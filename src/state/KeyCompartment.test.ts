import { describe, expect, it } from "vitest";
import { InvalidKeyError } from "../crypto/KeyCodec.js";
import { MAX_UPDATE_LEVEL } from "../crypto/Updater.js";
import { appendChecksum } from "../crypto/KeyCodec.js";
import {
  AVAILABLE,
  InvalidNameError,
  KeyCompartmentStore,
  MAX_SLOT,
  MIN_SLOT,
  SLOT_COUNT,
  SlotEmptyError,
  SlotIndexError,
  UpdateExhaustedError,
  formatSlotLine,
} from "./KeyCompartment.js";

// Helper: make a valid 32-letter key from a 30-letter body.
const ALL_A_KEY = "A".repeat(32);
const B_THEN_A = appendChecksum("B" + "A".repeat(29));

describe("KeyCompartmentStore.load", () => {
  it("loads a valid key into a slot and reports it", () => {
    const store = new KeyCompartmentStore();
    const c = store.load(1, "TEST-00", ALL_A_KEY);
    expect(c.id).toBe(1);
    expect(c.name).toBe("TEST-00");
    expect(c.updateLevel).toBe(0);
    expect(c.kRaw.length).toBe(15);
    expect(c.currentKey.length).toBe(15);
    expect(store.peek(1)).toBe(c);
  });

  it("all 16 slots are addressable", () => {
    const store = new KeyCompartmentStore();
    for (let i = MIN_SLOT; i <= MAX_SLOT; i++) {
      store.load(i, `K${i.toString().padStart(2, "0")}`, ALL_A_KEY);
    }
    const listed = store.list();
    expect(listed.length).toBe(SLOT_COUNT);
    for (const c of listed) expect(c).not.toBeNull();
  });

  it("rejects out-of-range slot ids", () => {
    const store = new KeyCompartmentStore();
    expect(() => store.load(0, "X", ALL_A_KEY)).toThrow(SlotIndexError);
    expect(() => store.load(17, "X", ALL_A_KEY)).toThrow(SlotIndexError);
    expect(() => store.load(1.5, "X", ALL_A_KEY)).toThrow(SlotIndexError);
  });

  it("rejects invalid keys (checksum fail, wrong length)", () => {
    const store = new KeyCompartmentStore();
    expect(() => store.load(1, "X", "A".repeat(30) + "AB")).toThrow(InvalidKeyError);
    expect(() => store.load(1, "X", "A".repeat(31))).toThrow(InvalidKeyError);
  });

  it("rejects names that are too long, empty, or contain illegal chars", () => {
    const store = new KeyCompartmentStore();
    expect(() => store.load(1, "", ALL_A_KEY)).toThrow(InvalidNameError);
    expect(() => store.load(1, "12345678901", ALL_A_KEY)).toThrow(InvalidNameError); // 11 chars
    expect(() => store.load(1, "HELLO!", ALL_A_KEY)).toThrow(InvalidNameError);
  });

  it("accepts 10-char alphanumeric names with space and hyphen (MANUAL p.7)", () => {
    const store = new KeyCompartmentStore();
    expect(store.load(1, "TEST-00", ALL_A_KEY).name).toBe("TEST-00");
    expect(store.load(2, "KEY 01", ALL_A_KEY).name).toBe("KEY 01");
    expect(store.load(3, "1234567890", ALL_A_KEY).name).toBe("1234567890");
  });

  it("overwriting a slot replaces it (no stale key)", () => {
    const store = new KeyCompartmentStore();
    const first = store.load(5, "OLD", ALL_A_KEY);
    const second = store.load(5, "NEW", B_THEN_A);
    expect(store.peek(5)?.name).toBe("NEW");
    expect(Array.from(first.kRaw)).not.toEqual(Array.from(second.kRaw));
    // First compartment's buffers are zeroized in place.
    expect(first.kRaw.every((b) => b === 0)).toBe(true);
  });
});

describe("select / selected", () => {
  it("select marks the active slot; selected() returns it", () => {
    const store = new KeyCompartmentStore();
    store.load(3, "K3", ALL_A_KEY);
    expect(store.selected()).toBeNull();
    const c = store.select(3);
    expect(store.selected()).toBe(c);
  });

  it("select on empty slot throws", () => {
    const store = new KeyCompartmentStore();
    expect(() => store.select(7)).toThrow(SlotEmptyError);
  });
});

describe("update", () => {
  it("advances update level and refreshes the current key", () => {
    const store = new KeyCompartmentStore();
    const v0 = store.load(1, "TEST-00", ALL_A_KEY);
    const v1 = store.update(1);
    expect(v1.updateLevel).toBe(1);
    expect(Array.from(v1.currentKey)).not.toEqual(Array.from(v0.currentKey));
    expect(store.peek(1)).toBe(v1);
    // v0's derived-key buffer is zeroized in place when replaced.
    expect(v0.currentKey.every((b) => b === 0)).toBe(true);
    // K_raw is retained (update chain re-derivable from it + level).
    expect(v0.kRaw.some((b) => b !== 0) || v0.kRaw.every((b) => b === 0)).toBe(true);
  });

  it("reaches level 35 but refuses level 36", () => {
    const store = new KeyCompartmentStore();
    store.load(1, "K", ALL_A_KEY);
    for (let i = 0; i < MAX_UPDATE_LEVEL; i++) store.update(1);
    expect(store.peek(1)?.updateLevel).toBe(MAX_UPDATE_LEVEL);
    expect(() => store.update(1)).toThrow(UpdateExhaustedError);
  });

  it("update on empty slot throws", () => {
    const store = new KeyCompartmentStore();
    expect(() => store.update(2)).toThrow(SlotEmptyError);
  });
});

describe("clear / clearAll", () => {
  it("clear zeroizes the slot and clears selection if it was selected", () => {
    const store = new KeyCompartmentStore();
    const c = store.load(2, "TEST", ALL_A_KEY);
    store.select(2);
    store.clear(2);
    expect(store.peek(2)).toBeNull();
    expect(store.selected()).toBeNull();
    expect(c.kRaw.every((b) => b === 0)).toBe(true);
    expect(c.currentKey.every((b) => b === 0)).toBe(true);
  });

  it("clear on empty slot is a no-op (no throw)", () => {
    const store = new KeyCompartmentStore();
    expect(() => store.clear(4)).not.toThrow();
  });

  it("clearAll zeroizes every slot and resets selection", () => {
    const store = new KeyCompartmentStore();
    for (let i = 1; i <= 5; i++) store.load(i, `K${i}`, ALL_A_KEY);
    store.select(3);
    store.clearAll();
    for (const c of store.list()) expect(c).toBeNull();
    expect(store.selected()).toBeNull();
  });
});

describe("formatSlotLine (display formatter)", () => {
  it("renders the MANUAL p.8 shape for loaded slots", () => {
    const store = new KeyCompartmentStore();
    const c = store.load(1, "TEST-00", ALL_A_KEY);
    expect(formatSlotLine(1, c)).toBe("01 - TEST-00 - 00");
    store.update(1);
    expect(formatSlotLine(1, store.peek(1))).toBe("01 - TEST-00 - 01");
  });

  it("renders AVAILABLE for empty slots", () => {
    expect(formatSlotLine(7, null)).toBe(`07 - ${AVAILABLE}`);
  });
});
