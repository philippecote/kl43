// App-level top bar — sits above the device photo and hosts utilities that
// are not part of the emulated hardware. Kept visually distinct from the
// device so there's no confusion about what's "real" vs. dev affordance.
//
// Key Generator: produces a valid 32-letter key (30 body + 2 checksum),
// displayed in a dismissable modal with copy / type-into-device / regenerate.
// Cipher: lets the operator pick the substitute SAVILLE/AES/DES backend.
// Selection is persisted to localStorage and applied on the next page load —
// the backend is plumbed into the Machine at construction time, so mid-session
// swaps aren't safe; we reload instead. The real KL-43 only shipped with
// SAVILLE so this whole picker is an emulator-only convenience.
// The modem lives on the device's C-menu (Communications) flow — no
// app-level UI for it; see main.ts for the wiring.

import { decodeKey, appendChecksum } from "../crypto/KeyCodec.js";
import type { KeyEvent } from "../machine/Machine.js";
import type { BackendId } from "../crypto/CryptoBackend.js";
import { ALL_BACKENDS } from "../crypto/backends/registry.js";
import { modemConfig, MODEM_DEFAULTS, type ModemConfig } from "./modem.js";
import { buildShareUrl } from "./shareLink.js";
import { renderQrInto } from "./qrcode.js";

type Dispatcher = (ev: KeyEvent) => void;
type FlashKey = (id: string) => void;

const CIPHER_STORAGE = "kl43.cipher.v1";

function groupKey(letters: string): string {
  return letters.match(/.{1,8}/g)?.join(" ") ?? letters;
}

function generateKeyLetters(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  const body30 = decodeKey(raw).slice(0, 30);
  return appendChecksum(body30);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function setupKeyGen(dispatch: Dispatcher, flashKey: FlashKey, currentCipher: BackendId): void {
  const dlg = document.getElementById("keygen-dialog");
  const keyText = document.getElementById("keygen-key");
  const statusEl = document.getElementById("keygen-status");
  const btnRegen = document.getElementById("keygen-regen") as HTMLButtonElement | null;
  const btnCopy = document.getElementById("keygen-copy") as HTMLButtonElement | null;
  const btnType = document.getElementById("keygen-type") as HTMLButtonElement | null;
  const btnShare = document.getElementById("keygen-share") as HTMLButtonElement | null;
  const btnClose = document.getElementById("keygen-close") as HTMLButtonElement | null;
  const sharePanel = document.getElementById("keygen-share-panel");
  const shareUrlInput = document.getElementById("keygen-share-url") as HTMLInputElement | null;
  const shareQr = document.getElementById("keygen-share-qr");
  const openBtn = document.getElementById("menu-keygen");
  if (!dlg || !keyText || !statusEl || !btnRegen || !btnCopy || !btnType || !btnShare ||
      !btnClose || !sharePanel || !shareUrlInput || !shareQr || !openBtn) return;

  let current = "";
  const setStatus = (msg: string) => { statusEl.textContent = msg; };

  const hideShare = () => { sharePanel.hidden = true; };
  const regenerate = () => {
    current = generateKeyLetters();
    keyText.textContent = groupKey(current);
    hideShare();
    setStatus("Select the text above to copy, or use the buttons.");
  };

  btnRegen.addEventListener("click", regenerate);
  btnCopy.addEventListener("click", async () => {
    const ok = await copyToClipboard(current);
    setStatus(ok ? "Copied to clipboard." : "Clipboard unavailable — select text above and copy manually.");
  });
  btnType.addEventListener("click", () => {
    for (const ch of current) {
      dispatch({ kind: "char", ch });
      flashKey(ch);
    }
    setStatus(`Typed ${current.length} letters into device.`);
  });
  btnShare.addEventListener("click", async () => {
    const url = buildShareUrl({ key: current, cipher: currentCipher, name: "SHARED" });
    shareUrlInput.value = url;
    sharePanel.hidden = false;
    shareUrlInput.select();
    try { renderQrInto(shareQr, url); } catch (err) { console.warn("[kl43] qr render failed:", err); }
    const ok = await copyToClipboard(url);
    setStatus(ok
      ? "Share URL copied. Paste into the other device, or scan the QR code."
      : "Share URL ready below. Copy manually — clipboard was unavailable.");
  });

  const close = () => { dlg.classList.remove("show"); hideShare(); };
  btnClose.addEventListener("click", close);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dlg.classList.contains("show")) { close(); e.preventDefault(); }
  });
  openBtn.addEventListener("click", () => { regenerate(); dlg.classList.add("show"); });
}

function setupCipherPicker(currentId: BackendId): void {
  const dlg = document.getElementById("cipher-dialog");
  const form = document.getElementById("cipher-form") as HTMLFormElement | null;
  const statusEl = document.getElementById("cipher-status");
  const btnClose = document.getElementById("cipher-close") as HTMLButtonElement | null;
  const openBtn = document.getElementById("menu-cipher");
  if (!dlg || !form || !statusEl || !btnClose || !openBtn) return;

  form.innerHTML = "";
  for (const backend of ALL_BACKENDS) {
    const id = `cipher-opt-${backend.id}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.innerHTML =
      `<input type="radio" name="cipher" id="${id}" value="${backend.id}"` +
      (backend.id === currentId ? " checked" : "") +
      `><span class="cipher-meta">${backend.label}</span>` +
      `<span class="cipher-desc">${backend.description}</span>`;
    form.appendChild(label);
  }

  const close = () => dlg.classList.remove("show");
  btnClose.addEventListener("click", close);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dlg.classList.contains("show")) { close(); e.preventDefault(); }
  });

  form.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.name !== "cipher") return;
    const next = input.value as BackendId;
    if (next === currentId) return;
    localStorage.setItem(CIPHER_STORAGE, next);
    statusEl.textContent =
      "Cipher changed — reloading so the device picks up the new backend. " +
      "Messages encrypted under the old cipher will no longer decrypt.";
    setTimeout(() => window.location.reload(), 800);
  });

  openBtn.addEventListener("click", () => {
    statusEl.textContent = "";
    dlg.classList.add("show");
  });
}

type KnobSpec = {
  key: keyof ModemConfig;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  /** Optional formatter for the displayed value (default: 2 decimals). */
  format?: (v: number) => string;
};

const MODEM_KNOBS: KnobSpec[] = [
  {
    key: "binRatio",
    label: "Bin ratio (acquisition)",
    help:
      "Minimum ratio between winning and losing Goertzel bins to accept a " +
      "detection. Lower = more sensitive but more false triggers from noise.",
    min: 1.05,
    max: 3,
    step: 0.05,
  },
  {
    key: "strongBinRatio",
    label: "Strong-tone bypass",
    help:
      "If one bin dominates by at least this ratio, accept even when SNR " +
      "is modest. Lower = pick up quieter clean tones faster.",
    min: 1.5,
    max: 10,
    step: 0.25,
  },
  {
    key: "snrFactor",
    label: "SNR floor",
    help:
      "Window energy must exceed the tracked noise floor by this factor. " +
      "Lower = more sensitive in noisy rooms.",
    min: 1.1,
    max: 8,
    step: 0.1,
  },
  {
    key: "absEnergyScale",
    label: "Absolute energy floor",
    help:
      "Dead-silence cutoff (per-sample energy). Below this, no signal is " +
      "considered present even in a totally quiet room.",
    min: 1e-8,
    max: 1e-3,
    step: 1e-8,
    format: (v) => v.toExponential(1),
  },
  {
    key: "preambleMs",
    label: "TX preamble (ms)",
    help:
      "Length of mark tone sent before data, so the receiver's noise-floor " +
      "estimate can settle and a slightly late RX still catches byte one.",
    min: 0,
    max: 1500,
    step: 25,
    format: (v) => `${Math.round(v)}`,
  },
];

const MODEM_STORAGE = "kl43.modem.v1";

function loadModemConfig(): void {
  try {
    const raw = localStorage.getItem(MODEM_STORAGE);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ModemConfig>;
    for (const k of Object.keys(MODEM_DEFAULTS) as (keyof ModemConfig)[]) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isFinite(v)) modemConfig[k] = v;
    }
  } catch { /* ignore corrupt storage */ }
}

function saveModemConfig(): void {
  try { localStorage.setItem(MODEM_STORAGE, JSON.stringify(modemConfig)); }
  catch { /* ignore quota */ }
}

function setupModemPicker(): void {
  const dlg = document.getElementById("modem-dialog");
  const form = document.getElementById("modem-form");
  const btnClose = document.getElementById("modem-close") as HTMLButtonElement | null;
  const btnReset = document.getElementById("modem-reset") as HTMLButtonElement | null;
  const openBtn = document.getElementById("menu-modem");
  if (!dlg || !form || !btnClose || !btnReset || !openBtn) return;

  const rows = new Map<keyof ModemConfig, { input: HTMLInputElement; value: HTMLSpanElement; fmt: (v: number) => string }>();

  form.innerHTML = "";
  for (const spec of MODEM_KNOBS) {
    const row = document.createElement("div");
    row.className = "knob";
    const id = `modem-knob-${spec.key}`;
    const label = document.createElement("label");
    label.className = "knob-label";
    label.htmlFor = id;
    label.textContent = spec.label;
    const value = document.createElement("span");
    value.className = "knob-value";
    const input = document.createElement("input");
    input.type = "range";
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    const help = document.createElement("div");
    help.className = "knob-help";
    help.textContent = spec.help;
    row.appendChild(label);
    row.appendChild(value);
    row.appendChild(input);
    row.appendChild(help);
    form.appendChild(row);

    const fmt = spec.format ?? ((v: number) => v.toFixed(2));
    rows.set(spec.key, { input, value, fmt });
  }

  const refresh = () => {
    for (const spec of MODEM_KNOBS) {
      const row = rows.get(spec.key);
      if (!row) continue;
      const v = modemConfig[spec.key];
      row.input.value = String(v);
      row.value.textContent = row.fmt(v);
    }
  };

  form.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    const spec = MODEM_KNOBS.find((s) => input.id === `modem-knob-${s.key}`);
    if (!spec) return;
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    modemConfig[spec.key] = v;
    const row = rows.get(spec.key);
    if (row) row.value.textContent = row.fmt(v);
    saveModemConfig();
  });

  btnReset.addEventListener("click", () => {
    Object.assign(modemConfig, MODEM_DEFAULTS);
    saveModemConfig();
    refresh();
  });

  const close = () => dlg.classList.remove("show");
  btnClose.addEventListener("click", close);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dlg.classList.contains("show")) { close(); e.preventDefault(); }
  });
  openBtn.addEventListener("click", () => { refresh(); dlg.classList.add("show"); });
}

export function buildTopbar(
  dispatch: Dispatcher,
  flashKey: FlashKey,
  currentCipherId: BackendId,
): void {
  loadModemConfig();
  setupKeyGen(dispatch, flashKey, currentCipherId);
  setupCipherPicker(currentCipherId);
  setupModemPicker();
}
