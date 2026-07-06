/**
 * srv-36 — unit tests for afterChapterFinalized (render-integrity score pass).
 *
 * Covers:
 *   1. Calls scoreBook(bookDir, chapters) when qa.speaker.enabled is true.
 *   2. Two concurrent same-book invocations coalesce into ONE scoreBook run
 *      (single-flight per bookId).
 *   3. Does nothing when qa.speaker.enabled is false.
 *   4. Fire-and-forget: chapter completion must NOT block on the score pass —
 *      a slow/hung scoreBook (the audition-centroid path) used to stall
 *      assembly until the 720s no-progress watchdog killed the chapter (#1029).
 *   5. Finding 2: the post-audition VRAM reconcile fires against the run's
 *      FULL-cast keep-flags (`ctx.keep`) — NOT scoreBook's return — and is
 *      skipped when the run uses no Qwen tier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../audio/render-integrity/aggregate.js', () => ({ scoreBook: vi.fn(async () => {}) }));
/* Mock the reconcile so the post-audition branch is observable and never
   reaches for the sidecar over the network. The other two exports are the ones
   generation.ts imports from this module (mirrors the sibling route tests). */
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: vi.fn(async () => undefined),
  reconcileResidentQwenTiers: vi.fn(async () => undefined),
  SIDECAR_ENGINES: new Set(),
}));

import { scoreBook } from '../audio/render-integrity/aggregate.js';
import { reconcileResidentQwenTiers } from '../tts/ensure-sidecar-loaded.js';
import { afterChapterFinalized } from './generation.js';
import * as cfg from '../config/resolver.js';

const NO_QWEN = { keep06: false, keep17: false };

describe('afterChapterFinalized', () => {
  beforeEach(() => {
    vi.mocked(scoreBook).mockClear();
    vi.mocked(reconcileResidentQwenTiers).mockClear();
  });

  it('calls scoreBook with the bookDir and full chapter list when enabled', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await afterChapterFinalized({
      bookId: 'b1',
      bookDir: '/b1',
      chapters: [{ id: 1, slug: 'ch1' }],
      keep: NO_QWEN,
    });
    expect(scoreBook).toHaveBeenCalledOnce();
    expect(scoreBook).toHaveBeenCalledWith('/b1', [{ id: 1, slug: 'ch1' }]);
  });

  it('coalesces two concurrent same-book invocations into ONE scoreBook run', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    // Both calls run concurrently with the same bookId — single-flight should
    // ensure scoreBook is only invoked once.
    await Promise.all([
      afterChapterFinalized({ bookId: 'b2', bookDir: '/b2', chapters: [{ id: 1, slug: 'ch1' }], keep: NO_QWEN }),
      afterChapterFinalized({ bookId: 'b2', bookDir: '/b2', chapters: [{ id: 1, slug: 'ch1' }], keep: NO_QWEN }),
    ]);
    expect(scoreBook).toHaveBeenCalledTimes(1);
  });

  it('does not block the caller when scoreBook hangs (no-progress watchdog regression — bug #1029)', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    // Simulate the slow/hung audition-centroid score path that stalled chapter
    // assembly for 720s on the 8GB box: scoreBook never resolves.
    vi.mocked(scoreBook).mockImplementationOnce(() => new Promise<void>(() => {}));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.resolve(
        afterChapterFinalized({ bookId: 'hang-1029', bookDir: '/h', chapters: [{ id: 1, slug: 'ch1' }], keep: NO_QWEN }),
      ).then(() => 'resolved' as const),
      new Promise<'blocked'>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 250);
      }),
    ]);
    if (timer) clearTimeout(timer);

    // Fire-and-forget: chapter completion must NOT await the score pass…
    expect(outcome).toBe('resolved');
    // …but the pass WAS still kicked off (just not awaited).
    expect(scoreBook).toHaveBeenCalledTimes(1);
  });

  it('does nothing when qa.speaker.enabled is false', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(false);
    await afterChapterFinalized({
      bookId: 'b3',
      bookDir: '/b3',
      chapters: [{ id: 1, slug: 'ch1' }],
      keep: NO_QWEN,
    });
    expect(scoreBook).not.toHaveBeenCalled();
    expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
  });

  it('reconciles Qwen tiers against the run FULL-cast keep-flags after the score pass (Finding 2)', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    const keep = { keep06: true, keep17: false };
    await afterChapterFinalized({ bookId: 'b4', bookDir: '/b4', chapters: [{ id: 1, slug: 'ch1' }], keep });
    // The reconcile fires in the fire-and-forget tail after scoreBook resolves.
    await vi.waitFor(() => expect(reconcileResidentQwenTiers).toHaveBeenCalledTimes(1));
    // It reconciles against ctx.keep (the run's full-cast set), NOT anything
    // derived from scoreBook's finalized-chapters view (scoreBook returns void).
    expect(reconcileResidentQwenTiers).toHaveBeenCalledWith(keep);
  });

  it('skips the reconcile when the run uses no Qwen tier', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await afterChapterFinalized({ bookId: 'b5', bookDir: '/b5', chapters: [{ id: 1, slug: 'ch1' }], keep: NO_QWEN });
    // Let the score-pass tail run; the reconcile must NOT fire for a no-Qwen run.
    await vi.waitFor(() => expect(scoreBook).toHaveBeenCalledTimes(1));
    expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
  });
});
