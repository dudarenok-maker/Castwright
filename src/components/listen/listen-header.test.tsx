/* ListenHeader — fs-2 language badge. Shown only for non-English books so the
   existing English library gets no new chrome. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListenHeader } from './listen-header';

const baseProps = {
  title: 'A Book',
  author: 'An Author',
  narratorName: null,
  voiceCount: 3,
  totalSec: 3600,
  chapterCount: 10,
  completedCount: 10,
  hasListenable: true,
  firstListenableId: 1,
  bookCoverGradient: ['#000', '#fff'] as [string, string],
  effectiveCoverUrl: null,
  coverLoadFailed: false,
  onCoverLoadFailed: vi.fn(),
  onChangeCover: vi.fn(),
  onPlayFromStart: vi.fn(),
  onOpenExportModal: vi.fn(),
  onEnterPreview: vi.fn(),
  onOpenRestructure: vi.fn(),
  notes: null,
};

describe('ListenHeader — Wave 2 brand attribution', () => {
  it('renders "Full-cast audiobook · made with Castwright" below the credit line', () => {
    render(<ListenHeader {...baseProps} />);
    expect(screen.getByText('Full-cast audiobook · made with Castwright')).toBeInTheDocument();
  });
});

describe('ListenHeader — fs-2 language badge', () => {
  it('renders a Russian badge for a ru book', () => {
    render(<ListenHeader {...baseProps} language="ru" />);
    const badge = screen.getByTestId('listen-language-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Russian');
  });

  it('hides the badge for an English book', () => {
    render(<ListenHeader {...baseProps} language="en" />);
    expect(screen.queryByTestId('listen-language-badge')).not.toBeInTheDocument();
  });

  it('hides the badge when language is absent (legacy)', () => {
    render(<ListenHeader {...baseProps} />);
    expect(screen.queryByTestId('listen-language-badge')).not.toBeInTheDocument();
  });
});
