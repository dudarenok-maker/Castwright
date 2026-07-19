import { describe, it, expect, afterEach, vi } from 'vitest';

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

