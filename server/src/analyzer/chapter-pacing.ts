/* Pure pacing/ETA math shared by the three per-chapter SSE analyzer routes
   (annotate-emotion.ts, instruct-annotation.ts, script-review.ts). Each route
   streams one `phase` event per chapter carrying `chapterIndex`/`totalChapters`
   plus an optional `estRemainingMs` projected from the observed ms/char rate
   over chapters completed so far. No I/O, no route state — the routes keep
   their own local `actualMsTotal`/`actualCharsTotal` variables and call these
   functions to compute the map, the per-tick fields, and the post-chapter
   update, so control flow (WHEN pacing is accumulated — e.g. per-chapter
   `finally` vs. once after an inner per-chunk loop) stays in each route. */

import type { SentenceOutput } from '../handoff/schemas.js';

/** Total character count per chapter, keyed by chapter id — the denominator
    for the observed-rate ETA projection below. */
export function buildCharsByChapter(
  chapterIds: number[],
  byChapter: Map<number, SentenceOutput[]>,
): Map<number, number> {
  return new Map<number, number>(
    chapterIds.map((id) => [id, (byChapter.get(id) ?? []).reduce((n, sent) => n + sent.text.length, 0)]),
  );
}

/** The pacing-derived fields for one chapter's `phase` event: 1-based
    `chapterIndex` (distinct from the chapter's own id), `totalChapters`, and
    an `estRemainingMs` projected from the observed ms/char rate — OMITTED
    (not 0, not null) until at least one chapter's chars have been counted,
    so the first event of a run — and every event of a single-chapter run,
    where `actualCharsTotal` is always still 0 at tick time — never carries
    the field. `remainingChapterIds` is the current chapter plus every
    chapter still to come (i.e. `chapterIds.slice(index)`). */
export function chapterPacingPhaseFields(args: {
  index: number;
  totalChapters: number;
  actualMsTotal: number;
  actualCharsTotal: number;
  charsByChapter: Map<number, number>;
  remainingChapterIds: number[];
}): { chapterIndex: number; totalChapters: number; estRemainingMs?: number } {
  const { index, totalChapters, actualMsTotal, actualCharsTotal, charsByChapter, remainingChapterIds } = args;
  const fields: { chapterIndex: number; totalChapters: number; estRemainingMs?: number } = {
    chapterIndex: index + 1,
    totalChapters,
  };
  if (actualCharsTotal > 0) {
    const observedRate = actualMsTotal / actualCharsTotal;
    const remainingChars = remainingChapterIds.reduce((n, id) => n + (charsByChapter.get(id) ?? 0), 0);
    fields.estRemainingMs = Math.round(observedRate * remainingChars);
  }
  return fields;
}

/** Fold one chapter's real wall-clock duration + char count into the running
    pacing totals. Called even for a failed chapter/chunk — a failure still
    took real time, and excluding it would skew the rate for the chapters
    that follow. Pure: returns the updated totals rather than mutating a
    shared object, so each route keeps its own local variables and decides
    WHEN to call this (a per-chapter `finally`, or once after an inner
    per-chunk loop finishes). */
export function accumulateChapterPacing(
  totals: { actualMsTotal: number; actualCharsTotal: number },
  chapterStartedAt: number,
  chapterChars: number,
): { actualMsTotal: number; actualCharsTotal: number } {
  return {
    actualMsTotal: totals.actualMsTotal + (Date.now() - chapterStartedAt),
    actualCharsTotal: totals.actualCharsTotal + chapterChars,
  };
}
