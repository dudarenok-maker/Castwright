/* detectOllamaGpuSplit — mirrors the dependency-injection style in
   capacity-probe.test.ts / device-total.test.ts: mock execFile, never shell
   out for real in CI. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  detectOllamaGpuSplit,
  parseComputeAppsCsv,
  parseGpuIndexUuidCsv,
  parseGpuFreeCsv,
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
  it('single GPU, all Ollama usage on index 0 -> split: false, no split data to report', async () => {
    mockNvidiaSmi({
      computeApps: 'GPU-aaa, 1, ollama.exe, 5000\n',
      indexUuid: '0, GPU-aaa\n',
      free: '0, 3000\n',
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

  it('two distinct Ollama PIDs on different GPUs (false positive) -> split: false', async () => {
    mockNvidiaSmi({
      // GPU 0 holds PID 1 (5000MB), GPU 1 holds PID 2 (3000MB).
      // These are two different Ollama processes/models, not one model split.
      computeApps: 'GPU-aaa, 1, ollama.exe, 5000\nGPU-bbb, 2, ollama_llama_server, 3000\n',
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
      // Ollama rows present but used_memory is [N/A] (WDDM driver limitation)
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
});
