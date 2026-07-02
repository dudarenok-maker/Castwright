/* Task 10 (fs-65 Phase 3) — unit tests for runProsodyPasses thunk.

   TDD contract:
   - calls api.detectEmotions then api.detectInstruct in order
   - dispatches applyDetectedEmotions per annotation from pass 1
   - dispatches applyDetectedInstruct per annotation from pass 2
   - a chapter-failed event from either pass increments `failed`
   - resolves (does NOT throw) on partial failure */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mock api before importing the thunk ---
vi.mock('../lib/api', () => ({
  api: {
    detectEmotions: vi.fn(),
    detectInstruct: vi.fn(),
  },
}));

import { api } from '../lib/api';
import type { DetectEmotionsOpts, DetectInstructOpts } from '../lib/api';
import { manuscriptActions } from './manuscript-slice';
import { runProsodyPasses, buildProsodyProgressPayload } from './prosody-thunk';

const EMPTY_EMOTIONS = { totalAnnotations: 0, annotatedChapters: 0 };
const EMPTY_INSTRUCT = { totalAnnotations: 0, annotatedChapters: 0 };

describe('runProsodyPasses', () => {
  const bookId = 'book-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls detectEmotions then detectInstruct in order', async () => {
    const callOrder: string[] = [];
    vi.mocked(api.detectEmotions).mockImplementation(async () => {
      callOrder.push('emotions');
      return EMPTY_EMOTIONS;
    });
    vi.mocked(api.detectInstruct).mockImplementation(async () => {
      callOrder.push('instruct');
      return EMPTY_INSTRUCT;
    });

    const dispatch = vi.fn();
    await runProsodyPasses(bookId, { dispatch });

    expect(callOrder).toEqual(['emotions', 'instruct']);
  });

  it('dispatches applyDetectedEmotions for each emotion annotation', async () => {
    const emotionAnnotation = { chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'angry' }] };
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onAnnotation?.(emotionAnnotation);
        return { totalAnnotations: 1, annotatedChapters: 1 };
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    await runProsodyPasses(bookId, { dispatch });

    expect(dispatch).toHaveBeenCalledWith(
      manuscriptActions.applyDetectedEmotions(emotionAnnotation),
    );
  });

  it('dispatches applyDetectedInstruct for each instruct annotation', async () => {
    const instructAnnotation = {
      chapterId: 2,
      annotations: [{ sentenceId: 3, text: 'Ah!', instruct: 'gasp', vocalization: true }],
    };
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS);
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onAnnotation?.(instructAnnotation);
        return { totalAnnotations: 1, annotatedChapters: 1 };
      },
    );

    const dispatch = vi.fn();
    await runProsodyPasses(bookId, { dispatch });

    expect(dispatch).toHaveBeenCalledWith(
      manuscriptActions.applyDetectedInstruct(instructAnnotation),
    );
  });

  it('increments failed when detectEmotions reports a chapter-failed', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onChapterFailed?.({ chapterId: 5, message: 'Chapter annotation failed.' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const result = await runProsodyPasses(bookId, { dispatch });

    expect(result.failed).toBe(1);
  });

  it('increments failed when detectInstruct reports a chapter-failed', async () => {
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS);
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onChapterFailed?.({ chapterId: 3, message: 'Chapter annotation failed.' });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const result = await runProsodyPasses(bookId, { dispatch });

    expect(result.failed).toBe(1);
  });

  it('sums failed across both passes', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onChapterFailed?.({ chapterId: 1, message: 'fail' });
        opts.onChapterFailed?.({ chapterId: 2, message: 'fail' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onChapterFailed?.({ chapterId: 3, message: 'fail' });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const result = await runProsodyPasses(bookId, { dispatch });

    expect(result.failed).toBe(3);
  });

  it('resolves (does NOT throw) on partial failure', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onChapterFailed?.({ chapterId: 1, message: 'fail' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onChapterFailed?.({ chapterId: 2, message: 'fail' });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    await expect(runProsodyPasses(bookId, { dispatch })).resolves.toMatchObject({ failed: 2 });
  });

  it('returns correct totalAnnotations and totalChapters', async () => {
    const emo1 = { chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'happy' }] };
    const emo2 = { chapterId: 1, annotations: [{ sentenceId: 2, emotion: 'sad' }] };
    const inst1 = { chapterId: 2, annotations: [{ sentenceId: 10, instruct: 'sigh' }] };
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onAnnotation?.(emo1);
        opts.onAnnotation?.(emo2);
        return { totalAnnotations: 2, annotatedChapters: 1 };
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onAnnotation?.(inst1);
        return { totalAnnotations: 1, annotatedChapters: 2 };
      },
    );

    const dispatch = vi.fn();
    const result = await runProsodyPasses(bookId, { dispatch });

    expect(result.totalAnnotations).toBe(3); // 2 + 1
    expect(result.totalChapters).toBe(2);    // max(1, 2)
    expect(result.failed).toBe(0);
  });

  it('forwards signal to both api calls', async () => {
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS);
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const controller = new AbortController();
    await runProsodyPasses(bookId, { dispatch, signal: controller.signal });

    expect(vi.mocked(api.detectEmotions).mock.calls[0][1]).toMatchObject({
      signal: controller.signal,
    });
    expect(vi.mocked(api.detectInstruct).mock.calls[0][1]).toMatchObject({
      signal: controller.signal,
    });
  });

  it('works without a signal (Task 13 detached path)', async () => {
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS);
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    // No signal passed — must not throw
    await expect(runProsodyPasses(bookId, { dispatch })).resolves.toMatchObject({ failed: 0 });
  });

  it('calls onProgress with 0–1 fraction during both passes', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 0.5 });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onPhase?.({ progress: 1.0 });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const progressValues: number[] = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (f) => progressValues.push(f) });

    // emotions at 0.5 progress → fraction 0.25 (0.5 * 0.5)
    // instruct at 1.0 progress → fraction 1.0 (0.5 + 1.0 * 0.5)
    expect(progressValues).toEqual([0.25, 1.0]);
  });

  it('forwards onPhase label strings to onStatus', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 0.5, label: 'Detecting emotions — chapter 3' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onPhase?.({ progress: 1.0, label: 'Instruct — chapter 5' });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const statusValues: string[] = [];
    await runProsodyPasses(bookId, { dispatch, onStatus: (s) => statusValues.push(s) });

    // Pass 1 label, then inter-pass message, then pass 2 label
    expect(statusValues).toEqual([
      'Detecting emotions — chapter 3',
      'Adding natural reactions…',
      'Instruct — chapter 5',
    ]);
  });

  it('does NOT call onStatus for onPhase events without a label', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 0.5 }); // no label
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const statusValues: string[] = [];
    await runProsodyPasses(bookId, { dispatch, onStatus: (s) => statusValues.push(s) });

    // Only the inter-pass message fires (no label from pass 1)
    expect(statusValues).toEqual(['Adding natural reactions…']);
  });

  it('always calls onStatus with the inter-pass message between pass 1 and pass 2', async () => {
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS);
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const statusValues: string[] = [];
    await runProsodyPasses(bookId, { dispatch, onStatus: (s) => statusValues.push(s) });

    expect(statusValues).toEqual(['Adding natural reactions…']);
  });

  it('forwards onThrottle from pass 1 to the opts onThrottle callback', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onThrottle?.({ chapterId: 2, waitMs: 2000, reason: 'rate-limit' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const onThrottle = vi.fn();
    await runProsodyPasses(bookId, { dispatch, onThrottle });

    expect(onThrottle).toHaveBeenCalledTimes(1);
  });

  it('forwards onThrottle from pass 2 to the opts onThrottle callback', async () => {
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS);
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onThrottle?.({ chapterId: 4, waitMs: 1500, reason: 'rate-limit' });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const onThrottle = vi.fn();
    await runProsodyPasses(bookId, { dispatch, onThrottle });

    expect(onThrottle).toHaveBeenCalledTimes(1);
  });

  it('does not throw when onStatus and onThrottle are absent (Task 13 path)', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 0.5, label: 'Detecting emotions — chapter 1' });
        opts.onThrottle?.({ chapterId: 1, waitMs: 1000, reason: 'rate-limit' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    // Neither onStatus nor onThrottle passed — must not throw
    await expect(runProsodyPasses(bookId, { dispatch })).resolves.toMatchObject({ failed: 0 });
  });

  it('combines pass-1 remaining + pass-1-total-as-pass-2-proxy for the ETA while pass 1 runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        vi.setSystemTime(4000); // 4s elapsed since pass 1 started
        opts.onPhase?.({ progress: 0.5, estRemainingMs: 1000 });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const details: Array<{ estRemainingMs?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });
    vi.useRealTimers();

    // combined = own-remaining(1000) + pass1-total-as-proxy(elapsed 4000 + remaining 1000) = 6000
    expect(details[0]?.estRemainingMs).toBe(6000);
  });

  it('freezes at the pass-1 projection until pass 2 produces its own estimate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        vi.setSystemTime(2000);
        opts.onPhase?.({ progress: 1, estRemainingMs: 0 }); // pass 1 finishing
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onPhase?.({ progress: 0.1 }); // pass 2's first chapter — no own estimate yet
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const details: Array<{ estRemainingMs?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });
    vi.useRealTimers();

    // pass-1 combined = 0 + (elapsed 2000 + remaining 0) = 2000; frozen through pass 2's first tick
    expect(details[0]?.estRemainingMs).toBe(2000);
    expect(details[1]?.estRemainingMs).toBe(2000);
  });

  it('uses pass 2 own estRemainingMs once pass 2 reports one, ignoring the pass-1 proxy', async () => {
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS); // no onPhase calls
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onPhase?.({ progress: 0.5, estRemainingMs: 500 });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const details: Array<{ estRemainingMs?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });

    expect(details[0]?.estRemainingMs).toBe(500);
  });

  it('forwards chapterIndex/totalChapters/label from each pass onProgress detail', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 0.5, chapterIndex: 3, totalChapters: 12, label: 'Detecting emotions' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const details: Array<{ chapterIndex?: number; totalChapters?: number; label?: string } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });

    expect(details[0]).toMatchObject({ chapterIndex: 3, totalChapters: 12, label: 'Detecting emotions' });
  });

  it('pins totalChapters to pass 1\'s value when pass 2 reports a SMALLER totalChapters (a chapter got excluded between passes)', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 1, chapterIndex: 5, totalChapters: 5 });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        // Simulates a chapter being excluded in the gap between passes —
        // pass 2's own server-recomputed totalChapters is now smaller.
        opts.onPhase?.({ progress: 0.5, chapterIndex: 2, totalChapters: 4 });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const details: Array<{ chapterIndex?: number; totalChapters?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });

    expect(details[0]).toMatchObject({ chapterIndex: 5, totalChapters: 5 });
    // Pass 2's raw totalChapters (4) is NOT what's shown — it stays pinned
    // to pass 1's value (5), so the counter never visibly jumps/shrinks.
    expect(details[1]).toMatchObject({ chapterIndex: 2, totalChapters: 5 });
  });

  it('widens the pinned totalChapters if pass 2 genuinely covers MORE chapters than pass 1 (a chapter got un-excluded between passes)', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 1, chapterIndex: 4, totalChapters: 4 });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        // Simulates a chapter being un-excluded in the gap between passes —
        // pass 2 now covers a 5th chapter, exceeding pass 1's pinned total.
        opts.onPhase?.({ progress: 1, chapterIndex: 5, totalChapters: 5 });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const details: Array<{ chapterIndex?: number; totalChapters?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });

    expect(details[0]).toMatchObject({ chapterIndex: 4, totalChapters: 4 });
    // Pinned value widens to 5 so chapterIndex (5) never exceeds the
    // displayed total — no stale "Chapter 5 of 4".
    expect(details[1]).toMatchObject({ chapterIndex: 5, totalChapters: 5 });
  });
});

describe('buildProsodyProgressPayload', () => {
  const bookId = 'book-1';

  it('maps a full SubstageDetail into the updateProgress payload shape', () => {
    const detail = {
      label: 'Detecting emotions',
      chapterIndex: 2,
      totalChapters: 5,
      estRemainingMs: 12_000,
    };

    expect(buildProsodyProgressPayload(bookId, 0.5, detail)).toEqual({
      bookId,
      progress: 0.5,
      label: 'Detecting emotions',
      chapterIndex: 2,
      totalChapters: 5,
      estRemainingMs: 12_000,
    });
  });

  it('maps an undefined detail into a payload with undefined optional fields', () => {
    expect(buildProsodyProgressPayload(bookId, 0.25, undefined)).toEqual({
      bookId,
      progress: 0.25,
      label: undefined,
      chapterIndex: undefined,
      totalChapters: undefined,
      estRemainingMs: undefined,
    });
  });

  it('passes through a partially-populated detail field-by-field', () => {
    expect(buildProsodyProgressPayload(bookId, 0.75, { label: 'Adding natural reactions…' })).toEqual({
      bookId,
      progress: 0.75,
      label: 'Adding natural reactions…',
      chapterIndex: undefined,
      totalChapters: undefined,
      estRemainingMs: undefined,
    });
  });
});
