// Builds a live RemoteRoom: a websocket-only Socket.IO client (loaded lazily, so Home never pays
// for it) whose `auth` is a callback that hands over a fresh access token on every (re)connect.
import { PROTOCOL_VERSION } from '@gp/protocol';

import { i18n } from '../i18n';
import { waitForHealth } from '../net/api';
import { getSession } from '../net/client';
import { API_URL, APP_VERSION } from '../net/config';
import { base64url, cryptoRandomBytes } from '../net/identity';
import { WIRE_PLATFORM } from '../net/platform';
import { RemoteRoom } from './RemoteRoom';
import type { SocketHandler, SocketLike } from './RemoteRoom';

async function createSocket(lastToken: { current: string | undefined }): Promise<SocketLike> {
  const { io } = await import('socket.io-client');
  const session = getSession();
  const socket = io(API_URL, {
    transports: ['websocket'],
    autoConnect: false,
    reconnection: false,
    auth: (cb) => {
      session.getAccessToken().then(
        (token) => {
          lastToken.current = token;
          cb({ token });
        },
        () => cb({}),
      );
    },
  });
  return {
    get connected() {
      return socket.connected;
    },
    connect: () => void socket.connect(),
    disconnect: () => void socket.disconnect(),
    on: (event: string, fn: SocketHandler) => void socket.on(event, fn),
    off: (event: string, fn: SocketHandler) => void socket.off(event, fn),
    emit: (event: string, payload: unknown, ack?: (response: unknown) => void) =>
      void (ack ? socket.emit(event, payload, ack) : socket.emit(event, payload)),
  };
}

export interface ConnectOptions {
  roomId: string;
  asSpectator?: boolean;
}

export async function connectRoom(options: ConnectOptions): Promise<RemoteRoom> {
  const session = getSession();
  // Creates the server guest on first use, before the socket handshake needs a token.
  await session.getAccessToken();
  const identity = await session.identity();
  const lastToken: { current: string | undefined } = { current: undefined };
  const socket = await createSocket(lastToken);
  const room = new RemoteRoom({
    socket,
    roomId: options.roomId,
    ...(options.asSpectator ? { asSpectator: true } : {}),
    hello: () => ({
      protocolVersion: PROTOCOL_VERSION,
      appVersion: APP_VERSION,
      platform: WIRE_PLATFORM,
      deviceId: identity.deviceId,
      locale: i18n.language === 'ta' ? 'ta' : 'en',
    }),
    refreshAuth: async () => {
      await session.refresh(lastToken.current);
    },
    waitForServer: () => waitForHealth(),
    newActionId: () => base64url(cryptoRandomBytes(12)),
  });
  room.start();
  return room;
}
