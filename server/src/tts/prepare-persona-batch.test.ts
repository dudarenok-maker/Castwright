/* Tests for preparePersonaBatch. Because preparePersonaBatch and its callee
   (resolvePersonaGpuPlan) live in the same module, we cannot stub it out of
   the module itself. Instead we control its transitive dependencies so the
   real call stack runs, but hits mocked infrastructure:
   - resolvePersonaEngine   via vi.mock('../analyzer/voice-style.js')
   - resolvePersonaGpuPlan  via generation.js / design-lock.js mocks
*/
import { describe, it, expect, afterEach, vi } from 'vitest';

/* --- top-level mocks -------------------------------------------------------- */

/* resolvePersonaEngine is the outermost gate; mock the whole module so each
   test can flip the engine without re-importing. */
const mockResolvePersonaEngine = vi.fn<() => 'local' | 'gemini'>();
vi.mock('../analyzer/voice-style.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/voice-style.js')>();
  return { ...actual, resolvePersonaEngine: mockResolvePersonaEngine };
});

/* generation and design-lock mocks for resolvePersonaGpuPlan's busy check */
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

/* --------------------------------------------------------------------------- */

describe('preparePersonaBatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('local engine, idle → GPU args with the resident persona keepAlive window', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');

    mockResolvePersonaEngine.mockReturnValue('local');
    vi.mocked(gen.activeGenerationBooks).mockReturnValue([]);

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 300 });
  });

  it('local engine, render active → CPU args', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');

    mockResolvePersonaEngine.mockReturnValue('local');
    vi.mocked(gen.activeGenerationBooks).mockReturnValue(['book-1']); // render active → CPU

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: true, keepAlive: 0 });
  });

  it('gemini engine → off-GPU args', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');

    mockResolvePersonaEngine.mockReturnValue('gemini');

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 0 });
  });
});
