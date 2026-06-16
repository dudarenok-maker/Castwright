/* A/B audition orchestration (shared by CompareCastModal + VoiceCompareModal).

   Lifts the playback bookkeeping that used to live inline in
   compare-cast-modal.tsx: per-side loading/error rows, the click-again-to-stop
   toggle, and the "Auto A → B" sequence that plays Side A, waits for it to end,
   then plays Side B. It is body-agnostic — each consumer supplies a per-side
   `play()` (Side A typically plays a server voice sample via
   playSampleWithAutoLoad; Side B may play a known preview URL directly) and a
   `matchUrl`/`matchMode` so the hook can tell which side is currently audible
   against the shared <audio> singleton (`use-sample-playback.ts`). */

import { useRef, useState } from 'react';
import type { useSamplePlayback } from './use-sample-playback';

type SamplePlayback = ReturnType<typeof useSamplePlayback>;

export type AbSideKey = 'a' | 'b';

export interface AbSide {
  /** Used to detect "this side is playing" against the playback singleton's
      currentUrl. 'prefix' for server sample URLs whose cache hash we don't know
      client-side; 'exact' for a known preview blob/URL. */
  matchUrl: string;
  matchMode: 'prefix' | 'exact';
  /** Kick off playback for this side; throws on failure. */
  play: () => Promise<void>;
}

export interface AbRowState {
  loading?: boolean;
  error?: string;
}

export interface UseAbAudition {
  rowState: Record<AbSideKey, AbRowState>;
  autoRunning: boolean;
  footerError: string | null;
  playSide: (side: AbSideKey) => Promise<void>;
  runAuto: () => Promise<void>;
  stopAndCancel: () => void;
  isSidePlaying: (side: AbSideKey) => boolean;
}

export function useAbAudition({
  sides,
  playback,
}: {
  sides: Record<AbSideKey, AbSide>;
  playback: SamplePlayback;
}): UseAbAudition {
  const [rowState, setRowState] = useState<Record<AbSideKey, AbRowState>>({ a: {}, b: {} });
  const [autoRunning, setAutoRunning] = useState(false);
  const [footerError, setFooterError] = useState<string | null>(null);
  const autoCancelRef = useRef(false);

  function setRow(side: AbSideKey, patch: AbRowState | null) {
    setRowState((prev) => {
      const next = { ...prev };
      next[side] = patch === null ? {} : { ...next[side], ...patch };
      return next;
    });
  }

  function isSidePlaying(side: AbSideKey): boolean {
    const url = playback.currentUrl;
    if (!playback.isPlaying || !url) return false;
    const { matchUrl, matchMode } = sides[side];
    return matchMode === 'prefix' ? url.startsWith(matchUrl) : url === matchUrl;
  }

  function stopAndCancel() {
    autoCancelRef.current = true;
    setAutoRunning(false);
    if (playback.isPlaying) playback.stop();
  }

  async function playSide(side: AbSideKey) {
    /* Cancel any in-flight auto-compare so an individual play doesn't fight
       the sequence. */
    autoCancelRef.current = true;
    setAutoRunning(false);
    if (isSidePlaying(side)) {
      playback.stop();
      return;
    }
    setRow(side, { loading: true, error: undefined });
    setFooterError(null);
    try {
      await sides[side].play();
      setRow(side, { loading: false });
    } catch (err) {
      /* Surface on BOTH the side row AND the footer — a single-side play
         failure was previously only written to the row, which some consumers
         (VoiceCompareModal's Side A) don't render, so it looked like nothing
         happened. The footer is always shown by AbCompareShell. */
      setRow(side, { loading: false, error: (err as Error).message });
      setFooterError((err as Error).message);
    }
  }

  async function runAuto() {
    if (autoRunning) {
      autoCancelRef.current = true;
      setAutoRunning(false);
      if (playback.isPlaying) playback.stop();
      return;
    }
    autoCancelRef.current = false;
    setAutoRunning(true);
    setFooterError(null);
    try {
      for (const side of ['a', 'b'] as const) {
        if (autoCancelRef.current) break;
        setRow(side, { loading: true, error: undefined });
        try {
          await sides[side].play();
          setRow(side, { loading: false });
        } catch (err) {
          setRow(side, { loading: false, error: (err as Error).message });
          setFooterError((err as Error).message);
          break;
        }
        if (autoCancelRef.current) break;
        const { cancelled } = await playback.playUntilEnded();
        if (cancelled || autoCancelRef.current) break;
      }
    } finally {
      setAutoRunning(false);
    }
  }

  return { rowState, autoRunning, footerError, playSide, runAuto, stopAndCancel, isSidePlaying };
}
