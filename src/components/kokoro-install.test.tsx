/* KokoroInstall — CONTROLLED card spec. The idle state is driven by the `status`
   prop; a stubbed fetch drives only the install-job POST/poll. */

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

describe('KokoroInstall — controlled idle states', () => {
  it('renders weights-missing distinctly (not "not installed")', () => {
    render(<KokoroInstall status={{ state: 'weights-missing', packageBroken: false }} />);
    expect(screen.getByText(/voice weights not downloaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Kokoro is not installed/i)).not.toBeInTheDocument();
  });

  it('renders package-broken as a repair state', () => {
    render(<KokoroInstall status={{ state: 'ready', packageBroken: true }} />);
    expect(screen.getByText(/is installed but fails to load/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /repair/i })).toBeInTheDocument();
  });

  it('renders package-missing as a repair state', () => {
    render(<KokoroInstall status={{ state: 'package-missing', packageBroken: false }} />);
    expect(screen.getByTestId('kokoro-install-package-missing')).toBeInTheDocument();
    expect(screen.getByText(/package needs repair/i)).toBeInTheDocument();
  });

  it('renders ready as installed', () => {
    render(<KokoroInstall status={{ state: 'ready', packageBroken: false }} />);
    expect(screen.getByText(/Kokoro is installed/i)).toBeInTheDocument();
  });

  it('renders not-installed with an install CTA', () => {
    render(<KokoroInstall status={{ state: 'not-installed', packageBroken: false }} />);
    expect(screen.getByRole('button', { name: /Install Kokoro/i })).toBeInTheDocument();
  });

  it('Re-check on the ready card calls onInstalled (parent refetches models-status)', () => {
    const onInstalled = vi.fn();
    render(
      <KokoroInstall status={{ state: 'ready', packageBroken: false }} onInstalled={onInstalled} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /re-check/i }));
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });
});

describe('KokoroInstall — install job', () => {
  it('clicking Install POSTs /install and renders the job card with the step text', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Downloading Kokoro weights', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<KokoroInstall status={{ state: 'not-installed', packageBroken: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /install kokoro/i }));
    await waitFor(() => expect(screen.getByTestId('kokoro-install-job')).toBeInTheDocument());
    expect(screen.getByText(/Downloading Kokoro weights/i)).toBeInTheDocument();
  });

  it('calls onInstalled when a poll flips to installed', async () => {
    const onInstalled = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '42', status: 'installing', step: 'Downloading…', error: null }),
        );
      }
      if (url.includes('/install/42')) {
        return Promise.resolve(jsonResponse({ id: '42', status: 'installed', step: null, error: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <KokoroInstall status={{ state: 'not-installed', packageBroken: false }} onInstalled={onInstalled} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /install kokoro/i }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'error', step: null, error: 'download failed' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<KokoroInstall status={{ state: 'not-installed', packageBroken: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /install kokoro/i }));
    await waitFor(() => expect(screen.getByTestId('kokoro-install-error')).toBeInTheDocument());
    expect(screen.getByText(/download failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
