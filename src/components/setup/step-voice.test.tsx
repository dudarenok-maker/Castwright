/* StepVoice composition spec — fe-49.
   Verbatim lift of the voice half of the former combined Models step.
   Verifies the runtime/Kokoro controls and the "More voice engines"
   collapsible are present. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SetupReadiness, BlockerDiagnosis } from '../../lib/api';
import { StepVoice } from './step-voice';

// ── stub the heavy installer children — composition-only spec ──────────────

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

vi.mock('../blocker-fix-action', () => ({
  BlockerFixAction: ({
    diagnosis,
    onDone,
  }: {
    diagnosis: BlockerDiagnosis;
    onDone?: () => void;
  }) => {
    const action = diagnosis.action;
    if (!action) return null;
    return (
      <button data-testid="stub-blocker-fix-action" type="button" onClick={onDone}>
        {action.label}
      </button>
    );
  },
}));

const allPassReadiness: SetupReadiness = {
  ready: true,
  completedAt: null,
  blockers: {
    sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
  },
  info: { gpu: '' },
};

describe('StepVoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the voice-engine controls (runtime + Kokoro + More engines)', () => {
    render(<StepVoice readiness={allPassReadiness} onRefetch={() => {}} />);
    expect(screen.getAllByText(/voice engines/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/more voice engines/i)).toBeInTheDocument();
    expect(screen.getByTestId('stub-venv-bootstrap')).toBeInTheDocument();
    expect(screen.getByTestId('stub-kokoro-install')).toBeInTheDocument();
    expect(screen.getByTestId('stub-qwen-install')).toBeInTheDocument();
    expect(screen.getByTestId('stub-coqui-install')).toBeInTheDocument();
  });
});
