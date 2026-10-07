// Shortest-solution search for the hint and the level par (BUILD_BRIEF §7.9).
//
// Phase 1 is A* over canonical states (tube order ignored, so permutations dedupe) with the admissible,
// consistent bound `boundOf`. With unit move costs that is a best-first BFS: the first
// solution it reaches is a shortest one. A node budget keeps it bounded on a phone. If the budget runs
// out, phase 2 is a greedy best-first search (ordered by the bound alone) with its own budget, which
// finds *a* solution fast but not necessarily the shortest one. Everything is deterministic and
// integer-only: the same board always gives the same answer on every engine.

import type { Board, Move, Tube } from './board';

/** Default expansions for the optimal phase (also used by the level generator for par). */
export const OPTIMAL_NODE_BUDGET = 20_000;
/** Default expansions for the greedy fallback. */
export const GREEDY_NODE_BUDGET = 20_000;

export interface SolveOptions {
  /** Expansions allowed for the optimal (A*) phase. */
  maxNodes?: number;
  /** Expansions allowed for the greedy fallback; 0 disables it. */
  maxGreedyNodes?: number;
}

export type SolveResult =
  /** `optimal`: true when `moves` is a shortest solution. `nodes`: total expansions used. */
  | { status: 'solved'; moves: Move[]; optimal: boolean; nodes: number }
  /** The search space was exhausted: no sequence of pours solves this board (a dead end). */
  | { status: 'unsolvable'; nodes: number }
  /** Both budgets ran out without an answer. */
  | { status: 'unknown'; nodes: number };

/** Binary min-heap of node ids keyed by a number (ties are broken by the key itself, see `key`). */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((keys[p] as number) <= key) break;
      ids[i] = ids[p] as number;
      keys[i] = keys[p] as number;
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0] as number;
    const lastId = ids.pop() as number;
    const lastKey = keys.pop() as number;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && (keys[r] as number) < (keys[l] as number) ? r : l;
        if ((keys[c] as number) >= lastKey) break;
        ids[i] = ids[c] as number;
        keys[i] = keys[c] as number;
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

/** Moves worth searching: drops pours that only permute tubes (dedupe would discard them anyway). */
export function searchMoves(board: Board): Move[] {
  return expandMoves(board.tubes.map(tubeString), board.capacity);
}

/** A tube as a string, one char per unit (bottom first). The search works on these: cheap to copy. */
function tubeString(tube: Tube): string {
  let s = '';
  for (const c of tube) s += String.fromCharCode(65 + c);
  return s;
}

function runsOf(t: string): number {
  let runs = 0;
  for (let i = 0; i < t.length; i++) if (i === 0 || t.charCodeAt(i) !== t.charCodeAt(i - 1)) runs++;
  return runs;
}

function topRunOf(t: string): number {
  const n = t.length;
  if (n === 0) return 0;
  const c = t.charCodeAt(n - 1);
  let run = 1;
  while (run < n && t.charCodeAt(n - 1 - run) === c) run++;
  return run;
}

function expandMoves(tubes: readonly string[], cap: number): Move[] {
  const out: Move[] = [];
  const firstEmpty = tubes.indexOf('');
  for (let from = 0; from < tubes.length; from++) {
    const src = tubes[from] as string;
    const n = src.length;
    if (n === 0) continue;
    const run = topRunOf(src);
    if (run === n && n === cap) continue; // complete tube
    const uniform = run === n;
    const c = src.charCodeAt(n - 1);
    for (let to = 0; to < tubes.length; to++) {
      if (to === from) continue;
      const dst = tubes[to] as string;
      if (dst.length === 0) {
        // All empty tubes are equivalent; moving a whole single-colour tube into one is a no-op.
        if (to !== firstEmpty || uniform) continue;
      } else if (dst.length >= cap || dst.charCodeAt(dst.length - 1) !== c) {
        continue;
      }
      out.push({ from, to });
    }
  }
  return out;
}

const bottomCounts = new Int32Array(64);

/**
 * Admissible, consistent lower bound on the pours left:
 * - every run that is not at the bottom of its tube must be poured out at least once;
 * - a colour sitting at the bottom of k tubes must have k − 1 of those bottom runs poured out.
 * Each pour is the first pour of at most one original run, so the sum holds; a pour lowers it by at
 * most one, so A* with it returns shortest solutions. It is ≥ `mixScore` (runs − colours).
 */
function boundOf(tubes: readonly string[]): number {
  let h = 0;
  bottomCounts.fill(0);
  for (const t of tubes) {
    if (t.length === 0) continue;
    h += runsOf(t) - 1;
    const b = t.charCodeAt(0) - 65;
    if (bottomCounts[b] !== 0) h++;
    bottomCounts[b] = 1;
  }
  return h;
}

/** `boundOf` for a board: a lower bound on the pours needed to solve it (0 iff solved). */
export function lowerBound(board: Board): number {
  return boundOf(board.tubes.map(tubeString));
}

function keyOfTubes(tubes: readonly string[]): string {
  return tubes.slice().sort().join(',');
}

interface SearchOutcome {
  status: 'solved' | 'exhausted' | 'budget';
  moves: Move[];
  nodes: number;
}

// Keys pack (primary, secondary, insertion order) into one double: primary < 2^12, secondary < 2^12,
// seq < 2^28, so the key stays below 2^52 and heap order is fully deterministic.
const SEQ_LIMIT = 0x1000_0000;
const SEC_SPAN = 0x1000;

function search(start: Board, maxNodes: number, greedy: boolean): SearchOutcome {
  const cap = start.capacity;
  const first = start.tubes.map(tubeString);
  const nodes: (readonly string[])[] = [first];
  const parent: number[] = [-1];
  const moveFrom: number[] = [-1];
  const moveTo: number[] = [-1];
  const depth: number[] = [0];
  const hOf: number[] = [boundOf(first)];
  const bestG = new Map<string, number>();
  bestG.set(keyOfTubes(first), 0);
  const closed = new Set<string>();
  const heap = new MinHeap();
  const keyOf = (g: number, h: number, seq: number): number => {
    const primary = greedy ? h : g + h;
    const secondary = greedy ? g : h;
    return (primary * SEC_SPAN + secondary) * SEQ_LIMIT + seq;
  };
  heap.push(0, keyOf(0, hOf[0] as number, 0));
  let expanded = 0;

  while (heap.size > 0) {
    const id = heap.pop();
    const tubes = nodes[id] as readonly string[];
    const key = keyOfTubes(tubes);
    if (closed.has(key)) continue;
    closed.add(key);
    const h = hOf[id] as number;
    if (h === 0) {
      const moves: Move[] = [];
      for (let n = id; n > 0; n = parent[n] as number) {
        moves.push({ from: moveFrom[n] as number, to: moveTo[n] as number });
      }
      moves.reverse();
      return { status: 'solved', moves, nodes: expanded };
    }
    if (expanded >= maxNodes) return { status: 'budget', moves: [], nodes: expanded };
    expanded++;
    const g = (depth[id] as number) + 1;
    for (const m of expandMoves(tubes, cap)) {
      const src = tubes[m.from] as string;
      const dst = tubes[m.to] as string;
      const run = topRunOf(src);
      const space = cap - dst.length;
      const amount = run < space ? run : space;
      const ns = src.slice(0, src.length - amount);
      const nd = dst + src.slice(src.length - amount);
      const next = tubes.slice();
      next[m.from] = ns;
      next[m.to] = nd;
      const nk = keyOfTubes(next);
      if (closed.has(nk)) continue;
      const prev = bestG.get(nk);
      if (prev !== undefined && prev <= g) continue;
      bestG.set(nk, g);
      const nid = nodes.length;
      if (nid >= SEQ_LIMIT) return { status: 'budget', moves: [], nodes: expanded };
      const nh = boundOf(next);
      nodes.push(next);
      parent.push(id);
      moveFrom.push(m.from);
      moveTo.push(m.to);
      depth.push(g);
      hOf.push(nh);
      heap.push(nid, keyOf(g, nh, nid));
    }
  }
  return { status: 'exhausted', moves: [], nodes: expanded };
}

/**
 * Solves `board`. Phase 1 (A*) returns a shortest solution; if its budget runs out, phase 2 (greedy)
 * returns some solution. `unsolvable` is only reported when a phase exhausted the whole search space.
 */
export function solve(board: Board, options: SolveOptions = {}): SolveResult {
  const maxNodes = options.maxNodes ?? OPTIMAL_NODE_BUDGET;
  const maxGreedy = options.maxGreedyNodes ?? GREEDY_NODE_BUDGET;
  const a = search(board, maxNodes, false);
  if (a.status === 'solved')
    return { status: 'solved', moves: a.moves, optimal: true, nodes: a.nodes };
  if (a.status === 'exhausted') return { status: 'unsolvable', nodes: a.nodes };
  if (maxGreedy <= 0) return { status: 'unknown', nodes: a.nodes };
  const b = search(board, maxGreedy, true);
  const nodes = a.nodes + b.nodes;
  if (b.status === 'solved') return { status: 'solved', moves: b.moves, optimal: false, nodes };
  if (b.status === 'exhausted') return { status: 'unsolvable', nodes };
  return { status: 'unknown', nodes };
}
