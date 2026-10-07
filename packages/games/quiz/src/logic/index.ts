// Quiz Battle GameModule (BUILD_BRIEF §7.4). All seats answer the same question simultaneously.
// Answers are Secret<QuizAction> owned by their seat and the correct option is Secret<'server'> until the
// reveal; question content stays Secret<'server'> until the question is asked. See README.md.

import { canSee, defineGame, isSecret, secret } from '@gp/game-sdk/core';
import type { Ctx, Rng, Seat, Step, Validation, Viewer } from '@gp/game-sdk/core';
import { z } from 'zod';

import { chooseAnswer } from '../bot';
import { manifest } from '../manifest';
import {
  CATEGORIES,
  INTRO_MS,
  MAX_QUESTIONS,
  MAX_THINK_MS,
  OPTION_COUNT,
  OPTIONS,
  pointsFor,
  QUESTION_MS,
  REVEAL_MS,
  standingsOf,
  THINK_OPTIONS,
  THINK_STEP_MS,
} from './rules';
import type {
  AnswerSlot,
  AskedQuestion,
  QuizAction,
  QuizConfig,
  QuizEvent,
  QuizQuestion,
  QuizRejection,
  QuizState,
  QuizView,
  RevealRecord,
} from './rules';

export * from './rules';
export { CATEGORY_MODE, manifest, QUICK } from '../manifest';

type QuizStep = Step<QuizState, QuizEvent>;

const optionSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

export const questionSchema: z.ZodType<QuizQuestion> = z.object({
  id: z.string().min(1).max(64),
  category: z.enum(CATEGORIES),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).length(OPTION_COUNT),
  answerIdx: z
    .number()
    .int()
    .min(0)
    .max(OPTION_COUNT - 1),
});

export const configSchema: z.ZodType<QuizConfig> = z
  .object({
    category: z.enum(CATEGORIES).nullable(),
    questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
  })
  .superRefine((config, issue) => {
    const ids = new Set(config.questions.map((q) => q.id));
    if (ids.size !== config.questions.length)
      issue.addIssue({ code: 'custom', message: 'question ids must be unique' });
    if (config.category !== null && config.questions.some((q) => q.category !== config.category))
      issue.addIssue({ code: 'custom', message: 'every question must be in the chosen category' });
  });

export const actionSchema: z.ZodType<QuizAction> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), choice: optionSchema }),
  z.object({ type: z.literal('pass') }),
  z.object({
    type: z.literal('auto'),
    correct: z.boolean(),
    thinkMs: z.number().int().min(0).max(MAX_THINK_MS).multipleOf(THINK_STEP_MS),
  }),
]);

function reject(reason: QuizRejection): Validation {
  return { ok: false, reason };
}

/** The option a pick ends up as at the reveal; null = no answer. Failed auto rolls draw a wrong option. */
function resolvePick(pick: QuizAction | null, correctIdx: number, rng: Rng): number | null {
  if (pick === null || pick.type === 'pass') return null;
  if (pick.type === 'answer') return pick.choice;
  if (pick.correct) return correctIdx;
  return rng.pick(OPTIONS.filter((o) => o !== correctIdx));
}

function ask(state: QuizState, index: number, now: number): QuizStep {
  const slot = state.questions[index];
  if (!slot) throw new Error(`quiz: no question ${index}`);
  const question: AskedQuestion = { ...slot.content.value, index };
  const deadlineAt = now + QUESTION_MS;
  return {
    state: {
      ...state,
      phase: 'question',
      index,
      current: question,
      startedAt: now,
      deadlineAt,
      wakeAt: null,
      answers: state.answers.map(() => null),
    },
    events: [{ type: 'question', question, startedAt: now, deadlineAt }],
  };
}

/** Locks the question (reveal due at once) when every seat's answer is in and shown. */
function lockIfComplete(state: QuizState, events: QuizEvent[], now: number): QuizStep {
  if (!state.answers.every((slot) => slot !== null && slot.shown)) return { state, events };
  return {
    state: { ...state, phase: 'locked', wakeAt: now },
    events: [...events, { type: 'locked', index: state.index }],
  };
}

function answeredEvent(seat: Seat, pick: QuizAction): QuizEvent {
  return { type: 'answered', seat, choice: pick.type === 'answer' ? pick.choice : null };
}

function reveal(state: QuizState, ctx: Ctx): QuizStep {
  const slot = state.questions[state.index];
  const startedAt = state.startedAt ?? 0;
  if (!slot) throw new Error(`quiz: no question ${state.index}`);
  const correctIdx = slot.answerIdx.value;
  const picks = state.answers.map((answer) =>
    resolvePick(answer?.pick.value ?? null, correctIdx, ctx.rng),
  );
  const timesMs = state.answers.map((answer, seat) =>
    answer && picks[seat] !== null
      ? Math.min(QUESTION_MS, Math.max(0, answer.at - startedAt))
      : null,
  );
  const points = picks.map((pick, seat) =>
    pick === correctIdx ? pointsFor(timesMs[seat] ?? QUESTION_MS, state.streaks[seat] ?? 0) : 0,
  );
  const streaks = picks.map((pick, seat) =>
    pick === correctIdx ? (state.streaks[seat] ?? 0) + 1 : 0,
  );
  const counts = OPTIONS.map((o) => picks.filter((pick) => pick === o).length);
  const record: RevealRecord = {
    index: state.index,
    questionId: state.current?.id ?? '',
    correctIdx,
    picks,
    timesMs,
    points,
    streaks,
    counts,
    percents: counts.map((count) => Math.round((count * 100) / state.seatCount)),
    unanswered: picks.filter((pick) => pick === null).length,
  };
  return {
    state: {
      ...state,
      phase: 'reveal',
      wakeAt: ctx.now + REVEAL_MS,
      answers: state.answers.map(() => null),
      scores: state.scores.map((score, seat) => score + (points[seat] ?? 0)),
      streaks,
      correct: state.correct.map((c, seat) => c + (picks[seat] === correctIdx ? 1 : 0)),
      answerTimeMs: state.answerTimeMs.map((t, seat) => t + (timesMs[seat] ?? QUESTION_MS)),
      history: [...state.history, record],
    },
    events: [{ type: 'reveal', reveal: record }],
  };
}

function pendingWake(state: QuizState): number | null {
  let wake: number | null = null;
  for (const slot of state.answers) {
    if (slot && !slot.shown && (wake === null || slot.at < wake)) wake = slot.at;
  }
  return wake;
}

function viewFor(state: QuizState, viewer: Viewer): QuizView {
  const you = viewer.kind === 'seat' ? viewer.seat : null;
  const own = you === null ? null : (state.answers[you] ?? null);
  const settled = state.phase === 'reveal' || state.phase === 'done';
  return {
    you,
    mode: state.mode,
    category: state.category,
    phase: state.phase,
    seatCount: state.seatCount,
    questionCount: state.questions.length,
    index: state.index,
    rules: { questionMs: QUESTION_MS, revealMs: REVEAL_MS, introMs: INTRO_MS },
    question: state.current ? { ...state.current, options: [...state.current.options] } : null,
    startedAt: state.startedAt,
    deadlineAt: state.deadlineAt,
    answered: state.answers.map((slot) => slot !== null && slot.shown),
    yourPick: own && canSee(own.pick, viewer) ? { ...own.pick.value } : null,
    canAuto: you !== null && state.botSeats[you] === true,
    reveal: settled ? (state.history[state.history.length - 1] ?? null) : null,
    scores: [...state.scores],
    streaks: [...state.streaks],
    correct: [...state.correct],
    answerTimeMs: [...state.answerTimeMs],
    standings: standingsOf(state.scores, state.answerTimeMs, state.correct),
    history: state.history,
  };
}

function invariants(state: QuizState): string[] {
  const issues: string[] = [];
  const n = state.seatCount;
  for (const [name, list] of Object.entries({
    botSeats: state.botSeats,
    answers: state.answers,
    scores: state.scores,
    streaks: state.streaks,
    correct: state.correct,
    answerTimeMs: state.answerTimeMs,
  })) {
    if (list.length !== n) issues.push(`${name} has ${list.length} entries for ${n} seats`);
  }
  state.questions.forEach((q, i) => {
    if (!isSecret(q.content) || q.content.owner !== 'server')
      issues.push(`question ${i} content must be a server secret`);
    if (!isSecret(q.answerIdx) || q.answerIdx.owner !== 'server')
      issues.push(`question ${i} answer must be a server secret`);
    else if (
      !Number.isInteger(q.answerIdx.value) ||
      q.answerIdx.value < 0 ||
      q.answerIdx.value >= OPTION_COUNT
    )
      issues.push(`question ${i} answer out of range`);
  });
  const asking = state.phase === 'question' || state.phase === 'locked';
  const expectedHistory = state.phase === 'intro' ? 0 : asking ? state.index : state.index + 1;
  if (state.history.length !== expectedHistory)
    issues.push(
      `history has ${state.history.length} entries in ${state.phase} at index ${state.index}`,
    );
  if (state.index < 0 || state.index >= state.questions.length) issues.push('index out of range');
  if (state.phase !== 'intro' && state.current?.index !== state.index)
    issues.push('current question does not match index');
  if (asking && (state.startedAt === null || state.deadlineAt !== state.startedAt + QUESTION_MS))
    issues.push('question without a start or a deadline');
  if (state.phase !== 'question' && state.wakeAt === null && state.phase !== 'done')
    issues.push(`${state.phase} without a wake time`);
  if (state.phase === 'done' && state.history.length !== state.questions.length)
    issues.push('done before every question was revealed');
  state.answers.forEach((slot, seat) => {
    if (slot === null) return;
    if (!asking) issues.push(`seat ${seat} has an answer outside a question`);
    if (!isSecret(slot.pick) || slot.pick.owner !== seat)
      issues.push(`seat ${seat}'s answer must be a Secret owned by seat ${seat}`);
    if (slot.pick.value.type === 'auto' && !state.botSeats[seat])
      issues.push(`seat ${seat} is not a bot but answered auto`);
    if (!slot.shown && slot.pick.value.type !== 'auto')
      issues.push(`seat ${seat} has a hidden non-auto answer`);
    if (state.startedAt !== null && slot.at < state.startedAt)
      issues.push(`seat ${seat} answered before the question opened`);
  });
  if (state.phase === 'locked' && !state.answers.every((slot) => slot !== null && slot.shown))
    issues.push('locked with a missing answer');
  for (let seat = 0; seat < n; seat++) {
    const own = state.history;
    const sum = own.reduce((total, r) => total + (r.points[seat] ?? 0), 0);
    if (sum !== state.scores[seat]) issues.push(`scores[${seat}] disagrees with history`);
    const right = own.filter((r) => r.picks[seat] === r.correctIdx).length;
    if (right !== state.correct[seat]) issues.push(`correct[${seat}] disagrees with history`);
    const last = own[own.length - 1];
    if ((last?.streaks[seat] ?? 0) !== state.streaks[seat])
      issues.push(`streaks[${seat}] disagrees with history`);
  }
  return issues;
}

export const quiz = defineGame<QuizState, QuizAction, QuizConfig, QuizView, QuizEvent>({
  manifest,
  stateVersion: 1,
  configSchema,
  actionSchema,

  init({ config, mode, seats, now }) {
    const seatCount = seats.length;
    const botSeats = Array.from({ length: seatCount }, (_, seat) => {
      const info = seats.find((s) => s.seat === seat);
      return info?.occupant.kind === 'bot';
    });
    return {
      mode,
      category: config.category,
      seatCount,
      botSeats,
      phase: 'intro',
      questions: config.questions.map((q) => ({
        content: secret('server', {
          id: q.id,
          category: q.category,
          difficulty: q.difficulty,
          prompt: q.prompt,
          options: [...q.options],
        }),
        answerIdx: secret('server', q.answerIdx),
      })),
      index: 0,
      current: null,
      startedAt: null,
      deadlineAt: null,
      wakeAt: now + INTRO_MS,
      answers: botSeats.map(() => null),
      scores: botSeats.map(() => 0),
      streaks: botSeats.map(() => 0),
      correct: botSeats.map(() => 0),
      answerTimeMs: botSeats.map(() => 0),
      history: [],
    };
  },

  awaiting(state) {
    if (state.phase !== 'question') return { seats: [], deadlineAt: null };
    const seats: Seat[] = [];
    state.answers.forEach((slot, seat) => {
      if (slot === null) seats.push(seat);
    });
    return { seats, deadlineAt: state.deadlineAt };
  },

  wakeAt(state) {
    if (state.phase === 'question') return pendingWake(state);
    return state.phase === 'done' ? null : state.wakeAt;
  },

  legalActions(state, seat) {
    if (state.phase !== 'question' || state.answers[seat] !== null || seat >= state.seatCount)
      return [];
    const actions: QuizAction[] = OPTIONS.map((choice) => ({ type: 'answer', choice }));
    actions.push({ type: 'pass' });
    if (state.botSeats[seat]) {
      for (const correct of [true, false])
        for (const thinkMs of THINK_OPTIONS) actions.push({ type: 'auto', correct, thinkMs });
    }
    return actions;
  },

  validate(state, action, seat) {
    if (state.phase === 'done') return reject('FINISHED');
    if (
      state.phase !== 'question' ||
      !Number.isInteger(seat) ||
      seat < 0 ||
      seat >= state.seatCount
    )
      return reject('NOT_YOUR_TURN');
    if (state.answers[seat] !== null) return reject('ALREADY_ANSWERED');
    if (action.type === 'answer' && !OPTIONS.includes(action.choice)) return reject('ILLEGAL');
    if (action.type === 'auto') {
      if (!state.botSeats[seat]) return reject('BOT_ONLY');
      if (!THINK_OPTIONS.includes(action.thinkMs)) return reject('ILLEGAL');
    }
    return { ok: true };
  },

  reduce(state, action, seat, ctx) {
    const startedAt = state.startedAt ?? ctx.now;
    const at = action.type === 'auto' ? Math.max(ctx.now, startedAt + action.thinkMs) : ctx.now;
    const shown = at <= ctx.now;
    const slot: AnswerSlot = { at, shown, pick: secret(seat, { ...action }) };
    const answers = state.answers.map((s, i) => (i === seat ? slot : s));
    const events: QuizEvent[] = shown ? [answeredEvent(seat, action)] : [];
    return lockIfComplete({ ...state, answers }, events, ctx.now);
  },

  tick(state, ctx) {
    switch (state.phase) {
      case 'intro':
        return ask(state, 0, ctx.now);
      case 'question': {
        // A "thinking" bot's answer becomes visible at its planned time.
        const events: QuizEvent[] = [];
        const answers = state.answers.map((slot, seat) => {
          if (!slot || slot.shown || slot.at > ctx.now) return slot;
          events.push(answeredEvent(seat, slot.pick.value));
          return { ...slot, shown: true };
        });
        return lockIfComplete({ ...state, answers }, events, ctx.now);
      }
      case 'locked':
        return reveal(state, ctx);
      case 'reveal': {
        const next = state.index + 1;
        if (next < state.questions.length) return ask(state, next, ctx.now);
        return {
          state: { ...state, phase: 'done', wakeAt: null },
          events: [
            {
              type: 'ended',
              standings: standingsOf(state.scores, state.answerTimeMs, state.correct),
            },
          ],
        };
      }
      case 'done':
        return { state, events: [] };
    }
  },

  onTimeout() {
    return { type: 'pass' };
  },

  result(state) {
    if (state.phase !== 'done') return null;
    const placements = standingsOf(state.scores, state.answerTimeMs, state.correct).map(
      ({ seat, place, score }) => ({ seat, place, score }),
    );
    return { placements: placements.sort((a, b) => a.seat - b.seat) };
  },

  viewFor,

  eventFor(event, viewer) {
    if (event.type === 'answered' && !(viewer.kind === 'seat' && viewer.seat === event.seat))
      return { ...event, choice: null };
    return event;
  },

  invariants,

  bot: { choose: chooseAnswer },
});
