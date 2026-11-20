import { describe, it, expect, vi } from 'vitest';
import { evictIdleQwenBase, type EvictIdleQwenBaseOpts } from './evict-idle-tts.js';

/* #4533 — model-scoped, count-minus-self. The lever must not unload a model
   ANOTHER live design (0.6B base + VoiceDesign) or mint (1.7B base) is using,
   and must still free the rest. The caller's own design/mint is already counted
   when it asks (design-voice-core increments before withCapacityRetry), so it is
   subtracted. Asserts the keep set the lever hands reconcile. */

async function ask(
  live: { design: number; mint: number },
  opts: Partial<EvictIdleQwenBaseOpts>,
): Promise<Record<string, boolean | undefined>> {
  const reconcile = vi.fn().mockResolvedValue(true);
  await evictIdleQwenBase({
    modelKey: 'coqui-xtts-v2',
    _reconcile: reconcile,
    _isAnyGenerationActive: () => false,
    _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: false }),
    _inFlightDesignMint: () => live,
    ...opts,
  });
  expect(reconcile).toHaveBeenCalledTimes(1);
  return reconcile.mock.calls[0][0];
}

describe('evictIdleQwenBase keeps what another live design or mint uses (#4533)', () => {
  it('control: nothing live, a non-design op frees both bases as before', async () => {
    expect(await ask({ design: 0, mint: 0 }, {})).toEqual({ keep06: false, keep17: false });
  });

  it('a non-design caller while a mint is live: keeps the 1.7B, frees the 0.6B', async () => {
    expect(await ask({ design: 0, mint: 1 }, {})).toEqual({ keep06: false, keep17: true });
  });

  it('a non-design caller while a design is live: keeps the 0.6B (and so VoiceDesign), frees the 1.7B', async () => {
    expect(await ask({ design: 1, mint: 0 }, {})).toEqual({ keep06: true, keep17: false });
  });

  it('a design calling its own lever with nothing else live frees as before (count-minus-self)', async () => {
    const keep = await ask({ design: 1, mint: 0 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'design' });
    expect(keep).toMatchObject({ keep06: false, keep17: false });
  });

  it('a design calling the lever while ANOTHER design is live keeps the 0.6B', async () => {
    const keep = await ask({ design: 2, mint: 0 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'design' });
    expect(keep).toMatchObject({ keep06: true, keep17: false });
  });

  it('a design while a mint is live keeps the 1.7B', async () => {
    const keep = await ask({ design: 1, mint: 1 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'design' });
    expect(keep).toMatchObject({ keep06: false, keep17: true });
  });

  it('a mint calling its own lever alone frees the 0.6B only (count-minus-self, its own 1.7B keep is unchanged)', async () => {
    const keep = await ask({ design: 0, mint: 1 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'mint' });
    expect(keep).toMatchObject({ keep06: false, keep17: true });
  });

  it('a mint while ANOTHER design is live keeps the 0.6B too', async () => {
    const keep = await ask({ design: 1, mint: 1 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'mint' });
    expect(keep).toMatchObject({ keep06: true, keep17: true });
  });
});
