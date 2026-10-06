// Engine-facing types (ARCHITECTURE §3.3): injected dependencies, the action log, snapshots and step records.

import { z } from 'zod';

import type {
  Awaiting,
  BotLevel,
  Effect,
  GameEvent,
  MatchResult,
  RngState,
  Seat,
  SeatInfo,
  Seed128,
} from '../core';

/** One timer per room. The room layer usually wraps `fire` so it runs on the room's serialized queue. */
export interface Scheduler {
  /** Calls `fire` at wall time `at` (ms, may be in the past). Returns a function that cancels the call. */
  schedule(at: number, fire: () => void): () => void;
}

/** Runs effects (Carrom physics) off the reducer. Outputs must be JSON values: they are logged. */
export interface EffectRunner {
  run(effect: Effect): Promise<unknown>;
}

export type LogKind = 'action' | 'timeout' | 'tick' | 'effect' | 'clock';

/**
 * One entry of a match's action log (`match_actions`). `now` is the game time the entry was applied at;
 * replays feed it back as ctx.now. Timeouts carry no action: replay calls onTimeout with the same stream.
 */
export type LogEntry =
  | {
      seq: number;
      kind: 'action';
      seat: Seat;
      payload: { action: unknown };
      now: number;
      clientActionId?: string;
    }
  | { seq: number; kind: 'timeout'; seat: Seat; payload: Record<string, never>; now: number }
  | { seq: number; kind: 'tick'; payload: Record<string, never>; now: number }
  | { seq: number; kind: 'effect'; payload: { id: string; output: unknown }; now: number }
  /** clockOffset changed (freeze/unfreeze, restore). `epoch` is set when a new server process took over. */
  | { seq: number; kind: 'clock'; payload: { clockOffset: number; epoch?: number }; now: number };

/** Who drives a seat. `occupantEpoch` increases on every change, so late bot results can be recognised. */
export type SeatControl =
  | { kind: 'human'; connected: boolean; occupantEpoch: number }
  | { kind: 'bot'; level: BotLevel; occupantEpoch: number };

/** Everything needed to resume a match (stored as jsonb). `S` is the module state. */
export interface EngineSnapshot<S = unknown> {
  format: 1;
  stateVersion: number;
  logicVersion: number;
  S: S;
  rng: { game: RngState; bot: RngState };
  version: number;
  /** Per seat: the version at which its current decision began, or null when not awaited. */
  awaitedSince: (number | null)[];
  afkCounters: number[];
  seatControl: SeatControl[];
  /** Effects issued whose result is not logged yet; re-issued on restore. */
  pendingEffects: Effect[];
  clockOffset: number;
  lastSeq: number;
  lastNow: number;
}

/** What one applied log entry did. `state` and raw `events` are server-only; send `outputFor()` instead. */
export interface StepRecord<S, E extends GameEvent> {
  entry: LogEntry;
  version: number;
  state: S;
  events: E[];
  effects: Effect[];
  awaiting: Awaiting;
  /** A new decision began, a tick/effect changed the phase, or the match ended: write through before publishing. */
  decisionBoundary: boolean;
  result: MatchResult | null;
}

export interface EngineHooks<S, E extends GameEvent> {
  /** Called after every applied entry (live mode). Persist `record.entry`, then publish per-viewer outputs. */
  onStep?(record: StepRecord<S, E>): void;
  /** A seat reached AFK_TIMEOUT_LIMIT consecutive timeouts. Takeover policy belongs to the room layer. */
  onAfk?(seat: Seat, consecutiveTimeouts: number): void;
  /** Errors from timers, bots and effects. Without a handler they are rethrown. */
  onError?(error: unknown): void;
}

export interface EngineDeps<S, E extends GameEvent> {
  /** Wall clock in ms (server time). */
  clock: () => number;
  /** Absent: no timer is armed; call `wake()` yourself. */
  scheduler?: Scheduler;
  /** Absent: effects stay pending until `deliverEffect()`. */
  effects?: EffectRunner;
  /** The room's serialized queue for async inputs (timers, bot results, effect results). Default: run now. */
  enqueue?: (task: () => void) => void;
  /** Server process epoch (§5.5); versions are epoch * 2^32 + n. Default 0. */
  epoch?: number;
  /** Deep-freeze state, actions and outputs handed to the module (tests; proves reducers don't mutate). */
  freezeInputs?: boolean;
  hooks?: EngineHooks<S, E>;
}

export interface MatchSetup {
  /** Room config; parsed with the module's configSchema. */
  config: unknown;
  mode: string;
  seats: SeatInfo[];
  seed: Seed128;
  /** Game time at init. Default: the wall clock, i.e. clockOffset 0. */
  initNow?: number;
  /** Human seats connected at start. Default: every human seat. */
  connectedSeats?: readonly Seat[];
}

export type Ack = { ok: true; version: number; seq: number; duplicate: boolean };

export interface SubmitOptions {
  /** The state version the client acted on. */
  baseVersion: number;
  clientActionId?: string;
}

/** Engine metadata for one viewer: awaited seats and the deadline in wall time. */
export interface EngineMeta {
  version: number;
  awaiting: { seats: Seat[]; deadlineAt: number | null };
  paused: boolean;
  finished: boolean;
}

export interface ViewerOutput<V, E> {
  version: number;
  view: V;
  events: E[];
  meta: EngineMeta;
}

// ---- schemas (trust boundary: rows read back from Postgres) ----

const u32 = z.number().int().min(0).max(0xffff_ffff);
const rngStateSchema = z
  .tuple([u32, u32, u32, u32])
  .refine((words) => words.some((w) => w !== 0), 'rng state must not be all zero');
const seat = z.number().int().min(0);
const now = z.number().finite();
const seq = z.number().int().min(1);
const empty = z.object({}).strict() as z.ZodType<Record<string, never>>;

export const effectSchema: z.ZodType<Effect> = z.object({
  kind: z.literal('simulate'),
  id: z.string(),
  input: z.unknown(),
});

export const logEntrySchema: z.ZodType<LogEntry> = z.discriminatedUnion('kind', [
  z.object({
    seq,
    kind: z.literal('action'),
    seat,
    payload: z.object({ action: z.unknown() }),
    now,
    clientActionId: z.string().optional(),
  }),
  z.object({ seq, kind: z.literal('timeout'), seat, payload: empty, now }),
  z.object({ seq, kind: z.literal('tick'), payload: empty, now }),
  z.object({
    seq,
    kind: z.literal('effect'),
    payload: z.object({ id: z.string(), output: z.unknown() }),
    now,
  }),
  z.object({
    seq,
    kind: z.literal('clock'),
    payload: z.object({
      clockOffset: z.number().finite(),
      epoch: z.number().int().min(0).optional(),
    }),
    now,
  }),
]);

export const seatControlSchema: z.ZodType<SeatControl> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('human'),
    connected: z.boolean(),
    occupantEpoch: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('bot'),
    level: z.enum(['easy', 'medium', 'hard']),
    occupantEpoch: z.number().int().min(0),
  }),
]);

export const engineSnapshotSchema: z.ZodType<EngineSnapshot> = z.object({
  format: z.literal(1),
  stateVersion: z.number().int(),
  logicVersion: z.number().int(),
  S: z.unknown(),
  rng: z.object({ game: rngStateSchema, bot: rngStateSchema }),
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  awaitedSince: z.array(z.number().int().min(0).nullable()),
  afkCounters: z.array(z.number().int().min(0)),
  seatControl: z.array(seatControlSchema),
  pendingEffects: z.array(effectSchema),
  clockOffset: z.number().finite(),
  lastSeq: z.number().int().min(0),
  lastNow: z.number().finite(),
});
