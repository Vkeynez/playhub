// Ludo GameModule (classic Indian rules, 2–4 seats, 2v2 teams at 4). Everything is public: no Secret<T>.
// State machine: roll → (move | auto-pass) → roll … → done. The engine's game Rng rolls the die; the roll
// action carries no value. See README.md.

import { defineGame, findMode } from '@gp/game-sdk/core';
import type { MatchResult, Seat, Validation, Viewer } from '@gp/game-sdk/core';
import { z } from 'zod';

import { chooseAction } from '../bot';
import { manifest } from '../manifest';
import {
  allHome,
  BASE,
  colourIndex,
  controlledSeat,
  DEFAULT_RULES,
  DEFAULT_TURN_MS,
  emptyStats,
  HOME,
  isPoint,
  isSafeSquare,
  legalMoves,
  partnerOf,
  progressPercent,
  safeSquares,
  sameSide,
  seatColours,
  spotOf,
  squareOf,
  startSquare,
  teamOf,
  TOKENS_PER_SEAT,
} from './rules';
import type {
  BonusReason,
  LudoAction,
  LudoConfig,
  LudoEvent,
  LudoRejection,
  LudoRules,
  LudoState,
  LudoView,
  SeatStats,
  SeatView,
} from './rules';

export * from './rules';
export { CLASSIC } from '../manifest';

const MIN_SEATS = 2;
const MAX_SEATS = 4;

export const configSchema: z.ZodType<LudoConfig> = z.object({
  needSixToOpen: z.boolean().default(DEFAULT_RULES.needSixToOpen),
  threeSixesCancel: z.boolean().default(DEFAULT_RULES.threeSixesCancel),
  captureBonus: z.boolean().default(DEFAULT_RULES.captureBonus),
  safeSquares: z.boolean().default(DEFAULT_RULES.safeSquares),
  homeBonus: z.boolean().default(DEFAULT_RULES.homeBonus),
  exactFinish: z.boolean().default(DEFAULT_RULES.exactFinish),
  teams: z.boolean().default(false),
});

export const actionSchema: z.ZodType<LudoAction> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('roll') }),
  z.object({
    type: z.literal('move'),
    token: z
      .number()
      .int()
      .min(0)
      .max(TOKENS_PER_SEAT - 1),
  }),
]);

type Step = { state: LudoState; events: LudoEvent[] };

function reject(reason: LudoRejection): Validation {
  return { ok: false, reason };
}

function seatCount(state: LudoState): number {
  return state.colours.length;
}

function isFinished(state: LudoState, seat: Seat): boolean {
  return state.finished.includes(seat);
}

/** The next seat clockwise. In free-for-all, finished seats are skipped; in teams they roll for partners. */
function nextSeat(state: LudoState, from: Seat): Seat {
  const n = seatCount(state);
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (state.teams || !isFinished(state, seat)) return seat;
  }
  return from;
}

function addStats(stats: SeatStats[], seat: Seat, delta: Partial<SeatStats>): SeatStats[] {
  return stats.map((s, i) => {
    if (i !== seat) return s;
    const next = { ...s };
    for (const key of Object.keys(delta) as (keyof SeatStats)[]) next[key] += delta[key] ?? 0;
    return next;
  });
}

function passTurn(
  state: LudoState,
  now: number,
  events: LudoEvent[],
  reason: 'moved' | 'no-move' | 'three-sixes',
): Step {
  const from = state.turn;
  const to = nextSeat(state, from);
  events.push(
    reason === 'three-sixes'
      ? { type: 'turn-cancelled', seat: from, to, reason }
      : { type: 'turn-passed', from, to, reason },
  );
  return {
    state: {
      ...state,
      phase: 'roll',
      turn: to,
      roll: null,
      sixes: 0,
      deadlineAt: now + state.turnMs,
    },
    events,
  };
}

/** Match over? Teams: both partners of one side finished. Free-for-all: at most one seat still playing. */
function isOver(state: LudoState): boolean {
  if (state.teams) {
    return state.finished.some((seat) => {
      const partner = partnerOf(state, seat);
      return partner !== null && isFinished(state, partner);
    });
  }
  return seatCount(state) - state.finished.length <= 1;
}

function computePlaces(state: LudoState): number[] {
  const n = seatCount(state);
  if (state.teams) {
    const winner = state.finished.find((seat) => {
      const partner = partnerOf(state, seat);
      return partner !== null && isFinished(state, partner);
    });
    return Array.from({ length: n }, (_, seat) =>
      winner !== undefined && sameSide(state, seat, winner) ? 1 : 2,
    );
  }
  const rest = state.finished.length + 1;
  return Array.from({ length: n }, (_, seat) => {
    const at = state.finished.indexOf(seat);
    return at >= 0 ? at + 1 : rest;
  });
}

function roll(state: LudoState, seat: Seat, value: number, now: number): Step {
  const sixes = value === 6 ? state.sixes + 1 : 0;
  const events: LudoEvent[] = [{ type: 'rolled', seat, value, sixes }];
  const rolled: LudoState = {
    ...state,
    lastRoll: { seat, value },
    stats: addStats(state.stats, seat, { rolls: 1, sixes: value === 6 ? 1 : 0 }),
  };
  if (state.rules.threeSixesCancel && sixes >= 3)
    return passTurn(rolled, now, events, 'three-sixes');
  const waiting: LudoState = {
    ...rolled,
    phase: 'move',
    roll: value,
    sixes,
    deadlineAt: now + state.turnMs,
  };
  if (legalMoves(waiting).length > 0) return { state: waiting, events };
  // No legal move (even on a 6): the turn passes.
  return passTurn(waiting, now, events, 'no-move');
}

function move(state: LudoState, seat: Seat, token: number, now: number): Step {
  const option = legalMoves(state).find((m) => m.token === token);
  if (!option) return { state, events: [] };
  const { owner } = option;
  const events: LudoEvent[] = [
    {
      type: 'moved',
      seat,
      owner,
      token,
      from: option.from,
      to: option.to,
      path: option.path.map((s) => ({ ...s })),
    },
  ];
  const tokens = state.tokens.map((row) => [...row]);
  const ownRow = tokens[owner];
  if (ownRow) ownRow[token] = option.to;
  let stats = state.stats;
  const square = squareOf(state.colours[owner] ?? 'red', option.to);
  for (const victim of option.captures) {
    const row = tokens[victim.seat];
    if (row) row[victim.token] = BASE;
    stats = addStats(stats, victim.seat, { lost: 1 });
    events.push({
      type: 'captured',
      seat,
      owner,
      victim: victim.seat,
      token: victim.token,
      square: square ?? 0,
    });
  }
  if (option.captures.length > 0)
    stats = addStats(stats, seat, { captures: option.captures.length });

  let finished = state.finished;
  if (option.reachesHome) {
    events.push({ type: 'entered-home', seat, owner, token });
    if (allHome(tokens[owner] ?? []) && !finished.includes(owner)) {
      finished = [...finished, owner];
      events.push({ type: 'finished', seat: owner, place: finished.length });
    }
  }
  const moved: LudoState = { ...state, tokens, stats, finished };

  if (isOver(moved)) {
    const places = computePlaces(moved);
    events.push({
      type: 'ended',
      places,
      winners: places.flatMap((place, s) => (place === 1 ? [s] : [])),
    });
    return {
      state: { ...moved, phase: 'done', roll: null, deadlineAt: null, places },
      events,
    };
  }

  const reasons: BonusReason[] = [];
  if (state.roll === 6) reasons.push('six');
  if (option.captures.length > 0 && state.rules.captureBonus) reasons.push('capture');
  if (option.reachesHome && state.rules.homeBonus) reasons.push('home');
  // In free-for-all a seat that just finished is out of the rotation, bonus or not.
  const out = !moved.teams && isFinished(moved, seat);
  if (reasons.length > 0 && !out) {
    events.push({ type: 'bonus-roll', seat, reasons });
    return {
      state: { ...moved, phase: 'roll', roll: null, deadlineAt: now + state.turnMs },
      events,
    };
  }
  return passTurn(moved, now, events, 'moved');
}

function seatView(state: LudoState, seat: Seat): SeatView {
  const colour = state.colours[seat] ?? 'red';
  const tokens = state.tokens[seat] ?? [];
  const at = state.finished.indexOf(seat);
  return {
    seat,
    colour,
    team: teamOf(state, seat),
    partner: partnerOf(state, seat),
    start: startSquare(colour),
    tokens: tokens.map((progress, token) => ({ token, ...spotOf(colour, progress) })),
    inBase: tokens.filter((p) => p === BASE).length,
    home: tokens.filter((p) => p === HOME).length,
    progress: progressPercent(tokens),
    finished: at >= 0,
    finishedAt: at >= 0 ? at + 1 : null,
    stats: { ...(state.stats[seat] ?? emptyStats()) },
  };
}

function viewFor(state: LudoState, viewer: Viewer): LudoView {
  const done = state.phase === 'done';
  return {
    you: viewer.kind === 'seat' ? viewer.seat : null,
    mode: state.mode,
    phase: state.phase,
    rules: { ...state.rules },
    teams: state.teams,
    turnMs: state.turnMs,
    turn: state.turn,
    controls: controlledSeat(state, state.turn),
    awaiting: done ? [] : [state.turn],
    deadlineAt: state.deadlineAt,
    roll: state.roll,
    lastRoll: state.lastRoll ? { ...state.lastRoll } : null,
    sixes: state.sixes,
    safeSquares: safeSquares(state.rules),
    seats: state.colours.map((_, seat) => seatView(state, seat)),
    moves: legalMoves(state),
    finished: [...state.finished],
    places: state.places ? [...state.places] : null,
    winners: state.places ? state.places.flatMap((p, s) => (p === 1 ? [s] : [])) : null,
  };
}

function result(state: LudoState): MatchResult | null {
  if (state.phase !== 'done' || !state.places) return null;
  return {
    placements: state.places.map((place, seat) => ({
      seat,
      place,
      score: (state.tokens[seat] ?? []).filter((p) => p === HOME).length,
    })),
  };
}

function invariants(state: LudoState): string[] {
  const issues: string[] = [];
  const n = seatCount(state);
  if (n < MIN_SEATS || n > MAX_SEATS) issues.push(`seat count ${n} out of range`);
  if (state.teams && n !== 4) issues.push('teams need exactly 4 seats');
  if (new Set(state.colours).size !== n) issues.push('seat colours must be distinct');
  if (state.colours.some((c) => colourIndex(c) < 0)) issues.push('unknown colour');
  if (state.tokens.length !== n) issues.push('one token row per seat');
  if (state.stats.length !== n) issues.push('one stats row per seat');
  state.tokens.forEach((row, seat) => {
    if (row.length !== TOKENS_PER_SEAT) issues.push(`seat ${seat} must have 4 tokens`);
    if (row.some((p) => !Number.isInteger(p) || p < BASE || p > HOME))
      issues.push(`seat ${seat} has a token out of range`);
  });
  if (!Number.isInteger(state.turn) || state.turn < 0 || state.turn >= n)
    issues.push('turn seat out of range');

  // Finished seats are exactly those with every token home, each listed once.
  const allIn = state.tokens.flatMap((row, seat) => (allHome(row) ? [seat] : []));
  if (new Set(state.finished).size !== state.finished.length)
    issues.push('finished has duplicates');
  if (allIn.length !== state.finished.length || allIn.some((s) => !state.finished.includes(s)))
    issues.push('finished disagrees with the tokens');

  if ((state.phase === 'move') !== (state.roll !== null)) issues.push('roll set exactly in move');
  if (state.roll !== null && !isPoint(state.roll)) issues.push('roll out of range');
  if (state.phase === 'move' && legalMoves(state).length === 0)
    issues.push('move phase without a legal move');
  if (state.sixes < 0 || (state.rules.threeSixesCancel && state.sixes > 2))
    issues.push('sixes out of range');
  if (state.lastRoll && !isPoint(state.lastRoll.value)) issues.push('lastRoll out of range');
  if (state.phase === 'move' && state.lastRoll?.value !== state.roll)
    issues.push('pending roll must be the last roll');
  if ((state.phase === 'done') !== (state.deadlineAt === null))
    issues.push('a deadline must be set exactly while a seat is awaited');

  // Captures guarantee: an unsafe track square never holds tokens of two sides.
  const sideAt = new Map<number, Seat>();
  state.tokens.forEach((row, seat) => {
    const colour = state.colours[seat];
    if (!colour) return;
    for (const p of row) {
      const square = squareOf(colour, p);
      if (square === null || isSafeSquare(state.rules, square)) continue;
      const other = sideAt.get(square);
      if (other === undefined) sideAt.set(square, seat);
      else if (!sameSide(state, other, seat))
        issues.push(`square ${square} holds seats ${other} and ${seat}`);
    }
  });

  const captures = state.stats.reduce((a, s) => a + s.captures, 0);
  const lost = state.stats.reduce((a, s) => a + s.lost, 0);
  if (captures !== lost) issues.push('captures and losses disagree');

  const over = isOver(state);
  if ((state.phase === 'done') !== over)
    issues.push('done must hold exactly when the match is over');
  if ((state.phase === 'done') !== (state.places !== null))
    issues.push('places set exactly when done');
  if (state.phase !== 'done' && !state.teams && isFinished(state, state.turn))
    issues.push('a finished seat holds the turn in free-for-all');
  if (state.places) {
    if (state.places.length !== n) issues.push('one place per seat');
    if (JSON.stringify(state.places) !== JSON.stringify(computePlaces(state)))
      issues.push('wrong places');
  }
  return issues;
}

/** The Ludo module. */
export const ludo = defineGame<LudoState, LudoAction, LudoConfig, LudoView, LudoEvent>({
  manifest,
  stateVersion: 1,
  configSchema,
  actionSchema,

  init({ config, mode, seats, now }) {
    const n = Math.min(MAX_SEATS, Math.max(MIN_SEATS, seats.length));
    const turnMs = (findMode(manifest, mode).turnTimerSec ?? DEFAULT_TURN_MS / 1000) * 1000;
    const rules: LudoRules = {
      needSixToOpen: config.needSixToOpen ?? DEFAULT_RULES.needSixToOpen,
      threeSixesCancel: config.threeSixesCancel ?? DEFAULT_RULES.threeSixesCancel,
      captureBonus: config.captureBonus ?? DEFAULT_RULES.captureBonus,
      safeSquares: config.safeSquares ?? DEFAULT_RULES.safeSquares,
      homeBonus: config.homeBonus ?? DEFAULT_RULES.homeBonus,
      exactFinish: config.exactFinish ?? DEFAULT_RULES.exactFinish,
    };
    return {
      mode,
      rules,
      teams: config.teams === true && n === 4,
      colours: seatColours(n),
      tokens: Array.from({ length: n }, () => Array.from({ length: TOKENS_PER_SEAT }, () => BASE)),
      phase: 'roll',
      turn: 0,
      roll: null,
      sixes: 0,
      lastRoll: null,
      finished: [],
      turnMs,
      deadlineAt: now + turnMs,
      places: null,
      stats: Array.from({ length: n }, emptyStats),
    };
  },

  awaiting(state) {
    return state.phase === 'done'
      ? { seats: [], deadlineAt: null }
      : { seats: [state.turn], deadlineAt: state.deadlineAt };
  },

  legalActions(state, seat) {
    if (state.phase === 'done' || seat !== state.turn) return [];
    if (state.phase === 'roll') return [{ type: 'roll' }];
    return legalMoves(state).map((m) => ({ type: 'move', token: m.token }));
  },

  validate(state, action, seat) {
    if (state.phase === 'done') return reject('FINISHED');
    if (seat !== state.turn) return reject('NOT_YOUR_TURN');
    switch (action.type) {
      case 'roll':
        return state.phase === 'roll' ? { ok: true } : reject('ALREADY_ROLLED');
      case 'move':
        if (state.phase !== 'move') return reject('ROLL_FIRST');
        return legalMoves(state).some((m) => m.token === action.token)
          ? { ok: true }
          : reject('ILLEGAL');
      default:
        return reject('ILLEGAL');
    }
  },

  reduce(state, action, seat, ctx) {
    if (state.phase === 'roll' && action.type === 'roll')
      return roll(state, seat, ctx.rng.int(1, 6), ctx.now);
    if (state.phase === 'move' && action.type === 'move')
      return move(state, seat, action.token, ctx.now);
    return { state, events: [] };
  },

  onTimeout(state, seat, rng) {
    // The 20 s timer plays the bot's best move (brief §7.2); rolling is the only action in 'roll'.
    if (state.phase !== 'move') return { type: 'roll' };
    return chooseAction(viewFor(state, { kind: 'seat', seat }), seat, 'hard', rng);
  },

  result,
  viewFor,

  eventFor(event) {
    return event;
  },

  invariants,

  bot: { choose: chooseAction },
});
