// Shared-value animation helpers: everything here runs on the UI thread once started (no per-frame
// React state). Timings are shared by the Skia arena and the RN overlays so they land together.
import { useEffect, useRef } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import {
  cancelAnimation,
  Easing,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import type { HandMotion } from './Hand';
import { poseFor } from './model';

/** The hands pump twice, then the fingers flick out: this is the moment of the reveal ("thunk"). */
export const REVEAL_AT_MS = 380;
/** Feedback text, particles and the wicket land just after the thunk. */
export const IMPACT_AT_MS = REVEAL_AT_MS + 40;

export function useHandMotion(): HandMotion {
  const thumb = useSharedValue(0);
  const index = useSharedValue(0);
  const middle = useSharedValue(0);
  const ring = useSharedValue(0);
  const pinky = useSharedValue(0);
  const lift = useSharedValue(0);
  const squash = useSharedValue(0);
  const ref = useRef<HandMotion | null>(null);
  ref.current ??= { thumb, index, middle, ring, pinky, lift, squash };
  return ref.current;
}

function fingerValues(m: HandMotion): SharedValue<number>[] {
  return [m.thumb, m.index, m.middle, m.ring, m.pinky];
}

/** Pump, pump, flick: the fingers spring out to `value` with a little overshoot. */
export function flickTo(m: HandMotion, value: number | null, reduceMotion: boolean): void {
  const pose = poseFor(value);
  const fingers = fingerValues(m);
  fingers.forEach((sv, i) => {
    cancelAnimation(sv);
    const target = pose[i] ?? 0;
    sv.value = reduceMotion
      ? withTiming(target, { duration: 120 })
      : withDelay(REVEAL_AT_MS, withSpring(target, { damping: 9, stiffness: 340, mass: 0.6 }));
  });
  cancelAnimation(m.lift);
  cancelAnimation(m.squash);
  if (reduceMotion) {
    m.lift.value = 0;
    m.squash.value = 0;
    return;
  }
  const beat = { duration: REVEAL_AT_MS / 4, easing: Easing.inOut(Easing.quad) };
  m.lift.value = withSequence(
    withTiming(-0.16, beat),
    withTiming(0.04, beat),
    withTiming(-0.13, beat),
    withTiming(0.03, beat),
    withSpring(0, { damping: 12, stiffness: 260 }),
  );
  m.squash.value = withDelay(
    REVEAL_AT_MS,
    withSequence(withTiming(1, { duration: 60 }), withTiming(0, { duration: 300 })),
  );
}

/** Back to a fist for the next delivery. */
export function toFist(m: HandMotion, reduceMotion: boolean): void {
  for (const sv of fingerValues(m)) {
    cancelAnimation(sv);
    sv.value = withTiming(0, { duration: reduceMotion ? 0 : 180 });
  }
  cancelAnimation(m.lift);
  m.lift.value = withTiming(0, { duration: 150 });
}

/**
 * 1 → 0 over the time left to `deadlineAt` (in `serverNow()` units). Freezes while paused and resumes
 * from the same point; snaps back to 0 when there is no deadline.
 */
export function useCountdown(
  deadlineAt: number | null,
  paused: boolean,
  serverNow: () => number,
): SharedValue<number> {
  const progress = useSharedValue(0);
  const span = useRef<{ deadlineAt: number; total: number } | null>(null);
  useEffect(() => {
    cancelAnimation(progress);
    if (deadlineAt === null) {
      span.current = null;
      progress.value = withTiming(0, { duration: 200 });
      return;
    }
    const remaining = Math.max(0, deadlineAt - serverNow());
    if (span.current?.deadlineAt !== deadlineAt) {
      span.current = { deadlineAt, total: remaining || 1 };
    }
    progress.value = Math.min(1, remaining / span.current.total);
    if (!paused) progress.value = withTiming(0, { duration: remaining, easing: Easing.linear });
  }, [deadlineAt, paused, progress, serverNow]);
  return progress;
}
