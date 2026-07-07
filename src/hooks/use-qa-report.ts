import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { BookQaReport } from '../lib/types';

export function useQaReport(bookId: string) {
  const [report, setReport] = useState<BookQaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  /* Guards against an out-of-order response: if `bookId` changes while a
     fetch is in flight, the earlier request's resolution must not clobber
     state a newer request already set. Tracks the current request via a
     generation counter and only commits state if this call is still the
     latest one when it resolves. */
  const requestIdRef = useRef(0);

  const fetchReport = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(false);
    try {
      const r = await api.getQaReport(bookId);
      if (requestIdRef.current === requestId) setReport(r);
    } catch {
      if (requestIdRef.current === requestId) setError(true);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  return { report, loading, error, refetch: fetchReport };
}
