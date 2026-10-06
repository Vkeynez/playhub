// Tic-tac-toe bot. It sees only the view (no hidden information exists here anyway).
// easy: a random empty cell. medium / hard: win > block > centre > corner > any.

import type { BotLevel, Rng, Seat } from '@gp/game-sdk/core';

import { emptyCells, winningCells } from '../logic/rules';
import type { PlaceAction, TicTacToeView } from '../logic/rules';

const CENTRE = 4;
const CORNERS = [0, 2, 6, 8];

export function chooseMove(
  view: TicTacToeView,
  seat: Seat,
  level: BotLevel,
  rng: Rng,
): PlaceAction {
  const open = emptyCells(view.board);
  if (open.length === 0) throw new Error('tic-tac-toe bot asked to move on a full board');
  if (level === 'easy') return { type: 'place', cell: rng.pick(open) };
  const win = winningCells(view.board, seat);
  if (win.length > 0) return { type: 'place', cell: rng.pick(win) };
  const block = winningCells(view.board, 1 - seat);
  if (block.length > 0) return { type: 'place', cell: rng.pick(block) };
  if (open.includes(CENTRE)) return { type: 'place', cell: CENTRE };
  const corners = CORNERS.filter((cell) => open.includes(cell));
  if (corners.length > 0) return { type: 'place', cell: rng.pick(corners) };
  return { type: 'place', cell: rng.pick(open) };
}
