/* Regression: the /confirm screen must reflect the server-merged cast.json —
   including designed voices the reparse/replace carryover (srv-13) restored.
   After a reparse/replace + fresh analysis, the analysis payload carries the
   detected roster WITHOUT those voices, the reparse/replace handler cleared the
   cast slice so hydrateFromAnalysis's overlay has nothing to draw from, and the
   layout's confirm-stage hydration is skipped once the SSE stream filled the
   slice. ConfirmRoute therefore re-reads getBookState on entry and
   setCharacters from the authoritative merged cast.json.

   Without the fix the slice keeps the voiceless roster and the confirm screen
   renders "No voice designed yet" for a character whose designed voice is on
   disk. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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
import type { Character } from '../lib/types';

const BOOK_ID = 'castwright__standalones__the-coalfall-commission';

const getBookStateMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getBookState: (bookId: string) => getBookStateMock(bookId),
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
    },
    preloadedState: {
      cast: { characters: preloadCharacters, renderedFallbackByCharacter: {} },
    },
  });
}

beforeEach(() => {
  getBookStateMock.mockReset();
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
});
