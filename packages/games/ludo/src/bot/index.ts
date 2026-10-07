// Ludo bot. It reads only the public view: `view.moves` already lists each legal move with its captures,
// safety and home flags, so ranking is a single pass.
//
// Priority (brief §7.2): capture > reach safety > enter home > advance the furthest token.
// - medium: that order; opening a token (on a 6) ranks just above plain advancing.
// - hard:   the same, but "reach safety" only counts for a token that is actually threatened, and a
//           destination within 1..6 squares in front of an opponent token is penalised.
// - easy:   plays a random legal move 40% of the time, else the medium choice.
// Rolling is the only action in phase 'roll'.

import type { BotLevel, Rng, Seat } from '@gp/game-sdk/core';

import { LAST_TRACK, TRACK_LENGTH } from '../logic/rules';
import type { LudoAction, LudoView, MoveOption, SeatView } from '../logic/rules';

const EASY_RANDOM = 0.4;
const CAPTURE = 10_000;
const SAFETY = 1_000;
const ENTER_HOME = 200;
const REACH_HOME = 100;
const OPEN = 60;
const DANGER = 40;

export function chooseAction(view: LudoView, seat: Seat, level: BotLevel, rng: Rng): LudoAction {
  const moves = view.moves;
  if (view.phase !== 'move' || view.turn !== seat || moves.length === 0) return { type: 'roll' };
  const [first] = moves;
  if (!first) return { type: 'roll' };
  if (level === 'easy' && rng.float() < EASY_RANDOM) return toAction(rng.pick(moves));
  let best = first;
  let bestScore = -Infinity;
  for (const option of moves) {
    const score = scoreMove(view, option, level === 'hard');
    if (score > bestScore) {
      best = option;
      bestScore = score;
    }
  }
  return toAction(best);
}

function toAction(option: MoveOption): LudoAction {
  return { type: 'move', token: option.token };
}

/** Higher is better. Exported for tests. */
export function scoreMove(view: LudoView, option: MoveOption, careful: boolean): number {
  let score = 0;
  if (option.captures.length > 0) {
    score += CAPTURE;
    for (const victim of option.captures)
      score += view.seats[victim.seat]?.tokens[victim.token]?.progress ?? 0;
  }
  const owner = view.seats[option.owner];
  const fromSquare = owner?.tokens[option.token]?.square ?? null;
  const fromUnsafe = fromSquare !== null && !view.safeSquares.includes(fromSquare);
  // Reaching safety = a vulnerable token landing on a safe square (the home column is its own tier).
  const toSafeSquare = option.safe && !option.entersColumn;
  if (toSafeSquare && fromUnsafe && (!careful || threatened(view, option.owner, fromSquare))) {
    score += SAFETY;
  }
  if (option.entersColumn) score += ENTER_HOME;
  if (option.reachesHome) score += REACH_HOME;
  if (option.opens) score += OPEN;
  else score += option.from;
  if (careful && !option.safe) {
    const toSquare = option.path[option.path.length - 1]?.square ?? null;
    if (toSquare !== null && threatened(view, option.owner, toSquare)) score -= DANGER;
  }
  return score;
}

function sameSide(view: LudoView, a: SeatView, owner: Seat): boolean {
  if (a.seat === owner) return true;
  const other = view.seats[owner];
  return a.team !== null && other !== undefined && a.team === other.team;
}

/** An opponent token sits 1..6 squares behind `square` and can still travel that far on the track. */
export function threatened(view: LudoView, owner: Seat, square: number): boolean {
  if (view.safeSquares.includes(square)) return false;
  for (const seatView of view.seats) {
    if (sameSide(view, seatView, owner)) continue;
    for (const token of seatView.tokens) {
      if (token.square === null) continue;
      const gap = (square - token.square + TRACK_LENGTH) % TRACK_LENGTH;
      if (gap >= 1 && gap <= 6 && token.progress + gap <= LAST_TRACK) return true;
    }
  }
  return false;
}
