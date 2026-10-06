// A deterministic wall clock + Scheduler for tests and the contract harness.

import type { Scheduler } from '../engine';

interface FakeTimer {
  at: number;
  order: number;
  fire: () => void;
  live: boolean;
}

export class FakeTime implements Scheduler {
  private order = 0;
  private timers: FakeTimer[] = [];

  constructor(public now: number) {}

  readonly clock = (): number => this.now;

  schedule(at: number, fire: () => void): () => void {
    const timer: FakeTimer = { at, order: this.order++, fire, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Number of armed (uncancelled) timers. */
  get pending(): number {
    this.prune();
    return this.timers.length;
  }

  /** Wall time of the earliest armed timer, or null. */
  nextAt(): number | null {
    const timer = this.earliest();
    return timer ? timer.at : null;
  }

  /** Moves to the earliest armed timer (never backwards) and fires it. False when nothing is armed. */
  next(): boolean {
    const timer = this.earliest();
    if (!timer) return false;
    this.timers = this.timers.filter((t) => t !== timer);
    timer.live = false;
    this.now = Math.max(this.now, timer.at);
    timer.fire();
    return true;
  }

  /** Advances by `ms`, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const at = this.nextAt();
      if (at === null || at > target) break;
      this.next();
    }
    this.now = Math.max(this.now, target);
  }

  private prune(): void {
    this.timers = this.timers.filter((t) => t.live);
  }

  private earliest(): FakeTimer | null {
    this.prune();
    let best: FakeTimer | null = null;
    for (const t of this.timers) {
      if (best === null || t.at < best.at || (t.at === best.at && t.order < best.order)) best = t;
    }
    return best;
  }
}

/** Lets promise continuations (async bots, effect results) run. */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
