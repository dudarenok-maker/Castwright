import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconPlay, IconPause, IconCheck, IconSpinner, IconWarning,
  IconArrowDn, IconRefresh, IconClose,
} from '../lib/icons';
import {
  SectionLabel, MixedHeading, Pill, ColorDot,
} from '../components/primitives';
import { useAppDispatch, useAppSelector } from '../store';
import { chaptersActions } from '../store/chapters-slice';
import { api } from '../lib/api';
import { ttsModelLabel } from '../lib/tts-models';
import { parseDuration, formatTime } from '../lib/time';
import { CHAR_COLORS } from '../lib/colors';
import {
  characterStatsByChapter, overallProgress, sentencesPerChapter,
} from '../lib/generation-progress';
import type {
  Chapter, Character, CharColor, ChapterAudio, GenerationTick, TtsModelKey,
} from '../lib/types';

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
  const pendingRegen        = useAppSelector(s => s.chapters.pendingRegen);
  const regenEpoch          = useAppSelector(s => s.chapters.regenEpoch);
  const sentences           = useAppSelector(s => s.manuscript.sentences);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  /* Manuscript-derived shape used both for accurate overall-progress
     weighting (so 3 hydrated-Done chapters don't collapse the bar to the
     in-flight chapter's progress) and for the per-character lines/words
     readout in the expanded chapter rows. */
  const manuscriptCounts = useMemo(() => sentencesPerChapter(sentences), [sentences]);
  const characterStats   = useMemo(() => characterStatsByChapter(sentences), [sentences]);

  /* Open the SSE on mount / model / regen-epoch change. We deliberately do
     NOT depend on `chapters` here — the slice handles ticks and the server
     drives the stream. `regenEpoch` is the explicit trigger for a fresh
     run with `force + chapterIds`; the spec lives in `pendingRegen` and is
     cleared on `idle`, so a paused → resumed regenerate replays correctly. */
  const pendingRef = useRef(pendingRegen);
  useEffect(() => { pendingRef.current = pendingRegen; }, [pendingRegen]);
  useEffect(() => {
    if (paused) return;
    const spec = pendingRef.current;
    const cancel = api.streamGeneration({
      bookId,
      modelKey,
      chapterIds: spec?.chapterIds,
      force: spec?.force,
      onTick: (ev: GenerationTick) => dispatch(chaptersActions.applyGenerationTick(ev)),
    });
    /* The spec has been handed to the server; consume it now so a Pause →
       Resume cycle (which aborts the SSE before any `idle` tick can clear
       the spec via the slice) doesn't re-forward force:true on Resume and
       wipe the in-flight chapter. The next regenerate sets a fresh spec
       and bumps regenEpoch, which is what re-fires this effect. */
    if (spec) dispatch(chaptersActions.consumePendingRegen());
    return cancel;
  }, [paused, dispatch, bookId, modelKey, regenEpoch]);

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
     Disappears entirely when the queue is drained. */
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!generationStartedAt || paused) return;
    const id = setInterval(() => forceTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [generationStartedAt, paused]);
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
          <p className="mt-1 text-xs text-ink/50">Engine: <span className="font-medium text-ink/70">{engineLabel}</span></p>
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

      <div className="space-y-3">
        {chapters.map(ch => (
          <ChapterRow key={ch.id} chapter={ch} characters={characters} bookId={bookId}
                      expanded={!!expanded[ch.id]} onToggle={() => setExpanded({ ...expanded, [ch.id]: !expanded[ch.id] })}
                      paused={paused} blocked={blocked}
                      charStats={characterStats[ch.id]}
                      onRegenerate={onRegenerate}
                      onRegenerateCharacterInChapter={onRegenerateCharacterInChapter}
                      onPreview={onPreview}/>
        ))}
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
  charStats: Record<string, { lines: number; words: number }> | undefined;
  onRegenerate: (ch: Chapter) => void;
  onRegenerateCharacterInChapter: (charId: string, chapterId: number) => void;
  onPreview: (chapterId: number) => void;
}

function ChapterRow({
  chapter, characters, bookId, expanded, onToggle, paused, blocked, charStats,
  onRegenerate, onRegenerateCharacterInChapter, onPreview,
}: ChapterRowProps) {
  const assembling = chapter.phase === 'assembling';
  const inProgressLabel = assembling ? 'Assembling…' : (paused ? 'Paused' : 'Generating');
  const queuedPill = blocked
    ? <Pill color="danger">Blocked</Pill>
    : <Pill>Queued</Pill>;
  const stateConfig = {
    done:        { tint: 'bg-emerald-50/50', badge: <Pill color="success">Done</Pill>,                                                       icon: <IconCheck   className="w-4 h-4 text-emerald-600"/> },
    in_progress: { tint: 'bg-peach/[0.06]',  badge: <Pill color="peach">{inProgressLabel}</Pill>,                                            icon: paused ? <IconPause className="w-4 h-4 text-magenta"/> : <IconSpinner className="w-4 h-4 text-magenta"/> },
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

  return (
    <div className={`rounded-3xl border border-ink/10 shadow-card overflow-hidden ${stateConfig.tint}`}>
      <button onClick={onToggle} className="w-full grid grid-cols-[40px_60px_1fr_180px_100px_120px_24px] items-center gap-4 px-5 py-4 text-left">
        <span className="grid place-items-center">{stateConfig.icon}</span>
        <span className="text-sm font-bold text-ink/50 tabular-nums">CH {String(chapter.id).padStart(2, '0')}</span>
        <span className="min-w-0">
          <span className="block font-semibold text-ink truncate">{chapter.title}</span>
          {chapterTotals && (
            <span className="block text-[11px] text-ink/50 tabular-nums mt-0.5">
              {chapterTotals.words.toLocaleString()} {chapterTotals.words === 1 ? 'word' : 'words'}
              {' · '}
              {chapterTotals.lines.toLocaleString()} {chapterTotals.lines === 1 ? 'line' : 'lines'}
              {' · '}
              {chapterTotals.speakers} {chapterTotals.speakers === 1 ? 'speaker' : 'speakers'}
            </span>
          )}
          {chapter.errorReason && <span className="block text-xs text-rose-600 truncate mt-0.5">{chapter.errorReason}</span>}
        </span>
        <ChapterProgressBar progress={chapter.progress} state={chapter.state} paused={paused} assembling={assembling}/>
        <span className="text-sm tabular-nums text-ink/60 text-right">{chapter.duration}</span>
        <span>{stateConfig.badge}</span>
        <span className={`text-ink/40 transition-transform ${expanded ? 'rotate-180' : ''}`}><IconArrowDn className="w-4 h-4"/></span>
      </button>
      {(chapter.state === 'done' || chapter.state === 'failed') && (
        <div className="px-5 py-2 -mt-2 flex justify-end items-center gap-3">
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
                  <CharStatusBar status={status} paused={paused}/>
                  <span className="text-xs text-ink/50 capitalize text-right">
                    {status === 'in_progress' && <span className="text-magenta font-medium">{paused ? 'Paused' : 'Generating…'}</span>}
                    {status === 'done'        && <span className="text-emerald-700 font-medium">Done</span>}
                    {status === 'queued'      && 'Queued'}
                    {status === 'skipped'     && '—'}
                    {status === 'failed'      && <span className="text-rose-600 font-medium">Failed</span>}
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

function CharStatusBar({ status, paused }: { status: string; paused: boolean }) {
  if (status === 'done')        return <div className="h-1 rounded-full bg-emerald-400"/>;
  if (status === 'skipped')     return <div className="h-1 rounded-full bg-ink/[0.04]"/>;
  if (status === 'queued')      return <div className="h-1 rounded-full bg-ink/[0.08]"/>;
  if (status === 'failed')      return <div className="h-1 rounded-full bg-rose-400"/>;
  if (status === 'in_progress') return (
    <div className="relative h-1 rounded-full bg-ink/[0.06] overflow-hidden">
      <div className={`absolute inset-y-0 left-0 w-3/5 bg-gradient-progress rounded-full ${paused ? '' : 'pulse-bar'}`}>
        {!paused && <div className="absolute inset-0 stripe-travel"/>}
      </div>
    </div>
  );
  return null;
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
