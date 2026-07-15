/* VenvBootstrap — CONTROLLED card spec. The idle state is driven by the `status`
   prop; a stubbed fetch drives only the bootstrap-job POST/poll. */

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

describe('VenvBootstrap — controlled idle states', () => {
  it('renders the "Set up" button when pythonFound true and runtime absent', () => {
    render(
      <VenvBootstrap status={{ installedOnDisk: false, pythonFound: true, process: 'down' }} />,
    );
    expect(screen.getByTestId('venv-bootstrap-setup')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /set up the voice engine runtime/i }),
    ).toBeInTheDocument();
  });

  it('renders manual instructions when pythonFound false and runtime absent', () => {
    render(
      <VenvBootstrap status={{ installedOnDisk: false, pythonFound: false, process: 'down' }} />,
    );
    expect(screen.getByTestId('venv-bootstrap-manual')).toBeInTheDocument();
    // decision-Z: both Windows and macOS/Linux instructions must be visible
    expect(screen.getByText(/py -3\.11/i)).toBeInTheDocument();
    expect(screen.getByText(/python3\.11 -m venv/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-check/i })).toBeInTheDocument();
  });

  it('renders the ready card when installedOnDisk', () => {
    render(
      <VenvBootstrap status={{ installedOnDisk: true, pythonFound: true, process: 'ready' }} />,
    );
    expect(screen.getByTestId('venv-bootstrap-ready')).toBeInTheDocument();
    expect(screen.getByText(/voice engine runtime ready/i)).toBeInTheDocument();
  });

  it('Re-check on the ready card calls onBootstrapped', () => {
    const onBootstrapped = vi.fn();
    render(
      <VenvBootstrap
        status={{ installedOnDisk: true, pythonFound: true, process: 'ready' }}
        onBootstrapped={onBootstrapped}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /re-check/i }));
    expect(onBootstrapped).toHaveBeenCalledTimes(1);
  });
});

describe('VenvBootstrap — bootstrap job', () => {
  it('clicking "Set up" POSTs bootstrap and renders the job progress card', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '1', status: 'installing', step: 'Creating virtual environment', error: null }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <VenvBootstrap status={{ installedOnDisk: false, pythonFound: true, process: 'down' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(screen.getByTestId('venv-bootstrap-job')).toBeInTheDocument());
    expect(screen.getByText(/Creating virtual environment/i)).toBeInTheDocument();
  });

  it('calls onBootstrapped when a poll flips to installed', async () => {
    const onBootstrapped = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ id: '42', status: 'installing', step: 'Installing packages…', error: null }),
        );
      }
      if (url.includes('/bootstrap/42')) {
        return Promise.resolve(jsonResponse({ id: '42', status: 'installed', step: null, error: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <VenvBootstrap
        status={{ installedOnDisk: false, pythonFound: true, process: 'down' }}
        onBootstrapped={onBootstrapped}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(onBootstrapped).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('renders the error card with a retry button on a failed job', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'error', step: null, error: 'pip install failed' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <VenvBootstrap status={{ installedOnDisk: false, pythonFound: true, process: 'down' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(screen.getByTestId('venv-bootstrap-error')).toBeInTheDocument());
    expect(screen.getByText(/pip install failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
