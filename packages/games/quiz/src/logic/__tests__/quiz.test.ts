import {
  deriveStream,
  liveViewers,
  mapSecrets,
  secret,
  seedFromInt,
  stableStringify,
} from '@gp/game-sdk/core';
import type { BotLevel, ModeManifest, Rng, Seat, SeatInfo, Viewer } from '@gp/game-sdk/core';
import {
  checkRedaction,
  contractSuite,
  defaultSimMatches,
  perturbOneSecret,
} from '@gp/game-sdk/testing';
import type { RedactionAdapter } from '@gp/game-sdk/testing';
import { describe, expect, it } from 'vitest';

import { pickQuestions, PRACTICE_PACK } from '../../content';
import {
  CATEGORIES,
  CATEGORY_MODE,
  configSchema,
  OPTIONS,
  pointsFor,
  QUESTION_MS,
  QUICK,
  quiz,
  speedBonus,
  standingsOf,
} from '../index';
import type {
  QuestionContent,
  QuizAction,
  QuizConfig,
  QuizEvent,
  QuizQuestion,
  QuizState,
} from '../index';

// ------------------------------------------------------------------ contract harness

/**
 * Perturbs one secret a viewer can't see: the correct option of any question, another seat's pick
 * (staying within its kind: option/pass ↔ option/pass, auto ↔ auto with the other roll), or the content
 * of a question (future questions must stay hidden until asked).
 */
const redaction: RedactionAdapter<QuizState> = perturbOneSecret((s, path, rng: Rng) => {
  const key = path[path.length - 1];
  const value = s.value;
  if (key === 'answerIdx' && typeof value === 'number')
    return rng.pick(OPTIONS.filter((o) => o !== value));
  if (key === 'pick') {
    const pick = value as QuizAction;
    if (pick.type === 'auto') return { ...pick, correct: !pick.correct };
    const all: QuizAction[] = [
      ...OPTIONS.map((choice): QuizAction => ({ type: 'answer', choice })),
      { type: 'pass' },
    ];
    return rng.pick(all.filter((a) => stableStringify(a) !== stableStringify(pick)));
  }
  if (key === 'content') {
    const content = value as QuestionContent;
    return {
      ...content,
      prompt: `${content.prompt} (alt)`,
      options: [...content.options].reverse(),
    };
  }
  return undefined;
});

const config = (mode: ModeManifest, rng: Rng): QuizConfig => {
  const category = mode.id === CATEGORY_MODE ? rng.pick(CATEGORIES) : null;
  return {
    category,
    questions: pickQuestions(PRACTICE_PACK, {
      mode: mode.id,
      category,
      count: rng.int(3, 10),
      seed: rng.nextU32(),
    }),
  };
};

/** The module with every mode fixed to `seats` seats; `allBots` makes every seat a bot seat in the
 *  module (so the all-human random walks also exercise `auto` answers and "thinking" bots). */
function variant(seats: number, allBots = false): typeof quiz {
  return {
    ...quiz,
    manifest: {
      ...quiz.manifest,
      id: `quiz-${seats}${allBots ? '-bots' : ''}`,
      modes: quiz.manifest.modes.map((m) => ({ ...m, seats: { min: seats, max: seats } })),
    },
    init: allBots
      ? (ctx) =>
          quiz.init({
            ...ctx,
            seats: ctx.seats.map((s): SeatInfo => ({
              ...s,
              occupant: { kind: 'bot', level: 'medium' },
            })),
          })
      : quiz.init,
  };
}

// One action or timeout per seat per question, at most 10 questions. The 8-seat and all-bot-seat walks
// check 9 and 5 viewers per state, so they use fewer non-interference walks to keep the suite quick.
// 8-seat matches are long: cap the CI simulation count (1,000) at 300 to keep the suite near a minute.
const sims = Math.min(defaultSimMatches(), 300);

contractSuite({
  module: variant(2),
  maxActions: 2 * 10,
  redaction,
  config,
  budget: false,
  matches: sims,
});
contractSuite({
  module: variant(8),
  maxActions: 8 * 10,
  redaction,
  config,
  redactionWalks: 10,
  matches: sims,
});
contractSuite({
  module: variant(4, true),
  maxActions: 4 * 10,
  redaction,
  config,
  redactionWalks: 16,
  budget: false,
  matches: sims,
});

// ------------------------------------------------------------------ direct driver

const rng = (): Rng => deriveStream(seedFromInt(11), 'game');

function seatsOf(count: number, bots: Partial<Record<Seat, BotLevel>> = {}): SeatInfo[] {
  return Array.from({ length: count }, (_, seat) => {
    const level = bots[seat];
    return {
      seat,
      team: null,
      occupant: level ? { kind: 'bot', level } : { kind: 'human', userId: `u${seat}` },
    };
  });
}

function question(i: number, answerIdx: number): QuizQuestion {
  return {
    id: `q${i}`,
    category: 'general',
    difficulty: 2,
    prompt: `Question ${i}?`,
    options: ['A', 'B', 'C', 'D'],
    answerIdx,
  };
}

/** Drives the module directly: actions are validated, timed phases are ticked until a seat is awaited. */
class Match {
  state: QuizState;
  events: QuizEvent[] = [];
  now = 0;

  constructor(answers: number[], seatCount = 2, bots: Partial<Record<Seat, BotLevel>> = {}) {
    const cfg = configSchema.parse({
      category: null,
      questions: answers.map((a, i) => question(i, a)),
    });
    this.state = quiz.init({
      config: cfg,
      mode: QUICK,
      seats: seatsOf(seatCount, bots),
      rng: rng(),
      now: 0,
    });
    this.check();
    this.settle();
  }

  /** Moves the clock to `ms` after the current question opened. */
  at(ms: number): this {
    this.now = (this.state.startedAt ?? 0) + ms;
    return this;
  }

  /** Applies an action without settling. */
  raw(seat: Seat, action: QuizAction): this {
    const verdict = quiz.validate(this.state, action, seat);
    if (!verdict.ok) throw new Error(`rejected: ${verdict.reason}`);
    const next = quiz.reduce(this.state, action, seat, { rng: rng(), now: this.now });
    this.state = next.state;
    this.events.push(...next.events);
    this.check();
    return this;
  }

  act(seat: Seat, action: QuizAction): this {
    return this.raw(seat, action).settle();
  }

  answer(seat: Seat, choice: 0 | 1 | 2 | 3, ms: number): this {
    return this.at(ms).act(seat, { type: 'answer', choice });
  }

  /** Lets the deadline lapse: every awaited seat gets its timeout move. */
  expire(): this {
    this.now = this.state.deadlineAt ?? this.now;
    for (const seat of quiz.awaiting(this.state).seats)
      this.raw(seat, quiz.onTimeout(this.state, seat, rng()));
    return this.settle();
  }

  tick(): this {
    const wake = quiz.wakeAt?.(this.state) ?? null;
    if (wake === null) throw new Error('nothing to tick');
    this.now = Math.max(this.now, wake);
    const next = quiz.tick?.(this.state, { rng: rng(), now: this.now });
    if (!next) throw new Error('no tick');
    this.state = next.state;
    this.events.push(...next.events);
    this.check();
    return this;
  }

  /** Ticks through intro, pending bot answers, locks and reveals until a seat is awaited or the end. */
  settle(): this {
    for (let i = 0; i < 20 && this.state.phase !== 'done'; i++) {
      if (quiz.awaiting(this.state).seats.length > 0) break;
      this.tick();
    }
    return this;
  }

  check(): void {
    expect(quiz.invariants?.(this.state) ?? []).toEqual([]);
  }

  view(viewer: Viewer) {
    return quiz.viewFor(this.state, viewer);
  }
}

const seatView = (seat: Seat): Viewer => ({ kind: 'seat', seat });

describe('scoring (D15)', () => {
  it('speed bonus falls linearly from 500 to 0 over 15 s', () => {
    expect(speedBonus(0)).toBe(500);
    expect(speedBonus(7_500)).toBe(250);
    expect(speedBonus(3_000)).toBe(400);
    expect(speedBonus(QUESTION_MS)).toBe(0);
    expect(speedBonus(-50)).toBe(500);
    expect(speedBonus(99_999)).toBe(0);
    expect(pointsFor(0, 0)).toBe(1_500);
    expect(pointsFor(QUESTION_MS, 0)).toBe(1_000);
    expect(pointsFor(7_500, 1)).toBe(1_375);
  });

  it('streak multiplier rises 0.1 per consecutive correct answer and caps at 1.5×', () => {
    const m = new Match([0, 0, 0, 0, 0, 0, 0]);
    for (let q = 0; q < 7; q++) m.answer(0, 0, 3_000).answer(1, 1, 1_000);
    expect(m.state.phase).toBe('done');
    expect(m.state.history.map((r) => r.points[0])).toEqual([
      1400, 1540, 1680, 1820, 1960, 2100, 2100,
    ]);
    expect(m.state.history.map((r) => r.points[1])).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(m.state.scores[0]).toBe(1400 + 1540 + 1680 + 1820 + 1960 + 2100 + 2100);
    expect(m.state.streaks).toEqual([7, 0]);
  });

  it('a wrong or missing answer scores 0 and resets the streak', () => {
    const m = new Match([0, 0, 0, 0, 0]);
    m.answer(0, 0, 3_000).answer(1, 0, 3_000);
    m.answer(0, 0, 3_000).answer(1, 0, 3_000);
    m.answer(0, 2, 3_000).answer(1, 0, 3_000);
    m.answer(1, 0, 3_000).expire(); // seat 0 runs out of time
    m.answer(0, 0, 3_000).at(4_000).act(1, { type: 'pass' });
    expect(m.state.history.map((r) => r.points[0])).toEqual([1400, 1540, 0, 0, 1400]);
    expect(m.state.history.map((r) => r.points[1])).toEqual([1400, 1540, 1680, 1820, 0]);
    expect(m.state.history.map((r) => r.streaks[0])).toEqual([1, 2, 0, 0, 1]);
  });

  it('ties break on lower total answer time (D16); full ties share a place', () => {
    const m = new Match([0, 0]);
    m.answer(0, 0, 0).answer(1, 1, 14_000); // seat 0: 1500 in 0 s; seat 1: wrong in 14 s
    m.answer(0, 1, 1_000).answer(1, 0, 0); //  seat 0: wrong in 1 s; seat 1: 1500 in 0 s
    expect(m.state.scores).toEqual([1500, 1500]);
    expect(m.state.answerTimeMs).toEqual([1_000, 14_000]);
    expect(quiz.result(m.state)?.placements).toEqual([
      { seat: 0, place: 1, score: 1500 },
      { seat: 1, place: 2, score: 1500 },
    ]);
    expect(standingsOf([10, 10, 5], [3, 3, 1], [1, 1, 1]).map((s) => [s.seat, s.place])).toEqual([
      [0, 1],
      [1, 1],
      [2, 3],
    ]);
  });

  it('missed and passed questions count the full 15 s towards the tie-break', () => {
    const m = new Match([2]);
    m.at(2_000).act(0, { type: 'pass' }).expire();
    expect(m.state.answerTimeMs).toEqual([QUESTION_MS, QUESTION_MS]);
    expect(quiz.result(m.state)?.placements.every((p) => p.place === 1)).toBe(true);
  });
});

describe('flow', () => {
  it('starts with an intro, then asks question 1 to every seat with a 15 s deadline', () => {
    const m = new Match([1, 2]);
    expect(m.events[0]).toMatchObject({ type: 'question' });
    expect(m.state.phase).toBe('question');
    expect(quiz.awaiting(m.state)).toEqual({
      seats: [0, 1],
      deadlineAt: m.state.startedAt! + QUESTION_MS,
    });
  });

  it('reveals as soon as everyone has answered', () => {
    const m = new Match([1, 2], 3);
    m.answer(0, 1, 1_000).answer(2, 1, 2_000);
    expect(m.state.phase).toBe('question');
    m.at(2_500).raw(1, { type: 'answer', choice: 0 });
    expect(m.state.phase).toBe('locked');
    expect(quiz.wakeAt?.(m.state)).toBe(m.now);
    m.tick();
    expect(m.state.phase).toBe('reveal');
    const reveal = m.view({ kind: 'spectator' }).reveal;
    expect(reveal).toMatchObject({
      correctIdx: 1,
      picks: [1, 0, 1],
      counts: [1, 2, 0, 0],
      unanswered: 0,
    });
    expect(reveal?.percents).toEqual([33, 67, 0, 0]);
    expect(reveal?.timesMs).toEqual([1_000, 2_500, 2_000]);
  });

  it('reveals on timeout with the missing seats as unanswered', () => {
    const m = new Match([3, 0]);
    m.answer(1, 3, 5_000);
    expect(quiz.awaiting(m.state).seats).toEqual([0]);
    m.expire();
    const reveal = m.state.history[0];
    expect(reveal).toMatchObject({ picks: [null, 3], timesMs: [null, 5_000], unanswered: 1 });
    expect(m.state.phase).toBe('question');
    expect(m.state.index).toBe(1);
  });

  it('ends after the last reveal pause with standings', () => {
    const m = new Match([0]);
    m.answer(0, 0, 0).at(0).raw(1, { type: 'answer', choice: 0 });
    m.tick(); // reveal
    expect(quiz.result(m.state)).toBeNull();
    m.tick(); // pause over
    expect(m.state.phase).toBe('done');
    expect(m.events[m.events.length - 1]).toMatchObject({ type: 'ended' });
    expect(quiz.result(m.state)?.placements).toEqual([
      { seat: 0, place: 1, score: 1500 },
      { seat: 1, place: 1, score: 1500 },
    ]);
  });

  it('rejects late, repeated and out-of-phase actions', () => {
    const m = new Match([0]);
    const answer: QuizAction = { type: 'answer', choice: 0 };
    m.answer(0, 0, 1_000);
    expect(quiz.validate(m.state, answer, 0)).toEqual({ ok: false, reason: 'ALREADY_ANSWERED' });
    expect(quiz.validate(m.state, answer, 5)).toEqual({ ok: false, reason: 'NOT_YOUR_TURN' });
    expect(quiz.validate(m.state, { type: 'auto', correct: true, thinkMs: 1_000 }, 1)).toEqual({
      ok: false,
      reason: 'BOT_ONLY',
    });
    m.answer(1, 0, 1_000);
    expect(m.state.phase).toBe('done');
    expect(quiz.validate(m.state, answer, 1)).toEqual({ ok: false, reason: 'FINISHED' });
  });
});

describe('bot answers (auto, resolved by the engine at the reveal)', () => {
  it('a "thinking" bot is hidden until its planned time, then resolved against the secret', () => {
    const m = new Match([2, 0], 2, { 1: 'hard' });
    expect(quiz.legalActions?.(m.state, 1)).toContainEqual({
      type: 'auto',
      correct: true,
      thinkMs: 6_000,
    });
    expect(quiz.legalActions?.(m.state, 0)?.some((a) => a.type === 'auto')).toBe(false);
    m.at(1_000).raw(1, { type: 'auto', correct: true, thinkMs: 6_000 });
    expect(quiz.awaiting(m.state).seats).toEqual([0]);
    expect(m.view(seatView(0)).answered).toEqual([false, false]);
    expect(m.view(seatView(1)).yourPick).toEqual({ type: 'auto', correct: true, thinkMs: 6_000 });
    expect(m.events.some((e) => e.type === 'answered')).toBe(false);
    m.at(2_000).raw(0, { type: 'answer', choice: 1 });
    expect(m.state.phase).toBe('question'); // the bot is still "thinking"
    expect(quiz.wakeAt?.(m.state)).toBe(m.state.startedAt! + 6_000);
    m.tick();
    expect(m.events[m.events.length - 2]).toEqual({ type: 'answered', seat: 1, choice: null });
    expect(m.state.phase).toBe('locked');
    m.tick();
    expect(m.state.history[0]).toMatchObject({
      correctIdx: 2,
      picks: [1, 2],
      timesMs: [2_000, 6_000],
    });
    expect(m.state.history[0]?.points[1]).toBe(pointsFor(6_000, 0));
  });

  it('a failed roll becomes a wrong option', () => {
    for (let seed = 0; seed < 20; seed++) {
      const m = new Match([seed % 4], 2, { 1: 'easy' });
      m.at(500).raw(1, { type: 'auto', correct: false, thinkMs: 0 }).answer(0, 0, 1_000);
      const pick = m.state.history[0]?.picks[1];
      expect(pick).not.toBeNull();
      expect(pick).not.toBe(seed % 4);
    }
  });
});

describe('redaction', () => {
  it("no viewer sees the answer or another seat's pick before the reveal", () => {
    const m = new Match([3, 1], 3, { 2: 'medium' });
    m.answer(0, 3, 1_000).at(1_200).raw(2, { type: 'auto', correct: true, thinkMs: 4_000 });
    const flipped = mapSecrets(m.state, (s, path) => {
      const key = path[path.length - 1];
      if (key === 'answerIdx') return secret(s.owner, 0);
      if (key === 'pick' && s.owner === 0) return secret(s.owner, { type: 'answer', choice: 1 });
      if (key === 'pick' && s.owner === 2)
        return secret(s.owner, { type: 'auto', correct: false, thinkMs: 4_000 });
      return s;
    });
    for (const viewer of [seatView(1), { kind: 'spectator' } as const]) {
      const view = quiz.viewFor(m.state, viewer);
      expect(stableStringify(view)).toBe(stableStringify(quiz.viewFor(flipped, viewer)));
      expect(JSON.stringify(view)).not.toMatch(/answerIdx|correctIdx|__secret|hidden/);
      expect(view.question).not.toHaveProperty('answerIdx');
      expect(view.yourPick).toBeNull();
    }
    for (const viewer of liveViewers(3)) {
      expect(JSON.stringify(quiz.viewFor(m.state, viewer))).not.toContain('Question 1?'); // future question
    }
    const answered: QuizEvent = { type: 'answered', seat: 0, choice: 3 };
    expect(quiz.eventFor(answered, seatView(0))).toEqual(answered);
    expect(quiz.eventFor(answered, seatView(1))).toEqual({
      type: 'answered',
      seat: 0,
      choice: null,
    });
    expect(quiz.eventFor(answered, { kind: 'spectator' })).toEqual({
      type: 'answered',
      seat: 0,
      choice: null,
    });
  });

  it("the harness catches a view that leaks another seat's pick", () => {
    const base = variant(2);
    const leaky: typeof quiz = {
      ...base,
      viewFor: (state, viewer) => ({
        ...base.viewFor(state, viewer),
        answered: state.answers.map(
          (slot) => slot?.pick.value.type === 'answer' && slot.pick.value.choice === 0,
        ),
      }),
    };
    const failures = checkRedaction({
      module: leaky,
      maxActions: 20,
      redaction,
      config,
      redactionWalks: 6,
    });
    expect(failures.some((f) => f.includes('LEAK'))).toBe(true);
  });
});
