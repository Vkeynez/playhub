// MatchEngine (ARCHITECTURE §3.3): wraps a GameModule with versions, the game clock, staleness, idempotency,
// the action log, timers, AFK counting, bots, effects, snapshots and replay. Pure TS: the wall clock,
// scheduler, effect runner and queue are injected, so the same code runs on Node, Hermes, V8 and Vitest.

import {
  allowedSeatCounts,
  deepFreeze,
  deriveStream,
  findMode,
  forkRng,
  jsonClone,
  rngFromState,
  seatViewer,
} from '../core';
import type {
  AssertNoSecrets,
  Awaiting,
  BotLevel,
  Ctx,
  Effect,
  GameEvent,
  GameModule,
  MatchResult,
  Rejection,
  Rng,
  RngState,
  Seat,
  SeatInfo,
  Step,
  Viewer,
} from '../core';
import { engineSnapshotSchema } from './types';
import type {
  Ack,
  EngineDeps,
  EngineMeta,
  EngineSnapshot,
  LogEntry,
  MatchSetup,
  SeatControl,
  StepRecord,
  SubmitOptions,
  ViewerOutput,
} from './types';

export const VERSION_EPOCH_FACTOR = 2 ** 32;
/** Largest epoch whose versions stay below 2^53. */
export const MAX_EPOCH = 2 ** 21 - 1;
/** On restore, every pending deadline gets at least this much time. */
export const RESTORE_MIN_DEADLINE_MS = 15_000;
/** Consecutive timeouts that trigger onAfk. */
export const AFK_TIMEOUT_LIMIT = 3;
/** Bot thinking delay range (game ms), drawn from the bot stream. */
export const BOT_THINK_MS = { min: 400, max: 1600 } as const;
const DEDUPE_CAPACITY = 512;
const MAX_STEPS_PER_WAKE = 1000;

/** A module whose view and event types are checked to contain no Secret<T> (§3.5 step 3). */
export type CheckedModule<S, A, C, V, E extends GameEvent> = GameModule<S, A, C, V, E> &
  AssertNoSecrets<V> &
  AssertNoSecrets<E>;

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

interface BotTask {
  seat: Seat;
  /** awaitedSince[seat] when the task was created: the decision it answers. */
  decision: number;
  occupantEpoch: number;
  /** Game time at which the bot "finishes thinking". */
  dueAt: number;
  started: boolean;
}

type Due =
  | { kind: 'timeout'; at: number; seat: Seat }
  | { kind: 'tick'; at: number }
  | { kind: 'bot'; at: number; task: BotTask };

interface EngineInit<S> {
  state: S;
  game: RngState;
  bot: RngState;
  version: number;
  awaitedSince: (number | null)[];
  afkCounters: number[];
  seatControl: SeatControl[];
  pendingEffects: Effect[];
  clockOffset: number;
  lastSeq: number;
  lastNow: number;
}

export interface ReplayOptions<S, E extends GameEvent> {
  epoch?: number;
  freezeInputs?: boolean;
  onStep?: (record: StepRecord<S, E>) => void;
}

function epochBase(epoch: number): number {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) {
    throw new EngineError(`epoch must be an integer in [0, ${MAX_EPOCH}], got ${epoch}`);
  }
  return epoch * VERSION_EPOCH_FACTOR;
}

/** The process epoch a version was produced in. */
export function epochOf(version: number): number {
  return Math.floor(version / VERSION_EPOCH_FACTOR);
}

function nextVersion(version: number): number {
  const next = version + 1;
  if (next % VERSION_EPOCH_FACTOR === 0 || !Number.isSafeInteger(next)) {
    throw new EngineError('version counter exhausted for this epoch');
  }
  return next;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function rejection(reason: Rejection['reason']): Rejection {
  return { ok: false, reason };
}

const runNow = (task: () => void): void => task();

export class MatchEngine<S, A, C, V, E extends GameEvent = GameEvent> {
  private state: S;
  private readonly gameRng: Rng;
  private readonly botRng: Rng;
  private ver: number;
  private readonly awaitedSince: (number | null)[];
  private readonly afkCounters: number[];
  private readonly seatControl: SeatControl[];
  private readonly pending: Effect[];
  private clockOffset: number;
  private lastSeq: number;
  private lastNow: number;
  /** Unclamped game time at which the clock froze; null while running. */
  private frozenAt: number | null = null;
  private awaitingNow: Awaiting;
  private finalResult: MatchResult | null;
  private live = false;
  private processing = false;
  private cancelTimer: (() => void) | null = null;
  private timerToken: object | null = null;
  private readonly dedupe = new Map<string, { seq: number; version: number }>();
  private readonly botTasks = new Map<Seat, BotTask>();

  private constructor(
    private readonly module: GameModule<S, A, C, V, E>,
    private readonly deps: EngineDeps<S, E>,
    init: EngineInit<S>,
  ) {
    this.state = this.freeze(init.state);
    this.gameRng = rngFromState(init.game);
    this.botRng = rngFromState(init.bot);
    this.ver = init.version;
    this.awaitedSince = init.awaitedSince;
    this.afkCounters = init.afkCounters;
    this.seatControl = init.seatControl;
    this.pending = init.pendingEffects;
    this.clockOffset = init.clockOffset;
    this.lastSeq = init.lastSeq;
    this.lastNow = init.lastNow;
    this.awaitingNow = module.awaiting(this.state);
    this.finalResult = module.result(this.state);
  }

  // ---------------------------------------------------------------- construction

  /** Starts a new match (live mode). */
  static create<S, A, C, V, E extends GameEvent>(
    module: CheckedModule<S, A, C, V, E>,
    setup: MatchSetup,
    deps: EngineDeps<S, E>,
  ): MatchEngine<S, A, C, V, E> {
    const initNow = setup.initNow ?? deps.clock();
    const engine = MatchEngine.initial(module, setup, deps, initNow);
    engine.clockOffset = deps.clock() - initNow;
    const connected = setup.connectedSeats;
    for (const [seat, control] of engine.seatControl.entries()) {
      if (control.kind === 'human' && connected) control.connected = connected.includes(seat);
    }
    engine.goLive();
    return engine;
  }

  /**
   * Replays a match from its setup (seed and initNow included) and log: no effects, timers or bots.
   * Used for match replays and determinism checks. The returned engine stays in replay mode.
   */
  static replay<S, A, C, V, E extends GameEvent>(
    module: GameModule<S, A, C, V, E>,
    setup: MatchSetup & { initNow: number },
    entries: readonly LogEntry[],
    options: ReplayOptions<S, E> = {},
  ): MatchEngine<S, A, C, V, E> {
    const deps: EngineDeps<S, E> = {
      clock: () => setup.initNow,
      freezeInputs: options.freezeInputs ?? false,
    };
    if (options.epoch !== undefined) deps.epoch = options.epoch;
    const engine = MatchEngine.initial(module, setup, deps, setup.initNow);
    for (const entry of entries) {
      const record = engine.apply(entry, null);
      options.onStep?.(record);
    }
    return engine;
  }

  /**
   * Resumes from a snapshot plus the log entries written after it. Replays the tail (no effects, timers or
   * bots), rebuilds the dedupe LRU, gives every pending deadline at least 15 s, logs the new epoch, then
   * re-issues pending effects that have no logged result. Human seats start disconnected unless listed.
   */
  static restore<S, A, C, V, E extends GameEvent>(
    module: CheckedModule<S, A, C, V, E>,
    snapshot: unknown,
    tail: readonly LogEntry[],
    deps: EngineDeps<S, E> & { connectedSeats?: readonly Seat[] },
  ): MatchEngine<S, A, C, V, E> {
    const snap = engineSnapshotSchema.parse(snapshot);
    const seatCount = snap.seatControl.length;
    if (snap.awaitedSince.length !== seatCount || snap.afkCounters.length !== seatCount) {
      throw new EngineError('snapshot seat arrays have different lengths');
    }
    if (snap.logicVersion !== module.manifest.logicVersion && tail.length > 0) {
      throw new EngineError(
        `cannot replay a log written by logicVersion ${snap.logicVersion} with logicVersion ${module.manifest.logicVersion}`,
      );
    }
    let state: S;
    if (snap.stateVersion === module.stateVersion) state = snap.S as S;
    else if (module.migrateState) state = module.migrateState(snap.S, snap.stateVersion);
    else
      throw new EngineError(
        `no migration from stateVersion ${snap.stateVersion} to ${module.stateVersion}`,
      );

    const connected = deps.connectedSeats ?? [];
    const seatControl = snap.seatControl.map((control, seat): SeatControl =>
      control.kind === 'human' ? { ...control, connected: connected.includes(seat) } : control,
    );
    const engine = new MatchEngine(module, deps, {
      state,
      game: snap.rng.game,
      bot: snap.rng.bot,
      version: snap.version,
      awaitedSince: snap.awaitedSince,
      afkCounters: snap.afkCounters,
      seatControl,
      pendingEffects: snap.pendingEffects,
      clockOffset: snap.clockOffset,
      lastSeq: snap.lastSeq,
      lastNow: snap.lastNow,
    });
    for (const entry of tail) engine.apply(entry, null);

    engine.live = true;
    const epoch = deps.epoch ?? epochOf(engine.ver);
    if (epoch < epochOf(engine.ver))
      throw new EngineError(`epoch ${epoch} is older than the snapshot's`);
    const wall = deps.clock();
    let target = wall - engine.clockOffset;
    const deadline = engine.awaitingNow.deadlineAt;
    if (
      deadline !== null &&
      engine.awaitingNow.seats.length > 0 &&
      deadline - target < RESTORE_MIN_DEADLINE_MS
    ) {
      target = deadline - RESTORE_MIN_DEADLINE_MS;
    }
    const offset = wall - target;
    if (!engine.finalResult && (offset !== engine.clockOffset || epoch !== epochOf(engine.ver))) {
      engine.commitClock(offset, epoch !== epochOf(engine.ver) ? epoch : undefined);
    }
    engine.goLive();
    for (const effect of [...engine.pending]) engine.runEffect(effect);
    return engine;
  }

  private static initial<S, A, C, V, E extends GameEvent>(
    module: GameModule<S, A, C, V, E>,
    setup: MatchSetup,
    deps: EngineDeps<S, E>,
    initNow: number,
  ): MatchEngine<S, A, C, V, E> {
    const mode = findMode(module.manifest, setup.mode);
    if (!allowedSeatCounts(mode).includes(setup.seats.length)) {
      throw new EngineError(`mode ${mode.id} does not allow ${setup.seats.length} seats`);
    }
    setup.seats.forEach((info, index) => {
      if (info.seat !== index)
        throw new EngineError(
          `seats must be listed in order; index ${index} has seat ${info.seat}`,
        );
    });
    const config = module.configSchema.parse(setup.config);
    const gameRng = deriveStream(setup.seed, 'game');
    const seats: SeatInfo[] = jsonClone(setup.seats);
    const freeze = deps.freezeInputs ?? false;
    const state = module.init({
      config: freeze ? deepFreeze(config) : config,
      mode: setup.mode,
      seats: freeze ? deepFreeze(seats) : seats,
      rng: gameRng,
      now: initNow,
    });
    const version = epochBase(deps.epoch ?? 0);
    const engine = new MatchEngine(module, deps, {
      state,
      game: gameRng.save(),
      bot: deriveStream(setup.seed, 'bot').save(),
      version,
      awaitedSince: setup.seats.map(() => null),
      afkCounters: setup.seats.map(() => 0),
      seatControl: setup.seats.map((info): SeatControl =>
        info.occupant.kind === 'human'
          ? { kind: 'human', connected: true, occupantEpoch: 0 }
          : { kind: 'bot', level: info.occupant.level, occupantEpoch: 0 },
      ),
      pendingEffects: [],
      clockOffset: 0,
      lastSeq: 0,
      lastNow: initNow,
    });
    for (const seat of engine.awaitingNow.seats) engine.awaitedSince[seat] = version;
    return engine;
  }

  private goLive(): void {
    this.live = true;
    this.updateFreeze();
    this.afterChange();
  }

  // ---------------------------------------------------------------- reading

  get version(): number {
    return this.ver;
  }

  /** Server-only. Never send this to a client; use outputFor(). */
  get currentState(): S {
    return this.state;
  }

  get awaiting(): Awaiting {
    return { seats: [...this.awaitingNow.seats], deadlineAt: this.awaitingNow.deadlineAt };
  }

  get result(): MatchResult | null {
    return this.finalResult;
  }

  get seq(): number {
    return this.lastSeq;
  }

  get seatCount(): number {
    return this.seatControl.length;
  }

  get isFrozen(): boolean {
    return this.frozenAt !== null;
  }

  get isLive(): boolean {
    return this.live;
  }

  get pendingEffects(): Effect[] {
    return jsonClone(this.pending);
  }

  get afk(): number[] {
    return [...this.afkCounters];
  }

  /** The version at which `seat`'s current decision began, or null when it isn't awaited. */
  awaitedSinceFor(seat: Seat): number | null {
    return this.awaitedSince[seat] ?? null;
  }

  seatControlFor(seat: Seat): SeatControl {
    const control = this.seatControl[seat];
    if (!control) throw new EngineError(`no seat ${seat}`);
    return { ...control };
  }

  /** Game time: max(lastNow, wall − clockOffset), held while frozen. */
  gameNow(): number {
    const raw = this.frozenAt ?? (this.live ? this.deps.clock() - this.clockOffset : this.lastNow);
    return Math.max(this.lastNow, raw);
  }

  toWall(gameTime: number): number {
    return gameTime + this.clockOffset;
  }

  /** Converts a client-claimed wall time (already corrected for clock offset) to game time. */
  toGame(wallTime: number): number {
    return wallTime - this.clockOffset;
  }

  view(viewer: Viewer): V {
    return this.module.viewFor(this.state, viewer);
  }

  eventsFor(events: readonly E[], viewer: Viewer): E[] {
    const out: E[] = [];
    for (const event of events) {
      const shown = this.module.eventFor(event, viewer);
      if (shown !== null) out.push(shown);
    }
    return out;
  }

  meta(): EngineMeta {
    const { seats, deadlineAt } = this.awaitingNow;
    return {
      version: this.ver,
      awaiting: {
        seats: [...seats],
        deadlineAt: deadlineAt === null ? null : this.toWall(deadlineAt),
      },
      paused: this.frozenAt !== null,
      finished: this.finalResult !== null,
    };
  }

  /** Everything `viewer` may receive after a step: the redacted view, redacted events and metadata. */
  outputFor(viewer: Viewer, events: readonly E[] = []): ViewerOutput<V, E> {
    return {
      version: this.ver,
      view: this.view(viewer),
      events: this.eventsFor(events, viewer),
      meta: this.meta(),
    };
  }

  /** Wall time of the single room timer, or null (frozen, finished, nothing due). */
  nextWakeAt(): number | null {
    if (!this.live || this.frozenAt !== null) return null;
    const due = this.nextDue();
    return due === null ? null : this.toWall(due.at);
  }

  /** JSON-safe snapshot (jsonb). */
  snapshot(): EngineSnapshot<S> {
    return jsonClone<EngineSnapshot<S>>({
      format: 1,
      stateVersion: this.module.stateVersion,
      logicVersion: this.module.manifest.logicVersion,
      S: this.state,
      rng: { game: this.gameRng.save(), bot: this.botRng.save() },
      version: this.ver,
      awaitedSince: this.awaitedSince,
      afkCounters: this.afkCounters,
      seatControl: this.seatControl,
      pendingEffects: this.pending,
      clockOffset: this.clockOffset,
      lastSeq: this.lastSeq,
      lastNow: this.lastNow,
    });
  }

  /** Game-stream state, for determinism checks. */
  gameRngState(): RngState {
    return this.gameRng.save();
  }

  // ---------------------------------------------------------------- inputs

  /**
   * A player's action. Order: dedupe by clientActionId (a retry gets the original ack), FINISHED,
   * NOT_YOUR_TURN, STALE (baseVersion older than the seat's current decision), schema, validate.
   */
  submit(seat: Seat, rawAction: unknown, options: SubmitOptions): Ack | Rejection {
    if (!this.live) throw new EngineError('submit() on an engine in replay mode');
    if (options.clientActionId !== undefined) {
      const hit = this.dedupe.get(this.dedupeKey(seat, options.clientActionId));
      if (hit) return { ok: true, version: hit.version, seq: hit.seq, duplicate: true };
    }
    if (this.finalResult) return rejection('FINISHED');
    if (!this.awaitingNow.seats.includes(seat)) return rejection('NOT_YOUR_TURN');
    const since = this.awaitedSince[seat];
    if (since !== null && since !== undefined && options.baseVersion < since)
      return rejection('STALE');
    const parsed = this.module.actionSchema.safeParse(rawAction);
    if (!parsed.success) return rejection('ILLEGAL');
    const action = this.freeze(parsed.data);
    const verdict = this.module.validate(this.state, action, seat);
    if (!verdict.ok) return rejection(verdict.reason);
    const entry: LogEntry = {
      seq: this.lastSeq + 1,
      kind: 'action',
      seat,
      payload: { action: jsonClone(action) },
      now: this.gameNow(),
    };
    if (options.clientActionId !== undefined) entry.clientActionId = options.clientActionId;
    const record = this.commit(entry, action);
    return { ok: true, version: record.version, seq: record.entry.seq, duplicate: false };
  }

  /** Processes everything due now (timeouts, ticks, bot moves) and re-arms the timer. */
  wake(): void {
    if (!this.live || this.frozenAt !== null || this.finalResult) {
      this.rearm();
      return;
    }
    this.processing = true;
    try {
      for (let i = 0; ; i++) {
        if (this.finalResult || this.frozenAt !== null || !this.live) break;
        if (i >= MAX_STEPS_PER_WAKE)
          throw new EngineError('too many steps in one wake; is wakeAt stuck in the past?');
        const now = this.gameNow();
        const due = this.nextDue();
        if (due === null || due.at > now) break;
        if (due.kind === 'timeout') {
          this.commit(
            { seq: this.lastSeq + 1, kind: 'timeout', seat: due.seat, payload: {}, now },
            null,
          );
        } else if (due.kind === 'tick') {
          this.commit({ seq: this.lastSeq + 1, kind: 'tick', payload: {}, now }, null);
        } else {
          this.runBot(due.task);
        }
      }
    } catch (error) {
      this.processing = false;
      this.fail(error);
    } finally {
      this.processing = false;
    }
    this.rearm();
  }

  /** Feeds an effect's output back (normally called by the EffectRunner path). False if not pending. */
  deliverEffect(id: string, output: unknown): boolean {
    if (!this.live || this.finalResult || !this.pending.some((effect) => effect.id === id))
      return false;
    this.commit(
      {
        seq: this.lastSeq + 1,
        kind: 'effect',
        payload: { id, output: jsonClone(output) },
        now: this.gameNow(),
      },
      null,
    );
    return true;
  }

  /** Marks a human seat (dis)connected. When no human is connected the game clock freezes. */
  setConnected(seat: Seat, connected: boolean): void {
    const control = this.seatControlFor(seat);
    if (control.kind !== 'human') throw new EngineError(`seat ${seat} is not human-controlled`);
    if (control.connected === connected) return;
    this.seatControl[seat] = { ...control, connected };
    this.updateFreeze();
    this.afterChange();
  }

  /** Hands a seat to a bot (takeover). Pending results of the previous occupant are dropped. */
  setBot(seat: Seat, level: BotLevel): void {
    const control = this.seatControlFor(seat);
    this.seatControl[seat] = { kind: 'bot', level, occupantEpoch: control.occupantEpoch + 1 };
    this.afkCounters[seat] = 0;
    this.updateFreeze();
    this.afterChange();
  }

  /** Gives a seat (back) to its human. */
  setHuman(seat: Seat, connected = true): void {
    const control = this.seatControlFor(seat);
    this.seatControl[seat] = { kind: 'human', connected, occupantEpoch: control.occupantEpoch + 1 };
    this.afkCounters[seat] = 0;
    this.updateFreeze();
    this.afterChange();
  }

  /** Stops timers; late async results are dropped. */
  dispose(): void {
    this.live = false;
    this.botTasks.clear();
    this.cancel();
  }

  // ---------------------------------------------------------------- applying entries

  /** Applies one log entry (live or replay). `action` is the pre-validated action on the live path. */
  private apply(entry: LogEntry, action: A | null): StepRecord<S, E> {
    if (entry.seq !== this.lastSeq + 1) {
      throw new EngineError(`log entry seq ${entry.seq} does not follow ${this.lastSeq}`);
    }
    if (this.finalResult && entry.kind !== 'clock')
      throw new EngineError(`entry ${entry.seq} after the match ended`);
    const ctx: Ctx = { rng: this.gameRng, now: entry.now };
    const before = this.awaitingNow;
    let step: Step<S, E> | null = null;
    let actor: Seat | null = null;
    switch (entry.kind) {
      case 'action': {
        const checked = action ?? this.replayAction(entry.seat, entry.payload.action);
        step = this.module.reduce(this.state, checked, entry.seat, ctx);
        actor = entry.seat;
        this.afkCounters[entry.seat] = 0;
        break;
      }
      case 'timeout': {
        const auto = this.freeze(this.module.onTimeout(this.state, entry.seat, this.gameRng));
        const verdict = this.module.validate(this.state, auto, entry.seat);
        if (!verdict.ok) {
          throw new EngineError(
            `onTimeout(seat ${entry.seat}) returned an action validate rejects (${verdict.reason})`,
          );
        }
        step = this.module.reduce(this.state, auto, entry.seat, ctx);
        actor = entry.seat;
        this.afkCounters[entry.seat] = (this.afkCounters[entry.seat] ?? 0) + 1;
        break;
      }
      case 'tick': {
        if (!this.module.tick) throw new EngineError('tick entry but the module has no tick()');
        step = this.module.tick(this.state, ctx);
        break;
      }
      case 'effect': {
        const index = this.pending.findIndex((effect) => effect.id === entry.payload.id);
        if (index < 0) throw new EngineError(`effect ${entry.payload.id} is not pending`);
        if (!this.module.resolve)
          throw new EngineError('effect entry but the module has no resolve()');
        step = this.module.resolve(
          this.state,
          entry.payload.id,
          this.freeze(entry.payload.output),
          ctx,
        );
        this.pending.splice(index, 1);
        break;
      }
      case 'clock': {
        if (entry.payload.epoch !== undefined)
          this.ver = Math.max(this.ver, epochBase(entry.payload.epoch));
        this.clockOffset = entry.payload.clockOffset;
        break;
      }
    }
    this.lastSeq = entry.seq;
    this.lastNow = Math.max(this.lastNow, entry.now);
    this.ver = nextVersion(this.ver);

    let after = before;
    if (step) {
      this.state = this.freeze(step.state);
      for (const effect of step.effects ?? []) {
        if (this.pending.some((p) => p.id === effect.id))
          throw new EngineError(`duplicate effect id ${effect.id}`);
        this.pending.push(jsonClone(effect));
      }
      after = this.module.awaiting(this.state);
      this.awaitingNow = after;
      this.finalResult = this.module.result(this.state);
    }

    // A decision begins when a seat becomes awaited, acts and is still awaited, or its deadline moves.
    let decisionStarted = false;
    for (let seat = 0; seat < this.seatCount; seat++) {
      if (!after.seats.includes(seat)) {
        this.awaitedSince[seat] = null;
      } else if (
        this.awaitedSince[seat] === null ||
        seat === actor ||
        after.deadlineAt !== before.deadlineAt
      ) {
        this.awaitedSince[seat] = this.ver;
        decisionStarted = true;
      }
    }
    if (entry.kind === 'action' && entry.clientActionId !== undefined) {
      this.remember(entry.seat, entry.clientActionId, entry.seq, this.ver);
    }

    return {
      entry,
      version: this.ver,
      state: this.state,
      events: this.freeze(step?.events ?? []),
      effects: step?.effects ?? [],
      awaiting: { seats: [...after.seats], deadlineAt: after.deadlineAt },
      decisionBoundary:
        decisionStarted ||
        entry.kind === 'tick' ||
        entry.kind === 'effect' ||
        this.finalResult !== null,
      result: this.finalResult,
    };
  }

  private replayAction(seat: Seat, raw: unknown): A {
    const parsed = this.module.actionSchema.safeParse(raw);
    if (!parsed.success) throw new EngineError(`logged action for seat ${seat} fails actionSchema`);
    const action = this.freeze(parsed.data);
    const verdict = this.module.validate(this.state, action, seat);
    if (!verdict.ok)
      throw new EngineError(
        `logged action for seat ${seat} is rejected on replay (${verdict.reason})`,
      );
    return action;
  }

  /** Live path: apply, notify, run effects, re-arm. */
  private commit(entry: LogEntry, action: A | null): StepRecord<S, E> {
    const record = this.apply(entry, action);
    const hooks = this.deps.hooks;
    hooks?.onStep?.(record);
    if (entry.kind === 'timeout' && this.afkCounters[entry.seat] === AFK_TIMEOUT_LIMIT) {
      hooks?.onAfk?.(entry.seat, AFK_TIMEOUT_LIMIT);
    }
    for (const effect of record.effects) this.runEffect(effect);
    this.afterChange();
    return record;
  }

  /**
   * Logs a clockOffset change. The entry's `now` is game time under the NEW offset (never below lastNow),
   * so a restore that moved game time back stalls the clock instead of skipping the extra time.
   */
  private commitClock(clockOffset: number, epoch: number | undefined): void {
    const payload: { clockOffset: number; epoch?: number } = { clockOffset };
    if (epoch !== undefined) payload.epoch = epoch;
    const now = Math.max(this.lastNow, this.deps.clock() - clockOffset);
    this.commit({ seq: this.lastSeq + 1, kind: 'clock', payload, now }, null);
  }

  private remember(seat: Seat, clientActionId: string, seq: number, version: number): void {
    const key = this.dedupeKey(seat, clientActionId);
    this.dedupe.delete(key);
    this.dedupe.set(key, { seq, version });
    if (this.dedupe.size > DEDUPE_CAPACITY) {
      const oldest = this.dedupe.keys().next();
      if (!oldest.done) this.dedupe.delete(oldest.value);
    }
  }

  private dedupeKey(seat: Seat, clientActionId: string): string {
    return `${seat}:${clientActionId}`;
  }

  // ---------------------------------------------------------------- clock, timer, bots, effects

  private updateFreeze(): void {
    if (!this.live) return;
    const humanConnected = this.seatControl.some(
      (control) => control.kind === 'human' && control.connected,
    );
    if (!humanConnected && this.frozenAt === null) {
      this.frozenAt = this.deps.clock() - this.clockOffset;
    } else if (humanConnected && this.frozenAt !== null) {
      const offset = this.deps.clock() - this.frozenAt;
      this.frozenAt = null;
      if (offset !== this.clockOffset && !this.finalResult) this.commitClock(offset, undefined);
    }
  }

  private afterChange(): void {
    this.syncBots();
    this.rearm();
  }

  private nextDue(): Due | null {
    if (this.finalResult) return null;
    let best: Due | null = null;
    const { seats, deadlineAt } = this.awaitingNow;
    const first = seats[0];
    if (deadlineAt !== null && first !== undefined)
      best = { kind: 'timeout', at: deadlineAt, seat: first };
    const wakeAt = this.module.wakeAt?.(this.state) ?? null;
    if (wakeAt !== null && (best === null || wakeAt < best.at)) best = { kind: 'tick', at: wakeAt };
    for (const task of this.botTasks.values()) {
      if (!task.started && (best === null || task.dueAt < best.at))
        best = { kind: 'bot', at: task.dueAt, task };
    }
    return best;
  }

  private rearm(): void {
    if (this.processing) return;
    this.cancel();
    const scheduler = this.deps.scheduler;
    const at = this.nextWakeAt();
    if (at === null || !scheduler) return;
    const token = {};
    this.timerToken = token;
    this.cancelTimer = scheduler.schedule(at, () => {
      if (this.timerToken !== token) return;
      this.timerToken = null;
      this.cancelTimer = null;
      this.enqueue(() => this.wake());
    });
  }

  private cancel(): void {
    this.timerToken = null;
    const cancel = this.cancelTimer;
    this.cancelTimer = null;
    cancel?.();
  }

  /** Keeps one bot task per awaited bot seat, keyed by its decision and occupant. */
  private syncBots(): void {
    if (!this.live || this.finalResult) {
      this.botTasks.clear();
      return;
    }
    for (let seat = 0; seat < this.seatCount; seat++) {
      const control = this.seatControl[seat];
      const since = this.awaitedSince[seat] ?? null;
      const task = this.botTasks.get(seat);
      if (!control || control.kind !== 'bot' || since === null) {
        this.botTasks.delete(seat);
        continue;
      }
      if (task && task.decision === since && task.occupantEpoch === control.occupantEpoch) continue;
      this.botTasks.set(seat, {
        seat,
        decision: since,
        occupantEpoch: control.occupantEpoch,
        dueAt: this.gameNow() + this.botRng.int(BOT_THINK_MS.min, BOT_THINK_MS.max),
        started: false,
      });
    }
  }

  private runBot(task: BotTask): void {
    const control = this.seatControl[task.seat];
    if (!control || control.kind !== 'bot') {
      this.botTasks.delete(task.seat);
      return;
    }
    task.started = true;
    const choice = this.module.bot.choose(
      this.view(seatViewer(task.seat)),
      task.seat,
      control.level,
      forkRng(this.botRng),
    );
    if (isPromiseLike(choice)) {
      void choice.then(
        (action) => this.enqueue(() => this.applyBotChoice(task, action)),
        (error: unknown) => this.enqueue(() => this.fail(error)),
      );
    } else {
      this.applyBotChoice(task, choice);
    }
  }

  /** Bot results are tagged (decision version, seat, occupantEpoch) and dropped when stale. */
  private applyBotChoice(task: BotTask, action: A): void {
    if (!this.live || this.finalResult || this.botTasks.get(task.seat) !== task) return;
    const control = this.seatControl[task.seat];
    if (
      !control ||
      control.kind !== 'bot' ||
      control.occupantEpoch !== task.occupantEpoch ||
      this.awaitedSince[task.seat] !== task.decision
    ) {
      return;
    }
    if (this.frozenAt !== null) {
      task.started = false; // think again once the clock runs
      return;
    }
    this.botTasks.delete(task.seat);
    const outcome = this.submit(task.seat, action, { baseVersion: this.ver });
    if (!outcome.ok) {
      this.fail(
        new EngineError(`bot for seat ${task.seat} chose a rejected action (${outcome.reason})`),
      );
    }
  }

  private runEffect(effect: Effect): void {
    const runner = this.deps.effects;
    if (!runner || !this.live) return;
    let promise: Promise<unknown>;
    try {
      promise = runner.run(effect);
    } catch (error) {
      this.fail(error);
      return;
    }
    void promise.then(
      (output) => this.enqueue(() => void this.deliverEffect(effect.id, output)),
      (error: unknown) => this.enqueue(() => this.fail(error)),
    );
  }

  private enqueue(task: () => void): void {
    (this.deps.enqueue ?? runNow)(task);
  }

  private fail(error: unknown): void {
    const onError = this.deps.hooks?.onError;
    if (onError) onError(error);
    else throw error;
  }

  private freeze<T>(value: T): T {
    return this.deps.freezeInputs ? deepFreeze(value) : value;
  }
}
