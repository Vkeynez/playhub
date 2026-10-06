// Entry: load Skia (CanvasKit on web) first, then evaluate the modules that touch Skia.
import { Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { loadSkia } from './src/loadSkia';
import { report } from './src/report';

const SpikeApp = lazy(async () => {
  try {
    const info = await loadSkia();
    report('skia-load', info);
  } catch (e) {
    report('skia-load-error', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    throw e;
  }
  return import('./src/SpikeApp');
});

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  componentDidCatch(e: unknown) {
    report(
      'render-error',
      e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e),
    );
  }
  render() {
    if (this.state.error) {
      return (
        <View style={styles.center}>
          <Text style={styles.err} testID="error">
            {this.state.error}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <View style={styles.center}>
            <Text style={styles.msg}>Loading Skia…</Text>
          </View>
        }
      >
        <SpikeApp />
      </Suspense>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  msg: { color: '#fff' },
  err: { color: '#f88', padding: 16 },
});
