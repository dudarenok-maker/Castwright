// #3400 pass 7 — while a book restructures the guard refuses every sentence
// edit, so the manuscript editor's edit affordances disable themselves (with a
// reason) instead of dispatching into a silent refusal.

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen } from '@testing-library/react';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { scriptReviewSlice } from '../store/script-review-slice';
import { uiSlice, uiActions } from '../store/ui-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { restructureGuardMiddleware } from '../store/restructure-guard-middleware';
import { RESTRUCTURING_REASON } from '../store/restructure-lock';
import { ManuscriptView } from './manuscript';
import type { Chapter, Character, Sentence } from '../lib/types';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      getScriptReviewState: vi.fn().mockResolvedValue({ kind: 'ledger', entries: {} }),
      renameChapter: vi.fn(),
    },
  };
});

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  { id: 'wren', name: 'Wren', role: 'Lead', color: 'amber' } as Character,
];
const chapter: Chapter = {
  id: 1,
  title: 'One',
  duration: '00:10',
  state: 'queued',
  progress: 0,
  characters: {},
};
const sentences: Sentence[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'First line.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: 'Second line.', excludeFromSynthesis: true },
];

function renderView(restructuring: boolean) {
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
      ui: uiSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (g) => g().prepend(restructureGuardMiddleware),
    preloadedState: {
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: 'bk-r', sentences: sentences as never },
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId: 'bk-r', view: 'manuscript', currentChapterId: 1, openProfileId: null } as never,
      },
    },
  });
  if (restructuring) store.dispatch(uiActions.setRestructuringBook('bk-r'));
  render(
    <Provider store={store}>
      <ManuscriptView
        characters={characters}
        chapters={[chapter]}
        currentChapterId={1}
        setCurrentChapterId={() => {}}
        sentencesFromStore={sentences}
      />
    </Provider>,
  );
  return store;
}

describe('ManuscriptView while the book restructures', () => {
  it('shows why editing is unavailable and disables the edit affordances', () => {
    renderView(true);
    expect(screen.getByTestId('manuscript-restructuring-banner')).toHaveTextContent(RESTRUCTURING_REASON);
    for (const b of screen.getAllByRole('button', { name: /^Reassign$/ })) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', RESTRUCTURING_REASON);
    }
    const promote = screen.getByTestId('promote-first-sentence-button');
    expect(promote).toBeDisabled();
    expect(promote).toHaveAttribute('title', RESTRUCTURING_REASON);
    expect(screen.getByTestId('reinclude-toggle-2')).toBeDisabled();
  });

  it('leaves them enabled when no restructure is running (control)', () => {
    renderView(false);
    expect(screen.queryByTestId('manuscript-restructuring-banner')).toBeNull();
    for (const b of screen.getAllByRole('button', { name: /^Reassign$/ })) expect(b).toBeEnabled();
    expect(screen.getByTestId('reinclude-toggle-2')).toBeEnabled();
  });
});
