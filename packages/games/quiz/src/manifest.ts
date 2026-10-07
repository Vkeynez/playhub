import { i18nKey } from '@gp/game-sdk/core';
import type { GameManifest, ModeManifest } from '@gp/game-sdk/core';

/** Mode ids (OQ D17): Quick mixes categories; in Category mode the host picks one. */
export const QUICK = 'quick';
export const CATEGORY_MODE = 'category';

const shared = {
  seats: { min: 2, max: 8 },
  teams: 'none',
  turnTimerSec: 15,
  supportsBots: true,
  supportsSpectators: true,
} as const satisfies Partial<ModeManifest>;

/** Quiz Battle (BUILD_BRIEF §7.4): 2–8 seats answer the same question at the same time. */
export const manifest: GameManifest = {
  id: 'quiz',
  name: i18nKey('games.quiz.name'),
  shelf: 'friends',
  modes: [
    { id: QUICK, name: i18nKey('games.quiz.modes.quick.name'), ...shared },
    { id: CATEGORY_MODE, name: i18nKey('games.quiz.modes.category.name'), ...shared },
  ],
  offlineCapable: true,
  minAppVersion: '0.1.0',
  logicVersion: 1,
};
