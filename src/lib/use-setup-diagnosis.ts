/* fs-21 wave 4 — shared readiness poller consumed by BOTH the Setup wizard
   and the Status popover, so there is one diagnosis engine, not two that
   can drift apart (spec Decision 1). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { SetupReadiness } from './api';

const DEFAULT_POLL_MS = 10_000;

export function useSetupDiagnosis(pollMs: number = DEFAULT_POLL_MS): {
  readiness: SetupReadiness | null;
  refetch: () => void;
} {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNow = useCallback(() => {
    api.getSetupReadiness().then(setReadiness).catch(() => {});
  }, []);

  useEffect(() => {
    fetchNow();
    timerRef.current = setInterval(fetchNow, pollMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchNow, pollMs]);

  return { readiness, refetch: fetchNow };
}
