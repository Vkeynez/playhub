import { describe, expect, it } from 'vitest';

import type { ModeManifest, Rng } from '../../core';
import { duel } from '../../engine/__tests__/fixture';
import type { DuelConfig, DuelState, DuelView } from '../../engine/__tests__/fixture';
import {
  checkProperties,
  checkRedaction,
  checkSimulation,
  contractSuite,
  perturbOneSecret,
} from '../index';

const redaction = perturbOneSecret<DuelState>((s, _path, rng) =>
  typeof s.value === 'number' ? rng.pick([1, 2, 3].filter((v) => v !== s.value)) : undefined,
);
const base = {
  maxActions: 6,
  redaction,
  runEffect: () => ({ bonus: 1 }),
  config: (_mode: ModeManifest, rng: Rng): DuelConfig => ({
    rounds: 3,
    useEffects: rng.float() < 0.5,
  }),
  matches: 30,
  determinismMatches: 5,
};

// The engine fixture (simultaneous picks, ticks, effects) passes the whole contract.
contractSuite({ module: duel, ...base });

describe('the harness rejects broken modules', () => {
  it('simulation really plays matches', async () => {
    let reduces = 0;
    const counted: typeof duel = {
      ...duel,
      reduce(state, action, seat, ctx) {
        reduces++;
        return duel.reduce(state, action, seat, ctx);
      },
    };
    expect(await checkSimulation({ ...base, module: counted }, 'duel', 10)).toEqual([]);
    expect(reduces).toBeGreaterThanOrEqual(10 * 6);
  });

  it('a reducer that mutates its input', () => {
    const mutating: typeof duel = {
      ...duel,
      reduce(state, action, seat, ctx) {
        state.scores[0] = 0;
        return duel.reduce(state, action, seat, ctx);
      },
    };
    expect(checkProperties({ ...base, module: mutating, propertyRuns: 5 })).not.toEqual([]);
  });

  it('a module that is not deterministic', async () => {
    let calls = 0;
    const flaky: typeof duel = {
      ...duel,
      tick(state, ctx) {
        calls++;
        const step = duel.tick?.(state, ctx) ?? { state, events: [] };
        return {
          ...step,
          state: { ...step.state, scores: step.state.scores.map((s) => s + (calls % 2)) },
        };
      },
    };
    const failures = await checkSimulation(
      { ...base, module: flaky, config: () => ({ rounds: 3, useEffects: false }) },
      'duel',
      5,
    );
    expect(failures.join('\n')).toMatch(/replay/);
  });

  it('a bot that chooses illegal actions', async () => {
    const badBot: typeof duel = { ...duel, bot: { choose: () => ({ type: 'pick', n: 0 }) } };
    const failures = await checkSimulation({ ...base, module: badBot }, 'duel', 3);
    expect(failures.join('\n')).toMatch(/rejected action/);
  });

  it('broken invariants', async () => {
    const broken: typeof duel = { ...duel, invariants: () => ['always broken'] };
    expect((await checkSimulation({ ...base, module: broken }, 'duel', 3)).join('\n')).toMatch(
      /always broken/,
    );
  });

  it('validate accepting seats that are not awaited', () => {
    const lax: typeof duel = {
      ...duel,
      validate: (state) =>
        state.phase === 'done' ? { ok: false, reason: 'FINISHED' } : { ok: true },
    };
    expect(checkProperties({ ...base, module: lax, propertyRuns: 10 }).join('\n')).toMatch(
      /non-awaited|legalActions/,
    );
  });

  it('a view that ships raw secrets', () => {
    const raw: typeof duel = { ...duel, viewFor: (state) => state as unknown as DuelView };
    expect(checkRedaction({ ...base, module: raw, redactionWalks: 3 }).join('\n')).toMatch(
      /__secret marker/,
    );
  });
});
