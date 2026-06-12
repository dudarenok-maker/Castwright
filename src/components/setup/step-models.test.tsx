/* StepModels composition spec.
   Uses vi.mock to stub the heavy child components so assertions focus on
   composition (correct sections rendered, callbacks wired), not on each
   child's internal state machine. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { accountSlice } from '../../store/account-slice';
import type { SetupReadiness } from '../../lib/api';
import { StepModels } from './step-models';

// ── stub child components ──────────────────────────────────────────────────

vi.mock('../venv-bootstrap', () => ({
  VenvBootstrap: ({ onBootstrapped }: { onBootstrapped?: () => void }) => (
    <div data-testid="stub-venv-bootstrap" data-has-cb={typeof onBootstrapped}>
      VenvBootstrap stub
    </div>
  ),
}));

vi.mock('../kokoro-install', () => ({
  KokoroInstall: ({ onInstalled }: { onInstalled?: () => void }) => (
    <div data-testid="stub-kokoro-install" data-has-cb={typeof onInstalled}>
      KokoroInstall stub
    </div>
  ),
}));

vi.mock('../qwen-install', () => ({
  QwenInstall: ({ onInstalled }: { onInstalled?: () => void }) => (
    <div data-testid="stub-qwen-install" data-has-cb={typeof onInstalled}>
      QwenInstall stub
    </div>
  ),
}));

vi.mock('../coqui-install', () => ({
  CoquiInstall: ({ onInstalled }: { onInstalled?: () => void }) => (
    <div data-testid="stub-coqui-install" data-has-cb={typeof onInstalled}>
      CoquiInstall stub
    </div>
  ),
}));

vi.mock('../ollama-install', () => ({
  OllamaInstall: ({ onInstalled }: { onInstalled?: () => void }) => (
    <div data-testid="stub-ollama-install" data-has-cb={typeof onInstalled}>
      OllamaInstall stub
    </div>
  ),
}));

vi.mock('../account-forms', () => ({
  GeminiKeyField: ({
    status,
    onSave,
  }: {
    status: 'set' | 'unset';
    onSave: (k: string | null) => unknown;
  }) => (
    <div data-testid="stub-gemini-key-field" data-status={status} data-has-cb={typeof onSave}>
      GeminiKeyField stub
    </div>
  ),
}));

// ── helpers ────────────────────────────────────────────────────────────────

function makeStore() {
  return configureStore({
    reducer: { account: accountSlice.reducer },
  });
}

const notReadyReadiness: SetupReadiness = {
  ready: false,
  completedAt: null,
  blockers: { sidecar: 'fail', ffmpeg: 'pass', tts: 'fail', analyzer: 'fail' },
  info: { gpu: 'none' },
};

const readyReadiness: SetupReadiness = {
  ready: true,
  completedAt: '2026-01-01T00:00:00Z',
  blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
  info: { gpu: 'NVIDIA A100' },
};

function renderStep(readiness: SetupReadiness = notReadyReadiness) {
  const store = makeStore();
  const onRefetch = vi.fn();
  render(
    <Provider store={store}>
      <StepModels readiness={readiness} onRefetch={onRefetch} />
    </Provider>,
  );
  return { store, onRefetch };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('StepModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "Models" heading', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: /models/i })).toBeInTheDocument();
  });

  it('renders the TTS section with VenvBootstrap and KokoroInstall stubs', () => {
    renderStep();
    expect(screen.getByTestId('stub-venv-bootstrap')).toBeInTheDocument();
    expect(screen.getByTestId('stub-kokoro-install')).toBeInTheDocument();
  });

  it('passes a function callback to VenvBootstrap (onBootstrapped)', () => {
    renderStep();
    expect(screen.getByTestId('stub-venv-bootstrap').dataset.hasCb).toBe('function');
  });

  it('passes a function callback to KokoroInstall (onInstalled)', () => {
    renderStep();
    expect(screen.getByTestId('stub-kokoro-install').dataset.hasCb).toBe('function');
  });

  it('renders the Analyzer section with GeminiKeyField stub', () => {
    renderStep();
    expect(screen.getByTestId('stub-gemini-key-field')).toBeInTheDocument();
  });

  it('passes a function callback to GeminiKeyField (onSave)', () => {
    renderStep();
    expect(screen.getByTestId('stub-gemini-key-field').dataset.hasCb).toBe('function');
  });

  it('renders the alternative engines toggle/details element', () => {
    renderStep();
    // Details/summary for alternative engines should be in the document
    const details = document.querySelector('details');
    expect(details).toBeInTheDocument();
  });

  it('Qwen and Coqui stubs are present inside alternatives (hidden by default)', () => {
    renderStep();
    // They are rendered (in the DOM) even if not visible — their container is collapsed
    expect(screen.getByTestId('stub-qwen-install')).toBeInTheDocument();
    expect(screen.getByTestId('stub-coqui-install')).toBeInTheDocument();
  });

  it('OllamaInstall stub is present inside the local analyzer toggle', () => {
    renderStep();
    expect(screen.getByTestId('stub-ollama-install')).toBeInTheDocument();
  });

  it('passes a function callback to QwenInstall (onInstalled)', () => {
    renderStep();
    expect(screen.getByTestId('stub-qwen-install').dataset.hasCb).toBe('function');
  });

  it('passes a function callback to CoquiInstall (onInstalled)', () => {
    renderStep();
    expect(screen.getByTestId('stub-coqui-install').dataset.hasCb).toBe('function');
  });

  it('passes a function callback to OllamaInstall (onInstalled)', () => {
    renderStep();
    expect(screen.getByTestId('stub-ollama-install').dataset.hasCb).toBe('function');
  });

  it('shows sidecar + tts blocker status badges', () => {
    renderStep(notReadyReadiness);
    // Both sidecar and tts are 'fail' in notReadyReadiness
    const failBadges = document.querySelectorAll('[data-blocker-status="fail"]');
    expect(failBadges.length).toBeGreaterThanOrEqual(2);
  });

  it('shows pass badges when all blockers pass', () => {
    renderStep(readyReadiness);
    const passBadges = document.querySelectorAll('[data-blocker-status="pass"]');
    expect(passBadges.length).toBeGreaterThanOrEqual(2);
  });

  it('reflects the account apiKeyStatus in GeminiKeyField status prop', () => {
    renderStep();
    // Initial store has apiKeyStatus:'unset'
    expect(screen.getByTestId('stub-gemini-key-field').dataset.status).toBe('unset');
  });
});
