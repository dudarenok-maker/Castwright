import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { IconWaveform, IconRewind, IconPause, IconPlay, IconForward, IconVolume, IconClose } from '../lib/icons';
import { api } from '../lib/api';
import { parseDuration, formatTime } from '../lib/time';
import type { Chapter, ChapterAudio } from '../lib/types';

interface MiniPlayerProps {
  chapter: Chapter | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  prevAvailable: boolean;
  nextAvailable: boolean;
}

export function MiniPlayer({ chapter, onClose, onPrev, onNext, prevAvailable, nextAvailable }: MiniPlayerProps) {
  const [audio, setAudio] = useState<ChapterAudio>({ durationSec: 0, peaks: [], url: null });
  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickRef = useRef(0);

  useEffect(() => {
    if (!chapter) return;
    setCurrentSec(0);
    let cancelled = false;
    api.getChapterAudio({ bookId: 'ns', chapterId: chapter.id, duration: chapter.duration })
      .then(meta => { if (!cancelled) setAudio(meta); });
    return () => { cancelled = true; };
  }, [chapter?.id, chapter?.duration]);

  useEffect(() => {
    if (!playing || !audio.durationSec) return;
    lastTickRef.current = performance.now();
    timerRef.current = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setCurrentSec(s => Math.min(audio.durationSec, s + dt));
    }, 100);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, audio.durationSec]);

  if (!chapter) return null;
  const totalSec = audio.durationSec || parseDuration(chapter.duration);
  const progress = totalSec ? currentSec / totalSec : 0;

  const onScrub = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setCurrentSec(pct * totalSec);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 fade-in">
      <div className="bg-ink text-canvas border-t border-canvas/10 backdrop-blur-md">
        <div className="max-w-[1500px] mx-auto px-6 py-3 grid grid-cols-[auto_minmax(0,2fr)_auto_minmax(0,3fr)_auto] items-center gap-5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-11 h-11 rounded-xl bg-gradient-cta shrink-0 grid place-items-center">
              <IconWaveform className="w-4 h-4 text-white/70"/>
            </span>
            <div className="min-w-0 hidden md:block">
              <p className="text-sm font-semibold truncate">CH {String(chapter.id).padStart(2, '0')} · {chapter.title}</p>
              <p className="text-[11px] text-canvas/60 truncate">The Northern Star</p>
            </div>
          </div>
          <span/>
          <div className="flex items-center gap-2">
            <button onClick={onPrev} disabled={!prevAvailable} className="p-2 rounded-full hover:bg-canvas/10 disabled:opacity-30"><IconRewind className="w-4 h-4"/></button>
            <button onClick={() => setPlaying(!playing)} className="w-10 h-10 rounded-full bg-canvas text-ink grid place-items-center hover:bg-white">
              {playing ? <IconPause className="w-4 h-4"/> : <IconPlay className="w-4 h-4 ml-0.5"/>}
            </button>
            <button onClick={onNext} disabled={!nextAvailable} className="p-2 rounded-full hover:bg-canvas/10 disabled:opacity-30"><IconForward className="w-4 h-4"/></button>
          </div>
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[11px] tabular-nums text-canvas/60 w-10 text-right">{formatTime(currentSec)}</span>
            <div onClick={onScrub} className="flex-1 h-1 rounded-full bg-canvas/15 relative cursor-pointer group">
              <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-progress pointer-events-none" style={{ width: `${progress * 100}%` }}/>
              <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-canvas opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" style={{ left: `${progress * 100}%` }}/>
            </div>
            <span className="text-[11px] tabular-nums text-canvas/60 w-10">{formatTime(totalSec)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 rounded-full hover:bg-canvas/10 hidden md:grid place-items-center"><IconVolume className="w-4 h-4"/></button>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-canvas/10"><IconClose className="w-4 h-4"/></button>
          </div>
        </div>
      </div>
    </div>
  );
}
