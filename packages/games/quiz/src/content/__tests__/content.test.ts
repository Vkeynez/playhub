import { describe, expect, it } from 'vitest';

import {
  CATEGORIES,
  CATEGORY_MODE,
  configSchema,
  OPTION_COUNT,
  QUICK,
  questionSchema,
} from '../../logic';
import { pickQuestions, PRACTICE_PACK } from '../index';

/** Facts that go stale (BUILD_BRIEF §7.4). */
const STALE =
  /\b(current|currently|latest|newest|recent|recently|nowadays|today|this year|reigning|incumbent|present|record|records)\b/i;
/** Records and superlatives need an `asOf` year (OQ D32). */
const SUPERLATIVE =
  /\b(most|highest|lowest|largest|biggest|smallest|fastest|slowest|longest|shortest|tallest|oldest|youngest)\b/i;

describe('practice pack', () => {
  it('has 60 questions, 10 per category, with unique ids', () => {
    expect(PRACTICE_PACK).toHaveLength(60);
    for (const category of CATEGORIES)
      expect(PRACTICE_PACK.filter((q) => q.category === category)).toHaveLength(10);
    expect(new Set(PRACTICE_PACK.map((q) => q.id)).size).toBe(60);
  });

  it('every question is well formed, sourced and awaiting review', () => {
    for (const q of PRACTICE_PACK) {
      expect(questionSchema.safeParse(q).success, q.id).toBe(true);
      expect(q.options, q.id).toHaveLength(OPTION_COUNT);
      expect(new Set(q.options.map((o) => o.trim().toLowerCase())).size, q.id).toBe(OPTION_COUNT);
      expect(q.answerIdx >= 0 && q.answerIdx < OPTION_COUNT, q.id).toBe(true);
      expect([1, 2, 3]).toContain(q.difficulty);
      expect(q.source.trim().length, q.id).toBeGreaterThan(10);
      expect(q.status).toBe('needs_review');
      expect(q.pack).toBe('practice');
    }
  });

  it('avoids facts that go stale, and dates any superlative', () => {
    for (const q of PRACTICE_PACK) {
      const text = [q.prompt, ...q.options].join(' | ');
      expect(STALE.test(text), `${q.id}: ${text}`).toBe(false);
      if (SUPERLATIVE.test(text)) expect(q.asOf, `${q.id} needs asOf`).toBeTypeOf('number');
    }
  });

  it('spreads the correct option across positions', () => {
    for (let i = 0; i < OPTION_COUNT; i++)
      expect(PRACTICE_PACK.filter((q) => q.answerIdx === i).length).toBeGreaterThanOrEqual(10);
  });
});

describe('pickQuestions', () => {
  const byId = new Map(PRACTICE_PACK.map((q) => [q.id, q]));

  it('is deterministic per seed and valid as a config', () => {
    const a = pickQuestions(PRACTICE_PACK, { mode: QUICK, seed: 7 });
    expect(pickQuestions(PRACTICE_PACK, { mode: QUICK, seed: 7 })).toEqual(a);
    expect(pickQuestions(PRACTICE_PACK, { mode: QUICK, seed: 8 })).not.toEqual(a);
    expect(a).toHaveLength(10);
    expect(configSchema.safeParse({ category: null, questions: a }).success).toBe(true);
  });

  it('quick mode mixes every category; options are shuffled but the answer follows', () => {
    const picked = pickQuestions(PRACTICE_PACK, { mode: QUICK, seed: 3 });
    expect(new Set(picked.map((q) => q.category)).size).toBe(CATEGORIES.length);
    for (const q of picked) {
      const original = byId.get(q.id)!;
      expect(q.options[q.answerIdx]).toBe(original.options[original.answerIdx]);
      expect([...q.options].sort()).toEqual([...original.options].sort());
      expect(q).not.toHaveProperty('source');
    }
  });

  it('category mode draws only from the chosen category', () => {
    const picked = pickQuestions(PRACTICE_PACK, {
      mode: CATEGORY_MODE,
      category: 'tamil-nadu',
      seed: 9,
    });
    expect(picked).toHaveLength(10);
    expect(picked.every((q) => q.category === 'tamil-nadu')).toBe(true);
    expect(configSchema.safeParse({ category: 'tamil-nadu', questions: picked }).success).toBe(
      true,
    );
    expect(() => pickQuestions(PRACTICE_PACK, { mode: CATEGORY_MODE, seed: 1 })).toThrow();
  });

  it('prefers questions not in excludeIds and falls back to them only when it runs out', () => {
    const cricket = PRACTICE_PACK.filter((q) => q.category === 'cricket').map((q) => q.id);
    const excludeIds = cricket.slice(0, 6);
    const four = pickQuestions(PRACTICE_PACK, {
      mode: CATEGORY_MODE,
      category: 'cricket',
      count: 4,
      seed: 2,
      excludeIds,
    });
    expect(four.every((q) => !excludeIds.includes(q.id))).toBe(true);
    const ten = pickQuestions(PRACTICE_PACK, {
      mode: CATEGORY_MODE,
      category: 'cricket',
      count: 10,
      seed: 2,
      excludeIds,
    });
    expect(ten.slice(0, 4).every((q) => !excludeIds.includes(q.id))).toBe(true);
    expect(new Set(ten.map((q) => q.id)).size).toBe(10);
    const quick = pickQuestions(PRACTICE_PACK, {
      mode: QUICK,
      seed: 4,
      excludeIds: PRACTICE_PACK.slice(0, 50).map((q) => q.id),
    });
    expect(quick.every((q) => PRACTICE_PACK.slice(50).some((p) => p.id === q.id))).toBe(true);
  });

  it('can keep the original option order', () => {
    const [q] = pickQuestions(PRACTICE_PACK, {
      mode: CATEGORY_MODE,
      category: 'science',
      count: 1,
      seed: 5,
      shuffleOptions: false,
    });
    const original = byId.get(q!.id)!;
    expect(q!.options).toEqual(original.options);
    expect(q!.answerIdx).toBe(original.answerIdx);
  });
});
