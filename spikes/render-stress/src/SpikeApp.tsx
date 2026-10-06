// Spike shell. Auto mode (default; `?auto=0` on web turns it off) runs:
//   Tamil sample -> stress 500 / 1000 / 2000 / 4000 / 500 again (2 s warm-up + 10 s measured each) -> planck bench
// and reports every result through report(). The toolbar runs any part by hand (owner's phone).
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AppState,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { readReport, report } from './report';
import type { FrameSummary } from './frameStats';
import { StressScreen } from './screens/StressScreen';
import { TamilScreen } from './screens/TamilScreen';
import type { TamilReport } from './screens/TamilScreen';
import { BenchScreen, jsEngine } from './screens/BenchScreen';
import type { BenchReport } from './screens/BenchScreen';

type Step = 'menu' | 'tamil' | 'bench' | 'done' | { stress: number; tag?: string };

const AUTO_STEPS: Step[] = [
  'tamil',
  { stress: 500 },
  { stress: 1000 },
  { stress: 2000 },
  { stress: 4000 },
  // Repeat of 500 after the heavy runs: tells a warm-up effect after launch apart from particle count.
  { stress: 500, tag: 'again' },
  'bench',
  'done',
];
const WARMUP_MS = 2000;
const MEASURE_MS = 10000;

function autoEnabled(): boolean {
  if (Platform.OS !== 'web') return true;
  return new URLSearchParams(window.location.search).get('auto') !== '0';
}

function label(step: Step): string {
  if (typeof step === 'string') return step;
  return step.tag ? `stress-${step.stress}-${step.tag}` : `stress-${step.stress}`;
}

export default function SpikeApp() {
  const { width, height } = useWindowDimensions();
  const [auto, setAuto] = useState(autoEnabled);
  const [index, setIndex] = useState(0);
  const [manual, setManual] = useState<Step>('menu');
  // The CanvasKit load result (web) is shown on the menu so a phone run needs no devtools.
  const [log, setLog] = useState<string[]>(() => {
    const load = readReport('skia-load');
    return load ? [`skia-load: ${JSON.stringify(load)}`] : [];
  });
  const step: Step = auto ? AUTO_STEPS[index] : manual;

  useEffect(() => {
    report('env', {
      platform: Platform.OS,
      version: Platform.Version,
      engine: jsEngine(),
      window: { width, height },
      pixelRatio: PixelRatio.get(),
      model:
        Platform.OS === 'android' ? (Platform.constants as { Model?: string }).Model : undefined,
    });
    // Reported once at start-up.
  }, []);

  // A run is only valid if the app stayed in the foreground: on Android, RN pauses JS timers in the
  // background and Skia has no surface, so any change is logged next to the results.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => report('appstate', s));
    return () => sub.remove();
  }, []);

  const advance = useCallback(() => {
    if (auto) setIndex((i) => Math.min(i + 1, AUTO_STEPS.length - 1));
    else setManual('menu');
  }, [auto]);

  const onStress = useCallback(
    (name: string) => (s: FrameSummary) => {
      report(name, s);
      setLog((l) => [
        ...l,
        `${name}: ${s.meanFps.toFixed(1)} fps p50 ${s.p50} p95 ${s.p95} p99 ${s.p99} >33 ${s.pctOver33.toFixed(2)}% work ${s.workMeanMs.toFixed(2)} ms`,
      ]);
      advance();
    },
    [advance],
  );
  const onTamil = useCallback(
    (r: TamilReport) => {
      report('tamil', r);
      setLog((l) => [
        ...l,
        `tamil: ${r.rows.map((x) => x.ratio).join(' / ')} (shaped/unshaped width)`,
      ]);
      if (auto) advance(); // manual: keep the Tamil screen up for a visual check
    },
    [auto, advance],
  );
  const onBench = useCallback(
    (r: BenchReport) => {
      report('bench', r);
      setLog((l) => [
        ...l,
        ...r.results.map(
          (x) =>
            `bench bullets=${x.allBullets}: ${x.msPerShot.mean.toFixed(2)} ms/shot, ${x.stepsPerShot.mean.toFixed(1)} steps`,
        ),
      ]);
      advance();
    },
    [advance],
  );

  useEffect(() => {
    if (auto && step === 'done') report('done', true);
  }, [auto, step]);

  let body: ReactNode = null;
  if (step === 'tamil') body = <TamilScreen onDone={onTamil} />;
  else if (step === 'bench') body = <BenchScreen onDone={onBench} />;
  else if (typeof step === 'object') {
    body = (
      <StressScreen
        key={label(step)}
        count={step.stress}
        warmupMs={WARMUP_MS}
        measureMs={auto ? MEASURE_MS : 0}
        onDone={auto ? onStress(label(step)) : undefined}
      />
    );
  } else {
    body = (
      <View style={styles.log} testID={step === 'done' ? 'done' : 'menu'}>
        <Text style={styles.logTitle}>{step === 'done' ? 'Auto run finished' : 'Pick a test'}</Text>
        {log.map((l, i) => (
          <Text key={i} style={styles.logLine}>
            {l}
          </Text>
        ))}
      </View>
    );
  }

  const go = (s: Step) => {
    setAuto(false);
    setManual(s);
  };
  const buttons: Array<[string, () => void]> = [
    ['Tamil', () => go('tamil')],
    ['500', () => go({ stress: 500 })],
    ['1000', () => go({ stress: 1000 })],
    ['2000', () => go({ stress: 2000 })],
    ['4000', () => go({ stress: 4000 })],
    ['Bench', () => go('bench')],
    [
      'Auto',
      () => {
        setLog([]);
        setIndex(0);
        setAuto(true);
      },
    ],
  ];

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden />
      <View style={styles.bar}>
        {buttons.map(([t, fn]) => (
          <Pressable key={t} onPress={fn} style={styles.btn}>
            <Text style={styles.btnText}>{t}</Text>
          </Pressable>
        ))}
        <Text style={styles.step}>{auto ? `auto: ${label(step)}` : label(step)}</Text>
      </View>
      <View style={styles.body}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingTop: 28,
    paddingHorizontal: 4,
    backgroundColor: '#222',
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    margin: 3,
    backgroundColor: '#444',
    borderRadius: 4,
  },
  btnText: { color: '#fff', fontSize: 13 },
  step: { color: '#9f9', fontSize: 12, marginLeft: 6 },
  body: { flex: 1 },
  log: { flex: 1, padding: 12, backgroundColor: '#111' },
  logTitle: { color: '#fff', fontSize: 16, marginBottom: 8 },
  logLine: { color: '#ddd', fontSize: 12, fontFamily: 'monospace', marginBottom: 4 },
});
