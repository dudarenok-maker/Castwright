/* Module-singleton audio playback for short voice samples. One <audio>
   element is shared across the app so clicking Play on a second voice
   stops the first, and React components don't need to coordinate refs.
   No library — just the DOM Audio API. */

import { useEffect, useState } from 'react';

type Listener = (state: PlaybackState) => void;

interface PlaybackState {
  currentUrl: string | null;
  isPlaying: boolean;
}

export interface PlayEndedResult {
  /** True when stop() was called (or playback errored / was interrupted
      by a new src) before the singleton fired `ended`. Lets the compare
      modal's Auto A→B sequence abort cleanly without throwing. */
  cancelled: boolean;
}

type EndedResolver = (result: PlayEndedResult) => void;

let audio: HTMLAudioElement | null = null;
const state: PlaybackState = { currentUrl: null, isPlaying: false };
const listeners = new Set<Listener>();
/* Awaiters for the next end-of-playback (or cancel). Drained when the
   singleton fires `ended` (cancelled:false) or when stop()/error/new src
   interrupts the current track (cancelled:true). One-shot — every
   playUntilEnded() registers a fresh resolver. */
const endedAwaiters = new Set<EndedResolver>();

function notify() {
  const snapshot = { ...state };
  for (const l of listeners) l(snapshot);
}

function drainEndedAwaiters(result: PlayEndedResult) {
  if (endedAwaiters.size === 0) return;
  const pending = Array.from(endedAwaiters);
  endedAwaiters.clear();
  for (const r of pending) r(result);
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('ended', () => {
    state.isPlaying = false;
    state.currentUrl = null;
    notify();
    drainEndedAwaiters({ cancelled: false });
  });
  audio.addEventListener('pause', () => {
    if (state.isPlaying && audio && audio.currentTime > 0 && !audio.ended) return;
    state.isPlaying = false;
    notify();
  });
  audio.addEventListener('error', () => {
    const mediaErr = audio?.error;
    // eslint-disable-next-line no-console
    console.error('[sample-playback] audio element errored', {
      url: state.currentUrl,
      code: mediaErr?.code,
      message: mediaErr?.message,
    });
    state.isPlaying = false;
    state.currentUrl = null;
    notify();
    drainEndedAwaiters({ cancelled: true });
  });
  return audio;
}

export function useSamplePlayback() {
  const [snap, setSnap] = useState<PlaybackState>(state);

  useEffect(() => {
    listeners.add(setSnap);
    setSnap({ ...state });
    return () => {
      listeners.delete(setSnap);
    };
  }, []);

  return {
    currentUrl: snap.currentUrl,
    isPlaying: snap.isPlaying,
    /* Returns a promise so callers can surface playback failures (e.g.
       browser autoplay policy, decode errors, 404 on the URL). The audio
       element's `error` listener also resets state in case the failure
       arrives async after this promise resolves. */
    async play(url: string): Promise<void> {
      const a = ensureAudio();
      if (state.currentUrl !== url) {
        /* Swapping src counts as cancelling any current track for the
           purposes of pending playUntilEnded() — otherwise an Auto A→B
           that starts a new sample mid-flight would never resolve the
           first awaiter. */
        if (state.isPlaying) drainEndedAwaiters({ cancelled: true });
        a.src = url;
        state.currentUrl = url;
      }
      state.isPlaying = true;
      notify();
      try {
        // eslint-disable-next-line no-console
        console.log('[sample-playback] playing', url);
        await a.play();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[sample-playback] play() rejected', err);
        state.isPlaying = false;
        state.currentUrl = null;
        notify();
        drainEndedAwaiters({ cancelled: true });
        throw err;
      }
    },
    stop() {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      state.isPlaying = false;
      state.currentUrl = null;
      notify();
      drainEndedAwaiters({ cancelled: true });
    },
    /* Awaits the singleton's `ended` event (cancelled:false) or any
       interruption — stop(), error, or a new src loading (cancelled:true).
       Caller is responsible for having already kicked off play(url); this
       does NOT auto-play. Pattern: `await play(url); const { cancelled }
       = await playUntilEnded();`. */
    playUntilEnded(): Promise<PlayEndedResult> {
      /* If nothing is currently playing, resolve immediately as cancelled —
         the most common reason is that play() failed or stop() ran between
         the caller's play() and its await. Returning cancelled:true here
         lets sequences bail cleanly. */
      if (!state.isPlaying) return Promise.resolve({ cancelled: true });
      return new Promise<PlayEndedResult>((resolve) => {
        endedAwaiters.add(resolve);
      });
    },
  };
}
