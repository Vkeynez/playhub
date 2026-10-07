import { deriveStream, seedFromInt } from '@gp/game-sdk/core';
import type { Rng } from '@gp/game-sdk/core';
import { describe, expect, it } from 'vitest';

import {
  applyEvent,
  boardEvent,
  colorSort,
  completeEvent,
  emptySave,
  EventSchema,
  hint,
  MERGE_RULES,
  mergeSaves,
  pourMove,
  SaveSchema,
  settingsEvent,
  startLevel,
} from '../index';
import type { ColorSortEvent, ColorSortSave, PlayState, Stamp } from '../index';

const at = (wallMs: number, deviceId = 'dev-a', counter = 0): Stamp => ({
  wallMs,
  counter,
  deviceId,
});

function randomStamp(rng: Rng): Stamp | null {
  if (rng.int(0, 4) === 0) return null;
  return at(rng.int(0, 5), rng.pick(['a', 'b']), rng.int(0, 1));
}

/** A random valid save; small value ranges so random pairs collide on keys and stamps. */
function randomSave(rng: Rng): ColorSortSave {
  const levels: ColorSortSave['levels'] = {};
  const n = rng.int(0, 5);
  for (let i = 0; i < n; i++) {
    levels[String(rng.int(1, 8))] = { bestMoves: rng.int(1, 30), stars: rng.int(1, 3) };
  }
  const settingsAt = randomStamp(rng);
  const boardAt = randomStamp(rng);
  return SaveSchema.parse({
    currentLevel: rng.int(1, 9),
    levels,
    settings: {
      value: { colorBlind: rng.int(0, 1) === 1, fastPour: rng.int(0, 1) === 1 },
      at: settingsAt,
    },
    board: {
      value:
        boardAt && rng.int(0, 1) === 1
          ? { level: rng.int(1, 9), moves: [{ from: rng.int(0, 4), to: rng.int(0, 4) }] }
          : null,
      at: boardAt,
    },
  });
}

describe('module', () => {
  it('is a relax-shelf, offline SoloGameModule', () => {
    expect(colorSort.manifest).toMatchObject({
      id: 'color-sort',
      shelf: 'relax',
      offlineCapable: true,
      logicVersion: 1,
    });
    expect(colorSort.saveVersion).toBe(1);
    expect(colorSort.mergeRules).toEqual({
      currentLevel: 'max',
      'levels.*.bestMoves': 'min',
      'levels.*.stars': 'max',
      settings: 'lww',
      board: 'lww',
    });
    expect(SaveSchema.parse(emptySave())).toEqual(emptySave());
  });

  it('rejects malformed saves and events', () => {
    expect(SaveSchema.safeParse({ ...emptySave(), currentLevel: 0 }).success).toBe(false);
    expect(
      SaveSchema.safeParse({ ...emptySave(), levels: { '01': { bestMoves: 3, stars: 1 } } })
        .success,
    ).toBe(false);
    expect(
      SaveSchema.safeParse({ ...emptySave(), levels: { '3': { bestMoves: 3, stars: 4 } } }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({ type: 'level_complete', level: 1, moves: 0, stars: 3, at: at(1) })
        .success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({
        type: 'board',
        board: { level: 1, moves: [{ from: 99, to: 0 }] },
        at: at(1),
      }).success,
    ).toBe(false);
    expect(EventSchema.safeParse({ type: 'nope', at: at(1) }).success).toBe(false);
  });
});

describe('apply', () => {
  const complete = (level: number, moves: number, stars: number, t = 10): ColorSortEvent => ({
    type: 'level_complete',
    level,
    moves,
    stars,
    at: at(t),
  });

  it('completing a level unlocks the next and keeps best moves (min) and stars (max)', () => {
    let s = emptySave();
    s = colorSort.apply(s, complete(1, 9, 2));
    expect(s.currentLevel).toBe(2);
    expect(s.levels['1']).toEqual({ bestMoves: 9, stars: 2 });
    s = colorSort.apply(s, complete(1, 12, 3));
    expect(s.levels['1']).toEqual({ bestMoves: 9, stars: 3 });
    s = colorSort.apply(s, complete(1, 7, 1));
    expect(s.levels['1']).toEqual({ bestMoves: 7, stars: 3 });
    expect(s.currentLevel).toBe(2); // replaying an old level never lowers progress
  });

  it('ignores events for levels that are still locked', () => {
    const s = emptySave();
    expect(colorSort.apply(s, complete(5, 9, 3))).toBe(s);
    expect(colorSort.apply(s, { type: 'board', board: { level: 4, moves: [] }, at: at(1) })).toBe(
      s,
    );
  });

  it('board and settings are last-writer-wins by HLC stamp', () => {
    let s = emptySave();
    s = applyEvent(s, {
      type: 'board',
      board: { level: 1, moves: [{ from: 0, to: 1 }] },
      at: at(5),
    });
    // A stale write (older stamp) loses, whatever order it arrives in.
    s = applyEvent(s, { type: 'board', board: { level: 1, moves: [] }, at: at(4) });
    expect(s.board.value?.moves).toHaveLength(1);
    s = applyEvent(s, settingsEvent({ colorBlind: true, fastPour: false }, at(3)));
    s = applyEvent(s, settingsEvent({ colorBlind: false, fastPour: true }, at(2)));
    expect(s.settings.value).toEqual({ colorBlind: true, fastPour: false });
    // Same wall time: the counter, then the device id, break the tie.
    s = applyEvent(s, settingsEvent({ colorBlind: false, fastPour: false }, at(3, 'dev-b')));
    expect(s.settings.value).toEqual({ colorBlind: false, fastPour: false });
  });

  it('completing the level in progress clears the Continue board; another level keeps it', () => {
    let s = applyEvent(emptySave(), { type: 'board', board: { level: 1, moves: [] }, at: at(5) });
    expect(colorSort.resume?.(s)).toEqual({
      label: 'games.colorSort.resume.continue',
      target: { level: 1, inProgress: true },
    });
    s = applyEvent(s, complete(1, 9, 3, 6));
    expect(s.board.value).toBeNull();
    expect(colorSort.resume?.(s)).toEqual({
      label: 'games.colorSort.resume.next',
      target: { level: 2, inProgress: false },
    });
    s = applyEvent(s, { type: 'board', board: { level: 2, moves: [] }, at: at(7) });
    s = applyEvent(s, complete(1, 8, 3, 8));
    expect(s.board.value?.level).toBe(2);
    expect(colorSort.resume?.(emptySave())).toBeNull();
  });

  it('never mutates its input', () => {
    const s = emptySave();
    const before = JSON.stringify(s);
    applyEvent(s, complete(1, 4, 3));
    applyEvent(s, { type: 'board', board: { level: 1, moves: [] }, at: at(1) });
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('event builders', () => {
  it('board while playing, completion on the win, both schema-valid', () => {
    let s: PlayState = startLevel(1);
    const first = boardEvent(s, at(1));
    expect(first && EventSchema.parse(first)).toEqual(first);
    while (!s.won) {
      const h = hint(s);
      if (h.kind !== 'move') throw new Error(h.kind);
      const r = pourMove(s, h.from, h.to);
      if (!r.ok) throw new Error(r.reason);
      s = r.state;
    }
    expect(boardEvent(s, at(2))).toBeNull();
    const done = completeEvent(s, at(3));
    expect(EventSchema.parse(done)).toEqual(done);
    expect(done).toMatchObject({ type: 'level_complete', level: 1, moves: s.par, stars: 3 });
  });
});

describe('merge rules', () => {
  const rng = deriveStream(seedFromInt(2026), 'game');
  const cases = Array.from({ length: 300 }, () => [
    randomSave(rng),
    randomSave(rng),
    randomSave(rng),
  ]);

  it('are idempotent, commutative and associative', () => {
    for (const [a, b, c] of cases as [ColorSortSave, ColorSortSave, ColorSortSave][]) {
      expect(mergeSaves(a, a)).toEqual(a);
      expect(mergeSaves(a, b)).toEqual(mergeSaves(b, a));
      expect(mergeSaves(mergeSaves(a, b), c)).toEqual(mergeSaves(a, mergeSaves(b, c)));
      expect(SaveSchema.safeParse(mergeSaves(a, b)).success).toBe(true);
    }
  });

  it('follow the declared per-field rules', () => {
    for (const [a, b] of cases as [ColorSortSave, ColorSortSave][]) {
      const m = mergeSaves(a, b);
      expect(m.currentLevel).toBe(Math.max(a.currentLevel, b.currentLevel));
      for (const k of new Set([...Object.keys(a.levels), ...Object.keys(b.levels)])) {
        const x = a.levels[k];
        const y = b.levels[k];
        expect(m.levels[k]?.bestMoves).toBe(
          Math.min(x?.bestMoves ?? Infinity, y?.bestMoves ?? Infinity),
        );
        expect(m.levels[k]?.stars).toBe(Math.max(x?.stars ?? 0, y?.stars ?? 0));
      }
    }
    expect(Object.keys(MERGE_RULES).sort()).toEqual(
      ['board', 'currentLevel', 'levels.*.bestMoves', 'levels.*.stars', 'settings'].sort(),
    );
  });

  it('merging two devices equals applying both event streams (any interleaving)', () => {
    const evA: ColorSortEvent[] = [
      { type: 'level_complete', level: 1, moves: 9, stars: 2, at: at(1, 'a') },
      { type: 'settings', settings: { colorBlind: true, fastPour: false }, at: at(2, 'a') },
    ];
    const evB: ColorSortEvent[] = [
      { type: 'level_complete', level: 1, moves: 7, stars: 3, at: at(1, 'b') },
      { type: 'board', board: { level: 2, moves: [] }, at: at(3, 'b') },
    ];
    const run = (evs: ColorSortEvent[]): ColorSortSave => evs.reduce(applyEvent, emptySave());
    const merged = mergeSaves(run(evA), run(evB));
    expect(run([...evA, ...evB])).toEqual(merged);
    expect(run([...evB, ...evA])).toEqual(merged);
  });
});
