import type { MatchResult, Seat } from '@gp/game-sdk/core';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';

import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { colors, font, radius, space } from '../ui/theme';

export type Outcome = 'win' | 'lose' | 'draw';

export function outcomeFor(result: MatchResult, seat: Seat): Outcome {
  const places = result.placements;
  if (places.every((p) => p.place === 1)) return 'draw';
  return places.find((p) => p.seat === seat)?.place === 1 ? 'win' : 'lose';
}

const BADGE: Record<Outcome, { glyph: string; color: string }> = {
  win: { glyph: '★', color: colors.marigold },
  lose: { glyph: '☂', color: colors.rain },
  draw: { glyph: '=', color: colors.teal },
};

interface ResultSheetProps {
  outcome: Outcome;
  onRematch(): void;
  /** vs-bot only: back to the setup sheet. */
  onSettings?(): void;
  onHome(): void;
  /** Multiplayer overrides: "Asha wins", "Leave room", a rematch note. */
  title?: string;
  subtitle?: string;
  homeLabel?: string;
  rematchDisabled?: boolean;
  note?: string | null;
}

export function ResultSheet({
  outcome,
  onRematch,
  onSettings,
  onHome,
  title,
  subtitle,
  homeLabel,
  rematchDisabled = false,
  note,
}: ResultSheetProps) {
  const { t } = useTranslation();
  const badge = BADGE[outcome];
  return (
    <Sheet
      title={title ?? t(`result.${outcome}`)}
      testID="result-sheet"
      footer={
        <>
          {note ? (
            <Text style={styles.note} accessibilityLiveRegion="polite">
              {note}
            </Text>
          ) : null}
          <Button
            big
            label={t('common.rematch')}
            onPress={onRematch}
            disabled={rematchDisabled}
            testID="rematch"
          />
          <View style={styles.row}>
            {onSettings && (
              <Button
                variant="secondary"
                label={t('setup.title')}
                onPress={onSettings}
                style={styles.flex}
              />
            )}
            <Button
              variant="secondary"
              label={homeLabel ?? t('common.backHome')}
              onPress={onHome}
              style={styles.flex}
              testID="result-home"
            />
          </View>
        </>
      }
    >
      <Animated.View
        entering={ZoomIn.springify().damping(12)}
        style={[styles.badge, { borderColor: badge.color }]}
      >
        <Text style={[styles.glyph, { color: badge.color }]}>{badge.glyph}</Text>
      </Animated.View>
      <Text style={styles.sub}>{subtitle ?? t(`result.${outcome}Sub`)}</Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'center',
    width: 96,
    height: 96,
    borderRadius: radius.pill,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  glyph: { fontSize: 48, fontWeight: '900' },
  sub: { color: colors.textMuted, fontSize: font.body, textAlign: 'center' },
  row: { flexDirection: 'row', gap: space.sm },
  note: { color: colors.marigold, fontSize: font.small, textAlign: 'center', fontWeight: '700' },
  flex: { flex: 1 },
});
