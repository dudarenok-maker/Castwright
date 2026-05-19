/* Smoke test for the shared RestructureChaptersButton. Mounted in
 * Listen header (post-generation entry) and Manuscript header (plan 70b
 * pre-generation entry). The data-testid stays stable across both
 * mounts so the e2e selectors keep resolving. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RestructureChaptersButton } from './restructure-chapters-button';

describe('RestructureChaptersButton', () => {
  it('renders the full label + icon by default', () => {
    render(<RestructureChaptersButton onClick={vi.fn()} />);
    expect(screen.getByTestId('open-restructure')).toBeInTheDocument();
    expect(screen.getByText('Restructure chapters')).toBeInTheDocument();
  });

  it('renders the compact label when compact=true', () => {
    render(<RestructureChaptersButton onClick={vi.fn()} compact />);
    expect(screen.getByText('Restructure')).toBeInTheDocument();
    expect(screen.queryByText('Restructure chapters')).not.toBeInTheDocument();
  });

  it('fires onClick when activated', () => {
    const onClick = vi.fn();
    render(<RestructureChaptersButton onClick={onClick} />);
    fireEvent.click(screen.getByTestId('open-restructure'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
