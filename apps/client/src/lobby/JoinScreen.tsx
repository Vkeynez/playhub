// /join/<CODE>: what an invite link (WhatsApp, QR, copy) opens. Resolves the code and replaces
// itself with the lobby; on failure it explains why and offers the code box again.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Backdrop } from '../ui/Backdrop';
import { Button } from '../ui/Button';
import { InAppHint } from '../ui/InAppHint';
import { colors, font, space } from '../ui/theme';
import { WakeBanner } from '../ui/WakeBanner';
import { isCompleteCode, sanitizeCodeInput } from './code';
import { JoinSheet } from './JoinSheet';
import { resolveJoin, roomHref } from './joinFlow';
import type { JoinErrorCode } from './joinFlow';

export function JoinScreen({ rawCode }: { rawCode: string }) {
  const { t } = useTranslation();
  const code = sanitizeCodeInput(rawCode);
  const valid = isCompleteCode(code);
  const [error, setError] = useState<JoinErrorCode | 'invalid' | null>(valid ? null : 'invalid');
  const [fullRoomId, setFullRoomId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    if (!valid) return;
    let live = true;
    setError(null);
    void resolveJoin(code).then((outcome) => {
      if (!live) return;
      if (outcome.ok) router.replace(roomHref(outcome.roomId));
      else {
        setError(outcome.error);
        setFullRoomId(outcome.roomId ?? null);
      }
    });
    return () => {
      live = false;
    };
  }, [code, valid, attempt]);

  return (
    <View style={styles.root}>
      <Backdrop />
      <View style={styles.column}>
        <InAppHint code={valid ? code : null} />
        {error === null ? (
          <View style={styles.center} role="status" accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.marigold} size="large" />
            <Text style={styles.title}>{t('join.joining', { code })}</Text>
          </View>
        ) : (
          <View style={styles.center}>
            <Text style={styles.title} role="alert">
              {t(`join.errors.${error}`)}
            </Text>
            <View style={styles.buttons}>
              {fullRoomId ? (
                <Button
                  big
                  label={t('join.watchLive')}
                  onPress={() => router.replace(roomHref(fullRoomId, true))}
                  testID="watch-live"
                />
              ) : error === 'invalid' || error === 'NOT_FOUND' ? (
                <Button big label={t('join.title')} onPress={() => setSheet(true)} />
              ) : (
                <Button big label={t('common.retry')} onPress={() => setAttempt((n) => n + 1)} />
              )}
              <Button
                variant="secondary"
                label={t('common.backHome')}
                onPress={() => router.replace('/')}
              />
            </View>
          </View>
        )}
        <WakeBanner />
      </View>
      {sheet && <JoinSheet onClose={() => setSheet(false)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    padding: space.lg,
    gap: space.lg,
    justifyContent: 'center',
  },
  center: { alignItems: 'center', gap: space.lg },
  title: { color: colors.text, fontSize: font.heading, fontWeight: '800', textAlign: 'center' },
  buttons: { gap: space.sm, width: '100%', maxWidth: 360 },
});
