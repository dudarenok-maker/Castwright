import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { manuscriptSlice } from '../store/manuscript-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { PromoteFirstSentenceButton } from './promote-first-sentence-button';
import type { Sentence } from '../lib/types';

const { renameChapter } = vi.hoisted(() => ({ renameChapter: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { renameChapter } };
});

const firstSentence: Sentence = {
  id: 1,
  chapterId: 3,
  characterId: 'narrator',
  text: 'PUPPY TRAINING.',
} as never;

function makeStore() {
  return configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      chapters: chaptersSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        sentences: [
          firstSentence,
          { id: 2, chapterId: 3, characterId: 'narrator', text: 'You brought home a puppy.' } as never,
        ],
      },
      chapters: {
        ...chaptersSlice.getInitialState(),
        chapters: [{ id: 3, title: 'Chapter 3', titleOverridden: false } as never],
      },
    },
  });
}

beforeEach(() => {
  renameChapter.mockReset();
});

describe('PromoteFirstSentenceButton', () => {
  it('is disabled when there is no first sentence', () => {
    render(
      <Provider store={makeStore()}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={null}
          isOnlySentence={false}
        />
      </Provider>,
    );
    expect(screen.getByTestId('promote-first-sentence-button')).toBeDisabled();
  });

  it('is disabled when the cleaned text exceeds 200 chars', () => {
    const long = { ...firstSentence, text: 'x'.repeat(201) };
    render(
      <Provider store={makeStore()}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={long}
          isOnlySentence={false}
        />
      </Provider>,
    );
    expect(screen.getByTestId('promote-first-sentence-button')).toBeDisabled();
  });

  it('shows the trimmed, trailing-period-stripped text in the confirm preview', () => {
    render(
      <Provider store={makeStore()}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={{ ...firstSentence, text: '  PUPPY TRAINING.  ' }}
          isOnlySentence={false}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent('PUPPY TRAINING');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('PUPPY TRAINING.');
  });

  it('Cancel closes the dialog with no dispatch or api call', () => {
    render(
      <Provider store={makeStore()}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={firstSentence}
          isOnlySentence={false}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(renameChapter).not.toHaveBeenCalled();
  });

  it('Confirm renames the chapter, removes the sentence, and tombstones it', async () => {
    renameChapter.mockResolvedValue(undefined);
    const store = makeStore();
    render(
      <Provider store={store}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={firstSentence}
          isOnlySentence={false}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    fireEvent.click(screen.getByTestId('promote-first-sentence-confirm'));
    await waitFor(() => expect(renameChapter).toHaveBeenCalledWith('b1', 3, 'PUPPY TRAINING'));
    const state = store.getState();
    expect(state.chapters.chapters[0].title).toBe('PUPPY TRAINING');
    expect(state.chapters.chapters[0].titleOverridden).toBe(true);
    expect(state.manuscript.sentences.map((s: Sentence) => s.id)).toEqual([2]);
    expect(state.manuscript.mergedAwayKeys).toContain('3:1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a failed rename shows an error toast and leaves the sentence untouched', async () => {
    renameChapter.mockRejectedValue(new Error('network down'));
    const store = makeStore();
    render(
      <Provider store={store}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={firstSentence}
          isOnlySentence={false}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    fireEvent.click(screen.getByTestId('promote-first-sentence-confirm'));
    await waitFor(() => expect(store.getState().notifications.toasts).toHaveLength(1));
    expect(store.getState().notifications.toasts[0].message).toBe(
      'Could not rename chapter 3: network down',
    );
    expect(store.getState().manuscript.sentences).toHaveLength(2);
    expect(store.getState().chapters.chapters[0].title).toBe('Chapter 3');
  });

  it('disables Confirm (not just the trigger) if firstSentence becomes invalid while the popover is open (PR-gate round 3)', () => {
    /* Regression: the popover doesn't reopen/remount on a sentence-content
       change (only a chapter switch remounts it, via the `key` in
       manuscript.tsx), so `cleaned`/`disabled` are recomputed live from
       whatever `firstSentence` prop is current. A concurrent edit (e.g. a
       script-review apply) could rewrite the same sentence to empty text
       while the popover is already open — Confirm must re-validate, not
       just check `busy`. */
    const store = makeStore();
    const { rerender } = render(
      <Provider store={store}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={firstSentence}
          isOnlySentence={false}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByTestId('promote-first-sentence-confirm')).toBeEnabled();

    // Simulate a concurrent edit emptying the sentence's text.
    rerender(
      <Provider store={store}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={{ ...firstSentence, text: '   ' }}
          isOnlySentence={false}
        />
      </Provider>,
    );

    expect(screen.getByTestId('promote-first-sentence-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('promote-first-sentence-confirm'));
    expect(renameChapter).not.toHaveBeenCalled();
  });

  it('shows the normal confirm copy (no "only sentence" warning) when isOnlySentence is false', () => {
    render(
      <Provider store={makeStore()}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={firstSentence}
          isOnlySentence={false}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Set title to "PUPPY TRAINING" and remove it from narration?',
    );
    expect(screen.getByRole('dialog')).not.toHaveTextContent("chapter's only sentence");
  });

  it('shows the stronger "only sentence" warning copy when isOnlySentence is true', () => {
    render(
      <Provider store={makeStore()}>
        <PromoteFirstSentenceButton
          bookId="b1"
          chapterId={3}
          firstSentence={firstSentence}
          isOnlySentence={true}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      "This is the chapter's only sentence — the chapter will have no narrated content until you add more.",
    );
  });
});
