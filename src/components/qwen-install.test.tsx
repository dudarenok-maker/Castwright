/* QwenInstall component state-machine spec (qwen-default phase 3). Mirrors
   ollama-install.test.tsx — stubbed fetch drives detect/install/poll. */

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

describe('QwenInstall', () => {
  it('renders the "installed" pill when /detect reports installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'ready', installed: true }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<QwenInstall />);
    await waitFor(() => expect(screen.getByTestId('qwen-install-ready')).toBeInTheDocument());
    expect(screen.getByText(/Qwen3-TTS is installed/i)).toBeInTheDocument();
  });

  it('renders the install card when /detect reports not-installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<QwenInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('qwen-install-not-detected')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /install qwen3-tts/i })).toBeInTheDocument();
  });

  it('clicking Install POSTs /install and renders the job card with the step text', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Pre-fetching models', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<QwenInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('qwen-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install qwen3-tts/i }));
    await waitFor(() => expect(screen.getByTestId('qwen-install-job')).toBeInTheDocument());
    expect(screen.getByText(/Pre-fetching models/i)).toBeInTheDocument();
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'error', step: null, error: 'pip failed' }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<QwenInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('qwen-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install qwen3-tts/i }));
    await waitFor(() => expect(screen.getByTestId('qwen-install-error')).toBeInTheDocument());
    expect(screen.getByText(/pip failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
