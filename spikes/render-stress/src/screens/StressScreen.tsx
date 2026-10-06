// Spike (a) stress screen: N particles drawn with one Skia Atlas from an RSXform buffer that a
// useFrameCallback worklet fills every frame, over an animated SkSL RuntimeEffect background, with a
// frame-time histogram computed in the same worklet.
//
// Game-loop rules from ARCH §6.4: fixed 1/60 s step with render interpolation, dt clamped to 100 ms,
// null dt (first frame / resume) counts as 0, state mutated in place in shared values, no React
// state per frame (the HUD gets a throttled scheduleOnRN twice a second).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import {
  AlphaType,
  Atlas,
  Canvas,
  ColorType,
  Fill,
  Group,
  Line,
  Path,
  Shader,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import type { SkImage, SkPath } from '@shopify/react-native-skia';
import {
  makeMutable,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  BINS,
  BIN_MS,
  STATS_LENGTH,
  binCount,
  recordFrame,
  resetStats,
  summarizeStats,
} from '../frameStats';
import type { FrameSummary } from '../frameStats';

const SPRITE = 32;
const SCALE = 0.75; // 24 px on screen
const FLOATS = 8; // x, y, prevX, prevY, vx, vy, angle, spin
const STEP_MS = 1000 / 60;
const STEP_S = 1 / 60;
const HIST_H = 90;
const HIST_MAX_MS = 60;

// control array slots
const ACC = 0;
const ELAPSED = 1;
const PHASE = 2; // 0 warm-up, 1 measuring, 2 done
const PHASE_START = 3;
const HUD_FRAMES = 4;
const TIME_S = 5;

const SKSL = `
uniform float2 iResolution;
uniform float iTime;

half4 main(float2 fragCoord) {
  float2 uv = fragCoord / iResolution;
  float t = iTime * 0.6;
  float v = sin(uv.x * 10.0 + t);
  v += sin((uv.y * 10.0 + t) * 0.5);
  v += sin((uv.x * 10.0 + uv.y * 10.0 + t) * 0.5);
  float cx = uv.x + 0.5 * sin(t / 5.0);
  float cy = uv.y + 0.5 * cos(t / 3.0);
  v += sin(sqrt(100.0 * (cx * cx + cy * cy) + 1.0) + t);
  v *= 0.5;
  float3 col = float3(sin(3.14159 * v), sin(3.14159 * v + 2.094), sin(3.14159 * v + 4.188));
  return half4(half3(0.5 + 0.5 * col) * 0.35, 1.0);
}`;

type PerfClock = { performance?: { now(): number } };

export interface StressProps {
  count: number;
  warmupMs: number;
  /** 0 = keep measuring (manual mode, HUD only). */
  measureMs: number;
  onDone?: (summary: FrameSummary) => void;
}

/** 4 soft dots in a 128x32 RGBA sheet, generated procedurally. */
function makeSpriteSheet(): SkImage | null {
  const w = SPRITE * 4;
  const bytes = new Uint8Array(w * SPRITE * 4);
  const colors = [
    [255, 196, 64],
    [96, 200, 255],
    [255, 96, 160],
    [140, 255, 140],
  ];
  for (let k = 0; k < 4; k++) {
    for (let y = 0; y < SPRITE; y++) {
      for (let x = 0; x < SPRITE; x++) {
        const dx = x + 0.5 - SPRITE / 2;
        const dy = y + 0.5 - SPRITE / 2;
        const d = Math.sqrt(dx * dx + dy * dy) / (SPRITE / 2);
        const a = d >= 1 ? 0 : Math.pow(1 - d, 0.8);
        const o = (y * w + k * SPRITE + x) * 4;
        bytes[o] = colors[k][0];
        bytes[o + 1] = colors[k][1];
        bytes[o + 2] = colors[k][2];
        bytes[o + 3] = Math.round(a * 255);
      }
    }
  }
  return Skia.Image.MakeImage(
    { width: w, height: SPRITE, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
    Skia.Data.fromBytes(bytes),
    w * 4,
  );
}

function initParticles(n: number, w: number, h: number): Float32Array {
  const p = new Float32Array(n * FLOATS);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const o = i * FLOATS;
    p[o] = rnd() * w;
    p[o + 1] = rnd() * h;
    p[o + 2] = p[o];
    p[o + 3] = p[o + 1];
    const a = rnd() * Math.PI * 2;
    const speed = 60 + rnd() * 240; // px/s
    p[o + 4] = Math.cos(a) * speed;
    p[o + 5] = Math.sin(a) * speed;
    p[o + 6] = rnd() * Math.PI * 2;
    p[o + 7] = (rnd() - 0.5) * 6; // rad/s
  }
  return p;
}

function HudText({ register }: { register: (fn: (s: FrameSummary) => void) => void }) {
  const [s, setS] = useState<FrameSummary | null>(null);
  useEffect(() => register(setS), [register]);
  if (!s) return <Text style={styles.hud}>warming up…</Text>;
  return (
    <Text style={styles.hud}>
      {`${s.meanFps.toFixed(1)} fps  p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  p99 ${s.p99.toFixed(2)} ms\n` +
        `>20ms ${s.pctOver20.toFixed(2)}%  >33ms ${s.pctOver33.toFixed(2)}%  max ${s.maxMs.toFixed(1)}  work ${s.workMeanMs.toFixed(2)}/${s.workMaxMs.toFixed(2)} ms  n=${s.frames}`}
    </Text>
  );
}

function StressCanvas({
  count,
  warmupMs,
  measureMs,
  onDone,
  width,
  height,
}: StressProps & { width: number; height: number }) {
  const sprite = useMemo(makeSpriteSheet, []);
  const effect = useMemo(() => Skia.RuntimeEffect.Make(SKSL), []);
  const sprites = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => Skia.XYWHRect((i % 4) * SPRITE, 0, SPRITE, SPRITE)),
    [count],
  );
  const xforms = useMemo(
    () => makeMutable(Array.from({ length: count }, () => Skia.RSXform(1, 0, 0, 0))),
    [count],
  );
  const sim = useSharedValue(initParticles(count, width, height));
  const control = useSharedValue(new Float64Array(8));
  const stats = useSharedValue(new Float64Array(STATS_LENGTH));
  const time = useSharedValue(0);
  const histPath = useSharedValue<SkPath>(Skia.Path.Make());

  const hudSetter = useRef<((s: FrameSummary) => void) | null>(null);
  const register = useCallback((fn: (s: FrameSummary) => void) => {
    hudSetter.current = fn;
  }, []);
  const pushHud = useCallback((s: FrameSummary) => hudSetter.current?.(s), []);
  const finish = useCallback((s: FrameSummary) => onDone?.(s), [onDone]);

  const uniforms = useDerivedValue(() => ({ iResolution: [width, height], iTime: time.value }));

  const frame = useCallback(
    (info: { timeSincePreviousFrame: number | null }) => {
      'worklet';
      const perf = (globalThis as PerfClock).performance;
      const t0 = perf !== undefined ? perf.now() : -1;
      const ctl = control.value;
      const raw = info.timeSincePreviousFrame;
      const dt = raw === null ? 0 : Math.min(raw, 100);
      const p = sim.value;
      const n = count;

      // fixed-step simulation
      ctl[ACC] += dt;
      while (ctl[ACC] >= STEP_MS) {
        for (let i = 0; i < n; i++) {
          const o = i * FLOATS;
          p[o + 2] = p[o];
          p[o + 3] = p[o + 1];
          let x = p[o] + p[o + 4] * STEP_S;
          let y = p[o + 1] + p[o + 5] * STEP_S;
          if (x < 0) {
            x = -x;
            p[o + 4] = -p[o + 4];
          } else if (x > width) {
            x = 2 * width - x;
            p[o + 4] = -p[o + 4];
          }
          if (y < 0) {
            y = -y;
            p[o + 5] = -p[o + 5];
          } else if (y > height) {
            y = 2 * height - y;
            p[o + 5] = -p[o + 5];
          }
          p[o] = x;
          p[o + 1] = y;
          p[o + 6] += p[o + 7] * STEP_S;
        }
        ctl[ACC] -= STEP_MS;
      }

      // interpolated render state into the RSXform buffer (in place, then one notify)
      const alpha = ctl[ACC] / STEP_MS;
      const arr = xforms.value;
      const c = SPRITE / 2;
      for (let i = 0; i < n; i++) {
        const o = i * FLOATS;
        const x = p[o + 2] + (p[o] - p[o + 2]) * alpha;
        const y = p[o + 3] + (p[o + 1] - p[o + 3]) * alpha;
        const scos = Math.cos(p[o + 6]) * SCALE;
        const ssin = Math.sin(p[o + 6]) * SCALE;
        arr[i].set(scos, ssin, x - (scos * c - ssin * c), y - (ssin * c + scos * c));
      }
      xforms.modify(undefined, true);
      ctl[TIME_S] += dt / 1000;
      time.value = ctl[TIME_S];

      const work = t0 >= 0 && perf !== undefined ? perf.now() - t0 : -1;

      // measurement phases
      if (raw === null) return;
      ctl[ELAPSED] += raw;
      const s = stats.value;
      if (ctl[PHASE] === 0) {
        if (ctl[ELAPSED] >= warmupMs) {
          resetStats(s);
          ctl[PHASE] = 1;
          ctl[PHASE_START] = ctl[ELAPSED];
        }
      } else if (ctl[PHASE] === 1) {
        recordFrame(s, raw, work);
        if (measureMs > 0 && ctl[ELAPSED] - ctl[PHASE_START] >= measureMs) {
          ctl[PHASE] = 2;
          scheduleOnRN(finish, summarizeStats(s));
        }
      }

      // HUD + histogram twice a second
      ctl[HUD_FRAMES] += 1;
      if (ctl[HUD_FRAMES] >= 30 && ctl[PHASE] >= 1) {
        ctl[HUD_FRAMES] = 0;
        scheduleOnRN(pushHud, summarizeStats(s));
        const perMs = Math.round(1 / BIN_MS);
        const buckets = HIST_MAX_MS;
        let peak = 1;
        for (let b = 0; b < buckets; b++) {
          let v = 0;
          for (let k = 0; k < perMs; k++) v += binCount(s, b * perMs + k);
          if (v > peak) peak = v;
        }
        const path = Skia.Path.Make();
        const bw = width / buckets;
        for (let b = 0; b < buckets && b * perMs < BINS; b++) {
          let v = 0;
          for (let k = 0; k < perMs; k++) v += binCount(s, b * perMs + k);
          if (v > 0) {
            const bh = Math.max(1, (v / peak) * HIST_H);
            path.addRect(Skia.XYWHRect(b * bw, height - bh, bw - 1, bh));
          }
        }
        histPath.value = path;
      }
    },
    [
      control,
      sim,
      stats,
      xforms,
      time,
      histPath,
      count,
      width,
      height,
      warmupMs,
      measureMs,
      finish,
      pushHud,
    ],
  );
  useFrameCallback(frame);

  const x16 = (16.7 / HIST_MAX_MS) * width;
  const x33 = (33.3 / HIST_MAX_MS) * width;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Canvas style={StyleSheet.absoluteFill}>
        {effect ? (
          <Fill>
            <Shader source={effect} uniforms={uniforms} />
          </Fill>
        ) : (
          <Fill color="#101018" />
        )}
        <Atlas image={sprite} sprites={sprites} transforms={xforms} />
        <Group>
          <Path path={histPath} color="rgba(255,255,255,0.85)" />
          <Line p1={vec(x16, height - HIST_H)} p2={vec(x16, height)} color="#4f4" strokeWidth={1} />
          <Line p1={vec(x33, height - HIST_H)} p2={vec(x33, height)} color="#f44" strokeWidth={1} />
        </Group>
      </Canvas>
      <HudText register={register} />
      <Text
        style={styles.histLabel}
      >{`frame-time histogram 0-${HIST_MAX_MS} ms (green 16.7, red 33.3)`}</Text>
    </View>
  );
}

export function StressScreen(props: StressProps) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) => prev ?? { w: Math.round(width), h: Math.round(height) });
  }, []);
  return (
    <View style={styles.fill} onLayout={onLayout} testID={`stress-${props.count}`}>
      {size ? <StressCanvas {...props} width={size.w} height={size.h} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  hud: {
    position: 'absolute',
    left: 8,
    top: 8,
    right: 8,
    color: '#fff',
    fontSize: 12,
    fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.55)',
    padding: 4,
  },
  histLabel: { position: 'absolute', left: 8, bottom: HIST_H + 4, color: '#ccc', fontSize: 10 },
});
