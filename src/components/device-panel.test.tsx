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

  it('headlines the active engine device and lists per-engine rows when ready', () => {
    h.info = {
      hardware: { platform: 'darwin', arch: 'arm64', appleSilicon: true, label: 'Apple Silicon Mac' },
      devices: { kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' },
      devicesState: 'ready',
      activeEngine: 'qwen',
    };
    render(<DevicePanel />);
    expect(screen.getByText(/Currently running on:/)).toBeInTheDocument();
    expect(screen.getByText('Apple GPU (Metal)')).toBeInTheDocument();
    // per-engine rows carry the brand engine names
    expect(screen.getByText('Kokoro')).toBeInTheDocument();
    expect(screen.getByText('Coqui XTTS')).toBeInTheDocument();
    expect(screen.getByText('Qwen3-TTS')).toBeInTheDocument();
    // the hedge is replaced by ground truth
    expect(screen.queryByText(/Load a voice to confirm/)).not.toBeInTheDocument();
  });

  it('falls back to capability copy while the probe is pending', () => {
    h.info = {
      hardware: { platform: 'win32', arch: 'x64', appleSilicon: false, label: 'Windows (x64)' },
      devices: { kokoro: null, coqui: null, qwen: null },
      devicesState: 'pending',
      activeEngine: 'kokoro',
    };
    render(<DevicePanel />);
    expect(screen.queryByText(/Currently running on:/)).not.toBeInTheDocument();
    expect(screen.getByText(/falls back to the CPU/)).toBeInTheDocument();
  });

  it('falls back when the active engine has no device entry (e.g. gemini default)', () => {
    h.info = {
      hardware: { platform: 'win32', arch: 'x64', appleSilicon: false, label: 'Windows (x64)' },
      devices: { kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' },
      devicesState: 'ready',
      activeEngine: 'gemini',
    };
    render(<DevicePanel />);
    // no headline (gemini is cloud — no local device), but rows still show
    expect(screen.queryByText(/Currently running on:/)).not.toBeInTheDocument();
    expect(screen.getByText('Kokoro')).toBeInTheDocument();
  });
});
