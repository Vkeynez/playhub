// Process metrics for /health (ARCHITECTURE §5.4): event-loop utilization and event-loop delay,
// sampled from process memory on an unref'd timer. Nothing here touches Postgres.

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface ProcessMetrics {
  /** Event-loop utilization over the last sample window, 0–1. */
  elu(): number;
  /** p99 event-loop delay over the last sample window, in ms. */
  eldP99Ms(): number;
  stop(): void;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function startProcessMetrics(sampleMs = 5_000): ProcessMetrics {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const bootElu = performance.eventLoopUtilization();
  let last = bootElu;
  let elu: number | null = null;
  let eldP99Ms = 0;

  const timer = setInterval(() => {
    const now = performance.eventLoopUtilization();
    elu = performance.eventLoopUtilization(now, last).utilization;
    last = now;
    const p99 = histogram.percentile(99) / 1e6;
    eldP99Ms = Number.isFinite(p99) ? p99 : 0;
    histogram.reset();
  }, sampleMs);
  timer.unref();

  return {
    elu: () => {
      // Before the first window closes, report utilization since boot.
      const value = elu ?? performance.eventLoopUtilization(bootElu).utilization;
      return round3(Math.min(1, Math.max(0, value)));
    },
    eldP99Ms: () => round3(eldP99Ms),
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
