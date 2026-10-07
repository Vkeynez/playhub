import { describe, expect, it } from 'vitest';

import {
  canonicalKey,
  checkPour,
  isPourError,
  isSolved,
  legalMoves,
  mixScore,
  pour,
  pourAmount,
  topRunLength,
} from '../index';
import type { Board } from '../index';

const b = (tubes: number[][], capacity = 4): Board => ({ capacity, tubes });

describe('pour rules', () => {
  it('moves the whole top run onto an empty tube', () => {
    const r = pour(b([[0, 1, 1], []]), 0, 1);
    expect(isPourError(r)).toBe(false);
    if (isPourError(r)) return;
    expect(r.board.tubes).toEqual([[0], [1, 1]]);
    expect(r).toMatchObject({ color: 1, amount: 2 });
  });

  it('moves onto a matching top colour', () => {
    const r = pour(
      b([
        [2, 1],
        [0, 1],
      ]),
      0,
      1,
    );
    expect(isPourError(r) ? r : r.board.tubes).toEqual([[2], [0, 1, 1]]);
  });

  it('moves only what fits (partial pour)', () => {
    const board = b([
      [0, 1, 1, 1],
      [2, 2, 1],
    ]);
    expect(pourAmount(board, 0, 1)).toBe(1);
    const r = pour(board, 0, 1);
    expect(isPourError(r) ? r : r.board.tubes).toEqual([
      [0, 1, 1],
      [2, 2, 1, 1],
    ]);
  });

  it('refuses illegal pours with a closed reason', () => {
    const board = b([[0, 1], [0, 2], [3, 3, 3, 1], []]);
    expect(checkPour(board, 0, 1)).toBe('COLOR_MISMATCH');
    expect(checkPour(board, 0, 2)).toBe('TARGET_FULL');
    expect(checkPour(board, 3, 0)).toBe('EMPTY_SOURCE');
    expect(checkPour(board, 1, 1)).toBe('SAME_TUBE');
    expect(checkPour(board, 0, 9)).toBe('BAD_TUBE');
    expect(checkPour(board, -1, 0)).toBe('BAD_TUBE');
    expect(checkPour(board, 0.5, 0)).toBe('BAD_TUBE');
    expect(pour(board, 0, 1)).toBe('COLOR_MISMATCH');
    expect(pourAmount(board, 0, 1)).toBe(0);
  });

  it('does not mutate the input board', () => {
    const board = b([[0, 1], []]);
    const snapshot = JSON.stringify(board);
    pour(board, 0, 1);
    expect(JSON.stringify(board)).toBe(snapshot);
  });

  it('lists legal moves', () => {
    expect(legalMoves(b([[0, 1], [1], []]))).toEqual([
      { from: 0, to: 1 },
      { from: 0, to: 2 },
      { from: 1, to: 0 },
      { from: 1, to: 2 },
    ]);
  });
});

describe('win detection', () => {
  it('is solved when every tube is empty or full of one colour', () => {
    expect(isSolved(b([[0, 0, 0, 0], [], [1, 1, 1, 1]]))).toBe(true);
    expect(isSolved(b([[0, 0, 0], [0], [1, 1, 1, 1]]))).toBe(false);
    expect(isSolved(b([[0, 0, 0, 1], [1, 1, 1, 0], []]))).toBe(false);
  });

  it('mixScore is 0 exactly when solved', () => {
    expect(mixScore(b([[0, 0, 0, 0], []]))).toBe(0);
    expect(
      mixScore(
        b([
          [0, 0],
          [0, 0],
        ]),
      ),
    ).toBe(1);
    expect(
      mixScore(
        b([
          [0, 1, 0, 1],
          [1, 0, 1, 0],
        ]),
      ),
    ).toBe(6);
  });
});

describe('helpers', () => {
  it('topRunLength counts the contiguous top colour', () => {
    expect(topRunLength([])).toBe(0);
    expect(topRunLength([1, 0, 0])).toBe(2);
    expect(topRunLength([0, 0, 0, 0])).toBe(4);
  });

  it('canonicalKey ignores tube order', () => {
    expect(canonicalKey(b([[0, 1], [], [2]]))).toBe(canonicalKey(b([[2], [0, 1], []])));
    expect(canonicalKey(b([[0, 1], []]))).not.toBe(canonicalKey(b([[1, 0], []])));
  });
});
