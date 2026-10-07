// "Waking up the game server…" state (ARCHITECTURE §6.7): shown while any server-dependent request
// is slow or waiting for /health. A counter, so overlapping requests share one banner.
import { useSyncExternalStore } from 'react';

type Listener = () => void;

function createWakeStore() {
  let pending = 0;
  const listeners = new Set<Listener>();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  return {
    begin() {
      pending += 1;
      if (pending === 1) emit();
    },
    end() {
      if (pending === 0) return;
      pending -= 1;
      if (pending === 0) emit();
    },
    isWaking: () => pending > 0,
    subscribe(fn: Listener) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export const wakeStore = createWakeStore();

export function useWaking(): boolean {
  return useSyncExternalStore(wakeStore.subscribe, wakeStore.isWaking, wakeStore.isWaking);
}
