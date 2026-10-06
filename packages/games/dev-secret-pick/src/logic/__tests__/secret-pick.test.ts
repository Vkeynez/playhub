import { deriveStream, jsonClone, seedFromInt, SPECTATOR } from '@gp/game-sdk/core';
import type { Rng } from '@gp/game-sdk/core';
import { checkRedaction, contractSuite, perturbOneSecret } from '@gp/game-sdk/testing';
import type { RedactionAdapter } from '@gp/game-sdk/testing';
import { describe, expect, it } from 'vitest';

import { choosePick } from '../../bot';
import { roundWinner, secretPick } from '../index';
import type { SecretPickEvent, SecretPickState } from '../index';

/** Changes one hidden pick to another legal value. */
const redaction: RedactionAdapter<SecretPickState> = perturbOneSecret((s, _path, rng: Rng) =>
  typeof s.value === 'number' ? rng.pick([1, 2, 3].filter((v) => v !== s.value)) : undefined,
);

contractSuite({ module: secretPick, maxActions: 10, redaction });

const rng = (): Rng => deriveStream(seedFromInt(3), 'game');
const seat0 = { kind: 'seat', seat: 0 } as const;
const seat1 = { kind: 'seat', seat: 1 } as const;

function lockedState(): SecretPickState {
  const start = secretPick.init({ config: {}, mode: 'best-of-5', seats: [], rng: rng(), now: 0 });
  const one = secretPick.reduce(start, { type: 'pick', value: 3 }, 0, { rng: rng(), now: 100 });
  return secretPick.reduce(one.state, { type: 'pick', value: 1 }, 1, { rng: rng(), now: 200 })
    .state;
}

describe('secret-pick rules', () => {
  it('2 beats 1, 3 beats 2, 1 beats 3', () => {
    expect(roundWinner(2, 1)).toBe(0);
    expect(roundWinner(2, 3)).toBe(1);
    expect(roundWinner(1, 3)).toBe(0);
    expect(roundWinner(2, 2)).toBeNull();
  });

  it('just before the reveal, each seat sees only its own pick (curated snapshot)', () => {
    const state = lockedState();
    expect(state.phase).toBe('locked');
    expect(secretPick.wakeAt?.(state)).toBe(200);
    expect(secretPick.viewFor(state, seat0).picks).toEqual([3, { hidden: true }]);
    expect(secretPick.viewFor(state, seat1).picks).toEqual([{ hidden: true }, 1]);
    expect(secretPick.viewFor(state, SPECTATOR).picks).toEqual([
      { hidden: true },
      { hidden: true },
    ]);
    expect(JSON.stringify(secretPick.viewFor(state, SPECTATOR))).not.toContain('__secret');
  });

  it('eventFor hides the opponent pick until the reveal tick publishes both', () => {
    const picked: SecretPickEvent = { type: 'picked', seat: 1, value: 2 };
    expect(secretPick.eventFor(picked, seat1)).toEqual(picked);
    expect(secretPick.eventFor(picked, seat0)).toEqual({ type: 'picked', seat: 1, value: null });
    expect(secretPick.eventFor(picked, SPECTATOR)).toEqual({
      type: 'picked',
      seat: 1,
      value: null,
    });
    const reveal = secretPick.tick?.(lockedState(), { rng: rng(), now: 200 });
    expect(reveal?.events[0]).toEqual({ type: 'revealed', round: 1, picks: [3, 1], winner: 1 });
    expect(reveal?.state.picks).toEqual([null, null]);
  });

  it('bots read only their view: hard counters the last pick, medium the most frequent', () => {
    const view = secretPick.viewFor(lockedState(), seat0);
    const withHistory = {
      ...view,
      history: [
        { round: 1, picks: [1, 2], winner: 1 },
        { round: 2, picks: [1, 2], winner: 1 },
        { round: 3, picks: [1, 3], winner: 0 },
      ],
    };
    expect(choosePick(withHistory, 0, 'hard', rng())).toEqual({ type: 'pick', value: 1 });
    expect(choosePick(withHistory, 0, 'medium', rng())).toEqual({ type: 'pick', value: 3 });
  });
});

describe('the harness catches leaky variants', () => {
  const options = { maxActions: 10, redaction, redactionWalks: 8 };

  it('fails a module whose eventFor passes the opponent pick through', () => {
    const leaky = { ...secretPick, eventFor: (event: SecretPickEvent) => jsonClone(event) };
    const failures = checkRedaction({ ...options, module: leaky });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/LEAK: .*observes \[events\] of seat \d's hidden input/);
  });

  it('fails a module whose viewFor shows every pick unwrapped (no __secret marker to spot)', () => {
    const leaky = {
      ...secretPick,
      viewFor: (state: SecretPickState, viewer: Parameters<typeof secretPick.viewFor>[1]) => ({
        ...secretPick.viewFor(state, viewer),
        picks: state.picks.map((pick) => pick?.value ?? null),
      }),
    };
    const failures = checkRedaction({ ...options, module: leaky });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/LEAK: .*observes \[view\]/);
  });

  it('passes the real module with the same settings', () => {
    expect(checkRedaction({ ...options, module: secretPick })).toEqual([]);
  });
});
