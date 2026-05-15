/* ManuscriptView — excluded-chapter rendering.

   Excluded chapters previously rendered as a fully-blank middle panel
   ("0 segments · 0 speakers · 0 low-confidence" with an empty article),
   which left users wondering whether the analyzer had silently failed.
   This file pins the user-facing affordance that explains the state:
   the sidebar marks the row as Excluded and the main panel swaps in an
   explanatory empty card.

   Also covers the chapter-filter affordance added so a 500+ chapter book
   does not push the cast list off the bottom of the sidebar. */

import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/* Chapter quick-filter — added so the user can jump within a 500-chapter
   book instead of dragging through dozens of viewports of rows to reach
   either a specific chapter or the Detected cast list below. */
describe('ManuscriptView — chapter filter', () => {
  const titles = ['Prologue', 'Chapter One', 'Chapter Two', 'Chapter Three', 'Epilogue'];
  const filterChapters: Chapter[] = titles.map((title, i) => ({
    id: i + 1,
    title,
    duration: '10:00',
    state: 'queued',
    progress: 0,
    characters: {},
  }));
  /* One sentence per chapter so the middle pane has something to render
     when we select a non-matching active chapter. */
  const filterSentences: Sentence[] = filterChapters.map((ch, i) => ({
    id: i + 1,
    chapterId: ch.id,
    characterId: 'narrator',
    text: `Body of ${ch.title}.`,
  }));

  function renderFilterView(currentChapterId: number) {
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
          chapters={filterChapters}
          currentChapterId={currentChapterId}
          setCurrentChapterId={() => {}}
          sentencesFromStore={filterSentences}
        />
      </Provider>,
    );
  }

  it('narrows the sidebar list to chapters whose title matches the filter, and restores all of them when cleared', async () => {
    const user = userEvent.setup();
    renderFilterView(1);

    /* Baseline — every chapter title is in the sidebar. */
    for (const title of titles) {
      expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument();
    }

    const input = screen.getByLabelText('Filter chapters');
    await user.type(input, 'epilogue');

    /* The four non-matching titles must drop out of the sidebar entirely
       (no row, no button). 'Epilogue' stays. */
    expect(screen.getByRole('button', { name: /Epilogue/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prologue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Chapter One/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Chapter Two/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Chapter Three/ })).toBeNull();

    await user.clear(input);

    /* All five return after the filter is cleared. */
    for (const title of titles) {
      expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument();
    }
  });

  it('keeps the active chapter selected in the main pane even when the filter hides it from the sidebar', async () => {
    const user = userEvent.setup();
    renderFilterView(2); /* "Chapter One" is the active chapter. */

    const input = screen.getByLabelText('Filter chapters');
    await user.type(input, 'epilogue');

    /* Sidebar row for "Chapter One" is gone… */
    expect(screen.queryByRole('button', { name: /Chapter One/ })).toBeNull();
    /* …but the main pane still shows it as the current chapter, with the
       chapter body text from the matching sentence. The filter is a
       *view* over the list, not a selection mutation. */
    expect(screen.getByRole('heading', { name: /Chapter One/ })).toBeInTheDocument();
    expect(screen.getByText('Body of Chapter One.')).toBeInTheDocument();
  });
});

/* Large-book structural smoke — the original bug was that a 500-chapter
   book pushed the cast list ~28k pixels below the chapter list inside one
   shared scroll container. The fix is layout (two cards, each with their
   own scroll region), which jsdom won't measure faithfully — but we can
   still pin that both lists are mounted and present in the DOM tree at
   the same time, so a regression to one-list-or-the-other won't slip by. */
describe('ManuscriptView — large book sidebar structure', () => {
  it('mounts both the Chapters and Detected sections with 60 chapters and 25 characters', () => {
    const bigChapters: Chapter[] = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      title: `Chapter ${i + 1}`,
      duration: '10:00',
      state: 'queued',
      progress: 0,
      characters: {},
    }));
    const bigCharacters: Character[] = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i + 1}`,
      name: `Char ${i + 1}`,
      role: 'Cast',
      color: 'narrator',
    }));
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog:  changeLogSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={bigCharacters}
          chapters={bigChapters}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    /* Both section headers render — neither list was collapsed out by
       the layout change. */
    expect(screen.getByRole('heading', { name: 'Chapters' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Detected' })).toBeInTheDocument();

    /* And rows from both lists are simultaneously mounted: a chapter
       row from near the end of the chapter list AND a character row
       from anywhere in the cast list. Without independent scroll
       regions a regression to "shared scroll, cast list below" would
       still mount both, so this is a structural-presence check, not a
       layout check. */
    expect(screen.getByRole('button', { name: /Chapter 60/ })).toBeInTheDocument();
    expect(screen.getByText('Char 25')).toBeInTheDocument();
  });
});
