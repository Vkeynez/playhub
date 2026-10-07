import { deriveStream, seedFromInt } from '@gp/game-sdk/core';
import type { BotLevel, Rng } from '@gp/game-sdk/core';
import { describe, expect, it } from 'vitest';

import { configSchema, QUICK, quiz, THINK_STEP_MS, MAX_THINK_MS } from '../../logic';
import type { QuizState, QuizView } from '../../logic';
import { botAccuracy, chooseAnswer } from '../index';

const LEVELS: BotLevel[] = ['easy', 'medium', 'hard'];

function questionView(canAuto: boolean, difficulty: 1 | 2 | 3 = 2): QuizView {
  const config = configSchema.parse({
    category: null,
    questions: [
      {
        id: 'q',
        category: 'tech',
        difficulty,
        prompt: 'P?',
        options: ['a', 'b', 'c', 'd'],
        answerIdx: 1,
      },
    ],
  });
  let state: QuizState = quiz.init({
    config,
    mode: QUICK,
    seats: [
      { seat: 0, team: null, occupant: { kind: 'human', userId: 'u' } },
      {
        seat: 1,
        team: null,
        occupant: canAuto ? { kind: 'bot', level: 'medium' } : { kind: 'human', userId: 'v' },
      },
    ],
    rng: deriveStream(seedFromInt(1), 'game'),
    now: 0,
  });
  state = quiz.tick!(state, { rng: deriveStream(seedFromInt(1), 'game'), now: 3_000 }).state;
  return quiz.viewFor(state, { kind: 'seat', seat: 1 });
}

function sample(
  level: BotLevel,
  n: number,
  view: QuizView,
): { accuracy: number; meanMs: number; times: number[] } {
  const rng: Rng = deriveStream(seedFromInt(42), 'bot');
  let correct = 0;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const action = chooseAnswer(view, 1, level, rng);
    if (action.type !== 'auto') throw new Error('bot seats answer auto');
    if (action.correct) correct++;
    times.push(action.thinkMs);
  }
  return { accuracy: correct / n, meanMs: times.reduce((a, b) => a + b, 0) / n, times };
}

describe('quiz bot', () => {
  it('hits its accuracy target per level (easy ~45%, medium ~65%, hard ~85%)', () => {
    const view = questionView(true);
    for (const [level, target] of [
      ['easy', 0.45],
      ['medium', 0.65],
      ['hard', 0.85],
    ] as const) {
      expect(Math.abs(sample(level, 4_000, view).accuracy - target)).toBeLessThan(0.03);
    }
  });

  it('answers faster as the level rises, on the think-time grid', () => {
    const view = questionView(true);
    const [easy, medium, hard] = LEVELS.map((level) => sample(level, 2_000, view));
    expect(easy!.meanMs).toBeGreaterThan(medium!.meanMs);
    expect(medium!.meanMs).toBeGreaterThan(hard!.meanMs);
    for (const s of [easy!, medium!, hard!]) {
      for (const t of s.times) {
        expect(t % THINK_STEP_MS).toBe(0);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(MAX_THINK_MS);
      }
    }
  });

  it('finds hard questions harder', () => {
    for (const level of LEVELS) expect(botAccuracy(level, 3)).toBeLessThan(botAccuracy(level, 1));
  });

  it('a takeover bot (human seat) may not use auto, so it guesses an option', () => {
    const view = questionView(false);
    const rng = deriveStream(seedFromInt(5), 'bot');
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const action = chooseAnswer(view, 1, 'hard', rng);
      expect(action.type).toBe('answer');
      if (action.type === 'answer') seen.add(action.choice);
    }
    expect(seen.size).toBe(4);
  });

  it('its view never carries the answer', () => {
    expect(JSON.stringify(questionView(true))).not.toMatch(/answerIdx|correctIdx/);
  });
});
