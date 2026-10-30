// WrenchVision backend — Node.js, no external dependencies.
// Serves the frontend and proxies model calls to the Meta Model API.
//
// The API key is read ONLY from the META_API_KEY environment variable.
// It is never stored in code, never sent to the browser, and never logged.
// Model: muse-spark-1.3 (standard tier). The contributor-tier variant is
// intentionally never used here.
//
// Generate-Scan-Fix loop, proven live Oct 26 2026 against the API:
// Generate drafts the manual, Scan returns only the step numbers that
// are unsafe or inconsistent, Fix applies any flags and returns the
// final manual. muse-spark-1.3 reasons before answering and on one
// Oct 27 night call spent all 5000 completion tokens reasoning and
// returned nothing, so every call uses an 8000-token budget and
// empty model output is never presented as a manual.
//
// Factory grounding: when the machine is a Honda EU7000is, Generate
// and follow-up include a compact reference taken from the 2023
// owner's manual (specs, intervals, battery and fuse facts), and
// that reference is the truth: steps the book covers are built from
// it and labeled verified, steps it does not cover are labeled
// inferred, never as book text. The manual also carries a
// troubleshooting section (symptom, cause, check, each labeled).
// The in-app diagram is a schematic drawn from that factory
// component set, labeled illustrative; the true exploded diagrams
// live in Honda's free parts catalog, which the app links to
// instead of copying Honda's images.
//
// Clean slate: starting the server wipes any saved job, so the app
// opens empty. The memory only starts holding once a photo is taken
// and a manual is generated — after that, leaving the app and
// coming back mid-job restores the manual on load.
//
// v11: the manual is shaped problem/solution (Problem up top,
// Solution steps below, walkthrough reads the solution); parts
// carry verified part numbers, never guessed ones; a New Job
// button clears the job mid-run; errors render as errors, not
// steps; Generate waits for the photo and retries once on empty
// output; and a job that cannot reach the server queues on the
// phone and sends when it is back on the network.
//
// v12: photo-anchored realistic 2D diagrams. After Generate, the
// server runs sam-3.1 (Meta's segmentation model, same API key)
// once per callout concept over the user's photo and, when it
// locates a part, returns that part's detected box so the client
// can draw numbered gold markers on the ACTUAL photo instead of
// the generated schematic. SAM is conservative: for a part it
// cannot see (battery inside the case, carburetor on an EFI
// machine) it returns nothing rather than a guessed region, and
// a concept it cannot ground (multi-concept prompts) also
// returns nothing — so a part with no box simply gets no
// marker, and when no part is located at all the diagram falls
// back exactly to the generated schematic. Boxes are detected
// regions for a concept, never verified part positions, and the
// client caption says so. The mask blobs SAM returns are not
// decoded: boxes are the honest, verifiable region. If SAM
// fails, times out, or the photo is absent, the manual still
// returns with the schematic — segmentation never blocks it.
// A follow-up keeps the photo regions only when the callout
// list is unchanged; otherwise it falls back to the schematic,
// because regions belong to callout concepts. A page reload
// has no photo in memory, so it also renders the schematic —
// the same as the photo preview today.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const VERSION = "v16";
const MODEL = "muse-spark-1.3";
const API_URL = "https://api.meta.ai/v1/chat/completions";
// sam-3.1 does NOT work on /v1/chat/completions (that endpoint
// answers 404 "Use /v1/responses") and its non-streaming
// Responses output is empty: the segmentation records only
// arrive on the streamed output_text deltas. So SAM calls use
// the streaming Responses endpoint and accumulate deltas.
const SAM_MODEL = "sam-3.1";
const SAM_URL = "https://api.meta.ai/v1/responses";
const SAM_MAX_CALLOUTS = 8;
const SAM_TIMEOUT_MS = 30000;

// Compact Honda EU7000is factory reference, verified Oct 27 2026
// from the 2023 owner's manual (00X31-Z37-6230). Facts only — the
// book names no battery type code, so none is claimed from it.
const EU7000IS_REFERENCE = [
  "Honda EU7000is factory reference (2023 owner's manual):",
  "Engine GX390T2, 389cc; oil capacity 1.2 US qt; fuel tank 5.07 gal.",
  "Spark plug NGK BPR6ES, gap 0.7-0.8 mm; plug torque 13.0 lbf-ft.",
  "Oil drain plug torque 16.3 lbf-ft; drain warm, new sealing washer.",
  "Battery 12V 11.2Ah; charge at 1.1A for 5-10 hours; charge monthly if",
  "used periodically. Remove negative cable first, then positive.",
  "Install positive first, boot over positive terminal, then negative.",
  "Fuses 3A and 15A; a blown fuse means the starter will not work.",
  "Fuel pump filter: change every 2 years or 1000 hours — dealer item",
  "unless mechanically proficient with proper tools (shop manual).",
  "Valve clearance IN 0.15, EX 0.20 mm (dealer).",
  "Verified part numbers (use these exact numbers, never guess one):",
  "fuel pump filter set 16707-Z37-003; spark plug Honda 98079-56846",
  "(NGK BPR6ES); air filter element 17211-Z3S-003, outer filter",
  "17218-Z0A-810; engine oil Honda 10W-30 08207-10W30.",
].join("\n");

// Links the app may show. Anything else the model offers is dropped:
// a factory link must be a verified source, never an invented URL.
const EU7000IS_MANUAL_URL =
  "https://productguidebook.com/files/manuals/hondapower-eu7000is-owners-manual_Ryh6mI3.pdf";
const EU7000IS_PARTS_URL = "http://peparts.honda.com/powerequipment";

// The current job: the machine, the original job text, and the
// latest manual (including parts, troubleshooting, and the problem section). POST
// /api/followup updates this job's manual with new info, using the
// same loop. The job is saved to disk after every update, so
// leaving the app and coming back mid-job restores the manual on
// load (GET /api/job) — but a server start is a clean slate by
// design: the saved job is wiped on startup, so the app opens
// empty and the memory only starts holding once a photo is taken
// and a manual is generated. The file holds only the machine, the
// job text, and the latest manual — never a key.
const JOB_FILE = path.join(__dirname, "wrenchvision-job.json");
let currentJob = null;

// Clean slate: starting the server clears any saved job from an
// earlier run. Within a run, Generate saves and page reloads
// restore — the slate only clears on the next server start.
try {
  fs.unlinkSync(JOB_FILE);
} catch {
  // No saved job to clear — already a clean slate.
}

function saveJob() {
  try {
    fs.writeFileSync(JOB_FILE, JSON.stringify(currentJob));
  } catch {
    // A failed save must not break the manual that is already built.
  }
}

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      return sendFile(res, "index.html");
    }
    if (req.method === "GET" && req.url === "/app.js") {
      return sendFile(res, "app.js");
    }
    // Plug-in diagram upgrades (client-only presentation, no loop
    // logic): served as plain static files alongside app.js, so
    // the <script>/<link> tags in index.html actually load.
    if (
      req.method === "GET" &&
      (req.url === "/diagram-upgrades.js" || req.url === "/diagram-upgrades.css")
    ) {
      return sendFile(res, req.url.slice(1));
    }
    if (req.method === "GET" && req.url === "/api/job") {
      // Restore within a run: the page reloads the saved job on
      // open, so leaving the app and coming back mid-job shows the
      // manual instead of an empty form. No model call and no key
      // needed — just the saved job. A server start wipes it
      // (clean slate).
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(
        currentJob
          ? { task: currentJob.task || "", manual: currentJob.manual }
          : { task: "", manual: null }
      ));
      return;
    }
    if (req.method === "POST" && req.url === "/api/newjob") {
      // New job: clear the saved job on the server and in the file,
      // so the next Generate starts from a clean slate mid-run
      // without restarting the server.
      currentJob = null;
      try {
        fs.unlinkSync(JOB_FILE);
      } catch {
        // Nothing saved — already a clean slate.
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/generate") {
      return handleGenerate(req, res);
    }
    if (req.method === "POST" && req.url === "/api/followup") {
      return handleFollowup(req, res);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server error. Please try again." }));
  }
});

function sendFile(res, name) {
  const file = path.join(__dirname, name);
  const ext = path.extname(name);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleGenerate(req, res) {
  const apiKey = process.env.META_API_KEY;

  // Graceful failure: never present a fake manual as real.
  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error:
        "Meta Model API key is not configured on this server. " +
        "Set the META_API_KEY environment variable and restart the server.",
      configured: false,
    }));
    return;
  }

  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request." }));
    return;
  }

  const userText = [
    "Identify the machine in the photo, if one was provided.",
    input.task ? `The user reports: ${input.task}` : "",
    "If the machine is a Honda EU7000is, the factory reference below " +
      "is the truth: ground every fact you can in it and say nothing " +
      "that contradicts it. Build the steps from the reference " +
      "wherever it covers the job — its specs, intervals, and " +
      "procedures — and label those steps verified. Where the " +
      "reference does not cover a step, write it from the job and " +
      "label it inferred, never as book text. For any other " +
      "machine, ignore the reference entirely.\n" +
      EU7000IS_REFERENCE,
    "Return a repair manual as JSON with keys: machine (string), " +
      "problem (object with symptom — the reported problem in one " +
      "line — and diagnosis — the most likely cause in one or two " +
      "lines, grounded in the factory reference when it covers it; " +
      "the steps below are the solution to this problem), " +
      "callouts (array of short part labels), steps (array of objects " +
      "with text and label, where label is one of verified, inferred, " +
      "illustrative), diagramNote (one short line), diagramSvg (a " +
      "single SVG string, max 4000 characters, no style blocks, no " +
      "scripts, no external references: a simple exploded-style " +
      "schematic of the machine built from the callouts, parts " +
      "spread apart as in an exploded view, each with a numbered " +
      "marker matching its callouts order — this is a schematic, " +
      "not a photo trace), parts (array of " +
      "objects with short name, short identification, partNumber, " +
      "and label, where partNumber is the real manufacturer part " +
      "number when it is known from the factory reference or " +
      "verified evidence and is left empty rather than guessed, and " +
      "identification says what the part is and why it is needed, and " +
      "label is one of verified, inferred, illustrative — list every " +
      "part needed for this repair, each labeled honestly), " +
      "troubleshooting (array of at most 5 objects with symptom, " +
      "cause, check, and label, where label is one of verified, " +
      "inferred, illustrative — for the reported problem, the " +
      "likely causes in order with the check that confirms or " +
      "rules out each one; ground causes and checks in the " +
      "factory reference when it covers them, and label each " +
      "honestly), " +
      "manualUrl (only when the machine is a Honda EU7000is, use " +
      "exactly " + EU7000IS_MANUAL_URL + "; otherwise omit it), " +
      "partsUrl (only when the machine is a Honda EU7000is, use " +
      "exactly " + EU7000IS_PARTS_URL + "; otherwise omit it).",
  ].filter(Boolean).join("\n");

  const content = [{ type: "text", text: userText }];
  if (input.photo) {
    content.push({ type: "image_url", image_url: { url: input.photo } });
  }

  let manual;
  try {
    manual = await runManualLoop(apiKey, [{ role: "user", content }]);
    if (!manual) {
      // Empty or unparseable output is never presented as a manual.
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "The model returned no usable manual. Please try again.",
      }));
      return;
    }
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "The model service returned an error. Please try again.",
    }));
    return;
  }

  // v12: photo-anchored diagram. Best effort only — a failure
  // here must not touch the manual that is already built.
  if (input.photo && Array.isArray(manual.callouts) && manual.callouts.length) {
    try {
      const seg = await segmentPhoto(apiKey, input.photo, manual.callouts);
      if (seg && seg.regions.length > 0) {
        manual.photoRegions = seg.regions;
        manual.photoWidth = seg.width;
        manual.photoHeight = seg.height;
      }
    } catch {
      // Segmentation failed — the schematic path still serves.
    }
  }

  currentJob = { machine: manual.machine, task: input.task || "", manual };
  saveJob();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(manual));
}

// Generate-Scan-Fix loop, shared by /api/generate and /api/followup.
// Returns the final manual, or null when the model output is empty or
// unparseable. Throws when the model service itself errors.
async function runManualLoop(apiKey, messages) {
  // Step 1 — Generate, with one retry on empty output: the model
  // sometimes spends its whole budget reasoning and returns
  // nothing, and a second try usually lands. A second empty
  // result still returns null — never a fake manual.
  let manual = tryParseManual(await callModel(apiKey, messages, 8000));
  if (!manual) {
    manual = tryParseManual(await callModel(apiKey, messages, 8000));
  }
  if (!manual) {
    // Empty or unparseable output is never presented as a manual.
    return null;
  }

  // Step 2 — Scan: narrow verdict, step numbers only.
  const scanText = await callModel(
    apiKey,
    [{
      role: "user",
      content:
        "Read these repair steps. Reply with ONLY a JSON list of " +
        "the 0-based step numbers that are unsafe, wrong, or " +
        "inconsistent with the symptoms. Reply [] if every step is " +
        "fine. No explanation. Steps: " + JSON.stringify(manual.steps),
    }],
    8000
  );
  const flags = tryParseFlags(scanText);

  // Step 3 — Fix, only when Scan flagged something.
  if (flags.length > 0) {
    const fixed = await callModel(
      apiKey,
      [{
        role: "user",
        content:
          "Apply these review flags to the draft and return the " +
          "final manual as JSON with keys: machine, problem " +
          "(symptom, diagnosis — keep the draft's, fixing only " +
          "what the flags require), callouts, steps " +
          "(text and label, one of verified, inferred, " +
          "illustrative), parts (name, identification, partNumber, " +
          "label, one of " +
          "verified, inferred, illustrative), troubleshooting " +
          "(symptom, cause, check, label — keep the draft's " +
          "entries, fixing only what the flags require), " +
          "diagramNote, diagramSvg " +
          "(keep the draft's schematic, fixing only what the flags " +
          "require), manualUrl, partsUrl. Draft: " +
          JSON.stringify(manual) +
          " Flags: " + JSON.stringify(flags),
      }],
      8000
    );
    const fixedManual = tryParseManual(fixed);
    if (fixedManual) {
      // A fix must not silently drop the diagram or factory links.
      if (!fixedManual.diagramSvg) {
        fixedManual.diagramSvg = manual.diagramSvg;
      }
      if (!fixedManual.manualUrl) {
        fixedManual.manualUrl = manual.manualUrl;
      }
      if (!fixedManual.partsUrl) {
        fixedManual.partsUrl = manual.partsUrl;
      }
      // A fix must not silently drop the troubleshooting section.
      if (!fixedManual.troubleshooting || !fixedManual.troubleshooting.length) {
        fixedManual.troubleshooting = manual.troubleshooting || [];
      }
      // A fix must not silently drop the problem section either.
      if (!fixedManual.problem || (!fixedManual.problem.symptom && !fixedManual.problem.diagnosis)) {
        fixedManual.problem = manual.problem || { symptom: "", diagnosis: "" };
      }
      manual = fixedManual;
    }
    // If Fix fails, the scanned draft still goes out with its labels.
  }
  return manual;
}

async function handleFollowup(req, res) {
  const apiKey = process.env.META_API_KEY;

  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error:
        "Meta Model API key is not configured on this server. " +
        "Set the META_API_KEY environment variable and restart the server.",
      configured: false,
    }));
    return;
  }

  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request." }));
    return;
  }

  const text = (input.text || "").trim();
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Type a follow-up first." }));
    return;
  }
  if (!currentJob) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "No job yet — generate a manual first.",
    }));
    return;
  }

  const followupText = [
    "Update this repair manual with the new information below. " +
      "Keep the same machine unless the new information says " +
      "otherwise. Keep steps and parts that are still correct, " +
      "change the ones the new information affects, and add anything " +
      "new it calls for. Label every step and part honestly as " +
      "verified, inferred, or illustrative — a fact the user " +
      "confirms becomes verified, anything else stays inferred or " +
      "illustrative.",
    "If the machine is a Honda EU7000is, the factory reference is " +
      "the truth: ground every fact and every step you can in it, " +
      "and label steps the reference covers as verified; where it " +
      "does not cover a step, label it inferred, never as book " +
      "text. For any other machine, ignore the reference " +
      "entirely.\n" +
      EU7000IS_REFERENCE,
    currentJob.task ? `Original job: ${currentJob.task}` : "",
    "Current manual: " + JSON.stringify(currentJob.manual),
    "New information: " + text,
    "Return the full updated manual as JSON with keys: machine " +
      "(string), problem (object with symptom and diagnosis — " +
      "update it with the new information just like the steps), " +
      "callouts (array of short part labels), steps (array " +
      "of objects with text and label, where label is one of " +
      "verified, inferred, illustrative), diagramNote (one short " +
      "line), diagramSvg (keep the current schematic unless the new " +
      "information changes it), parts (array of objects with short " +
      "name, short identification, partNumber, and label, where " +
      "label is one of " +
      "verified, inferred, illustrative), troubleshooting (array of " +
      "objects with symptom, cause, check, and label — update it " +
      "with the new information just like the steps), manualUrl, " +
      "partsUrl.",
  ].filter(Boolean).join("\n");

  // v12: photo regions belong to callout concepts. Keep them
  // only when the follow-up left the callout list untouched;
  // otherwise the regions could point at parts that are no
  // longer listed, and the schematic takes over instead.
  const oldCallouts = currentJob.manual
    ? JSON.stringify(currentJob.manual.callouts || [])
    : null;
  const oldRegions = currentJob.manual
    ? currentJob.manual.photoRegions
    : null;
  const oldPhotoWidth = currentJob.manual
    ? currentJob.manual.photoWidth
    : null;
  const oldPhotoHeight = currentJob.manual
    ? currentJob.manual.photoHeight
    : null;

  let manual;
  try {
    manual = await runManualLoop(apiKey, [
      { role: "user", content: [{ type: "text", text: followupText }] },
    ]);
    if (!manual) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "The model returned no usable manual. Please try again.",
      }));
      return;
    }
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "The model service returned an error. Please try again.",
    }));
    return;
  }

  if (
    oldRegions &&
    oldRegions.length > 0 &&
    oldCallouts !== null &&
    JSON.stringify(manual.callouts || []) === oldCallouts &&
    Number.isFinite(oldPhotoWidth) &&
    Number.isFinite(oldPhotoHeight)
  ) {
    manual.photoRegions = oldRegions;
    manual.photoWidth = oldPhotoWidth;
    manual.photoHeight = oldPhotoHeight;
  }

  currentJob = { machine: manual.machine, task: currentJob.task, manual };
  saveJob();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(manual));
}

async function callModel(apiKey, messages, maxTokens) {
  const apiRes = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
    }),
  });
  if (!apiRes.ok) {
    throw new Error("Model service error.");
  }
  const apiData = await apiRes.json();
  return apiData.choices?.[0]?.message?.content || "";
}

// SAM 3.1 segmentation, v12 boxes + mask pass-through. The
// streamed output text is one frame line like:
//   <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;x=0;y=0;data=H,W,payload|>
// A concept can return several records (one per instance, e.g.
// "handle"); the largest box by area is the main instance and
// the only one kept. Each record's mask is paired with its own
// box: the mask tag nearest the box inside the same record
// (box-then-mask is what the API emits; mask-then-box is also
// accepted, per the protocol). The mask is passed through ONLY
// when it is strictly valid for that box, per Meta's SAM 3
// protocol (github.com/meta-models/meta-sam, protocol/sam3.md):
// mask x and y are both 0, the data tuple is H,W,payload with
// H and W equal to the box interior (x2-x1+1, y2-y1+1), the
// payload starts with ~ (lossless, the API default) or !
// (one_bit), and every payload character is in the 85-digit
// alphabet. Anything less is dropped and the box stands alone
// — a box is always better than a guessed outline. The client
// decodes the payload; this server never invents geometry.
// Returns null when nothing usable is in the text: empty
// output, no box tag, or an invalid box.
const MASK_ALPHABET =
  "!#$%&'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{";

function parseTokenFields(body) {
  const fields = {};
  for (const part of String(body || "").split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key && !(key in fields)) fields[key] = part.slice(eq + 1).trim();
  }
  return fields;
}

function parseSamLargestRegion(text) {
  if (typeof text !== "string" || !text) {
    return null;
  }
  const boxRe = /<\|box;([^|]*)\|>/g;
  const maskRe = /<\|mask;([^|]*)\|>/g;
  const boxes = [];
  const masks = [];
  let match;
  while ((match = boxRe.exec(text)) !== null) {
    boxes.push({ start: match.index, end: match.index + match[0].length, fields: parseTokenFields(match[1]) });
  }
  while ((match = maskRe.exec(text)) !== null) {
    masks.push({ start: match.index, end: match.index + match[0].length, fields: parseTokenFields(match[1]) });
  }
  let best = null;
  for (let i = 0; i < boxes.length; i++) {
    const f = boxes[i].fields;
    const x1 = Number(f.x1);
    const y1 = Number(f.y1);
    const x2 = Number(f.x2);
    const y2 = Number(f.y2);
    const w = Number(f.w);
    const h = Number(f.h);
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite)) {
      continue;
    }
    if (!(w > 0 && h > 0 && x2 > x1 && y2 > y1)) {
      continue;
    }
    // Clamp to the image the model saw; a box outside it is
    // not a region of this photo.
    const cx1 = Math.max(0, Math.min(x1, w));
    const cy1 = Math.max(0, Math.min(y1, h));
    const cx2 = Math.max(0, Math.min(x2, w));
    const cy2 = Math.max(0, Math.min(y2, h));
    if (!(cx2 > cx1 && cy2 > cy1)) {
      continue;
    }
    const area = (cx2 - cx1) * (cy2 - cy1);
    if (best && area <= best.area) {
      continue;
    }
    // Pair this box with its record's mask: the nearest mask
    // tag after the box (before the next box), else the nearest
    // one before it (after the previous box). A mask from
    // another record is never borrowed.
    const nextBoxStart = i + 1 < boxes.length ? boxes[i + 1].start : text.length;
    const prevBoxEnd = i > 0 ? boxes[i - 1].end : 0;
    let maskTag = null;
    for (const m of masks) {
      if (m.start >= boxes[i].end && m.start < nextBoxStart) {
        maskTag = m;
        break;
      }
    }
    if (!maskTag) {
      for (let j = masks.length - 1; j >= 0; j--) {
        if (masks[j].end <= boxes[i].start && masks[j].end > prevBoxEnd) {
          maskTag = masks[j];
          break;
        }
      }
    }
    let mask = null;
    if (maskTag) {
      const mf = maskTag.fields;
      // Protocol requires x=0, y=0 and data=H,W,payload. The
      // mask raster covers exactly the box interior, and the
      // box must not have needed clamping — otherwise the
      // raster would no longer align with the displayed box.
      const data = mf.data || "";
      const firstComma = data.indexOf(",");
      const secondComma = firstComma === -1 ? -1 : data.indexOf(",", firstComma + 1);
      if (
        mf.x === "0" && mf.y === "0" &&
        firstComma > 0 && secondComma > firstComma &&
        cx1 === x1 && cy1 === y1 && cx2 === x2 && cy2 === y2
      ) {
        const mh = Number(data.slice(0, firstComma));
        const mw = Number(data.slice(firstComma + 1, secondComma));
        const payload = data.slice(secondComma + 1);
        if (
          Number.isInteger(mh) && Number.isInteger(mw) &&
          mh === y2 - y1 + 1 && mw === x2 - x1 + 1 &&
          (payload[0] === "~" || payload[0] === "!") && payload.length > 1 &&
          [...payload.slice(1)].every((c) => MASK_ALPHABET.indexOf(c) !== -1)
        ) {
          mask = data;
        }
      }
    }
    best = {
      box: { x1: cx1, y1: cy1, x2: cx2, y2: cy2 },
      width: w,
      height: h,
      area,
      mask,
    };
  }
  if (!best) {
    return null;
  }
  return { box: best.box, width: best.width, height: best.height, mask: best.mask };
}

// One SAM call per callout concept. Multi-concept prompts
// return nothing on this endpoint, so concepts go one at a
// time; a concept with no box simply gets no marker. Never
// throws: every failure degrades to "no regions" and the
// caller falls back to the schematic.
// SAM is weak with complicated phrases ("Display screen module") and
// strong with short nouns ("screen"). Simplify each callout to one
// short noun for the SAM prompt; the marker number still matches the
// original callout order. Unmapped phrases fall back to the full text.
function simplifyConcept(text) {
  const lower = String(text || "").toLowerCase();
  const rules = [
    ["spark plug", ["spark plug"]],
    ["cable", ["cable", "ribbon", "wire"]],
    ["screen", ["screen", "display", "lcd"]],
    ["knob", ["knob", "potentiometer"]],
    ["circuit board", ["pcb", "board"]],
    ["chassis", ["chassis", "housing"]],
    ["panel", ["panel"]],
    ["button", ["button"]],
    ["battery", ["battery"]],
    ["tank", ["tank"]],
    ["filter", ["filter"]],
    ["fuse", ["fuse"]],
    ["pump", ["pump"]],
    ["engine", ["engine"]],
    ["wheel", ["wheel"]],
    ["handle", ["handle"]],
    ["switch", ["switch"]],
    ["motor", ["motor"]],
    ["microphone", ["microphone"]],
    ["slider", ["slider", "fader"]],
    ["plug", ["plug"]],
    ["port", ["port"]],
  ];
  for (const [simple, keys] of rules) {
    if (keys.some((k) => lower.includes(k))) return simple;
  }
  return String(text || "").trim();
}

async function segmentPhoto(apiKey, photoDataUrl, callouts) {
  const regions = [];
  let width = 0;
  let height = 0;
  // Keep each concept's original callout index: the marker
  // number must match the callout list order, even when an
  // empty label is skipped or two callouts share a simplified noun
  // (the first callout wins; the other simply gets no marker).
  const concepts = [];
  const seen = new Set();
  for (let index = 0; index < callouts.length && concepts.length < SAM_MAX_CALLOUTS; index++) {
    const text = simplifyConcept(callouts[index]);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    concepts.push({ index, text });
  }
  for (let i = 0; i < concepts.length; i++) {
    let text = "";
    try {
      const apiRes = await fetch(SAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: SAM_MODEL,
          stream: true,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: concepts[i].text },
              { type: "input_image", image_url: photoDataUrl },
            ],
          }],
        }),
        signal: AbortSignal.timeout(SAM_TIMEOUT_MS),
      });
      if (!apiRes.ok || !apiRes.body) {
        continue;
      }
      // Accumulate streamed output_text deltas; the done event
      // carries the full text as a fallback when deltas are
      // absent. Non-streamed SAM output is empty, so the stream
      // is required, not optional.
      const reader = apiRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let doneText = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const event = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const dataAt = event.indexOf("data: ");
          if (dataAt === -1) {
            continue;
          }
          let data;
          try {
            data = JSON.parse(event.slice(dataAt + 6));
          } catch {
            continue;
          }
          if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
            text += data.delta;
          } else if (data.type === "response.output_text.done" && typeof data.text === "string") {
            doneText = data.text;
          }
        }
      }
      if (!text) {
        text = doneText;
      }
    } catch {
      continue;
    }
    const found = parseSamLargestRegion(text);
    if (!found) {
      continue;
    }
    // All boxes must share the first call's image dimensions —
    // they all segment the same photo, so a mismatch means a
    // bad parse, not a second photo.
    if (!width) {
      width = found.width;
      height = found.height;
    } else if (found.width !== width || found.height !== height) {
      continue;
    }
    const region = {
      calloutIndex: concepts[i].index,
      label: concepts[i].text,
      box: found.box,
    };
    // Mask pass-through only: the client decodes it; an
    // absent or invalid mask simply means the box stands.
    if (found.mask) {
      region.mask = found.mask;
    }
    regions.push(region);
  }
  if (!regions.length) {
    return null;
  }
  return { regions, width, height };
}

function tryParseFlags(raw) {
  try {
    const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((n) => Number.isInteger(n));
  } catch {
    return [];
  }
}

// Model-supplied SVG is untrusted markup: strip everything that can
// run code or pull in outside content, and keep only basic shapes
// and text. Returns "" when nothing safe remains.
function sanitizeSvg(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  let svg = raw.slice(0, 8000);
  const start = svg.indexOf("<svg");
  const end = svg.lastIndexOf("</svg>");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  svg = svg.slice(start, end + 6);
  svg = svg.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "");
  svg = svg.replace(/<style[\s\S]*?<\/style\s*>/gi, "");
  svg = svg.replace(/<iframe[\s\S]*?<\/iframe\s*>/gi, "");
  svg = svg.replace(/<image[\s\S]*?>/gi, "");
  svg = svg.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  svg = svg.replace(/\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m) =>
    /href\s*=\s*("|')#/.test(m) ? m : ""
  );
  svg = svg.replace(/\sxlink:href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m) =>
    /xlink:href\s*=\s*("|')#/.test(m) ? m : ""
  );
  svg = svg.replace(/javascript:/gi, "");
  const allowed = new Set([
    "svg", "g", "rect", "circle", "ellipse", "line", "polyline",
    "polygon", "path", "text", "tspan", "title", "desc",
  ]);
  svg = svg.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, tag) =>
    allowed.has(tag.toLowerCase()) ? m : ""
  );
  return svg.includes("<svg") ? svg : "";
}

// Parts-catalog links must stay on Honda's catalog host: the exact
// catalog URL, or the same URL followed by a path, query, or
// fragment — never a lookalike host.
function isPartsUrl(u) {
  if (typeof u !== "string") {
    return false;
  }
  if (u === EU7000IS_PARTS_URL) {
    return true;
  }
  if (!u.startsWith(EU7000IS_PARTS_URL)) {
    return false;
  }
  const next = u[EU7000IS_PARTS_URL.length];
  return next === "#" || next === "/" || next === "?";
}

function tryParseManual(raw) {
  try {
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.steps)) {
      return null;
    }
    return {
      machine: parsed.machine || "Unknown — see steps",
      problem: {
        symptom: String((parsed.problem && parsed.problem.symptom) || ""),
        diagnosis: String((parsed.problem && parsed.problem.diagnosis) || ""),
      },
      callouts: Array.isArray(parsed.callouts) ? parsed.callouts : [],
      steps: parsed.steps.map((s) => ({
        text: String(s.text || ""),
        label: ["verified", "inferred", "illustrative"].includes(
          String(s.label || "").toLowerCase()
        )
          ? String(s.label).toLowerCase()
          : "inferred",
      })),
      parts: Array.isArray(parsed.parts)
        ? parsed.parts
            .map((p) => ({
              name: String(p.name || ""),
              identification: String(p.identification || ""),
              partNumber: String(p.partNumber || ""),
              label: ["verified", "inferred", "illustrative"].includes(
                String(p.label || "").toLowerCase()
              )
                ? String(p.label).toLowerCase()
                : "inferred",
            }))
            .filter((p) => p.name)
        : [],
      troubleshooting: Array.isArray(parsed.troubleshooting)
        ? parsed.troubleshooting
            .map((t) => ({
              symptom: String(t.symptom || ""),
              cause: String(t.cause || ""),
              check: String(t.check || ""),
              label: ["verified", "inferred", "illustrative"].includes(
                String(t.label || "").toLowerCase()
              )
                ? String(t.label).toLowerCase()
                : "inferred",
            }))
            .filter((t) => t.symptom || t.cause || t.check)
        : [],
      diagramNote: parsed.diagramNote || "Exploded-view diagram appears here.",
      diagramSvg: sanitizeSvg(parsed.diagramSvg),
      manualUrl: parsed.manualUrl === EU7000IS_MANUAL_URL ? parsed.manualUrl : "",
      partsUrl: isPartsUrl(parsed.partsUrl) ? parsed.partsUrl : "",
    };
  } catch {
    return null;
  }
}

server.listen(PORT, () => {
  console.log(`WrenchVision ${VERSION} listening on http://localhost:${PORT}`);
  if (!process.env.META_API_KEY) {
    console.log("META_API_KEY is not set — /api/generate will report that.");
  }
});
