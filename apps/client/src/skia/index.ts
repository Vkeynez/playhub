// Skia readiness for game screens: `ensureSkia()` starts loading (once per page), `useSkiaReady()`
// re-renders when it settles. On native both resolve immediately.
import { useSyncExternalStore } from 'react';

import { loadSkiaPlatform } from './loader';

export type SkiaStatus = 'idle' | 'loading' | 'ready' | 'error';

let status: SkiaStatus = 'idle';
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setStatus(next: SkiaStatus): void {
  status = next;
  for (const fn of listeners) fn();
}

export function ensureSkia(): Promise<void> {
  pending ??= (async () => {
    setStatus('loading');
    try {
      await loadSkiaPlatform();
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      throw error;
    }
  })();
  return pending;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSkiaStatus(): SkiaStatus {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => status,
  );
}

/** True once Skia can be used (CanvasKit loaded on web). GameHost loads it before a Skia game's UI. */
export function useSkiaReady(): boolean {
  return useSkiaStatus() === 'ready';
}
