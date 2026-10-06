// Every game the client can run. Importing this module registers them (manifests only; the logic
// and UI chunks load when a match starts).

import { manifest as cricketManifest } from '@gp/game-cricket/manifest';
import { manifest as secretPickManifest } from '@gp/game-dev-secret-pick/manifest';
import { manifest as ticTacToeManifest } from '@gp/game-dev-tictactoe/manifest';

import { optionalUi } from '../generated/optionalUi';
import type { GameUiModule } from '../room/types';
import { getGame, isRegistered, registerGame } from './index';

/** Thrown by `load()` while a game's UI package hasn't landed yet. */
export class UiNotReadyError extends Error {
  constructor(gameId: string) {
    super(`${gameId} UI is not built yet`);
    this.name = 'UiNotReadyError';
  }
}

function pendingUi(gameId: string): () => Promise<GameUiModule> {
  return optionalUi[gameId] ?? (() => Promise.reject(new UiNotReadyError(gameId)));
}

export function registerAllGames(): void {
  if (isRegistered(ticTacToeManifest.id)) return;
  registerGame({
    manifest: ticTacToeManifest,
    logic: () => import('@gp/game-dev-tictactoe/logic').then((m) => m.ticTacToe),
    load: () => import('../games/dev-tictactoe/Screen'),
    usesSkia: false,
    seatChoice: { labels: ['X', 'O'] },
  });
  registerGame({
    manifest: secretPickManifest,
    logic: () => import('@gp/game-dev-secret-pick/logic').then((m) => m.secretPick),
    load: () => import('../games/dev-secret-pick/Screen'),
    usesSkia: true,
  });
  registerGame({
    manifest: cricketManifest,
    logic: () => import('@gp/game-cricket/logic').then((m) => m.cricket),
    load: pendingUi(cricketManifest.id),
    usesSkia: true,
  });
}

registerAllGames();

export { getGame };
