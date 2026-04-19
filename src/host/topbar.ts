// App-level top bar — sits above the device photo and hosts utilities that
// are not part of the emulated hardware. Kept visually distinct from the
// device so there's no confusion about what's "real" vs. dev affordance.
//
// Key Generator: produces a valid 32-letter key (30 body + 2 checksum),
// displayed in a dismissable modal with copy / type-into-device / regenerate.
// The modem lives on the device's C-menu (Communications) flow — no
// app-level UI for it; see main.ts for the wiring.

import { decodeKey, appendChecksum } from "../crypto/KeyCodec.js";
import type { KeyEvent } from "../machine/Machine.js";

type Dispatcher = (ev: KeyEvent) => void;
type FlashKey = (id: string) => void;

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

export function buildTopbar(dispatch: Dispatcher, flashKey: FlashKey): void {
  setupKeyGen(dispatch, flashKey);
}
