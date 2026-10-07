// In-memory fixed-window rate limits (ARCHITECTURE §5.7). Per process, never persisted, no timers:
// expired windows are dropped lazily when the map grows.

const PRUNE_AT = 5_000;

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit for `key`; false when the key is over its limit in the current window. */
  take(key: string): boolean {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      if (this.windows.size >= PRUNE_AT) this.prune(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count++;
    return current.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
    // Still full of live windows: drop the oldest half rather than grow without bound.
    if (this.windows.size >= PRUNE_AT) {
      let drop = this.windows.size / 2;
      for (const key of this.windows.keys()) {
        if (drop-- <= 0) break;
        this.windows.delete(key);
      }
    }
  }
}

/** The limits from ARCHITECTURE §5.7, per process. Tests may override any of them. */
export interface RateLimitConfig {
  guestPerIp: [number, number];
  guestPerKey: [number, number];
  refreshPerIp: [number, number];
  restPerIp: [number, number];
  createRoomPerUser: [number, number];
  joinPerUser: [number, number];
  actionPerUser: [number, number];
  lobbyPerUser: [number, number];
  reactPerUser: [number, number];
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  guestPerIp: [20, 60_000],
  guestPerKey: [5, 60_000],
  refreshPerIp: [60, 60_000],
  restPerIp: [120, 60_000],
  createRoomPerUser: [5, 60_000],
  joinPerUser: [20, 60_000],
  actionPerUser: [40, 10_000],
  lobbyPerUser: [60, 60_000],
  reactPerUser: [1, 2_000],
};

export type Limiters = { [K in keyof RateLimitConfig]: RateLimiter };

export function createLimiters(
  overrides: Partial<RateLimitConfig> = {},
  now: () => number = Date.now,
): Limiters {
  const config = { ...DEFAULT_RATE_LIMITS, ...overrides };
  const entries = Object.entries(config).map(([name, [limit, windowMs]]) => [
    name,
    new RateLimiter(limit, windowMs, now),
  ]);
  return Object.fromEntries(entries) as Limiters;
}
