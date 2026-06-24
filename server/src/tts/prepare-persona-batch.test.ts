/* Tests for preparePersonaBatch. Because preparePersonaBatch and its callees
   (resolvePersonaGpuPlan, unloadResidentSidecar) live in the same module, we
   cannot stub them out of the module itself. Instead we control their transitive
   dependencies so the real call stack runs, but hits mocked infrastructure:
   - resolvePersonaEngine   via vi.mock('../analyzer/voice-style.js')
   - resolvePersonaGpuPlan  via vi.mock('../gpu/residency.js') + semaphore + generation
   - unloadResidentSidecar  via vi.spyOn(global, 'fetch') and activeGenerationBooks
*/
import { describe, it, expect, afterEach, vi } from 'vitest';
import { gpuSemaphore } from '../gpu/semaphore.js';

/* --- top-level mocks -------------------------------------------------------- */

/* resolvePersonaEngine is the outermost gate; mock the whole module so each
   test can flip the engine without re-importing. */
const mockResolvePersonaEngine = vi.fn<() => 'local' | 'gemini'>();
vi.mock('../analyzer/voice-style.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/voice-style.js')>();
  return { ...actual, resolvePersonaEngine: mockResolvePersonaEngine };
});

/* resolvePersonaGpuPlan: mock its dependencies. */
vi.mock('../gpu/residency.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gpu/residency.js')>();
  return { ...actual, shouldEvictBeforeSidecarLoad: vi.fn(() => false) };
});

/* generation and design-lock mocks for unloadResidentSidecar / resolvePersonaGpuPlan */
vi.mock('../routes/generation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/generation.js')>();
  return { ...actual, activeGenerationBooks: vi.fn(() => []) };
});
vi.mock('./design-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./design-lock.js')>();
  return {
    ...actual,
    isOtherBookDesignBusy: vi.fn(() => false),
    isAnyAnalysisBusy: vi.fn(() => false),
  };
});

/* user-settings is needed by unloadResidentSidecar (getResolvedSidecarUrl) */
vi.mock('../workspace/user-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/user-settings.js')>();
  return { ...actual, getResolvedSidecarUrl: vi.fn(() => 'http://localhost:9000') };
});

/* ollama.js is needed by resolvePersonaGpuPlan (resolveAnalyzerKeepAlive) */
vi.mock('../analyzer/ollama.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/ollama.js')>();
  return { ...actual, resolveAnalyzerKeepAlive: vi.fn(() => '5m') };
});

/* --------------------------------------------------------------------------- */

describe('preparePersonaBatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('evict plan → unloads once, returns GPU args', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const residency = await import('../gpu/residency.js');
    const gen = await import('../routes/generation.js');

    mockResolvePersonaEngine.mockReturnValue('local');
    /* constrained + no-render → plan.evict = true */
    vi.mocked(residency.shouldEvictBeforeSidecarLoad).mockReturnValue(true);
    vi.mocked(gen.activeGenerationBooks).mockReturnValue([]);

    /* fetch mock: /unload 200 + /health 200 */
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'idle' }), { status: 200 }),
    );

    const result = await preparePersonaBatch('/a');
    expect(result).toEqual({ onCpu: false, keepAlive: '5m' });
    /* /unload must have been called exactly once */
    const unloadCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/unload'));
    expect(unloadCalls).toHaveLength(1);
    expect(gpuSemaphore.inFlight).toBe(0);
  });

  it('evict refused → CPU args, no throw', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const residency = await import('../gpu/residency.js');
    const gen = await import('../routes/generation.js');

    mockResolvePersonaEngine.mockReturnValue('local');
    vi.mocked(residency.shouldEvictBeforeSidecarLoad).mockReturnValue(true);
    /* activeGenerationBooks returns empty so plan.evict=true,
       but inside unloadResidentSidecar the SECOND check (after acquiring budget)
       sees an active render → GpuBusyForPersonaError */
    vi.mocked(gen.activeGenerationBooks)
      .mockReturnValueOnce([])   // first call: resolvePersonaGpuPlan (busy check)
      .mockReturnValue(['book-1']); // second call: inside unloadResidentSidecar

    const result = await preparePersonaBatch('/a');
    expect(result).toEqual({ onCpu: true, keepAlive: 0 });
    expect(gpuSemaphore.inFlight).toBe(0); // semaphore released in finally
  });

  it('gemini engine → off-GPU args, no evict', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const fetchSpy = vi.spyOn(global, 'fetch');

    mockResolvePersonaEngine.mockReturnValue('gemini');

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
