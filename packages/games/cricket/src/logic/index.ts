// Hand Cricket GameModule. Picks (toss throws and ball picks) are Secret<number> owned by their seat;
// a tick reveals both together once both are in (a timeout auto-picks from the game stream).
// State machine: call → toss → toss-locked → toss-result → choose → innings-start → (ball → ball-locked →
// ball-result)* → innings-start (innings 2) → (ball …)* → done. See README.md.

import { defineGame, findMode, isSecret, project, secret } from '@gp/game-sdk/core';
import type { MatchResult, Seat, Validation, Viewer } from '@gp/game-sdk/core';
import { z } from 'zod';

import { chooseAction } from '../bot';
import { manifest } from '../manifest';
import {
  BALLS_PER_OVER,
  ballOutcome,
  DECIDE_MS,
  decide,
  DEFAULT_OVERS,
  DEFAULT_PICK_MS,
  DEFAULT_WICKETS,
  emptyStats,
  INNINGS_INTRO_MS,
  inningsOver,
  isPick,
  OUT_SHOW_MS,
  PICKS,
  RUNS_SHOW_MS,
  TOSS_CALLER,
  TOSS_SHOW_MS,
  tossWinner,
} from './rules';
import type {
  BallRecord,
  CricketAction,
  CricketConfig,
  CricketEvent,
  CricketRejection,
  CricketState,
  CricketView,
  CurrentInnings,
  Decision,
  InningsState,
  Parity,
  Phase,
  SeatStats,
} from './rules';

export * from './rules';
export { HAND_CRICKET } from '../manifest';

const SEATS: readonly Seat[] = [0, 1];
const PARITIES: readonly Parity[] = ['odd', 'even'];
const DECISIONS: readonly Decision[] = ['bat', 'bowl'];
/** Phases that end on a tick at `wakeAt`. */
const TIMED: readonly Phase[] = [
  'toss-locked',
  'toss-result',
  'innings-start',
  'ball-locked',
  'ball-result',
];

export const configSchema: z.ZodType<CricketConfig> = z.object({
  wickets: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(DEFAULT_WICKETS),
  overs: z.union([z.literal(1), z.literal(2), z.literal(5)]).default(DEFAULT_OVERS),
});

export const actionSchema: z.ZodType<CricketAction> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('call'), call: z.enum(['odd', 'even']) }),
  z.object({ type: z.literal('pick'), value: z.number().int().min(1).max(6) }),
  z.object({ type: z.literal('choose'), decision: z.enum(['bat', 'bowl']) }),
]);

function reject(reason: CricketRejection): Validation {
  return { ok: false, reason };
}

function awaitedSeats(state: CricketState): Seat[] {
  switch (state.phase) {
    case 'call':
      return [state.toss.caller];
    case 'choose':
      return state.toss.winner === null ? [] : [state.toss.winner];
    case 'toss':
    case 'ball':
      return SEATS.filter((seat) => state.picks[seat] === null);
    default:
      return [];
  }
}

function lastInnings(state: CricketState): InningsState | null {
  return state.innings[state.innings.length - 1] ?? null;
}

function newInnings(number: number, batter: Seat, target: number | null): InningsState {
  return {
    number,
    batter,
    bowler: 1 - batter,
    runs: 0,
    wickets: 0,
    balls: 0,
    target,
    sinceWicket: 0,
    history: [],
  };
}

function pickValue(state: CricketState, seat: Seat): number {
  const pick = state.picks[seat];
  return pick && isPick(pick.value) ? pick.value : 1;
}

function addStats(stats: SeatStats[], seat: Seat, delta: Partial<SeatStats>): SeatStats[] {
  return stats.map((s, i) => {
    if (i !== seat) return s;
    const next = { ...s };
    for (const key of Object.keys(delta) as (keyof SeatStats)[]) next[key] += delta[key] ?? 0;
    return next;
  });
}

/** The ball-locked tick: reveal both picks together and score the ball. */
function revealBall(
  state: CricketState,
  now: number,
): { state: CricketState; events: CricketEvent[] } {
  const inn = lastInnings(state);
  if (!inn) return { state, events: [] };
  const batterPick = pickValue(state, inn.batter);
  const bowlerPick = pickValue(state, inn.bowler);
  const outcome = ballOutcome(batterPick, bowlerPick);
  const out = outcome === 'out';
  const runs = out ? 0 : batterPick;
  const ball: BallRecord = {
    innings: inn.number,
    over: Math.floor(inn.balls / BALLS_PER_OVER),
    ball: (inn.balls % BALLS_PER_OVER) + 1,
    batterPick,
    bowlerPick,
    outcome,
    runs,
  };
  const updated: InningsState = {
    ...inn,
    runs: inn.runs + runs,
    wickets: inn.wickets + (out ? 1 : 0),
    balls: inn.balls + 1,
    sinceWicket: out ? 0 : inn.sinceWicket + runs,
    history: [...inn.history, ball],
  };
  let stats = addStats(state.stats, inn.batter, {
    runs,
    ballsFaced: 1,
    sixes: outcome === 'six' ? 1 : 0,
    ducks: out && inn.sinceWicket === 0 ? 1 : 0,
  });
  stats = addStats(stats, inn.bowler, {
    ballsBowled: 1,
    runsConceded: runs,
    wicketsTaken: out ? 1 : 0,
  });
  const innings = [...state.innings.slice(0, -1), updated];
  const events: CricketEvent[] = [
    { type: 'ball', ball, runs: updated.runs, wickets: updated.wickets },
  ];
  const base: CricketState = {
    ...state,
    picks: [null, null],
    innings,
    lastBall: ball,
    stats,
    deadlineAt: null,
  };
  if (inningsOver(updated, state.wickets, state.overs)) {
    events.push({
      type: 'innings-end',
      innings: updated.number,
      runs: updated.runs,
      wickets: updated.wickets,
      balls: updated.balls,
    });
    const first = innings[0];
    if (updated.number === 2 && first) {
      const result = decide(first, updated, state.wickets);
      events.push({
        type: 'ended',
        outcome: result,
        scores: stats.map((s) => s.runs),
      });
      return { state: { ...base, phase: 'done', wakeAt: null, outcome: result }, events };
    }
  }
  return {
    state: { ...base, phase: 'ball-result', wakeAt: now + (out ? OUT_SHOW_MS : RUNS_SHOW_MS) },
    events,
  };
}

function currentView(state: CricketState): CurrentInnings | null {
  const inn = lastInnings(state);
  if (!inn) return null;
  const total = state.overs * BALLS_PER_OVER;
  const showingLast = (state.phase === 'ball-result' || state.phase === 'done') && inn.balls > 0;
  const over = showingLast
    ? Math.floor((inn.balls - 1) / BALLS_PER_OVER)
    : Math.min(Math.floor(inn.balls / BALLS_PER_OVER), state.overs - 1);
  return {
    number: inn.number,
    batter: inn.batter,
    bowler: inn.bowler,
    runs: inn.runs,
    wickets: inn.wickets,
    balls: inn.balls,
    target: inn.target,
    runsNeeded: inn.target === null ? null : Math.max(0, inn.target - inn.runs),
    ballsLeft: total - inn.balls,
    wicketsLeft: state.wickets - inn.wickets,
    over,
    thisOver: inn.history.filter((b) => b.over === over).map((b) => ({ ...b })),
  };
}

function viewFor(state: CricketState, viewer: Viewer): CricketView {
  return {
    you: viewer.kind === 'seat' ? viewer.seat : null,
    mode: state.mode,
    phase: state.phase,
    rules: {
      wickets: state.wickets,
      overs: state.overs,
      ballsPerOver: BALLS_PER_OVER,
      pickMs: state.pickMs,
    },
    deadlineAt: state.deadlineAt,
    awaiting: awaitedSeats(state),
    toss: { ...state.toss, throws: state.toss.throws ? [...state.toss.throws] : null },
    picks: project(state.picks, viewer),
    innings: state.innings.map((inn) => ({ ...inn, history: inn.history.map((b) => ({ ...b })) })),
    current: currentView(state),
    lastBall: state.lastBall ? { ...state.lastBall } : null,
    stats: state.stats.map((s) => ({ ...s })),
    outcome: state.outcome
      ? { ...state.outcome, margin: state.outcome.margin ? { ...state.outcome.margin } : null }
      : null,
  };
}

function result(state: CricketState): MatchResult | null {
  const outcome = state.outcome;
  if (state.phase !== 'done' || !outcome) return null;
  return {
    placements: SEATS.map((seat) => ({
      seat,
      place: outcome.winner === null || outcome.winner === seat ? 1 : 2,
      score: state.stats[seat]?.runs ?? 0,
    })),
  };
}

function invariants(state: CricketState): string[] {
  const issues: string[] = [];
  const picking = state.phase === 'toss' || state.phase === 'ball';
  const locked = state.phase === 'toss-locked' || state.phase === 'ball-locked';
  state.picks.forEach((pick, seat) => {
    if (pick === null) return;
    if (!isSecret(pick) || pick.owner !== seat)
      issues.push(`pick ${seat} must be a Secret owned by seat ${seat}`);
    if (!isPick(pick.value)) issues.push(`pick ${seat} out of range`);
  });
  if (state.picks.length !== 2) issues.push('picks must have one slot per seat');
  if (!picking && !locked && state.picks.some((p) => p !== null))
    issues.push(`picks must be empty in ${state.phase}`);
  if (picking && state.picks.every((p) => p !== null)) issues.push('both picked but not locked');
  if (locked && state.picks.some((p) => p === null)) issues.push('locked with a missing pick');
  if (awaitedSeats(state).length > 0 !== (state.deadlineAt !== null))
    issues.push('a deadline must be set exactly when a seat is awaited');
  if (TIMED.includes(state.phase) !== (state.wakeAt !== null))
    issues.push('wakeAt must be set exactly in timed phases');

  const { toss } = state;
  if (toss.caller !== TOSS_CALLER) issues.push('the joiner (seat 1) calls the toss');
  const tossDone =
    state.phase !== 'call' && state.phase !== 'toss' && state.phase !== 'toss-locked';
  if (tossDone !== (toss.winner !== null && toss.throws !== null))
    issues.push('the toss winner is known exactly after the toss reveal');
  if (state.phase !== 'call' && toss.call === null) issues.push('toss call missing');
  if (toss.throws && toss.call && toss.winner !== null) {
    const sum = toss.throws.reduce((a, b) => a + b, 0);
    if (tossWinner(toss.call, sum, toss.caller) !== toss.winner) issues.push('wrong toss winner');
  }

  const [first, second] = state.innings;
  if (state.innings.length > 2) issues.push('more than two innings');
  if (state.innings.length > 0 !== (toss.decision !== null))
    issues.push('innings start exactly when the toss decision is made');
  if (first && toss.winner !== null && toss.decision !== null) {
    const batter = toss.decision === 'bat' ? toss.winner : 1 - toss.winner;
    if (first.batter !== batter) issues.push('innings 1 batter does not follow the toss decision');
  }
  if (second && first) {
    if (second.batter !== first.bowler) issues.push('innings 2 must swap roles');
    if (second.target !== first.runs + 1) issues.push('innings 2 target must be innings 1 + 1');
    if (!inningsOver(first, state.wickets, state.overs))
      issues.push('innings 2 started before innings 1 ended');
  }
  state.innings.forEach((inn, i) => {
    const label = `innings ${i + 1}`;
    if (inn.number !== i + 1) issues.push(`${label} numbered ${inn.number}`);
    if (inn.bowler !== 1 - inn.batter) issues.push(`${label}: batter and bowler must differ`);
    if (inn.balls !== inn.history.length) issues.push(`${label}: balls disagree with history`);
    if (inn.runs !== inn.history.reduce((a, b) => a + b.runs, 0))
      issues.push(`${label}: runs disagree with history`);
    if (inn.wickets !== inn.history.filter((b) => b.outcome === 'out').length)
      issues.push(`${label}: wickets disagree with history`);
    if (inn.wickets > state.wickets) issues.push(`${label}: too many wickets`);
    if (inn.balls > state.overs * BALLS_PER_OVER) issues.push(`${label}: too many balls`);
    if (inn.target !== null && inn.history.length > 0) {
      const before = inn.runs - (inn.history[inn.history.length - 1]?.runs ?? 0);
      if (before >= inn.target) issues.push(`${label}: chase continued past the target`);
    }
    inn.history.forEach((b, n) => {
      if (
        b.outcome !== ballOutcome(b.batterPick, b.bowlerPick) ||
        b.runs !== (b.outcome === 'out' ? 0 : b.batterPick)
      )
        issues.push(`${label} ball ${n + 1}: wrong outcome`);
      if (b.over !== Math.floor(n / BALLS_PER_OVER) || b.ball !== (n % BALLS_PER_OVER) + 1)
        issues.push(`${label} ball ${n + 1}: wrong over/ball`);
    });
    if (
      i === 0 &&
      !second &&
      inningsOver(inn, state.wickets, state.overs) &&
      state.phase !== 'ball-result'
    )
      issues.push('innings 1 ended but innings 2 has not started');
  });

  SEATS.forEach((seat) => {
    const s = state.stats[seat];
    if (!s) {
      issues.push(`stats missing for seat ${seat}`);
      return;
    }
    const batted = state.innings.filter((inn) => inn.batter === seat);
    const bowled = state.innings.filter((inn) => inn.bowler === seat);
    const sum = (list: InningsState[], f: (inn: InningsState) => number) =>
      list.reduce((a, inn) => a + f(inn), 0);
    if (s.runs !== sum(batted, (inn) => inn.runs)) issues.push(`stats[${seat}].runs`);
    if (s.ballsFaced !== sum(batted, (inn) => inn.balls)) issues.push(`stats[${seat}].ballsFaced`);
    if (s.ballsBowled !== sum(bowled, (inn) => inn.balls))
      issues.push(`stats[${seat}].ballsBowled`);
    if (s.runsConceded !== sum(bowled, (inn) => inn.runs))
      issues.push(`stats[${seat}].runsConceded`);
    if (s.wicketsTaken !== sum(bowled, (inn) => inn.wickets))
      issues.push(`stats[${seat}].wicketsTaken`);
    if (
      s.sixes !==
      batted.reduce((a, inn) => a + inn.history.filter((b) => b.outcome === 'six').length, 0)
    )
      issues.push(`stats[${seat}].sixes`);
    if (s.ducks > sum(batted, (inn) => inn.wickets)) issues.push(`stats[${seat}].ducks`);
  });

  const decided =
    second !== undefined && first !== undefined && inningsOver(second, state.wickets, state.overs);
  if ((state.phase === 'done') !== decided) issues.push('done must hold exactly when decided');
  if ((state.phase === 'done') !== (state.outcome !== null))
    issues.push('outcome must be set exactly when done');
  if (decided && first && second && state.outcome) {
    const expected = decide(first, second, state.wickets);
    if (JSON.stringify(expected) !== JSON.stringify(state.outcome)) issues.push('wrong outcome');
  }
  return issues;
}

/** The Cricket module. Modes dispatch on `state.mode` (only 'hand-cricket' until Phase 3). */
export const cricket = defineGame<
  CricketState,
  CricketAction,
  CricketConfig,
  CricketView,
  CricketEvent
>({
  manifest,
  stateVersion: 1,
  configSchema,
  actionSchema,

  init({ config, mode, now }) {
    const pickMs = (findMode(manifest, mode).turnTimerSec ?? DEFAULT_PICK_MS / 1000) * 1000;
    return {
      mode,
      phase: 'call',
      wickets: config.wickets ?? DEFAULT_WICKETS,
      overs: config.overs ?? DEFAULT_OVERS,
      pickMs,
      deadlineAt: now + DECIDE_MS,
      wakeAt: null,
      toss: { caller: TOSS_CALLER, call: null, throws: null, winner: null, decision: null },
      picks: [null, null],
      innings: [],
      lastBall: null,
      stats: [emptyStats(), emptyStats()],
      outcome: null,
    };
  },

  awaiting(state) {
    const seats = awaitedSeats(state);
    return { seats, deadlineAt: seats.length > 0 ? state.deadlineAt : null };
  },

  wakeAt(state) {
    return TIMED.includes(state.phase) ? state.wakeAt : null;
  },

  legalActions(state, seat) {
    if (!awaitedSeats(state).includes(seat)) return [];
    switch (state.phase) {
      case 'call':
        return PARITIES.map((call) => ({ type: 'call', call }));
      case 'choose':
        return DECISIONS.map((decision) => ({ type: 'choose', decision }));
      case 'toss':
      case 'ball':
        return PICKS.map((value) => ({ type: 'pick', value }));
      default:
        return [];
    }
  },

  validate(state, action, seat) {
    if (state.phase === 'done') return reject('FINISHED');
    if (!awaitedSeats(state).includes(seat)) {
      const picking = state.phase === 'toss' || state.phase === 'ball';
      return reject(picking && state.picks[seat] ? 'ALREADY_PICKED' : 'NOT_YOUR_TURN');
    }
    switch (action.type) {
      case 'call':
        return state.phase === 'call' && PARITIES.includes(action.call)
          ? { ok: true }
          : reject('ILLEGAL');
      case 'choose':
        return state.phase === 'choose' && DECISIONS.includes(action.decision)
          ? { ok: true }
          : reject('ILLEGAL');
      case 'pick':
        return (state.phase === 'toss' || state.phase === 'ball') && isPick(action.value)
          ? { ok: true }
          : reject('ILLEGAL');
      default:
        return reject('ILLEGAL');
    }
  },

  reduce(state, action, seat, ctx) {
    if (action.type === 'call' && state.phase === 'call') {
      return {
        state: {
          ...state,
          phase: 'toss',
          toss: { ...state.toss, call: action.call },
          deadlineAt: ctx.now + state.pickMs,
        },
        events: [{ type: 'called', seat, call: action.call }],
      };
    }
    if (action.type === 'choose' && state.phase === 'choose') {
      const batter = action.decision === 'bat' ? seat : 1 - seat;
      const first = newInnings(1, batter, null);
      return {
        state: {
          ...state,
          phase: 'innings-start',
          toss: { ...state.toss, decision: action.decision },
          innings: [first],
          deadlineAt: null,
          wakeAt: ctx.now + INNINGS_INTRO_MS,
        },
        events: [
          { type: 'chose', seat, decision: action.decision },
          { type: 'innings-start', innings: 1, batter, bowler: first.bowler, target: null },
        ],
      };
    }
    if (action.type === 'pick' && (state.phase === 'toss' || state.phase === 'ball')) {
      const picks = state.picks.map((pick, i) => (i === seat ? secret(seat, action.value) : pick));
      const events: CricketEvent[] = [{ type: 'picked', seat, value: action.value }];
      if (picks.some((pick) => pick === null)) return { state: { ...state, picks }, events };
      // Both picks are in: lock them and reveal on the next tick (a decision boundary for the room layer).
      return {
        state: {
          ...state,
          picks,
          phase: state.phase === 'toss' ? 'toss-locked' : 'ball-locked',
          deadlineAt: null,
          wakeAt: ctx.now,
        },
        events,
      };
    }
    return { state, events: [] };
  },

  tick(state, ctx) {
    switch (state.phase) {
      case 'toss-locked': {
        const throws = SEATS.map((seat) => pickValue(state, seat));
        const sum = throws.reduce((a, b) => a + b, 0);
        const winner = tossWinner(state.toss.call ?? 'odd', sum, state.toss.caller);
        return {
          state: {
            ...state,
            phase: 'toss-result',
            toss: { ...state.toss, throws, winner },
            picks: [null, null],
            wakeAt: ctx.now + TOSS_SHOW_MS,
          },
          events: [{ type: 'toss', throws, sum, winner }],
        };
      }
      case 'toss-result':
        return {
          state: { ...state, phase: 'choose', deadlineAt: ctx.now + DECIDE_MS, wakeAt: null },
          events: [],
        };
      case 'innings-start':
        return {
          state: { ...state, phase: 'ball', deadlineAt: ctx.now + state.pickMs, wakeAt: null },
          events: [],
        };
      case 'ball-locked':
        return revealBall(state, ctx.now);
      case 'ball-result': {
        const inn = lastInnings(state);
        if (inn && inn.number === 1 && inningsOver(inn, state.wickets, state.overs)) {
          const second = newInnings(2, inn.bowler, inn.runs + 1);
          return {
            state: {
              ...state,
              phase: 'innings-start',
              innings: [...state.innings, second],
              wakeAt: ctx.now + INNINGS_INTRO_MS,
            },
            events: [
              {
                type: 'innings-start',
                innings: 2,
                batter: second.batter,
                bowler: second.bowler,
                target: second.target,
              },
            ],
          };
        }
        return {
          state: { ...state, phase: 'ball', deadlineAt: ctx.now + state.pickMs, wakeAt: null },
          events: [],
        };
      }
      default:
        return { state, events: [] };
    }
  },

  onTimeout(state, _seat, rng) {
    // OQ D5: a timed-out pick is random (game stream); the engine counts it towards the AFK rule.
    switch (state.phase) {
      case 'call':
        return { type: 'call', call: rng.pick(PARITIES) };
      case 'choose':
        return { type: 'choose', decision: rng.pick(DECISIONS) };
      default:
        return { type: 'pick', value: rng.pick(PICKS) };
    }
  },

  result,
  viewFor,

  eventFor(event, viewer) {
    if (event.type === 'picked' && !(viewer.kind === 'seat' && viewer.seat === event.seat)) {
      return { type: 'picked', seat: event.seat, value: null };
    }
    return event;
  },

  invariants,

  bot: { choose: chooseAction },
});
