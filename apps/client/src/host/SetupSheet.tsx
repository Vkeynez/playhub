// Pre-game sheet: mode (when a game has several), bot difficulty, and the game's config options.
import { BOT_LEVELS } from '@gp/game-sdk/core';
import type { BotLevel, GameManifest } from '@gp/game-sdk/core';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { colors, font, radius, space, TOUCH } from '../ui/theme';
import type { ConfigOption, OptionValue } from './configOptions';
import { initialConfig } from './configOptions';

export interface MatchSettings {
  mode: string;
  botLevel: BotLevel;
  /** The human's seat (0 unless the game offers a seat choice, e.g. X or O). */
  seat: number;
  config: Record<string, OptionValue>;
}

interface SetupSheetProps {
  manifest: GameManifest;
  options: readonly ConfigOption[];
  /** Seat labels when the player may pick a side (seat 0 moves first). */
  seatLabels?: readonly string[] | undefined;
  initial: MatchSettings | null;
  onStart(settings: MatchSettings): void;
  /** Shown for games with a 2+ seat mode: creates a room instead of a vs-bot match. */
  onPlayFriend?(settings: MatchSettings): void;
  /** "Creating your room…" while POST /rooms runs. */
  friendBusy?: boolean;
  friendError?: string | null;
  /** Shown under the buttons, e.g. the wake banner. */
  extra?: ReactNode;
  onClose(): void;
}

const LEVEL_DOTS: Record<BotLevel, number> = { easy: 1, medium: 2, hard: 3 };

export function defaultSettings(
  manifest: GameManifest,
  options: readonly ConfigOption[],
): MatchSettings {
  const mode = manifest.modes.find((m) => m.supportsBots) ?? manifest.modes[0];
  return { mode: mode?.id ?? '', botLevel: 'medium', seat: 0, config: initialConfig(options) };
}

export function SetupSheet({
  manifest,
  options,
  seatLabels,
  initial,
  onStart,
  onPlayFriend,
  friendBusy = false,
  friendError,
  extra,
  onClose,
}: SetupSheetProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<MatchSettings>(
    () => initial ?? defaultSettings(manifest, options),
  );
  const modes = manifest.modes.filter((m) => m.supportsBots);
  const friendsAllowed = (manifest.modes.find((m) => m.id === settings.mode)?.seats.max ?? 1) >= 2;

  const setOption = (key: string, value: OptionValue | undefined) =>
    setSettings((s) => {
      const config = { ...s.config };
      if (value === undefined) delete config[key];
      else config[key] = value;
      return { ...s, config };
    });

  return (
    <Sheet
      title={t('setup.title')}
      onClose={onClose}
      closeLabel={t('common.backHome')}
      testID="setup-sheet"
      footer={
        <>
          {friendError ? (
            <Text style={styles.error} role="alert">
              {friendError}
            </Text>
          ) : null}
          {extra}
          <View style={styles.footerRow}>
            <Button
              big
              label={t('common.start')}
              onPress={() => onStart(settings)}
              disabled={friendBusy}
              style={styles.flex}
              testID="start"
            />
            {onPlayFriend && friendsAllowed && (
              <Button
                big
                variant="secondary"
                label={friendBusy ? t('friends.creating') : t('friends.playWithFriend')}
                accessibilityHint={t('friends.hint')}
                onPress={() => onPlayFriend(settings)}
                disabled={friendBusy}
                style={styles.flex}
                testID="play-friend"
              />
            )}
          </View>
        </>
      }
    >
      <Text style={styles.subtitle}>
        {t(manifest.name)} · {t('setup.vsBot')}
      </Text>

      {modes.length > 1 && (
        <Section title={t('setup.mode')}>
          <View style={styles.chips}>
            {modes.map((m) => (
              <Button
                key={m.id}
                variant="secondary"
                label={t(m.name)}
                selected={settings.mode === m.id}
                onPress={() => setSettings((s) => ({ ...s, mode: m.id }))}
              />
            ))}
          </View>
        </Section>
      )}

      {seatLabels && seatLabels.length > 1 && (
        <Section title={t('setup.playAs')}>
          <View style={styles.chips} role="radiogroup">
            {seatLabels.map((label, seat) => (
              <Button
                key={label}
                variant="secondary"
                label={label}
                selected={settings.seat === seat}
                onPress={() => setSettings((s) => ({ ...s, seat }))}
                testID={`seat-${seat}`}
              />
            ))}
          </View>
          <Text style={styles.levelHint}>{t('setup.movesFirst', { label: seatLabels[0] })}</Text>
        </Section>
      )}

      <Section title={t('setup.difficulty')}>
        <View style={styles.levels} role="radiogroup">
          {BOT_LEVELS.map((level) => {
            const selected = settings.botLevel === level;
            return (
              <Pressable
                key={level}
                role="radio"
                aria-checked={selected}
                accessibilityLabel={`${t(`setup.level.${level}`)}. ${t(`setup.levelHint.${level}`)}`}
                onPress={() => setSettings((s) => ({ ...s, botLevel: level }))}
                testID={`level-${level}`}
                style={({ pressed }) => [
                  styles.level,
                  selected && styles.levelSelected,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <View style={styles.dots}>
                  {[1, 2, 3].map((d) => (
                    <View key={d} style={[styles.dot, d <= LEVEL_DOTS[level] && styles.dotOn]} />
                  ))}
                </View>
                <Text style={styles.levelName}>{t(`setup.level.${level}`)}</Text>
                <Text style={styles.levelHint}>{t(`setup.levelHint.${level}`)}</Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {options.length > 0 && (
        <Section title={t('setup.options')}>
          {options.map((option) => (
            <View key={option.key} style={styles.option}>
              <Text style={styles.optionLabel}>
                {t(`options.${option.key}`, { defaultValue: option.key })}
              </Text>
              <View style={styles.chips}>
                {option.choices.map((value) => (
                  <Button
                    key={String(value)}
                    variant="secondary"
                    label={value === undefined ? t('common.default') : String(value)}
                    selected={settings.config[option.key] === value}
                    onPress={() => setOption(option.key, value)}
                    testID={`opt-${option.key}-${String(value)}`}
                  />
                ))}
              </View>
            </View>
          ))}
        </Section>
      )}
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} role="heading" aria-level={3}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textMuted, fontSize: font.body },
  section: { gap: space.sm },
  sectionTitle: {
    color: colors.textDim,
    fontSize: font.small,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  levels: { flexDirection: 'row', gap: space.sm },
  level: {
    flex: 1,
    minHeight: TOUCH,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1.5,
    borderColor: colors.border,
    gap: 4,
  },
  levelSelected: { borderColor: colors.marigold, backgroundColor: 'rgba(245, 168, 58, 0.14)' },
  dots: { flexDirection: 'row', gap: 4, marginBottom: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.borderStrong },
  dotOn: { backgroundColor: colors.marigold },
  levelName: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  levelHint: { color: colors.textMuted, fontSize: font.tiny, lineHeight: 16 },
  option: { gap: space.sm },
  footerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  flex: { flexGrow: 1, flexBasis: 220 },
  error: { color: colors.danger, fontSize: font.small, textAlign: 'center', fontWeight: '600' },
  optionLabel: { color: colors.text, fontSize: font.body, fontWeight: '600' },
});
