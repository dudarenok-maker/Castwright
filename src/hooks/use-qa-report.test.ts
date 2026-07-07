import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useQaReport } from './use-qa-report';
import { MOCK_QA_REPORT } from '../data/qa-report';
import { api } from '../lib/api';
import type { BookQaReport } from '../lib/types';

vi.mock('../lib/api', () => ({ api: { getQaReport: vi.fn(async () => MOCK_QA_REPORT) } }));

describe('useQaReport', () => {
  it('fetches on mount and exposes the report', async () => {
    const { result } = renderHook(() => useQaReport('b1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.report).toEqual(MOCK_QA_REPORT);
    expect(result.current.error).toBe(false);
  });

  it('sets error and clears loading when the fetch rejects', async () => {
    vi.mocked(api.getQaReport).mockImplementationOnce(async () => {
      throw new Error('network error');
    });
    const { result } = renderHook(() => useQaReport('b1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.report).toBeNull();
  });

  it('ignores a stale response when bookId changes mid-flight', async () => {
    const reportA: BookQaReport = { ...MOCK_QA_REPORT, bookId: 'a' };
    const reportB: BookQaReport = { ...MOCK_QA_REPORT, bookId: 'b' };

    /* Book A's request resolves AFTER book B's — out-of-order network
       timing. Deferred promises let the test control resolution order
       explicitly rather than relying on timer/microtask ordering. */
    let resolveA!: (r: BookQaReport) => void;
    let resolveB!: (r: BookQaReport) => void;
    const pendingA = new Promise<BookQaReport>((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise<BookQaReport>((resolve) => {
      resolveB = resolve;
    });

    vi.mocked(api.getQaReport).mockImplementation(async (id: string) =>
      id === 'a' ? pendingA : pendingB,
    );

    const { result, rerender } = renderHook(({ bookId }) => useQaReport(bookId), {
      initialProps: { bookId: 'a' },
    });
    rerender({ bookId: 'b' });

    /* Resolve out of order: B first, then the stale A. */
    resolveB(reportB);
    await waitFor(() => expect(result.current.report).toEqual(reportB));
    resolveA(reportA);

    /* Give the stale A resolution every chance to (wrongly) land before
       asserting it didn't — flush microtasks/macrotasks repeatedly rather
       than a single racy setTimeout(0). */
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(result.current.report).toEqual(reportB);
  });
});
