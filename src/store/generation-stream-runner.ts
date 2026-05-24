/* Generation-stream runner — owns the single SSE handle and its lifecycle.

   Extracted from generation-stream-middleware (plan 102 Should #6) so the
   queue dispatcher can open a CROSS-BOOK stream through the exact same
   lifecycle the same-book reconcile path uses: one handle, one
   `chapters.activeStream` snapshot, one per-run rollup, one idle teardown.

   A single shared instance is created in `src/store/index.ts` and injected
   into BOTH `generation-stream-middleware` (same-book, reconcile-driven
   opens) and `queue-dispatcher-middleware` (cross-book, dispatch-driven
   opens). Because the handle lives here and not in either middleware, the
   "only one SSE at a time" invariant is structural rather than conventional,
   and the per-tick side-effects (snapshot refresh, rollup, completion /
   failure events, idle close) fire for cross-book streams too — the
   generation-stream-middleware still observes every `applyGenerationTick`
   and delegates to `runner.handleTick`, regardless of which middleware
   opened the stream. */

import type { Dispatch } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import {
  buildGenerationStartedEvent,
  buildGenerationRunCompleteEvent,
  buildChapterFailedEvent,
} from '../lib/change-log';
import { chaptersActions } from './chapters-slice';
import { changeLogActions } from './change-log-slice';
import { revisionsActions } from './revisions-slice';
import { notificationsActions } from './notifications-slice';
import type { ActiveStreamSnapshot, ChaptersState } from './chapters-slice';
import type { GenerationTick, TtsModelKey } from '../lib/types';

/** What the stream should render. Mirrors the old `chapters.pendingRegen`
    shape (`{ chapterIds, force }`) so the same-book reconcile path can pass
    its spec through unchanged; the cross-book dispatch path constructs one
    from the head queue entry. */
export interface StreamSpec {
  chapterIds?: number[];
  force?: boolean;
}

export interface StreamOpenOpts {
  /** Queue entry this stream fulfils. Threaded to the server so per-chapter
      ticks correlate to the right queue row when entries from different
      books interleave. */
  queueEntryId?: string;
}

/** Minimal store surface the runner needs. Satisfied by the configured RTK
    store; kept narrow (only `chapters`) so the runner doesn't import the
    store's circular `RootState` and stays usable from lean test stores. */
export interface StreamRunnerStore {
  dispatch: Dispatch;
  getState: () => { chapters: ChaptersState };
}

interface OpenHandle {
  cancel: () => void;
  bookId: string;
  modelKey: TtsModelKey;
  /** Chapter ids this stream is rendering (the spec's chapterIds). Lets the
      dispatcher answer "is chapter X already being generated?" so two workers
      never claim the same chapter. */
  chapterIds: number[];
  /* Per-run rollup accumulator. Every chapter_complete tick pushes its
     chapterId here; on run end (close) we emit one generation_run_complete
     event with the full list — keeps the activity feed from drowning in
     per-chapter audit rows on long runs. */
  completedChapterIds: number[];
}

export interface StreamRunner {
  /** Open an SSE for `bookId` with the given spec. No-ops if a stream is
      already open FOR THAT BOOK (the per-book singleton — two concurrent
      streams for one book would abort each other server-side, see
      server/src/routes/generation.ts `inFlightByBook`). Different books open
      independent concurrent streams (plan 111 worker pool). */
  open(
    bookId: string,
    modelKey: TtsModelKey,
    spec: StreamSpec | null,
    opts?: StreamOpenOpts,
  ): void;
  /** Tear down the stream for `bookId` (flushing its run rollup) and clear
      that book's snapshot. No-op when nothing is open for the book. */
  close(bookId: string): void;
  /** Tear down every open stream — store teardown / hard reset. */
  closeAll(): void;
  /** Number of books currently streaming (the dispatcher's N-slot gate). */
  openBookCount(): number;
  /** Book ids of every open stream — used by the halt path to pause each. */
  openBookIds(): string[];
  /** Is a stream open for this specific book? (per-book singleton check) */
  hasOpenStreamForBook(bookId: string): boolean;
  /** Union of chapter ids across all open streams — so the dispatcher never
      claims a chapter that's already rendering. */
  openChapterIds(): number[];
}

function snapshotFromChapters(
  bookId: string,
  modelKey: TtsModelKey,
  state: ChaptersState,
): ActiveStreamSnapshot {
  /* Counters mirror the active-subset filter used in the Generate view
     (`activeChapters` in src/views/generation.tsx): excluded chapters
     never queue or synthesise, so they must not inflate `total` or
     stall the cross-book top-bar pill's done/total readout. */
  const active = state.chapters.filter((c) => !c.excluded);
  return {
    bookId,
    modelKey,
    done: active.filter((c) => c.state === 'done').length,
    total: active.length,
    inProgress: active.filter((c) => c.state === 'in_progress').length,
    lastTickAt: state.lastTickAt,
    halted: state.lastError != null,
  };
}

export function createStreamRunner(store: StreamRunnerStore): StreamRunner {
  /* Plan 111 worker pool — one handle per book. The per-book singleton is
     structural (the server aborts a book's prior job on a new forced request,
     so two streams for one book can't coexist); different books stream
     concurrently up to the dispatcher's N-worker cap. */
  const handles = new Map<string, OpenHandle>();
  const dispatch = store.dispatch;

  const close = (bookId: string): void => {
    const handle = handles.get(bookId);
    if (!handle) return;
    /* Flush the per-run rollup before tearing down. Empty runs (pause before
       any chapter finished, queue drained immediately) write nothing — there
       was already a generation_started anchor for those. */
    if (handle.completedChapterIds.length > 0) {
      dispatch(
        changeLogActions.appendLogEvent(
          buildGenerationRunCompleteEvent({ chapterIds: handle.completedChapterIds }),
        ),
      );
    }
    handle.cancel();
    handles.delete(bookId);
    dispatch(chaptersActions.clearActiveStream(bookId));
  };

  const closeAll = (): void => {
    for (const bookId of [...handles.keys()]) close(bookId);
  };

  const open = (
    bookId: string,
    modelKey: TtsModelKey,
    spec: StreamSpec | null,
    opts: StreamOpenOpts = {},
  ): void => {
    /* Per-book singleton — never stack a second stream for the SAME book (the
       server would abort the first). Different books open concurrently. */
    if (handles.has(bookId)) return;

    const after = store.getState();

    /* Emit a system-level "generation started" event so the activity feed has
       a beat for the user's Regenerate click (or Resume). The chapterIds
       reflect either the regen spec or the broader queued/in-progress set
       the server will resume against. For a cross-book open the slice holds a
       DIFFERENT book's rows, so fall back only when the spec is empty AND the
       slice is on this book. */
    const sliceOnThisBook = after.chapters.currentBookId === bookId;
    const ids =
      spec?.chapterIds && spec.chapterIds.length > 0
        ? spec.chapterIds
        : sliceOnThisBook
          ? after.chapters.chapters
              .filter((c) => c.state === 'in_progress' || c.state === 'queued')
              .map((c) => c.id)
          : [];
    dispatch(changeLogActions.appendLogEvent(buildGenerationStartedEvent({ chapterIds: ids })));

    /* Seed this book's snapshot. Same-book: derive from the slice's rows
       (it IS this book's data right now). Cross-book: the slice holds the
       wrong book, so seed a minimal placeholder; the first tick's run*
       aggregates refresh it via updateActiveStreamProgress. */
    const seed: ActiveStreamSnapshot = sliceOnThisBook
      ? snapshotFromChapters(bookId, modelKey, after.chapters)
      : {
          bookId,
          modelKey,
          done: 0,
          total: spec?.chapterIds?.length ?? 1,
          inProgress: 1,
          lastTickAt: null,
          halted: false,
        };
    dispatch(chaptersActions.setActiveStream(seed));

    const cancel = api.streamGeneration({
      bookId,
      modelKey,
      chapterIds: spec?.chapterIds,
      force: spec?.force,
      ...(opts.queueEntryId ? { queueEntryId: opts.queueEntryId } : {}),
      /* The mock implementation reads live chapter state via this callback;
         the real fetch-based stream ignores it. Either way we close over the
         store, not over any view's props, so generation continues after the
         Generate view unmounts. */
      getChapters: () => store.getState().chapters.chapters,
      /* Each stream binds its own bookId so a tick is always attributable to
         the right book even with several streams running. */
      onTick: (ev: GenerationTick) => onStreamTick(bookId, ev),
    });
    handles.set(bookId, { cancel, bookId, modelKey, chapterIds: ids, completedChapterIds: [] });
  };

  /* Per-stream tick entry point. Row mutation (applyGenerationTick) only fires
     for the VIEWED book — a foreign-book tick would corrupt the viewed book's
     rows (chapter ids collide across books). Side-effects + snapshot refresh
     run for every stream via handleTickFor. */
  const onStreamTick = (bookId: string, ev: GenerationTick | undefined): void => {
    if (!ev) return;
    if (store.getState().chapters.currentBookId === bookId) {
      dispatch(chaptersActions.applyGenerationTick(ev));
    }
    handleTickFor(bookId, ev);
  };

  const handleTickFor = (bookId: string, ev: GenerationTick): void => {
    const handle = handles.get(bookId);
    if (!handle) return;
    const after = store.getState();
    const sliceMatchesHandle = after.chapters.currentBookId === bookId;
    if (sliceMatchesHandle) {
      /* Slice has this book's rows — derive counters from rows so we
         pick up any user-side mutations (excluded toggles etc.). */
      dispatch(
        chaptersActions.setActiveStream(
          snapshotFromChapters(bookId, handle.modelKey, after.chapters),
        ),
      );
    } else if (ev.type !== 'idle') {
      /* Cross-book path. The slice is on a different book so the per-chapter
         tick was not applied; pull counters straight from the tick payload's
         run aggregates so the pill keeps moving and the stall check stays
         fresh. Older servers don't emit the run* fields — `updateActiveStream
         Progress` still bumps lastTickAt so the pill doesn't go spuriously
         stalled. */
      const evRecord = ev as unknown as Record<string, unknown>;
      const runDone = typeof evRecord.runDone === 'number' ? evRecord.runDone : undefined;
      const runTotal = typeof evRecord.runTotal === 'number' ? evRecord.runTotal : undefined;
      const runInProgress =
        typeof evRecord.runInProgress === 'number' ? evRecord.runInProgress : undefined;
      dispatch(
        chaptersActions.updateActiveStreamProgress({
          bookId,
          done: runDone,
          total: runTotal,
          inProgress: runInProgress,
        }),
      );
    }
    if (ev.type === 'chapter_complete' && ev.chapterId != null && sliceMatchesHandle) {
      /* Accumulate — do NOT dispatch a per-chapter event. The rollup goes
         out once on close (run drain / pause). De-dupe so a retry tick or
         re-emitted SSE message doesn't double-count. */
      if (!handle.completedChapterIds.includes(ev.chapterId)) {
        handle.completedChapterIds.push(ev.chapterId);
      }
      /* Flip any pending revisions for this chapter to playable. */
      dispatch(revisionsActions.markRevisionPlayable({ chapterId: ev.chapterId }));
    } else if (ev.type === 'chapter_failed' && ev.chapterId != null && sliceMatchesHandle) {
      const ch = after.chapters.chapters.find((c) => c.id === ev.chapterId);
      if (ch) {
        dispatch(
          changeLogActions.appendLogEvent(
            buildChapterFailedEvent({
              chapter: ch,
              errorReason: ev.errorReason ?? ch.errorReason ?? 'Synthesis failed.',
            }),
          ),
        );
      }
    } else if (ev.type === 'chapter_failed' && ev.chapterId == null && sliceMatchesHandle) {
      /* Stream-level halt (setup / sidecar / cast issue — chapter id absent). */
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: ev.errorReason ?? 'Generation halted.',
          dedupeKey: 'generation-stream',
        }),
      );
    } else if (ev.type === 'idle') {
      /* Server's idle tick is the unambiguous "no more work" signal for this
         book's stream — tear it down (per-book, leaving other streams alive). */
      close(bookId);
    }
  };

  return {
    open,
    close,
    closeAll,
    openBookCount: () => handles.size,
    openBookIds: () => [...handles.keys()],
    hasOpenStreamForBook: (bookId) => handles.has(bookId),
    openChapterIds: () => [...handles.values()].flatMap((h) => h.chapterIds),
  };
}
