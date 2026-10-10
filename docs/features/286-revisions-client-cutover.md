---
status: active
shipped: null
owner: null
---

# 286 — revisions.json server-owned, PR 2: the client cutover (#3400, #3397)

> Status: active (revision 5 — assumption-checker passes 1, 2, 3 and 4 folded, plus the operator decisions of 2026-10-06 and 2026-10-07, including OD28–OD31; 32 tasks). PR 2 of 2. PR 1 (plan [285](285-revisions-server-ops.md), PR #3504, merged `ce142a3c`) landed the server half dark. This plan switches the client over and turns the server switches on.
>
> Key files:
> - Client, new: `src/store/revisions-thunks.ts`, `src/store/preview-thunks.ts`, `src/store/revision-player-middleware.ts`, `src/mocks/mock-revisions.ts`, `src/lib/revision-op-failure.ts`, `src/lib/build-preview-stub.ts` (renamed from `build-pending-revision.ts`).
> - Client, modified: `src/store/revisions-slice.ts`, `src/store/ui-slice.ts`, `src/store/chapters-slice.ts`, `src/store/splice-slice.ts`, `src/store/splice-runner-middleware.ts`, `src/store/generation-stream-runner.ts`, `src/store/generation-stream-middleware.ts`, `src/store/persistence-middleware.ts`, `src/store/index.ts`, `src/components/layout.tsx`, `src/components/revision-timeline-modal.tsx`, `src/views/revision-diff.tsx`, `src/lib/use-ab-playback.ts`, `src/lib/api.ts`, `src/lib/types.ts`, `src/routes/index.tsx`, `src/views/restructure.tsx` (OD31), `src/main.tsx`, `src/data/revisions.ts`.
> - Client, deleted: `src/store/revisions-scope-middleware.ts` (+ its test).
> - Server, modified: `server/src/routes/chapter-audio.ts`, `server/src/routes/revisions.ts`, `server/src/routes/revision-ops.ts`, `server/src/routes/qa-report.ts` (both handlers), `server/src/routes/book-state.ts` (GET, PUT, and `applyReparse`'s revisions reset), `server/src/routes/chapter-splice.ts`, `server/src/routes/chapter-qa-repair.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapters-restructure.ts`, `server/src/workspace/restructure.ts`, `server/src/workspace/revisions-store.ts`, `server/src/workspace/cast-lock.ts` (comment), `server/src/audio/previous-audio.ts` (comment), `server/src/audio/finalize-chapter-write.ts` (`reviewOutcome`, Task 7), `CLAUDE.md` (swallow-list sentence, Task 7).
> - Contract: `openapi.yaml`, `src/lib/api-types.ts` (generated).
> - e2e: new `e2e/revision-ops.spec.ts`, new `e2e/revisions-book-switch.spec.ts`, new `e2e/profile-regen-preview-recorded.spec.ts`; modified `e2e/profile-regen-preview.spec.ts`, `e2e/character-splice.spec.ts`, `e2e/marketing/scenes.ts`.
>
> URL surface: none new. The A/B player (`RevisionDiffPlayer`) and the Status popover's revisions action change behaviour.
>
> OpenAPI operations:
> - New: `POST /api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded`.
> - Changed: `GET /api/revisions` (gains `errors`), `GET /api/books/{bookId}/state` (`revisions` normalised, gains `revisionsError`), the `Revision` schema (gains `recovered`, OD20), `PUT /api/books/{bookId}/state` (`slice:'revisions'` → 400), `DELETE …/audio/previous` and `POST …/audio/previous/restore` (→ 410); the `splice_complete` / `qa_repair_complete` frames and `GenerationTick` replace `reviewRecorded` with `reviewOutcome` (new `ReviewOutcome` schema, Task 7).
> - First client callers: `POST …/revisions/{revisionId}/accept`, `…/reject`, `POST …/drift/{driftId}/dismiss`.

## Benefit / Rationale

- **User:**
  - A Fix-audio or preview take that finishes while you are on another book (or the Library) shows up as a normal, playable A/B prompt when you come back (#3397: no more stuck "Rendering…" rows). A preview is no longer lost by finishing elsewhere or by closing its player: it re-opens when you return to its book, and the Status popover re-opens it too (OD27, OD28). This holds for one preview at a time: `ui.previewRegen` is a single slot, so starting a second preview before the first is approved or rejected replaces the first (residual, Out of scope). If the chapter already has a pending server entry when the preview's player would open as a stub, that entry opens instead, as the preview's player (OD30). Re-parsing, replacing, restructuring or deleting the preview's book clears the preview; the new take stays live (OD31). The one deliberate exception is a preview whose take the server recorded and that was resolved while you were away (another tab, or a newer render). It is dropped with a "This preview was resolved elsewhere" notice instead of being offered again (OD29). The server now says which happened, so a preview of a chapter that had no audio yet still re-opens (Task 7). Takes already stuck "Rendering…" from before the update become reviewable again while the take kept before the chapter's last render is still on disk, labelled **Recovered from before the update** so the user knows the pairing may not be the one they started (OD20).
  - Accept and Reject only change the Revision History once the audio step actually succeeded (D1). A refused Reject no longer says "rejected".
  - A preview opens the player on the take that preview produced, so Approve always runs the preview's fan-out (D6). (The Status popover opens the preview's own entry first, else the first pending take — OD15, amended in PR #3594 review pass 1.)
  - One broken book no longer freezes the background drift badges of every other book (D9), and an unreadable review-history file is reported once instead of silently hiding every pending take (OD2).
- **Technical:** the client stops writing `revisions.json` at all. It becomes a cache of server state, ordered by `fileId`/`rev` and guarded against stale hydrates, so a stale tab or a slow response can no longer erase disk (#3400). About a dozen pieces of #3395's guard machinery are deleted.
- **Architectural:** one writer per file. The persistence middleware loses the whole-file-replace rule set that raced the server. The server's `review` seam (PR 1) goes live for splice, QA repair, generation and restructure.

## Architectural impact

- **New seams:**
  - `revisions-thunks.ts`: confirm-then-apply operations (`acceptRevisionOp`, `rejectRevisionOp`, `dismissDriftOp`, `refetchActiveRevisions`).
  - `preview-thunks.ts`: `startPreviewRegen`, `approvePreviewSideEffects`, `restoreUnrecordedPreview`.
  - `ui.openRevision` (`{kind:'server', revisionId, chapterId} | {kind:'preview-stub'} | null`) and `ui.revisionOpInFlight`.
  - `uiActions.openPreviewStub(stub)` (OD30, Task 13): sets the preview's stub and opens it in **one** action, so the player watcher never sees the stub without its player. `uiActions.clearPreviewForBook(bookId)` (OD31, Task 26).
  - `revisions.adoptSeq` + `hydrate({ requestSeq })`: the hydrate sequence guard.
  - `chapters/previewChapterComplete` (a `createAction`, no reducer).
  - `splice.inFlightChapters`.
  - `ui.previewRegen.completed` (`{ reviewOutcome?, stubFallback }`). OD27/OD28: it is set on **every** completion of the preview, so a finished preview stays re-openable on arrival at its book. `stubFallback` says whether a recorded completion whose refetch failed twice may still open a stub (OD23).
  - `reviewOutcome: 'recorded' | 'none' | 'failed'` on finalize's result and the three completion ticks (Task 7, replacing plan 285's `reviewRecorded` boolean). OD29 keys on it.
  - `selectActivePreviewStub` (ui slice). The preview stub is shown, and counted in the Status popover, only on its own book (OD28).
  - `Revision.recovered` (OD20: server-stamped on a recovered legacy stuck entry; the player labels it).
  - `src/mocks/mock-revisions.ts` + `window.__mockRevisions` + `window.__mockSpliceDelayMs`.
- **Invariants preserved:** OpenAPI stays the type source (the hand-written `BookStateResponse.revisions` is realigned to it, Task 17); every field added to an existing schema stays optional; the cast-lock rules (the revisions lock stays a leaf; `revision-op` → `revisions`); RTK Immer reducers; the discriminated `ui.stage`.
- **Migration:** none on disk. Legacy (origin-less) entries are normalised on read; they are shown to the user and accept/reject correctly (PR 1 commit `7d39752e`). A legacy `playable:false` entry whose `.previous.mp3` still exists is now surfaced as playable with `recovered: true` (read-only normalisation change, Task 6), so the #3397 "stuck" takes are recoverable and labelled as such (Task 16). The next unrelated store write persists the normalised entry (`playable: true, recovered: true`) — see Reversibility 9.
- **Reversibility:** revert the PR. See "Reversibility / observable changes" at the end.

## Invariants to preserve

1. **No `PUT /state` with `slice:'revisions'` is ever sent.** `StateSlice` (`src/lib/types.ts`) does not include `'revisions'`; `persistence-middleware.ts` has no `revisions/*` rule. Pinned by `src/store/persistence-middleware.revisions-never-put.test.ts` (Tasks 25, 26).
2. **The revisions cache only adopts a payload in order.** Different book → adopt. Same book: a newer `fileId` adopts, an older one is ignored (`null` is oldest), equal `fileId` ignores a lower `rev`. `hydrate` additionally adopts on any `fileId` difference — **unless** an op/poll adopted **changed** state after that hydrate's request started (the sequence guard; a no-op adoption — same book, `fileId` and `rev` — neither bumps `adoptSeq` nor drops an in-flight hydrate). Pinned in `revisions-slice.cache.test.ts` (Task 12) and `layout.test.tsx` (Task 18).
3. **Callers dispatch `applyPoll` / `applyServerState` only for the active book**, read at dispatch time. Pinned in the thunk tests (Task 14).
4. **Selectors return empty for a non-active book** (`selectActivePending`, `selectActiveTimeline`, `selectActiveAcceptedSelections`).
5. **Preview side effects (fan-out, change-log entry) run only after the accept succeeded**, and the fan-out targets `previewRegen.bookId`.
6. **The preview stub never lives in the revisions cache** — only in `ui.previewRegen.stub` — and is routed by `ui.openRevision.kind`, never by id or by a missing `origin`. It is shown (and counted in the Status popover) only while its book is the active one (`selectActivePreviewStub`, Task 13). Navigating away hides it and never clears it (OD28).
7. **The A/B player releases both `<audio>` elements before any op is sent, and re-attaches them on the next play** (Windows file handles; a refused op leaves the player usable).
8. **Server: no revisions-store error text reaches a client body, on the routes listed here.** Each answers a fixed sentence (or `UnsupportedSchemaError`'s own path-free "upgrade the server" sentence); the raw error goes to the log. Scope, exhaustively: `revision-ops.ts` ×3, `revisions.ts` ×2 (+ the bulk per-book `errors`), `qa-report.ts` ×2 (the GET, and `resume-scoring` — not a store path, curated by OD26), `restore-unrecorded`'s unreadable-file 500, `GET /state`'s `revisionsError`, the reparse / replace-manuscript revisions reset (Task 4 — only that arm; their other failures keep today's text), and the restructure drop (swallowed). Every path-freedom test drives a **mocked rejection whose message embeds an absolute path** (EPERM-style), never an `EISDIR` fixture: `EISDIR: illegal operation on a directory, read` carries no path, so asserting its absence proves nothing. The client's "unexpected" toast is a fixed sentence too; the OD2 toast shows the server's `revisionsError`, which this invariant makes path-free.
9. **Server: `restore-unrecorded` never writes revisions.json**, and takes the per-chapter `revision-op` key around the audio step.
10. **Server: normalisation never writes.** OD20's change only widens what the read view keeps (and stamps `recovered`). A later, unrelated store write does persist the normalised view — that is PR 1's existing `load → save` behaviour, not a write on read.

## Test plan

### Automated coverage

- **Slice cache + sequence guard** (`src/store/revisions-slice.cache.test.ts`, Task 12; `revisions-slice.test.ts` poll cases, Task 19).
- **API, real** (`src/lib/api-revision-ops.test.ts`, Task 9) and **mock** (`src/mocks/mock-revisions.test.ts`, Task 8; `src/lib/api.mock-revisions.test.ts`, created in Task 10 and extended in Task 11); **mock/real signature parity** (`api-types.revisions-contract.test.ts`, Task 9).
- **Thunks** (`src/store/revisions-thunks.test.ts`, Task 14; `src/store/preview-thunks.test.ts`, Task 15).
- **Player watcher** (`src/store/revision-player-middleware.test.ts`, Task 21).
- **Revision-diff view** (`src/views/revision-diff.test.tsx`, Task 16 — including the OD20 "Recovered from before the update" label).
- **Layout** (`src/components/layout.test.tsx`, Tasks 18, 19, 22); **routes** (`src/routes/index.test.tsx`, Task 26: delete / reparse / replace forget the cache and clear that book's preview, OD31); **restructure view** (`src/views/restructure.preview.test.tsx`, Task 26: a restructure clears the book's preview, OD31).
- **Splice runner** (`splice-runner-middleware.test.ts`, Task 20); **generation runner + middleware** (`generation-stream-runner.test.ts`, `generation-stream-middleware.test.ts`, Task 24 — including the re-open on arrival (OD27), every completion marked and nothing stranded (OD28), the recorded-but-gone drop (OD29), the A8 chapter wait, the post-await stale-state guard (pass 4 A1), and an **integration** describe that runs the generation middleware and the player watcher in one store to pin OD30); **player watcher** also covers the stub's book scope and a server entry superseding the stub (Task 21).
- **No revisions PUT** (`persistence-middleware.revisions-never-put.test.ts`, Tasks 25–26).
- **Server:** `finalize-chapter-write.test.ts` (Task 7: one test per review outcome), `chapter-audio.test.ts` (Tasks 1, 29), `revisions.test.ts` (Tasks 2, 3), `revision-ops.test.ts` (Tasks 3, 6), `qa-report.test.ts` (Task 3, both handlers), `book-state.reparse.test.ts` + `book-state.replace-manuscript.test.ts` (Task 4), `book-state.hydrate.test.ts` (Tasks 5, 29), `revisions-store.test.ts` (Tasks 1, 6, 28), `chapter-splice.test.ts`, `chapter-qa-repair.test.ts`, `generation.test.ts` via `test:slow` (Task 27), `restructure.test.ts` + `chapters-restructure.test.ts` via `test:slow` (Task 28).
- **Playwright** (mock mode): `e2e/revision-ops.spec.ts` (accept / reject / dismiss through the UI), `e2e/revisions-book-switch.spec.ts` (#3397), `e2e/profile-regen-preview-recorded.spec.ts` (a preview with a recorded server entry), Task 30; `profile-regen-preview.spec.ts` without its workaround (Task 24); `character-splice.spec.ts` waits for the refetch (Task 20).

### Manual acceptance walkthrough

Mock mode (`npm run dev:mock`):
1. Open **Solway Bay** (`#/books/sb/listen`). Status pill → **1 revision** → the player opens on chapter 3 in review mode, A and B both playable.
2. **Commit selection** → the player closes, the Status pill shows no pending revisions, and **Revision history** lists "Accepted revision" for chapter 3.
3. Reload. From the console: `window.__mockRevisions.seed('sb', { state: { pending: [{ id: 'rev1', chapterId: 3, characterId: 'eliza', segments: [], playable: true, hasPreviousAudio: true, origin: 'server' }] }, previousChapterIds: [3], liveChapterIds: [3] })`. Reopen the player → **Reject draft** → closes; history shows "Rejected revision".
4. Open **Carrick's Compass** cast, mark chapters rendered (as `character-splice.spec.ts` does), set `window.__mockSpliceDelayMs = 3000`, **Fix audio**, go to Solway Bay before it finishes, then back to Carrick's Compass → the Status pill shows the new take, and it is playable.
5. **Reload first.** Step 4's splice called `mockRecordRender(…, { assumeLive: true })` for every chapter it touched, which adds each to the mock store's `liveChapterIds`, so without a reload chapter 1 may already have audio and the preview would record an entry. A reload resets the in-memory mock store (as step 6 also relies on). Then, on Carrick's Compass, start a **profile-regen preview** and go to Solway Bay before it finishes. A "Preview ready in Carrick's Compass" toast appears. Go back, and the preview player opens by itself (OD27). Chapter 1 has no audio in the mock store, so the render is a first render (`reviewOutcome: 'none'`) and the player is the stub, with the A card reading "Original audio not preserved". To exercise the recorded path instead, run `window.__mockRevisions.seed('cc', { liveChapterIds: [1] })` first: going back then opens the recorded server entry.
6. Reload, which resets the mock store. Open Carrick's Compass, start a preview, and stay on the book until its stub player opens. Close it with the back arrow → the player hides. Status pill → **1 revision pending · Open** → the same preview player opens again (OD28). Go to Solway Bay and back → it opens by itself again.

Real backend: owed as on-box acceptance — a **new** register row (Task 31) plus the existing A9 steps that #3397 changes.

## Out of scope

- The chapter take lifecycle (#3456): every audio-file behaviour stays exactly as PR 1 left it.
- Any multi-step rollback; the `rolled-back` timeline kind stays renderable but nothing writes it.
- Writing anything to disk to migrate legacy entries (OD20 is read-only).
- **Two concurrent previews on different books** (residual, pre-existing): `ui.previewRegen` is a single slot, so starting a preview on book B while A's preview renders replaces A's context and A's Approve no longer fans out. Unchanged by this PR; the fan-out now at least targets the right book (`previewRegen.bookId`).
- **A second preview overwrites a finished, unresolved first one** (residual, pass 4 #10): the same single slot means OD27/OD28's re-open guarantee covers only the latest preview. Starting a new preview (on any book) while an earlier one is finished but not yet approved or rejected replaces the earlier context, `completed` marker and stub included. The earlier take stays live as its chapter's audio; a recorded server entry for it stays reachable from the Status popover on its book (OD15); an unrecorded (stub) one is no longer offered.
- **OD30 matches by chapter alone** (residual, deliberate — pass 4 #9): the entry lookup in `openPreview` and the watcher's rule 1 (Task 21) match a cache entry to the preview by `chapterId` only, never by `characterId`, `triggeredBy` or id. Any pending entry for the preview's chapter becomes the preview's player, including an older entry the preview did not produce. That is the decision (OD30), not an accident: the server's `has_revision` guard already refuses the stub's Reject while such an entry exists. If that cached entry turns out stale (the server dropped it and no poll has landed since), Approve answers `revision_not_found`, and the thunk refetches, closes the player and clears the preview with "This take was replaced by a newer render" (Task 14, OD10); the preview's take stays live.

## Ship notes

PR 2 (client cutover) is pending — opens in Task 32 as `fix(frontend,server):
revisions.json client cutover to server ownership (#3400)`, `Closes #3400`,
`Closes #3397`. Status stays `active` (not `stable`) until the on-box
acceptance register row (A113, added in Task 31) is run and accepted (OD18).

---

# revisions.json server-ownership — PR 2 (client cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the client a pure consumer of server-owned `revisions.json`: accept/reject/dismiss call the per-op routes, pending comes only from the server, #3395's client guards are deleted, the server records pending for every render, and the old write paths are closed.

**Architecture:** The revisions slice becomes a cache ordered by the server's `fileId`/`rev`, with a sequence guard against stale hydrates. Thunks call a route, then apply the returned state. Runners refetch instead of writing. The A/B player opens a specific entry through `ui.openRevision`. The preview path routes either to a recorded server entry or, when none was recorded, to a client-only stub kept in `ui.previewRegen`. Then the server switches on: finalize callers pass `review`/`null`, restructure drops stale entries, and the raw PUT and the two legacy audio routes are closed.

**Tech Stack:** React 18 + Redux Toolkit + Vitest/jsdom/RTL; Node 20 + Express + Vitest/supertest; OpenAPI 3.0.3 + openapi-typescript; Playwright (chromium, mock mode).

**Spec:** `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md` (rev 9), §4 and "Compatibility and the two PRs" → PR 2. Read it with plan 285's "Superseded by later commits" note and the shipped code; PR 1's review rounds added things the spec predates (see Global Constraints → "What PR 1 actually shipped"). Where this plan and the spec disagree, the plan's Open decisions say why.

**Base:** a new branch off `main` at or after `3587e132` (contains PR 1 `ce142a3c` and the fsck fix #3457 `9d0c6502`, which the spec makes a prerequisite).

## Global Constraints

### Paths and how to run tests

- **`<wt>` is the implementation worktree** the implementation thread cuts with `node scripts/wt-new.mjs fix/frontend-3400-revisions-client-cutover`. Work only there.
- **Quoted code is authoritative; line numbers are advisory.** Every `file:line` was measured on `main` at `3587e132`. Find code by its quoted text; an earlier task's edit shifts later lines.
- **Command forms** (each "Run:" line is one command):
  - Frontend: `npm --prefix <wt> run test -- <paths>`
  - Server, fast pool: `npm --prefix <wt>/server run test -- <path under server/>`
  - Server, **slow pool** — **required** for every file in `SLOW_FILES_TO_EXCLUDE` (`server/vitest.config.ts:35-58`), which this plan touches as: `src/routes/generation.test.ts`, `src/routes/book-state.test.ts` and **`src/routes/chapters-restructure.test.ts`**. The fast pool prints "No test files found" for them, so a test or mutation run there proves nothing. Form: `npm --prefix <wt>/server run test:slow -- <path> [-t "<name filter>"]`. A `-t` filter that matches no test is a failure, not a pass (check the verbose output lists the expected title).
  - Typecheck (frontend + server): `npm --prefix <wt> run typecheck`
  - OpenAPI regen: `npm --prefix <wt> run openapi:types`
  - Lint a subset: `npx --prefix <wt> eslint <paths>` (the `lint` script is `eslint . --max-warnings 0` and always lints the whole tree).
  - e2e: `npm --prefix <wt> run test:e2e -- e2e/<spec>.spec.ts`
- **On a lane that kills a command after 30 s** (a Cline lane), launch every test, typecheck and `openapi:types` command through **plan 285's detach recipe** (285 → Global Constraints → "Lanes and long commands"), unchanged except for `<wt>`, including its Green rule and contention rule. On the `claude` lane run them in the foreground with a 600 s timeout.
- **Every red-first run and every mutation run appends `--retry=0`.** Both vitest configs set `retry: 1`.
- **No task runs a full battery** (`npm run test`, `test:server`, `test:all`, `verify`, `build`, whole-tree lint). Each task runs its own files plus `typecheck`. Task 32 runs the broader check; cloud `verify.yml` is the authoritative gate.

### Ordering rule

Every task's commit leaves `npm run typecheck` and that task's tests green, and does not break a test elsewhere:
- New reducers/functions are **added** before callers switch to them; old ones are **deleted** only after the last caller is gone (Tasks 25–26).
- A task that changes behaviour some other test pins (a layout test, an e2e spec) updates that test **in the same task**, and names it.
- **The preview path is migrated in this order** so `e2e/profile-regen-preview.spec.ts` stays green at every commit: the stub thunks exist (Task 15) → the watcher exists (Task 21) → the layout routes both kinds, and the old completion trigger opens the stub as `kind:'preview-stub'` (Task 22) → the new trigger replaces it (Task 24).
- Server switches (Tasks 27–29) come after the client stops using the old paths.
- **Known transitional window (Tasks 19–21):** from Task 19 the polls adopt server pending, but until Task 22 the old generation middleware still enqueues the preview stub **into** `revisions.pending`. A 30 s active poll landing between the preview's completion and its Approve therefore adopts server state and wipes the stub (no user exposure: every task merges together in one PR). `e2e/profile-regen-preview.spec.ts` finishes inside one poll period, so it stays green — and Tasks 19, 20 and 21 each run it with `--repeat-each=3` in their Green step to prove that. A red there in those tasks is this window, not a flake: report it; the fix is to pull Task 22's transitional generation-middleware edit forward, not to retry.

### What PR 1 actually shipped (read before any task)

- **Per-chapter serialisation.** Accept/reject run inside `withKeyLock(revisionOpLockKey(bookDir, chapterId))` (`revision-op:<resolved bookDir>:<chapterId>`), with the `revisions` leaf lock taken inside for steps 1 and 3. Lock order `revision-op` → `revisions`.
- **Legacy entries commit.** `commitRevisionOp` looks its entry up in the stored view first (`stored.pending.find(...) ?? file.pending.find(...)`, `revisions-store.ts:387-389`).
- **Legacy-route lock curation.** The legacy `DELETE …/audio/previous` and `POST …/audio/previous/restore` answer `LOCK_CONTENTION_REQUEST_ERROR` on a lock timeout. Task 29 retires both routes (410), so those branches go.
- **Error body shape.** Coded errors: `{ error: <code>, message, state? }` (`RevisionOpError`, `openapi.yaml:7168`). Unexpected 500s: `{ error: <message> }` with no `message` field. **Before Task 3** that message can be raw `(e as Error).message` — Task 3 fixes it.
- **Finalize.** `applyReview` (`finalize-chapter-write.ts:773`) already implements the tri-state; PR 2 only changes what callers pass.
- **Client plumbing.** `review` already rides `EnqueueInput` → queue entry → `StreamOpenOpts` → `StreamArgs` → POST body (PR 1 Task 11). The mock queue is `src/mocks/mock-queue.ts`.
- **CLAUDE.md `requestFailureMessage` count — re-derive, never copy.** CLAUDE.md states the **call-site** count; `git -C <wt> grep -c "requestFailureMessage(" -- 'server/src/**/*.ts' ':!*.test.ts'` sums to call sites **+ 1** (the definition in `workspace/file-lock.ts`). Measured on `de0da822` (after #3527): grep sum **22**, CLAUDE.md "twenty-one sites" (`qa-report` ×2 = the GET and `resume-scoring`). **This plan's delta is 0**: Tasks 1 and 2 add fixed sentences at lock-free sites with **no** helper (a lock timeout cannot originate there), and Tasks 3–4 change only the fallback *argument* at existing sites. So at rebase time the implementer re-runs the grep and re-reads CLAUDE.md's sentence, and they must still agree as "grep sum − 1 = stated count"; if they disagree, another PR moved one of them — reconcile CLAUDE.md to the grep, never to a number written in this plan. The CLAUDE.md lines this plan does change are named per task: the explicit `LOCK_CONTENTION_REQUEST_ERROR` branch list (Task 1 adds `restore-unrecorded`; Task 29 removes the two legacy routes), the `revision-op` serialisation sentence (Task 29), and the swallow list FIVE → SIX (Task 28).

### Error codes the client handles

`invalid_selection` (400), `book_not_found` / `revision_not_found` / `not_found` (404), `chapter_busy` / `no_previous_audio` / `live_audio_missing` / `revision_gone` / `has_revision` (409), `restore_failed` / `lock_contention` (500), `revisions_server_owned` (400, PUT only), `moved` (410, legacy routes only). Any other body is "unexpected".

### User-facing copy (exact strings)

| Key | Kind | Text |
|---|---|---|
| busy | warn | `This chapter is busy — try again when it finishes` |
| no previous | warn | `Original audio not preserved` |
| gone / not found | warn | `This take was replaced by a newer render` |
| live missing | error | `This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it` |
| restore failed | error | `Couldn't restore the earlier take — try Reject again` (one neutral sentence for every entry, so an OD20 **recovered** entry is never told its A side is "the original". The client always toasts this constant (`REVISION_COPY.restoreFailed`), never the server's `message`. PR 1's `revision-ops.ts:149` `message` still says "the original" and is not shown.) |
| resolved elsewhere | info | `This preview was resolved elsewhere` |
| splice unrecorded | warn | `The new take is live, but its A/B review couldn't be saved` |
| has revision | warn | `This chapter has an older pending review — resolve it from the chapter's review first` |
| preview elsewhere | info | `Preview ready in ‹book title›` |
| unexpected | error | `Couldn't update the revision — try again` |
| dismiss failed | error | `Couldn't dismiss the drift event — try again` |
| revisions unreadable (OD2) | warn | the server's `revisionsError`, verbatim: `This book's A/B review history couldn't be read, so its pending reviews aren't shown.` — or, for a newer-schema file, `UnsupportedSchemaError`'s own "… upgrade the server before editing this book." sentence (Task 5) |
| recovered badge (OD20) | label | `Recovered from before the update` |
| recovered A card (OD20) | label | `The take kept before this chapter's last render` (never "the original": see OD20) |

### Commits

- Each task commits on its own, in the foreground, with the message in its last step. Never `--no-verify`.
- Subject `<type>(<scope>[,<scope>]): <subject>`, ≤100 chars, scopes from `frontend|server|mocks|openapi|e2e|docs`.
- Each commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the dispatching session's attribution line).

### Mutation checks

Every task ends with mutation checks. For each: make the named change, run the named test with `--retry=0`, observe the **named** test go red **for the stated reason**, restore byte-for-byte, re-run green, and confirm `git -C <wt> diff --stat` shows only the task's own files. A mutation that stays green is a finding to report, never something to paper over.

### Task character

Each task header says **mechanical** or **judgment**. The operator assigns lanes at decompose time.

## Review Focus

1. **Coming back to a book after a take finished elsewhere (#3397).** The browser outcome is pinned by `e2e/revisions-book-switch.spec.ts` (Task 30), whose mutation cuts the client's adoption of server state (`applyPoll` never adopts and the hydrate passes `state: null`) while the mock store still records. The specific mechanism — every reopen re-reads revisions — is pinned by the layout unit test "reopening a book always re-hydrates revisions" (Task 18). (The active poll also fetches immediately on reopen of a `ready` book, so the e2e alone cannot isolate the rehydrate.)
2. **Two tabs on one take.** Tab 1 accepts; tab 2's poll removes the entry its player shows. The player must close, and a preview tied to that chapter must clear with one "resolved elsewhere" toast. Pinned in `revision-player-middleware.test.ts` (Task 21).
3. **A legacy on-disk entry** (no `origin`, id `revision:3:eliza` or `splice-…`) opens as a server entry and accept/reject go through the route. Pinned in `revisions-thunks.test.ts` (Task 14) and the layout player test (Task 22); a stuck legacy `playable:false` take is recoverable (Task 6) and shows the **Recovered from before the update** label (Task 16).
4. **Many books / one broken book in the background poll.** More than 50 analysed books, or one failing book, must not stop drift for the others. Pinned in the layout poll tests (Task 19) and `revisions.test.ts` (Task 2).
5. **A slow book-open read racing the user's first op on a legacy book** (`fileId:null`): the stale snapshot must not erase the entry the op just recorded. Pinned in `revisions-slice.cache.test.ts` and the layout race test (Tasks 12, 18).

---

### Task 1: Server — `restore-unrecorded` route

**Character:** judgment (route ordering and curation).

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (add `hasPendingForChapter`).
- Modify: `server/src/routes/chapter-audio.ts` (new route, after the `POST …/audio/previous/restore` handler).
- Modify: `openapi.yaml` (new path), then regenerate `src/lib/api-types.ts`.
- Modify: `CLAUDE.md` (the explicit `LOCK_CONTENTION_REQUEST_ERROR` branch list only — no count change).
- Test: `server/src/routes/chapter-audio.test.ts`, `server/src/workspace/revisions-store.test.ts`, `src/lib/api-types.revisions-contract.test.ts`.

**Interfaces:**
- Produces: `hasPendingForChapter(bookDir: string, chapters: readonly ChapterRef[], chapterId: number): Promise<boolean>` (lock-free, normalised view; throws like `readRevisions` — never a `LockAcquisitionTimeoutError`, so its catch needs no lock curation).
- Produces: `POST /api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded` → `204` · `404 {error:'not_found'|'no_previous_audio'}` · `409 {error:'chapter_busy'|'has_revision'}` · `500 {error:'restore_failed'|'lock_contention'} | {error:<fixed sentence>}`. Never writes revisions.json.

- [ ] **Step 1: Write the failing tests.**

  (a) `revisions-store.test.ts` (uses the file's `seedRaw`, `serverEntry`, `CHAPTERS`, `bookDir`, `audioDir`); add `hasPendingForChapter` to its import list:
  ```ts
  describe('hasPendingForChapter (plan 286)', () => {
    it('is true only for a chapter with a pending entry in the normalised view', async () => {
      seedRaw({ schema: 1, fileId: null, rev: 0, pending: [serverEntry(1, 'r1')], dismissed: [], acceptedSelections: {}, timeline: {} });
      expect(await hasPendingForChapter(bookDir, CHAPTERS, 1)).toBe(true);
      expect(await hasPendingForChapter(bookDir, CHAPTERS, 2)).toBe(false);
    });
    it('a legacy entry whose .previous.mp3 is gone does not count', async () => {
      seedRaw({ pending: [{ id: 'revision:1:narrator', chapterId: 1, characterId: 'narrator', playable: true, segments: [] }] });
      expect(await hasPendingForChapter(bookDir, CHAPTERS, 1)).toBe(false);
      writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
      expect(await hasPendingForChapter(bookDir, CHAPTERS, 1)).toBe(true);
    });
  });
  ```

  (b) `chapter-audio.test.ts` — add `readFileSync`, `existsSync`, `rmSync` to its `node:fs` import if missing. Add a hoisted passthrough mock beside the file's existing `vi.mock('../workspace/file-lock.js', …)` so a test can inject a path-bearing rejection (in this red step `real.hasPendingForChapter` is still `undefined`; `vi.fn(undefined)` is a valid no-op until Step 2 exports it):
  ```ts
  vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
    return { ...real, hasPendingForChapter: vi.fn(real.hasPendingForChapter) };
  });
  ```
  **Convert the file's `beforeAll` imports to sequential in the same edit (incidental finding, #2083).** The file already carries two hoisted async-factory mocks (`node:fs/promises` `~:24`, `file-lock.js` `~:40`) and still loads the router through `const [{ chapterAudioRouter }, { makeBookId }] = await Promise.all([import('./chapter-audio.js'), import('../workspace/paths.js')]);` (`~:63`). A `Promise.all` of dynamic imports races an async factory, so a module can bind the real, unmocked export; this task adds a third. Replace it with the pattern `book-state.reparse.test.ts:71-77` and `revisions.test.ts:90-94` use, keeping a comment that says why:
  ```ts
  /* Sequential, not `Promise.all` — this file carries hoisted async-factory
     `vi.mock`s, which a `Promise.all` of dynamic imports races (#2083). */
  const { chapterAudioRouter } = await import('./chapter-audio.js');
  const { makeBookId } = await import('../workspace/paths.js');
  ```
  Then inside `describe('preserved previous audio', …)`:
  ```ts
  describe('POST /audio/previous/restore-unrecorded (plan 286)', () => {
    const RU = () => `/api/books/${bookId}/chapters/1/audio/previous/restore-unrecorded`;
    const revisionsFile = () => join(bookDir, '.audiobook', 'revisions.json');
    const seedPendingForCh1 = () =>
      writeFileSync(revisionsFile(), JSON.stringify({ schema: 1, fileId: '000000000000001-a', rev: 1,
        pending: [{ id: 'revision:1:1', chapterId: 1, characterId: 'narrator', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' }],
        dismissed: [], acceptedSelections: {}, timeline: {} }));
    beforeEach(() => { if (existsSync(revisionsFile())) rmSync(revisionsFile()); });

    it('204: restores .previous over live and never writes revisions.json', async () => {
      resetAudio(); writeMp3(); writePreviousMp3();
      const res = await request(app).post(RU());
      expect(res.status).toBe(204);
      expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(false);
      expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
      expect(existsSync(revisionsFile())).toBe(false);
    });
    it('404 no_previous_audio when nothing was preserved', async () => {
      resetAudio(); writeMp3();
      const res = await request(app).post(RU());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('no_previous_audio');
    });
    it('409 has_revision when revisions.json has a pending entry for the chapter; audio and file untouched', async () => {
      resetAudio(); writeMp3(); writePreviousMp3(); seedPendingForCh1();
      const before = readFileSync(revisionsFile(), 'utf8');
      const res = await request(app).post(RU());
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('has_revision');
      expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);
      expect(readFileSync(revisionsFile(), 'utf8')).toBe(before);
    });
    it('409 chapter_busy during generation, checked before the chapter-id parse', async () => {
      vi.resetModules();
      vi.doMock('./generation.js', () => ({ generationRouter: undefined, isGenerationActive: () => true }));
      const { chapterAudioRouter: mocked } = await import('./chapter-audio.js');
      const mApp = express(); mApp.use('/api/books', mocked);
      const res = await request(mApp).post(`/api/books/${bookId}/chapters/not-a-number/audio/previous/restore-unrecorded`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chapter_busy');
      vi.doUnmock('./generation.js'); vi.resetModules();
    });
    it('a lock timeout answers the curated contention body (no key or path) and is logged', async () => {
      resetAudio(); writeMp3(); writePreviousMp3();
      const { withKeyLock, LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
      vi.mocked(withKeyLock).mockRejectedValueOnce(new LockAcquisitionTimeoutError('revision-op:C:/SECRET-WORKSPACE/book:1', 10_000));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request(app).post(RU());
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'lock_contention', message: LOCK_CONTENTION_REQUEST_ERROR });
        expect(res.text).not.toContain('SECRET-WORKSPACE');
        expect(errSpy).toHaveBeenCalled();
      } finally { errSpy.mockRestore(); }
    });
    it('an unreadable revisions.json answers a fixed 500 without the path, and the raw error is logged', async () => {
      resetAudio(); writeMp3(); writePreviousMp3();
      const { hasPendingForChapter } = await import('../workspace/revisions-store.js');
      /* EISDIR's own message carries no path, so it could not prove path-freedom;
         a mocked EPERM-style rejection whose message embeds the path can. */
      vi.mocked(hasPendingForChapter).mockRejectedValueOnce(
        Object.assign(new Error("EPERM: operation not permitted, open 'C:\\SECRET-WORKSPACE\\book\\.audiobook\\revisions.json'"), { code: 'EPERM' }),
      );
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request(app).post(RU());
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Couldn't read this chapter's review state." });
        expect(res.text).not.toContain('SECRET-WORKSPACE');
        expect(errSpy).toHaveBeenCalled();
        expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);
      } finally { errSpy.mockRestore(); }
    });
  });
  ```
  (The file's `vi.mock('../workspace/file-lock.js', …)` already wraps `withKeyLock` in `vi.fn`, which is what makes `vi.mocked(withKeyLock).mockRejectedValueOnce` reach the route — the PR 1 legacy timeout tests at `~:626-649` use the same mechanism. `hasPendingForChapter` takes no lock, so the first `withKeyLock` call the route makes is the `revision-op` one.)

  (c) `api-types.revisions-contract.test.ts`:
  ```ts
  it('plan 286 — restore-unrecorded is a POST with 204 / 404 / 409 / 500', () => {
    type Op = paths['/api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded']['post'];
    expectTypeOf<keyof Op['responses']>().toEqualTypeOf<204 | 404 | 409 | 500>();
  });
  ```

  Run: `npm --prefix <wt>/server run test -- src/routes/chapter-audio.test.ts src/workspace/revisions-store.test.ts --retry=0`
  Expected: FAIL — `hasPendingForChapter` is not exported (import error fails the store file), and the route 404s with Express's default HTML body.

- [ ] **Step 2: Implement `hasPendingForChapter`** in `revisions-store.ts`, after `readRevisions`:
  ```ts
  /** Plan 286 — lock-free: does the normalised view hold a pending entry for
      this chapter? restore-unrecorded's check-then-act guard (spec §4: a guard
      against the common case, not a fence). */
  export async function hasPendingForChapter(
    bookDir: string,
    chapters: readonly ChapterRef[],
    chapterId: number,
  ): Promise<boolean> {
    return (await load(bookDir, chapters)).pending.some((p) => p.chapterId === chapterId);
  }
  ```

- [ ] **Step 3: Implement the route** in `chapter-audio.ts`, directly after the `…/audio/previous/restore` handler. Add `hasPendingForChapter` to the `revisions-store.js` import. **No `requestFailureMessage`**: the first catch guards a lock-free read (a lock timeout cannot reach it), so it answers a plain fixed sentence; the only lock on this route is the `revision-op` key, curated by the explicit `LOCK_CONTENTION_REQUEST_ERROR` branch.
  ```ts
  /* Plan 286 (#3400 PR 2) — restore `.previous` for a preview whose A/B review
     was never recorded (finalize answered reviewOutcome:'failed'). Keeps the
     restore route's order: busy 409 first, then the chapter parse and lookups.
     Refuses with has_revision when a pending entry exists for the chapter (that
     one must go through the recorded reject). Never writes revisions.json.
     Takes the per-chapter revision-op key: it runs restorePreviousAudio, so it
     shares accept/reject's race (PR #3504 review pass 1). */
  chapterAudioRouter.post(
    '/:bookId/chapters/:chapterId/audio/previous/restore-unrecorded',
    async (req: Request, res: Response) => {
      if (isGenerationActive(req.params.bookId)) {
        return res.status(409).json({ error: 'chapter_busy', message: 'This chapter is busy — try again when it finishes.' });
      }
      const chapterId = Number.parseInt(req.params.chapterId, 10);
      if (!Number.isInteger(chapterId)) return res.status(404).json({ error: 'not_found', message: 'Chapter audio not found.' });
      const located = await findBookByBookId(req.params.bookId);
      if (!located) return res.status(404).json({ error: 'not_found', message: 'Chapter audio not found.' });
      const chapter = located.state.chapters.find((c) => c.id === chapterId);
      if (!chapter) return res.status(404).json({ error: 'not_found', message: 'Chapter audio not found.' });
      try {
        if (await hasPendingForChapter(located.bookDir, located.state.chapters, chapter.id)) {
          return res.status(409).json({
            error: 'has_revision',
            message: "This chapter has an older pending review — resolve it from the chapter's review first.",
          });
        }
      } catch (e) {
        console.error('[chapter-audio] restore-unrecorded: revisions.json unreadable', e);
        return res.status(500).json({ error: "Couldn't read this chapter's review state." });
      }
      const root = audioDir(located.bookDir);
      let outcome: 'restored' | 'none';
      try {
        outcome = await withKeyLock(revisionOpLockKey(located.bookDir, chapter.id), () =>
          restorePreviousAudio(root, chapter.slug),
        );
      } catch (e) {
        console.error('[chapter-audio] restore-unrecorded failed', e);
        if (isLockAcquisitionTimeout(e)) {
          return res.status(500).json({ error: 'lock_contention', message: LOCK_CONTENTION_REQUEST_ERROR });
        }
        return res.status(500).json({ error: 'restore_failed', message: "Couldn't restore the earlier take — try Reject again." });
      }
      if (outcome === 'none') return res.status(404).json({ error: 'no_previous_audio', message: 'No preserved previous audio.' });
      return res.status(204).end();
    },
  );
  ```

- [ ] **Step 4: OpenAPI.** After the `…/audio/previous/restore:` path in `openapi.yaml`:
  ```yaml
  /api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded:
    post:
      summary: Restore the preserved take for a preview whose review was never recorded (plan 286)
      operationId: restorePreviousUnrecorded
      description: |
        Used only by the A/B preview stub when finalize answered
        `reviewOutcome: 'failed'` (its take was preserved but no entry was recorded). Busy check first, then the chapter lookups.
        409 `has_revision` when revisions.json holds a pending entry for the
        chapter (read lock-free — a guard, not a fence). Never writes
        revisions.json. Serialised per chapter with accept/reject.
      parameters:
        - { in: path, name: bookId, required: true, schema: { type: string } }
        - { in: path, name: chapterId, required: true, schema: { type: integer } }
      responses:
        '204': { description: Restored. }
        '404':
          description: '`not_found` (book / chapter) or `no_previous_audio`.'
          content: { application/json: { schema: { $ref: '#/components/schemas/RevisionOpError' } } }
        '409':
          description: '`chapter_busy` or `has_revision`.'
          content: { application/json: { schema: { $ref: '#/components/schemas/RevisionOpError' } } }
        '500':
          description: '`restore_failed`, `lock_contention`, or a fixed failure sentence.'
          content: { application/json: { schema: { $ref: '#/components/schemas/RevisionOpError' } } }
  ```
  Add `has_revision`, `lock_contention` and `not_found` to `RevisionOpError.error`'s description list. Run `openapi:types`.

- [ ] **Step 5: CLAUDE.md chore.** Add `restore-unrecorded` to the sentence listing explicit `LOCK_CONTENTION_REQUEST_ERROR` branches ("… and of `restore-unrecorded` in `chapter-audio.ts`"). The `requestFailureMessage` count does **not** change (delta 0 — see Global Constraints): re-run `git -C <wt> grep -c "requestFailureMessage(" -- 'server/src/**/*.ts' ':!*.test.ts'` and confirm its sum minus 1 still equals the count CLAUDE.md states.

- [ ] **Step 6: Green.**
  Run: `npm --prefix <wt>/server run test -- src/routes/chapter-audio.test.ts src/workspace/revisions-store.test.ts`
  Run: `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts`
  Run: `npm --prefix <wt> run typecheck`

- [ ] **Step 7: Mutations.**
  1. Move the `hasPendingForChapter` block below the `withKeyLock(… restorePreviousAudio …)` call → red: `409 has_revision when …` (`.previous` already consumed when the refusal comes).
  2. Move the `isGenerationActive` check below the chapter-id parse → red: `409 chapter_busy during generation, checked before the chapter-id parse` (gets 404).
  3. Replace the `isLockAcquisitionTimeout` branch's body with `return res.status(500).json({ error: (e as Error).message })` → red: `a lock timeout answers the curated contention body…` (body names `SECRET-WORKSPACE`).
  4. Replace the first catch's sentence with `(e as Error).message` → red: `an unreadable revisions.json answers a fixed 500 without the path…` (the body is the mocked EPERM text, naming `SECRET-WORKSPACE`).

- [ ] **Step 8: Commit.** `feat(server,openapi): add restore-unrecorded for an unrecorded preview take (#3400)`.

---

### Task 2: Server — bulk poll isolates a failing book (D9, server half)

**Character:** mechanical.

**Files:**
- Modify: `server/src/routes/revisions.ts` (`revisionsBulkRouter.get('/revisions', …)`), `openapi.yaml` (`BulkRevisionsResponse`), regenerate `src/lib/api-types.ts`. **No CLAUDE.md change**: the per-book catch is lock-free and uses no helper; the bulk handler's outer `requestFailureMessage` site stays (count delta 0).
- Test: `server/src/routes/revisions.test.ts` — the new describe, **plus** the existing `a lock timeout under either poll answers the curated 500 (no lock-key path)` (`~:625`), whose bulk half this task changes.

**Interfaces:**
- Produces: `GET /api/revisions` → `200 { byBookId, errors?: Record<bookId, string> }`. `errors` is present only when at least one book failed; each value is the fixed sentence `Couldn't read this book's review state.` — a plain literal, no helper: `getRevisionsForBook` → `readRevisions` is lock-free (`revisions-store.ts` `loadRaw`), so no lock timeout can originate there, and a fixed literal is path-free whatever the error.

- [ ] **Step 1: Failing test.** Read `revisions.test.ts`'s top-level `beforeAll` first: if it doesn't mount `revisionsBulkRouter`, mount it there with `app.use('/api', revisionsBulkRouter)` (import it beside `revisionsRouter`). Then add, using the same state.json literal the file's `seed` writes for its own book (copy the object; only `bookId`, `title` and the directory differ):
  ```ts
  describe('GET /api/revisions — per-book isolation (plan 286, D9)', () => {
    let goodId: string; let badId: string;
    beforeAll(async () => {
      const { makeBookId } = await import('../workspace/paths.js');
      for (const title of ['Bulk Good', 'Bulk Bad']) {
        const dir = join(workspaceRoot, 'books', 'Bulk Author', 'Standalones', title);
        mkdirSync(join(dir, '.audiobook'), { recursive: true });
        writeFileSync(join(dir, 'manuscript.txt'), 'x');
        const id = makeBookId('Bulk Author', 'Standalones', title);
        writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify({
          bookId: id, manuscriptId: `m_${title}`, title, author: 'Bulk Author', series: 'Standalones',
          seriesPosition: null, isStandalone: true, manuscriptFile: 'manuscript.txt', castConfirmed: true,
          chapters: [{ id: 1, title: 'One', slug: '01-one' }], coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));
        if (title === 'Bulk Bad') writeFileSync(join(dir, '.audiobook', 'revisions.json'), '[]'); // non-object top level → store throws
        if (title === 'Bulk Good') goodId = id; else badId = id;
      }
    });
    it('returns the healthy books and lists the broken one in errors with a path-free sentence', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get(`/api/revisions?bookIds=${goodId},${badId}`);
      err.mockRestore();
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.byBookId)).toEqual([goodId]);
      expect(res.body.errors).toEqual({ [badId]: "Couldn't read this book's review state." });
      expect(res.text).not.toContain(workspaceRoot);
    });
    it('omits errors when every book succeeds', async () => {
      const res = await request(app).get(`/api/revisions?bookIds=${goodId}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('errors');
    });
    it('a failure whose message embeds an absolute path never reaches the body', async () => {
      /* The '[]' fixture above throws a path-free SyntaxError, so it cannot prove
         path-freedom; this EPERM-style rejection embeds the path. readRevisions is
         already a vi.fn passthrough (the file's hoisted revisions-store mock). */
      const store = await import('../workspace/revisions-store.js');
      vi.mocked(store.readRevisions).mockRejectedValueOnce(
        Object.assign(new Error(`EPERM: operation not permitted, open '${join(workspaceRoot, 'books', 'SECRET', 'revisions.json')}'`), { code: 'EPERM' }),
      );
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get(`/api/revisions?bookIds=${goodId}`);
      err.mockRestore();
      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual({ [goodId]: "Couldn't read this book's review state." });
      expect(res.text).not.toContain(workspaceRoot);
      expect(res.text).not.toContain('SECRET');
    });
  });
  ```
  (Use the file's own names for the workspace root variable and imports; add `vi`, `beforeAll`, `mkdirSync`, `writeFileSync` to its imports if missing.)

  **Rewrite the bulk half of the existing lock-timeout test** (`a lock timeout under either poll answers the curated 500 (no lock-key path)`, `~:625`): after this task a per-book failure is no longer a whole-request 500. Rename it `a lock timeout answers the curated 500 on the single poll and a fixed per-book error on the bulk poll` and replace its last three lines (`const bulk = …`, `expect(bulk.status).toBe(500)`, `expect(bulk.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR })`) with:
  ```ts
  const bulk = await request(app).get(`/api/revisions?bookIds=${bookId}`);
  expect(bulk.status).toBe(200);
  expect(bulk.body.errors).toEqual({ [bookId]: "Couldn't read this book's review state." });
  expect(bulk.text).not.toContain('SECRET-WORKSPACE');
  ```
  (The single-poll half is unchanged.)

  Run: `npm --prefix <wt>/server run test -- src/routes/revisions.test.ts -t "per-book isolation|fixed per-book error" --reporter=verbose --retry=0`
  Expected: FAIL — status 500 for the whole response (the new tests and the rewritten bulk half).

- [ ] **Step 2: Implement.** Replace the `Promise.all` block and the `res.json({ byBookId })` in the bulk handler:
  ```ts
  /* Plan 286 (D9) — one book's failure no longer blanks every other book's
     drift. Its id goes into `errors` with a fixed, path-free sentence; the
     raw error is logged. */
  const errors: Record<string, string> = {};
  const entries = await Promise.all(
    bookIds.map(async (id) => {
      try {
        return [id, await getRevisionsForBook(id)] as const;
      } catch (e) {
        console.error(`[revisions] bulk GET: book ${id} failed`, e);
        errors[id] = "Couldn't read this book's review state.";
        return [id, null] as const;
      }
    }),
  );
  const byBookId: Record<string, { pending: StoredRevision[]; drift: DriftEvent[] }> = {};
  for (const [id, result] of entries) {
    if (result) byBookId[id] = { pending: result.pending, drift: result.drift };
  }
  res.json(Object.keys(errors).length > 0 ? { byBookId, errors } : { byBookId });
  ```
  Extend the handler's header comment: a failing book lands in `errors`.

- [ ] **Step 3: OpenAPI.** In `BulkRevisionsResponse.properties`:
  ```yaml
        errors:
          type: object
          description: Plan 286 — bookIds whose computation failed, each with a fixed path-free sentence. Present only when non-empty.
          additionalProperties: { type: string }
  ```
  Regenerate.

- [ ] **Step 4: Green.** `revisions.test.ts` (whole file — it holds the rewritten lock test), `typecheck`. Re-run the CLAUDE.md count grep: unchanged (delta 0).

- [ ] **Step 5: Mutations.**
  1. Remove the `try/catch` around `getRevisionsForBook(id)` → red: `returns the healthy books…` and the rewritten lock test (500).
  2. Replace the per-book sentence with `(e as Error).message` → red: `a failure whose message embeds an absolute path never reaches the body` (the body names the workspace path) and `returns the healthy books…` (`errors[badId]` is the `SyntaxError` text).
  3. Always send `errors` → red: `omits errors when every book succeeds`.

- [ ] **Step 6: Commit.** `fix(server,openapi): isolate a failing book in the bulk revisions poll (#3400)`.

---

### Task 3: Server — curate the revisions routes' and qa-report's raw 500 fallbacks (Invariant 8, OD26)

**Character:** mechanical.

**Why:** `revision-ops.ts` (accept `~:113`, reject `~:172`, dismiss `~:185`), `revisions.ts` (`~:238`, `~:271`) and `qa-report.ts` (GET `~:47`, `resume-scoring` `~:73`) pass `(e as Error).message || '…'` to `requestFailureMessage`, which keeps any non-lock message verbatim. A filesystem error (`EPERM`, `EBUSY`) embeds the absolute workspace path, and from Task 14 on the client would show it in a toast. Same defect class at all seven sites, so all seven are fixed here. `resume-scoring` is not a store path, but OD26 (operator, 2026-10-07) curates it in the same round: fixed sentences for **both** qa-report handlers, the raw error logged.

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (add `revisionsFailureText`), `server/src/routes/revision-ops.ts`, `server/src/routes/revisions.ts`, `server/src/routes/qa-report.ts` (both handlers).
- Modify: `docs/features/285-revisions-server-ops.md` (Reversibility 3 note, Step 3).
- Test: `server/src/routes/revision-ops.test.ts`, `server/src/routes/revisions.test.ts`, `server/src/routes/qa-report.test.ts` — including two **existing** qa-report tests whose expectation this task flips (Step 1).

**Interfaces:**
- Produces: `export function revisionsFailureText(err: unknown, fallback: string): string` — `err instanceof UnsupportedSchemaError ? err.message : fallback` (that error's message is fixed and path-free by construction, and tells the user to upgrade).
- The six store sites become `requestFailureMessage(e, revisionsFailureText(e, '<its existing literal fallback>'))`; `resume-scoring` becomes `requestFailureMessage(e, 'Failed to resume scoring.')` (not a store path, so no `revisionsFailureText`). The `requestFailureMessage(` count does not change (delta 0).

- [ ] **Step 1: Failing tests.** Every path-freedom case uses a **mocked rejection whose message embeds a path** (Invariant 8 — an `EISDIR` fixture's message carries no path and would prove nothing). One shared literal per file:
  ```ts
  const pathError = () => Object.assign(
    new Error("EPERM: operation not permitted, open 'C:\\SECRET-WORKSPACE\\book\\.audiobook\\revisions.json'"),
    { code: 'EPERM' },
  );
  ```
  ```ts
  // revision-ops.test.ts — beginRevisionOp and dismissDriftId are already vi.fn passthroughs
  // (the file's hoisted revisions-store mock, ~:54). With no revisions.json the lock-free
  // pre-read finds nothing, so accept/reject reach beginRevisionOp unlocked.
  describe('unexpected failures answer fixed sentences (plan 286, invariant 8)', () => {
    it.each([
      ['accept', 'begin', () => accept('r1'), 'Failed to accept revision.'],
      ['reject', 'begin', () => reject('r1'), 'Failed to reject revision.'],
      ['dismiss', 'dismiss', () => request(app).post(`/api/books/${bookId}/drift/d1/dismiss`), 'Failed to dismiss drift.'],
    ] as const)('%s', async (_n, which, call, text) => {
      const store = await import('../workspace/revisions-store.js');
      if (which === 'begin') vi.mocked(store.beginRevisionOp).mockRejectedValueOnce(pathError());
      else vi.mocked(store.dismissDriftId).mockRejectedValueOnce(pathError());
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await call();
      err.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: text });
      expect(res.text).not.toContain('SECRET-WORKSPACE');
    });
  });
  ```
  ```ts
  // revisions.test.ts — single-book poll; readRevisions is already a vi.fn passthrough (~:30).
  it('plan 286 — an unreadable revisions.json answers a fixed sentence, not the fs error', async () => {
    const store = await import('../workspace/revisions-store.js');
    vi.mocked(store.readRevisions).mockRejectedValueOnce(pathError());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to compute revisions.' });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
  });
  it('plan 286 — a newer-schema file keeps its own upgrade sentence', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'revisions.json'), JSON.stringify({ schema: 99 }));
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/upgrade the server/i);
  });
  ```
  ```ts
  // qa-report.test.ts — extend the existing hoisted scan.js mock (~:16) with one more sentinel,
  // beside THROW_TRIGGER and LOCK_TRIGGER:
  //   if (bookId === 'EPERM_TRIGGER') throw pathError();
  // (declare pathError above the vi.mock with vi.hoisted, since the factory is hoisted), then:
  it('plan 286 (OD26) — GET: an error naming a path answers a fixed sentence', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/books/EPERM_TRIGGER/qa-report');
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build QA report.' });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
  });
  it('plan 286 (OD26) — resume-scoring: an error naming a path answers a fixed sentence', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/books/EPERM_TRIGGER/resume-scoring');
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to resume scoring.' });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
  });
  ```
  **Flip two existing qa-report tests** (they pin the raw-message behaviour OD26 retires; name both in the commit body):
  - `returns 500 when the underlying lookup throws` (`~:150`): `expect(res.body).toEqual({ error: 'disk read failed' })` → `expect(res.body).toEqual({ error: 'Failed to build QA report.' })`.
  - `a non-lock failure keeps its own message` (`~:225`, added by #3527): rename to `a non-lock failure answers a fixed sentence` and change its expectation to `{ error: 'Failed to resume scoring.' }`.

  **Then** grep the three test files for every other assertion on an error body: `grep -n "toEqual({ error:\|SyntaxError\|Unexpected token\|JSON at position\|expected a JSON object" server/src/routes/{revisions,revision-ops,qa-report}.test.ts`. A hit expecting `LOCK_CONTENTION_REQUEST_ERROR` stays (the helper still curates the lock class); any hit expecting a raw (non-fixed) message changes to its site's fixed sentence. List each change in the commit body.

  Run the three files with `--retry=0` → FAIL (bodies carry the mocked `EPERM` text; the two flipped qa-report tests get `disk read failed`).

- [ ] **Step 2: Implement.** In `revisions-store.ts`:
  ```ts
  /** Plan 286 (invariant 8) — the text a whole-request 500 may show for a
      store failure: UnsupportedSchemaError's own fixed "upgrade" sentence, or
      the caller's fixed fallback. Never an fs error's message (it embeds the
      absolute workspace path). */
  export function revisionsFailureText(err: unknown, fallback: string): string {
    return err instanceof UnsupportedSchemaError ? err.message : fallback;
  }
  ```
  Each store site: e.g. `revision-ops.ts` accept → `requestFailureMessage(e, revisionsFailureText(e, 'Failed to accept revision.'))`; reject → `'Failed to reject revision.'`; dismiss → `'Failed to dismiss drift.'`; `revisions.ts` single → `'Failed to compute revisions.'`; bulk outer catch → `'Failed to compute bulk revisions.'`; `qa-report.ts` GET → `revisionsFailureText(e, 'Failed to build QA report.')`. `qa-report.ts` `resume-scoring` → `requestFailureMessage(e, 'Failed to resume scoring.')`. Every catch keeps its `console.error(…, e)` (the raw error is logged). Also fix `revisions.ts`'s header comment if it says the error text is the raw parse error.

- [ ] **Step 3: Docs.** Plan 285 Reversibility 3 "Error text" bullet is now false for PR 2's state: append "(PR 2 / plan 286 Task 3: every such 500 now answers a fixed sentence; a newer schema keeps its upgrade sentence.)".

- [ ] **Step 4: Green.** The three test files, server `typecheck`. Re-run the CLAUDE.md count grep: unchanged.

- [ ] **Step 5: Mutations.**
  1. Revert `revision-ops.ts` reject's fallback to `(e as Error).message || 'Failed to reject revision.'` → red: the `reject` row (body is the mocked EPERM text).
  2. Make `revisionsFailureText` return `fallback` unconditionally → red: `a newer-schema file keeps its own upgrade sentence`.
  3. Revert `resume-scoring`'s fallback to `(e as Error).message || 'Failed to resume scoring.'` → red: `resume-scoring: an error naming a path…` and `a non-lock failure answers a fixed sentence`.

- [ ] **Step 6: Commit.** `fix(server): answer fixed sentences for revisions store and qa-report failures (#3400)`.

---

### Task 4: Server — reparse / replace-manuscript curate the revisions reset failure (Invariant 8)

**Character:** mechanical.

**Why:** `POST …/reparse` (`book-state.ts ~:1357-1358`) and `POST …/replace-manuscript` (`~:1412-1415`) answer `requestFailureMessage(e, (e as Error).message || …)`. Both run `applyReparse` (`~:1091`), whose `Promise.all` includes PR 1's `resetRevisions(bookDir)` (`~:1210`) — a store write whose fs error embeds the absolute path, returned verbatim. Curating the **whole** handler would also hide the manuscript parser's own user-facing messages (EPUB/PDF failures), which are not revisions text; so only the revisions arm is curated. Their `assertRevisionsResettable` preflight (`~:1298`, `~:1384`) throws only `UnsupportedSchemaError`, whose message is fixed and path-free — unchanged.

**Files:**
- Modify: `server/src/routes/book-state.ts` (`applyReparse`'s `resetRevisions(bookDir)` arm only).
- Test: `server/src/routes/book-state.reparse.test.ts`, `server/src/routes/book-state.replace-manuscript.test.ts` (both fast pool — only `book-state.test.ts` is in `SLOW_FILES_TO_EXCLUDE`).

**Interfaces:**
- The reset arm becomes `resetRevisions(bookDir).catch((e) => { … })`: log the raw error, then rethrow `e` unchanged when it is a `LockAcquisitionTimeoutError` (the handlers' `requestFailureMessage` already curates it) or an `UnsupportedSchemaError` (path-free), else throw `new Error("Couldn't reset this book's A/B review history.")`. The handlers are untouched, so the `requestFailureMessage` count is unchanged.

- [ ] **Step 1: Failing tests.** In each file, add a hoisted passthrough mock:
  ```ts
  vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
    return { ...real, resetRevisions: vi.fn(real.resetRevisions) };
  });
  ```
  **Imports must be sequential (#2083), and the two files differ.**
  - `book-state.reparse.test.ts` already loads its routers sequentially (`~:71-77`, with the comment saying why). Keep that.
  - `book-state.replace-manuscript.test.ts` still uses `const [{ bookStateRouter }, { makeBookId }] = await Promise.all([import('./book-state.js'), import('../workspace/paths.js')]);` (`~:30-33`). A `Promise.all` of dynamic imports races the async factory this task adds, so convert it in the same edit. This is an incidental finding. Add `vi` to the file's vitest import too.
  ```ts
  /* Sequential, not `Promise.all` — this file carries a hoisted async-factory
     `vi.mock` (revisions-store.js, plan 286), which a `Promise.all` of dynamic
     imports races (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  ```
  **Settle the sibling arms before a test ends (A12).** `applyReparse`'s `Promise.all` rejects the instant the mocked reset rejects, so the 500 arrives while its other three arms are still running:
  - the cast arm (the carryover write and `rm(cast.json)` under the cast lock);
  - `clearAnalysisCache`;
  - the audio-dir `rm`.

  A stray `rm` that lands after the test returns races the next test's `beforeEach`. So each new test seeds one observable side effect per arm before the request, and waits for all three after the response. Add these two helpers above each file's new tests, using that file's own `bookDir`, `cachePath` and `CACHE_DIR`:
  ```ts
  /* A12 — one sentinel per sibling arm of applyReparse's Promise.all. */
  function seedSiblingSentinels() {
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), 'LIVE');
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, '{}');
  }
  /* The 500 arrives when the reset arm rejects; wait until every sibling
     arm's last fs effect has landed, so none outlives the test. */
  async function awaitSiblingArms() {
    await vi.waitFor(() => {
      expect(existsSync(join(bookDir, '.audiobook', 'cast.json'))).toBe(false);
      expect(existsSync(join(bookDir, 'audio'))).toBe(false);
      expect(existsSync(cachePath)).toBe(false);
    });
  }
  ```
  `applyReparse` reads no analysis cache before the `Promise.all` (`book-state.ts ~:1091-1132`), so the `'{}'` cache file is never parsed; `clearAnalysisCache` only `rm`s it. Add `mkdirSync`/`existsSync` to a file's `node:fs` import if it lacks them.
  ```ts
  // book-state.reparse.test.ts — inside describe('reparse handler — preserves manuscript-edits.json')
  it('plan 286 — a revisions reset failure naming a path answers a fixed sentence', async () => {
    seedSiblingSentinels();
    const { resetRevisions } = await import('../workspace/revisions-store.js');
    vi.mocked(resetRevisions).mockRejectedValueOnce(Object.assign(
      new Error("EPERM: operation not permitted, rename 'C:\\SECRET-WORKSPACE\\book\\.audiobook\\revisions.json.tmp'"), { code: 'EPERM' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    await awaitSiblingArms();
    const logged = err.mock.calls.flat().map(String).join(' ');
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Couldn't reset this book's A/B review history." });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
    expect(logged).toContain('SECRET-WORKSPACE'); // the raw error is logged
  });
  it('plan 286 — a lock timeout on the reset still answers the curated contention body', async () => {
    seedSiblingSentinels();
    const { resetRevisions } = await import('../workspace/revisions-store.js');
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    vi.mocked(resetRevisions).mockRejectedValueOnce(new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    await awaitSiblingArms();
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
  });
  ```
  (The second test passes before the change — `requestFailureMessage` already curates a timeout — so it is a regression guard; mutation 3 is its red evidence.)
  ```ts
  // book-state.replace-manuscript.test.ts — inside describe('replace-manuscript handler'); mirror the
  // file's own upload call (see 'replaces chapters from the uploaded file …') for the request:
  it('plan 286 — a revisions reset failure naming a path answers a fixed sentence', async () => {
    seedSiblingSentinels();
    const { resetRevisions } = await import('../workspace/revisions-store.js');
    vi.mocked(resetRevisions).mockRejectedValueOnce(Object.assign(
      new Error("EPERM: operation not permitted, rename 'C:\\SECRET-WORKSPACE\\book\\.audiobook\\revisions.json.tmp'"), { code: 'EPERM' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from('# Chapter One\n\nNew text.'), 'revised.md');
    await awaitSiblingArms();
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Couldn't reset this book's A/B review history." });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
  });
  ```
  (Use each file's own `app`/`bookId` names.)
  Run: `npm --prefix <wt>/server run test -- src/routes/book-state.reparse.test.ts src/routes/book-state.replace-manuscript.test.ts --retry=0` → FAIL (the body is the mocked EPERM text).

- [ ] **Step 2: Implement** in `applyReparse`:
  ```ts
  /* Plan 286 (invariant 8) — this arm's fs error embeds the absolute
     workspace path, and both handlers answer (e as Error).message. Log it raw;
     surface a fixed sentence. A lock timeout and a newer-schema refusal pass
     through unchanged: the handlers' requestFailureMessage curates the first,
     and the second's text is fixed and path-free. */
  resetRevisions(bookDir).catch((e: unknown) => {
    console.error('[book-state] revisions reset failed', e);
    if (isLockAcquisitionTimeout(e) || e instanceof UnsupportedSchemaError) throw e;
    throw new Error("Couldn't reset this book's A/B review history.");
  }),
  ```
  Import `isLockAcquisitionTimeout` from `../workspace/file-lock.js` and `UnsupportedSchemaError` from `../workspace/schema-migrate.js` if not already imported.

- [ ] **Step 3: Green.** Both files (whole files: the plan 285 reset/refusal tests must stay green), server `typecheck`, `npm --prefix <wt>/server run test -- src/routes/lock-timeout-response-bodies.test.ts` (it drives reparse and replace through a **cast**-lock timeout; must stay green).

- [ ] **Step 4: Mutations.**
  1. Drop the `.catch(…)` wrapper → red: both new tests (the body is the EPERM text).
  2. Rethrow every error unchanged inside the catch → red: same tests.
  3. Throw the fixed `Error` for a lock timeout too (drop `isLockAcquisitionTimeout(e) ||`) → red: `a lock timeout on the reset still answers the curated contention body` (the body becomes the reset sentence).
  4. In `applyReparse`'s cast arm, delete the `await rm(castJsonPath(bookDir), { force: true });` line (`book-state.ts ~:1201`, inside the `withCastLock` arm) → red: every new test in both files, at `awaitSiblingArms` (`vi.waitFor` times out on `expected true to be false` for `cast.json`). This shows the helper observes a real effect of a sibling arm, not a file that was never there, and it is deterministic: with the `rm` gone the sentinel can never disappear, whichever arm finishes last. (Pass 3's version flipped the helper's own expectation to `toBe(true)`, which went red only if the cast arm had not yet run at `vi.waitFor`'s first check — a race, pass 4 #5.)

- [ ] **Step 5: Commit.** `fix(server): keep the revisions reset's path out of reparse and replace errors (#3400)`.

---

### Task 5: Server — `GET /state` returns normalised revisions and a `revisionsError` (OD2 server half)

**Character:** mechanical.

**Files:**
- Modify: `server/src/routes/book-state.ts` (GET handler: the `const revs = await readJson<…>(revisionsJsonPath(bookDir));` block `~:277-286`, and `revisions: revs,` in `res.json`).
- Modify: `openapi.yaml` (`BookStateResponse`).
- Test: `server/src/routes/book-state.hydrate.test.ts`.

**Interfaces:**
- Produces: `GET /state` → `revisions: RevisionsState | null`, and `revisionsError?: string`. `RevisionsState` here includes `bookId`, `fileId`, `rev`, normalised `pending`, `dismissed`, `acceptedSelections`, `timeline`; never `drift` or `schema`. When the store throws: `revisions: null` and `revisionsError: revisionsFailureText(e, "This book's A/B review history couldn't be read, so its pending reviews aren't shown.")` (Task 3's helper — so a newer-schema file serves `UnsupportedSchemaError`'s own path-free "upgrade the server" sentence, and anything else the fixed sentence); the book still opens; the raw error is logged. The sentence is user copy: the client toasts it verbatim (OD2, Task 18). A missing file is **not** an error (empty state).

- [ ] **Step 1: Failing tests** in `book-state.hydrate.test.ts` (add `vi` to its imports). The file has no mocks today; add a hoisted passthrough so a test can inject a path-bearing rejection:
  ```ts
  vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
    return { ...real, readRevisions: vi.fn(real.readRevisions) };
  });
  ```
  **Convert the file's `beforeAll` imports to sequential in the same edit (#2083, incidental finding).** It loads the router through `const [{ bookStateRouter }, { makeBookId }] = await Promise.all([import('./book-state.js'), import('../workspace/paths.js')]);` (`~:45-48`). That races the async factory above, and the race can bind the real `readRevisions`, so the mocked rejection never fires. Replace it with the sequential form, with a comment saying why (as `revisions.test.ts:90-94` does):
  ```ts
  /* Sequential, not `Promise.all` — this file carries a hoisted async-factory
     `vi.mock` (revisions-store.js, plan 286), which a `Promise.all` of dynamic
     imports races (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  ```
  ```ts
  describe('GET /state — revisions read through the store (plan 286)', () => {
    const revPath = () => join(bookDir, '.audiobook', 'revisions.json');
    it('normalises: drops drift and a legacy entry with no .previous.mp3, adds fileId/rev/bookId', async () => {
      writeFileSync(revPath(), JSON.stringify({
        pending: [{ id: 'splice-x-1-eliza', chapterId: 1, characterId: 'eliza', playable: true, segments: [] }],
        drift: [{ id: 'd1' }], dismissed: ['a'], timeline: {},
      }));
      const res = await request(app).get(`/api/books/${bookId}/state`);
      expect(res.status).toBe(200);
      expect(res.body.revisions).toEqual({ bookId, fileId: null, rev: 0, pending: [], dismissed: ['a'], acceptedSelections: {}, timeline: {} });
      expect(res.body).not.toHaveProperty('revisionsError');
    });
    it('a missing file reads as an empty state, not null and not an error', async () => {
      const res = await request(app).get(`/api/books/${bookId}/state`);
      expect(res.body.revisions).toEqual({ bookId, fileId: null, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} });
      expect(res.body).not.toHaveProperty('revisionsError');
    });
    it('an unreadable file still opens the book: revisions null + a fixed revisionsError, raw error logged', async () => {
      /* A rejection whose message embeds the path — an EISDIR fixture's message
         carries none, so it could not prove the body is path-free. */
      const store = await import('../workspace/revisions-store.js');
      vi.mocked(store.readRevisions).mockRejectedValueOnce(Object.assign(
        new Error(`EPERM: operation not permitted, open '${revPath()}'`), { code: 'EPERM' }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get(`/api/books/${bookId}/state`);
      /* Read the calls BEFORE mockRestore: in vitest 5 mockRestore also clears
         mock.calls, so asserting toHaveBeenCalled after it always fails. */
      const errorCalls = err.mock.calls.length;
      err.mockRestore();
      expect(res.status).toBe(200);
      expect(res.body.revisions).toBeNull();
      expect(res.body.revisionsError).toBe("This book's A/B review history couldn't be read, so its pending reviews aren't shown.");
      expect(res.text).not.toContain(workspaceRoot);
      expect(errorCalls).toBeGreaterThan(0);
    });
    it('a newer-schema file opens the book with its own upgrade sentence', async () => {
      writeFileSync(revPath(), JSON.stringify({ schema: 99 }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get(`/api/books/${bookId}/state`);
      err.mockRestore();
      expect(res.status).toBe(200);
      expect(res.body.revisions).toBeNull();
      expect(res.body.revisionsError).toMatch(/upgrade the server/i);
    });
  });
  ```
  (The file's `beforeEach` already deletes `revisions.json` between tests.)

  Run: `npm --prefix <wt>/server run test -- src/routes/book-state.hydrate.test.ts --retry=0` → FAIL (raw shape with `drift`, no `fileId`; the rejection and the newer-schema file 500).

- [ ] **Step 2: Implement.** Replace the `const revs = await readJson<{…}>(revisionsJsonPath(bookDir));` statement:
  ```ts
  /* Plan 286 — read through the store: normalised (legacy drift dropped,
     stale legacy pending dropped), with fileId/rev for the client cache. An
     unreadable file must not lock the user out of the book: serve null plus a
     fixed, path-free revisionsError the client toasts once (OD2). */
  let revs: RevisionsState | null;
  let revisionsError: string | undefined;
  try {
    revs = toRevisionsState(req.params.bookId, await readRevisions(bookDir, state.chapters));
  } catch (e) {
    console.error('[book-state] revisions.json unreadable; serving the book without it', e);
    revs = null;
    revisionsError = revisionsFailureText(e, "This book's A/B review history couldn't be read, so its pending reviews aren't shown.");
  }
  ```
  and in `res.json({ … revisions: revs, … })` add `...(revisionsError ? { revisionsError } : {}),`. Import `readRevisions`, `toRevisionsState`, `revisionsFailureText`, `type RevisionsState`. Leave `revisionsJsonPath` imported (the PUT still uses it until Task 29).

- [ ] **Step 3: OpenAPI.** Replace `BookStateResponse.revisions`'s inline object with:
  ```yaml
        revisions:
          description: Plan 286 — revisions.json read through the server store (normalised). Null when the file is unreadable (then `revisionsError` is set).
          nullable: true
          allOf: [{ $ref: '#/components/schemas/RevisionsState' }]
        revisionsError:
          type: string
          description: Plan 286 — present only when revisions.json could not be read. A fixed, path-free user-facing sentence (or, for a newer-schema file, the server's own "upgrade the server" sentence); the client toasts it verbatim.
  ```
  Regenerate. In `api-types.revisions-contract.test.ts`, the PR 1 assertion on `BookStateResponse.revisions.schema` (`expectTypeOf<NonNullable<S['BookStateResponse']['revisions']>['schema']>()…`) no longer holds — replace it with `expectTypeOf<NonNullable<S['BookStateResponse']['revisions']>>().toEqualTypeOf<S['RevisionsState']>();` and `expectTypeOf<S['BookStateResponse']['revisionsError']>().toEqualTypeOf<string | undefined>();`. (The hand-written client `BookStateResponse` in `src/lib/types.ts` is realigned in Task 17, before the layout consumes it in Task 18.)

- [ ] **Step 4: Green.** `book-state.hydrate.test.ts`, `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts`, `typecheck`.

- [ ] **Step 5: Mutations.**
  1. Revert to `readJson(revisionsJsonPath(bookDir))` → red: `normalises: drops drift…`.
  2. Replace the catch body with `throw e` → red: `an unreadable file still opens the book…` (500).
  3. Set `revisionsError = (e as Error).message` → red: same test (the body carries the mocked EPERM path).
  4. Use the fixed sentence alone (drop `revisionsFailureText`) → red: `a newer-schema file opens the book with its own upgrade sentence`.

- [ ] **Step 6: Commit.** `fix(server,openapi): serve normalised revisions and a revisionsError from GET /state (#3400)`.

---

### Task 6: Server — legacy stuck entries stay recoverable, labelled `recovered` (OD20, operator decision)

**Character:** mechanical.

**Why:** a legacy `playable:false` entry is a take the old client enqueued and never flipped (#3397 "stuck"). Today `normaliseRevisions` drops it unconditionally (`revisions-store.ts:130-133`), so the take kept before the chapter's last render is unreachable from the UI. OD20 (revised 2026-10-07): keep it recoverable while `.previous.mp3` exists — read-only, as before — **and label it distinctly**, because the pairing may not be the one the stuck entry describes: every render preserves `.previous` (`finalize-chapter-write.ts:714`, `preserveExistingAsPrevious`), and a failed splice leaves its `playable:false` entry behind (`splice-runner-middleware.ts:67-79` enqueues it before the stream; `:146` only counts the failure). So a later render can have replaced `.previous` with an unrelated older take. The label's carrier is a **server-side flag**, `recovered: true`, on the normalised entry (in the store type, `openapi.yaml`'s `Revision`, and the generated client type); the client renders it in Task 16. Nothing is written on read.

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (`StoredRevision` gains `recovered?: true`; `normaliseRevisions` and its doc comment).
- Modify: `openapi.yaml` (`Revision.recovered`), then regenerate `src/lib/api-types.ts`.
- Test: `server/src/workspace/revisions-store.test.ts`, `server/src/routes/revision-ops.test.ts`, `src/lib/api-types.revisions-contract.test.ts`.

**Interfaces:**
- Normalisation rule for a legacy (origin-less) entry: kept only while `.previous.mp3` exists, whatever its `playable` flag; surfaced `playable: true`; `recovered: true` when the stored entry has `playable === false` **or** already carries `recovered === true` (so the label survives the next unrelated store write, which persists the normalised view — see Reversibility 9). A server entry (`origin: 'server'`) never carries `recovered`.
- **Per-chapter winner (pass 3 #5).** It is still the last entry per chapter, **except that a recovered entry never replaces a non-recovered one**, whatever their order. Keep-last alone is wrong once stuck entries are kept. A failed splice appends its `playable:false` entry **after** a playable `revision:<ch>:<char>` on the same chapter (`splice-runner-middleware.ts:67-79` enqueues before the stream). Keep-last would then shadow the playable entry with a "Recovered" one carrying `segments: []`, and the next store write would persist that loss.

- [ ] **Step 1: Failing tests.**
  ```ts
  // revisions-store.test.ts — inside describe('readRevisions — normalisation (never writes)')
  it('plan 286 (OD20) — a legacy playable:false entry with .previous.mp3 is surfaced as playable and recovered; nothing is written', async () => {
    writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
    seedRaw({ pending: [{ id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: false, hasPreviousAudio: true, segments: [] }] });
    const before = readFileSync(revisionsJsonPath(bookDir), 'utf8');
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file.pending).toEqual([{ id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: true, hasPreviousAudio: true, recovered: true, segments: [] }]);
    expect(readFileSync(revisionsJsonPath(bookDir), 'utf8')).toBe(before);
  });
  it('plan 286 (OD20) — a legacy playable:true entry is not marked recovered', async () => {
    writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
    seedRaw({ pending: [{ id: 'revision:1:c', chapterId: 1, characterId: 'c', playable: true, segments: [] }] });
    expect((await readRevisions(bookDir, CHAPTERS)).pending[0]).not.toHaveProperty('recovered');
  });
  it('plan 286 (OD20) — a legacy playable:false entry without .previous.mp3 is still dropped', async () => {
    seedRaw({ pending: [{ id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: false, segments: [] }] });
    expect((await readRevisions(bookDir, CHAPTERS)).pending).toEqual([]);
  });
  it('plan 286 (OD20) — the next unrelated store write persists it as playable:true, and the label survives', async () => {
    writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
    seedRaw({ pending: [{ id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: false, hasPreviousAudio: true, segments: [] }] });
    await dismissDriftId(bookDir, CHAPTERS, 'unrelated-drift');
    const stored = (onDisk().pending as Array<Record<string, unknown>>)[0];
    expect(stored).toMatchObject({ id: 'splice-b-1-c', playable: true, recovered: true });
    expect((await readRevisions(bookDir, CHAPTERS)).pending[0]).toMatchObject({ id: 'splice-b-1-c', recovered: true });
  });
  it('plan 286 (OD20, pass 3 #5) — a stuck entry appended AFTER a playable one on the same chapter does not shadow it', async () => {
    writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
    seedRaw({ pending: [
      { id: 'revision:1:c', chapterId: 1, characterId: 'c', playable: true, hasPreviousAudio: true, segments: [] },
      { id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: false, hasPreviousAudio: true, segments: [] },
    ] });
    const pending = (await readRevisions(bookDir, CHAPTERS)).pending;
    expect(pending.map((p) => p.id)).toEqual(['revision:1:c']);
    expect(pending[0]).not.toHaveProperty('recovered');
  });
  ```
  Rename the existing test `'drops drift, playable:false legacy entries, and legacy entries with no .previous.mp3'` to `'drops drift and legacy entries with no .previous.mp3; a later playable entry replaces a stuck one'`. Its fixture is entry `a` (`playable:false`, chapter 1) followed by `c1` on chapter 1. That still yields `[c1]` under OD20: `c1` is not recovered and comes last, so it wins under both keep-last and the #5 rule. Its assertions are unchanged; only its name became false. That fixture is the **stuck-first** order. The new #5 test above pins the **playable-first** order, which nothing tested before.
  ```ts
  // revision-ops.test.ts — inside describe('legacy (origin-less) pending entries commit like server ones (#3400)')
  it('plan 286 (OD20) — a stuck legacy entry (playable:false) is rejected: the kept take returns and the outcome is recorded', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([{ ...legacyEntry(1), playable: false }]);
    const res = await reject(LEGACY_ID);
    expect(res.status).toBe(200);
    expect(readFileSync(live(), 'utf8')).toBe('PREV');
    expect(res.body.timeline['1']).toMatchObject([{ id: LEGACY_ID, eventKind: 'rejected' }]);
    expect(disk().pending).toEqual([]);
  });
  ```
  ```ts
  // api-types.revisions-contract.test.ts
  it('plan 286 (OD20) — Revision carries an optional recovered flag', () => {
    expectTypeOf<S['Revision']['recovered']>().toEqualTypeOf<boolean | undefined>();
  });
  ```
  Run: `npm --prefix <wt>/server run test -- src/workspace/revisions-store.test.ts src/routes/revision-ops.test.ts --retry=0` → FAIL: the first store test gets `[]`; the persistence test finds no entry; the reject gets `404 revision_not_found`. The #5 test passes before the change, because today's code drops every stuck entry. It is a guard on the new keep rule, and mutation 5 is its red evidence. `npm --prefix <wt> run typecheck` → FAIL (`recovered` is not on `Revision`).

- [ ] **Step 2: Implement.** In `normaliseRevisions`, delete the legacy branch's `if (e.playable === false) continue;` (keep the `.previous` check). Then replace the existing `byChapter.delete(e.chapterId); byChapter.set(e.chapterId, {…});` pair (`revisions-store.ts ~:134-140`) with the following, which stamps the flag and applies the #5 winner rule:
  ```ts
  const recovered = e.origin !== 'server' && (e.playable === false || e.recovered === true);
  /* Plan 286 (OD20, pass 3 #5) — a recovered entry never replaces a non-recovered
     one for its chapter, whatever their order: a failed splice appended
     after a playable take must not shadow it (it would show as "Recovered"
     with no segments, and the next store write would persist the loss). */
  const held = byChapter.get(e.chapterId);
  if (recovered && held && !held.recovered) continue;
  byChapter.delete(e.chapterId);
  byChapter.set(e.chapterId, {
    ...(e as unknown as StoredRevision),
    segments: Array.isArray(e.segments) ? e.segments : [],
    playable: true,
    hasPreviousAudio: typeof e.hasPreviousAudio === 'boolean' ? e.hasPreviousAudio : true,
    ...(recovered ? { recovered: true as const } : {}),
  });
  ```
  (The store never writes `recovered` on a server entry, so the `...e` spread cannot carry one there.) `StoredRevision` gains `/** Plan 286 OD20 — a legacy entry the old client never flipped (stuck "Rendering…"), surfaced because .previous.mp3 exists. Its A side is the take kept before the chapter's last render, which may not be the take this entry was recorded against. */ recovered?: true;`. Rewrite the doc comment's rule list: "drop the legacy `drift` copy; default missing fields; keep a legacy (origin-less) entry — whatever its `playable` flag — only while `.previous.mp3` exists, surfaced as playable, and stamped `recovered: true` when it was stored `playable:false` (plan 286 OD20); keep the LAST entry per chapter, except that a recovered entry never replaces a non-recovered one (plan 286, pass 3 #5)."
  `openapi.yaml`, in `Revision.properties` after `origin`:
  ```yaml
        recovered:
          type: boolean
          description: >-
            Plan 286 (OD20) — a legacy entry left stuck "Rendering…" by the
            pre-server client, surfaced because a preserved take exists. The
            A side is the take kept before the chapter's last render, which
            may not be the take this entry was recorded against; the player
            labels it "Recovered from before the update".
  ```
  Run `openapi:types`.

- [ ] **Step 3: Green.** Both server files; also `npm --prefix <wt>/server run test -- src/routes/revisions.test.ts src/routes/qa-report.test.ts` (they read through the store); `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts`; `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Restore `if (e.playable === false) continue;` → red: `(OD20) … surfaced as playable and recovered`, the persistence test, and `… stuck legacy entry … is rejected`.
  2. Remove the `.previous` check for legacy entries → red: `… without .previous.mp3 is still dropped`.
  3. Compute `recovered` from `e.playable === false` only (drop `|| e.recovered === true`) → red: `the next unrelated store write persists it as playable:true, and the label survives` (the re-read after the write loses the flag).
  4. Stamp `recovered: true` on every legacy entry → red: `a legacy playable:true entry is not marked recovered`.
  5. Delete the `if (recovered && held && !held.recovered) continue;` line (back to plain keep-last) → red: `a stuck entry appended AFTER a playable one … does not shadow it` (gets `['splice-b-1-c']`). The renamed stuck-first test stays green under this mutation, which is why the new test exists.

- [ ] **Step 5: Commit.** `fix(server,openapi): surface stuck legacy A/B takes as recovered while a kept take exists (#3397)`.

---

### Task 7: Server — finalize reports a three-way review outcome (OD29)

**Character:** mechanical (one field renamed across its producer, three routes, the contract and two hand-written types).

**Why:** `applyReview` (`finalize-chapter-write.ts:773-805`) answers `true` both when it recorded an entry and when it dropped the chapter's entry because nothing was preserved (a first render, or `review: null`). It answers `false` when the store call failed. A client that lands on a book after a preview finished elsewhere therefore cannot tell "recorded, then resolved elsewhere" from "a first render, nothing to review". That is the distinction OD29 keys its drop-vs-stub decision on.

The field has no client consumer before PR 2: the first ones are Tasks 11, 20 and 24. It is replaced outright, not extended. The `boolean` stays ambiguous, so it would invite the same misreading.

**Files:**
- Modify: `server/src/audio/finalize-chapter-write.ts`:
  - `applyReview` returns `Promise<ReviewOutcome | undefined>`;
  - the result type's `reviewRecorded?: boolean` (`~:180-182`, with its doc comment) becomes `reviewOutcome?: ReviewOutcome`;
  - the call site and spread at `~:756` and `~:764` change to match.
- Modify: `server/src/routes/chapter-splice.ts` (`~:567`), `server/src/routes/chapter-qa-repair.ts` (`~:906`) and `server/src/routes/generation.ts` (destructure `~:1890`, tick spread `~:2096`): thread `reviewOutcome` instead of `reviewRecorded`.
- Modify: `openapi.yaml`:
  - add a `ReviewOutcome` component schema;
  - in the `splice_complete` inline schema (`~:1878`), the `qa_repair_complete` inline schema (`~:1977`) and `GenerationTick` (`~:6056`), replace the `reviewRecorded` property with `reviewOutcome: { $ref: '#/components/schemas/ReviewOutcome' }`;
  - then run `openapi:types`.
- Modify: `src/lib/api.ts`. In the hand-written `splice_complete` tick (`~:669`) and `qa_repair_complete` tick (`~:714`), replace `reviewRecorded?: boolean` with `reviewOutcome?: ReviewOutcome`. `api.ts` already imports the generated types as `import type { components as ApiComponents, paths as ApiPaths } from './api-types';` (`~:65`), so add only `type ReviewOutcome = ApiComponents['schemas']['ReviewOutcome'];` beside the file's other `ApiComponents['schemas'][…]` aliases (e.g. `MergeSuggestion`, `~:305`). Do not add a second `components` import.
- Modify: `CLAUDE.md`, the swallow-list sentence about `applyReview` (`~:620`, "surfaces only `reviewRecorded: false`"). It becomes "surfaces only `reviewOutcome: 'failed'`". This is a chore: the sentence turns false in this commit.
- Modify: `docs/features/285-revisions-server-ops.md`. Append to its "Superseded by later commits" note: "plan 286 Task 7 replaced `reviewRecorded` (boolean) with `reviewOutcome: 'recorded' | 'none' | 'failed'` on finalize's result and the three completion ticks."
- Test: `server/src/audio/finalize-chapter-write.test.ts`, `server/src/routes/chapter-splice.test.ts`, `server/src/routes/chapter-qa-repair.test.ts`, `server/src/routes/generation.test.ts` (**slow pool**), `src/lib/api-types.revisions-contract.test.ts`.

**Interfaces:**
- `export type ReviewOutcome = 'recorded' | 'none' | 'failed';` (in `finalize-chapter-write.ts`). The three values:
  - **`'recorded'`** — `review` was an object, the prior take was preserved, and `recordPending` landed. The chapter has a server entry.
  - **`'none'`** — the drop landed and there is nothing to review: either `review` was an object but nothing was preserved (a first render), or `review` was `null`. The chapter has no entry.
  - **`'failed'`** — the store call threw. The error is logged in full and the new take is live. This is the old `false`, and the lock-timeout swallow is unchanged.
- The field is absent when `review` was `undefined`, as `reviewRecorded` was.
- OpenAPI:
  ```yaml
      ReviewOutcome:
        type: string
        enum: [recorded, none, failed]
        description: >-
          Plan 286 (OD29) — what finalize did with A/B review state, on a
          completion frame only when it was asked to: `recorded` (a pending
          entry now exists for the chapter), `none` (nothing to review — a
          first render, or a render without review; any entry for the chapter
          was dropped), `failed` (the store call failed; the new take is live
          without its review entry). Replaces plan 285's boolean flag.
  ```
  (The description deliberately does not spell the old field name: it is copied into the generated `api-types.ts`, and Step 2's check requires no non-test hit for that name.)

- [ ] **Step 1: Failing tests** — flip every existing `reviewRecorded` assertion to the new field. **One test per outcome**, plus the two "none" variants:
  ```ts
  // finalize-chapter-write.test.ts — in the file's plan-285 review-state describe (~:770-875)
  // 'undefined: leaves revisions.json alone and the result carries no reviewRecorded' → rename '… carries no reviewOutcome':
  expect('reviewOutcome' in result).toBe(false);
  // 'object + preserved: upserts one server entry for the chapter':
  expect(result.reviewOutcome).toBe('recorded');
  // 'object + first render (nothing preserved): drops any stale entry, records nothing':
  expect(result.reviewOutcome).toBe('none');
  // "null: drops the chapter's entry even when the prior take was preserved":
  expect(result.reviewOutcome).toBe('none');
  // 'a store failure → reviewRecorded:false; …' → rename 'a store failure → reviewOutcome:failed; …':
  expect(result.reviewOutcome).toBe('failed');
  ```
  ```ts
  // chapter-splice.test.ts (~:281, ~:301), chapter-qa-repair.test.ts (~:440), generation.test.ts (~:2369, ~:2390; and
  // the ~:121 header comment): in each threading test the forced finalize result becomes
  //   spy.mockImplementationOnce(async (input) => ({ ...(await real(input)), reviewOutcome: 'failed' as const }));
  // and its assertion
  //   expect(done!.reviewOutcome).toBe('failed');
  // Rename "threads reviewRecorded onto …" → "threads reviewOutcome onto …" in each title. In the two "carries no
  // reviewRecorded when finalize returns none" tests, rename the same way and assert
  //   expect(line).not.toContain('reviewOutcome');
  // and keep, beside it, the line that proves the old name is gone from the wire (both tests already carry it):
  //   expect(line).not.toContain('reviewRecorded');
  // (Task 27 rewrites these two tests to assert the outcome the routes then always send, keeping the wire guard.)
  ```
  ```ts
  // api-types.revisions-contract.test.ts — replace the two reviewRecorded type assertions (~:62, ~:75-81):
  expectTypeOf<S['GenerationTick']['reviewOutcome']>().toEqualTypeOf<'recorded' | 'none' | 'failed' | undefined>();
  it('the hand-written splice / qa-repair completion ticks carry an optional reviewOutcome', () => {
    expectTypeOf<Extract<SpliceTick, { type: 'splice_complete' }>['reviewOutcome']>().toEqualTypeOf<'recorded' | 'none' | 'failed' | undefined>();
    expectTypeOf<Extract<QaRepairTick, { type: 'qa_repair_complete' }>['reviewOutcome']>().toEqualTypeOf<'recorded' | 'none' | 'failed' | undefined>();
  });
  ```
  Run:
  - `npm --prefix <wt>/server run test -- src/audio/finalize-chapter-write.test.ts src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts --retry=0`
  - `npm --prefix <wt>/server run test:slow -- src/routes/generation.test.ts -t "reviewOutcome" --reporter=verbose --retry=0` (check that both renamed titles appear)

  → FAIL (`reviewOutcome` is `undefined` everywhere). Then `npm --prefix <wt> run typecheck` → FAIL (the contract test names a property that does not exist yet).

- [ ] **Step 2: Implement.** `applyReview`:
  ```ts
  /** Plan 285 — best-effort with respect to the render … (keep the existing doc
      comment, replacing "surfaces ONLY as `false`" with "surfaces ONLY as
      `'failed'`"). Plan 286 (OD29) — three outcomes, so a client can tell a
      recorded entry from "nothing to review". */
  async function applyReview(
    input: FinalizeChapterAudioInput,
    preserved: boolean,
    prev: BookStateJson | null,
  ): Promise<ReviewOutcome | undefined> {
    if (input.review === undefined) return undefined;
    const { bookDir, chapter } = input;
    const chapters: ChapterRef[] = prev?.chapters ?? [{ id: chapter.id, slug: chapter.slug }];
    try {
      if (input.review !== null && preserved) {
        await recordPending(bookDir, chapters, { /* …unchanged entry… */ });
        return 'recorded';
      }
      await dropPendingForChapter(bookDir, chapters, chapter.id);
      return 'none';
    } catch (err) {
      console.error(/* …unchanged… */, err);
      return 'failed';
    }
  }
  ```
  The result type: `/** Plan 285/286 — absent when `review` was undefined; see ReviewOutcome. */ reviewOutcome?: ReviewOutcome;`. Change the call site to `const reviewOutcome = await applyReview(…)` and the spread to `...(reviewOutcome === undefined ? {} : { reviewOutcome })`. Thread the same spread in the three routes. Then the OpenAPI, the `api.ts` types, `CLAUDE.md` and the plan 285 note, per Files.
  Check, in two parts (pass 4 #3 — Step 1 deliberately keeps `expect(line).not.toContain('reviewRecorded');` as a wire guard, so a single grep over test files can never come back clean):
  - `git -C <wt> grep -n "reviewRecorded" -- server/src src openapi.yaml CLAUDE.md ':!*.test.ts' ':!*.test.tsx'` → no hits. This includes the regenerated `src/lib/api-types.ts`.
  - `git -C <wt> grep -n "reviewRecorded" -- '*.test.ts' '*.test.tsx'` → **exactly two hits**, both the line `expect(line).not.toContain('reviewRecorded');`: one in `server/src/routes/chapter-splice.test.ts`, one in `server/src/routes/generation.test.ts`. Any other hit (a title, a header comment, a forced `reviewRecorded: false`) is a rename Step 1 missed.

- [ ] **Step 3: Green.** The three fast files and the slow `generation.test.ts` (same commands without `--retry=0`); `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts`; `typecheck`.

- [ ] **Step 4: Mutations.**
  1. **Collapse `'none'` into `'recorded'`** (the drop branch returns `'recorded'`) → red: `object + first render (nothing preserved)…` and `null: drops the chapter's entry…` (both get `'recorded'`). This is exactly the ambiguity OD29 needs gone.
  2. Collapse `'none'` into `'failed'` (the drop branch returns `'failed'`) → red: the same two tests.
  3. Return `'none'` from the `catch` → red: `a store failure → reviewOutcome:failed…`.
  4. In `chapter-splice.ts`, thread the old name (`reviewRecorded: result.reviewOutcome`) → red: the splice threading test (`done!.reviewOutcome` is `undefined`).

- [ ] **Step 5: Commit.** `refactor(server,openapi): report finalize's A/B review outcome as recorded / none / failed (#3400)`.

---

### Task 8: Mock revisions store (`src/mocks/mock-revisions.ts`)

**Character:** judgment (mirrors the server store's rules; pure module).

**Files:**
- Create: `src/mocks/mock-revisions.ts`.
- Modify: `src/data/revisions.ts` (the seeded `rev1` gains `playable: true`, `hasPreviousAudio: true`, `origin: 'server'`).
- Test: create `src/mocks/mock-revisions.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface MockRevisionsSeed { state?: Partial<Omit<RevisionsState, 'bookId'>>; previousChapterIds?: number[]; liveChapterIds?: number[] }
  export function seedMockRevisions(bookId: string, seed: MockRevisionsSeed): void;   // replaces that book
  export function resetMockRevisions(): void;
  export function hasMockRevisions(bookId: string): boolean;
  export function getMockRevisions(bookId: string): RevisionsState;                     // deep copy
  export function mockHasPrevious(bookId: string, chapterId: number): boolean;
  export function mockAcceptRevision(bookId: string, revisionId: string, selection?: Record<number, 'A' | 'B'>): RevisionsState; // throws RevisionOpFailure
  export function mockRejectRevision(bookId: string, revisionId: string): RevisionsState;  // throws RevisionOpFailure
  export function mockDismissDrift(bookId: string, driftId: string): RevisionsState;
  export function mockRestoreUnrecorded(bookId: string, chapterId: number): 'restored' | 'none'; // throws has_revision
  export function mockRecordRender(bookId: string, chapterId: number, review: { characterId: string; triggeredBy: string; oldDuration?: string; newDuration?: string } | null, opts?: { assumeLive?: boolean }): boolean;
  ```
- `RevisionOpFailure` comes from `src/lib/revision-op-failure.ts`, created **in this task** (it is needed here first; Task 9 reuses it):
  ```ts
  /* Plan 286 — the one error type every revisions op throws (real and mock),
     so the thunks branch on `code` only. Outside api.ts so the mocks can
     import it without a cycle. */
  import type { RevisionsState } from './types';

  export const REVISION_OP_CODES = [
    'invalid_selection', 'book_not_found', 'revision_not_found', 'chapter_busy', 'no_previous_audio',
    'live_audio_missing', 'revision_gone', 'restore_failed', 'has_revision', 'lock_contention', 'not_found',
  ] as const;
  export type RevisionOpCode = (typeof REVISION_OP_CODES)[number] | 'unexpected';

  export class RevisionOpFailure extends Error {
    constructor(message: string, readonly status: number, readonly code: RevisionOpCode, readonly state?: RevisionsState) {
      super(message);
      this.name = 'RevisionOpFailure';
    }
  }

  export async function revisionOpFailureFrom(res: Response, fallback: string): Promise<RevisionOpFailure> {
    const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown; state?: RevisionsState } | null;
    const raw = typeof body?.error === 'string' ? body.error : null;
    const known = raw !== null && (REVISION_OP_CODES as readonly string[]).includes(raw);
    const code: RevisionOpCode = known ? (raw as RevisionOpCode) : 'unexpected';
    const message = typeof body?.message === 'string' ? body.message : !known && raw !== null ? raw : fallback;
    return new RevisionOpFailure(message, res.status, code, body?.state);
  }
  ```
  and `src/lib/types.ts` gains `export type RevisionsState = components['schemas']['RevisionsState'];` beside `RevisionsResponse`.
- Rules (mirroring `revisions-store.ts` + `revision-ops.ts`): every write bumps `rev` and mints `fileId` if null; `mockRecordRender` — "had audio" = `assumeLive || liveChapterIds.has(ch)`; if it had audio, add `ch` to `previousChapterIds`; with `review` **and** audio, upsert the chapter's single entry (`origin:'server'`, id `revision:<ch>:<Date.now()>`, `playable:true`, `hasPreviousAudio:true`, `confidence:1`, `triggeredAgo:'just now'`, `segments:[]`); otherwise drop any entry for `ch`; always add `ch` to `liveChapterIds`; returns whether an entry was recorded. Accept/reject/dismiss/restore-unrecorded per the server routes; no busy rule (OD9).

- [ ] **Step 1: Failing tests** — `src/mocks/mock-revisions.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import * as m from './mock-revisions';
  import { RevisionOpFailure } from '../lib/revision-op-failure';

  const entry = (ch: number, id = `r${ch}`) => ({ id, chapterId: ch, characterId: 'eliza', segments: [], playable: true, hasPreviousAudio: true, origin: 'server' as const });
  const codeOf = (fn: () => unknown): string => { try { fn(); return 'no-throw'; } catch (e) { return (e as RevisionOpFailure).code; } };
  beforeEach(() => m.resetMockRevisions());

  describe('mock revisions store (plan 286)', () => {
    it('accept removes the entry, deletes previous, records the outcome and bumps rev', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(3)] }, previousChapterIds: [3], liveChapterIds: [3] });
      const s = m.mockAcceptRevision('b', 'r3', { 0: 'B' });
      expect(s.pending).toEqual([]);
      expect(s.timeline[3].map((t) => t.eventKind)).toEqual(['accepted']);
      expect(s.acceptedSelections.r3).toEqual({ 0: 'B' });
      expect(s.rev).toBe(1);
      expect(s.fileId).not.toBeNull();
      expect(m.mockHasPrevious('b', 3)).toBe(false);
    });
    it('a repeated accept answers the current state; a reject of an accepted id is 404', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(3)] }, previousChapterIds: [3], liveChapterIds: [3] });
      const first = m.mockAcceptRevision('b', 'r3');
      expect(m.mockAcceptRevision('b', 'r3')).toEqual(first);
      expect(codeOf(() => m.mockRejectRevision('b', 'r3'))).toBe('revision_not_found');
    });
    it('accept refuses live_audio_missing when only previous exists, and writes nothing', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(3)] }, previousChapterIds: [3], liveChapterIds: [] });
      expect(codeOf(() => m.mockAcceptRevision('b', 'r3'))).toBe('live_audio_missing');
      expect(m.getMockRevisions('b').rev).toBe(0);
    });
    it('reject with no previous is 409 no_previous_audio and keeps the entry', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(3)] }, liveChapterIds: [3] });
      expect(codeOf(() => m.mockRejectRevision('b', 'r3'))).toBe('no_previous_audio');
      expect(m.getMockRevisions('b').pending).toHaveLength(1);
    });
    it('a review render records only when the chapter already had audio', () => {
      expect(m.mockRecordRender('b', 1, { characterId: 'eliza', triggeredBy: 't' })).toBe(false);
      expect(m.getMockRevisions('b').pending).toEqual([]);
      expect(m.mockRecordRender('b', 1, { characterId: 'eliza', triggeredBy: 't' })).toBe(true);
      const p = m.getMockRevisions('b').pending;
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ chapterId: 1, origin: 'server', playable: true });
      expect(m.mockHasPrevious('b', 1)).toBe(true);
    });
    it('a plain render drops the chapter entry', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(2)] }, liveChapterIds: [2] });
      m.mockRecordRender('b', 2, null);
      expect(m.getMockRevisions('b').pending).toEqual([]);
    });
    it('restore-unrecorded: has_revision with an entry; restored / none otherwise', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(2)] }, previousChapterIds: [2, 4], liveChapterIds: [2, 4] });
      expect(codeOf(() => m.mockRestoreUnrecorded('b', 2))).toBe('has_revision');
      expect(m.mockRestoreUnrecorded('b', 4)).toBe('restored');
      expect(m.mockRestoreUnrecorded('b', 4)).toBe('none');
    });
    it('dismiss is idempotent and bumps rev once', () => {
      expect(m.mockDismissDrift('b', 'd').rev).toBe(1);
      expect(m.mockDismissDrift('b', 'd').rev).toBe(1);
      expect(m.getMockRevisions('b').dismissed).toEqual(['d']);
    });
    it('books are isolated, and the view carries its bookId', () => {
      m.seedMockRevisions('a', { state: { pending: [entry(1)] } });
      expect(m.getMockRevisions('b').pending).toEqual([]);
      expect(m.getMockRevisions('a').bookId).toBe('a');
    });
  });
  ```
  Run: `npm --prefix <wt> run test -- src/mocks/mock-revisions.test.ts --retry=0` → FAIL (module missing).

- [ ] **Step 2: Implement** `src/mocks/mock-revisions.ts`:
  ```ts
  /* Plan 286 — in-memory stand-in for server-owned revisions.json in mock mode
     (dev:mock + e2e). Mirrors server/src/workspace/revisions-store.ts and
     routes/revision-ops.ts closely enough that the client's cache rules and
     thunk branches behave the same against it. Separate module (like
     mock-queue.ts) so api.ts, main.tsx's window hook and unit tests share one
     table. `previous` mirrors `.previous` on disk; `live` mirrors live audio. */
  import type { Revision, RevisionsState, TimelineEntry } from '../lib/types';
  import { RevisionOpFailure, type RevisionOpCode } from '../lib/revision-op-failure';

  type MockFile = Omit<RevisionsState, 'bookId'>;
  interface Book { file: MockFile; previous: Set<number>; live: Set<number> }
  export interface MockRevisionsSeed { state?: Partial<MockFile>; previousChapterIds?: number[]; liveChapterIds?: number[] }

  const books = new Map<string, Book>();
  let mintSeq = 0;
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const emptyFile = (): MockFile => ({ fileId: null, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} });
  const mintFileId = () => `${String(Date.now()).padStart(15, '0')}-mock${(mintSeq++).toString(16)}`;

  function book(bookId: string): Book {
    let b = books.get(bookId);
    if (!b) { b = { file: emptyFile(), previous: new Set(), live: new Set() }; books.set(bookId, b); }
    return b;
  }
  const view = (bookId: string, b: Book): RevisionsState => ({ bookId, ...clone(b.file) });
  function save(b: Book, next: MockFile): void {
    b.file = { ...next, fileId: next.fileId ?? mintFileId(), rev: next.rev + 1 };
  }
  function fail(bookId: string, b: Book, status: number, code: RevisionOpCode, message: string, withState = true): never {
    throw new RevisionOpFailure(message, status, code, withState ? view(bookId, b) : undefined);
  }
  function hasOutcome(f: MockFile, kind: 'accepted' | 'rejected', id: string): boolean {
    return Object.values(f.timeline).some((list) => list.some((t) => t.id === id && t.eventKind === kind));
  }
  function appended(f: MockFile, e: TimelineEntry): MockFile['timeline'] {
    const key = e.chapterId as unknown as keyof MockFile['timeline'];
    const prior = (f.timeline[key] ?? []).map((t) => (e.reversible ? { ...t, reversible: false } : t));
    return { ...f.timeline, [key]: [...prior, e] };
  }

  export function seedMockRevisions(bookId: string, seed: MockRevisionsSeed): void {
    books.set(bookId, {
      file: { ...emptyFile(), ...clone(seed.state ?? {}) },
      previous: new Set(seed.previousChapterIds ?? []),
      live: new Set(seed.liveChapterIds ?? []),
    });
  }
  export function resetMockRevisions(): void { books.clear(); }
  export function hasMockRevisions(bookId: string): boolean { return books.has(bookId); }
  export function getMockRevisions(bookId: string): RevisionsState { return view(bookId, book(bookId)); }
  export function mockHasPrevious(bookId: string, chapterId: number): boolean { return book(bookId).previous.has(chapterId); }

  function findOrDone(bookId: string, revisionId: string, kind: 'accepted' | 'rejected'): { b: Book; entry?: Revision; done?: RevisionsState } {
    const b = book(bookId);
    const entry = b.file.pending.find((p) => p.id === revisionId);
    if (entry) return { b, entry };
    if (hasOutcome(b.file, kind, revisionId)) return { b, done: view(bookId, b) };
    return fail(bookId, b, 404, 'revision_not_found', 'This take was replaced by a newer render or is no longer pending.');
  }
  function commit(bookId: string, b: Book, entry: Revision, kind: 'accepted' | 'rejected', selection?: Record<number, 'A' | 'B'>): RevisionsState {
    save(b, {
      ...b.file,
      pending: b.file.pending.filter((p) => p.id !== entry.id),
      timeline: appended(b.file, { id: entry.id, chapterId: entry.chapterId, characterId: entry.characterId, eventKind: kind, timestamp: new Date().toISOString(), status: 'active', reversible: true }),
      acceptedSelections: kind === 'accepted' ? { ...b.file.acceptedSelections, [entry.id]: selection ?? {} } : b.file.acceptedSelections,
    });
    return view(bookId, b);
  }

  export function mockAcceptRevision(bookId: string, revisionId: string, selection?: Record<number, 'A' | 'B'>): RevisionsState {
    const { b, entry, done } = findOrDone(bookId, revisionId, 'accepted');
    if (done) return done;
    const ch = entry!.chapterId;
    if (!b.live.has(ch) && b.previous.has(ch)) {
      fail(bookId, b, 409, 'live_audio_missing', "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it.");
    }
    b.previous.delete(ch);
    return commit(bookId, b, entry!, 'accepted', selection);
  }
  export function mockRejectRevision(bookId: string, revisionId: string): RevisionsState {
    const { b, entry, done } = findOrDone(bookId, revisionId, 'rejected');
    if (done) return done;
    const ch = entry!.chapterId;
    if (!b.previous.has(ch)) fail(bookId, b, 409, 'no_previous_audio', 'Original audio not preserved.');
    b.previous.delete(ch);
    b.live.add(ch);
    return commit(bookId, b, entry!, 'rejected');
  }
  export function mockDismissDrift(bookId: string, driftId: string): RevisionsState {
    const b = book(bookId);
    if (!b.file.dismissed.includes(driftId)) save(b, { ...b.file, dismissed: [...b.file.dismissed, driftId] });
    return view(bookId, b);
  }
  export function mockRestoreUnrecorded(bookId: string, chapterId: number): 'restored' | 'none' {
    const b = book(bookId);
    if (b.file.pending.some((p) => p.chapterId === chapterId)) {
      fail(bookId, b, 409, 'has_revision', "This chapter has an older pending review — resolve it from the chapter's review first.", false);
    }
    if (!b.previous.has(chapterId)) return 'none';
    b.previous.delete(chapterId);
    b.live.add(chapterId);
    return 'restored';
  }
  export function mockRecordRender(
    bookId: string,
    chapterId: number,
    review: { characterId: string; triggeredBy: string; oldDuration?: string; newDuration?: string } | null,
    opts: { assumeLive?: boolean } = {},
  ): boolean {
    const b = book(bookId);
    const hadAudio = opts.assumeLive === true || b.live.has(chapterId);
    if (hadAudio) b.previous.add(chapterId);
    b.live.add(chapterId);
    const others = b.file.pending.filter((p) => p.chapterId !== chapterId);
    if (review && hadAudio) {
      const entry: Revision = {
        id: `revision:${chapterId}:${Date.now()}`, chapterId, characterId: review.characterId,
        triggeredBy: review.triggeredBy, triggeredAgo: 'just now', oldDuration: review.oldDuration ?? '', newDuration: review.newDuration ?? '',
        confidence: 1, playable: true, hasPreviousAudio: true, segments: [], origin: 'server',
      };
      save(b, { ...b.file, pending: [...others, entry] });
      return true;
    }
    if (others.length !== b.file.pending.length) save(b, { ...b.file, pending: others });
    return false;
  }
  ```
  In `src/data/revisions.ts`, add `playable: true, hasPreviousAudio: true, origin: 'server',` to `rev1`.

- [ ] **Step 3: Green.** The new test, `typecheck`.

- [ ] **Step 4: Mutations.**
  1. In `mockRecordRender`, drop `&& hadAudio` from the record branch → red: `a review render records only when the chapter already had audio` (the first call returns `true`).
  2. Remove the `live_audio_missing` check → red: `accept refuses live_audio_missing…`.
  3. In `hasOutcome`, drop `&& t.eventKind === kind` → red: `a repeated accept…; a reject of an accepted id is 404` (reject answers the accepted state as "done").

- [ ] **Step 5: Commit.** `feat(mocks): add an in-memory server-owned revisions store for mock mode (#3400)`.

---

### Task 9: Client API — real and mock op functions, and mock/real parity

**Character:** mechanical.

**Why both halves at once:** `api` is `USE_MOCKS ? mock : real` (`api.ts:10803`), a union type; `api.acceptRevision` is a TS2339 error until **both** objects have it.

**Files:**
- Modify: `src/lib/api.ts` (`real` object next to `acceptChapterRevision`; `mock` object; two type exports).
- Test: create `src/lib/api-revision-ops.test.ts`; extend `src/lib/api-types.revisions-contract.test.ts`.

**Interfaces:**
- Consumes: Task 8's `RevisionOpFailure`, `revisionOpFailureFrom`, mock store.
- Produces (both `real` and `mock`):
  - `acceptRevision(args: { bookId: string; revisionId: string; selection?: Record<number, 'A' | 'B'> }): Promise<RevisionsState>`
  - `rejectRevision(args: { bookId: string; revisionId: string }): Promise<RevisionsState>`
  - `dismissDrift(args: { bookId: string; driftId: string }): Promise<RevisionsState>`
  - `restorePreviousUnrecorded(args: { bookId: string; chapterId: number }): Promise<'restored' | 'none'>`
  - Each throws `RevisionOpFailure` on any other outcome.
- Produces: `export type __MockApi = typeof mock; export type __RealApi = typeof real;` (after `const mock = {…}`).

- [ ] **Step 1: Failing tests.** `src/lib/api-revision-ops.test.ts` (vitest runs with `USE_MOCKS=false`, so `api === real`):
  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { api } from './api';
  import { RevisionOpFailure } from './revision-op-failure';

  const STATE = { bookId: 'b', fileId: '000000000000001-a', rev: 2, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} };
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  describe('plan 286 — revision op routes (real)', () => {
    it('accept POSTs the selection to the per-op route and returns the state', async () => {
      fetchMock.mockResolvedValueOnce(json(200, STATE));
      const out = await api.acceptRevision({ bookId: 'b k', revisionId: 'revision:3:1', selection: { 0: 'A' } });
      expect(out).toEqual(STATE);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/books/b%20k/revisions/revision%3A3%3A1/accept');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ selection: { 0: 'A' } });
    });
    it('accept with no selection sends {}', async () => {
      fetchMock.mockResolvedValueOnce(json(200, STATE));
      await api.acceptRevision({ bookId: 'b', revisionId: 'r' });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    });
    it('a coded 409 throws RevisionOpFailure carrying code, message and state', async () => {
      fetchMock.mockResolvedValueOnce(json(409, { error: 'revision_gone', message: 'gone', state: STATE }));
      const err = await api.rejectRevision({ bookId: 'b', revisionId: 'r' }).catch((e) => e);
      expect(err).toBeInstanceOf(RevisionOpFailure);
      expect(err).toMatchObject({ status: 409, code: 'revision_gone', message: 'gone', state: STATE });
    });
    it('an uncoded 500 is "unexpected" and keeps the server sentence', async () => {
      fetchMock.mockResolvedValueOnce(json(500, { error: 'Failed to dismiss drift.' }));
      const err = await api.dismissDrift({ bookId: 'b', driftId: 'd' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'unexpected', message: 'Failed to dismiss drift.' });
    });
    it('dismiss POSTs to the drift route of the given book', async () => {
      fetchMock.mockResolvedValueOnce(json(200, STATE));
      await api.dismissDrift({ bookId: 'b', driftId: 'drift:b:1:eliza:voice' });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/books/b/drift/drift%3Ab%3A1%3Aeliza%3Avoice/dismiss');
    });
    it('restore-unrecorded: 204 → restored, 404 → none, 409 → throws has_revision', async () => {
      fetchMock.mockResolvedValueOnce(json(204, null)).mockResolvedValueOnce(json(404, { error: 'no_previous_audio' }))
        .mockResolvedValueOnce(json(409, { error: 'has_revision', message: 'older' }));
      expect(await api.restorePreviousUnrecorded({ bookId: 'b', chapterId: 3 })).toBe('restored');
      expect(await api.restorePreviousUnrecorded({ bookId: 'b', chapterId: 3 })).toBe('none');
      await expect(api.restorePreviousUnrecorded({ bookId: 'b', chapterId: 3 })).rejects.toMatchObject({ code: 'has_revision' });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/books/b/chapters/3/audio/previous/restore-unrecorded');
    });
  });
  ```
  In `api-types.revisions-contract.test.ts`:
  ```ts
  import type { __MockApi, __RealApi } from './api';
  it('plan 286 — mock and real revisions functions have identical signatures', () => {
    type K = 'acceptRevision' | 'rejectRevision' | 'dismissDrift' | 'restorePreviousUnrecorded';
    expectTypeOf<Pick<__MockApi, K>>().toEqualTypeOf<Pick<__RealApi, K>>();
  });
  ```
  (Task 10 widens `K` to the read functions it reshapes.)

  Run: `npm --prefix <wt> run test -- src/lib/api-revision-ops.test.ts --retry=0` → FAIL (`api.acceptRevision is not a function`); `typecheck` → FAIL (`__MockApi` not exported).

- [ ] **Step 2: Implement.** `real`, after `rejectChapterRevision` (import `revisionOpFailureFrom` and `type RevisionsState`):
  ```ts
  /* Plan 286 — server-owned revisions operations (plan 285 routes). */
  acceptRevision: async ({ bookId, revisionId, selection }: { bookId: string; revisionId: string; selection?: Record<number, 'A' | 'B'> }): Promise<RevisionsState> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/revisions/${encodeURIComponent(revisionId)}/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection ? { selection } : {}),
    });
    if (!res.ok) throw await revisionOpFailureFrom(res, `Accept failed (${res.status}).`);
    return res.json();
  },
  rejectRevision: async ({ bookId, revisionId }: { bookId: string; revisionId: string }): Promise<RevisionsState> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/revisions/${encodeURIComponent(revisionId)}/reject`, { method: 'POST' });
    if (!res.ok) throw await revisionOpFailureFrom(res, `Reject failed (${res.status}).`);
    return res.json();
  },
  dismissDrift: async ({ bookId, driftId }: { bookId: string; driftId: string }): Promise<RevisionsState> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/drift/${encodeURIComponent(driftId)}/dismiss`, { method: 'POST' });
    if (!res.ok) throw await revisionOpFailureFrom(res, `Dismiss failed (${res.status}).`);
    return res.json();
  },
  restorePreviousUnrecorded: async ({ bookId, chapterId }: { bookId: string; chapterId: number }): Promise<'restored' | 'none'> => {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/audio/previous/restore-unrecorded`, { method: 'POST' });
    if (res.status === 204) return 'restored';
    if (res.status === 404) return 'none';
    throw await revisionOpFailureFrom(res, `Restore failed (${res.status}).`);
  },
  ```
  `mock` (import the four mock-store functions):
  ```ts
  acceptRevision: async ({ bookId, revisionId, selection }: { bookId: string; revisionId: string; selection?: Record<number, 'A' | 'B'> }): Promise<RevisionsState> => { await wait(100); return mockAcceptRevision(bookId, revisionId, selection); },
  rejectRevision: async ({ bookId, revisionId }: { bookId: string; revisionId: string }): Promise<RevisionsState> => { await wait(100); return mockRejectRevision(bookId, revisionId); },
  dismissDrift: async ({ bookId, driftId }: { bookId: string; driftId: string }): Promise<RevisionsState> => { await wait(60); return mockDismissDrift(bookId, driftId); },
  restorePreviousUnrecorded: async ({ bookId, chapterId }: { bookId: string; chapterId: number }): Promise<'restored' | 'none'> => { await wait(60); return mockRestoreUnrecorded(bookId, chapterId); },
  ```
  and after `const mock = {…};`: `export type __MockApi = typeof mock;` / `export type __RealApi = typeof real;`.

- [ ] **Step 3: Green.** Both test files, `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Drop `encodeURIComponent` around `revisionId` in `acceptRevision` → red: `accept POSTs the selection…` (URL contains raw `:`).
  2. In `revisionOpFailureFrom`, use `raw` as the code without the known-code check (`const code = (raw ?? 'unexpected') as RevisionOpCode`) → red: `an uncoded 500 is "unexpected"…`.
  3. Change the mock `dismissDrift` to return `Promise<void>` (drop the `return`) → `typecheck` red at `mock and real revisions functions have identical signatures`.

- [ ] **Step 5: Commit.** `feat(frontend,mocks): add per-op revisions api calls, real and mock (#3400)`.

---

### Task 10: Mock API reads — per-book poll (D7), dismissed filter, previous audio, `getBookState` overlay

**Character:** judgment (several mock functions in a 10k-line file).

**Files:**
- Modify: `src/lib/api.ts`: `buildSolwayBayMockState` (drop `revisions: { pending: PENDING_REVISIONS }` and its comment), the default-seeding function that calls `MOCK_BOOK_STATES.set('sb', …)` (`~:1189`), `mockGetBookState` (`~:1288`), `mockPollRevisions` (`~:1939`), `mockGetChapterAudioPrevious` (`~:1900`).
- Test: create `src/lib/api.mock-revisions.test.ts`; extend the parity test.

**Interfaces:**
- `mockPollRevisions({ bookId })` returns `{ ...getMockRevisions(bookId), drift }` where `drift` is today's per-book fixture selection (both the `DEMO_CAPTURE` and normal branches) **filtered by the store's `dismissed`**.
- Mock `getBookState(bookId)`: when the stored response exists **and** `hasMockRevisions(bookId)`, overlay `revisions: getMockRevisions(bookId)`; otherwise unchanged (so `api.mock-state.test.ts`'s `revisions: null` expectation for an unseeded book holds).
- `mockGetChapterAudioPrevious({ bookId, chapterId, duration })` returns `null` unless `mockHasPrevious(bookId, chapterId)`; return type `Promise<ChapterAudio | null>`.
- Default seed: `resetMockRevisions(); seedMockRevisions('sb', { state: { pending: [PENDING_REVISIONS[0]] }, previousChapterIds: [3], liveChapterIds: SB_CHAPTERS.map((c) => c.id) });` in the seeding function, so `_resetMockBookStates()` resets it too.
- Test-only exports: `export { mockPollRevisions as _mockPollRevisions, mockGetChapterAudioPrevious as _mockGetChapterAudioPrevious };` (mirrors `_resetMockBookStates`); `mockGetBookState` is already exported (`export async function mockGetBookState` — confirm; if not, export it the same way).

- [ ] **Step 1: Failing tests** — `src/lib/api.mock-revisions.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { _resetMockBookStates, _mockPollRevisions, _mockGetChapterAudioPrevious, mockGetBookState } from './api';
  import { seedMockRevisions, mockDismissDrift } from '../mocks/mock-revisions';

  beforeEach(() => _resetMockBookStates());

  describe('mock API reads per-book revisions (plan 286, D7)', () => {
    it('the poll returns each book its own pending, never the sb fixture for every book', async () => {
      expect((await _mockPollRevisions({ bookId: 'sb' })).pending?.map((p) => p.id)).toEqual(['rev1']);
      expect((await _mockPollRevisions({ bookId: 'cc' })).pending).toEqual([]);
    });
    it('the poll carries bookId, fileId and rev', async () => {
      expect(await _mockPollRevisions({ bookId: 'sb' })).toMatchObject({ bookId: 'sb', fileId: null, rev: 0 });
    });
    it('the poll omits dismissed drift events', async () => {
      const before = (await _mockPollRevisions({ bookId: 'sb' })).drift ?? [];
      expect(before.length).toBeGreaterThan(0);
      mockDismissDrift('sb', before[0].id);
      const after = (await _mockPollRevisions({ bookId: 'sb' })).drift ?? [];
      expect(after.map((d) => d.id)).not.toContain(before[0].id);
      expect(after).toHaveLength(before.length - 1);
    });
    it('getBookState overlays the mock revisions state for a seeded book only', async () => {
      seedMockRevisions('cc', { state: { pending: [{ id: 'x', chapterId: 1, characterId: 'eliza', segments: [], origin: 'server' }] } });
      expect((await mockGetBookState('cc'))?.revisions?.pending?.map((p) => p.id)).toEqual(['x']);
      expect((await mockGetBookState('ns'))?.revisions ?? null).toBeNull();
    });
    it('previous audio is null unless the chapter is in previousChapterIds', async () => {
      expect(await _mockGetChapterAudioPrevious({ bookId: 'sb', chapterId: 3, duration: '11:31' })).not.toBeNull();
      expect(await _mockGetChapterAudioPrevious({ bookId: 'sb', chapterId: 4, duration: '11:31' })).toBeNull();
    });
  });
  ```
  (If `ns`'s fixture has a non-null `revisions`, use any mock book id whose stored `revisions` is `null`, or assert equality with the stored value: `expect(r?.revisions).toEqual(storedBefore)`.) Widen the parity test's `K` with `'pollRevisions' | 'pollRevisionsBulk' | 'getChapterAudioPrevious'`.

  Run → FAIL (`cc` gets `rev1`; no `fileId`; dismissed event still present; previous for ch 4 non-null; parity fails on `getChapterAudioPrevious`'s return type).

- [ ] **Step 2: Implement** per Interfaces. In `mockPollRevisions`, keep `await wait(200)` and the existing drift selection, then:
  ```ts
  /* Plan 286 — pending, dismissed etc. come from the per-book mock store (D7);
     drift the store has dismissed is filtered, as the server does. */
  const state = getMockRevisions(args.bookId);
  const dismissed = new Set(state.dismissed);
  return { ...state, drift: drift.filter((d) => !dismissed.has(d.id)) };
  ```
  (restructure the two existing `return`s to compute `drift` first). Delete the two stale comment paragraphs about `pending` being inert and about the phantom revision. Update `mockGetChapterAudioPrevious`'s header comment ("resolves only when the mock store mirrors a `.previous`").

- [ ] **Step 3: Green.** The new file, `src/lib/api.mock-state.test.ts`, the parity test, `typecheck`; e2e `npm --prefix <wt> run test:e2e -- e2e/revision-diff.spec.ts e2e/drift-report-multibook.spec.ts e2e/profile-regen-preview.spec.ts` (the `sb` player still opens; drift per book; `profile-regen-preview`'s player opens via the old path — its A card now reads "Original audio not preserved", which no assertion checks).

- [ ] **Step 4: Mutations.**
  1. Make `mockPollRevisions` spread `{ pending: PENDING_REVISIONS }` back in → red: `the poll returns each book its own pending…`.
  2. Remove the dismissed filter → red: `the poll omits dismissed drift events`.
  3. Remove the `mockHasPrevious` early return → red: `previous audio is null unless…`.

- [ ] **Step 5: Commit.** `fix(mocks): serve per-book revisions from the mock store (D7) (#3400)`.

---

### Task 11: Mock renders record pending; `window.__mockRevisions`; splice delay hook

**Character:** judgment.

**Files:**
- Modify: `src/lib/api.ts`: `mockStreamSplice` (`~:1760`), `mockStreamGeneration`'s `chapter_complete` emission (`~:1720`), `mockStreamQaRepair` (`~:1795`, pass 4 #2 — mock/server parity).
- Modify: `src/main.tsx` (DEV/e2e hook block, beside `__mockQueue`).
- Test: extend `src/lib/api.mock-revisions.test.ts`.

**Interfaces:**
- `mockStreamSplice({ bookId, chapterId, mode, characterId, onTick })`: per-step delay `(window as { __mockSpliceDelayMs?: number }).__mockSpliceDelayMs ?? 80`. Before `splice_complete`: `mockRecordRender(bookId, chapterId, { characterId, triggeredBy }, { assumeLive: true })` with `triggeredBy = \`${mode === 'remix' ? 'Loudness fix' : 'Re-record'} (${firstName})\``, `firstName` = first word of the mock cast's `name` for `characterId` (`MOCK_BOOK_STATES.get(bookId)?.cast?.characters`), falling back to `characterId`. `splice_complete` carries `reviewOutcome: 'recorded'` (a splice always has audio).
- `mockStreamGeneration`: destructure `bookId`, `chapterIds`, `review` from `StreamArgs`. `const reviewChapterId = review && chapterIds?.length === 1 ? chapterIds[0] : null;`. On each `chapter_complete` for `active.id`: if `active.id === reviewChapterId`, call `mockRecordRender(bookId, active.id, { ...review, oldDuration: active.duration, newDuration: active.duration })` and add `reviewChapter: true, reviewOutcome: recorded ? 'recorded' : 'none'` to the tick, where `recorded` is `mockRecordRender`'s return. This mirrors Task 7: `'none'` is a first render, which records nothing; otherwise `mockRecordRender(bookId, active.id, null)` and the tick carries `reviewOutcome: 'none'` (no `reviewChapter`).
- **Parity with the server after Task 27 (pass 4 #2).** From Task 27 on, every real finalize is asked about review: generation passes `job.review` (`null` without one) and QA repair passes `review: null`, so a plain `chapter_complete` and every `qa_repair_complete` carry `reviewOutcome: 'none'` (the chapter's entry was dropped). The mock does the same from this task on:
  - the plain-render `chapter_complete` above carries `reviewOutcome: 'none'`;
  - `mockStreamQaRepair({ bookId, chapterId, onTick })` calls `mockRecordRender(bookId, chapterId, null)` before `qa_repair_complete`, and that frame carries `reviewOutcome: 'none'`.
  (No client code reads `reviewOutcome` off a plain `chapter_complete` or a `qa_repair_complete`; Task 24's runner keys on `reviewChapter === true`. Parity keeps mock-mode and e2e runs from diverging from the real wire.)
- `window.__mockRevisions = { seed: seedMockRevisions, get: getMockRevisions, reset: resetMockRevisions }`.
- Test-only exports: `_mockStreamSplice`, `_mockStreamGeneration`, `_mockStreamQaRepair`.

- [ ] **Step 1: Failing tests** (append to `api.mock-revisions.test.ts`; add `vi` and `afterEach` to the import, and `_mockStreamSplice`, `_mockStreamGeneration`, `_mockStreamQaRepair` to the `./api` import, `seedMockRevisions`/`getMockRevisions` from the store):
  ```ts
  describe('mock renders record pending (plan 286)', () => {
    afterEach(() => vi.useRealTimers());

    it('a splice records a server entry for the chapter and reports reviewOutcome recorded', async () => {
      const ticks: Array<{ type: string; reviewOutcome?: string }> = [];
      await _mockStreamSplice({ bookId: 'cc', chapterId: 2, mode: 'remix', characterId: 'eliza_cc', gainDb: 3, onTick: (t) => ticks.push(t) } as never);
      expect(ticks.at(-1)).toMatchObject({ type: 'splice_complete', reviewOutcome: 'recorded' });
      const p = getMockRevisions('cc').pending;
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ chapterId: 2, origin: 'server', triggeredBy: expect.stringMatching(/^Loudness fix \(/) });
    });

    const genArgs = (withReview: boolean, onTick: (t: Record<string, unknown>) => void) => ({
      bookId: 'cc', modelKey: 'kokoro-v1', chapterIds: [1], force: true, mockGenConcurrency: 1,
      ...(withReview ? { review: { characterId: 'eliza_cc', triggeredBy: 'Eliza voice change' } } : {}),
      getChapters: () => [{ id: 1, title: 'One', duration: '01:00', state: 'in_progress', progress: 0.99, totalLines: 10, characters: {} }],
      onTick,
    });

    it('a review render of a chapter with audio records an entry and stamps reviewChapter on chapter_complete', async () => {
      vi.useFakeTimers();
      seedMockRevisions('cc', { liveChapterIds: [1] });
      const ticks: Array<Record<string, unknown>> = [];
      const stop = _mockStreamGeneration(genArgs(true, (t) => ticks.push(t)) as never);
      await vi.advanceTimersByTimeAsync(1300);
      stop();
      expect(ticks.find((t) => t.type === 'chapter_complete')).toMatchObject({ chapterId: 1, reviewChapter: true, reviewOutcome: 'recorded' });
      expect(getMockRevisions('cc').pending).toHaveLength(1);
    });

    it('a first render (no audio yet) records nothing but still stamps reviewChapter', async () => {
      vi.useFakeTimers();
      const ticks: Array<Record<string, unknown>> = [];
      const stop = _mockStreamGeneration(genArgs(true, (t) => ticks.push(t)) as never);
      await vi.advanceTimersByTimeAsync(1300);
      stop();
      expect(ticks.find((t) => t.type === 'chapter_complete')).toMatchObject({ reviewChapter: true, reviewOutcome: 'none' });
      expect(getMockRevisions('cc').pending).toEqual([]);
    });

    it('a render without review never stamps reviewChapter, reports reviewOutcome none and drops the chapter entry', async () => {
      vi.useFakeTimers();
      seedMockRevisions('cc', { state: { pending: [{ id: 'old', chapterId: 1, characterId: 'eliza_cc', segments: [], origin: 'server' }] }, liveChapterIds: [1] });
      const ticks: Array<Record<string, unknown>> = [];
      const stop = _mockStreamGeneration(genArgs(false, (t) => ticks.push(t)) as never);
      await vi.advanceTimersByTimeAsync(1300);
      stop();
      const done = ticks.find((t) => t.type === 'chapter_complete');
      expect(done).not.toHaveProperty('reviewChapter');
      expect(done).toMatchObject({ reviewOutcome: 'none' }); // the server's answer for review:null (Task 27)
      expect(getMockRevisions('cc').pending).toEqual([]);
    });

    it('a QA repair drops the chapter entry and reports reviewOutcome none, as the server does with review:null', async () => {
      seedMockRevisions('cc', { state: { pending: [{ id: 'old', chapterId: 2, characterId: 'eliza_cc', segments: [], origin: 'server' }] }, liveChapterIds: [2] });
      const ticks: Array<{ type: string; reviewOutcome?: string }> = [];
      await _mockStreamQaRepair({ bookId: 'cc', chapterId: 2, onTick: (t) => ticks.push(t) } as never);
      expect(ticks.at(-1)).toMatchObject({ type: 'qa_repair_complete', reviewOutcome: 'none' });
      expect(getMockRevisions('cc').pending).toEqual([]);
    });
  });
  ```
  Before writing `genArgs`, read `mockStreamGeneration`'s body (`~:1633-1760`) and make `getChapters()`'s row shape match the fields it reads (`id`, `state`, `progress`, `totalLines`, `characters`, `duration`); the mock completes a chapter whose progress reaches 1 on its next 1200 ms tick.

  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces. `main.tsx`:
  ```ts
  /* Plan 286 — let e2e specs seed/read the mock server-owned revisions.json. */
  void import('./mocks/mock-revisions').then(({ seedMockRevisions, getMockRevisions, resetMockRevisions }) => {
    (window as unknown as { __mockRevisions: unknown }).__mockRevisions = {
      seed: seedMockRevisions,
      get: getMockRevisions,
      reset: resetMockRevisions,
    };
  });
  ```

- [ ] **Step 3: Green.** The test file, `typecheck`, e2e `character-splice.spec.ts profile-regen-preview.spec.ts qa-repair.spec.ts` (the client still enqueues its own pending at this point, so the first two stay green; `qa-repair.spec.ts` repairs `sb` chapter 1, while the seeded `sb` entry is chapter 3, so the new mock drop touches nothing it checks).

- [ ] **Step 4: Mutations.**
  1. Pass `{ assumeLive: false }` in `mockStreamSplice` → red: `a splice records a server entry…` (`cc` has no live chapters).
  2. Stamp `reviewChapter: true` on every `chapter_complete` → red: `a render without review never stamps reviewChapter…`.
  3. Skip `mockRecordRender(bookId, active.id, null)` for plain renders → red: same test (`old` still pending).
  4. Omit `reviewOutcome` from the plain-render `chapter_complete` → red: `a render without review … reports reviewOutcome none …`, at `toMatchObject({ reviewOutcome: 'none' })`.
  5. In `mockStreamQaRepair`, skip the `mockRecordRender(bookId, chapterId, null)` call → red: `a QA repair drops the chapter entry …` (`old` still pending).

- [ ] **Step 5: Commit.** `feat(mocks): record pending on mock splices and review renders (#3400)`.

---

### Task 12: Revisions slice — the ordered cache, selectors, and the hydrate sequence guard (additive)

**Character:** judgment (the ordering rule is the heart of the PR).

**Files:**
- Modify: `src/store/revisions-slice.ts`.
- Test: create `src/store/revisions-slice.cache.test.ts`; touch `src/store/revisions-slice.test.ts` (initial-state assertion).

**Interfaces:**
- Produces (fields): `fileId: string | null` (initial `null`), `rev: number` (initial `0`), `adoptSeq: number` (initial `0`; increments on every adoption that **changes** `(bookId, fileId, rev)` — an equal-version no-op adoption, e.g. a routine poll at the same `rev`, does not bump it, so it cannot make an in-flight hydrate look stale).
- Produces (pure): `export function compareFileIds(a: string | null, b: string | null): number`.
- Produces (reducers):
  - `hydrate(payload: { bookId: string; state: Partial<RevisionsState> | null; requestSeq?: number })`:
    1. **Sequence guard** (operator decision): if `payload.bookId === s.bookId` and `requestSeq !== undefined` and `requestSeq < s.adoptSeq`, an op or poll adopted newer state after this read started → drop the payload (only `loaded = true`).
    2. Otherwise adopt when `bookId` differs **or** `(state?.fileId ?? null) !== s.fileId`; else only when `(state?.rev ?? 0) >= s.rev`.
    3. `loaded = true`. **Transitional:** set `s.hydratedFor = bookId` (deleted with the field in Task 26) so the old persistence gate keeps working until then.
  - `applyServerState(payload: RevisionsState)`: ordered adopt.
  - `applyDismiss(payload: { driftId: string; state?: RevisionsState })`: always removes the event from `drift`; applies `state` through the ordered rule when given.
  - `forgetBook(payload: string)`: if `s.bookId === payload`, resets `bookId`, `fileId`, `rev` and the four per-book fields.
  - **Ordered adopt:** different `bookId` → adopt; same book → `compareFileIds(incoming, cached)`: `> 0` adopt, `< 0` ignore, `0` adopt iff `incoming.rev >= cached.rev`.
  - *Adopt* sets `bookId`, `fileId`, `rev`, `pending`, `dismissed`, `acceptedSelections`, `timeline` (via `normaliseTimelineKeys`) and increments `adoptSeq` **only if** `(bookId, fileId, rev)` differs from what the cache held. Never touches `drift` or `loaded`.
- Produces (selectors): `selectActivePending`, `selectActiveTimeline`, `selectActiveAcceptedSelections` over `{ revisions: RevisionsState; ui: { stage: unknown } }`.
- `bookScopeChanged` (alive until Task 26) also resets `fileId = null; rev = 0`.
- `applyPoll` is **not** changed here (Task 19).

- [ ] **Step 1: Failing tests** — `src/store/revisions-slice.cache.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { revisionsSlice, revisionsActions as a, compareFileIds, selectActivePending, type RevisionsState } from './revisions-slice';

  type Act = Parameters<typeof revisionsSlice.reducer>[1];
  const reduce = (s: RevisionsState, ...acts: Act[]) => acts.reduce(revisionsSlice.reducer, s);
  const init = () => revisionsSlice.reducer(undefined, { type: '@@init' });
  const st = (o: Partial<{ bookId: string; fileId: string | null; rev: number; ids: string[] }>) => ({
    bookId: o.bookId ?? 'A', fileId: o.fileId ?? null, rev: o.rev ?? 0,
    pending: (o.ids ?? []).map((id) => ({ id, chapterId: 1, characterId: 'c', segments: [] })),
    dismissed: [] as string[], acceptedSelections: {}, timeline: {},
  });
  const F1 = '000000000000001-aa', F2 = '000000000000002-aa', F2b = '000000000000002-bb';

  describe('compareFileIds', () => {
    it('null is older than any id; ids order by epoch; a same-ms tie breaks on the suffix', () => {
      expect(compareFileIds(null, F1)).toBeLessThan(0);
      expect(compareFileIds(F1, null)).toBeGreaterThan(0);
      expect(compareFileIds(F1, F2)).toBeLessThan(0);
      expect(compareFileIds(F2, F2b)).toBeLessThan(0);
      expect(compareFileIds(F2b, F2)).toBeGreaterThan(0);
      expect(compareFileIds(null, null)).toBe(0);
    });
  });

  describe('applyServerState — ordered adopt', () => {
    it('adopts a different book', () => {
      const s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F2, rev: 5, ids: ['a'] })), a.applyServerState(st({ bookId: 'B', fileId: F1, rev: 1, ids: ['b'] })));
      expect(s.bookId).toBe('B'); expect(s.pending.map((p) => p.id)).toEqual(['b']);
    });
    it('ignores a lower rev within one fileId; adopts an equal or higher rev', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['x'] })));
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 2, ids: [] })));
      expect(s.pending.map((p) => p.id)).toEqual(['x']);
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 3, ids: ['y'] })));
      expect(s.pending.map((p) => p.id)).toEqual(['y']);
    });
    it("null → id adopts (a legacy book's first op), and a newer fileId adopts even at a lower rev", () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: null, rev: 0, ids: ['legacy'] })));
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 1, ids: [] })));
      expect(s.fileId).toBe(F1);
      s = reduce(s, a.applyServerState(st({ fileId: F2, rev: 0, ids: ['reset'] })));
      expect(s.fileId).toBe(F2); expect(s.rev).toBe(0); expect(s.pending.map((p) => p.id)).toEqual(['reset']);
    });
    it('ignores an older fileId (a late pre-reset response) and a null fileId over a non-null cache', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F2, rev: 0, ids: [] })));
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 9, ids: ['stale'] })));
      s = reduce(s, a.applyServerState(st({ fileId: null, rev: 9, ids: ['legacy'] })));
      expect(s.fileId).toBe(F2); expect(s.pending).toEqual([]);
    });
    it('a changing adoption increments adoptSeq; an ignored or equal-version payload does not', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 1 })));
      expect(s.adoptSeq).toBe(1);
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 0 })));
      expect(s.adoptSeq).toBe(1);
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 1 })));
      expect(s.adoptSeq).toBe(1);
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 2 })));
      expect(s.adoptSeq).toBe(2);
    });
  });

  describe('hydrate', () => {
    it('adopts a different fileId even when it is null (delete + re-import under the same id)', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F2, rev: 4, ids: ['old'] })));
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0 }), requestSeq: s.adoptSeq }));
      expect(s.fileId).toBeNull(); expect(s.pending).toEqual([]);
    });
    it('with the same fileId, a stale hydrate does not drop a newer entry', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['new'] })));
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: F1, rev: 2 }), requestSeq: s.adoptSeq }));
      expect(s.pending.map((p) => p.id)).toEqual(['new']);
    });
    it('a null state for a new book adopts an empty cache and flips loaded', () => {
      const s = reduce(init(), a.hydrate({ bookId: 'A', state: null }));
      expect(s).toMatchObject({ bookId: 'A', fileId: null, rev: 0, pending: [], loaded: true });
    });
    it('sequence guard — a legacy-book read that started before the first op is dropped when it lands after it', () => {
      // book open: legacy file, nothing written yet
      let s = reduce(init(), a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0 }), requestSeq: 0 }));
      // a reopen read starts now…
      const requestSeq = s.adoptSeq;
      // …the user's first op lands: the server minted F1 and recorded an entry
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 1, ids: ['recorded'] })));
      // …then the stale null-fileId snapshot from before the op arrives
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0 }), requestSeq }));
      expect(s.fileId).toBe(F1);
      expect(s.pending.map((p) => p.id)).toEqual(['recorded']);
    });
    it('sequence guard — an equal-rev poll landing while a hydrate is in flight does not drop that hydrate', () => {
      // cache at F1 rev 3; a reopen read starts…
      let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['old'] })));
      const requestSeq = s.adoptSeq;
      // …a routine poll at the same version lands first (a no-op adoption)…
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 3, ids: ['old'] })));
      // …then the hydrate lands carrying a re-imported file (fileId:null): it must still adopt
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0, ids: [] }), requestSeq }));
      expect(s.fileId).toBeNull();
      expect(s.pending).toEqual([]);
    });
    it('sequence guard — the other order: a hydrate that lands first, then an equal-rev poll, leaves the hydrated state and adoptSeq alone', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['old'] })));
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: F2, rev: 0, ids: ['fresh'] }), requestSeq: s.adoptSeq }));
      const seqAfterHydrate = s.adoptSeq;
      s = reduce(s, a.applyServerState(st({ fileId: F2, rev: 0, ids: ['fresh'] })));
      expect(s.adoptSeq).toBe(seqAfterHydrate);
      expect(s).toMatchObject({ fileId: F2, rev: 0 });
      expect(s.pending.map((p) => p.id)).toEqual(['fresh']);
      // …so a second hydrate whose read started right after the first landed is not dropped either
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0, ids: [] }), requestSeq: seqAfterHydrate }));
      expect(s.fileId).toBeNull();
    });
    it('sequence guard does not apply across books', () => {
      let s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 1, ids: ['a'] })));
      s = reduce(s, a.hydrate({ bookId: 'B', state: st({ bookId: 'B', fileId: null, rev: 0, ids: ['b'] }), requestSeq: 0 }));
      expect(s.bookId).toBe('B'); expect(s.pending.map((p) => p.id)).toEqual(['b']);
    });
  });

  describe('applyDismiss', () => {
    it('removes the event; a foreign book (no state) leaves rev and dismissed alone', () => {
      let s = reduce(init(), a.applyServerState({ ...st({ fileId: F1, rev: 2 }), dismissed: ['k'] }));
      s = { ...s, drift: [{ id: 'd-foreign', bookId: 'B' } as never, { id: 'd-own', bookId: 'A' } as never] };
      s = reduce(s, a.applyDismiss({ driftId: 'd-foreign' }));
      expect(s.drift.map((d) => d.id)).toEqual(['d-own']);
      expect(s.rev).toBe(2); expect(s.dismissed).toEqual(['k']);
      s = reduce(s, a.applyDismiss({ driftId: 'd-own', state: { ...st({ fileId: F1, rev: 3 }), dismissed: ['k', 'd-own'] } }));
      expect(s.drift).toEqual([]); expect(s.dismissed).toEqual(['k', 'd-own']); expect(s.rev).toBe(3);
    });
  });

  describe('forgetBook', () => {
    it('resets only when it holds that book', () => {
      let s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 2, ids: ['x'] })));
      s = reduce(s, a.forgetBook('B'));
      expect(s.bookId).toBe('A');
      s = reduce(s, a.forgetBook('A'));
      expect(s).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] });
    });
  });

  describe('selectors', () => {
    it('return empty for a non-active book or no active book', () => {
      const revisions = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 1, ids: ['x'] })));
      expect(selectActivePending({ revisions, ui: { stage: { kind: 'ready', bookId: 'A' } } })).toHaveLength(1);
      expect(selectActivePending({ revisions, ui: { stage: { kind: 'ready', bookId: 'B' } } })).toEqual([]);
      expect(selectActivePending({ revisions, ui: { stage: { kind: 'books' } } })).toEqual([]);
    });
  });

  describe('bookScopeChanged (transitional, deleted in Task 26)', () => {
    it('resets fileId and rev', () => {
      let s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 2 })));
      s = reduce(s, a.bookScopeChanged('B'));
      expect(s.fileId).toBeNull(); expect(s.rev).toBe(0);
    });
  });
  ```
  Run: `npm --prefix <wt> run test -- src/store/revisions-slice.cache.test.ts --retry=0` → FAIL (exports missing).

- [ ] **Step 2: Implement** in `revisions-slice.ts`:
  - Fields + initial values; doc comments ("Plan 286 — the server file identity/version this cache last adopted"; "`adoptSeq` — increments on every adoption that changes `(bookId, fileId, rev)`; a hydrate whose read started before the latest such adoption (`requestSeq < adoptSeq`) is stale and dropped").
  - Import `RevisionsState as WireRevisionsState` from `../lib/types`.
  - Helpers above the slice:
    ```ts
    /** Plan 286 — null (a legacy file never written through the store) is
        older than any id; ids are `${epoch 15-padded}-${random}`, so string
        order is epoch order with the suffix breaking a same-ms tie. */
    export function compareFileIds(a: string | null, b: string | null): number {
      if (a === b) return 0;
      if (a === null) return -1;
      if (b === null) return 1;
      return a < b ? -1 : 1;
    }
    type IncomingRevisions = Partial<WireRevisionsState> & { bookId: string };
    function adopt(s: RevisionsState, p: IncomingRevisions): void {
      /* Only a version change counts for the sequence guard: an equal-version
         poll must not make an in-flight hydrate look stale. */
      const changed = s.bookId !== p.bookId || s.fileId !== (p.fileId ?? null) || s.rev !== (p.rev ?? 0);
      s.bookId = p.bookId;
      s.fileId = p.fileId ?? null;
      s.rev = p.rev ?? 0;
      s.pending = p.pending ?? [];
      s.dismissed = p.dismissed ?? [];
      s.acceptedSelections = p.acceptedSelections ?? {};
      s.timeline = normaliseTimelineKeys(p.timeline);
      if (changed) s.adoptSeq += 1;
    }
    /** Plan 286 — the cache rule for polls and op responses (spec §4). */
    function shouldAdoptOrdered(s: RevisionsState, p: IncomingRevisions): boolean {
      if (s.bookId !== p.bookId) return true;
      const c = compareFileIds(p.fileId ?? null, s.fileId);
      if (c !== 0) return c > 0;
      return (p.rev ?? 0) >= s.rev;
    }
    ```
  - Reducers:
    ```ts
    /** Plan 286 — book open / reopen hydrate from GET /state. ANY fileId
        difference adopts (null included: a book deleted and re-imported under
        its deterministic id reads fileId:null) — except a read that started
        before the latest op/poll adoption (sequence guard). */
    hydrate: (s, a: PayloadAction<{ bookId: string; state: Partial<WireRevisionsState> | null; requestSeq?: number }>) => {
      const { bookId, requestSeq } = a.payload;
      s.loaded = true;
      /* Transitional (Task 26 deletes the field): keeps the old persistence gate open. */
      s.hydratedFor = bookId;
      if (bookId === s.bookId && requestSeq !== undefined && requestSeq < s.adoptSeq) return;
      const p: IncomingRevisions = { ...(a.payload.state ?? {}), bookId };
      const differs = s.bookId !== bookId || (p.fileId ?? null) !== s.fileId;
      if (differs || (p.rev ?? 0) >= s.rev) adopt(s, p);
    },
    applyServerState: (s, a: PayloadAction<WireRevisionsState>) => {
      if (shouldAdoptOrdered(s, a.payload)) adopt(s, a.payload);
    },
    applyDismiss: (s, a: PayloadAction<{ driftId: string; state?: WireRevisionsState }>) => {
      s.drift = s.drift.filter((d) => d.id !== a.payload.driftId);
      if (a.payload.state && shouldAdoptOrdered(s, a.payload.state)) adopt(s, a.payload.state);
    },
    forgetBook: (s, a: PayloadAction<string>) => {
      if (s.bookId !== a.payload) return;
      s.bookId = null; s.fileId = null; s.rev = 0;
      s.pending = []; s.dismissed = []; s.acceptedSelections = {}; s.timeline = {};
    },
    ```
  - Selectors after `revisionsActions`:
    ```ts
    type ActiveRoot = { revisions: RevisionsState; ui: { stage: unknown } };
    const EMPTY_PENDING: Revision[] = [];
    const EMPTY_TIMELINE: Record<number, TimelineEntry[]> = {};
    const EMPTY_SELECTIONS: Record<string, Record<number, 'A' | 'B'>> = {};
    const holdsActive = (s: ActiveRoot): boolean => {
      const active = (s.ui.stage as { bookId?: string } | undefined)?.bookId ?? null;
      return s.revisions.bookId !== null && s.revisions.bookId === active;
    };
    /** Plan 286 — read the cache only for the active book (spec §4). */
    export const selectActivePending = (s: ActiveRoot): Revision[] => (holdsActive(s) ? s.revisions.pending : EMPTY_PENDING);
    export const selectActiveTimeline = (s: ActiveRoot) => (holdsActive(s) ? s.revisions.timeline : EMPTY_TIMELINE);
    export const selectActiveAcceptedSelections = (s: ActiveRoot) => (holdsActive(s) ? s.revisions.acceptedSelections : EMPTY_SELECTIONS);
    ```
  - `bookScopeChanged`: add `s.fileId = null; s.rev = 0;`.

- [ ] **Step 3: Green.** The new file, `revisions-slice.test.ts` (add `fileId: null, rev: 0, adoptSeq: 0` to the initial-state expectation), `typecheck` — any test that hand-builds a full `RevisionsState` needs `fileId: null, rev: 0, adoptSeq: 0`: at least `src/components/revision-timeline-modal.test.tsx`'s `makeStore` `preloadedState` (Task 22 later replaces that helper); `splice-runner-middleware.test.ts` spreads `getInitialState()` and is fine. Fix every one `typecheck` lists.

- [ ] **Step 4: Mutations.**
  1. In `compareFileIds`, swap the two `null` branches → red: `null is older than any id…`.
  2. In `shouldAdoptOrdered`, change `>=` to `>` → red: `ignores a lower rev…; adopts an equal or higher rev`.
  3. In `hydrate`, drop the `|| (p.fileId ?? null) !== s.fileId` clause → red: `adopts a different fileId even when it is null`.
  4. Delete the sequence-guard `return` line → red: `sequence guard — a legacy-book read … is dropped…`.
  5. Remove `if (changed) s.adoptSeq += 1;` from `adopt` → red: `a changing adoption increments adoptSeq…` and `sequence guard — a legacy-book read … is dropped…`.
  6. Bump unconditionally (`s.adoptSeq += 1;`, ignoring `changed`) → red: `a changing adoption increments adoptSeq…` (the equal-version step), `an equal-rev poll landing while a hydrate is in flight…` (the hydrate is dropped, `fileId` stays `F1`), and `the other order…`.

- [ ] **Step 5: Commit.** `feat(frontend): add the ordered revisions cache with a hydrate sequence guard (#3400)`.

---

### Task 13: UI slice — `openRevision`, `revisionOpInFlight`, `PreviewRegenCtx.bookId`/`stub`; `previewChapterComplete`

**Character:** mechanical.

**Files:**
- Modify: `src/store/ui-slice.ts`; `src/components/layout.tsx` (the `uiActions.setPreviewRegen({ characterId, previewChapterId, … })` call in the regenerate-character `onConfirm`, `~:2067`, gains `bookId`).
- Modify: `src/store/chapters-slice.ts` (export `previewChapterComplete`).
- Tests: `src/store/ui-slice.test.ts`, `src/store/persist-config.test.ts` (or wherever `UI_PERSIST_WHITELIST` is asserted), every test building a `PreviewRegenCtx` (`grep -rln "previewChapterId:" src e2e` → `generation-stream-middleware.test.ts` at least), and every test that hand-builds a **full `UiState`** — `src/components/theme-toggle.test.tsx` (`uiPreloaded: UiState`, `~:26`), `src/lib/use-theme.test.tsx` (`~:36`), `src/store/ui-slice.test.ts` (`baseState`, `~:10`): the two new required fields break their `typecheck` here, so each gains `openRevision: null, revisionOpInFlight: false` in this task (their `showRevisionPlayer: false` line stays until Task 23).

**Interfaces:**
- Produces:
  ```ts
  export type OpenRevision = { kind: 'server'; revisionId: string; chapterId: number } | { kind: 'preview-stub' };
  // UiState
  openRevision: OpenRevision | null;   // initial null; transient
  revisionOpInFlight: boolean;         // initial false
  // PreviewRegenCtx
  bookId: string;
  stub?: Revision;
  /** OD27/OD28 — set on EVERY completion of this preview's chapter (on its
      book or elsewhere), so a finished preview whose player was closed, never
      opened, or failed to build stays re-openable: arriving at `bookId` re-runs
      the open path (Task 24). `reviewOutcome` is finalize's answer (Task 7):
      'none' and 'failed' open a stub, and 'recorded' opens the server entry or
      is dropped as resolved elsewhere when it is gone (OD29). `stubFallback`
      (OD23) says whether a 'recorded' completion whose refetch failed twice
      may still open a stub: true only when the completion was seen on its own
      book; false when it finished elsewhere, or once a server entry for the
      chapter has been seen (Task 21). */
  completed?: { reviewOutcome?: ReviewOutcome; stubFallback: boolean };
  // actions
  setOpenRevision(payload: OpenRevision | null); setRevisionOpInFlight(payload: boolean);
  /** OD30 (pass 4) — set the preview's stub AND open it, in ONE action. Two
      separate dispatches (setPreviewRegen with the stub, then setOpenRevision)
      let the player watcher (Task 21) run between them: with a cached entry for
      the chapter, rule 1 drops the stub while no player is open, then rule 2
      hides the stub player the second dispatch opens — nothing opens, no toast.
      In one action the watcher sees the stub player already open, so rule 1
      switches it to the cached entry (OD30). No-op without a preview. */
  openPreviewStub(payload: Revision);
  //   reducer: (s, a) => { if (!s.previewRegen) return; s.previewRegen.stub = a.payload; s.openRevision = { kind: 'preview-stub' }; }
  // selector (OD28, pass 3 #1) — the stub, only while its book is the active one
  export const selectActivePreviewStub = (s: { ui: UiState }): Revision | undefined => {
    const pv = s.ui.previewRegen;
    const active = (s.ui.stage as { bookId?: string } | undefined)?.bookId ?? null;
    return pv?.stub && pv.bookId === active ? pv.stub : undefined;
  };
  ```
- Produces (`chapters-slice.ts`): `export const previewChapterComplete = createAction<{ bookId: string; chapterId: number; reviewOutcome?: ReviewOutcome }>('chapters/previewChapterComplete');` (no reducer, OD21). `ReviewOutcome` is `components['schemas']['ReviewOutcome']` from `src/lib/api-types.ts` (Task 7).
- `showRevisionPlayer` stays until Task 23 (Task 22 stops using it; Task 23 deletes it).

- [ ] **Step 1: Failing tests.** `ui-slice.test.ts`:
  ```ts
  it('plan 286 — openRevision and revisionOpInFlight round-trip and start empty', () => {
    let s = uiSlice.reducer(undefined, { type: '@@init' });
    expect(s.openRevision).toBeNull();
    expect(s.revisionOpInFlight).toBe(false);
    s = uiSlice.reducer(s, uiActions.setOpenRevision({ kind: 'server', revisionId: 'r', chapterId: 3 }));
    s = uiSlice.reducer(s, uiActions.setRevisionOpInFlight(true));
    expect(s.openRevision).toEqual({ kind: 'server', revisionId: 'r', chapterId: 3 });
    expect(s.revisionOpInFlight).toBe(true);
  });
  it('plan 286 — previewRegen carries its bookId and an optional stub', () => {
    const s = uiSlice.reducer(undefined, uiActions.setPreviewRegen({ bookId: 'b', characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '', stub: { id: 'revision:1:c', chapterId: 1, characterId: 'c', segments: [] } }));
    expect(s.previewRegen?.bookId).toBe('b');
    expect(s.previewRegen?.stub?.id).toBe('revision:1:c');
  });
  it('plan 286 (OD28) — selectActivePreviewStub returns the stub only on its own book', () => {
    const stub = { id: 'revision:1:c', chapterId: 1, characterId: 'c', segments: [] };
    let s = uiSlice.reducer(undefined, uiActions.openBook({ id: 'b', status: 'complete' } as never));
    s = uiSlice.reducer(s, uiActions.setPreviewRegen({ bookId: 'b', characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '', stub }));
    expect(selectActivePreviewStub({ ui: s })).toEqual(stub);
    s = uiSlice.reducer(s, uiActions.openBook({ id: 'other', status: 'complete' } as never));
    expect(selectActivePreviewStub({ ui: s })).toBeUndefined();
    expect(s.previewRegen?.stub).toEqual(stub); // hidden, never cleared
  });
  it('plan 286 (OD30) — openPreviewStub sets the stub and opens it in one action; a no-op without a preview', () => {
    const stub = { id: 'revision:1:c', chapterId: 1, characterId: 'c', segments: [] };
    let s = uiSlice.reducer(undefined, uiActions.openPreviewStub(stub));
    expect(s.previewRegen).toBeNull();
    expect(s.openRevision).toBeNull();
    s = uiSlice.reducer(s, uiActions.setPreviewRegen({ bookId: 'b', characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '' }));
    s = uiSlice.reducer(s, uiActions.openPreviewStub(stub));
    expect(s.previewRegen?.stub).toEqual(stub);
    expect(s.openRevision).toEqual({ kind: 'preview-stub' });
  });
  ```
  (Import `selectActivePreviewStub` beside `uiSlice`/`uiActions`. Neither `openBook` (`ui-slice.ts ~:255`) nor `goHome` (`~:181`) touches `previewRegen`, so navigation keeps the preview, as OD28 needs.)
  In the file that asserts `UI_PERSIST_WHITELIST` (`grep -rln UI_PERSIST_WHITELIST src`):
  ```ts
  it('plan 286 — openRevision and revisionOpInFlight are not persisted', () => {
    expect(UI_PERSIST_WHITELIST).not.toContain('openRevision');
    expect(UI_PERSIST_WHITELIST).not.toContain('revisionOpInFlight');
  });
  ```
  Run → FAIL (actions missing; the whitelist test passes already — it is a regression guard, see mutation 1).

- [ ] **Step 2: Implement** per Interfaces. Fix every `PreviewRegenCtx` literal `typecheck` flags (add `bookId`), and every hand-built `UiState` it flags (add `openRevision: null, revisionOpInFlight: false`).
- [ ] **Step 3: Green.** ui-slice + whitelist tests, `generation-stream-middleware.test.ts`, `layout.test.tsx`, `src/components/theme-toggle.test.tsx`, `src/lib/use-theme.test.tsx`, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Add `'openRevision'` to `UI_PERSIST_WHITELIST` → red: `openRevision and revisionOpInFlight are not persisted`.
  2. Initialise `revisionOpInFlight: true` → red: `…round-trip and start empty`.
  3. Drop `&& pv.bookId === active` from `selectActivePreviewStub` → red: `selectActivePreviewStub returns the stub only on its own book` (the second expectation gets the stub).
  4. In `openPreviewStub`, drop `s.openRevision = { kind: 'preview-stub' };` → red: `openPreviewStub sets the stub and opens it in one action…` (`openRevision` stays `null`).
  5. In `openPreviewStub`, drop the `if (!s.previewRegen) return;` guard → red: the same test, at its first dispatch (`TypeError` setting `stub` on `null`).
- [ ] **Step 5: Commit.** `feat(frontend): add openRevision, op-in-flight and preview bookId to the ui slice (#3400)`.

---

### Task 14: Revisions thunks — confirm, then apply

**Character:** judgment.

**Files:**
- Create: `src/store/revisions-thunks.ts`.
- Test: create `src/store/revisions-thunks.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type RevisionOpOutcome = { ok: true } | { ok: false; code: RevisionOpCode | 'network' };
  export const REVISION_COPY: { gone; busy; noPrevious; liveMissing; restoreFailed; unexpected; hasRevision }; // the Global Constraints strings
  export function refetchActiveRevisions(bookId: string): (d, g) => Promise<'ok' | 'failed' | 'skipped'>;
  export function acceptRevisionOp(args: { bookId: string; revisionId: string; chapterId: number; selection?: Record<number, 'A' | 'B'> }): (d, g) => Promise<RevisionOpOutcome>;
  export function rejectRevisionOp(args: { bookId: string; revisionId: string; chapterId: number }): (d, g) => Promise<RevisionOpOutcome>;
  export function dismissDriftOp(driftId: string): (d, g) => Promise<void>;
  ```
  `chapterId` is the entry's chapter, used only to decide whether a preview is tied to it (finding 7 / OD10); it is not sent.
- Behaviour:
  - Every op sets `ui.revisionOpInFlight` for its duration (cleared in `finally`).
  - Success: `applyServerState(state)` only if the active book (at dispatch time) is `bookId`; then `setOpenRevision(null)`. No toast.
  - `revision_not_found` / `revision_gone`: apply the body's `state` if present and active, else `refetchActiveRevisions(bookId)`; `setOpenRevision(null)`; clear `previewRegen` **only if** `previewRegen.bookId === bookId && previewRegen.previewChapterId === chapterId`; one warn toast (dedupe `revision-op-gone`).
  - `chapter_busy` / `no_previous_audio`: warn toast; apply `state` if present+active; player stays open.
  - `live_audio_missing`: error toast; apply `state`; player stays open.
  - `restore_failed`: error toast; refetch; player stays open.
  - Anything else (incl. a network error → `'network'`): error toast `Couldn't update the revision — try again` (fixed; never the error's own message — invariant 8); cache unchanged.
  - `refetchActiveRevisions`: `'skipped'` if not active; else `api.pollRevisions({ bookId })` → if still active `applyPoll({ ...res, bookId })` → `'ok'`; a throw → `'failed'`.
  - `dismissDriftOp(driftId)`: book = the drift event's `bookId`, else the active book; none → return. On success `applyDismiss({ driftId, state: active === book ? state : undefined })`. On failure error toast `Couldn't dismiss the drift event — try again` (dedupe `drift-dismiss-failed`); the event stays (OD19).

- [ ] **Step 1: Failing tests** — `src/store/revisions-thunks.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { configureStore } from '@reduxjs/toolkit';

  const { apiMock } = vi.hoisted(() => ({
    apiMock: { acceptRevision: vi.fn(), rejectRevision: vi.fn(), dismissDrift: vi.fn(), pollRevisions: vi.fn() },
  }));
  vi.mock('../lib/api', () => ({ api: apiMock }));

  import { uiSlice, uiActions } from './ui-slice';
  import { revisionsSlice, revisionsActions } from './revisions-slice';
  import { notificationsSlice } from './notifications-slice';
  import { RevisionOpFailure } from '../lib/revision-op-failure';
  import { acceptRevisionOp, rejectRevisionOp, dismissDriftOp, refetchActiveRevisions } from './revisions-thunks';

  const F = '000000000000001-a';
  const S = (bookId: string, rev: number, ids: string[] = [], fileId = F) => ({ bookId, fileId, rev, pending: ids.map((id) => ({ id, chapterId: 3, characterId: 'c', segments: [] })), dismissed: [], acceptedSelections: {}, timeline: {} });
  const PREVIEW = (chapter: number) => ({ bookId: 'A', characterId: 'c', previewChapterId: chapter, remainingChapterIds: [4], reason: '', note: '' });
  function makeStore(activeBook = 'A') {
    const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer, notifications: notificationsSlice.reducer } });
    store.dispatch(uiActions.openBook({ id: activeBook, status: 'complete' } as never));
    store.dispatch(revisionsActions.applyServerState(S(activeBook, 1, ['r1'])));
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
    return store;
  }
  const toasts = (s: ReturnType<typeof makeStore>) => s.getState().notifications.toasts.map((t) => t.message);
  beforeEach(() => { for (const f of Object.values(apiMock)) f.mockReset(); });

  describe('revisions thunks (plan 286)', () => {
    it('success applies the returned state, closes the player, no toast, in-flight cleared', async () => {
      apiMock.acceptRevision.mockResolvedValueOnce(S('A', 2));
      const store = makeStore();
      const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(out).toEqual({ ok: true });
      expect(store.getState().revisions.pending).toEqual([]);
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.revisionOpInFlight).toBe(false);
      expect(toasts(store)).toEqual([]);
    });
    it('sets revisionOpInFlight while the op runs', async () => {
      let release!: (v: unknown) => void;
      apiMock.rejectRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
      const store = makeStore();
      const p = store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(store.getState().ui.revisionOpInFlight).toBe(true);
      release(S('A', 2)); await p;
      expect(store.getState().ui.revisionOpInFlight).toBe(false);
    });
    it('a response for a book the user has left is not applied', async () => {
      let release!: (v: unknown) => void;
      apiMock.acceptRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
      const store = makeStore('A');
      const p = store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
      release(S('A', 2)); await p;
      expect(store.getState().revisions.rev).toBe(1);
    });
    it('revision_gone with a preview on THAT chapter: applies state, closes, clears the preview, one toast', async () => {
      apiMock.acceptRevision.mockRejectedValueOnce(new RevisionOpFailure('gone', 409, 'revision_gone', S('A', 3)));
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen(PREVIEW(3)));
      const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(out).toEqual({ ok: false, code: 'revision_gone' });
      expect(store.getState().revisions.rev).toBe(3);
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.previewRegen).toBeNull();
      expect(toasts(store)).toEqual(['This take was replaced by a newer render']);
    });
    it('revision_gone leaves an UNRELATED preview (another chapter) alone', async () => {
      apiMock.acceptRevision.mockRejectedValueOnce(new RevisionOpFailure('gone', 409, 'revision_gone', S('A', 3)));
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen(PREVIEW(7)));
      await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(store.getState().ui.previewRegen?.previewChapterId).toBe(7);
    });
    it('revision_not_found without a state refetches the active book', async () => {
      apiMock.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('nf', 404, 'revision_not_found'));
      apiMock.pollRevisions.mockResolvedValueOnce({ ...S('A', 4), drift: [] });
      const store = makeStore();
      await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(apiMock.pollRevisions).toHaveBeenCalledWith({ bookId: 'A' });
      /* Task 19 adds: expect(store.getState().revisions.rev).toBe(4) — applyPoll
         only adopts server state from Task 19 on. */
    });
    it.each([
      ['chapter_busy', 'This chapter is busy — try again when it finishes'],
      ['no_previous_audio', 'Original audio not preserved'],
      ['live_audio_missing', "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it"],
    ])('%s keeps the player open with its toast and clears in-flight', async (code, msg) => {
      apiMock.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('x', 409, code as never, S('A', 1, ['r1'])));
      const store = makeStore();
      await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(store.getState().ui.openRevision).not.toBeNull();
      expect(store.getState().ui.revisionOpInFlight).toBe(false);
      expect(toasts(store)).toEqual([msg]);
    });
    it('restore_failed toasts, refetches and keeps the entry', async () => {
      apiMock.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('x', 500, 'restore_failed'));
      apiMock.pollRevisions.mockResolvedValueOnce({ ...S('A', 1, ['r1']), drift: [] });
      const store = makeStore();
      await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(toasts(store)).toEqual(["Couldn't restore the earlier take — try Reject again"]);
      expect(apiMock.pollRevisions).toHaveBeenCalledWith({ bookId: 'A' });
      expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['r1']);
    });
    it('an unexpected failure shows a fixed sentence (never the error text) and leaves the cache alone', async () => {
      apiMock.acceptRevision.mockRejectedValueOnce(new Error("EPERM: operation not permitted, unlink 'C:\\SECRET\\a.mp3'"));
      const store = makeStore();
      const before = store.getState().revisions;
      const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
      expect(out).toEqual({ ok: false, code: 'network' });
      expect(store.getState().revisions).toBe(before);
      expect(toasts(store)).toEqual(["Couldn't update the revision — try again"]);
    });
    it('a legacy id (revision:<ch>:<char>) is sent as-is to the server op', async () => {
      apiMock.acceptRevision.mockResolvedValueOnce(S('A', 2));
      const store = makeStore();
      await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'revision:3:eliza', chapterId: 3 }));
      expect(apiMock.acceptRevision).toHaveBeenCalledWith({ bookId: 'A', revisionId: 'revision:3:eliza' });
    });
    it("dismissDriftOp posts to the event's own book; a foreign dismiss leaves the active rev alone", async () => {
      const store = makeStore('A');
      store.dispatch(revisionsActions.applyBackgroundPoll({ bookId: 'B', drift: [{ id: 'dB', bookId: 'B' } as never] }));
      apiMock.dismissDrift.mockResolvedValueOnce(S('B', 7, [], '000000000000009-z'));
      await store.dispatch(dismissDriftOp('dB'));
      expect(apiMock.dismissDrift).toHaveBeenCalledWith({ bookId: 'B', driftId: 'dB' });
      expect(store.getState().revisions.drift).toEqual([]);
      expect(store.getState().revisions.rev).toBe(1);
    });
    it('dismissDriftOp failure keeps the event and toasts', async () => {
      const store = makeStore('A');
      store.dispatch(revisionsActions.applyBackgroundPoll({ bookId: 'A', drift: [{ id: 'dA', bookId: 'A' } as never] }));
      apiMock.dismissDrift.mockRejectedValueOnce(new Error('x'));
      await store.dispatch(dismissDriftOp('dA'));
      expect(store.getState().revisions.drift.map((d) => d.id)).toEqual(['dA']);
      expect(toasts(store)).toEqual(["Couldn't dismiss the drift event — try again"]);
    });
    it('refetchActiveRevisions skips a non-active book and reports a failure', async () => {
      const store = makeStore('A');
      expect(await store.dispatch(refetchActiveRevisions('B'))).toBe('skipped');
      expect(apiMock.pollRevisions).not.toHaveBeenCalled();
      apiMock.pollRevisions.mockRejectedValueOnce(new Error('x'));
      expect(await store.dispatch(refetchActiveRevisions('A'))).toBe('failed');
    });
  });
  ```
  (`uiActions.openBook` takes `{ id, status, manuscriptId? }`; `status: 'complete'` gives a `ready` stage with that `bookId`.)

  Run → FAIL (module missing).

- [ ] **Step 2: Implement** `src/store/revisions-thunks.ts`:
  ```ts
  /* Plan 286 (#3400) — revisions operations: confirm with the server, then
     apply its state. The client never writes revisions.json. */
  import type { AppDispatch, RootState } from './index';
  import { api } from '../lib/api';
  import { RevisionOpFailure, type RevisionOpCode } from '../lib/revision-op-failure';
  import type { RevisionsState } from '../lib/types';
  import { revisionsActions } from './revisions-slice';
  import { uiActions } from './ui-slice';
  import { notificationsActions } from './notifications-slice';

  export type RevisionOpOutcome = { ok: true } | { ok: false; code: RevisionOpCode | 'network' };

  export const REVISION_COPY = {
    gone: 'This take was replaced by a newer render',
    busy: 'This chapter is busy — try again when it finishes',
    noPrevious: 'Original audio not preserved',
    liveMissing: "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it",
    restoreFailed: "Couldn't restore the earlier take — try Reject again",
    unexpected: "Couldn't update the revision — try again",
    hasRevision: "This chapter has an older pending review — resolve it from the chapter's review first",
  } as const;

  /* Typed against the one slice it reads, not RootState (pass 4 #7): the
     generation middleware calls it with its own StreamableRootState
     (generation-stream-middleware.ts ~:44-55), which is not a RootState. Same
     shape as the revisions selectors' ActiveRoot (Task 12). */
  export const activeBookId = (s: { ui: { stage: unknown } }): string | null => (s.ui.stage as { bookId?: string }).bookId ?? null;

  export function refetchActiveRevisions(bookId: string) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<'ok' | 'failed' | 'skipped'> => {
      if (activeBookId(getState()) !== bookId) return 'skipped';
      try {
        const res = await api.pollRevisions({ bookId });
        if (activeBookId(getState()) === bookId) dispatch(revisionsActions.applyPoll({ ...res, bookId }));
        return 'ok';
      } catch {
        return 'failed';
      }
    };
  }

  function runOp(bookId: string, chapterId: number, call: () => Promise<RevisionsState>) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<RevisionOpOutcome> => {
      const applyIfActive = (state: RevisionsState | undefined): boolean => {
        if (!state || activeBookId(getState()) !== bookId) return false;
        dispatch(revisionsActions.applyServerState(state));
        return true;
      };
      const toast = (kind: 'warn' | 'error', message: string, key: string) =>
        dispatch(notificationsActions.pushToast({ kind, message, dedupeKey: `revision-op-${key}` }));
      dispatch(uiActions.setRevisionOpInFlight(true));
      try {
        applyIfActive(await call());
        dispatch(uiActions.setOpenRevision(null));
        return { ok: true };
      } catch (err) {
        const f = err instanceof RevisionOpFailure ? err : null;
        const code: RevisionOpCode | 'network' = f ? f.code : 'network';
        switch (code) {
          case 'revision_not_found':
          case 'revision_gone': {
            if (!applyIfActive(f?.state)) void dispatch(refetchActiveRevisions(bookId));
            dispatch(uiActions.setOpenRevision(null));
            const preview = getState().ui.previewRegen;
            if (preview && preview.bookId === bookId && preview.previewChapterId === chapterId) {
              dispatch(uiActions.setPreviewRegen(null));
            }
            toast('warn', REVISION_COPY.gone, 'gone');
            break;
          }
          case 'chapter_busy':
            applyIfActive(f?.state);
            toast('warn', REVISION_COPY.busy, code);
            break;
          case 'no_previous_audio':
            applyIfActive(f?.state);
            toast('warn', REVISION_COPY.noPrevious, code);
            break;
          case 'live_audio_missing':
            applyIfActive(f?.state);
            toast('error', REVISION_COPY.liveMissing, code);
            break;
          case 'restore_failed':
            void dispatch(refetchActiveRevisions(bookId));
            toast('error', REVISION_COPY.restoreFailed, code);
            break;
          default:
            console.error('[revisions] op failed', err);
            toast('error', REVISION_COPY.unexpected, 'unexpected');
        }
        return { ok: false, code };
      } finally {
        dispatch(uiActions.setRevisionOpInFlight(false));
      }
    };
  }

  export function acceptRevisionOp({ bookId, revisionId, chapterId, selection }: { bookId: string; revisionId: string; chapterId: number; selection?: Record<number, 'A' | 'B'> }) {
    return runOp(bookId, chapterId, () => api.acceptRevision(selection ? { bookId, revisionId, selection } : { bookId, revisionId }));
  }

  export function rejectRevisionOp({ bookId, revisionId, chapterId }: { bookId: string; revisionId: string; chapterId: number }) {
    return runOp(bookId, chapterId, () => api.rejectRevision({ bookId, revisionId }));
  }

  export function dismissDriftOp(driftId: string) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
      const s = getState();
      const bookId = s.revisions.drift.find((d) => d.id === driftId)?.bookId ?? activeBookId(s);
      if (!bookId) return;
      try {
        const state = await api.dismissDrift({ bookId, driftId });
        dispatch(revisionsActions.applyDismiss({ driftId, state: activeBookId(getState()) === bookId ? state : undefined }));
      } catch (err) {
        console.error('[revisions] dismiss failed', err);
        dispatch(notificationsActions.pushToast({ kind: 'error', message: "Couldn't dismiss the drift event — try again", dedupeKey: 'drift-dismiss-failed' }));
      }
    };
  }
  ```
  `applyPoll`'s current payload type (`(RevisionsResponse & { bookId?: string }) | undefined`) accepts `{ ...res, bookId }`.

- [ ] **Step 3: Green.** The test file, `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Remove `if (!state || activeBookId(getState()) !== bookId) return false;`'s active-book half → red: `a response for a book the user has left is not applied`.
  2. Drop the `preview.previewChapterId === chapterId` condition → red: `revision_gone leaves an UNRELATED preview … alone`.
  3. Remove the `setPreviewRegen(null)` line → red: `revision_gone with a preview on THAT chapter…`.
  4. Move `setRevisionOpInFlight(false)` out of `finally` into the success path → red: the `it.each` rows (`in-flight` stays `true`).
  5. Use `(err as Error).message` in the default toast → red: `an unexpected failure shows a fixed sentence…`.

- [ ] **Step 5: Commit.** `feat(frontend): add confirm-then-apply revisions thunks (#3400)`.

---

### Task 15: Preview thunks — start, approve side effects, unrecorded reject

**Character:** judgment.

**Files:**
- Create: `src/store/preview-thunks.ts`.
- Test: create `src/store/preview-thunks.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export function startPreviewRegen(args: { bookId: string; characterId: string; characterName: string; chapterIds: number[]; reason: string; note: string }): (d, g) => Promise<void>;
  export function approvePreviewSideEffects(preview: PreviewRegenCtx): (d, g) => Promise<void>;
  export function restoreUnrecordedPreview(preview: PreviewRegenCtx): (d, g) => Promise<void>;
  ```
  - `startPreviewRegen` is today's inline preview branch of layout's regenerate-character `onConfirm` (`layout.tsx ~:2057-2083`), moved: `setPreviewRegen({ bookId, characterId, previewChapterId, remainingChapterIds, reason, note })`, then `enqueueQueueEntries([{ id: \`regen-preview-${bookId}-${characterId}-${previewChapterId}-${rand}\`, bookId, chapterId: previewChapterId, scope: 'this', review: { characterId, triggeredBy: \`${characterName} voice change\` } }])` (OD14). Layout switches to it in Task 22.
  - `approvePreviewSideEffects(preview)`: `setPreviewRegen(null)`; append `buildCharacterRegenEvent({ character, chapterIds: [preview.previewChapterId, ...preview.remainingChapterIds], reason, note })` (character from `cast.characters`; skip the event if absent, as today); if `remainingChapterIds.length > 0`, `enqueueQueueEntries(...)` with ids `regen-rest-${preview.bookId}-…` and `bookId: preview.bookId`, then `changeView('generate')` **only if** the active book is `preview.bookId`. (Today's inline block `layout.tsx ~:2505-2534`, with `bookId` → `preview.bookId`.)
  - `restoreUnrecordedPreview(preview)`: `!preview.stub?.hasPreviousAudio` → `setPreviewRegen(null)` + `setOpenRevision(null)`, no request. Else set in-flight, `api.restorePreviousUnrecorded({ bookId: preview.bookId, chapterId: preview.previewChapterId })`: resolved (`'restored'` or `'none'`) → close both; `has_revision` → warn toast (has revision copy), keep open; `chapter_busy` → warn toast busy, keep open; anything else → error toast restore-failed, keep open. In-flight cleared in `finally`.

- [ ] **Step 1: Failing tests** — `src/store/preview-thunks.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import { configureStore } from '@reduxjs/toolkit';

  const { apiMock } = vi.hoisted(() => ({ apiMock: { restorePreviousUnrecorded: vi.fn() } }));
  vi.mock('../lib/api', () => ({ api: apiMock }));

  import { uiSlice, uiActions, type PreviewRegenCtx } from './ui-slice';
  import { castSlice } from './cast-slice';
  import { changeLogSlice } from './change-log-slice';
  import { queueSlice } from './queue-slice';
  import { analysisSlice } from './analysis-slice';
  import { chaptersSlice } from './chapters-slice';
  import { notificationsSlice } from './notifications-slice';
  import { RevisionOpFailure } from '../lib/revision-op-failure';
  import { startPreviewRegen, approvePreviewSideEffects, restoreUnrecordedPreview } from './preview-thunks';

  let fetchMock: ReturnType<typeof vi.fn>;
  const enqueueBodies = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/queue/enqueue')).map((c) => JSON.parse(c[1].body).entries);
  beforeEach(() => {
    apiMock.restorePreviousUnrecorded.mockReset();
    fetchMock = vi.fn(async (_u: string, init?: { body?: string }) => ({ ok: true, status: 200, json: async () => ({ entries: init?.body ? JSON.parse(init.body).entries : [], paused: false }) }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function makeStore(active = 'A') {
    const store = configureStore({ reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, changeLog: changeLogSlice.reducer, queue: queueSlice.reducer, analysis: analysisSlice.reducer, chapters: chaptersSlice.reducer, notifications: notificationsSlice.reducer } });
    store.dispatch(uiActions.openBook({ id: active, status: 'complete' } as never));
    store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'eliza', name: 'Eliza Carrick', role: '', color: 'narrator' } as never]));
    return store;
  }
  const PREVIEW = (over: Partial<PreviewRegenCtx> = {}): PreviewRegenCtx => ({ bookId: 'A', characterId: 'eliza', previewChapterId: 1, remainingChapterIds: [2, 3], reason: 'voice', note: '', ...over });
  const stub = (hasPreviousAudio: boolean) => ({ id: 'revision:1:eliza', chapterId: 1, characterId: 'eliza', segments: [], playable: true, hasPreviousAudio });
  const toasts = (s: ReturnType<typeof makeStore>) => s.getState().notifications.toasts.map((t) => t.message);

  describe('startPreviewRegen (plan 286)', () => {
    it('stores the preview with its bookId and enqueues the first chapter carrying review', async () => {
      const store = makeStore();
      await store.dispatch(startPreviewRegen({ bookId: 'A', characterId: 'eliza', characterName: 'Eliza Carrick', chapterIds: [1, 2, 3], reason: 'voice', note: '' }));
      expect(store.getState().ui.previewRegen).toMatchObject({ bookId: 'A', previewChapterId: 1, remainingChapterIds: [2, 3] });
      const [entries] = enqueueBodies();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ bookId: 'A', chapterId: 1, review: { characterId: 'eliza', triggeredBy: 'Eliza Carrick voice change' } });
    });
  });

  describe('approvePreviewSideEffects (plan 286)', () => {
    it('clears the preview, logs the regenerate, and fans the rest out under preview.bookId', async () => {
      const store = makeStore('A');
      store.dispatch(uiActions.setPreviewRegen(PREVIEW()));
      await store.dispatch(approvePreviewSideEffects(PREVIEW()));
      expect(store.getState().ui.previewRegen).toBeNull();
      expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(true);
      const [entries] = enqueueBodies();
      expect(entries.map((e: { bookId: string; chapterId: number }) => [e.bookId, e.chapterId])).toEqual([['A', 2], ['A', 3]]);
    });
    it('a preview for another book fans out to THAT book and does not switch the view', async () => {
      const store = makeStore('B');
      const viewBefore = (store.getState().ui.stage as { view?: string }).view;
      await store.dispatch(approvePreviewSideEffects(PREVIEW({ bookId: 'A' })));
      const [entries] = enqueueBodies();
      expect(entries.every((e: { bookId: string }) => e.bookId === 'A')).toBe(true);
      expect((store.getState().ui.stage as { view?: string }).view).toBe(viewBefore);
    });
    it('no remaining chapters → no enqueue', async () => {
      const store = makeStore('A');
      await store.dispatch(approvePreviewSideEffects(PREVIEW({ remainingChapterIds: [] })));
      expect(enqueueBodies()).toEqual([]);
    });
  });

  describe('restoreUnrecordedPreview (plan 286, spec §4 stub table)', () => {
    function open(store: ReturnType<typeof makeStore>, hasPrev: boolean) {
      store.dispatch(uiActions.setPreviewRegen(PREVIEW({ stub: stub(hasPrev) })));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      return store.getState().ui.previewRegen!;
    }
    it('hasPreviousAudio false → drops the preview with no request', async () => {
      const store = makeStore();
      await store.dispatch(restoreUnrecordedPreview(open(store, false)));
      expect(apiMock.restorePreviousUnrecorded).not.toHaveBeenCalled();
      expect(store.getState().ui.previewRegen).toBeNull();
      expect(store.getState().ui.openRevision).toBeNull();
    });
    it.each([['restored'], ['none']])('%s → drops the preview', async (outcome) => {
      apiMock.restorePreviousUnrecorded.mockResolvedValueOnce(outcome);
      const store = makeStore();
      await store.dispatch(restoreUnrecordedPreview(open(store, true)));
      expect(apiMock.restorePreviousUnrecorded).toHaveBeenCalledWith({ bookId: 'A', chapterId: 1 });
      expect(store.getState().ui.previewRegen).toBeNull();
      expect(store.getState().ui.openRevision).toBeNull();
    });
    it.each([
      ['has_revision', 409, "This chapter has an older pending review — resolve it from the chapter's review first"],
      ['chapter_busy', 409, 'This chapter is busy — try again when it finishes'],
      ['restore_failed', 500, "Couldn't restore the earlier take — try Reject again"],
    ])('%s → keeps the preview open with its toast', async (code, status, msg) => {
      apiMock.restorePreviousUnrecorded.mockRejectedValueOnce(new RevisionOpFailure('x', status, code as never));
      const store = makeStore();
      await store.dispatch(restoreUnrecordedPreview(open(store, true)));
      expect(store.getState().ui.previewRegen).not.toBeNull();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
      expect(store.getState().ui.revisionOpInFlight).toBe(false);
      expect(toasts(store)).toEqual([msg]);
    });
  });
  ```
  (Check the names `castSlice.actions.hydrateCharacters`, `changeLog.events`, and that `enqueueQueueEntries`'s analysis gate only needs `analysis`; if `selectAnalysisBusyForBook` reads another slice, add it to `makeStore`.)

  Run → FAIL (module missing).

- [ ] **Step 2: Implement** `src/store/preview-thunks.ts`:
  ```ts
  /* Plan 286 — the profile-regen preview's side effects, as thunks (moved out
     of layout.tsx so they run only after a confirmed accept, under the
     preview's own bookId). */
  import type { AppDispatch, RootState } from './index';
  import { api } from '../lib/api';
  import { RevisionOpFailure } from '../lib/revision-op-failure';
  import { uiActions, type PreviewRegenCtx } from './ui-slice';
  import { changeLogActions } from './change-log-slice';
  import { notificationsActions } from './notifications-slice';
  import { enqueueQueueEntries } from './queue-thunks';
  import { buildCharacterRegenEvent } from '../lib/change-log-events'; // the module layout.tsx imports it from today
  import { REVISION_COPY, activeBookId } from './revisions-thunks';

  const rand = () => Math.random().toString(36).slice(2, 8);

  export function startPreviewRegen(args: { bookId: string; characterId: string; characterName: string; chapterIds: number[]; reason: string; note: string }) {
    return async (dispatch: AppDispatch): Promise<void> => {
      const [previewChapterId, ...remainingChapterIds] = args.chapterIds;
      if (previewChapterId === undefined) return;
      dispatch(uiActions.setPreviewRegen({ bookId: args.bookId, characterId: args.characterId, previewChapterId, remainingChapterIds, reason: args.reason, note: args.note }));
      await dispatch(enqueueQueueEntries([{
        id: `regen-preview-${args.bookId}-${args.characterId}-${previewChapterId}-${rand()}`,
        bookId: args.bookId,
        chapterId: previewChapterId,
        scope: 'this',
        review: { characterId: args.characterId, triggeredBy: `${args.characterName} voice change` },
      }]));
    };
  }

  export function approvePreviewSideEffects(preview: PreviewRegenCtx) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
      dispatch(uiActions.setPreviewRegen(null));
      const character = getState().cast.characters.find((c) => c.id === preview.characterId);
      if (character) {
        dispatch(changeLogActions.appendLogEvent(buildCharacterRegenEvent({
          character, chapterIds: [preview.previewChapterId, ...preview.remainingChapterIds], reason: preview.reason, note: preview.note,
        })));
      }
      if (preview.remainingChapterIds.length === 0) return;
      const r = rand();
      await dispatch(enqueueQueueEntries(preview.remainingChapterIds.map((chId) => ({
        id: `regen-rest-${preview.bookId}-${preview.characterId}-${chId}-${r}`, bookId: preview.bookId, chapterId: chId, scope: 'this' as const,
      }))));
      if (activeBookId(getState()) === preview.bookId) dispatch(uiActions.changeView('generate'));
    };
  }

  export function restoreUnrecordedPreview(preview: PreviewRegenCtx) {
    return async (dispatch: AppDispatch): Promise<void> => {
      const close = () => { dispatch(uiActions.setPreviewRegen(null)); dispatch(uiActions.setOpenRevision(null)); };
      if (!preview.stub?.hasPreviousAudio) return close();
      dispatch(uiActions.setRevisionOpInFlight(true));
      try {
        await api.restorePreviousUnrecorded({ bookId: preview.bookId, chapterId: preview.previewChapterId });
        close();
      } catch (err) {
        const code = err instanceof RevisionOpFailure ? err.code : 'network';
        const [kind, message] =
          code === 'has_revision' ? (['warn', REVISION_COPY.hasRevision] as const)
          : code === 'chapter_busy' ? (['warn', REVISION_COPY.busy] as const)
          : (['error', REVISION_COPY.restoreFailed] as const);
        dispatch(notificationsActions.pushToast({ kind, message, dedupeKey: `preview-restore-${code}` }));
      } finally {
        dispatch(uiActions.setRevisionOpInFlight(false));
      }
    };
  }
  ```
  Use the actual module `layout.tsx` imports `buildCharacterRegenEvent` from (grep it).

- [ ] **Step 3: Green.** The test file, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Drop `review` from the `startPreviewRegen` entry → red: `stores the preview with its bookId and enqueues … carrying review`.
  2. Use the active book instead of `preview.bookId` for the fan-out (`bookId: activeBookId(getState())!`) → red: `a preview for another book fans out to THAT book…`.
  3. Close the preview on `has_revision` (call `close()` in the catch) → red: the `has_revision` row.
  4. Remove the `!preview.stub?.hasPreviousAudio` early return → red: `hasPreviousAudio false → drops the preview with no request`.
- [ ] **Step 5: Commit.** `feat(frontend): add preview thunks for start, approve and unrecorded reject (#3400)`.

---

### Task 16: `RevisionDiffPlayer` — `busy`, `rendering`, Keep new take, release + re-attach, the OD20 recovered label

**Character:** mechanical.

**Files:**
- Modify: `src/views/revision-diff.tsx`, `src/lib/use-ab-playback.ts`.
- Test: `src/views/revision-diff.test.tsx`.

**Interfaces:**
- Props (all optional): `busy?: boolean`, `rendering?: boolean`, `previousMissing?: boolean`, `onKeepNew?: () => void`.
- Footer rule (review mode only, OD11): when `onKeepNew` is given **and** A is unavailable (`!hasPreviousAudio || previousMissing`), the primary button reads **Keep new take** (calls `onKeepNew`) and **Reject draft** is disabled. Preview mode unchanged. `busy` disables both buttons.
- **OD20 label:** when `revision.recovered === true` (Task 6's server flag), the header shows a badge `Recovered from before the update` (`data-testid="revision-recovered-badge"`), and the A card's `sub` reads `The take kept before this chapter's last render` instead of `Already in your audiobook` — never "the original": the kept take may predate the take this entry was recorded against (OD20). Without the flag, nothing changes. Both modes.
- `useAbPlayback` gains `release(): void` — pause both, remove `src`, `load()` — and **lazy re-attach**: `playA`/`playB` first restore the element's `src` from the latest url if it was released (`if (!el.getAttribute('src') && url) el.src = url`). So a refused op (the player stays open) still plays. Every footer click calls `ab.release()` first.

- [ ] **Step 1: Failing tests** in `revision-diff.test.tsx`. Extend `renderPlayer` to take props: change its signature to `renderPlayer(revision: Revision = makeRevision(), extra: Partial<React.ComponentProps<typeof RevisionDiffPlayer>> = {})` and spread `{...extra}` onto `<RevisionDiffPlayer …/>`. Then:
  ```ts
  it('plan 286 — busy disables every footer action', () => {
    renderPlayer(makeRevision(), { busy: true });
    expect(screen.getByRole('button', { name: /Reject draft/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Commit selection/i })).toBeDisabled();
  });
  it('plan 286 — rendering shows the rendering copy and disables B', () => {
    renderPlayer(makeRevision(), { rendering: true });
    expect(screen.getByText(/Rendering new take/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Play B · New draft/i)).toBeDisabled();
  });
  it('plan 286 — A unavailable: Keep new take replaces Commit selection; Reject is disabled', () => {
    const onKeepNew = vi.fn();
    renderPlayer(makeRevision(), { previousMissing: true, onKeepNew });
    expect(screen.queryByRole('button', { name: /Commit selection/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Keep new take/i }));
    expect(onKeepNew).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Reject draft/i })).toBeDisabled();
  });
  it('plan 286 — preview mode never shows Keep new take', () => {
    render(<RevisionDiffPlayer revision={makeRevision({ hasPreviousAudio: false })} bookId="book-1" chapter={chapter} character={character}
      onClose={vi.fn()} onAccept={vi.fn()} onReject={vi.fn()} onKeepNew={vi.fn()} mode="preview" />);
    expect(screen.queryByRole('button', { name: /Keep new take/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Approve.*regenerate the rest/i })).toBeEnabled();
  });
  it('plan 286 — releases both audio elements before calling onReject', () => {
    const order: string[] = [];
    basePause.mockImplementation(function (this: HTMLMediaElement) { order.push('pause'); });
    const onReject = vi.fn(() => { order.push('reject'); });
    renderPlayer(makeRevision(), { onReject });
    fireEvent.click(screen.getByRole('button', { name: /Reject draft/i }));
    expect(order.filter((o) => o === 'pause').length).toBeGreaterThanOrEqual(2);
    expect(order.lastIndexOf('pause')).toBeLessThan(order.indexOf('reject'));
  });
  it('plan 286 — after a refused reject (player still open), A and B still play from their URLs', async () => {
    const played: Array<string | null> = [];
    basePlay.mockImplementation(function (this: HTMLMediaElement) { played.push(this.getAttribute('src')); return Promise.resolve(); });
    renderPlayer(makeRevision());
    await waitFor(() => expect(api.getChapterAudio).toHaveBeenCalled());
    await waitFor(() => expect(api.getChapterAudioPrevious).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); }); // let setAudioA/setAudioB land so the hook has both URLs
    fireEvent.click(screen.getByRole('button', { name: /Reject draft/i })); // release; onReject is a no-op mock = refused
    fireEvent.click(screen.getByLabelText(/Play A · Current/i));
    fireEvent.click(screen.getByLabelText(/Play B · New draft/i));
    await waitFor(() => expect(played).toEqual(['blob:a', 'blob:b']));
  });
  it('plan 286 (OD20) — a recovered entry is labelled, and its A side is described as the kept take', () => {
    renderPlayer(makeRevision({ recovered: true }));
    expect(screen.getByTestId('revision-recovered-badge')).toHaveTextContent('Recovered from before the update');
    expect(screen.getByText("The take kept before this chapter's last render")).toBeInTheDocument();
    expect(screen.queryByText('Already in your audiobook')).toBeNull();
  });
  it('plan 286 (OD20) — an ordinary entry shows no recovered label', () => {
    renderPlayer(makeRevision());
    expect(screen.queryByTestId('revision-recovered-badge')).toBeNull();
    expect(screen.getByText('Already in your audiobook')).toBeInTheDocument();
  });
  ```
  (`basePlay`/`basePause` are the file's existing spies; `afterEach` restores them; add `act` to the RTL import.) Run → FAIL on five: `busy disables…`, `rendering shows…`, `A unavailable: Keep new take…`, `releases both audio elements…` (no `pause` precedes `reject`), and `a recovered entry is labelled…`. **Three pass before the change** and are regression guards, each with named red evidence: `preview mode never shows Keep new take` (no Keep new take button exists yet anywhere — mutation 4), `after a refused reject … still play` (nothing releases yet — mutation 3), and `an ordinary entry shows no recovered label` (no badge exists yet — mutation 6).

- [ ] **Step 2: Implement.**
  - `use-ab-playback.ts`: keep the latest urls in refs (`const urlARef = useRef(urlA); urlARef.current = urlA;` and the same for B). Add
    ```ts
    /** Plan 286 — free both elements' file handles BEFORE an accept/reject
        reaches the server (Windows refuses to unlink/rename an open file).
        playA/playB re-attach lazily, so a refused op leaves a working player. */
    const release = useCallback(() => {
      for (const el of [refA.current, refB.current]) {
        if (!el) continue;
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      setSnap({ playing: null, segmentId: null });
    }, []);
    ```
    and at the top of the element-resolving path in `playA` / `playB` (where each gets its element): `if (!el.getAttribute('src') && urlARef.current) el.src = urlARef.current;` (B with `urlBRef`). Add `release` to the hook's return object and type.
  - `revision-diff.tsx`: destructure the props; `const aUnavailable = !hasPreviousAudio || previousMissing === true; const bAvailable = playable && !rendering;`. Use `aUnavailable` everywhere `!hasPreviousAudio` gates A (the A `ABCard`'s `available`/`sub`, `aDisabled`, the auto-compare `disabled`, `handlePlay`'s A guard) and `bAvailable` everywhere `playable` gates B (B `ABCard` `available`, its `sub` shows `'Rendering new take…'` when `!bAvailable`, `bDisabled`, auto-compare, `handlePlay`'s B guard). Footer:
    ```tsx
    const keepNewOnly = !isPreview && aUnavailable && onKeepNew !== undefined;
    …
    <button onClick={() => { ab.release(); onReject(); }} disabled={busy || keepNewOnly}
      className="px-4 py-2.5 text-sm font-medium text-ink/70 hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed">
      {isPreview ? 'Reject & re-adjust' : 'Reject draft'}
    </button>
    {keepNewOnly ? (
      <PrimaryButton variant="dark" disabled={busy} onClick={() => { ab.release(); onKeepNew!(); }}>Keep new take</PrimaryButton>
    ) : (
      <PrimaryButton variant="dark" disabled={busy} onClick={() => { ab.release(); onAccept(selected); }}>
        {isPreview ? 'Approve — regenerate the rest' : 'Commit selection'}
      </PrimaryButton>
    )}
    ```
    If `PrimaryButton` has no `disabled` prop, add one that forwards to its `<button>` (`src/components/primitives.tsx`).
  - The "Original audio not preserved" copy is also shown when `previousMissing`; the previous-audio fetch effect keys on `hasPreviousAudio` only (unchanged).
  - OD20: `const recovered = revision.recovered === true;` — in the header, directly before the `Triggered {revision.triggeredAgo}` span, `{recovered && <span data-testid="revision-recovered-badge" className="px-2.5 py-1 rounded-full bg-peach/15 text-magenta text-xs font-semibold">Recovered from before the update</span>}` (the peach/magenta pairing the header's A/B icon already uses); the A `ABCard`'s `sub`: `aUnavailable ? 'Original audio not preserved — review by metadata only' : recovered ? "The take kept before this chapter's last render" : 'Already in your audiobook'`. Token classes only (CLAUDE.md: no hex literals).

- [ ] **Step 3: Green.** `revision-diff.test.tsx` (all existing cases still pass), `src/lib/use-ab-playback.test.ts` if it exists, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Drop `disabled={busy}` from the non-keep-new `PrimaryButton` → red: `busy disables every footer action`.
  2. Call `onReject()` before `ab.release()` → red: `releases both audio elements before calling onReject`.
  3. Delete the lazy re-attach line in `playA` → red: `after a refused reject … A and B still play` (`played[0]` is `null`).
  4. Drop `!isPreview &&` from `keepNewOnly` → red: `preview mode never shows Keep new take` (with `hasPreviousAudio:false` and `onKeepNew` given, the preview footer now shows Keep new take).
  5. Delete the badge element → red: `a recovered entry is labelled…`.
  6. Render the badge unconditionally (drop `recovered &&`) → red: `an ordinary entry shows no recovered label`.
- [ ] **Step 5: Commit.** `feat(frontend): add busy, rendering, Keep new take and the recovered label to the A/B player (#3400)`.

---

### Task 17: Types — realign the hand-written `BookStateResponse.revisions` to the generated type

**Character:** mechanical.

**Why:** the hand-written `BookStateResponse.revisions` (`src/lib/types.ts ~:438-446`) lacks `bookId`/`fileId`/`rev`/`timeline` and has no `revisionsError`, while Task 5 changed the wire shape (CLAUDE.md: OpenAPI is the type source). Split out of the layout task so that task's diff is only behaviour.

**Files:**
- Modify: `src/lib/types.ts` — `revisions: RevisionsState | null;` (the `RevisionsState` alias Task 8 added) and `revisionsError?: string;` with a one-line doc each; the inline object and its `acceptedSelections` doc comment (which cites `revisionsActions.acceptRevision`) go with it.
- Modify: whatever fixture `typecheck` then flags (the `MOCK_BOOK_STATES` builders and `src/mocks/marketing/hollow-tide.ts` already use `revisions: null`; `buildSolwayBayMockState`'s `revisions: { pending: … }` was removed in Task 10).
- Test: `src/lib/api-types.revisions-contract.test.ts`.

- [ ] **Step 1: Failing test** (import `type BookStateResponse` from `./types`):
  ```ts
  it('plan 286 — the client BookStateResponse.revisions is the generated RevisionsState', () => {
    expectTypeOf<BookStateResponse['revisions']>().toEqualTypeOf<S['RevisionsState'] | null>();
    expectTypeOf<BookStateResponse['revisionsError']>().toEqualTypeOf<string | undefined>();
  });
  ```
  Run: `npm --prefix <wt> run typecheck` → FAIL at this test (the inline shape is not `RevisionsState`; `revisionsError` does not exist).

- [ ] **Step 2: Implement** per Files. The layout's `revisionsActions.hydrateFromBookState({ bookId, ...(res.revisions ?? {}) })` keeps compiling (a spread is not excess-property-checked) and is replaced in Task 18.

- [ ] **Step 3: Green.** `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts src/lib/api.mock-state.test.ts src/components/layout.test.tsx` (behaviour unchanged), `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Restore the inline `revisions` object → `typecheck` red at `the client BookStateResponse.revisions is the generated RevisionsState`.

- [ ] **Step 5: Commit.** `refactor(frontend): type BookStateResponse.revisions from the OpenAPI schema (#3400)`.

---

### Task 18: Layout — book-open hydrate, rehydrate on reopen, sequence guard, OD2 toast

**Character:** judgment (layout.tsx is 2.6k lines; its test file 2.7k).

**Files:**
- Modify: `src/components/layout.tsx` — the per-book hydration effect (`useEffect(() => { if (!bookId) return; … }, [bookId, stageKind])`, `~:758-1041`), the `revisionsHydratedFor` selector (`~:202`), and the `pending` selector (`~:195`: `useAppSelector((s) => s.revisions.pending)` → `useAppSelector(selectActivePending)` — moved here from Task 22, because this task's "book B never shows A's pending" assertion is on the rendered UI, which reads that selector).
- Test: `src/components/layout.test.tsx`.

**Interfaces:**
- Consumes: `revisionsActions.hydrate` + `adoptSeq` (Task 12), `GET /state` (Task 5).
- Behaviour:
  - Every hydrate read captures `const requestSeq = store.getState().revisions.adoptSeq;` **immediately before** `api.getBookState(bookId)`, and dispatches `revisionsActions.hydrate({ bookId, state: res?.revisions ?? null, requestSeq })` where `hydrateFromBookState` is dispatched today (both the `res === null` branch and the full-load branch).
  - **Reopen:** when `manuscriptReady`, the effect re-reads revisions (today's revisions-only path) **once per arrival at the book** — tracked by a ref `revisionsReadFor`, set to `bookId` **only when a read lands** (the not-cancelled branch that dispatches `hydrate`, in both the full-load and revisions-only paths) and **cleared on every `bookId` change** (pass 3, A7 — not only when `bookId` becomes falsy: a read for book B that is cancelled before it lands would otherwise leave the ref holding A, so a return to A short-circuits on A's old read) — so a stage change within the same book (confirm → ready) does not issue another `GET /state` (gap 2), while a read the effect's cleanup **cancelled** before it landed (`cancelled = true`) leaves the ref unset and the next run re-issues it rather than short-circuiting on a read that never arrived. A→B→A re-reads, because leaving A cleared the ref, whether or not B's read ever landed.
  - Remove: `revisionsHydratedFor`/`revisionsReady`, `hasWindowWrites`, both `persistPendingAfterHydrateMerge` dispatches. Keep `flushBookPersistence` (other slices still persist).
  - Retry loop (OD3): kept for the **full-load** path only; on the revisions-only path a failed read is `console.warn`ed and dropped (no toast, no retry).
  - **OD2:** when `res.revisionsError` is set, push a warn toast whose message is **`res.revisionsError` verbatim** (Task 5 makes it the fixed user sentence, or the newer-schema "upgrade the server" sentence — both path-free), dedupe `revisions-unreadable-<bookId>`, **at most once per book per session** — a module-level `const revisionsErrorToasted = new Set<string>();`, with a test-only `export function _resetRevisionsErrorToastedForTests(): void { revisionsErrorToasted.clear(); }` so tests (and vitest's `retry: 1` re-run) start from an empty set.

- [ ] **Step 1: Failing tests.** Add helpers near the top of `layout.test.tsx` (after `makeStore`):
  ```ts
  const F1 = '000000000000001-a';
  function bookStateFor(bookId: string, revisions: unknown, extra: Record<string, unknown> = {}) {
    return {
      state: { bookId, manuscriptId: `mns_${bookId}`, title: `Book ${bookId}`, author: 'Della Renwick', series: 'Standalones',
        seriesPosition: null, isStandalone: true, manuscriptFile: 'manuscript.txt', castConfirmed: true, chapters: [],
        coverGradient: ['#3C194F', '#0F0E0D'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      cast: { characters: [{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' }] },
      manuscript: { wordCount: 0, format: 'plaintext' }, manuscriptEdits: null,
      revisions, completedSlugs: [], chapterCharacters: {}, changeLog: null, ...extra,
    };
  }
  const revState = (bookId: string, fileId: string | null, rev: number, ids: string[]) =>
    ({ bookId, fileId, rev, pending: ids.map((id) => ({ id, chapterId: 3, characterId: 'eliza', segments: [] })), dismissed: [], acceptedSelections: {}, timeline: {} });
  function renderLayoutAt(store: ReturnType<typeof makeStore>, bookId: string) {
    return render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/books/${bookId}/cast`]}>
          <Routes><Route path="/books/:bookId/cast" element={<Layout />} /></Routes>
        </MemoryRouter>
      </Provider>,
    );
  }
  const openAt = (store: ReturnType<typeof makeStore>, id: string) =>
    act(() => { store.dispatch({ type: 'ui/openBook', payload: { id, status: 'cast_pending' } }); });
  ```
  Then a new `describe('Layout — revisions hydrate (plan 286)', …)` replacing `describe('Layout — per-book hydration: revisions branch (plan 27)')`'s first test:
  ```ts
  describe('Layout — revisions hydrate (plan 286)', () => {
    beforeEach(() => {
      pollRevisionsMock.mockResolvedValue({ drift: [] });
      pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
      _resetRevisionsErrorToastedForTests(); // module-level: without this, a retry or test order leaks the OD2 set
    });

    it('book open dispatches hydrate with the normalised revisions (fileId/rev adopted)', async () => {
      getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', F1, 3, ['r1'])));
      const store = makeStore();
      openAt(store, 'b1');
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: 'b1', fileId: F1, rev: 3 }));
      expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['r1']);
    });

    it('reopening a book always re-hydrates revisions, even with manuscript and cast already loaded', async () => {
      getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
      const store = makeStore();
      openAt(store, 'b1');
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
      getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', F1, 1, ['fresh'])));
      act(() => { store.dispatch(uiActions.goHome()); });
      openAt(store, 'b1');
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['fresh']));
    });

    it('a stage change within the same book (confirm → ready) does not re-read revisions', async () => {
      getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
      const store = makeStore();
      openAt(store, 'b1');
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
      act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } }); }); // → ready
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(getBookStateMock).toHaveBeenCalledTimes(1);
    });

    it('a failed reopen read is dropped silently (no toast); the poll repairs it', async () => {
      getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
      const store = makeStore();
      openAt(store, 'b1');
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
      getBookStateMock.mockRejectedValueOnce(new Error('boom'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      act(() => { store.dispatch(uiActions.goHome()); });
      openAt(store, 'b1');
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      warn.mockRestore();
      expect(store.getState().notifications.toasts).toEqual([]);
    });

    it('a reopen read cancelled by a stage change before it lands is re-issued, not skipped', async () => {
      getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
      const store = makeStore();
      openAt(store, 'b1');
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
      let resolveCancelled!: (v: unknown) => void;
      getBookStateMock
        .mockReturnValueOnce(new Promise((r) => (resolveCancelled = r)))
        .mockResolvedValueOnce(bookStateFor('b1', revState('b1', F1, 2, ['fresh'])));
      act(() => { store.dispatch(uiActions.goHome()); });
      openAt(store, 'b1'); // read #2 starts and stays in flight
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
      act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } }); }); // stage change: cleanup cancels read #2
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(3)); // re-issued, because read #2 never landed
      await act(async () => { resolveCancelled(bookStateFor('b1', revState('b1', null, 0, []))); }); // the cancelled read lands late and is ignored
      await waitFor(() => expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['fresh']));
    });

    it('A7 — a read for another book cancelled before it lands does not let a return skip the first book's re-read', async () => {
      getBookStateMock.mockImplementation(async (id: string) => bookStateFor(id, revState(id, null, 0, [])));
      const store = makeStore();
      openAt(store, 'bA');
      renderLayoutAt(store, 'bA');
      await waitFor(() => expect(store.getState().manuscript.bookId).toBe('bA')); // bA's read landed
      getBookStateMock.mockImplementationOnce(() => new Promise(() => {})); // bB's read never lands
      openAt(store, 'bB');
      await waitFor(() => expect(getBookStateMock).toHaveBeenLastCalledWith('bB'));
      const callsBefore = getBookStateMock.mock.calls.length;
      getBookStateMock.mockImplementation(async (id: string) => bookStateFor(id, revState(id, F1, 1, ['back'])));
      openAt(store, 'bA'); // cancels bB's read; bA is still manuscript-ready, so this is the revisions-only path
      await waitFor(() => expect(getBookStateMock.mock.calls.length).toBe(callsBefore + 1));
      expect(getBookStateMock).toHaveBeenLastCalledWith('bA');
      await waitFor(() => expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['back']));
    });

    it('sequence guard — a slow reopen read on a legacy book does not erase the entry the user just recorded', async () => {
      getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
      const store = makeStore();
      openAt(store, 'b1');
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
      let resolveRead!: (v: unknown) => void;
      getBookStateMock.mockReturnValueOnce(new Promise((r) => (resolveRead = r)));
      act(() => { store.dispatch(uiActions.goHome()); });
      openAt(store, 'b1');
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2)); // read in flight, carrying the pre-op seq
      act(() => { store.dispatch(revisionsActions.applyServerState(revState('b1', F1, 1, ['recorded']))); }); // the op lands first
      await act(async () => { resolveRead(bookStateFor('b1', revState('b1', null, 0, []))); }); // the stale snapshot lands after
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(store.getState().revisions.fileId).toBe(F1);
      expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['recorded']);
    });

    it('OD2 — an unreadable revisions.json toasts the server sentence once per book per session', async () => {
      const msg = "This book's A/B review history couldn't be read, so its pending reviews aren't shown.";
      getBookStateMock.mockResolvedValue(bookStateFor('b9', null, { revisionsError: msg }));
      const store = makeStore();
      openAt(store, 'b9');
      renderLayoutAt(store, 'b9');
      await waitFor(() => expect(store.getState().notifications.toasts.map((t) => t.message)).toEqual([msg]));
      act(() => { store.dispatch(notificationsActions.dismissByKey('revisions-unreadable-b9')); });
      act(() => { store.dispatch(uiActions.goHome()); });
      openAt(store, 'b9');
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(store.getState().notifications.toasts).toEqual([]);
    });

    it('OD2 — a newer-schema file toasts its own upgrade sentence', async () => {
      const upgrade = 'revisions.json declares schema=99 but this server only understands up to schema=1. Refusing to read it — upgrade the server before editing this book.';
      getBookStateMock.mockResolvedValue(bookStateFor('b8', null, { revisionsError: upgrade }));
      const store = makeStore();
      openAt(store, 'b8');
      renderLayoutAt(store, 'b8');
      await waitFor(() => expect(store.getState().notifications.toasts.map((t) => t.message)).toEqual([upgrade]));
    });

    it("book B never shows book A's pending in the rendered UI (selector scoping)", async () => {
      getBookStateMock.mockImplementation(async (id: string) => bookStateFor(id, revState(id, F1, 1, id === 'bA' ? ['a-take'] : [])));
      const store = makeStore();
      openAt(store, 'bA');
      renderLayoutAt(store, 'bA');
      fireEvent.click(await screen.findByTestId('status-pill'));
      await waitFor(() => expect(within(screen.getByTestId('status-popover-revisions')).getByText(/1 revision pending/)).toBeInTheDocument());
      openAt(store, 'bB'); // the cache still holds bA's entry until bB's hydrate lands
      /* Open the popover if it is not already open (clicking an open one would close it).
         With the scoped selector bB has no pending, so the pill may not render at all. */
      const pill = screen.queryByTestId('status-pill');
      if (pill && !screen.queryByTestId('status-popover-revisions')) fireEvent.click(pill);
      expect(screen.queryByText(/revisions? pending/)).toBeNull();
    });
  });
  ```
  (Import `_resetRevisionsErrorToastedForTests` from `./layout`, and `notificationsActions`, `uiActions`, `revisionsActions`, `within` as the file needs.)

  **Delete in this task** (they pin #3395 machinery removed here): the rest of `describe('Layout — per-book hydration: revisions branch (plan 27)')` that asserts `hydrateFromBookState` payloads, all of `describe('Layout — revisions persist only after the book is hydrated (#3395 pass 3, R1/R1b/R2)')` (`~:621-1276`) except "the failed-read notice is dismissed when the user moves on to another book" (full-load path — keep, adapting its fixture to `bookStateFor`), and `describe('Layout — revisions.bookId scope tracking through real navigation (#3395 pass 2, N1)')` (`~:534-620`, replaced by the selector test above). List each deleted test in the commit body with what replaces it (Task 12 cache tests, Task 14 thunk tests, or "machinery deleted, behaviour moved server-side"). `makeStoreWithScope` stays until Task 26 if any remaining test uses it.

  Run → FAIL on the new tests, including `book B never shows book A's pending in the rendered UI` (the layout still reads the raw `s.revisions.pending`, which holds bA's entry the instant the stage names bB — it replaces the deleted #3395 N1 layout test). One passes already and is a regression guard: `a stage change within the same book … does not re-read` (today's `hydratedFor` short-circuit also skips it); mutation 2 is its red evidence.

- [ ] **Step 2: Implement** per Interfaces. Core of the effect:
  ```ts
  /* Plan 286 — revisions are server-owned: every arrival at a book re-reads
     them (one GET), so a take recorded while the user was away (#3397) — or a
     delete + re-import in another tab — is picked up. A stage change within
     the same book does not re-read (revisionsReadFor). The other slices keep
     their short-circuit. */
  if (manuscriptReady && revisionsReadFor.current === bookId) return;
  const revisionsOnly = manuscriptReady;
  ```
  with `const revisionsReadFor = useRef<string | null>(null);` declared in the component, and — **declared above the hydration effect**, so it runs first on a book change (React runs a component's effects in declaration order) — `useEffect(() => { revisionsReadFor.current = null; }, [bookId]);` (A7: every book change forgets the last arrival's read; a stage change within the book does not re-run it). In `load`, capture `const requestSeq = store.getState().revisions.adoptSeq;` right before `api.getBookState(bookId)`; at both former `hydrateFromBookState` sites (each already behind `if (cancelled) return;`), dispatch `revisionsActions.hydrate({ bookId, state: res?.revisions ?? null, requestSeq })` and **then** set `revisionsReadFor.current = bookId;` — the read landed, so the arrival is satisfied; a cancelled read never reaches this line. Then
  ```ts
  if (res?.revisionsError && !revisionsErrorToasted.has(bookId)) {
    revisionsErrorToasted.add(bookId);
    /* Path-free by construction (Task 5: a fixed sentence, or the newer-schema
       upgrade sentence), so it is shown verbatim. */
    dispatch(notificationsActions.pushToast({ kind: 'warn', message: res.revisionsError, dedupeKey: `revisions-unreadable-${bookId}` }));
  }
  ```
  Above the component: `const revisionsErrorToasted = new Set<string>();` and `/** Test-only. */ export function _resetRevisionsErrorToastedForTests(): void { revisionsErrorToasted.clear(); }`. Switch `const pending = useAppSelector((s) => s.revisions.pending);` to `useAppSelector(selectActivePending)`.
  In the rejection handler, before the toast/retry: `if (revisionsOnly) { console.warn('[book-state] revisions re-read failed; the next poll repairs it:', err?.message); return; }`, and keep only the full-load toast copy.

- [ ] **Step 3: Green.** `layout.test.tsx`, `src/routes/confirm-rehydrate.test.tsx`, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Replace `revisionsReadFor.current === bookId` with `true` (always short-circuit when loaded) → red: `reopening a book always re-hydrates revisions…`.
  2. Delete the whole short-circuit statement (`if (manuscriptReady && revisionsReadFor.current === bookId) return;` — so every effect run re-reads) → red: `a stage change within the same book … does not re-read revisions`.
  3. Pass `requestSeq: undefined` to `hydrate` → red: `sequence guard — a slow reopen read…`.
  4. Remove the `revisionsErrorToasted` check → red: `OD2 — … toasts once per book per session`.
  5. Re-add the toast on the revisions-only failure → red: `a failed reopen read is dropped silently`.
  6. Move `revisionsReadFor.current = bookId;` back to where the read **starts** → red: `a reopen read cancelled by a stage change before it lands is re-issued, not skipped` (only two `getBookState` calls; `pending` stays empty).
  7. Revert `pending` to `useAppSelector((s) => s.revisions.pending)` → red: `book B never shows book A's pending in the rendered UI`.
  8. Toast a fixed client sentence instead of `res.revisionsError` → red: `OD2 — a newer-schema file toasts its own upgrade sentence`.
  9. Delete the `_resetRevisionsErrorToastedForTests()` call from the describe's `beforeEach` **and** paste a second copy of `OD2 — an unreadable revisions.json toasts the server sentence once per book per session` directly below the first (simulating vitest's retry re-run) → red: the copy (no toast — `b9` is already in the set). Remove the copy and restore the call.
  10. Restore the old clear (`useEffect(() => { if (!bookId) revisionsReadFor.current = null; }, [bookId]);`) → red: `A7 — a read for another book cancelled before it lands…` (no third `getBookState` call: the ref still holds `bA`, so the return short-circuits).
- [ ] **Step 5: Commit.** `fix(frontend): rehydrate revisions from the server on every book open, guarded against stale reads (#3397)`.

---

### Task 19: Layout — polls adopt server state (D9), dismiss via the thunk

**Character:** judgment.

**Files:**
- Modify: `src/store/revisions-slice.ts` (`applyPoll`), `src/components/layout.tsx` (active poll `~:1113-1125`, bulk poll `~:1148-1165`, drift-report `onDismiss` `~:2199`).
- Test: `src/store/revisions-slice.test.ts`, `src/components/layout.test.tsx` (the `(#3376 round 2)` describe `~:2658`), `src/store/revisions-thunks.test.ts`.

**Interfaces:**
- `applyPoll(payload: RevisionsResponse & { bookId: string })`: merges drift for `bookId`, then ordered adopt, then `loaded = true`. `bookId` becomes required.
- Active poll: `.then((res) => { if (!cancelled && (store.getState().ui.stage as { bookId?: string }).bookId === bookId) dispatch(revisionsActions.applyPoll({ ...res, bookId })); }).catch((err) => console.warn('[revisions] active poll failed:', (err as Error).message))`.
- Bulk poll: chunks of ≤50 (`BULK_POLL_MAX = 50`, the server's cap); each chunk has its own `.catch`; `res.errors` entries and chunk failures go through `warnOnce` (module-level `Set`, with a test-only `export function _resetRevisionPollWarningsForTests(): void` that clears it — same reason as Task 18's OD2 set: a module-level set otherwise leaks across tests and across vitest's `retry: 1` re-run), console only (OD24).
- `onDismiss={(eventId) => void dispatch(dismissDriftOp(eventId))}`.

- [ ] **Step 1: Failing tests.**
  (a) `revisions-slice.test.ts`: delete `describe('revisionsSlice — applyPoll')`'s three cases asserting "never touches pending" and `describe('revisionsSlice — applyPoll preserves dismissed')` (both pin client ownership that this task ends — list them in the commit body); add:
  ```ts
  describe('applyPoll adopts server state (plan 286)', () => {
    const F = '000000000000001-a';
    const base = () => revisionsSlice.reducer(undefined, revisionsActions.applyServerState({ bookId: 'A', fileId: F, rev: 2, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} }));
    it('adopts pending/dismissed by the ordered rule and merges drift', () => {
      const s = revisionsSlice.reducer(base(), revisionsActions.applyPoll({ bookId: 'A', fileId: F, rev: 3, pending: [{ id: 'p', chapterId: 1, characterId: 'c', segments: [] }], dismissed: ['d'], drift: [{ id: 'x', bookId: 'A' } as never] }));
      expect(s.pending.map((p) => p.id)).toEqual(['p']); expect(s.dismissed).toEqual(['d']); expect(s.drift.map((d) => d.id)).toEqual(['x']); expect(s.loaded).toBe(true);
    });
    it('a stale poll (lower rev) updates drift but not pending', () => {
      let s = revisionsSlice.reducer(base(), revisionsActions.applyServerState({ bookId: 'A', fileId: F, rev: 5, pending: [{ id: 'keep', chapterId: 1, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} }));
      s = revisionsSlice.reducer(s, revisionsActions.applyPoll({ bookId: 'A', fileId: F, rev: 4, pending: [], drift: [{ id: 'new', bookId: 'A' } as never] }));
      expect(s.pending.map((p) => p.id)).toEqual(['keep']); expect(s.drift.map((d) => d.id)).toEqual(['new']);
    });
  });
  ```
  Fix the `multi-book drift` `applyPoll` cases that omit `bookId` (pass one). In `revisions-thunks.test.ts`, add to `revision_not_found without a state refetches the active book`: `expect(store.getState().revisions.rev).toBe(4);` (deferred from Task 14).

  (b) `layout.test.tsx`: replace the body of `describe('Layout — active book poll never overwrites client-owned pending (#3376 round 2)')` with a renamed describe `'Layout — revisions polls (plan 286)'` holding:
  ```ts
  function libraryOf(ids: string[]) {
    return { authors: [{ name: 'Della Renwick', series: [{ name: 'The Hollow Tide', books: ids.map((id) => ({
      bookId: id, title: `Book ${id}`, author: 'Della Renwick', series: 'The Hollow Tide', seriesPosition: 1, isStandalone: false,
      status: 'complete', chapterCount: 1, completedChapters: 1, characterCount: 1, voiceCount: 1, lastWorkedOn: 'today',
      coverGradient: ['#000', '#fff'], tags: [] })) }] }] } as unknown as LibraryResponse;
  }
  beforeEach(() => { _resetRevisionPollWarningsForTests(); }); // the warn-once set is module-level
  async function noUnhandled(run: () => Promise<void>) {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', on);
    try { await run(); await new Promise((r) => setTimeout(r, 10)); } finally { process.off('unhandledRejection', on); }
    expect(seen).toEqual([]);
  }

  it('a stale active poll (lower rev) does not clobber pending', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', F1, 5, ['keep'])));
    pollRevisionsMock.mockResolvedValue({ ...revState('b1', F1, 4, []), drift: [] });
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    const store = makeStore();
    act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } }); }); // ready → active poll runs
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(pollRevisionsMock).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['keep']);
  });
  it('a failing active poll is caught', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsMock.mockRejectedValue(new Error('500'));
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noUnhandled(async () => {
      const store = makeStore();
      act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } }); });
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(pollRevisionsMock).toHaveBeenCalled());
    });
    warn.mockRestore();
  });
  it('D9 — a failing bulk poll is caught', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsBulkMock.mockRejectedValue(new Error('500'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noUnhandled(async () => {
      const store = makeStore();
      store.dispatch(librarySlice.actions.hydrate(libraryOf(['active', 'bg1'])));
      act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'active', status: 'cast_pending' } }); });
      renderLayoutAt(store, 'active');
      await waitFor(() => expect(pollRevisionsBulkMock).toHaveBeenCalled());
    });
    warn.mockRestore();
  });
  it('D9 — a partial byBookId with errors still applies the healthy books', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsBulkMock.mockResolvedValue({
      byBookId: { good: { pending: [], drift: [{ id: 'g', bookId: 'good', characterId: 'eliza', chapterId: 1, chapterTitle: 'C1', severity: 'severe', factor: 'voice' }] } },
      errors: { bad: "Couldn't read this book's review state." },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    store.dispatch(librarySlice.actions.hydrate(libraryOf(['active', 'good', 'bad'])));
    act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'active', status: 'cast_pending' } }); });
    renderLayoutAt(store, 'active');
    await waitFor(() => expect(store.getState().revisions.drift.map((d) => d.id)).toContain('g'));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('bad'))).toBe(true);
    warn.mockRestore();
  });
  it('more than 50 background books are polled in chunks of at most 50', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    const ids = Array.from({ length: 121 }, (_, i) => `bk${i}`);
    const store = makeStore();
    store.dispatch(librarySlice.actions.hydrate(libraryOf(ids)));
    act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'bk0', status: 'cast_pending' } }); });
    renderLayoutAt(store, 'bk0');
    await waitFor(() => expect(pollRevisionsBulkMock).toHaveBeenCalledTimes(3)); // 120 non-active books
    const sizes = pollRevisionsBulkMock.mock.calls.map((c) => (c[0] as { bookIds: string[] }).bookIds.length);
    expect(sizes).toEqual([50, 50, 20]);
  });
  ```
  The existing background describe (`~:2549`) seeds pending through `revisionsActions.hydrateFromBookState`; change that seed to `revisionsActions.applyServerState(revState('book-A-slug', F1, 1, ['r-active']))` (its assertion — the bulk tick never touches the active book's pending — still holds: `applyBackgroundPoll` is drift-only).

  Run → FAIL (stale poll adopts? no — `applyPoll` still ignores pending, so the stale test passes; the failing ones are the `.catch` and chunk tests). The two slice tests fail (pending not adopted).

- [ ] **Step 2: Implement.** `applyPoll`:
  ```ts
  /* Plan 286 — the server owns pending. The poll carries the whole
     RevisionsState plus live drift: drift always merges (per book); the rest
     is adopted by the ordered rule, so a slow poll cannot revert a newer op
     response. Callers dispatch only for the active book. */
  applyPoll: (s, a: PayloadAction<RevisionsResponse & { bookId: string }>) => {
    mergeDriftForBook(s, a.payload.bookId, a.payload.drift);
    if (shouldAdoptOrdered(s, a.payload)) adopt(s, a.payload);
    s.loaded = true;
  },
  ```
  Delete the old `applyPoll` doc comment. Layout, above the component:
  ```ts
  const BULK_POLL_MAX = 50; // server cap: 'Up to 50 bookIds per request' (routes/revisions.ts)
  const loggedRevisionPollWarnings = new Set<string>();
  function warnOnce(key: string, msg: string): void {
    if (loggedRevisionPollWarnings.has(key)) return;
    loggedRevisionPollWarnings.add(key);
    console.warn(msg);
  }
  /** Test-only. */
  export function _resetRevisionPollWarningsForTests(): void { loggedRevisionPollWarnings.clear(); }
  ```
  and the bulk effect's `fetchOnce`:
  ```ts
  const fetchOnce = () => {
    for (let i = 0; i < bgBookIds.length; i += BULK_POLL_MAX) {
      const chunk = bgBookIds.slice(i, i + BULK_POLL_MAX);
      api.pollRevisionsBulk({ bookIds: chunk })
        .then((res) => {
          if (cancelled) return;
          for (const [id, r] of Object.entries(res.byBookId)) {
            dispatch(revisionsActions.applyBackgroundPoll({ bookId: id, drift: r.drift }));
          }
          for (const [id, msg] of Object.entries(res.errors ?? {})) warnOnce(`book:${id}`, `[revisions] background poll skipped ${id}: ${msg}`);
        })
        .catch((err) => warnOnce(`chunk:${(err as Error).message}`, `[revisions] background poll failed: ${(err as Error).message}`));
    }
  };
  ```

- [ ] **Step 3: Green.** `revisions-slice.test.ts`, `revisions-slice.cache.test.ts`, `revisions-thunks.test.ts`, `layout.test.tsx`, `src/modals/drift-report.test.tsx`, `typecheck`; e2e `drift-report-multibook.spec.ts revision-diff.spec.ts character-splice.spec.ts`; and `npm --prefix <wt> run test:e2e -- e2e/profile-regen-preview.spec.ts --repeat-each=3` (Global Constraints → "Known transitional window": from this task a poll can adopt over the in-cache preview stub until Task 22).
- [ ] **Step 4: Mutations.**
  1. Remove the bulk `.catch` → red: `D9 — a failing bulk poll is caught`.
  2. Set `BULK_POLL_MAX = 200` → red: `…in chunks of at most 50` (one call of 120 — which the server would 400).
  3. In `applyPoll`, call `adopt` unconditionally → red: `a stale poll (lower rev) updates drift but not pending` and the layout stale-poll test.
  4. Remove the active poll's `.catch` → red: `a failing active poll is caught`.
  5. Delete the `_resetRevisionPollWarningsForTests()` call from the describe's `beforeEach` **and** paste a second copy of `D9 — a partial byBookId with errors…` directly below the first (simulating vitest's retry re-run) → red: the copy (its `warn` spy sees nothing — `book:bad` is already in the set). Remove the copy and restore the call.
- [ ] **Step 5: Commit.** `fix(frontend): adopt server pending from polls and isolate background poll failures (D9) (#3400)`.

---

### Task 20: Splice runner — refetch instead of writing; `inFlightChapters`

**Character:** judgment.

**Files:**
- Modify: `src/store/splice-slice.ts`, `src/store/splice-runner-middleware.ts`.
- Test: `src/store/splice-runner-middleware.test.ts`, `e2e/character-splice.spec.ts`.

**Interfaces:**
- `splice-slice`: `inFlightChapters: Array<{ bookId: string; chapterId: number }>` (initial `[]`); `chapterStarted({ bookId, chapterId })` (adds if absent), `chapterSettled({ bookId, chapterId })` (removes); `export const selectChapterRendering = (s: { splice: SpliceState }, bookId: string, chapterId: number): boolean`.
- Runner: `chapterStarted` before `api.streamSplice`, `chapterSettled` in a `finally` around it. Remove both `revisionsActions` dispatches and the import. On `splice_complete`: `void dispatch(refetchActiveRevisions(req.bookId))` (the thunk skips a non-active book); if `ev.reviewOutcome === 'failed'`, warn toast `The new take is live, but its A/B review couldn't be saved` (dedupe `splice-review-unsaved-<bookId>`). `markChapterAudioUpdated` unchanged. Rewrite the header comment.

- [ ] **Step 1: Failing tests.** In `splice-runner-middleware.test.ts`, add `pollRevisionsSpy` to the hoisted mock and the `api` mock (`api: { streamSplice: streamSpliceSpy, putBookState: putBookStateSpy, pollRevisions: pollRevisionsSpy }`), reset it in `beforeEach` with `pollRevisionsSpy.mockReset().mockResolvedValue({ drift: [] })`. Add an action recorder: a module-level `const dispatched: string[] = [];`, cleared in `beforeEach` (`dispatched.length = 0`), and a recorder appended to `makeStore`'s middleware chain — `getDefault().concat(revisionsScopeMiddleware, persistenceMiddleware, spliceRunnerMiddleware(), () => (next) => (a) => { dispatched.push((a as { type: string }).type); return next(a); })`. (The cache can't prove "never writes pending" on its own: the refetch's `applyPoll` adopts the mocked empty server state and would wipe a stray client enqueue before any assertion runs.) Replace the test `'runs one splice per chapter, enqueues + flips pending revisions, refreshes audio, counts results'` with:
  ```ts
  it('plan 286 — runs one splice per chapter, never writes pending, refetches the active book, refreshes audio, counts results', async () => {
    const store = makeStore();
    store.dispatch(spliceActions.startBatch({ id: 'b1', bookId: 'bk1', characterId: 'castor', characterName: 'Castor Allred', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(streamSpliceSpy).toHaveBeenCalledTimes(2);
    expect(pollRevisionsSpy).toHaveBeenCalledWith({ bookId: 'bk1' });
    expect(dispatched.filter((t) => t.startsWith('revisions/') && t !== 'revisions/applyPoll')).toEqual([]);
    expect(store.getState().revisions.pending).toEqual([]);
    expect(putBookStateSpy.mock.calls.some((c) => (c[1] as { slice: string }).slice === 'revisions')).toBe(false);
    expect(store.getState().chapters.chapters.find((c) => c.id === 1)!.duration).toBe('03:42');
    expect(store.getState().splice.batches.b1).toMatchObject({ total: 2, succeeded: 2, failed: 0, status: 'done' });
  });
  it('plan 286 — a splice that finishes while the user is on another book does not refetch', async () => {
    const store = makeStore();
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      store.dispatch(uiActions.openBook({ id: 'other', status: 'complete' } as never));
      args.onTick({ type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId, mode: args.mode, durationSec: 222, segmentCount: 1, hasPreviousAudio: true } as SpliceTick);
    });
    store.dispatch(spliceActions.startBatch({ id: 'b2', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1] }));
    await flush();
    expect(pollRevisionsSpy).not.toHaveBeenCalled();
  });
  it('plan 286 — inFlightChapters tracks the running chapter per book and clears on completion or failure', async () => {
    /* Failure is driven through a chapter_failed tick, as 'counts a failed chapter
       without aborting the rest' (~:119-121) does — NOT a throwing streamSplice:
       the middleware launches the batch with `void runBatch(...)`, so a throw
       would surface as an unhandled rejection rather than a counted failure. */
    let release!: () => void;
    streamSpliceSpy
      .mockImplementationOnce((args: SpliceArgs) => new Promise<void>((r) => (release = () => {
        args.onTick({ type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId, mode: args.mode, durationSec: 120, segmentCount: 1, hasPreviousAudio: true } as SpliceTick);
        r();
      })))
      .mockImplementationOnce(async (args: SpliceArgs) => { args.onTick({ type: 'chapter_failed', chapterId: args.chapterId, errorReason: 'boom' }); });
    const store = makeStore();
    store.dispatch(spliceActions.startBatch({ id: 'b3', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(store.getState().splice.inFlightChapters).toEqual([{ bookId: 'bk1', chapterId: 1 }]);
    release(); await flush();
    expect(store.getState().splice.batches.b3).toMatchObject({ succeeded: 1, failed: 1, status: 'done' });
    expect(store.getState().splice.inFlightChapters).toEqual([]); // chapter 2 failed and still settled
  });
  it("plan 286 — reviewOutcome:'failed' toasts once", async () => {
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      args.onTick({ type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId, mode: args.mode, durationSec: 222, segmentCount: 1, hasPreviousAudio: true, reviewOutcome: 'failed' } as SpliceTick);
    });
    const store = makeStore();
    store.dispatch(spliceActions.startBatch({ id: 'b4', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(store.getState().notifications.toasts.filter((t) => t.message === "The new take is live, but its A/B review couldn't be saved")).toHaveLength(1);
  });
  ```
  Delete or adapt every other test in the file that asserts `revisions.pending` changes from the runner (`grep -n "revisions.pending\|markRevisionPlayable\|enqueuePending" src/store/splice-runner-middleware.test.ts`); list them in the commit body. (`flush()` is the file's existing helper. `revisionsScopeMiddleware` stays in this file's `makeStore` until Task 26 deletes the module.)

  **e2e** `character-splice.spec.ts` — replace the one-shot `pendingCount` read with:
  ```ts
  await expect
    .poll(() => page.evaluate(() => (window as unknown as StoreWin).__store__?.getState().revisions.pending.length ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(0);
  ```

  Run the unit file → FAIL.

- [ ] **Step 2: Implement** per Interfaces.
- [ ] **Step 3: Green.** The unit file, `typecheck`, `npm --prefix <wt> run test:e2e -- e2e/character-splice.spec.ts`, and `npm --prefix <wt> run test:e2e -- e2e/profile-regen-preview.spec.ts --repeat-each=3` (transitional window, Global Constraints).
- [ ] **Step 4: Mutations.**
  1. Re-add the old per-chapter `dispatch(revisionsActions.enqueuePending({ id: \`splice-${req.bookId}-${chapterId}-${req.characterId}\`, chapterId, characterId: req.characterId, playable: false, hasPreviousAudio: true, segments: [] }))` before `api.streamSplice` → red: `…never writes pending…` at the **recorder** assertion (`['revisions/enqueuePending', 'revisions/enqueuePending']`). The `pending` assertion alone would stay green — the refetch's `applyPoll` adopts the empty mocked state and wipes the entry — which is why the recorder exists. (Re-adding `markRevisionPlayable` is caught by the same assertion.)
  2. Move `chapterSettled` out of the `finally` into the `splice_complete` tick branch (so only a successful chapter settles) → red: `inFlightChapters … clears on completion or failure` (chapter 2's `chapter_failed` leaves it in flight).
  3. Replace the refetch with an unguarded `api.pollRevisions({ bookId: req.bookId }).then((res) => dispatch(revisionsActions.applyPoll({ ...res, bookId: req.bookId })))` → red: `…on another book does not refetch`.
- [ ] **Step 5: Commit.** `fix(frontend): splice runner refetches server pending instead of writing it (#3397)`.

---

### Task 21: Player watcher middleware

**Character:** judgment (three rules that interlock: a server entry resolved elsewhere, the stub's book scope, and a server entry superseding the stub).

**Files:**
- Create: `src/store/revision-player-middleware.ts`; wire it in `src/store/index.ts` (after `persistenceMiddleware`).
- Test: create `src/store/revision-player-middleware.test.ts`.

**Interfaces:**
- `export const revisionPlayerMiddleware: Middleware`. After every action it applies three rules, in this order. Each rule's dispatches make its own condition false, so re-entry is a no-op.
  1. **A server entry supersedes the preview stub (pass 3 #11).** When `ui.previewRegen` is for the active book, carries a `stub`, and `selectActivePending` holds an entry for `previewRegen.previewChapterId`:
     - if the open player is the stub (`openRevision.kind === 'preview-stub'`), first switch it with `setOpenRevision({ kind: 'server', revisionId: entry.id, chapterId })`;
     - then dispatch `setPreviewRegen({ ...preview, stub: undefined, completed: { ...completed, stubFallback: false } })`, keeping `completed` absent when it was absent.

     The order matters: dropping the stub first would let rule 2 hide the stub player before it could be switched.

     **Rule 1 is also how OD30 lands.** `openPreview` (Task 24) opens a stub with the single `uiActions.openPreviewStub` action (Task 13). When the cache already holds an entry for the preview's chapter, the watcher's pass over that one action sees the stub player open and switches it to the entry, so an existing entry wins at build time, for every `reviewOutcome`. Matching is by `chapterId` alone, deliberately (OD30; Out of scope residual).

     This closes the gap where a doubly-failed refetch (Task 24) opened a stub, a later poll adopted the server entry for the same chapter, and stub Approve then fanned out without ever accepting that entry. From then on Approve/Reject go through the recorded entry (Task 22's server-kind handlers). `stubFallback: false` means a later arrival whose refetch fails twice keeps the marker instead of rebuilding a stub over a take the server did record (OD23). A later refetch that succeeds and finds the entry gone drops it as resolved elsewhere, whatever `stubFallback` says (OD29).
  2. **The stub is shown only on its own book (pass 3 #1; OD28).** If `openRevision.kind === 'preview-stub'` and `selectActivePreviewStub` (Task 13) is `undefined`, dispatch `setOpenRevision(null)`. The trigger is the user navigating to another book, or the preview having been cleared. This **hides** the player and never clears `previewRegen`: the preview stays re-openable from the Status popover (Task 22) and on the next arrival at its book (Task 24).
  3. **A server entry resolved elsewhere (D6, unchanged).** If `openRevision.kind === 'server'`, `!ui.revisionOpInFlight`, and the entry is not in `selectActivePending`, dispatch `setOpenRevision(null)`. Additionally, if `ui.previewRegen` is for the active book with `previewChapterId === openRevision.chapterId` (OD10), dispatch `setPreviewRegen(null)` and an info toast `This preview was resolved elsewhere` (dedupe `preview-resolved-elsewhere`).
- Until Task 22, neither `openRevision` nor `previewRegen.stub` is ever set, so the middleware is inert in the app.

- [ ] **Step 1: Failing tests** — `src/store/revision-player-middleware.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { configureStore } from '@reduxjs/toolkit';
  import { uiSlice, uiActions } from './ui-slice';
  import { revisionsSlice, revisionsActions } from './revisions-slice';
  import { notificationsSlice } from './notifications-slice';
  import { revisionPlayerMiddleware } from './revision-player-middleware';

  const F = '000000000000001-a';
  const state = (rev: number, entries: Array<[string, number]>) => ({ bookId: 'A', fileId: F, rev, pending: entries.map(([id, ch]) => ({ id, chapterId: ch, characterId: 'c', segments: [] })), dismissed: [], acceptedSelections: {}, timeline: {} });
  function makeStore() {
    const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer, notifications: notificationsSlice.reducer }, middleware: (g) => g().concat(revisionPlayerMiddleware) });
    store.dispatch(uiActions.openBook({ id: 'A', status: 'complete' } as never));
    store.dispatch(revisionsActions.applyServerState(state(1, [['r1', 3], ['r2', 5]])));
    return store;
  }
  const preview = (ch: number) => ({ bookId: 'A', characterId: 'c', previewChapterId: ch, remainingChapterIds: [], reason: '', note: '' });
  /* Chapter 7 has no cache entry in makeStore, so rule 1 stays quiet until a test adds one. */
  const stubPreview = (completed?: { reviewOutcome?: 'recorded' | 'none' | 'failed'; stubFallback: boolean }) => ({
    ...preview(7), stub: { id: 'revision:7:c', chapterId: 7, characterId: 'c', segments: [] }, ...(completed ? { completed } : {}),
  });
  const toastMessages = (s: ReturnType<typeof makeStore>) => s.getState().notifications.toasts.map((t) => t.message);

  describe('revisionPlayerMiddleware (plan 286)', () => {
    it('a server entry vanishing (another tab) closes the player and clears a preview tied to it, with one toast', () => {
      const store = makeStore();
      store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
      store.dispatch(uiActions.setPreviewRegen(preview(3)));
      store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r2', 5]]), drift: [] }));
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.previewRegen).toBeNull();
      expect(toastMessages(store)).toEqual(['This preview was resolved elsewhere']);
    });
    it("does not fire during the user's own op (revisionOpInFlight)", () => {
      const store = makeStore();
      store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
      store.dispatch(uiActions.setPreviewRegen(preview(3)));
      store.dispatch(uiActions.setRevisionOpInFlight(true));
      store.dispatch(revisionsActions.applyServerState(state(2, [['r2', 5]])));
      expect(store.getState().ui.openRevision).not.toBeNull();
      expect(store.getState().ui.previewRegen).not.toBeNull();
      expect(toastMessages(store)).toEqual([]);
    });
    it('a vanishing entry unrelated to the preview closes the player but keeps the preview', () => {
      const store = makeStore();
      store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r2', chapterId: 5 }));
      store.dispatch(uiActions.setPreviewRegen(preview(3)));
      store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3]]), drift: [] }));
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.previewRegen?.previewChapterId).toBe(3);
      expect(toastMessages(store)).toEqual([]);
    });
    it('a vanishing entry with no preview closes silently (OD16)', () => {
      const store = makeStore();
      store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
      store.dispatch(revisionsActions.applyPoll({ ...state(2, []), drift: [] }));
      expect(store.getState().ui.openRevision).toBeNull();
      expect(toastMessages(store)).toEqual([]);
    });
    it("a poll on the stub's own book never closes it (the stub is never in the cache)", () => {
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen(stubPreview()));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      store.dispatch(revisionsActions.applyPoll({ ...state(2, []), drift: [] }));
      expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
      expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:7:c');
    });
    it('OD28 — navigating to another book hides an open stub player but keeps the preview', () => {
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen(stubPreview({ reviewOutcome: 'none', stubFallback: true })));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:7:c');
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
      expect(toastMessages(store)).toEqual([]);
    });
    it('#11 — a cache entry for the preview chapter supersedes an open stub: the player switches to it', () => {
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen(stubPreview({ reviewOutcome: 'recorded', stubFallback: true })));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3], ['r2', 5], ['r9', 7]]), drift: [] }));
      expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r9', chapterId: 7 });
      expect(store.getState().ui.previewRegen?.previewChapterId).toBe(7); // the preview survives: Approve still fans out
      expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: false });
      expect(toastMessages(store)).toEqual([]);
    });
    it('#11 — with the player closed, the entry still replaces the stub marker', () => {
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen(stubPreview({ reviewOutcome: 'recorded', stubFallback: true })));
      store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3], ['r2', 5], ['r9', 7]]), drift: [] }));
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: false });
    });
    it('OD30 — a stub opened while the cache already holds an entry for its chapter opens that entry instead, in the same dispatch', () => {
      const store = makeStore();
      store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3], ['r2', 5], ['r9', 7]]), drift: [] }));
      store.dispatch(uiActions.setPreviewRegen(preview(7)));
      store.dispatch(uiActions.openPreviewStub({ id: 'revision:7:c', chapterId: 7, characterId: 'c', segments: [] }));
      expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r9', chapterId: 7 });
      expect(store.getState().ui.previewRegen?.previewChapterId).toBe(7); // preview mode: Approve still fans out (Task 22)
      expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
      expect(toastMessages(store)).toEqual([]);
    });
  });
  ```
  (`applyPoll` adopts server state since Task 19.) Run → FAIL (module missing).

- [ ] **Step 2: Implement:**
  ```ts
  /* Plan 286 (D6, spec §4; pass 3 #1/#11; OD28) — the A/B player shows one
     server entry or the preview stub. Three rules, in order:
     1. a server entry for the preview's chapter supersedes its stub (Approve
        must accept that entry, not fan out around it);
     2. the stub is shown only on its own book — leaving hides it, never clears it;
     3. a server entry that leaves the cache while no op of the user's own is in
        flight (another tab resolved it, or a poll dropped it) closes the player,
        and clears a preview tied to that chapter with one toast. */
  import type { Middleware } from '@reduxjs/toolkit';
  import { uiActions, selectActivePreviewStub, type UiState } from './ui-slice';
  import { selectActivePending, type RevisionsState } from './revisions-slice';
  import { notificationsActions } from './notifications-slice';

  type Root = { ui: UiState; revisions: RevisionsState };

  export const revisionPlayerMiddleware: Middleware = (store) => (next) => (action) => {
    const result = next(action);
    const s = store.getState() as Root;
    const open = s.ui.openRevision;
    const preview = s.ui.previewRegen;
    const active = (s.ui.stage as { bookId?: string }).bookId ?? null;

    if (preview?.stub && preview.bookId === active) {
      const entry = selectActivePending(s).find((p) => p.chapterId === preview.previewChapterId);
      if (entry) {
        /* Switch the player first: rule 2 would otherwise hide a stub player
           the moment the stub is dropped. The re-entry this dispatch causes
           runs rule 1 again and drops the stub; `now` below sees that. */
        if (open?.kind === 'preview-stub') {
          store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: entry.id, chapterId: entry.chapterId }));
        }
        const now = (store.getState() as Root).ui.previewRegen;
        if (now?.stub) {
          store.dispatch(uiActions.setPreviewRegen({
            ...now,
            stub: undefined,
            ...(now.completed ? { completed: { ...now.completed, stubFallback: false } } : {}),
          }));
        }
        return result;
      }
    }

    if (!open) return result;
    if (open.kind === 'preview-stub') {
      if (!selectActivePreviewStub(s)) store.dispatch(uiActions.setOpenRevision(null));
      return result;
    }

    if (s.ui.revisionOpInFlight) return result;
    if (selectActivePending(s).some((p) => p.id === open.revisionId)) return result;
    store.dispatch(uiActions.setOpenRevision(null));
    if (preview && preview.bookId === active && preview.previewChapterId === open.chapterId) {
      store.dispatch(uiActions.setPreviewRegen(null));
      store.dispatch(notificationsActions.pushToast({ kind: 'info', message: 'This preview was resolved elsewhere', dedupeKey: 'preview-resolved-elsewhere' }));
    }
    return result;
  };
  ```
  Wire into `src/store/index.ts`'s `.concat(…)` after `persistenceMiddleware`.

- [ ] **Step 3: Green.** The test file, `typecheck`, and `npm --prefix <wt> run test:e2e -- e2e/profile-regen-preview.spec.ts --repeat-each=3` (transitional window, Global Constraints — the watcher is wired into the store here).
- [ ] **Step 4: Mutations.**
  1. Drop the `s.ui.revisionOpInFlight` check → red: `does not fire during the user's own op`.
  2. Drop `&& preview.previewChapterId === open.chapterId` → red: `a vanishing entry unrelated to the preview … keeps the preview`.
  3. Delete the whole `if (open.kind === 'preview-stub') { … }` block → red: `a poll on the stub's own book never closes it`. The stub kind falls through to rule 3; it has no `revisionId`, so the `some` check fails and the player closes.
  4. In that block, test `!s.ui.previewRegen?.stub` instead of `!selectActivePreviewStub(s)` → red: `OD28 — navigating to another book hides an open stub player…` (the stub still exists, so the player stays open on book B).
  5. Delete the whole rule-1 block (`if (preview?.stub && preview.bookId === active) { … }`) → red: both `#11 — …` tests and `OD30 — a stub opened while the cache already holds an entry…` (the player stays on the stub; `stub` is still set).
  6. In rule 1, keep `completed` as it was (drop `stubFallback: false`) → red: both `#11 — …` tests, at the `completed` assertion (`stubFallback` is still `true`).
- [ ] **Step 5: Commit.** `feat(frontend): close, hide or switch the A/B player as its entry or stub changes (#3400)`.

---

### Task 22: Layout — the A/B player routes `server` and `preview-stub` entries

**Character:** judgment.

**Files:**
- Modify: `src/components/layout.tsx` — the Status pill's three revision counts: `showStatus`'s `pending.length > 0` (`~:1694-1701`), `summarizeStatus`'s `pendingRevisionsCount` (`~:1708`, which `top-bar.tsx`'s `summarizeStatus` turns into the pill's "Revisions · N", `~:195`), and `statusDetail`'s `pendingRevisionsCount` and `onOpenRevisions` (`~:1730-1731`); the regenerate-character preview branch (`~:2057-2083` → `startPreviewRegen`), the player block (`~:2474-2568`), and two new top-level hooks (see Interfaces). (The `pending` selector already moved to `selectActivePending` in Task 18.)
- Modify: `src/components/revision-timeline-modal.tsx` (`useAppSelector((s) => s.revisions.timeline)` → `useAppSelector(selectActiveTimeline)`).
- Modify: `src/store/generation-stream-middleware.ts` — **transitional** (Task 24 replaces it): in its `revisions/markRevisionPlayable` block, stop `enqueuePending`ing the stub; instead dispatch the single action `uiActions.openPreviewStub(buildPendingRevisionStub({ chapter, character, playable: true }))` (Task 13 — one action, never `setPreviewRegen` + `setOpenRevision`, OD30). So the existing preview e2e opens the stub through the stub handlers below, and Approve fans out via `approvePreviewSideEffects`.
- Tests: `layout.test.tsx`, `src/components/revision-timeline-modal.test.tsx`, and `src/store/generation-stream-middleware.test.ts` (its two `showRevisionPlayer` assertions at `~:444`/`~:455` pin behaviour this task changes, so they move here; the other `showRevisionPlayer` references — pure field deletions — are Task 23's).
- `showRevisionPlayer` / `setShowRevisionPlayer` **stay in `ui-slice.ts` in this task** (unused by the layout after it); Task 23 deletes them.

**Interfaces:**
- `pending` is `useAppSelector(selectActivePending)` since Task 18.
- **Hooks at the component's top level, never inside the conditional player render** (the player block `~:2474` is a `{cond && <RevisionDiffPlayer …/>}` expression; a hook inside it would change the hook order whenever it mounts — React's rules of hooks). Declare, beside the other `useAppSelector` calls near `~:195`:
  ```ts
  const openRevision = useAppSelector((s) => s.ui.openRevision);
  const shownRevision = useAppSelector((s): Revision | undefined => {
    const open = s.ui.openRevision;
    if (open?.kind === 'server') return selectActivePending(s).find((p) => p.id === open.revisionId);
    /* Pass 3 #1 — only the active book's stub; a stub for another book never renders. */
    if (open?.kind === 'preview-stub') return selectActivePreviewStub(s);
    return undefined;
  });
  const shownRendering = useAppSelector((s) =>
    bookId && shownRevision ? selectChapterRendering(s, bookId, shownRevision.chapterId) : false);
  ```
- **Status pill and popover (OD28; pass 4 #6).** The stub stays reachable from the popover without entering the cache (Invariant 6): `const previewStub = useAppSelector(selectActivePreviewStub);` beside the other selectors, and `const revisionsCount = pending.length + (previewStub ? 1 : 0);` above `showStatus`. Every one of the three places that counts revisions uses `revisionsCount`, never `pending.length`, or a stub-only state has no pill to click:
  - `showStatus`: `… || revisionsCount > 0` (replacing `pending.length > 0`), so the pill renders even with no TTS control, no other pill and an empty cache;
  - `summarizeStatus({ …, pendingRevisionsCount: revisionsCount, … })`, so the pill reads "Revisions · 1";
  - `statusDetail.pendingRevisionsCount: revisionsCount`;
  - `onOpenRevisions: () => { const recorded = previewRegen && previewRegen.bookId === bookId ? pending.find((p) => p.chapterId === previewRegen.previewChapterId) : undefined; if (recorded) { dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: recorded.id, chapterId: recorded.chapterId })); return; } if (previewStub) { dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' })); return; } const first = pending[0]; if (first) dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: first.id, chapterId: first.chapterId })); }`.

  The active book's preview comes first, because it is the take the user was just reviewing and closing it must not bury it behind older takes. That is the preview's own recorded entry for its chapter when it has one, else its stub; otherwise this is `pending[0]` (OD15, amended by OD28 and by the PR #3594 review pass 1).
- Shown revision: `shownRevision` (above; called `shown` below). Mode `'preview'` iff `ui.previewRegen && ui.previewRegen.bookId === bookId && ui.previewRegen.previewChapterId === shown.chapterId`.
- Player props: `busy={ui.revisionOpInFlight}`, `rendering={shownRendering}`, `previousMissing={previousMissingFor === shown.id}` (local `useState<string | null>`), `onKeepNew` (server kind) → `acceptRevisionOp({ bookId, revisionId, chapterId })`, `onClose` → `setOpenRevision(null)`.
- Server kind: `onAccept(selection)` → capture `const preview = ui.previewRegen;` → `const out = await dispatch(acceptRevisionOp({ bookId, revisionId: shown.id, chapterId: shown.chapterId, selection }));` → `if (out.ok && preview && preview.bookId === bookId && preview.previewChapterId === shown.chapterId) await dispatch(approvePreviewSideEffects(preview));`. `onReject()` → `const out = await dispatch(rejectRevisionOp({ bookId, revisionId: shown.id, chapterId: shown.chapterId }));` → `if (out.ok && ui.previewRegen?.bookId === bookId && ui.previewRegen.previewChapterId === shown.chapterId) dispatch(uiActions.setPreviewRegen(null));` → `if (!out.ok && out.code === 'no_previous_audio') setPreviousMissingFor(shown.id);`.
- Stub kind: Approve → `await dispatch(approvePreviewSideEffects(preview)); dispatch(uiActions.setOpenRevision(null));` — no revisions call. Reject → `void dispatch(restoreUnrecordedPreview(preview))`. (Preview mode: no Keep new take.)
- Preview start: replace the inline `setPreviewRegen` + `enqueueQueueEntries` with `void dispatch(startPreviewRegen({ bookId, characterId, characterName: regenCharacter?.name ?? characterId, chapterIds, reason, note }))`.

- [ ] **Step 1: Failing tests.**
  (a) `layout.test.tsx` — add `acceptRevision`, `rejectRevision`, `restorePreviousUnrecorded`, `getChapterAudioPrevious` to the file's `vi.mock('../lib/api')` factory as `(...a) => acceptRevisionMock(...a)` etc. (declare the `vi.fn()`s beside `getBookStateMock`). The file's `makeStore()` (`~:193`) installs **no** middleware, so the player watcher (Task 21) — the thing that would fire a "resolved elsewhere" toast — is absent from every layout test, and a no-toast assertion there is vacuous. Give it an optional parameter, leaving every existing caller unchanged: `function makeStore(extraMiddleware: Middleware[] = [])` with `middleware: (getDefault) => getDefault().concat(...extraMiddleware)` (import `type Middleware` from `@reduxjs/toolkit` and `revisionPlayerMiddleware` from `../store/revision-player-middleware`). Then:
  ```ts
  describe('Layout — A/B player routing (plan 286)', () => {
    const entry = (id: string, ch: number, triggeredBy: string, extra = {}) => ({ id, chapterId: ch, characterId: 'eliza', triggeredBy, segments: [], playable: true, hasPreviousAudio: true, ...extra });
    const S = (ids: ReturnType<typeof entry>[], rev = 1) => ({ bookId: 'b1', fileId: F1, rev, pending: ids, dismissed: [], acceptedSelections: {}, timeline: {} });
    async function mounted(pending: ReturnType<typeof entry>[], middleware: Middleware[] = [revisionPlayerMiddleware]) {
      getBookStateMock.mockResolvedValue(null);
      pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
      getChapterAudioPreviousMock.mockResolvedValue(null);
      const store = makeStore(middleware); // the production watcher by default, so toast assertions can fail
      openAt(store, 'b1');
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalled());
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // let the null hydrate land first
      act(() => { store.dispatch(revisionsActions.applyServerState(S(pending))); });
      return store;
    }

    it('D6 — the player opens the requested entry, not pending[0]', async () => {
      const store = await mounted([entry('r-a', 3, 'Ay change'), entry('r-b', 5, 'Bee change')]);
      act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-b', chapterId: 5 })); });
      const player = await screen.findByTestId('revision-diff-player');
      expect(within(player).getByText('Bee change')).toBeInTheDocument();
      expect(within(player).queryByText('Ay change')).toBeNull();
    });
    it('Commit selection accepts through the route and closes on success', async () => {
      acceptRevisionMock.mockResolvedValueOnce(S([], 2));
      const store = await mounted([entry('r-a', 3, 'Ay change')]);
      act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 })); });
      fireEvent.click(await screen.findByRole('button', { name: /Commit selection/i }));
      await waitFor(() => expect(screen.queryByTestId('revision-diff-player')).toBeNull());
      expect(acceptRevisionMock).toHaveBeenCalledTimes(1);
      expect(acceptRevisionMock.mock.calls[0][0]).toEqual({ bookId: 'b1', revisionId: 'r-a', selection: {} });
      expect(store.getState().ui.openRevision).toBeNull();
    });
    it('a double-click on Commit selection sends one request', async () => {
      let release!: (v: unknown) => void;
      acceptRevisionMock.mockReturnValueOnce(new Promise((r) => (release = r)));
      const store = await mounted([entry('r-a', 3, 'Ay change')]);
      act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 })); });
      const btn = await screen.findByRole('button', { name: /Commit selection/i });
      fireEvent.click(btn); fireEvent.click(btn);
      expect(acceptRevisionMock).toHaveBeenCalledTimes(1);
      await act(async () => { release(S([], 2)); });
    });
    it('a preview Approve fans out only after the accept succeeded', async () => {
      const store = await mounted([entry('r-a', 3, 'Ay change')]);
      act(() => {
        store.dispatch(castActions.hydrateCharacters([{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' } as never]));
        store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '' }));
        store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 }));
      });
      acceptRevisionMock.mockRejectedValueOnce(new RevisionOpFailure('gone', 409, 'revision_gone', S([], 2)));
      fireEvent.click(await screen.findByRole('button', { name: /Approve.*regenerate the rest/i }));
      await waitFor(() => expect(acceptRevisionMock).toHaveBeenCalled());
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(false);
    });
    it('a successful preview Approve logs the regenerate, and the watcher fires no "resolved elsewhere" toast', async () => {
      acceptRevisionMock.mockResolvedValueOnce(S([], 2));
      const store = await mounted([entry('r-a', 3, 'Ay change')]);
      act(() => {
        store.dispatch(castActions.hydrateCharacters([{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' } as never]));
        store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '' }));
        store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 }));
      });
      fireEvent.click(await screen.findByRole('button', { name: /Approve.*regenerate the rest/i }));
      await waitFor(() => expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(true));
      expect(store.getState().ui.previewRegen).toBeNull();
      /* Non-vacuous only because `mounted` installs revisionPlayerMiddleware and a
         preview IS tied to chapter 3: the entry leaves the cache on this accept, and
         only revisionOpInFlight keeps the watcher from treating it as resolved
         elsewhere (mutation 5). */
      expect(store.getState().notifications.toasts.map((t) => t.message)).not.toContain('This preview was resolved elsewhere');
    });
    it('a legacy entry (no origin) opens as a server entry and is accepted through the route', async () => {
      acceptRevisionMock.mockResolvedValueOnce(S([], 2));
      const store = await mounted([entry('revision:3:eliza', 3, 'Legacy take')]);
      act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'revision:3:eliza', chapterId: 3 })); });
      fireEvent.click(await screen.findByRole('button', { name: /Commit selection/i }));
      await waitFor(() => expect(acceptRevisionMock).toHaveBeenCalledWith({ bookId: 'b1', revisionId: 'revision:3:eliza', selection: {} }));
    });
    it('a reject answering no_previous_audio switches the footer to Keep new take', async () => {
      rejectRevisionMock.mockRejectedValueOnce(new RevisionOpFailure('x', 409, 'no_previous_audio', S([entry('r-a', 3, 'Ay change')])));
      const store = await mounted([entry('r-a', 3, 'Ay change')]);
      act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 })); });
      fireEvent.click(await screen.findByRole('button', { name: /Reject draft/i }));
      expect(await screen.findByRole('button', { name: /Keep new take/i })).toBeInTheDocument();
    });
    it('stub Approve fans out and makes no revisions call', async () => {
      const store = await mounted([]);
      act(() => {
        store.dispatch(castActions.hydrateCharacters([{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' } as never]));
        store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
          stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: false }) }));
        store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      });
      fireEvent.click(await screen.findByRole('button', { name: /Approve.*regenerate the rest/i }));
      await waitFor(() => expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(true));
      expect(acceptRevisionMock).not.toHaveBeenCalled();
      expect(restorePreviousUnrecordedMock).not.toHaveBeenCalled();
    });
    it('stub Reject with preserved audio calls restore-unrecorded', async () => {
      restorePreviousUnrecordedMock.mockResolvedValueOnce('restored');
      const store = await mounted([]);
      act(() => {
        store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
          stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: true }) }));
        store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      });
      fireEvent.click(await screen.findByRole('button', { name: /Reject.*re-adjust/i }));
      await waitFor(() => expect(restorePreviousUnrecordedMock).toHaveBeenCalledWith({ bookId: 'b1', chapterId: 3 }));
      await waitFor(() => expect(store.getState().ui.previewRegen).toBeNull());
    });
    it('#1 — a preview stub for another book never renders, even with openRevision set', async () => {
      /* No watcher here: this pins the layout's own gate, not the watcher's hide rule (Task 21). */
      const store = await mounted([], []);
      act(() => {
        store.dispatch(uiActions.setPreviewRegen({ bookId: 'b2', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
          stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: true }) }));
        store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(screen.queryByTestId('revision-diff-player')).toBeNull();
      expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:3:eliza'); // hidden, not cleared
    });
    it('OD28 — closing a stub player only hides it; with nothing else pending and no engine pinned, the Status pill still counts and re-opens it', async () => {
      const store = await mounted([]);
      /* Pass 4 #6 — a STUB-ONLY state: no cache entry, and no TTS control to keep
         the pill up. The FRONTEND_ACCOUNT_DEFAULTS key is 'kokoro-v1', and any key
         (Gemini included) puts its engine into enginesToShow on a ready stage, so
         only an unset key leaves showTtsControls false (selectDefaultTtsEngine:
         "null when no default key has hydrated yet"). */
      act(() => { store.dispatch(accountSlice.actions.setDefaultTtsModelKey(null as never)); });
      /* Precondition: nothing else shows the pill, so only the stub can bring it
         back. If this fails, neutralise whatever else shows it in THIS test;
         never drop the precondition — without it the test cannot fail. */
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(screen.queryByTestId('status-pill')).toBeNull();
      act(() => {
        store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
          stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: true }), completed: { reviewOutcome: 'none', stubFallback: true } }));
        store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      });
      await screen.findByTestId('revision-diff-player');
      act(() => { store.dispatch(uiActions.setOpenRevision(null)); }); // exactly what the player's back-arrow onClose dispatches
      await waitFor(() => expect(screen.queryByTestId('revision-diff-player')).toBeNull());
      expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:3:eliza');
      const pill = await screen.findByTestId('status-pill');
      expect(pill).toHaveAttribute('aria-label', 'Status — Revisions 1'); // top-bar.tsx summarizeStatus: label 'Revisions', detail '1'
      fireEvent.click(pill);
      const section = await screen.findByTestId('status-popover-revisions');
      fireEvent.click(within(section).getByRole('button', { name: /1 revision pending · Open/ }));
      expect(await screen.findByTestId('revision-diff-player')).toBeInTheDocument();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
    });
  });
  ```
  (Import `RevisionOpFailure`, `castActions`, `accountSlice` (the file already imports it for its Export-pill test, `~:1658`), and `selectActivePreviewStub` in `layout.tsx` from `../store/ui-slice`. The player's back-arrow and X buttons carry no accessible name (`revision-diff.tsx ~:202`, `~:232`), so the OD28 test dispatches `onClose`'s action directly instead of clicking them. `changeLog.events[].type` — confirm the field name in `change-log-slice.ts`; `buildCharacterRegenEvent` produces `type: 'regenerate'` per `profile-regen-preview.spec.ts`.)
  (b) `revision-timeline-modal.test.tsx`:
  The file's `makeStore(timeline)` builds a store with only the `revisions` reducer and `bookId: null`, so every existing test would read empty through the new selector. Change it to also mount `ui` and put the cache on the active book:
  ```ts
  function makeStore(timeline: Record<number, TimelineEntry[]>, cacheBook = 'b1', activeBook = 'b1') {
    const store = configureStore({ reducer: { revisions: revisionsSlice.reducer, ui: uiSlice.reducer } });
    store.dispatch(uiActions.openBook({ id: activeBook, status: 'complete' } as never));
    store.dispatch(revisionsActions.applyServerState({ bookId: cacheBook, fileId: '000000000000001-a', rev: 1, pending: [], dismissed: [], acceptedSelections: {}, timeline }));
    return store;
  }
  ```
  (this also drops its hand-built `preloadedState`, which would otherwise need `hydratedFor`/`windowActions` until Task 26), then add:
  ```ts
  it('plan 286 — shows the empty state for a cached book that is not the active book', () => {
    const store = makeStore({ 3: [{ id: 't', chapterId: 3, eventKind: 'accepted', timestamp: '2026-01-01T00:00:00Z', status: 'active' }] }, 'X', 'Y');
    render(<Provider store={store}><RevisionTimelineModal chapterId={null} chapterTitle={undefined} characters={[halloran]} onClose={() => undefined} /></Provider>);
    expect(screen.getByTestId('revision-timeline-empty')).toBeInTheDocument();
  });
  ```
  (c) `generation-stream-middleware.test.ts`: `expect(store.getState().ui.showRevisionPlayer).toBe(true)` (`~:444`) → `expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' })`, its stub assertion moves from `revisions.pending` to `ui.previewRegen.stub`, and the `~:455` `showRevisionPlayer` `false` expectation → `expect(store.getState().ui.openRevision).toBeNull()`.
  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces. Remove the inline accept/reject bodies, the `api.acceptChapterRevision` / `api.rejectChapterRevision` calls, and the inline fan-out block.
- [ ] **Step 3: Green.** `layout.test.tsx`, `revision-timeline-modal.test.tsx`, `generation-stream-middleware.test.ts`, `typecheck`, `npx --prefix <wt> eslint src/components/layout.tsx` (`react-hooks/rules-of-hooks` must be clean); e2e `revision-diff.spec.ts profile-regen-preview.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Open `pending[0]` regardless of `openRevision.revisionId` → red: `D6 — the player opens the requested entry…`.
  2. Run `approvePreviewSideEffects` before awaiting the accept thunk → red: `a preview Approve fans out only after the accept succeeded`.
  3. Make stub Approve dispatch `acceptRevisionOp` → red: `stub Approve fans out and makes no revisions call`.
  4. Drop `busy={ui.revisionOpInFlight}` → red: `a double-click on Commit selection sends one request`.
  5. In `revisions-thunks.ts` `runOp`, clear in-flight **before** applying the response (`const state = await call(); dispatch(uiActions.setRevisionOpInFlight(false)); applyIfActive(state);`) → red: `a successful preview Approve logs the regenerate, and the watcher fires no "resolved elsewhere" toast` (with the watcher installed, the entry leaves the cache while no op is in flight and the preview is tied to it). Restore.
  6. In `shownRevision`, return `s.ui.previewRegen?.stub` for the stub kind (bypass `selectActivePreviewStub`) → red: `#1 — a preview stub for another book never renders…` (the player renders `b2`'s stub on `b1`).
  7. `statusDetail.pendingRevisionsCount: pending.length` (keep `revisionsCount` elsewhere) → red: `OD28 — closing a stub player only hides it…` (the popover says "No pending revisions.", so the button lookup throws).
  8. Drop the `if (previewStub) { … }` branch from `onOpenRevisions` → red: the same test (the button opens nothing, because `pending` is empty).
  9. `showStatus`'s last term back to `pending.length > 0` → red: the same test, at `findByTestId('status-pill')` (no pill renders: no TTS control, no other pill, empty cache). This is the pass 4 #6 gap; the old test pinned `kokoro-v1`, which kept the pill up through `showTtsControls` and hid it.
  10. `summarizeStatus`'s `pendingRevisionsCount: pending.length` → red: the same test, at the pill's `aria-label` (`Status — Status` instead of `Status — Revisions 1`).
- [ ] **Step 5: Commit.** `fix(frontend): open the requested A/B entry and confirm accept/reject with the server (D1, D6) (#3400)`.

---

### Task 23: UI slice — delete `showRevisionPlayer` (mechanical follow-on to Task 22)

**Character:** mechanical.

**Why:** Task 22 made `ui.openRevision` the only thing that opens the A/B player, leaving `showRevisionPlayer` / `setShowRevisionPlayer` unused. Their deletion touches four unrelated test files, so it is split out of Task 22 to keep that diff behavioural.

**Files:**
- Modify: `src/store/ui-slice.ts` — delete the `showRevisionPlayer` field (with its doc comment), its initial value, and the `setShowRevisionPlayer` reducer.
- Tests (from `git -C <wt> grep -n showRevisionPlayer -- src e2e`; the `generation-stream-middleware.test.ts` assertions already moved in Task 22):
  - `src/components/theme-toggle.test.tsx` (`~:35`), `src/lib/use-theme.test.tsx` (`~:36`), `src/store/ui-slice.test.ts` (`baseState`, `~:20`): delete the `showRevisionPlayer: false,` line from each hand-built `UiState` (they already carry `openRevision`/`revisionOpInFlight` since Task 13).
  - `src/store/persist-config.test.ts` (`~:48`): delete the `'showRevisionPlayer'` entry from `transientKeys` (typed `keyof` the initial state, so it stops compiling once the field is gone).

- [ ] **Step 1: Failing test** — in `ui-slice.test.ts`:
  ```ts
  it('plan 286 — showRevisionPlayer is gone; openRevision replaced it', () => {
    const s = uiSlice.reducer(undefined, { type: '@@init' });
    expect(s).not.toHaveProperty('showRevisionPlayer');
    expect('setShowRevisionPlayer' in uiActions).toBe(false);
  });
  ```
  Run: `npm --prefix <wt> run test -- src/store/ui-slice.test.ts --retry=0` → FAIL (the field and the action still exist).

- [ ] **Step 2: Implement** per Files. Check, in two parts (pass 4 #3 — Step 1's guard test names the deleted field and action on purpose):
  - `git -C <wt> grep -n "showRevisionPlayer\|setShowRevisionPlayer" -- src e2e ':!src/store/ui-slice.test.ts'` → no hits.
  - `git -C <wt> grep -n "showRevisionPlayer\|setShowRevisionPlayer" -- src/store/ui-slice.test.ts` → **exactly three hits**, all in Step 1's guard test: its title (`showRevisionPlayer is gone; openRevision replaced it`), `expect(s).not.toHaveProperty('showRevisionPlayer');` and `expect('setShowRevisionPlayer' in uiActions).toBe(false);`. A fourth hit is the `baseState` line this task deletes.

- [ ] **Step 3: Green.** `npm --prefix <wt> run test -- src/store/ui-slice.test.ts src/store/persist-config.test.ts src/components/theme-toggle.test.tsx src/lib/use-theme.test.tsx`, `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Re-add `showRevisionPlayer: false` to the initial state (and the interface) → red: `showRevisionPlayer is gone; openRevision replaced it`.

- [ ] **Step 5: Commit.** `refactor(frontend): delete showRevisionPlayer, superseded by openRevision (#3400)`.

---

### Task 24: Generation preview — `previewChapterComplete`, refetch-or-stub, re-open on arrival (OD27, OD28, OD29)

**Character:** judgment.

**Files:**
- Modify: `src/store/generation-stream-runner.ts` (`chapter_complete` branch of `handleTickFor`, `~:401-419`; `StreamRunnerStore.getState` type `~:85-88`).
- Modify: `src/store/generation-stream-middleware.ts` (replace Task 22's transitional `revisions/markRevisionPlayable` block).
- Rename: `src/lib/build-pending-revision.ts` → `src/lib/build-preview-stub.ts` (`buildPendingRevisionStub` → `buildPreviewStub`); correct the stale docstring (`hasPreviousAudio` comes from the metadata check now, `:8-12`, `:49-51`).
- Modify: `e2e/profile-regen-preview.spec.ts` (remove the `rejectAllPending` workaround and its comment — the phantom revision is gone since Task 10).
- Modify: `e2e/marketing/scenes.ts` `generating-revision-diff` scene (`~:1041-1091`) — **moved here from Task 26**: this task removes the generation middleware's `revisions/markRevisionPlayable` block, which is what that scene's `markRevisionPlayable` dispatch (`~:1087`) relies on to open the player, so the scene breaks in this commit, not later. Delete its `rejectAllPending` dispatch (`~:1060`) and replace the `markRevisionPlayable` dispatch with, after the existing `chapters/applyGenerationTick` dispatch:
  ```ts
  (window as unknown as { __mockRevisions?: { seed: (b: string, s: unknown) => void } }).__mockRevisions?.seed('hollow-tide-2', { previousChapterIds: [chapterId], liveChapterIds: [chapterId] });
  s?.dispatch({ type: 'chapters/previewChapterComplete', payload: { bookId: 'hollow-tide-2', chapterId, reviewOutcome: 'failed' } });
  ```
  `'failed'` (a preserved take, no recorded entry) takes the stub path without a refetch. Seeding `previousChapterIds` makes the stub's metadata check succeed, so the A card shows the preserved take, not "Original audio not preserved". Rewrite the scene's comments (`~:1012`, `~:1037` name `revisions/markRevisionPlayable`): the stream is dead under `DEMO_CAPTURE`, so the scene stands in for the completion tick with `previewChapterComplete` (stub path).
- Tests: `generation-stream-runner.test.ts`, `generation-stream-middleware.test.ts`, and the builder's test if one exists (rename with it).
  - **Delete** `generation-stream-runner.test.ts`'s `describe('generation-stream-runner — markRevisionPlayable guards on revisions.bookId (#3395 pass 2, N2)')` (`~:550-597`, both tests; list them in the commit body). It pins the runner's `markRevisionPlayable` dispatch, which this task removes: its second test (`flips a pending revision playable when revisions.bookId matches the stream…`) goes red here, and both seed through `hydrateFromBookState`, which Task 26 deletes. Its concern — a completion for the book the user left landing in the book they moved to, because chapter ids repeat — is now carried by `previewChapterComplete`'s explicit `bookId` (`dispatches previewChapterComplete only for reviewChapter, for any book`), the middleware's `mine` / `onBook` split, and the A8 chapters gate (`A8 — an active completion waits for its own book's chapters`).
  - `generation-stream-middleware.test.ts`'s `makeStore` gains an optional watcher, for the OD30 integration describe below: `function makeStore(opts: { watcher?: boolean } = {})`, with `middleware: (gd) => gd().concat(...(opts.watcher ? [revisionPlayerMiddleware] : []), generationStreamMiddleware(getRunner))` — the watcher **before** the generation middleware, the same order as `src/store/index.ts` (Task 21 wires it right after `persistenceMiddleware`, which precedes `generationStreamMiddleware`). Every existing caller passes nothing and is unchanged. Import `revisionPlayerMiddleware` from `./revision-player-middleware`.

**Interfaces:**
- Runner: on `chapter_complete` with `ev.reviewChapter === true`, `dispatch(previewChapterComplete({ bookId, chapterId: ev.chapterId, reviewOutcome: ev.reviewOutcome }))` for **any** book. Remove the `markRevisionPlayable` dispatch and the `revisions` member of `StreamRunnerStore`'s state type. (OD12: no refetch on a plain `chapter_complete`.)
- `buildPreviewStub({ chapter, character, hasPreviousAudio, triggeredBy? }): Revision` — `playable: true`, id `revision:<ch>:<char>`, no `origin`.
- Middleware on `previewChapterComplete.match(action)` (after `next(action)`). Let `mine` be "`ui.previewRegen` is this preview" (its `bookId` and `previewChapterId` match the payload) and `onBook` be "the active book is the payload's `bookId`".
  1. `onBook && mine` → `armedFor = bookId`, **before** step 2. Step 2's dispatch re-enters this middleware, and that re-entry's fire check (below) opens the preview in the same pass, provided three things hold: the book's chapters are in (`chapters.currentBookId === bookId`, A8: chapter ids repeat across books), no player is open, and the preview is finished. Otherwise it stays armed and fires as soon as all three hold. Arming first means exactly one fire. If step 1 armed after step 2, an arm left over from an arrival would fire in the re-entry, step 1 would re-arm, and the outer pass would fire a second `openPreview`. This replaces pass 2's direct `void openPreview(...)` call, which read whatever book's chapters happened to be loaded.
  2. **OD28 — mark EVERY completion of this preview finished**, on its book or elsewhere: if `mine`, dispatch `setPreviewRegen({ ...preview, completed: { reviewOutcome, stubFallback: onBook } })`. `reviewOutcome` is the server's own word on what happened (Task 7). `stubFallback` matters only for a `'recorded'` completion whose refetch fails twice. Seen on its book, that still opens a stub, as the spec's OD23 requires. Finished elsewhere, the marker is kept for the next arrival instead.
  3. `!onBook` → info toast `Preview ready in ‹title›` (title from `library` books, fallback `bookId`), dedupe `preview-ready-<bookId>`. Stop.
  4. `onBook && !mine` (e.g. after a reload, which drops `previewRegen`) → nothing opens, exactly as today's `markRevisionPlayable` handler does without a matching `previewRegen`. A recorded take reaches the Status popover with the next poll (OD12).
- `openPreview` (the only path that opens a preview; every early return leaves `completed` set, so the preview stays re-openable — OD28):
  ```ts
  const PREVIEW_REFETCH_RETRY_MS = 1000; // OD23
  async function openPreview(
    dispatch: AppDispatch,
    getState: () => StreamableRootState,
    p: { bookId: string; chapterId: number; completed: PreviewRegenCtx['completed'] },
  ) {
    const reviewOutcome = p.completed?.reviewOutcome;
    const stubFallback = p.completed?.stubFallback ?? false;
    const isThisPreview = (s: StreamableRootState) =>
      s.ui.previewRegen?.bookId === p.bookId && s.ui.previewRegen.previewChapterId === p.chapterId;
    /* OD29 (Task 7) — 'none' (a first render: nothing to review) and 'failed'
       (preserved, but no entry recorded) have no server entry to look for: the
       stub is the legitimate player, so no refetch. Only 'recorded' (or an
       absent outcome) looks for the entry. */
    if (reviewOutcome !== 'none' && reviewOutcome !== 'failed') {
      let r = await dispatch(refetchActiveRevisions(p.bookId));
      if (r === 'failed') { await new Promise((res) => setTimeout(res, PREVIEW_REFETCH_RETRY_MS)); r = await dispatch(refetchActiveRevisions(p.bookId)); }
      /* OD28 — the user left the book during the refetch ('skipped', or 'ok'
         with the response not applied): leave the preview as it is; the next
         arrival re-opens it. Without this check an unapplied 'ok' would read
         the NEW book's empty cache below and drop the preview (OD29) wrongly. */
      if (r === 'skipped' || activeBookId(getState()) !== p.bookId) return;
      if (r === 'ok') {
        /* OD30 — matched by chapter alone, deliberately: any entry for the
           preview's chapter is the preview's player. */
        const entry = selectActivePending(getState()).find((e) => e.chapterId === p.chapterId);
        if (entry) {
          /* A1 (pass 4) — the refetch awaited: never replace a player the user
             opened meanwhile. `completed` stays set; the next arrival re-opens
             it. (The active book was re-checked just above.) */
          if (getState().ui.openRevision !== null) return;
          dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: entry.id, chapterId: entry.chapterId }));
          return;
        }
        if (isThisPreview(getState())) {
          /* OD29 — the server recorded an entry and no longer has it: resolved
             elsewhere (another tab, or a newer render dropped it). Never a stub:
             its Reject (restore-unrecorded) could put the preview take back over
             that newer render (finalize-chapter-write.ts ~:798). */
          dispatch(uiActions.setPreviewRegen(null));
          dispatch(notificationsActions.pushToast({ kind: 'info', message: 'This preview was resolved elsewhere', dedupeKey: 'preview-resolved-elsewhere' }));
        }
        return;
      }
      /* r === 'failed' twice (OD23). */
      if (!stubFallback) {
        console.warn('[preview] could not confirm the recorded take; it re-opens on the next visit to the book');
        return;
      }
    }
    const before = getState();
    /* A8 — only this book's chapter rows (the fire gate already waited for
       them; this guards the window after the refetch's await). */
    const chapter = before.chapters.currentBookId === p.bookId ? before.chapters.chapters.find((c) => c.id === p.chapterId) : undefined;
    const prev = chapter ? await api.getChapterAudioPrevious({ bookId: p.bookId, chapterId: p.chapterId, duration: chapter.duration }).catch(() => null) : null;
    const s = getState();
    const preview = s.ui.previewRegen;
    if (!preview || !isThisPreview(s)) return; // resolved or replaced meanwhile: nothing left to open
    /* A1 (pass 4) — the awaits above (refetch, retry, previous-audio GET) let
       the user open a player or move to another book. Opening now would
       replace that player, or (on another book) open a stub the watcher
       instantly hides, closing the player the user has open there. Keep the
       OD28 marker (`completed` stays set) and do not open: the next arrival
       at the preview's book re-opens it. */
    if (s.ui.openRevision !== null || activeBookId(s) !== p.bookId) return;
    const character = s.cast.characters.find((c) => c.id === preview.characterId);
    if (!chapter || !character) {
      /* OD28 — never strand it: `completed` stays set, so the next arrival
         retries once the chapters and cast are in. */
      console.warn('[preview] could not build the preview stub (chapter or character not loaded); it re-opens on the next visit to the book');
      return;
    }
    /* OD30 (pass 4) — ONE action sets the stub and opens it. Never
       setPreviewRegen(stub) + setOpenRevision: between those two dispatches the
       player watcher (Task 21) would drop the stub (rule 1, a cached entry for
       the chapter, no player open yet) and then hide the stub player (rule 2),
       so nothing would open. In one action the watcher sees the stub player
       open, and when the active cache already holds an entry for this chapter,
       rule 1 switches the player to that entry: an existing entry wins, for
       every reviewOutcome, and the preview stays in preview mode so Approve
       runs its fan-out (Task 22). */
    dispatch(uiActions.openPreviewStub(buildPreviewStub({ chapter, character, hasPreviousAudio: prev !== null })));
  }
  ```
  Extend `StreamableRootState` with `revisions: RevisionsState` and `library: { books: Array<{ bookId: string; title: string }> }` (check the library slice's shape: it may expose `books` directly or via `authors` — use what `layout.tsx`'s `library.books` uses). Import `activeBookId` and `refetchActiveRevisions` from `./revisions-thunks`, `selectActivePending` from `./revisions-slice`, `notificationsActions`, and `type PreviewRegenCtx`.
- **The fire check: re-open on arrival (OD27) and the deferred active open (OD28, A8).** A preview that finished while the user was elsewhere has no other way back if nothing was recorded: a stub lives only in `ui.previewRegen`, never in the cache. So on arrival at `previewRegen.bookId` the middleware re-runs `openPreview`, and step 1 above uses the same check for a completion on the book itself. It must wait for that book's chapters, because the stub needs the chapter row, and on arrival `chapters` may still hold the previous book until the per-book hydrate lands. So it arms first and fires once everything holds. **Arming and firing test different things.** Arming checks only that the user arrived at the preview's book. The fire check alone checks `completed`. Pass 2 tested `completed` in both places, which masked its mutation 8.
  ```ts
  /* OD27/OD28 — closure state, one per store. */
  let armedFor: string | null = null;
  // in the middleware body: capture `const activeBefore = activeBookId(getState());` before `next(action)`; then, after the completion handling above:
  const after = getState();
  const activeAfter = activeBookId(after);
  const pv = after.ui.previewRegen;
  if (activeBefore !== activeAfter) armedFor = pv && pv.bookId === activeAfter ? activeAfter : null; // arrival: arm, finished or not
  if (
    armedFor !== null && armedFor === activeAfter && pv?.bookId === armedFor
    && pv.completed !== undefined                  // finished (OD27/OD28) — the ONLY completed test
    && after.ui.openRevision === null              // never over a player the user has open
    && after.chapters.currentBookId === armedFor   // this book's chapter rows (A8)
  ) {
    armedFor = null; // once per arm; openPreview's own dispatches re-enter with it cleared
    void openPreview(dispatch, getState, { bookId: pv.bookId, chapterId: pv.previewChapterId, completed: pv.completed });
  }
  ```
  An unfinished preview armed on arrival fires once its completion lands (step 1 re-arms anyway). A blocked fire (a player open, chapters not in) stays armed and fires when the blocker clears. `completed` stays on the context, so every later arrival re-opens it until `previewRegen` is cleared: by Approve / Reject, by OD29's drop, or by a reset of its book (OD31, Task 26). Task 21's watcher swapping the stub for a server entry does **not** end it: the swap keeps `completed` (only setting `stubFallback: false`), so a later arrival runs `openPreview` again with the same `reviewOutcome` and, while that entry is still there, opens the entry again (directly after a `'recorded'` refetch; through `openPreviewStub` and rule 1 / OD30 otherwise). Leaving the book disarms it; the next arrival re-arms. A fire whose `openPreview` returns at the A1 guard (a player opened, or the book left, during its awaits) has consumed its arm: it re-opens on the next arrival, not when that player closes.
- Remove `revisionsActions` and the old builder import from the middleware; update its header comment item 3.

- [ ] **Step 1: Failing tests.**
  (a) `generation-stream-runner.test.ts`:
  ```ts
  describe('plan 286 — preview completion', () => {
    function recordingRunner() {
      const types: Array<{ type: string; payload?: unknown }> = [];
      const store = configureStore({
        reducer: { chapters: chaptersSlice.reducer, changeLog: changeLogSlice.reducer, revisions: revisionsSlice.reducer, notifications: notificationsSlice.reducer },
        middleware: (g) => g().concat(() => (next) => (a) => { types.push(a as { type: string; payload?: unknown }); return next(a); }),
      });
      return { store, runner: createStreamRunner(store), types };
    }
    it('dispatches previewChapterComplete only for reviewChapter, for any book', () => {
      const { store, runner, types } = recordingRunner();
      store.dispatch(chaptersSlice.actions.setCurrentBookId('viewed'));
      runner.open('other', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
      runner.open('other', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
      onTickFor('other', 1)({ type: 'chapter_complete', chapterId: 1, reviewChapter: true, reviewOutcome: 'recorded' } as GenerationTick);
      onTickFor('other', 2)({ type: 'chapter_complete', chapterId: 2 } as GenerationTick);
      const previews = types.filter((t) => t.type === 'chapters/previewChapterComplete');
      expect(previews.map((t) => t.payload)).toEqual([{ bookId: 'other', chapterId: 1, reviewOutcome: 'recorded' }]);
    });
    it('never dispatches revisions/markRevisionPlayable', () => {
      const { store, runner, types } = recordingRunner();
      store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
      runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
      onTickFor('b1', 1)({ type: 'chapter_complete', chapterId: 1 } as GenerationTick);
      expect(types.some((t) => t.type === 'revisions/markRevisionPlayable')).toBe(false);
    });
  });
  ```
  (b) `generation-stream-middleware.test.ts` — add `notifications`, `library` reducers to `makeStore` (and its optional `watcher`, per Files), `pollRevisions` and `getChapterAudioPrevious` to its `vi.mock('../lib/api')` factory (`pollRevisionsMock`, `getChapterAudioPreviousMock` declared with `vi.hoisted`), `afterEach` to its vitest import, and replace the two Task 22-adapted `markRevisionPlayable` tests with:
  ```ts
  describe('plan 286 — previewChapterComplete', () => {
    const F = '000000000000001-a';
    const PREVIEW = { bookId: 'b1', characterId: 'marlow', previewChapterId: 3, remainingChapterIds: [4], reason: 'voice', note: '' };
    function seedPreview(store: ReturnType<typeof makeStore>['store']) {
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
      store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
      store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
      store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'marlow', name: 'Marlow' } as never]));
      store.dispatch(uiSlice.actions.setPreviewRegen(PREVIEW));
    }
    const recorded = (id = 'revision:3:1700') => ({ bookId: 'b1', fileId: F, rev: 1, pending: [{ id, chapterId: 3, characterId: 'marlow', segments: [], origin: 'server' }], dismissed: [], acceptedSelections: {}, timeline: {}, drift: [] });
    const empty = () => ({ bookId: 'b1', fileId: F, rev: 1, pending: [], dismissed: [], acceptedSelections: {}, timeline: {}, drift: [] });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const toasts = (store: ReturnType<typeof makeStore>['store']) => store.getState().notifications.toasts.map((t) => t.message);
    beforeEach(() => { pollRevisionsMock.mockReset(); getChapterAudioPreviousMock.mockReset(); });
    afterEach(() => vi.useRealTimers());

    it('active book + recorded entry → refetch, then open that server entry', async () => {
      const { store } = makeStore(); seedPreview(store);
      pollRevisionsMock.mockResolvedValueOnce(recorded());
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
      expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
    });
    it('a completion on the book while an arrival arm is pending opens it once (one refetch)', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival arms; the preview has not finished
      pollRevisionsMock.mockResolvedValue(recorded());
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
      await tick();
      expect(pollRevisionsMock).toHaveBeenCalledTimes(1);
    });
    it("'failed' (preserved, unrecorded) → no refetch; previous metadata decides the stub", async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockResolvedValueOnce({ url: 'blob:a', durationSec: 1, peaks: [], sampleRate: 1, segments: [] });
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'failed' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(pollRevisionsMock).not.toHaveBeenCalled();
      expect(store.getState().ui.previewRegen?.stub).toMatchObject({ chapterId: 3, hasPreviousAudio: true, playable: true });
    });
    it("'none' (a first render) → no refetch, a stub with no kept take", async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockResolvedValueOnce(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(pollRevisionsMock).not.toHaveBeenCalled();
      expect(store.getState().ui.previewRegen?.stub?.hasPreviousAudio).toBe(false);
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    });
    it("OD29 — 'recorded' on its own book, but the refetch finds no entry → dropped as resolved elsewhere, never a stub", async () => {
      const { store } = makeStore(); seedPreview(store);
      pollRevisionsMock.mockResolvedValueOnce(empty());
      getChapterAudioPreviousMock.mockResolvedValue(null); // a stub, if one were (wrongly) built, would open cleanly
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      await vi.waitFor(() => expect(store.getState().ui.previewRegen).toBeNull());
      expect(store.getState().ui.openRevision).toBeNull();
      expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
      expect(toasts(store)).toEqual(['This preview was resolved elsewhere']);
    });
    it('a failed refetch does not open a stub straight away; the retry succeeding opens the entry', async () => {
      vi.useFakeTimers();
      const { store } = makeStore(); seedPreview(store);
      pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(recorded());
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().ui.openRevision).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
    });
    it('a doubly-failed refetch still opens the stub', async () => {
      vi.useFakeTimers();
      const { store } = makeStore(); seedPreview(store);
      pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('y'));
      getChapterAudioPreviousMock.mockResolvedValueOnce(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().ui.openRevision).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(store.getState().revisions.pending).toEqual([]);
    });
    it('a previous-metadata GET that throws → stub with hasPreviousAudio:false', async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockRejectedValueOnce(new Error('500'));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'failed' }));
      await vi.waitFor(() => expect(store.getState().ui.previewRegen?.stub?.hasPreviousAudio).toBe(false));
    });
    it('a non-active book → "Preview ready in ‹title›" toast and nothing opens', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(librarySlice.actions.hydrate({ authors: [{ name: 'A', series: [{ name: 'S', books: [{ bookId: 'other', title: 'Other Book' }] }] }] } as never));
      store.dispatch(previewChapterComplete({ bookId: 'other', chapterId: 3, reviewOutcome: 'recorded' }));
      expect(toasts(store)).toEqual(['Preview ready in Other Book']);
      expect(store.getState().ui.openRevision).toBeNull();
      expect(pollRevisionsMock).not.toHaveBeenCalled();
    });
    it('OD27 — a non-active completion marks the matching preview finished', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: false });
      expect(store.getState().ui.openRevision).toBeNull();
    });
    it('OD28 — an active completion marks the preview finished too, so after a close the next arrival re-opens it', async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockResolvedValue(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
      store.dispatch(uiSlice.actions.setOpenRevision(null)); // the player's close
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(2);
    });
    it("OD27 — arriving back at the preview book re-opens a first render ('none') as a stub — never dropped", async () => {
      const { store } = makeStore(); seedPreview(store); // chapters.currentBookId is already 'b1'
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      getChapterAudioPreviousMock.mockResolvedValueOnce(null);
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(store.getState().ui.previewRegen?.stub).toMatchObject({ chapterId: 3, hasPreviousAudio: false });
    });
    it('OD27 — arriving back opens the recorded server entry when there is one', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      expect(pollRevisionsMock).not.toHaveBeenCalled(); // not on completion elsewhere
      pollRevisionsMock.mockResolvedValueOnce(recorded());
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
    });
    it("OD29 — arriving back after a 'recorded' completion elsewhere, with no entry now, drops the preview with one notice", async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      pollRevisionsMock.mockResolvedValueOnce(empty());
      getChapterAudioPreviousMock.mockResolvedValue(null); // a stub, if one were (wrongly) built, would open cleanly
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
      await vi.waitFor(() => expect(store.getState().ui.previewRegen).toBeNull());
      expect(store.getState().ui.openRevision).toBeNull();
      expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
      expect(toasts(store).filter((m) => m === 'This preview was resolved elsewhere')).toHaveLength(1);
    });
    it('OD28/OD29 — leaving the book while the arrival refetch is in flight leaves the preview re-openable', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      let release!: (v: unknown) => void;
      pollRevisionsMock.mockReturnValueOnce(new Promise((r) => (release = r)));
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival: the refetch starts
      await vi.waitFor(() => expect(pollRevisionsMock).toHaveBeenCalledTimes(1));
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' })); // leave before it lands
      release(empty());
      await tick();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: false });
      expect(toasts(store)).not.toContain('This preview was resolved elsewhere');
    });
    it("OD27 — the re-open waits for the arriving book's chapters", async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(chaptersSlice.actions.setCurrentBookId('b2'));
      store.dispatch(chaptersSlice.actions.setChapters([ch(9, { state: 'done', duration: '01:00' })])); // b2's chapters
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      getChapterAudioPreviousMock.mockResolvedValue(null);
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival; chapters still b2's
      await tick();
      expect(store.getState().ui.openRevision).toBeNull();
      /* b1's hydrate lands: rows first, then the book id the gate keys on (the
         real per-book hydrate sets both in one action). */
      store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
      store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    });
    it("A8 — an active completion waits for its own book's chapters (chapter ids repeat across books)", async () => {
      const { store } = makeStore(); seedPreview(store); // active b1
      store.dispatch(chaptersSlice.actions.setCurrentBookId('b2'));
      store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '09:00' })])); // ANOTHER book's chapter 3
      getChapterAudioPreviousMock.mockResolvedValue(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await tick();
      expect(store.getState().ui.openRevision).toBeNull();
      expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
      store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
      store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(getChapterAudioPreviousMock).toHaveBeenCalledWith({ bookId: 'b1', chapterId: 3, duration: '05:00' });
    });
    it('OD27 — no re-open on arrival without a finished preview', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // no completion happened
      await tick();
      expect(store.getState().ui.openRevision).toBeNull();
      expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
      expect(pollRevisionsMock).not.toHaveBeenCalled();
    });
    it('OD28 — never opens over a player the user has open; it opens once that player closes', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'r-x', chapterId: 5 }));
      getChapterAudioPreviousMock.mockResolvedValue(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await tick();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r-x', chapterId: 5 });
      expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
      store.dispatch(uiSlice.actions.setOpenRevision(null)); // the user closes it
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    });
    it('OD28 — a stub that cannot be built yet (character not loaded) leaves the preview re-openable', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(castSlice.actions.hydrateCharacters([]));
      getChapterAudioPreviousMock.mockResolvedValue(null);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalled());
      await tick();
      const warned = warn.mock.calls.length; // read before mockRestore, which clears mock.calls in vitest 5
      warn.mockRestore();
      expect(warned).toBeGreaterThan(0);
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
      store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'marlow', name: 'Marlow' } as never]));
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    });
    it('the stub never enters the revisions cache and survives a poll', async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockResolvedValueOnce(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      /* Asserted BEFORE the poll: a stub dispatched into the cache (mutation 4)
         would be wiped by the rev-9 poll's adoption below, masking it. */
      expect(store.getState().revisions.pending).toEqual([]);
      store.dispatch(revisionsSlice.actions.applyPoll({ ...empty(), rev: 9 }));
      expect(store.getState().revisions.pending).toEqual([]);
      expect(store.getState().ui.previewRegen?.stub).toBeDefined();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
    });
    /* A1 (pass 4) — openPreview re-checks after its awaits. Each test holds one
       await open with a manual promise, changes the state the guard reads, then
       releases it. */
    it('A1 — a player the user opens during the refetch window is not replaced', async () => {
      const { store } = makeStore(); seedPreview(store);
      let release!: (v: unknown) => void;
      pollRevisionsMock.mockReturnValueOnce(new Promise((r) => (release = r)));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      await vi.waitFor(() => expect(pollRevisionsMock).toHaveBeenCalledTimes(1));
      store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'r-x', chapterId: 5 })); // the user opens another take
      release(recorded()); // the refetch lands WITH an entry for chapter 3
      await tick();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r-x', chapterId: 5 });
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: true }); // the OD28 marker is kept
    });
    it('A1 — a player the user opens during the previous-audio GET is not replaced by the stub', async () => {
      const { store } = makeStore(); seedPreview(store);
      let release!: (v: unknown) => void;
      getChapterAudioPreviousMock.mockReturnValueOnce(new Promise((r) => (release = r)));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(1));
      store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'r-x', chapterId: 5 }));
      release(null);
      await tick();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r-x', chapterId: 5 });
      expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    });
    it('A1 — moving to book B during the GET builds no stub there; returning to the preview book re-opens it', async () => {
      const { store } = makeStore(); seedPreview(store);
      let release!: (v: unknown) => void;
      getChapterAudioPreviousMock.mockResolvedValue(null);
      getChapterAudioPreviousMock.mockReturnValueOnce(new Promise((r) => (release = r)));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(1));
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' })); // no player open on b2
      release(null);
      await tick();
      expect(store.getState().ui.openRevision).toBeNull();
      expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival: the kept marker re-opens it
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    });
  });

  /* OD30 (pass 4) — INTEGRATION: the generation middleware AND the player
     watcher in one store, in production order, with a non-empty cache for the
     preview's chapter. The unit stores above install no watcher, so they cannot
     see the race between the stub and its open (watcher rule 1 dropping the
     stub, rule 2 hiding its player); this describe exists for that. */
  describe('plan 286 — OD30: an existing entry for the chapter wins over the stub (generation middleware + watcher)', () => {
    const F = '000000000000001-a';
    const PREVIEW = { bookId: 'b1', characterId: 'marlow', previewChapterId: 3, remainingChapterIds: [4], reason: 'voice', note: '' };
    const cached = { bookId: 'b1', fileId: F, rev: 1, pending: [{ id: 'revision:3:1700', chapterId: 3, characterId: 'marlow', segments: [], origin: 'server' as const }], dismissed: [], acceptedSelections: {}, timeline: {}, drift: [] };
    function integratedStore() {
      const { store } = makeStore({ watcher: true });
      store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
      store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
      store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
      store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'marlow', name: 'Marlow' } as never]));
      store.dispatch(revisionsSlice.actions.applyPoll(cached)); // the active cache already holds an entry for chapter 3
      store.dispatch(uiSlice.actions.setPreviewRegen(PREVIEW));
      return store;
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const opensTheEntry = async (store: ReturnType<typeof integratedStore>, outcome: 'recorded' | 'none' | 'failed') => {
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
      const pv = store.getState().ui.previewRegen;
      expect(pv).toMatchObject({ bookId: 'b1', previewChapterId: 3 }); // still the preview: the layout opens it in preview mode, so Approve runs the fan-out (Task 22)
      expect(pv?.stub).toBeUndefined();
      expect(pv?.completed).toEqual({ reviewOutcome: outcome, stubFallback: false });
      expect(store.getState().notifications.toasts).toEqual([]);
    };
    beforeEach(() => { pollRevisionsMock.mockReset(); getChapterAudioPreviousMock.mockReset(); });
    afterEach(() => vi.useRealTimers());

    it.each(['none', 'failed'] as const)("'%s' with a cached entry for the chapter opens that entry, not a stub", async (outcome) => {
      const store = integratedStore();
      getChapterAudioPreviousMock.mockResolvedValue(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: outcome }));
      await opensTheEntry(store, outcome);
      expect(pollRevisionsMock).not.toHaveBeenCalled(); // OD29: no refetch for these outcomes; the CACHED entry won
    });
    it("'recorded' whose refetch fails twice, with a cached entry for the chapter, opens that entry, not a stub", async () => {
      vi.useFakeTimers();
      const store = integratedStore();
      pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('y'));
      getChapterAudioPreviousMock.mockResolvedValue(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
      await vi.advanceTimersByTimeAsync(1000);
      await opensTheEntry(store, 'recorded');
      expect(pollRevisionsMock).toHaveBeenCalledTimes(2);
    });
    it("A1 — moving to book B during the GET does not close the player the user opened on B", async () => {
      const store = integratedStore();
      let release!: (v: unknown) => void;
      getChapterAudioPreviousMock.mockReturnValueOnce(new Promise((r) => (release = r)));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
      await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(1));
      store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
      store.dispatch(revisionsSlice.actions.applyServerState({ bookId: 'b2', fileId: F, rev: 1, pending: [{ id: 'rB', chapterId: 2, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} }));
      store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'rB', chapterId: 2 })); // B's own player, which the watcher keeps (rB is cached)
      release(null);
      await tick();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'rB', chapterId: 2 });
      expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
      expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    });
  });
  ```
  (Confirm `librarySlice.actions.hydrate`'s payload shape against `LibraryResponse` and the selector the middleware uses for titles; adapt the literal.)
  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces; delete Task 22's transitional block.
- [ ] **Step 3: Green.** Runner + middleware tests, `typecheck`, e2e `profile-regen-preview.spec.ts` (`cc` chapter 1 has no live audio in the mock store → the render records nothing and the tick carries `reviewOutcome: 'none'` (Task 11) → no refetch (OD29: `'none'` never refetches) → stub with `hasPreviousAudio:false` → Approve fans out via the stub path; Reject drops the preview without a request); `npx --prefix <wt> eslint e2e/marketing/scenes.ts`. (The marketing scene runs only under the marketing harness — `.env.marketing`; if this lane cannot run that capture, say so in the report rather than claiming it green.)
- [ ] **Step 4: Mutations.** Each was traced against the test it names. Pass 3 found that pass 2's mutations 4 and 8 could not go red; both are restructured here.
  1. Remove the retry (open the stub on the first failure) → red: `a failed refetch does not open a stub straight away…`.
  2. Set `hasPreviousAudio: true` unconditionally in `buildPreviewStub`'s call → red: `'none' (a first render) → no refetch, a stub with no kept take` (`hasPreviousAudio` is `true`).
  3. Gate the runner dispatch on `sliceMatchesHandle` → red: `dispatches previewChapterComplete only for reviewChapter, for any book`.
  4. Dispatch the stub into the cache (`revisionsActions.applyServerState` with the stub added) → red: `the stub never enters the revisions cache…`, at the assertion **before** the poll. The rev-9 poll would adopt the empty state and wipe the injected stub, which is why pass 2's after-poll assertion alone could not go red.
  5. Drop step 2's `setPreviewRegen({ …completed })` for a non-active completion (mark only when `onBook`) → red: `OD27 — a non-active completion marks the matching preview finished` and `OD27 — arriving back at the preview book re-opens a first render ('none') as a stub…`.
  6. Never arm on arrival (delete the `if (activeBefore !== activeAfter) armedFor = …` line) → red: `OD27 — arriving back …` (both), `OD29 — arriving back after a 'recorded' completion elsewhere…`, and `OD28 — an active completion marks the preview finished too…` (its second, arrival-driven open).
  7. Drop `after.chapters.currentBookId === armedFor` from the fire condition → red:
     - `A8 — an active completion waits for its own book's chapters`. It fires at once, and `openPreview`'s own A8 guard (`currentBookId === p.bookId`) finds no b1 rows. It takes the "cannot be built yet" return and consumes the arm, so nothing opens when b1's rows land: the final `waitFor` times out.
     - `OD27 — the re-open waits for the arriving book's chapters` (the arm fires on arrival, finds no chapter 3 among b2's rows, takes the "cannot be built yet" return, and is consumed, so nothing opens when b1's rows land).
  8. Drop `&& pv.completed !== undefined` from the fire condition → red: `OD27 — no re-open on arrival without a finished preview`. An unfinished preview armed on arrival now fires: `openPreview` sees `reviewOutcome` `undefined`, which is neither `'none'` nor `'failed'`, and refetches, so `pollRevisionsMock` is called. Arming no longer tests `completed`, so nothing masks this; pass 2 tested it in both places.
  9. Drop `after.ui.openRevision === null` from the fire condition → red: `OD28 — never opens over a player the user has open…` (the stub replaces `r-x`, and `getChapterAudioPrevious` is called).
  10. Mark `completed` only for a non-active completion (step 2's `if (mine)` → `if (mine && !onBook)`) → red: `OD28 — an active completion marks the preview finished too…`. Its first `waitFor` times out, because without `completed` the fire check never opens the active completion.
  11. In `openPreview`'s `!chapter || !character` branch, clear the preview (`dispatch(uiActions.setPreviewRegen(null))`) before returning → red: `OD28 — a stub that cannot be built yet … leaves the preview re-openable` (`completed` is gone, and the later arrival opens nothing).
  12. Never drop on OD29: delete the `if (isThisPreview(getState())) { … }` drop block inside `if (r === 'ok')`, together with that branch's `return`, so a `'recorded'` refetch with no entry falls through → red:
      - `OD29 — 'recorded' on its own book, but the refetch finds no entry…` (`stubFallback` is `true`, so a stub opens);
      - `OD29 — arriving back after a 'recorded' completion elsewhere…` (it warns and keeps the preview, so `previewRegen` is never `null`).
  13. Stamp `stubFallback: false` on every completion → red: `a doubly-failed refetch still opens the stub` (it warns instead) and `'none' (a first render) → …` (at its `completed` assertion).
  14. Delete `|| activeBookId(getState()) !== p.bookId` after the refetch → red: `OD28/OD29 — leaving the book while the arrival refetch is in flight…`. The unapplied `'ok'` reads b2's empty cache, so OD29 drops the preview and toasts.
  15. Move step 1 (`armedFor = bookId`) after step 2's dispatch → red: `a completion on the book while an arrival arm is pending opens it once`. Step 2's re-entry fires on the arrival's arm, step 1 then re-arms, and the outer pass fires again, so `pollRevisionsMock` is called twice.
  16. **Collapse `'none'` into `'recorded'` on the client** (drop `reviewOutcome !== 'none' &&` from the refetch condition) → red: `'none' (a first render) → no refetch…` and `OD27 — arriving back at the preview book re-opens a first render ('none')…`. Mechanism (pass 4 #10 corrected it): neither test queues a poll response, and `beforeEach`'s `mockReset` leaves `pollRevisionsMock` returning `undefined` — not `empty()`. So the refetch dispatches `applyPoll({ ...undefined, bookId: 'b1' })`, i.e. `{ bookId: 'b1' }`; the cache held no book, so the ordered rule adopts it as an empty cache (`fileId: null`, `rev: 0`, `pending: []`), and the refetch answers `'ok'` with no entry for chapter 3. OD29 then drops the preview with "This preview was resolved elsewhere", so each test's stub-open `waitFor` times out (`openRevision` stays `null`). This is the client-side twin of Task 7's mutation 1.
  17. Treat `'failed'` like `'recorded'` (drop `&& reviewOutcome !== 'failed'`) → red: `'failed' (preserved, unrecorded) → no refetch…` (`pollRevisionsMock` is called).
  18. **OD30 — split the atomic open** back into `dispatch(uiActions.setPreviewRegen({ ...preview, stub: buildPreviewStub(…) })); dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));` → red: all three tests of the OD30 integration describe that open the entry (`'none' …`, `'failed' …`, `'recorded' whose refetch fails twice …`), at `opensTheEntry`'s first `waitFor` (`openRevision` stays `null`). Traced: the first dispatch reaches the watcher with no player open, so rule 1 drops the stub (stamping `stubFallback: false`) without switching anything; the second opens `preview-stub`, rule 2 finds no active stub and closes it. Nothing opens and no toast fires — exactly pass 4's race. The unit stores (no watcher) stay green under this mutation, which is why the integration describe exists.
  19. In `revision-player-middleware.ts`, delete rule 1's `if (open?.kind === 'preview-stub') { …setOpenRevision… }` switch (keep the stub drop) → red: the same three integration tests (the stub player opens, then rule 1 drops the stub and rule 2 closes the player: `openRevision` ends `null`). With the whole rule-1 block deleted instead, they go red with `openRevision` `{ kind: 'preview-stub' }` (Task 21's mutation 5 covers the unit side).
  20. **A1 — drop the `openRevision` re-check in the refetch branch** (`if (getState().ui.openRevision !== null) return;`) → red: `A1 — a player the user opens during the refetch window is not replaced` (`openRevision` becomes `revision:3:1700`).
  21. **A1 — drop `s.ui.openRevision !== null ||`** from the guard before the stub → red: `A1 — a player the user opens during the previous-audio GET is not replaced by the stub` (`openRevision` becomes `preview-stub`). The book check cannot mask it: the active book never changed.
  22. **A1 — drop `|| activeBookId(s) !== p.bookId`** from that guard → red: `A1 — moving to book B during the GET builds no stub there…` (no watcher in that store, so `openRevision` becomes `preview-stub` on b2 and the stub is set). The `openRevision` check cannot mask it: no player is open on b2.
  23. **A1 — delete the whole guard** before the stub → red: additionally `A1 — moving to book B during the GET does not close the player the user opened on B` (integration describe): the stub open replaces `rB`, and the watcher's rule 2 then closes it, so `openRevision` ends `null`. That test is guarded by both clauses at once, so only this combined mutation reaches it; mutations 21 and 22 prove each clause on its own.
  (No mutation targets `openPreview`'s own `currentBookId === p.bookId` guard. The fire gate (mutation 7) is the tested seam. That guard only covers the window after the refetch's `await`, when the active book is unchanged but the chapter rows could still differ, and no unit test reaches that window. It is defensive, and removing it changes no test.)
- [ ] **Step 5: Commit.** `fix(frontend,e2e): open a recorded preview entry or a stub, and re-open a preview on return (#3397)`.

---

### Task 25: Persistence — no revisions PUT, ever

**Character:** mechanical.

**Files:**
- Modify: `src/store/persistence-middleware.ts` — delete the nine `revisions/*` rules (`~:212-251`) and their comments, `revisionsPatch` (`~:304-322`), the `rule.slice === 'revisions'` gate (`~:466-491`) with its comment; amend the `FLUSH_BOOK` comment (`~:336-345`): "revisions no longer persists from the client (plan 286), so the write-then-re-read hazard it describes now applies only to the other slices".
- Modify: `src/lib/types.ts` (`StateSlice` drops `'revisions'`), `src/lib/api.ts` (`applyMockSliceWrite` drops `case 'revisions'`).
- Test: create `src/store/persistence-middleware.revisions-never-put.test.ts`; trim `persistence-middleware.test.ts` (delete its revisions-rule tests; list them in the commit body).
- Issue chore: post a comment on #3421 ("plan 286 removes every client revisions write, so the revisions half of this issue is moot; the re-send-vs-surface question remains for the other slices").

- [ ] **Step 1: Failing test** — the new file. The gate refuses a revisions write unless `revisions.bookId` and `revisions.hydratedFor` both equal the book, so the test **hydrates first** (Task 12's transitional `hydrate` sets both); without that the test would pass before the fix and prove nothing.
  ```ts
  /* Plan 286 — the client never PUTs revisions.json (invariant 1). Drives the
     revisions actions through a store with the real persistence middleware,
     with the old gate OPEN (book hydrated), flushes, and checks every
     putBookState call. */
  import { describe, it, expect, vi, expectTypeOf } from 'vitest';
  import { configureStore } from '@reduxjs/toolkit';
  import type { StateSlice } from '../lib/types';

  const { putBookState } = vi.hoisted(() => ({ putBookState: vi.fn(async () => {}) }));
  vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { putBookState } }));

  import { persistenceMiddleware, flushBookPersistence } from './persistence-middleware';
  import { revisionsSlice, revisionsActions } from './revisions-slice';
  import { uiSlice, uiActions } from './ui-slice';

  const STATE = { bookId: 'A', fileId: '000000000000001-a', rev: 1, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} };

  function hydratedStore() {
    const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer }, middleware: (g) => g().concat(persistenceMiddleware) });
    store.dispatch(uiActions.openBook({ id: 'A', status: 'complete' } as never));
    store.dispatch(revisionsActions.hydrate({ bookId: 'A', state: STATE }));
    return store;
  }

  describe('no revisions PUT (plan 286)', () => {
    it('StateSlice cannot name revisions', () => {
      expectTypeOf<'revisions'>().not.toMatchTypeOf<StateSlice>();
    });
    it("none of today's revisions actions schedules a PUT, even with the book hydrated", async () => {
      const store = hydratedStore();
      store.dispatch(revisionsActions.acceptAllPending());
      store.dispatch(revisionsActions.rejectAllPending());
      store.dispatch(revisionsActions.dismissDrift('d'));
      store.dispatch(revisionsActions.acceptRevision({ revisionId: 'r', selection: {} }));
      store.dispatch(revisionsActions.rejectRevision('r'));
      store.dispatch(revisionsActions.rolledBack({ chapterId: 1, timelineEntryId: 't', rolledBackId: 'x' }));
      store.dispatch(revisionsActions.enqueuePending({ id: 'p', chapterId: 1, characterId: 'c', segments: [] }));
      store.dispatch(revisionsActions.markRevisionPlayable({ chapterId: 1 }));
      store.dispatch(revisionsActions.persistPendingAfterHydrateMerge());
      await store.dispatch(flushBookPersistence('A') as never);
      expect(putBookState.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'revisions')).toEqual([]);
    });
  });
  ```
  Run → FAIL: the old rules schedule a revisions PUT (gate open), and `StateSlice` still includes `'revisions'` (`typecheck`).

- [ ] **Step 2: Implement** the deletions. Remove `revisions` from `PersistableRootState` if only deleted code used it.
- [ ] **Step 3: Green.** The new file, `persistence-middleware.test.ts`, `layout.test.tsx`, `src/lib/api.mock-state.test.ts`, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Re-add `'revisions/dismissDrift': { slice: 'revisions' as never, build: () => ({}) }` to `PERSIST_RULES` → red: `none of today's revisions actions schedules a PUT…`.
  2. Re-add `'revisions'` to `StateSlice` → `typecheck` red: `StateSlice cannot name revisions`.
- [ ] **Step 5: Commit.** `fix(frontend): stop persisting revisions.json from the client (#3400)`.

---

### Task 26: Delete #3395's guard machinery and the dead revisions API; a book reset clears its preview (OD31)

**Character:** mechanical (large but deletion-only), plus OD31's one reducer and its four call sites (pass 4: the operator decided it on 2026-10-07; it lands here because three of its four sites are the lines this task already rewrites).

**Files:**
- Modify: `src/store/revisions-slice.ts` — delete `hydratedFor`, `windowActions`, `RecordedRevisionsAction`, `DispatchedAt`, `recordIfUnhydrated`, `replayRecorded` (+ its assignment), `acceptAllPending`, `rejectAllPending`, `acceptRevision`, `rejectRevision`, `rolledBack`, `bookScopeChanged`, `bookWiped`, `dismissDrift`, `enqueuePending`, `markRevisionPlayable`, `hydrateFromBookState`, `persistPendingAfterHydrateMerge`, `appendTimelineEntryHelper`, `nowIso`; the transitional `s.hydratedFor = bookId;` line in `hydrate`; rewrite the `RevisionsState` field docs and the file header.
- Delete: `src/store/revisions-scope-middleware.ts`, `src/store/revisions-scope-middleware.test.ts`; remove its import and `.concat` entry from `src/store/index.ts`, and from `layout.test.tsx` (`makeStoreWithScope`) and `splice-runner-middleware.test.ts`.
- Modify: `src/routes/index.tsx` — `onDeleteBook` (`~:155`), `onReplaceManuscript` (`~:196`) and `onReparseBook` (`~:252`): each `bookWiped(b.bookId)` → `revisionsActions.forgetBook(b.bookId)`, and rewrite the comment sentence beside the replace/reparse ones (`~:191`): the server reset the file to a new `fileId`; forgetting the cache here means the next read adopts it as a different book, without depending on the `manuscriptActions.reset()` beside it forcing a full reload. (A no-op when the cache holds another book — `forgetBook` checks.)
- Modify: `src/lib/api.ts` — delete `acceptChapterRevision`/`rejectChapterRevision` (real + mock) and `mockAcceptChapterRevision`/`mockRejectChapterRevision`.
- **OD31 — a book reset clears the preview.** Add to `src/store/ui-slice.ts`:
  ```ts
  /** Plan 286 (OD31) — the preview's book was re-parsed, its manuscript
      replaced, its chapters restructured, or the book deleted. Chapter ids
      may now mean different chapters, and the server dropped any pending
      entry for the touched chapters, so the preview cannot be resumed: drop it.
      The new take stays as the chapter's audio (nothing is restored). Only a
      preview of THAT book; a no-op otherwise. An open stub player is closed by
      the watcher's rule 2 (Task 21), since its stub is gone. */
  clearPreviewForBook: (s, a: PayloadAction<string>) => {
    if (s.previewRegen?.bookId === a.payload) s.previewRegen = null;
  },
  ```
  and dispatch `uiActions.clearPreviewForBook(b.bookId)` immediately after each of the three `forgetBook` dispatches in `src/routes/index.tsx` (delete, replace, reparse) — synchronously, before that handler's next `await`, and as the first statement of `applyResponse` in `src/views/restructure.tsx` (`~:40`; `dispatch(uiActions.clearPreviewForBook(bookId));`, with a one-line OD31 comment). **The restructure site is not in `routes/index.tsx`** (pass 4's brief placed all four there; the code does not): merge, split, reorder, exclude and refresh-titles all funnel through that view's `applyResponse` after the server applied the change, so that one call covers every restructure operation.
- (`src/lib/types.ts`'s `acceptedSelections` doc comment went with the inline type in Task 17; `e2e/marketing/scenes.ts` was fixed in Task 24.)
- Tests: `revisions-slice.test.ts` (delete tests of deleted reducers; list in commit body), `routes/index.test.tsx`, `src/store/ui-slice.test.ts` (OD31 reducer), create `src/views/restructure.preview.test.tsx` (OD31 restructure site — `RestructureView` has no unit test today), `persistence-middleware.revisions-never-put.test.ts` (replace the old-action case with the exhaustive one below), `generation-stream-middleware.test.ts` (drop any remaining `markRevisionPlayable` case).

- [ ] **Step 1: Failing tests.**
  `routes/index.test.tsx` — replace `describe("drops the book's recorded pre-hydrate revisions writes")` (it pins `windowActions`, deleted here; list its three tests in the commit body) with:
  ```ts
  describe("forgets a wiped book's revisions cache and clears its preview (plan 286, OD31)", () => {
    beforeEach(() => {
      getLibraryMock.mockResolvedValue({ authors: [] });
      getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    });
    const held = { bookId: 'b1', fileId: '000000000000002-a', rev: 2, pending: [{ id: 'p', chapterId: 1, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} };
    /* OD31 — a finished, unresolved preview of b1 (marker set, stub built). */
    const previewOfB1 = { bookId: 'b1', characterId: 'c', previewChapterId: 1, remainingChapterIds: [2], reason: '', note: '',
      stub: { id: 'revision:1:c', chapterId: 1, characterId: 'c', segments: [] }, completed: { reviewOutcome: 'none' as const, stubFallback: true } };
    async function deleteB1(store: ReturnType<typeof makeStore>) {
      deleteBookMock.mockResolvedValue(undefined);
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
      const confirm = screen.getAllByRole('button', { name: /Delete book/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(deleteBookMock).toHaveBeenCalledWith('b1'));
    }
    it('deleting a book forgets its revisions cache and clears its preview', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      store.dispatch(uiActions.setPreviewRegen(previewOfB1));
      await deleteB1(store);
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] }));
      expect(store.getState().ui.previewRegen).toBeNull();
    });
    it('delete then re-import under the same id shows a clean cache', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      await deleteB1(store);
      await waitFor(() => expect(store.getState().revisions.bookId).toBeNull());
      store.dispatch(revisionsSlice.actions.hydrate({ bookId: 'b1', state: { ...held, fileId: null, rev: 0, pending: [] }, requestSeq: store.getState().revisions.adoptSeq }));
      expect(store.getState().revisions).toMatchObject({ bookId: 'b1', fileId: null, pending: [] });
    });
    it('a reparse forgets the cache and clears the preview', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      store.dispatch(uiActions.setPreviewRegen(previewOfB1));
      reparseBookMock.mockResolvedValue({ state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] });
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Re-parse manuscript/i }));
      const confirm = screen.getAllByRole('button', { name: /Re-parse manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(reparseBookMock).toHaveBeenCalledWith('b1'));
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] }));
      expect(store.getState().ui.previewRegen).toBeNull();
    });
    it('a manuscript replace forgets the cache and clears the preview', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      store.dispatch(uiActions.setPreviewRegen(previewOfB1));
      replaceManuscriptMock.mockResolvedValue({ chapterCount: 1 });
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.change(screen.getByTestId('replace-manuscript-input'), {
        target: { files: [new File(['# One'], 'new.md', { type: 'text/markdown' })] },
      });
      const confirm = screen.getAllByRole('button', { name: /Replace manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(replaceManuscriptMock).toHaveBeenCalledWith('b1', expect.any(File)));
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] }));
      expect(store.getState().ui.previewRegen).toBeNull();
    });
  });
  ```
  (The reparse and replace drives copy the existing `after a reparse` / `after a manuscript replace` tests this describe replaces, `~:728-756`. Each site's `previewRegen` assertion runs after the `forgetBook` `waitFor`, which the site's `clearPreviewForBook` dispatch sits beside, so the clear has landed by then. `uiActions` is already imported, `~:16`.)

  `ui-slice.test.ts` — the reducer's book scope:
  ```ts
  it('plan 286 (OD31) — clearPreviewForBook clears only that book\'s preview', () => {
    let s = uiSlice.reducer(undefined, uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '' }));
    s = uiSlice.reducer(s, uiActions.clearPreviewForBook('b2'));
    expect(s.previewRegen?.bookId).toBe('b1');
    s = uiSlice.reducer(s, uiActions.clearPreviewForBook('b1'));
    expect(s.previewRegen).toBeNull();
  });
  ```
  Create `src/views/restructure.preview.test.tsx` — the restructure site. `RestructureView` reads the app's singleton `store` from `../store` (`store.getState().cast.characters`, `restructure.tsx ~:53`), so mock that module onto a test store rather than importing the real one (whose module initialises the persisted app store):
  ```ts
  /* Plan 286 (OD31) — a restructure of the preview's book clears the preview. */
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen, fireEvent, waitFor } from '@testing-library/react';
  import { Provider } from 'react-redux';
  import { configureStore } from '@reduxjs/toolkit';
  import { uiSlice, uiActions } from '../store/ui-slice';
  import { chaptersSlice } from '../store/chapters-slice';
  import { manuscriptSlice } from '../store/manuscript-slice';
  import { librarySlice } from '../store/library-slice';
  import { notificationsSlice } from '../store/notifications-slice';
  import { castSlice } from '../store/cast-slice';

  const { holder, apiMock } = vi.hoisted(() => ({
    holder: { store: null as null | { getState: () => unknown } },
    apiMock: { refreshChapterTitles: vi.fn(), getBookState: vi.fn(), getLibrary: vi.fn() },
  }));
  vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: apiMock }));
  vi.mock('../store', async () => {
    const rr = await import('react-redux');
    return { useAppDispatch: rr.useDispatch, useAppSelector: rr.useSelector, store: { getState: () => holder.store!.getState() } };
  });

  import { RestructureView } from './restructure';

  function makeStore() {
    const store = configureStore({ reducer: { ui: uiSlice.reducer, chapters: chaptersSlice.reducer, manuscript: manuscriptSlice.reducer, library: librarySlice.reducer, notifications: notificationsSlice.reducer, cast: castSlice.reducer } });
    holder.store = store;
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' } as never));
    return store;
  }
  const preview = (bookId: string) => ({ bookId, characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '', completed: { reviewOutcome: 'none' as const, stubFallback: true } });

  beforeEach(() => {
    apiMock.refreshChapterTitles.mockReset().mockResolvedValue({ sentenceRemap: [], warnings: [] });
    apiMock.getBookState.mockReset().mockResolvedValue(null);
    apiMock.getLibrary.mockReset().mockResolvedValue(null);
  });

  async function refreshTitles(store: ReturnType<typeof makeStore>) {
    render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
    fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
    fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
    await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalledWith('b1'));
    await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled()); // applyResponse ran to its end
  }

  describe('RestructureView — OD31', () => {
    it("a restructure of the preview's book clears the preview", async () => {
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen(preview('b1')));
      await refreshTitles(store);
      expect(store.getState().ui.previewRegen).toBeNull();
    });
  });
  ```
  (Refresh-titles is the cheapest drive of `applyResponse`, which every restructure operation shares; if the panel needs chapter rows to render the button, seed one with `chaptersSlice.actions.setChapters`. If `RestructureChaptersPanel` or `EditChapterTitleModal` import another `../store` export at module load, add it to the factory rather than importing the real module.)
  `persistence-middleware.revisions-never-put.test.ts` — replace the "today's actions" case with:
  ```ts
  /* One payload per action creator. `satisfies` makes a new revisions action
     without an entry here a compile error, so it cannot dodge this test. */
  const PAYLOADS = {
    hydrate: { bookId: 'A', state: STATE },
    applyServerState: STATE,
    applyPoll: { ...STATE, drift: [] },
    applyBackgroundPoll: { bookId: 'B', drift: [] },
    applyDismiss: { driftId: 'd', state: STATE },
    forgetBook: 'A',
  } satisfies { [K in keyof typeof revisionsActions]: Parameters<(typeof revisionsActions)[K]>[0] };

  it('no revisions action ever reaches putBookState', async () => {
    const store = hydratedStore();
    for (const [name, payload] of Object.entries(PAYLOADS)) {
      store.dispatch((revisionsActions as unknown as Record<string, (p: unknown) => { type: string }>)[name](payload));
    }
    await store.dispatch(flushBookPersistence('A') as never);
    expect(putBookState.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'revisions')).toEqual([]);
  });
  ```
  (`hydratedStore()` still works: `hydrate` no longer sets `hydratedFor` but nothing gates on it.) Run → FAIL (`forgetBook` is not dispatched on delete, reparse or replace; `clearPreviewForBook` does not exist yet, so the ui-slice test and every `previewRegen` assertion fail).

- [ ] **Step 2: Implement** the deletions.
- [ ] **Step 3: Green.** One frontend run over every test file `git -C <wt> grep -l "revisions" -- 'src/**/*.test.ts' 'src/**/*.test.tsx'` lists, plus `src/store/ui-slice.test.ts` and `src/views/restructure.preview.test.tsx`; `typecheck`; `npx --prefix <wt> eslint src/store src/routes src/components src/lib src/views/restructure.tsx src/views/restructure.preview.test.tsx e2e/marketing` (unused imports); e2e `revision-diff.spec.ts profile-regen-preview.spec.ts character-splice.spec.ts drift-report-multibook.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Remove the `forgetBook` dispatch from `onDeleteBook` → red: `deleting a book forgets its revisions cache and clears its preview` (at the `revisions` `waitFor`).
  2. Add `noop: (s) => s` to the slice's reducers without a `PAYLOADS` entry → `typecheck` red at the `satisfies` clause.
  3. Remove the `forgetBook` dispatch from `onReparseBook` → red: `a reparse forgets the cache and clears the preview`.
  4. Remove the `forgetBook` dispatch from `onReplaceManuscript` → red: `a manuscript replace forgets the cache and clears the preview`.
  5. **OD31** — remove the `clearPreviewForBook` dispatch from `onDeleteBook` → red: `deleting a book forgets its revisions cache and clears its preview`, at `expect(store.getState().ui.previewRegen).toBeNull()` (the `forgetBook` `waitFor` before it still passes, so this isolates the new dispatch).
  6. **OD31** — the same in `onReparseBook` → red: `a reparse forgets the cache and clears the preview`, at its `previewRegen` assertion.
  7. **OD31** — the same in `onReplaceManuscript` → red: `a manuscript replace forgets the cache and clears the preview`, at its `previewRegen` assertion.
  8. **OD31** — remove the `clearPreviewForBook` dispatch from `restructure.tsx`'s `applyResponse` → red: `a restructure of the preview's book clears the preview`.
  9. **OD31** — make `clearPreviewForBook` clear unconditionally (drop the `bookId` check) → red: `clearPreviewForBook clears only that book's preview` (the `b2` dispatch clears `b1`'s preview).
- [ ] **Step 5: Commit.** `fix(frontend): delete the client revisions guard machinery; a book reset clears its preview (#3400)` (99 characters). The body lists the deleted tests and names OD31.

---

### Task 27: Server — finalize callers pass `review` / `null`

**Character:** judgment (three routes; generation suite is slow-pool).

**Files:**
- Modify: `server/src/routes/chapter-splice.ts` (`finalizeChapterAudioWrite({` call `~:526`), `server/src/routes/chapter-qa-repair.ts` (`~:766`), `server/src/routes/generation.ts` (`~:1891`; the `RunningJob.review` comment `~:387-389`).
- Tests: `chapter-splice.test.ts` (`plan 285 — passes no \`review\` to finalize (PR 1 dark)…` `~:281`, its threading assertion already renamed to `reviewOutcome` by Task 7), `chapter-qa-repair.test.ts` (`~:440`), `generation.test.ts` (`passes no \`review\` to finalize…` `~:2369`; `reviewChapter:true only on the chapter rendered with review — … finalize still gets no review` `~:2414`); and the two "… carries no reviewOutcome when finalize returns none" tests Task 7 renamed (`chapter-splice.test.ts ~:301-308`, `generation.test.ts ~:2390-2397`), which go red here and are rewritten in Step 1 (pass 4 #2).

**Interfaces:**
- Splice: `chapter-splice.ts` has no cast resolver today. Import `buildCastResolver` from `../store/cast-resolve.js` and, after `castIdHistory` is loaded (`~:229`), compute `const reviewName = buildCastResolver(cast.characters, castIdHistory).resolve(characterId)?.character.name ?? characterId;` (resolves superseded ids, OD13). Pass `review: { characterId, triggeredBy: spliceTriggeredBy(mode, reviewName) }`. Export `spliceTriggeredBy(mode: 'remix' | 'rerecord', name: string): string` = `` `${mode === 'remix' ? 'Loudness fix' : 'Re-record'} (${name.split(' ')[0] || name})` ``.
- QA repair: `review: null`.
- Generation: `review: job.review` (it is `null` when absent). A job with `review` renders exactly one chapter (400 otherwise, PR 1) and replayed chapters never finalize, so no per-chapter guard is needed. Update the `RunningJob.review` comment.

- [ ] **Step 1: Failing tests** — flip the three dark-state tests:
  ```ts
  // chapter-splice.test.ts — replace the 'plan 285 — passes no `review`…' test
  it('plan 286 — passes the splice review to finalize and threads reviewOutcome onto splice_complete', async () => {
    const fin = await import('../audio/finalize-chapter-write.js');
    const real = (await vi.importActual<typeof import('../audio/finalize-chapter-write.js')>('../audio/finalize-chapter-write.js')).finalizeChapterAudioWrite;
    const spy = vi.mocked(fin.finalizeChapterAudioWrite);
    spy.mockClear();
    spy.mockImplementationOnce(async (input) => ({ ...(await real(input)), reviewOutcome: 'failed' as const }));
    const res = await request(app).post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`).send({ mode: 'remix', characterId: 'castor', gainDb: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].review).toEqual({ characterId: 'castor', triggeredBy: 'Loudness fix (Castor)' });
    expect(parseSse(res.text).find((e) => e.type === 'splice_complete')!.reviewOutcome).toBe('failed');
  });
  it('plan 286 — spliceTriggeredBy uses the first name', () => {
    expect(spliceTriggeredBy('remix', 'Eliza Carrick')).toBe('Loudness fix (Eliza)');
    expect(spliceTriggeredBy('rerecord', 'narrator')).toBe('Re-record (narrator)');
  });
  ```
  ```ts
  // chapter-qa-repair.test.ts — in the existing 'plan 285 — passes no `review`…' test, rename to
  // 'plan 286 — passes review:null to finalize and threads reviewOutcome onto qa_repair_complete' and replace
  //   expect('review' in spy.mock.calls[0][0]).toBe(false);
  // with
  expect(spy.mock.calls[0][0].review).toBeNull();
  ```
  ```ts
  // generation.test.ts — rename 'passes no `review` to finalize and threads reviewOutcome…' (Task 7's title) to
  // 'plan 286 — passes review:null to finalize without review…' and replace its `'review' in …` assertion with:
  expect(spy.mock.calls[0][0].review).toBeNull();
  // and in 'reviewChapter:true only on the chapter rendered with review — never a replay — and finalize still gets no review',
  // rename the tail to '— and finalize gets the job review', replacing `expect('review' in spy.mock.calls[0][0]).toBe(false);` with:
  expect(spy.mock.calls[0][0].review).toEqual(REVIEW);
  ```
  **Pass 4 #2 — two existing tests go red in this task and must be rewritten here, not left for Green to discover.** Task 7 renamed them to "… carries no reviewOutcome when finalize returns none" and asserts `expect(line).not.toContain('reviewOutcome');`. That holds only while the routes pass no `review`. Once they always pass `review` / `null`, finalize always answers, so the field is always on the line:
  ```ts
  // chapter-splice.test.ts (~:301) — 'plan 285 — the splice_complete line carries no reviewOutcome when finalize returns none' →
  it('plan 286 — the splice_complete line always carries reviewOutcome: a splice records its review', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'remix', characterId: 'castor', gainDb: 3 });
    const line = res.text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"splice_complete"'));
    expect(line, res.text).toBeTruthy();
    /* A splice always has live audio to preserve (this file's own remix test asserts the
       .previous.mp3), so finalize records the entry. */
    expect(JSON.parse(line!.slice('data: '.length)).reviewOutcome).toBe('recorded');
    expect(line).not.toContain('reviewRecorded'); // the wire guard Task 7 kept
  });
  ```
  ```ts
  // generation.test.ts (~:2390) — 'the chapter_complete line carries no reviewOutcome when finalize returns none' →
  it('plan 286 — a plain chapter_complete carries reviewOutcome none (review:null drops the chapter entry)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    const line = completeLine(res.text, 1);
    expect(line, res.text).toBeTruthy();
    expect(JSON.parse(line!.slice('data: '.length)).reviewOutcome).toBe('none');
    expect(line).not.toContain('reviewRecorded'); // the wire guard Task 7 kept
  });
  ```
  (The mock already stamps the same values — `'recorded'` on a splice, `'none'` on a plain `chapter_complete` and on `qa_repair_complete` — since Task 11, so mock mode and this task's server agree.)
  Run:
  `npm --prefix <wt>/server run test -- src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts --retry=0`
  `npm --prefix <wt>/server run test:slow -- src/routes/generation.test.ts -t "review" --reporter=verbose --retry=0` (check all three renamed titles appear in the log)
  → FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Green** (same commands without `--retry=0`), server `typecheck`, `npm --prefix <wt> run check:cycles` (new import of `store/cast-resolve.js` into a route).
- [ ] **Step 4: Mutations.**
  1. Generation: pass `job.review ?? undefined` → red: `plan 286 — passes review:null to finalize without review` (`undefined`, finalize leaves revisions.json alone) and `plan 286 — a plain chapter_complete carries reviewOutcome none…` (finalize answers nothing, so the field is absent and `reviewOutcome` parses as `undefined`).
  2. QA repair: pass `undefined` → red: the renamed QA-repair test.
  3. Splice: use `characterId` instead of `reviewName` → red: `passes the splice review to finalize…` (`Loudness fix (castor)`).
  4. Splice: pass no `review` (PR 1's dark call) → red: `plan 286 — the splice_complete line always carries reviewOutcome…` (the field is absent) and `passes the splice review to finalize…` (`review` is `undefined`).
- [ ] **Step 5: Commit.** `feat(server): record A/B review state on splice, QA repair and generation renders (#3397)`.

---

### Task 28: Server — restructure drops stale pending entries

**Character:** judgment.

**Files:**
- Modify: `server/src/workspace/restructure.ts` (add `touchedChapterIds`), `server/src/workspace/revisions-store.ts` (add `dropPendingForChapters`), `server/src/routes/chapters-restructure.ts` (`applyRestructure`, after `rewriteChapterSlugs`).
- Modify: `CLAUDE.md` (swallow list FIVE → SIX), `server/src/workspace/cast-lock.ts` comment if it mirrors the list.
- Tests: `server/src/workspace/restructure.test.ts`, `server/src/workspace/revisions-store.test.ts`, `server/src/routes/chapters-restructure.test.ts` (**slow pool**).

**Interfaces:**
- `touchedChapterIds(oldChapters: BookStateJson['chapters'], newChapters: BookStateJson['chapters'], audioOps: AudioOp[]): number[]` (sorted, unique): every old chapter whose slug is an op's `from`, plus every old chapter whose id now maps to a different slug or to no chapter. (A rename's `newChapterId` is not added separately: the old chapter with that id either has its own op or changed slug, so it is already covered — finding 15.)
- `dropPendingForChapters(bookDir, chapters, chapterIds: readonly number[]): Promise<RevisionsFile>` — one write under the revisions lock, only if something was dropped.
- `applyRestructure`, after the audio ops (capture `const oldChapters = state.chapters.map((c) => ({ ...c }));` **before** `transform(...)` in case the transform mutates `state`):
  ```ts
  /* Plan 286 — entries for chapters this op touched no longer pair with the
     live take. Best-effort: logged, never in a response (the six handlers
     return raw messages, so a lock-key path must not reach them). A deliberate
     swallow of LockAcquisitionTimeoutError (CLAUDE.md swallow list). */
  try {
    const touched = touchedChapterIds(oldChapters, result.state.chapters, result.audioOps);
    if (touched.length > 0) await dropPendingForChapters(bookDir, oldChapters, touched);
  } catch (e) {
    console.error('[chapters-restructure] could not drop stale A/B review entries', e);
  }
  ```

- [ ] **Step 1: Failing tests.**
  ```ts
  // restructure.test.ts
  import { touchedChapterIds, type AudioOp } from './restructure.js';
  const ch = (id: number, slug: string) => ({ id, title: slug, slug });
  it('plan 286 — touchedChapterIds covers content change (same id), id change, and slug-only rename; leaves untouched chapters', () => {
    const old = [ch(1, '01-a'), ch(2, '02-b'), ch(3, '03-c'), ch(4, '04-d'), ch(5, '05-e')];
    const neu = [ch(1, '01-a'), ch(2, '02-b'), ch(3, '03-c-renamed'), ch(4, '04-merged')];
    const ops: AudioOp[] = [{ kind: 'delete', from: '02-b' }, { kind: 'rename', from: '03-c', to: '03-c-renamed', newChapterId: 3, newChapterTitle: 'C' }];
    // 2: content changed, same id+slug (delete op) · 3: slug-only rename · 4: same id, new slug · 5: gone · 1: untouched
    expect(touchedChapterIds(old as never, neu as never, ops)).toEqual([2, 3, 4, 5]);
  });
  ```
  ```ts
  // revisions-store.test.ts (add dropPendingForChapters to the import)
  it('plan 286 — dropPendingForChapters drops several chapters in one write; no-op when none match', async () => {
    seedRaw({ schema: 1, fileId: '000000000000001-a', rev: 4, pending: [serverEntry(1, 'r1'), serverEntry(2, 'r2')], dismissed: [], acceptedSelections: {}, timeline: {} });
    const out = await dropPendingForChapters(bookDir, CHAPTERS, [1, 2]);
    expect(out.pending).toEqual([]);
    expect(onDisk().rev).toBe(5);
    await dropPendingForChapters(bookDir, CHAPTERS, [7]);
    expect(onDisk().rev).toBe(5);
  });
  ```
  ```ts
  // chapters-restructure.test.ts — the file has NO vi.mock today (pass 2 cited a non-existent "existing hoisted
  // revisions-store mock"). Add one, at top level below the imports, so a test can inject a path-bearing rejection
  // (in the red step `real.dropPendingForChapters` is still undefined; vi.fn(undefined) is a valid no-op until Step 2):
  vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
    return { ...real, dropPendingForChapters: vi.fn(real.dropPendingForChapters) };
  });
  // …and convert its beforeAll's `const [{ chaptersRestructureRouter }, { bookStateRouter }, { makeBookId }] =
  // await Promise.all([...])` (~:132-136) to sequential awaits, which that async factory requires (#2083; incidental
  // finding, same comment as revisions.test.ts:90-92):
  //   const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  //   const { bookStateRouter } = await import('./book-state.js');
  //   const { makeBookId } = await import('../workspace/paths.js');
  // New describe; the file's beforeEach reseeds state/edits/audio (check it; if it does not remove revisions.json,
  // do so in this describe's afterEach)
  describe('plan 286 — restructure drops stale A/B entries', () => {
    const revPath = () => join(bookDir, '.audiobook', 'revisions.json');
    const srv = (chapterId: number, id: string) => ({ id, chapterId, characterId: 'narr', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' });
    afterEach(() => rmSync(revPath(), { recursive: true, force: true }));
    it('a merge of chapters 2+3 drops their entries and keeps chapter 1\'s', async () => {
      writeFileSync(revPath(), JSON.stringify({ schema: 1, fileId: '000000000000001-a', rev: 1, pending: [srv(1, 'r1'), srv(2, 'r2')], dismissed: [], acceptedSelections: {}, timeline: {} }));
      const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
      expect(res.status).toBe(200);
      const disk = JSON.parse(readFileSync(revPath(), 'utf8'));
      expect(disk.pending.map((p: { id: string }) => p.id)).toEqual(['r1']);
    });
    it('a failing drop still answers 200 and leaks no path', async () => {
      /* A rejection whose message embeds the path: an EISDIR fixture's message carries
         none, so asserting its absence would prove nothing (Invariant 8). */
      const store = await import('../workspace/revisions-store.js');
      vi.mocked(store.dropPendingForChapters).mockRejectedValueOnce(Object.assign(
        new Error(`EPERM: operation not permitted, rename '${revPath()}.tmp'`), { code: 'EPERM' }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
      const errorCalls = err.mock.calls.length; // before mockRestore, which clears mock.calls in vitest 5
      err.mockRestore();
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(workspaceRoot);
      expect(errorCalls).toBeGreaterThan(0);
    });
  });
  ```
  (Add `afterEach` and `vi` to the file's vitest import — today `describe, it, expect, beforeAll, afterAll, beforeEach` (`~:19`). `rmSync`, `writeFileSync` and `readFileSync` are already in its `node:fs` import (`~:20-25`); do not add them again.)
  Run:
  `npm --prefix <wt>/server run test -- src/workspace/restructure.test.ts src/workspace/revisions-store.test.ts --retry=0`
  `npm --prefix <wt>/server run test:slow -- src/routes/chapters-restructure.test.ts -t "plan 286" --reporter=verbose --retry=0`
  → FAIL (exports missing; `r2` survives the merge).
- [ ] **Step 2: Implement** per Interfaces. CLAUDE.md: "FIVE handlers swallow it deliberately" → "SIX …", adding "; and the restructure pending drop (`server/src/routes/chapters-restructure.ts`, plan 286) — a stale entry it fails to drop answers `revision_not_found` on the next accept/reject". Mirror in `cast-lock.ts` if it enumerates swallow sites.
- [ ] **Step 3: Green.** The two fast files; `test:slow` on `chapters-restructure.test.ts` (whole file, to keep the existing merge/split/reorder tests green); server `typecheck`; `npm --prefix <wt>/server run test -- src/workspace/cast-lock.guard.test.ts`.
- [ ] **Step 4: Mutations.**
  1. Drop the "old id maps to a different slug or no chapter" loop from `touchedChapterIds` → red: `touchedChapterIds covers…` (4 and 5 missing).
  2. Remove the `try/catch` in `applyRestructure` → red (slow pool): `a failing drop still answers 200 and leaks no path` (500 whose body carries the mocked EPERM path).
  3. Skip the drop call → red (slow pool): `a merge of chapters 2+3 drops their entries…`.
- [ ] **Step 5: Commit.** `feat(server): drop stale A/B entries for chapters a restructure touched (#3400)`.

---

### Task 29: Server — close the raw PUT (400) and the legacy audio routes (410)

**Character:** mechanical.

**Files:**
- Modify: `server/src/routes/book-state.ts` (`case 'revisions':` in the PUT switch `~:790`), `server/src/routes/chapter-audio.ts` (the `DELETE …/audio/previous` and `POST …/audio/previous/restore` handlers → 410), `server/src/audio/previous-audio.ts` (header comment names the old routes as callers), `server/src/workspace/revisions-store.ts` (`revisionOpLockKey`'s comment `:83-85`, "(and the legacy previous-audio routes)" → "(and restore-unrecorded)"), `openapi.yaml` (both legacy ops → 410 + `deprecated: true`; `PUT /state` documents the 400; `PutStateRequest.slice` description).
- Modify: `CLAUDE.md` (remove the two legacy routes from the `LOCK_CONTENTION_REQUEST_ERROR` sentence; "Accept/reject (and the legacy `…/audio/previous` routes) additionally serialise…" → "Accept/reject and `restore-unrecorded` additionally serialise…"); `server/src/workspace/cast-lock.ts` comment likewise.
- Tests: `chapter-audio.test.ts` (replace the `DELETE /audio/previous (accept)` and `POST /audio/previous/restore (reject)` describes — including PR 1's legacy race test and the legacy timeout `it.each` — with 410 tests; list each removed test in the commit body; the `restore-unrecorded` tests keep the same coverage for the shared audio function), `book-state.hydrate.test.ts`.

**Interfaces:**
- `PUT /state` `slice:'revisions'` → `400 { error: 'revisions_server_owned', message: 'revisions.json is written by the server; use the revision operations.' }`, nothing written.
- `DELETE …/audio/previous`, `POST …/audio/previous/restore` → `410 { error: 'moved', message: 'This operation moved to POST /api/books/{bookId}/revisions/{revisionId}/accept or /reject.' }` (never 404: the old client's accept treats 404 as success). No file touched.

- [ ] **Step 1: Failing tests.**
  ```ts
  // book-state.hydrate.test.ts
  it('plan 286 — PUT slice=revisions is refused with 400 and writes nothing', async () => {
    const res = await request(app).put(`/api/books/${bookId}/state`).send({ slice: 'revisions', patch: { pending: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('revisions_server_owned');
    expect(existsSync(join(bookDir, '.audiobook', 'revisions.json'))).toBe(false);
  });
  ```
  ```ts
  // chapter-audio.test.ts
  it.each([['delete', '/audio/previous'], ['post', '/audio/previous/restore']] as const)(
    'plan 286 — %s %s answers 410 moved and touches no audio', async (verb, suffix) => {
      resetAudio(); writeMp3(); writePreviousMp3();
      const res = await request(app)[verb](`/api/books/${bookId}/chapters/1${suffix}`);
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('moved');
      expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);
      expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
    });
  ```
  Run → FAIL.
- [ ] **Step 2: Implement.** Remove now-unused imports from `chapter-audio.ts` (`acceptPreviousAudio` — still exported, used by `revision-ops.ts`). Remove `revisionsJsonPath` from `book-state.ts`'s import if the PUT case was its last user.
- [ ] **Step 3: Green.** `chapter-audio.test.ts`, `book-state.hydrate.test.ts`, `typecheck`, `openapi:types` + `src/lib/api-types.revisions-contract.test.ts`, `npm --prefix <wt> run check:cycles`. (No `book-state.test.ts` run: its tests do not exercise the revisions PUT — `grep -n revisions server/src/routes/book-state.test.ts` is empty.)
- [ ] **Step 4: Mutations.**
  1. Answer 404 instead of 410 on the DELETE → red: the `delete` row.
  2. Make the PUT case `await writeJsonAtomic(revisionsJsonPath(bookDir), body.patch);` before returning 400 → red: `…writes nothing`.
- [ ] **Step 5: Commit.** `fix(server,openapi): refuse client revisions PUTs and retire the legacy A/B audio routes (#3400)`.

---

### Task 30: e2e — accept / reject / dismiss, the #3397 book switch, a recorded preview

**Character:** judgment (Playwright timing).

**Files:**
- Create: `e2e/revision-ops.spec.ts`, `e2e/revisions-book-switch.spec.ts`, `e2e/profile-regen-preview-recorded.spec.ts`.

- [ ] **Step 1: Write the specs** (serial mode).
  `e2e/revision-ops.spec.ts`:
  ```ts
  import { test, expect, type Page } from '@playwright/test';
  test.describe.configure({ mode: 'serial' });

  type Win = {
    __mockRevisions?: { get: (b: string) => { pending: Array<{ id: string }>; timeline: Record<string, Array<{ eventKind: string }>>; dismissed: string[] } };
    __store__?: { getState: () => { revisions: { pending: unknown[]; drift: Array<{ id: string; bookId: string; characterId: string }> } } };
  };

  async function openSbPlayer(page: Page) {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
    await page.getByText(/Solway Bay/i).first().click({ timeout: 10_000 });
    await page.getByTestId('status-pill').click();
    const open = page.getByTestId('status-popover-revisions').getByRole('button', { name: /\d+ revisions?/i });
    await expect(open).toBeVisible({ timeout: 10_000 });
    await open.click();
    const player = page.getByTestId('revision-diff-player');
    await expect(player).toBeVisible({ timeout: 10_000 });
    return player;
  }

  test('Commit selection accepts through the server and records history', async ({ page }) => {
    const player = await openSbPlayer(page);
    await player.getByRole('button', { name: /Commit selection/i }).click();
    await expect(player).toBeHidden({ timeout: 10_000 });
    const disk = await page.evaluate(() => (window as unknown as Win).__mockRevisions!.get('sb'));
    expect(disk.pending).toEqual([]);
    expect(disk.timeline['3'].map((t) => t.eventKind)).toEqual(['accepted']);
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__store__!.getState().revisions.pending.length)).toBe(0);
  });

  test('Reject draft rejects through the server and records history', async ({ page }) => {
    const player = await openSbPlayer(page);
    await player.getByRole('button', { name: /Reject draft/i }).click();
    await expect(player).toBeHidden({ timeout: 10_000 });
    const disk = await page.evaluate(() => (window as unknown as Win).__mockRevisions!.get('sb'));
    expect(disk.timeline['3'].map((t) => t.eventKind)).toEqual(['rejected']);
  });

  test('Dismissing a drift group posts to its book and the events stay gone after the next poll', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
    await page.getByText(/Solway Bay/i).first().click({ timeout: 10_000 });
    await page.goto('/#/books/sb/cast');
    const banner = page.getByText(/Voice drift detected in \d+ chapters?/i);
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const elizaIds = await page.evaluate(() =>
      (window as unknown as Win).__store__!.getState().revisions.drift.filter((d) => d.bookId === 'sb' && d.characterId === 'eliza').map((d) => d.id));
    expect(elizaIds.length).toBeGreaterThan(0);
    await banner.click();
    await page.getByTestId(/^drift-group-dismiss-all-/).first().click();
    await expect.poll(() => page.evaluate((ids) => {
      const dismissed = (window as unknown as Win).__mockRevisions!.get('sb').dismissed;
      return ids.every((id) => dismissed.includes(id));
    }, elizaIds), { timeout: 10_000 }).toBe(true);
    // Force a fresh poll: leave the book and come back (the active poll fires on arrival).
    await page.goto('/#/');
    await page.goto('/#/books/sb/cast');
    await expect.poll(() => page.evaluate((ids) =>
      (window as unknown as Win).__store__!.getState().revisions.drift.filter((d) => ids.includes(d.id)).length, elizaIds), { timeout: 10_000 }).toBe(0);
  });
  ```
  (The first `dismiss-all` group is the Eliza card per `drift-report-multibook.spec.ts`'s fixture notes; if the order differs, select the group whose testid contains `eliza`.)

  `e2e/revisions-book-switch.spec.ts` (#3397):
  ```ts
  import { test, expect, type Page } from '@playwright/test';
  test.describe.configure({ mode: 'serial' });
  type StoreWin = { __store__?: { getState: () => { chapters: { chapters: Array<{ id: number }> } }; dispatch: (a: unknown) => void } };

  async function markChaptersRendered(page: Page) {
    await page.evaluate(() => {
      const s = (window as unknown as StoreWin).__store__;
      if (!s) throw new Error('window.__store__ not exposed (e2e gate regressed)');
      const chapters = s.getState().chapters.chapters;
      s.dispatch({ type: 'chapters/setChapters', payload: chapters.map((c) => ({ ...c, state: 'done', progress: 1, audioModelKey: 'kokoro-v1' })) });
    });
  }

  test('a Fix-audio take that finishes while on another book is a playable prompt on return', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { (window as unknown as { __mockSpliceDelayMs?: number }).__mockSpliceDelayMs = 2500; });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
    await page.goto('/#/books/cc/cast');
    await expect(page.getByTestId('cast-row-eliza_cc')).toBeVisible({ timeout: 10_000 });
    await markChaptersRendered(page);
    await page.getByTestId('cast-row-eliza_cc').click();
    await page.getByRole('button', { name: /Fix Eliza.*audio \(loudness \/ re-record\)/i }).click();
    await page.evaluate(() => (window as unknown as StoreWin).__store__?.dispatch({ type: 'ui/setOpenProfileId', payload: null }));
    await page.getByRole('button', { name: /Apply to \d+ chapters?/i }).click();
    // Leave for another book before the first chapter's splice completes (2.5 s per step).
    await page.goto('/#/books/sb/listen');
    await expect(page.getByText(/Solway Bay/i).first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __mockRevisions: { get: (b: string) => { pending: unknown[] } } }).__mockRevisions.get('cc').pending.length), { timeout: 30_000 }).toBeGreaterThan(0);
    // Back to book A.
    await page.goto('/#/books/cc/cast');
    await page.getByTestId('status-pill').click();
    const open = page.getByTestId('status-popover-revisions').getByRole('button', { name: /\d+ revisions?/i });
    await expect(open).toBeVisible({ timeout: 10_000 });
    await open.click();
    const player = page.getByTestId('revision-diff-player');
    await expect(player).toBeVisible();
    await expect(player.getByText(/Rendering new take/i)).toHaveCount(0);
  });
  ```

  `e2e/profile-regen-preview-recorded.spec.ts` (finding 11 — the production path: a recorded server entry, not the stub). Copy `openPreviewPlayer`'s steps from `profile-regen-preview.spec.ts` (cast → drawer → regenerate modal → Preview → fast-forward), with one addition before clicking Preview:
  ```ts
  await page.evaluate(() => (window as unknown as { __mockRevisions: { seed: (b: string, s: unknown) => void } }).__mockRevisions.seed('cc', { liveChapterIds: [1, 2, 3] }));
  ```
  then:
  ```ts
  test('a preview render with a recorded entry opens on that server entry; Approve accepts it before fanning out', async ({ page }) => {
    test.setTimeout(45_000);
    const player = await openPreviewPlayerRecorded(page);
    await expect(player).toHaveAttribute('data-mode', 'preview');
    const openRevision = await page.evaluate(() => (window as unknown as { __store__: { getState: () => { ui: { openRevision: { kind: string } | null } } } }).__store__.getState().ui.openRevision);
    expect(openRevision?.kind).toBe('server');
    await player.getByRole('button', { name: /Approve.*regenerate the rest/i }).click();
    await expect(player).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => hasElizaRegenLog(page), { timeout: 10_000 }).toBe(true);
    const timeline = await page.evaluate(() => (window as unknown as { __mockRevisions: { get: (b: string) => { timeline: Record<string, Array<{ eventKind: string }>> } } }).__mockRevisions.get('cc').timeline);
    expect(timeline['1'].map((t) => t.eventKind)).toEqual(['accepted']);
  });
  ```
  (`openPreviewPlayerRecorded` and `hasElizaRegenLog` are copies of the original spec's helpers plus the seed line. The change-log event is only appended after `acceptRevisionOp` resolved `ok` — Task 22 — so "accepted is recorded" is established before the change-log poll can succeed.)

- [ ] **Step 2: Run** `npm --prefix <wt> run test:e2e -- e2e/revision-ops.spec.ts e2e/revisions-book-switch.spec.ts e2e/profile-regen-preview-recorded.spec.ts e2e/profile-regen-preview.spec.ts`. Expected PASS. Run the book-switch spec with `--repeat-each=3`.
- [ ] **Step 3: Mutations** (each must make the named spec red; restore after each):
  1. **Client-side**, leaving the mock store's recording intact: in `revisions-slice.ts` make `applyPoll` merge drift only (skip its `adopt`), **and** in `layout.tsx` dispatch `revisionsActions.hydrate({ bookId, state: null, requestSeq })` at both hydrate sites → `revisions-book-switch.spec.ts` red at `expect(open).toBeVisible` after returning to `cc` (the spec's `__mockRevisions.get('cc')` poll still passes — the mock server recorded the take — but no client path adopts it, so the Status popover offers no revisions). Both halves are needed: either alone leaves the other path to adopt the entry. (A server-side cut such as skipping `mockRecordRender` would also go red, but it tests the mock, not the client cutover.)
  2. In `src/store/preview-thunks.ts` `startPreviewRegen`, drop `review` → `profile-regen-preview-recorded.spec.ts` red at `openPreviewPlayerRecorded`'s player-visible wait (timeout): without `review` the mock render neither records an entry nor stamps `reviewChapter` on `chapter_complete` (Task 11: `reviewChapterId` is `null`), so the runner never dispatches `previewChapterComplete` and no player opens — it is **not** a stub opening in its place.
  3. In `mockPollRevisions`, remove the dismissed filter → `revision-ops.spec.ts` "Dismissing a drift group…" red at the post-poll assertion.
- [ ] **Step 4: Commit.** `test(e2e): cover server-owned accept/reject/dismiss, the book-switch take and a recorded preview (#3397)`.

---

### Task 31: Bookkeeping — release notes, on-box register, plan status, addenda to plans 20, 114 and 176

**Character:** mechanical (docs), **except the live-view publish, which is COORDINATOR-ONLY**: it needs the Artifact tool (publishing to the URL in the register's header), which a dispatched lane does not have. The lane edits the files and stops; the coordinator runs the publish procedure (last bullet of Files).

**Files and content:**
- `docs/release-notes-next.md` — one technical entry (PR-refed): client cutover (no client revisions writes; per-op routes; cache ordered by `fileId`/`rev` with a hydrate sequence guard); #3397; D1/D6/D7/D9; OD20 (legacy stuck takes recoverable while `.previous.mp3` exists, flagged `recovered: true` and labelled "Recovered from before the update"; the A side is the take kept before the chapter's last render, which may predate the stuck take); OD2 (`revisionsError` + one toast); OD26 (`qa-report` GET and `resume-scoring` 500s answer fixed sentences); OD27 (a preview that finished on another book re-opens on return); OD28 (closing a preview player only hides it — the Status popover and the next arrival re-open it; the stub shows only on its own book); OD29 (a recorded preview whose entry is gone on return is dropped with "This preview was resolved elsewhere"; finalize and the three completion ticks report `reviewOutcome: 'recorded' | 'none' | 'failed'` in place of `reviewRecorded`, Task 7); OD30 (a pending entry for the preview's chapter opens as the preview's player instead of a stub, departing from spec §4); OD31 (deleting, re-parsing, replacing or restructuring the preview's book drops the preview; its take stays live); reparse / replace no longer echo the revisions reset's fs error; `restore-unrecorded`; bulk `errors`; fixed 500 sentences for revisions store failures; `GET /state` normalised; `PUT slice:'revisions'` → 400; legacy routes → 410; restructure drop; finalize callers live; incidental fixes (bulk chunking at 50, active-poll catch).
- `RELEASE_NOTES.md` — brand-voice lines in the in-progress version: takes that finish while you're on another book wait for you as normal A/B reviews; a preview that finishes while you're elsewhere opens when you come back, and closing a preview no longer loses it — reopen it from the Status pill; takes stuck on "Rendering…" from before the update become reviewable again, marked "Recovered from before the update", when the take kept before that chapter's last render is still on disk (never call it "the original": it may be an older take); accept/reject only count once the audio change actually happened.
- `docs/testing/onbox-acceptance-register.md` — **mint a new Group A row** (allocate from Group A's `<!-- next-id: A… -->` marker and bump it in the same commit; A9 is the plan-176 splice row and stays, only its "known gap (#3397…)" sentences are replaced by a pointer to the new row). The new row: "Revisions server ownership (plan 286, #3400/#3397)", hardware: GPU box, real sidecar, a real rendered book. Observe:
  1. splice a character → switch books → return: the A/B prompt is there and playable;
  2. accept → the chapter's `.previous.mp3` is gone, Revision History shows "Accepted";
  3. re-splice → reject → the original take is live again, history shows "Rejected";
  4. reject while a generation runs on the book → refused ("busy"), pending unchanged;
  5. a real **profile-regen preview**: Approve fans the rest out; a second preview: Reject restores the original;
  6. a **restructure** (merge two chapters, one with a pending take) → that take disappears from the list;
  7. an **upgraded book's legacy entry** (pending from before the update) can be accepted and, on another, rejected;
  8. a **legacy stuck entry** ("Rendering…" from before the update, `.previous.mp3` present) is now reviewable and shows **Recovered from before the update**, with the A card reading "The take kept before this chapter's last render"; Reject puts that kept take back live (OD20) — record which take that turned out to be, since it may predate the stuck take;
  9. a **preview that finishes while you are on another book**: the "Preview ready in …" toast appears; returning to the book opens the preview player by itself (OD27). Then close it with the back arrow; the Status pill shows it as pending and re-opens it (OD28).
  Criteria live in this plan's "Manual acceptance walkthrough" and the row itself. Run `npm run register:build` and `npm run check:onbox-register`.
- `docs/testing/onbox-acceptance-register-live-view.html` — mirror the new row and the A9 edit (the lane does this edit and commits it).
- **COORDINATOR-ONLY — the live-view publish.** After the lane's commit, the coordinator publishes `onbox-acceptance-register-live-view.html` to the URL in the register's header following its "Live view" four-step procedure (including `check:onbox-register -- --against-published <file>` immediately before publishing), from the branch **after** rebasing on the latest `main`, with the Artifact tool and that URL (never a new artifact; never the `.md`). A lane must not attempt it and must not report it done.
- `docs/features/archive/114-profile-regen-preview.md` — append an addendum: "Plan 286 (2026-10): the preview's pending entry is recorded by the server (`review` on the queue entry); when none is recorded the player opens a client-only stub; Approve fans out only after the server confirmed the accept; a preview that finished on another book re-opens on return, and closing the player only hides it (Status popover and the next return re-open it); a recorded preview whose entry is gone on return is dropped as resolved elsewhere (OD27, OD28, OD29)."
- `docs/features/archive/20-revisions-and-drift.md` — append an addendum: "Plan 286 (2026-10): `revisions.json` is server-owned. The client never writes it (a `PUT /state` with `slice:'revisions'` answers 400); accept / reject / dismiss go through `POST …/revisions/{id}/accept|reject` and `…/drift/{id}/dismiss`; the legacy `…/audio/previous` routes answer 410. The client keeps an ordered cache of server state (plan 285, plan 286)."
- `docs/features/176-character-splice.md` — append an addendum: "Plan 286 (2026-10): a splice's A/B entry is recorded by the server at finalize (`review` with `triggeredBy` `Loudness fix (<first name>)` / `Re-record (<first name>)`); the client no longer enqueues a `splice-<book>-<ch>-<char>` entry or flips it playable, so a splice that fails leaves no stuck "Rendering…" row. On-box: see the new Group A row (A9's #3397 gap now points to it)."
- `docs/features/285-revisions-server-ops.md` — fill "Ship notes" (PR 1 merged `ce142a3c`; PR 2 merged `<sha>`); keep `status: active` (on-box owed) — OD18.
- `docs/features/286-revisions-client-cutover.md` — `status: active`, fill Ship notes; `docs/features/INDEX.md` — flip 286's status word.

- [x] Steps: write each; run `check:onbox-register` and `register:build`; commit `docs(docs): release notes and on-box acceptance for the revisions cutover (#3400)`. Then hand back to the coordinator for the live-view publish (COORDINATOR-ONLY, above).

---

### Task 32: Verify, review gate, PR

**Character:** coordinator (`claude` lane).

- [ ] `npm --prefix <wt> run typecheck`
- [ ] `npm --prefix <wt> run verify:fast:branch` (manual, CLAUDE.md step 7)
- [ ] `npm --prefix <wt> run test:e2e -- e2e/revision-ops.spec.ts e2e/revisions-book-switch.spec.ts e2e/profile-regen-preview-recorded.spec.ts e2e/revision-diff.spec.ts e2e/profile-regen-preview.spec.ts e2e/character-splice.spec.ts e2e/drift-report-multibook.spec.ts`
- [ ] `npm --prefix <wt>/server run test:slow -- src/routes/generation.test.ts src/routes/book-state.test.ts src/routes/chapters-restructure.test.ts`
- [ ] `npm --prefix <wt> run check:cycles`
- [ ] Leftover check, in two parts (pass 4 #3 — two guard tests name deleted things on purpose, so a grep over test files can never be clean):
  - `git -C <wt> grep -n "markRevisionPlayable\|enqueuePending\|hydrateFromBookState.*revisions\|hydratedFor\|bookWiped\|acceptChapterRevision\|rejectChapterRevision\|revisionsPatch\|showRevisionPlayer" -- src e2e server/src ':!src/lib/api-types.ts' ':!*.test.ts' ':!*.test.tsx'` → no hits. (`src/lib/api-types.ts` is excluded because it is generated and keeps the two legacy operations, `acceptChapterRevision` / `rejectChapterRevision`, as `deprecated` 410 entries per Task 29.)
  - The same pattern over `-- '*.test.ts' '*.test.tsx'` → **exactly five hits, in two files**: `src/store/ui-slice.test.ts` ×3 (Task 23's `showRevisionPlayer is gone…` guard test) and `src/store/generation-stream-runner.test.ts` ×2 (Task 24's `never dispatches revisions/markRevisionPlayable` title and its `t.type === 'revisions/markRevisionPlayable'` assertion). Any other hit is a leftover of a deleted API: delete the test, or reword the comment.
- [ ] Push; open the PR (title `fix(frontend,server): revisions.json client cutover to server ownership (#3400)`; body: Summary, Test plan, `Closes #3400`, `Closes #3397`, "Also fixed, found in passing" from Incidental findings, the register row).
- [ ] Run the `pr-review-gate` skill (multi-scope → depth `high`).

---

## Incidental findings (folded in, per CLAUDE.md "Incidental findings")

| Finding | Where | Disposition |
|---|---|---|
| The background bulk poll sends every analysed book in one request; the server rejects more than 50 with 400, so a library with 51+ analysed books never updates background drift. | `layout.tsx` bulk effect vs `routes/revisions.ts` `bookIds.length > 50` | Fixed in Task 19 (chunks of 50). |
| The active-book poll (`layout.tsx ~:1116`) also has no `.catch`. | `layout.tsx` | Fixed in Task 19. |
| Six revisions 500 handlers echo raw store error text (fs errors carry absolute paths), and `qa-report`'s `resume-scoring` echoes its raw error too. | `revision-ops.ts`, `revisions.ts`, `qa-report.ts` (both handlers) | Fixed in Task 3 (OD26 decided `resume-scoring`). |
| Reparse and replace-manuscript echo `resetRevisions`'s raw fs error (PR 1 added that store write to `applyReparse`). | `book-state.ts` `applyReparse` | Fixed in Task 4 (only the revisions arm; parser messages keep their text). |
| `rolledBack` (and its persistence rule) is never dispatched anywhere in `src/` — dead code. | `revisions-slice.ts`, `persistence-middleware.ts` | Deleted in Tasks 25–26. |
| The hand-written `BookStateResponse.revisions` (`src/lib/types.ts:430-445`) lacks `bookId`/`fileId`/`rev`/`timeline`. | `types.ts` | Realigned to the generated type in Task 17. |
| Two plans share the number 285. | `docs/features/` | **Not fixed here.** Draft PR #3516 renumbers `285-analysis-failure-phase-markers.md` → 287; it is held until PR #3505 merges. No clash with 286. |
| Three tests hand-build a full `UiState`, so Task 13's two new required fields break `typecheck` there — not only the `PreviewRegenCtx` literals the earlier draft listed. | `theme-toggle.test.tsx`, `use-theme.test.tsx`, `ui-slice.test.ts` | Fixed in Task 13. |
| Module-level once-per-session sets (`revisionsErrorToasted`, the poll `warnOnce` set) leak across tests and across vitest's `retry: 1` re-run. | `layout.tsx` | Test-only reset exports, called in each describe's `beforeEach` (Tasks 18, 19). |
| Four server test files load their routers with a `Promise.all` of dynamic imports while carrying (or, after this plan, gaining) a hoisted async-factory `vi.mock`. That race can bind the real, unmocked export (#2083). `chapter-audio.test.ts` already had two such mocks, so the race there predates this plan. | `chapter-audio.test.ts ~:63`, `book-state.replace-manuscript.test.ts ~:30`, `book-state.hydrate.test.ts ~:45`, `chapters-restructure.test.ts ~:132` | Fixed in the task that adds each file's mock (Tasks 1, 4, 5, 28): converted to sequential awaits with the `revisions.test.ts:90-94` comment. |

## Open decisions

The operator decided three on 2026-10-06 (OD2, OD20's first form, the hydrate race) and seven more on 2026-10-07 (OD20 revised, OD26, OD27; after assumption-checker pass 3, OD28 and OD29; after pass 4, OD30 and OD31), all recorded as **DECIDED**. The rest carry the default this plan uses.

1. **OD1 — Source of the reopen re-hydrate.** (a) `getBookState` (today's call, now normalised); (b) `api.pollRevisions`. **Default (a).** Cost: one `GET /state` per *arrival at a book* — not per stage change, which Task 18 scopes out (`revisionsReadFor`). For a `ready` book the active poll also fetches immediately on arrival, so the two overlap; the rehydrate is what covers `analysing`/`confirm` stages, where the poll does not run.
2. **OD2 — Unreadable `revisions.json` on `GET /state`. DECIDED (2026-10-06): toast once.** `GET /state` returns `revisions: null` and a path-free `revisionsError` (Task 5: the fixed user sentence, or — through `revisionsFailureText` — a newer-schema file's own "upgrade the server" sentence); the book opens; the client toasts that sentence verbatim, once per book per session (Tasks 5, 18). (The polls are console-only — Task 19, OD24 — so this toast is the user-visible signal.)
3. **OD3 — The hydrate retry loop.** Spec: "the revisions retry loop goes". The loop also retries the full book load. **Default:** keep it for the full-load path only.
4. **OD4 — `restore-unrecorded` serialisation.** **Default:** take the `revision-op` key (same race class as accept/reject).
5. **OD5 — Bulk per-book error text.** **Default:** a fixed path-free sentence.
6. **OD6 — Mock store placement.** **Default:** a separate `src/mocks/mock-revisions.ts` table overlaid onto `getBookState` (mirrors `mock-queue.ts`).
7. **OD7 — Mock "had audio".** **Default:** a `liveChapterIds` set (seeded `sb` = all chapters; grown by every mock render); a splice always counts as having audio.
8. **OD8 — `__mockRevisions` surface.** Spec: `seed(bookId, {state, previousChapterIds})`, `get`. Plan adds `liveChapterIds` and `reset`; splice delay via `window.__mockSpliceDelayMs`.
9. **OD9 — Mock reject never answers `chapter_busy`.** Busy is covered by unit tests. Alternative: read the mock queue for an in-progress entry.
10. **OD10 — Preview clearing scope.** Spec: if the shown entry disappears "and `previewRegen` is set", clear it. **Default:** clear only a preview for that book and chapter — both in the watcher (Task 21) and in the thunks' gone/not-found branch (Task 14).
11. **OD11 — "Keep new take".** **Default:** review mode only, replacing "Commit selection" when A is unavailable; Reject disabled then.
12. **OD12 — Plain `chapter_complete` with a cached entry for that chapter.** **Default:** no extra refetch; the next poll or a `revision_not_found` repairs it.
13. **OD13 — Splice `triggeredBy`.** **Default:** `Loudness fix (<first name>)` / `Re-record (<first name>)`, name resolved through the cast resolver, falling back to the character id.
14. **OD14 — Preview `review.triggeredBy`.** **Default:** `<name> voice change`.
15. **OD15 — Status popover target.** **Default:** `pending[0]` (it only knows a count). D6 is about the preview path, not this button. **Amended by OD28:** when the active book has a preview stub, the popover counts it and opens it first (Task 22). **Amended again, decided in PR #3594 review pass 1:** preview's own entry first (the recorded pending entry for the preview chapter, else the stub), else first pending — the server appends, so `pending[0]` is the oldest take and would bury the preview's Approve.
16. **OD16 — A vanished entry with no preview.** **Default:** close silently.
17. **OD17 — On-box acceptance.** **Default (revised):** a **new Group A row** (A9 is the plan-176 splice row; no row covers the preview path, plan 114 or #3400). A9's #3397 gap text is replaced with a pointer.
18. **OD18 — Plan status after merge.** **Default:** 285 and 286 both `active` with Ship notes until the new row is accepted.
19. **OD19 — Dismiss failure.** **Default:** keep the event and toast.
20. **OD20 — Legacy stuck entries. DECIDED (2026-10-07, revising 2026-10-06's "keep stuck entries recoverable"): keep them recoverable AND label them distinctly.** Read-only normalisation (Task 6): a legacy `playable:false` entry whose `.previous.mp3` exists is surfaced as playable with a server-side flag `recovered: true` (store type, `openapi.yaml` `Revision.recovered`, generated client type); the player shows **Recovered from before the update** and describes A as "the take kept before this chapter's last render" — never "the original" (Task 16; also the Benefit, release notes and register step 8 wording, Task 31). The carrier is the server flag rather than a client derivation because the client cannot tell a stuck legacy entry from any other origin-less one once normalisation has set `playable: true`.
    - **Why "never the original" (the false-premise residual, accepted):** every render preserves `.previous` (`finalize-chapter-write.ts:714`, `preserveExistingAsPrevious`), and a failed splice leaves its `playable:false` entry behind (`splice-runner-middleware.ts:67-79` enqueues it before the stream; `:146` only counts the failure). So any render after the stuck one — before this update, which never dropped entries — can have replaced `.previous` with an unrelated older take: the pair the user reviews may not be the pair the entry describes. The label says so; Reject still restores whatever take was kept.
    - **Persistence:** the next unrelated store write (any accept / reject / dismiss / record on that book) persists the normalised view, so the entry lands on disk as `playable: true, recovered: true`; the flag keeps the label alive across that write (Task 6 test). Reversibility 9.
    - **Residual still accepted:** legacy ids (`revision:<ch>:<char>`, `splice-<book>-<ch>-<char>`) are not per-recording, so a stale tab could act on a different legacy take with the same id.
21. **OD21 — `previewChapterComplete`** is a bare `createAction` exported from `chapters-slice.ts`.
22. **OD22 — `forgetBook` leaves that book's drift.** Spec literal; pre-existing linger until reload.
23. **OD23 — Preview refetch retry.** **Default:** one retry after 1000 ms.
24. **OD24 — Bulk/active poll failures in the UI.** **Default:** console only (once per book / per message per session).
25. **Hydrate race. DECIDED (2026-10-06): sequence guard** (`adoptSeq` / `requestSeq`, Tasks 12, 18). A hydrate whose read started before the latest op/poll adoption that **changed** `(bookId, fileId, rev)` is dropped; the next poll repairs anything it carried. An equal-version (no-op) adoption does not bump `adoptSeq` (assumption-checker pass 2), so a routine poll at the same `rev` cannot make an in-flight hydrate look stale.
26. **OD26 — `qa-report` 500 text. DECIDED (2026-10-07): fixed sentences for both handlers.** Task 3 curates the GET (`qa-report.ts ~:47`, via `revisionsFailureText`) and `resume-scoring` (`~:73`, a plain fixed sentence — not a store path) and logs the raw error; it flips #3527's `a non-lock failure keeps its own message` test and `qa-report.test.ts`'s `returns 500 when the underlying lookup throws` (`~:150`, `'disk read failed'`). Supersedes the earlier "flag for a follow-up" disposition.
27. **OD27 — A preview that finished with no recorded entry while the user was elsewhere. DECIDED (2026-10-07): re-open on arrival.** The completion marks the preview finished (`previewRegen.completed`). When the user next arrives at `previewRegen.bookId` with no player open, the middleware runs the same `openPreview` refetch-or-stub path, once that book's chapters have loaded (Task 24). Each later arrival re-opens it until Approve / Reject clears the preview. **Amended by OD28 and OD29 (2026-10-07):**
    - `completed` is now set on **every** completion, not only the non-active one (OD28).
    - The arrival path drops a *recorded* preview whose entry is gone, rather than re-opening a stub (OD29).
    - The original text said only the non-active branch marks the preview. That is superseded.
28. **OD28 — Closing a stub player. DECIDED (2026-10-07): keep it re-openable.** Closing (back arrow / X) only hides the player (`setOpenRevision(null)`); `previewRegen` and its stub stay. Concretely:
    - **Status popover.** The stub is counted and opened from the Status popover without entering the cache: Invariant 6, `selectActivePreviewStub`, Tasks 13 and 22. OD15 is amended so the stub comes first.
    - **Every completion is marked.** `previewRegen.completed` is set on **every** completion, including the active-book one. So an arrival at the book re-opens a preview whose player was closed, never opened, or could not be built (Task 24).
    - **No silent strand.** `openPreview`'s early returns no longer strand it:
      - the user left the book mid-refetch → returns with the marker kept;
      - the chapter or character is not loaded → `console.warn`, marker kept;
      - the user opened a player, or moved to another book, during `openPreview`'s awaits → returns without opening, marker kept (pass 4 A1);
      - the preview was resolved or replaced meanwhile → nothing left to open.
    - **Book scope (pass 3 #1).** The stub is shown only on its own book. Navigating away hides it and never clears it (Task 21 rule 2; Task 22's `shownRevision`).
    - **A server entry wins (pass 3 #11).** When a server entry for the preview chapter reaches the cache, it supersedes the stub (Task 21 rule 1).
    - Approve / Reject still resolve it.
29. **OD29 — A recorded preview whose server entry is gone. DECIDED (2026-10-07): treat as resolved, drop it, and the server reports the outcome (option (b)).** Two decisions, both dated 2026-10-07.
    - **Drop, never stub.** When the completion said the server **recorded** an entry and the refetch finds none, `openPreview` clears `previewRegen` and toasts `This preview was resolved elsewhere`, the existing copy (Task 24). It does **not** open a stub: the stub's Reject (`restore-unrecorded`) could put the preview take back over a newer render, which dropped the entry (`finalize-chapter-write.ts ~:798`). This holds on arrival and on the book itself, since in both cases the entry existed and is gone.
    - **The server says which outcome happened.** PR 1's `reviewRecorded: true` meant both "recorded an entry" and "nothing to review". A first render, or `review: null`, drops the chapter's entry and answered `true` too (`applyReview`, `finalize-chapter-write.ts:773-805`). So on a delayed arrival the client could not tell a first render from a resolved preview. The operator chose option (b), the server reporting it. Task 7 replaces the boolean with `reviewOutcome: 'recorded' | 'none' | 'failed'` on finalize's result and on the three completion ticks (contract `ReviewOutcome`), and the mock does the same (Task 11). PR 1 shipped the field dark, so the breaking rename is safe.
    - **The client keys on that signal (Task 24):**
      - `'recorded'` → refetch. If the entry is there, open it. If it is gone, drop with the toast. If the refetch fails twice, open a stub when the completion was seen on its own book (`stubFallback`, OD23); otherwise keep the marker for the next arrival.
      - `'none'` (a first render: nothing to review) → the stub is the legitimate player, with no refetch, and it re-opens on every arrival per OD28.
      - `'failed'` (the take was preserved, but no entry was recorded) → the stub, whose Reject calls `restore-unrecorded`.
    - Rejected alternatives: (a) accept a gap where a first-render preview finishing elsewhere would be dropped; (c) discriminate on `.previous`; (d) infer "first render" on the client at preview start.
30. **OD30 — An existing entry for the preview's chapter wins over the stub. DECIDED (2026-10-07, after assumption-checker pass 4).** When `openPreview` is about to build a stub and the active cache already holds an entry for the preview's chapter, that entry opens as the preview's player: `openRevision` `{ kind: 'server' }`, the preview kept (so the layout shows it in preview mode and Approve runs the preview's fan-out after the accept, Task 22). This applies to **every** outcome: `'none'`, `'failed'`, and `'recorded'` after a doubly-failed refetch with `stubFallback` (a `'recorded'` refetch that succeeds already opens the entry directly).
    - **Why:** it is rule 1's rationale (Task 21: a server entry supersedes the stub) applied at build time instead of after it, and it fits the server's `has_revision` guard — the stub's Reject (`restore-unrecorded`) would be refused while that entry exists anyway.
    - **Matching is by `chapterId` alone, deliberately** (pass 4 #9). Neither the lookup nor rule 1 checks `characterId`, `triggeredBy` or the id, so any pending entry for the chapter — including an older one the preview did not produce — becomes the preview's player. This is the decision, not an accident; it is listed as a residual under Out of scope, with what a stale cached entry does.
    - **The race it closes (and how).** `openPreview` used to dispatch `setPreviewRegen({ …stub })` and then `setOpenRevision({ kind: 'preview-stub' })`. Between the two, the watcher's rule 1 (an entry for the chapter, no player open) dropped the stub, and on the second dispatch rule 2 hid the stub player: nothing opened, and no toast said why. Now one action, `uiActions.openPreviewStub` (Task 13), sets the stub and opens it, so the watcher's single pass over it sees the stub player already open and rule 1 switches it to the entry (Tasks 21, 24). There is deliberately no second, separate entry lookup before the build: one mechanism (the atomic open plus rule 1), pinned by an integration describe that runs the generation middleware and the watcher in one store (Task 24, mutations 18–19).
    - **Departs from spec §4** (`docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md:364`: "When `reviewRecorded:false` and an older stale entry for the chapter survives, the stub is opened anyway"). Recorded under "Spec points … contradicts" below.
31. **OD31 — A book reset clears the preview. DECIDED (2026-10-07, after assumption-checker pass 4).** Re-parsing, replacing the manuscript of, restructuring the chapters of, or deleting `previewRegen.bookId` clears `previewRegen` (`uiActions.clearPreviewForBook`, a no-op for any other book). The preview's new take stays as the chapter's audio: nothing is restored or rejected. Sites (Task 26): `onDeleteBook`, `onReplaceManuscript` and `onReparseBook` in `src/routes/index.tsx`, each beside its `forgetBook`; and `applyResponse` in `src/views/restructure.tsx`, which every restructure operation (merge, split, reorder, exclude, refresh titles) runs after the server applied it. One test per site plus the reducer's book scope, each with a mutation (Task 26, mutations 5–9).
    - **Why:** after a reset the preview's `previewChapterId` may name a different chapter, and the server has dropped any pending entry for the touched chapters (Task 28 for restructure; the reset for the others), so neither the stub nor a server entry can be resumed meaningfully. Without the clear, OD27/OD28's re-open would offer a stale preview on the next arrival.

## Spec points that PR 1's merged code (or the code on `main`) contradicts

- §3 places `mockQueueRequest` in `queue-thunks.ts:36`; it is in `src/mocks/mock-queue.ts`.
- §4 places the timeline modal in `src/modals/`; it is `src/components/revision-timeline-modal.tsx`.
- §4 deletes `rolledBack` as if live; it is never dispatched.
- §4 "the revisions retry loop goes" — shared with the full-book load (OD3).
- §4 `restore-unrecorded` predates PR 1's per-chapter serialisation (OD4).
- §4 is silent on `GET /state` with an unreadable file (OD2, now decided).
- §4's `hydrate` rule ("a different `fileId` adopts, null included") is unsafe on its own for a legacy book: a read started before the first op returns `fileId:null` after the op minted one, and would erase the new entry. The sequence guard closes it.
- §1/§2 "keep legacy `playable:true` entries only" left #3397's stuck takes unrecoverable; OD20 widens it. And once stuck entries are kept, §1's plain "keep the LAST entry per chapter" lets a failed splice shadow a playable take; Task 6 adds the #5 rule.
- PR 1's `reviewRecorded` boolean answered `true` for both "recorded an entry" and "nothing to review" (a first render). Spec §4 (`:342`) papered over that with a refetch, but on a delayed arrival the refetch cannot tell those apart from "recorded, then resolved elsewhere". Task 7 replaces it with `reviewOutcome` (OD29).
- §4 (`:364`) says that when an older stale entry for the chapter survives, "the stub is opened anyway". OD30 (operator decision, 2026-10-07) departs from it deliberately: an existing entry for the preview's chapter opens as the preview's player instead, for every review outcome, matched by chapter alone. The spec's rule also raced the player watcher this plan adds (Task 21): the stub and its open landed in two dispatches, and with a cached entry the watcher dropped the stub between them, so nothing opened. Tasks 13, 21 and 24.
- D9 misses the 50-book cap and the active poll's missing `.catch`.
- PR 1's "unexpected 500 keeps the error's own message" (plan 285 Reversibility 3) conflicts with the client toasting it; Task 3 curates.
- The CLAUDE.md lines PR 2 makes false are not in the spec's Delivery: the swallow list (FIVE → SIX, Task 28) and the explicit `LOCK_CONTENTION_REQUEST_ERROR` branch list (Task 1 adds `restore-unrecorded`; Task 29 removes the two legacy routes), plus the `revision-op` serialisation sentence (Task 29). The `requestFailureMessage` count is **unchanged** (delta 0 — Global Constraints); an earlier draft of this plan raised it at two lock-free sites, which was a misuse of the seam.
- "PR 2 about 7 children" — at the 30–45-minute task size it is 32 dispatches (31 lane tasks plus the coordinator's Task 32; Task 31's live-view publish is coordinator-only).

## Reversibility / observable changes

Revert the PR. Everything PR 2 changes that a user, an old client or an operator can observe:

1. **The client never writes revisions.json.** An old tab's revisions `PUT` gets `400 revisions_server_owned`, logged to its console only. Disk is unchanged.
2. **The legacy `DELETE …/audio/previous` and `POST …/audio/previous/restore` answer `410 moved`.** An old tab's Accept/Reject toasts an error; nothing on disk changes.
3. **Every render records or drops A/B state on the server:** a splice records an entry; a plain generation or QA repair drops the chapter's entry; a preview render records one when the chapter already had audio.
4. **Restructure drops pending entries** for every chapter it touched.
5. **`GET /state`'s `revisions` is normalised** (no `drift`, no `schema`; stale legacy entries filtered); `null` plus `revisionsError` when unreadable (the book still opens; one toast).
6. **`GET /api/revisions` gains `errors`** and no longer fails as a whole for one bad book.
7. **Revisions 500s answer fixed sentences** instead of the error's own text — and so do `qa-report`'s two handlers (OD26) and the reparse / replace revisions reset (Task 4). A newer-schema file still answers its own "upgrade the server" sentence.
8. **New route** `POST …/audio/previous/restore-unrecorded`.
9. **Legacy pending entries are visible and actionable**, including stuck `playable:false` ones whose `.previous.mp3` exists, flagged `recovered: true` and labelled "Recovered from before the update" (OD20). Reading writes nothing, but **the next unrelated store write on that book persists the entry as `playable: true, recovered: true`**, so after a revert the old client sees it as an ordinary playable take (the label is gone; its A side may still be an older take than the entry describes).
10. **Mock mode:** the seeded `sb` revision is the only pending revision in the mock workspace; mock previous audio exists only where a mock render preserved it; dismissed drift stays dismissed.
11. **Client:** deleting, re-parsing or replacing a book's manuscript forgets that book's revisions cache; a preview that finished on another book re-opens when the user returns to it (OD27); closing a preview player only hides it, and the Status popover counts and re-opens it (OD28); a recorded preview whose entry is gone on return is dropped with a notice (OD29); a pending entry for the preview's chapter opens as the preview's player instead of a stub (OD30); deleting, re-parsing, replacing or restructuring the preview's book drops the preview, leaving its take live (OD31).
12. **`reviewRecorded` → `reviewOutcome`** on finalize's result and on the `splice_complete`, `qa_repair_complete` and generation `chapter_complete` SSE frames (Task 7). PR 1 shipped the boolean dark, with no client consumer, so only an out-of-tree SSE reader would notice; a revert restores the boolean.

A revert restores the client writer while leaving PR 1's store in place; entries the server recorded during PR 2's lifetime (`origin:'server'`) are read by the old client's hydrate as ordinary pending entries.
