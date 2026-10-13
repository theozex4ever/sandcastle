import { describe, expect, it } from "vitest";
import {
  clip,
  formatAgo,
  formatClock,
  formatCount,
  formatDuration,
  formatMs,
  formatOffset,
  formatStartTime,
  formatStateCounts,
  formatTokens,
  formatWallClock,
  tickStep,
  ticks,
} from "./format.js";

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_900)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_723_000)).toBe("1h 02m");
  });
  it("clamps negatives", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("formatMs", () => {
  it("uses ms below a second and one decimal below ten", () => {
    expect(formatMs(840)).toBe("840ms");
    expect(formatMs(3240)).toBe("3.2s");
    expect(formatMs(64_000)).toBe("1m 04s");
  });
});

describe("formatClock / formatOffset", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatClock(42_000)).toBe("0:42");
    expect(formatClock(252_000)).toBe("4:12");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatOffset(30_000)).toBe("+0:30");
  });
});

describe("formatTokens", () => {
  it("scales to k and M", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(340_500)).toBe("340k");
    expect(formatTokens(999_999)).toBe("999k");
    expect(formatTokens(1_250_000)).toBe("1.2M");
    expect(formatTokens(12_700_000)).toBe("12M");
  });
  it("treats invalid input as zero", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-3)).toBe("0");
  });
});

describe("formatCount", () => {
  it("adds thousands separators", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(12)).toBe("12");
  });
});

describe("formatWallClock / formatStartTime", () => {
  const at = (h: number, m: number, s = 0, day = 12) =>
    new Date(2026, 9, day, h, m, s).getTime();
  it("formats local HH:MM:SS", () => {
    expect(formatWallClock(at(9, 5, 7))).toBe("09:05:07");
  });
  it("labels today, yesterday and older days", () => {
    const now = at(15, 0);
    expect(formatStartTime(at(14, 3), now)).toBe("Today 14:03");
    expect(formatStartTime(at(9, 12, 0, 11), now)).toBe("Yesterday 09:12");
    expect(formatStartTime(at(14, 3, 0, 3), now)).toBe("Oct 3 14:03");
  });
});

describe("formatAgo", () => {
  it("picks the largest unit", () => {
    expect(formatAgo(12_000)).toBe("12s ago");
    expect(formatAgo(180_000)).toBe("3m ago");
    expect(formatAgo(7_200_000)).toBe("2h ago");
    expect(formatAgo(4 * 86_400_000)).toBe("4d ago");
  });
});

describe("formatStateCounts", () => {
  it("lists non-zero states in a fixed order", () => {
    expect(formatStateCounts({ done: 1, working: 3 })).toBe(
      "3 working, 1 done",
    );
    expect(formatStateCounts({ failed: 0 })).toBe("no runs");
  });
});

describe("ticks", () => {
  it("chooses a step that keeps the tick count bounded", () => {
    expect(tickStep(60_000, 6)).toBe(10_000);
    expect(tickStep(600_000, 8)).toBe(120_000);
  });
  it("produces aligned ticks across the range", () => {
    expect(ticks(0, 60_000, 6)).toEqual([
      0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000,
    ]);
    expect(ticks(5000, 25_000, 4)).toEqual([
      5000, 10_000, 15_000, 20_000, 25_000,
    ]);
  });
  it("handles an empty range", () => {
    expect(ticks(1000, 1000, 5)).toEqual([1000]);
  });
});

describe("clip", () => {
  it("only truncates long strings", () => {
    expect(clip("abc", 5)).toBe("abc");
    expect(clip("abcdefgh", 6)).toBe("abc...");
  });
});
