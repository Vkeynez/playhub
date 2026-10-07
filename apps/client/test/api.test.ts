import { describe, expect, it } from 'vitest';

import { ApiError, apiFetch } from '../src/net/api';
import type { ApiDeps } from '../src/net/api';
import { wakeStore } from '../src/net/wake';

const HEALTH = {
  ok: true,
  bootId: 'boot',
  buildSha: 'abc',
  protocolVersion: 1,
  uptime: 1,
  rooms: 0,
  elu: 0.1,
};
const ROOM = {
  roomId: '7b0f3c2e-8a51-4c1e-9d6b-2f4a1e0c9b11',
  code: 'K7P2QX',
  gameId: 'cricket',
  mode: 'hand-cricket',
  phase: 'LOBBY',
  seatCount: 2,
  seatsTaken: 1,
  youAreSeated: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function deps(responses: (() => Response | Promise<Response>)[], online = true) {
  const urls: string[] = [];
  let now = 0;
  const d: ApiDeps = {
    baseUrl: 'http://api.test',
    fetch: (url) => {
      urls.push(url);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return Promise.resolve(next());
    },
    isOnline: () => online,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
  };
  return { d, urls };
}

describe('apiFetch', () => {
  it('treats a 503 as WAKING: polls /health, then replays the request', async () => {
    const { d, urls } = deps([
      () => new Response('', { status: 503 }),
      () => new Response('<html>waking</html>', { headers: { 'content-type': 'text/html' } }),
      () => json(HEALTH),
      () => json(ROOM),
    ]);
    const room = await apiFetch('resolveRoom', { params: { code: 'K7P2QX' }, token: 't' }, d);
    expect(room.roomId).toBe(ROOM.roomId);
    expect(urls).toEqual([
      'http://api.test/rooms/K7P2QX',
      'http://api.test/health',
      'http://api.test/health',
      'http://api.test/rooms/K7P2QX',
    ]);
    expect(wakeStore.isWaking()).toBe(false);
  });

  it('treats Render’s HTML spin-up page (status 200) as WAKING', async () => {
    const { d, urls } = deps([
      () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      () => json(HEALTH),
      () => json(ROOM),
    ]);
    await apiFetch('resolveRoom', { params: { code: 'K7P2QX' } }, d);
    expect(urls).toHaveLength(3);
  });

  it('treats a fetch TypeError while online as WAKING, and offline as offline', async () => {
    const waking = deps([
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => json(HEALTH),
      () => json(ROOM),
    ]);
    await expect(
      apiFetch('resolveRoom', { params: { code: 'K7P2QX' } }, waking.d),
    ).resolves.toMatchObject({ code: 'K7P2QX' });

    const offline = deps(
      [
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
      false,
    );
    await expect(
      apiFetch('resolveRoom', { params: { code: 'K7P2QX' } }, offline.d),
    ).rejects.toMatchObject({ code: 'offline' });
  });

  it('maps JSON errors to ApiError codes', async () => {
    const { d } = deps([() => json({ error: 'not_found' }, 404)]);
    const error: unknown = await apiFetch('resolveRoom', { params: { code: 'K7P2QX' } }, d).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('validates the request body with the protocol schema before sending', async () => {
    const { d, urls } = deps([]);
    await expect(
      apiFetch(
        'createRoom',
        { body: { gameId: 'Not An Id', mode: 'classic', seatCount: 2, options: {} } },
        d,
      ),
    ).rejects.toThrow();
    expect(urls).toEqual([]);
  });
});
