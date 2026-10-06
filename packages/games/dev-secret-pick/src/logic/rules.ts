// Secret Pick rules and types: both seats pick 1–3 in secret; 2 beats 1, 3 beats 2, 1 beats 3.
// Best of 5: first to 3 round wins, or the most wins after 5 rounds. Pure: no randomness or time here.

import type { Hidden, Seat, Secret } from '@gp/game-sdk/core';

export const ROUNDS = 5;
export const WINS_NEEDED = 3;
/** How long a revealed round stays on screen before the next one starts (game ms). */
export const SHOW_MS = 2_000;
export const PICKS = [1, 2, 3] as const;

/** pick: waiting for picks · locked: both picked, reveal due · shown: round result on screen · done. */
export type Phase = 'pick' | 'locked' | 'shown' | 'done';

export interface RoundRecord {
  round: number;
  picks: number[];
  winner: Seat | null;
}

export interface SecretPickState {
  phase: Phase;
  round: number;
  /** This round's picks; each is visible only to the seat that made it until the reveal tick. */
  picks: (Secret<number> | null)[];
  deadlineAt: number | null;
  /** Game time of the next tick (reveal, or the next round); null in pick/done. */
  wakeAt: number | null;
  wins: number[];
  history: RoundRecord[];
  pickMs: number;
}

export interface PickAction {
  type: 'pick';
  value: number;
}

export interface SecretPickConfig {
  pickTimerSec?: number | undefined;
}

export type SecretPickEvent =
  /** `value` is null for everyone but the picker until the reveal. */
  | { type: 'picked'; seat: Seat; value: number | null }
  | { type: 'revealed'; round: number; picks: number[]; winner: Seat | null }
  | { type: 'round'; round: number }
  | { type: 'ended'; wins: number[] };

export interface SecretPickView {
  phase: Phase;
  round: number;
  picks: (number | Hidden | null)[];
  wins: number[];
  history: RoundRecord[];
  you: Seat | null;
}

export type SecretPickRejection = 'NOT_YOUR_TURN' | 'FINISHED' | 'ALREADY_PICKED';

/** The pick that beats `value`. */
export function counter(value: number): number {
  return (value % 3) + 1;
}

/** Winner of a round, or null for a tie. */
export function roundWinner(a: number, b: number): Seat | null {
  if (a === b) return null;
  return counter(b) === a ? 0 : 1;
}
