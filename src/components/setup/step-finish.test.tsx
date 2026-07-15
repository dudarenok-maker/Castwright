/* StepFinish spec — fs-21 wave 3.
   Verifies the two-tier smoke test UI and the finish button, plus the
   library-restart reminder (fs-21 first-run library location, Task 5). */

import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { SetupReadiness, SmokeTestResult } from '../../lib/api';
import { accountSlice } from '../../store/account-slice';
import { StepFinish } from './step-finish';

// ── api mock ─────────────────────────────────────────────────────────────────

vi.mock('../../lib/api', () => ({
  api: {
    runSmokeTest: vi.fn(),
  },
}));

// Import after mock so the component sees the stub.
import { api } from '../../lib/api';
const mockRunSmokeTest = vi.mocked(api.runSmokeTest);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReadiness(overrides: Partial<SetupReadiness> = {}): SetupReadiness {
  return {
    ready: true,
    completedAt: null,
    blockers: {
      sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    },
    info: { gpu: 'cuda · 1.2 / 8.0 GB' },
    ...overrides,
  };
}

function okResult(overrides: Partial<SmokeTestResult> = {}): SmokeTestResult {
  return { ok: true, url: 'http://localhost/smoke.wav', analyzerDetail: 'gemma-4-31b-it', ...overrides };
}

function failResult(overrides: Partial<SmokeTestResult> = {}): SmokeTestResult {
  return { ok: false, stage: 'tts', error: 'sidecar unreachable', ...overrides };
}

// StepFinish now reads redux (account.workspaceDirOverride, for the library
// restart reminder), so every render needs a Provider — mirrors
// step-defaults.test.tsx:53-65 / step-library.test.tsx.
type AccountPreload = Partial<ReturnType<typeof accountSlice.getInitialState>>;
function makeStore(over: AccountPreload = {}) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: { ...accountSlice.getInitialState(), ...over } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}

function renderFinish(ui: ReactElement, over: AccountPreload = {}) {
  return render(<Provider store={makeStore(over)}>{ui}</Provider>);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('StepFinish', () => {
  beforeEach(() => {
    mockRunSmokeTest.mockReset();
  });

  it('renders the finish-step heading', () => {
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /ready to perform/i })).toBeInTheDocument();
  });

  it('renders an ENABLED smoke-test button (not the placeholder disabled state)', () => {
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    const smokeBtn = screen.getByTestId('smoke-test-placeholder');
    expect(smokeBtn).not.toBeDisabled();
  });

  it('does NOT render the old "next release" placeholder copy', () => {
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(
      screen.queryByText(/arrives in the next release/i),
    ).not.toBeInTheDocument();
  });

  it('renders the finish button', () => {
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.getByRole('button', { name: /finish & open my library/i })).toBeInTheDocument();
  });

  it('calls onFinish when the finish button is clicked', () => {
    const onFinish = vi.fn();
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={onFinish} />);
    fireEvent.click(screen.getByRole('button', { name: /finish & open my library/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('clicking the smoke-test button calls api.runSmokeTest', async () => {
    mockRunSmokeTest.mockResolvedValue(okResult());
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByTestId('smoke-test-placeholder'));
    await waitFor(() => expect(mockRunSmokeTest).toHaveBeenCalledTimes(1));
  });

  it('shows an <audio> element and analyzer detail on ok result', async () => {
    mockRunSmokeTest.mockResolvedValue(okResult());
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByTestId('smoke-test-placeholder'));
    await waitFor(() =>
      expect(screen.getByTestId('smoke-audio')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('smoke-audio')).toHaveAttribute('src', 'http://localhost/smoke.wav');
    expect(screen.getByText(/gemma-4-31b-it/i)).toBeInTheDocument();
  });

  it('shows the error and stage on a failed result', async () => {
    mockRunSmokeTest.mockResolvedValue(failResult());
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByTestId('smoke-test-placeholder'));
    await waitFor(() =>
      expect(screen.getByText(/smoke test failed at tts/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/sidecar unreachable/i)).toBeInTheDocument();
  });

  it('does NOT render the demo-book button when onTryDemoBook is absent', () => {
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /play the demo book/i })).not.toBeInTheDocument();
  });

  it('renders the demo-book button when onTryDemoBook is provided and calls it on click', () => {
    const onTryDemoBook = vi.fn();
    renderFinish(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} onTryDemoBook={onTryDemoBook} />);
    const btn = screen.getByRole('button', { name: /play the demo book/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onTryDemoBook).toHaveBeenCalledTimes(1);
  });
});

describe('StepFinish library reminder', () => {
  it('shows restart reminder when libraryChanged', () => {
    render(<Provider store={makeStore({ workspaceDirOverride: 'D:\\Books' })}>
      <StepFinish readiness={makeReadiness()} onFinish={() => {}} libraryChanged /></Provider>);
    expect(screen.getByText(/Restart .* to move your library/i)).toBeInTheDocument();
    expect(screen.getByText(/D:\\Books/)).toBeInTheDocument();
  });
  it('hides it when not changed', () => {
    render(<Provider store={makeStore()}><StepFinish readiness={makeReadiness()} onFinish={() => {}} libraryChanged={false} /></Provider>);
    expect(screen.queryByText(/move your library/i)).not.toBeInTheDocument();
  });
});
