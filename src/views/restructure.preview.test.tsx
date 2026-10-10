/* Plan 286 (OD31) — a restructure of the preview's book clears the preview. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { uiSlice, uiActions } from '../store/ui-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { castSlice } from '../store/cast-slice';
import { revisionsSlice, revisionsActions } from '../store/revisions-slice';

const { holder, apiMock } = vi.hoisted(() => ({
  holder: { store: null as null | { getState: () => unknown } },
  apiMock: { refreshChapterTitles: vi.fn(), getBookState: vi.fn(), getLibrary: vi.fn() },
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: apiMock }));
vi.mock('../store', async () => {
  const rr = await import('react-redux');
  return { useAppDispatch: rr.useDispatch, useAppSelector: rr.useSelector, store: { getState: () => holder.store!.getState() } };
});

import { RestructureView } from './restructure';

function makeStore() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer, chapters: chaptersSlice.reducer, manuscript: manuscriptSlice.reducer, library: librarySlice.reducer, notifications: notificationsSlice.reducer, cast: castSlice.reducer, revisions: revisionsSlice.reducer } });
  holder.store = store;
  store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' } as never));
  return store;
}
const preview = (bookId: string) => ({ bookId, characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '', completed: { reviewOutcome: 'none' as const, stubFallback: true } });

beforeEach(() => {
  apiMock.refreshChapterTitles.mockReset().mockResolvedValue({ sentenceRemap: [], warnings: [] });
  apiMock.getBookState.mockReset().mockResolvedValue(null);
  apiMock.getLibrary.mockReset().mockResolvedValue(null);
});

async function refreshTitles(store: ReturnType<typeof makeStore>) {
  render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
  fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
  fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
  await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalledWith('b1'));
  await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled()); // applyResponse ran to its end
}

describe('RestructureView — OD31', () => {
  it("a restructure of the preview's book clears the preview", async () => {
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(preview('b1')));
    await refreshTitles(store);
    expect(store.getState().ui.previewRegen).toBeNull();
  });
});

describe('RestructureView — #3400 revisions adoption', () => {
  it('adopts the refetched book-state revisions, dropping entries the server removed, without waiting for a poll', async () => {
    const store = makeStore();
    store.dispatch(
      revisionsActions.hydrate({
        bookId: 'b1',
        state: { fileId: '000000000000001-aaaa', rev: 1, pending: [{ id: 'rev-stale', chapterId: 1 }] } as never,
      }),
    );
    expect(store.getState().revisions.pending).toHaveLength(1);
    apiMock.getBookState.mockResolvedValue({
      state: { chapters: [] },
      completedSlugs: [],
      revisions: { fileId: '000000000000001-aaaa', rev: 2, pending: [] },
    });
    await refreshTitles(store);
    expect(store.getState().revisions.pending).toEqual([]);
    expect(store.getState().revisions.rev).toBe(2);
  });
});

describe('RestructureView — #3400 cross-book guard', () => {
  it("does not adopt book A's re-read into the revisions cache once book B is open", async () => {
    const store = makeStore();
    let resolveA!: (v: unknown) => void;
    apiMock.getBookState.mockReturnValue(new Promise((r) => (resolveA = r)));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(apiMock.getBookState).toHaveBeenCalledWith('b1'));
    // The user switches to book B (cache seeded) while A's re-read is in flight.
    store.dispatch(uiActions.openBook({ id: 'b2', status: 'complete' } as never));
    store.dispatch(
      revisionsActions.hydrate({
        bookId: 'b2',
        state: { fileId: '000000000000002-bbbb', rev: 5, pending: [{ id: 'rev-b2', chapterId: 1 }] } as never,
      }),
    );
    resolveA({ state: { chapters: [] }, completedSlugs: [], revisions: { fileId: '000000000000001-aaaa', rev: 9, pending: [] } });
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled()); // applyResponse ran to its end
    expect(store.getState().revisions.pending).toEqual([{ id: 'rev-b2', chapterId: 1 }]);
    expect(store.getState().revisions.rev).toBe(5);
  });
});

describe('RestructureView — #3400 cross-book slices', () => {
  const sent = (id: number) => ({ id, chapterId: 1, characterId: 'c', text: `b2 sentence ${id}` });
  /* Start A's restructure, hold its book-state re-read open, then switch to B
     with B's manuscript + chapters seeded; returns the resolver for A's read. */
  async function startAThenSwitchToB(store: ReturnType<typeof makeStore>) {
    let resolveA!: (v: unknown) => void;
    apiMock.getBookState.mockReturnValue(new Promise((r) => (resolveA = r)));
    // A's restructure maps nothing, so an unguarded remap would drop every sentence it touches.
    apiMock.refreshChapterTitles.mockResolvedValue({ sentenceRemap: [], warnings: [] });
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(apiMock.getBookState).toHaveBeenCalledWith('b1'));
    store.dispatch(uiActions.openBook({ id: 'b2', status: 'complete' } as never));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b2', manuscriptId: 'm2', title: 'B2' } as never,
        sentences: [sent(1), sent(2)] as never,
      }),
    );
    store.dispatch(
      chaptersSlice.actions.hydrateFromBookState({
        bookId: 'b2',
        chapters: [{ id: 7, title: 'B2 chapter' }] as never,
        completedSlugs: [],
        characters: [],
      } as never),
    );
    return resolveA;
  }

  it("does not apply book A's sentence remap to book B's manuscript", async () => {
    const store = makeStore();
    const resolveA = await startAThenSwitchToB(store);
    resolveA({ state: { chapters: [{ id: 1, title: 'A chapter' }] }, completedSlugs: [] });
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    expect(store.getState().manuscript.bookId).toBe('b2');
    expect(store.getState().manuscript.sentences).toHaveLength(2);
  });

  it("does not re-apply the remap over sentences A's own layout read already hydrated post-restructure", async () => {
    const store = makeStore();
    const sentence = (chapterId: number, id: number, text: string) => ({ id, chapterId, characterId: 'c', text });
    const hydrateA = (sentences: unknown[]) =>
      store.dispatch(
        manuscriptSlice.actions.hydrateFromBookState({
          state: { bookId: 'b1', manuscriptId: 'm1', title: 'A' } as never,
          sentences: sentences as never,
        }),
      );
    // Pre-restructure: ch1 = one, ch2 = two, ch3 = three, ch4 = four.
    hydrateA([sentence(1, 1, 'one'), sentence(2, 1, 'two'), sentence(3, 1, 'three'), sentence(4, 1, 'four')]);
    // Merge [2,3] -> ch2 holds two+three; four moves 3 -> 2's successor. The remap is
    // delivered through the same applyResponse path every restructure route uses.
    const remap = [
      { oldChapterId: 1, oldSentenceId: 1, newChapterId: 1, newSentenceId: 1 },
      { oldChapterId: 2, oldSentenceId: 1, newChapterId: 2, newSentenceId: 1 },
      { oldChapterId: 3, oldSentenceId: 1, newChapterId: 2, newSentenceId: 2 },
      { oldChapterId: 4, oldSentenceId: 1, newChapterId: 3, newSentenceId: 1 },
    ];
    const serverFresh = [sentence(1, 1, 'one'), sentence(2, 1, 'two'), sentence(2, 2, 'three'), sentence(3, 1, 'four')];
    let resolveRestructure!: (v: unknown) => void;
    apiMock.refreshChapterTitles.mockReturnValue(new Promise((r) => (resolveRestructure = r)));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalledWith('b1'));
    // The user bounced A->B->A and A's own layout read landed first, already post-restructure.
    hydrateA(serverFresh);
    resolveRestructure({ sentenceRemap: remap, warnings: [] });
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    expect(store.getState().manuscript.sentences).toEqual(serverFresh);
  });

  it('applies the remap once when the slice still holds the sentences captured at click time', async () => {
    const store = makeStore();
    const sentence = (chapterId: number, id: number, text: string) => ({ id, chapterId, characterId: 'c', text });
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'm1', title: 'A' } as never,
        sentences: [sentence(2, 1, 'two'), sentence(3, 1, 'three')] as never,
      }),
    );
    apiMock.refreshChapterTitles.mockResolvedValue({
      sentenceRemap: [
        { oldChapterId: 2, oldSentenceId: 1, newChapterId: 2, newSentenceId: 1 },
        { oldChapterId: 3, oldSentenceId: 1, newChapterId: 2, newSentenceId: 2 },
      ],
      warnings: [],
    });
    await refreshTitles(store);
    expect(store.getState().manuscript.sentences).toEqual([sentence(2, 1, 'two'), sentence(2, 2, 'three')]);
  });

  it("does not hydrate book A's chapters over book B's chapters slice", async () => {
    const store = makeStore();
    const resolveA = await startAThenSwitchToB(store);
    resolveA({ state: { chapters: [{ id: 1, title: 'A chapter' }] }, completedSlugs: [] });
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    expect(store.getState().chapters.currentBookId).toBe('b2');
    expect(store.getState().chapters.chapters.map((c) => c.id)).toEqual([7]);
  });
});
