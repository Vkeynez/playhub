// dev-tictactoe UI: RN views + Reanimated (no Skia). Seat 0 is X (marigold), seat 1 is O (teal).
import type { PlaceAction, TicTacToeEvent, TicTacToeView } from '@gp/game-dev-tictactoe/logic';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';

import type { GameScreenProps } from '../../room/types';
import { colors, font, radius, space } from '../../ui/theme';
import { TimerBar } from '../shared/TimerBar';

type Props = GameScreenProps<TicTacToeView, PlaceAction, TicTacToeEvent>;

const MARK_COLOR = [colors.marigold, colors.teal] as const;
const MARK = ['X', 'O'] as const;

export function Screen({ view, meta, submit, serverNow }: Props) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const [pending, setPending] = useState<number | null>(null);
  const you = view.you ?? 0;
  const finished = meta.finished;
  const myTurn = !finished && view.turn === you;
  const boardSize = Math.max(198, Math.min(420, width - space.lg * 2, height - 260));
  const cellSize = Math.floor(boardSize / 3);

  useEffect(() => setPending(null), [view]);

  const place = (cell: number) => {
    if (!myTurn || pending !== null || view.board[cell] !== null) return;
    setPending(cell);
    void submit({ type: 'place', cell }).then((ack) => {
      if (!ack.ok) setPending(null);
    });
  };

  const status = finished
    ? ''
    : myTurn
      ? t('games.devTictactoe.yourTurn')
      : t('games.devTictactoe.botTurn');

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <View style={styles.players}>
          <PlayerBadge
            label={t('common.you')}
            mark={MARK[you] ?? 'X'}
            color={MARK_COLOR[you] ?? colors.marigold}
            active={myTurn}
          />
          <PlayerBadge
            label={t('common.bot')}
            mark={MARK[1 - you] ?? 'O'}
            color={MARK_COLOR[1 - you] ?? colors.teal}
            active={!finished && !myTurn}
          />
        </View>
        <Text style={styles.status} accessibilityLiveRegion="polite" testID="ttt-status">
          {status}
        </Text>
        <View style={{ width: boardSize }}>
          <TimerBar
            deadlineAt={meta.awaiting.deadlineAt}
            paused={meta.paused}
            serverNow={serverNow}
            color={myTurn ? colors.marigold : colors.teal}
          />
        </View>
      </View>

      <View style={[styles.board, { width: cellSize * 3 + 2, height: cellSize * 3 + 2 }]}>
        {view.board.map((owner, cell) => {
          const row = Math.floor(cell / 3);
          const col = cell % 3;
          const winning = view.winLine?.includes(cell) ?? false;
          const shown = owner ?? (pending === cell ? you : null);
          return (
            <Pressable
              key={cell}
              onPress={() => place(cell)}
              disabled={!myTurn || owner !== null}
              accessibilityRole="button"
              accessibilityLabel={t('games.devTictactoe.cell', {
                row: row + 1,
                col: col + 1,
                state: shown === null ? t('games.devTictactoe.empty') : MARK[shown],
              })}
              testID={`cell-${cell}`}
              style={({ pressed }) => [
                styles.cell,
                { width: cellSize, height: cellSize },
                col < 2 && styles.cellRight,
                row < 2 && styles.cellBottom,
                pressed && owner === null && myTurn && styles.cellPressed,
              ]}
            >
              {winning && <WinGlow color={MARK_COLOR[view.winner ?? 0] ?? colors.marigold} />}
              {shown !== null && (
                <Mark seat={shown} size={cellSize * 0.56} faded={owner === null} />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function PlayerBadge({
  label,
  mark,
  color,
  active,
}: {
  label: string;
  mark: string;
  color: string;
  active: boolean;
}) {
  return (
    <View
      style={[
        styles.badge,
        active && { borderColor: color, backgroundColor: 'rgba(255,255,255,0.06)' },
      ]}
    >
      <Text style={[styles.badgeMark, { color }]}>{mark}</Text>
      <Text style={styles.badgeLabel}>{label}</Text>
    </View>
  );
}

function Mark({ seat, size, faded }: { seat: number; size: number; faded: boolean }) {
  const color = MARK_COLOR[seat] ?? colors.marigold;
  const stroke = Math.max(6, size * 0.16);
  return (
    <Animated.View
      entering={ZoomIn.springify().damping(11).stiffness(260)}
      style={{ width: size, height: size, opacity: faded ? 0.5 : 1 }}
    >
      {seat === 0 ? (
        <>
          <View
            style={[
              styles.bar,
              {
                backgroundColor: color,
                height: stroke,
                borderRadius: stroke,
                top: (size - stroke) / 2,
                transform: [{ rotate: '45deg' }],
              },
            ]}
          />
          <View
            style={[
              styles.bar,
              {
                backgroundColor: color,
                height: stroke,
                borderRadius: stroke,
                top: (size - stroke) / 2,
                transform: [{ rotate: '-45deg' }],
              },
            ]}
          />
        </>
      ) : (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: stroke,
            borderColor: color,
          }}
        />
      )}
    </Animated.View>
  );
}

function WinGlow({ color }: { color: string }) {
  const pulse = useSharedValue(0.25);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(withTiming(0.55, { duration: 520 }), withTiming(0.25, { duration: 520 })),
      -1,
    );
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.glow, { backgroundColor: color }, style]}
    />
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
    padding: space.lg,
  },
  top: { alignItems: 'center', gap: space.md },
  players: { flexDirection: 'row', gap: space.md },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  badgeMark: { fontSize: font.heading, fontWeight: '900' },
  badgeLabel: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  status: { color: colors.textMuted, fontSize: font.body, minHeight: 22 },
  board: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: radius.lg,
    backgroundColor: 'rgba(22, 28, 46, 0.85)',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  cell: { alignItems: 'center', justifyContent: 'center' },
  cellRight: { borderRightWidth: 2, borderRightColor: colors.borderStrong },
  cellBottom: { borderBottomWidth: 2, borderBottomColor: colors.borderStrong },
  cellPressed: { backgroundColor: 'rgba(245, 168, 58, 0.10)' },
  bar: { position: 'absolute', left: 0, right: 0 },
  glow: { opacity: 0.3 },
});
