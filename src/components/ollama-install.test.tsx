/* Plan 61 — OllamaInstall component state-machine spec. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { OllamaInstall } from './ollama-install';

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

describe('OllamaInstall — detected', () => {
  it('renders the "Ollama is installed" pill when /detect returns installed:true', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/detect')) {
        return Promise.resolve(jsonResponse({ installed: true, version: 'ollama version 0.5.4' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<OllamaInstall />);
    await waitFor(() => {
      expect(screen.getByTestId('ollama-install-ready')).toBeInTheDocument();
    });
    expect(screen.getByText(/ollama version 0\.5\.4/i)).toBeInTheDocument();
  });
});

describe('OllamaInstall — not detected', () => {
  it('renders the "Install Ollama" button when /detect returns installed:false', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/detect')) {
        return Promise.resolve(jsonResponse({ installed: false, version: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<OllamaInstall />);
    await waitFor(() => {
      expect(screen.getByTestId('ollama-install-not-detected')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /install ollama/i })).toBeInTheDocument();
  });

  it('clicking "Install Ollama" POSTs /install and renders the job card', async () => {
    fetchMock.mockImplementation((url: string, init: RequestInit | undefined) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ installed: false, version: null }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              id: '1',
              status: 'downloading',
              platform: 'linux',
              arch: 'x64',
              bytesReceived: 0,
              bytesTotal: 1_000_000,
              manualInstallerPath: null,
              error: null,
              startedAt: 0,
              updatedAt: 0,
            },
            { status: 202 },
          ),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<OllamaInstall />);
    await waitFor(() => {
      expect(screen.getByTestId('ollama-install-not-detected')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /install ollama/i }));
    await waitFor(() => {
      const node = screen.getByTestId('ollama-install-job');
      expect(node).toBeInTheDocument();
      expect(node.getAttribute('data-job-status')).toBe('downloading');
    });
    expect(screen.getByTestId('ollama-install-progress-bar')).toBeInTheDocument();
  });

  it('renders the Windows-manual-installer banner when manualInstallerPath is set', async () => {
    fetchMock.mockImplementation((url: string, init: RequestInit | undefined) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ installed: false, version: null }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              id: '7',
              status: 'installing',
              platform: 'win32',
              arch: 'x64',
              bytesReceived: 100_000_000,
              bytesTotal: 100_000_000,
              manualInstallerPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\OllamaSetup.exe',
              error: null,
              startedAt: 0,
              updatedAt: 0,
            },
            { status: 202 },
          ),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<OllamaInstall />);
    await waitFor(() => {
      expect(screen.getByTestId('ollama-install-not-detected')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /install ollama/i }));
    await waitFor(() => {
      expect(screen.getByText(/double-click this file/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/OllamaSetup\.exe/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-check/i })).toBeInTheDocument();
  });

  it('renders the error card when the job ends in error state', async () => {
    fetchMock.mockImplementation((url: string, init: RequestInit | undefined) => {
      if (url.endsWith('/detect')) {
        return Promise.resolve(jsonResponse({ installed: false, version: null }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              id: '99',
              status: 'error',
              platform: 'linux',
              arch: 'x64',
              bytesReceived: 0,
              bytesTotal: null,
              manualInstallerPath: null,
              error: 'Failed to fetch installer (HTTP 502)',
              startedAt: 0,
              updatedAt: 0,
            },
            { status: 202 },
          ),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<OllamaInstall />);
    await waitFor(() => {
      expect(screen.getByTestId('ollama-install-not-detected')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /install ollama/i }));
    await waitFor(() => {
      expect(screen.getByText(/Install failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/HTTP 502/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('calls onInstalled when a poll flips status to installed', async () => {
    const onInstalled = vi.fn();
    fetchMock.mockImplementation((url: string, init: RequestInit | undefined) => {
      if (url.includes('/detect')) {
        return Promise.resolve(jsonResponse({ installed: false, version: null }));
      }
      if (url.endsWith('/install') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              id: '42',
              status: 'downloading',
              platform: 'linux',
              arch: 'x64',
              bytesReceived: 0,
              bytesTotal: 50_000_000,
              manualInstallerPath: null,
              error: null,
              startedAt: 0,
              updatedAt: 0,
            },
            { status: 202 },
          ),
        );
      }
      if (url.includes('/install/42')) {
        return Promise.resolve(
          jsonResponse({
            id: '42',
            status: 'installed',
            platform: 'linux',
            arch: 'x64',
            bytesReceived: 50_000_000,
            bytesTotal: 50_000_000,
            manualInstallerPath: null,
            error: null,
            startedAt: 0,
            updatedAt: 0,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<OllamaInstall onInstalled={onInstalled} />);
    await waitFor(() => {
      expect(screen.getByTestId('ollama-install-not-detected')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /install ollama/i }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });
});
