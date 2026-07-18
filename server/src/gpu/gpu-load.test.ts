import { describe, it, expect, vi, beforeEach } from 'vitest';

const { busyMock } = vi.hoisted(() => {
  const busyMock = vi.fn(() => false);
  return { busyMock };
});

vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: busyMock }));

import { withGpuLoad, GpuBusyError } from './gpu-load.js';

beforeEach(() => {
  busyMock.mockReturnValue(false);
});

describe('withGpuLoad', () => {
  it('idle: runs the load directly', async () => {
    const out = await withGpuLoad(async () => 'ok');
    expect(out).toBe('ok');
  });

  it('REFUSES with GpuBusyError when analysis is busy (no load)', async () => {
    busyMock.mockReturnValue(true);
    const load = vi.fn();
    await expect(withGpuLoad(load as never)).rejects.toBeInstanceOf(GpuBusyError);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('withGpuLoad — engineOnGpu passthrough (W2.6)', () => {
  it('runs the load directly (no busy check) when engineOnGpu is false, even while analysis is busy', async () => {
    busyMock.mockClear(); // isolate from prior tests' accumulated call history
    busyMock.mockReturnValue(true); // would normally refuse
    const out = await withGpuLoad(async () => 'ok', false);
    expect(out).toBe('ok');
    expect(busyMock).not.toHaveBeenCalled();
  });
});
