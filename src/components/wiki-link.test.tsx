import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WikiLink } from './wiki-link';

describe('WikiLink', () => {
  it('renders a page-level external link with safe rel', () => {
    render(<WikiLink page="Troubleshooting" />);
    const a = screen.getByRole('link', { name: /read more on the wiki/i });
    expect(a).toHaveAttribute('href', 'https://github.com/dudarenok-maker/Castwright/wiki/Troubleshooting');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('accepts a custom label', () => {
    render(<WikiLink page="Admin" label="Admin guide" />);
    expect(screen.getByRole('link', { name: /admin guide/i })).toBeInTheDocument();
  });
});
