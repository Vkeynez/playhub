// Room events on a socket (ARCHITECTURE §4.4). Every payload is parsed with its @gp/protocol schema
// (unknown keys stripped); every command runs on the room's serialized queue. Nothing here reads
// Postgres except activation of a room that isn't in memory and a profile cache miss on join.

import type { FastifyBaseLogger } from 'fastify';
import {
  parseClientEvent,
  type GameActionAck,
  type LobbyAck,
  type RoomJoinAck,
} from '@gp/protocol';
import type { Pool } from '../db';
import type { ProfileCache } from '../profiles';
import type { Limiters } from '../rate-limit';
import type { RoomSocket } from '../socket-types';
import type { RoomActor } from './actor';
import type { RoomManager } from './manager';

export interface RoomSocketContext {
  manager: RoomManager;
  limiters: Limiters;
  profiles: ProfileCache;
  pool: Pool;
  log: FastifyBaseLogger;
}

export const ROOM_EVENTS = [
  'room:join',
  'room:ready',
  'room:options',
  'room:kick',
  'room:start',
  'room:rematch',
  'room:leave',
  'game:action',
  'react',
  'presence',
] as const;

type Ack<T> = ((response: T) => void) | undefined;

export function attachRoomHandlers(socket: RoomSocket, ctx: RoomSocketContext): void {
  const { manager, limiters, profiles, pool, log } = ctx;
  const userId = socket.data.userId;

  const invalid = (event: string) =>
    socket.emit('error', { code: 'INVALID_PAYLOAD', event: event.slice(0, 32) });

  function reply<T>(ack: Ack<T>, work: () => Promise<T>, fallback: T): void {
    work().then(
      (response) => {
        if (typeof ack === 'function') ack(response);
      },
      (error: unknown) => {
        log.error({ err: error, userId }, 'room handler failed');
        if (typeof ack === 'function') ack(fallback);
      },
    );
  }

  const inRoom = (roomId: string): RoomActor | null =>
    socket.data.rooms.has(roomId) ? manager.get(roomId) : null;

  function lobby(
    ack: Ack<LobbyAck>,
    roomId: string,
    command: (actor: RoomActor) => Promise<LobbyAck>,
  ): void {
    if (!limiters.lobbyPerUser.take(userId)) return ack?.({ ok: false, reason: 'RATE_LIMITED' });
    const actor = inRoom(roomId);
    if (!actor) return ack?.({ ok: false, reason: 'NOT_IN_ROOM' });
    reply(ack, () => actor.run(() => command(actor)), { ok: false, reason: 'WRONG_PHASE' });
  }

  const badLobby = (event: string, ack: Ack<LobbyAck>) => {
    invalid(event);
    ack?.({ ok: false, reason: 'NOT_IN_ROOM' });
  };

  socket.on('room:join', (payload, ack) => {
    const parsed = parseClientEvent('room:join', payload);
    if (!parsed.ok) {
      invalid('room:join');
      return ack?.({ ok: false, error: 'NOT_FOUND' });
    }
    const join = parsed.data;
    reply<RoomJoinAck>(
      ack,
      async () => {
        if (!limiters.joinPerUser.take(userId)) return { ok: false, error: 'SERVER_BUSY' };
        let roomId: string;
        if ('code' in join) {
          const resolved = await manager.resolveCode(join.code, userId);
          if (!resolved.ok) return { ok: false, error: resolved.error };
          roomId = resolved.roomId;
        } else {
          roomId = join.roomId;
        }
        const activated = await manager.activate(roomId);
        if (!activated.ok) return { ok: false, error: activated.error };
        const profile = await profiles.get(pool, userId);
        if (!profile) return { ok: false, error: 'NOT_FOUND' };
        const actor = activated.actor;
        return actor.run(() =>
          actor.join({
            socket,
            userId,
            profile,
            platform: socket.data.hello?.platform ?? 'web',
            asSpectator: join.asSpectator ?? false,
          }),
        );
      },
      { ok: false, error: 'SERVER_BUSY' },
    );
  });

  socket.on('room:ready', (payload, ack) => {
    const parsed = parseClientEvent('room:ready', payload);
    if (!parsed.ok) return badLobby('room:ready', ack);
    const { roomId, ready, loaded } = parsed.data;
    lobby(ack, roomId, (actor) => actor.ready(socket.id, ready, loaded));
  });

  socket.on('room:options', (payload, ack) => {
    const parsed = parseClientEvent('room:options', payload);
    if (!parsed.ok) return badLobby('room:options', ack);
    const { roomId, ...change } = parsed.data;
    lobby(ack, roomId, (actor) => actor.setOptions(socket.id, change));
  });

  socket.on('room:kick', (payload, ack) => {
    const parsed = parseClientEvent('room:kick', payload);
    if (!parsed.ok) return badLobby('room:kick', ack);
    const { roomId, userId: target, fromSpectating } = parsed.data;
    lobby(ack, roomId, (actor) => actor.kick(socket.id, target, fromSpectating ?? false));
  });

  socket.on('room:start', (payload, ack) => {
    const parsed = parseClientEvent('room:start', payload);
    if (!parsed.ok) return badLobby('room:start', ack);
    lobby(ack, parsed.data.roomId, (actor) => actor.start(socket.id));
  });

  socket.on('room:rematch', (payload, ack) => {
    const parsed = parseClientEvent('room:rematch', payload);
    if (!parsed.ok) return badLobby('room:rematch', ack);
    const { roomId, accept } = parsed.data;
    lobby(ack, roomId, (actor) => actor.requestRematch(socket.id, accept));
  });

  socket.on('room:leave', (payload, ack) => {
    const parsed = parseClientEvent('room:leave', payload);
    if (!parsed.ok) return badLobby('room:leave', ack);
    lobby(ack, parsed.data.roomId, (actor) => actor.leave(socket.id));
  });

  socket.on('game:action', (payload, ack) => {
    const parsed = parseClientEvent('game:action', payload);
    if (!parsed.ok) {
      invalid('game:action');
      return ack?.({ ok: false, reason: 'INVALID_ACTION' });
    }
    const action = parsed.data;
    if (!limiters.actionPerUser.take(userId)) return ack?.({ ok: false, reason: 'RATE_LIMITED' });
    const actor = inRoom(action.roomId);
    if (!actor) return ack?.({ ok: false, reason: 'NOT_IN_ROOM' });
    reply<GameActionAck>(ack, () => actor.run(() => actor.action(socket.id, action)), {
      ok: false,
      reason: 'INVALID_ACTION',
    });
  });

  socket.on('react', (payload) => {
    const parsed = parseClientEvent('react', payload);
    if (!parsed.ok) return invalid('react');
    if (!limiters.reactPerUser.take(userId)) return;
    const actor = inRoom(parsed.data.roomId);
    if (actor) void actor.run(() => actor.react(socket.id, parsed.data.emoji));
  });

  socket.on('presence', (payload) => {
    const parsed = parseClientEvent('presence', payload);
    if (!parsed.ok) return invalid('presence');
    const actor = inRoom(parsed.data.roomId);
    if (actor) void actor.run(() => actor.presence(socket.id, parsed.data.state === 'away'));
  });

  socket.on('disconnect', () => manager.socketGone(socket));
}
