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

  /* Fetch the audio meta (url, durationSec, segments) whenever the chapter
     changes. We don't store the chapter id on the audio element because the
     <audio> src swap is driven separately — this effect just owns the
     metadata for the scrubber + duration display. */
  useEffect(() => {
    if (!chapter) return;
    setCurrentSec(0);
    setError(null);
    /* Drop the previous chapter's URL synchronously so the <audio> element
       stops its current playback immediately. Without this reset, src
       continues pointing at chapter A until B's metadata fetch resolves —
       which feels like a stalled click if the network is slow or the fetch
       fails (the old chapter just keeps playing under the new chapter's UI). */
    setAudio({ durationSec: 0, peaks: [], url: null });
    let cancelled = false;
    api
      .getChapterAudio({ bookId, chapterId: chapter.id, duration: chapter.duration })
      .then((meta) => {
        if (!cancelled) setAudio(meta);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
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
          onTimeUpdate={(e) => setCurrentSec(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setAudio((a) => ({ ...a, durationSec: d }));
          }}
          onEnded={() => setPlaying(false)}
          onError={() => setError('Audio failed to load.')}
          className="hidden"
        />
      </div>
    </div>
  );
}
