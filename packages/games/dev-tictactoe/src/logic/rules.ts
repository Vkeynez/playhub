// Tic-tac-toe rules and types. Pure: no randomness or time here.

import type { Seat } from '@gp/game-sdk/core';

/** A cell holds the seat that marked it (0 = X, 1 = O), or null. */
export type Cell = Seat | null;

export interface TicTacToeState {
  board: Cell[];
  turn: Seat;
  /** Game time the current turn times out at; null once finished. */
  deadlineAt: number | null;
  turnMs: number;
  winner: Seat | null;
  winLine: number[] | null;
  draw: boolean;
}

export interface PlaceAction {
  type: 'place';
  cell: number;
}

export interface TicTacToeConfig {
  turnTimerSec?: number | undefined;
}

export type TicTacToeEvent =
  | { type: 'placed'; seat: Seat; cell: number; timedOut: boolean }
  | { type: 'ended'; winner: Seat | null; line: number[] | null };

/** No hidden information: every viewer gets the same board. `you` is the viewer's seat, if any. */
export interface TicTacToeView {
  board: Cell[];
  turn: Seat;
  winner: Seat | null;
  winLine: number[] | null;
  draw: boolean;
  you: Seat | null;
}

export type TicTacToeRejection = 'NOT_YOUR_TURN' | 'FINISHED' | 'CELL_TAKEN';

export const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function emptyCells(board: readonly Cell[]): number[] {
  const cells: number[] = [];
  board.forEach((cell, index) => {
    if (cell === null) cells.push(index);
  });
  return cells;
}

/** The completed line for `seat`, if any. */
export function winningLine(board: readonly Cell[], seat: Seat): number[] | null {
  for (const line of LINES) {
    if (line.every((cell) => board[cell] === seat)) return [...line];
  }
  return null;
}

export function isFinished(state: TicTacToeState): boolean {
  return state.winner !== null || state.draw;
}

/** Cells where `seat` would complete a line right now. */
export function winningCells(board: readonly Cell[], seat: Seat): number[] {
  return emptyCells(board).filter((cell) => {
    const next = [...board];
    next[cell] = seat;
    return winningLine(next, seat) !== null;
  });
}
