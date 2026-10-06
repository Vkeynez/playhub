import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CatalogEntry } from '../catalog';
import { gameKey } from '../i18n';
import { GameArt } from './GameArt';
import { colors, font, radius, shelfGradients, space } from './theme';

interface GameTileProps {
  game: CatalogEntry;
  playable: boolean;
  width: number;
  onPress(): void;
}

export function GameTile({ game, playable, width, onPress }: GameTileProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const key = gameKey(game.id);
  const name = t(`games.${key}.name`);
  const blurb = t(`games.${key}.blurb`);
  const status =
    game.status === 'dev'
      ? t('home.devBadge')
      : playable
        ? t('home.playNow')
        : t('home.comingSoon');
  const seats = game.seats
    ? game.seats.min === game.seats.max
      ? t('home.seats', { count: game.seats.min })
      : t('home.seatsRange', game.seats)
    : t('home.solo');
  const [from, to] = shelfGradients[game.shelf];
  const artSize = Math.min(120, Math.round(width * 0.52));

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={t('home.tileLabel', { name, status })}
      accessibilityHint={blurb}
      testID={`tile-${game.id}`}
      style={({ pressed }) => [
        styles.tile,
        { width },
        hovered && styles.hovered,
        pressed && styles.pressed,
      ]}
    >
      <LinearGradient
        colors={playable ? [from, to] : [colors.surfaceRaised, colors.surface]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.art}
      >
        <View style={[styles.artInner, !playable && styles.muted]}>
          <GameArt id={game.id} size={artSize} />
        </View>
        <View
          style={[
            styles.pill,
            playable ? styles.pillPlay : styles.pillSoon,
            game.status === 'dev' && styles.pillDev,
          ]}
        >
          <Text style={[styles.pillText, playable && styles.pillTextPlay]}>{status}</Text>
        </View>
      </LinearGradient>
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.blurb} numberOfLines={2}>
          {blurb}
        </Text>
        <Text style={styles.seats}>{seats}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  hovered: { borderColor: colors.borderStrong, transform: [{ translateY: -2 }] },
  pressed: { transform: [{ scale: 0.97 }] },
  art: { aspectRatio: 1.25, alignItems: 'center', justifyContent: 'center' },
  artInner: { alignItems: 'center', justifyContent: 'center' },
  muted: { opacity: 0.45 },
  pill: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  pillPlay: { backgroundColor: 'rgba(14, 18, 32, 0.78)' },
  pillSoon: { backgroundColor: 'rgba(255, 236, 210, 0.10)' },
  pillDev: { backgroundColor: colors.lavender },
  pillText: { color: colors.textMuted, fontSize: font.tiny, fontWeight: '700', letterSpacing: 0.4 },
  pillTextPlay: { color: colors.text },
  meta: { padding: space.md, gap: 2 },
  name: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  blurb: { color: colors.textMuted, fontSize: font.tiny, lineHeight: 16, minHeight: 32 },
  seats: { color: colors.textDim, fontSize: font.tiny, marginTop: 2 },
});
