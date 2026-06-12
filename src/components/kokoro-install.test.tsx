/* KokoroInstall component state-machine spec. Mirrors coqui-install.test.tsx —
   stubbed fetch drives detect/install/poll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KokoroInstall } from './kokoro-install';

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

describe('KokoroInstall', () => {
  it('renders the "installed" pill when /detect reports installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'ready', installed: true }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<KokoroInstall />);
    await waitFor(() => expect(screen.getByTestId('kokoro-install-ready')).toBeInTheDocument());
    expect(screen.getByText(/Kokoro is installed/i)).toBeInTheDocument();
  });

  it('renders the install card when not installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'weights-missing', installed: false }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<KokoroInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('kokoro-install-not-detected')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /install kokoro/i })).toBeInTheDocument();
  });

  it('clicking Install POSTs /install and renders the job card with the step text', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'weights-missing', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Downloading Kokoro weights', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<KokoroInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('kokoro-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install kokoro/i }));
    await waitFor(() => expect(screen.getByTestId('kokoro-install-job')).toBeInTheDocument());
    expect(screen.getByText(/Downloading Kokoro weights/i)).toBeInTheDocument();
  });

  it('calls onInstalled when a poll flips to installed', async () => {
    const onInstalled = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'weights-missing', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '42', status: 'installing', step: 'Downloading…', error: null }),
        );
      }
      if (url.includes('/install/42')) {
        return Promise.resolve(
          jsonResponse({ id: '42', status: 'installed', step: null, error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<KokoroInstall onInstalled={onInstalled} />);
    await waitFor(() =>
      expect(screen.getByTestId('kokoro-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install kokoro/i }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'weights-missing', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'error', step: null, error: 'download failed' }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<KokoroInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('kokoro-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install kokoro/i }));
    await waitFor(() => expect(screen.getByTestId('kokoro-install-error')).toBeInTheDocument());
    expect(screen.getByText(/download failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
