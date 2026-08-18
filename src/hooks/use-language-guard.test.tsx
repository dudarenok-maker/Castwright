/* useLanguageGuard — verifies the global language-guard host (#2246 Task 9c):
     - guard(bookId, shape, onRetry) opens EditBookMetaModal in guard mode
       with the language field empty; picking a language + Save persists the
       patch then re-runs onRetry;
     - the modal does NOT open for a book the library doesn't know;
     - on mount the hook registers itself as the language-guard-bus handler, so
       the four 409 sites in api.ts can route a language-unset failure here.

   Pairs with src/hooks/use-reverse-local-analyzer-guard.test.tsx (same shape). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { librarySlice } from '../store/library-slice';
import { useLanguageGuard } from './use-language-guard';
import { emitLanguageGuard } from '../lib/language-guard-bus';
import { api } from '../lib/api';
import type { LibraryBook } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    putBookState: vi.fn(),
    getLibrary: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

function unsetBook(): LibraryBook {
  return {
    bookId: 'b_marlow',
    title: 'The Coalfall Commission',
    author: 'Della Renwick',
    series: 'The Hollow Tide',
    seriesPosition: 1,
    isStandalone: false,
    status: 'cast_pending',
    chapterCount: 0,
    completedChapters: 0,
    characterCount: 0,
    voiceCount: 0,
    lastWorkedOn: '2026-08-10T00:00:00Z',
    coverGradient: ['#fff', '#000'],
    tags: [],
    languageSet: false,
  };
}

function makeStore(book: LibraryBook | null) {
  const store = configureStore({
    reducer: { library: librarySlice.reducer },
  });
  if (book) store.dispatch(librarySlice.actions.addBook(book));
  return store;
}

function Harness({ onProceed }: { onProceed: () => void }) {
  const { guard, modal } = useLanguageGuard();
  return (
    <>
      <button onClick={() => guard('b_marlow', '409', onProceed)}>Trigger</button>
      {modal}
    </>
  );
}

beforeEach(() => {
  vi.mocked(api.putBookState).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.getLibrary)
    .mockReset()
    .mockResolvedValue({ authors: [] });
});

describe('useLanguageGuard', () => {
  it('opens the guard modal empty; picking a language + Save persists it then retries (acceptance 1)', async () => {
    const store = makeStore(unsetBook());
    const retry = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={retry} />
      </Provider>,
    );

    // Trigger the guard: modal opens in guard mode with the hint banner.
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();
    expect(screen.getByText('Set a language to continue')).toBeInTheDocument();

    // Guard mode always seeds the language empty.
    const select = screen.getByTestId('edit-book-language') as HTMLSelectElement;
    expect(select.value).toBe('');

    // Choose a language — Save becomes enabled.
    fireEvent.change(select, { target: { value: 'ru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(mockedApi.putBookState).toHaveBeenCalledWith('b_marlow', {
      slice: 'state',
      patch: expect.objectContaining({ language: 'ru' }),
    });
    expect(mockedApi.getLibrary).toHaveBeenCalled();
  });

  it('does not open a modal when the library has no matching book', () => {
    const store = makeStore(null);
    const retry = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={retry} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.queryByTestId('edit-book-language-guard')).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  it('registers itself as the bus handler so the api layer can route a 409 here', () => {
    const store = makeStore(unsetBook());
    const retry = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={retry} />
      </Provider>,
    );

    // Simulate the api layer routing a language-unset 409 through the bus.
    let accepted = false;
    act(() => {
      accepted = emitLanguageGuard({ bookId: 'b_marlow', shape: '409', onRetry: retry });
    });
    expect(accepted).toBe(true);
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();
  });
});
