# Quiz Battle logic (`@gp/game-quiz/logic`)

Pure `GameModule` (`quiz`) for BUILD_BRIEF §7.4. Manifest id `quiz`, shelf `friends`, `offlineCapable`,
`logicVersion: 1`. Two modes, both 2–8 seats, 15 s per question, bots and spectators allowed:

- `quick` (`QUICK`): 10 questions from mixed categories.
- `category` (`CATEGORY_MODE`): 10 questions from the one category the host picks.

Categories (`CATEGORIES`): `cricket`, `cinema` (Indian cinema), `science`, `tech`, `general`,
`tamil-nadu`.

## Config (`QuizConfig`): the questions are frozen before init

```ts
{
  category: Category | null,   // category mode: the host's pick (every question must match); quick: null
  questions: QuizQuestion[],   // 1..20 (normally 10): { id, category, difficulty: 1|2|3, prompt,
                               //   options: [4 strings], answerIdx: 0..3 }
}
```

The host side chooses the questions and puts them in the config, so the module never does I/O
(ARCHITECTURE §3.4). Online, the server picks from Postgres (OQ D20: unseen by every player for 7 days)
and stores them in `matches.config`. Offline, call `pickQuestions(PRACTICE_PACK, { mode, category, seed,
excludeIds? })` from `@gp/game-quiz/content`. It is pure and seeded, mixes categories round-robin in
quick mode, uses excluded ids only once nothing else is left, and shuffles each question's options
(`answerIdx` follows the correct option). `configSchema` checks the 4 options, the answer range, unique
ids and the category match.

Inside the state, every question's content is `Secret<'server'>` until it is asked, and its `answerIdx` is
`Secret<'server'>` until its reveal. Views never carry a future question or an unrevealed answer.

## State machine (`view.phase`)

```
intro (3 s) → ( question → locked → reveal (4 s) )×N → done
```

| phase      | who acts (`view.answered` false) | ends                                                               |
| ---------- | -------------------------------- | ------------------------------------------------------------------ |
| `intro`    | nobody ("Get ready")             | 3 s, then question 1                                               |
| `question` | every seat, at the same time     | everyone's answer is in and shown, or the 15 s deadline (timeouts) |
| `locked`   | nobody                           | tick at once: the reveal                                           |
| `reveal`   | nobody (show `view.reveal`)      | 4 s pause, then the next question; after the last one, `done`      |
| `done`     | nobody                           | `view.standings` final; `result()` set                             |

A seat that misses the deadline gets `onTimeout` = `{ type: 'pass' }` (no answer). It counts towards AFK.
Timeouts reveal as soon as the last missing seat has been timed out.

## Actions (`QuizAction`)

| action                                                  | who                                         |
| ------------------------------------------------------- | ------------------------------------------- |
| `{ type: 'answer', choice: 0 \| 1 \| 2 \| 3 }`          | any seat that hasn't answered this question |
| `{ type: 'pass' }`                                      | any seat ("I don't know"); also the timeout |
| `{ type: 'auto', correct: boolean, thinkMs: 0..14500 }` | bot seats only (see Bot); `thinkMs` in 500s |

One answer per seat per question; it can't be changed. Rejections (closed): `FINISHED`, `NOT_YOUR_TURN`
(not in a question, or an unknown seat), `ALREADY_ANSWERED`, `BOT_ONLY` (`auto` from a seat that wasn't a
bot at the start), `ILLEGAL`.

## Scoring (OQ D15, D16)

- Correct: `round((1000 + speedBonus) × multiplier)`.
  - `speedBonus = round(500 × (15 s − t) / 15 s)`, where `t` is the time since the question opened.
  - `multiplier = 1.0 + 0.1 × (consecutive correct answers before this one)`, capped at ×1.5. So the
    1st correct answer in a row is ×1.0, the 2nd ×1.1 and the 6th onwards ×1.5.
- Wrong, passed or missed: 0 points, and the streak resets.
- Standings: score descending, then lower **total answer time** (D16). A passed or missed question
  counts the full 15 s, so not answering never wins a tie. Equal score and equal time share a place.
- Helpers: `speedBonus(t)`, `multiplierTenths(streakBefore)`, `pointsFor(t, streakBefore)`,
  `standingsOf(scores, answerTimeMs, correct)`.

## View (`QuizView`)

- `you` (null for spectators), `mode`, `category`, `phase`, `seatCount`, `questionCount`, `index`
  (0-based current question), `rules { questionMs, revealMs, introMs }`.
- `question`: `{ index, id, category, difficulty, prompt, options[4] }` once asked (null during the
  intro). It never contains the answer.
- `startedAt` / `deadlineAt`: game time. For the countdown ring use the engine meta's wall-clock
  `awaiting.deadlineAt`.
- `answered[seat]`: true once that seat's answer is in. Use it for the "answered" ticks around the
  avatars. Use this, **not** the engine meta's `awaiting`, which drops a "thinking" bot as soon as it has
  decided.
- `yourPick`: your own action for the current question (null until you answer). Highlight your option
  from it. Other seats' picks are never visible before the reveal.
- `canAuto`: true for bot seats (used by the bot).
- `reveal` (phases `reveal` and `done`): the current question's `RevealRecord`:
  - `correctIdx`;
  - `picks[seat]`: the option each seat ended with (null = passed or missed);
  - `timesMs[seat]`, `points[seat]` and `streaks[seat]` (after this question);
  - `counts[4]`, plus `percents[4]` (rounded % of all seats) for the bar chart;
  - `unanswered`.
- `scores[]`, `streaks[]`, `correct[]`, `answerTimeMs[]`, and `standings[]` (sorted
  `{ seat, place, score, correct, answerTimeMs }`). `history[]` holds every `RevealRecord`, for the
  result screen.

## Events (`QuizEvent`)

- `question`: `{ question, startedAt, deadlineAt }`.
- `answered`: `{ seat, choice }`. `choice` is your own option for your own seat, and null for everyone
  else, timeouts and passes.
- `locked`.
- `reveal`: `{ reveal: RevealRecord }`. Drive the reveal animation from this.
- `ended`: `{ standings }`.

The intro has no event: a match starts in `phase: 'intro'`.

## Bot (`src/bot`): it never sees the answer

The view carries no answer, so the bot can't peek. Instead:

1. **A bot seat** (bot when the match began, `view.canAuto`) rolls on the **bot** stream:
   - whether it "knows" the answer: easy ≈45%, medium ≈65%, hard ≈85%, ±8 points per difficulty step
     away from 2;
   - an answer time: easy ≈5–13.5 s, medium ≈3–10 s, hard ≈1.5–6.5 s, +1 s when it doesn't know.

   It submits `{ type: 'auto', correct, thinkMs }`.

2. **The reducer** records the answer as counting at `startedAt + thinkMs`. Until then the seat is
   shown as still thinking: `answered` is false and no `answered` event is sent. A tick at that time
   flips it.
3. **At the reveal**, the engine resolves `auto` against the secret answer. If `correct`, the bot gets
   `answerIdx`. Otherwise it gets a uniformly random **wrong** option from the **game** stream, which
   is replay-deterministic.

**Takeover bots** play a human's seat after a disconnect (BUILD_BRIEF §6.4). They can't use `auto`, so
they guess an option uniformly at random.

**Note for the room layer:** `validate` only allows `auto` for seats that were bots at init. If a human
ever takes over a seat that started as a bot, the socket handler should also reject `type: 'auto'` from
human-controlled seats.

## Content (`@gp/game-quiz/content`)

`PRACTICE_PACK` is the offline pack (D18). It holds 60 original English questions, 10 per category,
each with a `source` note. Every question is `status: 'needs_review'` until it has been fact-checked
(D32). `PackQuestion` extends `QuizQuestion` with:

- `source`;
- `asOf?`: required for records and superlatives;
- `status`;
- `pack`.

The tests enforce the counts, the 4 distinct options, unique ids, and no stale wording ("current",
"latest", "record", and so on).

## i18n keys used by the manifest

`games.quiz.name`, `games.quiz.modes.quick.name` and `games.quiz.modes.category.name`. These aren't in
the client bundles yet.

Question text is English only. Tamil (D19, only approved translations) will need a per-question `ta`
variant chosen by the client.
