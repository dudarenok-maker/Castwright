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
    render(
      <RegenerateModal
        chapter={chapter}
        defaultScope="forward"
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ scope: 'forward' }));
  });

  it('defaults to "Just this chapter" when no scope is forced', () => {
    const onConfirm = vi.fn();
    render(
      <RegenerateModal
        chapter={chapter}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
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
    render(
      <RegenerateModal
        chapter={chapter}
        defaultScope="forward"
        forwardCount={20}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/for 20 chapters/)).toBeInTheDocument();
    expect(screen.queryByText(/for 4 chapters/)).not.toBeInTheDocument();
  });

  it('pluralises correctly when only one chapter remains', () => {
    render(
      <RegenerateModal
        chapter={chapter}
        defaultScope="forward"
        forwardCount={1}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/for 1 chapter\b/)).toBeInTheDocument();
  });
});

describe('RegenerateModal — ETA scales with audio duration × RTF', () => {
  /* Previously the single-chapter ETA was the hardcoded string "≈3 min"
     regardless of the chapter's length. Generation wall-clock tracks the
     real-time factor (~2.5), so a 10-minute chapter takes ~25 min, not 3. */
  const tenMin: Chapter = { ...chapter, duration: '10:00' };

  it('derives the single-chapter ETA from the chapter duration (≈25 min for 10:00)', () => {
    render(
      <RegenerateModal
        chapter={tenMin}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('≈25 min')).toBeInTheDocument();
    expect(screen.queryByText('≈3 min')).not.toBeInTheDocument();
  });

  it('derives the forward ETA from forwardDurationSec, not a flat per-chapter number', () => {
    render(
      <RegenerateModal
        chapter={tenMin}
        defaultScope="forward"
        forwardCount={3}
        /* 3 × 10:00 = 1800s → 1800 × 2.5 = 4500s = 75 min → "1h 15m". */
        forwardDurationSec={1800}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('≈1h 15m for 3 chapters')).toBeInTheDocument();
  });
});

describe('RegenerateModal — scroll-safe on short viewports (footer never clipped)', () => {
  /* Regression: the card is centered with `grid place-items-center` and is
     `overflow-hidden`. Without a max-height + an internal scroll region, a short
     desktop window pushes the footer (Cancel + Regenerate) below the viewport
     with no way to scroll to it. The card must cap its height as a flex column
     and let the body scroll, keeping header + footer visible — the same pattern
     CharacterRegenerateModal already uses. */
  it('caps the card height and makes the body the scroll region', () => {
    const { container } = render(
      <RegenerateModal
        chapter={chapter}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    const card = container.querySelector('.max-w-xl') as HTMLElement;
    expect(card).not.toBeNull();
    // Height-capped flex column so the footer can't be pushed off-screen.
    expect(card.className).toMatch(/max-h-\[90vh\]/);
    expect(card.className).toContain('flex-col');
    // The middle region (body) is the scroller; the header + footer stay put.
    const body = card.children[1] as HTMLElement;
    expect(body.className).toContain('overflow-y-auto');
  });
});

describe('RegenerateModal — per-regenerate model override (#4)', () => {
  it('confirms with the session default model when the picker is untouched', () => {
    const onConfirm = vi.fn();
    render(
      <RegenerateModal
        chapter={chapter}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate$/ }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ modelKey: 'qwen3-tts-0.6b' }),
    );
  });

  it('lets the user pick the Qwen 1.7B quality tier for this regenerate', () => {
    const onConfirm = vi.fn();
    render(
      <RegenerateModal
        chapter={chapter}
        defaultModelKey="qwen3-tts-0.6b"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText('Qwen3-TTS 1.7B'));
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate$/ }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ modelKey: 'qwen3-tts-1.7b' }),
    );
  });
});
