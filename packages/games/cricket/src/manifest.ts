import { i18nKey } from '@gp/game-sdk/core';
import type { GameManifest, ModeManifest } from '@gp/game-sdk/core';

/** Mode ids. Arcade Super Over ('arcade-super-over') joins `modes` in Phase 3. */
export const HAND_CRICKET = 'hand-cricket';

const handCricket: ModeManifest = {
  id: HAND_CRICKET,
  name: i18nKey('games.cricket.modes.handCricket.name'),
  seats: { min: 2, max: 2 },
  teams: 'none',
  turnTimerSec: 5,
  supportsBots: true,
  supportsSpectators: true,
  // OQ D30: the clock freezes during the 60 s disconnect grace, so the player is back on the same ball.
  pauseOnDisconnect: true,
};

/** Cricket: one shelf tile, two modes (Hand Cricket now, Arcade Super Over in Phase 3). */
export const manifest: GameManifest = {
  id: 'cricket',
  name: i18nKey('games.cricket.name'),
  shelf: 'friends',
  modes: [handCricket],
  offlineCapable: true,
  minAppVersion: '0.1.0',
  logicVersion: 1,
};
