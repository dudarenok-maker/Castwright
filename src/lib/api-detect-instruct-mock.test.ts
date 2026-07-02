/* Whole-branch review Finding 2 — mock chapter counts must agree across the
   two "Detect emotions" passes.

   mockDetectEmotions emits totalChapters: 2 (chapterIndex 1 then 2), but
   mockDetectInstruct used to emit totalChapters: 1. Since both passes walk
   the SAME chapter list against a real backend, that mismatch was internally
   implausible mock data — and it had a real visible consequence:
   formatSubstageDetail's formatChapterCount(1, 1) returns null for a 1-of-1
   case, so the chapter counter disappeared during the instruct pass under
   VITE_USE_MOCKS=true instead of resetting from "N of M" back to "1 of M"
   like docs/features/236-prosody-review-progress-detail.md describes. */

import { describe, it, expect, vi } from 'vitest';

// Force mock mode so `api` resolves to the mock object (not the real fetch-based one).
vi.stubEnv('VITE_USE_MOCKS', 'true');

// Must be a dynamic import AFTER stubEnv so the module sees the stubbed env.
const { api } = await import('./api');

describe('mock detectInstruct — chapter count matches mockDetectEmotions (Finding 2)', () => {
  it('emits totalChapters: 2 across two phase ticks, chapterIndex 1 then 2', async () => {
    const phases: Array<{ chapterIndex?: number; totalChapters?: number }> = [];
    await api.detectInstruct('book1', {
      onPhase: (e) => phases.push({ chapterIndex: e.chapterIndex, totalChapters: e.totalChapters }),
    });

    const chapterTicks = phases.filter((p) => p.chapterIndex !== undefined);
    expect(chapterTicks.length).toBeGreaterThanOrEqual(2);
    expect(chapterTicks.every((p) => p.totalChapters === 2)).toBe(true);
    expect(chapterTicks.map((p) => p.chapterIndex)).toEqual([1, 2]);
  });

  it('matches mockDetectEmotions\' totalChapters so the counter never disappears at the pass boundary', async () => {
    const emotionPhases: Array<number | undefined> = [];
    await api.detectEmotions('book1', {
      onPhase: (e) => emotionPhases.push(e.totalChapters),
    });
    const emotionTotal = emotionPhases.find((t) => t !== undefined);

    const instructPhases: Array<number | undefined> = [];
    await api.detectInstruct('book1', {
      onPhase: (e) => instructPhases.push(e.totalChapters),
    });
    const instructTotal = instructPhases.find((t) => t !== undefined);

    expect(instructTotal).toBe(emotionTotal);
  });
});
