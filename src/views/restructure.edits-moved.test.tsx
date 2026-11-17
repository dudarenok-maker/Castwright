/* #4227 pass 1 -- the journal replay re-keys manuscript-edits.json behind an open
   client. A client holding the OLD keys that applied the server's `sentenceRemap` to
   its own copy dropped every line the remap did not name, then saved the result over
   the repaired file. The response now carries `editsRevisionBefore`; when it differs
   from the manuscript token the client last learned, the client adopts the fresh
   re-read's sentences instead of remapping (owner decision, #4227).

   Real RestructureView + real manuscript reducer + real persistence middleware; the
   server is a model of the two things that matter: what is on disk, and the token
   that disk carries. The numbers are the reviewer's probe: six lines in three
   chapters, a merge parked between its state and edits writes, so the replay turns
   them into four lines in chapter 1 and two in chapter 2. */
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
import { bookMetaSlice } from '../store/book-meta-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { settingsSlice } from '../store/settings-slice';
import {
  persistenceMiddleware,
  beginFullRead,
  learnSliceRevisions,
  knownSliceRevision,
} from '../store/persistence-middleware';

const { holder, apiMock } = vi.hoisted(() => ({
  holder: { store: null as null | { getState: () => unknown; subscribe: (l: () => void) => () => void } },
  apiMock: {
    refreshChapterTitles: vi.fn(),
    mergeChapters: vi.fn(),
    getBookState: vi.fn(),
    getLibrary: vi.fn(),
    putBookState: vi.fn(),
  },
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: apiMock }));
vi.mock('../store', async () => {
  const rr = await import('react-redux');
  return {
    useAppDispatch: rr.useDispatch,
    useAppSelector: rr.useSelector,
    store: { getState: () => holder.store!.getState(), subscribe: (l: () => void) => holder.store!.subscribe(l) },
  };
});

import { RestructureView } from './restructure';

type S = { id: number; chapterId: number; characterId: string; text: string };
const s = (chapterId: number, id: number, text: string): S => ({ id, chapterId, characterId: 'c', text });
const tok = (rev: string) => ({ sentences: rev, mergedAwayKeys: `${rev}-m` });

/* What the open client holds, keyed to the three ORIGINAL chapters. */
const CLIENT = [
  s(1, 1, 'Alpha first.'),
  s(1, 2, 'Alpha second.'),
  s(2, 1, 'Beta first.'),
  s(2, 2, 'Beta second.'),
  s(3, 1, 'Gamma first.'),
  s(3, 2, 'Gamma second.'),
];
/* What the replay leaves on disk: chapters 1 and 2 merged, Gamma now chapter 2. */
const REPLAYED = [
  s(1, 1, 'Alpha first.'),
  s(1, 2, 'Alpha second.'),
  s(1, 3, 'Beta first.'),
  s(1, 4, 'Beta second.'),
  s(2, 1, 'Gamma first.'),
  s(2, 2, 'Gamma second.'),
];
const identity = (xs: S[]) =>
  xs.map((x) => ({ oldChapterId: x.chapterId, oldSentenceId: x.id, newChapterId: x.chapterId, newSentenceId: x.id }));
const show = (xs: S[]) => xs.map((x) => `${x.chapterId}:${x.id} ${x.text}`);

let disk: { sentences: S[]; rev: string };

function makeStore() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      library: librarySlice.reducer,
      notifications: notificationsSlice.reducer,
      cast: castSlice.reducer,
      revisions: revisionsSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      settings: settingsSlice.reducer,
    },
    preloadedState: { settings: { ...settingsSlice.getInitialState(), autosaveDebounceMs: 40 } },
    middleware: () => new Tuple(persistenceMiddleware),
  });
  holder.store = store;
  store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' } as never));
  store.dispatch(
    manuscriptSlice.actions.hydrateFromBookState({
      state: { bookId: 'b1', manuscriptId: 'm1', title: 'A' } as never,
      sentences: CLIENT as never,
    }),
  );
  return store;
}

/* Layout's full read: the client learns the token of the disk it just read. */
const learn = (store: ReturnType<typeof makeStore>, rev: string) =>
  store.dispatch(
    learnSliceRevisions('b1', { manuscript: tok(rev) }, store.dispatch(beginFullRead('b1')) as unknown as number),
  );

beforeEach(() => {
  disk = { sentences: [], rev: '' };
  apiMock.refreshChapterTitles.mockReset();
  apiMock.mergeChapters.mockReset();
  apiMock.getLibrary.mockReset().mockResolvedValue(null);
  apiMock.getBookState.mockReset().mockImplementation(async () => ({
    state: { chapters: [] },
    completedSlugs: [],
    manuscriptEdits: { sentences: disk.sentences },
    sliceRevisions: { manuscript: tok(disk.rev) },
  }));
  apiMock.putBookState
    .mockReset()
    .mockImplementation(async (_id: string, w: { slice: string; patch: { sentences?: S[] } }) => {
      if (w.slice === 'manuscript') disk = { sentences: w.patch.sentences!, rev: `${disk.rev}+client` };
    });
});

const settle = () => new Promise((r) => setTimeout(r, 150));

async function run(store: ReturnType<typeof makeStore>, how: 'refresh' | 'merge') {
  render(
    <Provider store={store}>
      <RestructureView bookId="b1" />
    </Provider>,
  );
  fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
  fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
  await waitFor(() =>
    expect(how === 'refresh' ? apiMock.refreshChapterTitles : apiMock.mergeChapters).toHaveBeenCalled(),
  );
  await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled()); // applyResponse ran to its end
  await settle();
}

describe('#4227 the client adopts the server when the edits moved under it', () => {
  /* Trigger 1: the replay ran INSIDE this request. The route answers with the remap of
     the re-keyed file (identity here: the op was a title refresh). Red when the client
     branches on nothing and remaps its own old-keyed copy: four lines survive. */
  it('E1 replay inside the request: all six lines survive on disk, keyed to the new chapters', async () => {
    const store = makeStore();
    learn(store, 'rev1'); // the client read the old-keyed file
    apiMock.refreshChapterTitles.mockImplementation(async () => {
      disk = { sentences: REPLAYED, rev: 'rev2' }; // replay, then the op's own rewrite
      return { sentenceRemap: identity(REPLAYED), editsRevisionBefore: tok('rev2'), warnings: [] };
    });
    await run(store, 'refresh');
    expect(show(disk.sentences)).toEqual(show(REPLAYED));
    expect(show(store.getState().manuscript.sentences as S[])).toEqual(show(REPLAYED));
    expect(apiMock.putBookState).not.toHaveBeenCalled(); // adopting is not an edit
  });

  /* Trigger 2: the boot sweep replayed BEFORE the request, so this request replayed
     nothing; the token still differs. The op is a merge, whose remap would also move
     the client's old keys onto the wrong lines. */
  it('E2 boot-sweep replay, stale tab: all six lines survive on disk after a merge', async () => {
    const store = makeStore();
    learn(store, 'rev1');
    disk = { sentences: REPLAYED, rev: 'rev2' }; // the sweep ran at server start
    const merged = REPLAYED.map((x, i) => s(1, i + 1, x.text));
    apiMock.mergeChapters.mockImplementation(async () => {
      const remap = REPLAYED.map((x, i) => ({
        oldChapterId: x.chapterId,
        oldSentenceId: x.id,
        newChapterId: 1,
        newSentenceId: i + 1,
      }));
      disk = { sentences: merged, rev: 'rev3' };
      return { sentenceRemap: remap, editsRevisionBefore: tok('rev2'), warnings: [] };
    });
    store.dispatch(
      chaptersSlice.actions.hydrateFromBookState({
        bookId: 'b1',
        chapters: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }] as never,
        completedSlugs: [],
        characters: [],
      } as never),
    );
    render(
      <Provider store={store}>
        <RestructureView bookId="b1" />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('restructure-check-1'));
    fireEvent.click(screen.getByTestId('restructure-check-2'));
    fireEvent.click(screen.getByTestId('restructure-merge-button'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(apiMock.mergeChapters).toHaveBeenCalled());
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled());
    await settle();
    expect(show(disk.sentences)).toEqual(show(merged));
    expect(disk.sentences).toHaveLength(6);
    expect(show(store.getState().manuscript.sentences as S[])).toEqual(show(merged));
  });

  /* Red when: the adopt branch skips the "no fresh read" case and remaps anyway, which
     would drop lines the route's rewrite kept. The lock stays up for Layout's read. */
  it('E3 signal set but the re-read failed: the remap is NOT applied and the edit lock stays up', async () => {
    const store = makeStore();
    learn(store, 'rev1');
    apiMock.getBookState.mockResolvedValue(null);
    apiMock.refreshChapterTitles.mockImplementation(async () => {
      disk = { sentences: REPLAYED, rev: 'rev2' };
      return { sentenceRemap: identity(REPLAYED), editsRevisionBefore: tok('rev2'), warnings: [] };
    });
    await run(store, 'refresh');
    expect(show(store.getState().manuscript.sentences as S[])).toEqual(show(CLIENT));
    expect(apiMock.putBookState).not.toHaveBeenCalled();
    expect(store.getState().ui.restructuringBooks['b1']).toBeTruthy();
    expect(store.getState().bookMeta.needsFullRead?.['b1']).toBeGreaterThan(0);
  });

  /* The control: nothing moved, so the remap is the right tool and is still applied. */
  it('E4 tokens equal: the remap is applied to the client copy, as before', async () => {
    const store = makeStore();
    learn(store, 'rev1');
    disk = { sentences: CLIENT, rev: 'rev1' };
    const MERGED = [s(1, 1, 'Alpha first.'), s(1, 2, 'Alpha second.'), s(1, 3, 'Beta first.'), s(1, 4, 'Beta second.'), s(2, 1, 'Gamma first.'), s(2, 2, 'Gamma second.')];
    apiMock.getBookState.mockResolvedValue(null); // so only the remap can have produced MERGED
    apiMock.refreshChapterTitles.mockImplementation(async () => ({
      sentenceRemap: [
        ...[1, 2].map((id) => ({ oldChapterId: 1, oldSentenceId: id, newChapterId: 1, newSentenceId: id })),
        ...[1, 2].map((id) => ({ oldChapterId: 2, oldSentenceId: id, newChapterId: 1, newSentenceId: id + 2 })),
        ...[1, 2].map((id) => ({ oldChapterId: 3, oldSentenceId: id, newChapterId: 2, newSentenceId: id })),
      ],
      editsRevisionBefore: tok('rev1'),
      warnings: [],
    }));
    await run(store, 'refresh');
    expect(show(store.getState().manuscript.sentences as S[])).toEqual(show(MERGED));
  });

  /* A client that never learned a token (a hand-built store, a failed read) cannot tell:
     it keeps the old behaviour rather than throwing its copy away. */
  it('E5 no learned token: the remap is applied as before', async () => {
    const store = makeStore();
    apiMock.getBookState.mockResolvedValue(null);
    apiMock.refreshChapterTitles.mockImplementation(async () => ({
      sentenceRemap: [{ oldChapterId: 1, oldSentenceId: 1, newChapterId: 1, newSentenceId: 1 }],
      editsRevisionBefore: tok('rev2'),
      warnings: [],
    }));
    await run(store, 'refresh');
    expect(show(store.getState().manuscript.sentences as S[])).toEqual(['1:1 Alpha first.']);
  });

  /* Red when: the fresh read's token is not learned, so the NEXT restructure of an
     untouched book would see a stale token and adopt instead of remapping. */
  it('E6 after taking a restructure the client holds the token of the disk it adopted', async () => {
    const store = makeStore();
    learn(store, 'rev1');
    apiMock.refreshChapterTitles.mockImplementation(async () => {
      disk = { sentences: REPLAYED, rev: 'rev2' };
      return { sentenceRemap: identity(REPLAYED), editsRevisionBefore: tok('rev2'), warnings: [] };
    });
    await run(store, 'refresh');
    expect(store.dispatch(knownSliceRevision('b1', 'manuscript'))).toEqual(tok('rev2'));
  });
});
