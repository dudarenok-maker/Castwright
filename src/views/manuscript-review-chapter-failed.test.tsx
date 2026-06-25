/* Regression for the Review-Script empty-modal bug: when a chapter review
   fails server-side, the SSE stream emits a `chapter-failed` event and ends
   with `result{totalOps:0}`. Previously handleReviewScript unconditionally
   called scriptReviewActions.setReview, creating an empty bucket → the diff
   modal opened empty with no explanation. The fix surfaces a warn toast and
   skips the empty bucket. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { scriptReviewSlice } from '../store/script-review-slice';
import { uiSlice } from '../store/ui-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { notificationsSlice } from '../store/notifications-slice';
import type { Toast } from '../store/notifications-slice';
import { ManuscriptView } from './manuscript';
import type { Chapter, Character, Sentence } from '../lib/types';

const { reviewScript } = vi.hoisted(() => ({ reviewScript: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...(actual as { api: object }).api, reviewScript } };
});

const characters: Character[] = [{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' }];
const chapter: Chapter = { id: 2, title: 'Chapter Two', duration: '10:00', state: 'done', progress: 1, characters: {} };
const liveSentence: Sentence = { id: 1, chapterId: 2, characterId: 'narrator', text: 'Live line.' };

function makeStore() {
  return configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
      ui: uiSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      manuscript: { ...manuscriptSlice.getInitialState(), sentences: [liveSentence] as never },
      ui: {
        ...uiSlice.getInitialState(),
        stage: {
          kind: 'ready',
          bookId: 'bk-1',
          view: 'manuscript',
          currentChapterId: 2,
          openProfileId: null,
        } as never,
      },
    },
  });
}

describe('ManuscriptView — script-review chapter-failed', () => {
  beforeEach(() => reviewScript.mockReset());

  it('toasts and opens no empty review modal when the only chapter fails', async () => {
    const user = userEvent.setup();
    const store = makeStore();

    reviewScript.mockImplementation(
      async (
        _bookId: string,
        opts?: { onChapterFailed?: (e: { chapterId: number; message: string }) => void },
      ) => {
        opts?.onChapterFailed?.({ chapterId: 2, message: 'Chapter 2 is too large — split it first.' });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[chapter]}
          currentChapterId={2}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[liveSentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-chapter'));

    await waitFor(() => {
      const toasts: Toast[] = store.getState().notifications.toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toMatch(/too large/);
    });

    /* No empty bucket → the diff modal never opens. */
    const state = store.getState() as { scriptReview: { byBook: Record<string, unknown> } };
    expect(state.scriptReview.byBook['bk-1']).toBeUndefined();
  });
});
