/* StepFfmpeg spec — fs-21 wave 2.
   Asserts the green "found" card on pass and per-OS install instructions
   + Re-check button on fail. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StepFfmpeg } from './step-ffmpeg';
import type { SetupReadiness } from '../../lib/api';

function makeReadiness(status: 'pass' | 'fail' | 'outdated'): SetupReadiness {
  const ffmpeg =
    status === 'pass'
      ? { status: 'pass' as const, cause: 'pass' as const, message: 'ffmpeg and ffprobe are both installed.', remediation: '' }
      : status === 'outdated'
        /* ops-35 (#1877) — present but below the declared support floor. A
           SUPPORT floor means "untested", not "broken", so this is a warn and
           `ready` stays true. */
        ? {
            status: 'warn' as const,
            cause: 'ffmpeg-too-old' as const,
            message: 'ffmpeg 4.4 is older than Castwright supports (6.0+).',
            remediation: 'Upgrade ffmpeg, then click Recheck.',
          }
        : { status: 'fail' as const, cause: 'both-missing' as const, message: 'ffmpeg and ffprobe are not on PATH.', remediation: 'Install ffmpeg.' };
  return {
    ready: status !== 'fail',
    completedAt: null,
    blockers: {
      sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      ffmpeg,
    },
    info: { gpu: '', vramTotalMb: null },
  };
}

describe('StepFfmpeg', () => {
  describe('when ffmpeg blocker is pass', () => {
    it('renders a ready / found indication', () => {
      render(<StepFfmpeg readiness={makeReadiness('pass')} onRefetch={vi.fn()} />);
      expect(screen.getByText(/audio assembly ready/i)).toBeInTheDocument();
    });

    it('uses the plain-language "Audio assembly" heading, not raw "ffmpeg"', () => {
      render(<StepFfmpeg readiness={makeReadiness('pass')} onRefetch={vi.fn()} />);
      expect(screen.getByRole('heading', { name: /audio assembly/i })).toBeInTheDocument();
    });

    it('does NOT render install instructions', () => {
      render(<StepFfmpeg readiness={makeReadiness('pass')} onRefetch={vi.fn()} />);
      expect(screen.queryByText(/winget install ffmpeg/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/brew install ffmpeg/i)).not.toBeInTheDocument();
    });
  });

  describe('when ffmpeg blocker is fail', () => {
    it('renders Windows install instructions', () => {
      render(<StepFfmpeg readiness={makeReadiness('fail')} onRefetch={vi.fn()} />);
      expect(screen.getByText(/winget install ffmpeg/i)).toBeInTheDocument();
    });

    it('renders macOS install instructions', () => {
      render(<StepFfmpeg readiness={makeReadiness('fail')} onRefetch={vi.fn()} />);
      expect(screen.getByText(/brew install ffmpeg/i)).toBeInTheDocument();
    });

    it('renders Linux install instructions', () => {
      render(<StepFfmpeg readiness={makeReadiness('fail')} onRefetch={vi.fn()} />);
      expect(screen.getByText(/sudo apt install ffmpeg/i)).toBeInTheDocument();
    });

    it('renders a Re-check button that calls onRefetch', () => {
      const onRefetch = vi.fn();
      render(<StepFfmpeg readiness={makeReadiness('fail')} onRefetch={onRefetch} />);
      const btn = screen.getByRole('button', { name: /re-check/i });
      fireEvent.click(btn);
      expect(onRefetch).toHaveBeenCalledTimes(1);
    });
  });

  /* ops-35 (#1877). Before this, `passed` was a two-way boolean on
     status === 'pass', so a 'warn' fell through to the missing branch and told
     a user who HAS ffmpeg that it "isn't installed yet". */
  describe('when ffmpeg is present but below the support floor', () => {
    it('renders the outdated card, not the ready card', () => {
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={vi.fn()} />);
      expect(screen.getByTestId('step-ffmpeg-outdated')).toBeInTheDocument();
      expect(screen.queryByTestId('step-ffmpeg-ready')).not.toBeInTheDocument();
    });

    it('does NOT claim ffmpeg is missing', () => {
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={vi.fn()} />);
      expect(screen.queryByTestId('step-ffmpeg-missing')).not.toBeInTheDocument();
      expect(screen.queryByText(/isn’t installed yet/i)).not.toBeInTheDocument();
    });

    it('shows the detected version and the required floor', () => {
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={vi.fn()} />);
      expect(screen.getByText(/ffmpeg 4\.4 is older than Castwright supports \(6\.0\+\)/i)).toBeInTheDocument();
    });

    it('offers upgrade commands for an already-installed ffmpeg', () => {
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={vi.fn()} />);
      expect(screen.getByText(/winget upgrade Gyan\.FFmpeg/i)).toBeInTheDocument();
      expect(screen.getByText(/brew upgrade ffmpeg/i)).toBeInTheDocument();
      // The missing card's Windows/macOS *install* commands must not appear here.
      expect(screen.queryByText(/winget install ffmpeg/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/brew install ffmpeg/i)).not.toBeInTheDocument();
    });

    /* The `ffmpeg` snap's stable channel is 4.3.1 (2020) — OLDER than Ubuntu
       22.04's own 4.4.2 — so recommending it would downgrade the exact users
       this card is shown to. An earlier draft did; this pins that it doesn't. */
    it('never recommends the ffmpeg snap, which is older than the build it would replace', () => {
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={vi.fn()} />);
      expect(screen.queryByText(/snap install/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/apt remove/i)).not.toBeInTheDocument();
    });

    it('says plainly that Ubuntu 22.04 has no in-repo route to the floor', () => {
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={vi.fn()} />);
      expect(screen.getByText(/22\.04 tops out at 4\.4/i)).toBeInTheDocument();
    });

    it('links the documentation so the floor can be verified', () => {
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={vi.fn()} />);
      const link = screen.getByRole('link', { name: /prerequisites/i });
      expect(link).toHaveAttribute('href', expect.stringContaining('Installing-Castwright'));
    });

    it('renders a Re-check button that calls onRefetch', () => {
      const onRefetch = vi.fn();
      render(<StepFfmpeg readiness={makeReadiness('outdated')} onRefetch={onRefetch} />);
      fireEvent.click(screen.getByRole('button', { name: /re-check/i }));
      expect(onRefetch).toHaveBeenCalledTimes(1);
    });
  });
});
