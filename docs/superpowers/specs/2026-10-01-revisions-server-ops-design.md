---
status: draft
issues: "#3400, #3397"
supersedes-client-guards-from: "#3376 / PR #3395 (merged 9f379fb6)"
---

# revisions.json becomes server-owned: per-operation writes

## Problem

`<bookDir>/.audiobook/revisions.json` holds the pending A/B takes, dismissed drift, accepted segment selections, and the Revision History timeline. Today the client writes it as a **whole-file replace**:

- the persistence middleware PUTs the entire slice (`src/store/persistence-middleware.ts`, nine `revisions/*` `PERSIST_RULES` built by `revisionsPatch`);
- the server writes that body over the file with no lock and no validation (`server/src/routes/book-state.ts:789-790`, a bare `writeJsonAtomic`).

So any client state that is stale in any way erases disk. PR #3395 (#3376) spent six review passes adding client guards:

- `revisions-scope-middleware.ts`;
- `bookId` / `hydratedFor` / `windowActions`;
- a hydrate gate in the persistence middleware;
- replay of writes made before hydrate;
- `persistPendingAfterHydrateMerge`;
- flush-on-leave.

Each guard closed one ordering and opened another (#3400). Two further gaps remain because pending entries are **client-created and active-book-only** (#3397):

- **Stuck.** A Fix-audio entry enqueued as `playable:false` never flips if the user leaves the book before the splice finishes. It then survives reloads.
- **Lost.** A splice that starts and finishes while its book is not active never gets an entry. The new audio and its `.previous` backup are on disk, but there is no A/B prompt.

Two more defects found while mapping:

- **Accept and reject are not atomic.** The slice action is dispatched (and persisted) *before* the audio call. Accept is `DELETE …/audio/previous` and reject is `POST …/audio/previous/restore` (`server/src/routes/chapter-audio.ts:377-441`). On a refused restore (409), the timeline says "rejected" but the audio was never restored.
- **Reject's busy check is incomplete.** Reject checks only `isGenerationActive`, never a splice in flight on the same chapter. A reject racing a splice can clobber the `.previous` that splice just wrote.

A second browser tab can also erase the first tab's writes: the revisions slice is not cross-tab-synced (`broadcast-middleware.ts:39-66`).

## Decisions (operator, 2026-10-01, recorded on #3400 / #3397)

1. **Server-side per-operation writes** (#3400 option a). The client stops writing revisions.json.
2. **Server-derived pending** (#3397 option a), for **every** source, not just Fix-audio.
3. **Accept and reject are single atomic operations** covering the audio-file step and the JSON write.
4. **One route per operation**, not a single `ops` endpoint with a tagged union.
5. PR #3395's client guard machinery is **removed**, because it is now obsolete. (#3395 merged before this design landed, so this means deletion from `main`, not "never merged".)

## Design

### 1. Ownership

`revisions.json` becomes **server-owned**. Every write goes through one new module, `server/src/workspace/revisions-store.ts`, modelled on `server/src/workspace/script-review-ledger.ts`.

- **Locking.** Each operation is a read-modify-write under `withKeyLock(\`revisions:${bookDir}\`)` (`server/src/workspace/file-lock.ts:218`).
  - The read, and every decision derived from it, happens inside the lock (cast-lock rule 2, applied to this file).
  - This is a **leaf lock**. No revisions op acquires any other lock class while holding it, and no code path acquires it while holding the design, library-voice or cast lock. Add one line to the lock-order comment at `server/src/workspace/cast-lock.ts:11-24` saying so.
- **File shape** (`schema: 1`):
  ```ts
  { schema: 1,
    pending: Revision[],                     // at most one entry per chapterId
    dismissed: string[],                     // dismissed drift ids
    acceptedSelections: Record<revisionId, Record<segmentIndex, 'A'|'B'>>,
    timeline: Record<chapterId, TimelineEntry[]> }
  ```
  The `drift` copy the client used to write is **dropped**. Drift is computed live by `computeRevisionsForBook` (`server/src/routes/revisions.ts`), which reads only `dismissed`.
- **Reading and normalising.** `readRevisions(bookDir)` normalises a legacy or absent file:
  - drop `drift`;
  - default any missing field;
  - deduplicate `pending` per `chapterId`, keeping the newest;
  - resolve entries stuck at `playable:false`: if `.previous` exists for the chapter and no splice is in flight, set `playable:true`; otherwise drop the entry.

  The normalised form is written on the next mutation. A read never writes.
- **Deletion.** Reparse and replace-manuscript still delete the file (`book-state.ts:1201-1203`), now through `revisions-store` under the same lock.

### 2. HTTP contract

Every route responds `200 RevisionsState`:
```ts
{ pending: Revision[], dismissed: string[],
  acceptedSelections: Record<string, Record<number, 'A'|'B'>>,
  timeline: Record<number, TimelineEntry[]> }
```
The client replaces its cache with the response.

**`POST /api/books/{bookId}/revisions/{revisionId}/accept`**, body `{ selection?: Record<segmentIndex, 'A'|'B'> }`. Under the lock:
1. Look up `revisionId` in pending.
   - If it's absent and the timeline already has an `accepted` entry for it, return 200 with the current state (idempotent retry).
   - Otherwise return 404 `revision_not_found`.
2. If `isGenerationActive(bookId)` or a splice is in flight for that chapter, return 409 `chapter_busy`.
3. Delete `.previous.<ext>` and `.previous.segments.json`. Missing files count as success.
4. Remove the pending entry, set `acceptedSelections[revisionId]` (when `selection` is given), and append the timeline `accepted` entry, applying the existing reversible-chain rule from `appendTimelineEntryHelper`. Write the file atomically.

**`POST /api/books/{bookId}/revisions/{revisionId}/reject`**. Same as accept, except:
- step 1's idempotent case looks for an existing `rejected` entry;
- step 3 restores `.previous` over the live take;
- if there is no `.previous`, return 409 `no_previous_audio` and leave state unchanged. The UI then offers "Keep new take", which is accept.
- Step 4 appends the timeline `rejected` entry.

**`POST /api/books/{bookId}/drift/{driftId}/dismiss`**: add `driftId` to `dismissed` (idempotent). It does not touch the audio and takes no busy check.

**`GET /api/books/{bookId}/revisions`** (the existing active-book poll): it now returns `RevisionsState` plus the live `drift`. `GET /api/revisions` (bulk, background) is unchanged: `{byBookId: {[id]: {pending, drift}}}`.

**Ordering rule: audio first, JSON second, both inside the lock.**
- If the audio step fails, the response is 500 and the file is byte-identical.
- *Known residual case:* a process crash between the audio step and the atomic write. Accept recovers on retry, because the missing `.previous` counts as success. Reject's retry gets `no_previous_audio`, and the user resolves it with "Keep new take". Nothing is corrupted; the residual is one extra click.

**Errors**
- 404 for an unknown book.
- 400 for a malformed `selection` (non-integer segment keys, values outside `A`/`B`, dangerous keys rejected as in `script-review-ledger.ts:52`).
- 500 through `requestFailureMessage` (`file-lock.ts:214`), so a lock timeout never leaks the workspace path.

**The whole-file write path is closed.** `PUT /api/books/{bookId}/state` with `slice: 'revisions'` returns **400 `revisions_server_owned`**. `openapi.yaml`'s description of that PUT says so.

**`busy` helper.** Promote `_hasInFlightSplice` (`server/src/routes/chapter-job-coordination.ts:45`) to a public `isSpliceInFlight(bookId, chapterId)`, and use it in the ops and in `readRevisions`' normalisation.

**OpenAPI** (`openapi.yaml`, then `npm run openapi:types`):
- add the three routes and a `RevisionsState` schema;
- correct the drift the map found: `BookStateResponse.revisions` gains `timeline`; `RevisionsResponse` gains `dismissed`/`acceptedSelections` and reflects the poll's new shape.

### 3. Server-derived pending

`finalizeChapterAudioWrite` (`server/src/audio/finalize-chapter-write.ts:124`) gains an optional `review?: { characterId: string; triggeredBy: string }` on `FinalizeChapterAudioInput`.

- `preserveExistingAsPrevious` (called at `:359`) must report whether it actually preserved a file. On a first render there is nothing to preserve.
- After the audio and segments are written:
  - **`review` given and a `.previous` was created:** `revisions-store.recordPending` upserts the chapter's single entry, **already playable**, with `hasPreviousAudio: true`, an id unique to this recording, `revision:<chapterId>:<finalize epoch ms>`, the `triggeredBy` text and the duration fields. Any older entry for that chapter is replaced, since a chapter has only one `.previous`.

    The id must be unique per recording. With one stable id per chapter, a duplicated or late `accept` for an earlier take would hit the newer entry and accept a take the user never auditioned. A per-recording id makes the late request 404 instead.
  - **No `review`, but the chapter has a pending entry:** `revisions-store.dropPendingForChapter` removes it, because its side A has just been overwritten. This happens today silently, leaving an A/B pair that compares the wrong takes. It's fixed here as part of the same change.
  - **`review` given but nothing preserved** (first render): no entry is created. This replaces the client's optimistic `hasPreviousAudio: true` (`src/lib/build-pending-revision.ts`).

Callers:
- **`chapter-splice.ts:492`** always passes `review` (Fix-audio's "Loudness fix…" / "Re-record…" text, currently built client-side in `splice-runner-middleware.ts`; move it server-side next to the splice request's mode).
- **`generation.ts:1861`** passes `review` only when the generate request carries it. The request type behind `src/lib/api.ts:603` (`chapterIds?: number[]`) gains an optional `review?: { characterId, triggeredBy }`. The client sets it only when `ui.previewRegen` names that chapter.
- **`chapter-qa-repair.ts:720`** passes no `review`, so its finalize drops any stale entry for that chapter.

Because the server records the entry on completion, whether or not any client is on that book, #3397's Gap 2 (lost) is closed. Because no entry is ever stored unplayable, Gap 1 (stuck) cannot recur. Existing stuck entries are cleared by the normalisation in §1.

### 4. Client

**API layer (`src/lib/api.ts`)**
- Add `acceptRevision`, `rejectRevision` and `dismissDrift`, each with a `real` implementation and a `mock` implementation. The mocks apply the same rules to `MOCK_BOOK_STATES` (`api.ts:916`), including the two 409s.
- `mockStreamSplice` and the mock generation preview record a pending entry the way finalize does, so mock mode and e2e exercise the server-owned flow.
- Remove `acceptChapterRevision` / `rejectChapterRevision` (only caller: `layout.tsx`). Delete the server routes `DELETE …/audio/previous` and `POST …/audio/previous/restore` if `git grep` finds no other caller; their logic moves into `revisions-store`.

**Revisions slice (`src/store/revisions-slice.ts`) becomes a cache**
- **State:** `pending`, `drift`, `dismissed`, `acceptedSelections`, `timeline`, `loaded`, and `bookId` (which book the cache holds).
- **Writers:** `hydrate({bookId, state})`, `applyServerState({bookId, state})` (op responses and refetches) and `applyPoll({bookId, …})`. Each **discards a payload whose `bookId` differs from the book the cache holds**, or, for `hydrate`, adopts the new book. `applyBackgroundPoll` (drift only, multi-book) stays.
- **Removed:**
  - `hydratedFor`, `windowActions`, `recordIfUnhydrated`, `replayRecorded`;
  - `bookScopeChanged`, `bookWiped`, `persistPendingAfterHydrateMerge`;
  - `enqueuePending`, `markRevisionPlayable`;
  - the reducer halves of `acceptRevision`, `rejectRevision` and `dismissDrift`;
  - the never-dispatched `acceptAllPending`, `rejectAllPending` and `rolledBack`.
- **Kept:** the drift selectors (`selectDriftByBook`, `selectDriftForBook`, `groupDriftEvents`, …), `mergeDriftForBook`, `normaliseTimelineKeys`.
- **`src/store/revisions-scope-middleware.ts`** is deleted, together with its wiring in `src/store/index.ts`.

**Persistence middleware (`src/store/persistence-middleware.ts`)**
- All nine `revisions/*` `PERSIST_RULES`, `revisionsPatch`, and the revisions hydrate gate (`:480-495`) are removed.
- The `${bookId}:${slice}` flush key and flush-on-book-change stay. They are shared by every persisted slice, not revisions-specific.

**Thunks (new, `src/store/revisions-thunks.ts`): confirm, then apply.** There is no optimistic update.
- `acceptRevisionOp`, `rejectRevisionOp` and `dismissDriftOp` call the route and `applyServerState` the response.
- The caller disables its buttons while the request is in flight.
- `409 chapter_busy` → toast "This chapter is busy — try again when it finishes".
- `409 no_previous_audio` → the diff player's "Original audio not preserved" state with a **Keep new take** action (= accept).
- Any other failure → toast. The cache is unchanged, so the UI still matches disk.

**Layout (`src/components/layout.tsx`)**
- Book-open hydrate (`:825-925`) dispatches `hydrate`. The `persistPendingAfterHydrateMerge` follow-up and any revisions-only retry loop go. A failed read leaves the cache empty and unloaded, and the next poll fills it. Nothing can be erased, because nothing writes.
- Accept (`:2485-2527`) and reject (`:2549-2568`) dispatch the thunks. **The preview side effects are preserved:**
  - accept: drop the preview, append the change-log entry, and enqueue the remaining chapters;
  - reject: drop the preview.

  These run only after the op succeeds.
- Dismiss (`:2199`) dispatches `dismissDriftOp`.
- The active poll (`:1108-1125`) now carries the full `RevisionsState`, so `applyPoll` refreshes the whole cache.

**Runners**
- `splice-runner-middleware.ts`: remove the `enqueuePending` (`:68-70`) and `markRevisionPlayable` (`:123-124`) dispatches. The chapter's "Rendering new take…" state is derived from the splice slice's in-flight chapter set, not from `playable:false`. On `splice_complete` **for the book the cache holds**, refetch `GET /books/:id/revisions` → `applyServerState`.
- `generation-stream-middleware.ts:167-185`: on the preview chapter's `chapter_complete`, refetch revisions, then open the A/B player. Remove `buildPendingRevisionStub` (`src/lib/build-pending-revision.ts`) if nothing else uses it.
- `generation-stream-runner.ts`'s `markRevisionPlayable` dispatch is removed.

### 5. Compatibility and rollout

- **Files already on disk** are normalised on first read (§1). Historical **lost** entries (#3397 Gap 2 before this ships) are **not** recreated. An orphan `.previous` is indistinguishable from an ordinary regen's backup, which by design gets no review. The fix is forward-only.
- **An old client tab** open across an upgrade gets 400 on its revisions PUT. That is logged, and nothing on disk changes. Its next book open runs the new code.
- The portable export, boot fsck and upgrade backup (`build-portable-book.ts:143`, `index.ts:208-230`, `upgrade-coordinator.ts:101`) are unaffected; none of them parse the file's fields.

## Testing

Every item ships with its paired test (CLAUDE.md "Testing discipline"). Each behavioural test is mutation-checked: revert the fix, observe red.

**Server: `revisions-store`**
- Each op, including the idempotent retries.
- `chapter_busy`, from both generation and a splice in flight.
- `no_previous_audio`.
- Audio first: an injected failure in the audio step leaves the file byte-identical.
- Lock serialisation: an accept racing `recordPending` on the same book (both orderings) loses neither write.
- Normalising a legacy file: `drift` present; a stuck `playable:false` entry with and without `.previous`; duplicate entries for one chapter.
- `selection` validation, including dangerous keys.

**Server: finalize**
- `review` plus a preserved `.previous` records an entry.
- `review` on a first render records none.
- No `review` drops the chapter's existing entry.
- The splice route passes `review`; the generation route passes it only when the request does; QA repair never does.

**Server: routes**
- Status codes for all three ops.
- The poll's new shape.
- `PUT /state` with `slice:'revisions'` returns 400.
- A lock timeout returns the curated `requestFailureMessage`, with no path in the body.

**Client**
- The slice discards foreign-book payloads.
- Thunk success, `chapter_busy`, `no_previous_audio` and other failures, with the cache unchanged on any failure.
- Accept and reject preview side effects run only on success.
- **No `revisions` PUT is ever sent.** Assert over every `putBookState` call in the layout and runner tests.
- The splice runner and the generation middleware no longer dispatch pending writes.
- Mock and real `acceptRevision`/`rejectRevision`/`dismissDrift` pass one shared contract test.

**e2e (Playwright, mock mode, one spec):** start Fix-audio on book A, switch to book B, wait for completion, return to A. The A/B prompt is present and playable. This is #3397's regression.

**On-box acceptance** (register row, real sidecar and a real book), the same walkthrough with a real splice:
- confirm the entry appears after a book switch;
- accept it, and confirm `.previous` is deleted;
- re-run the splice and reject, and confirm the original take plays;
- reject during generation, and confirm the 409 toast and that pending is unchanged.

## Not in scope

- Timeline rollback (`rolledBack` has no UI; it is removed, not ported).
- Cross-tab sync of the revisions cache. It is no longer needed for correctness, because tabs can no longer erase each other.
- Recovering pre-existing lost entries.
- Any change to drift computation.

## Delivery

- One branch, `fix/server-3400-revisions-server-ops` (worktree `C:\Claude\Projects\wt-3400-revisions-server-ops`), and one PR with `Closes #3400` and `Closes #3397`.
- A regression plan, `docs/features/285-revisions-server-ops.md`, plus an INDEX entry.
- Release notes in both files.
- An on-box register row (all three surfaces).
- The implementation plan (writing-plans) cuts this into children of about one commit each, ordered so the server lands before the client stops writing. **The `PUT` refusal lands last on the server side, after the client no longer sends revisions PUTs.**
