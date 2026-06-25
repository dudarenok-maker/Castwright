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
import { runProsodyPasses } from './prosody-thunk';

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
});
