// Spike (d) on device: the planck carrom bench on the JS thread (Hermes on Android, V8 on web).
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { runCarromBenchAsync } from '../carrom/carromBench';
import type { BenchSummary } from '../carrom/carromBench';

export interface BenchReport {
  engine: string;
  results: BenchSummary[];
  error?: string;
}

type HermesGlobal = typeof globalThis & {
  HermesInternal?: { getRuntimeProperties?: () => Record<string, string> };
};

export function jsEngine(): string {
  const h = (globalThis as HermesGlobal).HermesInternal;
  if (!h) return 'not-hermes';
  const props = h.getRuntimeProperties?.() ?? {};
  return `hermes ${props['OSS Release Version'] ?? ''} ${props['Build'] ?? ''}`.trim();
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const now = () => performance.now();

export function BenchScreen({ onDone }: { onDone?: (r: BenchReport) => void }) {
  const [status, setStatus] = useState('starting…');
  const [results, setResults] = useState<BenchSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const configs = [
        { allBullets: true, mu: 0.18 },
        { allBullets: false, mu: 0.18 },
      ];
      const out: BenchSummary[] = [];
      try {
        for (const c of configs) {
          const r = await runCarromBenchAsync(
            { shots: 100, warmupShots: 10, seed: 1, now, ...c },
            yieldToUi,
            (done, total) => {
              if (!cancelled && done % 10 === 0)
                setStatus(`bullets=${c.allBullets}: ${done}/${total}`);
            },
          );
          if (cancelled) return;
          out.push(r);
          setResults([...out]);
        }
      } catch (e) {
        // A release build swallows unhandled rejections, so report the failure explicitly.
        const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        setStatus(`error: ${error}`);
        onDone?.({ engine: jsEngine(), results: out, error });
        return;
      }
      setStatus('done');
      onDone?.({ engine: jsEngine(), results: out });
    })();
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  return (
    <View style={styles.fill} testID="bench">
      <Text style={styles.t}>{`planck carrom bench (${jsEngine()}) — ${status}`}</Text>
      {results.map((r) => (
        <Text key={String(r.allBullets)} style={styles.t}>
          {`bullets=${r.allBullets} mu=${r.mu}: ${r.msPerShot.mean.toFixed(2)} ms/shot (p50 ${r.msPerShot.p50.toFixed(2)}, p95 ${r.msPerShot.p95.toFixed(2)}, max ${r.msPerShot.max.toFixed(2)}), ` +
            `${r.stepsPerShot.mean.toFixed(1)} steps/shot, ${(r.msPerStep * 1000).toFixed(1)} µs/step`}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#101010', padding: 12 },
  t: { color: '#fff', fontSize: 13, fontFamily: 'monospace', marginBottom: 8 },
});
