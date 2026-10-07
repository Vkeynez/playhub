// Socket.IO on Fastify's HTTP server (ARCHITECTURE §5.1 `realtime`, §4.4): the access-JWT check
// at the handshake (stateless, no DB), the `hello` version gate, `clock:ping`, the per-user socket
// cap and the room events. `hello`, `clock:ping` and connects never touch Postgres (§5.3 rule 3).

import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import {
  checkProtocol,
  isClientEventName,
  parseClientEvent,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  type HelloAck,
  type ProtocolRange,
} from '@gp/protocol';
import type { TokenService } from './auth/tokens';
import { attachRoomHandlers, ROOM_EVENTS, type RoomSocketContext } from './rooms/socket';
import type { RealtimeServer, RoomSocket } from './socket-types';

export type { RealtimeServer } from './socket-types';

export interface RealtimeOptions {
  corsOrigins: string[];
  /** Cookie auth needs credentialed CORS; bearer auth doesn't. */
  credentials: boolean;
  bootId: string;
  epoch: number;
  /** `MIN_PROTOCOL_VERSION` from the env; defaults to the build's `PROTOCOL_MIN_SUPPORTED`. */
  minProtocolVersion?: number;
  /** Verifies `handshake.auth.token`. */
  tokens: TokenService;
  rooms: RoomSocketContext;
}

/** The `hello` ack, including `bootId` and `epoch` (part of `HelloAckSchema`). */
export type HelloAckWithBoot = HelloAck & { bootId: string; epoch: number };

export interface Realtime {
  io: RealtimeServer;
  protocol: ProtocolRange;
  socketCount(): number;
  /** Deploy drain (§5.6): tells every client to reconnect elsewhere, then closes the sockets. */
  drain(reason: 'DEPLOY' | 'FENCED'): void;
}

const HANDLED_EVENTS = new Set<string>(['hello', 'clock:ping', ...ROOM_EVENTS]);
/** Payloads are small; this bounds memory per message well below the 1 MB default. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** Sockets per user (§5.4); a new one evicts the oldest. */
export const MAX_SOCKETS_PER_USER = 3;

/**
 * CORS doesn't apply to WebSocket upgrades, so the Origin is checked here (cross-site WebSocket
 * hijacking matters once cookie auth exists). No Origin (Node clients) and same-host origins pass:
 * React Native's Android WebSocket sends the server's own origin by default.
 */
function originAllowed(origin: string | undefined, host: string | undefined, allowed: Set<string>) {
  if (origin === undefined || allowed.has(origin)) return true;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function attachRealtime(app: FastifyInstance, options: RealtimeOptions): Realtime {
  const allowedOrigins = new Set(options.corsOrigins);
  const protocol: ProtocolRange = {
    min: options.minProtocolVersion ?? PROTOCOL_MIN_SUPPORTED,
    max: PROTOCOL_VERSION,
  };
  const io: RealtimeServer = new Server(app.server, {
    transports: ['websocket'],
    perMessageDeflate: false,
    serveClient: false,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    cors: { origin: options.corsOrigins, credentials: options.credentials },
    allowRequest: (request, callback) =>
      callback(null, originAllowed(request.headers.origin, request.headers.host, allowedOrigins)),
  });

  // The access JWT, verified statelessly (no DB) before the connection is accepted (§7).
  io.use((socket, next) => {
    const auth: unknown = socket.handshake.auth;
    const token =
      typeof auth === 'object' && auth !== null && 'token' in auth ? auth.token : undefined;
    if (typeof token !== 'string') return next(new Error('UNAUTHORIZED'));
    options.tokens.verifyAccess(token).then(
      (userId) => {
        if (userId === null) return next(new Error('UNAUTHORIZED'));
        socket.data.userId = userId;
        socket.data.hello = null;
        socket.data.rooms = new Set();
        next();
      },
      () => next(new Error('UNAUTHORIZED')),
    );
  });

  const userSockets = new Map<string, RoomSocket[]>();

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const mine = userSockets.get(userId) ?? [];
    mine.push(socket);
    userSockets.set(userId, mine);
    while (mine.length > MAX_SOCKETS_PER_USER) mine.shift()?.disconnect(true);
    socket.on('disconnect', () => {
      const list = userSockets.get(userId);
      if (!list) return;
      const index = list.indexOf(socket);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) userSockets.delete(userId);
    });

    attachRoomHandlers(socket, options.rooms);
    const invalid = (event: string) =>
      socket.emit('error', { code: 'INVALID_PAYLOAD', event: event.slice(0, 32) });

    socket.on('hello', (payload, ack) => {
      const parsed = parseClientEvent('hello', payload);
      if (!parsed.ok || typeof ack !== 'function') return invalid('hello');
      const check = checkProtocol(parsed.data.protocolVersion, protocol);
      const base = {
        serverTime: Date.now(),
        protocol,
        bootId: options.bootId,
        epoch: options.epoch,
      };
      const response: HelloAckWithBoot = check.ok
        ? { ok: true, ...base }
        : { ok: false, reason: check.reason, ...base };
      if (check.ok) socket.data.hello = parsed.data;
      ack(response);
    });

    socket.on('clock:ping', (payload, ack) => {
      const parsed = parseClientEvent('clock:ping', payload);
      if (!parsed.ok || typeof ack !== 'function') return invalid('clock:ping');
      ack({ t0: parsed.data.t0, ts: Date.now() });
    });

    socket.onAny((event: string) => {
      if (HANDLED_EVENTS.has(event)) return;
      const code =
        isClientEventName(event) && socket.data.hello === null ? 'HELLO_REQUIRED' : 'UNKNOWN_EVENT';
      socket.emit('error', { code, event: event.slice(0, 32) });
    });
  });

  const realtime: Realtime = {
    io,
    protocol,
    socketCount: () => io.engine.clientsCount,
    drain(reason) {
      io.emit('server:moving', { reason });
      // `true` closes the underlying connections, so Fastify's close() isn't held open by them.
      io.disconnectSockets(true);
    },
  };

  // Fastify closes the HTTP server; Socket.IO only has to let go of its engine.
  app.addHook('preClose', (done) => {
    io.disconnectSockets(true);
    io.engine.close();
    done();
  });
  return realtime;
}
