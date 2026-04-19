// Real-time clock abstraction. The KL-43C has a lithium-backed RTC that
// continues ticking across power-off (MANUAL p.47). We model it as a plain
// interface so production can bind `SystemClock` (Date.now) and tests can
// bind `FakeClock` for deterministic assertions.
//
// Authentication (§5.4) and any time-display menu (`S - Set Time and Date`)
// read the same source — consistency between the two is how challenge/reply
// works without separate synchronization.

export interface Clock {
  nowUtcMs(): number;
  /** Commit a user-entered date/time. SystemClock tracks as an offset from
   * the host wall clock; FakeClock sets directly. */
  set(utcMs: number): void;
}

export class SystemClock implements Clock {
  private offsetMs = 0;
  nowUtcMs(): number {
    return Date.now() + this.offsetMs;
  }
  set(utcMs: number): void {
    this.offsetMs = utcMs - Date.now();
  }
}

export class FakeClock implements Clock {
  private t: number;
  constructor(initialUtcMs: number = 0) {
    this.t = initialUtcMs;
  }
  nowUtcMs(): number {
    return this.t;
  }
  set(utcMs: number): void {
    this.t = utcMs;
  }
  advance(deltaMs: number): void {
    this.t += deltaMs;
  }
}

export function formatClockLines(utcMs: number): [string, string] {
  const d = new Date(utcMs);
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
  const months = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ] as const;
  const day = days[d.getUTCDay()]!;
  const month = months[d.getUTCMonth()]!;
  const date = d.getUTCDate().toString().padStart(2, " ");
  const year = d.getUTCFullYear().toString();
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return [`${day} ${month} ${date} ${year}`, `${hh}:${mm}:${ss}`];
}
