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
      changeLog: changeLogSlice.reducer,
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
        changeLog: changeLogSlice.reducer,
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
        changeLog: changeLogSlice.reducer,
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

/* Right-pane SegmentInspector — same shape of bug as the left sidebar.
   The "Reassign whole segment to" list and the help-text footer used to
   flow without bound, so a 30-character cast pushed the help line below
   the viewport. The fix gives the inspector card its own bounded flex
   column with sticky header + sticky footer + scrollable middle, so the
   help line and segment header stay anchored regardless of cast size. */
describe('ManuscriptView — inspector with large cast', () => {
  it('mounts the inspector header, the full reassign character list, and the help footer at the same time with 30 characters', async () => {
    const user = userEvent.setup();
    const manyCharacters: Character[] = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i + 1}`,
      name: `Char ${i + 1}`,
      role: 'Cast',
      color: 'narrator',
    }));
    const chapter: Chapter = {
      id: 1,
      title: 'Ch 1',
      duration: '10:00',
      state: 'queued',
      progress: 0,
      characters: {},
    };
    const sentence: Sentence = {
      id: 1,
      chapterId: 1,
      characterId: 'c1',
      text: 'A line of dialogue.',
    };
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={manyCharacters}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[sentence]}
        />
      </Provider>,
    );

    /* Empty state until a segment is selected. Click the rendered
       sentence to set selectedSeg and surface the full inspector card. */
    expect(screen.getByText(/Select a paragraph to inspect/)).toBeInTheDocument();
    await user.click(screen.getByText('A line of dialogue.'));
    expect(screen.queryByText(/Select a paragraph to inspect/)).toBeNull();

    /* The inspector now renders header + reassign list + help footer
       in the same tree. The footer line was the regression — it used
       to fall below the viewport on tall casts. */
    expect(screen.getByText('Reassign whole segment to')).toBeInTheDocument();
    expect(screen.getByText(/Highlight text/)).toBeInTheDocument();
    expect(screen.getByText(/Drag a boundary/)).toBeInTheDocument();

    /* And all 30 reassign targets must mount — the structural concern
       behind the height bound. The character names also appear in the
       Detected sidebar, so use queryAllByText and assert at least one
       per name (the inspector copy). */
    for (let i = 1; i <= 30; i++) {
      expect(screen.queryAllByText(`Char ${i}`).length).toBeGreaterThan(0);
    }
  });
});

/* Cross-chapter reassign — regression for the bug where clicking a
   character chip in the SegmentInspector on a non-first chapter silently
   mutated chapter 1's same-id sentence (because the reducer matched by id
   alone, but sentence ids restart at 1 per chapter). The slice unit tests
   in src/store/manuscript-slice.test.ts cover the reducer in isolation;
   this test pins the prop wiring end-to-end through real React + real
   redux: SegmentInspector must forward `s.chapterId` to onReassignSentence
   so the dispatch carries the right chapter scope. */
describe('ManuscriptView — cross-chapter reassign isolation', () => {
  it("reassigning a chapter-2 sentence via the inspector leaves chapter 1's same-id sentence untouched", async () => {
    const user = userEvent.setup();
    const reassignCharacters: Character[] = [
      { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
      { id: 'eliza', name: 'Eliza', role: 'Cast', color: 'narrator' },
    ];
    const twoChapters: Chapter[] = [
      {
        id: 1,
        title: 'Chapter One',
        duration: '10:00',
        state: 'done',
        progress: 1,
        characters: {},
      },
      {
        id: 2,
        title: 'Chapter Two',
        duration: '10:00',
        state: 'done',
        progress: 1,
        characters: {},
      },
    ];
    /* Both chapters carry id=1 — the collision the bug used to glob onto. */
    const twoChapterSentences: Sentence[] = [
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one opening line.' },
      { id: 1, chapterId: 2, characterId: 'narrator', text: 'Chapter two opening line.' },
    ];
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          bookId: null,
          manuscriptId: null,
          title: null,
          format: null,
          wordCount: 0,
          sourceText: null,
          sentences: twoChapterSentences,
          importCandidate: null,
          pendingReupload: null,
        },
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={reassignCharacters}
          chapters={twoChapters}
          currentChapterId={2}
          setCurrentChapterId={() => {}}
          sentencesFromStore={twoChapterSentences}
        />
      </Provider>,
    );

    /* Open the inspector by clicking chapter 2's sentence. */
    await user.click(screen.getByText('Chapter two opening line.'));
    expect(screen.getByText('Reassign whole segment to')).toBeInTheDocument();

    /* Click the Eliza chip in the "Reassign whole segment to" list. The
       inspector lists every cast member; Eliza appears once in the list
       and once in the sidebar (Detected), so use getAllByText and click
       the inspector copy (last in DOM order under the inspector card). */
    const elizaButtons = screen.getAllByRole('button', { name: /Eliza/ });
    /* The inspector copy is inside the inspector card — its parent button
       has the role and contains the colour dot + name. Pick the last one
       because the inspector card renders below the sidebar card in DOM
       order. */
    await user.click(elizaButtons[elizaButtons.length - 1]);

    /* Store assertion is the regression contract. Chapter 2's sentence
       reassigned; chapter 1's same-id sentence untouched. */
    const after = store.getState().manuscript.sentences;
    expect(after).toEqual([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one opening line.' },
      { id: 1, chapterId: 2, characterId: 'eliza', text: 'Chapter two opening line.' },
    ]);
  });
});
