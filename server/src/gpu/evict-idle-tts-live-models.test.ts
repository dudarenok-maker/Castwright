import { describe, it, expect, vi, afterEach } from 'vitest';
import { evictIdleQwenBase, type EvictIdleQwenBaseOpts } from './evict-idle-tts.js';
import { withCapacityRetry } from './capacity-retry.js';
import { setInFlightDesignCounter, setInFlightMintCounter } from './active-generation-gate.js';

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

  it('a design calling the lever while ANOTHER design is live AND resident keeps the 0.6B', async () => {
    const keep = await ask(
      { design: 2, mint: 0 },
      {
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        deviceKey: 'cuda:0',
        _probeHealth: async () => ({
          qwenLoaded: true,
          kokoroLoaded: false,
          qwenDesignResident: true,
          qwenDeviceKey: 'cuda:1',
        }),
      },
    );
    expect(keep).toMatchObject({ keep06: true, keep17: false });
  });

  it('a design calling the lever while another design is merely COUNTED (none resident, still waiting for admission) frees the 0.6B', async () => {
    const keep = await ask({ design: 2, mint: 0 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'design' });
    expect(keep).toMatchObject({ keep06: false, keep17: false });
  });

  it('a design while a mint is live keeps the 1.7B', async () => {
    const keep = await ask({ design: 1, mint: 1 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'design' });
    expect(keep).toMatchObject({ keep06: false, keep17: true });
  });

  it('a mint calling its own lever alone frees the 0.6B only (count-minus-self, its own 1.7B keep is unchanged)', async () => {
    const keep = await ask({ design: 0, mint: 1 }, { modelKey: 'qwen3-tts-0.6b', purpose: 'mint' });
    expect(keep).toMatchObject({ keep06: false, keep17: true });
  });

  it('a mint while ANOTHER design is live AND resident keeps the 0.6B too', async () => {
    const keep = await ask(
      { design: 1, mint: 1 },
      {
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'mint',
        deviceKey: 'cuda:0',
        _probeHealth: async () => ({
          qwenLoaded: true,
          kokoroLoaded: false,
          qwenDesignResident: true,
          qwenDeviceKey: 'cuda:1',
        }),
      },
    );
    expect(keep).toMatchObject({ keep06: true, keep17: true });
  });
});

/* Review pass 1 (#4563) — the production wiring (leaf-gate counters, NO
   `_inFlightDesignMint` injection) and the two admission-shaped regressions. */
describe('evictIdleQwenBase #4533 review fixes', () => {
  afterEach(() => {
    setInFlightDesignCounter(() => 0);
    setInFlightMintCounter(() => 0);
  });

  async function askWired(opts: Partial<EvictIdleQwenBaseOpts>) {
    const reconcile = vi.fn().mockResolvedValue(true);
    const out = await evictIdleQwenBase({
      modelKey: 'coqui-xtts-v2',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
      _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: false }),
      ...opts,
    });
    return { out, keep: reconcile.mock.calls[0]?.[0] as Record<string, boolean | undefined> };
  }

  it('real counters: a live DESIGN keeps the 0.6B (not the 1.7B); a live MINT keeps the 1.7B (not the 0.6B)', async () => {
    setInFlightDesignCounter(() => 1);
    expect((await askWired({})).keep).toEqual({ keep06: true, keep17: false });
    setInFlightDesignCounter(() => 0);
    setInFlightMintCounter(() => 1);
    expect((await askWired({})).keep).toEqual({ keep06: false, keep17: true });
  });

  it('a design waiting for admission uses no model: a design caller with another design counted but none RESIDENT frees the 0.6B', async () => {
    setInFlightDesignCounter(() => 2);
    const { keep, out } = await askWired({ modelKey: 'qwen3-tts-0.6b', purpose: 'design' });
    expect(keep).toMatchObject({ keep06: false });
    expect(out).toBe(true);
  });

  it('a design caller keeps the 0.6B when the probe confirms another design resident (other device) and answers declined', async () => {
    setInFlightDesignCounter(() => 2);
    const { keep, out } = await askWired({
      modelKey: 'qwen3-tts-0.6b',
      purpose: 'design',
      deviceKey: 'cuda:0',
      _probeHealth: async () => ({
        qwenLoaded: true,
        kokoroLoaded: false,
        qwenDesignResident: true,
        qwenDeviceKey: 'cuda:1',
      }),
    });
    expect(keep).toMatchObject({ keep06: true });
    expect(out).toBe('declined');
  });

  it('a hold-back frees the rest and answers declined, so the caller re-asks once the other op ends', async () => {
    setInFlightMintCounter(() => 1);
    const { out } = await askWired({});
    expect(out).toBe('declined');
  });

  it('through withCapacityRetry: two designs refused together both succeed with ONE 0.6B unload (as on main)', async () => {
    let base06 = true;
    const unloads: string[] = [];
    setInFlightDesignCounter(() => 2);
    const doPost = async () =>
      base06
        ? new Response(JSON.stringify({ noCapacity: true, neededMb: 6000, deviceKey: 'cuda:0' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('ok', { status: 200 });
    const run = () =>
      withCapacityRetry(doPost, {
        engine: 'qwen',
        capacityProbe: { read: async () => [{ kind: 'cuda', index: 0, label: 'g', totalMb: 8000, freeMb: 100 }] },
        analyzerEvictWouldHelp: async () => false,
        evictEndpoints: async () => ({ attempted: 0, unloaded: 0 }),
        isDesignResident: async () => false,
        describeBlockers: async () => [],
        pollMs: 1,
        maxAttempts: 4,
        evictIdleTts: (deviceKey, quiet) =>
          evictIdleQwenBase({
            modelKey: 'qwen3-tts-0.6b',
            purpose: 'design',
            deviceKey,
            quiet,
            _isAnyGenerationActive: () => false,
            _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: false, qwenDesignResident: false }),
            _reconcile: async (keep) => {
              if (keep.keep06 || !base06) return false;
              base06 = false;
              unloads.push('0.6B');
              return true;
            },
          }),
      });
    const res = await Promise.all([run(), run()]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(unloads).toEqual(['0.6B']);
  });

  it('through withCapacityRetry: a preview refused while a mint is live is freed the 1.7B once the mint ends', async () => {
    let base17 = true;
    let mintLive = 1;
    setInFlightMintCounter(() => mintLive);
    const unloads: string[] = [];
    const doPost = async () =>
      base17
        ? new Response(JSON.stringify({ noCapacity: true, neededMb: 4000, deviceKey: 'cuda:0' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('ok', { status: 200 });
    setTimeout(() => {
      mintLive = 0;
    }, 15);
    const res = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: async () => [{ kind: 'cuda', index: 0, label: 'g', totalMb: 8000, freeMb: 100 }] },
      analyzerEvictWouldHelp: async () => false,
      evictEndpoints: async () => ({ attempted: 0, unloaded: 0 }),
      isDesignResident: async () => false,
      describeBlockers: async () => [],
      pollMs: 10,
      maxAttempts: 20,
      evictIdleTts: (deviceKey, quiet) =>
        evictIdleQwenBase({
          modelKey: 'coqui-xtts-v2',
          deviceKey,
          quiet,
          _isAnyGenerationActive: () => false,
          _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: false }),
          _reconcile: async (keep) => {
            if (keep.keep17 || !base17) return false;
            base17 = false;
            unloads.push('1.7B');
            return true;
          },
        }),
    });
    expect(res.status).toBe(200);
    expect(unloads).toEqual(['1.7B']);
  });

  it('re-asks during a live mint free the 0.6B at most once, and the held 1.7B only after the mint ends', async () => {
    let live = { design: 0, mint: 1 };
    const quiet = { minGapMs: 1, sawRepair: false, idleSince: null, epoch: null };
    const keeps: Array<{ keep06?: boolean; keep17?: boolean }> = [];
    const reconcile = vi.fn(async (keep: { keep06?: boolean; keep17?: boolean }) => {
      keeps.push({ ...keep });
      return !keep.keep06 || !keep.keep17;
    });
    const ask1 = () =>
      evictIdleQwenBase({
        modelKey: 'coqui-xtts-v2',
        quiet,
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: false }),
        _inFlightDesignMint: () => live,
      });
    const results = [await ask1(), await ask1(), await ask1(), await ask1()];
    expect(results).toEqual(['declined', 'declined', 'declined', 'declined']);
    // Only the first ask frees the 0.6B; every re-ask keeps both models.
    expect(keeps.filter((k) => !k.keep06)).toHaveLength(1);
    expect(keeps.slice(1)).toEqual([
      { keep06: true, keep17: true },
      { keep06: true, keep17: true },
      { keep06: true, keep17: true },
    ]);
    live = { design: 0, mint: 0 };
    expect(await ask1()).toBe(true);
    expect(keeps[4]).toEqual({ keep06: false, keep17: false });
  });
});
