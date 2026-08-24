/* #1641 — the admin Model settings form mirrors fe-49's analyzer-readiness
   tri-state badge (green = ready + backup / amber = ready, no backup / rose =
   needed), reading the SAME shared setup-readiness diagnosis the wizard uses. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
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
    info: { gpu: '', vramTotalMb: null },
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

describe('ModelSettingsForm — Cloud fallback toggle (Part 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSetupReadiness).mockResolvedValue(readinessWith(PASS));
  });

  it('defaults the Cloud fallback toggle to ON (opt-out)', async () => {
    renderForm();
    const toggle = (await screen.findByTestId('account-allow-cloud-fallback')) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('turning it off and saving PATCHes allowCloudFallback:false', async () => {
    vi.mocked(api.putUserSettings).mockImplementation(
      async (patch) =>
        ({ ...accountSlice.getInitialState(), ...(patch as object) }) as never,
    );
    renderForm();
    const toggle = (await screen.findByTestId('account-allow-cloud-fallback')) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(vi.mocked(api.putUserSettings)).toHaveBeenCalledWith(
        expect.objectContaining({ allowCloudFallback: false }),
      );
    });
  });
});

describe('ModelSettingsForm — Voice engine URL sublabel (#2632 N22)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSetupReadiness).mockResolvedValue(readinessWith(PASS));
  });

  it('never instructs the user to leave the field blank — sidecarUrl is required by the schema and blank 400s the whole save', async () => {
    renderForm();
    const input = await screen.findByTestId('account-sidecar-url');
    const fieldText = input.closest('label')?.textContent ?? '';
    expect(fieldText.toLowerCase()).not.toMatch(/leave blank/);
  });

  // #2632 N43 — the test above (and the one below) are negative-only and pass
  // vacuously if the sublabel prop is deleted outright, which would ship the
  // field with NO guidance at all, including the "don't leave it blank" line
  // RELEASE_NOTES.md:186 advertises. Anchor the copy that must actually be
  // present, not just the jargon that must be absent.
  it('does instruct the user not to leave the field blank', async () => {
    renderForm();
    const input = await screen.findByTestId('account-sidecar-url');
    const fieldText = input.closest('label')?.textContent ?? '';
    expect(fieldText).toMatch(/do not leave it blank/i);
  });

  // #2632 N37 — the sublabel used to claim the value shown below (the
  // input's placeholder) is "derived from LOCAL_TTS_PORT". The placeholder
  // is a hardcoded literal, never updated from LOCAL_TTS_PORT, and hidden
  // once the field is populated — the sentence was false, and falsest in
  // exactly the per-worktree scenario #2632 exists for. It's also shipped
  // copy: "LOCAL_TTS_PORT" / "this checkout" are repo jargon a packaged-app
  // end user has never seen.
  it('does not claim the value below is derived from LOCAL_TTS_PORT, and avoids repo jargon', async () => {
    renderForm();
    const input = await screen.findByTestId('account-sidecar-url');
    const fieldText = input.closest('label')?.textContent ?? '';
    expect(fieldText).not.toMatch(/shown below/i);
    expect(fieldText).not.toMatch(/LOCAL_TTS_PORT/);
    expect(fieldText).not.toMatch(/this checkout/i);
  });
});
