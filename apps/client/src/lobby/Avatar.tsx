import { StyleSheet, Text, View } from 'react-native';

import { avatarHue } from '../net/identity';
import { colors } from '../ui/theme';

/** A coloured disc with the player's initial; the hue comes from their avatar seed. */
export function Avatar({ seed, name, size = 44 }: { seed: string; name: string; size?: number }) {
  const hue = avatarHue(seed);
  return (
    <View
      style={[
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: `hsl(${hue}, 62%, 46%)`,
          borderColor: `hsl(${hue}, 70%, 68%)`,
        },
      ]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Text style={[styles.initial, { fontSize: size * 0.42 }]}>
        {name.trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  initial: { color: colors.text, fontWeight: '900' },
});
