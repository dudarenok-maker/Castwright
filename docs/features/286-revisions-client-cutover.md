---
status: draft
shipped: null
owner: null
---

# 286 — revisions.json server-owned, PR 2: the client cutover (#3400, #3397)

> Status: draft. PR 2 of 2. PR 1 (plan [285](285-revisions-server-ops.md), PR #3504, merged `ce142a3c`) landed the server half dark. This plan switches the client over and turns the server switches on.
>
> Key files:
> - Client, new: `src/store/revisions-thunks.ts`, `src/store/revision-player-middleware.ts`, `src/mocks/mock-revisions.ts`, `src/lib/revision-op-failure.ts`, `src/lib/build-preview-stub.ts` (renamed from `build-pending-revision.ts`).
> - Client, modified: `src/store/revisions-slice.ts`, `src/store/ui-slice.ts`, `src/store/chapters-slice.ts`, `src/store/splice-slice.ts`, `src/store/splice-runner-middleware.ts`, `src/store/generation-stream-runner.ts`, `src/store/generation-stream-middleware.ts`, `src/store/persistence-middleware.ts`, `src/store/index.ts`, `src/components/layout.tsx`, `src/components/revision-timeline-modal.tsx`, `src/views/revision-diff.tsx`, `src/lib/use-ab-playback.ts`, `src/lib/api.ts`, `src/lib/types.ts`, `src/routes/index.tsx`, `src/main.tsx`, `src/data/revisions.ts`.
> - Client, deleted: `src/store/revisions-scope-middleware.ts` (+ its test).
> - Server, modified: `server/src/routes/chapter-audio.ts`, `server/src/routes/revisions.ts`, `server/src/routes/book-state.ts`, `server/src/routes/chapter-splice.ts`, `server/src/routes/chapter-qa-repair.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapters-restructure.ts`, `server/src/workspace/restructure.ts`, `server/src/workspace/revisions-store.ts`, `server/src/workspace/cast-lock.ts` (comment), `server/src/audio/previous-audio.ts` (comment).
> - Contract: `openapi.yaml`, `src/lib/api-types.ts` (generated).
> - e2e: new `e2e/revision-ops.spec.ts`, new `e2e/revisions-book-switch.spec.ts`; modified `e2e/profile-regen-preview.spec.ts`, `e2e/character-splice.spec.ts`, `e2e/marketing/scenes.ts`.
>
> URL surface: none new. The A/B player (`RevisionDiffPlayer`) and the Status popover's revisions action change behaviour.
>
> OpenAPI operations:
> - New: `POST /api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded`.
> - Changed: `GET /api/revisions` (gains `errors`), `GET /api/books/{bookId}/state` (`revisions` normalised), `PUT /api/books/{bookId}/state` (`slice:'revisions'` → 400), `DELETE …/audio/previous` and `POST …/audio/previous/restore` (→ 410).
> - First client callers: `POST …/revisions/{revisionId}/accept`, `…/reject`, `POST …/drift/{driftId}/dismiss`.

## Benefit / Rationale

- **User:**
  - A Fix-audio or preview take that finishes while you are on another book (or the Library) now shows up as a normal, playable A/B prompt when you come back (#3397: no more stuck "Rendering…" rows, no more lost prompts).
  - Accept and Reject only change the Revision History once the audio step actually succeeded (D1). A refused Reject no longer says "rejected".
  - The A/B player opens the take you asked for, not whatever happened to be first (D6).
  - One broken book no longer freezes the background drift badges of every other book (D9).
- **Technical:** the client stops writing `revisions.json` at all. It becomes a cache of server state, ordered by `fileId`/`rev`, so a stale tab or a slow response can no longer erase disk (#3400). About a dozen pieces of #3395's guard machinery are deleted.
- **Architectural:** one writer per file. The persistence middleware loses its only whole-file-replace rule set that raced the server. The server's `review` seam (PR 1) goes live for splice, QA repair, generation and restructure.

## Architectural impact

- **New seams:**
  - `revisions-thunks.ts`: confirm-then-apply operations (`acceptRevisionOp`, `rejectRevisionOp`, `dismissDriftOp`, `refetchActiveRevisions`) plus the two preview helpers.
  - `ui.openRevision` (`{kind:'server', revisionId, chapterId} | {kind:'preview-stub'} | null`) and `ui.revisionOpInFlight`.
  - `chapters/previewChapterComplete` (a `createAction`, no reducer).
  - `splice.inFlightChapters`.
  - `src/mocks/mock-revisions.ts` + `window.__mockRevisions`.
- **Invariants preserved:** OpenAPI stays the type source; every field added to an existing schema stays optional; the cast-lock rules (the revisions lock stays a leaf; `revision-op` → `revisions`); RTK Immer reducers; the discriminated `ui.stage`.
- **Migration:** none on disk. Legacy (origin-less) entries are normalised on read by PR 1's store; they are now shown to the user and can be accepted/rejected (PR 1 commit `7d39752e`). Legacy `playable:false` entries (the #3397 "stuck" ones) disappear at cutover, by PR 1's normalisation rule.
- **Reversibility:** revert the PR. See "Reversibility / observable changes" at the end of this document for the complete list.

## Invariants to preserve

1. **No `PUT /state` with `slice:'revisions'` is ever sent.** `StateSlice` (`src/lib/types.ts`) no longer includes `'revisions'`; `persistence-middleware.ts` has no `revisions/*` rule. Pinned by `src/store/persistence-middleware.revisions-never-put.test.ts` (Task 17).
2. **The revisions cache only adopts a payload in order.** Different book → adopt. Same book: a newer `fileId` adopts, an older one is ignored (`null` is oldest), equal `fileId` ignores a lower `rev`. `hydrate` additionally adopts on *any* `fileId` difference. Pinned in `revisions-slice.cache.test.ts` (Task 7).
3. **Callers dispatch `applyPoll` / `applyServerState` only for the active book**, read at dispatch time. Pinned in the thunk tests (Task 9) and the layout poll test (Task 12).
4. **Selectors return empty for a non-active book** (`selectActivePending`, `selectActiveTimeline`, `selectActiveAcceptedSelections`).
5. **Preview side effects (fan-out, change-log entry) run only after the accept succeeded**, and the fan-out targets `previewRegen.bookId`.
6. **The preview stub never lives in the revisions cache** — only in `ui.previewRegen.stub` — and is routed by `ui.openRevision.kind`, never by id or by a missing `origin`.
7. **The A/B player releases both `<audio>` elements before any op is sent** (Windows file handles).
8. **Server: no store error text reaches a client body.** The bulk poll's per-book `errors` values, `restore-unrecorded`'s 500 and the restructure drop all curate or swallow.
9. **Server: `restore-unrecorded` never writes revisions.json**, and takes the per-chapter `revision-op` key around the audio step.

## Test plan

### Automated coverage

- **Slice cache** (`src/store/revisions-slice.cache.test.ts`, Task 7; `revisions-slice.test.ts` poll cases, Task 12).
- **API, real** (`src/lib/api-revision-ops.test.ts`, Task 4) and **mock** (`src/mocks/mock-revisions.test.ts`, Tasks 5–6; `src/lib/api.mock-revisions.test.ts`, Task 6).
- **Thunks** (`src/store/revisions-thunks.test.ts`, Tasks 9 and 16).
- **Player watcher** (`src/store/revision-player-middleware.test.ts`, Task 14).
- **Revision-diff view** (`src/views/revision-diff.test.tsx`, Task 10).
- **Layout** (`src/components/layout.test.tsx`, Tasks 11, 12, 14, 16).
- **Splice runner** (`splice-runner-middleware.test.ts`, Task 13); **generation runner + middleware** (`generation-stream-runner.test.ts`, `generation-stream-middleware.test.ts`, Task 16).
- **No revisions PUT** (`persistence-middleware.revisions-never-put.test.ts`, Task 17).
- **Server:** `chapter-audio.test.ts` (Tasks 1, 21), `revisions.test.ts` (Task 2), `book-state.hydrate.test.ts` (Tasks 3, 21), `chapter-splice.test.ts`, `chapter-qa-repair.test.ts`, `generation.test.ts` via `test:slow` (Task 19), `restructure.test.ts` + `chapters-restructure.test.ts` (Task 20), `revisions-store.test.ts` (Tasks 1, 20).
- **Playwright** (mock mode): `e2e/revision-ops.spec.ts` (accept / reject / dismiss through the UI) and `e2e/revisions-book-switch.spec.ts` (#3397), Task 22; `profile-regen-preview.spec.ts` without its workaround (Task 15); `character-splice.spec.ts` waits for the refetch (Task 13).

### Manual acceptance walkthrough

Mock mode (`npm run dev:mock`):
1. Open **Solway Bay** (`#/books/sb/listen`). Status pill → **1 revision** → the player opens on chapter 3 in review mode, A and B both playable.
2. **Commit selection** → the player closes, the Status pill shows no pending revisions, and **Revision history** lists "Accepted revision" for chapter 3.
3. Reload. Seed again from the console: `window.__mockRevisions.seed('sb', { state: { pending: [/* rev1 */] }, previousChapterIds: [3] })`. Reopen the player → **Reject draft** → closes; history shows "Rejected revision".
4. Open **Carrick's Compass** cast, mark chapters rendered (as `character-splice.spec.ts` does), **Fix audio** with `window.__mockSpliceDelayMs = 3000`, then go to Solway Bay before it finishes, then back to Carrick's Compass → the Status pill shows the new take, and it is playable.

Real backend: owed as on-box acceptance (row **A9**, updated by Task 23).

## Out of scope

- The chapter take lifecycle (#3456): every audio-file behaviour stays exactly as PR 1 left it.
- Any multi-step rollback; the `rolled-back` timeline kind stays renderable but nothing writes it.
- Migrating legacy entries on disk.

## Ship notes

(Filled in when PR 2 merges — see Task 23.)

---

# revisions.json server-ownership — PR 2 (client cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the client a pure consumer of server-owned `revisions.json`: accept/reject/dismiss call the per-op routes, pending comes only from the server, #3395's client guards are deleted, the server records pending for every render, and the old write paths are closed.

**Architecture:** The revisions slice becomes a cache ordered by the server's `fileId`/`rev`. Thunks call a route, then apply the returned state. Runners refetch instead of writing. The A/B player opens a specific entry through `ui.openRevision`. The preview path routes either to a server entry or, when none was recorded, to a client-only stub kept in `ui.previewRegen`. Then the server switches on: finalize callers pass `review`/`null`, restructure drops stale entries, and the raw PUT and the two legacy audio routes are closed.

**Tech Stack:** React 18 + Redux Toolkit + Vitest/jsdom/RTL; Node 20 + Express + Vitest/supertest; OpenAPI 3.0.3 + openapi-typescript; Playwright (chromium, mock mode).

**Spec:** `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md` (rev 9), §4 and "Compatibility and the two PRs" → PR 2. Read it with plan 285's "Superseded by later commits" note and the shipped code: PR 1's review rounds added things the spec predates (see Global Constraints → "What PR 1 actually shipped").

**Base:** a new branch off `main` at or after `3587e132` (contains PR 1 `ce142a3c` and the fsck fix #3457 `9d0c6502`, which this PR depends on — spec "Delivery").

## Global Constraints

### Paths and how to run tests

- **`<wt>` is the implementation worktree** the implementation thread cuts with `node scripts/wt-new.mjs fix/frontend-3400-revisions-client-cutover` (branch name per CLAUDE.md "Branching workflow"; the PR is multi-scope, so commit subjects use `fix(frontend,server): …` etc.). Work only there.
- **Quoted code is authoritative; line numbers are advisory.** Every `file:line` below was measured on `main` at `3587e132`. Find code by its quoted text. An earlier task's edit shifts later lines.
- **Command forms** (each "Run:" line is one command):
  - Frontend: `npm --prefix <wt> run test -- <paths>`
  - Server, fast pool: `npm --prefix <wt>/server run test -- <path under server/>`
  - Server, slow pool (**required** for `src/routes/generation.test.ts` and `src/routes/book-state.test.ts`, both in `SLOW_FILES_TO_EXCLUDE`): `npm --prefix <wt>/server run test:slow -- <path> -t "<name filter>"`
  - Typecheck (frontend + server): `npm --prefix <wt> run typecheck`
  - OpenAPI regen: `npm --prefix <wt> run openapi:types`
  - e2e: `npm --prefix <wt> run test:e2e -- e2e/<spec>.spec.ts`
- **On a lane that kills a command after 30 s** (a Cline lane), launch every test, typecheck and `openapi:types` command through **plan 285's detach recipe** (285 → Global Constraints → "Lanes and long commands"), unchanged except for `<wt>`, including its Green rule and contention rule. On the `claude` lane run them in the foreground with a 600 s timeout.
- **Every red-first run and every mutation run appends `--retry=0`.** Both vitest configs set `retry: 1`; a mutation that turns green only on retry proves nothing.
- **No task runs a full battery** (`npm run test`, `test:server`, `test:all`, `verify`, `build`, whole-tree lint). Each task runs its own files plus `typecheck`. Task 24 runs the broader check; cloud `verify.yml` is the authoritative gate.

### Test sketches in harness-heavy files

`layout.test.tsx` (2.7k lines), `splice-runner-middleware.test.ts`, `revision-player-middleware.test.ts` and the generation middleware tests have large existing harnesses. In their sketches, `…text…` inside a test body marks **setup the file's existing harness already provides** (the task names the helper or `describe` to copy from); every assertion is written out. Reuse the harness; do not invent a parallel one.

### Ordering rule

Every task's commit leaves `npm run typecheck` and that task's tests green, and does not break any test elsewhere. Concretely:
- New reducers/functions are **added** before callers switch to them, and old ones are **deleted** only after the last caller is gone (Tasks 17–18).
- A task that changes behaviour some other test pins (a layout test, an e2e spec) updates that test **in the same task**. Each task names those tests.
- Server switches (Tasks 19–21) come after the client stops using the old paths.

### What PR 1 actually shipped (read before any task)

- **Per-chapter serialisation.** Accept/reject run inside `withKeyLock(revisionOpLockKey(bookDir, chapterId))` (`revision-op:<resolved bookDir>:<chapterId>`), with the `revisions` leaf lock taken inside for steps 1 and 3. Lock order `revision-op` → `revisions`. (`revision-ops.ts` `serialisedPerChapter`.)
- **Legacy entries commit.** `commitRevisionOp` looks its entry up in the stored view first (`stored.pending.find(...) ?? file.pending.find(...)`, `revisions-store.ts:387-389`), so an origin-less entry whose `.previous.mp3` the op consumed still records an outcome.
- **Legacy-route lock curation.** The legacy `DELETE …/audio/previous` and `POST …/audio/previous/restore` answer `LOCK_CONTENTION_REQUEST_ERROR` on a lock timeout. Task 21 retires both routes (410), so those branches go with them.
- **Error body shape.** Coded errors: `{ error: <code>, message, state? }` (`RevisionOpError` in `openapi.yaml:7168`). Unexpected 500s: `{ error: <curated message> }` with no `message`.
- **Finalize.** `applyReview` (`finalize-chapter-write.ts:773`) already implements the tri-state; PR 2 only changes what callers pass.
- **Client plumbing.** `review` already rides `EnqueueInput` → queue entry → `StreamOpenOpts` → `StreamArgs` → POST body (PR 1 Task 11). The mock queue is `src/mocks/mock-queue.ts` (not `queue-thunks.ts`, which the spec cites).

### Error codes the client handles

`invalid_selection` (400), `book_not_found` / `revision_not_found` (404), `chapter_busy` / `no_previous_audio` / `live_audio_missing` / `revision_gone` / `has_revision` (409), `restore_failed` (500), `revisions_server_owned` (400, PUT only), `moved` (410, legacy routes only). Any other body is "unexpected".

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
| unexpected | error | `Couldn't update the revision — ‹message›` |
| dismiss failed | error | `Couldn't dismiss the drift event — try again` |

### Commits

- Each task commits on its own, in the foreground, with the message given in its last step. Never `--no-verify`.
- Subject `<type>(<scope>[,<scope>]): <subject>`, ≤100 chars, scopes from `frontend|server|mocks|openapi|e2e|docs`.
- Each commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the dispatching session's attribution line).

### Mutation checks

Every task ends with mutation checks. For each: make the named change, run the named test with `--retry=0`, observe the **named** test go red for the stated reason, restore byte-for-byte, re-run green, and confirm `git -C <wt> diff --stat` shows only the task's own files.

### Task character

Each task header says **mechanical** (follow the code as written) or **judgment** (the code is a strong guide but the implementer must fit it into surrounding code they will read for the first time). The operator assigns lanes at decompose time.

## Review Focus

1. **Coming back to a book after a take finished elsewhere (#3397).** The user leaves book A mid-splice and returns: the prompt must be there and playable. Pinned by `e2e/revisions-book-switch.spec.ts` (Task 22) and the reopen-rehydrate layout test (Task 11).
2. **Two tabs on one take.** Tab 1 accepts; tab 2 has the player open on the same entry, and its poll removes it. Tab 2's player must close, and a preview tied to that chapter must clear with one "resolved elsewhere" toast — never a stranded player. Pinned in `revision-player-middleware.test.ts` (Task 14).
3. **A legacy on-disk entry** (no `origin`, id `revision:3:eliza` or `splice-…`) shown after cutover must open as a server entry, and accept/reject must record an outcome. Pinned in `revisions-thunks.test.ts` "legacy id" case (Task 9) and the layout player test (Task 14); the server side is PR 1's.
4. **Many books / one broken book in the background poll.** More than 50 analysed books, or one book whose bulk entry fails, must not stop drift for the others. Pinned in the layout bulk-poll tests (Task 12) and `revisions.test.ts` (Task 2).
5. **Double-click on Approve / Reject.** The buttons disable while an op is in flight, so a second click sends nothing. Pinned in `revision-diff.test.tsx` "busy" (Task 10) and the layout player test (Task 14).

---

### Task 1: Server — `restore-unrecorded` route

**Character:** judgment (route ordering and curation).

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (add `hasPendingForChapter`).
- Modify: `server/src/routes/chapter-audio.ts` (new route, after the `POST …/audio/previous/restore` handler).
- Modify: `openapi.yaml` (new path), then regenerate `src/lib/api-types.ts`.
- Test: `server/src/routes/chapter-audio.test.ts`, `server/src/workspace/revisions-store.test.ts`, `src/lib/api-types.revisions-contract.test.ts`.

**Interfaces:**
- Produces: `hasPendingForChapter(bookDir: string, chapters: readonly ChapterRef[], chapterId: number): Promise<boolean>` (lock-free, normalised view; throws like `readRevisions`).
- Produces: `POST /api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded` → `204` restored · `404 {error:'no_previous_audio'|'not_found'}` · `409 {error:'chapter_busy'|'has_revision'}` · `500 {error:'restore_failed'|'lock_contention'|<curated>}`. Never writes revisions.json.

- [ ] **Step 1: Write the failing tests.**

  (a) `revisions-store.test.ts`, new `describe('hasPendingForChapter (plan 286)')` using the file's existing temp-book helpers:
  ```ts
  it('is true only for a chapter with a pending entry in the normalised view', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1')); // existing helper shape: origin:'server'
    expect(await hasPendingForChapter(bookDir, CHAPTERS, 1)).toBe(true);
    expect(await hasPendingForChapter(bookDir, CHAPTERS, 2)).toBe(false);
  });
  it('a legacy entry whose .previous.mp3 is gone does not count (normalised view)', async () => {
    writeRawRevisions({ pending: [{ id: 'revision:1:narrator', chapterId: 1, characterId: 'narrator', playable: true, segments: [] }] });
    expect(await hasPendingForChapter(bookDir, CHAPTERS, 1)).toBe(false);
  });
  ```
  (Use whatever the file already names its entry/raw-write helpers; if none exist, write the JSON with `writeFileSync(revisionsJsonPath(bookDir), …)`.)

  (b) `chapter-audio.test.ts`, inside `describe('preserved previous audio')`, add `describe('POST /audio/previous/restore-unrecorded (plan 286)')`:
  ```ts
  const RU = () => `/api/books/${bookId}/chapters/1/audio/previous/restore-unrecorded`;
  const revisionsFile = () => join(bookDir, '.audiobook', 'revisions.json');
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
  it('409 has_revision when revisions.json has a pending entry for the chapter; audio untouched', async () => {
    resetAudio(); writeMp3(); writePreviousMp3();
    writeFileSync(revisionsFile(), JSON.stringify({ schema: 1, fileId: '000000000000001-a', rev: 1,
      pending: [{ id: 'revision:1:1', chapterId: 1, characterId: 'narrator', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' }],
      dismissed: [], acceptedSelections: {}, timeline: {} }));
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
  it('a lock timeout answers the curated contention body, never the key', async () => {
    resetAudio(); writeMp3(); writePreviousMp3();
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    const spy = vi.spyOn(await import('../workspace/file-lock.js'), 'withKeyLock')
      .mockRejectedValueOnce(new LockAcquisitionTimeoutError('revision-op:/SECRET-WORKSPACE/x:1', 10));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(RU());
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-WORKSPACE');
    expect(res.body.message).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore(); errSpy.mockRestore();
  });
  ```
  The file already mocks `../workspace/file-lock.js` with a pass-through (`chapter-audio.test.ts:40-44`); if `vi.spyOn` cannot reach the mocked export, follow the PR 1 legacy-timeout tests in this same file (search `LOCK_CONTENTION_REQUEST_ERROR`) and copy their mechanism.

  (c) `api-types.revisions-contract.test.ts`, new `it`:
  ```ts
  it('plan 286 — restore-unrecorded is a POST with 204 / 404 / 409 / 500', () => {
    type Op = paths['/api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded']['post'];
    expectTypeOf<keyof Op['responses']>().toEqualTypeOf<204 | 404 | 409 | 500>();
  });
  ```

  Run: `npm --prefix <wt>/server run test -- src/routes/chapter-audio.test.ts src/workspace/revisions-store.test.ts --retry=0`
  Expected: FAIL — the route 404s (Express default), and `hasPendingForChapter` is not exported.

- [ ] **Step 2: Implement `hasPendingForChapter`** in `revisions-store.ts`, after `readRevisions`:
  ```ts
  /** Plan 286 — lock-free: does the normalised view hold a pending entry for
      this chapter? Used by restore-unrecorded's check-then-act guard (spec §4:
      a guard against the common case, not a fence). */
  export async function hasPendingForChapter(
    bookDir: string,
    chapters: readonly ChapterRef[],
    chapterId: number,
  ): Promise<boolean> {
    return (await load(bookDir, chapters)).pending.some((p) => p.chapterId === chapterId);
  }
  ```

- [ ] **Step 3: Implement the route** in `chapter-audio.ts`, directly after the `…/audio/previous/restore` handler. Add `hasPendingForChapter` to the existing `revisions-store.js` import.
  ```ts
  /* Plan 286 (#3400 PR 2) — restore `.previous` for a preview whose A/B review
     was never recorded (finalize answered reviewRecorded:false). Keeps the
     restore route's order: busy 409 first, then the chapter parse and lookups.
     Refuses with has_revision when a pending entry exists for the chapter (that
     one must go through the recorded reject). Never writes revisions.json.
     Takes the same per-chapter revision-op key as accept/reject: it runs the
     same restorePreviousAudio, so it shares their race (PR #3504 pass 1). */
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
  Import `requestFailureMessage` from `../workspace/file-lock.js` if not already imported. This adds one `requestFailureMessage(` site (see Step 5).

- [ ] **Step 4: OpenAPI.** Add after the `…/audio/previous/restore:` path in `openapi.yaml`:
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
          description: '`restore_failed`, `lock_contention`, or a curated failure.'
          content: { application/json: { schema: { $ref: '#/components/schemas/RevisionOpError' } } }
  ```
  Add `has_revision`, `lock_contention` and `not_found` to `RevisionOpError.error`'s description list. Run `npm --prefix <wt> run openapi:types`.

- [ ] **Step 5: CLAUDE.md chore.** The `requestFailureMessage` enumeration (CLAUDE.md "enumerates all twenty sites") becomes 21 with `chapter-audio` ×1. Update the count and add `chapter-audio` to the list. Also add the new route to the sentence about explicit `LOCK_CONTENTION_REQUEST_ERROR` branches ("… and of `restore-unrecorded` in `chapter-audio.ts`"). Task 21 removes the two legacy routes from that sentence. Verify with `git -C <wt> grep -c "requestFailureMessage(" -- 'server/src/**/*.ts' ':!*.test.ts'` summed.

- [ ] **Step 6: Run green.**
  Run: `npm --prefix <wt>/server run test -- src/routes/chapter-audio.test.ts src/workspace/revisions-store.test.ts`
  Run: `npm --prefix <wt> run test -- src/lib/api-types.revisions-contract.test.ts`
  Run: `npm --prefix <wt> run typecheck`
  Expected: PASS / exit 0.

- [ ] **Step 7: Mutations.**
  1. Move the `hasPendingForChapter` guard below the `withKeyLock(... restorePreviousAudio ...)` call → red: `409 has_revision when revisions.json has a pending entry…` (audio was restored before the refusal).
  2. Move the `isGenerationActive` check below the chapter-id parse → red: `409 chapter_busy during generation, checked before the chapter-id parse` (gets 404).
  3. Replace the `isLockAcquisitionTimeout` branch's body with `(e as Error).message` → red: `a lock timeout answers the curated contention body` (body contains `SECRET-WORKSPACE`).

- [ ] **Step 8: Commit.**
  `git -C <wt> add server/src/workspace/revisions-store.ts server/src/workspace/revisions-store.test.ts server/src/routes/chapter-audio.ts server/src/routes/chapter-audio.test.ts openapi.yaml src/lib/api-types.ts src/lib/api-types.revisions-contract.test.ts CLAUDE.md`
  `git -C <wt> commit -m "feat(server,openapi): add restore-unrecorded for an unrecorded preview take (#3400)"`

---

### Task 2: Server — bulk poll isolates a failing book (D9, server half)

**Character:** mechanical.

**Files:**
- Modify: `server/src/routes/revisions.ts` (`revisionsBulkRouter.get('/revisions', …)`).
- Modify: `openapi.yaml` (`BulkRevisionsResponse`), regenerate `src/lib/api-types.ts`.
- Test: `server/src/routes/revisions.test.ts`.

**Interfaces:**
- Produces: `GET /api/revisions` → `200 { byBookId, errors?: Record<bookId, string> }`. `errors` is present only when at least one book failed. Each value is a fixed, path-free sentence (curated through `requestFailureMessage`).

- [ ] **Step 1: Failing test** in `revisions.test.ts`, new `describe('GET /api/revisions — per-book isolation (plan 286, D9)')`. Seed two books with the file's existing helpers (a good one, and one whose `.audiobook/revisions.json` is `[]` — a non-object top level, which PR 1's store throws on):
  ```ts
  it('returns the healthy books and lists the broken one in errors with a path-free message', async () => {
    const res = await request(app).get(`/api/revisions?bookIds=${goodId},${badId}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.byBookId)).toEqual([goodId]);
    expect(Object.keys(res.body.errors)).toEqual([badId]);
    expect(res.body.errors[badId]).toBe("Couldn't read this book's review state.");
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
  });
  it('omits errors when every book succeeds', async () => {
    const res = await request(app).get(`/api/revisions?bookIds=${goodId}`);
    expect(res.body).not.toHaveProperty('errors');
  });
  ```
  If `revisions.test.ts` mounts only the single-book router, mount `revisionsBulkRouter` at `/api` in its `beforeAll` (the PR 1 bulk tests may already; search `revisionsBulkRouter`). Creating a second book: copy the file's `seed`/state-writing pattern for a second `Author/Series/Title` triple.

  Run: `npm --prefix <wt>/server run test -- src/routes/revisions.test.ts -t "per-book isolation" --retry=0`
  Expected: FAIL — 500 for the whole response.

- [ ] **Step 2: Implement.** Replace the `Promise.all` block in the bulk handler:
  ```ts
  /* Plan 286 (D9) — one book's failure no longer blanks every other book's
     drift. Its id goes into `errors` with a fixed, path-free sentence (the
     raw error is logged). */
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
  Update the handler's header comment ("Skips bookIds that don't exist… so one removed book doesn't take down the whole poll") to also say a failing book lands in `errors`.

- [ ] **Step 3: OpenAPI.** In `BulkRevisionsResponse.properties` add:
  ```yaml
        errors:
          type: object
          description: Plan 286 — bookIds whose computation failed, each with a fixed path-free sentence. Present only when non-empty.
          additionalProperties: { type: string }
  ```
  Regenerate types.

- [ ] **Step 4: CLAUDE.md chore.** The enumeration count rises by one more (`revisions` ×3 now: single, bulk whole-request, bulk per-book). Update the count (22 after Task 1) and the `revisions ×2` entry.

- [ ] **Step 5: Green.** Run the revisions suite, `typecheck`.

- [ ] **Step 6: Mutations.**
  1. Remove the `try/catch` around `getRevisionsForBook(id)` → red: `returns the healthy books…` (500).
  2. Change the fallback to `(e as Error).message` → red: same test (message differs and may contain the path).
  3. Always send `errors` → red: `omits errors when every book succeeds`.

- [ ] **Step 7: Commit.** `fix(server,openapi): isolate a failing book in the bulk revisions poll (#3400)`.

---

### Task 3: Server — `GET /state` returns normalised revisions

**Character:** mechanical (one decision recorded as OD2).

**Files:**
- Modify: `server/src/routes/book-state.ts` (the GET handler: the `const revs = await readJson<…>(revisionsJsonPath(bookDir));` block, `~:277-286`, and `revisions: revs,` in `res.json`).
- Modify: `openapi.yaml` (`BookStateResponse.revisions` descriptions).
- Test: `server/src/routes/book-state.hydrate.test.ts`.

**Interfaces:**
- Produces: `GET /state` → `revisions: RevisionsState | null`. `RevisionsState` here includes `bookId`, `fileId`, `rev`, normalised `pending`, `dismissed`, `acceptedSelections`, `timeline`; never `drift` or `schema`. `null` only when the store throws (corrupt / newer schema / non-object): the book still opens (OD2), and the error is logged.

- [ ] **Step 1: Failing tests** in `book-state.hydrate.test.ts`, new `describe('GET /state — revisions read through the store (plan 286)')`:
  ```ts
  const revPath = () => join(bookDir, '.audiobook', 'revisions.json');
  it('normalises: drops drift and a legacy playable:false entry, adds fileId/rev', async () => {
    writeFileSync(revPath(), JSON.stringify({
      pending: [{ id: 'splice-x-1-eliza', chapterId: 1, characterId: 'eliza', playable: false, segments: [] }],
      drift: [{ id: 'd1' }], dismissed: ['a'], timeline: {},
    }));
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.revisions).toMatchObject({ bookId, fileId: null, rev: 0, pending: [], dismissed: ['a'] });
    expect(res.body.revisions).not.toHaveProperty('drift');
  });
  it('a missing file reads as an empty state, not null', async () => {
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.body.revisions).toEqual({ bookId, fileId: null, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} });
  });
  it('an unreadable file still opens the book with revisions: null', async () => {
    writeFileSync(revPath(), '[]');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.revisions).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  ```
  (Import `vi` in the file's vitest import.)

  Run: `npm --prefix <wt>/server run test -- src/routes/book-state.hydrate.test.ts --retry=0`
  Expected: FAIL — `drift` present, no `fileId`, and the corrupt case 500s.

- [ ] **Step 2: Implement.** Replace the `const revs = await readJson<{…}>(revisionsJsonPath(bookDir));` statement (keep its neighbours) with:
  ```ts
  /* Plan 286 — read through the store: normalised (legacy drift dropped,
     stale legacy pending dropped), carrying fileId/rev for the client cache.
     An unreadable file (corrupt, newer schema, non-object) must not lock the
     user out of the book: serve null and log. The polls still surface the
     error. */
  let revs: RevisionsState | null;
  try {
    revs = toRevisionsState(req.params.bookId, await readRevisions(bookDir, state.chapters));
  } catch (e) {
    console.error('[book-state] revisions.json unreadable; serving the book without it', e);
    revs = null;
  }
  ```
  Add `readRevisions`, `toRevisionsState` and `type RevisionsState` to the existing `revisions-store.js` import. Remove `revisionsJsonPath` from the `paths.js` import **only if** nothing else in the file still uses it (the PUT handler does until Task 21 — leave it).

- [ ] **Step 3: OpenAPI.** In `BookStateResponse.revisions`: add `bookId: { type: string }`; reword `fileId` ("Plan 286 — present; null for a legacy file the store never wrote"), `drift` ("Plan 286 — no longer returned; the poll carries drift. Kept for older servers."), `schema` ("Plan 286 — no longer returned."), and the object description ("null when the file is unreadable"). Regenerate types. Update `api-types.revisions-contract.test.ts` only if a type assertion there now fails.

- [ ] **Step 4: Green.** Run `book-state.hydrate.test.ts`; also `npm --prefix <wt>/server run test:slow -- src/routes/book-state.test.ts -t "revisions"` (it asserts the raw GET in places — update any assertion that expected `drift`/raw shape to the normalised shape, and say so in the commit body). `typecheck`.

- [ ] **Step 5: Mutations.**
  1. Revert to `readJson(revisionsJsonPath(bookDir))` → red: `normalises: drops drift…`.
  2. Replace the `catch` body with `throw e` → red: `an unreadable file still opens the book…` (500).

- [ ] **Step 6: Commit.** `fix(server,openapi): serve normalised revisions from GET /state (#3400)`.

---

### Task 4: Client API — real `acceptRevision` / `rejectRevision` / `dismissDrift` / `restorePreviousUnrecorded`

**Character:** mechanical.

**Files:**
- Create: `src/lib/revision-op-failure.ts`.
- Modify: `src/lib/types.ts` (re-export `RevisionsState`), `src/lib/api.ts` (`real` object, next to `acceptChapterRevision`).
- Test: create `src/lib/api-revision-ops.test.ts`.

**Interfaces:**
- Produces (`src/lib/revision-op-failure.ts`):
  ```ts
  export const REVISION_OP_CODES = ['invalid_selection','book_not_found','revision_not_found','chapter_busy','no_previous_audio','live_audio_missing','revision_gone','restore_failed','has_revision','lock_contention','not_found'] as const;
  export type RevisionOpCode = (typeof REVISION_OP_CODES)[number] | 'unexpected';
  export class RevisionOpFailure extends Error { readonly status: number; readonly code: RevisionOpCode; readonly state?: RevisionsState }
  export async function revisionOpFailureFrom(res: Response, fallback: string): Promise<RevisionOpFailure>;
  ```
- Produces (`src/lib/types.ts`): `export type RevisionsState = components['schemas']['RevisionsState'];`
- Produces (`real`):
  - `acceptRevision(args: { bookId: string; revisionId: string; selection?: Record<number, 'A' | 'B'> }): Promise<RevisionsState>`
  - `rejectRevision(args: { bookId: string; revisionId: string }): Promise<RevisionsState>`
  - `dismissDrift(args: { bookId: string; driftId: string }): Promise<RevisionsState>`
  - `restorePreviousUnrecorded(args: { bookId: string; chapterId: number }): Promise<'restored' | 'none'>`
  - Each throws `RevisionOpFailure` on any other status.

- [ ] **Step 1: Failing test** — create `src/lib/api-revision-ops.test.ts` (vitest runs with `USE_MOCKS=false`, so `api === real`; same fetch-stub pattern as `api-stream-review.test.ts`):
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

  describe('plan 286 — revision op routes', () => {
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
      fetchMock.mockResolvedValueOnce(json(500, { error: 'Another request is still working on this book.' }));
      const err = await api.dismissDrift({ bookId: 'b', driftId: 'd' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'unexpected', message: 'Another request is still working on this book.' });
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
  Run: `npm --prefix <wt> run test -- src/lib/api-revision-ops.test.ts --retry=0` → FAIL (functions missing).

- [ ] **Step 2: Implement** `src/lib/revision-op-failure.ts`:
  ```ts
  /* Plan 286 — the one error type every revisions op throws (real and mock),
     so the thunks branch on `code` only. Lives outside api.ts so the mocks
     can import it without a cycle. */
  import type { RevisionsState } from './types';

  export const REVISION_OP_CODES = [
    'invalid_selection', 'book_not_found', 'revision_not_found', 'chapter_busy', 'no_previous_audio',
    'live_audio_missing', 'revision_gone', 'restore_failed', 'has_revision', 'lock_contention', 'not_found',
  ] as const;
  export type RevisionOpCode = (typeof REVISION_OP_CODES)[number] | 'unexpected';

  export class RevisionOpFailure extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: RevisionOpCode,
      readonly state?: RevisionsState,
    ) {
      super(message);
      this.name = 'RevisionOpFailure';
    }
  }

  export async function revisionOpFailureFrom(res: Response, fallback: string): Promise<RevisionOpFailure> {
    const body = (await res.json().catch(() => null)) as
      | { error?: unknown; message?: unknown; state?: RevisionsState }
      | null;
    const raw = typeof body?.error === 'string' ? body.error : null;
    const known = raw !== null && (REVISION_OP_CODES as readonly string[]).includes(raw);
    const code: RevisionOpCode = known ? (raw as RevisionOpCode) : 'unexpected';
    const message =
      typeof body?.message === 'string' ? body.message : !known && raw !== null ? raw : fallback;
    return new RevisionOpFailure(message, res.status, code, body?.state);
  }
  ```
  In `types.ts`, next to `RevisionsResponse`: `export type RevisionsState = components['schemas']['RevisionsState'];`.
  In `api.ts` `real`, after `rejectChapterRevision`:
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
  Import `RevisionsState` and `revisionOpFailureFrom`. **Typecheck note:** `api` is `USE_MOCKS ? mock : real`; nothing calls these yet, so the union type is fine until Task 6 adds the mocks.

- [ ] **Step 3: Green.** Run the test file; `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Drop `encodeURIComponent` around `revisionId` → red: `accept POSTs the selection…` (URL contains raw `:`).
  2. In `revisionOpFailureFrom`, return `raw` as the code without the known-code check → red: `an uncoded 500 is "unexpected"…`.
  3. In `restorePreviousUnrecorded`, treat 404 as a throw → red: the restore-unrecorded test.

- [ ] **Step 5: Commit.** `feat(frontend): add real per-op revisions api calls (#3400)`.

---

### Task 5: Mock revisions store (`src/mocks/mock-revisions.ts`)

**Character:** judgment (mirrors the server store's rules; pure module).

**Files:**
- Create: `src/mocks/mock-revisions.ts`.
- Modify: `src/data/revisions.ts` (the seeded `rev1` gains `origin: 'server'`, `playable: true`, `hasPreviousAudio: true`).
- Test: create `src/mocks/mock-revisions.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface MockRevisionsSeed { state?: Partial<Omit<RevisionsState, 'bookId'>>; previousChapterIds?: number[]; liveChapterIds?: number[] }
  export function seedMockRevisions(bookId: string, seed: MockRevisionsSeed): void;   // replaces that book
  export function resetMockRevisions(): void;                                           // empties every book
  export function hasMockRevisions(bookId: string): boolean;
  export function getMockRevisions(bookId: string): RevisionsState;                     // deep copy
  export function mockHasPrevious(bookId: string, chapterId: number): boolean;
  export function mockAcceptRevision(bookId: string, revisionId: string, selection?: Record<number, 'A' | 'B'>): RevisionsState; // throws RevisionOpFailure
  export function mockRejectRevision(bookId: string, revisionId: string): RevisionsState;  // throws RevisionOpFailure
  export function mockDismissDrift(bookId: string, driftId: string): RevisionsState;
  export function mockRestoreUnrecorded(bookId: string, chapterId: number): 'restored' | 'none'; // throws has_revision
  export function mockRecordRender(bookId: string, chapterId: number, review: { characterId: string; triggeredBy: string; oldDuration?: string; newDuration?: string } | null, opts?: { assumeLive?: boolean }): boolean; // true = an entry was recorded
  ```
- Rules (mirroring `revisions-store.ts` + `revision-ops.ts`):
  - Every write bumps `rev` and mints `fileId` if null (`${epoch 15-padded}-mock<n>`).
  - `mockRecordRender`: "had audio" = `assumeLive || liveChapterIds.has(ch)`. If it had audio, add `ch` to `previousChapterIds` (preserve). With `review` and audio: upsert the chapter's single entry (`origin:'server'`, id `revision:<ch>:<Date.now()>`, `playable:true`, `hasPreviousAudio:true`, `confidence:1`, `triggeredAgo:'just now'`, `segments: []`). Otherwise drop any entry for `ch` (only writes if one existed). Always add `ch` to `liveChapterIds`. Returns whether an entry was recorded.
  - Accept: absent + timeline has `accepted` with that id → current state; absent → 404 `revision_not_found` with state; no live but previous → 409 `live_audio_missing`; else delete previous, remove entry, append timeline (reversible-chain rule), set `acceptedSelections[id] = selection ?? {}`.
  - Reject: absent rules as accept but for `rejected`; no previous → 409 `no_previous_audio`; else move previous → live, remove entry, append `rejected`. (No busy rule — OD9.)
  - Dismiss: idempotent append to `dismissed`.
  - Restore-unrecorded: a pending entry for `ch` → throws 409 `has_revision`; previous → `'restored'` (remove from previous, add to live); else `'none'`.

- [ ] **Step 1: Failing tests** — `src/mocks/mock-revisions.test.ts`:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import * as m from './mock-revisions';
  import { RevisionOpFailure } from '../lib/revision-op-failure';

  const entry = (ch: number, id = `r${ch}`) => ({ id, chapterId: ch, characterId: 'eliza', segments: [], playable: true, hasPreviousAudio: true, origin: 'server' as const });
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
      expect(() => m.mockRejectRevision('b', 'r3')).toThrow(RevisionOpFailure);
      try { m.mockRejectRevision('b', 'r3'); } catch (e) { expect((e as RevisionOpFailure).code).toBe('revision_not_found'); }
    });
    it('accept refuses live_audio_missing when only previous exists, and writes nothing', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(3)] }, previousChapterIds: [3], liveChapterIds: [] });
      try { m.mockAcceptRevision('b', 'r3'); throw new Error('no throw'); } catch (e) {
        expect((e as RevisionOpFailure).code).toBe('live_audio_missing');
      }
      expect(m.getMockRevisions('b').rev).toBe(0);
    });
    it('reject with no previous is 409 no_previous_audio and keeps the entry', () => {
      m.seedMockRevisions('b', { state: { pending: [entry(3)] }, liveChapterIds: [3] });
      try { m.mockRejectRevision('b', 'r3'); throw new Error('no throw'); } catch (e) {
        expect((e as RevisionOpFailure).code).toBe('no_previous_audio');
      }
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
      expect(() => m.mockRestoreUnrecorded('b', 2)).toThrow(RevisionOpFailure);
      expect(m.mockRestoreUnrecorded('b', 4)).toBe('restored');
      expect(m.mockRestoreUnrecorded('b', 4)).toBe('none');
    });
    it('books are isolated', () => {
      m.seedMockRevisions('a', { state: { pending: [entry(1)] } });
      expect(m.getMockRevisions('b').pending).toEqual([]);
      expect(m.getMockRevisions('a').bookId).toBe('a');
    });
  });
  ```
  Run → FAIL (module missing).

- [ ] **Step 2: Implement** `src/mocks/mock-revisions.ts`:
  ```ts
  /* Plan 286 — in-memory stand-in for server-owned revisions.json in mock mode
     (dev:mock + e2e). Mirrors the rules of server/src/workspace/revisions-store.ts
     and routes/revision-ops.ts closely enough that the client's cache rules and
     thunk branches behave the same against it. Separate module (like
     mock-queue.ts) so api.ts, main.tsx's window hook and unit tests share one
     table. `previousChapterIds` mirrors `.previous` on disk; `liveChapterIds`
     mirrors live chapter audio. */
  import type { Revision, RevisionsState, TimelineEntry } from '../lib/types';
  import { RevisionOpFailure } from '../lib/revision-op-failure';

  type MockFile = Omit<RevisionsState, 'bookId'>;
  interface Book { file: MockFile; previous: Set<number>; live: Set<number> }
  export interface MockRevisionsSeed { state?: Partial<MockFile>; previousChapterIds?: number[]; liveChapterIds?: number[] }

  const books = new Map<string, Book>();
  let mintSeq = 0;
  const emptyFile = (): MockFile => ({ fileId: null, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} });
  const mintFileId = () => `${String(Date.now()).padStart(15, '0')}-mock${(mintSeq++).toString(16)}`;

  function book(bookId: string): Book {
    let b = books.get(bookId);
    if (!b) { b = { file: emptyFile(), previous: new Set(), live: new Set() }; books.set(bookId, b); }
    return b;
  }
  function view(bookId: string, b: Book): RevisionsState {
    return { bookId, ...structuredClone(b.file) };
  }
  function save(b: Book, next: MockFile): void {
    b.file = { ...next, fileId: next.fileId ?? mintFileId(), rev: next.rev + 1 };
  }
  function fail(bookId: string, b: Book, status: number, code: RevisionOpFailure['code'], message: string, withState = true): never {
    throw new RevisionOpFailure(message, status, code, withState ? view(bookId, b) : undefined);
  }
  function hasOutcome(f: MockFile, kind: 'accepted' | 'rejected', id: string): boolean {
    return Object.values(f.timeline).some((list) => list.some((t) => t.id === id && t.eventKind === kind));
  }
  function append(f: MockFile, e: TimelineEntry): MockFile['timeline'] {
    const key = String(e.chapterId);
    const prior = (f.timeline[key as unknown as number] ?? []).map((t) => (e.reversible ? { ...t, reversible: false } : t));
    return { ...f.timeline, [key]: [...prior, e] };
  }

  export function seedMockRevisions(bookId: string, seed: MockRevisionsSeed): void {
    books.set(bookId, {
      file: { ...emptyFile(), ...structuredClone(seed.state ?? {}) },
      previous: new Set(seed.previousChapterIds ?? []),
      live: new Set(seed.liveChapterIds ?? []),
    });
  }
  export function resetMockRevisions(): void { books.clear(); }
  export function hasMockRevisions(bookId: string): boolean { return books.has(bookId); }
  export function getMockRevisions(bookId: string): RevisionsState { return view(bookId, book(bookId)); }
  export function mockHasPrevious(bookId: string, chapterId: number): boolean { return book(bookId).previous.has(chapterId); }

  function op(bookId: string, revisionId: string, kind: 'accepted' | 'rejected'): { b: Book; entry: Revision } | { b: Book; done: RevisionsState } {
    const b = book(bookId);
    const entry = b.file.pending.find((p) => p.id === revisionId);
    if (!entry) {
      if (hasOutcome(b.file, kind, revisionId)) return { b, done: view(bookId, b) };
      fail(bookId, b, 404, 'revision_not_found', 'This take was replaced by a newer render or is no longer pending.');
    }
    return { b, entry };
  }
  function commit(bookId: string, b: Book, entry: Revision, kind: 'accepted' | 'rejected', selection?: Record<number, 'A' | 'B'>): RevisionsState {
    save(b, {
      ...b.file,
      pending: b.file.pending.filter((p) => p.id !== entry.id),
      timeline: append(b.file, { id: entry.id, chapterId: entry.chapterId, characterId: entry.characterId, eventKind: kind, timestamp: new Date().toISOString(), status: 'active', reversible: true }),
      acceptedSelections: kind === 'accepted' ? { ...b.file.acceptedSelections, [entry.id]: selection ?? {} } : b.file.acceptedSelections,
    });
    return view(bookId, b);
  }

  export function mockAcceptRevision(bookId: string, revisionId: string, selection?: Record<number, 'A' | 'B'>): RevisionsState {
    const r = op(bookId, revisionId, 'accepted');
    if ('done' in r) return r.done;
    const ch = r.entry.chapterId;
    if (!r.b.live.has(ch) && r.b.previous.has(ch)) {
      fail(bookId, r.b, 409, 'live_audio_missing', "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it.");
    }
    r.b.previous.delete(ch);
    return commit(bookId, r.b, r.entry, 'accepted', selection);
  }
  export function mockRejectRevision(bookId: string, revisionId: string): RevisionsState {
    const r = op(bookId, revisionId, 'rejected');
    if ('done' in r) return r.done;
    const ch = r.entry.chapterId;
    if (!r.b.previous.has(ch)) fail(bookId, r.b, 409, 'no_previous_audio', 'Original audio not preserved.');
    r.b.previous.delete(ch);
    r.b.live.add(ch);
    return commit(bookId, r.b, r.entry, 'rejected');
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
  In `src/data/revisions.ts`, add to `rev1`: `playable: true, hasPreviousAudio: true, origin: 'server',`.
  If `structuredClone` is unavailable in the jsdom test env, use `JSON.parse(JSON.stringify(...))`.

- [ ] **Step 3: Green.** Run the new test; `typecheck`.

- [ ] **Step 4: Mutations.**
  1. In `mockRecordRender`, drop the `&& hadAudio` from the record branch → red: `a review render records only when the chapter already had audio`.
  2. In `mockAcceptRevision`, remove the `live_audio_missing` check → red: that test.
  3. In `hasOutcome`, drop the `t.eventKind === kind` check → red: `a repeated accept…; a reject of an accepted id is 404`.

- [ ] **Step 5: Commit.** `feat(mocks): add an in-memory server-owned revisions store for mock mode (#3400)`.

---

### Task 6: Wire the mock store into the mock API (D7)

**Character:** judgment (several mock functions in a 10k-line file).

**Files:**
- Modify: `src/lib/api.ts`: `buildSolwayBayMockState` (drop `revisions: { pending: PENDING_REVISIONS }`), `seedDefaultMockBookStates`/`_resetMockBookStates`, `mockGetBookState`, `mockPollRevisions`, mock `pollRevisionsBulk`, `mockGetChapterAudioPrevious`, the `mock` object.
- Test: create `src/lib/api.mock-revisions.test.ts`.

**Interfaces:**
- Consumes: Task 5's module.
- Produces (mock): `acceptRevision`, `rejectRevision`, `dismissDrift`, `restorePreviousUnrecorded` with the real signatures (each `await wait(100)`); `pollRevisions` returning `{ ...getMockRevisions(bookId), drift }`; `getBookState` overlaying `revisions: getMockRevisions(bookId)` when `hasMockRevisions(bookId)`; `getChapterAudioPrevious` returning `null` unless `mockHasPrevious`.
- Produces: default seed — `seedMockRevisions('sb', { state: { pending: [PENDING_REVISIONS[0]] }, previousChapterIds: [3], liveChapterIds: SB_CHAPTERS.map((c) => c.id) })`, applied wherever the default mock book states are seeded and on `_resetMockBookStates()` (call `resetMockRevisions()` first).

- [ ] **Step 1: Failing test** — `src/lib/api.mock-revisions.test.ts`. The mock functions are module-private; test them through exports. Export them from `api.ts` with an `_` prefix for tests only, mirroring `_resetMockBookStates`/`mockPutBookState`: `export { mockPollRevisions as _mockPollRevisions, mockGetChapterAudioPrevious as _mockGetChapterAudioPrevious }` and export `mockGetBookState` if it is not already (it is `export async function` at `~:1288` — check). Then:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { _resetMockBookStates, _mockPollRevisions, _mockGetChapterAudioPrevious, mockGetBookState } from './api';
  import { seedMockRevisions } from '../mocks/mock-revisions';

  beforeEach(() => _resetMockBookStates());

  describe('mock API reads per-book revisions (plan 286, D7)', () => {
    it('the poll returns each book its own pending, never the sb fixture for every book', async () => {
      expect((await _mockPollRevisions({ bookId: 'sb' })).pending?.map((p) => p.id)).toEqual(['rev1']);
      expect((await _mockPollRevisions({ bookId: 'cc' })).pending).toEqual([]);
    });
    it('the poll carries fileId and rev', async () => {
      const p = await _mockPollRevisions({ bookId: 'sb' });
      expect(p).toMatchObject({ bookId: 'sb', fileId: null, rev: 0 });
    });
    it('getBookState overlays the mock revisions state', async () => {
      seedMockRevisions('cc', { state: { pending: [{ id: 'x', chapterId: 1, characterId: 'eliza', segments: [], origin: 'server' }] } });
      expect((await mockGetBookState('cc'))?.revisions?.pending?.map((p) => p.id)).toEqual(['x']);
    });
    it('previous audio is null unless the chapter is in previousChapterIds', async () => {
      expect(await _mockGetChapterAudioPrevious({ bookId: 'sb', chapterId: 3, duration: '11:31' })).not.toBeNull();
      expect(await _mockGetChapterAudioPrevious({ bookId: 'sb', chapterId: 4, duration: '11:31' })).toBeNull();
    });
  });
  ```
  (If the mock `getBookState` is named differently, use its real name.)

  **Mock/real contract** (spec PR 2 test list): add to `api.ts`, after `const mock = {…}`, `export type __MockApi = typeof mock; export type __RealApi = typeof real;` and to `src/lib/api-types.revisions-contract.test.ts`:
  ```ts
  import type { __MockApi, __RealApi } from './api';
  it('plan 286 — mock and real revisions functions have identical signatures', () => {
    type K = 'acceptRevision' | 'rejectRevision' | 'dismissDrift' | 'restorePreviousUnrecorded' | 'pollRevisions' | 'pollRevisionsBulk' | 'getChapterAudioPrevious';
    expectTypeOf<Pick<__MockApi, K>>().toEqualTypeOf<Pick<__RealApi, K>>();
  });
  ```
  Run → FAIL (and `typecheck` fails until the mocks exist).

- [ ] **Step 2: Implement.**
  - `mockPollRevisions(args)`: keep the `await wait(200)` and the drift selection exactly as today (both branches, including `DEMO_CAPTURE`), but return `{ ...getMockRevisions(args.bookId), drift }`. Delete the two stale comment paragraphs about `pending` being inert (they become false); replace with one line: `/* Plan 286 — pending comes from the per-book mock store (D7). */`.
  - Mock `pollRevisionsBulk`: unchanged shape — it already calls `mockPollRevisions` per id; map each to `{ pending, drift }`.
  - `mockGetBookState(bookId)`: after resolving the stored response `r` (both the `HOLLOW_TIDE_BOOK_STATES` and the `MOCK_BOOK_STATES` branch), return `r && hasMockRevisions(bookId) ? { ...r, revisions: getMockRevisions(bookId) } : r`.
  - `mockGetChapterAudioPrevious({ bookId, chapterId, duration })`: `if (!mockHasPrevious(bookId, chapterId)) return null;` before building the response; widen its return type to `Promise<ChapterAudio | null>` (matches `real`). Update its header comment ("Mock mode always resolves" → "resolves only when `.previous` is mirrored in the mock store").
  - Remove `revisions: { pending: PENDING_REVISIONS }` from `buildSolwayBayMockState` and its comment block; the default seed replaces it.
  - Seeding: in the function that runs `MOCK_BOOK_STATES.set('sb', buildSolwayBayMockState())` (`~:1189`), add `resetMockRevisions(); seedMockRevisions('sb', { state: { pending: [PENDING_REVISIONS[0]] }, previousChapterIds: [3], liveChapterIds: SB_CHAPTERS.map((c) => c.id) });`. `_resetMockBookStates` already calls that function, so it resets too.
  - The `mock` object gains:
    ```ts
    acceptRevision: async ({ bookId, revisionId, selection }: { bookId: string; revisionId: string; selection?: Record<number, 'A' | 'B'> }) => { await wait(100); return mockAcceptRevision(bookId, revisionId, selection); },
    rejectRevision: async ({ bookId, revisionId }: { bookId: string; revisionId: string }) => { await wait(100); return mockRejectRevision(bookId, revisionId); },
    dismissDrift: async ({ bookId, driftId }: { bookId: string; driftId: string }) => { await wait(60); return mockDismissDrift(bookId, driftId); },
    restorePreviousUnrecorded: async ({ bookId, chapterId }: { bookId: string; chapterId: number }) => { await wait(60); return mockRestoreUnrecorded(bookId, chapterId); },
    ```
  - **Tests other than this file that change:** run `src/lib/api.mock-state.test.ts` and any test grepping `PENDING_REVISIONS`; `profile-regen-preview.spec.ts`'s A card now reads "Original audio not preserved" for `cc` (no assertion depends on it).

- [ ] **Step 3: Green.** Run the new test, `src/lib/api.mock-state.test.ts`, `typecheck`. Then run `npm --prefix <wt> run test:e2e -- e2e/revision-diff.spec.ts e2e/drift-report-multibook.spec.ts` (the sb fixture still opens the player; drift still per book).

- [ ] **Step 4: Mutations.**
  1. Make `mockPollRevisions` return `pending: PENDING_REVISIONS` again → red: `the poll returns each book its own pending…`.
  2. Remove the `mockHasPrevious` early return → red: `previous audio is null unless…`.
  3. Change the mock `dismissDrift` to return `Promise<void>` → `typecheck` red at `mock and real revisions functions have identical signatures`.

- [ ] **Step 5: Commit.** `fix(mocks): serve per-book revisions from the mock store (D7) (#3400)`.

---

### Task 6b: Mock splice + mock review generation + `window.__mockRevisions`

> Its own dispatch and commit. Numbered 6b because it was split out of Task 6 for size; it runs after Task 6.

**Character:** judgment.

**Files:**
- Modify: `src/lib/api.ts`: `mockStreamSplice`, `mockStreamGeneration` (the `chapter_complete` branch of `tick`).
- Modify: `src/main.tsx` (DEV/e2e hook block).
- Test: `src/lib/api.mock-revisions.test.ts` (extend).

**Interfaces:**
- `mockStreamSplice({ bookId, chapterId, mode, characterId, onTick })`: per-step delay `window.__mockSpliceDelayMs ?? 80`. Before `splice_complete`, call `mockRecordRender(bookId, chapterId, { characterId, triggeredBy }, { assumeLive: true })` where `triggeredBy = \`${mode === 'remix' ? 'Loudness fix' : 'Re-record'} (${firstName})\`` and `firstName` = the mock cast's name for `characterId` in `MOCK_BOOK_STATES.get(bookId)?.cast?.characters`, first word, falling back to `characterId`. Emit `reviewRecorded: true` on `splice_complete`.
- `mockStreamGeneration`: let `reviewChapterId = review && chapterIds?.length === 1 ? chapterIds[0] : null`. On each `chapter_complete`: if `active.id === reviewChapterId`, `const rec = mockRecordRender(bookId, active.id, { ...review, oldDuration: active.duration, newDuration: active.duration })` and add `reviewChapter: true, reviewRecorded: true` to the tick (finalize reports `true` whenever the record **or** drop landed, even if nothing was recorded — mirror that). Otherwise `mockRecordRender(bookId, active.id, null)`.
- `window.__mockRevisions = { seed: seedMockRevisions, get: getMockRevisions, reset: resetMockRevisions }` in `main.tsx`, same gate as `__mockQueue`.

- [ ] **Step 1: Failing tests** (append to `api.mock-revisions.test.ts`; export `mockStreamSplice` as `_mockStreamSplice` for tests):
  ```ts
  describe('mock renders record pending (plan 286)', () => {
    it('a splice records a server entry for the chapter and reports reviewRecorded', async () => {
      const ticks: Array<{ type: string; reviewRecorded?: boolean }> = [];
      await _mockStreamSplice({ bookId: 'cc', chapterId: 2, mode: 'remix', characterId: 'eliza_cc', gainDb: 3, onTick: (t) => ticks.push(t) });
      expect(ticks.at(-1)).toMatchObject({ type: 'splice_complete', reviewRecorded: true });
      const p = (await _mockPollRevisions({ bookId: 'cc' })).pending ?? [];
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ chapterId: 2, origin: 'server', triggeredBy: expect.stringMatching(/^Loudness fix \(/) });
    });
  });
  ```
  For `mockStreamGeneration`, add a test with `vi.useFakeTimers()`: call `api.streamGeneration` is not reachable (vitest = real), so export `mockStreamGeneration` as `_mockStreamGeneration`, call it with `bookId: 'cc'`, `chapterIds: [1]`, `review: { characterId: 'eliza_cc', triggeredBy: 'Eliza voice change' }`, a `getChapters` returning one `in_progress` chapter `{ id: 1, progress: 0.99, totalLines: 10, characters: {}, duration: '01:00' }` (copy the exact chapter shape the existing mock generation tests use — search `mockStreamGeneration` in `src/**/*.test.ts`), advance 1300 ms, and assert the `chapter_complete` tick has `reviewChapter: true`. Seed `liveChapterIds: [1]` first and assert one pending entry; without the seed assert none.

  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces. Add the `Window` field typing inline as the file does for `__mockGenConcurrency`. In `main.tsx`:
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

- [ ] **Step 3: Green.** Run the test file, `typecheck`, and `npm --prefix <wt> run test:e2e -- e2e/character-splice.spec.ts e2e/profile-regen-preview.spec.ts` (still green: the client still enqueues its own pending at this point).

- [ ] **Step 4: Mutations.**
  1. Pass `{ assumeLive: false }` in `mockStreamSplice` → red: the splice test (no entry: `cc` has no live chapters).
  2. Stamp `reviewChapter: true` on every `chapter_complete` → red: a second assertion in the generation test — add `expect(nonReviewTick).not.toHaveProperty('reviewChapter')` for a run without `review`.

- [ ] **Step 5: Commit.** `feat(mocks): record pending on mock splices and review renders (#3400)`.

---

### Task 7: Revisions slice — the cache reducers and selectors (additive)

**Character:** judgment (the ordering rule is the heart of the PR).

**Files:**
- Modify: `src/store/revisions-slice.ts`.
- Test: create `src/store/revisions-slice.cache.test.ts`.

**Interfaces:**
- Produces (fields): `fileId: string | null` (initial `null`), `rev: number` (initial `0`).
- Produces (pure): `export function compareFileIds(a: string | null, b: string | null): number` (`null` oldest; else string order).
- Produces (reducers):
  - `hydrate(payload: { bookId: string; state: Partial<RevisionsState> | null })`: adopts when `bookId` differs **or** `(state?.fileId ?? null) !== s.fileId`; otherwise only when `(state?.rev ?? 0) >= s.rev`. Sets `loaded = true`. **Transitional:** also sets `s.hydratedFor = bookId` (deleted with the field in Task 18) so the old persistence gate keeps working until then.
  - `applyServerState(payload: RevisionsState)`: ordered adopt (below).
  - `applyDismiss(payload: { driftId: string; state?: RevisionsState })`: always removes the event from `drift`; applies `state` through the ordered rule when given.
  - `forgetBook(payload: string)`: if `s.bookId === payload`, resets `bookId` to `null`, `fileId` to `null`, `rev` to `0`, and the four per-book fields to empty.
  - **Ordered adopt:** different `bookId` → adopt; same book → `compareFileIds(incoming, cached)`: `> 0` adopt, `< 0` ignore, `0` adopt iff `incoming.rev >= cached.rev`.
  - *Adopt* sets `bookId`, `fileId`, `rev`, `pending`, `dismissed`, `acceptedSelections`, `timeline` (via `normaliseTimelineKeys`), each defaulting to empty. It never touches `drift` or `loaded`.
- Produces (selectors): `selectActivePending`, `selectActiveTimeline`, `selectActiveAcceptedSelections` over `{ revisions: RevisionsState; ui: { stage: unknown } }`, returning module-level empty constants when `revisions.bookId === null || revisions.bookId !== (ui.stage as { bookId?: string }).bookId`.
- `applyPoll` is **not** changed in this task (Task 12 changes it).

- [ ] **Step 1: Failing tests** — `src/store/revisions-slice.cache.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { revisionsSlice, revisionsActions as a, compareFileIds, selectActivePending, type RevisionsState } from './revisions-slice';

  const reduce = (s: RevisionsState, ...acts: Parameters<typeof revisionsSlice.reducer>[1][]) => acts.reduce(revisionsSlice.reducer, s);
  const init = () => revisionsSlice.reducer(undefined, { type: '@@init' });
  const st = (o: Partial<{ bookId: string; fileId: string | null; rev: number; ids: string[] }>) => ({
    bookId: o.bookId ?? 'A', fileId: o.fileId ?? null, rev: o.rev ?? 0,
    pending: (o.ids ?? []).map((id) => ({ id, chapterId: 1, characterId: 'c', segments: [] })),
    dismissed: [], acceptedSelections: {}, timeline: {},
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
    it('null → id adopts (a legacy book\'s first op), and a newer fileId adopts even at a lower rev', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: null, rev: 0, ids: ['legacy'] })));
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 1, ids: [] })));
      expect(s.fileId).toBe(F1);
      s = reduce(s, a.applyServerState(st({ fileId: F2, rev: 0, ids: ['reset'] })));
      expect(s.fileId).toBe(F2); expect(s.rev).toBe(0);
    });
    it('ignores an older fileId (a late pre-reset response) and a null fileId over a non-null cache', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F2, rev: 0, ids: [] })));
      s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 9, ids: ['stale'] })));
      s = reduce(s, a.applyServerState(st({ fileId: null, rev: 9, ids: ['legacy'] })));
      expect(s.fileId).toBe(F2); expect(s.pending).toEqual([]);
    });
  });

  describe('hydrate', () => {
    it('adopts a different fileId even when it is null (delete + re-import under the same id)', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F2, rev: 4, ids: ['old'] })));
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0, ids: [] }) }));
      expect(s.fileId).toBeNull(); expect(s.pending).toEqual([]);
    });
    it('with the same fileId, a stale hydrate does not drop a newer entry', () => {
      let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['new'] })));
      s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: F1, rev: 2, ids: [] }) }));
      expect(s.pending.map((p) => p.id)).toEqual(['new']);
    });
    it('a null state for a new book adopts an empty cache and flips loaded', () => {
      const s = reduce(init(), a.hydrate({ bookId: 'A', state: null }));
      expect(s).toMatchObject({ bookId: 'A', fileId: null, rev: 0, pending: [], loaded: true });
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
    it('return empty for a non-active book', () => {
      const revisions = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 1, ids: ['x'] })));
      expect(selectActivePending({ revisions, ui: { stage: { kind: 'ready', bookId: 'A' } } })).toHaveLength(1);
      expect(selectActivePending({ revisions, ui: { stage: { kind: 'ready', bookId: 'B' } } })).toEqual([]);
      expect(selectActivePending({ revisions, ui: { stage: { kind: 'books' } } })).toEqual([]);
    });
    it('return a stable empty reference', () => {
      const revisions = init();
      const ui = { stage: { kind: 'books' } };
      expect(selectActivePending({ revisions, ui })).toBe(selectActivePending({ revisions, ui }));
    });
  });
  ```
  Run → FAIL.

- [ ] **Step 2: Implement** in `revisions-slice.ts`:
  - Add `fileId: string | null;` and `rev: number;` to `RevisionsState` with doc comments ("Plan 286 — the server file identity/version this cache last adopted; ordered by `compareFileIds` then `rev`"), and `fileId: null, rev: 0` to `initialState`.
  - Import `RevisionsState as WireRevisionsState` from `../lib/types`.
  - Add helpers above `revisionsSlice`:
    ```ts
    /** Plan 286 — fileId order: null (a legacy file never written through the
        store) is older than any id; ids are `${epoch 15-padded}-${random}`, so
        string order is epoch order with the suffix breaking a same-ms tie. */
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
    }

    /** Plan 286 — the cache rule for polls and op responses (spec §4). */
    function shouldAdoptOrdered(s: RevisionsState, p: IncomingRevisions): boolean {
      if (s.bookId !== p.bookId) return true;
      const c = compareFileIds(p.fileId ?? null, s.fileId);
      if (c !== 0) return c > 0;
      return (p.rev ?? 0) >= s.rev;
    }
    ```
  - Add the reducers (keep every existing reducer for now):
    ```ts
    /** Plan 286 — book-open / reopen hydrate from GET /state. Unlike the
        ordered rule, ANY fileId difference adopts (null included): a book
        deleted and re-imported under its deterministic id reads fileId:null. */
    hydrate: (s, a: PayloadAction<{ bookId: string; state: Partial<WireRevisionsState> | null }>) => {
      const p: IncomingRevisions = { ...(a.payload.state ?? {}), bookId: a.payload.bookId };
      const differs = s.bookId !== p.bookId || (p.fileId ?? null) !== s.fileId;
      if (differs || (p.rev ?? 0) >= s.rev) adopt(s, p);
      s.loaded = true;
      /* Transitional (Task 18 deletes the field): keeps the old persistence
         gate open for writes still dispatched by not-yet-migrated callers. */
      s.hydratedFor = p.bookId;
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
      s.bookId = null;
      s.fileId = null;
      s.rev = 0;
      s.pending = [];
      s.dismissed = [];
      s.acceptedSelections = {};
      s.timeline = {};
    },
    ```
  - Selectors, after `revisionsActions`:
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
  - `bookScopeChanged` (still present until Task 18) must also reset `fileId = null; rev = 0` — otherwise a cache keyed to book A carries A's `rev` into book B's equal-`fileId` comparison. Add those two lines and a test: `bookScopeChanged resets fileId and rev`.

- [ ] **Step 3: Green.** Run the new file and `src/store/revisions-slice.test.ts` (initial-state test may need `fileId: null, rev: 0` added), `typecheck` (any hand-built `RevisionsState` in other tests needs the two fields — fix each, they are mechanical).

- [ ] **Step 4: Mutations.**
  1. In `compareFileIds`, swap the `null` branches → red: `null is older than any id…`.
  2. In `shouldAdoptOrdered`, change `>=` to `>` → red: `ignores a lower rev…; adopts an equal or higher rev` (equal rev not adopted).
  3. In `hydrate`, drop the `|| (p.fileId ?? null) !== s.fileId` clause → red: `adopts a different fileId even when it is null`.
  4. In `holdsActive`, drop `s.revisions.bookId !== null &&` and make the cache `bookId` null with an `{ kind: 'books' }` stage → red: covered by `return empty for a non-active book` (the `books` stage case) — confirm it goes red; if not, add the case `revisions.bookId === null` with a stage that has no bookId.

- [ ] **Step 5: Commit.** `feat(frontend): add the ordered revisions cache reducers and active-book selectors (#3400)`.

---

### Task 8: UI slice — `openRevision`, `revisionOpInFlight`, `PreviewRegenCtx.bookId`/`stub`

**Character:** mechanical.

**Files:**
- Modify: `src/store/ui-slice.ts`; `src/components/layout.tsx` (the one `uiActions.setPreviewRegen({ characterId, previewChapterId, … })` call in the regenerate-character `onConfirm`, `~:2067`, gains `bookId`).
- Modify: `src/store/chapters-slice.ts` (export `previewChapterComplete`).
- Tests: `src/store/ui-slice.test.ts` (or the existing ui-slice test file), and every test constructing a `PreviewRegenCtx` (grep `previewChapterId:` in `src/**/*.test.*` and `e2e/**`).

**Interfaces:**
- Produces:
  ```ts
  export type OpenRevision = { kind: 'server'; revisionId: string; chapterId: number } | { kind: 'preview-stub' };
  // UiState
  openRevision: OpenRevision | null;   // initial null; transient (not in UI_PERSIST_WHITELIST)
  revisionOpInFlight: boolean;         // initial false
  // PreviewRegenCtx
  bookId: string;
  stub?: Revision;                     // the client-only preview stub (Tasks 15–16)
  // actions
  setOpenRevision(payload: OpenRevision | null); setRevisionOpInFlight(payload: boolean);
  ```
- Produces (`chapters-slice.ts`): `export const previewChapterComplete = createAction<{ bookId: string; chapterId: number; reviewRecorded?: boolean }>('chapters/previewChapterComplete');` — no reducer.
- `showRevisionPlayer` stays until Task 14.

- [ ] **Step 1: Failing test** (ui-slice test file):
  ```ts
  it('plan 286 — openRevision and revisionOpInFlight round-trip and start empty', () => {
    let s = uiSlice.reducer(undefined, { type: '@@init' });
    expect(s.openRevision).toBeNull(); expect(s.revisionOpInFlight).toBe(false);
    s = uiSlice.reducer(s, uiActions.setOpenRevision({ kind: 'server', revisionId: 'r', chapterId: 3 }));
    s = uiSlice.reducer(s, uiActions.setRevisionOpInFlight(true));
    expect(s.openRevision).toEqual({ kind: 'server', revisionId: 'r', chapterId: 3 });
    expect(s.revisionOpInFlight).toBe(true);
  });
  it('plan 286 — openRevision is not persisted', () => {
    expect(UI_PERSIST_WHITELIST).not.toContain('openRevision');
  });
  ```
  (Import `UI_PERSIST_WHITELIST` from `./index` only if the existing `persist-whitelist.test.ts` does so; otherwise put the second assertion there.) Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces. In layout, `setPreviewRegen({ bookId, characterId, previewChapterId, remainingChapterIds, reason, note })` — `bookId` is already in scope there (the handler returns early on `!bookId`). Fix every test fixture that builds a `PreviewRegenCtx` (add `bookId: 'cc'` or the test's book) — typecheck lists them.

- [ ] **Step 3: Green.** ui-slice tests, `generation-stream-middleware.test.ts`, `layout.test.tsx -t "preview"`, `typecheck`.

- [ ] **Step 4: Mutations.** Add `'openRevision'` to `UI_PERSIST_WHITELIST` → red: `openRevision is not persisted`.

- [ ] **Step 5: Commit.** `feat(frontend): add openRevision, op-in-flight and preview bookId to the ui slice (#3400)`.

---

### Task 9: Thunks — confirm, then apply

**Character:** judgment.

**Files:**
- Create: `src/store/revisions-thunks.ts`.
- Test: create `src/store/revisions-thunks.test.ts`.

**Interfaces:**
- Consumes: Task 4/6 `api.*` ops and `RevisionOpFailure`; Task 7 reducers/selectors; Task 8 ui actions.
- Produces:
  ```ts
  export type RevisionOpOutcome = { ok: true } | { ok: false; code: RevisionOpCode | 'network' };
  export function refetchActiveRevisions(bookId: string): (d, g) => Promise<'ok' | 'failed' | 'skipped'>;
  export function acceptRevisionOp(args: { bookId: string; revisionId: string; selection?: Record<number, 'A' | 'B'> }): (d, g) => Promise<RevisionOpOutcome>;
  export function rejectRevisionOp(args: { bookId: string; revisionId: string }): (d, g) => Promise<RevisionOpOutcome>;
  export function dismissDriftOp(driftId: string): (d, g) => Promise<void>;
  ```
- Behaviour (spec §4 "Thunks" table):
  - Every op sets `ui.revisionOpInFlight` true for its duration (cleared in `finally`).
  - Success: `applyServerState(state)` **only if** the active book (read at dispatch time) is `bookId`; then `setOpenRevision(null)`. Returns `{ ok: true }`. No toast.
  - `revision_not_found` / `revision_gone`: apply the body's `state` if present and active, else `refetchActiveRevisions(bookId)`; `setOpenRevision(null)`; if `ui.previewRegen` is set, `setPreviewRegen(null)`; exactly one warn toast "This take was replaced by a newer render" (dedupe `revision-op-gone`).
  - `chapter_busy`: warn toast busy; apply `state` if present+active; player stays open.
  - `no_previous_audio`: warn toast "Original audio not preserved"; apply `state`; player stays open (Keep new take, Task 14).
  - `live_audio_missing`: error toast; apply `state`; player stays open.
  - `restore_failed`: error toast; `refetchActiveRevisions(bookId)`; player stays open.
  - Anything else (incl. a network error, code `'network'`): error toast "Couldn't update the revision — ‹message›"; cache unchanged.
  - Toast dedupe keys: `revision-op-<code>`.
  - `refetchActiveRevisions(bookId)`: `'skipped'` if not active; else `api.pollRevisions({ bookId })` → if still active `applyPoll({ ...res, bookId })` → `'ok'`; a throw → `'failed'` (no toast; callers decide).
  - `dismissDriftOp(driftId)`: book = the drift event's `bookId` in `revisions.drift`, else the active book; none → return. `api.dismissDrift` → `applyDismiss({ driftId, state: active === book ? state : undefined })`. A throw → error toast "Couldn't dismiss the drift event — try again" (dedupe `drift-dismiss-failed`); the event stays (OD19).

- [ ] **Step 1: Failing tests** — `src/store/revisions-thunks.test.ts`. Mock `../lib/api` the way `queue-thunks` tests do (`vi.mock('../lib/api', () => ({ api: { acceptRevision: vi.fn(), rejectRevision: vi.fn(), dismissDrift: vi.fn(), pollRevisions: vi.fn() } }))`), and build a store with `ui`, `revisions`, `notifications` reducers:
  ```ts
  const S = (bookId: string, fileId: string, rev: number, ids: string[] = []) => ({ bookId, fileId, rev, pending: ids.map((id) => ({ id, chapterId: 3, characterId: 'c', segments: [] })), dismissed: [], acceptedSelections: {}, timeline: {} });
  function makeStore(activeBook = 'A') {
    const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer, notifications: notificationsSlice.reducer } });
    store.dispatch(uiActions.openBook({ id: activeBook, status: 'complete' } as never));
    store.dispatch(revisionsActions.applyServerState(S(activeBook, '000000000000001-a', 1, ['r1'])));
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
    return store;
  }
  const toasts = (s: ReturnType<typeof makeStore>) => s.getState().notifications.toasts.map((t) => t.message);

  it('success applies the returned state, closes the player, no toast, in-flight cleared', async () => {
    api.acceptRevision.mockResolvedValueOnce(S('A', '000000000000001-a', 2));
    const store = makeStore();
    const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    expect(out).toEqual({ ok: true });
    expect(store.getState().revisions.pending).toEqual([]);
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
    expect(toasts(store)).toEqual([]);
  });
  it('sets revisionOpInFlight while the op runs', async () => {
    let release!: (v: unknown) => void;
    api.rejectRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore();
    const p = store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    expect(store.getState().ui.revisionOpInFlight).toBe(true);
    release(S('A', '000000000000001-a', 2)); await p;
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
  });
  it('a response for a book the user has left is not applied', async () => {
    let release!: (v: unknown) => void;
    api.acceptRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    const p = store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
    release(S('A', '000000000000001-a', 2)); await p;
    expect(store.getState().revisions.rev).toBe(1);
  });
  it('revision_gone with an open preview: applies state, closes the player, clears previewRegen, exactly one toast', async () => {
    api.acceptRevision.mockRejectedValueOnce(new RevisionOpFailure('gone', 409, 'revision_gone', S('A', '000000000000001-a', 3)));
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen({ bookId: 'A', characterId: 'c', previewChapterId: 3, remainingChapterIds: [4], reason: '', note: '' }));
    const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    expect(out).toEqual({ ok: false, code: 'revision_gone' });
    expect(store.getState().revisions.rev).toBe(3);
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen).toBeNull();
    expect(toasts(store)).toEqual(['This take was replaced by a newer render']);
  });
  it('revision_not_found without a state refetches', async () => {
    api.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('nf', 404, 'revision_not_found'));
    api.pollRevisions.mockResolvedValueOnce({ ...S('A', '000000000000001-a', 4), drift: [] });
    const store = makeStore();
    await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    expect(api.pollRevisions).toHaveBeenCalledWith({ bookId: 'A' });
    /* Task 12 adds: expect(store.getState().revisions.rev).toBe(4) — applyPoll
       only adopts server state from Task 12 on. */
  });
  it.each([
    ['chapter_busy', 'This chapter is busy — try again when it finishes'],
    ['no_previous_audio', 'Original audio not preserved'],
    ['live_audio_missing', "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it"],
  ])('%s keeps the player open with its toast', async (code, msg) => {
    api.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('x', 409, code as never, S('A', '000000000000001-a', 1, ['r1'])));
    const store = makeStore();
    await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    expect(store.getState().ui.openRevision).not.toBeNull();
    expect(toasts(store)).toEqual([msg]);
  });
  it('restore_failed toasts, refetches and keeps the entry', async () => {
    api.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('x', 500, 'restore_failed'));
    api.pollRevisions.mockResolvedValueOnce({ ...S('A', '000000000000001-a', 1, ['r1']), drift: [] });
    const store = makeStore();
    await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    expect(toasts(store)).toEqual(["Couldn't restore the original — try Reject again"]);
    expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['r1']);
  });
  it('an unexpected failure toasts and leaves the cache alone', async () => {
    api.acceptRevision.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const store = makeStore();
    const before = store.getState().revisions;
    const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1' }));
    expect(out).toEqual({ ok: false, code: 'network' });
    expect(store.getState().revisions).toBe(before);
    expect(toasts(store)).toEqual(["Couldn't update the revision — Failed to fetch"]);
  });
  it('a legacy id (revision:<ch>:<char>) is sent as-is to the server op', async () => {
    api.acceptRevision.mockResolvedValueOnce(S('A', '000000000000001-a', 2));
    const store = makeStore();
    await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'revision:3:eliza' }));
    expect(api.acceptRevision).toHaveBeenCalledWith({ bookId: 'A', revisionId: 'revision:3:eliza' });
  });
  it('dismissDriftOp posts to the event\'s own book; a foreign dismiss leaves the active rev alone', async () => {
    const store = makeStore('A');
    store.dispatch(revisionsActions.applyBackgroundPoll({ bookId: 'B', drift: [{ id: 'dB', bookId: 'B' } as never] }));
    api.dismissDrift.mockResolvedValueOnce(S('B', '000000000000009-z', 7));
    await store.dispatch(dismissDriftOp('dB'));
    expect(api.dismissDrift).toHaveBeenCalledWith({ bookId: 'B', driftId: 'dB' });
    expect(store.getState().revisions.drift).toEqual([]);
    expect(store.getState().revisions.rev).toBe(1);
  });
  it('refetchActiveRevisions skips a non-active book and reports a failure', async () => {
    const store = makeStore('A');
    expect(await store.dispatch(refetchActiveRevisions('B'))).toBe('skipped');
    api.pollRevisions.mockRejectedValueOnce(new Error('x'));
    expect(await store.dispatch(refetchActiveRevisions('A'))).toBe('failed');
  });
  ```
  (`uiActions.openBook` is the existing action; use whatever payload shape the slice already takes. `applyPoll` currently accepts any payload with `bookId` and ignores pending — the refetch tests still pass after Task 12 changes it, because Task 12 re-runs this file.)

  Run → FAIL.

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

  const activeBookId = (s: RootState): string | null => (s.ui.stage as { bookId?: string }).bookId ?? null;

  const COPY = {
    gone: 'This take was replaced by a newer render',
    busy: 'This chapter is busy — try again when it finishes',
    noPrevious: 'Original audio not preserved',
    liveMissing: "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it",
    restoreFailed: "Couldn't restore the original — try Reject again",
  } as const;

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

  function runOp(bookId: string, call: () => Promise<RevisionsState>) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<RevisionOpOutcome> => {
      const applyIfActive = (state: RevisionsState | undefined): boolean => {
        if (!state || activeBookId(getState()) !== bookId) return false;
        dispatch(revisionsActions.applyServerState(state));
        return true;
      };
      const toast = (kind: 'warn' | 'error', message: string, code: string) =>
        dispatch(notificationsActions.pushToast({ kind, message, dedupeKey: `revision-op-${code}` }));
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
          case 'revision_gone':
            if (!applyIfActive(f?.state)) void dispatch(refetchActiveRevisions(bookId));
            dispatch(uiActions.setOpenRevision(null));
            if (getState().ui.previewRegen) dispatch(uiActions.setPreviewRegen(null));
            toast('warn', COPY.gone, 'gone');
            break;
          case 'chapter_busy':
            applyIfActive(f?.state);
            toast('warn', COPY.busy, code);
            break;
          case 'no_previous_audio':
            applyIfActive(f?.state);
            toast('warn', COPY.noPrevious, code);
            break;
          case 'live_audio_missing':
            applyIfActive(f?.state);
            toast('error', COPY.liveMissing, code);
            break;
          case 'restore_failed':
            void dispatch(refetchActiveRevisions(bookId));
            toast('error', COPY.restoreFailed, code);
            break;
          default:
            toast('error', `Couldn't update the revision — ${(err as Error).message || 'network error'}`, 'unexpected');
        }
        return { ok: false, code };
      } finally {
        dispatch(uiActions.setRevisionOpInFlight(false));
      }
    };
  }

  export function acceptRevisionOp(args: { bookId: string; revisionId: string; selection?: Record<number, 'A' | 'B'> }) {
    return runOp(args.bookId, () => api.acceptRevision(args));
  }

  export function rejectRevisionOp(args: { bookId: string; revisionId: string }) {
    return runOp(args.bookId, () => api.rejectRevision(args));
  }

  export function dismissDriftOp(driftId: string) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
      const s = getState();
      const bookId = s.revisions.drift.find((d) => d.id === driftId)?.bookId ?? activeBookId(s);
      if (!bookId) return;
      try {
        const state = await api.dismissDrift({ bookId, driftId });
        dispatch(revisionsActions.applyDismiss({ driftId, state: activeBookId(getState()) === bookId ? state : undefined }));
      } catch {
        dispatch(notificationsActions.pushToast({ kind: 'error', message: "Couldn't dismiss the drift event — try again", dedupeKey: 'drift-dismiss-failed' }));
      }
    };
  }
  ```
  Note: `acceptRevisionOp({bookId, revisionId})` passes `args` through, so `selection: undefined` is omitted from the object only if the caller omitted it — the legacy-id test asserts the exact object; keep callers passing `selection` only when they have one.

- [ ] **Step 3: Green.** The new test file, `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Remove `if (activeBookId(getState()) !== bookId) return false;` from `applyIfActive` → red: `a response for a book the user has left is not applied`.
  2. Remove the `setPreviewRegen(null)` line → red: `revision_gone with an open preview…`.
  3. Push the gone toast twice (once per `case`) → red: same test (`exactly one toast`).
  4. Move `setRevisionOpInFlight(false)` out of `finally` into the success path only → red: the `it.each` cases (in-flight stays true) — add `expect(store.getState().ui.revisionOpInFlight).toBe(false)` to the `it.each` body.

- [ ] **Step 5: Commit.** `feat(frontend): add confirm-then-apply revisions thunks (#3400)`.

---

### Task 10: `RevisionDiffPlayer` — `busy`, `rendering`, Keep new take, audio release

**Character:** mechanical.

**Files:**
- Modify: `src/views/revision-diff.tsx`, `src/lib/use-ab-playback.ts`.
- Test: `src/views/revision-diff.test.tsx`, `src/lib/use-ab-playback.test.ts` (if it exists; else add the `release` case to `revision-diff.test.tsx`).

**Interfaces:**
- Produces (props, all optional, existing callers unaffected):
  ```ts
  busy?: boolean;            // disables Reject / Commit / Keep new take
  rendering?: boolean;       // B shows "Rendering new take…" and is unplayable
  previousMissing?: boolean; // forces the A-unavailable UI (after a no_previous_audio reject)
  onKeepNew?: () => void;    // accept without a selection
  ```
- Footer rule (review mode only): when `onKeepNew` is given **and** A is unavailable (`!hasPreviousAudio || previousMissing`), the primary button reads **Keep new take** and calls `onKeepNew`; **Reject draft** is disabled. Preview mode is unchanged (OD11).
- Produces (`useAbPlayback`): `release(): void` — pauses both elements, removes `src` and calls `load()` on each (frees Windows file handles before the server unlinks/renames). Every footer click calls `ab.release()` first, then its callback.

- [ ] **Step 1: Failing tests** in `revision-diff.test.tsx` (reuse its render helper and fixtures):
  ```ts
  it('plan 286 — busy disables every footer action', () => {
    renderPlayer({ busy: true });
    expect(screen.getByRole('button', { name: /Reject draft/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Commit selection/i })).toBeDisabled();
  });
  it('plan 286 — rendering shows the rendering copy and disables B', () => {
    renderPlayer({ rendering: true });
    expect(screen.getByText(/Rendering new take/i)).toBeInTheDocument();
  });
  it('plan 286 — A unavailable: Keep new take replaces Commit selection; Reject is disabled', () => {
    const onKeepNew = vi.fn();
    renderPlayer({ previousMissing: true, onKeepNew });
    expect(screen.queryByRole('button', { name: /Commit selection/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Keep new take/i }));
    expect(onKeepNew).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Reject draft/i })).toBeDisabled();
  });
  it('plan 286 — releases both audio elements before calling onReject', () => {
    const order: string[] = [];
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => { order.push('pause'); });
    const onReject = vi.fn(() => order.push('reject'));
    renderPlayer({ onReject });
    fireEvent.click(screen.getByRole('button', { name: /Reject draft/i }));
    expect(order.indexOf('pause')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('pause')).toBeLessThan(order.indexOf('reject'));
    pauseSpy.mockRestore();
  });
  ```
  (If the file has no `renderPlayer(overrides)` helper, add one wrapping its existing `render(<RevisionDiffPlayer … />)` call.) Run → FAIL.

- [ ] **Step 2: Implement.**
  - `use-ab-playback.ts`: add to the hook and its result type:
    ```ts
    /** Plan 286 — free both elements' file handles BEFORE an accept/reject
        reaches the server (Windows refuses to unlink/rename an open file). */
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
  - `revision-diff.tsx`: destructure the new props; `const aUnavailable = !hasPreviousAudio || previousMissing === true; const bAvailable = playable && !rendering;` — use `aUnavailable` wherever `!hasPreviousAudio` gates A (ABCard `available`, `aDisabled`, auto-compare, `handlePlay`), and `bAvailable` wherever `playable` gates B; B's `sub` shows `'Rendering new take…'` when `!bAvailable`. Footer:
    ```tsx
    const keepNewOnly = !isPreview && aUnavailable && onKeepNew !== undefined;
    …
    <button onClick={() => { ab.release(); onReject(); }} disabled={busy || keepNewOnly} className="… disabled:opacity-50 disabled:cursor-not-allowed">
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
    If `PrimaryButton` has no `disabled` prop, add one that forwards to the `<button>` (check `src/components/primitives.tsx`).

- [ ] **Step 3: Green.** `revision-diff.test.tsx` (all existing cases still pass), `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Drop `disabled={busy}` from the primary button → red: `busy disables every footer action`.
  2. Call `onReject()` before `ab.release()` → red: `releases both audio elements before calling onReject`.

- [ ] **Step 5: Commit.** `feat(frontend): add busy, rendering and Keep new take to the A/B player (#3400)`.

---

### Task 11: Layout — book-open hydrate and always-rehydrate on reopen

**Character:** judgment (layout.tsx is 2.6k lines; its test file 2.7k).

**Files:**
- Modify: `src/components/layout.tsx` — the per-book hydration effect (`useEffect(() => { if (!bookId) return; … }, [bookId, stageKind])`, `~:758-1041`) and the `revisionsHydratedFor` selector (`~:202`).
- Test: `src/components/layout.test.tsx`.

**Interfaces:**
- Consumes: `revisionsActions.hydrate` (Task 7), `GET /state`'s normalised `revisions` (Task 3; mock overlay Task 6).
- Behaviour:
  - Full load: dispatch `revisionsActions.hydrate({ bookId, state: res.revisions ?? null })` where `hydrateFromBookState` is dispatched today. `res === null` (no persisted state) → `hydrate({ bookId, state: null })`.
  - **Reopen:** when `manuscriptReady` is true the effect still fetches `getBookState` and dispatches **only** the revisions `hydrate` (today's "revisions-only" path) — now **unconditionally**, not gated on `hydratedFor` (spec §4 "Reopening a book always re-hydrates revisions"). OD1: the source stays `getBookState`.
  - Remove: `revisionsHydratedFor`/`revisionsReady`, `hasWindowWrites`, both `persistPendingAfterHydrateMerge` dispatches. Keep `flushBookPersistence` (other slices still persist).
  - Retry loop (OD3): keep it for the **full-load** path ("Couldn't load this book. Retrying…"); on the revisions-only path a failed read is logged and dropped (no toast, no retry) — the active poll repairs it.

- [ ] **Step 1: Failing tests** in `layout.test.tsx`. Replace the body of `describe('Layout — per-book hydration: revisions branch (plan 27)')`'s first test's assertions to expect the cache shape, and add:
  ```ts
  it('plan 286 — book open dispatches hydrate with the normalised revisions (fileId/rev adopted)', async () => {
    getBookStateMock.mockResolvedValue(bookStateWith({ revisions: { bookId: 'b1', fileId: '000000000000001-a', rev: 3, pending: [{ id: 'r1', chapterId: 3, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} } }));
    const store = makeStore();
    store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'cast_pending' } });
    renderAt(store, '/books/b1/cast');
    await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: 'b1', fileId: '000000000000001-a', rev: 3 }));
  });
  it('plan 286 — reopening a book always re-hydrates revisions, even with manuscript/cast already loaded', async () => {
    // open b1, let the full load land, go Library, come back
    …same setup…
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(1));
    getBookStateMock.mockResolvedValue(bookStateWith({ revisions: { bookId: 'b1', fileId: '000000000000002-a', rev: 0, pending: [{ id: 'fresh', chapterId: 2, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} } }));
    act(() => { store.dispatch(uiActions.goHome()); });
    act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'cast_pending' } }); });
    await waitFor(() => expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['fresh']));
  });
  it('plan 286 — a failed reopen read is dropped silently (no toast); the poll repairs it', async () => {
    …open + full load…
    getBookStateMock.mockRejectedValueOnce(new Error('boom'));
    …goHome, reopen…
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
    expect(store.getState().notifications.toasts).toEqual([]);
  });
  ```
  `bookStateWith(overrides)` and `renderAt(store, path)`: extract helpers from the existing first test's literal (`state`, `cast`, …) and its `render(<Provider><MemoryRouter …><Routes><Route … element={<Layout />} /></Routes></MemoryRouter></Provider>)` block, then reuse them. If `goHome` doesn't exist under that name, use the action the existing #3395 tests use to leave the book.

  **Delete in this task** (they pin #3395 machinery this task removes): every test in `describe('Layout — revisions persist only after the book is hydrated (#3395 pass 3, R1/R1b/R2)')` (`~:621-1276`) and `describe('Layout — revisions.bookId scope tracking through real navigation (#3395 pass 2, N1)')` (`~:534-620`), **except** keep (and adapt to `hydrate`) the two that pin user-visible outcomes still owed: "book B never inherits book A's pending revisions after openBook(B)" (now via the selector: assert `selectActivePending(store.getState())` for B is `[]`), and "the failed-read notice is dismissed when the user moves on to another book" (full-load path only). Name each deleted test in the commit body with one line saying what replaces it (the cache tests in Task 7, the thunk tests in Task 9, or "machinery deleted, behaviour moved server-side").

  Run → FAIL on the new tests.

- [ ] **Step 2: Implement** per Interfaces. The new effect core, replacing the `revisionsReady` / `revisionsOnly` / `hasWindowWrites` block and the two hydrate dispatch sites:
  ```ts
  /* Plan 286 — revisions are server-owned: every (re)open re-reads them
     (one GET), so a take recorded while the user was away (#3397) — or a
     delete + re-import in another tab — is picked up. The other slices keep
     their short-circuit. */
  const revisionsOnly = manuscriptReady;
  ```
  and at both former `hydrateFromBookState` sites:
  ```ts
  dispatch(revisionsActions.hydrate({ bookId, state: res?.revisions ?? null }));
  ```
  In the rejection handler: `if (revisionsOnly) { console.warn('[book-state] revisions re-read failed; the next poll repairs it:', err?.message); return; }` before the toast/retry, and change the toast copy to the full-load sentence only.

- [ ] **Step 3: Green.** `layout.test.tsx` (whole file — it is one file), `src/routes/confirm-rehydrate.test.tsx`, `typecheck`.

- [ ] **Step 4: Mutations.**
  1. Restore `if (manuscriptReady && revisionsReady) return;` using a `hydratedFor` check → red: `reopening a book always re-hydrates revisions…`.
  2. Re-add the toast on the revisions-only failure → red: `a failed reopen read is dropped silently`.

- [ ] **Step 5: Commit.** `fix(frontend): rehydrate revisions from the server on every book open (#3397)`.

---

### Task 12: Layout — polls (active + bulk/D9), `applyPoll` adopts server state, dismiss

**Character:** judgment.

**Files:**
- Modify: `src/store/revisions-slice.ts` (`applyPoll`), `src/components/layout.tsx` (active poll `~:1113-1125`, bulk poll `~:1148-1165`, the drift-report `onDismiss` `~:2199`).
- Test: `src/store/revisions-slice.test.ts` (`describe('revisionsSlice — applyPoll')` and `applyPoll preserves dismissed`), `src/components/layout.test.tsx` (`describe('Layout — active book poll never overwrites client-owned pending (#3376 round 2)')`, `~:2658`; the background-poll describe `~:2549`), `src/store/revisions-thunks.test.ts` (re-run).

**Interfaces:**
- `applyPoll(payload: RevisionsResponse & { bookId: string })`: merges drift for `bookId` as today, then the ordered adopt (Task 7's `shouldAdoptOrdered`/`adopt`), then `loaded = true`. `bookId` becomes **required** in the payload type.
- Active poll: `api.pollRevisions({ bookId }).then((res) => { if (!cancelled && activeBookIdNow() === bookId) dispatch(applyPoll({ ...res, bookId })); }).catch((err) => console.warn('[revisions] active poll failed:', (err as Error).message))`. `activeBookIdNow` = `(store.getState().ui.stage as { bookId?: string }).bookId` (layout already holds `store` — it reads `store.getState()` elsewhere; use the same handle).
- Bulk poll (D9 + incidental findings, see "Incidental findings"): chunk `bgBookIds` into groups of ≤50 (the server 400s above 50); each chunk's call has its own `.catch` (one warn per chunk failure, deduped by a module-level `Set` of logged messages so a 120 s tick doesn't spam); for each `res.errors` entry, `console.warn` once per bookId per session (same `Set`). The per-book `applyBackgroundPoll` dispatch is unchanged.
- Dismiss: `onDismiss={(eventId) => void dispatch(dismissDriftOp(eventId))}`.

- [ ] **Step 1: Failing tests.**
  (a) `revisions-slice.test.ts`: replace the three `applyPoll` cases that assert "never touches pending" and the `applyPoll preserves dismissed` case with:
  ```ts
  it('plan 286 — applyPoll adopts the server pending/dismissed/timeline by the ordered rule and merges drift', () => {
    let s = revisionsSlice.reducer(undefined, revisionsActions.applyServerState({ bookId: 'A', fileId: '000000000000001-a', rev: 2, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} }));
    s = revisionsSlice.reducer(s, revisionsActions.applyPoll({ bookId: 'A', fileId: '000000000000001-a', rev: 3, pending: [{ id: 'p', chapterId: 1, characterId: 'c', segments: [] }], dismissed: ['d'], drift: [{ id: 'x', bookId: 'A' } as never] }));
    expect(s.pending.map((p) => p.id)).toEqual(['p']); expect(s.dismissed).toEqual(['d']); expect(s.drift.map((d) => d.id)).toEqual(['x']); expect(s.loaded).toBe(true);
  });
  it('plan 286 — a stale poll (lower rev) updates drift but not pending', () => {
    let s = revisionsSlice.reducer(undefined, revisionsActions.applyServerState({ bookId: 'A', fileId: '000000000000001-a', rev: 5, pending: [{ id: 'keep', chapterId: 1, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} }));
    s = revisionsSlice.reducer(s, revisionsActions.applyPoll({ bookId: 'A', fileId: '000000000000001-a', rev: 4, pending: [], drift: [{ id: 'new', bookId: 'A' } as never] }));
    expect(s.pending.map((p) => p.id)).toEqual(['keep']); expect(s.drift.map((d) => d.id)).toEqual(['new']);
  });
  ```
  Fix the multi-book drift `applyPoll` tests that omit `bookId` (they now must pass one). In `revisions-thunks.test.ts`, add the deferred assertion to `revision_not_found without a state refetches`: `expect(store.getState().revisions.rev).toBe(4);`.
  (b) `layout.test.tsx`: replace the `(#3376 round 2)` describe's test with "a stale poll (lower rev) does not clobber pending", driving `pollRevisionsMock` with a lower `rev`. Add:
  ```ts
  it('plan 286 (D9) — a failing bulk poll is caught: no unhandled rejection, other books still update', async () => {
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
    pollRevisionsBulkMock.mockRejectedValueOnce(new Error('500'));
    …render with two background books…
    await waitFor(() => expect(pollRevisionsBulkMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
  it('plan 286 (D9) — a partial byBookId with errors still applies the healthy books', async () => {
    pollRevisionsBulkMock.mockResolvedValueOnce({ byBookId: { good: { pending: [], drift: [{ id: 'g', bookId: 'good' }] } }, errors: { bad: "Couldn't read this book's review state." } });
    …render…
    await waitFor(() => expect(store.getState().revisions.drift.map((d) => d.id)).toContain('g'));
  });
  it('plan 286 — more than 50 background books are polled in chunks of at most 50', async () => {
    …seed library with 120 analysed books (status 'complete'), active book none or another…
    await waitFor(() => expect(pollRevisionsBulkMock).toHaveBeenCalledTimes(3));
    for (const [arg] of pollRevisionsBulkMock.mock.calls) expect(arg.bookIds.length).toBeLessThanOrEqual(50);
  });
  it('plan 286 — a failing active poll is caught', async () => { pollRevisionsMock.mockRejectedValueOnce(new Error('500')); …assert no unhandled rejection… });
  ```
  Reuse the existing background-poll describe's library seeding (`~:2549`) for book lists.
  Run → FAIL.

- [ ] **Step 2: Implement.** `applyPoll`:
  ```ts
  /* Plan 286 — the server owns pending. The poll carries the whole
     RevisionsState plus live drift; drift always merges (per book), and the
     rest is adopted by the ordered rule, so a slow poll cannot revert a newer
     op response. Callers dispatch only for the active book. */
  applyPoll: (s, a: PayloadAction<RevisionsResponse & { bookId: string }>) => {
    mergeDriftForBook(s, a.payload.bookId, a.payload.drift);
    if (shouldAdoptOrdered(s, a.payload)) adopt(s, a.payload);
    s.loaded = true;
  },
  ```
  Delete the old `applyPoll` doc comment (it describes client-owned pending). Layout per Interfaces; a helper above the component:
  ```ts
  const BULK_POLL_MAX = 50; // server cap: `Up to 50 bookIds per request` (routes/revisions.ts)
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

- [ ] **Step 3: Green.** `revisions-slice.test.ts`, `revisions-slice.cache.test.ts`, `revisions-thunks.test.ts`, `layout.test.tsx`, `src/modals/drift-report.test.tsx`, `typecheck`; e2e `drift-report-multibook.spec.ts`.

- [ ] **Step 4: Mutations.**
  1. Remove the bulk `.catch` → red: `a failing bulk poll is caught`.
  2. Set `BULK_POLL_MAX = 200` → red: `polled in chunks of at most 50`.
  3. In `applyPoll`, call `adopt` unconditionally → red: `a stale poll (lower rev) updates drift but not pending`.

- [ ] **Step 5: Commit.** `fix(frontend): adopt server pending from polls and isolate background poll failures (D9) (#3400)`.

---

### Task 13: Splice runner — refetch instead of writing; `inFlightChapters`

**Character:** judgment.

**Files:**
- Modify: `src/store/splice-slice.ts`, `src/store/splice-runner-middleware.ts`.
- Test: `src/store/splice-runner-middleware.test.ts`, `e2e/character-splice.spec.ts`.

**Interfaces:**
- Produces (`splice-slice`): `inFlightChapters: Array<{ bookId: string; chapterId: number }>` (initial `[]`); actions `chapterStarted({ bookId, chapterId })` (adds if absent) and `chapterSettled({ bookId, chapterId })` (removes); selector `selectChapterRendering(state, bookId, chapterId): boolean`.
- Runner: per chapter dispatch `chapterStarted` before `api.streamSplice` and `chapterSettled` after it returns (success, failure or abort — use `try/finally`). Remove both `revisionsActions` dispatches and the import. On `splice_complete`: `void dispatch(refetchActiveRevisions(req.bookId))` — the thunk itself skips a book that isn't active (Task 9), so the runner adds no guard of its own; if `ev.reviewRecorded === false`, warn toast "The new take is live, but its A/B review couldn't be saved" (dedupe `splice-review-unsaved-<bookId>`). `markChapterAudioUpdated` stays as is.
- Rewrite the header comment (the "enqueues a pending A/B revision… flips it playable" sentences are now false).

- [ ] **Step 1: Failing tests** (`splice-runner-middleware.test.ts`; reuse its store builder and `api.streamSplice` mock):
  ```ts
  it('plan 286 — never writes pending; refetches the active book on splice_complete', async () => {
    …store active on book A; streamSplice mock emits splice_complete for chapter 2…
    store.dispatch(spliceActions.startBatch({ id: 'b1', bookId: 'A', characterId: 'eliza', characterName: 'Eliza', mode: 'remix', gainDb: 3, chapterIds: [2] }));
    await flush();
    expect(pollRevisionsMock).toHaveBeenCalledWith({ bookId: 'A' });
    expect(dispatched.some((t) => t.startsWith('revisions/enqueuePending') || t.startsWith('revisions/markRevisionPlayable'))).toBe(false);
  });
  it('plan 286 — a splice that finishes while the user is on another book does not refetch into the wrong book', async () => {
    …same, but dispatch ui openBook('B') before splice_complete…
    expect(pollRevisionsMock).not.toHaveBeenCalled();
  });
  it('plan 286 — inFlightChapters tracks the running chapter per book and clears on completion or failure', async () => {
    …streamSplice mock that awaits a gate…
    expect(store.getState().splice.inFlightChapters).toEqual([{ bookId: 'A', chapterId: 2 }]);
    release(); await flush();
    expect(store.getState().splice.inFlightChapters).toEqual([]);
  });
  it('plan 286 — reviewRecorded:false toasts once', async () => { …emit splice_complete with reviewRecorded:false… expect toast text }
  ```
  `dispatched` = a recording middleware the test adds; if the file has none, add one (`const types: string[] = []; const rec = () => (next) => (a) => { types.push(a.type); return next(a); }`). Mock `api.pollRevisions` in the file's `vi.mock('../lib/api')` factory.

  **e2e** `character-splice.spec.ts`: replace the one-shot `pending.length` read with a poll:
  ```ts
  await expect
    .poll(() => page.evaluate(() => (window as unknown as StoreWin).__store__?.getState().revisions.pending.length ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(0);
  ```
  It passes because the mock splice records into the mock store (Task 6b) and the runner refetches.

  Run the unit tests → FAIL.

- [ ] **Step 2: Implement** per Interfaces.

- [ ] **Step 3: Green.** The unit file, `typecheck`, `npm --prefix <wt> run test:e2e -- e2e/character-splice.spec.ts`.

- [ ] **Step 4: Mutations.**
  1. Re-add `revisionsActions.markRevisionPlayable({ chapterId })` on `splice_complete` (the old write) → red: `never writes pending; refetches the active book…`.
  2. Remove the `finally` around `chapterSettled` and make the splice mock reject → red: `inFlightChapters … clears on completion or failure`.
  3. Replace the refetch with `api.pollRevisions({ bookId: req.bookId }).then((res) => dispatch(revisionsActions.applyPoll({ ...res, bookId: req.bookId })))` (no active-book check) → red: `…on another book does not refetch into the wrong book`.

- [ ] **Step 5: Commit.** `fix(frontend): splice runner refetches server pending instead of writing it (#3397)`.

---

### Task 14: Layout — the A/B player opens a specific entry; accept/reject via thunks; watcher

**Character:** judgment.

**Files:**
- Create: `src/store/revision-player-middleware.ts`; wire it in `src/store/index.ts` (after `persistenceMiddleware`).
- Modify: `src/components/layout.tsx` (the `pending` selector `~:195`, `onOpenRevisions` `~:1731`, the player block `~:2474-2568`), `src/components/revision-timeline-modal.tsx` (`useAppSelector((s) => s.revisions.timeline)` → `selectActiveTimeline`), `src/store/ui-slice.ts` (delete `showRevisionPlayer` + `setShowRevisionPlayer`).
- Modify: `src/store/generation-stream-middleware.ts` — transitional only (Task 16 rewrites this block): its `markRevisionPlayable` handler still `enqueuePending`s the stub into the cache (the old reducer exists until Task 18); replace its `setShowRevisionPlayer(true)` with `setOpenRevision({ kind: 'server', revisionId: stub.id, chapterId: stub.chapterId })` so the player finds the stub in `pending` and `profile-regen-preview.spec.ts` stays green until Task 16.
- Create: `src/store/revisions-thunks.ts` additions — `approvePreviewSideEffects(preview: PreviewRegenCtx)` (moved from layout's inline block).
- Test: create `src/store/revision-player-middleware.test.ts`; `layout.test.tsx`; `src/components/revision-timeline-modal.test.tsx`.

**Interfaces:**
- Layout:
  - `const pending = useAppSelector(selectActivePending);`
  - `onOpenRevisions: () => { const first = pending[0]; if (first) dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: first.id, chapterId: first.chapterId })); }` (OD15).
  - Player shown revision: `open?.kind === 'server' ? pending.find((p) => p.id === open.revisionId) : open?.kind === 'preview-stub' ? ui.previewRegen?.stub : undefined`. Mode `'preview'` iff `ui.previewRegen && ui.previewRegen.bookId === bookId && ui.previewRegen.previewChapterId === shown.chapterId`; else `'review'`.
  - Props: `busy={ui.revisionOpInFlight}`, `rendering={selectChapterRendering(state, bookId, shown.chapterId)}`, `previousMissing={previousMissingFor === shown.id}` (local `useState<string | null>`), `onKeepNew` (server kind only) → `acceptRevisionOp({ bookId, revisionId })`.
  - `onClose` → `setOpenRevision(null)`.
  - Server-kind `onAccept(selection)`: capture `const preview = ui.previewRegen;` then `const out = await dispatch(acceptRevisionOp({ bookId, revisionId: shown.id, selection }));` then `if (out.ok && preview && preview.previewChapterId === shown.chapterId && preview.bookId === bookId) dispatch(approvePreviewSideEffects(preview));`.
  - Server-kind `onReject()`: `const out = await dispatch(rejectRevisionOp({ bookId, revisionId: shown.id }));` `if (out.ok && ui.previewRegen?.previewChapterId === shown.chapterId) dispatch(uiActions.setPreviewRegen(null));` `if (!out.ok && out.code === 'no_previous_audio') setPreviousMissingFor(shown.id);`.
  - Stub-kind handlers come in Task 15 (before Task 16 ever sets the stub kind).
- `approvePreviewSideEffects(preview)` (thunk): `setPreviewRegen(null)`; append the `buildCharacterRegenEvent` change-log entry for `[preview.previewChapterId, ...preview.remainingChapterIds]` (character from `cast.characters`); if `remainingChapterIds.length > 0`, `enqueueQueueEntries(...)` with ids `regen-rest-${preview.bookId}-…` and `bookId: preview.bookId`, then `changeView('generate')` **only if** the active book is `preview.bookId`. This is today's inline block (`layout.tsx ~:2505-2534`) moved, with `bookId` → `preview.bookId`.
- `revisionPlayerMiddleware`: after every action, if `ui.openRevision?.kind === 'server'` and `!ui.revisionOpInFlight` and the entry is not in `selectActivePending`, dispatch `setOpenRevision(null)`; if additionally `ui.previewRegen` is set for the active book with `previewChapterId === openRevision.chapterId` (OD10), dispatch `setPreviewRegen(null)` and an info toast "This preview was resolved elsewhere" (dedupe `preview-resolved-elsewhere`). Guard against re-entrancy (it dispatches from inside the middleware: check the condition again after `next(action)`; the dispatched actions themselves make the condition false).

- [ ] **Step 1: Failing tests.**
  (a) `revision-player-middleware.test.ts` (store: ui, revisions, notifications + the middleware):
  ```ts
  it('a server entry vanishing (another tab) closes the player and clears a preview tied to it, with one toast', () => {
    …active book A; cache rev 1 with r1 on chapter 3; openRevision server r1/3; previewRegen {bookId:'A', previewChapterId:3,…}
    store.dispatch(revisionsActions.applyPoll({ bookId: 'A', fileId: F1, rev: 2, pending: [], drift: [] }));
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen).toBeNull();
    expect(toastMessages()).toEqual(['This preview was resolved elsewhere']);
  });
  it('does not fire during the user\'s own op (revisionOpInFlight)', () => {
    …same, but dispatch setRevisionOpInFlight(true) before the poll…
    expect(store.getState().ui.previewRegen).not.toBeNull();
    expect(toastMessages()).toEqual([]);
  });
  it('a vanishing entry unrelated to the preview closes the player but keeps the preview', () => {
    …openRevision r2 on chapter 5, preview on chapter 3…
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen).not.toBeNull();
  });
  it('ignores the preview-stub kind', () => { …openRevision {kind:'preview-stub'} with empty cache → stays open… });
  ```
  (b) `layout.test.tsx` player tests (replace the existing ones that drive `showRevisionPlayer`):
  ```ts
  it('plan 286 (D6) — the player opens the requested entry, not pending[0]', …) // two entries; setOpenRevision on the second; assert the player's chapter title is the second's
  it('plan 286 — Commit selection calls the accept route once and closes on success; preview fan-out only after success', …)
  // acceptRevisionMock resolves with a state lacking the entry; assert enqueueQueueEntries (queue mock) called with bookId = previewRegen.bookId, AFTER acceptRevisionMock resolved
  it('plan 286 — a refused accept (revision_gone) runs no fan-out and shows one toast', …)
  it('plan 286 — double-click on Commit selection sends one request (busy)', …)
  it('plan 286 — a legacy entry (no origin) opens as a server entry and is accepted through the route', …)
  it('plan 286 — reject answering no_previous_audio switches the footer to Keep new take', …)
  ```
  Add `acceptRevision`, `rejectRevision`, `dismissDrift`, `restorePreviousUnrecorded` mocks to the file's `vi.mock('../lib/api')` factory. The user's own Approve must not fire the "resolved elsewhere" toast — add that assertion to the Commit-selection test (spec test list).
  (c) `revision-timeline-modal.test.tsx`: the modal shows nothing for a cached book that isn't active.
  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces. Remove the inline accept/reject bodies (including the `api.acceptChapterRevision` / `api.rejectChapterRevision` calls). Keep the `onOpenHistory` wiring.

- [ ] **Step 3: Green.** The new test, `layout.test.tsx`, `revision-timeline-modal.test.tsx`, `generation-stream-middleware.test.ts`, `typecheck`; e2e `revision-diff.spec.ts`, `profile-regen-preview.spec.ts`.

- [ ] **Step 4: Mutations.**
  1. In the middleware, drop the `!ui.revisionOpInFlight` check → red: `does not fire during the user's own op`.
  2. In layout's `onAccept`, run `approvePreviewSideEffects` before awaiting the thunk → red: `…preview fan-out only after success` / `a refused accept … runs no fan-out`.
  3. Open `pending[0]` regardless of `openRevision.revisionId` → red: `the player opens the requested entry, not pending[0]`.
  4. Drop the chapter match in the middleware's preview clear → red: `a vanishing entry unrelated to the preview … keeps the preview`.

- [ ] **Step 5: Commit.** `fix(frontend): open the requested A/B entry and confirm accept/reject with the server (D1, D6) (#3400)`.

---

### Task 15: Preview stub — Approve / Reject; preview enqueue carries `review`

**Character:** judgment.

**Files:**
- Modify: `src/store/revisions-thunks.ts` (add `restoreUnrecordedPreview`), `src/components/layout.tsx` (stub handlers; the preview `enqueueQueueEntries([{ id: \`regen-preview-…\`, … }])` call `~:2073-2082` gains `review`).
- Modify: `e2e/profile-regen-preview.spec.ts` (remove the workaround).
- Tests: `revisions-thunks.test.ts`, `layout.test.tsx`.

**Interfaces:**
- Preview enqueue entry gains `review: { characterId, triggeredBy: \`${regenCharacter?.name ?? characterId} voice change\` }` (OD14).
- Stub Approve (`onAccept` and Keep new take when `kind === 'preview-stub'`): `dispatch(approvePreviewSideEffects(preview)); dispatch(setOpenRevision(null));` — **no** revisions call.
- Stub Reject: `restoreUnrecordedPreview(preview)`:
  - `!preview.stub?.hasPreviousAudio` → `setPreviewRegen(null)`, `setOpenRevision(null)`.
  - else `api.restorePreviousUnrecorded({ bookId: preview.bookId, chapterId: preview.previewChapterId })`:
    | Outcome | Action |
    |---|---|
    | `'restored'` / `'none'` | `setPreviewRegen(null)`, `setOpenRevision(null)` |
    | `has_revision` | warn toast (has revision copy); keep open |
    | `chapter_busy` | warn toast busy; keep open |
    | other failure | error toast `Couldn't restore the original — try Reject again`; keep open |
  - Sets `revisionOpInFlight` for its duration.

- [ ] **Step 1: Failing tests.**
  - Thunk: one test per row of the table, plus "hasPreviousAudio false → no request".
  - Layout: `the preview enqueue carries review`; `stub Approve fans out and makes no revisions call` (assert `acceptRevisionMock` and `restorePreviousUnrecordedMock` not called, queue enqueue called); `stub Reject calls restore-unrecorded`. Nothing sets the stub kind until Task 16, so these layout tests set it directly: `store.dispatch(uiActions.setPreviewRegen({ bookId, characterId, previewChapterId: 1, remainingChapterIds: [2], reason: '', note: '', stub: { id: 'revision:1:eliza_cc', chapterId: 1, characterId: 'eliza_cc', segments: [], playable: true, hasPreviousAudio: true } }))` then `setOpenRevision({ kind: 'preview-stub' })`.
  - e2e: in `openPreviewPlayer`, delete the `s?.dispatch({ type: 'revisions/rejectAllPending' })` line and its comment (the phantom revision no longer exists — D7); keep the drawer dismissal.
  Run → FAIL.

- [ ] **Step 2: Implement.** Thunk in `revisions-thunks.ts`:
  ```ts
  /** Plan 286 — Reject on a preview stub (no recorded entry). Never touches
      revisions.json; restores `.previous` only when the metadata check said it
      exists (spec §4 stub table). */
  export function restoreUnrecordedPreview(preview: PreviewRegenCtx) {
    return async (dispatch: AppDispatch): Promise<void> => {
      const close = () => {
        dispatch(uiActions.setPreviewRegen(null));
        dispatch(uiActions.setOpenRevision(null));
      };
      if (!preview.stub?.hasPreviousAudio) return close();
      dispatch(uiActions.setRevisionOpInFlight(true));
      try {
        await api.restorePreviousUnrecorded({ bookId: preview.bookId, chapterId: preview.previewChapterId });
        close();
      } catch (err) {
        const code = err instanceof RevisionOpFailure ? err.code : 'network';
        const [kind, message] =
          code === 'has_revision'
            ? (['warn', "This chapter has an older pending review — resolve it from the chapter's review first"] as const)
            : code === 'chapter_busy'
              ? (['warn', COPY.busy] as const)
              : (['error', COPY.restoreFailed] as const);
        dispatch(notificationsActions.pushToast({ kind, message, dedupeKey: `preview-restore-${code}` }));
      } finally {
        dispatch(uiActions.setRevisionOpInFlight(false));
      }
    };
  }
  ```
  (Import `type PreviewRegenCtx` from `./ui-slice`.) Layout: branch the player handlers on `ui.openRevision?.kind === 'preview-stub'` — Approve / Keep new take → `dispatch(approvePreviewSideEffects(preview)); dispatch(uiActions.setOpenRevision(null));`; Reject → `void dispatch(restoreUnrecordedPreview(preview))`. For the stub, pass `onKeepNew` only in review mode (it is always preview mode, so in practice not at all).
- [ ] **Step 3: Green.** Thunk + layout tests, `typecheck`, e2e `profile-regen-preview.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Make stub Approve call `acceptRevisionOp` → red: `stub Approve … makes no revisions call`.
  2. Close the player on `has_revision` → red: the `has_revision` row test.
  3. Drop `review` from the preview enqueue → red: `the preview enqueue carries review`.
- [ ] **Step 5: Commit.** `fix(frontend): resolve an unrecorded preview stub without touching revisions.json (#3400)`.

---

### Task 16: Generation preview — `previewChapterComplete`, refetch-or-stub

**Character:** judgment.

**Files:**
- Modify: `src/store/generation-stream-runner.ts` (the `chapter_complete` branch of `handleTickFor`, `~:401-419`; `StreamRunnerStore.getState` type `~:85-88`).
- Modify: `src/store/generation-stream-middleware.ts` (replace the `revisions/markRevisionPlayable` block `~:157-186`).
- Rename: `src/lib/build-pending-revision.ts` → `src/lib/build-preview-stub.ts` (`buildPendingRevisionStub` → `buildPreviewStub`); correct its stale docstring (`hasPreviousAudio` now comes from the metadata check, not optimism).
- Tests: `generation-stream-runner.test.ts`, `generation-stream-middleware.test.ts`, `build-pending-revision.test.ts` (rename with the module if it exists).

**Interfaces:**
- Runner: on `chapter_complete` with `ev.reviewChapter === true`, `dispatch(previewChapterComplete({ bookId, chapterId: ev.chapterId, reviewRecorded: ev.reviewRecorded }))` — for **any** book. Remove the `markRevisionPlayable` dispatch and the `revisions` member of `StreamRunnerStore`'s state type (spec table). OD12: no refetch on plain `chapter_complete`.
- `buildPreviewStub({ chapter, character, hasPreviousAudio, triggeredBy? }): Revision` — `playable: true`, `id: revision:<ch>:<char>`, `hasPreviousAudio` as given, no `origin`.
- Middleware, on `previewChapterComplete.match(action)` (`{ bookId, chapterId, reviewRecorded }`):
  1. If the active book is not `bookId`: info toast "Preview ready in ‹title›" (title from `library` slice if the middleware's state type can reach it; else from `ui.previewRegen` — add `bookTitle?: string` to nothing; use `state.library` — extend `StreamableRootState` with `library: { books: Array<{ bookId: string; title: string }> }`), dedupe `preview-ready-<bookId>`. Stop.
  2. Else `void openPreview(...)`:
     ```ts
     async function openPreview(dispatch: AppDispatch, getState: () => StreamableRootState, p: { bookId: string; chapterId: number; reviewRecorded?: boolean }) {
       if (p.reviewRecorded !== false) {
         let r = await dispatch(refetchActiveRevisions(p.bookId));
         if (r === 'failed') { await sleep(PREVIEW_REFETCH_RETRY_MS); r = await dispatch(refetchActiveRevisions(p.bookId)); }
         if (r === 'skipped') return;
         if (r === 'ok') {
           const entry = selectActivePending(getState()).find((e) => e.chapterId === p.chapterId);
           if (entry) { dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: entry.id, chapterId: entry.chapterId })); return; }
         }
       }
       const prev = await api.getChapterAudioPrevious({ bookId: p.bookId, chapterId: p.chapterId }).catch(() => null);
       const s = getState();
       const preview = s.ui.previewRegen;
       if (!preview || preview.bookId !== p.bookId || preview.previewChapterId !== p.chapterId) return;
       const chapter = s.chapters.chapters.find((c) => c.id === p.chapterId);
       const character = s.cast.characters.find((c) => c.id === preview.characterId);
       if (!chapter || !character) return;
       dispatch(uiActions.setPreviewRegen({ ...preview, stub: buildPreviewStub({ chapter, character, hasPreviousAudio: prev !== null }) }));
       dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
     }
     ```
     `PREVIEW_REFETCH_RETRY_MS = 1000` (OD24). `getChapterAudioPrevious` requires `duration` in `AudioArgs` — pass `chapter.duration` (read `chapter` before the call). `selectActivePending` needs `ui` + `revisions` in `StreamableRootState` — extend the type.
- Remove `revisionsActions` + `buildPendingRevisionStub` imports from the middleware.

- [ ] **Step 1: Failing tests.**
  (a) runner:
  ```ts
  it('plan 286 — dispatches previewChapterComplete only for reviewChapter, for any book', …) // two ticks: one with reviewChapter:true on book B (not viewed), one without
  it('plan 286 — never dispatches revisions/markRevisionPlayable', …)
  ```
  (b) middleware (`vi.useFakeTimers()` for the retry):
  ```ts
  it('active book + recorded entry → refetch, then open that server entry', …)
  it('reviewRecorded:false → no refetch; asks for previous metadata; opens the stub with hasPreviousAudio from it', …)
  it('refetch succeeded with no entry for the chapter → stub', …)
  it('a failed refetch does not open a stub straight away; the retry succeeding opens the entry', …)
  it('a doubly-failed refetch still opens the stub', …)
  it('a previous-metadata GET that throws → stub with hasPreviousAudio:false', …)
  it('a non-active book → "Preview ready in ‹title›" toast and nothing opens', …)
  it('the stub never enters the revisions cache, and survives a poll', …) // after open, applyPoll with empty pending → ui.previewRegen.stub still set, openRevision still preview-stub
  ```
  Use the file's `makeStore`/`ch` harness; add `notifications: notificationsSlice.reducer` and `library: librarySlice.reducer` to its reducer map, and `pollRevisions` / `getChapterAudioPrevious` mocks to its `vi.mock('../lib/api')` factory. Two of these written out, as the pattern for the rest:
  ```ts
  const PREVIEW = { bookId: 'b1', characterId: 'marlow', previewChapterId: 3, remainingChapterIds: [4], reason: 'voice', note: '' };
  function seedPreview(store: ReturnType<typeof makeStore>['store']) {
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
    store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'marlow', name: 'Marlow' } as never]));
    store.dispatch(uiSlice.actions.setPreviewRegen(PREVIEW));
  }
  it('active book + recorded entry → refetch, then open that server entry', async () => {
    const { store } = makeStore();
    seedPreview(store);
    pollRevisionsMock.mockResolvedValueOnce({ bookId: 'b1', fileId: '000000000000001-a', rev: 1, pending: [{ id: 'revision:3:1700', chapterId: 3, characterId: 'marlow', segments: [], origin: 'server' }], drift: [] });
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: true }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
    expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
  });
  it('a doubly-failed refetch still opens the stub', async () => {
    vi.useFakeTimers();
    const { store } = makeStore();
    seedPreview(store);
    pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('y'));
    getChapterAudioPreviousMock.mockResolvedValueOnce(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewRecorded: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ui.openRevision).toBeNull(); // the first failure opens nothing
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(store.getState().ui.previewRegen?.stub).toMatchObject({ chapterId: 3, hasPreviousAudio: false });
    expect(store.getState().revisions.pending).toEqual([]);
    vi.useRealTimers();
  });
  ```
  Run → FAIL.

- [ ] **Step 2: Implement** per Interfaces. Update the middleware's header comment item 3.
- [ ] **Step 3: Green.** Runner + middleware tests, `typecheck`, e2e `profile-regen-preview.spec.ts` (`cc` has no live chapter 1 in the mock store, so the preview takes the stub path; Approve/Reject go through Task 15's stub handlers, already in place). Also delete Task 14's transitional `enqueuePending(stub)` + `setOpenRevision({kind:'server', …})` block — this task replaces it.
- [ ] **Step 4: Mutations.**
  1. Remove the retry (open the stub on the first failure) → red: `a failed refetch does not open a stub straight away…`.
  2. Set `hasPreviousAudio: true` unconditionally → red: `reviewRecorded:false … with hasPreviousAudio from it`.
  3. Gate the runner dispatch on `sliceMatchesHandle` → red: `…for any book`.
- [ ] **Step 5: Commit.** `fix(frontend): open a recorded preview entry, or a stub when none was recorded (#3397)`.

---

### Task 17: Persistence — no revisions PUT, ever

**Character:** mechanical.

**Files:**
- Modify: `src/store/persistence-middleware.ts` (delete the nine `revisions/*` rules `~:212-251` and their doc comments, `revisionsPatch` `~:304-322`, and the `rule.slice === 'revisions'` gate `~:466-491` with its comment).
- Modify: `src/lib/types.ts` (`StateSlice` drops `'revisions'`), `src/lib/api.ts` (`applyMockSliceWrite` drops the `'revisions'` case).
- Test: create `src/store/persistence-middleware.revisions-never-put.test.ts`; trim `persistence-middleware.test.ts` (delete its revisions-rule tests; list them in the commit body).

**Interfaces:** none new.

- [ ] **Step 1: Failing test** — the new file:
  ```ts
  /* Plan 286 — the client never PUTs revisions.json (spec §4, invariant 1).
     Drives every remaining revisions action through a store that has the real
     persistence middleware, then flushes, and checks every putBookState call. */
  import { describe, it, expect, vi } from 'vitest';
  import { configureStore } from '@reduxjs/toolkit';
  import { expectTypeOf } from 'vitest';
  import type { StateSlice } from '../lib/types';

  const putBookState = vi.fn(async () => {});
  vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { putBookState } }));

  const { persistenceMiddleware, flushBookPersistence } = await import('./persistence-middleware');
  const { revisionsSlice, revisionsActions } = await import('./revisions-slice');
  const { uiSlice, uiActions } = await import('./ui-slice');

  const STATE = { bookId: 'A', fileId: '000000000000001-a', rev: 1, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} };
  /* One payload per action creator. A new revisions action without an entry
     here is a compile error — so it cannot dodge this test. */
  const PAYLOADS: { [K in keyof typeof revisionsActions]: Parameters<(typeof revisionsActions)[K]>[0] } = {
    hydrate: { bookId: 'A', state: STATE },
    applyServerState: STATE,
    applyPoll: { ...STATE, drift: [] },
    applyBackgroundPoll: { bookId: 'B', drift: [] },
    applyDismiss: { driftId: 'd', state: STATE },
    forgetBook: 'A',
  } as never;

  describe('no revisions PUT', () => {
    it('StateSlice cannot name revisions', () => {
      expectTypeOf<'revisions'>().not.toMatchTypeOf<StateSlice>();
    });
    it('no revisions action ever reaches putBookState', async () => {
      const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer }, middleware: (g) => g().concat(persistenceMiddleware) });
      store.dispatch(uiActions.openBook({ id: 'A', status: 'complete' } as never));
      for (const [name, payload] of Object.entries(PAYLOADS)) {
        store.dispatch((revisionsActions as Record<string, (p: unknown) => { type: string }>)[name](payload));
      }
      await store.dispatch(flushBookPersistence('A') as never);
      for (const call of putBookState.mock.calls) expect((call[1] as { slice: string }).slice).not.toBe('revisions');
    });
  });
  ```
  The `PAYLOADS` map above lists the actions that exist **after Task 18**; while the old reducers still exist it does not compile. So the file is split across two tasks: **this task** creates it with the `StateSlice cannot name revisions` case plus the runtime case below, over the action list that exists today; **Task 18** replaces that runtime case with the exhaustive `PAYLOADS` version above.
  ```ts
  it('none of today\'s revisions actions schedules a PUT', async () => {
    …dispatch acceptAllPending, rejectAllPending, dismissDrift('d'), acceptRevision({revisionId:'r', selection:{}}), rejectRevision('r'), rolledBack({chapterId:1,timelineEntryId:'t',rolledBackId:'x'}), enqueuePending({id:'p',chapterId:1,characterId:'c',segments:[]}), markRevisionPlayable({chapterId:1}), persistPendingAfterHydrateMerge()…
    …flush, assert no slice 'revisions'…
  });
  ```
  Task 18 then replaces this runtime test's action list with the exhaustive `PAYLOADS` map. Run → FAIL (the rules still PUT).

- [ ] **Step 2: Implement** the deletions. Remove the `revisions` field from `PersistableRootState` if only the deleted code used it.
- [ ] **Step 3: Green.** The new file, `persistence-middleware.test.ts`, `layout.test.tsx`, `api.mock-state.test.ts`, `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Re-add `'revisions/dismissDrift': { slice: 'revisions' as never, build: () => ({}) }` to `PERSIST_RULES` → red: `none of today's revisions actions schedules a PUT`.
  2. Re-add `'revisions'` to `StateSlice` → typecheck red: `StateSlice cannot name revisions`.
- [ ] **Step 5: Commit.** `fix(frontend): stop persisting revisions.json from the client (#3400)`.

---

### Task 18: Delete #3395's guard machinery and the dead revisions API

**Character:** mechanical (large but deletion-only).

**Files:**
- Modify: `src/store/revisions-slice.ts` — delete `hydratedFor`, `windowActions`, `RecordedRevisionsAction`, `DispatchedAt`, `recordIfUnhydrated`, `replayRecorded` (+ its assignment), `acceptAllPending`, `rejectAllPending`, `acceptRevision`, `rejectRevision`, `rolledBack`, `bookScopeChanged`, `bookWiped`, `dismissDrift`, `enqueuePending`, `markRevisionPlayable`, `hydrateFromBookState`, `persistPendingAfterHydrateMerge`, `appendTimelineEntryHelper`, `nowIso`; the transitional `s.hydratedFor = …` line in `hydrate`; rewrite the `RevisionsState` doc comments for `bookId` (now "the book the cache holds") and the file header.
- Delete: `src/store/revisions-scope-middleware.ts`, `src/store/revisions-scope-middleware.test.ts`; remove its import and `.concat` entry from `src/store/index.ts` and from `layout.test.tsx`'s store.
- Modify: `src/routes/index.tsx` — `onDeleteBook`: `bookWiped` → `revisionsActions.forgetBook(b.bookId)`; `onReplaceManuscript`/`onReparseBook`: delete the `bookWiped` dispatch and its comment sentence (the server resets the file; the next hydrate adopts by `fileId`).
- Modify: `src/lib/api.ts` — delete `acceptChapterRevision`/`rejectChapterRevision` (real + mock) and `mockAcceptChapterRevision`/`mockRejectChapterRevision`.
- Modify: `src/lib/types.ts` comments that cite `revisionsActions.acceptRevision` (`~:443`).
- Modify: `e2e/marketing/scenes.ts` `generating-revision-diff` scene: replace the `rejectAllPending` + `markRevisionPlayable` dispatches with `window.__mockRevisions.seed('hollow-tide-2', { liveChapterIds: [chapterId] })` **before** Preview is clicked is not possible (the stream is dead under `DEMO_CAPTURE`), so instead: after the `applyGenerationTick` dispatch, dispatch `{ type: 'chapters/previewChapterComplete', payload: { bookId: 'hollow-tide-2', chapterId, reviewRecorded: false } }` — the stub path opens the player. Rewrite the scene's long comment accordingly (the old one cites removed actions).
- Tests: `revisions-slice.test.ts` (delete the tests of deleted reducers — list in commit body), `routes/index.test.tsx` (`bookWiped` → `forgetBook` on delete; nothing on replace/reparse), `persistence-middleware.revisions-never-put.test.ts` (replace the old-action list with the exhaustive `PAYLOADS` map from Task 17's sketch), `generation-stream-middleware.test.ts` (remove `markRevisionPlayable` cases if Task 16 left any).

- [ ] **Step 1: Failing test** — `routes/index.test.tsx`:
  ```ts
  it('plan 286 — deleting the open book forgets its revisions cache', async () => {
    …cache holds book X; trigger onDeleteBook(X)…
    expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0 });
  });
  it('plan 286 — delete then re-import under the same id shows a clean cache', async () => {
    …delete X; hydrate({ bookId: X, state: { fileId: null, rev: 0, pending: [] } })…
    expect(store.getState().revisions.pending).toEqual([]);
  });
  ```
  Run → FAIL (`forgetBook` not dispatched).
- [ ] **Step 2: Implement** the deletions.
- [ ] **Step 3: Green.** Run every test file that `git grep -l "revisions"` lists under `src/` (frontend only, one command), `typecheck`, `npm --prefix <wt> run lint -- src/store src/routes src/components src/lib e2e/marketing` (unused imports), e2e `revision-diff.spec.ts profile-regen-preview.spec.ts character-splice.spec.ts drift-report-multibook.spec.ts`.
- [ ] **Step 4: Mutations.**
  1. Remove the `forgetBook` dispatch from `onDeleteBook` → red: `deleting the open book forgets its revisions cache`.
  2. Add a new reducer `noop: (s) => s` to the slice without a `PAYLOADS` entry → typecheck red in `persistence-middleware.revisions-never-put.test.ts`.
- [ ] **Step 5: Commit.** `refactor(frontend): delete the client revisions guard machinery superseded by server ownership (#3400)`.

---

### Task 19: Server — finalize callers pass `review` / `null`

**Character:** judgment (three routes; generation suite is slow-pool).

**Files:**
- Modify: `server/src/routes/chapter-splice.ts` (`finalizeChapterAudioWrite({` call `~:526`), `server/src/routes/chapter-qa-repair.ts` (`~:766`), `server/src/routes/generation.ts` (`~:1891`).
- Tests: `chapter-splice.test.ts` (`plan 285 — passes no \`review\` to finalize (PR 1 dark)…` `~:281`), `chapter-qa-repair.test.ts` (`~:440`), `generation.test.ts` (`passes no \`review\` to finalize…` `~:2369`, `reviewChapter:true only on the chapter rendered with review — … finalize still gets no review` `~:2414`).

**Interfaces:**
- Splice: `review: { characterId, triggeredBy: spliceTriggeredBy(mode, reviewName) }` where `reviewName` = the cast character's `name` resolved through the resolver the route already builds (search `buildCastResolver(` in the file; `resolver.resolve(characterId)?.character.name`), falling back to `characterId` (OD13). Export `spliceTriggeredBy(mode: 'remix' | 'rerecord', name: string): string` = `` `${mode === 'remix' ? 'Loudness fix' : 'Re-record'} (${name.split(' ')[0] || name})` `` (the text moved from `splice-runner-middleware.ts`).
- QA repair: `review: null`.
- Generation: `review: job.review !== null && job.chapterId === chapter.id ? job.review : null`. Update the `RunningJob.review` comment ("Not yet passed to finalize (PR 2)" → "passed to finalize for the job's own chapter").

- [ ] **Step 1: Failing tests** — flip the three dark-state spy tests:
  ```ts
  // chapter-splice.test.ts
  it('plan 286 — passes the splice review to finalize and threads reviewRecorded onto splice_complete', async () => {
    …existing setup with finalize spy…
    expect(finalizeSpy.mock.calls[0][0].review).toEqual({ characterId: 'eliza', triggeredBy: 'Loudness fix (Eliza)' });
  });
  it('spliceTriggeredBy uses the first name', () => {
    expect(spliceTriggeredBy('remix', 'Eliza Carrick')).toBe('Loudness fix (Eliza)');
    expect(spliceTriggeredBy('rerecord', 'narrator')).toBe('Re-record (narrator)');
  });
  // chapter-qa-repair.test.ts
  expect(finalizeSpy.mock.calls[0][0].review).toBeNull();
  // generation.test.ts (slow pool)
  it('passes the job review to finalize for its own chapter and null for every other chapter', …)
  ```
  Use the test's actual character id/name. Run:
  `npm --prefix <wt>/server run test -- src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts --retry=0`
  `npm --prefix <wt>/server run test:slow -- src/routes/generation.test.ts -t "review" --reporter=verbose --retry=0`
  → FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Green** (same commands without `--retry=0`), server `typecheck`.
- [ ] **Step 4: Mutations.**
  1. Generation: pass `job.review` for every chapter → red: `…null for every other chapter`.
  2. QA repair: pass `undefined` → red: the flipped QA-repair test.
- [ ] **Step 5: Commit.** `feat(server): record A/B review state on splice, QA repair and generation renders (#3397)`.

---

### Task 20: Server — restructure drops stale pending entries

**Character:** judgment.

**Files:**
- Modify: `server/src/workspace/restructure.ts` (add `touchedChapterIds`), `server/src/workspace/revisions-store.ts` (add `dropPendingForChapters`), `server/src/routes/chapters-restructure.ts` (`applyRestructure`, after `rewriteChapterSlugs`).
- Modify: `CLAUDE.md` (swallow list FIVE → SIX), `server/src/workspace/cast-lock.ts` comment if it mirrors that list.
- Tests: `server/src/workspace/restructure.test.ts`, `server/src/workspace/revisions-store.test.ts`, `server/src/routes/chapters-restructure.test.ts`.

**Interfaces:**
- `touchedChapterIds(oldChapters: BookStateJson['chapters'], newChapters: BookStateJson['chapters'], audioOps: AudioOp[]): number[]` (sorted, unique): every old chapter whose slug is an op's `from`; every rename's `newChapterId`; every old chapter whose id now maps to a different slug or to no chapter.
- `dropPendingForChapters(bookDir, chapters, chapterIds: readonly number[]): Promise<RevisionsFile>` — one write under the revisions lock, only if something was dropped.
- `applyRestructure`: after the audio ops,
  ```ts
  /* Plan 286 — entries for chapters this op touched no longer pair with the
     live take. Best-effort: logged, never in a response (the six handlers
     return raw messages, so a lock-key path must not reach them). A deliberate
     swallow of LockAcquisitionTimeoutError (CLAUDE.md swallow list). */
  try {
    const touched = touchedChapterIds(state.chapters, result.state.chapters, result.audioOps);
    if (touched.length > 0) await dropPendingForChapters(bookDir, state.chapters, touched);
  } catch (e) {
    console.error('[chapters-restructure] could not drop stale A/B review entries', e);
  }
  ```
  `state.chapters` is the pre-transform list (read `applyRestructure` to confirm `state` is not mutated by the transform; if it is, capture `const oldChapters = state.chapters.map((c) => ({ ...c }))` before `transform(...)`).

- [ ] **Step 1: Failing tests.**
  ```ts
  // restructure.test.ts
  it('touchedChapterIds covers content change (same id), id change, and slug-only rename', () => {
    const old = [ch(1, '01-a'), ch(2, '02-b'), ch(3, '03-c'), ch(4, '04-d')];
    const neu = [ch(1, '01-a'), ch(2, '02-b'), ch(3, '03-c-renamed'), ch(4, '04-merged')];
    const ops = [{ kind: 'delete', from: '02-b' }, { kind: 'rename', from: '03-c', to: '03-c-renamed', newChapterId: 3, newChapterTitle: 'C' }] as AudioOp[];
    expect(touchedChapterIds(old, neu, ops)).toEqual([2, 3, 4]);
  });
  // revisions-store.test.ts
  it('dropPendingForChapters drops several chapters in one write and is a no-op when none match', …)
  // chapters-restructure.test.ts
  it('plan 286 — a merge drops pending entries for the touched chapters only', …) // seed revisions.json with server entries for ch 1 and ch 3; merge [1,2]; expect ch 3 kept
  it('plan 286 — a failing drop still answers 200 and leaks no path', …) // vi.spyOn(revisionsStore, 'dropPendingForChapters').mockRejectedValueOnce(new LockAcquisitionTimeoutError('revisions:/SECRET-WORKSPACE/x', 10))
  ```
  Run → FAIL.
- [ ] **Step 2: Implement** per Interfaces. Update CLAUDE.md: "FIVE handlers swallow it deliberately" → "SIX …" and add "; and the restructure pending drop (`server/src/routes/chapters-restructure.ts`, plan 286), whose stale A/B entries the next accept/reject also answers `revision_not_found` for". Mirror in `cast-lock.ts`'s comment block if it enumerates the swallow sites.
- [ ] **Step 3: Green.** The three test files, server `typecheck`, `npm --prefix <wt>/server run test -- src/workspace/cast-lock.guard.test.ts`.
- [ ] **Step 4: Mutations.**
  1. Drop the rename `newChapterId` clause → red: `touchedChapterIds covers…` (4 missing? adjust fixture so 4 is reachable only through the clause; verify it goes red).
  2. Remove the `try/catch` → red: `a failing drop still answers 200…`.
- [ ] **Step 5: Commit.** `feat(server): drop stale A/B entries for chapters a restructure touched (#3400)`.

---

### Task 21: Server — close the raw PUT (400) and the legacy audio routes (410)

**Character:** mechanical.

**Files:**
- Modify: `server/src/routes/book-state.ts` (`case 'revisions':` in the PUT switch `~:790`), `server/src/routes/chapter-audio.ts` (the `DELETE …/audio/previous` and `POST …/audio/previous/restore` handlers → 410), `server/src/audio/previous-audio.ts` (header comment names the old routes as callers), `openapi.yaml` (both legacy ops → 410 + `deprecated: true`; `PUT /state` documents the 400; `PutStateRequest.slice` description).
- Modify: `CLAUDE.md` (remove the two legacy routes from the `LOCK_CONTENTION_REQUEST_ERROR` sentence and from "Accept/reject (and the legacy `…/audio/previous` routes) additionally serialise…" — replace with "Accept/reject and `restore-unrecorded` additionally serialise…"); `server/src/workspace/cast-lock.ts` comment likewise.
- Tests: `chapter-audio.test.ts` (replace the `DELETE /audio/previous (accept)` and `POST /audio/previous/restore (reject)` describes, including PR 1's legacy race and timeout tests, with 410 tests; list each removed test in the commit body), `book-state.hydrate.test.ts`.

**Interfaces:**
- `PUT /state` `slice:'revisions'` → `400 { error: 'revisions_server_owned', message: 'revisions.json is written by the server; use the revision operations.' }`, file untouched.
- `DELETE …/audio/previous`, `POST …/audio/previous/restore` → `410 { error: 'moved', message: 'This operation moved to /api/books/{bookId}/revisions/{revisionId}/accept|reject.' }` (never 404 — the old client's accept treats 404 as success). No file touched.

- [ ] **Step 1: Failing tests.**
  ```ts
  // book-state.hydrate.test.ts
  it('plan 286 — PUT slice=revisions is refused with 400 and writes nothing', async () => {
    const res = await request(app).put(`/api/books/${bookId}/state`).send({ slice: 'revisions', patch: { pending: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('revisions_server_owned');
    expect(existsSync(join(bookDir, '.audiobook', 'revisions.json'))).toBe(false);
  });
  // chapter-audio.test.ts
  it.each([['delete', '/audio/previous'], ['post', '/audio/previous/restore']])('plan 286 — %s %s answers 410 moved and touches no audio', async (method, path) => {
    resetAudio(); writeMp3(); writePreviousMp3();
    const res = await (request(app) as never as Record<string, (u: string) => request.Test>)[method](`/api/books/${bookId}/chapters/1${path}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('moved');
    expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);
    expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
  });
  ```
  Run → FAIL.
- [ ] **Step 2: Implement.** Remove now-unused imports from `chapter-audio.ts` (`acceptPreviousAudio` if only the DELETE used it; `isGenerationActive`, `withKeyLock`, `revisionOpLockKey`, `isLockAcquisitionTimeout`, `LOCK_CONTENTION_REQUEST_ERROR` stay for `restore-unrecorded`). `acceptPreviousAudio` is still used by `revision-ops.ts` — keep the export. In `book-state.ts` remove `revisionsJsonPath` from the import if the PUT case was its last user.
- [ ] **Step 3: Green.** `chapter-audio.test.ts`, `book-state.hydrate.test.ts`, `npm --prefix <wt>/server run test:slow -- src/routes/book-state.test.ts -t "revisions"`, `typecheck`, `npm --prefix <wt> run openapi:types` + `src/lib/api-types.revisions-contract.test.ts`, `npm --prefix <wt> run check:cycles`.
- [ ] **Step 4: Mutations.**
  1. Answer 404 instead of 410 on the DELETE → red: the `it.each` delete row.
  2. Make the PUT case write before answering 400 → red: `…writes nothing`.
- [ ] **Step 5: Commit.** `fix(server,openapi): refuse client revisions PUTs and retire the legacy A/B audio routes (#3400)`.

---

### Task 22: e2e — accept / reject / dismiss through the UI, and the #3397 book switch

**Character:** judgment (Playwright timing).

**Files:**
- Create: `e2e/revision-ops.spec.ts`, `e2e/revisions-book-switch.spec.ts`.

**Interfaces:** consumes `window.__store__`, `window.__mockRevisions`, `window.__mockSpliceDelayMs`.

- [ ] **Step 1: Write the specs** (serial mode, like `revision-diff.spec.ts`).
  `e2e/revision-ops.spec.ts`:
  ```ts
  import { test, expect, type Page } from '@playwright/test';
  test.describe.configure({ mode: 'serial' });

  type Win = {
    __mockRevisions?: { seed: (b: string, s: unknown) => void; get: (b: string) => { pending: Array<{ id: string }>; timeline: Record<string, Array<{ eventKind: string }>>; dismissed: string[] } };
    __store__?: { getState: () => { revisions: { pending: unknown[]; drift: Array<{ id: string; bookId: string }> } } };
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

  test('Dismissing a drift event posts to its book and it stays dismissed after the next poll', async ({ page }) => {
    // Follow drift-report-multibook.spec.ts to open the Drift Report on sb and click a row's Dismiss.
    …open drift report, click the first Dismiss, capture its event id via the store…
    await expect.poll(() => page.evaluate((id) => (window as unknown as Win).__mockRevisions!.get('sb').dismissed.includes(id), eventId)).toBe(true);
  });
  ```
  For the dismiss test, copy the navigation and selectors from `e2e/drift-report-multibook.spec.ts` (it already drives the Drift Report and its Dismiss buttons under mocks); the drift events come from `VOICE_DRIFT_EVENTS` for `sb`.

  `e2e/revisions-book-switch.spec.ts` (#3397):
  ```ts
  test('a Fix-audio take that finishes while on another book is a playable prompt on return', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { (window as unknown as { __mockSpliceDelayMs?: number }).__mockSpliceDelayMs = 2500; });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
    await page.goto('/#/books/cc/cast');
    await expect(page.getByTestId('cast-row-eliza_cc')).toBeVisible({ timeout: 10_000 });
    await markChaptersRendered(page); // copy from character-splice.spec.ts
    await page.getByTestId('cast-row-eliza_cc').click();
    await page.getByRole('button', { name: /Fix Eliza.*audio \(loudness \/ re-record\)/i }).click();
    await page.evaluate(() => (window as unknown as { __store__?: { dispatch: (a: unknown) => void } }).__store__?.dispatch({ type: 'ui/setOpenProfileId', payload: null }));
    await page.getByRole('button', { name: /Apply to \d+ chapters?/i }).click();
    // Leave for another book before the splice completes.
    await page.goto('/#/books/sb/listen');
    await expect(page.getByText(/Solway Bay/i).first()).toBeVisible({ timeout: 10_000 });
    // Wait until the mock store has recorded the take (the splice finished while away).
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRevisions: { get: (b: string) => { pending: unknown[] } } }).__mockRevisions.get('cc').pending.length), { timeout: 20_000 }).toBeGreaterThan(0);
    // Back to book A.
    await page.goto('/#/books/cc/listen');
    await page.getByTestId('status-pill').click();
    const open = page.getByTestId('status-popover-revisions').getByRole('button', { name: /\d+ revisions?/i });
    await expect(open).toBeVisible({ timeout: 10_000 });
    await open.click();
    const player = page.getByTestId('revision-diff-player');
    await expect(player).toBeVisible();
    await expect(player.getByText(/Rendering new take/i)).toHaveCount(0);
  });
  ```
  If `cc` has no listen route under mocks, return to `#/books/cc/cast` instead — any book stage that renders the Status pill.

- [ ] **Step 2: Run** `npm --prefix <wt> run test:e2e -- e2e/revision-ops.spec.ts e2e/revisions-book-switch.spec.ts`. Expected PASS. Run the book-switch spec 3× in a row to check flakiness (`--repeat-each=3`).
- [ ] **Step 3: Mutation.** Temporarily revert Task 11's "always re-hydrate on reopen" (restore the `hydratedFor` short-circuit by skipping the revisions-only fetch when `manuscriptReady`) → `revisions-books-switch` goes red (no revisions button, or the button is absent within 10 s; the 30 s poll is outside the timeout). Restore.
- [ ] **Step 4: Commit.** `test(e2e): cover server-owned accept/reject/dismiss and the book-switch take (#3397)`.

---

### Task 23: Bookkeeping — release notes, on-box register, plan status

**Character:** mechanical (docs) — but the register publish has its own procedure.

**Files:**
- `docs/release-notes-next.md` — one technical entry (PR-refed) covering: client cutover (no client revisions writes; per-op routes; cache ordered by `fileId`/`rev`), #3397 fix, D1/D6/D7/D9, `restore-unrecorded`, bulk `errors`, `GET /state` normalised (and `revisions: null` on an unreadable file), `PUT slice:'revisions'` → 400, legacy routes → 410, restructure drop, finalize callers live; the incidental fixes (bulk chunking, active-poll catch).
- `RELEASE_NOTES.md` — one brand-voice line in the in-progress version: takes that finish while you're on another book now wait for you as normal A/B prompts; accept/reject only record once the audio change actually happened.
- `docs/testing/onbox-acceptance-register.md` — **update row A9** in place (OD17): replace the "known gap (#3397…)" sentences with the spec's four on-box checks (splice → switch books → prompt appears; accept → `.previous` gone; re-splice → reject → original returns; reject during generation → 409 with pending unchanged), plus "a legacy pending entry from before the update can be accepted and rejected". Add a dated update block citing this PR. Run `npm run register:build` and `npm run check:onbox-register`.
- `docs/testing/onbox-acceptance-register-live-view.html` — mirror the A9 change; publish to the URL in the register's header following its "Live view" four-step procedure (including `check:onbox-register -- --against-published <file>` immediately before publishing).
- `docs/features/285-revisions-server-ops.md` — fill "Ship notes" (PR 1 merged `ce142a3c`; PR 2 merged `<sha>`); keep `status: active` (on-box owed) — OD18.
- `docs/features/286-revisions-client-cutover.md` — `status: active`, fill Ship notes.
- `docs/features/INDEX.md` — flip 286's status word.

- [ ] Steps: write each; run `npm --prefix <wt> run check:onbox-register` and `register:build`; commit `docs(docs): release notes and on-box acceptance for the revisions cutover (#3400)`. Publishing the live view happens from the branch **after** rebasing on the latest `main` (memory note: a stale branch nearly clobbered a newer live page).

---

### Task 24: Verify, review gate, PR

**Character:** coordinator (`claude` lane).

- [ ] `npm --prefix <wt> run typecheck`
- [ ] `npm --prefix <wt> run verify:fast:branch` (manual, per CLAUDE.md step 7)
- [ ] `npm --prefix <wt> run test:e2e -- e2e/revision-ops.spec.ts e2e/revisions-book-switch.spec.ts e2e/revision-diff.spec.ts e2e/profile-regen-preview.spec.ts e2e/character-splice.spec.ts e2e/drift-report-multibook.spec.ts`
- [ ] `npm --prefix <wt>/server run test:slow -- src/routes/generation.test.ts src/routes/book-state.test.ts`
- [ ] `npm --prefix <wt> run check:cycles`
- [ ] `git -C <wt> grep -n "markRevisionPlayable\|enqueuePending\|hydrateFromBookState.*revisions\|hydratedFor\|bookWiped\|acceptChapterRevision\|rejectChapterRevision\|revisionsPatch\|showRevisionPlayer"` → no hits outside historical docs.
- [ ] Push; open the PR (title `fix(frontend,server): revisions.json client cutover to server ownership (#3400)`; body: Summary, Test plan, `Closes #3400`, `Closes #3397`, "Also fixed, found in passing" list from the Incidental findings below, the on-box row update).
- [ ] Run the `pr-review-gate` skill (multi-scope → depth `high`).

---

## Incidental findings (folded in, per CLAUDE.md "Incidental findings")

| Finding | Where | Disposition |
|---|---|---|
| The background bulk poll sends every analysed book in one request; the server rejects more than 50 with 400, so on a library of 51+ analysed books background drift never updates. | `layout.tsx` bulk effect vs `routes/revisions.ts` `bookIds.length > 50` | Fixed in Task 12 (chunking). |
| The active-book poll (`api.pollRevisions(...).then(...)`, `layout.tsx ~:1116`) also has no `.catch` — the same unhandled-rejection class as D9. | `layout.tsx` | Fixed in Task 12. |
| `rolledBack` (and its persistence rule) is never dispatched anywhere in `src/` — dead code. | `revisions-slice.ts`, `persistence-middleware.ts` | Deleted in Tasks 17–18 (spec already lists it). |
| Two plans share the number 285 (`285-analysis-failure-phase-markers.md`, `285-revisions-server-ops.md`). | `docs/features/` | **Reported, not renumbered** (instruction). Needs a decision on which one moves; not fixed here. |

## Open decisions

Each lists the options, the default this plan uses, and why.

1. **OD1 — Source of the reopen re-hydrate.** (a) `getBookState` (today's call, now normalised); (b) `api.pollRevisions` (returns `RevisionsState` + drift, lighter on the client, heavier on the server — it computes drift). **Default (a):** keeps today's code path and one source for both open and reopen; drift arrives on the immediate first poll anyway.
2. **OD2 — `GET /state` with an unreadable `revisions.json`.** (a) degrade to `revisions: null` and log; (b) 500, as main does for an unparseable file. **Default (a):** a broken review-history file should not lock the user out of the whole book; the polls still answer 500 so the problem stays visible. Spec is silent.
3. **OD3 — The hydrate retry loop.** Spec: "the revisions retry loop goes". The loop also retries the *full* book load ("Couldn't load this book. Retrying…"), which is not revisions machinery. (a) Keep it for the full-load path only; (b) delete it entirely. **Default (a).**
4. **OD4 — `restore-unrecorded` serialisation.** Spec gives it no per-chapter key. It runs the same `restorePreviousAudio` whose race PR 1 pass 1 fixed for accept/reject. (a) Take `revision-op` (default); (b) none. **Default (a):** same race class, cheap, and it keeps the lock-order rule uniform.
5. **OD5 — Bulk per-book error text.** (a) a fixed path-free sentence (default); (b) the error's own message via `requestFailureMessage` (fs errors embed absolute paths). **Default (a).**
6. **OD6 — Mock store placement.** Spec says `MOCK_BOOK_STATES` "gains `previousChapterIds`". (a) A separate `src/mocks/mock-revisions.ts` table overlaid onto `getBookState` (default, mirrors `mock-queue.ts`, testable without `api.ts`); (b) fields inside `MOCK_BOOK_STATES`. Behaviour is the same.
7. **OD7 — Mock "had audio".** Spec's mock rules need to know whether a chapter already had audio. (a) A `liveChapterIds` set (seeded `sb` = all chapters; grown by every mock render); a splice always counts as having audio (default); (b) read `completedSlugs`. (a) works for books with no seeded slugs (`cc`).
8. **OD8 — `__mockRevisions` surface.** Spec: `seed(bookId, {state, previousChapterIds})`, `get`. Plan adds `liveChapterIds` to `seed` and a `reset`. Splice delay via `window.__mockSpliceDelayMs` (mirrors `__mockGenConcurrency`).
9. **OD9 — Mock reject never answers `chapter_busy`.** The mock has no generation-active notion. Busy is covered by the thunk and real-api unit tests. Alternative: read the mock queue for an in-progress entry on the book.
10. **OD10 — Watcher scope.** Spec: if the shown server entry disappears "and `previewRegen` is set", clear the preview. Literal reading clears an *unrelated* preview. Default: `OpenRevision` carries `chapterId`; clear the preview only if it is for the active book and that chapter.
11. **OD11 — "Keep new take".** Spec adds the button but not when it shows. Default: review mode only, replacing "Commit selection" when A is unavailable (`hasPreviousAudio:false` or after a `no_previous_audio` reject), with Reject disabled. Preview mode keeps Approve/Reject unchanged (Approve already means keep-new).
12. **OD12 — Plain `chapter_complete` with a cached entry for that chapter.** The server drops the entry; the client learns on the next 30 s poll, or from a `revision_not_found` if the user acts first. (a) No extra refetch (default; keeps the runner's store type narrow); (b) refetch when the cache holds an entry for that chapter.
13. **OD13 — Splice `triggeredBy` server-side.** Default: `Loudness fix (<first name>)` / `Re-record (<first name>)`, name resolved through the cast resolver (handles superseded ids), falling back to the character id.
14. **OD14 — Preview `review.triggeredBy`.** Default `<name> voice change` (today's stub text). Alternative: include the user's `reason`.
15. **OD15 — Status popover target.** It opens `pending[0]` (it only knows a count). Default unchanged.
16. **OD16 — A vanished entry with no preview.** Default: close the player silently.
17. **OD17 — On-box acceptance.** Spec: "a register row owed by PR 2". Row A9 already covers Fix-audio A/B and carries the #3397 gap text. Default: update A9 in place (new steps, gap text removed). Alternative: mint a new row and cross-reference.
18. **OD18 — Plan status after merge.** Default: 285 and 286 both `active` with Ship notes, not archived, until A9 is accepted on the box.
19. **OD19 — Dismiss failure.** Spec silent. Default: keep the event and toast; the user can retry.
20. **OD20 — Legacy entries (PR #3504 pass 2).** PR 2 shows them. They accept/reject correctly since `7d39752e`. Residuals accepted by default: legacy ids (`revision:<ch>:<char>`, `splice-<book>-<ch>-<char>`) are not per-recording, so a stale tab could accept a *different* legacy take with the same id; a legacy entry whose `.previous` is gone vanishes at cutover (including every `playable:false` "stuck" entry from #3397). Alternative: a one-shot migration that stamps or clears legacy entries — not recommended (it is a write on read, which the store forbids).
21. **OD21 — `previewChapterComplete` as a bare `createAction`** exported from `chapters-slice.ts` (no reducer), rather than a no-op reducer. Same wire type `chapters/previewChapterComplete`.
22. **OD22 — `forgetBook` leaves that book's drift.** Spec literal. A deleted book's drift lingers until reload (pre-existing). Alternative: also drop its drift.
23. **OD23 — Preview refetch retry delay.** Default one retry after 1000 ms.
24. **OD24 — Bulk-poll per-book errors in the UI.** Spec: "log or toast once (deduped)". Default: log once per book per session; no toast (a background book is not actionable from here).

## Spec points that PR 1's merged code (or the code on `main`) contradicts

- §3 cites `mockQueueRequest` at `queue-thunks.ts:36`; it is in `src/mocks/mock-queue.ts`, and PR 1 Task 11 already carried `review` through it.
- §4 cites `src/modals/revision-timeline-modal.tsx`; the file is `src/components/revision-timeline-modal.tsx`.
- §4 deletes `rolledBack` as if live; it is never dispatched (dead since before PR 1).
- §4 "the revisions retry loop goes" — the loop is shared with the full-book load (OD3).
- §4 `restore-unrecorded` predates PR 1's per-chapter serialisation and omits it (OD4).
- §4 doesn't say what `GET /state` does on an unreadable file (OD2).
- D9 says the only newly reachable bulk-poll trigger is a non-object file; on `main` the bulk poll is also dead for any library with more than 50 analysed books (400), and the active poll has the same missing `.catch`.
- The CLAUDE.md lock paragraphs PR 2 makes false are not listed in the spec's Delivery: the `requestFailureMessage` count (20 → 22), the swallow list (FIVE → SIX), and the legacy routes' `LOCK_CONTENTION_REQUEST_ERROR` branches (replaced by `restore-unrecorded`'s). Tasks 1, 2, 20 and 21 carry them.
- "Expected size: PR 2 about 7 plus verify" — at the 30–45-minute task size PR 1's lanes needed, it is 25 dispatches (Tasks 1–24 plus 6b).

## Verify commands (whole PR)

See Task 24. Cloud `verify.yml` is the required gate.

## Reversibility / observable changes

Revert the PR. Everything PR 2 changes that a user, an old client or an operator can observe:

1. **The client never writes revisions.json.** An old tab's revisions `PUT` now gets `400 revisions_server_owned`, logged to its console only (no toast handler for that slice). Disk is unchanged.
2. **The legacy `DELETE …/audio/previous` and `POST …/audio/previous/restore` answer `410 moved`.** An old tab's Accept/Reject toasts an error; nothing on disk changes. (They answered 204/404/409/500 before.)
3. **Every render records or drops A/B state on the server:** a splice records an entry; a plain generation or QA repair drops the chapter's entry; a preview render records one when the chapter already had audio. Revision History now records only outcomes the server confirmed.
4. **Restructure drops pending entries** for every chapter it touched.
5. **`GET /state`'s `revisions` is normalised**: no `drift`, no `schema`; legacy stale entries filtered; `null` when the file is unreadable (the book still opens).
6. **`GET /api/revisions` gains `errors`** and no longer fails as a whole for one bad book.
7. **New route** `POST …/audio/previous/restore-unrecorded`.
8. **Legacy pending entries become visible and actionable**, and legacy `playable:false` entries disappear (PR 1's normalisation, first exposed here).
9. **Mock mode:** the seeded `sb` revision is the only pending revision in the mock workspace (no phantom on every book); mock previous audio exists only where a mock render preserved it.

A revert restores the client writer while leaving PR 1's store in place; entries the server recorded during PR 2's lifetime (`origin:'server'`) are read by the old client's hydrate as ordinary pending entries.
