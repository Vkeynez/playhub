// The 12 liquid colours (BUILD_BRIEF §7.9). Colour id = index in PALETTE; tubes store these ids.
// Colour-blind mode: every colour also has a distinct symbol the UI draws on each liquid unit, so no
// two colours are told apart by hue alone. Pure data, no platform imports.

export type ColorSymbol =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'diamond'
  | 'star'
  | 'heart'
  | 'cross'
  | 'plus'
  | 'hexagon'
  | 'moon'
  | 'drop'
  | 'bolt';

export interface LiquidColor {
  id: number;
  /** Stable machine name (analytics, tests, i18n key suffix). */
  key: string;
  /** i18n key for the accessible colour name. */
  nameKey: string;
  /** Suggested fill; the UI theme may adjust it for dark mode. */
  hex: string;
  /** Pattern drawn in colour-blind mode. Unique per colour. */
  symbol: ColorSymbol;
}

const COLORS: ReadonlyArray<Omit<LiquidColor, 'id' | 'nameKey'>> = [
  { key: 'red', hex: '#E53935', symbol: 'circle' },
  { key: 'orange', hex: '#FB8C00', symbol: 'square' },
  { key: 'yellow', hex: '#FDD835', symbol: 'triangle' },
  { key: 'lime', hex: '#9CCC65', symbol: 'diamond' },
  { key: 'green', hex: '#2E7D32', symbol: 'star' },
  { key: 'teal', hex: '#26A69A', symbol: 'heart' },
  { key: 'sky', hex: '#4FC3F7', symbol: 'cross' },
  { key: 'blue', hex: '#1E3A8A', symbol: 'plus' },
  { key: 'purple', hex: '#8E24AA', symbol: 'hexagon' },
  { key: 'pink', hex: '#F48FB1', symbol: 'moon' },
  { key: 'brown', hex: '#795548', symbol: 'drop' },
  { key: 'grey', hex: '#9E9E9E', symbol: 'bolt' },
];

export const PALETTE: readonly LiquidColor[] = COLORS.map((c, id) => ({
  ...c,
  id,
  nameKey: `games.colorSort.colors.${c.key}`,
}));

export const PALETTE_SIZE = 12;
