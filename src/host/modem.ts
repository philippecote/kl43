// Bell 103 FSK modem — faithful to the KL-43C's built-in acoustic coupler
// (National MM74HC943, 300 baud, Bell 103-compatible) described in
// KL43_emulator_spec.md §7.1.
//
// Async framing: 8-N-1 (1 start bit = 0/space, 8 data bits LSB-first, 1 stop
// bit = 1/mark). Idle line = continuous mark.
//
// Tx: synthesize a continuous-phase FSK waveform into an AudioBuffer and
// play it through the shared AudioContext. Continuous phase avoids clicks
// at bit boundaries and keeps the demodulator happy.
//
// Rx: tap the microphone via getUserMedia, run a pair of Goertzel filters
// (mark/space), slice bits at centre-of-bit via a simple UART state machine.
// ScriptProcessorNode is used (deprecated but widely supported) for sample
// streaming — AudioWorklet would need a separate module file and the
// detection math is light enough for the main thread.

import { getAudioContext } from "./audio.js";

export type FreqPair = { mark: number; space: number };

// Live-tunable receiver gate config. Sliders in the Modem settings dialog
// (see topbar.ts) write directly into this object; `startReceiver` reads
// the current values on every sample, so changes take effect instantly
// without restarting the mic.
export type ModemConfig = {
  /** Tone bin must dominate the other by this ratio under the main gate. */
  binRatio: number;
  /** Bin ratio that bypasses the SNR requirement (clear tone in the quiet). */
  strongBinRatio: number;
  /** Window energy must exceed noise floor * this factor. */
  snrFactor: number;
  /** Minimum absolute window energy (times winSize) to even consider. */
  absEnergyScale: number;
  /** Milliseconds of continuous mark preamble before data. */
  preambleMs: number;
};

// Defaults tuned from real iPhone-speaker → MacBook-mic coupling in a
// typical (not silent) living room. Acquisition is very permissive; the
// UART framing + start-bit mid-point validation do most of the work of
// rejecting ambient noise in practice.
export const MODEM_DEFAULTS: ModemConfig = {
  binRatio: 1.05,
  strongBinRatio: 3.0,
  snrFactor: 1.1,
  absEnergyScale: 1e-6,
  preambleMs: 400,
};

export const modemConfig: ModemConfig = { ...MODEM_DEFAULTS };

// Per MANUAL / spec §7.1. Originate used by whichever side transmits first.
export const BELL103_ORIGINATE: FreqPair = { mark: 1270, space: 1070 };
export const BELL103_ANSWER: FreqPair = { mark: 2225, space: 2025 };

export const BAUD = 300;

function byteToFrame(b: number): number[] {
  const out: number[] = [0]; // start bit = space
  for (let i = 0; i < 8; i++) out.push((b >> i) & 1); // LSB first
  out.push(1); // stop bit = mark
  return out;
}

function synthesizeFSK(bytes: Uint8Array, pair: FreqPair, ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const spb = sr / BAUD;
  const bits: number[] = [];
  // Configurable mark preamble so the receiver's ambient-noise EWMA has a
  // chance to stop tracking upward as soon as the tone arrives, and so an
  // operator hitting RX slightly late still catches the first data byte.
  const preBits = Math.ceil((BAUD * modemConfig.preambleMs) / 1000);
  const postBits = Math.ceil(BAUD * 0.1);
  for (let i = 0; i < preBits; i++) bits.push(1);
  for (const b of bytes) for (const x of byteToFrame(b)) bits.push(x);
  for (let i = 0; i < postBits; i++) bits.push(1);

  const total = Math.round(bits.length * spb);
  const buf = ctx.createBuffer(1, total, sr);
  const d = buf.getChannelData(0);
  let phase = 0;
  let idx = 0;
  for (let bi = 0; bi < bits.length; bi++) {
    const f = bits[bi] === 1 ? pair.mark : pair.space;
    const w = (2 * Math.PI * f) / sr;
    const nextEnd = Math.round((bi + 1) * spb);
    while (idx < nextEnd && idx < total) {
      d[idx] = 0.45 * Math.sin(phase);
      phase += w;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      idx++;
    }
  }
  return buf;
}

/**
 * Handle for an in-flight transmission. `done` resolves when the underlying
 * BufferSource naturally ends OR when `stop()` aborts it. `stop()` is
 * idempotent and safe to call after natural completion.
 */
export type TransmitHandle = {
  stop(): void;
  readonly done: Promise<void>;
};

export function transmitText(
  text: string,
  pair: FreqPair = BELL103_ORIGINATE,
): TransmitHandle {
  return transmitTextTo(text, pair, null);
}

/**
 * Transmit FSK audio, optionally routing into a custom destination node
 * (plus the main output) instead of just the speakers. Used by the pair
 * demo so station-A's transmit feeds station-B's receiver directly via a
 * shared AudioContext node.
 *
 * Returns a TransmitHandle synchronously: the caller can await `handle.done`
 * for completion, but can also call `handle.stop()` to abort the tone
 * mid-stream. This is how pressing XIT during a long FEC-protected TX
 * actually silences the modem — without it, the `AudioBufferSourceNode`
 * would play to completion regardless of what the state machine did.
 */
export function transmitTextTo(
  text: string,
  pair: FreqPair,
  extraDestination: AudioNode | null,
): TransmitHandle {
  const ctx = getAudioContext();
  if (!ctx) throw new Error("No AudioContext");
  // The AudioContext may be suspended (autoplay policy) — resume is async
  // but we still want to return the handle synchronously, so we kick off
  // the chain and let the caller await `done` if they need completion.
  let stopped = false;
  let src: AudioBufferSourceNode | null = null;
  const done: Promise<void> = (async () => {
    if (ctx.state === "suspended") await ctx.resume();
    if (stopped) return;
    const bytes = new TextEncoder().encode(text);
    const buf = synthesizeFSK(bytes, pair, ctx);
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    if (extraDestination) src.connect(extraDestination);
    await new Promise<void>((resolve) => {
      src!.onended = () => resolve();
      src!.start();
    });
  })();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      // src may be null if stop() is called before the async init finished;
      // the `stopped` flag ensures the init path returns before creating
      // the BufferSource.
      if (src) {
        try { src.onended = null; src.stop(); src.disconnect(); }
        catch { /* already stopped or disconnected */ }
      }
    },
    done,
  };
}

// ---------------------------------------------------------------------------
// Receiver

export type ReceiverHandle = {
  stop(): void;
  /**
   * Register a callback for each decoded byte. The second argument is
   * `erased`: true means the receiver's bit-clock expected a byte at this
   * position on the stream but the UART framing failed (no valid stop
   * bit) OR no start-bit edge arrived within the clock-lock tolerance
   * window. The byte value is ASCII `?` (0x3F) in that case, chosen so
   * the operator sees a literal `?` in Review at the exact position of
   * the lost byte. Downstream (Base32 receive-side filter) converts the
   * `?` to a zero-bit base32 symbol so the codeword alignment is
   * preserved for Reed–Solomon — an erasure is a single position-known
   * substitution, which RS handles within its per-codeword budget.
   */
  onByte: (cb: (b: number, erased: boolean) => void) => void;
};

// URL flag ?debug=modem dumps per-detection stats (throttled) so we can see
// what the gate is seeing in real deployments.
const DEBUG_MODEM =
  typeof location !== "undefined" && /[?&]debug=modem\b/.test(location.search);

export async function startReceiver(
  pair: FreqPair = BELL103_ORIGINATE,
): Promise<ReceiverHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Vendor-prefixed duplicates: some iOS / Chromium builds only honour
      // one spelling. Harmless where unsupported.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(({ googEchoCancellation: false, googNoiseSuppression: false, googAutoGainControl: false, googHighpassFilter: false } as any)),
    },
  });
  const ctx = getAudioContext();
  if (!ctx) throw new Error("No AudioContext");
  if (ctx.state === "suspended") await ctx.resume();

  const src = ctx.createMediaStreamSource(stream);
  const stopStream = () => stream.getTracks().forEach((t) => t.stop());
  return attachReceiver(ctx, src, pair, stopStream);
}

/**
 * Run the FSK demodulator against an arbitrary AudioNode source instead of
 * the microphone. Used by the pair demo: station B taps station A's TX
 * bus directly, skipping the acoustic coupling and mic/speaker layer.
 *
 * The caller owns the upstream node and is responsible for disconnecting
 * anything it wired in. `stop()` on the returned handle only tears down
 * the internal Goertzel graph.
 */
export function startReceiverFromNode(
  source: AudioNode,
  pair: FreqPair = BELL103_ORIGINATE,
): ReceiverHandle {
  const ctx = source.context as AudioContext;
  return attachReceiver(ctx, source, pair, () => {});
}

/**
 * Pure UART/FSK demodulator: same logic as the live receiver, but no
 * AudioContext, no ScriptProcessorNode, no mic. Given a sample rate and
 * the Bell 103 tone pair, accepts blocks of Float32 audio samples and
 * emits `(byte, erased)` callbacks as each UART frame is decoded. Used
 * by [src/host/modem.test.ts](src/host/modem.test.ts) to exercise the
 * clock-locked state machine against synthesized FSK with deliberately
 * injected drops and inserts.
 *
 * The object exposes a minimal surface — `pushSamples()` + `onByte()` —
 * and is stateful: it buffers samples internally (via the Goertzel ring
 * buffer) and holds the UART state across calls. Push as many or as few
 * samples as you want per call; the decoder doesn't care about buffer
 * boundaries.
 */
export type UartDemodulator = {
  pushSamples(samples: Float32Array | ArrayLike<number>): void;
  onByte(cb: (b: number, erased: boolean) => void): void;
};

export function createUartDemodulator(
  sampleRate: number,
  pair: FreqPair,
): UartDemodulator {
  const { pushSamples, setOnByte } = buildDemodCore(sampleRate, pair);
  return {
    pushSamples,
    onByte: setOnByte,
  };
}

function attachReceiver(
  ctx: AudioContext,
  src: AudioNode,
  pair: FreqPair,
  onStop: () => void,
): ReceiverHandle {
  // ScriptProcessorNode is deprecated but reliable for this use.
  const bufSize = 1024;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (ctx as any).createScriptProcessor(bufSize, 1, 1) as ScriptProcessorNode;
  // Route through a zero-gain node to keep the graph alive without routing
  // mic audio to the speakers (avoids feedback).
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const core = buildDemodCore(ctx.sampleRate, pair);

  proc.onaudioprocess = (e: AudioProcessingEvent) => {
    core.pushSamples(e.inputBuffer.getChannelData(0));
  };

  src.connect(proc).connect(mute).connect(ctx.destination);

  return {
    stop: () => {
      try {
        src.disconnect();
        proc.disconnect();
        mute.disconnect();
      } catch { /* ignore */ }
      onStop();
    },
    onByte: (cb) => core.setOnByte(cb),
  };
}

/**
 * Shared body of the demodulator used by both the live AudioContext
 * path (`attachReceiver`) and the headless test path
 * (`createUartDemodulator`). Returns closures bound to a single
 * receiver's state; callers decide how to feed samples in.
 */
function buildDemodCore(
  sampleRate: number,
  pair: FreqPair,
): {
  pushSamples(input: Float32Array | ArrayLike<number>): void;
  setOnByte(cb: (b: number, erased: boolean) => void): void;
} {
  const sr = sampleRate;
  const spb = sr / BAUD;
  // Full bit-period window = ~3.5 cycles of the 1070 Hz tone at 48 kHz,
  // which is enough for the Goertzel to discriminate mark vs. space cleanly.
  // A 0.6-bit window was too narrow and the 200 Hz separation between
  // tones was getting smeared, causing bit errors.
  const winSize = Math.max(16, Math.round(spb));
  const halfWin = Math.floor(winSize / 2);
  const ringLen = Math.ceil(spb * 16);
  const ring = new Float32Array(ringLen);
  let head = 0; // monotonically increasing write index

  // Returns { bin, energy } where energy is the window's total sample energy
  // (sum of squares). We use that for a signal-presence gate so ambient room
  // noise doesn't get decoded as random bits.
  const goertzelAt = (centerIdx: number, freq: number): number => {
    const start = centerIdx - halfWin;
    const w = (2 * Math.PI * freq) / sr;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < winSize; i++) {
      const idx = ((start + i) % ringLen + ringLen) % ringLen;
      const s = ring[idx]! + coeff * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  };

  const windowEnergy = (centerIdx: number): number => {
    const start = centerIdx - halfWin;
    let sum = 0;
    for (let i = 0; i < winSize; i++) {
      const idx = ((start + i) % ringLen + ringLen) % ringLen;
      const s = ring[idx]!;
      sum += s * s;
    }
    return sum;
  };

  // Rolling estimate of the ambient noise floor (window-energy units),
  // slow-tracked while we're idle. We gate detection on being well above it.
  let noiseFloor = 0;
  // Minimum absolute energy needed to even consider the window as carrier —
  // this is a floor even in a dead-quiet room so electronic hiss doesn't
  // produce bits. Empirically ~winSize × 1e-5 on a ±1 float PCM signal is
  // well below real carrier and well above a quiet mic.
  // Thresholds are read from `modemConfig` on every call so the settings
  // dialog can change them without restarting the mic.
  const absFloor = () => winSize * modemConfig.absEnergyScale;

  type Detection = { bit: 0 | 1; ok: boolean };
  const detectAt = (centerIdx: number): Detection => {
    const em = goertzelAt(centerIdx, pair.mark);
    const es = goertzelAt(centerIdx, pair.space);
    const energy = windowEnergy(centerIdx);
    const big = em > es ? em : es;
    const small = em > es ? es : em;
    const bit: 0 | 1 = em > es ? 1 : 0;
    if (energy <= absFloor()) return { bit, ok: false };
    const strong = energy > noiseFloor * modemConfig.snrFactor;
    const dominant = big > small * modemConfig.binRatio;
    const veryDominant = big > small * modemConfig.strongBinRatio;
    // Accept if: (energy above SNR floor AND bins separable) OR
    // (tone is clearly one frequency even without much SNR headroom).
    return { bit, ok: (strong && dominant) || veryDominant };
  };

  // Narrow-window detect: a short window centred tightly, used for finding
  // the precise mark→space edge once we've seen a coarse transition.
  const narrowHalf = Math.max(4, Math.floor(spb / 8));
  const narrowSize = narrowHalf * 2;
  const detectNarrow = (centerIdx: number): 0 | 1 => {
    const start = centerIdx - narrowHalf;
    const compute = (freq: number) => {
      const w = (2 * Math.PI * freq) / sr;
      const coeff = 2 * Math.cos(w);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < narrowSize; i++) {
        const idx = ((start + i) % ringLen + ringLen) % ringLen;
        const s = ring[idx]! + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      return s1 * s1 + s2 * s2 - coeff * s1 * s2;
    };
    return compute(pair.mark) > compute(pair.space) ? 1 : 0;
  };

  // The receiver is a three-state machine:
  //   IDLE   — no lock. Coarse-scanning for the first mark→space edge.
  //   DATA   — locked to a byte; sampling the 10 bits of an 8-N-1 frame.
  //   LOCKED — between bytes, bit-clock locked to lastStartEdge. Waiting
  //            for the NEXT byte's start-bit edge at the predicted sample
  //            position expectedEdge = lastStartEdge + 10*spb.
  //
  // LOCKED is what makes the receiver robust to single-byte drops and
  // noise-triggered phantom insertions. Before the clock lock was added,
  // a UART framing error (stop bit not mark) silently dropped the byte
  // and returned to IDLE, where the coarse scanner would often latch onto
  // an internal data-bit transition of the NEXT byte and emit a phantom
  // shifted byte. Either way, the byte stream shifted by one and every
  // subsequent byte landed at the wrong offset — catastrophic for
  // Reed–Solomon, which corrects substitutions but not insertions or
  // deletions. Now:
  //   - framing error → emit erasure byte (ASCII '?', 0x3F) at the
  //     correct position, enter LOCKED aligned with the transmitter's
  //     byte clock, accept the next byte at its predicted edge;
  //   - noise-triggered false transitions between bytes are simply
  //     ignored because LOCKED only accepts edges inside a narrow window
  //     around expectedEdge.
  // The downstream base32 decode path (filterToBase32PreservingErasures)
  // substitutes '?' with the zero-bit base32 symbol so codeword byte
  // alignment is preserved for RS.
  type State = "IDLE" | "DATA" | "LOCKED";
  let state: State = "IDLE";
  let bitIdx = 0;
  let byteAccum = 0;
  let nextTarget = 0; // sample index at which to sample next bit
  let lastIdle: 0 | 1 = 1;
  // Sample index of the current (or most recent) byte's start-bit edge,
  // i.e. the sample where the line fell from mark to space. Used in
  // LOCKED to predict the next byte's edge.
  let lastStartEdge = 0;
  // Predicted sample index of the next byte's start-bit edge.
  let expectedEdge = 0;
  // Previous sample's bit value in LOCKED, for transition detection.
  let lockedLastBit: 0 | 1 = 1;
  // Whether LOCKED should re-sync by hunting for the mark→space
  // transition of the next byte's start bit, or by trusting the bit
  // clock directly. Set to `true` after a clean byte (stop bit = mark,
  // so line is mark between bytes → a real edge appears at the next
  // start bit), and `false` after a framing-error erasure (stop bit =
  // space, so line is continuously space through the erased stop bit
  // and into the next start bit → no mark→space edge exists at
  // expectedEdge; walk-back would latch on the wrong transition and
  // misalign the whole next byte). In clock-only mode we bypass edge
  // detection and simply re-enter DATA with nextTarget aligned to
  // expectedEdge + 0.5*spb.
  let lockedNeedsEdge = true;
  const scanStep = Math.max(1, Math.round(spb / 16));

  // Acceptance window around expectedEdge in LOCKED. EARLY covers small
  // transmitter/receiver clock jitter; LATE covers the detection lag from
  // the Goertzel window needing ~half a bit of space-phase samples before
  // it reports "we're in space". If no edge appears by expectedEdge +
  // LATE_TOLERANCE, we relinquish the clock lock — either the stream
  // ended (normal EOM) or the line degraded beyond resync; the
  // rxSilenceTimer upstream still flushes the buffer.
  const EARLY_TOLERANCE_SAMPLES = Math.round(spb * 0.5);
  const LATE_TOLERANCE_SAMPLES = Math.round(spb * 3);
  // detectAt's Goertzel window is spb samples wide, so it doesn't
  // reliably show "space" until the window is mostly past the edge
  // (centerIdx ≈ edge + halfWin). The walk-back in LOCKED therefore has
  // to cover a potentially longer span than the IDLE one — up to
  // halfWin + one scanStep + narrowHalf to be safe.
  const LOCKED_WALKBACK = halfWin + scanStep + narrowHalf;

  let onByteCb: (b: number, erased: boolean) => void = () => {};

  // Periodic, unconditional debug dump (~500 ms cadence) plus per-callback
  // mic-arrival proof. Lets us tell at a glance whether we're getting any
  // audio at all, what the peak amplitude is, and what each Goertzel sees.
  let lastDebugAt = 0;
  let cbCount = 0;
  let cbPeak = 0;
  const debugTick = (centerIdx: number) => {
    if (!DEBUG_MODEM) return;
    const now = performance.now();
    if (now - lastDebugAt < 500) return;
    lastDebugAt = now;
    const em = goertzelAt(centerIdx, pair.mark);
    const es = goertzelAt(centerIdx, pair.space);
    const energy = windowEnergy(centerIdx);
    const big = Math.max(em, es);
    const small = Math.max(1e-12, Math.min(em, es));
    const ratio = big / small;
    const snr = energy / Math.max(1e-12, noiseFloor);
    const wouldPass =
      energy > absFloor() &&
      ((energy > noiseFloor * modemConfig.snrFactor && ratio > modemConfig.binRatio) ||
        ratio > modemConfig.strongBinRatio);
    // eslint-disable-next-line no-console
    console.log(
      `[kl43/modem] cb=${cbCount} peak=${cbPeak.toFixed(3)} ` +
        `em=${em.toExponential(2)} es=${es.toExponential(2)} ratio=${ratio.toFixed(1)} ` +
        `winE=${energy.toExponential(2)} floor=${noiseFloor.toExponential(2)} ` +
        `snr=${snr.toFixed(1)} state=${state} pass=${wouldPass}`,
    );
    cbCount = 0;
    cbPeak = 0;
  };

  const pushSamples = (input: Float32Array | ArrayLike<number>): void => {
    cbCount++;
    for (let i = 0; i < input.length; i++) {
      const s = input[i]!;
      ring[head % ringLen] = s;
      head++;
      const a = s < 0 ? -s : s;
      if (a > cbPeak) cbPeak = a;

      // We can detect centred on any idx where idx + halfWin <= head.
      const centerIdx = head - halfWin - 1;
      if (centerIdx < halfWin) continue;
      debugTick(centerIdx);

      if (state === "IDLE") {
        if (head % scanStep !== 0) continue;
        const d = detectAt(centerIdx);
        // Track the ambient floor from non-carrier windows with a slow EWMA.
        // We only fold in weak windows (where the detector rejected the
        // sample) so real carrier energy doesn't raise the gate on us.
        if (!d.ok) {
          const e = windowEnergy(centerIdx);
          noiseFloor = noiseFloor === 0 ? e : noiseFloor * 0.98 + e * 0.02;
          lastIdle = 1;
          continue;
        }
        if (d.bit === 0 && lastIdle === 1) {
          // Start-bit candidate. Walk back with a narrow window to find the
          // actual mark→space edge (within a few samples), then validate by
          // re-checking at mid-start-bit. The first data bit is centred
          // 1.5 bit-periods after the edge.
          let edge = centerIdx;
          for (let k = 1; k <= scanStep + narrowHalf; k++) {
            const probe = centerIdx - k;
            if (probe - narrowHalf < 0) break;
            if (detectNarrow(probe) === 1) {
              edge = probe + 1;
              break;
            }
          }
          lastStartEdge = edge;
          nextTarget = Math.round(edge + spb / 2);
          state = "DATA";
          bitIdx = -1;
          byteAccum = 0;
        }
        lastIdle = d.bit;
      } else if (state === "DATA") {
        if (centerIdx < nextTarget) continue;
        // Inside a frame we trust whichever bin is louder. Only a total
        // carrier collapse (energy below the absolute floor) aborts —
        // transient dips in ratio or SNR must not cost us a byte.
        const energy = windowEnergy(nextTarget);
        if (energy < absFloor()) {
          state = "IDLE";
          lastIdle = 1;
          continue;
        }
        const em = goertzelAt(nextTarget, pair.mark);
        const es = goertzelAt(nextTarget, pair.space);
        const bit: 0 | 1 = em > es ? 1 : 0;
        if (bitIdx === -1) {
          // Start-bit validation still requires clear dominance: if the bin
          // ratio is near 1 at mid-start, it was a noise glitch.
          const big = em > es ? em : es;
          const small = em > es ? es : em;
          if (bit !== 0 || big <= small * modemConfig.binRatio) {
            // Noise-glitch start bit — no real byte to preserve, so just
            // fall back to full IDLE acquisition.
            state = "IDLE";
            lastIdle = bit;
            continue;
          }
          bitIdx = 0;
          nextTarget += Math.round(spb);
        } else if (bitIdx < 8) {
          byteAccum |= bit << bitIdx;
          bitIdx++;
          nextTarget += Math.round(spb);
        } else {
          // Stop-bit sample. Clean byte if mark, otherwise it's a framing
          // error — emit an erasure at the SAME position so downstream
          // RS still sees a position-preserving substitution rather than
          // a dropped byte that would shift every subsequent codeword.
          if (bit === 1) {
            onByteCb(byteAccum, false);
            // Clean stop bit: the line is mark between this byte and
            // the next start bit, so the next byte's start bit will
            // produce a real mark→space edge. LOCKED uses edge-based
            // resync (with walk-back) to absorb small clock jitter.
            lockedNeedsEdge = true;
          } else {
            onByteCb(0x3f, true); // ASCII '?'
            // Framing error: stop bit was space. On the wire the line
            // is continuously space from the end of the real data
            // through this "stop" bit and into the next byte's start
            // bit (both space). There is no mark→space transition at
            // expectedEdge, so LOCKED must NOT walk back — it would
            // latch onto the earlier (inside-this-byte) transition or
            // drift late and misalign the next byte. Clock-only mode
            // re-enters DATA with nextTarget aligned to
            // expectedEdge + 0.5*spb.
            lockedNeedsEdge = false;
          }
          // Either way, the transmitter's bit clock is still running and
          // the next byte's start-bit edge is exactly 10 bit-periods
          // after THIS byte's start edge. Hand over to LOCKED to wait
          // for it at that predicted sample position.
          expectedEdge = lastStartEdge + Math.round(10 * spb);
          lockedLastBit = 1;
          state = "LOCKED";
        }
      } else {
        // LOCKED: bit-clock is locked to lastStartEdge. Two resync
        // modes depending on the previous byte's stop bit:
        //   * edge-based (lockedNeedsEdge=true, set after a clean
        //     stop=mark byte): hunt for the mark→space transition of
        //     the next byte inside
        //     [expectedEdge - EARLY_TOLERANCE, expectedEdge + LATE_TOLERANCE].
        //   * clock-only (lockedNeedsEdge=false, set after a
        //     framing-error erasure): no edge exists — the line is
        //     space on both sides of expectedEdge — so trust the clock
        //     and re-enter DATA targeting expectedEdge + 0.5*spb.
        if (head % scanStep !== 0) continue;
        const energy = windowEnergy(centerIdx);
        if (energy < absFloor()) {
          // Carrier gone. End of message or line dropped — relinquish
          // the clock lock and go back to passive scanning.
          state = "IDLE";
          lastIdle = 1;
          continue;
        }
        if (centerIdx > expectedEdge + LATE_TOLERANCE_SAMPLES) {
          // No start-bit edge arrived within tolerance. In practice this
          // is the transmitter's post-data mark (carrier still on, just
          // no more data bits) — treat as EOM. The rxSilenceTimer in the
          // host finishes the job of flushing the buffer.
          state = "IDLE";
          lastIdle = 1;
          continue;
        }
        if (!lockedNeedsEdge) {
          // Clock-only resync after a framing-error erasure. Wait until
          // the Goertzel window can be centred on the middle of the
          // next start bit, then re-enter DATA with lastStartEdge =
          // expectedEdge. We skip start-bit validation in DATA (bitIdx
          // starts at 0 instead of -1) so a space→space transition
          // through the gap can't be mistaken for a missing start bit.
          const startSampleCtr = expectedEdge + Math.round(spb / 2);
          if (centerIdx < startSampleCtr) continue;
          lastStartEdge = expectedEdge;
          nextTarget = startSampleCtr + Math.round(spb);
          state = "DATA";
          bitIdx = 0;
          byteAccum = 0;
          continue;
        }
        if (centerIdx < expectedEdge - EARLY_TOLERANCE_SAMPLES) {
          // Still inside the previous byte's stop bit — wait.
          lockedLastBit = 1;
          continue;
        }
        const d = detectAt(centerIdx);
        if (!d.ok) continue; // ambiguous; try again at next scan step
        if (d.bit === 0 && lockedLastBit === 1) {
          // Mark→space transition inside the acceptance window. Walk
          // back narrow to pin down the exact edge — same technique as
          // IDLE, but with a longer reach to cover detectAt's ~halfWin
          // detection lag.
          let edge = centerIdx;
          for (let k = 1; k <= LOCKED_WALKBACK; k++) {
            const probe = centerIdx - k;
            if (probe - narrowHalf < 0) break;
            if (detectNarrow(probe) === 1) {
              edge = probe + 1;
              break;
            }
          }
          lastStartEdge = edge;
          nextTarget = Math.round(edge + spb / 2);
          state = "DATA";
          bitIdx = -1;
          byteAccum = 0;
          continue;
        }
        lockedLastBit = d.bit;
      }
    }
  };

  const setOnByte = (cb: (b: number, erased: boolean) => void) => {
    onByteCb = cb;
  };

  return { pushSamples, setOnByte };
}
