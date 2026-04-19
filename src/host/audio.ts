// Simple WebAudio sound effects for the KL-43C emulator.
//
// The real device has a piezo speaker that emits short clicks on each key
// press and longer confirmation / warning tones at key moments. We synthesize
// equivalents with a shared AudioContext. The context starts suspended until
// the first user gesture (browser autoplay policy); `unlock()` resumes it.
//
// Silent / Quiet Mode (MANUAL p.40): suppresses key clicks and confirmation
// tones but does not disable warnings (implementation choice — warnings
// override silent since they indicate faults the operator must notice).

let ctx: AudioContext | null = null;

/** Lazily-created shared AudioContext. Exposed so other host modules (modem)
 *  can plug into the same context as the key-click sounds. */
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

/** Resume the audio context in response to a user gesture. */
export function unlockAudio(): void {
  getCtx();
}

function pulse(freq: number, durMs: number, gain = 0.08, type: OscillatorType = "square"): void {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const end = now + durMs / 1000;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ac.createGain();
  // Attack-decay envelope to avoid clicks at start/end.
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.002);
  g.gain.setValueAtTime(gain, end - 0.01);
  g.gain.linearRampToValueAtTime(0, end);
  osc.connect(g).connect(ac.destination);
  osc.start(now);
  osc.stop(end + 0.02);
}

/** Short key-press click. Very brief square-wave burst. */
export function playKeyClick(silent: boolean): void {
  if (silent) return;
  pulse(1600, 8, 0.05, "square");
}

/** Confirmation chirp — e.g. after Encrypt/Decrypt succeeds, or key load. */
export function playConfirm(silent: boolean): void {
  if (silent) return;
  pulse(880, 90, 0.09, "sine");
}

/** Descending double-beep for errors (decryptFailed, invalid key). */
export function playError(): void {
  pulse(440, 120, 0.1, "square");
  setTimeout(() => pulse(330, 160, 0.1, "square"), 140);
}

/** Power-off tone — single soft low note. */
export function playPowerOff(): void {
  pulse(220, 180, 0.08, "sine");
}
