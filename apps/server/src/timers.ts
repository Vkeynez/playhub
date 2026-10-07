// Timers and the wall clock behind every room deadline (ARCHITECTURE §4.3). Injected so tests can
// drive turn timers, grace windows and idle closes with a manual clock while sockets and Postgres
// keep using real time. None of these timers may write to Postgres (§5.2, §5.3 rule 2).

export interface TimerHandle {
  cancel(): void;
}

export interface Timers {
  /** Wall time in ms. */
  now(): number;
  /** Calls `fn` after `ms` (clamped at 0). */
  after(ms: number, fn: () => void): TimerHandle;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  after(ms, fn) {
    const handle = setTimeout(fn, Math.max(0, ms));
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

/** A named one-shot timer that replaces itself when re-armed. */
export class Slot {
  private handle: TimerHandle | null = null;

  constructor(private readonly timers: Timers) {}

  /** Arms the slot for wall time `at` (or cancels it when `at` is null). */
  at(at: number | null, fn: () => void): void {
    this.cancel();
    if (at === null) return;
    const handle = this.timers.after(at - this.timers.now(), () => {
      if (this.handle !== handle) return;
      this.handle = null;
      fn();
    });
    this.handle = handle;
  }

  get armed(): boolean {
    return this.handle !== null;
  }

  cancel(): void {
    this.handle?.cancel();
    this.handle = null;
  }
}
