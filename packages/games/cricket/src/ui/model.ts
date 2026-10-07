// Pure view-model helpers for the Hand Cricket screen: no React, no platform imports, unit-tested.
import type { Seat } from '@gp/game-sdk/core';

import type { BallRecord, CricketView, InningsState, MatchOutcome, Phase } from '../logic/rules';

/** Finger extension, 0 = curled, 1 = straight: [thumb, index, middle, ring, pinky]. */
export type FingerPose = readonly [number, number, number, number, number];

export const FIST: FingerPose = [0, 0, 0, 0, 0];

/** Thumb straight up (a thumbs-up) vs splayed out beside an open hand. */
const THUMB_UP = 0.84;
const THUMB_SPLAY = 1.08;

/** Hand-cricket counting: 1–5 fingers from the index, 6 is the thumb alone ("thumbs up"). */
const POSES: Readonly<Record<number, FingerPose>> = {
  1: [0, 1, 0, 0, 0],
  2: [0, 1, 1, 0, 0],
  3: [0, 1, 1, 1, 0],
  4: [0, 1, 1, 1, 1],
  5: [THUMB_SPLAY, 1, 1, 1, 1],
  6: [THUMB_UP, 0, 0, 0, 0],
};

export function poseFor(value: number | null): FingerPose {
  return value === null ? FIST : (POSES[value] ?? FIST);
}

export function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

/** The seat drawn on the left (the viewer; seat 0 for spectators). */
export function homeSeat(view: CricketView): Seat {
  return view.you ?? 0;
}

export interface SeatPlayer {
  seat: Seat;
  name: string;
  bot: boolean;
}

/**
 * Labels per seat: "You" for your own seat; a human opponent (multiplayer) by name, otherwise
 * "Bot"; a spectator sees both players' names.
 */
export function seatNames(
  you: Seat | null,
  players: readonly SeatPlayer[] | undefined,
  labels: { you: string; bot: string },
): Record<number, string> {
  const home = you ?? 0;
  const away = otherSeat(home);
  const human = (seat: Seat) => players?.find((p) => p.seat === seat && !p.bot)?.name;
  return {
    [home]: you === null ? (human(home) ?? 'P1') : labels.you,
    [away]: human(away) ?? labels.bot,
  };
}

/** Cricket notation: 9 balls at 6 an over → "1.3". */
export function oversText(balls: number, perOver: number): string {
  return `${Math.floor(balls / perOver)}.${balls % perOver}`;
}

export type Role = 'bat' | 'bowl' | 'watch';

export function roleOf(view: CricketView): Role {
  const cur = view.current;
  if (view.you === null || cur === null) return 'watch';
  if (cur.batter === view.you) return 'bat';
  return cur.bowler === view.you ? 'bowl' : 'watch';
}

const REVEAL_PHASES: ReadonlySet<Phase> = new Set(['ball-result', 'done']);
const TOSS_SHOWN: ReadonlySet<Phase> = new Set(['toss-locked', 'toss-result', 'choose']);

export interface HandValues {
  home: number | null;
  away: number | null;
  /** Changes once per reveal: the animation trigger. null while both hands are fists. */
  key: string | null;
}

/** What each hand shows right now. Fists while picking; the revealed throws/picks afterwards. */
export function handValues(view: CricketView): HandValues {
  const home = homeSeat(view);
  const away = otherSeat(home);
  if (TOSS_SHOWN.has(view.phase) && view.toss.throws) {
    return {
      home: view.toss.throws[home] ?? null,
      away: view.toss.throws[away] ?? null,
      key: 'toss',
    };
  }
  const ball = view.lastBall;
  if (REVEAL_PHASES.has(view.phase) && ball) {
    const innings = view.innings[ball.innings - 1];
    if (innings) {
      const pickOf = (seat: Seat) => (seat === innings.batter ? ball.batterPick : ball.bowlerPick);
      return { home: pickOf(home), away: pickOf(away), key: ballKey(ball) };
    }
  }
  return { home: null, away: null, key: null };
}

export function ballKey(ball: BallRecord): string {
  return `b${ball.innings}.${ball.over}.${ball.ball}`;
}

export type FeedbackKind = 'out' | 'six' | 'four' | 'runs';

export interface BallFeedback {
  kind: FeedbackKind;
  runs: number;
  /** The viewer batted on this ball (null for spectators). */
  youBatted: boolean | null;
}

export function feedbackFor(view: CricketView, ball: BallRecord): BallFeedback {
  const batter = view.innings[ball.innings - 1]?.batter ?? null;
  const youBatted = view.you === null || batter === null ? null : batter === view.you;
  const kind: FeedbackKind =
    ball.outcome === 'out'
      ? 'out'
      : ball.outcome === 'six'
        ? 'six'
        : ball.runs === 4
          ? 'four'
          : 'runs';
  return { kind, runs: ball.runs, youBatted };
}

export interface TeamLine {
  seat: Seat;
  runs: number;
  wickets: number;
  balls: number;
  /** Has batted (or is batting). */
  batted: boolean;
  batting: boolean;
}

/** Scoreboard lines for [home, away]. */
export function teamLines(view: CricketView): [TeamLine, TeamLine] {
  const home = homeSeat(view);
  const line = (seat: Seat): TeamLine => {
    const inn: InningsState | undefined = view.innings.find((i) => i.batter === seat);
    return {
      seat,
      runs: inn?.runs ?? 0,
      wickets: inn?.wickets ?? 0,
      balls: inn?.balls ?? 0,
      batted: inn !== undefined,
      batting: view.current !== null && view.current.batter === seat && view.phase !== 'done',
    };
  };
  return [line(home), line(otherSeat(home))];
}

export interface Chase {
  target: number;
  runsNeeded: number;
  ballsLeft: number;
}

export function chaseOf(view: CricketView): Chase | null {
  const cur = view.current;
  if (!cur || cur.target === null || cur.runsNeeded === null || view.phase === 'done') return null;
  return { target: cur.target, runsNeeded: Math.max(0, cur.runsNeeded), ballsLeft: cur.ballsLeft };
}

export type ResultKey = 'tie' | 'wonByRuns' | 'wonByWickets' | 'lostByRuns' | 'lostByWickets';

export interface ResultLine {
  key: ResultKey;
  count: number;
  /** The winner from the viewer's side: null on a tie. */
  won: boolean | null;
}

export function resultLine(outcome: MatchOutcome, home: Seat): ResultLine {
  if (outcome.winner === null || outcome.margin === null)
    return { key: 'tie', count: 0, won: null };
  const won = outcome.winner === home;
  const byWickets = outcome.margin.kind === 'wickets';
  const key: ResultKey = won
    ? byWickets
      ? 'wonByWickets'
      : 'wonByRuns'
    : byWickets
      ? 'lostByWickets'
      : 'lostByRuns';
  return { key, count: outcome.margin.value, won };
}

/** A pick the viewer may submit now (phase + not yet picked). */
export function canPick(view: CricketView, pending: boolean): boolean {
  if (view.you === null || pending) return false;
  if (view.phase !== 'toss' && view.phase !== 'ball') return false;
  return view.picks[view.you] === null && view.awaiting.includes(view.you);
}

export function isAwaiting(view: CricketView, phase: Phase): boolean {
  return view.you !== null && view.phase === phase && view.awaiting.includes(view.you);
}

/** The opponent has locked a pick (secret) in this phase. */
export function opponentPicked(view: CricketView): boolean {
  const away = otherSeat(homeSeat(view));
  const pick = view.picks[away];
  return pick !== null && pick !== undefined;
}

/** Decimal digits of a non-negative integer, most significant first (min `width` digits). */
export function digitsOf(value: number, width = 1): number[] {
  const safe = Math.max(0, Math.floor(value));
  const text = String(safe).padStart(width, '0');
  return Array.from(text, (ch) => ch.charCodeAt(0) - 48);
}
