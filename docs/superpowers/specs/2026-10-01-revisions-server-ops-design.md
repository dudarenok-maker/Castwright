---
status: draft
revision: 5 (revisions-only scope, chosen by the operator 2026-10-02 after four assumption-checker passes)
issues: "#3400, #3397"
supersedes-client-guards-from: "#3376 / PR #3395 (merged 9f379fb6)"
---

# revisions.json becomes server-owned: per-operation writes

## Problem

`<bookDir>/.audiobook/revisions.json` holds:
- the pending A/B takes;
- dismissed drift;
- accepted segment selections;
- the Revision History timeline.

**The client writes it as a whole-file replace.** The persistence middleware PUTs the entire slice through nine `revisions/*` rules built by `revisionsPatch` (`src/store/persistence-middleware.ts:231-251`). The server writes that over the file with no lock and no validation (`server/src/routes/book-state.ts:789-790`). Any stale client state erases disk. PR #3395 (#3376) added client guards over six review passes, and each closed one ordering and opened another (#3400).

**Pending entries are client-created and only for the active book** (#3397):
- **Stuck:** a Fix-audio entry enqueued `playable:false` never flips if the user leaves the book first.
- **Lost:** a splice that runs while its book is not active never gets an entry.

### Also fixed here

| | Defect | Evidence |
|---|---|---|
| D1 | Accept and reject are not atomic. The slice action persists *before* the audio call, so a 409 on restore leaves the timeline saying "rejected". | `layout.tsx` ~2485-2568 |
| D6 | The A/B player opens `pending[0]`, not the entry the user came for. A leftover entry can become the preview player, and approving it skips the preview fan-out. | `layout.tsx:2474-2479,2509` |
| D7 | `mockPollRevisions` returns the canned fixture for every book and ignores `MOCK_BOOK_STATES`. | `src/lib/api.ts:1931-1973` |
| D8 | `computeRevisionsForBook` returns `pending: []` whenever the cast is empty. | `server/src/routes/revisions.ts:132-135` |

### Not fixed here: the chapter-take lifecycle (one new design issue)

Four spec passes showed that making the **audio files** of an A/B pair safe means owning the whole lifecycle of a chapter's takes. That lifecycle has many unfenced writers and readers: finalize, restructure (split/merge/rename/refresh-titles), export, companion sync, and the boot fsck. That needs its own design. This deliverable leaves every audio-file behaviour **exactly as it is today** and files one design issue, **"Chapter take lifecycle: ownership of live and `.previous` audio"**. Its input is the four passes' findings, including:

- reject deletes the live take before restoring, and a failed restore followed by Approve leaves no audio (`chapter-audio.ts:420-438`);
- a failed segments rename is swallowed;
- reject restores only audio and segments; the `state.json` take fields, loudness, peaks and embeddings stay with the rejected take;
- lufs is written before preserve runs (`finalize-chapter-write.ts:210` vs `:359`);
- `state.json` has unlocked whole-file writers;
- no exclusion between accept/reject and jobs:
  - splice and QA repair read files before registering;
  - stalled or displaced generation bodies keep finalizing (`generation.ts` ~2077-2084);
- restructure leaves `.previous.*` under the old slug, and fsck later promotes it into a stray `<oldslug>.mp3`;
- split and merge keep the chapter id but delete the live take, so `.previous` survives;
- a failed finalize rename (`:365`) leaves the live take missing and P set to the take under review;
- `.previous` is always named `.mp3`, and the A-side routes are mp3-only;
- reparse races in-flight jobs (`abortInFlightSplice(bookId, null)` is a no-op);
- a fingerprint, marker or exclusion-counter approach was tried, and the passes record why each fell short.

The issue names its owed decision: **which component owns a chapter's live and `.previous` files, and how other writers are fenced.**

### Dispatched now as an independent fix

**Boot fsck destroys valid m4a/ogg A/B pairs.** It tests the literal `<slug>.mp3` (`fsck-orphan-audio.ts:80-91`), so on every boot it promotes `.previous.mp3` over a live `.m4a`/`.ogg`. The fix: promote only when no live audio of any extension exists. It gets its own issue, branch and PR, with no design needed.

## Decisions

Recorded by the operator on #3400/#3397 and in session, 2026-10-01/02:

1. Server-side per-operation writes. The client never writes revisions.json.
2. Server-derived pending, for every source.
3. Accept and reject are each **one server request** that runs the audio step and the JSON write in that order. The JSON is written only if the audio step succeeded.
4. One route per operation.
5. #3395's client guard machinery is deleted from `main`.
6. **Revisions-only scope.** The audio step is today's code, moved but unchanged. The take lifecycle is filed separately (above).
7. Two PRs: PR 1 is the server, dark; PR 2 is the client cutover.

## Design

### 1. The store

**`server/src/workspace/revisions-store.ts`** owns every read and write of revisions.json. It is modelled on `script-review-ledger.ts`.

**Writes** run under `withKeyLock(\`revisions:${bookDir}\`)` (`file-lock.ts:218`). The read, and every decision derived from it, happens inside the lock. **No file other than revisions.json is touched while the lock is held.**

**It is a leaf lock.** Nothing acquires another lock class while holding it. Verified: generation, splice, QA repair, finalize and chapter-audio hold no cast, design or library-voice lock, and the reparse wipe's revisions branch sits beside its `withCastLock` branch rather than inside it (`book-state.ts:1132-1204`). Add the rule to the lock-order comment in `cast-lock.ts:11-24` and to CLAUDE.md's rule 4.

**Reads** (`readRevisions`) take no lock. `writeJsonAtomic` renames atomically, so a reader sees one whole version. The GET handlers therefore cannot hit a lock timeout and need no new curation sites.

**File shape, `schema: 1`:**
```ts
{ schema: 1,
  fileId: string | null, // minted (random) on the store's first write; a missing or legacy file reads as null
  rev: number,           // +1 on every write within one fileId; a missing file reads as 0
  pending: Revision[],   // ≤1 entry per chapterId
  dismissed: string[],
  acceptedSelections: Record<revisionId, Record<segmentIndex, 'A'|'B'>>,
  timeline: Record<chapterId, TimelineEntry[]> }
```

Server-recorded entries carry `origin: 'server'`. Legacy (client-written) entries don't.

**Normalisation on read** never writes. It:
- drops the legacy `drift` copy;
- defaults missing fields;
- drops legacy entries with `playable:false`;
- keeps legacy `playable:true` entries only if `.previous.mp3` exists;
- keeps the last entry when a chapter has several.

**Reparse and replace** delete the file **through the store**, under its lock (`book-state.ts:1199-1203` today `rm`s it outside any lock). An op's final write can then never recreate a just-wiped file.

### 2. HTTP contract

**Accept and reject return `200 RevisionsState`**:
`{ bookId, fileId, rev, pending, dismissed, acceptedSelections, timeline }`.

**Dismiss returns `200 DriftDismissResponse`**: `{ bookId, fileId, rev, dismissed }`.

**The audio step is today's code.** The bodies of `DELETE …/audio/previous` (`chapter-audio.ts:374-395`) and `POST …/audio/previous/restore` (`:400-441`) move unchanged into two exported functions in `server/src/audio/previous-audio.ts`:
- `acceptPreviousAudio(bookDir, slug)`: deletes `.previous.*`. Returns `'deleted' | 'none'`.
- `restorePreviousAudio(bookId, bookDir, slug)`: keeps today's `isGenerationActive` 409, its delete-then-rename order, and its swallowed segments rename. Returns `'restored' | 'none' | 'busy'`.

The old routes call them in PR 1, so their behaviour is byte-for-byte today's.

#### `POST /api/books/{bookId}/revisions/{revisionId}/accept`

Body: `{ selection?: Record<segmentIndex,'A'|'B'> }`.

1. **Under the lock:** find the entry.
   - It's absent, but the timeline has an `accepted` entry with this `revisionId` → 200 with the current state.
   - Otherwise absent → 404 `revision_not_found`.
2. **Outside the lock:** `acceptPreviousAudio`. Both `'deleted'` and `'none'` proceed; `'none'` is today's 404-as-success. A thrown error → 500, and the JSON is untouched.
3. **Under the lock:** re-read, then:
   - remove the entry, if it is still there;
   - set `acceptedSelections`;
   - append `accepted`, using the reversible-chain rule from `appendTimelineEntryHelper`;
   - write once, `rev + 1`.

#### `POST …/{revisionId}/reject`

1. **Under the lock:** as accept's step 1, but the idempotence check looks for a `rejected` entry with this `revisionId`. An `accepted` one does not count.
2. **Outside the lock:** `restorePreviousAudio`.
   - `'busy'` → 409 `chapter_busy`.
   - `'none'` → 409 `no_previous_audio`. The UI offers **Keep new take**, which is accept.
   - A thrown error → 500, and the JSON is untouched.
3. **Under the lock:** remove the entry and append `rejected`. One write, `rev + 1`.

**Residual (filed with the take-lifecycle issue):** if the audio step succeeds and step 3's write then fails, the response is 500, the entry stays, and the audio is the restored take. A retried reject gets `no_previous_audio`. Choosing Keep new take would then record `accepted` while the old take is live. Making that impossible needs the lifecycle design. It requires a JSON write failure right after a successful rename, both on the same disk.

#### `POST /api/books/{bookId}/drift/{driftId}/dismiss`

Adds the id to `dismissed`. It is idempotent and touches no audio.

#### Polls

- `GET /api/books/{bookId}/revisions` (the active-book poll) returns `RevisionsState` plus live `drift`.
- `GET /api/revisions` (bulk) returns `{byBookId:{[id]:{pending, drift}}}`, with pending read through the store.
- `computeRevisionsForBook` (`revisions.ts:125`) changes shape in step with all three of its callers, including `server/src/routes/qa-report.ts:13,30`. It returns pending even when the cast is empty (D8).

#### Errors

| Status | Cause |
|---|---|
| 404 | Unknown book, or `revision_not_found`. |
| 400 | Malformed `selection`: non-integer keys, values outside A/B, or dangerous keys as in `script-review-ledger.ts:46-52`. |
| 409 | `chapter_busy` or `no_previous_audio`. |
| 500 | Through `requestFailureMessage` (`file-lock.ts:214`). |

The CLAUDE.md sentence "`git grep requestFailureMessage` enumerates all thirteen sites" is updated for the three new sites.

#### OpenAPI

Then run `npm run openapi:types`.
- Add the three routes, `RevisionsState`, `DriftDismissResponse` and the 409 codes.
- `Revision` gains an optional `origin`.
- `BookStateResponse.revisions` gains `timeline`, `fileId` and `rev`.
- `RevisionsResponse` takes the poll's new shape.
- Update the bulk response's description.

### 3. Server-derived pending

`FinalizeChapterAudioInput` (`server/src/audio/finalize-chapter-write.ts`) gains `review?: { characterId: string; triggeredBy: string } | null`:

| Value | Behaviour |
|---|---|
| `undefined` | Finalize leaves revisions.json alone. **This is PR 1's dark state.** Every caller passes it until PR 2. |
| `null` | A plain render. Drop the chapter's pending entry: its A side was just overwritten. |
| object | A review render. If `preserveExistingAsPrevious` actually preserved, upsert the chapter's single entry. Otherwise (a first render) drop any entry. |

- **Whether it preserved:** read `PreserveResult.preserved`, which `:359` currently throws away.
- **The upserted entry:** `playable:true`, `hasPreviousAudio:true`, `origin:'server'`, id `revision:<chapterId>:<epoch ms>`, `triggeredBy`, and the old/new durations. A per-recording id means a late accept of an earlier take returns 404 instead of approving a take the user never heard.
- **Failure is best-effort with respect to the render.** The store call is wrapped inside finalize. Errors are logged in full and surface only as `reviewRecorded: false` on the result and on the three SSE completion events (`splice_complete`, generation's `chapter_complete`, QA repair's completion). No store error text reaches an SSE body, so the lock-key path never leaks through `chapter-splice.ts:524-525`'s `fail(…message)` or its siblings.
- **Residual, filed with the lifecycle issue:** a failed upsert or drop leaves the chapter's older entry pointing at a `.previous` that was just overwritten.

**Callers in PR 2:**
- `chapter-splice.ts:492` passes `review`. Its "Loudness fix…"/"Re-record…" text moves server-side from `splice-runner-middleware.ts:55-67`.
- `chapter-qa-repair.ts:720` passes `null`.
- `generation.ts:1861` passes the job's `review`, or `null`.

**`review` on generation** (the code lands in PR 1, unused until PR 2) travels on the **persisted queue entry**:
1. `enqueueQueueEntries` (`src/store/queue-thunks.ts`)
2. `POST /api/queue/enqueue`, adding it to the whitelist at `server/src/routes/queue.ts:107-118`
3. `enqueue()`'s whitelist (`server/src/workspace/queue-io.ts:122-139`), plus `QueueEntry`/`EnqueueInput` and OpenAPI `QueueEntry`
4. the claim in `queue-dispatcher-middleware.ts:225-276`
5. the `runner.open` spec, then `StreamArgs` (`api.ts:603`), then `GenerationRequestBody` and `RunningJob`
6. finalize

Two server rules apply to it:
- A request carrying `review` that does not name exactly one chapter gets a **400 before the SSE headers are flushed** (`generation.ts:724`).
- `chapter_complete` carries `reviewChapter: true` **only for the chapter actually rendered with `review`**, never for the replayed done chapters (`generation.ts:1176-1194`).

A server test round-trips `review` through enqueue and claim into the request.

**Restructure** (`chapters-restructure.ts`) in PR 2: after its audio ops, it drops pending entries for every chapter the operation touched, whether its id changed, its content changed with the same id (split/merge), or only its slug changed (rename/refresh-titles). Their `.previous` files no longer pair with the live take.
- The drop is **best-effort**. It is logged, and its error never reaches a response. The six handlers' raw `(e as Error).message` returns (`:223, 251, 303, 334, 399, 421`) can therefore never carry a lock-key path.
- Restructure takes no other new behaviour; the lifecycle issue owns the `.previous` orphaning.

### 4. Client (PR 2)

#### API (`src/lib/api.ts`)

- Add `acceptRevision`, `rejectRevision` and `dismissDrift`, each real and mock. The mocks apply the store's rules to `MOCK_BOOK_STATES` (`api.ts:917`).
- The mock fixture's seeded entry gets `origin:'server'`.
- `mockPollRevisions` reads `MOCK_BOOK_STATES` (D7).
- `mockStreamSplice` records pending as finalize does, takes `bookId`, and takes a test-controllable delay.
- Remove `acceptChapterRevision` and `rejectChapterRevision`.

#### Revisions slice: a cache

`src/store/revisions-slice.ts` keeps `pending`, `drift`, `dismissed`, `acceptedSelections`, `timeline`, `loaded`, `bookId`, `fileId` and `rev`.

**Writers:**
- `hydrate({bookId, state})` always adopts.
- `applyServerState` and `applyPoll`:
  - **Callers dispatch only payloads whose `bookId` equals the current `ui.stage.bookId`**, read at dispatch time. That covers the thunks, the active poll, and the runners' refetches, which use the active book, never "the cached book".
  - The reducer adopts a different `bookId`.
  - For the same book, it adopts a different **non-null** `fileId`. A `fileId: null` payload is adopted only when the cache's `fileId` is also null and `rev` is not lower.
  - Within one `fileId`, it ignores `state.rev < cache.rev`.
- `applyDismiss({bookId, fileId, rev, dismissed})`:
  - removes that book's dismissed events from `s.drift`, whatever book is cached;
  - updates `dismissed` only for the cached book with the same `fileId`;
  - sets `rev` to `max(cache.rev, rev)`.
- `applyBackgroundPoll` is unchanged.

**Selectors return empty** for `pending`, `timeline` and `acceptedSelections` when `cache.bookId` ≠ the active book. The raw readers move onto these selectors: `layout.tsx:195`, `src/modals/revision-timeline-modal.tsx:56`. Layout's reload short-circuit, gated on `hydratedFor` (`layout.tsx:202`, `:787-845`), is re-gated on `revisions.bookId === bookId && revisions.loaded`.

**Delete:**
- `hydratedFor`, `windowActions`, `recordIfUnhydrated`, `replayRecorded`;
- `bookScopeChanged`, `bookWiped`, `persistPendingAfterHydrateMerge`;
- `enqueuePending`, `markRevisionPlayable`;
- the reducer halves of `acceptRevision`, `rejectRevision` and `dismissDrift`;
- `acceptAllPending`, `rejectAllPending`, `rolledBack`;
- `src/store/revisions-scope-middleware.ts` and its wiring in `src/store/index.ts`;
- `buildPendingRevisionStub` (`src/lib/build-pending-revision.ts`).

| Dispatch site | Change |
|---|---|
| `src/routes/index.tsx:155,196,252` (`bookWiped`) | removed |
| `e2e/profile-regen-preview.spec.ts:96-101` (phantom workaround) | removed |
| `e2e/marketing/scenes.ts:1060,1087` | seed mock state instead |
| `src/store/generation-stream-middleware.ts:169-179` (preview gate) | replaced by `chapters/previewChapterComplete` |
| `src/components/layout.tsx:202`, `:787-845` (`hydratedFor`) | re-gated as above |

#### Persistence middleware

- Remove the nine `revisions/*` rules, `revisionsPatch` (`:313`) and the revisions hydrate gate (`:486-490`).
- The `${bookId}:${slice}` flush key and flush-on-book-change stay; every persisted slice shares them.

#### Thunks (`src/store/revisions-thunks.ts`): confirm, then apply

- `acceptRevisionOp` and `rejectRevisionOp` call their route, then `applyServerState`.
- `dismissDriftOp` posts to the event's own book, then `applyDismiss`.

| Response | UI |
|---|---|
| `chapter_busy` | Toast: "This chapter is busy — try again when it finishes". |
| `no_previous_audio` | "Original audio not preserved", with **Keep new take**. |
| `revision_not_found` | "This take was replaced by a newer render", then refetch. |
| anything else | Toast; the cache is unchanged. |

#### Layout (`src/components/layout.tsx`)

- **Book-open hydrate** (`:825-925`) dispatches `hydrate`. The `persistPendingAfterHydrateMerge` follow-up and the revisions retry loop go; the next poll repairs a failed read.
- **Accept** (`:2485-2527`) and **reject** (`:2549-2568`) dispatch the thunks.
  - The player releases both `<audio>` elements first, as today.
  - The preview side effects run **only after success**: drop the preview, add the change-log entry, fan out the remaining chapters.
- **Dismiss** (`:2199`) dispatches `dismissDriftOp`.
- **The active poll** (`:1108-1125`) dispatches `applyPoll`.
- **The A/B player opens a specific `revisionId`** (D6).

**`PreviewRegenCtx`** (`src/store/ui-slice.ts:22-33`) gains `bookId`, and the fan-out uses it. It stays transient: after a reload, Approve does not fan out, which is today's behaviour and is stated in the regression plan.

**`src/views/revision-diff.tsx`** (which reads `revision.playable` at `:72,187,256,260,281,324`):
- a `rendering` prop drives "Rendering new take…";
- **Keep new take** is added;
- a `busy` prop disables the buttons while an op is in flight.

**Splice slice** (`src/store/splice-slice.ts:31-45`) gains `inFlightChapterIds`, which the runner maintains. It is the source of "Rendering new take…".

#### Runners

**`splice-runner-middleware.ts`**:
- drop its pending dispatches (`:68-70`, `:123-124`);
- maintain `inFlightChapterIds`;
- on `splice_complete` for the **active** book, refetch;
- on `reviewRecorded:false`, toast "The new take is live, but its A/B review couldn't be saved".

**`generation-stream-runner.ts`** dispatches `chapters/previewChapterComplete({bookId, chapterId, reviewRecorded})` only for a `chapter_complete` with `reviewChapter: true`. It does this for any book, because today only the viewed book's ticks are forwarded (`:345-354`).
- **Active book:** the middleware refetches and opens the player on that entry.
- **Otherwise:** toast "Preview ready in ‹book›".
- Its `markRevisionPlayable` dispatch is removed.

## Compatibility and the two PRs

**PR 1: the server, dark.** §1–§3 land, with these exceptions:
- every finalize caller passes `review: undefined`;
- restructure's pending drop is not wired;
- the old routes call the extracted audio functions, with byte-for-byte today's behaviour;
- `PUT /state` with `slice:'revisions'` is still accepted;
- `GET /state` returns revisions.json **raw**, so the old client's `hydrateFromBookState` still sees `drift` (`revisions-slice.ts:396-402`).

The new routes and the store exist but nothing calls them. The only PR 1 changes an old client could observe are the reparse wipe moving under the lock (same result), and D8 (pending with an empty cast), which the old `applyPoll` ignores (`revisions-slice.ts:318-322`).

**Invariant on `main` between PR 1 and PR 2: the client is the only writer of `pending`.**

**PR 2: the client cutover.** All of §4, plus:
- callers pass `review`/`null`;
- the restructure drop is wired;
- `GET /state` is normalised;
- `PUT slice:'revisions'` returns **400 `revisions_server_owned`**;
- the two old routes return **410 `moved`**, never 404: the old client's `acceptChapterRevision` treats 404 as success (`api.ts:10218-10221`).

On rollout, an old tab gets those 400s and 410s, which are logged and surfaced, and disk is unchanged. Files on disk are normalised on read. Historically lost entries are not recreated.

## Testing

Every behavioural item has a paired test, mutation-checked: revert the fix and observe red.

### PR 1

**Store:**
- each op, including idempotent retries; a reject does not treat an `accepted` timeline entry as its own;
- **the JSON is untouched when the audio step throws, returns `busy`, or returns `none` on reject**;
- lock serialisation: accept racing `recordPending` on one book, in both orders;
- normalisation;
- `fileId`/`rev`;
- `selection` validation;
- reparse deleting through the store while an op's final write waits, so the file is not recreated.

**Audio extraction:** the old routes' existing tests pass unchanged against the extracted functions. Add tests for any branch they don't cover.

**Finalize:**
- the `review` tri-state, keyed on `preserved`;
- a store failure → `reviewRecorded:false`, with no store text in any SSE body;
- a test over the three call sites asserting they pass `undefined`.

**Routes:**
- status codes;
- a curated 500 on a lock timeout;
- pending with an empty cast;
- `qa-report` unaffected;
- `review` round-trips through enqueue and claim;
- a multi-chapter `review` gets 400 before SSE;
- `reviewChapter` set only on the rendered chapter.

### PR 2

**Client:**
- the cache rules (foreign book, `fileId`/`rev`, null `fileId`, `applyDismiss` across books, rev monotonic);
- selectors empty for a non-active book;
- every thunk outcome;
- preview side effects only on success, with the fan-out under `previewRegen.bookId`;
- **no revisions PUT is ever sent**, asserted over every `putBookState` call;
- the player opens the requested entry;
- `previewChapterComplete` only on `reviewChapter`, and for a non-viewed book;
- the mock/real contract test;
- the mock poll reads per-book state.

**Server switches:**
- each caller's `review` value;
- the restructure drop for id-changed, split/merge and rename, best-effort, with no message leak;
- the 400 and 410;
- `GET /state` normalised.

**e2e (mock):**
- Fix-audio on A with a controlled delay → switch to B → completion → back to A: the prompt is present and playable (#3397);
- `profile-regen-preview.spec.ts` passes without its workaround.

**On-box acceptance** (a register row owed by PR 2; real sidecar, real book):
- splice → switch books → the prompt appears;
- accept → `.previous` is gone;
- re-splice → reject → the original audio returns;
- reject during generation → 409, and pending is unchanged.

## Delivery

- **PR 1:** branch `fix/server-3400-revisions-server-ops` (this worktree), `Refs #3400`, `Refs #3397`.
- **PR 2:** a new branch from `main` after PR 1 merges, `Closes #3400`, `Closes #3397`.
- **PR 1 also adds:**
  - the regression plan `docs/features/285-revisions-server-ops.md` and its INDEX entry;
  - the two CLAUDE.md sentence updates (the lock order and the `requestFailureMessage` count);
  - release notes. PR 1's are none: dark, with no shippable delta. Say so explicitly in the PR.
- **PR 2 also adds:** release notes, and the on-box register row on all three surfaces.
- **Before PR 1 starts:**
  - file the take-lifecycle design issue, carrying the four passes' findings;
  - file the fsck fix's issue and dispatch the fix.
- **Expected size:** PR 1 about 6 children plus verify, PR 2 about 7 plus verify.
