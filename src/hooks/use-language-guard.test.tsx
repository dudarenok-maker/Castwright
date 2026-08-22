/* useLanguageGuard — verifies the global language-guard host (#2246 Task 9c):
     - guard(bookId, shape, onRetry) opens EditBookMetaModal in guard mode
       with the language field empty; picking a language + Save persists the
       patch then re-runs onRetry;
     - the modal does NOT open for a book the library doesn't know;
     - on mount the hook registers itself as the language-guard-bus handler, so
       the four 409 sites in api.ts can route a language-unset failure here.

   Pairs with src/hooks/use-reverse-local-analyzer-guard.test.tsx (same shape). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { librarySlice } from '../store/library-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { useLanguageGuard } from './use-language-guard';
import { emitLanguageGuard, type LanguageGuardSelector } from '../lib/language-guard-bus';
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
    manuscriptId: 'm_marlow',
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
    reducer: {
      library: librarySlice.reducer,
      notifications: notificationsSlice.reducer,
    },
  });
  if (book) store.dispatch(librarySlice.actions.addBook(book));
  return store;
}

function Harness({
  onProceed,
  onDismiss,
  selector = { bookId: 'b_marlow' },
}: {
  onProceed: () => void;
  onDismiss?: () => void;
  selector?: LanguageGuardSelector;
}) {
  const { guard, modal } = useLanguageGuard();
  return (
    <>
      <button onClick={() => void guard(selector, '409', onProceed, onDismiss)}>Trigger</button>
      {modal}
    </>
  );
}

function ReturnHarness() {
  const { guard, modal } = useLanguageGuard();
  const [ok, setOk] = useState<boolean | null>(null);
  return (
    <>
      <button onClick={() => setOk(guard({ bookId: 'b_missing' }, '409', () => {}))}>Go</button>
      <div data-testid="ok">{ok === null ? 'none' : String(ok)}</div>
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

  it('opens the guard for a book resolved by manuscriptId (analysis pathway, acceptance 5)', () => {
    const store = makeStore(unsetBook());
    render(
      <Provider store={store}>
        <Harness onProceed={() => {}} selector={{ manuscriptId: 'm_marlow' }} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();
  });

  it('reports false and opens nothing when the selector matches no library book (acceptance 8)', () => {
    const store = makeStore(unsetBook());
    render(
      <Provider store={store}>
        <ReturnHarness />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByTestId('ok').textContent).toBe('false');
    expect(screen.queryByTestId('edit-book-language-guard')).not.toBeInTheDocument();
  });

  it('refuses through the bus too when the selector matches no library book (acceptance 8)', () => {
    const store = makeStore(unsetBook());
    render(
      <Provider store={store}>
        <Harness onProceed={() => {}} />
      </Provider>,
    );

    let accepted = true;
    act(() => {
      accepted = emitLanguageGuard({
        selector: { manuscriptId: 'm_unknown' },
        shape: '409',
        onRetry: () => {},
      });
    });
    expect(accepted).toBe(false);
    expect(screen.queryByTestId('edit-book-language-guard')).not.toBeInTheDocument();
  });

  it('calls onDismiss when the guard modal is dismissed without saving (acceptance 7)', () => {
    const store = makeStore(unsetBook());
    const onDismiss = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={() => {}} onDismiss={onDismiss} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('edit-book-language-guard')).not.toBeInTheDocument();
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
      accepted = emitLanguageGuard({ selector: { bookId: 'b_marlow' }, shape: '409', onRetry: retry });
    });
    expect(accepted).toBe(true);
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();
  });

  it('surfaces a failed guard-mode save as an error toast, not a dismiss (F1 regression)', async () => {
    const store = makeStore(unsetBook());
    const retry = vi.fn();
    const onDismiss = vi.fn();
    const saveError = new Error('Network error: 500');
    vi.mocked(api.putBookState).mockRejectedValue(saveError);

    render(
      <Provider store={store}>
        <Harness onProceed={retry} onDismiss={onDismiss} />
      </Provider>,
    );

    // Trigger the guard: modal opens in guard mode.
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();

    // Choose a language and click Save.
    const select = screen.getByTestId('edit-book-language') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // Wait for the save attempt to complete.
    await waitFor(() => expect(mockedApi.putBookState).toHaveBeenCalledTimes(1));

    // The modal should still be open (not closed by onClose).
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();

    // onDismiss should NOT have been called (this is the bug we're fixing).
    expect(onDismiss).not.toHaveBeenCalled();

    // An error toast should have been shown.
    const toasts = (store.getState() as any).notifications?.toasts ?? [];
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("Couldn't save the book's language"),
    });

    // The user should be able to retry by clicking Save again.
    vi.mocked(api.putBookState).mockResolvedValue(undefined);
    vi.mocked(api.getLibrary).mockResolvedValue({ authors: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(mockedApi.putBookState).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('edit-book-language-guard')).not.toBeInTheDocument();
  });

  it('accumulates and fires all retries when a multi-chapter batch guards multiple times (F8 regression)', async () => {
    const store = makeStore(unsetBook());
    const retry1 = vi.fn();
    const retry2 = vi.fn();
    const retry3 = vi.fn();

    function MultiGuardHarness() {
      const { guard, modal } = useLanguageGuard();
      return (
        <>
          <button onClick={() => void guard({ bookId: 'b_marlow' }, '409', retry1)}>Retry1</button>
          <button onClick={() => void guard({ bookId: 'b_marlow' }, '409', retry2)}>Retry2</button>
          <button onClick={() => void guard({ bookId: 'b_marlow' }, '409', retry3)}>Retry3</button>
          {modal}
        </>
      );
    }

    render(
      <Provider store={store}>
        <MultiGuardHarness />
      </Provider>,
    );

    // Simulate a multi-chapter batch: 3 chapters fail with 409, each triggering guard().
    fireEvent.click(screen.getByRole('button', { name: 'Retry1' }));
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();

    // Second chapter fails while guard is already open.
    fireEvent.click(screen.getByRole('button', { name: 'Retry2' }));
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();

    // Third chapter fails while guard is still open.
    fireEvent.click(screen.getByRole('button', { name: 'Retry3' }));
    expect(screen.getByTestId('edit-book-language-guard')).toBeInTheDocument();

    // Set the language and save.
    const select = screen.getByTestId('edit-book-language') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // All three retries should fire.
    await waitFor(() => {
      expect(retry1).toHaveBeenCalledTimes(1);
      expect(retry2).toHaveBeenCalledTimes(1);
      expect(retry3).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('edit-book-language-guard')).not.toBeInTheDocument();
  });
});
