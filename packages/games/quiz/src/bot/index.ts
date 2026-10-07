// Quiz Battle bot. It reads only its own view, which never carries the answer, so it can't peek.
//
// A bot seat (one that was a bot when the match began, `view.canAuto`) rolls its accuracy and its answer
// time on the bot stream and submits { type: 'auto', correct, thinkMs }. The ENGINE resolves it at the
// reveal: correct → the secret answer, otherwise a random wrong option from the game stream. Until
// `thinkMs` has passed the bot is shown as still thinking, and the speed bonus uses that time.
//
// A bot playing for a disconnected human (`canAuto` false; takeover, BUILD_BRIEF §6.4) may not use
// `auto`, so it guesses an option uniformly.
//
// easy:   ~45% correct, slow (≈5–13.5 s).
// medium: ~65% correct (≈3–10 s).
// hard:   ~85% correct, fast (≈1.5–6.5 s).
// Accuracy moves ±8 points with the question's difficulty (1 easier, 3 harder); a missed answer takes
// about a second longer (hesitation).

import type { BotLevel, Rng, Seat } from '@gp/game-sdk/core';

import { MAX_THINK_MS, OPTIONS, THINK_STEP_MS } from '../logic/rules';
import type { QuizAction, QuizView } from '../logic/rules';

export interface BotProfile {
  /** Chance of a correct answer on a difficulty-2 question. */
  accuracy: number;
  /** Answer time range (ms after the question opened); sampled as the mean of two uniforms. */
  thinkMs: { min: number; max: number };
}

export const BOT_PROFILES: Record<BotLevel, BotProfile> = {
  easy: { accuracy: 0.45, thinkMs: { min: 5_000, max: 13_500 } },
  medium: { accuracy: 0.65, thinkMs: { min: 3_000, max: 10_000 } },
  hard: { accuracy: 0.85, thinkMs: { min: 1_500, max: 6_500 } },
};

/** Accuracy shift per difficulty step away from 2. */
export const DIFFICULTY_SHIFT = 0.08;
/** Extra think time when the roll failed. */
export const MISS_HESITATION_MS = 1_000;

export function botAccuracy(level: BotLevel, difficulty: number): number {
  const raw = BOT_PROFILES[level].accuracy + (2 - difficulty) * DIFFICULTY_SHIFT;
  return Math.min(0.98, Math.max(0.05, raw));
}

/** A planned answer time, snapped to the THINK_STEP_MS grid that `auto` accepts. */
export function botThinkMs(level: BotLevel, correct: boolean, rng: Rng): number {
  const { min, max } = BOT_PROFILES[level].thinkMs;
  const raw =
    min + ((rng.float() + rng.float()) / 2) * (max - min) + (correct ? 0 : MISS_HESITATION_MS);
  const snapped = Math.round(raw / THINK_STEP_MS) * THINK_STEP_MS;
  return Math.min(MAX_THINK_MS, Math.max(0, snapped));
}

export function chooseAnswer(view: QuizView, _seat: Seat, level: BotLevel, rng: Rng): QuizAction {
  if (view.phase !== 'question' || view.question === null || view.yourPick !== null)
    return { type: 'pass' };
  if (!view.canAuto) return { type: 'answer', choice: rng.pick(OPTIONS) };
  const correct = rng.float() < botAccuracy(level, view.question.difficulty);
  return { type: 'auto', correct, thinkMs: botThinkMs(level, correct, rng) };
}
