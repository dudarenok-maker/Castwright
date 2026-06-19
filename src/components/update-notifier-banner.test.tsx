import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AppInfo } from '../lib/types';

// Hoisted mutable handle so the vi.mock factory reads live values per test.
// (Pattern copied verbatim from whats-new-banner.test.tsx — the codebase's
// established way to drive useAppInfo; vi.spyOn does NOT reliably intercept the
// ESM named import.)
const h = vi.hoisted(() => ({ info: null as AppInfo | null, refresh: vi.fn(async () => {}) }));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: h.refresh }),
}));

import { UpdateNotifierBanner } from './update-notifier-banner';
import { __resetForTests, getDismissedVersion } from '../lib/update-notice';

const info = (over: Partial<AppInfo>): AppInfo => ({
  appVersion: '1.8.0',
  sidecarVersion: null,
  schemas: {},
  lastSeenAppVersion: null,
  showWhatsNew: false,
  releaseNotes: '',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  __resetForTests();
  h.info = null;
});

const renderBanner = () =>
  render(
    <MemoryRouter>
      <UpdateNotifierBanner />
    </MemoryRouter>,
  );

describe('UpdateNotifierBanner', () => {
  it('renders the version and release-notes link when behind', () => {
    h.info = info({ updateAvailable: true, latestVersion: '1.9.0' });
    renderBanner();
    expect(screen.getByTestId('update-notifier-banner')).toBeInTheDocument();
    expect(screen.getByText(/Update available — v1\.9\.0/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /See what.?s new/ })).toHaveAttribute('href', '/release-notes');
  });

  it('does not render when up to date', () => {
    h.info = info({ updateAvailable: false, latestVersion: null });
    renderBanner();
    expect(screen.queryByTestId('update-notifier-banner')).not.toBeInTheDocument();
  });

  it('dismiss records the version and hides the banner', () => {
    h.info = info({ updateAvailable: true, latestVersion: '1.9.0' });
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(getDismissedVersion()).toBe('1.9.0');
    expect(screen.queryByTestId('update-notifier-banner')).not.toBeInTheDocument();
  });
});
