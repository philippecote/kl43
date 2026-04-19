// Pair demo — two KL-43C emulators side-by-side, wired together through a
// single AudioContext. Whichever side transmits:
//
//   Station A: FSK buffer --->+--> ctx.destination  (you hear it)
//                             |
//                             +--> GainNode "bus A"  (station B taps this)
//
//   Station B: FSK buffer --->+--> ctx.destination
//                             |
//                             +--> GainNode "bus B"  (station A taps this)
//
// This is not an acoustic coupler — it's a direct node-to-node graph, so
// the decoder sees a pristine signal. That's deliberate: the mic/speaker
// path is already exercised by the single-unit demo on index.html;
// here the goal is to show the protocol working end-to-end with clean
// audio plus the audible modem song.
//
// Each station keeps its own persistence (kl43.pair.a.* vs kl43.pair.b.*)
// so resetting one doesn't nuke the other.
//
// Keyboard input is routed to whichever station is "focused". Click a
// device to focus it; clicking elsewhere retains focus on the last one.

import { Machine, defaultDeps, type KeyEvent, type Effect } from "../machine/Machine.js";
import { renderScreen } from "../machine/Screen.js";
import { paintLcd } from "./lcd.js";
import { buildKeypad, keyEventFor } from "./keypad.js";
import {
  playKeyClick, playConfirm, playError, playPowerOff, playPowerOn,
  playZeroize, unlockAudio, getAudioContext,
} from "./audio.js";
import { showPrintedScroll } from "./printer.js";
import { showToast } from "./clipboard.js";
import {
  transmitTextTo,
  startReceiverFromNode,
  BELL103_ORIGINATE,
  BELL103_ANSWER,
  type FreqPair,
  type ReceiverHandle,
} from "./modem.js";
import type { BackendId } from "../crypto/CryptoBackend.js";
import { createBackend, DEFAULT_BACKEND_ID } from "../crypto/backends/registry.js";
import { decodeKey, appendChecksum } from "../crypto/KeyCodec.js";

type StationId = "a" | "b";
const TICK_INTERVAL_MS = 100;
const RX_SILENCE_MS = 1500;

const CIPHER_STORAGE = "kl43.cipher.v1";
function loadCipherId(): BackendId {
  const stored = localStorage.getItem(CIPHER_STORAGE);
  if (stored === "lfsr-nlc" || stored === "aes-ctr" || stored === "des-cbc") return stored;
  return DEFAULT_BACKEND_ID;
}

function keyStorageFor(id: StationId): string {
  return `kl43.pair.${id}.keyStore.v1`;
}

type Station = {
  id: StationId;
  txPair: FreqPair;
  rxPair: FreqPair;
  txBus: GainNode;
  rxInput: AudioNode;
  machine: Machine;
  deps: ReturnType<typeof defaultDeps>;
  lcd: HTMLCanvasElement;
  device: HTMLElement;
  flashKey: (id: string) => void;
  render: () => void;
  receiver: ReceiverHandle | null;
  rxBuffer: string;
  rxSilenceTimer: ReturnType<typeof setTimeout> | null;
  prevStateKind: string;
};

let focusedStation: StationId = "a";
const stations: Record<StationId, Station> = {} as Record<StationId, Station>;

// ---------------------------------------------------------------------------
// Audio graph. We build two GainNodes up front; each transmit connects its
// BufferSource to (ctx.destination, myBus). The far side's receiver is
// started on demand from the opposing bus.

function setupAudioGraph(): { busA: GainNode; busB: GainNode; masterGain: GainNode } {
  const ctx = getAudioContext();
  if (!ctx) throw new Error("No AudioContext");
  // masterGain lets us mute the audible path without killing the loopback.
  const masterGain = ctx.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(ctx.destination);
  const busA = ctx.createGain();
  busA.gain.value = 1;
  const busB = ctx.createGain();
  busB.gain.value = 1;
  return { busA, busB, masterGain };
}

// ---------------------------------------------------------------------------
// Per-station wiring.

function buildStation(
  id: StationId,
  txPair: FreqPair,
  rxPair: FreqPair,
  txBus: GainNode,
  rxInput: AudioNode,
  cipherId: BackendId,
): Station {
  const device = document.getElementById(`device-${id}`) as HTMLElement;
  const lcd = document.getElementById(`lcd-canvas-${id}`) as HTMLCanvasElement;
  const keypadEl = document.getElementById(`keypad-${id}`) as HTMLElement;

  const deps = defaultDeps({
    backend: createBackend(cipherId),
    viewAngle: 4,
    silent: false,
  });
  const machine = new Machine(deps);

  // Rehydrate this station's own compartment snapshot.
  try {
    const raw = localStorage.getItem(keyStorageFor(id));
    if (raw) deps.keyStore.loadSnapshot(JSON.parse(raw));
  } catch (err) {
    console.warn(`[kl43/pair/${id}] rehydrate failed:`, err);
  }
  const persistKeys = () => {
    try {
      localStorage.setItem(keyStorageFor(id), JSON.stringify(deps.keyStore.snapshot()));
    } catch (err) { console.warn(`[kl43/pair/${id}] persist failed:`, err); }
  };

  const s: Station = {
    id,
    txPair,
    rxPair,
    txBus,
    rxInput,
    machine,
    deps,
    lcd,
    device,
    flashKey: () => {},
    render: () => {},
    receiver: null,
    rxBuffer: "",
    rxSilenceTimer: null,
    prevStateKind: "OFF",
  };

  const render = () => {
    const screen = renderScreen(machine.state, deps.keyStore, deps.silent, deps.buffers, deps.clock);
    const angle = machine.state.kind === "V_ADJUST" ? machine.state.level : deps.viewAngle;
    paintLcd(lcd, screen, angle);
    device.classList.toggle("off", machine.state.kind === "OFF");

    const nowKind = machine.state.kind;
    const mode = "mode" in machine.state ? (machine.state as { mode?: string }).mode : undefined;
    if (nowKind === "C_RX_WAIT" && mode === "AUDIO" && s.prevStateKind !== "C_RX_WAIT") {
      startListening(s);
    } else if (s.prevStateKind === "C_RX_WAIT" && nowKind !== "C_RX_WAIT") {
      stopListening(s);
    }
    if (nowKind === "BANNER" && s.prevStateKind === "BOOT_CONFIRM") {
      playPowerOn();
    }
    s.prevStateKind = nowKind;
  };
  s.render = render;

  const handleEffects = (effects: readonly Effect[]) => {
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
        case "printed": {
          const buf = deps.buffers.get(e.slot);
          showPrintedScroll(e.slot, buf.buffer.toString());
          break;
        }
        case "txTransmitted":
          if (e.mode === "AUDIO") {
            transmitTextTo(e.wire, s.txPair, s.txBus).catch((err) => {
              console.error(`[kl43/pair/${id}] modem TX failed:`, err);
            });
          }
          break;
      }
    }
  };

  const dispatch = (ev: KeyEvent) => {
    const effects = machine.press(ev);
    playKeyClick(deps.silent);
    handleEffects(effects);
    render();
  };

  const { flashKey } = buildKeypad(keypadEl, dispatch);
  s.flashKey = flashKey;

  // Tick pump — one per station so busy states complete independently.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const elapsed = now - last;
    last = now;
    const effects = machine.press({ kind: "tick", elapsedMs: elapsed });
    handleEffects(effects);
    render();
  }, TICK_INTERVAL_MS);

  device.addEventListener("pointerdown", () => setFocusedStation(id), true);

  // Expose a per-station dispatch for the preload helper below.
  (s as unknown as { dispatch: (ev: KeyEvent) => void }).dispatch = dispatch;

  render();
  return s;
}

function setFocusedStation(id: StationId): void {
  if (focusedStation === id) return;
  focusedStation = id;
  for (const other of ["a", "b"] as const) {
    const el = document.getElementById(`device-${other}`);
    el?.classList.toggle("pair-focused", other === id);
  }
}

// ---------------------------------------------------------------------------
// Per-station receiver management (mirrors main.ts but using the loopback bus).

function startListening(s: Station): void {
  if (s.receiver) return;
  try {
    const rx = startReceiverFromNode(s.rxInput, s.rxPair);
    s.receiver = rx;
    rx.onByte((b) => {
      if (b >= 0x20 && b < 0x7f) s.rxBuffer += String.fromCharCode(b);
      else if (b === 0x0a || b === 0x0d) s.rxBuffer += "\n";
      s.machine.rxCarrierDetected();
      s.render();
      if (s.rxSilenceTimer) clearTimeout(s.rxSilenceTimer);
      s.rxSilenceTimer = setTimeout(() => {
        if (s.machine.state.kind === "C_RX_WAIT" && s.rxBuffer.length > 0) {
          const text = s.rxBuffer;
          stopListening(s);
          s.machine.feedReceived(text);
          s.render();
        } else {
          stopListening(s);
        }
      }, RX_SILENCE_MS);
    });
  } catch (err) {
    console.error(`[kl43/pair/${s.id}] rx start failed:`, err);
  }
}

function stopListening(s: Station): void {
  if (s.receiver) { s.receiver.stop(); s.receiver = null; }
  if (s.rxSilenceTimer) { clearTimeout(s.rxSilenceTimer); s.rxSilenceTimer = null; }
  s.rxBuffer = "";
}

// ---------------------------------------------------------------------------
// Convenience affordances — demo mode is meant to be quick to try out.

function generateKeyLetters(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  const body30 = decodeKey(raw).slice(0, 30);
  return appendChecksum(body30);
}

function preloadMatchingKey(): void {
  const key = generateKeyLetters();
  const name = "DEMO01";
  for (const id of ["a", "b"] as const) {
    const s = stations[id];
    s.deps.keyStore.load(1, name, key);
    s.deps.keyStore.select(1);
    try {
      localStorage.setItem(keyStorageFor(id), JSON.stringify(s.deps.keyStore.snapshot()));
    } catch { /* ignore */ }
  }
  // Power both on via a synthetic SRCH_ON → ENTER sequence. We do this
  // regardless of current state — if already past BOOT_CONFIRM the events
  // are no-ops in most states, but we filter to OFF/BOOT_CONFIRM to be safe.
  for (const id of ["a", "b"] as const) {
    const s = stations[id];
    const dispatch = (s as unknown as { dispatch: (ev: KeyEvent) => void }).dispatch;
    if (s.machine.state.kind === "OFF") dispatch({ kind: "key", key: "SRCH_ON" });
    if (s.machine.state.kind === "BOOT_CONFIRM") dispatch({ kind: "key", key: "ENTER" });
    s.render();
  }
  showToast(`Loaded matching key DEMO01 into both units (${key.slice(0, 4)}…)`);
}

function resetBoth(): void {
  for (const id of ["a", "b"] as const) {
    localStorage.removeItem(keyStorageFor(id));
  }
  // Reload so machines come up fresh; simpler than driving ZRO through both
  // state machines and handling every possible current screen.
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Boot.

console.log("[kl43/pair] booting");
const cipherId = loadCipherId();
const { busA, busB, masterGain } = setupAudioGraph();
// masterGain drives the audible path; bus A/B feed the other station's RX
// and also the masterGain so users actually hear the modem tones.
busA.connect(masterGain);
busB.connect(masterGain);

window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });

stations.a = buildStation("a", BELL103_ORIGINATE, BELL103_ANSWER, busA, busB, cipherId);
stations.b = buildStation("b", BELL103_ANSWER, BELL103_ORIGINATE, busB, busA, cipherId);
setFocusedStation("a");

// Keyboard routing — whichever station is focused gets it, matching
// main.ts's handler. We share the table across both paths for consistency.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  const s = stations[focusedStation];
  const dispatch = (s as unknown as { dispatch: (ev: KeyEvent) => void }).dispatch;
  const k = e.key;
  let ev: KeyEvent | null = null;
  let flashId: string | null = null;
  const table: Array<[string, KeyEvent, string]> = [
    ["Enter",      { kind: "key", key: "ENTER"   }, "ENTER"],
    ["Escape",     { kind: "key", key: "XIT"     }, "XIT"],
    ["Backspace",  { kind: "key", key: "DCH"     }, "DCH"],
    ["Delete",     { kind: "key", key: "DWD"     }, "DWD"],
    ["ArrowUp",    { kind: "key", key: "UP"      }, "UP"],
    ["ArrowDown",  { kind: "key", key: "DOWN"    }, "DOWN"],
    ["ArrowLeft",  { kind: "key", key: "LEFT"    }, "LEFT"],
    ["ArrowRight", { kind: "key", key: "RIGHT"   }, "RIGHT"],
    ["Home",       { kind: "key", key: "BOL"     }, "BOL"],
    ["End",        { kind: "key", key: "EOL"     }, "EOL"],
    ["PageUp",     { kind: "key", key: "BOT"     }, "BOT"],
    ["PageDown",   { kind: "key", key: "EOT"     }, "EOT"],
  ];
  for (const [name, kev, fid] of table) {
    if (k === name) { ev = kev; flashId = fid; break; }
  }
  if (!ev) {
    if (k === " ") { ev = { kind: "char", ch: " " }; flashId = "SPC"; }
    else if (k.length === 1) {
      const upper = k.toUpperCase();
      ev = keyEventFor(upper, upper);
      if (ev) {
        if (/^[A-Z]$/.test(upper)) flashId = upper;
        else if (/^[0-9]$/.test(upper)) flashId = `D${upper}`;
      }
    }
  }
  if (!ev) return;
  e.preventDefault();
  if (flashId) s.flashKey(flashId);
  dispatch(ev);
});

// Wire the preload / reset / mute controls.
const preloadBtn = document.getElementById("pair-preload") as HTMLButtonElement | null;
const resetBtn = document.getElementById("pair-reset") as HTMLButtonElement | null;
const muteEl = document.getElementById("pair-mute") as HTMLInputElement | null;
preloadBtn?.addEventListener("click", preloadMatchingKey);
resetBtn?.addEventListener("click", resetBoth);
muteEl?.addEventListener("change", () => {
  masterGain.gain.value = muteEl.checked ? 0 : 1;
});

console.log("[kl43/pair] ready");
