// Pairs with the chapter-regenerate flow in docs/features.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegenerateModal } from './regenerate';
import type { Chapter } from '../lib/types';

const chapter: Chapter = {
  id: 1,
  title: 'Chapter 1',
  duration: '00:45',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done' },
};

describe('RegenerateModal — defaultScope', () => {
  /* Header-level "Regenerate" (post-generation) opens the modal pre-set to
     'forward' from chapter 1 so it acts as a whole-book regenerate. The
     per-chapter Regenerate entry-point still gets the 'this' default. */
  it('pre-selects "This and all subsequent" when defaultScope=forward', () => {
    const onConfirm = vi.fn();
    render(<RegenerateModal chapter={chapter} defaultScope="forward"
                            onClose={() => {}} onConfirm={onConfirm}/>);
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ scope: 'forward' }));
  });

  it('defaults to "Just this chapter" when no scope is forced', () => {
    const onConfirm = vi.fn();
    render(<RegenerateModal chapter={chapter}
                            onClose={() => {}} onConfirm={onConfirm}/>);
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ scope: 'this' }));
  });
});

describe('RegenerateModal — forward ETA reflects actual affected count', () => {
  /* Previously the modal hardcoded "≈14 min for 4 chapters" regardless of the
     book's size or the chapter the user clicked from, so picking "this and all
     subsequent" on chapter 1 of a 20-chapter book lied about scope. The count
     must mirror what `regenerateChapter` actually queues. */
  it('renders the passed-in forwardCount in the "this and all subsequent" ETA', () => {
    render(<RegenerateModal chapter={chapter} defaultScope="forward" forwardCount={20}
                            onClose={() => {}} onConfirm={() => {}}/>);
    expect(screen.getByText(/for 20 chapters/)).toBeInTheDocument();
    expect(screen.queryByText(/for 4 chapters/)).not.toBeInTheDocument();
  });

  it('pluralises correctly when only one chapter remains', () => {
    render(<RegenerateModal chapter={chapter} defaultScope="forward" forwardCount={1}
                            onClose={() => {}} onConfirm={() => {}}/>);
    expect(screen.getByText(/for 1 chapter\b/)).toBeInTheDocument();
  });
});
