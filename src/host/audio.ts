// WebAudio sound effects for the KL-43C emulator.
//
// The real device's speaker is the acoustic coupler — a cheap 8Ω driver
// behind an LM386-class amp, tuned for telephone voice band (~300–3400 Hz).
// The NSC800 CPU toggles a GPIO for tones; key clicks are a few ms of
// square wave. Bell 103 modem tones live at 1070/1270/2025/2225 Hz, so
// system tones sit below that range (800–1200 Hz) to stay distinct.
//
// Silent / Quiet Mode (MANUAL p.40): suppresses key clicks and confirmation
// tones but does not disable warnings — warnings override silent since they
// indicate faults the operator must notice.

let ctx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

export function getAudioContext(): AudioContext | null {
  return getCtx();
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = (window.AudioContext ?? (window as any).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function unlockAudio(): void {
  getCtx();
}

function getNoiseBuffer(ac: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ac.sampleRate) return noiseBuffer;
  const len = Math.floor(ac.sampleRate * 0.05);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

/**
 * One tone with an exponential-decay envelope (attack ~1 ms, exp decay to
 * silence over `durMs`). Exponential decay is what a real RC-damped speaker
 * does when the driver cuts — it's why period beepers sound like a "click"
 * and not a digital beep.
 */
function tone(
  freq: number,
  durMs: number,
  opts: {
    gain?: number;
    type?: OscillatorType;
    startAt?: number; // absolute currentTime offset
  } = {},
): void {
  const ac = getCtx();
  if (!ac) return;
  const { gain = 0.08, type = "square", startAt = 0 } = opts;
  const now = ac.currentTime + startAt;
  const dur = durMs / 1000;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.001);
  // exponentialRampToValueAtTime can't target 0 — use a tiny floor.
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

/** Frequency-glide tone: lerps from `f0` to `f1` linearly over `durMs`. */
function glide(
  f0: number,
  f1: number,
  durMs: number,
  opts: { gain?: number; type?: OscillatorType; startAt?: number } = {},
): void {
  const ac = getCtx();
  if (!ac) return;
  const { gain = 0.08, type = "sine", startAt = 0 } = opts;
  const now = ac.currentTime + startAt;
  const dur = durMs / 1000;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, now);
  osc.frequency.linearRampToValueAtTime(f1, now + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.005);
  g.gain.setValueAtTime(gain, now + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, now + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

/** Tiny noise burst — adds "dome collapsing" tactile texture to clicks. */
function noiseBurst(durMs: number, gain: number): void {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const dur = durMs / 1000;
  const src = ac.createBufferSource();
  src.buffer = getNoiseBuffer(ac);
  // Band-limit the noise so it sounds like a mechanical click, not hiss.
  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1800;
  bp.Q.value = 0.8;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(now);
  src.stop(now + dur + 0.02);
}

/**
 * Key click — 800 Hz square, ~10 ms exp decay, plus a 2 ms filtered noise
 * onset for the "rubber dome" texture. Sits well below the Bell 103 modem
 * band (1070–2225 Hz) so it's unambiguous vs carrier.
 */
export function playKeyClick(silent: boolean): void {
  if (silent) return;
  tone(800, 10, { gain: 0.06, type: "square" });
  noiseBurst(2, 0.04);
}

/** Confirmation tone — single 1 kHz beep, ~150 ms. */
export function playConfirm(silent: boolean): void {
  if (silent) return;
  tone(1000, 150, { gain: 0.08, type: "sine" });
}

/**
 * Error — descending double beep (1200 → 600 Hz, 80 ms each). Overrides
 * silent mode: warnings must always be audible.
 */
export function playError(): void {
  tone(1200, 80, { gain: 0.09, type: "square" });
  tone(600, 80, { gain: 0.09, type: "square", startAt: 0.1 });
}

/** Power-on chirp — rising 600 → 1200 Hz glide, 200 ms. Plays after boot Y. */
export function playPowerOn(): void {
  glide(600, 1200, 200, { gain: 0.08, type: "sine" });
}

/** Power-off — single soft low note. */
export function playPowerOff(): void {
  tone(220, 180, { gain: 0.08, type: "sine" });
}

/**
 * Zeroize confirmation — three descending tones. The period flourish for a
 * destructive action; overrides silent so the operator always hears it.
 */
export function playZeroize(): void {
  tone(1200, 90, { gain: 0.09, type: "square" });
  tone(900, 90, { gain: 0.09, type: "square", startAt: 0.11 });
  tone(600, 140, { gain: 0.09, type: "square", startAt: 0.22 });
}
