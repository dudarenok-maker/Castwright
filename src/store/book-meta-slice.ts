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
   `state` slice patch containing all six fields. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
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
  /** fs-65 Phase 3 — per-book prosody annotation intent flag keyed by bookId.
      Eager-default: absent (undefined) ⇒ ON; only an explicit `false` opts out.
      The Task-13 trigger gate is `prosodyEnabled !== false`.
      Persisted through the server book-state slice; toggled by the Task-12
      analysis-form toggle. */
  prosodyEnabled: Record<string, boolean | undefined>;
}

const initialState: BookMetaState = {
  draft: null,
  saved: {},
  prosodyEnabled: {},
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
}

export const bookMetaSlice = createSlice({
  name: 'bookMeta',
  initialState,
  reducers: {
    /* Seed `saved[bookId]` from the BookStateJson the server returned on book
       open. Wipes any stale draft from a previous book. */
    hydrateFromBookState: (s, a: PayloadAction<HydratePayload>) => {
      const { bookId, state } = a.payload;
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
      s.draft = null;
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
        return;
      }
      if (s.draft) {
        s.saved[bookId] = { ...base, ...s.draft };
      }
      s.draft = null;
    },
  },
});

export const bookMetaActions = bookMetaSlice.actions;
export const bookMetaReducer = bookMetaSlice.reducer;

/* ── Selectors ──────────────────────────────────────────────────────────── */

/** Resolves the currently-displayed metadata for a book by overlaying any
    in-flight draft on top of the saved snapshot. Returns null if the book
    has not been hydrated. */
export const selectEffectiveMeta =
  (bookId: string | null) =>
  (s: RootState): EditableBookMeta | null => {
    if (!bookId) return null;
    const saved = s.bookMeta.saved[bookId];
    if (!saved) return null;
    if (!s.bookMeta.draft || Object.keys(s.bookMeta.draft).length === 0) return saved;
    return { ...saved, ...s.bookMeta.draft };
  };

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

