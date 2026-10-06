import { configSchema as cricketConfig } from '@gp/game-cricket/logic';
import { ticTacToe } from '@gp/game-dev-tictactoe/logic';
import { describe, expect, it } from 'vitest';

import { configOptions, initialConfig } from '../src/host/configOptions';

describe('configOptions', () => {
  it('offers cricket wickets and overs as literal choices with their defaults', () => {
    const options = configOptions(cricketConfig);
    expect(options.map((o) => o.key)).toEqual(['wickets', 'overs']);
    expect(options[0]?.choices).toEqual([1, 2, 3]);
    expect(options[1]?.choices).toEqual([1, 2, 5]);
    expect(cricketConfig.parse(initialConfig(options))).toEqual(cricketConfig.parse({}));
  });

  it('gives an optional bounded number a Default chip plus presets', () => {
    const [timer] = configOptions(ticTacToe.configSchema);
    expect(timer?.key).toBe('turnTimerSec');
    expect(timer?.choices).toEqual([undefined, 5, 10, 30, 60]);
    expect(timer?.initial).toBeUndefined();
  });
});

describe('adaptUiModule', () => {
  it('accepts a named Screen or a default export', async () => {
    const { adaptUiModule } = await import('../src/registry/adapt');
    const Screen = () => null;
    expect(adaptUiModule({ Screen }).Screen).toBe(Screen);
    expect(adaptUiModule({ default: Screen }).Screen).toBe(Screen);
    expect(() => adaptUiModule({})).toThrow();
  });
});
