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
import { notificationsSlice } from '../store/notifications-slice';
import { analysisSlice, analysisActions } from '../store/analysis-slice';
import { bookBusySlice } from '../store/book-busy-slice';
import { castGateMiddleware } from '../store/cast-gate';
import type { Character } from '../lib/types';

const BOOK_ID = 'castwright__standalones__the-coalfall-commission';

const { getBookStateMock, putBookStateMock, getBookBusyMock, overrideLibraryCastMock, viewProps } = vi.hoisted(() => ({
  getBookStateMock: vi.fn(),
  overrideLibraryCastMock: vi.fn(),
  viewProps: { current: null as null | { onOverrideLibrary: (a: unknown) => Promise<void> } },
  putBookStateMock: vi.fn().mockResolvedValue(undefined),
  getBookBusyMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    getBookBusy: (...args: unknown[]) => getBookBusyMock(...args),
    overrideLibraryCast: (...args: unknown[]) => overrideLibraryCastMock(...args),
    getBookState: (bookId: string, signal?: AbortSignal) => getBookStateMock(bookId, signal),
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
  ConfirmCastView: (props: never) => {
    viewProps.current = props;
    return null;
  },
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
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: BOOK_ID },
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

    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith(BOOK_ID, expect.any(AbortSignal)));
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

/* #3967 — the entry re-read is bounded and aborted: leaving Confirm (or re-entering
   it) never leaves an unsettled read open, and a read that never answers is given
   up on after BOOK_READ_TIMEOUT_MS. */
describe('ConfirmRoute — the entry re-read is bounded and aborted (#3967)', () => {
  /* never settles on its own; rejects like fetch does when its signal aborts */
  const hung = (signal?: AbortSignal) =>
    new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  function renderConfirmWithStore() {
    const store = makeStore([VOICELESS_COALFALL]);
    store.dispatch(uiActions.openBook({ id: BOOK_ID, status: 'cast_pending' }));
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/books/${BOOK_ID}/confirm`]}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    return store;
  }
  function renderConfirm() {
    const store = makeStore([VOICELESS_COALFALL]);
    store.dispatch(uiActions.openBook({ id: BOOK_ID, status: 'cast_pending' }));
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
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const signalOf = (i: number) => getBookStateMock.mock.calls[i][1] as AbortSignal;

  it('(a) timeout: a read that never settles is aborted after 15 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getBookStateMock.mockImplementation((_id: string, signal?: AbortSignal) => hung(signal));
      renderConfirm();
      await advance(100);
      expect(getBookStateMock).toHaveBeenCalledTimes(1);
      const first = signalOf(0);
      expect(first).toBeInstanceOf(AbortSignal);
      expect(first.aborted).toBe(false);
      await advance(15_500);
      expect(first.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(b) unmount: leaving Confirm aborts the in-flight read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getBookStateMock.mockImplementation((_id: string, signal?: AbortSignal) => hung(signal));
      const view = renderConfirm();
      await advance(100);
      const signal = signalOf(0);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      view.unmount();
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) re-entry: entering Confirm three times leaves at most one read open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getBookStateMock.mockImplementation((_id: string, signal?: AbortSignal) => hung(signal));
      for (let i = 0; i < 2; i++) {
        const view = renderConfirm();
        await advance(100);
        view.unmount();
      }
      renderConfirm();
      await advance(100);
      expect(getBookStateMock).toHaveBeenCalledTimes(3);
      const open = getBookStateMock.mock.calls.filter(([, s]) => !(s as AbortSignal | undefined)?.aborted);
      expect(open.length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(d) an expired read is retried on Layout\'s schedule and the designed voice lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getBookStateMock
        .mockImplementationOnce((_id: string, signal?: AbortSignal) => hung(signal))
        .mockResolvedValue({
          state: { bookId: BOOK_ID, chapters: [] },
          cast: { characters: [VOICED_COALFALL] },
        });
      const store = renderConfirmWithStore();
      await advance(15_500);
      expect(getBookStateMock).toHaveBeenCalledTimes(1);
      await advance(2_000);
      expect(getBookStateMock).toHaveBeenCalledTimes(2);
      const coalfall = store.getState().cast.characters.find((c) => c.id === 'coalfall');
      expect(coalfall?.overrideTtsVoices?.qwen?.name).toBe('qwen-coalfall');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(g) a retried read never puts an older cast over a save made while the first attempt was out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const NO_VOICE = { id: 'c1', name: 'Eliza', voiceState: 'generated' } as Character;
      const MATCHED = { ...NO_VOICE, voiceId: 'v_match', voiceState: 'reused' } as Character;
      const reply = (c: Character) => ({ state: { bookId: BOOK_ID, chapters: [] }, cast: { characters: [c] } });
      const store = makeStore([NO_VOICE]);
      store.dispatch(uiActions.openBook({ id: BOOK_ID, status: 'cast_pending' }));
      getBookStateMock
        .mockImplementationOnce((_id: string, signal?: AbortSignal) => hung(signal))
        .mockResolvedValueOnce(reply(NO_VOICE)) // the retry: read before the save landed on disk
        .mockResolvedValue(reply(MATCHED));
      render(
        <Provider store={store}>
          <MemoryRouter initialEntries={[`/books/${BOOK_ID}/confirm`]}>
            <Routes>
              <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
            </Routes>
          </MemoryRouter>
        </Provider>,
      );
      await advance(15_500); // the first attempt expired, its retry is pending
      expect(getBookStateMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        store.dispatch(
          castActions.applyVoiceMatches({
            matches: [
              {
                characterId: 'c1',
                candidates: [
                  { voiceId: 'v_match', fromBookId: 'b0', fromCharacterId: 'x', fromBookTitle: 'Old', score: 0.9, factors: {} },
                ],
              },
            ],
          } as never),
        );
        await store.dispatch(flushBookPersistence(BOOK_ID) as never);
      });
      const voiceOf = () => store.getState().cast.characters.find((c) => c.id === 'c1')?.voiceId;
      expect(voiceOf()).toBe('v_match');
      await advance(2_000); // the retry lands with the older cast
      expect(getBookStateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(voiceOf()).toBe('v_match'); // not overwritten
      await advance(60_000);
      expect(voiceOf()).toBe('v_match');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(f) a read that takes 16 s on every attempt still lands: the bound grows per attempt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getBookStateMock.mockImplementation(
        (_id: string, signal?: AbortSignal) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(
              () => resolve({ state: { bookId: BOOK_ID, chapters: [] }, cast: { characters: [VOICED_COALFALL] } }),
              16_000,
            );
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );
      const store = renderConfirmWithStore();
      await advance(300_000);
      const coalfall = store.getState().cast.characters.find((c) => c.id === 'coalfall');
      expect(coalfall?.overrideTtsVoices?.qwen?.name).toBe('qwen-coalfall');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(e) unmounting while the retry timer is pending issues no further read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getBookStateMock.mockImplementation((_id: string, signal?: AbortSignal) => hung(signal));
      const view = renderConfirm();
      await advance(15_500);
      expect(getBookStateMock).toHaveBeenCalledTimes(1);
      view.unmount();
      await advance(60_000);
      expect(getBookStateMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* Plan 291 (#4031), Task 12, item 12 — Confirm's entry read is the busy-gated
   re-hydrate while the cast is read-only, and it never hydrates a read that the
   gate's clear has overtaken. */
describe('ConfirmRoute — the entry read follows the cast gate (plan 291, item 12)', () => {
  const GATED_BOOK = BOOK_ID;
  const reply = (c: Character) => ({ state: { bookId: GATED_BOOK, chapters: [] }, cast: { characters: [c] } });

  function makeGatedStore(preload: Character[]) {
    const store = configureStore({
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
        analysis: analysisSlice.reducer,
        bookBusy: bookBusySlice.reducer,
        notifications: notificationsSlice.reducer,
      },
      middleware: (gDM) => gDM().concat(persistenceMiddleware, castGateMiddleware),
      preloadedState: { cast: { characters: preload, renderedFallbackByCharacter: {} } as never },
    });
    store.dispatch(uiActions.openBook({ id: GATED_BOOK, status: 'cast_pending' }));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: GATED_BOOK, manuscriptId: 'm1', title: 'Coalfall' } as never,
        sentences: null,
      }),
    );
    return store;
  }
  function renderRoute(store: ReturnType<typeof makeGatedStore>) {
    return render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/books/${GATED_BOOK}/confirm`]}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
  }
  const ids = (store: ReturnType<typeof makeGatedStore>) => store.getState().cast.characters.map((c) => c.id);

  beforeEach(() => {
    getBookBusyMock.mockReset();
    getBookBusyMock.mockResolvedValue([]);
  });

  it('item 12: ConfirmRoute re-hydrates through the busy gate when read-only', async () => {
    getBookBusyMock.mockResolvedValue(['analysis']);
    getBookStateMock.mockResolvedValue(reply(VOICED_COALFALL));
    const store = makeGatedStore([VOICELESS_COALFALL]);
    store.dispatch(castActions.latchAnalysisEra({ bookId: GATED_BOOK }));
    renderRoute(store);

    /* The run is on: Confirm reads nothing and hydrates nothing. */
    await new Promise((r) => setTimeout(r, 300));
    expect(getBookStateMock).not.toHaveBeenCalled();
    expect(store.getState().cast.characters[0].overrideTtsVoices).toBeUndefined();

    /* The run ends: the gate reads, hydrates and releases the cast. */
    getBookBusyMock.mockResolvedValue([]);
    await waitFor(() => expect(store.getState().cast.analysisEra?.[GATED_BOOK]).toBeUndefined(), { timeout: 10_000 });
    expect(store.getState().cast.characters[0].overrideTtsVoices?.qwen?.name).toBe('qwen-coalfall');
    expect(getBookStateMock).toHaveBeenCalled();
  }, 20_000);

  it('I1: the override-from-library mirror raises no read-only toast and the slice reflects the route result', async () => {
    getBookBusyMock.mockResolvedValue(['analysis']);
    getBookStateMock.mockResolvedValue(reply(VOICELESS_COALFALL));
    overrideLibraryCastMock.mockResolvedValue({ source: { ...VOICELESS_COALFALL, name: 'Coalfall Unioned' } });
    const store = makeGatedStore([VOICELESS_COALFALL]);
    store.dispatch(castActions.latchAnalysisEra({ bookId: GATED_BOOK }));
    renderRoute(store);
    await act(async () => {
      await viewProps.current!.onOverrideLibrary({
        sourceCharacterId: 'coalfall',
        targetBookId: 'b0',
        targetCharacterId: 'x',
      });
    });
    expect(store.getState().cast.characters[0].name).toBe('Coalfall Unioned');
    expect(
      store.getState().notifications.toasts.filter((t) => /Re-analysis running/.test(t.message)),
    ).toEqual([]);
  });

  it('a read the gate has overtaken is not hydrated: Confirm reads again', async () => {
    const FRESH = { ...VOICED_COALFALL, name: 'Coalfall Fresh' } as Character;
    const resolvers: Array<(v: unknown) => void> = [];
    getBookStateMock.mockImplementation(() => new Promise((r) => resolvers.push(r)));
    const store = makeGatedStore([VOICELESS_COALFALL]);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().cast.characters[0]?.name ?? ''));
    renderRoute(store);
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(1));

    /* While the read is out an analysis lands and the gate's own re-read
       hydrates the fresh roster and clears the era. */
    act(() => {
      store.dispatch(castActions.latchAnalysisEra({ bookId: GATED_BOOK }));
      store.dispatch(castActions.hydrateCharacters([FRESH]));
      store.dispatch(castActions.clearAnalysisEra({ bookId: GATED_BOOK, epoch: store.getState().cast.analysisEra![GATED_BOOK].epoch }));
    });
    expect(store.getState().cast.analysisEra?.[GATED_BOOK]).toBeUndefined();
    seen.length = 0;

    /* The overtaken read answers with the pre-run cast: it must not land. */
    await act(async () => resolvers[0](reply(VOICELESS_COALFALL)));
    expect(seen).not.toContain('Coalfall');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
    await act(async () => resolvers[1](reply(FRESH)));
    expect(ids(store)).toEqual(['coalfall']);
    expect(store.getState().cast.characters[0].name).toBe('Coalfall Fresh');
  });
});

/* Plan 291 (#4031), Task 12 fix round 1, I3 - the entry read is owed once for a
   visit, and runs when the gate drops, however long a run (or a live stream)
   keeps it up. The entry read is the one handed an AbortSignal; the gate's
   re-hydrate reads without one. */
describe('ConfirmRoute — the owed entry read runs once when the gate drops (plan 291, I3)', () => {
  const entryReads = () =>
    getBookStateMock.mock.calls.filter(([, signal]) => signal instanceof AbortSignal).length;
  const reply = (c: Character) => ({
    state: { bookId: BOOK_ID, chapters: [{ id: 1 }] },
    cast: { characters: [c] },
    analysis: {},
  });

  function makeStoreWith(withGate: boolean) {
    const store = configureStore({
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
        analysis: analysisSlice.reducer,
        bookBusy: bookBusySlice.reducer,
        notifications: notificationsSlice.reducer,
      },
      middleware: (gDM) =>
        withGate ? gDM().concat(persistenceMiddleware, castGateMiddleware) : gDM().concat(persistenceMiddleware),
      preloadedState: { cast: { characters: [VOICELESS_COALFALL], renderedFallbackByCharacter: {} } as never },
    });
    store.dispatch(uiActions.openBook({ id: BOOK_ID, status: 'cast_pending' }));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: BOOK_ID, manuscriptId: 'm1', title: 'Coalfall' } as never,
        sentences: null,
      }),
    );
    store.dispatch(castActions.latchAnalysisEra({ bookId: BOOK_ID }));
    return store;
  }
  function renderRoute(store: ReturnType<typeof makeStoreWith>) {
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
  beforeEach(() => {
    getBookBusyMock.mockReset();
    getBookBusyMock.mockResolvedValue([]);
  });

  it('a gated entry sets the analysis gaps once, after the gate it dispatched has released', async () => {
    /* No gate middleware: only ConfirmRoute's own dispatch can release the era. */
    getBookBusyMock.mockResolvedValueOnce(['analysis']);
    getBookStateMock.mockResolvedValue(reply(VOICED_COALFALL));
    const store = makeStoreWith(false);
    const gapsBefore = store.getState().chapters.analysisGapById;
    renderRoute(store);
    await new Promise((r) => setTimeout(r, 300));
    expect(entryReads()).toBe(0);
    expect(store.getState().chapters.analysisGapById).toBe(gapsBefore);

    await waitFor(() => expect(entryReads()).toBe(1), { timeout: 10_000 });
    expect(store.getState().cast.analysisEra?.[BOOK_ID]).toBeUndefined();
    expect(store.getState().chapters.analysisGapById).not.toBe(gapsBefore);

    /* The gate rising and dropping again reads nothing more. */
    act(() => {
      store.dispatch(castActions.latchAnalysisEra({ bookId: BOOK_ID }));
      store.dispatch(castActions.clearAnalysisEra({ bookId: BOOK_ID, epoch: store.getState().cast.analysisEra![BOOK_ID].epoch }));
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(entryReads()).toBe(1);
  }, 20_000);

  it('a live run at entry: the owed read runs once, when the run ends and the gate releases', async () => {
    getBookStateMock.mockResolvedValue(reply(VOICED_COALFALL));
    const store = makeStoreWith(true);
    const running = {
      bookId: BOOK_ID,
      manuscriptId: 'm1',
      phaseId: 0,
      phaseLabel: 'Detecting characters',
      phaseProgress: 0,
      remainingMs: null,
      lastTickAt: 0,
      state: 'running' as const,
    };
    act(() => {
      store.dispatch(analysisActions.applyExternalAnalysisSnapshot(running as never));
    });
    renderRoute(store);
    await new Promise((r) => setTimeout(r, 400));
    expect(entryReads()).toBe(0);

    act(() => {
      store.dispatch(analysisActions.applyExternalAnalysisSnapshot({ ...running, state: 'paused' } as never));
    });
    await waitFor(() => expect(store.getState().cast.analysisEra?.[BOOK_ID]).toBeUndefined(), { timeout: 10_000 });
    await waitFor(() => expect(entryReads()).toBe(1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(entryReads()).toBe(1);
  }, 25_000);
});
