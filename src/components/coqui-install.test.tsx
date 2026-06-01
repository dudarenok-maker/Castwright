/* CoquiInstall component state-machine spec. Mirrors qwen-install.test.tsx —
   stubbed fetch drives detect/install/poll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CoquiInstall } from './coqui-install';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CoquiInstall', () => {
  it('renders the "installed" pill when /detect reports installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'ready', installed: true }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<CoquiInstall />);
    await waitFor(() => expect(screen.getByTestId('coqui-install-ready')).toBeInTheDocument());
    expect(screen.getByText(/Coqui XTTS v2 is installed/i)).toBeInTheDocument();
  });

  it('renders the install card (with value/difference copy) when not installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'weights-missing', installed: false }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<CoquiInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('coqui-install-not-detected')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /install coqui xtts v2/i })).toBeInTheDocument();
    expect(screen.getByText(/zero-shot voice cloning/i)).toBeInTheDocument();
  });

  it('clicking Install POSTs /install and renders the job card with the step text', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'weights-missing', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Pre-fetching XTTS v2', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<CoquiInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('coqui-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install coqui xtts v2/i }));
    await waitFor(() => expect(screen.getByTestId('coqui-install-job')).toBeInTheDocument());
    expect(screen.getByText(/Pre-fetching XTTS v2/i)).toBeInTheDocument();
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'weights-missing', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'error', step: null, error: 'pre-fetch failed' }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<CoquiInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('coqui-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install coqui xtts v2/i }));
    await waitFor(() => expect(screen.getByTestId('coqui-install-error')).toBeInTheDocument());
    expect(screen.getByText(/pre-fetch failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
