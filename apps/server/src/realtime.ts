// Socket.IO on Fastify's HTTP server (ARCHITECTURE §5.1 `realtime`, §4.4). M2 scope: the `hello`
// version gate and `clock:ping`. No handler here may touch Postgres (§5.3 rule 3); JWT checks at the
// handshake arrive with auth (P0-M3).

import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import {
  checkProtocol,
  isClientEventName,
  parseClientEvent,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  type Hello,
  type HelloAck,
  type ProtocolRange,
  type RawClientToServerEvents,
  type ServerToClientEvents,
} from '@gp/protocol';

export interface RealtimeOptions {
  corsOrigins: string[];
  /** Cookie auth needs credentialed CORS; bearer auth doesn't. */
  credentials: boolean;
  bootId: string;
  epoch: number;
  /** `MIN_PROTOCOL_VERSION` from the env; defaults to the build's `PROTOCOL_MIN_SUPPORTED`. */
  minProtocolVersion?: number;
}

/** The `hello` ack, including `bootId` and `epoch` (part of `HelloAckSchema`). */
export type HelloAckWithBoot = HelloAck & { bootId: string; epoch: number };

interface SocketData {
  hello: Hello | null;
}

type InterServerEvents = Record<string, never>;

export type RealtimeServer = Server<
  RawClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface Realtime {
  io: RealtimeServer;
  protocol: ProtocolRange;
  socketCount(): number;
  /** Deploy drain (§5.6): tells every client to reconnect elsewhere, then closes the sockets. */
  drain(reason: 'DEPLOY' | 'FENCED'): void;
}

const HANDLED_EVENTS = new Set(['hello', 'clock:ping']);
/** Payloads in M2 are tiny; this bounds memory per message well below the 1 MB default. */
const MAX_MESSAGE_BYTES = 64 * 1024;

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

  io.on('connection', (socket) => {
    socket.data.hello = null;
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
      // Room events arrive with P0-M3+; until then every other event is unknown to this build.
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
