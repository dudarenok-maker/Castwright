/* fs-1 — pin useAppInfo: fetches on mount, exposes info, refresh re-fetches,
   errors are captured. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('./api', () => ({ api: { getAppInfo: vi.fn() } }));
import { api } from './api';
import { useAppInfo } from './use-app-info';

const INFO = {
  appVersion: '1.6.0',
  sidecarVersion: '1.6.0',
  schemas: { state: 1 },
  lastSeenAppVersion: '1.6.0',
  showWhatsNew: false,
  releaseNotes: '',
};

beforeEach(() => vi.clearAllMocks());

describe('useAppInfo', () => {
  it('fetches on mount and exposes the info', async () => {
    vi.mocked(api.getAppInfo).mockResolvedValue(INFO);
    const { result } = renderHook(() => useAppInfo(1_000_000)); // long poll → no extra ticks
    await waitFor(() => expect(result.current.info).toEqual(INFO));
    expect(result.current.error).toBeNull();
  });

  it('captures a fetch error', async () => {
    vi.mocked(api.getAppInfo).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAppInfo(1_000_000));
    await waitFor(() => expect(result.current.error).toBe('boom'));
  });

  it('refresh() re-fetches', async () => {
    vi.mocked(api.getAppInfo).mockResolvedValue(INFO);
    const { result } = renderHook(() => useAppInfo(1_000_000));
    await waitFor(() => expect(result.current.info).toEqual(INFO));
    vi.mocked(api.getAppInfo).mockClear();
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.getAppInfo).toHaveBeenCalledTimes(1);
  });
});
