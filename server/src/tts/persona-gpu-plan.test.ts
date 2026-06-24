import { describe, it, expect, afterEach, vi } from 'vitest';
import { gpuSemaphore } from '../gpu/semaphore.js';

describe('unloadResidentSidecar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses (no /unload) while a render is active, releasing the full budget', async () => {
    const mod = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');
    vi.spyOn(gen, 'activeGenerationBooks').mockReturnValue(['book-1']);
    const acquire = vi.spyOn(gpuSemaphore, 'acquire');
    const fetchSpy = vi.spyOn(global, 'fetch');
    await expect(mod.unloadResidentSidecar()).rejects.toBeInstanceOf(mod.GpuBusyForPersonaError);
    expect(acquire).toHaveBeenCalledWith(gpuSemaphore.budget); // full budget
    expect(fetchSpy).not.toHaveBeenCalled();                   // never sent /unload
    expect(gpuSemaphore.inFlight).toBe(0);                     // released in finally
  });

  it('unloads the qwen engine when idle and verifies health', async () => {
    const mod = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');
    vi.spyOn(gen, 'activeGenerationBooks').mockReturnValue([]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'idle' }), { status: 200 }),
    );
    await mod.unloadResidentSidecar();
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/unload'))!;
    expect(JSON.parse((call[1] as RequestInit).body as string).engine).toBe('qwen');
  });
});
