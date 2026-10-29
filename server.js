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

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const VERSION = "v10";
const MODEL = "muse-spark-1.3";
const API_URL = "https://api.meta.ai/v1/chat/completions";

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
].join("\n");

// Links the app may show. Anything else the model offers is dropped:
// a factory link must be a verified source, never an invented URL.
const EU7000IS_MANUAL_URL =
  "https://productguidebook.com/files/manuals/hondapower-eu7000is-owners-manual_Ryh6mI3.pdf";
const EU7000IS_PARTS_URL = "http://peparts.honda.com/powerequipment";

// The current job: the machine, the original job text, and the
// latest manual (including parts and troubleshooting). POST
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
      "callouts (array of short part labels), steps (array of objects " +
      "with text and label, where label is one of verified, inferred, " +
      "illustrative), diagramNote (one short line), diagramSvg (a " +
      "single SVG string, max 4000 characters, no style blocks, no " +
      "scripts, no external references: a simple exploded-style " +
      "schematic of the machine built from the callouts, parts " +
      "spread apart as in an exploded view, each with a numbered " +
      "marker matching its callouts order — this is a schematic, " +
      "not a photo trace), parts (array of " +
      "objects with short name, short identification, and label, where " +
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

  currentJob = { machine: manual.machine, task: input.task || "", manual };
  saveJob();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(manual));
}

// Generate-Scan-Fix loop, shared by /api/generate and /api/followup.
// Returns the final manual, or null when the model output is empty or
// unparseable. Throws when the model service itself errors.
async function runManualLoop(apiKey, messages) {
  // Step 1 — Generate.
  const generated = await callModel(apiKey, messages, 8000);
  let manual = tryParseManual(generated);
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
          "final manual as JSON with keys: machine, callouts, steps " +
          "(text and label, one of verified, inferred, " +
          "illustrative), parts (name, identification, label, one of " +
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
      "(string), callouts (array of short part labels), steps (array " +
      "of objects with text and label, where label is one of " +
      "verified, inferred, illustrative), diagramNote (one short " +
      "line), diagramSvg (keep the current schematic unless the new " +
      "information changes it), parts (array of objects with short " +
      "name, short identification, and label, where label is one of " +
      "verified, inferred, illustrative), troubleshooting (array of " +
      "objects with symptom, cause, check, and label — update it " +
      "with the new information just like the steps), manualUrl, " +
      "partsUrl.",
  ].filter(Boolean).join("\n");

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
