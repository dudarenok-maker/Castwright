import { useEffect, useState } from 'react';

/** Whole seconds elapsed since `since` (ms epoch); 0 when undefined. Ticks
    ~1×/s so callers re-render a live counter without server chatter. */
export function useElapsed(since: number | undefined): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === undefined) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (since === undefined) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}
