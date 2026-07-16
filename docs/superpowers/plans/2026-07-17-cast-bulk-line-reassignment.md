# Cast Bulk-Reassign Attributed Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user move many attributed lines from one character to another in a single, undoable action, reachable from both the roster/cast view and the script/review view, through one reusable form.

**Architecture:** A new cross-chapter reducer (`setSentencesCharacterBulk`) plus a one-level book-session-scoped undo slot (`lastBulkReassign`) live in the manuscript slice; the existing single-caller `ReattributeLinesModal` is generalized into a `source`-driven `ReassignLinesModal` (character / selection / unlink) with virtualized rows and a `Set`-based selection; a layout-level non-dismissing Undo banner completes the loop. No server change — line attribution round-trips through the existing generic `PUT /api/books/:id/state`.

**Tech Stack:** React 18 + TypeScript, Redux Toolkit (Immer), `@tanstack/react-virtual` (already a dependency), Vitest + React Testing Library, Playwright (e2e).

## Global Constraints

- **Composite key is load-bearing.** Sentence `id` restarts at 1 per chapter; every sentence lookup/selection key is `(chapterId, sentenceId)`, string-encoded as `` `${chapterId}:${sentenceId}` `` — verbatim the format `manuscript-slice.ts` and `mergedAwayKeys` already use.
- **No hex literals in components** — use the CSS custom-property design tokens (`--ink`, `--magenta`, `--peach`, etc.) via Tailwind classes, matching `reattribute-lines.tsx`.
- **Touch targets ≥44×44 px on touch devices** — `min-h-[44px] fine-pointer:min-h-0` (and `min-w-[44px] fine-pointer:min-w-0` for icon-only), per the Mobile testing protocol. Never `sm:min-h-0`.
- **RTK Immer** — slice reducers mutate drafts; do not rewrite to spreads.
- **OpenAPI is the type source of truth** — `Sentence` etc. come from generated types; do not hand-write them.
- **Every reassignment path must emit `changeLogActions.bumpBoundaryMove`** per affected chapter (the stale-audio precondition in `stale-chapters.ts:28`).
- **Persistence patch shape for manuscript actions is `{ sentences, mergedAwayKeys }`** — dropping `mergedAwayKeys` loses sentence-merge tombstones.
- **TDD, DRY, YAGNI, frequent commits.** Each task ends with a green test run and a commit.

---

## File Structure

- **Modify** `src/store/manuscript-slice.ts` — add `lastBulkReassign` state field; add `setSentencesCharacterBulk` + `undoBulkReassign` reducers; null the slot in `reset` / `hydrateFromBookState` / `hydrateFromAnalysis`; clear the slot on a conflicting single-line edit in `setSentenceCharacter` / `setSentencesCharacter` / `splitSentence` / `mergeSentences` / `promoteSentenceToTitle`.
- **Modify** `src/store/persistence-middleware.ts` — add persist rules for the two new actions; scope a persist-failure error toast to exactly those two action types.
- **Create** `src/modals/reassign-lines.tsx` — the generalized `ReassignLinesModal` (replaces `reattribute-lines.tsx`).
- **Delete** `src/modals/reattribute-lines.tsx` — folded into the above.
- **Create** `src/components/bulk-reassign-undo-banner.tsx` — layout-level non-dismissing Undo banner.
- **Modify** `src/components/layout.tsx` — swap the modal import/state/render to the `source` union; render the Undo banner in the banner region.
- **Modify** `src/modals/profile-drawer.tsx` — add a per-character "Reassign lines…" action that opens the form with `source: { kind: 'character' }`.
- **Modify** `src/views/manuscript.tsx` — add a checkbox multi-select mode + floating "Reassign N selected…" action bar opening `source: { kind: 'selection' }`.
- **Create** `e2e/cast-bulk-reassign.spec.ts` — browser golden path.
- **Create** `docs/features/1676-cast-bulk-line-reassignment.md` — regression plan (from `TEMPLATE.md`).
- **Modify** `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`.

Colocated test files (`*.test.ts`/`*.test.tsx`) sit next to each unit.

---

## Task 1: Bulk-reassign reducer + one-level undo slot

**Files:**
- Modify: `src/store/manuscript-slice.ts`
- Test: `src/store/manuscript-slice.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: existing `ManuscriptState`, `Sentence`.
- Produces:
  - `type SentenceKey = { chapterId: number; sentenceId: number }` (exported from the slice).
  - `manuscriptActions.setSentencesCharacterBulk({ keys: SentenceKey[]; characterId: string; targetLabel: string })` — rewrites `characterId` for each resolvable key, records inverse into `lastBulkReassign`.
  - `manuscriptActions.undoBulkReassign()` — restores each `prevCharacterId`, nulls the slot, records no new undo record.
  - `manuscript.lastBulkReassign: { moves: { chapterId: number; sentenceId: number; prevCharacterId: string }[]; targetLabel: string } | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/store/manuscript-slice.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { manuscriptSlice, manuscriptActions, type ManuscriptState } from './manuscript-slice';
import type { Sentence } from '../lib/types';

const reducer = manuscriptSlice.reducer;

function sent(chapterId: number, id: number, characterId: string): Sentence {
  return { chapterId, id, text: `s${id}`, characterId } as Sentence;
}

function baseState(sentences: Sentence[]): ManuscriptState {
  return {
    ...manuscriptSlice.getInitialState(),
    manuscriptId: 'm1',
    bookId: 'b1',
    sentences,
  };
}

describe('setSentencesCharacterBulk', () => {
  it('rewrites characterId for every resolvable key and records the inverse', () => {
    const s0 = baseState([sent(1, 1, 'egor'), sent(1, 2, 'egor'), sent(2, 1, 'anton')]);
    const s1 = reducer(
      s0,
      manuscriptActions.setSentencesCharacterBulk({
        keys: [
          { chapterId: 1, sentenceId: 1 },
          { chapterId: 1, sentenceId: 2 },
        ],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    expect(s1.sentences.find((x) => x.chapterId === 1 && x.id === 1)!.characterId).toBe('narrator');
    expect(s1.sentences.find((x) => x.chapterId === 1 && x.id === 2)!.characterId).toBe('narrator');
    expect(s1.sentences.find((x) => x.chapterId === 2 && x.id === 1)!.characterId).toBe('anton');
    expect(s1.lastBulkReassign).toEqual({
      moves: [
        { chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' },
        { chapterId: 1, sentenceId: 2, prevCharacterId: 'egor' },
      ],
      targetLabel: 'Narrator',
    });
  });

  it('skips keys that no longer resolve (drift) and records only applied moves', () => {
    const s0 = baseState([sent(1, 1, 'egor')]);
    const s1 = reducer(
      s0,
      manuscriptActions.setSentencesCharacterBulk({
        keys: [
          { chapterId: 1, sentenceId: 1 },
          { chapterId: 1, sentenceId: 99 }, // gone
        ],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    expect(s1.lastBulkReassign!.moves).toEqual([
      { chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' },
    ]);
  });

  it('does NOT clear the slot it just wrote (C1)', () => {
    const s0 = baseState([sent(1, 1, 'egor')]);
    const s1 = reducer(
      s0,
      manuscriptActions.setSentencesCharacterBulk({
        keys: [{ chapterId: 1, sentenceId: 1 }],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    expect(s1.lastBulkReassign).not.toBeNull();
  });
});

describe('undoBulkReassign', () => {
  it('restores prior ids, nulls the slot, and records no new undo record', () => {
    const s0 = baseState([sent(1, 1, 'egor'), sent(1, 2, 'egor')]);
    const s1 = reducer(
      s0,
      manuscriptActions.setSentencesCharacterBulk({
        keys: [
          { chapterId: 1, sentenceId: 1 },
          { chapterId: 1, sentenceId: 2 },
        ],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    const s2 = reducer(s1, manuscriptActions.undoBulkReassign());
    expect(s2.sentences.every((x) => x.characterId === 'egor')).toBe(true);
    expect(s2.lastBulkReassign).toBeNull();
  });

  it('is a no-op when the slot is empty', () => {
    const s0 = baseState([sent(1, 1, 'egor')]);
    const s1 = reducer(s0, manuscriptActions.undoBulkReassign());
    expect(s1.sentences[0].characterId).toBe('egor');
    expect(s1.lastBulkReassign).toBeNull();
  });
});

describe('lastBulkReassign clear-on-conflict (key-granular, M-2)', () => {
  function withBulk(): ManuscriptState {
    const s0 = baseState([sent(1, 1, 'egor'), sent(1, 2, 'egor'), sent(1, 3, 'anton')]);
    return reducer(
      s0,
      manuscriptActions.setSentencesCharacterBulk({
        keys: [
          { chapterId: 1, sentenceId: 1 },
          { chapterId: 1, sentenceId: 2 },
        ],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
  }

  it('survives an edit to an untouched sibling line in a touched chapter', () => {
    const s1 = withBulk();
    const s2 = reducer(
      s1,
      manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 3, characterId: 'egor' }),
    );
    expect(s2.lastBulkReassign).not.toBeNull();
  });

  it('clears when a later single reassign touches a moved key', () => {
    const s1 = withBulk();
    const s2 = reducer(
      s1,
      manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 1, characterId: 'anton' }),
    );
    expect(s2.lastBulkReassign).toBeNull();
  });

  it('clears when a split renumbers a moved key', () => {
    const s1 = withBulk();
    const s2 = reducer(
      s1,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 1,
        offsets: [1],
        characterIds: ['narrator', 'egor'],
      }),
    );
    expect(s2.lastBulkReassign).toBeNull();
  });

  it('clears on a second bulk (overwrite)', () => {
    const s1 = withBulk();
    const s2 = reducer(
      s1,
      manuscriptActions.setSentencesCharacterBulk({
        keys: [{ chapterId: 1, sentenceId: 3 }],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    // fresh slot for the new move, not the old one
    expect(s2.lastBulkReassign!.moves).toEqual([
      { chapterId: 1, sentenceId: 3, prevCharacterId: 'anton' },
    ]);
  });
});

describe('lastBulkReassign cross-book clearing (M-1)', () => {
  it('is nulled by reset', () => {
    const s1 = baseState([sent(1, 1, 'egor')]);
    s1.lastBulkReassign = { moves: [{ chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' }], targetLabel: 'X' };
    expect(reducer(s1, manuscriptActions.reset()).lastBulkReassign).toBeNull();
  });

  it('is nulled by hydrateFromBookState', () => {
    const s1 = baseState([sent(1, 1, 'egor')]);
    s1.lastBulkReassign = { moves: [{ chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' }], targetLabel: 'X' };
    const s2 = reducer(
      s1,
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'b2', manuscriptId: 'm2', title: 'T' } as never,
        sentences: [sent(1, 1, 'a')],
      }),
    );
    expect(s2.lastBulkReassign).toBeNull();
  });

  it('is nulled by hydrateFromAnalysis', () => {
    const s1 = baseState([sent(1, 1, 'egor')]);
    s1.lastBulkReassign = { moves: [{ chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' }], targetLabel: 'X' };
    const s2 = reducer(
      s1,
      manuscriptActions.hydrateFromAnalysis({ bookId: 'b1', sentences: [sent(1, 1, 'a')] } as never),
    );
    expect(s2.lastBulkReassign).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/store/manuscript-slice.test.ts`
Expected: FAIL — `setSentencesCharacterBulk`/`undoBulkReassign` are not functions; `lastBulkReassign` undefined.

- [ ] **Step 3: Add the state field + initial value**

In `src/store/manuscript-slice.ts`, add to the `ManuscriptState` interface (after `mergedAwayKeys`):

```ts
  /** #1676(c) — one-level, book-session-scoped undo for the last bulk line
      reassignment. Holds each moved key's PRIOR characterId so a single Undo
      restores them. NOT persisted (a full reload drops it — "undoable" is
      satisfied by in-session one-level undo). Cleared by any book transition
      (reset / hydrate*) and by a later edit that touches a moved key. */
  lastBulkReassign:
    | {
        moves: { chapterId: number; sentenceId: number; prevCharacterId: string }[];
        targetLabel: string;
      }
    | null;
```

Add to `initialState`:

```ts
  lastBulkReassign: null,
```

Export the key type near the top-level exports:

```ts
export type SentenceKey = { chapterId: number; sentenceId: number };
```

- [ ] **Step 4: Add a conflict helper + the two reducers**

Add a module-level helper above `manuscriptSlice` (after the imports):

```ts
/* #1676(c) — key-granular undo invalidation. Returns true when any of the
   just-edited keys is a member of the pending bulk-undo's moved-key set, in
   which case the caller nulls lastBulkReassign. Chapter-granularity was
   rejected: the origin bug spans nearly every chapter, so a chapter-level
   predicate would let almost any later edit nuke the undo. */
function bulkUndoConflicts(s: ManuscriptState, touched: string[]): boolean {
  if (!s.lastBulkReassign) return false;
  const moved = new Set(s.lastBulkReassign.moves.map((m) => `${m.chapterId}:${m.sentenceId}`));
  return touched.some((k) => moved.has(k));
}
```

Add the two reducers inside the `reducers: { ... }` block (place them right after `setSentencesCharacter`):

```ts
    /* #1676(c) — cross-chapter bulk reassignment. Rewrites characterId for each
       resolvable (chapterId, sentenceId) key and records each key's PRIOR
       characterId into the one-level undo slot. Keys that no longer resolve
       (drift between modal-open and apply) are skipped; only applied moves are
       recorded. Exempt from the clear-on-conflict guard — it must not clear the
       slot it just wrote (fixes C1). */
    setSentencesCharacterBulk: (
      s,
      a: PayloadAction<{ keys: SentenceKey[]; characterId: string; targetLabel: string }>,
    ) => {
      const index = new Map<string, Sentence>();
      for (const sent of s.sentences) index.set(`${sent.chapterId}:${sent.id}`, sent);
      const moves: { chapterId: number; sentenceId: number; prevCharacterId: string }[] = [];
      for (const k of a.payload.keys) {
        const sent = index.get(`${k.chapterId}:${k.sentenceId}`);
        if (!sent) continue; // drift — skip
        moves.push({ chapterId: k.chapterId, sentenceId: k.sentenceId, prevCharacterId: sent.characterId });
        sent.characterId = a.payload.characterId;
      }
      s.lastBulkReassign = { moves, targetLabel: a.payload.targetLabel };
    },

    /* #1676(c) — restore the last bulk reassignment. Rewrites each moved key
       back to its prevCharacterId and nulls the slot. Records NO new undo
       record (no undo-of-undo) — which is why Undo cannot reuse the recording
       reducer above. No-op when the slot is empty. */
    undoBulkReassign: (s) => {
      const slot = s.lastBulkReassign;
      if (!slot) return;
      const index = new Map<string, Sentence>();
      for (const sent of s.sentences) index.set(`${sent.chapterId}:${sent.id}`, sent);
      for (const m of slot.moves) {
        const sent = index.get(`${m.chapterId}:${m.sentenceId}`);
        if (sent) sent.characterId = m.prevCharacterId;
      }
      s.lastBulkReassign = null;
    },
```

- [ ] **Step 5: Null the slot in the three book-transition reducers (M-1)**

In `reset`, add:

```ts
      s.lastBulkReassign = null;
```

In `hydrateFromBookState`, add at the end (after `s.mergedAwayKeys = ...`):

```ts
      s.lastBulkReassign = null;
```

In `hydrateFromAnalysis`, add immediately after the `if (a.payload.bookId) s.bookId = a.payload.bookId;` line (so it clears even on the no-sentences early return):

```ts
      s.lastBulkReassign = null;
```

- [ ] **Step 6: Wire clear-on-conflict into the single-line edit reducers**

In `setSentenceCharacter`, after `if (sent) sent.characterId = ...`:

```ts
      if (bulkUndoConflicts(s, [`${a.payload.chapterId}:${a.payload.sentenceId}`]))
        s.lastBulkReassign = null;
```

In `setSentencesCharacter`, after the loop:

```ts
      if (
        bulkUndoConflicts(
          s,
          a.payload.sentenceIds.map((id) => `${a.payload.chapterId}:${id}`),
        )
      )
        s.lastBulkReassign = null;
```

In `splitSentence`, after `s.sentences.splice(idx, 1, ...pieces);`:

```ts
      if (bulkUndoConflicts(s, [`${a.payload.chapterId}:${a.payload.sentenceId}`]))
        s.lastBulkReassign = null;
```

In `mergeSentences`, after the drop loop:

```ts
      if (
        bulkUndoConflicts(
          s,
          a.payload.sentenceIds.map((id) => `${a.payload.chapterId}:${id}`),
        )
      )
        s.lastBulkReassign = null;
```

In `promoteSentenceToTitle`, after the splice:

```ts
      if (bulkUndoConflicts(s, [`${a.payload.chapterId}:${a.payload.sentenceId}`]))
        s.lastBulkReassign = null;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -- src/store/manuscript-slice.test.ts`
Expected: PASS (all bulk / undo / clear-on-conflict / cross-book cases green).

- [ ] **Step 8: Commit**

```bash
git add src/store/manuscript-slice.ts src/store/manuscript-slice.test.ts
git commit -m "feat(frontend): bulk line-reassign reducer + one-level undo slot"
```

---

## Task 2: Persistence rules + scoped persist-failure toast

**Files:**
- Modify: `src/store/persistence-middleware.ts`
- Test: `src/store/persistence-middleware.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `manuscriptActions.setSentencesCharacterBulk`, `manuscriptActions.undoBulkReassign` (Task 1); `notificationsActions.pushToast` (existing).
- Produces: debounced `PUT /api/books/:id/state` with `slice: 'manuscript'`, patch `{ sentences, mergedAwayKeys }`, for both new action types; an `error`-kind toast dispatched when the flush rejects, scoped to those two types only.

- [ ] **Step 1: Write the failing tests**

Append to `src/store/persistence-middleware.test.ts` (follow the file's existing store-mock harness; the shape below assumes a helper `makeStore()` that installs the middleware and stubs `api.putBookState` — reuse whatever the file already defines, otherwise add this harness):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { persistenceMiddleware } from './persistence-middleware';
import { manuscriptSlice, manuscriptActions } from './manuscript-slice';
import { uiSlice } from './ui-slice';
import { notificationsSlice } from './notifications-slice';
import * as apiModule from '../lib/api';

function makeStore(putImpl: () => Promise<void>) {
  vi.spyOn(apiModule.api, 'putBookState').mockImplementation(putImpl as never);
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
      // minimal siblings the middleware's typed read touches:
      cast: (s = { characters: [] }) => s,
      revisions: (s = {}) => s,
      changeLog: (s = { events: [] }) => s,
      bookMeta: (s = { saved: {} }) => s,
    } as never,
    middleware: (gDM) => gDM().concat(persistenceMiddleware),
  });
  // put a bookId in scope so bookIdFromState resolves
  store.dispatch(uiSlice.actions.__setStageForTest?.({ bookId: 'b1' }) ?? { type: 'noop' });
  return store;
}

describe('bulk-reassign persistence', () => {
  beforeEach(() => vi.useFakeTimers());

  it('flushes the full {sentences, mergedAwayKeys} patch for setSentencesCharacterBulk', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const store = makeStore(put);
    store.dispatch(
      manuscriptActions.setSentencesCharacterBulk({
        keys: [{ chapterId: 1, sentenceId: 1 }],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({
        slice: 'manuscript',
        patch: expect.objectContaining({ sentences: expect.any(Array), mergedAwayKeys: expect.any(Array) }),
      }),
    );
  });

  it('surfaces an error toast when a bulk apply PUT fails', async () => {
    const store = makeStore(() => Promise.reject(new Error('net')));
    store.dispatch(
      manuscriptActions.setSentencesCharacterBulk({
        keys: [{ chapterId: 1, sentenceId: 1 }],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    await vi.runAllTimersAsync();
    const toasts = (store.getState() as { notifications: { toasts: { kind: string }[] } }).notifications.toasts;
    expect(toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('surfaces an error toast when an undo PUT fails', async () => {
    const store = makeStore(() => Promise.reject(new Error('net')));
    store.dispatch(manuscriptActions.undoBulkReassign());
    await vi.runAllTimersAsync();
    const toasts = (store.getState() as { notifications: { toasts: { kind: string }[] } }).notifications.toasts;
    expect(toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('does NOT toast when a non-bulk manuscript edit PUT fails (scope)', async () => {
    const store = makeStore(() => Promise.reject(new Error('net')));
    store.dispatch(
      manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 1, characterId: 'x' }),
    );
    await vi.runAllTimersAsync();
    const toasts = (store.getState() as { notifications: { toasts: { kind: string }[] } }).notifications.toasts;
    expect(toasts.length).toBe(0);
  });
});
```

> Implementer note: if `ui-slice` has no `__setStageForTest`, set the stage via whatever reducer the existing middleware tests already use to put a `bookId` in scope (grep the test file for `bookId`). The assertion targets are the toast presence/absence, not the stage-setting mechanism.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/store/persistence-middleware.test.ts`
Expected: FAIL — no rule for the bulk actions (no PUT), and no toast on failure.

- [ ] **Step 3: Add the two persist rules**

In `PERSIST_RULES`, after the `'manuscript/setSentencesCharacter'` entry:

```ts
  'manuscript/setSentencesCharacterBulk': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* #1676(c) — the undo restore is a committed edit like any reassignment;
     persist the full manuscript patch so the reverted attribution survives a
     reload. */
  'manuscript/undoBulkReassign': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
```

- [ ] **Step 4: Scope a persist-failure toast to the two bulk actions**

Add the import at the top:

```ts
import { notificationsActions } from './notifications-slice';
```

Add a module-level constant near `DEFAULT_DEBOUNCE_MS`:

```ts
/* #1676(c) — action types whose persist failure the user MUST see: a silent
   swallow would leave redux showing the move applied while disk holds the prior
   attribution. Scoped to the two bulk actions only — broadening to every
   manuscript flush (let alone every slice) would change long-standing swallow
   behaviour for unrelated edits. */
const TOAST_ON_PERSIST_FAILURE = new Set<string>([
  'manuscript/setSentencesCharacterBulk',
  'manuscript/undoBulkReassign',
]);
```

Rework the middleware closure so the flush knows whether the pending write must toast on failure. Replace the `flush` + returned handler with:

```ts
export const persistenceMiddleware: Middleware = (store) => {
  const timers = new Map<StateSlice, ReturnType<typeof setTimeout>>();
  const pending = new Map<StateSlice, unknown>();
  /* Slices whose currently-pending write was (at least once this debounce
     window) triggered by a toast-worthy bulk action. Last-wins on the patch
     means the flush persists the latest manuscript state regardless, so if it
     fails the bulk move didn't land — toasting is correct even if a non-bulk
     edit also rode along in the same window. */
  const toastPending = new Set<StateSlice>();

  const flush = (bookId: string, slice: StateSlice) => {
    const patch = pending.get(slice);
    pending.delete(slice);
    timers.delete(slice);
    const shouldToast = toastPending.delete(slice);
    if (patch === undefined) return;
    api.putBookState(bookId, { slice, patch }).catch((err) => {
      console.error(`[persist] PUT /api/books/${bookId}/state slice=${slice} failed`, err);
      if (shouldToast) {
        store.dispatch(
          notificationsActions.pushToast({
            kind: 'error',
            message: 'Line reassignment could not be saved. Check your connection and try again.',
            dedupeKey: 'bulk-reassign-persist-failed',
          }),
        );
      }
    });
  };

  return (next) => (action) => {
    const result = next(action);
    const a = action as { type?: string };
    const type = a?.type;
    if (!type) return result;
    const rule = PERSIST_RULES[type];
    if (!rule) return result;

    const after = store.getState() as PersistableRootState;
    const bookId = bookIdFromState(after);
    if (!bookId) return result;

    pending.set(rule.slice, rule.build(after, bookId));
    if (TOAST_ON_PERSIST_FAILURE.has(type)) toastPending.add(rule.slice);
    const prev = timers.get(rule.slice);
    if (prev) clearTimeout(prev);
    timers.set(
      rule.slice,
      setTimeout(() => flush(bookId, rule.slice), debounceMs(after)),
    );
    return result;
  };
};
```

> Verify `notificationsActions.pushToast` accepts `{ kind, message, dedupeKey }` — grep `src/store/notifications-slice.ts` for the `pushToast` payload type; if `dedupeKey` isn't a field, drop it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- src/store/persistence-middleware.test.ts`
Expected: PASS (full patch shape; toast on bulk apply + undo failure; no toast on non-bulk failure).

- [ ] **Step 6: Commit**

```bash
git add src/store/persistence-middleware.ts src/store/persistence-middleware.test.ts
git commit -m "feat(frontend): persist bulk reassign + scoped persist-failure toast"
```

---

## Task 3: `ReassignLinesModal` reusable form

**Files:**
- Create: `src/modals/reassign-lines.tsx`
- Delete: `src/modals/reattribute-lines.tsx`
- Test: `src/modals/reassign-lines.test.tsx`

**Interfaces:**
- Consumes: `manuscriptActions.setSentencesCharacterBulk` (Task 1); `changeLogActions.bumpBoundaryMove`; `s.manuscript.sentences`, `s.cast.characters`, `s.chapters.chapters`; `useVirtualizer` from `@tanstack/react-virtual`; `UnlinkAliasImpactedChapter` from `../lib/api`.
- Produces:

```ts
export type SentenceKey = { chapterId: number; sentenceId: number };
export type ReassignSource =
  | { kind: 'character'; characterId: string }
  | { kind: 'selection'; keys: SentenceKey[] }
  | { kind: 'unlink'; impactedChapters: UnlinkAliasImpactedChapter[]; aliasCharacterId: string };
export function ReassignLinesModal(props: { source: ReassignSource; onClose: () => void }): JSX.Element;
```

Behavior contract:
- Resolves candidate rows from `source` (character → all sentences on that id; selection → hydrate keys; unlink → impacted-chapter candidates).
- Selection is a `Set<string>` of `` `${chapterId}:${sentenceId}` `` over the **full resolved candidate list** in component state — never from mounted DOM rows.
- Header controls: select-all, invert, live selected count; per-chapter select-all; text-substring filter; current-speaker facet (only meaningful when rows span speakers); "select all matching filter".
- Virtualized row list via `useVirtualizer` on the modal's own scroll container.
- Target picker: roster dropdown; source disabled; pending-removal characters excluded; Narrator target triggers a light confirm.
- Apply → lightweight confirm ("Reassign N lines from X to Y across M chapters?") → re-validate keys against live store (skip drifted, report skipped) → dispatch `setSentencesCharacterBulk` + `bumpBoundaryMove` per affected chapter → `onClose()`.
- Empty state preserved.

- [ ] **Step 1: Write the failing component tests**

Create `src/modals/reassign-lines.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ReassignLinesModal } from './reassign-lines';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { changeLogSlice } from '../store/change-log-slice';

function makeStore() {
  return configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      cast: castSlice.reducer,
      chapters: chaptersSlice.reducer,
      changeLog: changeLogSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        manuscriptId: 'm1',
        bookId: 'b1',
        sentences: [
          { chapterId: 1, id: 1, text: 'Alpha line.', characterId: 'egor' },
          { chapterId: 1, id: 2, text: 'Beta line.', characterId: 'egor' },
          { chapterId: 2, id: 1, text: 'Gamma line.', characterId: 'egor' },
        ] as never,
      },
      cast: {
        ...castSlice.getInitialState(),
        characters: [
          { id: 'egor', name: 'Егор' },
          { id: 'anton', name: 'Антон' },
          { id: 'narrator', name: 'Narrator' },
        ] as never,
      },
      chapters: {
        ...chaptersSlice.getInitialState(),
        chapters: [
          { id: 1, title: 'One' },
          { id: 2, title: 'Two' },
        ] as never,
      },
    } as never,
  });
}

function renderModal(source: Parameters<typeof ReassignLinesModal>[0]['source']) {
  const store = makeStore();
  const onClose = vi.fn();
  const spy = vi.spyOn(store, 'dispatch');
  render(
    <Provider store={store}>
      <ReassignLinesModal source={source} onClose={onClose} />
    </Provider>,
  );
  return { store, onClose, spy };
}

describe('ReassignLinesModal — character source', () => {
  it('lists every line on the character, grouped by chapter', () => {
    renderModal({ kind: 'character', characterId: 'egor' });
    expect(screen.getByText('Alpha line.')).toBeInTheDocument();
    expect(screen.getByText('Gamma line.')).toBeInTheDocument();
  });

  it('select-all then apply dispatches one bulk move + bumpBoundaryMove per chapter', async () => {
    const { spy } = renderModal({ kind: 'character', characterId: 'egor' });
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    // pick a target
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'anton' } });
    fireEvent.click(screen.getByRole('button', { name: /^reassign/i }));
    // confirm step
    fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));
    const bulk = spy.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'manuscript/setSentencesCharacterBulk',
    );
    expect(bulk).toBeTruthy();
    expect((bulk![0] as { payload: { keys: unknown[] } }).payload.keys).toHaveLength(3);
    const bumps = spy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'changeLog/bumpBoundaryMove',
    );
    expect(bumps).toHaveLength(2); // chapters 1 and 2
  });

  it('disables the source character in the target picker', () => {
    renderModal({ kind: 'character', characterId: 'egor' });
    const opt = within(screen.getByLabelText(/reassign to/i)).getByRole('option', { name: /Егор/ });
    expect(opt).toBeDisabled();
  });

  it('text filter + select-all-matching selects only the filtered subset', () => {
    renderModal({ kind: 'character', characterId: 'egor' });
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: /select all matching/i }));
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
  });

  it('shows the empty state for a character with zero lines', () => {
    renderModal({ kind: 'character', characterId: 'nobody' });
    expect(screen.getByText(/0 lines|nothing to reassign/i)).toBeInTheDocument();
  });
});

describe('ReassignLinesModal — Narrator confirm', () => {
  it('requires an extra confirm when the target is Narrator', async () => {
    const { spy } = renderModal({ kind: 'character', characterId: 'egor' });
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'narrator' } });
    fireEvent.click(screen.getByRole('button', { name: /^reassign/i }));
    // Narrator-specific confirm copy appears
    expect(await screen.findByText(/narrator/i)).toBeInTheDocument();
    expect(
      spy.mock.calls.some((c) => (c[0] as { type?: string })?.type === 'manuscript/setSentencesCharacterBulk'),
    ).toBe(false); // not yet applied
  });
});

describe('ReassignLinesModal — key drift at apply (m9)', () => {
  it('skips keys that no longer resolve and reports the count', async () => {
    const store = makeStore();
    const onClose = vi.fn();
    render(
      <Provider store={store}>
        <ReassignLinesModal source={{ kind: 'selection', keys: [
          { chapterId: 1, sentenceId: 1 },
          { chapterId: 1, sentenceId: 2 },
        ] }} onClose={onClose} />
      </Provider>,
    );
    // Simulate drift: sentence (1,2) disappears after the modal opened.
    store.dispatch(
      manuscriptActions.mergeSentences({ chapterId: 1, sentenceIds: [1, 2] }),
    );
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'anton' } });
    fireEvent.click(screen.getByRole('button', { name: /^reassign/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));
    expect(await screen.findByText(/no longer existed|were skipped/i)).toBeInTheDocument();
  });
});
```

> Implementer note on virtualization + jsdom: `useVirtualizer` measures a zero-height scroll container in jsdom, so it may mount zero rows. Give the modal an `initialRect`/`estimateSize` and, for tests, drive selection through the header controls (select-all / select-all-matching / invert) and the in-memory count — which is exactly the render-independent contract §1 requires — rather than asserting on per-row checkboxes. The per-row checkbox is exercised in the e2e spec (Task 8) under a real browser.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/modals/reassign-lines.test.tsx`
Expected: FAIL — module `./reassign-lines` does not exist.

- [ ] **Step 3: Write the component**

Create `src/modals/reassign-lines.tsx`:

```tsx
/* Reassign Lines modal (#1676 part c).

   One reusable form for moving many attributed lines from one character to
   another, driven by a discriminated `source`:
     - character: every sentence currently on a character (roster path)
     - selection: an explicit key set multi-selected in the script view
     - unlink:    today's alias-unlink flow (feature b reuses this)

   Selection is a Set<"chapterId:sentenceId"> over the FULL resolved candidate
   list held in component state — never derived from mounted (virtualized) DOM
   rows, so "select all" covers the whole 1184/10k-row set, not just the window.
   Apply routes through a lightweight confirm, re-validates keys against the
   live store (drift), then dispatches ONE setSentencesCharacterBulk plus a
   bumpBoundaryMove per affected chapter. The layout-level Undo banner (see
   bulk-reassign-undo-banner.tsx) owns the undo affordance. */

import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconClose } from '../lib/icons';
import { useAppDispatch, useAppSelector } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { changeLogActions } from '../store/change-log-slice';
import type { UnlinkAliasImpactedChapter } from '../lib/api';
import type { Sentence } from '../lib/types';

export type SentenceKey = { chapterId: number; sentenceId: number };

export type ReassignSource =
  | { kind: 'character'; characterId: string }
  | { kind: 'selection'; keys: SentenceKey[] }
  | { kind: 'unlink'; impactedChapters: UnlinkAliasImpactedChapter[]; aliasCharacterId: string };

interface Props {
  source: ReassignSource;
  onClose: () => void;
}

const CHAR_PREVIEW = 140;
const keyOf = (chapterId: number, sentenceId: number) => `${chapterId}:${sentenceId}`;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

interface Row {
  chapterId: number;
  sentenceId: number;
  text: string;
  characterId: string;
}

export function ReassignLinesModal({ source, onClose }: Props) {
  const dispatch = useAppDispatch();
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const characters = useAppSelector((s) => s.cast.characters);
  const chapters = useAppSelector((s) => s.chapters.chapters);

  const chapterTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of chapters) m.set(c.id, c.title);
    return m;
  }, [chapters]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of characters) m.set(c.id, c.name);
    return m;
  }, [characters]);

  /* Resolve the full candidate list from `source`. Read from the live store so
     the list reflects concurrent edits, but freeze the identity set at open by
     memoizing on `source` only for the selection/unlink key lists (the row TEXT
     may still update). */
  const rows = useMemo<Row[]>(() => {
    const byKey = new Map<string, Sentence>();
    for (const s of sentences) byKey.set(keyOf(s.chapterId, s.id), s);
    if (source.kind === 'character') {
      return sentences
        .filter((s) => s.characterId === source.characterId)
        .map((s) => ({ chapterId: s.chapterId, sentenceId: s.id, text: s.text, characterId: s.characterId }));
    }
    if (source.kind === 'selection') {
      return source.keys
        .map((k) => byKey.get(keyOf(k.chapterId, k.sentenceId)))
        .filter((s): s is Sentence => Boolean(s))
        .map((s) => ({ chapterId: s.chapterId, sentenceId: s.id, text: s.text, characterId: s.characterId }));
    }
    // unlink
    const out: Row[] = [];
    for (const ch of source.impactedChapters) {
      for (const sid of ch.candidateSentenceIds) {
        const s = byKey.get(keyOf(ch.chapterId, sid));
        if (s) out.push({ chapterId: s.chapterId, sentenceId: s.id, text: s.text, characterId: s.characterId });
      }
    }
    return out;
  }, [source, sentences]);

  const spansSpeakers = useMemo(() => new Set(rows.map((r) => r.characterId)).size > 1, [rows]);

  // --- filters ---
  const [textFilter, setTextFilter] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState<string>(''); // '' = all
  const filteredRows = useMemo(() => {
    const t = textFilter.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!t || r.text.toLowerCase().includes(t)) &&
        (!speakerFilter || r.characterId === speakerFilter),
    );
  }, [rows, textFilter, speakerFilter]);

  // --- selection (render-independent Set over the FULL candidate list) ---
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.map((r) => keyOf(r.chapterId, r.sentenceId))));
  const toggle = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  const selectAll = () => setSelected(new Set(rows.map((r) => keyOf(r.chapterId, r.sentenceId))));
  const selectNone = () => setSelected(new Set());
  const invert = () =>
    setSelected((prev) => {
      const next = new Set<string>();
      for (const r of rows) {
        const k = keyOf(r.chapterId, r.sentenceId);
        if (!prev.has(k)) next.add(k);
      }
      return next;
    });
  const selectAllMatching = () =>
    setSelected(new Set(filteredRows.map((r) => keyOf(r.chapterId, r.sentenceId))));
  const selectChapter = (chapterId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) if (r.chapterId === chapterId) next.add(keyOf(r.chapterId, r.sentenceId));
      return next;
    });

  // --- target picker ---
  const defaultTarget = source.kind === 'unlink' ? source.aliasCharacterId : '';
  const [targetId, setTargetId] = useState<string>(defaultTarget);
  const sourceCharacterId = source.kind === 'character' ? source.characterId : undefined;
  const targetOptions = characters.filter(
    (c) => !(c as { pendingRemoval?: boolean }).pendingRemoval,
  );

  // --- confirm gating ---
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const affectedChapters = useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) if (selected.has(keyOf(r.chapterId, r.sentenceId))) set.add(r.chapterId);
    return [...set];
  }, [rows, selected]);

  const selectedCount = selected.size;
  const isEmpty = rows.length === 0;
  const canApply = selectedCount > 0 && targetId !== '' && targetId !== sourceCharacterId;

  function apply() {
    // Re-validate each selected key against the LIVE store (m9 — drift).
    const liveKeys = new Set(sentences.map((s) => keyOf(s.chapterId, s.id)));
    const requested = [...selected];
    const resolvable = requested.filter((k) => liveKeys.has(k));
    const skipped = requested.length - resolvable.length;
    const keys: SentenceKey[] = resolvable.map((k) => {
      const [c, s] = k.split(':');
      return { chapterId: Number(c), sentenceId: Number(s) };
    });
    dispatch(
      manuscriptActions.setSentencesCharacterBulk({
        keys,
        characterId: targetId,
        targetLabel: nameById.get(targetId) ?? 'Character',
      }),
    );
    for (const chapterId of new Set(keys.map((k) => k.chapterId))) {
      dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 }));
    }
    if (skipped > 0) {
      setResult(`Moved ${keys.length} lines; ${skipped} no longer existed and were skipped.`);
      setConfirming(false);
    } else {
      onClose();
    }
  }

  // --- virtualization over filteredRows ---
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  const targetName = nameById.get(targetId) ?? '';
  const sourceName = sourceCharacterId ? nameById.get(sourceCharacterId) ?? '' : 'the current speaker';
  const isNarratorTarget = targetName.toLowerCase() === 'narrator';

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/30 z-50 fade-in" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reassign lines"
        className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[min(760px,calc(100vw-32px))] max-h-[min(84vh,calc(100vh-64px))] bg-white rounded-3xl shadow-drawer flex flex-col"
      >
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-md rounded-t-3xl border-b border-ink/10 px-6 py-4 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Reassign lines</p>
            <h3 className="text-lg font-bold text-ink leading-tight truncate">
              {selectedCount} selected
            </h3>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-w-[44px] min-h-[44px] fine-pointer:min-w-0 fine-pointer:min-h-0"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        {isEmpty ? (
          <div className="px-6 py-8 text-sm text-ink/65">
            <p className="font-semibold text-ink mb-1">Nothing to reassign here.</p>
            <p>There are 0 lines to move for this selection.</p>
          </div>
        ) : (
          <>
            {/* controls */}
            <div className="px-6 py-3 border-b border-ink/10 flex flex-wrap items-center gap-2">
              <button onClick={selectAll} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Select all</button>
              <button onClick={selectNone} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Clear</button>
              <button onClick={invert} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Invert</button>
              <input
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
                placeholder="Filter text…"
                className="flex-1 min-w-[140px] text-sm px-3 py-1.5 rounded-full border border-ink/15 bg-canvas/40"
              />
              {spansSpeakers && (
                <select
                  aria-label="Filter by current speaker"
                  value={speakerFilter}
                  onChange={(e) => setSpeakerFilter(e.target.value)}
                  className="text-sm px-2 py-1.5 rounded-full border border-ink/15 bg-white"
                >
                  <option value="">All speakers</option>
                  {[...new Set(rows.map((r) => r.characterId))].map((id) => (
                    <option key={id} value={id}>{nameById.get(id) ?? id}</option>
                  ))}
                </select>
              )}
              <button onClick={selectAllMatching} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-magenta/12 text-magenta hover:bg-magenta/20 min-h-[44px] fine-pointer:min-h-0">
                Select all matching
              </button>
            </div>

            {/* virtualized rows */}
            <div ref={scrollRef} className="px-6 py-2 overflow-y-auto scrollbar-thin flex-1">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const r = filteredRows[vi.index];
                  const k = keyOf(r.chapterId, r.sentenceId);
                  return (
                    <label
                      key={k}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                      className="flex items-start gap-3 py-2.5 border-b border-ink/8 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(k)}
                        onChange={() => toggle(k)}
                        className="mt-1 w-4 h-4 shrink-0"
                      />
                      <span className="flex-1 text-sm text-ink/80 leading-relaxed">
                        <span className="text-[11px] text-ink/45 mr-2">
                          {chapterTitleById.get(r.chapterId) ?? `Ch ${r.chapterId}`} · {r.sentenceId}
                        </span>
                        {truncate(r.text, CHAR_PREVIEW)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* footer */}
            <div className="sticky bottom-0 bg-white/95 backdrop-blur-md border-t border-ink/10 px-6 py-3 flex flex-wrap items-center justify-end gap-2 rounded-b-3xl">
              {result && <p className="flex-1 text-xs text-ink/60">{result}</p>}
              <label className="text-sm text-ink/70 flex items-center gap-2">
                Reassign to
                <select
                  aria-label="Reassign to"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="text-sm px-2 py-1.5 rounded-full border border-ink/15 bg-white"
                >
                  <option value="">Choose…</option>
                  {targetOptions.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.id === sourceCharacterId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!canApply}
                onClick={() => setConfirming(true)}
                className="px-4 py-2 rounded-full text-sm font-semibold bg-magenta text-white hover:bg-magenta/90 disabled:opacity-40 min-h-[44px] fine-pointer:min-h-0"
              >
                Reassign {selectedCount} lines
              </button>
            </div>
          </>
        )}
      </div>

      {/* confirm layer */}
      {confirming && (
        <>
          <div className="fixed inset-0 bg-ink/40 z-[60]" />
          <div role="alertdialog" aria-label="Confirm reassignment" className="fixed left-1/2 top-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100vw-32px))] bg-white rounded-2xl shadow-drawer p-6">
            <h4 className="text-base font-bold text-ink mb-2">
              Reassign {selectedCount} lines from {sourceName} to {targetName} across {affectedChapters.length} chapter{affectedChapters.length === 1 ? '' : 's'}?
            </h4>
            {isNarratorTarget && (
              <p className="text-sm text-amber-700 mb-3">
                You're moving these lines onto <strong>Narrator</strong>. Re-check this is intended — merging speech back into narration is easy to do by accident.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} className="px-4 py-2 rounded-full text-sm font-semibold bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Cancel</button>
              <button onClick={apply} className="px-4 py-2 rounded-full text-sm font-semibold bg-magenta text-white hover:bg-magenta/90 min-h-[44px] fine-pointer:min-h-0">Confirm</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 4: Delete the old modal**

```bash
git rm src/modals/reattribute-lines.tsx
```

(The sole caller is rewired in Task 5; running tests before Task 5 will show the layout import breaking — that's expected and resolved there. To keep this task's test run green in isolation, do Step 5 below before the test run.)

- [ ] **Step 5: Run the component tests**

Run: `npm run test -- src/modals/reassign-lines.test.tsx`
Expected: PASS (character listing, select-all → bulk + 2 bumps, source disabled, filter+select-all-matching count, empty state, Narrator confirm gate, drift skip report).

- [ ] **Step 6: Commit**

```bash
git add src/modals/reassign-lines.tsx src/modals/reassign-lines.test.tsx
git commit -m "feat(frontend): reusable ReassignLinesModal (character/selection/unlink sources)"
```

---

## Task 4: Layout-level Undo banner

**Files:**
- Create: `src/components/bulk-reassign-undo-banner.tsx`
- Modify: `src/components/layout.tsx` (render it in the banner region ~`1645-1679`)
- Test: `src/components/bulk-reassign-undo-banner.test.tsx`

**Interfaces:**
- Consumes: `s.manuscript.lastBulkReassign`; `manuscriptActions.undoBulkReassign`; `changeLogActions.appendLogEvent`.
- Produces: `export function BulkReassignUndoBanner(): JSX.Element | null` — renders only when the slot is non-null; Undo dispatches `undoBulkReassign` + one `appendLogEvent` revert-audit event.

- [ ] **Step 1: Write the failing test**

Create `src/components/bulk-reassign-undo-banner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { BulkReassignUndoBanner } from './bulk-reassign-undo-banner';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';

function makeStore(withSlot: boolean) {
  return configureStore({
    reducer: { manuscript: manuscriptSlice.reducer, changeLog: changeLogSlice.reducer },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        sentences: [{ chapterId: 1, id: 1, text: 'x', characterId: 'narrator' }] as never,
        lastBulkReassign: withSlot
          ? { moves: [{ chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' }], targetLabel: 'Narrator' }
          : null,
      },
    } as never,
  });
}

describe('BulkReassignUndoBanner', () => {
  it('renders nothing when the slot is empty', () => {
    const store = makeStore(false);
    const { container } = render(<Provider store={store}><BulkReassignUndoBanner /></Provider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count + target and reverts on Undo, appending a revert event', () => {
    const store = makeStore(true);
    render(<Provider store={store}><BulkReassignUndoBanner /></Provider>);
    expect(screen.getByText(/1 line.*Narrator/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    const s = store.getState();
    expect(s.manuscript.sentences[0].characterId).toBe('egor');
    expect(s.manuscript.lastBulkReassign).toBeNull();
    expect(s.changeLog.events.some((e) => /revert/i.test(e.note ?? ''))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/bulk-reassign-undo-banner.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the banner**

Create `src/components/bulk-reassign-undo-banner.tsx`:

```tsx
/* #1676(c) — layout-level, non-dismissing Undo banner for the last bulk line
   reassignment. Rendered once in the shell banner region (joining WhatsNewBanner
   / UpdateNotifierBanner) so it behaves identically regardless of which view
   opened the form and survives cast↔script navigation. Visible exactly while
   manuscript.lastBulkReassign is non-null; Undo restores prior attribution and
   appends one revert-audit event (the audit trail stays symmetric without
   rewriting the append-only boundary_move history). */

import { useAppDispatch, useAppSelector } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { changeLogActions } from '../store/change-log-slice';
import { buildBulkReassignRevertEvent } from '../lib/change-log';

export function BulkReassignUndoBanner() {
  const dispatch = useAppDispatch();
  const slot = useAppSelector((s) => s.manuscript.lastBulkReassign);
  if (!slot) return null;
  const n = slot.moves.length;
  return (
    <div className="mx-auto max-w-3xl px-4 py-2">
      <div className="flex items-center gap-3 rounded-2xl border border-ink/10 bg-peach/40 px-4 py-2.5 text-sm">
        <span className="flex-1 text-ink/80">
          Reassigned {n} line{n === 1 ? '' : 's'} to <strong>{slot.targetLabel}</strong>.
        </span>
        <button
          onClick={() => {
            dispatch(manuscriptActions.undoBulkReassign());
            dispatch(changeLogActions.appendLogEvent(buildBulkReassignRevertEvent({ count: n })));
          }}
          className="font-semibold underline shrink-0 min-h-[44px] fine-pointer:min-h-0"
        >
          Undo
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the change-log event builder**

Inspect `src/lib/change-log.ts` for the shape of `buildBoundaryMoveEvent`, then add a sibling. It must produce a valid `ChangeLogEvent` with a `note` containing "Reverted". Example (adapt field names to the existing builder — the test only asserts `note` matches `/revert/i`):

```ts
export function buildBulkReassignRevertEvent({ count }: { count: number }): ChangeLogEvent {
  return {
    ...buildBoundaryMoveEvent({ chapterId: -1, count }), // reuse timestamp/id scaffolding
    type: 'edit',
    chapterId: undefined, // book-level audit line, not tied to a chapter
    note: `Reverted reassignment of ${count} line${count === 1 ? '' : 's'}.`,
  };
}
```

> If `buildBoundaryMoveEvent` isn't easily reusable (e.g. it hard-codes `type: 'boundary_move'`), construct the event directly using the same `id`/`at`/`ts`/`date` fields the other builders in that file set. Keep `chapterId: undefined` so `wipeBookShapeEvents` doesn't drop the revert line and it can't trip a per-chapter stale predicate.

- [ ] **Step 5: Render the banner in the layout**

In `src/components/layout.tsx`, add the import near the other banner imports (~line 62):

```ts
import { BulkReassignUndoBanner } from './bulk-reassign-undo-banner';
```

Render it in the banner region, next to `<WhatsNewBanner />` (~line 1645):

```tsx
      <WhatsNewBanner />
      <BulkReassignUndoBanner />
```

- [ ] **Step 6: Run the banner tests**

Run: `npm run test -- src/components/bulk-reassign-undo-banner.test.tsx`
Expected: PASS (hidden when empty; count+target shown; Undo reverts + nulls slot + appends revert event).

- [ ] **Step 7: Commit**

```bash
git add src/components/bulk-reassign-undo-banner.tsx src/components/bulk-reassign-undo-banner.test.tsx src/lib/change-log.ts src/components/layout.tsx
git commit -m "feat(frontend): layout-level Undo banner for bulk reassignment"
```

---

## Task 5: Rewire the unlink caller to the renamed modal

**Files:**
- Modify: `src/components/layout.tsx` (state shape ~`428`, wiring ~`2129`, render ~`2278`)
- Test: `src/components/layout.test.tsx` or the existing alias-unlink test (grep for `reattribute`/`unlinkAlias`)

**Interfaces:**
- Consumes: `ReassignLinesModal`, `ReassignSource` (Task 3).
- Produces: the unlink flow now opens `ReassignLinesModal` with `source: { kind: 'unlink', impactedChapters, aliasCharacterId }`.

- [ ] **Step 1: Update the modal import**

Replace (~line 93):

```ts
import { ReattributeLinesModal } from '../modals/reattribute-lines';
```

with:

```ts
import { ReassignLinesModal, type ReassignSource } from '../modals/reassign-lines';
```

- [ ] **Step 2: Narrow the modal state to the source union**

Replace the `reattributeModal` state (~line 428) with:

```ts
  const [reassignSource, setReassignSource] = useState<ReassignSource | null>(null);
```

- [ ] **Step 3: Update the unlink handler**

In `onUnlinkAlias` (~line 2129), replace the `setReattributeModal({...})` call with:

```ts
                      setReassignSource({
                        kind: 'unlink',
                        impactedChapters: res.impactedChapters,
                        aliasCharacterId: res.newCharacter.id,
                      });
```

(The `sourceCharacterName` / `aliasName` fields are no longer needed — the generalized form derives display names from the cast roster.)

- [ ] **Step 4: Update the render**

Replace the `{reattributeModal && (...)}` block (~line 2278) with:

```tsx
      {reassignSource && (
        <ReassignLinesModal source={reassignSource} onClose={() => setReassignSource(null)} />
      )}
```

- [ ] **Step 5: Run typecheck + the layout/alias test**

Run: `npm run typecheck`
Expected: PASS (no dangling `ReattributeLinesModal` / `reattributeModal` references).

Run: `npm run test -- src/components/layout.test.tsx` (or the alias-unlink test file)
Expected: PASS — the unlink → reassign flow still opens the form and moves lines. Update any assertion that referenced the old symbol/props.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout.tsx src/components/layout.test.tsx
git commit -m "refactor(frontend): unlink flow opens generalized ReassignLinesModal"
```

---

## Task 6: Roster/cast entry point

**Files:**
- Modify: `src/modals/profile-drawer.tsx` (add a "Reassign lines…" action; add an `onReassignLines?: (characterId: string) => void` prop)
- Modify: `src/components/layout.tsx` (pass the handler that sets `source: { kind: 'character' }`)
- Test: `src/modals/profile-drawer.test.tsx` (append)

**Interfaces:**
- Consumes: `setReassignSource` (Task 5).
- Produces: profile-drawer surfaces a per-character "Reassign lines…" button; clicking it calls `onReassignLines(character.id)`.

- [ ] **Step 1: Write the failing test**

Append to `src/modals/profile-drawer.test.tsx` (mirror the file's existing render harness):

```tsx
it('invokes onReassignLines with the character id when the action is clicked', () => {
  const onReassignLines = vi.fn();
  renderDrawer({ onReassignLines }); // use the file's existing render helper; add the prop
  fireEvent.click(screen.getByRole('button', { name: /reassign lines/i }));
  expect(onReassignLines).toHaveBeenCalledWith(expect.any(String));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/modals/profile-drawer.test.tsx`
Expected: FAIL — no "Reassign lines" button / prop.

- [ ] **Step 3: Add the prop + button to the drawer**

Add `onReassignLines?: (characterId: string) => void;` to the drawer's Props. Render a button in the drawer's action area (near the existing "Also known as" / rename actions), guarded on the handler being present:

```tsx
{onReassignLines && (
  <button
    type="button"
    onClick={() => onReassignLines(character.id)}
    className="text-sm font-semibold text-magenta hover:underline min-h-[44px] fine-pointer:min-h-0"
  >
    Reassign lines…
  </button>
)}
```

- [ ] **Step 4: Wire the handler in the layout**

In `layout.tsx`, pass to `<ProfileDrawer …>` (near the other drawer handlers, ~line 2180):

```tsx
              onReassignLines={(characterId) =>
                setReassignSource({ kind: 'character', characterId })
              }
```

- [ ] **Step 5: Run the drawer test + typecheck**

Run: `npm run test -- src/modals/profile-drawer.test.tsx`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modals/profile-drawer.tsx src/modals/profile-drawer.test.tsx src/components/layout.tsx
git commit -m "feat(frontend): roster 'Reassign lines' entry point (character source)"
```

---

## Task 7: Script/review view entry point

**Files:**
- Modify: `src/views/manuscript.tsx` (checkbox multi-select mode + floating action bar)
- Test: `src/views/manuscript.test.tsx` (append)

**Interfaces:**
- Consumes: `ReassignLinesModal` opened via the layout's `setReassignSource`, OR opened locally — choose the local approach: the manuscript view renders the modal itself with `source: { kind: 'selection', keys }` since the selection state is local to the view.
- Produces: a multi-select mode (gutter checkboxes + shift-click range, kept distinct from the split text-range selection) and a floating "Reassign N selected…" bar.

- [ ] **Step 1: Write the failing test**

Append to `src/views/manuscript.test.tsx`:

```tsx
it('enters multi-select and opens the reassign form for the checked lines', async () => {
  renderManuscript(); // existing helper
  fireEvent.click(screen.getByRole('button', { name: /select lines|multi-select/i }));
  const checks = screen.getAllByRole('checkbox');
  fireEvent.click(checks[0]);
  fireEvent.click(checks[1]);
  fireEvent.click(screen.getByRole('button', { name: /reassign 2 selected/i }));
  expect(await screen.findByRole('dialog', { name: /reassign lines/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/views/manuscript.test.tsx`
Expected: FAIL — no multi-select toggle / action bar.

- [ ] **Step 3: Add multi-select state + gutter checkboxes**

Add local state to the manuscript view:

```tsx
const [multiSelect, setMultiSelect] = useState(false);
const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
const [reassignOpen, setReassignOpen] = useState(false);
const lastCheckedRef = useRef<string | null>(null);
```

Add a "Select lines" toggle near the existing reassign-help affordance (~line 1544). When `multiSelect` is on, render a gutter checkbox per sentence row. Shift-click extends the range from `lastCheckedRef` over the ordered sentence list. Use the `` `${chapterId}:${id}` `` key format.

- [ ] **Step 4: Add the floating action bar + modal**

```tsx
{multiSelect && checkedKeys.size > 0 && (
  <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full bg-ink text-white px-5 py-3 shadow-drawer">
    <span className="text-sm font-semibold">{checkedKeys.size} selected</span>
    <button
      onClick={() => setReassignOpen(true)}
      className="text-sm font-semibold underline min-h-[44px] fine-pointer:min-h-0"
    >
      Reassign {checkedKeys.size} selected…
    </button>
    <button onClick={() => { setCheckedKeys(new Set()); setMultiSelect(false); }} className="text-sm opacity-70 min-h-[44px] fine-pointer:min-h-0">Cancel</button>
  </div>
)}
{reassignOpen && (
  <ReassignLinesModal
    source={{
      kind: 'selection',
      keys: [...checkedKeys].map((k) => { const [c, s] = k.split(':'); return { chapterId: Number(c), sentenceId: Number(s) }; }),
    }}
    onClose={() => { setReassignOpen(false); setCheckedKeys(new Set()); setMultiSelect(false); }}
  />
)}
```

Add the import at the top of `manuscript.tsx`:

```ts
import { ReassignLinesModal } from '../modals/reassign-lines';
```

- [ ] **Step 5: Run the manuscript test + typecheck**

Run: `npm run test -- src/views/manuscript.test.tsx`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): script-view multi-select → reassign form (selection source)"
```

---

## Task 8: E2E golden path + docs + release notes

**Files:**
- Create: `e2e/cast-bulk-reassign.spec.ts`
- Create: `docs/features/1676-cast-bulk-line-reassignment.md`
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: Write the e2e spec**

Create `e2e/cast-bulk-reassign.spec.ts` (follow the harness in an existing spec, e.g. `e2e/*.spec.ts` — mock mode on port 5174). Golden path:

```ts
import { test, expect } from '@playwright/test';

test('bulk-reassign lines from the roster, then undo', async ({ page }) => {
  await page.goto('/');
  // navigate to a book's cast view (reuse the nav helpers other specs use)
  // open a character's profile drawer → "Reassign lines…"
  await page.getByRole('button', { name: /reassign lines/i }).first().click();
  const dialog = page.getByRole('dialog', { name: /reassign lines/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /select all/i }).click();
  await dialog.getByLabel(/reassign to/i).selectOption({ index: 1 });
  await dialog.getByRole('button', { name: /^reassign/i }).click();
  await page.getByRole('button', { name: /confirm/i }).click();
  // layout-level undo banner appears
  const banner = page.getByText(/reassigned .* line/i);
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: /undo/i }).click();
  await expect(banner).not.toBeVisible();
});
```

Run: `npm run test:e2e -- cast-bulk-reassign`
Expected: PASS (adjust selectors/nav to the mock fixtures until green).

- [ ] **Step 2: Write the regression plan doc**

Create `docs/features/1676-cast-bulk-line-reassignment.md` from `docs/features/TEMPLATE.md`, `status: active`. Document the invariants: composite-key selection, render-independent `Set` selection, one-level book-session-scoped undo with key-granular clear, cross-book slot nulling, scoped persist-failure toast, stale-after-undo acceptance. Link the design spec `docs/superpowers/specs/2026-07-17-cast-bulk-line-reassignment-design.md`. Add the manual acceptance walkthrough (roster + script entry points, Narrator confirm, drift-skip report, undo across navigation).

- [ ] **Step 3: Update the index + release notes**

- Add an entry for the new plan under its area in `docs/features/INDEX.md`.
- Append a technical entry to `docs/release-notes-next.md` (PR-refed).
- Append a brand-voice user-facing line to the in-progress version section at the top of `RELEASE_NOTES.md` (e.g. "Move a whole character's lines to someone else in one go — with a single-click undo.").

- [ ] **Step 4: Commit**

```bash
git add e2e/cast-bulk-reassign.spec.ts docs/features/1676-cast-bulk-line-reassignment.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "test(frontend): e2e for bulk reassign + regression plan + release notes"
```

- [ ] **Step 5: Full fast branch verify**

Run: `npm run verify:fast:branch`
Expected: PASS. Then open the PR (`Closes #1676` — note part (b) is a separate follow-up, so use `Refs #1676` if the issue must remain open for part b; confirm with the issue's scope before choosing) and let cloud `verify.yml` + the mandatory `code-review` gate run.

---

## Self-Review

**Spec coverage:**
- §1 Reusable form → Task 3 (source union, candidate resolution, Set selection, virtualization, filters incl. speaker facet + select-all-matching, target picker with source-disabled/pending-removal-excluded/Narrator-confirm, Apply→confirm, empty state, rename). ✓
- §2 Data plumbing → Task 1 (`setSentencesCharacterBulk`, inverse recording) + Task 2 (persist rules with full `{sentences, mergedAwayKeys}` patch, scoped failure toast); per-chapter `bumpBoundaryMove` on apply → Task 3; undo revert audit event → Task 4. ✓
- §3 Undo lifecycle → Task 1 (slot, `undoBulkReassign`, key-granular clear-on-conflict, cross-book nulling in reset/hydrate*) + Task 4 (layout-level banner, appendLogEvent, stale-after-undo accepted by doing nothing). ✓
- §4 Entry points → Task 6 (roster/character) + Task 7 (script/selection) + Task 5 (unlink). ✓
- §5 Edge cases → drift re-validation at apply (Task 3 `apply()` + test), source-zero empty state (Task 3), empty-selection Apply disabled (Task 3 `canApply`), target eligibility (Task 3), large moves single-batch (Task 1 reducer + virtualization Task 3). ✓
- §6 Testing → reducer (Task 1), persistence (Task 2), selection/virtualization + component (Task 3), undo lifecycle (Tasks 1+4), cross-book (Task 1), stale-after-undo (Task 3 bumps + accepted), regression unlink (Task 5), e2e (Task 8). ✓

**Placeholder scan:** No "TBD"/"add error handling" placeholders; the two "implementer note" callouts (test-file harness reuse, change-log builder field-name adaptation) point at concrete existing code to read, not deferred design. ✓

**Type consistency:** `SentenceKey`, `ReassignSource`, `setSentencesCharacterBulk({keys, characterId, targetLabel})`, `undoBulkReassign()`, `lastBulkReassign` shape, `` `${chapterId}:${sentenceId}` `` key format, and `bumpBoundaryMove({chapterId, count})` are used identically across Tasks 1–8. The banner reads `slot.moves.length` / `slot.targetLabel` exactly as Task 1 defines them. ✓
