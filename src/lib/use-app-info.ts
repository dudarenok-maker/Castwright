/* fs-1 — useAppInfo(): fetch GET /api/info on mount and poll, exposing the
   server-authoritative app version, the sidecar version, and the what's-new
   state. The version pill and the what's-new banner both read this. A manual
   refresh() lets the upgrade overlay re-probe right after a restart so it can
   detect the version flip. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AppInfo } from './types';

const POLL_MS = 30_000;

export interface UseAppInfo {
  info: AppInfo | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAppInfo(pollMs: number = POLL_MS): UseAppInfo {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getAppInfo();
      if (!cancelled.current) {
        setInfo(data);
        setError(null);
      }
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : 'Failed to load app info');
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => {
      cancelled.current = true;
      clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { info, error, refresh };
}
