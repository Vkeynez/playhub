# Ludo logic (`@gp/game-ludo/logic`)

Pure `GameModule` (`ludo`) for mode `classic`: 2–4 seats, 2v2 teams at 4 seats, 20 s turn timer,
bots, spectators, offline-capable. There is no hidden information: every viewer gets the same view
(only `you` differs), and `eventFor` passes every event through unchanged.

## Config (`LudoConfig`, all house rules default **on**, OQ D9)

| key                | default | effect                                                                            |
| ------------------ | ------- | --------------------------------------------------------------------------------- |
| `needSixToOpen`    | true    | a 6 brings a token out of base. Off: any roll opens a token onto its start square |
| `threeSixesCancel` | true    | a third 6 in a row is not played and ends the turn (earlier moves stand)          |
| `captureBonus`     | true    | a capture earns a bonus roll                                                      |
| `safeSquares`      | true    | start squares + 4 stars are safe. Off: no safe squares at all                     |
| `homeBonus`        | true    | a token reaching home earns a bonus roll                                          |
| `exactFinish`      | true    | home needs the exact roll. Off: an overshooting roll still reaches home           |
| `teams`            | false   | 2v2; applies only at exactly 4 seats (ignored for 2–3)                            |

Blockades (OQ D10) are not implemented: any number of tokens may share a square.

## Board

- 15×15 grid. Colours run clockwise: **red** (yard top-left), **green** (top-right), **yellow**
  (bottom-right), **blue** (bottom-left). Seats: 2 → red, yellow (opposite); 3 → red, green, yellow;
  4 → red, green, yellow, blue. In 2v2, partners sit opposite: seats 0 + 2 (team 0) and 1 + 3 (team 1).
- Main track: 52 squares, absolute index 0..51 clockwise. Colour `c` enters at its start square `13·c`
  (`START_SQUARES = [0, 13, 26, 39]`). Stars: `STAR_SQUARES = [8, 21, 34, 47]`.
  `SAFE_SQUARES` = both (use `view.safeSquares`, which is empty when the rule is off).
- Token **progress**: `-1` base, `0..50` main track (square `(13·c + p) % 52`), `51..55` the colour's
  home column (lane `0..4`), `56` home. A token turns into its column after progress 50 (the square two
  before its own start); it never passes its own start square again.
- Geometry helpers (pure, for the renderer): `TRACK_CELLS[square]`, `trackCell(square)`,
  `columnCell(colour, lane)`, `yardCell(colour, token)`, `homeCell(colour)` and
  `cellOf(colour, progress, token)`, all returning `{ row, col }` on the 15×15 grid (row 0 = top).
  Red's arm is the left arm: start `(6,1)`, column `(7,1)…(7,5)`, home `(7,6)`; other colours are
  quarter turns clockwise. Consecutive track cells are a king step apart (the arm corners are diagonal).

## State machine (`view.phase`)

```
roll ──roll──▶ move ──move──▶ roll (same seat: bonus) | roll (next seat) | done
  │              ▲
  └─ no legal move / third 6 ─▶ roll (next seat)
```

| phase  | who acts (`view.awaiting`) | action                          | notes                                                 |
| ------ | -------------------------- | ------------------------------- | ----------------------------------------------------- |
| `roll` | `view.turn`                | `{ type: 'roll' }` (no value)   | the engine rolls 1..6 with the game Rng               |
| `move` | `view.turn`                | `{ type: 'move', token: 0..3 }` | `token` indexes `view.controls`' tokens; `view.moves` |
| `done` | nobody                     | —                               | `places` / `winners` set                              |

- Each decision (roll or move) has its own 20 s deadline (`deadlineAt`, game time). A timeout rolls in
  `roll` and plays the hard bot's best move in `move`.
- After a roll with no legal move (even a 6) the turn passes at once (`turn-passed`, reason
  `no-move`). There is no pause phase: the UI plays the event queue in order (show the die, then pass).
- **Bonus rolls** don't stack: after a move the same seat rolls again if the roll was a 6, or the move
  captured (`captureBonus`), or a token reached home (`homeBonus`). Otherwise the turn passes clockwise.
- **Three sixes**: `sixes` counts consecutive 6s this turn; the third is cancelled (`turn-cancelled`).
- **Captures**: landing (final square only) on an unsafe track square sends every opponent token there
  back to base. Partners never capture each other. Tokens in the home column are untouchable.
- **Finishing**: a seat finishes when all 4 tokens are home (`finished` event with its finishing place).
  - Free-for-all: a finished seat leaves the rotation (no bonus roll); the match ends when one seat is
    left (2 seats: the first to finish wins). Places = finishing order, the last seat last.
  - Teams: a finished seat keeps its turns and rolls for and moves its partner's tokens
    (`view.controls` = partner). The match ends when both partners of a team are home: places
    `1` for that team, `2` for the other.
- Result: `placements[seat] = { place, score: tokens home }`.

## View (`LudoView`)

- `you` (seat or null), `mode`, `phase`, `rules` (the toggles), `teams`, `turnMs`.
- `turn`: seat to act; `controls`: whose tokens it moves; `awaiting`: `[turn]` (empty when done);
  `deadlineAt` (game time; use the engine meta's wall-clock deadline for the ring).
- `roll`: die value waiting to be moved (phase `move`), `lastRoll { seat, value }` (keep showing the die),
  `sixes`.
- `safeSquares`: safe absolute squares under the current rules.
- `seats[seat]`: `{ seat, colour, team, partner, start, tokens, inBase, home, progress (0..100 %),
finished, finishedAt, stats { rolls, sixes, captures, lost } }`.
  - `tokens[i]`: `{ token, progress, zone: 'base' | 'track' | 'column' | 'home', square (absolute track
index or null), lane (0..4 in the column or null) }`.
- `moves` (phase `move` only, for `turn`): `MoveOption { token, owner, from, to, path: Spot[], captures:
{ seat, token }[], opens, safe, entersColumn, reachesHome }`. Highlight `token` of `owner`; `path` lists
  every spot hopped, ending at the destination (opening: just the start square).
- `finished` (finishing order), `places` (per seat, when done), `winners`.

## Events (`LudoEvent`), in emission order per action

- `rolled { seat, value, sixes }` — animate the die to `value` (the server's value).
- `moved { seat, owner, token, from, to, path }` — hop square by square along `path`.
- `captured { seat, owner, victim, token, square }` — knock-back animation; the victim token is in base.
- `entered-home { seat, owner, token }`, `finished { seat, place }`.
- `bonus-roll { seat, reasons: ('six' | 'capture' | 'home')[] }` — "roll again".
- `turn-passed { from, to, reason: 'moved' | 'no-move' }`, `turn-cancelled { seat, to, reason:
'three-sixes' }`.
- `ended { places, winners }`.

Rejections (closed): `NOT_YOUR_TURN`, `FINISHED`, `ROLL_FIRST`, `ALREADY_ROLLED`, `ILLEGAL`.

## Bot (`src/bot`)

Reads only the view. Ranking: capture > reach safety (a vulnerable token onto a safe square) > enter the
home column / reach home > open a token > advance the furthest token. Hard counts safety only for a
threatened token and avoids landing 1..6 squares in front of an opponent; easy plays a random legal
move 40% of the time. Well under 1 ms a choice.
