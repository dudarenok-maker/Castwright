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

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  IconPlay,
  IconPause,
  IconShare,
  IconRefresh,
  IconPencil,
} from '../../lib/icons';
import { SectionLabel, Pill } from '../primitives';
import { Waveform } from '../waveform';
import { parseDuration, formatTime } from '../../lib/time';
import { stripChapterPrefix } from '../../lib/format-chapter-title';
import { useAppSelector } from '../../store';
import { selectListenProgress, type ListenMarker } from '../../store/listen-progress-slice';
import { ShareClipModal } from '../../modals/share-clip';
import { EditChapterTitleModal } from '../../modals/edit-chapter-title';
import { LoudnessReport, classifyDrift } from '../loudness-report';
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
  /* Plan 69 — share-clip modal is hoisted to the region level so it can
     read the listen-progress slice for the current playhead without each
     row carrying its own copy. The button lives per-row though, alongside
     the chapter's play affordance. */
  const [shareClipChapter, setShareClipChapter] = useState<Chapter | null>(null);
  /* Plan 78 — chapter rename modal hoisted to region level, mirroring
     the share-clip pattern. One modal mount, opened/closed per pencil
     click on a row. */
  const [renameChapter, setRenameChapter] = useState<Chapter | null>(null);
  const progress = useAppSelector(selectListenProgress(bookId));
  /* When the chapter we're sharing is the same one currently playing,
     centre the default ±15 s window on the resume bookmark (which the
     mini-player keeps updating). Otherwise fall back to null and the
     modal centres on chapter midpoint. */
  const sharePlayhead =
    shareClipChapter && progress?.chapterId === shareClipChapter.id ? progress.currentSec : null;

  /* Plan 93 — virtualise the chapter list above 40 rows. The list
     already has its own internal scroll container (max-h-[560px]) so
     `useVirtualizer` with `getScrollElement` pointing at that ref is
     the right shape (vs. manuscript's `useWindowVirtualizer`). Below
     the threshold the flat-render path keeps the simple DOM tree. */
  const chapterListRef = useRef<HTMLDivElement>(null);
  const chapterVirtEnabled = listenable.length >= 40;
  const chapterVirtualizer = useVirtualizer({
    count: chapterVirtEnabled ? listenable.length : 0,
    getScrollElement: () => chapterListRef.current,
    estimateSize: () => 88,
    overscan: 5,
  });

  return (
    <>
      <MarkersPanel
        bookId={bookId}
        chapters={chapters}
        onSeek={onSeekMarker}
        onDelete={onDeleteMarker}
      />

      <section className="mb-8 md:mb-12">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionLabel>Chapters</SectionLabel>
          <span className="text-xs text-ink/50 hidden sm:inline">
            Click any chapter to play from there
          </span>
        </div>
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          {/* Cap the list so a 59-chapter book doesn't push the rest of the
              Listen view off-screen. Inner div owns the scroll so the card's
              rounded corners stay clean; scrollbar-thin paints an inset thumb
              that clears those corners. */}
          <div
            ref={chapterListRef}
            data-testid="listen-chapters-scroll"
            className="max-h-[560px] overflow-y-auto scrollbar-thin divide-y divide-ink/5"
          >
            {chapterVirtEnabled ? (
              <div
                data-testid="listen-chapters-virtual-container"
                style={{ position: 'relative', height: chapterVirtualizer.getTotalSize() }}
              >
                {chapterVirtualizer.getVirtualItems().map((virtualItem) => {
                  const ch = listenable[virtualItem.index];
                  const charsIn = Object.entries(ch.characters)
                    .filter(([, st]) => st !== 'skipped')
                    .map(([id]) => findChar(id))
                    .filter(Boolean) as Character[];
                  return (
                    <div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={chapterVirtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <ChapterListenRow
                        bookId={bookId}
                        chapter={ch}
                        charactersIn={charsIn}
                        isPlaying={currentTrack === ch.id}
                        onPlay={() => onPlayChapter(currentTrack === ch.id ? null : ch.id)}
                        onRegenerate={onRegenerate}
                        onShareClip={() => setShareClipChapter(ch)}
                        onRename={() => setRenameChapter(ch)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              listenable.map((ch) => {
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
                    onShareClip={() => setShareClipChapter(ch)}
                    onRename={() => setRenameChapter(ch)}
                  />
                );
              })
            )}
          </div>
        </div>
      </section>

      <LoudnessReport chapters={listenable} />

      <ShareClipModal
        open={shareClipChapter !== null}
        bookId={bookId}
        chapter={shareClipChapter}
        playheadSec={sharePlayhead}
        durationSec={shareClipChapter ? parseDuration(shareClipChapter.duration) : 0}
        onClose={() => setShareClipChapter(null)}
      />

      <EditChapterTitleModal
        key={renameChapter?.id ?? 'closed'}
        open={renameChapter !== null}
        bookId={bookId}
        chapter={renameChapter}
        onClose={() => setRenameChapter(null)}
      />
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
  /** Plan 69 — opens the Share-clip modal for this chapter. The
      region-level component owns the modal state so it can read the
      cross-row playhead from the listen-progress slice. */
  onShareClip: () => void;
  /** Plan 78 — opens the rename modal for this chapter. Region-level
      modal mount; row only knows "open the rename modal for me". */
  onRename: () => void;
}

function ChapterListenRow({
  bookId,
  chapter,
  charactersIn,
  isPlaying,
  onPlay,
  onRegenerate,
  onShareClip,
  onRename,
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
      className={`px-4 sm:px-5 py-3 sm:py-4 transition-colors ${isPlaying ? 'bg-peach/[0.06]' : 'hover:bg-ink/[0.02]'}`}
    >
      {/* On <md the row stacks the title block above a control strip
          (play + waveform + duration + actions) so the chapter title
          gets its own line and the controls don't overflow at 375 px.
          md+ keeps the original 6-column grid for the desktop layout. */}
      <div className="md:grid md:grid-cols-[40px_60px_1fr_220px_100px_104px] md:items-center md:gap-4 flex flex-col gap-2">
        {/* On mobile this row groups the play button, chapter number,
            title, and (collapsed) waveform metadata. md+ promotes each
            cell to a grid track. */}
        <div className="flex items-center gap-3 min-w-0 md:contents">
          <button
            onClick={onPlay}
            aria-label={isPlaying ? `Pause chapter ${chapter.id}` : `Play chapter ${chapter.id}`}
            className={`shrink-0 w-11 h-11 md:w-9 md:h-9 rounded-full grid place-items-center transition-all ${isPlaying ? 'bg-ink text-canvas' : 'bg-canvas border border-ink/15 text-ink hover:bg-ink hover:text-canvas'}`}
          >
            {isPlaying ? (
              <IconPause className="w-3.5 h-3.5" />
            ) : (
              <IconPlay className="w-3.5 h-3.5 ml-0.5" />
            )}
          </button>
          <span className="shrink-0 text-sm font-bold text-ink/50 tabular-nums">
            CH {String(chapter.id).padStart(2, '0')}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink truncate">
                {stripChapterPrefix(chapter.title)}
              </span>
              {showResume && resume && (
                <Pill color="library">Resume at {formatTime(resume.currentSec)}</Pill>
              )}
              <LoudnessBadge chapter={chapter} />
            </span>
            <span className="block text-xs text-ink/50 truncate mt-0.5">
              With{' '}
              {charactersIn
                .slice(0, 4)
                .map((c) => c.name)
                .join(', ')}
            </span>
          </span>
        </div>
        {/* Waveform: visible md+ where it has horizontal room. Hiding
            on phone keeps the row scannable in a single tap-friendly
            column. */}
        <div className="hidden md:block">
          <Waveform progress={isPlaying ? progress : 0} active={isPlaying} />
        </div>
        {/* Mobile bottom strip: duration on the left, action pills on
            the right. md+ promotes the spans into their original grid
            cells. */}
        <div className="flex items-center gap-2 md:contents pl-14 md:pl-0">
          <span className="text-sm tabular-nums text-ink/60 md:text-right flex-1 md:flex-none">
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
              onClick={onRename}
              title="Rename chapter"
              aria-label={`Rename chapter ${chapter.id}`}
              data-testid={`chapter-row-${chapter.id}-rename`}
              className="text-ink/40 hover:text-magenta grid place-items-center w-11 h-11 md:w-8 md:h-8 rounded-full hover:bg-ink/[0.04]"
            >
              <IconPencil className="w-4 h-4" />
            </button>
            <button
              onClick={() => onRegenerate(chapter)}
              title="Regenerate"
              aria-label={`Regenerate chapter ${chapter.id}`}
              className="text-ink/40 hover:text-magenta grid place-items-center w-11 h-11 md:w-8 md:h-8 rounded-full hover:bg-ink/[0.04]"
            >
              <IconRefresh className="w-4 h-4" />
            </button>
            <button
              onClick={onShareClip}
              title="Share a 30-second clip"
              aria-label={`Share clip of chapter ${chapter.id}`}
              data-testid={`chapter-row-${chapter.id}-share-clip`}
              className="text-ink/40 hover:text-magenta grid place-items-center w-11 h-11 md:w-8 md:h-8 rounded-full hover:bg-ink/[0.04]"
            >
              <IconShare className="w-4 h-4" />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/* Plan 77 — per-chapter EBU R128 drift badge. Renders only when the
   chapter has a real two-pass loudness measurement on disk; single-pass
   values are NOT post-filter measurements (they're the nominal target
   restated) so they degrade to a null render rather than mislead. The
   colour mirrors the report-card sparkline: green (≤2 LU), amber (2–4 LU),
   rose (>4 LU). Hover reveals i / lra / tp / target / measured-at via
   the native title tooltip — keeps the row chrome light without dragging
   in a popover primitive just for this. */
function LoudnessBadge({ chapter }: { chapter: Chapter }) {
  const lufs = chapter.lufs;
  const bucket = classifyDrift(lufs ?? null);
  if (bucket === 'no-data') return null;
  if (!lufs || lufs.twoPass !== true) return null;
  const pillColor: 'success' | 'warning' | 'danger' =
    bucket === 'on-target' ? 'success' : bucket === 'slight' ? 'warning' : 'danger';
  const driftLabel =
    bucket === 'on-target' ? 'On target' : bucket === 'slight' ? 'Slight drift' : 'Off target';
  const measuredAtNote = lufs.measuredAt
    ? `Measured ${new Date(lufs.measuredAt).toLocaleString()}`
    : '';
  const lufsCompact = lufs.i.toFixed(1).startsWith('-')
    ? `−${lufs.i.toFixed(1).slice(1)} LUFS`
    : `${lufs.i.toFixed(1)} LUFS`;
  const title =
    `${driftLabel} — ${lufsCompact} (target ${lufs.target} LUFS).` +
    ` LRA ${lufs.lra.toFixed(1)} LU, true peak ${lufs.tp.toFixed(1)} dBTP.` +
    (measuredAtNote ? ` ${measuredAtNote}` : '');
  return (
    <span
      data-testid={`chapter-row-${chapter.id}-lufs-badge`}
      data-bucket={bucket}
      title={title}
      aria-label={`${driftLabel}: ${lufsCompact}`}
      className="inline-flex"
    >
      <Pill color={pillColor}>{lufsCompact}</Pill>
    </span>
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
    <section data-testid="listen-markers-panel" className="mb-8 md:mb-12">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <SectionLabel>Markers</SectionLabel>
        <span className="text-xs text-ink/50">
          {markers.length} bookmark{markers.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5">
        {groups.map((g) => (
          <div key={g.chapter.id} className="px-4 sm:px-5 py-4">
            <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/50 mb-2 truncate">
              CH {String(g.chapter.id).padStart(2, '0')} · {stripChapterPrefix(g.chapter.title)}
            </p>
            <ul className="space-y-1">
              {g.markers.map((m) => (
                <li
                  key={m.id}
                  data-testid={`listen-marker-${m.id}`}
                  className="flex items-center gap-2 text-sm text-ink/80"
                >
                  <button
                    type="button"
                    onClick={() => onSeek(m)}
                    data-testid={`listen-marker-seek-${m.id}`}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left hover:text-ink min-h-[44px]"
                  >
                    <span className="tabular-nums text-xs text-ink/50 w-12 shrink-0">
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
                    className="shrink-0 w-11 h-11 md:w-8 md:h-8 grid place-items-center rounded-full text-ink/40 hover:text-rose-500 hover:bg-ink/[0.04]"
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
