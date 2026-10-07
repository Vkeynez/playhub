// Color Sort board rules (BUILD_BRIEF §7.9). Pure and integer-only, so every engine agrees.
//
// A tube is a stack of colour ids, bottom first. A pour moves the contiguous top run of one colour from
// one tube to another while space allows: onto an empty tube or onto the same colour. The board is
// solved when every tube is empty or full of a single colour.

/** Colour ids, bottom → top. Colour ids index `PALETTE` (0..11). */
export type Tube = readonly number[];

export interface Board {
  /** Units each tube holds (4 for every generated level). */
  capacity: number;
  tubes: readonly Tube[];
}

export interface Move {
  from: number;
  to: number;
}

/** Why a pour is refused. A closed enum: the UI maps each to a shake / i18n key. */
export type PourError =
  'BAD_TUBE' | 'SAME_TUBE' | 'EMPTY_SOURCE' | 'TARGET_FULL' | 'COLOR_MISMATCH';

export interface PourResult {
  board: Board;
  color: number;
  amount: number;
}

export function topColor(tube: Tube): number | undefined {
  return tube[tube.length - 1];
}

/** Length of the contiguous run of the top colour (0 for an empty tube). */
export function topRunLength(tube: Tube): number {
  const n = tube.length;
  if (n === 0) return 0;
  const c = tube[n - 1];
  let run = 1;
  while (run < n && tube[n - 1 - run] === c) run++;
  return run;
}

/** Number of contiguous colour runs in a tube. */
export function runCount(tube: Tube): number {
  let runs = 0;
  for (let i = 0; i < tube.length; i++) if (i === 0 || tube[i] !== tube[i - 1]) runs++;
  return runs;
}

/** Full of one colour. */
export function isTubeComplete(tube: Tube, capacity: number): boolean {
  return tube.length === capacity && runCount(tube) === 1;
}

export function isSolved(board: Board): boolean {
  return board.tubes.every((t) => t.length === 0 || isTubeComplete(t, board.capacity));
}

/** Distinct colours on the board. */
export function colorCount(board: Board): number {
  const seen = new Set<number>();
  for (const t of board.tubes) for (const c of t) seen.add(c);
  return seen.size;
}

/**
 * Lower bound on the moves left: total runs minus colours. A pour changes the total run count by at most
 * one, and the goal is exactly one run per colour, so this is admissible and consistent.
 */
export function mixScore(board: Board): number {
  let runs = 0;
  for (const t of board.tubes) runs += runCount(t);
  return runs - colorCount(board);
}

function validIndex(board: Board, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < board.tubes.length;
}

/** null when the pour is legal. */
export function checkPour(board: Board, from: number, to: number): PourError | null {
  if (!validIndex(board, from) || !validIndex(board, to)) return 'BAD_TUBE';
  if (from === to) return 'SAME_TUBE';
  const src = board.tubes[from] as Tube;
  const dst = board.tubes[to] as Tube;
  if (src.length === 0) return 'EMPTY_SOURCE';
  if (dst.length >= board.capacity) return 'TARGET_FULL';
  if (dst.length > 0 && topColor(dst) !== topColor(src)) return 'COLOR_MISMATCH';
  return null;
}

/** Units a legal pour moves: the whole top run, or as much of it as fits. 0 when illegal. */
export function pourAmount(board: Board, from: number, to: number): number {
  if (checkPour(board, from, to) !== null) return 0;
  const src = board.tubes[from] as Tube;
  const dst = board.tubes[to] as Tube;
  const run = topRunLength(src);
  const space = board.capacity - dst.length;
  return run < space ? run : space;
}

/** Applies a pour; the input board is not modified (untouched tubes are shared). */
export function pour(board: Board, from: number, to: number): PourResult | PourError {
  const err = checkPour(board, from, to);
  if (err !== null) return err;
  const amount = pourAmount(board, from, to);
  const src = board.tubes[from] as Tube;
  const dst = board.tubes[to] as Tube;
  const color = topColor(src) as number;
  const tubes = board.tubes.slice();
  tubes[from] = src.slice(0, src.length - amount);
  const grown = dst.slice();
  for (let i = 0; i < amount; i++) grown.push(color);
  tubes[to] = grown;
  return { board: { capacity: board.capacity, tubes }, color, amount };
}

export function isPourError(r: PourResult | PourError): r is PourError {
  return typeof r === 'string';
}

/** Every legal pour, in (from, to) order. */
export function legalMoves(board: Board): Move[] {
  const out: Move[] = [];
  const n = board.tubes.length;
  for (let from = 0; from < n; from++) {
    for (let to = 0; to < n; to++) {
      if (checkPour(board, from, to) === null) out.push({ from, to });
    }
  }
  return out;
}

/** Order-independent key: two boards that differ only by tube order share a key. */
export function canonicalKey(board: Board): string {
  const parts: string[] = [];
  for (const t of board.tubes) {
    let s = '';
    for (const c of t) s += String.fromCharCode(65 + c);
    parts.push(s);
  }
  parts.sort();
  return parts.join(',');
}

/** Exact-order key (tube positions matter). Used for golden hashes. */
export function boardKey(board: Board): string {
  return board.tubes.map((t) => t.map((c) => String.fromCharCode(65 + c)).join('')).join(',');
}

/** FNV-1a over a string, as an unsigned 32-bit int. Integer-only (Math.imul), so engines agree. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
