/* Plan 124 — build-version footer. Verifies the shell footer renders with the
   contentinfo landmark + testid and a version-shaped stamp. Vitest runs as dev
   (import.meta.env.DEV === true), so the verbose form is rendered off the
   sentinel buildInfo — assertions stay resilient (shape, not exact sentinels).
   Wave 1: stamp now starts with "Made with Castwright ·" for brand presence. */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BuildStamp } from './build-stamp';

describe('BuildStamp', () => {
  it('renders a labelled contentinfo footer carrying the build stamp', () => {
    render(<BuildStamp />);
    const footer = screen.getByTestId('build-stamp');
    expect(footer).toBeInTheDocument();
    /* aria-label is the stamp itself — "Made with Castwright · v…" — so the
       landmark is named. Match by the brand prefix. */
    expect(screen.getByRole('contentinfo', { name: /made with castwright/i })).toBe(footer);
  });

  it('shows "Made with Castwright" brand prefix in the stamp', () => {
    render(<BuildStamp />);
    const text = screen.getByTestId('build-stamp').textContent ?? '';
    expect(text).toMatch(/^Made with Castwright/);
    expect(text).toContain('·');
  });
});
