/* Listen-progress slice — per-book resume bookmark.
 *
 * The slice stays in-memory only. The server file at
 * `.audiobook/listen-progress.json` is authoritative; this slice
 * mirrors it for the active book so the Listen view's "Resume at
 * MM:SS" pill and the MiniPlayer's on-mount seek can read state
 * synchronously without re-fetching on every render.
 *
 * Why not redux-persist? Two reasons:
 *   1. The server file already survives reloads.
 *   2. Persisting would put the bookmark in two places of truth;
 *      a stale rehydrate could clobber a fresh server-side write.
 *
 * Plan 47, extended by plan 53 with `playbackRate` (per-book
 * playback-speed memory) and `markers` (user-placed bookmarks). */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/* Plan 53 — marker kind enum. `note` is a general bookmark, `rerecord`
   flags a spot that needs another voice take. Server validator (plan
   53, server/src/routes/book-state.ts) rejects any other string so the
   on-disk shape stays canonical. */
export type ListenMarkerKind = 'note' | 'rerecord';
export const LISTEN_MARKER_KINDS: readonly ListenMarkerKind[] = ['note', 'rerecord'] as const;

export interface ListenMarker {
  id: string;
  chapterId: number;
  sec: number;
  label: string;
  kind: ListenMarkerKind;
  createdAt: string;
}

export interface ListenProgressRecord {
  chapterId: number;
  currentSec: number;
  updatedAt: string;
  /* Plan 53 — per-book playback rate (HTMLMediaElement.playbackRate).
     Optional / lazy: pre-plan-53 records on disk lack the field and
     callers default to 1.0 via getPlaybackRate(). */
  playbackRate?: number;
  /* Plan 53 — user-placed bookmarks. Optional + defaults to [] for
     records written before plan 53. */
  markers?: ListenMarker[];
}

/* Plan 53 — explicit "seek requested" signal so the listen-view
   marker-click can hop the mini-player to a position WITHIN the
   currently-playing chapter (where the chapter-mount seek path
   wouldn't re-fire because the chapter id didn't change). The
   mini-player consumes this with an effect, fires
   el.currentTime = sec, then dispatches consumeSeek to clear it. */
export interface PendingSeek {
  bookId: string;
  chapterId: number;
  sec: number;
  /* Monotonic counter so two marker clicks at the same sec still
     trigger a fresh seek (the effect compares the requestId, not the
     payload). */
  requestId: number;
}

export interface ListenProgressState {
  byBook: Record<string, ListenProgressRecord>;
  /* Plan 53 — one-shot seek request consumed by the mini-player.
     Null between requests. */
  pendingSeek: PendingSeek | null;
}

const initialState: ListenProgressState = { byBook: {}, pendingSeek: null };

/* Default playback rate when the record omits the field (pre-plan-53
   data on disk, or a brand-new book that hasn't picked a rate yet). */
export const DEFAULT_PLAYBACK_RATE = 1.0;

/** Helper used by the mini-player to read the rate with a guaranteed
 *  numeric fallback. Saves every caller from `?? 1.0` plumbing and keeps
 *  the default centralised. */
export function getPlaybackRate(record: ListenProgressRecord | null | undefined): number {
  if (!record || typeof record.playbackRate !== 'number' || !Number.isFinite(record.playbackRate)) {
    return DEFAULT_PLAYBACK_RATE;
  }
  return record.playbackRate;
}

export const listenProgressSlice = createSlice({
  name: 'listenProgress',
  initialState,
  reducers: {
    /* Server fetch returns the record (or null when no session has
       been recorded yet). Null clears any local entry for the book. */
    hydrate: (
      s,
      a: PayloadAction<{ bookId: string; progress: ListenProgressRecord | null }>,
    ) => {
      const { bookId, progress } = a.payload;
      if (progress) s.byBook[bookId] = progress;
      else delete s.byBook[bookId];
    },
    /* Optimistic update after a debounced PUT. Server's response will
       arrive with a real updatedAt; the slice carries the local timer's
       Date.now() value until then so the Listen pill's MM:SS stays
       fresh during continuous playback.
       Plan 53: preserves `playbackRate` + `markers` across position
       updates — the mini-player's debounced PUT only carries chapter
       + position, so without this guard the slice would drop the
       user's chosen rate and markers between saves. */
    update: (
      s,
      a: PayloadAction<{ bookId: string; chapterId: number; currentSec: number; updatedAt?: string }>,
    ) => {
      const { bookId, chapterId, currentSec, updatedAt } = a.payload;
      const prev = s.byBook[bookId];
      s.byBook[bookId] = {
        chapterId,
        currentSec,
        updatedAt: updatedAt ?? new Date().toISOString(),
        ...(prev?.playbackRate !== undefined ? { playbackRate: prev.playbackRate } : {}),
        ...(prev?.markers ? { markers: prev.markers } : {}),
      };
    },
    /* Plan 53 — playback-rate change from the mini-player picker.
       Preserves the existing position + markers; stamps a fresh
       updatedAt so the disk write that fans out from the same picker
       handler echoes the user's clock. */
    setPlaybackRate: (
      s,
      a: PayloadAction<{ bookId: string; playbackRate: number; updatedAt?: string }>,
    ) => {
      const { bookId, playbackRate, updatedAt } = a.payload;
      const prev = s.byBook[bookId];
      if (prev) {
        prev.playbackRate = playbackRate;
        prev.updatedAt = updatedAt ?? new Date().toISOString();
        return;
      }
      /* No prior record (user picked a rate before any playback
         actually advanced). Seed a minimal record so the rate survives
         the first PUT-then-hydrate round-trip. */
      s.byBook[bookId] = {
        chapterId: 0,
        currentSec: 0,
        updatedAt: updatedAt ?? new Date().toISOString(),
        playbackRate,
      };
    },
    /* Plan 53 — add a marker. Reducer is silent on duplicate ids; the
       caller is the only id minter (uses crypto.randomUUID() in the
       mini-player) and we don't want to throw inside Immer. */
    addMarker: (
      s,
      a: PayloadAction<{ bookId: string; marker: ListenMarker }>,
    ) => {
      const { bookId, marker } = a.payload;
      const prev = s.byBook[bookId];
      if (prev) {
        prev.markers = [...(prev.markers ?? []), marker];
        return;
      }
      /* No prior record — same minimal-seed pattern as
         setPlaybackRate. The mini-player only fires this from inside
         the chapter context, so chapterId/currentSec from the marker
         are sensible defaults for the parent record. */
      s.byBook[bookId] = {
        chapterId: marker.chapterId,
        currentSec: marker.sec,
        updatedAt: new Date().toISOString(),
        markers: [marker],
      };
    },
    /* Plan 53 — edit a marker's label and/or kind. Missing markerId is
       a silent no-op (caller is the sole id minter; no real session can
       hit this). */
    editMarker: (
      s,
      a: PayloadAction<{
        bookId: string;
        markerId: string;
        patch: Partial<Pick<ListenMarker, 'label' | 'kind'>>;
      }>,
    ) => {
      const { bookId, markerId, patch } = a.payload;
      const prev = s.byBook[bookId];
      if (!prev?.markers) return;
      const target = prev.markers.find((m) => m.id === markerId);
      if (!target) return;
      if (patch.label !== undefined) target.label = patch.label;
      if (patch.kind !== undefined) target.kind = patch.kind;
    },
    /* Plan 53 — delete a marker. Missing id is a silent no-op. */
    deleteMarker: (
      s,
      a: PayloadAction<{ bookId: string; markerId: string }>,
    ) => {
      const { bookId, markerId } = a.payload;
      const prev = s.byBook[bookId];
      if (!prev?.markers) return;
      prev.markers = prev.markers.filter((m) => m.id !== markerId);
    },
    clear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.byBook[a.payload.bookId];
    },
    /* Plan 53 — request a seek inside the current chapter. The mini-
       player's effect compares requestId against its last-consumed
       and fires el.currentTime = sec. */
    requestSeek: (
      s,
      a: PayloadAction<{ bookId: string; chapterId: number; sec: number }>,
    ) => {
      const prevId = s.pendingSeek?.requestId ?? 0;
      s.pendingSeek = {
        bookId: a.payload.bookId,
        chapterId: a.payload.chapterId,
        sec: a.payload.sec,
        requestId: prevId + 1,
      };
    },
    consumeSeek: (s, a: PayloadAction<{ requestId: number }>) => {
      if (s.pendingSeek?.requestId === a.payload.requestId) s.pendingSeek = null;
    },
  },
});

export const listenProgressActions = listenProgressSlice.actions;

/* Defensive selector: returns null when the slice isn't registered
   (older test stores composed before plan 47) or when no record
   exists for the book. Lets the Listen view + MiniPlayer call this
   unconditionally without a per-test fixup. */
export const selectListenProgress =
  (bookId: string | null) =>
  (s: { listenProgress?: ListenProgressState }): ListenProgressRecord | null => {
    if (!bookId) return null;
    return s.listenProgress?.byBook[bookId] ?? null;
  };

/* Plan 53 — selector for the one-shot pending seek. Null when no
   marker click is waiting, or when the slice isn't registered. */
export const selectPendingSeek =
  (bookId: string | null) =>
  (s: { listenProgress?: ListenProgressState }): PendingSeek | null => {
    if (!bookId) return null;
    const ps = s.listenProgress?.pendingSeek;
    if (!ps || ps.bookId !== bookId) return null;
    return ps;
  };
