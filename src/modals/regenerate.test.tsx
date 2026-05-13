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
