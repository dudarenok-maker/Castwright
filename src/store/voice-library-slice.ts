/* fs-38 Wave 1, Task 13 — voice-library RTK slice.

   Book-independent "My voices" library (design spec §5,
   docs/superpowers/specs/2026-07-04-fs38-voices-library-design.md). Backs
   the `#/voices` "My voices" tab: list + pin/tag/rename + design/redesign +
   delete + assign-to-character + promote-from-cast. Wraps the Task 12
   `api.*` voice-library pairs (real + mock, both already wired behind
   `VITE_USE_MOCKS` in src/lib/api.ts).

   Optimistic vs. refetch (spec §5 + task-13 brief): `patchEntry` (pin/tags/
   name/persona) is the one mutation cheap and safe to apply optimistically
   — it's a pure local-field edit with no server-side side effects to lose
   track of. Every other mutation (design, redesign, promote/discard
   redesign, delete, assign, promote-from-cast) refetches the full list
   after the server call succeeds rather than hand-rolling a local merge —
   simpler, and correctness matters more than shaving one round-trip for
   these lower-frequency actions.

   Cross-tab consistency (spec §5, explicit v1 decision): this slice does
   NOT join `broadcast-middleware` (which deliberately syncs only ephemeral
   stream state, never entity lists). Instead `installVoiceLibraryFocusListener`
   below wires a `visibilitychange`/`focus` listener that refetches when a
   tab becomes visible again — but only when the list is non-empty (nothing
   to go stale on first load) AND the last fetch is more than STALE_MS old
   (so alt-tabbing back and forth doesn't spam refetches). Installed from
   `src/store/index.ts` once the store exists, mirroring how other
   store-level side effects (e.g. the router) are wired up post-creation. */

import { createSlice, createAsyncThunk, createSelector, type PayloadAction } from '@reduxjs/toolkit';
import { api, type VoiceLibraryEntry, type VoiceLibraryPatch, type VoiceLibraryUsageEntry } from '../lib/api';

export type VoiceLibraryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface VoiceLibraryState {
  entries: VoiceLibraryEntry[];
  status: VoiceLibraryStatus;
  /** True while a design-voice request is in flight (Create-voice modal's
   *  submit spinner / disabled state). */
  designPending: boolean;
  /** ms-since-epoch of the last successful `fetchVoiceLibrary`, or null
   *  before the first fetch. Internal bookkeeping for the focus-listener's
   *  staleness check — not itself part of the task's stated state shape,
   *  but required to implement it. */
  lastFetchedAt: number | null;
}

const initialState: VoiceLibraryState = {
  entries: [],
  status: 'idle',
  designPending: false,
  lastFetchedAt: null,
};

/* ── Thunks ──────────────────────────────────────────────────────────── */

export const fetchVoiceLibrary = createAsyncThunk('voiceLibrary/fetch', async () => {
  return api.listVoiceLibrary();
});

export const designVoice = createAsyncThunk(
  'voiceLibrary/design',
  async (
    body: { name: string; persona: string; languageCode?: string },
    { dispatch },
  ) => {
    const result = await api.designLibraryVoice(body);
    await dispatch(fetchVoiceLibrary());
    return result;
  },
);

export const redesignVoice = createAsyncThunk(
  'voiceLibrary/redesign',
  async (args: { voiceUuid: string; persona: string }) => {
    return api.redesignLibraryVoice(args.voiceUuid, { persona: args.persona });
  },
);

export const promoteRedesign = createAsyncThunk(
  'voiceLibrary/promoteRedesign',
  async (args: { voiceUuid: string; persona?: string }, { dispatch }) => {
    const entry = await api.promoteLibraryRedesign(args.voiceUuid, { persona: args.persona });
    await dispatch(fetchVoiceLibrary());
    return entry;
  },
);

export const discardRedesign = createAsyncThunk(
  'voiceLibrary/discardRedesign',
  async (voiceUuid: string, { dispatch }) => {
    const entry = await api.discardLibraryRedesign(voiceUuid);
    await dispatch(fetchVoiceLibrary());
    return entry;
  },
);

/** Optimistic — the `pending` reducer below applies the patch to the
 *  matching entry immediately; `fulfilled` reconciles with the server's
 *  response (authoritative `updatedAt` etc). On failure the request body
 *  refetches the real list to undo the optimistic edit rather than trying
 *  to hand-roll a revert. */
export const patchEntry = createAsyncThunk(
  'voiceLibrary/patch',
  async (args: { voiceUuid: string; patch: VoiceLibraryPatch }, { dispatch }) => {
    try {
      return await api.patchVoiceLibrary(args.voiceUuid, args.patch);
    } catch (err) {
      await dispatch(fetchVoiceLibrary());
      throw err;
    }
  },
);

export const deleteEntry = createAsyncThunk(
  'voiceLibrary/delete',
  async (args: { voiceUuid: string; confirm?: boolean }, { dispatch }) => {
    const result = await api.deleteVoiceLibrary(args.voiceUuid, { confirm: args.confirm });
    if ('deleted' in result) {
      await dispatch(fetchVoiceLibrary());
    }
    return result;
  },
);

export const assignVoice = createAsyncThunk(
  'voiceLibrary/assign',
  async (
    args: { voiceUuid: string; bookId: string; characterId: string },
    { dispatch },
  ) => {
    const result = await api.assignLibraryVoice(args.voiceUuid, {
      bookId: args.bookId,
      characterId: args.characterId,
    });
    await dispatch(fetchVoiceLibrary());
    return result;
  },
);

export const promoteCharacterVoice = createAsyncThunk(
  'voiceLibrary/promoteCharacter',
  async (
    args: { bookId: string; characterId: string; name: string },
    { dispatch },
  ) => {
    const entry = await api.promoteToLibrary(args);
    await dispatch(fetchVoiceLibrary());
    return entry;
  },
);

export const cloneSample = createAsyncThunk('voiceLibrary/cloneSample', async (form: FormData) => {
  return api.cloneVoiceSample(form);
});

export const revokeVoice = createAsyncThunk(
  'voiceLibrary/revoke',
  async (voiceUuid: string, { dispatch }) => {
    const entry = await api.revokeVoiceLibraryEntry(voiceUuid);
    await dispatch(fetchVoiceLibrary());
    return entry;
  },
);

/* ── Slice ───────────────────────────────────────────────────────────── */

export const voiceLibrarySlice = createSlice({
  name: 'voiceLibrary',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchVoiceLibrary.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchVoiceLibrary.fulfilled, (state, action: PayloadAction<{ voices: VoiceLibraryEntry[] }>) => {
        state.entries = action.payload.voices;
        state.status = 'ready';
        state.lastFetchedAt = Date.now();
      })
      .addCase(fetchVoiceLibrary.rejected, (state) => {
        state.status = 'error';
      })
      .addCase(designVoice.pending, (state) => {
        state.designPending = true;
      })
      .addCase(designVoice.fulfilled, (state) => {
        state.designPending = false;
      })
      .addCase(designVoice.rejected, (state) => {
        state.designPending = false;
      })
      .addCase(patchEntry.pending, (state, action) => {
        const { voiceUuid, patch } = action.meta.arg;
        const entry = state.entries.find((e) => e.voiceUuid === voiceUuid);
        if (!entry) return;
        if (patch.name !== undefined) entry.name = patch.name;
        if (patch.tags !== undefined) entry.tags = patch.tags;
        if (patch.pinned !== undefined) entry.pinned = patch.pinned;
        if (patch.persona !== undefined) entry.persona = patch.persona;
        entry.updatedAt = new Date().toISOString();
      })
      .addCase(patchEntry.fulfilled, (state, action: PayloadAction<VoiceLibraryEntry>) => {
        const idx = state.entries.findIndex((e) => e.voiceUuid === action.payload.voiceUuid);
        if (idx >= 0) state.entries[idx] = action.payload;
        else state.entries.push(action.payload);
      });
  },
});

export const voiceLibraryActions = voiceLibrarySlice.actions;

/* ── Selectors ───────────────────────────────────────────────────────── */

/** Pinned-first, then most-recently-updated. Drives the "My voices" grid
 *  (design spec §5's stated sort). */
export const selectMyVoices = createSelector(
  [(state: { voiceLibrary: VoiceLibraryState }) => state.voiceLibrary.entries],
  (entries): VoiceLibraryEntry[] =>
    entries.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }),
);

export function selectVoiceByUuid(
  state: { voiceLibrary: VoiceLibraryState },
  voiceUuid: string,
): VoiceLibraryEntry | undefined {
  return state.voiceLibrary.entries.find((e) => e.voiceUuid === voiceUuid);
}

export type { VoiceLibraryEntry, VoiceLibraryPatch, VoiceLibraryUsageEntry };

/* ── Cross-tab refetch-on-focus (spec §5) ───────────────────────────────── */

/** Refetch only kicks in once the last fetch is at least this old — cheap
 *  insurance against a refetch storm from rapid alt-tabbing, and against
 *  duplicating the initial hydrate fetch a view already triggers on mount. */
const STALE_MS = 5000;

/** Minimal store shape the listener needs. Deliberately narrower than the
 *  full `RootState`/`AppDispatch` pair (rather than `import type { ... }
 *  from './index'`, the pattern `ui-slice.ts`/`queue-thunks.ts` use) so a
 *  test can exercise the listener against a single-slice store without
 *  satisfying every other slice's shape. Method-shorthand `dispatch(...)`
 *  (vs. an arrow-typed property) keeps parameter checking bivariant, so
 *  the real store's thunk-aware `AppDispatch` — whose dispatch signature
 *  is narrower than `(action: unknown) => unknown` — still satisfies
 *  this structurally at the `installVoiceLibraryFocusListener(store)`
 *  call site in `src/store/index.ts`. */
interface VoiceLibraryStoreLike {
  getState(): { voiceLibrary: VoiceLibraryState };
  dispatch(action: unknown): unknown;
}

/** Installs the `visibilitychange`/`focus` listener described in the
 *  module doc comment. Call once, from `src/store/index.ts`, after the
 *  store is constructed. Returns a teardown function (unused in
 *  production — the store lives for the app's lifetime — but handy for
 *  tests).
 *
 *  No-ops (and returns a no-op teardown) outside a DOM environment, and
 *  the refetch itself only fires when the library is non-empty AND stale
 *  — both true in every unrelated jsdom test's default (empty) state, so
 *  a stray `visibilitychange`/`focus` event elsewhere in the suite can
 *  never trigger an unexpected `api.listVoiceLibrary()` call. */
export function installVoiceLibraryFocusListener(store: VoiceLibraryStoreLike): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const maybeRefetch = () => {
    if (document.visibilityState !== 'visible') return;
    const { entries, lastFetchedAt } = store.getState().voiceLibrary;
    if (entries.length === 0) return;
    if (lastFetchedAt === null) return;
    if (Date.now() - lastFetchedAt < STALE_MS) return;
    store.dispatch(fetchVoiceLibrary());
  };

  document.addEventListener('visibilitychange', maybeRefetch);
  window.addEventListener('focus', maybeRefetch);

  return () => {
    document.removeEventListener('visibilitychange', maybeRefetch);
    window.removeEventListener('focus', maybeRefetch);
  };
}
