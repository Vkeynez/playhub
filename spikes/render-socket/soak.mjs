// Spike (b): hold one Socket.IO connection to the deployed api for N minutes and log every
// connect, disconnect, server:moving and restart (new bootId/epoch). One JSON line per event.
//
//   scripts/isolated.sh node spikes/render-socket/soak.mjs [url] [minutes]
//
// Throwaway code. Run it from outside the corporate network (the spike-render workflow does).
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// SOCKET_IO_CLIENT_DIR lets a CI runner point at a scratch npm install instead of apps/server.
const base = process.env.SOCKET_IO_CLIENT_DIR
  ? pathToFileURL(`${process.env.SOCKET_IO_CLIENT_DIR}/noop.js`)
  : new URL('../../apps/server/package.json', import.meta.url);
const require = createRequire(base);
const { io } = require('socket.io-client');

const url = process.argv[2] ?? 'https://playhub-api-nlgk.onrender.com';
const minutes = Number(process.argv[3] ?? 32);
const start = Date.now();
const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: Math.round((Date.now() - start) / 1000), event, ...data }));

const deviceId = randomUUID();
const socket = io(url, { transports: ['websocket'], reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
const stats = { connects: 0, disconnects: 0, moving: 0, rtts: [], boots: new Set(), epochs: new Set() };

function hello() {
  socket
    .timeout(15_000)
    .emit(
      'hello',
      { protocolVersion: 1, appVersion: '0.0.1', platform: 'web', deviceId, locale: 'en' },
      (err, ack) => {
        if (err) return log('hello-timeout');
        stats.boots.add(ack.bootId);
        stats.epochs.add(ack.epoch);
        log('hello', { ok: ack.ok, bootId: String(ack.bootId).slice(0, 8), epoch: ack.epoch });
      },
    );
}

socket.on('connect', () => {
  stats.connects += 1;
  log('connect', { n: stats.connects });
  hello();
});
socket.on('disconnect', (reason) => {
  stats.disconnects += 1;
  log('disconnect', { reason });
  // Socket.IO doesn't reconnect by itself after a server-side disconnect (ARCHITECTURE §4.4).
  if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 500 + Math.random() * 2500);
});
socket.on('server:moving', (payload) => {
  stats.moving += 1;
  log('server:moving', payload);
});
socket.on('connect_error', (e) => log('connect_error', { message: e.message }));

const ping = setInterval(() => {
  const sent = Date.now();
  socket.timeout(10_000).emit('clock:ping', { t0: sent }, (err) => {
    if (err) return log('ping-timeout');
    stats.rtts.push(Date.now() - sent);
  });
}, 60_000);

setTimeout(() => {
  clearInterval(ping);
  const rtts = [...stats.rtts].sort((a, b) => a - b);
  log('summary', {
    minutes,
    connects: stats.connects,
    disconnects: stats.disconnects,
    serverMoving: stats.moving,
    distinctBoots: stats.boots.size,
    epochs: [...stats.epochs],
    pings: rtts.length,
    rttP50: rtts[Math.floor(rtts.length / 2)],
    rttMax: rtts.at(-1),
  });
  socket.close();
  process.exit(0);
}, minutes * 60_000);
