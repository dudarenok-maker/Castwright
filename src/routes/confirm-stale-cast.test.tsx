/* F6 (A120 on-box run, 2026-11-10): with the book read failing, /confirm for
   book B rendered book A's cast rows under B's URL. The cast slice holds ONE
   book; Confirm must show its rows only while the slice names this route's book. */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route } from 'react-router';
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

vi.mock('../lib/api', () => ({
  api: {
    getBookState: () => Promise.reject(new Error('proxy down')),
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

function renderConfirm(sliceBookId: string | null) {
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
        characters: [{ id: 'm', name: 'Maerin from Legacy Book 1', voiceState: 'generated' } as Character],
        renderedFallbackByCharacter: {},
      },
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: sliceBookId },
    },
  });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/books/chain-b2/confirm']}>
        <Routes>
          <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('ConfirmRoute — never shows another book\'s cast (F6)', () => {
  it('does not render the previous book\'s rows while the slice names a different book', () => {
    renderConfirm('legacy-b1');
    expect(screen.queryByText('Maerin from Legacy Book 1')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders the rows once the slice names this book', () => {
    renderConfirm('chain-b2');
    expect(screen.getByText('Maerin from Legacy Book 1')).toBeTruthy();
  });
});
