/* Plan 124 — build-version footer. Verifies the shell footer renders with the
   contentinfo landmark + testid and a version-shaped stamp. Vitest runs as dev
   (import.meta.env.DEV === true), so the verbose form is rendered off the
   sentinel buildInfo — assertions stay resilient (shape, not exact sentinels).
   The in-app stamp starts with the bare brand name "Castwright ·" (the
   "Made with Castwright" attribution form is reserved for exported outputs). */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BuildStamp } from './build-stamp';

describe('BuildStamp', () => {
  it('renders a labelled contentinfo footer carrying the build stamp', () => {
    render(<BuildStamp />);
    const footer = screen.getByTestId('build-stamp');
    expect(footer).toBeInTheDocument();
    /* aria-label is the stamp itself — "Castwright · v…" — so the landmark is
       named. Match by the brand prefix. */
    expect(screen.getByRole('contentinfo', { name: /^castwright/i })).toBe(footer);
  });

  it('shows the "Castwright" brand prefix in the stamp', () => {
    render(<BuildStamp />);
    const text = screen.getByTestId('build-stamp').textContent ?? '';
    expect(text).toMatch(/^Castwright/);
    expect(text).toContain('·');
  });
});
