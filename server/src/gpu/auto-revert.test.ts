import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAutoRevert, getTripStatus, _resetTripStatusForTest } from './auto-revert.js';

/* Task 16/16.5 (#1230 item 2, #2974) — runAutoRevert consumes one
   tripEvent() firing. Card-specific (trip.card !== null) reverts the
   offending engines' device pins and resets the sidecar; non-card-specific
   (trip.card === null) leaves TTS held down with a distinct toast. */

describe('runAutoRevert', () => {
  beforeEach(() => {
    _resetTripStatusForTest();
  });

  it('card-specific streak: reverts each resident engine device pin and resets+respawns', async () => {
    const clearOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: 1, residentEngines: ['qwen', 'kokoro'] },
      { clearOverride, resetAndRespawn },
    );

    expect(clearOverride).toHaveBeenCalledWith('tts.qwen.device');
    expect(clearOverride).toHaveBeenCalledWith('tts.kokoro.device');
    expect(clearOverride).toHaveBeenCalledTimes(2);
    expect(resetAndRespawn).toHaveBeenCalledTimes(1);
    expect(status.status).toBe('reverted');
    if (status.status === 'reverted') {
      expect(status.card).toBe(1);
      expect(status.engines).toEqual(['qwen', 'kokoro']);
      expect(status.toast).toMatch(/auto-reverted/i);
      expect(status.toast).toMatch(/qwen, kokoro/);
    }
    // Recorded for a later GET /api/gpu/trip-status read.
    expect(getTripStatus()).toEqual(status);
  });

  it('card-specific streak with no revertible engine (only asr/spk resident) still resets, reverts nothing', async () => {
    const clearOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert({ card: 0, residentEngines: ['asr'] }, { clearOverride, resetAndRespawn });

    expect(clearOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).toHaveBeenCalledTimes(1);
    expect(status.status).toBe('reverted');
    if (status.status === 'reverted') expect(status.engines).toEqual([]);
  });

  it('non-card-specific streak: does NOT revert or respawn, surfaces the distinct unrevertable toast', async () => {
    const clearOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: null, residentEngines: ['qwen'] },
      { clearOverride, resetAndRespawn },
    );

    expect(clearOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status).toEqual({
      status: 'unrevertable',
      toast: expect.stringMatching(/not tied to a specific gpu card/i),
    });
    expect(getTripStatus()).toEqual(status);
  });

  it('non-card-specific streak with an undefined card (degraded breadcrumb) is treated the same as null', async () => {
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    const status = await runAutoRevert(
      { card: undefined, residentEngines: [] },
      { resetAndRespawn },
    );
    expect(status.status).toBe('unrevertable');
    expect(resetAndRespawn).not.toHaveBeenCalled();
  });
});

/* ── Mutation check (task item 3) ─────────────────────────────────────────
   Actually run, not just asserted: inverted the card-specific branch guard
   in auto-revert.ts from
     if (trip.card === null || trip.card === undefined)
   to
     if (!(trip.card === null || trip.card === undefined))
   and re-ran `vitest run src/gpu/auto-revert.test.ts` (server workspace).
   All 4 cases reddened as expected — the mutation swaps which branch each
   fixture takes, so every assertion tied to that branch flips:

     FAIL  card-specific streak: reverts each resident engine device pin and
     resets+respawns
       AssertionError: expected "vi.fn()" to be called with arguments:
       [ 'tts.qwen.device' ]
       Number of calls: 0

     FAIL  card-specific streak with no revertible engine ... still resets,
     reverts nothing
       AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
         expect(resetAndRespawn).toHaveBeenCalledTimes(1);

     FAIL  non-card-specific streak: does NOT revert or respawn, surfaces the
     distinct unrevertable toast
       AssertionError: expected "vi.fn()" to not be called at all, but
       actually been called 1 times
         Received: 1st vi.fn() call: [ "tts.qwen.device" ]

     FAIL  non-card-specific streak with an undefined card (degraded
     breadcrumb) is treated the same as null
       AssertionError: expected 'reverted' to be 'unrevertable'

   Reverted the mutation immediately after capturing this output; the
   committed auto-revert.ts has the original (correct) guard, confirmed
   green again (4 passed) before this commit. */
