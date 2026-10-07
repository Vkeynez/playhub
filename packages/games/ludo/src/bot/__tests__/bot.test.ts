import { deriveStream, seedFromInt } from '@gp/game-sdk/core';
import type { BotLevel, Rng, RngState, SeatInfo } from '@gp/game-sdk/core';
import { describe, expect, it } from 'vitest';

import { CLASSIC, configSchema, ludo } from '../../logic';
import type { LudoState, LudoView } from '../../logic';
import { chooseAction, threatened } from '../index';

const LEVELS: BotLevel[] = ['easy', 'medium', 'hard'];

function fixed(value: number): Rng {
  const state: RngState = [1, 2, 3, 4];
  return {
    nextU32: () => value,
    int: () => value,
    float: () => 0.99,
    pick<T>(items: readonly T[]): T {
      const [first] = items;
      if (first === undefined) throw new Error('empty');
      return first;
    },
    shuffle: <T>(items: readonly T[]) => [...items],
    save: () => state,
  };
}

function seats(n: number): SeatInfo[] {
  return Array.from({ length: n }, (_, seat) => ({
    seat,
    team: null,
    occupant: { kind: 'bot', level: 'hard' },
  }));
}

/** Red (seat 0) to move with `value` rolled, the board set to `tokens` (2 seats: red vs yellow). */
function viewAfterRoll(tokens: number[][], value: number): LudoView {
  const init = ludo.init({
    config: configSchema.parse({}),
    mode: CLASSIC,
    seats: seats(tokens.length),
    rng: fixed(value),
    now: 0,
  });
  const state: LudoState = { ...init, tokens };
  const rolled = ludo.reduce(state, { type: 'roll' }, 0, { rng: fixed(value), now: 0 }).state;
  expect(rolled.phase).toBe('move');
  return ludo.viewFor(rolled, { kind: 'seat', seat: 0 });
}

const chosen = (view: LudoView, level: BotLevel) => chooseAction(view, 0, level, fixed(1));

describe('ludo bot', () => {
  it('rolls when it is time to roll', () => {
    const view = ludo.viewFor(
      ludo.init({
        config: configSchema.parse({}),
        mode: CLASSIC,
        seats: seats(2),
        rng: fixed(1),
        now: 0,
      }),
      { kind: 'seat', seat: 0 },
    );
    for (const level of LEVELS)
      expect(chooseAction(view, 0, level, fixed(1))).toEqual({ type: 'roll' });
  });

  // Rolling a 4. Token 0: 10 → 14 captures yellow (progress 40). Token 1: 48 → 52 enters the home column.
  // Token 2: 4 → 8 (a star) escapes yellow's token on square 1 (progress 27). Token 3: 20 → 24 plain.
  const yellow = [40, 27, -1, -1];

  it('prefers a capture first', () => {
    const view = viewAfterRoll([[10, 48, 4, 20], yellow], 4);
    expect(chosen(view, 'medium')).toEqual({ type: 'move', token: 0 });
    expect(chosen(view, 'hard')).toEqual({ type: 'move', token: 0 });
  });

  it('then reaching safety', () => {
    const view = viewAfterRoll([[11, 48, 4, 20], yellow], 4);
    expect(threatened(view, 0, 4)).toBe(true);
    expect(chosen(view, 'medium')).toEqual({ type: 'move', token: 2 });
    expect(chosen(view, 'hard')).toEqual({ type: 'move', token: 2 });
  });

  it('then entering home, then advancing the furthest token', () => {
    const home = viewAfterRoll([[11, 48, 3, 20], yellow], 4);
    expect(chosen(home, 'medium')).toEqual({ type: 'move', token: 1 });
    expect(chosen(home, 'hard')).toEqual({ type: 'move', token: 1 });
    const furthest = viewAfterRoll(
      [
        [11, 30, 3, 20],
        [-1, -1, -1, -1],
      ],
      3,
    );
    expect(chosen(furthest, 'medium')).toEqual({ type: 'move', token: 1 });
  });

  it('hard avoids landing just in front of an opponent', () => {
    // Token 0: 30 → 33 lands 2 in front of yellow on square 31 (progress 5); token 1: 20 → 23 is clear.
    const view = viewAfterRoll(
      [
        [30, 20, -1, -1],
        [5, -1, -1, -1],
      ],
      3,
    );
    expect(chosen(view, 'medium')).toEqual({ type: 'move', token: 0 });
    expect(chosen(view, 'hard')).toEqual({ type: 'move', token: 1 });
  });

  it('easy sometimes plays a random legal move', () => {
    const view = viewAfterRoll([[10, 48, 4, 20], yellow], 4);
    const picks = new Set<number>();
    for (let seed = 0; seed < 60; seed++) {
      const action = chooseAction(view, 0, 'easy', deriveStream(seedFromInt(seed), 'bot'));
      if (action.type === 'move') picks.add(action.token);
    }
    expect(picks.has(0)).toBe(true);
    expect(picks.size).toBeGreaterThan(1);
  });

  // The < 5 ms per choice budget is checked by the contract harness (budget: bot.choose p99).
  it('every level finishes legal 4-seat matches', () => {
    for (let seed = 0; seed < 6; seed++) {
      const rng = deriveStream(seedFromInt(seed), 'game');
      const bot = deriveStream(seedFromInt(seed), 'bot');
      let state = ludo.init({
        config: configSchema.parse({ teams: seed % 2 === 1 }),
        mode: CLASSIC,
        seats: seats(4),
        rng,
        now: 0,
      });
      for (let step = 0; step < 5_000 && state.phase !== 'done'; step++) {
        const seat = state.turn;
        const view = ludo.viewFor(state, { kind: 'seat', seat });
        const level = LEVELS[(seat + seed) % LEVELS.length] ?? 'hard';
        const action = chooseAction(view, seat, level, bot);
        expect(ludo.validate(state, action, seat)).toEqual({ ok: true });
        state = ludo.reduce(state, action, seat, { rng, now: step }).state;
      }
      expect(state.phase).toBe('done');
      expect(ludo.invariants?.(state)).toEqual([]);
    }
  });
});
