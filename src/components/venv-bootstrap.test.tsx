/* VenvBootstrap component state-machine spec. Mirrors kokoro-install.test.tsx —
   stubbed fetch drives detect/bootstrap/poll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VenvBootstrap } from './venv-bootstrap';

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

describe('VenvBootstrap', () => {
  it('renders the "Set up" button when pythonFound true and venv absent', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(
            jsonResponse({ state: 'no-venv', venvPresent: false, pythonFound: true, installed: false }),
          )
        : Promise.resolve(jsonResponse({})),
    );
    render(<VenvBootstrap />);
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-setup')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /set up the voice engine runtime/i })).toBeInTheDocument();
  });

  it('renders manual instructions when pythonFound false and venv absent', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(
            jsonResponse({ state: 'no-python', venvPresent: false, pythonFound: false, installed: false }),
          )
        : Promise.resolve(jsonResponse({})),
    );
    render(<VenvBootstrap />);
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-manual')).toBeInTheDocument(),
    );
    // decision-Z: both Windows and macOS/Linux instructions must be visible
    expect(screen.getByText(/py -3\.11/i)).toBeInTheDocument();
    expect(screen.getByText(/python3\.11 -m venv/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-check/i })).toBeInTheDocument();
  });

  it('renders the ready card when venvPresent', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/detect')
        ? Promise.resolve(
            jsonResponse({ state: 'ready', venvPresent: true, pythonFound: true, installed: true }),
          )
        : Promise.resolve(jsonResponse({})),
    );
    render(<VenvBootstrap />);
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-ready')).toBeInTheDocument(),
    );
    expect(screen.getByText(/voice engine runtime ready/i)).toBeInTheDocument();
  });

  it('clicking "Set up" POSTs bootstrap and renders the job progress card', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/detect')) {
        return Promise.resolve(
          jsonResponse({ state: 'no-venv', venvPresent: false, pythonFound: true, installed: false }),
        );
      }
      if (url.includes('/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Creating virtual environment', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<VenvBootstrap />);
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-setup')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-job')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Creating virtual environment/i)).toBeInTheDocument();
  });

  it('calls onBootstrapped when a poll flips to installed', async () => {
    const onBootstrapped = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/detect')) {
        return Promise.resolve(
          jsonResponse({ state: 'no-venv', venvPresent: false, pythonFound: true, installed: false }),
        );
      }
      if (url.includes('/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '42', status: 'installing', step: 'Installing packages…', error: null }),
        );
      }
      if (url.includes('/bootstrap/42')) {
        return Promise.resolve(
          jsonResponse({ id: '42', status: 'installed', step: null, error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<VenvBootstrap onBootstrapped={onBootstrapped} />);
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-setup')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(onBootstrapped).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/detect')) {
        return Promise.resolve(
          jsonResponse({ state: 'no-venv', venvPresent: false, pythonFound: true, installed: false }),
        );
      }
      if (url.includes('/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'error', step: null, error: 'pip install failed' }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<VenvBootstrap />);
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-setup')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() =>
      expect(screen.getByTestId('venv-bootstrap-error')).toBeInTheDocument(),
    );
    expect(screen.getByText(/pip install failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
