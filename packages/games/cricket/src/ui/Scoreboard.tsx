// Scoreboard: both sides' runs/wickets with odometer digits that tick forward (transform-only, on
// the UI thread), overs, the chase equation and the "this over" ball strip.
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';

import type { BallRecord } from '../logic/rules';
import type { Translate } from './i18n';
import type { Chase, TeamLine } from './model';
import { digitsOf } from './model';
import { colors, font, PICK_COLORS, radius, space } from './theme';

const DIGITS = Array.from({ length: 20 }, (_, i) => i % 10);

interface DigitProps {
  digit: number;
  size: number;
  color: string;
  delay: number;
  reduceMotion: boolean;
}

/** One odometer wheel: 0–9 twice, so a wrap (7 → 3) keeps rolling forward through 8, 9, 0. */
function Digit({ digit, size, color, delay, reduceMotion }: DigitProps) {
  const line = Math.round(size * 1.18);
  const pos = useSharedValue(digit);
  useEffect(() => {
    cancelAnimation(pos);
    const from = pos.value % 10;
    if (reduceMotion || from === digit) {
      pos.value = digit;
      return;
    }
    const target = digit > from ? digit : digit + 10;
    pos.value = from;
    pos.value = withDelay(
      delay,
      withTiming(target, { duration: 420, easing: Easing.out(Easing.back(1.4)) }, (done) => {
        if (done && target >= 10) pos.value = target - 10;
      }),
    );
  }, [digit, delay, reduceMotion, pos]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -pos.value * line }] }));
  return (
    <View style={{ height: line, overflow: 'hidden' }}>
      <Animated.View style={style}>
        {DIGITS.map((d, i) => (
          <Text
            key={i}
            style={[styles.digit, { fontSize: size, lineHeight: line, height: line, color }]}
          >
            {d}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}

interface OdometerProps {
  value: number;
  size: number;
  color: string;
  delay: number;
  reduceMotion: boolean;
  testID?: string;
}

export function Odometer({ value, size, color, delay, reduceMotion, testID }: OdometerProps) {
  const digits = digitsOf(value);
  return (
    <View style={styles.odometer} accessibilityLabel={String(value)} testID={testID}>
      {digits.map((d, i) => (
        <Digit
          key={digits.length - i}
          digit={d}
          size={size}
          color={color}
          delay={delay}
          reduceMotion={reduceMotion}
        />
      ))}
    </View>
  );
}

interface ScoreboardProps {
  t: Translate;
  home: TeamLine;
  away: TeamLine;
  homeName: string;
  awayName: string;
  oversText: string | null;
  totalOvers: number;
  chase: Chase | null;
  thisOver: readonly BallRecord[];
  ballsPerOver: number;
  /** Delay the tick so it lands with the reveal. */
  tickDelay: number;
  reduceMotion: boolean;
  compact: boolean;
}

export function Scoreboard(p: ScoreboardProps) {
  const size = p.compact ? 30 : 38;
  return (
    <View style={styles.board} testID="cr-scoreboard">
      <View style={styles.teams}>
        <Side
          line={p.home}
          name={p.homeName}
          accent={colors.cuffYou}
          size={size}
          delay={p.tickDelay}
          reduceMotion={p.reduceMotion}
          testID="cr-score-home"
          t={p.t}
        />
        <View style={styles.overs}>
          <Text style={styles.oversLabel}>{p.t('overs')}</Text>
          <Text style={styles.oversValue} testID="cr-overs">
            {p.oversText ?? '–'}
          </Text>
          <Text style={styles.oversTotal}>/ {p.totalOvers}</Text>
        </View>
        <Side
          line={p.away}
          name={p.awayName}
          accent={colors.cuffBot}
          size={size}
          delay={p.tickDelay}
          reduceMotion={p.reduceMotion}
          testID="cr-score-away"
          alignEnd
          t={p.t}
        />
      </View>
      <View style={styles.footer}>
        {p.chase ? (
          <Text style={styles.chase} testID="cr-chase" accessibilityLiveRegion="polite">
            <Text style={styles.target}>{p.t('target', { target: p.chase.target })}</Text>
            {'  ·  '}
            {p.t('need', { count: p.chase.runsNeeded })}{' '}
            {p.t('ballsLeft', { count: p.chase.ballsLeft })}
          </Text>
        ) : (
          <View />
        )}
        <OverStrip balls={p.thisOver} perOver={p.ballsPerOver} t={p.t} delay={p.tickDelay} />
      </View>
    </View>
  );
}

function Side({
  line,
  name,
  accent,
  size,
  delay,
  reduceMotion,
  testID,
  alignEnd = false,
  t,
}: {
  line: TeamLine;
  name: string;
  accent: string;
  size: number;
  delay: number;
  reduceMotion: boolean;
  testID: string;
  alignEnd?: boolean;
  t: Translate;
}) {
  const dim = !line.batted;
  return (
    <View style={[styles.side, alignEnd && styles.sideEnd]}>
      <View style={[styles.nameRow, alignEnd && styles.rowEnd]}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {line.batting && (
          <View style={[styles.batPill, { borderColor: accent }]}>
            <Text style={[styles.batText, { color: accent }]}>{t('bat')}</Text>
          </View>
        )}
      </View>
      <View style={[styles.scoreRow, alignEnd && styles.rowEnd, dim && styles.dim]} testID={testID}>
        <Odometer
          value={line.runs}
          size={size}
          color={colors.text}
          delay={delay}
          reduceMotion={reduceMotion}
        />
        <Text style={[styles.slash, { fontSize: size * 0.7 }]}>/</Text>
        <Odometer
          value={line.wickets}
          size={size * 0.7}
          color={colors.textMuted}
          delay={delay}
          reduceMotion={reduceMotion}
        />
      </View>
    </View>
  );
}

function OverStrip({
  balls,
  perOver,
  t,
  delay,
}: {
  balls: readonly BallRecord[];
  perOver: number;
  t: Translate;
  delay: number;
}) {
  const slots = Array.from({ length: perOver }, (_, i) => balls[i] ?? null);
  return (
    <View style={styles.strip} accessibilityLabel={t('thisOver')}>
      {slots.map((b, i) =>
        b ? (
          <Animated.View
            key={`${b.innings}.${b.over}.${b.ball}`}
            entering={ZoomIn.delay(delay).springify().damping(11)}
            style={[
              styles.slot,
              b.outcome === 'out'
                ? styles.slotOut
                : { backgroundColor: PICK_COLORS[b.runs] ?? colors.surfaceRaised },
            ]}
          >
            <Text style={[styles.slotText, b.outcome === 'out' && styles.slotTextOut]}>
              {b.outcome === 'out' ? t('wicketShort') : b.runs}
            </Text>
          </Animated.View>
        ) : (
          <View key={`e${i}`} style={[styles.slot, styles.slotEmpty]} />
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  board: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  teams: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  side: { flex: 1, gap: 2 },
  sideEnd: { alignItems: 'flex-end' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowEnd: { justifyContent: 'flex-end' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: colors.textMuted, fontSize: font.small, fontWeight: '800', flexShrink: 1 },
  batPill: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
  batText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  scoreRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  dim: { opacity: 0.45 },
  odometer: { flexDirection: 'row' },
  digit: { fontWeight: '900', textAlign: 'center', fontVariant: ['tabular-nums'] },
  slash: { color: colors.textDim, fontWeight: '800', marginBottom: 2 },
  overs: { alignItems: 'center', paddingHorizontal: space.sm, paddingBottom: 2 },
  oversLabel: { color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  oversValue: { color: colors.text, fontSize: font.heading, fontWeight: '900' },
  oversTotal: { color: colors.textDim, fontSize: font.tiny, fontWeight: '700' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chase: { color: colors.text, fontSize: font.small, fontWeight: '700', flexShrink: 1 },
  target: { color: colors.marigold, fontWeight: '900' },
  strip: { flexDirection: 'row', gap: 5, marginLeft: 'auto' },
  slot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotEmpty: { borderWidth: 1.5, borderColor: colors.borderStrong, borderStyle: 'dashed' },
  slotOut: { backgroundColor: colors.kumkum },
  slotText: { color: colors.ink, fontSize: font.tiny, fontWeight: '900' },
  slotTextOut: { color: colors.text },
});
