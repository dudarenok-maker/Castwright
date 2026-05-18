/* Singleton playback sequencing — covers the playUntilEnded API the
   compare modal's Auto A→B button relies on. The hook proxies a module-
   level <audio> element; jsdom's Audio doesn't actually decode, so we
   replace it with a stub that exposes the ended/error/pause events. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

class FakeAudio {
  preload = '';
  src = '';
  currentTime = 0;
  ended = false;
  error: MediaError | null = null;
  private listeners = new Map<string, Set<EventListener>>();
  addEventListener(name: string, fn: EventListener) {
    const set = this.listeners.get(name) ?? new Set<EventListener>();
    set.add(fn);
    this.listeners.set(name, set);
  }
  removeEventListener(name: string, fn: EventListener) {
    this.listeners.get(name)?.delete(fn);
  }
  dispatch(name: string) {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) fn(new Event(name));
  }
  play = vi.fn(async () => {
    /* resolves immediately */
  });
  pause = vi.fn(() => {});
}

let fake: FakeAudio;
type AudioSlot = { Audio?: unknown };
const OriginalAudio = (globalThis as AudioSlot).Audio;

beforeEach(async () => {
  vi.resetModules();
  fake = new FakeAudio();
  (globalThis as AudioSlot).Audio = function Audio() {
    return fake;
  };
});

afterEach(() => {
  if (OriginalAudio) (globalThis as AudioSlot).Audio = OriginalAudio;
  else delete (globalThis as AudioSlot).Audio;
});

describe('useSamplePlayback', () => {
  it('playUntilEnded resolves with cancelled:false when the audio fires "ended"', async () => {
    const { useSamplePlayback } = await import('./use-sample-playback');
    const { result } = renderHook(() => useSamplePlayback());

    await act(async () => {
      await result.current.play('/audio/voices/x.mp3');
    });
    expect(result.current.isPlaying).toBe(true);

    const pending = result.current.playUntilEnded();
    await act(async () => {
      fake.dispatch('ended');
    });
    await expect(pending).resolves.toEqual({ cancelled: false });
    expect(result.current.isPlaying).toBe(false);
  });

  it('playUntilEnded resolves with cancelled:true when stop() runs before "ended"', async () => {
    const { useSamplePlayback } = await import('./use-sample-playback');
    const { result } = renderHook(() => useSamplePlayback());

    await act(async () => {
      await result.current.play('/audio/voices/x.mp3');
    });

    const pending = result.current.playUntilEnded();
    await act(async () => {
      result.current.stop();
    });
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(result.current.isPlaying).toBe(false);
  });

  it('playUntilEnded resolves with cancelled:true if nothing is currently playing', async () => {
    const { useSamplePlayback } = await import('./use-sample-playback');
    const { result } = renderHook(() => useSamplePlayback());

    /* No prior play(); the awaiter must not hang. Auto A→B relies on
       this so a failed prep doesn't leave the sequence stuck. */
    await expect(result.current.playUntilEnded()).resolves.toEqual({ cancelled: true });
  });

  it('swapping to a new src interrupts any in-flight playUntilEnded with cancelled:true', async () => {
    const { useSamplePlayback } = await import('./use-sample-playback');
    const { result } = renderHook(() => useSamplePlayback());

    await act(async () => {
      await result.current.play('/audio/voices/a.mp3');
    });
    const pending = result.current.playUntilEnded();
    await act(async () => {
      await result.current.play('/audio/voices/b.mp3');
    });
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});
