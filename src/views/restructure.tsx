/* Full-page chapter restructure view. Mounted at the ready-stage
   `view: 'restructure'` route. Entry from the listen-view header.

   Owns the API plumbing for plan 51's three routes:
   - apply mutates the chapters slice (via setChapters from the response)
   - applies the sentence remap to manuscript slice
   - dispatches a library refresh so completedSlugs / audio state catch up

   On apply error: keeps the panel mounted so the user can retry or back
   out without losing their selection.

   See docs/features/archive/51-restructure-chapters.md. */

import { useCallback, useState } from 'react';
import { useAppDispatch, useAppSelector, store } from '../store';
import { uiActions } from '../store/ui-slice';
import { chaptersActions } from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { libraryActions } from '../store/library-slice';
import { revisionsActions } from '../store/revisions-slice';
import { activeBookId } from '../store/revisions-thunks';
import { notificationsActions } from '../store/notifications-slice';
import { ANALYSIS_RUNNING_REASON } from '../store/restructure-lock';
import { selectAnalysisRunningForBook } from '../store/analysis-substage-selectors';
import { flushBookPersistence, type BookFlushOutcome } from '../store/persistence-middleware';
import { api, type ChapterRestructureResponse } from '../lib/api';
import { BOOK_READ_TIMEOUT_MS, within } from '../components/layout';
import { RestructureChaptersPanel } from '../components/restructure-chapters-panel';
import { EditChapterTitleModal } from '../modals/edit-chapter-title';
import type { Chapter } from '../lib/types';

interface Props {
  bookId: string;
}

const SAVE_FAILED_BEFORE_RESTRUCTURE =
  "Your last change couldn't be saved, so the chapters weren't changed. Try again.";

export function RestructureView({ bookId }: Props) {
  const dispatch = useAppDispatch();
  const chapters = useAppSelector((s) => s.chapters.chapters);
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const [busy, setBusy] = useState(false);
  /* The server refuses a restructure while an analysis runs for the book. */
  const analysisRunning = useAppSelector((s) => selectAnalysisRunningForBook(s, bookId));
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  /* Plan 78 — rename modal hoisted to view level so the per-row pencil
     button just opens it. */
  const [renamingChapter, setRenamingChapter] = useState<Chapter | null>(null);

  /* #3400 — send this book's queued saves and wait for them before a restructure
     request: one still waiting out its debounce would land after the route's own
     rewrite of manuscript-edits.json, carrying the old chapter ids. `null` (or the
     bare action, without the persistence middleware) means nothing to wait for.
     A save that still fails aborts the restructure, because the route would
     rewrite manuscript-edits.json without it; the kept save is re-sent first on
     the next attempt (#3421). */
  const flushQueuedSaves = useCallback(async () => {
    const writes = dispatch(flushBookPersistence(bookId)) as unknown;
    if (writes instanceof Promise) {
      const outcome = (await writes) as BookFlushOutcome;
      if (outcome.failedSlices.length > 0) throw new Error(SAVE_FAILED_BEFORE_RESTRUCTURE);
    }
  }, [bookId, dispatch]);

  /* #3400 — raise the book's restructure flag and return the matching release. A
     request lowers it only while no later request has raised it again (each raise
     bumps restructureEpochs), so leaving and re-entering Restructure mid-request
     cannot let the first request's end drop the second one's protection. */
  const beginRestructure = useCallback(() => {
    dispatch(uiActions.setRestructuringBook(bookId));
    const epoch = store.getState().ui.restructureEpochs[bookId];
    return () => {
      if (store.getState().ui.restructureEpochs[bookId] === epoch) {
        dispatch(uiActions.clearRestructuringBook(bookId));
      }
    };
  }, [bookId, dispatch]);

  const applyResponse = useCallback(
    async (res: ChapterRestructureResponse, hydrateSeqAtStart: number) => {
      // OD31 — the restructure dropped any pending entry for the touched
      // chapters, so the preview's book can't resume it: clear it here.
      dispatch(uiActions.clearPreviewForBook(bookId));
      // Re-fetch book-state so chaptersActions.hydrateFromBookState gets
      // a coherent payload: completedSlugs derived from the post-rewrite
      // audio dir, chapterCharacters re-derived from the remapped
      // manuscript-edits.json. The book-state GET handler runs the same
      // reconciliation that surface code expects on a normal page open.
      const requestSeq = store.getState().revisions.adoptSeq;
      /* #3967 — both re-reads run with the book's edit lock up, so each is bounded:
         one that never settles must not keep manuscript edits refused until reload. */
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const fresh = await within(api.getBookState(bookId), BOOK_READ_TIMEOUT_MS, timers).catch(() => null);
      /* The user may have opened another book while the re-read was in flight;
         the hydrate's sequence guard only orders same-book reads, so adopt only
         while this book is still the open one (same guard as refetchActiveRevisions). */
      if (fresh && activeBookId(store.getState()) === bookId) {
        /* #3400 — the server drops A/B entries for the touched chapters, so
           adopt its revisions through the same sequence-guarded hydrate book
           open uses; otherwise the dropped entries linger until the next poll. */
        dispatch(revisionsActions.hydrate({ bookId, state: fresh.revisions ?? null, requestSeq }));
        dispatch(
          chaptersActions.hydrateFromBookState({
            bookId,
            chapters: fresh.state.chapters,
            completedSlugs: fresh.completedSlugs ?? [],
            characters: store.getState().cast.characters,
            chapterCharacters: fresh.chapterCharacters,
            /* #3440 — carry the raw→canonical aliases through the
               post-restructure re-hydrate too. */
            characterIdAliases: fresh.characterIdAliases,
          }),
        );
      }
      /* Same cross-book rule for the remap: it rewrites (and drops unmapped)
         whatever sentences the slice holds, so apply it only while the slice
         itself holds this book — the stage can move before the slices do.
         The remap is also only valid for the sentences captured when the
         restructure started: if the slice was re-hydrated meanwhile (book A's
         own layout read landed the server's post-restructure sentences
         first), the server state is authoritative and re-mapping would drop
         or move sentences. A hydrate counter, not array identity: an
         in-place write (emotion detection, bulk-reassign Undo) replaces the
         array but still holds the pre-restructure keys, which need the remap. */
      const after = store.getState();
      if (
        activeBookId(after) === bookId &&
        after.manuscript.bookId === bookId &&
        (after.manuscript.hydrateSeq ?? 0) === hydrateSeqAtStart
      ) {
        dispatch(
          manuscriptActions.applyChapterRestructure({
            sentenceRemap: res.sentenceRemap ?? [],
          }),
        );
      }
      // Refresh library so the Listen view's chapter card and the
      // generation queue pick up the new structure on next render.
      const lib = await within(api.getLibrary(), BOOK_READ_TIMEOUT_MS, timers).catch(() => null);
      timers.forEach(clearTimeout);
      if (lib) dispatch(libraryActions.hydrate(lib));
      // Plan 70b — surface server-emitted advisories (orphan recovery,
      // empty-chapter prune, generic-title renumber from plan 70a).
      for (const message of res.warnings ?? []) {
        dispatch(
          notificationsActions.pushToast({
            kind: 'info',
            message,
            dedupeKey: `restructure-${message.slice(0, 40)}`,
          }),
        );
      }
    },
    [bookId, dispatch],
  );

  const handleMerge = useCallback(
    async (chapterIds: number[]) => {
      setBusy(true);
      const endRestructure = beginRestructure();
      setErrorBanner(null);
      try {
        const hydrateSeqAtStart = store.getState().manuscript.hydrateSeq ?? 0;
        await flushQueuedSaves();
        const res = await api.mergeChapters(bookId, chapterIds);
        await applyResponse(res, hydrateSeqAtStart);
      } catch (e) {
        setErrorBanner((e as Error).message || 'Merge failed.');
        throw e;
      } finally {
        setBusy(false);
        endRestructure();
      }
    },
    [bookId, applyResponse, flushQueuedSaves, beginRestructure],
  );

  const handleSplit = useCallback(
    async (chapterId: number, afterSentenceId: number) => {
      setBusy(true);
      const endRestructure = beginRestructure();
      setErrorBanner(null);
      try {
        const hydrateSeqAtStart = store.getState().manuscript.hydrateSeq ?? 0;
        await flushQueuedSaves();
        const res = await api.splitChapter(bookId, chapterId, afterSentenceId);
        await applyResponse(res, hydrateSeqAtStart);
      } catch (e) {
        setErrorBanner((e as Error).message || 'Split failed.');
        throw e;
      } finally {
        setBusy(false);
        endRestructure();
      }
    },
    [bookId, applyResponse, flushQueuedSaves, beginRestructure],
  );

  const handleReorder = useCallback(
    async (order: number[]) => {
      setBusy(true);
      const endRestructure = beginRestructure();
      setErrorBanner(null);
      try {
        const hydrateSeqAtStart = store.getState().manuscript.hydrateSeq ?? 0;
        await flushQueuedSaves();
        const res = await api.reorderChapters(bookId, order);
        await applyResponse(res, hydrateSeqAtStart);
      } catch (e) {
        setErrorBanner((e as Error).message || 'Reorder failed.');
        throw e;
      } finally {
        setBusy(false);
        endRestructure();
      }
    },
    [bookId, applyResponse, flushQueuedSaves, beginRestructure],
  );

  const handleExclude = useCallback(
    async (chapterId: number, excluded: boolean) => {
      setBusy(true);
      const endRestructure = beginRestructure();
      setErrorBanner(null);
      try {
        const hydrateSeqAtStart = store.getState().manuscript.hydrateSeq ?? 0;
        await flushQueuedSaves();
        const res = await api.excludeChapters(bookId, [chapterId], excluded);
        await applyResponse(res, hydrateSeqAtStart);
      } catch (e) {
        setErrorBanner((e as Error).message || 'Exclude failed.');
        throw e;
      } finally {
        setBusy(false);
        endRestructure();
      }
    },
    [bookId, applyResponse, flushQueuedSaves, beginRestructure],
  );

  const handleRefreshTitles = useCallback(async () => {
    setBusy(true);
    const endRestructure = beginRestructure();
    setErrorBanner(null);
    try {
      const hydrateSeqAtStart = store.getState().manuscript.hydrateSeq ?? 0;
      await flushQueuedSaves();
      const res = await api.refreshChapterTitles(bookId);
      await applyResponse(res, hydrateSeqAtStart);
    } catch (e) {
      setErrorBanner((e as Error).message || 'Refresh chapter names failed.');
      throw e;
    } finally {
      setBusy(false);
      endRestructure();
    }
  }, [bookId, applyResponse, flushQueuedSaves, beginRestructure]);

  return (
    <div className="max-w-3xl mx-auto py-6">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-ink">Restructure chapters</h1>
          <p className="text-sm text-ink/55 mt-0.5">
            Merge, split, or reorder chapters. Sentence attribution and voice
            assignments are preserved across structural edits.
          </p>
        </div>
      </header>
      {errorBanner && (
        <div className="mb-4 rounded-xl border border-magenta/30 bg-magenta/5 px-4 py-3 text-sm text-magenta">
          {errorBanner}
        </div>
      )}
      {analysisRunning && (
        <p data-testid="restructure-analysis-running" className="mb-4 text-sm text-ink/60">
          {ANALYSIS_RUNNING_REASON}
        </p>
      )}
      <RestructureChaptersPanel
        chapters={chapters}
        sentences={sentences}
        onMerge={handleMerge}
        onSplit={handleSplit}
        onReorder={handleReorder}
        onExclude={handleExclude}
        onRefreshTitles={handleRefreshTitles}
        onRename={setRenamingChapter}
        onBack={() => dispatch(uiActions.changeView('listen'))}
        busy={busy || analysisRunning}
      />
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
