import { fc, test as fcTest } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';

import {
  deriveStream,
  deriveStreamState,
  forkRng,
  isRngState,
  jsonClone,
  rngFromState,
  seedFromInt,
  SplitMix32,
} from '../index';
import type { RngState, Seed128 } from '../index';

// Independent BigInt reference implementations (a different code path from the Math.imul one under test).
const M32 = 0xffffffffn;
const rotlRef = (x: bigint, k: bigint): bigint => ((x << k) | (x >> (32n - k))) & M32;

function xoshiroRef(state: RngState): () => number {
  let [s0, s1, s2, s3] = state.map(BigInt) as [bigint, bigint, bigint, bigint];
  return () => {
    const result = (rotlRef((s1 * 5n) & M32, 7n) * 9n) & M32;
    const t = (s1 << 9n) & M32;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotlRef(s3, 11n);
    return Number(result);
  };
}

function splitMixRef(seed: number): () => number {
  let state = BigInt(seed >>> 0);
  return () => {
    state = (state + 0x9e3779b9n) & M32;
    let z = state;
    z = ((z ^ (z >> 16n)) * 0x85ebca6bn) & M32;
    z = ((z ^ (z >> 13n)) * 0xc2b2ae35n) & M32;
    return Number(z ^ (z >> 16n));
  };
}

const u32 = fc.integer({ min: 0, max: 0xffffffff });
const seedArb = fc.tuple(u32, u32, u32, u32) as fc.Arbitrary<Seed128>;

describe('xoshiro128**', () => {
  it('matches the published reference vector for state [1, 2, 3, 4]', () => {
    const rng = rngFromState([1, 2, 3, 4]);
    const out = Array.from({ length: 6 }, () => rng.nextU32());
    expect(out).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492]);
  });

  fcTest.prop([fc.tuple(u32, u32, u32, u32).filter((s) => s.some((w) => w !== 0))], {
    numRuns: 50,
  })('agrees with a BigInt reference for 500 outputs', (state) => {
    const rng = rngFromState(state);
    const ref = xoshiroRef(state);
    for (let i = 0; i < 500; i++) expect(rng.nextU32()).toBe(ref());
  });

  it('save() then rngFromState() continues the same sequence, through JSON', () => {
    const rng = deriveStream(seedFromInt(7), 'game');
    for (let i = 0; i < 37; i++) rng.nextU32();
    const saved = jsonClone(rng.save());
    const expected = Array.from({ length: 100 }, () => rng.nextU32());
    const resumed = rngFromState(saved);
    expect(Array.from({ length: 100 }, () => resumed.nextU32())).toEqual(expected);
  });

  it('rejects an all-zero or malformed state', () => {
    expect(isRngState([0, 0, 0, 0])).toBe(false);
    expect(isRngState([1, 2, 3])).toBe(false);
    expect(isRngState([1, 2, 3, 2 ** 32])).toBe(false);
    expect(() => rngFromState([0, 0, 0, 0])).toThrow(TypeError);
  });
});

describe('SplitMix32 and stream derivation', () => {
  it('SplitMix32 agrees with a BigInt reference', () => {
    for (const seed of [0, 1, 42, 0xffffffff]) {
      const sm = new SplitMix32(seed);
      const ref = splitMixRef(seed);
      for (let i = 0; i < 100; i++) expect(sm.next()).toBe(ref());
    }
    const sm0 = new SplitMix32(0);
    expect([sm0.next(), sm0.next(), sm0.next()]).toEqual([2462723854, 1020716019, 454327756]);
  });

  it('derives the golden stream states (cross-engine regression vector)', () => {
    const seed = seedFromInt(42);
    expect(seed).toEqual([939911724, 3948730756, 321366731, 3317318717]);
    expect(deriveStreamState(seed, 'game')).toEqual([
      1126502677, 3124185984, 2086331211, 3416575995,
    ]);
    expect(deriveStreamState(seed, 'bot')).toEqual([602209303, 3053466306, 801467401, 3883952232]);
  });

  fcTest.prop([seedArb])('streams of one seed are distinct and uncorrelated', (seed) => {
    const game = deriveStream(seed, 'game');
    const bot = deriveStream(seed, 'bot');
    const cosmetic = deriveStream(seed, 'cosmetic');
    const g = Array.from({ length: 64 }, () => game.nextU32());
    const b = Array.from({ length: 64 }, () => bot.nextU32());
    const c = Array.from({ length: 64 }, () => cosmetic.nextU32());
    const sameGB = g.filter((x, i) => x === b[i]).length;
    const sameGC = g.filter((x, i) => x === c[i]).length;
    expect(sameGB).toBeLessThan(2);
    expect(sameGC).toBeLessThan(2);
  });

  it('drawing from the bot stream never shifts the game stream', () => {
    const seed = seedFromInt(9);
    const reference = deriveStream(seed, 'game');
    const expected = Array.from({ length: 20 }, () => reference.nextU32());
    const game = deriveStream(seed, 'game');
    const bot = deriveStream(seed, 'bot');
    const got: number[] = [];
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < i; j++) bot.nextU32();
      got.push(game.nextU32());
    }
    expect(got).toEqual(expected);
  });

  fcTest.prop([seedArb, seedArb])('distinct seeds give distinct stream states', (a, b) => {
    fc.pre(a.some((w, i) => w !== b[i]));
    expect(deriveStreamState(a, 'game')).not.toEqual(deriveStreamState(b, 'game'));
  });

  it('forkRng is deterministic and advances the parent by four draws', () => {
    const p1 = deriveStream(seedFromInt(3), 'bot');
    const p2 = deriveStream(seedFromInt(3), 'bot');
    const c1 = forkRng(p1);
    const c2 = forkRng(p2);
    expect(c1.save()).toEqual(c2.save());
    const p3 = deriveStream(seedFromInt(3), 'bot');
    for (let i = 0; i < 4; i++) p3.nextU32();
    expect(p1.save()).toEqual(p3.save());
  });
});

describe('Rng helpers', () => {
  const rng = deriveStream(seedFromInt(1), 'game');

  it('int stays in range and is roughly uniform', () => {
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) {
      const x = rng.int(0, 5);
      counts[x] = (counts[x] ?? 0) + 1;
    }
    for (const n of counts) expect(n).toBeGreaterThan(850);
    for (const n of counts) expect(n).toBeLessThan(1150);
    for (let i = 0; i < 200; i++) {
      const x = rng.int(-3, 3);
      expect(x).toBeGreaterThanOrEqual(-3);
      expect(x).toBeLessThanOrEqual(3);
    }
    expect(rng.int(5, 5)).toBe(5);
  });

  it('int rejects bad ranges', () => {
    expect(() => rng.int(3, 2)).toThrow(RangeError);
    expect(() => rng.int(0, 2 ** 32)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
  });

  it('float is in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const x = rng.float();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('shuffle returns a permutation and leaves its input alone; pick rejects empty arrays', () => {
    const items = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = rng.shuffle(items);
    expect([...shuffled].sort((a, b) => a - b)).toEqual([...items]);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(items).toContain(rng.pick(items));
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});
