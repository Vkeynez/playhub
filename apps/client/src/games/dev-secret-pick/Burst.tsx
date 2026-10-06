// Skia reveal burst behind the round winner's card. Animated purely on the UI thread: one shared
// value drives the group's scale and opacity (no React state per frame).
// The Canvas style must be a plain object: Skia's web Canvas does not flatten style arrays.
import { Canvas, Circle, Group } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import { Easing, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';

const RAYS = Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2);

export function Burst({ size, color, trigger }: { size: number; color: string; trigger: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    if (trigger === 0) return;
    p.value = 0;
    p.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });
  }, [trigger, p]);

  const c = size / 2;
  const transform = useDerivedValue(() => [{ scale: 0.35 + p.value * 0.75 }]);
  const opacity = useDerivedValue(() => (p.value === 0 ? 0 : 1 - p.value * 0.85));
  const ring = useDerivedValue(() => 2 + (1 - p.value) * 10);

  return (
    <Canvas
      style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }}
      pointerEvents="none"
    >
      <Group transform={transform} origin={{ x: c, y: c }} opacity={opacity}>
        <Circle cx={c} cy={c} r={c * 0.62} color={color} style="stroke" strokeWidth={ring} />
        <Circle cx={c} cy={c} r={c * 0.45} color={color} opacity={0.18} />
        {RAYS.map((a) => (
          <Circle
            key={a}
            cx={c + Math.cos(a) * c * 0.82}
            cy={c + Math.sin(a) * c * 0.82}
            r={size * 0.025}
            color={color}
          />
        ))}
      </Group>
    </Canvas>
  );
}
