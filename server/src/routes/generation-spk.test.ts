/**
 * srv-36 — unit tests for afterChapterFinalized (render-integrity score pass).
 *
 * Covers:
 *   1. Calls scoreBook(bookDir, chapters) when qa.speaker.enabled is true.
 *   2. Two concurrent same-book invocations coalesce into ONE scoreBook run
 *      (single-flight per bookId).
 *   3. Does nothing when qa.speaker.enabled is false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../audio/render-integrity/aggregate.js', () => ({ scoreBook: vi.fn(async () => {}) }));

import { scoreBook } from '../audio/render-integrity/aggregate.js';
import { afterChapterFinalized } from './generation.js';
import * as cfg from '../config/resolver.js';

describe('afterChapterFinalized', () => {
  beforeEach(() => {
    vi.mocked(scoreBook).mockClear();
  });

  it('calls scoreBook with the bookDir and full chapter list when enabled', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await afterChapterFinalized({
      bookId: 'b1',
      bookDir: '/b1',
      chapters: [{ id: 1, slug: 'ch1' }],
    });
    expect(scoreBook).toHaveBeenCalledOnce();
    expect(scoreBook).toHaveBeenCalledWith('/b1', [{ id: 1, slug: 'ch1' }]);
  });

  it('coalesces two concurrent same-book invocations into ONE scoreBook run', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    // Both calls run concurrently with the same bookId — single-flight should
    // ensure scoreBook is only invoked once.
    await Promise.all([
      afterChapterFinalized({ bookId: 'b2', bookDir: '/b2', chapters: [{ id: 1, slug: 'ch1' }] }),
      afterChapterFinalized({ bookId: 'b2', bookDir: '/b2', chapters: [{ id: 1, slug: 'ch1' }] }),
    ]);
    expect(scoreBook).toHaveBeenCalledTimes(1);
  });

  it('does nothing when qa.speaker.enabled is false', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(false);
    await afterChapterFinalized({
      bookId: 'b3',
      bookDir: '/b3',
      chapters: [{ id: 1, slug: 'ch1' }],
    });
    expect(scoreBook).not.toHaveBeenCalled();
  });
});
