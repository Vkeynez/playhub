// A QR code for the invite link: the qrcode encoder's module matrix drawn as one SVG path.
import { create } from 'qrcode/lib/core/qrcode';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

const QUIET = 2;

export function qrPath(text: string): { path: string; size: number } {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) path += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
    }
  }
  return { path, size: modules.size + QUIET * 2 };
}

export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { path, size: cells } = useMemo(() => qrPath(value), [value]);
  return (
    <View accessible role="img" accessibilityLabel={label} style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${cells} ${cells}`}>
        <Rect x={0} y={0} width={cells} height={cells} fill="#ffffff" rx={1} />
        <Path d={path} fill="#0e1220" />
      </Svg>
    </View>
  );
}
