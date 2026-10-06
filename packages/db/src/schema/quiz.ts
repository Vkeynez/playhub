import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './columns';
import { quizPack, quizQuestionStatus, quizTextStatus } from './enums';
import { users } from './users';

/*
 * Quiz Battle content (ARCHITECTURE §9, OPEN_QUESTIONS D18–D20, D32). The online bank is loaded
 * through an admin import, never committed to a public repo (OPEN_QUESTIONS I12).
 */

export const quizQuestions = pgTable(
  'quiz_questions',
  {
    /** Stable id from the bank, e.g. `tn-0042`. */
    id: text('id').primaryKey(),
    category: text('category').notNull(),
    difficulty: smallint('difficulty').notNull(),
    answerIdx: smallint('answer_idx').notNull(),
    /** Source URL checked during fact-checking. */
    source: text('source').notNull(),
    /** Set on records and superlatives ("as of" a date). */
    asOf: date('as_of'),
    status: quizQuestionStatus('status').notNull().default('approved'),
    /** `practice` questions ship offline and never appear online. */
    pack: quizPack('pack').notNull().default('online'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('quiz_questions_pick_idx').on(t.pack, t.category, t.status),
    check('quiz_questions_difficulty_range', sql`${t.difficulty} BETWEEN 1 AND 3`),
    check('quiz_questions_answer_nonnegative', sql`${t.answerIdx} >= 0`),
  ],
);

/** Text per language. Only approved translations are shown; otherwise English (D19). */
export const quizQuestionText = pgTable(
  'quiz_question_text',
  {
    questionId: text('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'cascade' }),
    lang: text('lang').notNull(),
    prompt: text('prompt').notNull(),
    /** Exactly the answer options, as a JSON array of strings. */
    options: jsonb('options').notNull(),
    status: quizTextStatus('status').notNull().default('needs_review'),
  },
  (t) => [primaryKey({ name: 'quiz_question_text_pk', columns: [t.questionId, t.lang] })],
);

/** For the 7-day no-repeat pick (D20); pruned after 7 days. */
export const quizSeen = pgTable(
  'quiz_seen',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    questionId: text('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'cascade' }),
    seenAt: timestamptz('seen_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'quiz_seen_pk', columns: [t.userId, t.questionId] }),
    index('quiz_seen_seen_at_idx').on(t.seenAt),
  ],
);

/** One report per user per question; 3 reports move the question to `needs_review` (D32). */
export const quizReports = pgTable(
  'quiz_reports',
  {
    questionId: text('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'quiz_reports_pk', columns: [t.questionId, t.userId] })],
);
