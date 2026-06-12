import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SetupView } from './setup';

describe('SetupView (wave 0 stub)', () => {
  it('renders the setup heading and the blocker rows from props', () => {
    render(
      <SetupView
        readiness={{
          ready: false,
          completedAt: null,
          blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'fail', analyzer: 'fail' },
          info: { gpu: 'CPU — no GPU detected' },
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: /set up castwright/i })).toBeInTheDocument();
    expect(screen.getByText(/tts/i)).toBeInTheDocument();
  });
});
