/* Listen-view play-affordance + markers region — pure presentational
   lift from listen.tsx. Owns: plan-53 MarkersPanel (per-book bookmarks
   with click-to-seek + delete) + the capped, scrollable chapter list
   that drives the global mini-player when a row is clicked.

   Behaviour-neutral lift — every data-testid, className, and child
   order matches the pre-refactor JSX so the listen.test.tsx +
   listen-playback / mini-player-features / listen-resume e2e selectors
   keep resolving. The mini-player itself lives in the global Layout
   shell (not on the listen view), so this region only exposes the
   chapter-row triggers + the markers sidebar. */

import { useEffect, useState } from 'react';
import {
  IconPlay,
  IconPause,
  IconDownload,
  IconRefresh,
} from '../../lib/icons';
import { SectionLabel, Pill } from '../primitives';
import { Waveform } from '../waveform';
import { parseDuration, formatTime } from '../../lib/time';
import { stripChapterPrefix } from '../../lib/format-chapter-title';
import { useAppSelector } from '../../store';
import { selectListenProgress, type ListenMarker } from '../../store/listen-progress-slice';
import type { Chapter, Character } from '../../lib/types';

interface ListenPlayerRegionProps {
  bookId: string;
  chapters: Chapter[];
  listenable: Chapter[];
  characters: Character[];
  currentTrack: number | null;
  onPlayChapter: (chapterId: number | null) => void;
  onRegenerate: (ch: Chapter) => void;
  onSeekMarker: (marker: ListenMarker) => void;
  onDeleteMarker: (markerId: string) => void;
}

export function ListenPlayerRegion({
  bookId,
  chapters,
  listenable,
  characters,
  currentTrack,
  onPlayChapter,
  onRegenerate,
  onSeekMarker,
  onDeleteMarker,
}: ListenPlayerRegionProps) {
  const findChar = (id: string) => characters.find((c) => c.id === id);
  return (
    <>
      <MarkersPanel
        bookId={bookId}
        chapters={chapters}
        onSeek={onSeekMarker}
        onDelete={onDeleteMarker}
      />

      <section className="mb-12">
        <div className="flex items-center justify-between mb-3">
          <SectionLabel>Chapters</SectionLabel>
          <span className="text-xs text-ink/50">Click any chapter to play from there</span>
        </div>
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          {/* Cap the list so a 59-chapter book doesn't push the rest of the
              Listen view off-screen. Inner div owns the scroll so the card's
              rounded corners stay clean; scrollbar-thin paints an inset thumb
              that clears those corners. */}
          <div
            data-testid="listen-chapters-scroll"
            className="max-h-[560px] overflow-y-auto scrollbar-thin divide-y divide-ink/5"
          >
            {listenable.map((ch) => {
              const charsIn = Object.entries(ch.characters)
                .filter(([, st]) => st !== 'skipped')
                .map(([id]) => findChar(id))
                .filter(Boolean) as Character[];
              return (
                <ChapterListenRow
                  key={ch.id}
                  bookId={bookId}
                  chapter={ch}
                  charactersIn={charsIn}
                  isPlaying={currentTrack === ch.id}
                  onPlay={() => onPlayChapter(currentTrack === ch.id ? null : ch.id)}
                  onRegenerate={onRegenerate}
                />
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}

interface ChapterListenRowProps {
  bookId: string;
  chapter: Chapter;
  charactersIn: Character[];
  isPlaying: boolean;
  onPlay: () => void;
  onRegenerate: (ch: Chapter) => void;
}

function ChapterListenRow({
  bookId,
  chapter,
  charactersIn,
  isPlaying,
  onPlay,
  onRegenerate,
}: ChapterListenRowProps) {
  /* Plan 47 — read the per-book resume bookmark. The pill renders
     only when it points at THIS chapter and the user got past the
     first 5 s (same noise-floor as the mini-player's save gate). */
  const resume = useAppSelector(selectListenProgress(bookId));
  const showResume = resume?.chapterId === chapter.id && resume.currentSec > 5;
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!isPlaying) return;
    setProgress(0);
    const t = setInterval(() => setProgress((p) => (p >= 1 ? p : Math.min(1, p + 0.012))), 800);
    return () => clearInterval(t);
  }, [isPlaying]);
  const totalSec = parseDuration(chapter.duration);
  const elapsedSec = Math.floor(totalSec * progress);
  return (
    <div
      data-testid={`chapter-row-${chapter.id}`}
      className={`grid grid-cols-[40px_60px_1fr_220px_100px_60px] items-center gap-4 px-5 py-4 transition-colors ${isPlaying ? 'bg-peach/[0.06]' : 'hover:bg-ink/[0.02]'}`}
    >
      <button
        onClick={onPlay}
        aria-label={isPlaying ? `Pause chapter ${chapter.id}` : `Play chapter ${chapter.id}`}
        className={`w-9 h-9 rounded-full grid place-items-center transition-all ${isPlaying ? 'bg-ink text-canvas' : 'bg-canvas border border-ink/15 text-ink hover:bg-ink hover:text-canvas'}`}
      >
        {isPlaying ? (
          <IconPause className="w-3.5 h-3.5" />
        ) : (
          <IconPlay className="w-3.5 h-3.5 ml-0.5" />
        )}
      </button>
      <span className="text-sm font-bold text-ink/50 tabular-nums">
        CH {String(chapter.id).padStart(2, '0')}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="font-semibold text-ink truncate">
            {stripChapterPrefix(chapter.title)}
          </span>
          {showResume && resume && (
            <Pill color="library">Resume at {formatTime(resume.currentSec)}</Pill>
          )}
        </span>
        <span className="block text-xs text-ink/50 truncate mt-0.5">
          With{' '}
          {charactersIn
            .slice(0, 4)
            .map((c) => c.name)
            .join(', ')}
        </span>
      </span>
      <Waveform progress={isPlaying ? progress : 0} active={isPlaying} />
      <span className="text-sm tabular-nums text-ink/60 text-right">
        {isPlaying ? (
          <span className="text-ink font-semibold">
            {formatTime(elapsedSec)} / {chapter.duration}
          </span>
        ) : (
          chapter.duration
        )}
      </span>
      <span className="flex items-center gap-1 justify-end">
        <button
          onClick={() => onRegenerate(chapter)}
          title="Regenerate"
          className="text-ink/40 hover:text-magenta grid place-items-center w-8 h-8 rounded-full hover:bg-ink/[0.04]"
        >
          <IconRefresh className="w-4 h-4" />
        </button>
        <button
          disabled
          title="Download — coming soon"
          className="text-ink/30 grid place-items-center w-8 h-8 rounded-full cursor-not-allowed"
        >
          <IconDownload className="w-4 h-4" />
        </button>
      </span>
    </div>
  );
}

/* Plan 53 — markers sidebar panel. Reads the per-book bookmarks
   from the listen-progress slice, groups by chapter, and renders
   click-to-seek + delete affordances. Null-renders when the book has
   no markers so the listen view stays uncluttered for fresh books. */
interface MarkersPanelProps {
  bookId: string;
  chapters: Chapter[];
  onSeek: (marker: ListenMarker) => void;
  onDelete: (markerId: string) => void;
}
function MarkersPanel({ bookId, chapters, onSeek, onDelete }: MarkersPanelProps) {
  const progress = useAppSelector(selectListenProgress(bookId));
  const markers = progress?.markers ?? [];
  if (markers.length === 0) return null;
  /* Group markers by chapter for the sidebar; chapter order matches
     the chapters prop so a re-ordered restructure (plan 51) keeps the
     panel coherent. */
  const byChapter = new Map<number, ListenMarker[]>();
  for (const m of markers) {
    const list = byChapter.get(m.chapterId) ?? [];
    list.push(m);
    byChapter.set(m.chapterId, list);
  }
  /* Sort each chapter's markers by position so the UI reads top-to-
     bottom by play order. */
  for (const list of byChapter.values()) list.sort((a, b) => a.sec - b.sec);
  const groups: Array<{ chapter: Chapter; markers: ListenMarker[] }> = [];
  for (const ch of chapters) {
    const list = byChapter.get(ch.id);
    if (list && list.length > 0) groups.push({ chapter: ch, markers: list });
  }
  return (
    <section data-testid="listen-markers-panel" className="mb-12">
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Markers</SectionLabel>
        <span className="text-xs text-ink/50">
          {markers.length} bookmark{markers.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5">
        {groups.map((g) => (
          <div key={g.chapter.id} className="px-5 py-4">
            <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/50 mb-2">
              CH {String(g.chapter.id).padStart(2, '0')} · {stripChapterPrefix(g.chapter.title)}
            </p>
            <ul className="space-y-1">
              {g.markers.map((m) => (
                <li
                  key={m.id}
                  data-testid={`listen-marker-${m.id}`}
                  className="flex items-center gap-3 text-sm text-ink/80"
                >
                  <button
                    type="button"
                    onClick={() => onSeek(m)}
                    data-testid={`listen-marker-seek-${m.id}`}
                    className="flex-1 flex items-center gap-3 text-left hover:text-ink"
                  >
                    <span className="tabular-nums text-xs text-ink/50 w-12">
                      {formatTime(m.sec)}
                    </span>
                    <span className="truncate">{m.label || <em className="text-ink/40">No label</em>}</span>
                    {m.kind === 'rerecord' && (
                      <Pill color="library">re-record</Pill>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(m.id)}
                    aria-label="Delete marker"
                    data-testid={`listen-marker-delete-${m.id}`}
                    className="text-ink/40 hover:text-rose-500 text-xs px-2"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
