// Primitive types shared by every part of the Game SDK (ARCHITECTURE §3.1).

export type Seat = number;

/** Who a view or event is being rendered for. `replay` viewers own no secrets. */
export type Viewer = { kind: 'seat'; seat: Seat } | { kind: 'spectator' } | { kind: 'replay' };

export type BotLevel = 'easy' | 'medium' | 'hard';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];

/** An i18next key. Branded so a raw user-facing string can't be passed where a key is expected. */
export type I18nKey = string & { readonly __brand: 'I18nKey' };

export function i18nKey(key: string): I18nKey {
  return key as I18nKey;
}

export type Occupant = { kind: 'human'; userId: string } | { kind: 'bot'; level: BotLevel };

export interface SeatInfo {
  seat: Seat;
  team: number | null;
  occupant: Occupant;
}

/**
 * Base shape of every game event. Events are JSON values with a `type` discriminator.
 * Raw events stay on the server; clients only ever receive `eventFor(event, viewer)`.
 */
export interface GameEvent {
  type: string;
}

export function seatViewer(seat: Seat): Viewer {
  return { kind: 'seat', seat };
}

export const SPECTATOR: Viewer = Object.freeze({ kind: 'spectator' });
export const REPLAY_VIEWER: Viewer = Object.freeze({ kind: 'replay' });

/** Every live viewer of a match with `seatCount` seats: each seat, then a spectator. */
export function liveViewers(seatCount: number): Viewer[] {
  const viewers: Viewer[] = [];
  for (let seat = 0; seat < seatCount; seat++) viewers.push(seatViewer(seat));
  viewers.push({ kind: 'spectator' });
  return viewers;
}

export function viewerLabel(viewer: Viewer): string {
  return viewer.kind === 'seat' ? `seat ${viewer.seat}` : viewer.kind;
}
