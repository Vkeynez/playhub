// Join by code: GET /rooms/:code, then decide where to go (BUILD_BRIEF §6.2, §6.3).
import type { ResolveRoomResponse } from '@gp/protocol';

import { ApiError } from '../net/api';
import { authedFetch } from '../net/client';
import { roomIsFull } from './code';

export type JoinErrorCode =
  | 'NOT_FOUND'
  | 'CLOSED'
  | 'ROOM_FULL'
  | 'KICKED'
  | 'SERVER_BUSY'
  | 'asleep'
  | 'offline'
  | 'generic';

export type JoinOutcome =
  | { ok: true; roomId: string; room: ResolveRoomResponse }
  | { ok: false; error: JoinErrorCode; roomId?: string };

export function joinErrorFor(e: unknown): JoinErrorCode {
  if (!(e instanceof ApiError)) return 'generic';
  switch (e.code) {
    case 'not_found':
    case 'bad_request':
      return 'NOT_FOUND';
    case 'room_closed':
      return 'CLOSED';
    case 'server_busy':
    case 'rate_limited':
      return 'SERVER_BUSY';
    case 'asleep':
      return 'asleep';
    case 'offline':
      return 'offline';
    default:
      return 'generic';
  }
}

export async function resolveJoin(code: string): Promise<JoinOutcome> {
  let room: ResolveRoomResponse;
  try {
    room = await authedFetch('resolveRoom', { params: { code } });
  } catch (e) {
    return { ok: false, error: joinErrorFor(e) };
  }
  if (room.phase === 'CLOSED') return { ok: false, error: 'CLOSED' };
  if (roomIsFull(room)) return { ok: false, error: 'ROOM_FULL', roomId: room.roomId };
  return { ok: true, roomId: room.roomId, room };
}

export function roomHref(roomId: string, watch = false): string {
  return watch ? `/room/${roomId}?watch=1` : `/room/${roomId}`;
}
