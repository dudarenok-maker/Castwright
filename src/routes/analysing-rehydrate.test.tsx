/* Regression: after analysis completes, the /confirm cast must reflect the
   server-merged cast.json — including designed voices the reparse/replace
   carryover (srv-13) restored. The analysis payload carries only the detected
   roster (voiceless for an in-this-book designed voice), and the reparse/replace
   handler cleared the cast slice, so hydrateFromAnalysis's overlay has nothing
   to draw from. AnalysingRoute.onComplete therefore re-reads getBookState and
   setCharacters from the authoritative merged cast.json.

   Without the fix the cast slice keeps the voiceless payload roster and the
   confirm screen renders "No voice designed yet" for a character whose designed
   voice is safe on disk. */

import { Suspense } from 'react';
import { useEffect } from 'react';
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
import type { AnalyseResponse } from '../lib/types';

const BOOK_ID = 'castwright__standalones__the-coalfall-commission';

/* The analysis payload AnalysingView hands to onComplete: a freshly-detected
   roster whose Coalfall is VOICELESS (no overrideTtsVoices) — exactly what the
   stream produces when the designed voice was restored server-side into
   cast.json but never streamed back to the client. */
const VOICELESS_PAYLOAD = {
  bookId: BOOK_ID,
  manuscriptId: 'mns_coalfall',
  title: 'The Coalfall Commission',
  characters: [{ id: 'coalfall', name: 'Coalfall', voiceState: 'generated' }],
  chapters: [],
  sentences: [],
} as unknown as AnalyseResponse;

/* What the merged cast.json on disk holds — Coalfall WITH its restored Qwen
   designed voice. getBookState returns this; the fix must surface it. */
const getBookStateMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getBookState: (bookId: string) => getBookStateMock(bookId),
    /* AnalysingRoute / layout-free render touches none of these here, but the
       module references `api.*` at call sites — provide inert stubs. */
    getDroppedQuotes: () => Promise.resolve({ manuscriptId: 'mns_coalfall', batches: [] }),
    getChapterAudio: () => new Promise(() => {}),
  },
  AnalysisError: class extends Error {
    code = 'unknown';
  },
}));

/* Stub AnalysingView so it fires onComplete once on mount with the voiceless
   payload — standing in for a completed analysis stream. */
vi.mock('../views/analysing', () => ({
  AnalysingView: (props: { onComplete: (p: AnalyseResponse) => void }) => {
    useEffect(() => {
      props.onComplete(VOICELESS_PAYLOAD);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  },
}));

// Import AFTER the mocks so the route module picks them up.
import { AnalysingRoute } from './index';

function makeStore() {
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
  });
}

beforeEach(() => {
  getBookStateMock.mockReset();
});

describe('AnalysingRoute.onComplete — re-reads merged cast.json', () => {
  it('surfaces a carryover-restored designed voice the analysis payload omitted', async () => {
    getBookStateMock.mockResolvedValue({
      state: { bookId: BOOK_ID, chapters: [] },
      cast: {
        characters: [
          {
            id: 'coalfall',
            name: 'Coalfall',
            voiceState: 'generated',
            ttsEngine: 'qwen',
            overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
          },
        ],
      },
    });

    const store = makeStore();
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/books/${BOOK_ID}/analysing`]}>
          <Suspense fallback={<div data-testid="suspense-loading" />}>
            <Routes>
              <Route path="/books/:bookId/analysing" element={<AnalysingRoute />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </Provider>,
    );

    /* getBookState is called with the completed book's id … */
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith(BOOK_ID));

    /* … and its merged cast (with the designed voice) replaces the voiceless
       payload roster in the slice. */
    await waitFor(() => {
      const coalfall = store.getState().cast.characters.find((c) => c.id === 'coalfall');
      expect(coalfall?.overrideTtsVoices?.qwen?.name).toBe('qwen-coalfall');
    });
  });
});
