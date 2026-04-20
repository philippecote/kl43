// Entry point — boots a single `Machine` with production `defaultDeps()`,
// paints the LCD, wires the keypad, binds the physical keyboard, and runs a
// tick pump so busy-states (BANNER, CRYPT, etc.) complete on their own.
//
// The Machine never polls; we push `{ kind: "tick", elapsedMs }` on a fixed
// cadence. 100 ms is fine-grained enough to honour the smallest timer
// (CRYPT_BUSY_MS = 500) without burning CPU.

import { Machine, defaultDeps, type KeyEvent, type Effect } from "../machine/Machine.js";
import { renderScreen } from "../machine/Screen.js";
import { paintLcd } from "./lcd.js";
import { buildKeypad, enableCalibration, keyEventFor } from "./keypad.js";
import { playKeyClick, playConfirm, playError, playPowerOff, playPowerOn, playZeroize, unlockAudio } from "./audio.js";
import { buildTopbar } from "./topbar.js";
import { showPrintedScroll } from "./printer.js";
import { installCopyHandler, showToast } from "./clipboard.js";
import { handleShareOnBoot } from "./shareLink.js";
import {
  transmitText,
  startReceiver,
  BELL103_ORIGINATE,
  type ReceiverHandle,
  type TransmitHandle,
} from "./modem.js";
import type { BackendId } from "../crypto/CryptoBackend.js";
import {
  createBackend,
  DEFAULT_BACKEND_ID,
} from "../crypto/backends/registry.js";

const CIPHER_STORAGE = "kl43.cipher.v1";
function loadCipherId(): BackendId {
  const stored = localStorage.getItem(CIPHER_STORAGE);
  if (stored === "lfsr-nlc" || stored === "aes-ctr" || stored === "des-cbc") return stored;
  return DEFAULT_BACKEND_ID;
}

const VIEW_ANGLE_STORAGE = "kl43.viewAngle.v1";
const SILENT_STORAGE = "kl43.silent.v1";
function loadViewAngle(): number {
  const raw = localStorage.getItem(VIEW_ANGLE_STORAGE);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 7 ? Math.floor(n) : 4;
}
function loadSilent(): boolean {
  return localStorage.getItem(SILENT_STORAGE) === "1";
}

const TICK_INTERVAL_MS = 100;

const device = document.getElementById("device") as HTMLElement;
const lcdCanvas = document.getElementById("lcd-canvas") as HTMLCanvasElement;
const keypadEl = document.getElementById("keypad") as HTMLElement;

console.log("[kl43] host booting");
const cipherId = loadCipherId();
console.log("[kl43] cipher:", cipherId);
const deps = defaultDeps({
  backend: createBackend(cipherId),
  viewAngle: loadViewAngle(),
  silent: loadSilent(),
});
console.log("[kl43] deps ok");
const machine = new Machine(deps);
console.log("[kl43] machine ok");

// Key persistence (dev-mode — plain JSON in localStorage, not spec §9.4
// encrypted-at-rest). Rehydrate on boot, rewrite after any effect that
// mutates the keystore.
const KEY_STORAGE = "kl43.keyStore.v1";
try {
  const raw = localStorage.getItem(KEY_STORAGE);
  if (raw) deps.keyStore.loadSnapshot(JSON.parse(raw));
} catch (err) {
  console.warn("[kl43] rehydrate keyStore failed:", err);
}
function persistKeys(): void {
  try {
    localStorage.setItem(KEY_STORAGE, JSON.stringify(deps.keyStore.snapshot()));
  } catch (err) {
    console.warn("[kl43] persist keyStore failed:", err);
  }
}

// Modem receiver — live only while the device is in C_RX_WAIT (AUDIO). We
// accumulate demodulated bytes, then close the message on ~1.5s of silence
// (carrier loss) by calling machine.feedReceived().
let receiver: ReceiverHandle | null = null;
let rxBuffer = "";
let rxSilenceTimer: ReturnType<typeof setTimeout> | null = null;
const RX_SILENCE_MS = 1500;
let prevStateKind: string = "OFF";

// The live modem transmission, if any. We hold a handle so pressing XIT (or
// any transition out of a TX-playing state) can abort the tone mid-stream
// — without this, the AudioBufferSourceNode plays to completion regardless.
let currentTx: TransmitHandle | null = null;
function stopCurrentTx(): void {
  if (currentTx) { currentTx.stop(); currentTx = null; }
}
// States where the operator still wants to hear the modem finish. Leaving
// any of these kills the audio — matches the physical device, where
// pressing XIT during TX drops the acoustic coupler.
const TX_AUDIBLE_STATES: ReadonlySet<string> = new Set([
  "C_TX_BUSY",
  "C_TX_COMPLETE",
]);

function stopReceiver(): void {
  if (receiver) { receiver.stop(); receiver = null; }
  if (rxSilenceTimer) { clearTimeout(rxSilenceTimer); rxSilenceTimer = null; }
  rxBuffer = "";
}

async function startListeningForRx(): Promise<void> {
  if (receiver) return;
  console.log("[kl43] RX: requesting mic…");
  try {
    receiver = await startReceiver(BELL103_ORIGINATE);
    console.log("[kl43] RX: listening on originate pair (1270/1070 Hz)");
    receiver.onByte((b) => {
      const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16)}`;
      console.log(`[kl43] RX byte: 0x${b.toString(16).padStart(2, "0")} (${ch})`);
      if (b >= 0x20 && b < 0x7f) rxBuffer += String.fromCharCode(b);
      else if (b === 0x0a || b === 0x0d) rxBuffer += "\n";
      // Flip the LCD from "Waiting for Carrier…" to "Receiving Message" on
      // the very first demodulated byte, instead of only after end-of-
      // carrier. rxCarrierDetected() is idempotent and safe to call per byte.
      machine.rxCarrierDetected();
      render();
      if (rxSilenceTimer) clearTimeout(rxSilenceTimer);
      rxSilenceTimer = setTimeout(() => {
        if (machine.state.kind === "C_RX_WAIT" && rxBuffer.length > 0) {
          const text = rxBuffer;
          console.log(`[kl43] RX: carrier lost, feeding ${text.length} chars: ${JSON.stringify(text)}`);
          stopReceiver();
          machine.feedReceived(text);
          render();
        } else {
          stopReceiver();
        }
      }, RX_SILENCE_MS);
    });
  } catch (err) {
    console.error("[kl43] mic start failed:", err);
  }
}

function render(): void {
  const screen = renderScreen(
    machine.state,
    deps.keyStore,
    deps.silent,
    deps.buffers,
    deps.clock,
  );
  // While the operator is live-adjusting the view angle, preview the chosen
  // level; otherwise use the committed value from deps.
  const angle = machine.state.kind === "V_ADJUST"
    ? machine.state.level
    : deps.viewAngle;
  paintLcd(lcdCanvas, screen, angle);
  device.classList.toggle("off", machine.state.kind === "OFF");

  const nowKind = machine.state.kind;
  const mode = "mode" in machine.state ? (machine.state as { mode?: string }).mode : undefined;
  if (nowKind === "C_RX_WAIT" && mode === "AUDIO" && prevStateKind !== "C_RX_WAIT") {
    void startListeningForRx();
  } else if (prevStateKind === "C_RX_WAIT" && nowKind !== "C_RX_WAIT") {
    stopReceiver();
  }
  // Pressing XIT during TX drops us back to the main menu (or the dir
  // selector) — silence the modem the moment we leave any audible-TX state.
  if (TX_AUDIBLE_STATES.has(prevStateKind) && !TX_AUDIBLE_STATES.has(nowKind)) {
    stopCurrentTx();
  }
  // Power-on chirp: fires when the user confirms boot (BOOT_CONFIRM → BANNER).
  if (nowKind === "BANNER" && prevStateKind === "BOOT_CONFIRM") {
    playPowerOn();
  }
  prevStateKind = nowKind;
}

function handleEffects(effects: readonly Effect[]): void {
  for (const e of effects) {
    switch (e.kind) {
      case "keyLoaded":
      case "keyUpdated":
        persistKeys();
        playConfirm(deps.silent);
        break;
      case "zeroizedAll":
      case "zeroizedSlot":
        persistKeys();
        playZeroize();
        break;
      case "encrypted":
      case "decrypted":
      case "authChallengeSent":
      case "authReplyComputed":
        playConfirm(deps.silent);
        break;
      case "decryptFailed":
        playError();
        break;
      case "powerOff":
        playPowerOff();
        break;
      case "viewAngleChanged":
        try { localStorage.setItem(VIEW_ANGLE_STORAGE, String(e.level)); }
        catch (err) { console.warn("[kl43] persist viewAngle failed:", err); }
        break;
      case "silentModeChanged":
        try { localStorage.setItem(SILENT_STORAGE, e.silent ? "1" : "0"); }
        catch (err) { console.warn("[kl43] persist silent failed:", err); }
        break;
      case "printed": {
        const buf = deps.buffers.get(e.slot);
        showPrintedScroll(e.slot, buf.buffer.toString());
        break;
      }
      case "txTransmitted":
        if (e.mode === "AUDIO") {
          stopCurrentTx(); // any previous TX is already done; just be safe.
          const handle = transmitText(e.wire, BELL103_ORIGINATE);
          currentTx = handle;
          handle.done
            .catch((err) => console.error("[kl43] modem TX failed:", err))
            .finally(() => {
              if (currentTx === handle) currentTx = null;
              // Flip the LCD from "TRANSMITTING MESSAGE" to "TRANSMISSION
              // COMPLETE" the moment the modem actually falls silent, so
              // the two are in sync — no more phantom-complete screen
              // painted over a still-playing carrier.
              machine.txComplete();
              render();
            });
        } else {
          // DIGITAL (RS-232) is not simulated end-to-end; treat the send
          // as instantaneous so the state machine still progresses to
          // TRANSMISSION COMPLETE.
          machine.txComplete();
        }
        break;
    }
  }
}

function dispatch(ev: KeyEvent): void {
  const effects = machine.press(ev);
  playKeyClick(deps.silent);
  handleEffects(effects);
  render();
}

const { flashKey } = buildKeypad(keypadEl, dispatch);
enableCalibration(device, keypadEl);
buildTopbar(dispatch, flashKey, cipherId, deps.keyStore, () => {
  persistKeys();
  render();
});

// Resume AudioContext on the first user gesture (browser autoplay policy).
window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });

installCopyHandler(machine, deps);

// If the URL carries a shared key (?key=…&cipher=…&name=…), prompt on load.
void handleShareOnBoot(deps.keyStore, cipherId).then((toast) => {
  if (toast) {
    persistKeys();
    showToast(toast);
    render();
  }
});

// Physical keyboard: map browser keys to the emulator's event stream. Letters
// and digits go as char events; Enter/Escape/Backspace/arrows map to named
// keys. Unknown keys are ignored.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // If focus is inside an <input>, <textarea>, <select>, or contenteditable
  // element, let the browser handle the keystroke — otherwise app-level
  // dialogs (key-name input, share URL field, etc.) can't be typed in
  // because the device swallows every letter.
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
      return;
    }
  }
  const k = e.key;
  let ev: KeyEvent | null = null;
  let flashId: string | null = null;

  if (k === "Enter") {
    ev = { kind: "key", key: "ENTER" };
    flashId = "ENTER";
  } else if (k === "Escape") {
    ev = { kind: "key", key: "XIT" };
    flashId = "XIT";
  } else if (k === "Backspace") {
    ev = { kind: "key", key: "DCH" };
    flashId = "DCH";
  } else if (k === "Delete") {
    ev = { kind: "key", key: "DWD" };
    flashId = "DWD";
  } else if (k === "ArrowUp") {
    ev = { kind: "key", key: "UP" };
    flashId = "UP";
  } else if (k === "ArrowDown") {
    ev = { kind: "key", key: "DOWN" };
    flashId = "DOWN";
  } else if (k === "ArrowLeft") {
    ev = { kind: "key", key: "LEFT" };
    flashId = "LEFT";
  } else if (k === "ArrowRight") {
    ev = { kind: "key", key: "RIGHT" };
    flashId = "RIGHT";
  } else if (k === "Home") {
    ev = { kind: "key", key: "BOL" };
    flashId = "BOL";
  } else if (k === "End") {
    ev = { kind: "key", key: "EOL" };
    flashId = "EOL";
  } else if (k === "PageUp") {
    ev = { kind: "key", key: "BOT" };
    flashId = "BOT";
  } else if (k === "PageDown") {
    ev = { kind: "key", key: "EOT" };
    flashId = "EOT";
  } else if (k === " ") {
    ev = { kind: "char", ch: " " };
    flashId = "SPC";
  } else if (k.length === 1) {
    const upper = k.toUpperCase();
    ev = keyEventFor(upper, upper);
    if (ev) {
      if (/^[A-Z]$/.test(upper)) flashId = upper;
      else if (/^[0-9]$/.test(upper)) flashId = `D${upper}`;
    }
  }

  if (!ev) return;
  e.preventDefault();
  if (flashId) flashKey(flashId);
  dispatch(ev);
});

// Clipboard paste: fan out the pasted text as individual char events so it
// flows through the same input path as typing. Uppercase for messages;
// cipher-key state machine will filter invalid chars itself.
document.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  e.preventDefault();
  for (const raw of text) {
    const ch = raw.toUpperCase();
    if (ch === "\n" || ch === "\r") {
      dispatch({ kind: "key", key: "ENTER" });
    } else if (ch === " ") {
      dispatch({ kind: "char", ch: " " });
    } else if (ch.length === 1 && ch >= " " && ch <= "~") {
      dispatch({ kind: "char", ch });
    }
  }
});

// Tick pump. Using setInterval (not rAF) so ticks keep firing when the tab is
// backgrounded — desirable for busy-states like Encrypting that should finish
// even if the user switches away.
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const elapsed = now - last;
  last = now;
  const effects = machine.press({ kind: "tick", elapsedMs: elapsed });
  handleEffects(effects);
  render();
}, TICK_INTERVAL_MS);

render();
