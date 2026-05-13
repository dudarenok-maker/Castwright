import { useEffect, useMemo, useState } from 'react';
import {
  IconPlay, IconPause, IconCheck, IconSpinner, IconWarning,
  IconArrowDn, IconRefresh, IconClose, IconHistory, IconClock,
} from '../lib/icons';
import type { SidecarHealth } from '../lib/api';
import {
  SectionLabel, MixedHeading, Pill, ColorDot,
} from '../components/primitives';
import { useAppDispatch, useAppSelector } from '../store';
import { chaptersActions, STALL_THRESHOLD_MS } from '../store/chapters-slice';
import { api } from '../lib/api';
import { ttsModelLabel } from '../lib/tts-models';
import { parseDuration, formatTime } from '../lib/time';
import { CHAR_COLORS } from '../lib/colors';
import {
  characterLinePositionsByChapter, characterStatsByChapter, linesDoneAt,
  overallProgress, sentencesPerChapter,
} from '../lib/generation-progress';
import { withRecomputedDisplay } from '../lib/change-log';
import { LOG_TYPES } from '../data/log-types';
import type {
  Chapter, Character, CharColor, ChapterAudio, ChangeLogEvent, TtsModelKey,
} from '../lib/types';

const ACTIVITY_FEED_TYPES: ChangeLogEvent['type'][] = [
  'regenerate', 'chapter_complete', 'chapter_failed', 'generation_started',
];

interface Props {
  chapters: Chapter[];
  characters: Character[];
  paused: boolean;
  title?: string | null;
  bookId: string;
  modelKey: TtsModelKey;
  setPaused: (p: boolean) => void;
  onRegenerate: (ch: Chapter) => void;
  onRegenerateCharacterInChapter: (charId: string, chapterId: number) => void;
  onPreview: (chapterId: number) => void;
}

export function GenerationView({
  chapters, characters, paused, title, bookId, modelKey,
  setPaused, onRegenerate, onRegenerateCharacterInChapter, onPreview,
}: Props) {
  const dispatch = useAppDispatch();
  const lastError           = useAppSelector(s => s.chapters.lastError);
  const generationStartedAt = useAppSelector(s => s.chapters.generationStartedAt);
  const lastTickAt          = useAppSelector(s => s.chapters.lastTickAt);
  const sentences           = useAppSelector(s => s.manuscript.sentences);
  const activityEvents      = useAppSelector(s => s.changeLog.events);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  /* Manuscript-derived shape used both for accurate overall-progress
     weighting (so 3 hydrated-Done chapters don't collapse the bar to the
     in-flight chapter's progress) and for the per-character lines/words
     readout in the expanded chapter rows. */
  const manuscriptCounts   = useMemo(() => sentencesPerChapter(sentences), [sentences]);
  const characterStats     = useMemo(() => characterStatsByChapter(sentences), [sentences]);
  /* Per-character line positions inside each chapter — drives the truthful
     fractional bar in the expanded row instead of the slice's "active
     speaker only" status field. See generation-progress.ts. */
  const characterPositions = useMemo(() => characterLinePositionsByChapter(sentences), [sentences]);

  /* SSE ownership lives in src/store/generation-stream-middleware.ts so the
     stream survives navigating away from this view. The view is a pure
     renderer of slice state now. */

  const completed     = chapters.filter(c => c.state === 'done').length;
  const failed        = chapters.filter(c => c.state === 'failed').length;
  const inProgressCnt = chapters.filter(c => c.state === 'in_progress').length;
  const queued        = chapters.filter(c => c.state === 'queued').length;

  /* Sentence-weighted overall progress. Weights come from the manuscript
     when available (canonical for the whole book), then the live
     totalLines tick, then average-known, then equal-weight — see
     `overallProgress` for the precedence chain. */
  const totalProgress = overallProgress(chapters, manuscriptCounts);

  /* Real ETA from wall-clock elapsed × (1 - progress) / progress. Only
     surface when there's enough signal to avoid a wild initial estimate.
     Disappears entirely when the queue is drained.

     The same 1s tick also drives the stall detection re-render — without
     it the derived `stalled` would only flip when the slice mutates, and a
     truly hung worker (no ticks landing) wouldn't trigger any slice
     mutation, so the user would never see "Stalled" appear. We trigger
     while either an in-progress chapter exists OR ETA is live. */
  const [, forceTick] = useState(0);
  const needsClock = (generationStartedAt != null) || inProgressCnt > 0;
  useEffect(() => {
    if (!needsClock || paused) return;
    const id = setInterval(() => forceTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [needsClock, paused]);
  const elapsedMs = generationStartedAt ? Date.now() - generationStartedAt : 0;
  const etaSec = (generationStartedAt && totalProgress > 0.05 && totalProgress < 1)
    ? (elapsedMs / totalProgress) * (1 - totalProgress) / 1000
    : null;

  /* Honest "runtime so far" — sum of completed chapter durations. Replaces
     the hardcoded "4h 38m". */
  const runtimeSec = chapters
    .filter(c => c.state === 'done')
    .reduce((s, c) => s + parseDuration(c.duration), 0);

  const blocked = lastError != null;
  const engineLabel = ttsModelLabel(modelKey);

  /* "Stalled" = there's an in-progress chapter but the SSE has been silent
     for longer than STALL_THRESHOLD_MS. Reading `Date.now()` directly is fine
     because the ETA `forceTick` interval re-renders this view every second
     while a run is active, so the derived value updates without an extra
     timer. Cleared by every non-idle tick and by the slice on idle. */
  const stalledMs = lastTickAt && inProgressCnt > 0 && !paused
    ? Date.now() - lastTickAt
    : 0;
  const stalled = stalledMs > STALL_THRESHOLD_MS;
  const stalledSec = stalled ? Math.floor(stalledMs / 1000) : 0;

  /* `e.at` is the ISO timestamp set on every event the middleware or a
     user-confirm handler emits at runtime. Hand-authored fixture entries in
     src/data/change-log.ts omit it, so this filter keeps the sidebar honest
     — only real, this-session/this-book activity shows up; the demo seed
     stays out. */
  const recentActivity = useMemo(() => {
    const filtered = activityEvents.filter(e => e.at && ACTIVITY_FEED_TYPES.includes(e.type));
    return withRecomputedDisplay(filtered).slice(0, 6);
  }, [activityEvents]);

  /* Poll the sidecar /health endpoint so the user can tell "is the local TTS
     process even up?" without waiting for a chapter to actually fail. Poll
     every 30s while we're on this view, plus an immediate re-check whenever
     a stream-level error lands (it's the single most useful diagnostic
     follow-up after `chapter_failed`). */
  const [sidecarHealth, setSidecarHealth] = useState<SidecarHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      api.getSidecarHealth()
        .then(h => { if (!cancelled) setSidecarHealth(h); })
        .catch(() => { if (!cancelled) setSidecarHealth({ status: 'unreachable', url: '', error: 'Probe failed.' }); });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [lastError]);

  /* Sub-chapter "lines synthesised" counter so the user has a tangible
     "something is happening" signal at every tick (real backend emits one
     `progress` tick per same-speaker group; each group ships ~1-2 lines).

     Lines done = totalLines for chapters in `done`, currentLine for the
     in-flight chapter, 0 for queued. Total = totalLines from the SSE when
     available, else the manuscript-derived count (canonical, known before
     any tick fires). */
  const linesCounter = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const ch of chapters) {
      const chTotal = ch.totalLines ?? manuscriptCounts[ch.id] ?? 0;
      total += chTotal;
      if (ch.state === 'done') done += chTotal;
      else if (ch.state === 'in_progress') done += ch.currentLine ?? 0;
    }
    return { done, total };
  }, [chapters, manuscriptCounts]);

  return (
    <div className="max-w-[1100px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Audiobook generation</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Generating" bold={title || 'your audiobook'} level="h1"/>
          </div>
          <p className="mt-3 text-ink/60">
            {completed} of {chapters.length} chapters complete
            {etaSec != null && <> · approx. {formatTime(etaSec)} remaining</>}
          </p>
          {linesCounter.total > 0 && (
            <p className="mt-1 text-xs text-ink/55 tabular-nums">
              <span className="font-semibold text-ink/75">{linesCounter.done.toLocaleString()}</span>
              {' '}of {linesCounter.total.toLocaleString()} lines synthesised
            </p>
          )}
          <p className="mt-1 text-xs text-ink/50 inline-flex items-center gap-2 flex-wrap">
            <span>Engine: <span className="font-medium text-ink/70">{engineLabel}</span></span>
            {sidecarHealth && <SidecarStatusPill health={sidecarHealth}/>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setPaused(!paused)} className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2">
            {paused ? <><IconPlay className="w-4 h-4"/> Resume</> : <><IconPause className="w-4 h-4"/> Pause</>}
          </button>
        </div>
      </div>

      {lastError && (
        <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50/70 px-5 py-4 flex items-start gap-3 fade-in">
          <IconWarning className="w-5 h-5 text-rose-600 shrink-0 mt-0.5"/>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-rose-900">Generation halted</p>
            <p className="text-sm text-rose-800/90 mt-0.5">{lastError}</p>
          </div>
          <button onClick={() => dispatch(chaptersActions.clearLastError())}
                  className="p-1.5 rounded-full text-rose-600/70 hover:text-rose-700 hover:bg-rose-100">
            <IconClose className="w-4 h-4"/>
          </button>
        </div>
      )}

      {stalled && !lastError && (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50/70 px-5 py-4 flex items-start gap-3 fade-in">
          <IconClock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5"/>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">Worker has gone quiet</p>
            <p className="text-sm text-amber-800/90 mt-0.5">
              No progress for {stalledSec}s. The TTS engine may be retrying — give it a moment, or pause and resume to reset the stream.
            </p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-6 mb-8">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">Overall progress</p>
          <span className="text-sm font-bold text-ink tabular-nums">{Math.round(totalProgress * 100)}%</span>
        </div>
        <div className="relative h-3 rounded-full bg-ink/[0.06] overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-gradient-progress rounded-full transition-all" style={{ width: `${totalProgress * 100}%` }}>
            {!paused && <div className="absolute inset-0 stripe-travel"/>}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-4 pt-4 border-t border-ink/10">
          <Stat label="Completed"   value={completed}/>
          <Stat label="In progress" value={inProgressCnt}/>
          <Stat label="Queued"      value={queued}/>
          <Stat label="Failed"      value={failed} danger/>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-3 min-w-0">
          {chapters.map(ch => (
            <ChapterRow key={ch.id} chapter={ch} characters={characters} bookId={bookId}
                        expanded={!!expanded[ch.id]} onToggle={() => setExpanded({ ...expanded, [ch.id]: !expanded[ch.id] })}
                        paused={paused} blocked={blocked} stalled={stalled}
                        charStats={characterStats[ch.id]}
                        charPositions={characterPositions[ch.id]}
                        onRegenerate={onRegenerate}
                        onRegenerateCharacterInChapter={onRegenerateCharacterInChapter}
                        onPreview={onPreview}/>
          ))}
        </div>
        <aside className="lg:sticky lg:top-20 self-start bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          <header className="flex items-center justify-between px-5 py-4 border-b border-ink/10">
            <span className="text-sm font-semibold text-ink inline-flex items-center gap-2">
              <IconHistory className="w-4 h-4 text-ink/60"/> Activity
            </span>
            <a href={`#/books/${bookId}/log`}
               className="text-xs font-medium text-ink/55 hover:text-ink transition-colors">
              View all →
            </a>
          </header>
          {recentActivity.length === 0 ? (
            <p className="px-5 py-6 text-xs text-ink/50">
              Activity from this generation run will appear here as chapters complete or fail.
            </p>
          ) : (
            <ul className="divide-y divide-ink/5">
              {recentActivity.map(e => <ActivityRow key={e.id} event={e}/>)}
            </ul>
          )}
        </aside>
      </div>

      <div className="mt-10 pt-6 border-t border-ink/10 flex items-center justify-between text-xs text-ink/50 flex-wrap gap-3">
        <div className="flex items-center gap-6 flex-wrap">
          <span>Output: WAV (16-bit PCM)</span>
          <span>·</span>
          <span>Runtime so far: <span className="tabular-nums text-ink/70">{runtimeSec > 0 ? formatTime(runtimeSec) : '0:00'}</span></span>
        </div>
      </div>
    </div>
  );
}

function SidecarStatusPill({ health }: { health: SidecarHealth }) {
  const reachable = health.status === 'reachable';
  /* User-facing copy: "Sidecar" is implementation jargon — the user thinks in
     terms of "is the model up so I can generate". Tooltip keeps the technical
     URL for diagnostics. Two states; the in-between "slow / loading" is
     intentionally folded into unavailable for now — both block synthesis from
     the user's perspective, and the timeout copy in the tooltip explains it. */
  return (
    <span
      title={health.error || (reachable ? `Local TTS reachable at ${health.url}` : 'Local TTS process not reachable')}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
        reachable
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          : 'bg-rose-50 text-rose-700 border border-rose-200'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${reachable ? 'bg-emerald-500' : 'bg-rose-500'}`}/>
      {reachable ? 'Model ready' : 'Model unavailable'}
    </span>
  );
}

function ActivityRow({ event }: { event: ChangeLogEvent }) {
  const t = LOG_TYPES[event.type] || { icon: <IconHistory className="w-3.5 h-3.5"/>, color: '#6B6663', label: event.type };
  return (
    <li className="grid grid-cols-[auto_1fr] gap-3 px-5 py-3">
      <span className="w-7 h-7 rounded-full grid place-items-center text-white shrink-0 mt-0.5"
            style={{ background: t.color }}>
        {t.icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink truncate">{event.title}</p>
        <p className="text-[11px] text-ink/60 leading-snug line-clamp-2">{event.note}</p>
        <p className="mt-1 text-[10px] text-ink/45 tabular-nums inline-flex items-center gap-1">
          <IconClock className="w-2.5 h-2.5"/> {event.ts}
        </p>
      </div>
    </li>
  );
}

export function Stat({ label, value, danger, small }: { label: string; value: number | string; danger?: boolean; small?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-1">{label}</p>
      <p className={`${small ? 'text-base' : 'text-2xl'} font-bold tabular-nums ${danger && typeof value === 'number' && value > 0 ? 'text-magenta' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

interface ChapterRowProps {
  chapter: Chapter;
  characters: Character[];
  bookId: string;
  expanded: boolean;
  onToggle: () => void;
  paused: boolean;
  blocked: boolean;
  stalled: boolean;
  charStats: Record<string, { lines: number; words: number }> | undefined;
  charPositions: Record<string, number[]> | undefined;
  onRegenerate: (ch: Chapter) => void;
  onRegenerateCharacterInChapter: (charId: string, chapterId: number) => void;
  onPreview: (chapterId: number) => void;
}

function ChapterRow({
  chapter, characters, bookId, expanded, onToggle, paused, blocked, stalled, charStats, charPositions,
  onRegenerate, onRegenerateCharacterInChapter, onPreview,
}: ChapterRowProps) {
  const assembling = chapter.phase === 'assembling';
  const rowStalled = stalled && chapter.state === 'in_progress';
  const inProgressLabel = rowStalled
    ? 'Stalled'
    : assembling
      ? 'Assembling…'
      : paused ? 'Paused' : 'Generating';
  const inProgressPill = rowStalled
    ? <Pill color="warning">Stalled</Pill>
    : <Pill color="peach">{inProgressLabel}</Pill>;
  const queuedPill = blocked
    ? <Pill color="danger">Blocked</Pill>
    : <Pill>Queued</Pill>;
  const inProgressIcon = rowStalled
    ? <IconClock   className="w-4 h-4 text-amber-700"/>
    : paused
      ? <IconPause className="w-4 h-4 text-magenta"/>
      : <IconSpinner className="w-4 h-4 text-magenta"/>;
  const stateConfig = {
    done:        { tint: 'bg-emerald-50/50', badge: <Pill color="success">Done</Pill>,                                                       icon: <IconCheck   className="w-4 h-4 text-emerald-600"/> },
    in_progress: { tint: rowStalled ? 'bg-amber-50/60' : 'bg-peach/[0.06]', badge: inProgressPill, icon: inProgressIcon },
    queued:      { tint: blocked ? 'bg-rose-50/30' : 'bg-white', badge: queuedPill,                                                          icon: <span className="w-4 h-4 rounded-full border border-ink/20"/> },
    failed:      { tint: 'bg-rose-50/50',    badge: <Pill color="danger">Failed</Pill>,                                                     icon: <IconWarning className="w-4 h-4 text-rose-600"/> },
  }[chapter.state];

  const findChar = (id: string): Character => characters.find(c => c.id === id) || { id, name: id, role: '', color: 'narrator' };

  /* Chapter totals derived from the manuscript so the header can show
     "X words · Y lines · Z speakers" without waiting on the SSE. */
  const chapterTotals = (() => {
    if (!charStats) return null;
    const entries = Object.values(charStats);
    if (entries.length === 0) return null;
    return {
      lines:    entries.reduce((s, e) => s + e.lines, 0),
      words:    entries.reduce((s, e) => s + e.words, 0),
      speakers: entries.length,
    };
  })();

  /* Live "synthesising X · line N of Y" caption for the in-progress row.
     Replaces the queued/done static meta so the user has eye-level
     confirmation each tick that lines are moving. Falls back to the
     manuscript-derived total when the SSE hasn't shipped a totalLines
     yet (e.g. the first sub-second after Resume). */
  const liveSpeakerId = chapter.state === 'in_progress'
    ? Object.entries(chapter.characters).find(([, s]) => s === 'in_progress')?.[0]
    : undefined;
  const liveSpeaker = liveSpeakerId ? findChar(liveSpeakerId) : null;
  const liveTotal = chapter.totalLines ?? chapterTotals?.lines ?? 0;
  const liveCurrent = chapter.currentLine ?? 0;

  return (
    <div className={`rounded-3xl border border-ink/10 shadow-card overflow-hidden ${stateConfig.tint}`}>
      <button onClick={onToggle} className="w-full grid grid-cols-[32px_52px_minmax(0,1fr)_120px_64px_92px_20px] items-center gap-3 px-5 py-4 text-left">
        <span className="grid place-items-center">{stateConfig.icon}</span>
        <span className="text-sm font-bold text-ink/50 tabular-nums">CH {String(chapter.id).padStart(2, '0')}</span>
        <span className="min-w-0">
          <span className="block font-semibold text-ink truncate">{chapter.title}</span>
          {chapter.state === 'in_progress' && liveTotal > 0 ? (
            /* Live caption — swaps in once a tick has shipped totalLines so
               the user has a per-tick "moving" signal at eye level.
               Falls through to the static meta until then. */
            <span className="block text-[11px] text-magenta tabular-nums mt-0.5 truncate">
              {liveSpeaker ? `Synthesising ${liveSpeaker.name} · ` : ''}
              line {liveCurrent.toLocaleString()} of {liveTotal.toLocaleString()}
            </span>
          ) : chapterTotals && (
            <span className="block text-[11px] text-ink/50 tabular-nums mt-0.5 truncate">
              {chapterTotals.words.toLocaleString()} {chapterTotals.words === 1 ? 'word' : 'words'}
              {' · '}
              {chapterTotals.lines.toLocaleString()} {chapterTotals.lines === 1 ? 'line' : 'lines'}
              {' · '}
              {chapterTotals.speakers} {chapterTotals.speakers === 1 ? 'speaker' : 'speakers'}
            </span>
          )}
        </span>
        <ChapterProgressBar progress={chapter.progress} state={chapter.state} paused={paused} assembling={assembling}/>
        <span className="text-sm tabular-nums text-ink/60 text-right">
          {chapter.state === 'in_progress' && liveTotal > 0
            ? <span className="text-magenta">{liveCurrent}/{liveTotal}</span>
            : chapter.duration}
        </span>
        <span>{stateConfig.badge}</span>
        <span className={`text-ink/40 transition-transform ${expanded ? 'rotate-180' : ''}`}><IconArrowDn className="w-4 h-4"/></span>
      </button>
      {chapter.state === 'failed' && chapter.errorReason && (
        <div className="mx-5 mb-4 -mt-1 rounded-2xl border border-rose-200 bg-rose-50/80 px-4 py-3 flex items-start gap-3">
          <IconWarning className="w-4 h-4 text-rose-600 shrink-0 mt-0.5"/>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-rose-900">Synthesis failed</p>
            <p className="text-xs text-rose-800/90 mt-0.5 leading-relaxed">{chapter.errorReason}</p>
          </div>
          <button onClick={(e) => { e.stopPropagation(); onRegenerate(chapter); }}
                  className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-rose-700 hover:text-rose-900 transition-colors">
            <IconRefresh className="w-3.5 h-3.5"/> Retry
          </button>
        </div>
      )}
      {(chapter.state === 'done' || (chapter.state === 'failed' && !chapter.errorReason)) && (
        <div className="px-6 pb-4 -mt-2 flex justify-end items-center gap-3">
          {chapter.state === 'done' && (
            <button onClick={(e) => { e.stopPropagation(); onPreview(chapter.id); }}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-ink/70 hover:text-ink transition-colors">
              <IconPlay className="w-3.5 h-3.5"/> Preview
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onRegenerate(chapter); }} className="inline-flex items-center gap-1.5 text-xs font-medium text-ink/60 hover:text-magenta transition-colors">
            <IconRefresh className="w-3.5 h-3.5"/> {chapter.state === 'failed' ? 'Retry chapter' : 'Regenerate this chapter'}
          </button>
        </div>
      )}
      {expanded && (
        <div className="px-5 pb-5 pt-1 fade-in">
          <div className="ml-[100px] pl-4 border-l border-ink/10 space-y-2">
            {Object.entries(chapter.characters).map(([cid, status]) => {
              const c = findChar(cid);
              const stat = charStats?.[cid];
              /* Derive real per-character completion from the manuscript line
                 positions and the chapter's currentLine. The slice's `status`
                 only tells us who's *currently* speaking, not how much of each
                 character's share has been synthesised — without this fix, by
                 line 13 of 82 three characters showed full-green "Done" bars
                 because they had each spoken once before the narrator took
                 over. `done`-by-derivation respects the slice when synthesis
                 is finished (status='done' or chapter.state='done') and
                 otherwise reflects how many of this character's lines are
                 already behind us. */
              const linesTotal = stat?.lines ?? 0;
              const positions  = charPositions?.[cid];
              const derivedDone = chapter.state === 'done' || status === 'done'
                ? linesTotal
                : status === 'skipped'
                  ? 0
                  : linesDoneAt(positions, chapter.currentLine ?? 0);
              const fraction = linesTotal > 0 ? Math.min(1, derivedDone / linesTotal) : 0;
              const fullyDone = status === 'done' || chapter.state === 'done'
                || (linesTotal > 0 && derivedDone >= linesTotal);
              return (
                <div key={cid} className="grid grid-cols-[20px_1fr_140px_100px_28px] items-center gap-4 py-1.5 text-sm group">
                  <ColorDot color={c.color as CharColor} size={8}/>
                  <span className="min-w-0 flex items-baseline gap-2">
                    <span className="font-medium text-ink/90 truncate">{c.name}</span>
                    {stat && (
                      <span className="text-[11px] text-ink/40 tabular-nums shrink-0">
                        {stat.lines.toLocaleString()} {stat.lines === 1 ? 'line' : 'lines'} · {stat.words.toLocaleString()} {stat.words === 1 ? 'word' : 'words'}
                      </span>
                    )}
                  </span>
                  <CharStatusBar status={status} fraction={fraction} fullyDone={fullyDone} paused={paused}/>
                  <span className="text-xs text-ink/50 capitalize text-right tabular-nums">
                    {status === 'failed' ? (
                      <span className="text-rose-600 font-medium">Failed</span>
                    ) : status === 'skipped' ? (
                      '—'
                    ) : fullyDone ? (
                      <span className="text-emerald-700 font-medium">Done</span>
                    ) : status === 'in_progress' ? (
                      <span className="text-magenta font-medium">
                        {paused ? 'Paused' : 'Generating…'}
                        {linesTotal > 0 && <span className="text-magenta/60 font-normal"> {derivedDone}/{linesTotal}</span>}
                      </span>
                    ) : derivedDone > 0 && linesTotal > 0 ? (
                      /* Has spoken some lines but the active speaker is now
                         someone else — show real progress instead of the
                         old "Done" lie. */
                      <span className="text-ink/60">{derivedDone}/{linesTotal} done</span>
                    ) : (
                      'Queued'
                    )}
                  </span>
                  {status !== 'skipped' && (
                    <button onClick={(e) => { e.stopPropagation(); onRegenerateCharacterInChapter(cid, chapter.id); }}
                            title={`Regenerate ${c.name} in this chapter`}
                            className="opacity-0 group-hover:opacity-100 text-ink/40 hover:text-magenta grid place-items-center w-7 h-7 rounded-full hover:bg-ink/[0.06] transition-all">
                      <IconRefresh className="w-3.5 h-3.5"/>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {chapter.state === 'in_progress' && assembling && (
            <div className="mt-4 ml-[100px] text-xs text-ink/60">
              Writing chapter file… {chapter.totalLines ? `${chapter.totalLines} lines synthesised` : 'finalising audio'}.
            </div>
          )}
          {chapter.state === 'in_progress' && !assembling && chapter.currentLine != null && chapter.currentLine > 0 && (
            <div className="mt-4 ml-[100px] flex items-center gap-3 text-xs text-ink/60">
              <span>Active: <span className="font-semibold text-ink">{findChar(Object.entries(chapter.characters).find(([, s]) => s === 'in_progress')?.[0] || '').name}</span> · line {chapter.currentLine.toLocaleString()} of {chapter.totalLines?.toLocaleString()}</span>
            </div>
          )}
          {chapter.state === 'done' && (
            <ChapterSegmentStrip chapter={chapter} bookId={bookId} characters={characters}/>
          )}
        </div>
      )}
    </div>
  );
}

function ChapterProgressBar({ progress, state, paused, assembling }: { progress: number; state: Chapter['state']; paused: boolean; assembling: boolean }) {
  if (state === 'queued') return <div className="h-1.5 rounded-full bg-ink/[0.06]"/>;
  if (state === 'done')   return <div className="h-1.5 rounded-full bg-emerald-200"><div className="h-full w-full rounded-full bg-emerald-500"/></div>;
  if (state === 'failed') return <div className="h-1.5 rounded-full bg-rose-100"><div className="h-full rounded-full bg-rose-500" style={{ width: `${progress * 100}%` }}/></div>;
  if (assembling) return (
    /* Disk-write phase — neutral ink-tone bar with stripe motion to read as
       "near done, busy" rather than the magenta synthesis gradient. */
    <div className="relative h-1.5 rounded-full bg-ink/[0.06] overflow-hidden">
      <div className="absolute inset-y-0 left-0 rounded-full bg-ink/40" style={{ width: `${progress * 100}%` }}>
        {!paused && <div className="absolute inset-0 stripe-travel"/>}
      </div>
    </div>
  );
  return (
    <div className="relative h-1.5 rounded-full bg-ink/[0.06] overflow-hidden">
      <div className={`absolute inset-y-0 left-0 bg-gradient-progress rounded-full transition-all duration-700 ${paused ? '' : 'pulse-bar'}`} style={{ width: `${progress * 100}%` }}>
        {!paused && <div className="absolute inset-0 stripe-travel"/>}
      </div>
    </div>
  );
}

function CharStatusBar({ status, fraction, fullyDone, paused }: {
  status: string;
  /** Lines synthesised for this character ÷ this character's total lines.
      Clamped to [0,1] by the caller. */
  fraction: number;
  /** True when this character has no more lines to come (slice says done
      OR derived done ≥ total). Pinned full green even if `fraction` is
      slightly under 1 due to a stale tick. */
  fullyDone: boolean;
  paused: boolean;
}) {
  if (status === 'failed')  return <div className="h-1 rounded-full bg-rose-400"/>;
  if (status === 'skipped') return <div className="h-1 rounded-full bg-ink/[0.04]"/>;
  if (fullyDone)            return <div className="h-1 rounded-full bg-emerald-400"/>;

  const pct = Math.max(0, Math.min(100, fraction * 100));

  if (status === 'in_progress') return (
    /* Currently-speaking character. Bar fills to the real fraction of this
       character's lines that are behind us, with the peach gradient + stripe
       animation overlaying so it reads as "still working". Previously the
       bar was a fixed 60 %-width sliver regardless of how many lines were
       actually done. */
    <div className="relative h-1 rounded-full bg-ink/[0.06] overflow-hidden">
      <div className={`absolute inset-y-0 left-0 bg-gradient-progress rounded-full transition-all duration-500 ${paused ? '' : 'pulse-bar'}`}
           style={{ width: `${Math.max(pct, 8)}%` }}>
        {!paused && <div className="absolute inset-0 stripe-travel"/>}
      </div>
    </div>
  );

  if (pct > 0) return (
    /* Has spoken some lines but isn't the active speaker right now — show
       the real synthesised fraction in emerald so the user sees "1 of 13
       done" instead of the previous "Done" lie. */
    <div className="relative h-1 rounded-full bg-ink/[0.06] overflow-hidden">
      <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-300" style={{ width: `${pct}%` }}/>
    </div>
  );

  return <div className="h-1 rounded-full bg-ink/[0.08]"/>;
}

/* Visual confirmation that this chapter's audio was assembled in narrative
   order. Lazy-fetches the same segments JSON we already use for preview
   playback; renders coloured bands keyed to character palette colours. */
function ChapterSegmentStrip({ chapter, bookId, characters }: { chapter: Chapter; bookId: string; characters: Character[] }) {
  const [audio, setAudio] = useState<ChapterAudio | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getChapterAudio({ bookId, chapterId: chapter.id })
      .then(m => { if (!cancelled) setAudio(m); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [bookId, chapter.id]);

  if (error || !audio || !audio.segments?.length || !audio.durationSec) return null;
  const findChar = (id: string) => characters.find(c => c.id === id);

  return (
    <div className="mt-4 ml-[100px]">
      <p className="text-[10px] uppercase tracking-wider text-ink/50 font-semibold mb-1.5">Narrative order</p>
      <div className="flex h-2 rounded-full overflow-hidden bg-ink/[0.04]">
        {audio.segments.map((seg, i) => {
          const start = seg.start ?? 0;
          const end = seg.end ?? start;
          const charId = seg.characterId ?? '';
          const width = ((end - start) / audio.durationSec) * 100;
          const charColor = findChar(charId)?.color ?? 'narrator';
          const hex = CHAR_COLORS[charColor]?.hex ?? CHAR_COLORS.narrator.hex;
          return (
            <div key={i}
                 title={`${findChar(charId)?.name ?? (charId || 'unknown')} · ${formatTime(start)}–${formatTime(end)}`}
                 style={{ width: `${width}%`, background: hex }}/>
          );
        })}
      </div>
    </div>
  );
}
