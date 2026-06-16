import { describe, it, expect, vi, beforeEach } from 'vitest';

const { unloadMock, verifyMock, vramMock, busyMock, shouldEvictMock } = vi.hoisted(() => {
  const unloadMock = vi.fn(async () => ['qwen3.5:9b']);
  const verifyMock = vi.fn(async () => true);
  const vramMock = vi.fn();
  const busyMock = vi.fn(() => false);
  const shouldEvictMock = vi.fn((v: { totalMb: number | null }) => v.totalMb != null && v.totalMb < 11000);
  return { unloadMock, verifyMock, vramMock, busyMock, shouldEvictMock };
});

vi.mock('../routes/ollama-health.js', () => ({ unloadResidentOllama: unloadMock, verifyOllamaEvicted: verifyMock }));
vi.mock('./vram-state.js', () => ({ getLastKnownVram: vramMock }));
vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: busyMock }));
vi.mock('./residency.js', () => ({ shouldEvictBeforeSidecarLoad: shouldEvictMock }));

import { withGpuLoad, GpuBusyError } from './gpu-load.js';

beforeEach(() => {
  unloadMock.mockClear(); verifyMock.mockClear(); busyMock.mockReturnValue(false); verifyMock.mockResolvedValue(true);
});

describe('withGpuLoad', () => {
  it('on 8 GB: evicts, verifies, then runs the load (in that order)', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    const order: string[] = [];
    unloadMock.mockImplementationOnce(async () => { order.push('evict'); return ['qwen3.5:9b']; });
    verifyMock.mockImplementationOnce(async () => { order.push('verify'); return true; });
    const out = await withGpuLoad(async () => { order.push('load'); return 'ok'; });
    expect(out).toBe('ok');
    expect(order).toEqual(['evict', 'verify', 'load']);
  });

  it('on 12 GB: runs the load directly, no eviction', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 12288 });
    const out = await withGpuLoad(async () => 'ok');
    expect(out).toBe('ok');
    expect(unloadMock).not.toHaveBeenCalled();
  });

  it('REFUSES with GpuBusyError when analysis is busy on a constrained card (no load)', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    busyMock.mockReturnValue(true);
    const load = vi.fn();
    await expect(withGpuLoad(load as never)).rejects.toBeInstanceOf(GpuBusyError);
    expect(load).not.toHaveBeenCalled();
    expect(unloadMock).not.toHaveBeenCalled();
  });

  it('fail-closed: if eviction cannot be verified, throws and does NOT load', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    verifyMock.mockResolvedValue(false);
    const load = vi.fn();
    await expect(withGpuLoad(load as never)).rejects.toBeInstanceOf(GpuBusyError);
    expect(load).not.toHaveBeenCalled();
  });
});
