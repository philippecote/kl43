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

describe("createUartDemodulator — clean channel", () => {
  it("decodes a short ASCII byte stream byte-for-byte", () => {
    const bytes = new TextEncoder().encode("HELLO");
    const samples = synthesize({ sampleRate: SAMPLE_RATE, pair: BELL103_ORIGINATE, bytes });
    const rx = captureAll(samples);
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
    const rx = captureAll(samples);
    expect(rx.length).toBe(bytes.length);
    expect(rx.map((r) => r.b)).toEqual(Array.from(bytes));
  });

  it("preserves byte order across many bytes", () => {
    const bytes = new Uint8Array(40);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) & 0xff; // pseudo-random
    const samples = synthesize({ sampleRate: SAMPLE_RATE, pair: BELL103_ORIGINATE, bytes });
    const rx = captureAll(samples);
    expect(rx.map((r) => r.b)).toEqual(Array.from(bytes));
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
    const rx = captureAll(samples);
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
    const rx = captureAll(samples);
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
    const rx = captureAll(samples);
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
