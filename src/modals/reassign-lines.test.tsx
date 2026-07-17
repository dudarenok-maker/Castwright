import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ReassignLinesModal } from './reassign-lines';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { changeLogSlice } from '../store/change-log-slice';

function makeStore() {
  return configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      cast: castSlice.reducer,
      chapters: chaptersSlice.reducer,
      changeLog: changeLogSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        manuscriptId: 'm1',
        bookId: 'b1',
        sentences: [
          { chapterId: 1, id: 1, text: 'Alpha line.', characterId: 'egor' },
          { chapterId: 1, id: 2, text: 'Beta line.', characterId: 'egor' },
          { chapterId: 2, id: 1, text: 'Gamma line.', characterId: 'egor' },
        ] as never,
      },
      cast: {
        ...castSlice.getInitialState(),
        characters: [
          { id: 'egor', name: 'Егор' },
          { id: 'anton', name: 'Антон' },
          { id: 'narrator', name: 'Narrator' },
        ] as never,
      },
      chapters: {
        ...chaptersSlice.getInitialState(),
        chapters: [
          { id: 1, title: 'One' },
          { id: 2, title: 'Two' },
        ] as never,
      },
    },
  });
}

function renderModal(source: Parameters<typeof ReassignLinesModal>[0]['source']) {
  const store = makeStore();
  const onClose = vi.fn();
  const spy = vi.spyOn(store, 'dispatch');
  render(
    <Provider store={store}>
      <ReassignLinesModal source={source} onClose={onClose} />
    </Provider>,
  );
  return { store, onClose, spy };
}

describe('ReassignLinesModal — character source', () => {
  it('lists every line on the character, grouped by chapter', () => {
    renderModal({ kind: 'character', characterId: 'egor' });
    expect(screen.getByText('Alpha line.')).toBeInTheDocument();
    expect(screen.getByText('Gamma line.')).toBeInTheDocument();
  });

  it('select-all then apply dispatches one bulk move + bumpBoundaryMove per chapter', async () => {
    const { spy } = renderModal({ kind: 'character', characterId: 'egor' });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    // pick a target
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'anton' } });
    fireEvent.click(screen.getByRole('button', { name: /^reassign/i }));
    // confirm step
    fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));
    const bulk = spy.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'manuscript/setSentencesCharacterBulk',
    );
    expect(bulk).toBeTruthy();
    expect((bulk![0] as unknown as { payload: { keys: unknown[] } }).payload.keys).toHaveLength(3);
    const bumps = spy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'changeLog/bumpBoundaryMove',
    );
    expect(bumps).toHaveLength(2); // chapters 1 and 2
  });

  it('disables the source character in the target picker', () => {
    renderModal({ kind: 'character', characterId: 'egor' });
    const opt = within(screen.getByLabelText(/reassign to/i)).getByRole('option', { name: /Егор/ });
    expect(opt).toBeDisabled();
  });

  it('text filter + select-all-matching selects only the filtered subset', () => {
    renderModal({ kind: 'character', characterId: 'egor' });
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: /select all matching/i }));
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
  });

  it('per-chapter select-all adds only that chapter’s lines', () => {
    renderModal({ kind: 'character', characterId: 'egor' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.change(screen.getByLabelText(/select all in chapter/i), { target: { value: '2' } });
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument(); // chapter 2 has one Егор line
  });

  it('shows the empty state for a character with zero lines', () => {
    renderModal({ kind: 'character', characterId: 'nobody' });
    expect(screen.getByText(/0 lines|nothing to reassign/i)).toBeInTheDocument();
  });
});

describe('ReassignLinesModal — Narrator confirm', () => {
  it('requires an extra confirm when the target is Narrator', async () => {
    const { spy } = renderModal({ kind: 'character', characterId: 'egor' });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'narrator' } });
    fireEvent.click(screen.getByRole('button', { name: /^reassign/i }));
    // Narrator-specific confirm copy appears
    expect(await screen.findByText(/narrator/i)).toBeInTheDocument();
    expect(
      spy.mock.calls.some((c) => (c[0] as { type?: string })?.type === 'manuscript/setSentencesCharacterBulk'),
    ).toBe(false); // not yet applied
  });
});

describe('ReassignLinesModal — unlink source', () => {
  it('resolves candidate rows from impactedChapters and defaults the target to the alias character', () => {
    renderModal({
      kind: 'unlink',
      impactedChapters: [
        { chapterId: 1, candidateSentenceIds: [1, 2] },
        { chapterId: 2, candidateSentenceIds: [1] },
      ],
      aliasCharacterId: 'anton',
    });
    // Candidate rows resolve from the impacted-chapter sentence ids.
    expect(screen.getByText('Alpha line.')).toBeInTheDocument();
    expect(screen.getByText('Beta line.')).toBeInTheDocument();
    expect(screen.getByText('Gamma line.')).toBeInTheDocument();
    // Default target is the freshly-split alias character.
    expect(screen.getByLabelText(/reassign to/i)).toHaveValue('anton');
  });
});

describe('ReassignLinesModal — key drift at apply (m9)', () => {
  it('skips keys that no longer resolve and reports the count', async () => {
    const store = makeStore();
    const onClose = vi.fn();
    render(
      <Provider store={store}>
        <ReassignLinesModal source={{ kind: 'selection', keys: [
          { chapterId: 1, sentenceId: 1 },
          { chapterId: 1, sentenceId: 2 },
        ] }} onClose={onClose} />
      </Provider>,
    );
    // Simulate drift AFTER open: (1,2) is merged away (id 1 survives, id 2 dropped).
    // The initial selection was seeded from rows at mount and still holds BOTH
    // keys — deliberately do NOT re-run select-all, which would re-derive from the
    // now-shrunken live rows and drop the stale key, defeating the skip path.
    store.dispatch(manuscriptActions.mergeSentences({ chapterId: 1, sentenceIds: [1, 2] }));
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'anton' } });
    fireEvent.click(screen.getByRole('button', { name: /^reassign/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));
    expect(await screen.findByText(/no longer existed|were skipped/i)).toBeInTheDocument();
  });
});
