// Hand Cricket bot. It reads only its own view (revealed picks), so it can't peek at a hidden pick.
//
// easy:   uniform random.
// medium: avoids the opponent's last pick (batting: the bowler's; bowling: the batter's, unless the
//         batter just repeated a number, which it then bowls at) with mild randomness, and leans
//         towards high numbers when batting.
// hard:   models the opponent from revealed history: recency-weighted pick frequencies plus a
//         1st-order Markov chain (what they picked after their last pick before), with the other role's
//         picks as a weak prior. Bowling, it aims at the batter's likely pick; batting, it avoids the
//         bowler's likely pick and prefers high numbers when they are safe.

import type { BotLevel, Rng, Seat } from '@gp/game-sdk/core';

import { PICKS } from '../logic/rules';
import type { CricketAction, CricketView, CurrentInnings, Decision, Parity } from '../logic/rules';

const PARITIES: readonly Parity[] = ['odd', 'even'];
const DECISIONS: readonly Decision[] = ['bat', 'bowl'];

/** medium: chance of a plain random pick. */
const MEDIUM_NOISE = 0.2;
/** hard model weights. */
const BASE = 0.5;
const FREQ_W = 1;
const MARKOV_W = 1.5;
const PRIOR_W = 0.25;
const DECAY = 0.92;
/** hard bowler: sharpen the predicted distribution before sampling (higher = greedier). */
const SHARPEN = 4;
/** hard batter: softmax temperature over expected values, and run values used in them. */
const TEMPERATURE = 0.8;
const RUNS_PER_BALL = 2.9;
const WIN_VALUE = 40;

export function chooseAction(
  view: CricketView,
  seat: Seat,
  level: BotLevel,
  rng: Rng,
): CricketAction {
  switch (view.phase) {
    case 'call':
      return { type: 'call', call: rng.pick(PARITIES) };
    case 'choose':
      return { type: 'choose', decision: chooseDecision(level, rng) };
    case 'ball':
      if (view.current)
        return { type: 'pick', value: choosePick(view, view.current, seat, level, rng) };
      return { type: 'pick', value: rng.pick(PICKS) };
    default:
      return { type: 'pick', value: rng.pick(PICKS) };
  }
}

/** Chasing gives the batter a known target, so stronger bots prefer to bowl first. */
function chooseDecision(level: BotLevel, rng: Rng): Decision {
  if (level === 'easy') return rng.pick(DECISIONS);
  if (level === 'medium') return rng.float() < 0.7 ? 'bowl' : 'bat';
  return 'bowl';
}

function choosePick(
  view: CricketView,
  cur: CurrentInnings,
  seat: Seat,
  level: BotLevel,
  rng: Rng,
): number {
  if (level === 'easy') return rng.pick(PICKS);
  const batting = cur.batter === seat;
  const { sameRole, otherRole } = opponentPicks(view, cur, seat);
  if (level === 'medium') return mediumPick(sameRole, batting, rng);
  const probs = predict(sameRole, otherRole);
  return batting ? hardBat(probs, cur, rng) : hardBowl(probs, rng);
}

/**
 * The opponent's revealed picks, oldest first: in this innings (the role they play now), and in their
 * other role (the other innings plus their toss throw), which is only a weak prior.
 */
function opponentPicks(
  view: CricketView,
  cur: CurrentInnings,
  seat: Seat,
): { sameRole: number[]; otherRole: number[] } {
  const opponent = 1 - seat;
  const sameRole: number[] = [];
  const otherRole: number[] = [];
  for (const inn of view.innings) {
    const theyBat = inn.batter === opponent;
    const into = inn.number === cur.number ? sameRole : otherRole;
    for (const ball of inn.history) into.push(theyBat ? ball.batterPick : ball.bowlerPick);
  }
  const tossThrow = view.toss.throws?.[opponent];
  if (tossThrow !== undefined) otherRole.push(tossThrow);
  return { sameRole, otherRole };
}

function mediumPick(sameRole: readonly number[], batting: boolean, rng: Rng): number {
  if (rng.float() < MEDIUM_NOISE) return rng.pick(PICKS);
  const avoid = sameRole[sameRole.length - 1];
  // A batter who just repeated a number is bowled at; otherwise assume people rarely repeat.
  if (!batting && avoid !== undefined && avoid === sameRole[sameRole.length - 2]) return avoid;
  const weights = PICKS.map((v) => (v === avoid ? 0 : batting ? v + 3 : 1));
  return weightedPick(weights, rng);
}

/** P(opponent picks v) for v = 1..6, at index v - 1. */
export function predict(sameRole: readonly number[], otherRole: readonly number[]): number[] {
  const counts = [BASE, BASE, BASE, BASE, BASE, BASE];
  let weight = 1;
  for (let i = sameRole.length - 1; i >= 0; i--) {
    bump(counts, sameRole[i], FREQ_W * weight);
    weight *= DECAY;
  }
  for (const v of otherRole) bump(counts, v, PRIOR_W);
  const last = sameRole[sameRole.length - 1];
  if (last !== undefined) {
    weight = 1;
    for (let i = sameRole.length - 2; i >= 0; i--) {
      if (sameRole[i] === last) bump(counts, sameRole[i + 1], MARKOV_W * weight);
      weight *= DECAY;
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => c / total);
}

function bump(counts: number[], pick: number | undefined, by: number): void {
  if (pick === undefined || pick < 1 || pick > 6) return;
  counts[pick - 1] = (counts[pick - 1] ?? 0) + by;
}

/** Bowling: match the batter. Sample from the sharpened prediction (near-greedy when they're predictable). */
function hardBowl(probs: readonly number[], rng: Rng): number {
  return weightedPick(
    probs.map((p) => p ** SHARPEN),
    rng,
  );
}

/**
 * Batting: maximise (1 − P(match)) × value − P(match) × cost of a wicket. In a chase any pick that reaches
 * the target is worth a win. A softmax keeps it from being trivially predictable.
 */
function hardBat(probs: readonly number[], cur: CurrentInnings, rng: Rng): number {
  const future = Math.max(0, cur.ballsLeft - 1) * RUNS_PER_BALL;
  const lastWicket = cur.wicketsLeft <= 1;
  const wicketCost = lastWicket
    ? cur.runsNeeded !== null
      ? WIN_VALUE
      : future
    : future / cur.wicketsLeft;
  const scores = PICKS.map((v, i) => {
    const p = probs[i] ?? 0;
    const value = cur.runsNeeded !== null && v >= cur.runsNeeded ? WIN_VALUE : v;
    return (1 - p) * value - p * wicketCost;
  });
  const best = Math.max(...scores);
  return weightedPick(
    scores.map((s) => Math.exp((s - best) / TEMPERATURE)),
    rng,
  );
}

/** A pick 1..6 with probability proportional to weights[v - 1]. */
function weightedPick(weights: readonly number[], rng: Rng): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return rng.pick(PICKS);
  let r = rng.float() * total;
  for (let i = 0; i < PICKS.length; i++) {
    r -= weights[i] ?? 0;
    if (r < 0) return PICKS[i] ?? 1;
  }
  return PICKS[PICKS.length - 1] ?? 6;
}
