// ─────────────────────────────────────────────
//  app.js  –  Video Compiler Frontend Logic
//  Talks to the Cloudflare Worker at WORKER_URL
// ─────────────────────────────────────────────

const WORKER_URL = "lingering-leaf-b69a.anujitcj13.workers.dev"; // ← paste your Worker URL here
const MAX_SLOTS = 5;
const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

// ── State ──────────────────────────────────────
const slots = Array(MAX_SLOTS).fill(null); // null | File
let selectedMode = null; // "asis" | "trim"
let downloadUrl = null;

// ── DOM Refs ───────────────────────────────────
const uploadList  = document.getElementById("uploadList");
const countBar    = document.getElementById("countBar");
const makeVideoBtn= document.getElementById("makeVideoBtn");
const modeWrap    = document.getElementById("modeWrap");
const processWrap = document.getElementById("processWrap");
const processBtn  = document.getElementById("processBtn");
const statusWrap  = document.getElementById("statusWrap");
const progressFill= document.getElementById("progressFill");
const statusText  = document.getElementById("statusText");
const dlWrap      = document.getElementById("dlWrap");
const downloadBtn = document.getElementById("downloadBtn");
const toast       = document.getElementById("toast");
let toastTimer    = null;

// ── Build Upload Boxes ─────────────────────────
function buildBoxes() {
  uploadList.innerHTML = "";
  for (let i = 0; i < MAX_SLOTS; i++) {
    const file = slots[i];

    const box = document.createElement("div");
    box.className = "upload-box" + (file ? " filled" : "");
    box.dataset.index = i;

    // hidden file input
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "video/*";
    inp.className = "hidden-input";
    inp.id = `file-input-${i}`;
    inp.addEventListener("change", e => handleFileSelect(i, e.target.files[0]));

    // slot number
    const num = document.createElement("span");
    num.className = "slot-num";
    num.textContent = i + 1;

    // info area
    const info = document.createElement("div");
    info.className = "slot-info";

    const label = document.createElement("div");
    label.className = "slot-label";
    label.textContent = file ? "Video added" : "Tap to add video";

    const fname = document.createElement("div");
    fname.className = "slot-filename";
    fname.textContent = file ? file.name : "";

    const fsize = document.createElement("div");
    fsize.className = "slot-size";
    fsize.textContent = file ? formatSize(file.size) : "";

    info.appendChild(label);
    info.appendChild(fname);
    info.appendChild(fsize);

    // remove button
    const removeBtn = document.createElement("button");
    removeBtn.className = "slot-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", e => {
      e.stopPropagation();
      removeSlot(i);
    });

    box.appendChild(inp);
    box.appendChild(num);
    box.appendChild(info);
    box.appendChild(removeBtn);

    // click to open file picker (only if slot empty)
    box.addEventListener("click", () => {
      if (!slots[i]) inp.click();
    });

    // drag-and-drop
    box.addEventListener("dragover", e => { e.preventDefault(); box.classList.add("drag-over"); });
    box.addEventListener("dragleave", () => box.classList.remove("drag-over"));
    box.addEventListener("drop", e => {
      e.preventDefault();
      box.classList.remove("drag-over");
      const f = e.dataTransfer.files[0];
      if (f) handleFileSelect(i, f);
    });

    uploadList.appendChild(box);
  }
  updateUI();
}

// ── Handle File Selection ──────────────────────
function handleFileSelect(index, file) {
  if (!file) return;

  // must be video
  if (!file.type.startsWith("video/")) {
    showToast("Only video files are accepted.");
    return;
  }

  // size check
  if (file.size > MAX_SIZE_BYTES) {
    showToast("File exceeds 1 GB limit.");
    flashError(index);
    return;
  }

  // duplicate check
  const dupIndex = slots.findIndex(s => s && s.name === file.name && s.size === file.size);
  if (dupIndex !== -1) {
    showToast(`This file is already in slot ${dupIndex + 1}.`);
    flashError(index);
    return;
  }

  slots[index] = file;
  buildBoxes();
}

function removeSlot(index) {
  slots[index] = null;
  // reset mode & downstream UI when videos change
  selectedMode = null;
  hideModeAndBelow();
  buildBoxes();
}

function flashError(index) {
  const boxes = uploadList.querySelectorAll(".upload-box");
  const box = boxes[index];
  if (!box) return;
  box.classList.add("error-flash");
  setTimeout(() => box.classList.remove("error-flash"), 500);
}

// ── UI State ───────────────────────────────────
function updateUI() {
  const count = slots.filter(Boolean).length;
  countBar.textContent = `${count} / ${MAX_SLOTS} video${count !== 1 ? "s" : ""} added`;

  // show MAKE VIDEO if at least 1 video
  makeVideoBtn.style.display = count > 0 ? "block" : "none";

  // reset downstream when no videos
  if (count === 0) hideModeAndBelow();
}

function hideModeAndBelow() {
  modeWrap.classList.remove("visible");
  processWrap.classList.remove("visible");
  statusWrap.classList.remove("visible");
  dlWrap.classList.remove("visible");
  downloadUrl = null;
}

// ── MAKE VIDEO button ──────────────────────────
makeVideoBtn.addEventListener("click", () => {
  const count = slots.filter(Boolean).length;
  if (count === 0) return;

  // show mode selection
  modeWrap.classList.add("visible");
  processWrap.classList.add("visible");
  processBtn.disabled = true; // wait for mode pick
  statusWrap.classList.remove("visible");
  dlWrap.classList.remove("visible");

  // deselect mode
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("selected"));
  selectedMode = null;
});

// ── Mode Buttons ───────────────────────────────
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedMode = btn.dataset.mode;
    processBtn.disabled = false;
  });
});

// ── Process Button ─────────────────────────────
processBtn.addEventListener("click", async () => {
  if (!selectedMode) return;

  const files = slots.filter(Boolean);
  if (files.length === 0) return;

  // lock UI
  processBtn.disabled = true;
  makeVideoBtn.disabled = true;
  statusWrap.classList.add("visible");
  dlWrap.classList.remove("visible");
  setProgress(0, "Uploading videos to worker…");

  try {
    // 1. Upload each video to worker, get back file IDs
    const fileIds = [];
    for (let i = 0; i < files.length; i++) {
      setProgress(Math.round((i / files.length) * 50), `Uploading video ${i + 1} of ${files.length}…`);
      const id = await uploadFile(files[i]);
      fileIds.push(id);
    }

    setProgress(55, "Starting compilation job…");

    // 2. Send compile job to worker
    const jobRes = await fetch(`${WORKER_URL}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds, mode: selectedMode })
    });
    if (!jobRes.ok) throw new Error(await jobRes.text());
    const { jobId } = await jobRes.json();

    setProgress(60, "Processing… this may take a few minutes.");

    // 3. Poll for job status
    await pollJob(jobId);

  } catch (err) {
    setProgress(0, "Error: " + err.message);
    processBtn.disabled = false;
    makeVideoBtn.disabled = false;
  }
});

// ── Upload single file ─────────────────────────
async function uploadFile(file) {
  const formData = new FormData();
  formData.append("video", file);

  const res = await fetch(`${WORKER_URL}/upload`, {
    method: "POST",
    body: formData
  });
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
  const data = await res.json();
  return data.fileId;
}

// ── Poll job status ────────────────────────────
async function pollJob(jobId) {
  const maxWait = 15 * 60 * 1000; // 15 min timeout
  const interval = 3000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(interval);

    const res = await fetch(`${WORKER_URL}/status/${jobId}`);
    if (!res.ok) throw new Error("Status check failed");
    const data = await res.json();

    if (data.status === "done") {
      setProgress(100, "Done! Your video is ready.");
      downloadUrl = data.downloadUrl;
      dlWrap.classList.add("visible");
      makeVideoBtn.disabled = false;
      return;
    } else if (data.status === "error") {
      throw new Error(data.message || "Worker processing failed.");
    } else {
      // still processing
      const elapsed = Math.round((Date.now() - start) / 1000);
      const pct = Math.min(60 + elapsed, 95);
      setProgress(pct, data.message || "Processing…");
    }
  }
  throw new Error("Timed out waiting for processing.");
}

// ── Download Button ────────────────────────────
downloadBtn.addEventListener("click", () => {
  if (!downloadUrl) return;
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = "compiled_video.mp4";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// ── Helpers ────────────────────────────────────
function setProgress(pct, msg) {
  progressFill.style.width = pct + "%";
  statusText.textContent = msg;
}

function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let toastTimer2 = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer2);
  toastTimer2 = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ── Init ───────────────────────────────────────
buildBoxes();
