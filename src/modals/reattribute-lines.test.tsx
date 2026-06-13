// Pairs with docs/features/archive/95-alias-edit.md

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { chaptersSlice, chaptersActions } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { ReattributeLinesModal } from './reattribute-lines';
import type { Chapter, Sentence } from '../lib/types';

function makeStore({
  chapters,
  sentences,
}: {
  chapters: Chapter[];
  sentences: Sentence[];
}) {
  /* manuscript-slice has no top-level "setSentences" action — the live
     dispatch path is hydrateFromAnalysis / hydrateFromBookState. For
     this unit test we seed via preloadedState so we can shape the
     sentences array exactly without going through the upload contract. */
  const store = configureStore({
    reducer: {
      chapters: chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        bookId: 'b',
        manuscriptId: 'm',
        title: 'Test Book',
        format: null,
        wordCount: 0,
        sourceText: null,
        sentences,
        importCandidate: null,
        pendingReupload: null,
      },
    },
  });
  store.dispatch(chaptersActions.setChapters(chapters));
  return store;
}

const seededChapters: Chapter[] = [
  { id: 1, title: 'The Berth', state: 'queued', characters: {}, duration: '00:00', progress: 0 },
  { id: 4, title: 'A Manifest', state: 'queued', characters: {}, duration: '00:00', progress: 0 },
];

const seededSentences: Sentence[] = [
  { id: 1, chapterId: 1, characterId: 'saltgrave-figure', text: 'The shopkeeper laughed.' },
  { id: 2, chapterId: 1, characterId: 'saltgrave-figure', text: '"Garrow said that?"' },
  { id: 5, chapterId: 4, characterId: 'saltgrave-figure', text: 'Chapter four candidate line.' },
  /* Out-of-scope sentence (different character) — must not appear in the modal. */
  { id: 6, chapterId: 1, characterId: 'wren', text: 'Wren line that is not a candidate.' },
];

function renderModal(opts: {
  impactedChapters?: { chapterId: number; candidateSentenceIds: number[] }[];
  onClose?: () => void;
}) {
  const store = makeStore({ chapters: seededChapters, sentences: seededSentences });
  const onClose = opts.onClose ?? vi.fn();
  const impactedChapters = opts.impactedChapters ?? [
    { chapterId: 1, candidateSentenceIds: [1, 2] },
    { chapterId: 4, candidateSentenceIds: [5] },
  ];
  return {
    store,
    ...render(
      <Provider store={store}>
        <ReattributeLinesModal
          sourceCharacterId="saltgrave-figure"
          sourceCharacterName="Saltgrave Figure"
          newCharacterId="garrow"
          aliasName="Garrow"
          impactedChapters={impactedChapters}
          onClose={onClose}
        />
      </Provider>,
    ),
  };
}

describe('ReattributeLinesModal', () => {
  it('renders one card per impacted chapter with the candidate sentence text', () => {
    renderModal({});
    /* Both chapter cards visible with their titles. */
    expect(screen.getByText('The Berth')).toBeTruthy();
    expect(screen.getByText('A Manifest')).toBeTruthy();
    /* Candidate sentences from the impactedChapters payload only. */
    expect(screen.getByText('The shopkeeper laughed.')).toBeTruthy();
    expect(screen.getByText('"Garrow said that?"')).toBeTruthy();
    expect(screen.getByText('Chapter four candidate line.')).toBeTruthy();
    /* Out-of-scope sentence (Wren's) must not render. */
    expect(screen.queryByText('Wren line that is not a candidate.')).toBeNull();
  });

  it('clicking the alias chip on a row reassigns that sentence to the new character', () => {
    const { store } = renderModal({});
    /* Click the "Garrow" chip on the first row. There are multiple
       "Garrow" buttons (one per row), so disambiguate by finding the
       row's parent first. */
    const row = screen.getByText('The shopkeeper laughed.').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign to Garrow' }));
    const reassigned = store
      .getState()
      .manuscript.sentences.find((s) => s.chapterId === 1 && s.id === 1)!;
    expect(reassigned.characterId).toBe('garrow');
  });

  it('logs a boundary_move so the chapter is flagged stale (Bug 2 staleness precondition)', () => {
    const { store } = renderModal({});
    const row = screen.getByText('The shopkeeper laughed.').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign to Garrow' }));
    const events = store.getState().changeLog.events;
    expect(events.some((e) => e.type === 'boundary_move' && e.chapterId === 1)).toBe(true);
  });

  it('clicking the source chip on a reassigned row reverts the attribution', () => {
    const { store } = renderModal({});
    const row = screen.getByText('The shopkeeper laughed.').closest('li')!;
    /* Reassign … */
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign to Garrow' }));
    /* … then revert. */
    fireEvent.click(within(row).getByRole('button', { name: 'Keep on Saltgrave Figure' }));
    const reverted = store
      .getState()
      .manuscript.sentences.find((s) => s.chapterId === 1 && s.id === 1)!;
    expect(reverted.characterId).toBe('saltgrave-figure');
  });

  it('reflects aria-pressed state so screen readers know which chip is active', () => {
    const { store } = renderModal({});
    const row = screen.getByText('The shopkeeper laughed.').closest('li')!;
    /* Initially the source chip is "pressed" because the sentence is
       still attributed to the source character. */
    expect(within(row).getByRole('button', { name: 'Keep on Saltgrave Figure' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(row).getByRole('button', { name: 'Reassign to Garrow' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Reassign to Garrow' }));
    /* Need to re-query — same elements, but attributes flip. */
    expect(within(row).getByRole('button', { name: 'Keep on Saltgrave Figure' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(row).getByRole('button', { name: 'Reassign to Garrow' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    /* Store reflects the change too. */
    expect(
      store.getState().manuscript.sentences.find((s) => s.chapterId === 1 && s.id === 1)!
        .characterId,
    ).toBe('garrow');
  });

  it('Done button fires onClose', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the empty-state copy when impactedChapters is empty', () => {
    renderModal({ impactedChapters: [] });
    expect(screen.getByText(/Nothing to reattribute here\./)).toBeTruthy();
    /* Done button is still present so the user can dismiss. */
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('renders the empty-state copy when impactedChapters has entries but no candidate sentences', () => {
    /* Server returned chapter rows but the manuscript slice has no
       sentences attributed to the source (e.g. they were already
       reassigned in a prior modal pass). */
    renderModal({ impactedChapters: [{ chapterId: 99, candidateSentenceIds: [42] }] });
    expect(screen.getByText(/Nothing to reattribute here\./)).toBeTruthy();
  });
});
