// Mock "printed" scroll — atmospheric-only rendering of the TP-40S thermal
// printer output. MANUAL pp.45–46 describes the real printing path; the
// emulator does not drive a printer but surfaces the same text on a faux
// thermal-paper scroll so the operator gets the same "I just printed this"
// feedback loop. SPEC_DELTA §1.1 "Print function" + FAITHFULNESS §5.
//
// The scroll is a single DOM overlay, lazily created on first print. It is
// dismissed by click, Escape, or the close button. The scroll is cosmetic —
// no printing, no download, no persistence.

import type { SlotId } from "../editor/DualBuffer.js";

type Printout = {
  slot: SlotId;
  text: string;
  printedAt: Date;
};

let overlay: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  const el = document.createElement("div");
  el.className = "printed-scroll-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Printer output");
  el.hidden = true;
  el.innerHTML = `
    <div class="printed-scroll" role="document">
      <button type="button" class="printed-close" aria-label="Close printout">×</button>
      <div class="printed-paper">
        <header class="printed-header"></header>
        <pre class="printed-body"></pre>
        <footer class="printed-footer">— END OF PRINTOUT —</footer>
      </div>
    </div>
  `;
  const close = (): void => { el.hidden = true; };
  el.addEventListener("click", (ev) => {
    if (ev.target === el) close();
  });
  el.querySelector(".printed-close")!.addEventListener("click", close);
  document.addEventListener("keydown", (ev) => {
    if (!el.hidden && ev.key === "Escape") close();
  });
  document.body.appendChild(el);
  overlay = el;
  return el;
}

function formatHeader(p: Printout): string {
  const d = p.printedAt;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  return `TP-40S  KL-43C  MESSAGE ${p.slot}  ${stamp}`;
}

export function showPrintedScroll(slot: SlotId, text: string): void {
  const p: Printout = { slot, text, printedAt: new Date() };
  const el = ensureOverlay();
  (el.querySelector(".printed-header") as HTMLElement).textContent = formatHeader(p);
  (el.querySelector(".printed-body") as HTMLElement).textContent =
    text.length > 0 ? text : "(empty)";
  el.hidden = false;
  (el.querySelector(".printed-close") as HTMLButtonElement).focus();
}
