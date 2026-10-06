// A bottom sheet on phones, a centred card on wide screens. Rendered in place (absolute fill) so it
// works the same on web and native; Escape closes it on web.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, radius, space } from './theme';

interface SheetProps {
  title: string;
  onClose?(): void;
  closeLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
}

export function Sheet({ title, onClose, closeLabel, children, footer, testID }: SheetProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= 720;

  useEffect(() => {
    if (Platform.OS !== 'web' || !onClose) return;
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <View style={[StyleSheet.absoluteFill, styles.root, wide && styles.rootWide]} testID={testID}>
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(150)}
        style={StyleSheet.absoluteFill}
      >
        <Pressable
          style={[StyleSheet.absoluteFill, styles.scrim]}
          onPress={onClose}
          accessibilityRole={onClose ? 'button' : undefined}
          accessibilityLabel={onClose ? closeLabel : undefined}
          disabled={!onClose}
        />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.springify().damping(22).stiffness(220)}
        exiting={SlideOutDown.duration(160)}
        accessibilityViewIsModal
        aria-modal
        role="dialog"
        aria-label={title}
        style={[
          styles.panel,
          wide ? styles.panelWide : styles.panelPhone,
          { maxHeight: height * 0.9, paddingBottom: wide ? space.xl : insets.bottom + space.lg },
        ]}
      >
        {!wide && <View style={styles.grabber} />}
        <View style={styles.header}>
          <Text style={styles.title} role="heading" aria-level={2}>
            {title}
          </Text>
          {onClose && (
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              hitSlop={8}
              style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.closeGlyph}>×</Text>
            </Pressable>
          )}
        </View>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {children}
        </ScrollView>
        {footer && <View style={styles.footer}>{footer}</View>}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { justifyContent: 'flex-end', zIndex: 50 },
  rootWide: { justifyContent: 'center', alignItems: 'center' },
  scrim: { backgroundColor: colors.scrim },
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    paddingTop: space.md,
  },
  panelPhone: {
    width: '100%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderBottomWidth: 0,
  },
  panelWide: { width: 520, maxWidth: '92%', borderRadius: radius.xl },
  grabber: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.borderStrong,
    marginBottom: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingBottom: space.sm,
  },
  title: { flex: 1, color: colors.text, fontSize: font.title, fontWeight: '800' },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  closeGlyph: { color: colors.text, fontSize: 26, lineHeight: 28 },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: space.xl, paddingBottom: space.md, gap: space.lg },
  footer: { paddingHorizontal: space.xl, paddingTop: space.md, gap: space.sm },
});
