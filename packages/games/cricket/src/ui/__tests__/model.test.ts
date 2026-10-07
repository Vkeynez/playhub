import { describe, expect, it } from 'vitest';

import type { BallRecord, CricketView, InningsState } from '../../logic/rules';
import {
  canPick,
  chaseOf,
  digitsOf,
  feedbackFor,
  handValues,
  oversText,
  poseFor,
  resultLine,
  roleOf,
  seatNames,
  teamLines,
} from '../model';

function innings(n: number, batter: number, extra: Partial<InningsState> = {}): InningsState {
  return {
    number: n,
    batter,
    bowler: batter === 0 ? 1 : 0,
    runs: 0,
    wickets: 0,
    balls: 0,
    target: null,
    sinceWicket: 0,
    history: [],
    ...extra,
  };
}

function view(extra: Partial<CricketView> = {}): CricketView {
  return {
    you: 0,
    mode: 'hand-cricket',
    phase: 'ball',
    rules: { wickets: 2, overs: 2, ballsPerOver: 6, pickMs: 5000 },
    deadlineAt: null,
    awaiting: [0, 1],
    toss: { caller: 1, call: 'odd', throws: [3, 4], winner: 1, decision: 'bowl' },
    picks: [null, null],
    innings: [innings(1, 0)],
    current: null,
    lastBall: null,
    stats: [],
    outcome: null,
    ...extra,
  };
}

const ball = (extra: Partial<BallRecord>): BallRecord => ({
  innings: 1,
  over: 0,
  ball: 1,
  batterPick: 4,
  bowlerPick: 2,
  outcome: 'runs',
  runs: 4,
  ...extra,
});

describe('ui model', () => {
  it('maps picks to finger poses (6 = thumbs up)', () => {
    expect(poseFor(null)).toEqual([0, 0, 0, 0, 0]);
    expect(poseFor(1)).toEqual([0, 1, 0, 0, 0]);
    expect(poseFor(5).slice(1)).toEqual([1, 1, 1, 1]);
    expect(poseFor(6).slice(1)).toEqual([0, 0, 0, 0]);
    // The thumb is out for 5 and 6, splayed wider on the open hand than in the thumbs-up.
    expect(poseFor(6)[0]).toBeGreaterThan(0.5);
    expect(poseFor(5)[0]).toBeGreaterThan(poseFor(6)[0]);
  });

  it('formats overs and digits', () => {
    expect(oversText(0, 6)).toBe('0.0');
    expect(oversText(9, 6)).toBe('1.3');
    expect(oversText(12, 6)).toBe('2.0');
    expect(digitsOf(7)).toEqual([7]);
    expect(digitsOf(42, 3)).toEqual([0, 4, 2]);
    expect(digitsOf(-3)).toEqual([0]);
  });

  it('shows fists while picking and seat-mapped picks at the reveal', () => {
    const b = ball({ batterPick: 4, bowlerPick: 2 });
    expect(handValues(view({ lastBall: b }))).toEqual({ home: null, away: null, key: null });
    expect(handValues(view({ phase: 'ball-result', lastBall: b }))).toEqual({
      home: 4,
      away: 2,
      key: 'b1.0.1',
    });
    // The viewer bowls in innings 2: their hand shows the bowler's pick.
    const b2 = ball({ innings: 2, batterPick: 5, bowlerPick: 5, outcome: 'out', runs: 0 });
    const v2 = view({ phase: 'done', lastBall: b2, innings: [innings(1, 0), innings(2, 1)] });
    expect(handValues(v2)).toMatchObject({ home: 5, away: 5 });
    expect(handValues(view({ phase: 'toss-result' }))).toEqual({ home: 3, away: 4, key: 'toss' });
  });

  it('classifies ball feedback from the viewer side', () => {
    expect(feedbackFor(view(), ball({ outcome: 'six', runs: 6 }))).toEqual({
      kind: 'six',
      runs: 6,
      youBatted: true,
    });
    expect(feedbackFor(view(), ball({}))).toMatchObject({ kind: 'four' });
    expect(feedbackFor(view({ you: 1 }), ball({ outcome: 'out', runs: 0 }))).toEqual({
      kind: 'out',
      runs: 0,
      youBatted: false,
    });
  });

  it('builds scoreboard lines and the chase', () => {
    const cur = {
      number: 2,
      batter: 1,
      bowler: 0,
      runs: 10,
      wickets: 1,
      balls: 7,
      target: 24,
      runsNeeded: 14,
      ballsLeft: 5,
      wicketsLeft: 1,
      over: 1,
      thisOver: [],
    };
    const v = view({
      innings: [innings(1, 0, { runs: 23, wickets: 1, balls: 12 }), innings(2, 1, { runs: 10 })],
      current: cur,
    });
    const [home, away] = teamLines(v);
    expect(home).toMatchObject({ seat: 0, runs: 23, batted: true, batting: false });
    expect(away).toMatchObject({ seat: 1, runs: 10, batting: true });
    expect(chaseOf(v)).toEqual({ target: 24, runsNeeded: 14, ballsLeft: 5 });
    expect(roleOf(v)).toBe('bowl');
    expect(chaseOf(view({ current: { ...cur, target: null, runsNeeded: null } }))).toBeNull();
  });

  it('words the result from the viewer side', () => {
    const margin = { kind: 'runs' as const, value: 12 };
    expect(resultLine({ winner: 0, reason: 'defended', margin }, 0)).toEqual({
      key: 'wonByRuns',
      count: 12,
      won: true,
    });
    expect(
      resultLine({ winner: 1, reason: 'chased', margin: { kind: 'wickets', value: 1 } }, 0),
    ).toMatchObject({ key: 'lostByWickets', won: false });
    expect(resultLine({ winner: null, reason: 'tie', margin: null }, 0).key).toBe('tie');
  });

  it('allows a pick only when awaited and not yet picked', () => {
    expect(canPick(view(), false)).toBe(true);
    expect(canPick(view(), true)).toBe(false);
    expect(canPick(view({ picks: [{ hidden: true }, null] }), false)).toBe(false);
    expect(canPick(view({ phase: 'ball-result' }), false)).toBe(false);
    expect(canPick(view({ you: null }), false)).toBe(false);
  });

  it('names a human opponent instead of "Bot", and both players for a spectator', () => {
    const labels = { you: 'You', bot: 'Bot' };
    const players = [
      { seat: 0, name: 'Asha', bot: false },
      { seat: 1, name: 'Ravi', bot: false },
    ];
    expect(seatNames(1, players, labels)).toEqual({ 1: 'You', 0: 'Asha' });
    expect(seatNames(null, players, labels)).toEqual({ 0: 'Asha', 1: 'Ravi' });
    expect(seatNames(0, undefined, labels)).toEqual({ 0: 'You', 1: 'Bot' });
    expect(seatNames(0, [{ seat: 1, name: 'Bot 1', bot: true }], labels)).toEqual({
      0: 'You',
      1: 'Bot',
    });
  });
});
