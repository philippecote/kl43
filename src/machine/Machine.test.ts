import { describe, expect, it } from "vitest";
import {
  BANNER_DWELL_MS,
  CRYPT_BUSY_MS,
  KEY_INVALID_MS,
  Machine,
  PLEASE_WAIT_MS,
  POWER_ON_CONFIRM_TIMEOUT_MS,
  PRINT_BUSY_MS,
  RX_BUSY_MS,
  TX_BUSY_MS,
  UPDATE_COMPLETE_MS,
  VIEW_ANGLE_MAX,
  defaultDeps,
  type Effect,
} from "./Machine.js";
import { renderScreen } from "./Screen.js";
import { KeyCompartmentStore } from "../state/KeyCompartment.js";
import { DualBuffer } from "../editor/DualBuffer.js";
import { decodeKey, appendChecksum } from "../crypto/KeyCodec.js";
import { LfsrNlcBackend } from "../crypto/backends/LfsrNlcBackend.js";
import { FakeClock } from "../state/Clock.js";
import { computeReply } from "../auth/Authentication.js";

function fixedRandom(seed = 1): (n: number) => Uint8Array {
  let s = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

function build(opts: {
  silent?: boolean;
  clockMs?: number;
} = {}): {
  m: Machine;
  store: KeyCompartmentStore;
  buffers: DualBuffer;
  clock: FakeClock;
} {
  const store = new KeyCompartmentStore();
  const buffers = new DualBuffer();
  const clock = new FakeClock(opts.clockMs ?? Date.UTC(1991, 7, 15, 12, 34, 56));
  const m = new Machine(defaultDeps({
    keyStore: store,
    buffers,
    backend: new LfsrNlcBackend(),
    clock,
    random: fixedRandom(1),
    silent: opts.silent ?? false,
  }));
  return { m, store, buffers, clock };
}

function powerOn(m: Machine): void {
  m.press({ kind: "key", key: "SRCH_ON" });
  m.press({ kind: "key", key: "Y" });
  m.press({ kind: "tick", elapsedMs: BANNER_DWELL_MS });
}

function makeKeyLetters(): string {
  // Build 30 letters of raw key material, then append the 2-letter checksum
  // so parseKey accepts it. A-P are the canonical alphabet (4 bits each).
  const raw = new Uint8Array(15);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) & 0xff;
  // Reuse decodeKey to render 15 bytes → 30 letters (A-P only).
  const padded = new Uint8Array(16);
  padded.set(raw);
  const body30 = decodeKey(padded).slice(0, 30);
  return appendChecksum(body30);
}

describe("boot sequence (MANUAL p.5)", () => {
  it("starts OFF with a blank LCD", () => {
    const { m, store } = build();
    expect(m.state.kind).toBe("OFF");
    expect(renderScreen(m.state, store, false)).toEqual([""]);
  });

  it("SRCH/ON shows power-on confirm prompt", () => {
    const { m, store } = build();
    m.press({ kind: "key", key: "SRCH_ON" });
    expect(m.state.kind).toBe("BOOT_CONFIRM");
    expect(renderScreen(m.state, store, false)).toEqual(["Confirm--Turn power on? (Y/N)"]);
  });

  it("Y advances to the TRW banner", () => {
    const { m } = build();
    m.press({ kind: "key", key: "SRCH_ON" });
    m.press({ kind: "key", key: "Y" });
    expect(m.state.kind).toBe("BANNER");
  });

  it("N at the confirm screen powers down and emits powerOff", () => {
    const { m } = build();
    m.press({ kind: "key", key: "SRCH_ON" });
    const effects = m.press({ kind: "key", key: "N" });
    expect(m.state.kind).toBe("OFF");
    expect(effects).toContainEqual({ kind: "powerOff" });
  });

  it("auto-powers-down after 15 seconds with no confirmation", () => {
    const { m } = build();
    m.press({ kind: "key", key: "SRCH_ON" });
    expect(m.state.kind).toBe("BOOT_CONFIRM");
    // Advance just short of the window — still in confirm.
    m.press({ kind: "tick", elapsedMs: POWER_ON_CONFIRM_TIMEOUT_MS - 1 });
    expect(m.state.kind).toBe("BOOT_CONFIRM");
    // One more ms and we time out.
    const effects = m.press({ kind: "tick", elapsedMs: 1 });
    expect(m.state.kind).toBe("OFF");
    expect(effects).toContainEqual({ kind: "powerOff" });
  });

  it("banner auto-advances to Key Select after its dwell", () => {
    const { m } = build();
    m.press({ kind: "key", key: "SRCH_ON" });
    m.press({ kind: "key", key: "Y" });
    m.press({ kind: "tick", elapsedMs: BANNER_DWELL_MS });
    expect(m.state.kind).toBe("KEY_SELECT");
  });

  it("any key during banner skips to Key Select", () => {
    const { m } = build();
    m.press({ kind: "key", key: "SRCH_ON" });
    m.press({ kind: "key", key: "Y" });
    m.press({ kind: "key", key: "ENTER" });
    expect(m.state.kind).toBe("KEY_SELECT");
  });
});

describe("emergency zeroize at boot (MANUAL p.43)", () => {
  it("ZRO at the power-on confirm shows the zero-all confirmation", () => {
    const { m, store } = build();
    store.load(1, "TEST", makeKeyLetters());
    m.press({ kind: "key", key: "SRCH_ON" });
    m.press({ kind: "key", key: "ZRO" });
    expect(m.state.kind).toBe("BOOT_ZRO_CONFIRM");
  });

  it("confirming zeroize-all clears every slot and reports zeroizedAll", () => {
    const { m, store } = build();
    store.load(1, "A", makeKeyLetters());
    store.load(2, "B", makeKeyLetters());
    m.press({ kind: "key", key: "SRCH_ON" });
    m.press({ kind: "key", key: "ZRO" });
    const effects = m.press({ kind: "key", key: "Y" });
    expect(effects).toContainEqual({ kind: "zeroizedAll" });
    expect(store.peek(1)).toBeNull();
    expect(store.peek(2)).toBeNull();
    expect(m.state.kind).toBe("ZEROING");
  });

  it("declining zeroize at boot returns to the power-on confirm", () => {
    const { m, store } = build();
    store.load(1, "KEEP", makeKeyLetters());
    m.press({ kind: "key", key: "SRCH_ON" });
    m.press({ kind: "key", key: "ZRO" });
    m.press({ kind: "key", key: "N" });
    expect(m.state.kind).toBe("BOOT_CONFIRM");
    expect(store.peek(1)).not.toBeNull();
  });
});

describe("Key Select Menu", () => {
  it("shows a 2×2 grid of the first four slots + indicator column", () => {
    const { m, store } = build();
    powerOn(m);
    expect(m.state.kind).toBe("KEY_SELECT");
    const [r1, r2] = renderScreen(m.state, store, false);
    // Each column is 16 chars (15-char "NN-AVAILABLE-00" + 1 pad), separated
    // by 1 space, then a 1-space gap before the indicator column.
    expect(r1).toBe("01-AVAILABLE-00  02-AVAILABLE-00  ^ or v");
    expect(r2).toBe("03-AVAILABLE-00  04-AVAILABLE-00     ID#");
    expect(r1!.length).toBe(40);
    expect(r2!.length).toBe(40);
  });

  it("scrolls with UP/DOWN, clamping at 1 and 13", () => {
    const { m } = build();
    powerOn(m);
    // Scroll past the top.
    m.press({ kind: "key", key: "UP" });
    expect(m.state).toEqual({ kind: "KEY_SELECT", topSlot: 1, idBuf: "" });
    // Scroll all the way down — with a 4-slot window the last topSlot is 13
    // (shows 13, 14, 15, 16).
    for (let i = 0; i < 100; i++) m.press({ kind: "key", key: "DOWN" });
    expect(m.state).toEqual({ kind: "KEY_SELECT", topSlot: 13, idBuf: "" });
  });

  it("ENTER advances from Key Select → Main Menu", () => {
    const { m } = build();
    powerOn(m);
    m.press({ kind: "key", key: "ENTER" });
    expect(m.state.kind).toBe("MAIN_MENU");
  });

  it("two-digit ID# selects a loaded key and jumps to Main Menu (MANUAL p.8)", () => {
    const { m, store } = build();
    store.load(3, "BRAVO", "A".repeat(32));
    powerOn(m);
    m.press({ kind: "char", ch: "0" });
    expect(m.state).toEqual({ kind: "KEY_SELECT", topSlot: 1, idBuf: "0" });
    m.press({ kind: "char", ch: "3" });
    expect(m.state.kind).toBe("MAIN_MENU");
    expect(store.selected()?.id).toBe(3);
  });

  it("two-digit ID# on unloaded slot clears buffer and stays put", () => {
    const { m, store } = build();
    powerOn(m);
    m.press({ kind: "char", ch: "0" });
    m.press({ kind: "char", ch: "5" });
    expect(m.state).toEqual({ kind: "KEY_SELECT", topSlot: 1, idBuf: "" });
    expect(store.selected()).toBeNull();
  });

  it("out-of-range ID# (00 or >16) clears buffer", () => {
    const { m } = build();
    powerOn(m);
    m.press({ kind: "char", ch: "0" });
    m.press({ kind: "char", ch: "0" });
    expect(m.state).toEqual({ kind: "KEY_SELECT", topSlot: 1, idBuf: "" });
    m.press({ kind: "char", ch: "9" });
    m.press({ kind: "char", ch: "9" });
    expect(m.state).toEqual({ kind: "KEY_SELECT", topSlot: 1, idBuf: "" });
  });
});

describe("Main Menu (MANUAL p.9)", () => {
  function enterMainMenu(m: Machine): void {
    powerOn(m);
    m.press({ kind: "key", key: "ENTER" });
  }

  it("shows W and Q as the first two items with the scroll indicator", () => {
    const { m, store } = build();
    enterMainMenu(m);
    const [r1, r2] = renderScreen(m.state, store, false);
    // MANUAL p.9: "^ or v or" / "Select Function" indicator column.
    expect(r1).toBe("W - WORD PROCESSOR             ^ or v or");
    expect(r2).toBe("Q - QUIET OPERATION      Select Function");
    expect(r1!.length).toBe(40);
    expect(r2!.length).toBe(40);
  });

  it("XIT returns to Key Select", () => {
    const { m } = build();
    enterMainMenu(m);
    m.press({ kind: "key", key: "XIT" });
    expect(m.state.kind).toBe("KEY_SELECT");
  });

  it("all 13 menu letters dispatch (either a concrete state or STUB)", () => {
    const letters = ["W", "Q", "S", "K", "U", "E", "D", "A", "P", "C", "R", "V", "O"];
    for (const letter of letters) {
      const { m } = build();
      enterMainMenu(m);
      m.press({ kind: "char", ch: letter });
      expect(m.state.kind).not.toBe("MAIN_MENU");
    }
  });

  it("unknown menu letters are ignored", () => {
    const { m } = build();
    enterMainMenu(m);
    m.press({ kind: "char", ch: "X" });
    expect(m.state.kind).toBe("MAIN_MENU");
  });

  it("DOWN/UP clamps within [0, 11] so a 2-row window always fits", () => {
    const { m } = build();
    enterMainMenu(m);
    for (let i = 0; i < 50; i++) m.press({ kind: "key", key: "DOWN" });
    expect(m.state).toEqual({ kind: "MAIN_MENU", topIndex: 11 }); // items 12, 13
    for (let i = 0; i < 50; i++) m.press({ kind: "key", key: "UP" });
    expect(m.state).toEqual({ kind: "MAIN_MENU", topIndex: 0 });
  });
});

describe("Power Off (menu item O)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("O prompts 'Confirm --Turn the Unit OFF (Y/N)'", () => {
    const { m, store } = build();
    toMenu(m);
    m.press({ kind: "char", ch: "O" });
    expect(m.state.kind).toBe("POWER_OFF_CONFIRM");
    expect(renderScreen(m.state, store, false)).toEqual(["Confirm --Turn the Unit OFF (Y/N)"]);
  });

  it("Y powers down and emits powerOff", () => {
    const { m } = build();
    toMenu(m);
    m.press({ kind: "char", ch: "O" });
    const effects = m.press({ kind: "key", key: "Y" });
    expect(m.state.kind).toBe("OFF");
    expect(effects).toContainEqual({ kind: "powerOff" });
  });

  it("N cancels and returns to Main Menu", () => {
    const { m } = build();
    toMenu(m);
    m.press({ kind: "char", ch: "O" });
    m.press({ kind: "key", key: "N" });
    expect(m.state.kind).toBe("MAIN_MENU");
  });
});

describe("Quiet Operation (§4.6, MANUAL p.40)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("shows '[On]' next to the active mode", () => {
    const { m, store } = build();
    toMenu(m);
    m.press({ kind: "char", ch: "Q" });
    expect(m.state.kind).toBe("QUIET_MENU");
    const screen = renderScreen(m.state, store, false);
    // MANUAL p.40: two-col layout with "Select" / "Function" indicator.
    expect(screen[0]).toBe("S - Silent Mode                   Select");
    expect(screen[1]).toBe("N - Normal Mode [On]            Function");
    expect(screen[0]!.length).toBe(40);
    expect(screen[1]!.length).toBe(40);
  });

  it("S → enables silent mode and reports the change", () => {
    const { m } = build();
    toMenu(m);
    m.press({ kind: "char", ch: "Q" });
    const effects = m.press({ kind: "char", ch: "S" });
    expect(effects).toContainEqual({ kind: "silentModeChanged", silent: true });
    expect(m.silent).toBe(true);
    expect(m.state.kind).toBe("MAIN_MENU");
  });

  it("N → disables silent mode from silent", () => {
    const { m } = build({ silent: true });
    toMenu(m);
    m.press({ kind: "char", ch: "Q" });
    const effects = m.press({ kind: "char", ch: "N" });
    expect(effects).toContainEqual({ kind: "silentModeChanged", silent: false });
    expect(m.silent).toBe(false);
  });

  it("selecting the already-active mode returns silently (no effect)", () => {
    const { m } = build();
    toMenu(m);
    m.press({ kind: "char", ch: "Q" });
    const effects: Effect[] = m.press({ kind: "char", ch: "N" });
    expect(effects).toEqual([]);
    expect(m.silent).toBe(false);
  });
});

describe("ZRO runtime path (MANUAL p.43)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("ZRO from Main Menu opens the zeroize prompt", () => {
    const { m, store } = build();
    toMenu(m);
    m.press({ kind: "key", key: "ZRO" });
    expect(m.state.kind).toBe("ZEROIZE_PROMPT");
    expect(renderScreen(m.state, store, false)).toEqual([
      "Which key is to be cleared?",
      'Enter ID# or "A" for ALL',
    ]);
  });

  it("'A' → confirm-all → Y clears every slot", () => {
    const { m, store } = build();
    store.load(1, "A", makeKeyLetters());
    store.load(5, "B", makeKeyLetters());
    toMenu(m);
    m.press({ kind: "key", key: "ZRO" });
    m.press({ kind: "char", ch: "A" });
    expect(m.state.kind).toBe("ZEROIZE_CONFIRM_ALL");
    const effects = m.press({ kind: "key", key: "Y" });
    expect(effects).toContainEqual({ kind: "zeroizedAll" });
    expect(store.peek(1)).toBeNull();
    expect(store.peek(5)).toBeNull();
  });

  it("digit 3 → per-slot confirm → Y clears only that slot", () => {
    const { m, store } = build();
    store.load(3, "KEEP3", makeKeyLetters());
    store.load(4, "KEEP4", makeKeyLetters());
    toMenu(m);
    m.press({ kind: "key", key: "ZRO" });
    m.press({ kind: "char", ch: "3" });
    expect(m.state).toEqual({ kind: "ZEROIZE_CONFIRM_ONE", slot: 3 });
    const effects = m.press({ kind: "key", key: "Y" });
    expect(effects).toContainEqual({ kind: "zeroizedSlot", slot: 3 });
    expect(store.peek(3)).toBeNull();
    expect(store.peek(4)).not.toBeNull();
  });

  it("XIT at the prompt returns to Main Menu without zeroizing", () => {
    const { m, store } = build();
    store.load(1, "SAFE", makeKeyLetters());
    toMenu(m);
    m.press({ kind: "key", key: "ZRO" });
    m.press({ kind: "key", key: "XIT" });
    expect(m.state.kind).toBe("MAIN_MENU");
    expect(store.peek(1)).not.toBeNull();
  });

  it("Zeroing . . . state ignores input and auto-advances on tick", () => {
    const { m, store } = build();
    store.load(1, "X", makeKeyLetters());
    toMenu(m);
    m.press({ kind: "key", key: "ZRO" });
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "key", key: "Y" });
    expect(m.state.kind).toBe("ZEROING");
    expect(renderScreen(m.state, store, false)).toEqual(["Zeroing . . ."]);
    // Input ignored while zeroing.
    m.press({ kind: "key", key: "ENTER" });
    expect(m.state.kind).toBe("ZEROING");
    // Tick past dwell → Key Select.
    m.press({ kind: "tick", elapsedMs: 500 });
    expect(m.state.kind).toBe("KEY_SELECT");
  });
});

describe("Malfunction auto-zeroize (MANUAL p.54)", () => {
  it("latches MALFUNCTION and clears all keys", () => {
    const { m, store } = build();
    store.load(1, "K1", makeKeyLetters());
    powerOn(m);
    const effects = m.malfunction();
    expect(m.state.kind).toBe("MALFUNCTION");
    expect(effects).toContainEqual({ kind: "zeroizedAll" });
    expect(store.peek(1)).toBeNull();
    // MALFUNCTION stays put through arbitrary input.
    m.press({ kind: "key", key: "ENTER" });
    m.press({ kind: "char", ch: "X" });
    expect(m.state.kind).toBe("MALFUNCTION");
    expect(renderScreen(m.state, store, false)).toEqual(["MALFUNCTION! DO NOT USE"]);
  });

  it("SRCH/ON from MALFUNCTION goes back to OFF", () => {
    const { m } = build();
    powerOn(m);
    m.malfunction();
    m.press({ kind: "key", key: "SRCH_ON" });
    expect(m.state.kind).toBe("OFF");
  });
});

describe("STUB fallback path", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  // All 13 main-menu letters now route to concrete sub-machines. STUB is only
  // reached on guard failures (e.g. U/A with no selected key). These cases
  // are covered in the Update Key / Authentication suites below.
  it("XIT from a STUB state returns to Main Menu", () => {
    const { m } = build();
    toMenu(m);
    // U with no selected key hits the guard → STUB.
    m.press({ kind: "char", ch: "U" });
    expect(m.state.kind).toBe("STUB");
    m.press({ kind: "key", key: "XIT" });
    expect(m.state.kind).toBe("MAIN_MENU");
  });
});

describe("Word Processor sub-machine (MANUAL pp.10–14)", () => {
  function toWp(m: Machine) {
    powerOn(m);
    m.press({ kind: "key", key: "ENTER" });
    m.press({ kind: "char", ch: "W" });
  }

  it("W opens the A/B selector with the exact manual wording", () => {
    const { m, store, buffers } = build();
    toWp(m);
    expect(m.state.kind).toBe("WP_SELECT_SLOT");
    // MANUAL p.11: message selector carries "Select" / "Message to Use" indicator.
    expect(renderScreen(m.state, store, false, buffers)).toEqual([
      "A - Message A                     Select",
      "B - Message B             Message to Use",
    ]);
  });

  it("selecting an empty slot goes straight to the empty notice, then mode select", () => {
    const { m, store, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    expect(m.state.kind).toBe("WP_EMPTY_NOTICE");
    expect(renderScreen(m.state, store, false, buffers)).toEqual([
      "Message Space Is Empty:",
      "Starting New Message:",
    ]);
    m.press({ kind: "tick", elapsedMs: 2000 });
    expect(m.state.kind).toBe("WP_MODE_SELECT");
  });

  it("selecting a non-empty slot prompts to clear", () => {
    const { m, buffers } = build();
    buffers.get("B").buffer.insertString("OLD MESSAGE");
    toWp(m);
    m.press({ kind: "char", ch: "B" });
    expect(m.state).toEqual({ kind: "WP_CLEAR_CONFIRM", slot: "B" });
  });

  it("clear confirm Y wipes the slot and re-enters the notice", () => {
    const { m, buffers } = build();
    buffers.get("A").buffer.insertString("STALE");
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "key", key: "Y" });
    expect(m.state.kind).toBe("WP_EMPTY_NOTICE");
    expect(buffers.get("A").buffer.length).toBe(0);
  });

  it("clear confirm N drops into the editor with existing contents preserved", () => {
    const { m, buffers } = build();
    buffers.get("A").buffer.insertString("KEEP ME");
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "key", key: "N" });
    expect(m.state.kind).toBe("WP_EDITOR");
    expect(buffers.get("A").buffer.toString()).toBe("KEEP ME");
  });

  it("mode select P → classification prompt → ENTER commits the classification", () => {
    const { m, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    expect(m.state.kind).toBe("WP_CLASSIFICATION");
    for (const ch of "SECRET") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "ENTER" });
    expect(m.state).toEqual({ kind: "WP_EDITOR", slot: "A", mode: "PLAIN" });
    expect(buffers.get("A").classification).toBe("SECRET");
    // MANUAL p.12: classification becomes part of the message. The editor
    // buffer is seeded with it so it is encrypted with the body and shown
    // at Review / after decrypt on the receiver.
    expect(buffers.get("A").buffer.toString()).toBe("SECRET\n");
  });

  it("non-empty classification is typed in uppercase as a header line in the editor buffer", () => {
    const { m, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    for (const ch of "TOP SECRET") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "ENTER" });
    for (const ch of "hello") m.press({ kind: "char", ch });
    expect(buffers.get("A").buffer.toString()).toBe("TOP SECRET\nHELLO");
  });

  it("classification DCH deletes the most-recent character", () => {
    const { m } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    for (const ch of "TOP") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "DCH" });
    expect((m.state as { text: string }).text).toBe("TO");
  });

  it("mode select C → editor in cipher mode, bypassing classification", () => {
    const { m, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "C" });
    expect(m.state).toEqual({ kind: "WP_EDITOR", slot: "A", mode: "CIPHER" });
    // The slot is now marked TYPED/CIPHER, so assertTransmittable denies it
    // (MANUAL p.52). Empty buffer still denies — only the origin matters.
    expect(() => buffers.assertTransmittable("A")).toThrow();
  });

  it("plain editor accepts printable chars (uppercased) and ENTER inserts newline", () => {
    const { m, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    m.press({ kind: "key", key: "ENTER" }); // empty classification committed
    for (const ch of "hello") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "ENTER" });
    m.press({ kind: "char", ch: "w" });
    expect(buffers.get("A").buffer.toString()).toBe("HELLO\nW");
  });

  it("cipher editor silently drops chars outside base32 (A-Z + 2-7)", () => {
    const { m, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "C" });
    for (const ch of "AB19C/Z2") m.press({ kind: "char", ch });
    // 1 and 9 and / are dropped; everything else survives.
    expect(buffers.get("A").buffer.toString()).toBe("ABCZ2");
  });

  it("DCH in editor deletes the last typed char", () => {
    const { m, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "C" });
    for (const ch of "HELLO") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "DCH" });
    expect(buffers.get("A").buffer.toString()).toBe("HELL");
  });

  it("SRCH in editor opens search prompt; ENTER on hit moves cursor past match and returns to editor", () => {
    const { m, store, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    m.press({ kind: "key", key: "ENTER" });
    for (const ch of "HELLO WORLD") m.press({ kind: "char", ch });
    buffers.get("A").buffer.moveBot();
    m.press({ kind: "key", key: "SRCH_ON" });
    expect(m.state.kind).toBe("WP_SEARCH");
    for (const ch of "WORLD") m.press({ kind: "char", ch });
    expect(renderScreen(m.state, store, false, buffers)).toEqual(["Search String: WORLD", ""]);
    m.press({ kind: "key", key: "ENTER" });
    expect(m.state).toEqual({ kind: "WP_EDITOR", slot: "A", mode: "PLAIN" });
    expect(buffers.get("A").buffer.cursorPosition).toBe("HELLO WORLD".length);
  });

  it("SRCH not-found shows NOT FOUND and stays in search; XIT returns to editor", () => {
    const { m, store, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    m.press({ kind: "key", key: "ENTER" });
    for (const ch of "HELLO") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "SRCH_ON" });
    for (const ch of "XYZ") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "ENTER" });
    expect(m.state.kind).toBe("WP_SEARCH");
    expect((m.state as { notFound: boolean }).notFound).toBe(true);
    expect(renderScreen(m.state, store, false, buffers)).toEqual(["Search String: XYZ", "NOT FOUND"]);
    m.press({ kind: "key", key: "XIT" });
    expect(m.state).toEqual({ kind: "WP_EDITOR", slot: "A", mode: "PLAIN" });
  });

  it("SRCH DCH trims the term and clears the not-found flag", () => {
    const { m } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    m.press({ kind: "key", key: "ENTER" });
    m.press({ kind: "key", key: "SRCH_ON" });
    for (const ch of "XY") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "ENTER" });
    expect((m.state as { notFound: boolean }).notFound).toBe(true);
    m.press({ kind: "key", key: "DCH" });
    expect(m.state).toEqual({ kind: "WP_SEARCH", slot: "A", mode: "PLAIN", term: "X", notFound: false });
  });

  it("XIT from editor shows Stored As Message A, then returns to Main Menu on tick", () => {
    const { m, store, buffers } = build();
    toWp(m);
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "C" });
    for (const ch of "ABC") m.press({ kind: "char", ch });
    m.press({ kind: "key", key: "XIT" });
    expect(m.state.kind).toBe("WP_STORED");
    expect(renderScreen(m.state, store, false, buffers)).toEqual(["Stored As Message A"]);
    m.press({ kind: "tick", elapsedMs: 2000 });
    expect(m.state.kind).toBe("MAIN_MENU");
    // Buffer contents were preserved on store.
    expect(buffers.get("A").buffer.toString()).toBe("ABC");
  });
});

describe("Encrypt/Decrypt round trip (MANUAL pp.17-20)", () => {
  function toMenuWithKey(b: ReturnType<typeof build>): void {
    b.store.load(1, "TEST", makeKeyLetters());
    powerOn(b.m);
    // ENTER on KEY_SELECT auto-selects slot 1 since it's loaded.
    b.m.press({ kind: "key", key: "ENTER" });
  }

  it("E prompt A/B → confirm key → begin → encrypting → encrypted slot", () => {
    const b = build();
    toMenuWithKey(b);
    b.buffers.get("A").buffer.insertString("HELLO WORLD");
    b.m.press({ kind: "char", ch: "E" });
    expect(b.m.state.kind).toBe("E_SELECT_SLOT");
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "E_CONFIRM_KEY", slot: "A" });
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state).toEqual({ kind: "E_BEGIN_CONFIRM", slot: "A" });
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state.kind).toBe("E_BUSY");
    const effects = b.m.press({ kind: "tick", elapsedMs: CRYPT_BUSY_MS });
    expect(effects).toContainEqual({ kind: "encrypted", slot: "A" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
    // Buffer now holds ciphertext display form (MI + grouped base32), not plaintext.
    expect(b.buffers.get("A").form).toBe("CIPHER");
    expect(b.buffers.get("A").origin).toBe("ENCRYPTED");
    expect(b.buffers.get("A").buffer.toString()).not.toBe("HELLO WORLD");
  });

  it("encrypt then decrypt the same slot round-trips to the original plaintext", () => {
    const b = build();
    toMenuWithKey(b);
    const PLAIN = "ATTACK AT DAWN";
    b.buffers.get("A").buffer.insertString(PLAIN);

    // Encrypt.
    b.m.press({ kind: "char", ch: "E" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "tick", elapsedMs: CRYPT_BUSY_MS });
    expect(b.m.state.kind).toBe("MAIN_MENU");

    // Decrypt.
    b.m.press({ kind: "char", ch: "D" });
    expect(b.m.state.kind).toBe("D_SELECT_SLOT");
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state.kind).toBe("D_BUSY");
    const effects = b.m.press({ kind: "tick", elapsedMs: CRYPT_BUSY_MS });
    expect(effects).toContainEqual({ kind: "decrypted", slot: "A" });
    expect(b.buffers.get("A").buffer.toString()).toBe(PLAIN);
    expect(b.buffers.get("A").form).toBe("PLAIN");
    expect(b.buffers.get("A").origin).toBe("DECRYPTED");
  });

  it("decrypting garbage lands in D_FAIL and emits decryptFailed", () => {
    const b = build();
    toMenuWithKey(b);
    // Plausible-looking garbage that parses as a 12-letter MI + some base32.
    b.buffers.get("B").buffer.insertString("ABCDEFGHIJKL ZZZ ZZZ ZZZ ZZZ ZZZ ZZZ ZZZ");
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "B" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "key", key: "Y" });
    const effects = b.m.press({ kind: "tick", elapsedMs: CRYPT_BUSY_MS });
    expect(effects).toContainEqual({ kind: "decryptFailed", slot: "B" });
    expect(b.m.state.kind).toBe("D_FAIL");
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("E with no key selected falls through to STUB", () => {
    // No keys loaded, no selection.
    const b = build();
    powerOn(b.m);
    b.m.press({ kind: "key", key: "ENTER" }); // KEY_SELECT → MAIN_MENU, nothing selected.
    b.m.press({ kind: "char", ch: "E" });
    // E_SELECT_SLOT is entered; A bails out without a selected key.
    expect(b.m.state.kind).toBe("E_SELECT_SLOT");
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });
});

describe("Update Key (MANUAL pp.16-17)", () => {
  function toMenuWithKey(b: ReturnType<typeof build>): void {
    b.store.load(1, "TEST", makeKeyLetters());
    powerOn(b.m);
    b.m.press({ kind: "key", key: "ENTER" });
  }

  it("U → Y → Y advances the selected slot's update level", () => {
    const b = build();
    toMenuWithKey(b);
    expect(b.store.selected()?.updateLevel).toBe(0);
    b.m.press({ kind: "char", ch: "U" });
    expect(b.m.state.kind).toBe("U_CONFIRM");
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state.kind).toBe("U_CONFIRM2");
    const effects = b.m.press({ kind: "key", key: "Y" });
    expect(effects).toContainEqual({ kind: "keyUpdated", slotId: 1, updateLevel: 1 });
    expect(b.m.state.kind).toBe("U_COMPLETE");
    b.m.press({ kind: "tick", elapsedMs: UPDATE_COMPLETE_MS });
    expect(b.m.state.kind).toBe("U_POST");
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
    expect(b.store.peek(1)?.updateLevel).toBe(1);
  });

  it("U with no selected key is stubbed (guarded at dispatch)", () => {
    const b = build();
    powerOn(b.m);
    b.m.press({ kind: "key", key: "ENTER" }); // No key loaded, none selected.
    b.m.press({ kind: "char", ch: "U" });
    expect(b.m.state).toEqual({ kind: "STUB", letter: "U", label: "Update Key" });
  });

  it("N at the first U prompt aborts back to Main Menu", () => {
    const b = build();
    toMenuWithKey(b);
    b.m.press({ kind: "char", ch: "U" });
    b.m.press({ kind: "key", key: "N" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
    expect(b.store.peek(1)?.updateLevel).toBe(0);
  });

  it("U → Y → Y on a maxed-out key shows the update-limit warning", () => {
    const b = build();
    b.store.load(1, "TEST", makeKeyLetters());
    for (let i = 0; i < 35; i++) b.store.update(1);
    expect(b.store.peek(1)?.updateLevel).toBe(35);
    powerOn(b.m);
    b.m.press({ kind: "key", key: "ENTER" });
    b.m.press({ kind: "char", ch: "U" });
    b.m.press({ kind: "key", key: "Y" });
    const effects = b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state.kind).toBe("U_MAX_REACHED");
    expect(effects).toEqual([]);
    expect(b.store.peek(1)?.updateLevel).toBe(35);
    const screen = renderScreen(b.m.state, b.store, false, b.buffers, b.clock);
    expect(screen[0]).toContain("KEY UPDATE LIMIT REACHED");
    expect(screen[1]).toContain("PRESS A KEY TO CONTINUE");
  });

  it("any key on U_MAX_REACHED returns to Main Menu", () => {
    const b = build();
    b.store.load(1, "TEST", makeKeyLetters());
    for (let i = 0; i < 35; i++) b.store.update(1);
    powerOn(b.m);
    b.m.press({ kind: "key", key: "ENTER" });
    b.m.press({ kind: "char", ch: "U" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state.kind).toBe("U_MAX_REACHED");
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });
});

describe("Authentication (MANUAL pp.40-42)", () => {
  function toMenuWithKey(b: ReturnType<typeof build>): void {
    b.store.load(1, "TEST", makeKeyLetters());
    powerOn(b.m);
    b.m.press({ kind: "key", key: "ENTER" });
  }

  it("A → Y → C generates a challenge and its reply, matching computeReply()", () => {
    const b = build();
    toMenuWithKey(b);
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state.kind).toBe("A_CONFIRM_KEY");
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state.kind).toBe("A_CHALLENGE_OR_REPLY");
    const effects = b.m.press({ kind: "char", ch: "C" });
    expect(b.m.state.kind).toBe("A_DISPLAY_CHALLENGE");
    const sent = effects.find((e) => e.kind === "authChallengeSent");
    expect(sent).toBeDefined();
    if (sent && sent.kind === "authChallengeSent") {
      const expected = computeReply(
        b.store.selected()!.currentKey,
        sent.challenge,
        b.clock.nowUtcMs(),
      );
      expect(sent.reply).toBe(expected);
    }
  });

  it("R → enter 4 letters → computes reply against the typed challenge", () => {
    const b = build();
    toMenuWithKey(b);
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "char", ch: "R" });
    expect(b.m.state).toEqual({ kind: "A_ENTER_CHALLENGE", text: "" });
    for (const ch of "XRAY") b.m.press({ kind: "char", ch });
    expect(b.m.state.kind).toBe("A_DISPLAY_REPLY");
    if (b.m.state.kind === "A_DISPLAY_REPLY") {
      const expected = computeReply(
        b.store.selected()!.currentKey,
        "XRAY",
        b.clock.nowUtcMs(),
      );
      expect(b.m.state.reply).toBe(expected);
    }
  });

  it("DCH during challenge entry erases the last letter", () => {
    const b = build();
    toMenuWithKey(b);
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "char", ch: "R" });
    for (const ch of "XR") b.m.press({ kind: "char", ch });
    b.m.press({ kind: "key", key: "DCH" });
    expect(b.m.state).toEqual({ kind: "A_ENTER_CHALLENGE", text: "X" });
  });

  it("A with no selected key is stubbed (guarded at dispatch)", () => {
    const b = build();
    powerOn(b.m);
    b.m.press({ kind: "key", key: "ENTER" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "STUB", letter: "A", label: "Authentication" });
  });
});

describe("Set Time and Date clock view (MANUAL p.44)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("S opens CLOCK_VIEW and renders the fake clock time", () => {
    const b = build({ clockMs: Date.UTC(1991, 7, 15, 12, 34, 56) });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "S" });
    expect(b.m.state.kind).toBe("CLOCK_VIEW");
    const [row1, row2] = renderScreen(b.m.state, b.store, false, b.buffers, b.clock);
    expect(row1).toBe("THU AUG 15 1991");
    expect(row2).toBe("12:34:56");
  });

  it("XIT from CLOCK_VIEW returns to Main Menu", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "S" });
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("ENTER on CLOCK_VIEW opens CLOCK_EDIT seeded with current fields", () => {
    const b = build({ clockMs: Date.UTC(2024, 2, 15, 10, 20, 30) });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "S" });
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("CLOCK_EDIT");
    if (b.m.state.kind === "CLOCK_EDIT") {
      expect(b.m.state.fields).toEqual(["03", "15", "2024", "10", "20", "30"]);
      expect(b.m.state.fieldIdx).toBe(0);
    }
  });

  it("typing 6 fields of digits commits the time and returns to CLOCK_VIEW", () => {
    const b = build({ clockMs: Date.UTC(2024, 2, 15, 10, 20, 30) });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "S" });
    b.m.press({ kind: "key", key: "ENTER" });
    // Set to 1991-08-15 12:34:56 UTC.
    for (const d of "08") b.m.press({ kind: "char", ch: d }); // MONTH
    for (const d of "15") b.m.press({ kind: "char", ch: d }); // DATE
    for (const d of "1991") b.m.press({ kind: "char", ch: d }); // YEAR
    for (const d of "12") b.m.press({ kind: "char", ch: d }); // HOUR
    for (const d of "34") b.m.press({ kind: "char", ch: d }); // MINUTE
    const effects = (() => {
      const es: Effect[] = [];
      for (const d of "56") es.push(...b.m.press({ kind: "char", ch: d })); // SECOND
      return es;
    })();
    expect(b.m.state.kind).toBe("CLOCK_VIEW");
    expect(b.clock.nowUtcMs()).toBe(Date.UTC(1991, 7, 15, 12, 34, 56));
    expect(effects.some((e) => e.kind === "timeSet")).toBe(true);
  });

  it("out-of-range values reset the current field", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "S" });
    b.m.press({ kind: "key", key: "ENTER" });
    // Month 13 is invalid; buf should reset.
    for (const d of "13") b.m.press({ kind: "char", ch: d });
    expect(b.m.state).toMatchObject({ kind: "CLOCK_EDIT", fieldIdx: 0, buf: "" });
  });

  it("XIT aborts CLOCK_EDIT without committing", () => {
    const before = Date.UTC(2024, 2, 15, 10, 20, 30);
    const b = build({ clockMs: before });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "S" });
    b.m.press({ kind: "key", key: "ENTER" });
    for (const d of "08") b.m.press({ kind: "char", ch: d });
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("CLOCK_VIEW");
    expect(b.clock.nowUtcMs()).toBe(before);
  });
});

describe("Key Change (MANUAL p.7-8)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("K → digits → name → 32 letters loads and selects the slot", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "K" });
    expect(b.m.state).toEqual({ kind: "K_PROMPT_ID", buf: "" });
    for (const d of "05") b.m.press({ kind: "char", ch: d });
    expect(b.m.state).toEqual({ kind: "K_PROMPT_NAME", slotId: 5, name: "" });
    for (const ch of "ALPHA") b.m.press({ kind: "char", ch });
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("K_ENTER_SET");
    const letters = makeKeyLetters();
    let effects: Effect[] = [];
    for (const ch of letters) {
      effects = effects.concat(b.m.press({ kind: "char", ch }));
    }
    expect(b.m.state).toEqual({ kind: "K_CONFIRM", slotId: 5 });
    expect(effects).toContainEqual({ kind: "keyLoaded", slotId: 5, name: "ALPHA" });
    expect(b.store.peek(5)?.name).toBe("ALPHA");
    expect(b.store.selected()?.id).toBe(5);
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("invalid checksum lands in K_INVALID and returns to Main Menu on tick", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "K" });
    for (const d of "03") b.m.press({ kind: "char", ch: d });
    for (const ch of "BAD") b.m.press({ kind: "char", ch });
    b.m.press({ kind: "key", key: "ENTER" });
    // 30 As (k_raw=all-zeros → real checksum 00/AA) followed by a bogus
    // "AB" checksum pair. Guaranteed invalid.
    for (let i = 0; i < 30; i++) b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "B" });
    expect(b.m.state.kind).toBe("K_INVALID");
    b.m.press({ kind: "tick", elapsedMs: KEY_INVALID_MS });
    expect(b.m.state.kind).toBe("MAIN_MENU");
    expect(b.store.peek(3)).toBeNull();
  });

  it("out-of-range ID# (17..99) re-prompts without advancing", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "K" });
    for (const d of "17") b.m.press({ kind: "char", ch: d });
    expect(b.m.state).toEqual({ kind: "K_PROMPT_ID", buf: "" });
  });

  it("DCH during letter entry rolls the set index back when crossing an 8-boundary", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "K" });
    for (const d of "01") b.m.press({ kind: "char", ch: d });
    for (const ch of "X") b.m.press({ kind: "char", ch });
    b.m.press({ kind: "key", key: "ENTER" });
    for (let i = 0; i < 8; i++) b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toMatchObject({ setIdx: 1, letters: "AAAAAAAA" });
    b.m.press({ kind: "key", key: "DCH" });
    expect(b.m.state).toMatchObject({ setIdx: 0, letters: "AAAAAAA" });
  });
});

describe("Review Message (MANUAL p.14-15)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("R → A opens the read-only viewer; UP/DOWN scroll, XIT exits", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("LINE1\nLINE2\nLINE3");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "R" });
    expect(b.m.state.kind).toBe("R_SELECT_SLOT");
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({
      kind: "R_VIEWER", slot: "A", topRow: 0, phonetic: false, tokenIndex: 0,
    });
    b.m.press({ kind: "key", key: "DOWN" });
    expect((b.m.state as { topRow: number }).topRow).toBe(1);
    b.m.press({ kind: "key", key: "UP" });
    expect((b.m.state as { topRow: number }).topRow).toBe(0);
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("Review renders the classification as the first row (MANUAL p.12)", () => {
    const b = build();
    // Simulate the classification round-trip: operator picks P mode, types
    // "SECRET", ENTER, then body. The state machine prepends the header.
    powerOn(b.m); b.m.press({ kind: "key", key: "ENTER" });
    b.m.press({ kind: "char", ch: "W" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "tick", elapsedMs: 2000 });
    b.m.press({ kind: "char", ch: "P" });
    for (const ch of "SECRET") b.m.press({ kind: "char", ch });
    b.m.press({ kind: "key", key: "ENTER" });
    for (const ch of "HELLO") b.m.press({ kind: "char", ch });
    b.m.press({ kind: "key", key: "XIT" }); // store + return to menu
    b.m.press({ kind: "tick", elapsedMs: 5000 });
    b.m.press({ kind: "char", ch: "R" });
    b.m.press({ kind: "char", ch: "A" });
    const [row1, row2] = renderScreen(b.m.state, b.store, false, b.buffers);
    expect(row1).toBe("SECRET");
    expect(row2).toBe("HELLO");
  });

  // SPEC Appendix A §1.1 "Verbal fallback" + MANUAL Appendix C.
  it("SRCH in R_VIEWER toggles phonetic readout; UP/DOWN page tokens", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("4AB NFC QWP");
    powerOn(b.m); b.m.press({ kind: "key", key: "ENTER" });
    b.m.press({ kind: "char", ch: "R" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "SRCH_ON" });
    expect(b.m.state).toEqual({
      kind: "R_VIEWER", slot: "A", topRow: 0, phonetic: true, tokenIndex: 0,
    });
    b.m.press({ kind: "key", key: "DOWN" });
    expect((b.m.state as { tokenIndex: number }).tokenIndex).toBe(1);
    b.m.press({ kind: "key", key: "DOWN" });
    b.m.press({ kind: "key", key: "DOWN" });
    expect((b.m.state as { tokenIndex: number }).tokenIndex).toBe(2);
    b.m.press({ kind: "key", key: "SRCH_ON" });
    expect((b.m.state as { phonetic: boolean }).phonetic).toBe(false);
  });
});

describe("View Angle (MANUAL p.47)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("V adjusts level with UP/DOWN and commits on ENTER", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "V" });
    expect(b.m.state).toEqual({ kind: "V_ADJUST", level: 4 });
    b.m.press({ kind: "key", key: "DOWN" });
    b.m.press({ kind: "key", key: "DOWN" });
    expect(b.m.state).toEqual({ kind: "V_ADJUST", level: 2 });
    const effects = b.m.press({ kind: "key", key: "ENTER" });
    expect(effects).toContainEqual({ kind: "viewAngleChanged", level: 2 });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  // MANUAL p.47: pressing (^) at the Key Select Menu sets the angle to
  // maximum — so ^ (UP) raises level toward VIEW_ANGLE_MAX.
  it("UP clamps at VIEW_ANGLE_MAX, DOWN clamps at 0", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "V" });
    for (let i = 0; i < 20; i++) b.m.press({ kind: "key", key: "UP" });
    expect(b.m.state).toEqual({ kind: "V_ADJUST", level: VIEW_ANGLE_MAX });
    for (let i = 0; i < 20; i++) b.m.press({ kind: "key", key: "DOWN" });
    expect(b.m.state).toEqual({ kind: "V_ADJUST", level: 0 });
  });
});

describe("Print (MANUAL p.45-46)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("P → A (plain) warns then menu → P prints → completes with `printed` effect", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("PLAINTEXT");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "P" });
    expect(b.m.state.kind).toBe("P_SELECT_SLOT");
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "P_WARN_PLAIN", slot: "A" });
    b.m.press({ kind: "key", key: "Y" });
    expect(b.m.state).toEqual({ kind: "P_MENU", slot: "A" });
    b.m.press({ kind: "char", ch: "P" });
    expect(b.m.state.kind).toBe("P_BUSY");
    const effects = b.m.press({ kind: "tick", elapsedMs: PRINT_BUSY_MS });
    expect(effects).toContainEqual({ kind: "printed", slot: "A" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("P → A (cipher) skips the plain-text warning and lands in the P menu", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("ABCDEFG");
    b.buffers.markReceived("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "P" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "P_MENU", slot: "A" });
  });

  it("XIT during printing aborts without emitting `printed`", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("PLAINTEXT");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "P" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "Y" });
    b.m.press({ kind: "char", ch: "P" });
    const effects = b.m.press({ kind: "key", key: "XIT" });
    expect(effects).toEqual([]);
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });
});

describe("Communications (MANUAL p.22-40)", () => {
  function toMenu(m: Machine) { powerOn(m); m.press({ kind: "key", key: "ENTER" }); }

  it("C → A (audio) → T (tx) → A (acoustic) → U (US lines) → A (slot A) → ENTER transmits and completes", () => {
    const b = build();
    // Mark slot A as encrypted so assertTransmittable allows it.
    b.buffers.get("A").buffer.insertString("ABCDEFGHIJKL ZZZ ZZZ");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    expect(b.m.state.kind).toBe("C_MODE_SELECT");
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_DIR_SELECT", mode: "AUDIO" });
    b.m.press({ kind: "char", ch: "T" });
    expect(b.m.state).toEqual({ kind: "C_AUDIO_SUBMODE", dir: "TX" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_ACOUSTIC_LINES", dir: "TX" });
    b.m.press({ kind: "char", ch: "U" });
    expect(b.m.state).toEqual({ kind: "C_TX_SLOT_SELECT", mode: "AUDIO" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_TX_READY", slot: "A", mode: "AUDIO" });
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("C_TX_BUSY");
    const effects = b.m.press({ kind: "tick", elapsedMs: TX_BUSY_MS });
    expect(effects).toContainEqual({
      kind: "txTransmitted",
      slot: "A",
      mode: "AUDIO",
      wire: "ABCDEFGHIJKL ZZZ ZZZ",
    });
    expect(b.m.state).toEqual({ kind: "C_TX_COMPLETE", slot: "A", mode: "AUDIO" });
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("TX with locally-typed ciphertext is rejected per MANUAL p.52", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("ABCD");
    b.buffers.markTyped("A", "CIPHER"); // TYPED+CIPHER = denied
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "C" }); // connector-audio skips the lines prompt
    b.m.press({ kind: "char", ch: "A" });
    // Rejection surfaces the warn_local_cipher screen (Appendix B p.53).
    expect(b.m.state).toEqual({ kind: "C_LOCAL_CIPHER_DENIED" });
    // Any key acknowledges the warning and returns to Main Menu.
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("audio submode screen shows Acoustic/Connector with Select/Function indicator, 40 chars", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    expect(b.m.state).toEqual({ kind: "C_AUDIO_SUBMODE", dir: "TX" });
    const [r1, r2] = renderScreen(b.m.state, b.store, false, b.buffers);
    expect(r1).toHaveLength(40);
    expect(r2).toHaveLength(40);
    expect(r1).toBe("A - Acoustic Coupler              Select");
    expect(r2).toBe("C - Connector Audio             Function");
  });

  it("acoustic lines screen shows U.S./European with Select/Function indicator, 40 chars", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_ACOUSTIC_LINES", dir: "TX" });
    const [r1, r2] = renderScreen(b.m.state, b.store, false, b.buffers);
    expect(r1).toHaveLength(40);
    expect(r2).toHaveLength(40);
    expect(r1).toBe("U - U.S. Lines                    Select");
    expect(r2).toBe("E - European Lines              Function");
  });

  it("audio submode C (connector) skips the U.S./European lines prompt on TX", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("ABCDEFGHIJKL ZZZ");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "C" });
    expect(b.m.state).toEqual({ kind: "C_TX_SLOT_SELECT", mode: "AUDIO" });
  });

  it("audio RX: T→A (acoustic) → E (euro) lands in C_RX_WAIT with AUDIO mode", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "R" });
    expect(b.m.state).toEqual({ kind: "C_AUDIO_SUBMODE", dir: "RX" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_ACOUSTIC_LINES", dir: "RX" });
    b.m.press({ kind: "char", ch: "E" });
    expect(b.m.state).toEqual({ kind: "C_RX_WAIT", mode: "AUDIO", slot: "A", active: false });
  });

  it("audio RX: connector skips the lines prompt", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "R" });
    b.m.press({ kind: "char", ch: "C" });
    expect(b.m.state).toEqual({ kind: "C_RX_WAIT", mode: "AUDIO", slot: "A", active: false });
  });

  it("XIT from C_AUDIO_SUBMODE returns to C_DIR_SELECT; XIT from C_ACOUSTIC_LINES returns to submode", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_ACOUSTIC_LINES", dir: "TX" });
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state).toEqual({ kind: "C_AUDIO_SUBMODE", dir: "TX" });
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state).toEqual({ kind: "C_DIR_SELECT", mode: "AUDIO" });
  });

  it("Silent Mode blocks Acoustic Coupler with QUIET OPERATION warning (MANUAL p.39, Appendix B p.53)", () => {
    const b = build({ silent: true });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "A" }); // Acoustic
    expect(b.m.state).toEqual({ kind: "C_AUDIO_DENIED" });
    const screen = renderScreen(b.m.state, b.store, b.m.silent);
    expect(screen[0]).toBe("QUIET OPERATION: AUDIO OUTPUT DENIED.");
    // Any key returns to Main Menu.
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("Silent Mode blocks Acoustic Coupler on RX too (MANUAL p.39)", () => {
    const b = build({ silent: true });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "R" }); // Receive
    b.m.press({ kind: "char", ch: "A" }); // Acoustic
    expect(b.m.state).toEqual({ kind: "C_AUDIO_DENIED" });
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("Silent Mode still allows Connector Audio (MANUAL p.39 Note)", () => {
    const b = build({ silent: true });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "C" }); // Connector
    expect(b.m.state).toEqual({ kind: "C_TX_SLOT_SELECT", mode: "AUDIO" });
  });

  it("Silent Mode still allows Digital Data (MANUAL p.39 Note)", () => {
    const b = build({ silent: true });
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "T" });
    expect(b.m.state).toEqual({ kind: "C_TX_SLOT_SELECT", mode: "DIGITAL" });
  });

  it("digital TX: SLOT → baud-select → Please Wait → C_TX_READY (MANUAL p.28-29)", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("HELLO");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_TX_BAUD_SELECT", slot: "A", baudIndex: 5 });
    // UP raises the baud index; DOWN lowers it; clamp at both ends.
    b.m.press({ kind: "key", key: "UP" });
    expect((b.m.state as { baudIndex: number }).baudIndex).toBe(6);
    b.m.press({ kind: "key", key: "DOWN" });
    b.m.press({ kind: "key", key: "DOWN" });
    expect((b.m.state as { baudIndex: number }).baudIndex).toBe(4);
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("C_TX_PLEASE_WAIT");
    b.m.press({ kind: "tick", elapsedMs: PLEASE_WAIT_MS });
    expect(b.m.state).toEqual({ kind: "C_TX_READY", slot: "A", mode: "DIGITAL" });
  });

  it("digital TX baud-select renders {RATE} Baud with ^ or v indicator", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("HI");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "A" });
    const [r1, r2] = renderScreen(b.m.state, b.store, false, b.buffers);
    expect(r1).toContain("1200 Baud");
    expect(r1).toContain("^ or v to Select Speed");
    expect(r2).toContain("Press ENTER at Desired Speed");
  });

  it("digital TX baud UP from 9600 lands on 19.2K label", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("HI");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "A" });
    // From default 1200, press UP 4× → 19200.
    for (let i = 0; i < 4; i++) b.m.press({ kind: "key", key: "UP" });
    expect((b.m.state as { baudIndex: number }).baudIndex).toBe(9);
    const [r1] = renderScreen(b.m.state, b.store, false, b.buffers);
    expect(r1).toContain("19.2K Baud");
    // Further UP clamps at the top.
    b.m.press({ kind: "key", key: "UP" });
    expect((b.m.state as { baudIndex: number }).baudIndex).toBe(9);
  });

  it("digital TX XIT from baud-select returns to slot select; from Please Wait aborts to Main Menu", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("HI");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state).toEqual({ kind: "C_TX_SLOT_SELECT", mode: "DIGITAL" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("C_TX_PLEASE_WAIT");
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state.kind).toBe("MAIN_MENU");
  });

  it("digital RX baud-select XIT returns to C_DIR_SELECT", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "R" });
    expect(b.m.state.kind).toBe("C_RX_BAUD_SELECT");
    b.m.press({ kind: "key", key: "XIT" });
    expect(b.m.state).toEqual({ kind: "C_DIR_SELECT", mode: "DIGITAL" });
  });

  it("audio TX still skips baud (baud is a Digital-only gate)", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("HI");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "C" }); // connector
    b.m.press({ kind: "char", ch: "A" });
    expect(b.m.state).toEqual({ kind: "C_TX_READY", slot: "A", mode: "AUDIO" });
  });

  it("digital path is unchanged by the audio sub-selectors (no submode insertion)", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "T" });
    expect(b.m.state).toEqual({ kind: "C_TX_SLOT_SELECT", mode: "DIGITAL" });
  });

  it("C → D (digital) → R → baud select → feedReceived lands bytes and completes", () => {
    const b = build();
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "D" });
    b.m.press({ kind: "char", ch: "R" });
    // MANUAL p.37: digital RX routes through the baud-rate selector.
    expect(b.m.state).toEqual({ kind: "C_RX_BAUD_SELECT", baudIndex: 5 });
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state).toEqual({ kind: "C_RX_WAIT", mode: "DIGITAL", slot: "A", active: false });
    // Host signals first byte → screen flips to "Receiving Message".
    b.m.rxCarrierDetected();
    expect(b.m.state).toEqual({ kind: "C_RX_WAIT", mode: "DIGITAL", slot: "A", active: true });
    // Second call is idempotent.
    b.m.rxCarrierDetected();
    expect((b.m.state as { active: boolean }).active).toBe(true);
    b.m.feedReceived("RECEIVED MESSAGE");
    expect(b.m.state.kind).toBe("C_RX_BUSY");
    expect(b.buffers.get("A").buffer.toString()).toBe("RECEIVED MESSAGE");
    const effects = b.m.press({ kind: "tick", elapsedMs: RX_BUSY_MS });
    expect(effects).toContainEqual({ kind: "rxReceived", slot: "A", mode: "DIGITAL" });
    expect(b.m.state).toEqual({ kind: "C_RX_COMPLETE", slot: "A", mode: "DIGITAL" });
  });

  it("C_TX_COMPLETE → ENTER retransmits the same slot", () => {
    const b = build();
    b.buffers.get("A").buffer.insertString("XYZ");
    b.buffers.markEncrypted("A");
    toMenu(b.m);
    b.m.press({ kind: "char", ch: "C" });
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "char", ch: "T" });
    b.m.press({ kind: "char", ch: "C" }); // connector-audio skips the lines prompt
    b.m.press({ kind: "char", ch: "A" });
    b.m.press({ kind: "key", key: "ENTER" });
    b.m.press({ kind: "tick", elapsedMs: TX_BUSY_MS });
    expect(b.m.state.kind).toBe("C_TX_COMPLETE");
    b.m.press({ kind: "key", key: "ENTER" });
    expect(b.m.state.kind).toBe("C_TX_BUSY");
  });
});

describe("Editor navigation keys (MANUAL p.13)", () => {
  // Enter the plain-text editor on slot A with a short payload pre-typed.
  function toEditor(payload: string): { m: Machine; buffers: DualBuffer } {
    const { m, buffers } = build();
    powerOn(m);
    m.press({ kind: "key", key: "ENTER" });
    m.press({ kind: "char", ch: "W" });
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "tick", elapsedMs: 2000 });
    m.press({ kind: "char", ch: "P" });
    // Skip the classification so navigation tests can reason about cursor
    // offsets against the literal payload, not a classification-prefixed
    // buffer (MANUAL p.12: classification becomes part of the message).
    m.press({ kind: "key", key: "ENTER" });
    for (const ch of payload) m.press({ kind: "char", ch });
    return { m, buffers };
  }

  it("LEFT and RIGHT step the cursor; clamps at bounds", () => {
    const { m, buffers } = toEditor("ABCD");
    const buf = buffers.get("A").buffer;
    expect(buf.cursorPosition).toBe(4);
    m.press({ kind: "key", key: "LEFT" });
    m.press({ kind: "key", key: "LEFT" });
    expect(buf.cursorPosition).toBe(2);
    for (let i = 0; i < 10; i++) m.press({ kind: "key", key: "LEFT" });
    expect(buf.cursorPosition).toBe(0); // clamped
    m.press({ kind: "key", key: "RIGHT" });
    expect(buf.cursorPosition).toBe(1);
  });

  it("BOT jumps to start; EOT to end", () => {
    const { m, buffers } = toEditor("HELLO WORLD");
    const buf = buffers.get("A").buffer;
    m.press({ kind: "key", key: "BOT" });
    expect(buf.cursorPosition).toBe(0);
    m.press({ kind: "key", key: "EOT" });
    expect(buf.cursorPosition).toBe(11);
  });

  it("BOL and EOL move within the current line only", () => {
    const { m, buffers } = toEditor("ABC");
    m.press({ kind: "key", key: "ENTER" }); // paragraph break
    for (const ch of "DEF") m.press({ kind: "char", ch });
    const buf = buffers.get("A").buffer;
    m.press({ kind: "key", key: "BOL" });
    expect(buf.cursorPosition).toBe(4); // right after the \n
    m.press({ kind: "key", key: "EOL" });
    expect(buf.cursorPosition).toBe(7);
  });

  it("DWD deletes the word to the right of the cursor", () => {
    const { m, buffers } = toEditor("ONE TWO THREE");
    m.press({ kind: "key", key: "BOT" });
    m.press({ kind: "key", key: "DWD" });
    expect(buffers.get("A").buffer.toString()).toBe("TWO THREE");
  });
});

describe("CLK global shortcut (MANUAL p.15)", () => {
  it("CLK from Main Menu jumps to CLOCK_VIEW; XIT returns to Main Menu", () => {
    const { m } = build();
    powerOn(m);
    m.press({ kind: "key", key: "ENTER" }); // KEY_SELECT → MAIN_MENU
    expect(m.state.kind).toBe("MAIN_MENU");
    m.press({ kind: "key", key: "CLK" });
    expect(m.state.kind).toBe("CLOCK_VIEW");
    m.press({ kind: "key", key: "XIT" });
    expect(m.state.kind).toBe("MAIN_MENU");
  });

  it("CLK is a no-op from BOOT_CONFIRM (pre-power states are blocked)", () => {
    const { m } = build();
    m.press({ kind: "key", key: "SRCH_ON" });
    expect(m.state.kind).toBe("BOOT_CONFIRM");
    m.press({ kind: "key", key: "CLK" });
    expect(m.state.kind).toBe("BOOT_CONFIRM");
  });

  it("CLK is a no-op during E_BUSY", () => {
    const { m, store, buffers } = build();
    store.load(1, "TEST", makeKeyLetters());
    powerOn(m);
    m.press({ kind: "key", key: "ENTER" });
    buffers.get("A").buffer.insertString("HELLO");
    m.press({ kind: "char", ch: "E" });
    m.press({ kind: "char", ch: "A" });
    m.press({ kind: "key", key: "Y" });
    m.press({ kind: "key", key: "Y" });
    expect(m.state.kind).toBe("E_BUSY");
    m.press({ kind: "key", key: "CLK" });
    expect(m.state.kind).toBe("E_BUSY"); // still busy, CLK ignored
  });
});
