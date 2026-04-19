import init, { list_processors, parse_rcw } from "./pkg/rcw_reader.js";

let wasmReady = false;
let selectedFile = null;

async function bootstrap() {
  await init();
  wasmReady = true;

  // Populate processor dropdown from WASM
  const processors = JSON.parse(list_processors());
  const select = document.getElementById("processor-select");
  processors.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  });

  updateParseButton();
}

function updateParseButton() {
  const btn = document.getElementById("parse-btn");
  btn.disabled = !(wasmReady && selectedFile !== null);
}

// ── File input ──────────────────────────────────────────────────────────────

const fileInput = document.getElementById("file-input");
const dropZone = document.getElementById("drop-zone");

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    selectedFile = fileInput.files[0];
    dropZone.querySelector(".drop-hint").textContent = selectedFile.name;
    updateParseButton();
  }
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragging");
  const file = e.dataTransfer.files[0];
  if (file) {
    selectedFile = file;
    dropZone.querySelector(".drop-hint").textContent = file.name;
    updateParseButton();
  }
});

// ── Parse ───────────────────────────────────────────────────────────────────

document.getElementById("parse-btn").addEventListener("click", async () => {
  if (!selectedFile || !wasmReady) return;

  clearError();
  hideResults();

  const processor = document.getElementById("processor-select").value;

  try {
    // Only the first 72 bytes are needed (4 preamble + 4 address + 64 RCW).
    // Slicing avoids loading multi-megabyte flash images into memory.
    const HEAD = 72;
    const slice = selectedFile.size > HEAD ? selectedFile.slice(0, HEAD) : selectedFile;
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const resultStr = parse_rcw(bytes, processor);

    if (resultStr.startsWith("ERROR:")) {
      showError(resultStr.slice(7).trim());
      return;
    }

    const result = JSON.parse(resultStr);
    renderResults(result, selectedFile.name);
  } catch (err) {
    showError(`Unexpected error: ${err.message}`);
  }
});

// ── Render ──────────────────────────────────────────────────────────────────

function renderResults(result, filename) {
  document.getElementById("results-processor").textContent = result.processor;
  document.getElementById("results-filename").textContent = filename;

  const tbody = document.getElementById("fields-body");
  tbody.innerHTML = "";

  result.fields.forEach((field) => {
    const tr = document.createElement("tr");

    const bitsLabel = field.width === 1
      ? `[${field.bit_offset}]`
      : `[${field.bit_offset}:${field.bit_offset + field.width - 1}]`;

    let meaningCell;
    if (field.meaning !== null && field.meaning !== undefined) {
      meaningCell = `<span class="meaning-ok">${escHtml(field.meaning)}</span>`;
    } else {
      meaningCell = `<span class="meaning-unknown">
        ${escHtml(field.raw_hex)}
        <span class="badge">?</span>
      </span>`;
    }

    tr.innerHTML = `
      <td>${escHtml(field.name)}</td>
      <td>${escHtml(field.description)}</td>
      <td>${bitsLabel}</td>
      <td>${escHtml(field.raw_hex)}</td>
      <td>${meaningCell}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("results").classList.remove("hidden");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function showError(msg) {
  const banner = document.getElementById("error-banner");
  banner.textContent = msg;
  banner.classList.remove("hidden");
}

function clearError() {
  const banner = document.getElementById("error-banner");
  banner.textContent = "";
  banner.classList.add("hidden");
}

function hideResults() {
  document.getElementById("results").classList.add("hidden");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Boot ─────────────────────────────────────────────────────────────────────
bootstrap().catch((err) => {
  showError(`Failed to load WASM module: ${err.message}`);
});
