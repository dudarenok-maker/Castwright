/* TtsNoticeBanner — the shared surface for TTS Load/Stop lifecycle notices.
   This is the surface that fixes the silent-revert bug: before it existed at
   the layout level, a Load failure fired from the top-bar pill (Analysing /
   Confirm / ready views) set loadErrorNotice on the shared hook state but had
   nowhere to render, so the pill just reverted to idle with no explanation. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TtsNoticeBanner } from './tts-notice-banner';

describe('TtsNoticeBanner', () => {
  it('renders nothing when both notices are clear', () => {
    const { container } = render(
      <TtsNoticeBanner evictionNotice={null} loadErrorNotice={null} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the eviction notice as an info line', () => {
    render(
      <TtsNoticeBanner
        evictionNotice="Analyzer unloaded to free VRAM for TTS."
        loadErrorNotice={null}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Analyzer unloaded to free VRAM/i)).toBeInTheDocument();
    /* Not an alert — eviction is informational, not an error. */
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the load error as an alert and dismisses on click', () => {
    const onDismiss = vi.fn();
    render(
      <TtsNoticeBanner
        evictionNotice={null}
        loadErrorNotice="[Errno 22] Invalid argument"
        onDismiss={onDismiss}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('[Errno 22] Invalid argument');
    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders both notices together when both are set', () => {
    render(
      <TtsNoticeBanner
        evictionNotice="Analyzer unloaded to free VRAM for TTS."
        loadErrorNotice="Voice engine failed to load. Check the voice engine logs."
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Analyzer unloaded/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i);
  });
});
