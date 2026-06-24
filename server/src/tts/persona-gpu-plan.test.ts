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
    expect(gpuSemaphore.inFlight).toBe(0); // budget released in finally on success path
  });
});

describe('resolvePersonaGpuPlan', () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup({ constrained, inFlight, gen }: { constrained: boolean; inFlight: number; gen: string[] }) {
    const residency = await import('../gpu/residency.js');
    vi.spyOn(residency, 'shouldEvictBeforeSidecarLoad').mockReturnValue(constrained);
    const { gpuSemaphore } = await import('../gpu/semaphore.js');
    vi.spyOn(gpuSemaphore, 'inFlight', 'get').mockReturnValue(inFlight);
    const gen2 = await import('../routes/generation.js');
    vi.spyOn(gen2, 'activeGenerationBooks').mockReturnValue(gen);
    const dl = await import('./design-lock.js');
    vi.spyOn(dl, 'isOtherBookDesignBusy').mockReturnValue(false);
    vi.spyOn(dl, 'isAnyAnalysisBusy').mockReturnValue(false);
    return import('./persona-gpu-plan.js');
  }

  it('roomy card → GPU, no evict', async () => {
    const mod = await setup({ constrained: false, inFlight: 0, gen: [] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: false, evict: false, keepAlive: 0 });
  });

  it('constrained + idle → evict + GPU + resident keepAlive', async () => {
    const mod = await setup({ constrained: true, inFlight: 0, gen: [] });
    const plan = mod.resolvePersonaGpuPlan('/a');
    expect(plan).toMatchObject({ onCpu: false, evict: true });
    expect(plan.keepAlive).not.toBe(0);
  });

  it('constrained + inFlight>0 → CPU, no evict', async () => {
    const mod = await setup({ constrained: true, inFlight: 1, gen: [] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: true, evict: false });
  });

  it('constrained + durable render but inFlight===0 → still CPU', async () => {
    const mod = await setup({ constrained: true, inFlight: 0, gen: ['book-2'] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: true, evict: false });
  });
});

