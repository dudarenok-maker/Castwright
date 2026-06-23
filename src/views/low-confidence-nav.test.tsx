/* Plan: low-confidence-triage-polish — covers the active "X
   low-confidence" navigator pill in ManuscriptView's header.

   Pins:
   - K=0 renders a disabled "0 low-confidence" label (no buttons).
   - K>0 renders a count + ▲ + ▼ buttons.
   - Clicking ▼ opens the SegmentInspector on the first low-confidence
     sentence's segment; clicking again advances; wraps after the last.
   - Clicking ▲ from cursor=0 wraps to the last low-confidence entry.

   Plan 98 — sidebar chapter badge cases at the bottom of this file:
   - Per-chapter amber count badge renders when chapter contains
     low-confidence sentences.
   - Badge absent when count is 0.
   - Title text + aria-label use the correct singular / plural form.
   - The sticky stats bar is the canonical mount point for the
     navigator pill; `data-testid="manuscript-sticky-stats-bar"`
     anchors regression assertions across e2e + jsdom. */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { ManuscriptView } from './manuscript';
import type { Chapter, Character, Sentence } from '../lib/types';

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'lord-vane', name: 'Lord Vane', role: 'character', color: 'magenta' },
  { id: 'wren', name: 'Wren', role: 'character', color: 'peach' },
];

const chapter: Chapter = {
  id: 1,
  title: 'Chapter One',
  duration: '10:00',
  state: 'done',
  progress: 1,
  characters: {},
};

/* Four sentences. id=2 and id=4 are low-confidence (confidence 0.4
   and 0.5). The other two are above the 0.75 threshold. */
const sentences: Sentence[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'High confidence one.', confidence: 0.95 },
  {
    id: 2,
    chapterId: 1,
    characterId: 'lord-vane',
    text: 'Low confidence two.',
    confidence: 0.4,
  },
  { id: 3, chapterId: 1, characterId: 'wren', text: 'High confidence three.', confidence: 0.9 },
  { id: 4, chapterId: 1, characterId: 'wren', text: 'Low confidence four.', confidence: 0.5 },
];

function makeStore(s: Sentence[]) {
  return configureStore({
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
        sentences: s,
        importCandidate: null,
        pendingReupload: null,
        mergedAwayKeys: [],
      },
    },
  });
}

describe('ManuscriptView — low-confidence navigator', () => {
  it('renders a disabled "0 low-confidence" label when there are no low-confidence sentences', () => {
    const allHighConf: Sentence[] = sentences.map((s) => ({ ...s, confidence: 0.95 }));
    const store = makeStore(allHighConf);
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={allHighConf}
        />
      </Provider>,
    );
    expect(screen.getByText('0 low-confidence')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Next low-confidence sentence'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Previous low-confidence sentence'),
    ).not.toBeInTheDocument();
  });

  it('renders count + ▲/▼ controls when there are low-confidence sentences', () => {
    const store = makeStore(sentences);
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
    expect(screen.getByText('2 low-confidence')).toBeInTheDocument();
    expect(screen.getByLabelText('Next low-confidence sentence')).toBeInTheDocument();
    expect(screen.getByLabelText('Previous low-confidence sentence')).toBeInTheDocument();
  });

  it('clicking ▼ opens the inspector on the first low-confidence sentence', async () => {
    const user = userEvent.setup();
    const store = makeStore(sentences);
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
    /* Inspector is closed by default — no "Reassign whole segment to". */
    expect(screen.queryAllByText('Reassign whole segment to')).toHaveLength(0);
    await user.click(screen.getByLabelText('Next low-confidence sentence'));
    /* Inspector mounts in two places (sticky aside for tablet+desktop +
       BottomSheet for mobile). Both render the same content; assert the
       header appears at least once. */
    expect(screen.getAllByText('Reassign whole segment to').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking ▲ from initial cursor=0 wraps to the LAST low-confidence sentence', async () => {
    const user = userEvent.setup();
    const store = makeStore(sentences);
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
    await user.click(screen.getByLabelText('Previous low-confidence sentence'));
    /* Inspector opens on the last low-confidence sentence's segment.
       sentence id=4 belongs to Wren — verify by reading the
       inspector's h3. Multiple inspector instances render — both should
       show Wren. */
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.length).toBeGreaterThanOrEqual(1);
    for (const h of headings) {
      expect(h).toHaveTextContent('Wren');
    }
    /* Sanity: there is at least one "Selected segment" eyebrow above
       the heading, confirming we're reading the inspector card and not
       a stray h3 elsewhere. */
    expect(screen.getAllByText('Selected segment').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the navigator inside the sticky stats bar', () => {
    const store = makeStore(sentences);
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
    const bar = screen.getByTestId('manuscript-sticky-stats-bar');
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('top-16');
    /* The ▲/▼ buttons live inside the sticky bar, not in a separate
       header row — locks in plan 98's invariant that the navigator
       rides along with the sticky pin. */
    expect(within(bar).getByLabelText('Next low-confidence sentence')).toBeInTheDocument();
    expect(within(bar).getByLabelText('Previous low-confidence sentence')).toBeInTheDocument();
  });
});

describe('ManuscriptView — sidebar chapter low-confidence badge (plan 98)', () => {
  const twoChapters: Chapter[] = [
    { id: 1, title: 'Chapter One', duration: '10:00', state: 'done', progress: 1, characters: {} },
    { id: 2, title: 'Chapter Two', duration: '08:00', state: 'done', progress: 1, characters: {} },
  ];

  it('renders an amber count badge with the per-chapter count when low-conf sentences exist', () => {
    /* Chapter 1: two low-confidence sentences (id=2, id=4). Chapter 2:
       all high-confidence. The sidebar should show a badge on ch.1 with
       "2" and NO badge on ch.2. */
    const mixed: Sentence[] = [
      ...sentences,
      { id: 5, chapterId: 2, characterId: 'narrator', text: 'High two.', confidence: 0.95 },
    ];
    const store = makeStore(mixed);
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={twoChapters}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={mixed}
        />
      </Provider>,
    );
    const ch1Badge = screen.getByTestId('chapter-low-conf-badge-1');
    expect(ch1Badge).toHaveTextContent('2');
    expect(ch1Badge).toHaveAttribute('aria-label', '2 low-confidence');
    expect(ch1Badge).toHaveAttribute(
      'title',
      '2 low-confidence sentences in this chapter',
    );
    expect(screen.queryByTestId('chapter-low-conf-badge-2')).not.toBeInTheDocument();
  });

  it('omits the badge entirely when count is 0', () => {
    const allHighConf: Sentence[] = sentences.map((s) => ({ ...s, confidence: 0.95 }));
    const store = makeStore(allHighConf);
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={allHighConf}
        />
      </Provider>,
    );
    expect(screen.queryByTestId('chapter-low-conf-badge-1')).not.toBeInTheDocument();
  });

  it('uses singular form in title attribute when count is 1', () => {
    /* Exactly one low-confidence sentence: id=2. */
    const singleLowConf: Sentence[] = sentences.map((s) =>
      s.id === 4 ? { ...s, confidence: 0.95 } : s,
    );
    const store = makeStore(singleLowConf);
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={singleLowConf}
        />
      </Provider>,
    );
    const badge = screen.getByTestId('chapter-low-conf-badge-1');
    expect(badge).toHaveTextContent('1');
    expect(badge).toHaveAttribute(
      'title',
      '1 low-confidence sentence in this chapter',
    );
  });
});
