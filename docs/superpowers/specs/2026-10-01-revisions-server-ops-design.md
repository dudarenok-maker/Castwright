---
status: draft
revision: 4 (narrowed by the operator after two assumption-checker passes; third pass folded, 2026-10-02)
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
- **A stalled or displaced generation body keeps finalizing after it deregisters.** `Promise.race` at `generation.ts` ~2077-2084; finalize takes no abort signal. This deliverable keeps such a body visible to revisions ops (§2: `leave()` runs in the body's own `finally`). The owed decision is whether a stalled or displaced body should be **aborted** before it finalizes at all. Today it can overwrite a newer take.
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
- default any missing field. A **missing file** reads as `fileId: null, rev: 0`. A legacy file without `fileId` reads as `fileId: null` as well, and the store mints a real random `fileId` on its first write;
- legacy entries:
  - drop those with `playable:false`;
  - keep those with `playable:true` only if the chapter's `.previous.mp3` exists;
  - if several are left for one chapter, keep the last.

### 2. Per-chapter exclusion (`server/src/routes/chapter-job-coordination.ts`)

This file stays import-free. **One in-memory primitive serves both sides**, so there is no check-then-act gap and no probe into `generation.ts`. Per book and chapter it holds `{ op: boolean, jobs: number }`.

**Jobs**
- A job calls `await enterChapterJob(bookId, chapterId | null, timeoutMs = 60_000)` **before its first read of the chapter's files**:
  - splice: before `findChapterAudio` at `chapter-splice.ts:159`;
  - QA repair: before `:132`;
  - generation: before the displacement block at `generation.ts:1264`, which precedes the `registerJob` call at `:1297`.
- It waits while an op holds that chapter (or, for `null`/`::*`, any chapter of the book). It then increments `jobs` **synchronously**, in the same tick as the job's existing displacement and registration logic, so job-vs-job displacement keeps working exactly as today.
- It returns a handle whose `leave()` runs in the **render body's own `finally`**, not the route's. A generation body that keeps running after the stall watchdog's `Promise.race` resolves (`generation.ts` ~2077-2084), or after displacement, therefore still counts until it actually ends. That closes, for ops, the stalled/displaced-body hazard. Whether finalize itself should be aborted stays filed.
- On timeout the job fails with a curated "chapter is busy" error (no path).

**Ops**
- `tryClaimChapterForOp(bookId, chapterId)` succeeds only when `op` is false and `jobs === 0`, and then sets `op`. Otherwise → 409 `chapter_busy`. `release()` runs in `finally`.
- Ops never wait, so ops and jobs cannot deadlock. Neither side holds the revisions lock while waiting on the other.
- An op's worst case is three `renameWithRetry` budgets (about 1.8-3.6 s each) plus one lock acquisition, well inside a job's 60 s wait.

**Tests:** suites that `vi.mock('./generation.js')` (`chapter-splice.test.ts`, `chapter-qa-repair-spk.test.ts`) need no probe stub, because there is no probe.

**Restructure** (`chapters-restructure.ts`) renumbers chapter ids and renames chapter audio. It claims each affected chapter as an op (all-or-nothing, 409 if any is busy). Under the revisions lock it **drops pending entries for every chapter whose id changed**. Their `.previous` files do not move with the slug rename, so those A/B pairs are already broken today.

### 3. HTTP contract

**Accept and reject return `200 RevisionsState`**: `{ bookId, fileId, rev, pending, dismissed, acceptedSelections, timeline }`. **Dismiss returns `200 DriftDismissResponse`**: `{ bookId, fileId, rev, dismissed }`.

Notation: `L` is the live audio (`findChapterAudio`); `P` is `.previous.mp3`; `PS` is `.previous.segments.json`.

**Disk state is never inferred to mean "already done"**, with one exception that fails closed. A reject in progress is **recorded**: the entry carries `restoring: true` (written under the lock before any file moves). Without that marker, a missing `P` always means "nothing to restore". That keeps restructure, mtime drift on synced folders, or anything else that changes `L` from turning into a false "rejected".

**`POST /api/books/{bookId}/revisions/{revisionId}/accept`**, body `{ selection?: Record<segmentIndex,'A'|'B'> }`

1. **Under the lock:** read the entry.
   - Absent, and the timeline has `accepted` for this id → 200 with the current state (idempotent).
   - Absent otherwise → 404 `revision_not_found`.
   - `restoring` is set → 409 `revision_restoring` (only a reject retry may continue it).
2. **Under the lock:** `tryClaimChapterForOp`, else 409 `chapter_busy`.
3. **Outside the lock, holding the claim:**
   - `L` is missing → 409 `live_audio_missing`. Nothing changes; this stops the last-copy loss (D2).
   - The entry has `newTake` and `stat(L)` ≠ `newTake` → 409 `revision_stale`, and the entry is dropped in step 4.
   - Otherwise delete `P` and `PS`. Missing counts as success: accept's disk step is idempotent, so a retry after a failed step 4 just re-deletes nothing.
4. **Under the lock:** re-read. Remove the entry, set `acceptedSelections` (when `selection` is given), and append the timeline entry `accepted`, keeping the reversible-chain rule from `appendTimelineEntryHelper`. One write, `rev + 1`. Release the claim in `finally`.

**`POST …/{revisionId}/reject`**

Steps 1 (minus the `revision_restoring` refusal; the marker is reject's own) and 2 are as above.

3. **Under the lock, still holding the claim:** decide.
   - `restoring` already set → **resume**: go to 3b.
   - `P` is absent → 409 `no_previous_audio`. Nothing changes; the UI offers **Keep new take** (accept).
   - `L` is present, the entry has `newTake`, and `stat(L)` ≠ `newTake` → 409 `revision_stale` (drop the entry).
   - Otherwise set `restoring: true` (one write, `rev + 1`).

   `L` being missing is **not** a refusal here. Restoring `P` is exactly the recovery, as today (`chapter-audio.ts:422-428`).

3b. **Outside the lock: the restore.** Every step is idempotent, the live pair is never mismatched, and there is never a moment with no live audio:
   1. If `PS` exists, **copy** it to `segments.json.restore-tmp`. Copying keeps `PS` until the end.
   2. If `P` exists, rename `P` over `<slug>.mp3` (`renameWithRetry`, `atomic-rename.ts:45`; this replaces a closed target, as `writeJsonAtomic` does every day).
   3. If `segments.json.restore-tmp` exists, rename it over `segments.json`.
   4. If the previous live file was `<slug>.<other ext>`, delete it. `findChapterAudio` probes mp3 first (`chapter-audio-file.ts:37-41`).
   5. Delete `PS`.

   - A legacy pair with no `PS` skips 1, 3 and 5, as today (`chapter-audio.ts:435-438`).
   - On resume, a missing `P` means step 2 already ran, so continue from 3. `PS` (still present until step 5) re-feeds a missing tmp.
   - The only mismatched window is between steps 2 and 3, and the marker covers it: any failure returns 500 with `restoring` still set, and the next reject on that entry finishes it.
4. **Under the lock:** remove the entry and append `rejected`. One write, `rev + 1`. Release the claim.

**The fingerprint's role is limited to `revision_stale`, which only ever refuses.** It relies on `rename` on one volume preserving `mtime`. That was observed on NTFS during review, and a unit test pins it on the CI OS. On a filesystem with coarse or drifting mtimes it can only make entries read as stale (a false "replaced by a newer render"), never fail open.

**`POST /api/books/{bookId}/drift/{driftId}/dismiss`** adds the id to `dismissed` (idempotent). No claim, no disk step.

**Polls**
- `GET /api/books/{bookId}/revisions` (active-book poll) returns `RevisionsState` plus live `drift`.
- `GET /api/revisions` (bulk) returns `{byBookId:{[id]:{pending, drift}}}` with pending now read through the store.
- `computeRevisionsForBook` (`revisions.ts:125`) changes shape for all three callers, including `server/src/routes/qa-report.ts:13,30`. It returns pending even when the cast is empty (D8).

**Errors**
- 404: unknown book, `revision_not_found`.
- 400: malformed `selection` (non-integer keys, values outside A/B, dangerous keys as in `script-review-ledger.ts:46-52`).
- 409: `chapter_busy`, `live_audio_missing` (accept only), `revision_stale`, `no_previous_audio`, `revision_restoring` (accept on an entry whose reject is unfinished).
- 500: through `requestFailureMessage` (`file-lock.ts:214`).

CLAUDE.md's "`git grep requestFailureMessage` enumerates all thirteen sites" sentence is updated for the three new sites.

**OpenAPI** (then `npm run openapi:types`):
- the three routes;
- `RevisionsState` and `DriftDismissResponse`;
- the 409 codes;
- `Revision` gains optional `origin`, `newTake` and `restoring`;
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
- `applyServerState(...)` and `applyPoll(...)` carry full state.
  - **For a different `bookId` they adopt that book.** The callers (the thunks, the active-book poll, and the runners' refetches) dispatch only payloads whose `bookId` equals the **current** `ui.stage.bookId`, which they read at dispatch time. A late response for a book the user has left is dropped by the caller, not the reducer.
  - For the same `bookId`, a different `fileId` (or `null` on either side) adopts, since the file was recreated.
  - Within the same `fileId`, the payload is ignored when `state.rev < cache.rev`. So a poll that started before an op can't bring back the accepted entry, a reparse that resets `rev` doesn't lock the cache out, and a failed hydrate is repaired by the next poll.
- **Selectors return empty** (`pending`, `timeline`, `acceptedSelections`) when `cache.bookId` ≠ the active book. That replaces `bookScopeChanged`'s instant reset, so book B never shows book A's entries during the hydrate window.
- Layout's reload short-circuit, gated on `hydratedFor` (`layout.tsx:202`, `:787-845`), is regated on `revisions.bookId === bookId && revisions.loaded`.
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
| `src/store/generation-stream-middleware.ts:169-179` (the preview gate's `enqueuePending` and its `markRevisionPlayable` trigger) | replaced by `chapters/previewChapterComplete` (below) |
| `src/components/layout.tsx:202`, `:787-845` (`hydratedFor` consumers) | regated as above |

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
- the old `DELETE …/audio/previous` and `POST …/audio/previous/restore` routes stay live and the client keeps using them.
  - They take the per-chapter op claim (§2) and run the store's safe disk steps: accept's delete, and reject's copy-then-rename restore (§3 3b), **without** the fingerprint check or the marker, because PR 1 has no server entries.
  - D2's last-copy loss and the mismatched-pair window are therefore fixed for the old client too.
  - Their status codes are today's: restore 409 is used for "busy" (the old client renders it as "Generation is in flight", `api.ts:10235-10237`, which is slightly broader than the truth and acceptable for one release), and 404 when there is no `.previous`.
  - Reject with `L` missing still recovers, as today;
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
- **the `restoring` marker:** inject a failure at each restore sub-step (3b.1–3b.5) and at the final JSON write. After each, assert:
  - live audio exists;
  - live audio and `segments.json` are never a mismatched pair, except inside the marked 3b.2–3b.3 window;
  - a reject retry finishes with the original audio **and** segments live, and `rejected` recorded once;
  - accept on a marked entry returns `revision_restoring`;
- **no inference fails open:** `P` absent + no marker → `no_previous_audio`, even when `stat(L)` mismatches (the restructure/mtime-drift case);
- a legacy pair with no `.previous.segments.json` rejects successfully;
- reject with `L` missing restores;
- **the fingerprint:** a stale entry (live audio re-rendered after recording) returns `revision_stale`; `rename` preserving `mtime` is pinned on the CI OS;
- an m4a live take restores, and the stale `.m4a` is removed only after the mp3 rename;
- lock serialisation: accept racing `recordPending` on the same book, in both orders;
- legacy normalisation;
- the `fileId`/`rev` rules;
- `selection` validation.

Exclusion:
- the op claim refuses while a splice, a QA repair, or a generation job (`::id` and `::*`) is inside the chapter, **including during the job's pre-registration file reads**;
- a stalled generation body (watchdog resolved, body still running) still blocks the claim until its body ends;
- a job entering during an op waits, then proceeds with the restored files;
- two same-chapter generation POSTs still displace as today;
- a job wait that times out gives a curated error;
- restructure claims all affected chapters, and drops the remapped chapters' pending entries;
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
