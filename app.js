// WrenchVision frontend.
// Talks only to this app's own backend (/api/generate, /api/followup).
// This file NEVER contains, requests, or displays an API key.

const $ = (id) => document.getElementById(id);

const preview = $("preview");
const cameraBtn = $("cameraBtn");
const fileInput = $("fileInput");
const fileNameEl = $("fileName");
const taskInput = $("task");
const micBtn = $("micBtn");
const micHint = $("micHint");
const generateBtn = $("generate");
const statusEl = $("status");
const resultsEl = $("results");
const machineEl = $("machine");
const diagramBox = $("diagramBox");
const factoryLinksEl = $("factoryLinks");
const calloutsEl = $("callouts");
const stepsEl = $("steps");
const troubleshootHeading = $("troubleshootHeading");
const troubleshootEl = $("troubleshoot");
const speakBtn = $("speakBtn");
const stopSpeakBtn = $("stopSpeakBtn");
const partsBtn = $("partsBtn");
const partsPage = $("partsPage");
const partsMachine = $("partsMachine");
const partsList = $("partsList");
const backBtn = $("backBtn");
const manualBtn = $("manualBtn");
const followupInput = $("followup");
const followupBtn = $("followupBtn");
const followupStatus = $("followupStatus");

let photoDataUrl = null;
let currentSteps = [];
let currentParts = [];
let currentManualUrl = null;

// Photos are downscaled to at most 1280px on the long edge before
// they are stored or sent. Full-resolution phone photos blew past the
// phone's memory at capture time and made the upload huge; the model
// only needs a readable photo.
const MAX_PHOTO_EDGE = 1280;
function downscaleDataUrl(dataUrl, done) {
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(img.width, img.height));
    if (scale === 1) {
      done(dataUrl);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    done(canvas.toDataURL("image/jpeg", 0.8));
  };
  img.onerror = () => done(dataUrl);
  img.src = dataUrl;
}

// --- Camera ---
// The phone's camera lives in the file picker: tapping Open camera
// opens the system camera (capture="environment"), and the photo
// comes back through the file input. The old live-preview buttons
// never worked on the plain Wi-Fi page, so they are gone — one
// camera button, and it works as Open camera.
cameraBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileNameEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    downscaleDataUrl(reader.result, (small) => {
      photoDataUrl = small;
      preview.src = small;
      preview.hidden = false;
    });
  };
  reader.readAsDataURL(file);
});

// --- Voice input (browser speech recognition when available) ---
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.onresult = (event) => {
    taskInput.value = event.results[0][0].transcript;
  };
  recognition.onerror = () => {
    micHint.textContent = "Could not hear that — type the job instead.";
  };
  micBtn.addEventListener("click", () => recognition.start());
} else {
  micBtn.disabled = true;
  micHint.textContent = "Voice input is not supported in this browser — type the job instead.";
}

// --- Generate ---
generateBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!photoDataUrl && !task) {
    statusEl.textContent = "Take or upload a photo, or describe the job first.";
    return;
  }
  generateBtn.disabled = true;
  statusEl.textContent = "Generating manual…";
  resultsEl.hidden = true;

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: photoDataUrl, task }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "The server returned an error.");
    }
    renderManual(data);
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = "";
    resultsEl.hidden = false;
    machineEl.textContent = "—";
    diagramBox.innerHTML = "";
    factoryLinksEl.innerHTML = "";
    calloutsEl.innerHTML = "";
    stepsEl.innerHTML = `<li class="error">${escapeHtml(err.message)}</li>`;
    troubleshootHeading.hidden = true;
    troubleshootEl.innerHTML = "";
    troubleshootEl.hidden = true;
    currentSteps = [];
    currentParts = [];
    currentManualUrl = null;
    partsPage.hidden = true;
  } finally {
    generateBtn.disabled = false;
  }
});

function renderManual(data) {
  resultsEl.hidden = false;
  partsPage.hidden = true;
  followupInput.value = "";
  followupStatus.textContent = "";
  machineEl.textContent = data.machine || "Unknown — see steps";
  partsMachine.textContent = data.machine || "Unknown — see steps";
  diagramBox.innerHTML = "";
  if (data.diagramSvg) {
    // Server-sanitized SVG only; nothing else is injected as HTML.
    diagramBox.innerHTML = data.diagramSvg;
    const cap = document.createElement("p");
    cap.className = "hint";
    cap.textContent =
      (data.diagramNote || "Exploded-view diagram appears here.") +
      " Schematic diagram — illustrative, drawn from the factory component set.";
    diagramBox.appendChild(cap);
  } else {
    diagramBox.textContent =
      data.diagramNote || "Exploded-view diagram appears here.";
  }
  factoryLinksEl.innerHTML = "";
  const links = [];
  if (data.manualUrl) {
    links.push(["Factory owner's manual", data.manualUrl]);
  }
  if (data.partsUrl) {
    links.push(["Honda parts catalog — exploded diagrams", data.partsUrl]);
  }
  links.forEach(([label, href], i) => {
    if (i) {
      factoryLinksEl.appendChild(document.createTextNode(" · "));
    }
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    factoryLinksEl.appendChild(a);
  });
  calloutsEl.innerHTML = (data.callouts || [])
    .map((c) => `<li>${escapeHtml(String(c))}</li>`)
    .join("");
  currentSteps = data.steps || [];
  currentParts = data.parts || [];
  currentManualUrl = data.manualUrl || null;
  stepsEl.innerHTML = currentSteps
    .map((s) => {
      const label = (s.label || "inferred").toLowerCase();
      const cls = ["verified", "inferred", "illustrative"].includes(label)
        ? label
        : "inferred";
      return `<li>${escapeHtml(s.text)}<span class="badge ${cls}">${cls}</span></li>`;
    })
    .join("");
  // Troubleshooting: symptom, cause, check — shown only when the
  // manual carries entries; older saved jobs without the section
  // render cleanly with the heading hidden.
  const troubleshooting = data.troubleshooting || [];
  const showTrouble = troubleshooting.length > 0;
  troubleshootHeading.hidden = !showTrouble;
  troubleshootEl.hidden = !showTrouble;
  troubleshootEl.innerHTML = troubleshooting
    .map((t) => {
      const label = (t.label || "inferred").toLowerCase();
      const cls = ["verified", "inferred", "illustrative"].includes(label)
        ? label
        : "inferred";
      const parts = [t.symptom, t.cause, t.check]
        .filter(Boolean)
        .map(escapeHtml);
      return `<li>${parts.join(" — ")}<span class="badge ${cls}">${cls}</span></li>`;
    })
    .join("");
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// --- Spoken walkthrough (device speech synthesis) ---
speakBtn.addEventListener("click", () => {
  if (!currentSteps.length) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(
    currentSteps.map((s) => s.text).join(". ")
  );
  speechSynthesis.speak(utter);
});
stopSpeakBtn.addEventListener("click", () => speechSynthesis.cancel());

// --- Parts list page ---
partsBtn.addEventListener("click", () => {
  partsMachine.textContent = machineEl.textContent || "—";
  partsList.innerHTML = currentParts.length
    ? currentParts
        .map((p) => {
          const label = (p.label || "inferred").toLowerCase();
          const cls = ["verified", "inferred", "illustrative"].includes(label)
            ? label
            : "inferred";
          const id = p.identification
            ? ` — ${escapeHtml(p.identification)}`
            : "";
          return `<li><strong>${escapeHtml(p.name)}</strong>${id}<span class="badge ${cls}">${cls}</span></li>`;
        })
        .join("")
    : `<li class="hint">No parts listed for this manual.</li>`;
  manualBtn.hidden = !currentManualUrl;
  resultsEl.hidden = true;
  partsPage.hidden = false;
  window.scrollTo(0, 0);
});
backBtn.addEventListener("click", () => {
  partsPage.hidden = true;
  resultsEl.hidden = false;
  window.scrollTo(0, 0);
});
manualBtn.addEventListener("click", () => {
  // Factory manual only: opens the whitelisted owner's-manual URL the
  // server returned with this job (Honda EU7000is today). No button
  // shows for machines with no factory link — never a guessed URL.
  if (currentManualUrl) window.open(currentManualUrl, "_blank", "noopener");
});

// --- Restore the saved job on page load ---
// Leaving the app and coming back reloads the page; without this,
// the reload shows an empty form even though the server still holds
// the job. Fetching it here restores the manual in place, with no
// new model call and no regeneration.
(async () => {
  try {
    const res = await fetch("/api/job");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.manual && Array.isArray(data.manual.steps)) {
      if (data.task) taskInput.value = data.task;
      renderManual(data.manual);
    }
  } catch {
    // No saved job, or the server is unreachable — start fresh.
  }
})();

// --- Follow-up (same job, updated manual) ---
followupBtn.addEventListener("click", async () => {
  const text = followupInput.value.trim();
  if (!text) {
    followupStatus.textContent = "Type a follow-up first.";
    return;
  }
  followupBtn.disabled = true;
  followupStatus.textContent = "Updating manual…";
  try {
    const res = await fetch("/api/followup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "The server returned an error.");
    }
    renderManual(data);
  } catch (err) {
    // Keep the current manual on screen; show the error only.
    followupStatus.textContent = err.message;
  } finally {
    followupBtn.disabled = false;
  }
});
