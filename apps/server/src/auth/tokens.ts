// Tokens (ARCHITECTURE §7): a 15-minute HS256 access JWT (claims sub/iat/exp, verified statelessly)
// and an opaque 256-bit refresh token stored only as HMAC(REFRESH_SECRET, token). Rotation derives
// the successor as HMAC(K_ROTATE, old token), so re-presenting a just-rotated token can return the
// same successor without storing it in the clear.

import { createHmac, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { UuidSchema } from '@gp/protocol';

export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 60;

export interface TokenKeys {
  jwtSecret: string;
  refreshSecret: string;
  rotateSecret: string;
}

export interface AccessToken {
  token: string;
  /** Wall time (ms) when it expires. */
  expiresAt: number;
}

const ALG = 'HS256';
const encoder = new TextEncoder();

export class TokenService {
  private readonly jwtKey: Uint8Array;

  constructor(private readonly keys: TokenKeys) {
    this.jwtKey = encoder.encode(keys.jwtSecret);
  }

  async signAccess(userId: string, nowMs: number = Date.now()): Promise<AccessToken> {
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_SEC;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: ALG, typ: 'JWT' })
      .setSubject(userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.jwtKey);
    return { token, expiresAt: exp * 1000 };
  }

  /** The user id of a valid, unexpired access token, or null. Never touches the DB. */
  async verifyAccess(token: string): Promise<string | null> {
    if (token.length === 0 || token.length > 4096) return null;
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, { algorithms: [ALG] });
      const sub = UuidSchema.safeParse(payload.sub);
      return sub.success && typeof payload.exp === 'number' ? sub.data : null;
    } catch {
      return null;
    }
  }

  /** A fresh opaque refresh token (256 random bits, base64url). */
  newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** What `refresh_tokens.token_hash` stores. */
  hashRefresh(token: string): string {
    return createHmac('sha256', this.keys.refreshSecret).update(token).digest('base64url');
  }

  /** The deterministic successor of `token`: the same input always rotates to the same output. */
  successorOf(token: string): string {
    return createHmac('sha256', this.keys.rotateSecret).update(token).digest('base64url');
  }

  /** `users.guest_key_hash`: keyed, so a leaked table can't be checked against guessed keys. */
  hashGuestKey(guestKey: string): string {
    return createHmac('sha256', this.keys.refreshSecret)
      .update(`guest-key:${guestKey}`)
      .digest('base64url');
  }
}

/** `Authorization: Bearer <token>` → the token, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '');
  return match?.[1] ?? null;
}
