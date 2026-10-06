// The Skia arena: monsoon sky and pitch, the stumps (they fly on a wicket), the countdown ring around
// the ball, both hands and the particle bursts. All motion is shared values; React only re-renders
// when the match state changes. No text in Skia (ARCHITECTURE §6.4): labels are RN overlays.
import {
  Canvas,
  Circle,
  Group,
  LinearGradient,
  Oval,
  Path,
  RadialGradient,
  Rect,
  RoundedRect,
  Skia,
  usePathValue,
  vec,
} from '@shopify/react-native-skia';
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import type { HandPalette } from './Hand';
import { Hand } from './Hand';
import type { FeedbackKind } from './model';
import { flickTo, IMPACT_AT_MS, REVEAL_AT_MS, toFist, useCountdown, useHandMotion } from './motion';
import { colors } from './theme';

export interface ArenaFx {
  /** Changes once per reveal. */
  key: string;
  kind: FeedbackKind | 'toss';
}

interface ArenaProps {
  width: number;
  height: number;
  home: number | null;
  away: number | null;
  /** Reveal trigger: the hands flick when it changes to a non-null key, and close on null. */
  revealKey: string | null;
  fx: ArenaFx | null;
  deadlineAt: number | null;
  paused: boolean;
  ringActive: boolean;
  serverNow(): number;
  reduceMotion: boolean;
}

const YOU: HandPalette = { fill: colors.skin, shade: colors.skinShade, cuff: colors.cuffYou };
const BOT: HandPalette = { fill: colors.botHand, shade: colors.botShade, cuff: colors.cuffBot };

export interface ArenaLayout {
  handSize: number;
  homeX: number;
  awayX: number;
  handY: number;
  ballX: number;
  ballY: number;
  ringR: number;
  stumpsX: number;
  stumpsBase: number;
  stumpH: number;
}

export function arenaLayout(w: number, h: number): ArenaLayout {
  const handSize = Math.min(h * 0.58, w * 0.37);
  return {
    handSize,
    homeX: w * 0.21,
    awayX: w * 0.79,
    handY: h * 0.95,
    ballX: w / 2,
    ballY: h * 0.68,
    ringR: Math.min(h * 0.13, w * 0.1),
    stumpsX: w / 2,
    stumpsBase: h * 0.42,
    stumpH: h * 0.22,
  };
}

const BURST_COLORS: Record<FeedbackKind, readonly [string, string, string]> = {
  six: [colors.marigold, colors.lotus, colors.leaf],
  four: [colors.teal, colors.rain, colors.marigold],
  runs: [colors.marigold, colors.crease, colors.teal],
  out: [colors.kumkum, colors.stump, colors.terracotta],
};

export function Arena(props: ArenaProps) {
  const { width: w, height: h, reduceMotion } = props;
  const L = useMemo(() => arenaLayout(w, h), [w, h]);
  const homeHand = useHandMotion();
  const awayHand = useHandMotion();
  const impact = useSharedValue(0);
  const burst = useSharedValue(0);
  const wicket = useSharedValue(0);
  const rain = useSharedValue(0);

  // Hands: flick on a reveal, close to a fist for the next pick.
  const { revealKey, home, away } = props;
  useEffect(() => {
    if (revealKey === null) {
      toFist(homeHand, reduceMotion);
      toFist(awayHand, reduceMotion);
      return;
    }
    flickTo(homeHand, home, reduceMotion);
    flickTo(awayHand, away, reduceMotion);
    // Only the reveal key re-triggers the flick: the values belong to it.
  }, [revealKey]);

  // Impact ring, particles, stumps.
  const fxKey = props.fx?.key ?? null;
  const fxKind = props.fx?.kind ?? null;
  useEffect(() => {
    cancelAnimation(impact);
    cancelAnimation(burst);
    if (fxKey === null || fxKind === null) {
      wicket.value = withTiming(0, { duration: reduceMotion ? 0 : 250 });
      return;
    }
    const at = reduceMotion ? 0 : REVEAL_AT_MS;
    impact.value = 0;
    impact.value = withDelay(
      at,
      withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) }),
    );
    if (fxKind === 'toss' || reduceMotion) return;
    burst.value = 0;
    burst.value = withDelay(
      IMPACT_AT_MS,
      withTiming(1, { duration: fxKind === 'six' ? 1300 : 950, easing: Easing.out(Easing.quad) }),
    );
    if (fxKind === 'out') {
      wicket.value = 0;
      wicket.value = withDelay(
        IMPACT_AT_MS,
        withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }),
      );
    }
  }, [fxKey, fxKind, reduceMotion, impact, burst, wicket]);

  // Monsoon rain: one looping shared value (static with reduce motion).
  useEffect(() => {
    cancelAnimation(rain);
    if (reduceMotion) {
      rain.value = 0;
      return;
    }
    rain.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rain);
  }, [rain, reduceMotion]);

  const countdown = useCountdown(props.deadlineAt, props.paused, props.serverNow);
  const ringOn = useSharedValue(0);
  useEffect(() => {
    ringOn.value = withTiming(props.ringActive ? 1 : 0, { duration: 200 });
  }, [props.ringActive, ringOn]);

  const burstColors = fxKind && fxKind !== 'toss' ? BURST_COLORS[fxKind] : BURST_COLORS.runs;
  const burstAtStumps = fxKind === 'out';

  return (
    <Canvas style={{ width: w, height: h }} pointerEvents="none">
      <Backdrop w={w} h={h} rain={rain} layout={L} />
      <Stumps layout={L} wicket={wicket} />
      <BallRing layout={L} countdown={countdown} ringOn={ringOn} impact={impact} />
      <Hand
        x={L.homeX}
        y={L.handY}
        size={L.handSize}
        mirrored={false}
        palette={YOU}
        motion={homeHand}
      />
      <Hand x={L.awayX} y={L.handY} size={L.handSize} mirrored palette={BOT} motion={awayHand} />
      <Particles
        cx={L.ballX}
        cy={burstAtStumps ? L.stumpsBase - L.stumpH * 0.6 : L.ballY}
        spread={Math.min(w, h * 1.6) * 0.42}
        progress={burst}
        colors={burstColors}
        big={fxKind === 'six'}
      />
    </Canvas>
  );
}

function Backdrop({
  w,
  h,
  rain,
  layout: L,
}: {
  w: number;
  h: number;
  rain: SharedValue<number>;
  layout: ArenaLayout;
}) {
  const pitch = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    const top = L.stumpsBase - L.stumpH * 0.15;
    b.moveTo(w / 2 - w * 0.07, top);
    b.lineTo(w / 2 + w * 0.07, top);
    b.lineTo(w / 2 + w * 0.17, h);
    b.lineTo(w / 2 - w * 0.17, h);
    b.close();
    return b.build();
  }, [w, h, L]);
  const crease = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    const y1 = L.stumpsBase + 2;
    b.moveTo(w / 2 - w * 0.1, y1);
    b.lineTo(w / 2 + w * 0.1, y1);
    const y2 = h * 0.86;
    b.moveTo(w / 2 - w * 0.19, y2);
    b.lineTo(w / 2 + w * 0.19, y2);
    return b.build();
  }, [w, h, L]);
  const period = h * 0.3;
  const streaks = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    const cols = Math.max(8, Math.round(w / 34));
    for (let row = -1; row * period < h; row++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5 + (row % 2) * 0.5) * (w / cols) + ((c * 37) % 11);
        const y = row * period + ((c * 53) % Math.round(period));
        b.moveTo(x, y);
        b.lineTo(x - 3, y + 11);
      }
    }
    return b.build();
  }, [w, h, period]);
  const rainTransform = useDerivedValue(() => [{ translateY: rain.value * period }]);

  return (
    <Group>
      <Rect x={0} y={0} width={w} height={h}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(0, h)}
          colors={[colors.skyTop, colors.skyBottom, colors.fieldDeep]}
          positions={[0, 0.42, 0.43]}
        />
      </Rect>
      <Circle cx={w / 2} cy={h * 0.42} r={Math.max(w, h) * 0.55}>
        <RadialGradient
          c={vec(w / 2, h * 0.42)}
          r={Math.max(w, h) * 0.55}
          colors={['rgba(245,168,58,0.30)', 'rgba(245,168,58,0)']}
        />
      </Circle>
      <Oval x={-w * 0.15} y={h * 0.38} width={w * 1.3} height={h * 1.1} color={colors.field} />
      <Oval
        x={w * 0.12}
        y={h * 0.5}
        width={w * 0.76}
        height={h * 0.9}
        color="rgba(124,196,106,0.07)"
      />
      <Path path={pitch} color={colors.pitch} />
      <Path path={pitch} style="stroke" strokeWidth={2} color={colors.pitchShade} />
      <Path path={crease} style="stroke" strokeWidth={2} color={colors.crease} opacity={0.75} />
      <Group transform={rainTransform}>
        <Path
          path={streaks}
          style="stroke"
          strokeWidth={1.4}
          strokeCap="round"
          color="rgba(170,200,255,0.20)"
        />
      </Group>
    </Group>
  );
}

const STUMP_DIR = [-1, 0, 1] as const;

function Stumps({ layout: L, wicket }: { layout: ArenaLayout; wicket: SharedValue<number> }) {
  const gap = L.stumpH * 0.2;
  const sw = Math.max(3, L.stumpH * 0.085);
  return (
    <Group>
      <Oval
        x={L.stumpsX - gap * 2}
        y={L.stumpsBase - 3}
        width={gap * 4}
        height={6}
        color="rgba(0,0,0,0.28)"
      />
      {STUMP_DIR.map((d) => (
        <FlyingPiece
          key={d}
          wicket={wicket}
          x={L.stumpsX + d * gap}
          y={L.stumpsBase}
          dir={d}
          throwX={L.stumpH * 1.4}
          throwY={L.stumpH * 1.5}
          spin={1.5 + Math.abs(d) * 0.6}
        >
          <RoundedRect
            x={-sw / 2}
            y={-L.stumpH}
            width={sw}
            height={L.stumpH}
            r={sw / 2}
            color={colors.stump}
          />
          <Rect
            x={sw * 0.1}
            y={-L.stumpH}
            width={sw * 0.3}
            height={L.stumpH}
            color={colors.stumpShade}
          />
        </FlyingPiece>
      ))}
      {[-0.5, 0.5].map((d) => (
        <FlyingPiece
          key={d}
          wicket={wicket}
          x={L.stumpsX + d * gap}
          y={L.stumpsBase - L.stumpH - sw * 0.3}
          dir={d * 1.6}
          throwX={L.stumpH * 1.1}
          throwY={L.stumpH * 2.2}
          spin={4}
        >
          <RoundedRect
            x={-gap * 0.55}
            y={-sw * 0.35}
            width={gap * 1.1}
            height={sw * 0.7}
            r={sw * 0.35}
            color={colors.stump}
          />
        </FlyingPiece>
      ))}
    </Group>
  );
}

interface FlyingPieceProps {
  wicket: SharedValue<number>;
  x: number;
  y: number;
  /** -1 left, 0 straight back, 1 right. */
  dir: number;
  throwX: number;
  throwY: number;
  spin: number;
  children: ReactNode;
}

/** A stump or bail: rests at (x, y), cartwheels away along a parabola as `wicket` runs 0 → 1. */
function FlyingPiece({ wicket, x, y, dir, throwX, throwY, spin, children }: FlyingPieceProps) {
  const transform = useDerivedValue(() => {
    const t = wicket.value;
    const lean = dir === 0 ? 0.6 : dir;
    return [
      { translateX: x + dir * throwX * t },
      { translateY: y - throwY * t + throwY * 1.15 * t * t },
      { rotate: lean * spin * t },
    ];
  });
  const opacity = useDerivedValue(() => (wicket.value < 0.75 ? 1 : 1 - (wicket.value - 0.75) * 4));
  return (
    <Group transform={transform} opacity={opacity}>
      {children}
    </Group>
  );
}

function BallRing({
  layout: L,
  countdown,
  ringOn,
  impact,
}: {
  layout: ArenaLayout;
  countdown: SharedValue<number>;
  ringOn: SharedValue<number>;
  impact: SharedValue<number>;
}) {
  const r = L.ringR;
  const ring = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.addArc(Skia.XYWHRect(L.ballX - r, L.ballY - r, r * 2, r * 2), -90, 359.9);
    return b.build();
  }, [L.ballX, L.ballY, r]);
  const seam = useMemo(() => {
    const br = r * 0.62;
    const b = Skia.PathBuilder.Make();
    b.addArc(Skia.XYWHRect(L.ballX - br * 1.6, L.ballY - br, br * 2, br * 2), -38, 76);
    b.addArc(Skia.XYWHRect(L.ballX - br * 0.4, L.ballY - br, br * 2, br * 2), 142, 76);
    return b.build();
  }, [L.ballX, L.ballY, r]);
  // Marigold → kumkum as time runs out: two arcs cross-faded by plain numbers.
  const calmOpacity = useDerivedValue(() => ringOn.value * Math.min(1, countdown.value / 0.3));
  const urgentOpacity = useDerivedValue(
    () => ringOn.value * (1 - Math.min(1, countdown.value / 0.3)),
  );
  const ballScale = useDerivedValue(() => {
    const k = impact.value;
    const s = k > 0 && k < 1 ? 1 + Math.sin(k * Math.PI) * 0.22 : 1;
    return [{ scale: s }];
  });
  const shockR = useDerivedValue(() => r * (1 + impact.value * 1.4));
  const shockOpacity = useDerivedValue(() =>
    impact.value > 0 && impact.value < 1 ? (1 - impact.value) * 0.85 : 0,
  );
  const br = r * 0.62;
  return (
    <Group>
      <Circle cx={L.ballX} cy={L.ballY} r={r} color="rgba(9,12,22,0.55)" />
      <Circle
        cx={L.ballX}
        cy={L.ballY}
        r={r}
        style="stroke"
        strokeWidth={Math.max(4, r * 0.16)}
        color="rgba(255,236,210,0.10)"
      />
      <Path
        path={ring}
        style="stroke"
        strokeWidth={Math.max(4, r * 0.16)}
        strokeCap="round"
        start={0}
        end={countdown}
        color={colors.marigold}
        opacity={calmOpacity}
      />
      <Path
        path={ring}
        style="stroke"
        strokeWidth={Math.max(4, r * 0.16)}
        strokeCap="round"
        start={0}
        end={countdown}
        color={colors.kumkum}
        opacity={urgentOpacity}
      />
      <Circle
        cx={L.ballX}
        cy={L.ballY}
        r={shockR}
        style="stroke"
        strokeWidth={3}
        color={colors.crease}
        opacity={shockOpacity}
      />
      <Group transform={ballScale} origin={vec(L.ballX, L.ballY)}>
        <Circle cx={L.ballX} cy={L.ballY} r={br} color={colors.ball} />
        <Path path={seam} style="stroke" strokeWidth={1.6} color={colors.seam} />
        <Circle
          cx={L.ballX - br * 0.35}
          cy={L.ballY - br * 0.4}
          r={br * 0.28}
          color="rgba(255,255,255,0.22)"
        />
      </Group>
    </Group>
  );
}

const PARTICLES_PER_COLOR = 9;

function Particles({
  cx,
  cy,
  spread,
  progress,
  colors: palette,
  big,
}: {
  cx: number;
  cy: number;
  spread: number;
  progress: SharedValue<number>;
  colors: readonly [string, string, string];
  big: boolean;
}) {
  const opacity = useDerivedValue(() => {
    const t = progress.value;
    return t <= 0 || t >= 1 ? 0 : 1 - t * t;
  });
  return (
    <Group opacity={opacity}>
      {palette.map((color, i) => (
        <Sparks
          key={i}
          seed={i}
          cx={cx}
          cy={cy}
          spread={spread * (big ? 1.25 : 1)}
          size={big ? 1.4 : 1}
          progress={progress}
          color={color}
        />
      ))}
    </Group>
  );
}

function Sparks({
  seed,
  cx,
  cy,
  spread,
  size,
  progress,
  color,
}: {
  seed: number;
  cx: number;
  cy: number;
  spread: number;
  size: number;
  progress: SharedValue<number>;
  color: string;
}) {
  // Fixed per-particle angles/speeds (deterministic per seed so re-renders don't reshuffle).
  const shape = useMemo(() => {
    const angle: number[] = [];
    const speed: number[] = [];
    const radius: number[] = [];
    for (let i = 0; i < PARTICLES_PER_COLOR; i++) {
      const k = seed * PARTICLES_PER_COLOR + i;
      angle.push(((k * 137.508) % 360) * (Math.PI / 180));
      speed.push(0.45 + ((k * 61) % 55) / 100);
      radius.push((2.2 + ((k * 29) % 5) * 0.7) * size);
    }
    return { angle, speed, radius };
  }, [seed, size]);
  const path = usePathValue((b) => {
    'worklet';
    const t = progress.value;
    if (t <= 0 || t >= 1) return;
    for (let i = 0; i < PARTICLES_PER_COLOR; i++) {
      const a = shape.angle[i] ?? 0;
      const d = (shape.speed[i] ?? 1) * spread * t;
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d * 0.8 + spread * 0.5 * t * t;
      b.addCircle(x, y, (shape.radius[i] ?? 2) * (1 - t * 0.5));
    }
  });
  return <Path path={path} color={color} />;
}

/** Brief whole-arena shake for wickets (the Screen applies it to its root view). */
export function shakeSequence(reduceMotion: boolean) {
  if (reduceMotion) return 0;
  const step = { duration: 45 };
  return withDelay(
    IMPACT_AT_MS,
    withSequence(
      withTiming(-10, step),
      withTiming(9, step),
      withTiming(-7, step),
      withTiming(6, step),
      withTiming(-3, step),
      withTiming(0, step),
    ),
  );
}
