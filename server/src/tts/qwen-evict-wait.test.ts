/* #4568 — the bounded wait a render performs for another op's voice design or variant
   mint before it evicts Qwen. Clock, sleep and counts are injected; nothing here sleeps
   for real. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  QWEN_EVICT_DESIGN_POLL_MS,
  QWEN_EVICT_DESIGN_WAIT_MS,
  waitForDesignMintIdle,
} from './qwen-evict-wait.js';

/** A fake clock whose `sleep` only advances time and counts the calls. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

describe('waitForDesignMintIdle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) does not wait when nothing is in flight', async () => {
    const clock = fakeClock();

    const result = await waitForDesignMintIdle({
      counts: () => ({ design: 0, mint: 0 }),
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result).toEqual({ waited: false, timedOut: false, waitedMs: 0 });
    expect(clock.sleeps).toEqual([]);
  });

  it('(2) polls until a design that is busy for 3 polls goes idle', async () => {
    const clock = fakeClock();

    const result = await waitForDesignMintIdle({
      counts: () => ({ design: clock.sleeps.length < 3 ? 1 : 0, mint: 0 }),
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result).toEqual({
      waited: true,
      timedOut: false,
      waitedMs: 3 * QWEN_EVICT_DESIGN_POLL_MS,
    });
    expect(clock.sleeps).toHaveLength(3);
  });

  it('(3) gives up once the bound elapses while still busy', async () => {
    const clock = fakeClock();

    const result = await waitForDesignMintIdle({
      timeoutMs: 2_500,
      pollMs: 1_000,
      counts: () => ({ design: 1, mint: 0 }),
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.timedOut).toBe(true);
    expect(result.waited).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(2_500);
    // The last poll is clamped to what is left of the bound, so it never overshoots.
    expect(clock.sleeps).toEqual([1_000, 1_000, 500]);
  });

  it('(4) waits on a mint alone', async () => {
    const clock = fakeClock();

    const result = await waitForDesignMintIdle({
      counts: () => ({ design: 0, mint: clock.sleeps.length < 2 ? 1 : 0 }),
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result).toMatchObject({ waited: true, timedOut: false });
    expect(clock.sleeps).toHaveLength(2);
  });

  it('(5) rejects with an AbortError when aborted during the wait', async () => {
    const clock = fakeClock();
    const controller = new AbortController();

    const pending = waitForDesignMintIdle({
      signal: controller.signal,
      timeoutMs: 5_000,
      counts: () => ({ design: 1, mint: 0 }),
      /* A sleep that ignores the signal: the helper must notice the abort itself. */
      sleep: async (ms) => {
        await clock.sleep(ms);
        controller.abort();
      },
      now: clock.now,
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(clock.sleeps).toHaveLength(1);
  });

  it('(6) resolves at once with the real defaults when nothing is registered', async () => {
    await expect(waitForDesignMintIdle()).resolves.toEqual({
      waited: false,
      timedOut: false,
      waitedMs: 0,
    });
  });

  it('rejects an already-aborted signal even when idle', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForDesignMintIdle({
        signal: controller.signal,
        counts: () => ({ design: 0, mint: 0 }),
      }),
    ).rejects.toBe(controller.signal.reason);
  });

  it('the default sleep rejects as soon as the signal fires, mid-poll', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForDesignMintIdle({
      signal: controller.signal,
      counts: () => ({ design: 1, mint: 0 }),
    });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    controller.abort(); // no timer is advanced: only the abort can settle the wait

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the default sleep and clock run the wait to its default bound', async () => {
    vi.useFakeTimers();
    const pending = waitForDesignMintIdle({ counts: () => ({ design: 1, mint: 0 }) });

    await vi.advanceTimersByTimeAsync(QWEN_EVICT_DESIGN_WAIT_MS);

    await expect(pending).resolves.toEqual({
      waited: true,
      timedOut: true,
      waitedMs: QWEN_EVICT_DESIGN_WAIT_MS,
    });
  });

  it('pins the bound under the 600 s call ceiling and the 720 s stall watchdog', () => {
    expect(QWEN_EVICT_DESIGN_WAIT_MS).toBe(180_000);
    expect(QWEN_EVICT_DESIGN_POLL_MS).toBe(1_000);
  });
});
