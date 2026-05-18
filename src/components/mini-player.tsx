import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  IconWaveform,
  IconRewind,
  IconPause,
  IconPlay,
  IconForward,
  IconVolume,
  IconClose,
} from '../lib/icons';
import { api } from '../lib/api';
import { parseDuration, formatTime } from '../lib/time';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import type { Chapter, ChapterAudio } from '../lib/types';

interface MiniPlayerProps {
  chapter: Chapter | null;
  bookId: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  prevAvailable: boolean;
  nextAvailable: boolean;
}

export function MiniPlayer({
  chapter,
  bookId,
  onClose,
  onPrev,
  onNext,
  prevAvailable,
  nextAvailable,
}: MiniPlayerProps) {
  const [audio, setAudio] = useState<ChapterAudio>({ durationSec: 0, peaks: [], url: null });
  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /* Plan 47 — resume seek + debounced save state.
     pendingSeekRef carries the resume point from the on-mount
     api.getListenProgress fetch into the onLoadedMetadata handler,
     where the seek can actually stick (setting el.currentTime before
     metadata loads is unreliable across browsers).
     currentSecRef mirrors currentSec for the flush-on-unmount cleanup
     so the cleanup closure doesn't capture a stale value.
     lastSavedAtRef gates the onTimeUpdate save to once-per-5 s so a
     debounced PUT doesn't fire 60× per minute. */
  const pendingSeekRef = useRef<number | null>(null);
  const currentSecRef = useRef(0);
  const lastSavedAtRef = useRef(0);

  /* Fetch the audio meta (url, durationSec, segments) whenever the chapter
     changes. We don't store the chapter id on the audio element because the
     <audio> src swap is driven separately — this effect just owns the
     metadata for the scrubber + duration display.
     Also (plan 47) fetches the resume bookmark in parallel and stashes
     it in pendingSeekRef for onLoadedMetadata to apply; flushes one
     final save on cleanup if currentSecRef > 5 s. */
  useEffect(() => {
    if (!chapter) return;
    setCurrentSec(0);
    currentSecRef.current = 0;
    pendingSeekRef.current = null;
    lastSavedAtRef.current = 0;
    setError(null);
    /* Drop the previous chapter's URL synchronously so the <audio> element
       stops its current playback immediately. Without this reset, src
       continues pointing at chapter A until B's metadata fetch resolves —
       which feels like a stalled click if the network is slow or the fetch
       fails (the old chapter just keeps playing under the new chapter's UI). */
    setAudio({ durationSec: 0, peaks: [], url: null });
    let cancelled = false;
    const chapterId = chapter.id;
    api
      .getChapterAudio({ bookId, chapterId, duration: chapter.duration })
      .then((meta) => {
        if (!cancelled) setAudio(meta);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    /* Resume bookmark fetch fires in parallel with the audio meta
       fetch. Stash in a ref instead of calling setCurrentSec right
       now — the audio element's currentTime would just snap back to
       0 inside the audio.url effect below until the metadata lands.
       The actual seek happens in onLoadedMetadata. */
    api
      .getListenProgress(bookId)
      .then((progress) => {
        if (cancelled) return;
        if (progress && progress.chapterId === chapterId) {
          pendingSeekRef.current = progress.currentSec;
        }
      })
      .catch((e) => {
        /* Non-fatal — playback still works without a resume point. */
        console.warn('[mini-player] listen-progress GET failed', (e as Error).message);
      });
    return () => {
      cancelled = true;
      /* Flush-on-unmount: persist the latest position if the user got
         past the first 5 s. Skipping when <= 5 s avoids polluting the
         resume point with accidental click-and-close noise. */
      if (currentSecRef.current > 5) {
        void api
          .putListenProgress(bookId, {
            chapterId,
            currentSec: currentSecRef.current,
          })
          .catch((e) => {
            console.warn('[mini-player] listen-progress flush failed', (e as Error).message);
          });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapter?.id, chapter?.duration]);

  /* When the URL lands, point the audio element at it. Resetting src + load
     also clears any prior playback state from the previous chapter. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (audio.url) {
      el.src = audio.url;
      el.load();
      el.currentTime = 0;
      if (playing)
        void el.play().catch(() => {
          /* user-gesture errors surface via <audio onerror> */
        });
    } else {
      el.removeAttribute('src');
      el.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.url]);

  /* Reflect the React `playing` flag onto the element. Browsers may also flip
     `playing` externally (ended → false) — those paths use setPlaying directly
     so this effect won't trigger spurious play()/pause() calls. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audio.url) return;
    if (playing) {
      void el.play().catch(() => {
        /* swallow; <audio onerror> covers real failures */
      });
    } else {
      el.pause();
    }
  }, [playing, audio.url]);

  if (!chapter) return null;
  const totalSec = audio.durationSec || parseDuration(chapter.duration);
  const progress = totalSec ? currentSec / totalSec : 0;

  const onScrub = (e: MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const next = pct * totalSec;
    setCurrentSec(next);
    if (el && Number.isFinite(el.duration)) el.currentTime = next;
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 fade-in">
      <div className="bg-ink text-canvas border-t border-canvas/10 backdrop-blur-md">
        <div className="max-w-[1500px] mx-auto px-6 py-3 grid grid-cols-[auto_minmax(0,2fr)_auto_minmax(0,3fr)_auto] items-center gap-5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-11 h-11 rounded-xl bg-gradient-cta shrink-0 grid place-items-center">
              <IconWaveform className="w-4 h-4 text-white/70" />
            </span>
            <div className="min-w-0 hidden md:block">
              <p className="text-sm font-semibold truncate">
                CH {String(chapter.id).padStart(2, '0')} · {stripChapterPrefix(chapter.title)}
              </p>
              <p className="text-[11px] text-canvas/60 truncate">
                {error ? <span className="text-rose-300">{error}</span> : 'Preview'}
              </p>
            </div>
          </div>
          <span />
          <div className="flex items-center gap-2">
            <button
              onClick={onPrev}
              disabled={!prevAvailable}
              className="p-2 rounded-full hover:bg-canvas/10 disabled:opacity-30"
            >
              <IconRewind className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPlaying(!playing)}
              className="w-10 h-10 rounded-full bg-canvas text-ink grid place-items-center hover:bg-white"
            >
              {playing ? (
                <IconPause className="w-4 h-4" />
              ) : (
                <IconPlay className="w-4 h-4 ml-0.5" />
              )}
            </button>
            <button
              onClick={onNext}
              disabled={!nextAvailable}
              className="p-2 rounded-full hover:bg-canvas/10 disabled:opacity-30"
            >
              <IconForward className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[11px] tabular-nums text-canvas/60 w-10 text-right">
              {formatTime(currentSec)}
            </span>
            <div
              onClick={onScrub}
              className="flex-1 h-1 rounded-full bg-canvas/15 relative cursor-pointer group"
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-progress pointer-events-none"
                style={{ width: `${progress * 100}%` }}
              />
              <span
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-canvas opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                style={{ left: `${progress * 100}%` }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-canvas/60 w-10">
              {formatTime(totalSec)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 rounded-full hover:bg-canvas/10 hidden md:grid place-items-center">
              <IconVolume className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-canvas/10">
              <IconClose className="w-4 h-4" />
            </button>
          </div>
        </div>
        <audio
          ref={audioRef}
          preload="metadata"
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCurrentSec(t);
            currentSecRef.current = t;
            /* Plan 47 — debounced save. Once per 5 s of wall-clock,
               post the position so a refresh / close / app crash
               loses at most ~5 s of resume accuracy. Don't dispatch
               through Redux for this — slice churn on every tick
               would re-render too much; the listen-progress slice
               hydrates on book load + on chapter mount, both of
               which already cover the read path. */
            if (!chapter) return;
            const now = Date.now();
            if (now - lastSavedAtRef.current < 5000) return;
            if (t <= 5) return;
            lastSavedAtRef.current = now;
            const chapterId = chapter.id;
            void api
              .putListenProgress(bookId, { chapterId, currentSec: t })
              .catch((err) => {
                console.warn('[mini-player] listen-progress save failed', (err as Error).message);
              });
          }}
          onLoadedMetadata={(e) => {
            const target = e.currentTarget;
            const d = target.duration;
            if (Number.isFinite(d) && d > 0) {
              setAudio((a) => ({ ...a, durationSec: d }));
              /* Plan 47 — apply the resume bookmark now that the
                 audio element knows its duration. Cap at d - 1 so a
                 resume point parked near the end of the chapter
                 doesn't immediately trigger onEnded. */
              const pending = pendingSeekRef.current;
              if (pending != null && pending > 0 && pending < d - 1) {
                target.currentTime = pending;
                setCurrentSec(pending);
                currentSecRef.current = pending;
              }
              pendingSeekRef.current = null;
            }
          }}
          onEnded={() => setPlaying(false)}
          onError={() => setError('Audio failed to load.')}
          className="hidden"
        />
      </div>
    </div>
  );
}
