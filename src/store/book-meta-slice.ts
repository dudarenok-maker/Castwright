/* Book-meta slice — editable book-level audiobook metadata surfaced by the
   Listen view's metadata editor (title, author, series, narrator credit,
   genre, publication date).

   Shape:
   - `saved[bookId]` — last persisted values, hydrated from BookStateJson on
     book open. Reads (e.g. the Listen header) flow through `selectEffectiveMeta`,
     which overlays any in-flight draft on top.
   - `draft` — in-flight edits buffer scoped to the currently-open book.
     Cleared on cancel and on commit. While non-empty, `selectEffectiveMeta`
     blends it over `saved[bookId]` so the header updates live as the user
     types.

   Persistence: `commitDraft` is the only mutation that writes through to
   disk — the persistence-middleware watches that action and PUTs a single
   `state` slice patch containing the fields typed since the last accepted
   save (`lastCommitted[bookId].draft`). */

import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { BookStateJson } from '../lib/types';
import type { RootState } from './index';

/** Default narrator credit shown when no explicit credit has been saved.
    Duplicated on the server in server/src/export/narrator-credit.ts (no shared module). */
export const DEFAULT_NARRATOR_CREDIT = 'Castwright';

export interface EditableBookMeta {
  title: string;
  author: string;
  series: string;
  narratorCredit: string | null;
  genre: string | null;
  /** ISO 'YYYY-MM-DD' calendar date (no time). */
  publicationDate: string | null;
  /** Long-form "about this audiobook" copy. Travels into the M4B
      `desc` / `ldes` atoms during Voice export (plan 33). */
  description: string | null;
  /** Per-book editorial notes — source attribution, license, narration
      intent, in-progress thoughts. Workspace-internal (never exported).
      Markdown line breaks preserved via `whitespace-pre-wrap` at render time.
      See plan 67. */
  notes: string | null;
}

export type EditableBookMetaField = keyof EditableBookMeta;

export interface BookMetaState {
  /** In-flight edits for the currently-open book. null when no edits are pending. */
  draft: Partial<EditableBookMeta> | null;
  /** Last-saved snapshot for each book the user has opened this session. */
  saved: Record<string, EditableBookMeta>;
  /** #2230 — committed-edit snapshot for each book with an in-flight PUT.
      Captured on `commitDraft` so a refused save (a 409 from the persistence
      PUT) can (a) roll the optimistic `saved[bookId]` update back to the last
      value the server accepted AND (b) keep the user's typed `draft` in the
      editor for retry — a failed save must not silently erase their edits.
      - `saved` is pinned on the FIRST commit in a debounce window (the true
        server-accepted baseline), then moves forward per field as each field
        lands (`commitFieldsLanded`, #3827), so a refused PUT reverts to the
        newest landed value, never to an unpersisted intermediate. Later
        commits in the same window merge their drafts.
      - `draft` accumulates the diff staged across those commits; a field
        leaves it once it lands with no newer value queued.
      Cleared on `hydrateFromBookState` without `keepDraft`, on a delete, and
      once every typed field has landed. */
  lastCommitted?: Record<
    string,
    { saved: EditableBookMeta; draft: Partial<EditableBookMeta> }
  >;
  /** fs-65 Phase 3 — per-book prosody annotation intent flag keyed by bookId.
      Eager-default: absent (undefined) ⇒ ON; only an explicit `false` opts out.
      The Task-13 trigger gate is `prosodyEnabled !== false`.
      Persisted through the server book-state slice; toggled by the Task-12
      analysis-form toggle. */
  prosodyEnabled: Record<string, boolean | undefined>;
  /** Plan 289 (D7) — books whose in-memory slices may be older than disk: a
      save was refused as stale, or a writer the persistence middleware never
      sees (Library Edit, the language guard) changed the book. Layout reads a
      marked book in full, even when its slices are loaded, and the full read
      clears the mark. The value counts marks, so a read clears only the marks
      made before it was issued. Optional so hand-built test stores need not
      carry it. */
  needsFullRead?: Record<string, number>;
}

const initialState: BookMetaState = {
  draft: null,
  saved: {},
  lastCommitted: {},
  prosodyEnabled: {},
  needsFullRead: {},
};

interface HydratePayload {
  bookId: string;
  state: Pick<BookStateJson, 'title' | 'author' | 'series'> & {
    narratorCredit?: string | null;
    genre?: string | null;
    publicationDate?: string | null;
    description?: string | null;
    notes?: string | null;
    prosodyEnabled?: boolean;
  };
  /** #3784 PB — a full read of the book the user is editing: refresh `saved`
      and keep the draft. Layout sets it on every full read of the open book,
      the first after opening it included, unless the read is of a different
      manuscript than the book was last read from (#3784 P11-1: a book
      re-imported under the same id). */
  keepDraft?: boolean;
}

export const bookMetaSlice = createSlice({
  name: 'bookMeta',
  initialState,
  reducers: {
    /* Seed `saved[bookId]` from the BookStateJson the server returned on book
       open. Wipes any stale draft from a previous book.

       #3784 PB — a full read of the open book (`keepDraft`) keeps the draft: it
       holds the user's typing, or the edit a failed save restored (#2230,
       #3754), and the read cannot restore either. `selectEffectiveMeta` still
       overlays it, so a field the user is editing shows their typing while
       every other field shows the read. */
    hydrateFromBookState: (s, a: PayloadAction<HydratePayload>) => {
      const { bookId, state, keepDraft = false } = a.payload;
      s.saved[bookId] = {
        title: state.title,
        author: state.author,
        series: state.series,
        narratorCredit: state.narratorCredit ?? DEFAULT_NARRATOR_CREDIT,
        genre: state.genre ?? null,
        publicationDate: state.publicationDate ?? null,
        description: state.description ?? null,
        notes: state.notes ?? null,
      };
      s.prosodyEnabled[bookId] = state.prosodyEnabled;
      if (!keepDraft) s.draft = null;
      /* #2230 — a fresh authoritative state from disk supersedes any pending
         commit snapshot (the server is now the truth, rollback is moot).

         #3784 P11-2 — except on a re-read of the open book: a commit whose PUT
         is still queued or in flight keeps its snapshot, rebased onto the read,
         so a failed save still restores the typing and reverts to the read
         (keeping the outside write it brought), not to the pre-read baseline. */
      const pending = s.lastCommitted?.[bookId];
      if (pending && keepDraft) pending.saved = { ...s.saved[bookId] };
      else if (s.lastCommitted) delete s.lastCommitted[bookId];
    },

    /* Stage a single-field edit into the draft buffer. Triggered on every
       keystroke from the metadata editor's controlled inputs. */
    setDraftField: (
      s,
      a: PayloadAction<{ field: EditableBookMetaField; value: string | null }>,
    ) => {
      if (!s.draft) s.draft = {};
      const { field, value } = a.payload;
      (s.draft as Record<EditableBookMetaField, string | null>)[field] = value;
    },

    /* Discard pending edits — Cancel button. */
    cancelDraft: (s) => {
      s.draft = null;
    },

    /* fs-65 Phase 3 — set the prosody annotation intent flag for the given book.
       Dispatched by the Task-12 analysis-form toggle. The durable PUT to
       `{ slice: 'state', patch: { prosodyEnabled } }` is issued by the toggle
       component directly (no persistence-middleware watches this action). */
    setProsodyEnabled: (s, a: PayloadAction<{ bookId: string; value: boolean }>) => {
      s.prosodyEnabled[a.payload.bookId] = a.payload.value;
    },

    /* Fold the draft into `saved[bookId]` atomically. This is the action the
       persistence-middleware watches to fire a PUT — keep it dispatching even
       when the draft is empty so the middleware's logic stays simple. */
    commitDraft: (s, a: PayloadAction<{ bookId: string }>) => {
      const { bookId } = a.payload;
      const base = s.saved[bookId];
      if (!base) {
        /* No baseline — refuse to corrupt state. Still clear the draft so the
           user's intent (commit & close) is honoured. */
        s.draft = null;
        if (s.lastCommitted) delete s.lastCommitted[bookId];
        return;
      }
      if (s.draft) {
        /* #2230 — pin the server-accepted `saved` baseline on the FIRST commit
           in a debounce window, and merge drafts across any subsequent commits
           so a refused PUT can revert to that baseline without losing any typed
           text. (s.lastCommitted ??= {}) guards the recent-field optionality. */
        const snapshot = (s.lastCommitted ??= {});
        const pending = (snapshot[bookId] ??= { saved: base, draft: {} });
        pending.draft = { ...pending.draft, ...s.draft };
        s.saved[bookId] = { ...base, ...pending.draft };
      }
      s.draft = null;
    },

    /* #2230 — recover from a refused save. Dispatched by persistence-middleware
       on a bookMeta/commitDraft failure: the server left the book (folder /
       on-disk state) untouched. We revert the OPTIMISTIC `saved` update to the
       last value the server accepted, and restore the user's typed `draft` so
       the editor keeps their text with the Save/Cancel affordances + the error
       toast (esp. important for a transient network failure, where the content
       was never actually refused). Snapshot is always cleared.

       #3754 / #3784 — the draft is global, so it is restored only while the
       failing book is the open one (`restoreDraft`, default true): restoring
       it on another book would carry this book's text there. A 4xx refusal
       that arrives after the book was left still reverts `saved` (nothing is
       kept for a refused write) but passes `restoreDraft: false`. A retryable
       failure after leaving is not rolled back at all; it is kept and re-sent
       on the book's next flush. */
    rollbackCommitDraft: (s, a: PayloadAction<{ bookId: string; restoreDraft?: boolean }>) => {
      const { bookId, restoreDraft = true } = a.payload;
      const pending = s.lastCommitted?.[bookId];
      if (pending) {
        s.saved[bookId] = pending.saved;
        if (restoreDraft) s.draft = { ...pending.draft };
      }
      if (s.lastCommitted) delete s.lastCommitted[bookId];
    },

    /* #3827 — some fields of a pending commit landed on disk. Per the owner's
       decision on #3827, each field is folded into the rollback baseline as
       soon as it lands, so a refused later commit reverts to the newest landed
       value (T1), never the window baseline (T0). Every landed field is
       folded; only `settled` fields (no newer value queued) leave the typed
       set, so a landed field is not re-sent by a later commit in the window.
       An empty typed set deletes the snapshot, as `commitDraftSucceeded` did.
       Retention is unchanged (#3758): a rolled-back details save is still not
       kept. */
    commitFieldsLanded: (
      s,
      a: PayloadAction<{
        bookId: string;
        landed: Partial<EditableBookMeta>;
        settled: EditableBookMetaField[];
      }>,
    ) => {
      const { bookId, landed, settled } = a.payload;
      const pending = s.lastCommitted?.[bookId];
      if (!pending) return;
      Object.assign(pending.saved, landed);
      for (const f of settled) delete pending.draft[f];
      if (Object.keys(pending.draft).length === 0) delete s.lastCommitted![bookId];
    },

    /* #2230 — a successful PUT confirms the optimistically-written `saved`
       value, so the pending snapshot is moot. Pruning it means the NEXT commit
       (a new window) snaps a fresh, now-accepted baseline instead of a stale
       one — which is what makes the first-write baseline logic in commitDraft
       correct across consecutive save sessions. */
    commitDraftSucceeded: (s, a: PayloadAction<{ bookId: string }>) => {
      const { bookId } = a.payload;
      if (s.lastCommitted) delete s.lastCommitted[bookId];
    },

    /* #3784 P12-1 — the book was deleted: forget its commit snapshot, and the
       draft when it was typed on this book (`ownsDraft`, decided by the
       persistence middleware, which knows the book the draft belongs to). A
       re-import under the same id, from the book's own bundle, keeps both of
       its ids, so nothing later can tell the old book's typing from the new
       book's. */
    forgetBook: (s, a: PayloadAction<{ bookId: string; ownsDraft: boolean }>) => {
      if (s.lastCommitted) delete s.lastCommitted[a.payload.bookId];
      if (a.payload.ownsDraft) s.draft = null;
    },

    /* Plan 289 (D7) — mark a book for a full re-read (see `needsFullRead`).
       #3784 P1 — `refused` names book-meta fields the server refused as
       stale: they stop being the user's pending edit, so a rollback does not
       restore them and a later commit does not send them again (the
       persistence middleware sends only the pending edit's fields). */
    markNeedsFullRead: (s, a: PayloadAction<{ bookId: string; refused?: string[] }>) => {
      const marks = (s.needsFullRead ??= {});
      marks[a.payload.bookId] = (marks[a.payload.bookId] ?? 0) + 1;
      const pending = s.lastCommitted?.[a.payload.bookId];
      for (const f of a.payload.refused ?? []) delete pending?.draft[f as EditableBookMetaField];
    },

    /* Plan 289 (D7) — a full read landed. `upTo` is the mark count when it was
       issued; a mark made while it was in flight survives it. */
    clearNeedsFullRead: (s, a: PayloadAction<{ bookId: string; upTo: number }>) => {
      const { bookId, upTo } = a.payload;
      if (s.needsFullRead && (s.needsFullRead[bookId] ?? 0) <= upTo) delete s.needsFullRead[bookId];
    },
  },
});

export const bookMetaActions = bookMetaSlice.actions;
export const bookMetaReducer = bookMetaSlice.reducer;

/* ── Selectors ──────────────────────────────────────────────────────────── */

/** Resolves the currently-displayed metadata for a book by overlaying any
    in-flight draft on top of the saved snapshot. Returns null if the book
    has not been hydrated.

    Memoised via createSelector, mirroring `selectDriftForBook` (#1308) — an
    unmemoized `{ ...saved, ...draft }` allocates a fresh object on every call
    while a draft is in flight (i.e. while the user is actively editing),
    which react-redux's dev-mode stability check flags as "returned a
    different result when called with the same parameters" and forces
    `ListenRoute` (this selector's caller) to re-render on every store
    dispatch during that editing session, not just meta-relevant ones. */
export const selectEffectiveMeta = createSelector(
  [
    (s: RootState, bookId: string | null) => (bookId ? s.bookMeta.saved[bookId] : undefined),
    (s: RootState) => s.bookMeta.draft,
  ],
  (saved, draft): EditableBookMeta | null => {
    if (!saved) return null;
    if (!draft || Object.keys(draft).length === 0) return saved;
    return { ...saved, ...draft };
  },
);

/** True when the user has made any unsaved edits. */
export const selectIsDirty = (s: RootState): boolean =>
  s.bookMeta.draft != null && Object.keys(s.bookMeta.draft).length > 0;

/** fs-65 Phase 3 — per-book prosody annotation intent flag.
    Returns undefined for any book that has not been hydrated yet or where
    the flag was absent on disk. The Task-13 trigger gate is
    `prosodyEnabled !== false` (absent ⇒ on).
    Guards `s.bookMeta?.prosodyEnabled` so tests that omit the bookMeta
    slice from their store don't throw (they get the safe undefined/on default). */
export const selectProsodyEnabled =
  (bookId: string | null) =>
  (s: RootState): boolean | undefined =>
    bookId != null ? (s.bookMeta?.prosodyEnabled ?? {})[bookId] : undefined;

