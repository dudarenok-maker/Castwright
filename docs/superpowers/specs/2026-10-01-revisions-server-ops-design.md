---
status: draft
revision: 2 (folds the 2026-10-01 assumption-checker pass)
issues: "#3400, #3397"
supersedes-client-guards-from: "#3376 / PR #3395 (merged 9f379fb6)"
---

# revisions.json becomes server-owned: per-operation writes

## Problem

`<bookDir>/.audiobook/revisions.json` holds the pending A/B takes, dismissed drift, accepted segment selections, and the Revision History timeline. Today the client writes it as a **whole-file replace**:

- the persistence middleware PUTs the entire slice (`src/store/persistence-middleware.ts:231-251`, nine `revisions/*` rules built by `revisionsPatch`);
- the server writes that body over the file with no lock and no validation (`server/src/routes/book-state.ts:789-790`).

Any stale client state erases disk. PR #3395 (#3376) spent six review passes adding client guards (scope middleware, `bookId`/`hydratedFor`/`windowActions`, a hydrate gate, pre-hydrate write replay, `persistPendingAfterHydrateMerge`, flush-on-leave). Each closed one ordering and opened another (#3400).

Pending entries are **client-created and active-book-only**, which leaves #3397's two gaps:

- **Stuck.** A Fix-audio entry enqueued as `playable:false` never flips if the user leaves the book first. It then survives reloads.
- **Lost.** A splice that runs entirely while its book is not active never gets an entry.

Defects found while designing this, all owed in this change (CLAUDE.md "Incidental findings"):

| | Defect | Evidence |
|---|---|---|
| D1 | Accept and reject are not atomic. The slice action persists *before* the audio call, so a 409 on restore leaves the timeline saying "rejected" with nothing restored. | `layout.tsx` ~2485-2568 |
| D2 | Reject deletes the live take *before* renaming `.previous` back into place, and swallows a failed segments rename. A failed restore followed by Approve (which deletes `.previous`) leaves the chapter with **no audio**. | `chapter-audio.ts:420-438` |
| D3 | Reject restores only the audio and segments. `state.json`'s `duration`/`audioModelKey`/`audioEngines`/`audioRenderedAt`/`audioQa`, and the live `peaks.json`/`lufs.json`/embeddings, keep describing the take that was thrown away. | `finalize-chapter-write.ts:207-211,361-402` |
| D4 | `.previous` is always named `.previous.mp3`, and restore always writes `<slug>.mp3`, whatever the book's format. The boot fsck tests the literal `<slug>.mp3`, so **on every boot of an m4a or ogg book** it promotes a valid `.previous.mp3` over the live take. That silently reverts the chapter and hides the new file. | `preserve-previous-audio.ts:37,45`; `chapter-audio.ts:232-235,428`; `fsck-orphan-audio.ts:80-91`; `chapter-audio-file.ts:37-41` |
| D5 | Reject checks only the book-wide `isGenerationActive`; accept checks nothing. Neither sees a QA repair or splice on that chapter. | `chapter-audio.ts:377-441` |
| D6 | The A/B player opens `pending[0]`, not the entry the user came for. A leftover entry can become the auto-opened player during a profile-regen preview, and approving it skips the preview fan-out. | `layout.tsx:2474-2479,2509` |
| D7 | `mockPollRevisions` returns the canned `PENDING_REVISIONS` for every book and ignores `MOCK_BOOK_STATES`. | `src/lib/api.ts:1931-1973` |

## Decisions

From the operator, 2026-10-01, recorded on #3400 and #3397:

1. **Server-side per-operation writes.** The client never writes revisions.json.
2. **Server-derived pending**, for every source.
3. **Accept and reject are single atomic operations** covering the audio-file step and the JSON write.
4. **One route per operation.**
5. **#3395's client guard machinery is deleted from `main`.**

Made in this spec after review (the operator may overrule any of them at spec review):

- **R1. Reject restores the chapter exactly as it was before the new take.** That covers the audio, segments, peaks, loudness, embeddings, and the per-chapter `state.json` take fields. "Atomic" covers all of it, not only the JSON (closes D2 and D3).
- **R2. Recording a review entry is best-effort with respect to the render.** If `recordPending` fails after a good finalize, the chapter still succeeds and its SSE result carries `reviewRecorded: false`. The client shows "The new take is live, but its A/B review couldn't be saved". A render is never failed after its audio is written.
- **R3. Accept and reject are journalled.** An intent marker is written before any file moves, so a retry, or the next read, finishes an interrupted operation instead of guessing. This removes v1's "known residual".
- **R4. The busy check is per chapter**, not book-wide. Accepting or rejecting chapter 3 is allowed while chapter 9 renders.

## Design

### 1. Ownership and the store

`revisions.json` is **server-owned**. Every read and write goes through `server/src/workspace/revisions-store.ts`, modelled on `server/src/workspace/script-review-ledger.ts`.

- **Lock:** `withKeyLock(\`revisions:${bookDir}\`)` (`file-lock.ts:218`). Reads and every decision derived from them happen inside the lock.
- **Leaf lock.** Verified: no generation, splice, QA-repair, finalize or chapter-audio code holds a cast, design or library-voice lock, and the reparse wipe's revisions branch is a sibling of its `withCastLock` branch, not nested in it (`book-state.ts:1132-1204`). Add the leaf rule to `cast-lock.ts:11-24`'s lock-order comment **and** to CLAUDE.md's matching rule 4. The header says to keep the two in sync.
- **Imports.** `revisions-store.ts` imports `file-lock`, the workspace path helpers, `preserve-previous-audio`, and `chapter-job-coordination` **only**. It must never import `routes/generation.ts` (see §2, busy check), or a madge cycle closes through `generation.ts → finalize-chapter-write.ts → revisions-store.ts`. `npm run check:cycles` must stay green with no allowlist entry.

**File shape, `schema: 1`:**
```ts
{ schema: 1,
  rev: number,                                  // monotonic, +1 on every write (§4 stale-response guard)
  pending: Revision[],                          // ≤1 entry per chapterId
  dismissed: string[],
  acceptedSelections: Record<revisionId, Record<segmentIndex, 'A'|'B'>>,
  timeline: Record<chapterId, TimelineEntry[]> }
```
Each `Revision` may carry `resolving?: { op: 'accept'|'reject', selection?, at }`, the R3 journal marker. The legacy `drift` copy is dropped; drift stays computed live by `computeRevisionsForBook` (`server/src/routes/revisions.ts:125`).

**`readRevisions(bookDir)`** normalises in memory and never writes. Every reader uses it, **including `GET /state`** (`book-state.ts:276-285`, which today reads the file raw):

- Drop `drift`, and default any missing field (`rev: 0`).
- **Legacy entries** have no epoch in their id (`splice-…`, `revision:<ch>:<char>`):
  - drop them if `playable:false`. Their `.previous` cannot be trusted to belong to them: a later regen may have replaced it;
  - keep them if `playable:true` **and** the chapter's `.previous` exists;
  - if several remain for one chapter, keep the last in array order.
- **An entry with `resolving` set** is finished by the next mutating op, or by `completeInterrupted(bookDir)`, run once per book at boot after fsck (§3). A pure read reports it as-is, and the client shows it disabled as "finishing…".

**Reparse and replace-manuscript** delete the file through the store, under the lock (`book-state.ts:1201-1203`). They first call `abortInFlightSplice(bookId, null)` (`chapter-job-coordination.ts:39`), so a splice cannot finish afterwards and record an entry against a renumbered chapter.

### 2. HTTP contract

All three ops answer `200 RevisionsState`:
```ts
{ bookId, rev, pending, dismissed, acceptedSelections, timeline }
```

**Per-chapter busy check: `isChapterBusy(bookId, chapterId)` in `server/src/routes/chapter-job-coordination.ts`.** It returns true if any of these holds:

- `inFlightSplices` has `(bookId, chapterId)` (this covers Fix-audio and QA repair; QA repair calls `registerSplice`, `chapter-qa-repair.ts:299-300`);
- **generation** has `${bookId}::${chapterId}` or `${bookId}::*` in flight (`inFlightByChapter`, `generation.ts` ~438-454).

Generation's map is reached through a **registered accessor** (`registerGenerationChapterProbe(fn)`, set by `generation.ts` at module init, failing **closed**, i.e. busy, when unset), following the `gpu/*-gate.ts` leaf-gate pattern in CLAUDE.md. That way `chapter-job-coordination.ts` keeps zero imports. `_hasInFlightSplice` (`:45`) stays as the test seam.

> Unverified: generation's stall watchdog (`Promise.race`, `generation.ts` ~2069) may deregister a job whose body is still running. The implementation plan must check whether the body can still reach finalize after deregistration. If it can, the busy check must also cover it.

**`POST /api/books/{bookId}/revisions/{revisionId}/accept`**, body `{ selection?: Record<segmentIndex,'A'|'B'> }`. Under the lock:

1. Look up the entry.
   - If it's absent and the timeline has `accepted` for this `revisionId`, return 200 with the current state (idempotent).
   - If it's absent otherwise, return 404 `revision_not_found`.
2. If `isChapterBusy`, return 409 `chapter_busy`.
3. **Refuse to lose the last copy.** If the live take is missing, return 409 `live_audio_missing` and change nothing.
4. Write the journal marker `resolving: {op:'accept', selection}` (one atomic write, `rev+1`).
5. Delete the `.previous` set (§3). A missing file counts as success.
6. Remove the entry, set `acceptedSelections`, and append the timeline `accepted` entry, keeping the reversible-chain rule from `appendTimelineEntryHelper`. One atomic write, `rev+1`.

**`POST …/{revisionId}/reject`** follows the same steps, except:

- step 1 checks for `rejected`;
- step 3 returns 409 `no_previous_audio` if the `.previous` set is missing;
- step 5 runs the **full restore** (§3);
- step 6 appends `rejected`.

**Finishing an interrupted op (R3).** When step 1 finds an entry with `resolving` set, it finishes **the journalled op, whatever the request asked for**, and resumes from step 5. If the request asked for the other op, the response is 409 `revision_resolving` with the finished state, so the client can show what actually happened.

- accept: deleting an already-deleted set is a no-op;
- reject: if the `.previous` audio is gone and the live take is present, the restore already happened, so skip to step 6.

Either way the result matches what the user asked for, and `completeInterrupted` applies the same rule at boot. No path records a timeline outcome that disagrees with the audio on disk.

**`POST /api/books/{bookId}/drift/{driftId}/dismiss`** adds the id to `dismissed` (idempotent). It answers `{ bookId, rev, dismissed }`. No busy check; no audio step.

**`GET /api/books/{bookId}/revisions`** (the active-book poll) answers `RevisionsState` plus live `drift`. `GET /api/revisions` (bulk) is unchanged.

`computeRevisionsForBook`'s return shape is changed in step with its third caller, `server/src/routes/qa-report.ts:13,30`.

**Errors**

- 404: unknown book.
- 400: malformed `selection` (non-integer keys, values outside `A`/`B`, dangerous keys as in `script-review-ledger.ts:46-52`).
- 409: the three codes above.
- 500: through `requestFailureMessage` (`file-lock.ts:214`), so no lock key or path reaches a body.
- CLAUDE.md's sentence "`git grep requestFailureMessage` enumerates all thirteen sites" is updated for the three new sites.

**Whole-file writes are closed.** `PUT /api/books/{bookId}/state` with `slice:'revisions'` returns **400 `revisions_server_owned`**.

**The two old routes** (`DELETE …/audio/previous`, `POST …/audio/previous/restore`, `chapter-audio.ts:374-441`) return **410 `moved`**, with their logic moved into the store. They are not deleted: an old tab's `acceptChapterRevision` treats **404** as success (`api.ts:10221`), so a 404 would fake success, and 410 surfaces as an error.

**OpenAPI** (then `npm run openapi:types`):

- the three routes, `RevisionsState`, `DriftDismissResponse`, and the 409 codes;
- `BookStateResponse.revisions` gains `timeline` and `rev`, and loses `drift`;
- `RevisionsResponse` takes the poll's new shape;
- the PUT and 410 descriptions.

### 3. Takes on disk: the `.previous` set

**What gets preserved.** `preserveExistingAsPrevious` (`preserve-previous-audio.ts`) preserves a complete **set** under `<slug>.previous.*`:

- the audio, **keeping its real extension** (`<slug>.previous.<ext>`, not always `.mp3`; fixes D4);
- `segments.json`, peaks, lufs, and embeddings where they exist;
- a new `<slug>.previous.take.json`, holding the chapter's `state.json` take fields (`duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa`, and any field `finalize-chapter-write.ts:373-402` writes per take).

It returns the existing `PreserveResult { preserved }`, which `finalize-chapter-write.ts:359` currently discards. **`preserved` is true only when the audio *and* segments were both preserved.** Today it reports true even when the segments rename failed.

**Accept** deletes the whole set.

**Reject's full restore (R1), with no moment where no live audio exists:**

1. Rename each `.previous.*` sidecar over its live counterpart, then the audio last (`rename` over an existing file replaces it; verify on Windows).
2. If the extensions differ, the stale live file of the other extension is removed **after** the rename.
3. Then apply `previous.take.json` back into `state.json` (the same read-modify-write `finalize` uses).
4. A failure at any step returns 500. The journal marker stays, so the retry or boot completion finishes it.

**Boot fsck** (`fsck-orphan-audio.ts`, `index.ts:208-230`):

- It recognises `.previous.<any audio ext>` and only promotes `.previous` when **no live audio of any extension** exists.
- It runs before `completeInterrupted`, per book, under the revisions lock.

### 4. Server-derived pending

`FinalizeChapterAudioInput` (`finalize-chapter-write.ts`) gains `review?: { characterId: string; triggeredBy: string }`. After the audio, segments and state are written:

- **`review` given and `preserved`:** `recordPending` upserts the chapter's single entry, **playable**, with:
  - `hasPreviousAudio: true`;
  - id `revision:<chapterId>:<finalize epoch ms>`. The id is unique per recording, so a late or duplicated accept of an earlier take returns 404 instead of approving a take the user never heard;
  - `triggeredBy` and the old/new durations.

  It replaces any older entry for that chapter.
- **No `review`, but the chapter has an entry:** `dropPendingForChapter`. Its side A was just overwritten.

  The flows that do this are all user-initiated: QA repair from the Listen row, drift "Regenerate", and "Regenerate now". An open player for that entry then gets 404, and shows "This take was replaced by a newer render" and closes.
- **`review` given but nothing preserved** (first render): no entry.
- **Failure (R2).**
  - `recordPending`/`dropPendingForChapter` errors are caught **inside finalize**, logged in full, and surfaced as `reviewRecorded: false` on `FinalizeChapterAudioResult`.
  - The three SSE completion events (`splice_complete`, generation's `chapter_complete`, QA repair's completion) carry it.
  - No message from it ever reaches an SSE body, so a lock-key path can never leak through `chapter-splice.ts:524-525`'s `fail(…message)` or its generation/QA siblings.

**Callers**

- **`chapter-splice.ts:492`** always passes `review`. Its "Loudness fix…" / "Re-record…" text moves server-side from `splice-runner-middleware.ts:55-67`.
- **`chapter-qa-repair.ts:720`** never passes it.
- **`generation.ts:1861`** passes it only when the job carries one:
  - `review` travels on the **persisted generation queue entry**, the thing `queue-dispatcher-middleware.ts:225-276` claims, not on transient `ui.previewRegen` (`ui-slice.ts:22-33`, which has no `bookId` and is never persisted).
  - It goes queue entry → `runner.open` spec (`generation-stream-runner.ts`) → `StreamArgs` (`api.ts:603`) → `GenerationRequestBody` → `RunningJob` → finalize.
  - The server **rejects with 400** a `review` on a request whose `chapterIds` is not exactly one chapter, so a back-compat `*` job can never tag every chapter.
  - The preview click handler (`layout.tsx:2064-2084`) sets `review` on the entry it enqueues.

### 5. Client

**API (`src/lib/api.ts`).**

- Add `acceptRevision`, `rejectRevision` and `dismissDrift`, each with a real and a mock implementation. The mocks apply the store's rules to `MOCK_BOOK_STATES` (`api.ts:917`), including the 409s and `rev`.
- **`mockPollRevisions` reads `MOCK_BOOK_STATES`** (fixes D7). The `PENDING_REVISIONS` fixture moves into the seeded mock state.
- `mockStreamSplice` records pending like finalize does, takes `bookId`, and accepts a test-controllable delay, so an e2e can switch books mid-splice.
- Remove `acceptChapterRevision` / `rejectChapterRevision`.

**Revisions slice (`src/store/revisions-slice.ts`): a cache.**

- **State:** `pending`, `drift`, `dismissed`, `acceptedSelections`, `timeline`, `loaded`, `bookId`, `rev`.
- **Writers:**
  - `hydrate({bookId, state})` adopts the book.
  - `applyServerState({bookId, state})` and `applyPoll(...)` are **ignored when `bookId` differs from the cache's, or when `state.rev < cache.rev`**. A poll that started before an op and lands after it can't resurrect the entry.
  - `applyDismiss({bookId, rev, dismissed})` is **multi-book**: it removes that book's dismissed events from `s.drift` whatever book the cache holds, and updates `dismissed`/`rev` only when the book matches.
  - `applyBackgroundPoll` is unchanged.
- **Delete:**
  - `hydratedFor`, `windowActions`, `recordIfUnhydrated`, `replayRecorded`;
  - `bookScopeChanged`, `bookWiped`, `persistPendingAfterHydrateMerge`;
  - `enqueuePending`, `markRevisionPlayable`;
  - the reducer halves of `acceptRevision`/`rejectRevision`/`dismissDrift`;
  - `acceptAllPending`, `rejectAllPending`, `rolledBack`.
- **Keep:** drift selectors and helpers, `mergeDriftForBook`, `normaliseTimelineKeys`.
- **Delete `src/store/revisions-scope-middleware.ts`** and its wiring in `src/store/index.ts`.

**Every dispatch site of a deleted action is updated in the same task as the deletion:**

| Site | Change |
|---|---|
| `src/routes/index.tsx:155,196,252` | `revisionsActions.bookWiped` → removed; the server-side reparse/replace wipe plus the next hydrate cover it. |
| `e2e/profile-regen-preview.spec.ts:96-101` | The `rejectAllPending` phantom-clearing workaround is removed. It's unnecessary once D6 and D7 are fixed. |
| `e2e/marketing/scenes.ts:1060,1087` | `rejectAllPending` / `markRevisionPlayable` → seed the mock state directly. |
| `src/lib/build-pending-revision.ts` | Deleted, if nothing else uses it. |

**Persistence middleware.** Remove the nine `revisions/*` rules, `revisionsPatch` (`:313`), and the revisions hydrate gate (`:486-490`). The `${bookId}:${slice}` flush key and flush-on-book-change stay, because every persisted slice shares them.

**Thunks (`src/store/revisions-thunks.ts`): confirm, then apply, with no optimistic update.**

- `acceptRevisionOp` / `rejectRevisionOp` → `applyServerState`.
- `dismissDriftOp` posts to **the event's own book** → `applyDismiss`.
- Errors:
  - `chapter_busy` → toast "This chapter is busy — try again when it finishes".
  - `no_previous_audio` → the player's "Original audio not preserved" state, with **Keep new take** (= accept).
  - `live_audio_missing` → error toast; the entry stays.
  - `revision_not_found` → "This take was replaced by a newer render"; refetch.
  - Anything else → toast. The cache is unchanged.

**Layout (`src/components/layout.tsx`).**

- Book-open hydrate (`:825-925`) dispatches `hydrate`. The `persistPendingAfterHydrateMerge` follow-up and the revisions retry loop go. A failed read leaves the cache unloaded, and the next poll fills it.
- Accept (`:2485-2527`) and reject (`:2549-2568`) dispatch the thunks. The **preview side effects run only after success**:
  - accept: drop the preview, append the change-log entry, enqueue the remaining chapters;
  - reject: drop the preview.
- **The A/B player opens a specific entry**, not `pending[0]` (fixes D6):
  - the preview opens the entry for `previewChapterId`;
  - the Listen row opens its own chapter's entry;
  - `RevisionDiffPlayer` receives `revisionId`.
- Dismiss (`:2199`) → `dismissDriftOp`.
- The active poll (`:1108-1125`) → `applyPoll` with the full state.

**`src/views/revision-diff.tsx`** (reads `revision.playable` at `:72,187,256,260,281,324`):

- Its "Rendering new take…" state is driven by a new prop `rendering`, derived from splice-slice in-flight state.
- It gains the **Keep new take** action and a `busy` prop that disables the buttons while an op is in flight.
- An entry carrying `resolving` renders disabled as "Finishing…".

**Splice slice (`src/store/splice-slice.ts:31-45`)** gains `inFlightChapterIds: number[]` per batch, maintained by the splice runner. It is the source for the Listen row's and the player's "Rendering new take…" state, because pending entries now appear only when a take is complete.

**Runners.**

- `splice-runner-middleware.ts`:
  - remove the `enqueuePending`/`markRevisionPlayable` dispatches (`:68-70`, `:123-124`);
  - maintain `inFlightChapterIds`;
  - on `splice_complete` for the cached book, refetch revisions;
  - on `reviewRecorded:false`, show the R2 warning.
- **The preview hook.** Today the preview gate fires *on* the `revisions/markRevisionPlayable` action (`generation-stream-middleware.ts:169`), which is being deleted. The runner gets a new action, `chapters/previewChapterComplete({bookId, chapterId, reviewRecorded})`. `generation-stream-runner.ts` dispatches it whenever a `chapter_complete` tick's job carried `review`, **for any book, not only the viewed one** (`:345-354` only forwards ticks for the viewed book). The middleware then refetches revisions and opens the player on that chapter's entry.
- Remove `generation-stream-runner.ts`'s `markRevisionPlayable` dispatch.

### 6. Compatibility and rollout

- Files on disk are normalised on read (§1). Historical lost entries are not recreated; the fix is forward-only.
- An old tab: its revisions PUT gets 400, and its accept/reject gets 410. Both are logged and surfaced. Nothing on disk changes.
- Existing m4a/ogg books with a `.previous.mp3` from before this change: fsck's "no live audio of any extension" rule stops treating it as an orphan, and accept/reject find it by glob.

## Testing

Every behavioural item ships with its paired test, each mutation-checked: revert the fix and observe red.

**Server, `revisions-store`**

- Each op, including the idempotent retries and `live_audio_missing`.
- **The journal:** inject a failure after the marker, at each step of the restore, and after the audio step, then show that the retry and `completeInterrupted` reach the requested outcome, with the timeline matching the audio on disk.
- **Reject's full restore** brings back the audio, segments, peaks, lufs, embeddings and the state.json take fields, for **mp3 and m4a**. Live audio exists at every intermediate step (assert after each injected failure).
- Lock serialisation: accept racing `recordPending`, in both orders.
- Legacy normalisation: each rule in §1.
- `rev` increases on every write.
- `selection` validation.

**Server, other**

- `isChapterBusy`: per chapter, the `::*` case, and the unset accessor failing closed.
- `check:cycles` stays clean.
- Finalize records, drops or skips per §4, and sets `reviewRecorded:false` on an injected store failure, with no message in any SSE body.
- 400 on a `review` with more than one chapter.
- Route status codes. `PUT slice:'revisions'` returns 400. The old routes return 410.
- A lock timeout returns the curated body.
- `GET /state` returns normalised revisions.
- `qa-report` still works with the new `computeRevisionsForBook` shape.
- fsck with m4a pairs, and a live file under a different extension.
- Reparse aborts in-flight splices.

**Client**

- Foreign-book and stale-`rev` payloads are ignored.
- `applyDismiss` across books.
- Each thunk outcome. Preview side effects run only on success.
- **No revisions PUT is ever sent**, asserted over every `putBookState` call.
- The player opens the requested entry, not `pending[0]`.
- `previewChapterComplete` fires for a non-viewed book.
- Mock and real implementations pass one shared contract test.
- The mock poll reads per-book state.

**e2e (mock mode)**

- Fix-audio on A with a controlled delay → switch to B → completion → back to A: the prompt is present and playable.
- `profile-regen-preview.spec.ts` passes **without** its phantom workaround.

The e2e exercises the mock's imitation of finalize, so the server half is covered by the server tests above and by on-box acceptance.

**On-box acceptance** (register row; real sidecar, real book, **one mp3 and one m4a book**):

- splice → book switch → the prompt appears;
- accept → the `.previous` set is gone;
- re-splice → reject → the original take, duration, waveform and loudness all return;
- restart the server between the two → the pair survives fsck;
- reject a chapter that is rendering → 409, and pending is unchanged.

## Not in scope

- Timeline rollback (`rolledBack` has no UI and is removed).
- Cross-tab sync of the cache. It is no longer needed for correctness.
- Recovering pre-existing lost entries.
- Drift computation.
- Reparse/replace refusing to run during active **generation**. That is pre-existing, and it's a policy decision, so file it as its own issue naming that decision. This spec only aborts splices so that pending can't be recorded against renumbered chapters.

## Delivery

- One branch, `fix/server-3400-revisions-server-ops` (worktree `C:\Claude\Projects\wt-3400-revisions-server-ops`).
- One PR with `Closes #3400` and `Closes #3397`.
- A regression plan `docs/features/285-revisions-server-ops.md` plus an INDEX entry, release notes in both files, an on-box register row on all three surfaces, and the two CLAUDE.md sentence updates (lock order, `requestFailureMessage` count).

**Order** (the implementation plan cuts the children):

1. Server: store + journal.
2. `.previous` set + fsck.
3. Busy probe.
4. Ops + routes + OpenAPI.
5. Finalize recording + `review` plumbing.
6. Client: API + mocks.
7. The cache + its dispatch sites.
8. Thunks + layout + player.
9. Runners + the splice slice.
10. e2e.
11. **Then** the server's 400 on the revisions PUT and the 410 on the old routes, once no client code sends either.
12. Docs and the register.

**Expect about 15 children.** If the plan's task count goes much past that, the plan should propose splitting delivery into two PRs (server, then client) rather than producing children that can't finish.
