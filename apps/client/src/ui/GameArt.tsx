// Procedural vector art for the Home tiles (no external assets). Each piece is drawn in a 100×100
// box on top of the tile gradient, so light strokes on transparent backgrounds read on any shelf.
import type { ReactElement } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Rect } from 'react-native-svg';

const INK = '#fff7ea';
const SHADOW = 'rgba(20, 10, 30, 0.28)';

const art: Record<string, () => ReactElement> = {
  cricket: () => (
    <G>
      <Ellipse cx={52} cy={88} rx={34} ry={5} fill={SHADOW} />
      <G transform="rotate(-35 50 50)">
        <Rect x={47.5} y={8} width={7} height={26} rx={3} fill="#7a3b22" />
        <Rect x={44} y={32} width={14} height={54} rx={6} fill="#f3d9a4" />
        <Line x1={51} y1={40} x2={51} y2={80} stroke="#d9b779" strokeWidth={2} />
      </G>
      <Circle cx={72} cy={66} r={11} fill="#c8233a" />
      <Path
        d="M64 60 Q72 66 64 73 M80 59 Q72 66 80 73"
        stroke={INK}
        strokeWidth={1.6}
        fill="none"
      />
      <G opacity={0.9}>
        <Rect x={16} y={42} width={4} height={38} rx={2} fill={INK} />
        <Rect x={24} y={42} width={4} height={38} rx={2} fill={INK} />
        <Rect x={32} y={42} width={4} height={38} rx={2} fill={INK} />
        <Rect x={14} y={38} width={24} height={3} rx={1.5} fill={INK} />
      </G>
    </G>
  ),
  ludo: () => (
    <G>
      <Rect x={14} y={14} width={72} height={72} rx={10} fill={INK} />
      <Rect x={18} y={18} width={28} height={28} rx={6} fill="#e4664a" />
      <Rect x={54} y={18} width={28} height={28} rx={6} fill="#3db8a5" />
      <Rect x={18} y={54} width={28} height={28} rx={6} fill="#6a93dd" />
      <Rect x={54} y={54} width={28} height={28} rx={6} fill="#f5a83a" />
      <Path d="M40 40 H60 L50 50 Z" fill="#3db8a5" />
      <Path d="M60 40 V60 L50 50 Z" fill="#f5a83a" />
      <Path d="M40 60 H60 L50 50 Z" fill="#6a93dd" />
      <Path d="M40 40 V60 L50 50 Z" fill="#e4664a" />
      <Circle cx={32} cy={32} r={6} fill={INK} />
      <Circle cx={68} cy={68} r={6} fill={INK} />
    </G>
  ),
  carrom: () => (
    <G>
      <Rect
        x={12}
        y={12}
        width={76}
        height={76}
        rx={8}
        fill="#f1d6a2"
        stroke="#7a3b22"
        strokeWidth={5}
      />
      {[
        [20, 20],
        [80, 20],
        [20, 80],
        [80, 80],
      ].map(([x, y]) => (
        <Circle key={`${x}-${y}`} cx={x} cy={y} r={6} fill="#2a1606" />
      ))}
      <Circle cx={50} cy={50} r={16} fill="none" stroke="#c8233a" strokeWidth={1.5} />
      <Circle cx={50} cy={50} r={5} fill="#c8233a" />
      <Circle cx={41} cy={46} r={4.5} fill="#2a1606" />
      <Circle cx={59} cy={46} r={4.5} fill={INK} stroke="#2a1606" strokeWidth={0.6} />
      <Circle cx={50} cy={60} r={4.5} fill="#2a1606" />
      <Circle cx={50} cy={40} r={4.5} fill={INK} stroke="#2a1606" strokeWidth={0.6} />
    </G>
  ),
  quiz: () => (
    <G>
      <Path
        d="M16 22 h60 a8 8 0 0 1 8 8 v32 a8 8 0 0 1 -8 8 h-36 l-14 12 v-12 h-10 a8 8 0 0 1 -8 -8 v-32 a8 8 0 0 1 8 -8z"
        fill={INK}
      />
      <Path
        d="M38 38 q0 -10 10 -10 q10 0 10 9 q0 6 -8 9 v5"
        stroke="#7a5cc4"
        strokeWidth={6}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={50} cy={59} r={3.6} fill="#7a5cc4" />
      <Circle cx={84} cy={20} r={6} fill="#f5a83a" />
    </G>
  ),
  runner: () => (
    <G>
      <Circle cx={74} cy={24} r={10} fill={INK} opacity={0.9} />
      {[18, 34, 50, 66, 82].map((x) => (
        <Line
          key={x}
          x1={x}
          y1={8}
          x2={x - 6}
          y2={26}
          stroke={INK}
          strokeWidth={1.4}
          opacity={0.5}
        />
      ))}
      <Path d="M0 70 H30 V56 H44 V74 H60 V60 H76 V50 H100 V100 H0 Z" fill="#1b2240" />
      <Rect x={8} y={76} width={6} height={6} fill="#f5a83a" />
      <Rect x={66} y={68} width={6} height={6} fill="#f5a83a" />
      <Path
        d="M48 42 l6 -6 l6 4 l-4 8 l6 6 M54 36 l-6 -2 M56 48 l-8 4"
        stroke={INK}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={57} cy={30} r={4} fill={INK} />
    </G>
  ),
  'lantern-quest': () => (
    <G>
      <Circle cx={50} cy={54} r={34} fill="#ffd58a" opacity={0.18} />
      <Circle cx={50} cy={54} r={22} fill="#ffd58a" opacity={0.25} />
      <Path d="M50 10 V20" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      <Rect x={38} y={20} width={24} height={6} rx={3} fill="#7a3b22" />
      <Path
        d="M36 28 Q50 22 64 28 L60 76 Q50 80 40 76 Z"
        fill="#f5a83a"
        stroke="#7a3b22"
        strokeWidth={2}
      />
      <Path d="M50 40 q7 10 0 20 q-7 -10 0 -20z" fill="#fff3c4" />
      <Rect x={40} y={76} width={20} height={6} rx={3} fill="#7a3b22" />
    </G>
  ),
  kolam: () => (
    <G>
      {[30, 50, 70].flatMap((x) =>
        [30, 50, 70].map((y) => <Circle key={`${x}-${y}`} cx={x} cy={y} r={2.8} fill={INK} />),
      )}
      <Path
        d="M40 20 Q50 10 60 20 L80 40 Q90 50 80 60 L60 80 Q50 90 40 80 L20 60 Q10 50 20 40 Z"
        stroke={INK}
        strokeWidth={2.4}
        fill="none"
      />
      <Path
        d="M40 40 Q50 30 60 40 Q70 50 60 60 Q50 70 40 60 Q30 50 40 40 Z"
        stroke="#ffd58a"
        strokeWidth={2.4}
        fill="none"
      />
    </G>
  ),
  'koi-pond': () => (
    <G>
      <Circle cx={50} cy={50} r={38} fill="rgba(255,255,255,0.14)" />
      <Circle cx={50} cy={50} r={28} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1.2} />
      <G transform="rotate(-20 50 50)">
        <Ellipse cx={42} cy={40} rx={14} ry={7} fill={INK} />
        <Path d="M28 40 l-9 -7 v14 z" fill={INK} />
        <Circle cx={47} cy={38} r={3} fill="#e4664a" />
        <Ellipse cx={60} cy={64} rx={13} ry={6.5} fill="#f5a83a" />
        <Path d="M73 64 l9 -6 v12 z" fill="#f5a83a" />
      </G>
      <Ellipse cx={74} cy={30} rx={8} ry={5} fill="#7cc46a" />
    </G>
  ),
  'color-sort': () => (
    <G>
      {[
        { x: 18, fills: ['#e4664a', '#3db8a5', '#f5a83a'] },
        { x: 42, fills: ['#3db8a5', '#e88fb5', '#e4664a'] },
        { x: 66, fills: ['#f5a83a', '#f5a83a', '#e88fb5'] },
      ].map(({ x, fills }) => (
        <G key={x}>
          {fills.map((fill, i) => (
            <Rect key={i} x={x + 2} y={70 - i * 16} width={12} height={16} fill={fill} />
          ))}
          <Path d={`M${x} 22 V80 a8 8 0 0 0 16 0 V22`} stroke={INK} strokeWidth={3} fill="none" />
        </G>
      ))}
    </G>
  ),
  'zen-garden': () => (
    <G>
      {[0, 1, 2, 3, 4].map((i) => (
        <Path
          key={i}
          d={`M8 ${30 + i * 12} Q50 ${18 + i * 12} 92 ${30 + i * 12}`}
          stroke={INK}
          strokeWidth={1.6}
          opacity={0.6}
          fill="none"
        />
      ))}
      <Ellipse cx={34} cy={60} rx={13} ry={9} fill="#3a3550" />
      <Ellipse cx={66} cy={44} rx={9} ry={6} fill="#4a4566" />
      <Circle cx={34} cy={60} r={20} fill="none" stroke={INK} strokeWidth={1.4} opacity={0.7} />
    </G>
  ),
  'dev-tictactoe': () => (
    <G>
      <Path
        d="M38 16 V84 M62 16 V84 M16 38 H84 M16 62 H84"
        stroke={INK}
        strokeWidth={4}
        strokeLinecap="round"
      />
      <Path
        d="M20 20 l12 12 M32 20 l-12 12"
        stroke="#f5a83a"
        strokeWidth={5}
        strokeLinecap="round"
      />
      <Circle cx={50} cy={50} r={7} stroke="#3db8a5" strokeWidth={4.5} fill="none" />
      <Path
        d="M68 68 l12 12 M80 68 l-12 12"
        stroke="#f5a83a"
        strokeWidth={5}
        strokeLinecap="round"
      />
    </G>
  ),
  'dev-secret-pick': () => (
    <G>
      {[
        { x: 12, r: -12, fill: '#e4664a' },
        { x: 36, r: 0, fill: '#f5a83a' },
        { x: 60, r: 12, fill: '#3db8a5' },
      ].map(({ x, r, fill }, i) => (
        <G key={x} transform={`rotate(${r} ${x + 14} 60)`}>
          <Rect x={x} y={26} width={28} height={40} rx={6} fill={INK} />
          <Circle cx={x + 14} cy={46} r={6 + i * 2} fill={fill} />
        </G>
      ))}
    </G>
  ),
};

export function GameArt({ id, size }: { id: string; size: number }) {
  const draw = art[id];
  return (
    <View aria-hidden style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        {draw ? draw() : <Circle cx={50} cy={50} r={20} fill={INK} />}
      </Svg>
    </View>
  );
}
