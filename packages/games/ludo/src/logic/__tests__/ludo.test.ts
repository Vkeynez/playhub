import { matchResultIssues } from '@gp/game-sdk/core';
import type { GameModule, ModeManifest, Rng, RngState, Seat, SeatInfo } from '@gp/game-sdk/core';
import { contractSuite, defaultSimMatches } from '@gp/game-sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC,
  configSchema,
  GRID_SIZE,
  cellOf,
  columnCell,
  homeCell,
  ludo,
  SAFE_SQUARES,
  START_SQUARES,
  TRACK_CELLS,
  trackCell,
  yardCell,
} from '../index';
import type {
  Colour,
  LudoAction,
  LudoConfig,
  LudoEvent,
  LudoRules,
  LudoState,
  LudoView,
} from '../index';

// ------------------------------------------------------------------ contract harness

type LudoModule = GameModule<LudoState, LudoAction, LudoConfig, LudoView, LudoEvent>;

/** The module with its one mode pinned to `seats` seats (and pairs or not), for per-shape suites. */
function variant(seats: number, teams: boolean): LudoModule {
  const base = ludo.manifest.modes[0];
  if (!base) throw new Error('no mode');
  const mode: ModeManifest = {
    ...base,
    seats: { min: seats, max: seats },
    teams: teams ? 'pairs' : 'none',
  };
  return {
    ...ludo,
    manifest: { ...ludo.manifest, id: `ludo-${seats}${teams ? '-teams' : ''}`, modes: [mode] },
  };
}

/** Random house rules (each toggle on 75% of the time). */
function randomConfig(teams: boolean) {
  return (_mode: ModeManifest, rng: Rng): LudoConfig => ({
    needSixToOpen: rng.float() < 0.75,
    threeSixesCancel: rng.float() < 0.75,
    captureBonus: rng.float() < 0.75,
    safeSquares: rng.float() < 0.75,
    homeBonus: rng.float() < 0.75,
    exactFinish: rng.float() < 0.75,
    teams,
  });
}

// No hard bound exists in Ludo. Bot-vs-bot over 1,000 seeded matches per shape with random house rules:
// 4 seats p99 ≈ 3,000 actions, max ≈ 6,300 (safe squares off + opening on any roll is the long tail);
// with the default rules the max is ≈ 1,700.
const MAX_ACTIONS = 10_000;
// One mode, four seat shapes: the per-mode simulation budget (100 locally, 1,000 in CI) is split across
// them. A 4-seat match is ~1,000 actions, so the harness costs ≈ 0.9 s per 4-seat match.
const LUDO_SIM_CAP = 300;

const SHAPES = [
  { seats: 2, teams: false, share: 0.3 },
  { seats: 3, teams: false, share: 0.25 },
  { seats: 4, teams: false, share: 0.25 },
  { seats: 4, teams: true, share: 0.2 },
] as const;
for (const { seats, teams, share } of SHAPES) {
  contractSuite({
    module: variant(seats, teams),
    maxActions: MAX_ACTIONS,
    config: randomConfig(teams),
    // A 4-seat Ludo match is ~1,000 actions, so 1,000 sims would take ~9 min in CI. Cap at 300 in
    // total (about 1 min); the per-game invariants and determinism checks still run on every step.
    matches: Math.max(10, Math.round(Math.min(defaultSimMatches(), LUDO_SIM_CAP) * share)),
    determinismMatches: seats === 4 ? 2 : 4,
    propertyRuns: 15,
    // No Secret<T> anywhere: the walks only confirm there is nothing to perturb and no marker leaks.
    redactionWalks: 10,
  });
}

// ------------------------------------------------------------------ helpers

/** A die that lands on the scripted values. */
function dice(...values: number[]): Rng {
  const queue = [...values];
  const next = (): number => {
    const value = queue.shift();
    if (value === undefined) throw new Error('no scripted roll left');
    return value;
  };
  const state: RngState = [1, 2, 3, 4];
  return {
    nextU32: next,
    int: next,
    float: () => 0,
    pick<T>(items: readonly T[]): T {
      const [first] = items;
      if (first === undefined) throw new Error('empty');
      return first;
    },
    shuffle: <T>(items: readonly T[]) => [...items],
    save: () => state,
  };
}

function seatsOf(n: number): SeatInfo[] {
  return Array.from({ length: n }, (_, seat) => ({
    seat,
    team: null,
    occupant: { kind: 'human', userId: `u${seat}` },
  }));
}

interface Setup {
  seats?: number;
  teams?: boolean;
  rules?: Partial<LudoRules>;
  tokens?: number[][];
  turn?: Seat;
}

/** Drives the module directly: every action is validated and every state checked against invariants. */
class Game {
  state: LudoState;
  events: LudoEvent[] = [];
  now = 0;

  constructor({ seats = 2, teams = false, rules = {}, tokens, turn = 0 }: Setup = {}) {
    const config = configSchema.parse({ ...rules, teams });
    const state = ludo.init({ config, mode: CLASSIC, seats: seatsOf(seats), rng: dice(), now: 0 });
    const rows = tokens ?? state.tokens;
    this.state = {
      ...state,
      tokens: rows.map((row) => [...row]),
      finished: rows.flatMap((row, seat) => (row.every((p) => p === 56) ? [seat] : [])),
      turn,
    };
    this.check();
  }

  act(seat: Seat, action: LudoAction, rng: Rng = dice()): LudoEvent[] {
    const verdict = ludo.validate(this.state, action, seat);
    if (!verdict.ok) throw new Error(`rejected: ${verdict.reason}`);
    this.now += 1_000;
    const step = ludo.reduce(this.state, action, seat, { rng, now: this.now });
    this.state = step.state;
    this.events.push(...step.events);
    this.check();
    return step.events;
  }

  roll(value: number): LudoEvent[] {
    return this.act(this.state.turn, { type: 'roll' }, dice(value));
  }

  move(token: number): LudoEvent[] {
    return this.act(this.state.turn, { type: 'move', token });
  }

  view(seat: Seat | null = null): LudoView {
    return ludo.viewFor(this.state, seat === null ? { kind: 'spectator' } : { kind: 'seat', seat });
  }

  check(): void {
    expect(ludo.invariants?.(this.state) ?? []).toEqual([]);
  }
}

const types = (events: LudoEvent[]) => events.map((e) => e.type);

// ------------------------------------------------------------------ manifest, config, init

describe('manifest and config', () => {
  it('declares one classic 2–4 seat mode with pairs, a 20 s timer, bots and spectators', () => {
    expect(ludo.manifest).toMatchObject({
      id: 'ludo',
      shelf: 'friends',
      offlineCapable: true,
      logicVersion: 1,
    });
    expect(ludo.manifest.modes).toEqual([
      expect.objectContaining({
        id: 'classic',
        seats: { min: 2, max: 4 },
        teams: 'pairs',
        turnTimerSec: 20,
        supportsBots: true,
        supportsSpectators: true,
      }),
    ]);
  });

  it('turns every house rule on by default, teams off', () => {
    expect(configSchema.parse({})).toEqual({
      needSixToOpen: true,
      threeSixesCancel: true,
      captureBonus: true,
      safeSquares: true,
      homeBonus: true,
      exactFinish: true,
      teams: false,
    });
    expect(configSchema.safeParse({ teams: 'yes' }).success).toBe(false);
  });

  it('seats colours clockwise, opposite for 2 seats, and only pairs up at 4 seats', () => {
    const colours = (n: number, teams = false): Colour[] =>
      new Game({ seats: n, teams }).state.colours;
    expect(colours(2)).toEqual(['red', 'yellow']);
    expect(colours(3)).toEqual(['red', 'green', 'yellow']);
    expect(colours(4)).toEqual(['red', 'green', 'yellow', 'blue']);
    expect(new Game({ seats: 3, teams: true }).state.teams).toBe(false);
    const teams = new Game({ seats: 4, teams: true });
    expect(teams.state.teams).toBe(true);
    expect(teams.view().seats.map((s) => [s.team, s.partner])).toEqual([
      [0, 2],
      [1, 3],
      [0, 0],
      [1, 1],
    ]);
  });

  it('starts with every token in base and seat 0 to roll within 20 s', () => {
    const game = new Game({ seats: 4 });
    expect(game.state.tokens.flat().every((p) => p === -1)).toBe(true);
    expect(ludo.awaiting(game.state)).toEqual({ seats: [0], deadlineAt: 20_000 });
    expect(ludo.legalActions?.(game.state, 0)).toEqual([{ type: 'roll' }]);
    expect(game.view(1).seats.map((s) => s.start)).toEqual(START_SQUARES);
  });
});

// ------------------------------------------------------------------ board

describe('board geometry', () => {
  it('has 52 distinct track cells, each a king step from the next, with 8 safe squares', () => {
    expect(TRACK_CELLS).toHaveLength(52);
    expect(new Set(TRACK_CELLS.map((c) => `${c.row},${c.col}`)).size).toBe(52);
    TRACK_CELLS.forEach((cell, i) => {
      const next = trackCell(i + 1);
      expect(Math.max(Math.abs(cell.row - next.row), Math.abs(cell.col - next.col))).toBe(1);
      expect(cell.row >= 0 && cell.row < GRID_SIZE && cell.col >= 0 && cell.col < GRID_SIZE).toBe(
        true,
      );
    });
    expect(SAFE_SQUARES).toEqual([0, 8, 13, 21, 26, 34, 39, 47]);
    expect(trackCell(0)).toEqual({ row: 6, col: 1 });
    expect(trackCell(13)).toEqual({ row: 1, col: 8 });
  });

  it('joins each home column to the track and to the centre', () => {
    for (const colour of ['red', 'green', 'yellow', 'blue'] as const) {
      const entry = cellOf(colour, 50, 0);
      const lane0 = columnCell(colour, 0);
      const lane4 = columnCell(colour, 4);
      const home = homeCell(colour);
      expect(Math.abs(entry.row - lane0.row) + Math.abs(entry.col - lane0.col)).toBe(1);
      expect(Math.abs(lane4.row - home.row) + Math.abs(lane4.col - home.col)).toBe(1);
      expect(home.row >= 6 && home.row <= 8 && home.col >= 6 && home.col <= 8).toBe(true);
      const yard = yardCell(colour, 3);
      expect(TRACK_CELLS.some((c) => c.row === yard.row && c.col === yard.col)).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ rules

describe('opening a token', () => {
  it('needs a 6: any other roll with everyone in base passes the turn', () => {
    const game = new Game();
    const events = game.roll(5);
    expect(events).toEqual([
      { type: 'rolled', seat: 0, value: 5, sixes: 0 },
      { type: 'turn-passed', from: 0, to: 1, reason: 'no-move' },
    ]);
    expect(game.state.turn).toBe(1);
    expect(game.view().lastRoll).toEqual({ seat: 0, value: 5 });
  });

  it('a 6 opens a token onto the start square and earns another roll', () => {
    const game = new Game();
    game.roll(6);
    expect(game.state.phase).toBe('move');
    expect(game.view().moves.map((m) => [m.token, m.opens, m.to])).toEqual([
      [0, true, 0],
      [1, true, 0],
      [2, true, 0],
      [3, true, 0],
    ]);
    const events = game.move(2);
    expect(events[0]).toMatchObject({ type: 'moved', owner: 0, token: 2, from: -1, to: 0 });
    expect(events).toContainEqual({ type: 'bonus-roll', seat: 0, reasons: ['six'] });
    expect(game.view().seats[0]?.tokens[2]).toMatchObject({ zone: 'track', square: 0 });
    expect(game.state).toMatchObject({ phase: 'roll', turn: 0 });
  });

  it('with needSixToOpen off any roll opens onto the start square', () => {
    const game = new Game({ seats: 2, rules: { needSixToOpen: false } });
    game.roll(3);
    game.move(0);
    expect(game.state.tokens[0]?.[0]).toBe(0);
    expect(game.view(1).seats[1]?.tokens[0]?.zone).toBe('base');
    expect(game.state.turn).toBe(1);
    // Yellow opens onto its own start square, 26.
    game.roll(2);
    game.move(1);
    expect(game.view().seats[1]?.tokens[1]?.square).toBe(26);
  });
});

describe('three sixes', () => {
  it('the third 6 in a row cancels the turn; earlier moves stand', () => {
    const game = new Game({
      tokens: [
        [10, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(6);
    game.move(0);
    game.roll(6);
    game.move(0);
    expect(game.state.sixes).toBe(2);
    const events = game.roll(6);
    expect(events).toEqual([
      { type: 'rolled', seat: 0, value: 6, sixes: 3 },
      { type: 'turn-cancelled', seat: 0, to: 1, reason: 'three-sixes' },
    ]);
    expect(game.state.tokens[0]?.[0]).toBe(22);
    expect(game.state).toMatchObject({ turn: 1, sixes: 0, phase: 'roll' });
  });

  it('a non-6 resets the count, and the rule can be turned off', () => {
    const game = new Game({
      tokens: [
        [10, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(6);
    game.move(0);
    game.roll(6);
    game.move(0);
    game.roll(1);
    expect(game.state.sixes).toBe(0);

    const off = new Game({
      rules: { threeSixesCancel: false },
      tokens: [
        [10, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    for (let i = 0; i < 3; i++) {
      off.roll(6);
      off.move(0);
    }
    expect(off.state.tokens[0]?.[0]).toBe(28);
    expect(off.state.turn).toBe(0);
  });
});

describe('captures', () => {
  // Red (seat 0) at 10 rolls a 4 onto square 14, where yellow's token 0 (progress 40) stands.
  const tokens = [
    [10, -1, -1, -1],
    [40, -1, -1, -1],
  ];

  it('sends the opponent token back to base and earns a bonus roll', () => {
    const game = new Game({ tokens });
    game.roll(4);
    expect(game.view().moves[0]?.captures).toEqual([{ seat: 1, token: 0 }]);
    const events = game.move(0);
    expect(types(events)).toEqual(['moved', 'captured', 'bonus-roll']);
    expect(events[1]).toEqual({
      type: 'captured',
      seat: 0,
      owner: 0,
      victim: 1,
      token: 0,
      square: 14,
    });
    expect(events[2]).toEqual({ type: 'bonus-roll', seat: 0, reasons: ['capture'] });
    expect(game.state.tokens[1]?.[0]).toBe(-1);
    expect(game.state.stats[0]?.captures).toBe(1);
    expect(game.state.stats[1]?.lost).toBe(1);
    expect(game.state.turn).toBe(0);
  });

  it('without captureBonus the turn passes after a capture', () => {
    const game = new Game({ tokens, rules: { captureBonus: false } });
    game.roll(4);
    expect(types(game.move(0))).toEqual(['moved', 'captured', 'turn-passed']);
    expect(game.state.turn).toBe(1);
  });

  it('captures every opponent token on the square', () => {
    // Yellow has two tokens on square 14 (progress 40).
    const game = new Game({
      tokens: [
        [10, -1, -1, -1],
        [40, 40, -1, -1],
      ],
    });
    game.roll(4);
    expect(types(game.move(0))).toEqual(['moved', 'captured', 'captured', 'bonus-roll']);
    expect(game.state.tokens[1]).toEqual([-1, -1, -1, -1]);
    expect(game.state.stats[1]?.lost).toBe(2);
  });
});

describe('safe squares', () => {
  it('a star and a start square never capture; tokens share them', () => {
    // Red at 4 rolls 4 onto the star at 8, where yellow (progress 34) stands.
    const star = new Game({
      tokens: [
        [4, -1, -1, -1],
        [34, -1, -1, -1],
      ],
    });
    star.roll(4);
    expect(star.view().moves[0]).toMatchObject({ safe: true, captures: [] });
    expect(types(star.move(0))).toEqual(['moved', 'turn-passed']);
    expect(star.state.tokens[1]?.[0]).toBe(34);

    // Red opens onto its start square 0, where yellow (progress 26) stands.
    const start = new Game({
      tokens: [
        [-1, -1, -1, -1],
        [26, -1, -1, -1],
      ],
    });
    start.roll(6);
    start.move(0);
    expect(start.state.tokens[1]?.[0]).toBe(26);
    expect(start.view().safeSquares).toEqual(SAFE_SQUARES);
  });

  it('with safeSquares off, stars and start squares capture too', () => {
    const star = new Game({
      rules: { safeSquares: false },
      tokens: [
        [4, -1, -1, -1],
        [34, -1, -1, -1],
      ],
    });
    star.roll(4);
    expect(types(star.move(0))).toEqual(['moved', 'captured', 'bonus-roll']);
    const start = new Game({
      rules: { safeSquares: false },
      tokens: [
        [-1, -1, -1, -1],
        [26, -1, -1, -1],
      ],
    });
    start.roll(6);
    expect(types(start.move(0))).toContain('captured');
    expect(start.view().safeSquares).toEqual([]);
  });

  it('partners never capture each other', () => {
    const game = new Game({
      seats: 4,
      teams: true,
      // Red at 10 rolls 4 onto 14 where its partner yellow (progress 40) stands.
      tokens: [
        [10, -1, -1, -1],
        [-1, -1, -1, -1],
        [40, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(4);
    expect(game.view().moves[0]?.captures).toEqual([]);
    game.move(0);
    expect(game.state.tokens[2]?.[0]).toBe(40);
  });
});

describe('home column and finishing', () => {
  it('turns into the home column after square 50 and hops through it', () => {
    const game = new Game({
      tokens: [
        [48, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(4);
    const [option] = game.view().moves;
    expect(option).toMatchObject({ from: 48, to: 52, entersColumn: true, safe: true });
    expect(option?.path).toEqual([
      { progress: 49, zone: 'track', square: 49, lane: null },
      { progress: 50, zone: 'track', square: 50, lane: null },
      { progress: 51, zone: 'column', square: null, lane: 0 },
      { progress: 52, zone: 'column', square: null, lane: 1 },
    ]);
    game.move(0);
    expect(game.view().seats[0]?.tokens[0]).toMatchObject({ zone: 'column', lane: 1 });
  });

  it('needs the exact roll to reach home; reaching home earns a bonus roll', () => {
    const game = new Game({
      tokens: [
        [53, 20, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(4); // 57 overshoots: only token 1 can move
    expect(game.view().moves.map((m) => m.token)).toEqual([1]);
    game.move(1);
    game.roll(2); // seat 1 can't open
    game.roll(3);
    const events = game.move(0);
    expect(types(events)).toEqual(['moved', 'entered-home', 'bonus-roll']);
    expect(events[2]).toEqual({ type: 'bonus-roll', seat: 0, reasons: ['home'] });
    expect(game.view().seats[0]).toMatchObject({ home: 1, inBase: 2 });
  });

  it('an overshooting roll is a pass when nothing else can move', () => {
    const game = new Game({
      tokens: [
        [53, 56, 56, 56],
        [-1, -1, -1, -1],
      ],
    });
    expect(types(game.roll(5))).toEqual(['rolled', 'turn-passed']);
  });

  it('with exactFinish off an overshooting roll still reaches home', () => {
    const game = new Game({
      rules: { exactFinish: false },
      tokens: [
        [53, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(5);
    expect(game.view().moves[0]).toMatchObject({ to: 56, reachesHome: true });
    expect(game.view().moves[0]?.path.map((s) => s.progress)).toEqual([54, 55, 56]);
  });

  it('without homeBonus reaching home passes the turn', () => {
    const game = new Game({
      rules: { homeBonus: false },
      tokens: [
        [53, 20, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(3);
    expect(types(game.move(0))).toEqual(['moved', 'entered-home', 'turn-passed']);
  });
});

describe('standings', () => {
  it('2 seats: the first player home wins', () => {
    const game = new Game({
      tokens: [
        [55, 56, 56, 56],
        [30, -1, -1, -1],
      ],
    });
    game.roll(1);
    const events = game.move(0);
    expect(types(events)).toEqual(['moved', 'entered-home', 'finished', 'ended']);
    expect(events[3]).toEqual({ type: 'ended', places: [1, 2], winners: [0] });
    expect(ludo.result(game.state)).toEqual({
      placements: [
        { seat: 0, place: 1, score: 4 },
        { seat: 1, place: 2, score: 0 },
      ],
    });
    expect(ludo.awaiting(game.state)).toEqual({ seats: [], deadlineAt: null });
    expect(ludo.validate(game.state, { type: 'roll' }, 1)).toEqual({
      ok: false,
      reason: 'FINISHED',
    });
  });

  it('free-for-all: finished seats leave the rotation; the match ends with one player left', () => {
    const game = new Game({
      seats: 3,
      tokens: [
        [55, 56, 56, 56],
        [55, 56, 56, 56],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(1);
    const first = game.move(0);
    expect(first).toContainEqual({ type: 'finished', seat: 0, place: 1 });
    // No bonus for a seat that is out: the turn passes.
    expect(first[first.length - 1]).toEqual({
      type: 'turn-passed',
      from: 0,
      to: 1,
      reason: 'moved',
    });
    game.roll(3); // seat 1 overshoots
    game.roll(2); // seat 2 can't open; seat 0 is skipped
    expect(game.state.turn).toBe(1);
    game.roll(1);
    const last = game.move(0);
    expect(last).toContainEqual({ type: 'finished', seat: 1, place: 2 });
    expect(last[last.length - 1]).toEqual({ type: 'ended', places: [1, 2, 3], winners: [0] });
    const result = ludo.result(game.state);
    expect(matchResultIssues(result, 3)).toEqual([]);
    expect(game.view().seats.map((s) => s.finishedAt)).toEqual([1, 2, null]);
  });
});

describe('2v2 teams', () => {
  it('a finished player rolls for and moves their partner; the team wins when both are home', () => {
    const game = new Game({
      seats: 4,
      teams: true,
      tokens: [
        [55, 56, 56, 56],
        [-1, -1, -1, -1],
        [50, 56, 56, 56],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(1);
    const first = game.move(0);
    expect(types(first)).toEqual(['moved', 'entered-home', 'finished', 'bonus-roll']);
    expect(game.state.turn).toBe(0);
    expect(game.view().controls).toBe(2);
    game.roll(6);
    const view = game.view(0);
    expect(view.moves).toHaveLength(1);
    expect(view.moves[0]).toMatchObject({
      owner: 2,
      token: 0,
      from: 50,
      to: 56,
      reachesHome: true,
    });
    const last = game.move(0);
    expect(last[0]).toMatchObject({ type: 'moved', seat: 0, owner: 2 });
    expect(last).toContainEqual({ type: 'finished', seat: 2, place: 2 });
    expect(last[last.length - 1]).toEqual({ type: 'ended', places: [1, 2, 1, 2], winners: [0, 2] });
  });

  it('a finished player keeps their place in the rotation', () => {
    const game = new Game({
      seats: 4,
      teams: true,
      turn: 3,
      tokens: [
        [56, 56, 56, 56],
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    game.roll(2);
    expect(game.state.turn).toBe(0);
    expect(game.view().controls).toBe(2);
    game.roll(6);
    expect(game.view().moves.every((m) => m.owner === 2)).toBe(true);
  });
});

describe('validation and timeouts', () => {
  it('rejects out-of-turn, out-of-phase and illegal actions with closed reasons', () => {
    const game = new Game({
      tokens: [
        [10, -1, -1, -1],
        [-1, -1, -1, -1],
      ],
    });
    expect(ludo.validate(game.state, { type: 'roll' }, 1)).toEqual({
      ok: false,
      reason: 'NOT_YOUR_TURN',
    });
    expect(ludo.validate(game.state, { type: 'move', token: 0 }, 0)).toEqual({
      ok: false,
      reason: 'ROLL_FIRST',
    });
    game.roll(3);
    expect(ludo.validate(game.state, { type: 'roll' }, 0)).toEqual({
      ok: false,
      reason: 'ALREADY_ROLLED',
    });
    expect(ludo.validate(game.state, { type: 'move', token: 1 }, 0)).toEqual({
      ok: false,
      reason: 'ILLEGAL',
    });
    expect(ludo.legalActions?.(game.state, 0)).toEqual([{ type: 'move', token: 0 }]);
    expect(ludo.legalActions?.(game.state, 1)).toEqual([]);
  });

  it('a timeout rolls, then plays the bot’s best move (a capture here)', () => {
    const game = new Game({
      tokens: [
        [10, 2, -1, -1],
        [40, -1, -1, -1],
      ],
    });
    expect(ludo.onTimeout(game.state, 0, dice())).toEqual({ type: 'roll' });
    game.roll(4);
    expect(ludo.onTimeout(game.state, 0, dice())).toEqual({ type: 'move', token: 0 });
  });

  it('views are public: every viewer sees the same board and moves', () => {
    const game = new Game({
      tokens: [
        [10, -1, -1, -1],
        [40, -1, -1, -1],
      ],
    });
    game.roll(4);
    const strip = (v: LudoView) => ({ ...v, you: null });
    expect(strip(game.view(1))).toEqual(strip(game.view(0)));
    expect(strip(game.view(null))).toEqual(strip(game.view(0)));
    expect(game.view().awaiting).toEqual([0]);
  });
});
