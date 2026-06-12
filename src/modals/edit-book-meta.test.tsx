/* EditBookMetaModal — chip tag editor + suggestions dropdown
   coverage for plan 73. The modal also handles title/author/series
   edits inherited from the pre-plan-73 shape; the rendering smoke
   here covers that the form mounts with seed values, but the
   detailed coverage focuses on the new tag affordance. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { librarySlice } from '../store/library-slice';
import { EditBookMetaModal, type EditBookMetaPatch } from './edit-book-meta';
import type { LibraryBook } from '../lib/types';

const baseBook: LibraryBook = {
  bookId: 'b1',
  title: 'The Northern Star',
  author: 'Marin Vale',
  series: 'Northern Coast Trilogy',
  seriesPosition: 2,
  isStandalone: false,
  status: 'generating',
  chapterCount: 7,
  completedChapters: 2,
  characterCount: 4,
  voiceCount: 4,
  lastWorkedOn: '2 min ago',
  coverGradient: ['#3C194F', '#0F0E0D'],
  tags: ['favourite', 'series-1'],
};

function renderModal(
  bookOverrides: Partial<LibraryBook> = {},
  onSave: (patch: EditBookMetaPatch) => void = vi.fn(),
  libraryBooks: LibraryBook[] = [
    /* Other books contribute their tags to the suggestions dropdown. */
    { ...baseBook, bookId: 'b2', tags: ['draft', 'series-2'] },
  ],
) {
  const store = configureStore({
    reducer: { library: librarySlice.reducer },
    preloadedState: {
      library: {
        loaded: true,
        authors: [],
        books: libraryBooks,
        pausedSnapshots: {},
      },
    },
  });
  const book: LibraryBook = { ...baseBook, ...bookOverrides };
  return {
    store,
    onSave,
    ...render(
      <Provider store={store}>
        <EditBookMetaModal
          open
          book={book}
          onClose={vi.fn()}
          onSave={onSave}
        />
      </Provider>,
    ),
  };
}

describe('EditBookMetaModal — mount smoke', () => {
  it('seeds the form fields from the open book', () => {
    renderModal();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('The Northern Star');
    expect((screen.getByLabelText('Author') as HTMLInputElement).value).toBe('Marin Vale');
    expect((screen.getByLabelText('Series') as HTMLInputElement).value).toBe('Northern Coast Trilogy');
  });
});

describe('EditBookMetaModal — tag editor (plan 73)', () => {
  it('renders one chip per existing tag', () => {
    renderModal();
    expect(screen.getByTestId('tag-chip-favourite')).toBeInTheDocument();
    expect(screen.getByTestId('tag-chip-series-1')).toBeInTheDocument();
  });

  it('adds a tag on Enter and clears the input', () => {
    const onSave = vi.fn();
    renderModal({}, onSave);
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'priority' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('tag-chip-priority')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('adds a tag on comma keypress', () => {
    renderModal();
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wip' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(screen.getByTestId('tag-chip-wip')).toBeInTheDocument();
  });

  it('handles comma-separated paste (splits, trims, drops empties)', () => {
    renderModal({ tags: [] });
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'priority, draft,  ,wip' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('tag-chip-priority')).toBeInTheDocument();
    expect(screen.getByTestId('tag-chip-draft')).toBeInTheDocument();
    expect(screen.getByTestId('tag-chip-wip')).toBeInTheDocument();
    /* No chip for the all-whitespace token. */
    expect(screen.queryByTestId('tag-chip-')).not.toBeInTheDocument();
  });

  it('prevents duplicate adds', () => {
    renderModal();
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'favourite' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    /* Still exactly one favourite chip — getAllByTestId would throw if
       the dedup were broken. */
    expect(screen.getAllByTestId('tag-chip-favourite')).toHaveLength(1);
  });

  it('removes a tag when its X button is clicked', () => {
    renderModal();
    const remove = screen.getByLabelText('Remove tag favourite');
    fireEvent.click(remove);
    expect(screen.queryByTestId('tag-chip-favourite')).not.toBeInTheDocument();
    /* The other chip survives. */
    expect(screen.getByTestId('tag-chip-series-1')).toBeInTheDocument();
  });

  it('pops the last chip on Backspace when the input is empty', () => {
    renderModal();
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Backspace' });
    /* The last seed tag (series-1) popped; favourite remains. */
    expect(screen.queryByTestId('tag-chip-series-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('tag-chip-favourite')).toBeInTheDocument();
  });

  it('shows an empty-state placeholder when no tags are set', () => {
    renderModal({ tags: [] });
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    expect(input.placeholder).toMatch(/Add tags/i);
  });

  it('passes the tag list through to onSave', () => {
    const onSave = vi.fn();
    renderModal({}, onSave);
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'priority' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['favourite', 'series-1', 'priority'] }),
    );
  });

  it('commits a typed-but-unsubmitted tag on Save', () => {
    const onSave = vi.fn();
    renderModal({}, onSave);
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wip' } });
    /* No Enter / comma — user clicks Save directly. */
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['favourite', 'series-1', 'wip'] }),
    );
  });
});

describe('EditBookMetaModal — tag suggestions (plan 73)', () => {
  it('surfaces tags from other books in the library when the input is focused', () => {
    renderModal();
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.focus(input);
    const dropdown = screen.getByTestId('tag-suggestions');
    expect(within(dropdown).getByTestId('tag-suggestion-draft')).toBeInTheDocument();
    expect(within(dropdown).getByTestId('tag-suggestion-series-2')).toBeInTheDocument();
    // Scroll regions share the themed thin inset scrollbar, never the OS default.
    expect(dropdown.className).toMatch(/scrollbar-thin/);
  });

  it('filters suggestions by the current query', () => {
    renderModal();
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'dra' } });
    const dropdown = screen.getByTestId('tag-suggestions');
    expect(within(dropdown).getByTestId('tag-suggestion-draft')).toBeInTheDocument();
    expect(within(dropdown).queryByTestId('tag-suggestion-series-2')).not.toBeInTheDocument();
  });

  it('hides suggestions for tags already on the book', () => {
    renderModal();
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.focus(input);
    const dropdown = screen.getByTestId('tag-suggestions');
    /* favourite is already on baseBook.tags — should NOT appear in
       the suggestions list. */
    expect(within(dropdown).queryByTestId('tag-suggestion-favourite')).not.toBeInTheDocument();
  });

  it('clicking a suggestion adds it to the chip set', () => {
    renderModal();
    const input = screen.getByLabelText('Add tag') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByTestId('tag-suggestion-draft'));
    expect(screen.getByTestId('tag-chip-draft')).toBeInTheDocument();
  });
});
