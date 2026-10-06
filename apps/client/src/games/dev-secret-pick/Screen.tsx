// dev-secret-pick UI: pick 1–3 in secret, both cards flip at the reveal, a Skia burst marks the
// round winner. Exercises hidden info (Hidden markers), deadlines and timed reveals.
import type { PickAction, SecretPickEvent, SecretPickView } from '@gp/game-dev-secret-pick/logic';
import { isHidden } from '@gp/game-sdk/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FlipInYLeft, ZoomIn } from 'react-native-reanimated';

import type { GameScreenProps } from '../../room/types';
import { colors, font, radius, space } from '../../ui/theme';
import { TimerBar } from '../shared/TimerBar';
import { Burst } from './Burst';

type Props = GameScreenProps<SecretPickView, PickAction, SecretPickEvent>;

const PICK_COLORS: Record<number, string> = {
  1: colors.terracotta,
  2: colors.marigold,
  3: colors.teal,
};

export function Screen({ view, meta, submit, serverNow }: Props) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const [pending, setPending] = useState<number | null>(null);
  const you = view.you ?? 0;
  const bot = 1 - you;
  const revealed =
    view.phase === 'shown' || view.phase === 'done'
      ? (view.history[view.history.length - 1] ?? null)
      : null;
  const myPick = view.picks[you];
  const botPick = view.picks[bot];
  const iPicked = (myPick !== null && myPick !== undefined) || pending !== null;
  const canPick = view.phase === 'pick' && !iPicked && !meta.finished;
  const cardWidth = Math.min(150, (width - space.lg * 3) / 2);

  useEffect(() => setPending(null), [view.round, view.phase]);

  const pick = (value: number) => {
    if (!canPick) return;
    setPending(value);
    void submit({ type: 'pick', value }).then((ack) => {
      if (!ack.ok) setPending(null);
    });
  };

  const status = revealed
    ? revealed.winner === null
      ? t('games.devSecretPick.roundTie')
      : revealed.winner === you
        ? t('games.devSecretPick.roundWon')
        : t('games.devSecretPick.roundLost')
    : iPicked
      ? t('games.devSecretPick.waiting')
      : t('games.devSecretPick.pickPrompt');

  const myValue = revealed ? revealed.picks[you] : typeof myPick === 'number' ? myPick : pending;
  const botValue = revealed ? revealed.picks[bot] : null;
  const botLocked =
    !revealed &&
    botPick !== null &&
    botPick !== undefined &&
    (isHidden(botPick) || typeof botPick === 'number');

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.score} testID="sp-score">
          {t('games.devSecretPick.score', { you: view.wins[you] ?? 0, bot: view.wins[bot] ?? 0 })}
        </Text>
        <Text style={styles.round}>
          {t('games.devSecretPick.round', { round: Math.min(view.round, 5) })}
        </Text>
        <Text style={styles.rule}>{t('games.devSecretPick.rule')}</Text>
      </View>

      <View style={styles.cards}>
        <Card
          label={t('common.you')}
          value={myValue ?? null}
          width={cardWidth}
          winner={revealed?.winner === you}
          flipKey={revealed ? `r${revealed.round}` : `p${view.round}-${myValue ?? '-'}`}
          burstTrigger={revealed?.winner === you ? revealed.round : 0}
        />
        <Card
          label={t('common.bot')}
          value={botValue ?? null}
          width={cardWidth}
          winner={revealed !== null && revealed.winner === bot}
          caption={
            revealed
              ? undefined
              : botLocked
                ? t('games.devSecretPick.botLocked')
                : t('games.devSecretPick.botThinking')
          }
          flipKey={revealed ? `r${revealed.round}` : `p${view.round}-${botLocked ? 'l' : 'w'}`}
          burstTrigger={revealed?.winner === bot ? revealed.round : 0}
        />
      </View>

      <Text style={styles.status} accessibilityLiveRegion="polite" testID="sp-status">
        {status}
      </Text>
      <View style={styles.timer}>
        <TimerBar
          deadlineAt={meta.awaiting.deadlineAt}
          paused={meta.paused}
          serverNow={serverNow}
        />
      </View>

      <View style={styles.picks}>
        {[1, 2, 3].map((value) => (
          <Pressable
            key={value}
            onPress={() => pick(value)}
            disabled={!canPick}
            accessibilityRole="button"
            accessibilityLabel={t('games.devSecretPick.pick', { value })}
            accessibilityState={{ disabled: !canPick, selected: myValue === value }}
            testID={`pick-${value}`}
            style={({ pressed }) => [
              styles.pickButton,
              { borderColor: PICK_COLORS[value] },
              myValue === value && { backgroundColor: PICK_COLORS[value] },
              !canPick && myValue !== value && styles.pickDisabled,
              pressed && styles.pickPressed,
            ]}
          >
            <Text style={[styles.pickText, myValue === value && styles.pickTextOn]}>{value}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

interface CardProps {
  label: string;
  value: number | null;
  width: number;
  winner: boolean;
  caption?: string | undefined;
  flipKey: string;
  burstTrigger: number;
}

function Card({ label, value, width, winner, caption, flipKey, burstTrigger }: CardProps) {
  const color = value === null ? colors.surfaceRaised : (PICK_COLORS[value] ?? colors.marigold);
  const burstSize = width * 1.7;
  return (
    <View style={[styles.cardSlot, { width, height: width * 1.35 }]}>
      <View
        style={[
          styles.burst,
          {
            width: burstSize,
            height: burstSize,
            left: (width - burstSize) / 2,
            top: (width * 1.35 - burstSize) / 2,
          },
        ]}
        pointerEvents="none"
      >
        <Burst
          size={burstSize}
          color={winner ? colors.marigold : colors.rain}
          trigger={burstTrigger}
        />
      </View>
      <Animated.View
        key={flipKey}
        entering={FlipInYLeft.duration(380)}
        style={[styles.card, { borderColor: winner ? colors.marigold : colors.borderStrong }]}
      >
        <View
          style={[styles.cardFace, { backgroundColor: value === null ? 'transparent' : color }]}
        >
          {value === null ? (
            <Text style={styles.cardHidden}>?</Text>
          ) : (
            <Animated.Text entering={ZoomIn.delay(120)} style={styles.cardValue}>
              {value}
            </Animated.Text>
          )}
        </View>
        <Text style={styles.cardLabel}>{label}</Text>
        {caption && <Text style={styles.cardCaption}>{caption}</Text>}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.lg,
  },
  header: { alignItems: 'center', gap: 2 },
  score: { color: colors.text, fontSize: font.title, fontWeight: '900' },
  round: { color: colors.textMuted, fontSize: font.body, fontWeight: '700' },
  rule: { color: colors.textDim, fontSize: font.small },
  cards: { flexDirection: 'row', gap: space.lg, marginVertical: space.md },
  cardSlot: { alignItems: 'center', justifyContent: 'center' },
  burst: { position: 'absolute' },
  card: {
    flex: 1,
    width: '100%',
    borderRadius: radius.lg,
    borderWidth: 2,
    backgroundColor: colors.surface,
    padding: space.sm,
    alignItems: 'center',
    gap: space.xs,
  },
  cardFace: {
    flex: 1,
    width: '100%',
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHidden: { color: colors.textDim, fontSize: 48, fontWeight: '900' },
  cardValue: { color: '#1b1209', fontSize: 64, fontWeight: '900' },
  cardLabel: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  cardCaption: { color: colors.textMuted, fontSize: font.tiny, textAlign: 'center' },
  status: {
    color: colors.text,
    fontSize: font.heading,
    fontWeight: '700',
    minHeight: 26,
    textAlign: 'center',
  },
  timer: { width: '100%', maxWidth: 360 },
  picks: { flexDirection: 'row', gap: space.lg },
  pickButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  pickDisabled: { opacity: 0.35 },
  pickPressed: { transform: [{ scale: 0.94 }] },
  pickText: { color: colors.text, fontSize: 32, fontWeight: '900' },
  pickTextOn: { color: '#1b1209' },
});
