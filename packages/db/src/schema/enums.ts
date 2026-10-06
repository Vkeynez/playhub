import { pgEnum } from 'drizzle-orm/pg-core';

/*
 * Postgres enums. Values mirror `@gp/protocol` (this package doesn't depend on it); keep the two
 * in sync. Adding a value is an expand step (`ALTER TYPE … ADD VALUE`); never remove one.
 */

export const userKind = pgEnum('user_kind', ['guest', 'google']);

export const authProvider = pgEnum('auth_provider', ['google']);

export const platform = pgEnum('platform', ['android', 'web']);

export const gameShelf = pgEnum('game_shelf', ['friends', 'adventure', 'relax']);

/** Replaces the brief's `enabled` flag (ARCHITECTURE §3.7, §9). */
export const gameStatus = pgEnum('game_status', ['live', 'coming_soon', 'disabled', 'dev']);

export const roomStatus = pgEnum('room_status', ['LOBBY', 'IN_PROGRESS', 'FINISHED', 'CLOSED']);

export const botLevel = pgEnum('bot_level', ['easy', 'medium', 'hard']);

/** Action-log entry kinds (ARCHITECTURE §3.3). */
export const matchActionKind = pgEnum('match_action_kind', [
  'action',
  'timeout',
  'tick',
  'effect',
  'clock',
]);

export const matchOutcome = pgEnum('match_outcome', ['win', 'loss', 'draw', 'abandoned']);

export const quizPack = pgEnum('quiz_pack', ['online', 'practice']);

export const quizQuestionStatus = pgEnum('quiz_question_status', [
  'approved',
  'needs_review',
  'retired',
]);

export const quizTextStatus = pgEnum('quiz_text_status', ['approved', 'needs_review']);
