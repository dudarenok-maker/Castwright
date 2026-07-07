import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { BookQaReport } from '../lib/types';

export function useQaReport(bookId: string) {
  const [report, setReport] = useState<BookQaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await api.getQaReport(bookId);
      setReport(r);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  return { report, loading, error, refetch: fetchReport };
}
