import type { GameUiModule } from '../room/types';

/** Accepts `export { Screen }` or `export default Screen` from a game's `ui` entry. */
export function adaptUiModule(mod: object): GameUiModule {
  const record = mod as Record<string, unknown>;
  const screen = record.Screen ?? record.default;
  if (typeof screen !== 'function' && (typeof screen !== 'object' || screen === null)) {
    throw new Error('game UI module has no Screen export');
  }
  const loadAssets = record.loadAssets;
  return {
    Screen: screen as GameUiModule['Screen'],
    ...(typeof loadAssets === 'function'
      ? { loadAssets: loadAssets as NonNullable<GameUiModule['loadAssets']> }
      : {}),
  };
}
