import { deriveStream, seedFromInt } from '@gp/game-sdk/core';
import type { BotLevel, Rng, Seat } from '@gp/game-sdk/core';
import { describe, expect, it } from 'vitest';

import { cricket, HAND_CRICKET } from '../../logic';
import type { CricketAction, CricketConfig, CricketState, CricketView } from '../../logic';
import { chooseAction, predict } from '../index';

type Strategy = (view: CricketView, seat: Seat) => CricketAction;

/** A predictable human: calls even, bats first, and always shows 6. */
const alwaysSix: Strategy = (view) => {
  if (view.phase === 'call') return { type: 'call', call: 'even' };
  if (view.phase === 'choose') return { type: 'choose', decision: 'bat' };
  return { type: 'pick', value: 6 };
};

/** Plays one match to the end (no engine: awaited seats act, timed phases tick). */
function playMatch(
  botSeat: Seat,
  level: BotLevel,
  human: Strategy,
  seed: number,
  config: CricketConfig = { wickets: 2, overs: 2 },
): CricketState {
  const rng: Rng = deriveStream(seedFromInt(seed), 'game');
  let now = 0;
  let state = cricket.init({ config, mode: HAND_CRICKET, seats: [], rng, now });
  for (let step = 0; step < 1_000 && state.phase !== 'done'; step++) {
    const [seat] = cricket.awaiting(state).seats;
    if (seat === undefined) {
      now = Math.max(now, cricket.wakeAt?.(state) ?? now);
      const next = cricket.tick?.(state, { rng, now });
      if (!next) break;
      state = next.state;
      continue;
    }
    const view = cricket.viewFor(state, { kind: 'seat', seat });
    const action = seat === botSeat ? chooseAction(view, seat, level, rng) : human(view, seat);
    expect(cricket.validate(state, action, seat)).toEqual({ ok: true });
    state = cricket.reduce(state, action, seat, { rng, now }).state;
  }
  expect(state.phase).toBe('done');
  return state;
}

function botWinRate(level: BotLevel, human: Strategy, matches: number): number {
  let wins = 0;
  for (let i = 0; i < matches; i++) {
    const botSeat: Seat = i % 2;
    if (playMatch(botSeat, level, human, 1_000 + i).outcome?.winner === botSeat) wins++;
  }
  return wins / matches;
}

describe('cricket bot', () => {
  it('every level plays full legal matches from its own view', () => {
    const levels: BotLevel[] = ['easy', 'medium', 'hard'];
    for (const level of levels) {
      for (let seed = 0; seed < 6; seed++) {
        const opponent: Strategy = (view, seat) =>
          chooseAction(
            view,
            seat,
            'medium',
            deriveStream(seedFromInt(seed * 31 + view.innings.length), 'game'),
          );
        const state = playMatch(seed % 2, level, opponent, seed, { wickets: 3, overs: 5 });
        expect(cricket.invariants?.(state) ?? []).toEqual([]);
      }
    }
  });

  it('the model weighs frequencies and 1st-order sequences', () => {
    // Always 6: 6 dominates.
    const flat = predict([6, 6, 6, 6], []);
    expect(Math.max(...flat)).toBe(flat[5]);
    // Alternating 2, 5, 2, 5, 2: after a 2 comes a 5, even though 2 is (slightly) more frequent.
    const alternating = predict([2, 5, 2, 5, 2], []);
    expect(alternating[4]).toBeGreaterThan(alternating[1] ?? 1);
    // No history: uniform.
    expect(predict([], [])).toEqual([1, 1, 1, 1, 1, 1].map((v) => v / 6));
  });

  it('hard bowls at a predictable batter and bats around a predictable bowler', () => {
    const state = playMatch(0, 'hard', alwaysSix, 5);
    const botBowling = state.innings.find((inn) => inn.bowler === 0);
    const botBatting = state.innings.find((inn) => inn.batter === 0);
    // After a couple of 6s the bot keeps matching them.
    const late = botBowling?.history.slice(2) ?? [];
    expect(late.every((b) => b.bowlerPick === 6)).toBe(true);
    // It almost never shows 6 into a bowler who always bowls 6.
    const sixes = botBatting?.history.slice(1).filter((b) => b.batterPick === 6).length ?? 0;
    expect(sixes).toBeLessThanOrEqual(1);
  });

  it('beats an always-6 human far more often on hard (and medium) than on easy', () => {
    const matches = 60;
    const easy = botWinRate('easy', alwaysSix, matches);
    const medium = botWinRate('medium', alwaysSix, matches);
    const hard = botWinRate('hard', alwaysSix, matches);
    expect(hard).toBeGreaterThanOrEqual(0.9);
    expect(easy).toBeLessThanOrEqual(0.5);
    expect(hard - easy).toBeGreaterThanOrEqual(0.5);
    expect(medium).toBeGreaterThan(easy);
  });

  it('medium avoids the opponent pick from the last ball most of the time', () => {
    let repeats = 0;
    let balls = 0;
    for (let seed = 0; seed < 100; seed++) {
      const state = playMatch(0, 'medium', alwaysSix, seed, { wickets: 1, overs: 1 });
      const batting = state.innings.find((inn) => inn.batter === 0);
      for (const ball of batting?.history.slice(1) ?? []) {
        balls++;
        if (ball.batterPick === 6) repeats++;
      }
    }
    // Only the 20% noise can repeat it: about 1 ball in 30.
    expect(balls).toBeGreaterThan(50);
    expect(repeats / balls).toBeLessThan(0.08);
  });
});
