/* Tests for preparePersonaBatch. Because preparePersonaBatch and its callee
   (resolvePersonaGpuPlan) live in the same module, we cannot stub it out of
   the module itself. Instead we control its transitive dependencies so the
   real call stack runs, but hits mocked infrastructure:
   - personaSharesGpu       via vi.mock('../analyzer/voice-style.js')  (#3084 W4)
   - resolvePersonaGpuPlan  via generation.js / design-lock.js mocks
*/
import { describe, it, expect, afterEach, vi } from 'vitest';

/* --- top-level mocks -------------------------------------------------------- */

/* personaSharesGpu is the outermost gate (local Ollama, or an endpoint on the Qwen card);
   mock it so each test can flip it without re-importing. */
const mockPersonaSharesGpu = vi.fn<() => boolean>();
vi.mock('../analyzer/voice-style.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/voice-style.js')>();
  return { ...actual, personaSharesGpu: mockPersonaSharesGpu };
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

  it('persona shares the GPU (local, or a same-card endpoint), idle → GPU args with the resident persona keepAlive window', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');

    mockPersonaSharesGpu.mockReturnValue(true);
    vi.mocked(gen.activeGenerationBooks).mockReturnValue([]);

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 300 });
  });

  it('persona shares the GPU, render active → CPU args', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');

    mockPersonaSharesGpu.mockReturnValue(true);
    vi.mocked(gen.activeGenerationBooks).mockReturnValue(['book-1']); // render active → CPU

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: true, keepAlive: 0 });
  });

  it('persona does not share the GPU (gemini, or an endpoint on no card / another card) → off-GPU args', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');

    mockPersonaSharesGpu.mockReturnValue(false);

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 0 });
  });
});
