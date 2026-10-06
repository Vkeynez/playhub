// Platform hooks for the Hand Cricket screen: haptics (pluggable) and web keyboard input.
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

export type HapticKind = 'tap' | 'thunk' | 'six' | 'wicket';

type HapticImpl = (kind: HapticKind) => void;

const VIBRATE_MS: Record<HapticKind, number | number[]> = {
  tap: 8,
  thunk: 18,
  six: [12, 40, 24],
  wicket: [30, 50, 60],
};

/** Web default: the Vibration API where it exists (Android Chrome); silent elsewhere. */
const webVibrate: HapticImpl = (kind) => {
  const nav = (globalThis as { navigator?: { vibrate?: (p: number | number[]) => boolean } })
    .navigator;
  try {
    nav?.vibrate?.(VIBRATE_MS[kind]);
  } catch {
    // Blocked until the first user gesture in some browsers: ignore.
  }
};

let impl: HapticImpl = Platform.OS === 'web' ? webVibrate : () => undefined;

/** The shell can plug in expo-haptics (native) here; the game only calls `haptic(kind)`. */
export function setHaptics(next: HapticImpl): void {
  impl = next;
}

export function haptic(kind: HapticKind): void {
  impl(kind);
}

interface KeyEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  target: unknown;
  preventDefault(): void;
}

interface KeyTarget {
  addEventListener(type: 'keydown', fn: (e: KeyEventLike) => void): void;
  removeEventListener(type: 'keydown', fn: (e: KeyEventLike) => void): void;
}

/** Web only: calls `onKey` with the pressed key (ignores modified keys and text inputs). */
export function useWebKeys(onKey: (key: string) => boolean): void {
  const handler = useRef(onKey);
  handler.current = onKey;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const doc = (globalThis as { document?: KeyTarget }).document;
    if (!doc) return;
    const listener = (e: KeyEventLike) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const tag = (e.target as { tagName?: string } | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (handler.current(e.key)) e.preventDefault();
    };
    doc.addEventListener('keydown', listener);
    return () => doc.removeEventListener('keydown', listener);
  }, []);
}
