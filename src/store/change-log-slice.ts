/* Change-log slice — append-only audit trail of user-visible edits.

   Per-book `events` are hydrated from disk via `hydrateFromBookState` (called
   by the layout once per book open) and persisted by the persistence
   middleware. `workspaceEvents` is a separate, in-memory cache populated by
   `ChangelogRoute` from `GET /api/workspace/changelog`; it carries the
   bookId/bookTitle tags the global view renders alongside each event. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import { buildBoundaryMoveEvent } from '../lib/change-log';
import type { ChangeLogEvent } from '../lib/types';

export interface ChangeLogState {
  /** Newest first — appendLogEvent unshifts. Per-book log. */
  events: ChangeLogEvent[];
  /** Workspace-wide aggregation fetched from the server. Each event carries
      the bookId/bookTitle/author the aggregator attached at fetch time. Not
      persisted — refetched whenever the global Change log view mounts. */
  workspaceEvents: ChangeLogEvent[];
}

/* Starts empty. The Activity view shows a friendly empty-state card until
   real entries land via hydrateFromBookState (per-book) or
   hydrateWorkspaceEvents (workspace fan-out). Demo fixtures used to seed
   this slice; that polluted the workspace view on first run and hid the
   zero-count paths, so the seed was removed (see src/data/change-log.ts). */
const initialState: ChangeLogState = {
  events: CHANGE_LOG_EVENTS,
  workspaceEvents: [],
};

export const changeLogSlice = createSlice({
  name: 'changeLog',
  initialState,
  reducers: {
    appendLogEvent: (s, a: PayloadAction<ChangeLogEvent>) => {
      s.events.unshift(a.payload);
    },
    /* Per-chapter aggregator for manuscript boundary moves. The first edit
       in a chapter appends a fresh boundary_move event; subsequent edits
       while it is still at the head of the list increment its sentence
       count and rewrite the note in place. Rationale: a single drag-handle
       gesture fans out into dozens of setSentenceCharacter dispatches and
       we don't want each one to be its own audit line. */
    bumpBoundaryMove: (s, a: PayloadAction<{ chapterId: number; count: number }>) => {
      const { chapterId, count } = a.payload;
      const head = s.events[0];
      if (head && head.type === 'boundary_move' && head.chapterId === chapterId) {
        const prior = extractBoundaryCount(head.note);
        const next = prior + count;
        head.note = boundaryNote(next);
        head.at = new Date().toISOString();
        head.ts = 'Just now';
        head.date = 'today';
      } else {
        s.events.unshift(buildBoundaryMoveEvent({ chapterId, count }));
      }
    },
    /* Reparse wipe: drop every event that references a now-stale chapter id
       (regenerate, chapter_complete, chapter_failed, boundary_move).
       Cast/voice preferences (voice_tune, voice_lock, voice_reuse,
       cast_confirm) and historical markers (import, analysis_complete) carry
       no chapterId and survive — they're either still accurate or remain
       informative across a reparse. */
    wipeBookShapeEvents: (s) => {
      s.events = s.events.filter(e => e.chapterId === undefined);
    },
    hydrateFromBookState: (s, a: PayloadAction<ChangeLogEvent[] | null | undefined>) => {
      s.events = a.payload && a.payload.length > 0 ? a.payload : [];
    },
    hydrateWorkspaceEvents: (s, a: PayloadAction<ChangeLogEvent[]>) => {
      s.workspaceEvents = a.payload;
    },
    reset: (s) => { s.events = []; s.workspaceEvents = []; },
  },
});

function extractBoundaryCount(note: string): number {
  const m = note.match(/^(\d+)\s+sentence/);
  return m ? Number(m[1]) : 0;
}

function boundaryNote(count: number): string {
  return `${count} sentence${count === 1 ? '' : 's'} reassigned.`;
}

export const changeLogActions = changeLogSlice.actions;
