import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExternalLink } from './external-link';

describe('ExternalLink', () => {
  it('renders a new-tab link with safe rel, the given href and label', () => {
    render(<ExternalLink href="https://example.com/docs" label="Open docs" />);
    const a = screen.getByRole('link', { name: /open docs/i });
    expect(a).toHaveAttribute('href', 'https://example.com/docs');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
