/* fs-21 wave 2 — C5: SetupWizard orchestrator tests.
   The 7 step components are stubbed (lightweight divs with testids) so this
   suite tests ORCHESTRATION — step paging, Back/Next, progress, mode split —
   not the steps themselves. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SetupReadiness } from '../../lib/api';

// ── stub the 7 step components ────────────────────────────────────────────────

vi.mock('./step-environment', () => ({
  StepEnvironment: () => <div data-testid="step-environment-stub">env</div>,
}));
vi.mock('./step-ffmpeg', () => ({
  StepFfmpeg: () => <div data-testid="step-ffmpeg-stub">ffmpeg</div>,
}));
vi.mock('./step-analysis', () => ({
  StepAnalysis: () => <div data-testid="step-analysis-stub">analysis</div>,
}));
vi.mock('./step-voice', () => ({
  // Reflects the wizard-owned `needs` so navigation-persistence is observable.
  StepVoice: ({
    needs,
    onChooseNeeds,
  }: {
    needs: string | null;
    onChooseNeeds: (a: string) => void;
  }) => (
    <div data-testid="step-voice-stub">
      <label>
        <input
          type="radio"
          name="voice-needs-stub"
          checked={needs === 'expressive-or-multilingual'}
          onChange={() => onChooseNeeds('expressive-or-multilingual')}
        />
        yes — expressive
      </label>
    </div>
  ),
}));
vi.mock('./step-defaults', () => ({
  StepDefaults: () => <div data-testid="step-defaults-stub">defaults</div>,
}));
vi.mock('./step-library', () => ({
  StepLibrary: () => <div data-testid="step-library-stub">library</div>,
}));
vi.mock('./step-lan-cert', () => ({
  StepLanCert: () => <div data-testid="step-lan-cert-stub" />,
}));
vi.mock('./step-finish', () => ({
  StepFinish: ({ onFinish }: { onFinish: () => void }) => (
    <div data-testid="step-finish-stub">
      <button type="button" onClick={onFinish}>
        Finish setup
      </button>
    </div>
  ),
}));

import { SetupWizard } from './setup-wizard';

const READINESS: SetupReadiness = {
  ready: false,
  completedAt: null,
  blockers: {
    sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    tts: { status: 'fail', cause: 'venv-missing', message: 'TTS engine not available', remediation: 'Install Kokoro weights' },
    analyzer: { status: 'fail', cause: 'no-gemini-key', message: 'Analyzer not configured', remediation: 'Set up Gemini or Ollama' },
  },
  info: { gpu: 'CPU — no GPU detected' },
};

const READY_READINESS: SetupReadiness = {
  ready: true,
  completedAt: '2026-07-01T00:00:00.000Z',
  blockers: {
    sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
  },
  info: { gpu: 'cuda · 0.0 / 8.4 GB reserved' },
};

const STEP_TESTIDS = [
  'step-environment-stub',
  'step-ffmpeg-stub',
  'step-analysis-stub',
  'step-voice-stub',
  'step-defaults-stub',
  'step-library-stub',
  'step-lan-cert-stub',
  'step-finish-stub',
];

describe('SetupWizard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the "Set up Castwright" heading in guided mode', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /set up castwright/i }),
    ).toBeInTheDocument();
  });

  it('shows the "Set up Castwright" heading in checklist mode', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /set up castwright/i }),
    ).toBeInTheDocument();
  });

  it('guided mode renders ONE step at a time, starting on the first', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('step-ffmpeg-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-finish-stub')).not.toBeInTheDocument();
  });

  it('guided mode shows a "Step N of 8" progress indicator', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByText(/step 1 of 8/i)).toBeInTheDocument();
  });

  it('guided mode: Next is always enabled (no blocker gating) and advances', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    const next = screen.getByRole('button', { name: /next/i });
    // even with failing blockers, Next is NOT disabled
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    expect(screen.getByTestId('step-ffmpeg-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('step-environment-stub')).not.toBeInTheDocument();
    expect(screen.getByText(/step 2 of 8/i)).toBeInTheDocument();
  });

  it('guided mode: Back returns to the previous step', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('step-ffmpeg-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
    expect(screen.getByText(/step 1 of 8/i)).toBeInTheDocument();
  });

  it('guided mode reaches the Library step', () => {
    render(<SetupWizard readiness={READINESS} mode="guided" onRefetch={() => {}} onFinish={() => {}} />);
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('step-library-stub')).toBeInTheDocument();
    expect(screen.getByText(/step 6 of 8/i)).toBeInTheDocument();
  });

  it('guided mode: the Voice step answer survives Back/Next (#wizard-answer-persistence)', () => {
    // Regression: the guided yes/no answer used to live in StepVoice's local
    // state, so paging away (which unmounts the step) forgot it — and re-answering
    // on return re-fired the recommended-engine save, clobbering a finer model
    // chosen on the Defaults step. The answer now lives on the wizard.
    render(
      <SetupWizard readiness={READINESS} mode="guided" onRefetch={() => {}} onFinish={() => {}} />,
    );
    // Advance to the Voice step (index 3).
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /next/i }));
    const radio = screen.getByRole('radio', { name: /yes — expressive/i });
    expect(radio).not.toBeChecked();
    fireEvent.click(radio);
    expect(radio).toBeChecked();
    // Page forward to Defaults, then back to Voice.
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('step-defaults-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    // The answer is still selected — no re-click needed, so no clobbering save.
    expect(screen.getByRole('radio', { name: /yes — expressive/i })).toBeChecked();
  });

  it('guided mode: Back is disabled on the first step', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
  });

  it('guided mode: the Finish step renders on the last step (no Next there)', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    // advance through all 7 transitions to the last (finish) step
    for (let i = 0; i < 7; i++) {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    }
    expect(screen.getByTestId('step-finish-stub')).toBeInTheDocument();
    expect(screen.getByText(/step 8 of 8/i)).toBeInTheDocument();
    // Finish lives inside StepFinish; the wizard's own Next is gone
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  it('guided mode: the finish step button calls onFinish', () => {
    const onFinish = vi.fn();
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={onFinish}
      />,
    );
    for (let i = 0; i < 7; i++) {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('re-entry (checklist) mode opens on the summary board, NOT stacked steps', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByTestId('setup-summary-board')).toBeInTheDocument();
    // No step body is rendered until the user drills into a row.
    for (const id of STEP_TESTIDS) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    // No wizard paging at the summary level.
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument();
  });

  it('re-entry mode: clicking a summary row opens the guided wizard at that step', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    // The "Audio assembly" row maps to the ffmpeg step (step 2 of 8).
    fireEvent.click(screen.getByTestId('setup-summary-row-ffmpeg'));
    expect(screen.getByTestId('step-ffmpeg-stub')).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 8/i)).toBeInTheDocument();
  });

  it('re-entry mode: a "Setup overview" link returns from the wizard to the summary', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('setup-summary-row-environment'));
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /setup overview/i }));
    expect(screen.getByTestId('setup-summary-board')).toBeInTheDocument();
    expect(screen.queryByTestId('step-environment-stub')).not.toBeInTheDocument();
  });

  it('re-entry mode: flags failing blockers as needing attention', () => {
    // READINESS has tts:'fail' + analyzer:'fail' → voice + analyzer rows attention.
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByText(/need.*attention/i)).toBeInTheDocument();
    expect(screen.getByTestId('setup-summary-row-voice').dataset.status).toBe('attention');
    expect(screen.getByTestId('setup-summary-row-analyzer').dataset.status).toBe('attention');
    expect(screen.getByTestId('setup-summary-row-ffmpeg').dataset.status).toBe('ok');
  });

  it('re-entry mode: a Re-check button calls onRefetch', () => {
    const onRefetch = vi.fn();
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={onRefetch}
        onFinish={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /re-check/i }));
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('re-entry mode: when everything is ready, a Continue button dismisses and calls onFinish', () => {
    const onFinish = vi.fn();
    render(
      <SetupWizard
        readiness={READY_READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={onFinish}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /continue to my library/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('re-entry mode: when everything is ready, "Open setup wizard" still drills into the guided flow', () => {
    render(
      <SetupWizard
        readiness={READY_READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /open setup wizard/i }));
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
  });

  it('re-entry mode: when blockers remain, there is no Continue button — only Fix setup', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /continue to my library/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix setup/i })).toBeInTheDocument();
  });

  it('summary board renders the Analyzer row before Voice, with a yellow dot on warn', () => {
    const warnReadiness: SetupReadiness = {
      ...READINESS,
      ready: true,
      completedAt: '2026-07-01T00:00:00.000Z',
      blockers: {
        ...READINESS.blockers,
        tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
        analyzer: { status: 'warn', cause: 'pass', message: 'no backup', remediation: '' },
      },
    };
    render(
      <SetupWizard
        readiness={warnReadiness}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    const analyzerRow = screen.getByTestId('setup-summary-row-analyzer');
    const voiceRow = screen.getByTestId('setup-summary-row-voice');
    expect(analyzerRow.compareDocumentPosition(voiceRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(analyzerRow).toHaveAttribute('data-status', 'warn');
  });

  it('summary board treats a transiently-starting voice engine as neutral, not attention (#1612)', () => {
    // sidecar unreachable-transient just means the engine is still starting up —
    // it should agree with the step-voice neutral pill, not flag as 'attention'.
    const startingReadiness: SetupReadiness = {
      ...READINESS,
      blockers: {
        ...READINESS.blockers,
        sidecar: {
          status: 'fail',
          cause: 'unreachable-transient',
          message: 'Voice engine is starting…',
          remediation: '',
        },
        tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      },
    };
    render(
      <SetupWizard
        readiness={startingReadiness}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    const voiceRow = screen.getByTestId('setup-summary-row-voice');
    expect(voiceRow).not.toHaveAttribute('data-status', 'attention');
    expect(voiceRow).toHaveAttribute('data-status', 'ok');
  });
});

const WIKI = 'https://github.com/dudarenok-maker/Castwright/wiki';

describe('SetupWizard — help & wiki links (fe-52/fe-53)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the persistent "Need help?" footer in guided mode', () => {
    render(
      <SetupWizard readiness={READINESS} mode="guided" onRefetch={() => {}} onFinish={() => {}} />,
    );
    expect(screen.getByText(/need help\?/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /report a problem/i })).toHaveAttribute(
      'href', 'https://github.com/dudarenok-maker/Castwright/issues',
    );
  });

  it('renders the "Need help?" footer on the re-entry summary board too', () => {
    render(
      <SetupWizard readiness={READINESS} mode="checklist" onRefetch={() => {}} onFinish={() => {}} />,
    );
    expect(screen.getByTestId('setup-summary-board')).toBeInTheDocument();
    expect(screen.getByText(/need help\?/i)).toBeInTheDocument();
  });

  it('hides "Learn more" on steps whose page is already a footer link, shows it otherwise', () => {
    render(
      <SetupWizard readiness={READINESS} mode="guided" onRefetch={() => {}} onFinish={() => {}} />,
    );
    // Step 1 = Environment → Installing-Castwright (a footer link) → suppressed
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /learn more/i })).not.toBeInTheDocument();
    // Step 2 = ffmpeg → Installing-Castwright → also suppressed
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('step-ffmpeg-stub')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /learn more/i })).not.toBeInTheDocument();
    // Step 3 = Analysis → Analysis-and-the-Analyzer (not in footer) → shown
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('step-analysis-stub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /learn more/i })).toHaveAttribute(
      'href', `${WIKI}/Analysis-and-the-Analyzer`,
    );
  });
});
