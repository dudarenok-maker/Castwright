/* ManuscriptView — excluded-chapter rendering.

   Excluded chapters previously rendered as a fully-blank middle panel
   ("0 segments · 0 speakers · 0 low-confidence" with an empty article),
   which left users wondering whether the analyzer had silently failed.
   This file pins the user-facing affordance that explains the state:
   the sidebar marks the row as Excluded and the main panel swaps in an
   explanatory empty card. */

import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen } from '@testing-library/react';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { ManuscriptView } from './manuscript';
import type { Chapter, Character, Sentence } from '../lib/types';

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
];

const chapter1: Chapter = {
  id: 1,
  title: 'Dedication',
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: {},
  excluded: true,
};
const chapter2: Chapter = {
  id: 2,
  title: 'Chapter One',
  duration: '11:32',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done' },
};

const sentences: Sentence[] = [
  { id: 1, chapterId: 2, characterId: 'narrator', text: 'It was a quiet morning.' },
];

function renderView(currentChapterId: number) {
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      changeLog:  changeLogSlice.reducer,
    },
  });
  return render(
    <Provider store={store}>
      <ManuscriptView
        characters={characters}
        chapters={[chapter1, chapter2]}
        currentChapterId={currentChapterId}
        setCurrentChapterId={() => {}}
        sentencesFromStore={sentences}
      />
    </Provider>,
  );
}

describe('ManuscriptView — excluded chapter indication', () => {
  it('marks the excluded chapter in the sidebar with an "Excluded" label and a strikethrough title', () => {
    renderView(2);
    const excludedTitle = screen.getByText('Dedication');
    expect(excludedTitle.className).toMatch(/line-through/);
    expect(screen.getByText('Excluded')).toBeInTheDocument();
    /* The "11:32" duration of the non-excluded row must still render —
       i.e. we didn't replace duration globally, only on the excluded row. */
    expect(screen.getByText('11:32')).toBeInTheDocument();
  });

  it('shows the empty-state explanation in the main panel when the excluded chapter is selected', () => {
    renderView(1);
    expect(screen.getByText('This chapter was excluded at import.')).toBeInTheDocument();
    /* The segments/speakers/low-confidence counters must NOT render when
       the chapter is excluded — they are nonsensical and were the
       confusing "0 segments · 0 speakers · 0 low-confidence" line.
       Match the leading-number form so the "no sentences or speakers"
       copy in the empty-state body doesn't accidentally satisfy the
       check. */
    expect(screen.queryByText(/\d+ segments/)).toBeNull();
    expect(screen.queryByText(/\d+ speakers/)).toBeNull();
    expect(screen.queryByText(/low-confidence/)).toBeNull();
  });

  it('renders the article normally when a non-excluded chapter is selected', () => {
    renderView(2);
    expect(screen.queryByText('This chapter was excluded at import.')).toBeNull();
    expect(screen.getByText(/1 segments/)).toBeInTheDocument();
    expect(screen.getByText(/1 speakers/)).toBeInTheDocument();
    expect(screen.getByText(/It was a quiet morning\./)).toBeInTheDocument();
  });
});
