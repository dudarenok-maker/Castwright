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
    expect(result).toEqual({ onCpu: false, keepAlive: 300 });
    /* /unload must have been called exactly once */
    const unloadCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/unload'));
    expect(unloadCalls).toHaveLength(1);
    expect(gpuSemaphore.inFlight).toBe(0);
  });

  it('evict refused (render slips in during the budget wait) → CPU args, no throw', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const residency = await import('../gpu/residency.js');
    const gen = await import('../routes/generation.js');

    mockResolvePersonaEngine.mockReturnValue('local');
    vi.mocked(residency.shouldEvictBeforeSidecarLoad).mockReturnValue(true);

    // State-based: idle at plan time; a render starts WHILE we wait for the full budget.
    let activeBooks: string[] = [];
    vi.mocked(gen.activeGenerationBooks).mockImplementation(() => activeBooks);
    vi.spyOn(gpuSemaphore, 'acquire').mockImplementation(async () => {
      activeBooks = ['book-1']; // render slipped in during the evict wait
      return () => {};          // no-op release
    });
    const fetchSpy = vi.spyOn(global, 'fetch');

    const result = await preparePersonaBatch('/a');
    expect(result).toEqual({ onCpu: true, keepAlive: 0 });
    expect(fetchSpy).not.toHaveBeenCalled(); // refused evict must NOT reach /unload
    expect(gpuSemaphore.inFlight).toBe(0);   // real semaphore untouched (acquire was spied)
  });

  it('gemini engine → off-GPU args, no evict', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const fetchSpy = vi.spyOn(global, 'fetch');

    mockResolvePersonaEngine.mockReturnValue('gemini');

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('threads the signal into the evict acquire; aborted wait → CPU args, no throw', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const residency = await import('../gpu/residency.js');
    const gen = await import('../routes/generation.js');

    mockResolvePersonaEngine.mockReturnValue('local');
    vi.mocked(residency.shouldEvictBeforeSidecarLoad).mockReturnValue(true); // plan.evict = true
    vi.mocked(gen.activeGenerationBooks).mockReturnValue([]);

    // A pause fires while the full-budget acquire is queued → acquire rejects AbortError.
    // (Spy-based: the REAL semaphore block can't be reached here — see the spec note. The
    //  real abort mechanism is unit-tested in semaphore.test.ts.)
    const acquireSpy = vi.spyOn(gpuSemaphore, 'acquire').mockRejectedValue(
      new DOMException('GpuSemaphore acquire aborted', 'AbortError'),
    );

    const ac = new AbortController();
    const result = await preparePersonaBatch('/a', ac.signal);
    expect(result).toEqual({ onCpu: true, keepAlive: 0 });
    // The signal is actually forwarded to the reverse-evict acquire (the 2-arg branch):
    expect(acquireSpy).toHaveBeenCalledWith(gpuSemaphore.budget, { signal: ac.signal });
  });
});
