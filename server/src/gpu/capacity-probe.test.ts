/* CapacityProbe — the Node client for the sidecar's GET /capacity (vram-aware
   placement, Task 6). sidecar-good path first; nvidia-smi/rocm-smi vendor
   fallback when the sidecar is down (analysis phase / RSS recycle); CPU-only
   as the final floor. A ~1500ms last-known-good cache avoids re-probing on
   every call unless `fresh: true` is passed. Mocks global fetch + execFile —
   never touches a real sidecar/nvidia-smi/rocm-smi. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { capacityProbe, type ComputeDevice } from './capacity-probe.js';

const fetchMock = vi.fn();

/* Drive execFile's callback-style API: last arg is the (err, stdout, stderr)
   callback. Default every mocked call to ENOENT (binary not found) unless a
   test overrides it for a specific command. */
function mockExecFile(handlers: Record<string, { stdout?: string; err?: Error }>) {
  execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) => {
    const h = handlers[cmd];
    if (!h) {
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return;
    }
    if (h.err) cb(h.err);
    else cb(null, h.stdout ?? '');
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  execFileMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  mockExecFile({}); // default: every vendor probe ENOENTs
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CapacityProbe.read', () => {
  it('sidecar-good: returns the sidecar devices verbatim', async () => {
    const devices: ComputeDevice[] = [
      { kind: 'cuda', index: 0, label: 'NVIDIA GeForce RTX 4090', totalMb: 24576, freeMb: 20000 },
      { kind: 'cpu', index: 0, label: 'cpu', totalMb: 32000, freeMb: 16000 },
    ];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await capacityProbe.read({ fresh: true });
    expect(result).toEqual(devices);
  });

  it('sidecar-down: falls back to nvidia-smi and parses the CSV', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    mockExecFile({
      'nvidia-smi': { stdout: '0, 8188, 6000\n1, 8188, 7000\n' },
    });

    const result = await capacityProbe.read({ fresh: true });
    expect(result).toEqual([
      { kind: 'cuda', index: 0, label: 'cuda:0', totalMb: 8188, freeMb: 6000 },
      { kind: 'cuda', index: 1, label: 'cuda:1', totalMb: 8188, freeMb: 7000 },
    ]);
  });

  it('no probe works: degrades to a single CPU-only device', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    mockExecFile({}); // nvidia-smi AND rocm-smi both ENOENT

    const result = await capacityProbe.read({ fresh: true });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('cpu');
    expect(result[0].totalMb).toBeGreaterThan(0);
    expect(result[0].freeMb).toBeGreaterThan(0);
  });

  it('caches for ~1500ms and only re-probes on fresh:true or after the TTL', async () => {
    const devices: ComputeDevice[] = [
      { kind: 'cuda', index: 0, label: 'gpu0', totalMb: 8188, freeMb: 6000 },
      { kind: 'cpu', index: 0, label: 'cpu', totalMb: 32000, freeMb: 16000 },
    ];
    // A fresh Response instance per call — a Response body can only be read
    // once, and this test deliberately calls fetch more than once.
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ devices }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const first = await capacityProbe.read({ fresh: true });
    expect(first).toEqual(devices);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Within the TTL — no new fetch call.
    const second = await capacityProbe.read();
    expect(second).toEqual(devices);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // fresh:true forces a re-probe regardless of TTL.
    const third = await capacityProbe.read({ fresh: true });
    expect(third).toEqual(devices);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
