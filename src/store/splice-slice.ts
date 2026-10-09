import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TtsModelKey } from '../lib/types';

/* fs-26 — tracks in-flight per-character splice batches. The actual work runs
   in `splice-runner-middleware` (one splice SSE per chapter, sequentially), so
   a batch survives the Fix-audio modal closing. This slice is the durable
   progress source the modal reads while open and a global indicator can read
   when it's closed. */

export type SpliceMode = 'remix' | 'rerecord';

/** Full run parameters carried by `startBatch` — the middleware reads these to
    drive the per-chapter SSE calls. */
export interface SpliceBatchRequest {
  id: string;
  bookId: string;
  characterId: string;
  characterName: string;
  mode: SpliceMode;
  /** remix only. */
  gainDb?: number;
  /** rerecord only. */
  modelKey?: TtsModelKey;
  chapterIds: number[];
  /** rerecord only — scope the splice to a subset of the character's segments
      (fs-26 per-line re-record from the Listen view). Applied to every chapter
      in the batch; omit for a whole-character re-record. */
  segmentIndices?: number[];
}

export interface SpliceBatch {
  id: string;
  bookId: string;
  characterId: string;
  characterName: string;
  mode: SpliceMode;
  total: number;
  succeeded: number;
  failed: number;
  status: 'running' | 'done' | 'cancelled';
}

export interface SpliceState {
  batches: Record<string, SpliceBatch>;
  /* Plan 286 Task 20 — the chapter currently mid-splice per book, tracked so
     the UI can show a rendering state without the runner writing to the
     revisions cache (that's server-owned now). */
  inFlightChapters: Array<{ bookId: string; chapterId: number }>;
}

const initialState: SpliceState = { batches: {}, inFlightChapters: [] };

export const spliceSlice = createSlice({
  name: 'splice',
  initialState,
  reducers: {
    /** Kick off a batch. The middleware reacts to this action's payload; the
        reducer just records the batch so the UI can show progress. */
    startBatch: (s, a: PayloadAction<SpliceBatchRequest>) => {
      const { id, bookId, characterId, characterName, mode, chapterIds } = a.payload;
      s.batches[id] = {
        id,
        bookId,
        characterId,
        characterName,
        mode,
        total: chapterIds.length,
        succeeded: 0,
        failed: 0,
        status: 'running',
      };
    },
    recordChapterResult: (s, a: PayloadAction<{ id: string; ok: boolean }>) => {
      const b = s.batches[a.payload.id];
      if (!b) return;
      if (a.payload.ok) b.succeeded += 1;
      else b.failed += 1;
    },
    finishBatch: (s, a: PayloadAction<{ id: string }>) => {
      const b = s.batches[a.payload.id];
      if (b && b.status === 'running') b.status = 'done';
    },
    cancelBatch: (s, a: PayloadAction<{ id: string }>) => {
      const b = s.batches[a.payload.id];
      if (b) b.status = 'cancelled';
    },
    clearBatch: (s, a: PayloadAction<{ id: string }>) => {
      delete s.batches[a.payload.id];
    },
    /** A chapter's splice SSE call has started. Added if not already present. */
    chapterStarted: (s, a: PayloadAction<{ bookId: string; chapterId: number }>) => {
      const { bookId, chapterId } = a.payload;
      if (!s.inFlightChapters.some((c) => c.bookId === bookId && c.chapterId === chapterId)) {
        s.inFlightChapters.push({ bookId, chapterId });
      }
    },
    /** A chapter's splice SSE call has settled (succeeded or failed). */
    chapterSettled: (s, a: PayloadAction<{ bookId: string; chapterId: number }>) => {
      const { bookId, chapterId } = a.payload;
      s.inFlightChapters = s.inFlightChapters.filter(
        (c) => !(c.bookId === bookId && c.chapterId === chapterId),
      );
    },
  },
});

export const spliceActions = spliceSlice.actions;

/** The active (running) batch for a character in a book, if any. */
export const selectActiveSpliceBatch =
  (bookId: string, characterId: string) =>
  (s: { splice?: SpliceState }): SpliceBatch | null =>
    Object.values(s.splice?.batches ?? {}).find(
      (b) => b.bookId === bookId && b.characterId === characterId && b.status === 'running',
    ) ?? null;

/** Whether a chapter is currently mid-splice for a book. */
export const selectChapterRendering = (
  s: { splice: SpliceState },
  bookId: string,
  chapterId: number,
): boolean =>
  s.splice.inFlightChapters.some((c) => c.bookId === bookId && c.chapterId === chapterId);
