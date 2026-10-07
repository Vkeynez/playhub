import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CLIENT_EVENT_NAMES,
  clientEvents,
  isClientEventName,
  isServerEventName,
  parseClientAck,
  parseClientEvent,
  parseServerEvent,
  ROOM_JOIN_ERRORS,
  SERVER_EVENT_NAMES,
  type ClientEventPayload,
  type RoomSnapshot,
} from '../src';

const ROOM_ID = '7d3f2c1a-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
const USER_ID = '0b9e8d7c-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
const MATCH_ID = '01920f3e-8c5a-7b2d-9e4f-6a1b2c3d4e5f';

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: ROOM_ID,
    code: 'ABC234',
    gameId: 'dev-tictactoe',
    mode: 'classic',
    version: 4 * 2 ** 32 + 3,
    phase: 'IN_PROGRESS',
    seatCount: 2,
    options: {},
    seats: [
      {
        seat: 0,
        team: null,
        occupant: {
          kind: 'human',
          userId: USER_ID,
          name: 'Swift Mango 42',
          avatarSeed: 'seed-1',
          platform: 'android',
          connection: 'connected',
        },
        isHost: true,
        ready: true,
        loaded: true,
      },
      {
        seat: 1,
        team: null,
        occupant: { kind: 'bot', level: 'easy', playingFor: null },
        isHost: false,
        ready: true,
        loaded: true,
      },
    ],
    spectators: 0,
    yourSeat: 0,
    matchId: MATCH_ID,
    deadlines: [{ kind: 'turn', seats: [0], at: 1_760_000_000_000 }],
    rematch: null,
    view: { board: [null, 'x', null] },
    events: [{ type: 'placed', cell: 1 }],
    ...overrides,
  };
}

describe('event map', () => {
  it('covers every client → server event in ARCHITECTURE §4.4', () => {
    expect([...CLIENT_EVENT_NAMES].sort()).toEqual(
      [
        'hello',
        'clock:ping',
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
      ].sort(),
    );
  });

  it('covers every server → client event in ARCHITECTURE §4.4', () => {
    expect([...SERVER_EVENT_NAMES].sort()).toEqual(
      ['room:state', 'reaction', 'room:closed', 'room:kicked', 'server:moving', 'error'].sort(),
    );
  });

  it('marks react and presence as fire-and-forget', () => {
    expect(clientEvents.react.ack).toBeNull();
    expect(clientEvents.presence.ack).toBeNull();
    expect(clientEvents['game:action'].ack).not.toBeNull();
  });

  it('recognizes event names without prototype leaks', () => {
    expect(isClientEventName('hello')).toBe(true);
    expect(isClientEventName('toString')).toBe(false);
    expect(isClientEventName('room:state')).toBe(false);
    expect(isServerEventName('room:state')).toBe(true);
    expect(isServerEventName('constructor')).toBe(false);
  });
});

describe('hello', () => {
  const hello = {
    protocolVersion: 1,
    appVersion: '0.1.0',
    platform: 'web',
    deviceId: 'web-7f3a',
    locale: 'ta',
  };

  it('accepts a valid hello and strips unknown keys', () => {
    const result = parseClientEvent('hello', { ...hello, isAdmin: true, __proto__x: 1 });
    expect(result).toEqual({ ok: true, data: hello });
  });

  it('rejects missing or malformed fields', () => {
    expect(parseClientEvent('hello', { ...hello, platform: 'ios' }).ok).toBe(false);
    expect(parseClientEvent('hello', { ...hello, appVersion: 'latest' }).ok).toBe(false);
    expect(parseClientEvent('hello', { ...hello, protocolVersion: 1.5 }).ok).toBe(false);
    const { deviceId: _omit, ...withoutDevice } = hello;
    expect(parseClientEvent('hello', withoutDevice).ok).toBe(false);
    expect(parseClientEvent('hello', null).ok).toBe(false);
  });

  it('parses both ack shapes', () => {
    const ok = parseClientAck('hello', {
      ok: true,
      serverTime: 1,
      protocol: { min: 1, max: 1 },
      bootId: 'boot-1',
      epoch: 2,
    });
    expect(ok.ok).toBe(true);
    const tooOld = parseClientAck('hello', {
      ok: false,
      serverTime: 1,
      protocol: { min: 2, max: 2 },
      reason: 'CLIENT_TOO_OLD',
    });
    expect(tooOld.ok && tooOld.data.ok === false && tooOld.data.reason).toBe('CLIENT_TOO_OLD');
    expect(
      parseClientAck('hello', {
        ok: false,
        serverTime: 1,
        protocol: { min: 1, max: 1 },
        reason: 'NOPE',
      }).ok,
    ).toBe(false);
  });
});

describe('clock:ping', () => {
  it('round-trips t0 and the server time', () => {
    expect(parseClientEvent('clock:ping', { t0: 1234.567 }).ok).toBe(true);
    expect(parseClientEvent('clock:ping', { t0: -1 }).ok).toBe(false);
    expect(parseClientAck('clock:ping', { t0: 1234.567, ts: 1_760_000_000_000 }).ok).toBe(true);
  });
});

describe('room:join', () => {
  it('accepts a code (normalized) and strips unknown keys', () => {
    const result = parseClientEvent('room:join', { code: 'abc-234', asSpectator: true, extra: 1 });
    expect(result).toEqual({ ok: true, data: { code: 'ABC234', asSpectator: true } });
  });

  it('accepts a reconnect by roomId with lastStateVersion', () => {
    const result = parseClientEvent('room:join', { roomId: ROOM_ID, lastStateVersion: 42 });
    expect(result).toEqual({ ok: true, data: { roomId: ROOM_ID, lastStateVersion: 42 } });
  });

  it('rejects payloads with neither a valid code nor a valid roomId', () => {
    expect(parseClientEvent('room:join', {}).ok).toBe(false);
    expect(parseClientEvent('room:join', { code: 'ABCD0E' }).ok).toBe(false);
    expect(parseClientEvent('room:join', { roomId: 'not-a-uuid' }).ok).toBe(false);
    expect(parseClientEvent('room:join', { roomId: ROOM_ID, lastStateVersion: -1 }).ok).toBe(false);
  });

  it('parses a success ack with a full snapshot', () => {
    const ack = parseClientAck('room:join', {
      ok: true,
      roomId: ROOM_ID,
      role: 'player',
      snapshot: snapshot(),
    });
    expect(ack.ok).toBe(true);
  });

  it('parses every error from the closed enum and nothing else', () => {
    for (const error of ROOM_JOIN_ERRORS) {
      expect(parseClientAck('room:join', { ok: false, error }).ok, error).toBe(true);
    }
    expect(parseClientAck('room:join', { ok: false, error: 'NOPE' }).ok).toBe(false);
    expect(ROOM_JOIN_ERRORS).toEqual([
      'NOT_FOUND',
      'CLOSED',
      'ROOM_FULL',
      'KICKED',
      'SERVER_BUSY',
      'MOVING',
    ]);
  });
});

describe('lobby commands', () => {
  it('validates each command', () => {
    expect(parseClientEvent('room:ready', { roomId: ROOM_ID, ready: true, loaded: true }).ok).toBe(
      true,
    );
    expect(parseClientEvent('room:ready', { roomId: ROOM_ID, ready: 'yes', loaded: true }).ok).toBe(
      false,
    );
    expect(
      parseClientEvent('room:options', { roomId: ROOM_ID, seatCount: 4, options: { overs: 2 } }).ok,
    ).toBe(true);
    expect(
      parseClientEvent('room:options', { roomId: ROOM_ID, seatCount: 9, options: {} }).ok,
    ).toBe(false);
    expect(parseClientEvent('room:kick', { roomId: ROOM_ID, userId: USER_ID }).ok).toBe(true);
    expect(parseClientEvent('room:kick', { roomId: ROOM_ID }).ok).toBe(false);
    expect(parseClientEvent('room:start', { roomId: ROOM_ID }).ok).toBe(true);
    expect(parseClientEvent('room:rematch', { roomId: ROOM_ID, accept: true }).ok).toBe(true);
    expect(parseClientEvent('room:leave', { roomId: 'x' }).ok).toBe(false);
  });

  it('keeps game-specific options opaque', () => {
    const result = parseClientEvent('room:options', {
      roomId: ROOM_ID,
      options: { overs: 2, nested: { anything: true } },
    });
    expect(result.ok && result.data.options).toEqual({ overs: 2, nested: { anything: true } });
  });

  it('parses lobby acks', () => {
    expect(parseClientAck('room:start', { ok: true }).ok).toBe(true);
    expect(parseClientAck('room:start', { ok: false, reason: 'NOT_HOST' }).ok).toBe(true);
    expect(parseClientAck('room:start', { ok: false, reason: 'BECAUSE' }).ok).toBe(false);
  });
});

describe('game:action', () => {
  const action = {
    roomId: ROOM_ID,
    clientActionId: '01920f3e-8c5a-7b2d',
    baseVersion: 2 ** 32 + 7,
    action: { type: 'place', cell: 4, hint: { keep: 'me' } },
  };

  it('accepts a valid action and leaves the game payload untouched', () => {
    const result = parseClientEvent('game:action', { ...action, spoofedSeat: 1 });
    expect(result).toEqual({ ok: true, data: action });
    if (result.ok) {
      expectTypeOf(result.data).toEqualTypeOf<ClientEventPayload<'game:action'>>();
      expectTypeOf(result.data.baseVersion).toEqualTypeOf<number>();
    }
  });

  it('rejects bad envelopes', () => {
    expect(parseClientEvent('game:action', { ...action, clientActionId: 'short' }).ok).toBe(false);
    expect(
      parseClientEvent('game:action', { ...action, clientActionId: 'has spaces in it' }).ok,
    ).toBe(false);
    expect(parseClientEvent('game:action', { ...action, baseVersion: 2 ** 53 }).ok).toBe(false);
    expect(parseClientEvent('game:action', { ...action, roomId: undefined }).ok).toBe(false);
  });

  it('parses acks with closed reason codes', () => {
    expect(parseClientAck('game:action', { ok: true, version: 9 })).toEqual({
      ok: true,
      data: { ok: true, version: 9 },
    });
    expect(parseClientAck('game:action', { ok: false, reason: 'STALE' }).ok).toBe(true);
    expect(parseClientAck('game:action', { ok: false, reason: 'free text reason' }).ok).toBe(false);
  });
});

describe('react and presence', () => {
  it('accepts only the 8 emoji', () => {
    expect(parseClientEvent('react', { roomId: ROOM_ID, emoji: '🔥' }).ok).toBe(true);
    expect(parseClientEvent('react', { roomId: ROOM_ID, emoji: 'lol' }).ok).toBe(false);
  });

  it('accepts active | away', () => {
    expect(parseClientEvent('presence', { roomId: ROOM_ID, state: 'away' }).ok).toBe(true);
    expect(parseClientEvent('presence', { roomId: ROOM_ID, state: 'gone' }).ok).toBe(false);
  });
});

describe('server events', () => {
  it('parses a room:state snapshot and strips unknown keys at every level', () => {
    const raw = {
      ...snapshot(),
      serverSecret: 'nope',
      seats: snapshot().seats.map((seat) => ({ ...seat, internal: 1 })),
    };
    const result = parseServerEvent('room:state', raw);
    expect(result).toEqual({ ok: true, data: snapshot() });
  });

  it('keeps the optional P0 meta and result fields', () => {
    const withMeta = {
      ...snapshot(),
      meta: {
        version: 2 ** 32 + 3,
        awaiting: { seats: [1], deadlineAt: 1_700_000_000_000 },
        paused: false,
        finished: false,
      },
      result: { placements: [{ seat: 0, place: 1, score: null }] },
    };
    expect(parseServerEvent('room:state', withMeta)).toEqual({ ok: true, data: withMeta });
    expect(parseServerEvent('room:state', { ...snapshot(), meta: null, result: null }).ok).toBe(
      true,
    );
  });

  it('rejects a snapshot with a bad version or phase', () => {
    expect(parseServerEvent('room:state', snapshot({ version: -1 })).ok).toBe(false);
    expect(parseServerEvent('room:state', { ...snapshot(), phase: 'PAUSED' }).ok).toBe(false);
  });

  it('parses the other server events', () => {
    expect(
      parseServerEvent('reaction', {
        roomId: ROOM_ID,
        userId: USER_ID,
        seat: null,
        emoji: '🎉',
        at: 5,
      }).ok,
    ).toBe(true);
    expect(parseServerEvent('room:closed', { roomId: ROOM_ID, reason: 'IDLE' }).ok).toBe(true);
    expect(parseServerEvent('room:closed', { roomId: ROOM_ID, reason: 'BORED' }).ok).toBe(false);
    expect(parseServerEvent('room:kicked', { roomId: ROOM_ID, fromSpectating: false }).ok).toBe(
      true,
    );
    expect(parseServerEvent('server:moving', { reason: 'DEPLOY' }).ok).toBe(true);
    expect(parseServerEvent('error', { code: 'INVALID_PAYLOAD', event: 'game:action' }).ok).toBe(
      true,
    );
    expect(parseServerEvent('error', { code: 'WHATEVER' }).ok).toBe(false);
  });
});
