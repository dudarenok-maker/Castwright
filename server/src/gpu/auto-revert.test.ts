import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAutoRevert, getTripStatus, _resetTripStatusForTest } from './auto-revert.js';
import * as registry from '../config/registry.js';
import * as resolver from '../config/resolver.js';

/* Task 16/16.5 (#1230 item 2, #2974) — runAutoRevert consumes one
   tripEvent() firing. Card-specific with at least one revertible
   (qwen/coqui/kokoro) resident engine picks a different card (or cpu) for
   each and resets the sidecar; everything else (no card, a malformed card,
   or a known card with nothing revertible resident) leaves TTS held down
   with a distinct toast. */

describe('runAutoRevert', () => {
  beforeEach(() => {
    _resetTripStatusForTest();
    vi.restoreAllMocks();
  });

  it('card-specific streak, no cached device list: falls back to clearing each engine to cpu', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 1 }, residentEngines: ['qwen', 'kokoro'] },
      { writeOverride, resetAndRespawn, getDevices: async () => [] },
    );

    expect(writeOverride).toHaveBeenCalledWith('tts.qwen.device', 'cpu');
    expect(writeOverride).toHaveBeenCalledWith('tts.kokoro.device', 'cpu');
    expect(writeOverride).toHaveBeenCalledTimes(2);
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

  it('card-specific streak WITH a live device list: lands each engine on a DIFFERENT card with enough headroom, using the canonical cuda-uuid form', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    // card 0 tripped (too small); card 1 has plenty of room for qwen (6500 MB).
    const devices = [
      { idx: 0, uuid: 'GPU-0', freeMb: 500 },
      { idx: 1, uuid: 'GPU-1', freeMb: 12000 },
    ];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: async () => devices },
    );

    expect(writeOverride).toHaveBeenCalledWith('tts.qwen.device', 'cuda-uuid:GPU-1');
    expect(status.status).toBe('reverted');
  });

  it('falls back to the bare cuda:N form when the chosen candidate has no known uuid', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    const devices = [
      { idx: 0, uuid: null, freeMb: 500 },
      { idx: 1, uuid: null, freeMb: 12000 },
    ];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: async () => devices },
    );

    expect(writeOverride).toHaveBeenCalledWith('tts.qwen.device', 'cuda:1');
    expect(status.status).toBe('reverted');
  });

  it('a running budget correctly falls back to cpu for the SECOND engine once the shared candidate card is exhausted', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    // Card 1 has room for qwen (6500) alone, but not qwen + kokoro (7500)
    // together — the second engine must fall back to cpu, not double-book
    // card 1 against its ORIGINAL 7000 MB reading.
    const devices = [
      { idx: 0, uuid: 'GPU-0', freeMb: 500 },
      { idx: 1, uuid: 'GPU-1', freeMb: 7000 },
    ];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen', 'kokoro'] },
      { writeOverride, resetAndRespawn, getDevices: async () => devices },
    );

    expect(writeOverride).toHaveBeenCalledWith('tts.qwen.device', 'cuda-uuid:GPU-1');
    expect(writeOverride).toHaveBeenCalledWith('tts.kokoro.device', 'cpu');
    expect(status.status).toBe('reverted');
  });

  it('card-specific streak, no OTHER card has enough room: falls back to cpu, never re-lands on the tripped card', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    const devices = [
      { idx: 0, uuid: 'GPU-0', freeMb: 500 },
      { idx: 1, uuid: 'GPU-1', freeMb: 800 }, // not enough for qwen's 6500 MB
    ];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: async () => devices },
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
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: async () => [] },
    );

    expect(writeOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('failed');
    if (status.status === 'failed') {
      expect(status.toast).toMatch(/environment variable/i);
      expect(status.toast).toMatch(/qwen/);
    }
    expect(getTripStatus()).toEqual(status);
  });

  it('card-specific streak with NO revertible engine resident (only asr/spk) is unrevertable and does NOT respawn — respawning would just repeat whatever actually crashed', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['asr'] },
      { writeOverride, resetAndRespawn, getDevices: async () => [] },
    );

    expect(writeOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('unrevertable');
    if (status.status === 'unrevertable') {
      expect(status.toast).toMatch(/no tts engine was resident/i);
    }
  });

  it('card-specific streak with an EMPTY resident-engines list is unrevertable and does NOT respawn', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: [] },
      { writeOverride, resetAndRespawn, getDevices: async () => [] },
    );

    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('unrevertable');
  });

  it('non-card-specific streak: does NOT revert or respawn, surfaces the distinct unrevertable toast', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: null, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn },
    );

    expect(writeOverride).not.toHaveBeenCalled();
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
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: {}, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: async () => [] },
    );

    expect(writeOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('unrevertable');
  });

  it('a rejected writeOverride reaches a failed status, never an uncaught throw, and does not call resetAndRespawn', async () => {
    const writeOverride = vi.fn().mockRejectedValue(new Error('disk full'));
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);
    const devices = [{ idx: 1, uuid: 'GPU-1', freeMb: 12000 }];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: async () => devices },
    );

    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('failed');
    expect(getTripStatus()).toEqual(status);
  });

  it('a rejected resetAndRespawn (config already written) reaches a failed status, never an uncaught throw', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const devices = [{ idx: 1, uuid: 'GPU-1', freeMb: 12000 }];

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      { writeOverride, resetAndRespawn, getDevices: async () => devices },
    );

    expect(writeOverride).toHaveBeenCalledTimes(1);
    expect(status.status).toBe('failed');
    expect(getTripStatus()).toEqual(status);
  });

  it('a rejected getDevices() fetch reaches a failed status, never an uncaught throw', async () => {
    const writeOverride = vi.fn().mockResolvedValue(undefined);
    const resetAndRespawn = vi.fn().mockResolvedValue(undefined);

    const status = await runAutoRevert(
      { card: { idx: 0 }, residentEngines: ['qwen'] },
      {
        writeOverride,
        resetAndRespawn,
        getDevices: async () => {
          throw new Error('sidecar unreachable');
        },
      },
    );

    expect(writeOverride).not.toHaveBeenCalled();
    expect(resetAndRespawn).not.toHaveBeenCalled();
    expect(status.status).toBe('failed');
  });
});

/* ── Mutation check (task item 3) ─────────────────────────────────────────
   Actually run, not just asserted: inverted the card-specific branch guard
   in auto-revert.ts from
     if (!isTrippedCardIdx(trip.card))
   to
     if (isTrippedCardIdx(trip.card))
   and re-ran `vitest run src/gpu/auto-revert.test.ts` (server workspace).
   12 of 14 cases reddened, with `--reporter=verbose` used to identify the
   exact 2 survivors, not just the aggregate count. The mutation swaps which
   branch every fixture takes, so most assertions tied to that branch flip:
   the card-specific fixtures (real revert, env-lock, rejected-dependency
   cases) fell into the unrevertable early return; the null-card fixture fell
   into the card-specific branch and called revert deps that should never
   fire for it.

   The 2 survivors are coincidental convergence with the SEPARATE
   zero-revertible-engines guard a few lines below this one, not evidence
   this guard is dead for them: "EMPTY resident-engines list" uses
   `card: {idx: 0}` (a VALID idx) with `residentEngines: []` — under the
   mutation this card wrongly takes the unrevertable early return, but the
   real code, taking the correct branch, would also land on 'unrevertable'
   via the zero-engines guard instead, so the final assertion can't tell the
   two apart. "undefined card (degraded breadcrumb)" also sets
   `residentEngines: []` — under the mutation it wrongly skips the early
   return and falls into the card-specific try block, but that block's own
   `engines.length === 0` check (fed by the same empty residentEngines) still
   produces 'unrevertable', again matching by coincidence rather than by this
   guard doing its job. Both fixtures happen not to isolate isTrippedCardIdx
   from the zero-engines guard — a residentEngines value that only ONE of
   the two guards would catch is needed to fully separate them, which these
   two pre-existing fixtures don't provide.

   Reverted the mutation immediately after capturing this output; the
   committed auto-revert.ts has the original (correct) guard, confirmed
   green again (14 passed) before this commit.

   Second mutation, same discipline: changed the separate
   `if (engines.length === 0)` guard a few lines below isTrippedCardIdx's
   check to `if (engines.length === 999)` (an unreachable condition) and
   re-ran the same file. Exactly the 2 fixtures the first mutation couldn't
   isolate — "EMPTY resident-engines list" and "NO revertible engine
   resident (only asr/spk)" — reddened (`expected 'failed' to be
   'unrevertable'`, since with the guard disabled both fall through into the
   try block and hit `reverted.length === 0` after the env-lock loop
   no-ops on nothing, landing on the env-lock 'failed' message instead).
   Together with the first mutation, every fixture in this file is now
   confirmed sensitive to at least one of the two guards. Reverted
   immediately; confirmed green again (14 passed) before this commit. */
