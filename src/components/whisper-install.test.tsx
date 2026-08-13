/* WhisperInstall component state-machine spec (srv-31). Mirrors qwen-install.test
   — stubbed fetch drives detect/install/poll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WhisperInstall } from './whisper-install';
import { api } from '../lib/api';
import type { ConfigResponse } from '../lib/types';

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

  it('names the CONFIGURED qa.asr.model, not a hard-coded "base" (PR #2008 re-review, m1)', async () => {
    /* Before this fix the card unconditionally said "the `base` model" —
       wrong as soon as the Major-1 fix made the installer actually fetch a
       UI-configured, non-default model. */
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/detect')) {
        return Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }));
      }
      if (url.includes('/api/config')) {
        return Promise.resolve(jsonResponse({ values: { 'qa.asr.model': { effective: 'small' } } }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<WhisperInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('whisper-install-not-detected')).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByText('small')).toBeInTheDocument());
    expect(screen.queryByText('base')).not.toBeInTheDocument();
  });

  it('falls back to the registry default "base" when /api/config has no qa.asr.model value', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }))
        : Promise.resolve(jsonResponse({})), // /api/config falls through here too
    );
    render(<WhisperInstall />);
    await waitFor(() =>
      expect(screen.getByTestId('whisper-install-not-detected')).toBeInTheDocument(),
    );
    expect(screen.getByText('base')).toBeInTheDocument();
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

  describe('#2344 — routed through api.getConfig(), not a raw fetch', () => {
    it('reads the configured qa.asr.model via api.getConfig(), not a direct fetch("/api/config")', async () => {
      fetchMock.mockImplementation((url: string) =>
        url.includes('/detect')
          ? Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }))
          : Promise.resolve(jsonResponse({})),
      );
      const getConfigSpy = vi.spyOn(api, 'getConfig').mockResolvedValue({
        groups: [],
        descriptors: [],
        values: { 'qa.asr.model': { key: 'qa.asr.model', effective: 'medium', source: 'override', locked: false, overridden: true } },
        restartPending: false,
        cudaEnvShadow: false,
      } as ConfigResponse);
      render(<WhisperInstall />);
      await waitFor(() =>
        expect(screen.getByTestId('whisper-install-not-detected')).toBeInTheDocument(),
      );
      await waitFor(() => expect(screen.getByText('medium')).toBeInTheDocument());
      expect(getConfigSpy).toHaveBeenCalledTimes(1);
      // The old direct-fetch implementation would have hit fetch('/api/config') —
      // confirm nothing under this URL was ever asked of the raw fetch stub.
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/config'));
      getConfigSpy.mockRestore();
    });

    it('preserves the best-effort swallow: a rejected api.getConfig() keeps the registry-default label instead of erroring the card (PR #2008 review m1)', async () => {
      /* #2348 review finding 6: the DOM assertions below (label survives,
         no error card) still pass even if the component's own
         `.catch(() => {})` is deleted — they'd pass just as happily with
         the rejection left dangling as an unhandled promise rejection.
         Without the onUnhandled assertion at the end, this test is red
         only via Vitest's own global unhandled-rejection reporter (which a
         `dangerouslyIgnoreUnhandledErrors` config would silence), not via
         anything this test itself checks. Registering a listener and
         asserting on it directly makes the test own its own red. */
      const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
      try {
        fetchMock.mockImplementation((url: string) =>
          url.includes('/detect')
            ? Promise.resolve(jsonResponse({ state: 'not-installed', installed: false }))
            : Promise.resolve(jsonResponse({})),
        );
        // realGetConfig throws (rather than resolving null) on a non-ok response
        // — this simulates exactly that shape, reaching the component's own
        // .catch(() => {}) rather than an unhandled rejection or a crashed card.
        const getConfigSpy = vi
          .spyOn(api, 'getConfig')
          .mockRejectedValue(new Error('Config fetch failed (500): boom'));
        render(<WhisperInstall />);
        await waitFor(() =>
          expect(screen.getByTestId('whisper-install-not-detected')).toBeInTheDocument(),
        );
        // Default label ('base') survives; no error surfaces on the card.
        expect(screen.getByText('base')).toBeInTheDocument();
        expect(screen.queryByTestId('whisper-install-error')).not.toBeInTheDocument();
        // Give the microtask/macrotask queue a turn so a dangling rejection
        // (if the .catch were missing) has actually surfaced as unhandled
        // before we check.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onUnhandled).not.toHaveBeenCalled();
        getConfigSpy.mockRestore();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });
});
