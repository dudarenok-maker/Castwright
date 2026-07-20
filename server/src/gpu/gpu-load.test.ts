import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { busyMock, probeMock, evictMock, lockMock } = vi.hoisted(() => ({
  busyMock: vi.fn(() => false),
  probeMock: vi.fn(async () => [{ kind: 'cpu', index: 0, label: 'cpu', totalMb: 32000, freeMb: 16000 }]),
  evictMock: vi.fn(async () => {}),
  lockMock: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: busyMock }));
vi.mock('./capacity-probe.js', () => ({ capacityProbe: { read: probeMock } }));
vi.mock('../analyzer/ollama-residency.js', () => ({ evictOllama: evictMock }));
vi.mock('./load-mutex.js', () => ({ withGpuLoadLock: lockMock }));

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
  lockMock.mockClear();
});

afterEach(() => {
  delete process.env.SEG_CAPACITY_ADMISSION;
});

describe('withGpuLoad', () => {
  // These exercise the coarse Node load-path (probe/evict/lock). Since #1720
  // flipped SEG_CAPACITY_ADMISSION ON by default, that path only runs under the
  // explicit =0 opt-out — set it here so these keep testing the coarse path.
  beforeEach(() => {
    process.env.SEG_CAPACITY_ADMISSION = '0';
  });

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

describe('withGpuLoad — SEG_CAPACITY_ADMISSION flag (#1720)', () => {
  it('flag DEFAULT (unset): passthrough — no probe/evict/lock, even on a tight+busy card', async () => {
    // The flag flipped ON by default with the #1720 rollout: an unset env must
    // behave like an explicit =1 (sidecar admission is the single authority).
    delete process.env.SEG_CAPACITY_ADMISSION;
    busyMock.mockReturnValue(true);
    probeMock.mockImplementation(async () => {
      throw new Error('capacityProbe.read should not be called when admission is on by default');
    });
    const load = vi.fn(async () => 'ok');
    const out = await withGpuLoad(load, true);
    expect(out).toBe('ok');
    expect(load).toHaveBeenCalledTimes(1);
    expect(probeMock).not.toHaveBeenCalled();
    expect(evictMock).not.toHaveBeenCalled();
    expect(lockMock).not.toHaveBeenCalled();
  });

  it('flag ON: runs the load directly, without probe/evict/lock, even on a tight+busy card', async () => {
    process.env.SEG_CAPACITY_ADMISSION = '1';
    probeMock.mockResolvedValue(tightGpu);
    busyMock.mockReturnValue(true);
    // A probe that throws if called — belt-and-suspenders on top of the call-count assertion.
    probeMock.mockImplementation(async () => {
      throw new Error('capacityProbe.read should not be called when SEG_CAPACITY_ADMISSION=1');
    });
    const load = vi.fn(async () => 'ok');
    const out = await withGpuLoad(load, true);
    expect(out).toBe('ok');
    expect(load).toHaveBeenCalledTimes(1);
    expect(probeMock).not.toHaveBeenCalled();
    expect(evictMock).not.toHaveBeenCalled();
    expect(lockMock).not.toHaveBeenCalled();
  });
});
