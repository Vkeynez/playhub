// A monotonic clock that can be paused (tab hidden / app backgrounded), for LocalRoom (ARCHITECTURE §6.3).
// While paused, now() is frozen; on resume it continues from where it stopped, so game time never jumps.

export interface PausableClock {
  now(): number;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
}

export function createPausableClock(source: () => number = () => performance.now()): PausableClock {
  let pausedAt: number | null = null;
  let pausedTotal = 0;
  return {
    now: () => (pausedAt ?? source()) - pausedTotal,
    pause() {
      if (pausedAt === null) pausedAt = source();
    },
    resume() {
      if (pausedAt === null) return;
      pausedTotal += source() - pausedAt;
      pausedAt = null;
    },
    get paused() {
      return pausedAt !== null;
    },
  };
}

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
