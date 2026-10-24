---
status: draft
shipped: null
owner: null
---

# 289 — Book-state revision precondition: a stale save is refused, not replayed (srv-97, #3784)

> Status: draft (design of record; owner decisions OD1–OD6 below are open)
> Key files: `server/src/routes/book-state.ts` (`PUT` / `GET /:bookId/state`, `applyReparse`), new `server/src/workspace/slice-revision.ts`, `server/src/routes/import.ts`, `server/src/import/scan-import-folder.ts`, `server/src/routes/analysis.ts` (Start fresh), `openapi.yaml`, `src/lib/types.ts`, `src/lib/api.ts`, `src/store/persistence-middleware.ts`, `src/components/layout.tsx`, `src/routes/index.tsx`, `src/hooks/use-language-guard.tsx`
> URL surface: indirect (the book-open hydrate and every autosave)
> OpenAPI ops: `GET /api/books/{bookId}/state`, `PUT /api/books/{bookId}/state`

Blocks PR #3775 (#3421 / #3755). Lands on that PR's branch, `fix/frontend-3421-flush-retry`.

## Benefit / Rationale

- **User:** a save that failed and is re-sent later can no longer undo a newer change made elsewhere. That covers the Library Edit dialog, a series-wide voice override, another tab, a re-parse, and a re-import. When the server refuses a stale save, the user is told, and the book is re-read so the screen shows what is actually on disk. (N5 is a regression against `main`: a renamed book is silently renamed back, folder included.)
- **Technical:** the server, which sees every writer, decides whether a re-sent save is still valid. Five review passes on #3775 showed the client cannot decide this. Most of #3775's park/restore bookkeeping goes.
- **Architectural:** one compare-and-swap at one seam (`PUT /state`), evaluated inside the existing lock spans. No new lock. The tokens are derived from content, plus a per-book *edit epoch* that only the wiping writers rotate.

## The problem

A kept save is a whole-slice snapshot, re-sent at an arbitrary later time. Whether it is still owed depends on two things the client cannot see:

- writes the middleware never routes: `onEditBook` and the language-guard modal call `api.putBookState` directly, `POST …/voice-override-linked` writes other books' `cast.json` on the server, and other tabs write too;
- server outcomes the client cannot learn: a `DELETE` that removed the folder and then answered 500, or a response that was lost.

The full argument is in pass 5 (PR #3775, comment 6389974661).

## Decisions

Decisions with more than one defensible outcome that the owner has a stake in are marked **OD** and carry a recommendation. Nothing is implemented until they are answered.

### D1 — Granularity — OD1

- **(a) Recommended: per top-level field within each file.** A `SliceRevision` is a map from field to token:
  - `state`: one token per editorial field `PUT /state` can write. `chapters` and `updatedAt` are excluded.
  - `cast`: one token, `characters`.
  - `manuscript`: two tokens, `sentences` and `mergedAwayKeys`.
  - `changeLog`: one token, `events`.

  A conditional write is **stale** if any field it carries meets three conditions: its base token is present, the base differs from the current token, and the server's *post-merge* value for the field (D5 no-op rule) differs from its current value. A stale write is refused whole.
- **(b) One token per file.** Then a direct client write such as a prosody flag (`layout.tsx` ~`:1422`/`:1459`), the language guard, or Start fresh's `castConfirmed` reset refuses a kept rename that shares no field with it.
- **(c) Per character for `cast`.** This option is offered, not recommended. A single `characters` token means a background `cast.json` writer refuses any concurrent retry of a roster edit. That writer can be an analysis interim snapshot, a voice-library assign, or a design job, none of which has a mirror persist. Per-character tokens would narrow that to edits of the same character, at the cost of a per-character compare in the cast pipeline. How often this collision happens is unmeasured.
- **Why (a):** the issue's "disjoint fields don't refuse each other" holds for `state` at no client cost, because the client echoes the map back opaquely. Inside the middleware, `confirmCast` and `commitDraft` share one key but **replace** each other's pending patch last-wins (`persistence-middleware.ts` ~`:737`, comment ~`:745-754`). They only merge with a *kept* patch. So overlapping sequences with disjoint fields happen in-process too, and per-field tokens matter there as well.

### D2 — What a 409 `stale_revision` means to the client — OD2

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
- **rotated** inside each writer's existing `state.json` write by re-parse, replace-manuscript and Start fresh.
- **not touched by any other writer.** Every token is salted with it, so a wipe invalidates every kept or retrying save of the book.

| Writer | Effect |
|---|---|
| Library Edit / language guard (the same `PUT`) | Moves the fields it changes, so N5's kept `commitDraft` is refused. |
| `voice-override-linked` | Moves the member books' `characters`, so a kept roster is refused. |
| Chapter restructure | Moves `sentences`; `state` tokens are unchanged (`chapters` is excluded). |
| Re-parse, replace, Start fresh | Rotate `editEpoch`, so **every** token moves. |
| Delete then re-import, by either import path | New epoch, so every token moves. That covers N8, including a base on an absent file and a bundle carrying the old `manuscriptId`. |
| Snapshot restore (`POST /backups/restore`) | Moves the fields it changes. It does not rotate the epoch (ABA residual, D4). |
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

The **analysis `changeLog.json` append is unlocked** (`analysis.ts` ~`:528`) and races the slice PUT. That race exists today and is not widened here. It is reported separately.

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

  `BookStateResponse` is hand-modelled (`src/lib/types.ts` ~`:441`, `openapi.yaml` ~`:4033`), so add `sliceRevisions` there as well as in the schema.
- **`PUT` body adds an optional `baseRevision: SliceRevision`.** If it is absent, the write is unconditional: today's behaviour, which also serves an old tab and a write with no known base.
- **No-op rule.** The value compared for each field is the server's **post-merge, post-transform** value:
  - `state`: the `buildNext(fresh)` output;
  - `cast`: the output of `preserveDesignedVoices → denormaliseCastReusedVoices → stripDerivedCharacterFields`, i.e. exactly what would be written;
  - `manuscript`: the parsed patch;
  - `changeLog`: the patch.

  That value is compared with the current on-disk value. If they are equal, the field is never stale. So a retry after a lost response returns 200, never a false refusal.
- **`PUT` success changes `204` → `200 { revision: SliceRevision }`.** The value is the slice's map after the write, or the current map after a no-op. Every existing server test that asserts `204` is updated.
- **409 `code: 'stale_revision'`** is added to the PUT's 409 enum. Its `error` is a fixed, path-free sentence. The check runs after the 400s and the 404, and before the consent, empty-manuscript and path-taken 409s, with `book_busy` excepted (D3). Nothing is written.
- **Mock parity.** `mockGetBookState` returns `sliceRevisions`, and `mockPutBookState` applies the same rule and returns the same shape. Mock tokens are `JSON.stringify` of the values plus the salt; they are opaque, so the mock need not hash. `editEpoch` is rotated by the mock's own reparse/replace/import. On refusal the mock throws `Book state PUT failed (409): …` with `code`.
- **`realPutBookState`** sends `baseRevision` only when it is given. It returns `{ revision }`, and the thrown error carries `code` (`Object.assign`, matching `realDeleteBook`).

### D6 — Which sends carry a base, and which base — OD3

- **(a) Recommended: every send that re-sends a write which already failed once,** and nothing else:
  - every retry (attempts 1–3);
  - every replay of a kept save;
  - a **live build that a kept patch was merged into** (`persistence-middleware.ts` ~`:735-737`). That send carries the *kept* base, because otherwise the merge would smuggle the kept fields past the check.

  A plain attempt 0 carries no base. That is `main`'s last-writer-wins for a live edit built from the current screen.
- **What the base is.** It is `known[book:slice]` as it stands when the sequence's first attempt is made. A kept record stores its base. Two rules keep the base from being older than the client's own writes:
  - When a `PUT` of the same key lands with generation `g`, its returned revision replaces the base of every **in-flight sequence with a generation above `g`.** Their patches were built after `g`'s and already include it. That also covers overlapping same-key sequences (the #2230 case).
  - `known` is updated from every middleware `PUT` 200, and from **full** Layout reads only. Each full read stamps its read sequence, and a learn that was issued before the latest `PUT` 200 for the key is ignored.
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
- **F1 stays:** `dropRetainedSaves(bookId)` on a **full** read still drops kept saves, because the user has now seen disk. Revisions-only reads do not drop.

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

`retained` + `retainedOnSuccess` + `retainedGen` collapse into one map: `kept: Map<FlushKey, { patch, base, onSuccess? }>`.

**Why the supersede can go.** It existed so that a retry could not put the pre-wipe roster into a wiped book. Every retry now carries a base, and every wipe rotates `editEpoch`. So that retry is refused by the server, whichever side of the wipe it lands on, because `book-op` serialises the two.

**Stays:**

- retries at +1/+2/+4 s, with a 4xx final;
- the give-up toast, named by `savedTitleOf`, for retried network/5xx failures, plus D2;
- `flushBookPersistence` / `BookFlushOutcome`, and Layout's flush-before-re-read;
- #3755's restructure abort;
- `resendRetained`, now reading `kept`;
- the #2230 `generation` gate and `toastPending`;
- `dropRetainedSaves` on full reads (D7).

#### D8a — `onSuccess` rides in the kept record — OD5

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
4. Tokens are made only by `slice-revision.ts`, salted with `manuscriptId` and `editEpoch`. Only import (both paths), re-parse, replace and Start fresh write `editEpoch`.
5. A plain attempt 0 carries no base. A retry, a replay, and a live build with a merged kept patch carry the base of the write they re-send (D6).
6. A stale refusal is never kept, never re-sent and never rolled back. It toasts and marks the book for a full read (D2/D7).
7. Revisions-only reads neither update `known` nor drop kept saves.
8. `persistence-middleware.ts` holds no `parked`, `sending`, `pendingWipes`, `retainedGen` or `retainedOnSuccess`, and exports no `supersedeBookSaves` / `restoreSupersededSaves`.

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
- **D6:**
  - attempt 0 carries no base;
  - attempts 1–3 and replays carry the captured or kept base;
  - a live build with a kept patch merged in carries the kept base;
  - an older same-key 200 refreshes the newer in-flight sequence's base;
  - a revisions-only read does not update `known`;
  - an out-of-order learn is ignored.
- **D2:** a stale refusal on a retry and on a replay each toasts once, does not roll back, is not kept, and marks the book. If the book is open, Layout re-reads it.
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
   - The `kept` record (D8a per OD5).
   - Base capture and refresh, including the merge case (D6).
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
- **#5 — overlapping same-key sequences.** An older sequence's 200 refreshes the base of newer in-flight sequences (D6).
- **#6 — a kept patch merged into a live build bypassed the check.** That send now carries the kept base (D6, Invariant 5).
- **#7 — a silent drop on replay leaves redux showing a refused edit.** D2 is now one loud rule plus a re-read.
- **#9 — replace keeps `manuscriptId`, and the bundle import keeps the bundle's.** Identity now comes from `editEpoch`, minted by both import paths.
- **#11 — `book_busy` precedes the check on the moving branch,** and the resolve-time `projected` must not run it. Stated in the D3 table.
- **#12 — `confirmCast` and `commitDraft` replace rather than merge.** D1's reasoning is corrected.
- **#16 — the voice-override test must use a designed slot and assert `code`.**
- **#18 — `BookStateResponse` is hand-modelled.**
- **Gaps:**
  - the rollback-to-a-stale-baseline problem: no rollback on a stale refusal;
  - the GET-vs-PUT ordering of `known`: a learn sequence;
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

- The unlocked analysis append to `changeLog.json` (`analysis.ts` ~`:528`), which races the slice PUT. It predates this plan, needs a lock decision, and is reported separately.
- Conditional live first attempts, and endpoints returning tokens (D6(b)).
- A conflict-choice UI (D2(b)).
- Cross-tab sync beyond `broadcast-middleware.ts`.

## Ship notes

(Filled in when status flips to `stable`.)
