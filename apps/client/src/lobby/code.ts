// Room-code input (BUILD_BRIEF §6.2): what a person types or pastes becomes at most 6 characters of
// the code alphabet, upper-cased. A pasted invite link or message yields the code inside it.
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@gp/protocol';
import type { ResolveRoomResponse } from '@gp/protocol';

const LINK_CODE = /\/join\/([A-Za-z0-9]{6})(?![A-Za-z0-9])/;
const NOT_IN_ALPHABET = new RegExp(`[^${ROOM_CODE_ALPHABET}]`, 'g');

/** Live-input normaliser for the code box: upper-case, alphabet only, max 6. */
export function sanitizeCodeInput(raw: string): string {
  const fromLink = LINK_CODE.exec(raw)?.[1];
  const source = fromLink ?? raw;
  return source.toUpperCase().replace(NOT_IN_ALPHABET, '').slice(0, ROOM_CODE_LENGTH);
}

export function isCompleteCode(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && sanitizeCodeInput(code) === code;
}

/** A room the caller can't take a seat in (every seat filled, or the match already started). */
export function roomIsFull(room: ResolveRoomResponse): boolean {
  if (room.youAreSeated) return false;
  return room.phase !== 'LOBBY' || room.seatsTaken >= room.seatCount;
}
