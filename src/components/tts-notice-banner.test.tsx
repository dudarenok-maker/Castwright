/* TtsNoticeBanner — the shared surface for TTS Load/Stop lifecycle notices.
   This is the surface that fixes the silent-revert bug: before it existed at
   the layout level, a Load failure fired from the top-bar pill (Analysing /
   Confirm / ready views) set loadErrorNotice on the shared hook state but had
   nowhere to render, so the pill just reverted to idle with no explanation. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TtsNoticeBanner } from './tts-notice-banner';
import type { EngineLifecycle } from '../lib/use-tts-lifecycle';

function makeReadyLifecycle(): EngineLifecycle {
  return { state: 'ready', onLoad: vi.fn(), onStop: vi.fn() };
}

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
        evictionNotice="Analyzer unloaded to free VRAM for the voice engine."
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
        evictionNotice="Analyzer unloaded to free VRAM for the voice engine."
        loadErrorNotice="Voice engine failed to load. Check the voice engine logs."
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Analyzer unloaded/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i);
  });

  describe('trip notice (Task 16/16.5, #2974)', () => {
    it('renders the trip notice as an alert, distinct from loadErrorNotice, and dismisses on click', () => {
      const onDismiss = vi.fn();
      render(
        <TtsNoticeBanner
          evictionNotice={null}
          loadErrorNotice={null}
          tripNotice="Auto-reverted: GPU pin for qwen looked structurally too small and was reset to auto."
          onDismiss={onDismiss}
        />,
      );
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Auto-reverted');
      fireEvent.click(screen.getByRole('button', { name: /dismiss gpu auto-revert notice/i }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('renders alongside a load error notice without clobbering it', () => {
      render(
        <TtsNoticeBanner
          evictionNotice={null}
          loadErrorNotice="Voice engine failed to load. Check the voice engine logs."
          tripNotice="Voice engine kept crash-looping, but not tied to a specific GPU card — manual investigation needed."
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.getByText(/not tied to a specific gpu card/i)).toBeInTheDocument();
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
  });

  describe('resident-model Stop row (Task 10 / #1839)', () => {
    it("leads with the action: the Stop button's VISIBLE text names the engine, and doubles as its accessible name", () => {
      /* This control duplicates the Status popover's own Stop pill for the
         same engine whenever that engine is resident (#1841 CI triage) — the
         two must have different accessible names. This banner copy names the
         engine directly on the button itself ("Stop Kokoro") instead of the
         popover's unchanged, generic "Stop (voice engine)" — the point here
         is the action, not a status readout, so the label reads on the
         button rather than via a hidden aria-label override. */
      render(
        <TtsNoticeBanner
          evictionNotice={null}
          loadErrorNotice={null}
          onDismiss={vi.fn()}
          kokoro={makeReadyLifecycle()}
        />,
      );
      const stopButton = screen.getByRole('button', { name: 'Stop Kokoro' });
      expect(stopButton).toBeInTheDocument();
      /* Visible text, not just the accessible name — proves the engine name
         is on-screen copy, not hidden aria-label-only copy. */
      expect(stopButton).toHaveTextContent('Stop Kokoro');
      expect(screen.queryByRole('button', { name: /^stop \(voice engine\)$/i })).not.toBeInTheDocument();
    });

    it('still shows the resident status as secondary copy alongside the action', () => {
      /* The status chip ("Kokoro ready") isn't gone — it just isn't the
         prominent element in this context anymore; the Stop button is. */
      render(
        <TtsNoticeBanner
          evictionNotice={null}
          loadErrorNotice={null}
          onDismiss={vi.fn()}
          kokoro={makeReadyLifecycle()}
        />,
      );
      expect(screen.getByText(/Kokoro ready/i)).toBeInTheDocument();
    });

    it('gives Kokoro and Coqui XTTS distinct Stop buttons when both are resident', () => {
      render(
        <TtsNoticeBanner
          evictionNotice={null}
          loadErrorNotice={null}
          onDismiss={vi.fn()}
          kokoro={makeReadyLifecycle()}
          coqui={makeReadyLifecycle()}
        />,
      );
      expect(screen.getByRole('button', { name: 'Stop Kokoro' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop Coqui XTTS' })).toBeInTheDocument();
    });

    it('renders nothing extra when neither engine is resident', () => {
      const { container } = render(
        <TtsNoticeBanner
          evictionNotice={null}
          loadErrorNotice={null}
          onDismiss={vi.fn()}
          kokoro={{ state: 'idle', onLoad: vi.fn(), onStop: vi.fn() }}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });
});
