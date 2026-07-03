/* StepFfmpeg spec — fs-21 wave 2.
   Asserts the green "found" card on pass and per-OS install instructions
   + Re-check button on fail. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StepFfmpeg } from './step-ffmpeg';
import type { SetupReadiness } from '../../lib/api';

function makeReadiness(status: 'pass' | 'fail'): SetupReadiness {
  return {
    ready: status === 'pass',
    completedAt: null,
    blockers: {
      sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      ffmpeg: status === 'pass'
        ? { status: 'pass', cause: 'pass', message: 'ffmpeg and ffprobe are both installed.', remediation: '' }
        : { status: 'fail', cause: 'both-missing', message: 'ffmpeg and ffprobe are not on PATH.', remediation: 'Install ffmpeg.' },
    },
    info: { gpu: '' },
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
});
