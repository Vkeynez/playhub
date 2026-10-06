# Hand Cricket logic (`@gp/game-cricket/logic`)

Pure `GameModule` (`cricket`) for mode `hand-cricket` (2 seats, 5 s pick timer, bots, spectators,
`pauseOnDisconnect`). Config: `{ wickets: 1 | 2 | 3 (default 2), overs: 1 | 2 | 5 (default 2) }`.
Arcade Super Over (Phase 3) will be a second entry in `manifest.modes`, dispatched on `state.mode`.

## State machine (`view.phase`)

```
call → toss → toss-locked → toss-result → choose → innings-start (1)
  → ( ball → ball-locked → ball-result )*   until innings 1 is over
  → innings-start (2)
  → ( ball → ball-locked → ball-result )*   until all out / overs done / target passed
  → done                                    (the match-ending ball skips ball-result)
```

| phase           | who acts (`view.awaiting`)  | action                                          | ends                               |
| --------------- | --------------------------- | ----------------------------------------------- | ---------------------------------- |
| `call`          | seat 1 (the joiner)         | `{ type: 'call', call: 'odd' \| 'even' }`       | 10 s deadline                      |
| `toss`          | both, secretly              | `{ type: 'pick', value: 1..6 }`                 | both in, or 5 s deadline           |
| `toss-locked`   | nobody                      | —                                               | tick at once: both throws revealed |
| `toss-result`   | nobody (show `toss.throws`) | —                                               | 2 s pause                          |
| `choose`        | `toss.winner`               | `{ type: 'choose', decision: 'bat' \| 'bowl' }` | 10 s deadline                      |
| `innings-start` | nobody ("Target 23" splash) | —                                               | 2.5 s pause                        |
| `ball`          | both, secretly              | `{ type: 'pick', value: 1..6 }`                 | both in, or 5 s deadline           |
| `ball-locked`   | nobody                      | —                                               | tick at once: reveal + score       |
| `ball-result`   | nobody (animate `lastBall`) | —                                               | 1.6 s (runs) / 2.6 s (out) pause   |
| `done`          | nobody                      | —                                               | `outcome` set                      |

A lapsed deadline auto-plays a random legal action (game stream) and counts towards AFK. The final ball
goes straight to `done` (no `ball-result` pause): animate `lastBall` there too.

## Rules

Toss: sum of both throws; its parity vs seat 1's call decides; the winner bats or bowls. Each ball:
equal picks = batter OUT (0 runs); otherwise the batter scores their own pick (`'six'` when 6). 6 balls an
over, no extras. An innings ends on all wickets or all overs; innings 2 also ends the moment
`runs >= target` (target = innings 1 runs + 1). Higher total wins; equal totals draw (`winner: null`).

## View (`CricketView`)

- `you`: your seat, or null for spectators. `phase`, `rules { wickets, overs, ballsPerOver, pickMs }`.
- `deadlineAt` (game time) and `awaiting` (seats still to act). For the countdown ring use the engine
  meta's wall-clock `awaiting.deadlineAt`.
- `picks[seat]`: `null` = not picked yet, `{ hidden: true }` = picked (secret), number = your own pick.
  Use it for "opponent has picked" ticks. Opponent picks are never visible before the reveal.
- `toss { caller, call, throws (null until revealed), winner, decision }`.
- `innings[]`: `{ number, batter, bowler, runs, wickets, balls, target, sinceWicket, history: BallRecord[] }`.
- `current`: the innings in play: `{ number, batter, bowler, runs, wickets, balls, target, runsNeeded,
ballsLeft, wicketsLeft, over, thisOver: BallRecord[] }` (`thisOver` = revealed balls of the current over).
- `lastBall`: `{ innings, over, ball, batterPick, bowlerPick, outcome: 'out' | 'runs' | 'six', runs }`.
- `stats[seat]`: `{ runs, ballsFaced, sixes, ducks, wicketsTaken, ballsBowled, runsConceded }`.
- `outcome`: `{ winner: Seat | null, reason: 'chased' | 'defended' | 'tie', margin: { kind: 'runs' |
'wickets', value } | null }`.

## Events (`CricketEvent`)

`called`, `picked` (`value` is null for everyone but the picker), `toss`, `chose`, `innings-start`,
`ball` (the reveal: drive the animation from it), `innings-end`, `ended`.

## i18n keys used by the manifest

`games.cricket.name`, `games.cricket.modes.handCricket.name` (not yet in the client's en/ta bundles).

## Bot

`src/bot`: easy = uniform; medium = avoids the opponent's last pick (bowls at a batter who repeats);
hard = recency-weighted frequencies + 1st-order Markov model of the opponent's revealed picks.
