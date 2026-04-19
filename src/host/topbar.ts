// App-level top bar — sits above the device photo and hosts utilities that
// are not part of the emulated hardware. Kept visually distinct from the
// device so there's no confusion about what's "real" vs. dev affordance.
//
// Key Generator opens a modal with a freshly-generated 32-letter key (30
// random body letters + 2-letter checksum). From the modal the user can
// copy the key to clipboard, inject it straight into the device as if
// typed (for when they're already sitting at a K_ENTER_SET prompt), or
// regenerate.

import { decodeKey, appendChecksum } from "../crypto/KeyCodec.js";
import type { KeyEvent } from "../machine/Machine.js";

type Dispatcher = (ev: KeyEvent) => void;
type FlashKey = (id: string) => void;

function generateKeyLetters(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  const body30 = decodeKey(raw).slice(0, 30);
  return appendChecksum(body30);
}

function groupKey(letters: string): string {
  return letters.match(/.{1,8}/g)?.join(" ") ?? letters;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function setupDialog(dispatch: Dispatcher, flashKey: FlashKey): void {
  const dlg = document.getElementById("keygen-dialog") as HTMLElement | null;
  const keyText = document.getElementById("keygen-key") as HTMLElement | null;
  const statusEl = document.getElementById("keygen-status") as HTMLElement | null;
  const btnRegen = document.getElementById("keygen-regen") as HTMLButtonElement | null;
  const btnCopy = document.getElementById("keygen-copy") as HTMLButtonElement | null;
  const btnType = document.getElementById("keygen-type") as HTMLButtonElement | null;
  const btnClose = document.getElementById("keygen-close") as HTMLButtonElement | null;
  if (!dlg || !keyText || !statusEl || !btnRegen || !btnCopy || !btnType || !btnClose) return;

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
    setStatus(ok ? "Copied to clipboard." : "Clipboard unavailable — select the text above and copy manually.");
  });

  btnType.addEventListener("click", () => {
    for (const ch of current) {
      dispatch({ kind: "char", ch });
      flashKey(ch);
    }
    setStatus(`Typed ${current.length} letters into device.`);
  });

  const close = () => { dlg.classList.remove("show"); };
  btnClose.addEventListener("click", close);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dlg.classList.contains("show")) { close(); e.preventDefault(); }
  });

  const openBtn = document.getElementById("menu-keygen");
  openBtn?.addEventListener("click", () => {
    regenerate();
    dlg.classList.add("show");
  });
}

export function buildTopbar(dispatch: Dispatcher, flashKey: FlashKey): void {
  setupDialog(dispatch, flashKey);
}
