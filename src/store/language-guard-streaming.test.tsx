/* language-guard-streaming — pins the two shapes wired in #2407 (#2246 Task
   9d): the sse shape (cast-design-stream-middleware.ts's onError, both the
   bulk and single callback builders) and the batch shape
   (script-review-thunk.ts's runReviewScript, whose route fails each chapter
   individually rather than the whole request). Both must reach the SAME
   host (useLanguageGuard) through the language-guard-bus, and Save must
   genuinely replay the action that opened the stream / re-run the review —
   not merely open a modal. Task 9c already pins the 409 shape
   (use-language-guard.test.tsx) and the bus contract
   (api-language-guard.test.ts); this file is real integration through the
   host, so narrowing either wiring site makes it fail. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { librarySlice } from './library-slice';
import { castDesignSlice, castDesignActions } from './cast-design-slice';
import { castSlice } from './cast-slice';
import { notificationsSlice } from './notifications-slice';
import { scriptReviewSlice } from './script-review-slice';
import { useLanguageGuard } from '../hooks/use-language-guard';
import { api, type CastDesignCallbacks } from '../lib/api';
import type { LibraryBook } from '../lib/types';
import type { AppDispatch, RootState } from './index';

interface StartCall {
  bookId: string;
  characterIds: string[];
  modelKey: string;
  cb: CastDesignCallbacks;
}

const startCalls: StartCall[] = [];

vi.mock('../lib/api', () => ({
  api: {
    startCastDesign: (
      bookId: string,
      { characterIds, modelKey }: { characterIds: string[]; modelKey: string },
      cb: CastDesignCallbacks,
    ) => {
      startCalls.push({ bookId, characterIds, modelKey, cb });
      return new Promise<void>(() => {}); // never resolves — torn down via close()/abort
    },
    putBookState: vi.fn(),
    getLibrary: vi.fn(),
    reviewScript: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

import { createCastDesignMiddleware } from './cast-design-stream-middleware';
import { runReviewScript } from './script-review-thunk';

/* Same fixture shape as use-language-guard.test.tsx's unsetBook(). */
function unsetBook(): LibraryBook {
  return {
    bookId: 'b_marlow',
    manuscriptId: 'm_marlow',
    title: 'The Coalfall Commission',
    author: 'Della Renwick',
    series: 'The Hollow Tide',
    seriesPosition: 1,
    isStandalone: false,
    status: 'cast_pending',
    chapterCount: 0,
    completedChapters: 0,
    characterCount: 0,
    voiceCount: 0,
    lastWorkedOn: '2026-08-10T00:00:00Z',
    coverGradient: ['#fff', '#000'],
    tags: [],
    languageSet: false,
  };
}

/* Verbatim copy of GUARD_COPY['sse'/'batch'].hint from src/modals/edit-book-meta.tsx
   (not exported) — asserting the literal text catches the guard opening in the
   wrong shape (e.g. '409' copy) even though the modal itself renders fine. */
const SSE_HINT = 'Generating voices needs a book language. Choose one below and we’ll pick up where we left off.';
const BATCH_HINT = 'Script review needs a book language. Choose one below and we’ll re-run the review.';

function Harness() {
  const { modal } = useLanguageGuard();
  return <>{modal}</>;
}

async function saveLanguage(): Promise<void> {
  const select = screen.getByTestId('edit-book-language') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'ru' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
}

beforeEach(() => {
  startCalls.length = 0;
  vi.mocked(api.putBookState).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.getLibrary).mockReset().mockResolvedValue({ authors: [] });
  vi.mocked(api.reviewScript).mockReset();
});

describe('language-guard-streaming (sse shape, #2407 Task 9d)', () => {
  it('routes a cast-design onError({code:"language_unset"}) to the guard host, and Save replays the SAME designAllRequested (acceptance 1)', async () => {
    const store = configureStore({
      reducer: {
        library: librarySlice.reducer,
        castDesign: castDesignSlice.reducer,
        cast: castSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
      middleware: (getDefault) => getDefault().concat(createCastDesignMiddleware()),
    });
    store.dispatch(librarySlice.actions.addBook(unsetBook()));

    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    );

    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b_marlow',
        characterIds: ['c1'],
        modelKey: 'qwen3-tts-0.6b',
      }),
    );
    expect(startCalls).toHaveLength(1);

    act(() => {
      startCalls[0].cb.onError?.({ code: 'language_unset', message: 'Set the book language first.' });
    });

    // Guard modal opened, empty, in the sse shape — not the ordinary error toast.
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();
    expect((screen.getByTestId('edit-book-language') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(SSE_HINT)).toBeInTheDocument();
    expect(store.getState().notifications.toasts).toHaveLength(0);

    await saveLanguage();

    // The load-bearing assertion: the ORIGINAL action was genuinely replayed,
    // not just a modal opened and forgotten.
    await waitFor(() => expect(startCalls).toHaveLength(2));
    expect(mockedApi.putBookState).toHaveBeenCalledWith('b_marlow', {
      slice: 'state',
      patch: expect.objectContaining({ language: 'ru' }),
    });
    expect(startCalls[1]).toMatchObject({
      bookId: 'b_marlow',
      characterIds: ['c1'],
      modelKey: 'qwen3-tts-0.6b',
    });
  });
});

describe('language-guard-streaming (batch shape, #2407 Task 9d)', () => {
  it('routes a reviewScript chapter-failed({code:"language_unset"}) to the guard host, and Save re-runs the review (acceptance 2)', async () => {
    const store = configureStore({
      reducer: {
        library: librarySlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    store.dispatch(librarySlice.actions.addBook(unsetBook()));

    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    );

    let reviewScriptCalls = 0;
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId, opts = {}) => {
      reviewScriptCalls += 1;
      if (reviewScriptCalls === 1) {
        opts.onChapterFailed?.({
          chapterId: 1,
          message: 'Set the book language first.',
          code: 'language_unset',
        });
      }
      return { reviewedChapters: 0, totalOps: 0 };
    });

    /* Hand-rolled getState/dispatch (per #2407's brief) rather than wiring
       the real manuscript/cast slices: retryReviewScript's snapshotIfReady
       only ever reads state.manuscript.{bookId,manuscriptId,sentences} and
       state.cast.characters (mirrors fakeGetState in
       script-review-thunk.test.ts), while useLanguageGuard needs a REAL
       library slice in a real store to resolve the book — so the two
       concerns are layered rather than both faked. */
    const sentences = [{ id: 1, chapterId: 1, text: 'Hello.', characterId: 'c1' }];
    const getState = (): RootState =>
      ({
        ...store.getState(),
        manuscript: { bookId: 'b_marlow', manuscriptId: 'm_marlow', sentences },
        cast: { characters: [{ id: 'c1' }] },
      }) as unknown as RootState;
    const dispatch = ((a: unknown) =>
      typeof a === 'function'
        ? (a as (d: unknown, g: unknown) => unknown)(dispatch, getState)
        : store.dispatch(a as never)) as AppDispatch;

    await act(async () => {
      await runReviewScript('b_marlow', {
        dispatch,
        wholeBook: true,
        model: 'gemma',
        sentences,
        characterIds: new Set(['c1']),
        manuscriptId: 'm_marlow',
      });
    });

    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();
    expect((screen.getByTestId('edit-book-language') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(BATCH_HINT)).toBeInTheDocument();
    expect(store.getState().notifications.toasts).toHaveLength(0);

    await saveLanguage();

    // The load-bearing assertion: the review was genuinely re-run, not just
    // a modal opened and forgotten.
    await waitFor(() => expect(reviewScriptCalls).toBe(2));
    expect(mockedApi.putBookState).toHaveBeenCalledWith('b_marlow', {
      slice: 'state',
      patch: expect.objectContaining({ language: 'ru' }),
    });
  });
});
