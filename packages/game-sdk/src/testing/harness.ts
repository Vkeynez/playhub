// The GameModule contract harness (ARCHITECTURE §3.6). Each check returns a list of failures (empty = pass)
// so a game's test can assert on it, and so a test can prove the harness catches a broken module.
// contractSuite() (suite.ts) wraps these checks in Vitest tests.

import * as fc from 'fast-check';

import {
  allowedSeatCounts,
  BOT_LEVELS,
  canSee,
  deepFreeze,
  deriveStream,
  findMode,
  findSecrets,
  forkRng,
  hashJson,
  hashString,
  jsonClone,
  jsonSafetyIssues,
  liveViewers,
  mapSecrets,
  matchResultIssues,
  project,
  REPLAY_VIEWER,
  rngFromState,
  secret,
  seatViewer,
  seedFromInt,
  stableStringify,
  viewerLabel,
} from '../core';
import type {
  Effect,
  GameEvent,
  GameModule,
  ModeManifest,
  Rng,
  RngState,
  Seat,
  SeatInfo,
  Secret,
  SecretPath,
  Validation,
  Viewer,
} from '../core';
import { MatchEngine } from '../engine';
import type { CheckedModule, EngineDeps, EngineHooks, LogEntry, MatchSetup } from '../engine';
import { FakeTime, flushMicrotasks } from './fake-time';

/** Changes one secret that `viewer` can't see; null when there is none to change. */
export interface RedactionAdapter<S> {
  perturb(state: S, viewer: Viewer, rng: Rng): S | null;
}

export interface ContractOptions<S, A, C, V, E extends GameEvent> {
  module: CheckedModule<S, A, C, V, E>;
  /** A finished match must take at most this many actions + timeouts. */
  maxActions: number;
  /** Room config for one match. Default: {} (parsed by configSchema). */
  config?: (mode: ModeManifest, rng: Rng) => C;
  /** Required when S holds Secret<T>: the module-supplied secret perturbation (see perturbOneSecret). */
  redaction?: RedactionAdapter<S>;
  /** Runs effects during simulation (Carrom physics). */
  runEffect?: (effect: Effect) => unknown;
  /** Simulated matches per mode. Default: env CONTRACT_SIM_MATCHES, else 100. */
  matches?: number;
  /** Matches per mode with a snapshot/restore no-op check at every step. Default 10. */
  determinismMatches?: number;
  /** fast-check runs (each one a seeded random walk). Default 50. */
  propertyRuns?: number;
  /** Random walks for the non-interference check. Default 40. */
  redactionWalks?: number;
  /** Steps both branches continue after a non-revealing step (k). Default 3. */
  traceSteps?: number;
  /** p99 budgets in ms, scaled by a calibration loop; false skips the check. */
  budget?: { botChooseP99Ms: number; reduceP99Ms: number } | false;
}

type Module<S, A, C, V, E extends GameEvent> = GameModule<S, A, C, V, E>;

const START_WALL = 1_760_000_000_000;
const MAX_FAILURES = 12;
const SECRET_MARKER = '"__secret"';

// ------------------------------------------------------------------ small helpers

function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}

/** Default simulation count: CONTRACT_SIM_MATCHES, else 100 (CI sets 1000). */
export function defaultSimMatches(): number {
  const raw = Number(env('CONTRACT_SIM_MATCHES'));
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
}

/** Error text including its cause chain (fast-check reports the property's own error as `cause`). */
function errorText(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const text = `${error.name}: ${error.message}`;
  return error.cause !== undefined && depth < 3
    ? `${text}\ncaused by ${errorText(error.cause, depth + 1)}`
    : text;
}

function seedFor(...parts: (string | number)[]): number {
  return parseInt(hashString(parts.join('/')).slice(0, 8), 16);
}

function push(failures: string[], message: string): void {
  if (failures.length < MAX_FAILURES) failures.push(message);
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function makeSetup<C>(
  config: ((mode: ModeManifest, rng: Rng) => C) | undefined,
  mode: ModeManifest,
  seedInt: number,
  rng: Rng,
  allHuman: boolean,
  initNow: number,
): MatchSetup & { initNow: number } {
  const count = rng.pick(allowedSeatCounts(mode));
  const seats: SeatInfo[] = [];
  for (let seat = 0; seat < count; seat++) {
    const bot = !allHuman && seat > 0 && mode.supportsBots && rng.float() < 0.5;
    seats.push({
      seat,
      team: mode.teams === 'pairs' ? seat % 2 : null,
      occupant: bot
        ? { kind: 'bot', level: rng.pick(BOT_LEVELS) }
        : { kind: 'human', userId: `user-${seat}` },
    });
  }
  return {
    config: config ? config(mode, rng) : {},
    mode: mode.id,
    seats,
    seed: seedFromInt(seedInt),
    initNow,
  };
}

/** A random legal action: legalActions, else sampleAction, else onTimeout. */
export function chooseAction<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  state: S,
  seat: Seat,
  rng: Rng,
): A {
  const legal = module.legalActions?.(state, seat);
  if (legal && legal.length > 0) return rng.pick(legal);
  if (module.sampleAction) return module.sampleAction(state, seat, rng);
  return module.onTimeout(state, seat, rng);
}

/** Up to `max` distinct candidate actions for `seat`. */
function candidateActions<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  state: S,
  seat: Seat,
  rng: Rng,
  max: number,
): A[] {
  const legal = module.legalActions?.(state, seat);
  if (legal) return rng.shuffle(legal).slice(0, max);
  const out = new Map<string, A>();
  for (let i = 0; i < max * 2 && out.size < max; i++) {
    const action = module.sampleAction
      ? module.sampleAction(state, seat, rng)
      : module.onTimeout(state, seat, rng);
    out.set(stableStringify(action), action);
  }
  return [...out.values()];
}

/** View + events for every viewer, hashed; used to compare live runs with replays. */
function outputsHash<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  state: S,
  events: readonly E[],
  viewers: readonly Viewer[],
): string {
  const parts = viewers.map((viewer) =>
    stableStringify({
      view: module.viewFor(state, viewer),
      events: events
        .map((event) => module.eventFor(event, viewer))
        .filter((event) => event !== null),
    }),
  );
  return hashString(parts.join('|'));
}

/** Per-state checks shared by every phase: invariants, JSON safety, secret markers in outputs. */
function stateIssues<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  state: S,
  events: readonly E[],
  viewers: readonly Viewer[],
): string[] {
  const issues: string[] = [];
  for (const issue of module.invariants?.(state) ?? []) issues.push(`invariant: ${issue}`);
  for (const issue of jsonSafetyIssues(state, '$state').slice(0, 3))
    issues.push(`state is not JSON-safe: ${issue}`);
  for (const viewer of viewers) {
    const view = module.viewFor(state, viewer);
    const shown = events.map((event) => module.eventFor(event, viewer));
    const text = JSON.stringify({ view, shown });
    if (text.includes(SECRET_MARKER))
      issues.push(`__secret marker in output for ${viewerLabel(viewer)}`);
    for (const issue of jsonSafetyIssues(view, '$view').slice(0, 2)) {
      issues.push(`view for ${viewerLabel(viewer)} is not JSON-safe: ${issue}`);
    }
  }
  return issues;
}

/**
 * The default redaction adapter: picks one secret hidden from the viewer and replaces its value with
 * `generate(secret, path, rng)` (return undefined to leave that secret alone).
 */
export function perturbOneSecret<S>(
  generate: (s: Secret<unknown>, path: SecretPath, rng: Rng) => unknown,
): RedactionAdapter<S> {
  return {
    perturb(state, viewer, rng) {
      const hidden = findSecrets(state).filter(({ secret: s }) => !canSee(s, viewer));
      if (hidden.length === 0) return null;
      const target = rng.pick(hidden);
      const key = stableStringify(target.path);
      const value = generate(target.secret, target.path, rng);
      if (value === undefined || stableStringify(value) === stableStringify(target.secret.value))
        return null;
      return mapSecrets(state, (s, path) =>
        stableStringify(path) === key ? secret(s.owner, value) : s,
      );
    },
  };
}

// ------------------------------------------------------------------ random walks (properties, redaction)

interface WalkPoint<S, A, C, V, E extends GameEvent> {
  engine: MatchEngine<S, A, C, V, E>;
  rng: Rng;
}

/**
 * Plays one seeded match with every seat human-connected and driven by random legal actions, letting
 * deadlines lapse now and then. `visit` sees every reachable state (the engine deep-freezes inputs).
 */
function walk<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
  seedInt: number,
  visit: (point: WalkPoint<S, A, C, V, E>) => void,
): void {
  const { module } = options;
  const rng = deriveStream(seedFromInt(seedInt), 'cosmetic');
  const mode = rng.pick(module.manifest.modes);
  const time = new FakeTime(START_WALL);
  const setup = makeSetup(options.config, mode, seedInt, rng, true, time.now);
  const engine = MatchEngine.create(options.module, setup, {
    clock: time.clock,
    scheduler: time,
    freezeInputs: true,
  });
  try {
    for (let i = 0; i <= options.maxActions * 4 && !engine.result; i++) {
      visit({ engine, rng });
      if (engine.result) break;
      const { seats, deadlineAt } = engine.awaiting;
      if (seats.length > 0 && (deadlineAt === null || rng.float() < 0.85)) {
        const seat = rng.pick(seats);
        const action = chooseAction(module, engine.currentState, seat, rng);
        const ack = engine.submit(seat, action, { baseVersion: engine.version });
        if (!ack.ok)
          throw new Error(`a legal/sampled action for seat ${seat} was rejected (${ack.reason})`);
      } else if (!time.next()) {
        break;
      }
    }
    visit({ engine, rng });
  } finally {
    engine.dispose();
  }
}

// ------------------------------------------------------------------ 1. simulation (+ determinism)

interface SimulationOptions {
  /** Snapshot → JSON → restore at every step and require a no-op. */
  everyStepRoundTrip: boolean;
}

async function simulateMatch<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
  mode: ModeManifest,
  index: number,
  sim: SimulationOptions,
): Promise<string[]> {
  const { module } = options;
  const seedInt = seedFor(
    module.manifest.id,
    mode.id,
    index,
    sim.everyStepRoundTrip ? 'deep' : 'sim',
  );
  const label = `${mode.id} match ${index} (seed ${seedInt})`;
  const failures: string[] = [];
  const fail = (message: string): void => push(failures, `${label}: ${message}`);

  const rng = deriveStream(seedFromInt(seedInt), 'cosmetic');
  const time = new FakeTime(START_WALL);
  const setup = makeSetup(options.config, mode, seedInt, rng, false, time.now);
  const seatCount = setup.seats.length;
  const humans = setup.seats.filter((s) => s.occupant.kind === 'human').map((s) => s.seat);
  const viewers = [...liveViewers(seatCount), REPLAY_VIEWER];

  const log: LogEntry[] = [];
  const stepHashes: string[] = [];
  const errors: unknown[] = [];
  let moves = 0;
  const hooks: EngineHooks<S, E> = {
    onStep(record) {
      log.push(jsonClone(record.entry));
      if (record.entry.kind === 'action' || record.entry.kind === 'timeout') moves++;
      stepHashes.push(outputsHash(module, record.state, record.events, viewers));
      for (const issue of stateIssues(module, record.state, record.events, viewers))
        fail(`seq ${record.entry.seq}: ${issue}`);
      if (record.result) {
        for (const issue of matchResultIssues(record.result, seatCount))
          fail(`invalid result: ${issue}`);
      }
    },
    onError(error) {
      errors.push(error);
    },
  };
  const deps: EngineDeps<S, E> = { clock: time.clock, scheduler: time, freezeInputs: true, hooks };
  const runEffect = options.runEffect;
  if (runEffect) deps.effects = { run: async (effect) => runEffect(effect) };

  let engine: MatchEngine<S, A, C, V, E>;
  try {
    engine = MatchEngine.create(options.module, setup, deps);
  } catch (error) {
    return [`${label}: create/init threw ${errorText(error)}`];
  }
  const initialHash = outputsHash(module, engine.currentState, [], viewers);
  for (const issue of stateIssues(module, engine.currentState, [], viewers)) fail(`init: ${issue}`);
  let mid: { snapshot: unknown; seq: number } | null = null;
  let sent = new Map<string, number>();
  let actionId = 0;

  try {
    for (let guard = 0; !engine.result && failures.length === 0 && errors.length === 0; guard++) {
      if (moves > options.maxActions) {
        fail(`no result after ${options.maxActions} actions + timeouts`);
        break;
      }
      if (guard > options.maxActions * 50 + 1000) {
        fail('stalled: the loop guard tripped');
        break;
      }

      // Injected disconnect: every human leaves, the clock must freeze, nothing may happen.
      if (rng.float() < 0.02) {
        for (const seat of humans)
          if (engine.seatControlFor(seat).kind === 'human') engine.setConnected(seat, false);
        if (!engine.isFrozen || engine.nextWakeAt() !== null)
          fail('clock did not freeze with no human connected');
        const seq = engine.seq;
        time.advance(30_000);
        await flushMicrotasks();
        if (engine.seq !== seq) fail('entries were applied while the clock was frozen');
        for (const seat of humans)
          if (engine.seatControlFor(seat).kind === 'human') engine.setConnected(seat, true);
      }

      // Injected snapshot → jsonb → restore round trip.
      if (rng.float() < 0.03) {
        const before = hashJson(engine.currentState);
        const snapshot = jsonClone(engine.snapshot());
        for (const issue of jsonSafetyIssues(snapshot, '$snapshot').slice(0, 3))
          fail(`snapshot: ${issue}`);
        engine.dispose();
        engine = MatchEngine.restore(options.module, snapshot, [], {
          ...deps,
          connectedSeats: humans,
        });
        sent = new Map();
        if (hashJson(engine.currentState) !== before) fail('snapshot round trip changed the state');
      }
      if (mid === null && rng.float() < 0.1)
        mid = { snapshot: jsonClone(engine.snapshot()), seq: engine.seq };

      // Scripted humans (they play with bot.choose on their own view) — or let the deadline lapse.
      let acted = false;
      const { seats, deadlineAt } = engine.awaiting;
      for (const seat of seats) {
        if (engine.seatControlFor(seat).kind !== 'human') continue;
        if (deadlineAt !== null && rng.float() < 0.15) continue;
        const base = engine.version;
        const level = rng.pick(BOT_LEVELS);
        const pick = module.bot.choose(engine.view(seatViewer(seat)), seat, level, forkRng(rng));
        const action = isPromise(pick) ? await pick : pick;
        if (engine.version !== base) break; // something else happened meanwhile; look again
        const clientActionId = `c${actionId++}`;
        const ack = engine.submit(seat, action, { baseVersion: base, clientActionId });
        if (!ack.ok) {
          fail(`bot.choose(${level}) for seat ${seat} returned a rejected action (${ack.reason})`);
          break;
        }
        sent.set(clientActionId, ack.version);
        if (rng.float() < 0.1) {
          const retry = engine.submit(seat, action, { baseVersion: base, clientActionId });
          if (!retry.ok || !retry.duplicate || retry.version !== ack.version)
            fail('a retried clientActionId was not deduped');
        }
        acted = true;
        break;
      }
      if (!acted) {
        if (!time.next()) {
          await flushMicrotasks();
          if (
            time.pending === 0 &&
            engine.awaiting.seats.every((s) => engine.seatControlFor(s).kind !== 'human')
          ) {
            fail('stalled: nobody to act and no timer armed');
            break;
          }
        }
      }
      await flushMicrotasks();
      if (sim.everyStepRoundTrip) roundTripNoOp(options, engine, humans, viewers, time, fail);
    }
  } catch (error) {
    fail(`threw ${errorText(error)}`);
  }
  for (const error of errors.slice(0, 3)) fail(`engine error: ${errorText(error)}`);
  engine.dispose();
  if (failures.length > 0) return failures;
  if (!engine.result) return [`${label}: finished without a result`];

  // Determinism: replay the log from the seed → identical state, game stream and per-step outputs.
  try {
    const replayHashes: string[] = [];
    const replayed = MatchEngine.replay(module, setup, log, {
      onStep: (record) =>
        replayHashes.push(outputsHash(module, record.state, record.events, viewers)),
    });
    if (hashJson(replayed.currentState) !== hashJson(engine.currentState))
      fail('replay: final state differs');
    if (stableStringify(replayed.gameRngState()) !== stableStringify(engine.gameRngState())) {
      fail('replay: game RNG state differs (did a bot or view draw from the game stream?)');
    }
    if (
      outputsHash(module, MatchEngine.replay(module, setup, []).currentState, [], viewers) !==
      initialHash
    ) {
      fail('replay: initial outputs differ');
    }
    const firstDiff = stepHashes.findIndex((hash, i) => replayHashes[i] !== hash);
    if (firstDiff >= 0 || replayHashes.length !== stepHashes.length) {
      fail(`replay: per-step views/events differ (first at step ${firstDiff})`);
    }
    const midPoint = mid;
    if (midPoint) {
      const tail = log.filter((entry) => entry.seq > midPoint.seq);
      const restored = MatchEngine.restore(options.module, midPoint.snapshot, tail, {
        clock: time.clock,
      });
      if (hashJson(restored.currentState) !== hashJson(engine.currentState)) {
        fail(`restore(snapshot at seq ${midPoint.seq}) + tail replay: final state differs`);
      }
      restored.dispose();
    }
  } catch (error) {
    fail(`replay threw ${errorText(error)}`);
  }
  return failures;
}

function roundTripNoOp<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
  engine: MatchEngine<S, A, C, V, E>,
  humans: Seat[],
  viewers: Viewer[],
  time: FakeTime,
  fail: (message: string) => void,
): void {
  const snapshot = engine.snapshot();
  const encoded = jsonClone(snapshot);
  if (stableStringify(encoded) !== stableStringify(snapshot))
    fail('snapshot changes in a jsonb round trip');
  const restored = MatchEngine.restore(options.module, encoded, [], {
    clock: time.clock,
    connectedSeats: humans,
  });
  const same =
    hashJson(restored.currentState) === hashJson(engine.currentState) &&
    stableStringify(restored.gameRngState()) === stableStringify(engine.gameRngState()) &&
    stableStringify(restored.awaiting) === stableStringify(engine.awaiting) &&
    outputsHash(options.module, restored.currentState, [], viewers) ===
      outputsHash(options.module, engine.currentState, [], viewers);
  if (!same) fail(`snapshot/restore at seq ${engine.seq} is not a no-op`);
  restored.dispose();
}

/** 1,000 (CI) / 100 (local) seeded bot-vs-bot matches of one mode. */
export async function checkSimulation<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
  modeId: string,
  matches = options.matches ?? defaultSimMatches(),
): Promise<string[]> {
  const mode = findMode(options.module.manifest, modeId);
  const failures: string[] = [];
  for (let i = 0; i < matches && failures.length < MAX_FAILURES; i++) {
    for (const failure of await simulateMatch(options, mode, i, { everyStepRoundTrip: false }))
      push(failures, failure);
  }
  return failures;
}

/** Replay equality plus a snapshot/restore no-op check after every step. */
export async function checkDeterminism<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
  matches = options.determinismMatches ?? 10,
): Promise<string[]> {
  const failures: string[] = [];
  for (const mode of options.module.manifest.modes) {
    for (let i = 0; i < matches && failures.length < MAX_FAILURES; i++) {
      for (const failure of await simulateMatch(options, mode, i, { everyStepRoundTrip: true })) {
        push(failures, failure);
      }
    }
  }
  return failures;
}

// ------------------------------------------------------------------ 2. properties

export function checkProperties<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
): string[] {
  const { module } = options;
  const universe = new Map<string, A>();
  try {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fffffff }), (seedInt) => {
        const found: string[] = [];
        walk(options, seedInt, ({ engine, rng }) => {
          const where = `seed ${seedInt} seq ${engine.seq}`;
          const state = engine.currentState;
          const viewers = liveViewers(engine.seatCount);
          for (const issue of stateIssues(module, state, [], viewers))
            found.push(`${where}: ${issue}`);
          if (engine.result) {
            const probe = universe.values().next();
            if (!probe.done) {
              const outcome = engine.submit(0, probe.value, { baseVersion: engine.version });
              if (outcome.ok || outcome.reason !== 'FINISHED')
                found.push(`${where}: action after the end not FINISHED`);
            }
            return;
          }
          const awaited = module.awaiting(state).seats;
          for (let seat = 0; seat < engine.seatCount; seat++) {
            const legal = module.legalActions?.(state, seat);
            const sample = [...universe.values()].slice(0, 40);
            if (!awaited.includes(seat)) {
              if (legal && legal.length > 0)
                found.push(`${where}: legalActions non-empty for non-awaited seat ${seat}`);
              for (const action of sample) {
                if (module.validate(state, action, seat).ok) {
                  found.push(`${where}: validate accepts an action from non-awaited seat ${seat}`);
                }
                const outcome = engine.submit(seat, action, { baseVersion: engine.version });
                if (outcome.ok || outcome.reason !== 'NOT_YOUR_TURN') {
                  found.push(`${where}: engine did not answer NOT_YOUR_TURN for seat ${seat}`);
                }
              }
              continue;
            }
            const chosen = chooseAction(module, state, seat, rng);
            if (universe.size < 300) universe.set(stableStringify(chosen), chosen);
            if (legal) {
              const keys = new Set<string>();
              for (const action of legal) {
                const key = stableStringify(action);
                keys.add(key);
                if (universe.size < 300) universe.set(key, action);
                if (!module.actionSchema.safeParse(action).success)
                  found.push(`${where}: legal action fails actionSchema`);
              }
              for (const [key, action] of universe) {
                if (module.validate(state, action, seat).ok !== keys.has(key)) {
                  found.push(
                    `${where}: validate ⇔ legalActions mismatch for seat ${seat} on ${key}`,
                  );
                }
              }
            } else if (!module.validate(state, chosen, seat).ok) {
              found.push(`${where}: sampleAction/onTimeout produced an action validate rejects`);
            }
            const since = engine.awaitedSinceFor(seat);
            if (since !== null && since > 0) {
              const outcome = engine.submit(seat, chosen, { baseVersion: since - 1 });
              if (outcome.ok || outcome.reason !== 'STALE')
                found.push(`${where}: stale baseVersion was not STALE`);
            }
          }
        });
        if (found.length > 0) throw new Error(found.slice(0, 5).join('\n'));
      }),
      { numRuns: options.propertyRuns ?? 50 },
    );
  } catch (error) {
    return [errorText(error)];
  }
  return [];
}

// ------------------------------------------------------------------ 3. redaction (non-interference over traces)

type Input<A> =
  { kind: 'action'; seat: Seat; action: A } | { kind: 'timeout'; seat: Seat } | { kind: 'tick' };

interface Outcome<S, E> {
  verdict: Validation;
  next: S | null;
  events: E[];
  now: number;
}

function stepOnce<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  state: S,
  input: Input<A>,
  rngState: RngState,
  now: number,
): Outcome<S, E> {
  const rng = rngFromState(rngState);
  if (input.kind === 'tick') {
    const at = Math.max(now, module.wakeAt?.(state) ?? now);
    if (!module.tick) return { verdict: { ok: true }, next: null, events: [], now: at };
    const step = module.tick(state, { rng, now: at });
    return {
      verdict: { ok: true },
      next: deepFreeze(step.state),
      events: deepFreeze(step.events),
      now: at,
    };
  }
  let at = now;
  let action: A;
  if (input.kind === 'action') {
    action = input.action;
  } else {
    at = Math.max(now, module.awaiting(state).deadlineAt ?? now);
    action = deepFreeze(module.onTimeout(state, input.seat, rng));
  }
  const verdict = module.validate(state, action, input.seat);
  if (!verdict.ok) return { verdict, next: null, events: [], now: at };
  const step = module.reduce(state, action, input.seat, { rng, now: at });
  return { verdict, next: deepFreeze(step.state), events: deepFreeze(step.events), now: at };
}

function inputsAt<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  state: S,
  rng: Rng,
): Input<A>[] {
  if (module.result(state)) return [];
  const inputs: Input<A>[] = [];
  const { seats, deadlineAt } = module.awaiting(state);
  for (const seat of seats) {
    for (const action of candidateActions(module, state, seat, rng, 3))
      inputs.push({ kind: 'action', seat, action });
    if (deadlineAt !== null) inputs.push({ kind: 'timeout', seat });
  }
  if (module.tick && (module.wakeAt?.(state) ?? null) !== null) inputs.push({ kind: 'tick' });
  return inputs;
}

/** What `viewer` can observe of an outcome, part by part. */
function observe<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  viewer: Viewer,
  outcome: Outcome<S, E>,
  includeVerdict: boolean,
): Record<string, string> {
  const parts: Record<string, string> = {
    verdict: includeVerdict ? stableStringify(outcome.verdict) : '',
  };
  const next = outcome.next;
  if (next === null) return parts;
  parts.view = stableStringify(module.viewFor(next, viewer));
  parts.events = stableStringify(outcome.events.map((event) => module.eventFor(event, viewer)));
  parts.awaiting = stableStringify(module.awaiting(next));
  parts.wakeAt = stableStringify(module.wakeAt?.(next) ?? null);
  parts.result = stableStringify(module.result(next));
  return parts;
}

function differingParts(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]);
}

function publicState<S>(state: S, viewer: Viewer): string {
  return stableStringify(project(state, viewer));
}

/** Secrets hidden from `viewer`: path → serialized value. */
function hiddenSecrets(state: unknown, viewer: Viewer): Map<string, string> {
  const hidden = new Map<string, string>();
  for (const { path, secret: s } of findSecrets(state)) {
    if (!canSee(s, viewer)) hidden.set(stableStringify(path), stableStringify(s.value));
  }
  return hidden;
}

/**
 * True if the step from (prevA, prevB) to (nextA, nextB) revealed the perturbed secret to `viewer`:
 * the public projections diverge, or a hidden secret that differed between the branches is no longer hidden
 * (e.g. a reveal that publishes picks in an event and clears them from the state).
 */
function revealed<S>(prevA: S, prevB: S, nextA: S, nextB: S, viewer: Viewer): boolean {
  if (publicState(nextA, viewer) !== publicState(nextB, viewer)) return true;
  const beforeA = hiddenSecrets(prevA, viewer);
  const beforeB = hiddenSecrets(prevB, viewer);
  const afterA = hiddenSecrets(nextA, viewer);
  const afterB = hiddenSecrets(nextB, viewer);
  for (const path of new Set([...beforeA.keys(), ...beforeB.keys()])) {
    if (beforeA.get(path) !== beforeB.get(path) && (!afterA.has(path) || !afterB.has(path)))
      return true;
  }
  return false;
}

/**
 * Runs the same input on two states that differ only in secrets `viewer` can't see, then `k` more steps.
 * Unless the step reveals the secret (the projected states diverge), `viewer` must observe identical bytes.
 */
function followPair<S, A, C, V, E extends GameEvent>(
  module: Module<S, A, C, V, E>,
  viewer: Viewer,
  a: S,
  b: S,
  input: Input<A>,
  now: number,
  rng: Rng,
  depth: number,
  fail: (message: string) => void,
): void {
  const rngState = forkRng(rng).save();
  const oa = stepOnce(module, a, input, rngState, now);
  const ob = stepOnce(module, b, input, rngState, now);
  const actor = input.kind === 'tick' ? null : input.seat;
  const own = viewer.kind === 'seat' && viewer.seat === actor;
  if (!own && oa.verdict.ok !== ob.verdict.ok) return; // validity rests on the actor's own hidden info
  if (oa.next === null || ob.next === null) {
    if (own && stableStringify(oa.verdict) !== stableStringify(ob.verdict)) {
      fail(`validate outcome for ${viewerLabel(viewer)} depends on a secret it can't see`);
    }
    return;
  }
  if (revealed(a, b, oa.next, ob.next, viewer)) return; // the exception: this step revealed the secret
  const diff = differingParts(observe(module, viewer, oa, own), observe(module, viewer, ob, own));
  if (diff.length > 0) {
    fail(
      `LEAK: ${viewerLabel(viewer)} observes [${diff.join(', ')}] differently after ${input.kind}` +
        `${actor === null ? '' : ` by seat ${actor}`} although the secret is still hidden (depth ${depth})`,
    );
    return;
  }
  if (depth > 0) {
    const options = inputsAt(module, oa.next, rng);
    if (options.length === 0) return;
    followPair(module, viewer, oa.next, ob.next, rng.pick(options), oa.now, rng, depth - 1, fail);
  }
}

function redactionAt<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
  point: WalkPoint<S, A, C, V, E>,
  fail: (message: string) => void,
): void {
  const { module } = options;
  const { engine, rng } = point;
  const state = engine.currentState;
  const viewers = liveViewers(engine.seatCount);
  for (const viewer of [...viewers, REPLAY_VIEWER]) {
    if (JSON.stringify(module.viewFor(state, viewer)).includes(SECRET_MARKER)) {
      fail(`__secret marker in viewFor(${viewerLabel(viewer)})`);
    }
  }
  if (module.result(state)) return;
  const hasSecrets = findSecrets(state).length > 0;
  if (hasSecrets && !options.redaction) {
    fail('state holds Secret<T> values but no redaction adapter was supplied');
    return;
  }
  const now = engine.gameNow();
  const k = options.traceSteps ?? 3;
  for (const viewer of viewers) {
    // (a) Perturb a secret the viewer can't see; run the same inputs on both states.
    const perturbed =
      hasSecrets && options.redaction ? options.redaction.perturb(state, viewer, rng) : null;
    if (perturbed !== null) {
      const other = deepFreeze(perturbed);
      if (publicState(state, viewer) !== publicState(other, viewer)) {
        fail(`redaction adapter changed something ${viewerLabel(viewer)} can see`);
      } else {
        const before = differingParts(
          observe(module, viewer, { verdict: { ok: true }, next: state, events: [], now }, false),
          observe(module, viewer, { verdict: { ok: true }, next: other, events: [], now }, false),
        );
        if (before.length > 0)
          fail(`LEAK: ${viewerLabel(viewer)} observes [${before.join(', ')}] of a hidden secret`);
        for (const input of rng.shuffle(inputsAt(module, state, rng)).slice(0, 4)) {
          followPair(module, viewer, state, other, input, now, rng, k, fail);
        }
      }
    }
    // (b) Two different inputs by another seat that leave the same public state must look the same.
    for (const actor of module.awaiting(state).seats) {
      if (viewer.kind === 'seat' && viewer.seat === actor) continue;
      const candidates = candidateActions(module, state, actor, rng, 4);
      const rngState = forkRng(rng).save();
      const outcomes = candidates
        .map((action) =>
          stepOnce(module, state, { kind: 'action', seat: actor, action }, rngState, now),
        )
        .filter((o) => o.next !== null);
      const first = outcomes[0];
      if (!first || first.next === null) continue;
      for (const o of outcomes.slice(1)) {
        if (o.next === null || publicState(o.next, viewer) !== publicState(first.next, viewer))
          continue;
        const diff = differingParts(
          observe(module, viewer, first, false),
          observe(module, viewer, o, false),
        );
        if (diff.length > 0) {
          fail(
            `LEAK: ${viewerLabel(viewer)} observes [${diff.join(', ')}] of seat ${actor}'s hidden input`,
          );
        }
      }
    }
  }
}

/** Trace-level non-interference (§3.5) plus secret-marker checks over random walks. */
export function checkRedaction<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
): string[] {
  const failures: string[] = [];
  const walks = options.redactionWalks ?? 40;
  for (let w = 0; w < walks && failures.length < MAX_FAILURES; w++) {
    const seedInt = seedFor(options.module.manifest.id, 'redaction', w);
    try {
      walk(options, seedInt, (point) =>
        redactionAt(options, point, (message) =>
          push(failures, `walk seed ${seedInt} seq ${point.engine.seq}: ${message}`),
        ),
      );
    } catch (error) {
      push(failures, `walk seed ${seedInt}: threw ${errorText(error)}`);
    }
  }
  return failures;
}

// ------------------------------------------------------------------ 5. budget

function perfNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/** Reference duration of the calibration loop on a developer laptop (ms). */
const CALIBRATION_REFERENCE_MS = 1.5;

/** How much slower this machine is than the reference (≥ 1, capped at 8). */
export function calibrationScale(): number {
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const rng = rngFromState([1, 2, 3, 4]);
    const start = perfNow();
    let sink = 0;
    for (let i = 0; i < 200_000; i++) sink ^= rng.nextU32();
    best = Math.min(best, perfNow() - start);
    if (sink === 0.5) best = 0; // keeps the loop from being optimised away
  }
  return Math.min(8, Math.max(1, best / CALIBRATION_REFERENCE_MS));
}

function p99(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.floor(0.99 * (sorted.length - 1))] ?? 0;
}

/** bot.choose p99 < 5 ms and reduce p99 < 1 ms (scaled by calibration). */
export async function checkBudget<S, A, C, V, E extends GameEvent>(
  options: ContractOptions<S, A, C, V, E>,
): Promise<string[]> {
  if (options.budget === false) return [];
  const budget = options.budget ?? { botChooseP99Ms: 5, reduceP99Ms: 1 };
  const { module } = options;
  const points: { state: S; seat: Seat; now: number; action: A }[] = [];
  for (let w = 0; w < 20 && points.length < 400; w++) {
    walk(options, seedFor(module.manifest.id, 'budget', w), ({ engine, rng }) => {
      if (engine.result) return;
      for (const seat of engine.awaiting.seats) {
        const action = chooseAction(module, engine.currentState, seat, rng);
        points.push({ state: engine.currentState, seat, now: engine.gameNow(), action });
      }
    });
  }
  const rng = deriveStream(seedFromInt(1), 'cosmetic');
  const botTimes: number[] = [];
  const reduceTimes: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    for (const { state, seat, now, action } of points) {
      const view = module.viewFor(state, seatViewer(seat));
      for (const level of BOT_LEVELS) {
        const start = perfNow();
        const pick = module.bot.choose(view, seat, level, forkRng(rng));
        if (isPromise(pick)) await pick;
        if (pass > 0) botTimes.push(perfNow() - start);
      }
      const start = perfNow();
      module.reduce(state, action, seat, { rng: forkRng(rng), now });
      if (pass > 0) reduceTimes.push(perfNow() - start);
    }
  }
  const scale = calibrationScale();
  const failures: string[] = [];
  const botP99 = p99(botTimes);
  const reduceP99 = p99(reduceTimes);
  if (botP99 > budget.botChooseP99Ms * scale) {
    failures.push(
      `bot.choose p99 ${botP99.toFixed(3)} ms > ${budget.botChooseP99Ms} ms × ${scale.toFixed(2)}`,
    );
  }
  if (reduceP99 > budget.reduceP99Ms * scale) {
    failures.push(
      `reduce p99 ${reduceP99.toFixed(3)} ms > ${budget.reduceP99Ms} ms × ${scale.toFixed(2)}`,
    );
  }
  return failures;
}
