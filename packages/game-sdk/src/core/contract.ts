// The GameModule contract (ARCHITECTURE §3.1): the brief's §5 interface plus the additive refinements
// adopted in OPEN_QUESTIONS I6. The rationale for each refinement is in ARCHITECTURE §3.2.

import type { ZodType } from 'zod';

import type { MatchResult } from './result';
import type { Rng } from './rng';
import type { AssertNoSecrets } from './secret';
import type { BotLevel, GameEvent, I18nKey, Seat, SeatInfo, Viewer } from './types';

/** Inputs every reducer gets. `now` is GAME time in ms (§3.3), not wall time. */
export interface Ctx {
  rng: Rng;
  now: number;
}

export interface ModeManifest {
  id: string;
  name: I18nKey;
  /** Allowed seat counts: min..max, optionally narrowed to `allowed` (Carrom: [2, 4]). */
  seats: { min: number; max: number; allowed?: number[] };
  teams?: 'none' | 'pairs';
  turnTimerSec?: number;
  supportsBots: boolean;
  supportsSpectators: boolean;
  /** Freeze the game clock while a human seat is disconnected (2-seat simultaneous modes, OQ D30). */
  pauseOnDisconnect?: boolean;
}

export interface GameManifest {
  id: string;
  name: I18nKey;
  shelf: 'friends' | 'adventure' | 'relax';
  modes: ModeManifest[];
  offlineCapable: boolean;
  minAppVersion: string;
  /** Bumped whenever rules change; replays require a matching logicVersion. */
  logicVersion: number;
}

/** Which seats the game is waiting on, and until when (game time; null = no deadline). */
export interface Awaiting {
  seats: Seat[];
  deadlineAt: number | null;
}

/** Work a reducer asks the engine to run outside the reducer (Carrom physics). The output is logged. */
export interface Effect {
  kind: 'simulate';
  id: string;
  input: unknown;
}

export interface Step<S, E> {
  state: S;
  events: E[];
  effects?: Effect[];
}

/**
 * Rejection reasons are a closed enum per game: the shared reasons plus the game's own.
 * Free text is not allowed; it is where redaction bugs hide.
 */
export type RejectionReason =
  'NOT_YOUR_TURN' | 'ILLEGAL' | 'STALE' | 'FINISHED' | (string & Record<never, never>);

export interface Rejection<R extends string = RejectionReason> {
  ok: false;
  reason: R;
}

export type Validation<R extends string = RejectionReason> = { ok: true } | Rejection<R>;

export interface InitContext<C> {
  config: C;
  mode: string;
  seats: SeatInfo[];
  rng: Rng;
  now: number;
}

/**
 * A multiplayer game. All functions are pure: no Math.random, Date.now, timers, DOM or node:*.
 * Inputs are treated as immutable (the harness deep-freezes them).
 *
 * - S: state. JSON values only (no Map, Set, undefined, bigint). Hidden values are Secret<T>.
 * - A: action. C: room config. V: per-viewer view. E: event.
 * - V and E must not contain Secret<T>; defineGame() and MatchEngine.create() check this at compile time
 *   (AssertNoSecrets), and the harness checks serialized views and events at run time.
 */
export interface GameModule<S, A, C, V, E extends GameEvent = GameEvent> {
  manifest: GameManifest;
  stateVersion: number;
  configSchema: ZodType<C>;
  actionSchema: ZodType<A>;
  init(ctx: InitContext<C>): S;
  awaiting(state: S): Awaiting;
  /** Game time of the next time-driven change (a reveal pause ending), handled by tick. */
  wakeAt?(state: S): number | null;
  tick?(state: S, ctx: Ctx): Step<S, E>;
  /** Every legal action for `seat` (finite action spaces; used by bots and tests). */
  legalActions?(state: S, seat: Seat): A[];
  /** A random (ideally legal) action, for continuous action spaces. */
  sampleAction?(state: S, seat: Seat, rng: Rng): A;
  validate(state: S, action: A, seat: Seat): Validation;
  reduce(state: S, action: A, seat: Seat, ctx: Ctx): Step<S, E>;
  resolve?(state: S, effectId: string, output: unknown, ctx: Ctx): Step<S, E>;
  /** The auto-move when `seat` misses its deadline. Must be legal. */
  onTimeout(state: S, seat: Seat, rng: Rng): A;
  /** Non-null = the match is over. */
  result(state: S): MatchResult | null;
  viewFor(state: S, viewer: Viewer): V;
  /** The event as `viewer` may see it, or null to drop it for that viewer. */
  eventFor(event: E, viewer: Viewer): E | null;
  /** Game-specific invariant violations; empty when the state is consistent. */
  invariants?(state: S): string[];
  bot: { choose(view: V, seat: Seat, level: BotLevel, rng: Rng): A | Promise<A> };
  migrateState?(snapshot: unknown, fromStateVersion: number): S;
}

/**
 * Any game module, for registries and the room layer. Module members use method syntax, so a concrete
 * GameModule<TicTacToeState, ...> is assignable to this.
 */
export type AnyGameModule = GameModule<unknown, unknown, unknown, unknown, GameEvent>;

/**
 * Identity helper that pins the type parameters of a module definition and checks at compile time that
 * the view and event types contain no Secret<T>.
 */
export function defineGame<S, A, C, V, E extends GameEvent>(
  module: GameModule<S, A, C, V, E> & AssertNoSecrets<V> & AssertNoSecrets<E>,
): GameModule<S, A, C, V, E> {
  return module;
}

/** The mode manifest for `modeId`, or throws. */
export function findMode(manifest: GameManifest, modeId: string): ModeManifest {
  const mode = manifest.modes.find((m) => m.id === modeId);
  if (!mode) throw new Error(`Game ${manifest.id} has no mode ${modeId}`);
  return mode;
}

/** Seat counts a mode accepts, ascending. */
export function allowedSeatCounts(mode: ModeManifest): number[] {
  if (mode.seats.allowed) return [...mode.seats.allowed].sort((a, b) => a - b);
  const counts: number[] = [];
  for (let n = mode.seats.min; n <= mode.seats.max; n++) counts.push(n);
  return counts;
}
