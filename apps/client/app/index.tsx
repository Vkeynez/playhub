// Home: brand header, "Join with code", and the three shelves (plus dev games in dev builds / ?dev=1).
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATALOG, SHELVES } from '../src/catalog';
import type { CatalogEntry } from '../src/catalog';
import { gameKey, i18n } from '../src/i18n';
import { isRegistered } from '../src/registry';
import { Backdrop } from '../src/ui/Backdrop';
import { Button } from '../src/ui/Button';
import { GameArt } from '../src/ui/GameArt';
import { GameTile } from '../src/ui/GameTile';
import { Sheet } from '../src/ui/Sheet';
import { colors, CONTENT_MAX, font, radius, space } from '../src/ui/theme';

const GAP = space.md;
const SIDE = space.lg;
const TILE_MIN = 156;

type ShelfId = (typeof SHELVES)[number] | 'dev';

export default function Home() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ dev?: string }>();
  const showDev = __DEV__ || params.dev === '1';
  const [joinOpen, setJoinOpen] = useState(false);
  const [soon, setSoon] = useState<CatalogEntry | null>(null);

  const contentWidth = Math.min(width, CONTENT_MAX) - SIDE * 2;
  const columns = Math.min(5, Math.max(2, Math.floor((contentWidth + GAP) / (TILE_MIN + GAP))));
  const tileWidth = Math.floor((contentWidth - GAP * (columns - 1)) / columns);

  const shelves = useMemo(() => {
    const visible = CATALOG.filter(
      (g) => g.status !== 'disabled' && (g.status !== 'dev' || showDev),
    );
    const ids: ShelfId[] = [...SHELVES, ...(showDev ? (['dev'] as const) : [])];
    return ids
      .map((id) => ({
        id,
        games: visible
          .filter((g) => (id === 'dev' ? g.status === 'dev' : g.shelf === id && g.status !== 'dev'))
          .sort((a, b) => a.sort - b.sort),
      }))
      .filter((s) => s.games.length > 0);
  }, [showDev]);

  const open = (game: CatalogEntry) => {
    if (isRegistered(game.id)) router.push(`/play/${game.id}`);
    else setSoon(game);
  };

  const toggleLanguage = () => {
    void i18n.changeLanguage(i18n.language === 'ta' ? 'en' : 'ta');
  };

  return (
    <View style={styles.root}>
      <Backdrop />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl },
        ]}
      >
        <View style={[styles.column, { width: contentWidth }]}>
          <View style={styles.header}>
            <View style={styles.brand}>
              <View style={styles.logo}>
                <GameArt id="lantern-quest" size={40} />
              </View>
              <View style={styles.brandText}>
                <Text style={styles.appName} role="heading" aria-level={1}>
                  {t('app.name')}
                </Text>
                <Text style={styles.tagline} numberOfLines={2}>
                  {t('app.tagline')}
                </Text>
              </View>
            </View>
            <Button
              variant="secondary"
              label={t('common.language')}
              accessibilityHint={t('common.languageLabel')}
              onPress={toggleLanguage}
            />
          </View>

          <Animated.View entering={FadeInDown.duration(380)} style={styles.joinCard}>
            <Text style={styles.joinHint}>{t('home.joinHint')}</Text>
            <Button
              big
              label={t('home.joinWithCode')}
              onPress={() => setJoinOpen(true)}
              testID="join"
              style={styles.joinButton}
            />
          </Animated.View>

          {shelves.map((shelf, index) => (
            <Animated.View
              key={shelf.id}
              entering={FadeInDown.delay(80 * (index + 1)).duration(380)}
              style={styles.shelf}
            >
              <Text style={styles.shelfTitle} role="heading" aria-level={2}>
                {t(`shelves.${shelf.id}.title`)}
              </Text>
              <Text style={styles.shelfSubtitle}>{t(`shelves.${shelf.id}.subtitle`)}</Text>
              <View style={styles.grid}>
                {shelf.games.map((game) => (
                  <GameTile
                    key={game.id}
                    game={game}
                    width={tileWidth}
                    playable={isRegistered(game.id)}
                    onPress={() => open(game)}
                  />
                ))}
              </View>
            </Animated.View>
          ))}
        </View>
      </ScrollView>

      {joinOpen && (
        <Sheet
          title={t('join.title')}
          onClose={() => setJoinOpen(false)}
          closeLabel={t('common.close')}
          testID="join-sheet"
          footer={
            <>
              <Button
                label={t('join.playBot')}
                onPress={() => {
                  setJoinOpen(false);
                  router.push('/play/cricket');
                }}
              />
              <Button
                variant="ghost"
                label={t('common.close')}
                onPress={() => setJoinOpen(false)}
              />
            </>
          }
        >
          <Text style={styles.sheetBody}>{t('join.body')}</Text>
        </Sheet>
      )}

      {soon && (
        <Sheet
          title={t('host.notReady', { name: t(`games.${gameKey(soon.id)}.name`) })}
          onClose={() => setSoon(null)}
          closeLabel={t('common.close')}
          footer={
            <Button variant="secondary" label={t('common.close')} onPress={() => setSoon(null)} />
          }
        >
          <View style={styles.soonArt}>
            <GameArt id={soon.id} size={120} />
          </View>
          <Text style={styles.sheetBody}>{t(`games.${gameKey(soon.id)}.blurb`)}</Text>
        </Sheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { alignItems: 'center' },
  column: { gap: space.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md },
  logo: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  brandText: { flex: 1 },
  appName: { color: colors.text, fontSize: font.title, fontWeight: '900', letterSpacing: 0.5 },
  tagline: { color: colors.textMuted, fontSize: font.small },
  joinCard: {
    backgroundColor: 'rgba(30, 38, 64, 0.72)',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: space.lg,
    gap: space.md,
  },
  joinButton: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  joinHint: { color: colors.textMuted, fontSize: font.small, textAlign: 'center' },
  shelf: { gap: space.xs },
  shelfTitle: { color: colors.text, fontSize: font.heading, fontWeight: '800' },
  shelfSubtitle: { color: colors.textDim, fontSize: font.small, marginBottom: space.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  sheetBody: { color: colors.textMuted, fontSize: font.body, lineHeight: 23 },
  soonArt: {
    alignSelf: 'center',
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
  },
});
