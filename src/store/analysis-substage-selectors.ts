import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './index';
import type { SubstageEntry } from './prosody-slice';
import type { AnalysisEngine } from '../lib/model-id';

/* #3435 — a `background` run (the layout's open-book re-run) is not counted:
   it yields to the user instead of blocking them (selectBookHasForegroundWork). */
export const selectProsodyRunningForBook = (state: RootState, bookId: string): boolean => {
  const entry = state.prosody?.activeStreams?.[bookId];
  return !!entry && !entry.background;
};

export const selectReviewRunningForBook = (state: RootState, bookId: string): boolean =>
  !!state.scriptReview?.activeStreams && bookId in state.scriptReview.activeStreams;

export const selectAnalysisBusyForBook = (state: RootState, bookId: string): boolean =>
  selectProsodyRunningForBook(state, bookId) || selectReviewRunningForBook(state, bookId);

/** #3400 — an analysis run (main or subset) of this book is running. The server
    refuses a chapter restructure while one is, so the Restructure entry points
    disable on it. */
export const selectAnalysisRunningForBook = (state: RootState, bookId: string | null | undefined): boolean =>
  !!bookId && state.analysis?.activeStream?.bookId === bookId && state.analysis.activeStream.state === 'running';

/** #3400 — a chapter restructure of this book is in flight (per-book marker). */
export const selectBookRestructuring = (state: RootState, bookId: string): boolean =>
  !!state.ui?.restructuringBooks?.[bookId];

/** #3435 — anything the user has started on this book: a manual analysis
    pass, an analysis run (main or subset), generation queued or rendering,
    or a cast-design run — and (#3400) a chapter restructure, which re-keys
    the book's sentences under a detection run that snapshotted the old
    structure. The layout's background re-run of emotion detection
    does not start while this holds and ends at once when it starts to. */
export const selectBookHasForegroundWork = (state: RootState, bookId: string): boolean =>
  selectBookRestructuring(state, bookId) ||
  selectAnalysisBusyForBook(state, bookId) ||
  (state.analysis?.activeStream?.bookId === bookId && state.analysis.activeStream.state === 'running') ||
  (state.queue?.entries ?? []).some(
    (e) => e.bookId === bookId && (e.status === 'queued' || e.status === 'in_progress'),
  ) ||
  Object.values(state.chapters?.activeStreams ?? {}).some((st) => st.bookId === bookId) ||
  (state.castDesign?.active?.bookId === bookId && state.castDesign.active.state === 'running');

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
    engine?: AnalysisEngine;
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
