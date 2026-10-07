// The server-side game registry (ARCHITECTURE §5.1 `engine`): the pure logic modules a room can run.
// Each entry wraps MatchEngine construction in a generic closure, so the room layer works with one
// non-generic `LiveMatch` interface whatever the game's state, action, view and event types are.

import {
  MatchEngine,
  type Ack,
  type CheckedModule,
  type EngineMeta,
  type EngineSnapshot,
  type LogEntry,
  type MatchSetup,
  type Scheduler,
  type StepRecord,
} from '@gp/game-sdk/engine';
import {
  allowedSeatCounts,
  type GameEvent,
  type GameManifest,
  type MatchResult,
  type ModeManifest,
  type Rejection,
  type Seat,
  type Viewer,
} from '@gp/game-sdk/core';
import { cricket } from '@gp/game-cricket/logic';
import { secretPick } from '@gp/game-dev-secret-pick/logic';
import { ticTacToe } from '@gp/game-dev-tictactoe/logic';

/**
 * Raw events of one or more engine steps, closed over by the wrapper so they can only come out
 * redacted for a viewer (`eventFor`).
 */
export type EventBatch = (viewer: Viewer) => unknown[];
export const NO_EVENTS: EventBatch = () => [];

/** What the room layer learns from each applied log entry (the raw state stays in the engine). */
export interface StepInfo {
  entry: LogEntry;
  decisionBoundary: boolean;
}

/** The engine surface a RoomActor uses. Raw state and events never leave through it. */
export interface LiveMatch {
  readonly version: number;
  readonly result: MatchResult | null;
  readonly isFrozen: boolean;
  readonly seq: number;
  submit(
    seat: Seat,
    action: unknown,
    options: { baseVersion: number; clientActionId?: string },
  ): Ack | Rejection;
  /** The redacted view, the batch's events as `viewer` may see them, and the engine metadata. */
  outputFor(
    viewer: Viewer,
    events: EventBatch,
  ): { view: unknown; events: unknown[]; meta: EngineMeta };
  /** Takes the events of every step applied since the last call. */
  takeEvents(): EventBatch;
  meta(): EngineMeta;
  setConnected(seat: Seat, connected: boolean): void;
  snapshot(): EngineSnapshot;
  dispose(): void;
}

export interface MatchDeps {
  clock: () => number;
  scheduler: Scheduler;
  enqueue: (task: () => void) => void;
  epoch: number;
  onStep: (step: StepInfo) => void;
  onError: (error: unknown) => void;
}

export interface GameEntry {
  id: string;
  manifest: GameManifest;
  logicVersion: number;
  stateVersion: number;
  /** Parses lobby options with the module's configSchema (defaults applied). */
  parseConfig(options: unknown): { ok: true; config: unknown } | { ok: false };
  create(setup: MatchSetup, deps: MatchDeps): LiveMatch;
  restore(
    snapshot: unknown,
    tail: readonly LogEntry[],
    deps: MatchDeps & { connectedSeats: readonly Seat[] },
  ): LiveMatch;
}

function wrap<S, A, C, V, E extends GameEvent>(
  build: (onEvents: (events: readonly E[]) => void) => MatchEngine<S, A, C, V, E>,
): LiveMatch {
  let pending: E[] = [];
  const engine = build((events) => {
    for (const event of events) pending.push(event);
  });
  return {
    get version() {
      return engine.version;
    },
    get result() {
      return engine.result;
    },
    get isFrozen() {
      return engine.isFrozen;
    },
    get seq() {
      return engine.seq;
    },
    submit: (seat, action, options) => engine.submit(seat, action, options),
    outputFor: (viewer, events) => ({
      view: engine.view(viewer),
      events: events(viewer),
      meta: engine.meta(),
    }),
    takeEvents: () => {
      const taken = pending;
      pending = [];
      return taken.length === 0 ? NO_EVENTS : (viewer) => engine.eventsFor(taken, viewer);
    },
    meta: () => engine.meta(),
    setConnected: (seat, connected) => engine.setConnected(seat, connected),
    snapshot: () => engine.snapshot(),
    dispose: () => engine.dispose(),
  };
}

function entry<S, A, C, V, E extends GameEvent>(module: CheckedModule<S, A, C, V, E>): GameEntry {
  const engineDeps = (deps: MatchDeps, onEvents: (events: readonly E[]) => void) => ({
    clock: deps.clock,
    scheduler: deps.scheduler,
    enqueue: deps.enqueue,
    epoch: deps.epoch,
    hooks: {
      onStep: (record: StepRecord<S, E>) => {
        onEvents(record.events);
        deps.onStep({ entry: record.entry, decisionBoundary: record.decisionBoundary });
      },
      onError: deps.onError,
    },
  });
  return {
    id: module.manifest.id,
    manifest: module.manifest,
    logicVersion: module.manifest.logicVersion,
    stateVersion: module.stateVersion,
    parseConfig(options) {
      const parsed = module.configSchema.safeParse(options ?? {});
      return parsed.success ? { ok: true, config: parsed.data } : { ok: false };
    },
    create: (setup, deps) =>
      wrap((onEvents) => MatchEngine.create(module, setup, engineDeps(deps, onEvents))),
    restore: (snapshot, tail, deps) =>
      wrap((onEvents) =>
        MatchEngine.restore(module, snapshot, tail, {
          ...engineDeps(deps, onEvents),
          connectedSeats: deps.connectedSeats,
        }),
      ),
  };
}

const ENTRIES: readonly GameEntry[] = [entry(ticTacToe), entry(secretPick), entry(cricket)];
const BY_ID = new Map(ENTRIES.map((game) => [game.id, game]));

export function findGame(gameId: string): GameEntry | null {
  return BY_ID.get(gameId) ?? null;
}

export function registeredGameIds(): string[] {
  return [...BY_ID.keys()];
}

/** The mode and seat count a room may use, or null when the combination isn't allowed. */
export function resolveMode(
  game: GameEntry,
  modeId: string,
  seatCount: number | undefined,
): { mode: ModeManifest; seatCount: number } | null {
  const mode = game.manifest.modes.find((m) => m.id === modeId);
  if (!mode) return null;
  const allowed = allowedSeatCounts(mode);
  const count = seatCount ?? allowed[0];
  if (count === undefined || !allowed.includes(count)) return null;
  return { mode, seatCount: count };
}
