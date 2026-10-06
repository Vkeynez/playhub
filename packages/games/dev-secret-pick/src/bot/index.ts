// Secret Pick bot. It sees only its own view, so it can't peek at the opponent's hidden pick.
// easy: random. medium: counter the opponent's most frequent past pick. hard: counter their last pick.

import type { BotLevel, Rng, Seat } from '@gp/game-sdk/core';

import { counter, PICKS } from '../logic/rules';
import type { PickAction, SecretPickView } from '../logic/rules';

export function choosePick(
  view: SecretPickView,
  seat: Seat,
  level: BotLevel,
  rng: Rng,
): PickAction {
  const theirs = view.history.map((round) => round.picks[1 - seat] ?? 1);
  if (level === 'easy' || theirs.length === 0) return { type: 'pick', value: rng.pick(PICKS) };
  if (level === 'hard') return { type: 'pick', value: counter(theirs[theirs.length - 1] ?? 1) };
  const counts = PICKS.map((value) => theirs.filter((t) => t === value).length);
  const top = Math.max(...counts);
  const favourites = PICKS.filter((_, i) => counts[i] === top);
  return { type: 'pick', value: counter(rng.pick(favourites)) };
}
