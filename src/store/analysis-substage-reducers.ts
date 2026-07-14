/* Shared setActive/updateProgress reducer LOGIC for the two per-book
   substage-progress maps (prosody-slice, script-review-slice). Both slices
   track an identical `Record<string, SubstageEntry>` shape with identical
   last-known-value semantics; keeping the logic here means a future field
   addition/rename only needs one edit, not two kept in sync by hand.

   Plain functions, not reducers themselves — each slice's own `createSlice`
   reducer stays the call site so RTK's Immer draft wiring (and the
   slice-specific action types) are untouched. Mutate the draft directly,
   matching this codebase's "RTK immer" convention. */

import type { SubstageEntry } from './prosody-slice';

export interface SetActiveSubstagePayload {
  bookId: string;
  progress: number;
  label: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}

export interface UpdateSubstageProgressPayload {
  bookId: string;
  progress: number;
  label?: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
  model?: string;
  engine?: 'local' | 'gemini';
  activityState?: 'loading' | 'waiting' | 'streaming';
  fallbackActive?: boolean;
  /** Client timestamp used to stamp activitySince when activityState changes. */
  now?: number;
}

/** Start or restart a stream for `bookId` — fully REPLACES any existing
    entry (not a partial merge); deliberate, since setActive only fires at
    pass-start. */
export function setActiveSubstage(
  state: Record<string, SubstageEntry>,
  payload: SetActiveSubstagePayload,
): void {
  const { bookId, progress, label, chapterIndex, totalChapters, estRemainingMs } = payload;
  state[bookId] = {
    progress: Math.round(progress * 100),
    label,
    ...(chapterIndex !== undefined ? { chapterIndex } : {}),
    ...(totalChapters !== undefined ? { totalChapters } : {}),
    ...(estRemainingMs !== undefined ? { estRemainingMs } : {}),
  };
}

/** Update the in-flight entry for `bookId`. Last-known-value semantics: a
    field absent (`undefined`) from the payload leaves the previous value
    untouched. No-op if the book has no active entry. */
export function updateSubstageProgress(
  state: Record<string, SubstageEntry>,
  payload: UpdateSubstageProgressPayload,
): void {
  const e = state[payload.bookId];
  if (!e) return;
  e.progress = Math.round(payload.progress * 100);
  if (payload.label !== undefined) e.label = payload.label;
  if (payload.chapterIndex !== undefined) e.chapterIndex = payload.chapterIndex;
  if (payload.totalChapters !== undefined) e.totalChapters = payload.totalChapters;
  if (payload.estRemainingMs !== undefined) e.estRemainingMs = payload.estRemainingMs;
  if (payload.model !== undefined) e.model = payload.model;
  if (payload.engine !== undefined) e.engine = payload.engine;
  if (payload.fallbackActive !== undefined) e.fallbackActive = payload.fallbackActive;
  if (payload.activityState !== undefined && payload.activityState !== e.activityState) {
    e.activityState = payload.activityState;
    if (payload.now !== undefined) e.activitySince = payload.now;
  }
}
