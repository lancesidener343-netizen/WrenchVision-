// WrenchVision frontend.
// Talks only to this app's own backend (/api/generate).
// This file NEVER contains, requests, or displays an API key.

const $ = (id) => document.getElementById(id);

const video = $("camera");
const preview = $("preview");
const startCameraBtn = $("startCamera");
const captureBtn = $("capture");
const fileInput = $("fileInput");
const taskInput = $("task");
const micBtn = $("micBtn");
const micHint = $("micHint");
const generateBtn = $("generate");
const statusEl = $("status");
const resultsEl = $("results");
const machineEl = $("machine");
const diagramBox = $("diagramBox");
const calloutsEl = $("callouts");
const stepsEl = $("steps");
const speakBtn = $("speakBtn");
const stopSpeakBtn = $("stopSpeakBtn");

let stream = null;
let photoDataUrl = null;
let currentSteps = [];

// --- Camera ---
startCameraBtn.addEventListener("click", async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    video.srcObject = stream;
    video.hidden = false;
    preview.hidden = true;
    captureBtn.disabled = false;
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = "Camera unavailable — use the file upload instead.";
  }
});

captureBtn.addEventListener("click", () => {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  photoDataUrl = canvas.toDataURL("image/jpeg", 0.85);
  preview.src = photoDataUrl;
  preview.hidden = false;
  video.hidden = true;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  captureBtn.disabled = true;
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    photoDataUrl = reader.result;
    preview.src = photoDataUrl;
    preview.hidden = false;
    video.hidden = true;
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
    calloutsEl.innerHTML = "";
    stepsEl.innerHTML = `<li class="error">${escapeHtml(err.message)}</li>`;
    currentSteps = [];
  } finally {
    generateBtn.disabled = false;
  }
});

function renderManual(data) {
  resultsEl.hidden = false;
  machineEl.textContent = data.machine || "Unknown — see steps";
  diagramBox.textContent = data.diagramNote ||
    "Exploded-view diagram appears here.";
  calloutsEl.innerHTML = (data.callouts || [])
    .map((c) => `<li>${escapeHtml(String(c))}</li>`)
    .join("");
  currentSteps = data.steps || [];
  stepsEl.innerHTML = currentSteps
    .map((s) => {
      const label = (s.label || "inferred").toLowerCase();
      const cls = ["verified", "inferred", "illustrative"].includes(label)
        ? label
        : "inferred";
      return `<li>${escapeHtml(s.text)}<span class="badge ${cls}">${cls}</span></li>`;
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
