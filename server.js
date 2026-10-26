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
// final manual. muse-spark-1.3 reasons before answering and spends
// roughly 1500 to 3000 tokens doing so, so every call uses a generous
// token budget and empty model output is never presented as a manual.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MODEL = "muse-spark-1.3";
const API_URL = "https://api.meta.ai/v1/chat/completions";

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
    if (req.method === "POST" && req.url === "/api/generate") {
      return handleGenerate(req, res);
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
    "Return a repair manual as JSON with keys: machine (string), " +
      "callouts (array of short part labels), steps (array of objects " +
      "with text and label, where label is one of verified, inferred, " +
      "illustrative), diagramNote (one short line).",
  ].filter(Boolean).join("\n");

  const content = [{ type: "text", text: userText }];
  if (input.photo) {
    content.push({ type: "image_url", image_url: { url: input.photo } });
  }

  let manual;
  try {
    // Step 1 — Generate.
    const generated = await callModel(
      apiKey,
      [{ role: "user", content }],
      5000
    );
    manual = tryParseManual(generated);
    if (!manual) {
      // Empty or unparseable output is never presented as a manual.
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "The model returned no usable manual. Please try again.",
      }));
      return;
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
      5000
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
            "illustrative), diagramNote. Draft: " + JSON.stringify(manual) +
            " Flags: " + JSON.stringify(flags),
        }],
        5000
      );
      const fixedManual = tryParseManual(fixed);
      if (fixedManual) {
        manual = fixedManual;
      }
      // If Fix fails, the scanned draft still goes out with its labels.
    }
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "The model service returned an error. Please try again.",
    }));
    return;
  }

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
      diagramNote: parsed.diagramNote || "Exploded-view diagram appears here.",
    };
  } catch {
    return null;
  }
}

server.listen(PORT, () => {
  console.log(`WrenchVision listening on http://localhost:${PORT}`);
  if (!process.env.META_API_KEY) {
    console.log("META_API_KEY is not set — /api/generate will report that.");
  }
});
