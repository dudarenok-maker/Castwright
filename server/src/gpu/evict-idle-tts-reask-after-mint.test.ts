import { describe, it, expect, afterEach } from 'vitest';
import { evictIdleQwenBase } from './evict-idle-tts.js';
import { withCapacityRetry } from './capacity-retry.js';
import { setInFlightDesignCounter, setInFlightMintCounter } from './active-generation-gate.js';
import { setProbeSidecarHealthProvider } from './sidecar-health-gate.js';

/* #4533 — the re-ask restriction ends with the hold-back: a mint reloads its 0.6B in its own
   phases, so once it ends that 0.6B is idle again and the next ask must free it. Real
   withCapacityRetry, real lever, real mint counter; only the sidecar is faked. */

const noCap = (neededMb: number) =>
  new Response(JSON.stringify({ noCapacity: true, neededMb, deviceKey: 'cuda:0' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

describe('evict lever re-ask after the hold-back ends (#4533)', () => {
  afterEach(() => {
    setInFlightDesignCounter(() => 0);
    setInFlightMintCounter(() => 0);
    setProbeSidecarHealthProvider(null);
  });

  it('a preview behind a mint that reloads its 0.6B still frees it once the mint ends (#4533)', async () => {
    const st = { r06: true, r17: true, mintLive: 1 };
    setInFlightMintCounter(() => st.mintLive);
    const log: string[] = [];
    // The mint's distil / audition phase reloads the 0.6B inside its lock (main.py:8420-8422).
    setTimeout(() => {
      if (!st.r06) {
        st.r06 = true;
        log.push('mint phase reloads 0.6B');
      }
    }, 8);
    setTimeout(() => {
      st.mintLive = 0;
      log.push('mint ends');
    }, 25);
    const doPost = async () => {
      // Real sidecar: once the mint's reservation ends, the admission ladder frees an
      // idle 1.7B on its own (main.py:6110). The 0.6B has no ladder step.
      if (st.mintLive === 0 && st.r17) {
        st.r17 = false;
        log.push('ladder frees 1.7B');
      }
      return st.r06 || st.r17 ? noCap(3584) : new Response('ok', { status: 200 });
    };
    let outcome: string;
    try {
      const res = await withCapacityRetry(doPost, {
        engine: 'coqui',
        capacityProbe: { read: async () => [{ kind: 'cuda', index: 0, label: 'g', totalMb: 8000, freeMb: 100 }] },
        analyzerEvictWouldHelp: async () => false,
        evictEndpoints: async () => ({ attempted: 0, unloaded: 0 }),
        isDesignResident: async () => false,
        describeBlockers: async () => [],
        pollMs: 5,
        maxAttempts: 30,
        evictIdleTts: (deviceKey, quiet) =>
          evictIdleQwenBase({
            modelKey: 'coqui-xtts-v2',
            deviceKey,
            quiet,
            _isAnyGenerationActive: () => false,
            _probeHealth: async () => ({ qwenLoaded: st.r06, kokoroLoaded: false }),
            _reconcile: async (keep) => {
              let freed = false;
              const when = st.mintLive ? 'mint live' : 'mint ended';
              if (!keep.keep06 && st.r06) {
                st.r06 = false;
                freed = true;
                log.push(`lever frees 0.6B (${when})`);
              }
              if (!keep.keep17 && st.r17) {
                st.r17 = false;
                freed = true;
                log.push(`lever frees 1.7B (${when})`);
              }
              return freed;
            },
          }),
      });
      outcome = `ok ${res.status}`;
    } catch (e) {
      outcome = `rejected ${(e as Error).name}`;
    }
    expect(outcome).toBe('ok 200');
  });
});
