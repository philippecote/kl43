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

function setupKeyGen(dispatch: Dispatcher, flashKey: FlashKey): void {
  const dlg = document.getElementById("keygen-dialog");
  const keyText = document.getElementById("keygen-key");
  const statusEl = document.getElementById("keygen-status");
  const btnRegen = document.getElementById("keygen-regen") as HTMLButtonElement | null;
  const btnCopy = document.getElementById("keygen-copy") as HTMLButtonElement | null;
  const btnType = document.getElementById("keygen-type") as HTMLButtonElement | null;
  const btnClose = document.getElementById("keygen-close") as HTMLButtonElement | null;
  const openBtn = document.getElementById("menu-keygen");
  if (!dlg || !keyText || !statusEl || !btnRegen || !btnCopy || !btnType || !btnClose || !openBtn) return;

  let current = "";
  const setStatus = (msg: string) => { statusEl.textContent = msg; };

  const regenerate = () => {
    current = generateKeyLetters();
    keyText.textContent = groupKey(current);
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

  const close = () => dlg.classList.remove("show");
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

export function buildTopbar(
  dispatch: Dispatcher,
  flashKey: FlashKey,
  currentCipherId: BackendId,
): void {
  setupKeyGen(dispatch, flashKey);
  setupCipherPicker(currentCipherId);
}
