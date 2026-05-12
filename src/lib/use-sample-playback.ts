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

let audio: HTMLAudioElement | null = null;
const state: PlaybackState = { currentUrl: null, isPlaying: false };
const listeners = new Set<Listener>();

function notify() {
  const snapshot = { ...state };
  for (const l of listeners) l(snapshot);
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('ended', () => {
    state.isPlaying = false;
    state.currentUrl = null;
    notify();
  });
  audio.addEventListener('pause', () => {
    if (state.isPlaying && audio && audio.currentTime > 0 && !audio.ended) return;
    state.isPlaying = false;
    notify();
  });
  audio.addEventListener('error', () => {
    const mediaErr = audio?.error;
    // eslint-disable-next-line no-console
    console.error('[sample-playback] audio element errored', { url: state.currentUrl, code: mediaErr?.code, message: mediaErr?.message });
    state.isPlaying = false;
    state.currentUrl = null;
    notify();
  });
  return audio;
}

export function useSamplePlayback() {
  const [snap, setSnap] = useState<PlaybackState>(state);

  useEffect(() => {
    listeners.add(setSnap);
    setSnap({ ...state });
    return () => { listeners.delete(setSnap); };
  }, []);

  return {
    currentUrl: snap.currentUrl,
    isPlaying:  snap.isPlaying,
    /* Returns a promise so callers can surface playback failures (e.g.
       browser autoplay policy, decode errors, 404 on the URL). The audio
       element's `error` listener also resets state in case the failure
       arrives async after this promise resolves. */
    async play(url: string): Promise<void> {
      const a = ensureAudio();
      if (state.currentUrl !== url) {
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
    },
  };
}
