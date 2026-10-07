// Session (ARCHITECTURE §6.2, §7): the local identity, then the server guest and its tokens.
//
// - The local identity is created on first launch and never needs the server.
// - The server guest (POST /auth/guest) is created the first time multiplayer needs a token.
// - Refresh is single-flight: one shared promise per runtime and, on web, one tab at a time via
//   navigator.locks ('auth-refresh'), re-reading the stored tokens inside the lock so a refresh done
//   by another tab is reused instead of spending the refresh token twice.
// Pure: dependencies are injected, so tests run it without a network, storage or React.
import type { AuthSession, GuestAuthRequest, Me } from '@gp/protocol';

import { createIdentity, cryptoRandomBytes, isLocalIdentity } from './identity';
import type { LocalIdentity, RandomBytes } from './identity';
import type { Kv } from './kv';

export const IDENTITY_KEY = 'identity.v1';
export const TOKENS_KEY = 'auth.v1';
/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 60_000;

export interface StoredTokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string | null;
  user: Me;
}

export interface LockManagerLike {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface SessionDeps {
  kv: Kv;
  /** POST /auth/guest. */
  guest(body: GuestAuthRequest): Promise<AuthSession>;
  /** POST /auth/refresh; rejects with an error whose `status` is 401 when the token is dead. */
  refresh(refreshToken: string): Promise<AuthSession>;
  now(): number;
  locks?: LockManagerLike | null;
  random?: RandomBytes;
  /** Extra fields for POST /auth/guest (locale, platform). */
  guestExtras?(): Pick<GuestAuthRequest, 'locale' | 'platform'>;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === 'string' &&
    typeof v.accessTokenExpiresAt === 'number' &&
    (typeof v.refreshToken === 'string' || v.refreshToken === null) &&
    typeof v.user === 'object' &&
    v.user !== null
  );
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isUnauthorized(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 401;
}

export class Session {
  private identityPromise: Promise<LocalIdentity> | null = null;
  private tokens: StoredTokens | null = null;
  private tokensLoaded: Promise<void> | null = null;
  private guestPromise: Promise<StoredTokens> | null = null;
  private refreshPromise: Promise<StoredTokens> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionDeps) {}

  /** The local identity, created (and stored) on first call. Never touches the network. */
  identity(): Promise<LocalIdentity> {
    this.identityPromise ??= this.loadIdentity();
    return this.identityPromise;
  }

  /** The signed-in server user, once multiplayer has been used. */
  get user(): Me | null {
    return this.tokens?.user ?? null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** A valid access token: creates the server guest on first use, refreshes when close to expiry. */
  async getAccessToken(): Promise<string> {
    await this.loadTokens();
    let tokens = this.tokens ?? (await this.ensureGuest());
    if (tokens.accessTokenExpiresAt - this.deps.now() < REFRESH_MARGIN_MS) {
      tokens = await this.refresh(tokens.accessToken);
    }
    return tokens.accessToken;
  }

  /**
   * Single-flight refresh. `staleToken` is the access token the caller found expired or rejected;
   * if storage already holds a different, fresh token (another tab refreshed), that one is used.
   */
  refresh(staleToken?: string): Promise<StoredTokens> {
    this.refreshPromise ??= this.withLock(() => this.doRefresh(staleToken)).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async loadIdentity(): Promise<LocalIdentity> {
    const stored = parseJson(await this.deps.kv.get(IDENTITY_KEY));
    if (isLocalIdentity(stored)) return stored;
    const identity = createIdentity(this.deps.random ?? cryptoRandomBytes);
    await this.deps.kv.set(IDENTITY_KEY, JSON.stringify(identity));
    return identity;
  }

  private loadTokens(): Promise<void> {
    this.tokensLoaded ??= this.readStoredTokens().then((t) => {
      this.tokens ??= t;
    });
    return this.tokensLoaded;
  }

  private async readStoredTokens(): Promise<StoredTokens | null> {
    const stored = parseJson(await this.deps.kv.get(TOKENS_KEY));
    return isStoredTokens(stored) ? stored : null;
  }

  private async save(session: AuthSession, previousRefresh: string | null): Promise<StoredTokens> {
    const tokens: StoredTokens = {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      refreshToken: session.refreshToken ?? previousRefresh,
      user: session.user,
    };
    this.tokens = tokens;
    await this.deps.kv.set(TOKENS_KEY, JSON.stringify(tokens));
    for (const fn of this.listeners) fn();
    return tokens;
  }

  private ensureGuest(): Promise<StoredTokens> {
    this.guestPromise ??= this.createGuest().finally(() => {
      this.guestPromise = null;
    });
    return this.guestPromise;
  }

  private async createGuest(): Promise<StoredTokens> {
    const identity = await this.identity();
    const session = await this.deps.guest({
      guestKey: identity.guestKey,
      name: identity.name,
      avatarSeed: identity.avatarSeed,
      deviceId: identity.deviceId,
      ...this.deps.guestExtras?.(),
    });
    return this.save(session, null);
  }

  private async doRefresh(staleToken: string | undefined): Promise<StoredTokens> {
    const stored = await this.readStoredTokens();
    if (
      stored &&
      stored.accessToken !== staleToken &&
      stored.accessTokenExpiresAt - this.deps.now() >= REFRESH_MARGIN_MS
    ) {
      this.tokens = stored;
      return stored;
    }
    const refreshToken = stored?.refreshToken ?? this.tokens?.refreshToken ?? null;
    if (!refreshToken) return this.createGuest();
    try {
      return await this.save(await this.deps.refresh(refreshToken), refreshToken);
    } catch (e) {
      // A dead refresh token: the guest key is still ours, so sign in as the guest again.
      if (isUnauthorized(e)) return this.createGuest();
      throw e;
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = this.deps.locks;
    return locks ? locks.request('auth-refresh', fn) : fn();
  }
}

/** navigator.locks when the browser has it (all evergreen browsers; not every old WebView). */
export function browserLocks(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  const locks = nav?.locks;
  if (!locks || typeof locks.request !== 'function') return null;
  return { request: (name, fn) => locks.request(name, fn) };
}
