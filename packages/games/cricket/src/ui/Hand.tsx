// A cartoon hand drawn with Skia, fingers up, palm to the viewer. Each finger's extension (0 curled →
// 1 straight) is a shared value, so the reveal flick runs on the UI thread: fingers are round-capped
// strokes rebuilt in one path per frame, never React state.
import type { SkPathBuilder } from '@shopify/react-native-skia';
import { Group, Path, RoundedRect, usePathValue } from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';
import { useDerivedValue } from 'react-native-reanimated';

export interface HandPalette {
  fill: string;
  shade: string;
  cuff: string;
}

export interface HandMotion {
  thumb: SharedValue<number>;
  index: SharedValue<number>;
  middle: SharedValue<number>;
  ring: SharedValue<number>;
  pinky: SharedValue<number>;
  /** Vertical pump, in hand sizes (negative = up). */
  lift: SharedValue<number>;
  /** 0..1 impact squash of the reveal "thunk". */
  squash: SharedValue<number>;
}

interface HandProps {
  /** Wrist centre in canvas coordinates. */
  x: number;
  y: number;
  size: number;
  /** Mirror so the thumb faces the centre from the right-hand side. */
  mirrored: boolean;
  palette: HandPalette;
  motion: HandMotion;
}

// Hand-local geometry, in hand sizes. The thumb sits on +x (towards the centre for the left hand).
const BASE_Y = -0.5;
const FINGER_X = [0.225, 0.075, -0.075, -0.225] as const;
const FINGER_LEN = [0.46, 0.52, 0.47, 0.38] as const;
const FINGER_SPREAD = [0.05, 0.015, -0.02, -0.06] as const;
const CURLED = 0.05;
const FINGER_W = 0.14;
const OUTLINE = 0.05;
const THUMB_X = 0.25;
const THUMB_Y = -0.2;

function addFinger(b: SkPathBuilder, i: number, extension: number, s: number): void {
  'worklet';
  const e = Math.min(1.15, Math.max(0, extension));
  const len = CURLED + ((FINGER_LEN[i] ?? 0.4) - CURLED) * e;
  const bx = (FINGER_X[i] ?? 0) * s;
  b.moveTo(bx, BASE_Y * s);
  b.lineTo(bx + (FINGER_SPREAD[i] ?? 0) * e * s, (BASE_Y - len) * s);
}

export function Hand({ x, y, size: s, mirrored, palette, motion }: HandProps) {
  const { thumb, index, middle, ring, pinky, lift, squash } = motion;

  const transform = useDerivedValue(() => [
    { translateX: x },
    { translateY: y + lift.value * s },
    { scaleX: mirrored ? -1 : 1 },
    { scale: 1 + squash.value * 0.1 },
  ]);

  const fingers = usePathValue((b) => {
    'worklet';
    addFinger(b, 0, index.value, s);
    addFinger(b, 1, middle.value, s);
    addFinger(b, 2, ring.value, s);
    addFinger(b, 3, pinky.value, s);
  });

  const thumbPath = usePathValue((b) => {
    'worklet';
    const e = Math.min(1.15, Math.max(0, thumb.value));
    const angle = -1.4 + 1.85 * e;
    const len = (0.2 + 0.14 * e) * s;
    const bx = THUMB_X * s;
    const by = THUMB_Y * s;
    b.moveTo(bx, by);
    b.lineTo(bx + Math.sin(angle) * len, by - Math.cos(angle) * len);
  });

  const fw = FINGER_W * s;
  const ow = fw + OUTLINE * s;
  return (
    <Group transform={transform}>
      <RoundedRect
        x={-0.3 * s}
        y={-0.04 * s}
        width={0.6 * s}
        height={0.3 * s}
        r={0.06 * s}
        color={palette.cuff}
      />
      <RoundedRect
        x={-0.3 * s}
        y={0.07 * s}
        width={0.6 * s}
        height={0.05 * s}
        r={0.02 * s}
        color="rgba(0,0,0,0.18)"
      />
      <Path
        path={fingers}
        style="stroke"
        strokeWidth={ow}
        strokeCap="round"
        color={palette.shade}
      />
      <RoundedRect
        x={-0.335 * s}
        y={-0.615 * s}
        width={0.67 * s}
        height={0.65 * s}
        r={0.18 * s}
        color={palette.shade}
      />
      <RoundedRect
        x={-0.31 * s}
        y={-0.59 * s}
        width={0.62 * s}
        height={0.6 * s}
        r={0.16 * s}
        color={palette.fill}
      />
      <Path path={fingers} style="stroke" strokeWidth={fw} strokeCap="round" color={palette.fill} />
      <Path
        path={thumbPath}
        style="stroke"
        strokeWidth={ow + 0.01 * s}
        strokeCap="round"
        color={palette.shade}
      />
      <Path
        path={thumbPath}
        style="stroke"
        strokeWidth={fw + 0.01 * s}
        strokeCap="round"
        color={palette.fill}
      />
    </Group>
  );
}
