import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedOllamaUrl: () => 'http://localhost:11434',
}));

import { readOllamaResidency, evictOllama, analyzerEvictWouldHelp } from './ollama-residency.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readOllamaResidency', () => {
  it('sums size_vram bytes into MB and lists model names when /api/ps succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen3.5:9b', size_vram: 3 * 1_048_576 },
          { name: 'llama3.2:3b', size_vram: 2 * 1_048_576 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await readOllamaResidency();

    expect(result).toEqual({
      totalVramMb: 5,
      models: ['qwen3.5:9b', 'llama3.2:3b'],
      reachable: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/ps',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns the unreachable shape when fetch rejects (daemon down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await readOllamaResidency();

    expect(result).toEqual({ totalVramMb: 0, models: [], reachable: false });
  });

  it('returns the unreachable shape on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await readOllamaResidency();

    expect(result).toEqual({ totalVramMb: 0, models: [], reachable: false });
  });

  it('never throws on a malformed body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('bad json');
        },
      }),
    );

    await expect(readOllamaResidency()).resolves.toEqual({ totalVramMb: 0, models: [], reachable: false });
  });
});

describe('evictOllama', () => {
  it('posts a keep_alive:0 empty-prompt /api/generate for each resident model', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/ps')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            models: [
              { name: 'qwen3.5:9b', size_vram: 1 },
              { name: 'llama3.2:3b', size_vram: 1 },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await evictOllama();

    const generateCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/generate'));
    expect(generateCalls).toHaveLength(2);
    expect(JSON.parse(generateCalls[0][1].body)).toEqual({ model: 'qwen3.5:9b', prompt: '', keep_alive: 0 });
    expect(JSON.parse(generateCalls[1][1].body)).toEqual({ model: 'llama3.2:3b', prompt: '', keep_alive: 0 });
  });

  it('tolerates a per-model 500 without throwing', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/ps')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: 'qwen3.5:9b', size_vram: 1 }] }),
        });
      }
      return Promise.reject(new Error('boom'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(evictOllama()).resolves.toBeUndefined();
  });

  it('no-ops when the daemon is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await evictOllama();

    // Only the /api/ps probe fired — no /api/generate attempts with no known models.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('analyzerEvictWouldHelp', () => {
  it('returns false when combined VRAM is still short of what is needed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'qwen3.5:9b', size_vram: 3000 * 1_048_576 }] }),
      }),
    );

    // Ollama holds 3000 MB, freeOnDevice 2000, needed 5600 -> 5000 < 5600 -> false.
    await expect(analyzerEvictWouldHelp(5600, 2000)).resolves.toBe(false);
  });

  it('returns true when combined VRAM covers what is needed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'qwen3.5:9b', size_vram: 3000 * 1_048_576 }] }),
      }),
    );

    // 3000 + 2000 = 5000 >= 4800 -> true.
    await expect(analyzerEvictWouldHelp(4800, 2000)).resolves.toBe(true);
  });
});
