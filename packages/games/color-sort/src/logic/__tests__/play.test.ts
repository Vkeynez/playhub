import { describe, expect, it } from 'vitest';

import {
  generateLevel,
  hint,
  isSolved,
  legalMoves,
  movesOf,
  pourMove,
  restart,
  resumeLevel,
  scrambleLevel,
  solve,
  starsFor,
  startLevel,
  undo,
} from '../index';
import type { PlayState } from '../index';

/** Plays `state` to the end by always taking the hint. */
function followHints(state: PlayState, limit = 200): PlayState {
  let s = state;
  for (let i = 0; i < limit && !s.won; i++) {
    const h = hint(s);
    if (h.kind !== 'move') throw new Error(`hint ${h.kind} at move ${i}`);
    const r = pourMove(s, h.from, h.to);
    if (!r.ok) throw new Error(r.reason);
    s = r.state;
  }
  return s;
}

const optimalLength = (s: PlayState): number => {
  const r = solve({ capacity: s.capacity, tubes: s.tubes });
  if (r.status !== 'solved' || !r.optimal) throw new Error('expected an optimal solve');
  return r.moves.length;
};

describe('play', () => {
  it('starts from the generated level', () => {
    const s = startLevel(4);
    const l = generateLevel(4);
    expect(s.tubes).toEqual(l.tubes);
    expect(s.start).toEqual(l.tubes);
    expect(s).toMatchObject({ level: 4, par: l.par, history: [], won: false, capacity: 4 });
  });

  it('pours, undoes exactly (unlimited) and restarts', () => {
    let s = startLevel(20);
    const start = s.tubes;
    const trail: number[][][] = [s.tubes];
    for (let i = 0; i < 6; i++) {
      const m = legalMoves({ capacity: s.capacity, tubes: s.tubes })[0];
      if (!m) break;
      const r = pourMove(s, m.from, m.to);
      if (!r.ok) throw new Error(r.reason);
      expect(r.pour.amount).toBeGreaterThan(0);
      s = r.state;
      trail.push(s.tubes);
    }
    const made = s.history.length;
    expect(made).toBeGreaterThan(0);
    for (let i = made; i > 0; i--) {
      expect(s.tubes).toEqual(trail[i]);
      s = undo(s);
    }
    expect(s.tubes).toEqual(start);
    expect(undo(s)).toBe(s); // nothing left to undo
    const r = pourMove(
      s,
      legalMoves({ capacity: 4, tubes: s.tubes })[0]!.from,
      legalMoves({ capacity: 4, tubes: s.tubes })[0]!.to,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(restart(r.state).tubes).toEqual(start);
    expect(restart(r.state).history).toEqual([]);
  });

  it('rejects illegal pours with the board reason', () => {
    const s = startLevel(1);
    const empty = s.tubes.findIndex((t) => t.length === 0);
    expect(pourMove(s, empty, (empty + 1) % s.tubes.length)).toEqual({
      ok: false,
      reason: 'EMPTY_SOURCE',
    });
    expect(pourMove(s, 0, 0)).toEqual({ ok: false, reason: 'SAME_TUBE' });
  });

  it('detects the win and refuses further pours', () => {
    const s = followHints(startLevel(1));
    expect(s.won).toBe(true);
    expect(isSolved({ capacity: s.capacity, tubes: s.tubes })).toBe(true);
    expect(pourMove(s, 0, 1)).toEqual({ ok: false, reason: 'FINISHED' });
    expect(hint(s)).toEqual({ kind: 'none' });
    expect(undo(s).won).toBe(false);
  });

  it('flags a tube completed by a pour', () => {
    // Level 1 = [[],[0,0,0,4],[0,7,7,7],[],[7,4,4,4]]: 4 → tube 1 is not complete; follow hints and
    // check that some pour reports completedTube.
    let s = startLevel(1);
    let completed = 0;
    while (!s.won) {
      const h = hint(s);
      if (h.kind !== 'move') throw new Error(h.kind);
      const r = pourMove(s, h.from, h.to);
      if (!r.ok) throw new Error(r.reason);
      if (r.completedTube) completed++;
      s = r.state;
    }
    expect(completed).toBeGreaterThan(0);
  });
});

describe('hint', () => {
  it.each([1, 9, 33, 120, 250])(
    'level %i: following hints solves it in exactly par moves',
    (level) => {
      const s = followHints(startLevel(level));
      expect(s.won).toBe(true);
      expect(s.history.length).toBe(generateLevel(level).par);
    },
  );

  it('each hint is on a shortest path, also from off-path positions', () => {
    for (const level of [15, 64, 140]) {
      let s = startLevel(level);
      // Wander off the hinted path with a few arbitrary pours that keep the board solvable.
      for (let i = 0; i < 3; i++) {
        const moves = legalMoves({ capacity: s.capacity, tubes: s.tubes }).reverse();
        const next = moves
          .map((m) => pourMove(s, m.from, m.to))
          .find(
            (r) =>
              r.ok && solve({ capacity: s.capacity, tubes: r.state.tubes }).status === 'solved',
          );
        if (!next || !next.ok) break;
        s = next.state;
      }
      expect(s.history.length).toBe(3);
      for (let i = 0; i < 4 && !s.won; i++) {
        const before = optimalLength(s);
        const h = hint(s);
        expect(h.kind).toBe('move');
        if (h.kind !== 'move') break;
        expect(h.optimal).toBe(true);
        expect(h.movesLeft).toBe(before);
        const r = pourMove(s, h.from, h.to);
        if (!r.ok) throw new Error(r.reason);
        s = r.state;
        if (!s.won) expect(optimalLength(s)).toBe(before - 1);
      }
    }
  });

  it('suggests undo after pours that lead into a dead end', () => {
    // Always taking the last legal pour walks level 15 into a dead end within 3 pours.
    let s = startLevel(15);
    for (let i = 0; i < 3; i++) {
      const moves = legalMoves({ capacity: s.capacity, tubes: s.tubes });
      const m = moves[moves.length - 1];
      if (!m) break;
      const r = pourMove(s, m.from, m.to);
      if (r.ok) s = r.state;
    }
    expect(solve({ capacity: s.capacity, tubes: s.tubes }).status).toBe('unsolvable');
    expect(hint(s)).toEqual({ kind: 'undo' });
    // Undoing back to the start makes the hint useful again.
    while (s.history.length > 0) s = undo(s);
    expect(hint(s).kind).toBe('move');
  });

  it('suggests undo on a hand-made dead end', () => {
    const dead: PlayState = {
      level: 1,
      capacity: 2,
      colorCount: 2,
      par: 1,
      start: [
        [0, 1],
        [1, 0],
      ],
      tubes: [
        [0, 1],
        [1, 0],
      ],
      history: [],
      won: false,
    };
    expect(hint(dead)).toEqual({ kind: 'undo' });
  });
});

describe('resume from saved pours', () => {
  it('replays to the same board', () => {
    let s = startLevel(30);
    for (let i = 0; i < 3; i++) {
      const h = hint(s);
      if (h.kind !== 'move') throw new Error(h.kind);
      const r = pourMove(s, h.from, h.to);
      if (!r.ok) throw new Error(r.reason);
      s = r.state;
    }
    const back = resumeLevel(30, movesOf(s));
    expect(back.tubes).toEqual(s.tubes);
    expect(back.history).toEqual(s.history);
  });

  it('stops at the first illegal pour of a corrupt save', () => {
    const level = scrambleLevel(2);
    const empty = level.tubes.findIndex((t) => t.length === 0);
    const back = resumeLevel(2, [
      { from: empty, to: 0 },
      { from: 0, to: 1 },
    ]);
    expect(back.history).toEqual([]);
    expect(back.tubes).toEqual(level.tubes);
  });
});

describe('stars', () => {
  it('3★ within par + 2, 2★ within par + 2 + max(4, par/2), else 1★', () => {
    expect(starsFor(10, 10)).toBe(3);
    expect(starsFor(12, 10)).toBe(3);
    expect(starsFor(13, 10)).toBe(2);
    expect(starsFor(17, 10)).toBe(2);
    expect(starsFor(18, 10)).toBe(1);
    expect(starsFor(30, 20)).toBe(2);
    expect(starsFor(33, 20)).toBe(1);
  });
});
