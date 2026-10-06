import { describe, expect, it } from 'vitest';
import { formatEnvError, parseEnv, REQUIRED_KEYS } from '../src/env';
import { rawEnv } from './helpers';

describe('parseEnv', () => {
  it('parses a complete env with defaults', () => {
    const result = parseEnv(rawEnv({ LOG_LEVEL: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.PORT).toBe(10_000);
    expect(result.env.AUTH_TRANSPORT).toBe('bearer');
    expect(result.env.TRUST_PROXY_HOPS).toBe(0);
    expect(result.env.LOG_LEVEL).toBe('info');
    expect(result.env.BUILD_SHA).toBe('dev');
    expect(result.env.CORS_ORIGINS).toEqual(['https://web.example.test', 'http://localhost:8081']);
  });

  it('lists every missing required key, and never echoes values', () => {
    const result = parseEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([...REQUIRED_KEYS]);
    const message = formatEnvError(result);
    for (const key of REQUIRED_KEYS) expect(message).toContain(key);
  });

  it('treats a blank required key as missing', () => {
    const result = parseEnv(rawEnv({ JWT_SECRET: '   ', CORS_ORIGINS: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['JWT_SECRET', 'CORS_ORIGINS']);
  });

  it('reports invalid values by key without printing them', () => {
    const shortSecret = 'too-short-secret';
    const result = parseEnv(
      rawEnv({ ADMIN_TOKEN: shortSecret, CORS_ORIGINS: 'not a url', DATABASE_URL: 'mysql://x' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid.map((issue) => issue.key).sort()).toEqual([
      'ADMIN_TOKEN',
      'CORS_ORIGINS',
      'DATABASE_URL',
    ]);
    const message = formatEnvError(result);
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain('mysql://x');
  });

  it('treats blank optional keys as unset and reports the disabled features', () => {
    const result = parseEnv(
      rawEnv({
        GOOGLE_CLIENT_IDS: '',
        EXPO_ACCESS_TOKEN: ' ',
        SENTRY_DSN: '',
        DEV_USER_IDS: '',
        MIN_PROTOCOL_VERSION: '',
        PORT: '',
        AUTH_TRANSPORT: '',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.GOOGLE_CLIENT_IDS).toBeUndefined();
    expect(result.env.EXPO_ACCESS_TOKEN).toBeUndefined();
    expect(result.env.SENTRY_DSN).toBeUndefined();
    expect(result.env.DEV_USER_IDS).toBeUndefined();
    expect(result.env.MIN_PROTOCOL_VERSION).toBeUndefined();
    expect(result.env.PORT).toBe(10_000);
    expect(result.env.AUTH_TRANSPORT).toBe('bearer');
    expect(result.disabledFeatures).toHaveLength(4);
  });

  it('parses optional lists and numbers, and BUILD_SHA from RENDER_GIT_COMMIT', () => {
    const result = parseEnv(
      rawEnv({
        GOOGLE_CLIENT_IDS: 'a.apps.googleusercontent.com, b.apps.googleusercontent.com',
        DEV_USER_IDS: 'u1,u2',
        MIN_PROTOCOL_VERSION: '2',
        TRUST_PROXY_HOPS: '1',
        AUTH_TRANSPORT: 'cookie',
        RENDER_GIT_COMMIT: 'abc123',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.GOOGLE_CLIENT_IDS).toEqual([
      'a.apps.googleusercontent.com',
      'b.apps.googleusercontent.com',
    ]);
    expect(result.env.DEV_USER_IDS).toEqual(['u1', 'u2']);
    expect(result.env.MIN_PROTOCOL_VERSION).toBe(2);
    expect(result.env.TRUST_PROXY_HOPS).toBe(1);
    expect(result.env.AUTH_TRANSPORT).toBe('cookie');
    expect(result.env.BUILD_SHA).toBe('abc123');
    expect(result.disabledFeatures).toHaveLength(2);
  });
});
