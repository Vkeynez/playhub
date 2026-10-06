import { i18nKey } from '@gp/game-sdk/core';
import type { GameManifest } from '@gp/game-sdk/core';

/** Dev-only reference game (catalog status `dev`): the smallest complete turn-based GameModule. */
export const manifest: GameManifest = {
  id: 'dev-tictactoe',
  name: i18nKey('games.devTictactoe.name'),
  shelf: 'friends',
  modes: [
    {
      id: 'classic',
      name: i18nKey('games.devTictactoe.modes.classic'),
      seats: { min: 2, max: 2 },
      teams: 'none',
      turnTimerSec: 30,
      supportsBots: true,
      supportsSpectators: true,
    },
  ],
  offlineCapable: true,
  minAppVersion: '0.1.0',
  logicVersion: 1,
};
