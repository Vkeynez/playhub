// Seeded randomness (ARCHITECTURE §3.4).
//
// - PRNG: xoshiro128** (Blackman & Vigna). 32-bit integer math only, so Hermes and V8 agree bit for bit.
// - The match seed is 128 bits (four u32 words) from crypto.getRandomValues on the server.
// - Streams (game / bot / cosmetic) are derived from the seed with SplitMix32, so a bot drawing
//   numbers can never shift the game stream, and replays only need the seed plus the action log.
// - State lives in the engine, never in S, so it can't leak through views.

/** A 128-bit match seed as four unsigned 32-bit words. */
export type Seed128 = readonly [number, number, number, number];

/** JSON-safe xoshiro128** state: four unsigned 32-bit words, never all zero. */
export type RngState = [number, number, number, number];

/** Independent streams derived from one match seed. */
export type RngStream = 'game' | 'bot' | 'cosmetic';

export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextU32(): number;
  /** Uniform integer in [min, max], both inclusive. The range may span at most 2^32 values. */
  int(min: number, max: number): number;
  /** Uniform float in [0, 1) with 53 bits of precision. */
  float(): number;
  /** Uniformly chosen element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle into a new array; `items` is left untouched. */
  shuffle<T>(items: readonly T[]): T[];
  /** JSON-safe copy of the current state; `rngFromState(rng.save())` continues the same sequence. */
  save(): RngState;
}

const TWO_POW_32 = 0x1_0000_0000;
const TWO_POW_53 = 9007199254740992;
const GOLDEN_GAMMA = 0x9e3779b9;
/** Used when a derived state would be all zero, which xoshiro can't leave. */
const NONZERO_FALLBACK: RngState = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x01234567];

/** Stream ids double as SplitMix32 seeds for each stream's key words. */
const STREAM_IDS: Record<RngStream, number> = { game: 1, bot: 2, cosmetic: 3 };

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** MurmurHash3's fmix32 finalizer: a bijection on u32. */
function fmix32(z: number): number {
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** SplitMix32: a Weyl sequence (golden-ratio gamma) through fmix32. Used only to derive seeds. */
export class SplitMix32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + GOLDEN_GAMMA) >>> 0;
    return fmix32(this.state);
  }
}

function isU32(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < TWO_POW_32;
}

export function isRngState(value: unknown): value is RngState {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(isU32) &&
    value.some((w: number) => w !== 0)
  );
}

export function isSeed128(value: unknown): value is Seed128 {
  return Array.isArray(value) && value.length === 4 && value.every(isU32);
}

class Xoshiro128StarStar implements Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: RngState) {
    [this.s0, this.s1, this.s2, this.s3] = state;
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`Rng.int: invalid range [${min}, ${max}]`);
    }
    const range = max - min + 1;
    if (range > TWO_POW_32)
      throw new RangeError(`Rng.int: range [${min}, ${max}] exceeds 2^32 values`);
    if (range === TWO_POW_32) return min + this.nextU32();
    // Rejection sampling keeps the result unbiased.
    const limit = TWO_POW_32 - (TWO_POW_32 % range);
    for (;;) {
      const x = this.nextU32();
      if (x < limit) return min + (x % range);
    }
  }

  float(): number {
    const hi = this.nextU32() >>> 5; // 27 bits
    const lo = this.nextU32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / TWO_POW_53;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Rng.pick: empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  save(): RngState {
    return [this.s0 >>> 0, this.s1 >>> 0, this.s2 >>> 0, this.s3 >>> 0];
  }
}

/** Rebuilds a generator from `rng.save()` output (e.g. an EngineSnapshot). */
export function rngFromState(state: RngState): Rng {
  if (!isRngState(state))
    throw new TypeError('rngFromState: expected four u32 words, not all zero');
  return new Xoshiro128StarStar([state[0], state[1], state[2], state[3]]);
}

/**
 * The xoshiro state for `stream` of `seed`.
 *
 * The stream's four key words are the first four outputs of SplitMix32 seeded with the stream id.
 * State word i is one SplitMix32 step from (seed[i] XOR key[i]). Each word is a bijection of its seed
 * word, so distinct seeds always give distinct states and no seed entropy is lost.
 */
export function deriveStreamState(seed: Seed128, stream: RngStream): RngState {
  if (!isSeed128(seed)) throw new TypeError('deriveStreamState: seed must be four u32 words');
  const keys = new SplitMix32(STREAM_IDS[stream]);
  const state: RngState = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    state[i] = new SplitMix32((seed[i] as number) ^ keys.next()).next();
  }
  return state.some((w) => w !== 0) ? state : [...NONZERO_FALLBACK];
}

/** A generator for one stream of a match seed. */
export function deriveStream(seed: Seed128, stream: RngStream): Rng {
  return rngFromState(deriveStreamState(seed, stream));
}

/**
 * A child generator seeded from four draws of `parent`. The engine hands each (possibly async)
 * bot.choose call its own child, so a bot that awaits can't interleave draws with another call.
 */
export function forkRng(parent: Rng): Rng {
  const state: RngState = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) state[i] = new SplitMix32(parent.nextU32()).next();
  return rngFromState(state.some((w) => w !== 0) ? state : [...NONZERO_FALLBACK]);
}

/** A full 128-bit seed expanded from a small integer. For tests, tools and the harness only. */
export function seedFromInt(n: number): Seed128 {
  const sm = new SplitMix32(n >>> 0);
  return [sm.next(), sm.next(), sm.next(), sm.next()];
}
