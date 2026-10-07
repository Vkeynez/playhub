// Save data, progress events and merge rules (BUILD_BRIEF §8.3, ARCHITECTURE §3.8 / §8.2).
//
// Field rules: currentLevel `max`; levels.*.bestMoves `min`; levels.*.stars `max`; settings and the
// in-progress board `lww`. LWW fields carry their own HLC stamp (`at`, OQ E1) so a stale offline write
// loses to a newer one wherever and in whatever order they meet.

import { z } from 'zod';

import { i18nKey } from '@gp/game-sdk/core';
import type { MergeRule, ResumePoint } from '@gp/game-sdk/core';

import { MAX_LEVEL } from './generator';

export const SAVE_VERSION = 1;
/** Pours kept for Continue; a longer attempt is still playable, it just isn't saved beyond this. */
export const MAX_SAVED_MOVES = 2_000;
/** Generated levels have at most 14 tubes; the schema allows a little headroom. */
const MAX_TUBES = 16;

/** Hybrid logical clock stamp: compared by (wallMs, counter, deviceId). */
export const StampSchema = z.object({
  wallMs: z.int().min(0),
  counter: z.int().min(0).max(0xffff_ffff),
  deviceId: z.string().min(1).max(64),
});
export type Stamp = z.infer<typeof StampSchema>;

const LevelNumberSchema = z.int().min(1).max(MAX_LEVEL);
const TubeIndexSchema = z
  .int()
  .min(0)
  .max(MAX_TUBES - 1);

export const SettingsSchema = z.object({
  /** Draw each colour's symbol on the liquid (PALETTE[i].symbol). */
  colorBlind: z.boolean(),
  /** Shorter pour animation. */
  fastPour: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = { colorBlind: false, fastPour: false };

/** A level in progress, stored as its pours; replay with `resumeLevel(level, moves)`. */
export const SavedBoardSchema = z.object({
  level: LevelNumberSchema,
  moves: z.array(z.object({ from: TubeIndexSchema, to: TubeIndexSchema })).max(MAX_SAVED_MOVES),
});
export type SavedBoard = z.infer<typeof SavedBoardSchema>;

export const LevelRecordSchema = z.object({
  bestMoves: z.int().min(1),
  stars: z.int().min(1).max(3),
});
export type LevelRecord = z.infer<typeof LevelRecordSchema>;

const LevelKeySchema = z
  .string()
  .regex(/^[1-9][0-9]{0,4}$/)
  .refine((k) => Number(k) <= MAX_LEVEL);

export const SaveSchema = z.object({
  /** Highest unlocked level: the level after the best one completed. */
  currentLevel: LevelNumberSchema,
  /** Completed levels by number ("12"). */
  levels: z.record(LevelKeySchema, LevelRecordSchema),
  settings: z.object({ value: SettingsSchema, at: StampSchema.nullable() }),
  /** The Continue row's level in progress; null when none. */
  board: z.object({ value: SavedBoardSchema.nullable(), at: StampSchema.nullable() }),
});
export type ColorSortSave = z.infer<typeof SaveSchema>;

export const EventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('level_complete'),
    level: LevelNumberSchema,
    moves: z.int().min(1).max(1_000_000),
    stars: z.int().min(1).max(3),
    at: StampSchema,
  }),
  /** Save (or with `board: null`, drop) the level in progress. */
  z.object({ type: z.literal('board'), board: SavedBoardSchema.nullable(), at: StampSchema }),
  z.object({ type: z.literal('settings'), settings: SettingsSchema, at: StampSchema }),
]);
export type ColorSortEvent = z.infer<typeof EventSchema>;

export const MERGE_RULES: Record<string, MergeRule> = {
  currentLevel: 'max',
  'levels.*.bestMoves': 'min',
  'levels.*.stars': 'max',
  settings: 'lww',
  board: 'lww',
};

export function emptySave(): ColorSortSave {
  return {
    currentLevel: 1,
    levels: {},
    settings: { value: { ...DEFAULT_SETTINGS }, at: null },
    board: { value: null, at: null },
  };
}

/** Total order on stamps; null (never written) sorts first. */
export function compareStamps(a: Stamp | null, b: Stamp | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

interface Lww<T> {
  value: T;
  at: Stamp | null;
}

/** Newer stamp wins. Equal stamps (same device, same tick) fall back to the value's JSON, so it commutes. */
function lww<T>(a: Lww<T>, b: Lww<T>): Lww<T> {
  const c = compareStamps(a.at, b.at);
  if (c !== 0) return c > 0 ? a : b;
  return JSON.stringify(a.value) >= JSON.stringify(b.value) ? a : b;
}

function mergeRecord(a: LevelRecord | undefined, b: LevelRecord | undefined): LevelRecord {
  if (!a) return { ...(b as LevelRecord) };
  if (!b) return { ...a };
  return {
    bestMoves: a.bestMoves < b.bestMoves ? a.bestMoves : b.bestMoves,
    stars: a.stars > b.stars ? a.stars : b.stars,
  };
}

/** Field-wise merge of two saves by MERGE_RULES: idempotent, commutative and associative. */
export function mergeSaves(a: ColorSortSave, b: ColorSortSave): ColorSortSave {
  const levels: Record<string, LevelRecord> = {};
  for (const k of Object.keys(a.levels)) levels[k] = mergeRecord(a.levels[k], b.levels[k]);
  for (const k of Object.keys(b.levels))
    if (!(k in levels)) levels[k] = { ...(b.levels[k] as LevelRecord) };
  const settings = lww(a.settings, b.settings);
  const board = lww(a.board, b.board);
  return {
    currentLevel: a.currentLevel > b.currentLevel ? a.currentLevel : b.currentLevel,
    levels,
    settings: { value: { ...settings.value }, at: settings.at },
    board: { value: board.value, at: board.at },
  };
}

/**
 * Pure event reducer, identical on client and server. Never throws; an event for a level that is not
 * unlocked yet is ignored. Completing a level also clears the Continue board if it was that level.
 */
export function applyEvent(save: ColorSortSave, ev: ColorSortEvent): ColorSortSave {
  switch (ev.type) {
    case 'level_complete': {
      if (ev.level > save.currentLevel) return save;
      const key = String(ev.level);
      const levels = {
        ...save.levels,
        [key]: mergeRecord(save.levels[key], { bestMoves: ev.moves, stars: ev.stars }),
      };
      const unlocked = ev.level + 1 > MAX_LEVEL ? MAX_LEVEL : ev.level + 1;
      const clears =
        save.board.value !== null &&
        save.board.value.level === ev.level &&
        compareStamps(ev.at, save.board.at) > 0;
      return {
        ...save,
        currentLevel: save.currentLevel > unlocked ? save.currentLevel : unlocked,
        levels,
        board: clears ? { value: null, at: ev.at } : save.board,
      };
    }
    case 'board': {
      if (ev.board !== null && ev.board.level > save.currentLevel) return save;
      return { ...save, board: lww(save.board, { value: ev.board, at: ev.at }) };
    }
    case 'settings':
      return { ...save, settings: lww(save.settings, { value: ev.settings, at: ev.at }) };
  }
}

/** Where Home's Continue row goes (OQ D23): the level in progress, else the next level. */
export function resumePoint(save: ColorSortSave): ResumePoint | null {
  if (save.board.value !== null) {
    return {
      label: i18nKey('games.colorSort.resume.continue'),
      target: { level: save.board.value.level, inProgress: true },
    };
  }
  if (save.currentLevel > 1) {
    return {
      label: i18nKey('games.colorSort.resume.next'),
      target: { level: save.currentLevel, inProgress: false },
    };
  }
  return null;
}
