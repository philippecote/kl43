// Unit tests for the clock-locked UART demodulator in
// [src/host/modem.ts](./modem.ts). These exercise the state-machine
// core (`createUartDemodulator`) directly against synthesized FSK, so
// we can deterministically inject drops, inserts, and noisy byte
// patterns without running an AudioContext.
//
// The contract we pin here is the one that rescues Reed–Solomon from
// channel misalignment:
//
//   - N transmitted UART bytes always yield exactly N onByte callbacks.
//   - A framing error (stop bit = space) shows up as a single
//     `(0x3F, erased=true)` callback at that byte's position.
//   - Byte patterns with internal mark→space transitions (e.g. 0xAA)
//     do NOT cause phantom insertions, because LOCKED only accepts
//     edges inside the clock-locked acceptance window.
//
// The synthesize() helper mirrors `synthesizeFSK` in modem.ts but
// writes into a plain Float32Array and lets us mutate individual
// UART frames.

import { describe, expect, it } from "vitest";
import {
  BAUD,
  BELL103_ORIGINATE,
  createUartDemodulator,
  FreqPair,
} from "./modem.js";

type Captured = { b: number; erased: boolean };

const SAMPLE_RATE = 48000;

function synthesize(opts: {
  sampleRate: number;
  pair: FreqPair;
  bytes: Uint8Array;
  /** Mark-tone samples before the first byte (bit count). */
  preBits?: number;
  /** Mark-tone samples after the last byte. */
  postBits?: number;
  /**
   * Optional per-byte override. Return an array of 10 bits (start +
   * 8 data LSB-first + stop) to send on the wire in place of the
   * standard 8-N-1 frame for this byte. Return null to emit the
   * standard frame unchanged.
   */
  mutateFrame?: (byteIdx: number, origBits: number[]) => number[] | null;
}): Float32Array {
  const sr = opts.sampleRate;
  const spb = sr / BAUD;
  const pair = opts.pair;
  const preBits = opts.preBits ?? 120; // matches a modest ~400 ms preamble
  const postBits = opts.postBits ?? 30;

  const bits: number[] = [];
  for (let i = 0; i < preBits; i++) bits.push(1);
  for (let bi = 0; bi < opts.bytes.length; bi++) {
    const b = opts.bytes[bi]!;
    const frame: number[] = [0]; // start bit
    for (let i = 0; i < 8; i++) frame.push((b >> i) & 1); // LSB first
    frame.push(1); // stop bit
    const mutated = opts.mutateFrame ? opts.mutateFrame(bi, frame) : null;
    const emit = mutated ?? frame;
    for (const x of emit) bits.push(x);
  }
  for (let i = 0; i < postBits; i++) bits.push(1);

  const total = Math.round(bits.length * spb);
  const out = new Float32Array(total);
  let phase = 0;
  let idx = 0;
  for (let bi = 0; bi < bits.length; bi++) {
    const f = bits[bi] === 1 ? pair.mark : pair.space;
    const w = (2 * Math.PI * f) / sr;
    const nextEnd = Math.round((bi + 1) * spb);
    while (idx < nextEnd && idx < total) {
      out[idx] = 0.45 * Math.sin(phase);
      phase += w;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      idx++;
    }
  }
  return out;
}

function captureAll(samples: Float32Array, pair: FreqPair = BELL103_ORIGINATE): Captured[] {
  const demod = createUartDemodulator(SAMPLE_RATE, pair);
  const out: Captured[] = [];
  demod.onByte((b, erased) => out.push({ b, erased }));
  demod.pushSamples(samples);
  return out;
}

/**
 * The LOCKED state emits up to MAX_LOCKED_MISSES (currently 2) `?` erasures
 * when the carrier is still on but no start-bit edge arrives in the
 * predicted slot — which is exactly what the transmitter's post-data mark
 * tail looks like at EOM. Real EOM is bounded (the rxSilenceTimer in the
 * host flushes the buffer), but from inside a unit test we don't have that
 * timer, so these EOM erasures surface in `rx`. Callers who only care about
 * the emitted *payload* bytes can trim them off.
 */
function stripTrailingEomErasures(rx: Captured[]): Captured[] {
  const out = rx.slice();
  while (
    out.length > 0 &&
    out[out.length - 1]!.erased &&
    out[out.length - 1]!.b === 0x3f
  ) {
    out.pop();
  }
  return out;
}

describe("createUartDemodulator — clean channel", () => {
  it("decodes a short ASCII byte stream byte-for-byte", () => {
    const bytes = new TextEncoder().encode("HELLO");
    const samples = synthesize({ sampleRate: SAMPLE_RATE, pair: BELL103_ORIGINATE, bytes });
    const rx = stripTrailingEomErasures(captureAll(samples));
    expect(rx.map((r) => r.b)).toEqual(Array.from(bytes));
    expect(rx.every((r) => !r.erased)).toBe(true);
  });

  it("handles bytes with alternating bits (0xAA / 0x55) without phantom insertions", () => {
    // 0xAA = 0b10101010 LSB-first → every data-bit boundary is a
    // mark↔space transition. The old pre-clock-lock receiver would,
    // after any framing error, latch onto one of these internal
    // transitions and emit a phantom shifted byte. With clock-lock,
    // edges outside expectedEdge are ignored.
    const bytes = new Uint8Array([0xaa, 0x55, 0xaa, 0x55, 0xaa]);
    const samples = synthesize({ sampleRate: SAMPLE_RATE, pair: BELL103_ORIGINATE, bytes });
    const rx = stripTrailingEomErasures(captureAll(samples));
    expect(rx.length).toBe(bytes.length);
    expect(rx.map((r) => r.b)).toEqual(Array.from(bytes));
  });

  it("preserves byte order across many bytes", () => {
    const bytes = new Uint8Array(40);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) & 0xff; // pseudo-random
    const samples = synthesize({ sampleRate: SAMPLE_RATE, pair: BELL103_ORIGINATE, bytes });
    const rx = stripTrailingEomErasures(captureAll(samples));
    expect(rx.map((r) => r.b)).toEqual(Array.from(bytes));
  });

  it("emits at most MAX_LOCKED_MISSES (= 2) spurious '?' erasures at EOM", () => {
    // When the transmitter stops sending data but the carrier is still up
    // (the post-data mark tail), LOCKED has no way of distinguishing "line
    // went quiet" from "byte was lost" until it's missed enough slots to
    // give up. We've capped that at MAX_LOCKED_MISSES, so real EOM
    // produces a bounded number of trailing '?' erasures and no phantom
    // 0xFF bytes.
    const bytes = new TextEncoder().encode("HELLO");
    const samples = synthesize({
      sampleRate: SAMPLE_RATE,
      pair: BELL103_ORIGINATE,
      bytes,
      postBits: 40, // plenty of time for timeouts to fire
    });
    const rx = captureAll(samples);
    const tailErasures = rx.slice(bytes.length);
    expect(tailErasures.length).toBeLessThanOrEqual(2);
    for (const t of tailErasures) {
      expect(t.erased).toBe(true);
      expect(t.b).toBe(0x3f);
    }
  });
});

describe("createUartDemodulator — dropped bytes (framing error)", () => {
  it("emits a single erasure at the correct position and stays in sync", () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45]);
    const samples = synthesize({
      sampleRate: SAMPLE_RATE,
      pair: BELL103_ORIGINATE,
      bytes,
      // Flip byte 2's stop bit to space — this is exactly what a real
      // UART framing error looks like on the wire.
      mutateFrame: (i, frame) => {
        if (i !== 2) return null;
        const m = [...frame];
        m[9] = 0;
        return m;
      },
    });
    const rx = stripTrailingEomErasures(captureAll(samples));
    expect(rx.length).toBe(bytes.length);
    expect(rx[0]).toEqual({ b: 0x41, erased: false });
    expect(rx[1]).toEqual({ b: 0x42, erased: false });
    expect(rx[2]!.erased).toBe(true);
    expect(rx[2]!.b).toBe(0x3f); // ASCII '?'
    expect(rx[3]).toEqual({ b: 0x44, erased: false });
    expect(rx[4]).toEqual({ b: 0x45, erased: false });
  });

  it("recovers from a drop when the next byte has many internal transitions", () => {
    // Regression: the bug was that after a framing error, the receiver
    // fell back to IDLE and latched onto an internal data-bit
    // transition of the *next* byte, emitting a phantom shifted byte.
    // With clock-lock, LOCKED only looks for the start-bit edge in the
    // predicted window, so this class of insertion is impossible.
    const bytes = new Uint8Array([0x41, 0xaa, 0x55, 0x42]);
    const samples = synthesize({
      sampleRate: SAMPLE_RATE,
      pair: BELL103_ORIGINATE,
      bytes,
      mutateFrame: (i, frame) => {
        if (i !== 1) return null;
        const m = [...frame];
        m[9] = 0;
        return m;
      },
    });
    const rx = stripTrailingEomErasures(captureAll(samples));
    expect(rx.length).toBe(bytes.length);
    expect(rx[0]!.b).toBe(0x41);
    expect(rx[0]!.erased).toBe(false);
    expect(rx[1]!.erased).toBe(true); // 0xAA's stop bit was space
    expect(rx[2]).toEqual({ b: 0x55, erased: false });
    expect(rx[3]).toEqual({ b: 0x42, erased: false });
  });

  it("handles two non-adjacent drops", () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
    const dropIdxs = new Set([1, 4]);
    const samples = synthesize({
      sampleRate: SAMPLE_RATE,
      pair: BELL103_ORIGINATE,
      bytes,
      mutateFrame: (i, frame) => {
        if (!dropIdxs.has(i)) return null;
        const m = [...frame];
        m[9] = 0;
        return m;
      },
    });
    const rx = stripTrailingEomErasures(captureAll(samples));
    expect(rx.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      if (dropIdxs.has(i)) {
        expect(rx[i]!.erased).toBe(true);
        expect(rx[i]!.b).toBe(0x3f);
      } else {
        expect(rx[i]!.erased).toBe(false);
        expect(rx[i]!.b).toBe(bytes[i]!);
      }
    }
  });
});

describe("createUartDemodulator — missed start bit (LOCKED timeout)", () => {
  // This second failure mode is what the user saw as "groups of 2 chars,
  // no question mark". A bit flip that turns the start bit from space to
  // mark leaves the line in mark all the way through the missed byte, so
  // DATA never enters — only LOCKED times out and notices. Before this
  // fix, LOCKED silently fell back to IDLE, the byte disappeared, and
  // everything after shifted by one base32 symbol.

  it("emits a '?' erasure at the correct position when a start bit is flipped to mark", () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45]);
    const samples = synthesize({
      sampleRate: SAMPLE_RATE,
      pair: BELL103_ORIGINATE,
      bytes,
      // Corrupt byte 2's start bit to mark → the entire frame looks like
      // mark + 8 data bits + mark, which the LOCKED state sees as "no
      // edge arrived in the expected slot" and must handle by emitting
      // an erasure and advancing the clock.
      mutateFrame: (i, frame) => {
        if (i !== 2) return null;
        const m = [...frame];
        m[0] = 1;
        // The 8 data bits of 0x43 = 0b01000011 LSB-first are
        // [1,1,0,0,0,0,1,0]. Force them all to mark so the line is
        // solid mark throughout the frame, forcing the pure
        // "timeout in LOCKED" path rather than an accidental edge
        // inside the frame.
        for (let k = 1; k <= 8; k++) m[k] = 1;
        return m;
      },
    });
    const rx = stripTrailingEomErasures(captureAll(samples));
    expect(rx.length).toBe(bytes.length);
    expect(rx[0]).toEqual({ b: 0x41, erased: false });
    expect(rx[1]).toEqual({ b: 0x42, erased: false });
    expect(rx[2]!.erased).toBe(true);
    expect(rx[2]!.b).toBe(0x3f);
    expect(rx[3]).toEqual({ b: 0x44, erased: false });
    expect(rx[4]).toEqual({ b: 0x45, erased: false });
  });

  it("emits '?' erasures for two consecutive bytes when both start bits are flipped", () => {
    // Two back-to-back missed bytes: the LOCKED state must emit an
    // erasure for each slot, advance the clock twice, and still be in
    // sync for the surviving bytes that follow. Because
    // MAX_LOCKED_MISSES = 2, this is the boundary case: exactly two
    // consecutive misses still lets the clock lock recover if the third
    // slot is a real byte.
    const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45]);
    const dropIdxs = new Set([1, 2]);
    const samples = synthesize({
      sampleRate: SAMPLE_RATE,
      pair: BELL103_ORIGINATE,
      bytes,
      mutateFrame: (i, frame) => {
        if (!dropIdxs.has(i)) return null;
        const m = [...frame];
        m[0] = 1;
        for (let k = 1; k <= 8; k++) m[k] = 1;
        return m;
      },
    });
    const rx = captureAll(samples);
    // After 2 consecutive LOCKED timeouts we give up the lock and fall
    // to IDLE. Byte 3 (0x44) will then be re-acquired cold from IDLE
    // on its start edge, which still works — just without clock-lock
    // assistance. Assert the *first three* bytes (0x41, '?', '?') are
    // present and byte 0x43's position has the erasure marker.
    expect(rx[0]).toEqual({ b: 0x41, erased: false });
    expect(rx[1]!.erased).toBe(true);
    expect(rx[1]!.b).toBe(0x3f);
    expect(rx[2]!.erased).toBe(true);
    expect(rx[2]!.b).toBe(0x3f);
    // After dropping out of LOCKED we re-acquire from IDLE on the next
    // real byte. The important contract is that NO phantom 0xFF bytes
    // show up between the '?' erasures and the real 0x44.
    const rest = rx.slice(3);
    const real = rest.filter((r) => !r.erased);
    expect(real.map((r) => r.b)).toEqual([0x44, 0x45]);
    // No 0xFF phantoms inside the post-timeout gap.
    expect(rx.every((r) => r.b !== 0xff)).toBe(true);
  });
});

describe("createUartDemodulator — statefulness across pushSamples calls", () => {
  it("produces the same output whether pushed in one block or in chunks", () => {
    const bytes = new TextEncoder().encode("STREAM TEST 12345");
    const samples = synthesize({ sampleRate: SAMPLE_RATE, pair: BELL103_ORIGINATE, bytes });

    const whole = captureAll(samples);

    const chunked = (() => {
      const demod = createUartDemodulator(SAMPLE_RATE, BELL103_ORIGINATE);
      const out: Captured[] = [];
      demod.onByte((b, erased) => out.push({ b, erased }));
      // Split into arbitrarily small blocks — the decoder must not care
      // where callback boundaries fall.
      const CHUNK = 137;
      for (let i = 0; i < samples.length; i += CHUNK) {
        demod.pushSamples(samples.subarray(i, Math.min(i + CHUNK, samples.length)));
      }
      return out;
    })();

    expect(chunked).toEqual(whole);
  });
});
