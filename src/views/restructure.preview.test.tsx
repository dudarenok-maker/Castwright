/* Plan 286 (OD31) — a restructure of the preview's book clears the preview. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore, Tuple } from '@reduxjs/toolkit';
import { uiSlice, uiActions } from '../store/ui-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { castSlice } from '../store/cast-slice';
import { revisionsSlice, revisionsActions } from '../store/revisions-slice';
import { settingsSlice } from '../store/settings-slice';
import { persistenceMiddleware } from '../store/persistence-middleware';

const { holder, apiMock } = vi.hoisted(() => ({
  holder: { store: null as null | { getState: () => unknown } },
  apiMock: { refreshChapterTitles: vi.fn(), getBookState: vi.fn(), getLibrary: vi.fn(), putBookState: vi.fn() },
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

  /* Merge [2,3] over ch1..4 (one sentence each); held open so a test can write
     to the slice while the request is pending. */
  async function startMerge23(store: ReturnType<typeof makeStore>) {
    const sentence = (chapterId: number, id: number, text: string) => ({ id, chapterId, characterId: 'c', text });
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'm1', title: 'A' } as never,
        sentences: [sentence(1, 1, 'one'), sentence(2, 1, 'two'), sentence(3, 1, 'three'), sentence(4, 1, 'four')] as never,
      }),
    );
    let resolveRestructure!: (v: unknown) => void;
    apiMock.refreshChapterTitles.mockReturnValue(new Promise((r) => (resolveRestructure = r)));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalledWith('b1'));
    const remap = [
      { oldChapterId: 1, oldSentenceId: 1, newChapterId: 1, newSentenceId: 1 },
      { oldChapterId: 2, oldSentenceId: 1, newChapterId: 2, newSentenceId: 1 },
      { oldChapterId: 3, oldSentenceId: 1, newChapterId: 2, newSentenceId: 2 },
      { oldChapterId: 4, oldSentenceId: 1, newChapterId: 3, newSentenceId: 1 },
    ];
    return () => resolveRestructure({ sentenceRemap: remap, warnings: [] });
  }
  const keys = (store: ReturnType<typeof makeStore>) =>
    store.getState().manuscript.sentences.map((x) => `${x.chapterId}:${x.id}:${x.text}:${x.emotion ?? ''}`);

  it('still applies the remap when a same-book write (emotion detection) replaced the sentences array mid-request', async () => {
    const store = makeStore();
    const resolve = await startMerge23(store);
    store.dispatch(
      manuscriptSlice.actions.applyDetectedEmotions({ chapterId: 4, annotations: [{ sentenceId: 1, emotion: 'sad' }] }),
    );
    resolve();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    expect(keys(store)).toEqual(['1:1:one:', '2:1:two:', '2:2:three:', '3:1:four:sad']);
  });

  it("skips the remap when the slice was re-pointed at another book without a sentence hydrate", async () => {
    const store = makeStore();
    const resolve = await startMerge23(store);
    // B's analysis lands with no sentences: the slice keeps A's array but is now B's.
    store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({ bookId: 'b2' } as never));
    resolve();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    expect(keys(store)).toEqual(['1:1:one:', '2:1:two:', '3:1:three:', '4:1:four:']);
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

/* #3400 pass 5 — the disk half of the remap. A save is built when its action is
   dispatched and sent one debounce later, so one queued before (or during) a
   restructure lands AFTER the server's own manuscript-edits.json rewrite carrying
   the old chapter ids; the remap has to be saved last. The mock "disk" is whatever
   the server rewrite or the latest manuscript PUT left, applied in arrival order. */
describe('RestructureView — #3400 the remapped manuscript is what ends up on disk', () => {
  const sentence = (chapterId: number, id: number, text: string) => ({ id, chapterId, characterId: 'c', text });
  const remap = [
    { oldChapterId: 1, oldSentenceId: 1, newChapterId: 1, newSentenceId: 1 },
    { oldChapterId: 2, oldSentenceId: 1, newChapterId: 2, newSentenceId: 1 },
    { oldChapterId: 3, oldSentenceId: 1, newChapterId: 2, newSentenceId: 2 },
    { oldChapterId: 4, oldSentenceId: 1, newChapterId: 3, newSentenceId: 1 },
  ];
  const REMAPPED = ['1:1:one', '2:1:two', '2:2:three', '3:1:four'];
  let disk: string[];
  let resolveRestructure: () => void;

  async function setup() {
    disk = [];
    apiMock.putBookState.mockReset().mockImplementation(async (_id: string, w: { slice: string; patch: { sentences?: Array<{ chapterId: number; id: number; text: string }> } }) => {
      if (w.slice === 'manuscript') disk = w.patch.sentences!.map((x) => `${x.chapterId}:${x.id}:${x.text}`);
    });
    apiMock.refreshChapterTitles.mockReset().mockImplementation(
      () =>
        new Promise((r) => {
          disk = REMAPPED; // the route rewrites manuscript-edits.json before it answers
          resolveRestructure = () => r({ sentenceRemap: remap, warnings: [] });
        }),
    );
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, chapters: chaptersSlice.reducer, manuscript: manuscriptSlice.reducer, library: librarySlice.reducer, notifications: notificationsSlice.reducer, cast: castSlice.reducer, revisions: revisionsSlice.reducer, settings: settingsSlice.reducer },
      preloadedState: { settings: { ...settingsSlice.getInitialState(), autosaveDebounceMs: 40 } },
      middleware: () => new Tuple(persistenceMiddleware),
    });
    holder.store = store;
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' } as never));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'm1', title: 'A' } as never,
        sentences: [sentence(1, 1, 'one'), sentence(2, 1, 'two'), sentence(3, 1, 'three'), sentence(4, 1, 'four')] as never,
      }),
    );
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    const confirm = await screen.findByTestId('restructure-confirm-apply');
    return { store, confirm };
  }
  const edit = (store: Awaited<ReturnType<typeof setup>>['store']) =>
    store.dispatch(manuscriptSlice.actions.setSentenceEmotion({ chapterId: 4, sentenceId: 1, emotion: 'sad' } as never));
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('a write made just before the click is sent before the request, and the remap is saved after it', async () => {
    const { store, confirm } = await setup();
    edit(store);
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    resolveRestructure();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await settle();
    expect(disk).toEqual(REMAPPED);
  });

  it("a write made just before the click cannot land after the rewrite when the remap is skipped because the slice was already re-hydrated", async () => {
    const { store, confirm } = await setup();
    edit(store);
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    // A's own layout read landed post-restructure, so applyResponse skips the remap and saves nothing.
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'm1', title: 'A' } as never,
        sentences: [sentence(1, 1, 'one'), sentence(2, 1, 'two'), sentence(2, 2, 'three'), sentence(3, 1, 'four')] as never,
      }),
    );
    resolveRestructure();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await settle();
    expect(disk).toEqual(REMAPPED);
  });

  it('a write made mid-request, still queued when the answer arrives, does not outlive the remap', async () => {
    const { store, confirm } = await setup();
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    edit(store);
    resolveRestructure();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await settle();
    expect(disk).toEqual(REMAPPED);
  });

  it('a write made mid-request and already sent before the answer arrives is overwritten by the remap', async () => {
    const { store, confirm } = await setup();
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    edit(store);
    await settle(); // the debounce fires: old keys reach disk after the server's rewrite
    expect(disk).toEqual(['1:1:one', '2:1:two', '3:1:three', '4:1:four']);
    resolveRestructure();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await settle();
    expect(disk).toEqual(REMAPPED);
  });
});

/* #3400 pass 5 — the restructure flag keeps an emotion run's book from being filled in
   under the old structure; it must be up for the whole request and must not be lowered
   by a request that has been superseded. */
describe('RestructureView — #3400 restructure flag', () => {
  const flag = (store: ReturnType<typeof makeStore>) => store.getState().ui.restructuringBookId;
  async function startRefresh() {
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
  }

  it('is set while the request is in flight and cleared once it has been applied', async () => {
    const store = makeStore();
    let resolve!: (v: unknown) => void;
    apiMock.refreshChapterTitles.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    expect(flag(store)).toBeNull();
    await startRefresh();
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalledWith('b1'));
    expect(flag(store)).toBe('b1');
    resolve({ sentenceRemap: [], warnings: [] });
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await waitFor(() => expect(flag(store)).toBeNull());
  });

  it('is cleared when the request fails', async () => {
    const store = makeStore();
    apiMock.refreshChapterTitles.mockRejectedValue(new Error('boom'));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    await startRefresh();
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    await waitFor(() => expect(flag(store)).toBeNull());
  });

  it('stays up for a second request when the first, from a view that was left, finishes first', async () => {
    const store = makeStore();
    const resolvers: Array<(v: unknown) => void> = [];
    apiMock.refreshChapterTitles.mockImplementation(() => new Promise((r) => resolvers.push(r)));
    const first = render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    await startRefresh();
    await waitFor(() => expect(resolvers).toHaveLength(1));
    first.unmount(); // leave Restructure mid-request, then come back to a fresh view
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    await startRefresh();
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0]({ sentenceRemap: [], warnings: [] });
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(flag(store)).toBe('b1'); // the second request is still running
    resolvers[1]({ sentenceRemap: [], warnings: [] });
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(flag(store)).toBeNull());
  });
});
