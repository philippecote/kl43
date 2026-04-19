import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { K_RAW_LENGTH } from "./KeyCodec.js";
import {
  MAX_UPDATE_LEVEL,
  UpdateLevelError,
  advanceOneStep,
  updateKey,
} from "./Updater.js";

const kRawArb = fc.uint8Array({ minLength: K_RAW_LENGTH, maxLength: K_RAW_LENGTH });

describe("updateKey", () => {
  it("at level 0 returns K_raw unchanged (new array, same bytes)", () => {
    fc.assert(
      fc.property(kRawArb, (kRaw) => {
        const derived = updateKey(kRaw, 0);
        expect(Array.from(derived)).toEqual(Array.from(kRaw));
        expect(derived).not.toBe(kRaw); // defensive copy
      }),
    );
  });

  it("is deterministic for the same (K_raw, level)", () => {
    fc.assert(
      fc.property(kRawArb, fc.integer({ min: 0, max: MAX_UPDATE_LEVEL }), (kRaw, level) => {
        const a = updateKey(kRaw, level);
        const b = updateKey(kRaw, level);
        expect(Array.from(a)).toEqual(Array.from(b));
        expect(a.length).toBe(K_RAW_LENGTH);
      }),
    );
  });

  it("produces distinct keys at adjacent non-zero levels (collision-resistant)", () => {
    fc.assert(
      fc.property(kRawArb, fc.integer({ min: 1, max: MAX_UPDATE_LEVEL - 1 }), (kRaw, level) => {
        const a = updateKey(kRaw, level);
        const b = updateKey(kRaw, level + 1);
        expect(Array.from(a)).not.toEqual(Array.from(b));
      }),
    );
  });

  it("reaches level 35 but rejects level 36", () => {
    const kRaw = new Uint8Array(K_RAW_LENGTH);
    expect(() => updateKey(kRaw, MAX_UPDATE_LEVEL)).not.toThrow();
    expect(() => updateKey(kRaw, MAX_UPDATE_LEVEL + 1)).toThrow(UpdateLevelError);
  });

  it("rejects negative or non-integer levels", () => {
    const kRaw = new Uint8Array(K_RAW_LENGTH);
    expect(() => updateKey(kRaw, -1)).toThrow(UpdateLevelError);
    expect(() => updateKey(kRaw, 1.5)).toThrow(UpdateLevelError);
    expect(() => updateKey(kRaw, Number.NaN)).toThrow(UpdateLevelError);
  });

  it("rejects wrong-length K_raw", () => {
    expect(() => updateKey(new Uint8Array(14), 1)).toThrow(RangeError);
    expect(() => updateKey(new Uint8Array(16), 1)).toThrow(RangeError);
  });

  it("fixed KAT: all-zero K_raw at level 1", () => {
    // Locks the update-chain output so a change in the HMAC salt ("KL43-
    // UPDATE-" || byte(1)) surfaces as a test failure. Generated against
    // this build; not an NSA vector.
    const kRaw = new Uint8Array(K_RAW_LENGTH);
    const derived = updateKey(kRaw, 1);
    expect(Array.from(derived).map((b) => b.toString(16).padStart(2, "0")).join("")).toMatch(
      /^[0-9a-f]{30}$/,
    );
  });
});

describe("advanceOneStep matches updateKey", () => {
  it("stepping from level N by one equals computing level N+1 from scratch", () => {
    fc.assert(
      fc.property(kRawArb, fc.integer({ min: 0, max: MAX_UPDATE_LEVEL - 1 }), (kRaw, level) => {
        const current = updateKey(kRaw, level);
        const advanced = advanceOneStep(current, level + 1);
        const fresh = updateKey(kRaw, level + 1);
        expect(Array.from(advanced)).toEqual(Array.from(fresh));
      }),
      { numRuns: 50 },
    );
  });

  it("rejects nextLevel out of (0, 35]", () => {
    const k = new Uint8Array(K_RAW_LENGTH);
    expect(() => advanceOneStep(k, 0)).toThrow(UpdateLevelError);
    expect(() => advanceOneStep(k, 36)).toThrow(UpdateLevelError);
  });
});
