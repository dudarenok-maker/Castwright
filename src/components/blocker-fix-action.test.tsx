import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BlockerFixAction } from './blocker-fix-action';
import type { BlockerDiagnosis } from '../lib/api';

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

const VENV_MISSING: BlockerDiagnosis = {
  status: 'fail', cause: 'venv-missing',
  message: 'Voice engine runtime not set up.', remediation: 'Set it up.',
  action: { kind: 'venv-bootstrap', label: 'Set up the voice engine runtime' },
};

describe('BlockerFixAction', () => {
  it('renders nothing actionable for a diagnosis with no action (just remediation text elsewhere)', () => {
    const { container } = render(
      <BlockerFixAction diagnosis={{ status: 'fail', cause: 'ffmpeg-missing', message: 'x', remediation: 'y' }} onDone={() => {}} />,
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('venv-bootstrap: clicking POSTs the bootstrap job, polls, and calls onDone on completion', async () => {
    const onDone = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/setup/venv/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'bootstrapping', step: null, error: null }));
      }
      if (url.includes('/api/setup/venv/bootstrap/1')) {
        return Promise.resolve(jsonResponse({ id: '1', status: 'installed', step: null, error: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<BlockerFixAction diagnosis={VENV_MISSING} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('sidecar-restart: clicking POSTs /api/sidecar/restart and calls onDone', async () => {
    const onDone = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    render(
      <BlockerFixAction
        diagnosis={{ status: 'fail', cause: 'supervisor-exhausted', message: 'x', remediation: 'y', action: { kind: 'sidecar-restart', label: 'Reset & restart voice engine' } }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /reset & restart voice engine/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/sidecar/restart', expect.objectContaining({ method: 'POST' }));
  });

  it('ollama-pull: completes on the "pulled" terminal status, not just "installed"', async () => {
    const onDone = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/ollama/pull') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '9', status: 'pulling', step: null, error: null }));
      }
      if (url.includes('/api/ollama/pull/9')) {
        return Promise.resolve(jsonResponse({ id: '9', status: 'pulled', step: null, error: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <BlockerFixAction
        diagnosis={{ status: 'fail', cause: 'model-not-pulled', message: 'x', remediation: 'y', action: { kind: 'ollama-pull', label: 'Pull qwen3.5:9b', params: { model: 'qwen3.5:9b' } } }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /pull qwen3\.5:9b/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('navigate: clicking sets window.location.hash and calls onDone', () => {
    const onDone = vi.fn();
    render(
      <BlockerFixAction
        diagnosis={{ status: 'fail', cause: 'unreachable-no-supervisor', message: 'x', remediation: 'y', action: { kind: 'navigate', label: 'Open Model Manager', href: '#/models' } }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /open model manager/i }));
    expect(window.location.hash).toBe('#/models');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('surfaces the job error inline on failure', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/setup/venv/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'bootstrapping', step: null, error: null }));
      }
      if (url.includes('/api/setup/venv/bootstrap/1')) {
        return Promise.resolve(jsonResponse({ id: '1', status: 'error', step: null, error: 'pip install failed' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<BlockerFixAction diagnosis={VENV_MISSING} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(screen.getByText(/pip install failed/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it('unmounting mid-poll stops the poll loop instead of calling onDone in the background', async () => {
    // PR #1252 mandatory-review finding: pollJob's recursive setTimeout chain
    // had no unmount cleanup, unlike venv-bootstrap.tsx's pattern this
    // component claims to mirror. Before the fix, unmounting while a poll was
    // scheduled left the timer running — the next tick would still fetch and
    // call onDone (a caller-owned callback) on an unmounted component.
    const onDone = vi.fn();
    let pollCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/setup/venv/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'bootstrapping', step: null, error: null }));
      }
      if (url.includes('/api/setup/venv/bootstrap/1')) {
        pollCount += 1;
        return Promise.resolve(jsonResponse({ id: '1', status: 'installed', step: null, error: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const { unmount } = render(<BlockerFixAction diagnosis={VENV_MISSING} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    // POLL_MS is 1500ms — unmount well before the first scheduled poll fires.
    await new Promise((r) => setTimeout(r, 200));
    unmount();
    // Wait past when the poll would have fired if the timer weren't cleared.
    await new Promise((r) => setTimeout(r, 2000));
    expect(pollCount).toBe(0);
    expect(onDone).not.toHaveBeenCalled();
  }, 10000);

  it('ollama-install: shows a Recheck prompt (not endless polling) when the job needs a manual GUI install', async () => {
    const onDone = vi.fn();
    // Matches the REAL route's shape (install-bootstrap.ts): the POST returns
    // synchronously at 'detecting' with no manualInstallerPath yet — the path
    // only appears on a LATER poll, once the background job reaches the
    // win32 manual-install branch. A test that puts manualInstallerPath
    // directly on the POST response exercises runJobAction's branch, which
    // never actually runs in production — only pollJob's branch does.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/ollama/install') && init?.method === 'POST' && !url.includes('/recheck')) {
        return Promise.resolve(jsonResponse({ id: '5', status: 'detecting', step: null, error: null, manualInstallerPath: null }));
      }
      if (url.includes('/api/ollama/install/5/recheck')) {
        return Promise.resolve(jsonResponse({ id: '5', status: 'installed', step: null, error: null }));
      }
      if (url.includes('/api/ollama/install/5')) {
        return Promise.resolve(jsonResponse({ id: '5', status: 'installing', step: null, error: null, manualInstallerPath: 'C:\\Users\\x\\Downloads\\OllamaSetup.exe' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <BlockerFixAction
        diagnosis={{ status: 'fail', cause: 'ollama-unreachable', message: 'x', remediation: 'y', action: { kind: 'ollama-install', label: 'Install Ollama' } }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /install ollama/i }));
    // The manualInstallerPath only appears on the poll (POLL_MS=1500 later),
    // not on the initial POST response — give waitFor enough time to see it.
    await waitFor(() => expect(screen.getByText(/OllamaSetup\.exe/i)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText(/working…/i)).toBeNull(); // not stuck polling
    fireEvent.click(screen.getByRole('button', { name: /recheck/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});
