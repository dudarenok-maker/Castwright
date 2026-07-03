import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSetupDiagnosis } from './use-setup-diagnosis';
import * as api from './api';

describe('useSetupDiagnosis', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('fetches readiness on mount', async () => {
    const readiness = {
      ready: true, completedAt: null,
      blockers: {
        sidecar: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: 'cuda' },
    };
    vi.spyOn(api.api, 'getSetupReadiness').mockResolvedValue(readiness);
    const { result } = renderHook(() => useSetupDiagnosis());
    await vi.waitFor(() => expect(result.current.readiness).toEqual(readiness));
  });

  it('polls on the given interval', async () => {
    const spy = vi.spyOn(api.api, 'getSetupReadiness').mockResolvedValue({
      ready: true, completedAt: null,
      blockers: {
        sidecar: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: '' },
    });
    renderHook(() => useSetupDiagnosis(5_000));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetch triggers an immediate re-fetch', async () => {
    const spy = vi.spyOn(api.api, 'getSetupReadiness').mockResolvedValue({
      ready: true, completedAt: null,
      blockers: {
        sidecar: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: '' },
    });
    const { result } = renderHook(() => useSetupDiagnosis(60_000));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => result.current.refetch());
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('clears the polling interval on unmount', async () => {
    const spy = vi.spyOn(api.api, 'getSetupReadiness').mockResolvedValue({
      ready: true, completedAt: null,
      blockers: {
        sidecar: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: '' },
    });
    const { unmount } = renderHook(() => useSetupDiagnosis(5_000));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
