import { i18nKey } from '@gp/game-sdk/core';
import type { GameManifest } from '@gp/game-sdk/core';

/** Dev-only reference game (catalog status `dev`): simultaneous hidden picks, timed reveals. */
export const manifest: GameManifest = {
  id: 'dev-secret-pick',
  name: i18nKey('games.devSecretPick.name'),
  shelf: 'friends',
  modes: [
    {
      id: 'best-of-5',
      name: i18nKey('games.devSecretPick.modes.bestOf5'),
      seats: { min: 2, max: 2 },
      teams: 'none',
      turnTimerSec: 10,
      supportsBots: true,
      supportsSpectators: true,
    },
  ],
  offlineCapable: true,
  minAppVersion: '0.1.0',
  logicVersion: 1,
};
