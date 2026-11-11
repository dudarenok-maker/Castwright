/* F6 (A120 on-box run, 2026-11-10): with the book read failing, /confirm for
   book B rendered book A's cast rows under B's URL. The cast slice holds ONE
   book; Confirm must show its rows only while the slice names this route's book. */

import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { queueSlice } from '../store/queue-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { persistenceMiddleware } from '../store/persistence-middleware';
import { settingsSlice } from '../store/settings-slice';
import type { Character } from '../lib/types';

const { getBookStateMock } = vi.hoisted(() => ({
  getBookStateMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    getBookState: (...a: unknown[]) => getBookStateMock(...a),
    putBookState: vi.fn().mockResolvedValue(undefined),
    matchVoices: () => new Promise(() => {}),
  },
  AnalysisError: class extends Error {
    code = 'unknown';
  },
}));
vi.mock('../views/confirm-cast', () => ({
  ConfirmCastView: ({ characters }: { characters: Character[] }) => (
    <ul data-testid="rows">
      {characters.map((c) => (
        <li key={c.id}>{c.name}</li>
      ))}
    </ul>
  ),
}));
vi.mock('../hooks/use-local-analyzer-guard', () => ({
  useLocalAnalyzerGuard: () => ({ guard: (fn: () => void) => fn(), modal: null }),
}));

import { ConfirmRoute } from './index';

function renderConfirm(sliceBookId: string | null, reply?: unknown) {
  getBookStateMock.mockReset();
  if (reply === undefined) getBookStateMock.mockRejectedValue(new Error('proxy down'));
  else getBookStateMock.mockResolvedValue(reply);
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
    },
    middleware: (gDM) => gDM().concat(persistenceMiddleware),
    preloadedState: {
      cast: {
        characters: [
          { id: 'm', name: 'Maerin from Legacy Book 1', voiceState: 'generated' } as Character,
        ],
        renderedFallbackByCharacter: {},
      },
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: sliceBookId },
    },
  });
  renderWith(store);
  return store;
}

let navigateTo: (to: string) => void = () => {};
function NavProbe() {
  navigateTo = useNavigate();
  return null;
}

function renderWith(store: ReturnType<typeof configureStore>) {
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/books/chain-b2/confirm']}>
        <NavProbe />
        <Routes>
          <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe("ConfirmRoute — never shows another book's cast (F6)", () => {
  it("does not render the previous book's rows while the slice names a different book", () => {
    renderConfirm('legacy-b1');
    expect(screen.queryByText('Maerin from Legacy Book 1')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders the rows once the slice names this book', () => {
    renderConfirm('chain-b2');
    expect(screen.getByText('Maerin from Legacy Book 1')).toBeTruthy();
  });

  it('shows a way back, not "Loading…" forever, when the book answers 404', async () => {
    renderConfirm(null, null);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /library/i })).toBeTruthy();
  });

  it("does not hydrate this book's roster while the slices hold another book", async () => {
    const store = renderConfirm('legacy-b1', {
      state: { bookId: 'chain-b2', chapters: [] },
      cast: { characters: [{ id: 'n', name: 'Roster of B2', voiceState: 'generated' }] },
    });
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getState().cast.characters.map((c: Character) => c.id)).toEqual(['m']);
  });

  it("does not carry book A's not-found flag over to book B (Back/Forward on one route instance)", async () => {
    renderConfirm(null, null);
    expect(await screen.findByRole('alert')).toBeTruthy();
    getBookStateMock.mockReset();
    getBookStateMock.mockRejectedValue(new Error('proxy down'));
    act(() => navigateTo('/books/other-b/confirm'));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("does not write another book's chapter gaps while the slices hold a different book", async () => {
    const store = renderConfirm('legacy-b1', {
      state: { bookId: 'chain-b2', chapters: [{ id: 1 }] },
      cast: { characters: [] },
    });
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getState().chapters.analysisGapById).toBeUndefined();
  });
});
