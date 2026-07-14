/* StepAnalysis composition spec — fe-49.
   Verifies the local-first ordering (Ollama section before Gemini section),
   the pull dead-end is closed (ModelPullStatus renders inline), and the
   tri-state badge is message-only (no BlockerFixAction). Uses a real
   ModelPullStatus/OllamaInstall (not stubbed) so global fetch is mocked for
   their raw calls, matching the pattern in model-pull-status.test.tsx /
   ollama-install.test.tsx. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { accountSlice } from '../../store/account-slice';
import type { SetupReadiness } from '../../lib/api';

// ── mock api.getOllamaHealth (used directly by StepAnalysis + the
//    fetchAnalyzerModels thunk) ──────────────────────────────────────────────

const getOllamaHealthMock = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      getOllamaHealth: () => getOllamaHealthMock(),
    },
  };
});

import { StepAnalysis } from './step-analysis';

// ── raw fetch mock for the leaf controls (OllamaInstall /detect,
//    ModelPullStatus /refresh + /pull) ───────────────────────────────────────

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
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/detect')) {
      return Promise.resolve(jsonResponse({ installed: true, version: 'ollama version 0.5.4' }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  getOllamaHealthMock.mockReset();
  getOllamaHealthMock.mockResolvedValue({
    status: 'reachable',
    url: 'http://localhost:11434',
    models: [],
    pullable: ['qwen3.5:4b'],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const readiness: SetupReadiness = {
  ready: true,
  completedAt: null,
  blockers: {
    sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    analyzer: {
      status: 'warn',
      cause: 'pass',
      message: 'Analyzer ready — no backup analyzer configured.',
      remediation: '',
    },
  },
  info: { gpu: '' },
};

function makeStore(
  preloaded: Partial<ReturnType<typeof accountSlice.getInitialState>> = {},
) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...preloaded,
      } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}

describe('StepAnalysis', () => {
  it('renders Local-via-Ollama first, then Online-via-Gemini, with the tri-state badge', async () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <StepAnalysis readiness={readiness} onRefetch={() => {}} />
      </Provider>,
    );

    // Ollama section (dead-end closed): the pull-status list is present.
    await waitFor(() => {
      expect(screen.getByTestId('model-pull-status')).toBeInTheDocument();
    });
    // Gemini card present.
    expect(screen.getAllByText(/gemini/i).length).toBeGreaterThan(0);
    // Tri-state badge shows the warn (yellow) label, message-only, no fix button.
    expect(screen.getByText(/no backup analyzer configured/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open advanced settings/i })).toBeNull();
    // Local section comes before the Gemini section in DOM order.
    const local = screen.getByText(/local via ollama/i);
    const gemini = screen.getByText(/online via gemini/i);
    expect(local.compareDocumentPosition(gemini) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
