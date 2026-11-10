import { describe, it, expect, vi } from 'vitest';
import { evictIdleQwenBase } from './evict-idle-tts.js';
import type { QuietPollState } from './active-generation-gate.js';

/* #4075 (review pass 2) — a Fix-audio splice batch is one POST per chapter, so
   between chapters the gate briefly reads idle. A lever that has seen a repair
   in this admission may only evict after a QUIET STREAK: two consecutive idle
   polls at least one poll interval apart. State is per admission
   (`QuietPollState`), never module-global. */

const quiet = (minGapMs = 10): QuietPollState => ({ minGapMs, sawRepair: false, idleSince: null, epoch: null });

function lever(state: { active: boolean; repairOnly: boolean; now: number; epoch?: number | null }) {
  const reconcile = vi.fn(async () => true);
  const ask = (q: QuietPollState | undefined) =>
    evictIdleQwenBase({
      modelKey: 'qwen3-tts-0.6b',
      purpose: 'design',
      quiet: q,
      _isAnyGenerationActive: () => state.active,
      _isRepairOnlyKnownActive: () => state.repairOnly,
      _probeHealth: async () => ({ status: 'ok', qwenLoaded: true }) as never,
      _reconcile: reconcile,
      _now: () => state.now,
      _spliceEpoch: () => (state.epoch === undefined ? 0 : state.epoch),
    });
  return { reconcile, ask };
}

describe('evictIdleQwenBase quiet-poll rule', () => {
  it('does not evict on the first idle poll after a repair, nor after activity resumes in a splice-batch gap', async () => {
    const s = { active: true, repairOnly: true, now: 0 };
    const { reconcile, ask } = lever(s);
    const q = quiet();

    expect(await ask(q)).toBe('declined'); // chapter 1 splicing
    s.active = false;
    s.repairOnly = false;
    s.now = 100;
    expect(await ask(q)).toBe('declined'); // gap between chapters: first idle poll, NO evict
    s.active = true;
    s.repairOnly = true;
    s.now = 102;
    expect(await ask(q)).toBe('declined'); // chapter 2 registered: streak reset
    s.active = false;
    s.repairOnly = false;
    s.now = 200;
    expect(await ask(q)).toBe('declined'); // idle again: streak restarts
    s.now = 210;
    expect(await ask(q)).toBe(true); // second consecutive idle poll, one interval later
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('needs the two idle polls to be at least one poll interval apart', async () => {
    const s = { active: true, repairOnly: true, now: 0 };
    const { reconcile, ask } = lever(s);
    const q = quiet(10);
    await ask(q);
    s.active = false;
    s.repairOnly = false;
    s.now = 50;
    expect(await ask(q)).toBe('declined');
    s.now = 55; // only 5 ms after the first idle poll
    expect(await ask(q)).toBe('declined');
    expect(reconcile).not.toHaveBeenCalled();
    s.now = 60;
    expect(await ask(q)).toBe(true);
  });

  it('no repair seen in this admission: the first idle ask evicts at once (unchanged)', async () => {
    const s = { active: false, repairOnly: false, now: 0 };
    const { reconcile, ask } = lever(s);
    expect(await ask(quiet())).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('a render is unchanged: false (latch spent), and it does not arm the quiet rule', async () => {
    const s = { active: true, repairOnly: false, now: 0 };
    const { reconcile, ask } = lever(s);
    const q = quiet();
    expect(await ask(q)).toBe(false);
    expect(q.sawRepair).toBe(false);
    s.active = false;
    expect(await ask(q)).toBe(true); // a fresh ask (caller would not make it) is immediate
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('both asks see idle but a splice registered and released between them: no eviction; a later bump-free interval evicts', async () => {
    const s = { active: true, repairOnly: true, now: 0, epoch: 1 as number | null };
    const { reconcile, ask } = lever(s);
    const q = quiet(10);
    await ask(q); // chapter 1 splicing: sawRepair
    s.active = false;
    s.repairOnly = false;
    s.now = 100;
    expect(await ask(q)).toBe('declined'); // gap 1: idleSince set, epoch 1
    s.epoch = 2; // a short chapter registered and released unseen
    s.now = 200;
    expect(await ask(q)).toBe('declined'); // gap 2: idle, gap >= minGap, but epoch moved: restart
    expect(q.idleSince).toBe(200);
    expect(q.epoch).toBe(2);
    expect(reconcile).not.toHaveBeenCalled();
    s.now = 300; // a whole quiet interval, no bump
    expect(await ask(q)).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('an epoch bump during the heavy probe restarts the streak instead of evicting', async () => {
    const s = { active: true, repairOnly: true, now: 0, epoch: 1 as number | null };
    const reconcile = vi.fn(async () => true);
    const q = quiet(10);
    const ask = () =>
      evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        quiet: q,
        _isAnyGenerationActive: () => s.active,
        _isRepairOnlyKnownActive: () => s.repairOnly,
        _probeHealth: async () => {
          s.epoch = (s.epoch as number) + 1; // a splice registers+releases inside the probe
          return { status: 'ok', qwenLoaded: true } as never;
        },
        _reconcile: reconcile,
        _now: () => s.now,
        _spliceEpoch: () => s.epoch,
      });
    await ask(); // active: sawRepair
    s.active = false;
    s.repairOnly = false;
    s.now = 100;
    expect(await ask()).toBe('declined'); // first idle: streak set
    s.now = 200;
    expect(await ask()).toBe('declined'); // probe bumped the epoch: no unload
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('an unregistered epoch accessor never completes the quiet rule (fails closed)', async () => {
    const s = { active: true, repairOnly: true, now: 0, epoch: null as number | null };
    const { reconcile, ask } = lever(s);
    const q = quiet(10);
    await ask(q);
    s.active = false;
    s.repairOnly = false;
    for (const t of [100, 200, 300, 400]) {
      s.now = t;
      expect(await ask(q)).toBe('declined');
    }
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('two concurrent admissions do not share a streak', async () => {
    const s = { active: true, repairOnly: true, now: 0 };
    const { reconcile, ask } = lever(s);
    const a = quiet();
    const b = quiet();
    await ask(a); // admission A sees the repair
    s.active = false;
    s.repairOnly = false;
    s.now = 100;
    expect(await ask(a)).toBe('declined'); // A: first idle poll
    expect(await ask(b)).toBe(true); // B never saw a repair: evicts immediately
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
