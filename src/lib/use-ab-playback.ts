/* Mutual-exclusion a/b playback hook for the revision-diff player.

   Two HTMLAudioElement instances, one per version (A = preserved/previous
   take, B = freshly-rendered take). Playing one pauses the other. Optional
   per-segment seek + auto-pause via `timeupdate`: when the caller passes
   a `[segmentStart, segmentEnd]` window, the audio seeks to start and
   pauses as soon as currentTime crosses end. Whole-revision playback
   uses the same API with `undefined` bounds — the audio plays through to
   `ended` and stops naturally.

   Module-internal vs. hook-scoped: unlike use-sample-playback (which is
   module-singleton because samples play across many views), a/b playback
   only ever lives inside one mounted revision-diff player at a time, so
   the audio elements are owned by the hook's lifetime. Closing the diff
   view tears them down. */

import { useCallback, useEffect, useRef, useState } from 'react';

export type AbVersion = 'A' | 'B';

interface PlaybackSnapshot {
  /** Which version is playing right now, or null when paused. */
  playing: AbVersion | null;
  /** The currently-playing segment id (caller-supplied), or null when
      playing the whole revision (no bounds). Lets the UI light up the
      right per-segment row. */
  segmentId: number | null;
}

export interface PlayOptions {
  /** Optional segment id — surfaced back in the snapshot so the UI can
      highlight the playing row. */
  segmentId?: number;
  /** Optional segment window in seconds. When set, the audio seeks to
      `start` on play and auto-pauses past `end`. */
  start?: number;
  end?: number;
}

export interface UseAbPlaybackResult {
  playing: AbVersion | null;
  segmentId: number | null;
  playA: (opts?: PlayOptions) => Promise<void>;
  playB: (opts?: PlayOptions) => Promise<void>;
  pause: () => void;
  /** Lazy refs to the underlying audio elements — exposed for tests so
      they can spy on `.play()` / `.pause()` without coupling to internals. */
  audioRefs: { A: HTMLAudioElement | null; B: HTMLAudioElement | null };
}

interface Args {
  /** URL for the A (preserved/current) audio. Null while the metadata
      fetch is pending; falsy disables A playback. */
  urlA: string | null;
  /** URL for the B (proposed/new) audio. */
  urlB: string | null;
}

export function useAbPlayback({ urlA, urlB }: Args): UseAbPlaybackResult {
  const refA = useRef<HTMLAudioElement | null>(null);
  const refB = useRef<HTMLAudioElement | null>(null);
  const [snap, setSnap] = useState<PlaybackSnapshot>({ playing: null, segmentId: null });

  /* Lazy-init audio elements so SSR + the initial render don't pay the
     cost; React Strict-Mode double-effect doesn't create two pairs. */
  function ensureAudio(version: AbVersion): HTMLAudioElement {
    const ref = version === 'A' ? refA : refB;
    if (!ref.current) {
      ref.current = new Audio();
      ref.current.preload = 'metadata';
    }
    return ref.current;
  }

  /* Keep `src` synced with the latest urls. Setting src to '' detaches
     the source — safer than leaving a stale src that won't 404 until
     the next play() click. */
  useEffect(() => {
    const a = ensureAudio('A');
    if (urlA && a.src !== urlA) a.src = urlA;
    if (!urlA) a.removeAttribute('src');
  }, [urlA]);

  useEffect(() => {
    const b = ensureAudio('B');
    if (urlB && b.src !== urlB) b.src = urlB;
    if (!urlB) b.removeAttribute('src');
  }, [urlB]);

  /* Cleanup on unmount: pause both elements + detach src so the
     browser releases any decode buffers. */
  useEffect(() => {
    return () => {
      if (refA.current) {
        refA.current.pause();
        refA.current.removeAttribute('src');
      }
      if (refB.current) {
        refB.current.pause();
        refB.current.removeAttribute('src');
      }
    };
  }, []);

  const pause = useCallback(() => {
    if (refA.current) refA.current.pause();
    if (refB.current) refB.current.pause();
    setSnap({ playing: null, segmentId: null });
  }, []);

  const playVersion = useCallback(async (version: AbVersion, opts: PlayOptions = {}) => {
    const target = ensureAudio(version);
    const other = ensureAudio(version === 'A' ? 'B' : 'A');
    /* Mutual exclusion: pause the other element first so its
       `timeupdate` auto-pause handler doesn't keep racing past the
       boundary while the new one starts. */
    other.pause();

    if (typeof opts.start === 'number' && Number.isFinite(opts.start)) {
      target.currentTime = opts.start;
    }

    /* Per-segment auto-pause. Remove any prior listener (a previous play
       on a different segment) before attaching the new one — without
       cleanup, the prior listener fires forever and keeps pausing the
       audio every time it loops past the old end. */
    const handler = target.dataset.abHandler;
    if (handler && (target as unknown as { _abListener?: EventListener })._abListener) {
      target.removeEventListener(
        'timeupdate',
        (target as unknown as { _abListener: EventListener })._abListener,
      );
    }
    if (typeof opts.end === 'number' && Number.isFinite(opts.end)) {
      const endSec = opts.end;
      const listener: EventListener = () => {
        if (target.currentTime >= endSec) {
          target.pause();
          target.removeEventListener('timeupdate', listener);
          setSnap((s) => (s.playing === version ? { playing: null, segmentId: null } : s));
        }
      };
      target.addEventListener('timeupdate', listener);
      (target as unknown as { _abListener: EventListener })._abListener = listener;
      target.dataset.abHandler = '1';
    }

    /* Clear playing state when the track ends naturally — full-revision
       playback (no `end` bound) relies on this, not the timeupdate
       listener. */
    target.onended = () => {
      setSnap((s) => (s.playing === version ? { playing: null, segmentId: null } : s));
    };

    setSnap({ playing: version, segmentId: opts.segmentId ?? null });
    try {
      await target.play();
    } catch (err) {
      /* Autoplay-policy reject, decode error, 404 — flip back to paused
         so the UI doesn't get stuck in a phantom "playing" state. */
      setSnap((s) => (s.playing === version ? { playing: null, segmentId: null } : s));
      throw err;
    }
  }, []);

  const playA = useCallback((opts?: PlayOptions) => playVersion('A', opts), [playVersion]);
  const playB = useCallback((opts?: PlayOptions) => playVersion('B', opts), [playVersion]);

  return {
    playing: snap.playing,
    segmentId: snap.segmentId,
    playA,
    playB,
    pause,
    audioRefs: { A: refA.current, B: refB.current },
  };
}
