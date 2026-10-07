// Procedural levels (BUILD_BRIEF §7.9, OQ D28): seeded by the level number alone, integer-only, so
// level N is the same board on every device and engine (ARCHITECTURE §3.4 cross-engine content).
//
// Always solvable by construction: start from the solved board and apply random legal REVERSE pours.
// Every reverse pour undoes some forward pour, so replaying them backwards solves the level. The solver
// then confirms it and computes the par (a shortest solution when it fits the node budget).

import { deriveStream, SplitMix32 } from '@gp/game-sdk/core';
import type { Rng, Seed128 } from '@gp/game-sdk/core';

import { isSolved, mixScore, runCount, topColor, topRunLength } from './board';
import type { Board, Move, Tube } from './board';
import { PALETTE_SIZE } from '../content/palette';
import { solve } from './solver';

export const CAPACITY = 4;
export const MIN_COLORS = 3;
export const MAX_COLORS = PALETTE_SIZE;
/** Highest level number the save schema accepts. The generator itself works for any positive int. */
export const MAX_LEVEL = 99_999;

/** Level number at which each colour count starts (index 0 → 3 colours … index 9 → 12 colours). */
const COLOR_STEPS = [1, 4, 9, 16, 26, 41, 61, 86, 121, 171] as const;
const GENERATOR_SALT = 0xc0105047;
const MAX_SCRAMBLE_STEPS = 2_000;

export interface LevelParams {
  level: number;
  colors: number;
  capacity: number;
  emptyTubes: number;
  /** The scramble stops once `mixScore` (runs − colours, a lower bound on moves) reaches this. */
  targetMix: number;
}

export interface Level {
  level: number;
  capacity: number;
  colorCount: number;
  emptyTubes: number;
  /** Starting tubes, bottom → top colour ids (indexes into `PALETTE`). */
  tubes: number[][];
  /** Moves the star rule compares against: a shortest solution if `parOptimal`, else a known one. */
  par: number;
  parOptimal: boolean;
}

/** The difficulty curve. Integer arithmetic only. */
export function levelParams(level: number): LevelParams {
  assertLevel(level);
  let colors = MIN_COLORS;
  for (let i = 1; i < COLOR_STEPS.length; i++) {
    if (level >= (COLOR_STEPS[i] as number)) colors = MIN_COLORS + i;
  }
  // From level 30, every 5th level is a "tight" one with a single spare tube.
  const tight = level >= 30 && level % 5 === 0;
  const emptyTubes = tight ? 1 : 2;
  // Mixing ramps from 35 % of the maximum towards 80 % (the maximum is every unit its own run).
  const maxMix = colors * (CAPACITY - 1);
  const pct = Math.min(80, 35 + ((level / 3) | 0)) - (tight ? 10 : 0);
  const targetMix = Math.max(3, ((maxMix * pct) / 100) | 0);
  return { level, colors, capacity: CAPACITY, emptyTubes, targetMix };
}

function assertLevel(level: number): void {
  if (!Number.isSafeInteger(level) || level < 1) {
    throw new RangeError(`color-sort: invalid level ${level}`);
  }
}

/** The rng for a level: four SplitMix32 words from the salted level number. */
export function levelRng(level: number): Rng {
  const sm = new SplitMix32((level ^ GENERATOR_SALT) >>> 0);
  const seed: Seed128 = [sm.next(), sm.next(), sm.next(), sm.next()];
  return deriveStream(seed, 'game');
}

/** A reverse pour: take `amount` units off the top of `src` and put them on `dst`. */
interface ReverseMove {
  src: number;
  dst: number;
  amount: number;
  /** Change in total runs. */
  delta: number;
}

/**
 * Every reverse pour whose forward pour (dst → src) is legal and moves exactly `amount` units:
 * - src keeps its top colour c below the lifted units, or becomes empty (c sat on c, or on nothing);
 * - dst has room; if dst's top is already c, the forward pour stopped only because src was full.
 */
function reverseMoves(tubes: readonly Tube[], cap: number): ReverseMove[] {
  const out: ReverseMove[] = [];
  for (let src = 0; src < tubes.length; src++) {
    const s = tubes[src] as Tube;
    if (s.length === 0) continue;
    const c = topColor(s);
    const run = topRunLength(s);
    for (let amount = 1; amount <= run; amount++) {
      if (amount === run && run !== s.length) continue;
      for (let dst = 0; dst < tubes.length; dst++) {
        if (dst === src) continue;
        const d = tubes[dst] as Tube;
        if (d.length + amount > cap) continue;
        const merges = d.length > 0 && topColor(d) === c;
        if (merges && s.length !== cap) continue;
        const delta = (merges ? 0 : 1) - (amount === s.length ? 1 : 0);
        out.push({ src, dst, amount, delta });
      }
    }
  }
  return out;
}

function applyReverse(tubes: Tube[], m: ReverseMove): void {
  const s = tubes[m.src] as Tube;
  const c = topColor(s) as number;
  tubes[m.src] = s.slice(0, s.length - m.amount);
  const d = (tubes[m.dst] as Tube).slice();
  for (let i = 0; i < m.amount; i++) d.push(c);
  tubes[m.dst] = d;
}

export interface Scramble {
  params: LevelParams;
  tubes: number[][];
  /** Forward pours that solve `tubes` (the scramble played backwards). */
  solution: Move[];
  /** Every tube starts full or empty (the familiar layout). */
  classic: boolean;
}

/** Units away from the classic layout (every tube empty or full): 0 means classic. */
function layoutDistance(tubes: readonly Tube[], cap: number): number {
  let d = 0;
  for (const t of tubes) d += t.length < cap - t.length ? t.length : cap - t.length;
  return d;
}

function distanceAfter(tubes: readonly Tube[], cap: number, m: ReverseMove): number {
  const before = layoutDistance([tubes[m.src] as Tube, tubes[m.dst] as Tube], cap);
  const s = (tubes[m.src] as Tube).length - m.amount;
  const d = (tubes[m.dst] as Tube).length + m.amount;
  const after = (s < cap - s ? s : cap - s) + (d < cap - d ? d : cap - d);
  return layoutDistance(tubes, cap) - before + after;
}

interface Walk {
  tubes: Tube[];
  reverse: ReverseMove[];
  mix: number;
  distance: number;
}

/**
 * One reverse walk from the solved board. Phase 1 mixes (mostly run-adding lifts) until `targetMix`;
 * phase 2 compacts towards the classic layout (full tubes plus empty spares) by preferring lifts that
 * shrink `layoutDistance`, with the odd random lift to escape local minima.
 */
function walk(params: LevelParams, rng: Rng, start: Tube[]): Walk {
  const { capacity: cap, targetMix } = params;
  const tubes = start.map((t) => t.slice());
  const reverse: ReverseMove[] = [];
  let mix = 0;
  let distance = 0;
  for (let step = 0; step < MAX_SCRAMBLE_STEPS; step++) {
    const mixing = mix < targetMix;
    if (!mixing && distance === 0) break;
    const last = reverse[reverse.length - 1];
    const all = reverseMoves(tubes, cap).filter(
      // Never immediately put back what the previous step lifted.
      (m) => !(last && m.src === last.dst && m.dst === last.src && m.amount === last.amount),
    );
    if (all.length === 0) break;
    let pool = all;
    if (rng.int(0, 7) !== 0) {
      if (mixing) {
        const up = all.filter((m) => m.delta > 0);
        if (up.length > 0) pool = up;
      } else {
        let best = Number.MAX_SAFE_INTEGER;
        let bestDelta = -2;
        let picked: ReverseMove[] = [];
        for (const m of all) {
          const d = distanceAfter(tubes, cap, m);
          if (d < best || (d === best && m.delta > bestDelta)) {
            best = d;
            bestDelta = m.delta;
            picked = [m];
          } else if (d === best && m.delta === bestDelta) {
            picked.push(m);
          }
        }
        pool = picked;
      }
    }
    const m = rng.pick(pool);
    distance = distanceAfter(tubes, cap, m);
    applyReverse(tubes, m);
    reverse.push(m);
    mix += m.delta;
  }
  return { tubes, reverse, mix, distance };
}

const MAX_ATTEMPTS = 64;

/** The scrambled board for a level, plus the known solution. Fast (no solver). */
export function scrambleLevel(level: number): Scramble {
  const params = levelParams(level);
  const { colors, capacity, emptyTubes } = params;
  const rng = levelRng(level);
  // Which palette colours this level uses, and where the spare tubes start.
  const palette = rng.shuffle(Array.from({ length: MAX_COLORS }, (_, i) => i)).slice(0, colors);
  const solved: Tube[] = palette.map((c) => Array.from({ length: capacity }, () => c));
  for (let i = 0; i < emptyTubes; i++) solved.push([]);
  const start: Tube[] = rng.shuffle(solved);
  // Retry (same rng, so still deterministic) until a walk lands on the classic layout with enough
  // mixing; otherwise keep the best attempt seen.
  let best: Walk | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const w = walk(params, rng, start);
    if (w.mix < 2) continue;
    if (
      best === null ||
      w.distance < best.distance ||
      (w.distance === best.distance && w.mix > best.mix)
    ) {
      best = w;
    }
    if (best.distance === 0 && best.mix >= params.targetMix - 2) break;
  }
  if (best === null) throw new Error(`color-sort: level ${level} could not be scrambled`);
  const solution: Move[] = [];
  for (let i = best.reverse.length - 1; i >= 0; i--) {
    const m = best.reverse[i] as ReverseMove;
    solution.push({ from: m.dst, to: m.src });
  }
  return {
    params,
    tubes: best.tubes.map((t) => t.slice()),
    solution,
    classic: best.distance === 0,
  };
}

// Generating a level runs the solver, so keep the last few around (pure: same input, same output).
const CACHE_SIZE = 8;
const cache = new Map<number, Level>();

function cloneLevel(l: Level): Level {
  return { ...l, tubes: l.tubes.map((t) => t.slice()) };
}

/** Level `level` (≥ 1): deterministic, solvable, never already solved. */
export function generateLevel(level: number): Level {
  const hit = cache.get(level);
  if (hit) return cloneLevel(hit);
  const { params, tubes, solution } = scrambleLevel(level);
  const board: Board = { capacity: params.capacity, tubes };
  if (isSolved(board) || mixScore(board) < 2) {
    throw new Error(`color-sort: level ${level} scrambled too little`); // guarded by tests (1..500)
  }
  const result = solve(board);
  let par = solution.length;
  let parOptimal = false;
  if (result.status === 'solved' && result.moves.length <= par) {
    par = result.moves.length;
    parOptimal = result.optimal;
  }
  const out: Level = {
    level,
    capacity: params.capacity,
    colorCount: params.colors,
    emptyTubes: params.emptyTubes,
    tubes: tubes.map((t) => t.slice()),
    par,
    parOptimal,
  };
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as number);
  cache.set(level, out);
  return cloneLevel(out);
}

/** Total runs on a board; handy for difficulty stats. */
export function totalRuns(tubes: readonly Tube[]): number {
  let n = 0;
  for (const t of tubes) n += runCount(t);
  return n;
}
