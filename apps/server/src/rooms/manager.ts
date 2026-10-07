// RoomManager (ARCHITECTURE §5.1, §5.6): the only way to get a RoomActor. One in-flight activation
// per room id (a reconnect storm restores a room once), the creation cap, code lookup and a
// negative cache of closed rooms so stale links don't wake Postgres.

import type { FastifyBaseLogger } from 'fastify';
import type { CreateRoomRequest, ResolveRoomResponse } from '@gp/protocol';
import type { Pool } from '../db';
import type { ProfileCache } from '../profiles';
import type { RoomSocket } from '../socket-types';
import type { Timers } from '../timers';
import { RoomActor, type ActorDeps } from './actor';
import { findGame, resolveMode } from './registry';
import type { RoomStore } from './store';

export type ActivateResult =
  { ok: true; actor: RoomActor } | { ok: false; error: 'NOT_FOUND' | 'CLOSED' | 'MOVING' };

export type CreateResult =
  | { ok: true; roomId: string; code: string }
  | {
      ok: false;
      status: number;
      error: 'bad_request' | 'game_unavailable' | 'server_busy' | 'unauthorized';
    };

export interface ManagerDeps {
  store: RoomStore;
  pool: Pool;
  profiles: ProfileCache;
  timers: Timers;
  epoch: number;
  log: FastifyBaseLogger;
  maxActiveRooms: number;
}

const CLOSED_CACHE = 2_000;

export class RoomManager {
  private readonly actors = new Map<string, RoomActor>();
  private readonly byCode = new Map<string, string>();
  private readonly activating = new Map<string, Promise<ActivateResult>>();
  private readonly closedIds = new Set<string>();
  private readonly actorDeps: ActorDeps;

  constructor(private readonly deps: ManagerDeps) {
    this.actorDeps = {
      store: deps.store,
      timers: deps.timers,
      epoch: deps.epoch,
      log: deps.log,
      onGone: (roomId, code, closed) => this.gone(roomId, code, closed),
    };
  }

  /** Rooms in memory (for /health; never touches the DB). */
  get size(): number {
    return this.actors.size;
  }

  get(roomId: string): RoomActor | null {
    return this.actors.get(roomId) ?? null;
  }

  async create(hostUserId: string, request: CreateRoomRequest): Promise<CreateResult> {
    const game = findGame(request.gameId);
    if (!game) return { ok: false, status: 404, error: 'game_unavailable' };
    const resolved = resolveMode(game, request.mode, request.seatCount);
    if (!resolved) return { ok: false, status: 400, error: 'bad_request' };
    const config = game.parseConfig(request.options);
    if (!config.ok) return { ok: false, status: 400, error: 'bad_request' };
    // MAX_ACTIVE_ROOMS applies to creation only, never to activation or restore (§4.2).
    if (this.actors.size >= this.deps.maxActiveRooms) {
      return { ok: false, status: 503, error: 'server_busy' };
    }
    const profile = await this.deps.profiles.get(this.deps.pool, hostUserId);
    if (!profile) return { ok: false, status: 401, error: 'unauthorized' };

    const created = await this.deps.store.createRoom({
      hostUserId,
      gameId: game.id,
      mode: resolved.mode.id,
      seatCount: resolved.seatCount,
      options: config.config,
    });
    // One open lobby per host: the store closed the old one; tell anyone still in it.
    for (const id of created.replaced) {
      const old = this.actors.get(id);
      if (old) void old.run(() => old.close('REPLACED'));
      else this.markClosed(id);
    }
    const actor = new RoomActor(
      {
        id: created.id,
        code: created.code,
        game,
        mode: resolved.mode.id,
        seatCount: resolved.seatCount,
        options: config.config,
        hostUserId,
        status: 'LOBBY',
        kicked: [],
        seats: [{ seat: 0, team: null, userId: hostUserId, profile }],
      },
      this.actorDeps,
    );
    this.actors.set(actor.id, actor);
    this.byCode.set(actor.code, actor.id);
    return { ok: true, roomId: created.id, code: created.code };
  }

  /** The room's actor, restoring it from Postgres (claim + snapshot + tail) when not in memory. */
  activate(roomId: string): Promise<ActivateResult> {
    const live = this.actors.get(roomId);
    if (live && !live.isClosed) return Promise.resolve({ ok: true, actor: live });
    if (this.closedIds.has(roomId)) return Promise.resolve({ ok: false, error: 'CLOSED' });
    let pending = this.activating.get(roomId);
    if (!pending) {
      pending = this.load(roomId).finally(() => this.activating.delete(roomId));
      this.activating.set(roomId, pending);
    }
    return pending;
  }

  /** A code from a link or the code box → an open room id. */
  async resolveCode(
    code: string,
    userId: string,
  ): Promise<{ ok: true; roomId: string } | { ok: false; error: 'NOT_FOUND' | 'CLOSED' }> {
    const id = this.byCode.get(code);
    if (id && this.actors.has(id)) return { ok: true, roomId: id };
    const row = await this.deps.store.summaryByCode(code, userId);
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.status === 'CLOSED' || row.expired || this.closedIds.has(row.id)) {
      return { ok: false, error: 'CLOSED' };
    }
    return { ok: true, roomId: row.id };
  }

  /** GET /rooms/:code. Memory first; Postgres only for rooms this process doesn't hold. */
  async summary(
    code: string,
    userId: string,
  ): Promise<ResolveRoomResponse | 'not_found' | 'closed'> {
    const id = this.byCode.get(code);
    const actor = id ? this.actors.get(id) : undefined;
    if (actor && !actor.isClosed) return actor.summary(userId);
    const row = await this.deps.store.summaryByCode(code, userId);
    if (!row) return 'not_found';
    if (row.status === 'CLOSED' || row.expired || this.closedIds.has(row.id)) return 'closed';
    return {
      roomId: row.id,
      code: row.code,
      gameId: row.game_id,
      mode: row.mode,
      phase: row.status,
      seatCount: row.seat_count,
      seatsTaken: row.taken,
      youAreSeated: row.you,
    };
  }

  /** A socket disconnected: every room it was in hears about it through its queue. */
  socketGone(socket: RoomSocket): void {
    for (const roomId of [...socket.data.rooms]) {
      const actor = this.actors.get(roomId);
      if (actor) void actor.run(() => actor.socketGone(socket.id));
    }
    socket.data.rooms.clear();
  }

  /** SIGTERM drain (§5.6): flush and release every room. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.actors.values()].map((actor) => actor.drain()));
  }

  /** Resolves once every room's queue and writes are idle (tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.actors.values()].map((actor) => actor.idle()));
  }

  private async load(roomId: string): Promise<ActivateResult> {
    const claim = await this.deps.store.claim(roomId);
    if (!claim.ok) {
      if (claim.error === 'CLOSED') this.markClosed(roomId);
      return claim;
    }
    const { room, seats, match } = claim;
    const game = findGame(room.gameId);
    if (!game) return { ok: false, error: 'CLOSED' };
    const config = game.parseConfig(room.options);
    const status = match === null && room.status !== 'LOBBY' ? 'LOBBY' : room.status;
    const actor = new RoomActor(
      {
        id: room.id,
        code: room.code,
        game,
        mode: room.mode,
        seatCount: room.seatCount,
        options: config.ok ? config.config : {},
        hostUserId: room.hostUserId,
        status,
        kicked: room.kicked,
        seats: seats.map((s) => ({
          seat: s.seat,
          team: s.team,
          userId: s.userId,
          profile:
            s.name !== null && s.avatarSeed !== null
              ? { name: s.name, avatarSeed: s.avatarSeed }
              : null,
        })),
      },
      this.actorDeps,
    );
    this.actors.set(actor.id, actor);
    this.byCode.set(actor.code, actor.id);
    if (match) await actor.run(() => actor.restoreMatch(match));
    this.deps.log.info({ roomId, status: actor.phase, restored: match !== null }, 'room activated');
    return { ok: true, actor };
  }

  private gone(roomId: string, code: string, closed: boolean): void {
    this.actors.delete(roomId);
    if (this.byCode.get(code) === roomId) this.byCode.delete(code);
    if (closed) this.markClosed(roomId);
  }

  private markClosed(roomId: string): void {
    this.closedIds.add(roomId);
    if (this.closedIds.size > CLOSED_CACHE) {
      const oldest = this.closedIds.values().next();
      if (!oldest.done) this.closedIds.delete(oldest.value);
    }
  }
}
