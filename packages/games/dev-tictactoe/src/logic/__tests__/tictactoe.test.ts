import { deriveStream, seedFromInt } from '@gp/game-sdk/core';
import { contractSuite } from '@gp/game-sdk/testing';
import { describe, expect, it } from 'vitest';

import { chooseMove } from '../../bot';
import { ticTacToe } from '../index';
import type { Cell, TicTacToeView } from '../index';

contractSuite({ module: ticTacToe, maxActions: 9 });

function view(board: string): TicTacToeView {
  const cells: Cell[] = [...board].map((c) => (c === 'X' ? 0 : c === 'O' ? 1 : null));
  return { board: cells, turn: 0, winner: null, winLine: null, draw: false, you: 0 };
}

describe('tic-tac-toe bot', () => {
  const rng = deriveStream(seedFromInt(5), 'bot');

  it('medium and hard take a win before blocking', () => {
    for (const level of ['medium', 'hard'] as const) {
      expect(chooseMove(view('XX.OO....'), 0, level, rng)).toEqual({ type: 'place', cell: 2 });
    }
  });

  it('medium and hard block, then prefer the centre, then a corner', () => {
    expect(chooseMove(view('OO.X.....'), 0, 'hard', rng)).toEqual({ type: 'place', cell: 2 });
    expect(chooseMove(view('.........'), 0, 'medium', rng)).toEqual({ type: 'place', cell: 4 });
    expect([0, 2, 6, 8]).toContain(chooseMove(view('....O....'), 0, 'hard', rng).cell);
  });

  it('easy plays any empty cell', () => {
    for (let i = 0; i < 20; i++)
      expect([3, 8]).toContain(chooseMove(view('XXO.OXXO.'), 0, 'easy', rng).cell);
  });
});

describe('tic-tac-toe rules', () => {
  it('rejects taken cells and wrong turns with closed reasons', () => {
    const state = ticTacToe.init({
      config: {},
      mode: 'classic',
      seats: [],
      rng: deriveStream(seedFromInt(1), 'game'),
      now: 0,
    });
    expect(state.deadlineAt).toBe(30_000);
    const next = ticTacToe.reduce(state, { type: 'place', cell: 4 }, 0, {
      rng: deriveStream(seedFromInt(1), 'game'),
      now: 1,
    });
    expect(ticTacToe.validate(next.state, { type: 'place', cell: 4 }, 1)).toEqual({
      ok: false,
      reason: 'CELL_TAKEN',
    });
    expect(ticTacToe.validate(next.state, { type: 'place', cell: 0 }, 0)).toEqual({
      ok: false,
      reason: 'NOT_YOUR_TURN',
    });
  });
});
