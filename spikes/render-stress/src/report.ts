// Results leave the app two ways: one `SPIKE <kind> <json>` console line (logcat on Android) and
// `window.__spike[kind]` (read by the Playwright script on web).

type SpikeGlobal = typeof globalThis & { __spike?: Record<string, unknown> };

export function report(kind: string, data: unknown): void {
  console.log(`SPIKE ${kind} ${JSON.stringify(data)}`);
  const g = globalThis as SpikeGlobal;
  g.__spike = g.__spike ?? {};
  g.__spike[kind] = data;
}

export function readReport(kind: string): unknown {
  return (globalThis as SpikeGlobal).__spike?.[kind];
}
