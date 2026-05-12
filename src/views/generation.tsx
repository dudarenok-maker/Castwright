import { useEffect, useRef, useState } from 'react';
import {
  IconPlay, IconPause, IconCheck, IconSpinner, IconWarning,
  IconArrowDn, IconRefresh,
} from '../lib/icons';
import {
  SectionLabel, MixedHeading, PrimaryButton, Pill, ColorDot,
} from '../components/primitives';
import { useAppDispatch } from '../store';
import { chaptersActions } from '../store/chapters-slice';
import { api } from '../lib/api';
import type { Chapter, Character, CharColor, GenerationTick, TtsModelKey } from '../lib/types';

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
}

export function GenerationView({ chapters, characters, paused, title, bookId, modelKey, setPaused, onRegenerate, onRegenerateCharacterInChapter }: Props) {
  const dispatch = useAppDispatch();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({ 3: true });

  const chaptersRef = useRef(chapters);
  useEffect(() => { chaptersRef.current = chapters; }, [chapters]);
  useEffect(() => {
    if (paused) return;
    const cancel = api.streamGeneration({
      bookId,
      modelKey,
      getChapters: () => chaptersRef.current,
      onTick: (ev: GenerationTick) => dispatch(chaptersActions.applyGenerationTick(ev)),
    });
    return cancel;
  }, [paused, dispatch, bookId, modelKey]);

  const completed = chapters.filter(c => c.state === 'done').length;
  const failed    = chapters.filter(c => c.state === 'failed').length;
  const inProgress = chapters.find(c => c.state === 'in_progress');
  const queued    = chapters.filter(c => c.state === 'queued').length;
  const totalProgress = chapters.reduce((s, c) => s + c.progress, 0) / chapters.length;
  const minutesLeft = Math.max(1, Math.round((1 - totalProgress) * 45));

  return (
    <div className="max-w-[1100px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Audiobook generation</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Generating" bold={title || 'your audiobook'} level="h1"/>
          </div>
          <p className="mt-3 text-ink/60">{completed} of {chapters.length} chapters complete · approx. {minutesLeft} min remaining</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setPaused(!paused)} className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2">
            {paused ? <><IconPlay className="w-4 h-4"/> Resume</> : <><IconPause className="w-4 h-4"/> Pause</>}
          </button>
          <PrimaryButton variant="ghost" icon={false}>View partial output</PrimaryButton>
        </div>
      </div>

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
          <Stat label="In progress" value={inProgress ? 1 : 0}/>
          <Stat label="Queued"      value={queued}/>
          <Stat label="Failed"      value={failed} danger/>
        </div>
      </div>

      <div className="space-y-3">
        {chapters.map(ch => (
          <ChapterRow key={ch.id} chapter={ch} characters={characters}
                      expanded={!!expanded[ch.id]} onToggle={() => setExpanded({ ...expanded, [ch.id]: !expanded[ch.id] })}
                      paused={paused} onRegenerate={onRegenerate}
                      onRegenerateCharacterInChapter={onRegenerateCharacterInChapter}/>
        ))}
      </div>

      <div className="mt-10 pt-6 border-t border-ink/10 flex items-center justify-between text-xs text-ink/50">
        <div className="flex items-center gap-6">
          <span>Output: 24-bit FLAC + MP3</span><span>·</span><span>Estimated runtime: 4h 38m</span><span>·</span><span>Format: m4b chaptered</span>
        </div>
        <button className="text-ink/60 font-medium hover:text-ink hover:underline">Cancel generation</button>
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
  expanded: boolean;
  onToggle: () => void;
  paused: boolean;
  onRegenerate: (ch: Chapter) => void;
  onRegenerateCharacterInChapter: (charId: string, chapterId: number) => void;
}

function ChapterRow({ chapter, characters, expanded, onToggle, paused, onRegenerate, onRegenerateCharacterInChapter }: ChapterRowProps) {
  const stateConfig = {
    done:        { tint: 'bg-emerald-50/50',  badge: <Pill color="success">Done</Pill>,                                                icon: <IconCheck   className="w-4 h-4 text-emerald-600"/> },
    in_progress: { tint: 'bg-peach/[0.06]',   badge: <Pill color="peach">{paused ? 'Paused' : 'Generating'}</Pill>,                  icon: paused ? <IconPause className="w-4 h-4 text-magenta"/> : <IconSpinner className="w-4 h-4 text-magenta"/> },
    queued:      { tint: 'bg-white',          badge: <Pill>Queued</Pill>,                                                            icon: <span className="w-4 h-4 rounded-full border border-ink/20"/> },
    failed:      { tint: 'bg-rose-50/50',     badge: <Pill color="danger">Failed</Pill>,                                             icon: <IconWarning className="w-4 h-4 text-rose-600"/> },
  }[chapter.state];

  const findChar = (id: string): Character => characters.find(c => c.id === id) || { id, name: id, role: '', color: 'narrator' };

  return (
    <div className={`rounded-3xl border border-ink/10 shadow-card overflow-hidden ${stateConfig.tint}`}>
      <button onClick={onToggle} className="w-full grid grid-cols-[40px_60px_1fr_180px_100px_120px_24px] items-center gap-4 px-5 py-4 text-left">
        <span className="grid place-items-center">{stateConfig.icon}</span>
        <span className="text-sm font-bold text-ink/50 tabular-nums">CH {String(chapter.id).padStart(2, '0')}</span>
        <span className="min-w-0">
          <span className="block font-semibold text-ink truncate">{chapter.title}</span>
          {chapter.errorReason && <span className="block text-xs text-rose-600 truncate mt-0.5">{chapter.errorReason}</span>}
        </span>
        <ChapterProgressBar progress={chapter.progress} state={chapter.state} paused={paused}/>
        <span className="text-sm tabular-nums text-ink/60 text-right">{chapter.duration}</span>
        <span>{stateConfig.badge}</span>
        <span className={`text-ink/40 transition-transform ${expanded ? 'rotate-180' : ''}`}><IconArrowDn className="w-4 h-4"/></span>
      </button>
      {(chapter.state === 'done' || chapter.state === 'failed') && (
        <div className="px-5 py-2 -mt-2 flex justify-end">
          <button onClick={(e) => { e.stopPropagation(); onRegenerate(chapter); }} className="inline-flex items-center gap-1.5 text-xs font-medium text-ink/60 hover:text-magenta transition-colors">
            <IconRefresh className="w-3.5 h-3.5"/> Regenerate this chapter
          </button>
        </div>
      )}
      {expanded && (
        <div className="px-5 pb-5 pt-1 fade-in">
          <div className="ml-[100px] pl-4 border-l border-ink/10 space-y-2">
            {Object.entries(chapter.characters).map(([cid, status]) => {
              const c = findChar(cid);
              return (
                <div key={cid} className="grid grid-cols-[20px_1fr_140px_100px_28px] items-center gap-4 py-1.5 text-sm group">
                  <ColorDot color={c.color as CharColor} size={8}/>
                  <span className="font-medium text-ink/90">{c.name}</span>
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
          {chapter.state === 'failed' && (
            <div className="mt-4 ml-[100px] flex items-center gap-3">
              <PrimaryButton variant="dark" size="sm">Retry chapter</PrimaryButton>
              <button className="text-sm font-medium text-ink/60 hover:text-ink">View error log</button>
            </div>
          )}
          {chapter.state === 'in_progress' && chapter.currentLine && (
            <div className="mt-4 ml-[100px] flex items-center gap-3 text-xs text-ink/60">
              <span>Active: <span className="font-semibold text-ink">{Object.entries(chapter.characters).find(([, s]) => s === 'in_progress')?.[0] || '—'}</span> · line {chapter.currentLine.toLocaleString()} of {chapter.totalLines?.toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChapterProgressBar({ progress, state, paused }: { progress: number; state: Chapter['state']; paused: boolean }) {
  if (state === 'queued') return <div className="h-1.5 rounded-full bg-ink/[0.06]"/>;
  if (state === 'done')   return <div className="h-1.5 rounded-full bg-emerald-200"><div className="h-full w-full rounded-full bg-emerald-500"/></div>;
  if (state === 'failed') return <div className="h-1.5 rounded-full bg-rose-100"><div className="h-full rounded-full bg-rose-500" style={{ width: `${progress * 100}%` }}/></div>;
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
