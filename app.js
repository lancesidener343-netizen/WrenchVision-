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
const problemHeading = $("problemHeading");
const problemText = $("problemText");
const newJobBtn = $("newJobBtn");
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
let photoPending = false;
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

// One attach path for both photo sources: the file picker and the
// live viewfinder below feed it the same way.
function attachPhotoDataUrl(dataUrl, name) {
  fileNameEl.textContent = name;
  photoPending = true;
  downscaleDataUrl(dataUrl, (small) => {
    photoDataUrl = small;
    photoPending = false;
    preview.src = small;
    preview.hidden = false;
  });
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => attachPhotoDataUrl(reader.result, file.name);
  reader.readAsDataURL(file);
});

// --- Live camera with the eye viewfinder (secure contexts only) ---
// getUserMedia needs https, so on the plain Wi-Fi page this whole
// block stays dormant: no extra button, no behavior change, and the
// file-picker camera above is untouched. On a secure origin
// (Codespaces https) a Live camera button appears next to Open
// camera: the preview wears the gold eye frame from the logo, and
// Take photo feeds the exact same attach path the file picker uses.
const liveCameraOK = !!(
  window.isSecureContext &&
  navigator.mediaDevices &&
  navigator.mediaDevices.getUserMedia
);
let liveStream = null;
function stopLiveStream() {
  if (liveStream) {
    liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null;
  }
}
function closeLiveView() {
  stopLiveStream();
  const overlay = document.getElementById("wvLive");
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
}
async function openLiveView() {
  const overlay = document.createElement("div");
  overlay.className = "wv-live";
  overlay.id = "wvLive";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  overlay.appendChild(video);
  const eye = document.createElement("div");
  eye.className = "wv-eye";
  overlay.appendChild(eye);
  const iris = document.createElement("div");
  iris.className = "wv-eye-iris";
  overlay.appendChild(iris);
  const cap = document.createElement("div");
  cap.className = "wv-live-cap";
  cap.textContent = "Look into the eye — frame the machine";
  overlay.appendChild(cap);
  const actions = document.createElement("div");
  actions.className = "wv-live-actions";
  const takeBtn = document.createElement("button");
  takeBtn.type = "button";
  takeBtn.textContent = "Take photo";
  takeBtn.addEventListener("click", () => {
    try {
      if (!video.videoWidth) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      attachPhotoDataUrl(canvas.toDataURL("image/jpeg", 0.8), "live-capture.jpg");
      closeLiveView();
    } catch {
      // Capture failed — the overlay stays up; Close and Open
      // camera still work, and nothing else is disturbed.
    }
  });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "secondary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeLiveView);
  actions.appendChild(takeBtn);
  actions.appendChild(closeBtn);
  overlay.appendChild(actions);
  document.body.appendChild(overlay);
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    video.srcObject = liveStream;
  } catch {
    cap.textContent = "Camera unavailable here — use Open camera instead.";
  }
}
if (liveCameraOK) {
  const liveBtn = document.createElement("button");
  liveBtn.type = "button";
  liveBtn.id = "liveBtn";
  liveBtn.textContent = "Live camera";
  liveBtn.addEventListener("click", openLiveView);
  cameraBtn.parentNode.appendChild(liveBtn);
}

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
  if (!photoDataUrl && !task && !photoPending) {
    statusEl.textContent = "Take or upload a photo, or describe the job first.";
    return;
  }
  // A photo chosen a moment ago may still be downscaling: wait for
  // it (up to 5 seconds) instead of sending the job without it.
  if (photoPending) {
    statusEl.textContent = "Waiting for the photo…";
    const started = Date.now();
    while (photoPending && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!photoDataUrl && !task) {
    statusEl.textContent = "Take or upload a photo, or describe the job first.";
    return;
  }
  generateBtn.disabled = true;
  statusEl.textContent = "Generating manual…";
  statusEl.classList.remove("error");
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
    try {
      localStorage.removeItem("wrenchvision-queue");
    } catch {
      // Storage unavailable — nothing queued to clear.
    }
    renderManual(data);
    statusEl.textContent = "";
  } catch (err) {
    // No connection to the server (offline, or the server is down):
    // hold the job on the phone and send it when the network is
    // back, instead of losing it. Any other error renders as an
    // error message — never as a step in the manual.
    if (err instanceof TypeError) {
      try {
        localStorage.setItem("wrenchvision-queue", JSON.stringify({
          photo: photoDataUrl, task, savedAt: Date.now(),
        }));
      } catch {
        // Storage full or unavailable — the error below still shows.
      }
      statusEl.textContent = "No connection — job saved on the phone. It will send when you're back on the network.";
      statusEl.classList.remove("error");
    } else {
      statusEl.textContent = err.message;
      statusEl.classList.add("error");
    }
    resultsEl.hidden = true;
    partsPage.hidden = true;
    machineEl.textContent = "—";
    diagramBox.innerHTML = "";
    factoryLinksEl.innerHTML = "";
    calloutsEl.innerHTML = "";
    stepsEl.innerHTML = "";
    problemHeading.hidden = true;
    problemText.hidden = true;
    problemText.textContent = "";
    troubleshootHeading.hidden = true;
    troubleshootEl.innerHTML = "";
    troubleshootEl.hidden = true;
    currentSteps = [];
    currentParts = [];
    currentManualUrl = null;
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
  // Problem up top, solution steps below: the manual is shaped
  // problem/solution, and the walkthrough reads the solution.
  const problem = data.problem || {};
  const showProblem = Boolean(problem.symptom || problem.diagnosis);
  problemHeading.hidden = !showProblem;
  problemText.hidden = !showProblem;
  problemText.textContent = [problem.symptom, problem.diagnosis]
    .filter(Boolean)
    .join(" — ");
  diagramBox.innerHTML = "";
  // v12: photo-anchored diagram. Only when the server located at
  // least one part AND this page still holds the photo: a page
  // reload has no photo in memory, so it renders the schematic
  // instead — the same as the photo preview today. Markers are
  // detected regions for a callout concept, never verified part
  // positions, and the caption says so; parts with no marker
  // were not located in this photo, not missing from the job.
  const regions = Array.isArray(data.photoRegions) ? data.photoRegions : [];
  if (
    regions.length &&
    photoDataUrl &&
    Number.isFinite(data.photoWidth) && data.photoWidth > 0 &&
    Number.isFinite(data.photoHeight) && data.photoHeight > 0
  ) {
    const wrap = document.createElement("div");
    wrap.className = "photo-diagram";
    const img = document.createElement("img");
    img.src = photoDataUrl;
    img.alt = "Your machine photo with located parts marked";
    img.className = "preview";
    wrap.appendChild(img);
    regions.forEach((r) => {
      const b = r.box || {};
      const left = (b.x1 / data.photoWidth) * 100;
      const top = (b.y1 / data.photoHeight) * 100;
      const w = ((b.x2 - b.x1) / data.photoWidth) * 100;
      const h = ((b.y2 - b.y1) / data.photoHeight) * 100;
      if (!(w > 0 && h > 0 && left >= 0 && top >= 0)) return;
      const box = document.createElement("div");
      box.className = "photo-box";
      // Mask pass-through for the diagram plug-in: inert on
      // its own, decoded to an outline only when valid.
      if (typeof r.mask === "string" && r.mask) {
        box.dataset.duMask = r.mask;
      }
      box.style.left = left + "%";
      box.style.top = top + "%";
      box.style.width = w + "%";
      box.style.height = h + "%";
      const num = document.createElement("span");
      num.className = "photo-num";
      num.textContent = String((r.calloutIndex || 0) + 1);
      box.appendChild(num);
      wrap.appendChild(box);
    });
    diagramBox.appendChild(wrap);
    const cap = document.createElement("p");
    cap.className = "hint";
    cap.textContent =
      "Photo of your machine — gold markers show where the model located each part; parts without a marker weren't located in this photo.";
    diagramBox.appendChild(cap);
  } else if (data.diagramSvg) {
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
          const num = p.partNumber
            ? ` <span class="hint">Part #${escapeHtml(p.partNumber)}</span>`
            : "";
          return `<li><strong>${escapeHtml(p.name)}</strong>${id}${num}<span class="badge ${cls}">${cls}</span></li>`;
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

// --- New job (clean slate mid-run) ---
newJobBtn.addEventListener("click", async () => {
  // Clear the server job too, so the next Generate starts fresh
  // without restarting the server. The page clears regardless.
  try {
    await fetch("/api/newjob", { method: "POST" });
  } catch {
    // Server unreachable — the page still clears.
  }
  try {
    localStorage.removeItem("wrenchvision-queue");
  } catch {
    // Storage unavailable — nothing queued to clear.
  }
  photoDataUrl = null;
  photoPending = false;
  fileInput.value = "";
  fileNameEl.textContent = "";
  preview.src = "";
  preview.hidden = true;
  taskInput.value = "";
  followupInput.value = "";
  followupStatus.textContent = "";
  statusEl.textContent = "";
  statusEl.classList.remove("error");
  resultsEl.hidden = true;
  partsPage.hidden = true;
  machineEl.textContent = "—";
  currentSteps = [];
  currentParts = [];
  currentManualUrl = null;
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
let restoredManual = false;
(async () => {
  try {
    const res = await fetch("/api/job");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.manual && Array.isArray(data.manual.steps)) {
      if (data.task) taskInput.value = data.task;
      renderManual(data.manual);
      restoredManual = true;
    }
  } catch {
    // No saved job, or the server is unreachable — start fresh.
  }
})();

// --- Offline queue: a job that could not reach the server waits
// on the phone and sends when the network is back. On load it only
// sends when no manual was restored, so it never overwrites a
// restored job; on regaining the network it sends regardless.
async function tryFlushQueue() {
  let queued = null;
  try {
    queued = JSON.parse(localStorage.getItem("wrenchvision-queue") || "null");
  } catch {
    return;
  }
  if (!queued || (!queued.photo && !queued.task)) return;
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: queued.photo, task: queued.task }),
    });
    const data = await res.json();
    if (!res.ok || data.error) return;
    try {
      localStorage.removeItem("wrenchvision-queue");
    } catch {
      // Queued copy lingers — the manual still rendered.
    }
    if (queued.task) taskInput.value = queued.task;
    renderManual(data);
    statusEl.textContent = "";
  } catch {
    // Still offline — the job stays queued for the next try.
  }
}
setTimeout(() => {
  if (!restoredManual) tryFlushQueue();
}, 150);
window.addEventListener("online", tryFlushQueue);

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
