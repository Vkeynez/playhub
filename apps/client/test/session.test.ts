import type { AuthSession, GuestAuthRequest } from '@gp/protocol';
import { describe, expect, it } from 'vitest';

import { memoryKv } from '../src/net/kv';
import { IDENTITY_KEY, Session, TOKENS_KEY } from '../src/net/session';
import type { LockManagerLike, SessionDeps } from '../src/net/session';

const USER = {
  userId: '0f1e2d3c-4b5a-4968-8776-655443322110',
  kind: 'guest' as const,
  name: 'Swift Mango 42',
  avatarSeed: 'seed',
  locale: 'en' as const,
  muteInvites: false,
  email: null,
};

function auth(token: string, expiresAt: number, refreshToken = `r-${token}`): AuthSession {
  return { accessToken: token, accessTokenExpiresAt: expiresAt, refreshToken, user: USER };
}

/** A promise the test resolves later, to hold calls in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(patch: Partial<SessionDeps> = {}) {
  let now = 1_000_000;
  const calls = { guest: [] as GuestAuthRequest[], refresh: [] as string[] };
  const kv = memoryKv();
  const deps: SessionDeps = {
    kv,
    guest: (body) => {
      calls.guest.push(body);
      return Promise.resolve(auth(`g${calls.guest.length}`, now + 900_000));
    },
    refresh: (token) => {
      calls.refresh.push(token);
      return Promise.resolve(auth(`f${calls.refresh.length}`, now + 900_000));
    },
    now: () => now,
    random: (n) => new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256),
    ...patch,
  };
  return {
    kv,
    calls,
    session: new Session(deps),
    deps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Session', () => {
  it('creates the local identity once, offline, and keeps it', async () => {
    const { session, kv, calls, deps } = setup();
    const a = await session.identity();
    expect(a.guestKey.length).toBeGreaterThanOrEqual(22);
    expect(a.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
    expect(calls.guest).toHaveLength(0);
    expect(await kv.get(IDENTITY_KEY)).not.toBeNull();
    const again = await new Session(deps).identity();
    expect(again).toEqual(a);
  });

  it('creates the server guest once for concurrent callers', async () => {
    const gate = deferred<AuthSession>();
    const { session, calls } = setup({
      guest: (body) => {
        calls.guest.push(body);
        return gate.promise;
      },
    });
    const tokens = Promise.all([session.getAccessToken(), session.getAccessToken()]);
    await Promise.resolve();
    gate.resolve(auth('g1', 2_000_000));
    expect(await tokens).toEqual(['g1', 'g1']);
    expect(calls.guest).toHaveLength(1);
    const identity = await session.identity();
    expect(calls.guest[0]).toMatchObject({ guestKey: identity.guestKey, name: identity.name });
  });

  it('refreshes once for concurrent callers when the token is about to expire', async () => {
    const { session, calls, advance, kv } = setup();
    expect(await session.getAccessToken()).toBe('g1');
    advance(900_000 - 30_000);
    const tokens = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
    ]);
    expect(tokens).toEqual(['f1', 'f1', 'f1']);
    expect(calls.refresh).toEqual(['r-g1']);
    expect(JSON.parse((await kv.get(TOKENS_KEY)) ?? '{}')).toMatchObject({ accessToken: 'f1' });
  });

  it('serialises refresh through the lock and reuses another tab’s refresh', async () => {
    const order: string[] = [];
    const locks: LockManagerLike = {
      request: async (name, fn) => {
        order.push(`lock:${name}`);
        return fn();
      },
    };
    const { session, calls, kv, deps } = setup({ locks });
    await session.getAccessToken();
    // Another tab refreshed and stored a fresh token meanwhile.
    await kv.set(
      TOKENS_KEY,
      JSON.stringify({ ...auth('other-tab', deps.now() + 900_000), refreshToken: 'r2' }),
    );
    const fresh = await session.refresh('g1');
    expect(fresh.accessToken).toBe('other-tab');
    expect(calls.refresh).toEqual([]);
    expect(order).toEqual(['lock:auth-refresh']);
  });

  it('falls back to guest sign-in when the refresh token is dead', async () => {
    const { session, calls } = setup({
      refresh: () => Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })),
    });
    await session.getAccessToken();
    const fresh = await session.refresh('g1');
    expect(fresh.accessToken).toBe('g2');
    expect(calls.guest).toHaveLength(2);
  });
});
