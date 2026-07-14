import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './index';
import type { SubstageEntry } from './prosody-slice';

export const selectProsodyRunningForBook = (state: RootState, bookId: string): boolean =>
  !!state.prosody?.activeStreams && bookId in state.prosody.activeStreams;

export const selectReviewRunningForBook = (state: RootState, bookId: string): boolean =>
  !!state.scriptReview?.activeStreams && bookId in state.scriptReview.activeStreams;

export const selectAnalysisBusyForBook = (state: RootState, bookId: string): boolean =>
  selectProsodyRunningForBook(state, bookId) || selectReviewRunningForBook(state, bookId);

/** User-facing "why is Generate blocked" copy for a busy book — per-pass
    wording (spec copy). Returns null when the book isn't busy. */
export const analysisBusyMessage = (state: RootState, bookId: string): string | null => {
  if (selectProsodyRunningForBook(state, bookId)) return 'Wait — emotions are still being detected';
  if (selectReviewRunningForBook(state, bookId)) return 'Wait — script review is in progress';
  return null;
};

const firstByLowestBookId = (m: Record<string, SubstageEntry>): { bookId: string; entry: SubstageEntry } | null => {
  const ids = Object.keys(m).sort();
  return ids.length ? { bookId: ids[0], entry: m[ids[0]] } : null;
};

/** Memoized so an unchanged map returns a stable reference (avoids the
    "selector returned a different result" re-render churn). Prefers a prosody
    pass over a review pass; ties broken by lowest bookId. */
export const selectAnalysisSubstage = createSelector(
  [(s: RootState) => s.prosody.activeStreams, (s: RootState) => s.scriptReview.activeStreams],
  (
    prosody,
    review,
  ): {
    kind: 'prosody' | 'review';
    label: string;
    percent: number;
    chapterIndex?: number;
    totalChapters?: number;
    estRemainingMs?: number;
    model?: string;
    engine?: 'local' | 'gemini';
    activityState?: 'loading' | 'waiting' | 'streaming';
    activitySince?: number;
    fallbackActive?: boolean;
  } | null => {
    const p = firstByLowestBookId(prosody);
    if (p)
      return {
        kind: 'prosody',
        label: p.entry.label,
        percent: p.entry.progress,
        chapterIndex: p.entry.chapterIndex,
        totalChapters: p.entry.totalChapters,
        estRemainingMs: p.entry.estRemainingMs,
        model: p.entry.model,
        engine: p.entry.engine,
        activityState: p.entry.activityState,
        activitySince: p.entry.activitySince,
        fallbackActive: p.entry.fallbackActive,
      };
    const r = firstByLowestBookId(review);
    if (r)
      return {
        kind: 'review',
        label: r.entry.label,
        percent: r.entry.progress,
        chapterIndex: r.entry.chapterIndex,
        totalChapters: r.entry.totalChapters,
        estRemainingMs: r.entry.estRemainingMs,
        model: r.entry.model,
        engine: r.entry.engine,
        activityState: r.entry.activityState,
        activitySince: r.entry.activitySince,
        fallbackActive: r.entry.fallbackActive,
      };
    return null;
  },
);
