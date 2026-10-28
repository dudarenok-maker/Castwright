---
status: active
shipped: null
owner: null
---

# 289 — Book-state revision precondition: a stale save is refused, not replayed (srv-97, #3784)

> Status: active (ships with PR #3775; owner decisions OD1–OD6 answered 2026-10-25, see Ship notes). **The client half is being reworked to a single-flight field outbox (owner decision 2026-10-26, after review pass 7): see [Client rework (pass 7)](#client-rework-pass-7-single-flight-outbox). Where it supersedes a D-section, that section says so inline.**
> Key files: `server/src/routes/book-state.ts` (`PUT` / `GET /:bookId/state`, `applyReparse`), new `server/src/workspace/slice-revision.ts`, `server/src/routes/import.ts`, `server/src/import/scan-import-folder.ts`, `server/src/routes/analysis.ts` (Start fresh), `openapi.yaml`, `src/lib/types.ts`, `src/lib/api.ts`, `src/store/persistence-middleware.ts`, `src/components/layout.tsx`, `src/routes/index.tsx`, `src/hooks/use-language-guard.tsx`
> URL surface: indirect (the book-open hydrate and every autosave)
> OpenAPI ops: `GET /api/books/{bookId}/state`, `PUT /api/books/{bookId}/state`

Blocks PR #3775 (#3421 / #3755). Lands on that PR's branch, `fix/frontend-3421-flush-retry`.

## Benefit / Rationale

- **User:** a save that failed and is re-sent later can no longer undo a newer change made elsewhere. That covers the Library Edit dialog, a series-wide voice override, another tab, a re-parse, and a re-import. When the server refuses a stale save, the user is told, and the book is re-read so the screen shows what is actually on disk. (N5 is a regression against `main`: a renamed book is silently renamed back, folder included.)
- **Technical:** the server, which sees every writer, decides whether a re-sent save is still valid. Five review passes on #3775 showed the client cannot decide this. Most of #3775's park/restore bookkeeping goes.
- **Architectural:** one compare-and-swap at one seam (`PUT /state`), evaluated inside the existing lock spans. No new lock. The tokens are derived from content, plus a per-book *edit epoch* that only the wiping writers rotate.

## The problem

A kept save is a whole-slice snapshot, re-sent at an arbitrary later time. (This describes the pass-5 client; superseded by C1 and C7: a kept entry is now a per-field outbox entry, not a whole-slice snapshot.) Whether it is still owed depends on two things the client cannot see:

- writes the middleware never routes: `onEditBook` and the language-guard modal call `api.putBookState` directly, `POST …/voice-override-linked` writes other books' `cast.json` on the server, and other tabs write too;
- server outcomes the client cannot learn: a `DELETE` that removed the folder and then answered 500, or a response that was lost.

The full argument is in pass 5 (PR #3775, comment 6389974661).

## Decisions

Decisions with more than one defensible outcome that the owner has a stake in are marked **OD** and carry a recommendation. All were answered on 2026-10-25 (see Ship notes).

### D1 — Granularity — OD1

- **(a) Recommended: per top-level field within each file.** A `SliceRevision` is a map from field to token:
  - `state`: one token per editorial field `PUT /state` can write. `chapters` and `updatedAt` are excluded.
  - `cast`: one token, `characters`.
  - `manuscript`: two tokens, `sentences` and `mergedAwayKeys`.
  - `changeLog`: one token, `events`.

  A conditional write is **stale** if any field it carries meets three conditions: its base token is present, the base differs from the current token, and the server's *post-merge* value for the field (D5 no-op rule) differs from its current value. A stale write is refused whole.
- **(b) One token per file.** Then a direct client write such as a prosody flag (`layout.tsx` ~`:1422`/`:1459`), the language guard, or Start fresh's `castConfirmed` reset refuses a kept rename that shares no field with it.
- **(c) Per character for `cast`.** This option is offered, not recommended. A single `characters` token means a background `cast.json` writer refuses any concurrent retry of a roster edit. That writer can be an analysis interim snapshot, a voice-library assign, or a design job, none of which has a mirror persist. Per-character tokens would narrow that to edits of the same character, at the cost of a per-character compare in the cast pipeline. How often this collision happens is unmeasured.
- **Why (a):** the issue's "disjoint fields don't refuse each other" holds for `state` at no client cost, because the client echoes the map back opaquely. Inside the middleware, `confirmCast` and `commitDraft` share one key but **replace** each other's pending patch last-wins at plan time; 6c002345 later made them merge (see Ship notes). So overlapping sequences with disjoint fields happen in-process too, and per-field tokens matter there as well.

### D2 — What a 409 `stale_revision` means to the client — OD2

> **Amended by C6 and C9.** The rule below still holds per field: a stale refusal now drops only the refused fields that still hold the value sent (all of the send's fields on a whole-slice slice), and toasts and marks only when it dropped one. The rest of the send is re-sent at once.

- **(a) Recommended: one rule for every stale refusal, on a retry or on a replay:**
  - The save is not kept and not re-sent.
  - The existing give-up toast fires, naming the book by its last-saved title (`savedTitleOf`), or the handler's own toast for `commitDraft` / bulk reassign. Its body says the book was changed elsewhere, so the edit was not saved. It is deduped per book.
  - The **#2230 rollback does not run.** Its baseline (`lastCommitted`) is older than disk, so restoring it would show the user neither value.
  - The book is **marked for a full re-read** (D7). If the book is open, Layout re-reads it now. Otherwise the next open is a full read, not revisions-only.
- **Why not silent on a replay:** pass 5 and the checker showed that a given-up cast, manuscript, changeLog or `confirmCast` save keeps its edit on screen (no rollback, `persistence-middleware.ts` ~`:528-539`). Replays fire from any flush of the book, often while the user is on it. A silent drop therefore leaves redux showing an edit the server refused. That is the #1676(c) / #3421 divergence this work exists to close.
- **(b) Rejected: a "keep yours / keep theirs" choice.** It is new UI, and CLAUDE.md says the v1 surface is final.
- Every other 4xx is unchanged: final, not re-sent, and silent unless a handler toasts.

### D3 — What moves the revision

The token for field `f` is computed as:

```
first16hex(sha256(manuscriptId ∥ editEpoch ∥ f ∥ canonicalJson(value)))
```

- `canonicalJson` serialises with sorted keys.
- An absent file contributes the literal `<absent-file>` as its value.
- An absent field contributes `<absent-field>`.

Content moves a token automatically. **No content writer changes**: a writer moves exactly the fields whose values it changes, and render stamps, uuid mints, title refresh and chapter `excluded`/`held` move nothing. One thing content alone cannot see: a **wipe that resets a field to a value equal to many bases**. A re-parse writes `castConfirmed: false` (`book-state.ts` ~`:1551`), so a kept `castConfirmed: true` whose base was `false` would land on a book whose cast was just deleted. The book would then read as confirmed, with no cast and no Resume (`analysis-cache.ts` ~`:198`, `book-state.ts` ~`:499`). Start fresh has the same shape (`analysis.ts` ~`:4815-4819`).

Hence `state.json.editEpoch`. It is a random id with these properties:

- **minted** by every import path: `POST /api/import` (`import.ts` ~`:376`), and the portable-bundle import. The bundle import (`scan-import-folder.ts` ~`:335-348`) currently keeps the bundle's own `state.json`, `manuscriptId` included, so it must **overwrite** the epoch rather than keep the bundle's.
- **rotated** inside each writer's existing `state.json` write by re-parse, replace-manuscript, Start fresh and backup restore (`auto-backup.ts` `restoreBackup`, which writes the snapshot's whole `state.json` and so would otherwise bring the snapshot's old epoch back).
- **not touched by any other writer.** Every token is salted with it, so a wipe invalidates every kept or retrying save of the book.

| Writer | Effect |
|---|---|
| Library Edit / language guard (the same `PUT`) | Moves the fields it changes, so N5's kept `commitDraft` is refused. |
| `voice-override-linked` | Moves the member books' `characters`, so a kept roster is refused. |
| Chapter restructure | Moves `sentences`; `state` tokens are unchanged (`chapters` is excluded). |
| Re-parse, replace, Start fresh | Rotate `editEpoch`, so **every** token moves. |
| Delete then re-import, by either import path | New epoch, so every token moves. That covers N8, including a base on an absent file and a bundle carrying the old `manuscriptId`. |
| Snapshot restore (`POST /backups/restore`) | Mints a fresh epoch (69f188c7), so every token moves. Without it the snapshot's old epoch returned and a kept save could replay onto a restored book (ABA, D4). |
| Analysis persist, cover writers, prosody flags | Move exactly the fields they change. |

`editEpoch` is server-owned. It is not on the PUT whitelist, and `buildNext` carries it through `...state`. A legacy book has no `editEpoch`, so it salts with the empty string, and the first wipe or import mints one. **No migration.**

**Lock order: no new lock.** The check runs on the fresh read the write is already derived from, inside the slice's existing innermost span:

| Slice | Where the check runs |
|---|---|
| `state`, folder not moving | inside `withBookLock` → `withStateJsonLock`, on `fresh` |
| `state`, folder moving | inside `buildNext`, which `moveBookFolder` calls on its locked re-read before `BookPathTakenError` and `renameWithRetry` (`book-op-lock.ts` ~`:534-542`). A stale write throws `StaleRevisionError`, so nothing moves. **`assertNotBusy` (~`:517`) runs first, so `book_busy` wins over `stale_revision` on this branch.** That is still a final 4xx, as today. The resolve-time `projected = buildNext(book.state)` (`book-state.ts` ~`:1249`) must not run the check; give `buildNext` a flag. |
| `cast` | inside `withCastLock`, on `existing` |
| `manuscript` | inside `withBookLock`, on `existing` |
| `changeLog` | under `book-op` (the existing span) |

The orders `book-op → book → state-json` and `book-op → cast` are unchanged.

**The salt for the cast, manuscript and changeLog checks is read fresh inside each check's span,** with a plain `readStateJsonWithRecovery`. That is a read, not a lock, so the lock order is unchanged.

The `book.state` resolved under `book-op` is not enough. Import, re-parse and replace hold `book-op`, but **Start fresh is a long analysis job that does not**. Start fresh rotates the epoch inside the `updateStateAtDir` write it already makes.

The **analysis `changeLog.json` append is unlocked** (`analysis.ts` ~`:528`) and races the slice PUT. That race predated this plan; it is fixed in this PR (79fecfca, Ship notes).

### D4 — Where the revision lives — OD4

- **(a) Recommended: derived content tokens plus one stored `editEpoch`.** Content writers change nothing. Only the wiping writers rotate the epoch, and each of them already writes `state.json` under its lock.
  - **Residual (ABA):** if a field goes A → B → A *without* a wipe, a stale write built against A lands. Examples are a snapshot restore to exactly the base, or a user retyping the old value. The worst case is today's `main` behaviour, and it needs an exact return to the old value.
- **(b) A full counter per file, bumped by every writer of a carried field.** It has no ABA case, but plan 279 counts 35+ `cast.json` write sites alone. A missed bump is a silent clobber, and a bump from a writer that touches only server-owned fields is a false refusal. It also needs a guard test and a migration.
- **(c) mtime.** Rejected. Render stamps and uuid mints change it, so kept saves would be refused constantly.

### D5 — Contract

- **`GET /state` adds `sliceRevisions: { state, cast, manuscript, changeLog }`.** Each value is a `SliceRevision` (`Record<string, string>`). It is computed from the **raw** reads, before decoration:
  - the cast at its read, before `lines` and `clonedElsewhereInSeries` are applied in place (~`:596-633`);
  - the edits before they are reassigned (~`:529-532`);
  - `state`, not `stateView` (~`:788-794`).

  `BookStateResponse` is hand-modelled (`src/lib/types.ts` ~`:441`, `openapi.yaml` ~`:9367`), so add `sliceRevisions` there as well as in the schema.
- **`PUT` body adds an optional `baseRevision: SliceRevision`.** If it is absent, the write is unconditional: today's behaviour, which also serves an old tab and a write with no known base.
- **No-op rule.** The value compared for each field is the server's **post-merge, post-transform** value:
  - `state`: the `buildNext(fresh)` output;
  - `cast`: the output of `preserveDesignedVoices → denormaliseCastReusedVoices → stripDerivedCharacterFields`, i.e. exactly what would be written;
  - `manuscript`: the parsed patch;
  - `changeLog`: the patch.

  That value is compared with the current on-disk value. If they are equal, the field is never stale. So a retry after a lost response returns 200, never a false refusal.
- **`PUT` success changes `204` → `200 { revision: SliceRevision }`.** The value is the slice's map after the write, or the current map after a no-op. Every existing server test that asserts `204` is updated.
- **409 `code: 'stale_revision'`** is added to the PUT's 409 enum. Its `error` is a fixed, path-free sentence. **Amended by C9:** the body also carries `fields`, the stale field names. The check runs after the 400s and the 404, and before the consent, empty-manuscript and path-taken 409s, with `book_busy` excepted (D3). Nothing is written.
- **Mock parity.** `mockGetBookState` returns `sliceRevisions`, and `mockPutBookState` applies the same rule and returns the same shape. Mock tokens are `JSON.stringify` of the values plus the salt; they are opaque, so the mock need not hash. `editEpoch` is rotated by the mock's own reparse/replace/import. On refusal the mock throws `Book state PUT failed (409): …` with `code`.
- **`realPutBookState`** sends `baseRevision` only when it is given. It returns `{ revision }`, and the thrown error carries `code` (`Object.assign`, matching `realDeleteBook`).

### D6 — Which sends carry a base, and which base — OD3

> **Superseded by C2, C3 and C4.** OD3's principle stands (a live edit is unconditional; a re-send of a write that already failed carries a base). What changes: the base is per field and is stamped by the transport failure; the older-200 refresh is gone (single flight makes it unnecessary); `known` learns from a 200 only the fields that request carried (R1); and a live build merged with a kept field carries the kept field's base only, not a base for every field (OD-C2).

- **(a) Recommended: every send that re-sends a write which already failed once,** and nothing else:
  - every retry (attempts 1–3);
  - every replay of a kept save;
  - a **live build that a kept patch was merged into** (`persistence-middleware.ts` ~`:735-737`). That send carries the *kept* base, because otherwise the merge would smuggle the kept fields past the check. (Superseded by C1 and C3: a build merges per unit, and an unchanged entry keeps its own base, so no live field is ever sent against a kept base. OD-C2.)

  A plain attempt 0 carries no base. That is `main`'s last-writer-wins for a live edit built from the current screen.
- **What the base is.** It is `known[book:slice]` as it stands when the sequence's first attempt is made. A kept record stores its base. (Superseded by C3: a base is stamped per field by a transport failure, and a kept entry stores it on the entry.) Two rules keep the base from being older than the client's own writes:
  - When a `PUT` of the same key lands with generation `g`, its returned revision replaces the base of every **in-flight sequence with a generation above `g`.** Their patches were built after `g`'s and already include it. That also covers overlapping same-key sequences (the #2230 case). (Superseded by C2 and C4: there are no generations or sequences, and no refresh. Single flight leaves no older same-key request in transit, and a 200 teaches only the fields it carried, which is R1's fix.)
  - `known` is updated from every middleware `PUT` 200, and from **full** Layout reads only. Each full read stamps its read sequence, and a learn that was issued before the latest `PUT` 200 for the key is ignored. (Amended by C4: a 200 teaches only the fields it carried, and the ignore rule is per field.)
  - A **revisions-only read never updates `known`**, because it re-seeds none of these four slices (`layout.tsx` ~`:983`, `:997`).
  - With `known` absent, the send is unconditional.
- **(b) Every send carries a base.** This also protects an out-of-order live attempt 0. The cost is that every `cast.json`- or `manuscript-edits.json`-writing endpoint whose result the client mirrors would have to return the new token: `applyAddAlias`, `applyRepointAlias`, `applyManualMatch`, the restructure, voice design, ConfirmRoute's cast re-hydrate (`routes/index.tsx` ~`:729-753`). Without that, mirrors are falsely refused. That is a large contract widening, for a reordering hazard that already exists on `main`.
- **Known false refusal under (a).** An attempt 0 fails with a network/5xx error after the client absorbed an endpoint write it has no token for. Its retry then carries an older base. The direction is safe: the toast fires and a re-read follows. Nothing is clobbered.

### D7 — Re-seeding after a refusal, and after an outside edit (new; from the checker)

The checker's Critical finding: N5's reopen is **revisions-only**. `revisionsOnly = manuscriptReady` (`layout.tsx` ~`:871-879`), and nothing resets the manuscript slice on leaving. A revisions-only read returns before `bookMetaActions.hydrateFromBookState` (~`:997`). `onEditBook` refreshes only the library (`routes/index.tsx` ~`:182-191`), and the Listen header reads `bookMeta.saved` (~`:1011`).

So even with the server refusing the replay, the header would show T1 while disk holds T2. Worse, the next book-meta commit rebuilds all eight fields from that stale `saved` and sends them unconditionally, reverting T2 and the folder. The same is true on `main` today, with no kept save involved: Library Edit, reopen, edit notes, and the title reverts.

The fix uses one mechanism:

- **A full-re-read mark** `needsFullRead[bookId]`, kept in a slice Layout already selects. The implementer picks the slice, and it must be store-visible.
- **Layout** treats a marked book as a full read (`revisionsOnly = false`). If the book is open when it is marked, Layout re-reads it at once. A full read clears the mark.
- **Who marks a book:**
  - the middleware, on every `stale_revision` refusal (D2);
  - **`onEditBook` and the language-guard modal, after a successful direct `PUT`.** They are writers the middleware never sees, and the book's slices may be in memory.
- **F1 stays:** `dropRetainedSaves(bookId)` on a **full** read still drops kept saves, because the user has now seen disk. Revisions-only reads do not drop. (**Amended by C7:** a kept save is now the idle outbox entries of a key; since pass 8 a full read keeps based (P2) `state` entries. Pass 9 removed the held-key (P1) exception.)

### D8 — What the client stops doing

**Goes:**

- `retainedGen`, an equivalent mutant (pass 5);
- `sending`;
- `parked`, with its per-field `newerFields` / `landedFields`, and the `parkedHere` lines in `flush` and in the rule handler;
- `pendingWipes` / `endWipe`;
- `SUPERSEDE_BOOK` / `supersedeBookSaves`, and `RESTORE_SUPERSEDED` / `restoreSupersededSaves`;
- the `wipeSettled` option;
- in `src/routes/index.tsx`, every supersede/restore/drop dispatch, the `book_partly_deleted` branch, and the import. The handlers return to `main`'s shape, plus D8b.
- in `realDeleteBook`, the `code` surfacing, if nothing else reads it (grep first).

`retained` + `retainedOnSuccess` + `retainedGen` collapse into one map: `kept: Map<FlushKey, { patch, base, onSuccess? }>`. **Superseded by C1:** `kept` itself goes; a kept save is the idle entries of the per-field outbox.

**Why the supersede can go.** It existed so that a retry could not put the pre-wipe roster into a wiped book. Every retry now carries a base, and every wipe rotates `editEpoch`. So that retry is refused by the server, whichever side of the wipe it lands on, because `book-op` serialises the two.

**Stays:**

- retries at +1/+2/+4 s, with a 4xx final;
- the give-up toast, named by `savedTitleOf`, for retried network/5xx failures, plus D2;
- `flushBookPersistence` / `BookFlushOutcome`, and Layout's flush-before-re-read;
- #3755's restructure abort;
- `resendRetained`, now reading `kept`; (**superseded by C2:** a send of any key of a book first sends that book's kept keys)
- the #2230 `generation` gate and `toastPending`; (**superseded by C6:** the gate becomes "a handler's success or rollback runs only when every outbox entry it owns still holds the value sent", and the handler rides on each entry)
- `dropRetainedSaves` on full reads (D7).

#### D8a — `onSuccess` rides in the kept record — OD5

> **Superseded by C6.** OD5's behaviour stays (a re-send that lands prunes `lastCommitted`); the handler now rides on each outbox entry instead of a kept record.

The owner listed `retainedOnSuccess` as deletable. The *map* goes, but its behaviour is not made redundant by the precondition. A kept `commitDraft` that lands on replay must prune `bookMeta.lastCommitted`, or the next commit pins a stale rollback baseline (3b6ebafc, pinned by its test).

- **(a) Recommended:** keep `onSuccess` as a field of `kept`.
- **(b)** Drop it and accept the stale baseline. It is visible after a revisions-only reopen.

N7's mechanism (restore inheriting the newest generation plus the parked `onSuccess`) goes with restore either way.

#### D8b — Wipes on the client — OD6

- **(a) Recommended: no client drop on re-parse or replace success.** The rotated epoch refuses every kept save, and D2 raises the toast and the re-read. The handlers already reset the cast and manuscript and go home. On **delete success**, keep one `dropRetainedSaves(bookId)` for hygiene, so kept entries for a gone book do not linger. It is not needed for correctness.
- **(b)** Keep a drop on every wipe's success. It is harmless, but redundant with the epoch.

Note the change from the first draft: with the epoch, a kept *rename* does **not** survive a re-parse. Every save made before a wipe is refused. That is the owner's F1 semantics ("dropped when wiped"), now enforced by the server.

### Acceptance adjustment (stated, not silently changed)

The issue asks that each pass-5 shape has a test that is red without the precondition.

- **N5, the voice override and N8** meet that: the precondition and the epoch are the fix.
- **N6 and N7** are defects in client bookkeeping (`landedFields`; restore inheriting the generation and `onSuccess`). Deleting that bookkeeping fixes them. Their tests replay pass 5's sequences and assert the end state is right.
  - They are **red against PR head 5ec7178c**, not against "precondition off". With no park/restore and with both wipes failing, nothing in those sequences is stale.
  - Pass 5 reports both shapes reproduce from 8a480096 to head; the task-5 implementer confirms red at 5ec7178c before deleting.
  - The owner should confirm this reading.

## Architectural impact

- **New seam:** `server/src/workspace/slice-revision.ts`. It is pure and exports two functions:
  - `sliceRevision(slice, content | null, salt) → SliceRevision`;
  - `staleFields(base, current, next) → string[]`.

  It is the only place tokens are made. Server-owned field: `state.json.editEpoch`.
- **Invariants preserved:**
  - the CLAUDE.md lock order (no new lock);
  - no client-facing body carries a path;
  - the mocks stay behind `VITE_USE_MOCKS`;
  - OpenAPI stays the type source, except `BookStateResponse`, which is already hand-modelled.
- **Migration:** none. Tokens are derived, and an absent epoch salts as `''`.
- **Reversibility:** the server ignoring `baseRevision` restores unconditional writes, and a 200 body is additive. The client side reverts from #3775's history.

## Invariants to preserve

1. A `PUT /state` with `baseRevision` writes nothing and answers 409 `stale_revision` if any carried field is stale (D1/D5). Without a base, today's behaviour applies.
2. Staleness compares the server's post-merge, post-transform value. A no-op field is never stale.
3. The check reads the same fresh content the write derives from, inside the slice's innermost span. The moving branch refuses before `renameWithRetry`.
4. Tokens are made only by `slice-revision.ts`, salted with `manuscriptId` and `editEpoch`. Only import (both paths), re-parse, replace, Start fresh and backup restore write `editEpoch`; each mints or rotates it (`mintEditEpoch`), and none carries a stored one back.
5. A plain attempt 0 carries no base. A retry, a replay, and a live build with a merged kept patch carry the base of the write they re-send (D6). **Superseded by C-I2 and C-I3** (per-field bases).
6. A stale refusal is never kept, never re-sent and never rolled back. It toasts and marks the book for a full read (D2/D7). **Amended by C-I5** (per field; toast and mark only when a field was dropped).
7. Revisions-only reads neither update `known` nor drop kept saves.
8. `persistence-middleware.ts` holds no `parked`, `sending`, `pendingWipes`, `retainedGen` or `retainedOnSuccess`, and exports no `supersedeBookSaves` / `restoreSupersededSaves`. **Extended by C-I9.**

## Test plan

### Automated coverage

**Server** (Vitest, real temp workspace, real router). Tests 1–4, 7 and 8 must be red with the check disabled. Tests 5, 6, 9 and 10 are positive or contract tests and are not expected to be red that way.

- `slice-revision.test.ts`:
  - key order is stable;
  - a change of salt or epoch moves every token;
  - an absent file and an absent field get distinct tokens;
  - `staleFields` applies its three conditions and the no-op rule.
- `book-state.revision-precondition.test.ts`:
  1. **N5.** GET to take a base. An unconditional Library-Edit PUT (title T2). Then a conditional PUT (title T1) at the old base. Expect 409 with `code: 'stale_revision'`, and both the title and the folder at T2.
  2. **Voice override.** GET book B to take a base. `POST /api/books/A/cast/:id/voice-override-linked` with a **designed** (not cloned) slot, so the consent guard cannot produce the 409. Then a conditional cast PUT to B with the old roster that carries an explicit `overrideTtsVoices`. Assert `code: 'stale_revision'` (not just 409), and that B is unchanged.
  3. **N8.** Delete, then re-import through `POST /api/import`, and separately through the portable bundle import with the same `bookId`, `manuscriptId` and content. Each conditional `state` / `cast` / `manuscript` PUT at the pre-delete base gets 409, including a base taken on an absent `manuscript-edits.json`.
  4. **Wipe reset.** A base with `castConfirmed: false`, then a re-parse, then a conditional `{castConfirmed: true}`: expect 409. Repeat the shape with Start fresh.
  5. **Disjoint fields.** A conditional `{castConfirmed}` lands after another writer changed `title`.
  6. **Lost response.** A conditional retry of an already-landed `cast` patch that carries the GET decorations (`lines`, `clonedElsewhereInSeries`) gets 200. The same for a `state` patch with untrimmed tags.
  7. **Folder move.** A stale conditional rename gets 409, and the old folder is intact.
  8. **Restructure** moves `sentences` but no `state` token.
  9. **GET** `sliceRevisions` equal `slice-revision.ts` computed over the raw files.
  10. **PUT 200** `revision` equals the next GET's value for that slice.
- Update every existing test that asserts the PUT's `204`.

**Contract / api.**

- `src/lib/api-put-book-state-error.test.ts` (its existing precedent):
  - the base is sent only when given;
  - `revision` is returned;
  - a 409 error carries `code`.
- `src/lib/api.mock-state.test.ts`:
  - the mock GET returns `sliceRevisions`;
  - the mock refuses a stale base and accepts a no-op;
  - the mock re-parse rotates the epoch.

**Client** (`persistence-middleware.test.ts`, `routes/index.test.tsx`, `layout.test.tsx`). A shared disk-model helper applies the precondition and the epoch.

- **N5, end to end** through `BooksRoute.onEditBook` and a **revisions-only** Layout reopen:
  1. Rename to T1 and leave; four 503s, so the save is kept.
  2. Library Edit to T2.
  3. Reopen.
  4. Expect the PUT log `503 T1 ×4, ok T2, 409 T1`, one named toast, a forced full read, the header at T2 and disk at T2.
  5. Then edit the notes. Expect the PUT to carry T2, not T1.

  This test is red with the check off. It is also red without D7: the `onEditBook` mark, and the stale mark.
- **Library Edit without any kept save (D7).** Edit, reopen, then a notes edit. The title stays T2. This test is red on `main`.
- **Voice override:** a kept roster for B is refused after the model applies a linked override. Red with the check off.
- **N8:** a delete answers 500 after the folder is gone, then a re-import under the same id, then a reopen. The kept save is refused and the re-imported book is untouched. Red with the check off.
- **Wipe:** a retrying `confirmCast` spans a successful re-parse. It is refused, and the book stays unconfirmed. Red with the epoch off.
- **N6 (a) and (b), and N7:** pass 5's sequences end with disk and memory at the latest intended value (R; Q), and with `lastCommitted.b1` still holding T2's baseline. Red against 5ec7178c.
- **D6** (**superseded by the C test plan**; the "older same-key 200 refreshes" and "live build with a kept patch carries the kept base" bullets are replaced there):
  - attempt 0 carries no base;
  - attempts 1–3 and replays carry the captured or kept base;
  - a live build with a kept patch merged in carries the kept base; (Superseded by C1 and C3: an unchanged entry keeps its base and a changed one is unbased.)
  - an older same-key 200 refreshes the newer in-flight sequence's base; (Superseded by C2 and C4: the refresh is deleted.)
  - a revisions-only read does not update `known`;
  - an out-of-order learn is ignored. (Amended by C4: per field, `landedAt[key][f]`.)
- **D2:** a stale refusal on a retry and on a replay each toasts once, does not roll back, is not kept, and marks the book. If the book is open, Layout re-reads it. (Amended by C6 and C9: per field, and toast and mark only when a field was dropped.)
- **D8:** delete every test of supersede / restore / `pendingWipes` / `newerFields` / `landedFields` / `retainedGen`, and replace each with the shape test above that covers its user-level invariant. The PR body maps each deleted test to its replacement. The existing tests for retry delays, the 4xx being final, toast naming, flush-before-read and the #3755 abort stay green and unchanged.

**E2E:** none. The shapes need a scripted 503 on a chosen PUT, and the mock-mode Playwright harness has no network to intercept. The router/redux/layout crossing is covered by the jsdom BooksRoute + Layout reopen test.

**On-box acceptance:** none owed. Real temp-workspace server tests prove everything without a GPU, sidecar or analyzer.

### Manual acceptance walkthrough (`npm run dev`)

1. Open a book and, in Listen, rename it to T1. Stop the server and go back to the Library. After about 7 s, a toast names the book.
2. Start the server. In Library → Edit, set the title to T2.
3. Reopen the book. A toast says the earlier edit was not saved, and the header shows T2.
4. Edit the notes and save. The title on disk is still T2. On `main` and on PR head 5ec7178c, step 3 shows T1, and on `main` step 4 reverts T2.

## Task breakdown (one implementer subagent per task, in order)

1. **Server: `slice-revision.ts`, `editEpoch`, and the GET `sliceRevisions`.**
   - The pure module and its tests.
   - Mint `editEpoch` in both import paths (the bundle import overwrites it), and rotate it in re-parse, replace and Start fresh, inside their existing `state.json` writes.
   - The GET computes tokens from the raw reads (D5).
   - Server tests 9 and 4 (the epoch half).
   - First grep for an existing stable-stringify helper.
2. **Server: the PUT precondition.**
   - Parse `baseRevision`, and run the check per the D3 table, using the post-transform comparison values (D5).
   - `buildNext` gets a check flag for the locked caller only.
   - Return `200 { revision }`, and map `StaleRevisionError` to 409 `stale_revision`.
   - Server tests 1–3 and 5–10, plus the `204` updates.
3. **Contract, `api.ts` and the mock.**
   - `openapi.yaml`, then `npm run openapi:types`.
   - The hand-written `BookStateResponse.sliceRevisions` and `PutStateRequest.baseRevision`.
   - The `realPutBookState` return value and error `code`.
   - Mock parity, including the epoch.
   - The api tests. Fix any caller the new return type breaks (type-only).
4. **Client: conditional re-sends and re-seeding.**
   - `known`, with its learn-sequence guard and full-read-only learning.
   - The `kept` record (D8a per OD5). (Superseded by C1: the per-field outbox.)
   - Base capture and refresh, including the merge case (D6). (Superseded by C2, C3 and C4: no refresh; bases are stamped per field.)
   - Stale handling (D2) and the `needsFullRead` mark, with Layout's handling of it and the `onEditBook` / language-guard marks (D7).
   - The disk-model helper, and the N5, Library-Edit, voice-override, N8, wipe, D2 and D6 client tests.
   - Park/restore stays in place during this task.
5. **Client: delete the park/restore machinery (D8).**
   - Remove everything on the "goes" list.
   - Replace the deleted tests and add N6/N7. Confirm N6/N7 are red at 5ec7178c first.
   - Make sure nothing is left orphaned.
   - Apply D8b per OD6.
6. **Docs and release notes.**
   - Update this plan's status and Ship notes.
   - Add an entry to `docs/release-notes-next.md`, and a brand-voice line to `RELEASE_NOTES.md`'s in-progress section. Rewrite #3775's existing #3421 entries so they no longer describe park/restore.
   - Write the PR body: the deleted-test → replacement map, and the "Also fixed" line for D7's `main` defect.

## Assumption-checker dispositions

A Premium-tier `spec-checker` ran the `assumption-checker` skill on the first draft of this plan, against the code at 5ec7178c. Findings are referenced by their number in that report.

**Accepted and folded in:**

- **#1 / #2 (Critical) — N5's reopen is revisions-only.** Added D7: the full-read mark, set by a stale refusal and by `onEditBook` / the language guard. `known` is learned from full reads only.
- **#3 (Critical) — a re-parse resets `castConfirmed` to a value equal to many bases.** Added `editEpoch`, rotated by every wipe and minted by every import. D8b now drops nothing on the client.
- **#4 (Critical) — the no-op rule must compare post-merge, post-transform values.** Now specified in D5.
- **#5 — overlapping same-key sequences.** An older sequence's 200 refreshes the base of newer in-flight sequences (D6). (Superseded by C2 and C4: single flight; the refresh is deleted.)
- **#6 — a kept patch merged into a live build bypassed the check.** That send now carries the kept base (D6, Invariant 5). (Superseded by C1 and C3: per-unit merge; no live field carries a kept base.)
- **#7 — a silent drop on replay leaves redux showing a refused edit.** D2 is now one loud rule plus a re-read.
- **#9 — replace keeps `manuscriptId`, and the bundle import keeps the bundle's.** Identity now comes from `editEpoch`, minted by both import paths.
- **#11 — `book_busy` precedes the check on the moving branch,** and the resolve-time `projected` must not run it. Stated in the D3 table.
- **#12 — `confirmCast` and `commitDraft` replace rather than merge.** D1's reasoning is corrected.
- **#16 — the voice-override test must use a designed slot and assert `code`.**
- **#18 — `BookStateResponse` is hand-modelled.**
- **Gaps:**
  - the rollback-to-a-stale-baseline problem: no rollback on a stale refusal;
  - the GET-vs-PUT ordering of `known`: a learn sequence (amended by C4: per field);
  - an absent `known`: the send is unconditional;
  - the absent-field token;
  - pruning kept entries for deleted books: a delete-success drop;
  - "red unless noted": corrected;
  - the prosody flag is a client writer, not a server one.

**Accepted as an open option:**

- **#8 — a single `characters` token refuses retries that span background cast writers.** Offered as D1(c), per-character tokens, under OD1. Frequency unmeasured.

**Rejected or minor:**

- **#10 — a re-parse with no preserved edits does not append to the change log.** Now moot: the epoch moves every token on a re-parse.
- **#15 — `chapters` exclusion.** Kept, because no client sends `chapters` on the state slice (confirmed by the checker). Documented: a conditional write carrying `chapters` is not protected for that field.
- **#13, #14, #17 — confirmations.** No change.

## Out of scope

- ~~The unlocked analysis append to `changeLog.json`~~: fixed in this PR after all (79fecfca); see Ship notes.
- Conditional live first attempts, and endpoints returning tokens (D6(b)).
- A conflict-choice UI (D2(b)).
- Cross-tab sync beyond `broadcast-middleware.ts`.

## Client rework (pass 7): single-flight outbox

**Owner decision (2026-10-26, #3784, after [review pass 7](https://github.com/dudarenok-maker/Castwright/pull/3775#issuecomment-6396493753)):** replace the client save bookkeeping in `src/store/persistence-middleware.ts` with one request in flight per (book, slice) and a per-field outbox. The shape is decided; this section designs its details. The server half stays as built (pass 7 judged it converged), except the 409 body gains `fields` (C9).

**Why.** Passes 1–7 kept finding the same family: facts that belong to one field were tracked per send or per sequence, in maps that disagreed (`covered`, `refreshable`, the whole-slice refresh, per-send keep and rollback). R1–R3 are its latest members. A per-field outbox with one request in flight holds each fact once, on the field it belongs to, so there is nothing to disagree with.

**Size.** `persistence-middleware.ts` is 925 lines at 11a2509f (511 on `main`). Expected after the rework: **700–780**. The rules table, handlers and exports (lines 1–407) change only in comments. The unchanged tail of the action handler (the gate, S3, the draft clear, LEARN / DROP / FLUSH) is about 95 lines. The new engine (maps, `pump`/`run`, four outcome handlers, the build merge) is about 250 lines at this file's comment density. **Above 800 lines, stop and simplify before review.** The test file grows on net (five red-first tests plus about nine pins, minus four deleted); the shrink is in the engine, not in the tests. *(Revised after the checker; the first draft said about 650 lines, and a test-file shrink.) Outcome: 786 at pass 7; 865 after the pass-8 fixes, over this ceiling; 803 after the pass-9 fix (33 lines over 100 characters) — see Ship notes, "Review pass 8 fixes" and "Review pass 9 fixes".*

### Decisions

#### C1 — The outbox: one entry per field on `state`, one entry per build on the whole-slice slices

Per key `${bookId}:${slice}` the middleware holds `outbox: Map<unit, Entry>`, where `Entry = { value, base?: SliceRevision, handler?: PersistFailureHandler }`. `base` is a partial token map covering the entry's own fields.

- **`state`: one entry per editorial field** (the D1 token fields), with `value` holding the field's value. The fields are independent on the server: it merges a partial state patch.
- **`cast`, `manuscript`, `changeLog`: ONE entry for the whole build** (unit `*`), with `value` holding the built object (`{characters}`, `{sentences, mergedAwayKeys}`, `{events}`) and `base` covering all of its token fields.
  - *Forced, not chosen.* The server's manuscript PUT **replaces the file** (`writeJsonAtomic(editsPath, parsed.data)`, `book-state.ts:~1187`; `mergedAwayKeys` is optional in its schema). So a send carrying `sentences` without `mergedAwayKeys` would wipe the merge tombstones on disk: this is the fs-58 loss pinned at `persistence-middleware.test.ts "fs-58 batch ordering"`.
  - A per-field outbox would produce exactly that send. A 200 would clear an unchanged `mergedAwayKeys` and leave a newer `sentences` queued.
  - So for these slices the owner's "per-field outbox" is a single unit, and "drops only the stale fields" drops the unit. This is noted for the owner rather than offered as a choice, because a split send is never correct. Cast and changeLog have one token field each, so nothing changes for them.
- **The send's `baseRevision` is the union of its entries' `base` maps** (omitted when empty).
- **A build merges per unit, newest value wins:**
  - **Changed** (any of the unit's fields is not `Object.is` equal to the entry's, or there is no entry): the entry is replaced by `{ value: built, handler }` with **no base**. A live edit is unconditional, as on `main`.
  - **Unchanged** (every field `Object.is` equal): the entry is kept as it is, base and all. This mattered when `commitDraft` re-sent all eight book-meta fields on every commit (before review pass 9; it now sends only the typed fields, see C7). It still applies when a later build carries the same value for a field: a kept `title` keeps its base rather than being sent unconditionally.
    - Immer keeps an untouched array reference-equal, so `Object.is` is cheap.
    - Some cast reducers re-map `characters` even when nothing changes (`cast-slice.ts:179`, `:793`). A dispatch of one then reads as "changed" and makes a kept cast save unconditional (C11). That fails open, at `main` parity, and needs no deep compare.
  - **Handler is sticky:** `entry.handler = buildHandler ?? previous?.handler`. A bulk reassignment still unsent in the unit owns the unit's failure toast even when a plain edit rode along. That is correct: the send still carries the reassignment, and it is today's `toastPending` behaviour. **Its pin is new work (T3)**: `"a non-bulk manuscript edit PUT failure raises the generic save toast"` does not exercise stickiness.
- **Combined queued edits (6c002345) are true by construction:** `confirmCast` and `commitDraft` write different fields of one map.

#### C2 — One request in flight per key: the flight loop

Per key: `outbox`, `timers` (debounce), `flights: Map<key, Promise<{ slice, ok }>>`. A **flight** is one async loop that sends, waits for the answer, handles it, and either sends again or ends. At most one flight per key exists, so at most one PUT per key is in transit (C-I1).

```
pump(key):                 // called ONLY by a debounce timer and by flushBookNow
  if flights.has(key) or outbox(key) is empty: return
  flights.set(key, run(key)); on settle: flights.delete(key)   // settle never pumps

run(key):
  failures = 0; ok = true
  loop:
    sent = snapshot of outbox(key): unit -> entry.value   // fields whose value is undefined are not sent
    base = union of entry.base over the snapshot            // may be empty
    knownAtSend = known[key] restricted to the sent token fields
    try PUT { slice, patch: sent, baseRevision: base if non-empty }
      -> 200: handle (C6); failures = 0
    catch stale 409 -> handle (C6); failures = 0
    catch other 4xx  -> handle (C6); failures = 0
    catch transport  -> stamp (C3); failures++
                        if failures > 3: give up (C6); return { ok: false }
                        await FLUSH_RETRY_DELAYS_MS[failures - 1]; continue   // re-snapshot: coalesces
    if outbox(key) non-empty and not timers.has(key): continue               // follow-up, no delay
    return { ok }
```

- **A newer edit waits.** A build during a flight only updates the outbox and (re)starts the key's debounce timer. A timer that fires while the flight runs does nothing; the flight's own end sends what is left. This is the owner's accepted cost: one round-trip behind the in-flight PUT. During a retry backoff the wait is up to the backoff (OD-C1).
- **After a server answer, a follow-up goes at once** if the outbox is non-empty and no debounce timer is pending. If a timer is pending, the flight ends and the timer starts the next one, so typing still coalesces.
- **A timer-fired send or a book flush of a book first sends that book's kept keys** (`pumpBook`). When a key's timer fires, every *idle* key of the same book is pumped first, then the key itself. An idle key has an outbox, no timer and no flight: a kept save (C7). `flushBookNow` pumps every key of the book, idle keys first, in a fixed order (the slice order of `LEARNED_SLICES`). That preserves "(i-b) a debounced save of the book sends the kept save before its own", without cutting other keys' debounce short. Retries and follow-ups do not pump other keys.
- **Nothing else starts a flight.** In particular a flight's settle never pumps, so a give-up cannot restart itself. After a give-up, a key is sent again only by a timer (a new persisted dispatch) or by a book flush. Each of those is a new external event; each starts a fresh 4-attempt flight, as a new edit after a give-up does at head.
- `ok` is `false` when the flight gave up, or a refusal dropped or rolled back a field; `true` otherwise (including "a newer value owns the outcome"). `flushBookPersistence` resolves `failedSlices` from it, as today, so #3755's restructure abort is unchanged.

#### C3 — Where a base comes from

- **A live build carries no base** (C1).
- **A transport failure (network or 5xx) stamps the base** on each sent unit whose entry still holds the sent value: `entry.base ??= knownAtSend` restricted to the unit's token fields (one field on `state`, all of the build's on a whole-slice slice; absent fields of `known` are omitted). `??=` because a value that already failed keeps the base it was first sent against; nothing between attempts can teach a newer token for it (a 200 would have removed it, and a full read drops it).
- **`known` absent for the field ⇒ no base.** The entry is still a kept save if it gives up, and is re-sent unconditionally, as today (D6 "with `known` absent, the send is unconditional").
- **A field a newer build overwrote during the flight is not stamped**: it is a live edit that has not been sent yet.
- **Never a base the client did not read** (C-I2): a base is always a `known` token, and `known` only ever holds tokens of values the client hydrated (a full read) or wrote itself (a 200 that carried the field, C4).
- **R3 cannot occur:** a live field is unconditional on its first send, and a newer edit is sent only after the previous request's 200 has taught `known`. There is no older same-key request still in flight that might already have landed the user's value.

#### C4 — Learning `known`

- **From a 200, only the token fields that request carried with a defined value:** `known[key][f] = res.revision[f]`. A field whose snapshot value was `undefined` is dropped by `JSON.stringify` and skipped by the server's `carriedFields`, so it is not learned. A 200's revision also carries tokens for fields the request did not write, which may reflect an outside write the screen never showed. Learning those is R1's root cause. A 200 with no `revision` (an older server) deletes `known` for the carried fields.
- **From a full read, every field**, except a field a PUT has landed on since the read was stamped. The `landedAt` guard becomes **per field** (`landedAt[key][f]`). That is more precise than per key: a read's other fields are still what the screen was hydrated from. `beginFullRead` and `learnSliceRevisions` keep their signatures.
- **Revisions-only reads teach nothing** (unchanged, Invariant 7).
- **R1 cannot occur, twice over:** single flight means there is no older same-key 200 arriving while a newer request waits (the refresh is deleted); and even a 200 that lands first teaches only its own fields.

#### C5 — Retries against single flight

- **The schedule is unchanged:** +1 s, +2 s, +4 s, so 4 PUTs at most per run of consecutive transport failures. The counter is per flight, and resets after any server answer (200, 409, other 4xx).
- **A newer edit coalesces into the next attempt.** Each attempt re-snapshots the outbox (`run`'s loop), so a value built during the backoff rides the scheduled retry, unconditional (no base), next to the failed fields with theirs. This keeps the newest value per field, and sends a base only on fields whose own send failed (C3). It does **not** end the backoff early (OD-C1).
- **A coalesced value does not reset the counter.** If the server is down, a newer edit made during the backoff is given up on with the rest; it is kept (C7) and re-sent on the book's next flush.

#### C6 — Outcomes

"Holds the sent value" means `Object.is(outbox.get(unit)?.value, sent[unit])`. On the whole-slice slices the unit is the whole build (C1), so "the stale fields" of that slice are its one unit.

| Outcome | Fields affected | Effect |
|---|---|---|
| **200** | sent fields still holding the sent value | Removed from the outbox. `known` learns them (C4). For each handler with an `onSuccess` among the removed entries: dispatch it only if **no** entry it owns remains in the outbox. A newer commit still queued keeps its rollback baseline; this is #2230's gate, now per field. A kept save that lands on replay prunes `lastCommitted` (OD5 / N2). |
| **409 `stale_revision`** | the sent units, among those that carried a base, that hold a named field and still hold the sent value | Removed. **No rollback** (D2). If at least one was removed, toast and `markNeedsFullRead`. The toast uses the handler's message if a removed entry has a handler, else `staleMessage(title)`; its dedupe key is `book-persist-stale:<bookId>`. If none was removed (every stale unit was overwritten by a newer value), there is no toast and no mark, because the newer value owns the outcome (P6-3, now per field; OD-C3). Every other entry stays and goes in the follow-up with its base. **If `fields` is missing, malformed, empty, or names no based unit, read it as "every sent unit that carried a base".** Only a based unit can be stale, so this never drops a live edit, and it always removes or un-bases something (termination). The server never sends an empty list (`book-state.ts:1073` throws only on a non-empty one). |
| **Other 4xx** | per **rollback** handler among the sent entries | If every outbox entry the handler owns still holds its sent value, remove them, toast the handler's message (no title), and dispatch `rollback(bookId, restoreDraft = bookOpen)`. Otherwise a newer commit is queued and owns the outcome, so do nothing for that handler (no toast, no rollback); its entries go in the follow-up. **If the send carried no rollback handler at all,** remove every sent field still holding its sent value (a 4xx is final), and toast only if one of them has a toast-only handler (bulk reassign), as today. Entries with no rollback handler that rode with a rolled-back handler (a `castConfirmed`) **stay and go in the follow-up**. This is R2's fix. |
| **Give-up** (4th transport failure) | — | Bases are stamped (C3). The flight ends `ok: false` and the entries stay (kept, C7). **If the book is open:** for each rollback handler, remove its entries and dispatch `rollback(bookId, true)`; other entries stay kept (a304ae55). **If the book is not open:** no rollback; everything stays kept and is re-sent on the book's next flush (f8871b1a). One toast: the handler's message (with the title) if any sent entry has a handler, else `flushFailedMessage(title)`. |

**Termination.** A flight ends:
- **Transport failures:** after at most 4 consecutive ones, it gives up and returns. Its settle never pumps (C2).
- **A stale 409:** each one removes a based unit, or finds the unit overwritten by an unbased newer value, which cannot be refused as stale. The fallback rule above covers an empty or useless `fields`.
- **A non-stale 4xx:** each one removes the sent-valued entries of a handler, or of the whole send when it carried no rollback handler.
- **Re-sending a refused entry:** this only happens behind a newer value (the "newer owns" rows). Each such loop consumes a new persisted dispatch made while the flight ran. That dispatch is a user edit or an automated one: `applyVoiceMatches` from Layout, or the streamed `applyDetectedEmotions` / `applyDetectedInstruct`. The loop is bounded by those dispatches, not only by user actions.

A send whose 4xx was in fact caused by a non-handler field next to a handler (none is known today: `castConfirmed` is a whitelisted boolean) rolls the handler back and then drops the field on the follow-up: two requests, then final.

#### C7 — Leaving, flushing, kept saves, full reads, delete

- **A kept save is the idle entries of a key:** outbox non-empty, no debounce timer, no flight. There is no separate `kept` map. An entry becomes idle by giving up (C6), or by staying behind a give-up when it was coalesced but never sent.
- **Leaving a book** (S3): `flushBookNow(bookId)` clears every debounce timer of that book and pumps every key. A running flight continues, and what was queued rides its next attempt or its follow-up. **This changes timing:** at head, an edit sent on leaving goes at once as its own sequence. Under C it waits behind the in-flight request or backoff (up to 4 s, OD-C1). That is within the owner's accepted cost. There is no unload flush (pre-existing), so a tab closed inside that window loses the edit, as it would during a debounce today.
- **`flushBookPersistence(bookId)`** (Layout's flush-before-re-read, and restructure) calls `flushBookNow`, then resolves when every flight of the book has ended, follow-ups included (they are in the same loop). It resolves `null` when none ran. The outcome shape is unchanged.
- **Kept and re-sent after leaving (owner decision, 2026-10-25):** natural. A give-up with the book not open removes nothing, so the entries stay idle, and the book's next flush or next edit sends them with their bases.
- **Full read (F1, amended by P2 of review pass 8):** `dropRetainedSaves(bookId, true)` removes the outbox of every key of the book that is idle, except one kind of `state` entry: (P2) a `state` entry that carries a base stays, and goes with the book's next send for the server to judge. Cast, manuscript and changeLog entries are still dropped, based or not: the read puts the screen back to disk, and a kept whole-slice save landing later would leave screen and disk disagreeing (fa0d78e2). Entries with a live timer or a flight are live edits and stay. **Delete success** dispatches `dropRetainedSaves(bookId)`, which drops everything (D8b hygiene). (Pass 8's second exception, a `state` key held for the read (P1), was removed in pass 9.)
- **A book-details save sends only the fields typed since the last accepted save (P1, redone in pass 9).** A `bookMeta/commitDraft` sends the keys of `lastCommitted[bookId].draft`, which is exactly what a rollback reverts, not all eight `saved` fields. A value refused as stale and still on screen therefore cannot ride a later commit back to disk. `markNeedsFullRead`'s `refused` list prunes a stale-refused field from that set, so a rollback does not restore it and a later commit does not send it again. Nothing is held: pass 8's hold of a marked book's `state` sends until the read (bbb9f733, 8a316704, and the P1 half of ca09d9ad) was removed in ae6bb325 after review pass 9 found it unsafe (P9-1, P9-2, P9-3). A failed full read is retried by Layout only while the book stays open; if the user leaves first, nothing waits for it.
- **Every full read of the open book keeps the details draft (PB, review pass 10, owner decision on #3784, 2026-10-28; widened by the owner decisions on review pass 11, 2026-10-29).** Layout passes `keepDraft` to `bookMeta.hydrateFromBookState` on every full read, the first after opening the book included, unless the book was last read from a different manuscript.
  - **Why it is safe:** the middleware clears the draft on a switch to a different book (#3754, #3782), so a draft still present at a read was typed on this book.
  - **The one exception is a re-import under the same id (P11-1).** A book id is its author/series/title slug, so deleting a book and importing one with the same slug reuses the id. Every import mints a new `manuscriptId`, and the read of that new manuscript wipes the old book's draft. A re-parse or a manuscript replace keeps the manuscript id (pinned on the server), so it keeps the draft.
  - **`metaReadFor`** is a per-book map of the manuscript each book's details were last read from. It is not reset by navigation. It is per book rather than "the last read", so a visit whose read never landed cannot hide a re-import made in another tab.
  - **What the read does:** it refreshes `saved`, so an outside write shows on every field the user is not editing. It keeps `draft`, so a field the user is typing in, or a draft a failed save restored (#2230, #3754), still shows the user's value.
  - **The pending commit snapshot is kept too (P11-2).** A `keepDraft` hydrate rebases `lastCommitted[bookId].saved` onto the read instead of deleting it. A commit queued or in flight across the read therefore still restores its typing if that save then fails, and its rollback reverts to the read, keeping the outside write the read brought. The send is unchanged: still exactly the snapshot's typed fields.
  - **A hydrate without `keepDraft`** wipes the draft and deletes the snapshot. That is the re-import read, and the library-entry fallback, which runs only while `saved` holds nothing for the book.
- **Does the outbox just persist per book?** Yes. It is keyed per (book, slice) and never cleared by navigation, only by an answer, a full read, or a delete.

#### C8 — Book-meta rollback and drafts: what is now natural, what needs code

| Guarantee | Status under C |
|---|---|
| P6-1: a 4xx after leaving reverts `saved` without restoring the draft | **Needs code** (one argument): the 4xx rollback passes `restoreDraft = bookOpen`. Tests (g), (h) stay. |
| #3782: a draft is never restored into another book | **Needs code**, unchanged: the give-up rollback runs only when the book is open, and a 4xx rollback restores the draft only when open. |
| #3782: opening a different book clears the draft | **Unchanged code** (`lastOpenBookId` block). |
| #2230 / #3754: a full read of the open book keeps the draft and the pending commit snapshot (PB, review pass 10; P11-2 and the first-read decision, review pass 11) | **Needs code:** `keepDraft` on the hydrate, passed by Layout unless the book was last read from a different manuscript (P11-1); the hydrate rebases the snapshot (C7). |
| a304ae55: a rolled-back save keeps the carried earlier edit | **Natural:** a rollback removes only the entries its handler owns. |
| 6c002345: combined queued edits | **Natural** (C1). |
| f8871b1a: kept and re-sent after leaving | **Natural** (C7). |
| OD5 / N2: a landed replay prunes `lastCommitted` | **Natural** (C6, 200 row). |
| N7: an older landing does not prune a newer commit's baseline | **Natural** (C6: the handler still owns a queued entry). |
| Pass-7 cleanup: a replayed book-meta save that lands prunes `lastCommitted`, so a later give-up rolls back to the replayed title | **Natural**; gets a pin (it had no test that could fail). |

#### C9 — Stale refusal UX, and the 409 contract

- **UX (OD2 stands, per field):** a stale refusal that removed a field toasts, naming the book, and marks it for a full re-read. If the book is open, Layout re-reads it now. The mark stays whole-book: Layout's full read is the only re-seed path, and a per-slice re-read would be new machinery.
- **P6-3 is not moot; it becomes the per-field rule.** "Superseded" now means that a newer build overwrote the stale field during the flight, so nothing was removed, and there is no toast and no mark. Its two tests stay; their choreography is rewritten for single flight (test map).
- **The blind spot pass 7 found is fixed by `fields`.** In that case a correctly refused older send's stale field is covered by a newer build, but the send also carried an uncovered field, and the client used to toast and re-read anyway. Now the client knows which field was stale, so the uncovered field is simply re-sent.
- **Contract.** In `openapi.yaml`, under `PUT /api/books/{bookId}/state` → `409`, add to the response schema:

  ```yaml
  fields:
    type: array
    items: { type: string }
    description: >-
      Present only with `code: stale_revision`: the carried fields whose base
      revision is stale (names from the slice's fixed field list). Never a path
      or lock text.
  ```

  Then `npm run openapi:types`.
- **Server:** `res.status(409).json({ error: STALE_REVISION_SENTENCE, code: 'stale_revision', fields: e.fields })`. `StaleRevisionError.fields` already exists. Its values come from `staleFields` over `carriedFields(FIELDS[slice], patch)`, so they are always names from `STATE_/CAST_/MANUSCRIPT_/CHANGELOG_REVISION_FIELDS`, never client text and never a path. A server test pins the body to exactly `{ error, code, fields }` with `fields ⊆ FIELDS[slice]`, on the non-moving state branch, the moving branch, cast, and a manuscript send with both fields stale.
- **Client contract:** `realPutBookState` reads `fields` when it is an array of strings and throws `Object.assign(new Error(…), { code, fields })`. `mockPutBookState` throws with the `stale` list it already computes. `src/test/book-state-disk.ts` does the same. The api tests pin all three.

#### C10 — What goes, what stays

**Goes from `persistence-middleware.ts`:**
- the maps `pending`, `toastPending`, `rollbackFields`, `generation`, `inFlight` (replaced by `flights`), `kept`, `carriedKept` and `sequences`;
- the type `KeptSave` and the type `Sequence`, with its `covered` and `refreshable`;
- the helpers `mergeSaves`, `sendBase`, `resendRetained`, `leaveBehind` and `uncovered`;
- the older-200 refresh, and the `superseded`/`overtaken` computation.

**Stays, and composes:**

| Kept item | How it composes with C |
|---|---|
| D7 marks (`onEditBook`, the language guard, Account restore, the stale mark) | Unchanged. The middleware dispatches `markNeedsFullRead` from C6's stale row. Layout's handling is untouched. |
| Server half (precondition, `editEpoch`, both import mints, the re-parse/replace/Start-fresh/restore rotations, the per-field no-op rule) | Unchanged, except C9's body field. The client sends a per-field partial `baseRevision`, which the server already supports: `staleFields` checks only fields with a base. |
| The changeLog and manuscript `book` locks (79fecfca, cfb9c94a) | Server-side; untouched. |
| Restore epoch (P6-2b, 69f188c7) | Server-side; a kept entry's base is refused after a restore, the same as after a wipe. |
| #3755 restructure abort | `flushBookPersistence` keeps `{ failedSlices }` (C2 `ok`). A kept save is re-sent first by the next flush (C7). |
| #3624 stage/slice gate, `BOOK_KEYED_RULES`, #3754 draft clear, per-key debounce (S4), leave-flush (S3), revisions never PUT | Unchanged code paths. |
| Retry schedule, 4xx final, named give-up toast, `savedTitleOf` | Unchanged (C5, C6). |
| Exports `flushBookPersistence`, `BookFlushOutcome`, `dropRetainedSaves`, `beginFullRead`, `learnSliceRevisions`, `PERSISTED_ACTION_TYPES` | Names unchanged; `dropRetainedSaves` gained an optional `onFullRead` parameter, which `layout.tsx` passes on a full hydrate. `routes/index.tsx`, `restructure.tsx` and `account.tsx` need no edit. |

#### C11 — Residuals (stated, not fixed)

- **Lost 200, then a newer value, then a second transport failure (OD-C4).**
  1. Attempt 0 of `X = 1` lands, but its response is lost, so its base is stamped `k0`.
  2. During the backoff the user sets `X = 2`, which is unbased.
  3. That retry also fails, so `X = 2` is stamped `k0`, because `known` was never taught `k1`.
  4. The next retry is refused as stale: disk holds 1, and 2 ≠ 1.

  The result is a false "changed elsewhere" toast, and the user's `X = 2` is dropped. It **fails safe**: nothing of anyone else's is reverted, and the book is re-read, so it shows 1. It needs a lost response plus two transport failures plus a same-field edit inside the backoff. A retry of the *same* value after a lost 200 is a server no-op and lands, so the common lost-200 case is fixed. A slow 200 is fixed by single flight.
- **A kept cast save made unconditional by a no-op re-map.**
  - Some cast reducers re-map `characters` even when nothing changes (`cast-slice.ts:179`, `:793`), and Layout dispatches `applyVoiceMatches` automatically.
  - Such a dispatch reads as a changed value (C1), so it replaces a kept cast entry with an unbased one.
  - This fails open, at `main` parity. A deep compare of the roster would close it; it is not worth it for a cast-only, fail-open case.
- **A 200 can teach a token for a value the client did not write.** `pickString` keeps disk's title when the sent title is empty (`book-state.ts:~1256`). This fails open, and is unreachable from the Listen editor's normal path.
- **A stale screen re-asserted by a book-details commit.** (Before pass 9 this was an eight-field snapshot; `commitDraft` now sends only the typed fields, but a typed field is still sent unconditionally over another tab's newer value.) This happens when another tab writes the book while this tab shows it. `main` has the same behaviour, and it is out of scope (cross-tab); D7's marks cover every same-tab outside writer.

### OWNER DECISIONS

- **OD-C1 — A newer edit made during a retry backoff.**
  - **(a) Recommended:** it rides the scheduled retry (it waits up to 4 s while the server is failing).
  - **(b)** Its debounce ends the backoff early and retries now, with the attempt counter carried on.

  *Why (a):* the server is already failing, and (b) compresses the outage window, so the save gives up sooner. It also adds a cancellable sleep.
- **OD-C2 — Consequence of "a live build carries no base" (confirm).** When a live commit is combined with a kept field, only the kept field carries its base, and the live fields go unconditionally.
  - **(a) Recommended: accept.** D6 chose differently: it based every field of such a send (test "a live build a kept save was merged into carries the kept base, so an outside write refuses it"). That test is rewritten to: an outside write *to the kept field* refuses the send; an outside write to a live field is overwritten, as on `main`.
  - **(b)** Base every field of a send that carries a kept field. This is one ingredient of R3: it can refuse the user's own unacknowledged write. Under the outbox it does not reproduce R3 alone (single flight leaves no older same-key request to have already landed the write); R3 is pinned by C3's "a live build carries no base", and the red-first R3 test is red only when that rule is broken.

  *Why (a):* this is `main` parity for live edits. Same-tab outside writers are covered by D7's full read.
- **OD-C3 — A field the server refused as stale whose value a newer edit already replaced.**
  - **(a) Recommended:** the newer value is sent unconditionally in the follow-up, with no toast and no re-read (P6-3, per field).
  - **(b)** Drop the newer value too, toast, and re-read.

  *Why (a):* the newer value is a live edit (OD3), and (b) discards the user's newest typing.
- **OD-C4 — Accept C11's lost-200 residual.**
  - **(a) Recommended: accept and document.**
  - **(b)** Extend the contract so a retry can also name "the value I last sent" as acceptable. That needs a server-side hash of the previous value, and new client state.

  *Why (a):* it is narrow (three coincident failures), it fails safe, and (b) re-grows the state this rework deletes.

### Invariants (client, replacing Invariant 5 and amending 6 and 8)

- **C-I1.** At most one **middleware-issued** `PUT /state` per (book, slice) is in transit. The direct writers (`onEditBook`, the language guard, prosody flags, `cast.tsx`, `analysing.tsx`) bypass the middleware, as today.
- **C-I2.** A field's base is only ever `known[key][f]` captured at a send that carried `f`, stamped when that send failed in transport. It is never taken from a 409, a revisions-only read, or a 200 that did not carry `f`.
- **C-I3.** A build of a changed unit replaces the entry with no base. A build whose every field is `Object.is` equal keeps the entry, base included. A cast, manuscript or changeLog send always carries every field of its build (a manuscript send never omits `mergedAwayKeys`).
- **C-I4.** A 200 removes exactly the entries still holding the value sent, and teaches `known` only the fields it carried.
- **C-I5.** A stale 409 removes only based units that are refused and still hold the value sent (a whole-slice build is one unit). It never rolls back. It toasts and marks the book only when it removed one. Everything else goes in the follow-up.
- **C-I6.** A non-stale 4xx rolls back a handler only when every entry the handler owns still holds its sent value, restoring the draft only if the book is open. Entries with no rollback handler that rode alongside stay; a send with no rollback handler loses its sent-valued entries.
- **C-I7.** A give-up rolls back only while the book is open; everything else stays as kept.
- **C-I8.** A kept save is a key's idle outbox. A timer-fired send or a flush of the book sends it first; a delete removes it, and a full read removes it except based `state` entries (P2). A `commitDraft` sends only the typed fields (the keys of `lastCommitted.draft`, less any `refused` by a stale 409). A flight's settle never starts a flight.
- **C-I9.** The middleware holds none of `pending`, `toastPending`, `rollbackFields`, `generation`, `kept`, `carriedKept`, `sequences`, `mergeSaves`, `sendBase`, `resendRetained` or `leaveBehind`. The export names are unchanged, but `dropRetainedSaves` gained an `onFullRead` parameter (P2), which Layout's full hydrate passes.
- **C-I10.** Every full read of the open book, the first after opening it included, refreshes `saved`, keeps `bookMeta.draft`, and rebases `lastCommitted[bookId].saved` onto the read. The exception is a book last read from a different manuscript (a re-import under the same id): that read wipes the draft and deletes the snapshot, as does the library-entry fallback hydrate. A switch to a different book clears the draft in the middleware. (PB, review pass 10; P11-1, P11-2 and the first-read decision, review pass 11.)

### Test plan (C)

**Red-first.** Write each of these before the rewrite. Run it against the **unmodified engine**: T1 does not touch `persistence-middleware.ts`, so the engine on the branch is still 11a2509f's. Confirm it is **red for the stated reason**, then make it green with the rewrite. Every test **seeds `known` with a full read first** (the plan-289 `setup()` at `persistence-middleware.test.ts:~1306` does this). Without a seed, C sends unconditionally (C3) and R1 would land.

All of them use `src/test/book-state-disk.ts`, which must first be brought closer to the server:
- **Replace, don't merge, on the whole-slice slices.** The server writes the cast, manuscript and changeLog files whole (`book-state.ts:~1187`), and so does `mockPutBookState`. The helper's `{ ...before, ...patch }` (`:136`) does not, and that hides a partial manuscript send.
- **Answer 400 on a manuscript patch without `sentences`.**
- **New capabilities:**
  - `hold(match)`: keeps a matching PUT in transit until it is released;
  - `loseResponse(match)`: writes, then throws a 503;
  - `refuseNext(code, match)`: a scripted non-stale 4xx such as `book_path_taken` or `book_busy`;
  - `maxInTransit(key)`: counts concurrent PUTs per key.

1. **R1 (pass 7's repro).**
   - Steps: hold `confirmCast`'s PUT; commit title "Mine"; another writer sets title "Theirs"; release the hold (200); "Mine"'s next PUT returns 503 once.
   - Expect: disk title "Theirs", one stale toast, the book marked.
   - Red at head: the retry rides the refreshed base, and disk ends at "Mine".
2. **R1-learn** (the C4 rule in isolation; no overlap).
   - Steps: another writer sets "Theirs"; `confirmCast` lands; commit "Mine", which gets a 503, then the retry.
   - Expect: a 409, and disk "Theirs".
   - Red at head: `known.set(key, res.revision)` taught the title token from `confirmCast`'s 200.
3. **R2 (a) book open / (b) book left.**
   - Steps: `castConfirmed` kept after 4×503; rename to a colliding title, which gets 409 `book_path_taken`.
   - Expect: the title rolled back (draft restored only in (a)), `castConfirmed` sent in the follow-up and on disk `true`, and exactly the book-details toast.
   - Red at head: `castConfirmed` is dropped.
   - **(c):** add `expect(castConfirmed).toBe(true)` to "a refused superseded save whose book-meta fields a newer commit carries does not roll them back" (red at head).
4. **R3.**
   - Steps:
     1. `confirmCast` gets a 503.
     2. Commit T1 **before** `confirmCast`'s 1 s retry wakes. At head, T1 then goes as its own attempt 0; under C it rides the retry.
     3. The PUT carrying T1 writes, but its 200 is held.
     4. Commit T2, and let T2's debounce fire while the hold stands.
     5. Release.
   - Expect: disk title T2, `castConfirmed` true, no toast, no mark.
   - Red at head: a false 409; disk T1 and a "changed elsewhere" toast.
5. **Single flight.**
   - Steps: a scripted run of overlapping `commitDraft`, `confirmCast` and `cast/setCharacters` with held and slow responses.
   - Expect: `maxInTransit` is 1 for every key, and disk ends at the newest value per field.
   - Red at head: concurrent same-key sequences.

**New pins (T3).** Each one names the mutation that turns it red. Confirm it red under that mutation once, then restore the mutation byte-for-byte:
- **The equal-value rebuild keeps the base.** A kept `title` survives a notes-only commit with its base, and an outside title write refuses it. *Mutation:* always replace on build.
- **A whole-slice stale drop.** A manuscript 409 naming only `sentences` drops the whole unit, and nothing is re-sent. *Mutation:* split the manuscript unit per field.
- **Tombstones survive a mid-flight sentence edit.**
  - Steps: a merge is sent; a `setSentenceCharacter` lands during the flight; the 200 arrives.
  - Expect: the follow-up carries `mergedAwayKeys`, and disk keeps the tombstone (the fs-58 class).
  - This is red against a per-field manuscript outbox, and needs the helper's replace semantics. *Mutation:* split the manuscript unit per field.
- **The per-field `landedAt` guard.**
  - Steps:
    1. Open the book (full read 1, title token `k0`).
    2. Another writer sets title X (`k1`).
    3. Mark the book, so full read 2 is issued.
    4. A `castConfirmed` PUT lands while read 2 is in flight.
    5. Read 2 returns X / `k1`, and the screen shows X.
    6. Rename to Y. It gets a 503, then the retry.
  - Expect: the retry carries `k1` and lands Y.
  - *Mutation:* make the guard per key, so `known.title` stays `k0`. That gives a false 409.
- **A follow-up after a stale drop.**
  - Steps: a kept eight-field `commitDraft`; a Library Edit changes the title; reopen.
  - Expect: the title is dropped; `author` (changed in the kept save) lands in the follow-up; one toast; one full read.
  - *Mutation:* drop all sent fields on a `state` 409.
- **A replayed save that lands prunes `lastCommitted`.** This is the pass-7 cleanup, and it had no test that could fail. *Mutation:* skip `onSuccess` on a replay.
- **A give-up with a coalesced, never-sent value.** It stays kept and is sent on the next flush. *Mutation:* clear the outbox on give-up.
- **A 404 drops the key's outbox and ends the flight** (termination). *Mutation:* keep the rest on a no-handler 4xx.
- **The bulk-reassign handler is sticky** over a later plain manuscript edit in the window. This is new work; the existing "a non-bulk manuscript edit PUT failure raises the generic save toast" does not exercise it. *Mutation:* `handler = buildHandler`.
- **The `fields` fallback.** The api parses `fields`. In the middleware, a missing or empty `fields` drops every **based** sent unit, keeps unbased live units, and the flight ends. *Mutation:* fall back to every sent unit.

**Server (T1):** a 409 body `{ error, code, fields }` on the four shapes in C9, `fields ⊆ FIELDS[slice]`, with two stale fields both listed. These are red with `fields` removed from the route.

**Unchanged:** E2E none, and on-box none (the reasons in the Test plan above still apply).

### Finding map (every earlier finding)

| Finding | Fate under C | Test |
|---|---|---|
| N5 | Still needed: server precondition + D7 | Layout N5, server test 1: keep |
| N6 (a), (b) | Moot by construction (no park / `landedFields`) | Route N6 (a)/(b): keep as end-state regressions |
| N7, (b), (c) | Natural (C6 handler-owns gate; C8) | Route N7 ×3: keep |
| N8 | Still needed (server, epoch) | Server + route N8: keep |
| P6-1 | Still needed: `restoreDraft = bookOpen` (C8) | meta-draft (g), (h): keep |
| P6-2 (a), (b) | Still needed (D7 mark; restore epoch) | Layout P6-2(a), server restore-epoch: keep |
| P6-3 | Per-field rule (C9) | "a stale refusal a newer save superseded", "a stale refusal of a field the newer send did not carry": keep the behaviour, rewrite the choreography for single flight |
| P6-4 | Moot by construction (no supersession) | "a superseded state send keeps a carried kept field", "a superseded state send whose newer edit is still queued" → one coalesce test ("a commit during `confirmCast`'s backoff rides its retry; `castConfirmed` keeps its base"); "a newer save given up on after leaving the book" keep, rewrite the choreography |
| P6-5 | Still needed (marks in catch) | Layout P6-5, language guard: keep |
| P6-6 | Server, verified; the plan's false caveat is corrected (Ship notes) | Server lock tests: keep |
| R1 | Fixed by construction (C2, C4) | Red-first 1, 2 |
| R2 | Fixed (C6: other 4xx row) | Red-first 3 |
| R3 | Fixed by construction (C3) | Red-first 4; "a later edit that takes the left-behind field" folds into it |
| `leaveBehind` own-field `onSuccess` (pass-7 cleanup) | Mechanism gone; the behaviour is natural | New pin "a replayed save that lands prunes `lastCommitted`" |
| False refusal: slow 200 | Fixed by single flight | Red-first 4 |
| False refusal: overtaken blind spot | Fixed by `fields` (C9) | "a stale refusal of a field the newer send did not carry" |
| False refusal: lost 200 | Same value: fixed (no-op). Newer value plus a second failure: residual (OD-C4) | Documented in C11 |
| P6-6 doc caveat false | Fixed in this plan; release-notes-next :300 and the PR body in T4 | — |
| Catalogue chores (R1, R3 shapes) | T4 adds entries 48 and 49 to `reviewer-brief.md` | — |

### Test map (existing PR tests, `persistence-middleware.test.ts` unless named)

Rows cite the test title as of 11a2509f, because line numbers drift. Tests the rework re-titled are mapped old to new in the PR #3775 body.

| Test | Fate | Task |
|---|---|---|
| "a newer write supersedes a pending retry" | Keep. It passes as written: the retry carries the newer value. | T2 |
| "#2230 race" | Adjust: one PUT in flight at a time (`deferred` length 1, then 1). The end-state assertions are unchanged. | T2 |
| the (i)…(v-b) kept-save tests (`describe` "a given-up save is kept and re-sent on the next flush") | Keep | — |
| "attempt 0 carries no base" (base on retries and replay) | Keep (the assertion is a per-field subset) | T2 |
| "a live build a kept save was merged into carries the kept base" | Rewrite per OD-C2: the outside write to the kept field refuses it | T2 |
| "a ui/confirmCast in the same window combines with the book-meta commits" (commit + confirmCast, generic 4xx) | **Adjust per R2:** the commit rolls back and `castConfirmed` goes in a follow-up, so expect 2 PUTs, not 1. Not a regression: this is the owner's a304ae55 rule applied to refusals. | T2 |
| "(i-c) two kept slices of one book are each re-sent exactly once" | Keep the invariant (each once). Assert the order C2 fixes (`LEARNED_SLICES` order) or no order. | T2 |
| "a second state build in the same window keeps the kept fields", "a combined commit + confirmCast that gives up with the book open" | **Adjust** `baseRevision` to the kept unit's subset (`{castConfirmed}`), not the 16-field revision | T2 |
| "two queued state edits with no kept save combine" | Keep | — |
| "a confirmCast after a commit that carried a kept title" | Adjust `baseRevision` to the per-field subset (title is live, so it has none) | T2 |
| "an older same-key 200 refreshes the newer in-flight sequence's base" | **Delete.** Replaced by red-first 1 and 5 (no refresh exists) | T2 |
| "a full read stamped before a PUT landed" | Keep. The per-field variant is a new pin | T3 |
| "voice override: a kept roster is refused", "wipe: a retrying confirmCast that spans a re-parse is refused", "D2 on a replay", "a stale refusal nothing superseded still toasts" | Keep | — |
| "D2 on a retry" | **Adjust:** after the stale drop of `title`, the other based fields go in a follow-up, so expect outcomes `['503','409','ok']` | T2 |
| "a stale refusal a newer save superseded", "a stale refusal of a field the newer send did not carry", "a left-behind field is refused once the book changed elsewhere", "a newer save given up on after leaving the book", "a refused save a newer commit fully overtook" | Keep the end state; rewrite the overlap choreography for single flight | T2 if red, else T3 |
| "a superseded state send keeps a carried kept field", "a superseded state send whose newer edit is still queued" | Replace with one coalesce test (P6-4 row) | T3 |
| "a later edit that takes the left-behind field" | Replace with red-first 4 (R3) | T3 |
| "book-meta fields that ride a queued confirmCast" | **Adjust choreography:** under OD-C1, `castConfirmed` waits for the retry; after the path-taken 4xx, `castConfirmed` goes alone in the follow-up. Keep the toast and rollback assertions. | T2 |
| "a refused superseded save rolls back and toasts" | Keep the behaviour (a refused send whose handler entries all hold their values rolls back and toasts); re-title | T3 |
| "a refused superseded save whose book-meta fields a newer commit carries" | Keep, plus the `castConfirmed` assertion (R2 (c)) | T2 |
| meta-draft (e)–(h), route N6/N7/N8/S1/S3, Layout, restructure, api tests | Keep | — |

Every deleted or replaced test is named in the PR body's deleted-test → replacement map (T4).

### Assumption-checker dispositions (C)

A Premium-tier `spec-checker` ran the `assumption-checker` skill on the first draft of this section, against the code at 11a2509f.

**Accepted and folded in:**

- **#1 (Critical): a per-field outbox splits manuscript sends, and the server replaces the file.** That wipes `mergedAwayKeys` (fs-58). C1 now makes each whole-slice build one unit. This is forced, not a choice: it is noted for the owner, but it is not an OD.
- **#2 (Critical): `book-state-disk.ts` merges where the server replaces, and has no non-stale 4xx.** T2 brings the helper to parity first (replace semantics, a 400 on a missing `sentences`, `refuseNext`), and a tombstone pin was added.
- **#3: the test map missed rows that break.** Added "a ui/confirmCast in the same window combines with the book-meta commits" (R2 reverses it), "(i-c) two kept slices of one book are each re-sent exactly once" order, "a second state build in the same window keeps the kept fields" / "a combined commit + confirmCast that gives up with the book open" base subset, "D2 on a retry" follow-up, and "book-meta fields that ride a queued confirmCast" choreography. T2 now re-derives the map against the rewritten engine before editing any assertion.
- **#4: termination gaps.**
  - `pump` is no longer "called at a flight's end": a settle never pumps, so a give-up cannot restart itself.
  - An empty or useless `fields` now falls back to "every based sent unit", which always makes progress.
  - Transport termination is stated.
  - Restarts after a give-up come only from new external events, the same as at head.
- **#5: the per-field `landedAt` pin was a no-op mutant.** It was re-specified with an outside title write between two full reads.
- **#6: red-first preconditions.** The tests must seed `known` with a full read; "red at 11a2509f" means against the unmodified engine; R3's timing is spelled out.
- **#7: a 200 learning `undefined`-valued fields.** C4 now learns only fields carried with a defined value. The `pickString` empty-title case is listed in C11 (fails open).
- **#8: no-op cast re-maps strip a kept base.** Listed in C11 (fails open, at `main` parity).
- **#9: the stickiness pin is new work.** It is marked so in the test plan.
- **#10–#12: wording.** C-I1 now says middleware-issued, C-I8 is reworded, and C7 now states the leave-flush timing change.
- **#13: size.** Revised to 700–780 lines, with an 800 ceiling. The test file grows on net.
- **Contradictions:**
  - The "missing `fields` = every sent field" rule contradicted C-I5. It now reads "every based sent unit".
  - The termination claim that "each loop consumes a user action" was wrong. It now says "a new persisted dispatch", which includes the automated ones.

**Rejected or kept as is:**

- **The stale toast "misstates" a partly-landed commit.** The copy stays: the dropped field was not saved, and the immediate full re-read shows what was. Changing user-facing copy is outside this rework.
- **#14 (contract is path-free on every branch): confirmed.** No change.

### Task breakdown (C; one `implementer` subagent per task, in order; a `task-reviewer` after each)

1. **T1 — Server `fields` and the contract.**
   - The `book-state.ts` 409 body, and the server tests (C9).
   - `openapi.yaml`, then `npm run openapi:types` (with no drift beyond the new property).
   - `realPutBookState` / `mockPutBookState` `fields`, and `book-state-disk.ts` `fields`.
   - The api tests.
   - Run the server suites with `OLLAMA_URL=http://127.0.0.1:1` (the precondition suite drives Start fresh).
2. **T2 — Client engine rewrite, red-first.**
   - Bring `book-state-disk.ts` to server parity: replace on whole-slice slices, 400 on a missing `sentences`, and add `hold` / `loseResponse` / `refuseNext` / `maxInTransit`. The existing suites must stay green on the unmodified engine.
   - Add red-first tests 1–5. Confirm each red against the unmodified engine, and paste the failing assertion lines into the report.
   - Rewrite the engine per C1–C9: the outbox, `pump` / `run`, stamping, learning, the outcome table, kept = idle, and `dropRetainedSaves`.
   - **Re-derive the test map** by running every client suite against the rewritten engine, before editing any assertion: middleware ×4, `routes/index`, `layout`, `restructure.preview`, `use-language-guard`, and the api tests.
     - Make the T2-column changes.
     - A red test the map does not list is **reported with its cause** before it is touched. Never edit an assertion just to go green.
   - Report the line count. If it is over 800, stop and simplify.
3. **T3 — Test-map migration and pins.**
   - The T3-column rows, and the new pins.
   - A mutation battery covering each pin's named mutation, plus C-I1 through C-I8: assert a green baseline first, restore byte-for-byte, and flag any no-op mutant.
   - The rows that T2 kept green as written but whose titles still name a deleted mechanism are re-titled.
4. **T4 — Docs.**
   - `docs/release-notes-next.md`: rewrite the #3421 entry (:297) around the outbox, and fix :300's false lock caveat.
   - `RELEASE_NOTES.md`: check the user line still reads true.
   - This plan's Ship notes ("What was built → Client").
   - `reviewer-brief.md` entries 48 (R1: a base refreshed from a response that covers more than the write it acknowledges) and 49 (R3: merging a replay into a live send changes whether the live fields are checked).
   - The PR #3775 body: the deleted-test map, and a "Superseded in pass 7" note.

**Entry point:** T1, the 409 body in `server/src/routes/book-state.ts` (~:1500), and its server test.

## Ship notes

Ships with PR #3775 (branch `fix/frontend-3421-flush-retry`); closes #3421, #3755 and #3784. Status stays `active` until the PR merges; the merge SHA is added when it flips to `stable`.

### What was built

- **Server:** `server/src/workspace/slice-revision.ts` (pure tokens and `staleFields`); `state.json.editEpoch`, minted by both import paths and rotated by re-parse, replace, Start fresh and backup restore; `GET /state` returns `sliceRevisions`; `PUT /state` takes an optional `baseRevision`, checks it inside each slice's existing lock span, answers `200 { revision }` and refuses a stale field with 409 `stale_revision` (fixed, path-free sentence). No new lock class.
- **Contract:** `openapi.yaml`, `src/lib/api-types.ts`, the hand-modelled `BookStateResponse` / `PutStateRequest`, `realPutBookState` / `mockPutBookState` parity.
- **Client:** a `known` map and a `kept` record (`{ patch, base, onSuccess? }`) in `persistence-middleware.ts` (**superseded by C1 and C7:** the `kept` record was replaced by a per-field outbox in 8149095a; see "Client rework (pass 7), shipped"); conditional re-sends; a stale refusal toasts, is not kept and not rolled back, and marks the book for a full re-read (set by the middleware, `onEditBook` and the language guard). The park/restore machinery (`parked`, `sending`, `pendingWipes`, `retainedGen`, `supersedeBookSaves`, `restoreSupersededSaves`, `wipeSettled`) was deleted in 8b9e64f3.

### Deviations from the plan as written

- **`GET /state` reads the state tokens via a fresh read** of `state.json` rather than from the `book.state` resolved earlier.
- **Start fresh always writes `state.json`**, so the epoch is always rotated.
- **`canonicalJson` is kept separate from user-settings' `canonicalStringify`.** The two differ on `undefined` by design, so the existing helper was not reused (the plan's "grep for an existing stable-stringify helper" found it and ruled it out).
- **The older-200 refresh skips kept-carrying sequences** (**superseded by C2/C4:** the refresh is deleted). D6's refresh of an in-flight sequence's base from an older same-key 200 does not touch a sequence whose patch has a kept patch merged in, which carries the kept base on purpose.
- **N6 and N7 are route-level tests** (`src/routes/index.test.tsx`), not middleware-level, because the sequences span the Library handlers and their wipe RPCs. Red at 5ec7178c, per the accepted acceptance adjustment.
- **`sliceRevisions` is optional in the TS `BookStateResponse`.**
- **The mock has no Start-fresh epoch rotation.** Only its re-parse and replace rotate it (`rotateMockEditEpoch`, `api.ts`); its import does not.
- **The changeLog lock (79fecfca).** The plan listed the unlocked analysis `changeLog.json` append under Out of scope. It is now fixed in this PR: the analysis carried-forward append and the re-parse append take the per-book `book` lock around their read -> write, and the slice PUT's changeLog check and write takes the same lock, so an append cannot land between the PUT's read and write. The lock order is unchanged.
- **Merged kept fields (f559c156, found in passing; superseded by C1, which makes it true by construction).** `confirmCast` and `commitDraft` replace each other's queued `state` patch, so a second `state` build in the same debounce window dropped the kept fields while the kept base still rode along. Every build now merges the kept patch the queued send carries, newer fields winning.

### Post-plan owner decisions (2026-10-25)

OD1–OD6 were all accepted as recommended (comment on #3784). Three more followed from Task 5 and from merging #3782:

1. **Queued `state` edits combine** (6c002345). `confirmCast` and `commitDraft` are merged instead of replacing each other; for each field the newest value wins, as on every other slice. This supersedes D1's note that they replace each other last-wins.
2. **A rolled-back save keeps the older edit it carried** (a304ae55). When a state save that carried a merged kept edit gives up and is rolled back while the book is open, only its own new edit is rolled back; the carried edit goes back into the kept slot with its base and is re-sent next time, and the server refuses it if the book has moved on.
3. **A book-meta save that finally fails after the user left the book is kept and re-sent,** not rolled back, whether the user is on the Library or in another book (f8871b1a, the merge of #3782 into this branch). The revision check refuses it if the book changed meanwhile. #3782's guarantees stay (a draft is never shown in another book; opening a different book clears the draft); its test (e) assertion on `saved.B` flipped to match.

The acceptance adjustment (N6 and N7 count as proved when red at 5ec7178c) was also confirmed by the owner.

All three still hold under the C rework; C1 makes 1 true by construction, and C6/C7 carry 2 and 3 (see the C finding map).

### Review pass 6 fixes (PR #3775, all #3784)

- **P6-1, 41b3290a:** a 4xx that refuses a book-details save after the user left the book reverts `saved` (draft not restored), as `main` did.
- **P6-2b, 69f188c7:** backup restore mints a fresh `editEpoch`, so a restored snapshot cannot bring an old epoch back (Invariant 4).
- **P6-2a / P6-5, 06e376f1:** a full re-read is marked after any direct state write that may have landed, including Account's Restore from backup, `onEditBook` and the language guard when the response is lost.
- **P6-3, 0cfd1010:** a stale refusal that a newer save superseded no longer forces a full re-read of the open book. (**Mechanism superseded by C9**, behaviour kept per field.)
- **P6-4, d193a1f4:** a superseded `state` save's uncovered fields (and a carried kept save) are kept, not dropped. (**Superseded by C1/C2**: no supersession exists; true by construction.)
- **06b48f76:** the uncovered fields of a superseded, refused `state` save are rolled back. (**Superseded by C6.**)
- **5c6cb6a1:** a kept save is merged under a queued one on resend. (**Superseded by C1.**)
- **6e936845:** the unobservable `onSuccess` pass-through is removed (M16); the matching `leaveBehind` fallback went in this round's follow-up. (**Superseded by C6.**)
- **P6-6, cfb9c94a:** the slice PUT's `manuscript-edits.json` check-then-write takes the `book` lock, and so do the other writers of that file: Start fresh's delete, both analysis persists, the interim edits rolls, the chapter restructure and the cast merge (pass 7 verified each, red with the lock removed). *Corrected 2026-10-28 (pass-10 C4): the chapter restructure and the cast merge were missing from this list.* *Corrected 2026-10-26: this note first said those writers do not take `book`, which cfb9c94a made false (pass 7).*

### Client rework (pass 7), shipped

Owner decision of 2026-10-26 (#3784, after review pass 7). OD-C1 to OD-C4 were all accepted as recommended. The server half is as built, except the 409 body.

- **T1, 0ee01f03:** a 409 `stale_revision` now answers `{ error, code, fields }`, field names only; `openapi.yaml`, `api-types.ts`, `realPutBookState`, `mockPutBookState` and the disk model surface `fields`.
- **T2, a82870bb:** `src/test/book-state-disk.ts` reaches server parity (replace on the whole-slice slices, 400 on a manuscript patch without `sentences`, `refuseNext`, `loseResponse`, `serve` with `hold` and `maxInTransit`), pinned by `src/test/book-state-disk.test.ts`.
- **T2, 8149095a:** the engine in `persistence-middleware.ts` is rewritten as a single-flight per-field outbox (C1 to C9). Deleted: `pending`, `toastPending`, `rollbackFields`, `generation`, `inFlight`, `kept`, `carriedKept`, `sequences`, `KeptSave`, `Sequence`, `mergeSaves`, `sendBase`, `resendRetained`, `leaveBehind`, `uncovered` and the older-200 refresh. Exports are unchanged.
- **T2 follow-up, a14b0727:** a stale refusal that drops nothing is final for the whole send (toast, mark for a full re-read, stop). See the deviations below.
- **T3, da7219d0:** the tests and comments that still named deleted mechanisms are re-titled, and new pins were added: a manuscript 409 naming only `sentences` drops the whole build, a plain edit keeps the bulk reassignment toast, a 409 with missing or empty `fields` drops the based unit only, and a 404 ends the flight with nothing kept. OD-C2 (b) no longer claims to be exactly R3's mechanism, because the mutation battery showed it alone does not reproduce it.
- **Size:** `persistence-middleware.ts` was **786 lines** at pass 7 (925 at 11a2509f, 511 on `main`), inside the 800 ceiling. Review pass 8 took it over; see below.

**Deviations and facts to know**

- **T2 did three T3 rows early.** The rows for "a superseded state send keeps a carried kept field" and "a superseded state send whose newer edit is still queued" (replaced by one coalesce test) and "a later edit that takes the left-behind field" (replaced by the R3 red-first test) were red under the new engine, so they were done in 8149095a rather than T3.
- **The tombstone pin is also red at head, for an interleaving reason.** "a sentence edit made while a merge is in flight keeps the tombstone in the follow-up (fs-58)" is red at head too, for an interleaving reason (overlapping sends), not only the whole-build rule.
- **The per-field `landedAt` pin cannot be red at head.** "a full read is ignored only for the fields a PUT landed on since it was stamped" cannot be made red against the old engine. It is pinned by mutation instead (the battery in T3).
- **The disk model logs `refused` and `lost` outcomes** (`refuseNext` and `loseResponse`), beside `ok`, `503`, `409`, `404` and `400`, so a test can assert the exact sequence of answers.
- **A stale refusal that drops nothing is final (a14b0727).** The server cannot produce one (it names only fields that had a base), but a mock or a future server could, and the engine would otherwise re-send the same send forever.
- **N8a is defence in depth.** The `POST /api/books` epoch mint has no observable effect: every import mints a fresh `manuscriptId` (`server/src/routes/import.ts:378`), and the tokens are salted with it. It is kept so every new book has an epoch.
- **The R3 choreography is pinned only by M8** (C3, "a live build carries no base"). No other mutation reproduces it.

### Review pass 8 fixes (PR #3775, all #3784)

- **P1, bbb9f733:** a marked book's `state` sends wait for the full read; held unbased book-meta entries are rebuilt from the typed draft at the read's hydrate (see C7). **Superseded by ae6bb325 (review pass 9): the hold was removed.**
- **P2, 7aa43755:** a based kept save is kept across a full read for the server to judge.
- **8a316704:** pins the P1 hold inside the send loop for a stale-refused retry.
- **P2 narrowed, fa0d78e2:** only `state` entries stay across a full read; based cast, manuscript and changeLog saves are dropped again (F1).
- **ca09d9ad:** the P1/P2 one-liners are unpacked into readable statements, with no behaviour change.
- **C1, d7977f75:** five outbox rules that survived mutation each get a test that goes red under its mutant; the persistent 4xx and 5xx mocks are capped.
- **Size, honestly:** `persistence-middleware.ts` is now **865 lines, over the plan's 800 hard stop.** It went over the cap because P1 and P2 added real logic. An earlier attempt that met the cap by compressing code into dense one-liners was reverted (ca09d9ad): gaming the cap defeats its purpose. The owner is told.

### Review pass 9 fixes (PR #3775, all #3784)

- **ae6bb325:** owner decision on #3784, from review pass 9: P1 becomes typed-fields-only saves, and P2 stays `state`-only (a based kept `state` entry survives a full read; based cast, manuscript and changeLog saves are still dropped).
  - **Reverted:** pass 8's P1 hold. bbb9f733 and 8a316704 (and the P1 half of ca09d9ad) are superseded. Removed: `holdForRead`, `waiting`, the hydrate-time release and re-commit, the drop's held-key skip, and the pre-action `lastCommitted` capture.
  - **Now:** a `bookMeta/commitDraft` sends only the fields typed since the last accepted save (the keys of `lastCommitted[bookId].draft`), not all eight `saved` fields. `markNeedsFullRead`'s `refused` pruning stays: it keeps a stale-refused field out of that set. This closes P9-1 (the release rebuilt held entries on the read's `saved`), P9-2 (a second mark while the read was in flight dropped held commits) and P9-3 (the unbounded hold replayed a live edit unbased after the user left and returned) by construction.
  - **Tests:** new P9-1, P9-2 and P9-3 pins, red at d80157b2; tests that asserted the eight-field send now assert the typed fields.
- **Size, honestly:** `persistence-middleware.ts` is **803 lines, 33 of them over 100 characters**, down from 865. It is 3 lines over the plan's 800 ceiling, and was not compressed to meet it.
- **Fuzz:** the fix agent's re-implementation of pass 9's model-based fuzz of the P1 window, oracles O1 to O4, gives 0 on each over 3,000 runs against this engine. Its O4 is not pass 9's: it fires 136 times on f2a41423 and 135 on d80157b2, where pass 9's fired 0 and 5. Review pass 10 ran its own harness as well. It reported O4b 1 and O5 2 at head, all three by D6's design (seeds 71, 271 and 1588), so what it confirmed was the fix agent's harness's zero, not a zero of its own. *Corrected 2026-10-28 (pass-10 C2): this bullet first called it the reviewer's fuzz. Corrected 2026-10-29 (pass-11 C3): it said pass 10 "confirmed the zero at head".*
- **Routed to #3827:** a field the user typed that already landed can be sent again by a later commit while it is still in `lastCommitted.draft`. Whether to prune `lastCommitted` per field is the open question on #3827; it is not changed here.
- **Corrections to earlier text (pass-9 C1):** C-I9 said the exports are unchanged, but `dropRetainedSaves` gained `onFullRead`; and "Layout retries the read until it lands" holds only while the book stays open. Both are fixed above. The two code comments that called P2's kept entry a "book-details field" (its case is `castConfirmed`) were already reworded in ae6bb325.

### Review pass 10 fixes (PR #3775, all #3784)

- **PB, 4698f107:** owner decision on #3784 (2026-10-28): a full re-read of the book the user is editing keeps the details draft and refreshes only `saved` (C7, C8, C-I10). Before, any mark on the open book triggered a full read whose hydrate set `draft = null`, so uncommitted typing was lost after a stale 409, and a draft a rollback had just restored was wiped by the re-read the 409 asked for (#2230, #3754).
  - **`lastCommitted`** is still cleared by every hydrate. Its `saved` baseline predates the read, so keeping it would let a rollback revert the outside write. The kept draft is either unsaved typing or a rollback's restore, which already excludes `refused` fields, so the next commit's typed-fields set is its keys and the prune still composes.
  - **#3782 holds:** the draft is cleared on a switch to another book by the middleware, as before, and the first full read after opening another book still wipes it. *(Superseded by review pass 11: that first read now keeps the draft. See "Review pass 11 fixes".)*
  - **D7 holds:** the read still writes every field into `saved`, so the outside write shows on each field the user is not editing; a field in the draft shows the user's typing (`selectEffectiveMeta`), and the outside value is in `saved` underneath it.
  - **Tests:** Layout PB-1 (uncommitted notes, and the outside title in `saved`), PB-2 (a rollback-restored draft), PB-3 (a field in the draft and changed outside) and PB-5 (typing kept across a library trip survives a Library Edit's read) are red without the fix; PB-4 (opening another book clears the draft) and a slice test without `keepDraft` are controls. Two slice tests pin `keepDraft`.
  - **Mutants:** 17 over a 347-test baseline, files restored byte-for-byte. M8 (prune every typed field on any stale refusal), which survived all 340 tests at aa2366ca because the restored draft was wiped, is now red (PB-2). Ignoring `keepDraft` in the slice: 5 red; Layout always `false`: 4; the ref never set: 4; the ref reset on a book change: 1 (PB-5). Layout always `true` survived. *Corrected 2026-10-29 (pass-11 C1): this bullet called the ref defence in depth because of that, which was false. Always `true` kept typing made before a reopened book's first full read, which head wiped, and no test covered that path. Under pass 11's rule, keeping it is the intended behaviour, and the always-`true` mutant is now caught by the re-import pins (P11-1).* M10 survives as before (equivalent). M1–M7, M9, M11 and M12 stay red.
- **Text (pass-10 C1–C4):** the Layout P1 test's comment and title (it no longer waits for the read); the fuzz attribution in "Review pass 9 fixes"; the `manuscript-edits.json` writer list in "Review pass 6 fixes"; and the PR body.
- **Catalogue:** entry 54 in the reviewer brief (a resync read wipes client-only state it cannot restore).

### Review pass 11 fixes (PR #3775, all #3784)

These are the owner decisions on #3784 (2026-10-29), from review pass 11 (https://github.com/dudarenok-maker/Castwright/pull/3775#issuecomment-6464372461).

- **P11-1, e106d9ca:** a book deleted and re-imported under the same id no longer inherits the old book's details draft.
  - The same-book check keys on the manuscript id as well as the book id: a book id is a slug, and every import mints a new `manuscriptId`.
  - Re-parse and replace keep the manuscript id, so they still count as the same book.
  - **Tests:** Layout P11-1 (pass 11's R2: delete, re-import under the same id, open; the draft is null and Save writes none of the old text), red at 95e96a62. Controls: a re-parse on the client, and server pins in `book-state.reparse` and `book-state.replace-manuscript` that both keep `manuscriptId`.
- **P11-2, 96315e01:** a same-book read keeps a pending commit's `lastCommitted` snapshot and rebases its `saved` onto the read, instead of deleting it.
  - A failed save after the read still restores the typing. Its rollback reverts to the read's values, keeping the outside write.
  - The send is still exactly the snapshot's typed fields.
  - **Tests:** Layout P11-2 (pass 11's R5, with an outside rename brought by the read: the PUT carries only `{ notes }`, the draft is restored, and `saved` keeps the read's title), red at 95e96a62. The slice test that pinned the deletion ("…and clears the stale snapshot") is rewritten to pin the rebase and its rollback.
- **First read keeps the typing, 34a432cf:** any full read of the open book keeps a draft that belongs to it, the first read after opening included. This replaces "the first hydrate behaves as today".
  - Layout's `metaReadFor` becomes a per-book map of the manuscript each book was last read from. A read keeps the draft unless that book was last read from a different manuscript.
  - **The ref stays.** Nothing else records which manuscript `saved` was read from: the manuscript slice's id can already name an upload in progress.
  - It is per book rather than "the last read", so a visit whose read never landed cannot hide a re-import made in another tab.
  - **Tests:** two P11-3 pins, both red at 96315e01: pass 11's R1 (typing between reopening a book from another book and its first full read), and typing on the library-seeded `saved` before a book's first full read of the session. A further P11-1 pin covers the failed-read visit.
- **Mutants:** 8, over a green 356-test baseline, each file restored byte-for-byte (sha checked). Every one is red:

  | Mutant | Red |
  |---|---|
  | always `keepDraft: true` (pass 11's survivor) | 2 (both P11-1 re-import pins) |
  | keyed on the book only | 3 (both P11-1 re-import pins, and the first-read-of-the-session P11-3) |
  | the manuscript ignored | 2 |
  | the map reduced to the last read | 1 (the failed-read P11-1) |
  | a book's first read of the session wipes | 1 (P11-3) |
  | the snapshot deleted, as before | 2 (P11-2 and the slice rebase test) |
  | the snapshot kept but not rebased | 2 |
  | the snapshot kept on a re-import | 1 (the slice's "clears the stale snapshot for the refreshed book") |

- **Fuzz:** pass 11's harness, with Layout's new keep rule and its D3 oracle (a rollback that finds no snapshot) restored, over 3,000 runs. At head: D1, D2 and D3 are 0, and O4b 1 and O5 2 are D6's by-design hits on seeds 71, 271 and 1588. The positive controls fire: `keepDraft` off gives D1 2,094; no `refused` prune (M2) gives D2 13; the snapshot deleted as before gives D3 21, pass 11's head figure on the same seeds.
- **Text (pass-11 C1–C3):** the "defence in depth" note in "Review pass 10 fixes" and the PR body; the catalogue cites in the finding map and the task breakdown (now 48 and 49, after the renumbering); and the pass-10 fuzz claim in "Review pass 9 fixes".
- **Catalogue (C4):** entry 54 is widened to the pending commit snapshot. Entry 55 is added: an identity check keyed on an id the system reuses after a delete and re-create.

### Not owed

No on-box acceptance and no e2e (see the Test plan).
