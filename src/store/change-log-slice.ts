/* Change-log slice — append-only audit trail of user-visible edits.

   Per-book `events` are hydrated from disk via `hydrateFromBookState` (called
   by the layout once per book open) and persisted by the persistence
   middleware. `workspaceEvents` is a separate, in-memory cache populated by
   `ChangelogRoute` from `GET /api/workspace/changelog`; it carries the
   bookId/bookTitle tags the global view renders alongside each event. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import { buildBoundaryMoveEvent } from '../lib/change-log';
import type { ChangeLogEvent, WorkspaceChangeLogCategoryCounts } from '../lib/types';

export interface ChangeLogState {
  /** Newest first — appendLogEvent unshifts. Per-book log. */
  events: ChangeLogEvent[];
  /** Workspace-wide aggregation fetched from the server, one page at a time.
      Each event carries the bookId/bookTitle/author the aggregator attached
      at fetch time. Not persisted — refetched whenever the global Change log
      view mounts. The page is appended to (not replaced) on subsequent
      infinite-scroll fetches; reset by `hydrateWorkspaceEvents`. */
  workspaceEvents: ChangeLogEvent[];
  /** Cursor for the next page (`?before=` query). `null` means this view has
      reached the tail and there are no more events to load. */
  workspaceNextCursor: string | null;
  /** Total events across the workspace, not just this page. Drives the
      "All (N)" pill so it stays truthful while the user scrolls. */
  workspaceTotalCount: number;
  /** Per-category totals across the full workspace set. Drives the
      Voice/Generation/Manuscript/Cast pills so they don't lie when only
      part of the log is loaded. */
  workspaceCategoryCounts: WorkspaceChangeLogCategoryCounts;
}

/* Starts empty. The Activity view shows a friendly empty-state card until
   real entries land via hydrateFromBookState (per-book) or
   hydrateWorkspaceEvents (workspace fan-out). Demo fixtures used to seed
   this slice; that polluted the workspace view on first run and hid the
   zero-count paths, so the seed was removed (see src/data/change-log.ts). */
const initialState: ChangeLogState = {
  events: CHANGE_LOG_EVENTS,
  workspaceEvents: [],
  workspaceNextCursor: null,
  workspaceTotalCount: 0,
  workspaceCategoryCounts: { voice: 0, generation: 0, manuscript: 0, cast: 0 },
};

export interface WorkspacePagePayload {
  events: ChangeLogEvent[];
  nextCursor: string | null;
  totalCount: number;
  categoryCounts: WorkspaceChangeLogCategoryCounts;
}

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
    /* Replace the workspace cache — used for the first page fetch on mount.
       Resets cursor + counts atomically with the events so a stale total
       from a previous mount doesn't briefly render alongside the new page. */
    hydrateWorkspaceFirstPage: (s, a: PayloadAction<WorkspacePagePayload>) => {
      s.workspaceEvents         = a.payload.events;
      s.workspaceNextCursor     = a.payload.nextCursor;
      s.workspaceTotalCount     = a.payload.totalCount;
      s.workspaceCategoryCounts = a.payload.categoryCounts;
    },
    /* Append the next page to the workspace cache without disturbing the
       totals (those reflect the FULL workspace and don't change between
       pages). Cursor advances to whatever the server returned. */
    appendWorkspacePage: (s, a: PayloadAction<WorkspacePagePayload>) => {
      s.workspaceEvents.push(...a.payload.events);
      s.workspaceNextCursor = a.payload.nextCursor;
      /* Server's totals are authoritative — re-sync in case a write landed
         between page fetches. */
      s.workspaceTotalCount     = a.payload.totalCount;
      s.workspaceCategoryCounts = a.payload.categoryCounts;
    },
    /* Legacy single-list hydrate — preserved so callers that only have a
       bare event array (older tests, the ChangelogRoute pre-pagination
       path) still compile. New code should prefer hydrateWorkspaceFirstPage
       so counts + cursor stay in sync. */
    hydrateWorkspaceEvents: (s, a: PayloadAction<ChangeLogEvent[]>) => {
      s.workspaceEvents     = a.payload;
      s.workspaceNextCursor = null;
      s.workspaceTotalCount = a.payload.length;
    },
    reset: (s) => {
      s.events                  = [];
      s.workspaceEvents         = [];
      s.workspaceNextCursor     = null;
      s.workspaceTotalCount     = 0;
      s.workspaceCategoryCounts = { voice: 0, generation: 0, manuscript: 0, cast: 0 };
    },
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
