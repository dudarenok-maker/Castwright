/* GeminiRateLimiter — sliding-window enforcement of RPM, TPM, RPD with
   AbortSignal cancellation, env-var overrides, and a daily-reset
   boundary at UTC midnight. Uses Vitest fake timers so a 60-s wait
   doesn't actually take 60 s. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiRateLimiter, DailyQuotaExhaustedError, computeTpmWait } from './rate-limit.js';
import { AnalysisAbortedError } from './ollama.js';

describe('GeminiRateLimiter', () => {
  let limiter: GeminiRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    limiter = new GeminiRateLimiter();
    /* Pin a deterministic seed for jitter. */
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.GEMINI_RPM_GEMINI_3_1_FLASH_LITE;
    delete process.env.GEMINI_TPM_GEMINI_3_1_FLASH_LITE;
    delete process.env.GEMINI_RPD_GEMINI_3_1_FLASH_LITE;
    delete process.env.GEMINI_TPM_GEMMA_4_31B_IT;
  });

  it('acquires up to the model RPM without waiting, then blocks until the window slides', async () => {
    /* Flash Lite: 15 RPM. 15 immediate acquires should resolve in the
       same tick; the 16th must wait until the first rolls off. */
    for (let i = 0; i < 15; i += 1) {
      await limiter.acquire('gemini-3.1-flash-lite', 1_000);
    }
    /* Sanity: this returns without advancing the clock if it would not
       wait. We race it against a no-op timer to detect blocking. */
    const onWait = vi.fn();
    const pending = limiter.acquire('gemini-3.1-flash-lite', 1_000, { onWait });
    /* Advance only a sliver — the acquire must still be blocked. */
    await vi.advanceTimersByTimeAsync(10);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    /* The acquire fired onWait with reason='rpm' and a wait near 60 s. */
    expect(onWait).toHaveBeenCalled();
    const [waitMs, reason] = onWait.mock.calls[0];
    expect(reason).toBe('rpm');
    expect(waitMs).toBeGreaterThanOrEqual(60_000);
    /* Advance the clock past the window. */
    await vi.advanceTimersByTimeAsync(waitMs + 1);
    await pending;
  });

  it('blocks on TPM when input tokens would push the 60-s sum past the cap', async () => {
    /* Flash Lite: 250K TPM. 2 acquires of 120K fit (240K); a third of
       30K does not (270K > 250K) and must wait for an entry to roll
       off. */
    await limiter.acquire('gemini-3.1-flash-lite', 120_000);
    await limiter.acquire('gemini-3.1-flash-lite', 120_000);

    const onWait = vi.fn();
    const pending = limiter.acquire('gemini-3.1-flash-lite', 30_000, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    expect(onWait).toHaveBeenCalled();
    expect(onWait.mock.calls[0][1]).toBe('tpm');
    /* Drain the window. */
    await vi.advanceTimersByTimeAsync(60_500);
    await pending;
  });

  it('applies the baked-in limits for gemini-3.5-flash (250K TPM, not the 100K fallback)', async () => {
    /* Registered in BUILTIN_LIMITS as 5 RPM / 250K TPM / 20 RPD. A single
       120K-token acquire fits the baked 250K cap without waiting; under the
       unknown-model fallback (100K TPM) that same call would block — so a
       non-blocking acquire proves the entry is wired up, not falling back. */
    const onWait = vi.fn();
    await limiter.acquire('gemini-3.5-flash', 120_000, { onWait });
    expect(onWait).not.toHaveBeenCalled();
  });

  it('applies the baked-in limits for gemini-3.5-flash-lite (15 RPM / 250K TPM, not the 5 RPM / 100K fallback)', async () => {
    /* Registered in BUILTIN_LIMITS as 15 RPM / 250K TPM / 500 RPD. Six
       immediate 1K acquires prove RPM > 5 (the unknown-model fallback would
       block the 6th); a single 120K acquire proves TPM = 250K (the 100K
       fallback would block it). Together they prove the entry is wired up,
       not falling back — without it a book-length run would hit the 50 RPD
       fallback cap and stall mid-analysis. */
    const onWait = vi.fn();
    for (let i = 0; i < 6; i += 1) {
      await limiter.acquire('gemini-3.5-flash-lite', 1_000, { onWait });
    }
    await limiter.acquire('gemini-3.5-flash-lite', 120_000, { onWait });
    expect(onWait).not.toHaveBeenCalled();
  });

  it('applies the baked-in limits for gemini-3.6-flash (250K TPM, not the 100K fallback)', async () => {
    /* Registered in BUILTIN_LIMITS as 5 RPM / 250K TPM / 20 RPD (same tier as
       3.5 Flash). A single 120K-token acquire fits the baked 250K cap without
       waiting; under the unknown-model fallback (100K TPM) it would block. */
    const onWait = vi.fn();
    await limiter.acquire('gemini-3.6-flash', 120_000, { onWait });
    expect(onWait).not.toHaveBeenCalled();
  });

  it('reconciles an over-estimated entry via recordActualTokens', async () => {
    /* Reserve 50K; reconcile down to 10K — a follow-up 200K request
       must now fit (10K + 200K = 210K, under 250K). */
    await limiter.acquire('gemini-3.1-flash-lite', 50_000);
    limiter.recordActualTokens('gemini-3.1-flash-lite', 10_000);
    /* This must not block. */
    const onWait = vi.fn();
    await limiter.acquire('gemini-3.1-flash-lite', 200_000, { onWait });
    expect(onWait).not.toHaveBeenCalled();
  });

  it('throws DailyQuotaExhaustedError once RPD is reached, no retry', async () => {
    /* Use the unknown-model fallback: 5 RPM / 100K TPM / 50 RPD. Set
       RPM high enough that RPM doesn't bite. */
    process.env.GEMINI_RPM_FAKE_MODEL = '500';
    process.env.GEMINI_TPM_FAKE_MODEL = '10000000';
    process.env.GEMINI_RPD_FAKE_MODEL = '3';
    for (let i = 0; i < 3; i += 1) {
      await limiter.acquire('fake-model', 1_000);
    }
    await expect(limiter.acquire('fake-model', 1_000)).rejects.toBeInstanceOf(
      DailyQuotaExhaustedError,
    );
    /* Reset boundary is next UTC midnight. */
    try {
      await limiter.acquire('fake-model', 1_000);
    } catch (err) {
      if (err instanceof DailyQuotaExhaustedError) {
        expect(err.resetAt.toISOString()).toBe('2026-05-17T00:00:00.000Z');
        expect(err.model).toBe('fake-model');
      } else {
        throw err;
      }
    }
    delete process.env.GEMINI_RPM_FAKE_MODEL;
    delete process.env.GEMINI_TPM_FAKE_MODEL;
    delete process.env.GEMINI_RPD_FAKE_MODEL;
  });

  it('recordRejection(model, ms) blocks the next acquire for at least that long', async () => {
    /* Even with room to spare on RPM/TPM, recordRejection enforces a
       hard floor — emulates Google's `retry-delay: Ns`. */
    process.env.GEMINI_RPM_GEMINI_3_1_FLASH_LITE = '20';
    process.env.GEMINI_TPM_GEMINI_3_1_FLASH_LITE = '10000000';
    limiter.recordRejection('gemini-3.1-flash-lite', 5_000);

    const onWait = vi.fn();
    const pending = limiter.acquire('gemini-3.1-flash-lite', 1_000, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    expect(onWait).toHaveBeenCalled();
    const [waitMs, reason] = onWait.mock.calls[0];
    expect(reason).toBe('retry-after');
    expect(waitMs).toBeGreaterThanOrEqual(5_000);
    await vi.advanceTimersByTimeAsync(waitMs + 1);
    await pending;
  });

  it('cancels in-flight acquires when the AbortSignal fires', async () => {
    /* Sink Flash Lite, then abort while waiting. */
    process.env.GEMINI_RPM_GEMINI_3_1_FLASH_LITE = '1';
    await limiter.acquire('gemini-3.1-flash-lite', 1_000);

    const ac = new AbortController();
    const pending = limiter.acquire('gemini-3.1-flash-lite', 1_000, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AnalysisAbortedError);
  });

  it('honors GEMINI_RPM_/TPM_/RPD_ env overrides', async () => {
    process.env.GEMINI_RPM_GEMINI_3_1_FLASH_LITE = '2';
    process.env.GEMINI_TPM_GEMINI_3_1_FLASH_LITE = '10000';
    process.env.GEMINI_RPD_GEMINI_3_1_FLASH_LITE = '5';
    /* Two immediate acquires of 4K (fits both RPM=2 and TPM=10K). */
    await limiter.acquire('gemini-3.1-flash-lite', 4_000);
    await limiter.acquire('gemini-3.1-flash-lite', 4_000);
    /* The third would breach both RPM and TPM — must block. */
    const onWait = vi.fn();
    const pending = limiter.acquire('gemini-3.1-flash-lite', 4_000, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    expect(onWait).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_500);
    await pending;
  });

  it('falls back to conservative limits (5 RPM / 100K TPM / 50 RPD) for unknown model ids', async () => {
    /* Fire 5 acquires, then a 6th — should block on RPM. */
    for (let i = 0; i < 5; i += 1) {
      await limiter.acquire('totally-made-up-model', 1_000);
    }
    const onWait = vi.fn();
    const pending = limiter.acquire('totally-made-up-model', 1_000, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    expect(onWait).toHaveBeenCalled();
    expect(onWait.mock.calls[0][1]).toBe('rpm');
    await vi.advanceTimersByTimeAsync(61_000);
    await pending;
  });

  it('paces a second Gemma request against the finite 16000 TPM', async () => {
    /* Real timers for this one: the assertion only needs onWait to have
       fired (it fires synchronously before the internal sleep()), but the
       Promise.race needs its setTimeout to actually elapse, which fake
       timers (active via the outer beforeEach) never do without an
       explicit advance. afterEach() unconditionally calls
       vi.useRealTimers(), so this doesn't leak into sibling tests. */
    vi.useRealTimers();
    const limiter = new GeminiRateLimiter();
    const waits: number[] = [];
    await limiter.acquire('gemma-4-31b-it', 12000, { onWait: (ms) => waits.push(ms) });
    // second 12k request cannot fit alongside the first in a 16k window → must wait
    const p = limiter.acquire('gemma-4-31b-it', 12000, { onWait: (ms) => waits.push(ms) });
    await Promise.race([p, new Promise((r) => setTimeout(r, 20))]);
    expect(waits.some((w) => w > 0)).toBe(true);
  });

  it('applies the corrected Gemma RPM of 30 (not the old 15)', async () => {
    /* Gemma free tier is 30 RPM / 16000 TPM / 14400 RPD (AI Studio 2026). 16
       tiny acquires (900 tok each = 14.4k, under the 16k TPM window) must all
       clear without an RPM wait — the pre-correction 15 RPM cap would have
       blocked the 16th. Locks the 15→30 correction in BUILTIN_LIMITS. */
    const onWait = vi.fn();
    for (let i = 0; i < 16; i += 1) {
      await limiter.acquire('gemma-4-31b-it', 900, { onWait });
    }
    expect(onWait).not.toHaveBeenCalled();
  });

  it('treats env TPM 0 as unlimited even though the builtin is finite', () => {
    process.env.GEMINI_TPM_GEMMA_4_31B_IT = '0';
    const limiter = new GeminiRateLimiter();
    // 40k-token request must acquire immediately (unlimited), no throw
    return expect(limiter.acquire('gemma-4-31b-it', 40000)).resolves.toBeUndefined();
  });

  it('fails fast when a single request exceeds a finite TPM (never spins)', async () => {
    const limiter = new GeminiRateLimiter();
    const start = Date.now();
    await expect(limiter.acquire('gemma-4-31b-it', 25000)).rejects.toMatchObject({
      code: 'REQUEST_EXCEEDS_TPM',
    });
    expect(Date.now() - start).toBeLessThan(1000); // did NOT wait 60s
  });
});

describe('saved rate-limit overrides in user settings', () => {
  /* Fresh module registry + temp {} store, exactly like
     config-overrides.test.ts does, so a saved override can be injected and
     never bleeds into sibling tests. */
  async function limiterWithOverrides(overrides: Record<string, number>): Promise<GeminiRateLimiter> {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'cw-ratelimit-'));
    process.env.USER_SETTINGS_FILE = join(dir, 'user-settings.json');
    writeFileSync(process.env.USER_SETTINGS_FILE, '{}');
    const ws = await import('../workspace/user-settings.js');
    for (const [key, value] of Object.entries(overrides)) {
      await ws.writeConfigOverride(key, value);
    }
    const m = await import('./rate-limit.js');
    /* Re-assert fake timers after the module reload: the resolver/gpu module
       graph registers its own timers on import, which a bare vi.resetModules()
       can leave in real-timer state and hang a blocking acquire on a real 60-s
       wait. Pin system time so the sliding-window math is deterministic. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    return new m.GeminiRateLimiter();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.USER_SETTINGS_FILE;
    delete process.env.GEMINI_RPM_GEMMA_4_31B_IT;
    delete process.env.GEMINI_TPM_GEMMA_4_31B_IT;
    delete process.env.GEMINI_RPD_GEMMA_4_31B_IT;
  });

  it('enforces a saved rate.rpm.gemma override below the builtin RPM', async () => {
    /* Built-in gemma-4-31b-it RPM is 30; a saved override of 2 must cap the
       sliding window at 2 — the third acquire within a minute blocks on RPM. */
    const limiter = await limiterWithOverrides({ 'rate.rpm.gemma': 2 });
    const onWait = vi.fn();
    await limiter.acquire('gemma-4-31b-it', 900, { onWait });
    await limiter.acquire('gemma-4-31b-it', 900, { onWait });

    const pending = limiter.acquire('gemma-4-31b-it', 900, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    /* Prove `pending` is genuinely still unsettled rather than merely
       checking a `.then()` flag before the microtask queue has had a chance
       to flip it (that boolean reads false either way, so it can never fail).
       Promise.race calls .then() on each entry in array order, so if `pending`
       were ALREADY resolved its callback would be queued first and this would
       race to 'resolved' instead of the sentinel. */
    const STILL_PENDING = Symbol('still-pending');
    const raceResult = await Promise.race([
      pending.then(() => 'resolved' as const),
      Promise.resolve(STILL_PENDING),
    ]);
    expect(raceResult).toBe(STILL_PENDING);
    expect(onWait).toHaveBeenCalled();
    const [waitMs, reason] = onWait.mock.calls[0];
    expect(reason).toBe('rpm');
    expect(waitMs).toBeGreaterThanOrEqual(60_000);
    await vi.advanceTimersByTimeAsync(waitMs + 1);
    await pending;
  });

  it('env still beats a saved override for the same knob', async () => {
    /* Env=7 is chosen to differ from BOTH the builtin default (30) and the
       saved override (2) — with env=30 (the prior value), removing the
       `readEnvNumber(...) ??` precedence term from resolveLimits still left
       this test green, because the override lookup falls through to the
       builtin default (30) whenever the resolver reports the value came from
       env rather than override, so "30" was indistinguishable from "correct".
       Firing exactly 7 acquires and expecting the 8th to block on RPM proves
       the effective cap is precisely 7 — not 2 (which would already have
       blocked by the 3rd) and not 30 (which would not block until the 31st). */
    process.env.GEMINI_RPM_GEMMA_4_31B_IT = '7';
    const limiter = await limiterWithOverrides({ 'rate.rpm.gemma': 2 });
    const onWait = vi.fn();
    for (let i = 0; i < 7; i += 1) {
      await limiter.acquire('gemma-4-31b-it', 900, { onWait });
    }
    expect(onWait).not.toHaveBeenCalled();

    const pending = limiter.acquire('gemma-4-31b-it', 900, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    expect(onWait).toHaveBeenCalled();
    expect(onWait.mock.calls[0][1]).toBe('rpm');
    await vi.advanceTimersByTimeAsync(60_500);
    await pending;
  });

  it('a saved rate.tpm.gemma override of 0 removes the TPM gate', async () => {
    /* Built-in gemma-4-31b-it TPM is a finite 16000; a saved override of 0
       ("unlimited") must admit a request that would otherwise trip
       RequestExceedsTpmError. */
    const limiter = await limiterWithOverrides({ 'rate.tpm.gemma': 0 });
    await expect(limiter.acquire('gemma-4-31b-it', 50_000)).resolves.toBeUndefined();
  });

  it('applies a saved override live, to an already-constructed limiter, without reconstruction', async () => {
    /* This is the "live" half of `apply: 'live'` (server/src/config/registry.ts)
       and the release note's "takes effect right away, with no restart
       needed": the SAME limiter instance must pick up an override written
       AFTER it was constructed and already used, on its very next acquire() —
       not just at construction time. Built-in gemma-4-31b-it RPM is 30, so
       the first two acquires below clear with no override in play at all. */
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'cw-ratelimit-'));
    process.env.USER_SETTINGS_FILE = join(dir, 'user-settings.json');
    writeFileSync(process.env.USER_SETTINGS_FILE, '{}');
    const ws = await import('../workspace/user-settings.js');
    const m = await import('./rate-limit.js');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    const limiter = new m.GeminiRateLimiter();

    await limiter.acquire('gemma-4-31b-it', 900);
    await limiter.acquire('gemma-4-31b-it', 900);

    /* Save the override only now — after the limiter already exists and has
       already resolved limits twice above with no override present. */
    await ws.writeConfigOverride('rate.rpm.gemma', 2);

    const onWait = vi.fn();
    const pending = limiter.acquire('gemma-4-31b-it', 900, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    expect(onWait).toHaveBeenCalled();
    const [waitMs, reason] = onWait.mock.calls[0];
    expect(reason).toBe('rpm');
    expect(waitMs).toBeGreaterThanOrEqual(60_000);
    await vi.advanceTimersByTimeAsync(waitMs + 1);
    await pending;
  });
});

describe('computeTpmWait', () => {
  const state = (entries: Array<{ ts: number; tokens: number }>) => ({
    rpmWindow: [],
    tpmWindow: entries.map((e) => ({ ...e, pending: false })),
    rpdCount: 0,
    rpdDayKey: '2026-05-16',
    blockUntil: 0,
  });

  it('returns the wait until the oldest entry frees enough headroom', () => {
    /* cap 250K, needed 30K, window 240K (two 120K entries). surplus = 20K,
       freed by the first (oldest) entry, which expires 60 s after its ts. */
    const now = 1_000_000;
    const wait = computeTpmWait(
      state([
        { ts: now - 40_000, tokens: 120_000 },
        { ts: now - 20_000, tokens: 120_000 },
      ]),
      now,
      30_000,
      250_000,
    );
    // oldest entry expires at (now - 40_000) + 60_000 = now + 20_000.
    expect(wait).toBe(20_000);
  });

  it('returns 0 when the request already fits (no surplus)', () => {
    const now = 1_000_000;
    expect(computeTpmWait(state([{ ts: now, tokens: 10_000 }]), now, 30_000, 250_000)).toBe(0);
  });

  it('throws the invariant tripwire if reached with needed > cap (guard bypassed)', () => {
    /* acquire's RC5 guard makes this unreachable in production; assert the
       tripwire fires so a future caller that bypasses it fails loudly
       instead of silently soft-capping. */
    const now = 1_000_000;
    expect(() =>
      computeTpmWait(state([{ ts: now, tokens: 10_000 }]), now, 300_000, 250_000),
    ).toThrow(/invariant violated/);
  });
});
