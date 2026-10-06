// Monsoon palette (mirrors apps/client/src/ui/theme.ts: game UI packages do not import the client)
// plus the Hand Cricket accents.

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
  ink: '#1b1209',
  marigold: '#f5a83a',
  marigoldDeep: '#d9771f',
  terracotta: '#e4664a',
  kumkum: '#d8405f',
  teal: '#3db8a5',
  rain: '#6a93dd',
  lotus: '#e88fb5',
  leaf: '#7cc46a',
  success: '#62d29a',
  danger: '#ff7a6b',
  // Arena
  skyTop: '#1a2140',
  skyBottom: '#3a2a3a',
  glow: '#f5a83a',
  field: '#183a33',
  fieldDeep: '#0f2622',
  pitch: '#c9a46b',
  pitchShade: '#a8844f',
  crease: '#f3e6cf',
  stump: '#f1dcb2',
  stumpShade: '#b88b4a',
  ball: '#c8323c',
  seam: '#f6d9a8',
  // Hands
  skin: '#e8b48c',
  skinShade: '#b9805a',
  cuffYou: '#f5a83a',
  botHand: '#8fa9dc',
  botShade: '#4f6aa6',
  cuffBot: '#3db8a5',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 16, lg: 22, xl: 28, pill: 999 } as const;
export const font = { display: 34, title: 24, heading: 19, body: 16, small: 14, tiny: 12 } as const;

/** One colour per pick value: buttons, the "this over" strip and the reveal badges. */
export const PICK_COLORS: Readonly<Record<number, string>> = {
  1: '#6a93dd',
  2: '#3db8a5',
  3: '#7cc46a',
  4: '#e88fb5',
  5: '#e4664a',
  6: '#f5a83a',
};

/** Max width of the play column on desktop. */
export const COLUMN_MAX = 640;
