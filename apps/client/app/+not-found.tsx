import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Backdrop } from '../src/ui/Backdrop';
import { Button } from '../src/ui/Button';
import { colors, font, space } from '../src/ui/theme';

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <View style={styles.root}>
      <Backdrop />
      <Text style={styles.title} role="heading">
        {t('notFound.title')}
      </Text>
      <Text style={styles.body}>{t('notFound.body')}</Text>
      <Button label={t('common.backHome')} onPress={() => router.replace('/')} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.xl,
  },
  title: { color: colors.text, fontSize: font.title, fontWeight: '800' },
  body: { color: colors.textMuted, fontSize: font.body },
});
