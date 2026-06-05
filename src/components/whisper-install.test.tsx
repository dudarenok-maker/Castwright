/* WhisperInstall component state-machine spec (srv-31). Mirrors qwen-install.test
   — stubbed fetch drives detect/install/poll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WhisperInstall } from './whisper-install';

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

describe('WhisperInstall', () => {
  it('renders the "installed" pill when /detect reports installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'ready', installed: true }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<WhisperInstall />);
    await waitFor(() => expect(screen.getByTestId('whisper-install-ready')).toBeInTheDocument());
    expect(screen.getByText(/Whisper ASR is installed/i)).toBeInTheDocument();
  });

  it('renders the install card when /detect reports not-installed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }))
        : Promise.resolve(jsonResponse({})),
    );
    render(<WhisperInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('whisper-install-not-detected')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /install whisper asr/i })).toBeInTheDocument();
  });

  it('clicking Install POSTs /install and renders the job card with the step text', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Installing faster-whisper', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<WhisperInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('whisper-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install whisper asr/i }));
    await waitFor(() => expect(screen.getByTestId('whisper-install-job')).toBeInTheDocument());
    expect(screen.getByText(/Installing faster-whisper/i)).toBeInTheDocument();
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
    render(<WhisperInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('whisper-install-not-detected')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /install whisper asr/i }));
    await waitFor(() => expect(screen.getByTestId('whisper-install-error')).toBeInTheDocument());
    expect(screen.getByText(/pip failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
