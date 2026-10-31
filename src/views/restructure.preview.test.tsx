/* Plan 286 (OD31) — a restructure of the preview's book clears the preview. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
import { analysisSlice, analysisActions } from '../store/analysis-slice';
import { ANALYSIS_RUNNING_REASON } from '../store/restructure-lock';
import { persistenceMiddleware } from '../store/persistence-middleware';
import { restructureGuardMiddleware } from '../store/restructure-guard-middleware';

const { holder, apiMock } = vi.hoisted(() => ({
  holder: { store: null as null | { getState: () => unknown } },
  apiMock: { refreshChapterTitles: vi.fn(), mergeChapters: vi.fn(), getBookState: vi.fn(), getLibrary: vi.fn(), putBookState: vi.fn() },
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: apiMock }));
vi.mock('../store', async () => {
  const rr = await import('react-redux');
  return { useAppDispatch: rr.useDispatch, useAppSelector: rr.useSelector, store: { getState: () => holder.store!.getState() } };
});

import { RestructureView } from './restructure';
import { BOOK_READ_TIMEOUT_MS } from '../lib/book-read';

/* `guard` installs the real restructure guard (first in the chain, as in the app store):
   a user edit made mid-request is refused. Without it the store models a writer that
   bypasses the guard (a non-UI writer, or a write queued before the flag went up). */
function makeStore(guard = false) {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer, chapters: chaptersSlice.reducer, manuscript: manuscriptSlice.reducer, library: librarySlice.reducer, notifications: notificationsSlice.reducer, cast: castSlice.reducer, revisions: revisionsSlice.reducer, analysis: analysisSlice.reducer },
    middleware: (g) => (guard ? g().prepend(restructureGuardMiddleware) : g()),
  });
  holder.store = store;
  store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' } as never));
  return store;
}
const preview = (bookId: string) => ({ bookId, characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '', completed: { reviewOutcome: 'none' as const, stubFallback: true } });

beforeEach(() => {
  apiMock.refreshChapterTitles.mockReset().mockResolvedValue({ sentenceRemap: [], warnings: [] });
  apiMock.mergeChapters.mockReset().mockResolvedValue({ sentenceRemap: [], warnings: [] });
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

  it('refuses a user edit made mid-request, visibly, and the remap lands on the untouched sentences (the real guard)', async () => {
    const store = makeStore(true);
    const resolve = await startMerge23(store);
    store.dispatch(
      manuscriptSlice.actions.setSentenceEmotion({ chapterId: 4, sentenceId: 1, emotion: 'sad' } as never),
    );
    expect(keys(store)).toEqual(['1:1:one:', '2:1:two:', '3:1:three:', '4:1:four:']);
    expect(store.getState().notifications.toasts.map((t) => t.dedupeKey)).toContain('restructuring-edit-refused');
    resolve();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    expect(keys(store)).toEqual(['1:1:one:', '2:1:two:', '2:2:three:', '3:1:four:']);
  });

  it('still applies the remap when a write that bypasses the guard (a non-UI writer: emotion detection) replaced the sentences array mid-request', async () => {
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

  async function setup(guard = false) {
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
      middleware: () => (guard ? new Tuple(restructureGuardMiddleware, persistenceMiddleware) : new Tuple(persistenceMiddleware)),
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

  it('waits for a queued save to finish before it sends the restructure request', async () => {
    const { store, confirm } = await setup();
    const order: string[] = [];
    apiMock.putBookState.mockImplementation(async () => {
      order.push('put-start');
      await new Promise((r) => setTimeout(r, 120));
      order.push('put-end');
    });
    apiMock.refreshChapterTitles.mockImplementation(async () => {
      order.push('restructure');
      return { sentenceRemap: [], warnings: [] };
    });
    edit(store);
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    expect(order).toEqual(['put-start', 'put-end', 'restructure']);
  });

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

  it('a user edit made mid-request is refused by the guard: no save is queued and the remap is what ends up on disk', async () => {
    const { store, confirm } = await setup(true);
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    edit(store);
    await settle();
    expect(apiMock.putBookState).not.toHaveBeenCalled();
    expect(disk).toEqual(REMAPPED);
    resolveRestructure();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await settle();
    expect(disk).toEqual(REMAPPED);
  });

  it('a write that bypasses the guard (queued, not yet sent) when the answer arrives does not outlive the remap', async () => {
    const { store, confirm } = await setup();
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalled());
    edit(store);
    resolveRestructure();
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await settle();
    expect(disk).toEqual(REMAPPED);
  });

  it('a write that bypasses the guard and was already sent before the answer arrives is overwritten by the remap', async () => {
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
  const flag = (store: ReturnType<typeof makeStore>) => store.getState().ui.restructuringBooks['b1'] ? 'b1' : null;
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

  /* #3967 — the re-reads run with the flag up; one that never settles must not hold it. */
  it.each(['getBookState', 'getLibrary'] as const)('is cleared when the %s re-read never settles', async (hung) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const store = makeStore();
      apiMock[hung].mockReturnValue(new Promise(() => {}));
      render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
      await startRefresh();
      await waitFor(() => expect(apiMock[hung]).toHaveBeenCalled());
      expect(flag(store)).toBe('b1');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOOK_READ_TIMEOUT_MS * 2);
      });
      await waitFor(() => expect(flag(store)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("book A's request ending does not lower book B's flag (pass-6 cross-book)", async () => {
    const store = makeStore();
    const resolvers: Array<(v: unknown) => void> = [];
    apiMock.refreshChapterTitles.mockImplementation(() => new Promise((r) => resolvers.push(r)));
    const a = render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    await startRefresh();
    await waitFor(() => expect(resolvers).toHaveLength(1));
    a.unmount();
    render(<Provider store={store}><RestructureView bookId="b2" /></Provider>);
    await startRefresh();
    await waitFor(() => expect(resolvers).toHaveLength(2));
    expect(store.getState().ui.restructuringBooks).toEqual({ b1: true, b2: true });
    resolvers[0]({ sentenceRemap: [], warnings: [] });
    await waitFor(() => expect(store.getState().ui.restructuringBooks).toEqual({ b2: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().ui.restructuringBooks).toEqual({ b2: true });
    resolvers[1]({ sentenceRemap: [], warnings: [] });
    await waitFor(() => expect(store.getState().ui.restructuringBooks).toEqual({}));
  });
});

describe('RestructureView — analysis running (server refuses a restructure mid-run)', () => {
  const running = (bookId: string) =>
    analysisActions.setActiveStream({
      bookId,
      manuscriptId: 'm1',
      phaseId: 1,
      phaseLabel: 'Parsing',
      phaseProgress: 0.2,
      remainingMs: null,
      lastTickAt: 0,
      state: 'running',
    });

  it('disables the restructure controls with a visible reason while this book is being analysed', () => {
    const store = makeStore();
    store.dispatch(running('b1'));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    expect(screen.getByTestId('restructure-analysis-running')).toHaveTextContent(ANALYSIS_RUNNING_REASON);
    expect(screen.getByTestId('restructure-refresh-titles')).toBeDisabled();
  });

  it('leaves them enabled when the analysis is for another book', () => {
    const store = makeStore();
    store.dispatch(running('other'));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    expect(screen.queryByTestId('restructure-analysis-running')).toBeNull();
    expect(screen.getByTestId('restructure-refresh-titles')).not.toBeDisabled();
  });

  it("a 409 from the server (a job started in another tab) shows its message and clears the restructuring flag", async () => {
    const store = makeStore();
    apiMock.refreshChapterTitles.mockRejectedValue(new Error('Analysis is running on this book. Pause it or wait for it to finish, then change the chapters.'));
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
    expect(await screen.findByText(/Analysis is running on this book/)).toBeInTheDocument();
    await waitFor(() => expect(store.getState().ui.restructuringBooks['b1']).toBeFalsy());
  });
});

/* #3421 — a save that still fails before a restructure aborts it; the kept save is
   re-sent first on the next attempt. */
describe('RestructureView — a failed save before a restructure aborts it (#3421)', () => {
  const ABORT_MESSAGE = "Your last change couldn't be saved, so the chapters weren't changed. Try again.";
  const sentence = (chapterId: number, id: number, text: string) => ({ id, chapterId, characterId: 'c', text });
  let diskSentences: Array<{ chapterId: number; id: number; emotion?: string }>;
  let events: string[];

  async function setupMerge() {
    diskSentences = [];
    events = [];
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
    store.dispatch(
      chaptersSlice.actions.hydrateFromBookState({
        bookId: 'b1',
        chapters: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }] as never,
        completedSlugs: [],
        characters: [],
      } as never),
    );
    apiMock.mergeChapters.mockImplementation(async () => {
      events.push('merge');
      return { sentenceRemap: [], warnings: [] };
    });
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-check-1'));
    fireEvent.click(screen.getByTestId('restructure-check-2'));
    fireEvent.click(screen.getByTestId('restructure-merge-button'));
    return store;
  }
  const putSucceeds = () =>
    apiMock.putBookState.mockReset().mockImplementation(async (_id: string, w: { slice: string; patch: { sentences?: typeof diskSentences } }) => {
      if (w.slice === 'manuscript') {
        events.push('put');
        diskSentences = w.patch.sentences!;
      }
    });
  const putFails = (message: string) => apiMock.putBookState.mockReset().mockRejectedValue(new Error(message));
  const editSad = (store: Awaited<ReturnType<typeof setupMerge>>) =>
    store.dispatch(manuscriptSlice.actions.setSentenceEmotion({ chapterId: 4, sentenceId: 1, emotion: 'sad' } as never));
  const sadInMemory = (store: Awaited<ReturnType<typeof setupMerge>>) =>
    store.getState().manuscript.sentences.find((x) => x.chapterId === 4)?.emotion;

  it('aborts, and does not call the route, when the save is refused', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    putFails('Book state PUT failed (409): refused');
    const store = await setupMerge();
    editSad(store);
    fireEvent.click(screen.getByTestId('restructure-confirm-apply'));
    expect((await screen.findAllByText(ABORT_MESSAGE)).length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(apiMock.mergeChapters).not.toHaveBeenCalled();
    expect(sadInMemory(store)).toBe('sad');
    expect(store.getState().ui.restructuringBooks['b1']).toBeFalsy();
    err.mockRestore();
  });

  it('(ii) clicked twice: the kept save is re-sent first, then the restructure runs', async () => {
    /* Fake timers (shouldAdvanceTime) so the 7 s of retries run without waiting. */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      putFails('Book state PUT failed (503): down');
      const store = await setupMerge();
      editSad(store);
      fireEvent.click(screen.getByTestId('restructure-confirm-apply'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect((await screen.findAllByText(ABORT_MESSAGE)).length).toBeGreaterThan(0);
      expect(apiMock.mergeChapters).not.toHaveBeenCalled();

      putSucceeds();
      let diskAtMerge: typeof diskSentences = [];
      apiMock.mergeChapters.mockImplementation(async () => {
        events.push('merge');
        diskAtMerge = diskSentences;
        return { sentenceRemap: [], warnings: [] };
      });
      fireEvent.click(screen.getByTestId('restructure-confirm-apply'));
      await waitFor(() => expect(apiMock.mergeChapters).toHaveBeenCalledWith('b1', [1, 2]));
      expect(events).toEqual(['put', 'merge']);
      expect(apiMock.putBookState.mock.calls[0][1].patch.sentences.find((x: { chapterId: number }) => x.chapterId === 4).emotion).toBe('sad');
      expect(diskAtMerge.find((x) => x.chapterId === 4)?.emotion).toBe('sad');
    } finally {
      err.mockRestore();
      vi.useRealTimers();
    }
  });

  it('control: when the save lands, the route is called after it and no abort message shows', async () => {
    putSucceeds();
    const store = await setupMerge();
    editSad(store);
    fireEvent.click(screen.getByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(apiMock.mergeChapters).toHaveBeenCalledWith('b1', [1, 2]));
    expect(events).toEqual(['put', 'merge']);
    expect(screen.queryByText(ABORT_MESSAGE)).toBeNull();
  });
});
