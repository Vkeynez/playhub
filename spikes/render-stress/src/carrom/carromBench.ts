// Spike (d): planck.js carrom-like shot benchmark. Throwaway code.
//
// Units: 1 world unit = 1 dm (10 cm). planck's defaults (linearSlop 5e-3, velocityThreshold 1,
// maxTranslation 2 per step) are tuned for ~0.1-10 unit objects, so decimetres keep a 1.6 cm coin at
// 0.16 units, the contact slop at 0.5 mm and the speed cap at 12 m/s (60 Hz) without touching the
// global Settings.
//
// Board numbers (ICF-ish): playing surface 74 cm square, coin Ø 3.18 cm / 5.5 g, striker Ø 4.13 cm /
// 15 g, pocket Ø 4.45 cm. Friction with the board is Coulomb-style (mu * g deceleration, clamped so it
// never reverses a body), plus light linear damping, so every shot reaches a true rest.

import { Box, Circle, World } from 'planck';
import type { Body } from 'planck';

export interface BenchOptions {
  shots: number;
  warmupShots: number;
  seed: number;
  /** Monotonic clock in ms (performance.now). Injected so the module stays platform-free. */
  now: () => number;
  /** true: every body is a bullet (CCD between dynamic bodies). false: only the striker. */
  allBullets: boolean;
  /** Coulomb friction coefficient between pieces and the board. Default 0.18 (powdered board). */
  mu?: number;
}

export interface ShotResult {
  ms: number;
  steps: number;
  pocketed: number;
  cappedAt8s: boolean;
}

export interface BenchSummary {
  shots: number;
  allBullets: boolean;
  mu: number;
  msPerShot: { mean: number; p50: number; p95: number; max: number };
  stepsPerShot: { mean: number; p50: number; max: number };
  msPerStep: number;
  pocketedTotal: number;
  capped: number;
  totalMs: number;
}

const BOARD = 7.4; // 74 cm
const HALF = BOARD / 2;
const COIN_R = 0.159;
const STRIKER_R = 0.2065;
const POCKET_R = 0.2225;
const COIN_MASS = 0.0055; // kg (planck mass is unit-agnostic; only ratios matter here)
const STRIKER_MASS = 0.015;
const DEFAULT_MU = 0.18; // board friction (powdered board)
const G = 98.1; // dm/s^2
const STEP = 1 / 60;
const MAX_STEPS = 8 * 60; // capped at 8 s
const REST_SPEED = 0.01; // 1 mm/s

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function density(mass: number, radius: number): number {
  return mass / (Math.PI * radius * radius);
}

/** 19 coins: queen in the centre, a ring of 6 touching it, a ring of 12 around that. */
function coinPositions(): Array<{ x: number; y: number }> {
  const d = 2 * COIN_R + 0.002;
  const out: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    out.push({ x: d * Math.cos(a), y: d * Math.sin(a) });
  }
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    out.push({ x: 2 * d * Math.cos(a), y: 2 * d * Math.sin(a) });
    const b = a + Math.PI / 6;
    const r = d * Math.sqrt(3);
    out.push({ x: r * Math.cos(b), y: r * Math.sin(b) });
  }
  return out;
}

const POCKETS = [
  { x: -HALF + POCKET_R, y: -HALF + POCKET_R },
  { x: HALF - POCKET_R, y: -HALF + POCKET_R },
  { x: -HALF + POCKET_R, y: HALF - POCKET_R },
  { x: HALF - POCKET_R, y: HALF - POCKET_R },
];

function buildWorld(allBullets: boolean): { world: World; bodies: Body[]; striker: Body } {
  const world = new World({ gravity: { x: 0, y: 0 } });

  const wall = world.createBody({ type: 'static' });
  const t = 0.5;
  const wallFix = { friction: 0.1, restitution: 0.6 };
  wall.createFixture({
    shape: new Box(HALF + t, t / 2, { x: 0, y: -HALF - t / 2 }, 0),
    ...wallFix,
  });
  wall.createFixture({ shape: new Box(HALF + t, t / 2, { x: 0, y: HALF + t / 2 }, 0), ...wallFix });
  wall.createFixture({
    shape: new Box(t / 2, HALF + t, { x: -HALF - t / 2, y: 0 }, 0),
    ...wallFix,
  });
  wall.createFixture({ shape: new Box(t / 2, HALF + t, { x: HALF + t / 2, y: 0 }, 0), ...wallFix });

  const bodies: Body[] = [];
  for (const p of coinPositions()) {
    const b = world.createBody({
      type: 'dynamic',
      position: p,
      linearDamping: 0.3,
      angularDamping: 2,
      bullet: allBullets,
    });
    b.createFixture({
      shape: new Circle(COIN_R),
      density: density(COIN_MASS, COIN_R),
      friction: 0.15,
      restitution: 0.8,
    });
    bodies.push(b);
  }

  const striker = world.createBody({
    type: 'dynamic',
    position: { x: 0, y: -2.6 },
    linearDamping: 0.3,
    angularDamping: 2,
    bullet: true,
  });
  striker.createFixture({
    shape: new Circle(STRIKER_R),
    density: density(STRIKER_MASS, STRIKER_R),
    friction: 0.15,
    restitution: 0.8,
  });
  bodies.push(striker);
  return { world, bodies, striker };
}

/** Coulomb-style board friction, applied as a velocity change after each step. */
function applyBoardFriction(b: Body, frictionDv: number): number {
  const v = b.getLinearVelocity();
  const speed = Math.hypot(v.x, v.y);
  if (speed <= frictionDv) {
    if (speed !== 0) b.setLinearVelocity({ x: 0, y: 0 });
    b.setAngularVelocity(0);
    return 0;
  }
  const k = (speed - frictionDv) / speed;
  b.setLinearVelocity({ x: v.x * k, y: v.y * k });
  return speed - frictionDv;
}

function inPocket(b: Body): boolean {
  const p = b.getPosition();
  for (const q of POCKETS) {
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    if (dx * dx + dy * dy < POCKET_R * POCKET_R) return true;
  }
  return false;
}

/** One shot: fresh board, striker flicked from the baseline, stepped at 60 Hz until rest or 8 s. */
export function simulateShot(
  rand: () => number,
  now: () => number,
  allBullets: boolean,
  mu: number = DEFAULT_MU,
): ShotResult {
  const frictionDv = mu * G * STEP; // velocity removed per step by board friction
  const { world, bodies, striker } = buildWorld(allBullets);
  const sx = -2 + 4 * rand();
  striker.setPosition({ x: sx, y: -2.6 });
  const tx = (rand() - 0.5) * 1.0;
  const ty = (rand() - 0.5) * 1.0;
  const speed = 30 + 40 * rand(); // 3-7 m/s
  const dx = tx - sx;
  const dy = ty + 2.6;
  const len = Math.hypot(dx, dy);
  striker.setLinearVelocity({ x: (dx / len) * speed, y: (dy / len) * speed });

  const live = bodies.slice();
  let pocketed = 0;
  let steps = 0;
  const t0 = now();
  while (steps < MAX_STEPS) {
    world.step(STEP, 8, 3);
    steps++;
    let moving = false;
    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i];
      if (inPocket(b)) {
        world.destroyBody(b);
        live.splice(i, 1);
        pocketed++;
        continue;
      }
      if (applyBoardFriction(b, frictionDv) > REST_SPEED) moving = true;
    }
    if (!moving) break;
  }
  const ms = now() - t0;
  return { ms, steps, pocketed, cappedAt8s: steps >= MAX_STEPS };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(results: ShotResult[], allBullets: boolean, mu: number): BenchSummary {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const steps = results.map((r) => r.steps).sort((a, b) => a - b);
  const totalMs = ms.reduce((s, x) => s + x, 0);
  const totalSteps = steps.reduce((s, x) => s + x, 0);
  return {
    shots: results.length,
    allBullets,
    mu,
    msPerShot: {
      mean: totalMs / results.length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      max: ms[ms.length - 1] ?? 0,
    },
    stepsPerShot: {
      mean: totalSteps / results.length,
      p50: percentile(steps, 50),
      max: steps[steps.length - 1] ?? 0,
    },
    msPerStep: totalSteps > 0 ? totalMs / totalSteps : 0,
    pocketedTotal: results.reduce((s, r) => s + r.pocketed, 0),
    capped: results.filter((r) => r.cappedAt8s).length,
    totalMs,
  };
}

/** Synchronous run (Node CLI). The app uses runCarromBenchAsync to keep the UI responsive. */
export function runCarromBench(opts: BenchOptions): BenchSummary {
  const mu = opts.mu ?? DEFAULT_MU;
  const rand = mulberry32(opts.seed);
  for (let i = 0; i < opts.warmupShots; i++) simulateShot(rand, opts.now, opts.allBullets, mu);
  const results: ShotResult[] = [];
  for (let i = 0; i < opts.shots; i++)
    results.push(simulateShot(rand, opts.now, opts.allBullets, mu));
  return summarize(results, opts.allBullets, mu);
}

/** Same shots as runCarromBench, yielding between shots. Each shot is still timed on its own. */
export async function runCarromBenchAsync(
  opts: BenchOptions,
  yieldFn: () => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<BenchSummary> {
  const mu = opts.mu ?? DEFAULT_MU;
  const rand = mulberry32(opts.seed);
  for (let i = 0; i < opts.warmupShots; i++) {
    simulateShot(rand, opts.now, opts.allBullets, mu);
    await yieldFn();
  }
  const results: ShotResult[] = [];
  for (let i = 0; i < opts.shots; i++) {
    results.push(simulateShot(rand, opts.now, opts.allBullets, mu));
    onProgress?.(i + 1, opts.shots);
    await yieldFn();
  }
  return summarize(results, opts.allBullets, mu);
}
