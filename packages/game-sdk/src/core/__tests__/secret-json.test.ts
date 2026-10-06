import { describe, expect, it } from 'vitest';

import {
  deepFreeze,
  findSecrets,
  hashJson,
  isDraw,
  isSecret,
  jsonClone,
  jsonSafetyIssues,
  mapSecrets,
  matchResultIssues,
  placementsFromScores,
  project,
  secret,
  stableStringify,
  winners,
} from '../index';
import type { Viewer } from '../index';

const seat0: Viewer = { kind: 'seat', seat: 0 };
const seat1: Viewer = { kind: 'seat', seat: 1 };

describe('Secret and project()', () => {
  const state = deepFreeze({
    round: 2,
    picks: [secret(0, 3), secret(1, 1)],
    deck: secret('server', [5, 6, 7]),
    nested: { hand: secret(1, { cards: [secret(1, 9)] }) },
  });

  it('shows a seat its own secrets and hides everything else', () => {
    expect(project(state, seat0)).toEqual({
      round: 2,
      picks: [3, { hidden: true }],
      deck: { hidden: true },
      nested: { hand: { hidden: true } },
    });
    expect(project(state, seat1)).toEqual({
      round: 2,
      picks: [{ hidden: true }, 1],
      deck: { hidden: true },
      nested: { hand: { cards: [9] } },
    });
  });

  it('hides every secret from spectators and replay viewers', () => {
    for (const viewer of [{ kind: 'spectator' }, { kind: 'replay' }] as Viewer[]) {
      const json = JSON.stringify(project(state, viewer));
      expect(json).not.toContain('__secret');
      expect(json).not.toContain('"value"');
    }
  });

  it('works on deep-frozen input and returns fresh objects', () => {
    const out = project(state, seat0);
    expect(Object.isFrozen(out)).toBe(false);
    expect(isSecret(state.picks[0])).toBe(true);
  });

  it('mapSecrets and findSecrets report paths and copy the rest', () => {
    const found = findSecrets(state);
    expect(found.map((f) => f.path)).toEqual([
      ['picks', 0],
      ['picks', 1],
      ['deck'],
      ['nested', 'hand'],
    ]);
    const bumped = mapSecrets(state, (s, path) => (path[0] === 'picks' ? secret(s.owner, 99) : s));
    expect(project(bumped, seat0).picks).toEqual([99, { hidden: true }]);
    expect(state.picks[0]?.value).toBe(3);
  });
});

describe('JSON helpers', () => {
  it('jsonClone is a jsonb round trip', () => {
    const value = { a: [1, 'x', null], b: { c: true } };
    const copy = jsonClone(value);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(jsonClone(undefined)).toBeNull();
  });

  it('deepFreeze freezes nested values', () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
    expect(() => {
      (value.a.b as unknown[]).push(3);
    }).toThrow(TypeError);
  });

  it('jsonSafetyIssues flags everything a jsonb round trip would change', () => {
    expect(jsonSafetyIssues({ a: [1, 'two', null, { b: false }] })).toEqual([]);
    class Point {
      x = 1;
    }
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const cases: unknown[] = [
      { a: undefined },
      { a: new Map() },
      { a: new Set() },
      { a: 1n },
      { a: Number.NaN },
      { a: Infinity },
      { a: -0 },
      { a: new Point() },
      // eslint-disable-next-line no-sparse-arrays
      [1, , 3],
      circular,
      { f: () => 1 },
    ];
    for (const value of cases) expect(jsonSafetyIssues(value).length).toBeGreaterThan(0);
  });

  it('stableStringify and hashJson ignore key order but not content', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(hashJson({ b: 1, a: 2 })).toBe(hashJson({ a: 2, b: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
    expect(hashJson({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('MatchResult helpers', () => {
  it('ranks scores with standard competition ranking', () => {
    expect(placementsFromScores([10, 10, 5]).map((p) => p.place)).toEqual([1, 1, 3]);
    expect(placementsFromScores([3, 1], false).map((p) => p.place)).toEqual([2, 1]);
  });

  it('detects winners, draws and malformed results', () => {
    const win = { placements: placementsFromScores([2, 1]) };
    expect(winners(win)).toEqual([0]);
    expect(isDraw(win)).toBe(false);
    expect(isDraw({ placements: placementsFromScores([1, 1]) })).toBe(true);
    expect(matchResultIssues(win, 2)).toEqual([]);
    expect(matchResultIssues(win, 3)).toContain('seat 2 has no placement');
    expect(matchResultIssues({ placements: [{ seat: 0, place: 2, score: null }] }, 1)).toContain(
      'no seat has place 1',
    );
    expect(matchResultIssues({ nope: true }, 1)).toHaveLength(1);
  });
});
