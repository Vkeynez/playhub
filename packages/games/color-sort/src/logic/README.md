# Color Sort Flow logic (`@gp/game-color-sort/logic`)

Pure TypeScript, integer-only. A solo **`SoloGameModule`** (`colorSort`) plus level, play and solver
functions. The manifest is `id: 'color-sort'`, shelf `relax`, `offlineCapable`, `logicVersion: 1`, with
one mode, `levels` (1 seat, no bots, no spectators). There is no server match and no `GameModule`. The
UI drives `PlayState` locally and pushes save events to the sync outbox.

## Board and rules

- A **tube** is `number[]` of colour ids, **bottom first**. Colour id = index into `PALETTE` (12 colours).
  `Board = { capacity, tubes }`. Every generated level has capacity 4.
- **Pour `from → to`** moves the contiguous top run of one colour. The target must be empty, or have
  the same top colour and free space. It moves the whole run, or as much of it as fits (a partial pour).
- **Win**: every tube is empty or full of one colour (`isSolved`).
- Refusal reasons (closed enum, map each to a shake or an i18n key): `BAD_TUBE`, `SAME_TUBE`,
  `EMPTY_SOURCE`, `TARGET_FULL`, `COLOR_MISMATCH`, plus `FINISHED` once the level is won.

## Levels (`generateLevel(n)`, OQ D28)

The level number seeds everything (SplitMix32 → xoshiro). Level N is the same board on every device and
engine; golden hashes are pinned in the tests. Each `Level` has:

`{ level, capacity: 4, colorCount, emptyTubes, tubes, par, parOptimal }`

- **Always solvable by construction.** Generation starts from the solved board and applies random legal
  _reverse_ pours: it mixes first, then compacts to the classic look of full tubes plus 1 or 2 empty
  spares. The reversed walk is a known solution, and the solver then confirms the level and sets `par`
  (a shortest solution for every level from 1 to 500). No level is pre-solved or a single move.
- **Curve** (`levelParams`):
  - colours: 3 at level 1, 4 from 4, 5 from 9, 6 from 16, 7 from 26, 8 from 41, 9 from 61, 10 from 86,
    11 from 121, and 12 from 171;
  - spare tubes: 2, but from level 30 every 5th level is a "tight" level with 1;
  - mixing rises with the level.

  Par goes from 4 (level 1) to about 7 (level 10), 12–18 (levels 50–100), and 22–31 (12 colours).

- **Cost:** `generateLevel` runs the solver and caches the last 8 levels. On V8, levels 1..500 take
  2.4 s in total; the slowest are L331 (92 ms) and L429 (42 ms), and most take under 5 ms. If you need
  the board before par, `scrambleLevel(n).tubes` takes about 3 ms.

## Playing a level (`PlayState`)

```ts
{ level, capacity, colorCount, par, start: number[][], tubes: number[][],
  history: PourRecord[] /* {from,to,color,amount} */, won }
```

| call                    | returns                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `startLevel(n)`         | a fresh attempt                                                                                     |
| `legalTargets(s, from)` | tube indices `from` can pour into (highlight these after the first tap)                             |
| `pourMove(s, from, to)` | `{ ok: true, state, pour: {from,to,color,amount}, completedTube, won }` or `{ ok: false, reason }`  |
| `undo(s)`               | exact take-back of the last pour (unlimited; the same object when there is no history)              |
| `restart(s)`            | the starting board, with the history cleared                                                        |
| `hint(s)`               | `{kind:'move', from, to, optimal, movesLeft}` · `{kind:'undo'}` (proven dead end) · `{kind:'none'}` |
| `moveCount(s)`          | `history.length` (undo lowers it)                                                                   |
| `resumeLevel(n, moves)` | rebuilds a saved attempt by replaying `{from,to}[]`; stops at the first illegal pour                |
| `starsFor(moves, par)`  | 3★ if moves ≤ par+2; 2★ if moves ≤ par+2+max(4, ⌊par/2⌋); otherwise 1★                              |

- **Animation:** use `pour.color` and `pour.amount` from the `pourMove` result to animate the stream.
  Celebrate when `completedTube` is set, and show the win screen when `won` is set.
- **Hint:** it runs A\* within a node budget (`HINT_NODE_BUDGET`) and returns the first pour of a
  _shortest_ solution from the current board, even after the player has wandered off. If the budget runs
  out, it uses a greedy search (`optimal: false`). It returns `undo` when the board can no longer be
  solved. Typical cost is under 5 ms; the worst case on the hardest level is 74 ms on V8, so expect a
  few hundred ms on Hermes. Run it off the gesture handler, and show a spinner if it takes longer than
  100 ms.
- **Colour-blind mode:** each `PALETTE[i]` is `{ id, key, nameKey, hex, symbol }`. The `symbol` values
  are unique: circle, square, triangle, diamond, star, heart, cross, plus, hexagon, moon, drop and bolt.
  Draw the symbol on every unit when `settings.colorBlind` is on. `nameKey` is
  `games.colorSort.colors.<key>`, for accessibility labels.

## Save (`saveVersion` 1) and events

```ts
ColorSortSave = {
  currentLevel: number;                                   // highest unlocked level      — max
  levels: { [n: string]: { bestMoves; stars: 1|2|3 } };   // completed levels            — bestMoves min, stars max
  settings: { value: { colorBlind; fastPour }, at: Stamp | null };            //          — lww
  board:    { value: { level; moves: {from,to}[] } | null, at: Stamp | null } // Continue — lww
}
Stamp = { wallMs, counter, deviceId }   // HLC (OQ E1); compared in that order
```

Events (`EventSchema`, discriminated on `type`, and valid as an outbox `type`). Use the builders in
`progress.ts`:

| event                                              | when (builder)                                                                                       | effect                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `{type:'board', board \| null, at}`                | after each pour, undo or restart: `boardEvent(s, at)` (null once won or after more than 2,000 pours) | LWW-writes the Continue board                                                               |
| `{type:'level_complete', level, moves, stars, at}` | on `won`: `completeEvent(s, at)`                                                                     | min/max on the level record, unlocks `level + 1`, and clears the board if it was this level |
| `{type:'settings', settings, at}`                  | `settingsEvent(settings, at)`                                                                        | LWW-writes the settings                                                                     |

- `apply` (`applyEvent`) is pure and never throws. It ignores events for levels that are still locked.
- `mergeSaves(a, b)` applies `MERGE_RULES` field by field. It is idempotent, commutative and
  associative (property-tested).
- `resume(save)` drives the Continue row:
  - `{ label: 'games.colorSort.resume.continue', target: { level, inProgress: true } }`, which you
    rebuild with `resumeLevel(level, save.board.value.moves)`;
  - otherwise `{ label: 'games.colorSort.resume.next', target: { level: currentLevel, inProgress: false } }`;
  - otherwise `null` for a fresh save.

## i18n keys used

`games.colorSort.name`, `games.colorSort.modes.levels.name`, `games.colorSort.resume.continue`,
`games.colorSort.resume.next`, and `games.colorSort.colors.{red,orange,yellow,lime,green,teal,sky,blue,purple,pink,brown,grey}`.
