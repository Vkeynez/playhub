// LocalRoom: the offline / vs-bot authority (ARCHITECTURE §6.3). It runs the same MatchEngine the
// server runs, in process: seat 0 is the human, every other seat is a bot. The clock is a pausable
// monotonic clock, so a hidden tab or backgrounded app never auto-moves the human's seat.

import { seatViewer } from '@gp/game-sdk/core';
import type {
  BotLevel,
  GameEvent,
  GameModule,
  MatchResult,
  Seat,
  SeatInfo,
  Seed128,
} from '@gp/game-sdk/core';
import { MatchEngine } from '@gp/game-sdk/engine';
import type { CheckedModule, Scheduler } from '@gp/game-sdk/engine';

import { createPausableClock, realTimers } from './clock';
import type { PausableClock, TimerApi } from './clock';
import type { RoomState, RoomTransport, SubmitResult } from './types';

export const HUMAN_SEAT: Seat = 0;

export interface LocalRoomOptions {
  mode: string;
  config: unknown;
  /** Total seats; defaults to the mode's minimum. */
  seatCount?: number;
  botLevel: BotLevel;
  /** The human's seat; every other seat is a bot. Defaults to seat 0. */
  humanSeat?: Seat;
  seed?: Seed128;
  clock?: PausableClock;
  timers?: TimerApi;
  onError?(error: unknown): void;
}

export function randomSeed(): Seed128 {
  const words = new Uint32Array(4);
  globalThis.crypto.getRandomValues(words);
  if (words.every((w) => w === 0)) words[0] = 1;
  return [words[0] ?? 1, words[1] ?? 0, words[2] ?? 0, words[3] ?? 0];
}

export class LocalRoom<S, A, C, V, E extends GameEvent> implements RoomTransport<V, A, E> {
  readonly seat: Seat;
  private readonly engine: MatchEngine<S, A, C, V, E>;
  private readonly clock: PausableClock;
  private readonly listeners = new Set<(state: RoomState<V, E>) => void>();
  private state: RoomState<V, E>;
  private actionCounter = 0;
  private disposed = false;

  constructor(module: GameModule<S, A, C, V, E>, options: LocalRoomOptions) {
    this.seat = options.humanSeat ?? HUMAN_SEAT;
    this.clock = options.clock ?? createPausableClock();
    const timers = options.timers ?? realTimers;
    const clock = this.clock;
    const scheduler: Scheduler = {
      schedule(at, fire) {
        const handle = timers.setTimeout(fire, Math.max(0, at - clock.now()));
        return () => timers.clearTimeout(handle);
      },
    };
    const modeManifest = module.manifest.modes.find((m) => m.id === options.mode);
    if (!modeManifest) throw new Error(`${module.manifest.id} has no mode ${options.mode}`);
    const seatCount = options.seatCount ?? modeManifest.seats.min;
    if (this.seat < 0 || this.seat >= seatCount) {
      throw new Error(`humanSeat ${this.seat} is outside 0..${seatCount - 1}`);
    }
    const seats: SeatInfo[] = [];
    for (let seat = 0; seat < seatCount; seat++) {
      seats.push({
        seat,
        team: null,
        occupant:
          seat === this.seat
            ? { kind: 'human', userId: 'local' }
            : { kind: 'bot', level: options.botLevel },
      });
    }

    let ready = false;
    const engine = MatchEngine.create(
      // LocalRoom takes the module as registered; the redaction check already ran in defineGame().
      module as CheckedModule<S, A, C, V, E>,
      { config: options.config, mode: options.mode, seats, seed: options.seed ?? randomSeed() },
      {
        clock: () => clock.now(),
        scheduler,
        hooks: {
          onStep: (record) => {
            if (!ready) return;
            this.publish(record.events, record.result);
          },
          onError: (error) => {
            if (options.onError) options.onError(error);
            else console.error('LocalRoom engine error', error);
          },
        },
      },
    );
    this.engine = engine;
    const initial = engine.outputFor(seatViewer(this.seat));
    this.state = {
      version: initial.version,
      view: initial.view,
      events: initial.events,
      meta: initial.meta,
      result: engine.result,
    };
    ready = true;
  }

  subscribe(fn: (state: RoomState<V, E>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState(): RoomState<V, E> {
    return this.state;
  }

  serverNow(): number {
    return this.clock.now();
  }

  async submit(action: A): Promise<SubmitResult> {
    if (this.disposed) return { ok: false, reason: 'FINISHED' };
    this.actionCounter += 1;
    const ack = this.engine.submit(this.seat, action, {
      baseVersion: this.state.version,
      clientActionId: `local-${this.actionCounter}`,
    });
    return ack.ok ? { ok: true, version: ack.version } : { ok: false, reason: ack.reason };
  }

  /** Tab hidden / app backgrounded: freeze game time and every timer; resume where it stopped. */
  setActive(active: boolean): void {
    if (this.disposed) return;
    if (active) {
      this.clock.resume();
      this.engine.setConnected(this.seat, true);
    } else {
      this.engine.setConnected(this.seat, false);
      this.clock.pause();
    }
    this.publish([], null);
  }

  get paused(): boolean {
    return this.clock.paused;
  }

  dispose(): void {
    this.disposed = true;
    this.engine.dispose();
    this.listeners.clear();
  }

  private publish(events: readonly E[], result: MatchResult | null): void {
    const out = this.engine.outputFor(seatViewer(this.seat), events);
    this.state = {
      version: out.version,
      view: out.view,
      events: out.events,
      meta: out.meta,
      result: result ?? this.engine.result,
    };
    for (const fn of this.listeners) fn(this.state);
  }
}
