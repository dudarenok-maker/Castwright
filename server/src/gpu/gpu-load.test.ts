import { describe, it, expect, vi, beforeEach } from 'vitest';

const { busyMock, probeMock, evictMock } = vi.hoisted(() => ({
  busyMock: vi.fn(() => false),
  probeMock: vi.fn(async () => [{ kind: 'cpu', index: 0, label: 'cpu', totalMb: 32000, freeMb: 16000 }]),
  evictMock: vi.fn(async () => {}),
}));

vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: busyMock }));
vi.mock('./capacity-probe.js', () => ({ capacityProbe: { read: probeMock } }));
vi.mock('../analyzer/ollama-residency.js', () => ({ evictOllama: evictMock }));

import { withGpuLoad, GpuBusyError } from './gpu-load.js';

const roomyGpu = [{ kind: 'cuda', index: 0, label: 'g', totalMb: 16384, freeMb: 12000 }];
// 8 GB card with Ollama resident: only ~2.5 GB free — below the 6144 decode floor.
const tightGpu = [{ kind: 'cuda', index: 0, label: 'g', totalMb: 8188, freeMb: 2500 }];

beforeEach(() => {
  busyMock.mockClear();
  busyMock.mockReturnValue(false);
  probeMock.mockClear();
  probeMock.mockResolvedValue([{ kind: 'cpu', index: 0, label: 'cpu', totalMb: 32000, freeMb: 16000 }]);
  evictMock.mockClear();
});

describe('withGpuLoad', () => {
  it('roomy card: loads directly, no evict — even while analysis is busy (coexist)', async () => {
    probeMock.mockResolvedValue(roomyGpu);
    busyMock.mockReturnValue(true); // would refuse if the card were tight
    const out = await withGpuLoad(async () => 'ok');
    expect(out).toBe('ok');
    expect(evictMock).not.toHaveBeenCalled();
  });

  it('tight card, analysis idle: evicts the resident analyzer, then loads', async () => {
    probeMock.mockResolvedValue(tightGpu);
    const load = vi.fn(async () => 'ok');
    const out = await withGpuLoad(load);
    expect(evictMock).toHaveBeenCalledTimes(1);
    expect(out).toBe('ok');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('tight card, analysis busy: refuses with GpuBusyError, no load, no evict', async () => {
    probeMock.mockResolvedValue(tightGpu);
    busyMock.mockReturnValue(true);
    const load = vi.fn();
    await expect(withGpuLoad(load as never)).rejects.toBeInstanceOf(GpuBusyError);
    expect(load).not.toHaveBeenCalled();
    expect(evictMock).not.toHaveBeenCalled();
  });
});

describe('withGpuLoad — engineOnGpu passthrough (W2.6)', () => {
  it('runs the load directly (no probe/busy/evict) when engineOnGpu is false', async () => {
    busyMock.mockReturnValue(true);
    probeMock.mockClear();
    const out = await withGpuLoad(async () => 'ok', false);
    expect(out).toBe('ok');
    expect(busyMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    expect(evictMock).not.toHaveBeenCalled();
  });
});
