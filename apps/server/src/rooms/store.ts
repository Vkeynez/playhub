// Room persistence (ARCHITECTURE §5.2, §5.6). Every write after creation is fenced on
// `rooms.owner_epoch` and stamps `last_write_at`; zero fenced rows means another process owns the
// room now (FencedError). Nothing here runs on a timer except the debounced lobby-seat write and the
// ≤ 250 ms write-behind, both of which only follow a state transition.

import { randomInt } from 'node:crypto';
import { logEntrySchema, type LogEntry } from '@gp/game-sdk/engine';
import { generateRoomCode, type RoomPhase } from '@gp/protocol';
import { one, rows, transaction, type Pool } from '../db';

/** `rooms.expires_at` after each kind of write (closing is decided in memory, §5.2). */
export const EXPIRY_SEC = { LOBBY: 30 * 60, IN_PROGRESS: 30 * 60, FINISHED: 10 * 60 } as const;
const CODE_ATTEMPTS = 12;
const MAINTENANCE_EVERY_MS = 60 * 60 * 1000;

export class FencedError extends Error {
  constructor(roomId: string) {
    super(`room ${roomId} is owned by a newer server epoch`);
    this.name = 'FencedError';
  }
}

export interface SeatRow {
  seat: number;
  userId: string | null;
  team: number | null;
}

export interface LogRow {
  seq: number;
  kind: LogEntry['kind'];
  seat: number | null;
  payload: unknown;
  game_now: number;
  client_action_id: string | null;
}

export interface ParticipantRow {
  seat: number;
  user_id: string | null;
  team: number | null;
  outcome: 'win' | 'loss' | 'draw' | 'abandoned';
  score: number | null;
}

export interface NewMatch {
  id: string;
  gameId: string;
  mode: string;
  seedHex: string;
  config: unknown;
  logicVersion: number;
  stateVersion: number;
  snapshot: unknown;
  snapshotVersion: number;
}

export interface RoomRecord {
  id: string;
  code: string;
  gameId: string;
  mode: string;
  hostUserId: string;
  seatCount: number;
  options: unknown;
  status: RoomPhase;
  kicked: string[];
}

export interface StoredSeat extends SeatRow {
  name: string | null;
  avatarSeed: string | null;
}

export interface StoredMatch {
  id: string;
  seedHex: string;
  logicVersion: number;
  snapshot: unknown;
  ended: boolean;
  result: unknown;
  tail: LogEntry[];
}

export type ClaimResult =
  | { ok: true; room: RoomRecord; seats: StoredSeat[]; match: StoredMatch | null }
  | { ok: false; error: 'NOT_FOUND' | 'CLOSED' | 'MOVING' };

export interface RoomSummaryRow {
  id: string;
  code: string;
  game_id: string;
  mode: string;
  status: RoomPhase;
  seat_count: number;
  taken: number;
  you: boolean;
  expired: boolean;
}

interface RoomDbRow {
  id: string;
  code: string;
  game_id: string;
  mode: string;
  host_user_id: string;
  seat_count: number;
  options: unknown;
  status: RoomPhase;
  kicked_user_ids: string[];
}

const toRoom = (row: RoomDbRow): RoomRecord => ({
  id: row.id,
  code: row.code,
  gameId: row.game_id,
  mode: row.mode,
  hostUserId: row.host_user_id,
  seatCount: row.seat_count,
  options: row.options,
  status: row.status,
  kicked: row.kicked_user_ids,
});

export function toLogRow(entry: LogEntry): LogRow {
  return {
    seq: entry.seq,
    kind: entry.kind,
    seat: entry.kind === 'action' || entry.kind === 'timeout' ? entry.seat : null,
    payload: entry.payload,
    game_now: entry.now,
    client_action_id: entry.kind === 'action' ? (entry.clientActionId ?? null) : null,
  };
}

function fromLogRow(row: {
  seq: number;
  kind: string;
  seat: number | null;
  payload: unknown;
  game_now: string | number;
  client_action_id: string | null;
}): LogEntry {
  const raw: Record<string, unknown> = {
    seq: row.seq,
    kind: row.kind,
    payload: row.payload,
    now: Number(row.game_now),
  };
  if (row.seat !== null) raw.seat = row.seat;
  if (row.client_action_id !== null) raw.clientActionId = row.client_action_id;
  return logEntrySchema.parse(raw);
}

const FENCE = (status: string | null) => `f AS (
  UPDATE rooms SET last_write_at = now(), expires_at = now() + make_interval(secs => $3)
    ${status === null ? '' : `, status = ${status}`}
  WHERE id = $1 AND owner_epoch = $2 RETURNING id)`;

const LOG_INSERT = (rowsParam: string, matchParam: string) => `a AS (
  INSERT INTO match_actions (match_id, seq, kind, seat, payload, game_now, client_action_id)
  SELECT ${matchParam}::uuid, r.seq, r.kind::match_action_kind, r.seat, r.payload, r.game_now,
         r.client_action_id
    FROM f, jsonb_to_recordset(${rowsParam}::jsonb)
      AS r(seq int, kind text, seat smallint, payload jsonb, game_now bigint, client_action_id text)
  ON CONFLICT DO NOTHING
  RETURNING 1)`;

export class RoomStore {
  private lastMaintenance = 0;

  constructor(
    private readonly pool: Pool,
    readonly epoch: number,
  ) {}

  /**
   * Write-through room creation (§5.2): closes the host's open lobby (one per host), reserves a
   * code that is unique among open rooms and unused for 24 h, and seats the host in seat 0.
   */
  async createRoom(input: {
    hostUserId: string;
    gameId: string;
    mode: string;
    seatCount: number;
    options: unknown;
  }): Promise<{ id: string; code: string; replaced: string[] }> {
    return transaction(this.pool, async (client) => {
      const replaced = await rows<{ id: string }>(
        client,
        `UPDATE rooms SET status = 'CLOSED', closed_at = now()
          WHERE host_user_id = $1 AND status = 'LOBBY' RETURNING id`,
        [input.hostUserId],
      );
      if (Date.now() - this.lastMaintenance > MAINTENANCE_EVERY_MS) {
        this.lastMaintenance = Date.now();
        // Lazy maintenance (§5.2), inside a transaction that is happening anyway.
        await client.query(
          `UPDATE rooms SET status = 'CLOSED', closed_at = expires_at
            WHERE status <> 'CLOSED' AND expires_at < now()`,
        );
      }
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
        const code = generateRoomCode(randomInt);
        const room = await one<{ id: string }>(
          client,
          `INSERT INTO rooms (code, game_id, mode, host_user_id, seat_count, options, status,
                             owner_epoch, expires_at)
           SELECT $1, $2, $3, $4, $5, $6::jsonb, 'LOBBY', $7, now() + make_interval(secs => $8)
            WHERE NOT EXISTS (
              SELECT 1 FROM rooms WHERE code = $1
                AND (status <> 'CLOSED' OR coalesce(closed_at, expires_at) > now() - interval '24 hours'))
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            code,
            input.gameId,
            input.mode,
            input.hostUserId,
            input.seatCount,
            JSON.stringify(input.options ?? {}),
            this.epoch,
            EXPIRY_SEC.LOBBY,
          ],
        );
        if (!room) continue;
        await client.query('INSERT INTO room_seats (room_id, seat, user_id) VALUES ($1, 0, $2)', [
          room.id,
          input.hostUserId,
        ]);
        return { id: room.id, code, replaced: replaced.map((row) => row.id) };
      }
      throw new Error('could not allocate a room code');
    });
  }

  /** The newest room with this code, for GET /rooms/:code and join-by-code when not in memory. */
  async summaryByCode(code: string, userId: string): Promise<RoomSummaryRow | null> {
    return one<RoomSummaryRow>(
      this.pool,
      `SELECT r.id, r.code, r.game_id, r.mode, r.status, r.seat_count,
              (SELECT count(*)::int FROM room_seats s WHERE s.room_id = r.id AND s.user_id IS NOT NULL) AS taken,
              EXISTS (SELECT 1 FROM room_seats s WHERE s.room_id = r.id AND s.user_id = $2) AS you,
              (r.expires_at < now()) AS expired
         FROM rooms r WHERE r.code = $1
        ORDER BY (r.status <> 'CLOSED') DESC, r.created_at DESC LIMIT 1`,
      [code, userId],
    );
  }

  /** Claim (§5.6) plus the read of seats, the latest match's snapshot and its logged tail. */
  async claim(roomId: string): Promise<ClaimResult> {
    return transaction(this.pool, async (client) => {
      const claimed = await one<RoomDbRow>(
        client,
        `UPDATE rooms SET owner_epoch = $2, released_at = NULL, last_write_at = now()
          WHERE id = $1 AND owner_epoch <= $2 AND status <> 'CLOSED' AND expires_at > now()
          RETURNING id, code, game_id, mode, host_user_id, seat_count, options, status, kicked_user_ids`,
        [roomId, this.epoch],
      );
      if (!claimed) {
        const row = await one<{ status: RoomPhase; expired: boolean; owner_epoch: string }>(
          client,
          `SELECT status, expires_at <= now() AS expired, owner_epoch FROM rooms WHERE id = $1`,
          [roomId],
        );
        if (!row) return { ok: false, error: 'NOT_FOUND' };
        if (row.status !== 'CLOSED' && row.expired) {
          // Activation treats an expired room as closed and closes it in the same transaction.
          await client.query(
            `UPDATE rooms SET status = 'CLOSED', closed_at = expires_at
              WHERE id = $1 AND status <> 'CLOSED'`,
            [roomId],
          );
        }
        if (row.status !== 'CLOSED' && !row.expired && Number(row.owner_epoch) > this.epoch) {
          return { ok: false, error: 'MOVING' };
        }
        return { ok: false, error: 'CLOSED' };
      }
      const seats = await rows<{
        seat: number;
        user_id: string | null;
        team: number | null;
        display_name: string | null;
        avatar_seed: string | null;
      }>(
        client,
        `SELECT s.seat, s.user_id, s.team, u.display_name, u.avatar_seed
           FROM room_seats s LEFT JOIN users u ON u.id = s.user_id
          WHERE s.room_id = $1 ORDER BY s.seat`,
        [roomId],
      );
      const match = await one<{
        id: string;
        seed: string;
        logic_version: number;
        snapshot: { lastSeq?: unknown } | null;
        result: unknown;
        ended_at: Date | null;
      }>(
        client,
        `SELECT id, seed, logic_version, snapshot, result, ended_at FROM matches
          WHERE room_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [roomId],
      );
      let stored: StoredMatch | null = null;
      if (match && match.snapshot !== null) {
        const lastSeq = typeof match.snapshot.lastSeq === 'number' ? match.snapshot.lastSeq : 0;
        const tail = await rows<Parameters<typeof fromLogRow>[0]>(
          client,
          `SELECT seq, kind, seat, payload, game_now, client_action_id FROM match_actions
            WHERE match_id = $1 AND seq > $2 ORDER BY seq`,
          [match.id, lastSeq],
        );
        stored = {
          id: match.id,
          seedHex: match.seed,
          logicVersion: match.logic_version,
          snapshot: match.snapshot,
          ended: match.ended_at !== null,
          result: match.result,
          tail: tail.map(fromLogRow),
        };
      }
      return {
        ok: true,
        room: toRoom(claimed),
        seats: seats.map((s) => ({
          seat: s.seat,
          userId: s.user_id,
          team: s.team,
          name: s.display_name,
          avatarSeed: s.avatar_seed,
        })),
        match: stored,
      };
    });
  }

  /** Lobby seats, host, options and kicks (debounced ≤ 1 per 2 s per room by the actor). */
  async writeLobby(
    roomId: string,
    state: {
      status: RoomPhase;
      hostUserId: string;
      options: unknown;
      kicked: string[];
      seats: SeatRow[];
    },
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const fenced = await one<{ id: string }>(
        client,
        `UPDATE rooms SET last_write_at = now(), expires_at = now() + make_interval(secs => $3),
                status = $4::text::room_status, host_user_id = $5, options = $6::jsonb,
                kicked_user_ids = $7::uuid[],
                closed_at = CASE WHEN $4::text = 'CLOSED' THEN now() ELSE closed_at END
          WHERE id = $1 AND owner_epoch = $2 RETURNING id`,
        [
          roomId,
          this.epoch,
          state.status === 'FINISHED' ? EXPIRY_SEC.FINISHED : EXPIRY_SEC.LOBBY,
          state.status,
          state.hostUserId,
          JSON.stringify(state.options ?? {}),
          state.kicked,
        ],
      );
      if (!fenced) throw new FencedError(roomId);
      await client.query('DELETE FROM room_seats WHERE room_id = $1', [roomId]);
      await client.query(
        `INSERT INTO room_seats (room_id, seat, user_id, team)
         SELECT $1, r.seat, r.user_id, r.team
           FROM jsonb_to_recordset($2::jsonb) AS r(seat smallint, user_id uuid, team smallint)`,
        [
          roomId,
          JSON.stringify(
            state.seats.map((s) => ({ seat: s.seat, user_id: s.userId, team: s.team })),
          ),
        ],
      );
    });
  }

  /** Match start: the matches row (seed, frozen config, versions, initial snapshot) + room status. */
  async startMatch(roomId: string, match: NewMatch): Promise<void> {
    const row = await one<{ fenced: number }>(
      this.pool,
      `WITH ${FENCE("'IN_PROGRESS'")},
       m AS (
         INSERT INTO matches (id, room_id, game_id, mode, seed, config, logic_version, state_version,
                              snapshot, snapshot_version)
         SELECT $4, f.id, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12 FROM f
         RETURNING id)
       SELECT (SELECT count(*)::int FROM f) AS fenced, (SELECT count(*)::int FROM m) AS inserted`,
      [
        roomId,
        this.epoch,
        EXPIRY_SEC.IN_PROGRESS,
        match.id,
        match.gameId,
        match.mode,
        match.seedHex,
        JSON.stringify(match.config),
        match.logicVersion,
        match.stateVersion,
        JSON.stringify(match.snapshot),
        match.snapshotVersion,
      ],
    );
    if (!row || row.fenced === 0) throw new FencedError(roomId);
  }

  /** Appends log rows (ON CONFLICT DO NOTHING) and, at decision points, the snapshot. */
  async appendLog(
    roomId: string,
    matchId: string,
    log: LogRow[],
    snapshot: { value: unknown; version: number } | null,
  ): Promise<void> {
    const row = await one<{ fenced: number }>(
      this.pool,
      `WITH ${FENCE(null)}, ${LOG_INSERT('$5', '$4')},
       s AS (
         UPDATE matches SET snapshot = $6::jsonb, snapshot_version = $7
           FROM f WHERE matches.id = $4 AND $6::jsonb IS NOT NULL AND matches.snapshot_version < $7
         RETURNING 1)
       SELECT (SELECT count(*)::int FROM f) AS fenced, (SELECT count(*)::int FROM a) AS logged,
              (SELECT count(*)::int FROM s) AS snapped`,
      [
        roomId,
        this.epoch,
        EXPIRY_SEC.IN_PROGRESS,
        matchId,
        JSON.stringify(log),
        snapshot === null ? null : JSON.stringify(snapshot.value),
        snapshot?.version ?? 0,
      ],
    );
    if (!row || row.fenced === 0) throw new FencedError(roomId);
  }

  /**
   * Idempotent match end (§5.2): the final log rows and snapshot, then — only if this call ended the
   * match — participants, per-user stats and recent players. Returns whether it ended the match.
   */
  async endMatch(
    roomId: string,
    matchId: string,
    log: LogRow[],
    snapshot: { value: unknown; version: number },
    result: unknown,
    participants: ParticipantRow[],
  ): Promise<boolean> {
    const row = await one<{ fenced: number; ended: number }>(
      this.pool,
      `WITH ${FENCE("'FINISHED'")}, ${LOG_INSERT('$5', '$4')},
       e AS (
         UPDATE matches SET ended_at = now(), result = $8::jsonb, snapshot = $6::jsonb,
                snapshot_version = GREATEST(matches.snapshot_version, $7)
           FROM f WHERE matches.id = $4 AND matches.ended_at IS NULL
         RETURNING matches.id, matches.game_id, matches.mode),
       parts AS (
         SELECT * FROM jsonb_to_recordset($9::jsonb)
           AS r(seat smallint, user_id uuid, team smallint, outcome text, score int)),
       p AS (
         INSERT INTO match_participants (match_id, seat, user_id, team, outcome, score)
         SELECT e.id, parts.seat, parts.user_id, parts.team, parts.outcome::match_outcome, parts.score
           FROM e, parts
         ON CONFLICT DO NOTHING RETURNING 1),
       st AS (
         INSERT INTO user_game_stats AS g (user_id, game_id, mode, played, won, lost, drawn, streak)
         SELECT parts.user_id, e.game_id, e.mode, 1, (parts.outcome = 'win')::int,
                (parts.outcome = 'loss')::int, (parts.outcome = 'draw')::int,
                (parts.outcome = 'win')::int
           FROM e, parts WHERE parts.user_id IS NOT NULL AND parts.outcome <> 'abandoned'
         ON CONFLICT (user_id, game_id, mode) DO UPDATE SET
           played = g.played + 1, won = g.won + EXCLUDED.won, lost = g.lost + EXCLUDED.lost,
           drawn = g.drawn + EXCLUDED.drawn,
           streak = CASE WHEN EXCLUDED.won = 1 THEN GREATEST(g.streak, 0) + 1 ELSE 0 END,
           updated_at = now()
         RETURNING 1),
       rp AS (
         INSERT INTO recent_players (user_id, other_user_id, last_played_at)
         SELECT a.user_id, b.user_id, now() FROM e, parts a, parts b
          WHERE a.user_id IS NOT NULL AND b.user_id IS NOT NULL AND a.user_id <> b.user_id
            AND a.outcome <> 'abandoned'
         ON CONFLICT (user_id, other_user_id) DO UPDATE SET last_played_at = now()
         RETURNING 1)
       SELECT (SELECT count(*)::int FROM f) AS fenced, (SELECT count(*)::int FROM e) AS ended,
              (SELECT count(*)::int FROM a) + (SELECT count(*)::int FROM p)
                + (SELECT count(*)::int FROM st) + (SELECT count(*)::int FROM rp) AS touched`,
      [
        roomId,
        this.epoch,
        EXPIRY_SEC.FINISHED,
        matchId,
        JSON.stringify(log),
        JSON.stringify(snapshot.value),
        snapshot.version,
        JSON.stringify(result),
        JSON.stringify(participants),
      ],
    );
    if (!row || row.fenced === 0) throw new FencedError(roomId);
    return row.ended > 0;
  }

  /** Bumps `expires_at` (the rematch prompt) or releases ownership (drain). */
  async touch(roomId: string, expiresInSec: number, release = false): Promise<void> {
    const row = await one<{ id: string }>(
      this.pool,
      `UPDATE rooms SET last_write_at = now(), expires_at = now() + make_interval(secs => $3),
              released_at = CASE WHEN $4 THEN now() ELSE released_at END
        WHERE id = $1 AND owner_epoch = $2 RETURNING id`,
      [roomId, this.epoch, expiresInSec, release],
    );
    if (!row) throw new FencedError(roomId);
  }
}
