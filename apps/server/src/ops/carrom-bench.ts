// POST /ops/bench/carrom (ARCHITECTURE §5.4): the spike (d) planck shot benchmark, run in-process
// so it measures the real Render instance. Adapted from spikes/render-stress/src/carrom/carromBench.ts
// with the configuration the spike reported (all bullets, mu 0.18, seed 1) so numbers compare.
// This module is only ever loaded with a dynamic import(), which keeps planck off the boot path.
//
// Units: 1 world unit = 1 dm. Board 74 cm square, coin Ø 3.18 cm / 5.5 g, striker Ø 4.13 cm / 15 g,
// pocket Ø 4.45 cm. Coulomb-style board friction plus light linear damping, 60 Hz steps until every
// body rests or 8 s pass.

import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Box, Circle, World } from 'planck';
import type { Body } from 'planck';

export interface CarromBenchOptions {
  shots: number;
  warmupShots: number;
  seed: number;
}

export interface CarromBenchResult {
  shots: number;
  warmupShots: number;
  msPerShotP50: number;
  msPerShotP95: number;
  msPerShotMax: number;
  stepsPerShotMean: number;
  pocketedTotal: number;
  capped: number;
  /** Sum of the timed shots only (no warm-up, no yields between shots). */
  totalMs: number;
  /** Wall time of the whole request, including warm-up and event-loop yields. */
  wallMs: number;
}

const BOARD = 7.4;
const HALF = BOARD / 2;
const COIN_R = 0.159;
const STRIKER_R = 0.2065;
const POCKET_R = 0.2225;
const COIN_MASS = 0.0055;
const STRIKER_MASS = 0.015;
const MU = 0.18;
const G = 98.1; // dm/s²
const STEP = 1 / 60;
const MAX_STEPS = 8 * 60;
const REST_SPEED = 0.01; // 1 mm/s
const FRICTION_DV = MU * G * STEP;

interface ShotResult {
  ms: number;
  steps: number;
  pocketed: number;
  capped: boolean;
}

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

const density = (mass: number, radius: number): number => mass / (Math.PI * radius * radius);

/** 19 coins: the queen, a ring of 6 touching it, and a ring of 12 around that. */
function coinPositions(): { x: number; y: number }[] {
  const d = 2 * COIN_R + 0.002;
  const out = [{ x: 0, y: 0 }];
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

function buildWorld(): { world: World; bodies: Body[]; striker: Body } {
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

  const piece = (position: { x: number; y: number }, radius: number, mass: number): Body => {
    const body = world.createBody({
      type: 'dynamic',
      position,
      linearDamping: 0.3,
      angularDamping: 2,
      bullet: true,
    });
    body.createFixture({
      shape: new Circle(radius),
      density: density(mass, radius),
      friction: 0.15,
      restitution: 0.8,
    });
    return body;
  };

  const bodies = coinPositions().map((p) => piece(p, COIN_R, COIN_MASS));
  const striker = piece({ x: 0, y: -2.6 }, STRIKER_R, STRIKER_MASS);
  bodies.push(striker);
  return { world, bodies, striker };
}

/** Removes `mu·g·dt` of speed per step without ever reversing a body; returns the new speed. */
function applyBoardFriction(body: Body): number {
  const v = body.getLinearVelocity();
  const speed = Math.hypot(v.x, v.y);
  if (speed <= FRICTION_DV) {
    if (speed !== 0) body.setLinearVelocity({ x: 0, y: 0 });
    body.setAngularVelocity(0);
    return 0;
  }
  const k = (speed - FRICTION_DV) / speed;
  body.setLinearVelocity({ x: v.x * k, y: v.y * k });
  return speed - FRICTION_DV;
}

function inPocket(body: Body): boolean {
  const p = body.getPosition();
  return POCKETS.some((q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < POCKET_R * POCKET_R);
}

function simulateShot(rand: () => number): ShotResult {
  const { world, bodies, striker } = buildWorld();
  const sx = -2 + 4 * rand();
  striker.setPosition({ x: sx, y: -2.6 });
  const tx = (rand() - 0.5) * 1.0;
  const ty = (rand() - 0.5) * 1.0;
  const speed = 30 + 40 * rand(); // 3–7 m/s
  const dx = tx - sx;
  const dy = ty + 2.6;
  const len = Math.hypot(dx, dy);
  striker.setLinearVelocity({ x: (dx / len) * speed, y: (dy / len) * speed });

  const live = bodies.slice();
  let pocketed = 0;
  let steps = 0;
  const t0 = performance.now();
  while (steps < MAX_STEPS) {
    world.step(STEP, 8, 3);
    steps++;
    let moving = false;
    for (let i = live.length - 1; i >= 0; i--) {
      const body = live[i];
      if (!body) continue;
      if (inPocket(body)) {
        world.destroyBody(body);
        live.splice(i, 1);
        pocketed++;
        continue;
      }
      if (applyBoardFriction(body) > REST_SPEED) moving = true;
    }
    if (!moving) break;
  }
  return { ms: performance.now() - t0, steps, pocketed, capped: steps >= MAX_STEPS };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Runs the shots one by one, yielding to the event loop between shots so /health keeps
 * answering within Render's 5 s probe timeout even on 0.1 CPU.
 */
export async function runCarromBench(options: CarromBenchOptions): Promise<CarromBenchResult> {
  const started = performance.now();
  const rand = mulberry32(options.seed);
  for (let i = 0; i < options.warmupShots; i++) {
    simulateShot(rand);
    await yieldToLoop();
  }
  const results: ShotResult[] = [];
  for (let i = 0; i < options.shots; i++) {
    results.push(simulateShot(rand));
    await yieldToLoop();
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const totalSteps = results.reduce((sum, r) => sum + r.steps, 0);
  return {
    shots: results.length,
    warmupShots: options.warmupShots,
    msPerShotP50: round3(percentile(ms, 50)),
    msPerShotP95: round3(percentile(ms, 95)),
    msPerShotMax: round3(ms[ms.length - 1] ?? 0),
    stepsPerShotMean: round3(results.length > 0 ? totalSteps / results.length : 0),
    pocketedTotal: results.reduce((sum, r) => sum + r.pocketed, 0),
    capped: results.filter((r) => r.capped).length,
    totalMs: round3(ms.reduce((sum, x) => sum + x, 0)),
    wallMs: round3(performance.now() - started),
  };
}
