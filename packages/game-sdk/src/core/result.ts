// Match results. Stored as matches.result (jsonb) and used for W/L stats.

import { z } from 'zod';

import type { Seat } from './types';

export interface Placement {
  seat: Seat;
  /** 1 = first. Seats that share a place tied; teammates share their team's place. */
  place: number;
  /** Game-specific score shown on the result screen, or null. */
  score: number | null;
}

/**
 * The outcome of a finished match: exactly one placement per seat.
 * Place 1 wins; if every seat has place 1, the match is a draw.
 * Abandoned matches (no human connected for 5 min) are decided by the room layer, not by a module.
 */
export interface MatchResult {
  placements: Placement[];
}

export const matchResultSchema = z.object({
  placements: z.array(
    z.object({
      seat: z.number().int().min(0),
      place: z.number().int().min(1),
      score: z.number().finite().nullable(),
    }),
  ),
});

/** Seats in first place. */
export function winners(result: MatchResult): Seat[] {
  return result.placements.filter((p) => p.place === 1).map((p) => p.seat);
}

export function isDraw(result: MatchResult): boolean {
  return result.placements.length > 1 && result.placements.every((p) => p.place === 1);
}

/**
 * Placements from scores with standard competition ranking (10, 10, 5 → 1, 1, 3).
 * `higherIsBetter` defaults to true.
 */
export function placementsFromScores(
  scores: readonly number[],
  higherIsBetter = true,
): Placement[] {
  return scores.map((score, seat) => {
    const better = scores.filter((other) =>
      higherIsBetter ? other > score : other < score,
    ).length;
    return { seat, place: better + 1, score };
  });
}

/** Problems with `result` for a match with `seatCount` seats; empty means valid. */
export function matchResultIssues(result: unknown, seatCount: number): string[] {
  const parsed = matchResultSchema.safeParse(result);
  if (!parsed.success) return [`result does not match MatchResult: ${parsed.error.message}`];
  const issues: string[] = [];
  const seen = new Set<number>();
  for (const p of parsed.data.placements) {
    if (p.seat >= seatCount) issues.push(`placement for unknown seat ${p.seat}`);
    if (seen.has(p.seat)) issues.push(`seat ${p.seat} placed twice`);
    seen.add(p.seat);
  }
  for (let seat = 0; seat < seatCount; seat++) {
    if (!seen.has(seat)) issues.push(`seat ${seat} has no placement`);
  }
  if (parsed.data.placements.length > 0 && !parsed.data.placements.some((p) => p.place === 1)) {
    issues.push('no seat has place 1');
  }
  return issues;
}
