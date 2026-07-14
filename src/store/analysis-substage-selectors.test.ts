import { describe, it, expect } from 'vitest';
import {
  selectProsodyRunningForBook,
  selectReviewRunningForBook,
  selectAnalysisBusyForBook,
  selectAnalysisSubstage,
} from './analysis-substage-selectors';
import type { RootState } from './index';

const mk = (prosody: Record<string, { progress: number; label: string }>, review: Record<string, { progress: number; label: string }>) =>
  ({ prosody: { activeStreams: prosody }, scriptReview: { activeStreams: review } } as unknown as RootState);

describe('analysis-substage selectors', () => {
  it('per-book running flags', () => {
    const s = mk({ b1: { progress: 10, label: 'Detecting emotions' } }, { b2: { progress: 5, label: 'Reviewing' } });
    expect(selectProsodyRunningForBook(s, 'b1')).toBe(true);
    expect(selectProsodyRunningForBook(s, 'b2')).toBe(false);
    expect(selectReviewRunningForBook(s, 'b2')).toBe(true);
    expect(selectAnalysisBusyForBook(s, 'b1')).toBe(true);
    expect(selectAnalysisBusyForBook(s, 'b2')).toBe(true);
    expect(selectAnalysisBusyForBook(s, 'b3')).toBe(false);
  });

  it('selectAnalysisSubstage prefers prosody, then lowest bookId', () => {
    const s = mk(
      { b2: { progress: 40, label: 'Detecting emotions' }, b1: { progress: 70, label: 'Detecting emotions' } },
      { b9: { progress: 5, label: 'Reviewing' } },
    );
    expect(selectAnalysisSubstage(s)).toEqual({ kind: 'prosody', label: 'Detecting emotions', percent: 70 });
  });

  it('falls back to review when no prosody runs; null when idle', () => {
    expect(selectAnalysisSubstage(mk({}, { b5: { progress: 12, label: 'Reviewing' } }))).toEqual({
      kind: 'review',
      label: 'Reviewing',
      percent: 12,
    });
    expect(selectAnalysisSubstage(mk({}, {}))).toBeNull();
  });

  it('selectAnalysisSubstage returns a stable reference for unchanged input (memoized)', () => {
    const s = mk({ b1: { progress: 40, label: 'Detecting emotions' } }, {});
    expect(selectAnalysisSubstage(s)).toBe(selectAnalysisSubstage(s));
  });

  it('selectAnalysisSubstage passes chapterIndex/totalChapters/estRemainingMs through', () => {
    const s = mk(
      {
        b1: {
          progress: 40,
          label: 'Detecting emotions',
          chapterIndex: 3,
          totalChapters: 12,
          estRemainingMs: 60_000,
        } as never,
      },
      {},
    );
    expect(selectAnalysisSubstage(s)).toEqual({
      kind: 'prosody',
      label: 'Detecting emotions',
      percent: 40,
      chapterIndex: 3,
      totalChapters: 12,
      estRemainingMs: 60_000,
    });
  });

  it('omits chapterIndex/totalChapters/estRemainingMs when the entry lacks them', () => {
    const s = mk({}, { b5: { progress: 12, label: 'Reviewing script' } });
    expect(selectAnalysisSubstage(s)).toEqual({
      kind: 'review',
      label: 'Reviewing script',
      percent: 12,
      chapterIndex: undefined,
      totalChapters: undefined,
      estRemainingMs: undefined,
    });
  });

  it('projects model/engine/activityState/activitySince/fallbackActive for a review pass', () => {
    const s = mk(
      {},
      {
        b1: {
          progress: 12,
          label: 'Reviewing script',
          model: 'gemma-4-31b-it',
          engine: 'gemini',
          activityState: 'streaming',
          activitySince: 1000,
          fallbackActive: true,
        } as never,
      },
    );
    const out = selectAnalysisSubstage(s);
    expect(out).toMatchObject({
      kind: 'review',
      model: 'gemma-4-31b-it',
      engine: 'gemini',
      activityState: 'streaming',
      activitySince: 1000,
      fallbackActive: true,
    });
  });
});
