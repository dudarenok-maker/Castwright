/* Plan 124 — build-version footer. Verifies the shell footer renders with the
   contentinfo landmark + testid and a version-shaped stamp. Vitest runs as dev
   (import.meta.env.DEV === true), so the verbose form is rendered off the
   sentinel buildInfo — assertions stay resilient (shape, not exact sentinels). */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BuildStamp } from './build-stamp';

describe('BuildStamp', () => {
  it('renders a labelled contentinfo footer carrying the build stamp', () => {
    render(<BuildStamp />);
    const footer = screen.getByTestId('build-stamp');
    expect(footer).toBeInTheDocument();
    /* Single named contentinfo landmark for screen readers. */
    expect(screen.getByRole('contentinfo', { name: /build version/i })).toBe(footer);
  });

  it('shows a version-shaped, separator-joined stamp in dev', () => {
    render(<BuildStamp />);
    const text = screen.getByTestId('build-stamp').textContent ?? '';
    expect(text).toMatch(/^v\d/);
    expect(text).toContain('·');
  });
});
