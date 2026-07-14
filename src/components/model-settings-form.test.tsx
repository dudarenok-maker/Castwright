/* #1641 — the admin Model settings form mirrors fe-49's analyzer-readiness
   tri-state badge (green = ready + backup / amber = ready, no backup / rose =
   needed), reading the SAME shared setup-readiness diagnosis the wizard uses. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within } from '@testing-library/react';
import { accountSlice } from '../store/account-slice';
import { ModelSettingsForm } from './model-settings-form';
import { api, type SetupReadiness, type BlockerDiagnosis } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getOllamaHealth: vi
      .fn()
      .mockResolvedValue({ status: 'reachable', url: '(mock)', models: [], pullable: [] }),
    getSetupReadiness: vi.fn(),
    putUserSettings: vi.fn(),
    putGeminiKey: vi.fn(),
  },
}));

/* Stub the raw-fetch installers so their mount-time /detect probes don't fire
   against an absent backend — this suite tests only the readiness badge. */
vi.mock('./ollama-install', () => ({
  OllamaInstall: () => <div data-testid="mock-ollama-install" />,
}));
vi.mock('./model-pull-status', () => ({
  ModelPullStatus: () => <div data-testid="mock-model-pull-status" />,
}));

const PASS: BlockerDiagnosis = { status: 'pass', cause: 'pass', message: '', remediation: '' };

function readinessWith(analyzer: BlockerDiagnosis): SetupReadiness {
  return {
    ready: analyzer.status !== 'fail',
    completedAt: null,
    blockers: { sidecar: PASS, ffmpeg: PASS, tts: PASS, analyzer },
    info: { gpu: '' },
  };
}

function renderForm() {
  const store = configureStore({ reducer: { account: accountSlice.reducer } });
  return render(
    <Provider store={store}>
      <ModelSettingsForm embedded />
    </Provider>,
  );
}

describe('ModelSettingsForm — analyzer readiness badge (fe-49 mirror #1641)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a green "Analyzer ready" chip when the analyzer passes', async () => {
    vi.mocked(api.getSetupReadiness).mockResolvedValue(readinessWith(PASS));
    renderForm();
    const badge = await screen.findByTestId('admin-analyzer-readiness');
    expect(within(badge).getByText('Analyzer ready')).toBeInTheDocument();
    // pass carries no message line.
    expect(within(badge).queryByText(/no backup|needed/i)).toBeNull();
  });

  it('shows an amber "no backup" chip on warn, with the message', async () => {
    vi.mocked(api.getSetupReadiness).mockResolvedValue(
      readinessWith({
        status: 'warn',
        cause: 'pass',
        message: 'Analyzer ready — no backup analyzer configured.',
        remediation: '',
      }),
    );
    renderForm();
    const badge = await screen.findByTestId('admin-analyzer-readiness');
    expect(within(badge).getByText('Analyzer ready — no backup')).toBeInTheDocument();
    expect(within(badge).getByText(/no backup analyzer configured/i)).toBeInTheDocument();
    expect(badge.querySelector('[data-blocker-status="warn"]')).not.toBeNull();
  });

  it('shows a rose "Analyzer needed" chip + remediation message on fail', async () => {
    vi.mocked(api.getSetupReadiness).mockResolvedValue(
      readinessWith({
        status: 'fail',
        cause: 'no-gemini-key',
        message: 'No Gemini API key is configured.',
        remediation: 'Enter a Gemini API key in Advanced Settings.',
      }),
    );
    renderForm();
    const badge = await screen.findByTestId('admin-analyzer-readiness');
    expect(within(badge).getByText('Analyzer needed')).toBeInTheDocument();
    expect(within(badge).getByText('No Gemini API key is configured.')).toBeInTheDocument();
    expect(badge.querySelector('[data-blocker-status="fail"]')).not.toBeNull();
  });
});
