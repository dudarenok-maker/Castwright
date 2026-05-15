import { useEffect, useMemo, useRef, useState } from 'react';
import { IconCheck, IconRefresh, IconSpinner } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { api, AnalysisError, type AnalysisLiveInfo, type AnalysisLiveChapter, type AnalysisHeartbeat, type OllamaHealth } from '../lib/api';
import { ANALYSIS_PHASES } from '../data/analysis-phases';
import { MODEL_OPTIONS, MODEL_OPTION_GROUPS } from '../lib/models';
import { ModelControlPill, type ModelControlState } from '../components/ModelControlPill';
import type { AnalyseResponse, DroppedQuotesResponse } from '../lib/types';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';

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

/* Live cast preview rendered under Phase 0 — fills in chapter-by-chapter
   as cast-update events arrive. Order mirrors the running roster from the
   server (insertion order = chapter discovery order). Names truncate to
   keep wide casts on a single row at viewport widths the rest of the app
   supports; full list is always visible on the cast view once stage='confirm'. */
function LiveCastPreview() {
  const characters = useAppSelector(s => s.cast.characters);
  if (characters.length === 0) return null;
  return (
    <div className="mt-3 text-[11px] text-ink/60">
      <div className="font-semibold text-ink/80">Cast so far · {characters.length} character{characters.length === 1 ? '' : 's'}</div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
        {characters.map(c => (
          <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink/[0.04] text-ink/70">
            {c.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* Read-only ledger of evidence quotes the analyser's verifier rejected
   for not matching the source text. Pulls the latest batch from
   GET /api/books/:bookId/dropped-quotes and groups entries by
   characterName. No Restore button in Phase 1 — this view is an audit
   surface for tuning the verifier prompt; raising/lowering the
   threshold is a separate workflow. Re-fetches when the run completes
   so a fresh batch from the just-finished verify pass shows up
   without a page reload. */
function DroppedQuotesPanel({ bookId, refreshKey }: { bookId: string | null | undefined; refreshKey: number }) {
  const [file, setFile] = useState<DroppedQuotesResponse | null>(null);
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    api.getDroppedQuotes(bookId)
      .then(f => { if (!cancelled) setFile(f); })
      .catch(err => { console.warn('[analysing] dropped-quotes fetch skipped:', err.message); });
    return () => { cancelled = true; };
  }, [bookId, refreshKey]);
  const latest = file?.batches.length ? file.batches[file.batches.length - 1] : null;
  if (!latest || latest.entries.length === 0) return null;
  /* Group entries by characterName so a character with 5 fabricated
     quotes renders as one collapsible row, not five separate rows. */
  const grouped = new Map<string, typeof latest.entries>();
  for (const e of latest.entries) {
    const list = grouped.get(e.characterName);
    if (list) list.push(e);
    else grouped.set(e.characterName, [e]);
  }
  const groups = Array.from(grouped.entries());
  return (
    <details className="mt-3 text-[11px] text-ink/60">
      <summary className="cursor-pointer select-none font-semibold text-ink/80">
        Verifier dropped {latest.totalDropped} quote{latest.totalDropped === 1 ? '' : 's'} across {latest.affectedCharacters} character{latest.affectedCharacters === 1 ? '' : 's'}
        <span className="ml-2 font-normal text-ink/50">· latest batch</span>
      </summary>
      <ul className="mt-2 space-y-2">
        {groups.map(([name, entries]) => (
          <li key={name} className="rounded-2xl border border-ink/[0.08] bg-white/60 px-3 py-2">
            <div className="font-semibold text-ink/80">{name}</div>
            <ul className="mt-1 space-y-1.5">
              {entries.map((e, i) => (
                <li key={i} className="border-l-2 border-amber-300/70 pl-2">
                  <div className="font-mono text-ink/70 italic break-words">
                    "{e.quote}"
                    {e.truncated && <span className="ml-1 text-ink/40">[truncated]</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-ink/40">
                    <span>{e.reason === 'not_in_source' ? 'not in source' : 'empty after normalisation'}</span>
                    {e.note && <span>· note: {e.note}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

/* Stall thresholds vary by engine. Cloud (Gemini) streams steadily —
   any gap >8s is a real problem. qwen3.5:4b under structured-output
   constrained decoding emits in bursts and routinely sits silent for
   20-40s while the schema-constraint solver works, which is normal
   per-chapter behaviour; flagging that as "Stalled" cried wolf and
   conditioned users to ignore the badge. 60s is well past the longest
   observed legitimate gap on qwen3.5:4b chapters. */
const STALL_THRESHOLD_CLOUD_SEC = 8;
const STALL_THRESHOLD_LOCAL_SEC = 60;

/* Live indicator that the analyzer's LLM call is actively returning bytes.
   Displays size received, throughput, and seconds since the last chunk —
   the third value is the most reassuring during long runs because it ticks
   forward even between server heartbeats (we re-anchor on each event). */
function HeartbeatRow({ hb, receivedAt, stallThresholdSec }: { hb: AnalysisHeartbeat; receivedAt: number; stallThresholdSec: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sinceLast = Math.max(hb.sinceLastChunkMs, now - receivedAt);
  const sinceLastSec = Math.round(sinceLast / 1000);
  const sizeKb = hb.receivedBytes / 1024;
  const sizeText = sizeKb >= 10 ? `${Math.round(sizeKb)} KB` : `${sizeKb.toFixed(1)} KB`;
  const stalled = sinceLastSec > stallThresholdSec;
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

/* Refined-ETA caption that swaps in for describeSize once the server has
   observed at least one chapter's wall-clock rate. The static string is
   Gemini-calibrated (22ms/word) and overshoots local Ollama by 3-5×, so
   the moment we have a real sample we should show it. */
function describeRemaining(remainingMs: number, wordCount?: number): string {
  const words = wordCount && wordCount > 0 ? `${wordCount.toLocaleString()} words — ` : '';
  if (remainingMs < 60_000) {
    const secs = Math.max(5, Math.round(remainingMs / 1000));
    return `${words}~${secs} seconds remaining at the current pace.`;
  }
  const mins = Math.max(1, Math.round(remainingMs / 60_000));
  if (mins <= 5)  return `${words}~${mins} minute${mins === 1 ? '' : 's'} remaining at the current pace.`;
  if (mins <= 15) return `${words}~${mins} minutes remaining at the current pace. Grab a coffee.`;
  return `${words}~${mins} minutes remaining at the current pace. This is a long one.`;
}

interface Props {
  manuscriptId: string | null | undefined;
  bookId?: string | null;
  title?: string | null;
  wordCount?: number;
  model?: string;
  onComplete: (payload: AnalyseResponse) => void;
}

type ConnState = 'idle' | 'connecting' | 'streaming' | 'error' | 'done';

export function AnalysingView({ manuscriptId, bookId, title, wordCount, model, onComplete }: Props) {
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
  /* Server-refined total-remaining-ms. Null until the first chapter
     completes — then the heading swaps from the static describeSize
     string (Gemini-calibrated 22ms/word) to a value that reflects the
     model the user actually picked. */
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [, setNow] = useState(Date.now());
  const completedRef = useRef(false);
  /* The active analysis fetch's AbortController. Lifted out of the
     analysis effect so the Pause button (rendered in the header below)
     can abort it imperatively without waiting for the effect's normal
     deps-driven cleanup path. Assigned at the top of each effect run;
     cleared by the cleanup. */
  const analysisControllerRef = useRef<AbortController | null>(null);
  /* Tracks whether analysis has been started at least once in this
     mount. Used to pick the "Start" vs "Resume" label on the permanent
     button — after a pause the cache holds completed chapters, so
     "Resume" is the truthful word. */
  const hasStartedOnceRef = useRef(false);
  /* Per-chapter cast-detection failures that survive across reload. Seeded
     from /api/books/:bookId/state on mount; appended to from the SSE's
     chapter-failed event; cleared per id when a Retry succeeds. */
  const [failedChapters, setFailedChapters] = useState<Array<{ chapterId: number; message: string }>>([]);
  const [retryingChapterId, setRetryingChapterId] = useState<number | null>(null);
  /* Bump to refetch the dropped-quotes ledger. Goes up when the server
     finishes a verify pass (run completes, hits cast_incomplete, or a
     subset retry resolves) so the new batch shows up without a
     page reload. Initial value 0 means the panel fetches once on
     mount. */
  const [droppedQuotesRefreshKey, setDroppedQuotesRefreshKey] = useState(0);
  /* True after the server emits `kind: 'error', code: 'cast_incomplete'`
     — the run finished Phase 0a but at least one chapter is still in
     failedChapterIds, so Phase 1 hasn't started. The view treats this
     as "paused awaiting retry" rather than a fatal error: no red error
     banner, retry buttons in the panel are active, and once
     failedChapters drains to 0 we auto-resume the main run so Phase 1+
     start without the user having to re-click "Try again". */
  const [castIncomplete, setCastIncomplete] = useState(false);

  /* Explicit "Start analysis" gate. The previous auto-fire path was hard
     to reason about — auto-load fires, probe re-runs, isAnalyzerReady
     flips, analysis useEffect re-runs… and at any link in the chain a
     leaked fetch or a stale render could pile up against Ollama. With
     an explicit click the user controls when the analysis kicks off,
     and the server log shows exactly one [analysis] entry per click. */
  const [analysisStarted, setAnalysisStarted] = useState(false);

  /* Analyzer readiness gate — declared up here (above the analysis
     useEffect) because the analysis effect depends on it. The full
     analyzer Load/Stop machinery lives further down; this slice pulls
     just the bits the analysis effect needs to decide whether it's
     safe to fire the SSE. */
  const selectedModel = useMemo(() => {
    const id = model ?? MODEL_OPTIONS[0].id;
    return MODEL_OPTIONS.find(m => m.id === id);
  }, [model]);
  const isLocalAnalyzer = selectedModel?.engine === 'local';
  const [ollamaHealth, setOllamaHealth] = useState<OllamaHealth | null>(null);
  const [pendingAnalyzerPill, setPendingAnalyzerPill] = useState<ModelControlState | null>(null);
  const [analyzerProbeKey, setAnalyzerProbeKey] = useState(0);
  const [analyzerEvictionNotice, setAnalyzerEvictionNotice] = useState<string | null>(null);
  const isAnalyzerReady = !isLocalAnalyzer || (
    ollamaHealth?.status === 'reachable' && ollamaHealth?.modelResident === true
  );

  useEffect(() => {
    if (!manuscriptId) return;     // nothing to analyse — UI shows a CTA below
    /* Explicit user click — see analysisStarted comment above. */
    if (!analysisStarted) {
      setConn('idle');
      return;
    }
    /* Hold off until the analyzer is actually able to take a request.
       For local engines this means Ollama has the configured model
       resident in VRAM (see isAnalyzerReady above). Firing the SSE
       against a cold Ollama caused the very pile-up the user reported:
       the first chat call kicked off a model load, every retry in the
       meantime queued another chat call, and Ollama returned errors
       for each one as the load swapped its state. Gemini is gated as
       "always ready" so the cloud path is unaffected. */
    if (!isAnalyzerReady) {
      setConn('idle');
      return;
    }
    let cancelled = false;
    /* AbortController tied to the effect's cleanup. Without this, every
       re-run of this effect (Try again / model switch / "Start fresh")
       leaked the previous fetch's TCP connection — the cleanup only set
       `cancelled = true` to drop incoming results, but the underlying
       request kept the server's analysis loop busy. At concurrency=1
       the server's log filled with `[analysis] manuscript=...` ↔
       `[analysis] aborted (client disconnected)` pairs as the browser
       eventually pruned the orphaned fetches, breaking every retry. */
    const controller = new AbortController();
    analysisControllerRef.current = controller;
    hasStartedOnceRef.current = true;
    setPhase(0);
    setPhaseProgress(0);
    setLogs({});
    setError(null);
    setConn('connecting');
    setLastEventAt(null);
    setLive(null);
    setHeartbeatByPhase({});
    setRemainingMs(null);
    /* Clear castIncomplete on every re-entry so an old "paused" state
       doesn't linger when the user clicks Try again / Start fresh /
       model switch. If the server still has unresolved failures this
       run will re-set it via the cast_incomplete catch below. */
    setCastIncomplete(false);
    const markEvent = () => setLastEventAt(Date.now());
    (async () => {
      try {
        const payload = await api.analyseManuscript(manuscriptId, {
          signal: controller.signal,
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
          onEta: ({ remainingMs: ms }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setRemainingMs(ms);
          },
          onCastUpdate: ({ characters }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            /* Merge into the cast slice so the cast view (and Phase 0
               live preview below) reflect the chapter-by-chapter roster
               as it grows. Replay-safe — late-arriving snapshots upsert
               by id, preserving locked voices on existing entries. */
            dispatch(castActions.mergeCharacters(characters));
          },
          onChapterFailed: ({ chapterId, message }) => {
            if (cancelled) return;
            markEvent();
            /* Upsert by chapterId so a retry of the same chapter (which
               will fail again, replaying chapter-failed) doesn't double
               the row. */
            setFailedChapters(prev => {
              const filtered = prev.filter(f => f.chapterId !== chapterId);
              return [...filtered, { chapterId, message }];
            });
          },
          onChapterResolved: ({ chapterId }) => {
            if (cancelled) return;
            markEvent();
            /* The main route just succeeded Phase 0a for a chapter that
               had been in failedChapterIds. Drop the panel row so the
               user doesn't click Retry on something the server has
               already fixed (pre-fix that click kicked a duplicate
               subset run and raced the main route's writes). */
            setFailedChapters(prev => prev.filter(f => f.chapterId !== chapterId));
          },
        });
        if (cancelled || completedRef.current) return;
        completedRef.current = true;
        setConn('done');
        setDroppedQuotesRefreshKey(k => k + 1);
        onComplete(payload);
      } catch (e) {
        if (cancelled) return;
        /* AbortError = the effect cleanup tore the fetch down (the user
           re-tried / switched models / unmounted). Server emits a
           `kind: 'error', code: 'aborted'` event for the same reason —
           either way it's a benign disconnect, not a failure to surface
           in the UI. Falling through would flash "Analysis failed:
           Analysis aborted" right before the new attempt renders. */
        if ((e as Error)?.name === 'AbortError') return;
        if (e instanceof AnalysisError && e.code === 'aborted') return;
        /* cast_incomplete is the server's "Phase 0 done but at least one
           chapter still needs retry" signal. Not a failure — the user
           sees the failed-chapter panel and can retry below. The
           auto-resume effect picks up once every row resolves. */
        if (e instanceof AnalysisError && e.code === 'cast_incomplete') {
          setConn('idle');
          setCastIncomplete(true);
          setDroppedQuotesRefreshKey(k => k + 1);
          return;
        }
        setConn('error');
        const code = e instanceof AnalysisError ? e.code : 'unknown';
        const detail = e instanceof AnalysisError ? e.detail : undefined;
        setError({ message: (e as Error).message || 'Analysis failed.', code, detail });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (analysisControllerRef.current === controller) {
        analysisControllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manuscriptId, retry, isAnalyzerReady, analysisStarted]);

  /* Tick once a second while we're waiting on events so the "X seconds since
     last update" indicator advances even if the server is quiet. */
  useEffect(() => {
    if (conn !== 'connecting' && conn !== 'streaming') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [conn]);

  /* Per-chapter retry hydration. The analysis cache persists
     failedChapterIds (see server/src/store/analysis-cache.ts), surfaced
     through the book-state response. On mount we read it so the failed-
     chapter rows survive page reload — without this the rows would only
     live as long as the SSE that emitted the chapter-failed event.
     Also seeds chapterTitleById from state.chapters so the rows can
     show a human title instead of a bare numeric id. */
  const [chapterTitleById, setChapterTitleById] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    api.getBookState(bookId)
      .then(res => {
        if (cancelled) return;
        const titles: Record<number, string> = {};
        for (const c of res.state.chapters) titles[c.id] = c.title;
        setChapterTitleById(titles);
        const failedIds = res.analysis?.failedChapterIds ?? [];
        if (failedIds.length === 0) return;
        setFailedChapters(prev => {
          /* Merge with whatever the SSE already pushed during this session
             so we don't clobber a fresh chapter-failed event whose
             message is more useful than the hydration placeholder. */
          const messageById = new Map(prev.map(f => [f.chapterId, f.message]));
          return failedIds.map(id => ({
            chapterId: id,
            message: messageById.get(id)
              ?? 'Analysis failed on a previous attempt. Retry to try again.',
          }));
        });
      })
      .catch(err => { console.warn('[analysing] failed-chapter hydrate skipped:', err.message); });
    return () => { cancelled = true; };
  }, [bookId]);

  /* Auto-resume the main run after the user resolves every failed
     chapter. The server's cast_incomplete gate stops the run before
     Phase 1; once failedChapters drains to 0 we re-enter
     /analysis/stream which discovers the cache is complete and
     advances. Without this the user would have to click "Try again"
     themselves after the final retry — easy to miss when the panel
     has just disappeared. */
  useEffect(() => {
    if (!castIncomplete) return;
    if (failedChapters.length > 0) return;
    if (retryingChapterId !== null) return;
    setRetry(r => ({ nonce: r.nonce + 1, fresh: false }));
  }, [castIncomplete, failedChapters.length, retryingChapterId]);

  /* Per-chapter retry handler. Hits POST /api/manuscripts/:id/analysis/
     chapters, which on success removes the chapter id from
     cache.failedChapterIds (also broadcast via chapter-resolved SSE so
     this view's row clears in real time).

     Concurrency contract — PAUSE-AND-RETRY. If the main /analysis/stream
     run is in flight when the user clicks Retry, we abort it before
     firing the subset call and re-arm it once the subset settles. The
     previous implementation let the two SSEs run in parallel; both
     routes load their own snapshot of the disk-backed analysis cache
     and write back independently, so the second-finisher's stale view
     of cache.failedChapterIds / cache.chapters silently clobbered the
     first's progress. The symptom the user saw: after a successful
     retry, reload restored the failed rows and showed previously-
     attributed chapters as still-not-parsed. Serialising the two runs
     on the client side is the smallest fix that closes the race
     without forcing the user to Pause first. */
  const handleRetryChapter = (chapterId: number) => {
    if (!manuscriptId) return;
    if (retryingChapterId !== null) return;
    setRetryingChapterId(chapterId);
    const markEvent = () => setLastEventAt(Date.now());
    /* Snapshot whether the main run is in flight RIGHT NOW. If yes,
       abort it before firing subset (avoids the cache-write race) and
       remember to resume it after subset settles.
       Both conditions matter: analysisControllerRef.current is set
       while the effect's controller is live, BUT the effect cleanup
       only nulls it when deps change — so after a cast_incomplete
       catch the ref can linger as a zombie even though no fetch is
       streaming. Gate on conn too so we only pause real in-flight
       runs and leave the cast_incomplete auto-resume effect to
       handle that path on its own (it kicks once every failedChapter
       row clears). */
    const pausedMainForRetry =
      analysisControllerRef.current !== null &&
      (conn === 'streaming' || conn === 'connecting');
    if (pausedMainForRetry) {
      analysisControllerRef.current?.abort();
      setAnalysisStarted(false);
    }
    /* Retry now owns the conn/phase indicators — main is either already
       idle or just got paused. */
    setConn('connecting');
    /* Track whether the server re-emitted chapter-failed for THIS id
       during the retry. We use this instead of relying on .then() vs
       .catch() because the subset route may end without a `result`
       event when other chapters still need retry (Phase 1 won't run
       for a partial roster — see the subset-route gate in
       server/src/routes/analysis.ts). In that case api.ts throws "no
       result" and .catch fires even though our retried chapter
       succeeded. The retryReFailed flag lets us correctly drop the
       row on success regardless of which promise branch we land in. */
    let retryReFailed = false;
    api.runAnalysisForChapters(manuscriptId, [chapterId], {
      model,
      onPhase: ({ phaseId, progress, live }) => {
        markEvent();
        setConn('streaming');
        setPhase(phaseId); setPhaseProgress(progress);
        if (live) setLive(live);
      },
      onLog: ({ phaseId, message }) => {
        markEvent();
        setConn('streaming');
        setLogs(prev => ({ ...prev, [phaseId]: [...(prev[phaseId] ?? []), message] }));
      },
      onHeartbeat: (hb) => {
        markEvent();
        setConn('streaming');
        setHeartbeatByPhase(prev => ({ ...prev, [hb.phaseId]: { hb, receivedAt: Date.now() } }));
      },
      onCastUpdate: ({ characters }) => {
        markEvent();
        dispatch(castActions.mergeCharacters(characters));
      },
      onChapterFailed: ({ chapterId: failedId, message }) => {
        markEvent();
        if (failedId === chapterId) retryReFailed = true;
        setFailedChapters(prev => {
          const filtered = prev.filter(f => f.chapterId !== failedId);
          return [...filtered, { chapterId: failedId, message }];
        });
      },
      onChapterResolved: ({ chapterId: resolvedId }) => {
        markEvent();
        setFailedChapters(prev => prev.filter(f => f.chapterId !== resolvedId));
      },
    })
      .then(() => {
        if (!retryReFailed) {
          setFailedChapters(prev => prev.filter(f => f.chapterId !== chapterId));
        }
        setConn('idle');
      })
      .catch(err => {
        /* The subset route ends without a `result` event when other
           chapters still need retry (Phase 1 gate). api.ts throws
           "no result" in that case — not a real failure, drop the
           row if this chapter itself succeeded. */
        if (!retryReFailed) {
          setFailedChapters(prev => prev.filter(f => f.chapterId !== chapterId));
        } else {
          console.warn('[analysing] retry failed:', err);
        }
        setConn('idle');
      })
      .finally(() => {
        setRetryingChapterId(null);
        setDroppedQuotesRefreshKey(k => k + 1);
        /* Resume the main run if Retry paused it. The analysis effect
           is keyed off (analysisStarted, retry.nonce, …) so we flip
           analysisStarted back on and bump the nonce to re-enter — the
           same idiom the manual Resume button uses below. The server
           skips already-cached chapters, so resume picks up exactly
           where the pause left off (plus the freshly-retried chapter,
           which is now cached too). */
        if (pausedMainForRetry) {
          setAnalysisStarted(true);
          setRetry(r => ({ nonce: r.nonce + 1, fresh: false }));
        }
      });
  };

  const overall = (phase + phaseProgress) / ANALYSIS_PHASES.length;
  const sinceLastSec = lastEventAt ? Math.max(0, Math.round((Date.now() - lastEventAt) / 1000)) : null;

  /* Analyzer Load/Stop control. Only meaningful when the selected analyzer
     is a local Ollama model — Gemini lives in the cloud and has no local
     lifecycle to manage. The state hooks for this section (selectedModel,
     ollamaHealth, isAnalyzerReady, …) are declared higher up so the
     analysis useEffect can gate on them. */

  useEffect(() => {
    if (!isLocalAnalyzer) {
      setOllamaHealth(null);
      return;
    }
    let cancelled = false;
    const probe = () => {
      api.getOllamaHealth()
        .then(h => {
          if (cancelled) return;
          setOllamaHealth(h);
          setPendingAnalyzerPill(null);
        })
        .catch(() => {
          if (cancelled) return;
          setOllamaHealth({ status: 'unreachable', url: '', error: 'Probe failed.' });
          setPendingAnalyzerPill(null);
        });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isLocalAnalyzer, analyzerProbeKey]);

  /* Pill on this screen shows only the coarse state ("Streaming live") —
     HeartbeatRow below already renders the per-chunk bytes/throughput, so
     duplicating numbers in the header is just noise.
     The pill reflects the *model* lifecycle, not the SSE-fetch lifecycle —
     conflating the two used to surface as "Loading analyzer…" sitting
     stuck on screen while Ollama's /api/ps already shows the model 100%
     resident, because conn stays 'connecting' until the first phase event
     lands (which can be a minute on a long book's stage 0a). The probe is
     the source of truth for what's in VRAM; the analysis state only fills
     in the streaming detail. */
  const analyzerPillState: ModelControlState = (() => {
    if (pendingAnalyzerPill) return pendingAnalyzerPill;
    /* Daemon-level outage wins everything else — the model can't be in a
       useful state if Ollama itself isn't answering. */
    if (ollamaHealth?.status === 'unreachable') return 'unreachable';
    /* Active SSE means the analysis is mid-chunk against the model, so the
       pill should reflect "in use" regardless of probe staleness. */
    if (conn === 'streaming') return 'streaming';
    /* Resident-in-VRAM (not just "pulled") — the model has to be loaded
       AND at the analyzer's num_ctx for the next chat call to skip the
       reload. modelResident comes from Ollama's /api/ps. */
    if (ollamaHealth?.modelResident) return 'ready';
    /* Model not resident yet AND analysis is reaching out — the very first
       chat call is implicitly warming the model, so surface as 'loading'
       so the user has visible feedback during the cold-load tax. */
    if (conn === 'connecting') return 'loading';
    return 'idle';
  })();

  const handleLoadAnalyzer = async () => {
    setPendingAnalyzerPill('loading');
    setAnalyzerEvictionNotice(null);
    /* Auto-evict the TTS sidecar before warming the analyzer — they fight
       for the same VRAM. Only surface the banner when the unload actually
       freed something so we don't lie about state. */
    let sidecarHadModel = false;
    try {
      const sc = await api.getSidecarHealth();
      sidecarHadModel = sc.status === 'reachable' && sc.modelLoaded === true;
    } catch {}
    try {
      await api.unloadSidecar();
      if (sidecarHadModel) setAnalyzerEvictionNotice('TTS unloaded to free VRAM for the analyzer.');
    } catch {}
    try {
      await api.loadAnalyzer();
    } catch {}
    setAnalyzerProbeKey(k => k + 1);
  };

  const handleStopAnalyzer = async () => {
    setPendingAnalyzerPill('idle');
    setAnalyzerEvictionNotice(null);
    try {
      await api.unloadAnalyzer();
    } catch {}
    setAnalyzerProbeKey(k => k + 1);
  };

  /* Auto-warm the analyzer on arrival when:
       1. there's a manuscript to analyse (skip pre-import screens),
       2. the selected engine is local,
       3. we've probed Ollama and the configured model is NOT resident,
       4. no Load is already in flight (avoid double-fire on re-render).
     The analysis useEffect above is gated on isAnalyzerReady, so the run
     starts the moment Ollama confirms the model is resident — no extra
     click required. Without this, the user lands on Analysing, sees
     "Loading analyzer…" do nothing (the analysis won't fire because of
     the gate), and has to manually click Load. */
  const autoLoadFiredRef = useRef(false);
  useEffect(() => {
    if (!manuscriptId) return;
    if (!isLocalAnalyzer) return;
    if (!ollamaHealth) return;                   // probe still pending
    if (ollamaHealth.status !== 'reachable') return;
    if (ollamaHealth.modelResident) return;      // already warm
    if (pendingAnalyzerPill) return;             // a Load is already in flight
    if (autoLoadFiredRef.current) return;        // one-shot per mount
    autoLoadFiredRef.current = true;
    void handleLoadAnalyzer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manuscriptId, isLocalAnalyzer, ollamaHealth, pendingAnalyzerPill]);

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex items-center justify-center px-6 py-16">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-60 pointer-events-none"/>
      <div className="relative max-w-2xl w-full">
        <div className="text-center mb-10">
          <SectionLabel>Analysing</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="Reading" bold={title || 'your manuscript'}/>
          </div>
          <p className="mt-4 text-ink/70">
            {remainingMs !== null ? describeRemaining(remainingMs, wordCount) : describeSize(wordCount)}
          </p>
          {/* Analyzer Load/Stop control. Rendered even without a manuscript
              so the user can pre-warm Ollama from the Analysing screen (the
              page-refresh / deep-link case where manuscriptId is null lands
              here too — same screen, just no analysis to run yet). The
              ConnPill stays scoped to cloud analyzers + the manuscriptId
              branch where the SSE wiring lives. */}
          {isLocalAnalyzer && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
              <ModelControlPill
                kind="analyzer"
                state={analyzerPillState}
                unreachableLabel="Ollama not reachable"
                onLoad={handleLoadAnalyzer}
                onStop={handleStopAnalyzer}
              />
            </div>
          )}
          {/* Permanent analysis control. Cycles between Start / Pause /
              Resume based on whether the SSE is in flight:
              - running (conn streaming|connecting) → "Pause analysis";
                clicking aborts via the lifted controller ref + flips
                analysisStarted to false, which makes the effect cleanup
                tear the fetch down and the early-out leave conn=idle.
              - paused (started once, not running) → "Resume analysis";
                clicking flips analysisStarted back on. The server
                auto-skips chapters already in cache.chapterCast, so the
                run picks up where it left off.
              - idle (never started) → "Start analysis".
              For local analyzers the button is disabled until the model
              is resident (isAnalyzerReady) — clicking earlier would
              fire an SSE that the analysis useEffect's gate would
              immediately bounce, looking like a broken button to the
              user. For Gemini the button enables as soon as the
              manuscript is loaded (no local lifecycle to wait on). */}
          {manuscriptId && conn !== 'done' && (() => {
            const isRunning = conn === 'streaming' || conn === 'connecting';
            const label = isRunning
              ? 'Pause analysis'
              : (isAnalyzerReady
                  ? (hasStartedOnceRef.current ? 'Resume analysis' : 'Start analysis')
                  : 'Waiting for analyzer…');
            const onClick = () => {
              if (isRunning) {
                /* Imperative abort — the effect's cleanup will also call
                   .abort() when analysisStarted flips, but doing it here
                   first means the user sees the SSE tear down without
                   the brief race where conn could stay on 'streaming'
                   between click and effect-cleanup. */
                analysisControllerRef.current?.abort();
                setAnalysisStarted(false);
                setConn('idle');
              } else {
                /* Resume after a pause — bump retry.nonce so the effect
                   re-runs even if analysisStarted is already true (it
                   isn't here, but bumping is the established idiom for
                   re-entering the effect, see Try again at the error
                   panel below). */
                setAnalysisStarted(true);
                setRetry(r => ({ nonce: r.nonce + 1, fresh: false }));
              }
            };
            const disabled = !isRunning && !isAnalyzerReady;
            return (
              <div className="mt-6 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={onClick}
                  disabled={disabled}
                  className={`px-6 py-2.5 rounded-full text-sm font-semibold transition-colors ${
                    disabled
                      ? 'bg-ink/15 text-ink/40 cursor-not-allowed'
                      : 'bg-ink text-canvas hover:bg-ink/90'
                  }`}
                >
                  {label}
                </button>
                {isLocalAnalyzer && !isAnalyzerReady && !isRunning && (
                  <p className="text-[11px] text-ink/50">
                    The model needs to be resident in VRAM before analysis can run.
                    {pendingAnalyzerPill === 'loading' ? ' Loading now…' : ' Click Load above to warm it.'}
                  </p>
                )}
              </div>
            );
          })()}
          {manuscriptId && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
              {!isLocalAnalyzer && (
                <ConnPill state={conn} sinceLastSec={sinceLastSec}/>
              )}
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
                  {MODEL_OPTION_GROUPS.map(g => (
                    <optgroup key={g.engine} label={g.label}>
                      {g.models.map(m => (
                        <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
                      ))}
                    </optgroup>
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
          {analyzerEvictionNotice && (
            <p className="mt-3 inline-flex items-center gap-2 text-[11px] text-emerald-700">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"/>
              {analyzerEvictionNotice}
            </p>
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
                    {MODEL_OPTION_GROUPS.map(g => (
                      <optgroup key={g.engine} label={g.label}>
                        {g.models.map(m => (
                          <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
                        ))}
                      </optgroup>
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
                      {/* Bridging status while the SSE is open but no log
                          lines have arrived yet. On a fresh server the
                          first ~2-3s after clicking Start is spent in
                          getOrHydrateManuscript re-parsing the EPUB —
                          silence during that window made the screen look
                          frozen / the button look broken. */}
                      {p.id === 0 && phaseLogs.length === 0 && analysisStarted && conn === 'connecting' && (
                        <p className="mt-3 text-xs font-mono text-ink/50 italic">
                          Reading the manuscript (parsing chapters)…
                        </p>
                      )}
                      {heartbeatByPhase[p.id] && (
                        <HeartbeatRow
                          hb={heartbeatByPhase[p.id].hb}
                          receivedAt={heartbeatByPhase[p.id].receivedAt}
                          stallThresholdSec={isLocalAnalyzer ? STALL_THRESHOLD_LOCAL_SEC : STALL_THRESHOLD_CLOUD_SEC}
                        />
                      )}
                      {live && live.chapters.length > 0 && (
                        <LiveChapterTicker live={live}/>
                      )}
                    </>
                  )}
                  {/* Cast roster is Phase 0's outcome — keep it visible after
                      Phase 0 completes (or is skipped via a cached resume after
                      a model switch) so the user doesn't lose the detected
                      cast just because the active phase advanced. */}
                  {p.id === 0 && <LiveCastPreview/>}
                  {p.id === 0 && <DroppedQuotesPanel bookId={bookId} refreshKey={droppedQuotesRefreshKey}/>}
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

        {/* Failed-chapter retry panel. Survives reload via book-state
            hydration (see the failed-chapters effect above).
            Pause-and-retry: clicking Retry while the main run is in
            flight pauses it for the duration of the subset call and
            auto-resumes once the row resolves — see handleRetryChapter
            for why running both SSEs in parallel races the analysis-
            cache writes. Only one chapter can be in flight at a time
            (retryingChapterId tracks the active one). */}
        {failedChapters.length > 0 && (
          <div className="mt-6 rounded-3xl border border-amber-200 bg-amber-50/60 px-6 py-4">
            <p className="text-sm font-semibold text-amber-900">
              {castIncomplete
                ? (failedChapters.length === 1
                    ? 'Paused — 1 chapter still needs cast detection'
                    : `Paused — ${failedChapters.length} chapters still need cast detection`)
                : (failedChapters.length === 1
                    ? '1 chapter failed cast detection'
                    : `${failedChapters.length} chapters failed cast detection`)}
            </p>
            <p className="mt-1 text-xs text-amber-800/80">
              {castIncomplete
                ? 'Phase 1 (sentence attribution) won\'t start until every chapter has a cast. Click Retry below — the rest of the analysis resumes automatically once they all clear.'
                : 'The model produced malformed output on these chapters even after the analyzer\'s built-in retry. Retry runs them again on the currently-selected model. If the main run is in flight, Retry pauses it for the duration of the subset call and resumes automatically when the row clears.'}
            </p>
            <ul className="mt-3 space-y-2">
              {failedChapters.map(f => {
                const isRetrying = retryingChapterId === f.chapterId;
                const anotherRetryInFlight = retryingChapterId !== null && !isRetrying;
                const disabled = isRetrying || anotherRetryInFlight;
                const title = chapterTitleById[f.chapterId] ?? `Chapter ${f.chapterId}`;
                return (
                  <li key={f.chapterId} className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 border border-amber-200/70">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-ink truncate" title={title}>{title}</p>
                      <p className="mt-0.5 text-xs text-ink/60 break-words">{f.message}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRetryChapter(f.chapterId)}
                      disabled={disabled}
                      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                        disabled
                          ? 'bg-ink/10 text-ink/40 cursor-not-allowed'
                          : 'bg-ink text-canvas hover:bg-ink/90'
                      }`}
                    >
                      <IconRefresh className="w-3.5 h-3.5"/>
                      {isRetrying ? 'Retrying…' : 'Retry chapter'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
