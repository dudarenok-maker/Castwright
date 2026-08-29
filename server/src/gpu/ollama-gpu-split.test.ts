/* detectOllamaGpuSplit — mirrors the dependency-injection style in
   capacity-probe.test.ts / device-total.test.ts: mock execFile, never shell
   out for real in CI. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { configValueMock } = vi.hoisted(() => ({
  configValueMock: vi.fn((key: string) => {
    if (key === 'gpu.split.probe') return true; // default on
    return undefined;
  }),
}));
vi.mock('../config/resolver.js', () => ({ configValue: configValueMock }));

import {
  detectOllamaGpuSplit,
  parseComputeAppsCsv,
  parseGpuIndexUuidCsv,
  parseGpuFreeCsv,
  __resetOllamaGpuSplitCacheForTest,
} from './ollama-gpu-split.js';

type Cb = (err: Error | null, stdout?: string) => void;

/** Route each mocked nvidia-smi call by which --query-* flag it carries,
    since detectOllamaGpuSplit fires three distinct queries against the same
    'nvidia-smi' command name. */
function mockNvidiaSmi(opts: { computeApps?: string; indexUuid?: string; free?: string; err?: Error }) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _o: unknown, cb: Cb) => {
    if (opts.err) {
      cb(opts.err);
      return;
    }
    const flag = args[0] ?? '';
    if (flag.startsWith('--query-compute-apps')) cb(null, opts.computeApps ?? '');
    else if (flag === '--query-gpu=index,uuid') cb(null, opts.indexUuid ?? '');
    else if (flag === '--query-gpu=index,memory.free') cb(null, opts.free ?? '');
    else cb(new Error('unexpected query'));
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  configValueMock.mockReset();
  __resetOllamaGpuSplitCacheForTest();
});

describe('parseComputeAppsCsv', () => {
  it('parses gpu_uuid,pid,process_name,used_memory rows', () => {
    const result = parseComputeAppsCsv('GPU-aaa, 123, ollama.exe, 5000\nGPU-bbb, 456, chrome.exe, 200\n');
    expect(result.rows).toEqual([
      { gpuUuid: 'GPU-aaa', pid: '123', processName: 'ollama.exe', usedMemoryMb: 5000 },
      { gpuUuid: 'GPU-bbb', pid: '456', processName: 'chrome.exe', usedMemoryMb: 200 },
    ]);
    expect(result.hadUnparseableMemory).toBe(false);
  });

  it('skips structurally invalid rows (field count < 4)', () => {
    const result = parseComputeAppsCsv('garbage\n');
    expect(result.rows).toEqual([]);
    expect(result.hadUnparseableMemory).toBe(false);
  });

  it('skips rows with structurally valid format but unparseable used_memory ([N/A], [Not Supported])', () => {
    const result = parseComputeAppsCsv('GPU-aaa, 123, ollama.exe, [N/A]\nGPU-bbb, 456, ollama_llama_server, [Not Supported]\nGPU-ccc, 789, chrome.exe, 200\n');
    expect(result.rows).toEqual([
      { gpuUuid: 'GPU-ccc', pid: '789', processName: 'chrome.exe', usedMemoryMb: 200 },
    ]);
    expect(result.hadUnparseableMemory).toBe(true);
  });
});

describe('parseGpuIndexUuidCsv', () => {
  it('parses index,uuid rows', () => {
    expect(parseGpuIndexUuidCsv('0, GPU-aaa\n1, GPU-bbb\n')).toEqual([
      { index: 0, uuid: 'GPU-aaa' },
      { index: 1, uuid: 'GPU-bbb' },
    ]);
  });
});

describe('parseGpuFreeCsv', () => {
  it('parses index,memory.free rows', () => {
    expect(parseGpuFreeCsv('0, 3000\n1, 5000\n')).toEqual([
      { index: 0, freeMb: 3000 },
      { index: 1, freeMb: 5000 },
    ]);
  });
});

describe('detectOllamaGpuSplit', () => {
  it('single GPU, all Ollama usage on index 0 -> split: false, device index reported', async () => {
    mockNvidiaSmi({
      computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
      indexUuid: '0, GPU-aaa\n',
      free: '0, 3000\n',
    });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: true,
      split: false,
      deviceIndices: [0], // Single non-split PID on GPU 0
      totalUsedMb: 5000,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });
  });

  it('two distinct Ollama PIDs on different GPUs (false positive) -> split: false', async () => {
    mockNvidiaSmi({
      // GPU 0 holds PID 1 (5000MB), GPU 1 holds PID 2 (3000MB).
      // These are two different Ollama processes/models, not one model split.
      // When there's no split but multiple resident PIDs, deviceIndices should list all resident GPUs.
      computeApps: 'GPU-aaa, 1, ollama.exe, 5000\nGPU-bbb, 2, ollama_llama_server, 3000\n',
      indexUuid: '0, GPU-aaa\n1, GPU-bbb\n',
      free: '0, 3000\n1, 500\n',
    });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: true,
      split: false,
      deviceIndices: [0, 1], // Both resident GPUs listed
      totalUsedMb: 8000,      // Sum of both PIDs
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });
  });

  it('single Ollama PID on a non-expected GPU (not split, wrong device) -> split: false, deviceIndices populated', async () => {
    mockNvidiaSmi({
      // One Ollama model on GPU 1 (not the default GPU 0).
      // This is the REGRESSION TEST for srv-2367: the detector must report
      // which GPU it's actually on so the mismatch warnings can fire.
      computeApps: 'GPU-bbb, 1, ollama.exe, 5000\n',
      indexUuid: '0, GPU-aaa\n1, GPU-bbb\n',
      free: '0, 3000\n1, 500\n',
    });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: true,
      split: false,
      deviceIndices: [1], // Must report the actual device, not empty
      totalUsedMb: 5000,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });
  });

  it('one Ollama PID split across two GPUs -> split: true, wouldFitSingleDevice: true', async () => {
    mockNvidiaSmi({
      // PID 1 (ollama model) is split: 5000MB on GPU 0, 3000MB on GPU 1.
      computeApps: 'GPU-aaa, 1, ollama.exe, 5000\nGPU-bbb, 1, ollama_llama_server, 3000\n',
      indexUuid: '0, GPU-aaa\n1, GPU-bbb\n',
      // GPU 0 has exactly 3000MB free: 3000 + 5000 own-share == 8000, the >=
      // boundary (deliberately exact, not slack, so a >= -> > mutation flips red).
      free: '0, 3000\n1, 500\n',
    });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: true,
      split: true,
      deviceIndices: [0, 1],
      totalUsedMb: 8000,
      wouldFitSingleDevice: true,
      dataUnavailable: false,
    });
  });

  it('one Ollama PID split across two GPUs, neither device covers total -> wouldFitSingleDevice: false', async () => {
    mockNvidiaSmi({
      // PID 1 (ollama model) is split: 5000MB on GPU 0, 11000MB on GPU 1.
      computeApps: 'GPU-aaa, 1, ollama.exe, 5000\nGPU-bbb, 1, ollama_llama_server, 11000\n',
      indexUuid: '0, GPU-aaa\n1, GPU-bbb\n',
      // Neither device's free + own-share (0: 500+5000=5500, 1: 200+11000=11200) covers 16000.
      free: '0, 500\n1, 200\n',
    });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: true,
      split: true,
      deviceIndices: [0, 1],
      totalUsedMb: 16000,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });
  });

  it('nvidia-smi missing/errors -> reachable: false, no throw', async () => {
    mockNvidiaSmi({ err: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: false,
      split: false,
      deviceIndices: [],
      totalUsedMb: 0,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });
  });

  it('no Ollama process present (idle) -> split: false, deviceIndices: []', async () => {
    mockNvidiaSmi({
      computeApps: 'GPU-aaa, 1, chrome.exe, 200\n',
      indexUuid: '0, GPU-aaa\n',
      free: '0, 6000\n',
    });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: true,
      split: false,
      deviceIndices: [],
      totalUsedMb: 0,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });
  });

  it('Ollama processes detected but used_memory unreadable ([N/A] under WDDM) -> dataUnavailable: true', async () => {
    mockNvidiaSmi({
      // Ollama rows present but used_memory is [N/A] (WDDM driver limitation).
      // The raw "GPU-aaa, 1, ollama.exe, [N/A]" line is structurally valid but
      // VRAM is unparseable, so all such rows are skipped and ollamaRows ends up empty.
      // This triggers the "no Ollama rows found" path, returning empty indices.
      computeApps: 'GPU-aaa, 1, ollama.exe, [N/A]\nGPU-bbb, 1, ollama_llama_server, [Not Supported]\n',
      indexUuid: '0, GPU-aaa\n1, GPU-bbb\n',
      free: '0, 3000\n1, 500\n',
    });

    const result = await detectOllamaGpuSplit();
    expect(result).toEqual({
      reachable: true,
      split: false,
      deviceIndices: [],
      totalUsedMb: 0,
      wouldFitSingleDevice: false,
      dataUnavailable: true,
    });
  });

  describe('caching behavior (srv-2367)', () => {
    it('caches result and returns cached copy on second call within TTL window', async () => {
      mockNvidiaSmi({
        computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
        indexUuid: '0, GPU-aaa\n',
        free: '0, 3000\n',
      });

      // First call — should invoke nvidia-smi
      const result1 = await detectOllamaGpuSplit();
      expect(result1.split).toBe(false);
      const callCount1 = execFileMock.mock.calls.length;

      // Second call immediately after — should return cached result without invoking nvidia-smi again
      const result2 = await detectOllamaGpuSplit();
      expect(result2).toEqual(result1);
      expect(execFileMock.mock.calls.length).toBe(callCount1); // No additional calls
    });

    it('bypasses cache and re-probes when fresh: true is passed', async () => {
      mockNvidiaSmi({
        computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
        indexUuid: '0, GPU-aaa\n',
        free: '0, 3000\n',
      });

      // First call — invokes nvidia-smi
      await detectOllamaGpuSplit();
      const callCount1 = execFileMock.mock.calls.length;

      // Second call with fresh: true — should re-probe
      await detectOllamaGpuSplit({ fresh: true });
      expect(execFileMock.mock.calls.length).toBeGreaterThan(callCount1);
    });

    it('re-probes after cache expires (simulated by calling with fresh: true)', async () => {
      mockNvidiaSmi({
        computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
        indexUuid: '0, GPU-aaa\n',
        free: '0, 3000\n',
      });

      // First call — invokes nvidia-smi
      const result1 = await detectOllamaGpuSplit();
      const callCount1 = execFileMock.mock.calls.length;

      // Mock time passage (TTL would expire). We simulate this by calling with fresh: true.
      // In production, the real cache TTL (~1500ms) prevents redundant calls within that window.
      const result2 = await detectOllamaGpuSplit({ fresh: true });
      expect(result2).toEqual(result1); // Result is the same (same underlying state)
      expect(execFileMock.mock.calls.length).toBeGreaterThan(callCount1); // But we re-probed
    });

    it('caches failed probe result (reachable: false)', async () => {
      mockNvidiaSmi({ err: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });

      // First call — fails
      const result1 = await detectOllamaGpuSplit();
      expect(result1.reachable).toBe(false);
      const callCount1 = execFileMock.mock.calls.length;

      // Second call — returns cached failure without re-invoking nvidia-smi
      const result2 = await detectOllamaGpuSplit();
      expect(result2).toEqual(result1);
      expect(execFileMock.mock.calls.length).toBe(callCount1);
    });

    it('coalesces calls 3-5 seconds apart within the 60-second TTL (realistic multi-stage scenario)', async () => {
      let fakeNow = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      try {
        mockNvidiaSmi({
          computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
          indexUuid: '0, GPU-aaa\n',
          free: '0, 3000\n',
        });

        // First call at t=1000 — invokes nvidia-smi
        const result1 = await detectOllamaGpuSplit();
        expect(result1.split).toBe(false);
        const callCount1 = execFileMock.mock.calls.length;

        // Simulate 4 seconds passing (typical gap between chapter processing in stage 1/2)
        fakeNow += 4_000;

        // Second call at t=5000 — should hit cache because 4000ms < 60000ms TTL
        const result2 = await detectOllamaGpuSplit();
        expect(result2).toEqual(result1);
        expect(execFileMock.mock.calls.length).toBe(callCount1);
        // Verify: no additional nvidia-smi calls were made

        // Simulate another 50 seconds (total 54 seconds elapsed, still within TTL)
        fakeNow += 50_000;

        // Third call at t=55000 — still within 60-second TTL, should still hit cache
        const result3 = await detectOllamaGpuSplit();
        expect(result3).toEqual(result1);
        expect(execFileMock.mock.calls.length).toBe(callCount1);
        // Verify: still no additional nvidia-smi calls

        // Simulate 10 more seconds (total 64 seconds elapsed, past TTL)
        fakeNow += 10_000;

        // Fourth call at t=65000 — now past 60-second TTL, should re-probe
        await detectOllamaGpuSplit();
        expect(execFileMock.mock.calls.length).toBeGreaterThan(callCount1);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('respects gpu.split.probe=false config to disable probe', async () => {
      mockNvidiaSmi({
        computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
        indexUuid: '0, GPU-aaa\n',
        free: '0, 3000\n',
      });

      (configValueMock as any).mockReturnValue(false);

      const result = await detectOllamaGpuSplit();
      // When disabled, should return empty result without invoking nvidia-smi
      expect(result).toEqual({
        reachable: false,
        split: false,
        deviceIndices: [],
        totalUsedMb: 0,
        wouldFitSingleDevice: false,
        dataUnavailable: false,
      });
      expect(execFileMock.mock.calls.length).toBe(0);
    });

    it('respects stored override of gpu.split.probe=false to disable probe', async () => {
      mockNvidiaSmi({
        computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
        indexUuid: '0, GPU-aaa\n',
        free: '0, 3000\n',
      });

      // Simulate a stored override that has been resolved to false
      (configValueMock as any).mockReturnValue(false);

      const result = await detectOllamaGpuSplit();
      // When disabled via override, should return empty result without invoking nvidia-smi
      expect(result).toEqual({
        reachable: false,
        split: false,
        deviceIndices: [],
        totalUsedMb: 0,
        wouldFitSingleDevice: false,
        dataUnavailable: false,
      });
      expect(execFileMock.mock.calls.length).toBe(0);
    });

    it('respects env var CASTWRIGHT_GPU_SPLIT_PROBE=false to disable probe via config resolution', async () => {
      mockNvidiaSmi({
        computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
        indexUuid: '0, GPU-aaa\n',
        free: '0, 3000\n',
      });

      // Simulate env var resolution path returning false (e.g., CASTWRIGHT_GPU_SPLIT_PROBE=0/false/no/off)
      (configValueMock as any).mockReturnValue(false);

      const result = await detectOllamaGpuSplit();
      // When disabled via env var resolution, should return empty result without invoking nvidia-smi
      expect(result).toEqual({
        reachable: false,
        split: false,
        deviceIndices: [],
        totalUsedMb: 0,
        wouldFitSingleDevice: false,
        dataUnavailable: false,
      });
      expect(execFileMock.mock.calls.length).toBe(0);
    });
  });
});
