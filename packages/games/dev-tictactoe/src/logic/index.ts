// dev-tictactoe GameModule: the reference turn-based module (no hidden information, turn timer).

import { defineGame, findMode } from '@gp/game-sdk/core';
import type { Validation } from '@gp/game-sdk/core';
import { z } from 'zod';

import { chooseMove } from '../bot';
import { manifest } from '../manifest';
import { emptyCells, isFinished, winningLine } from './rules';
import type {
  PlaceAction,
  TicTacToeConfig,
  TicTacToeEvent,
  TicTacToeRejection,
  TicTacToeState,
  TicTacToeView,
} from './rules';

export * from './rules';

const DEFAULT_TURN_SEC = 30;

function reject(reason: TicTacToeRejection): Validation {
  return { ok: false, reason };
}

export const ticTacToe = defineGame<
  TicTacToeState,
  PlaceAction,
  TicTacToeConfig,
  TicTacToeView,
  TicTacToeEvent
>({
  manifest,
  stateVersion: 1,
  configSchema: z.object({ turnTimerSec: z.number().int().min(5).max(300).optional() }),
  actionSchema: z.object({ type: z.literal('place'), cell: z.number().int().min(0).max(8) }),

  init({ config, mode, now }) {
    const turnSec =
      config.turnTimerSec ?? findMode(manifest, mode).turnTimerSec ?? DEFAULT_TURN_SEC;
    const turnMs = turnSec * 1000;
    return {
      board: Array<null>(9).fill(null),
      turn: 0,
      deadlineAt: now + turnMs,
      turnMs,
      winner: null,
      winLine: null,
      draw: false,
    };
  },

  awaiting(state) {
    return isFinished(state)
      ? { seats: [], deadlineAt: null }
      : { seats: [state.turn], deadlineAt: state.deadlineAt };
  },

  legalActions(state, seat) {
    if (isFinished(state) || seat !== state.turn) return [];
    return emptyCells(state.board).map((cell) => ({ type: 'place', cell }));
  },

  validate(state, action, seat) {
    if (isFinished(state)) return reject('FINISHED');
    if (seat !== state.turn) return reject('NOT_YOUR_TURN');
    if (state.board[action.cell] !== null) return reject('CELL_TAKEN');
    return { ok: true };
  },

  reduce(state, action, seat, ctx) {
    const board = [...state.board];
    board[action.cell] = seat;
    const line = winningLine(board, seat);
    const draw = line === null && emptyCells(board).length === 0;
    const finished = line !== null || draw;
    const timedOut = ctx.now >= (state.deadlineAt ?? Infinity);
    const events: TicTacToeEvent[] = [{ type: 'placed', seat, cell: action.cell, timedOut }];
    if (finished) events.push({ type: 'ended', winner: line ? seat : null, line });
    return {
      state: {
        ...state,
        board,
        turn: finished ? state.turn : 1 - seat,
        deadlineAt: finished ? null : ctx.now + state.turnMs,
        winner: line ? seat : null,
        winLine: line,
        draw,
      },
      events,
    };
  },

  onTimeout(state, _seat, rng) {
    return { type: 'place', cell: rng.pick(emptyCells(state.board)) };
  },

  result(state) {
    if (state.winner !== null) {
      return {
        placements: [0, 1].map((seat) => ({
          seat,
          place: seat === state.winner ? 1 : 2,
          score: null,
        })),
      };
    }
    if (state.draw) return { placements: [0, 1].map((seat) => ({ seat, place: 1, score: null })) };
    return null;
  },

  viewFor(state, viewer) {
    return {
      board: [...state.board],
      turn: state.turn,
      winner: state.winner,
      winLine: state.winLine ? [...state.winLine] : null,
      draw: state.draw,
      you: viewer.kind === 'seat' ? viewer.seat : null,
    };
  },

  eventFor(event) {
    return event;
  },

  invariants(state) {
    const issues: string[] = [];
    const x = state.board.filter((cell) => cell === 0).length;
    const o = state.board.filter((cell) => cell === 1).length;
    if (state.board.length !== 9) issues.push('board must have 9 cells');
    if (x - o !== 0 && x - o !== 1) issues.push(`X/O counts out of step (${x}/${o})`);
    if (!isFinished(state) && state.turn !== (x === o ? 0 : 1))
      issues.push('turn does not match the board');
    if (state.winner !== null && winningLine(state.board, state.winner) === null)
      issues.push('winner without a line');
    if (state.draw && (emptyCells(state.board).length > 0 || state.winner !== null))
      issues.push('bad draw');
    if (isFinished(state) !== (state.deadlineAt === null))
      issues.push('deadline must be cleared exactly at the end');
    return issues;
  },

  bot: { choose: chooseMove },
});
