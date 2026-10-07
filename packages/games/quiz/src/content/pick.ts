// Picks a match's questions from a pack (pure and seeded). Offline, the client calls this over
// PRACTICE_PACK and freezes the result into the match config; online, the server does the same over the
// Postgres bank (excluding questions any player saw in the last 7 days, OQ D20).

import { deriveStream, seedFromInt } from '@gp/game-sdk/core';
import type { Rng } from '@gp/game-sdk/core';

import { CATEGORY_MODE } from '../manifest';
import { OPTIONS, QUESTIONS_PER_MATCH } from '../logic/rules';
import type { Category, QuizQuestion } from '../logic/rules';

export interface PickOptions {
  /** 'quick' mixes categories round-robin; 'category' draws only from `category`. */
  mode: string;
  category?: Category | null;
  /** Default QUESTIONS_PER_MATCH. Fewer are returned when the pack runs out. */
  count?: number;
  /** Any 32-bit integer; the same inputs always give the same questions. */
  seed: number;
  /** Questions to avoid (recently seen). Used only after every other question has been taken. */
  excludeIds?: readonly string[];
  /** Shuffle each question's options (answerIdx follows). Default true. */
  shuffleOptions?: boolean;
}

/** Round-robin over categories in random order, each category's questions shuffled. */
function interleave<Q extends QuizQuestion>(questions: readonly Q[], rng: Rng): Q[] {
  const groups = new Map<Category, Q[]>();
  for (const question of questions) {
    const group = groups.get(question.category);
    if (group) group.push(question);
    else groups.set(question.category, [question]);
  }
  const order = rng
    .shuffle([...groups.keys()])
    .map((category) => rng.shuffle(groups.get(category) ?? []));
  const out: Q[] = [];
  for (let round = 0; out.length < questions.length; round++) {
    for (const group of order) {
      const question = group[round];
      if (question) out.push(question);
    }
  }
  return out;
}

function toConfigQuestion(question: QuizQuestion, rng: Rng, shuffle: boolean): QuizQuestion {
  const order: number[] = shuffle ? rng.shuffle(OPTIONS) : [...OPTIONS];
  return {
    id: question.id,
    category: question.category,
    difficulty: question.difficulty,
    prompt: question.prompt,
    options: order.map((i) => question.options[i] ?? ''),
    answerIdx: order.indexOf(question.answerIdx),
  };
}

/** The questions for one match, ready for QuizConfig.questions. */
export function pickQuestions(pack: readonly QuizQuestion[], options: PickOptions): QuizQuestion[] {
  const count = options.count ?? QUESTIONS_PER_MATCH;
  const rng = deriveStream(seedFromInt(options.seed >>> 0), 'game');
  const byCategory = options.mode === CATEGORY_MODE;
  if (byCategory && !options.category)
    throw new Error('pickQuestions: category mode needs a category');
  const pool = byCategory ? pack.filter((q) => q.category === options.category) : [...pack];
  const excluded = new Set(options.excludeIds ?? []);
  const fresh = pool.filter((q) => !excluded.has(q.id));
  const seen = pool.filter((q) => excluded.has(q.id));
  const order = (list: readonly QuizQuestion[]): QuizQuestion[] =>
    byCategory ? rng.shuffle(list) : interleave(list, rng);
  return [...order(fresh), ...order(seen)]
    .slice(0, Math.max(0, count))
    .map((q) => toConfigQuestion(q, rng, options.shuffleOptions ?? true));
}
