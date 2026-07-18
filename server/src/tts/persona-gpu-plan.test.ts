import { describe, it, expect, afterEach, vi } from 'vitest';

describe('unloadResidentSidecar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses (no /unload) while a render is active', async () => {
    const mod = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');
    vi.spyOn(gen, 'activeGenerationBooks').mockReturnValue(['book-1']);
    const fetchSpy = vi.spyOn(global, 'fetch');
    await expect(mod.unloadResidentSidecar()).rejects.toBeInstanceOf(mod.GpuBusyForPersonaError);
    expect(fetchSpy).not.toHaveBeenCalled(); // never sent /unload
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

describe('resolvePersonaGpuPlan', () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup({ constrained, gen }: { constrained: boolean; gen: string[] }) {
    const residency = await import('../gpu/residency.js');
    vi.spyOn(residency, 'shouldEvictBeforeSidecarLoad').mockReturnValue(constrained);
    const gen2 = await import('../routes/generation.js');
    vi.spyOn(gen2, 'activeGenerationBooks').mockReturnValue(gen);
    const dl = await import('./design-lock.js');
    vi.spyOn(dl, 'isOtherBookDesignBusy').mockReturnValue(false);
    vi.spyOn(dl, 'isAnyAnalysisBusy').mockReturnValue(false);
    return import('./persona-gpu-plan.js');
  }

  it('roomy card → GPU, no evict', async () => {
    const mod = await setup({ constrained: false, gen: [] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: false, evict: false, keepAlive: 0 });
  });

  it('constrained + idle → evict + GPU + resident keepAlive', async () => {
    const mod = await setup({ constrained: true, gen: [] });
    const plan = mod.resolvePersonaGpuPlan('/a');
    expect(plan).toMatchObject({ onCpu: false, evict: true });
    expect(plan.keepAlive).not.toBe(0);
  });

  it('constrained + durable render active → CPU, no evict', async () => {
    const mod = await setup({ constrained: true, gen: ['book-2'] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: true, evict: false });
  });
});

