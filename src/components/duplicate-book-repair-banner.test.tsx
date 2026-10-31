import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AppInfo } from '../lib/types';

const h = vi.hoisted(() => ({ info: null as AppInfo | null, refresh: vi.fn(async () => {}) }));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: h.refresh }),
}));

import { DuplicateBookRepairBanner } from './duplicate-book-repair-banner';

const repair = {
  previousBookId: 'a__s__t',
  newBookId: 'a__s__t-2',
  keptFolder: 'A/S/T2',
  reassignedFolder: 'A/S/T',
};

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
  h.info = null;
});
afterEach(() => vi.restoreAllMocks());

describe('DuplicateBookRepairBanner (#3713)', () => {
  it('renders nothing for an absent or empty list', () => {
    h.info = info({});
    const { container, rerender } = render(<DuplicateBookRepairBanner />);
    expect(container).toBeEmptyDOMElement();
    h.info = info({ duplicateBookIdRepairs: [] });
    rerender(<DuplicateBookRepairBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names both folders, with the kept folder in the kept position', () => {
    h.info = info({ duplicateBookIdRepairs: [repair] });
    render(<DuplicateBookRepairBanner />);
    const banner = screen.getByTestId('duplicate-book-repair-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner.textContent).toMatch(/A\/S\/T2 kept its ID/);
    expect(banner.textContent).toMatch(/A\/S\/T has a new ID and starts with an empty queue/);
  });

  it('hides on Dismiss and stays hidden after a remount', () => {
    h.info = info({ duplicateBookIdRepairs: [repair] });
    const first = render(<DuplicateBookRepairBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('duplicate-book-repair-banner')).toBeNull();
    first.unmount();
    render(<DuplicateBookRepairBanner />);
    expect(screen.queryByTestId('duplicate-book-repair-banner')).toBeNull();
  });

  it('still renders, and dismisses for the session, when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    h.info = info({ duplicateBookIdRepairs: [repair] });
    render(<DuplicateBookRepairBanner />);
    expect(screen.getByTestId('duplicate-book-repair-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('duplicate-book-repair-banner')).toBeNull();
  });
});
