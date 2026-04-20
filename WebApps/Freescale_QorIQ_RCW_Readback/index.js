import init, { get_version, list_processors, parse_rcw } from "./pkg/rcw_reader.js";

let wasmReady = false;
let selectedFile = null;
let lastParseResult = null;   // cached so SYSCLK changes recalculate instantly

async function bootstrap() {
  await init();
  wasmReady = true;

  document.getElementById("app-version").textContent = `v${get_version()}`;

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
  document.getElementById("parse-btn").disabled = !(wasmReady && selectedFile !== null);
}

// ── File input ───────────────────────────────────────────────────────────────

const fileInput = document.getElementById("file-input");
const dropZone  = document.getElementById("drop-zone");

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    selectedFile = fileInput.files[0];
    dropZone.querySelector(".drop-hint").textContent = selectedFile.name;
    updateParseButton();
  }
});

dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("dragging"); });
dropZone.addEventListener("dragleave", ()  => { dropZone.classList.remove("dragging"); });
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

// ── SYSCLK live recalculation ────────────────────────────────────────────────

document.getElementById("sysclk-input").addEventListener("input", () => {
  if (lastParseResult) {
    renderFrequencies(lastParseResult);
    renderIssues(lastParseResult);
  }
});

// ── Parse ────────────────────────────────────────────────────────────────────

document.getElementById("parse-btn").addEventListener("click", async () => {
  if (!selectedFile || !wasmReady) return;

  clearError();
  hideResults();

  const processor = document.getElementById("processor-select").value;

  try {
    const MIN_SIZE = 72;
    const HEAD = 4096; // enough for any PBL image; large flash files are still not fully loaded
    if (selectedFile.size < MIN_SIZE) {
      showError(`File too small (${selectedFile.size} bytes). A valid PBL binary must be at least ${MIN_SIZE} bytes — 4-byte preamble + 4-byte destination address + 64-byte RCW payload.`);
      return;
    }
    const slice = selectedFile.size > HEAD ? selectedFile.slice(0, HEAD) : selectedFile;
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const resultStr = parse_rcw(bytes, processor);

    if (resultStr.startsWith("ERROR:")) {
      showError(resultStr.slice(7).trim());
      return;
    }

    lastParseResult = JSON.parse(resultStr);
    renderFrequencies(lastParseResult);
    renderResults(lastParseResult, selectedFile.name);
    renderIssues(lastParseResult);
  } catch (err) {
    showError(`Unexpected error: ${err.message}`);
  }
});

// ── RCW fields table ─────────────────────────────────────────────────────────

function renderResults(result, filename) {
  document.getElementById("results-processor").textContent = result.processor;
  document.getElementById("results-filename").textContent = filename;

  const crcEl = document.getElementById("results-crc");
  if (result.crc_ok === null || result.crc_ok === undefined) {
    crcEl.textContent = "No CRC";
    crcEl.className = "crc-badge crc-none";
    crcEl.title = "No PBL end command with CRC found in file";
  } else if (result.crc_ok) {
    crcEl.textContent = "CRC OK";
    crcEl.className = "crc-badge crc-ok";
    crcEl.title = `Stored: ${result.crc_stored}  Computed: ${result.crc_computed}`;
  } else {
    crcEl.textContent = "CRC FAIL";
    crcEl.className = "crc-badge crc-fail";
    crcEl.title = `Stored: ${result.crc_stored}  Computed: ${result.crc_computed}`;
  }

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
      meaningCell = `<span class="meaning-unknown">${escHtml(field.raw_hex)}<span class="badge">?</span></span>`;
    }

    tr.innerHTML = `
      <td>${escHtml(field.name)}</td>
      <td>${escHtml(field.description)}</td>
      <td>${bitsLabel}</td>
      <td>${escHtml(field.raw_hex)}</td>
      <td>${meaningCell}</td>`;

    if (SERDES_FIELDS.has(field.name)) {
      tr.classList.add("serdes-row");
      attachSerdesHover(tr, field.name, field.raw_value, result.fields);
    }

    tbody.appendChild(tr);
  });

  document.getElementById("results").classList.remove("hidden");
}

// ── Derived frequencies ──────────────────────────────────────────────────────

function getSysclk() {
  const v = parseFloat(document.getElementById("sysclk-input").value);
  return isNaN(v) || v <= 0 ? 100 : v;
}

/** Returns raw_value for a named field, or null if not found / zero. */
function fieldVal(fields, name) {
  const f = fields.find(f => f.name === name);
  return f ? f.raw_value : null;
}

/** Format a MHz value as e.g. "800 MHz" or "1.6 GHz". */
function fmtMHz(mhz) {
  if (mhz >= 1000) return `${+(mhz / 1000).toFixed(4).replace(/\.?0+$/, "")} GHz`;
  return `${+mhz.toFixed(4).replace(/\.?0+$/, "")} MHz`;
}

/** Format a MT/s value. */
function fmtMTs(mts) {
  if (mts >= 1000) return `${+(mts / 1000).toFixed(3).replace(/\.?0+$/, "")} GT/s`;
  return `${+mts.toFixed(3).replace(/\.?0+$/, "")} MT/s`;
}

// PLL select encoding → { pll: string, div: number }
const PLL_SEL_P3041 = {
  0: { pll: "CC1", div: 1 }, 1: { pll: "CC1", div: 2 }, 2: { pll: "CC1", div: 4 },
  4: { pll: "CC2", div: 1 }, 5: { pll: "CC2", div: 2 }, 6: { pll: "CC2", div: 4 },
};
const PLL_SEL_T2080 = {
  0: { pll: "CGA1", div: 1 }, 1: { pll: "CGA1", div: 2 }, 2: { pll: "CGA1", div: 4 },
  4: { pll: "CGA2", div: 1 }, 5: { pll: "CGA2", div: 2 }, 6: { pll: "CGA2", div: 4 },
};
// P4080/P5040: CC1-CC4 (P4080) or CC1-CC3 (P5040)
const PLL_SEL_CC4 = {
  0:  { pll: "CC1", div: 1 }, 1:  { pll: "CC1", div: 2 }, 2:  { pll: "CC1", div: 4 },
  4:  { pll: "CC2", div: 1 }, 5:  { pll: "CC2", div: 2 }, 6:  { pll: "CC2", div: 4 },
  8:  { pll: "CC3", div: 1 }, 9:  { pll: "CC3", div: 2 }, 10: { pll: "CC3", div: 4 },
  12: { pll: "CC4", div: 1 }, 13: { pll: "CC4", div: 2 }, 14: { pll: "CC4", div: 4 },
};
// T4240: CGA_PLL1/2/3 + CGB_PLL1/2
const PLL_SEL_T4240_CGA = {
  0:  { pll: "CGA1", div: 1 }, 1:  { pll: "CGA1", div: 2 }, 2:  { pll: "CGA1", div: 4 },
  4:  { pll: "CGA2", div: 1 }, 5:  { pll: "CGA2", div: 2 }, 6:  { pll: "CGA2", div: 4 },
  8:  { pll: "CGA3", div: 1 }, 9:  { pll: "CGA3", div: 2 }, 10: { pll: "CGA3", div: 4 },
  12: { pll: "PLAT", div: 1 },
};

/** Returns 'over' | 'under' | 'ok' | null (no limit defined). */
function checkLimit(row) {
  if (row.mhz == null || !row.limit) return null;
  if (row.limit.max != null && row.mhz > row.limit.max) return "over";
  if (row.limit.min != null && row.mhz < row.limit.min) return "under";
  return "ok";
}

function calcFreqs(result, sysclk) {
  const { processor, fields } = result;
  const fv = (name) => fieldVal(fields, name);
  const groups = [];

  if (processor === "P3041") {
    // Limits from P3041 Hardware Specifications Rev.2 Table 100 (1500 MHz grade max used).
    // ── System ───────────────────────────────────────────────────────────────
    const sysGroup = { title: "System", rows: [] };

    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk), mhz: platClk, limit: { min: 600, max: 750 } });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    // ── Core PLLs ─────────────────────────────────────────────────────────────
    const pllGroup = { title: "Core Cluster PLLs", rows: [] };
    let cc1 = null, cc2 = null;

    const cc1Rat = fv("CC1_PLL_RAT");
    if (cc1Rat) {
      cc1 = sysclk * cc1Rat;
      pllGroup.rows.push({ label: "CC1 PLL", note: `SYSCLK × ${cc1Rat}`, value: fmtMHz(cc1), mhz: cc1, limit: { min: 800, max: 1500 } });
    }
    const cc2Rat = fv("CC2_PLL_RAT");
    if (cc2Rat) {
      cc2 = sysclk * cc2Rat;
      pllGroup.rows.push({ label: "CC2 PLL", note: `SYSCLK × ${cc2Rat}`, value: fmtMHz(cc2), mhz: cc2, limit: { min: 800, max: 1500 } });
    }
    if (pllGroup.rows.length) groups.push(pllGroup);

    // ── Core frequencies ──────────────────────────────────────────────────────
    const coreGroup = { title: "Core Frequencies", rows: [] };
    const pllMap = { CC1: cc1, CC2: cc2 };
    ["C0", "C1", "C2", "C3"].forEach((core, i) => {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_P3041[sel];
      if (entry && pllMap[entry.pll] !== null) {
        const freq = pllMap[entry.pll] / entry.div;
        const divStr = entry.div > 1 ? ` / ${entry.div}` : "";
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll}${divStr}`, value: fmtMHz(freq), mhz: freq, limit: { min: 400, max: 1500 } });
      }
    });
    if (coreGroup.rows.length) groups.push(coreGroup);

    // ── Memory ────────────────────────────────────────────────────────────────
    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    const ddrSync = fv("DDR_SYNC");
    if (memRat) {
      const refClk = (ddrSync === 1 && platClk) ? platClk : sysclk;
      const refLabel = ddrSync === 1 ? "Platform clock" : "SYSCLK";
      const ddrClk = refClk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `${refLabel} × ${memRat}`, value: fmtMHz(ddrClk), mhz: ddrClk, limit: { min: 400, max: 667 } });
      memGroup.rows.push({ label: "DDR data rate", note: `DDR clock × 2`,            value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    // ── Frame Manager ─────────────────────────────────────────────────────────
    const fmGroup = { title: "Frame Manager", rows: [] };
    const fmSel = fv("FM_CLK_SEL");
    if (fmSel === 0 && platClk) {
      fmGroup.rows.push({ label: "FM clock", note: "Platform clock / 2", value: fmtMHz(platClk / 2), mhz: platClk / 2, limit: { max: 583 } });
    } else if (fmSel === 1 && cc2) {
      fmGroup.rows.push({ label: "FM clock", note: "CC2 PLL / 2", value: fmtMHz(cc2 / 2), mhz: cc2 / 2, limit: { max: 583 } });
    }
    const hwaSel = fv("HWA_ASYNC_DIV");
    if (hwaSel !== null && cc2) {
      const div = hwaSel === 0 ? 2 : 4;
      fmGroup.rows.push({ label: "HW accelerator clock", note: `CC2 PLL / ${div}`, value: fmtMHz(cc2 / div) });
    }
    if (fmGroup.rows.length) groups.push(fmGroup);

  } else if (processor === "T2080" || processor === "T2081") {
    // Limits from T2080 Data Sheet Rev.3 Table 121 (1800 MHz grade max used).
    // ── System ───────────────────────────────────────────────────────────────
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk), mhz: platClk, limit: { min: 400, max: 600 } });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    // ── Cluster PLLs ─────────────────────────────────────────────────────────
    const pllGroup = { title: "Cluster Group A PLLs", rows: [] };
    let cga1 = null, cga2 = null;

    const cga1Rat = fv("CGA_PLL1_RAT");
    if (cga1Rat) {
      cga1 = sysclk * cga1Rat;
      pllGroup.rows.push({ label: "CGA PLL1", note: `SYSCLK × ${cga1Rat}`, value: fmtMHz(cga1), mhz: cga1, limit: { min: 1000, max: 1800 } });
    }
    const cga2Rat = fv("CGA_PLL2_RAT");
    if (cga2Rat) {
      cga2 = sysclk * cga2Rat;
      pllGroup.rows.push({ label: "CGA PLL2", note: `SYSCLK × ${cga2Rat}`, value: fmtMHz(cga2), mhz: cga2, limit: { min: 1000, max: 1800 } });
    }
    if (pllGroup.rows.length) groups.push(pllGroup);

    // ── Cluster frequency ─────────────────────────────────────────────────────
    const coreGroup = { title: "Cluster Frequencies", rows: [] };
    const pllMap = { CGA1: cga1, CGA2: cga2 };
    const c1Sel = fv("C1_PLL_SEL");
    const entry = PLL_SEL_T2080[c1Sel];
    if (entry && pllMap[entry.pll] !== null) {
      const freq = pllMap[entry.pll] / entry.div;
      const divStr = entry.div > 1 ? ` / ${entry.div}` : "";
      coreGroup.rows.push({ label: "Cluster 1 clock", note: `${entry.pll}${divStr}`, value: fmtMHz(freq), mhz: freq, limit: { min: 250, max: 1800 } });
    }
    if (coreGroup.rows.length) groups.push(coreGroup);

    // ── Memory ────────────────────────────────────────────────────────────────
    // Note: T2080 DDR uses its own DDRCLK pin (asynchronous only).
    // MEM_PLL_RAT here is relative to DDRCLK, not SYSCLK — value shown for reference only.
    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    if (memRat) {
      const ddrClk = sysclk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `SYSCLK × ${memRat} (ref only)`, value: fmtMHz(ddrClk), mhz: ddrClk, limit: { min: 533, max: 1066 } });
      memGroup.rows.push({ label: "DDR data rate", note: `DDR clock × 2`,                  value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    // ── Frame Manager ─────────────────────────────────────────────────────────
    const fmGroup = { title: "Frame Manager", rows: [] };
    const fmSel = fv("HWA_CGA_M1_CLK_SEL");
    const fmCalc = {
      1: cga1 ? { v: cga1 / 1, n: "CGA PLL1 / 1" } : null,
      2: cga1 ? { v: cga1 / 2, n: "CGA PLL1 / 2" } : null,
      3: cga1 ? { v: cga1 / 3, n: "CGA PLL1 / 3" } : null,
      4: cga1 ? { v: cga1 / 4, n: "CGA PLL1 / 4" } : null,
      5: platClk ? { v: platClk,  n: "Platform clock"  } : null,
      6: cga2 ? { v: cga2 / 2, n: "CGA PLL2 / 2" } : null,
      7: cga2 ? { v: cga2 / 3, n: "CGA PLL2 / 3" } : null,
    };
    const fmEntry = fmSel !== null ? fmCalc[fmSel] : null;
    if (fmEntry) {
      fmGroup.rows.push({ label: "FM clock", note: fmEntry.n, value: fmtMHz(fmEntry.v), mhz: fmEntry.v, limit: { max: 700 } });
    }

    const m2Sel = fv("HWA_CGA_M2_CLK_SEL");
    const m2Calc = {
      1: cga2 ? { v: cga2 / 1, n: "CGA PLL2 / 1" } : null,
      2: cga2 ? { v: cga2 / 2, n: "CGA PLL2 / 2" } : null,
      3: cga2 ? { v: cga2 / 3, n: "CGA PLL2 / 3" } : null,
      4: cga2 ? { v: cga2 / 4, n: "CGA PLL2 / 4" } : null,
      6: cga1 ? { v: cga1 / 2, n: "CGA PLL1 / 2" } : null,
      7: cga1 ? { v: cga1 / 3, n: "CGA PLL1 / 3" } : null,
    };
    const m2Entry = m2Sel !== null ? m2Calc[m2Sel] : null;
    if (m2Entry) {
      fmGroup.rows.push({ label: "eSDHC SDR clock", note: m2Entry.n, value: fmtMHz(m2Entry.v) });
    }
    if (fmGroup.rows.length) groups.push(fmGroup);

  } else if (processor === "P2041") {
    // P2041: CC1/CC2 PLLs, C0-C3
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk) });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    const pllGroup = { title: "Core Cluster PLLs", rows: [] };
    let cc1 = null, cc2 = null;
    const cc1Rat = fv("CC1_PLL_RAT");
    if (cc1Rat) { cc1 = sysclk * cc1Rat; pllGroup.rows.push({ label: "CC1 PLL", note: `SYSCLK × ${cc1Rat}`, value: fmtMHz(cc1) }); }
    const cc2Rat = fv("CC2_PLL_RAT");
    if (cc2Rat) { cc2 = sysclk * cc2Rat; pllGroup.rows.push({ label: "CC2 PLL", note: `SYSCLK × ${cc2Rat}`, value: fmtMHz(cc2) }); }
    if (pllGroup.rows.length) groups.push(pllGroup);

    const coreGroup = { title: "Core Frequencies", rows: [] };
    const pllMap = { CC1: cc1, CC2: cc2 };
    ["C0","C1","C2","C3"].forEach((core, i) => {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_P3041[sel];
      if (entry && pllMap[entry.pll] != null) {
        const freq = pllMap[entry.pll] / entry.div;
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll} / ${entry.div}`, value: fmtMHz(freq) });
      }
    });
    if (coreGroup.rows.length) groups.push(coreGroup);

    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    const ddrSync = fv("DDR_SYNC");
    if (memRat) {
      const refClk = (ddrSync === 1 && platClk) ? platClk : sysclk;
      const ddrClk = refClk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `${ddrSync === 1 ? "Platform clock" : "SYSCLK"} × ${memRat}`, value: fmtMHz(ddrClk) });
      memGroup.rows.push({ label: "DDR data rate", note: "DDR clock × 2", value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    const fmGroup2 = { title: "Frame Manager", rows: [] };
    const fmSel2 = fv("FM_CLK_SEL");
    if (fmSel2 === 0 && platClk) fmGroup2.rows.push({ label: "FM clock", note: "Platform clock / 2", value: fmtMHz(platClk / 2) });
    else if (fmSel2 === 1 && cc2)  fmGroup2.rows.push({ label: "FM clock", note: "CC2 PLL / 2", value: fmtMHz(cc2 / 2) });
    if (fmGroup2.rows.length) groups.push(fmGroup2);

  } else if (processor === "T1040" || processor === "T1042") {
    // T1040: CGA_PLL1/PLL2, C1-C4 (1-indexed)
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk) });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    const pllGroup = { title: "Cluster Group A PLLs", rows: [] };
    let cga1 = null, cga2 = null;
    const cga1Rat = fv("CGA_PLL1_RAT");
    if (cga1Rat) { cga1 = sysclk * cga1Rat; pllGroup.rows.push({ label: "CGA PLL1", note: `SYSCLK × ${cga1Rat}`, value: fmtMHz(cga1) }); }
    const cga2Rat = fv("CGA_PLL2_RAT");
    if (cga2Rat) { cga2 = sysclk * cga2Rat; pllGroup.rows.push({ label: "CGA PLL2", note: `SYSCLK × ${cga2Rat}`, value: fmtMHz(cga2) }); }
    if (pllGroup.rows.length) groups.push(pllGroup);

    const coreGroup = { title: "Core Frequencies", rows: [] };
    const pllMap = { CGA1: cga1, CGA2: cga2 };
    [1,2,3,4].forEach(i => {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_T2080[sel];
      if (entry && pllMap[entry.pll] != null) {
        const freq = pllMap[entry.pll] / entry.div;
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll} / ${entry.div}`, value: fmtMHz(freq) });
      }
    });
    if (coreGroup.rows.length) groups.push(coreGroup);

    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    const ddrRefSel = fv("DDR_REFCLK_SEL");
    const ddrFbMult = fv("DDR_FDBK_MULT");
    if (memRat) {
      const refClk = (ddrRefSel === 1) ? sysclk : sysclk; // external pin — can't calculate, use SYSCLK as approximation
      const mult = (ddrFbMult === 2) ? 2 : (ddrFbMult === 3) ? 3 : 1;
      const ddrClk = refClk * mult * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `SYSCLK × ${mult > 1 ? mult + "×" : ""}${memRat}`, value: fmtMHz(ddrClk) });
      memGroup.rows.push({ label: "DDR data rate", note: "DDR clock × 2", value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    const fmGroup = { title: "Frame Manager", rows: [] };
    const fmSel = fv("HWA_CGA_M1_CLK_SEL");
    const fmCalcT1040 = {
      1: cga1 ? { v: cga1 / 1, n: "CGA PLL1 / 1" } : null,
      2: cga1 ? { v: cga1 / 2, n: "CGA PLL1 / 2" } : null,
      3: cga1 ? { v: cga1 / 3, n: "CGA PLL1 / 3" } : null,
      4: cga1 ? { v: cga1 / 4, n: "CGA PLL1 / 4" } : null,
      5: platClk ? { v: platClk,  n: "Platform clock"  } : null,
      6: cga2 ? { v: cga2 / 2, n: "CGA PLL2 / 2" } : null,
      7: cga2 ? { v: cga2 / 3, n: "CGA PLL2 / 3" } : null,
    };
    const fmEntry = fmSel !== null ? fmCalcT1040[fmSel] : null;
    if (fmEntry) fmGroup.rows.push({ label: "FM clock", note: fmEntry.n, value: fmtMHz(fmEntry.v) });
    if (fmGroup.rows.length) groups.push(fmGroup);

  } else if (processor === "T1024" || processor === "T1023") {
    // T1024: single CGA_PLL1, C1-C2 only
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk) });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    const pllGroup = { title: "Cluster Group A PLL", rows: [] };
    let cga1 = null;
    const cga1Rat = fv("CGA_PLL1_RAT");
    if (cga1Rat) { cga1 = sysclk * cga1Rat; pllGroup.rows.push({ label: "CGA PLL1", note: `SYSCLK × ${cga1Rat}`, value: fmtMHz(cga1) }); }
    if (pllGroup.rows.length) groups.push(pllGroup);

    const coreGroup = { title: "Core Frequencies", rows: [] };
    const PLL_SEL_T1024 = {
      0: { pll: "CGA1", div: 1 }, 1: { pll: "CGA1", div: 2 }, 2: { pll: "CGA1", div: 4 },
      8: { pll: "PLAT", div: 1 },
    };
    const pllMap = { CGA1: cga1, PLAT: platClk };
    [1,2].forEach(i => {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_T1024[sel];
      if (entry && pllMap[entry.pll] != null) {
        const freq = pllMap[entry.pll] / entry.div;
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll} / ${entry.div}`, value: fmtMHz(freq) });
      }
    });
    if (coreGroup.rows.length) groups.push(coreGroup);

    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    if (memRat) {
      const ddrClk = sysclk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `SYSCLK × ${memRat}`, value: fmtMHz(ddrClk) });
      memGroup.rows.push({ label: "DDR data rate", note: "DDR clock × 2",       value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    const fmGroup = { title: "Frame Manager / eSDHC", rows: [] };
    const fmSel = fv("HWA_CGA_M1_CLK_SEL");
    const fmCalcT1024 = {
      1: cga1   ? { v: cga1   / 1, n: "CGA PLL1 / 1" } : null,
      2: cga1   ? { v: cga1   / 2, n: "CGA PLL1 / 2" } : null,
      3: cga1   ? { v: cga1   / 3, n: "CGA PLL1 / 3" } : null,
      4: cga1   ? { v: cga1   / 4, n: "CGA PLL1 / 4" } : null,
      5: platClk ? { v: platClk,   n: "Platform clock" } : null,
    };
    const fmEntry = fmSel !== null ? fmCalcT1024[fmSel] : null;
    if (fmEntry) fmGroup.rows.push({ label: "FM1 clock", note: fmEntry.n, value: fmtMHz(fmEntry.v) });
    const m2Sel = fv("HWA_CGA_M2_CLK_SEL");
    if (m2Sel !== null && fmCalcT1024[m2Sel]) {
      fmGroup.rows.push({ label: "eSDHC clock", note: fmCalcT1024[m2Sel].n, value: fmtMHz(fmCalcT1024[m2Sel].v) });
    }
    if (fmGroup.rows.length) groups.push(fmGroup);

  } else if (processor === "T4240" || processor === "T4160") {
    // T4240: CGA_PLL1-3 + CGB_PLL1-2
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk) });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    const cgaGroup = { title: "Cluster Group A PLLs", rows: [] };
    let cga1 = null, cga2 = null, cga3 = null;
    const c1r = fv("CGA_PLL1_RAT"); if (c1r) { cga1 = sysclk * c1r; cgaGroup.rows.push({ label: "CGA PLL1", note: `SYSCLK × ${c1r}`, value: fmtMHz(cga1) }); }
    const c2r = fv("CGA_PLL2_RAT"); if (c2r) { cga2 = sysclk * c2r; cgaGroup.rows.push({ label: "CGA PLL2", note: `SYSCLK × ${c2r}`, value: fmtMHz(cga2) }); }
    const c3r = fv("CGA_PLL3_RAT"); if (c3r) { cga3 = sysclk * c3r; cgaGroup.rows.push({ label: "CGA PLL3", note: `SYSCLK × ${c3r}`, value: fmtMHz(cga3) }); }
    if (cgaGroup.rows.length) groups.push(cgaGroup);

    const cgbGroup = { title: "Cluster Group B PLLs", rows: [] };
    let cgb1 = null, cgb2 = null;
    const d1r = fv("CGB_PLL1_RAT"); if (d1r) { cgb1 = sysclk * d1r; cgbGroup.rows.push({ label: "CGB PLL1", note: `SYSCLK × ${d1r}`, value: fmtMHz(cgb1) }); }
    const d2r = fv("CGB_PLL2_RAT"); if (d2r) { cgb2 = sysclk * d2r; cgbGroup.rows.push({ label: "CGB PLL2", note: `SYSCLK × ${d2r}`, value: fmtMHz(cgb2) }); }
    if (cgbGroup.rows.length) groups.push(cgbGroup);

    const coreGroup = { title: "Core Frequencies (CGA)", rows: [] };
    const cgaPllMap = { CGA1: cga1, CGA2: cga2, CGA3: cga3, PLAT: platClk };
    [1,2,3].forEach(i => {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_T4240_CGA[sel];
      if (entry && cgaPllMap[entry.pll] != null) {
        const freq = cgaPllMap[entry.pll] / entry.div;
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll} / ${entry.div}`, value: fmtMHz(freq) });
      }
    });
    if (coreGroup.rows.length) groups.push(coreGroup);

    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    if (memRat) {
      const ddrClk = sysclk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `SYSCLK × ${memRat}`, value: fmtMHz(ddrClk) });
      memGroup.rows.push({ label: "DDR data rate", note: "DDR clock × 2",       value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    const fmGroup = { title: "Frame Manager / Accelerators", rows: [] };
    const buildCgaCalc = (p1, p2) => ({
      1: p1 ? { v: p1/1, n: "CGA PLL1 / 1" } : null, 2: p1 ? { v: p1/2, n: "CGA PLL1 / 2" } : null,
      3: p1 ? { v: p1/3, n: "CGA PLL1 / 3" } : null, 4: p1 ? { v: p1/4, n: "CGA PLL1 / 4" } : null,
      5: platClk ? { v: platClk, n: "Platform clock" } : null,
      6: p2 ? { v: p2/2, n: "CGA PLL2 / 2" } : null, 7: p2 ? { v: p2/3, n: "CGA PLL2 / 3" } : null,
    });
    const buildCgbCalc = (p1, p2) => ({
      1: p1 ? { v: p1/1, n: "CGB PLL1 / 1" } : null, 2: p1 ? { v: p1/2, n: "CGB PLL1 / 2" } : null,
      3: p1 ? { v: p1/3, n: "CGB PLL1 / 3" } : null, 4: p1 ? { v: p1/4, n: "CGB PLL1 / 4" } : null,
      5: platClk ? { v: platClk, n: "Platform clock" } : null,
      6: p2 ? { v: p2/2, n: "CGB PLL2 / 2" } : null, 7: p2 ? { v: p2/3, n: "CGB PLL2 / 3" } : null,
    });
    const cgaCalc = buildCgaCalc(cga1, cga2);
    const cgbCalc = buildCgbCalc(cgb1, cgb2);
    const m1Sel = fv("HWA_CGA_M1_CLK_SEL"); const m1e = m1Sel !== null ? cgaCalc[m1Sel] : null;
    if (m1e) fmGroup.rows.push({ label: "FM1 / CGA HWA clock", note: m1e.n, value: fmtMHz(m1e.v) });
    const cb1Sel = fv("HWA_CGB_M1_CLK_SEL"); const cb1e = cb1Sel !== null ? cgbCalc[cb1Sel] : null;
    if (cb1e) fmGroup.rows.push({ label: "CGB HWA M1 clock", note: cb1e.n, value: fmtMHz(cb1e.v) });
    const cb2Sel = fv("HWA_CGB_M2_CLK_SEL"); const cb2e = cb2Sel !== null ? cgbCalc[cb2Sel] : null;
    if (cb2e) fmGroup.rows.push({ label: "CGB HWA M2 clock", note: cb2e.n, value: fmtMHz(cb2e.v) });
    if (fmGroup.rows.length) groups.push(fmGroup);

  } else if (processor === "P4080") {
    // P4080: CC1-CC4, C0-C7
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk) });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    const pllGroup = { title: "Core Cluster PLLs", rows: [] };
    const ccFreqs = { CC1: null, CC2: null, CC3: null, CC4: null };
    [1,2,3,4].forEach(n => {
      const rat = fv(`CC${n}_PLL_RAT`);
      if (rat) {
        ccFreqs[`CC${n}`] = sysclk * rat;
        pllGroup.rows.push({ label: `CC${n} PLL`, note: `SYSCLK × ${rat}`, value: fmtMHz(ccFreqs[`CC${n}`]) });
      }
    });
    if (pllGroup.rows.length) groups.push(pllGroup);

    const coreGroup = { title: "Core Frequencies", rows: [] };
    for (let i = 0; i <= 7; i++) {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_CC4[sel];
      if (entry && ccFreqs[entry.pll] != null) {
        const freq = ccFreqs[entry.pll] / entry.div;
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll} / ${entry.div}`, value: fmtMHz(freq) });
      }
    }
    if (coreGroup.rows.length) groups.push(coreGroup);

    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    const ddrSync = fv("DDR_SYNC");
    if (memRat) {
      const refClk = (ddrSync === 1 && platClk) ? platClk : sysclk;
      const ddrClk = refClk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `${ddrSync === 1 ? "Platform clock" : "SYSCLK"} × ${memRat}`, value: fmtMHz(ddrClk) });
      memGroup.rows.push({ label: "DDR data rate", note: "DDR clock × 2", value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    const fmGroup = { title: "Frame Manager", rows: [] };
    const fm1Sel = fv("FM1_CLK_SEL");
    if (fm1Sel === 0 && platClk) fmGroup.rows.push({ label: "FM1 clock", note: "Platform clock / 2", value: fmtMHz(platClk / 2) });
    else if (fm1Sel === 1 && ccFreqs.CC3) fmGroup.rows.push({ label: "FM1 clock", note: "CC3 PLL / 2", value: fmtMHz(ccFreqs.CC3 / 2) });
    const fm2Sel = fv("FM2_CLK_SEL");
    if (fm2Sel === 0 && platClk) fmGroup.rows.push({ label: "FM2 clock", note: "Platform clock / 2", value: fmtMHz(platClk / 2) });
    else if (fm2Sel === 1 && ccFreqs.CC4) fmGroup.rows.push({ label: "FM2 clock", note: "CC4 PLL / 2", value: fmtMHz(ccFreqs.CC4 / 2) });
    if (fmGroup.rows.length) groups.push(fmGroup);

  } else if (processor === "P5020" || processor === "P5010") {
    // P5020: CC1-CC2, C0-C1
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk) });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    const pllGroup = { title: "Core Cluster PLLs", rows: [] };
    let cc1 = null, cc2 = null;
    const cc1Rat = fv("CC1_PLL_RAT"); if (cc1Rat) { cc1 = sysclk * cc1Rat; pllGroup.rows.push({ label: "CC1 PLL", note: `SYSCLK × ${cc1Rat}`, value: fmtMHz(cc1) }); }
    const cc2Rat = fv("CC2_PLL_RAT"); if (cc2Rat) { cc2 = sysclk * cc2Rat; pllGroup.rows.push({ label: "CC2 PLL", note: `SYSCLK × ${cc2Rat}`, value: fmtMHz(cc2) }); }
    if (pllGroup.rows.length) groups.push(pllGroup);

    const coreGroup = { title: "Core Frequencies", rows: [] };
    const pllMap = { CC1: cc1, CC2: cc2 };
    [0,1].forEach(i => {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_P3041[sel];
      if (entry && pllMap[entry.pll] != null) {
        const freq = pllMap[entry.pll] / entry.div;
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll} / ${entry.div}`, value: fmtMHz(freq) });
      }
    });
    if (coreGroup.rows.length) groups.push(coreGroup);

    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    const ddrSync = fv("DDR_SYNC");
    if (memRat) {
      const refClk = (ddrSync === 1 && platClk) ? platClk : sysclk;
      const ddrClk = refClk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `${ddrSync === 1 ? "Platform clock" : "SYSCLK"} × ${memRat}`, value: fmtMHz(ddrClk) });
      memGroup.rows.push({ label: "DDR data rate", note: "DDR clock × 2", value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    const fmGroup = { title: "Frame Manager", rows: [] };
    const fmSel = fv("FM_CLK_SEL");
    if (fmSel === 0 && platClk) fmGroup.rows.push({ label: "FM clock", note: "Platform clock / 2", value: fmtMHz(platClk / 2) });
    else if (fmSel === 1 && cc2)  fmGroup.rows.push({ label: "FM clock", note: "CC2 PLL / 2", value: fmtMHz(cc2 / 2) });
    if (fmGroup.rows.length) groups.push(fmGroup);

  } else if (processor === "P5040") {
    // P5040: CC1-CC3, C0-C3
    const sysGroup = { title: "System", rows: [] };
    const sysPllRat = fv("SYS_PLL_RAT");
    let platClk = null;
    if (sysPllRat) {
      platClk = sysclk * sysPllRat;
      sysGroup.rows.push({ label: "Platform clock", note: `SYSCLK × ${sysPllRat}`, value: fmtMHz(platClk) });
    }
    if (sysGroup.rows.length) groups.push(sysGroup);

    const pllGroup = { title: "Core Cluster PLLs", rows: [] };
    const ccFreqs = { CC1: null, CC2: null, CC3: null };
    [1,2,3].forEach(n => {
      const rat = fv(`CC${n}_PLL_RAT`);
      if (rat) {
        ccFreqs[`CC${n}`] = sysclk * rat;
        pllGroup.rows.push({ label: `CC${n} PLL`, note: `SYSCLK × ${rat}`, value: fmtMHz(ccFreqs[`CC${n}`]) });
      }
    });
    if (pllGroup.rows.length) groups.push(pllGroup);

    const coreGroup = { title: "Core Frequencies", rows: [] };
    const PLL_SEL_CC3 = {
      0:  { pll: "CC1", div: 1 }, 1:  { pll: "CC1", div: 2 }, 2:  { pll: "CC1", div: 4 },
      4:  { pll: "CC2", div: 1 }, 5:  { pll: "CC2", div: 2 }, 6:  { pll: "CC2", div: 4 },
      8:  { pll: "CC3", div: 1 }, 9:  { pll: "CC3", div: 2 }, 10: { pll: "CC3", div: 4 },
    };
    for (let i = 0; i <= 3; i++) {
      const sel = fv(`C${i}_PLL_SEL`);
      const entry = PLL_SEL_CC3[sel];
      if (entry && ccFreqs[entry.pll] != null) {
        const freq = ccFreqs[entry.pll] / entry.div;
        coreGroup.rows.push({ label: `Core ${i}`, note: `${entry.pll} / ${entry.div}`, value: fmtMHz(freq) });
      }
    }
    if (coreGroup.rows.length) groups.push(coreGroup);

    const memGroup = { title: "Memory (DDR)", rows: [] };
    const memRat = fv("MEM_PLL_RAT");
    const ddrSync = fv("DDR_SYNC");
    if (memRat) {
      const refClk = (ddrSync === 1 && platClk) ? platClk : sysclk;
      const ddrClk = refClk * memRat;
      memGroup.rows.push({ label: "DDR clock",     note: `${ddrSync === 1 ? "Platform clock" : "SYSCLK"} × ${memRat}`, value: fmtMHz(ddrClk) });
      memGroup.rows.push({ label: "DDR data rate", note: "DDR clock × 2", value: fmtMTs(ddrClk * 2) });
    }
    if (memGroup.rows.length) groups.push(memGroup);

    const fmGroup = { title: "Frame Manager", rows: [] };
    const fmSel = fv("FM_CLK_SEL");
    if (fmSel === 0 && platClk) fmGroup.rows.push({ label: "FM clock", note: "Platform clock / 2", value: fmtMHz(platClk / 2) });
    else if (fmSel === 1 && ccFreqs.CC2) fmGroup.rows.push({ label: "FM clock", note: "CC2 PLL / 2", value: fmtMHz(ccFreqs.CC2 / 2) });
    if (fmGroup.rows.length) groups.push(fmGroup);
  }

  return groups;
}

function renderFrequencies(result) {
  const sysclk = getSysclk();
  const groups = calcFreqs(result, sysclk);

  document.getElementById("freq-sysclk-label").textContent = `SYSCLK = ${sysclk} MHz`;

  const container = document.getElementById("freq-groups");
  container.innerHTML = "";

  if (groups.length === 0) {
    container.innerHTML = `<p class="freq-empty">No calculable frequencies for this processor/configuration.</p>`;
  } else {
    groups.forEach((group) => {
      const card = document.createElement("div");
      card.className = "freq-card";
      card.innerHTML = `<h3>${escHtml(group.title)}</h3>`;
      const table = document.createElement("table");
      table.className = "freq-table";
      group.rows.forEach((row) => {
        const status = checkLimit(row);
        const valClass = (status === "over" || status === "under") ? "freq-value freq-out" : "freq-value";
        const badge = status === "over"
          ? `<span class="freq-limit-badge freq-over-badge" title="Exceeds maximum">▲</span>`
          : status === "under"
          ? `<span class="freq-limit-badge freq-under-badge" title="Below minimum">▼</span>`
          : "";
        const limitHint = row.limit
          ? [row.limit.min != null ? `min ${row.limit.min} MHz` : null,
             row.limit.max != null ? `max ${row.limit.max} MHz` : null]
            .filter(Boolean).join(", ")
          : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="freq-label">${escHtml(row.label)}</td>
          <td class="freq-note">${escHtml(row.note)}</td>
          <td class="${valClass}" title="${escHtml(limitHint)}">${escHtml(row.value)}${badge}</td>`;
        table.appendChild(tr);
      });
      card.appendChild(table);
      container.appendChild(card);
    });
  }

  document.getElementById("frequencies").classList.remove("hidden");
}

// ── Observed Issues ──────────────────────────────────────────────────────────

function renderIssues(result) {
  const issues = [];

  if (result.crc_ok === false) {
    issues.push({
      severity: "error",
      text: `PBL CRC check failed — stored ${result.crc_stored}, computed ${result.crc_computed}`,
    });
  }

  result.fields.forEach((f) => {
    if (f.meaning === null || f.meaning === undefined) {
      issues.push({
        severity: "warn",
        text: `Unknown value for field ${f.name} (${f.raw_hex}) — not defined in processor config`,
      });
    }
  });

  const sysclk = getSysclk();
  const groups = calcFreqs(result, sysclk);
  groups.forEach((g) => {
    g.rows.forEach((row) => {
      const status = checkLimit(row);
      if (status === "over") {
        issues.push({ severity: "error", text: `${row.label} (${row.value}) exceeds maximum of ${row.limit.max} MHz` });
      } else if (status === "under") {
        issues.push({ severity: "error", text: `${row.label} (${row.value}) is below minimum of ${row.limit.min} MHz` });
      }
    });
  });

  const section = document.getElementById("issues");
  const list    = document.getElementById("issues-list");
  const none    = document.getElementById("issues-none");

  list.innerHTML = "";
  if (issues.length === 0) {
    none.classList.remove("hidden");
    list.classList.add("hidden");
  } else {
    none.classList.add("hidden");
    list.classList.remove("hidden");
    issues.forEach((issue) => {
      const li = document.createElement("li");
      li.className = `issue-item issue-${issue.severity}`;
      li.textContent = issue.text;
      list.appendChild(li);
    });
  }

  section.classList.remove("hidden");
}

// ── SerDes protocol tables ────────────────────────────────────────────────────
// Source: P3041 Reference Manual Rev.4 Table 3-15 / T2080 Reference Manual Rev.4 Table 19-1
//
// P3041: single SRDS_PRTCL field.
//   b1[0..9] = Bank1 lanes A-J (10 lanes)
//   b2[0..3] = Bank2 lanes A-D (4 lanes)
//   b3[0..3] = Bank3 lanes A-D (4 lanes)
//
// T2080: two fields SRDS_PRTCL_S1 and SRDS_PRTCL_S2.
//   Each is an 8-element array for lanes A-H.

const L = ["A","B","C","D","E","F","G","H","I","J"];

// Shorthand helpers so the table below stays readable
const p = (n,sp) => sp ? `PCIe${n} (${sp})` : `PCIe${n}`;
const sg  = (n,sp) => `SGMII ${n}` + (sp ? ` (${sp})` : "");
const xfi = (n)    => `XFI ${n}`;
const sr  = (n,sp) => sp ? `sRIO${n} (${sp})` : `sRIO${n}`;

const SERDES_P3041 = {
  0x02: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","PCIe2","PCIe2","PCIe4","Debug"],
          b2:["PCIe3","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["—","—","SATA1","SATA2"] },
  0x04: { b1:["sRIO2","sRIO2","sRIO2","sRIO2","sRIO1","sRIO1","sRIO1","sRIO1","PCIe2","Debug"],
          b2:["PCIe3","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"] },
  0x0B: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","sRIO2","sRIO2","sRIO1","sRIO1","PCIe2","Debug"],
          b2:["PCIe3","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["—","—","SATA1","SATA2"] },
  0x10: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","Debug","Debug","Debug","Debug","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x11: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["—","—","SATA1","SATA2"] },
  0x13: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"] },
  0x14: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","PCIe2","PCIe2","PCIe3","Debug"],
          b2:["—","—","—","—"],
          b3:["SGMII EC1 (3.125G)","SGMII EC2 (3.125G)","SGMII EC3 (3.125G)","SGMII EC4 (3.125G)"] },
  0x15: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x16: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["sRIO1 (3.125G)","sRIO1 (3.125G)","sRIO1 (3.125G)","sRIO1 (3.125G)"] },
  0x17: { b1:["sRIO2","sRIO2","sRIO2","sRIO2","sRIO1","sRIO1","sRIO1","sRIO1","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["—","—","SATA1","SATA2"] },
  0x18: { b1:["sRIO2","sRIO2","sRIO2","sRIO2","sRIO1","sRIO1","sRIO1","sRIO1","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["SGMII EC5 (3.125G)","—","—","—"] },
  0x1B: { b1:["sRIO2","sRIO2","sRIO2","sRIO2","sRIO1","sRIO1","sRIO1","sRIO1","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x1D: { b1:["sRIO2 (3.125G)","sRIO2 (3.125G)","sRIO2 (3.125G)","sRIO2 (3.125G)","sRIO1 (3.125G)","sRIO1 (3.125G)","sRIO1 (3.125G)","sRIO1 (3.125G)","Debug","Debug"],
          b2:["PCIe3 (2.5G)","PCIe3 (2.5G)","PCIe3 (2.5G)","PCIe3 (2.5G)"],
          b3:["—","—","SATA1","SATA2"] },
  0x20: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","sRIO1","sRIO1","sRIO1","sRIO1","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"] },
  0x21: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","sRIO1","sRIO1","sRIO1","sRIO1","PCIe3","Debug"],
          b2:["—","—","—","—"],
          b3:["SGMII EC1 (3.125G)","SGMII EC2 (3.125G)","SGMII EC3 (3.125G)","SGMII EC4 (3.125G)"] },
  0x22: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","sRIO1","sRIO1","sRIO1","sRIO1","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x23: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","sRIO2","sRIO2","sRIO1","sRIO1","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["—","—","SATA1","SATA2"] },
  0x24: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","sRIO2","sRIO2","sRIO1","sRIO1","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["SGMII EC5 (3.125G)","—","—","—"] },
  0x28: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["—","—","SATA1","SATA2"] },
  0x29: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["SGMII EC5 (3.125G)","—","—","—"] },
  0x2A: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"] },
  0x2B: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","PCIe2","PCIe2","PCIe2","PCIe2","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x2F: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","sRIO2","sRIO2","sRIO1","sRIO1","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x31: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","sRIO1","sRIO1","sRIO1","sRIO1","Debug","Debug"],
          b2:["SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4"],
          b3:["SGMII EC5 (3.125G)","—","—","—"] },
  0x33: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","sRIO1","sRIO1","sRIO1","sRIO1","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x34: { b1:["PCIe1","PCIe1","PCIe1","PCIe1","SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x35: { b1:["PCIe1","PCIe1","PCIe2","PCIe2","SGMII EC3","SGMII EC4","Debug","Debug","—","—"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x36: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","SGMII EC1","SGMII EC2","SGMII EC3","SGMII EC4","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
  0x37: { b1:["PCIe1","PCIe1","PCIe3","PCIe3","PCIe2","PCIe2","SGMII EC3","SGMII EC4","Debug","Debug"],
          b2:["XAUI/10GEC","XAUI/10GEC","XAUI/10GEC","XAUI/10GEC"],
          b3:["—","—","SATA1","SATA2"] },
};

// T2080 SerDes 1 — lanes A-H (8 lanes)
const SERDES_T2080_S1 = {
  0x1C: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","SGMII 3","SGMII 4","SGMII 5","SGMII 6"],
  0x95: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","SGMII 3","SGMII 4","SGMII 5","SGMII 6"],
  0xA2: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","SGMII 3","SGMII 4","SGMII 5","SGMII 6"],
  0x94: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","SGMII 3","SGMII 4","SGMII 5","SGMII 6"],
  0x51: ["XAUI 9","XAUI 9","XAUI 9","XAUI 9","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0x5F: ["HiGig 9","HiGig 9","HiGig 9","HiGig 9","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0x65: ["HiGig 9","HiGig 9","HiGig 9","HiGig 9","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0x6A: ["XFI 9","XFI 10","XFI 1","XFI 2","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0x6B: ["XFI 9","XFI 10","XFI 1","XFI 2","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0x6C: ["XFI 9","XFI 10","SGMII 1","SGMII 2","PCIe4","—","—","—"],
  0x6D: ["XFI 9","XFI 10","SGMII 1","SGMII 2","PCIe4","—","—","—"],
  0x6E: ["XFI 9","XFI 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0x66: ["XFI 9","XFI 10","XFI 1","XFI 2","PCIe4","—","—","—"],
  0x67: ["XFI 9","XFI 10","XFI 1","XFI 2","PCIe4","—","—","—"],
  0x71: ["XFI 9","XFI 10","SGMII 1","SGMII 2","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0x82: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0x83: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0x8A: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","—","—","—"],
  0x8E: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0x8F: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0x96: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","—","—","—"],
  0xA4: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","—","—","—"],
  0xA6: ["SGMII 9","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0xAA: ["PCIe3","PCIe3","PCIe3","PCIe3","PCIe4","—","—","—"],
  0xAB: ["PCIe3","PCIe3","PCIe3","PCIe3","PCIe4","—","—","—"],
  0xBC: ["PCIe3","—","SGMII 1","SGMII 2","PCIe4","—","—","—"],
  0xC8: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0xCB: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0xD3: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0xD6: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 5","SGMII 6","—"],
  0xD8: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0xD9: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","SGMII 4","SGMII 5","SGMII 6"],
  0xDA: ["PCIe3","PCIe3","PCIe3","PCIe3","—","—","—","—"],
  0xDB: ["PCIe3","PCIe3","PCIe3","PCIe3","—","—","—","—"],
  0xDE: ["PCIe3","PCIe3","PCIe4","PCIe4","PCIe1","PCIe1","PCIe2","SGMII 6"],
  0xE0: ["PCIe3","PCIe3","PCIe4","PCIe4","PCIe1","SGMII 5","SGMII 6","—"],
  0xF2: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","PCIe1","PCIe2","SGMII 6"],
  0xF8: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","PCIe1","PCIe2","SGMII 6"],
  0xFA: ["PCIe3","SGMII 10","SGMII 1","SGMII 2","PCIe4","PCIe1","SGMII 5","SGMII 6"],
};

// T2080 SerDes 2 — lanes A-H (8 lanes)
const SERDES_T2080_S2 = {
  0x01: ["PCIe1","PCIe1","PCIe1","PCIe1","—","—","—","—"],
  0x02: ["PCIe1","PCIe1","PCIe1","PCIe1","—","—","—","—"],
  0x15: ["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","SATA1","SATA2"],
  0x16: ["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","SATA1","SATA2"],
  0x18: ["PCIe1","PCIe1","PCIe1","PCIe1","Aurora","Aurora","SATA1","SATA2"],
  0x1F: ["PCIe1","PCIe1","PCIe1","PCIe1","PCIe2","PCIe2","PCIe2","PCIe2"],
  0x27: ["PCIe1","PCIe1","PCIe1","PCIe1","—","—","SATA1","SATA2"],
  0x29: ["SRIO2","SRIO2","SRIO2","SRIO2","SRIO1","SRIO1","SRIO1","SRIO1"],
  0x2D: ["SRIO2","SRIO2","SRIO2","SRIO2","SRIO1","SRIO1","SRIO1","SRIO1"],
  0x2E: ["SRIO2","SRIO2","SRIO2","SRIO2","SRIO1","SRIO1","SRIO1","SRIO1"],
  0x36: ["SRIO2","SRIO2","SRIO2","SRIO2","Aurora","Aurora","SATA1","SATA2"],
};

// Fields that trigger the SerDes tooltip
const SERDES_FIELDS = new Set(["SRDS_PRTCL","SRDS_PRTCL_S1","SRDS_PRTCL_S2"]);

function buildSerdesPopup(fieldName, rawValue, allFields) {
  const tip = document.getElementById("serdes-tooltip");

  if (fieldName === "SRDS_PRTCL") {
    const entry = SERDES_P3041[rawValue];
    if (!entry) return false;
    tip.innerHTML = renderSerdesP3041(rawValue, entry);
    return true;
  }

  if (fieldName === "SRDS_PRTCL_S1" || fieldName === "SRDS_PRTCL_S2") {
    const s1Field = allFields.find(f => f.name === "SRDS_PRTCL_S1");
    const s2Field = allFields.find(f => f.name === "SRDS_PRTCL_S2");
    const s1Val = s1Field ? s1Field.raw_value : null;
    const s2Val = s2Field ? s2Field.raw_value : null;
    const s1Lanes = s1Val !== null ? SERDES_T2080_S1[s1Val] : null;
    const s2Lanes = s2Val !== null ? SERDES_T2080_S2[s2Val] : null;
    if (!s1Lanes && !s2Lanes) return false;
    tip.innerHTML = renderSerdesT2080(s1Val, s1Lanes, s2Val, s2Lanes);
    return true;
  }

  return false;
}

function laneTable(lanes, laneLabels) {
  const headers = laneLabels.map(l => `<th>${l}</th>`).join("");
  const cells   = lanes.map(v => {
    const cls = v === "—" ? "sd-unused" : "sd-used";
    return `<td class="${cls}">${escHtml(v)}</td>`;
  }).join("");
  return `<table class="sd-lane-table"><thead><tr>${headers}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`;
}

function renderSerdesP3041(val, entry) {
  const fmt = n => `0x${n.toString(16).toUpperCase().padStart(2,"0")}`;
  return `
    <div class="sd-title">SerDes Config — SRDS_PRTCL = ${fmt(val)}</div>
    <div class="sd-group-label">Bank 1 (lanes A–J)</div>
    ${laneTable(entry.b1, L.slice(0,10))}
    <div class="sd-group-label">Bank 2 (lanes A–D)</div>
    ${laneTable(entry.b2, L.slice(0,4))}
    <div class="sd-group-label">Bank 3 (lanes A–D)</div>
    ${laneTable(entry.b3, L.slice(0,4))}`;
}

function renderSerdesT2080(s1Val, s1Lanes, s2Val, s2Lanes) {
  const fmt = n => n !== null ? `0x${n.toString(16).toUpperCase().padStart(2,"0")}` : "?";
  let html = `<div class="sd-title">SerDes Config — S1=${fmt(s1Val)} · S2=${fmt(s2Val)}</div>`;
  if (s1Lanes) {
    html += `<div class="sd-group-label">SerDes 1 (SRDS_PRTCL_S1 = ${fmt(s1Val)}, lanes A–H)</div>`;
    html += laneTable(s1Lanes, L.slice(0,8));
  }
  if (s2Lanes) {
    html += `<div class="sd-group-label">SerDes 2 (SRDS_PRTCL_S2 = ${fmt(s2Val)}, lanes A–H)</div>`;
    html += laneTable(s2Lanes, L.slice(0,8));
  }
  return html;
}

// Attach hover handlers to a table row
function attachSerdesHover(tr, fieldName, rawValue, allFields) {
  const tip = document.getElementById("serdes-tooltip");

  tr.addEventListener("mouseenter", (e) => {
    const ok = buildSerdesPopup(fieldName, rawValue, allFields);
    if (!ok) return;
    tip.classList.remove("hidden");
    positionTooltip(e.currentTarget);
  });

  tr.addEventListener("mousemove", (e) => {
    positionTooltip(e.currentTarget);
  });

  tr.addEventListener("mouseleave", () => {
    tip.classList.add("hidden");
  });
}

function positionTooltip(anchorEl) {
  const tip  = document.getElementById("serdes-tooltip");
  const rect = anchorEl.getBoundingClientRect();
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;

  let top  = rect.bottom + scrollY + 6;
  let left = rect.left   + scrollX;

  // Keep within right edge
  const tipW = tip.offsetWidth;
  if (left + tipW > window.innerWidth + scrollX - 16) {
    left = window.innerWidth + scrollX - tipW - 16;
  }

  tip.style.top  = `${top}px`;
  tip.style.left = `${left}px`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  document.getElementById("frequencies").classList.add("hidden");
  document.getElementById("issues").classList.add("hidden");
  lastParseResult = null;
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
