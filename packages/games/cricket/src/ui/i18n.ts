// Hand Cricket UI strings. They live with the game and are merged into the client's i18next
// instance under `games.cricket.ui.*` when the UI chunk loads, so the shell bundle stays small and
// i18next's English fallback covers keys that are not translated yet.
import i18next from 'i18next';
import { useCallback, useSyncExternalStore } from 'react';

export const en = {
  you: 'You',
  bot: 'Bot',
  // Toss
  tossTitle: 'Toss',
  callPrompt: 'Call the toss',
  odd: 'Odd',
  even: 'Even',
  callWaiting: '{{name}} is calling the toss…',
  called: '{{name}} called {{call}}',
  tossThrow: 'Throw a number for the toss',
  tossSum: '{{a}} + {{b}} = {{sum}}, {{parity}}',
  tossWonYou: 'You won the toss!',
  tossWonThem: '{{name}} won the toss',
  choosePrompt: 'Bat or bowl first?',
  bat: 'Bat',
  bowl: 'Bowl',
  chooseWaiting: '{{name}} is choosing…',
  // Innings
  innings1: '1st innings',
  innings2: '2nd innings',
  inningsBreak: 'Innings break',
  youBatFirst: 'You bat first',
  youBowlFirst: 'You bowl first',
  youChase: 'You need {{target}} to win',
  theyChase: '{{name}} needs {{target}} to win',
  firstInningsScore: '{{name}} scored {{runs}}/{{wickets}}',
  roleBat: 'You’re batting',
  roleBowl: 'You’re bowling',
  hintBat: 'Pick 1–6 to score. Same number as the bowler and you’re out.',
  hintBowl: 'Guess the batter’s number to take a wicket.',
  pickNow: 'Pick a number!',
  lockedIn: 'Locked in {{value}}. Waiting for {{name}}…',
  oppPicked: '{{name}} has picked',
  oppThinking: '{{name}} is thinking…',
  // Scoreboard
  overs: 'Overs',
  oversOf: '{{done}} of {{total}}',
  target: 'Target {{target}}',
  need_one: 'Need {{count}} run',
  need_other: 'Need {{count}} runs',
  ballsLeft_one: 'from {{count}} ball',
  ballsLeft_other: 'from {{count}} balls',
  thisOver: 'This over',
  wicketShort: 'W',
  // Ball feedback
  out: 'OUT!',
  wicket: 'WICKET!',
  six: 'SIX!',
  four: 'FOUR!',
  runs_one: '{{count}} run',
  runs_other: '{{count}} runs',
  handsShow: '{{batter}} vs {{bowler}}',
  // Result
  resultTitle: 'Match over',
  wonByRuns_one: 'You won by {{count}} run!',
  wonByRuns_other: 'You won by {{count}} runs!',
  wonByWickets_one: 'You won by {{count}} wicket!',
  wonByWickets_other: 'You won by {{count}} wickets!',
  lostByRuns_one: '{{name}} won by {{count}} run',
  lostByRuns_other: '{{name}} won by {{count}} runs',
  lostByWickets_one: '{{name}} won by {{count}} wicket',
  lostByWickets_other: '{{name}} won by {{count}} wickets',
  tie: 'Match tied!',
  statRuns: 'Runs',
  statBalls: 'Balls faced',
  statSixes: 'Sixes',
  statWickets: 'Wickets taken',
  statDucks: 'Ducks',
  scoreLine: '{{runs}}/{{wickets}} ({{overs}} ov)',
  // Controls
  pickLabel: 'Pick {{value}}',
  keysHint: 'Keys: 1–6 to pick · ← → and Enter',
  keysHintCall: 'Keys: O odd · E even (or 1 · 2)',
  keysHintChoose: 'Keys: B or 1 bat · 2 bowl',
  handLabel: '{{name}} shows {{value}}',
  handFist: '{{name}}: fist, waiting',
} as const;

export type StringKey = keyof typeof en;
type BaseKey<K> = K extends `${infer B}_${'one' | 'other'}` ? B : K;
/** Keys as callers use them: plural forms (`need_one`, `need_other`) are asked for as `need`. */
export type UiKey = BaseKey<StringKey>;

/** Tamil. TODO(ta): translate; missing keys fall back to English through i18next. */
export const ta: Partial<Record<StringKey, string>> = {};

const NS = 'translation';
const PREFIX = 'games.cricket.ui';

let registered = false;

/** Merges the strings into the shell's i18next instance (idempotent). */
export function registerStrings(): void {
  if (registered) return;
  registered = true;
  i18next.addResourceBundle('en', NS, { games: { cricket: { ui: en } } }, true, false);
  i18next.addResourceBundle('ta', NS, { games: { cricket: { ui: ta } } }, true, false);
}

function subscribe(fn: () => void): () => void {
  i18next.on('languageChanged', fn);
  return () => i18next.off('languageChanged', fn);
}

const language = () => i18next.language;

export type Translate = (key: UiKey, options?: Record<string, string | number>) => string;

/** `t('need', { count: 3 })`: re-renders when the shell's language changes. */
export function useStrings(): Translate {
  registerStrings();
  const lang = useSyncExternalStore(subscribe, language, language);
  return useCallback<Translate>(
    (key, options) => i18next.t(`${PREFIX}.${key}`, { lng: lang, ...options }),
    [lang],
  );
}
