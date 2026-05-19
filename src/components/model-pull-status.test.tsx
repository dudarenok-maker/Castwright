/* Plan 61 — ModelPullStatus per-row state machine. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ModelPullStatus } from './model-pull-status';

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

const PULLABLE = ['qwen3.5:4b', 'llama3.1:8b'] as const;

describe('ModelPullStatus — render', () => {
  it('marks present models with the on-disk pill and disables their Pull button', () => {
    render(
      <ModelPullStatus
        pullableModels={PULLABLE}
        health={{
          status: 'reachable',
          url: 'http://localhost:11434',
          models: ['qwen3.5:4b'],
          expectedModel: 'qwen3.5:4b',
        }}
      />,
    );
    const row = screen.getByTestId('model-row-qwen3.5:4b');
    expect(row).toHaveTextContent(/on disk/i);
    expect(row).toHaveTextContent(/configured default/i);
    /* Pulled button is rendered but disabled. */
    const btn = screen.getByTestId('model-pull-qwen3.5:4b') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/pulled/i);
  });

  it('shows "Not pulled yet" for absent models and enables Pull only when daemon is reachable', () => {
    render(
      <ModelPullStatus
        pullableModels={PULLABLE}
        health={{
          status: 'reachable',
          url: 'http://localhost:11434',
          models: [],
          expectedModel: 'qwen3.5:4b',
        }}
      />,
    );
    const row = screen.getByTestId('model-row-llama3.1:8b');
    expect(row).toHaveTextContent(/not pulled yet/i);
    expect(screen.getByTestId('model-pull-llama3.1:8b')).not.toBeDisabled();
  });

  it('disables Pull and surfaces an unreachable banner when the daemon is unreachable', () => {
    render(
      <ModelPullStatus
        pullableModels={PULLABLE}
        health={{ status: 'unreachable', url: '', error: 'ECONNREFUSED' }}
      />,
    );
    expect(screen.getByText(/local ollama daemon is unreachable/i)).toBeInTheDocument();
    expect(screen.getByTestId('model-pull-qwen3.5:4b')).toBeDisabled();
  });
});

describe('ModelPullStatus — pull flow', () => {
  it('clicking Pull POSTs /api/ollama/pull and renders the progress bar', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/ollama/pull' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              id: '1',
              model: 'qwen3.5:4b',
              status: 'pulling',
              lastStatusMessage: 'pulling manifest',
              bytesReceived: 0,
              bytesTotal: 1_000_000,
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
    render(
      <ModelPullStatus
        pullableModels={PULLABLE}
        health={{
          status: 'reachable',
          url: 'http://localhost:11434',
          models: [],
          expectedModel: 'qwen3.5:4b',
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('model-pull-qwen3.5:4b'));
    await waitFor(() => {
      expect(screen.getByTestId('model-pull-progress-qwen3.5:4b')).toBeInTheDocument();
    });
  });

  it('renders an error card if the pull POST 400s with an allowlist error', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/ollama/pull' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ error: "Model 'foo:9b' is not in the allowlist" }, { status: 400 }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    /* We render with a fake "foo:9b" in the pullable list to drive the
       click — the component normally trusts the prop. */
    render(
      <ModelPullStatus
        pullableModels={['foo:9b'] as readonly string[]}
        health={{
          status: 'reachable',
          url: 'http://localhost:11434',
          models: [],
          expectedModel: 'qwen3.5:4b',
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('model-pull-foo:9b'));
    await waitFor(() => {
      expect(screen.getByText(/not in the allowlist/i)).toBeInTheDocument();
    });
  });
});

describe('ModelPullStatus — refresh', () => {
  it('clicking "Refresh available models" POSTs /api/ollama/refresh and updates the rows', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/ollama/refresh' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            status: 'reachable',
            url: 'http://localhost:11434',
            models: ['qwen3.5:4b'],
            expectedModel: 'qwen3.5:4b',
            modelPulled: true,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <ModelPullStatus
        pullableModels={PULLABLE}
        health={{
          status: 'reachable',
          url: 'http://localhost:11434',
          models: [],
          expectedModel: 'qwen3.5:4b',
        }}
      />,
    );
    /* Pre-refresh: qwen row shows "Not pulled yet". */
    expect(screen.getByTestId('model-row-qwen3.5:4b')).toHaveTextContent(/not pulled yet/i);
    fireEvent.click(screen.getByTestId('model-pull-refresh'));
    await waitFor(() => {
      expect(screen.getByTestId('model-row-qwen3.5:4b')).toHaveTextContent(/on disk/i);
    });
  });
});
