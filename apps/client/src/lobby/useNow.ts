import { useEffect, useRef, useState } from 'react';

/** `source()` re-read every `intervalMs` (null = no ticking), for countdowns in the lobby. */
export function useNow(intervalMs: number | null, source: () => number): number {
  const latest = useRef(source);
  latest.current = source;
  const [now, setNow] = useState(source);
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(latest.current());
    const id = setInterval(() => setNow(latest.current()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
