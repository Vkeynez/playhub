// "Waking up the game server…" (ARCHITECTURE §6.7): shown by server-dependent screens only.
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';

import { useWaking } from '../net/wake';
import { colors, font, radius, space } from './theme';

export function WakeBanner() {
  const { t } = useTranslation();
  const waking = useWaking();
  if (!waking) return null;
  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutUp.duration(180)}
      style={styles.banner}
      accessibilityLiveRegion="polite"
      role="status"
      testID="wake-banner"
    >
      <ActivityIndicator color={colors.marigold} />
      <View style={styles.text}>
        <Text style={styles.title}>{t('wake.title')}</Text>
        <Text style={styles.body}>{t('wake.body')}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(245, 168, 58, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 168, 58, 0.4)',
  },
  text: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  body: { color: colors.textMuted, fontSize: font.small },
});
