// One level in play: pour, undo (unlimited), restart and hint. Pure: every call returns a new state.

import { checkPour, isSolved, isTubeComplete, pour, isPourError } from './board';
import type { Board, Move, PourError } from './board';
import { generateLevel } from './generator';
import { solve } from './solver';

/** Expansions a hint may spend on the shortest-solution phase, then on the greedy fallback. */
export const HINT_NODE_BUDGET = 20_000;
export const HINT_GREEDY_BUDGET = 40_000;

/** A pour that happened: enough to animate it and to undo it exactly. */
export interface PourRecord {
  from: number;
  to: number;
  color: number;
  amount: number;
}

export interface PlayState {
  level: number;
  capacity: number;
  colorCount: number;
  par: number;
  /** The level's starting tubes (bottom → top colour ids). */
  start: number[][];
  /** Current tubes. */
  tubes: number[][];
  /** Pours since the start (undo pops these). `history.length` is the move count. */
  history: PourRecord[];
  won: boolean;
}

export type PourOutcome =
  | {
      ok: true;
      state: PlayState;
      pour: PourRecord;
      /** The target tube just became full of one colour (small celebration). */
      completedTube: boolean;
      /** This pour solved the level. */
      won: boolean;
    }
  | { ok: false; reason: PourError | 'FINISHED' };

export type Hint =
  /** Pour `from` → `to`. `optimal`: on a shortest solution; `movesLeft`: that solution's length. */
  | { kind: 'move'; from: number; to: number; optimal: boolean; movesLeft: number }
  /** The board is a proven dead end: undo (or restart) to continue. */
  | { kind: 'undo' }
  /** Nothing to suggest: already solved, or the solver ran out of budget. */
  | { kind: 'none' };

function boardOf(state: PlayState): Board {
  return { capacity: state.capacity, tubes: state.tubes };
}

function copyTubes(tubes: readonly (readonly number[])[]): number[][] {
  return tubes.map((t) => t.slice());
}

/** A fresh attempt at `level`. */
export function startLevel(level: number): PlayState {
  const l = generateLevel(level);
  return {
    level,
    capacity: l.capacity,
    colorCount: l.colorCount,
    par: l.par,
    start: copyTubes(l.tubes),
    tubes: copyTubes(l.tubes),
    history: [],
    won: false,
  };
}

export function moveCount(state: PlayState): number {
  return state.history.length;
}

/** Targets `from` can legally pour into right now (for highlighting after the first tap). */
export function legalTargets(state: PlayState, from: number): number[] {
  const board = boardOf(state);
  const out: number[] = [];
  for (let to = 0; to < state.tubes.length; to++) {
    if (checkPour(board, from, to) === null) out.push(to);
  }
  return out;
}

export function pourMove(state: PlayState, from: number, to: number): PourOutcome {
  if (state.won) return { ok: false, reason: 'FINISHED' };
  const r = pour(boardOf(state), from, to);
  if (isPourError(r)) return { ok: false, reason: r };
  const record: PourRecord = { from, to, color: r.color, amount: r.amount };
  const tubes = copyTubes(r.board.tubes);
  const won = isSolved(r.board);
  const next: PlayState = { ...state, tubes, history: [...state.history, record], won };
  return {
    ok: true,
    state: next,
    pour: record,
    completedTube: isTubeComplete(tubes[to] as number[], state.capacity),
    won,
  };
}

/** Takes back the last pour exactly (unlimited). Returns the same state when there is nothing to undo. */
export function undo(state: PlayState): PlayState {
  const last = state.history[state.history.length - 1];
  if (!last) return state;
  const tubes = copyTubes(state.tubes);
  const to = tubes[last.to] as number[];
  to.length -= last.amount;
  const from = tubes[last.from] as number[];
  for (let i = 0; i < last.amount; i++) from.push(last.color);
  return { ...state, tubes, history: state.history.slice(0, -1), won: false };
}

/** Back to the starting board (the move count resets). */
export function restart(state: PlayState): PlayState {
  return { ...state, tubes: copyTubes(state.start), history: [], won: false };
}

/**
 * The next pour of a shortest solution from the current board (A* within `HINT_NODE_BUDGET`), else of
 * some solution (greedy fallback). Typically a few ms; worst generated level ~0.1 s on V8.
 */
export function hint(state: PlayState): Hint {
  if (state.won) return { kind: 'none' };
  const r = solve(boardOf(state), {
    maxNodes: HINT_NODE_BUDGET,
    maxGreedyNodes: HINT_GREEDY_BUDGET,
  });
  if (r.status === 'solved') {
    const first = r.moves[0];
    if (!first) return { kind: 'none' };
    return {
      kind: 'move',
      from: first.from,
      to: first.to,
      optimal: r.optimal,
      movesLeft: r.moves.length,
    };
  }
  if (r.status === 'unsolvable') return { kind: 'undo' };
  return { kind: 'none' };
}

/** The pours made so far as (from, to) pairs: what the save stores for Continue. */
export function movesOf(state: PlayState): Move[] {
  return state.history.map((h) => ({ from: h.from, to: h.to }));
}

/**
 * Rebuilds a level in progress from its saved pours. Replay stops at the first pour that is illegal
 * (a corrupt or foreign save), so the result is always a reachable board.
 */
export function resumeLevel(level: number, moves: readonly Move[]): PlayState {
  let state = startLevel(level);
  for (const m of moves) {
    const r = pourMove(state, m.from, m.to);
    if (!r.ok) break;
    state = r.state;
  }
  return state;
}

/** Star rule: 3★ within par + 2 pours; 2★ within par + 2 + max(4, par / 2); else 1★. */
export function starsFor(moves: number, par: number): 1 | 2 | 3 {
  if (moves <= par + 2) return 3;
  const half = (par / 2) | 0;
  if (moves <= par + 2 + (half > 4 ? half : 4)) return 2;
  return 1;
}
