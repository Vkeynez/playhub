// "Monsoon" theme: a warm dark palette (rain-cloud indigo, marigold, terracotta, wet-leaf teal).
// Tokens only; components read them directly (no runtime theming yet).

export const colors = {
  bg: '#0e1220',
  bgDeep: '#090c16',
  surface: '#161c2e',
  surfaceRaised: '#1e2640',
  border: 'rgba(255, 236, 210, 0.10)',
  borderStrong: 'rgba(255, 236, 210, 0.22)',
  text: '#f7efe3',
  textMuted: '#c4b8a6',
  textDim: '#8d8576',
  marigold: '#f5a83a',
  marigoldDeep: '#d9771f',
  terracotta: '#e4664a',
  kumkum: '#d8405f',
  teal: '#3db8a5',
  rain: '#6a93dd',
  lotus: '#e88fb5',
  lavender: '#a58be0',
  leaf: '#7cc46a',
  scrim: 'rgba(6, 8, 15, 0.72)',
  success: '#62d29a',
  danger: '#ff7a6b',
} as const;

export type Shelf = 'friends' | 'adventure' | 'relax';

/** Gradient stops per shelf (top-left → bottom-right). */
export const shelfGradients: Record<Shelf, readonly [string, string]> = {
  friends: ['#f5a83a', '#c94a3c'],
  adventure: ['#3db8a5', '#3d5fb8'],
  relax: ['#e88fb5', '#7a5cc4'],
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radius = { sm: 10, md: 16, lg: 22, xl: 28, pill: 999 } as const;

export const font = {
  /** System stack: no font download on the Home critical path. */
  family: undefined,
  display: 34,
  title: 24,
  heading: 19,
  body: 16,
  small: 14,
  tiny: 12,
} as const;

/** Minimum touch target (ARCHITECTURE §6.8). */
export const TOUCH = 44;

/** Max content width on desktop. */
export const CONTENT_MAX = 1120;
