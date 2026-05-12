import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconRefresh, IconSpinner } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { api, AnalysisError } from '../lib/api';
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

/* Last N lines per phase shown inline; older lines fold into a "…and N earlier"
   line so a long stage-2 chapter loop doesn't push the rest of the page off-
   screen. The most recent line of the active phase is bolded so the eye lands
   there. */
const PHASE_LOG_TAIL = 6;

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
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [retry, setRetry] = useState<{ nonce: number; fresh: boolean }>({ nonce: 0, fresh: false });
  const [conn, setConn] = useState<ConnState>('idle');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
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
    const markEvent = () => setLastEventAt(Date.now());
    (async () => {
      try {
        const payload = await api.analyseManuscript(manuscriptId, {
          model,
          fresh: retry.fresh || undefined,
          onPhase: ({ phaseId, progress }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setPhase(phaseId);
            setPhaseProgress(progress);
          },
          onLog: ({ phaseId, message }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setLogs(prev => ({ ...prev, [phaseId]: [...(prev[phaseId] ?? []), message] }));
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
        setError({ message: (e as Error).message || 'Analysis failed.', code });
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
            <div className="mt-4 inline-flex items-center gap-3 text-xs">
              <ConnPill state={conn} sinceLastSec={sinceLastSec}/>
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
                    <div className="mt-3 h-1 rounded-full bg-ink/[0.06] overflow-hidden">
                      <div className="h-full bg-gradient-progress rounded-full" style={{ width: `${phaseProgress * 100}%` }}/>
                    </div>
                  )}
                  {phaseLogs.length > 0 && (
                    <ul className={`mt-3 space-y-1.5 text-xs font-mono ${isActive ? 'text-ink/70' : 'text-ink/50'}`}>
                      {phaseLogs.slice(-PHASE_LOG_TAIL).map((s, i) => <li key={i} className={i === phaseLogs.length - 1 && isActive ? 'tick-up font-semibold text-ink' : ''}>{s}</li>)}
                      {phaseLogs.length > PHASE_LOG_TAIL && (
                        <li className="text-ink/30">…and {phaseLogs.length - PHASE_LOG_TAIL} earlier {phaseLogs.length - PHASE_LOG_TAIL === 1 ? 'line' : 'lines'}.</li>
                      )}
                    </ul>
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
