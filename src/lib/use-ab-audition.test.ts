/* useAbAudition (plan 161) — the A/B playback orchestration extracted from
   CompareCastModal. Asserts the per-side loading rows, the click-again-to-stop
   toggle, the Auto A→B sequence ordering (A.play → playUntilEnded → B.play),
   that a cancel breaks the sequence, and that a side error surfaces on the row
   + footer. The playback singleton is a hand-rolled fake whose currentUrl /
   isPlaying we mutate to drive `isSidePlaying`. */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAbAudition, type AbSide } from './use-ab-audition';

function makePlayback() {
  return {
    currentUrl: null as string | null,
    isPlaying: false,
    play: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    playUntilEnded: vi.fn(async () => ({ cancelled: false })),
  };
}

function sides(order: string[], opts?: { aThrows?: boolean }): Record<'a' | 'b', AbSide> {
  return {
    a: {
      matchUrl: '/audio/voices/cur-',
      matchMode: 'prefix',
      play: vi.fn(async () => {
        order.push('a');
        if (opts?.aThrows) throw new Error('boom');
      }),
    },
    b: {
      matchUrl: 'https://blob/proposed.mp3',
      matchMode: 'exact',
      play: vi.fn(async () => {
        order.push('b');
      }),
    },
  };
}

describe('useAbAudition', () => {
  it('runs a side and clears its loading row', async () => {
    const playback = makePlayback();
    const order: string[] = [];
    const s = sides(order);
    const { result } = renderHook(() => useAbAudition({ sides: s, playback }));

    await act(async () => {
      await result.current.playSide('a');
    });
    expect(s.a.play).toHaveBeenCalledTimes(1);
    expect(result.current.rowState.a.loading).toBeFalsy();
    expect(result.current.rowState.a.error).toBeUndefined();
  });

  it('stop-toggles when the clicked side is already playing', async () => {
    const playback = makePlayback();
    playback.isPlaying = true;
    playback.currentUrl = '/audio/voices/cur-abc123.mp3'; // matches side a prefix
    const s = sides([]);
    const { result } = renderHook(() => useAbAudition({ sides: s, playback }));

    await act(async () => {
      await result.current.playSide('a');
    });
    expect(playback.stop).toHaveBeenCalledTimes(1);
    expect(s.a.play).not.toHaveBeenCalled();
  });

  it('Auto A→B plays A, waits for it to end, then plays B', async () => {
    const playback = makePlayback();
    const order: string[] = [];
    const s = sides(order);
    const { result } = renderHook(() => useAbAudition({ sides: s, playback }));

    await act(async () => {
      await result.current.runAuto();
    });
    expect(order).toEqual(['a', 'b']);
    expect(playback.playUntilEnded).toHaveBeenCalled();
  });

  it('breaks the Auto sequence when a side errors and surfaces it on the footer', async () => {
    const playback = makePlayback();
    const order: string[] = [];
    const s = sides(order, { aThrows: true });
    const { result } = renderHook(() => useAbAudition({ sides: s, playback }));

    await act(async () => {
      await result.current.runAuto();
    });
    await waitFor(() => expect(result.current.footerError).toBe('boom'));
    expect(result.current.rowState.a.error).toBe('boom');
    expect(order).toEqual(['a']); // B never reached
  });

  it('playSide surfaces a failing side on the row AND the footer (regression: Side A errors were swallowed)', async () => {
    const playback = makePlayback();
    const s = sides([], { aThrows: true });
    const { result } = renderHook(() => useAbAudition({ sides: s, playback }));

    await act(async () => {
      await result.current.playSide('a');
    });
    expect(result.current.rowState.a.error).toBe('boom');
    expect(result.current.footerError).toBe('boom');
  });

  it('stopAndCancel stops playback', () => {
    const playback = makePlayback();
    playback.isPlaying = true;
    const { result } = renderHook(() => useAbAudition({ sides: sides([]), playback }));
    act(() => result.current.stopAndCancel());
    expect(playback.stop).toHaveBeenCalledTimes(1);
  });
});
