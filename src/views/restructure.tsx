/* Full-page chapter restructure view. Mounted at the ready-stage
   `view: 'restructure'` route. Entry from the listen-view header.

   Owns the API plumbing for plan 51's three routes:
   - apply mutates the chapters slice (via setChapters from the response)
   - applies the sentence remap to manuscript slice
   - dispatches a library refresh so completedSlugs / audio state catch up

   On apply error: keeps the panel mounted so the user can retry or back
   out without losing their selection.

   See docs/features/51-restructure-chapters.md. */

import { useCallback, useState } from 'react';
import { useAppDispatch, useAppSelector, store } from '../store';
import { uiActions } from '../store/ui-slice';
import { chaptersActions } from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { libraryActions } from '../store/library-slice';
import { api, type ChapterRestructureResponse } from '../lib/api';
import { RestructureChaptersPanel } from '../components/restructure-chapters-panel';

interface Props {
  bookId: string;
}

export function RestructureView({ bookId }: Props) {
  const dispatch = useAppDispatch();
  const chapters = useAppSelector((s) => s.chapters.chapters);
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const applyResponse = useCallback(
    async (res: ChapterRestructureResponse) => {
      // Re-fetch book-state so chaptersActions.hydrateFromBookState gets
      // a coherent payload: completedSlugs derived from the post-rewrite
      // audio dir, chapterCharacters re-derived from the remapped
      // manuscript-edits.json. The book-state GET handler runs the same
      // reconciliation that surface code expects on a normal page open.
      const fresh = await api.getBookState(bookId).catch(() => null);
      if (fresh) {
        dispatch(
          chaptersActions.hydrateFromBookState({
            bookId,
            chapters: fresh.state.chapters,
            completedSlugs: fresh.completedSlugs ?? [],
            characters: store.getState().cast.characters,
            chapterCharacters: fresh.chapterCharacters,
          }),
        );
      }
      dispatch(
        manuscriptActions.applyChapterRestructure({
          sentenceRemap: res.sentenceRemap ?? [],
        }),
      );
      // Refresh library so the Listen view's chapter card and the
      // generation queue pick up the new structure on next render.
      const lib = await api.getLibrary().catch(() => null);
      if (lib) dispatch(libraryActions.hydrate(lib));
    },
    [bookId, dispatch],
  );

  const handleMerge = useCallback(
    async (chapterIds: number[]) => {
      setBusy(true);
      setErrorBanner(null);
      try {
        const res = await api.mergeChapters(bookId, chapterIds);
        await applyResponse(res);
      } catch (e) {
        setErrorBanner((e as Error).message || 'Merge failed.');
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [bookId, applyResponse],
  );

  const handleSplit = useCallback(
    async (chapterId: number, afterSentenceId: number) => {
      setBusy(true);
      setErrorBanner(null);
      try {
        const res = await api.splitChapter(bookId, chapterId, afterSentenceId);
        await applyResponse(res);
      } catch (e) {
        setErrorBanner((e as Error).message || 'Split failed.');
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [bookId, applyResponse],
  );

  const handleReorder = useCallback(
    async (order: number[]) => {
      setBusy(true);
      setErrorBanner(null);
      try {
        const res = await api.reorderChapters(bookId, order);
        await applyResponse(res);
      } catch (e) {
        setErrorBanner((e as Error).message || 'Reorder failed.');
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [bookId, applyResponse],
  );

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
      <RestructureChaptersPanel
        chapters={chapters}
        sentences={sentences}
        onMerge={handleMerge}
        onSplit={handleSplit}
        onReorder={handleReorder}
        onBack={() => dispatch(uiActions.changeView('listen'))}
        busy={busy}
      />
    </div>
  );
}
