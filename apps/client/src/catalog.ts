// Static catalog for the offline Home (mirrors packages/db/src/seed.ts: id, shelf, status, sort).
// Later the server's `games` rows override `status`; until then this is the source of truth.

import type { Shelf } from './ui/theme';

export type CatalogStatus = 'live' | 'coming_soon' | 'disabled' | 'dev';

export interface CatalogEntry {
  id: string;
  shelf: Shelf;
  status: CatalogStatus;
  sort: number;
  /** Players, for the tile's subtitle (null = solo). */
  seats: { min: number; max: number } | null;
}

export const CATALOG: readonly CatalogEntry[] = [
  { id: 'cricket', shelf: 'friends', status: 'coming_soon', sort: 10, seats: { min: 2, max: 2 } },
  { id: 'ludo', shelf: 'friends', status: 'coming_soon', sort: 20, seats: { min: 2, max: 4 } },
  { id: 'carrom', shelf: 'friends', status: 'coming_soon', sort: 30, seats: { min: 2, max: 4 } },
  { id: 'quiz', shelf: 'friends', status: 'coming_soon', sort: 40, seats: { min: 2, max: 8 } },
  { id: 'runner', shelf: 'adventure', status: 'coming_soon', sort: 50, seats: null },
  { id: 'lantern-quest', shelf: 'adventure', status: 'coming_soon', sort: 60, seats: null },
  { id: 'kolam', shelf: 'relax', status: 'coming_soon', sort: 70, seats: null },
  { id: 'koi-pond', shelf: 'relax', status: 'coming_soon', sort: 80, seats: null },
  { id: 'color-sort', shelf: 'relax', status: 'coming_soon', sort: 90, seats: null },
  { id: 'zen-garden', shelf: 'relax', status: 'coming_soon', sort: 100, seats: null },
  { id: 'dev-tictactoe', shelf: 'friends', status: 'dev', sort: 900, seats: { min: 2, max: 2 } },
  { id: 'dev-secret-pick', shelf: 'friends', status: 'dev', sort: 910, seats: { min: 2, max: 2 } },
];

export const SHELVES: readonly Shelf[] = ['friends', 'adventure', 'relax'];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((g) => g.id === id);
}
