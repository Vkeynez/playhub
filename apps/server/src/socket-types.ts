// Socket.IO typings shared by the realtime layer and the room handlers.

import type { Server, Socket } from 'socket.io';
import type { Hello, RawClientToServerEvents, ServerToClientEvents } from '@gp/protocol';

export interface SocketData {
  hello: Hello | null;
  /** From the access JWT checked at the handshake. */
  userId: string;
  /** Rooms this socket has joined (as a player or a spectator). */
  rooms: Set<string>;
}

type InterServerEvents = Record<string, never>;

export type RealtimeServer = Server<
  RawClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type RoomSocket = Socket<
  RawClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
