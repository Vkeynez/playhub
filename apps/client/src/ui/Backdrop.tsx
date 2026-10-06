// The monsoon backdrop: night-sky gradient, two warm lamp glows and faint rain. Pure vector, static.
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, RadialGradient, Stop } from 'react-native-svg';

import { colors } from './theme';

const RAIN = Array.from({ length: 28 }, (_, i) => ({
  x: (i * 37) % 100,
  y: (i * 53) % 100,
  len: 3 + ((i * 7) % 4),
}));

export function Backdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={[colors.bgDeep, colors.bg, '#1a1630']}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          <RadialGradient id="glowA" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={colors.marigold} stopOpacity={0.22} />
            <Stop offset="1" stopColor={colors.marigold} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="glowB" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={colors.lotus} stopOpacity={0.14} />
            <Stop offset="1" stopColor={colors.lotus} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={88} cy={6} r={36} fill="url(#glowA)" />
        <Circle cx={4} cy={70} r={40} fill="url(#glowB)" />
        <G opacity={0.16}>
          {RAIN.map((d, i) => (
            <Line
              key={i}
              x1={d.x}
              y1={d.y}
              x2={d.x - 0.8}
              y2={d.y + d.len}
              stroke={colors.text}
              strokeWidth={0.18}
            />
          ))}
        </G>
      </Svg>
    </View>
  );
}
