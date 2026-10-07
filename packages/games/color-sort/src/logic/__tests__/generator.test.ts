import { describe, expect, it } from 'vitest';

import {
  boardKey,
  CAPACITY,
  fnv1a,
  generateLevel,
  isPourError,
  isSolved,
  levelParams,
  lowerBound,
  pour,
  scrambleLevel,
  solve,
} from '../index';
import type { Board } from '../index';

const hashOf = (tubes: number[][]): string =>
  fnv1a(boardKey({ capacity: CAPACITY, tubes })).toString(16);

describe('generator determinism', () => {
  it('the same level number always gives the same board', () => {
    for (const level of [1, 7, 42, 333]) {
      expect(scrambleLevel(level)).toEqual(scrambleLevel(level));
      expect(generateLevel(level)).toEqual(generateLevel(level));
    }
    expect(boardKey({ capacity: 4, tubes: generateLevel(5).tubes })).not.toBe(
      boardKey({ capacity: 4, tubes: generateLevel(6).tubes }),
    );
  });

  // Golden hashes: a change here changes every player's levels. Bump logicVersion if it is intended.
  it.each([
    [1, '8113ea4d', 4],
    [10, '33004769', 7],
    [50, '2b0f1e9b', 12],
    [200, '63dc9fef', 22],
  ])('level %i hashes to %s (par %i)', (level, hash, par) => {
    const l = generateLevel(level);
    expect(hashOf(l.tubes)).toBe(hash);
    expect(l.par).toBe(par);
  });

  it('returns copies callers cannot use to corrupt the cache', () => {
    const a = generateLevel(3);
    (a.tubes[0] as number[]).push(99);
    expect(generateLevel(3).tubes).not.toEqual(a.tubes);
  });

  it('rejects invalid level numbers', () => {
    expect(() => generateLevel(0)).toThrow(RangeError);
    expect(() => generateLevel(1.5)).toThrow(RangeError);
  });
});

describe('difficulty curve', () => {
  it('ramps colours 3 → 12, capacity 4, 1-2 spare tubes', () => {
    expect(levelParams(1).colors).toBe(3);
    expect(levelParams(500).colors).toBe(12);
    let prev = 0;
    for (let level = 1; level <= 500; level++) {
      const p = levelParams(level);
      expect(p.colors).toBeGreaterThanOrEqual(prev);
      expect(p.capacity).toBe(4);
      expect([1, 2]).toContain(p.emptyTubes);
      prev = p.colors;
    }
  });

  it('later levels need more moves', () => {
    const avgPar = (from: number, to: number): number => {
      let sum = 0;
      for (let l = from; l <= to; l++) sum += generateLevel(l).par;
      return sum / (to - from + 1);
    };
    const early = avgPar(1, 10);
    const mid = avgPar(91, 100);
    const late = avgPar(291, 300);
    expect(early).toBeLessThan(mid);
    expect(mid).toBeLessThan(late);
  });
});

describe('every level 1..500', () => {
  const levels = Array.from({ length: 500 }, (_, i) => i + 1);

  it('is solvable by construction, verified by the solver, never pre-solved or trivial', () => {
    for (const level of levels) {
      const { params, tubes, solution, classic } = scrambleLevel(level);
      const board: Board = { capacity: params.capacity, tubes };
      // Layout: the classic look (full tubes + empty spares), each colour exactly `capacity` units.
      expect(classic, `level ${level} layout`).toBe(true);
      expect(tubes).toHaveLength(params.colors + params.emptyTubes);
      expect(tubes.filter((t) => t.length === 0)).toHaveLength(params.emptyTubes);
      const counts = new Map<number, number>();
      for (const t of tubes) for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1);
      expect(counts.size).toBe(params.colors);
      for (const n of counts.values()) expect(n).toBe(params.capacity);
      // Not solved, not one move from solved.
      expect(isSolved(board), `level ${level} pre-solved`).toBe(false);
      expect(lowerBound(board), `level ${level} trivial`).toBeGreaterThanOrEqual(2);
      // By construction: the reversed scramble solves it.
      let b: Board = board;
      for (const m of solution) {
        const r = pour(b, m.from, m.to);
        expect(isPourError(r), `level ${level} replay`).toBe(false);
        if (isPourError(r)) break;
        b = r.board;
      }
      expect(isSolved(b), `level ${level} replay solves`).toBe(true);
      // Verified by the solver, and the par is a real solution length > 1.
      const l = generateLevel(level);
      expect(l.par, `level ${level} par`).toBeGreaterThanOrEqual(2);
      expect(l.par).toBeLessThanOrEqual(solution.length);
      expect(l.parOptimal, `level ${level} optimal`).toBe(true);
    }
  }, 120_000);
});

describe('solver', () => {
  it('finds shortest solutions that actually solve the board', () => {
    for (const level of [1, 2, 12, 77, 150]) {
      const { tubes } = scrambleLevel(level);
      const board: Board = { capacity: CAPACITY, tubes };
      const r = solve(board);
      expect(r.status).toBe('solved');
      if (r.status !== 'solved') continue;
      expect(r.optimal).toBe(true);
      expect(r.moves.length).toBeGreaterThanOrEqual(lowerBound(board));
      let b = board;
      for (const m of r.moves) {
        const p = pour(b, m.from, m.to);
        if (isPourError(p)) throw new Error(p);
        b = p.board;
      }
      expect(isSolved(b)).toBe(true);
    }
  });

  it('is optimal on a hand-checked board (BFS by hand: 3 pours)', () => {
    // [A B] [B A] [] : B→empty, B→B, A→A  — no 2-pour solution exists.
    const r = solve({ capacity: 2, tubes: [[0, 1], [1, 0], []] });
    expect(r.status === 'solved' && r.moves.length).toBe(3);
  });

  it('reports a dead end as unsolvable', () => {
    // No legal pours at all and not solved.
    expect(
      solve({
        capacity: 2,
        tubes: [
          [0, 1],
          [1, 0],
        ],
      }).status,
    ).toBe('unsolvable');
  });

  it('falls back to the greedy phase when the optimal budget is exhausted', () => {
    const { tubes } = scrambleLevel(331);
    const r = solve({ capacity: CAPACITY, tubes }, { maxNodes: 10 });
    expect(r.status).toBe('solved');
    if (r.status === 'solved') expect(r.optimal).toBe(false);
    expect(solve({ capacity: CAPACITY, tubes }, { maxNodes: 10, maxGreedyNodes: 0 }).status).toBe(
      'unknown',
    );
  });
});
