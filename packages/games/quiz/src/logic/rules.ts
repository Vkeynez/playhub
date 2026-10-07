// Quiz Battle rules and types (BUILD_BRIEF §7.4, OQ D15–D17, D20; ARCHITECTURE §3.4). Pure: no I/O,
// randomness or wall time here.
//
// The host side freezes the match's questions into the config before init (online: the server picks
// from Postgres; offline: pickQuestions() over the bundled practice pack), so the module never does I/O.
// Every seat answers the same question at the same time; the answer and each seat's pick stay secret
// until the reveal. Scoring (D15): correct = 1000 + a speed bonus of up to 500 that falls linearly over
// the 15 s question, × a streak multiplier (+0.1 per consecutive correct answer before this one, capped
// at ×1.5). Wrong or missing answers score 0 and reset the streak. Ties: lower total answer time (D16).

import type { Seat, Secret } from '@gp/game-sdk/core';

export const CATEGORIES = [
  'cricket',
  'cinema',
  'science',
  'tech',
  'general',
  'tamil-nadu',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const OPTION_COUNT = 4;
export const OPTIONS = [0, 1, 2, 3] as const;
export type OptionIdx = (typeof OPTIONS)[number];
export const DIFFICULTIES = [1, 2, 3] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Questions in a standard round (Quick and Category). Config may carry 1..MAX_QUESTIONS. */
export const QUESTIONS_PER_MATCH = 10;
export const MAX_QUESTIONS = 20;

/** Time to answer one question (game ms). */
export const QUESTION_MS = 15_000;
/** "Get ready" splash before the first question. */
export const INTRO_MS = 3_000;
/** How long a reveal (correct option, every pick, % per option) stays on screen. */
export const REVEAL_MS = 4_000;

export const BASE_POINTS = 1_000;
export const MAX_SPEED_BONUS = 500;
/** Streak multiplier in tenths: ×1.0 + 0.1 per consecutive correct answer before this one, max ×1.5. */
export const MULTIPLIER_BASE_TENTHS = 10;
export const MULTIPLIER_MAX_TENTHS = 15;

/** Bot think times are planned in steps of this size, from 0 up to MAX_THINK_MS. */
export const THINK_STEP_MS = 500;
export const MAX_THINK_MS = QUESTION_MS - THINK_STEP_MS;
export const THINK_OPTIONS: readonly number[] = Array.from(
  { length: MAX_THINK_MS / THINK_STEP_MS + 1 },
  (_, i) => i * THINK_STEP_MS,
);

/** One frozen question as it travels in the config (server-only; never in a view). */
export interface QuizQuestion {
  id: string;
  category: Category;
  difficulty: Difficulty;
  prompt: string;
  /** Exactly OPTION_COUNT options. */
  options: string[];
  answerIdx: number;
}

export interface QuizConfig {
  /** Category mode: the host's category (every question must match). Quick mode: null. */
  category: Category | null;
  /** The match's questions, frozen before init (ARCHITECTURE §3.4). */
  questions: QuizQuestion[];
}

/**
 * answer: lock in an option. pass: give up on this question (also the timeout auto-move).
 * auto: bot seats only. The bot rolled its accuracy on the bot stream without seeing the answer;
 * `correct` says whether the roll succeeded, and the reducer resolves it against the secret answer at
 * the reveal (a failed roll becomes a random wrong option drawn from the game stream). `thinkMs` is the
 * bot's planned answer time after the question opened; the answer stays invisible ("thinking") until
 * then, and that time is what the speed bonus uses.
 */
export type QuizAction =
  | { type: 'answer'; choice: OptionIdx }
  | { type: 'pass' }
  | { type: 'auto'; correct: boolean; thinkMs: number };

/**
 * intro: splash before question 1 · question: everyone answers in secret · locked: everyone is in,
 * reveal due at once · reveal: correct option, picks and % on screen · done: final standings.
 */
export type Phase = 'intro' | 'question' | 'locked' | 'reveal' | 'done';

/** What players see of a question once it is asked. */
export interface QuestionContent {
  id: string;
  category: Category;
  difficulty: Difficulty;
  prompt: string;
  options: string[];
}

/** A frozen question inside the state: everything is hidden until it is asked, the answer until the reveal. */
export interface QuestionSlot {
  content: Secret<QuestionContent>;
  answerIdx: Secret<number>;
}

export interface AskedQuestion extends QuestionContent {
  /** 0-based position in the match. */
  index: number;
}

export interface AnswerSlot {
  /** Game time the answer counts from (bots: question start + thinkMs, or later). */
  at: number;
  /** False while a bot's answer is still "thinking"; the seat is not shown as answered yet. */
  shown: boolean;
  pick: Secret<QuizAction>;
}

/** One revealed question. Everything here is public. */
export interface RevealRecord {
  index: number;
  questionId: string;
  correctIdx: number;
  /** The option each seat ended up with; null = passed or no answer. */
  picks: (number | null)[];
  /** How long each seat took (ms after the question opened); null = no answer. */
  timesMs: (number | null)[];
  points: number[];
  /** Streak after this question. */
  streaks: number[];
  /** Seats per option, and the same as a rounded % of all seats. */
  counts: number[];
  percents: number[];
  /** Seats that passed or ran out of time. */
  unanswered: number;
}

export interface Standing {
  seat: Seat;
  /** 1 = first; equal score and equal total answer time share a place. */
  place: number;
  score: number;
  correct: number;
  /** D16 tie-break: total answer time; a missed or passed question counts the full QUESTION_MS. */
  answerTimeMs: number;
}

export interface QuizState {
  mode: string;
  category: Category | null;
  seatCount: number;
  /** Seats that were bots when the match began; only they may submit `auto`. */
  botSeats: boolean[];
  phase: Phase;
  questions: QuestionSlot[];
  /** The current (or last) question's index. */
  index: number;
  /** Public copy of the current (or last) question once it is asked; null during the intro. */
  current: AskedQuestion | null;
  startedAt: number | null;
  deadlineAt: number | null;
  /** Wake time of intro, locked and reveal (the question phase wakes for pending bot answers). */
  wakeAt: number | null;
  answers: (AnswerSlot | null)[];
  scores: number[];
  streaks: number[];
  correct: number[];
  answerTimeMs: number[];
  history: RevealRecord[];
}

export type QuizRejection =
  'FINISHED' | 'NOT_YOUR_TURN' | 'ALREADY_ANSWERED' | 'BOT_ONLY' | 'ILLEGAL';

export interface QuizView {
  /** Your seat, or null for spectators and replays. */
  you: Seat | null;
  mode: string;
  category: Category | null;
  phase: Phase;
  seatCount: number;
  questionCount: number;
  index: number;
  rules: { questionMs: number; revealMs: number; introMs: number };
  /** The question on screen (prompt, 4 options); null during the intro. Never carries the answer. */
  question: AskedQuestion | null;
  startedAt: number | null;
  deadlineAt: number | null;
  /** Seats shown as answered for the current question (a "thinking" bot shows false). */
  answered: boolean[];
  /** Your own pick for the current question, or null. */
  yourPick: QuizAction | null;
  /** True for bot seats (used by the bot to choose `auto`). */
  canAuto: boolean;
  /** The current question's reveal (phases reveal and done), else null. */
  reveal: RevealRecord | null;
  scores: number[];
  streaks: number[];
  correct: number[];
  answerTimeMs: number[];
  standings: Standing[];
  history: RevealRecord[];
}

export type QuizEvent =
  | { type: 'question'; question: AskedQuestion; startedAt: number; deadlineAt: number }
  /** `choice` is the answering seat's own option, and null for everyone else. */
  | { type: 'answered'; seat: Seat; choice: number | null }
  | { type: 'locked'; index: number }
  | { type: 'reveal'; reveal: RevealRecord }
  | { type: 'ended'; standings: Standing[] };

// ------------------------------------------------------------------ scoring

/** Speed bonus for answering `timeMs` after the question opened: 500 at 0 s down to 0 at 15 s. */
export function speedBonus(timeMs: number): number {
  const t = Math.min(QUESTION_MS, Math.max(0, timeMs));
  return Math.round((MAX_SPEED_BONUS * (QUESTION_MS - t)) / QUESTION_MS);
}

/** Multiplier in tenths for a correct answer after `streakBefore` consecutive correct answers. */
export function multiplierTenths(streakBefore: number): number {
  return Math.min(MULTIPLIER_MAX_TENTHS, MULTIPLIER_BASE_TENTHS + Math.max(0, streakBefore));
}

/** Points for a correct answer (D15). Wrong or missing answers score 0. */
export function pointsFor(timeMs: number, streakBefore: number): number {
  return Math.round(((BASE_POINTS + speedBonus(timeMs)) * multiplierTenths(streakBefore)) / 10);
}

/** Standings: score descending, then total answer time ascending (D16); full ties share a place. */
export function standingsOf(
  scores: readonly number[],
  answerTimeMs: readonly number[],
  correct: readonly number[],
): Standing[] {
  const rows = scores.map((score, seat) => ({
    seat,
    score,
    correct: correct[seat] ?? 0,
    answerTimeMs: answerTimeMs[seat] ?? 0,
  }));
  const better = (a: (typeof rows)[number], b: (typeof rows)[number]): boolean =>
    a.score > b.score || (a.score === b.score && a.answerTimeMs < b.answerTimeMs);
  return rows
    .map((row) => ({ ...row, place: rows.filter((other) => better(other, row)).length + 1 }))
    .sort((a, b) => a.place - b.place || a.seat - b.seat);
}
