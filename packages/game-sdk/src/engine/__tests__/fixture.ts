// "Duel": a tiny simultaneous hidden-pick game used to exercise the engine (deadlines, ticks, effects).

import { z } from 'zod';

import { defineGame, i18nKey, placementsFromScores, project, secret } from '../../core';
import type { Projected, Secret } from '../../core';

export const PICK_MS = 10_000;
export const REVEAL_MS = 1_000;

export interface DuelState {
  phase: 'pick' | 'reveal' | 'simulate' | 'done';
  round: number;
  rounds: number;
  picks: (Secret<number> | null)[];
  scores: number[];
  deadlineAt: number | null;
  revealAt: number | null;
  useEffects: boolean;
}
export interface DuelAction {
  type: 'pick';
  n: number;
}
export interface DuelConfig {
  rounds: number;
  useEffects: boolean;
}
export type DuelEvent = { type: 'picked'; seat: number } | { type: 'revealed'; picks: number[] };
export type DuelView = Projected<DuelState>;

function score(
  state: DuelState,
  now: number,
  bonus: number,
): { state: DuelState; events: DuelEvent[] } {
  const values = state.picks.map((p) => p?.value ?? 0);
  const [a = 0, b = 0] = values;
  const scores = [...state.scores];
  if (a > b) scores[0] = (scores[0] ?? 0) + 1;
  if (b > a) scores[1] = (scores[1] ?? 0) + 1;
  scores[0] = (scores[0] ?? 0) + bonus;
  const done = state.round >= state.rounds;
  return {
    state: {
      ...state,
      phase: done ? 'done' : 'pick',
      round: done ? state.round : state.round + 1,
      picks: [null, null],
      scores,
      deadlineAt: done ? null : now + PICK_MS,
      revealAt: null,
    },
    events: [{ type: 'revealed', picks: values }],
  };
}

export const duel = defineGame<DuelState, DuelAction, DuelConfig, DuelView, DuelEvent>({
  manifest: {
    id: 'duel',
    name: i18nKey('test.duel'),
    shelf: 'friends',
    modes: [
      {
        id: 'duel',
        name: i18nKey('test.duel'),
        seats: { min: 2, max: 2 },
        supportsBots: true,
        supportsSpectators: true,
      },
    ],
    offlineCapable: true,
    minAppVersion: '0.0.0',
    logicVersion: 1,
  },
  stateVersion: 1,
  configSchema: z.object({
    rounds: z.number().int().min(1).default(3),
    useEffects: z.boolean().default(false),
  }),
  actionSchema: z.object({ type: z.literal('pick'), n: z.number().int().min(1).max(3) }),
  init: ({ config, now }) => ({
    phase: 'pick',
    round: 1,
    rounds: config.rounds,
    picks: [null, null],
    scores: [0, 0],
    deadlineAt: now + PICK_MS,
    revealAt: null,
    useEffects: config.useEffects,
  }),
  awaiting: (state) =>
    state.phase === 'pick'
      ? { seats: [0, 1].filter((seat) => state.picks[seat] === null), deadlineAt: state.deadlineAt }
      : { seats: [], deadlineAt: null },
  wakeAt: (state) => (state.phase === 'reveal' ? state.revealAt : null),
  legalActions: (state, seat) =>
    state.phase === 'pick' && state.picks[seat] === null
      ? [1, 2, 3].map((n) => ({ type: 'pick' as const, n }))
      : [],
  validate: (state, _action, seat) => {
    if (state.phase === 'done') return { ok: false, reason: 'FINISHED' };
    if (state.phase !== 'pick' || state.picks[seat] !== null)
      return { ok: false, reason: 'NOT_YOUR_TURN' };
    return { ok: true };
  },
  reduce: (state, action, seat, ctx) => {
    const picks = state.picks.map((p, i) => (i === seat ? secret(seat, action.n) : p));
    const both = picks.every((p) => p !== null);
    const events: DuelEvent[] = [{ type: 'picked', seat }];
    if (!both) return { state: { ...state, picks }, events };
    if (state.useEffects) {
      return {
        state: { ...state, picks, phase: 'simulate', deadlineAt: null },
        events,
        effects: [{ kind: 'simulate', id: `round-${state.round}`, input: { round: state.round } }],
      };
    }
    return {
      state: { ...state, picks, phase: 'reveal', deadlineAt: null, revealAt: ctx.now + REVEAL_MS },
      events,
    };
  },
  tick: (state, ctx) => score(state, ctx.now, 0),
  resolve: (state, _id, output, ctx) => {
    const bonus = (output as { bonus?: unknown }).bonus;
    return score(state, ctx.now, typeof bonus === 'number' ? bonus : 0);
  },
  onTimeout: (_state, _seat, rng) => ({ type: 'pick', n: rng.int(1, 3) }),
  result: (state) =>
    state.phase === 'done' ? { placements: placementsFromScores(state.scores) } : null,
  viewFor: (state, viewer) => project(state, viewer),
  eventFor: (event) => event,
  invariants: (state) => (state.scores.some((s) => s < 0) ? ['negative score'] : []),
  bot: { choose: (_view, _seat, _level, rng) => ({ type: 'pick', n: rng.int(1, 3) }) },
});
