import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import { IconClose, IconRefresh } from '../lib/icons';
import { helpHrefForFailureCode } from '../lib/router';
import { HELP_FAILURE_ENTRIES } from '../data/help-failures';
import { SectionLabel, MixedHeading, Checkbox } from '../components/primitives';
import { MANIFESTO } from '../lib/brand';
import {
  api,
  AnalysisError,
  type AnalysisFailureFix,
  type AnalysisLiveInfo,
  type AnalysisHeartbeat,
  type OllamaHealth,
} from '../lib/api';
import { ANALYSIS_PHASES } from '../data/analysis-phases';
import { computeOverallProgress } from '../lib/analysis-progress';
import { derivePhaseState, isNotAFailureHaltCode } from '../lib/analysis-phase-state';
import {
  MODEL_OPTIONS,
  buildLocalModelOptions,
  buildModelOptionGroups,
  engineForModelId,
  localRunModelIds,
  runModelsAllResident,
} from '../lib/models';
import type { AnalysisEngine } from '../lib/model-id';
import { ModelControlPill, type ModelControlState } from '../components/ModelControlPill';
import { AnalyzerModelOverrideBadge } from '../components/analyzer-model-override-badge';
import { PhaseCard, NeedsActionLine, type ConnState } from '../components/analysing/phase-card';
import { FailureFixList } from '../components/failure-fix-list';
import { StickyAnalysisBar } from '../components/analysing/sticky-analysis-bar';
import type { AnalyseResponse } from '../lib/types';
import { useAppDispatch, useAppSelector, type RootState } from '../store';
import { uiActions, selectPhaseModelPick } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { analysisActions, selectMainAnalysisLive } from '../store/analysis-slice';
import { selectAnalyzerSplitIsActive, fetchAnalyzerModels } from '../store/account-slice';
import { bookMetaActions, selectProsodyEnabled } from '../store/book-meta-slice';
import { notificationsActions } from '../store/notifications-slice';

/* Heuristic estimate matched to the server's analysis pacing (server/src/
   routes/analysis.ts: STAGE1_BASELINE_RATE × STAGE2_STRETCH ≈ 4 ms per input
   character on gemini-2.5-flash). Average word ≈ 5.5 characters → ~22 ms
   per word total. */
const MS_PER_WORD = 22;

/** fe-29 — true when `code` maps to a known Help entry (not just 'unknown').
    Used alongside helpHrefForFailureCode to guard anchor rendering: control-flow
    codes like 'aborted'/'stage1_shrink_refused' never appear in HELP_FAILURE_ENTRIES
    and must not produce a dangling link. */
const isHelpLinkable = (code: string | undefined): boolean =>
  code != null && HELP_FAILURE_ENTRIES.some((e) => e.code === code);

/* PhaseCard, plus the per-phase helpers (HeartbeatRow / ThrottleRow /
   LiveCastPreview / SeriesPriorPill / DroppedQuotesPanel / ActivePhaseLog),
   live under `src/components/analysing/phase-card.tsx` — pulled out of this
   monolith in plan 95 so per-phase UI (model chip + swap) has one obvious
   seam to land in. */

function ConnPill({ state, sinceLastSec }: { state: ConnState; sinceLastSec: number | null }) {
  const meta = (() => {
    if (state === 'idle') return { label: 'Idle', tone: 'text-ink/50', dot: 'bg-ink/30' };
    if (state === 'connecting')
      return {
        label: 'Connecting to server…',
        tone: 'text-amber-700',
        dot: 'bg-amber-500 animate-pulse',
      };
    if (state === 'streaming')
      return {
        label:
          sinceLastSec != null && sinceLastSec > 8
            ? `Streaming · last update ${sinceLastSec}s ago`
            : 'Streaming live',
        tone: 'text-emerald-700',
        dot: 'bg-emerald-500 animate-pulse',
      };
    if (state === 'done') return { label: 'Done', tone: 'text-emerald-700', dot: 'bg-emerald-500' };
    return { label: 'Stopped', tone: 'text-red-700', dot: 'bg-red-500' };
  })();
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/70 border border-ink/10 ${meta.tone}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
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
  if (mins <= 5) return `${words} words — usually ~${mins} minutes.`;
  if (mins <= 15) return `${words} words — usually ~${mins} minutes. Grab a coffee.`;
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
  if (mins <= 5)
    return `${words}~${mins} minute${mins === 1 ? '' : 's'} remaining at the current pace.`;
  if (mins <= 15) return `${words}~${mins} minutes remaining at the current pace. Grab a coffee.`;
  return `${words}~${mins} minutes remaining at the current pace. This is a long one.`;
}

/* One row of the failed-chapter panel. `phase` is which step failed (plan 285):
   a pre-285 server sends none, and a row with no phase reads as a cast failure. */
interface FailedChapterRow {
  chapterId: number;
  message: string;
  code?: string;
  remediation?: string;
  phase?: 'cast' | 'attribution';
}

/* Panel heading and subtext for the rows' phases (#3435, spec 4).
   `stage1Ready` is the book-state fact "the roster is final": while it is false
   a cast row pauses the analysis, and an attribution row waits for the main
   resume (a Retry cannot attribute without a final roster). */
function failedPanelCopy(
  rows: FailedChapterRow[],
  stage1Ready: boolean,
): { heading: string; subtext: string; mixed: boolean } {
  const n = rows.length;
  const plural = n === 1 ? '' : 's';
  const castRows = rows.filter((r) => (r.phase ?? 'cast') === 'cast').length;
  if (castRows === n) {
    return !stage1Ready
      ? {
          heading: `Paused — ${n} chapter${n === 1 ? ' still needs' : 's still need'} cast detection.`,
          subtext:
            'Sentence attribution starts once every chapter has a cast. Retry below; the analysis resumes on its own.',
          mixed: false,
        }
      : {
          heading: `Cast detection failed on ${n} chapter${plural}.`,
          subtext: 'Retry detects the cast again and re-attributes that chapter.',
          mixed: false,
        };
  }
  if (castRows === 0) {
    return {
      heading: `Speaker attribution failed on ${n} chapter${plural}.`,
      subtext: stage1Ready
        ? 'Retry re-runs this chapter.'
        : "Cast detection hasn't finished for the whole book, so these chapters are attributed when you resume the analysis.",
      mixed: false,
    };
  }
  return {
    heading: `${n} chapters failed.`,
    subtext: 'Each row says which step failed. Retry re-runs that chapter.',
    mixed: true,
  };
}

interface Props {
  manuscriptId: string | null | undefined;
  bookId?: string | null;
  title?: string | null;
  wordCount?: number;
  model?: string;
  onComplete: (payload: AnalyseResponse) => void;
}

export function AnalysingView({
  manuscriptId,
  bookId,
  title,
  wordCount,
  model,
  onComplete,
}: Props) {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  /* `phase` is the pipeline FRONTIER — the highest phase id seen this run.
     It drives the overall %, the sticky bar, and the cross-nav snapshot. The
     per-phase progress + live payloads are kept in separate maps so two
     pipelined phases (cast + attribution, under the split analyzer) never
     clobber each other's ticker — the old single `live`/`phaseProgress` state
     was the active-card "flicker" the user filmed. */
  const [phase, setPhase] = useState(0);
  const maxPhaseRef = useRef(0);
  const [progressByPhase, setProgressByPhase] = useState<Record<number, number>>({});
  const [liveByPhase, setLiveByPhase] = useState<Record<number, AnalysisLiveInfo | null>>({});
  const [logs, setLogs] = useState<Record<number, string[]>>({});
  const [error, setError] = useState<{
    message: string;
    code: string;
    detail?: string;
    remediation?: string;
    /* #3084 F7 — structured "How to fix" list carried on the terminal error
       frame (see `AnalysisError.fixes`). Present only when the classifier can
       name something actionable; the run-level block renders it when non-empty
       and renders nothing at all otherwise. */
    fixes?: AnalysisFailureFix[];
  } | null>(null);
  const [retry, setRetry] = useState<{
    nonce: number;
    fresh: boolean;
    allowStage1Shrink?: boolean;
  }>({ nonce: 0, fresh: false });
  const [conn, setConn] = useState<ConnState>('idle');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  /* Per-phase live "Receiving response" indicator. Cleared whenever the
     active phase changes so a stale heartbeat never bleeds into the next
     phase's UI. Heartbeat events arrive throttled (~one per 2s); the local
     re-render every second between events advances the "last chunk Ns ago"
     counter so the indicator never visibly stalls. */
  const [heartbeatByPhase, setHeartbeatByPhase] = useState<
    Record<number, { hb: AnalysisHeartbeat; receivedAt: number }>
  >({});
  /* Per-phase rate-limit throttle indicator. Set on `throttle` SSE
     events from the limiter; the ThrottleRow re-renders a countdown
     until `until` passes. The next heartbeat naturally overwrites the
     visual; the state itself stays until cleared on phase change so a
     replay or component re-render doesn't lose the pill mid-wait. */
  const [throttleByPhase, setThrottleByPhase] = useState<
    Record<number, { until: number; model: string; reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after' }>
  >({});
  /* Server-resolved model id per phase — populated from the `model` field
     on `kind: 'phase'` SSE events. Lets PhaseModelChip display what the
     server ACTUALLY ran on rather than the client's Redux selection. */
  const [serverModelByPhase, setServerModelByPhase] = useState<Record<number, string>>({});
  /* Server-refined total-remaining-ms. Null until the first chapter
     completes — then the heading swaps from the static describeSize
     string (Gemini-calibrated 22ms/word) to a value that reflects the
     model the user actually picked. */
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [, setNow] = useState(Date.now());
  const completedRef = useRef(false);
  /* False once the view unmounts. A per-chapter Retry has no abort signal, so
     its promise chain can settle after the user left; it must not complete a
     view that is gone (onComplete hydrates whichever book is open now). */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
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
  /* Tracks whether the current retry attempt was refused before it
     started a job — subset_in_progress (#3202: another subset job is live)
     or main_analysis_running (#3435: the main run is live or still
     finishing). Used in the finally block to leave the restored snapshot
     alone. */
  const subsetInProgressRef = useRef(false);
  /* Same shape for a Retry that ended with a real analyzer error (#3084):
     the catch halted the run, so the finally block must leave it alone. */
  const retryHaltedRef = useRef(false);
  /* Same shape for a Retry that ended in a not-a-failure stop (`cast_incomplete`,
     `stage1_shrink_refused`, `resume_required`): the catch halted the snapshot with the server's
     message for the needs-action line, so the finally block must leave it
     alone (#3435 A8). */
  const retryNeedsActionRef = useRef(false);
  /* Per-chapter analysis failures that survive across reload. Seeded
     from /api/books/:bookId/state on mount; appended to from the SSE's
     chapter-failed event; cleared per id when a Retry succeeds. */
  const [failedChapters, setFailedChapters] = useState<FailedChapterRow[]>([]);
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
  /* #3435 (C18, C20, C-8) — the book-state GET's server facts: the roster is
     final (`stage1Ready`) and an unfinished book needs a main resume
     (`resumeRequired`). Read on mount and again after every run ending this
     view observes (`bookStateRefreshKey`). They drive copy and affordances
     only, never the auto-resume. `stage1Ready` is undefined until the GET
     answers (or from a server that predates it). */
  const [bookFacts, setBookFacts] = useState<{
    stage1Ready?: boolean;
    resumeRequired: boolean;
    castConfirmed: boolean;
  } | null>(null);
  const [bookStateRefreshKey, setBookStateRefreshKey] = useState(0);
  /* #3435 — the server refused this view's main start (a chapter retry is
     running, or the previous run is still finishing). Its message shows on the
     needs-action line; cleared on the next start. */
  const [startRefusal, setStartRefusal] = useState<string | null>(null);

  /* Stage 1 shrink-refused info — surfaced when the server refused to
     overwrite a non-trivial cached roster with a much smaller one
     (`code: 'stage1_shrink_refused'`). The view renders a banner with
     the prev/next counts and an "Accept smaller roster" button; the
     button re-fires the analysis with allowStage1Shrink:true so the
     next attempt bypasses the gate. Null when no shrink has been
     refused on this view session. */
  /* #3435 — `retryChapterId` marks a shrink a per-chapter Retry hit: its
     Accept re-runs that subset, and a main re-entry leaves its banner alone. */
  const [stage1ShrinkInfo, setStage1ShrinkInfo] = useState<{
    prev: number;
    next: number;
    retryChapterId?: number;
  } | null>(null);

  /* Explicit "Start analysis" gate. The previous auto-fire path was hard
     to reason about — auto-load fires, probe re-runs, isAnalyzerReady
     flips, analysis useEffect re-runs… and at any link in the chain a
     leaked fetch or a stale render could pile up against Ollama. With
     an explicit click the user controls when the analysis kicks off,
     and the server log shows one `[analysis] start` line per run actually
     started (plus a `request received` line for every POST, including the
     stream middleware's subscribe and any rejoin). */
  const [analysisStarted, setAnalysisStarted] = useState(false);
  /* True only while re-attaching to an already-running job after a page
     reload — set when the cold-boot rehydrate finds a `running` snapshot,
     cleared on the first replayed event (markEvent) or any explicit
     start/retry. Drives PhaseCard's "Reconnecting…" bridge so the elapsed
     ticker never reads as a blank/lost during the sub-second resume window
     before the SSE replay lands (issue #865). */
  const [resuming, setResuming] = useState(false);

  /* Marketing capture (VITE_DEMO_CAPTURE): auto-start so a deep-link to the
     analysing screen poses a live run. The analyzer is Gemini in mock mode
     (isAnalyzerReady === true), and the mock analyse stream emits one posed
     frame then hangs (src/lib/api.ts), so the screen freezes mid-analysis
     with phase progress + live cast instead of the idle Start state. */
  useEffect(() => {
    if (import.meta.env.VITE_DEMO_CAPTURE === '1') setAnalysisStarted(true);
  }, []);

  /* Cold-boot rehydration of the view's local "have we started?" state
     from the cross-navigation analysis slice. Without this, a browser
     reload during an in-flight run lands the user on Analysing with
     the top-bar pill correctly showing live progress (layout.tsx
     populates the slice via api.getAnalysisState) but the view itself
     stuck on "Start analysis" — clicking it then fires a fresh POST
     that the server routes via the subscribe path, masking the bug
     as "I had to click before things appeared to run".
     - state='running' → server is actively producing; flip
       analysisStarted on so the analysis useEffect opens its
       subscribe SSE without a click.
     - state='paused' or 'halted' → user must explicitly Resume /
       acknowledge the halt; only mark hasStartedOnceRef so the
       button reads "Resume analysis" instead of "Start analysis".
     One-shot per mount so a user's explicit Pause (which keeps the
     paused snapshot in the slice) is never auto-undone. */
  const activeStreamSnapshot = useAppSelector((s) => s.analysis.activeStream);
  /* #3084 F7 — the run-level "How to fix" list must survive the user leaving
     the view and coming back in the same session. This view's own `error`
     state does not (it is per-mount), but the halted-run snapshot the
     analysis-stream middleware wrote does — so the block near the bottom of
     this file falls back to `haltFixes` when `error` is null.

     Three guards, all load-bearing:
     - manuscriptId: a DIFFERENT book's halt must not leak this book's chrome;
     - state === 'halted': a running/paused snapshot has no fixes to show;
     - !isNotAFailureHaltCode: `cast_incomplete` and `stage1_shrink_refused`
       also leave `error` null while halted (their catch branches dispatch
       setHalted and deliberately never setError, see below), and #3244 renders
       those as a neutral "Needs action" state. Without this exclusion a future
       task attaching fixes to either code would print a "How to fix" list
       inside failure chrome for a state that is explicitly not a failure.
       Neither code carries fixes today, so this is a guard, not a carve-out. */
  const haltFixes = useAppSelector((s) => {
    const snap = s.analysis.activeStream;
    if (!snap) return undefined;
    if (snap.manuscriptId !== manuscriptId) return undefined;
    if (snap.state !== 'halted') return undefined;
    if (isNotAFailureHaltCode(snap.haltCode)) return undefined;
    return snap.haltFixes;
  });
  const coldBootRehydratedRef = useRef(false);
  useEffect(() => {
    if (coldBootRehydratedRef.current) return;
    if (!manuscriptId) return;
    if (!activeStreamSnapshot) return;
    if (activeStreamSnapshot.manuscriptId !== manuscriptId) return;
    coldBootRehydratedRef.current = true;
    hasStartedOnceRef.current = true;
    /* #3435 (C9) — only a running MAIN snapshot re-attaches the main stream. A
       running subset (a Retry, Re-analyse or Include) never POSTs the main
       route: the server would refuse it, and the rows come from the
       book-state GET as usual. */
    if (activeStreamSnapshot.state === 'running' && activeStreamSnapshot.kind !== 'subset') {
      setAnalysisStarted(true);
      setResuming(true);
    }
  }, [manuscriptId, activeStreamSnapshot]);
  /* #3435 decision A — a main run is live for this manuscript (on this device
     or another), so Retry is disabled: the server refuses a subset run beside
     it. */
  const mainAnalysisLive = useAppSelector((s) => selectMainAnalysisLive(s, manuscriptId));

  /* Analyzer readiness gate — declared up here (above the analysis
     useEffect) because the analysis effect depends on it. The full
     analyzer Load/Stop machinery lives further down; this slice pulls
     just the bits the analysis effect needs to decide whether it's
     safe to fire the SSE. */
  /* Plan 118 — the model id to SEND on the request. When the user has a
     per-phase split configured AND hasn't made an explicit per-run pick, send
     nothing so the server's saved per-phase models apply (precedence priority
     3). Otherwise send the selected model — preserving the single-model path
     (split off → both phases use defaultAnalysisModel) and the explicit
     per-run override (priority 2). */
  const splitActive = useAppSelector((s) => selectAnalyzerSplitIsActive(s.account));
  const selectedModelExplicit = useAppSelector((s) => s.ui.selectedModelExplicit);
  const defaultAnalysisModel = useAppSelector((s) => s.account.defaultAnalysisModel);
  const phase0Model = useAppSelector((s) => s.account.analyzerPhase0Model);
  const phase1Model = useAppSelector((s) => s.account.analyzerPhase1Model);
  /* #3141 step 5 — per-run picks from the analysing view's PhaseModelSwap
     control (never persisted to settings). A pick counts as split mode for
     the requestModel/effectiveModelIds logic below, same as a saved
     per-phase split, but a per-run pick is cleared once its run has been
     requested (see the analysis effect) so a later run starts from settings. */
  const phase0Pick = useAppSelector((s) => selectPhaseModelPick(s.ui, manuscriptId, 0));
  const phase1Pick = useAppSelector((s) => selectPhaseModelPick(s.ui, manuscriptId, 1));
  const hasPhasePick = Boolean(phase0Pick || phase1Pick);
  /* Live local Ollama tags for the failed-retry model picker (curated ∪ live),
     so a model the user just pulled is selectable here. Fetched only AFTER a
     failure (gated on `error` below) — a healthy cloud run never probes Ollama,
     preserving the cloud-no-probe invariant. */
  const localAnalyzerModels = useAppSelector((s) => s.account.localAnalyzerModels);
  const analyzerModelGroups = buildModelOptionGroups(buildLocalModelOptions(localAnalyzerModels));
  /* fs-65 Task 12 — per-book prosody annotation toggle. Eager default: absent
     (undefined) or true → checked; only an explicit false → unchecked. */
  const prosodyStored = useAppSelector(selectProsodyEnabled(bookId ?? null));
  /* Populate the local-tag list only after a failure surfaces the retry picker
     — never on a healthy (possibly cloud) run, so the Ollama probe stays off
     the cloud path. */
  useEffect(() => {
    if (error) void dispatch(fetchAnalyzerModels());
  }, [dispatch, error]);
  const requestModel = (splitActive || hasPhasePick) && !selectedModelExplicit ? undefined : model;
  /* The model id(s) the run will ACTUALLY execute on. The readiness/engine
     gate MUST derive from these, not from ui.selectedModel: ui.selectedModel is
     re-seeded from the account default on every boot (ui-slice.ts), so a user
     who once used Ollama keeps a stale LOCAL default there even after switching
     the per-phase dropdowns to a cloud model. Reading it directly left the view
     "stuck on Ollama" — probing the daemon, blocking Start on VRAM residency —
     for a Gemini run that never calls Ollama. Mirror requestModel exactly:
       - split engaged, no explicit pick → the saved per-phase models plus any
         per-run picks (a blank phase without a pick falls back to the account
         default, which the client now knows and sends);
       - otherwise → the single per-run model (or the built-in default). */
  const effectiveModelIds = useMemo<string[]>(() => {
    if ((splitActive || hasPhasePick) && !selectedModelExplicit) {
      return [
        phase0Pick ?? phase0Model ?? defaultAnalysisModel,
        phase1Pick ?? phase1Model ?? defaultAnalysisModel,
      ].filter((id): id is string => Boolean(id));
    }
    return [model ?? MODEL_OPTIONS[0].id];
  }, [
    splitActive,
    hasPhasePick,
    selectedModelExplicit,
    phase0Pick,
    phase1Pick,
    phase0Model,
    phase1Model,
    defaultAnalysisModel,
    model,
  ]);
  const isLocalAnalyzer = effectiveModelIds.some((id) => engineForModelId(id) === 'local');
  /* Engine tag captured into the cross-navigation snapshot (read by the
     reverse-local-analyzer guard). Mirror the effective-local derivation so a
     cloud run is never mis-tagged 'local' and made to nag the TTS-start path.
     Uses the shared id grammar so an endpoint run is tagged 'openai', not
     the stale 'gemini' default. */
  const effectiveEngine: AnalysisEngine = isLocalAnalyzer
    ? 'local'
    : engineForModelId(effectiveModelIds[0] ?? '');
  const [ollamaHealth, setOllamaHealth] = useState<OllamaHealth | null>(null);
  const [pendingAnalyzerPill, setPendingAnalyzerPill] = useState<ModelControlState | null>(null);
  const [analyzerProbeKey, setAnalyzerProbeKey] = useState(0);
  /* In-flight op counter — guards the /health poll's unconditional pending-
     clear below against a Load/Stop that is still awaiting its response.
     handleStopAnalyzer awaits api.unloadAnalyzer() and handleLoadAnalyzer
     awaits api.unloadSidecar() (the TTS route #1921 moved to a 90s budget),
     so the 30s poll tick can land WHILE either is still pending. Without
     this guard the poll would clear the optimistic pending override and the
     pill would flip back to a stale reading mid-operation — mirrors
     `inFlightOps` in src/lib/use-tts-lifecycle.ts (#1921/#1930). Incremented
     at the top of each handler, decremented in a finally so a throw can't
     leak it and freeze the pill's optimistic state permanently. */
  const inFlightAnalyzerOps = useRef(0);
  const [analyzerEvictionNotice, setAnalyzerEvictionNotice] = useState<string | null>(null);
  /* Rose banner shown when Load / Stop returns {status:'error', ...} or
     throws. Without it the auto-load path looks stuck on "Loading…" and
     the manual Load click silently bounces the pill back to idle. */
  const [analyzerLoadError, setAnalyzerLoadError] = useState<string | null>(null);
  /* Residency MUST be judged on the model(s) the run actually executes
     (`effectiveModelIds`), NOT `ollamaHealth.modelResident` — that flag is the
     residency of the server's CONFIGURED DEFAULT (e.g. qwen3.5:4b). Keying off
     it made the view warm/check the default while the run used a per-run override
     or per-phase pick (e.g. gemma): the pill showed "Load model" mid-analysis and
     auto-warm kept reloading the default after the user stopped it. We derive
     residency from `ollamaHealth.resident` (Ollama /api/ps) against the run model
     instead, and warm the run model (`runModelToWarm`), never the default. */
  const localRunModels = useMemo(() => localRunModelIds(effectiveModelIds), [effectiveModelIds]);
  const runModelToWarm = localRunModels[0];
  const runModelsResident = runModelsAllResident(effectiveModelIds, ollamaHealth?.resident ?? []);
  const isAnalyzerReady =
    !isLocalAnalyzer || (ollamaHealth?.status === 'reachable' && runModelsResident);

  /* A run that sent `result` finished the book: the main run's own ending,
     and a Retry's whose subset run finished it (#3435 S14). */
  const completeRun = (payload: AnalyseResponse) => {
    completedRef.current = true;
    setConn('done');
    setDroppedQuotesRefreshKey((k) => k + 1);
    setBookStateRefreshKey((k) => k + 1);
    /* Run completed cleanly — tear down the cross-navigation snapshot
       so the pill drops out (the view will transition to confirm
       via onComplete below anyway). */
    dispatch(analysisActions.clearActiveStream());
    onComplete(payload);
  };

  useEffect(() => {
    if (!manuscriptId) return; // nothing to analyse — UI shows a CTA below
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
       the server's log filled with per-request start ↔ `[analysis]
       aborted` pairs as the browser eventually pruned the orphaned
       fetches, breaking every retry. */
    const controller = new AbortController();
    analysisControllerRef.current = controller;
    hasStartedOnceRef.current = true;
    setPhase(0);
    maxPhaseRef.current = 0;
    setProgressByPhase({});
    setLiveByPhase({});
    setLogs({});
    setError(null);
    setConn('connecting');
    setLastEventAt(null);
    setHeartbeatByPhase({});
    setServerModelByPhase({});
    setRemainingMs(null);
    /* Clear castIncomplete on every re-entry so an old "paused" state
       doesn't linger when the user clicks Try again / Start fresh /
       model switch. If the server still has unresolved failures this
       run will re-set it via the cast_incomplete catch below. */
    setCastIncomplete(false);
    /* Same clear for the shrink-refused banner — a new attempt either
       succeeds (banner stays cleared) or hits the gate again and the
       catch below re-sets it with fresh counts. Only a MAIN shrink banner:
       a Retry's (#3435) belongs to that chapter's subset run. */
    setStage1ShrinkInfo((info) => (info?.retryChapterId !== undefined ? info : null));
    setStartRefusal(null);
    const markEvent = () => {
      setLastEventAt(Date.now());
      /* First event of any run means we're re-attached — drop the
         "Reconnecting…" bridge (issue #865). No-op when not resuming. */
      setResuming(false);
    };
    /* #3435 (A7) — the snapshot as it was before this POST, restored if the
       server refuses the start, so a refused start leaves no `running` main
       snapshot behind to grey out this device's own Retry. */
    const preStartSnapshot = store.getState().analysis.activeStream;
    /* Seed the cross-navigation analysis snapshot so the AnalysisPill
       (B3) can read live progress from Redux even after the user
       navigates away from this view. The snapshot updates on every
       phase / eta tick below and is torn down on terminal events. */
    dispatch(
      analysisActions.setActiveStream({
        bookId: bookId ?? null,
        manuscriptId,
        bookTitle: title ?? undefined,
        /* Engine captured at start time, not read from ui.selectedModel
         later. A user model-switch mid-stream must not mis-classify a
         running analysis from the reverse-direction guard's
         perspective (see use-reverse-local-analyzer-guard.tsx). */
        engine: effectiveEngine,
        phaseId: 0,
        phaseLabel: ANALYSIS_PHASES[0]?.label ?? 'Detecting characters',
        phaseProgress: 0,
        remainingMs: null,
        lastTickAt: Date.now(),
        state: 'running',
      }),
    );
    /* #3141 step 5 — the picks are being sent on this request now; clear them
       so a later run (retry, or a fresh Start on this manuscript) starts from
       settings instead of silently repeating a one-off choice. An explicit
       per-run override collapses the split server-side, so picks are never
       sent alongside one — nothing to clear in that case since they didn't
       affect this run. */
    if (hasPhasePick && !selectedModelExplicit) dispatch(uiActions.clearPhaseModelPicks({ manuscriptId }));
    (async () => {
      try {
        const payload = await api.analyseManuscript(manuscriptId, {
          signal: controller.signal,
          model: requestModel,
          phase0Model:
            selectedModelExplicit || (!splitActive && !hasPhasePick)
              ? undefined
              : phase0Pick ?? phase0Model ?? defaultAnalysisModel,
          phase1Model:
            selectedModelExplicit || (!splitActive && !hasPhasePick)
              ? undefined
              : phase1Pick ?? phase1Model ?? defaultAnalysisModel,
          fresh: retry.fresh || undefined,
          allowStage1Shrink: retry.allowStage1Shrink || undefined,
          onPhase: ({ phaseId, progress, live, model: serverModel }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            if (serverModel) {
              setServerModelByPhase((prev) => ({ ...prev, [phaseId]: serverModel }));
            }
            /* Per-phase state: each phase owns its progress + live payload so
               pipelined cast (Phase 0) and attribution (Phase 1) ticks don't
               overwrite one another. Live is STICKY — only replaced when a tick
               carries a fresh `live`, never blanked on a no-live tick. The
               server/mock emit `live` only while a chapter is in flight, so a
               mid-phase no-live tick must not flicker the ticker out. A phase's
               ticker stops rendering once it reads as done (progress 1 →
               derivePhaseState), which also hides its now-stale live + heartbeat. */
            setProgressByPhase((prev) => ({ ...prev, [phaseId]: progress }));
            if (live) setLiveByPhase((prev) => ({ ...prev, [phaseId]: live }));
            const prevMax = maxPhaseRef.current;
            const newMax = Math.max(prevMax, phaseId);
            maxPhaseRef.current = newMax;
            if (newMax !== prevMax) setPhase(newMax);
            /* Only the frontier phase drives the cross-nav snapshot's phase
               label/progress (so the top-bar pill doesn't flip-flop between the
               two pipelined phases); lagging-phase ticks just refresh the
               liveness timestamp. */
            dispatch(
              analysisActions.applyAnalysisSnapshotTick(
                phaseId === newMax
                  ? {
                      manuscriptId,
                      phaseId,
                      phaseLabel: ANALYSIS_PHASES[phaseId]?.label ?? 'Analysing',
                      phaseProgress: progress,
                      lastTickAt: Date.now(),
                    }
                  : { manuscriptId, lastTickAt: Date.now() },
              ),
            );
          },
          onLog: ({ phaseId, message }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setLogs((prev) => ({ ...prev, [phaseId]: [...(prev[phaseId] ?? []), message] }));
          },
          onHeartbeat: (hb) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setHeartbeatByPhase((prev) => ({
              ...prev,
              [hb.phaseId]: { hb, receivedAt: Date.now() },
            }));
          },
          onEta: ({ remainingMs: ms }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            setRemainingMs(ms);
            dispatch(
              analysisActions.applyAnalysisSnapshotTick({
                manuscriptId,
                remainingMs: ms,
                lastTickAt: Date.now(),
              }),
            );
          },
          onCastUpdate: ({ characters }) => {
            if (cancelled) return;
            setConn('streaming');
            markEvent();
            /* Replace the cast slice with each full roster snapshot so the
               cast view (and Phase 0 live preview below) mirror the server's
               already-deduped, verifier-pruned roster exactly — no stale
               same-name dups or verifier-dropped names lingering. Replay-safe
               — snapshots upsert by id, preserving locked voices on survivors. */
            dispatch(castActions.replaceLiveRoster(characters));
          },
          onChapterFailed: ({ chapterId, message, code, remediation, phase }) => {
            if (cancelled) return;
            markEvent();
            /* Upsert by chapterId so a retry of the same chapter (which
               will fail again, replaying chapter-failed) doesn't double
               the row. */
            setFailedChapters((prev) => {
              const filtered = prev.filter((f) => f.chapterId !== chapterId);
              return [...filtered, { chapterId, message, code, remediation, phase }];
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
            setFailedChapters((prev) => prev.filter((f) => f.chapterId !== chapterId));
          },
          onThrottle: ({ phaseId, model: throttleModel, waitMs, reason }) => {
            if (cancelled) return;
            markEvent();
            setThrottleByPhase((prev) => ({
              ...prev,
              [phaseId]: { until: Date.now() + waitMs, model: throttleModel, reason },
            }));
          },
          onSeriesPrior: ({ count, names }) => {
            if (cancelled) return;
            markEvent();
            /* Series carry-over surface (C3). Server emitted this once
               at Phase 0 entry; persist into the slice so the
               analysing view's "Carried from <series>" pill renders
               immediately and survives reload. */
            dispatch(analysisActions.setSeriesPrior({ manuscriptId, count, names }));
          },
          onWarning: ({ code, message }) => {
            if (cancelled) return;
            /* dedupeKey collapses a burst across the five merge-base write
               sites into one toast. Wire kind is 'warning'; ToastKind is
               'warn' — they are different vocabularies, not a typo. */
            dispatch(
              notificationsActions.pushToast({ kind: 'warn', message, dedupeKey: code }),
            );
          },
        });
        if (cancelled || completedRef.current) return;
        completeRun(payload);
      } catch (e) {
        if (cancelled) return;
        /* AbortError = the effect cleanup tore the fetch down (the user
           re-tried / switched models / unmounted). Server emits a
           `kind: 'error', code: 'aborted'` event for the same reason —
           either way it's a benign disconnect, not a failure to surface
           in the UI. Falling through would flash "Analysis failed:
           Analysis aborted" right before the new attempt renders. */
        /* #3435 (C-8) — every run ending this view observes re-reads the
           book-state facts, an abort included: the run may have written
           stage1 before it stopped. */
        setBookStateRefreshKey((k) => k + 1);
        if ((e as Error)?.name === 'AbortError') return;
        /* #3435 (A7) — the server refused this start: a chapter retry is
           running (`subset_analysis_running`), or the previous run is still
           finishing (`main_analysis_running`, draining). No job started, so
           this is neither a halt nor a failure: restore the pre-POST snapshot,
           go idle, and show the server's message. */
        if (
          e instanceof AnalysisError &&
          (e.code === 'subset_analysis_running' || e.code === 'main_analysis_running')
        ) {
          if (preStartSnapshot) dispatch(analysisActions.setActiveStream(preStartSnapshot));
          else dispatch(analysisActions.clearActiveStream());
          setConn('idle');
          setAnalysisStarted(false);
          setStartRefusal(e.message);
          return;
        }
        if (e instanceof AnalysisError && e.code === 'aborted') {
          /* Server-side pause / displacement. Reflect in the snapshot
             so the pill renders the paused variant, but DO NOT clear
             the snapshot — keep the pill visible so the user can
             navigate back to the analysing view and resume. Update conn
             state to keep the sticky bar in sync (paused → idle). */
          setConn('idle');
          dispatch(analysisActions.setPaused({ manuscriptId }));
          return;
        }
        /* cast_incomplete is the server's "Phase 0 done but at least one
           chapter still needs retry" signal. Not a failure — the user
           sees the failed-chapter panel and can retry below. The
           auto-resume effect picks up once every row resolves. */
        if (e instanceof AnalysisError && e.code === 'cast_incomplete') {
          setConn('idle');
          setCastIncomplete(true);
          setDroppedQuotesRefreshKey((k) => k + 1);
          dispatch(analysisActions.setHalted({ manuscriptId, code: e.code, message: e.message }));
          return;
        }
        /* stage1_shrink_refused is the data-loss guard for stage1
           rewrites. Not a failure — the user sees a banner with the
           prev/next counts and can opt in via "Accept smaller roster",
           which re-fires the request with allowStage1Shrink: true. */
        if (e instanceof AnalysisError && e.code === 'stage1_shrink_refused') {
          setConn('idle');
          setStage1ShrinkInfo({
            prev: e.prevCharCount ?? 0,
            next: e.nextCharCount ?? 0,
          });
          dispatch(analysisActions.setHalted({ manuscriptId, code: e.code, message: e.message }));
          return;
        }
        setConn('error');
        const code = e instanceof AnalysisError ? e.code : 'unknown';
        const detail = e instanceof AnalysisError ? e.detail : undefined;
        const remediation = e instanceof AnalysisError ? e.remediation : undefined;
        /* #3084 F7 — carried to BOTH sinks below so the view agrees with the
           analysis-stream middleware's own setHalted/pushToast for the same
           failure (the middleware is what keeps the toast alive after
           navigation; this view's copy is what renders the run-level list
           inline without waiting for a re-mount). */
        const fixes = e instanceof AnalysisError ? e.fixes : undefined;
        dispatch(
          analysisActions.setHalted({
            manuscriptId,
            code,
            message: (e as Error)?.message ?? 'Analysis failed.',
            fixes,
          }),
        );
        setError({
          message: (e as Error).message || 'Analysis failed.',
          code,
          detail,
          remediation,
          fixes,
        });
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
     show a human title instead of a bare numeric id.
     #3435 (C-8) — re-read after every run ending this view observes
     (`bookStateRefreshKey`), for the analysis facts as well as the rows. */
  const [chapterTitleById, setChapterTitleById] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    /* The mount read is the one fired with the initial key; a refresh (a later
       key) never arms castIncomplete, even if the mount read was cancelled
       before it answered. */
    const isMountRead = bookStateRefreshKey === 0;
    api
      .getBookState(bookId)
      .then((res) => {
        if (cancelled || res === null) return;
        const titles: Record<number, string> = {};
        for (const c of res.state.chapters) titles[c.id] = c.title;
        setChapterTitleById(titles);
        const stage1Ready = res.analysis?.stage1Ready;
        setBookFacts({
          stage1Ready,
          resumeRequired: res.analysis?.resumeRequired === true,
          castConfirmed: res.state.castConfirmed === true,
        });
        /* #3435 (C20) — castIncomplete arming (b): on mount only, from a halted
           cast_incomplete snapshot of either kind, when the roster is not final.
           A later refresh never arms it (C-8). */
        if (isMountRead) {
          const snap = store.getState().analysis.activeStream;
          if (
            stage1Ready === false &&
            snap &&
            snap.manuscriptId === manuscriptId &&
            snap.state === 'halted' &&
            snap.haltCode === 'cast_incomplete'
          ) {
            setCastIncomplete(true);
          }
        }
        const failedIds = res.analysis?.failedChapterIds ?? [];
        /* #3435 — a refresh is the server's current view of the rows: one it no
           longer reports drops, even when it reports none. */
        if (failedIds.length === 0 && isMountRead) return;
        const errorById = res.analysis?.failedChapterErrors ?? {};
        setFailedChapters((prev) => {
          /* Merge with whatever the SSE already pushed during this session
             so we don't clobber a fresh chapter-failed event whose
             message is more useful than the hydration placeholder. */
          const liveById = new Map(prev.map((f) => [f.chapterId, f]));
          return failedIds.map((id) => {
            const live = liveById.get(id);
            const record = errorById[String(id)];
            if (live) {
              /* #3435 — on a refresh a kept row takes the server's phase; it
                 keeps its own message (a live one, e.g. a refused Retry's, is
                 more useful than the stored record's). */
              if (isMountRead || !record?.phase) return live;
              return { ...live, phase: record.phase };
            }
            if (record) {
              return {
                chapterId: id,
                message: record.message,
                code: record.code,
                remediation: record.remediation,
                phase: record.phase,
              };
            }
            /* No stored record: the legacy placeholder. Its phase is unknown, so
               it reads as a cast row (what every row was before plan 285). */
            return {
              chapterId: id,
              message: 'Analysis failed on a previous attempt. Retry to try again.',
              phase: 'cast' as const,
            };
          });
        });
      })
      .catch((err) => {
        console.warn('[analysing] failed-chapter hydrate skipped:', err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, bookStateRefreshKey]);

  /* Auto-resume the main run after the user resolves every failed
     cast chapter. The server's cast_incomplete gate stops the run before
     Phase 1; once no cast row is left we re-enter /analysis/stream which
     discovers the roster is final and attributes the book. Without this
     the user would have to click "Try again" themselves after the final
     retry — easy to miss when the panel has just disappeared.
     #3435 (P-beta) — keyed on CAST rows only: an attribution row waits for
     exactly this resume, so it must not block it. The book-state facts never
     arm or disarm it (C-8); it fires only for a run this view started. */
  const castRowCount = failedChapters.filter((f) => (f.phase ?? 'cast') === 'cast').length;
  useEffect(() => {
    if (!castIncomplete) return;
    if (!analysisStarted) return;
    if (castRowCount > 0) return;
    if (retryingChapterId !== null) return;
    setRetry((r) => ({ nonce: r.nonce + 1, fresh: false }));
  }, [castIncomplete, analysisStarted, castRowCount, retryingChapterId]);

  /* Per-chapter retry handler. Hits POST /api/manuscripts/:id/analysis/
     chapters, which on success removes the chapter id from
     cache.failedChapterIds (also broadcast via chapter-resolved SSE so
     this view's row clears in real time).

     Concurrency contract — REFUSE UNTIL PAUSED (#3435 decision A). The main
     run and a subset run must never write one book at once: both load their
     own snapshot of the disk-backed analysis cache and write back
     independently, so the second finisher clobbered the first's progress.
     The server refuses a subset POST while a main run is live or still
     finishing (409 `main_analysis_running`), and Retry is disabled with
     "Pause the analysis first" while this view knows a main run is live. The
     earlier client-side pause-and-retry is withdrawn: it could not wait for
     the paused run to settle. */
  const handleRetryChapter = (chapterId: number, opts: { allowStage1Shrink?: boolean } = {}) => {
    if (!manuscriptId) return;
    if (retryingChapterId !== null) return;
    setRetryingChapterId(chapterId);
    /* #3435 — the refused-start line is about that start; a Retry supersedes it.
       So does the failed main run's red banner: whatever this Retry ends in is
       what the screen shows. */
    setStartRefusal(null);
    setError(null);
    /* Reset the subset_in_progress flag for this attempt. */
    subsetInProgressRef.current = false;
    retryHaltedRef.current = false;
    retryNeedsActionRef.current = false;
    const markEvent = () => {
      setLastEventAt(Date.now());
      /* First event of any run means we're re-attached — drop the
         "Reconnecting…" bridge (issue #865). No-op when not resuming. */
      setResuming(false);
    };
    /* Retry now owns the conn/phase indicators — the main run is not
       running (Retry is disabled while it is). */
    setConn('connecting');
    /* Plan 32 follow-up: switch the cross-navigation snapshot from
       main → subset so the top-bar AnalysisPill renders the "Retrying
       N chapters" variant and the analysis-stream-middleware re-opens
       its sticky subscribe POST against the subset route's in-flight
       map. Without this, a navigate-away mid-retry dropped the pill
       and the middleware would have tried to subscribe to the main
       map (which has no job) and either start a fresh main run or
       fall through.

       Capture the prior snapshot in case the request is refused
       (subset_in_progress, or #3435 main_analysis_running); restoration
       prevents a stale/clobbered state from becoming permanent (B2
       regression guard). */
    const priorSnapshot = store.getState().analysis.activeStream;
    dispatch(
      analysisActions.setActiveStream({
        bookId: bookId ?? null,
        manuscriptId,
        bookTitle: title ?? undefined,
        engine: effectiveEngine,
        phaseId: 0,
        phaseLabel: ANALYSIS_PHASES[0]?.label ?? 'Detecting characters',
        phaseProgress: 0,
        remainingMs: null,
        lastTickAt: Date.now(),
        state: 'running',
        kind: 'subset',
        subsetChapterIds: [chapterId],
      }),
    );
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
    /* The server announced this chapter resolved (its record was cleared). A
       stream that ends without a `result` drops the row only on this; a chapter
       the server never resolved still has its record, so its row stays. */
    let retryResolved = false;
    api
      .runAnalysisForChapters(manuscriptId, [chapterId], {
        model: requestModel,
        /* #3435 — set only by the subset shrink banner's Accept. */
        allowStage1Shrink: opts.allowStage1Shrink || undefined,
        onPhase: ({ phaseId, progress, live }) => {
          markEvent();
          setConn('streaming');
          setProgressByPhase((prev) => ({ ...prev, [phaseId]: progress }));
          if (live) setLiveByPhase((prev) => ({ ...prev, [phaseId]: live }));
          const newMax = Math.max(maxPhaseRef.current, phaseId);
          maxPhaseRef.current = newMax;
          setPhase(newMax);
          /* Snapshot tick — proof to the middleware that the subset
           SSE is alive so it can attach as a second subscriber. */
          dispatch(
            analysisActions.applyAnalysisSnapshotTick({
              manuscriptId,
              phaseId,
              phaseLabel: ANALYSIS_PHASES[phaseId]?.label ?? 'Analysing',
              phaseProgress: progress,
              lastTickAt: Date.now(),
            }),
          );
        },
        onLog: ({ phaseId, message }) => {
          markEvent();
          setConn('streaming');
          setLogs((prev) => ({ ...prev, [phaseId]: [...(prev[phaseId] ?? []), message] }));
        },
        onHeartbeat: (hb) => {
          markEvent();
          setConn('streaming');
          setHeartbeatByPhase((prev) => ({
            ...prev,
            [hb.phaseId]: { hb, receivedAt: Date.now() },
          }));
        },
        onCastUpdate: ({ characters }) => {
          markEvent();
          /* Full roster snapshot — replace, don't accumulate (see the other
             onCastUpdate handler above and replaceLiveRoster's rationale). */
          dispatch(castActions.replaceLiveRoster(characters));
        },
        onChapterFailed: ({ chapterId: failedId, message, code, remediation, phase }) => {
          markEvent();
          if (failedId === chapterId) retryReFailed = true;
          setFailedChapters((prev) => {
            const filtered = prev.filter((f) => f.chapterId !== failedId);
            return [...filtered, { chapterId: failedId, message, code, remediation, phase }];
          });
        },
        onChapterResolved: ({ chapterId: resolvedId }) => {
          markEvent();
          if (resolvedId === chapterId) retryResolved = true;
          setFailedChapters((prev) => prev.filter((f) => f.chapterId !== resolvedId));
        },
        onThrottle: ({ phaseId, model: throttleModel, waitMs, reason }) => {
          markEvent();
          setThrottleByPhase((prev) => ({
            ...prev,
            [phaseId]: { until: Date.now() + waitMs, model: throttleModel, reason },
          }));
        },
        onWarning: ({ code, message }) => {
          /* dedupeKey collapses a burst across the five merge-base write
             sites into one toast. Wire kind is 'warning'; ToastKind is
             'warn' — they are different vocabularies, not a typo. */
          dispatch(
            notificationsActions.pushToast({ kind: 'warn', message, dedupeKey: code }),
          );
        },
      })
      .then((payload) => {
        if (!retryReFailed) {
          setFailedChapters((prev) => prev.filter((f) => f.chapterId !== chapterId));
        }
        /* #3435 (S14) — a subset `result` on a book that has not reached
           Confirm means the book is finished: route to Confirm exactly like a
           main run's result. A cast-confirmed book stays put (decision F). */
        if (bookFacts?.castConfirmed !== true && !completedRef.current && mountedRef.current) {
          completeRun(payload);
          return;
        }
        setConn('idle');
      })
      .catch((err) => {
        /* subset_in_progress (#3202) — the server rejected this retry
           outright because a different subset is already running; it
           never reaches onChapterFailed, so retryReFailed stays false and
           the generic branch below would wrongly drop the row as if it
           had succeeded. Surface the server's message instead. This request
           never started a job, so restore the prior snapshot (B2 regression
           guard: the pre-POST clobber must not persist on rejection) and
           mark this in the ref so the finally block knows not to touch it or
           re-arm the main run. */
        /* #3435 — `main_analysis_running`: the server refused this Retry
           because the main run is live or still finishing. Same handling:
           restore, keep the row, show the server's message on it. */
        if (
          err instanceof AnalysisError &&
          (err.code === 'subset_in_progress' || err.code === 'main_analysis_running')
        ) {
          subsetInProgressRef.current = true;
          if (priorSnapshot) {
            dispatch(analysisActions.setActiveStream(priorSnapshot));
          } else {
            dispatch(analysisActions.clearActiveStream());
          }
          setFailedChapters((prev) => {
            /* The refusal row replaces the failure row: it keeps that row's
               phase, so the panel still groups it under the step that failed. */
            const existing = prev.find((f) => f.chapterId === chapterId);
            const filtered = prev.filter((f) => f.chapterId !== chapterId);
            return [
              ...filtered,
              { chapterId, message: err.message, code: err.code, phase: existing?.phase ?? 'cast' },
            ];
          });
          setConn('idle');
          return;
        }
        /* #3084 — the reasoning-overflow terminal frame arrives as an `error`
           event with NO chapter-failed, so it is a FAILURE of this Retry, not
           the benign no-result case below. Deliberately an allowlist of one:
           other codes (cast_incomplete after a Retry that SUCCEEDED,
           stage1_shrink_refused, ...) keep their pre-existing paths. Keep the row, halt the run-level
           state with the fixes so "How to fix" renders and the middleware's
           HALTED hook pushes the persistent toast, and tell the finally
           block not to clear the snapshot or resume the main run (which
           would only overflow again on the same settings). The retained row
           also keeps the cast_incomplete auto-resume effect disarmed. */
        if (err instanceof AnalysisError && err.code === 'analyzer-reasoning-overflow') {
          retryHaltedRef.current = true;
          setFailedChapters((prev) => {
            const existing = prev.find((f) => f.chapterId === chapterId);
            const filtered = prev.filter((f) => f.chapterId !== chapterId);
            return [
              ...filtered,
              {
                chapterId,
                message: err.message,
                code: err.code,
                remediation: err.remediation,
                phase: existing?.phase ?? 'cast',
              },
            ];
          });
          dispatch(
            analysisActions.setHalted({
              manuscriptId,
              code: err.code,
              message: err.message,
              fixes: err.fixes,
            }),
          );
          setConn('idle');
          return;
        }
        /* #3435 — a soft stop (`cast_incomplete`, `stage1_shrink_refused`,
           `resume_required`) is the user's call to action, not a failure: halt
           the snapshot with the server's message (the needs-action line and the
           pill read it), raise no toast, and tell the finally block to leave the
           snapshot alone. The row follows the same rule as the plain no-result
           ending below. A shrink also raises the banner, whose Accept re-runs
           this chapter's subset with allowStage1Shrink. */
        if (err instanceof AnalysisError && isNotAFailureHaltCode(err.code)) {
          retryNeedsActionRef.current = true;
          if (retryResolved && !retryReFailed) {
            setFailedChapters((prev) => prev.filter((f) => f.chapterId !== chapterId));
          }
          if (err.code === 'stage1_shrink_refused') {
            setStage1ShrinkInfo({
              prev: err.prevCharCount ?? 0,
              next: err.nextCharCount ?? 0,
              retryChapterId: chapterId,
            });
          }
          dispatch(
            analysisActions.setHalted({ manuscriptId, code: err.code, message: err.message }),
          );
          setConn('idle');
          return;
        }
        /* The subset route ends without a `result` event on a gate exit.
           api.ts throws "no result" in that case — not a real failure. The row
           drops only if the server said this chapter resolved; otherwise its
           record is still on the server and the row stays. */
        if (retryResolved && !retryReFailed) {
          setFailedChapters((prev) => prev.filter((f) => f.chapterId !== chapterId));
        } else if (retryReFailed) {
          console.warn('[analysing] retry failed:', err);
        }
        setConn('idle');
      })
      .finally(() => {
        setRetryingChapterId(null);
        setDroppedQuotesRefreshKey((k) => k + 1);
        /* #3435 (C-8) — re-read the book-state facts after the subset ended. */
        setBookStateRefreshKey((k) => k + 1);
        /* If the subset request was refused (subset_in_progress #3202, or
           main_analysis_running #3435), the catch restored the prior
           snapshot: leave it alone. */
        if (subsetInProgressRef.current) {
          return;
        }
        /* Same for a Retry that failed with a real analyzer error (#3084):
           the halted snapshot is the user's call to action — don't clear it
           or restart the run behind it. */
        if (retryHaltedRef.current) {
          return;
        }
        /* #3435 A8 — and for a Retry that ended in a not-a-failure stop
           (`cast_incomplete`, `stage1_shrink_refused`, `resume_required`): the
           halted snapshot carries the message the needs-action line shows. */
        if (retryNeedsActionRef.current) {
          return;
        }
        /* The Retry ran on its own (the main run is never running beside it,
           #3435). Clear the snapshot so the pill drops out; the cast_incomplete
           auto-resume effect handles its own next-step decisions. */
        /* After unmount the snapshot may belong to another book now: clear it
           only if it is still this Retry's. */
        if (
          mountedRef.current ||
          store.getState().analysis.activeStream?.manuscriptId === manuscriptId
        ) {
          dispatch(analysisActions.clearActiveStream());
        }
      });
  };

  const overall = computeOverallProgress(phase, progressByPhase[phase] ?? 0);
  const sinceLastSec = lastEventAt
    ? Math.max(0, Math.round((Date.now() - lastEventAt) / 1000))
    : null;

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
      api
        .getOllamaHealth()
        .then((h) => {
          if (cancelled) return;
          setOllamaHealth(h);
          if (inFlightAnalyzerOps.current === 0) setPendingAnalyzerPill(null);
        })
        .catch(() => {
          if (cancelled) return;
          setOllamaHealth({ status: 'unreachable', url: '', error: 'Probe failed.' });
          if (inFlightAnalyzerOps.current === 0) setPendingAnalyzerPill(null);
        });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
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
    /* Resident-in-VRAM (not just "pulled") — the RUN model has to be loaded
       AND at the analyzer's num_ctx for the next chat call to skip the
       reload. Judged on the run model's residency (Ollama /api/ps), not the
       configured default's modelResident flag. */
    if (runModelsResident) return 'ready';
    /* Model not resident yet AND analysis is reaching out — the very first
       chat call is implicitly warming the model, so surface as 'loading'
       so the user has visible feedback during the cold-load tax. */
    if (conn === 'connecting') return 'loading';
    return 'idle';
  })();

  const handleLoadAnalyzer = async () => {
    inFlightAnalyzerOps.current += 1;
    try {
      setPendingAnalyzerPill('loading');
      setAnalyzerEvictionNotice(null);
      setAnalyzerLoadError(null);
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
        if (sidecarHadModel) setAnalyzerEvictionNotice('Voice engine unloaded to free VRAM for the analyzer.');
      } catch {}
      /* loadAnalyzer's HTTP-level failures land in the result body
         (status:'error') with a 5xx — only fetch-itself failures throw.
         Check both paths so a silent error doesn't strand the pill on
         "Loading…" until the probe ticks. */
      try {
        /* Warm the model the run will ACTUALLY execute on (per-run override or
           per-phase pick), not the server's configured default. Passing no model
           here is what made the view re-warm qwen behind a gemma run. */
        const result = await api.loadAnalyzer(runModelToWarm ? { model: runModelToWarm } : undefined);
        if (result.status === 'error') {
          setAnalyzerLoadError(result.error || 'Analyzer failed to load. Check Ollama is running.');
          setPendingAnalyzerPill(null);
        }
      } catch (e) {
        setAnalyzerLoadError(`Couldn't reach Ollama: ${(e as Error).message ?? 'fetch failed'}`);
        setPendingAnalyzerPill(null);
      }
      setAnalyzerProbeKey((k) => k + 1);
    } finally {
      inFlightAnalyzerOps.current -= 1;
    }
  };

  const handleStopAnalyzer = async () => {
    inFlightAnalyzerOps.current += 1;
    try {
      /* #1929: pending goes to 'unloading', not 'idle' — 'idle' invited a
         Load click against a model that hadn't actually unloaded yet while
         api.unloadAnalyzer() was still in flight. Left uncleared on success
         (mirrors doStop in use-tts-lifecycle.ts) — the /health poll's own
         guarded clear above is what confirms the transition. */
      setPendingAnalyzerPill('unloading');
      setAnalyzerEvictionNotice(null);
      setAnalyzerLoadError(null);
      try {
        const result = await api.unloadAnalyzer();
        if (result.status === 'error') {
          setAnalyzerLoadError(result.error || 'Analyzer failed to unload.');
          setPendingAnalyzerPill(null);
        }
      } catch (e) {
        setAnalyzerLoadError(`Couldn't reach Ollama: ${(e as Error).message ?? 'fetch failed'}`);
        setPendingAnalyzerPill(null);
      }
      setAnalyzerProbeKey((k) => k + 1);
    } finally {
      inFlightAnalyzerOps.current -= 1;
    }
  };

  /* Auto-warm the analyzer on arrival when:
       1. there's a manuscript to analyse (skip pre-import screens),
       2. the selected engine is local,
       3. we've probed Ollama and the RUN model is NOT resident,
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
    if (!ollamaHealth) return; // probe still pending
    if (ollamaHealth.status !== 'reachable') return;
    if (runModelsResident) return; // the RUN model is already warm
    if (pendingAnalyzerPill) return; // a Load is already in flight
    if (autoLoadFiredRef.current) return; // one-shot per mount
    autoLoadFiredRef.current = true;
    void handleLoadAnalyzer();
    /* handleLoadAnalyzer is recreated each render; the autoLoadFiredRef guard
       already makes this one-shot, so listing it would only churn re-runs. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manuscriptId, isLocalAnalyzer, ollamaHealth, runModelsResident, pendingAnalyzerPill]);

  const isAnalysisRunning = conn === 'streaming' || conn === 'connecting';
  /* #3435 decision A — Retry is disabled while a main run is live: this view's
     own main stream (conn is also 'connecting'/'streaming' during a Retry, so
     that case is excluded), or a live main snapshot from anywhere. */
  const retryBlockedByMain = (isAnalysisRunning && retryingChapterId === null) || mainAnalysisLive;
  const shrinkAcceptBlocked = stage1ShrinkInfo?.retryChapterId !== undefined && retryBlockedByMain;
  /* Single source of truth for the Pause/Resume/Start cycle. Both the
     original header button (inside the centred column) and the new
     `<StickyAnalysisBar/>` (which pins on scroll) call this — keeping
     them in lockstep means there's no chance of one button showing
     "Pause" while the other shows "Resume". */
  const handlePauseOrResume = () => {
    if (isAnalysisRunning) {
      analysisControllerRef.current?.abort();
      if (manuscriptId) dispatch(analysisActions.setPaused({ manuscriptId }));
      setAnalysisStarted(false);
      setConn('idle');
      /* #3435 (C-8) — a Pause is a run ending this view observes (its own
         catch returns early on the cancelled fetch): re-read the facts. */
      setBookStateRefreshKey((k) => k + 1);
    } else {
      /* #3435 — this click IS the resume: disarm the auto-resume first, or it
         sees analysisStarted turn true in the same commit and fires a second
         main POST. */
      setCastIncomplete(false);
      setAnalysisStarted(true);
      setResuming(false);
      setRetry((r) => ({ nonce: r.nonce + 1, fresh: false }));
    }
  };

  /* #3435 — the book-state facts. Until the GET answers (or from a server
     that predates them) the roster counts as final unless this session's run
     ended cast_incomplete. */
  const stage1Ready = bookFacts?.stage1Ready ?? !castIncomplete;
  const resumeRequired = bookFacts?.resumeRequired === true;
  /* #3435 — the one line of "what now" under the phase list: a start the server
     refused (its message), else the halted snapshot's reason for a
     not-a-failure stop, else — after a reload or a dropped snapshot — the
     book-state's resumeRequired. The shrink banner below already says its own
     stop, so that one is not repeated here. */
  const haltNeedsActionMessage =
    activeStreamSnapshot &&
    activeStreamSnapshot.manuscriptId === manuscriptId &&
    activeStreamSnapshot.state === 'halted' &&
    isNotAFailureHaltCode(activeStreamSnapshot.haltCode) &&
    !stage1ShrinkInfo
      ? (activeStreamSnapshot.haltReason ?? null)
      : null;
  const resumeRequiredMessage =
    resumeRequired && !isAnalysisRunning
      ? 'Some chapters still need attribution — resume the analysis to finish the book.'
      : null;
  const needsActionMessage = startRefusal ?? haltNeedsActionMessage ?? resumeRequiredMessage;
  const failedPanel = failedPanelCopy(failedChapters, stage1Ready);

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex flex-col items-center px-6 py-16">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-60 pointer-events-none" />
      {/* Sticky bar lives only while the SSE is in flight. Outside the
          streaming/connecting window the inline header button handles
          Start / Resume — never two surfaces competing for the same
          affordance. Mounted directly under the outer flex container
          (not nested inside its own positioned wrapper) so the sticky
          bar's containing block is the full-height analysing view, not a
          tiny wrapper — without this, the bar would scroll off because
          its containing block had nothing left to scroll WITHIN. */}
      {manuscriptId && isAnalysisRunning && (
        <StickyAnalysisBar
          activePhaseId={phase}
          conn={conn}
          isRunning={isAnalysisRunning}
          hasStartedOnce={hasStartedOnceRef.current}
          isAnalyzerReady={isAnalyzerReady}
          onPauseOrResume={handlePauseOrResume}
        />
      )}
      <div className="relative max-w-2xl w-full">
        <div className="text-center mb-10">
          <SectionLabel>Analysing</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="Reading" bold={title || 'your manuscript'} />
          </div>
          <p className="mt-4 text-ink/70">
            {remainingMs !== null
              ? describeRemaining(remainingMs, wordCount)
              : describeSize(wordCount)}
          </p>
          <p className="mt-2 text-sm text-ink/50">{MANIFESTO}</p>
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
          {/* Inline Start/Resume button. Hidden while the SSE is in flight —
              the sticky bar's Pause button takes over once isAnalysisRunning
              is true (the two surfaces are mutually exclusive by design,
              never duplicate). */}
          {manuscriptId &&
            conn !== 'done' &&
            !isAnalysisRunning &&
            (() => {
              const isRunning = false;
              const label = isAnalyzerReady
                ? hasStartedOnceRef.current || resumeRequired
                  ? 'Resume analysis'
                  : 'Start analysis'
                : 'Waiting for analyzer…';
              const onClick = handlePauseOrResume;
              const disabled = !isRunning && !isAnalyzerReady;
              return (
                <div className="mt-6 flex flex-col items-center gap-2">
                  {/* fs-65 Task 12 — Expressive directions toggle (eager default ON).
                      Hidden when bookId is null (setProsodyEnabled needs a non-null id).
                      Minimum 44px touch target on phone per mobile rule. */}
                  {bookId != null && (
                    <Checkbox
                      id="prosody-toggle"
                      className="max-w-sm w-full px-1"
                      checked={prosodyStored !== false}
                      onChange={(value) => {
                        dispatch(bookMetaActions.setProsodyEnabled({ bookId: bookId, value }));
                        void api.putBookState(bookId, {
                          slice: 'state',
                          patch: { prosodyEnabled: value },
                        });
                      }}
                      label="Expressive directions"
                      labelClassName="text-sm font-medium text-ink"
                      description="Generate per-line emotion + delivery directions for the higher-quality (1.7B) voice. Runs in the background after analysis."
                    />
                  )}
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
                      {pendingAnalyzerPill === 'loading'
                        ? ' Loading now…'
                        : ' Click Load above to warm it.'}
                    </p>
                  )}
                </div>
              );
            })()}
          {manuscriptId && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
              {!isLocalAnalyzer && <ConnPill state={conn} sinceLastSec={sinceLastSec} />}
              {/* Per-phase model chips + swap dropdowns live inside each
                  PhaseCard (plan 95). The legacy single-`<select>` picker
                  that used to live here wrote to ui.selectedModel and bumped
                  the retry nonce on every change; per-phase pickers are a
                  per-run-only pick (#3141 step 5, ui.analyzerPhasePicks),
                  never persisted to UserSettings, sent on the next start
                  request, no in-flight abort. */}
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
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {analyzerEvictionNotice}
            </p>
          )}
          {analyzerLoadError && (
            <p
              className="mt-3 inline-flex items-start gap-2 text-[11px] text-rose-700 max-w-prose mx-auto text-left"
              role="alert"
            >
              <span className="w-1.5 h-1.5 mt-1 rounded-full bg-rose-500 shrink-0" />
              <span>{analyzerLoadError}</span>
              <button
                type="button"
                onClick={() => setAnalyzerLoadError(null)}
                aria-label="Dismiss error"
                className="ml-1 text-rose-600/70 hover:text-rose-800"
              >
                <IconClose className="w-3 h-3" />
              </button>
            </p>
          )}
          {!manuscriptId && (
            <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-amber-900">No manuscript loaded</p>
              <p className="mt-1 text-sm text-amber-800">
                The browser tab lost its in-progress upload (page refresh, a URL pasted directly, or
                an opened book whose <code>state.json</code> is missing a <code>manuscriptId</code>
                ). Re-open the book from the library to resume, or import a fresh manuscript.
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
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-semibold text-ink/80 hover:bg-ink/4"
                >
                  Back to library
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-red-900">
                {error.code === 'daily_quota' || error.code === 'analyzer-daily-quota'
                  ? 'Daily free-tier quota exhausted'
                  : 'Analysis failed'}
              </p>
              <p className="mt-1 text-sm text-red-800 wrap-break-word">{error.message}</p>
              {error.remediation && (
                <p className="mt-1 text-sm text-red-800/90 wrap-break-word">
                  <span className="font-semibold">What to do:</span> {error.remediation}
                  {isHelpLinkable(error.code) && helpHrefForFailureCode(error.code) && (
                    <>
                      {' '}
                      <a
                        href={helpHrefForFailureCode(error.code)!}
                        className="underline font-semibold text-magenta hover:text-magenta/80"
                      >
                        More help
                      </a>
                    </>
                  )}
                </p>
              )}
              {error.fixes && error.fixes.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-semibold text-red-900">How to fix:</p>
                  <FailureFixList fixes={error.fixes} className="flex flex-col gap-1" />
                </div>
              )}
              {error.detail && (
                <details className="mt-2 text-xs text-red-800/90">
                  <summary className="cursor-pointer font-medium hover:text-red-900">
                    Show upstream detail
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-red-100/60 p-3 text-[11px] font-mono whitespace-pre-wrap wrap-break-word">
                    {error.detail}
                  </pre>
                </details>
              )}
              {(error.code === 'daily_quota' || error.code === 'analyzer-daily-quota') && (
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
                    className="px-3 py-1.5 rounded-full border border-red-300/60 bg-white text-xs font-medium text-ink focus:outline-hidden focus:ring-2 focus:ring-red-400/40"
                  >
                    {analyzerModelGroups.map((g) => (
                      <optgroup key={g.engine} label={g.label}>
                        {g.models.map((m) => (
                          <option key={m.id} value={m.id} title={m.hint}>
                            {m.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <AnalyzerModelOverrideBadge />
                <button
                  onClick={() => setRetry((r) => ({ nonce: r.nonce + 1, fresh: false }))}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink/90"
                >
                  <IconRefresh className="w-3.5 h-3.5" /> Try again
                </button>
                <button
                  onClick={() => {
                    if (
                      confirm('Discard all cached progress for this manuscript and start over?')
                    ) {
                      setRetry((r) => ({ nonce: r.nonce + 1, fresh: true }));
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-red-300/60 bg-white text-red-700 text-xs font-semibold hover:bg-red-50"
                >
                  Start fresh
                </button>
              </div>
              <p className="mt-2 text-xs text-red-700/70">
                Try again resumes from the first uncached chapter. Start fresh discards all cached
                progress and re-runs stage 1.
              </p>
            </div>
          )}
          {!error && haltFixes && haltFixes.length > 0 && (
            /* #3084 F7 — run-level survival path: this run failed (or was
               rejoined after a reload) while the user was elsewhere, so the
               inline block above never mounted. The halted-run snapshot still
               carries the fixes, so they render here instead — same list
               renderer, same call to action.
               Gated on `!error` so the two blocks can never both render the
               same list: when `error` is set, its inline copy is authoritative.
               `haltFixes` (not the raw `activeStream` read) is what keeps this
               render honest — see its definition for the three guards, the
               `cast_incomplete`/`stage1_shrink_refused` exclusion in
               particular. */
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-rose-900">How to fix:</p>
              <FailureFixList fixes={haltFixes} className="mt-1 flex flex-col gap-1" />
            </div>
          )}
        </div>

        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-ink/60 mb-2">
            <span>Overall</span>
            <span className="tabular-nums font-semibold text-ink">
              {Math.round(overall * 100)}%
            </span>
          </div>
          <div className="relative h-2 rounded-full bg-ink/6 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-gradient-progress rounded-full"
              style={{ width: `${overall * 100}%` }}
            >
              <div className="absolute inset-0 stripe-travel" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card divide-y divide-ink/5">
          {ANALYSIS_PHASES.map((p) => {
            const phaseState = derivePhaseState(p.id, {
              progressByPhase,
              liveByPhase,
              maxPhase: phase,
              /* An idle page (never started, no rehydrated snapshot) must not
                 render phase 0 as active just because it's the pipeline
                 frontier (#3169) — analysisStarted covers the explicit-click/
                 retry/demo-capture/cold-boot-running paths, resuming covers
                 the #865 reload bridge, and hasStartedOnceRef covers a
                 cold-boot rehydrate of a paused/halted snapshot so those
                 still render exactly as they do today. activeStreamSnapshot
                 (the same cross-navigation signal the rehydrate effect above
                 acts on) is ALSO checked directly rather than relying solely
                 on hasStartedOnceRef: that ref is written by the rehydrate
                 effect with no setState, so on the very first render it
                 hasn't re-rendered yet and `started` would read false —
                 correcting only once some unrelated effect happens to
                 re-render. Reading the selector value instead is present
                 on the first render, so a cold-boot paused/halted snapshot
                 never produces a pending flash. A lingering snapshot for
                 this manuscript is always running/paused/halted — a
                 completed run's snapshot is torn down via
                 clearActiveStream, so this can't wrongly mark a
                 never-started view as started.
                 F3 (#3169 fix wave) — `!!manuscriptId &&` guards against
                 both sides being `undefined`: with no `manuscriptId` prop
                 and no snapshot, the bare `===` read `undefined ===
                 undefined` as true, rendering an idle view as active. The
                 rehydrate effect this comment says it mirrors already
                 returns early on `!manuscriptId` — this term
                 needs the same guard to actually mirror it. */
              started:
                analysisStarted ||
                resuming ||
                hasStartedOnceRef.current ||
                (!!manuscriptId && activeStreamSnapshot?.manuscriptId === manuscriptId),
              runState:
                activeStreamSnapshot && activeStreamSnapshot.manuscriptId === manuscriptId
                  ? activeStreamSnapshot.state === 'halted' &&
                    isNotAFailureHaltCode(activeStreamSnapshot.haltCode)
                    ? 'needs-action'
                    : activeStreamSnapshot.state ?? 'running'
                  : 'running',
            });
            return (
              <PhaseCard
                key={p.id}
                phase={p}
                activePhaseId={phase}
                isPhaseActive={phaseState === 'active'}
                isPhaseDone={phaseState === 'done'}
                isPhasePaused={phaseState === 'paused'}
                isPhaseHalted={phaseState === 'halted'}
                isPhaseNeedsAction={phaseState === 'needs-action'}
                phaseProgress={progressByPhase[p.id] ?? 0}
                phaseLogs={logs[p.id] ?? []}
                live={liveByPhase[p.id] ?? null}
                heartbeat={heartbeatByPhase[p.id]}
                throttle={throttleByPhase[p.id]}
                serverModelByPhase={serverModelByPhase}
                isLocalAnalyzer={isLocalAnalyzer}
                analysisStarted={analysisStarted}
                conn={conn}
                isResuming={resuming}
                bookId={bookId}
                droppedQuotesRefreshKey={droppedQuotesRefreshKey}
                manuscriptId={manuscriptId}
              />
            );
          })}
        </div>

        {needsActionMessage && <NeedsActionLine message={needsActionMessage} />}

        {/* Stage 1 shrink-refused banner. The server refused to overwrite
            a non-trivial cached roster with a much smaller one — usually
            a sign that a follow-up run with a worse model (or a chapter
            re-parse) would silently lose detected characters. The user
            can opt in via "Accept smaller roster", which re-fires the
            analysis with allowStage1Shrink:true. */}
        {stage1ShrinkInfo && (
          <div
            className="mt-6 rounded-3xl border border-amber-300 bg-amber-50 px-6 py-4"
            data-testid="stage1-shrink-refused-banner"
          >
            <p className="text-sm font-semibold text-amber-900">
              Refusing to shrink the cast roster
            </p>
            <p className="mt-1 text-xs text-amber-800/80">
              The previous run detected{' '}
              <span className="font-semibold">{stage1ShrinkInfo.prev} characters</span>, and the new
              run would replace it with{' '}
              <span className="font-semibold">{stage1ShrinkInfo.next}</span>. This usually means a
              worse model collapsed the cast (or the manuscript was re-parsed and quotes no longer
              match). The existing roster is preserved on disk — you can try a different model, or
              accept the smaller roster if it's what you want.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  /* #3435 — a Retry's shrink re-runs that chapter's subset (its
                     Phase 0 runs again, an accepted cost); a main shrink re-fires
                     the main run. */
                  if (stage1ShrinkInfo.retryChapterId !== undefined) {
                    const id = stage1ShrinkInfo.retryChapterId;
                    setStage1ShrinkInfo(null);
                    handleRetryChapter(id, { allowStage1Shrink: true });
                    return;
                  }
                  setRetry((r) => ({ nonce: r.nonce + 1, fresh: false, allowStage1Shrink: true }));
                }}
                /* #3435 — a Retry's Accept starts a subset run, which the server
                   refuses beside a live main run: disabled like Retry. */
                disabled={shrinkAcceptBlocked}
                title={shrinkAcceptBlocked ? 'Pause the analysis first' : undefined}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-ink text-canvas hover:bg-ink/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Accept smaller roster ({stage1ShrinkInfo.next} characters)
              </button>
              <button
                type="button"
                onClick={() => setStage1ShrinkInfo(null)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 hover:bg-amber-200 transition-colors"
              >
                Dismiss
              </button>
            </div>
            {shrinkAcceptBlocked && <p className="mt-2 text-xs text-amber-800/80">Pause the analysis first</p>}
          </div>
        )}

        {/* Failed-chapter retry panel. Survives reload via book-state
            hydration (see the failed-chapters effect above).
            Refuse until paused (#3435): Retry is disabled while the main
            run is live — see handleRetryChapter for why the two runs must
            never write the book at once. Only one chapter can be in flight
            at a time (retryingChapterId tracks the active one). */}
        {failedChapters.length > 0 && (
          <div className="mt-6 rounded-3xl border border-amber-200 bg-amber-50/60 px-6 py-4">
            <p className="text-sm font-semibold text-amber-900">{failedPanel.heading}</p>
            <p className="mt-1 text-xs text-amber-800/80">{failedPanel.subtext}</p>
            <ul className="mt-3 space-y-2">
              {failedChapters.map((f) => {
                const isRetrying = retryingChapterId === f.chapterId;
                const anotherRetryInFlight = retryingChapterId !== null && !isRetrying;
                const disabled = isRetrying || anotherRetryInFlight || retryBlockedByMain;
                const title = chapterTitleById[f.chapterId] ?? `Chapter ${f.chapterId}`;
                /* #3435 (A10) — without a final roster a Retry cannot attribute
                   (it would only re-detect the cast and end resume_required), so
                   an attribution row waits for the main resume instead. */
                const waitsForResume = (f.phase ?? 'cast') === 'attribution' && !stage1Ready;
                return (
                  <li
                    key={f.chapterId}
                    className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 border border-amber-200/70"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-ink truncate" title={title}>
                        {title}
                      </p>
                      {failedPanel.mixed && (
                        <p className="text-[11px] font-medium uppercase tracking-wide text-ink/50">
                          {(f.phase ?? 'cast') === 'cast' ? 'Cast detection' : 'Speaker attribution'}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs text-ink/60 wrap-break-word">{f.message}</p>
                      {waitsForResume && (
                        <p className="mt-1 text-xs text-amber-900/90">
                          Attributed when you resume the analysis.
                        </p>
                      )}
                      {f.remediation && (
                        <p className="mt-1 text-xs text-amber-900/90 wrap-break-word">
                          <span className="font-semibold">What to do:</span> {f.remediation}
                          {isHelpLinkable(f.code) && helpHrefForFailureCode(f.code) && (
                            <>
                              {' '}
                              <a
                                href={helpHrefForFailureCode(f.code)!}
                                className="underline font-semibold text-magenta hover:text-magenta/80"
                              >
                                More help
                              </a>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                    {!waitsForResume && (
                      <button
                        type="button"
                        onClick={() => handleRetryChapter(f.chapterId)}
                        disabled={disabled}
                        title={retryBlockedByMain ? 'Pause the analysis first' : undefined}
                        className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                          disabled
                            ? 'bg-ink/10 text-ink/40 cursor-not-allowed'
                            : 'bg-ink text-canvas hover:bg-ink/90'
                        }`}
                      >
                        <IconRefresh className="w-3.5 h-3.5" />
                        {isRetrying ? 'Retrying…' : 'Retry chapter'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {retryBlockedByMain && (
              <p className="mt-2 text-xs text-amber-800/80">Pause the analysis first</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
