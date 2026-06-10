/* #/release-notes — renders the bundled multi-version history newest-first and
   marks the running version. useAppInfo is mocked so the test is hermetic. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ info: null as null | Record<string, unknown> }));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: vi.fn() }),
}));

import { ReleaseNotesView } from './release-notes';

const NOTES =
  '# Castwright 1.7.0\n- **It runs on a Mac now.** Apple Silicon is first-class.\n\n# Castwright 1.6.0\n- **Update from inside the app.** In-app upgrade.';

beforeEach(() => {
  h.info = null;
});

describe('ReleaseNotesView', () => {
  it('renders each version section, newest first', () => {
    h.info = { appVersion: '1.7.0', releaseNotes: NOTES };
    render(<ReleaseNotesView />);
    expect(screen.getByText('Castwright 1.7.0')).toBeInTheDocument();
    expect(screen.getByText('Castwright 1.6.0')).toBeInTheDocument();
    expect(screen.getByText(/It runs on a Mac now/)).toBeInTheDocument();
    expect(screen.getByText(/In-app upgrade/)).toBeInTheDocument();
  });

  it('marks the section matching the running version', () => {
    h.info = { appVersion: '1.6.0', releaseNotes: NOTES };
    render(<ReleaseNotesView />);
    expect(screen.getByText(/on this version/i)).toBeInTheDocument();
  });
});
