// Builders for the save events the UI pushes to the outbox while a level is played.

import type { PlayState } from './play';
import { MAX_SAVED_MOVES } from './save';
import type { ColorSortEvent, Settings, Stamp } from './save';
import { movesOf, starsFor } from './play';

/** After each pour / undo / restart: the Continue board. `null` once the attempt is too long to save. */
export function boardEvent(state: PlayState, at: Stamp): ColorSortEvent | null {
  if (state.won || state.history.length > MAX_SAVED_MOVES) return null;
  return { type: 'board', board: { level: state.level, moves: movesOf(state) }, at };
}

/** When `pourMove` reports `won`. */
export function completeEvent(state: PlayState, at: Stamp): ColorSortEvent {
  const moves = state.history.length;
  return {
    type: 'level_complete',
    level: state.level,
    moves,
    stars: starsFor(moves, state.par),
    at,
  };
}

export function settingsEvent(settings: Settings, at: Stamp): ColorSortEvent {
  return { type: 'settings', settings: { ...settings }, at };
}
