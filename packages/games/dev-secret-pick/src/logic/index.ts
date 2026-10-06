// dev-secret-pick GameModule: the reference module for simultaneous hidden moves, deadlines and timed reveals.
// Picks are Secret<number> owned by their seat; tick() reveals them once both are in (auto-picks on timeout).

import {
  defineGame,
  findMode,
  isSecret,
  placementsFromScores,
  project,
  secret,
} from '@gp/game-sdk/core';
import type { Validation } from '@gp/game-sdk/core';
import { z } from 'zod';

import { choosePick } from '../bot';
import { manifest } from '../manifest';
import { PICKS, roundWinner, ROUNDS, SHOW_MS, WINS_NEEDED } from './rules';
import type {
  PickAction,
  SecretPickConfig,
  SecretPickEvent,
  SecretPickRejection,
  SecretPickState,
  SecretPickView,
} from './rules';

export * from './rules';

const DEFAULT_PICK_SEC = 10;

function reject(reason: SecretPickRejection): Validation {
  return { ok: false, reason };
}

export const secretPick = defineGame<
  SecretPickState,
  PickAction,
  SecretPickConfig,
  SecretPickView,
  SecretPickEvent
>({
  manifest,
  stateVersion: 1,
  configSchema: z.object({ pickTimerSec: z.number().int().min(3).max(120).optional() }),
  actionSchema: z.object({ type: z.literal('pick'), value: z.number().int().min(1).max(3) }),

  init({ config, mode, now }) {
    const pickMs =
      (config.pickTimerSec ?? findMode(manifest, mode).turnTimerSec ?? DEFAULT_PICK_SEC) * 1000;
    return {
      phase: 'pick',
      round: 1,
      picks: [null, null],
      deadlineAt: now + pickMs,
      wakeAt: null,
      wins: [0, 0],
      history: [],
      pickMs,
    };
  },

  awaiting(state) {
    if (state.phase !== 'pick') return { seats: [], deadlineAt: null };
    return {
      seats: [0, 1].filter((seat) => state.picks[seat] === null),
      deadlineAt: state.deadlineAt,
    };
  },

  wakeAt(state) {
    return state.phase === 'locked' || state.phase === 'shown' ? state.wakeAt : null;
  },

  legalActions(state, seat) {
    if (state.phase !== 'pick' || state.picks[seat] !== null) return [];
    return PICKS.map((value) => ({ type: 'pick', value }));
  },

  validate(state, _action, seat) {
    if (state.phase === 'done') return reject('FINISHED');
    if (state.phase !== 'pick' || seat < 0 || seat > 1) return reject('NOT_YOUR_TURN');
    if (state.picks[seat] !== null) return reject('ALREADY_PICKED');
    return { ok: true };
  },

  reduce(state, action, seat, ctx) {
    const picks = state.picks.map((pick, i) => (i === seat ? secret(seat, action.value) : pick));
    const events: SecretPickEvent[] = [{ type: 'picked', seat, value: action.value }];
    if (picks.some((pick) => pick === null)) return { state: { ...state, picks }, events };
    // Both picks are in: lock them and reveal on the next tick (a decision boundary for the room layer).
    return {
      state: { ...state, picks, phase: 'locked', deadlineAt: null, wakeAt: ctx.now },
      events,
    };
  },

  tick(state, ctx) {
    if (state.phase === 'locked') {
      const values = state.picks.map((pick) => pick?.value ?? 1);
      const winner = roundWinner(values[0] ?? 1, values[1] ?? 1);
      const wins = state.wins.map((w, seat) => (seat === winner ? w + 1 : w));
      const history = [...state.history, { round: state.round, picks: values, winner }];
      const done = wins.some((w) => w >= WINS_NEEDED) || state.round >= ROUNDS;
      const events: SecretPickEvent[] = [
        { type: 'revealed', round: state.round, picks: values, winner },
      ];
      if (done) events.push({ type: 'ended', wins });
      return {
        state: {
          ...state,
          phase: done ? 'done' : 'shown',
          picks: [null, null],
          wakeAt: done ? null : ctx.now + SHOW_MS,
          wins,
          history,
        },
        events,
      };
    }
    if (state.phase === 'shown') {
      const round = state.round + 1;
      return {
        state: { ...state, phase: 'pick', round, deadlineAt: ctx.now + state.pickMs, wakeAt: null },
        events: [{ type: 'round', round }],
      };
    }
    return { state, events: [] };
  },

  onTimeout(_state, _seat, rng) {
    return { type: 'pick', value: rng.pick(PICKS) };
  },

  result(state) {
    return state.phase === 'done' ? { placements: placementsFromScores(state.wins) } : null;
  },

  viewFor(state, viewer) {
    return {
      phase: state.phase,
      round: state.round,
      picks: project(state.picks, viewer),
      wins: [...state.wins],
      history: state.history.map((r) => ({
        round: r.round,
        picks: [...r.picks],
        winner: r.winner,
      })),
      you: viewer.kind === 'seat' ? viewer.seat : null,
    };
  },

  eventFor(event, viewer) {
    if (event.type === 'picked' && !(viewer.kind === 'seat' && viewer.seat === event.seat)) {
      return { type: 'picked', seat: event.seat, value: null };
    }
    return event;
  },

  invariants(state) {
    const issues: string[] = [];
    const settled = state.phase === 'shown' || state.phase === 'done';
    if (state.history.length !== state.round - (settled ? 0 : 1))
      issues.push('history length does not match round');
    if (state.round < 1 || state.round > ROUNDS) issues.push(`round ${state.round} out of range`);
    state.wins.forEach((w, seat) => {
      if (w !== state.history.filter((r) => r.winner === seat).length)
        issues.push(`wins[${seat}] disagrees with history`);
      if (w > WINS_NEEDED) issues.push(`wins[${seat}] above ${WINS_NEEDED}`);
    });
    state.picks.forEach((pick, seat) => {
      if (pick === null) return;
      if (!isSecret(pick) || pick.owner !== seat)
        issues.push(`pick ${seat} must be a Secret owned by seat ${seat}`);
      if (!PICKS.includes(pick.value as 1 | 2 | 3)) issues.push(`pick ${seat} out of range`);
    });
    if (state.phase === 'pick' && state.deadlineAt === null)
      issues.push('pick phase without a deadline');
    if (state.phase === 'locked' && state.picks.some((p) => p === null))
      issues.push('locked with a missing pick');
    if (settled && state.picks.some((p) => p !== null))
      issues.push('picks must be cleared once revealed');
    const decided = state.wins.some((w) => w >= WINS_NEEDED) || state.history.length >= ROUNDS;
    if ((state.phase === 'done') !== decided) {
      issues.push('done must hold exactly when the match is decided');
    }
    return issues;
  },

  bot: { choose: choosePick },
});
