import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAutoRevert, getTripStatus, _resetTripStatusForTest } from './auto-revert.js';
import * as registry from '../config/registry.js';
import * as resolver from '../config/resolver.js';

/* Task 16/16.5 (#1230 item 2, #2974) — runAutoRevert consumes one
   tripEvent() firing. Card-specific (trip.card = {idx: number}) picks a
   different card (or cpu) for each revertible resident engine and resets
   the sidecar; non-card-specific (null/undefined/malformed) leaves TTS held
   down with a distinct toast. */

describe('runAutoRevert', () => {
  beforeEach(() => {
    _resetTripStatusForTest();
    vi.restoreAllMocks();
  });

  it('card-specific streak, no cached device list: falls back to clearing each engine to auto', async () => {
    const clearOverride = vi.fn().mockResolvedValue(undefined);
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 1 }, residentEngines: ['qwen', 'kokoro'] },
      { clearOverride, writeOverride, resetAndRespawn, getDevices: () => [] },
    );

    expect(clearOverride).toHaveBeenCalledWith('tts.qwen.device');
    expect(clearOverride).toHaveBeenCalledWith('tts.kokoro.device');
    expect(clearOverride).toHaveBeenCalledTimes(2);
    expect(writeOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).toHaveBeenCalledTimes(1);
    expect(status.status).toBe('reverted');
    if (status.status === 'reverted') {
      expect(status.card).toEqual({ idx: 1 });
      expect(status.engines).toEqual(['qwen', 'kokoro']);
      expect(status.toast).toMatch(/auto-reverted/i);
      expect(status.toast).toMatch(/qwen, kokoro/);
    }
    expect(getTripStatus()).toEqual(status);
  });

  it('card-specific streak WITH a cached device list: lands each engine on a DIFFERENT card with enough headroom, never back on the tripped card', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    // card 0 tripped (too small); card 1 has plenty of room for qwen (6500 MB).
    const devices = [
      { uuid: 'GPU-0', idx: 0, freeMb: 500 },
      { uuid: 'GPU-1', idx: 1, freeMb: 12000 },
    ];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: () => devices },
    );

    expect(writeOverride).toHaveBeenCalledWith('tts.qwen.device', 'cuda:1');
    expect(status.status).toBe('reverted');
  });

  it('card-specific streak, no OTHER card has enough room: falls back to cpu, never re-lands on the tripped card', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    const devices = [
      { uuid: 'GPU-0', idx: 0, freeMb: 500 },
      { uuid: 'GPU-1', idx: 1, freeMb: 800 }, // not enough for qwen's 6500 MB
    ];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: () => devices },
    );

    expect(writeOverride).toHaveBeenCalledWith('tts.qwen.device', 'cpu');
    expect(status.status).toBe('reverted');
  });

  it('an env-locked engine is NOT written and NOT counted as reverted — status is failed, not a false reverted, when it is the only resident engine', async () => {
    vi.spyOn(registry, 'getKnob').mockReturnValue({ key: 'tts.qwen.device' } as never);
    vi.spyOn(resolver, 'resolveKnob').mockReturnValue({
      key: 'tts.qwen.device',
      effective: 'cuda:0',
      source: 'env',
      locked: true,
      overridden: false,
    });
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const clearOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, clearOverride, resetAndRespawn, getDevices: () => [] },
    );

    expect(writeOverride).not.toHaveBeenCalled();
    expect(clearOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('failed');
    if (status.status === 'failed') {
      expect(status.toast).toMatch(/environment variable/i);
      expect(status.toast).toMatch(/qwen/);
    }
    expect(getTripStatus()).toEqual(status);
  });

  it('card-specific streak with no revertible engine (only asr/spk resident) still resets, reverts nothing', async () => {
    const clearOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['asr'] },
      { clearOverride, resetAndRespawn, getDevices: () => [] },
    );

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
      seq: expect.any(Number),
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

  it('a malformed card breadcrumb (an object with no numeric idx) is treated as unrevertable, not card-specific', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const clearOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: {}, residentEngines: ['qwen'] },
      { writeOverride, clearOverride, resetAndRespawn, getDevices: () => [] },
    );

    expect(writeOverride).not.toHaveBeenCalled();
    expect(clearOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('unrevertable');
  });

  it('a rejected writeOverride reaches a failed status, never an uncaught throw, and does not call resetAndRespawn', async () => {
    const writeOverride = vi.fn().mockRejectedValue(new Error('disk full'));
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    const devices = [{ uuid: 'GPU-1', idx: 1, freeMb: 12000 }];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: () => devices },
    );

    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('failed');
    expect(getTripStatus()).toEqual(status);
  });

  it('a rejected resetAndRespawn (config already written) reaches a failed status, never an uncaught throw', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const devices = [{ uuid: 'GPU-1', idx: 1, freeMb: 12000 }];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: () => devices },
    );

    expect(writeOverride).toHaveBeenCalledTimes(1);
    expect(status.status).toBe('failed');
    expect(getTripStatus()).toEqual(status);
  });
});

/* ── Mutation check (task item 3) ─────────────────────────────────────────
   Actually run, not just asserted: inverted the card-specific branch guard
   in auto-revert.ts from
     if (!isTrippedCardIdx(trip.card))
   to
     if (isTrippedCardIdx(trip.card))
   and re-ran `vitest run src/gpu/auto-revert.test.ts` (server workspace).
   All 10 cases reddened (10/10 failed) — the mutation swaps which branch
   every fixture takes, so every assertion tied to that branch flips: the
   card-specific fixtures (real revert, env-lock, rejected-dependency cases)
   fell into the null-card early return and reported 'unrevertable' instead
   of 'reverted'/'failed'; the null/undefined-card fixtures fell into the
   card-specific branch and called the revert deps that should never fire
   for them. Confirms the guard is load-bearing for every fixture in this
   file, not just the malformed-shape one it was added for.

   Reverted the mutation immediately after capturing this output; the
   committed auto-revert.ts has the original (correct) guard, confirmed
   green again (10 passed) before this commit. */
