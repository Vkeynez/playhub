// SoloGameModule (ARCHITECTURE §3.8). Types only in Phase 0; the implementation lands with packages/sync
// in Phase 2.

import type { ZodType } from 'zod';

import type { GameManifest } from './contract';
import type { I18nKey } from './types';

/** Dotted path into a save, e.g. 'stats.bestScore' or 'levels.*.stars'. */
export type FieldPath = string;

/** How concurrent offline writes to one field merge (ARCHITECTURE §8.2). */
export type MergeRule = 'max' | 'min' | 'set-union' | 'counter' | 'ledger' | 'lww';

/** Where "Continue" on Home takes the player (OQ D23). */
export interface ResumePoint {
  label: I18nKey;
  /** Game-specific target, e.g. { level: 12 } or { checkpoint: 'lantern-3' }. JSON values only. */
  target: Record<string, string | number | boolean>;
}

export interface SoloGameModule<Save, Ev> {
  manifest: GameManifest;
  saveVersion: number;
  saveSchema: ZodType<Save>;
  eventSchema: ZodType<Ev>;
  mergeRules: Record<FieldPath, MergeRule>;
  /** Pure; identical on client and server. */
  apply(save: Save, ev: Ev): Save;
  resume?(save: Save): ResumePoint | null;
  migrateSave?(old: unknown, fromVersion: number): Save;
}
