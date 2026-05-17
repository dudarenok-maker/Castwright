/* Pin the contract of useTtsLifecycle so a future refactor that consolidates
   it with Generation view's local pill (or hoists state to Redux) can't
   silently regress: the load flow must auto-evict the analyzer FIRST, set
   the eviction banner only if the analyzer was actually resident, then
   load TTS; the stop flow unloads TTS and clears notices. */

import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSidecarHealth: vi.fn(),
    getOllamaHealth: vi.fn(),
    unloadAnalyzer: vi.fn(),
    loadSidecar: vi.fn(),
    unloadSidecar: vi.fn(),
  },
}));

vi.mock('./api', () => ({ api: mocks }));

import { useTtsLifecycle } from './use-tts-lifecycle';

beforeEach(() => {
  mocks.getSidecarHealth.mockResolvedValue({
    status: 'reachable',
    url: '',
    loading: false,
    modelLoaded: false,
  });
  mocks.getOllamaHealth.mockResolvedValue({
    status: 'reachable',
    modelResident: true,
  });
  mocks.unloadAnalyzer.mockResolvedValue({ status: 'ok' });
  mocks.loadSidecar.mockResolvedValue({ status: 'ok' });
  mocks.unloadSidecar.mockResolvedValue({ status: 'ok' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useTtsLifecycle', () => {
  it('starts in "idle" state before the first probe completes', () => {
    const { result } = renderHook(() => useTtsLifecycle());
    /* Synchronous initial render: probe has fired but hasn't resolved yet. */
    expect(result.current.state).toBe('idle');
  });

  it('flips to "ready" when /health reports modelLoaded=true', async () => {
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: true,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('ready'));
  });

  it('flips to "unreachable" when /health rejects', async () => {
    mocks.getSidecarHealth.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('unreachable'));
  });

  it('onLoad auto-evicts the analyzer and surfaces the eviction banner when analyzer WAS resident', async () => {
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('idle'));

    await act(async () => {
      await result.current.onLoad();
    });

    expect(mocks.unloadAnalyzer).toHaveBeenCalledOnce();
    expect(mocks.loadSidecar).toHaveBeenCalledOnce();
    expect(result.current.evictionNotice).toBe('Analyzer unloaded to free VRAM for TTS.');
  });

  it('onLoad does NOT surface the eviction banner when analyzer was already unloaded', async () => {
    mocks.getOllamaHealth.mockResolvedValueOnce({
      status: 'reachable',
      modelResident: false,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('idle'));

    await act(async () => {
      await result.current.onLoad();
    });

    /* unloadAnalyzer still fires (idempotent) but the banner stays off
       because we only show it when the unload actually freed something. */
    expect(mocks.unloadAnalyzer).toHaveBeenCalledOnce();
    expect(result.current.evictionNotice).toBeNull();
  });

  it('onLoad surfaces a load-error banner when loadSidecar returns status=error', async () => {
    mocks.loadSidecar.mockResolvedValueOnce({ status: 'error', error: 'weights missing' });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('idle'));

    await act(async () => {
      await result.current.onLoad();
    });

    expect(result.current.loadErrorNotice).toBe('weights missing');
  });

  it('onLoad surfaces a load-error banner when loadSidecar throws', async () => {
    mocks.loadSidecar.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('idle'));

    await act(async () => {
      await result.current.onLoad();
    });

    expect(result.current.loadErrorNotice).toMatch(/connect ECONNREFUSED/);
  });

  it('onStop calls unloadSidecar and clears any prior notices', async () => {
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('idle'));

    /* Plant a notice via onLoad first, then verify onStop clears it. */
    await act(async () => {
      await result.current.onLoad();
    });
    expect(result.current.evictionNotice).not.toBeNull();

    await act(async () => {
      await result.current.onStop();
    });
    expect(mocks.unloadSidecar).toHaveBeenCalledOnce();
    expect(result.current.evictionNotice).toBeNull();
    expect(result.current.loadErrorNotice).toBeNull();
  });

  it('dismissNotices clears both banner strings without calling the API', async () => {
    mocks.loadSidecar.mockResolvedValueOnce({ status: 'error', error: 'X' });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.state).toBe('idle'));

    await act(async () => {
      await result.current.onLoad();
    });
    expect(result.current.loadErrorNotice).toBe('X');

    const callsBefore = mocks.loadSidecar.mock.calls.length + mocks.unloadSidecar.mock.calls.length;
    act(() => {
      result.current.dismissNotices();
    });
    expect(result.current.evictionNotice).toBeNull();
    expect(result.current.loadErrorNotice).toBeNull();
    const callsAfter = mocks.loadSidecar.mock.calls.length + mocks.unloadSidecar.mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });
});
