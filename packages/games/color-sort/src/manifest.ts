import { i18nKey } from '@gp/game-sdk/core';
import type { GameManifest, ModeManifest } from '@gp/game-sdk/core';

/** The single solo mode: numbered levels, one player, no bots or spectators. */
export const LEVELS = 'levels';

const levels: ModeManifest = {
  id: LEVELS,
  name: i18nKey('games.colorSort.modes.levels.name'),
  seats: { min: 1, max: 1 },
  teams: 'none',
  supportsBots: false,
  supportsSpectators: false,
};

/** Color Sort Flow (BUILD_BRIEF §7.9): a solo Relax game, fully playable offline. */
export const manifest: GameManifest = {
  id: 'color-sort',
  name: i18nKey('games.colorSort.name'),
  shelf: 'relax',
  modes: [levels],
  offlineCapable: true,
  minAppVersion: '0.1.0',
  logicVersion: 1,
};
