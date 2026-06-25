/* EditChapterTitleModal — plan 78.

   Coverage:
   - Modal seeds the input with the current chapter title.
   - Save calls api.renameChapter with the trimmed title, dispatches
     chaptersActions.renameChapter, and closes.
   - Empty / whitespace-only input keeps Save disabled.
   - Cancel does not call the api or dispatch.
   - API failure surfaces a toast via notificationsActions.pushToast
     and keeps the modal open. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { chaptersSlice } from '../store/chapters-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { EditChapterTitleModal } from './edit-chapter-title';
import { api } from '../lib/api';
import type { Chapter } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    renameChapter: vi.fn(),
  },
}));

const renameSpy = vi.mocked(api.renameChapter);

const makeChapter = (overrides: Partial<Chapter> = {}): Chapter => ({
  id: 3,
  title: 'Chapter 3 — Awkward Heuristic',
  duration: '12:34',
  state: 'queued',
  progress: 0,
  characters: {},
  ...overrides,
});

function renderModal(
  chapter: Chapter | null = makeChapter(),
  onClose = vi.fn(),
) {
  const store = configureStore({
    reducer: {
      chapters: chaptersSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      chapters: {
        chapters: chapter ? [chapter] : [],
        paused: false,
        lastError: null,
        generationStartedAt: null,
        pendingRegen: null,
        regenEpoch: 0,
        lastTickAt: null,
        currentBookId: null,
        activeStreams: {},
        renderedSpeakersByChapter: {},
        renderedTextByChapter: {},
      },
    },
  });
  return {
    store,
    onClose,
    ...render(
      <Provider store={store}>
        <EditChapterTitleModal
          open
          bookId="b1"
          chapter={chapter}
          onClose={onClose}
        />
      </Provider>,
    ),
  };
}

beforeEach(() => {
  renameSpy.mockReset();
});

describe('EditChapterTitleModal — mount + seed', () => {
  it('renders the current chapter title in the input', () => {
    renderModal();
    const input = screen.getByTestId('edit-chapter-title-input') as HTMLInputElement;
    expect(input.value).toBe('Chapter 3 — Awkward Heuristic');
  });

  it('null-renders when open is false', () => {
    const store = configureStore({ reducer: { notifications: notificationsSlice.reducer } });
    const { container } = render(
      <Provider store={store}>
        <EditChapterTitleModal
          open={false}
          bookId="b1"
          chapter={makeChapter()}
          onClose={vi.fn()}
        />
      </Provider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('null-renders when chapter is null', () => {
    const { container } = renderModal(null);
    expect(container.firstChild).toBeNull();
  });
});

describe('EditChapterTitleModal — save', () => {
  it('disables Save when the input is empty', () => {
    renderModal();
    const input = screen.getByTestId('edit-chapter-title-input');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('disables Save when the input is unchanged', () => {
    renderModal();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('calls api.renameChapter with the trimmed title and dispatches the slice action', async () => {
    renameSpy.mockResolvedValue({ id: 3, title: 'The Real Title', slug: '03-the-real-title', titleOverridden: true });
    const onClose = vi.fn();
    const { store } = renderModal(makeChapter(), onClose);

    const input = screen.getByTestId('edit-chapter-title-input');
    fireEvent.change(input, { target: { value: '   The Real Title   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith('b1', 3, 'The Real Title');
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(store.getState().chapters.chapters[0]).toMatchObject({
      title: 'The Real Title',
      titleOverridden: true,
    });
  });

  it('submits on Enter when Save is enabled', async () => {
    renameSpy.mockResolvedValue({ id: 3, title: 'Quick Save', slug: '03-quick-save', titleOverridden: true });
    const onClose = vi.fn();
    renderModal(makeChapter(), onClose);
    const input = screen.getByTestId('edit-chapter-title-input');
    fireEvent.change(input, { target: { value: 'Quick Save' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith('b1', 3, 'Quick Save');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes without calling api on Escape', () => {
    const onClose = vi.fn();
    renderModal(makeChapter(), onClose);
    fireEvent.keyDown(screen.getByTestId('edit-chapter-title-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('does not call api or dispatch when Cancel is clicked', () => {
    const onClose = vi.fn();
    const { store } = renderModal(makeChapter(), onClose);

    const input = screen.getByTestId('edit-chapter-title-input');
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(renameSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.chapters[0].title).toBe('Chapter 3 — Awkward Heuristic');
  });

  it('surfaces a toast and keeps the modal open when the api rejects', async () => {
    renameSpy.mockRejectedValue(new Error('Title must be 200 characters or fewer.'));
    const onClose = vi.fn();
    const { store } = renderModal(makeChapter(), onClose);

    fireEvent.change(screen.getByTestId('edit-chapter-title-input'), {
      target: { value: 'x'.repeat(50) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      const toasts = store.getState().notifications.toasts;
      expect(toasts.some((t) => t.message.includes('200 characters'))).toBe(true);
    });
    expect(onClose).not.toHaveBeenCalled();
    // Slice not updated on failure — chapter still has original title.
    expect(store.getState().chapters.chapters[0].title).toBe('Chapter 3 — Awkward Heuristic');
  });
});
