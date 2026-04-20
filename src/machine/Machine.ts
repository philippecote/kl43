// Top-level state machine for the KL-43C emulator. Inputs are `KeyEvent`s
// (named keys + printable characters + a periodic clock tick). Output is the
// current LCD screen (one or two 40-column lines) and an optional list of
// side effects for the host to carry out.
//
// Scope: this module owns the device-wide navigation — boot sequence, Key
// Select Menu, Main Menu dispatch, power-off confirmation, quiet-mode
// toggle, and the ZRO key paths. Leaf operations that belong to other
// modules (WordProcessor editing, key loading, encrypt/decrypt, comms) are
// modelled as single "busy" states here: enter on menu dispatch, exit on
// XIT, and carry a brief `title` from STRINGS so the harness can render
// them. They will be fleshed out as their own sub-machines later.
//
// Faithfulness anchors (all from the Operator's Manual):
//   - §4.2 boot sequence, 15-second power-on confirm window (MANUAL p.5).
//   - §4.4 main menu: 13 items, W/Q/S/K/U/E/D/A/P/C/R/V/O (MANUAL p.9).
//   - §4.6 Quiet/Silent Mode persists across power cycles (MANUAL p.40).
//   - §5.3.3 ZRO at boot → "all-keys" confirm path (MANUAL p.43).
//   - §5.3.3 ZRO at runtime → per-slot or "A"-for-all confirm path.
//   - §5.3.3 MALFUNCTION → auto-zeroize all keys (MANUAL p.54).

import { MAIN_MENU_ITEMS } from "../ui/STRINGS.js";
import { KeyCompartmentStore } from "../state/KeyCompartment.js";
import {
  DualBuffer,
  InvalidClassificationError,
  MAX_CLASSIFICATION_LENGTH,
  TransmitDeniedError,
  type SlotId,
} from "../editor/DualBuffer.js";
import { MAX_BUFFER_CHARS, MAX_PLAINTEXT_CHARS } from "../editor/TextBuffer.js";
import { Clock, SystemClock } from "../state/Clock.js";
import { CryptoBackend } from "../crypto/CryptoBackend.js";
import { LfsrNlcBackend } from "../crypto/backends/LfsrNlcBackend.js";
import { randomBytes } from "../crypto/primitives.js";
import {
  encryptMessage,
  decryptMessage,
  UncorrectableError,
  formatForDisplay,
  parseDisplayForm,
} from "../wire/EncryptedMessage.js";
import {
  CHALLENGE_LENGTH,
  computeReply,
  generateChallenge,
} from "../auth/Authentication.js";
import { MAX_UPDATE_LEVEL } from "../crypto/Updater.js";

export type LcdLine = string;
export type LcdScreen = readonly [LcdLine] | readonly [LcdLine, LcdLine];

/** Boot-confirm timeout from MANUAL p.5. */
export const POWER_ON_CONFIRM_TIMEOUT_MS = 15_000;
/** TRW banner dwell. Manual says "briefly"; we pick 2s to match spec §4.2. */
export const BANNER_DWELL_MS = 2_000;
/** How long "Message Space Is Empty / Starting New Message" lingers. */
export const WP_EMPTY_NOTICE_MS = 1_500;
/** How long "Stored As Message {AB}" lingers before returning to Main Menu. */
export const WP_STORED_NOTICE_MS = 1_500;
/** Crypto "Encrypting" / "Decrypting" busy screen dwell. */
export const CRYPT_BUSY_MS = 500;
/** "Key Update Complete" dwell. */
export const UPDATE_COMPLETE_MS = 800;
/** Invalid-key notice dwell, before returning to Main Menu. */
export const KEY_INVALID_MS = 1_000;
/** Print busy screen dwell. */
export const PRINT_BUSY_MS = 1_000;
/** Receive "busy" dwell once carrier is detected. */
export const RX_BUSY_MS = 1_000;
/** "Please Wait" dwell between baud select and C_TX_READY (MANUAL p.29). */
export const PLEASE_WAIT_MS = 500;
/** View-angle range [0, VIEW_ANGLE_MAX]. 0 = top view, MAX = bottom view. */
export const VIEW_ANGLE_MAX = 7;

/**
 * Digital Data baud rates selectable by the operator (MANUAL p.27).
 * Only baud rate is selectable; framing is always 1/8/2/none.
 */
export const BAUD_RATES: readonly number[] = [
  50, 75, 150, 300, 600, 1200, 2400, 4800, 9600, 19200,
] as const;
/** Default baud rate index = 1200, a typical field default. */
export const DEFAULT_BAUD_INDEX = 5;

/**
 * Clock edit fields, in the order the operator cycles through them. Widths
 * are digit counts; min/max enforce the device's input validation (we mirror
 * the real device's per-field range check rather than letting `Date.UTC`
 * silently normalize invalid dates).
 */
export const CLOCK_FIELDS = [
  { name: "MONTH", width: 2, min: 1, max: 12 },
  { name: "DATE", width: 2, min: 1, max: 31 },
  { name: "YEAR", width: 4, min: 1900, max: 2099 },
  { name: "HOUR", width: 2, min: 0, max: 23 },
  { name: "MINUTE", width: 2, min: 0, max: 59 },
  { name: "SECOND", width: 2, min: 0, max: 59 },
] as const;

/**
 * Split buffer content into tokens for the R_VIEWER verbal-readout overlay.
 * Each run of non-whitespace becomes one token; for operators this matches
 * the base32 cipher-group layout (`4AB NFC QWP …`, MANUAL p.12) and also
 * works sanely for plaintext (one word per screen).
 */
export function tokenizeForVerbal(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/** Seed CLOCK_EDIT with the current clock's fields so operators only need to
 *  overtype the components they want to change. */
export function clockSeed(utcMs: number): string[] {
  const d = new Date(utcMs);
  return [
    (d.getUTCMonth() + 1).toString().padStart(2, "0"),
    d.getUTCDate().toString().padStart(2, "0"),
    d.getUTCFullYear().toString().padStart(4, "0"),
    d.getUTCHours().toString().padStart(2, "0"),
    d.getUTCMinutes().toString().padStart(2, "0"),
    d.getUTCSeconds().toString().padStart(2, "0"),
  ];
}

export type NamedKey =
  | "SRCH_ON"   // power toggle / search — dual-purpose hardware key
  | "XIT"       // back / cancel
  | "ENTER"
  | "Y"
  | "N"
  | "ZRO"
  | "UP"
  | "DOWN"
  | "LEFT"      // cursor left one char (editor)
  | "RIGHT"     // cursor right one char (editor)
  | "BOT"       // jump to beginning of text (editor)
  | "EOT"       // jump to end of text (editor)
  | "BOL"       // beginning of current line (editor)
  | "EOL"       // end of current line (editor)
  | "DCH"       // delete char to the left (editor)
  | "DWD"       // delete word to the right (editor)
  | "CLK";      // global shortcut: display time and date (MANUAL p.15)

export type KeyEvent =
  | { kind: "key"; key: NamedKey }
  | { kind: "char"; ch: string }
  | { kind: "tick"; elapsedMs: number };

export type MenuLetter = (typeof MAIN_MENU_ITEMS)[number]["key"];

/**
 * State tag. Each variant carries exactly the data that state needs.
 * Keeping this a tagged union (rather than a class-per-state) lets the
 * machine pattern-match on `state.kind` and keeps serialization trivial
 * for future persistence of "device was in menu X" across reloads.
 */
export type State =
  | { kind: "OFF" }
  | { kind: "BOOT_CONFIRM"; remainingMs: number }
  | { kind: "BOOT_ZRO_CONFIRM" }       // ZRO pressed during BOOT_CONFIRM → confirm zeroize-all
  | { kind: "BANNER"; remainingMs: number }
  | { kind: "KEY_SELECT"; topSlot: number; idBuf: string } // idBuf: 0-2 digit buffer for ID# shortcut (MANUAL p.8)
  | { kind: "MAIN_MENU"; topIndex: number } // 2-row window over 13 items
  | { kind: "POWER_OFF_CONFIRM" }
  | { kind: "QUIET_MENU" }
  | { kind: "ZEROIZE_PROMPT" }         // "Which key is to be cleared? Enter ID# or A"
  | { kind: "ZEROIZE_CONFIRM_ONE"; slot: number }
  | { kind: "ZEROIZE_CONFIRM_ALL" }
  | { kind: "ZEROING"; remainingMs: number }
  | { kind: "MALFUNCTION" }             // latches until power cycle
  | { kind: "WP_SELECT_SLOT" }          // A/B selector (MANUAL p.11)
  | { kind: "WP_CLEAR_CONFIRM"; slot: SlotId }
  | { kind: "WP_EMPTY_NOTICE"; slot: SlotId; remainingMs: number }
  | { kind: "WP_MODE_SELECT"; slot: SlotId }
  | { kind: "WP_CLASSIFICATION"; slot: SlotId; text: string }
  | { kind: "WP_EDITOR"; slot: SlotId; mode: "PLAIN" | "CIPHER" }
  | { kind: "WP_SEARCH"; slot: SlotId; mode: "PLAIN" | "CIPHER"; term: string; notFound: boolean }
  | { kind: "WP_STORED"; slot: SlotId; remainingMs: number }
  // Encrypt / Decrypt (MANUAL pp.17-20)
  | { kind: "E_SELECT_SLOT" }
  | { kind: "E_CONFIRM_KEY"; slot: SlotId }
  | { kind: "E_BEGIN_CONFIRM"; slot: SlotId }
  | { kind: "E_BUSY"; slot: SlotId; remainingMs: number }
  | { kind: "D_SELECT_SLOT" }
  | { kind: "D_CONFIRM_KEY"; slot: SlotId }
  | { kind: "D_BEGIN_CONFIRM"; slot: SlotId }
  | { kind: "D_BUSY"; slot: SlotId; remainingMs: number }
  | { kind: "D_FAIL" }  // "MESSAGE DOES NOT DECRYPT PROPERLY" — latch until XIT
  // MANUAL p.53 Appendix B: RS FEC ran out of correction capacity. Line-noise
  // diagnosis, not a cipher-layer failure; surfaced separately so the operator
  // knows the fix is "ask the sender to retransmit" rather than "check the key".
  | { kind: "D_UNCORRECTABLE"; errorsCorrected: number }
  // Update Key (MANUAL p.16-17)
  | { kind: "U_CONFIRM" }
  | { kind: "U_CONFIRM2" }
  | { kind: "U_COMPLETE"; remainingMs: number }
  | { kind: "U_POST" }  // "Press ENTER or XIT"
  | { kind: "U_MAX_REACHED" }  // Attempted update past MAX_UPDATE_LEVEL; latch until any key.
  // Authentication (MANUAL pp.41-42)
  | { kind: "A_CONFIRM_KEY" }
  | { kind: "A_CHALLENGE_OR_REPLY" }
  | { kind: "A_DISPLAY_CHALLENGE"; challenge: string; reply: string }
  | { kind: "A_ENTER_CHALLENGE"; text: string }
  | { kind: "A_DISPLAY_REPLY"; challenge: string; reply: string }
  // Set Time / Date (MANUAL p.44)
  | { kind: "CLOCK_VIEW" }
  | { kind: "CLOCK_EDIT"; fieldIdx: number; buf: string; fields: readonly string[] }
  // Key Change (MANUAL p.7-8)
  | { kind: "K_PROMPT_ID"; buf: string }
  | { kind: "K_PROMPT_NAME"; slotId: number; name: string }
  | { kind: "K_ENTER_SET"; slotId: number; name: string; letters: string; setIdx: 0 | 1 | 2 | 3 }
  | { kind: "K_INVALID"; remainingMs: number }
  | { kind: "K_CONFIRM"; slotId: number }
  // Review Message (MANUAL p.14-15)
  | { kind: "R_SELECT_SLOT" }
  // `phonetic` toggles the verbal-readout overlay used when the operator has
  // to relay a ciphertext message over a voice channel. When true, navigation
  // is by whitespace-separated token (cipher groups in black mode) rather
  // than by row; the token index is kept in `tokenIndex`. MANUAL Appendix C
  // (p.55) + SPEC Appendix A §1.1 "Verbal fallback".
  | { kind: "R_VIEWER"; slot: SlotId; topRow: number; phonetic: boolean; tokenIndex: number }
  // View Angle (MANUAL p.47)
  | { kind: "V_ADJUST"; level: number }
  // Print (MANUAL p.45-46)
  | { kind: "P_SELECT_SLOT" }
  | { kind: "P_WARN_PLAIN"; slot: SlotId }
  | { kind: "P_MENU"; slot: SlotId }
  | { kind: "P_BUSY"; slot: SlotId; remainingMs: number }
  // Communications (MANUAL p.22-40) — minimal navigation machine; a real
  // modem/audio stack is not implemented. TX emits an effect carrying the
  // on-wire display form; RX waits until the host calls `feedReceived()`.
  | { kind: "C_MODE_SELECT" }
  | { kind: "C_DIR_SELECT"; mode: "AUDIO" | "DIGITAL" }
  // Audio sub-selectors (MANUAL p.23). Only reached when mode === "AUDIO";
  // digital skips these. `dir` carries the TX/RX decision forward so the
  // acoustic/connector and U.S./European prompts can route correctly.
  | { kind: "C_AUDIO_SUBMODE"; dir: "TX" | "RX" }
  | { kind: "C_ACOUSTIC_LINES"; dir: "TX" | "RX" }
  // Silent Mode denies acoustic-coupler comms (MANUAL p.39; Appendix B p.53).
  | { kind: "C_AUDIO_DENIED" }
  // MANUAL p.52: locally-entered ciphertext cannot be transmitted; display
  // the Appendix B warning until the operator acknowledges with any key.
  | { kind: "C_LOCAL_CIPHER_DENIED" }
  // MANUAL p.53 Appendix B: the device refuses to transmit plaintext so an
  // operator who forgot to press E cannot put the message on the wire in
  // the clear. Any key acknowledges and returns to Main Menu.
  | { kind: "C_PLAIN_DENIED" }
  | { kind: "C_TX_SLOT_SELECT"; mode: "AUDIO" | "DIGITAL" }
  | { kind: "C_TX_BAUD_SELECT"; slot: SlotId; baudIndex: number }  // DIGITAL TX, MANUAL p.29
  | { kind: "C_TX_PLEASE_WAIT"; slot: SlotId; baudIndex: number; remainingMs: number }
  | { kind: "C_RX_BAUD_SELECT"; baudIndex: number }  // DIGITAL RX, MANUAL p.37
  | { kind: "C_TX_READY"; slot: SlotId; mode: "AUDIO" | "DIGITAL" }
  // `C_TX_BUSY` is held open for the entire duration the modem is actually
  // transmitting — we emit `txTransmitted` on entry, start the audio
  // synchronously in the host, and only leave the state when the host
  // calls `machine.txComplete()` after `TransmitHandle.done` resolves.
  // Previously we auto-transitioned after a fixed 1 s tick, which painted
  // "TRANSMISSION COMPLETE" long before the modem actually fell silent
  // (~30 s for a maxed-out message).
  | { kind: "C_TX_BUSY"; slot: SlotId; mode: "AUDIO" | "DIGITAL" }
  | { kind: "C_TX_COMPLETE"; slot: SlotId; mode: "AUDIO" | "DIGITAL" }
  // `active` flips true as soon as the host demodulator detects carrier /
  // receives its first byte, so the LCD can show "Receiving Message" while
  // data is actually flowing in rather than only for the post-carrier dwell.
  // Until then the LCD shows the manual's "Waiting for …" prompt.
  | { kind: "C_RX_WAIT"; mode: "AUDIO" | "DIGITAL"; slot: SlotId; active: boolean }
  | { kind: "C_RX_BUSY"; slot: SlotId; mode: "AUDIO" | "DIGITAL"; remainingMs: number }
  | { kind: "C_RX_COMPLETE"; slot: SlotId; mode: "AUDIO" | "DIGITAL" }
  | { kind: "STUB"; letter: MenuLetter; label: string }; // unimplemented menu dispatch

/**
 * Side effects the host should apply after a `press`/`tick`. Everything that
 * escapes the machine's internal state (clock reads, compartment mutation,
 * power) is surfaced here instead of baked into the machine so tests can
 * assert on effects without a real clock or audio stack.
 */
export type Effect =
  | { kind: "powerOff" }
  | { kind: "zeroizedAll" }
  | { kind: "zeroizedSlot"; slot: number }
  | { kind: "silentModeChanged"; silent: boolean }
  | { kind: "encrypted"; slot: SlotId }
  | { kind: "decrypted"; slot: SlotId }
  | { kind: "decryptFailed"; slot: SlotId }
  | { kind: "keyUpdated"; slotId: number; updateLevel: number }
  | { kind: "authChallengeSent"; challenge: string; reply: string }
  | { kind: "authReplyComputed"; challenge: string; reply: string }
  | { kind: "keyLoaded"; slotId: number; name: string }
  | { kind: "viewAngleChanged"; level: number }
  | { kind: "timeSet"; utcMs: number }
  | { kind: "printed"; slot: SlotId }
  | { kind: "txTransmitted"; slot: SlotId; mode: "AUDIO" | "DIGITAL"; wire: string }
  | { kind: "rxReceived"; slot: SlotId; mode: "AUDIO" | "DIGITAL" };

export interface MachineDeps {
  readonly keyStore: KeyCompartmentStore;
  readonly buffers: DualBuffer;
  readonly backend: CryptoBackend;
  readonly clock: Clock;
  readonly random: (n: number) => Uint8Array;
  /** Silent/Quiet mode persists across power cycles (MANUAL p.40). */
  silent: boolean;
  /** LCD view-angle level, 0..VIEW_ANGLE_MAX, persists across power cycles. */
  viewAngle: number;
}

/** Build a production-configured deps bundle. Tests can override any field. */
export function defaultDeps(overrides: Partial<MachineDeps> = {}): MachineDeps {
  return {
    keyStore: overrides.keyStore ?? new KeyCompartmentStore(),
    buffers: overrides.buffers ?? new DualBuffer(),
    backend: overrides.backend ?? new LfsrNlcBackend(),
    clock: overrides.clock ?? new SystemClock(),
    random: overrides.random ?? randomBytes,
    silent: overrides.silent ?? false,
    viewAngle: overrides.viewAngle ?? 4,
  };
}

export class Machine {
  private _state: State = { kind: "OFF" };
  private readonly deps: MachineDeps;

  constructor(deps: MachineDeps) {
    this.deps = deps;
  }

  get state(): State {
    return this._state;
  }

  get silent(): boolean {
    return this.deps.silent;
  }

  get buffers(): DualBuffer {
    return this.deps.buffers;
  }

  /** Drive an input. Returns any side effects triggered by the transition. */
  press(event: KeyEvent): Effect[] {
    if (event.kind === "tick") return this.tick(event.elapsedMs);
    return this.handleKey(this.normalizeYN(event));
  }

  /**
   * The Y and N alpha keys on the real device double as the "yes/no" answer
   * at every confirm prompt. Confirm-site handlers check for NamedKey Y/N,
   * so when the host emits `{ kind: "char", ch: "Y" }` from the alpha keycap
   * (the ergonomic thing to do — one physical key, one event shape) we
   * coerce it to `{ kind: "key", key: "Y" }` unless the current state is
   * actively typing letters. Typing states (editor, classification prompt,
   * name-entry, key-letter entry, auth-challenge entry) keep the char form.
   */
  private normalizeYN(event: Extract<KeyEvent, { kind: "key" } | { kind: "char" }>): typeof event {
    if (event.kind !== "char") return event;
    if (event.ch !== "Y" && event.ch !== "N") return event;
    const k = this._state.kind;
    const typingStates: ReadonlySet<State["kind"]> = new Set([
      "WP_EDITOR",
      "WP_SEARCH",
      "WP_CLASSIFICATION",
      "A_ENTER_CHALLENGE",
      "K_PROMPT_NAME",
      "K_ENTER_SET",
      // QUIET_MENU uses "N" (Normal) and "S" (Silent) as mode-select letters,
      // not as yes/no answers — keep the char form here.
      "QUIET_MENU",
    ]);
    if (typingStates.has(k)) return event;
    return { kind: "key", key: event.ch };
  }

  /** Force the device into MALFUNCTION: latches the screen and zeroizes. */
  malfunction(): Effect[] {
    this.deps.keyStore.clearAll();
    this._state = { kind: "MALFUNCTION" };
    return [{ kind: "zeroizedAll" }];
  }

  private tick(elapsedMs: number): Effect[] {
    const s = this._state;
    if (s.kind === "BOOT_CONFIRM") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        // Power-on window elapsed with no confirmation → auto-off.
        this._state = { kind: "OFF" };
        return [{ kind: "powerOff" }];
      }
      this._state = { kind: "BOOT_CONFIRM", remainingMs: rem };
      return [];
    }
    if (s.kind === "BANNER") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "KEY_SELECT", topSlot: 1, idBuf: "" };
        return [];
      }
      this._state = { kind: "BANNER", remainingMs: rem };
      return [];
    }
    if (s.kind === "ZEROING") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "KEY_SELECT", topSlot: 1, idBuf: "" };
        return [];
      }
      this._state = { kind: "ZEROING", remainingMs: rem };
      return [];
    }
    if (s.kind === "WP_EMPTY_NOTICE") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "WP_MODE_SELECT", slot: s.slot };
        return [];
      }
      this._state = { kind: "WP_EMPTY_NOTICE", slot: s.slot, remainingMs: rem };
      return [];
    }
    if (s.kind === "WP_STORED") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      this._state = { kind: "WP_STORED", slot: s.slot, remainingMs: rem };
      return [];
    }
    if (s.kind === "E_BUSY") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) return this.performEncrypt(s.slot);
      this._state = { kind: "E_BUSY", slot: s.slot, remainingMs: rem };
      return [];
    }
    if (s.kind === "D_BUSY") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) return this.performDecrypt(s.slot);
      this._state = { kind: "D_BUSY", slot: s.slot, remainingMs: rem };
      return [];
    }
    if (s.kind === "U_COMPLETE") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "U_POST" };
        return [];
      }
      this._state = { kind: "U_COMPLETE", remainingMs: rem };
      return [];
    }
    if (s.kind === "K_INVALID") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      this._state = { kind: "K_INVALID", remainingMs: rem };
      return [];
    }
    if (s.kind === "P_BUSY") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [{ kind: "printed", slot: s.slot }];
      }
      this._state = { kind: "P_BUSY", slot: s.slot, remainingMs: rem };
      return [];
    }
    if (s.kind === "C_TX_BUSY") {
      // No timer — the state is held until `txComplete()` is called by the
      // host after the modem actually finishes. Ticks are no-ops here.
      return [];
    }
    if (s.kind === "C_TX_PLEASE_WAIT") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "C_TX_READY", slot: s.slot, mode: "DIGITAL" };
        return [];
      }
      this._state = { ...s, remainingMs: rem };
      return [];
    }
    if (s.kind === "C_RX_BUSY") {
      const rem = s.remainingMs - elapsedMs;
      if (rem <= 0) {
        this._state = { kind: "C_RX_COMPLETE", slot: s.slot, mode: s.mode };
        return [{ kind: "rxReceived", slot: s.slot, mode: s.mode }];
      }
      this._state = { kind: "C_RX_BUSY", slot: s.slot, mode: s.mode, remainingMs: rem };
      return [];
    }
    return [];
  }

  private handleKey(event: Extract<KeyEvent, { kind: "key" } | { kind: "char" }>): Effect[] {
    const s = this._state;

    // MALFUNCTION latches. Per MANUAL p.54 the only recovery is power cycle,
    // but since the unit auto-zeroized the power-on path starts over blank.
    if (s.kind === "MALFUNCTION") {
      if (event.kind === "key" && event.key === "SRCH_ON") {
        this._state = { kind: "OFF" };
      }
      return [];
    }

    // CLK is a global shortcut to the time/date view (MANUAL p.15).
    // Disabled while the device is busy with crypto or comms, and irrelevant
    // when powered off. Everywhere else it jumps straight to CLOCK_VIEW;
    // XIT from CLOCK_VIEW returns the operator to Main Menu.
    if (event.kind === "key" && event.key === "CLK") {
      const clkBlocked: ReadonlySet<State["kind"]> = new Set([
        "OFF", "BOOT_CONFIRM", "BOOT_ZRO_CONFIRM", "BANNER",
        "E_BUSY", "D_BUSY", "C_TX_BUSY", "C_RX_BUSY", "C_TX_COMPLETE",
        "C_RX_COMPLETE", "C_TX_PLEASE_WAIT", "P_BUSY", "ZEROING", "MALFUNCTION",
        "CLOCK_VIEW", "CLOCK_EDIT",
      ]);
      if (!clkBlocked.has(s.kind)) {
        this._state = { kind: "CLOCK_VIEW" };
      }
      return [];
    }

    if (s.kind === "OFF") {
      if (event.kind === "key" && event.key === "SRCH_ON") {
        this._state = { kind: "BOOT_CONFIRM", remainingMs: POWER_ON_CONFIRM_TIMEOUT_MS };
      }
      return [];
    }

    if (s.kind === "BOOT_CONFIRM") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "BANNER", remainingMs: BANNER_DWELL_MS };
        return [];
      }
      if (event.kind === "key" && event.key === "N") {
        this._state = { kind: "OFF" };
        return [{ kind: "powerOff" }];
      }
      if (event.kind === "key" && event.key === "ZRO") {
        // MANUAL p.43: pressing ZRO immediately at boot is the emergency
        // all-keys clear path. Confirm first — per the manual note, the
        // confirm prevents accidental zeroing.
        this._state = { kind: "BOOT_ZRO_CONFIRM" };
        return [];
      }
      return [];
    }

    if (s.kind === "BOOT_ZRO_CONFIRM") {
      if (event.kind === "key" && event.key === "Y") {
        this.deps.keyStore.clearAll();
        this._state = { kind: "ZEROING", remainingMs: 500 };
        return [{ kind: "zeroizedAll" }];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        // Fall back to the normal boot confirm — operator didn't want zeroize.
        this._state = { kind: "BOOT_CONFIRM", remainingMs: POWER_ON_CONFIRM_TIMEOUT_MS };
        return [];
      }
      return [];
    }

    if (s.kind === "BANNER") {
      // Any key during banner skips it to the key select menu.
      this._state = { kind: "KEY_SELECT", topSlot: 1, idBuf: "" };
      return [];
    }

    if (s.kind === "KEY_SELECT") {
      // MANUAL p.8: "Select the loaded key by typing in the appropriate key
      // identification number." Two-digit ID# buffer — accumulates until two
      // digits are seen, then tries to select the corresponding loaded slot.
      if (event.kind === "char" && /^[0-9]$/.test(event.ch)) {
        const newBuf = s.idBuf + event.ch;
        if (newBuf.length < 2) {
          this._state = { kind: "KEY_SELECT", topSlot: s.topSlot, idBuf: newBuf };
          return [];
        }
        const n = parseInt(newBuf, 10);
        const loaded = n >= 1 && n <= 16 ? this.deps.keyStore.peek(n) : null;
        if (loaded) {
          this.deps.keyStore.select(n);
          this._state = { kind: "MAIN_MENU", topIndex: 0 };
          return [];
        }
        // Invalid (00/>16) or unloaded slot: drop buffer, stay put.
        this._state = { kind: "KEY_SELECT", topSlot: s.topSlot, idBuf: "" };
        return [];
      }
      if (event.kind === "key") {
        if (event.key === "UP") {
          this._state = { kind: "KEY_SELECT", topSlot: Math.max(1, s.topSlot - 1), idBuf: "" };
          return [];
        }
        if (event.key === "DOWN") {
          // MANUAL p.5/8: 4 slots shown at a time (2×2 grid). Last window is
          // slots {13,14,15,16} → max topSlot = 13.
          this._state = { kind: "KEY_SELECT", topSlot: Math.min(13, s.topSlot + 1), idBuf: "" };
          return [];
        }
        if (event.key === "ENTER") {
          // MANUAL p.8 shows "Is the selected key" after ENTER on a loaded
          // row. We collapse the confirmation step and implicitly select
          // the top-row compartment when it's loaded; empty slots leave
          // the previous selection intact so the operator can still reach
          // E/D/U from Main Menu without re-scrolling.
          const top = this.deps.keyStore.peek(s.topSlot);
          if (top) this.deps.keyStore.select(s.topSlot);
          this._state = { kind: "MAIN_MENU", topIndex: 0 };
          return [];
        }
        if (event.key === "ZRO") {
          this._state = { kind: "ZEROIZE_PROMPT" };
          return [];
        }
      }
      return [];
    }

    if (s.kind === "MAIN_MENU") {
      if (event.kind === "key") {
        if (event.key === "UP") {
          this._state = { kind: "MAIN_MENU", topIndex: Math.max(0, s.topIndex - 1) };
          return [];
        }
        if (event.key === "DOWN") {
          this._state = {
            kind: "MAIN_MENU",
            topIndex: Math.min(MAIN_MENU_ITEMS.length - 2, s.topIndex + 1),
          };
          return [];
        }
        if (event.key === "XIT") {
          this._state = { kind: "KEY_SELECT", topSlot: 1, idBuf: "" };
          return [];
        }
        if (event.key === "ZRO") {
          this._state = { kind: "ZEROIZE_PROMPT" };
          return [];
        }
      }
      if (event.kind === "char") {
        return this.dispatchMainMenu(event.ch);
      }
      return [];
    }

    if (s.kind === "POWER_OFF_CONFIRM") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "OFF" };
        return [{ kind: "powerOff" }];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "QUIET_MENU") {
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "S" && !this.deps.silent) {
          this.deps.silent = true;
          this._state = { kind: "MAIN_MENU", topIndex: 0 };
          return [{ kind: "silentModeChanged", silent: true }];
        }
        if (ch === "N" && this.deps.silent) {
          this.deps.silent = false;
          this._state = { kind: "MAIN_MENU", topIndex: 0 };
          return [{ kind: "silentModeChanged", silent: false }];
        }
        // Re-selecting the current mode is a no-op but returns to menu.
        if (ch === "S" || ch === "N") {
          this._state = { kind: "MAIN_MENU", topIndex: 0 };
          return [];
        }
      }
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "ZEROIZE_PROMPT") {
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "A") {
          this._state = { kind: "ZEROIZE_CONFIRM_ALL" };
          return [];
        }
        // Numeric entry is two digits per the manual's ID# scheme; accept
        // the typed digits greedily here. For now a single-digit/two-digit
        // entry finalizes on a valid slot in [1, 16].
        if (/^[0-9]$/.test(ch)) {
          // Two-digit entry isn't worth a dedicated buffered sub-state for
          // one character; tests drive this with full two-char sequences
          // by synthesizing the numeric value. Keep the single-step path
          // but accept 1..9 directly so "5" → slot 5.
          const slot = parseInt(ch, 10);
          if (slot >= 1 && slot <= 9) {
            this._state = { kind: "ZEROIZE_CONFIRM_ONE", slot };
          }
          return [];
        }
      }
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "ZEROIZE_CONFIRM_ONE") {
      if (event.kind === "key" && event.key === "Y") {
        this.deps.keyStore.clear(s.slot);
        this._state = { kind: "ZEROING", remainingMs: 500 };
        return [{ kind: "zeroizedSlot", slot: s.slot }];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "ZEROIZE_CONFIRM_ALL") {
      if (event.kind === "key" && event.key === "Y") {
        this.deps.keyStore.clearAll();
        this._state = { kind: "ZEROING", remainingMs: 500 };
        return [{ kind: "zeroizedAll" }];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "ZEROING") {
      // User input is ignored while "Zeroing . . ." is on screen. Only the
      // tick advances out of this state.
      return [];
    }

    // ───────── Encrypt flow ─────────
    if (s.kind === "E_SELECT_SLOT") {
      return this.handleCryptSlotSelect(event, "E");
    }
    if (s.kind === "E_CONFIRM_KEY") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "E_BEGIN_CONFIRM", slot: s.slot };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "E_BEGIN_CONFIRM") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "E_BUSY", slot: s.slot, remainingMs: CRYPT_BUSY_MS };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "E_BUSY") {
      return []; // Input ignored; tick advances.
    }

    // ───────── Decrypt flow ─────────
    if (s.kind === "D_SELECT_SLOT") {
      return this.handleCryptSlotSelect(event, "D");
    }
    if (s.kind === "D_CONFIRM_KEY") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "D_BEGIN_CONFIRM", slot: s.slot };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "D_BEGIN_CONFIRM") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "D_BUSY", slot: s.slot, remainingMs: CRYPT_BUSY_MS };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "D_BUSY") return [];
    if (s.kind === "D_FAIL") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "D_UNCORRECTABLE") {
      // Any key acknowledges per Appendix B ("PRESS EXIT"), but we accept
      // any key press for operator convenience — the warning has already
      // been read.
      if (event.kind === "key" || event.kind === "char") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    // ───────── Update Key flow ─────────
    if (s.kind === "U_CONFIRM") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "U_CONFIRM2" };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "U_CONFIRM2") {
      if (event.kind === "key" && event.key === "Y") {
        const sel = this.deps.keyStore.selected();
        if (!sel) {
          this._state = { kind: "MAIN_MENU", topIndex: 0 };
          return [];
        }
        if (sel.updateLevel >= MAX_UPDATE_LEVEL) {
          this._state = { kind: "U_MAX_REACHED" };
          return [];
        }
        const next = this.deps.keyStore.update(sel.id);
        this._state = { kind: "U_COMPLETE", remainingMs: UPDATE_COMPLETE_MS };
        return [{ kind: "keyUpdated", slotId: next.id, updateLevel: next.updateLevel }];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "U_COMPLETE") return [];
    if (s.kind === "U_POST") {
      if (event.kind === "key" && (event.key === "ENTER" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "U_MAX_REACHED") {
      if (event.kind === "key" || event.kind === "char") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    // ───────── Authentication flow ─────────
    if (s.kind === "A_CONFIRM_KEY") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "A_CHALLENGE_OR_REPLY" };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "A_CHALLENGE_OR_REPLY") {
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        const sel = this.deps.keyStore.selected();
        if (!sel) {
          this._state = { kind: "MAIN_MENU", topIndex: 0 };
          return [];
        }
        if (ch === "C") {
          const challenge = generateChallenge(this.deps.random);
          const reply = computeReply(sel.currentKey, challenge, this.deps.clock.nowUtcMs());
          this._state = { kind: "A_DISPLAY_CHALLENGE", challenge, reply };
          return [{ kind: "authChallengeSent", challenge, reply }];
        }
        if (ch === "R") {
          this._state = { kind: "A_ENTER_CHALLENGE", text: "" };
          return [];
        }
      }
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "A_DISPLAY_CHALLENGE") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "A_ENTER_CHALLENGE") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "A_CHALLENGE_OR_REPLY" };
        return [];
      }
      if (event.kind === "key" && event.key === "DCH") {
        if (s.text.length > 0) {
          this._state = { kind: "A_ENTER_CHALLENGE", text: s.text.slice(0, -1) };
        }
        return [];
      }
      if (event.kind === "char" && s.text.length < CHALLENGE_LENGTH) {
        const ch = event.ch.toUpperCase();
        if (/^[A-Z]$/.test(ch)) {
          const next = s.text + ch;
          if (next.length === CHALLENGE_LENGTH) {
            const sel = this.deps.keyStore.selected();
            if (!sel) {
              this._state = { kind: "MAIN_MENU", topIndex: 0 };
              return [];
            }
            const reply = computeReply(sel.currentKey, next, this.deps.clock.nowUtcMs());
            this._state = { kind: "A_DISPLAY_REPLY", challenge: next, reply };
            return [{ kind: "authReplyComputed", challenge: next, reply }];
          }
          this._state = { kind: "A_ENTER_CHALLENGE", text: next };
        }
      }
      return [];
    }
    if (s.kind === "A_DISPLAY_REPLY") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    // ───────── Clock view / edit (S menu) ─────────
    if (s.kind === "CLOCK_VIEW") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "key" && event.key === "ENTER") {
        this._state = {
          kind: "CLOCK_EDIT",
          fieldIdx: 0,
          buf: "",
          fields: clockSeed(this.deps.clock.nowUtcMs()),
        };
        return [];
      }
      return [];
    }
    if (s.kind === "CLOCK_EDIT") {
      return this.handleClockEdit(s, event);
    }

    // ───────── Key Change (K menu) ─────────
    if (s.kind === "K_PROMPT_ID") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "key" && event.key === "DCH") {
        if (s.buf.length > 0) {
          this._state = { kind: "K_PROMPT_ID", buf: s.buf.slice(0, -1) };
        }
        return [];
      }
      if (event.kind === "char" && /^[0-9]$/.test(event.ch)) {
        const buf = s.buf + event.ch;
        if (buf.length === 2) {
          const id = parseInt(buf, 10);
          if (id >= 1 && id <= 16) {
            this._state = { kind: "K_PROMPT_NAME", slotId: id, name: "" };
          } else {
            // Out-of-range → re-prompt from scratch.
            this._state = { kind: "K_PROMPT_ID", buf: "" };
          }
        } else {
          this._state = { kind: "K_PROMPT_ID", buf };
        }
      }
      return [];
    }
    if (s.kind === "K_PROMPT_NAME") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "K_PROMPT_ID", buf: "" };
        return [];
      }
      if (event.kind === "key" && event.key === "DCH") {
        if (s.name.length > 0) {
          this._state = { kind: "K_PROMPT_NAME", slotId: s.slotId, name: s.name.slice(0, -1) };
        }
        return [];
      }
      if (event.kind === "key" && event.key === "ENTER") {
        if (s.name.length === 0) return []; // name required
        this._state = {
          kind: "K_ENTER_SET",
          slotId: s.slotId,
          name: s.name,
          letters: "",
          setIdx: 0,
        };
        return [];
      }
      if (event.kind === "char" && s.name.length < 10) {
        const ch = event.ch.toUpperCase();
        if (/^[A-Z0-9 \-]$/.test(ch)) {
          this._state = { kind: "K_PROMPT_NAME", slotId: s.slotId, name: s.name + ch };
        }
      }
      return [];
    }
    if (s.kind === "K_ENTER_SET") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "key" && event.key === "DCH") {
        if (s.letters.length > 0) {
          const nextLetters = s.letters.slice(0, -1);
          const nextSetIdx = Math.floor(nextLetters.length / 8) as 0 | 1 | 2 | 3;
          this._state = { ...s, letters: nextLetters, setIdx: nextSetIdx };
        }
        return [];
      }
      if (event.kind === "char" && s.letters.length < 32) {
        const ch = event.ch.toUpperCase();
        if (/^[A-Z]$/.test(ch)) {
          const letters = s.letters + ch;
          if (letters.length === 32) {
            try {
              this.deps.keyStore.load(s.slotId, s.name, letters);
              this.deps.keyStore.select(s.slotId);
              this._state = { kind: "K_CONFIRM", slotId: s.slotId };
              return [{ kind: "keyLoaded", slotId: s.slotId, name: s.name }];
            } catch {
              this._state = { kind: "K_INVALID", remainingMs: KEY_INVALID_MS };
              return [];
            }
          }
          const setIdx = Math.floor(letters.length / 8) as 0 | 1 | 2 | 3;
          this._state = { ...s, letters, setIdx };
        }
      }
      return [];
    }
    if (s.kind === "K_INVALID") {
      // Input ignored; tick auto-advances.
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "K_CONFIRM") {
      if (event.kind === "key" && (event.key === "Y" || event.key === "ENTER")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    // ───────── Review Message (R menu) ─────────
    if (s.kind === "R_SELECT_SLOT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "A" || ch === "B") {
          this._state = {
            kind: "R_VIEWER",
            slot: ch as SlotId,
            topRow: 0,
            phonetic: false,
            tokenIndex: 0,
          };
        }
      }
      return [];
    }
    if (s.kind === "R_VIEWER") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      // SPEC Appendix A §1.1 "Verbal fallback": SRCH toggles the phonetic overlay
      // so the operator can read the (usually cipher) message aloud. This is
      // a deliberate emulator affordance — MANUAL p.21 says only ^/v are
      // functional in Review, but without a softkey there is nowhere else to
      // surface the phonetic table.
      if (event.kind === "key" && event.key === "SRCH_ON") {
        this._state = {
          kind: "R_VIEWER",
          slot: s.slot,
          topRow: s.topRow,
          phonetic: !s.phonetic,
          tokenIndex: 0,
        };
        return [];
      }
      if (s.phonetic) {
        const tokens = tokenizeForVerbal(this.deps.buffers.get(s.slot).buffer.toString());
        const last = Math.max(0, tokens.length - 1);
        if (event.kind === "key" && event.key === "UP") {
          this._state = { ...s, tokenIndex: Math.max(0, s.tokenIndex - 1) };
          return [];
        }
        if (event.kind === "key" && event.key === "DOWN") {
          this._state = { ...s, tokenIndex: Math.min(last, s.tokenIndex + 1) };
          return [];
        }
        return [];
      }
      if (event.kind === "key" && event.key === "UP") {
        this._state = { ...s, topRow: Math.max(0, s.topRow - 1) };
        return [];
      }
      if (event.kind === "key" && event.key === "DOWN") {
        const { lines } = this.deps.buffers.get(s.slot).buffer.layout();
        const lastTop = Math.max(0, lines.length - 2);
        this._state = { ...s, topRow: Math.min(lastTop, s.topRow + 1) };
        return [];
      }
      return [];
    }

    // ───────── View Angle (V menu) ─────────
    if (s.kind === "V_ADJUST") {
      if (event.kind === "key" && (event.key === "XIT" || event.key === "ENTER")) {
        this.deps.viewAngle = s.level;
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [{ kind: "viewAngleChanged", level: s.level }];
      }
      // MANUAL p.47: "the display view angle can also be set to maximum by
      // … pressing the (^) key at the Key Select Menu." ^ raises level
      // toward VIEW_ANGLE_MAX; v lowers it.
      if (event.kind === "key" && event.key === "UP") {
        this._state = { kind: "V_ADJUST", level: Math.min(VIEW_ANGLE_MAX, s.level + 1) };
        return [];
      }
      if (event.kind === "key" && event.key === "DOWN") {
        this._state = { kind: "V_ADJUST", level: Math.max(0, s.level - 1) };
        return [];
      }
      return [];
    }

    // ───────── Print (P menu) ─────────
    if (s.kind === "P_SELECT_SLOT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "A" || ch === "B") {
          const slot: SlotId = ch;
          const slotState = this.deps.buffers.get(slot);
          // Plaintext → warn before printing (MANUAL p.46).
          if (slotState.form === "PLAIN") {
            this._state = { kind: "P_WARN_PLAIN", slot };
          } else {
            this._state = { kind: "P_MENU", slot };
          }
        }
      }
      return [];
    }
    if (s.kind === "P_WARN_PLAIN") {
      if (event.kind === "key" && event.key === "Y") {
        this._state = { kind: "P_MENU", slot: s.slot };
        return [];
      }
      if (event.kind === "key" && (event.key === "N" || event.key === "XIT")) {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "P_MENU") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "P") {
          this._state = { kind: "P_BUSY", slot: s.slot, remainingMs: PRINT_BUSY_MS };
        }
        // L (line feed) and F (form feed) emit nothing visible in our
        // emulator; real printer output is beyond scope.
      }
      return [];
    }
    if (s.kind === "P_BUSY") {
      if (event.kind === "key" && event.key === "XIT") {
        // Abort: stop printing, return to menu without emitting `printed`.
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    // ───────── Communications (C menu) ─────────
    if (s.kind === "C_MODE_SELECT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "A") this._state = { kind: "C_DIR_SELECT", mode: "AUDIO" };
        else if (ch === "D") this._state = { kind: "C_DIR_SELECT", mode: "DIGITAL" };
      }
      return [];
    }
    if (s.kind === "C_DIR_SELECT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "C_MODE_SELECT" };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "T") {
          this._state = s.mode === "AUDIO"
            ? { kind: "C_AUDIO_SUBMODE", dir: "TX" }
            : { kind: "C_TX_SLOT_SELECT", mode: s.mode };
        } else if (ch === "R") {
          // Default RX into slot A. A host that delivers a message via
          // `feedReceived` can redirect by passing a slot explicitly.
          this._state = s.mode === "AUDIO"
            ? { kind: "C_AUDIO_SUBMODE", dir: "RX" }
            : { kind: "C_RX_BAUD_SELECT", baudIndex: DEFAULT_BAUD_INDEX };
        }
      }
      return [];
    }
    if (s.kind === "C_AUDIO_SUBMODE") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "C_DIR_SELECT", mode: "AUDIO" };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "A") {
          // MANUAL p.39: Silent Mode disallows acoustic-coupler comms (audio
          // output via internal speaker). Appendix B p.53 gives the warning.
          if (this.deps.silent) {
            this._state = { kind: "C_AUDIO_DENIED" };
            return [];
          }
          this._state = { kind: "C_ACOUSTIC_LINES", dir: s.dir };
        } else if (ch === "C") {
          // Connector-audio path skips the U.S./European lines prompt.
          // Allowed in Silent Mode per p.39 Note: RS-232/423/Connector Audio
          // may be used regardless of operation mode.
          this._state = s.dir === "TX"
            ? { kind: "C_TX_SLOT_SELECT", mode: "AUDIO" }
            : { kind: "C_RX_WAIT", mode: "AUDIO", slot: "A", active: false };
        }
      }
      return [];
    }
    if (s.kind === "C_AUDIO_DENIED") {
      // Any key acknowledges the warning and returns to Main Menu.
      if (event.kind === "key" || event.kind === "char") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "C_LOCAL_CIPHER_DENIED") {
      if (event.kind === "key" || event.kind === "char") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "C_PLAIN_DENIED") {
      if (event.kind === "key" || event.kind === "char") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "C_ACOUSTIC_LINES") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "C_AUDIO_SUBMODE", dir: s.dir };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "U" || ch === "E") {
          // U.S./European selection only affects the analog transmit level;
          // it has no downstream effect in this emulator.
          this._state = s.dir === "TX"
            ? { kind: "C_TX_SLOT_SELECT", mode: "AUDIO" }
            : { kind: "C_RX_WAIT", mode: "AUDIO", slot: "A", active: false };
        }
      }
      return [];
    }
    if (s.kind === "C_TX_SLOT_SELECT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "C_DIR_SELECT", mode: s.mode };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "A" || ch === "B") {
          const slot: SlotId = ch;
          // Enforce MANUAL p.52–53: locally-entered ciphertext and raw
          // plaintext are both refused. Dispatch on the error reason so the
          // operator sees the correct Appendix B warning.
          try {
            this.deps.buffers.assertTransmittable(slot);
          } catch (err) {
            if (err instanceof TransmitDeniedError && err.reason === "PLAIN") {
              // warn_plain_tx: MESSAGE IN PLAIN TEXT FORM / COMMUNICATIONS DENIED.
              this._state = { kind: "C_PLAIN_DENIED" };
              return [];
            }
            // warn_local_cipher: CIPHER TEXT HAS BEEN LOCALLY ENTERED / …DENIED.
            this._state = { kind: "C_LOCAL_CIPHER_DENIED" };
            return [];
          }
          // DIGITAL TX inserts baud-select + Please Wait per MANUAL p.28-29.
          // AUDIO TX skips both (the baud selector is the Digital-only gate).
          this._state = s.mode === "DIGITAL"
            ? { kind: "C_TX_BAUD_SELECT", slot, baudIndex: DEFAULT_BAUD_INDEX }
            : { kind: "C_TX_READY", slot, mode: s.mode };
        }
      }
      return [];
    }
    if (s.kind === "C_TX_BAUD_SELECT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "C_TX_SLOT_SELECT", mode: "DIGITAL" };
        return [];
      }
      if (event.kind === "key" && event.key === "UP") {
        const next = Math.min(BAUD_RATES.length - 1, s.baudIndex + 1);
        this._state = { ...s, baudIndex: next };
        return [];
      }
      if (event.kind === "key" && event.key === "DOWN") {
        const next = Math.max(0, s.baudIndex - 1);
        this._state = { ...s, baudIndex: next };
        return [];
      }
      if (event.kind === "key" && event.key === "ENTER") {
        this._state = {
          kind: "C_TX_PLEASE_WAIT",
          slot: s.slot,
          baudIndex: s.baudIndex,
          remainingMs: PLEASE_WAIT_MS,
        };
      }
      return [];
    }
    if (s.kind === "C_TX_PLEASE_WAIT") {
      // XIT aborts back to Main Menu; the manual says (XIT) aborts transmission.
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "C_RX_BAUD_SELECT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "C_DIR_SELECT", mode: "DIGITAL" };
        return [];
      }
      if (event.kind === "key" && event.key === "UP") {
        const next = Math.min(BAUD_RATES.length - 1, s.baudIndex + 1);
        this._state = { ...s, baudIndex: next };
        return [];
      }
      if (event.kind === "key" && event.key === "DOWN") {
        const next = Math.max(0, s.baudIndex - 1);
        this._state = { ...s, baudIndex: next };
        return [];
      }
      if (event.kind === "key" && event.key === "ENTER") {
        this._state = { kind: "C_RX_WAIT", mode: "DIGITAL", slot: "A", active: false };
      }
      return [];
    }
    if (s.kind === "C_TX_READY") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "key" && event.key === "ENTER") {
        const wire = this.deps.buffers.get(s.slot).buffer.toString();
        this._state = { kind: "C_TX_BUSY", slot: s.slot, mode: s.mode };
        // Fire the TX effect immediately so the host starts the modem
        // audio as soon as the "TRANSMITTING MESSAGE" screen appears. The
        // state is then held open until `txComplete()` is called.
        return [{ kind: "txTransmitted", slot: s.slot, mode: s.mode, wire }];
      }
      return [];
    }
    if (s.kind === "C_TX_BUSY") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "C_TX_COMPLETE") {
      if (event.kind === "key" && event.key === "ENTER") {
        // Retransmit — emit txTransmitted again so the host restarts audio.
        const wire = this.deps.buffers.get(s.slot).buffer.toString();
        this._state = { kind: "C_TX_BUSY", slot: s.slot, mode: s.mode };
        return [{ kind: "txTransmitted", slot: s.slot, mode: s.mode, wire }];
      }
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "C_RX_WAIT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      // No keyboard path out: either XIT, or host calls feedReceived().
      return [];
    }
    if (s.kind === "C_RX_BUSY") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }
    if (s.kind === "C_RX_COMPLETE") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "STUB") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "WP_SELECT_SLOT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "A" || ch === "B") {
          const slot: SlotId = ch;
          if (this.deps.buffers.get(slot).buffer.length === 0) {
            this._state = {
              kind: "WP_EMPTY_NOTICE",
              slot,
              remainingMs: WP_EMPTY_NOTICE_MS,
            };
          } else {
            this._state = { kind: "WP_CLEAR_CONFIRM", slot };
          }
        }
      }
      return [];
    }

    if (s.kind === "WP_CLEAR_CONFIRM") {
      if (event.kind === "key" && event.key === "Y") {
        this.deps.buffers.reset(s.slot);
        this._state = {
          kind: "WP_EMPTY_NOTICE",
          slot: s.slot,
          remainingMs: WP_EMPTY_NOTICE_MS,
        };
        return [];
      }
      if (event.kind === "key" && event.key === "N") {
        // Keep existing contents, drop straight into the editor in its
        // existing form. No mode prompt when resuming a message.
        this._state = {
          kind: "WP_EDITOR",
          slot: s.slot,
          mode: this.deps.buffers.get(s.slot).form,
        };
        return [];
      }
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    if (s.kind === "WP_EMPTY_NOTICE") {
      // Any keypress during the notice fast-forwards to mode select. The
      // tick handler takes care of auto-advance after the dwell.
      if (event.kind === "key" || event.kind === "char") {
        this._state = { kind: "WP_MODE_SELECT", slot: s.slot };
      }
      return [];
    }

    if (s.kind === "WP_MODE_SELECT") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
        return [];
      }
      if (event.kind === "char") {
        const ch = event.ch.toUpperCase();
        if (ch === "P") {
          this._state = { kind: "WP_CLASSIFICATION", slot: s.slot, text: "" };
          this.deps.buffers.markTyped(s.slot, "PLAIN");
          return [];
        }
        if (ch === "C") {
          this.deps.buffers.markTyped(s.slot, "CIPHER");
          this._state = { kind: "WP_EDITOR", slot: s.slot, mode: "CIPHER" };
          return [];
        }
      }
      return [];
    }

    if (s.kind === "WP_CLASSIFICATION") {
      if (event.kind === "key" && event.key === "XIT") {
        this._state = { kind: "WP_MODE_SELECT", slot: s.slot };
        return [];
      }
      if (event.kind === "key" && event.key === "ENTER") {
        try {
          this.deps.buffers.setClassification(s.slot, s.text);
        } catch (err) {
          if (err instanceof InvalidClassificationError) {
            // Reject silently: stay on the prompt. A production UI would
            // flash an error; for now the operator just retries.
            return [];
          }
          throw err;
        }
        // MANUAL p.12: the classification "becomes part of the message" —
        // prepend it (uppercased + trimmed) to the editor buffer on a line
        // of its own so it is visible in Review, encrypted with the body,
        // transmitted on the wire, and shown after decrypt on the receiver.
        const normalized = s.text.trim().toUpperCase();
        if (normalized.length > 0) {
          const buf = this.deps.buffers.get(s.slot).buffer;
          buf.clear();
          buf.insertString(normalized + "\n");
        }
        this._state = { kind: "WP_EDITOR", slot: s.slot, mode: "PLAIN" };
        return [];
      }
      if (event.kind === "key" && event.key === "DCH") {
        if (s.text.length > 0) {
          this._state = {
            kind: "WP_CLASSIFICATION",
            slot: s.slot,
            text: s.text.slice(0, -1),
          };
        }
        return [];
      }
      if (event.kind === "char") {
        if (s.text.length >= MAX_CLASSIFICATION_LENGTH) return [];
        const ch = event.ch.toUpperCase();
        // The classification alphabet is A-Z + 0-9 + space + dash (per
        // DualBuffer.CLASSIFICATION_PATTERN). Silently drop anything else.
        if (/^[A-Z0-9 \-]$/.test(ch)) {
          this._state = {
            kind: "WP_CLASSIFICATION",
            slot: s.slot,
            text: s.text + ch,
          };
        }
        return [];
      }
      return [];
    }

    if (s.kind === "WP_EDITOR") {
      const buf = this.deps.buffers.get(s.slot).buffer;
      if (event.kind === "key") {
        if (event.key === "XIT") {
          // Storing happens implicitly: the DualBuffer already owns the
          // TextBuffer; we just transition to the "Stored As Message {AB}"
          // notice and auto-return to Main Menu.
          this._state = { kind: "WP_STORED", slot: s.slot, remainingMs: WP_STORED_NOTICE_MS };
          return [];
        }
        if (event.key === "ENTER") {
          // Cap-gate newline inserts the same way char events are gated.
          // Without this, pasting past the cap would keep appending
          // newlines (chars get filtered by the `buf.length < cap` check
          // below, but ENTER used to slip through unchecked) until the
          // physical buffer filled and `insertChar` threw BufferFullError
          // mid-paste, leaving the editor in a bad state.
          const cap = s.mode === "CIPHER" ? MAX_BUFFER_CHARS : MAX_PLAINTEXT_CHARS;
          if (buf.length < cap) buf.insertChar("\n");
          return [];
        }
        if (event.key === "DCH") {
          buf.deleteCharLeft();
          return [];
        }
        if (event.key === "DWD") {
          buf.deleteWordRight();
          return [];
        }
        if (event.key === "LEFT")  { buf.moveLeft();  return []; }
        if (event.key === "RIGHT") { buf.moveRight(); return []; }
        if (event.key === "UP")    { buf.moveUp();    return []; }
        if (event.key === "DOWN")  { buf.moveDown();  return []; }
        if (event.key === "BOT")   { buf.moveBot();   return []; }
        if (event.key === "EOT")   { buf.moveEot();   return []; }
        if (event.key === "BOL")   { buf.moveBol();   return []; }
        if (event.key === "EOL")   { buf.moveEol();   return []; }
        if (event.key === "SRCH_ON") {
          this._state = { kind: "WP_SEARCH", slot: s.slot, mode: s.mode, term: "", notFound: false };
          return [];
        }
      }
      if (event.kind === "char") {
        const ch = s.mode === "CIPHER"
          // Cipher-text entry accepts only base32 (A-Z + 2-7); everything
          // else is silently ignored (SPEC Appendix A §6.7, §4.5).
          ? (/^[A-Za-z2-7]$/.test(event.ch) ? event.ch.toUpperCase() : null)
          // Plain text accepts any printable char as-is; device is
          // uppercase-only per MANUAL p.12 note.
          : (event.ch.length === 1 ? event.ch.toUpperCase() : null);
        // PLAIN mode caps at MANUAL p.10's 2600-char limit; CIPHER mode
        // (operator re-entering a received ciphertext) can hold up to the
        // physical buffer size — a maxed plaintext encrypts to ~6400 chars
        // of display form and the receiver has to be able to type it back.
        const cap = s.mode === "CIPHER" ? MAX_BUFFER_CHARS : MAX_PLAINTEXT_CHARS;
        if (ch !== null && buf.length < cap) {
          buf.insertChar(ch);
        }
      }
      return [];
    }

    if (s.kind === "WP_SEARCH") {
      const buf = this.deps.buffers.get(s.slot).buffer;
      if (event.kind === "key") {
        if (event.key === "XIT") {
          this._state = { kind: "WP_EDITOR", slot: s.slot, mode: s.mode };
          return [];
        }
        if (event.key === "DCH") {
          this._state = { ...s, term: s.term.slice(0, -1), notFound: false };
          return [];
        }
        if (event.key === "ENTER") {
          if (s.term.length === 0) return [];
          const hit = buf.search(s.term);
          if (hit) {
            this._state = { kind: "WP_EDITOR", slot: s.slot, mode: s.mode };
          } else {
            this._state = { ...s, notFound: true };
          }
          return [];
        }
      }
      if (event.kind === "char") {
        if (s.term.length >= 20) return [];
        const ch = event.ch.length === 1 ? event.ch.toUpperCase() : null;
        if (ch !== null) {
          this._state = { ...s, term: s.term + ch, notFound: false };
        }
      }
      return [];
    }

    if (s.kind === "WP_STORED") {
      // Any keypress fast-forwards; tick auto-advances.
      if (event.kind === "key" || event.kind === "char") {
        this._state = { kind: "MAIN_MENU", topIndex: 0 };
      }
      return [];
    }

    return [];
  }

  private dispatchMainMenu(ch: string): Effect[] {
    const letter = ch.toUpperCase();
    const item = MAIN_MENU_ITEMS.find((i) => i.key === letter);
    if (!item) return [];

    switch (item.key) {
      case "O":
        this._state = { kind: "POWER_OFF_CONFIRM" };
        return [];
      case "Q":
        this._state = { kind: "QUIET_MENU" };
        return [];
      case "W":
        this._state = { kind: "WP_SELECT_SLOT" };
        return [];
      case "E":
        this._state = { kind: "E_SELECT_SLOT" };
        return [];
      case "D":
        this._state = { kind: "D_SELECT_SLOT" };
        return [];
      case "U":
        // No selected key → nothing to update; fall back to STUB so the
        // operator sees something rather than silently no-oping.
        if (!this.deps.keyStore.selected()) {
          this._state = { kind: "STUB", letter: "U", label: item.label };
          return [];
        }
        this._state = { kind: "U_CONFIRM" };
        return [];
      case "A":
        if (!this.deps.keyStore.selected()) {
          this._state = { kind: "STUB", letter: "A", label: item.label };
          return [];
        }
        this._state = { kind: "A_CONFIRM_KEY" };
        return [];
      case "S":
        this._state = { kind: "CLOCK_VIEW" };
        return [];
      case "K":
        this._state = { kind: "K_PROMPT_ID", buf: "" };
        return [];
      case "R":
        this._state = { kind: "R_SELECT_SLOT" };
        return [];
      case "V":
        this._state = { kind: "V_ADJUST", level: this.deps.viewAngle };
        return [];
      case "P":
        this._state = { kind: "P_SELECT_SLOT" };
        return [];
      case "C":
        this._state = { kind: "C_MODE_SELECT" };
        return [];
      default:
        this._state = { kind: "STUB", letter: item.key as MenuLetter, label: item.label };
        return [];
    }
  }

  /**
   * Simulate carrier detection during a C_RX_WAIT. The host hands the raw
   * received text (MI + grouped base32 body) straight into the selected
   * slot's buffer and we transition to C_RX_BUSY, finally emitting
   * `rxReceived` after the dwell. Callers in production plumb this from the
   * modem layer; tests use it directly.
   */
  /**
   * Signal from the host that the modem has locked onto a carrier / seen
   * its first inbound byte. Flips C_RX_WAIT.active true so the LCD swaps
   * from "Waiting for Carrier…" to "Receiving Message" while bytes are
   * still streaming in. Idempotent and a no-op outside C_RX_WAIT.
   */
  rxCarrierDetected(): void {
    if (this._state.kind !== "C_RX_WAIT") return;
    if (this._state.active) return;
    this._state = { ...this._state, active: true };
  }

  /**
   * Signal from the host that the modem has finished playing the
   * transmitted message (carrier dropped). Transitions C_TX_BUSY →
   * C_TX_COMPLETE so the LCD swaps from "TRANSMITTING MESSAGE" to
   * "TRANSMISSION COMPLETE" in sync with the audio actually stopping.
   *
   * No-op outside C_TX_BUSY — if the operator pressed XIT and the machine
   * already left the state, the host's deferred `handle.done` callback can
   * still fire and we silently ignore it.
   */
  txComplete(): void {
    if (this._state.kind !== "C_TX_BUSY") return;
    this._state = { kind: "C_TX_COMPLETE", slot: this._state.slot, mode: this._state.mode };
  }

  feedReceived(text: string, slot?: SlotId): void {
    if (this._state.kind !== "C_RX_WAIT") {
      throw new Error(`feedReceived requires C_RX_WAIT, got ${this._state.kind}`);
    }
    const target = slot ?? this._state.slot;
    const buf = this.deps.buffers.get(target).buffer;
    buf.clear();
    buf.insertString(text);
    this.deps.buffers.markReceived(target);
    this._state = {
      kind: "C_RX_BUSY",
      slot: target,
      mode: this._state.mode,
      remainingMs: RX_BUSY_MS,
    };
  }

  private handleClockEdit(
    s: Extract<State, { kind: "CLOCK_EDIT" }>,
    event: Extract<KeyEvent, { kind: "key" } | { kind: "char" }>,
  ): Effect[] {
    if (event.kind === "key" && event.key === "XIT") {
      // Abort: discard pending edits, return to the read-only view.
      this._state = { kind: "CLOCK_VIEW" };
      return [];
    }
    if (event.kind === "key" && event.key === "DCH") {
      if (s.buf.length > 0) {
        this._state = { ...s, buf: s.buf.slice(0, -1) };
      }
      return [];
    }
    const field = CLOCK_FIELDS[s.fieldIdx];
    if (!field) return [];
    if (event.kind !== "char" || !/^[0-9]$/.test(event.ch)) return [];
    if (s.buf.length >= field.width) return [];
    const buf = s.buf + event.ch;
    if (buf.length < field.width) {
      this._state = { ...s, buf };
      return [];
    }
    const val = parseInt(buf, 10);
    if (val < field.min || val > field.max) {
      // Out of range — reset the buffer and let the operator retry.
      this._state = { ...s, buf: "" };
      return [];
    }
    const nextFields = s.fields.slice();
    nextFields[s.fieldIdx] = buf;
    if (s.fieldIdx === CLOCK_FIELDS.length - 1) {
      const utcMs = Date.UTC(
        parseInt(nextFields[2]!, 10),
        parseInt(nextFields[0]!, 10) - 1,
        parseInt(nextFields[1]!, 10),
        parseInt(nextFields[3]!, 10),
        parseInt(nextFields[4]!, 10),
        parseInt(nextFields[5]!, 10),
      );
      this.deps.clock.set(utcMs);
      this._state = { kind: "CLOCK_VIEW" };
      return [{ kind: "timeSet", utcMs }];
    }
    this._state = {
      kind: "CLOCK_EDIT",
      fieldIdx: s.fieldIdx + 1,
      buf: "",
      fields: nextFields,
    };
    return [];
  }

  /**
   * Shared A/B slot selection for the Encrypt and Decrypt flows. Both sides
   * pick which message buffer to operate on, require a key to have been
   * selected on the Key Select Menu, and then advance into the key-confirm
   * screen. XIT aborts back to the Main Menu.
   */
  private handleCryptSlotSelect(
    event: Extract<KeyEvent, { kind: "key" } | { kind: "char" }>,
    mode: "E" | "D",
  ): Effect[] {
    if (event.kind === "key" && event.key === "XIT") {
      this._state = { kind: "MAIN_MENU", topIndex: 0 };
      return [];
    }
    if (event.kind !== "char") return [];
    const ch = event.ch.toUpperCase();
    if (ch !== "A" && ch !== "B") return [];
    const slot: SlotId = ch;
    // Guard: we need a selected key to encrypt/decrypt under.
    if (!this.deps.keyStore.selected()) {
      this._state = { kind: "MAIN_MENU", topIndex: 0 };
      return [];
    }
    this._state =
      mode === "E"
        ? { kind: "E_CONFIRM_KEY", slot }
        : { kind: "D_CONFIRM_KEY", slot };
    return [];
  }

  /**
   * Encrypt the given slot's buffer under the selected key. On success the
   * buffer is replaced with the on-wire display form (MI + grouped base32),
   * the slot is marked ENCRYPTED, and we return to the Main Menu.
   */
  private performEncrypt(slot: SlotId): Effect[] {
    const sel = this.deps.keyStore.selected();
    if (!sel) {
      this._state = { kind: "MAIN_MENU", topIndex: 0 };
      return [];
    }
    const buf = this.deps.buffers.get(slot).buffer;
    const plaintext = buf.toString();
    const message = encryptMessage(sel, this.deps.backend, plaintext, this.deps.random);
    const display = formatForDisplay(message);
    buf.clear();
    buf.insertString(display);
    this.deps.buffers.markEncrypted(slot);
    this._state = { kind: "MAIN_MENU", topIndex: 0 };
    return [{ kind: "encrypted", slot }];
  }

  /**
   * Decrypt the given slot's buffer under the selected key. On parse or MAC
   * failure we transition to D_FAIL (latch until XIT) rather than mutating
   * the buffer — operators must be able to recover original ciphertext.
   */
  private performDecrypt(slot: SlotId): Effect[] {
    const sel = this.deps.keyStore.selected();
    if (!sel) {
      this._state = { kind: "MAIN_MENU", topIndex: 0 };
      return [];
    }
    const buf = this.deps.buffers.get(slot).buffer;
    const wire = buf.toString();
    try {
      const message = parseDisplayForm(wire);
      const plaintext = decryptMessage(sel, this.deps.backend, message);
      buf.clear();
      buf.insertString(plaintext);
      this.deps.buffers.markDecrypted(slot);
      this._state = { kind: "MAIN_MENU", topIndex: 0 };
      return [{ kind: "decrypted", slot }];
    } catch (err) {
      // Line-noise past the RS capacity is a distinct failure mode from
      // "cipher doesn't decrypt" (bad key, truncated body, key-set drift).
      // MANUAL p.53 Appendix B documents both warnings separately.
      if (err instanceof UncorrectableError) {
        this._state = { kind: "D_UNCORRECTABLE", errorsCorrected: 0 };
        return [{ kind: "decryptFailed", slot }];
      }
      this._state = { kind: "D_FAIL" };
      return [{ kind: "decryptFailed", slot }];
    }
  }
}
