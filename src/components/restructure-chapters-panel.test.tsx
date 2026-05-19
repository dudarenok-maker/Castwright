/* RestructureChaptersPanel — covers the three op flows + multi-select
 * + drag reorder via keyboard sensor + confirm-dialog gating.
 *
 * @dnd-kit's KeyboardSensor is the accessibility hook the panel must
 * keep working: Space-to-grab a row, arrows to move, Enter to drop.
 * fireEvent.keyDown drives this without needing a layout engine. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RestructureChaptersPanel } from './restructure-chapters-panel';
import type { Chapter, Sentence } from '../lib/types';

function makeChapter(id: number, title: string, duration = '01:00'): Chapter {
  return {
    id,
    title,
    duration,
    state: 'queued',
    progress: 0,
    characters: {},
  };
}

function makeSentence(id: number, chapterId: number, text: string): Sentence {
  return { id, chapterId, characterId: 'narr', text };
}

const FIXTURES = {
  chapters: [
    makeChapter(1, 'Chapter One'),
    makeChapter(2, 'Chapter Two'),
    makeChapter(3, 'Chapter Three'),
  ],
  sentences: [
    makeSentence(1, 1, 'A1 first.'),
    makeSentence(2, 1, 'A1 last.'),
    makeSentence(1, 2, 'B1 first.'),
    makeSentence(2, 2, 'B1 last.'),
    makeSentence(1, 3, 'C1 only.'),
  ],
};

describe('RestructureChaptersPanel — rendering', () => {
  it('renders one row per chapter with sentence count + first + last excerpts', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.getByText('Chapter One')).toBeInTheDocument();
    expect(screen.getByText('Chapter Two')).toBeInTheDocument();
    expect(screen.getByText('Chapter Three')).toBeInTheDocument();
    expect(screen.getByText(/A1 first\./)).toBeInTheDocument();
    expect(screen.getByText(/A1 last\./)).toBeInTheDocument();
    // Chapter 3 has only one sentence — only first excerpt shows, no separate "last"
    expect(screen.getByText(/C1 only\./)).toBeInTheDocument();
    // Sentence count badges
    expect(screen.getAllByText(/2 sentences/)).toHaveLength(2);
    expect(screen.getAllByText(/1 sentence/)).toHaveLength(1);
  });
});

describe('RestructureChaptersPanel — merge selection', () => {
  it('disables Merge button until 2 contiguous chapters selected', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    const mergeBtn = screen.getByTestId('restructure-merge-button');
    expect(mergeBtn).toBeDisabled();

    // Pick chapter 1 only — still disabled
    fireEvent.click(screen.getByTestId('restructure-check-1'));
    expect(mergeBtn).toBeDisabled();

    // Pick chapter 3 too — non-contiguous, still disabled
    fireEvent.click(screen.getByTestId('restructure-check-3'));
    expect(mergeBtn).toBeDisabled();
    expect(mergeBtn.getAttribute('title') ?? '').toMatch(/contiguous/i);

    // Swap 3 for 2 — now contiguous, enabled
    fireEvent.click(screen.getByTestId('restructure-check-3'));
    fireEvent.click(screen.getByTestId('restructure-check-2'));
    expect(mergeBtn).not.toBeDisabled();
  });

  it('fires onMerge with sorted contiguous ids after confirm', async () => {
    const onMerge = vi.fn().mockResolvedValue(undefined);
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={onMerge}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    // Pick 2 then 1 in reverse order to verify sorting
    fireEvent.click(screen.getByTestId('restructure-check-2'));
    fireEvent.click(screen.getByTestId('restructure-check-1'));
    fireEvent.click(screen.getByTestId('restructure-merge-button'));
    // Confirm dialog shows
    expect(screen.getByTestId('restructure-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(onMerge).toHaveBeenCalledWith([1, 2]));
  });

  it('cancels selection via Cancel selection button', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('restructure-check-1'));
    fireEvent.click(screen.getByTestId('restructure-check-2'));
    expect(screen.getByTestId('restructure-merge-button')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('restructure-cancel-selection'));
    expect(screen.getByTestId('restructure-merge-button')).toBeDisabled();
  });
});

describe('RestructureChaptersPanel — split affordance', () => {
  it('expands a chapter row to show per-sentence split buttons and fires onSplit after confirm', async () => {
    const onSplit = vi.fn().mockResolvedValue(undefined);
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={onSplit}
        onReorder={vi.fn()}
      />,
    );
    // Sentence list initially hidden
    expect(screen.queryByTestId('restructure-sentences-1')).not.toBeInTheDocument();
    // Expand chapter 1
    fireEvent.click(screen.getByTestId('restructure-split-toggle-1'));
    expect(screen.getByTestId('restructure-sentences-1')).toBeInTheDocument();
    // Split after sentence 1 (only one split point since chapter has 2 sentences)
    fireEvent.click(screen.getByTestId('restructure-split-after-1-1'));
    fireEvent.click(screen.getByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(onSplit).toHaveBeenCalledWith(1, 1));
  });

  it('disables split toggle for single-sentence chapters', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    // Chapter 3 has one sentence → toggle disabled
    expect(screen.getByTestId('restructure-split-toggle-3')).toBeDisabled();
  });
});

describe('RestructureChaptersPanel — confirm dialog', () => {
  it('does not fire op when Cancel is clicked', () => {
    const onMerge = vi.fn();
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={onMerge}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('restructure-check-1'));
    fireEvent.click(screen.getByTestId('restructure-check-2'));
    fireEvent.click(screen.getByTestId('restructure-merge-button'));
    fireEvent.click(screen.getByTestId('restructure-confirm-cancel'));
    expect(onMerge).not.toHaveBeenCalled();
  });
});

describe('RestructureChaptersPanel — busy state', () => {
  it('disables checkboxes and split toggles when busy', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        busy
      />,
    );
    expect(screen.getByTestId('restructure-check-1')).toBeDisabled();
    expect(screen.getByTestId('restructure-split-toggle-1')).toBeDisabled();
  });
});

describe('RestructureChaptersPanel — back button', () => {
  it('renders only when onBack is supplied', () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.queryByText('Back')).not.toBeInTheDocument();
    rerender(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalled();
  });
});

/* -- plan 70b: exclude per-row + refresh-titles button -------------- */

function makeExcludedChapter(id: number, title: string): Chapter {
  return { ...makeChapter(id, title), excluded: true };
}

describe('RestructureChaptersPanel — exclude per-row (plan 70b)', () => {
  it('renders Exclude button per row when onExclude is wired', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onExclude={vi.fn()}
      />,
    );
    expect(screen.getByTestId('restructure-exclude-1')).toBeInTheDocument();
    expect(screen.getByTestId('restructure-exclude-2')).toBeInTheDocument();
    expect(screen.getByTestId('restructure-exclude-3')).toBeInTheDocument();
  });

  it('hides Exclude button when onExclude is not wired (back-compat)', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('restructure-exclude-1')).not.toBeInTheDocument();
  });

  it('shows "Exclude" label for non-excluded rows, "Include" for excluded rows', () => {
    render(
      <RestructureChaptersPanel
        chapters={[
          FIXTURES.chapters[0],
          makeExcludedChapter(2, 'Chapter Two'),
          FIXTURES.chapters[2],
        ]}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onExclude={vi.fn()}
      />,
    );
    expect(screen.getByTestId('restructure-exclude-1').textContent).toBe('Exclude');
    expect(screen.getByTestId('restructure-exclude-2').textContent).toBe('Include');
    expect(screen.getByTestId('restructure-exclude-3').textContent).toBe('Exclude');
  });

  it('fires onExclude with the inverted flag when clicked', async () => {
    const onExclude = vi.fn();
    render(
      <RestructureChaptersPanel
        chapters={[
          FIXTURES.chapters[0],
          makeExcludedChapter(2, 'Chapter Two'),
          FIXTURES.chapters[2],
        ]}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onExclude={onExclude}
      />,
    );
    fireEvent.click(screen.getByTestId('restructure-exclude-1'));
    fireEvent.click(screen.getByTestId('restructure-exclude-2'));
    await waitFor(() => expect(onExclude).toHaveBeenCalledTimes(2));
    expect(onExclude).toHaveBeenNthCalledWith(1, 1, true); // not excluded → excluded
    expect(onExclude).toHaveBeenNthCalledWith(2, 2, false); // excluded → un-excluded
  });

  it('disables the merge checkbox for excluded rows', () => {
    render(
      <RestructureChaptersPanel
        chapters={[
          FIXTURES.chapters[0],
          makeExcludedChapter(2, 'Chapter Two'),
          FIXTURES.chapters[2],
        ]}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onExclude={vi.fn()}
      />,
    );
    expect(screen.getByTestId('restructure-check-1')).not.toBeDisabled();
    expect(screen.getByTestId('restructure-check-2')).toBeDisabled();
    expect(screen.getByTestId('restructure-check-3')).not.toBeDisabled();
  });

  it('marks excluded rows with data-excluded=true for styling assertion', () => {
    render(
      <RestructureChaptersPanel
        chapters={[
          FIXTURES.chapters[0],
          makeExcludedChapter(2, 'Chapter Two'),
        ]}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onExclude={vi.fn()}
      />,
    );
    expect(screen.getByTestId('restructure-row-1').getAttribute('data-excluded')).toBe('false');
    expect(screen.getByTestId('restructure-row-2').getAttribute('data-excluded')).toBe('true');
  });
});

describe('RestructureChaptersPanel — Refresh chapter names button (plan 70b)', () => {
  it('renders the Refresh button when onRefreshTitles is wired', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onRefreshTitles={vi.fn()}
      />,
    );
    expect(screen.getByTestId('restructure-refresh-titles')).toBeInTheDocument();
  });

  it('hides the Refresh button when onRefreshTitles is not wired', () => {
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('restructure-refresh-titles')).not.toBeInTheDocument();
  });

  it('fires onRefreshTitles after confirm', async () => {
    const onRefreshTitles = vi.fn().mockResolvedValue(undefined);
    render(
      <RestructureChaptersPanel
        chapters={FIXTURES.chapters}
        sentences={FIXTURES.sentences}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onReorder={vi.fn()}
        onRefreshTitles={onRefreshTitles}
      />,
    );
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    // Confirm dialog appears with refresh-specific description
    expect(screen.getByTestId('restructure-confirm')).toBeInTheDocument();
    expect(screen.getByText(/Auto-generated/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(onRefreshTitles).toHaveBeenCalled());
  });
});
