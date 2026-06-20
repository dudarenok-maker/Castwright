/* MergeSuggestionCard — unit tests for the Tier-2b diminutive merge-suggestion
   card component. Verifies render (two names + reason + buttons) and button wiring
   (Merge calls onMerge, Dismiss calls onDismiss). */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MergeSuggestionCard } from './merge-suggestion-card';
import type { MergeSuggestion } from '../lib/api';

const suggestion: MergeSuggestion = {
  sourceId: 'olya',
  targetId: 'olga',
  reason: 'Diminutive of «Ольга»',
};

describe('MergeSuggestionCard', () => {
  it('renders source name, target name, and reason', () => {
    const { container } = render(
      <MergeSuggestionCard
        suggestion={suggestion}
        sourceName="Оля"
        targetName="Ольга"
        onMerge={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('merge-suggestion-card')).toBeInTheDocument();
    /* The card heading contains both names. */
    expect(container.querySelector('p')?.textContent).toMatch(/«Оля»/);
    expect(container.querySelector('p')?.textContent).toMatch(/«Ольга»/);
    expect(screen.getByText(/Diminutive of «Ольга»/)).toBeInTheDocument();
  });

  it('calls onMerge when the Merge button is clicked', () => {
    const onMerge = vi.fn().mockResolvedValue(undefined);
    render(
      <MergeSuggestionCard
        suggestion={suggestion}
        sourceName="Оля"
        targetName="Ольга"
        onMerge={onMerge}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-suggestion-merge'));
    expect(onMerge).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when the Dismiss button is clicked', () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(
      <MergeSuggestionCard
        suggestion={suggestion}
        sourceName="Оля"
        targetName="Ольга"
        onMerge={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-suggestion-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('falls back gracefully when names equal the ids (unknown character)', () => {
    render(
      <MergeSuggestionCard
        suggestion={suggestion}
        sourceName="olya"
        targetName="olga"
        onMerge={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/«olya»/)).toBeInTheDocument();
    expect(screen.getByText(/«olga»/)).toBeInTheDocument();
  });
});
