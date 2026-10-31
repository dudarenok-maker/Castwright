/* Regression: the /confirm screen must reflect the server-merged cast.json —
   including designed voices the reparse/replace carryover (srv-13) restored.
   After a reparse/replace + fresh analysis, the analysis payload carries the
   detected roster WITHOUT those voices, the reparse/replace handler cleared the
   cast slice so hydrateFromAnalysis's overlay has nothing to draw from, and the
   layout's confirm-stage hydration is skipped once the SSE stream filled the
   slice. ConfirmRoute therefore re-reads getBookState on entry and
   hydrateCharacters from the authoritative merged cast.json.

   Without the fix the slice keeps the voiceless roster and the confirm screen
   renders "No voice designed yet" for a character whose designed voice is on
   disk. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route } from 'react-router';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { queueSlice } from '../store/queue-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { persistenceMiddleware, flushBookPersistence } from '../store/persistence-middleware';
import { settingsSlice } from '../store/settings-slice';
import type { Character } from '../lib/types';

const BOOK_ID = 'castwright__standalones__the-coalfall-commission';

const { getBookStateMock, putBookStateMock } = vi.hoisted(() => ({
  getBookStateMock: vi.fn(),
  putBookStateMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/api', () => ({
  api: {
    getBookState: (bookId: string) => getBookStateMock(bookId),
    putBookState: (bookId: string, req: unknown) => putBookStateMock(bookId, req),
    matchVoices: () => new Promise(() => {}), // layout-style match probe; never resolves
  },
  AnalysisError: class extends Error {
    code = 'unknown';
  },
}));

/* Stub the heavy confirm view so the route renders in isolation — the fix lives
   in ConfirmRoute's hydration effect, not the view. */
vi.mock('../views/confirm-cast', () => ({
  ConfirmCastView: () => null,
}));

/* The analyzer guard hook pulls in modals/providers we don't need here. */
vi.mock('../hooks/use-local-analyzer-guard', () => ({
  useLocalAnalyzerGuard: () => ({ guard: (fn: () => void) => fn(), modal: null }),
}));

import { ConfirmRoute } from './index';

const VOICELESS_COALFALL = { id: 'coalfall', name: 'Coalfall', voiceState: 'generated' } as Character;
const VOICED_COALFALL = {
  id: 'coalfall',
  name: 'Coalfall',
  voiceState: 'generated',
  ttsEngine: 'qwen',
  overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
} as unknown as Character;

function makeStore(preloadCharacters: Character[]) {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      library: librarySlice.reducer,
      voices: voicesSlice.reducer,
      changeLog: changeLogSlice.reducer,
      account: accountSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      queue: queueSlice.reducer,
      settings: settingsSlice.reducer,
    },
    middleware: (gDM) => gDM().concat(persistenceMiddleware),
    preloadedState: {
      cast: { characters: preloadCharacters, renderedFallbackByCharacter: {} },
    },
  });
}

beforeEach(() => {
  getBookStateMock.mockReset();
  putBookStateMock.mockClear();
});

describe('ConfirmRoute — re-reads merged cast.json on entry', () => {
  it('replaces a voiceless slice roster with the merged designed voices from disk', async () => {
    // Slice arrives voiceless (the post-analysis SSE roster).
    const store = makeStore([VOICELESS_COALFALL]);
    // Disk / server has the carryover-restored designed voice.
    getBookStateMock.mockResolvedValue({
      state: { bookId: BOOK_ID, chapters: [] },
      cast: { characters: [VOICED_COALFALL] },
    });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/books/${BOOK_ID}/confirm`]}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith(BOOK_ID));
    await waitFor(() => {
      const coalfall = store.getState().cast.characters.find((c) => c.id === 'coalfall');
      expect(coalfall?.overrideTtsVoices?.qwen?.name).toBe('qwen-coalfall');
    });
  });

  it('does not echo a cast putBookState after the re-read (hydrateCharacters is non-persisting)', async () => {
    const store = makeStore([VOICELESS_COALFALL]);
    getBookStateMock.mockResolvedValue({
      state: { bookId: BOOK_ID, chapters: [] },
      cast: { characters: [VOICED_COALFALL] },
    });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/books/${BOOK_ID}/confirm`]}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    // Wait for the re-read to land — hydrateCharacters dispatches from the
    // resolved getBookState promise.
    await waitFor(() => {
      const coalfall = store.getState().cast.characters.find((c) => c.id === 'coalfall');
      expect(coalfall?.overrideTtsVoices?.qwen?.name).toBe('qwen-coalfall');
    });

    // Send any queued write now rather than sleeping out the debounce. If the
    // route had dispatched setCharacters (in PERSIST_RULES) instead of
    // hydrateCharacters, a putBookState for the cast slice would be queued
    // and this flush would fire it.
    await store.dispatch(flushBookPersistence(BOOK_ID) as never);

    expect(putBookStateMock).not.toHaveBeenCalled();
  });
});

/* #3916 — Confirm's entry re-read must wait for queued saves and must not put an
   older cast over a save made while it was out (owner decision, 2026-10-30). */
describe('ConfirmRoute — entry re-read vs a save made while it was out (#3916)', () => {
  const NO_VOICE = { id: 'c1', name: 'Eliza', voiceState: 'generated' } as Character;
  const MATCHED = { ...NO_VOICE, voiceId: 'v_match', voiceState: 'reused' } as Character;
  const MATCH = {
    matches: [
      {
        characterId: 'c1',
        candidates: [
          { voiceId: 'v_match', fromBookId: 'b0', fromCharacterId: 'x', fromBookTitle: 'Old', score: 0.9, factors: {} },
        ],
      },
    ],
  } as never;
  const reply = (c: Character) => ({ state: { bookId: BOOK_ID, chapters: [] }, cast: { characters: [c] } });

  function makeBookStore(chars: Character[]) {
    const store = makeStore(chars);
    // Put the book in scope before render so an edit made first is persisted.
    store.dispatch(uiActions.openBook({ id: BOOK_ID, status: 'cast_pending' }));
    return store;
  }

  function renderRoute(store: ReturnType<typeof makeStore>) {
    return render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/books/${BOOK_ID}/confirm`]}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
  }

  const voiceOf = (store: ReturnType<typeof makeStore>) =>
    store.getState().cast.characters.find((c) => c.id === 'c1')?.voiceId;

  it('keeps a save made while the read was out, and re-reads', async () => {
    const store = makeBookStore([NO_VOICE]);
    const resolvers: Array<(v: unknown) => void> = [];
    getBookStateMock.mockImplementation(() => new Promise((r) => resolvers.push(r)));
    renderRoute(store);
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      store.dispatch(castActions.applyVoiceMatches(MATCH));
      await store.dispatch(flushBookPersistence(BOOK_ID) as never);
    });
    expect(putBookStateMock).toHaveBeenCalled();

    await act(async () => resolvers[0](reply(NO_VOICE)));
    expect(voiceOf(store)).toBe('v_match');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
    await act(async () => resolvers[1](reply(MATCHED)));
    expect(voiceOf(store)).toBe('v_match');
  });

  it('flushes and waits for queued saves before it reads', async () => {
    const store = makeBookStore([NO_VOICE]);
    let landPut: () => void = () => {};
    putBookStateMock.mockImplementationOnce(() => new Promise<void>((r) => (landPut = r)));
    getBookStateMock.mockResolvedValue(reply(MATCHED));
    store.dispatch(castActions.applyVoiceMatches(MATCH)); // queued, still inside its debounce
    expect(putBookStateMock).not.toHaveBeenCalled();
    renderRoute(store);
    await waitFor(() => expect(putBookStateMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(getBookStateMock).not.toHaveBeenCalled(); // the save is still in flight
    await act(async () => landPut());
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalled());
    expect(putBookStateMock.mock.invocationCallOrder[0]).toBeLessThan(getBookStateMock.mock.invocationCallOrder[0]);
  });

  it('re-reads at most 3 times when a save lands during every read', async () => {
    const store = makeBookStore([NO_VOICE]);
    getBookStateMock.mockImplementation(async () => {
      store.dispatch(castActions.applyVoiceMatches(MATCH));
      await store.dispatch(flushBookPersistence(BOOK_ID) as never);
      return reply(NO_VOICE);
    });
    renderRoute(store);
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(getBookStateMock).toHaveBeenCalledTimes(3);
    expect(voiceOf(store)).toBe('v_match');
  });
});

/* #3916 review — the 15 s bound on the flush wait must not turn a stalled save
   into "no read ever": on expiry the route reads anyway. */
describe('ConfirmRoute — entry re-read when a queued save stalls past the wait bound (#3916)', () => {
  it('still reads after 15 s while the save is held, and surfaces the disk voice once it lands', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([VOICELESS_COALFALL]);
      store.dispatch(uiActions.openBook({ id: BOOK_ID, status: 'cast_pending' }));
      let landPut: () => void = () => {};
      putBookStateMock.mockImplementationOnce(() => new Promise<void>((r) => (landPut = r)));
      getBookStateMock.mockResolvedValue({
        state: { bookId: BOOK_ID, chapters: [] },
        cast: { characters: [VOICED_COALFALL] },
      });
      store.dispatch(
        castActions.applyVoiceMatches({
          matches: [
            {
              characterId: 'coalfall',
              candidates: [
                { voiceId: 'v_match', fromBookId: 'b0', fromCharacterId: 'x', fromBookTitle: 'Old', score: 0.9, factors: {} },
              ],
            },
          ],
        } as never),
      );
      render(
        <Provider store={store}>
          <MemoryRouter initialEntries={[`/books/${BOOK_ID}/confirm`]}>
            <Routes>
              <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
            </Routes>
          </MemoryRouter>
        </Provider>,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(putBookStateMock).toHaveBeenCalled();
      expect(getBookStateMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(16_000); // the wait expires with the PUT still held
      expect(getBookStateMock).toHaveBeenCalled();

      landPut();
      await vi.advanceTimersByTimeAsync(60_000);
      const coalfall = store.getState().cast.characters.find((c) => c.id === 'coalfall');
      expect(coalfall?.overrideTtsVoices?.qwen?.name).toBe('qwen-coalfall');
    } finally {
      vi.useRealTimers();
    }
  });
});
