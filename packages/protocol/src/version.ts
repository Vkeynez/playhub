/**
 * Wire protocol version (ARCHITECTURE §4.4).
 *
 * Changes are expand/contract: server N+1 accepts both N and N+1 for at least one release,
 * so `PROTOCOL_MIN_SUPPORTED` trails `PROTOCOL_VERSION` while a change rolls out.
 */
export const PROTOCOL_VERSION = 1;

/** The oldest client protocol this build still accepts in `hello`. */
export const PROTOCOL_MIN_SUPPORTED = 1;

export type ProtocolRange = { min: number; max: number };

export type ProtocolCompatibility =
  { ok: true } | { ok: false; reason: 'CLIENT_TOO_OLD' | 'SERVER_TOO_OLD' };

/**
 * Decides whether a client speaking `clientVersion` can talk to a server supporting `server`.
 * Used by the server's `hello` gate; the client shows "Update required" or "Server updating…".
 */
export function checkProtocol(
  clientVersion: number,
  server: ProtocolRange = { min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_VERSION },
): ProtocolCompatibility {
  if (clientVersion < server.min) return { ok: false, reason: 'CLIENT_TOO_OLD' };
  if (clientVersion > server.max) return { ok: false, reason: 'SERVER_TOO_OLD' };
  return { ok: true };
}
