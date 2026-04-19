// App-level clipboard hook: Ctrl+C / Cmd+C copies the current message
// buffer (plaintext or ciphertext) to the system clipboard when the device
// is in the Word Processor editor or the Review viewer. The emulator has
// always accepted paste; this closes the loop so an operator can shuttle
// cipher groups into email, chat, etc.
//
// We explicitly do NOT hijack copy when:
//  - the user has an active DOM text selection (they are copying something
//    else on the page — footer, dialog text, etc.),
//  - focus is inside an <input>/<textarea>/contenteditable (cipher picker,
//    key-gen dialog, and so on), or
//  - the current machine state has no "current slot" (nothing to copy).

import type { Machine } from "../machine/Machine.js";
import type { MachineDeps } from "../machine/Machine.js";
import type { SlotId } from "../editor/DualBuffer.js";

type CopySource = { slot: SlotId; text: string };

function currentCopySource(machine: Machine, deps: MachineDeps): CopySource | null {
  const s = machine.state;
  if (s.kind !== "WP_EDITOR" && s.kind !== "R_VIEWER") return null;
  const text = deps.buffers.get(s.slot).buffer.toString();
  if (text.length === 0) return null;
  return { slot: s.slot, text };
}

function hasActiveDomSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

let toastEl: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "app-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.remove("show");
  }, 1600);
}

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback: off-screen textarea + execCommand. Works in Safari
    // without the Clipboard API permission.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Install the Ctrl+C / Cmd+C handler. Idempotent-safe only if called once. */
export function installCopyHandler(machine: Machine, deps: MachineDeps): void {
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "c" && ev.key !== "C") return;
      if (!(ev.metaKey || ev.ctrlKey)) return;
      if (ev.altKey || ev.shiftKey) return;
      if (hasActiveDomSelection()) return;
      if (isTypingTarget(ev.target)) return;

      const src = currentCopySource(machine, deps);
      if (!src) return;

      ev.preventDefault();
      void writeToClipboard(src.text).then((ok) => {
        showToast(
          ok
            ? `Copied message ${src.slot} (${src.text.length} chars)`
            : "Copy failed — clipboard access denied",
        );
      });
    },
    true, // capture phase so we run before the emulator's keydown listener
  );
}
