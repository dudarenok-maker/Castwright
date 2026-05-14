import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconRefresh, IconSpinner } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { api, AnalysisError, type AnalysisLiveInfo, type AnalysisLiveChapter, type AnalysisHeartbeat } from '../lib/api';
import { ANALYSIS_PHASES } from '../data/analysis-phases';
import { MODEL_OPTIONS } from '../lib/models';
import type { AnalyseResponse } from '../lib/types';
import { useAppDispatch } from '../store';
import { uiActions } from '../store/ui-slice';

/* Heuristic estimate matched to the server's analysis pacing (server/src/
   routes/analysis.ts: STAGE1_BASELINE_RATE × STAGE2_STRETCH ≈ 4 ms per input
   character on gemini-2.5-flash). Average word ≈ 5.5 characters → ~22 ms
   per word total. */
const MS_PER_WORD = 22;

/* Two log presentations:
   - active phase: scrollable container capped at ACTIVE_PHASE_LOG_MAX_H so
     a long stage-2 loop doesn't push the rest of the page off-screen.
     Auto-scrolls to the bottom on every new line; user can scroll up to
     review history without losing the auto-pin until they scroll back down.
   - completed phases: keep only the last N lines as a static summary. No
     scroll. The "earlier lines" indicator is gone — it confused readers
     into thinking the log had stalled. */
const COMPLETED_PHASE_TAIL = 6;
const ACTIVE_PHASE_LOG_MAX_H = 'max-h-48'; // ≈ 12rem; tuned to fit ~12 lines

/* Live "what's running right now" indicator on the active phase header.
   Server sends a `live` payload every 500ms with every chapter currently
   in flight; we render one row per chapter so a slow chapter doesn't
   visually hide the chapters progressing alongside it. The displayed
   elapsed is advanced locally between server ticks so the seconds counter
   never visibly stalls — each row re-anchors to the server's elapsedMs on
   every update. */
function LiveChapterRow({ chapter, totalChapters }: { chapter: AnalysisLiveChapter; totalChapters: number }) {
  const [displayMs, setDisplayMs] = useState(chapter.elapsedMs);
  useEffect(() => {
    const baseline = Date.now() - chapter.elapsedMs;
    setDisplayMs(Date.now() - baseline);
    const id = setInterval(() => setDisplayMs(Date.now() - baseline), 1000);
    return () => clearInterval(id);
  }, [chapter.elapsedMs, chapter.chapterIndex]);

  const overBudget = displayMs > chapter.estMs * 1.25;
  return (
    <div className={`inline-flex items-center gap-2 text-[11px] font-mono tabular-nums ${overBudget ? 'text-amber-700' : 'text-ink/60'}`}>
      <span className="font-semibold">Chapter {chapter.chapterIndex}/{totalChapters}</span>
      <span className="text-ink/30">·</span>
      <span className="truncate max-w-[220px]" title={chapter.chapterTitle}>{chapter.chapterTitle}</span>
      <span className="text-ink/30">·</span>
      <span>{humanSecondsCompact(displayMs)} of ~{humanSecondsCompact(chapter.estMs)}</span>
      {overBudget && <span className="ml-1 font-semibold">over budget</span>}
    </div>
  );
}

function LiveChapterTicker({ live }: { live: AnalysisLiveInfo }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      {live.chapters.map(ch => (
        <LiveChapterRow key={ch.chapterIndex} chapter={ch} totalChapters={live.totalChapters}/>
      ))}
    </div>
  );
}

/* Compact MM:SS / H:MM:SS used in the live ticker. Different format from
   humanSeconds (which spells out "1m 14s") because the ticker updates every
   second and a colon-formatted clock is easier to read at a glance. */
function humanSecondsCompact(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* Scrolling log for the active phase. Pins to the bottom on every new line
   so the user always sees the most recent updates. If the user scrolls up to
   read history, the pin temporarily releases — we re-pin on the next render
   once they scroll back near the bottom. The latest line is bolded + ink-
   coloured so the eye lands on it. */
function ActivePhaseLog({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  /* Track whether the user is currently near the bottom. While they are,
     new lines auto-scroll; if they scroll up to review, we leave them be. */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < 24; // tolerate small overshoot
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={`mt-3 ${ACTIVE_PHASE_LOG_MAX_H} overflow-y-auto pr-2 -mr-2`}
    >
      <ul className="space-y-1.5 text-xs font-mono text-ink/70">
        {lines.map((s, i) => (
          <li
            key={i}
            className={i === lines.length - 1 ? 'tick-up font-semibold text-ink' : ''}
          >
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Live indicator that the analyzer's LLM call is actively returning bytes.
   Displays size received, throughput, and seconds since the last chunk —
   the third value is the most reassuring during long runs because it ticks
   forward even between server heartbeats (we re-anchor on each event). */
function HeartbeatRow({ hb, receivedAt }: { hb: AnalysisHeartbeat; receivedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sinceLast = Math.max(hb.sinceLastChunkMs, now - receivedAt);
  const sinceLastSec = Math.round(sinceLast / 1000);
  const sizeKb = hb.receivedBytes / 1024;
  const sizeText = sizeKb >= 10 ? `${Math.round(sizeKb)} KB` : `${sizeKb.toFixed(1)} KB`;
  const stalled = sinceLastSec > 8;
  return (
    <div className={`mt-2 inline-flex items-center gap-2 text-[11px] font-mono tabular-nums ${stalled ? 'text-amber-700' : 'text-emerald-700'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${stalled ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'}`}/>
      <span className="font-semibold">{stalled ? 'Stalled' : 'Receiving response'}</span>
      <span className="text-ink/30">·</span>
      <span>{sizeText}</span>
      {hb.charsPerSec > 0 && (
        <>
          <span className="text-ink/30">·</span>
          <span>{hb.charsPerSec.toLocaleString()} chars/s</span>
        </>
      )}
      <span className="text-ink/30">·</span>
      <span>last chunk {sinceLastSec}s ago</span>
    </div>
  );
}

function ConnPill({ state, sinceLastSec }: { state: ConnState; sinceLastSec: number | null }) {
  const meta = (() => {
    if (state === 'idle')       return { label: 'Idle',                tone: 'text-ink/50',    dot: 'bg-ink/30' };
    if (state === 'connecting') return { label: 'Connecting to server…', tone: 'text-amber-700', dot: 'bg-amber-500 animate-pulse' };
    if (state === 'streaming')  return { label: sinceLastSec != null && sinceLastSec > 8
                                            ? `Streaming · last update ${sinceLastSec}s ago`
                                            : 'Streaming live', tone: 'text-emerald-700', dot: 'bg-emerald-500 animate-pulse' };
    if (state === 'done')       return { label: 'Done',                  tone: 'text-emerald-700', dot: 'bg-emerald-500' };
    return { label: 'Stopped',  tone: 'text-red-700',     dot: 'bg-red-500' };
  })();
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/70 border border-ink/10 ${meta.tone}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`}/>
      <span className="font-medium tabular-nums">{meta.label}</span>
    </span>
  );
}

function describeSize(wordCount?: number): string {
  if (!wordCount || wordCount <= 0) return 'This usually takes 60 to 90 seconds.';
  const estMs = wordCount * MS_PER_WORD;
  const words = wordCount.toLocaleString();
  if (estMs < 90_000) return `${words} words — usually under 90 seconds.`;
  const mins = Math.max(2, Math.round(estMs / 60_000));
  if (mins <= 5)   return `${words} words — usually ~${mins} minutes.`;
  if (mins <= 15)  return `${words} words — usually ~${mins} minutes. Grab a coffee.`;
  return `${words} words — usually ~${mins} minutes. This is a long one.`;
}

interface Props {
  manuscriptId: string | null | undefined;
  title?: string | null;
  wordCount?: number;
  model?: string;
  onComplete: (payload: AnalyseResponse) => void;
}

type ConnState = 'idle' | 'connecting' | 'streaming' | 'error' | 'done';

export function AnalysingView({ manuscriptId, title, wordCount, model, onComplete }: Props) {
  const dispatch = useAppDispatch();
  const [phase, setPhase] = useState(0);
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [logs, setLogs] = useState<Record<number, string[]>>({});
  const [error, setError] = useState<{ message: string; code: string; detail?: string } | null>(null);
  const [retry, setRetry] = useState<{ nonce: number; fresh: boolean }>({ nonce: 0, fresh: false });
  const [conn, setConn] = useState<ConnState>('idle');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [live, setLive] = useState<AnalysisLiveInfo | null>(null);
  /* Per-phase live "Receiving response" indicator. Cleared whenever the
     active phase changes so a stale heartbeat never bleeds into the next
     phase's UI. Heartbeat events arrive throttled (~one per 2s); the local
     re-render every second between events advances the "last chunk Ns ago"
     counter so the indicator never visibly stalls. */
  const [heartbeatByPhase, setHeartbeatByPhase] = useState<Record<number, { hb: AnalysisHeartbeat; receivedAt: number }>>({});
  const [, setNow] = useState(Date.now());
  const completedRef = useRef(false);

  useEffect(() => {
    if (!manuscriptId) return;     // nothing to analyse — UI shows a CTA below
    let cancelled = false;
    setPhase(0);
    setPhaseProgress(0);
    setLogs({});
    setError(null);
    setConn('connecting');
    setLastEventAt(null);
    setLive(null);
    setHeartbeatByPhase({});
    const markEvent = () => setLastEventAt(Date.now());
    (async () => {
      try {
        const payload = await api.analyseManuscript(manuscriptId, {
          model,
          fresh: retry.fresh || undefined,
          onPhase: ({ phaseId, progress, live }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setPhase(prev => {
              /* Drop heartbeat for the previous phase the moment the active
                 phase advances — completed phases shouldn't keep a "still
                 receiving" hint. */
              if (prev !== phaseId) {
                setHeartbeatByPhase(hbs => {
                  if (!(prev in hbs)) return hbs;
                  const { [prev]: _drop, ...rest } = hbs;
                  return rest;
                });
              }
              return phaseId;
            });
            setPhaseProgress(progress);
            /* Carry the realtime "what's running right now" payload so the
               active phase header can render a ticking elapsed indicator.
               Cleared as soon as the active phase changes (below). */
            if (live) setLive(live);
          },
          onLog: ({ phaseId, message }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setLogs(prev => ({ ...prev, [phaseId]: [...(prev[phaseId] ?? []), message] }));
          },
          onHeartbeat: (hb) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setHeartbeatByPhase(prev => ({ ...prev, [hb.phaseId]: { hb, receivedAt: Date.now() } }));
          },
        });
        if (cancelled || completedRef.current) return;
        completedRef.current = true;
        setConn('done');
        onComplete(payload);
      } catch (e) {
        if (cancelled) return;
        setConn('error');
        const code = e instanceof AnalysisError ? e.code : 'unknown';
        const detail = e instanceof AnalysisError ? e.detail : undefined;
        setError({ message: (e as Error).message || 'Analysis failed.', code, detail });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manuscriptId, retry]);

  /* Tick once a second while we're waiting on events so the "X seconds since
     last update" indicator advances even if the server is quiet. */
  useEffect(() => {
    if (conn !== 'connecting' && conn !== 'streaming') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [conn]);

  const overall = (phase + phaseProgress) / ANALYSIS_PHASES.length;
  const sinceLastSec = lastEventAt ? Math.max(0, Math.round((Date.now() - lastEventAt) / 1000)) : null;

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex items-center justify-center px-6 py-16">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-60 pointer-events-none"/>
      <div className="relative max-w-2xl w-full">
        <div className="text-center mb-10">
          <SectionLabel>Analysing</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="Reading" bold={title || 'your manuscript'}/>
          </div>
          <p className="mt-4 text-ink/70">{describeSize(wordCount)}</p>
          {manuscriptId && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
              <ConnPill state={conn} sinceLastSec={sinceLastSec}/>
              {/* Live model picker. Changing the model mid-run cancels the
                  in-flight request and restarts from the first uncached
                  chapter — completed chapters in the analysis cache survive,
                  so switching from a flaky Gemma run to Gemini 2.5 Flash
                  picks up exactly where the user is, with the new model. */}
              <label className="inline-flex items-center gap-2 text-ink/60">
                <span className="font-medium">Model</span>
                <select
                  value={model ?? MODEL_OPTIONS[0].id}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === model) return;
                    dispatch(uiActions.setSelectedModel(next));
                    /* Bump the retry nonce so the analysis useEffect re-runs
                       with the new model. fresh stays false — cached
                       chapters from the previous model are still valid
                       (the cache key is the manuscript, not the model). */
                    setRetry(r => ({ nonce: r.nonce + 1, fresh: false }));
                  }}
                  className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
                  title="Switch the analysis model. Cancels the in-flight request and resumes from the first uncached chapter."
                >
                  {MODEL_OPTIONS.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => dispatch(uiActions.goHome())}
                className="text-ink/60 hover:text-ink underline-offset-2 hover:underline"
              >
                Back to library
              </button>
            </div>
          )}
          {!manuscriptId && (
            <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-amber-900">No manuscript loaded</p>
              <p className="mt-1 text-sm text-amber-800">
                The browser tab lost its in-progress upload (page refresh, a URL pasted directly,
                or an opened book whose <code>state.json</code> is missing a <code>manuscriptId</code>).
                Re-open the book from the library to resume, or import a fresh manuscript.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => dispatch(uiActions.startNewBook())}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink/90"
                >
                  Start a new upload
                </button>
                <button
                  onClick={() => dispatch(uiActions.goHome())}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-semibold text-ink/80 hover:bg-ink/[0.04]"
                >
                  Back to library
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-red-900">
                {error.code === 'daily_quota' ? 'Daily free-tier quota exhausted' : 'Analysis failed'}
              </p>
              <p className="mt-1 text-sm text-red-800 break-words">{error.message}</p>
              {error.detail && (
                <details className="mt-2 text-xs text-red-800/90">
                  <summary className="cursor-pointer font-medium hover:text-red-900">
                    Show upstream detail
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-red-100/60 p-3 text-[11px] font-mono whitespace-pre-wrap break-words">
                    {error.detail}
                  </pre>
                </details>
              )}
              {error.code === 'daily_quota' && (
                <p className="mt-2 text-xs text-red-800/90">
                  Each Gemini model has its own 20-requests-per-day free-tier bucket. Try switching
                  to <span className="font-semibold">Gemini 3.1 Flash Lite</span> below, or wait for
                  your quota to reset (Pacific midnight). Cached chapters are preserved either way.
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 text-xs text-red-900/80">
                  <span className="font-medium">Model</span>
                  <select
                    value={model ?? MODEL_OPTIONS[0].id}
                    onChange={(e) => dispatch(uiActions.setSelectedModel(e.target.value))}
                    className="px-3 py-1.5 rounded-full border border-red-300/60 bg-white text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-red-400/40"
                  >
                    {MODEL_OPTIONS.map(m => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() => setRetry(r => ({ nonce: r.nonce + 1, fresh: false }))}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink/90"
                >
                  <IconRefresh className="w-3.5 h-3.5"/> Try again
                </button>
                <button
                  onClick={() => {
                    if (confirm('Discard all cached progress for this manuscript and start over?')) {
                      setRetry(r => ({ nonce: r.nonce + 1, fresh: true }));
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-red-300/60 bg-white text-red-700 text-xs font-semibold hover:bg-red-50"
                >
                  Start fresh
                </button>
              </div>
              <p className="mt-2 text-xs text-red-700/70">
                Try again resumes from the first uncached chapter. Start fresh discards all cached progress and re-runs stage 1.
              </p>
            </div>
          )}
        </div>

        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-ink/60 mb-2">
            <span>Overall</span><span className="tabular-nums font-semibold text-ink">{Math.round(overall * 100)}%</span>
          </div>
          <div className="relative h-2 rounded-full bg-ink/[0.06] overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-gradient-progress rounded-full" style={{ width: `${overall * 100}%` }}>
              <div className="absolute inset-0 stripe-travel"/>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card divide-y divide-ink/5">
          {ANALYSIS_PHASES.map(p => {
            const isActive = phase === p.id;
            const isDone   = phase > p.id;
            const phaseLogs = logs[p.id] ?? [];
            return (
              <div key={p.id} className="px-6 py-4 flex items-start gap-4">
                <div className="mt-1 shrink-0">
                  {isDone   && <span className="w-7 h-7 rounded-full bg-emerald-100 grid place-items-center"><IconCheck className="w-4 h-4 text-emerald-700"/></span>}
                  {isActive && <span className="w-7 h-7 rounded-full bg-peach/20 grid place-items-center"><IconSpinner className="w-4 h-4 text-magenta"/></span>}
                  {!isDone && !isActive && <span className="w-7 h-7 rounded-full border border-ink/15"/>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`font-semibold ${isDone || isActive ? 'text-ink' : 'text-ink/40'}`}>{p.label}</p>
                  <p className={`text-sm mt-0.5 ${isDone || isActive ? 'text-ink/60' : 'text-ink/30'}`}>{p.detail}</p>
                  {isActive && (
                    <>
                      <div className="mt-3 h-1 rounded-full bg-ink/[0.06] overflow-hidden">
                        <div className="h-full bg-gradient-progress rounded-full" style={{ width: `${phaseProgress * 100}%` }}/>
                      </div>
                      {heartbeatByPhase[p.id] && (
                        <HeartbeatRow
                          hb={heartbeatByPhase[p.id].hb}
                          receivedAt={heartbeatByPhase[p.id].receivedAt}
                        />
                      )}
                      {live && live.chapters.length > 0 && (
                        <LiveChapterTicker live={live}/>
                      )}
                    </>
                  )}
                  {phaseLogs.length > 0 && (
                    isActive
                      ? <ActivePhaseLog lines={phaseLogs}/>
                      : (
                        <ul className="mt-3 space-y-1.5 text-xs font-mono text-ink/50">
                          {phaseLogs.slice(-COMPLETED_PHASE_TAIL).map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
