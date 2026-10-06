// @gp/protocol: zod schemas for every socket event and REST body, plus PROTOCOL_VERSION.
// Pure: no Node, DOM or platform imports (ARCHITECTURE §2).

export * from './version';
export * from './primitives';
export * from './room-code';

export * from './socket/room-state';
export * from './socket/client-events';
export * from './socket/server-events';
export * from './socket/events';

export * from './rest/errors';
export * from './rest/auth';
export * from './rest/catalog';
export * from './rest/rooms';
export * from './rest/profile';
export * from './rest/sync';
export * from './rest/routes';
