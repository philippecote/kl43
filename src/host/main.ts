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
import { playKeyClick, playConfirm, playError, playPowerOff, unlockAudio } from "./audio.js";
import { buildTopbar } from "./topbar.js";

const TICK_INTERVAL_MS = 100;

const device = document.getElementById("device") as HTMLElement;
const lcdCanvas = document.getElementById("lcd-canvas") as HTMLCanvasElement;
const keypadEl = document.getElementById("keypad") as HTMLElement;

console.log("[kl43] host booting");
const deps = defaultDeps();
console.log("[kl43] deps ok");
const machine = new Machine(deps);
console.log("[kl43] machine ok");

function render(): void {
  const screen = renderScreen(
    machine.state,
    deps.keyStore,
    deps.silent,
    deps.buffers,
    deps.clock,
  );
  paintLcd(lcdCanvas, screen);
  device.classList.toggle("off", machine.state.kind === "OFF");
}

function handleEffects(effects: readonly Effect[]): void {
  for (const e of effects) {
    switch (e.kind) {
      case "encrypted":
      case "decrypted":
      case "keyLoaded":
      case "keyUpdated":
      case "authChallengeSent":
      case "authReplyComputed":
      case "zeroizedAll":
      case "zeroizedSlot":
        playConfirm(deps.silent);
        break;
      case "decryptFailed":
        playError();
        break;
      case "powerOff":
        playPowerOff();
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
buildTopbar(dispatch, flashKey);

// Resume AudioContext on the first user gesture (browser autoplay policy).
window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });

// Physical keyboard: map browser keys to the emulator's event stream. Letters
// and digits go as char events; Enter/Escape/Backspace/arrows map to named
// keys. Unknown keys are ignored.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
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
