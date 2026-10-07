// Ludo rules, board geometry and types. Pure functions over LudoState; no randomness here (the module rolls).
//
// Board (classic Indian layout, 15×15 grid, play runs clockwise):
//   - a 52-square main track; colour c enters it at its start square 13·c;
//   - token progress: -1 = base (yard), 0..50 = main track (absolute square (13·c + p) % 52),
//     51..55 = the colour's 5-square home column, 56 = home;
//   - safe squares: the 4 start squares and the 4 stars (start + 8).

import type { Seat } from '@gp/game-sdk/core';

export type Colour = 'red' | 'green' | 'yellow' | 'blue';
/** Clockwise. Red's yard is top-left, green top-right, yellow bottom-right, blue bottom-left. */
export const COLOURS: readonly Colour[] = ['red', 'green', 'yellow', 'blue'];

export const TRACK_LENGTH = 52;
/** Track squares between consecutive start squares. */
export const ARM_LENGTH = 13;
export const TOKENS_PER_SEAT = 4;
export const BASE = -1;
/** The last main-track progress (the square in front of the home column). */
export const LAST_TRACK = 50;
export const COLUMN_START = 51;
export const COLUMN_LENGTH = 5;
export const HOME = 56;
/** A star sits this many squares after each start square. */
export const STAR_OFFSET = 8;
export const DIE_FACES: readonly number[] = [1, 2, 3, 4, 5, 6];
export const GRID_SIZE = 15;
export const DEFAULT_TURN_MS = 20_000;

/** Absolute track indices of the 4 start squares (red, green, yellow, blue). */
export const START_SQUARES: readonly number[] = [0, 13, 26, 39];
/** Absolute track indices of the 4 stars. */
export const STAR_SQUARES: readonly number[] = [8, 21, 34, 47];
/** Start squares + stars, sorted. */
export const SAFE_SQUARES: readonly number[] = [0, 8, 13, 21, 26, 34, 39, 47];

// ------------------------------------------------------------------ config, state, actions

/** House-rule toggles (OQ D9: all on by default). Blockades (OQ D10) are not implemented (off). */
export interface LudoRules {
  /** A 6 is needed to bring a token out of base (off: any roll opens it onto the start square). */
  needSixToOpen: boolean;
  /** A third 6 in a row cancels that roll and ends the turn (earlier moves stand). */
  threeSixesCancel: boolean;
  /** A capture earns a bonus roll. */
  captureBonus: boolean;
  /** Start squares and stars are safe (no captures there; off: no safe squares at all). */
  safeSquares: boolean;
  /** A token reaching home earns a bonus roll. */
  homeBonus: boolean;
  /** Finishing needs the exact roll (off: an overshooting roll still reaches home). */
  exactFinish: boolean;
}

export interface LudoConfig extends LudoRules {
  /** 2v2 at 4 seats: partners are seats s and s+2 (opposite colours). Ignored for 2 or 3 seats. */
  teams: boolean;
}

export const DEFAULT_RULES: LudoRules = {
  needSixToOpen: true,
  threeSixesCancel: true,
  captureBonus: true,
  safeSquares: true,
  homeBonus: true,
  exactFinish: true,
};

export type Phase = 'roll' | 'move' | 'done';

export interface SeatStats {
  rolls: number;
  sixes: number;
  /** Opponent tokens this seat's moves sent back to base. */
  captures: number;
  /** This seat's tokens sent back to base. */
  lost: number;
}

export interface LudoState {
  mode: string;
  rules: LudoRules;
  /** True only for 4 seats with config.teams. */
  teams: boolean;
  /** Colour of each seat. */
  colours: Colour[];
  /** tokens[seat][token] = progress (-1 base … 56 home). */
  tokens: number[][];
  phase: Phase;
  /** The seat to act: roll, then move. */
  turn: Seat;
  /** The die value waiting to be moved (phase 'move' only). */
  roll: number | null;
  /** Consecutive 6s rolled in the current turn (0..2). */
  sixes: number;
  lastRoll: { seat: Seat; value: number } | null;
  /** Seats whose 4 tokens are home, in finishing order. */
  finished: Seat[];
  turnMs: number;
  deadlineAt: number | null;
  /** places[seat] (1 = first) once the match is over. */
  places: number[] | null;
  stats: SeatStats[];
}

export type LudoAction = { type: 'roll' } | { type: 'move'; token: number };

export type LudoRejection =
  'NOT_YOUR_TURN' | 'FINISHED' | 'ROLL_FIRST' | 'ALREADY_ROLLED' | 'ILLEGAL';

// ------------------------------------------------------------------ views and events

export type Zone = 'base' | 'track' | 'column' | 'home';

/** Where a token is (or passes through). */
export interface Spot {
  progress: number;
  zone: Zone;
  /** Absolute main-track index 0..51 when zone is 'track', else null. */
  square: number | null;
  /** Home-column index 0..4 when zone is 'column', else null. */
  lane: number | null;
}

export interface TokenView extends Spot {
  token: number;
}

export interface TokenRef {
  seat: Seat;
  token: number;
}

/** One legal move for the awaited seat, with everything a UI or bot needs to rank or preview it. */
export interface MoveOption {
  token: number;
  /** Whose token moves: the awaited seat, or their partner once they have finished (teams). */
  owner: Seat;
  from: number;
  to: number;
  /** Every spot hopped, ending at the destination. */
  path: Spot[];
  /** Opponent tokens sent back to base by landing here. */
  captures: TokenRef[];
  /** Leaves base. */
  opens: boolean;
  /** The destination is a safe square, the home column or home. */
  safe: boolean;
  /** Crosses from the main track into the home column (or straight home). */
  entersColumn: boolean;
  reachesHome: boolean;
}

export interface SeatView {
  seat: Seat;
  colour: Colour;
  /** Team 0 (seats 0, 2) or 1 (seats 1, 3) in 2v2, else null. */
  team: number | null;
  partner: Seat | null;
  /** Absolute track index of this seat's start square. */
  start: number;
  tokens: TokenView[];
  inBase: number;
  home: number;
  /** Distance travelled by all 4 tokens, as a whole percentage 0..100. */
  progress: number;
  finished: boolean;
  /** Finishing position (1 = first to finish), or null. */
  finishedAt: number | null;
  stats: SeatStats;
}

export interface LudoView {
  you: Seat | null;
  mode: string;
  phase: Phase;
  rules: LudoRules;
  teams: boolean;
  turnMs: number;
  /** The seat to act. */
  turn: Seat;
  /** Whose tokens `turn` moves (themselves, or their partner once they have finished). */
  controls: Seat;
  awaiting: Seat[];
  deadlineAt: number | null;
  /** The die value waiting to be moved (phase 'move'). */
  roll: number | null;
  lastRoll: { seat: Seat; value: number } | null;
  sixes: number;
  /** Safe track squares under the current rules (empty when safeSquares is off). */
  safeSquares: number[];
  seats: SeatView[];
  /** Legal moves for `turn` (phase 'move' only; empty otherwise). */
  moves: MoveOption[];
  finished: Seat[];
  /** places[seat] once the match is over, else null. */
  places: number[] | null;
  winners: Seat[] | null;
}

export type BonusReason = 'six' | 'capture' | 'home';

export type LudoEvent =
  | { type: 'rolled'; seat: Seat; value: number; sixes: number }
  | {
      type: 'moved';
      seat: Seat;
      owner: Seat;
      token: number;
      from: number;
      to: number;
      path: Spot[];
    }
  | { type: 'captured'; seat: Seat; owner: Seat; victim: Seat; token: number; square: number }
  | { type: 'entered-home'; seat: Seat; owner: Seat; token: number }
  | { type: 'finished'; seat: Seat; place: number }
  | { type: 'bonus-roll'; seat: Seat; reasons: BonusReason[] }
  | { type: 'turn-passed'; from: Seat; to: Seat; reason: 'moved' | 'no-move' }
  | { type: 'turn-cancelled'; seat: Seat; to: Seat; reason: 'three-sixes' }
  | { type: 'ended'; places: number[]; winners: Seat[] };

// ------------------------------------------------------------------ seats and colours

/** Seat colours: 2 seats sit opposite (red, yellow); 3 take red, green, yellow; 4 take all. */
export function seatColours(seatCount: number): Colour[] {
  if (seatCount === 2) return ['red', 'yellow'];
  return COLOURS.slice(0, Math.max(0, Math.min(seatCount, COLOURS.length)));
}

export function colourIndex(colour: Colour): number {
  return COLOURS.indexOf(colour);
}

export function startSquare(colour: Colour): number {
  return colourIndex(colour) * ARM_LENGTH;
}

export function partnerOf(state: Pick<LudoState, 'teams' | 'colours'>, seat: Seat): Seat | null {
  return state.teams ? (seat + 2) % state.colours.length : null;
}

export function teamOf(state: Pick<LudoState, 'teams'>, seat: Seat): number | null {
  return state.teams ? seat % 2 : null;
}

/** Same side: the seat itself or its partner. */
export function sameSide(state: Pick<LudoState, 'teams'>, a: Seat, b: Seat): boolean {
  return a === b || (state.teams && a % 2 === b % 2);
}

/** Whose tokens `seat` moves: its own, or its partner's once it has finished (teams). */
export function controlledSeat(state: LudoState, seat: Seat): Seat {
  const partner = partnerOf(state, seat);
  return partner !== null && state.finished.includes(seat) ? partner : seat;
}

// ------------------------------------------------------------------ positions

export function isPoint(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 6;
}

export function zoneOf(progress: number): Zone {
  if (progress < 0) return 'base';
  if (progress <= LAST_TRACK) return 'track';
  if (progress < HOME) return 'column';
  return 'home';
}

/** Absolute track square for a main-track progress, else null. */
export function squareOf(colour: Colour, progress: number): number | null {
  return zoneOf(progress) === 'track' ? (startSquare(colour) + progress) % TRACK_LENGTH : null;
}

export function spotOf(colour: Colour, progress: number): Spot {
  const zone = zoneOf(progress);
  return {
    progress,
    zone,
    square: squareOf(colour, progress),
    lane: zone === 'column' ? progress - COLUMN_START : null,
  };
}

export function safeSquares(rules: LudoRules): number[] {
  return rules.safeSquares ? [...SAFE_SQUARES] : [];
}

export function isSafeSquare(rules: LudoRules, square: number): boolean {
  return rules.safeSquares && SAFE_SQUARES.includes(square);
}

/** Destination after rolling `value`, or null when the token can't move. */
export function destination(rules: LudoRules, progress: number, value: number): number | null {
  if (progress >= HOME) return null;
  if (progress === BASE) return !rules.needSixToOpen || value === 6 ? 0 : null;
  const to = progress + value;
  if (to <= HOME) return to;
  return rules.exactFinish ? null : HOME;
}

/** Opponent tokens on `square` (main track), i.e. not on `owner`'s side. */
export function opponentsOn(state: LudoState, owner: Seat, square: number): TokenRef[] {
  const found: TokenRef[] = [];
  state.tokens.forEach((tokens, seat) => {
    if (sameSide(state, seat, owner)) return;
    const colour = state.colours[seat];
    if (!colour) return;
    tokens.forEach((progress, token) => {
      if (squareOf(colour, progress) === square) found.push({ seat, token });
    });
  });
  return found;
}

/** Every legal move for the seat to act with the pending roll. */
export function legalMoves(state: LudoState): MoveOption[] {
  if (state.phase !== 'move' || state.roll === null) return [];
  const value = state.roll;
  const owner = controlledSeat(state, state.turn);
  const colour = state.colours[owner];
  const tokens = state.tokens[owner];
  if (!colour || !tokens) return [];
  const moves: MoveOption[] = [];
  tokens.forEach((from, token) => {
    const to = destination(state.rules, from, value);
    if (to === null) return;
    const path: Spot[] = [];
    for (let p = from === BASE ? 0 : from + 1; p <= to; p++) path.push(spotOf(colour, p));
    const square = squareOf(colour, to);
    const captures =
      square === null || isSafeSquare(state.rules, square) ? [] : opponentsOn(state, owner, square);
    moves.push({
      token,
      owner,
      from,
      to,
      path,
      captures,
      opens: from === BASE,
      safe: square === null || isSafeSquare(state.rules, square),
      entersColumn: from <= LAST_TRACK && to > LAST_TRACK,
      reachesHome: to === HOME,
    });
  });
  return moves;
}

export function allHome(tokens: readonly number[]): boolean {
  return tokens.length === TOKENS_PER_SEAT && tokens.every((p) => p === HOME);
}

/** Whole-percentage progress of 4 tokens (base counts as 0, home as 56 each). */
export function progressPercent(tokens: readonly number[]): number {
  const travelled = tokens.reduce((a, p) => a + Math.max(0, p), 0);
  return Math.floor((100 * travelled) / (HOME * TOKENS_PER_SEAT));
}

export function emptyStats(): SeatStats {
  return { rolls: 0, sixes: 0, captures: 0, lost: 0 };
}

// ------------------------------------------------------------------ board geometry (15×15 grid)

export interface Cell {
  row: number;
  col: number;
}

/** Red's 13 track squares (start square first); the other colours are quarter turns of these. */
const RED_ARM: readonly Cell[] = [
  { row: 6, col: 1 },
  { row: 6, col: 2 },
  { row: 6, col: 3 },
  { row: 6, col: 4 },
  { row: 6, col: 5 },
  { row: 5, col: 6 },
  { row: 4, col: 6 },
  { row: 3, col: 6 },
  { row: 2, col: 6 },
  { row: 1, col: 6 },
  { row: 0, col: 6 },
  { row: 0, col: 7 },
  { row: 0, col: 8 },
];
const RED_YARD: readonly Cell[] = [
  { row: 1, col: 1 },
  { row: 1, col: 4 },
  { row: 4, col: 1 },
  { row: 4, col: 4 },
];
const RED_HOME: Cell = { row: 7, col: 6 };

/** Rotates a red cell a quarter turn clockwise `turns` times. */
function rotate(cell: Cell, turns: number): Cell {
  let { row, col } = cell;
  for (let i = 0; i < turns; i++) {
    const next = { row: col, col: GRID_SIZE - 1 - row };
    row = next.row;
    col = next.col;
  }
  return { row, col };
}

/** Grid cells of the 52 track squares, indexed by absolute square. */
export const TRACK_CELLS: readonly Cell[] = COLOURS.flatMap((_, c) =>
  RED_ARM.map((cell) => rotate(cell, c)),
);

/** Grid cell of absolute track square `square`. */
export function trackCell(square: number): Cell {
  const cell = TRACK_CELLS[((square % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH];
  return cell ? { ...cell } : { row: 0, col: 0 };
}

/** Grid cell of `colour`'s home-column lane 0..4 (lane 0 is next to the track). */
export function columnCell(colour: Colour, lane: number): Cell {
  return rotate({ row: 7, col: 1 + lane }, colourIndex(colour));
}

/** Grid cell of `colour`'s yard slot for token 0..3. */
export function yardCell(colour: Colour, token: number): Cell {
  return rotate(RED_YARD[token] ?? { row: 1, col: 1 }, colourIndex(colour));
}

/** The centre cell where `colour`'s finished tokens rest (its side of the home triangle). */
export function homeCell(colour: Colour): Cell {
  return rotate(RED_HOME, colourIndex(colour));
}

/** Grid cell for a token of `colour` at `progress`. */
export function cellOf(colour: Colour, progress: number, token: number): Cell {
  switch (zoneOf(progress)) {
    case 'base':
      return yardCell(colour, token);
    case 'track':
      return trackCell(startSquare(colour) + progress);
    case 'column':
      return columnCell(colour, progress - COLUMN_START);
    default:
      return homeCell(colour);
  }
}
