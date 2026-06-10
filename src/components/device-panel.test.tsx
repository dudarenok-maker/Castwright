import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ info: null as null | Record<string, unknown> }));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: vi.fn() }),
}));

import { DevicePanel } from './device-panel';
import { HARDWARE_LINE } from '../lib/brand';

beforeEach(() => {
  h.info = null;
});

describe('DevicePanel', () => {
  it('always shows the honest hardware line', () => {
    render(<DevicePanel />);
    expect(screen.getByText(HARDWARE_LINE)).toBeInTheDocument();
  });

  it('shows the detected host + Metal note on Apple Silicon', () => {
    h.info = {
      hardware: { platform: 'darwin', arch: 'arm64', appleSilicon: true, label: 'Apple Silicon Mac' },
    };
    render(<DevicePanel />);
    expect(screen.getByText('Apple Silicon Mac')).toBeInTheDocument();
    expect(screen.getByText(/Metal GPU automatically/)).toBeInTheDocument();
  });

  it('shows the GPU/CPU note on Windows', () => {
    h.info = {
      hardware: { platform: 'win32', arch: 'x64', appleSilicon: false, label: 'Windows (x64)' },
    };
    render(<DevicePanel />);
    expect(screen.getByText('Windows (x64)')).toBeInTheDocument();
    expect(screen.getByText(/falls back to the CPU/)).toBeInTheDocument();
  });

  it('shows a detecting state when hardware is absent (older server)', () => {
    h.info = { appVersion: '1.6.0' };
    render(<DevicePanel />);
    expect(screen.getByText(/Detecting your hardware/)).toBeInTheDocument();
  });
});
