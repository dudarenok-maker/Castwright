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

  async function setup({ gen }: { gen: string[] }) {
    const gen2 = await import('../routes/generation.js');
    vi.spyOn(gen2, 'activeGenerationBooks').mockReturnValue(gen);
    const dl = await import('./design-lock.js');
    vi.spyOn(dl, 'isOtherBookDesignBusy').mockReturnValue(false);
    vi.spyOn(dl, 'isAnyAnalysisBusy').mockReturnValue(false);
    return import('./persona-gpu-plan.js');
  }

  it('idle → GPU with the resident persona keepAlive window', async () => {
    const mod = await setup({ gen: [] });
    expect(mod.resolvePersonaGpuPlan('/a')).toEqual({ onCpu: false, keepAlive: 300 });
  });

  it('durable render active → CPU, no keepAlive', async () => {
    const mod = await setup({ gen: ['book-2'] });
    expect(mod.resolvePersonaGpuPlan('/a')).toEqual({ onCpu: true, keepAlive: 0 });
  });
});

