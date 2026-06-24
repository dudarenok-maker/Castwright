import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { helpHrefForFailureCode } from '../lib/router';
import { MANIFESTO } from '../lib/brand';
import {
  IconPlay,
  IconPause,
  IconCheck,
  IconSpinner,
  IconWarning,
  IconArrowDn,
  IconRefresh,
  IconClose,
  IconHistory,
  IconClock,
  IconPencil,
  IconSparkle,
} from '../lib/icons';
import { SectionLabel, MixedHeading, Pill, ColorDot } from '../components/primitives';
import { Stat } from '../components/stat-tiles';
import { ModelControlPill } from '../components/ModelControlPill';
import { selectEnginesInUse } from '../store/engines-in-use-selector';
import type { LayoutContext } from '../components/layout';
import type { TtsLifecycle } from '../lib/use-tts-lifecycle';

/* Fallback used only when GenerationView is mounted outside a Layout
   (today: the cross-book Generate title regression test that bypasses
   the Layout wrapper). Inert state, no-op handlers. Real call sites
   always come through Layout → outlet context. */
const INERT_ENGINE_LIFECYCLE = {
  state: 'unreachable' as const,
  onLoad: async () => {},
  onStop: async () => {},
};
const INERT_TTS_LIFECYCLE: TtsLifecycle = {
  coqui: INERT_ENGINE_LIFECYCLE,
  kokoro: INERT_ENGINE_LIFECYCLE,
  qwen: INERT_ENGINE_LIFECYCLE,
  qwen1_7b: INERT_ENGINE_LIFECYCLE,
  asr: { enabled: false, state: 'idle', device: null },
  evictionNotice: null,
  loadErrorNotice: null,
  dismissNotices: () => {},
};
import { ConfirmDialog } from '../modals/confirm-dialog';
import { EditChapterTitleModal } from '../modals/edit-chapter-title';
import { useAppDispatch, useAppSelector } from '../store';
import { chaptersActions, STALL_THRESHOLD_MS } from '../store/chapters-slice';
import { castActions } from '../store/cast-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { analysisActions } from '../store/analysis-slice';
import { uiActions } from '../store/ui-slice';
import { bookMetaActions, selectLiveInstruct } from '../store/book-meta-slice';
import { selectGenerationActivityCount } from '../store/queue-slice';
import { enqueueQueueEntries } from '../store/queue-thunks';
import { api, AnalysisError } from '../lib/api';
import { useLocalAnalyzerGuard } from '../hooks/use-local-analyzer-guard';
import { useReverseLocalAnalyzerGuard } from '../hooks/use-reverse-local-analyzer-guard';
import { ANALYSIS_PHASES } from '../data/analysis-phases';
import { engineForModelId } from '../lib/models';
import { ttsModelLabel, formatEngineBreakdown } from '../lib/tts-models';
import { parseDuration, formatTime } from '../lib/time';
import { CHAR_COLORS } from '../lib/colors';
import { deriveIssues } from '../lib/chapter-issues';
import { Waveform } from '../components/waveform';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import {
  isChapterStaleFromReassign,
  isChapterReassignedSinceRender,
} from '../lib/stale-chapters';
import {
  characterLinePositionsByChapter,
  characterRowProgress,
  characterSentenceIdsByChapter,
  characterStatsByChapter,
  overallProgress,
  sentencesPerChapter,
} from '../lib/generation-progress';
import { relativeTime, withRecomputedDisplay } from '../lib/change-log';
import { computeReanalyseProgress, formatElapsed } from '../lib/reanalyse-progress';
import { LOG_TYPES } from '../data/log-types';
import type {
  Chapter,
  Character,
  CharColor,
  ChapterAudio,
  ChangeLogEvent,
  TtsModelKey,
} from '../lib/types';

const ACTIVITY_FEED_TYPES: ChangeLogEvent['type'][] = [
  'regenerate',
  'chapter_complete',
  'chapter_failed',
  'generation_started',
];

/* A chapter whose voices span more than one TTS engine (e.g. narrator on
   Kokoro + dialogue on Qwen, per-character routing plan 108). Such a chapter
   can't be reduced to a single drift comparison, so the row shows a per-engine
   voice-count breakdown instead of a drift warning (false-drift fix). */
function isMixedEngineChapter(chapter: Chapter): boolean {
  return Object.keys(chapter.audioEngines ?? {}).length > 1;
}

/* Transient per-chapter state for an in-flight "Include in book" subset
   analysis. Lives only while the SSE is streaming — drops on success,
   on cancel, or when the user clicks Retry. The error variant keeps
   the entry around so the row can offer Retry without losing the
   message. */
interface SubsetProgress {
  chapterId: number;
  phaseId: 0 | 1;
  phaseLabel: string;
  /** Display fraction shown on the bar — mapped (see lib/reanalyse-progress.ts),
      NOT the server's coarse value, so a single-chapter run actually moves. */
  progress: number;
  /** Server's coarse phase progress (0..1), kept to detect phase completion. */
  serverProgress: number;
  /** Heartbeat's per-call elapsed ms — drives the intra-phase ease + live readout. */
  phaseElapsedMs: number;
  /** Heartbeat throughput, for the live "N chars/s" readout. */
  charsPerSec: number;
  throttle: { until: number; reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after'; model: string } | null;
  error: string | null;
  controller: AbortController;
}

interface Props {
  chapters: Chapter[];
  characters: Character[];
  paused: boolean;
  title?: string | null;
  bookId: string;
  modelKey: TtsModelKey;
  onRegenerate: (ch: Chapter) => void;
  /** Header "Regenerate" entry-point shown when every chapter is done.
      Defaults the modal to scope='forward' from chapter 1, i.e. the whole
      book. The view doesn't know which chapter is "current" once the queue
      is drained, so a single book-level CTA is the right affordance. */
  onRegenerateBook: () => void;
  onRegenerateCharacterInChapter: (charId: string, chapterId: number) => void;
  onPreview: (chapterId: number) => void;
}

export function GenerationView({
  chapters,
  characters,
  paused,
  title,
  bookId,
  modelKey,
  onRegenerate,
  onRegenerateBook,
  onRegenerateCharacterInChapter,
  onPreview,
}: Props) {
  const dispatch = useAppDispatch();
  const lastError = useAppSelector((s) => s.chapters.lastError);
  const generationStartedAt = useAppSelector((s) => s.chapters.generationStartedAt);
  const lastTickAt = useAppSelector((s) => s.chapters.lastTickAt);
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const manuscriptId = useAppSelector((s) => s.manuscript.manuscriptId);
  const activityEvents = useAppSelector((s) => s.changeLog.events);
  /* #650 — render-time sentence→speaker map per chapter, for the PRECISE
     reassignment-staleness diff (vs the time-based change-log fallback). */
  const renderedSpeakersByChapter = useAppSelector(
    (s) => s.chapters.renderedSpeakersByChapter,
  );
  /* Drives the "View queue · N" pill in the header. Reflects real workspace
     queue entries when present, else the live generation run (the primary,
     reconcile-driven path never writes a queue entry) so the pill doesn't read
     0 / vanish while a book is visibly generating. */
  const activityCount = useAppSelector(selectGenerationActivityCount);
  /* fs-57 — per-book live-instruct flag. Defaults false (absent on older books).
     Dispatching setLiveInstruct also fires a persistence-middleware PUT via the
     'bookMeta/setLiveInstruct' rule. selectLiveInstruct is keyed by bookId so
     switching books always reflects the correct per-book value. */
  const liveInstruct = useAppSelector(selectLiveInstruct(bookId));
  /* Plan 102 — Generate view scroll consumer. ui.stage.currentChapterId
     is set by the queue modal's "Jump to chapter" affordance (modal pushes
     #/books/<bookId>/generate?chapter=<id>); we scroll the chapter row
     into view here so the user lands at the right card instead of the
     top of the chapter list. */
  const currentChapterId = useAppSelector((s) =>
    s.ui.stage.kind === 'ready' ? s.ui.stage.currentChapterId : null,
  );
  useEffect(() => {
    if (currentChapterId == null) return;
    const el = document.getElementById(`chapter-${currentChapterId}`);
    if (!el) return;
    /* Defer a frame so any layout shift from view-switch settles before
       the scroll fires; without this, the target row is sometimes still
       being laid out and the scroll lands a few hundred pixels short. */
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [currentChapterId]);
  /* Default analyzer engine used by the subset retry below (un-exclude
     path). Read at click time, not memoised, so a model switch between
     un-excludes is reflected on the next retry. */
  const selectedAnalyzerModelId = useAppSelector((s) => s.ui.selectedModel);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  /* Plan 78 — chapter rename modal state at the view level. One mount,
     opened/closed via the per-row Rename button. */
  const [renamingChapter, setRenamingChapter] = useState<Chapter | null>(null);
  /* Per-chapter subset-analysis state for the un-exclude flow. Lives only
     for the duration of the inline run — once the chapter transitions
     back to a normal queued row (or the user cancels) the entry is
     dropped. The un-exclude path is now a multi-phase streamed
     analysis and the user needs phase/progress/throttle/error
     feedback inline. */
  const [subsetByChapter, setSubsetByChapter] = useState<Record<number, SubsetProgress>>({});

  /* Guard for mid-generation TTS eviction. When the selected analyzer is
     local (Ollama) AND a generation stream is alive, clicking Include
     would silently load Ollama and evict the TTS sidecar. The hook
     short-circuits to a straight call-through for remote engines
     (Gemini), so this is a no-op unless both conditions hold. */
  const { guard, modal: analyzerGuardModal } = useLocalAnalyzerGuard({
    generatingBookTitle: title,
  });

  /* Reverse guard (plan 32, D2): when the user explicitly resumes TTS
     generation here AND a local analysis is running somewhere in the
     workspace, prompt before proceeding. The modal-only destructure (no
     `guard:`) reflects Wave 4a: the local Resume/Pause button moved to
     the queue modal, so the only caller of `guard` lives there now. The
     modal mount stays here because the prompt is rendered next to the
     Generate view's content. */
  const { modal: reverseGuardModal } = useReverseLocalAnalyzerGuard();

  const patchSubset = (chapterId: number, patch: Partial<SubsetProgress>) => {
    setSubsetByChapter((prev) => {
      const existing = prev[chapterId];
      if (!existing) return prev;
      return { ...prev, [chapterId]: { ...existing, ...patch } };
    });
  };

  /* Apply a phase or heartbeat tick to a subset row, recomputing the mapped
     display `progress` from the merged raw state (lib/reanalyse-progress.ts).
     `phaseElapsedMs` resets when the phase advances so each phase's ease starts
     from 0; `progress` is clamped non-decreasing so it never visibly rewinds. */
  const applySubsetTick = (
    chapterId: number,
    raw: {
      phaseId?: 0 | 1;
      serverProgress?: number;
      phaseElapsedMs?: number;
      charsPerSec?: number;
    },
  ) => {
    setSubsetByChapter((prev) => {
      const existing = prev[chapterId];
      if (!existing) return prev;
      const phaseChanged = raw.phaseId != null && raw.phaseId !== existing.phaseId;
      const phaseId = raw.phaseId ?? existing.phaseId;
      const phaseElapsedMs =
        raw.phaseElapsedMs != null ? raw.phaseElapsedMs : phaseChanged ? 0 : existing.phaseElapsedMs;
      const serverProgress = raw.serverProgress ?? existing.serverProgress;
      const mapped = computeReanalyseProgress({ phaseId, serverProgress, phaseElapsedMs });
      return {
        ...prev,
        [chapterId]: {
          ...existing,
          phaseId,
          phaseLabel: ANALYSIS_PHASES[phaseId]?.label ?? existing.phaseLabel,
          serverProgress,
          phaseElapsedMs,
          charsPerSec: raw.charsPerSec ?? existing.charsPerSec,
          progress: Math.max(existing.progress, mapped),
        },
      };
    });
  };

  async function handleToggleExcluded(chapterId: number, excluded: boolean): Promise<void> {
    /* Exclude direction — flip the flag and walk away. No analysis is
       needed; the server cleans up audio + segments and the slice resets
       transient generation state for the row. */
    if (excluded) {
      try {
        await api.setChapterExcluded(bookId, chapterId, true);
        dispatch(chaptersActions.setChapterExcluded({ chapterId, excluded: true }));
      } catch (e) {
        console.error('[generation] exclude failed', e);
      }
      return;
    }

    /* Un-exclude direction — POST exclude=false, then ALWAYS run subset
       analysis (Phase 0a + Phase 1) so the chapter's sentences land in
       manuscript.sentences, new characters land in cast, and the row's
       characters map populates. Without that triple-merge a chapter
       that was excluded at import has nothing for generation to
       synthesise. The subset route is cheap-ish on Gemini and worth the
       round-trip even for a previously-analysed chapter so the user
       doesn't have to reason about cache freshness vs. cast/manuscript
       edits made while the chapter was excluded. */
    if (!manuscriptId) return;
    /* Idempotency guard — a second click while subset analysis is in
       flight should do nothing rather than starting a parallel run.
       An errored entry doesn't block retry: handleRetrySubset relies
       on this so the user can re-fire the flow without a state-update
       microtask dance. */
    if (subsetByChapter[chapterId] && subsetByChapter[chapterId].error == null) return;

    const controller = new AbortController();
    setSubsetByChapter((prev) => ({
      ...prev,
      [chapterId]: {
        chapterId,
        phaseId: 0,
        phaseLabel: ANALYSIS_PHASES[0].label,
        progress: 0,
        serverProgress: 0,
        phaseElapsedMs: 0,
        charsPerSec: 0,
        throttle: null,
        error: null,
        controller,
      },
    }));

    /* Plan 32 follow-up: cross-navigation snapshot for the un-exclude
       subset retry. Without this, navigating away mid-retry drops the
       AnalysisPill and the middleware can't re-attach to the in-flight
       server job (it tries the main route's map, which is empty).
       Captured engine: ui.selectedModel — the analyzer that will
       handle this subset retry. */
    const engine = engineForModelId(selectedAnalyzerModelId);
    dispatch(
      analysisActions.setActiveStream({
        bookId,
        manuscriptId,
        bookTitle: title ?? undefined,
        engine,
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

    try {
      await api.setChapterExcluded(bookId, chapterId, false);
      dispatch(chaptersActions.setChapterExcluded({ chapterId, excluded: false }));

      const res = await api.runAnalysisForChapters(manuscriptId, [chapterId], {
        signal: controller.signal,
        onPhase: ({ phaseId, progress }) => {
          applySubsetTick(chapterId, { phaseId: phaseId as 0 | 1, serverProgress: progress });
          /* Snapshot tick — middleware uses this to attach a sticky
             subscriber against the subset route's in-flight map. */
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
        onHeartbeat: (hb) => {
          /* Live streaming tick — moves the bar within a phase (the server's
             coarse progress is frozen for a single-chapter subset) and feeds
             the elapsed / chars-per-sec readout. The slice tick carries the
             same elapsed so the global AnalysisPill maps identically. */
          applySubsetTick(chapterId, {
            phaseId: hb.phaseId as 0 | 1,
            phaseElapsedMs: hb.elapsedMs,
            charsPerSec: hb.charsPerSec,
          });
          dispatch(
            analysisActions.applyAnalysisSnapshotTick({
              manuscriptId,
              phaseId: hb.phaseId,
              phaseElapsedMs: hb.elapsedMs,
              lastTickAt: Date.now(),
            }),
          );
        },
        onCastUpdate: ({ characters }) => {
          dispatch(castActions.mergeCharacters(characters));
        },
        onThrottle: ({ model: throttleModel, waitMs, reason }) => {
          patchSubset(chapterId, {
            throttle: { until: Date.now() + waitMs, model: throttleModel, reason },
          });
        },
        onChapterFailed: ({ chapterId: failedId, message }) => {
          if (failedId === chapterId) {
            patchSubset(chapterId, { error: message });
          }
        },
      });

      /* Triple-slice merge — this is the load-bearing fix. Pre-fix only
         chaptersActions.mergeSubsetAnalysis was dispatched, so the new
         chapter's sentences never reached manuscript.sentences and
         audio generation had nothing to synthesise. */
      dispatch(castActions.mergeCharacters(res.characters ?? []));
      dispatch(chaptersActions.mergeSubsetAnalysis({ response: res, chapterIds: [chapterId] }));
      dispatch(manuscriptActions.hydrateFromAnalysis(res));

      setSubsetByChapter((prev) => {
        const { [chapterId]: _, ...rest } = prev;
        return rest;
      });
      /* Subset retry done — drop the snapshot so the AnalysisPill
         disappears. */
      dispatch(analysisActions.clearActiveStream());
    } catch (e) {
      /* AbortError = user clicked Cancel; any other error = subset
         analysis failed (network, analyzer offline, server-side
         exception). In both cases the chapter has been flipped to
         excluded=false on the server already, but its analysis is
         absent / partial. Roll the flag back so the chapter doesn't
         drift to an included-but-unanalysed state that no UI surfaces.
         The rollback is best-effort — if it fails the worst case is
         the chapter sticks around as queued-with-no-content until the
         user re-excludes it manually. */
      const isAbort =
        (e as Error)?.name === 'AbortError' || (e instanceof AnalysisError && e.code === 'aborted');
      await rollbackInclude(chapterId).catch((rollbackErr) => {
        console.warn('[generation] include rollback failed', rollbackErr);
      });
      /* Drop the snapshot on either abort or terminal failure — the
         server-side job already ended (abort) or surfaced an error,
         and the row's own error state inside subsetByChapter carries
         the message for the user. */
      dispatch(analysisActions.clearActiveStream());
      if (isAbort) {
        setSubsetByChapter((prev) => {
          const { [chapterId]: _, ...rest } = prev;
          return rest;
        });
        return;
      }
      const message = (e as Error).message || 'Subset analysis failed.';
      patchSubset(chapterId, { error: message });
    }
  }

  /* Re-exclude server-side AND in the slice to undo the optimistic
     un-exclude when an in-flight Include either failed or was
     cancelled. Kept separate from the main handler so the catch arm
     stays readable. */
  async function rollbackInclude(chapterId: number): Promise<void> {
    await api.setChapterExcluded(bookId, chapterId, true);
    dispatch(chaptersActions.setChapterExcluded({ chapterId, excluded: true }));
  }

  function handleCancelSubset(chapterId: number): void {
    const entry = subsetByChapter[chapterId];
    if (entry) entry.controller.abort();
  }

  function handleRetrySubset(chapterId: number): void {
    void handleToggleExcluded(chapterId, false);
  }

  function handleIncludeClick(chapterId: number): void {
    guard(() => {
      void handleToggleExcluded(chapterId, false);
    });
  }

  /* Re-analyse ONE already-included chapter in place (#518 / per-chapter
     reanalyse) — re-runs character detection + attribution for it via the same
     subset route the un-exclude flow uses, so the user never has to navigate to
     the analysing URL (which re-runs the WHOLE book). Designed voices are
     preserved server-side. Streaming + progress mirror `handleToggleExcluded`'s
     include branch, minus the exclude flip + rollback (the chapter stays
     included throughout). */
  async function handleReanalyse(chapterId: number): Promise<void> {
    if (!manuscriptId) return;
    if (subsetByChapter[chapterId] && subsetByChapter[chapterId].error == null) return;
    const controller = new AbortController();
    setSubsetByChapter((prev) => ({
      ...prev,
      [chapterId]: {
        chapterId,
        phaseId: 0,
        phaseLabel: ANALYSIS_PHASES[0].label,
        progress: 0,
        serverProgress: 0,
        phaseElapsedMs: 0,
        charsPerSec: 0,
        throttle: null,
        error: null,
        controller,
      },
    }));
    const engine = engineForModelId(selectedAnalyzerModelId);
    dispatch(
      analysisActions.setActiveStream({
        bookId,
        manuscriptId,
        bookTitle: title ?? undefined,
        engine,
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
    try {
      const res = await api.runAnalysisForChapters(manuscriptId, [chapterId], {
        signal: controller.signal,
        onPhase: ({ phaseId, progress }) => {
          applySubsetTick(chapterId, { phaseId: phaseId as 0 | 1, serverProgress: progress });
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
        onHeartbeat: (hb) => {
          /* Live streaming tick — moves the bar within a phase (the server's
             coarse progress is frozen for a single-chapter subset) and feeds
             the elapsed / chars-per-sec readout. The slice tick carries the
             same elapsed so the global AnalysisPill maps identically. */
          applySubsetTick(chapterId, {
            phaseId: hb.phaseId as 0 | 1,
            phaseElapsedMs: hb.elapsedMs,
            charsPerSec: hb.charsPerSec,
          });
          dispatch(
            analysisActions.applyAnalysisSnapshotTick({
              manuscriptId,
              phaseId: hb.phaseId,
              phaseElapsedMs: hb.elapsedMs,
              lastTickAt: Date.now(),
            }),
          );
        },
        onCastUpdate: ({ characters }) => {
          dispatch(castActions.mergeCharacters(characters));
        },
        onThrottle: ({ model: throttleModel, waitMs, reason }) => {
          patchSubset(chapterId, {
            throttle: { until: Date.now() + waitMs, model: throttleModel, reason },
          });
        },
        onChapterFailed: ({ chapterId: failedId, message }) => {
          if (failedId === chapterId) patchSubset(chapterId, { error: message });
        },
      });
      dispatch(castActions.mergeCharacters(res.characters ?? []));
      dispatch(chaptersActions.mergeSubsetAnalysis({ response: res, chapterIds: [chapterId] }));
      dispatch(manuscriptActions.hydrateFromAnalysis(res));
      setSubsetByChapter((prev) => {
        const { [chapterId]: _, ...rest } = prev;
        return rest;
      });
      dispatch(analysisActions.clearActiveStream());
    } catch (e) {
      const isAbort =
        (e as Error)?.name === 'AbortError' || (e instanceof AnalysisError && e.code === 'aborted');
      dispatch(analysisActions.clearActiveStream());
      if (isAbort) {
        setSubsetByChapter((prev) => {
          const { [chapterId]: _, ...rest } = prev;
          return rest;
        });
        return;
      }
      patchSubset(chapterId, { error: (e as Error).message || 'Re-analysis failed.' });
    }
  }

  /* Escape hatch for a chapter stuck showing "Queued" with no active run —
     e.g. one that failed before the durable failure-status landed, so the
     queue entry was long since cleared and nothing remembers it. A queued row
     otherwise only offers Rename/Exclude, leaving such a chapter unactionable.
     This directly enqueues a single-chapter entry (mirrors the drift-bulk
     enqueue above); the queue dispatcher claims it and opens the stream. We
     skip the reason-prompt RegenerateModal that `onRegenerate` opens because a
     never-rendered chapter has no prior render to "regenerate". */
  function handleGenerateChapter(ch: Chapter): void {
    /* Re-adding a "Not queued" (held) chapter clears the hold so the row leaves
       the "Not queued" state and the auto-work resume stops skipping it. Clear
       optimistically in the slice + persist; the enqueue below is what actually
       starts it. No-op for a normal queued chapter (never held). */
    if (ch.held) {
      dispatch(chaptersActions.setChapterHeld({ chapterId: ch.id, held: false }));
      void api.setChapterHeld(bookId, ch.id, false).catch(() => {
        /* best-effort: the chapter still enqueues; the hold reconciles on the
           next hydrate if the persist failed. */
      });
    }
    const rand = Math.random().toString(36).slice(2, 8);
    void dispatch(
      enqueueQueueEntries([
        { id: `generate-row-${bookId}-${ch.id}-${rand}`, bookId, chapterId: ch.id, scope: 'this' },
      ]),
    );
  }

  /* Manuscript-derived shape used both for accurate overall-progress
     weighting (so 3 hydrated-Done chapters don't collapse the bar to the
     in-flight chapter's progress) and for the per-character lines/words
     readout in the expanded chapter rows. */
  const manuscriptCounts = useMemo(() => sentencesPerChapter(sentences), [sentences]);
  const characterStats = useMemo(() => characterStatsByChapter(sentences), [sentences]);
  /* Per-character line positions inside each chapter — drives the truthful
     fractional bar in the expanded row instead of the slice's "active
     speaker only" status field. See generation-progress.ts. */
  const characterPositions = useMemo(() => characterLinePositionsByChapter(sentences), [sentences]);
  /* fs-13 — per-character sentence ids inside each chapter. Intersected with
     the chapter's live completed-id set for an EXACT per-character done count
     under out-of-order completion (the positions+currentLine map above is the
     fallback when the set is absent). */
  const characterSentenceIds = useMemo(() => characterSentenceIdsByChapter(sentences), [sentences]);
  /* #650 — the set of chapters whose live sentence→speaker mapping differs from
     what was rendered (precise reassignment staleness). Recomputed from the live
     manuscript, so it reflects an edit immediately without a refetch; only
     chapters the server shipped a render map for are considered here (others
     fall back to the time-based heuristic at the row). */
  const reassignedSinceRenderSet = useMemo(() => {
    const renderedIds = Object.keys(renderedSpeakersByChapter);
    if (renderedIds.length === 0) return new Set<number>();
    const byChapter = new Map<number, Array<{ id: number; characterId: string }>>();
    for (const s of sentences) {
      let arr = byChapter.get(s.chapterId);
      if (!arr) byChapter.set(s.chapterId, (arr = []));
      arr.push({ id: s.id, characterId: s.characterId });
    }
    const set = new Set<number>();
    for (const cidStr of renderedIds) {
      const cid = Number(cidStr);
      if (isChapterReassignedSinceRender(renderedSpeakersByChapter[cid], byChapter.get(cid) ?? [])) {
        set.add(cid);
      }
    }
    return set;
  }, [renderedSpeakersByChapter, sentences]);

  /* SSE ownership lives in src/store/generation-stream-middleware.ts so the
     stream survives navigating away from this view. The view is a pure
     renderer of slice state now. */

  /* Counters and "all complete" math operate on the active subset —
     excluded chapters don't queue, don't generate, and shouldn't count
     against (or for) completion. Without this an 8-of-10-completed book
     with 2 excluded would never reach allComplete. */
  const activeChapters = useMemo(() => chapters.filter((c) => !c.excluded), [chapters]);
  const completed = activeChapters.filter((c) => c.state === 'done').length;
  const failed = activeChapters.filter((c) => c.state === 'failed').length;
  const inProgressCnt = activeChapters.filter((c) => c.state === 'in_progress').length;
  /* `held` chapters carry state==='queued' under the hood but the user removed
     them from the queue ("Not queued"), so they must NOT count as queued work:
     this gates the Resume-generation button (so it doesn't re-enqueue them) and
     keeps the queued/“N pending” copy honest. They still sit in activeChapters,
     so a book with held chapters is correctly never "all complete". */
  const queued = activeChapters.filter((c) => c.state === 'queued' && !c.held).length;
  /* Engine drift (plan 35). A drifted chapter has audio recorded with a
     different TTS engine than the project's current selection — usually
     because the user changed the model picker after generation. The list
     drives the top-of-view banner (count + bulk-regen affordance), the
     per-row caption, and the bulk-regen confirm dialog's body copy. */
  const driftedChapters = useMemo(
    () =>
      activeChapters.filter(
        (c) =>
          c.state === 'done' &&
          c.audioModelKey != null &&
          c.audioModelKey !== modelKey &&
          /* A genuinely mixed-engine chapter (narrator on Kokoro + dialogue on
             Qwen) is intentional, not drift — it shows a per-engine breakdown
             caption instead, and must not inflate the drift banner/bulk-regen
             (false-drift fix, 2026-06-07). */
          !isMixedEngineChapter(c),
      ),
    [activeChapters, modelKey],
  );
  const driftedCount = driftedChapters.length;
  /* Distinct source engines seen across the drifted set. The common case
     is a single engine (user flipped one switch), but accumulated drift
     across multiple swaps can leave a mixed set — render both shapes
     gracefully in the confirm dialog. */
  const driftedSourceEngines = useMemo(
    () => Array.from(new Set(driftedChapters.map((c) => ttsModelLabel(c.audioModelKey!)))),
    [driftedChapters],
  );
  const [bulkRegenOpen, setBulkRegenOpen] = useState(false);
  /* Chapter pending a re-analyse confirmation (per-chapter reanalyse, #518). */
  const [reanalyseChapter, setReanalyseChapter] = useState<Chapter | null>(null);
  /* Used by the header action: Resume/Pause is meaningless once every chapter
     has finished synthesising, so the button flips to Regenerate. Failed
     chapters keep the Pause/Resume affordance because the user might still
     hit the per-row Retry to drive the queue. */
  const allComplete = activeChapters.length > 0 && completed === activeChapters.length;

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
  const needsClock = generationStartedAt != null || inProgressCnt > 0;
  useEffect(() => {
    if (!needsClock || paused) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [needsClock, paused]);
  const elapsedMs = generationStartedAt ? Date.now() - generationStartedAt : 0;
  const etaSec =
    generationStartedAt && totalProgress > 0.05 && totalProgress < 1
      ? ((elapsedMs / totalProgress) * (1 - totalProgress)) / 1000
      : null;

  /* Honest "runtime so far" — sum of completed chapter durations. Replaces
     the hardcoded "4h 38m". */
  const runtimeSec = chapters
    .filter((c) => c.state === 'done')
    .reduce((s, c) => s + parseDuration(c.duration), 0);

  const blocked = lastError != null;
  const engineLabel = ttsModelLabel(modelKey);

  /* "Stalled" = there's an in-progress chapter but the SSE has been silent
     for longer than STALL_THRESHOLD_MS. Reading `Date.now()` directly is fine
     because the ETA `forceTick` interval re-renders this view every second
     while a run is active, so the derived value updates without an extra
     timer. Cleared by every non-idle tick and by the slice on idle. */
  const stalledMs = lastTickAt && inProgressCnt > 0 && !paused ? Date.now() - lastTickAt : 0;
  const stalled = stalledMs > STALL_THRESHOLD_MS;
  const stalledSec = stalled ? Math.floor(stalledMs / 1000) : 0;

  /* `e.at` is the ISO timestamp set on every event the middleware or a
     user-confirm handler emits at runtime. Hand-authored fixture entries in
     src/data/change-log.ts omit it, so this filter keeps the sidebar honest
     — only real, this-session/this-book activity shows up; the demo seed
     stays out. */
  const recentActivity = useMemo(() => {
    const filtered = activityEvents.filter((e) => e.at && ACTIVITY_FEED_TYPES.includes(e.type));
    return withRecomputedDisplay(filtered).slice(0, 6);
  }, [activityEvents]);

  /* TTS pill state lives in a single Layout-owned `useTtsLifecycle()` call
     (plan 30 G1). Layout exposes it via LayoutContext so this view, the
     top-bar pill, and any future pill surface render the same state from
     a single 30s /health poll. The pill's Load click here and the
     top-bar's Load click are now the same action against the same
     in-memory state — no more 30s lag between surfaces.

     Fallback to an inert stub when this view is mounted outside a Layout
     (the cross-book title regression test, or any future ad-hoc mount):
     the pill renders as "unreachable", clicks are no-ops, and no /health
     poll fires. Real call sites always come through Layout. */
  const outletCtx = useOutletContext<LayoutContext | null>();
  const ttsLifecycle: TtsLifecycle = outletCtx?.ttsLifecycle ?? INERT_TTS_LIFECYCLE;
  const enginesInUse = useAppSelector(selectEnginesInUse);

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
    for (const ch of activeChapters) {
      const chTotal = ch.totalLines ?? manuscriptCounts[ch.id] ?? 0;
      total += chTotal;
      if (ch.state === 'done') done += chTotal;
      else if (ch.state === 'in_progress') done += ch.currentLine ?? 0;
    }
    return { done, total };
  }, [activeChapters, manuscriptCounts]);

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <div className="mb-6 sm:mb-8 flex flex-col md:flex-row md:items-end md:justify-between gap-4 sm:gap-6 md:flex-wrap">
        <div className="min-w-0">
          <SectionLabel>Audiobook generation</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Generating" bold={title || 'your audiobook'} level="h1" />
          </div>
          <p className="mt-3 text-ink/60">
            {completed} of {activeChapters.length} chapters complete
            {etaSec != null && <> · approx. {formatTime(etaSec)} remaining</>}
          </p>
          <p className="mt-1 text-sm text-ink/50">{MANIFESTO}</p>
          {linesCounter.total > 0 && (
            <p className="mt-1 text-xs text-ink/55 tabular-nums">
              <span className="font-semibold text-ink/75">
                {linesCounter.done.toLocaleString()}
              </span>{' '}
              of {linesCounter.total.toLocaleString()} lines synthesised
            </p>
          )}
          <p className="mt-1 text-xs text-ink/50 inline-flex items-center gap-2 flex-wrap">
            <span>
              Engine: <span className="font-medium text-ink/70">{engineLabel}</span>
            </span>
            {enginesInUse.has('kokoro') && (
              <ModelControlPill
                kind="tts"
                engineLabel="Kokoro"
                state={ttsLifecycle.kokoro.state}
                unreachableLabel="Voice engine not running"
                onLoad={() => {
                  void ttsLifecycle.kokoro.onLoad();
                }}
                onStop={() => {
                  void ttsLifecycle.kokoro.onStop();
                }}
              />
            )}
            {enginesInUse.has('coqui') && (
              <ModelControlPill
                kind="tts"
                engineLabel="Coqui XTTS"
                state={ttsLifecycle.coqui.state}
                unreachableLabel="Voice engine not running"
                onLoad={() => {
                  void ttsLifecycle.coqui.onLoad();
                }}
                onStop={() => {
                  void ttsLifecycle.coqui.onStop();
                }}
              />
            )}
          </p>
          {/* fs-57 — per-book live-instruct toggle. Only meaningful for
              1.7B-tier characters; shown for all books so the operator can
              flip it before starting generation. */}
          <label
            className="mt-2 flex items-center gap-2 cursor-pointer select-none min-h-[44px] sm:min-h-0"
            data-testid="live-instruct-toggle"
          >
            <input
              type="checkbox"
              checked={liveInstruct}
              onChange={(e) =>
                dispatch(bookMetaActions.setLiveInstruct({ bookId, value: e.target.checked }))
              }
              className="accent-magenta w-4 h-4 shrink-0"
            />
            <span className="text-xs text-ink/60 leading-snug">
              <span className="font-medium text-ink/75">
                Live expressive delivery (1.7B)
              </span>{' '}
              — re-render to hear it
              <span className="block text-ink/45 mt-0.5">
                Uses real-time instruct prompts to shape emotion + vocalizations on
                Qwen 1.7B characters. Has no effect on Kokoro or 0.6B voices.
              </span>
            </span>
          </label>
          {/* TTS Load/Stop notices (eviction + load error) now render once
              globally under the top bar via <TtsNoticeBanner> in layout.tsx —
              see that component for why. The inline copy was removed here to
              avoid a double render (both surfaces share the one
              useTtsLifecycle instance). */}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Plan 102 — header CTAs.
              - "View queue" replaces the old Resume/Pause toggle; pause moved
                to the queue modal (it's queue-global now, not per-book-active-
                handle).
              - "Regenerate" (allComplete branch) stays — it opens the per-
                chapter modal scoped to chapter 1 + forward (= whole book),
                whose onConfirm enqueues each chapter individually.
              - min-h-[44px] hits the ≥44px touch-target rule on phone. */}
          <button
            type="button"
            onClick={() => dispatch(uiActions.openQueueModal())}
            data-testid="generation-view-queue"
            aria-label={
              activityCount > 0 ? `View queue — ${activityCount} pending` : 'View queue'
            }
            className="min-h-[44px] px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2"
          >
            View queue{activityCount > 0 && <span className="text-magenta">· {activityCount}</span>}
          </button>
          {/* fe-17 — explicit one-click resume for an interrupted run. Plan 137
              made opening a book never auto-enqueue, so a book whose run was
              interrupted (queue drained server-side, chapters still `queued`)
              has no in-view way to continue. Shown only when there's queued
              work and nothing is in flight; it dispatches the same
              requestStartGeneration intent the "Approve cast & start
              generating" CTA uses. Hidden while a run is live, once every
              chapter is done (queued === 0), or while generation is halted on
              an error. */}
          {queued > 0 && inProgressCnt === 0 && !lastError && (
            <button
              type="button"
              onClick={() => dispatch(uiActions.requestStartGeneration())}
              data-testid="generation-view-resume"
              data-tour-id="generate-resume-btn"
              className="min-h-[44px] px-4 py-2.5 rounded-full border border-magenta/30 bg-magenta/5 text-sm font-medium text-magenta hover:bg-magenta/10 inline-flex items-center gap-2"
            >
              <IconPlay className="w-4 h-4" /> Resume generation
            </button>
          )}
          {allComplete && (
            <button
              onClick={onRegenerateBook}
              className="min-h-[44px] px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2"
            >
              <IconRefresh className="w-4 h-4" /> Regenerate
            </button>
          )}
        </div>
      </div>

      {lastError && (
        <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50/70 px-5 py-4 flex items-start gap-3 fade-in">
          <IconWarning className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-rose-900">Generation halted</p>
            <p className="text-sm text-rose-800/90 mt-0.5">{lastError}</p>
          </div>
          <button
            onClick={() => dispatch(chaptersActions.clearLastError())}
            aria-label="Dismiss generation error"
            className="grid place-items-center w-11 h-11 rounded-full text-rose-600/70 hover:text-rose-700 hover:bg-rose-100"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>
      )}

      {stalled && !lastError && (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50/70 px-5 py-4 flex items-start gap-3 fade-in">
          <IconClock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">Worker has gone quiet</p>
            <p className="text-sm text-amber-800/90 mt-0.5">
              No progress for {stalledSec}s. The voice engine may be synthesising a batch of lines or
              retrying — batched synthesis can run a while between updates — so give it a moment, or
              pause and resume to reset the stream.
            </p>
          </div>
        </div>
      )}

      {driftedCount > 0 && (
        /* Engine drift banner (plan 35). Counts chapters whose recorded
           audio engine differs from the project's current TTS model.
           The "Regenerate all" button bulk-re-queues every chapter in
           the drifted set through chaptersActions.regenerateChapterIds,
           which the middleware turns into a single fresh SSE with
           chapterIds + force=true. Per-row Regenerate still works for
           the surgical case. */
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50/70 px-5 py-4 flex items-start gap-3 fade-in">
          <IconWarning className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              {driftedCount} chapter{driftedCount === 1 ? '' : 's'} generated with a different
              engine
            </p>
            <p className="text-sm text-amber-800/90 mt-0.5">
              Current engine is <span className="font-medium">{ttsModelLabel(modelKey)}</span>.
              Drifted chapters keep their original voices until you regenerate them.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setBulkRegenOpen(true)}
            className="shrink-0 inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 rounded-full bg-amber-900/90 text-white text-xs font-semibold hover:bg-amber-900 transition-colors"
          >
            <IconRefresh className="w-3.5 h-3.5" /> Regenerate all
          </button>
        </div>
      )}

      <ConfirmDialog
        open={bulkRegenOpen}
        variant="danger"
        eyebrow="Regenerate"
        icon={<IconRefresh className="w-4 h-4" />}
        title={`Regenerate ${driftedCount} chapter${driftedCount === 1 ? '' : 's'} with ${ttsModelLabel(modelKey)}?`}
        body={
          <div className="space-y-3">
            <p>
              {driftedSourceEngines.length === 1 ? (
                <>
                  These chapters were rendered with{' '}
                  <span className="font-medium text-ink">{driftedSourceEngines[0]}</span>.
                </>
              ) : (
                <>
                  These chapters were rendered across{' '}
                  <span className="font-medium text-ink">{driftedSourceEngines.join(', ')}</span>.
                </>
              )}{' '}
              They will be re-synthesised on the current engine.
            </p>
            <p className="text-ink/60">
              Existing audio remains available until each new chapter completes.
            </p>
            {inProgressCnt > 0 && (
              <p className="text-amber-800">This will interrupt the current run.</p>
            )}
          </div>
        }
        confirmLabel={`Regenerate ${driftedCount === 1 ? '1 chapter' : `all ${driftedCount}`}`}
        cancelLabel="Cancel"
        onConfirm={() => {
          /* Plan 102 — drift bulk regen now enqueues one entry per
             drifted chapter (was: single regenerateChapterIds dispatch
             that hard-interrupted any in-flight chapter). Each entry
             rides through the queue dispatcher serially, so an
             in-flight chapter completes before the next drift target
             starts. Entry ids include a short rand suffix so two
             back-to-back drift runs in the same session don't collide
             on duplicate ids. */
          const rand = Math.random().toString(36).slice(2, 8);
          void dispatch(
            enqueueQueueEntries(
              driftedChapters.map((c) => ({
                id: `drift-bulk-${bookId}-${c.id}-${rand}`,
                bookId,
                chapterId: c.id,
                scope: 'this',
              })),
            ),
          );
          setBulkRegenOpen(false);
        }}
        onClose={() => setBulkRegenOpen(false)}
      />

      <ConfirmDialog
        open={reanalyseChapter !== null}
        eyebrow="Re-analyse"
        icon={<IconRefresh className="w-4 h-4" />}
        title={`Re-analyse "${reanalyseChapter?.title ?? ''}"?`}
        body={
          <div className="space-y-3">
            <p>
              Re-runs character detection and dialogue attribution for this chapter only — useful
              if its analysis came out wrong (duplicated or missing lines).
            </p>
            <p className="text-ink/60">
              Your designed character voices are preserved. Regenerate this chapter afterwards to
              hear the updated attribution.
            </p>
          </div>
        }
        confirmLabel="Re-analyse chapter"
        cancelLabel="Cancel"
        onConfirm={() => {
          const ch = reanalyseChapter;
          setReanalyseChapter(null);
          if (ch) void handleReanalyse(ch.id);
        }}
        onClose={() => setReanalyseChapter(null)}
      />

      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-4 sm:p-6 mb-6 sm:mb-8">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">Overall progress</p>
          <span className="text-sm font-bold text-ink tabular-nums">
            {Math.round(totalProgress * 100)}%
          </span>
        </div>
        <div className="relative h-3 rounded-full bg-ink/6 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-gradient-progress rounded-full transition-all"
            style={{ width: `${totalProgress * 100}%` }}
          >
            {!paused && <div className="absolute inset-0 stripe-travel" />}
          </div>
        </div>
        {/* 2×2 grid on phone (gap-3 keeps the numbers from jamming together
            at 375px), revert to four columns on sm and up. */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 pt-4 border-t border-ink/10">
          <Stat label="Completed" value={completed} />
          <Stat label="In progress" value={inProgressCnt} />
          <Stat label="Queued" value={queued} />
          <Stat label="Failed" value={failed} danger />
        </div>
      </div>

      {/* Wave-3 responsive layout: single column on phone + tablet (chapter
          list owns the whole width — Activity panel becomes a stacked footer
          card below), two-column with a narrower 280px side panel on `md:`
          tablets in landscape, full 320px sidebar restored on `lg:` desktop.
          Activity panel ordering swaps so the chapter list always stays
          first under the page header on every viewport. */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] lg:grid-cols-[1fr_320px] gap-4 sm:gap-6">
        <div className="space-y-3 min-w-0">
          {chapters.map((ch) => (
            <ChapterRow
              key={ch.id}
              chapter={ch}
              characters={characters}
              bookId={bookId}
              expanded={!!expanded[ch.id]}
              onToggle={() => setExpanded({ ...expanded, [ch.id]: !expanded[ch.id] })}
              paused={paused}
              blocked={blocked}
              stalled={stalled}
              charStats={characterStats[ch.id]}
              charPositions={characterPositions[ch.id]}
              charSentenceIds={characterSentenceIds[ch.id]}
              onRegenerate={onRegenerate}
              onReanalyse={(ch) => setReanalyseChapter(ch)}
              onGenerateChapter={handleGenerateChapter}
              onRegenerateCharacterInChapter={onRegenerateCharacterInChapter}
              onPreview={onPreview}
              onRename={setRenamingChapter}
              onToggleExcluded={handleToggleExcluded}
              onIncludeClick={handleIncludeClick}
              onCancelSubset={handleCancelSubset}
              onRetrySubset={handleRetrySubset}
              stale={
                /* OR-gate (fs-58 Task 3): stale if the precise render-map diff
                   flags a speaker change OR a post-render boundary_move was
                   logged (covers text/emotion edits the characterId-only precise
                   diff can't see — strip_tag / fix_emotion + the retained
                   split/extract piece). Intentionally conservative: a
                   move-then-undo still reads stale, trading that rare false
                   positive for catching edits that don't change characterIds. */
                (renderedSpeakersByChapter[ch.id] ? reassignedSinceRenderSet.has(ch.id) : false) ||
                isChapterStaleFromReassign(ch, activityEvents)
              }
              subsetProgress={subsetByChapter[ch.id] ?? null}
              activeModelKey={modelKey}
            />
          ))}
        </div>
        <aside className="lg:sticky lg:top-20 self-start bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          <header className="flex items-center justify-between px-5 py-4 border-b border-ink/10">
            <span className="text-sm font-semibold text-ink inline-flex items-center gap-2">
              <IconHistory className="w-4 h-4 text-ink/60" /> Activity
            </span>
            <a
              href={`#/books/${bookId}/log`}
              className="text-xs font-medium text-ink/55 hover:text-ink transition-colors"
            >
              View all →
            </a>
          </header>
          {recentActivity.length === 0 ? (
            <p className="px-5 py-6 text-xs text-ink/50">
              Activity from this generation run will appear here as chapters complete or fail.
            </p>
          ) : (
            <ul className="divide-y divide-ink/5">
              {recentActivity.map((e) => (
                <ActivityRow key={e.id} event={e} />
              ))}
            </ul>
          )}
        </aside>
      </div>

      <div className="mt-8 sm:mt-10 pt-6 border-t border-ink/10 flex items-center justify-between text-xs text-ink/50 flex-wrap gap-3">
        <div className="flex items-center gap-3 sm:gap-6 flex-wrap">
          <span>Output: MP3 (VBR V2)</span>
          <span className="hidden sm:inline">·</span>
          <span>
            Runtime so far:{' '}
            <span className="tabular-nums text-ink/70">
              {runtimeSec > 0 ? formatTime(runtimeSec) : '0:00'}
            </span>
          </span>
        </div>
      </div>
      {analyzerGuardModal}
      {reverseGuardModal}
      <EditChapterTitleModal
        key={renamingChapter?.id ?? 'closed'}
        open={renamingChapter !== null}
        bookId={bookId}
        chapter={renamingChapter}
        onClose={() => setRenamingChapter(null)}
      />
    </div>
  );
}

function ActivityRow({ event }: { event: ChangeLogEvent }) {
  const t = LOG_TYPES[event.type] || {
    icon: <IconHistory className="w-3.5 h-3.5" />,
    color: '#6B6663',
    label: event.type,
  };
  return (
    <li className="grid grid-cols-[auto_1fr] gap-3 px-5 py-3">
      <span
        className="w-7 h-7 rounded-full grid place-items-center text-white shrink-0 mt-0.5"
        style={{ background: t.color }}
      >
        {t.icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink truncate">{event.title}</p>
        <p className="text-[11px] text-ink/60 leading-snug line-clamp-2">{event.note}</p>
        <p className="mt-1 text-[10px] text-ink/45 tabular-nums inline-flex items-center gap-1">
          <IconClock className="w-2.5 h-2.5" /> {event.ts}
        </p>
      </div>
    </li>
  );
}

/* Plan 89 C5 — Stat moved to `src/components/stat-tiles.tsx` so sibling
   components can statically import it without keeping this view in the
   eager graph. The view still uses Stat internally (chapter-row stats);
   re-exporting from here also keeps any external call sites working. */
export { Stat } from '../components/stat-tiles';

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
  /** fs-13 — per-character sentence ids in this chapter, intersected with
      `chapter.completedSentenceIds` for an EXACT per-character done count. */
  charSentenceIds: Record<string, number[]> | undefined;
  onRegenerate: (ch: Chapter) => void;
  /** Re-analyse this one chapter (character detection + attribution) in place. */
  onReanalyse: (ch: Chapter) => void;
  /** Escape hatch for a stuck/never-rendered `queued` row: enqueues this one
      chapter directly (no reason prompt) so the dispatcher picks it up. */
  onGenerateChapter: (ch: Chapter) => void;
  onRegenerateCharacterInChapter: (charId: string, chapterId: number) => void;
  onPreview: (chapterId: number) => void;
  /** Plan 78 — opens the rename modal for this chapter. View-level
      modal mount; row only knows "open rename for me". */
  onRename: (ch: Chapter) => void;
  onToggleExcluded: (chapterId: number, excluded: boolean) => void;
  /** Guard-wrapped variant of `onToggleExcluded(id, false)`. Wraps the
      un-exclude call in `useLocalAnalyzerGuard` so the local-analyzer
      mid-gen confirm modal can intercept before the analysis fires. */
  onIncludeClick: (chapterId: number) => void;
  onCancelSubset: (chapterId: number) => void;
  onRetrySubset: (chapterId: number) => void;
  /** Bug 2 — true when this `done` chapter's sentence→speaker assignments were
      reassigned after its audio was rendered (derived from the change-log vs
      `audioRenderedAt`). Drives the "Sentences reassigned · regenerate" caption. */
  stale: boolean;
  /** In-flight subset analysis state for this chapter, or null when
      the row is idle. Drives the inline progress / throttle / error
      block on the excluded-chapter variant. */
  subsetProgress: SubsetProgress | null;
  /** Active TTS model on the project. Used to compute engine drift: a
      chapter whose `audioModelKey` differs gets a "Generated with X"
      badge prompting the user to regenerate for consistency
      (plan 35). */
  activeModelKey: TtsModelKey;
}

function ChapterRow({
  chapter,
  characters,
  bookId,
  expanded,
  onToggle,
  paused,
  blocked,
  stalled,
  charStats,
  charPositions,
  charSentenceIds,
  onRegenerate,
  onReanalyse,
  onGenerateChapter,
  onRegenerateCharacterInChapter,
  onPreview,
  onRename,
  onToggleExcluded,
  onIncludeClick,
  onCancelSubset,
  onRetrySubset,
  stale,
  subsetProgress,
  activeModelKey,
}: ChapterRowProps) {
  /* fs-13 — the chapter's live completed sentence-id SET, built once per row
     render and shared by every per-character bar below. Absent (undefined)
     when the server hasn't sent any `completedSentenceIds` yet (older server,
     or pre-first-completion) — characterRowProgress then falls back to the
     currentLine approximation. Declared before the early return so the hook
     order stays stable. */
  const completedSet = useMemo(
    () =>
      chapter.completedSentenceIds && chapter.completedSentenceIds.length > 0
        ? new Set(chapter.completedSentenceIds)
        : undefined,
    [chapter.completedSentenceIds],
  );
  /* Render the greyed-out variant when the chapter is excluded OR a
     subset re-analysis is in flight for it. The transitional case
     (excluded flipped to false server-side but analysis is still
     running) MUST keep the special row visible — without it the
     in-flight progress / Cancel / error UI would disappear the moment
     the slice action lands and the row would morph into an empty
     normal queued row mid-stream. */
  if (chapter.excluded || subsetProgress) {
    return (
      <ExcludedChapterRow
        chapter={chapter}
        subsetProgress={subsetProgress}
        onIncludeClick={onIncludeClick}
        onCancelSubset={onCancelSubset}
        onRetrySubset={onRetrySubset}
      />
    );
  }

  const assembling = chapter.phase === 'assembling';
  const verifying = chapter.phase === 'verifying';
  /* C2 (Wave 3) — the worker is riding out a mid-render sidecar respawn. Takes
     precedence over the stall styling: this IS a healthy recovery, not a stall. */
  const recovering = chapter.phase === 'recovering';
  const rowStalled = stalled && chapter.state === 'in_progress' && !recovering;
  const inProgressLabel = rowStalled
    ? 'Stalled'
    : recovering
      ? 'Recovering…'
      : assembling
        ? 'Assembling…'
        : verifying
          ? 'Verifying speech…'
          : paused
            ? 'Paused'
            : 'Generating';
  const inProgressPill = rowStalled ? (
    <Pill color="warning">Stalled</Pill>
  ) : (
    <Pill color="peach">{inProgressLabel}</Pill>
  );
  const queuedPill = blocked ? <Pill color="danger">Blocked</Pill> : <Pill>Queued</Pill>;
  const inProgressIcon = rowStalled ? (
    <IconClock className="w-4 h-4 text-amber-700" />
  ) : paused ? (
    <IconPause className="w-4 h-4 text-magenta" />
  ) : (
    <IconSpinner className="w-4 h-4 text-magenta" />
  );
  const stateConfig = {
    done: {
      tint: 'bg-emerald-50/50',
      badge: <Pill color="success">Done</Pill>,
      icon: <IconCheck className="w-4 h-4 text-emerald-600" />,
    },
    in_progress: {
      tint: rowStalled ? 'bg-amber-50/60' : 'bg-peach/6',
      badge: inProgressPill,
      icon: inProgressIcon,
    },
    queued: {
      tint: blocked ? 'bg-rose-50/30' : 'bg-white',
      badge: queuedPill,
      icon: <span className="w-4 h-4 rounded-full border border-ink/20" />,
    },
    failed: {
      tint: 'bg-rose-50/50',
      badge: <Pill color="danger">Failed</Pill>,
      icon: <IconWarning className="w-4 h-4 text-rose-600" />,
    },
  }[chapter.state];

  /* "Not queued" hold overrides the neutral Queued badge. The chapter is
     un-rendered (state==='queued') but the user removed it from the queue, so
     it must not read "Queued" (which implies pending work) — a dashed circle +
     muted "Not queued" pill signals it's idle and re-addable via the expanded
     "Generate this chapter" button. */
  const heldNotQueued = !!chapter.held && chapter.state === 'queued';
  if (heldNotQueued) {
    stateConfig.badge = <Pill>Not queued</Pill>;
    stateConfig.icon = (
      <span className="w-4 h-4 rounded-full border border-dashed border-ink/30" />
    );
  }

  const findChar = (id: string): Character =>
    characters.find((c) => c.id === id) || { id, name: id, role: '', color: 'narrator' };

  /* Chapter totals derived from the manuscript so the header can show
     "X words · Y lines · Z speakers" without waiting on the SSE. */
  const chapterTotals = (() => {
    if (!charStats) return null;
    const entries = Object.values(charStats);
    if (entries.length === 0) return null;
    return {
      lines: entries.reduce((s, e) => s + e.lines, 0),
      words: entries.reduce((s, e) => s + e.words, 0),
      speakers: entries.length,
    };
  })();

  /* Live "synthesising X · line N of Y" caption for the in-progress row.
     Replaces the queued/done static meta so the user has eye-level
     confirmation each tick that lines are moving. Falls back to the
     manuscript-derived total when the SSE hasn't shipped a totalLines
     yet (e.g. the first sub-second after Resume). */
  const liveSpeakerId =
    chapter.state === 'in_progress'
      ? Object.entries(chapter.characters).find(([, s]) => s === 'in_progress')?.[0]
      : undefined;
  const liveSpeaker = liveSpeakerId ? findChar(liveSpeakerId) : null;
  const liveTotal = chapter.totalLines ?? chapterTotals?.lines ?? 0;
  const liveCurrent = chapter.currentLine ?? 0;

  return (
    <div
      id={`chapter-${chapter.id}`}
      className={`rounded-3xl border border-ink/10 shadow-card overflow-hidden ${stateConfig.tint}`}
    >
      <button
        onClick={onToggle}
        className="w-full grid grid-cols-[24px_44px_minmax(0,1fr)_auto_20px] sm:grid-cols-[32px_52px_minmax(0,1fr)_120px_64px_92px_20px] items-center gap-2 sm:gap-3 px-4 sm:px-5 py-4 min-h-[44px] text-left"
      >
        <span className="grid place-items-center">{stateConfig.icon}</span>
        <span className="text-sm font-bold text-ink/50 tabular-nums">
          CH {String(chapter.id).padStart(2, '0')}
        </span>
        <span className="min-w-0">
          <span className="block font-semibold text-ink truncate">
            {stripChapterPrefix(chapter.title)}
          </span>
          {chapter.state === 'in_progress' && recovering ? (
            /* C2 (Wave 3) — the sidecar recycled mid-render and the worker is
               riding out the respawn. Name it explicitly so a healthy recovery
               doesn't read as a frozen "Synthesising …" line / stall. */
            <span className="block text-[11px] text-magenta tabular-nums mt-0.5 truncate">
              Recovering — restarting voice engine…
            </span>
          ) : chapter.state === 'in_progress' && verifying ? (
            /* srv-31 ASR content-QA pass: the synthesis groups are done and
               counters are frozen near 99 %, so show the QA step explicitly
               instead of a stuck "Synthesising …" line. */
            <span className="block text-[11px] text-magenta tabular-nums mt-0.5 truncate">
              Verifying speech…
            </span>
          ) : chapter.state === 'in_progress' && liveTotal > 0 ? (
            /* Live caption — swaps in once a tick has shipped totalLines so
               the user has a per-tick "moving" signal at eye level.
               Falls through to the static meta until then. */
            <span className="block text-[11px] text-magenta tabular-nums mt-0.5 truncate">
              {liveSpeaker ? `Synthesising ${liveSpeaker.name} · ` : ''}
              line {liveCurrent.toLocaleString()} of {liveTotal.toLocaleString()}
            </span>
          ) : chapter.state === 'done' && stale ? (
            /* Bug 2 — sentence→speaker assignments changed after this chapter
               was rendered, so its audio is out of date. Most actionable of the
               "done" captions (the user's own edit invalidated it), so it wins
               over the informational mixed-engine / engine-drift lines. The
               Regenerate-this-chapter control sits eye-level below. */
            <span
              className="block text-[11px] text-amber-700 tabular-nums mt-0.5 truncate"
              title="You reassigned sentences in this chapter after it was generated. Regenerate to refresh the audio."
            >
              ⚠ Sentences reassigned · regenerate to refresh
            </span>
          ) : chapter.state === 'done' && isMixedEngineChapter(chapter) ? (
            /* Mixed-engine breakdown caption (false-drift fix, 2026-06-07).
               A chapter whose voices span engines (narrator on Kokoro +
               dialogue on Qwen) is intentional, not drift — show the per-engine
               voice count instead of an amber warning. */
            <span
              className="block text-[11px] text-ink/50 tabular-nums mt-0.5 truncate"
              title={`Voices rendered across ${formatEngineBreakdown(chapter.audioEngines)}.`}
            >
              Voices: {formatEngineBreakdown(chapter.audioEngines)}
            </span>
          ) : chapter.state === 'done' &&
            chapter.audioModelKey &&
            chapter.audioModelKey !== activeModelKey ? (
            /* Engine drift caption (plan 35). When a Done chapter's
               recorded engine differs from the project's current TTS
               model, surface it in place of the words/lines static meta
               so the user notices on the row that's eye-level with the
               Regenerate-this-chapter link below. Tooltip carries the
               full message; the inline copy stays compact. */
            <span
              className="block text-[11px] text-amber-700 tabular-nums mt-0.5 truncate"
              title={`Generated with ${ttsModelLabel(chapter.audioModelKey)}. Current engine is ${ttsModelLabel(activeModelKey)}. Regenerate to refresh.`}
            >
              ⚠ Generated with {ttsModelLabel(chapter.audioModelKey)} · current engine is{' '}
              {ttsModelLabel(activeModelKey)}
            </span>
          ) : (
            chapterTotals && (
              <span className="block text-[11px] text-ink/50 tabular-nums mt-0.5 truncate">
                {chapterTotals.words.toLocaleString()}{' '}
                {chapterTotals.words === 1 ? 'word' : 'words'}
                {' · '}
                {chapterTotals.lines.toLocaleString()}{' '}
                {chapterTotals.lines === 1 ? 'line' : 'lines'}
                {' · '}
                {chapterTotals.speakers} {chapterTotals.speakers === 1 ? 'speaker' : 'speakers'}
              </span>
            )
          )}
        </span>
        {/* Progress bar + duration are desktop-only cells; on phone (<sm)
            the chapter row is icon · CH · title · badge · chevron. The
            collapsed-row progress + duration affordances live in the chapter
            list anyway (the row's status icon + badge already convey the
            state) — full progress/duration return on `sm:` and up. */}
        <span className="hidden sm:block">
          <ChapterProgressBar
            progress={chapter.progress}
            state={chapter.state}
            paused={paused}
            assembling={assembling}
            verifying={verifying}
            recovering={recovering}
          />
        </span>
        <span className="hidden sm:block text-sm tabular-nums text-ink/60 text-right">
          {chapter.state === 'in_progress' && liveTotal > 0 ? (
            <span className="text-magenta">
              {liveCurrent}/{liveTotal}
            </span>
          ) : (
            chapter.duration
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {/* srv-27 — advisory QA badge. Renders only when the rendered audio
              was flagged suspect (near-silent / clipped / duration drift); the
              chapter is still Done. The reasons sit in the tooltip. */}
          {chapter.state === 'done' && chapter.audioQa?.status === 'suspect' && (
            <span
              className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
              title={chapter.audioQa.reasons.join(' ')}
            >
              Suspect
            </span>
          )}
          {stateConfig.badge}
        </span>
        <span className={`text-ink/40 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <IconArrowDn className="w-4 h-4" />
        </span>
      </button>
      {chapter.state === 'failed' && chapter.errorReason && (
        <div className="mx-5 mb-4 -mt-1 rounded-2xl border border-rose-200 bg-rose-50/80 px-4 py-3 flex items-start gap-3">
          <IconWarning className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-rose-900">Synthesis failed</p>
            <p className="text-xs text-rose-800/90 mt-0.5 leading-relaxed">{chapter.errorReason}</p>
            {/* fs-19 — concrete "what to do about it" line under the reason. */}
            {chapter.generationRemediation && (
              <p className="text-xs text-rose-700/80 mt-1.5 leading-relaxed">
                <span className="font-semibold">What to do:</span> {chapter.generationRemediation}
                {helpHrefForFailureCode(chapter.generationErrorCode) && (
                  <>
                    {' '}
                    <a
                      href={helpHrefForFailureCode(chapter.generationErrorCode)!}
                      className="underline font-semibold text-magenta hover:text-magenta/80"
                    >
                      More help
                    </a>
                  </>
                )}
              </p>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRegenerate(chapter);
            }}
            className="shrink-0 inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-semibold text-rose-700 hover:text-rose-900 transition-colors"
          >
            <IconRefresh className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}
      {(chapter.state === 'done' || (chapter.state === 'failed' && !chapter.errorReason)) && (
        /* Action row wraps on phone (was a single overflowing row); each
            button gets min-h + tap padding so the touch target hits ≥44px
            without changing the visual size of the labels on desktop. */
        <div className="px-4 sm:px-6 pb-3 sm:pb-4 -mt-2 flex flex-wrap justify-end items-center gap-x-3 gap-y-1">
          {/* When the audio was synthesised. `mr-auto` keeps it left-aligned
              while the action buttons stay right-aligned and wrap cleanly on
              phone. Relative label (matches the Activity feed) with the exact
              date/time on hover. Guarded on the field so legacy chapters
              rendered before it existed simply omit the line. */}
          {chapter.state === 'done' && chapter.audioRenderedAt && (
            <span
              className="mr-auto text-[11px] text-ink/40 tabular-nums"
              title={new Date(chapter.audioRenderedAt).toLocaleString()}
            >
              Generated {relativeTime(chapter.audioRenderedAt)}
            </span>
          )}
          {chapter.state === 'done' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPreview(chapter.id);
              }}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/70 hover:text-ink transition-colors"
            >
              <IconPlay className="w-3.5 h-3.5" /> Preview
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExcluded(chapter.id, true);
            }}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/45 hover:text-ink/70 transition-colors"
            title="Skip this chapter — no audio will be generated for it."
          >
            <IconClose className="w-3.5 h-3.5" /> Exclude
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRename(chapter);
            }}
            data-testid={`chapter-row-${chapter.id}-rename`}
            aria-label={`Rename chapter ${chapter.id}`}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/60 hover:text-magenta transition-colors"
          >
            <IconPencil className="w-3.5 h-3.5" /> Rename
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReanalyse(chapter);
            }}
            disabled={subsetProgress != null}
            data-testid={`chapter-row-${chapter.id}-reanalyse`}
            title="Re-run character detection + attribution for this chapter (designed voices preserved)."
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/60 hover:text-magenta transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <IconSparkle className="w-3.5 h-3.5" /> Re-analyse
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRegenerate(chapter);
            }}
            aria-label={chapter.state === 'failed' ? 'Retry chapter' : 'Regenerate this chapter'}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/60 hover:text-magenta transition-colors"
          >
            <IconRefresh className="w-3.5 h-3.5" />{' '}
            {chapter.state === 'failed' ? 'Retry chapter' : 'Regenerate'}
          </button>
        </div>
      )}
      {/* For queued chapters (no other action row visible), surface a
          subtle Exclude link in the expanded panel below. The expand
          arrow already invites interaction; putting the link in the
          expanded view keeps the collapsed row visually clean. */}
      {expanded && (chapter.state === 'queued' || chapter.state === 'in_progress') && (
        <div className="px-4 sm:px-6 -mt-3 flex flex-wrap justify-end items-center gap-x-3 gap-y-1">
          {/* Escape hatch: a `queued` row that isn't part of an active run
              (e.g. one that failed before the durable status landed, then had
              its queue entry cleared) is otherwise unactionable. Enqueue it
              directly so the dispatcher renders just this chapter. */}
          {chapter.state === 'queued' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onGenerateChapter(chapter);
              }}
              data-testid={`chapter-row-${chapter.id}-generate`}
              aria-label={`Generate chapter ${chapter.id}`}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-semibold text-magenta hover:text-magenta/80 transition-colors"
              title="Queue this chapter for synthesis now."
            >
              <IconPlay className="w-3.5 h-3.5" /> Generate this chapter
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRename(chapter);
            }}
            data-testid={`chapter-row-${chapter.id}-rename`}
            aria-label={`Rename chapter ${chapter.id}`}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/60 hover:text-magenta transition-colors"
          >
            <IconPencil className="w-3.5 h-3.5" /> Rename
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExcluded(chapter.id, true);
            }}
            disabled={chapter.state === 'in_progress'}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/45 hover:text-ink/70 disabled:opacity-40 transition-colors"
            title={
              chapter.state === 'in_progress'
                ? 'Pause first, then you can exclude this chapter.'
                : 'Skip this chapter — no audio will be generated for it.'
            }
          >
            <IconClose className="w-3.5 h-3.5" /> Exclude
          </button>
        </div>
      )}
      {expanded && (
        <div className="px-4 sm:px-5 pb-5 pt-1 fade-in">
          {/* On phone the 60px gutter (designed to align under the chapter
              icon + CH label) eats too much of the 375px width — drop it
              and rely on the left border for hierarchy. Desktop keeps the
              gutter. */}
          <div className="ml-0 sm:ml-[60px] pl-3 sm:pl-4 border-l border-ink/10 space-y-2">
            {Object.entries(chapter.characters).map(([cid, status]) => {
              const c = findChar(cid);
              const stat = charStats?.[cid];
              /* Derive real per-character completion from the manuscript line
                 positions and the chapter's currentLine — NOT from the slice's
                 per-character `status`, which only tracks who's *currently*
                 speaking and goes stale at `'done'` across a regenerate (a
                 hydrate re-seeds the rendered chapter's cast as done, and only
                 the live speaker gets un-done'd). See characterRowProgress. */
              const linesTotal = stat?.lines ?? 0;
              const { derivedDone, fraction, fullyDone } = characterRowProgress({
                chapterState: chapter.state,
                status,
                linesTotal,
                positions: charPositions?.[cid],
                currentLine: chapter.currentLine ?? 0,
                /* fs-13 — when the live completed-id set is present, derive this
                   character's done count EXACTLY (set ∩ their sentence ids);
                   otherwise fall back to the positions+currentLine count. */
                sentenceIds: charSentenceIds?.[cid],
                completedSet,
              });
              return (
                <div
                  key={cid}
                  className="grid grid-cols-[16px_minmax(0,1fr)_auto_44px] sm:grid-cols-[20px_1fr_96px_128px_28px] items-center gap-2 sm:gap-4 py-1.5 text-sm group"
                >
                  <ColorDot color={c.color as CharColor} size={8} />
                  {/* Name + line/word stat row: stacks vertically on phone
                      (truncated names + their stat get a guaranteed row
                      each), inline-baseline on sm+ for the original
                      ≥640px shape. */}
                  <span className="min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
                    <span className="font-medium text-ink/90 truncate">{c.name}</span>
                    {stat && (
                      <span className="text-[11px] text-ink/40 tabular-nums shrink-0">
                        {stat.lines.toLocaleString()} {stat.lines === 1 ? 'line' : 'lines'} ·{' '}
                        {stat.words.toLocaleString()} {stat.words === 1 ? 'word' : 'words'}
                      </span>
                    )}
                  </span>
                  {/* Per-character progress bar is desktop-only (sm+). On
                      phone the status text + numeric ratio at the right is
                      enough; the bar requires its own grid column which
                      would force the row to overflow at 375px. */}
                  <span className="hidden sm:block">
                    <CharStatusBar
                      status={status}
                      fraction={fraction}
                      fullyDone={fullyDone}
                      paused={paused}
                    />
                  </span>
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
                        {linesTotal > 0 && (
                          <span className="text-magenta/60 font-normal">
                            {' '}
                            {derivedDone}/{linesTotal}
                          </span>
                        )}
                      </span>
                    ) : derivedDone > 0 && linesTotal > 0 ? (
                      /* Has spoken some lines but the active speaker is now
                         someone else — show real progress instead of the
                         old "Done" lie. */
                      <span className="text-ink/60">
                        {derivedDone}/{linesTotal} done
                      </span>
                    ) : (
                      'Queued'
                    )}
                  </span>
                  {status !== 'skipped' && (
                    /* Hover-reveal is mouse-only. Gate the hide on `fine-pointer:`
                       (mice) rather than the `sm:` width breakpoint: `fine-pointer`
                       and `coarse-pointer` are mutually-exclusive media queries, so
                       touch devices (incl. tablets ≥640px) keep the button visible at
                       its full 44×44 target, while a mouse hides it until group-hover
                       and shrinks it to the compact 28px swatch. The old `sm:` proxy
                       hid the action on touch tablets — fe-5. */
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRegenerateCharacterInChapter(cid, chapter.id);
                      }}
                      title={`Regenerate ${c.name} in this chapter`}
                      aria-label={`Regenerate ${c.name} in this chapter`}
                      className="opacity-100 fine-pointer:opacity-0 fine-pointer:group-hover:opacity-100 text-ink/40 hover:text-magenta grid place-items-center min-w-[44px] min-h-[44px] fine-pointer:min-w-0 fine-pointer:min-h-0 fine-pointer:w-7 fine-pointer:h-7 rounded-full hover:bg-ink/6 transition-all"
                    >
                      <IconRefresh className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {chapter.state === 'in_progress' && assembling && (
            <div className="mt-4 ml-[60px] text-xs text-ink/60">
              Writing chapter file…{' '}
              {chapter.totalLines ? `${chapter.totalLines} lines synthesised` : 'finalising audio'}.
            </div>
          )}
          {chapter.state === 'in_progress' &&
            !assembling &&
            !verifying &&
            !recovering &&
            chapter.currentLine != null &&
            chapter.currentLine > 0 && (
              <div className="mt-4 ml-[60px] flex items-center gap-3 text-xs text-ink/60">
                <span>
                  Active:{' '}
                  <span className="font-semibold text-ink">
                    {
                      findChar(
                        Object.entries(chapter.characters).find(
                          ([, s]) => s === 'in_progress',
                        )?.[0] || '',
                      ).name
                    }
                  </span>{' '}
                  · line {chapter.currentLine.toLocaleString()} of{' '}
                  {chapter.totalLines?.toLocaleString()}
                </span>
              </div>
            )}
          {chapter.state === 'done' && (
            <ChapterSegmentStrip chapter={chapter} bookId={bookId} characters={characters} />
          )}
        </div>
      )}
    </div>
  );
}

/* Idle / running / errored variants of the greyed-out excluded-chapter
   row on the Generate screen. Lives at this top level so the parent
   ChapterRow stays focused on the live-chapter state machine; the
   excluded path has its own three-state UI now (idle → inline progress
   → optional error/retry). */
function ExcludedChapterRow({
  chapter,
  subsetProgress,
  onIncludeClick,
  onCancelSubset,
  onRetrySubset,
}: {
  chapter: Chapter;
  subsetProgress: SubsetProgress | null;
  onIncludeClick: (chapterId: number) => void;
  onCancelSubset: (chapterId: number) => void;
  onRetrySubset: (chapterId: number) => void;
}) {
  /* Three-state UI: idle (subsetProgress null) → running (entry exists,
     no error) → errored (entry exists with error). Narrowing via direct
     null/error checks rather than aliased booleans so TypeScript's
     control-flow analysis flows through every branch. */
  const running = subsetProgress && subsetProgress.error == null ? subsetProgress : null;
  const errored = subsetProgress && subsetProgress.error != null ? subsetProgress : null;
  const throttleActive = running?.throttle != null && running.throttle.until > Date.now();

  return (
    <div className="rounded-3xl border border-ink/10 bg-ink/3 overflow-hidden">
      <div className="grid grid-cols-[24px_44px_minmax(0,1fr)_auto] sm:grid-cols-[32px_52px_minmax(0,1fr)_auto] items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3">
        <span className="grid place-items-center text-ink/30">
          <span className="w-4 h-4 rounded-full border border-ink/15" />
        </span>
        <span className="text-sm font-bold text-ink/35 tabular-nums">
          CH {String(chapter.id).padStart(2, '0')}
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-ink/40 truncate line-through decoration-1">
            {stripChapterPrefix(chapter.title)}
          </span>
          {running ? (
            <span className="block text-[11px] text-ink/55 mt-0.5">
              Re-analyzing — {running.phaseLabel} (Phase {running.phaseId === 0 ? '0a' : '1'})
              {running.phaseElapsedMs > 0 && (
                <span className="text-ink/40 tabular-nums">
                  {' · '}
                  {formatElapsed(running.phaseElapsedMs)}
                  {running.charsPerSec > 0 && ` · ${running.charsPerSec.toLocaleString()} chars/s`}
                </span>
              )}
            </span>
          ) : errored ? (
            <span className="block text-[11px] text-rose-700 mt-0.5">
              Re-analysis failed: {errored.error}
            </span>
          ) : (
            <span className="block text-[11px] text-ink/45 mt-0.5">
              Excluded — not analyzed, no audio will be generated.
            </span>
          )}
        </span>
        {running ? (
          <button
            type="button"
            onClick={() => onCancelSubset(chapter.id)}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/60 hover:text-magenta transition-colors"
          >
            Cancel
          </button>
        ) : errored ? (
          <button
            type="button"
            onClick={() => onRetrySubset(chapter.id)}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/60 hover:text-magenta transition-colors"
          >
            <IconRefresh className="w-3.5 h-3.5" /> Retry
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onIncludeClick(chapter.id)}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-2 text-xs font-medium text-ink/60 hover:text-magenta transition-colors"
          >
            + Include in book
          </button>
        )}
      </div>
      {running && (
        /* Inline progress bar — same gradient + stripe-travel as the live
           chapter rows so the visual language stays consistent. The bar
           fills 0→1 across the active phase; the phase label above is
           the user's cue that there's a Phase 0a → Phase 1 handoff. */
        <div className="px-5 pb-3 -mt-1">
          <div className="relative h-1.5 rounded-full bg-ink/6 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-gradient-progress rounded-full transition-all duration-700"
              style={{ width: `${Math.max(0, Math.min(1, running.progress)) * 100}%` }}
            >
              <div className="absolute inset-0 stripe-travel" />
            </div>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-ink/50 tabular-nums">
            <span>{Math.round(running.progress * 100)}%</span>
            {throttleActive && running.throttle && (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <IconClock className="w-2.5 h-2.5" />
                Waiting on {running.throttle.model} ({running.throttle.reason})
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChapterProgressBar({
  progress,
  state,
  paused,
  assembling,
  verifying,
  recovering,
}: {
  progress: number;
  state: Chapter['state'];
  paused: boolean;
  assembling: boolean;
  verifying: boolean;
  recovering: boolean;
}) {
  if (state === 'queued') return <div className="h-1.5 rounded-full bg-ink/6" />;
  if (state === 'done')
    return (
      <div className="h-1.5 rounded-full bg-emerald-200">
        <div className="h-full w-full rounded-full bg-emerald-500" />
      </div>
    );
  if (state === 'failed')
    return (
      <div className="h-1.5 rounded-full bg-rose-100">
        <div className="h-full rounded-full bg-rose-500" style={{ width: `${progress * 100}%` }} />
      </div>
    );
  if (assembling || verifying || recovering)
    return (
      /* Disk-write phase (assembling), the srv-31 ASR content-QA pass
         (verifying), or a mid-render sidecar respawn ride-out (recovering, C2)
         — neutral ink-tone bar with stripe motion to read as "near done, busy"
         rather than the magenta synthesis gradient. */
      <div className="relative h-1.5 rounded-full bg-ink/6 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-ink/40"
          style={{ width: `${progress * 100}%` }}
        >
          {!paused && <div className="absolute inset-0 stripe-travel" />}
        </div>
      </div>
    );
  return (
    <div className="relative h-1.5 rounded-full bg-ink/6 overflow-hidden">
      <div
        className={`absolute inset-y-0 left-0 bg-gradient-progress rounded-full transition-all duration-700 ${paused ? '' : 'pulse-bar'}`}
        style={{ width: `${progress * 100}%` }}
      >
        {!paused && <div className="absolute inset-0 stripe-travel" />}
      </div>
    </div>
  );
}

function CharStatusBar({
  status,
  fraction,
  fullyDone,
  paused,
}: {
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
  if (status === 'failed') return <div className="h-1 rounded-full bg-rose-400" />;
  if (status === 'skipped') return <div className="h-1 rounded-full bg-ink/4" />;
  if (fullyDone) return <div className="h-1 rounded-full bg-emerald-400" />;

  const pct = Math.max(0, Math.min(100, fraction * 100));

  if (status === 'in_progress')
    return (
      /* Currently-speaking character. Bar fills to the real fraction of this
       character's lines that are behind us, with the peach gradient + stripe
       animation overlaying so it reads as "still working". Previously the
       bar was a fixed 60 %-width sliver regardless of how many lines were
       actually done. */
      <div className="relative h-1 rounded-full bg-ink/6 overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 bg-gradient-progress rounded-full transition-all duration-500 ${paused ? '' : 'pulse-bar'}`}
          style={{ width: `${Math.max(pct, 8)}%` }}
        >
          {!paused && <div className="absolute inset-0 stripe-travel" />}
        </div>
      </div>
    );

  if (pct > 0)
    return (
      /* Has spoken some lines but isn't the active speaker right now — show
       the real synthesised fraction in emerald so the user sees "1 of 13
       done" instead of the previous "Done" lie. */
      <div className="relative h-1 rounded-full bg-ink/6 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-emerald-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    );

  return <div className="h-1 rounded-full bg-ink/8" />;
}

/* Visual confirmation that this chapter's audio was assembled in narrative
   order. Lazy-fetches the same segments JSON we already use for preview
   playback; renders coloured bands keyed to character palette colours. */
export function ChapterSegmentStrip({
  chapter,
  bookId,
  characters,
}: {
  chapter: Chapter;
  bookId: string;
  characters: Character[];
}) {
  const [audio, setAudio] = useState<ChapterAudio | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getChapterAudio({ bookId, chapterId: chapter.id })
      .then((m) => {
        if (!cancelled) setAudio(m);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, chapter.id]);

  const issues = useMemo(() => (audio ? deriveIssues(audio) : []), [audio]);

  if (error || !audio || !audio.segments?.length || !audio.durationSec) return null;
  const findChar = (id: string) => characters.find((c) => c.id === id);
  const hasPeaks = (audio.peaks?.length ?? 0) > 0;
  const chapterLevelOnly = chapter.audioQa?.status === 'suspect' && issues.length === 0;

  return (
    <div className="mt-4 ml-[60px]">
      <p className="text-[10px] uppercase tracking-wider text-ink/50 font-semibold mb-1.5">
        Narrative order
      </p>
      <div className="flex h-2 rounded-full overflow-hidden bg-ink/4">
        {audio.segments.map((seg, i) => {
          const start = seg.start ?? 0;
          const end = seg.end ?? start;
          const charId = seg.characterId ?? '';
          const width = ((end - start) / audio.durationSec) * 100;
          const charColor = findChar(charId)?.color ?? 'narrator';
          const hex = CHAR_COLORS[charColor]?.hex ?? CHAR_COLORS.narrator.hex;
          return (
            <div
              key={i}
              title={`${findChar(charId)?.name ?? (charId || 'unknown')} · ${formatTime(start)}–${formatTime(end)}`}
              style={{ width: `${width}%`, background: hex }}
            />
          );
        })}
      </div>

      {hasPeaks && (
        <div className="mt-2 relative">
          <Waveform progress={0} active={false} peaks={audio.peaks} issues={issues} />
          {chapterLevelOnly && (
            <div
              className="absolute left-0 right-0 -bottom-0.5 h-[2px] rounded-full bg-amber-400/70"
              title={chapter.audioQa?.reasons.join(' ') || 'Chapter-level issue'}
            />
          )}
        </div>
      )}

      {issues.length > 0 && (
        <p
          className="mt-1 text-[10px] font-semibold text-amber-700 flex items-center gap-1"
          title={issues.map((r) => `${formatTime(r.seekSec)}: ${r.reasons.join(', ')}`).join(' · ')}
        >
          <span aria-hidden>⚠</span>
          {issues.length} issue{issues.length > 1 ? 's' : ''} to review
        </p>
      )}
      {chapterLevelOnly && (
        <p className="mt-1 text-[10px] font-semibold text-amber-700 flex items-center gap-1"
           title={chapter.audioQa?.reasons.join(' ')}>
          <span aria-hidden>⚠</span> Chapter-level issue
        </p>
      )}
    </div>
  );
}
