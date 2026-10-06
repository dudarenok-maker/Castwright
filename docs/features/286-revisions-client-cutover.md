---
status: draft
shipped: null
owner: null
---

# 286 — revisions.json server-owned, PR 2: the client cutover (#3400, #3397)

> Status: draft (revision 2 — assumption-checker pass 1 folded, plus three operator decisions of 2026-10-06). PR 2 of 2. PR 1 (plan [285](285-revisions-server-ops.md), PR #3504, merged `ce142a3c`) landed the server half dark. This plan switches the client over and turns the server switches on.
>
> Key files:
> - Client, new: `src/store/revisions-thunks.ts`, `src/store/preview-thunks.ts`, `src/store/revision-player-middleware.ts`, `src/mocks/mock-revisions.ts`, `src/lib/revision-op-failure.ts`, `src/lib/build-preview-stub.ts` (renamed from `build-pending-revision.ts`).
> - Client, modified: `src/store/revisions-slice.ts`, `src/store/ui-slice.ts`, `src/store/chapters-slice.ts`, `src/store/splice-slice.ts`, `src/store/splice-runner-middleware.ts`, `src/store/generation-stream-runner.ts`, `src/store/generation-stream-middleware.ts`, `src/store/persistence-middleware.ts`, `src/store/index.ts`, `src/components/layout.tsx`, `src/components/revision-timeline-modal.tsx`, `src/views/revision-diff.tsx`, `src/lib/use-ab-playback.ts`, `src/lib/api.ts`, `src/lib/types.ts`, `src/routes/index.tsx`, `src/main.tsx`, `src/data/revisions.ts`.
> - Client, deleted: `src/store/revisions-scope-middleware.ts` (+ its test).
> - Server, modified: `server/src/routes/chapter-audio.ts`, `server/src/routes/revisions.ts`, `server/src/routes/revision-ops.ts`, `server/src/routes/qa-report.ts`, `server/src/routes/book-state.ts`, `server/src/routes/chapter-splice.ts`, `server/src/routes/chapter-qa-repair.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapters-restructure.ts`, `server/src/workspace/restructure.ts`, `server/src/workspace/revisions-store.ts`, `server/src/workspace/cast-lock.ts` (comment), `server/src/audio/previous-audio.ts` (comment).
> - Contract: `openapi.yaml`, `src/lib/api-types.ts` (generated).
> - e2e: new `e2e/revision-ops.spec.ts`, new `e2e/revisions-book-switch.spec.ts`, new `e2e/profile-regen-preview-recorded.spec.ts`; modified `e2e/profile-regen-preview.spec.ts`, `e2e/character-splice.spec.ts`, `e2e/marketing/scenes.ts`.
>
> URL surface: none new. The A/B player (`RevisionDiffPlayer`) and the Status popover's revisions action change behaviour.
>
> OpenAPI operations:
> - New: `POST /api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded`.
> - Changed: `GET /api/revisions` (gains `errors`), `GET /api/books/{bookId}/state` (`revisions` normalised, gains `revisionsError`), `PUT /api/books/{bookId}/state` (`slice:'revisions'` → 400), `DELETE …/audio/previous` and `POST …/audio/previous/restore` (→ 410).
> - First client callers: `POST …/revisions/{revisionId}/accept`, `…/reject`, `POST …/drift/{driftId}/dismiss`.

## Benefit / Rationale

- **User:**
  - A Fix-audio or preview take that finishes while you are on another book (or the Library) shows up as a normal, playable A/B prompt when you come back (#3397: no more stuck "Rendering…" rows, no more lost prompts). Takes already stuck "Rendering…" from before the update become reviewable again when their original audio is still on disk (OD20).
  - Accept and Reject only change the Revision History once the audio step actually succeeded (D1). A refused Reject no longer says "rejected".
  - A preview opens the player on the take that preview produced, so Approve always runs the preview's fan-out (D6). (The Status popover still opens the first pending take — OD15.)
  - One broken book no longer freezes the background drift badges of every other book (D9), and an unreadable review-history file is reported once instead of silently hiding every pending take (OD2).
- **Technical:** the client stops writing `revisions.json` at all. It becomes a cache of server state, ordered by `fileId`/`rev` and guarded against stale hydrates, so a stale tab or a slow response can no longer erase disk (#3400). About a dozen pieces of #3395's guard machinery are deleted.
- **Architectural:** one writer per file. The persistence middleware loses the whole-file-replace rule set that raced the server. The server's `review` seam (PR 1) goes live for splice, QA repair, generation and restructure.

## Architectural impact

- **New seams:**
  - `revisions-thunks.ts`: confirm-then-apply operations (`acceptRevisionOp`, `rejectRevisionOp`, `dismissDriftOp`, `refetchActiveRevisions`).
  - `preview-thunks.ts`: `startPreviewRegen`, `approvePreviewSideEffects`, `restoreUnrecordedPreview`.
  - `ui.openRevision` (`{kind:'server', revisionId, chapterId} | {kind:'preview-stub'} | null`) and `ui.revisionOpInFlight`.
  - `revisions.adoptSeq` + `hydrate({ requestSeq })`: the hydrate sequence guard.
  - `chapters/previewChapterComplete` (a `createAction`, no reducer).
  - `splice.inFlightChapters`.
  - `src/mocks/mock-revisions.ts` + `window.__mockRevisions` + `window.__mockSpliceDelayMs`.
- **Invariants preserved:** OpenAPI stays the type source (the hand-written `BookStateResponse.revisions` is realigned to it, Task 15); every field added to an existing schema stays optional; the cast-lock rules (the revisions lock stays a leaf; `revision-op` → `revisions`); RTK Immer reducers; the discriminated `ui.stage`.
- **Migration:** none on disk. Legacy (origin-less) entries are normalised on read; they are shown to the user and accept/reject correctly (PR 1 commit `7d39752e`). A legacy `playable:false` entry whose `.previous.mp3` still exists is now surfaced as playable (read-only normalisation change, Task 5), so the #3397 "stuck" takes are recoverable.
- **Reversibility:** revert the PR. See "Reversibility / observable changes" at the end.

## Invariants to preserve

1. **No `PUT /state` with `slice:'revisions'` is ever sent.** `StateSlice` (`src/lib/types.ts`) does not include `'revisions'`; `persistence-middleware.ts` has no `revisions/*` rule. Pinned by `src/store/persistence-middleware.revisions-never-put.test.ts` (Tasks 21, 22).
2. **The revisions cache only adopts a payload in order.** Different book → adopt. Same book: a newer `fileId` adopts, an older one is ignored (`null` is oldest), equal `fileId` ignores a lower `rev`. `hydrate` additionally adopts on any `fileId` difference — **unless** an op/poll adopted state after that hydrate's request started (the sequence guard). Pinned in `revisions-slice.cache.test.ts` (Task 10) and `layout.test.tsx` (Task 15).
3. **Callers dispatch `applyPoll` / `applyServerState` only for the active book**, read at dispatch time. Pinned in the thunk tests (Task 12).
4. **Selectors return empty for a non-active book** (`selectActivePending`, `selectActiveTimeline`, `selectActiveAcceptedSelections`).
5. **Preview side effects (fan-out, change-log entry) run only after the accept succeeded**, and the fan-out targets `previewRegen.bookId`.
6. **The preview stub never lives in the revisions cache** — only in `ui.previewRegen.stub` — and is routed by `ui.openRevision.kind`, never by id or by a missing `origin`.
7. **The A/B player releases both `<audio>` elements before any op is sent, and re-attaches them on the next play** (Windows file handles; a refused op leaves the player usable).
8. **Server: no store error text reaches a client body.** Every revisions whole-request 500 answers a fixed sentence (or `UnsupportedSchemaError`'s own path-free sentence); the raw error goes to the log. Covers `revision-ops.ts` ×3, `revisions.ts` ×2 (+ the bulk per-book `errors`), `qa-report.ts`'s GET, `restore-unrecorded`, `GET /state`'s `revisionsError`, and the restructure drop (swallowed). The client's "unexpected" toast is a fixed sentence too.
9. **Server: `restore-unrecorded` never writes revisions.json**, and takes the per-chapter `revision-op` key around the audio step.
10. **Server: normalisation never writes.** OD20's change only widens what the read view keeps.

## Test plan

### Automated coverage

- **Slice cache + sequence guard** (`src/store/revisions-slice.cache.test.ts`, Task 10; `revisions-slice.test.ts` poll cases, Task 16).
- **API, real** (`src/lib/api-revision-ops.test.ts`, Task 7) and **mock** (`src/mocks/mock-revisions.test.ts`, Task 6; `src/lib/api.mock-revisions.test.ts`, Tasks 7–9); **mock/real signature parity** (`api-types.revisions-contract.test.ts`, Task 7).
- **Thunks** (`src/store/revisions-thunks.test.ts`, Task 12; `src/store/preview-thunks.test.ts`, Task 13).
- **Player watcher** (`src/store/revision-player-middleware.test.ts`, Task 18).
- **Revision-diff view** (`src/views/revision-diff.test.tsx`, Task 14).
- **Layout** (`src/components/layout.test.tsx`, Tasks 15, 16, 19).
- **Splice runner** (`splice-runner-middleware.test.ts`, Task 17); **generation runner + middleware** (`generation-stream-runner.test.ts`, `generation-stream-middleware.test.ts`, Task 20).
- **No revisions PUT** (`persistence-middleware.revisions-never-put.test.ts`, Tasks 21–22).
- **Server:** `chapter-audio.test.ts` (Tasks 1, 25), `revisions.test.ts` (Tasks 2, 3), `revision-ops.test.ts` (Tasks 3, 5), `qa-report.test.ts` (Task 3), `book-state.hydrate.test.ts` (Tasks 4, 25), `revisions-store.test.ts` (Tasks 1, 5, 24), `chapter-splice.test.ts`, `chapter-qa-repair.test.ts`, `generation.test.ts` via `test:slow` (Task 23), `restructure.test.ts` + `chapters-restructure.test.ts` via `test:slow` (Task 24).
- **Playwright** (mock mode): `e2e/revision-ops.spec.ts` (accept / reject / dismiss through the UI), `e2e/revisions-book-switch.spec.ts` (#3397), `e2e/profile-regen-preview-recorded.spec.ts` (a preview with a recorded server entry), Task 26; `profile-regen-preview.spec.ts` without its workaround (Task 20); `character-splice.spec.ts` waits for the refetch (Task 17).

### Manual acceptance walkthrough

Mock mode (`npm run dev:mock`):
1. Open **Solway Bay** (`#/books/sb/listen`). Status pill → **1 revision** → the player opens on chapter 3 in review mode, A and B both playable.
2. **Commit selection** → the player closes, the Status pill shows no pending revisions, and **Revision history** lists "Accepted revision" for chapter 3.
3. Reload. From the console: `window.__mockRevisions.seed('sb', { state: { pending: [{ id: 'rev1', chapterId: 3, characterId: 'eliza', segments: [], playable: true, hasPreviousAudio: true, origin: 'server' }] }, previousChapterIds: [3], liveChapterIds: [3] })`. Reopen the player → **Reject draft** → closes; history shows "Rejected revision".
4. Open **Carrick's Compass** cast, mark chapters rendered (as `character-splice.spec.ts` does), set `window.__mockSpliceDelayMs = 3000`, **Fix audio**, go to Solway Bay before it finishes, then back to Carrick's Compass → the Status pill shows the new take, and it is playable.

Real backend: owed as on-box acceptance — a **new** register row (Task 27) plus the existing A9 steps that #3397 changes.

## Out of scope

- The chapter take lifecycle (#3456): every audio-file behaviour stays exactly as PR 1 left it.
- Any multi-step rollback; the `rolled-back` timeline kind stays renderable but nothing writes it.
- Writing anything to disk to migrate legacy entries (OD20 is read-only).
- **Two concurrent previews on different books** (residual, pre-existing): `ui.previewRegen` is a single slot, so starting a preview on book B while A's preview renders replaces A's context and A's Approve no longer fans out. Unchanged by this PR; the fan-out now at least targets the right book (`previewRegen.bookId`).

## Ship notes

(Filled in when PR 2 merges — see Task 27.)

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
- **No task runs a full battery** (`npm run test`, `test:server`, `test:all`, `verify`, `build`, whole-tree lint). Each task runs its own files plus `typecheck`. Task 28 runs the broader check; cloud `verify.yml` is the authoritative gate.

### Ordering rule

Every task's commit leaves `npm run typecheck` and that task's tests green, and does not break a test elsewhere:
- New reducers/functions are **added** before callers switch to them; old ones are **deleted** only after the last caller is gone (Tasks 21–22).
- A task that changes behaviour some other test pins (a layout test, an e2e spec) updates that test **in the same task**, and names it.
- **The preview path is migrated in this order** so `e2e/profile-regen-preview.spec.ts` stays green at every commit: the stub thunks exist (Task 13) → the watcher exists (Task 18) → the layout routes both kinds, and the old completion trigger opens the stub as `kind:'preview-stub'` (Task 19) → the new trigger replaces it (Task 20).
- Server switches (Tasks 23–25) come after the client stops using the old paths.

### What PR 1 actually shipped (read before any task)

- **Per-chapter serialisation.** Accept/reject run inside `withKeyLock(revisionOpLockKey(bookDir, chapterId))` (`revision-op:<resolved bookDir>:<chapterId>`), with the `revisions` leaf lock taken inside for steps 1 and 3. Lock order `revision-op` → `revisions`.
- **Legacy entries commit.** `commitRevisionOp` looks its entry up in the stored view first (`stored.pending.find(...) ?? file.pending.find(...)`, `revisions-store.ts:387-389`).
- **Legacy-route lock curation.** The legacy `DELETE …/audio/previous` and `POST …/audio/previous/restore` answer `LOCK_CONTENTION_REQUEST_ERROR` on a lock timeout. Task 25 retires both routes (410), so those branches go.
- **Error body shape.** Coded errors: `{ error: <code>, message, state? }` (`RevisionOpError`, `openapi.yaml:7168`). Unexpected 500s: `{ error: <message> }` with no `message` field. **Before Task 3** that message can be raw `(e as Error).message` — Task 3 fixes it.
- **Finalize.** `applyReview` (`finalize-chapter-write.ts:773`) already implements the tri-state; PR 2 only changes what callers pass.
- **Client plumbing.** `review` already rides `EnqueueInput` → queue entry → `StreamOpenOpts` → `StreamArgs` → POST body (PR 1 Task 11). The mock queue is `src/mocks/mock-queue.ts`.
- **CLAUDE.md count.** `git grep -c "requestFailureMessage(" -- 'server/src/**/*.ts' ':!*.test.ts'` sums to **21** on `3587e132`: 20 call sites plus the definition in `workspace/file-lock.ts`. CLAUDE.md states the **call-site** count (20). Every task below that adds a site gives both numbers.

### Error codes the client handles

`invalid_selection` (400), `book_not_found` / `revision_not_found` / `not_found` (404), `chapter_busy` / `no_previous_audio` / `live_audio_missing` / `revision_gone` / `has_revision` (409), `restore_failed` / `lock_contention` (500), `revisions_server_owned` (400, PUT only), `moved` (410, legacy routes only). Any other body is "unexpected".

### User-facing copy (exact strings)

| Key | Kind | Text |
|---|---|---|
| busy | warn | `This chapter is busy — try again when it finishes` |
| no previous | warn | `Original audio not preserved` |
| gone / not found | warn | `This take was replaced by a newer render` |
| live missing | error | `This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it` |
| restore failed | error | `Couldn't restore the original — try Reject again` |
| resolved elsewhere | info | `This preview was resolved elsewhere` |
| splice unrecorded | warn | `The new take is live, but its A/B review couldn't be saved` |
| has revision | warn | `This chapter has an older pending review — resolve it from the chapter's review first` |
| preview elsewhere | info | `Preview ready in ‹book title›` |
| unexpected | error | `Couldn't update the revision — try again` |
| dismiss failed | error | `Couldn't dismiss the drift event — try again` |
| revisions unreadable (OD2) | warn | `This book's A/B review history couldn't be read, so its pending reviews aren't shown` |

### Commits

- Each task commits on its own, in the foreground, with the message in its last step. Never `--no-verify`.
- Subject `<type>(<scope>[,<scope>]): <subject>`, ≤100 chars, scopes from `frontend|server|mocks|openapi|e2e|docs`.
- Each commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the dispatching session's attribution line).

### Mutation checks

Every task ends with mutation checks. For each: make the named change, run the named test with `--retry=0`, observe the **named** test go red **for the stated reason**, restore byte-for-byte, re-run green, and confirm `git -C <wt> diff --stat` shows only the task's own files. A mutation that stays green is a finding to report, never something to paper over.

### Task character

Each task header says **mechanical** or **judgment**. The operator assigns lanes at decompose time.

## Review Focus

1. **Coming back to a book after a take finished elsewhere (#3397).** The browser outcome is pinned by `e2e/revisions-book-switch.spec.ts` (Task 26), whose mutation cuts the server→client path (the mock splice stops recording). The specific mechanism — every reopen re-reads revisions — is pinned by the layout unit test "reopening a book always re-hydrates revisions" (Task 15). (The active poll also fetches immediately on reopen of a `ready` book, so the e2e alone cannot isolate the rehydrate.)
2. **Two tabs on one take.** Tab 1 accepts; tab 2's poll removes the entry its player shows. The player must close, and a preview tied to that chapter must clear with one "resolved elsewhere" toast. Pinned in `revision-player-middleware.test.ts` (Task 18).
3. **A legacy on-disk entry** (no `origin`, id `revision:3:eliza` or `splice-…`) opens as a server entry and accept/reject go through the route. Pinned in `revisions-thunks.test.ts` (Task 12) and the layout player test (Task 19); a stuck legacy `playable:false` take is recoverable (Task 5).
4. **Many books / one broken book in the background poll.** More than 50 analysed books, or one failing book, must not stop drift for the others. Pinned in the layout poll tests (Task 16) and `revisions.test.ts` (Task 2).
5. **A slow book-open read racing the user's first op on a legacy book** (`fileId:null`): the stale snapshot must not erase the entry the op just recorded. Pinned in `revisions-slice.cache.test.ts` and the layout race test (Tasks 10, 15).

---

### Task 1: Server — `restore-unrecorded` route

**Character:** judgment (route ordering and curation).

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (add `hasPendingForChapter`).
- Modify: `server/src/routes/chapter-audio.ts` (new route, after the `POST …/audio/previous/restore` handler).
- Modify: `openapi.yaml` (new path), then regenerate `src/lib/api-types.ts`.
- Modify: `CLAUDE.md` (count + branch list).
- Test: `server/src/routes/chapter-audio.test.ts`, `server/src/workspace/revisions-store.test.ts`, `src/lib/api-types.revisions-contract.test.ts`.

**Interfaces:**
- Produces: `hasPendingForChapter(bookDir: string, chapters: readonly ChapterRef[], chapterId: number): Promise<boolean>` (lock-free, normalised view; throws like `readRevisions`).
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

  (b) `chapter-audio.test.ts` — add `readFileSync`, `existsSync`, `rmSync` to its `node:fs` import if missing, and inside `describe('preserved previous audio', …)`:
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
    it('an unreadable revisions.json answers a fixed 500 without the path', async () => {
      resetAudio(); writeMp3(); writePreviousMp3();
      mkdirSync(revisionsFile()); // a directory: readJson fails with EISDIR and a path in its message
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request(app).post(RU());
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Couldn't read this chapter's review state." });
        expect(res.text).not.toContain(workspaceRoot);
        expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);
      } finally { errSpy.mockRestore(); rmSync(revisionsFile(), { recursive: true, force: true }); }
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

- [ ] **Step 3: Implement the route** in `chapter-audio.ts`, directly after the `…/audio/previous/restore` handler. Add `hasPendingForChapter` to the `revisions-store.js` import and `requestFailureMessage` to the `file-lock.js` import.
  ```ts
  /* Plan 286 (#3400 PR 2) — restore `.previous` for a preview whose A/B review
     was never recorded (finalize answered reviewRecorded:false). Keeps the
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
        return res.status(500).json({ error: requestFailureMessage(e, "Couldn't read this chapter's review state.") });
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
        return res.status(500).json({ error: 'restore_failed', message: "Couldn't restore the original — try Reject again." });
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
        `reviewRecorded: false`. Busy check first, then the chapter lookups.
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

- [ ] **Step 5: CLAUDE.md chore.** In the lock paragraph: "enumerates all twenty sites" → "all twenty-one sites", add `chapter-audio` (`restore-unrecorded`) to the parenthesised list, and add `restore-unrecorded` to the sentence listing explicit `LOCK_CONTENTION_REQUEST_ERROR` branches ("… and of `restore-unrecorded` in `chapter-audio.ts`"). Check: `git -C <wt> grep -c "requestFailureMessage(" -- 'server/src/**/*.ts' ':!*.test.ts'` now sums to **22** (21 sites + the definition).

- [ ] **Step 6: Green.**
  Run: `npm --prefix <wt>/server run test -- src/routes/chapter-audio.test.ts src/workspace/revisions-store.test.ts`
  Run: `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts`
  Run: `npm --prefix <wt> run typecheck`

- [ ] **Step 7: Mutations.**
  1. Move the `hasPendingForChapter` block below the `withKeyLock(… restorePreviousAudio …)` call → red: `409 has_revision when …` (`.previous` already consumed when the refusal comes).
  2. Move the `isGenerationActive` check below the chapter-id parse → red: `409 chapter_busy during generation, checked before the chapter-id parse` (gets 404).
  3. Replace the `isLockAcquisitionTimeout` branch's body with `return res.status(500).json({ error: (e as Error).message })` → red: `a lock timeout answers the curated contention body…` (body names `SECRET-WORKSPACE`).
  4. Replace the first catch's fallback with `(e as Error).message` → red: `an unreadable revisions.json answers a fixed 500…` (the body is the raw fs error text).

- [ ] **Step 8: Commit.** `feat(server,openapi): add restore-unrecorded for an unrecorded preview take (#3400)`.

---

### Task 2: Server — bulk poll isolates a failing book (D9, server half)

**Character:** mechanical.

**Files:**
- Modify: `server/src/routes/revisions.ts` (`revisionsBulkRouter.get('/revisions', …)`), `openapi.yaml` (`BulkRevisionsResponse`), regenerate `src/lib/api-types.ts`, `CLAUDE.md`.
- Test: `server/src/routes/revisions.test.ts`.

**Interfaces:**
- Produces: `GET /api/revisions` → `200 { byBookId, errors?: Record<bookId, string> }`. `errors` is present only when at least one book failed; each value is the fixed sentence `Couldn't read this book's review state.` (through `requestFailureMessage`).

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
  });
  ```
  (Use the file's own names for the workspace root variable and imports; add `vi`, `beforeAll`, `mkdirSync`, `writeFileSync` to its imports if missing.)

  Run: `npm --prefix <wt>/server run test -- src/routes/revisions.test.ts -t "per-book isolation" --reporter=verbose --retry=0`
  Expected: FAIL — status 500 for the whole response.

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
        errors[id] = requestFailureMessage(e, "Couldn't read this book's review state.");
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

- [ ] **Step 4: CLAUDE.md.** Twenty-one → **twenty-two** sites; `revisions ×2` → `revisions ×3 (the single-book poll, the bulk poll, and the bulk poll's per-book errors)`. Grep check: **23** (22 + definition).

- [ ] **Step 5: Green.** `revisions.test.ts`, `typecheck`.

- [ ] **Step 6: Mutations.**
  1. Remove the `try/catch` around `getRevisionsForBook(id)` → red: `returns the healthy books…` (500).
  2. Change the fallback to `(e as Error).message` → red: same test (`errors[badId]` is the `SyntaxError` text).
  3. Always send `errors` → red: `omits errors when every book succeeds`.

- [ ] **Step 7: Commit.** `fix(server,openapi): isolate a failing book in the bulk revisions poll (#3400)`.

---

### Task 3: Server — curate the revisions routes' raw 500 fallbacks (Invariant 8)

**Character:** mechanical.

**Why:** `revision-ops.ts:113`, `:172`, `:185`, `revisions.ts:238`, `:271` and `qa-report.ts:47` pass `(e as Error).message || '…'` to `requestFailureMessage`, which keeps any non-lock message verbatim. A filesystem error (`EPERM`, `EBUSY`, `EISDIR`) embeds the absolute workspace path, and from Task 12 on the client would show it in a toast. Same defect class at all six sites, so all six are fixed here.

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (add `revisionsFailureText`), `server/src/routes/revision-ops.ts`, `server/src/routes/revisions.ts`, `server/src/routes/qa-report.ts`.
- Test: `server/src/routes/revision-ops.test.ts`, `server/src/routes/revisions.test.ts`, `server/src/routes/qa-report.test.ts`.

**Interfaces:**
- Produces: `export function revisionsFailureText(err: unknown, fallback: string): string` — `err instanceof UnsupportedSchemaError ? err.message : fallback` (that error's message is fixed and path-free by construction, and tells the user to upgrade).
- Each site becomes `requestFailureMessage(e, revisionsFailureText(e, '<its existing literal fallback>'))`. The `requestFailureMessage(` count does not change.

- [ ] **Step 1: Failing tests.** Make `revisions.json` a directory so the store's read throws `EISDIR` with the path:
  ```ts
  // revision-ops.test.ts (inside a new describe; uses the file's revisionsPath, accept, reject, request, app, bookId)
  describe('unexpected failures answer fixed sentences (plan 286, invariant 8)', () => {
    beforeEach(() => { rmSync(revisionsPath, { recursive: true, force: true }); mkdirSync(revisionsPath); });
    afterEach(() => { rmSync(revisionsPath, { recursive: true, force: true }); });
    it.each([
      ['accept', () => accept('r1'), 'Failed to accept revision.'],
      ['reject', () => reject('r1'), 'Failed to reject revision.'],
      ['dismiss', () => request(app).post(`/api/books/${bookId}/drift/d1/dismiss`), 'Failed to dismiss drift.'],
    ] as const)('%s', async (_n, call, text) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await call();
      err.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: text });
      expect(res.text).not.toContain(dirname(revisionsPath));
    });
  });
  ```
  ```ts
  // revisions.test.ts — single-book poll; use the file's seed helper for its main book, then:
  it('plan 286 — an unreadable revisions.json answers a fixed sentence, not the fs error', async () => {
    const p = join(bookDir, '.audiobook', 'revisions.json');
    rmSync(p, { force: true, recursive: true }); mkdirSync(p);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    err.mockRestore(); rmSync(p, { recursive: true, force: true });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to compute revisions.' });
  });
  it('plan 286 — a newer-schema file keeps its own upgrade sentence', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'revisions.json'), JSON.stringify({ schema: 99 }));
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/upgrade/i);
  });
  ```
  ```ts
  // qa-report.test.ts (its harness: bookDir, bookId, app; add mkdirSync/rmSync/join imports if missing)
  it('plan 286 — an unreadable revisions.json answers a fixed sentence', async () => {
    const p = join(bookDir, '.audiobook', 'revisions.json');
    rmSync(p, { force: true, recursive: true }); mkdirSync(p);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/api/books/${bookId}/qa-report`);
    err.mockRestore(); rmSync(p, { recursive: true, force: true });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build QA report.' });
    expect(res.text).not.toContain(workspaceRoot);
  });
  ```

  **Then** grep the three test files for assertions that pinned the raw message (PR 1 Reversibility 3: "a parse failure … surfaces the raw `SyntaxError` message"): `grep -n "SyntaxError\|Unexpected token\|JSON at position\|expected a JSON object" server/src/routes/{revisions,revision-ops,qa-report}.test.ts`. Change each to the fixed sentence and list them in the commit body.

  Run the three files with `--retry=0` → FAIL (bodies carry `EISDIR: illegal operation on a directory, read`).

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
  Each of the six sites: e.g. `revision-ops.ts` accept → `requestFailureMessage(e, revisionsFailureText(e, 'Failed to accept revision.'))`; reject → `'Failed to reject revision.'`; dismiss → `'Failed to dismiss drift.'`; `revisions.ts` single → `'Failed to compute revisions.'`; bulk → `'Failed to compute bulk revisions.'`; `qa-report.ts:47` → `'Failed to build QA report.'`. Also fix `revisions.ts`'s header comment if it says the error text is the raw parse error.

- [ ] **Step 3: Docs.** Plan 285 Reversibility 3 "Error text" bullet is now false for PR 2's state: append "(PR 2 / plan 286 Task 3: every such 500 now answers a fixed sentence; a newer schema keeps its upgrade sentence.)".

- [ ] **Step 4: Green.** The three test files, server `typecheck`.

- [ ] **Step 5: Mutations.**
  1. Revert `revision-ops.ts` reject's fallback to `(e as Error).message || 'Failed to reject revision.'` → red: the `reject` row.
  2. Make `revisionsFailureText` return `fallback` unconditionally → red: `a newer-schema file keeps its own upgrade sentence`.

- [ ] **Step 6: Commit.** `fix(server): answer fixed sentences for revisions store failures (#3400)`.

---

### Task 4: Server — `GET /state` returns normalised revisions and a `revisionsError` (OD2 server half)

**Character:** mechanical.

**Files:**
- Modify: `server/src/routes/book-state.ts` (GET handler: the `const revs = await readJson<…>(revisionsJsonPath(bookDir));` block `~:277-286`, and `revisions: revs,` in `res.json`).
- Modify: `openapi.yaml` (`BookStateResponse`).
- Test: `server/src/routes/book-state.hydrate.test.ts`.

**Interfaces:**
- Produces: `GET /state` → `revisions: RevisionsState | null`, and `revisionsError?: string`. `RevisionsState` here includes `bookId`, `fileId`, `rev`, normalised `pending`, `dismissed`, `acceptedSelections`, `timeline`; never `drift` or `schema`. When the store throws: `revisions: null` and `revisionsError: "This book's A/B review history couldn't be read."` (fixed, path-free); the book still opens; the raw error is logged. A missing file is **not** an error (empty state).

- [ ] **Step 1: Failing tests** in `book-state.hydrate.test.ts` (add `vi` and `mkdirSync` to its imports):
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
      mkdirSync(revPath());
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get(`/api/books/${bookId}/state`);
      err.mockRestore(); rmSync(revPath(), { recursive: true, force: true });
      expect(res.status).toBe(200);
      expect(res.body.revisions).toBeNull();
      expect(res.body.revisionsError).toBe("This book's A/B review history couldn't be read.");
      expect(res.text).not.toContain(workspaceRoot);
      expect(err).toHaveBeenCalled();
    });
  });
  ```
  (The file's `beforeEach` already deletes `revisions.json` between tests; a leftover directory is removed by the test itself.)

  Run: `npm --prefix <wt>/server run test -- src/routes/book-state.hydrate.test.ts --retry=0` → FAIL (raw shape with `drift`, no `fileId`; the directory case 500s).

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
    revisionsError = "This book's A/B review history couldn't be read.";
  }
  ```
  and in `res.json({ … revisions: revs, … })` add `...(revisionsError ? { revisionsError } : {}),`. Import `readRevisions`, `toRevisionsState`, `type RevisionsState`. Leave `revisionsJsonPath` imported (the PUT still uses it until Task 25).

- [ ] **Step 3: OpenAPI.** Replace `BookStateResponse.revisions`'s inline object with:
  ```yaml
        revisions:
          description: Plan 286 — revisions.json read through the server store (normalised). Null when the file is unreadable (then `revisionsError` is set).
          nullable: true
          allOf: [{ $ref: '#/components/schemas/RevisionsState' }]
        revisionsError:
          type: string
          description: Plan 286 — a fixed, path-free sentence, present only when revisions.json could not be read.
  ```
  Regenerate. In `api-types.revisions-contract.test.ts`, the PR 1 assertion on `BookStateResponse.revisions.schema` (`expectTypeOf<NonNullable<S['BookStateResponse']['revisions']>['schema']>()…`) no longer holds — replace it with `expectTypeOf<NonNullable<S['BookStateResponse']['revisions']>>().toEqualTypeOf<S['RevisionsState']>();` and `expectTypeOf<S['BookStateResponse']['revisionsError']>().toEqualTypeOf<string | undefined>();`. (The hand-written client `BookStateResponse` in `src/lib/types.ts` is realigned in Task 15, where it is consumed.)

- [ ] **Step 4: Green.** `book-state.hydrate.test.ts`, `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts`, `typecheck`.

- [ ] **Step 5: Mutations.**
  1. Revert to `readJson(revisionsJsonPath(bookDir))` → red: `normalises: drops drift…`.
  2. Replace the catch body with `throw e` → red: `an unreadable file still opens the book…` (500).
  3. Set `revisionsError = (e as Error).message` → red: same test (the raw fs error text instead of the fixed sentence).

- [ ] **Step 6: Commit.** `fix(server,openapi): serve normalised revisions and a revisionsError from GET /state (#3400)`.

---

### Task 5: Server — legacy stuck entries stay recoverable (OD20, operator decision)

**Character:** mechanical.

**Why:** a legacy `playable:false` entry is a take the old client enqueued and never flipped (#3397 "stuck"). If its `.previous.mp3` still exists, the render did preserve, so the user can still choose. Today `normaliseRevisions` drops it unconditionally (`revisions-store.ts:130-133`), so the original audio is unreachable from the UI. Read-only change: the read view keeps it (as playable) while `.previous.mp3` exists. Nothing is written on read.

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (`normaliseRevisions` and its doc comment).
- Test: `server/src/workspace/revisions-store.test.ts`, `server/src/routes/revision-ops.test.ts`.

- [ ] **Step 1: Failing tests.**
  ```ts
  // revisions-store.test.ts — inside describe('readRevisions — normalisation (never writes)')
  it('plan 286 (OD20) — a legacy playable:false entry with .previous.mp3 is surfaced as playable; nothing is written', async () => {
    writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
    seedRaw({ pending: [{ id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: false, hasPreviousAudio: true, segments: [] }] });
    const before = readFileSync(revisionsJsonPath(bookDir), 'utf8');
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file.pending).toEqual([{ id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: true, hasPreviousAudio: true, segments: [] }]);
    expect(readFileSync(revisionsJsonPath(bookDir), 'utf8')).toBe(before);
  });
  it('plan 286 (OD20) — a legacy playable:false entry without .previous.mp3 is still dropped', async () => {
    seedRaw({ pending: [{ id: 'splice-b-1-c', chapterId: 1, characterId: 'c', playable: false, segments: [] }] });
    expect((await readRevisions(bookDir, CHAPTERS)).pending).toEqual([]);
  });
  ```
  Rename the existing test `'drops drift, playable:false legacy entries, and legacy entries with no .previous.mp3'` to `'drops drift and legacy entries with no .previous.mp3; keeps the last entry per chapter'` — its fixture (entry `a`, `playable:false`, chapter 1, followed by `c1` on chapter 1) still yields `[c1]` under OD20 because keep-last wins, so its assertions are unchanged; only its name became false.
  ```ts
  // revision-ops.test.ts — inside describe('legacy (origin-less) pending entries commit like server ones (#3400)')
  it('plan 286 (OD20) — a stuck legacy entry (playable:false) is rejected: the original returns and the outcome is recorded', async () => {
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
  Run: `npm --prefix <wt>/server run test -- src/workspace/revisions-store.test.ts src/routes/revision-ops.test.ts --retry=0` → FAIL: the first store test gets `[]`; the reject gets `404 revision_not_found`.

- [ ] **Step 2: Implement.** In `normaliseRevisions`, delete `if (e.playable === false) continue;` (keep the `.previous` check), and rewrite the doc comment's rule list: "drop the legacy `drift` copy; default missing fields; keep a legacy (origin-less) entry — whatever its `playable` flag — only while `.previous.mp3` exists, surfaced as playable (plan 286 OD20: a `playable:false` legacy entry is a take the old client never flipped; with `.previous` on disk the user can still choose); keep the LAST entry per chapter."

- [ ] **Step 3: Green.** Both files; also `npm --prefix <wt>/server run test -- src/routes/revisions.test.ts src/routes/qa-report.test.ts` (they read through the store); server `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Restore `if (e.playable === false) continue;` → red: both `(OD20) … surfaced as playable` and `… stuck legacy entry … is rejected`.
  2. Remove the `.previous` check for legacy entries → red: `… without .previous.mp3 is still dropped`.

- [ ] **Step 5: Commit.** `fix(server): surface stuck legacy A/B takes while their original audio exists (#3397)`.

---

### Task 6: Mock revisions store (`src/mocks/mock-revisions.ts`)

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
- `RevisionOpFailure` comes from `src/lib/revision-op-failure.ts`, created **in this task** (it is needed here first; Task 7 reuses it):
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

### Task 7: Client API — real and mock op functions, and mock/real parity

**Character:** mechanical.

**Why both halves at once:** `api` is `USE_MOCKS ? mock : real` (`api.ts:10803`), a union type; `api.acceptRevision` is a TS2339 error until **both** objects have it.

**Files:**
- Modify: `src/lib/api.ts` (`real` object next to `acceptChapterRevision`; `mock` object; two type exports).
- Test: create `src/lib/api-revision-ops.test.ts`; extend `src/lib/api-types.revisions-contract.test.ts`.

**Interfaces:**
- Consumes: Task 6's `RevisionOpFailure`, `revisionOpFailureFrom`, mock store.
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
  (Task 8 widens `K` to the read functions it reshapes.)

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

### Task 8: Mock API reads — per-book poll (D7), dismissed filter, previous audio, `getBookState` overlay

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

### Task 9: Mock renders record pending; `window.__mockRevisions`; splice delay hook

**Character:** judgment.

**Files:**
- Modify: `src/lib/api.ts`: `mockStreamSplice` (`~:1760`), `mockStreamGeneration`'s `chapter_complete` emission (`~:1720`).
- Modify: `src/main.tsx` (DEV/e2e hook block, beside `__mockQueue`).
- Test: extend `src/lib/api.mock-revisions.test.ts`.

**Interfaces:**
- `mockStreamSplice({ bookId, chapterId, mode, characterId, onTick })`: per-step delay `(window as { __mockSpliceDelayMs?: number }).__mockSpliceDelayMs ?? 80`. Before `splice_complete`: `mockRecordRender(bookId, chapterId, { characterId, triggeredBy }, { assumeLive: true })` with `triggeredBy = \`${mode === 'remix' ? 'Loudness fix' : 'Re-record'} (${firstName})\``, `firstName` = first word of the mock cast's `name` for `characterId` (`MOCK_BOOK_STATES.get(bookId)?.cast?.characters`), falling back to `characterId`. `splice_complete` carries `reviewRecorded: true`.
- `mockStreamGeneration`: destructure `bookId`, `chapterIds`, `review` from `StreamArgs`. `const reviewChapterId = review && chapterIds?.length === 1 ? chapterIds[0] : null;`. On each `chapter_complete` for `active.id`: if `active.id === reviewChapterId`, call `mockRecordRender(bookId, active.id, { ...review, oldDuration: active.duration, newDuration: active.duration })` and add `reviewChapter: true, reviewRecorded: true` to the tick (finalize reports `true` whenever its record **or** drop landed); otherwise `mockRecordRender(bookId, active.id, null)`.
- `window.__mockRevisions = { seed: seedMockRevisions, get: getMockRevisions, reset: resetMockRevisions }`.
- Test-only exports: `_mockStreamSplice`, `_mockStreamGeneration`.

- [ ] **Step 1: Failing tests** (append to `api.mock-revisions.test.ts`; add `vi` and `afterEach` to the import, and `_mockStreamSplice`, `_mockStreamGeneration` to the `./api` import, `seedMockRevisions`/`getMockRevisions` from the store):
  ```ts
  describe('mock renders record pending (plan 286)', () => {
    afterEach(() => vi.useRealTimers());

    it('a splice records a server entry for the chapter and reports reviewRecorded', async () => {
      const ticks: Array<{ type: string; reviewRecorded?: boolean }> = [];
      await _mockStreamSplice({ bookId: 'cc', chapterId: 2, mode: 'remix', characterId: 'eliza_cc', gainDb: 3, onTick: (t) => ticks.push(t) } as never);
      expect(ticks.at(-1)).toMatchObject({ type: 'splice_complete', reviewRecorded: true });
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
      expect(ticks.find((t) => t.type === 'chapter_complete')).toMatchObject({ chapterId: 1, reviewChapter: true, reviewRecorded: true });
      expect(getMockRevisions('cc').pending).toHaveLength(1);
    });

    it('a first render (no audio yet) records nothing but still stamps reviewChapter', async () => {
      vi.useFakeTimers();
      const ticks: Array<Record<string, unknown>> = [];
      const stop = _mockStreamGeneration(genArgs(true, (t) => ticks.push(t)) as never);
      await vi.advanceTimersByTimeAsync(1300);
      stop();
      expect(ticks.find((t) => t.type === 'chapter_complete')).toMatchObject({ reviewChapter: true });
      expect(getMockRevisions('cc').pending).toEqual([]);
    });

    it('a render without review never stamps reviewChapter and drops the chapter entry', async () => {
      vi.useFakeTimers();
      seedMockRevisions('cc', { state: { pending: [{ id: 'old', chapterId: 1, characterId: 'eliza_cc', segments: [], origin: 'server' }] }, liveChapterIds: [1] });
      const ticks: Array<Record<string, unknown>> = [];
      const stop = _mockStreamGeneration(genArgs(false, (t) => ticks.push(t)) as never);
      await vi.advanceTimersByTimeAsync(1300);
      stop();
      expect(ticks.find((t) => t.type === 'chapter_complete')).not.toHaveProperty('reviewChapter');
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

- [ ] **Step 3: Green.** The test file, `typecheck`, e2e `character-splice.spec.ts profile-regen-preview.spec.ts` (the client still enqueues its own pending at this point, so both stay green).

- [ ] **Step 4: Mutations.**
  1. Pass `{ assumeLive: false }` in `mockStreamSplice` → red: `a splice records a server entry…` (`cc` has no live chapters).
  2. Stamp `reviewChapter: true` on every `chapter_complete` → red: `a render without review never stamps reviewChapter…`.
  3. Skip `mockRecordRender(bookId, active.id, null)` for plain renders → red: same test (`old` still pending).

- [ ] **Step 5: Commit.** `feat(mocks): record pending on mock splices and review renders (#3400)`.

---

### Task 10: Revisions slice — the ordered cache, selectors, and the hydrate sequence guard (additive)

**Character:** judgment (the ordering rule is the heart of the PR).

**Files:**
- Modify: `src/store/revisions-slice.ts`.
- Test: create `src/store/revisions-slice.cache.test.ts`; touch `src/store/revisions-slice.test.ts` (initial-state assertion).

**Interfaces:**
- Produces (fields): `fileId: string | null` (initial `null`), `rev: number` (initial `0`), `adoptSeq: number` (initial `0`; increments on every adoption).
- Produces (pure): `export function compareFileIds(a: string | null, b: string | null): number`.
- Produces (reducers):
  - `hydrate(payload: { bookId: string; state: Partial<RevisionsState> | null; requestSeq?: number })`:
    1. **Sequence guard** (operator decision): if `payload.bookId === s.bookId` and `requestSeq !== undefined` and `requestSeq < s.adoptSeq`, an op or poll adopted newer state after this read started → drop the payload (only `loaded = true`).
    2. Otherwise adopt when `bookId` differs **or** `(state?.fileId ?? null) !== s.fileId`; else only when `(state?.rev ?? 0) >= s.rev`.
    3. `loaded = true`. **Transitional:** set `s.hydratedFor = bookId` (deleted with the field in Task 22) so the old persistence gate keeps working until then.
  - `applyServerState(payload: RevisionsState)`: ordered adopt.
  - `applyDismiss(payload: { driftId: string; state?: RevisionsState })`: always removes the event from `drift`; applies `state` through the ordered rule when given.
  - `forgetBook(payload: string)`: if `s.bookId === payload`, resets `bookId`, `fileId`, `rev` and the four per-book fields.
  - **Ordered adopt:** different `bookId` → adopt; same book → `compareFileIds(incoming, cached)`: `> 0` adopt, `< 0` ignore, `0` adopt iff `incoming.rev >= cached.rev`.
  - *Adopt* sets `bookId`, `fileId`, `rev`, `pending`, `dismissed`, `acceptedSelections`, `timeline` (via `normaliseTimelineKeys`) and increments `adoptSeq`. Never touches `drift` or `loaded`.
- Produces (selectors): `selectActivePending`, `selectActiveTimeline`, `selectActiveAcceptedSelections` over `{ revisions: RevisionsState; ui: { stage: unknown } }`.
- `bookScopeChanged` (alive until Task 22) also resets `fileId = null; rev = 0`.
- `applyPoll` is **not** changed here (Task 16).

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
    it('every adoption increments adoptSeq; an ignored payload does not', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 1 })));
      expect(s.adoptSeq).toBe(1);
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 0 })));
      expect(s.adoptSeq).toBe(1);
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

  describe('bookScopeChanged (transitional, deleted in Task 22)', () => {
    it('resets fileId and rev', () => {
      let s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 2 })));
      s = reduce(s, a.bookScopeChanged('B'));
      expect(s.fileId).toBeNull(); expect(s.rev).toBe(0);
    });
  });
  ```
  Run: `npm --prefix <wt> run test -- src/store/revisions-slice.cache.test.ts --retry=0` → FAIL (exports missing).

- [ ] **Step 2: Implement** in `revisions-slice.ts`:
  - Fields + initial values; doc comments ("Plan 286 — the server file identity/version this cache last adopted"; "`adoptSeq` — increments on every adoption; a hydrate whose read started before the latest adoption (`requestSeq < adoptSeq`) is stale and dropped").
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
      s.bookId = p.bookId;
      s.fileId = p.fileId ?? null;
      s.rev = p.rev ?? 0;
      s.pending = p.pending ?? [];
      s.dismissed = p.dismissed ?? [];
      s.acceptedSelections = p.acceptedSelections ?? {};
      s.timeline = normaliseTimelineKeys(p.timeline);
      s.adoptSeq += 1;
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
      /* Transitional (Task 22 deletes the field): keeps the old persistence gate open. */
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

- [ ] **Step 3: Green.** The new file, `revisions-slice.test.ts` (add `fileId: null, rev: 0, adoptSeq: 0` to the initial-state expectation), `typecheck` — any test that hand-builds a full `RevisionsState` needs `fileId: null, rev: 0, adoptSeq: 0`: at least `src/components/revision-timeline-modal.test.tsx`'s `makeStore` `preloadedState` (Task 19 later replaces that helper); `splice-runner-middleware.test.ts` spreads `getInitialState()` and is fine. Fix every one `typecheck` lists.

- [ ] **Step 4: Mutations.**
  1. In `compareFileIds`, swap the two `null` branches → red: `null is older than any id…`.
  2. In `shouldAdoptOrdered`, change `>=` to `>` → red: `ignores a lower rev…; adopts an equal or higher rev`.
  3. In `hydrate`, drop the `|| (p.fileId ?? null) !== s.fileId` clause → red: `adopts a different fileId even when it is null`.
  4. Delete the sequence-guard `return` line → red: `sequence guard — a legacy-book read … is dropped…`.
  5. Remove `s.adoptSeq += 1` from `adopt` → red: `every adoption increments adoptSeq…` and the sequence-guard test.

- [ ] **Step 5: Commit.** `feat(frontend): add the ordered revisions cache with a hydrate sequence guard (#3400)`.

---

### Task 11: UI slice — `openRevision`, `revisionOpInFlight`, `PreviewRegenCtx.bookId`/`stub`; `previewChapterComplete`

**Character:** mechanical.

**Files:**
- Modify: `src/store/ui-slice.ts`; `src/components/layout.tsx` (the `uiActions.setPreviewRegen({ characterId, previewChapterId, … })` call in the regenerate-character `onConfirm`, `~:2067`, gains `bookId`).
- Modify: `src/store/chapters-slice.ts` (export `previewChapterComplete`).
- Tests: `src/store/ui-slice.test.ts`, `src/store/persist-config.test.ts` (or wherever `UI_PERSIST_WHITELIST` is asserted), and every test building a `PreviewRegenCtx` (`grep -rln "previewChapterId:" src e2e` → `generation-stream-middleware.test.ts` at least).

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
  // actions
  setOpenRevision(payload: OpenRevision | null); setRevisionOpInFlight(payload: boolean);
  ```
- Produces (`chapters-slice.ts`): `export const previewChapterComplete = createAction<{ bookId: string; chapterId: number; reviewRecorded?: boolean }>('chapters/previewChapterComplete');` (no reducer, OD21).
- `showRevisionPlayer` stays until Task 19.

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
  ```
  In the file that asserts `UI_PERSIST_WHITELIST` (`grep -rln UI_PERSIST_WHITELIST src`):
  ```ts
  it('plan 286 — openRevision and revisionOpInFlight are not persisted', () => {
    expect(UI_PERSIST_WHITELIST).not.toContain('openRevision');
    expect(UI_PERSIST_WHITELIST).not.toContain('revisionOpInFlight');
  });
  ```
  Run → FAIL (actions missing; the whitelist test passes already — it is a regression guard, see mutation 1).

- [ ] **Step 2: Implement** per Interfaces. Fix every `PreviewRegenCtx` literal `typecheck` flags (add `bookId`).
- [ ] **Step 3: Green.** ui-slice + whitelist tests, `generation-stream-middleware.test.ts`, `layout.test.tsx`, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Add `'openRevision'` to `UI_PERSIST_WHITELIST` → red: `openRevision and revisionOpInFlight are not persisted`.
  2. Initialise `revisionOpInFlight: true` → red: `…round-trip and start empty`.
- [ ] **Step 5: Commit.** `feat(frontend): add openRevision, op-in-flight and preview bookId to the ui slice (#3400)`.

---

### Task 12: Revisions thunks — confirm, then apply

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
      /* Task 16 adds: expect(store.getState().revisions.rev).toBe(4) — applyPoll
         only adopts server state from Task 16 on. */
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
      expect(toasts(store)).toEqual(["Couldn't restore the original — try Reject again"]);
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
    restoreFailed: "Couldn't restore the original — try Reject again",
    unexpected: "Couldn't update the revision — try again",
    hasRevision: "This chapter has an older pending review — resolve it from the chapter's review first",
  } as const;

  export const activeBookId = (s: RootState): string | null => (s.ui.stage as { bookId?: string }).bookId ?? null;

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

### Task 13: Preview thunks — start, approve side effects, unrecorded reject

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
  - `startPreviewRegen` is today's inline preview branch of layout's regenerate-character `onConfirm` (`layout.tsx ~:2057-2083`), moved: `setPreviewRegen({ bookId, characterId, previewChapterId, remainingChapterIds, reason, note })`, then `enqueueQueueEntries([{ id: \`regen-preview-${bookId}-${characterId}-${previewChapterId}-${rand}\`, bookId, chapterId: previewChapterId, scope: 'this', review: { characterId, triggeredBy: \`${characterName} voice change\` } }])` (OD14). Layout switches to it in Task 19.
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
      ['restore_failed', 500, "Couldn't restore the original — try Reject again"],
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

### Task 14: `RevisionDiffPlayer` — `busy`, `rendering`, Keep new take, release + re-attach

**Character:** mechanical.

**Files:**
- Modify: `src/views/revision-diff.tsx`, `src/lib/use-ab-playback.ts`.
- Test: `src/views/revision-diff.test.tsx`.

**Interfaces:**
- Props (all optional): `busy?: boolean`, `rendering?: boolean`, `previousMissing?: boolean`, `onKeepNew?: () => void`.
- Footer rule (review mode only, OD11): when `onKeepNew` is given **and** A is unavailable (`!hasPreviousAudio || previousMissing`), the primary button reads **Keep new take** (calls `onKeepNew`) and **Reject draft** is disabled. Preview mode unchanged. `busy` disables both buttons.
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
  ```
  (`basePlay`/`basePause` are the file's existing spies; `afterEach` restores them; add `act` to the RTL import.) Run → FAIL on the first five. **The re-attach test passes before the change** — nothing releases yet — so it is a regression guard for the release added here; mutation 3 is its red evidence.

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

- [ ] **Step 3: Green.** `revision-diff.test.tsx` (all existing cases still pass), `src/lib/use-ab-playback.test.ts` if it exists, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Drop `disabled={busy}` from the non-keep-new `PrimaryButton` → red: `busy disables every footer action`.
  2. Call `onReject()` before `ab.release()` → red: `releases both audio elements before calling onReject`.
  3. Delete the lazy re-attach line in `playA` → red: `after a refused reject … A and B still play` (`played[0]` is `null`).
- [ ] **Step 5: Commit.** `feat(frontend): add busy, rendering and Keep new take to the A/B player (#3400)`.

---

### Task 15: Layout — book-open hydrate, rehydrate on reopen, sequence guard, OD2 toast

**Character:** judgment (layout.tsx is 2.6k lines; its test file 2.7k).

**Files:**
- Modify: `src/components/layout.tsx` — the per-book hydration effect (`useEffect(() => { if (!bookId) return; … }, [bookId, stageKind])`, `~:758-1041`) and the `revisionsHydratedFor` selector (`~:202`).
- Modify: `src/lib/types.ts` — the hand-written `BookStateResponse.revisions` (`~:430-445`) realigned to the generated type: `revisions: RevisionsState | null;` and `revisionsError?: string;` (finding 21; CLAUDE.md: OpenAPI is the type source). Fix the mock fixtures `typecheck` then flags (`MOCK_BOOK_STATES` builders and `src/mocks/marketing/hollow-tide.ts` already use `revisions: null`).
- Test: `src/components/layout.test.tsx`.

**Interfaces:**
- Consumes: `revisionsActions.hydrate` + `adoptSeq` (Task 10), `GET /state` (Task 4).
- Behaviour:
  - Every hydrate read captures `const requestSeq = store.getState().revisions.adoptSeq;` **immediately before** `api.getBookState(bookId)`, and dispatches `revisionsActions.hydrate({ bookId, state: res?.revisions ?? null, requestSeq })` where `hydrateFromBookState` is dispatched today (both the `res === null` branch and the full-load branch).
  - **Reopen:** when `manuscriptReady`, the effect re-reads revisions (today's revisions-only path) **once per arrival at the book** — tracked by a ref `revisionsReadFor` set to `bookId` when that read starts and cleared when `bookId` becomes falsy — so a stage change within the same book (confirm → ready) does not issue another `GET /state` (gap 2). A→B→A re-reads, because the ref holds B.
  - Remove: `revisionsHydratedFor`/`revisionsReady`, `hasWindowWrites`, both `persistPendingAfterHydrateMerge` dispatches. Keep `flushBookPersistence` (other slices still persist).
  - Retry loop (OD3): kept for the **full-load** path only; on the revisions-only path a failed read is `console.warn`ed and dropped (no toast, no retry).
  - **OD2:** when `res.revisionsError` is set, push a warn toast with the "revisions unreadable" copy, dedupe `revisions-unreadable-<bookId>`, **at most once per book per session** — a module-level `const revisionsErrorToasted = new Set<string>();`.

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
    beforeEach(() => { pollRevisionsMock.mockResolvedValue({ drift: [] }); pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} }); });

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

    it('OD2 — an unreadable revisions.json toasts once per book per session', async () => {
      getBookStateMock.mockResolvedValue(bookStateFor('b9', null, { revisionsError: "This book's A/B review history couldn't be read." }));
      const store = makeStore();
      openAt(store, 'b9');
      renderLayoutAt(store, 'b9');
      const msg = "This book's A/B review history couldn't be read, so its pending reviews aren't shown";
      await waitFor(() => expect(store.getState().notifications.toasts.map((t) => t.message)).toEqual([msg]));
      act(() => { store.dispatch(notificationsActions.dismissByKey('revisions-unreadable-b9')); });
      act(() => { store.dispatch(uiActions.goHome()); });
      openAt(store, 'b9');
      await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(store.getState().notifications.toasts).toEqual([]);
    });

    it("book B never shows book A's pending (selector scoping)", async () => {
      getBookStateMock.mockImplementation(async (id: string) => bookStateFor(id, revState(id, F1, 1, id === 'bA' ? ['a-take'] : [])));
      const store = makeStore();
      openAt(store, 'bA');
      renderLayoutAt(store, 'bA');
      await waitFor(() => expect(selectActivePending(store.getState())).toHaveLength(1));
      openAt(store, 'bB');
      expect(selectActivePending(store.getState())).toEqual([]);
    });
  });
  ```
  (Import `selectActivePending`, `notificationsActions`, `uiActions`, `revisionsActions` as the file needs. `bookStateFor('b9', null, …)` uses a distinct book id because `revisionsErrorToasted` is module-level and lives for the whole test file.)

  **Delete in this task** (they pin #3395 machinery removed here): the rest of `describe('Layout — per-book hydration: revisions branch (plan 27)')` that asserts `hydrateFromBookState` payloads, all of `describe('Layout — revisions persist only after the book is hydrated (#3395 pass 3, R1/R1b/R2)')` (`~:621-1276`) except "the failed-read notice is dismissed when the user moves on to another book" (full-load path — keep, adapting its fixture to `bookStateFor`), and `describe('Layout — revisions.bookId scope tracking through real navigation (#3395 pass 2, N1)')` (`~:534-620`, replaced by the selector test above). List each deleted test in the commit body with what replaces it (Task 10 cache tests, Task 12 thunk tests, or "machinery deleted, behaviour moved server-side"). `makeStoreWithScope` stays until Task 22 if any remaining test uses it.

  Run → FAIL on the new tests, except two that already pass and are regression guards with their red evidence in Step 4: `a stage change within the same book … does not re-read` (today's `hydratedFor` short-circuit also skips it; mutation 2) and `book B never shows book A's pending` (the selector from Task 10 already scopes it, and Task 10's `return empty for a non-active book` is its red evidence; it is kept here as the end-to-end guard that replaces the deleted #3395 N1 layout test).

- [ ] **Step 2: Implement** per Interfaces. Core of the effect:
  ```ts
  /* Plan 286 — revisions are server-owned: every arrival at a book re-reads
     them (one GET), so a take recorded while the user was away (#3397) — or a
     delete + re-import in another tab — is picked up. A stage change within
     the same book does not re-read (revisionsReadFor). The other slices keep
     their short-circuit. */
  if (manuscriptReady && revisionsReadFor.current === bookId) return;
  const revisionsOnly = manuscriptReady;
  revisionsReadFor.current = bookId;
  ```
  with `const revisionsReadFor = useRef<string | null>(null);` declared in the component and `useEffect(() => { if (!bookId) revisionsReadFor.current = null; }, [bookId]);`. In `load`, capture `const requestSeq = store.getState().revisions.adoptSeq;` right before `api.getBookState(bookId)`; dispatch `revisionsActions.hydrate({ bookId, state: res?.revisions ?? null, requestSeq })` at both former `hydrateFromBookState` sites; then
  ```ts
  if (res?.revisionsError && !revisionsErrorToasted.has(bookId)) {
    revisionsErrorToasted.add(bookId);
    dispatch(notificationsActions.pushToast({ kind: 'warn', message: "This book's A/B review history couldn't be read, so its pending reviews aren't shown", dedupeKey: `revisions-unreadable-${bookId}` }));
  }
  ```
  In the rejection handler, before the toast/retry: `if (revisionsOnly) { console.warn('[book-state] revisions re-read failed; the next poll repairs it:', err?.message); return; }`, and keep only the full-load toast copy.

- [ ] **Step 3: Green.** `layout.test.tsx`, `src/routes/confirm-rehydrate.test.tsx`, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Replace `revisionsReadFor.current === bookId` with `true` (always short-circuit when loaded) → red: `reopening a book always re-hydrates revisions…`.
  2. Delete the `revisionsReadFor.current === bookId` condition (re-read on every effect run) → red: `a stage change within the same book … does not re-read revisions`.
  3. Pass `requestSeq: undefined` to `hydrate` → red: `sequence guard — a slow reopen read…`.
  4. Remove the `revisionsErrorToasted` check → red: `OD2 — … toasts once per book per session`.
  5. Re-add the toast on the revisions-only failure → red: `a failed reopen read is dropped silently`.
- [ ] **Step 5: Commit.** `fix(frontend): rehydrate revisions from the server on every book open, guarded against stale reads (#3397)`.

---

### Task 16: Layout — polls adopt server state (D9), dismiss via the thunk

**Character:** judgment.

**Files:**
- Modify: `src/store/revisions-slice.ts` (`applyPoll`), `src/components/layout.tsx` (active poll `~:1113-1125`, bulk poll `~:1148-1165`, drift-report `onDismiss` `~:2199`).
- Test: `src/store/revisions-slice.test.ts`, `src/components/layout.test.tsx` (the `(#3376 round 2)` describe `~:2658`), `src/store/revisions-thunks.test.ts`.

**Interfaces:**
- `applyPoll(payload: RevisionsResponse & { bookId: string })`: merges drift for `bookId`, then ordered adopt, then `loaded = true`. `bookId` becomes required.
- Active poll: `.then((res) => { if (!cancelled && (store.getState().ui.stage as { bookId?: string }).bookId === bookId) dispatch(revisionsActions.applyPoll({ ...res, bookId })); }).catch((err) => console.warn('[revisions] active poll failed:', (err as Error).message))`.
- Bulk poll: chunks of ≤50 (`BULK_POLL_MAX = 50`, the server's cap); each chunk has its own `.catch`; `res.errors` entries and chunk failures go through `warnOnce` (module-level `Set`), console only (OD24).
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
  Fix the `multi-book drift` `applyPoll` cases that omit `bookId` (pass one). In `revisions-thunks.test.ts`, add to `revision_not_found without a state refetches the active book`: `expect(store.getState().revisions.rev).toBe(4);` (deferred from Task 12).

  (b) `layout.test.tsx`: replace the body of `describe('Layout — active book poll never overwrites client-owned pending (#3376 round 2)')` with a renamed describe `'Layout — revisions polls (plan 286)'` holding:
  ```ts
  function libraryOf(ids: string[]) {
    return { authors: [{ name: 'Della Renwick', series: [{ name: 'The Hollow Tide', books: ids.map((id) => ({
      bookId: id, title: `Book ${id}`, author: 'Della Renwick', series: 'The Hollow Tide', seriesPosition: 1, isStandalone: false,
      status: 'complete', chapterCount: 1, completedChapters: 1, characterCount: 1, voiceCount: 1, lastWorkedOn: 'today',
      coverGradient: ['#000', '#fff'], tags: [] })) }] }] } as unknown as LibraryResponse;
  }
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

- [ ] **Step 3: Green.** `revisions-slice.test.ts`, `revisions-slice.cache.test.ts`, `revisions-thunks.test.ts`, `layout.test.tsx`, `src/modals/drift-report.test.tsx`, `typecheck`; e2e `drift-report-multibook.spec.ts revision-diff.spec.ts character-splice.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Remove the bulk `.catch` → red: `D9 — a failing bulk poll is caught`.
  2. Set `BULK_POLL_MAX = 200` → red: `…in chunks of at most 50` (one call of 120 — which the server would 400).
  3. In `applyPoll`, call `adopt` unconditionally → red: `a stale poll (lower rev) updates drift but not pending` and the layout stale-poll test.
  4. Remove the active poll's `.catch` → red: `a failing active poll is caught`.
- [ ] **Step 5: Commit.** `fix(frontend): adopt server pending from polls and isolate background poll failures (D9) (#3400)`.

---

### Task 17: Splice runner — refetch instead of writing; `inFlightChapters`

**Character:** judgment.

**Files:**
- Modify: `src/store/splice-slice.ts`, `src/store/splice-runner-middleware.ts`.
- Test: `src/store/splice-runner-middleware.test.ts`, `e2e/character-splice.spec.ts`.

**Interfaces:**
- `splice-slice`: `inFlightChapters: Array<{ bookId: string; chapterId: number }>` (initial `[]`); `chapterStarted({ bookId, chapterId })` (adds if absent), `chapterSettled({ bookId, chapterId })` (removes); `export const selectChapterRendering = (s: { splice: SpliceState }, bookId: string, chapterId: number): boolean`.
- Runner: `chapterStarted` before `api.streamSplice`, `chapterSettled` in a `finally` around it. Remove both `revisionsActions` dispatches and the import. On `splice_complete`: `void dispatch(refetchActiveRevisions(req.bookId))` (the thunk skips a non-active book); if `ev.reviewRecorded === false`, warn toast `The new take is live, but its A/B review couldn't be saved` (dedupe `splice-review-unsaved-<bookId>`). `markChapterAudioUpdated` unchanged. Rewrite the header comment.

- [ ] **Step 1: Failing tests.** In `splice-runner-middleware.test.ts`, add `pollRevisionsSpy` to the hoisted mock and the `api` mock (`api: { streamSplice: streamSpliceSpy, putBookState: putBookStateSpy, pollRevisions: pollRevisionsSpy }`), reset it in `beforeEach` with `pollRevisionsSpy.mockReset().mockResolvedValue({ drift: [] })`. Replace the test `'runs one splice per chapter, enqueues + flips pending revisions, refreshes audio, counts results'` with:
  ```ts
  it('plan 286 — runs one splice per chapter, never writes pending, refetches the active book, refreshes audio, counts results', async () => {
    const store = makeStore();
    store.dispatch(spliceActions.startBatch({ id: 'b1', bookId: 'bk1', characterId: 'castor', characterName: 'Castor Allred', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(streamSpliceSpy).toHaveBeenCalledTimes(2);
    expect(pollRevisionsSpy).toHaveBeenCalledWith({ bookId: 'bk1' });
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
    let release!: () => void;
    streamSpliceSpy.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockImplementationOnce(async () => { throw new Error('boom'); });
    const store = makeStore();
    store.dispatch(spliceActions.startBatch({ id: 'b3', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(store.getState().splice.inFlightChapters).toEqual([{ bookId: 'bk1', chapterId: 1 }]);
    release(); await flush();
    expect(store.getState().splice.inFlightChapters).toEqual([]);
  });
  it('plan 286 — reviewRecorded:false toasts once', async () => {
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      args.onTick({ type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId, mode: args.mode, durationSec: 222, segmentCount: 1, hasPreviousAudio: true, reviewRecorded: false } as SpliceTick);
    });
    const store = makeStore();
    store.dispatch(spliceActions.startBatch({ id: 'b4', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(store.getState().notifications.toasts.filter((t) => t.message === "The new take is live, but its A/B review couldn't be saved")).toHaveLength(1);
  });
  ```
  Delete or adapt every other test in the file that asserts `revisions.pending` changes from the runner (`grep -n "revisions.pending\|markRevisionPlayable\|enqueuePending" src/store/splice-runner-middleware.test.ts`); list them in the commit body. (`flush()` is the file's existing helper. `revisionsScopeMiddleware` stays in this file's `makeStore` until Task 22 deletes the module.)

  **e2e** `character-splice.spec.ts` — replace the one-shot `pendingCount` read with:
  ```ts
  await expect
    .poll(() => page.evaluate(() => (window as unknown as StoreWin).__store__?.getState().revisions.pending.length ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(0);
  ```

  Run the unit file → FAIL.

- [ ] **Step 2: Implement** per Interfaces.
- [ ] **Step 3: Green.** The unit file, `typecheck`, `npm --prefix <wt> run test:e2e -- e2e/character-splice.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Re-add the old per-chapter `dispatch(revisionsActions.enqueuePending({ id: \`splice-${req.bookId}-${chapterId}-${req.characterId}\`, chapterId, characterId: req.characterId, playable: false, hasPreviousAudio: true, segments: [] }))` before `api.streamSplice` → red: `…never writes pending…` at `expect(store.getState().revisions.pending).toEqual([])`. (Re-adding `markRevisionPlayable` alone would stay green — it flips entries in an empty list — so it is not used.)
  2. Remove the `finally` around `chapterSettled` → red: `inFlightChapters … clears on completion or failure`.
  3. Replace the refetch with an unguarded `api.pollRevisions({ bookId: req.bookId }).then((res) => dispatch(revisionsActions.applyPoll({ ...res, bookId: req.bookId })))` → red: `…on another book does not refetch`.
- [ ] **Step 5: Commit.** `fix(frontend): splice runner refetches server pending instead of writing it (#3397)`.

---

### Task 18: Player watcher middleware

**Character:** mechanical.

**Files:**
- Create: `src/store/revision-player-middleware.ts`; wire it in `src/store/index.ts` (after `persistenceMiddleware`).
- Test: create `src/store/revision-player-middleware.test.ts`.

**Interfaces:**
- `export const revisionPlayerMiddleware: Middleware` — after every action: if `ui.openRevision?.kind === 'server'`, `!ui.revisionOpInFlight`, and the entry is not in `selectActivePending`, dispatch `setOpenRevision(null)`; additionally, if `ui.previewRegen` is for the active book with `previewChapterId === openRevision.chapterId` (OD10), dispatch `setPreviewRegen(null)` and an info toast `This preview was resolved elsewhere` (dedupe `preview-resolved-elsewhere`). The dispatched actions make the condition false, so re-entry is a no-op.
- Until Task 19, `openRevision` is never set, so the middleware is inert in the app.

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
    it('ignores the preview-stub kind (the stub is never in the cache)', () => {
      const store = makeStore();
      store.dispatch(uiActions.setPreviewRegen({ ...preview(3), stub: { id: 'revision:3:c', chapterId: 3, characterId: 'c', segments: [] } }));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
      store.dispatch(revisionsActions.applyPoll({ ...state(2, []), drift: [] }));
      expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
      expect(store.getState().ui.previewRegen).not.toBeNull();
    });
  });
  ```
  (`applyPoll` adopts server state since Task 16.) Run → FAIL (module missing).

- [ ] **Step 2: Implement:**
  ```ts
  /* Plan 286 (D6, spec §4) — the A/B player shows one server entry. If that
     entry leaves the cache while no op of the user's own is in flight (another
     tab resolved it, or a poll dropped it), close the player — and clear a
     preview tied to that chapter, with one toast, so it is never stranded. */
  import type { Middleware } from '@reduxjs/toolkit';
  import { uiActions, type UiState } from './ui-slice';
  import { selectActivePending, type RevisionsState } from './revisions-slice';
  import { notificationsActions } from './notifications-slice';

  type Root = { ui: UiState; revisions: RevisionsState };

  export const revisionPlayerMiddleware: Middleware = (store) => (next) => (action) => {
    const result = next(action);
    const s = store.getState() as Root;
    const open = s.ui.openRevision;
    if (!open || open.kind !== 'server' || s.ui.revisionOpInFlight) return result;
    if (selectActivePending(s).some((p) => p.id === open.revisionId)) return result;
    store.dispatch(uiActions.setOpenRevision(null));
    const preview = s.ui.previewRegen;
    const active = (s.ui.stage as { bookId?: string }).bookId;
    if (preview && preview.bookId === active && preview.previewChapterId === open.chapterId) {
      store.dispatch(uiActions.setPreviewRegen(null));
      store.dispatch(notificationsActions.pushToast({ kind: 'info', message: 'This preview was resolved elsewhere', dedupeKey: 'preview-resolved-elsewhere' }));
    }
    return result;
  };
  ```
  Wire into `src/store/index.ts`'s `.concat(…)` after `persistenceMiddleware`.

- [ ] **Step 3: Green.** The test file, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Drop the `s.ui.revisionOpInFlight` check → red: `does not fire during the user's own op`.
  2. Drop `&& preview.previewChapterId === open.chapterId` → red: `a vanishing entry unrelated to the preview … keeps the preview`.
  3. Drop `open.kind !== 'server' ||` → red: `ignores the preview-stub kind` (the stub kind has no `revisionId`, so the `some` check fails and the player closes).
- [ ] **Step 5: Commit.** `feat(frontend): close the A/B player when its entry is resolved elsewhere (#3400)`.

---

### Task 19: Layout — the A/B player routes `server` and `preview-stub` entries

**Character:** judgment.

**Files:**
- Modify: `src/components/layout.tsx` — `pending` selector (`~:195`), `onOpenRevisions` (`~:1731`), the regenerate-character preview branch (`~:2057-2083` → `startPreviewRegen`), the player block (`~:2474-2568`).
- Modify: `src/components/revision-timeline-modal.tsx` (`useAppSelector((s) => s.revisions.timeline)` → `useAppSelector(selectActiveTimeline)`).
- Modify: `src/store/ui-slice.ts` — delete `showRevisionPlayer` and `setShowRevisionPlayer`.
- Modify: `src/store/generation-stream-middleware.ts` — **transitional** (Task 20 replaces it): in its `revisions/markRevisionPlayable` block, stop `enqueuePending`ing the stub; instead dispatch `uiActions.setPreviewRegen({ ...preview, stub: buildPendingRevisionStub({ chapter, character, playable: true }) })` and `uiActions.setOpenRevision({ kind: 'preview-stub' })`. So the existing preview e2e opens the stub through the stub handlers below, and Approve fans out via `approvePreviewSideEffects`.
- Tests that reference `showRevisionPlayer` and must change in this task: `src/components/theme-toggle.test.tsx`, `src/lib/use-theme.test.tsx`, `src/store/persist-config.test.ts`, `src/store/ui-slice.test.ts`, `src/store/generation-stream-middleware.test.ts` (from `grep -rln showRevisionPlayer src`); plus `layout.test.tsx`, `src/components/revision-timeline-modal.test.tsx`.

**Interfaces:**
- `const pending = useAppSelector(selectActivePending);`
- `onOpenRevisions: () => { const first = pending[0]; if (first) dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: first.id, chapterId: first.chapterId })); }` (OD15).
- Shown revision: `open?.kind === 'server' ? pending.find((p) => p.id === open.revisionId) : open?.kind === 'preview-stub' ? ui.previewRegen?.stub : undefined`. Mode `'preview'` iff `ui.previewRegen && ui.previewRegen.bookId === bookId && ui.previewRegen.previewChapterId === shown.chapterId`.
- Player props: `busy={ui.revisionOpInFlight}`, `rendering={useAppSelector((s) => bookId && shown ? selectChapterRendering(s, bookId, shown.chapterId) : false)}`, `previousMissing={previousMissingFor === shown.id}` (local `useState<string | null>`), `onKeepNew` (server kind) → `acceptRevisionOp({ bookId, revisionId, chapterId })`, `onClose` → `setOpenRevision(null)`.
- Server kind: `onAccept(selection)` → capture `const preview = ui.previewRegen;` → `const out = await dispatch(acceptRevisionOp({ bookId, revisionId: shown.id, chapterId: shown.chapterId, selection }));` → `if (out.ok && preview && preview.bookId === bookId && preview.previewChapterId === shown.chapterId) await dispatch(approvePreviewSideEffects(preview));`. `onReject()` → `const out = await dispatch(rejectRevisionOp({ bookId, revisionId: shown.id, chapterId: shown.chapterId }));` → `if (out.ok && ui.previewRegen?.bookId === bookId && ui.previewRegen.previewChapterId === shown.chapterId) dispatch(uiActions.setPreviewRegen(null));` → `if (!out.ok && out.code === 'no_previous_audio') setPreviousMissingFor(shown.id);`.
- Stub kind: Approve → `await dispatch(approvePreviewSideEffects(preview)); dispatch(uiActions.setOpenRevision(null));` — no revisions call. Reject → `void dispatch(restoreUnrecordedPreview(preview))`. (Preview mode: no Keep new take.)
- Preview start: replace the inline `setPreviewRegen` + `enqueueQueueEntries` with `void dispatch(startPreviewRegen({ bookId, characterId, characterName: regenCharacter?.name ?? characterId, chapterIds, reason, note }))`.

- [ ] **Step 1: Failing tests.**
  (a) `layout.test.tsx` — add `acceptRevision`, `rejectRevision`, `restorePreviousUnrecorded`, `getChapterAudioPrevious` to the file's `vi.mock('../lib/api')` factory as `(...a) => acceptRevisionMock(...a)` etc. (declare the `vi.fn()`s beside `getBookStateMock`), then:
  ```ts
  describe('Layout — A/B player routing (plan 286)', () => {
    const entry = (id: string, ch: number, triggeredBy: string, extra = {}) => ({ id, chapterId: ch, characterId: 'eliza', triggeredBy, segments: [], playable: true, hasPreviousAudio: true, ...extra });
    const S = (ids: ReturnType<typeof entry>[], rev = 1) => ({ bookId: 'b1', fileId: F1, rev, pending: ids, dismissed: [], acceptedSelections: {}, timeline: {} });
    async function mounted(pending: ReturnType<typeof entry>[]) {
      getBookStateMock.mockResolvedValue(null);
      pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
      getChapterAudioPreviousMock.mockResolvedValue(null);
      const store = makeStore();
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
    it('Commit selection accepts through the route, closes on success, and fires no "resolved elsewhere" toast', async () => {
      acceptRevisionMock.mockResolvedValueOnce(S([], 2));
      const store = await mounted([entry('r-a', 3, 'Ay change')]);
      act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 })); });
      fireEvent.click(await screen.findByRole('button', { name: /Commit selection/i }));
      await waitFor(() => expect(screen.queryByTestId('revision-diff-player')).toBeNull());
      expect(acceptRevisionMock).toHaveBeenCalledTimes(1);
      expect(acceptRevisionMock.mock.calls[0][0]).toEqual({ bookId: 'b1', revisionId: 'r-a', selection: {} });
      expect(store.getState().notifications.toasts.map((t) => t.message)).not.toContain('This preview was resolved elsewhere');
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
    it('a successful preview Approve logs the regenerate', async () => {
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
  });
  ```
  (Import `RevisionOpFailure`, `castActions`. `changeLog.events[].type` — confirm the field name in `change-log-slice.ts`; `buildCharacterRegenEvent` produces `type: 'regenerate'` per `profile-regen-preview.spec.ts`.)
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
  (this also drops its hand-built `preloadedState`, which would otherwise need `hydratedFor`/`windowActions` until Task 22), then add:
  ```ts
  it('plan 286 — shows the empty state for a cached book that is not the active book', () => {
    const store = makeStore({ 3: [{ id: 't', chapterId: 3, eventKind: 'accepted', timestamp: '2026-01-01T00:00:00Z', status: 'active' }] }, 'X', 'Y');
    render(<Provider store={store}><RevisionTimelineModal chapterId={null} chapterTitle={undefined} characters={[halloran]} onClose={() => undefined} /></Provider>);
    expect(screen.getByTestId('revision-timeline-empty')).toBeInTheDocument();
  });
  ```
  (c) In the five `showRevisionPlayer` test files, replace each reference with `openRevision` (`showRevisionPlayer: false` → `openRevision: null, revisionOpInFlight: false` in hand-built ui states; the gen-middleware test's `expect(store.getState().ui.showRevisionPlayer).toBe(true)` → `expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' })` and its stub assertion moves from `revisions.pending` to `ui.previewRegen.stub`).
  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces. Remove the inline accept/reject bodies, the `api.acceptChapterRevision` / `api.rejectChapterRevision` calls, and the inline fan-out block.
- [ ] **Step 3: Green.** `layout.test.tsx`, `revision-timeline-modal.test.tsx`, the five files above, `typecheck`; e2e `revision-diff.spec.ts profile-regen-preview.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Open `pending[0]` regardless of `openRevision.revisionId` → red: `D6 — the player opens the requested entry…`.
  2. Run `approvePreviewSideEffects` before awaiting the accept thunk → red: `a preview Approve fans out only after the accept succeeded`.
  3. Make stub Approve dispatch `acceptRevisionOp` → red: `stub Approve fans out and makes no revisions call`.
  4. Drop `busy={ui.revisionOpInFlight}` → red: `a double-click on Commit selection sends one request`.
- [ ] **Step 5: Commit.** `fix(frontend): open the requested A/B entry and confirm accept/reject with the server (D1, D6) (#3400)`.

---

### Task 20: Generation preview — `previewChapterComplete`, refetch-or-stub

**Character:** judgment.

**Files:**
- Modify: `src/store/generation-stream-runner.ts` (`chapter_complete` branch of `handleTickFor`, `~:401-419`; `StreamRunnerStore.getState` type `~:85-88`).
- Modify: `src/store/generation-stream-middleware.ts` (replace Task 19's transitional `revisions/markRevisionPlayable` block).
- Rename: `src/lib/build-pending-revision.ts` → `src/lib/build-preview-stub.ts` (`buildPendingRevisionStub` → `buildPreviewStub`); correct the stale docstring (`hasPreviousAudio` comes from the metadata check now, `:8-12`, `:49-51`).
- Modify: `e2e/profile-regen-preview.spec.ts` (remove the `rejectAllPending` workaround and its comment — the phantom revision is gone since Task 8).
- Tests: `generation-stream-runner.test.ts`, `generation-stream-middleware.test.ts`, and the builder's test if one exists (rename with it).

**Interfaces:**
- Runner: on `chapter_complete` with `ev.reviewChapter === true`, `dispatch(previewChapterComplete({ bookId, chapterId: ev.chapterId, reviewRecorded: ev.reviewRecorded }))` for **any** book. Remove the `markRevisionPlayable` dispatch and the `revisions` member of `StreamRunnerStore`'s state type. (OD12: no refetch on a plain `chapter_complete`.)
- `buildPreviewStub({ chapter, character, hasPreviousAudio, triggeredBy? }): Revision` — `playable: true`, id `revision:<ch>:<char>`, no `origin`.
- Middleware on `previewChapterComplete.match(action)`:
  1. Active book ≠ `bookId` → info toast `Preview ready in ‹title›` (title from `library` books, fallback `bookId`), dedupe `preview-ready-<bookId>`; stop.
  2. Else `void openPreview(...)`:
     ```ts
     const PREVIEW_REFETCH_RETRY_MS = 1000; // OD23
     async function openPreview(dispatch: AppDispatch, getState: () => StreamableRootState, p: { bookId: string; chapterId: number; reviewRecorded?: boolean }) {
       if (p.reviewRecorded !== false) {
         let r = await dispatch(refetchActiveRevisions(p.bookId));
         if (r === 'failed') { await new Promise((res) => setTimeout(res, PREVIEW_REFETCH_RETRY_MS)); r = await dispatch(refetchActiveRevisions(p.bookId)); }
         if (r === 'skipped') return;
         if (r === 'ok') {
           const entry = selectActivePending(getState()).find((e) => e.chapterId === p.chapterId);
           if (entry) { dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: entry.id, chapterId: entry.chapterId })); return; }
         }
       }
       const before = getState();
       const chapter = before.chapters.chapters.find((c) => c.id === p.chapterId);
       const prev = chapter ? await api.getChapterAudioPrevious({ bookId: p.bookId, chapterId: p.chapterId, duration: chapter.duration }).catch(() => null) : null;
       const s = getState();
       const preview = s.ui.previewRegen;
       if (!preview || preview.bookId !== p.bookId || preview.previewChapterId !== p.chapterId) return;
       const character = s.cast.characters.find((c) => c.id === preview.characterId);
       if (!chapter || !character) return;
       dispatch(uiActions.setPreviewRegen({ ...preview, stub: buildPreviewStub({ chapter, character, hasPreviousAudio: prev !== null }) }));
       dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
     }
     ```
     Extend `StreamableRootState` with `revisions: RevisionsState` and `library: { books: Array<{ bookId: string; title: string }> }` (check the library slice's shape: it may expose `books` directly or via `authors` — use what `layout.tsx`'s `library.books` uses).
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
      onTickFor('other', 1)({ type: 'chapter_complete', chapterId: 1, reviewChapter: true, reviewRecorded: true } as GenerationTick);
      onTickFor('other', 2)({ type: 'chapter_complete', chapterId: 2 } as GenerationTick);
      const previews = types.filter((t) => t.type === 'chapters/previewChapterComplete');
      expect(previews.map((t) => t.payload)).toEqual([{ bookId: 'other', chapterId: 1, reviewRecorded: true }]);
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
  (b) `generation-stream-middleware.test.ts` — add `notifications`, `library` reducers to `makeStore`, `pollRevisions` and `getChapterAudioPrevious` to its `vi.mock('../lib/api')` factory (`pollRevisionsMock`, `getChapterAudioPreviousMock` declared with `vi.hoisted`), and replace the two Task 19-adapted `markRevisionPlayable` tests with:
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
    beforeEach(() => { pollRevisionsMock.mockReset(); getChapterAudioPreviousMock.mockReset(); });
    afterEach(() => vi.useRealTimers());

    it('active book + recorded entry → refetch, then open that server entry', async () => {
      const { store } = makeStore(); seedPreview(store);
      pollRevisionsMock.mockResolvedValueOnce(recorded());
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: true }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
      expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
    });
    it('reviewRecorded:false → no refetch; previous metadata decides the stub', async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockResolvedValueOnce({ url: 'blob:a', durationSec: 1, peaks: [], sampleRate: 1, segments: [] });
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: false }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(pollRevisionsMock).not.toHaveBeenCalled();
      expect(store.getState().ui.previewRegen?.stub).toMatchObject({ chapterId: 3, hasPreviousAudio: true, playable: true });
    });
    it('refetch succeeded with no entry for the chapter → stub', async () => {
      const { store } = makeStore(); seedPreview(store);
      pollRevisionsMock.mockResolvedValueOnce(empty());
      getChapterAudioPreviousMock.mockResolvedValueOnce(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: true }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(store.getState().ui.previewRegen?.stub?.hasPreviousAudio).toBe(false);
    });
    it('a failed refetch does not open a stub straight away; the retry succeeding opens the entry', async () => {
      vi.useFakeTimers();
      const { store } = makeStore(); seedPreview(store);
      pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(recorded());
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: true }));
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
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().ui.openRevision).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      expect(store.getState().revisions.pending).toEqual([]);
    });
    it('a previous-metadata GET that throws → stub with hasPreviousAudio:false', async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockRejectedValueOnce(new Error('500'));
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: false }));
      await vi.waitFor(() => expect(store.getState().ui.previewRegen?.stub?.hasPreviousAudio).toBe(false));
    });
    it('a non-active book → "Preview ready in ‹title›" toast and nothing opens', async () => {
      const { store } = makeStore(); seedPreview(store);
      store.dispatch(librarySlice.actions.hydrate({ authors: [{ name: 'A', series: [{ name: 'S', books: [{ bookId: 'other', title: 'Other Book' }] }] }] } as never));
      store.dispatch(previewChapterComplete({ bookId: 'other', chapterId: 3, reviewRecorded: true }));
      expect(store.getState().notifications.toasts.map((t) => t.message)).toEqual(['Preview ready in Other Book']);
      expect(store.getState().ui.openRevision).toBeNull();
      expect(pollRevisionsMock).not.toHaveBeenCalled();
    });
    it('the stub never enters the revisions cache and survives a poll', async () => {
      const { store } = makeStore(); seedPreview(store);
      getChapterAudioPreviousMock.mockResolvedValueOnce(null);
      store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: false }));
      await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
      store.dispatch(revisionsSlice.actions.applyPoll({ ...empty(), rev: 9 }));
      expect(store.getState().revisions.pending).toEqual([]);
      expect(store.getState().ui.previewRegen?.stub).toBeDefined();
      expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
    });
  });
  ```
  (Confirm `librarySlice.actions.hydrate`'s payload shape against `LibraryResponse` and the selector the middleware uses for titles; adapt the literal.)
  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces; delete Task 19's transitional block.
- [ ] **Step 3: Green.** Runner + middleware tests, `typecheck`, e2e `profile-regen-preview.spec.ts` (`cc` chapter 1 has no live audio in the mock store → the render records nothing → refetch finds no entry → stub with `hasPreviousAudio:false` → Approve fans out via the stub path; Reject drops the preview without a request).
- [ ] **Step 4: Mutations.**
  1. Remove the retry (open the stub on the first failure) → red: `a failed refetch does not open a stub straight away…`.
  2. Set `hasPreviousAudio: true` unconditionally in `buildPreviewStub`'s call → red: `refetch succeeded with no entry … → stub` (`hasPreviousAudio` is `true`).
  3. Gate the runner dispatch on `sliceMatchesHandle` → red: `dispatches previewChapterComplete only for reviewChapter, for any book`.
  4. Dispatch the stub into the cache (`revisionsActions.applyServerState` with the stub added) → red: `the stub never enters the revisions cache…`.
- [ ] **Step 5: Commit.** `fix(frontend): open a recorded preview entry, or a stub when none was recorded (#3397)`.

---

### Task 21: Persistence — no revisions PUT, ever

**Character:** mechanical.

**Files:**
- Modify: `src/store/persistence-middleware.ts` — delete the nine `revisions/*` rules (`~:212-251`) and their comments, `revisionsPatch` (`~:304-322`), the `rule.slice === 'revisions'` gate (`~:466-491`) with its comment; amend the `FLUSH_BOOK` comment (`~:336-345`): "revisions no longer persists from the client (plan 286), so the write-then-re-read hazard it describes now applies only to the other slices".
- Modify: `src/lib/types.ts` (`StateSlice` drops `'revisions'`), `src/lib/api.ts` (`applyMockSliceWrite` drops `case 'revisions'`).
- Test: create `src/store/persistence-middleware.revisions-never-put.test.ts`; trim `persistence-middleware.test.ts` (delete its revisions-rule tests; list them in the commit body).
- Issue chore: post a comment on #3421 ("plan 286 removes every client revisions write, so the revisions half of this issue is moot; the re-send-vs-surface question remains for the other slices").

- [ ] **Step 1: Failing test** — the new file. The gate refuses a revisions write unless `revisions.bookId` and `revisions.hydratedFor` both equal the book, so the test **hydrates first** (Task 10's transitional `hydrate` sets both); without that the test would pass before the fix and prove nothing.
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

### Task 22: Delete #3395's guard machinery and the dead revisions API

**Character:** mechanical (large but deletion-only).

**Files:**
- Modify: `src/store/revisions-slice.ts` — delete `hydratedFor`, `windowActions`, `RecordedRevisionsAction`, `DispatchedAt`, `recordIfUnhydrated`, `replayRecorded` (+ its assignment), `acceptAllPending`, `rejectAllPending`, `acceptRevision`, `rejectRevision`, `rolledBack`, `bookScopeChanged`, `bookWiped`, `dismissDrift`, `enqueuePending`, `markRevisionPlayable`, `hydrateFromBookState`, `persistPendingAfterHydrateMerge`, `appendTimelineEntryHelper`, `nowIso`; the transitional `s.hydratedFor = bookId;` line in `hydrate`; rewrite the `RevisionsState` field docs and the file header.
- Delete: `src/store/revisions-scope-middleware.ts`, `src/store/revisions-scope-middleware.test.ts`; remove its import and `.concat` entry from `src/store/index.ts`, and from `layout.test.tsx` (`makeStoreWithScope`) and `splice-runner-middleware.test.ts`.
- Modify: `src/routes/index.tsx` — `onDeleteBook`: `bookWiped` → `revisionsActions.forgetBook(b.bookId)`; `onReplaceManuscript`/`onReparseBook`: delete the `bookWiped` dispatch and its comment sentence (the server resets the file; the next hydrate adopts by `fileId`).
- Modify: `src/lib/api.ts` — delete `acceptChapterRevision`/`rejectChapterRevision` (real + mock) and `mockAcceptChapterRevision`/`mockRejectChapterRevision`.
- Modify: `src/lib/types.ts` — the `acceptedSelections` doc comment citing `revisionsActions.acceptRevision` (`~:443`).
- Modify: `e2e/marketing/scenes.ts` `generating-revision-diff` scene (`~:1041-1091`): replace the `rejectAllPending` dispatch (delete it) and the `markRevisionPlayable` dispatch with, after the existing `chapters/applyGenerationTick` dispatch:
  ```ts
  (window as unknown as { __mockRevisions?: { seed: (b: string, s: unknown) => void } }).__mockRevisions?.seed('hollow-tide-2', { previousChapterIds: [chapterId], liveChapterIds: [chapterId] });
  s?.dispatch({ type: 'chapters/previewChapterComplete', payload: { bookId: 'hollow-tide-2', chapterId, reviewRecorded: false } });
  ```
  Seeding `previousChapterIds` makes the stub's metadata check succeed, so the A card shows the preserved take, not "Original audio not preserved". Rewrite the scene's long comment: the stream is dead under `DEMO_CAPTURE`, so the scene stands in for the completion tick with `previewChapterComplete` (stub path).
- Tests: `revisions-slice.test.ts` (delete tests of deleted reducers; list in commit body), `routes/index.test.tsx`, `persistence-middleware.revisions-never-put.test.ts` (replace the old-action case with the exhaustive one below), `generation-stream-middleware.test.ts` (drop any remaining `markRevisionPlayable` case).

- [ ] **Step 1: Failing tests.**
  `routes/index.test.tsx` — replace `describe("drops the book's recorded pre-hydrate revisions writes")` (it pins `windowActions`, deleted here; list its three tests in the commit body) with:
  ```ts
  describe('forgets the deleted book\'s revisions cache (plan 286)', () => {
    beforeEach(() => {
      getLibraryMock.mockResolvedValue({ authors: [] });
      getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    });
    const held = { bookId: 'b1', fileId: '000000000000002-a', rev: 2, pending: [{ id: 'p', chapterId: 1, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} };
    async function deleteB1(store: ReturnType<typeof makeStore>) {
      deleteBookMock.mockResolvedValue(undefined);
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
      const confirm = screen.getAllByRole('button', { name: /Delete book/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(deleteBookMock).toHaveBeenCalledWith('b1'));
    }
    it('deleting a book forgets its revisions cache', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      await deleteB1(store);
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] }));
    });
    it('delete then re-import under the same id shows a clean cache', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      await deleteB1(store);
      await waitFor(() => expect(store.getState().revisions.bookId).toBeNull());
      store.dispatch(revisionsSlice.actions.hydrate({ bookId: 'b1', state: { ...held, fileId: null, rev: 0, pending: [] }, requestSeq: store.getState().revisions.adoptSeq }));
      expect(store.getState().revisions).toMatchObject({ bookId: 'b1', fileId: null, pending: [] });
    });
  });
  ```
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
  (`hydratedStore()` still works: `hydrate` no longer sets `hydratedFor` but nothing gates on it.) Run → FAIL (`forgetBook` not dispatched on delete).

- [ ] **Step 2: Implement** the deletions.
- [ ] **Step 3: Green.** One frontend run over every test file `git -C <wt> grep -l "revisions" -- 'src/**/*.test.ts' 'src/**/*.test.tsx'` lists; `typecheck`; `npx --prefix <wt> eslint src/store src/routes src/components src/lib e2e/marketing` (unused imports); e2e `revision-diff.spec.ts profile-regen-preview.spec.ts character-splice.spec.ts drift-report-multibook.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Remove the `forgetBook` dispatch from `onDeleteBook` → red: `deleting a book forgets its revisions cache`.
  2. Add `noop: (s) => s` to the slice's reducers without a `PAYLOADS` entry → `typecheck` red at the `satisfies` clause.
- [ ] **Step 5: Commit.** `refactor(frontend): delete the client revisions guard machinery superseded by server ownership (#3400)`.

---

### Task 23: Server — finalize callers pass `review` / `null`

**Character:** judgment (three routes; generation suite is slow-pool).

**Files:**
- Modify: `server/src/routes/chapter-splice.ts` (`finalizeChapterAudioWrite({` call `~:526`), `server/src/routes/chapter-qa-repair.ts` (`~:766`), `server/src/routes/generation.ts` (`~:1891`; the `RunningJob.review` comment `~:387-389`).
- Tests: `chapter-splice.test.ts` (`plan 285 — passes no \`review\` to finalize (PR 1 dark)…` `~:281`), `chapter-qa-repair.test.ts` (`~:440`), `generation.test.ts` (`passes no \`review\` to finalize…` `~:2369`; `reviewChapter:true only on the chapter rendered with review — … finalize still gets no review` `~:2414`).

**Interfaces:**
- Splice: `chapter-splice.ts` has no cast resolver today. Import `buildCastResolver` from `../store/cast-resolve.js` and, after `castIdHistory` is loaded (`~:229`), compute `const reviewName = buildCastResolver(cast.characters, castIdHistory).resolve(characterId)?.character.name ?? characterId;` (resolves superseded ids, OD13). Pass `review: { characterId, triggeredBy: spliceTriggeredBy(mode, reviewName) }`. Export `spliceTriggeredBy(mode: 'remix' | 'rerecord', name: string): string` = `` `${mode === 'remix' ? 'Loudness fix' : 'Re-record'} (${name.split(' ')[0] || name})` ``.
- QA repair: `review: null`.
- Generation: `review: job.review` (it is `null` when absent). A job with `review` renders exactly one chapter (400 otherwise, PR 1) and replayed chapters never finalize, so no per-chapter guard is needed. Update the `RunningJob.review` comment.

- [ ] **Step 1: Failing tests** — flip the three dark-state tests:
  ```ts
  // chapter-splice.test.ts — replace the 'plan 285 — passes no `review`…' test
  it('plan 286 — passes the splice review to finalize and threads reviewRecorded onto splice_complete', async () => {
    const fin = await import('../audio/finalize-chapter-write.js');
    const real = (await vi.importActual<typeof import('../audio/finalize-chapter-write.js')>('../audio/finalize-chapter-write.js')).finalizeChapterAudioWrite;
    const spy = vi.mocked(fin.finalizeChapterAudioWrite);
    spy.mockClear();
    spy.mockImplementationOnce(async (input) => ({ ...(await real(input)), reviewRecorded: false }));
    const res = await request(app).post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`).send({ mode: 'remix', characterId: 'castor', gainDb: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].review).toEqual({ characterId: 'castor', triggeredBy: 'Loudness fix (Castor)' });
    expect(parseSse(res.text).find((e) => e.type === 'splice_complete')!.reviewRecorded).toBe(false);
  });
  it('plan 286 — spliceTriggeredBy uses the first name', () => {
    expect(spliceTriggeredBy('remix', 'Eliza Carrick')).toBe('Loudness fix (Eliza)');
    expect(spliceTriggeredBy('rerecord', 'narrator')).toBe('Re-record (narrator)');
  });
  ```
  ```ts
  // chapter-qa-repair.test.ts — in the existing 'plan 285 — passes no `review`…' test, rename to
  // 'plan 286 — passes review:null to finalize and threads reviewRecorded onto qa_repair_complete' and replace
  //   expect('review' in spy.mock.calls[0][0]).toBe(false);
  // with
  expect(spy.mock.calls[0][0].review).toBeNull();
  ```
  ```ts
  // generation.test.ts — rename 'passes no `review` to finalize and threads reviewRecorded…' to
  // 'plan 286 — passes review:null to finalize without review…' and replace its `'review' in …` assertion with:
  expect(spy.mock.calls[0][0].review).toBeNull();
  // and in 'reviewChapter:true only on the chapter rendered with review — never a replay — and finalize still gets no review',
  // rename the tail to '— and finalize gets the job review', replacing `expect('review' in spy.mock.calls[0][0]).toBe(false);` with:
  expect(spy.mock.calls[0][0].review).toEqual(REVIEW);
  ```
  Run:
  `npm --prefix <wt>/server run test -- src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts --retry=0`
  `npm --prefix <wt>/server run test:slow -- src/routes/generation.test.ts -t "review" --reporter=verbose --retry=0` (check both renamed titles appear in the log)
  → FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Green** (same commands without `--retry=0`), server `typecheck`, `npm --prefix <wt> run check:cycles` (new import of `store/cast-resolve.js` into a route).
- [ ] **Step 4: Mutations.**
  1. Generation: pass `job.review ?? undefined` → red: `plan 286 — passes review:null to finalize without review` (`undefined`, finalize leaves revisions.json alone).
  2. QA repair: pass `undefined` → red: the renamed QA-repair test.
  3. Splice: use `characterId` instead of `reviewName` → red: `passes the splice review to finalize…` (`Loudness fix (castor)`).
- [ ] **Step 5: Commit.** `feat(server): record A/B review state on splice, QA repair and generation renders (#3397)`.

---

### Task 24: Server — restructure drops stale pending entries

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
  // chapters-restructure.test.ts — new describe; the file's beforeEach reseeds state/edits/audio (check it; if it does not
  // remove revisions.json, do so in this describe's afterEach)
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
      mkdirSync(revPath()); // the store read throws EISDIR, with the path in its message
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
      err.mockRestore();
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(workspaceRoot);
    });
  });
  ```
  (Add `afterEach`, `vi`, `rmSync`, `mkdirSync` to the file's imports.)
  Run:
  `npm --prefix <wt>/server run test -- src/workspace/restructure.test.ts src/workspace/revisions-store.test.ts --retry=0`
  `npm --prefix <wt>/server run test:slow -- src/routes/chapters-restructure.test.ts -t "plan 286" --reporter=verbose --retry=0`
  → FAIL (exports missing; `r2` survives the merge).
- [ ] **Step 2: Implement** per Interfaces. CLAUDE.md: "FIVE handlers swallow it deliberately" → "SIX …", adding "; and the restructure pending drop (`server/src/routes/chapters-restructure.ts`, plan 286) — a stale entry it fails to drop answers `revision_not_found` on the next accept/reject". Mirror in `cast-lock.ts` if it enumerates swallow sites.
- [ ] **Step 3: Green.** The two fast files; `test:slow` on `chapters-restructure.test.ts` (whole file, to keep the existing merge/split/reorder tests green); server `typecheck`; `npm --prefix <wt>/server run test -- src/workspace/cast-lock.guard.test.ts`.
- [ ] **Step 4: Mutations.**
  1. Drop the "old id maps to a different slug or no chapter" loop from `touchedChapterIds` → red: `touchedChapterIds covers…` (4 and 5 missing).
  2. Remove the `try/catch` in `applyRestructure` → red (slow pool): `a failing drop still answers 200 and leaks no path` (500 with the EISDIR path).
  3. Skip the drop call → red (slow pool): `a merge of chapters 2+3 drops their entries…`.
- [ ] **Step 5: Commit.** `feat(server): drop stale A/B entries for chapters a restructure touched (#3400)`.

---

### Task 25: Server — close the raw PUT (400) and the legacy audio routes (410)

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

### Task 26: e2e — accept / reject / dismiss, the #3397 book switch, a recorded preview

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
  (`openPreviewPlayerRecorded` and `hasElizaRegenLog` are copies of the original spec's helpers plus the seed line. The change-log event is only appended after `acceptRevisionOp` resolved `ok` — Task 19 — so "accepted is recorded" is established before the change-log poll can succeed.)

- [ ] **Step 2: Run** `npm --prefix <wt> run test:e2e -- e2e/revision-ops.spec.ts e2e/revisions-book-switch.spec.ts e2e/profile-regen-preview-recorded.spec.ts e2e/profile-regen-preview.spec.ts`. Expected PASS. Run the book-switch spec with `--repeat-each=3`.
- [ ] **Step 3: Mutations** (each must make the named spec red; restore after each):
  1. In `mockStreamSplice`, skip the `mockRecordRender` call → `revisions-book-switch.spec.ts` red (the mock store never gains an entry — this cuts every server→client path, so it discriminates; reverting only Task 15's rehydrate would not, because the active poll also fetches on arrival).
  2. In `src/store/preview-thunks.ts` `startPreviewRegen`, drop `review` → `profile-regen-preview-recorded.spec.ts` red (no entry is recorded, so the player opens on the stub: `openRevision.kind` is `preview-stub`).
  3. In `mockPollRevisions`, remove the dismissed filter → `revision-ops.spec.ts` "Dismissing a drift group…" red at the post-poll assertion.
- [ ] **Step 4: Commit.** `test(e2e): cover server-owned accept/reject/dismiss, the book-switch take and a recorded preview (#3397)`.

---

### Task 27: Bookkeeping — release notes, on-box register, plan status, plan 114

**Character:** mechanical (docs) — the register publish has its own procedure.

**Files and content:**
- `docs/release-notes-next.md` — one technical entry (PR-refed): client cutover (no client revisions writes; per-op routes; cache ordered by `fileId`/`rev` with a hydrate sequence guard); #3397; D1/D6/D7/D9; OD20 (legacy stuck takes recoverable while `.previous.mp3` exists); OD2 (`revisionsError` + one toast); `restore-unrecorded`; bulk `errors`; fixed 500 sentences for revisions store failures; `GET /state` normalised; `PUT slice:'revisions'` → 400; legacy routes → 410; restructure drop; finalize callers live; incidental fixes (bulk chunking at 50, active-poll catch).
- `RELEASE_NOTES.md` — brand-voice lines in the in-progress version: takes that finish while you're on another book wait for you as normal A/B reviews; takes stuck on "Rendering…" from before the update become reviewable again if the original audio was kept; accept/reject only count once the audio change actually happened.
- `docs/testing/onbox-acceptance-register.md` — **mint a new Group A row** (allocate from Group A's `<!-- next-id: A… -->` marker and bump it in the same commit; A9 is the plan-176 splice row and stays, only its "known gap (#3397…)" sentences are replaced by a pointer to the new row). The new row: "Revisions server ownership (plan 286, #3400/#3397)", hardware: GPU box, real sidecar, a real rendered book. Observe:
  1. splice a character → switch books → return: the A/B prompt is there and playable;
  2. accept → the chapter's `.previous.mp3` is gone, Revision History shows "Accepted";
  3. re-splice → reject → the original take is live again, history shows "Rejected";
  4. reject while a generation runs on the book → refused ("busy"), pending unchanged;
  5. a real **profile-regen preview**: Approve fans the rest out; a second preview: Reject restores the original;
  6. a **restructure** (merge two chapters, one with a pending take) → that take disappears from the list;
  7. an **upgraded book's legacy entry** (pending from before the update) can be accepted and, on another, rejected;
  8. a **legacy stuck entry** ("Rendering…" from before the update, `.previous.mp3` present) is now reviewable and Reject restores the original (OD20).
  Criteria live in this plan's "Manual acceptance walkthrough" and the row itself. Run `npm run register:build` and `npm run check:onbox-register`.
- `docs/testing/onbox-acceptance-register-live-view.html` — mirror the new row and the A9 edit; publish to the URL in the register's header following its "Live view" four-step procedure (including `check:onbox-register -- --against-published <file>` immediately before publishing), from the branch **after** rebasing on the latest `main`.
- `docs/features/archive/114-profile-regen-preview.md` — append an addendum: "Plan 286 (2026-10): the preview's pending entry is recorded by the server (`review` on the queue entry); when none is recorded the player opens a client-only stub; Approve fans out only after the server confirmed the accept."
- `docs/features/285-revisions-server-ops.md` — fill "Ship notes" (PR 1 merged `ce142a3c`; PR 2 merged `<sha>`); keep `status: active` (on-box owed) — OD18.
- `docs/features/286-revisions-client-cutover.md` — `status: active`, fill Ship notes; `docs/features/INDEX.md` — flip 286's status word.

- [ ] Steps: write each; run `check:onbox-register` and `register:build`; commit `docs(docs): release notes and on-box acceptance for the revisions cutover (#3400)`.

---

### Task 28: Verify, review gate, PR

**Character:** coordinator (`claude` lane).

- [ ] `npm --prefix <wt> run typecheck`
- [ ] `npm --prefix <wt> run verify:fast:branch` (manual, CLAUDE.md step 7)
- [ ] `npm --prefix <wt> run test:e2e -- e2e/revision-ops.spec.ts e2e/revisions-book-switch.spec.ts e2e/profile-regen-preview-recorded.spec.ts e2e/revision-diff.spec.ts e2e/profile-regen-preview.spec.ts e2e/character-splice.spec.ts e2e/drift-report-multibook.spec.ts`
- [ ] `npm --prefix <wt>/server run test:slow -- src/routes/generation.test.ts src/routes/book-state.test.ts src/routes/chapters-restructure.test.ts`
- [ ] `npm --prefix <wt> run check:cycles`
- [ ] `git -C <wt> grep -n "markRevisionPlayable\|enqueuePending\|hydrateFromBookState.*revisions\|hydratedFor\|bookWiped\|acceptChapterRevision\|rejectChapterRevision\|revisionsPatch\|showRevisionPlayer" -- src e2e server/src` → no hits.
- [ ] Push; open the PR (title `fix(frontend,server): revisions.json client cutover to server ownership (#3400)`; body: Summary, Test plan, `Closes #3400`, `Closes #3397`, "Also fixed, found in passing" from Incidental findings, the register row).
- [ ] Run the `pr-review-gate` skill (multi-scope → depth `high`).

---

## Incidental findings (folded in, per CLAUDE.md "Incidental findings")

| Finding | Where | Disposition |
|---|---|---|
| The background bulk poll sends every analysed book in one request; the server rejects more than 50 with 400, so a library with 51+ analysed books never updates background drift. | `layout.tsx` bulk effect vs `routes/revisions.ts` `bookIds.length > 50` | Fixed in Task 16 (chunks of 50). |
| The active-book poll (`layout.tsx ~:1116`) also has no `.catch`. | `layout.tsx` | Fixed in Task 16. |
| Six revisions 500 handlers echo raw store error text (fs errors carry absolute paths). | `revision-ops.ts`, `revisions.ts`, `qa-report.ts` | Fixed in Task 3. |
| `rolledBack` (and its persistence rule) is never dispatched anywhere in `src/` — dead code. | `revisions-slice.ts`, `persistence-middleware.ts` | Deleted in Tasks 21–22. |
| The hand-written `BookStateResponse.revisions` (`src/lib/types.ts:430-445`) lacks `bookId`/`fileId`/`rev`/`timeline`. | `types.ts` | Realigned to the generated type in Task 15. |
| Two plans share the number 285. | `docs/features/` | **Not fixed here.** Draft PR #3516 renumbers `285-analysis-failure-phase-markers.md` → 287; it is held until PR #3505 merges. No clash with 286. |
| `qa-report.ts:73` (`resume scoring`) also returns a raw error message. | `qa-report.ts` | Out of this PR's revisions scope (not a store path); same class — flag to the operator for a follow-up dispatch. |

## Open decisions

The operator decided three on 2026-10-06 (recorded as **DECIDED**). The rest carry the default this plan uses.

1. **OD1 — Source of the reopen re-hydrate.** (a) `getBookState` (today's call, now normalised); (b) `api.pollRevisions`. **Default (a).** Cost: one `GET /state` per *arrival at a book* — not per stage change, which Task 15 scopes out (`revisionsReadFor`). For a `ready` book the active poll also fetches immediately on arrival, so the two overlap; the rehydrate is what covers `analysing`/`confirm` stages, where the poll does not run.
2. **OD2 — Unreadable `revisions.json` on `GET /state`. DECIDED: toast once.** `GET /state` returns `revisions: null` and a fixed, path-free `revisionsError`; the book opens; the client shows one warn toast per book per session (Tasks 4, 15). (The polls are console-only — Task 16, OD24 — so this toast is the user-visible signal.)
3. **OD3 — The hydrate retry loop.** Spec: "the revisions retry loop goes". The loop also retries the full book load. **Default:** keep it for the full-load path only.
4. **OD4 — `restore-unrecorded` serialisation.** **Default:** take the `revision-op` key (same race class as accept/reject).
5. **OD5 — Bulk per-book error text.** **Default:** a fixed path-free sentence.
6. **OD6 — Mock store placement.** **Default:** a separate `src/mocks/mock-revisions.ts` table overlaid onto `getBookState` (mirrors `mock-queue.ts`).
7. **OD7 — Mock "had audio".** **Default:** a `liveChapterIds` set (seeded `sb` = all chapters; grown by every mock render); a splice always counts as having audio.
8. **OD8 — `__mockRevisions` surface.** Spec: `seed(bookId, {state, previousChapterIds})`, `get`. Plan adds `liveChapterIds` and `reset`; splice delay via `window.__mockSpliceDelayMs`.
9. **OD9 — Mock reject never answers `chapter_busy`.** Busy is covered by unit tests. Alternative: read the mock queue for an in-progress entry.
10. **OD10 — Preview clearing scope.** Spec: if the shown entry disappears "and `previewRegen` is set", clear it. **Default:** clear only a preview for that book and chapter — both in the watcher (Task 18) and in the thunks' gone/not-found branch (Task 12).
11. **OD11 — "Keep new take".** **Default:** review mode only, replacing "Commit selection" when A is unavailable; Reject disabled then.
12. **OD12 — Plain `chapter_complete` with a cached entry for that chapter.** **Default:** no extra refetch; the next poll or a `revision_not_found` repairs it.
13. **OD13 — Splice `triggeredBy`.** **Default:** `Loudness fix (<first name>)` / `Re-record (<first name>)`, name resolved through the cast resolver, falling back to the character id.
14. **OD14 — Preview `review.triggeredBy`.** **Default:** `<name> voice change`.
15. **OD15 — Status popover target.** **Default:** `pending[0]` (it only knows a count). D6 is about the preview path, not this button.
16. **OD16 — A vanished entry with no preview.** **Default:** close silently.
17. **OD17 — On-box acceptance.** **Default (revised):** a **new Group A row** (A9 is the plan-176 splice row; no row covers the preview path, plan 114 or #3400). A9's #3397 gap text is replaced with a pointer.
18. **OD18 — Plan status after merge.** **Default:** 285 and 286 both `active` with Ship notes until the new row is accepted.
19. **OD19 — Dismiss failure.** **Default:** keep the event and toast.
20. **OD20 — Legacy entries. DECIDED: keep stuck entries recoverable.** Read-only normalisation change (Task 5): a legacy `playable:false` entry whose `.previous.mp3` exists is surfaced as playable. Residual still accepted: legacy ids (`revision:<ch>:<char>`, `splice-<book>-<ch>-<char>`) are not per-recording, so a stale tab could act on a different legacy take with the same id.
21. **OD21 — `previewChapterComplete`** is a bare `createAction` exported from `chapters-slice.ts`.
22. **OD22 — `forgetBook` leaves that book's drift.** Spec literal; pre-existing linger until reload.
23. **OD23 — Preview refetch retry.** **Default:** one retry after 1000 ms.
24. **OD24 — Bulk/active poll failures in the UI.** **Default:** console only (once per book / per message per session).
25. **Hydrate race. DECIDED: sequence guard** (`adoptSeq` / `requestSeq`, Tasks 10, 15). A hydrate whose read started before the latest op/poll adoption is dropped; the next poll repairs anything it carried.

## Spec points that PR 1's merged code (or the code on `main`) contradicts

- §3 places `mockQueueRequest` in `queue-thunks.ts:36`; it is in `src/mocks/mock-queue.ts`.
- §4 places the timeline modal in `src/modals/`; it is `src/components/revision-timeline-modal.tsx`.
- §4 deletes `rolledBack` as if live; it is never dispatched.
- §4 "the revisions retry loop goes" — shared with the full-book load (OD3).
- §4 `restore-unrecorded` predates PR 1's per-chapter serialisation (OD4).
- §4 is silent on `GET /state` with an unreadable file (OD2, now decided).
- §4's `hydrate` rule ("a different `fileId` adopts, null included") is unsafe on its own for a legacy book: a read started before the first op returns `fileId:null` after the op minted one, and would erase the new entry. The sequence guard closes it.
- §1/§2 "keep legacy `playable:true` entries only" left #3397's stuck takes unrecoverable; OD20 widens it.
- D9 misses the 50-book cap and the active poll's missing `.catch`.
- PR 1's "unexpected 500 keeps the error's own message" (plan 285 Reversibility 3) conflicts with the client toasting it; Task 3 curates.
- The CLAUDE.md lines PR 2 makes false are not in the spec's Delivery: the `requestFailureMessage` call-site count (20 → 22; the grep counts the definition too, so 21 → 23), the swallow list (five → six), and the legacy routes' `LOCK_CONTENTION_REQUEST_ERROR` branches (replaced by `restore-unrecorded`'s).
- "PR 2 about 7 children" — at the 30–45-minute task size it is 28 dispatches.

## Reversibility / observable changes

Revert the PR. Everything PR 2 changes that a user, an old client or an operator can observe:

1. **The client never writes revisions.json.** An old tab's revisions `PUT` gets `400 revisions_server_owned`, logged to its console only. Disk is unchanged.
2. **The legacy `DELETE …/audio/previous` and `POST …/audio/previous/restore` answer `410 moved`.** An old tab's Accept/Reject toasts an error; nothing on disk changes.
3. **Every render records or drops A/B state on the server:** a splice records an entry; a plain generation or QA repair drops the chapter's entry; a preview render records one when the chapter already had audio.
4. **Restructure drops pending entries** for every chapter it touched.
5. **`GET /state`'s `revisions` is normalised** (no `drift`, no `schema`; stale legacy entries filtered); `null` plus `revisionsError` when unreadable (the book still opens; one toast).
6. **`GET /api/revisions` gains `errors`** and no longer fails as a whole for one bad book.
7. **Revisions 500s answer fixed sentences** instead of the error's own text.
8. **New route** `POST …/audio/previous/restore-unrecorded`.
9. **Legacy pending entries are visible and actionable**, including stuck `playable:false` ones whose `.previous.mp3` exists (OD20, read-only).
10. **Mock mode:** the seeded `sb` revision is the only pending revision in the mock workspace; mock previous audio exists only where a mock render preserved it; dismissed drift stays dismissed.

A revert restores the client writer while leaving PR 1's store in place; entries the server recorded during PR 2's lifetime (`origin:'server'`) are read by the old client's hydrate as ordinary pending entries.
