import type { z } from 'zod';
import {
  ClockPingSchema,
  ClockPongSchema,
  GameActionAckSchema,
  GameActionSchema,
  HelloAckSchema,
  HelloSchema,
  LobbyAckSchema,
  PresenceSchema,
  ReactSchema,
  RoomJoinAckSchema,
  RoomJoinSchema,
  RoomKickSchema,
  RoomLeaveSchema,
  RoomOptionsSchema,
  RoomReadySchema,
  RoomRematchSchema,
  RoomStartSchema,
} from './client-events';
import {
  ReactionEventSchema,
  RoomClosedEventSchema,
  RoomKickedEventSchema,
  RoomStateEventSchema,
  ServerErrorEventSchema,
  ServerMovingEventSchema,
} from './server-events';

type ClientEventSpec = { payload: z.ZodType; ack: z.ZodType | null };

/** Client → server: each event's payload schema, and its ack schema (`null` = no ack). */
export const clientEvents = {
  hello: { payload: HelloSchema, ack: HelloAckSchema },
  'clock:ping': { payload: ClockPingSchema, ack: ClockPongSchema },
  'room:join': { payload: RoomJoinSchema, ack: RoomJoinAckSchema },
  'room:ready': { payload: RoomReadySchema, ack: LobbyAckSchema },
  'room:options': { payload: RoomOptionsSchema, ack: LobbyAckSchema },
  'room:kick': { payload: RoomKickSchema, ack: LobbyAckSchema },
  'room:start': { payload: RoomStartSchema, ack: LobbyAckSchema },
  'room:rematch': { payload: RoomRematchSchema, ack: LobbyAckSchema },
  'room:leave': { payload: RoomLeaveSchema, ack: LobbyAckSchema },
  'game:action': { payload: GameActionSchema, ack: GameActionAckSchema },
  react: { payload: ReactSchema, ack: null },
  presence: { payload: PresenceSchema, ack: null },
} as const satisfies Record<string, ClientEventSpec>;

/** Server → client: each event's payload schema. */
export const serverEvents = {
  'room:state': RoomStateEventSchema,
  reaction: ReactionEventSchema,
  'room:closed': RoomClosedEventSchema,
  'room:kicked': RoomKickedEventSchema,
  'server:moving': ServerMovingEventSchema,
  error: ServerErrorEventSchema,
} as const satisfies Record<string, z.ZodType>;

type ClientEvents = typeof clientEvents;
type ServerEvents = typeof serverEvents;

export type ClientEventName = keyof ClientEvents;
export type ServerEventName = keyof ServerEvents;

/** Client events that expect an ack. */
export type AckedClientEventName = {
  [E in ClientEventName]: ClientEvents[E]['ack'] extends z.ZodType ? E : never;
}[ClientEventName];

/** What the client sends (before parsing). */
export type ClientEventInput<E extends ClientEventName> = z.input<ClientEvents[E]['payload']>;
/** What the server works with (after parsing: unknown keys stripped, codes normalized). */
export type ClientEventPayload<E extends ClientEventName> = z.output<ClientEvents[E]['payload']>;
export type ClientEventAck<E extends AckedClientEventName> = z.output<
  Exclude<ClientEvents[E]['ack'], null>
>;
export type ServerEventPayload<E extends ServerEventName> = z.output<ServerEvents[E]>;

type AckCallback<E extends ClientEventName> = E extends AckedClientEventName
  ? (response: ClientEventAck<E>) => void
  : never;

/**
 * Socket.IO typings for the client: `io<ServerToClientEvents, ClientToServerEvents>()`.
 * Events with an ack take a callback as the second argument.
 */
export type ClientToServerEvents = {
  [E in ClientEventName]: E extends AckedClientEventName
    ? (payload: ClientEventInput<E>, ack: AckCallback<E>) => void
    : (payload: ClientEventInput<E>) => void;
};

/**
 * The server-side view of client events: payloads are `unknown` until `parseClientEvent`
 * accepts them, and a client may omit the ack callback, so check it before calling.
 */
export type RawClientToServerEvents = {
  [E in ClientEventName]: E extends AckedClientEventName
    ? (payload: unknown, ack?: AckCallback<E>) => void
    : (payload: unknown) => void;
};

export type ServerToClientEvents = {
  [E in ServerEventName]: (payload: ServerEventPayload<E>) => void;
};

export const CLIENT_EVENT_NAMES = Object.keys(clientEvents) as ClientEventName[];
export const SERVER_EVENT_NAMES = Object.keys(serverEvents) as ServerEventName[];

export function isClientEventName(name: string): name is ClientEventName {
  return Object.hasOwn(clientEvents, name);
}

export function isServerEventName(name: string): name is ServerEventName {
  return Object.hasOwn(serverEvents, name);
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: z.ZodError };

function parseWith<T>(schema: z.ZodType, value: unknown): ParseResult<T> {
  const result = schema.safeParse(value);
  // The caller picks `schema` from a map keyed by the same event name that determines `T`;
  // TypeScript can't correlate the two through the generic index, so the link is asserted here.
  return result.success ? { ok: true, data: result.data as T } : { ok: false, error: result.error };
}

/** Parses a client event payload on the server. Unknown keys are stripped. */
export function parseClientEvent<E extends ClientEventName>(
  event: E,
  payload: unknown,
): ParseResult<ClientEventPayload<E>> {
  return parseWith(clientEvents[event].payload, payload);
}

/** Parses the server's ack to a client event, on the client. */
export function parseClientAck<E extends AckedClientEventName>(
  event: E,
  response: unknown,
): ParseResult<ClientEventAck<E>> {
  const schema: z.ZodType = clientEvents[event].ack;
  return parseWith(schema, response);
}

/** Parses a server event payload on the client. Unknown keys are stripped. */
export function parseServerEvent<E extends ServerEventName>(
  event: E,
  payload: unknown,
): ParseResult<ServerEventPayload<E>> {
  return parseWith(serverEvents[event], payload);
}
