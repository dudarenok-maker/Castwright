import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useQaReport } from './use-qa-report';
import { MOCK_QA_REPORT } from '../data/qa-report';

vi.mock('../lib/api', () => ({ api: { getQaReport: vi.fn(async () => MOCK_QA_REPORT) } }));

describe('useQaReport', () => {
  it('fetches on mount and exposes the report', async () => {
    const { result } = renderHook(() => useQaReport('b1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.report).toEqual(MOCK_QA_REPORT);
    expect(result.current.error).toBe(false);
  });
});
