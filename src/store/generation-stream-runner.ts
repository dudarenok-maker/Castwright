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
  /** The single chapter this stream renders (queue-sole concurrency: one
      queue worker = one chapter). Used to key the handle map so two
      same-book chapters open independent concurrent streams instead of one
      aborting the other. Absent only on the legacy/back-compat open path
      (no specific chapter), which keys by `${bookId}::*`. */
  chapterId?: number;
}

/** Composite handle key — `${bookId}::${chapterId}` (or `${bookId}::*` when
    no chapter is named). The singleton guard now guards the CHAPTER, so two
    chapters of the same book stream concurrently. */
function streamKey(bookId: string, chapterId: number | undefined): string {
  return `${bookId}::${chapterId == null ? '*' : chapterId}`;
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
  /** The composite key this handle is stored under (`${bookId}::${chapterId}`
      or `${bookId}::*`). Carried so close() can clear the right
      activeStreams entry. */
  key: string;
  /** The single chapter this stream renders, when known. Null on the
      back-compat `*` open. */
  chapterId: number | null;
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
      already open FOR THE SAME CHAPTER (the per-chapter singleton). Under
      queue-sole concurrency the server keys jobs by `${bookId}::${chapterId}`,
      so two chapters of the SAME book open independent concurrent streams —
      they no longer abort each other. Pass `opts.chapterId` so the handle is
      keyed per chapter; absent → the back-compat `${bookId}::*` key. */
  open(bookId: string, modelKey: TtsModelKey, spec: StreamSpec | null, opts?: StreamOpenOpts): void;
  /** Tear down ONE stream by its composite key (`${bookId}::${chapterId}`),
      flushing its run rollup and clearing that stream's snapshot. No-op when
      nothing is open for the key. */
  close(key: string): void;
  /** Tear down every open stream — store teardown / hard reset. */
  closeAll(): void;
  /** Number of streams currently open (the dispatcher's N-slot gate is now
      chapter-level, so this counts chapters). */
  openBookCount(): number;
  /** DISTINCT book ids across all open streams — used by the halt path to
      pause each book once. */
  openBookIds(): string[];
  /** Is a stream open for this specific (book, chapter)? — the per-chapter
      singleton check the dispatcher uses to fill + reconcile per chapter. */
  hasOpenStreamForChapter(bookId: string, chapterId: number): boolean;
  /** Is ANY stream open for this book? — kept for the halt path. */
  hasOpenStreamForBook(bookId: string): boolean;
  /** Union of chapter ids across all open streams — so the dispatcher never
      claims a chapter that's already rendering. */
  openChapterIds(): number[];
  /** Return + CLEAR the recorded synthesis-failure reason for a (book,
      chapter), or null if it didn't fail. The dispatcher calls this during
      reconcile to decide whether the entry is marked `failed` (lingers for
      retry) or done-pruned. One-shot so a later success can't read a stale
      failure. */
  takeChapterFailure(bookId: string, chapterId: number): string | null;
}

function snapshotFromChapters(
  streamKey: string,
  bookId: string,
  chapterId: number | null,
  modelKey: TtsModelKey,
  state: ChaptersState,
): ActiveStreamSnapshot {
  /* Counters mirror the active-subset filter used in the Generate view
     (`activeChapters` in src/views/generation.tsx): excluded chapters
     never queue or synthesise, so they must not inflate `total` or
     stall the cross-book top-bar pill's done/total readout. */
  const active = state.chapters.filter((c) => !c.excluded);
  return {
    streamKey,
    bookId,
    chapterId,
    modelKey,
    done: active.filter((c) => c.state === 'done').length,
    total: active.length,
    inProgress: active.filter((c) => c.state === 'in_progress').length,
    lastTickAt: state.lastTickAt,
    halted: state.lastError != null,
  };
}

export function createStreamRunner(store: StreamRunnerStore): StreamRunner {
  /* Queue-sole concurrency — one handle per CHAPTER, keyed
     `${bookId}::${chapterId}`. The server keys jobs by the same composite, so
     two chapters of the same book stream concurrently without aborting each
     other; the dispatcher's N-slot gate counts chapters. */
  const handles = new Map<string, OpenHandle>();
  /* Per-chapter synthesis failures, keyed `${bookId}::${chapterId}`, recorded
     on a `chapter_failed` tick and read+cleared by the dispatcher during
     reconcile (`takeChapterFailure`) so the queue entry is marked `failed`
     (lingers for retry) instead of done-pruned. Outlives the stream close that
     `idle` triggers — close() removes the handle, not this map. */
  const chapterFailures = new Map<string, string>();
  const dispatch = store.dispatch;

  const close = (key: string): void => {
    const handle = handles.get(key);
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
    handles.delete(key);
    /* Per-stream snapshot key — each chapter stream owns its own
       activeStreams entry, so clearing one leaves a sibling chapter's pill
       alive. */
    dispatch(chaptersActions.clearActiveStream(key));
  };

  const closeAll = (): void => {
    for (const key of [...handles.keys()]) close(key);
  };

  const open = (
    bookId: string,
    modelKey: TtsModelKey,
    spec: StreamSpec | null,
    opts: StreamOpenOpts = {},
  ): void => {
    const key = streamKey(bookId, opts.chapterId);
    /* Per-chapter singleton — never stack a second stream for the SAME
       chapter (the server would abort its prior run). Sibling chapters of the
       same book, and different books, open concurrently. */
    if (handles.has(key)) return;

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

    const chapterId = opts.chapterId ?? null;

    /* Seed this stream's snapshot, keyed by the composite stream key so two
       same-book chapters get independent entries. Same-book: derive from the
       slice's rows (it IS this book's data right now). Cross-book: the slice
       holds the wrong book, so seed a minimal placeholder; the first tick's
       run* aggregates refresh it via updateActiveStreamProgress. */
    const seed: ActiveStreamSnapshot = sliceOnThisBook
      ? snapshotFromChapters(key, bookId, chapterId, modelKey, after.chapters)
      : {
          streamKey: key,
          bookId,
          chapterId,
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
      /* Each stream binds its own composite key so a tick is always
         attributable to the right (book, chapter) even with several streams
         running. */
      onTick: (ev: GenerationTick) => onStreamTick(key, ev),
    });
    handles.set(key, {
      cancel,
      bookId,
      key,
      chapterId,
      modelKey,
      chapterIds: ids,
      completedChapterIds: [],
    });
  };

  /* Per-stream tick entry point. Keyed by the composite stream key. Row
     mutation (applyGenerationTick) only fires for the VIEWED book — a
     foreign-book tick would corrupt the viewed book's rows (chapter ids
     collide across books). Side-effects + snapshot refresh run for every
     stream via handleTickFor. */
  const onStreamTick = (key: string, ev: GenerationTick | undefined): void => {
    if (!ev) return;
    const handle = handles.get(key);
    if (!handle) return;
    if (store.getState().chapters.currentBookId === handle.bookId) {
      dispatch(chaptersActions.applyGenerationTick(ev));
    }
    handleTickFor(key, ev);
  };

  const handleTickFor = (key: string, ev: GenerationTick): void => {
    const handle = handles.get(key);
    if (!handle) return;
    const bookId = handle.bookId;
    const after = store.getState();
    const sliceMatchesHandle = after.chapters.currentBookId === bookId;
    if (sliceMatchesHandle) {
      /* Slice has this book's rows — derive counters from rows so we
         pick up any user-side mutations (excluded toggles etc.). */
      dispatch(
        chaptersActions.setActiveStream(
          snapshotFromChapters(key, bookId, handle.chapterId, handle.modelKey, after.chapters),
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
          streamKey: key,
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
    } else if (ev.type === 'chapter_failed' && ev.chapterId != null) {
      /* Record the failure UNCONDITIONALLY (not gated on sliceMatchesHandle) —
         a cross-book chapter's queue entry must still be marked `failed` even
         though its rows aren't in the viewed slice. The dispatcher reads this
         on the reconcile that follows the `idle` close. */
      chapterFailures.set(
        streamKey(bookId, ev.chapterId),
        ev.errorReason ?? 'Synthesis failed.',
      );
      if (sliceMatchesHandle) {
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
    } else if (ev.type === 'warning' && ev.message) {
      /* Non-fatal run-setup advisory (e.g. a Qwen→Kokoro engine downgrade, or
         dual-model-off with a mixed cast). The run still proceeds, but the user
         MUST see it — a silent Qwen→Kokoro fallback renders a whole book in the
         wrong voices unnoticed. Dedupe by code so a re-emit (or per-chapter
         stream) doesn't stack identical toasts. */
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message: ev.message,
          dedupeKey: `generation-warning:${ev.code ?? ev.message}`,
        }),
      );
    } else if (ev.type === 'idle') {
      /* Server's idle tick is the unambiguous "no more work" signal for this
         chapter's stream — tear it down by its composite key, leaving sibling
         chapter streams (same book or other books) alive. */
      close(key);
    }
  };

  return {
    open,
    close,
    closeAll,
    /* Counts STREAMS (one per chapter now) — the dispatcher's N-slot gate is
       chapter-level. */
    openBookCount: () => handles.size,
    /* DISTINCT books across open streams — the halt path pauses each book
       once even when several of its chapters are streaming. */
    openBookIds: () => [...new Set([...handles.values()].map((h) => h.bookId))],
    hasOpenStreamForChapter: (bookId, chapterId) => handles.has(streamKey(bookId, chapterId)),
    hasOpenStreamForBook: (bookId) => [...handles.values()].some((h) => h.bookId === bookId),
    openChapterIds: () => [...handles.values()].flatMap((h) => h.chapterIds),
    takeChapterFailure: (bookId, chapterId) => {
      const key = streamKey(bookId, chapterId);
      const reason = chapterFailures.get(key);
      if (reason === undefined) return null;
      chapterFailures.delete(key);
      return reason;
    },
  };
}
