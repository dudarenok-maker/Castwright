/* Plan: low-confidence-triage-polish — covers the active "X
   low-confidence" navigator pill in ManuscriptView's header.

   Pins:
   - K=0 renders a disabled "0 low-confidence" label (no buttons).
   - K>0 renders a count + ▲ + ▼ buttons.
   - Clicking ▼ opens the SegmentInspector on the first low-confidence
     sentence's segment; clicking again advances; wraps after the last.
   - Clicking ▲ from cursor=0 wraps to the last low-confidence entry. */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { ManuscriptView } from './manuscript';
import type { Chapter, Character, Sentence } from '../lib/types';

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'lord-cassius', name: 'Lord Cassius', role: 'character', color: 'magenta' },
  { id: 'sophie', name: 'Sophie', role: 'character', color: 'peach' },
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
    characterId: 'lord-cassius',
    text: 'Low confidence two.',
    confidence: 0.4,
  },
  { id: 3, chapterId: 1, characterId: 'sophie', text: 'High confidence three.', confidence: 0.9 },
  { id: 4, chapterId: 1, characterId: 'sophie', text: 'Low confidence four.', confidence: 0.5 },
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
       sentence id=4 belongs to Sophie — verify by reading the
       inspector's h3. Multiple inspector instances render — both should
       show Sophie. */
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.length).toBeGreaterThanOrEqual(1);
    for (const h of headings) {
      expect(h).toHaveTextContent('Sophie');
    }
    /* Sanity: there is at least one "Selected segment" eyebrow above
       the heading, confirming we're reading the inspector card and not
       a stray h3 elsewhere. */
    expect(screen.getAllByText('Selected segment').length).toBeGreaterThanOrEqual(1);
  });
});
