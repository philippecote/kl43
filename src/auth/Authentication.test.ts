import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BUCKET_MS,
  BUCKET_WINDOW,
  CHALLENGE_LENGTH,
  InvalidChallengeError,
  InvalidReplyError,
  REPLY_LENGTH,
  bucketForTime,
  computeReply,
  generateChallenge,
  verifyReply,
} from "./Authentication.js";

function key(seed: number): Uint8Array {
  const k = new Uint8Array(16);
  let s = seed || 1;
  for (let i = 0; i < k.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    k[i] = s & 0xff;
  }
  return k;
}

const deterministicRandom = (seed: number) => (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
};

describe("generateChallenge", () => {
  it("returns exactly 4 A-Z letters", () => {
    for (let seed = 0; seed < 20; seed++) {
      const c = generateChallenge(deterministicRandom(seed));
      expect(c).toMatch(/^[A-Z]{4}$/);
      expect(c.length).toBe(CHALLENGE_LENGTH);
    }
  });

  it("rejects a random source that returns the wrong length", () => {
    expect(() => generateChallenge(() => new Uint8Array(3))).toThrow(RangeError);
  });
});

describe("bucketForTime", () => {
  it("is floor(ms / 600_000)", () => {
    expect(bucketForTime(0)).toBe(0);
    expect(bucketForTime(BUCKET_MS - 1)).toBe(0);
    expect(bucketForTime(BUCKET_MS)).toBe(1);
    expect(bucketForTime(BUCKET_MS * 10 + 123)).toBe(10);
  });

  it("rejects non-finite inputs", () => {
    expect(() => bucketForTime(Number.NaN)).toThrow(RangeError);
    expect(() => bucketForTime(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("computeReply", () => {
  it("returns exactly 4 base32 chars (A-Z + 2-7)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_700_000_000_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (t, seed) => {
          const c = generateChallenge(deterministicRandom(seed));
          const r = computeReply(key(seed), c, t);
          expect(r).toMatch(/^[A-Z2-7]{4}$/);
          expect(r.length).toBe(REPLY_LENGTH);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("is deterministic: same inputs → same output", () => {
    const k = key(42);
    const c = "ABCD";
    const t = 1_700_000_000_000;
    expect(computeReply(k, c, t)).toBe(computeReply(k, c, t));
  });

  it("changes when the bucket advances", () => {
    const k = key(42);
    const c = "ABCD";
    const t0 = BUCKET_MS * 100;
    const t1 = BUCKET_MS * 101;
    expect(computeReply(k, c, t0)).not.toBe(computeReply(k, c, t1));
  });

  it("is identical inside a single bucket", () => {
    const k = key(42);
    const c = "ABCD";
    const base = BUCKET_MS * 100;
    expect(computeReply(k, c, base)).toBe(computeReply(k, c, base + 1));
    expect(computeReply(k, c, base)).toBe(computeReply(k, c, base + BUCKET_MS - 1));
  });

  it("changes with the key", () => {
    const c = "ABCD";
    const t = BUCKET_MS * 100;
    const r1 = computeReply(key(1), c, t);
    const r2 = computeReply(key(2), c, t);
    expect(r1).not.toBe(r2);
  });

  it("changes with the challenge", () => {
    const k = key(1);
    const t = BUCKET_MS * 100;
    expect(computeReply(k, "ABCD", t)).not.toBe(computeReply(k, "DCBA", t));
  });
});

describe("verifyReply", () => {
  const k = key(99);
  const c = "MIKE";
  const baseBucket = 100_000;
  const t = baseBucket * BUCKET_MS + 123;
  const reply = computeReply(k, c, t);

  it("accepts with offset 0 when clocks are in the same bucket", () => {
    expect(verifyReply(k, c, reply, t)).toEqual({ offset: 0 });
  });

  it("accepts ±1 bucket drift (~10 minutes)", () => {
    expect(verifyReply(k, c, reply, t - BUCKET_MS)).toEqual({ offset: 1 });
    expect(verifyReply(k, c, reply, t + BUCKET_MS)).toEqual({ offset: -1 });
  });

  it("accepts ±2 bucket drift (~20 minutes)", () => {
    expect(verifyReply(k, c, reply, t - 2 * BUCKET_MS)).toEqual({ offset: 2 });
    expect(verifyReply(k, c, reply, t + 2 * BUCKET_MS)).toEqual({ offset: -2 });
  });

  it("rejects ±3 bucket drift (outside the 20-minute window)", () => {
    expect(verifyReply(k, c, reply, t + (BUCKET_WINDOW + 1) * BUCKET_MS)).toBeNull();
    expect(verifyReply(k, c, reply, t - (BUCKET_WINDOW + 1) * BUCKET_MS)).toBeNull();
  });

  it("rejects a wrong reply", () => {
    expect(verifyReply(k, c, "AAAA", t)).toBeNull();
  });

  it("rejects a reply computed under a different key", () => {
    const other = computeReply(key(111), c, t);
    expect(verifyReply(k, c, other, t)).toBeNull();
  });

  it("rejects a reply to a different challenge", () => {
    const wrongChallenge = computeReply(k, "OTHR", t);
    expect(verifyReply(k, c, wrongChallenge, t)).toBeNull();
  });

  it("validates input shapes", () => {
    expect(() => verifyReply(k, "ABC", "WXYZ", t)).toThrow(InvalidChallengeError);
    expect(() => verifyReply(k, "abcd", "WXYZ", t)).toThrow(InvalidChallengeError);
    expect(() => verifyReply(k, "ABCD", "WXY", t)).toThrow(InvalidReplyError);
    // '1' is not in the base32 alphabet (A-Z + 2-7).
    expect(() => verifyReply(k, "ABCD", "WXY1", t)).toThrow(InvalidReplyError);
  });

  it("is case-insensitive on the reply", () => {
    expect(verifyReply(k, c, reply.toLowerCase(), t)).toEqual({ offset: 0 });
  });
});

describe("challenger ↔ replier handshake", () => {
  it("round-trips over realistic clock drift", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: -BUCKET_MS * 2, max: BUCKET_MS * 2 }),
        (keySeed, challengeSeed, driftMs) => {
          const k = key(keySeed);
          const challenge = generateChallenge(deterministicRandom(challengeSeed));
          // The challenger generates challenge + expected reply at its time.
          const challengerNow = 1_700_000_000_000;
          const expected = computeReply(k, challenge, challengerNow);
          // The replier's clock is drifted by up to ±20 minutes.
          const replierNow = challengerNow + driftMs;
          const replierReply = computeReply(k, challenge, replierNow);
          // Challenger verifies against its own clock.
          const result = verifyReply(k, challenge, replierReply, challengerNow);
          // Within ±20 min: accept. Exactly at the boundary (20m:00s) the
          // bucket offset may be 2 or 3 depending on alignment; property
          // guarantees only that ≤2-bucket drift is always accepted.
          const driftBuckets = Math.abs(
            Math.floor(replierNow / BUCKET_MS) - Math.floor(challengerNow / BUCKET_MS),
          );
          if (driftBuckets <= BUCKET_WINDOW) {
            expect(result).not.toBeNull();
            expect(Math.abs(result!.offset)).toBeLessThanOrEqual(BUCKET_WINDOW);
          }
          // Reference: reply matches expected when drift is within one
          // bucket of the challenger, modulo bucket boundaries.
          void expected;
        },
      ),
      { numRuns: 30 },
    );
  });
});
