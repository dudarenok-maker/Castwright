/* ManuscriptView — excluded-chapter rendering.

   Excluded chapters previously rendered as a fully-blank middle panel
   ("0 segments · 0 speakers · 0 low-confidence" with an empty article),
   which left users wondering whether the analyzer had silently failed.
   This file pins the user-facing affordance that explains the state:
   the sidebar marks the row as Excluded and the main panel swaps in an
   explanatory empty card.

   Also covers the chapter-filter affordance added so a 500+ chapter book
   does not push the cast list off the bottom of the sidebar. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { tourSlice } from '../store/tour-slice';
import { scriptReviewSlice, unresolvedCountForChapters } from '../store/script-review-slice';
import { uiSlice, uiActions } from '../store/ui-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { castSlice } from '../store/cast-slice';
import type { Toast } from '../store/notifications-slice';
import { TOUR_STEPS } from '../lib/tour-steps';
import { ManuscriptView, isExcludedSentenceId } from './manuscript';
import type { Chapter, Character, Sentence } from '../lib/types';

/* fs-58 — api mock for reviewScript + createCharacter trigger tests.
   Task 10 — getScriptReviewState is stubbed too: ManuscriptView now hydrates
   on mount for any bookId-bearing render, and without a mock the real
   (fetch-backed) implementation would fire in every test. Default resolves
   to an empty ledger so pre-existing tests that don't care about hydration
   stay inert (hydrateScriptReview's early-return on zero entries). */
const { reviewScript, createCharacter, getScriptReviewState, discardScriptReview, cancelScriptReview } = vi.hoisted(() => ({
  reviewScript: vi.fn(),
  createCharacter: vi.fn(),
  getScriptReviewState: vi.fn().mockResolvedValue({ kind: 'ledger', entries: {} }),
  discardScriptReview: vi.fn().mockResolvedValue(undefined),
  cancelScriptReview: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: { ...(actual as { api: object }).api, reviewScript, createCharacter, getScriptReviewState, discardScriptReview, cancelScriptReview },
  };
});

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

/* Detected list ordering — characters in the left sidebar's Detected card
   sort by line count in the currently-selected chapter (descending), with
   roster order as the stable tiebreaker. Zero-count characters fall to the
   bottom and dim to 60% opacity so they're still reachable for
   cross-chapter reassignment but don't compete with the chapter's actual
   speakers for vertical space. */
describe('ManuscriptView — Detected list ordering', () => {
  const orderingCharacters: Character[] = [
    { id: 'a', name: 'Alice', role: 'Cast', color: 'narrator' },
    { id: 'b', name: 'Bob', role: 'Cast', color: 'narrator' },
    { id: 'c', name: 'Carol', role: 'Cast', color: 'narrator' },
    { id: 'd', name: 'Dave', role: 'Cast', color: 'narrator' },
  ];
  const orderingChapters: Chapter[] = [
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
  /* Chapter 1: Carol speaks 5 lines, Alice speaks 2; Bob and Dave silent.
     Chapter 2: Alice speaks 6 lines; everyone else silent. */
  const orderingSentences: Sentence[] = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      chapterId: 1,
      characterId: 'c',
      text: `Carol line ${i + 1}.`,
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      id: i + 6,
      chapterId: 1,
      characterId: 'a',
      text: `Alice line ${i + 1}.`,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      chapterId: 2,
      characterId: 'a',
      text: `Alice chapter-two line ${i + 1}.`,
    })),
  ];

  function renderOrderingView(currentChapterId: number) {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={orderingCharacters}
          chapters={orderingChapters}
          currentChapterId={currentChapterId}
          setCurrentChapterId={() => {}}
          sentencesFromStore={orderingSentences}
        />
      </Provider>,
    );
  }

  /* Scope queries to the Detected card so we don't accidentally hit the
     reassign-list copy of character names inside the inspector. The
     character rows carry `data-character-id` so order is recoverable
     without depending on display strings. */
  function detectedOrder(): string[] {
    const detectedHeading = screen.getByRole('heading', { name: 'Detected' });
    const card = detectedHeading.closest('aside');
    if (!card) throw new Error('Detected card not found');
    const rows = within(card).getAllByText(/^(Alice|Bob|Carol|Dave)$/);
    return rows.map((el) => el.textContent ?? '');
  }

  it('sorts Detected by line count in the current chapter, with roster order as the tiebreaker', () => {
    renderOrderingView(1);
    /* Carol (5) > Alice (2) > [Bob (0), Dave (0)] in roster order. */
    expect(detectedOrder()).toEqual(['Carol', 'Alice', 'Bob', 'Dave']);
  });

  it('re-sorts when the active chapter changes', () => {
    renderOrderingView(2);
    /* Alice (6) > [Bob (0), Carol (0), Dave (0)] in roster order. */
    expect(detectedOrder()).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('dims rows for characters with zero lines in the current chapter while keeping the active speakers loud', () => {
    renderOrderingView(1);
    const detectedHeading = screen.getByRole('heading', { name: 'Detected' });
    const card = detectedHeading.closest('aside');
    if (!card) throw new Error('Detected card not found');
    /* Pull each row by its data-character-id so we can assert per-row
       opacity without depending on display order (already covered above). */
    function rowFor(id: string): HTMLElement {
      const node = card!.querySelector(`[data-character-id="${id}"]`);
      if (!(node instanceof HTMLElement)) {
        throw new Error(`Detected row for ${id} not found`);
      }
      return node;
    }
    /* Carol + Alice spoke → not dimmed. */
    expect(rowFor('c').className).not.toMatch(/opacity-60/);
    expect(rowFor('a').className).not.toMatch(/opacity-60/);
    /* Bob + Dave silent in chapter 1 → dimmed. */
    expect(rowFor('b').className).toMatch(/opacity-60/);
    expect(rowFor('d').className).toMatch(/opacity-60/);
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
          mergedAwayKeys: [],
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

    /* The inspector renders the current speaker as a "Change…" button.
       Click it to open the CharacterSearchPicker, then click the Eliza
       row inside the picker's listbox. Eliza also appears in the sidebar
       Detected card, so scope the click to the listbox role. */
    await user.click(screen.getByText(/Change…/));
    const picker = screen.getByRole('dialog', { name: /reassign speaker/i });
    const elizaOption = within(picker).getByRole('option', { name: /Eliza/ });
    await user.click(elizaOption);

    /* Store assertion is the regression contract. Chapter 2's sentence
       reassigned; chapter 1's same-id sentence untouched. */
    const after = store.getState().manuscript.sentences;
    expect(after).toEqual([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one opening line.' },
      { id: 1, chapterId: 2, characterId: 'eliza', text: 'Chapter two opening line.' },
    ]);
  });
});

/* Post-ship polish on plan 90 (CharacterSearchPicker). The picker now
   portal-renders to document.body, so the inspector's `overflow-y-auto`
   middle no longer clips the dropdown — every character in the book is
   pickable, regardless of cast length or scroll position. Click-outside
   replaces the row-level `onMouseLeave` that used to close the popover
   as soon as the user moved the cursor off the row.

   These cases pin both regressions. They DO drive the picker via
   `screen.getByRole('dialog')` because the picker portals out of the
   parent tree; jsdom honours createPortal natively. */
describe('ManuscriptView — reassign picker (post-90 portal + dismissal polish)', () => {
  it('reassigns a segment to a character that sits past the inspector\'s visible scroll height (no clipping)', async () => {
    const user = userEvent.setup();
    /* 30-character cast — large enough that, pre-portal, the bottom of
       the picker spilled past the inspector card and the user couldn't
       reach the last names. "Sela" sits at index 29 so it would have
       been outside the visible bound. */
    const wideCast: Character[] = [
      { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
      ...Array.from({ length: 28 }, (_, i) => ({
        id: `c${i + 1}`,
        name: `Char ${i + 1}`,
        role: 'Cast' as const,
        color: 'narrator' as const,
      })),
      { id: 'sela', name: 'Sela', role: 'Cast', color: 'magenta' },
    ];
    const chapter: Chapter = {
      id: 1,
      title: 'Ch 1',
      duration: '10:00',
      state: 'done',
      progress: 1,
      characters: {},
    };
    const sentence: Sentence = {
      id: 1,
      chapterId: 1,
      characterId: 'narrator',
      text: 'A line of dialogue.',
    };
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
          sentences: [sentence],
          importCandidate: null,
          pendingReupload: null,
          mergedAwayKeys: [],
        },
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={wideCast}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[sentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByText('A line of dialogue.'));
    await user.click(screen.getByText(/Change…/));
    const picker = screen.getByRole('dialog', { name: /reassign speaker/i });
    /* Sela sits at the end of a 30-row list. Pre-fix it was clipped
       below the inspector card; with the portal it's reachable. */
    const sela = within(picker).getByRole('option', { name: /^Sela$/ });
    await user.click(sela);

    expect(store.getState().manuscript.sentences[0].characterId).toBe('sela');
  });

  it('row Reassign popover stays open when the pointer leaves the segment row', async () => {
    const user = userEvent.setup();
    const cast: Character[] = [
      { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
      { id: 'eliza', name: 'Eliza', role: 'Cast', color: 'magenta' },
    ];
    const chapter: Chapter = {
      id: 1,
      title: 'Ch 1',
      duration: '10:00',
      state: 'done',
      progress: 1,
      characters: {},
    };
    const sentence: Sentence = {
      id: 1,
      chapterId: 1,
      characterId: 'narrator',
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
          characters={cast}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[sentence]}
        />
      </Provider>,
    );

    /* Hover the row to surface the Reassign button (it's `opacity-0`
       until the row is hovered or selected), then click to open. */
    const rowText = screen.getByText('A line of dialogue.');
    const rowContainer = rowText.closest('.group') as HTMLElement;
    expect(rowContainer).not.toBeNull();
    await user.hover(rowContainer);
    /* Two Reassign buttons exist in the tree (row + inspector) once the
       segment is selected — we want the row-level one. The row's button
       is the FIRST occurrence (sibling to the sentence text), but we
       haven't clicked-to-select yet so only the row button is in the
       DOM. */
    await user.click(screen.getByRole('button', { name: /^Reassign$/ }));

    /* Picker open: it's portalled so the standalone dialog query works. */
    const picker = screen.getByRole('dialog', { name: /reassign speaker/i });
    expect(picker).toBeInTheDocument();

    /* Move pointer off the row — the OLD onMouseLeave-on-row dismissal
       closed the popover here, breaking "move into the picker to click
       a row". The fix: dismissal is click-outside-only, so the picker
       must remain mounted. */
    await user.unhover(rowContainer);
    expect(screen.queryByRole('dialog', { name: /reassign speaker/i })).toBeInTheDocument();
  });
});

/* Plan 81 Wave 3 — mobile/tablet responsive scaffolding.

   jsdom doesn't honour Tailwind breakpoints (no real layout engine), so
   we can't assert "the desktop sidebar is hidden at 375px." What we can
   pin is the structural contract that survives the responsive rewrite:

   1) The view renders without throwing at a mocked mobile viewport.
   2) The mobile hamburger trigger ("Open chapter list" aria-label) is in
      the DOM regardless of viewport — Tailwind hides it via CSS at `lg:`.
   3) Clicking the hamburger surfaces the drawer (role=dialog + the
      chapter list inside).
   4) The desktop sticky sidebar + the drawer render the same chapter
      buttons — both paths share the SidebarPanels subtree, so the
      drawer button click goes through the same setCurrentChapterId
      wiring. Smoke-tests the "drawer auto-closes on chapter pick" wrap.

   Layout-correctness (no horizontal overflow at 375×667) belongs in
   Playwright (Wave 5) — see docs/features/archive/81-mobile-tablet-support.md. */
describe('ManuscriptView — responsive scaffolding (plan 81 wave 3)', () => {
  const r3Characters: Character[] = [
    { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  ];
  const r3Chapters: Chapter[] = [
    { id: 1, title: 'Chapter One', duration: '10:00', state: 'done', progress: 1, characters: {} },
    { id: 2, title: 'Chapter Two', duration: '10:00', state: 'done', progress: 1, characters: {} },
  ];
  const r3Sentences: Sentence[] = [
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'A line.' },
    { id: 1, chapterId: 2, characterId: 'narrator', text: 'Another line.' },
  ];

  function renderResponsive(currentChapterId = 1) {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    const setCurrent = vi.fn();
    const utils = render(
      <Provider store={store}>
        <ManuscriptView
          characters={r3Characters}
          chapters={r3Chapters}
          currentChapterId={currentChapterId}
          setCurrentChapterId={setCurrent}
          sentencesFromStore={r3Sentences}
        />
      </Provider>,
    );
    return { ...utils, setCurrent, store };
  }

  it('renders without throwing under a 375×667 matchMedia mock', () => {
    /* Force matchMedia to report mobile (every query returns false)
       just so any code that runs window.matchMedia at mount time
       doesn't observe a stale `matches: true`. The view itself uses
       CSS-only Tailwind breakpoints, but a mock keeps the test honest
       if responsive JS state lands later. */
    const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: matchMediaMock,
    });
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', {
      writable: true,
      configurable: true,
      value: 667,
    });

    expect(() => renderResponsive()).not.toThrow();
    /* Heading still renders — view content survived the responsive
       rewrite, not just the shell. */
    expect(screen.getByRole('heading', { name: /Chapter One/ })).toBeInTheDocument();
  });

  it('exposes a hamburger trigger and surfaces the chapter list inside a drawer when tapped', async () => {
    const user = userEvent.setup();
    const { setCurrent } = renderResponsive(1);

    /* Trigger is always in the DOM — Tailwind `lg:hidden` removes it
       only visually at desktop width. */
    const hamburger = screen.getByRole('button', { name: /Open chapter list/i });
    expect(hamburger).toBeInTheDocument();

    /* Drawer is unmounted until opened. */
    expect(screen.queryByRole('dialog', { name: /Chapters/i })).toBeNull();

    await user.click(hamburger);

    /* Drawer mounted with a close button + the chapter list rows. */
    const drawer = screen.getByRole('dialog', { name: /Chapters/i });
    expect(drawer).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close drawer/i })).toBeInTheDocument();

    /* Picking a chapter inside the drawer fires the same setter the
       desktop sidebar uses, and the drawer auto-closes (handleChapterPick
       wraps the prop). Use getAllByRole because both the desktop sidebar
       (currently hidden under `lg:hidden` at jsdom default width, but
       still mounted) and the drawer render their own copy of the button. */
    const drawerChapterTwo = within(drawer).getByRole('button', { name: /Chapter Two/ });
    await user.click(drawerChapterTwo);
    expect(setCurrent).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('dialog', { name: /Chapters/i })).toBeNull();
  });
});

/* Plan 92 — manuscript view virtualisation.
   The view falls back to a flat `segments.map` render below 60
   segments (preserves UX + keeps jsdom tests on the simple path) and
   switches to `useWindowVirtualizer` from `@tanstack/react-virtual`
   above the threshold. These cases pin the threshold semantics; the
   actual windowing behaviour (only visible rows in DOM) is verified
   end-to-end by Playwright since jsdom can't measure layout. */
describe('ManuscriptView — virtualisation threshold (plan 92)', () => {
  const narrator: Character = {
    id: 'narrator',
    name: 'Narrator',
    role: 'Narrator',
    color: 'narrator',
  };
  const dialogue: Character = {
    id: 'speaker',
    name: 'Speaker',
    role: 'Lead',
    color: 'slot-4',
  };
  const chapter: Chapter = {
    id: 1,
    title: 'Long Chapter',
    duration: '40:00',
    state: 'done',
    progress: 1,
    characters: {},
  };

  function renderWithSentenceCount(count: number) {
    /* Alternating-character sentences guarantee one segment per
       sentence (the segmenter only folds *consecutive* same-speaker
       sentences). So `count` sentences ⇒ `count` segments. */
    const sentences: Sentence[] = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      chapterId: 1,
      characterId: i % 2 === 0 ? 'narrator' : 'speaker',
      text: `Sentence ${i + 1}.`,
    }));
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={[narrator, dialogue]}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={sentences}
        />
      </Provider>,
    );
  }

  it('renders the flat segment list below the 60-segment threshold (no virtual container)', () => {
    renderWithSentenceCount(20);
    expect(screen.queryByTestId('manuscript-virtual-container')).toBeNull();
    /* Sanity — at least some sentence content rendered. */
    expect(screen.getByText('Sentence 1.')).toBeInTheDocument();
  });

  it('switches to the virtualised container above the threshold', () => {
    renderWithSentenceCount(120);
    expect(screen.getByTestId('manuscript-virtual-container')).toBeInTheDocument();
  });
});

describe('ManuscriptView — guided-tour demonstrations (fe-38)', () => {
  const tourChars: Character[] = [
    { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
    { id: 'oduvan', name: 'Master Oduvan', role: 'Blacksmith', color: 'mentor' },
  ];
  const tourChapter: Chapter = {
    id: 2,
    title: 'The Knock',
    duration: '05:00',
    state: 'done',
    progress: 1,
    characters: { narrator: 'done', oduvan: 'done' },
  };
  const tourSentences: Sentence[] = [
    { id: 1, chapterId: 2, characterId: 'narrator', text: 'The forge had gone cold.' },
    { id: 2, chapterId: 2, characterId: 'oduvan', text: 'Leave it.' },
  ];

  function renderAtStep(stepId: string) {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        tour: tourSlice.reducer,
      },
    });
    store.dispatch(tourSlice.actions.startTour({ tourId: 'linear', mode: 'linear' }));
    store.dispatch(tourSlice.actions.setStepIndex(TOUR_STEPS.findIndex((s) => s.id === stepId)));
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={tourChars}
          chapters={[tourChapter]}
          currentChapterId={2}
          setCurrentChapterId={() => {}}
          sentencesFromStore={tourSentences}
        />
      </Provider>,
    );
  }

  it('s4 "Who says each line" dims the manuscript to one speaker (filter active)', () => {
    renderAtStep('s4-line');
    /* The filtered speaker's Detected row flips to the "Clear filter" affordance. */
    expect(screen.getByTitle('Clear filter')).toBeInTheDocument();
    /* No line is selected on this step, so the inspector stays closed. */
    expect(screen.queryByLabelText('Close inspector')).toBeNull();
  });

  it('s5 "Chapters & paragraphs" opens the side-drawer on a character line', () => {
    renderAtStep('s5-boundary');
    expect(screen.getAllByLabelText('Close inspector').length).toBeGreaterThan(0);
    /* The speaker dim is cleared on this step. */
    expect(screen.queryByTitle('Clear filter')).toBeNull();
  });
});

/* fs-58 Task 11 — whole-book disclosure menu dismissal (Fix 2).
   The ⌄ toggle opens a small popover; an outside pointerdown or Escape
   must close it so it doesn't linger after the user clicks away. */
describe('ManuscriptView — review-menu dismissal', () => {
  const reviewChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };

  function renderReviewView() {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-menu',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[reviewChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );
  }

  it('dismisses the whole-book menu on Escape', async () => {
    const user = userEvent.setup();
    renderReviewView();

    const toggle = screen.getByTestId('review-script-menu-toggle');
    await user.click(toggle);
    /* Menu must now be open. */
    expect(screen.getByTestId('review-script-wholebook')).toBeInTheDocument();

    /* Press Escape — menu must close. */
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('review-script-wholebook')).toBeNull();
  });

  it('dismisses the whole-book menu on outside pointerdown', async () => {
    const user = userEvent.setup();
    renderReviewView();

    const toggle = screen.getByTestId('review-script-menu-toggle');
    await user.click(toggle);
    expect(screen.getByTestId('review-script-wholebook')).toBeInTheDocument();

    /* Pointer-down on the document body (outside the menu wrapper). */
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('review-script-wholebook')).toBeNull();
  });

  it('renders the whole-book menu above sibling sections (z-50 + opaque picker-surface)', async () => {
    const user = userEvent.setup();
    renderReviewView();

    await user.click(screen.getByTestId('review-script-menu-toggle'));
    /* The dropdown flyout is the parent of the whole-book button. It must sit
       at z-50 (above the z-40 content below it — the old z-20 left it hidden
       behind sibling sections) and carry the opaque picker-surface elevation. */
    const menu = screen.getByTestId('review-script-wholebook').parentElement!;
    expect(menu.className).toContain('z-50');
    expect(menu.className).toContain('picker-surface');
    expect(menu.className).not.toContain('z-20');
  });
});

/* fs-58 Task 11 — planApply quarantine at seed time (Fix 1).
   When the SSE stream returns an op whose target id is NOT in the live
   sentences, it must land in `unappliable` — NOT in the selectable `ops`
   list — so the diff modal never presents a no-op to the user. */
describe('ManuscriptView — script-review planApply quarantine at seed', () => {
  beforeEach(() => reviewScript.mockReset());

  const quarantineChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };
  const liveSentence: Sentence = { id: 1, chapterId: 1, characterId: 'narrator', text: 'Live line.' };

  function makeQuarantineStore() {
    return configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [liveSentence] as never,
        },
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-1',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
  }

  it('seeds ops with only resolvable ops; stale-id op goes to unappliable', async () => {
    const user = userEvent.setup();
    const store = makeQuarantineStore();

    /* Mock: stream returns one resolvable strip_tag (id=1) and one stale
       fix_emotion (id=999, which does not exist in live sentences). */
    reviewScript.mockImplementation(async (_bookId: string, opts?: { onOps?: (arg: { chapterId: number; ops: object[] }) => void }) => {
      opts?.onOps?.({
        chapterId: 1,
        ops: [
          { id: 1, op: 'strip_tag', newText: 'Live line fixed.', rationale: 'tag' },
          { id: 999, op: 'fix_emotion', emotion: 'excited', rationale: 'stale' },
        ],
      });
    });

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[quarantineChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[liveSentence]}
        />
      </Provider>,
    );

    /* Trigger per-chapter review. */
    await user.click(screen.getByTestId('review-script-chapter'));

    /* Wait for the async handler to dispatch. */
    await waitFor(() => {
      const state = store.getState() as { scriptReview: { byBook: Record<string, { ops: { id: number }[]; unappliable: { op: { id: number } }[] }> } };
      const review = state.scriptReview.byBook['bk-1'];
      expect(review).toBeDefined();
      /* The resolvable op (id=1) must be in ops. */
      expect(review.ops.some((o) => o.id === 1)).toBe(true);
      /* The stale op (id=999) must NOT be in ops. */
      expect(review.ops.some((o) => o.id === 999)).toBe(false);
      /* The stale op must be in unappliable. */
      expect(review.unappliable.some((u) => u.op.id === 999)).toBe(true);
    });
  });

  /* fs-58 Task 7 — the seed-path guard against the dead-feature window:
     planApply runs at seed time over the widened live builder, so a
     validate_instruct REPAIR op against a sentence that ALREADY has an
     instruct must reach `review.ops`. The sentence is explicitly seeded
     with `instruct: 'shouting'` — without it the repair guard drops the
     op (no current instruct) and the test would false-green. */
  it('seeds a validate_instruct repair op when the live sentence has an instruct', async () => {
    const user = userEvent.setup();
    const instructSentence: Sentence = {
      id: 1,
      chapterId: 1,
      characterId: 'narrator',
      text: 'Live line.',
      instruct: 'shouting',
    };
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [instructSentence] as never,
        },
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-1',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });

    reviewScript.mockImplementation(async (_bookId: string, opts?: { onOps?: (arg: { chapterId: number; ops: object[] }) => void }) => {
      opts?.onOps?.({
        chapterId: 1,
        ops: [{ id: 1, op: 'validate_instruct', newInstruct: 'a calm, even tone', rationale: 'instruct contradicts line' }],
      });
    });

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[quarantineChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[instructSentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-chapter'));

    await waitFor(() => {
      const state = store.getState() as { scriptReview: { byBook: Record<string, { ops: { id: number }[]; unappliable: { op: { id: number } }[] }> } };
      const review = state.scriptReview.byBook['bk-1'];
      expect(review).toBeDefined();
      /* The repair op lands in ops, NOT unappliable (widened live builder
         surfaced the seeded instruct so the repair guard passed). */
      expect(review.ops.some((o) => o.id === 1)).toBe(true);
      expect(review.unappliable.some((u) => u.op.id === 1)).toBe(false);
    });
  });

  it('shows chapter count + ETA on the Review Script inline chip while a review runs', async () => {
    const user = userEvent.setup();
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [liveSentence] as never,
        },
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-1',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });

    let triggerResolve!: () => void;
    reviewScript.mockImplementation(
      (
        _bookId: string,
        opts?: {
          onPhase?: (e: {
            progress: number;
            label?: string;
            chapterIndex?: number;
            totalChapters?: number;
            estRemainingMs?: number;
          }) => void;
        },
      ) => {
        opts?.onPhase?.({
          progress: 0.25,
          label: 'Reviewing script',
          chapterIndex: 3,
          totalChapters: 12,
          estRemainingMs: 125_000,
        });
        return new Promise<void>((resolve) => {
          triggerResolve = resolve;
        });
      },
    );

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[quarantineChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[liveSentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-chapter'));

    await waitFor(() =>
      expect(screen.getByTestId('review-script-progress-detail').textContent).toBe(
        'Chapter 3 of 12 · ~2m left',
      ),
    );

    /* Settle the mock's promise before the test ends so no dangling
       in-flight review stream outlives this test (avoids polluting the
       next test / cleanup). */
    triggerResolve();
    reviewScript.mockReset();
  });

  it('clicking Cancel on the progress pill calls api.cancelScriptReview with the book id', async () => {
    const user = userEvent.setup();
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [liveSentence] as never,
        },
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-1',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });

    let triggerResolve!: () => void;
    reviewScript.mockImplementation(
      (
        _bookId: string,
        opts?: { onPhase?: (e: { progress: number; label?: string }) => void },
      ) => {
        opts?.onPhase?.({ progress: 0.3, label: 'Reviewing script' });
        return new Promise<void>((resolve) => {
          triggerResolve = resolve;
        });
      },
    );

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[quarantineChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[liveSentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-chapter'));
    await waitFor(() => expect(screen.getByTestId('review-script-progress')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelScriptReview).toHaveBeenCalledWith('bk-1');

    /* Settle the mock's promise before the test ends — same cleanup
       discipline as the sibling "shows chapter count + ETA" test above. */
    triggerResolve();
    reviewScript.mockReset();
  });
});

/* fs-58 — handleReviewScript error surface (Fix 2).
   When api.reviewScript rejects, an error toast must be dispatched so
   the user sees feedback rather than the button going silently dead.

   The mock uses a controlled-resolution promise so the rejection fires
   AFTER the component's async handler is already awaiting it — this
   ensures the try/catch in handleReviewScript is the one that sees the
   rejection (rather than vitest's global unhandled-rejection tracker
   seeing a synchronously-thrown error from a mockRejectedValue call). */
describe('ManuscriptView — handleReviewScript error toast', () => {
  it('dispatches an error toast when api.reviewScript rejects', async () => {
    const user = userEvent.setup();

    /* Controlled promise: resolve/reject are captured so we can fire the
       rejection after the component has started awaiting. */
    let triggerReject!: (e: Error) => void;
    reviewScript.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          triggerReject = reject;
        }),
    );

    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        notifications: notificationsSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-err',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });

    const errChapter: Chapter = {
      id: 1,
      title: 'Chapter One',
      duration: '10:00',
      state: 'done',
      progress: 1,
      characters: {},
    };

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[errChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    /* Click the review button — the component starts awaiting the promise. */
    await user.click(screen.getByTestId('review-script-chapter'));

    /* Now reject the controlled promise so handleReviewScript's catch fires. */
    triggerReject(new Error('Quota exceeded'));

    await waitFor(() => {
      const toasts: Toast[] = store.getState().notifications.toasts;
      expect(toasts.some((t) => t.kind === 'error' && t.message.includes('Quota exceeded'))).toBe(
        true,
      );
    });

    /* Reset the mock so the next test run doesn't get a dangling promise. */
    reviewScript.mockReset();
  });
});

/* fs-58 Unit B — excluded sentence rendering (Task 13).
   An excluded sentence must render struck-through + greyed, show a re-include
   toggle, and suppress the emotion/instruct delivery chips. */
describe('ManuscriptView — excluded sentence UX (fs-58 Unit B)', () => {
  const excludedChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: { narrator: 'done' },
  };
  const excludedSentence: Sentence = {
    id: 42,
    chapterId: 1,
    characterId: 'narrator',
    text: 'p. 42',
    excludeFromSynthesis: true,
  };
  const includedSentence: Sentence = {
    id: 43,
    chapterId: 1,
    characterId: 'narrator',
    text: 'Normal included line.',
  };

  function renderExcludedView() {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [excludedSentence, includedSentence] as never,
        },
      },
    });
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[excludedChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[excludedSentence, includedSentence]}
        />
      </Provider>,
    );
  }

  it('renders an excluded sentence struck with a re-include toggle and no emotion/instruct chips (fs-58 Unit B)', () => {
    renderExcludedView();

    /* The text node is an inner span inside data-sentence-id; walk up to the
       data-sentence-id ancestor to assert the struck styling. */
    const textNode = screen.getByText('p. 42');
    const sentenceSpan = textNode.closest('[data-sentence-id]');
    expect(sentenceSpan).not.toBeNull();
    expect(sentenceSpan!.className).toMatch(/line-through/);
    expect(sentenceSpan!.className).toMatch(/opacity-50/);

    /* Re-include toggle must be present for the excluded sentence. */
    expect(screen.getByTestId('reinclude-toggle-42')).toBeInTheDocument();

    /* Emotion and instruct chips are suppressed for the excluded sentence.
       The included sentence still renders instruct chips, so we must check
       only the excluded sentence's chips are absent. */
    /* There is no instruct-chip associated with the excluded sentence;
       the included sentence may have one so we cannot assert zero globally.
       Instead: the re-include button is present for id 42 but NOT for id 43. */
    expect(screen.queryByTestId('reinclude-toggle-43')).toBeNull();
  });

  it('dispatches setSentenceExcluded(excluded:false) when re-include toggle is clicked', async () => {
    const user = userEvent.setup();
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [excludedSentence] as never,
        },
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[excludedChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[excludedSentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('reinclude-toggle-42'));

    /* After click the sentence is no longer excluded in the store. */
    const after = store.getState().manuscript.sentences;
    expect(after[0].excludeFromSynthesis).toBe(false);
  });
});

/* fs-58 Unit B Task 14 — "Add character" button opens CreateCharacterForm,
   submits via api.createCharacter, and dispatches castActions.addCharacter
   so the new member appears in the Detected sidebar. */
describe('ManuscriptView — Add character button (fs-58 Unit B Task 14)', () => {
  const addCharChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: { narrator: 'done' },
  };

  function renderAddCharView() {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
        cast: castSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-addchar',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        cast: {
          characters: [{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' }],
          renderedFallbackByCharacter: {},
        },
      },
    });
    return { store, ...render(
      <Provider store={store}>
        <ManuscriptView
          characters={[{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' }]}
          chapters={[addCharChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    ) };
  }

  beforeEach(() => {
    createCharacter.mockReset();
    createCharacter.mockResolvedValue({
      character: { id: 'ferra', name: 'Ferra', role: 'character', color: 'unset' },
    });
  });

  it('opens the create-character form and creates on submit (fs-58 Unit B)', async () => {
    const user = userEvent.setup();
    const { store } = renderAddCharView();

    /* Before clicking "Add character", the form must not be visible. */
    expect(screen.queryByTestId('create-character-form')).toBeNull();

    /* Click the "Add character" button in the Detected sidebar. */
    fireEvent.click(screen.getByRole('button', { name: /add character/i }));

    /* The CreateCharacterForm must now be visible. */
    expect(screen.getByTestId('create-character-form')).toBeInTheDocument();

    /* Type a name and submit. */
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ferra' } });
    await user.click(screen.getByTestId('create-character-submit'));

    /* api.createCharacter must have been called with the bookId and name. */
    await waitFor(() =>
      expect(createCharacter).toHaveBeenCalledWith(
        'bk-addchar',
        expect.objectContaining({ name: 'Ferra' }),
      ),
    );

    /* castActions.addCharacter must have been dispatched — Ferra is in the cast store. */
    await waitFor(() => {
      const castState = store.getState().cast as { characters: { id: string; name: string }[] };
      expect(castState.characters.some((c) => c.name === 'Ferra')).toBe(true);
    });

    /* The form must be dismissed after a successful create. */
    await waitFor(() => expect(screen.queryByTestId('create-character-form')).toBeNull());
  });

  it('on a failed create: shows an error toast and keeps the form open (#1122)', async () => {
    const user = userEvent.setup();
    createCharacter.mockReset();
    createCharacter.mockRejectedValue(new Error('boom'));

    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
        cast: castSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: { kind: 'ready', bookId: 'bk-addchar', view: 'manuscript', currentChapterId: 1, openProfileId: null } as never,
        },
        cast: { characters: [{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' }], renderedFallbackByCharacter: {} },
      },
    });

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={[{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' }]}
          chapters={[{ id: 1, title: 'Chapter One', duration: '10:00', state: 'done', progress: 1, characters: { narrator: 'done' } }]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /add character/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ferra' } });
    await user.click(screen.getByTestId('create-character-submit'));

    // Error toast surfaced.
    await waitFor(() => {
      const toasts: Toast[] = store.getState().notifications.toasts;
      expect(toasts.some((t) => t.kind === 'error' && /couldn't create character/i.test(t.message))).toBe(
        true,
      );
    });
    // Form still open for retry.
    expect(screen.getByTestId('create-character-form')).toBeInTheDocument();
  });
});

describe('isExcludedSentenceId', () => {
  const rows = [
    { chapterId: 1, id: 1, excludeFromSynthesis: true },
    { chapterId: 1, id: 2 },
    { chapterId: 2, id: 1 }, // same id, different chapter, NOT excluded
  ];
  it('is true for an excluded sentence', () => {
    expect(isExcludedSentenceId(rows, 1, 1)).toBe(true);
  });
  it('is false for a non-excluded sentence', () => {
    expect(isExcludedSentenceId(rows, 1, 2)).toBe(false);
  });
  it('is scoped by chapter (no cross-chapter id collision)', () => {
    expect(isExcludedSentenceId(rows, 2, 1)).toBe(false);
  });
  it('is false when the sentence is not found', () => {
    expect(isExcludedSentenceId(rows, 9, 9)).toBe(false);
  });
});

describe('ManuscriptView — promote first sentence to title (2026-07-01)', () => {
  function renderPromote(currentChapterId: number, chapterSentences: Sentence[]) {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        ui: uiSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId } as never,
        },
      },
    });
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[chapter1, chapter2]}
          currentChapterId={currentChapterId}
          setCurrentChapterId={() => {}}
          sentencesFromStore={chapterSentences}
        />
      </Provider>,
    );
  }

  it('promotes the minimum-id sentence even when it is not first in the array (finding 1 regression)', () => {
    renderPromote(2, [
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'It was a quiet morning.' } as never,
      { id: 1, chapterId: 2, characterId: 'narrator', text: 'PUPPY TRAINING.' } as never,
    ]);
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByRole('dialog', { name: 'Use first line as title' })).toHaveTextContent(
      'PUPPY TRAINING',
    );
  });

  it('disables the button and does not crash on a zero-sentence chapter (finding 4 regression)', () => {
    renderPromote(2, []);
    expect(screen.getByTestId('promote-first-sentence-button')).toBeDisabled();
  });

  it('wires isOnlySentence=true for a chapter with exactly one sentence (PR-gate finding 2)', () => {
    renderPromote(2, [
      { id: 1, chapterId: 2, characterId: 'narrator', text: 'PUPPY TRAINING.' } as never,
    ]);
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent("chapter's only sentence");
  });

  it('wires isOnlySentence=false for a chapter with more than one sentence (PR-gate finding 2)', () => {
    renderPromote(2, [
      { id: 1, chapterId: 2, characterId: 'narrator', text: 'PUPPY TRAINING.' } as never,
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'You brought home a puppy.' } as never,
    ]);
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByRole('dialog')).not.toHaveTextContent("chapter's only sentence");
  });

  it('resets the confirm popover to idle when the current chapter changes without clicking Cancel (PR-gate finding 1)', () => {
    /* Regression for the stale-popover bug: PromoteFirstSentenceButton is
       mounted without a `key` tied to the chapter, so switching chapters
       WITHOUT clicking Cancel first used to leave the popover open,
       silently retargeting at the new chapter (its `cleaned` text and
       `chapterId` are derived fresh from props each render). The fix keys
       the mount on `currentChapter.id` so a chapter switch unmounts and
       remounts the button, resetting its internal `phase` state to
       'idle'. */
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        ui: uiSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId: 2 } as never,
        },
      },
    });
    const sentencesBothChapters: Sentence[] = [
      { id: 1, chapterId: 2, characterId: 'narrator', text: 'PUPPY TRAINING.' } as never,
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'A different opener.' } as never,
    ];
    function renderAt(currentChapterId: number) {
      return (
        <Provider store={store}>
          <ManuscriptView
            characters={characters}
            chapters={[chapter1, chapter2]}
            currentChapterId={currentChapterId}
            setCurrentChapterId={() => {}}
            sentencesFromStore={sentencesBothChapters}
          />
        </Provider>
      );
    }

    const { rerender } = render(renderAt(2));
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent('PUPPY TRAINING');

    // Simulate switching to a different chapter WITHOUT clicking Cancel first.
    rerender(renderAt(1));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

/* fs-58 Task 10 — unresolved-findings count helper + the Review Script
   button/menu badges it drives (design spec §6.3). */
describe('unresolvedCountForChapters', () => {
  it('counts only ops in the given chapters', () => {
    const bucket = {
      ops: [
        { id: 1, op: 'strip_tag', chapterId: 1, rationale: 'r' },
        { id: 2, op: 'fix_emotion', chapterId: 2, rationale: 'r' },
      ],
      unappliable: [],
      selected: {},
      manuscriptId: 'ms-1',
      versionByChapter: { 1: 1, 2: 1 },
      visible: true,
    } as never;
    expect(unresolvedCountForChapters(bucket, [1])).toBe(1);
    expect(unresolvedCountForChapters(bucket, [1, 2])).toBe(2);
    expect(unresolvedCountForChapters(undefined, [1])).toBe(0);
  });
});

describe('ManuscriptView — unresolved-findings badge', () => {
  const badgeChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };
  const otherChapter: Chapter = {
    id: 2,
    title: 'Chapter Two',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };

  function renderBadgeView(currentChapterId: number) {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        scriptReview: {
          byBook: {
            'bk-badge': {
              ops: [{ id: 1, op: 'strip_tag', chapterId: 1, rationale: 'r' }],
              unappliable: [],
              selected: {},
              manuscriptId: 'ms-1',
              versionByChapter: { 1: 1 },
              visible: true,
            },
          },
          activeStreams: {},
        } as never,
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-badge',
            view: 'manuscript',
            currentChapterId,
            openProfileId: null,
          } as never,
        },
      },
    });
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[badgeChapter, otherChapter]}
          currentChapterId={currentChapterId}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );
  }

  it('shows a count badge on the Review Script button when the current chapter has unresolved findings', () => {
    renderBadgeView(1);
    expect(screen.getByTestId('review-script-chapter')).toHaveTextContent('Review Script (1)');
  });

  it('omits the badge when the current chapter has no unresolved findings', () => {
    renderBadgeView(2);
    expect(screen.getByTestId('review-script-chapter')).toHaveTextContent('Review Script');
    expect(screen.getByTestId('review-script-chapter')).not.toHaveTextContent('Review Script (');
  });

  /* PR-gate finding 1 — wholeBookUnresolvedCount must agree with
     handleReviewScript's targetChapterIds scope (both exclude excluded
     chapters), or the badge implies a confirm-gate prompt that a click
     on "Review whole book" then silently skips. */
  it('excludes an excluded chapter\'s unresolved ops from the whole-book badge, matching the confirm-gate scope', async () => {
    reviewScript.mockReset();
    const user = userEvent.setup();
    const excludedChapter: Chapter = { ...otherChapter, excluded: true };
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        scriptReview: {
          byBook: {
            'bk-badge-excl': {
              // The only op is on the now-excluded chapter — a whole-book
              // review will never touch it, so the badge must not count it.
              ops: [{ id: 1, op: 'strip_tag', chapterId: 2, rationale: 'r' }],
              unappliable: [],
              selected: {},
              manuscriptId: 'ms-1',
              versionByChapter: { 2: 1 },
              visible: true,
            },
          },
          activeStreams: {},
        } as never,
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-badge-excl',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[badgeChapter, excludedChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-menu-toggle'));
    const wholeBookButton = screen.getByTestId('review-script-wholebook');
    expect(wholeBookButton).toHaveTextContent('Review whole book');
    expect(wholeBookButton).not.toHaveTextContent('unresolved');

    // Clicking through must match the badge: no confirm gate, since the
    // excluded chapter's op is out of scope for both.
    await user.click(wholeBookButton);
    expect(screen.queryByTestId('review-script-confirm-gate')).toBeNull();
    expect(reviewScript).toHaveBeenCalled();
  });
});

/* Round-3 review Critical Finding 1 — the mount-time hydration effect was
   fire-and-forget with no loading flag, so a fast click on Review Script
   before hydrateScriptReview's GET /state fetch resolved would see an
   undefined scriptReviewBucket, read 0 unresolved findings, and skip the
   confirm gate entirely — silently overwriting a chapter's still-unresolved
   persisted findings. This pins the fix: the button must stay disabled for
   the lifetime of the mount-time hydration fetch. */
describe('ManuscriptView — mount hydration race (fs-58 PR review round 3, Finding 1)', () => {
  const hydrationChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };

  beforeEach(() => {
    getScriptReviewState.mockReset();
  });

  afterEach(() => {
    // Restore the file-wide default (a resolved empty ledger) so later
    // describe blocks' mount-time hydration doesn't hang forever on the
    // never-resolving promise this block installs.
    getScriptReviewState.mockReset().mockResolvedValue({ kind: 'ledger', entries: {} });
  });

  function renderHydrationView() {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-hydrate',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[hydrationChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );
  }

  it('disables the Review Script button while the mount-time hydration fetch is pending, and re-enables it once resolved', async () => {
    let resolveHydration!: (value: { kind: 'ledger'; entries: Record<string, never> }) => void;
    getScriptReviewState.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        }),
    );

    renderHydrationView();

    // Still pending — the button must be disabled, closing the race a fast
    // click would otherwise exploit.
    expect(screen.getByTestId('review-script-chapter')).toBeDisabled();
    expect(screen.getByTestId('review-script-menu-toggle')).toBeDisabled();

    // Resolve the hydration fetch.
    await act(async () => {
      resolveHydration({ kind: 'ledger', entries: {} });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('review-script-chapter')).not.toBeDisabled();
    });
    expect(screen.getByTestId('review-script-menu-toggle')).not.toBeDisabled();
  });
});

/* Round-4 review Finding 4 — the mount-time hydration effect is keyed only
   on [bookId] with no cleanup. If the user switches books before an
   in-flight hydration resolves, the effect re-fires for the NEW book — and
   if the STALE hydration for the OLD book then resolves, its `.finally`
   would clear scriptReviewHydrating for whichever book is on screen now,
   reopening the exact race Finding 1 (round 3, above) closed, just via
   cross-book interleaving instead of a same-book double-click. Pins the
   generation-counter fix: only the most recent effect run may clear the
   loading flag. */
describe('ManuscriptView — cross-book mount hydration race (fs-58 PR review round 4, Finding 4)', () => {
  const raceChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };

  beforeEach(() => {
    getScriptReviewState.mockReset();
  });

  afterEach(() => {
    getScriptReviewState.mockReset().mockResolvedValue({ kind: 'ledger', entries: {} });
  });

  function renderRaceView(store: ReturnType<typeof configureStore>) {
    return render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[raceChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );
  }

  it('a stale hydration for a book the user switched away from does not clear the loading flag for the NEW (current) book', async () => {
    const resolvers: Array<(v: { kind: 'ledger'; entries: Record<string, never> }) => void> = [];
    getScriptReviewState.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });

    renderRaceView(store);

    // Book A's mount-time hydration is in flight — button disabled.
    expect(resolvers).toHaveLength(1);
    expect(screen.getByTestId('review-script-chapter')).toBeDisabled();

    // The user switches to book B before A's hydration resolves — the
    // effect re-fires (still keyed on [bookId]), starting a SECOND
    // hydration and bumping the generation counter.
    await act(async () => {
      store.dispatch(uiActions.openBook({ id: 'bk-B', status: 'complete' }));
    });
    expect(resolvers).toHaveLength(2);
    expect(screen.getByTestId('review-script-chapter')).toBeDisabled();

    // Book A's STALE hydration resolves. Pre-fix, this `.finally` would
    // unconditionally clear scriptReviewHydrating — re-enabling the button
    // while book B's (current) hydration is still pending.
    await act(async () => {
      resolvers[0]({ kind: 'ledger', entries: {} });
      await Promise.resolve();
    });
    expect(screen.getByTestId('review-script-chapter')).toBeDisabled();

    // Book B's hydration (the current generation) resolves — only NOW does
    // the flag clear.
    await act(async () => {
      resolvers[1]({ kind: 'ledger', entries: {} });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('review-script-chapter')).not.toBeDisabled();
    });
  });
});

describe('ManuscriptView — re-run confirm gate (fs-58 Task 11)', () => {
  const gateChapter: Chapter = {
    id: 1,
    title: 'Chapter One',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };
  const otherGateChapter: Chapter = {
    id: 2,
    title: 'Chapter Two',
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
  };

  beforeEach(() => {
    reviewScript.mockReset();
    discardScriptReview.mockReset();
    discardScriptReview.mockResolvedValue(undefined);
  });

  function renderGateView() {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        scriptReview: {
          byBook: {
            'bk-gate': {
              ops: [{ id: 1, op: 'strip_tag', chapterId: 1, rationale: 'r' }],
              unappliable: [],
              selected: {},
              manuscriptId: 'ms-1',
              versionByChapter: { 1: 1 },
              // Starts hidden — this is the "prior run finished, badge shows
              // the count" state the re-run gate fires from; "Review
              // existing" flips it back to visible.
              visible: false,
            },
          },
          activeStreams: {},
        } as never,
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-gate',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[gateChapter, otherGateChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );
    return store;
  }

  it('clicking Review Script with unresolved findings in scope opens a confirm dialog instead of starting a new run', async () => {
    const user = userEvent.setup();
    renderGateView();

    await user.click(screen.getByTestId('review-script-chapter'));

    expect(screen.getByTestId('review-script-confirm-gate')).toBeInTheDocument();
    expect(screen.getByTestId('review-script-confirm-review-existing')).toBeInTheDocument();
    expect(screen.getByTestId('review-script-confirm-discard')).toBeInTheDocument();
    expect(reviewScript).not.toHaveBeenCalled();
  });

  it('"Review existing" in the confirm dialog reopens the hidden modal without discarding', async () => {
    const user = userEvent.setup();
    const store = renderGateView();

    await user.click(screen.getByTestId('review-script-chapter'));
    await user.click(screen.getByTestId('review-script-confirm-review-existing'));

    const state = store.getState() as { scriptReview: { byBook: Record<string, { visible: boolean }> } };
    expect(state.scriptReview.byBook['bk-gate'].visible).toBe(true);
    expect(discardScriptReview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('review-script-confirm-gate')).toBeNull();
  });

  /* Round-2 review Important Finding 4 — the confirm-gate dialog's TEXT read
     the LIVE `currentChapter.id` prop instead of `confirmGate.chapterIds[0]`,
     the chapter actually frozen at gate-open time. If the user navigates to
     a different chapter while the dialog is still open (browser Back/
     Forward, which the modal's CSS backdrop doesn't intercept), the dialog
     could show the NEW chapter's id while "Discard and start new" silently
     discards the ORIGINAL (frozen) chapter — misleading the user about what
     they're about to discard. This drives that exact sequence via `rerender`
     with a new `currentChapterId` prop, standing in for a live navigation. */
  it('the confirm dialog keeps naming the chapter it was opened for, even if the live current chapter changes while it is open', async () => {
    const user = userEvent.setup();
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        scriptReview: {
          byBook: {
            'bk-gate': {
              ops: [{ id: 1, op: 'strip_tag', chapterId: 1, rationale: 'r' }],
              unappliable: [],
              selected: {},
              manuscriptId: 'ms-1',
              versionByChapter: { 1: 1 },
              visible: false,
            },
          },
          activeStreams: {},
        } as never,
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-gate',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
    const { rerender } = render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[gateChapter, otherGateChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    // Opens the gate for chapter 1 — confirmGate.chapterIds freezes [1].
    await user.click(screen.getByTestId('review-script-chapter'));
    expect(screen.getByTestId('review-script-confirm-gate')).toHaveTextContent('chapter 1');

    // The user navigates to chapter 2 while the dialog is still open (e.g.
    // browser Back/Forward) — the live `currentChapterId` prop changes, but
    // the gate itself is untouched.
    rerender(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[gateChapter, otherGateChapter]}
          currentChapterId={2}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    // The dialog must still name chapter 1 (the frozen scope), not the new
    // live chapter 2.
    expect(screen.getByTestId('review-script-confirm-gate')).toHaveTextContent('chapter 1');
    expect(screen.getByTestId('review-script-confirm-gate')).not.toHaveTextContent('chapter 2');
  });

  it('"Discard and start new" calls discardReview then starts a fresh run', async () => {
    const user = userEvent.setup();
    renderGateView();

    await user.click(screen.getByTestId('review-script-chapter'));
    await user.click(screen.getByTestId('review-script-confirm-discard'));

    await waitFor(() => {
      expect(discardScriptReview).toHaveBeenCalledWith('bk-gate', [1]);
    });
    await waitFor(() => {
      expect(reviewScript).toHaveBeenCalled();
    });
  });

  /* Round-3 review Important Finding 3 — "Discard and start new" used the
     LIVE `currentChapterId` to pick the restart target, not the chapter the
     confirm gate actually froze. Round 2 only fixed the dialog's DISPLAY
     text (confirmGate.chapterIds[0]); this pins the actual restart action:
     if the user navigates to a different chapter while the dialog is still
     open (browser Back/Forward isn't blocked by the modal), the new review
     must still target the FROZEN chapter, not whatever is live when the
     button is clicked. */
  it('"Discard and start new" restarts against the frozen gate chapter, not the live current chapter', async () => {
    const user = userEvent.setup();
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        scriptReview: {
          byBook: {
            'bk-gate': {
              ops: [{ id: 1, op: 'strip_tag', chapterId: 1, rationale: 'r' }],
              unappliable: [],
              selected: {},
              manuscriptId: 'ms-1',
              versionByChapter: { 1: 1 },
              visible: false,
            },
          },
          activeStreams: {},
        } as never,
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-gate',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
    const { rerender } = render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[gateChapter, otherGateChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    // Opens the gate for chapter 1 — confirmGate.chapterIds freezes [1].
    await user.click(screen.getByTestId('review-script-chapter'));
    expect(screen.getByTestId('review-script-confirm-gate')).toHaveTextContent('chapter 1');

    // The user navigates to chapter 2 while the dialog is still open (the
    // live `currentChapterId` prop changes, standing in for browser
    // Back/Forward, which the modal's CSS backdrop doesn't intercept).
    rerender(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[gateChapter, otherGateChapter]}
          currentChapterId={2}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-confirm-discard'));

    await waitFor(() => {
      expect(discardScriptReview).toHaveBeenCalledWith('bk-gate', [1]);
    });
    await waitFor(() => {
      expect(reviewScript).toHaveBeenCalled();
    });
    // The restart must target the FROZEN chapter (1), not the live chapter
    // (2) that became current while the dialog was still open.
    const [, reviewOpts] = reviewScript.mock.calls[0] as [string, { chapterId?: number }];
    expect(reviewOpts.chapterId).toBe(1);
  });

  /* PR-gate finding 2 — a failed discardScriptReview must surface an error
     toast instead of silently closing the confirm dialog with no feedback. */
  it('shows an error toast when "Discard and start new" fails', async () => {
    discardScriptReview.mockReset();
    discardScriptReview.mockRejectedValue(new Error('discard boom'));
    const user = userEvent.setup();

    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
      preloadedState: {
        scriptReview: {
          byBook: {
            'bk-gate': {
              ops: [{ id: 1, op: 'strip_tag', chapterId: 1, rationale: 'r' }],
              unappliable: [],
              selected: {},
              manuscriptId: 'ms-1',
              versionByChapter: { 1: 1 },
              visible: false,
            },
          },
          activeStreams: {},
        } as never,
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-gate',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[gateChapter, otherGateChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-chapter'));
    await user.click(screen.getByTestId('review-script-confirm-discard'));

    await waitFor(() => {
      const toasts: Toast[] = store.getState().notifications.toasts;
      expect(toasts.some((t) => t.kind === 'error' && /discard boom/i.test(t.message))).toBe(true);
    });
    // The confirm dialog does not reopen — the failure surfaces via toast,
    // not by reviving the closed dialog.
    expect(screen.queryByTestId('review-script-confirm-gate')).toBeNull();
    // A fresh run must NOT have started when the discard itself failed.
    expect(reviewScript).not.toHaveBeenCalled();
  });
});
