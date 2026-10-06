// Hand Cricket rules and types (BUILD_BRIEF §7.1, OQ D1–D5, D30). Pure: no randomness or time here.
//
// Toss: the joiner (seat 1) calls odd/even, both show 1–6 in secret, the sum's parity decides, and the
// winner chooses to bat or bowl. Each ball: both pick 1–6 in secret; equal = the batter is OUT, otherwise
// the batter scores their own number. 6 balls an over, no extras. An innings ends on all wickets or all
// overs; the chase also ends the moment the target is passed. Higher score wins; equal scores draw.

import type { Hidden, Seat, Secret } from '@gp/game-sdk/core';

export const PICKS = [1, 2, 3, 4, 5, 6] as const;
export const BALLS_PER_OVER = 6;
/** OQ D1: the joiner calls odd/even. */
export const TOSS_CALLER: Seat = 1;
export const WICKET_OPTIONS = [1, 2, 3] as const;
export const OVER_OPTIONS = [1, 2, 5] as const;
export const DEFAULT_WICKETS: CricketConfig['wickets'] = 2;
export const DEFAULT_OVERS: CricketConfig['overs'] = 2;

/** Pick deadline when the mode sets no turn timer (game ms). */
export const DEFAULT_PICK_MS = 5_000;
/** Deadline for the toss call and the bat/bowl choice (game ms). */
export const DECIDE_MS = 10_000;
/** How long the toss result stays on screen (game ms). */
export const TOSS_SHOW_MS = 2_000;
/** Reveal pause after a scoring ball, and after a wicket (stumps-flying animation). */
export const RUNS_SHOW_MS = 1_600;
export const OUT_SHOW_MS = 2_600;
/** The "Innings 1: you bat" / "Target 23" splash before an innings' first ball. */
export const INNINGS_INTRO_MS = 2_500;

export type Parity = 'odd' | 'even';
export type Decision = 'bat' | 'bowl';
export type BallOutcome = 'out' | 'runs' | 'six';

/**
 * call: the toss caller calls odd/even · toss: both throw 1–6 in secret · toss-locked: both thrown,
 * reveal due · toss-result: toss shown · choose: the toss winner picks bat/bowl · innings-start: splash
 * before an innings · ball: both pick in secret · ball-locked: both picked, reveal due · ball-result:
 * the ball's outcome on screen · done.
 */
export type Phase =
  | 'call'
  | 'toss'
  | 'toss-locked'
  | 'toss-result'
  | 'choose'
  | 'innings-start'
  | 'ball'
  | 'ball-locked'
  | 'ball-result'
  | 'done';

export interface CricketConfig {
  wickets: 1 | 2 | 3;
  overs: 1 | 2 | 5;
}

export interface TossState {
  caller: Seat;
  call: Parity | null;
  /** Both throws, published together at the reveal; null until then. */
  throws: number[] | null;
  winner: Seat | null;
  decision: Decision | null;
}

/** One revealed delivery. Picks are public once a ball is revealed. */
export interface BallRecord {
  /** 1 or 2. */
  innings: number;
  /** 0-based over index. */
  over: number;
  /** 1–6 within the over. */
  ball: number;
  batterPick: number;
  bowlerPick: number;
  outcome: BallOutcome;
  /** Runs off this ball (0 when out). */
  runs: number;
}

export interface InningsState {
  /** 1 or 2. */
  number: number;
  batter: Seat;
  bowler: Seat;
  runs: number;
  wickets: number;
  /** Legal balls bowled (no extras in Hand Cricket). */
  balls: number;
  /** Runs needed to win (innings 2 only): innings 1 runs + 1. */
  target: number | null;
  /** Runs since the last wicket: the current "batsman's" score, for ducks. */
  sinceWicket: number;
  history: BallRecord[];
}

/** Per-seat match stats (brief §7.1 stats: runs, highest score, sixes, ducks, best economy). */
export interface SeatStats {
  runs: number;
  ballsFaced: number;
  sixes: number;
  /** Dismissals for 0 (each wicket is one "batsman"). */
  ducks: number;
  wicketsTaken: number;
  ballsBowled: number;
  runsConceded: number;
}

export type EndReason = 'chased' | 'defended' | 'tie';

export interface MatchOutcome {
  /** null = draw (OQ D2). */
  winner: Seat | null;
  reason: EndReason;
  /** "won by 12 runs" / "won by 2 wickets"; null for a tie. */
  margin: { kind: 'runs' | 'wickets'; value: number } | null;
}

export interface CricketState {
  mode: string;
  phase: Phase;
  wickets: number;
  overs: number;
  pickMs: number;
  /** Deadline of the current decision (game time); null when nobody is awaited. */
  deadlineAt: number | null;
  /** Game time of the next tick (a reveal, or the end of a pause); null otherwise. */
  wakeAt: number | null;
  toss: TossState;
  /** This ball's (or the toss's) picks; each is visible only to its own seat until the reveal tick. */
  picks: (Secret<number> | null)[];
  innings: InningsState[];
  lastBall: BallRecord | null;
  stats: SeatStats[];
  outcome: MatchOutcome | null;
}

export type CricketAction =
  | { type: 'call'; call: Parity }
  | { type: 'pick'; value: number }
  | { type: 'choose'; decision: Decision };

export type CricketEvent =
  | { type: 'called'; seat: Seat; call: Parity }
  /** `value` is null for everyone but the picker until the reveal. */
  | { type: 'picked'; seat: Seat; value: number | null }
  | { type: 'toss'; throws: number[]; sum: number; winner: Seat }
  | { type: 'chose'; seat: Seat; decision: Decision }
  | { type: 'innings-start'; innings: number; batter: Seat; bowler: Seat; target: number | null }
  | { type: 'ball'; ball: BallRecord; runs: number; wickets: number }
  | { type: 'innings-end'; innings: number; runs: number; wickets: number; balls: number }
  | { type: 'ended'; outcome: MatchOutcome; scores: number[] };

export type CricketRejection = 'NOT_YOUR_TURN' | 'FINISHED' | 'ILLEGAL' | 'ALREADY_PICKED';

/** The innings being played (or about to start / just finished), as the UI and bots need it. */
export interface CurrentInnings {
  number: number;
  batter: Seat;
  bowler: Seat;
  runs: number;
  wickets: number;
  balls: number;
  target: number | null;
  /** null outside a chase. */
  runsNeeded: number | null;
  ballsLeft: number;
  wicketsLeft: number;
  /** 0-based over of the next ball (or of the last ball while its result is on screen). */
  over: number;
  /** Revealed balls of that over. */
  thisOver: BallRecord[];
}

export interface CricketView {
  you: Seat | null;
  mode: string;
  phase: Phase;
  rules: { wickets: number; overs: number; ballsPerOver: number; pickMs: number };
  /** Game time. For a countdown use the engine meta's wall-clock `awaiting.deadlineAt`. */
  deadlineAt: number | null;
  /** Seats the game is waiting on right now. */
  awaiting: Seat[];
  toss: TossState;
  /** Per seat: null = not picked yet, { hidden: true } = picked (secret), number = your own pick. */
  picks: (number | Hidden | null)[];
  innings: InningsState[];
  current: CurrentInnings | null;
  /** The most recently revealed ball, for the reveal animation ('out' | 'runs' | 'six'). */
  lastBall: BallRecord | null;
  stats: SeatStats[];
  outcome: MatchOutcome | null;
}

export function emptyStats(): SeatStats {
  return {
    runs: 0,
    ballsFaced: 0,
    sixes: 0,
    ducks: 0,
    wicketsTaken: 0,
    ballsBowled: 0,
    runsConceded: 0,
  };
}

export function isPick(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6;
}

/** Equal = OUT; otherwise the batter scores their own number. */
export function ballOutcome(batterPick: number, bowlerPick: number): BallOutcome {
  if (batterPick === bowlerPick) return 'out';
  return batterPick === 6 ? 'six' : 'runs';
}

/** The toss winner: the caller wins when the sum's parity matches the call. */
export function tossWinner(call: Parity, sum: number, caller: Seat): Seat {
  const parity: Parity = sum % 2 === 0 ? 'even' : 'odd';
  return parity === call ? caller : 1 - caller;
}

/** All wickets down, all overs bowled, or (in a chase) the target reached. */
export function inningsOver(innings: InningsState, wickets: number, overs: number): boolean {
  return (
    innings.wickets >= wickets ||
    innings.balls >= overs * BALLS_PER_OVER ||
    (innings.target !== null && innings.runs >= innings.target)
  );
}

/** The result once both innings are complete (or the chase is won). */
export function decide(first: InningsState, second: InningsState, wickets: number): MatchOutcome {
  if (second.runs > first.runs) {
    return {
      winner: second.batter,
      reason: 'chased',
      margin: { kind: 'wickets', value: wickets - second.wickets },
    };
  }
  if (second.runs < first.runs) {
    return {
      winner: first.batter,
      reason: 'defended',
      margin: { kind: 'runs', value: first.runs - second.runs },
    };
  }
  return { winner: null, reason: 'tie', margin: null };
}
