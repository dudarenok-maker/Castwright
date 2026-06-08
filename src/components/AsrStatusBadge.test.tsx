/* AsrStatusBadge (srv-31) — the display-only model-watch indicator for Whisper.
   Pins: ready shows the device, idle/unreachable render their labels, and any
   non-display state collapses to idle (the badge never shows a Load/Stop). */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AsrStatusBadge } from './AsrStatusBadge';

describe('AsrStatusBadge', () => {
  it('shows the device when ready', () => {
    render(<AsrStatusBadge state="ready" device="cuda" />);
    expect(screen.getByText('Whisper ASR ready · cuda')).toBeInTheDocument();
  });

  it('shows ready without a device when none is reported', () => {
    render(<AsrStatusBadge state="ready" device={null} />);
    expect(screen.getByText('Whisper ASR ready')).toBeInTheDocument();
  });

  it('shows idle', () => {
    render(<AsrStatusBadge state="idle" device={null} />);
    expect(screen.getByText('Whisper ASR idle')).toBeInTheDocument();
  });

  it('shows the voice-engine-down label when unreachable', () => {
    render(<AsrStatusBadge state="unreachable" device={null} />);
    expect(screen.getByText('Voice engine not running')).toBeInTheDocument();
  });

  it('collapses an unexpected state to idle (no Load/Stop button ever renders)', () => {
    render(<AsrStatusBadge state="loading" device={null} />);
    expect(screen.getByText('Whisper ASR idle')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
