// `@gp/game-cricket/ui`: the lazily loaded Hand Cricket UI chunk (GameHost loads Skia first on web).
import { registerStrings } from './i18n';

export { Screen } from './Screen';
export type { CricketScreenProps } from './Screen';
export { setHaptics } from './platform';
export type { HapticKind } from './platform';

/** Resolved by GameHost before the match starts: merges this game's strings into i18next. */
export function loadAssets(): Promise<void> {
  registerStrings();
  return Promise.resolve();
}
