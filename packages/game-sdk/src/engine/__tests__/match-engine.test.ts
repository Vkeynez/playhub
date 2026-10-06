import { describe, expect, it } from 'vitest';

import { deriveStream, hashJson, jsonClone, seedFromInt } from '../../core';
import type { BotLevel, SeatInfo } from '../../core';
import { FakeTime, flushMicrotasks } from '../../testing/fake-time';
import { MatchEngine, MAX_EPOCH, RESTORE_MIN_DEADLINE_MS, VERSION_EPOCH_FACTOR } from '../index';
import type { EffectRunner, EngineDeps, LogEntry, MatchSetup, StepRecord } from '../index';
import { duel, PICK_MS, REVEAL_MS } from './fixture';
import type { DuelAction, DuelEvent, DuelState } from './fixture';

const T0 = 1_000_000;
const pick = (n: number): DuelAction => ({ type: 'pick', n });

function seats(bot1?: BotLevel): SeatInfo[] {
  return [
    { seat: 0, team: null, occupant: { kind: 'human', userId: 'a' } },
    {
      seat: 1,
      team: null,
      occupant: bot1 ? { kind: 'bot', level: bot1 } : { kind: 'human', userId: 'b' },
    },
  ];
}

interface StartOptions {
  epoch?: number;
  bot1?: BotLevel;
  config?: Partial<{ rounds: number; useEffects: boolean }>;
  effects?: EffectRunner;
  module?: typeof duel;
}

function start(options: StartOptions = {}) {
  const time = new FakeTime(T0);
  const steps: StepRecord<DuelState, DuelEvent>[] = [];
  const afk: number[] = [];
  const setup: MatchSetup & { initNow: number } = {
    config: options.config ?? {},
    mode: 'duel',
    seats: seats(options.bot1),
    seed: seedFromInt(1),
    initNow: T0,
  };
  const deps: EngineDeps<DuelState, DuelEvent> = {
    clock: time.clock,
    scheduler: time,
    freezeInputs: true,
    hooks: { onStep: (record) => steps.push(record), onAfk: (seat) => afk.push(seat) },
  };
  if (options.epoch !== undefined) deps.epoch = options.epoch;
  if (options.effects) deps.effects = options.effects;
  const engine = MatchEngine.create(options.module ?? duel, setup, deps);
  const log = (): LogEntry[] => steps.map((s) => jsonClone(s.entry));
  return { engine, time, steps, afk, setup, deps, log };
}

function ok(result: { ok: boolean }): void {
  expect(result).toMatchObject({ ok: true });
}

describe('versions', () => {
  it('are epoch * 2^32 + n and strictly increase', () => {
    const { engine, time } = start({ epoch: 5 });
    const base = 5 * VERSION_EPOCH_FACTOR;
    expect(engine.version).toBe(base);
    ok(engine.submit(0, pick(1), { baseVersion: engine.version }));
    expect(engine.version).toBe(base + 1);
    ok(engine.submit(1, pick(2), { baseVersion: engine.version }));
    time.next(); // reveal tick
    expect(engine.version).toBe(base + 3);
  });

  it('stay below 2^53 and reject epochs out of range', () => {
    expect(MAX_EPOCH * VERSION_EPOCH_FACTOR + (VERSION_EPOCH_FACTOR - 1)).toBeLessThanOrEqual(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => start({ epoch: MAX_EPOCH + 1 })).toThrow(/epoch/);
    expect(() => start({ epoch: -1 })).toThrow(/epoch/);
  });
});

describe('submit', () => {
  it('rejects with the closed reasons: NOT_YOUR_TURN, ILLEGAL, STALE, FINISHED', () => {
    const { engine, time } = start({ config: { rounds: 2 } });
    const round1 = engine.version;
    ok(engine.submit(0, pick(3), { baseVersion: round1 }));
    expect(engine.submit(0, pick(1), { baseVersion: engine.version })).toEqual({
      ok: false,
      reason: 'NOT_YOUR_TURN',
    });
    expect(engine.submit(1, { type: 'pick', n: 7 }, { baseVersion: engine.version })).toEqual({
      ok: false,
      reason: 'ILLEGAL',
    });
    // Seat 1 acting on an older version is fine: its decision began at round1.
    ok(engine.submit(1, pick(1), { baseVersion: round1 }));
    time.next(); // reveal → round 2 starts
    expect(engine.awaitedSinceFor(0)).toBe(engine.version);
    expect(engine.submit(0, pick(2), { baseVersion: round1 })).toEqual({
      ok: false,
      reason: 'STALE',
    });
    ok(engine.submit(0, pick(2), { baseVersion: engine.version }));
    ok(engine.submit(1, pick(1), { baseVersion: engine.version }));
    time.next();
    expect(engine.result).not.toBeNull();
    expect(engine.submit(0, pick(1), { baseVersion: engine.version })).toEqual({
      ok: false,
      reason: 'FINISHED',
    });
    expect(engine.nextWakeAt()).toBeNull();
  });

  it('marks hidden picks write-behind and reveals as decision boundaries', () => {
    const { engine, time, steps } = start();
    ok(engine.submit(0, pick(1), { baseVersion: engine.version }));
    ok(engine.submit(1, pick(2), { baseVersion: engine.version }));
    time.next();
    expect(steps.map((s) => [s.entry.kind, s.decisionBoundary])).toEqual([
      ['action', false],
      ['action', false],
      ['tick', true],
    ]);
  });

  it('dedupes clientActionId, also after a restore (LRU rebuilt from the tail)', () => {
    const { engine, time, log } = start();
    const snapshot = jsonClone(engine.snapshot());
    const first = engine.submit(0, pick(2), { baseVersion: engine.version, clientActionId: 'x' });
    ok(first);
    const retry = engine.submit(0, pick(2), { baseVersion: 0, clientActionId: 'x' });
    expect(retry).toEqual({ ...first, duplicate: true });
    expect(log().filter((e) => e.kind === 'action')).toHaveLength(1);

    const restored = MatchEngine.restore(duel, snapshot, log(), {
      clock: time.clock,
      connectedSeats: [0, 1],
    });
    expect(restored.submit(0, pick(2), { baseVersion: 0, clientActionId: 'x' })).toEqual({
      ...first,
      duplicate: true,
    });
    // The same id from the other seat is a different action.
    ok(restored.submit(1, pick(1), { baseVersion: restored.version, clientActionId: 'x' }));
  });
});

describe('timers and AFK', () => {
  it('times out awaited seats at the deadline and reports 3 consecutive timeouts', () => {
    const { engine, time, steps, afk } = start({ config: { rounds: 5 } });
    for (let round = 1; round <= 3; round++) {
      time.advance(PICK_MS + REVEAL_MS);
    }
    expect(steps.filter((s) => s.entry.kind === 'timeout')).toHaveLength(6);
    expect(engine.afk).toEqual([3, 3]);
    expect(afk).toEqual([0, 1]);
    ok(engine.submit(0, pick(1), { baseVersion: engine.version }));
    expect(engine.afk).toEqual([0, 3]);
  });

  it('runs one timer: the earliest of deadline, wakeAt and bot moves', () => {
    const { engine, time } = start();
    expect(engine.nextWakeAt()).toBe(T0 + PICK_MS);
    expect(time.pending).toBe(1);
    ok(engine.submit(0, pick(1), { baseVersion: engine.version }));
    ok(engine.submit(1, pick(1), { baseVersion: engine.version }));
    expect(engine.nextWakeAt()).toBe(T0 + REVEAL_MS);
    expect(time.pending).toBe(1);
  });
});

describe('game clock', () => {
  it('freezes with no human connected and logs the offset when play resumes', () => {
    const { engine, time, steps } = start();
    time.advance(4_000);
    engine.setConnected(0, false);
    engine.setConnected(1, false);
    expect(engine.isFrozen).toBe(true);
    expect(engine.nextWakeAt()).toBeNull();
    time.advance(60_000);
    expect(steps).toHaveLength(0);
    engine.setConnected(0, true);
    expect(steps.map((s) => s.entry)).toEqual([
      { seq: 1, kind: 'clock', payload: { clockOffset: 60_000 }, now: T0 + 4_000 },
    ]);
    expect(engine.gameNow()).toBe(T0 + 4_000);
    expect(engine.meta().awaiting.deadlineAt).toBe(T0 + PICK_MS + 60_000);
    time.advance(PICK_MS - 4_000 - 1);
    expect(steps.filter((s) => s.entry.kind === 'timeout')).toHaveLength(0);
    time.advance(1);
    expect(steps.filter((s) => s.entry.kind === 'timeout')).toHaveLength(2);
  });

  it('restore gives every pending deadline at least 15 s and never moves game time back', () => {
    const { engine, time } = start();
    time.advance(1_000);
    ok(engine.submit(0, pick(2), { baseVersion: engine.version }));
    time.advance(8_000); // 1 s left on seat 1's deadline
    const snapshot = jsonClone(engine.snapshot());
    engine.dispose();

    time.now += 40_000; // the process was down for 40 s
    const steps: StepRecord<DuelState, DuelEvent>[] = [];
    const restored = MatchEngine.restore(duel, snapshot, [], {
      clock: time.clock,
      scheduler: time,
      connectedSeats: [0, 1],
      hooks: { onStep: (record) => steps.push(record) },
    });
    expect(steps.map((s) => s.entry.kind)).toEqual(['clock']);
    expect(restored.gameNow()).toBe(T0 + 1_000);
    expect(restored.nextWakeAt()).toBe(time.now + RESTORE_MIN_DEADLINE_MS);
    time.advance(RESTORE_MIN_DEADLINE_MS - 1);
    expect(steps.filter((s) => s.entry.kind === 'timeout')).toHaveLength(0);
    time.advance(1);
    expect(steps.filter((s) => s.entry.kind === 'timeout').map((s) => s.entry.now)).toEqual([
      T0 + PICK_MS,
    ]);
  });

  it('a restore in a new process logs its epoch, so versions keep increasing in replays too', () => {
    const { engine, time, log, setup } = start();
    ok(engine.submit(0, pick(2), { baseVersion: engine.version }));
    const snapshot = jsonClone(engine.snapshot());
    const steps: StepRecord<DuelState, DuelEvent>[] = [];
    const restored = MatchEngine.restore(duel, snapshot, [], {
      clock: time.clock,
      epoch: 1,
      connectedSeats: [0],
      hooks: { onStep: (record) => steps.push(record) },
    });
    expect(restored.version).toBe(VERSION_EPOCH_FACTOR + 1);
    expect(steps[0]?.entry).toMatchObject({ kind: 'clock', payload: { epoch: 1 } });
    const replayed = MatchEngine.replay(duel, setup, [...log(), ...steps.map((s) => s.entry)]);
    expect(replayed.version).toBe(restored.version);
    expect(() =>
      MatchEngine.restore(duel, restored.snapshot(), [], { clock: time.clock, epoch: 0 }),
    ).toThrow(/epoch/);
  });
});

describe('bots', () => {
  it('think for 400–1600 ms (bot stream) and then move', () => {
    const { engine, time, steps } = start({ bot1: 'easy' });
    const wake = engine.nextWakeAt();
    expect(wake).not.toBeNull();
    expect((wake ?? 0) - T0).toBeGreaterThanOrEqual(400);
    expect((wake ?? 0) - T0).toBeLessThanOrEqual(1600);
    time.next();
    expect(steps.map((s) => [s.entry.kind, 'seat' in s.entry ? s.entry.seat : null])).toEqual([
      ['action', 1],
    ]);
    // Bot choices never consume the game stream.
    expect(engine.gameRngState()).toEqual(deriveStream(seedFromInt(1), 'game').save());
  });

  it('drop async results whose seat changed occupant or decision', async () => {
    const resolvers: ((action: DuelAction) => void)[] = [];
    const asyncDuel: typeof duel = {
      ...duel,
      bot: { choose: () => new Promise<DuelAction>((resolve) => resolvers.push(resolve)) },
    };
    const { engine, time, steps } = start({ bot1: 'hard', module: asyncDuel });
    time.next();
    expect(resolvers).toHaveLength(1);
    engine.setHuman(1, true); // the human reclaims the seat while the bot is thinking
    resolvers[0]?.(pick(3));
    await flushMicrotasks();
    expect(steps).toHaveLength(0);

    engine.setBot(1, 'medium');
    time.next();
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.(pick(2));
    await flushMicrotasks();
    expect(steps.map((s) => s.entry.kind)).toEqual(['action']);
  });
});

describe('effects', () => {
  function manualRunner() {
    const runs: string[] = [];
    const resolvers: ((output: unknown) => void)[] = [];
    const runner: EffectRunner = {
      run: (effect) => {
        runs.push(effect.id);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    };
    return { runs, resolvers, runner };
  }

  it('run through the EffectRunner; outputs are logged and passed to resolve()', async () => {
    const live = manualRunner();
    const { engine, time, log, setup } = start({
      effects: live.runner,
      config: { useEffects: true },
    });
    ok(engine.submit(0, pick(1), { baseVersion: engine.version }));
    ok(engine.submit(1, pick(1), { baseVersion: engine.version }));
    expect(live.runs).toEqual(['round-1']);
    expect(engine.pendingEffects).toHaveLength(1);

    // A restore mid-flight re-issues the effect; replay never runs it.
    const again = manualRunner();
    const restored = MatchEngine.restore(duel, jsonClone(engine.snapshot()), [], {
      clock: time.clock,
      effects: again.runner,
      connectedSeats: [0],
    });
    expect(again.runs).toEqual(['round-1']);
    restored.dispose();

    live.resolvers[0]?.({ bonus: 5 });
    await flushMicrotasks();
    expect(log().at(-1)).toMatchObject({
      kind: 'effect',
      payload: { id: 'round-1', output: { bonus: 5 } },
    });
    expect(engine.currentState.scores).toEqual([5, 0]);
    expect(engine.pendingEffects).toEqual([]);
    expect(engine.deliverEffect('round-1', { bonus: 1 })).toBe(false);

    const replayed = MatchEngine.replay(duel, setup, log());
    expect(hashJson(replayed.currentState)).toBe(hashJson(engine.currentState));
  });
});

describe('snapshots, replay and outputs', () => {
  it('snapshot round-trips through JSON; restore + tail and replay reproduce the live state', () => {
    const { engine, time, log, setup } = start({ bot1: 'medium', config: { rounds: 5 } });
    const rng = deriveStream(seedFromInt(77), 'cosmetic');
    let mid: { snapshot: unknown; seq: number } | null = null;
    for (let i = 0; i < 200 && !engine.result; i++) {
      if (i === 6) mid = { snapshot: jsonClone(engine.snapshot()), seq: engine.seq };
      if (engine.awaiting.seats.includes(0) && rng.float() < 0.7) {
        ok(engine.submit(0, pick(rng.int(1, 3)), { baseVersion: engine.version }));
      } else {
        time.next();
      }
    }
    expect(engine.result).not.toBeNull();
    const snapshot = engine.snapshot();
    expect(jsonClone(snapshot)).toEqual(snapshot);

    const replayed = MatchEngine.replay(duel, setup, log());
    expect(hashJson(replayed.currentState)).toBe(hashJson(engine.currentState));
    expect(replayed.gameRngState()).toEqual(engine.gameRngState());
    expect(replayed.version).toBe(engine.version);

    const point = mid as { snapshot: unknown; seq: number } | null;
    expect(point).not.toBeNull();
    const tail = log().filter((e) => e.seq > (point?.seq ?? 0));
    const restored = MatchEngine.restore(duel, point?.snapshot, tail, { clock: time.clock });
    expect(hashJson(restored.currentState)).toBe(hashJson(engine.currentState));
    expect(restored.result).toEqual(engine.result);
  });

  it('rejects a replay whose log the rules reject', () => {
    const { setup } = start();
    const bad: LogEntry[] = [
      { seq: 1, kind: 'action', seat: 0, payload: { action: pick(9) }, now: T0 },
    ];
    expect(() => MatchEngine.replay(duel, setup, bad)).toThrow(/actionSchema/);
    const gap: LogEntry[] = [{ seq: 2, kind: 'tick', payload: {}, now: T0 }];
    expect(() => MatchEngine.replay(duel, setup, gap)).toThrow(/seq/);
  });

  it('per-viewer outputs show a seat its own pick only', () => {
    const { engine, steps } = start();
    ok(engine.submit(0, pick(3), { baseVersion: engine.version }));
    const events = steps[0]?.events ?? [];
    expect(engine.outputFor({ kind: 'seat', seat: 0 }, events).view.picks).toEqual([3, null]);
    expect(engine.outputFor({ kind: 'seat', seat: 1 }, events).view.picks).toEqual([
      { hidden: true },
      null,
    ]);
    const spectator = engine.outputFor({ kind: 'spectator' }, events);
    expect(spectator.view.picks).toEqual([{ hidden: true }, null]);
    expect(spectator.events).toEqual([{ type: 'picked', seat: 0 }]);
    expect(JSON.stringify(spectator)).not.toContain('__secret');
  });
});
