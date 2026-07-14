/* CoquiInstall — CONTROLLED card spec. The idle state is driven by the `status`
   prop; a stubbed fetch drives only the install-job POST/poll. */

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

describe('CoquiInstall — controlled idle states', () => {
  it('renders ready as installed', () => {
    render(<CoquiInstall status={{ state: 'ready', packageBroken: false }} />);
    expect(screen.getByText(/Coqui XTTS v2 is installed/i)).toBeInTheDocument();
  });

  it('renders the install card (with value/difference copy) when not installed', () => {
    render(<CoquiInstall status={{ state: 'not-installed', packageBroken: false }} />);
    expect(screen.getByRole('button', { name: /install coqui xtts v2/i })).toBeInTheDocument();
    expect(screen.getByText(/zero-shot voice cloning/i)).toBeInTheDocument();
  });

  it('renders weights-missing distinctly (not "not installed")', () => {
    render(<CoquiInstall status={{ state: 'weights-missing', packageBroken: false }} />);
    expect(screen.getByText(/voice weights not downloaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Coqui XTTS v2 is not installed/i)).not.toBeInTheDocument();
  });

  it('renders package-broken as a repair state', () => {
    render(<CoquiInstall status={{ state: 'ready', packageBroken: true }} />);
    expect(screen.getByText(/is installed but fails to load/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /repair/i })).toBeInTheDocument();
  });
});

describe('CoquiInstall — install job', () => {
  it('clicking Install POSTs /install and renders the job card with the step text', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Pre-fetching XTTS v2', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<CoquiInstall status={{ state: 'not-installed', packageBroken: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /install coqui xtts v2/i }));
    await waitFor(() => expect(screen.getByTestId('coqui-install-job')).toBeInTheDocument());
    expect(screen.getByText(/Pre-fetching XTTS v2/i)).toBeInTheDocument();
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'error', step: null, error: 'pre-fetch failed' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<CoquiInstall status={{ state: 'not-installed', packageBroken: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /install coqui xtts v2/i }));
    await waitFor(() => expect(screen.getByTestId('coqui-install-error')).toBeInTheDocument());
    expect(screen.getByText(/pre-fetch failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
