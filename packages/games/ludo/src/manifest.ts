import { i18nKey } from '@gp/game-sdk/core';
import type { GameManifest, ModeManifest } from '@gp/game-sdk/core';

/** The only mode: classic Indian Ludo for 2–4 seats (2v2 teams at 4 seats via `config.teams`). */
export const CLASSIC = 'classic';

const classic: ModeManifest = {
  id: CLASSIC,
  name: i18nKey('games.ludo.modes.classic.name'),
  seats: { min: 2, max: 4 },
  // Pairs are allowed at 4 seats only; the host turns them on with `config.teams` (partners sit opposite).
  teams: 'pairs',
  turnTimerSec: 20,
  supportsBots: true,
  supportsSpectators: true,
};

export const manifest: GameManifest = {
  id: 'ludo',
  name: i18nKey('games.ludo.name'),
  shelf: 'friends',
  modes: [classic],
  offlineCapable: true,
  minAppVersion: '0.1.0',
  logicVersion: 1,
};
