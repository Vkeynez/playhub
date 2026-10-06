import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  AppVersionQuerySchema,
  AppVersionResponseSchema,
  CatalogResponseSchema,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  GoogleAuthRequestSchema,
  GoogleAuthResponseSchema,
  GuestAuthRequestSchema,
  GuestAuthResponseSchema,
  HealthResponseSchema,
  InviteRequestSchema,
  MatchDetailResponseSchema,
  ProfileResponseSchema,
  RefreshRequestSchema,
  ResolveRoomParamsSchema,
  restRoutes,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
  UpdateProfileRequestSchema,
} from '../src';

const USER_ID = '0b9e8d7c-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
const ROOM_ID = '7d3f2c1a-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
const EVENT_ID = '01920f3e-8c5a-7b2d-9e4f-6a1b2c3d4e5f';

const me = {
  userId: USER_ID,
  kind: 'guest',
  name: 'Swift Mango 42',
  avatarSeed: 'a1b2',
  locale: 'en',
  muteInvites: false,
  email: null,
} as const;

describe('auth DTOs', () => {
  const guest = {
    guestKey: 'Zm9vYmFyYmF6cXV4MTIzNDU2',
    name: '  Swift Mango 42 ',
    avatarSeed: 'a1b2',
  };

  it('accepts /auth/guest, trims the name and strips unknown keys', () => {
    expect(GuestAuthRequestSchema.parse({ ...guest, kind: 'google' })).toEqual({
      ...guest,
      name: 'Swift Mango 42',
    });
  });

  it('rejects weak or malformed guest keys and empty names', () => {
    expect(GuestAuthRequestSchema.safeParse({ ...guest, guestKey: 'short' }).success).toBe(false);
    expect(
      GuestAuthRequestSchema.safeParse({ ...guest, guestKey: 'has spaces and is long enough' })
        .success,
    ).toBe(false);
    expect(GuestAuthRequestSchema.safeParse({ ...guest, name: '   ' }).success).toBe(false);
    expect(GuestAuthRequestSchema.safeParse({ ...guest, name: 'x'.repeat(25) }).success).toBe(
      false,
    );
  });

  it('parses sessions with and without a refresh token (bearer vs cookie transport)', () => {
    const session = { accessToken: 'jwt', accessTokenExpiresAt: 1_760_000_900_000, user: me };
    expect(GuestAuthResponseSchema.safeParse({ ...session, refreshToken: 'opaque' }).success).toBe(
      true,
    );
    expect(GuestAuthResponseSchema.safeParse(session).success).toBe(true);
    expect(RefreshRequestSchema.safeParse({}).success).toBe(true);
  });

  it('parses /auth/google requests and merge outcomes', () => {
    expect(GoogleAuthRequestSchema.safeParse({ idToken: 'eyJ...' }).success).toBe(true);
    expect(GoogleAuthRequestSchema.safeParse({ idToken: '' }).success).toBe(false);
    const response = {
      accessToken: 'jwt',
      accessTokenExpiresAt: 1,
      user: { ...me, kind: 'google', email: 'player@example.com' },
      outcome: 'merged',
      merged: { matches: 12, progressGameIds: ['lantern-quest'] },
    };
    expect(GoogleAuthResponseSchema.safeParse(response).success).toBe(true);
    expect(GoogleAuthResponseSchema.safeParse({ ...response, outcome: 'stolen' }).success).toBe(
      false,
    );
  });
});

describe('catalog, version and health', () => {
  it('parses the catalog', () => {
    const result = CatalogResponseSchema.safeParse({
      games: [
        {
          id: 'cricket',
          shelf: 'friends',
          status: 'coming_soon',
          featured: false,
          sort: 10,
          minAppVersion: '0.1.0',
          config: {},
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(
      CatalogResponseSchema.safeParse({
        games: [
          {
            id: 'cricket',
            shelf: 'arcade',
            status: 'live',
            featured: false,
            sort: 1,
            minAppVersion: '1.0.0',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('parses /app/version', () => {
    expect(
      AppVersionQuerySchema.safeParse({ platform: 'android', appVersion: '1.2.3' }).success,
    ).toBe(true);
    expect(AppVersionQuerySchema.safeParse({ platform: 'android', appVersion: 'v1' }).success).toBe(
      false,
    );
    expect(
      AppVersionResponseSchema.safeParse({
        status: 'runtime_unsupported',
        latest: {
          version: '1.3.0',
          runtimeVersion: 'abc123',
          apkUrl: 'https://github.com/example/releases/download/v1.3.0/app.apk',
          notes: null,
          publishedAt: 1,
        },
        minSupported: '1.0.0',
      }).success,
    ).toBe(true);
  });

  it('requires ok: true on /health', () => {
    const health = {
      ok: true,
      bootId: 'b1',
      buildSha: 'abc',
      protocolVersion: 1,
      uptime: 3.2,
      rooms: 0,
      elu: 0.1,
      epoch: 3,
      sockets: 2,
      eldP99Ms: 4.5,
    };
    expect(HealthResponseSchema.safeParse(health).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ ...health, ok: false }).success).toBe(false);
  });
});

describe('rooms', () => {
  it('validates room creation', () => {
    expect(
      CreateRoomRequestSchema.safeParse({
        gameId: 'dev-tictactoe',
        mode: 'classic',
        seatCount: 2,
        options: {},
      }).success,
    ).toBe(true);
    expect(
      CreateRoomRequestSchema.safeParse({ gameId: 'Dev TicTacToe', mode: 'classic', seatCount: 2 })
        .success,
    ).toBe(false);
    expect(
      CreateRoomRequestSchema.safeParse({ gameId: 'quiz', mode: 'quick', seatCount: 9 }).success,
    ).toBe(false);
    expect(
      CreateRoomResponseSchema.safeParse({
        roomId: ROOM_ID,
        code: 'ABC234',
        joinUrl: 'https://play.example/join/ABC234',
      }).success,
    ).toBe(true);
  });

  it('normalizes the code when resolving', () => {
    expect(ResolveRoomParamsSchema.parse({ code: 'abc234' })).toEqual({ code: 'ABC234' });
    expect(ResolveRoomParamsSchema.safeParse({ code: 'ABC10O' }).success).toBe(false);
  });
});

describe('profile, matches and invites', () => {
  it('parses a profile', () => {
    const profile = {
      me,
      stats: [
        {
          gameId: 'dev-tictactoe',
          mode: 'classic',
          played: 3,
          won: 2,
          lost: 1,
          drawn: 0,
          streak: 1,
          best: null,
        },
      ],
      activity: [
        { type: 'match_played', gameId: 'dev-tictactoe', refId: EVENT_ID, data: null, at: 1 },
      ],
      recentPlayers: [{ userId: USER_ID, name: 'Calm Kite 7', avatarSeed: 'z', lastPlayedAt: 1 }],
      recentMatches: [
        {
          matchId: EVENT_ID,
          gameId: 'dev-tictactoe',
          mode: 'classic',
          startedAt: 1,
          endedAt: 2,
          outcome: 'win',
          score: null,
        },
      ],
    };
    expect(ProfileResponseSchema.safeParse(profile).success).toBe(true);
  });

  it('accepts partial profile updates', () => {
    expect(UpdateProfileRequestSchema.parse({ muteInvites: true, role: 'admin' })).toEqual({
      muteInvites: true,
    });
    expect(UpdateProfileRequestSchema.safeParse({ locale: 'fr' }).success).toBe(false);
  });

  it('parses match detail with bots, deleted players and a replay', () => {
    const detail = {
      matchId: EVENT_ID,
      roomId: ROOM_ID,
      gameId: 'dev-tictactoe',
      mode: 'classic',
      logicVersion: 1,
      startedAt: 1,
      endedAt: 2,
      result: { winner: 0 },
      finalVersion: 12,
      participants: [
        {
          seat: 0,
          team: null,
          player: { kind: 'human', userId: USER_ID, name: 'A', avatarSeed: 'a' },
          outcome: 'win',
          score: null,
        },
        { seat: 1, team: null, player: { kind: 'deleted' }, outcome: 'loss', score: null },
      ],
      replay: {
        seed: '0123456789abcdef0123456789abcdef',
        config: { initNow: 0 },
        entries: [{ seq: 0, kind: 'action', seat: 0, payload: { cell: 4 }, now: 1200 }],
      },
    };
    expect(MatchDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(
      MatchDetailResponseSchema.safeParse({ ...detail, replay: { ...detail.replay, seed: 'xyz' } })
        .success,
    ).toBe(false);
  });

  it('validates invites', () => {
    expect(InviteRequestSchema.safeParse({ toUserId: USER_ID, roomId: ROOM_ID }).success).toBe(
      true,
    );
    expect(InviteRequestSchema.safeParse({ toUserId: USER_ID }).success).toBe(false);
  });
});

describe('sync', () => {
  const event = {
    id: EVENT_ID,
    gameId: 'color-sort',
    type: 'level_cleared',
    payload: { level: 3, moves: 14 },
    hlc: { wallMs: 1_760_000_000_000, counter: 0 },
    deviceId: 'android-1',
  };

  it('accepts a push and keeps payloads opaque', () => {
    expect(SyncPushRequestSchema.parse({ events: [{ ...event, extra: true }] })).toEqual({
      events: [event],
    });
  });

  it('rejects malformed events and oversized batches', () => {
    expect(SyncPushRequestSchema.safeParse({ events: [{ ...event, id: 'nope' }] }).success).toBe(
      false,
    );
    expect(
      SyncPushRequestSchema.safeParse({ events: [{ ...event, hlc: { wallMs: -5, counter: 0 } }] })
        .success,
    ).toBe(false);
    expect(
      SyncPushRequestSchema.safeParse({ events: Array.from({ length: 501 }, () => event) }).success,
    ).toBe(false);
  });

  it('parses a response with rejected events', () => {
    const response = {
      canonicalSaves: [{ gameId: 'color-sort', saveVersion: 1, data: { level: 4 } }],
      ackedIds: [EVENT_ID],
      rejected: [{ id: EVENT_ID, reason: 'INSUFFICIENT_FUNDS' }],
    };
    expect(SyncPushResponseSchema.safeParse(response).success).toBe(true);
    expect(
      SyncPushResponseSchema.safeParse({ ...response, rejected: [{ id: EVENT_ID, reason: 'NO' }] })
        .success,
    ).toBe(false);
  });
});

describe('errors and the route table', () => {
  it('uses closed error codes', () => {
    expect(ApiErrorSchema.safeParse({ error: 'google_not_configured' }).success).toBe(true);
    expect(ApiErrorSchema.safeParse({ error: 'teapot' }).success).toBe(false);
  });

  it('lists every endpoint from ARCHITECTURE §5.1 once', () => {
    const endpoints = Object.values(restRoutes).map((route) => `${route.method} ${route.path}`);
    expect(new Set(endpoints).size).toBe(endpoints.length);
    for (const expected of [
      'GET /health',
      'POST /auth/guest',
      'POST /auth/refresh',
      'POST /auth/google',
      'GET /me',
      'DELETE /me',
      'GET /catalog',
      'GET /app/version',
      'POST /rooms',
      'GET /rooms/:code',
      'GET /profile',
      'GET /matches/:id',
      'POST /sync/push',
      'POST /invites',
    ]) {
      expect(endpoints).toContain(expected);
    }
  });
});
