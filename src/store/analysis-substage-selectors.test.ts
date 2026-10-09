import { describe, it, expect } from 'vitest';
import {
  selectProsodyRunningForBook,
  selectReviewRunningForBook,
  selectAnalysisBusyForBook,
  selectAnalysisSubstage,
  selectBookHasForegroundWork,
  analysisBusyMessage,
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

  it('#3435 — a background prosody run (the open-book re-run) never makes its book busy', () => {
    const s = mk({ b1: { progress: 10, label: 'Detecting emotions', background: true } as never }, {});
    expect(selectProsodyRunningForBook(s, 'b1')).toBe(false);
    expect(selectAnalysisBusyForBook(s, 'b1')).toBe(false);
    expect(analysisBusyMessage(s, 'b1')).toBeNull();
    // ...but it still shows in the pill.
    expect(selectAnalysisSubstage(s)).toMatchObject({ kind: 'prosody', percent: 10 });
  });

  it('#3435 — foreground work: anything the user started on the book', () => {
    const base = mk({}, {}) as unknown as Record<string, unknown>;
    const st = (over: Record<string, unknown>) => ({ ...base, ...over }) as unknown as RootState;
    expect(selectBookHasForegroundWork(st({}), 'b1')).toBe(false);
    // a background prosody run of its own is not foreground work
    expect(
      selectBookHasForegroundWork(
        st({ prosody: { activeStreams: { b1: { progress: 0, label: 'x', background: true } } } }),
        'b1',
      ),
    ).toBe(false);
    expect(
      selectBookHasForegroundWork(st({ prosody: { activeStreams: { b1: { progress: 0, label: 'x' } } } }), 'b1'),
    ).toBe(true);
    expect(
      selectBookHasForegroundWork(st({ scriptReview: { activeStreams: { b1: { progress: 0, label: 'x' } } } }), 'b1'),
    ).toBe(true);
    const entry = (bookId: string, status: string) => ({ id: 'q', bookId, chapterId: 1, status });
    expect(selectBookHasForegroundWork(st({ queue: { entries: [entry('b1', 'queued')] } }), 'b1')).toBe(true);
    expect(selectBookHasForegroundWork(st({ queue: { entries: [entry('b1', 'in_progress')] } }), 'b1')).toBe(true);
    expect(selectBookHasForegroundWork(st({ queue: { entries: [entry('b1', 'done')] } }), 'b1')).toBe(false);
    expect(selectBookHasForegroundWork(st({ queue: { entries: [entry('b2', 'queued')] } }), 'b1')).toBe(false);
    expect(
      selectBookHasForegroundWork(st({ chapters: { activeStreams: { 'b1::1': { bookId: 'b1' } } } }), 'b1'),
    ).toBe(true);
    expect(
      selectBookHasForegroundWork(st({ chapters: { activeStreams: { 'b2::1': { bookId: 'b2' } } } }), 'b1'),
    ).toBe(false);
    expect(
      selectBookHasForegroundWork(st({ castDesign: { active: { bookId: 'b1', state: 'running' } } }), 'b1'),
    ).toBe(true);
    expect(
      selectBookHasForegroundWork(st({ castDesign: { active: { bookId: 'b1', state: 'done' } } }), 'b1'),
    ).toBe(false);
    // an analysis run (main or subset) for the book, while it runs
    const run = (bookId: string, state: string, kind?: string) => ({
      analysis: { activeStream: { bookId, manuscriptId: `mns_${bookId}`, state, ...(kind ? { kind } : {}) } },
    });
    expect(selectBookHasForegroundWork(st(run('b1', 'running')), 'b1')).toBe(true);
    expect(selectBookHasForegroundWork(st(run('b1', 'running', 'subset')), 'b1')).toBe(true);
    expect(selectBookHasForegroundWork(st(run('b1', 'halted')), 'b1')).toBe(false);
    expect(selectBookHasForegroundWork(st(run('b2', 'running')), 'b1')).toBe(false);
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
