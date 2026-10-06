import { deriveStream, isSecret, jsonClone, seedFromInt, SPECTATOR } from '@gp/game-sdk/core';
import type { Rng, Seat } from '@gp/game-sdk/core';
import { checkRedaction, contractSuite, perturbOneSecret } from '@gp/game-sdk/testing';
import type { RedactionAdapter } from '@gp/game-sdk/testing';
import { describe, expect, it } from 'vitest';

import { configSchema, cricket, HAND_CRICKET, OVER_OPTIONS, PICKS, WICKET_OPTIONS } from '../index';
import type {
  CricketAction,
  CricketConfig,
  CricketEvent,
  CricketState,
  Decision,
  Parity,
} from '../index';

/** Changes one hidden pick (a toss throw or a ball pick) to another legal value. */
const redaction: RedactionAdapter<CricketState> = perturbOneSecret((s, _path, rng: Rng) =>
  typeof s.value === 'number' ? rng.pick(PICKS.filter((v) => v !== s.value)) : undefined,
);

// Worst case: 3 wickets × 5 overs = 30 balls × 2 picks × 2 innings + call, 2 throws, choose = 124.
contractSuite({
  module: cricket,
  maxActions: 130,
  redaction,
  config: (_mode, rng) => ({ wickets: rng.pick(WICKET_OPTIONS), overs: rng.pick(OVER_OPTIONS) }),
});

const rng = (): Rng => deriveStream(seedFromInt(7), 'game');
const seatViewer = (seat: Seat) => ({ kind: 'seat', seat }) as const;

/** Drives the module directly: actions are validated, timed phases are ticked until someone is awaited. */
class Match {
  state: CricketState;
  events: CricketEvent[] = [];
  now = 0;

  constructor(config: Partial<CricketConfig> = {}) {
    this.state = cricket.init({
      config: configSchema.parse(config),
      mode: HAND_CRICKET,
      seats: [],
      rng: rng(),
      now: 0,
    });
    this.check();
  }

  /** Applies an action without settling (the state may be left in a timed phase). */
  raw(seat: Seat, action: CricketAction): this {
    const verdict = cricket.validate(this.state, action, seat);
    if (!verdict.ok) throw new Error(`rejected: ${verdict.reason}`);
    const next = cricket.reduce(this.state, action, seat, { rng: rng(), now: this.now });
    this.state = next.state;
    this.events.push(...next.events);
    this.check();
    return this;
  }

  act(seat: Seat, action: CricketAction): this {
    this.raw(seat, action);
    return this.settle();
  }

  /** Ticks through reveals and pauses until a seat is awaited or the match is done. */
  settle(): this {
    for (let i = 0; i < 10 && cricket.awaiting(this.state).seats.length === 0; i++) {
      const wake = cricket.wakeAt?.(this.state) ?? null;
      if (wake === null) break;
      this.now = Math.max(this.now, wake);
      const next = cricket.tick?.(this.state, { rng: rng(), now: this.now });
      if (!next) break;
      this.state = next.state;
      this.events.push(...next.events);
      this.check();
    }
    return this;
  }

  check(): void {
    expect(cricket.invariants?.(this.state) ?? []).toEqual([]);
  }

  /** call → throws → choose. Returns the toss winner. */
  toss(call: Parity, throws: [number, number], decision: Decision): Seat {
    this.act(1, { type: 'call', call });
    this.act(0, { type: 'pick', value: throws[0] });
    this.act(1, { type: 'pick', value: throws[1] });
    const winner = this.state.toss.winner;
    if (winner === null) throw new Error('no toss winner');
    this.act(winner, { type: 'choose', decision });
    return winner;
  }

  get innings() {
    const inn = this.state.innings[this.state.innings.length - 1];
    if (!inn) throw new Error('no innings');
    return inn;
  }

  /** One ball: the bowler picks first, then the batter. */
  ball(batterPick: number, bowlerPick: number): this {
    const { batter, bowler } = this.innings;
    this.act(bowler, { type: 'pick', value: bowlerPick });
    return this.act(batter, { type: 'pick', value: batterPick });
  }

  balls(n: number, batterPick: number, bowlerPick: number): this {
    for (let i = 0; i < n; i++) this.ball(batterPick, bowlerPick);
    return this;
  }
}

describe('config', () => {
  it('defaults to 2 wickets and 2 overs and rejects other values', () => {
    expect(configSchema.parse({})).toEqual({ wickets: 2, overs: 2 });
    expect(configSchema.parse({ wickets: 3, overs: 5 })).toEqual({ wickets: 3, overs: 5 });
    expect(configSchema.safeParse({ wickets: 4 }).success).toBe(false);
    expect(configSchema.safeParse({ overs: 3 }).success).toBe(false);
  });

  it('the manifest has one 2-seat hand-cricket mode with a 5 s timer and pause on disconnect', () => {
    expect(cricket.manifest.modes).toHaveLength(1);
    expect(cricket.manifest.modes[0]).toMatchObject({
      id: 'hand-cricket',
      seats: { min: 2, max: 2 },
      turnTimerSec: 5,
      supportsBots: true,
      supportsSpectators: true,
      pauseOnDisconnect: true,
    });
    expect(cricket.manifest).toMatchObject({
      id: 'cricket',
      shelf: 'friends',
      offlineCapable: true,
    });
  });
});

describe('toss', () => {
  it('the joiner (seat 1) calls; the host cannot', () => {
    const m = new Match();
    expect(m.state.phase).toBe('call');
    expect(cricket.awaiting(m.state)).toEqual({ seats: [1], deadlineAt: m.state.deadlineAt });
    expect(cricket.validate(m.state, { type: 'call', call: 'odd' }, 0)).toEqual({
      ok: false,
      reason: 'NOT_YOUR_TURN',
    });
    expect(cricket.validate(m.state, { type: 'pick', value: 3 }, 1)).toEqual({
      ok: false,
      reason: 'ILLEGAL',
    });
  });

  it('an odd sum on an odd call: the caller wins and chooses', () => {
    const m = new Match();
    m.act(1, { type: 'call', call: 'odd' });
    expect(m.state.phase).toBe('toss');
    m.act(0, { type: 'pick', value: 3 }).act(1, { type: 'pick', value: 4 });
    expect(m.state.phase).toBe('choose');
    expect(m.state.toss).toMatchObject({ call: 'odd', throws: [3, 4], winner: 1 });
    expect(cricket.awaiting(m.state).seats).toEqual([1]);
    m.act(1, { type: 'choose', decision: 'bowl' });
    expect(m.state.phase).toBe('ball');
    expect(m.innings).toMatchObject({ number: 1, batter: 0, bowler: 1, target: null });
  });

  it('an even sum on an odd call: the host wins and bats', () => {
    const m = new Match();
    expect(m.toss('odd', [2, 4], 'bat')).toBe(0);
    expect(m.innings).toMatchObject({ batter: 0, bowler: 1 });
    expect(m.events.map((e) => e.type)).toEqual([
      'called',
      'picked',
      'picked',
      'toss',
      'chose',
      'innings-start',
    ]);
  });

  it('the toss throws stay hidden until both are in', () => {
    const m = new Match();
    m.act(1, { type: 'call', call: 'even' });
    m.act(0, { type: 'pick', value: 5 });
    expect(cricket.viewFor(m.state, seatViewer(0)).picks).toEqual([5, null]);
    expect(cricket.viewFor(m.state, seatViewer(1)).picks).toEqual([{ hidden: true }, null]);
    expect(cricket.viewFor(m.state, seatViewer(1)).toss.throws).toBeNull();
  });
});

describe('balls', () => {
  it('each seat sees only its own pick until the reveal; events hide the opponent pick', () => {
    const m = new Match();
    m.toss('odd', [1, 2], 'bat'); // seat 1 wins (odd), bats
    m.raw(0, { type: 'pick', value: 4 });
    expect(cricket.viewFor(m.state, seatViewer(0)).picks).toEqual([4, null]);
    expect(cricket.viewFor(m.state, seatViewer(1)).picks).toEqual([{ hidden: true }, null]);
    expect(cricket.viewFor(m.state, SPECTATOR).picks).toEqual([{ hidden: true }, null]);
    expect(JSON.stringify(cricket.viewFor(m.state, SPECTATOR))).not.toContain('__secret');
    expect(cricket.validate(m.state, { type: 'pick', value: 2 }, 0)).toEqual({
      ok: false,
      reason: 'ALREADY_PICKED',
    });
    const picked: CricketEvent = { type: 'picked', seat: 0, value: 4 };
    expect(cricket.eventFor(picked, seatViewer(0))).toEqual(picked);
    expect(cricket.eventFor(picked, seatViewer(1))).toEqual({
      type: 'picked',
      seat: 0,
      value: null,
    });
    expect(cricket.eventFor(picked, SPECTATOR)).toEqual({ type: 'picked', seat: 0, value: null });

    m.raw(1, { type: 'pick', value: 6 });
    expect(m.state.phase).toBe('ball-locked');
    expect(m.state.picks.every((p) => p !== null && isSecret(p))).toBe(true);
    expect(cricket.wakeAt?.(m.state)).toBe(m.now);
    m.settle();
    expect(m.state.lastBall).toMatchObject({
      batterPick: 6,
      bowlerPick: 4,
      outcome: 'six',
      runs: 6,
    });
    expect(m.state.phase).toBe('ball');
    expect(cricket.viewFor(m.state, SPECTATOR).current?.thisOver).toHaveLength(1);
  });

  it('equal picks: the batter is out for no runs; otherwise the batter scores their own number', () => {
    const m = new Match();
    m.toss('even', [2, 2], 'bat'); // seat 1 wins, bats
    m.ball(3, 5);
    expect(m.state.lastBall).toMatchObject({ outcome: 'runs', runs: 3 });
    m.ball(4, 4);
    expect(m.state.lastBall).toMatchObject({ outcome: 'out', runs: 0, over: 0, ball: 2 });
    expect(m.innings).toMatchObject({ runs: 3, wickets: 1, balls: 2 });
  });

  it('a reveal pause (wakeAt) follows each ball: longer after a wicket', () => {
    const m = new Match();
    m.toss('even', [2, 2], 'bat');
    m.ball(3, 5);
    const { batter, bowler } = m.innings;
    m.raw(bowler, { type: 'pick', value: 2 }).raw(batter, { type: 'pick', value: 1 });
    const reveal = cricket.tick?.(m.state, { rng: rng(), now: m.now });
    expect(reveal?.state.phase).toBe('ball-result');
    const runsPause = (reveal?.state.wakeAt ?? 0) - m.now;
    m.settle();
    m.raw(bowler, { type: 'pick', value: 2 }).raw(batter, { type: 'pick', value: 2 });
    const out = cricket.tick?.(m.state, { rng: rng(), now: m.now });
    expect(out?.state.lastBall?.outcome).toBe('out');
    expect((out?.state.wakeAt ?? 0) - m.now).toBeGreaterThan(runsPause);
    expect(runsPause).toBeGreaterThan(0);
  });

  it('the pick deadline is the 5 s turn timer', () => {
    const m = new Match();
    m.toss('odd', [1, 2], 'bat');
    expect(m.state.phase).toBe('ball');
    expect(cricket.awaiting(m.state)).toEqual({ seats: [0, 1], deadlineAt: m.now + 5_000 });
    expect(cricket.viewFor(m.state, SPECTATOR).awaiting).toEqual([0, 1]);
  });
});

describe('innings and result', () => {
  it('innings 1 ends on all wickets; innings 2 swaps roles with target = runs + 1', () => {
    const m = new Match({ wickets: 1, overs: 2 });
    m.toss('odd', [1, 2], 'bat'); // seat 1 bats
    m.ball(5, 1).ball(6, 1).ball(2, 2);
    expect(m.state.innings).toHaveLength(2);
    expect(m.innings).toMatchObject({ number: 2, batter: 0, bowler: 1, target: 12, runs: 0 });
    expect(m.state.phase).toBe('ball');
    const view = cricket.viewFor(m.state, seatViewer(0));
    expect(view.current).toMatchObject({ runsNeeded: 12, ballsLeft: 12, wicketsLeft: 1, over: 0 });
    expect(view.current?.thisOver).toEqual([]);
  });

  it('innings 1 ends after all overs (6 legal balls an over)', () => {
    const m = new Match({ wickets: 3, overs: 1 });
    m.toss('odd', [1, 2], 'bat');
    m.balls(5, 1, 2);
    const ballsSoFar = m.innings.history.map((b) => [b.over, b.ball]);
    expect(ballsSoFar).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
    ]);
    m.ball(1, 2);
    expect(m.state.innings).toHaveLength(2);
    expect(m.state.innings[0]).toMatchObject({ runs: 6, wickets: 0, balls: 6 });
  });

  it('the over counter moves on after 6 balls', () => {
    const m = new Match({ wickets: 3, overs: 2 });
    m.toss('odd', [1, 2], 'bat');
    m.balls(7, 1, 2);
    expect(m.state.lastBall).toMatchObject({ over: 1, ball: 1 });
    expect(cricket.viewFor(m.state, SPECTATOR).current?.thisOver).toHaveLength(1);
  });

  it('the chase ends the moment the target is passed', () => {
    const m = new Match({ wickets: 2, overs: 2 });
    m.toss('odd', [1, 2], 'bat'); // seat 1 bats first
    m.ball(4, 1).ball(4, 1).ball(3, 3).ball(3, 3); // 8 all out
    expect(m.innings).toMatchObject({ number: 2, batter: 0, target: 9 });
    m.ball(6, 1);
    expect(m.state.phase).toBe('ball');
    m.ball(5, 1); // 11 ≥ 9
    expect(m.state.phase).toBe('done');
    expect(m.innings.balls).toBe(2);
    expect(m.state.outcome).toEqual({
      winner: 0,
      reason: 'chased',
      margin: { kind: 'wickets', value: 2 },
    });
    expect(cricket.result(m.state)?.placements).toEqual([
      { seat: 0, place: 1, score: 11 },
      { seat: 1, place: 2, score: 8 },
    ]);
    expect(m.events.at(-1)).toEqual({
      type: 'ended',
      outcome: m.state.outcome,
      scores: [11, 8],
    });
    expect(cricket.awaiting(m.state).seats).toEqual([]);
    expect(cricket.validate(m.state, { type: 'pick', value: 1 }, 0)).toEqual({
      ok: false,
      reason: 'FINISHED',
    });
  });

  it('a defended total wins by runs', () => {
    const m = new Match({ wickets: 1, overs: 1 });
    m.toss('odd', [1, 2], 'bat');
    m.ball(6, 1).ball(4, 4); // 6
    m.ball(2, 1).ball(3, 3); // 2 all out
    expect(m.state.outcome).toEqual({
      winner: 1,
      reason: 'defended',
      margin: { kind: 'runs', value: 4 },
    });
  });

  it('equal scores are a draw (both placed first)', () => {
    const m = new Match({ wickets: 1, overs: 1 });
    m.toss('odd', [1, 2], 'bat');
    m.ball(5, 1).ball(2, 2); // 5
    m.ball(3, 1).ball(2, 1).ball(4, 4); // 5 all out
    expect(m.state.outcome).toEqual({ winner: null, reason: 'tie', margin: null });
    expect(cricket.result(m.state)?.placements.map((p) => p.place)).toEqual([1, 1]);
  });

  it('a chase that ends on overs below the target loses', () => {
    const m = new Match({ wickets: 3, overs: 1 });
    m.toss('odd', [1, 2], 'bat');
    m.balls(6, 5, 1); // 30
    m.balls(6, 1, 2); // 6 off the over
    expect(m.state.outcome).toMatchObject({ winner: 1, reason: 'defended' });
    expect(m.state.innings[1]).toMatchObject({ balls: 6, wickets: 0, runs: 6 });
  });

  it('keeps per-seat stats: runs, sixes, ducks, balls bowled, runs conceded', () => {
    const m = new Match({ wickets: 2, overs: 1 });
    m.toss('odd', [1, 2], 'bat'); // seat 1 bats first
    m.ball(3, 3); // duck
    m.ball(6, 1).ball(2, 2); // 6 then out (not a duck)
    m.ball(1, 1); // seat 0: duck
    m.ball(6, 1).ball(6, 2); // 12, chased
    const [s0, s1] = m.state.stats;
    expect(s1).toMatchObject({
      runs: 6,
      ballsFaced: 3,
      sixes: 1,
      ducks: 1,
      wicketsTaken: 1,
      ballsBowled: 3,
      runsConceded: 12,
    });
    expect(s0).toMatchObject({
      runs: 12,
      ballsFaced: 3,
      sixes: 2,
      ducks: 1,
      wicketsTaken: 2,
      ballsBowled: 3,
      runsConceded: 6,
    });
    expect(m.state.outcome?.winner).toBe(0);
  });
});

describe('timeouts', () => {
  it('a lapsed deadline picks at random from the game stream (deterministic per seed)', () => {
    const m = new Match();
    const call = cricket.onTimeout(m.state, 1, rng());
    expect(cricket.validate(m.state, call, 1)).toEqual({ ok: true });
    expect(cricket.onTimeout(m.state, 1, rng())).toEqual(call);

    m.act(1, call);
    const picks = new Set<number>();
    for (let seed = 0; seed < 60; seed++) {
      const action = cricket.onTimeout(m.state, 0, deriveStream(seedFromInt(seed), 'game'));
      expect(cricket.validate(m.state, action, 0)).toEqual({ ok: true });
      if (action.type === 'pick') picks.add(action.value);
    }
    expect([...picks].sort()).toEqual([1, 2, 3, 4, 5, 6]);

    m.act(0, { type: 'pick', value: 1 }).act(1, { type: 'pick', value: 2 });
    const winner = m.state.toss.winner ?? 0;
    const choice = cricket.onTimeout(m.state, winner, rng());
    expect(choice.type).toBe('choose');
    expect(cricket.validate(m.state, choice, winner)).toEqual({ ok: true });
  });

  it('a timed-out ball pick plays like a normal pick', () => {
    const m = new Match();
    m.toss('odd', [1, 2], 'bat');
    m.act(1, { type: 'pick', value: 4 });
    const auto = cricket.onTimeout(m.state, 0, rng());
    m.act(0, auto);
    expect(m.innings.balls).toBe(1);
  });
});

describe('the harness catches a leaky cricket', () => {
  const options = { maxActions: 130, redaction, redactionWalks: 8 };

  it('fails a variant whose eventFor passes the opponent pick through', () => {
    const leaky = { ...cricket, eventFor: (event: CricketEvent) => jsonClone(event) };
    expect(checkRedaction({ ...options, module: leaky }).join('\n')).toMatch(/LEAK: .*\[events\]/);
  });

  it('fails a variant whose view shows the pending picks', () => {
    const leaky = {
      ...cricket,
      viewFor: (state: CricketState, viewer: Parameters<typeof cricket.viewFor>[1]) => ({
        ...cricket.viewFor(state, viewer),
        picks: state.picks.map((pick) => pick?.value ?? null),
      }),
    };
    expect(checkRedaction({ ...options, module: leaky }).join('\n')).toMatch(/LEAK: .*\[view\]/);
  });
});
