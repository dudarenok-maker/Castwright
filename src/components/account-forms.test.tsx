import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GeminiKeyField } from './account-forms';

/* fe-50: the "Get a Gemini API key" link points at the wiki walkthrough page
   (which owns the fragile aistudio.google.com URL), not straight to Google, so
   a Google URL move is a wiki edit rather than an app release. Renders wherever
   GeminiKeyField is used — the setup wizard step and the Account surface. */
describe('GeminiKeyField — "Get a Gemini API key" link (fe-50)', () => {
  it('links to the wiki walkthrough page with safe external-link attributes', () => {
    render(<GeminiKeyField status="unset" onSave={vi.fn()} />);
    const link = screen.getByRole('link', { name: /get a gemini api key/i });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/dudarenok-maker/Castwright/wiki/Getting-a-Gemini-API-Key',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows the link whether or not a key is already on file', () => {
    render(<GeminiKeyField status="set" onSave={vi.fn()} />);
    expect(screen.getByRole('link', { name: /get a gemini api key/i })).toBeInTheDocument();
  });
});
