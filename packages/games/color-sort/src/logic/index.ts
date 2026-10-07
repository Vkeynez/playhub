// Color Sort Flow logic (BUILD_BRIEF §7.9): a SoloGameModule plus pure level, play and solver code.

import type { SoloGameModule } from '@gp/game-sdk/core';

import { manifest } from '../manifest';
import {
  applyEvent,
  EventSchema,
  MERGE_RULES,
  resumePoint,
  SAVE_VERSION,
  SaveSchema,
} from './save';
import type { ColorSortEvent, ColorSortSave } from './save';

export * from './board';
export * from './generator';
export * from './play';
export * from './progress';
export * from './save';
export * from './solver';
export { PALETTE, PALETTE_SIZE } from '../content/palette';
export type { ColorSymbol, LiquidColor } from '../content/palette';
export { LEVELS, manifest } from '../manifest';

export const colorSort: SoloGameModule<ColorSortSave, ColorSortEvent> = {
  manifest,
  saveVersion: SAVE_VERSION,
  saveSchema: SaveSchema,
  eventSchema: EventSchema,
  mergeRules: MERGE_RULES,
  apply: applyEvent,
  resume: resumePoint,
};
