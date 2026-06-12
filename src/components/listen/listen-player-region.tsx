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
import { api } from '../../lib/api';
import { parseDuration, formatTime } from '../../lib/time';
import { stripChapterPrefix } from '../../lib/format-chapter-title';
import { useAppSelector } from '../../store';
import {
  selectListenProgress,
  selectLivePlaybackFor,
  type ListenMarker,
} from '../../store/listen-progress-slice';
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
  /** fs-26 — flip a marker between a plain note and a re-record marker. */
  onSetMarkerKind: (markerId: string, kind: ListenMarker['kind']) => void;
  /** fs-26 — open the per-line re-record fix scoped to this marker's segment. */
  onFixLine: (marker: ListenMarker) => void;
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
  onSetMarkerKind,
  onFixLine,
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
        onSetKind={onSetMarkerKind}
        onFixLine={onFixLine}
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

/* Module-level cache of fetched per-chapter loudness envelopes, keyed by
   book + chapter + render stamp. A re-record (new audioRenderedAt) busts the
   entry — mirroring the mini-player's render-stamp cache-bust — while ordinary
   re-renders and virtualiser re-mounts reuse the cached array instead of
   refetching. Shared across every row in the list. */
const peaksCache = new Map<string, number[]>();

function peaksCacheKey(bookId: string, chapter: Chapter): string {
  return `${bookId}:${chapter.id}:${chapter.audioRenderedAt ?? ''}`;
}

/* Lazily fetch the real loudness envelope for a `done` chapter so its row's
   waveform reflects the actual audio rather than the seeded decorative shape.
   Reuses the same getChapterAudio endpoint the mini-player already calls.
   Returns null while loading, on error, or for chapters with no rendered audio
   — in which case <Waveform> falls back to its seeded bars. */
function useChapterPeaks(bookId: string, chapter: Chapter): number[] | null {
  const hasAudio = chapter.state === 'done';
  const key = peaksCacheKey(bookId, chapter);
  const [peaks, setPeaks] = useState<number[] | null>(() =>
    hasAudio ? peaksCache.get(key) ?? null : null,
  );
  useEffect(() => {
    if (!hasAudio) {
      setPeaks(null);
      return;
    }
    const cached = peaksCache.get(key);
    if (cached) {
      setPeaks(cached);
      return;
    }
    let cancelled = false;
    api
      .getChapterAudio({ bookId, chapterId: chapter.id, duration: chapter.duration })
      .then((meta) => {
        if (cancelled) return;
        const next = meta.peaks ?? [];
        if (next.length > 0) {
          peaksCache.set(key, next);
          setPeaks(next);
        } else {
          setPeaks(null);
        }
      })
      .catch(() => {
        /* Non-fatal — the row keeps the seeded waveform shape. */
        if (!cancelled) setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, chapter.id, chapter.duration, hasAudio, key]);
  return peaks;
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
  /* Plan 47 — read the per-book resume bookmark. The pill renders only
     when it points at THIS chapter and the user got past the first 5 s
     (same noise-floor as the mini-player's save gate). Plan 125: suppress
     it while THIS chapter is actively playing — once you're listening past
     the bookmark, "Resume at …" is noise (the live row time covers it). */
  const resume = useAppSelector(selectListenProgress(bookId));
  const showResume = !isPlaying && resume?.chapterId === chapter.id && resume.currentSec > 5;
  /* Plan 125 — mirror the mini-player's real playhead. The narrowed
     selector returns null for every row except the one actually playing,
     so only that row re-renders on each ~2 Hz tick. Falls back to the
     chapter-metadata duration until the first live tick lands. */
  const live = useAppSelector(selectLivePlaybackFor(bookId, chapter.id));
  const totalSec = live?.durationSec || parseDuration(chapter.duration);
  const elapsedSec = live ? Math.min(live.currentSec, totalSec) : 0;
  const progress = totalSec ? elapsedSec / totalSec : 0;
  /* Real per-chapter loudness envelope for the waveform bars; null until the
     fetch lands (or for not-yet-generated rows), where <Waveform> falls back
     to its seeded shape. */
  const peaks = useChapterPeaks(bookId, chapter);
  /* A chapter only has audio to play or share once it's `done` — the
     other states (queued / in_progress / failed) carry a placeholder
     "0:00" duration and no file. Gate the Play + Share affordances on
     this so the row reads as inert until generation lands, and surface
     the state instead of a misleading "0:00". Regenerate stays active —
     on a non-done chapter it can kick off (or retry) generation. */
  const hasAudio = chapter.state === 'done';
  const statusLabel =
    chapter.state === 'in_progress'
      ? 'Generating…'
      : chapter.state === 'failed'
        ? 'Failed'
        : 'Queued';
  return (
    <div
      data-testid={`chapter-row-${chapter.id}`}
      className={`px-4 sm:px-5 py-3 sm:py-4 transition-colors ${isPlaying ? 'bg-peach/6' : 'hover:bg-ink/2'}`}
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
            disabled={!hasAudio}
            aria-label={
              !hasAudio
                ? `Chapter ${chapter.id} not yet generated`
                : isPlaying
                  ? `Pause chapter ${chapter.id}`
                  : `Play chapter ${chapter.id}`
            }
            {...(chapter.id === 1 ? { 'data-tour-id': 'chapter-1-play' } : {})}
            className={`shrink-0 w-11 h-11 md:w-9 md:h-9 rounded-full grid place-items-center transition-all ${
              !hasAudio
                ? 'bg-canvas border border-ink/10 text-ink/30 opacity-50 cursor-not-allowed'
                : isPlaying
                  ? 'bg-ink text-canvas'
                  : 'bg-canvas border border-ink/15 text-ink hover:bg-ink hover:text-canvas'
            }`}
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
              {/* srv-27 — advisory QA flag. Renders only when the rendered audio
                  was flagged suspect; the reasons sit in the tooltip. */}
              {chapter.state === 'done' && chapter.audioQa?.status === 'suspect' && (
                <span
                  className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                  title={chapter.audioQa.reasons.join(' ')}
                  data-testid={`chapter-row-${chapter.id}-qa-suspect`}
                >
                  Suspect
                </span>
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
        </div>
        {/* Waveform: visible md+ where it has horizontal room. Hiding
            on phone keeps the row scannable in a single tap-friendly
            column. */}
        <div className="hidden md:block">
          <Waveform
            progress={isPlaying ? progress : 0}
            active={isPlaying}
            peaks={peaks ?? undefined}
          />
        </div>
        {/* Mobile bottom strip: duration on the left, action pills on
            the right. md+ promotes the spans into their original grid
            cells. */}
        <div className="flex items-center gap-2 md:contents pl-14 md:pl-0">
          <span className="text-sm tabular-nums text-ink/60 md:text-right flex-1 md:flex-none">
            {!hasAudio ? (
              <span className={chapter.state === 'failed' ? 'text-rose-500' : 'text-ink/40'}>
                {statusLabel}
              </span>
            ) : isPlaying ? (
              <span className="text-ink font-semibold">
                {formatTime(elapsedSec)} / {formatTime(totalSec)}
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
              className="text-ink/40 hover:text-magenta grid place-items-center w-11 h-11 md:w-8 md:h-8 rounded-full hover:bg-ink/4"
            >
              <IconPencil className="w-4 h-4" />
            </button>
            <button
              onClick={() => onRegenerate(chapter)}
              title="Regenerate"
              aria-label={`Regenerate chapter ${chapter.id}`}
              className="text-ink/40 hover:text-magenta grid place-items-center w-11 h-11 md:w-8 md:h-8 rounded-full hover:bg-ink/4"
            >
              <IconRefresh className="w-4 h-4" />
            </button>
            <button
              onClick={onShareClip}
              disabled={!hasAudio}
              title={hasAudio ? 'Share a 30-second clip' : 'No audio to share yet'}
              aria-label={
                hasAudio
                  ? `Share clip of chapter ${chapter.id}`
                  : `Chapter ${chapter.id} has no audio to share yet`
              }
              data-testid={`chapter-row-${chapter.id}-share-clip`}
              className={`grid place-items-center w-11 h-11 md:w-8 md:h-8 rounded-full ${
                hasAudio
                  ? 'text-ink/40 hover:text-magenta hover:bg-ink/4'
                  : 'text-ink/20 opacity-50 cursor-not-allowed'
              }`}
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
  onSetKind: (markerId: string, kind: ListenMarker['kind']) => void;
  onFixLine: (marker: ListenMarker) => void;
}
function MarkersPanel({
  bookId,
  chapters,
  onSeek,
  onDelete,
  onSetKind,
  onFixLine,
}: MarkersPanelProps) {
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
                  {/* fs-26 — per-line re-record entry. Only a re-record marker
                      can launch the fix; the kind toggle next to it promotes a
                      plain note into one. */}
                  {m.kind === 'rerecord' && (
                    <button
                      type="button"
                      onClick={() => onFixLine(m)}
                      data-testid={`listen-marker-fix-${m.id}`}
                      className="shrink-0 px-3 min-h-[44px] md:min-h-0 md:py-1.5 grid place-items-center rounded-full text-xs font-semibold text-magenta hover:bg-magenta/10"
                    >
                      Fix this line
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      onSetKind(m.id, m.kind === 'rerecord' ? 'note' : 'rerecord')
                    }
                    aria-pressed={m.kind === 'rerecord'}
                    aria-label={
                      m.kind === 'rerecord'
                        ? 'Mark as plain note'
                        : 'Mark for re-record'
                    }
                    title={
                      m.kind === 'rerecord'
                        ? 'Mark as plain note'
                        : 'Mark for re-record'
                    }
                    data-testid={`listen-marker-kind-${m.id}`}
                    className={`shrink-0 w-11 h-11 md:w-8 md:h-8 grid place-items-center rounded-full hover:bg-ink/4 ${m.kind === 'rerecord' ? 'text-magenta' : 'text-ink/40 hover:text-magenta'}`}
                  >
                    <IconRefresh className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(m.id)}
                    aria-label="Delete marker"
                    data-testid={`listen-marker-delete-${m.id}`}
                    className="shrink-0 w-11 h-11 md:w-8 md:h-8 grid place-items-center rounded-full text-ink/40 hover:text-rose-500 hover:bg-ink/4"
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
