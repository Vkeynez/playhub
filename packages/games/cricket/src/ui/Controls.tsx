// Inputs: the six big number buttons and the two-way choices (odd/even, bat/bowl). Buttons press-
// scale on the UI thread; the keyboard focus ring only appears once the keyboard is used.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import type { Translate } from './i18n';
import { colors, font, PICK_COLORS, radius, space } from './theme';

export const PICK_VALUES = [1, 2, 3, 4, 5, 6] as const;

interface PickPadProps {
  t: Translate;
  enabled: boolean;
  /** The pick already made (pending or locked) this ball. */
  chosen: number | null;
  /** Keyboard focus (1–6) or null when the keyboard isn't in use. */
  focus: number | null;
  width: number;
  onPick(value: number): void;
}

export function PickPad({ t, enabled, chosen, focus, width, onPick }: PickPadProps) {
  const columns = width < 470 ? 3 : 6;
  const gap = space.sm;
  const size = Math.min(92, Math.floor((width - gap * (columns - 1)) / columns));
  const height = columns === 3 ? Math.min(68, size * 0.72) : Math.min(84, size);
  return (
    <View style={[styles.pad, { width: size * columns + gap * (columns - 1), gap }]}>
      {PICK_VALUES.map((value) => (
        <BigButton
          key={value}
          label={String(value)}
          a11y={t('pickLabel', { value })}
          color={PICK_COLORS[value] ?? colors.marigold}
          width={size}
          height={height}
          enabled={enabled}
          selected={chosen === value}
          focused={focus === value}
          onPress={() => onPick(value)}
          testID={`cr-pick-${value}`}
        >
          <FingerDots value={value} color={chosen === value ? colors.ink : colors.textDim} />
        </BigButton>
      ))}
    </View>
  );
}

/** Tiny finger tally under each number (6 = thumb). */
function FingerDots({ value, color }: { value: number; color: string }) {
  if (value === 6) return <View style={[styles.thumb, { backgroundColor: color }]} />;
  return (
    <View style={styles.dots}>
      {Array.from({ length: value }, (_, i) => (
        <View key={i} style={[styles.finger, { backgroundColor: color }]} />
      ))}
    </View>
  );
}

interface ChoiceProps {
  options: readonly { id: string; label: string; testID: string; color: string }[];
  focus: number | null;
  enabled: boolean;
  width: number;
  onChoose(id: string): void;
}

export function ChoiceRow({ options, focus, enabled, width, onChoose }: ChoiceProps) {
  const gap = space.md;
  const w = Math.min(180, (width - gap) / 2);
  return (
    <View style={[styles.choices, { gap }]}>
      {options.map((o, i) => (
        <BigButton
          key={o.id}
          label={o.label}
          a11y={o.label}
          color={o.color}
          width={w}
          height={64}
          enabled={enabled}
          selected={false}
          focused={focus === i}
          onPress={() => onChoose(o.id)}
          testID={o.testID}
          wide
        />
      ))}
    </View>
  );
}

interface BigButtonProps {
  label: string;
  a11y: string;
  color: string;
  width: number;
  height: number;
  enabled: boolean;
  selected: boolean;
  focused: boolean;
  onPress(): void;
  testID: string;
  wide?: boolean;
  children?: ReactNode;
}

function BigButton(p: BigButtonProps) {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={style}>
      <Pressable
        onPress={p.onPress}
        onPressIn={() => {
          if (p.enabled) scale.value = withSpring(0.9, { damping: 14, stiffness: 500 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 9, stiffness: 300 });
        }}
        disabled={!p.enabled}
        accessibilityRole="button"
        accessibilityLabel={p.a11y}
        accessibilityState={{ disabled: !p.enabled, selected: p.selected }}
        testID={p.testID}
        style={[
          styles.button,
          { width: p.width, height: p.height, borderColor: p.color },
          p.selected && { backgroundColor: p.color },
          p.focused && styles.focused,
          !p.enabled && !p.selected && styles.disabled,
        ]}
      >
        <Text
          style={[
            p.wide ? styles.wideLabel : styles.label,
            { color: p.selected ? colors.ink : p.enabled ? colors.text : colors.textMuted },
          ]}
        >
          {p.label}
        </Text>
        {p.children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignSelf: 'center' },
  choices: { flexDirection: 'row', justifyContent: 'center' },
  button: {
    borderRadius: radius.md,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    gap: 4,
  },
  focused: { outlineWidth: 3, outlineColor: colors.text, outlineStyle: 'solid', outlineOffset: 2 },
  disabled: { opacity: 0.38 },
  label: { fontSize: 30, fontWeight: '900', lineHeight: 34 },
  wideLabel: { fontSize: font.heading, fontWeight: '900' },
  dots: { flexDirection: 'row', gap: 3 },
  finger: { width: 4, height: 9, borderRadius: 2 },
  thumb: { width: 9, height: 6, borderRadius: 3 },
});
