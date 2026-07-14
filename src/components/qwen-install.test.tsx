/* QwenInstall — CONTROLLED card spec. The idle state is driven by the `status`
   prop; a stubbed fetch drives only the install-job POST/poll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QwenInstall } from './qwen-install';

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

describe('QwenInstall — controlled idle states', () => {
  it('renders ready as installed', () => {
    render(<QwenInstall status={{ state: 'ready', packageBroken: false }} />);
    expect(screen.getByText(/Qwen3-TTS is installed/i)).toBeInTheDocument();
  });

  it('renders weights-missing distinctly (not "not installed")', () => {
    render(<QwenInstall status={{ state: 'weights-missing', packageBroken: false }} />);
    expect(screen.getByText(/voice weights not downloaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Qwen3-TTS is not installed/i)).not.toBeInTheDocument();
  });

  it('renders package-broken as a repair state', () => {
    render(<QwenInstall status={{ state: 'ready', packageBroken: true }} />);
    expect(screen.getByText(/is installed but fails to load/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /repair/i })).toBeInTheDocument();
  });

  it('renders not-installed with an install CTA', () => {
    render(<QwenInstall status={{ state: 'not-installed', packageBroken: false }} />);
    expect(screen.getByRole('button', { name: /install qwen3-tts/i })).toBeInTheDocument();
  });
});

describe('QwenInstall — install job', () => {
  it('clicking Install POSTs /install and renders the job card with the step text', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Pre-fetching models', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<QwenInstall status={{ state: 'not-installed', packageBroken: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /install qwen3-tts/i }));
    await waitFor(() => expect(screen.getByTestId('qwen-install-job')).toBeInTheDocument());
    expect(screen.getByText(/Pre-fetching models/i)).toBeInTheDocument();
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'error', step: null, error: 'pip failed' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<QwenInstall status={{ state: 'not-installed', packageBroken: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /install qwen3-tts/i }));
    await waitFor(() => expect(screen.getByTestId('qwen-install-error')).toBeInTheDocument());
    expect(screen.getByText(/pip failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
