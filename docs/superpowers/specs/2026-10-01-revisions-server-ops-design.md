---
status: draft
revision: 3 (narrowed by the operator after two assumption-checker passes, 2026-10-02)
issues: "#3400, #3397"
supersedes-client-guards-from: "#3376 / PR #3395 (merged 9f379fb6)"
---

# revisions.json becomes server-owned: per-operation writes

## Problem

`<bookDir>/.audiobook/revisions.json` holds four things: pending A/B takes, dismissed drift, accepted segment selections, and the Revision History timeline. Today the client writes it as a **whole-file replace**. The persistence middleware PUTs the entire slice through nine `revisions/*` rules built by `revisionsPatch` (`src/store/persistence-middleware.ts:231-251`). The server then writes it with no lock and no validation (`server/src/routes/book-state.ts:789-790`).

Any stale client state therefore erases disk. PR #3395 (#3376) added client guards over six review passes, and each one closed one ordering and opened another (#3400).

Pending entries are also **client-created and active-book-only** (#3397):
- **Stuck:** a Fix-audio entry is enqueued as `playable:false`, and it never flips if the user leaves the book first.
- **Lost:** a splice that runs entirely while its book is not active never gets an entry at all.

### Defects fixed in this deliverable

| | Defect | Evidence |
|---|---|---|
| D1 | Accept/reject are not atomic: the slice action persists *before* the audio call, so a 409 on restore leaves the timeline saying "rejected". | `layout.tsx` ~2485-2568 |
| D2 | Reject deletes the live take before renaming `.previous` into place. A failed restore followed by Approve leaves the chapter with **no audio**. | `chapter-audio.ts:420-438` |
| D5 | Reject checks only the book-wide `isGenerationActive`; accept checks nothing. Neither guards against a job starting mid-op. | `chapter-audio.ts:374-441` |
| D6 | The A/B player opens `pending[0]`, not the entry the user came for. A leftover entry can become the preview player, and approving it skips the preview fan-out. | `layout.tsx:2474-2479,2509` |
| D7 | `mockPollRevisions` returns the canned fixture for every book, ignoring `MOCK_BOOK_STATES`. | `src/lib/api.ts:1931-1973` |
| D8 | `computeRevisionsForBook` returns `pending: []` whenever the cast is empty. | `server/src/routes/revisions.ts:132-135` |

### Filed separately, each naming its owed decision (not in this deliverable)

- **Full take restore on reject.** Reject currently restores audio + segments only. `state.json` take fields, loudness, peaks and embeddings still describe the rejected take. The owed decisions:
  - which fields belong to a take;
  - where finalize captures them (the live lufs is written *before* preserve runs, `finalize-chapter-write.ts:210` vs `:359`);
  - how `state.json` gets locked. Today it has unlocked whole-file writers in finalize, `book-state.ts` and generation's failure stamp.
- **A stalled or displaced generation body keeps finalizing after it deregisters.** `Promise.race` at `generation.ts` ~2077-2084; finalize takes no abort signal. The owed decision: an abort signal threaded into finalize, versus a drain-before-deregister.
- **Reparse/replace racing in-flight jobs.** `abortInFlightSplice(bookId, null)` is a no-op (`chapter-job-coordination.ts:40`), and abort is not drain. The owed decision: refuse a reparse while jobs run, or abort-and-await.
- **`.previous` is always named `.previous.mp3`.** The A-side routes are mp3-only. The owed decision: extension-aware naming, including the migration of legacy m4a/ogg pairs.

### Dispatched now as an independent fix agent (no design needed)

- **Boot fsck destroys valid m4a/ogg A/B pairs.** Its "orphan `.previous`" rule tests the literal `<slug>.mp3` (`fsck-orphan-audio.ts:80-91`), so it promotes `.previous.mp3` over a live `.m4a`/`.ogg` on every boot. The fix: promote only when **no live audio of any extension** exists. It ships as its own branch, PR and issue, ahead of this deliverable.

## Decisions

Recorded by the operator on #3400/#3397 and in session, 2026-10-01/02:

1. Server-side per-operation writes; the client never writes revisions.json.
2. Server-derived pending, for every source (Fix-audio splice and profile-regen preview).
3. Accept/reject are single atomic server operations covering the audio step and the JSON write.
4. One route per operation.
5. #3395's client guard machinery is deleted from `main`.
6. **Narrow scope:** reject keeps today's restore fidelity (audio + segments). Everything else is filed as listed above.
7. **Two PRs.** PR 1 is server, shipped dark; PR 2 is the client cutover (see Delivery).

## Design

### 1. The store

All reads and writes of revisions.json go through `server/src/workspace/revisions-store.ts`, modelled on `script-review-ledger.ts`.

**Writes** run under `withKeyLock(\`revisions:${bookDir}\`)` (`file-lock.ts:218`). The read, and every decision derived from it, sits inside the lock.

This is a **leaf lock**. That was verified: no generation, splice, QA-repair, finalize or chapter-audio code holds a cast/design/library-voice lock, and the reparse wipe's revisions branch is a sibling of its `withCastLock` branch rather than nested inside it (`book-state.ts:1132-1204`). Add the rule to `cast-lock.ts:11-24` **and** to CLAUDE.md's matching rule 4.

**Reads** (`readRevisions`) take no lock. A `writeJsonAtomic` rename is atomic, so a reader sees either the old file or the new one. That keeps the GET handlers free of lock-timeout errors, so they need no new `requestFailureMessage` sites.

**File shape**, `schema: 1`:
```ts
{ schema: 1,
  fileId: string,        // random id minted when the file is created; a reparse/replace delete + recreate yields a new one
  rev: number,           // +1 on every write within one fileId
  pending: Revision[],   // ≤1 entry per chapterId
  dismissed: string[],
  acceptedSelections: Record<revisionId, Record<segmentIndex, 'A'|'B'>>,
  timeline: Record<chapterId, TimelineEntry[]> }
```

**Server-recorded `Revision` entries** carry two extra fields:
- `origin: 'server'`;
- `newTake: { size: number; mtimeMs: number }`: the `fs.stat` of the live chapter audio, taken right after finalize wrote it.

Legacy entries (client-written) have neither field. Identification is by these fields, never by parsing the id.

**Normalisation on read** (never writes):
- drop the legacy `drift` copy;
- default any missing field (a legacy file without `fileId` gets a deterministic `fileId = 'legacy'`);
- legacy entries:
  - drop those with `playable:false`;
  - keep those with `playable:true` only if the chapter's `.previous.mp3` exists;
  - if several are left for one chapter, keep the last.

### 2. Per-chapter reservation (`server/src/routes/chapter-job-coordination.ts`)

This file stays import-free. It gains:

- `reserveChapter(bookId, chapterId): Reservation | null`. It returns `null` if the chapter is busy or already reserved. **Busy** means any of:
  - `inFlightSplices` has the chapter (this covers Fix-audio and QA repair, which calls `registerSplice`, `chapter-qa-repair.ts:299-300`);
  - generation has `${bookId}::${chapterId}` or `${bookId}::*`.

  Generation is read through a registered accessor, `registerGenerationChapterProbe(fn)`, set by `generation.ts` at module init. It fails **closed** (busy) while unset. This follows CLAUDE.md's leaf-gate pattern, so no madge cycle appears and `npm run check:cycles` stays clean with no allowlist entry.
- `release()`, on the returned reservation.
- `awaitChapterFree(bookId, chapterId, timeoutMs = 10_000)`.
  - `registerSplice` callers and generation's `registerJob` (`generation.ts:526`) **await this before registering**, so a job that starts during an op waits a few seconds instead of reading files mid-rename.
  - A book-wide `::*` generation job awaits every reservation held on that book (`awaitChapterFree(bookId, null)`).
  - On timeout the job fails with a curated "chapter is busy" error (no path).
  - Ops hold a reservation for well under a second in the normal case.

The reservation only makes ops and **newly starting** jobs mutually exclusive. A stalled or displaced generation body that is still finalizing is not covered; that's the filed issue above.

### 3. HTTP contract

**Every op returns `200 RevisionsState`**: `{ bookId, fileId, rev, pending, dismissed, acceptedSelections, timeline }`.

**`POST /api/books/{bookId}/revisions/{revisionId}/accept`**, body `{ selection?: Record<segmentIndex,'A'|'B'> }`

1. **Under the lock:** read the entry.
   - If it's absent and the timeline has `accepted` for this id → 200 with the current state (idempotent).
   - If it's absent otherwise → 404 `revision_not_found`.
2. **Under the lock:** `reserveChapter` → `null` → 409 `chapter_busy`.
3. **Outside the lock, holding the reservation:** classify the disk state of the live audio `L` (found via `findChapterAudio`) and `.previous.mp3` `P`:
   - `L` is missing → 409 `live_audio_missing`. Nothing changes; this stops the last-copy loss (D2).
   - The entry has `newTake` and `stat(L)` ≠ `newTake` → 409 `revision_stale`, and the entry is dropped in step 4. A newer render replaced this take; its `.previous` is no longer this entry's A side.
   - Otherwise delete `P` and `.previous.segments.json`. If they're missing, the accept already happened.
4. **Under the lock:** re-read. Remove the entry, set `acceptedSelections` (when `selection` is given), and append the timeline entry `accepted`, keeping the reversible-chain rule from `appendTimelineEntryHelper`. Write once, `rev + 1`. Release the reservation in `finally`.

**`POST …/{revisionId}/reject`**

Steps 1, 2 and 4 are the same as accept (step 4 appends `rejected`). Step 3:
- `L` is missing → 409 `live_audio_missing`.
- `P` is present:
  - The entry has `newTake` and `stat(L)` ≠ `newTake` → 409 `revision_stale` and drop the entry.
  - Otherwise restore, **with no moment without live audio**:
    1. Rename `.previous.segments.json` → `segments.json`.
    2. Rename `P` → `<slug>.mp3`. This is a rename *over* the existing file: `renameWithRetry`, `atomic-rename.ts:45`, replaces a closed target, as `writeJsonAtomic` does every day.
    3. Only then, if the live file was `<slug>.<other ext>`, delete it. `findChapterAudio` probes mp3 first (`chapter-audio-file.ts:37-41`), so the restored file is served as soon as step 2 completes.

    A failure in step 1 or 2 returns 500, and the live take is still present. A failed segments rename is **not** swallowed, unlike today.
- `P` is absent:
  - The entry has `newTake` and `stat(L)` ≠ `newTake` → **the restore already happened** (a retry after a failed step 4). Go to step 4.
  - The entry has `newTake` and `stat(L)` = `newTake` → 409 `no_previous_audio`.
  - A legacy entry → 409 `no_previous_audio`.

  The UI offers **Keep new take** (accept) on `no_previous_audio`.

The fingerprint is valid across a restore because `rename` on one volume preserves `mtime`, so a restored old take never matches the new take's fingerprint. A unit test pins this on the CI OS and on Windows.

**`POST /api/books/{bookId}/drift/{driftId}/dismiss`** adds the id to `dismissed` (idempotent) and returns `{ bookId, fileId, rev, dismissed }`.

**Polls**
- `GET /api/books/{bookId}/revisions` (active-book poll) returns `RevisionsState` plus live `drift`.
- `GET /api/revisions` (bulk) returns `{byBookId:{[id]:{pending, drift}}}` with pending now read through the store.
- `computeRevisionsForBook` (`revisions.ts:125`) changes shape for all three callers, including `server/src/routes/qa-report.ts:13,30`. It returns pending even when the cast is empty (D8).

**Errors**
- 404: unknown book, `revision_not_found`.
- 400: malformed `selection` (non-integer keys, values outside A/B, dangerous keys as in `script-review-ledger.ts:46-52`).
- 409: `chapter_busy`, `live_audio_missing`, `revision_stale`, `no_previous_audio`.
- 500: through `requestFailureMessage` (`file-lock.ts:214`).

CLAUDE.md's "`git grep requestFailureMessage` enumerates all thirteen sites" sentence is updated for the three new sites.

**OpenAPI** (then `npm run openapi:types`):
- the three routes;
- `RevisionsState` and `DriftDismissResponse`;
- the 409 codes;
- `Revision` gains optional `origin` and `newTake`;
- `BookStateResponse.revisions` gains `timeline`, `fileId` and `rev`;
- `RevisionsResponse` takes the poll's new shape;
- the bulk response's description.

### 4. Server-derived pending

`FinalizeChapterAudioInput` (`server/src/audio/finalize-chapter-write.ts`) gains:
```ts
review?: { characterId: string; triggeredBy: string } | null
```

It has three states:

| Value | Meaning |
|---|---|
| `undefined` | Finalize does not touch revisions.json. This is the **PR 1 dark state**, and what every caller passes until PR 2. |
| `null` | A plain render. If the chapter has a pending entry, drop it: its A side was just overwritten. |
| an object | A review render. If `preserveExistingAsPrevious` actually preserved (`PreserveResult.preserved`, currently discarded at `:359`), upsert the chapter's single entry. Otherwise (a first render) drop any entry. |

`preserved` becomes true only if **both** the audio and the segments renamed. Today it reports true even when the segments rename failed.

The upserted entry contains:
- `playable: true`, `hasPreviousAudio: true`;
- `origin: 'server'`;
- `newTake` (a stat of the live audio taken after it is written);
- id `revision:<chapterId>:<epoch ms>`;
- `triggeredBy`, and the old/new durations.

**Failure is best-effort with respect to the render.** The store call is wrapped inside finalize. Any error is logged in full and surfaces only as `reviewRecorded: false` on `FinalizeChapterAudioResult`, and from there on the three SSE completion events (`splice_complete`, generation's `chapter_complete`, QA repair's completion).
- No store error message ever reaches an SSE body. That closes the lock-key-path leak through `chapter-splice.ts:524-525`'s `fail(…message)` and its siblings.
- A failed upsert can leave an older entry in place against an overwritten `.previous`. That entry's `newTake` no longer matches the live audio, so accept/reject answer `revision_stale` instead of comparing the wrong pair.

**Callers in PR 2** (PR 1 leaves them all at `undefined`):
- `chapter-splice.ts:492` always passes `review`. Its "Loudness fix…" / "Re-record…" text moves server-side from `splice-runner-middleware.ts:55-67`.
- `chapter-qa-repair.ts:720` passes `null`.
- `generation.ts:1861` passes the job's `review`, or `null` if the job has none.

**Plumbing `review` through generation** (the code lands in PR 1, the behaviour switches on in PR 2):
- It travels on the **persisted queue entry**:
  - `src/store/queue-thunks.ts` `enqueueQueueEntries`;
  - `POST /api/queue/enqueue`, whose field whitelist must add it (`server/src/routes/queue.ts:107-118`);
  - `enqueue()`'s whitelist (`server/src/workspace/queue-io.ts:122-139`), plus `QueueEntry`/`EnqueueInput` and OpenAPI `QueueEntry`;
  - the claim in `queue-dispatcher-middleware.ts:225-276`;
  - the `runner.open` spec (`generation-stream-runner.ts`) and `StreamArgs` (`api.ts:603`);
  - `GenerationRequestBody` and `RunningJob`;
  - finalize.
- The server returns **400** for a `review` whose request does not name exactly one chapter.
- A server test round-trips `review` through enqueue → claim → generation request, so a whitelist drop fails CI.

### 5. Client (PR 2)

**API (`src/lib/api.ts`)**
- Add `acceptRevision`, `rejectRevision` and `dismissDrift`, each with a real and a mock implementation. The mocks apply the store's rules to `MOCK_BOOK_STATES` (`api.ts:917`), including the 409s, `fileId`/`rev` and `newTake`.
- The mock fixture's seeded entry (`src/data/revisions.ts`) becomes a server-shaped entry (`origin:'server'`, `newTake`).
- `mockPollRevisions` reads `MOCK_BOOK_STATES` (D7).
- `mockStreamSplice` records pending as finalize does, takes `bookId`, and accepts a test-controllable delay.
- Remove `acceptChapterRevision` / `rejectChapterRevision`.

**Revisions slice (`src/store/revisions-slice.ts`) becomes a cache.**

State: `pending`, `drift`, `dismissed`, `acceptedSelections`, `timeline`, `loaded`, `bookId`, `fileId`, `rev`.

Writers:
- `hydrate({bookId, state})` adopts the book unconditionally.
- `applyServerState(...)` and `applyPoll(...)` are ignored when the `bookId` differs. When the `fileId` differs they adopt (the file was recreated). Within the same `fileId` they are ignored when `state.rev < cache.rev`. So a poll that started before an op can't bring back the accepted entry, and a reparse that resets `rev` doesn't lock the cache out.
- `applyDismiss({bookId, rev, dismissed})` works across books. It removes that book's dismissed events from `s.drift` whatever book the cache holds, and updates `dismissed`/`rev` only when the book matches.
- `applyBackgroundPoll` is unchanged.

**Delete:**
- `hydratedFor`, `windowActions`, `recordIfUnhydrated`, `replayRecorded`;
- `bookScopeChanged`, `bookWiped`, `persistPendingAfterHydrateMerge`;
- `enqueuePending`, `markRevisionPlayable`;
- the reducer halves of `acceptRevision`/`rejectRevision`/`dismissDrift`;
- `acceptAllPending`, `rejectAllPending`, `rolledBack`;
- `src/store/revisions-scope-middleware.ts` and its wiring in `src/store/index.ts`;
- `buildPendingRevisionStub` (`src/lib/build-pending-revision.ts`), once the generation-stream middleware stops using it (below).

**Dispatch sites of deleted actions, updated in the same task as the deletion:**

| Site | Change |
|---|---|
| `src/routes/index.tsx:155,196,252` (`bookWiped`) | removed |
| `e2e/profile-regen-preview.spec.ts:96-101` (`rejectAllPending` phantom workaround) | removed (unnecessary after D6/D7) |
| `e2e/marketing/scenes.ts:1060,1087` (`rejectAllPending`, `markRevisionPlayable`) | seed the mock state instead |

**Persistence middleware**
- Remove the nine `revisions/*` rules, `revisionsPatch` (`:313`), and the revisions hydrate gate (`:486-490`).
- The `${bookId}:${slice}` flush key and flush-on-book-change stay. They are shared by every persisted slice.

**Thunks (`src/store/revisions-thunks.ts`): confirm, then apply.**
- `acceptRevisionOp`/`rejectRevisionOp` → `applyServerState`.
- `dismissDriftOp` posts to **the event's own book** → `applyDismiss`.
- Errors:
  - `chapter_busy` → toast "This chapter is busy — try again when it finishes".
  - `no_previous_audio` → the player's "Original audio not preserved" state with **Keep new take**.
  - `live_audio_missing` → error toast.
  - `revision_stale` / `revision_not_found` → "This take was replaced by a newer render", then refetch.
  - Anything else → toast. The cache is unchanged.

**Layout (`src/components/layout.tsx`)**
- **Book-open hydrate** (`:825-925`) dispatches `hydrate`. The `persistPendingAfterHydrateMerge` follow-up and the revisions retry loop go. A failed read leaves the cache unloaded until the next poll.
- **Accept** (`:2485-2527`) and **reject** (`:2549-2568`) dispatch the thunks.
  - The player first **releases both `<audio>` elements** (`src=''`). As today, it closes before the call. That avoids replacing a file `res.sendFile` still holds open on Windows.
  - Preview side effects (drop the preview, the change-log entry, the fan-out of the remaining chapters) run **only after success**.
- **Dismiss** (`:2199`) → `dismissDriftOp`.
- The **active poll** (`:1108-1125`) → `applyPoll`.
- **The A/B player opens a specific `revisionId`**, not `pending[0]` (D6). The preview opens `previewChapterId`'s entry, and the Listen row opens its own chapter's entry.

**`PreviewRegenCtx`** (`src/store/ui-slice.ts:22-33`) gains `bookId`. Accept's fan-out uses `previewRegen.bookId`, not the active book. The context stays transient: after a reload, Approve no longer fans out, which is today's behaviour too and is stated in the regression plan.

**`src/views/revision-diff.tsx`** (reads `revision.playable` at `:72,187,256,260,281,324`):
- "Rendering new take…" is driven by a `rendering` prop.
- It adds a **Keep new take** action and a `busy` prop.

**Splice slice (`src/store/splice-slice.ts:31-45`)** gains `inFlightChapterIds`, maintained by the runner. It is the source of "Rendering new take…".

**Runners**
- **`splice-runner-middleware.ts`**:
  - drop the `enqueuePending`/`markRevisionPlayable` dispatches (`:68-70`, `:123-124`);
  - maintain `inFlightChapterIds`;
  - on `splice_complete` for the cached book, refetch revisions;
  - on `reviewRecorded:false`, toast "The new take is live, but its A/B review couldn't be saved".
- **Preview completion.** The preview gate currently fires *on* the deleted `revisions/markRevisionPlayable` action (`generation-stream-middleware.ts:169`). Instead, `generation-stream-runner.ts` dispatches a new action, `chapters/previewChapterComplete({bookId, chapterId, reviewRecorded})`, for any `chapter_complete` whose job carried `review`, **for any book**. (Today only the viewed book's ticks are forwarded, `:345-354`.)
  - If `bookId` is the cached book, the middleware refetches and opens the player on that chapter's entry.
  - Otherwise it shows a toast "Preview ready in ‹book›". The entry is on disk and appears when that book is opened.
- Remove `generation-stream-runner.ts`'s `markRevisionPlayable` dispatch.

## Compatibility and the two PRs

**PR 1, server, dark.** Everything in §1-§4 lands, but:
- every finalize caller passes `review: undefined`, so no server path writes pending;
- the old `DELETE …/audio/previous` and `POST …/audio/previous/restore` routes stay live and the client keeps using them. Their logic is rewired to the store's safe accept/reject **disk steps** (§3 step 3, no JSON write), so D2's last-copy loss is fixed even for the old client;
- `PUT /state` with `slice:'revisions'` is still accepted;
- `GET /state` still returns revisions.json **raw**, including the legacy `drift` key that the old client's `hydrateFromBookState` reads (`revisions-slice.ts:396-402`).

**Invariant on `main` between PR 1 and PR 2: the client is the only writer of `pending`.** If server recording went live while the old client still PUT whole files, those PUTs would erase server-written entries. That is #3400 again.

**PR 2, client cutover.** It carries all of §5 plus the server switches:
- callers pass `review`/`null`;
- `GET /state` returns the normalised state;
- `PUT slice:'revisions'` returns **400 `revisions_server_owned`**;
- the two old routes return **410 `moved`**. Not 404, because the old client's `acceptChapterRevision` treats 404 as success (`api.ts:10218-10221`).

On rollout, an old tab hits the 400/410, which are logged and surfaced; disk is unchanged. Files already on disk are normalised on read. Historical lost entries are not recreated.

## Testing

Every behavioural item has a paired test and is mutation-checked: revert the fix and observe red.

**PR 1 (server)**

Store:
- each op, including idempotent retries;
- all four 409s;
- **the fingerprint rule:**
  - a reject retried after an injected step-4 failure completes;
  - a stale entry (live audio re-rendered after recording) answers `revision_stale`;
  - `rename` preserves `mtime`, pinned on the CI OS;
- **no moment without live audio:** inject failures at restore steps 1 and 2, and assert the live file exists after each; test an m4a live take;
- lock serialisation: accept racing `recordPending` on the same book, in both orders;
- legacy normalisation;
- the `fileId`/`rev` rules;
- `selection` validation.

Reservation:
- `reserveChapter` refuses during a splice, a QA repair, and generation on `::id` and `::*`;
- the unset probe fails closed;
- a splice/generation registering during an op waits, then proceeds;
- a wait that times out gives a curated error;
- `check:cycles` stays clean.

Finalize:
- the `review` tri-state;
- `preserved` requires the segments too;
- a store failure → `reviewRecorded:false` and no message in any SSE body;
- **dark:** every caller passes `undefined`, asserted by a test over the three call sites.

Routes:
- status codes;
- curated 500 on a lock timeout;
- `computeRevisionsForBook` returns pending with an empty cast;
- `qa-report` is unaffected;
- `review` round-trips through queue enqueue and claim into the generation request, and a multi-chapter request gets 400;
- the old routes use the safe disk steps.

**PR 2 (client and switches)**

Client:
- foreign-book payloads ignored; `fileId`/`rev` handling; `applyDismiss` across books;
- every thunk outcome;
- preview side effects only on success, fan-out under `previewRegen.bookId`;
- **no revisions PUT is ever sent**, asserted over every `putBookState` call;
- the player opens the requested entry;
- `previewChapterComplete` for a non-viewed book;
- mock/real contract test;
- the mock poll reads per-book state.

Server switches:
- each caller's `review` value;
- the 400 and the 410;
- `GET /state` is normalised.

e2e (mock):
- Fix-audio on book A with a controlled delay → switch to B → completion → back to A: the prompt is present and playable (#3397);
- `profile-regen-preview.spec.ts` passes without its workaround.

The e2e drives the mock's imitation of finalize. The server half is covered by the PR 1 tests and by on-box acceptance.

**On-box acceptance** (register row, owed by PR 2; real sidecar, real mp3 book):
- splice → switch books → the prompt appears;
- accept → `.previous` is gone;
- re-splice → reject → the original audio and segments return;
- a reject while that chapter renders → 409;
- render a chapter while its accept/reject is mid-flight → the render waits and then proceeds.

## Delivery

- **One worktree and branch per PR.**
  - PR 1: `fix/server-3400-revisions-server-ops` (this worktree), `Refs #3400`, `Refs #3397`.
  - PR 2: a new branch cut from `main` after PR 1 merges, `Closes #3400`, `Closes #3397`.
- **Docs:**
  - PR 1 adds the regression plan `docs/features/285-revisions-server-ops.md`, its INDEX entry, and the two CLAUDE.md sentence updates (lock order, `requestFailureMessage` count);
  - both PRs add release notes (PR 1's are operator-facing: the reject last-copy fix);
  - PR 2 adds the on-box register row on all three surfaces.
- **Filed before PR 1 starts:** the four issues above, each naming its owed decision, and the fsck fix agent's issue.
- **Child counts:** PR 1 about 8 children plus verify; PR 2 about 7 plus verify. If writing-plans counts more than about 10 for either PR, it re-cuts rather than overloading children.
