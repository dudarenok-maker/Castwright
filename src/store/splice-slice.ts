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
}

const initialState: SpliceState = { batches: {} };

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
