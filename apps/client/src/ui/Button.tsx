import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { colors, font, radius, space, TOUCH } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps {
  label: string;
  onPress(): void;
  variant?: ButtonVariant;
  icon?: ReactNode;
  accessibilityHint?: string;
  disabled?: boolean;
  selected?: boolean;
  big?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  accessibilityHint,
  disabled = false,
  selected,
  big = false,
  style,
  testID,
}: ButtonProps) {
  const content = (
    <View style={[styles.inner, big && styles.innerBig]}>
      {icon}
      <Text
        style={[
          styles.label,
          big && styles.labelBig,
          variant === 'primary' ? styles.labelPrimary : styles.labelOther,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        variant === 'secondary' && styles.secondary,
        variant === 'ghost' && styles.ghost,
        selected === true && styles.selected,
        { opacity: disabled ? 0.45 : pressed ? 0.82 : 1 },
        pressed && styles.pressed,
        style,
      ]}
    >
      {variant === 'primary' ? (
        <LinearGradient
          colors={[colors.marigold, colors.marigoldDeep]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gradient}
        >
          {content}
        </LinearGradient>
      ) : (
        content
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: TOUCH,
    minWidth: TOUCH,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  pressed: { transform: [{ scale: 0.97 }] },
  secondary: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  ghost: { backgroundColor: 'transparent' },
  selected: { borderColor: colors.marigold, backgroundColor: 'rgba(245, 168, 58, 0.16)' },
  gradient: { flex: 1, borderRadius: radius.pill },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: TOUCH,
    paddingHorizontal: space.lg,
  },
  innerBig: { minHeight: 56, paddingHorizontal: space.xl },
  label: { fontSize: font.body, fontWeight: '700' },
  labelBig: { fontSize: font.heading },
  labelPrimary: { color: '#2a1606' },
  labelOther: { color: colors.text },
});
