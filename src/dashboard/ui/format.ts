/**
 * Pure formatting helpers for the dashboard UI. DOM-free so they can be unit
 * tested in node.
 */

import type { RunState } from "../projection.js";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Compact elapsed duration: `42s`, `3m 05s`, `1h 02m`. Negative input clamps
 * to zero.
 */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h === 0) return `${m}m ${pad2(s)}s`;
  return `${h}h ${pad2(m)}m`;
};

/** Short millisecond duration for setup steps: `840ms`, `3.2s`, `1m 04s`. */
export const formatMs = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
};

/** Clock-style duration: `0:42`, `4:12`, `1:02:03`. */
export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
};

/** Offset from a reference time, for axis ticks and log rows: `+0:30`. */
export const formatOffset = (ms: number): string => `+${formatClock(ms)}`;

/** Token counts: `0`, `940`, `1.2k`, `340k`, `1.2M`, `12M`. */
export const formatTokens = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const fmt = (v: number, unit: string) =>
    v < 10
      ? `${(Math.floor(v * 10) / 10).toFixed(1).replace(/\.0$/, "")}${unit}`
      : `${Math.floor(v)}${unit}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    // 999_999 would floor to "999k"; that is fine and never rounds up to "1000k".
    return fmt(k, "k");
  }
  return fmt(n / 1_000_000, "M");
};

/** Integer with thousands separators, for exact counts in tables. */
export const formatCount = (n: number): string =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Local wall-clock time `HH:MM:SS`. */
export const formatWallClock = (epochMs: number): string => {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Session start label: `Today 14:03`, `Yesterday 09:12`, `Oct 3 14:03`. */
export const formatStartTime = (epochMs: number, now: number): string => {
  const d = new Date(epochMs);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const startOfDay = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(epochMs)) / 86_400_000);
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
};

/** Short relative age: `12s ago`, `3m ago`, `2h ago`, `4d ago`. */
export const formatAgo = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};

export const STATE_LABELS: Readonly<Record<RunState, string>> = {
  provisioning: "Provisioning",
  setup: "Setup",
  working: "Working",
  quiet: "Quiet",
  finishing: "Finishing",
  done: "Done",
  failed: "Failed",
  lost: "Lost",
};

/** Order states appear in station summaries. */
export const STATE_ORDER: readonly RunState[] = [
  "working",
  "quiet",
  "finishing",
  "setup",
  "provisioning",
  "done",
  "failed",
  "lost",
];

/** `3 working, 1 done`. Zero counts are omitted; empty input gives `idle`. */
export const formatStateCounts = (
  counts: Partial<Record<RunState, number>>,
): string => {
  const parts = STATE_ORDER.filter((s) => (counts[s] ?? 0) > 0).map(
    (s) => `${counts[s]} ${STATE_LABELS[s].toLowerCase()}`,
  );
  return parts.length === 0 ? "no runs" : parts.join(", ");
};

/** Candidate gantt tick steps, in ms. */
const TICK_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400, 28_800,
  86_400,
].map((s) => s * 1000);

/**
 * Pick a tick step so a `rangeMs` axis gets at most `maxTicks` ticks.
 * Returns the step in ms.
 */
export const tickStep = (rangeMs: number, maxTicks: number): number => {
  const min = rangeMs / Math.max(1, maxTicks);
  return TICK_STEPS.find((s) => s >= min) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
};

/** Tick offsets (ms from axis start) from `fromMs` to `toMs` inclusive. */
export const ticks = (
  fromMs: number,
  toMs: number,
  maxTicks: number,
): number[] => {
  const range = toMs - fromMs;
  if (range <= 0) return [fromMs];
  const step = tickStep(range, maxTicks);
  const first = Math.ceil(fromMs / step) * step;
  const out: number[] = [];
  for (let t = first; t <= toMs; t += step) out.push(t);
  return out;
};

/** Truncate a string to `max` characters, appending `...`. */
export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
