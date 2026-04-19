import { describe, expect, it } from "vitest";
import { FakeClock, SystemClock, formatClockLines } from "./Clock.js";

describe("Clock", () => {
  it("SystemClock returns Date.now() within a ms", () => {
    const c = new SystemClock();
    const before = Date.now();
    const t = c.nowUtcMs();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("FakeClock.set / advance work as expected", () => {
    const c = new FakeClock(1000);
    expect(c.nowUtcMs()).toBe(1000);
    c.advance(500);
    expect(c.nowUtcMs()).toBe(1500);
    c.set(10_000);
    expect(c.nowUtcMs()).toBe(10_000);
  });
});

describe("formatClockLines", () => {
  it("formats 1991-08-15 12:34:56 UTC in the manual's shape", () => {
    const t = Date.UTC(1991, 7, 15, 12, 34, 56); // month is 0-indexed
    const [a, b] = formatClockLines(t);
    expect(a).toBe("THU AUG 15 1991");
    expect(b).toBe("12:34:56");
  });

  it("pads single-digit date with a space", () => {
    const t = Date.UTC(2000, 0, 1, 0, 0, 0);
    const [a] = formatClockLines(t);
    expect(a).toBe("SAT JAN  1 2000");
  });
});
