// Registers the contract harness as Vitest tests. Call it from a game's test file:
//   contractSuite({ module: ticTacToe, maxActions: 9 });

import { describe, expect, it } from 'vitest';

import type { GameEvent } from '../core';
import {
  checkBudget,
  checkDeterminism,
  checkProperties,
  checkRedaction,
  checkSimulation,
} from './harness';
import type { ContractOptions } from './harness';

const TIMEOUT = { timeout: 300_000 };

export function contractSuite<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
): void {
  describe(`GameModule contract: ${options.module.manifest.id}`, () => {
    for (const mode of options.module.manifest.modes) {
      it(`simulation: seeded bot-vs-bot matches (${mode.id})`, TIMEOUT, async () => {
        expect(await checkSimulation(options, mode.id)).toEqual([]);
      });
    }
    it(
      'properties: invariants, validate ⇔ legalActions, NOT_YOUR_TURN, STALE, frozen inputs',
      TIMEOUT,
      () => {
        expect(checkProperties(options)).toEqual([]);
      },
    );
    it('redaction: trace-level non-interference and no __secret in outputs', TIMEOUT, () => {
      expect(checkRedaction(options)).toEqual([]);
    });
    it('determinism: replay and snapshot round trips change nothing', TIMEOUT, async () => {
      expect(await checkDeterminism(options)).toEqual([]);
    });
    if (options.budget !== false) {
      it('budget: bot.choose p99 < 5 ms, reduce p99 < 1 ms', TIMEOUT, async () => {
        expect(await checkBudget(options)).toEqual([]);
      });
    }
  });
}
