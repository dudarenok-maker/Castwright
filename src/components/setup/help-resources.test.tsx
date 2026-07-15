import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelpResources } from './help-resources';

const BASE = 'https://github.com/dudarenok-maker/Castwright';

describe('HelpResources', () => {
  it('renders exactly 5 help links, each opening safely in a new tab', () => {
    render(<HelpResources />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('links to getting-started, install guide, troubleshooting, issues, discussions', () => {
    render(<HelpResources />);
    expect(screen.getByRole('link', { name: /getting started/i })).toHaveAttribute(
      'href', `${BASE}/wiki/Getting-Started`,
    );
    expect(screen.getByRole('link', { name: /install & setup/i })).toHaveAttribute(
      'href', `${BASE}/wiki/Installing-Castwright`,
    );
    expect(screen.getByRole('link', { name: /troubleshooting/i })).toHaveAttribute(
      'href', `${BASE}/wiki/Troubleshooting`,
    );
    expect(screen.getByRole('link', { name: /report a problem/i })).toHaveAttribute(
      'href', `${BASE}/issues`,
    );
    expect(screen.getByRole('link', { name: /ask a question/i })).toHaveAttribute(
      'href', `${BASE}/discussions`,
    );
  });
});
