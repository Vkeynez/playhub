// A deadline bar driven on the UI thread (Reanimated): no React state per frame. It freezes while
// the room is paused and resumes from the same point.
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, radius } from '../../ui/theme';

interface TimerBarProps {
  deadlineAt: number | null;
  paused: boolean;
  serverNow(): number;
  color?: string;
}

export function TimerBar({
  deadlineAt,
  paused,
  serverNow,
  color = colors.marigold,
}: TimerBarProps) {
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
    if (span.current?.deadlineAt !== deadlineAt)
      span.current = { deadlineAt, total: remaining || 1 };
    progress.value = Math.min(1, remaining / span.current.total);
    if (!paused) progress.value = withTiming(0, { duration: remaining, easing: Easing.linear });
  }, [deadlineAt, paused, progress, serverNow]);

  const fill = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
  return (
    <View style={styles.track} aria-hidden>
      <Animated.View style={[styles.fill, { backgroundColor: color }, fill]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 236, 210, 0.08)',
    overflow: 'hidden',
    width: '100%',
  },
  fill: { height: '100%', borderRadius: radius.pill },
});
