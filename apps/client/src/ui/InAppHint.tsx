// Inside WhatsApp's in-app browser (an Android WebView): a gentle nudge to open Chrome (§6.5).
// Everything keeps working without it.
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { isInAppBrowser } from '../net/platform';
import { colors, font, radius, space } from './theme';

export function InAppHint({ code }: { code?: string | null }) {
  const { t } = useTranslation();
  if (!isInAppBrowser()) return null;
  return (
    <View style={styles.hint} role="note" testID="webview-hint">
      <Text style={styles.text}>{t('webview.hint')}</Text>
      {code ? <Text style={styles.code}>{t('webview.code', { code })}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hint: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(106, 147, 221, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(106, 147, 221, 0.4)',
    gap: 2,
  },
  text: { color: colors.text, fontSize: font.small },
  code: { color: colors.textMuted, fontSize: font.small, fontWeight: '700', letterSpacing: 1 },
});
