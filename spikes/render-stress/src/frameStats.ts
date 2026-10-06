// Frame-time histogram kept in a Float64Array and updated inside a worklet: no allocation, no sort.
// Percentiles are read from 0.25 ms bins (0-100 ms, plus an overflow bin).

export const BIN_MS = 0.25;
export const BINS = 400;

// Layout of the stats array.
const COUNT = 0;
const SUM = 1;
const MAX = 2;
const OVER_20 = 3; // missed at least one 60 Hz vsync (allows ~3 ms jitter)
const OVER_33 = 4; // the PERF.md "> 33 ms" budget
const WORK_SUM = 5;
const WORK_MAX = 6;
const WORK_COUNT = 7;
const HIST = 8;
export const STATS_LENGTH = HIST + BINS + 1;

export interface FrameSummary {
  frames: number;
  meanFps: number;
  meanMs: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  pctOver20: number;
  pctOver33: number;
  /** Mean / max time spent in the frame callback itself (sim step + buffer fill), -1 if no clock. */
  workMeanMs: number;
  workMaxMs: number;
}

export function resetStats(s: Float64Array): void {
  'worklet';
  for (let i = 0; i < s.length; i++) s[i] = 0;
}

export function recordFrame(s: Float64Array, dtMs: number, workMs: number): void {
  'worklet';
  s[COUNT] += 1;
  s[SUM] += dtMs;
  if (dtMs > s[MAX]) s[MAX] = dtMs;
  if (dtMs > 20) s[OVER_20] += 1;
  if (dtMs > 33.4) s[OVER_33] += 1;
  if (workMs >= 0) {
    s[WORK_SUM] += workMs;
    s[WORK_COUNT] += 1;
    if (workMs > s[WORK_MAX]) s[WORK_MAX] = workMs;
  }
  let bin = Math.floor(dtMs / BIN_MS);
  if (bin > BINS) bin = BINS;
  if (bin < 0) bin = 0;
  s[HIST + bin] += 1;
}

function percentile(s: Float64Array, p: number): number {
  'worklet';
  const target = s[COUNT] * p;
  let acc = 0;
  for (let i = 0; i <= BINS; i++) {
    acc += s[HIST + i];
    if (acc >= target) return (i + 1) * BIN_MS;
  }
  return s[MAX];
}

export function summarizeStats(s: Float64Array): FrameSummary {
  'worklet';
  const n = s[COUNT];
  const mean = n > 0 ? s[SUM] / n : 0;
  return {
    frames: n,
    meanFps: mean > 0 ? 1000 / mean : 0,
    meanMs: mean,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    maxMs: s[MAX],
    pctOver20: n > 0 ? (100 * s[OVER_20]) / n : 0,
    pctOver33: n > 0 ? (100 * s[OVER_33]) / n : 0,
    workMeanMs: s[WORK_COUNT] > 0 ? s[WORK_SUM] / s[WORK_COUNT] : -1,
    workMaxMs: s[WORK_COUNT] > 0 ? s[WORK_MAX] : -1,
  };
}

/** Histogram count for bin i (0.25 ms wide). */
export function binCount(s: Float64Array, i: number): number {
  'worklet';
  return s[HIST + i];
}
