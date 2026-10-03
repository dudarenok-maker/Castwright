---
status: active
shipped: null
owner: null
---

# 285 — revisions.json becomes server-owned: per-operation writes (PR 1, server, dark) (#3400, #3397)

> Status: active. This is PR 1 of 2 (server, dark). PR 2, the client cutover, gets its own plan revision after PR 1 merges.
>
> Key files:
> - `server/src/workspace/revisions-store.ts` (new): the only reader and writer of revisions.json.
> - `server/src/audio/previous-audio.ts` (new): today's A/B audio steps, moved unchanged.
> - `server/src/routes/revision-ops.ts` (new): the accept, reject and dismiss routes.
> - `server/src/routes/review-request.ts` (new): the shared `review` validator.
> - Server files modified: `server/src/routes/revisions.ts`, `server/src/routes/qa-report.ts`, `server/src/routes/chapter-audio.ts`, `server/src/routes/book-state.ts`, `server/src/routes/generation.ts`, `server/src/routes/queue.ts`, `server/src/workspace/queue-io.ts`, `server/src/audio/finalize-chapter-write.ts`, `server/src/routes/chapter-splice.ts`, `server/src/routes/chapter-qa-repair.ts`, `server/src/app.ts`.
> - Contract and client files modified: `openapi.yaml`, `src/lib/api-types.ts` (generated), `src/lib/api.ts`, `src/lib/types.ts`, `src/store/queue-thunks.ts`, `src/store/generation-stream-runner.ts`, `src/store/queue-dispatcher-middleware.ts`.
>
> URL surface: none. PR 1 makes no UI change.
>
> OpenAPI operations:
> - New: `POST /api/books/{bookId}/revisions/{revisionId}/accept`, `POST /api/books/{bookId}/revisions/{revisionId}/reject`, `POST /api/books/{bookId}/drift/{driftId}/dismiss`.
> - Reshaped: `GET /api/books/{bookId}/revisions`, `GET /api/revisions`.

## Benefit / Rationale

- **User:** PR 1 is dark for the revisions flow itself.
  - **The `RELEASE_NOTES.md` line** Task 12 adds covers only a forward-looking safeguard. Reparse and replace refuse a review-history file written by a newer Castwright, before touching the book. No user can reach this until a later version writes `schema: 2`.
  - **One corner-case side effect** is documented in the technical notes and in Reversibility 3, not in the user line. The bulk poll only ever asks for non-active books that are past analysis (`layout.tsx:1137-1146` filters out `not_analysed`, `analysing`, `cast_pending`, `voices_pending`, `unreadable` and `orphaned`), so a book with no confirmed cast never enters it. Its `.then` has no `catch` (`layout.tsx` ~1153-1158), so one failing book is a silent unhandled rejection that stalls every *other* book's background drift badges. Main already does this for an unparseable file in a cast book, and the newer-schema case cannot be reached until a later version writes `schema: 2`. That leaves one newly reachable trigger in PR 1: a cast book whose revisions.json is valid JSON with a non-object top level (`null`, `[]`, a string or a number).

  PR 2 builds on it to fix #3397, where a Fix-audio prompt gets stuck or lost when the user leaves the book. It also fixes #3400, where stale client state erases revisions.json.
- **Technical:** revisions.json gets a single owner with a per-book lock. It also gets a `fileId`/`rev` version stamp, the existing `schema-migrate.ts` seam, and read-time normalisation. Accept and reject each become one server request, and the JSON is written only after the audio step succeeds (D1). `pending` is returned even when the cast is empty (D8).
- **Architectural:** adds a leaf lock class, `revisions:<abs bookDir>`, which sits outside the `design → library-voice → cast` order. The A/B audio steps move into `audio/previous-audio.ts` with no import of `routes/generation.ts`. Finalize gains a tri-state `review` seam that PR 2 switches on.

## Architectural impact

- **New seams:**
  - `revisions-store.ts`;
  - `previous-audio.ts`;
  - `FinalizeChapterAudioInput.review` and `FinalizeChapterAudioResult.reviewRecorded`;
  - `review` on the queue entry and on the generation request;
  - `reviewChapter` and `reviewRecorded` on the SSE completion events.
- **Invariants preserved:**
  - cast-lock rules 1–4. The revisions lock is a leaf: nothing else is acquired while it is held, and nothing but revisions.json is written under it.
  - OpenAPI remains the type source.
  - Every field added to an existing schema is optional.
- **Migration:**
  - The store stamps `schema: 1` through `schema-migrate.ts`'s `stampSeamSchema` and reads through `migrateSeamDoc`.
  - **The store** refuses to read or write a newer-schema file and never overwrites one. A corrupt file throws, as it does on main.
  - Legacy files are normalised on read, and a read never rewrites them.
  - The first store write mints `fileId` and sets `rev: 1`.
  - Reparse and replace **reset** the file instead of deleting it.
  - In PR 1, the client's whole-file `PUT /state` with `slice:'revisions'` still writes raw, by design (Invariant 7). The store's no-overwrite guarantee does not cover that path.
- **Reversibility:** revert the PR. The complete list of PR-1 behaviour an old client can observe:
  1. **Reparse and replace reset revisions.json instead of deleting it.** The old client hydrates an empty file the same way as a missing one.
  2. **Reparse and replace refuse a newer-schema revisions.json before anything is deleted.** They return a 500 carrying `UnsupportedSchemaError`'s own path-free "upgrade the server" message, and the book is left untouched. On main they deleted the file.
  3. **The single-book poll, the bulk poll and qa-report now answer 500 for a corrupt or newer-schema revisions.json.** Exactly what changed against main:
     - **Unparseable file, book with a cast:** unchanged. Main's `readJson` already throws in `computeRevisionsForBook`, so main already returns 500 on all three.
     - **Unparseable file, book with no cast:** new. Main returned early (`revisions.ts:132-135`) without reading the file and answered 200.
     - **Newer-schema file, cast or not:** new. Main parsed it like any JSON and answered 200. PR 1 refuses it through `migrateSeamDoc`.
     - **Valid JSON whose top level is not a plain object** (`null`, `[]`, a string or a number), **cast or not:** new, and accepted. Main parsed it and answered 200, because its `Array.isArray` guards read every field as empty. PR 1 treats it as corrupt and answers 500, so a later store write can never overwrite it as if it were missing.
     - **Numeric `schema` below 1** (e.g. `0`), **cast or not:** new. Main answered 200. `migrateSeamDoc` has no migration registered for it and throws a plain `Error` ("No migration registered for revisions.json schema=0 → 1"), so the polls and qa-report answer 500.
     - **Error text:** a parse failure or a non-object top level surfaces the raw `SyntaxError` message. That is `requestFailureMessage`'s verbatim fallback, which curates only a lock-acquisition timeout. A newer schema surfaces `UnsupportedSchemaError`'s own message. Neither contains a path.
     - **Blast radius:** the bulk `GET /api/revisions` maps every requested book through one `Promise.all`. A single such book therefore fails the **whole** bulk response with a 500, and every other book's drift goes with it. Main already has that blast radius for an unparseable file in a cast book. PR 1 extends it to the new cases above. **Visible effect:** The bulk poll only ever asks for non-active books that are past analysis (`layout.tsx:1137-1146` filters out `not_analysed`, `analysing`, `cast_pending`, `voices_pending`, `unreadable` and `orphaned`), so a book with no confirmed cast never enters it. Its `.then` has no `catch` (`layout.tsx` ~1153-1158), so one failing book is a silent unhandled rejection that stalls every *other* book's background drift badges. Main already does this for an unparseable file in a cast book, and the newer-schema case cannot be reached until a later version writes `schema: 2`. That leaves one newly reachable trigger in PR 1: a cast book whose revisions.json is valid JSON with a non-object top level (`null`, `[]`, a string or a number).
  4. **The poll carries extra fields, and `pending` now arrives with an empty cast (D8).** The old client's `applyPoll` and `applyBackgroundPoll` read only `drift`, so it never sees these.
  5. **Three new routes are mounted and reachable:** accept, reject and dismiss. No client calls them.

## Invariants to preserve

1. **Between PR 1 and PR 2, the client is the only writer of `pending`.**
   - No finalize caller passes `review`. Spy tests in the splice, QA-repair and generation suites assert this.
   - The new routes have no client caller.
   - The reparse reset leaves `pending: []`, the same result the old delete produced.
2. The lock key is `revisions:${path.resolve(bookDir)}`. It is built only by `revisionsLockKey` in `server/src/workspace/revisions-store.ts`.
3. While that lock is held, only revisions.json is written and no other lock is acquired. The only other filesystem access is the read-only `.previous.mp3` existence probe used by normalisation.
4. Reads (`readRevisions`) take no lock and never write.
5. The old routes keep today's status codes and order. `POST …/audio/previous/restore` keeps its `isGenerationActive` 409 **before** the chapter-id parse. `DELETE …/audio/previous` has no busy check today and gains none.
6. `audio/previous-audio.ts` does not import `routes/generation.ts`. `routes/generation.ts` gains no new import from `audio/` or `workspace/`.
7. `PUT /state` with `slice:'revisions'` is still accepted, and `GET /state` still returns revisions.json **raw**.
8. No store error text reaches an SSE body. Finalize reports a store failure only as `reviewRecorded: false`. Every new or reshaped 500 goes through `requestFailureMessage`.
9. Reparse and replace check that revisions.json can be reset (`assertRevisionsResettable`) **before** they delete or write anything.

## Test plan

### Automated coverage

- **Store** (`server/src/workspace/revisions-store.test.ts`):
  - normalisation;
  - the schema seam and the resettable preflight;
  - corrupt-file refusal;
  - `fileId`/`rev`;
  - upsert, drop and dismiss;
  - the two-phase accept/reject rules, idempotence and `revision_gone`;
  - a reset during an op;
  - lock-key normalisation;
  - serialisation in both orders;
  - `selection` validation.
- **Audio extraction** (`server/src/audio/previous-audio.test.ts`, plus `chapter-audio.test.ts`): the existing tests stay unchanged, plus one new 409.
- **Routes** (`server/src/routes/revision-ops.test.ts`): every code, the curated 500s, the restore-failed → `live_audio_missing` → retried-reject recovery, and a concurrent double accept.
- **Polls** (`server/src/routes/revisions.test.ts`, `qa-report.test.ts`): the new shape, D8, a corrupt file returns 500, curated 500s, and qa-report reads drift only.
- **OpenAPI contract** (`src/lib/api-types.revisions-contract.test.ts`): compile-time, enforced by `npm run typecheck`.
- **Finalize** (`finalize-chapter-write.test.ts`): the `review` tri-state, placement, and a leak-free failure.
- **Callers** (`chapter-splice.test.ts`, `chapter-qa-repair.test.ts`, `generation.test.ts` via `test:slow`): no caller passes `review`, and `reviewRecorded` is threaded only when set.
- **`review` plumbing:**
  - server: `review-request.test.ts`, `queue.test.ts`, `queue-io.test.ts`, and `generation.test.ts` via `test:slow`;
  - client: `src/lib/api-stream-review.test.ts`, `src/store/queue-dispatcher-middleware.test.ts`, `src/mocks/mock-queue.test.ts`.
- **Reset and preflight** (`book-state.reparse.test.ts`, `book-state.replace-manuscript.test.ts`).
- No Playwright spec: PR 1 has no UI-visible behaviour, so PR 2 owns the e2e test.

### Manual acceptance walkthrough

None for PR 1, because it is dark. PR 2 owes the on-box register row:
- splice → switch books → the prompt appears;
- accept → `.previous` is gone;
- re-splice → reject → the original take returns;
- reject during generation → 409, with `pending` unchanged.

## Out of scope

All of PR 2:
- callers passing `review`/`null`;
- the restructure pending drop;
- `restore-unrecorded`;
- normalised `GET /state`;
- `PUT slice:'revisions'` → 400;
- the old routes → 410;
- every client change in spec §4.

Also out of scope: the chapter-take lifecycle (#3456) and the fsck m4a/ogg fix (#3457).

## Ship notes

(Filled in when PR 2 ships.)

---

# revisions.json server-ownership — PR 1 (server, dark) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the server half of spec rev 9, entirely dark:
- a locked revisions.json store;
- the A/B audio steps, extracted unchanged;
- the accept, reject and dismiss routes;
- the finalize `review` seam;
- `review` plumbing through the queue and the generation request;
- the reparse/replace reset, behind a preflight.

The client remains the only writer of `pending`.

**Architecture:** `workspace/revisions-store.ts` owns revisions.json behind a leaf `withKeyLock` and uses the existing `schema-migrate.ts` seam. Accept and reject run in two phases:
1. Under the lock, read the entry.
2. Outside the lock, run the audio step. This is today's code, moved to `audio/previous-audio.ts`.
3. Under the lock again, re-read and write only if the entry is still there.

Finalize gets a tri-state `review`, which every caller leaves undefined in PR 1. `review` rides the persisted queue entry into the generation request. There it is validated and stamped `reviewChapter`, but nothing consumes it yet.

**Tech Stack:** Node 20 + Express + TypeScript, Vitest 5 + supertest, OpenAPI 3.0.3 + openapi-typescript 7, and React/RTK (client type plumbing only).

**Spec:** `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md` (rev 9). Read §"Compatibility and the two PRs" first: this plan implements **PR 1 only**.

**Base:** branch `fix/server-3400-revisions-server-ops` with `origin/main` merged in. HEAD is 7ce51045 and the merge-base is 54205283. All `file:line` citations below were re-anchored against that tree. If a cited line has moved, find it by the quoted text, never by the number alone.

## Global Constraints

### Paths and how to run tests

- **`<wt>` means `C:/Claude/Projects/wt-3400-revisions-server-ops` throughout.** Work only there. Never touch `C:/Claude/Projects/Audiobook-Generator`.
- **The quoted code is authoritative; line numbers are advisory.** Every `file:line` here was measured on the base before any task ran, and an earlier task's edit shifts later lines in the same file. Where a later task's line moved, it says so ("after Task N's edit, near `<quoted text>`"). If a number and the quoted text ever disagree, find the quoted text.
- The command forms below are the `$Cmd` you hand to the detach recipe (see "Lanes and long commands"). In Tasks 1–12, never run them in the foreground. **Every line of a "Run:" block is its own recipe launch, with one `$Cmd` each.** Never chain commands off `cd`: Task 13's Bash permission hook blocks `cd X &&`, and the recipe does not need it.
  - Server, fast pool: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- <path under server/>`
  - Server, slow pool: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test:slow -- <path> [-t "<name filter>"]`
    - This is **required for `src/routes/generation.test.ts` and `src/routes/book-state.test.ts`**. Both are listed in `SLOW_FILES_TO_EXCLUDE` (`server/vitest.config.ts:35-58`), so the fast pool silently prints "No test files found" for them.
    - Add a `-t` filter wherever the step allows, so each child runs as few slow tests as possible.
  - Frontend: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test -- <path under repo root>`
  - Server-only typecheck: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`. Takes about 23 s on this box.
  - Frontend + server typecheck: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`. Takes about 50 s on this box. Tasks 6 and 11 run it through the detach recipe; Task 13 runs it in the foreground on the `claude` lane.

### Lanes and long commands

- **Lanes.**
  - **Tasks 1–12 are auto-cloud children.** Auto-cloud resolves along the `AutoCloud` chain in `C:\Claude\open-engine\config\lanes.psd1`: `cline-glm` → `cline-free` → `cline-qwen-cloud` → `cline` → **`claude`**. A child usually lands on a Cline lane, but the chain can fall back to `claude`. The recipe below works on every lane in that chain.
  - A Cline lane runs every command through PowerShell, via the `oe-run` shim. The shim uses `pwsh` 7 if present and Windows PowerShell 5.1 otherwise (`C:\Claude\open-engine\runner\prompt.md:35-58,91-94`, `.clinerules/cline.md:60`).
    - There is **no** `bash`, `nohup`, `grep`, `tail` or `head`. `&&` is unavailable under 5.1, and the recipe does not need it.
    - A Cline lane **kills any single command at 30 s**.
  - **Task 13 (verify) runs on the `claude` lane** (Claude Code). It runs its commands in the foreground with `timeout: 600000`; see that task.
  - The coordinator sets each task's lane, and each task's header repeats it.
- **Detach every test and typecheck command in Tasks 1–12. No exceptions.**
  - These are launched with the recipe below and then polled: every `vitest` run (`run test -- …`, `test:slow`), every `typecheck`/`tsc`, every `openapi:types`, and every `check:cycles`.
  - Only `git`, `gh`, short file reads and file edits run in the foreground.
  - **There is no "short enough for the foreground" carve-out.** These durations were measured under normal lane concurrency:

    | Command | Duration |
    |---|---|
    | `schema-migrate` | 16 s |
    | `chapter-audio` | 14–41 s |
    | revisions + qa-report | 19 s |
    | queue suites | 31.6 s |
    | finalize | 133 s |
    | reparse + replace + hydrate | 24–64 s |
    | generation `test:slow` | 44 s |
    | server typecheck | 25 s |
    | root typecheck | about 50 s |

- **The detach recipe.** This is the repo's own pattern from `.clinerules/cline.md:263-303`, plus the unique-name rule (`:231-242`) and the liveness rule (`:287-290`).
  - It works under `pwsh` 7 and Windows PowerShell 5.1. The plan author dry-ran it under both shells; see Self-review notes → "Recipe dry run".
  - Each block below is one command for the `oe-run` shim: write it into `oe-run.ps1`, then run `oe-run.cmd`.
  - **Launch.** This returns at once and prints `$T`. Record it.

    ```powershell
    # $Name: a short label for THIS run, e.g. 't4-revision-ops' or 't7-finalize-mutation2'.
    # $Cmd : the exact command, in cmd.exe syntax (it runs under cmd /c). For a -t
    #        run, append --reporter=verbose so the matched test titles are printed.
    $Name = 't4-revision-ops'
    $Cmd  = 'npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revision-ops.test.ts'
    $T = Join-Path $env:TEMP ('cw-' + $Name + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $T -Force | Out-Null
    Set-Content -Path (Join-Path $T 'cmd.txt') -Value $Cmd -Encoding ascii
    $child = @'
    param([string]$Dir)
    $ErrorActionPreference = 'Continue'
    $log = Join-Path $Dir 'run.log'
    $cmdLine = (Get-Content -Path (Join-Path $Dir 'cmd.txt') -Raw).Trim()
    cmd /c $cmdLine *>&1 | Out-File -FilePath $log -Encoding utf8
    "EXIT=$LASTEXITCODE" | Out-File -FilePath $log -Append -Encoding utf8
    '@
    Set-Content -Path (Join-Path $T 'run.ps1') -Value $child -Encoding utf8
    $p = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$T\run.ps1`"", '-Dir', "`"$T`"")
    $p.Id | Set-Content (Join-Path $T 'run.pid')
    $T
    ```

    In the real `.ps1` file, every line starts at **column 0**. That includes the here-string's body lines and its closing `'@`. The indentation above is markdown only; strip it.
  - **Why the command goes through `cmd.txt`:** it keeps any quotes in `$Cmd`, such as `-t "plan 285"`, out of `Start-Process`'s argument quoting.
  - **Never reuse a fixed dir or log name.** The GUID suffix is load-bearing. Two lanes, or two attempts, that share a log each read the other's `EXIT=`.
  - **Poll.** Repeat this short command with `$T` set to the dir the launch printed. It checks **the process first, then the sentinel**.
    - **Poll at most once every 60 s, and use no tight loops.** The block opens with its own wait. Use `-Seconds 120` for finalize and `test:slow` runs.
    - This follows `C:\Claude\open-engine\runner\prompt.md:119-145`: make "FEWER, LONGER waits", and never open a fresh short loop identical to the last one.

    ```powershell
    Start-Sleep -Seconds 60   # 120 for finalize and test:slow runs
    $T     = '<the dir the launch printed>'
    $id    = Get-Content "$T\run.pid"
    $alive = [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)
    $done  = (Test-Path "$T\run.log") -and (Select-String -Path "$T\run.log" -Pattern '^EXIT=' -Quiet)
    "alive=$alive done=$done"
    if ($alive)    { 'still running -- keep polling, and IGNORE any EXIT= you can see' }
    elseif ($done) {
        Select-String -Path "$T\run.log" -Pattern 'Test Files|Tests  |error TS|EXIT=' | ForEach-Object { $_.Line }
        Get-Content "$T\run.log" -Tail 40
    }
    else           { 'child gone with no EXIT= -- read run.log, then relaunch into a FRESH dir' }
    ```

  - **Reading the result**, using PowerShell only:
    - **Green means all of the following**, and nothing less:
      - `EXIT=0`;
      - the vitest summary shows `Tests  N passed` with N ≥ 1;
      - no `failed` anywhere in the summary;
      - for a `-t` run, every expected test title appears in the log. Run it with `--reporter=verbose` and check with `Select-String -Path "$T\run.log" -SimpleMatch '<title text>'`.
      - A `-t` filter that matches nothing (every test skipped, `Tests  N skipped` with no `passed`) is a **FAIL**: fix the filter, don't record it.
      - For tsc, green is `EXIT=0` with no `error TS` line.
      - Wherever this plan says "confirm green", "Expected: PASS" or "restore … and re-run green", this rule applies.
    - Any other `EXIT=` is red.
    - **vitest:** the summary is the `Test Files …` and `Tests …` lines the `Select-String` above prints, for example `Test Files  1 passed (1)` and `Tests  5 passed | 1 skipped (6)`. For a failing assertion, read the block around it: `Select-String -Path "$T\run.log" -Pattern 'FAIL|AssertionError|expected' -Context 0,6`.
    - **tsc / typecheck:** the result is `EXIT=` plus any `error TS…` lines. `EXIT=0` with no `error TS` line is clean.
    - The child redirects with `*>&1`, so a green run's tail can still show `NativeCommandError` noise from stderr chatter. Trust `EXIT=`, not the look of the text.
    - **While the process is alive, an `EXIT=` you can see belongs to an earlier attempt.** Keep polling.
    - Paste the summary lines, or the `error TS` lines, into your report.

- **The contention rule** covers **any unexpected red**, including a step that is expected to be green.
  - **Contention signatures** in the log are:
    - `Hook timed out in`;
    - `Worker exited unexpectedly`;
    - exit code `3221226505` (decimal, as `EXIT=3221226505`), which is `0xC0000409`.
  - **If you see a contention signature:**
    1. Wait 60 s and re-run once, through a fresh launch.
    2. If it is still a contention signature, wait 2 minutes and retry. Do no more than **3 runs in total**.
    3. If it still fails, post `AGENT NEEDS INPUT` with the log tails from every run.
    - **Never change code to make a contention red go away.**
  - **A red that is the stated assertion** (red-first or mutation evidence) is accepted on its **first** run. No re-run is required.
  - **A red that is neither** (a different assertion, or a different test) is a real failure. Report it; it is not the evidence the step asked for.
  - (`LOW_CONCURRENCY=1` is not a remedy. `server/vitest.config.ts:65-67` only changes `maxWorkers`, which is already 1 for a single file.)

- **Retry is off for every red-first and mutation run.** Both vitest configs set `retry: 1` (`server/vitest.config.ts`, root `vitest.config.ts:137`). A test that consumes one-shot state, such as Task 4's `mockImplementationOnce` interleave or any module-level mutable state, can fail its first attempt and pass the retry. Vitest then reports green. That is the ops-46 hazard named in the config's own comment.
  - Every run whose purpose is to **observe a red** (a red-first step, or a mutation check) appends `--retry=0` to its `$Cmd`.
  - Example: `npm --prefix <wt>/server run test -- src/routes/revision-ops.test.ts -t "revision_gone" --reporter=verbose --retry=0`.
  - Ordinary green runs keep the configured retry.
  - A mutation check is valid only if run with `--retry=0`. A mutation that goes green without `--retry=0` proves nothing.

- **No task child runs a full battery.** That rules out `npm run test`, `test:server`, `test:server-slow`, `test:all`, `verify`, `build` and the whole-tree `npm run lint`.
  - These batteries exceed a Cline lane's 30 s per-command limit, and the whole set exceeds one heartbeat. In CI run 36068522339, the fast server suite alone took 176 s on Linux and 245 s on Windows.
  - Cloud `verify.yml` on the PR is the required, authoritative gate anyway (CLAUDE.md "Commit gate").
  - Each task runs only its own targeted test files, through the recipe.

### The dark state

- **PR 1 is dark. Invariant: between PR 1 and PR 2, the client is the only writer of `pending`.** Every task states how it keeps this.
- No finalize caller passes `review`.
- Restructure's pending drop is **not** wired.
- `PUT /state` with `slice:'revisions'` is still accepted, and still writes raw.
- `GET /state` returns revisions.json **raw**.
- The old routes call the extracted audio functions with **today's status codes and order**. The restore route keeps its `isGenerationActive` 409 before the chapter-id parse; `DELETE …/audio/previous` has no busy check and gains none (Invariant 5). A bad chapter id is a 404. A failed restore is a 500 with `'Failed to restore previous audio.'`.

### Locking, imports and schema

- The revisions lock is a **leaf**. Its key, `revisions:${path.resolve(bookDir)}`, is built only by `revisionsLockKey`.
- While the lock is held, nothing else is acquired and no file other than revisions.json is written.
- `audio/previous-audio.ts` must not import `routes/generation.ts`.
- `routes/generation.ts` gains **no new import from `audio/` or `workspace/`**. Its only new import is `./review-request.js`.
- `npm run check:cycles` must stay clean.
- revisions.json goes through `server/src/workspace/schema-migrate.ts`: `migrateSeamDoc` on read, `stampSeamSchema` on write. The **store** refuses a newer-schema file on every path. A corrupt file throws, as on main, and no store write ever overwrites it. The one exception is `resetRevisions`, which replaces a corrupt file as the old `rm` did.
- Reparse and replace call `assertRevisionsResettable(bookDir)` **before** anything is deleted or written.

### API contract and error text

- **Every field added to an existing OpenAPI schema is optional.** `RevisionsState` is a new schema and is fully required.
- No store error text appears in any SSE body or 4xx body.
- **Every new or reshaped whole-request 500 goes through `requestFailureMessage`** (`server/src/workspace/file-lock.ts:214`). This covers the three revision-ops routes, the two polls in `revisions.ts`, and qa-report's GET.

### Commits and pushes (Open Engine model)

- **Every task commits and pushes** on `fix/server-3400-revisions-server-ops`, in the foreground, with the message given in its last step.
- Never use `--no-verify`.
- Commit subjects follow `<type>(<scope>): <subject>`, are at most 100 characters, and use scopes from frontend|server|sidecar|app|scripts|e2e|mocks|openapi|docs|deps|ci|ops. Separate multiple scopes with commas and no spaces.
- No `server/tts-sidecar/**` changes.

### Mutation checks

Every task ends with a **mutation check**:
1. Make the named change.
2. Run the named test through the detach recipe, and paste the **observed** red output into the report.
   - A red that is the stated assertion is accepted on its first run.
   - Any other red goes through the contention rule (Global Constraints).
3. Restore the change.
4. Re-run and confirm green under the Green rule.
5. Run `git -C <wt> diff --stat` and confirm it lists **only the task's own intended files**. The mutated file must show no residue beyond the task's own edits.

## Review Focus

1. **A corrupt or newer-schema revisions.json.**
   - The store must fail loudly: the poll and qa-report return a 500, every store write refuses, and the store never overwrites the original.
   - The one deliberate exception: `resetRevisions` replaces a corrupt file.
   - A newer-schema file makes reparse and replace refuse **before** they delete anything.
   - In PR 1 the client's raw `PUT /state` still writes, by design.
   - Pinned in Tasks 1, 5 and 12.
2. **A `revisionId` of `__proto__` or `constructor` in the URL.** Expect a 404, no prototype pollution, and nothing written. Pinned in Tasks 2 and 4.
3. **A double-click on Approve** (two concurrent accepts for one id). Expect both to return 200 with exactly one `accepted` timeline entry. Pinned in Task 4.
4. **Accept when neither live nor `.previous` audio exists.** Expect it to proceed and clear the entry, with no `live_audio_missing`. Pinned in Task 4.
5. **The same bookDir spelled two ways** (`…/book` and `…/book\audio\..`, built without `path.join`). Expect one lock and no lost update. Pinned in Task 1.

---

### Task 1 (1a): Store core

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Create: `server/src/workspace/revisions-store.ts`
- Test: `server/src/workspace/revisions-store.test.ts`
- Modify (comments only): `server/src/workspace/schema-migrate.ts`, at the fs-1 scope note (`:22-27`) and the `stampSeamSchema` docstring (`:99-100`). This task makes the store the first writer that stamps, so both comments become false.

**Dark-state note:** this task creates the module, and nothing in production calls it yet.

**Interfaces:**
- Consumes:
  - `readJson`, `writeJsonAtomic` (`./state-io.js`);
  - `revisionsJsonPath`, `audioDir` (`./paths.js`);
  - `withKeyLock` (`./file-lock.js`);
  - `hasPreviousAudio(audioRoot, slug): boolean` (`./preserve-previous-audio.js`);
  - `SCHEMA_SEAMS`, `migrateSeamDoc`, `stampSeamSchema`, `UnsupportedSchemaError` (`./schema-migrate.js`, unchanged on the new base).
- Produces:
  ```ts
  export interface ChapterRef { id: number; slug: string }
  export interface StoredRevision {
    id: string; chapterId: number; characterId: string;
    triggeredBy?: string; triggeredAgo?: string; oldDuration?: string; newDuration?: string;
    confidence?: number; playable: boolean; hasPreviousAudio: boolean;
    segments: unknown[]; origin?: 'server';
  }
  export interface StoredTimelineEntry {
    id: string; chapterId: number; characterId?: string;
    eventKind: 'accepted' | 'rejected' | 'rolled-back'; timestamp: string;
    revisionId?: string; status: 'active' | 'rolled-back-from'; reversible?: boolean;
  }
  export type Selection = Record<string, 'A' | 'B'>;
  export interface RevisionsFile {
    schema: 1; fileId: string | null; rev: number; pending: StoredRevision[];
    dismissed: string[]; acceptedSelections: Record<string, Selection>;
    timeline: Record<string, StoredTimelineEntry[]>;
  }
  export interface RevisionsState {
    bookId: string; fileId: string | null; rev: number; pending: StoredRevision[];
    dismissed: string[]; acceptedSelections: Record<string, Selection>;
    timeline: Record<string, StoredTimelineEntry[]>;
  }
  export function revisionsLockKey(bookDir: string): string;
  export function mintFileId(nowMs?: number, suffix?: string): string;
  export function emptyRevisionsFile(fileId?: string | null): RevisionsFile;
  export function normaliseRevisions(raw: unknown, previousExists: (chapterId: number) => boolean): RevisionsFile;
  export function toRevisionsState(bookId: string, file: RevisionsFile): RevisionsState;
  export function parseSelection(raw: unknown): { ok: true; value: Selection | undefined } | { ok: false; message: string };
  export async function readRevisions(bookDir: string, chapters: readonly ChapterRef[]): Promise<RevisionsFile>;
  export async function assertRevisionsResettable(bookDir: string): Promise<void>; // throws UnsupportedSchemaError for a newer schema; a corrupt or missing file passes
  export async function resetRevisions(bookDir: string): Promise<RevisionsFile>;
  export async function recordPending(bookDir: string, chapters: readonly ChapterRef[], entry: StoredRevision): Promise<RevisionsFile>;
  export async function dropPendingForChapter(bookDir: string, chapters: readonly ChapterRef[], chapterId: number): Promise<RevisionsFile>;
  export async function dismissDriftId(bookDir: string, chapters: readonly ChapterRef[], driftId: string): Promise<RevisionsFile>;
  // module-private, extended by Task 2: isDangerousKey, isObj, load, save
  ```

- [ ] **Step 1: Write the failing test file** `server/src/workspace/revisions-store.test.ts`

```ts
/* Plan 285 Task 1 — the revisions.json store core (spec §1). Pure store
   against a tempdir. Task 2 appends the two-phase op tests to this file. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  readRevisions,
  assertRevisionsResettable,
  resetRevisions,
  recordPending,
  dropPendingForChapter,
  dismissDriftId,
  parseSelection,
  mintFileId,
  revisionsLockKey,
  toRevisionsState,
  type ChapterRef,
  type StoredRevision,
} from './revisions-store.js';
import { revisionsJsonPath, audioDir } from './paths.js';

let bookDir: string;
const CHAPTERS: ChapterRef[] = [
  { id: 1, slug: '01-one' },
  { id: 2, slug: '02-two' },
];

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'revisions-store-'));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioDir(bookDir), { recursive: true });
});
afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

/** A second spelling of bookDir that `path.join` would have normalised away —
    built by string concatenation so only the store's own `path.resolve` can
    collapse it. */
const otherSpelling = () => `${bookDir}${sep}audio${sep}..`;

function seedRaw(value: unknown): void {
  writeFileSync(revisionsJsonPath(bookDir), JSON.stringify(value));
}
function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(revisionsJsonPath(bookDir), 'utf8'));
}
function serverEntry(chapterId: number, id = `revision:${chapterId}:1000`): StoredRevision {
  return {
    id,
    chapterId,
    characterId: 'narrator',
    triggeredBy: 'Narrator voice change',
    triggeredAgo: 'just now',
    oldDuration: '00:10',
    newDuration: '00:11',
    confidence: 1,
    playable: true,
    hasPreviousAudio: true,
    segments: [],
    origin: 'server',
  };
}
const EMPTY = {
  schema: 1,
  fileId: null,
  rev: 0,
  pending: [],
  dismissed: [],
  acceptedSelections: {},
  timeline: {},
};

describe('readRevisions — normalisation (never writes)', () => {
  it('reads a missing file as empty and does not create it', async () => {
    expect(await readRevisions(bookDir, CHAPTERS)).toEqual(EMPTY);
    expect(existsSync(revisionsJsonPath(bookDir))).toBe(false);
  });

  it('drops drift, playable:false legacy entries, and legacy entries with no .previous.mp3', async () => {
    writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
    seedRaw({
      drift: [{ id: 'd1' }],
      dismissed: ['x', 'x', 7],
      pending: [
        { id: 'a', chapterId: 1, characterId: 'c', playable: false, segments: [] },
        { id: 'b', chapterId: 2, characterId: 'c', playable: true, segments: [] },
        { id: 'c1', chapterId: 1, characterId: 'c', playable: true },
      ],
    });
    const before = readFileSync(revisionsJsonPath(bookDir), 'utf8');
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file).not.toHaveProperty('drift');
    expect(file.dismissed).toEqual(['x']);
    expect(file.pending).toEqual([
      { id: 'c1', chapterId: 1, characterId: 'c', playable: true, hasPreviousAudio: true, segments: [] },
    ]);
    expect(readFileSync(revisionsJsonPath(bookDir), 'utf8')).toBe(before);
  });

  it('treats a legacy entry with no playable flag as playable (kept only when .previous.mp3 exists)', async () => {
    seedRaw({ pending: [{ id: 'old', chapterId: 1, characterId: 'c', segments: [] }] });
    expect((await readRevisions(bookDir, CHAPTERS)).pending).toEqual([]);
    writeFileSync(join(audioDir(bookDir), '01-one.previous.mp3'), 'PREV');
    expect((await readRevisions(bookDir, CHAPTERS)).pending.map((p) => p.id)).toEqual(['old']);
  });

  it('keeps server entries regardless of .previous and keeps only the LAST entry per chapter', async () => {
    seedRaw({ pending: [serverEntry(1, 'r1'), serverEntry(2, 'r2'), serverEntry(1, 'r3')] });
    const ids = (await readRevisions(bookDir, CHAPTERS)).pending.map((p) => p.id);
    expect(ids.sort()).toEqual(['r2', 'r3']);
  });

  it('drops prototype-polluting keys from acceptedSelections and timeline', async () => {
    writeFileSync(
      revisionsJsonPath(bookDir),
      '{"acceptedSelections":{"__proto__":{"0":"A"},"r1":{"0":"A","1":"Z"}},' +
        '"timeline":{"constructor":[{"id":"x","eventKind":"accepted"}]}}',
    );
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file.acceptedSelections).toEqual({ r1: { '0': 'A' } });
    expect(file.timeline).toEqual({});
    expect(({} as Record<string, unknown>)['0']).toBeUndefined();
  });
});

describe('refusals — the store never overwrites the original bytes', () => {
  it('a corrupt (unparseable) file THROWS, as on main, and no store write overwrites it', async () => {
    const corrupt = '{"pending": [';
    writeFileSync(revisionsJsonPath(bookDir), corrupt);
    await expect(readRevisions(bookDir, CHAPTERS)).rejects.toThrow(SyntaxError);
    await expect(recordPending(bookDir, CHAPTERS, serverEntry(1))).rejects.toThrow(SyntaxError);
    await expect(dismissDriftId(bookDir, CHAPTERS, 'd')).rejects.toThrow(SyntaxError);
    expect(readFileSync(revisionsJsonPath(bookDir), 'utf8')).toBe(corrupt);
  });

  it('a file from a NEWER schema refuses reads, writes, the resettable preflight and reset — never downgraded', async () => {
    seedRaw({ schema: 2, pending: [] });
    const before = readFileSync(revisionsJsonPath(bookDir), 'utf8');
    await expect(readRevisions(bookDir, CHAPTERS)).rejects.toThrow(/schema=2/);
    await expect(recordPending(bookDir, CHAPTERS, serverEntry(1))).rejects.toThrow(/schema=2/);
    await expect(assertRevisionsResettable(bookDir)).rejects.toThrow(/schema=2/);
    await expect(resetRevisions(bookDir)).rejects.toThrow(/schema=2/);
    expect(readFileSync(revisionsJsonPath(bookDir), 'utf8')).toBe(before);
  });

  it('a top level that is not a plain object (array, literal null, string or number) THROWS as corrupt — it is never read as missing', async () => {
    for (const body of ['[]', 'null', '"text"', '42']) {
      writeFileSync(revisionsJsonPath(bookDir), body);
      await expect(readRevisions(bookDir, CHAPTERS)).rejects.toThrow(SyntaxError);
      await expect(recordPending(bookDir, CHAPTERS, serverEntry(1))).rejects.toThrow(SyntaxError);
      expect(readFileSync(revisionsJsonPath(bookDir), 'utf8')).toBe(body);
      // corrupt ⇒ resettable: reset replaces it, as the old rm did
      await expect(assertRevisionsResettable(bookDir)).resolves.toBeUndefined();
    }
  });

  it('the resettable preflight passes for a missing, a v1 and a corrupt file', async () => {
    await expect(assertRevisionsResettable(bookDir)).resolves.toBeUndefined();
    seedRaw({ schema: 1, pending: [] });
    await expect(assertRevisionsResettable(bookDir)).resolves.toBeUndefined();
    writeFileSync(revisionsJsonPath(bookDir), '{"pending": [');
    await expect(assertRevisionsResettable(bookDir)).resolves.toBeUndefined();
  });

  it('a non-parse read failure propagates too (EISDIR)', async () => {
    mkdirSync(revisionsJsonPath(bookDir)); // a directory where the file should be
    await expect(readRevisions(bookDir, CHAPTERS)).rejects.toThrow();
    await expect(recordPending(bookDir, CHAPTERS, serverEntry(1))).rejects.toThrow();
  });

  it('reset REPLACES a corrupt file (as the old rm did)', async () => {
    writeFileSync(revisionsJsonPath(bookDir), '{"pending": [');
    const reset = await resetRevisions(bookDir);
    expect(onDisk()).toEqual({ ...EMPTY, fileId: reset.fileId });
  });
});

describe('fileId / rev / schema stamp', () => {
  it('mints `${15-digit zero-padded epoch}-${random}`', () => {
    expect(mintFileId(1234, 'abcd1234')).toBe('000000000001234-abcd1234');
    expect(mintFileId()).toMatch(/^\d{15}-[0-9a-f]{8}$/);
  });

  it('mints a fileId on the first write to a legacy file, stamps schema 1, and bumps rev on every write', async () => {
    seedRaw({ pending: [] });
    const first = await recordPending(bookDir, CHAPTERS, serverEntry(1));
    expect(first.fileId).toMatch(/^\d{15}-[0-9a-f]{8}$/);
    expect(first.rev).toBe(1);
    expect(onDisk()).toMatchObject({ schema: 1, fileId: first.fileId, rev: 1 });
    const second = await recordPending(bookDir, CHAPTERS, serverEntry(2));
    expect(second.fileId).toBe(first.fileId);
    expect(second.rev).toBe(2);
  });

  it('a no-op write does not bump rev', async () => {
    const a = await dismissDriftId(bookDir, CHAPTERS, 'drift:b:1:c:voice');
    const b = await dismissDriftId(bookDir, CHAPTERS, 'drift:b:1:c:voice');
    expect(b.rev).toBe(a.rev);
    const c = await dropPendingForChapter(bookDir, CHAPTERS, 2);
    expect(c.rev).toBe(a.rev);
  });

  it('reset writes an empty file with a NEW fileId and rev 0 — never deletes it', async () => {
    const written = await recordPending(bookDir, CHAPTERS, serverEntry(1));
    const reset = await resetRevisions(bookDir);
    expect(existsSync(revisionsJsonPath(bookDir))).toBe(true);
    expect(reset.fileId).not.toBe(written.fileId);
    expect(reset.fileId).toMatch(/^\d{15}-[0-9a-f]{8}$/);
    expect(onDisk()).toEqual({ ...EMPTY, fileId: reset.fileId });
  });

  it('reset creates the file when it is missing', async () => {
    const reset = await resetRevisions(bookDir);
    expect(onDisk()).toEqual({ ...EMPTY, fileId: reset.fileId });
  });
});

describe('recordPending / dropPendingForChapter', () => {
  it('upserts one entry per chapter and drops only the named chapter', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1'));
    await recordPending(bookDir, CHAPTERS, serverEntry(2, 'r2'));
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r3'));
    expect((await readRevisions(bookDir, CHAPTERS)).pending.map((p) => p.id).sort()).toEqual(['r2', 'r3']);
    await dropPendingForChapter(bookDir, CHAPTERS, 1);
    expect((await readRevisions(bookDir, CHAPTERS)).pending.map((p) => p.id)).toEqual(['r2']);
  });
});

describe('lock key', () => {
  it('normalises the key: two spellings of one bookDir share one lock', () => {
    expect(otherSpelling()).not.toBe(bookDir);
    expect(revisionsLockKey(otherSpelling())).toBe(revisionsLockKey(bookDir));
    expect(revisionsLockKey(bookDir).startsWith('revisions:')).toBe(true);
  });

  it('concurrent writes through two spellings lose no update', async () => {
    await Promise.all([
      recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1')),
      recordPending(otherSpelling(), CHAPTERS, serverEntry(2, 'r2')),
    ]);
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file.pending.map((p) => p.id).sort()).toEqual(['r1', 'r2']);
    expect(file.rev).toBe(2);
  });
});

describe('parseSelection', () => {
  it('accepts absence and integer-keyed A/B maps', () => {
    expect(parseSelection(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseSelection({ '0': 'A', '3': 'B' })).toEqual({ ok: true, value: { '0': 'A', '3': 'B' } });
  });

  it('rejects non-objects, non-integer keys, values outside A/B, and dangerous keys', () => {
    for (const bad of [
      null,
      ['A'],
      'A',
      { x: 'A' },
      { '-1': 'A' },
      { '1.5': 'A' },
      { '01': 'A' },
      { '0': 'C' },
      JSON.parse('{"__proto__":{"0":"A"}}'),
      JSON.parse('{"constructor":"A"}'),
    ]) {
      expect(parseSelection(bad).ok).toBe(false);
    }
  });
});

describe('toRevisionsState', () => {
  it('drops `schema` and stamps the bookId', () => {
    const state = toRevisionsState('book-1', {
      schema: 1,
      fileId: 'f',
      rev: 2,
      pending: [],
      dismissed: [],
      acceptedSelections: {},
      timeline: {},
    });
    expect(state).toEqual({
      bookId: 'book-1',
      fileId: 'f',
      rev: 2,
      pending: [],
      dismissed: [],
      acceptedSelections: {},
      timeline: {},
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/workspace/revisions-store.test.ts`
Expected: FAIL with `Failed to load url ./revisions-store.js`.

- [ ] **Step 3: Write the implementation** `server/src/workspace/revisions-store.ts`

The header comment deliberately spells the key as `revisions:<absolute bookDir>`, not as template-literal syntax. That keeps Task 13's code-only key grep from matching this comment.

```ts
/* Plan 285 (#3400) — the ONLY reader/writer of `<bookDir>/.audiobook/revisions.json`.
   Modelled on script-review-ledger.ts.

   LOCK. Every write runs under withKeyLock(revisionsLockKey(bookDir)). The key is
   "revisions:" + the path.resolve'd bookDir, normalised HERE so two callers that
   spell bookDir differently can never split the lock. The read, and every
   decision derived from it, happens inside the lock.

   LEAF LOCK. Nothing acquires any other lock while holding this one, and no file
   other than revisions.json is WRITTEN under it. (Normalisation probes
   `audio/<slug>.previous.mp3` for existence — a read-only stat, no lock, no
   write.) See the lock-order comment in cast-lock.ts.

   READS (readRevisions) take no lock: writeJsonAtomic renames atomically, so a
   reader always sees one whole version, and a GET can never hit a lock timeout.

   SCHEMA. Reads go through schema-migrate.ts's migrateSeamDoc (a newer-schema
   file throws UnsupportedSchemaError — refused, never downgraded); writes are
   stamped with stampSeamSchema. A CORRUPT file throws, exactly as on main
   (readJson's JSON.parse), so no store write ever overwrites it; only
   resetRevisions (reparse / replace) replaces a corrupt file, as the old `rm`
   did. assertRevisionsResettable is the preflight reparse/replace run BEFORE
   deleting anything. (In PR 1 the client's raw PUT /state still writes the
   file outside this module, by design.)

   PR 1 IS DARK: no production code calls the write ops except resetRevisions.
   The client remains the only writer of `pending`. */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './state-io.js';
import { audioDir, revisionsJsonPath } from './paths.js';
import { withKeyLock } from './file-lock.js';
import { hasPreviousAudio as previousAudioExists } from './preserve-previous-audio.js';
import { SCHEMA_SEAMS, migrateSeamDoc, stampSeamSchema, UnsupportedSchemaError } from './schema-migrate.js';

const REVISIONS_SEAM = SCHEMA_SEAMS.find((s) => s.label === 'revisions.json')!;

export interface ChapterRef {
  id: number;
  slug: string;
}

export interface StoredRevision {
  id: string;
  chapterId: number;
  characterId: string;
  triggeredBy?: string;
  triggeredAgo?: string;
  oldDuration?: string;
  newDuration?: string;
  confidence?: number;
  playable: boolean;
  hasPreviousAudio: boolean;
  segments: unknown[];
  /** Present (`'server'`) on entries the server recorded; absent on legacy client-written ones. */
  origin?: 'server';
}

export interface StoredTimelineEntry {
  id: string;
  chapterId: number;
  characterId?: string;
  eventKind: 'accepted' | 'rejected' | 'rolled-back';
  timestamp: string;
  revisionId?: string;
  status: 'active' | 'rolled-back-from';
  reversible?: boolean;
}

export type Selection = Record<string, 'A' | 'B'>;

export interface RevisionsFile {
  schema: 1;
  /** `${epochMs zero-padded to 15}-${random}`; minted on the first store write and on every reset. Null = a legacy/missing file nobody has written through the store. */
  fileId: string | null;
  /** +1 on every write within one fileId; 0 for a missing file and after a reset. */
  rev: number;
  pending: StoredRevision[];
  dismissed: string[];
  acceptedSelections: Record<string, Selection>;
  timeline: Record<string, StoredTimelineEntry[]>;
}

export interface RevisionsState {
  bookId: string;
  fileId: string | null;
  rev: number;
  pending: StoredRevision[];
  dismissed: string[];
  acceptedSelections: Record<string, Selection>;
  timeline: Record<string, StoredTimelineEntry[]>;
}

export function revisionsLockKey(bookDir: string): string {
  return `revisions:${resolve(bookDir)}`;
}

export function mintFileId(nowMs: number = Date.now(), suffix: string = randomBytes(4).toString('hex')): string {
  return `${String(nowMs).padStart(15, '0')}-${suffix}`;
}

export function emptyRevisionsFile(fileId: string | null = null): RevisionsFile {
  return { schema: 1, fileId, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} };
}

/** Explicit `===` comparisons (not a Set) so CodeQL's
    js/prototype-polluting-assignment barrier recognises the guard inline —
    same shape as script-review-ledger.ts. */
function isDangerousKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const EVENT_KINDS = new Set(['accepted', 'rejected', 'rolled-back']);

/** Pure. Never writes. `previousExists(chapterId)` answers whether
    `audio/<slug>.previous.mp3` exists for that chapter. Rules (spec §1):
    drop the legacy `drift` copy; default missing fields; drop legacy
    (origin-less) entries with `playable:false`; keep a legacy entry whose
    `playable` is true OR absent only if `.previous.mp3` exists; keep the LAST
    entry when a chapter has several. */
export function normaliseRevisions(
  raw: unknown,
  previousExists: (chapterId: number) => boolean,
): RevisionsFile {
  if (!isObj(raw)) return emptyRevisionsFile();
  const fileId = typeof raw.fileId === 'string' && raw.fileId.length > 0 ? raw.fileId : null;
  const rev = typeof raw.rev === 'number' && Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;

  const byChapter = new Map<number, StoredRevision>();
  for (const e of Array.isArray(raw.pending) ? raw.pending : []) {
    if (!isObj(e)) continue;
    if (typeof e.id !== 'string' || typeof e.characterId !== 'string') continue;
    if (typeof e.chapterId !== 'number' || !Number.isInteger(e.chapterId)) continue;
    if (e.origin !== 'server') {
      if (e.playable === false) continue;
      if (!previousExists(e.chapterId)) continue;
    }
    byChapter.delete(e.chapterId);
    byChapter.set(e.chapterId, {
      ...(e as unknown as StoredRevision),
      segments: Array.isArray(e.segments) ? e.segments : [],
      playable: true,
      hasPreviousAudio: typeof e.hasPreviousAudio === 'boolean' ? e.hasPreviousAudio : true,
    });
  }

  const dismissed = Array.isArray(raw.dismissed)
    ? [...new Set(raw.dismissed.filter((d): d is string => typeof d === 'string'))]
    : [];

  const acceptedSelections: Record<string, Selection> = {};
  if (isObj(raw.acceptedSelections)) {
    for (const [revId, sel] of Object.entries(raw.acceptedSelections)) {
      if (isDangerousKey(revId) || !isObj(sel)) continue;
      const out: Selection = {};
      for (const [k, v] of Object.entries(sel)) {
        if (isDangerousKey(k)) continue;
        if (v === 'A' || v === 'B') out[k] = v;
      }
      acceptedSelections[revId] = out;
    }
  }

  const timeline: Record<string, StoredTimelineEntry[]> = {};
  if (isObj(raw.timeline)) {
    for (const [chapterKey, list] of Object.entries(raw.timeline)) {
      if (isDangerousKey(chapterKey) || !Array.isArray(list)) continue;
      timeline[chapterKey] = list.filter(
        (t): t is StoredTimelineEntry =>
          isObj(t) && typeof t.id === 'string' && typeof t.eventKind === 'string' && EVENT_KINDS.has(t.eventKind),
      );
    }
  }

  return { schema: 1, fileId, rev, pending: [...byChapter.values()], dismissed, acceptedSelections, timeline };
}

export function toRevisionsState(bookId: string, file: RevisionsFile): RevisionsState {
  return {
    bookId,
    fileId: file.fileId,
    rev: file.rev,
    pending: file.pending,
    dismissed: file.dismissed,
    acceptedSelections: file.acceptedSelections,
    timeline: file.timeline,
  };
}

/** Validate an accept request's `selection` (spec §2 Errors, 400). Absent →
    ok/undefined. Keys must be canonical non-negative integers, values 'A'|'B',
    and no prototype-polluting key (script-review-ledger.ts:46-52). */
export function parseSelection(
  raw: unknown,
): { ok: true; value: Selection | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return { ok: false, message: 'selection must be an object.' };
  const out: Selection = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isDangerousKey(k)) return { ok: false, message: 'selection has a forbidden key.' };
    if (!/^(0|[1-9]\d*)$/.test(k)) return { ok: false, message: `selection key "${k}" is not a segment index.` };
    if (v !== 'A' && v !== 'B') return { ok: false, message: `selection["${k}"] must be "A" or "B".` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

/** null ONLY for a missing file (checked with existsSync — readJson alone
    returns null for both a missing file and a file containing literal `null`).
    THROWS for: unparseable JSON (SyntaxError, as on main); a top level that is
    not a plain object — an array, literal `null`, a string or a number
    (SyntaxError: corrupt, never "missing"); a newer schema
    (UnsupportedSchemaError); and any read error (EISDIR, EBUSY…). So no write
    can follow a bad read and overwrite the original. */
async function loadRaw(bookDir: string): Promise<Record<string, unknown> | null> {
  const path = revisionsJsonPath(bookDir);
  if (!existsSync(path)) return null;
  const raw = await readJson<unknown>(path);
  if (!isObj(raw)) throw new SyntaxError('revisions.json: expected a JSON object at the top level');
  return migrateSeamDoc(REVISIONS_SEAM, raw).doc;
}

async function load(bookDir: string, chapters: readonly ChapterRef[]): Promise<RevisionsFile> {
  const slugById = new Map(chapters.map((c) => [c.id, c.slug] as const));
  const root = audioDir(bookDir);
  const raw = await loadRaw(bookDir);
  return normaliseRevisions(raw, (chapterId) => {
    const slug = slugById.get(chapterId);
    return slug !== undefined && previousAudioExists(root, slug);
  });
}

async function writeStamped(bookDir: string, file: RevisionsFile): Promise<void> {
  await writeJsonAtomic(revisionsJsonPath(bookDir), stampSeamSchema(REVISIONS_SEAM, { ...file } as Record<string, unknown>));
}

async function save(bookDir: string, file: RevisionsFile): Promise<RevisionsFile> {
  const next: RevisionsFile = { ...file, schema: 1, fileId: file.fileId ?? mintFileId(), rev: file.rev + 1 };
  await writeStamped(bookDir, next);
  return next;
}

export async function readRevisions(bookDir: string, chapters: readonly ChapterRef[]): Promise<RevisionsFile> {
  return load(bookDir, chapters);
}

/** Preflight for reparse / replace, run BEFORE they delete anything (lock-free
    read). A reset discards the contents, so a corrupt or missing file is fine
    to reset; only a NEWER-schema file must be refused (never downgraded). */
export async function assertRevisionsResettable(bookDir: string): Promise<void> {
  try {
    await loadRaw(bookDir);
  } catch (err) {
    if (err instanceof UnsupportedSchemaError) throw err;
  }
}

export async function resetRevisions(bookDir: string): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    /* Re-checked under the lock (the preflight ran lock-free, earlier). */
    await assertRevisionsResettable(bookDir);
    const next = emptyRevisionsFile(mintFileId());
    await writeStamped(bookDir, next);
    return next;
  });
}

export async function recordPending(
  bookDir: string,
  chapters: readonly ChapterRef[],
  entry: StoredRevision,
): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    const pending = [...file.pending.filter((p) => p.chapterId !== entry.chapterId), entry];
    return save(bookDir, { ...file, pending });
  });
}

export async function dropPendingForChapter(
  bookDir: string,
  chapters: readonly ChapterRef[],
  chapterId: number,
): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    if (!file.pending.some((p) => p.chapterId === chapterId)) return file;
    return save(bookDir, { ...file, pending: file.pending.filter((p) => p.chapterId !== chapterId) });
  });
}

export async function dismissDriftId(
  bookDir: string,
  chapters: readonly ChapterRef[],
  driftId: string,
): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    if (file.dismissed.includes(driftId)) return file;
    return save(bookDir, { ...file, dismissed: [...file.dismissed, driftId] });
  });
}
```

- [ ] **Step 3b: Correct the two `schema-migrate.ts` comments this task makes false.** These are comment-only edits.

  1. In the fs-1 scope note, replace
     ```
        unstamped file still migrates correctly. When the first real schema bump
        lands, that change adds the writer-side stamp alongside its transform (where
        it's actually load-bearing and testable against a real migration). */
     ```
     with
     ```
        unstamped file still migrates correctly. When the first real schema bump
        lands, that change adds the writer-side stamp alongside its transform (where
        it's actually load-bearing and testable against a real migration).

        One exception (plan 285): revisions.json is owned by
        workspace/revisions-store.ts, which reads through migrateSeamDoc (refusing
        a newer schema) and stamps every write with stampSeamSchema. Every other
        file here is still written unstamped. */
     ```
  2. Replace the `stampSeamSchema` docstring
     ```
     /** Stamp the current schema on a doc before writing. The writer-side seam —
         wired in by the first real schema bump (see scope note above). */
     ```
     with
     ```
     /** Stamp the current schema on a doc before writing. The writer-side seam.
         Today only workspace/revisions-store.ts calls it (plan 285); every other
         writer is wired in by the first real schema bump (see scope note above). */
     ```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/workspace/revisions-store.test.ts src/workspace/schema-migrate.test.ts`
Expected: PASS. The `schema-migrate` suite is untouched apart from the comments, and should stay green.

- [ ] **Step 5: Typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 6: Mutation checks.** Report each red, restore after each, and confirm `git -C <wt> diff --stat` lists only this task's files.

  1. In `revisionsLockKey`, replace `resolve(bookDir)` with `bookDir`. Run Step 4.
     - Expected red: `normalises the key: two spellings of one bookDir share one lock` (`expected 'revisions:…\audio\..' to be 'revisions:…'`).
     - Probably also red: `concurrent writes through two spellings lose no update`.
  2. In `normaliseRevisions`, delete `if (!previousExists(e.chapterId)) continue;`. Run Step 4.
     - Expected red: `drops drift, playable:false legacy entries…` and `treats a legacy entry with no playable flag…`.
  3. In `loadRaw`, change `const raw = await readJson<unknown>(path);` to `const raw = await readJson<unknown>(path).catch(() => ({}));`. Run Step 4.
     - Expected red: `a corrupt (unparseable) file THROWS…` and `a non-parse read failure propagates too`. Both now resolve as an empty file.
  4. In `assertRevisionsResettable`, delete the line `if (err instanceof UnsupportedSchemaError) throw err;`. Run Step 4.
     - Expected red: `a file from a NEWER schema refuses reads, writes, the resettable preflight and reset…`, because the preflight resolves.
  5. In `loadRaw`, replace `if (!isObj(raw)) throw new SyntaxError(…);` with `if (!isObj(raw)) return null;`. Run Step 4.
     - Expected red: `a top level that is not a plain object … THROWS as corrupt`, because the read resolves as a missing file.

- [ ] **Step 7: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/workspace/revisions-store.ts server/src/workspace/revisions-store.test.ts server/src/workspace/schema-migrate.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server): add revisions.json store core with a per-book leaf lock (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push -u origin fix/server-3400-revisions-server-ops
```

---

### Task 2 (1b): Two-phase accept / reject ops in the store

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify: `server/src/workspace/revisions-store.ts` (append)
- Test: `server/src/workspace/revisions-store.test.ts` (append, and extend the import list)

**Dark-state note:** this task adds no production caller.

**Interfaces:**
- Consumes (Task 1, all in `revisions-store.ts`):
  - `ChapterRef`, `StoredRevision`, `StoredTimelineEntry`, `Selection`, `RevisionsFile`;
  - `revisionsLockKey`, `readRevisions`, `recordPending`, `resetRevisions`;
  - module-private `isDangerousKey`, `load(bookDir, chapters)`, `save(bookDir, file)`.
- Produces:
  ```ts
  export type RevisionOpKind = 'accept' | 'reject';
  export type BeginResult =
    | { kind: 'proceed'; entry: StoredRevision; chapter: ChapterRef; file: RevisionsFile }
    | { kind: 'already-done'; file: RevisionsFile }
    | { kind: 'not-found'; file: RevisionsFile };
  export type CommitResult =
    | { kind: 'committed'; file: RevisionsFile }
    | { kind: 'already-done'; file: RevisionsFile }
    | { kind: 'gone'; file: RevisionsFile };
  export async function beginRevisionOp(bookDir: string, chapters: readonly ChapterRef[], op: RevisionOpKind, revisionId: string): Promise<BeginResult>;
  export async function commitRevisionOp(bookDir: string, chapters: readonly ChapterRef[], op: RevisionOpKind, revisionId: string, selection?: Selection): Promise<CommitResult>;
  ```

- [ ] **Step 1: Write the failing tests.** Add `beginRevisionOp` and `commitRevisionOp` to the test file's import list, then append:

```ts
describe('beginRevisionOp / commitRevisionOp', () => {
  it('accept: removes the entry, records the selection, appends a reversible `accepted`', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r-old'));
    await commitRevisionOp(bookDir, CHAPTERS, 'reject', 'r-old');
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1'));
    const begin = await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'r1');
    expect(begin.kind).toBe('proceed');
    if (begin.kind === 'proceed') expect(begin.chapter).toEqual({ id: 1, slug: '01-one' });
    const before = (await readRevisions(bookDir, CHAPTERS)).rev;
    const commit = await commitRevisionOp(bookDir, CHAPTERS, 'accept', 'r1', { '0': 'B' });
    expect(commit.kind).toBe('committed');
    expect(commit.file.rev).toBe(before + 1);
    expect(commit.file.pending).toEqual([]);
    expect(commit.file.acceptedSelections.r1).toEqual({ '0': 'B' });
    expect(commit.file.timeline['1'].map((t) => [t.id, t.eventKind, t.reversible])).toEqual([
      ['r-old', 'rejected', false],
      ['r1', 'accepted', true],
    ]);
  });

  it('a retried accept is idempotent on TimelineEntry.id and writes nothing', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1'));
    const done = await commitRevisionOp(bookDir, CHAPTERS, 'accept', 'r1');
    expect((await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'r1')).kind).toBe('already-done');
    const again = await commitRevisionOp(bookDir, CHAPTERS, 'accept', 'r1');
    expect(again.kind).toBe('already-done');
    expect(again.file.rev).toBe(done.file.rev);
    expect(again.file.timeline['1']).toHaveLength(1);
  });

  it('a reject does not treat an `accepted` timeline entry as its own', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1'));
    await commitRevisionOp(bookDir, CHAPTERS, 'accept', 'r1');
    expect((await beginRevisionOp(bookDir, CHAPTERS, 'reject', 'r1')).kind).toBe('not-found');
    expect((await commitRevisionOp(bookDir, CHAPTERS, 'reject', 'r1')).kind).toBe('gone');
  });

  it('drops an entry whose chapter no longer exists and answers not-found', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(9, 'r9'));
    const before = (await readRevisions(bookDir, CHAPTERS)).rev;
    const begin = await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'r9');
    expect(begin.kind).toBe('not-found');
    expect(begin.file.pending).toEqual([]);
    expect(begin.file.rev).toBe(before + 1);
  });

  it('unknown and prototype-polluting ids are not-found / gone and write nothing', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1'));
    const rev = (await readRevisions(bookDir, CHAPTERS)).rev;
    for (const id of ['nope', '__proto__', 'constructor']) {
      expect((await beginRevisionOp(bookDir, CHAPTERS, 'accept', id)).kind).toBe('not-found');
      expect((await commitRevisionOp(bookDir, CHAPTERS, 'accept', id)).kind).toBe('gone');
    }
    expect((await readRevisions(bookDir, CHAPTERS)).rev).toBe(rev);
  });

  it('step 3 answers gone and writes nothing when a NEWER upsert replaced the entry', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'revision:1:1000'));
    await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'revision:1:1000');
    const upsert = await recordPending(bookDir, CHAPTERS, serverEntry(1, 'revision:1:2000'));
    const commit = await commitRevisionOp(bookDir, CHAPTERS, 'accept', 'revision:1:1000');
    expect(commit.kind).toBe('gone');
    expect(commit.file.rev).toBe(upsert.rev);
    expect(commit.file.pending.map((p) => p.id)).toEqual(['revision:1:2000']);
    expect(commit.file.timeline).toEqual({});
  });

  it('step 3 answers gone when an opposing op finished first', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1'));
    await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'r1');
    await beginRevisionOp(bookDir, CHAPTERS, 'reject', 'r1');
    expect((await commitRevisionOp(bookDir, CHAPTERS, 'reject', 'r1')).kind).toBe('committed');
    const late = await commitRevisionOp(bookDir, CHAPTERS, 'accept', 'r1');
    expect(late.kind).toBe('gone');
    expect(late.file.timeline['1'].map((t) => t.eventKind)).toEqual(['rejected']);
  });

  it('a reset while an op waits for its final write: gone, and nothing is written into the reset file', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1'));
    await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'r1');
    const reset = await resetRevisions(bookDir);
    const commit = await commitRevisionOp(bookDir, CHAPTERS, 'accept', 'r1', { '0': 'A' });
    expect(commit.kind).toBe('gone');
    expect(onDisk()).toEqual({ ...EMPTY, fileId: reset.fileId });
  });
});

describe('lock serialisation — accept racing recordPending', () => {
  it('commit queued first: committed, then the new entry lands', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'revision:1:1000'));
    await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'revision:1:1000');
    const [commit] = await Promise.all([
      commitRevisionOp(bookDir, CHAPTERS, 'accept', 'revision:1:1000'),
      recordPending(bookDir, CHAPTERS, serverEntry(1, 'revision:1:2000')),
    ]);
    expect(commit.kind).toBe('committed');
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file.pending.map((p) => p.id)).toEqual(['revision:1:2000']);
    expect(file.timeline['1'].map((t) => t.id)).toEqual(['revision:1:1000']);
    expect(file.rev).toBe(3);
  });

  it('upsert queued first: gone, and the new entry survives', async () => {
    await recordPending(bookDir, CHAPTERS, serverEntry(1, 'revision:1:1000'));
    await beginRevisionOp(bookDir, CHAPTERS, 'accept', 'revision:1:1000');
    const [, commit] = await Promise.all([
      recordPending(bookDir, CHAPTERS, serverEntry(1, 'revision:1:2000')),
      commitRevisionOp(bookDir, CHAPTERS, 'accept', 'revision:1:1000'),
    ]);
    expect(commit.kind).toBe('gone');
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file.pending.map((p) => p.id)).toEqual(['revision:1:2000']);
    expect(file.timeline).toEqual({});
    expect(file.rev).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/workspace/revisions-store.test.ts`
Expected: FAIL. The new tests report `beginRevisionOp is not a function` / `commitRevisionOp is not a function`, while Task 1's tests still pass.

- [ ] **Step 3: Append to `server/src/workspace/revisions-store.ts`**

```ts
/* ── Two-phase accept / reject (spec §2) ───────────────────────────────────
   beginRevisionOp (step 1, under the lock) → the caller's audio step (step 2,
   OUTSIDE the lock) → commitRevisionOp (step 3, under the lock; re-reads and
   writes only if the entry is still pending). */

export type RevisionOpKind = 'accept' | 'reject';

export type BeginResult =
  | { kind: 'proceed'; entry: StoredRevision; chapter: ChapterRef; file: RevisionsFile }
  | { kind: 'already-done'; file: RevisionsFile }
  | { kind: 'not-found'; file: RevisionsFile };

export type CommitResult =
  | { kind: 'committed'; file: RevisionsFile }
  | { kind: 'already-done'; file: RevisionsFile }
  | { kind: 'gone'; file: RevisionsFile };

/** Idempotence keys on TimelineEntry.id === revisionId (revisions-slice.ts:170-178);
    the schema's own `revisionId` field means "rollback target" and is not it. */
function hasOutcome(file: RevisionsFile, op: RevisionOpKind, revisionId: string): boolean {
  const kind = op === 'accept' ? 'accepted' : 'rejected';
  return Object.values(file.timeline).some((list) => list.some((t) => t.id === revisionId && t.eventKind === kind));
}

/** appendTimelineEntryHelper's reversible-chain rule (revisions-slice.ts): a
    new reversible entry flips every prior entry on the chapter to non-reversible. */
function appendTimelineEntry(
  timeline: Record<string, StoredTimelineEntry[]>,
  entry: StoredTimelineEntry,
): Record<string, StoredTimelineEntry[]> {
  const key = String(entry.chapterId);
  const prior = (timeline[key] ?? []).map((t) => (entry.reversible ? { ...t, reversible: false } : t));
  return { ...timeline, [key]: [...prior, entry] };
}

/** Spec §2 step 1. */
export async function beginRevisionOp(
  bookDir: string,
  chapters: readonly ChapterRef[],
  op: RevisionOpKind,
  revisionId: string,
): Promise<BeginResult> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    const entry = isDangerousKey(revisionId) ? undefined : file.pending.find((p) => p.id === revisionId);
    if (!entry) {
      return hasOutcome(file, op, revisionId) ? { kind: 'already-done', file } : { kind: 'not-found', file };
    }
    const chapter = chapters.find((c) => c.id === entry.chapterId);
    if (!chapter) {
      /* A restructure whose best-effort drop failed: clear the entry so the
         prompt stops looping, and answer not-found. */
      const next = await save(bookDir, { ...file, pending: file.pending.filter((p) => p.id !== revisionId) });
      return { kind: 'not-found', file: next };
    }
    return { kind: 'proceed', entry, chapter: { id: chapter.id, slug: chapter.slug }, file };
  });
}

/** Spec §2 step 3. Writes ONLY when the entry is still pending. */
export async function commitRevisionOp(
  bookDir: string,
  chapters: readonly ChapterRef[],
  op: RevisionOpKind,
  revisionId: string,
  selection?: Selection,
): Promise<CommitResult> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    const entry = isDangerousKey(revisionId) ? undefined : file.pending.find((p) => p.id === revisionId);
    if (!entry) {
      return hasOutcome(file, op, revisionId) ? { kind: 'already-done', file } : { kind: 'gone', file };
    }
    const timeline = appendTimelineEntry(file.timeline, {
      id: revisionId,
      chapterId: entry.chapterId,
      characterId: entry.characterId,
      eventKind: op === 'accept' ? 'accepted' : 'rejected',
      timestamp: new Date().toISOString(),
      status: 'active',
      reversible: true,
    });
    const acceptedSelections =
      op === 'accept' ? { ...file.acceptedSelections, [revisionId]: selection ?? {} } : file.acceptedSelections;
    const next = await save(bookDir, {
      ...file,
      pending: file.pending.filter((p) => p.id !== revisionId),
      timeline,
      acceptedSelections,
    });
    return { kind: 'committed', file: next };
  });
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/workspace/revisions-store.test.ts`
Expected: PASS.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 5: Mutation check.** In `commitRevisionOp`, replace `{ kind: 'gone', file }` with `{ kind: 'gone', file: await save(bookDir, file) }`, then run Step 4.
  - Expected red: `a reset while an op waits…`, because the on-disk `rev` is 1 instead of 0.
  - Also red: `upsert queued first…`, because `rev` is 3 instead of 2.

  Restore the line, confirm green, and confirm the diff-stat check.

- [ ] **Step 6: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/workspace/revisions-store.ts server/src/workspace/revisions-store.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server): add two-phase accept/reject ops to the revisions store (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 3 (2): Extract the A/B audio steps into `audio/previous-audio.ts`

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Create: `server/src/audio/previous-audio.ts`, `server/src/audio/previous-audio.test.ts`
- Modify `server/src/routes/chapter-audio.ts`. The file is unchanged on the new base, so these lines are verified:
  - the imports at `:31-42`;
  - the local `findPreviousChapterAudio` at `:232-237`, which gets removed;
  - the DELETE body at `:387-393`, from `const root = audioDir(located.bookDir);` through `res.status(204).end();`. The closing `},` and `);` that follow stay.
  - the restore body at `:416-439`, from `const root = audioDir(located.bookDir);` through `res.status(204).end();`. The closing `},` and `);` that follow stay.
- Test: `server/src/routes/chapter-audio.test.ts`. The existing tests stay unchanged, plus one new test.

**Dark-state note:** the old routes answer exactly as they do today, and this task adds no revisions.json write.

**Interfaces:**
- Consumes: `renameWithRetry` (`../workspace/atomic-rename.js`); `findChapterAudio`, `ChapterAudioFile` (`../workspace/chapter-audio-file.js`).
- Produces:
  ```ts
  export function findPreviousChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null;
  export async function acceptPreviousAudio(audioRoot: string, slug: string): Promise<'deleted' | 'none'>;
  export async function restorePreviousAudio(audioRoot: string, slug: string): Promise<'restored' | 'none'>; // throws on a failed audio rename
  ```

- [ ] **Step 1: Write the failing unit test** `server/src/audio/previous-audio.test.ts`

```ts
/* Plan 285 Task 3 — the A/B audio steps, moved unchanged from
   routes/chapter-audio.ts. These pin TODAY's behaviour, including the
   delete-then-rename residual filed as #3456. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { failRename } = vi.hoisted(() => ({ failRename: { value: false } }));
vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  return {
    ...real,
    renameWithRetry: async (src: string, dest: string) => {
      if (failRename.value && src.endsWith('.previous.mp3')) throw new Error('EBUSY: simulated');
      return real.renameWithRetry(src, dest);
    },
  };
});

import { acceptPreviousAudio, restorePreviousAudio, findPreviousChapterAudio } from './previous-audio.js';

const SLUG = '01-one';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'previous-audio-'));
  failRename.value = false;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const p = (name: string) => join(root, name);

describe('findPreviousChapterAudio', () => {
  it('returns null without a .previous.mp3, and the mp3 descriptor with one', () => {
    expect(findPreviousChapterAudio(root, SLUG)).toBeNull();
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    expect(findPreviousChapterAudio(root, SLUG)).toEqual({
      path: p(`${SLUG}.previous.mp3`),
      ext: 'mp3',
      mime: 'audio/mpeg',
      urlSuffix: 'audio.mp3',
    });
  });
});

describe('acceptPreviousAudio', () => {
  it("answers 'none' when nothing is preserved", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    expect(await acceptPreviousAudio(root, SLUG)).toBe('none');
    expect(existsSync(p(`${SLUG}.mp3`))).toBe(true);
  });

  it("deletes both .previous files, leaves live, answers 'deleted'", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{}');
    expect(await acceptPreviousAudio(root, SLUG)).toBe('deleted');
    expect(existsSync(p(`${SLUG}.previous.mp3`))).toBe(false);
    expect(existsSync(p(`${SLUG}.previous.segments.json`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('LIVE');
  });
});

describe('restorePreviousAudio', () => {
  it("answers 'none' and touches nothing when nothing is preserved", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    expect(await restorePreviousAudio(root, SLUG)).toBe('none');
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('LIVE');
  });

  it("promotes .previous over live (audio + segments) and answers 'restored'", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.segments.json`), '{"live":true}');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{"prev":true}');
    expect(await restorePreviousAudio(root, SLUG)).toBe('restored');
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('PREV');
    expect(JSON.parse(readFileSync(p(`${SLUG}.segments.json`), 'utf8'))).toEqual({ prev: true });
    expect(existsSync(p(`${SLUG}.previous.mp3`))).toBe(false);
  });

  it('today: a live .m4a is deleted and .previous comes back as .mp3', async () => {
    writeFileSync(p(`${SLUG}.m4a`), 'LIVE-M4A');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    expect(await restorePreviousAudio(root, SLUG)).toBe('restored');
    expect(existsSync(p(`${SLUG}.m4a`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('PREV');
  });

  it('today: a failed rename throws AFTER the live take was deleted; .previous stays intact', async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    failRename.value = true;
    await expect(restorePreviousAudio(root, SLUG)).rejects.toThrow(/simulated/);
    expect(existsSync(p(`${SLUG}.mp3`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.previous.mp3`), 'utf8')).toBe('PREV');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/previous-audio.test.ts`
Expected: FAIL with `Failed to load url ./previous-audio.js`.

- [ ] **Step 3: Create `server/src/audio/previous-audio.ts`.** The bodies move verbatim from `chapter-audio.ts:233-237`, `:389-393` and `:420-439`.

```ts
/* Plan 285 (#3400) — the A/B take audio steps, MOVED UNCHANGED from
   routes/chapter-audio.ts so the old routes (DELETE …/audio/previous,
   POST …/audio/previous/restore) and the new revision-ops routes run the same
   code. Behaviour is today's, residuals included (filed as #3456 "Chapter take
   lifecycle"): restore deletes the live take BEFORE the rename, swallows a
   failed segments rename, and `.previous` is always `.mp3`.

   No import of routes/generation.ts: the isGenerationActive 409 stays in the
   routes, in today's order. */

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findChapterAudio, type ChapterAudioFile } from '../workspace/chapter-audio-file.js';

/** Mirror of findChapterAudio but for the `.previous.mp3` sibling. */
export function findPreviousChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  const path = join(audioRoot, `${slug}.previous.mp3`);
  if (!existsSync(path)) return null;
  return { path, ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' };
}

/** ACCEPT — the new render wins. Deletes the .previous pair (unlink errors
    swallowed, as today). 'none' when nothing was preserved. */
export async function acceptPreviousAudio(audioRoot: string, slug: string): Promise<'deleted' | 'none'> {
  const previous = findPreviousChapterAudio(audioRoot, slug);
  if (!previous) return 'none';
  /* Delete both files — segments.json absence on its own isn't a fault. */
  await unlink(previous.path).catch(() => {});
  await unlink(join(audioRoot, `${slug}.previous.segments.json`)).catch(() => {});
  return 'deleted';
}

/** REJECT — the prior render wins. Promotes .previous over the live names.
    'none' when nothing was preserved; throws when the audio rename fails
    (callers answer today's fixed 500). */
export async function restorePreviousAudio(audioRoot: string, slug: string): Promise<'restored' | 'none'> {
  const previous = findPreviousChapterAudio(audioRoot, slug);
  if (!previous) return 'none';

  /* Delete the live render first so the previous → live rename doesn't
     race a still-present current file. */
  const currentLive = findChapterAudio(audioRoot, slug);
  if (currentLive) await unlink(currentLive.path).catch(() => {});
  const liveSegments = join(audioRoot, `${slug}.segments.json`);
  if (existsSync(liveSegments)) await unlink(liveSegments).catch(() => {});

  try {
    await renameWithRetry(previous.path, join(audioRoot, `${slug}.${previous.ext}`));
  } catch (err) {
    console.error(`[chapter-audio] failed to restore previous audio for ${slug}: ${(err as Error).message}`);
    throw err;
  }
  const previousSegments = join(audioRoot, `${slug}.previous.segments.json`);
  if (existsSync(previousSegments)) {
    await renameWithRetry(previousSegments, liveSegments).catch(() => {});
  }
  return 'restored';
}
```

- [ ] **Step 4: Run the unit test**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/previous-audio.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the new old-route test.** In `server/src/routes/chapter-audio.test.ts`, inside `describe('POST /audio/previous/restore (reject)', …)`, put it directly after `it('409s when a generation is in flight for the book', …)`:

```ts
      it('409s (not 404) for an INVALID chapter id while a generation is in flight — the busy check runs first', async () => {
        /* Plan 285 — pins today's ORDER: isGenerationActive is checked before
           the chapter-id parse, so the extraction into audio/previous-audio.ts
           must not move it. */
        vi.resetModules();
        vi.doMock('./generation.js', () => ({
          generationRouter: undefined,
          isGenerationActive: () => true,
        }));
        const { chapterAudioRouter: mockedRouter } = await import('./chapter-audio.js');
        const mockedApp = express();
        mockedApp.use('/api/books', mockedRouter);

        const res = await request(mockedApp).post(
          `/api/books/${bookId}/chapters/not-a-number/audio/previous/restore`,
        );
        expect(res.status).toBe(409);

        vi.doUnmock('./generation.js');
        vi.resetModules();
      });
```

- [ ] **Step 6: Run the chapter-audio suite.** This test has no red-first step: it pins today's order before the refactor, and its mutation is in Step 9.

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-audio.test.ts`
Expected: PASS.

- [ ] **Step 7: Refactor `server/src/routes/chapter-audio.ts`**

  1. Update the imports:
     - add `import { acceptPreviousAudio, restorePreviousAudio, findPreviousChapterAudio } from '../audio/previous-audio.js';`;
     - remove `import { unlink } from 'node:fs/promises';` (`:34`) and `import { renameWithRetry } from '../workspace/atomic-rename.js';` (`:38`);
     - remove `type ChapterAudioFile` from `:40` only if it becomes unreferenced (typecheck tells you);
     - keep `existsSync` and `join`.
  2. Delete the local `findPreviousChapterAudio` and its doc comment (`:232-237`).
  3. In the DELETE route, replace `:387-393` with the block below and leave the closing `},` and `);` in place:
     ```ts
         const root = audioDir(located.bookDir);
         const outcome = await acceptPreviousAudio(root, chapter.slug);
         if (outcome === 'none') return res.status(404).json({ message: 'No preserved previous audio.' });
         res.status(204).end();
     ```
  4. In the restore route, replace `:416-439` with the block below. Leave the `isGenerationActive` block at `:403-409` and the closing `},` and `);` in place:
     ```ts
         const root = audioDir(located.bookDir);
         let outcome: 'restored' | 'none';
         try {
           outcome = await restorePreviousAudio(root, chapter.slug);
         } catch {
           return res.status(500).json({ message: 'Failed to restore previous audio.' });
         }
         if (outcome === 'none') return res.status(404).json({ message: 'No preserved previous audio.' });
         res.status(204).end();
     ```

- [ ] **Step 8: Run both suites and typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-audio.test.ts src/audio/previous-audio.test.ts`
Expected: PASS.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 9: Mutation check.** In the restore route, move the `if (isGenerationActive(req.params.bookId)) { … }` block to after the `if (!chapter) return res.status(404)…` line, then run `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-audio.test.ts`.
  - Expected red: `409s (not 404) for an INVALID chapter id…`, with `expected 404 to be 409`.

  Restore the block, confirm green, and confirm the diff-stat check.

- [ ] **Step 10: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/audio/previous-audio.ts server/src/audio/previous-audio.test.ts server/src/routes/chapter-audio.ts server/src/routes/chapter-audio.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "refactor(server): extract previous-take audio steps into audio/previous-audio.ts (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 4 (3a): Accept / reject / dismiss routes

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Create: `server/src/routes/revision-ops.ts`, `server/src/routes/revision-ops.test.ts`
- Modify: `server/src/app.ts:64` (import) and `:312` (mount); `CLAUDE.md:629-632` (the `requestFailureMessage` count)

**Dark-state note:** these routes have no client caller in PR 1.

**Interfaces:**
- Consumes:
  - Tasks 1–2 (`../workspace/revisions-store.js`): `beginRevisionOp`, `commitRevisionOp`, `dismissDriftId`, `readRevisions`, `parseSelection`, `toRevisionsState`, `ChapterRef`;
  - Task 3 (`../audio/previous-audio.js`): `acceptPreviousAudio`, `restorePreviousAudio`, `findPreviousChapterAudio`;
  - `isGenerationActive` (`./generation.js`);
  - `requestFailureMessage` (`../workspace/file-lock.js`);
  - `findChapterAudio` (`../workspace/chapter-audio-file.js`).
- Produces: `export const revisionOpsRouter: Router`, mounted at `/api/books`.
  - Every coded failure returns `{ error: <code>, message: string, state?: RevisionsState }`. The codes:

    | Code | Status |
    | --- | --- |
    | `invalid_selection` | 400 |
    | `book_not_found` | 404 |
    | `revision_not_found` | 404 |
    | `chapter_busy` | 409 |
    | `no_previous_audio` | 409 |
    | `live_audio_missing` | 409 |
    | `revision_gone` | 409 |
    | `restore_failed` | 500, with no `state` |

  - Any other 500 returns `{ error: requestFailureMessage(e, …) }`.

- [ ] **Step 1: Write the failing route test** `server/src/routes/revision-ops.test.ts`

```ts
/* Plan 285 Task 4 — accept / reject / dismiss (spec §2). Tempdir workspace +
   supertest, like chapter-audio.test.ts. generation.js is mocked (only
   isGenerationActive is needed); atomic-rename.js is wrapped so a test can fail
   the .previous → live rename; the store's two lock-taking entry points are
   wrapped so a test can inject a lock timeout. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const { busy, failRestore } = vi.hoisted(() => ({ busy: { value: false }, failRestore: { value: false } }));

vi.mock('./generation.js', () => ({ isGenerationActive: () => busy.value }));
vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  return {
    ...real,
    renameWithRetry: async (src: string, dest: string) => {
      if (failRestore.value && src.endsWith('.previous.mp3')) throw new Error('EBUSY: simulated restore failure');
      return real.renameWithRetry(src, dest);
    },
  };
});
vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
  return {
    ...real,
    beginRevisionOp: vi.fn(real.beginRevisionOp),
    dismissDriftId: vi.fn(real.dismissDriftId),
  };
});

const AUTHOR = 'Revision Ops Author';
const SERIES = 'Standalones';
const TITLE = 'Revision Ops Book';
let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let revisionsPath: string;
let bookId: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'revision-ops-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { revisionOpsRouter } = await import('./revision-ops.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_revision_ops',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-one' },
        { id: 2, title: 'Chapter 2', slug: '02-two' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', revisionOpsRouter);
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  busy.value = false;
  failRestore.value = false;
  rmSync(audioRoot, { recursive: true, force: true });
  mkdirSync(audioRoot, { recursive: true });
  rmSync(revisionsPath, { force: true });
});

const FILE_ID = '000000000000001-aaaaaaaa';
function entry(chapterId: number, id: string) {
  return {
    id,
    chapterId,
    characterId: 'narrator',
    triggeredBy: 'Narrator voice change',
    playable: true,
    hasPreviousAudio: true,
    segments: [],
    origin: 'server',
  };
}
function seed(pending: unknown[]): void {
  writeFileSync(
    revisionsPath,
    JSON.stringify({ schema: 1, fileId: FILE_ID, rev: 3, pending, dismissed: [], acceptedSelections: {}, timeline: {} }),
  );
}
const disk = () => JSON.parse(readFileSync(revisionsPath, 'utf8'));
const live = (slug = '01-one') => join(audioRoot, `${slug}.mp3`);
const prev = (slug = '01-one') => join(audioRoot, `${slug}.previous.mp3`);
const accept = (id: string, body: object = {}) =>
  request(app).post(`/api/books/${bookId}/revisions/${encodeURIComponent(id)}/accept`).send(body);
const reject = (id: string) => request(app).post(`/api/books/${bookId}/revisions/${encodeURIComponent(id)}/reject`);

describe('POST …/revisions/:revisionId/accept', () => {
  it('deletes .previous, records the outcome, and answers the FULL RevisionsState', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const res = await accept('r1', { selection: { '0': 'B' } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['acceptedSelections', 'bookId', 'dismissed', 'fileId', 'pending', 'rev', 'timeline'],
    );
    expect(res.body).toMatchObject({ bookId, fileId: FILE_ID, rev: 4, pending: [] });
    expect(res.body.acceptedSelections).toEqual({ r1: { '0': 'B' } });
    expect(res.body.timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'accepted', reversible: true }]);
    expect(existsSync(prev())).toBe(false);
    expect(readFileSync(live(), 'utf8')).toBe('LIVE');
  });

  it('a retried accept answers 200 with the current state and writes nothing', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    await accept('r1');
    const again = await accept('r1');
    expect(again.status).toBe(200);
    expect(again.body.rev).toBe(4);
    expect(again.body.timeline['1']).toHaveLength(1);
  });

  it('two concurrent accepts for one id: both 200, exactly one timeline entry', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const [a, b] = await Promise.all([accept('r1'), accept('r1')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(disk().timeline['1']).toHaveLength(1);
  });

  it('404 revision_not_found for an unknown id, with the current state', async () => {
    seed([entry(1, 'r1')]);
    const res = await accept('nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'revision_not_found', state: { rev: 3 } });
  });

  it('404 for a prototype-polluting id, and nothing is written or polluted', async () => {
    seed([entry(1, 'r1')]);
    for (const id of ['__proto__', 'constructor']) {
      const res = await accept(id, { selection: { '0': 'A' } });
      expect(res.status).toBe(404);
    }
    expect(disk().rev).toBe(3);
    expect(({} as Record<string, unknown>)['0']).toBeUndefined();
  });

  it('400 invalid_selection for a malformed selection; nothing changes', async () => {
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const res = await accept('r1', { selection: { x: 'A' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_selection');
    expect(existsSync(prev())).toBe(true);
    expect(disk().rev).toBe(3);
  });

  it('404 book_not_found for an unknown book', async () => {
    const res = await request(app).post('/api/books/nope__nope__nope/revisions/r1/accept').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('book_not_found');
  });

  it('409 live_audio_missing when live is gone but .previous exists — nothing deleted, nothing written', async () => {
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const res = await accept('r1');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'live_audio_missing', state: { rev: 3 } });
    expect(readFileSync(prev(), 'utf8')).toBe('PREV');
    expect(disk().pending).toHaveLength(1);
  });

  it('proceeds and clears the entry when NEITHER live nor .previous exists', async () => {
    seed([entry(1, 'r1')]);
    const res = await accept('r1');
    expect(res.status).toBe(200);
    expect(res.body.pending).toEqual([]);
  });

  it('drops an entry whose chapter no longer exists and answers 404', async () => {
    seed([entry(9, 'r9')]);
    const res = await accept('r9');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('revision_not_found');
    expect(disk().pending).toEqual([]);
  });

  it('409 revision_gone when the entry was replaced between step 1 and step 3; nothing is written into its place', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const store = await import('../workspace/revisions-store.js');
    const real = await vi.importActual<typeof import('../workspace/revisions-store.js')>(
      '../workspace/revisions-store.js',
    );
    /* Interleave at the store: step 1 runs for real, then a newer render's
       upsert lands before the route's step 3. */
    vi.mocked(store.beginRevisionOp).mockImplementationOnce(async (dir, chapters, op, id) => {
      const begun = await real.beginRevisionOp(dir, chapters, op, id);
      await real.recordPending(dir, chapters, {
        ...entry(1, 'r-newer'),
        origin: 'server',
      } as Parameters<typeof real.recordPending>[2]);
      return begun;
    });
    const res = await accept('r1');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('revision_gone');
    expect(res.body.state.pending.map((p: { id: string }) => p.id)).toEqual(['r-newer']);
    expect(res.body.state.timeline).toEqual({});
    expect(disk().timeline).toEqual({});
  });

  it('a lock timeout answers the curated 500 — no lock-key path in the body', async () => {
    const store = await import('../workspace/revisions-store.js');
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    vi.mocked(store.beginRevisionOp).mockRejectedValueOnce(
      new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000),
    );
    seed([entry(1, 'r1')]);
    const res = await accept('r1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
  });
});

describe('POST …/revisions/:revisionId/reject', () => {
  it('restores .previous over live and records `rejected`', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const res = await reject('r1');
    expect(res.status).toBe(200);
    expect(readFileSync(live(), 'utf8')).toBe('PREV');
    expect(existsSync(prev())).toBe(false);
    expect(res.body.pending).toEqual([]);
    expect(res.body.timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'rejected' }]);
  });

  it('409 chapter_busy during generation; audio and JSON untouched', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    busy.value = true;
    const res = await reject('r1');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'chapter_busy', state: { rev: 3 } });
    expect(readFileSync(live(), 'utf8')).toBe('LIVE');
    expect(readFileSync(prev(), 'utf8')).toBe('PREV');
    expect(disk().rev).toBe(3);
  });

  it('409 no_previous_audio when nothing is preserved; JSON untouched', async () => {
    writeFileSync(live(), 'LIVE');
    seed([entry(1, 'r1')]);
    const res = await reject('r1');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_previous_audio');
    expect(disk().rev).toBe(3);
  });

  it('restore throws → 500 restore_failed; accept then refuses; a retried reject recovers', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    failRestore.value = true;
    const failed = await reject('r1');
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('restore_failed');
    expect(disk().rev).toBe(3);
    expect(existsSync(live())).toBe(false);
    expect(readFileSync(prev(), 'utf8')).toBe('PREV');

    const refused = await accept('r1');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('live_audio_missing');
    expect(readFileSync(prev(), 'utf8')).toBe('PREV');

    failRestore.value = false;
    const retried = await reject('r1');
    expect(retried.status).toBe(200);
    expect(readFileSync(live(), 'utf8')).toBe('PREV');
    expect(retried.body.timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'rejected' }]);
  });

  it('an `accepted` timeline entry is not a reject outcome: 404 after an accept', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    await accept('r1');
    const res = await reject('r1');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('revision_not_found');
  });

  it('a lock timeout answers the curated 500', async () => {
    const store = await import('../workspace/revisions-store.js');
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    vi.mocked(store.beginRevisionOp).mockRejectedValueOnce(
      new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000),
    );
    seed([entry(1, 'r1')]);
    const res = await reject('r1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
  });
});

describe('POST …/drift/:driftId/dismiss', () => {
  const dismiss = (id: string, book = bookId) =>
    request(app).post(`/api/books/${book}/drift/${encodeURIComponent(id)}/dismiss`);

  it('adds the id and answers the full state; a repeat writes nothing', async () => {
    seed([]);
    const first = await dismiss('drift:b:1:narrator:voice');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ bookId, rev: 4, dismissed: ['drift:b:1:narrator:voice'] });
    const again = await dismiss('drift:b:1:narrator:voice');
    expect(again.body.rev).toBe(4);
  });

  it('404 for an unknown book', async () => {
    const res = await dismiss('x', 'nope__nope__nope');
    expect(res.status).toBe(404);
  });

  it('a lock timeout answers the curated 500', async () => {
    const store = await import('../workspace/revisions-store.js');
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    vi.mocked(store.dismissDriftId).mockRejectedValueOnce(
      new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000),
    );
    const res = await dismiss('x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revision-ops.test.ts`
Expected: FAIL with `Failed to load url ./revision-ops.js`.

- [ ] **Step 3: Create `server/src/routes/revision-ops.ts`**

```ts
/* Plan 285 (#3400) — server-owned revisions operations (spec §2). One route per
   operation. Accept and reject run the audio step (today's code,
   audio/previous-audio.ts) and then the JSON write, in that order; the JSON is
   written only if the audio step succeeded.

   PR 1: no client calls these yet (the client cuts over in PR 2), so the
   client remains the only writer of `pending` on main. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { audioDir } from '../workspace/paths.js';
import { findBookByBookId } from '../workspace/scan.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { requestFailureMessage } from '../workspace/file-lock.js';
import {
  acceptPreviousAudio,
  findPreviousChapterAudio,
  restorePreviousAudio,
} from '../audio/previous-audio.js';
import {
  beginRevisionOp,
  commitRevisionOp,
  dismissDriftId,
  parseSelection,
  readRevisions,
  toRevisionsState,
  type ChapterRef,
} from '../workspace/revisions-store.js';
import { isGenerationActive } from './generation.js';

export const revisionOpsRouter = Router();

const NOT_FOUND_MESSAGE = 'This take was replaced by a newer render or is no longer pending.';
const GONE_MESSAGE = 'This take was resolved or replaced while the operation ran.';

revisionOpsRouter.post('/:bookId/revisions/:revisionId/accept', async (req: Request, res: Response) => {
  const { bookId, revisionId } = req.params;
  try {
    const parsed = parseSelection((req.body ?? {}).selection);
    if (!parsed.ok) return res.status(400).json({ error: 'invalid_selection', message: parsed.message });
    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'book_not_found', message: 'Book not found.' });
    const { bookDir, state } = located;
    const chapters: ChapterRef[] = state.chapters;

    /* Step 1 — under the lock. */
    const begin = await beginRevisionOp(bookDir, chapters, 'accept', revisionId);
    if (begin.kind === 'already-done') return res.json(toRevisionsState(bookId, begin.file));
    if (begin.kind === 'not-found') {
      return res
        .status(404)
        .json({ error: 'revision_not_found', message: NOT_FOUND_MESSAGE, state: toRevisionsState(bookId, begin.file) });
    }

    /* Step 2 — outside the lock. Refuse to delete the last copy: no live audio
       but a .previous still on disk (a failed restore or a failed finalize
       rename). The recovery is to retry Reject. Read-only pre-check; the audio
       code itself is unchanged. The body's state is a fresh lock-free read. */
    const root = audioDir(bookDir);
    if (!findChapterAudio(root, begin.chapter.slug) && findPreviousChapterAudio(root, begin.chapter.slug)) {
      const current = await readRevisions(bookDir, chapters);
      return res.status(409).json({
        error: 'live_audio_missing',
        message:
          "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it.",
        state: toRevisionsState(bookId, current),
      });
    }
    await acceptPreviousAudio(root, begin.chapter.slug); // 'deleted' and 'none' both proceed

    /* Step 3 — under the lock. */
    const commit = await commitRevisionOp(bookDir, chapters, 'accept', revisionId, parsed.value);
    if (commit.kind === 'gone') {
      return res
        .status(409)
        .json({ error: 'revision_gone', message: GONE_MESSAGE, state: toRevisionsState(bookId, commit.file) });
    }
    return res.json(toRevisionsState(bookId, commit.file));
  } catch (e) {
    console.error('[revision-ops] accept failed', e);
    /* Plan 285 — the store takes the per-book revisions lock, whose key embeds
       the absolute book path. Same curation as every whole-request site. */
    return res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to accept revision.') });
  }
});

revisionOpsRouter.post('/:bookId/revisions/:revisionId/reject', async (req: Request, res: Response) => {
  const { bookId, revisionId } = req.params;
  try {
    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'book_not_found', message: 'Book not found.' });
    const { bookDir, state } = located;
    const chapters: ChapterRef[] = state.chapters;

    const begin = await beginRevisionOp(bookDir, chapters, 'reject', revisionId);
    if (begin.kind === 'already-done') return res.json(toRevisionsState(bookId, begin.file));
    if (begin.kind === 'not-found') {
      return res
        .status(404)
        .json({ error: 'revision_not_found', message: NOT_FOUND_MESSAGE, state: toRevisionsState(bookId, begin.file) });
    }

    /* Step 2 — the same busy check today's restore route makes. */
    if (isGenerationActive(bookId)) {
      return res.status(409).json({
        error: 'chapter_busy',
        message: 'This chapter is busy — try again when it finishes.',
        state: toRevisionsState(bookId, begin.file),
      });
    }
    const root = audioDir(bookDir);
    let outcome: 'restored' | 'none';
    try {
      outcome = await restorePreviousAudio(root, begin.chapter.slug);
    } catch (err) {
      console.error('[revision-ops] reject: restore threw; revisions.json untouched', err);
      return res.status(500).json({ error: 'restore_failed', message: "Couldn't restore the original — try Reject again." });
    }
    if (outcome === 'none') {
      return res.status(409).json({
        error: 'no_previous_audio',
        message: 'Original audio not preserved.',
        state: toRevisionsState(bookId, begin.file),
      });
    }

    const commit = await commitRevisionOp(bookDir, chapters, 'reject', revisionId);
    if (commit.kind === 'gone') {
      console.warn(
        `[revision-ops] reject ${revisionId}: the restored take stands with no timeline record (entry gone before step 3; #3456)`,
      );
      return res
        .status(409)
        .json({ error: 'revision_gone', message: GONE_MESSAGE, state: toRevisionsState(bookId, commit.file) });
    }
    return res.json(toRevisionsState(bookId, commit.file));
  } catch (e) {
    console.error('[revision-ops] reject failed', e);
    return res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to reject revision.') });
  }
});

revisionOpsRouter.post('/:bookId/drift/:driftId/dismiss', async (req: Request, res: Response) => {
  const { bookId, driftId } = req.params;
  try {
    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'book_not_found', message: 'Book not found.' });
    const file = await dismissDriftId(located.bookDir, located.state.chapters, driftId);
    return res.json(toRevisionsState(bookId, file));
  } catch (e) {
    console.error('[revision-ops] dismiss failed', e);
    return res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to dismiss drift.') });
  }
});
```

- [ ] **Step 4: Run the route test**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revision-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount the router** in `server/src/app.ts`.

After line 64 (`import { revisionsRouter, revisionsBulkRouter } from './routes/revisions.js';`), add:

```ts
import { revisionOpsRouter } from './routes/revision-ops.js';
```

After line 312 (`app.use('/api', revisionsBulkRouter); …`), add:

```ts
app.use('/api/books', revisionOpsRouter); // plan 285 — server-owned accept / reject / dismiss (no client caller until PR 2)
```

- [ ] **Step 6: Update the CLAUDE.md count.** Verify the count first.

Run: `git -C C:/Claude/Projects/wt-3400-revisions-server-ops grep -n "requestFailureMessage(" -- "server/src/**/*.ts" ":!*.test.ts"`
Expected: 18 lines, which is the definition plus **17** call sites. That is 14 on the new base (book-state ×4, cast-design ×2, qwen-voice, script-review, single-design, voice-library ×3, voice-style, voices) plus revision-ops ×3.

In `CLAUDE.md`, replace
```
  and leaves every other body verbatim — `git grep requestFailureMessage`
  enumerates all thirteen sites (`book-state` ×4, `voice-library` ×3, `voices`,
  `qwen-voice`, `voice-style`, `single-design`, `script-review`, `cast-design`'s
  defensive outer), alongside the two merge routes' own explicit
```
with
```
  and leaves every other body verbatim — `git grep requestFailureMessage`
  enumerates all seventeen sites (`book-state` ×4, `voice-library` ×3,
  `revision-ops` ×3, `cast-design` ×2 (both arms of its defensive outer),
  `voices`, `qwen-voice`, `voice-style`, `single-design`, `script-review`),
  alongside the two merge routes' own explicit
```

- [ ] **Step 7: Typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 8: Mutation checks.** Report each red, restore after each, and confirm the diff-stat check.

  1. Delete the `if (!findChapterAudio(…) && findPreviousChapterAudio(…)) { … }` block. Run `…server run test -- src/routes/revision-ops.test.ts`.
     - Expected red: `409 live_audio_missing when live is gone but .previous exists` (`expected 200 to be 409`) and `restore throws → 500 restore_failed; accept then refuses…`.
  2. In the accept catch, replace `requestFailureMessage(e, (e as Error).message || 'Failed to accept revision.')` with `(e as Error).message`. Run the same file.
     - Expected red: the accept `a lock timeout answers the curated 500…`, because the body contains `SECRET-WORKSPACE`.
  3. In the accept route, replace the `if (commit.kind === 'gone') { return res.status(409)… }` block with `if (commit.kind === 'gone') return res.json(toRevisionsState(bookId, commit.file));`. Run the same file.
     - Expected red: `409 revision_gone when the entry was replaced between step 1 and step 3…`, with `expected 200 to be 409`.

- [ ] **Step 9: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/revision-ops.ts server/src/routes/revision-ops.test.ts server/src/app.ts CLAUDE.md
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server,docs): add revision accept/reject/dismiss routes (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 5 (3b): Poll reshape (`revisions.ts`), curated poll and qa-report 500s

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify `server/src/routes/revisions.ts` (re-anchored):
  - the header at `:1-14`;
  - the imports at `:18-19`;
  - delete `RevisionsPersisted` at `:34-43`;
  - `getRevisionsForBook`/`computeRevisionsForBook` at `:112-234`;
  - the single-route catch at `:242-245`;
  - the bulk map at `:270-273` and its catch at `:276-278`.
- Modify: `server/src/routes/qa-report.ts:44-47` (the GET catch).
- Modify: `server/src/routes/revisions.test.ts`:
  - the header comment at `:10-12`;
  - imports at `:17`;
  - the `beforeAll` dynamic imports at `:68-71`;
  - `:168-185`;
  - the `persisted pending echo` describe at `:539-586`.
- Modify: `server/src/routes/qa-report.test.ts`:
  - the `scan.js` mock at `:16-27`;
  - new tests.
- Modify (comment only, no code change): `src/store/revisions-slice.ts:308-311`. This task makes its claim that the poll carries no `dismissed`/`acceptedSelections` false.
- Modify: `CLAUDE.md` (the count, now 20).

**Dark-state note:** the old client's `applyPoll` and `applyBackgroundPoll` read only `drift` (`revisions-slice.ts:318-331`). A poll never writes.

**Interfaces:**
- Consumes (Task 1, `../workspace/revisions-store.js`): `readRevisions`, `toRevisionsState`, `RevisionsState`, `StoredRevision`. Also `requestFailureMessage` (`../workspace/file-lock.js`).
- Produces:
  ```ts
  export type RevisionsPoll = RevisionsState & { drift: DriftEvent[] };
  export async function computeRevisionsForBook(bookId: string, bookDir: string, state: BookStateJson): Promise<RevisionsPoll>;
  export async function getRevisionsForBook(bookId: string): Promise<RevisionsPoll | null>;
  ```
  - The bulk route returns exactly `{ pending, drift }` per book.

- [ ] **Step 1: Write the failing tests**

  0. In `server/src/routes/revisions.test.ts`, convert the `beforeAll` dynamic imports (`:68-71`) from `Promise.all` to sequential awaits **before** adding the async `vi.mock` below. This is the #2083 sweep's rule: a `Promise.all` of dynamic imports races an async `vi.mock` factory. See `book-state.reparse.test.ts:71-77` for the same conversion. Replace
     ```ts
       const [{ revisionsRouter, revisionsBulkRouter }, { makeBookId }] = await Promise.all([
         import('./revisions.js'),
         import('../workspace/paths.js'),
       ]);
     ```
     with
     ```ts
       /* Sequential, not `Promise.all` — this file carries a hoisted async-factory
          `vi.mock` (revisions-store.js, plan 285), which a `Promise.all` of dynamic
          imports races (#2083). */
       const { revisionsRouter, revisionsBulkRouter } = await import('./revisions.js');
       const { makeBookId } = await import('../workspace/paths.js');
     ```
     Also replace the header bullet (`:10-12`)
     ```
        - Persisted pending echo (#3376 part 1): revisions.json#pending is
          surfaced verbatim by both the single-book route and the bulk
          GET /api/revisions; a non-array value falls back to [].
     ```
     with
     ```
        - Pending read through the store (plan 285): revisions.json#pending is
          normalised by workspace/revisions-store.ts (stale legacy entries
          dropped) and surfaced by both the single-book route (whole
          RevisionsState + drift, even with an empty cast) and the bulk
          GET /api/revisions ({ pending, drift }); a non-array value falls back
          to []; a corrupt file 500s (raw parse error); a lock timeout 500s with the curated contention message.
     ```
  1. In `server/src/routes/revisions.test.ts`, change the vitest import to `import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';`. Then add this top-level mock after the imports:
     ```ts
     /* Plan 285 — passthrough spy on the store read so a test can inject a lock
        timeout and pin the curated 500. */
     vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
       const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
       return { ...real, readRevisions: vi.fn(real.readRevisions) };
     });
     ```
  2. After `interface CharacterSnapshot { … }`, add:
     ```ts
     /* Plan 285 — the poll now answers RevisionsState + drift. */
     const emptyPoll = () => ({
       bookId,
       fileId: null,
       rev: 0,
       pending: [],
       dismissed: [],
       acceptedSelections: {},
       timeline: {},
       drift: [],
     });
     ```
  3. At `:172` and `:184`, replace `expect(res.body).toEqual({ pending: [], drift: [] });` with `expect(res.body).toEqual(emptyPoll());`.
  4. Replace the whole `describe('GET /api/books/:bookId/revisions — persisted pending echo (#3376 part 1)', …)` block (`:539-586`) with:
     ```ts
     describe('GET /api/books/:bookId/revisions — pending read through the store (plan 285)', () => {
       const revisionsPath = () => join(bookDir, '.audiobook', 'revisions.json');
       const serverEntry = {
         id: 'revision:1:1000',
         chapterId: 1,
         characterId: 'eliza',
         playable: true,
         hasPreviousAudio: true,
         segments: [],
         origin: 'server',
       };
       /* A legacy entry on a chapter with no slug in state.json — normalisation
          drops it (no .previous can exist). */
       const staleLegacy = { id: 'rev-stale', chapterId: 2, characterId: 'x', segments: [] };
       const matchingCast = () =>
         seed({ snapshots: { eliza: { voiceId: 'v1' } }, cast: [{ id: 'eliza', voiceId: 'v1' }] });

       it('returns pending even when the cast is EMPTY (D8)', async () => {
         writeFileSync(revisionsPath(), JSON.stringify({ schema: 1, fileId: 'f-1', rev: 2, pending: [serverEntry] }));
         const res = await request(app).get(`/api/books/${bookId}/revisions`);
         expect(res.status).toBe(200);
         expect(res.body).toMatchObject({ bookId, fileId: 'f-1', rev: 2, pending: [serverEntry], drift: [] });
       });

       it('surfaces a legacy entry only while its .previous.mp3 exists', async () => {
         seed({ snapshots: { eliza: { voiceId: 'old' } }, cast: [{ id: 'eliza', voiceId: 'new' }] });
         const legacy = { id: 'rev-1', chapterId: 1, characterId: 'x', segments: [] };
         writeFileSync(revisionsPath(), JSON.stringify({ pending: [legacy] }));
         let res = await request(app).get(`/api/books/${bookId}/revisions`);
         expect(res.body.pending).toEqual([]);
         writeFileSync(join(audioRoot, '01-chapter-one.previous.mp3'), 'PREV');
         res = await request(app).get(`/api/books/${bookId}/revisions`);
         expect(res.body.pending).toEqual([{ ...legacy, playable: true, hasPreviousAudio: true }]);
         expect((res.body.drift as DriftEventOut[]).map((d) => d.factor)).toEqual(['voice']);
       });

       it('falls back to [] when persisted pending is not an array', async () => {
         matchingCast();
         writeFileSync(revisionsPath(), JSON.stringify({ pending: 'garbage' }));
         const res = await request(app).get(`/api/books/${bookId}/revisions`);
         expect(res.status).toBe(200);
         expect(res.body.pending).toEqual([]);
         expect(res.body.drift).toEqual([]);
       });

       it('a corrupt revisions.json answers 500, as on main', async () => {
         matchingCast();
         writeFileSync(revisionsPath(), '{"pending": [');
         const res = await request(app).get(`/api/books/${bookId}/revisions`);
         expect(res.status).toBe(500);
       });

       it('bulk GET /api/revisions answers exactly { pending, drift } per book, pending normalised', async () => {
         matchingCast();
         writeFileSync(
           revisionsPath(),
           JSON.stringify({ schema: 1, fileId: 'f-1', rev: 2, pending: [serverEntry, staleLegacy] }),
         );
         const res = await request(app).get(`/api/revisions?bookIds=${bookId}`);
         expect(res.status).toBe(200);
         expect(res.body.byBookId[bookId]).toEqual({ pending: [serverEntry], drift: [] });
       });

       it('a lock timeout under either poll answers the curated 500 (no lock-key path)', async () => {
         const store = await import('../workspace/revisions-store.js');
         const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
         const err = () => new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000);
         vi.mocked(store.readRevisions).mockRejectedValueOnce(err());
         const single = await request(app).get(`/api/books/${bookId}/revisions`);
         expect(single.status).toBe(500);
         expect(single.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
         vi.mocked(store.readRevisions).mockRejectedValueOnce(err());
         const bulk = await request(app).get(`/api/revisions?bookIds=${bookId}`);
         expect(bulk.status).toBe(500);
         expect(bulk.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
       });
     });
     ```
  5. In `server/src/routes/qa-report.test.ts`, extend the existing `scan.js` mock's `findBookByBookId` (`:16-27`) with a second trigger, just before `return actual.findBookByBookId(bookId);`:
     ```ts
           if (bookId === 'LOCK_TRIGGER') {
             const { LockAcquisitionTimeoutError } = await import('../workspace/file-lock.js');
             throw new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000);
           }
     ```
     Then, inside `describe('GET /api/books/:bookId/qa-report', …)`, add the tests below. Add `rmSync` to the `node:fs` import (`:6`) if it is missing.
     ```ts
       it('plan 285 — a lock timeout answers the curated 500 (no lock-key path)', async () => {
         const { LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
         const res = await request(app).get('/api/books/LOCK_TRIGGER/qa-report');
         expect(res.status).toBe(500);
         expect(res.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
         expect(res.text).not.toContain('SECRET-WORKSPACE');
       });

       it('plan 285 — configDrift is built from drift only; a pending revision never reaches it', async () => {
         const p = join(bookDir, '.audiobook', 'revisions.json');
         writeFileSync(
           p,
           JSON.stringify({
             schema: 1,
             fileId: 'f-1',
             rev: 1,
             pending: [
               { id: 'revision:1:1', chapterId: 1, characterId: 'n', severity: 'severe', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' },
             ],
           }),
         );
         const res = await request(app).get(`/api/books/${bookId}/qa-report`);
         rmSync(p, { force: true });
         expect(res.status).toBe(200);
         expect(res.body.configDrift).toEqual({ counts: { mild: 0, moderate: 0, severe: 0 }, events: [] });
       });
     ```

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revisions.test.ts src/routes/qa-report.test.ts`

  Expected FAIL. Each test below fails for the stated reason:
  - **The two `emptyPoll()` equalities.** Main has no `bookId`, `fileId` or `rev` fields.
  - **`returns pending even when the cast is EMPTY (D8)`.** With no cast, main returns `pending: []` early (`revisions.ts:132-135`).
  - **`surfaces a legacy entry only while its .previous.mp3 exists`.** Main echoes the legacy entry even with no `.previous`.
  - **`bulk GET … pending normalised`.** The cast is seeded, so main reaches its verbatim echo and returns `staleLegacy` too.
  - **Both lock-timeout tests.** Main returns the raw message containing `SECRET-WORKSPACE`. Also, main's `computeRevisionsForBook` does not call `readRevisions`, so the single/bulk poll test may instead see a 200.

  These pass both before and after the change (regression guards, each with a mutation in Step 4):
  - `a corrupt revisions.json answers 500` (main already reads the file once a cast exists);
  - `falls back to []…`;
  - the qa-report `configDrift` test.

- [ ] **Step 2: Reshape `server/src/routes/revisions.ts`**

  1. Replace the header comment (`:1-14`) with:
     ```ts
     /* GET /api/books/:bookId/revisions
        Reads each chapter's `<slug>.segments.json` and diffs the captured
        character snapshots against the current cast.json. Emits drift events
        for hard signals (voice / engine / gender / ageRange changed) and for
        meaningful tone deltas (warmth/pace/authority/emotion). Dismissed event
        ids are read from revisions.json and filtered out so a poll after a
        dismiss doesn't re-surface the same event.

        Plan 285 — revisions.json is read through workspace/revisions-store.ts
        (lock-free, normalised: legacy drift dropped, stale legacy pending
        dropped; a corrupt or newer-schema file throws → 500, as before). The
        single-book poll answers the whole RevisionsState plus live `drift`, and
        returns `pending` even when the cast is empty (D8). The drift detector
        never creates pending — the user still chooses. */
     ```
  2. Update the imports:
     - change `import { castJsonPath, revisionsJsonPath } from '../workspace/paths.js';` to `import { castJsonPath } from '../workspace/paths.js';`;
     - add `import { readRevisions, toRevisionsState, type RevisionsState, type StoredRevision } from '../workspace/revisions-store.js';`;
     - add `import { requestFailureMessage } from '../workspace/file-lock.js';`.
  3. Delete `interface RevisionsPersisted { … }`.
  4. Above `getRevisionsForBook`, add `/** Plan 285 — the single-book poll's shape: the store's RevisionsState plus live drift. */ export type RevisionsPoll = RevisionsState & { drift: DriftEvent[] };`. Change `getRevisionsForBook`'s return type to `Promise<RevisionsPoll | null>`.
  5. Replace the part of `computeRevisionsForBook` that runs from its signature down to the `return { pending: [], drift: [] };` block (`:125-135`, which ends with the `if` block's closing brace) with:
     ```ts
     export async function computeRevisionsForBook(
       bookId: string,
       bookDir: string,
       state: BookStateJson,
     ): Promise<RevisionsPoll> {
       const file = await readRevisions(bookDir, state.chapters);
       const base = toRevisionsState(bookId, file);
       const castFile = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
       const cast: CastCharacter[] = castFile?.characters ?? [];
       if (cast.length === 0) {
         // No cast confirmed yet — no drift to compute, but pending still surfaces (D8).
         return { ...base, drift: [] };
       }
     ```
     Then replace the six lines from `const persisted = await readJson<RevisionsPersisted>(…)` through `const pending = Array.isArray(…) …;`, including the `#3376 part 1` comment between them (`:148-153`), with:
     ```ts
       const dismissed = new Set(file.dismissed);
     ```
  6. Replace the final `return { pending, drift: filtered };` (`:234`) with `return { ...base, drift: filtered };`.
  7. In the single route's catch (`:244`), replace `res.status(500).json({ error: (e as Error).message || 'Failed to compute revisions.' });` with:
     ```ts
         /* Plan 285 — curated: a store failure may carry a lock-key path. */
         res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to compute revisions.') });
     ```
  8. In the bulk route, replace the `byBookId` declaration and loop (`:270-273`) with:
     ```ts
         const byBookId: Record<string, { pending: StoredRevision[]; drift: DriftEvent[] }> = {};
         for (const [id, result] of entries) {
           if (result) byBookId[id] = { pending: result.pending, drift: result.drift };
         }
     ```
     Then replace its catch body (`:277`) with:
     ```ts
         res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to compute bulk revisions.') });
     ```
  9. In `server/src/routes/qa-report.ts`:
     - add `import { requestFailureMessage } from '../workspace/file-lock.js';`;
     - replace the GET catch body (`:46`) with `res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to build QA report.') });`;
     - leave the resume-scoring catch at `:72` untouched.
  10. In `src/store/revisions-slice.ts`, edit the `applyPoll` comment (`:308-311`) and nothing else. After this task the comment is false, because the single-book poll now carries both fields. Replace
      ```
             was taken (#3376 round 2). Also DON'T touch dismissed or
             acceptedSelections — the server response (RevisionsResponse)
             doesn't include either, and overwriting with empty would lose state
             until the next disk hydrate.
      ```
      with
      ```
             was taken (#3376 round 2). Also DON'T touch dismissed or
             acceptedSelections. Since plan 285 the single-book poll does carry
             both (the bulk poll still doesn't), but until PR 2's cutover this
             slice still owns them: adopting the poll's copy would revert a
             local dismiss/accept still inside its persistence debounce.
      ```

- [ ] **Step 3: Update the CLAUDE.md count to the final number.**

  Run: `git -C C:/Claude/Projects/wt-3400-revisions-server-ops grep -n "requestFailureMessage(" -- "server/src/**/*.ts" ":!*.test.ts"`
  Expected: 21 lines, which is the definition plus **20** call sites. That is Task 4's 17 plus `revisions` ×2 and `qa-report` ×1.

  In `CLAUDE.md`, replace the text Task 4 wrote:
  ```
    enumerates all seventeen sites (`book-state` ×4, `voice-library` ×3,
    `revision-ops` ×3, `cast-design` ×2 (both arms of its defensive outer),
    `voices`, `qwen-voice`, `voice-style`, `single-design`, `script-review`),
  ```
  with
  ```
    enumerates all twenty sites (`book-state` ×4, `voice-library` ×3,
    `revision-ops` ×3, `cast-design` ×2 (both arms of its defensive outer),
    `revisions` ×2 (the single-book and bulk polls), `qa-report`, `voices`,
    `qwen-voice`, `voice-style`, `single-design`, `script-review`),
  ```

- [ ] **Step 4: Run the suites and typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revisions.test.ts src/routes/qa-report.test.ts src/routes/revision-ops.test.ts`
Expected: PASS.

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 5: Mutation checks.** Report each red, restore after each, and confirm the diff-stat check.

  1. Change the empty-cast branch to `return { ...base, pending: [], drift: [] };`. Run `…server run test -- src/routes/revisions.test.ts`.
     - Expected red: `returns pending even when the cast is EMPTY (D8)`.
  2. Change the bulk `byBookId[id] = { pending: result.pending, drift: result.drift };` to `byBookId[id] = result;`. Run the same file.
     - Expected red: the bulk test. `toEqual` sees the extra `bookId`/`fileId`/`rev`/… keys.
  3. Change `const file = await readRevisions(bookDir, state.chapters);` to `const file = await readRevisions(bookDir, state.chapters).catch(() => emptyRevisionsFile());`, importing `emptyRevisionsFile`. Run the same file.
     - Expected red: `a corrupt revisions.json answers 500, as on main`, because it returns 200.
  4. In `qa-report.ts:33`, change `const drift = revisions.drift;` to `const drift = revisions.pending as unknown as typeof revisions.drift;`. Run `…server run test -- src/routes/qa-report.test.ts`.
     - Expected red: `configDrift is built from drift only…`, with `counts.severe` at 1.
  5. In `qa-report.ts`'s GET catch, revert to `(e as Error).message || 'Failed to build QA report.'`. Run the same file.
     - Expected red: `a lock timeout answers the curated 500`.

- [ ] **Step 6: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/revisions.ts server/src/routes/revisions.test.ts server/src/routes/qa-report.ts server/src/routes/qa-report.test.ts src/store/revisions-slice.ts CLAUDE.md
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server,frontend,docs): polls read revisions through the store; curate their 500s (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 6 (4): OpenAPI for the PR-1 surface and generated types

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify `openapi.yaml`, re-anchored on the new base:
  - the generation request body: the `force:` property at `:1789-1791`, with responses below it;
  - the splice inline schema: `hasPreviousAudio` at `:1858`;
  - the qa-repair inline schema: `hasPreviousAudio` at `:1954`;
  - a new block after the `/api/books/{bookId}/revisions:` path, which ends at `:2831`;
  - the bulk description at `:2837-2841`;
  - `GenerationTick` at `:5773`, with `audioQa` at `:5906`;
  - `QueueEntry` at `:5978`, with `fallbackConfirmed` at `:6038`;
  - `QueueEnqueueEntry` at `:6096`, with `fallbackConfirmed` at `:6125`;
  - `RevisionsResponse` at `:6845` and `BulkRevisionsResponse` at `:6862`;
  - `Revision` at `:6922`, with `hasPreviousAudio` at `:6942`;
  - `BookStateResponse.revisions` at `:8088`.
- Regenerate: `src/lib/api-types.ts`.
- Modify: `src/lib/api.ts`, at `SpliceTick` (`:647`, `splice_complete` arm at `:657`) and `QaRepairTick` (`:689`, `qa_repair_complete` arm at `:701`).
- Modify: `src/lib/types.ts:80`.
- Create: `src/lib/api-types.revisions-contract.test.ts`.

**Dark-state note:** this task changes types only.

**Interfaces:**
- Consumes: the server shapes from Tasks 1–5. `RevisionsState` must match the server interface field for field.
- Produces:
  - **New schemas:** `components['schemas']['RevisionsState']`, `['RevisionOpError']`, `['ReviewRequest']`.
  - **New client type:** `export type ReviewRequest = components['schemas']['ReviewRequest']` in `src/lib/types.ts`.
  - **New optional fields:**
    - `GenerationTick.reviewChapter` and `reviewRecorded`;
    - `QueueEntry.review` and `QueueEnqueueEntry.review`;
    - `Revision.origin`;
    - `RevisionsResponse.bookId`, `fileId`, `rev`, `dismissed` and `acceptedSelections`;
    - `reviewRecorded` on the `splice_complete` and `qa_repair_complete` ticks.

- [ ] **Step 1: Write the failing contract test** `src/lib/api-types.revisions-contract.test.ts`

```ts
/* Plan 285 Task 6 — the PR-1 revisions contract, pinned against the GENERATED
   types. Compile-time assertions: they fail under `npm run typecheck`. The
   runtime `expect`s exist so vitest also reports each case. */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { components, paths } from './api-types';
import type { SpliceTick, QaRepairTick } from './api';
import type { ReviewRequest } from './types';

type S = components['schemas'];
type RevisionsState = S['RevisionsState'];
type Ok<P extends keyof paths> = paths[P] extends { post: { responses: { 200: { content: { 'application/json': infer B } } } } }
  ? B
  : never;

describe('openapi: plan 285 PR 1', () => {
  it('accept / reject / dismiss each answer a full RevisionsState', () => {
    expectTypeOf<Ok<'/api/books/{bookId}/revisions/{revisionId}/accept'>>().toEqualTypeOf<RevisionsState>();
    expectTypeOf<Ok<'/api/books/{bookId}/revisions/{revisionId}/reject'>>().toEqualTypeOf<RevisionsState>();
    expectTypeOf<Ok<'/api/books/{bookId}/drift/{driftId}/dismiss'>>().toEqualTypeOf<RevisionsState>();
  });

  it('RevisionsState is fully required, fileId nullable', () => {
    expectTypeOf<RevisionsState['fileId']>().toEqualTypeOf<string | null>();
    expectTypeOf<RevisionsState['rev']>().toEqualTypeOf<number>();
    const s: RevisionsState = {
      bookId: 'b',
      fileId: null,
      rev: 0,
      pending: [],
      dismissed: [],
      acceptedSelections: {},
      timeline: {},
    };
    expect(s.rev).toBe(0);
  });

  it('every field added to an EXISTING schema is optional (PR 1 mocks return partial shapes)', () => {
    const poll: S['RevisionsResponse'] = {};
    const tick: S['GenerationTick'] = { type: 'idle' };
    const rev: S['Revision'] = { id: 'r', chapterId: 1, characterId: 'c', segments: [] };
    const q: S['QueueEntry'] = {
      id: 'e',
      bookId: 'b',
      chapterId: 1,
      scope: 'this',
      addedAt: '2026-10-02T00:00:00.000Z',
      status: 'queued',
      order: 0,
    };
    expect([poll, tick, rev, q]).toHaveLength(4);
    expectTypeOf<S['RevisionsResponse']['fileId']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<S['GenerationTick']['reviewChapter']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<S['GenerationTick']['reviewRecorded']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<S['Revision']['origin']>().toEqualTypeOf<'server' | undefined>();
    expectTypeOf<S['QueueEntry']['review']>().toEqualTypeOf<ReviewRequest | undefined>();
    expectTypeOf<S['QueueEnqueueEntry']['review']>().toEqualTypeOf<ReviewRequest | undefined>();
  });

  it('ReviewRequest is { characterId, triggeredBy }', () => {
    expectTypeOf<ReviewRequest>().toEqualTypeOf<{ characterId: string; triggeredBy: string }>();
  });

  it('the hand-written splice / qa-repair completion ticks carry an optional reviewRecorded', () => {
    expectTypeOf<Extract<SpliceTick, { type: 'splice_complete' }>['reviewRecorded']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<Extract<QaRepairTick, { type: 'qa_repair_complete' }>['reviewRecorded']>().toEqualTypeOf<
      boolean | undefined
    >();
  });
});
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`
Expected: FAIL. The errors include `Property 'RevisionsState' does not exist`, `has no exported member 'ReviewRequest'` and `Property 'reviewRecorded' does not exist`.

- [ ] **Step 3: Edit `openapi.yaml`.** Find each anchor by its quoted text.

  (a) Generation request body. After the `force:` property and its `description:` (`:1789-1791`), add:
  ```yaml
                review:
                  allOf:
                    - $ref: '#/components/schemas/ReviewRequest'
                  description: |
                    Plan 285 — present only on a single-chapter A/B review render.
                    A request carrying `review` that does not name exactly one
                    chapter gets a 400 before any SSE header is sent. The chapter
                    actually rendered with it gets `reviewChapter: true` on its
                    `chapter_complete` (never a replayed done chapter). Not sent
                    by the client until PR 2.
  ```
  Add a `'400'` response next to this path's `'200'`:
  ```yaml
        '400':
          description: '`review` is malformed (`invalid_review`) or does not name exactly one chapter (`review_requires_single_chapter`).'
          content:
            application/json:
              schema:
                type: object
                properties:
                  error: { type: string }
                  message: { type: string }
  ```

  (b) Splice and QA-repair inline schemas. After the `hasPreviousAudio: { type: boolean }` lines at `:1858` (splice) and `:1954` (qa-repair), add:
  ```yaml
                  reviewRecorded:
                    type: boolean
                    description: Plan 285 — on the completion frame only when finalize was asked to record A/B review state; false when that record failed (the new take is still live).
  ```

  (c) New paths. After the `/api/books/{bookId}/revisions:` path block, which ends just before `/api/revisions:` at `:2833`, insert the following with two-space indentation like its siblings:
  ```yaml
  /api/books/{bookId}/revisions/{revisionId}/accept:
    post:
      summary: Accept a pending A/B revision — keep the new take (plan 285)
      operationId: acceptRevision
      description: |
        One request runs the audio step (delete the chapter's `.previous.*`
        pair — today's code) and then records the outcome in revisions.json
        under the per-book revisions lock; the JSON is written only after the
        audio step. Idempotent on the revision id. Refuses with 409
        `live_audio_missing` when the chapter has no live audio but still has a
        `.previous` take (accepting would delete the only copy — retry Reject).
        No client caller until PR 2.
      parameters:
        - { in: path, name: bookId, required: true, schema: { type: string } }
        - { in: path, name: revisionId, required: true, schema: { type: string } }
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                selection:
                  type: object
                  description: segmentIndex (a canonical non-negative integer key) → 'A' | 'B'.
                  additionalProperties: { type: string, enum: [A, B] }
      responses:
        '200':
          description: Accepted (or already accepted).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionsState' }
        '400':
          description: '`invalid_selection`.'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }
        '404':
          description: '`book_not_found` or `revision_not_found`.'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }
        '409':
          description: '`live_audio_missing` or `revision_gone`; the body carries the current state.'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }
        '500':
          description: Unexpected failure (a lock-acquisition timeout carries the curated contention message).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }

  /api/books/{bookId}/revisions/{revisionId}/reject:
    post:
      summary: Reject a pending A/B revision — restore the earlier take (plan 285)
      operationId: rejectRevision
      description: |
        One request runs the audio step (promote `.previous.*` over the live
        names — today's code) and then records the outcome. The JSON is
        untouched when the request is refused as busy, finds no `.previous`, or
        the audio step throws. No client caller until PR 2.
      parameters:
        - { in: path, name: bookId, required: true, schema: { type: string } }
        - { in: path, name: revisionId, required: true, schema: { type: string } }
      responses:
        '200':
          description: Rejected (or already rejected).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionsState' }
        '404':
          description: '`book_not_found` or `revision_not_found`.'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }
        '409':
          description: '`chapter_busy`, `no_previous_audio` or `revision_gone`; the body carries the current state.'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }
        '500':
          description: '`restore_failed` (the audio step threw — retry Reject), or an unexpected failure.'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }

  /api/books/{bookId}/drift/{driftId}/dismiss:
    post:
      summary: Dismiss a drift event (plan 285)
      operationId: dismissDrift
      description: Adds the id to revisions.json's `dismissed`. Idempotent; touches no audio. No client caller until PR 2.
      parameters:
        - { in: path, name: bookId, required: true, schema: { type: string } }
        - { in: path, name: driftId, required: true, schema: { type: string } }
      responses:
        '200':
          description: The full revisions state after the dismiss.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionsState' }
        '404':
          description: '`book_not_found`.'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }
        '500':
          description: Unexpected failure (a lock-acquisition timeout carries the curated contention message).
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RevisionOpError' }

  ```

  (d) Bulk route description (`:2837-2841`). Append the sentence `Plan 285 — each value carries exactly \`pending\` (read through the server store, normalised) and \`drift\`.`

  (e) `GenerationTick`. Insert after the **whole** `audioQa:` property block (`:5906-5912`: the `audioQa:` key, its `allOf`/`$ref`, and its three-line `description` ending "…without a state.json reload."), so the new keys land just before `errorReason: { type: string, nullable: true }`. Do not insert directly after the `audioQa:` key line. Add:
  ```yaml
        reviewChapter:
          type: boolean
          description: |
            Plan 285 — only on a live `chapter_complete` for the chapter actually
            rendered with a request `review` (never on a replayed done chapter).
        reviewRecorded:
          type: boolean
          description: |
            Plan 285 — only on `chapter_complete` when finalize was asked to
            record A/B review state; false when that record failed (the new take
            is still live).
  ```

  (f) `QueueEntry` and `QueueEnqueueEntry`. After each `fallbackConfirmed:` property block (`:6038`, `:6125`), add:
  ```yaml
        review:
          allOf:
            - $ref: '#/components/schemas/ReviewRequest'
          description: Plan 285 — the A/B review intent carried from enqueue to the generation request. Not set by the client until PR 2.
  ```

  (g) `RevisionsResponse` (`:6845`). After `timeline`, add:
  ```yaml
        bookId: { type: string }
        fileId:
          type: string
          nullable: true
          description: Plan 285 — see RevisionsState.fileId. Optional here; the bulk values omit it.
        rev: { type: integer, minimum: 0 }
        dismissed:
          type: array
          items: { type: string }
        acceptedSelections:
          type: object
          additionalProperties:
            type: object
            additionalProperties: { type: string, enum: [A, B] }
  ```
  Replace `BulkRevisionsResponse`'s description with:
  ```yaml
      description: |
        Response of `GET /api/revisions?bookIds=...` (plan 83). Each value is
        `{ pending, drift }` for that book — pending read through the server
        store (plan 285, normalised) — and bookIds that don't exist on disk are
        simply omitted from the map. The single-book `GET /:bookId/revisions`
        additionally returns the whole RevisionsState.
  ```

  (h) `Revision`. After its `hasPreviousAudio:` property block (`:6942`), add:
  ```yaml
        origin:
          type: string
          enum: [server]
          description: Plan 285 — present on entries the server recorded; absent on legacy client-written ones.
  ```

  (i) New component schemas. After `Revision`, add three:
  ```yaml
    RevisionsState:
      type: object
      description: |
        Plan 285 — a book's revisions.json as the server store holds it,
        answered by every revisions operation. `fileId` changes on every reset
        (reparse / manuscript replace) and is null only for a legacy file the
        store has never written; `rev` increments on every write within one
        `fileId`.
      required: [bookId, fileId, rev, pending, dismissed, acceptedSelections, timeline]
      properties:
        bookId: { type: string }
        fileId:
          type: string
          nullable: true
          description: '`${epochMs zero-padded to 15 digits}-${random}`.'
        rev: { type: integer, minimum: 0 }
        pending:
          type: array
          items: { $ref: '#/components/schemas/Revision' }
        dismissed:
          type: array
          items: { type: string }
        acceptedSelections:
          type: object
          additionalProperties:
            type: object
            additionalProperties: { type: string, enum: [A, B] }
        timeline:
          type: object
          additionalProperties:
            type: array
            items: { $ref: '#/components/schemas/TimelineEntry' }

    RevisionOpError:
      type: object
      required: [error]
      properties:
        error:
          type: string
          description: |
            A machine-readable code — `invalid_selection`, `book_not_found`,
            `revision_not_found`, `chapter_busy`, `no_previous_audio`,
            `live_audio_missing`, `revision_gone`, `restore_failed` — or, on an
            unexpected 500, the curated failure message.
        message: { type: string }
        state: { $ref: '#/components/schemas/RevisionsState' }

    ReviewRequest:
      type: object
      required: [characterId, triggeredBy]
      properties:
        characterId: { type: string }
        triggeredBy: { type: string }
  ```

  (j) `BookStateResponse.revisions` (`:8088`). After `acceptedSelections`, add:
  ```yaml
            timeline:
              type: object
              additionalProperties:
                type: array
                items: { $ref: '#/components/schemas/TimelineEntry' }
            fileId:
              type: string
              nullable: true
              description: Plan 285 — absent on a legacy file (PR 1 returns revisions.json raw).
            rev: { type: integer }
  ```

- [ ] **Step 4: Regenerate the types.** Run `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run openapi:types` and expect exit 0. Then run `git -C C:/Claude/Projects/wt-3400-revisions-server-ops diff --stat src/lib/api-types.ts`. The diff should contain only additions and the edited descriptions. If unrelated regions were reformatted, stop and report it.

- [ ] **Step 5: Hand-written types**
  1. `src/lib/types.ts`: after line 80 (`export type BulkRevisionsResponse = …`), add:
     ```ts
     /** Plan 285 — the A/B review intent a queue entry / generation request carries. */
     export type ReviewRequest = components['schemas']['ReviewRequest'];
     ```
  2. `src/lib/api.ts`: in `SpliceTick`'s `splice_complete` arm, add this after `hasPreviousAudio: boolean;`:
     ```ts
           /** Plan 285 — present only when finalize recorded (or failed to record) A/B review state. */
           reviewRecorded?: boolean;
     ```
  3. `src/lib/api.ts`: in `QaRepairTick`'s `qa_repair_complete` arm, add the same member and comment after `durationSec?: number;`. That arm has no `hasPreviousAudio`.

- [ ] **Step 6: Typecheck and contract test**

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`
  Expected: exit 0.

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test -- src/lib/api-types.revisions-contract.test.ts`
  Expected: PASS.

- [ ] **Step 7: Mutation check.**
  1. Delete the `reviewRecorded:` property you added to `GenerationTick` in `openapi.yaml`.
  2. Run `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run openapi:types`, then `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`.
  3. Expected red: a TypeScript error in `api-types.revisions-contract.test.ts` on the `GenerationTick['reviewRecorded']` assertion.
  4. Restore the property, regenerate, confirm green, and confirm the diff-stat check.

- [ ] **Step 8: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add openapi.yaml src/lib/api-types.ts src/lib/api.ts src/lib/types.ts src/lib/api-types.revisions-contract.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(openapi,frontend): describe server-owned revisions routes and review fields (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 7 (5a): Finalize `review` tri-state

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify `server/src/audio/finalize-chapter-write.ts`. It was re-anchored after #3362 rewrote this file:
  - imports at `:14-50`;
  - `FinalizeChapterAudioInput`: its last member is `reembeddedRows?: EmbeddingRow[];` at `:158`, and the interface closes at `:159`;
  - `FinalizeChapterAudioResult` at `:161-172`, whose last member is `audioEngines: AudioEngineBreakdown;` at `:171`;
  - `await preserveExistingAsPrevious(audioRoot, chapter.slug);` at `:704`;
  - `await rename(tmpAudio, audioPath);` at `:706`;
  - `const prev = await readJson<BookStateJson>(statePath);` at `:716`;
  - `writeStateJsonAtomic` at `:739`;
  - the return at `:742-748`, with the function closing at `:749`.
- Modify: `CLAUDE.md:603-609` (the deliberate-swallow list).
- Test: `server/src/audio/finalize-chapter-write.test.ts`. On the new base it is 764 lines. `baseInput()` (`:93-114`) already passes `castIdHistory` and `resynthesizedIndices: 'all'`, and the fixture's chapter `duration` is `'0:00'` (`:81`).

**Dark-state note:** no caller passes `review`.

**Interfaces:**
- Consumes (Task 1, `../workspace/revisions-store.js`): `recordPending`, `dropPendingForChapter`, `ChapterRef`. `formatDuration` is already imported at `:21`.
- Produces:
  ```ts
  // FinalizeChapterAudioInput
  review?: { characterId: string; triggeredBy: string } | null;
  // FinalizeChapterAudioResult
  reviewRecorded?: boolean; // absent when review is undefined; true on a successful record/drop; false on a store failure
  ```

- [ ] **Step 1: Write the failing tests.** Add `import { formatDuration } from './format-duration.js';` to the test file's imports, then append this at the end of the file:

```ts
describe('finalizeChapterAudioWrite review tri-state (plan 285)', () => {
  const revisionsPath = () => join(bookDir, '.audiobook', 'revisions.json');
  const readPending = () =>
    existsSync(revisionsPath()) ? JSON.parse(readFileSync(revisionsPath(), 'utf8')).pending : undefined;
  const REVIEW = { characterId: 'amy', triggeredBy: 'Amy voice change' };
  const seedEntry = (chapterId: number, id: string) =>
    writeFileSync(
      revisionsPath(),
      JSON.stringify({
        schema: 1,
        fileId: '000000000000001-aaaaaaaa',
        rev: 1,
        pending: [
          { id, chapterId, characterId: 'amy', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' },
        ],
      }),
    );
  const writePriorTake = () => writeFileSync(join(audioRoot, `${SLUG}.mp3`), 'PRIOR-TAKE');

  afterEach(() => {
    vi.doUnmock('../workspace/revisions-store.js');
    vi.resetModules();
  });

  it('undefined: leaves revisions.json alone and the result carries no reviewRecorded', async () => {
    writePriorTake();
    const result = await finalizeChapterAudioWrite(baseInput());
    expect(existsSync(revisionsPath())).toBe(false);
    expect('reviewRecorded' in result).toBe(false);
  });

  it('object + preserved: upserts one server entry for the chapter', async () => {
    writePriorTake();
    const result = await finalizeChapterAudioWrite({ ...baseInput(), review: REVIEW });
    expect(result.reviewRecorded).toBe(true);
    const pending = readPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      chapterId: 1,
      characterId: 'amy',
      triggeredBy: 'Amy voice change',
      oldDuration: '0:00',
      newDuration: formatDuration(1.0),
      playable: true,
      hasPreviousAudio: true,
      origin: 'server',
      segments: [],
    });
    expect(pending[0].id).toMatch(/^revision:1:\d+$/);
  });

  it('object + first render (nothing preserved): drops any stale entry, records nothing', async () => {
    seedEntry(1, 'revision:1:500');
    const result = await finalizeChapterAudioWrite({ ...baseInput(), review: REVIEW });
    expect(result.reviewRecorded).toBe(true);
    expect(readPending()).toEqual([]);
  });

  it("null: drops the chapter's entry even when the prior take was preserved", async () => {
    writePriorTake();
    seedEntry(1, 'revision:1:500');
    const result = await finalizeChapterAudioWrite({ ...baseInput(), review: null });
    expect(result.reviewRecorded).toBe(true);
    expect(readPending()).toEqual([]);
  });

  it('runs the store call AFTER the audio rename and the state.json write', async () => {
    writePriorTake();
    const seen: { duration?: string; audioExists?: boolean } = {};
    vi.resetModules();
    vi.doMock('../workspace/revisions-store.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
      return {
        ...real,
        recordPending: async (...args: Parameters<typeof real.recordPending>) => {
          const st = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
          seen.duration = st.chapters[0].duration;
          seen.audioExists = existsSync(join(audioRoot, `${SLUG}.mp3`));
          return real.recordPending(...args);
        },
      };
    });
    const { finalizeChapterAudioWrite: finalizeMocked } = await import('./finalize-chapter-write.js');
    await finalizeMocked({ ...baseInput(), review: REVIEW });
    // The fixture duration is '0:00'; the stamped one is formatDuration(1.0) === '00:01'.
    expect(seen).toEqual({ duration: '00:01', audioExists: true });
  });

  it('a store failure → reviewRecorded:false; the take still lands; no store text in the result', async () => {
    writePriorTake();
    vi.resetModules();
    vi.doMock('../workspace/revisions-store.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
      const { LockAcquisitionTimeoutError } = await import('../workspace/file-lock.js');
      return {
        ...real,
        recordPending: async () => {
          throw new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000);
        },
      };
    });
    const { finalizeChapterAudioWrite: finalizeMocked } = await import('./finalize-chapter-write.js');
    const result = await finalizeMocked({ ...baseInput(), review: REVIEW });
    expect(result.reviewRecorded).toBe(false);
    expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET-WORKSPACE');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/finalize-chapter-write.test.ts`
  Expected: FAIL. `object + preserved` fails with `expected undefined to be true`, and the other review cases fail too. The `undefined` case passes; its mutation is in Step 5.

- [ ] **Step 3: Implement in `server/src/audio/finalize-chapter-write.ts`**

  1. Add the import `import { recordPending, dropPendingForChapter, type ChapterRef } from '../workspace/revisions-store.js';`.
  2. In `FinalizeChapterAudioInput`, after `reembeddedRows?: EmbeddingRow[];` (`:158`) and before the closing `}`, add:
     ```ts
       /** Plan 285 (#3400) — the A/B review intent for this render.
           `undefined` (PR 1: every caller) — leave revisions.json alone.
           `null` — a plain render: drop the chapter's pending entry (its A side was just overwritten).
           object — a review render: upsert the chapter's single entry iff
           preserveExistingAsPrevious actually preserved; otherwise (a first
           render) drop any entry. Best-effort: never fails the render. */
       review?: { characterId: string; triggeredBy: string } | null;
     ```
  3. In `FinalizeChapterAudioResult`, after `audioEngines: AudioEngineBreakdown;` (`:171`), add:
     ```ts
       /** Plan 285 — absent when `review` was undefined; true when the record/drop
           landed; false when it failed (logged in full; the new take is live). */
       reviewRecorded?: boolean;
     ```
  4. At `:704`, change `await preserveExistingAsPrevious(audioRoot, chapter.slug);` to `const preserve = await preserveExistingAsPrevious(audioRoot, chapter.slug);`.
  5. Replace the final `return { … };` (`:742-748`) and the function's closing `}` (`:749`) with:
     ```ts
       /* Plan 285 — AFTER the last disk write (audio rename, peaks, state.json):
          a throw earlier in finalize therefore never leaves an entry for a
          half-written take. */
       const reviewRecorded = await applyReview(input, preserve.preserved, prev);

       return {
         durationSec,
         audioQa,
         segmentCount: segments.length,
         audioModelKey: effectiveModelKey,
         audioEngines,
         ...(reviewRecorded === undefined ? {} : { reviewRecorded }),
       };
     }

     /** Plan 285 — best-effort with respect to the render, and a DELIBERATE
         swallow of LockAcquisitionTimeoutError (CLAUDE.md's swallow list): the
         take already landed, so an error is logged in full and surfaces ONLY as
         `false` — no store text (whose lock key embeds the absolute workspace
         path) may reach an SSE body. */
     async function applyReview(
       input: FinalizeChapterAudioInput,
       preserved: boolean,
       prev: BookStateJson | null,
     ): Promise<boolean | undefined> {
       if (input.review === undefined) return undefined;
       const { bookDir, chapter } = input;
       const chapters: ChapterRef[] = prev?.chapters ?? [{ id: chapter.id, slug: chapter.slug }];
       try {
         if (input.review !== null && preserved) {
           await recordPending(bookDir, chapters, {
             id: `revision:${chapter.id}:${Date.now()}`,
             chapterId: chapter.id,
             characterId: input.review.characterId,
             triggeredBy: input.review.triggeredBy,
             triggeredAgo: 'just now',
             oldDuration: prev?.chapters.find((c) => c.id === chapter.id)?.duration ?? '',
             newDuration: formatDuration(input.durationSec),
             confidence: 1,
             playable: true,
             hasPreviousAudio: true,
             segments: [],
             origin: 'server',
           });
         } else {
           await dropPendingForChapter(bookDir, chapters, chapter.id);
         }
         return true;
       } catch (err) {
         console.error(
           `[finalize] could not record A/B review state for ${chapter.slug}; the new take is live without its review entry`,
           err,
         );
         return false;
       }
     }
     ```
     Check that the file ends with exactly one closing `}`, the one that closes `applyReview`. Typecheck confirms this.
  6. In `CLAUDE.md` (`:603-609`), replace
     ```
       `cast.json` and `state.json` never written at all. FOUR handlers swallow it
       deliberately: `reconcileRejectEdgesOnDisk`
       (`server/src/routes/analysis.ts`), which runs after every retirement has
       landed and writes only cosmetic `notLinkedTo` edges the next persist
       re-heals; and the three interim cast.json snapshots (per-chapter, stage-1,
       subset), which a final write in the same run clobbers, so a timeout there
       diverges nothing (#2292). A NINTH site fails loud in a different shape and is
     ```
     with
     ```
       `cast.json` and `state.json` never written at all. FIVE handlers swallow it
       deliberately: `reconcileRejectEdgesOnDisk`
       (`server/src/routes/analysis.ts`), which runs after every retirement has
       landed and writes only cosmetic `notLinkedTo` edges the next persist
       re-heals; the three interim cast.json snapshots (per-chapter, stage-1,
       subset), which a final write in the same run clobbers, so a timeout there
       diverges nothing (#2292); and `applyReview`
       (`server/src/audio/finalize-chapter-write.ts`, plan 285), whose A/B
       review record on the per-book revisions lock is best-effort with respect
       to a render that has already landed — it logs in full and surfaces only
       `reviewRecorded: false`, never the lock key. A NINTH site fails loud in a
       different shape and is
     ```

- [ ] **Step 4: Run and typecheck**

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/finalize-chapter-write.test.ts src/audio/finalize-chapter-write-refinalize.test.ts`
  Expected: PASS. The refinalize file is #3362's sibling suite and must stay green.

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
  Expected: exit 0.

- [ ] **Step 5: Mutation checks.** Report each red, restore after each, and confirm the diff-stat check.
  1. Move the line `const reviewRecorded = await applyReview(input, preserve.preserved, prev);` up to directly after `const prev = await readJson<BookStateJson>(statePath);` (`:716`), which places it before the `writeStateJsonAtomic` at `:739`. The `return` keeps using the variable. Run Step 4's first command.
     - Expected red: `runs the store call AFTER the audio rename and the state.json write`, reported as `expected { duration: '0:00', audioExists: true } to deeply equal { duration: '00:01', audioExists: true }`.
     - Why: the fixture's `'0:00'` has not been re-stamped yet, while `formatDuration(1.0)` is `'00:01'`. The audio rename at `:706` has already happened, so `audioExists` is true either way.
  2. In `applyReview`, change `if (input.review !== null && preserved)` to `if (input.review !== null)`. Run the same command.
     - Expected red: `object + first render (nothing preserved)…`, because the pending list has 1 entry instead of `[]`.
  3. In `applyReview`, delete `if (input.review === undefined) return undefined;`. Run the same command.
     - Expected red: `undefined: leaves revisions.json alone…`, because `'reviewRecorded' in result` is true.

- [ ] **Step 6: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/audio/finalize-chapter-write.ts server/src/audio/finalize-chapter-write.test.ts CLAUDE.md
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server,docs): add the finalize review tri-state, keyed on preserve (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 8 (5b): Thread `reviewRecorded` onto the three completion events and assert that no caller passes `review`

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify `server/src/routes/chapter-splice.ts`: the `splice_complete` send at `:558-566`, where `hasPreviousAudio: true,` is `:565`.
- Modify `server/src/routes/chapter-qa-repair.ts`: the `dryRun:false` `qa_repair_complete` send at `:866-876`, where `hasPreviousAudio: true,` is `:875`. Do NOT touch the dry-run send at `:283`.
- Modify `server/src/routes/generation.ts`:
  - the finalize destructure at `:1857-1861`;
  - the live `chapter_complete` broadcast at `:2041-2065`, where `audioQa,` is `:2064`;
  - leave the replay loop at `:1174-1194` alone.
- Tests:
  - `chapter-splice.test.ts` and `chapter-qa-repair.test.ts`. **Both already have a pass-through `vi.mock('../audio/finalize-chapter-write.js')` (`chapter-splice.test.ts:136-139`, `chapter-qa-repair.test.ts:73-76`), so reuse those spies and add no new mock.**
  - `generation.test.ts`. This one has **no** finalize mock yet, so add one. It is a **slow-pool** file.

**Dark-state note:** the tests assert that all three callers pass no `review`.

**Interfaces:**
- Consumes (Task 7): `FinalizeChapterAudioResult.reviewRecorded?: boolean` and `finalizeChapterAudioWrite`.
- Produces: `splice_complete`, `qa_repair_complete` (dryRun:false) and the live `chapter_complete` carry `reviewRecorded` only when the finalize result has it.

**About the "no `reviewRecorded`" tests below.** They check the raw SSE `data:` line text. `JSON.stringify` already drops a property whose value is `undefined`, so an unconditional `reviewRecorded: result.reviewRecorded` spread would put identical bytes on the wire as the conditional one. That makes it wire-identical, not a defect, and no test can or should tell them apart. What these tests do guard against is a default that invents a value, such as `?? false`. Each mutation is written to exercise exactly that.

- [ ] **Step 1: Write the failing caller tests**

  (a) In `server/src/routes/chapter-splice.test.ts`, inside `describe('POST /:bookId/chapters/:chapterId/splice (remix)', …)`, after the existing `threads an EMPTY resynthesizedIndices…` test, add the tests below. They use the file's existing spy; do not add a new `vi.mock`.
  ```ts
    it('plan 285 — passes no `review` to finalize (PR 1 dark) and threads reviewRecorded onto splice_complete', async () => {
      const fin = await import('../audio/finalize-chapter-write.js');
      const real = (
        await vi.importActual<typeof import('../audio/finalize-chapter-write.js')>('../audio/finalize-chapter-write.js')
      ).finalizeChapterAudioWrite;
      const spy = vi.mocked(fin.finalizeChapterAudioWrite);
      spy.mockClear();
      spy.mockImplementationOnce(async (input) => ({ ...(await real(input)), reviewRecorded: false }));

      const res = await request(app)
        .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
        .send({ mode: 'remix', characterId: 'castor', gainDb: 3 });

      expect(spy).toHaveBeenCalledTimes(1);
      expect('review' in spy.mock.calls[0][0]).toBe(false);
      const done = parseSse(res.text).find((e) => e.type === 'splice_complete');
      expect(done, `expected splice_complete, got ${res.text}`).toBeTruthy();
      expect(done!.reviewRecorded).toBe(false);
    });

    it('plan 285 — the splice_complete line carries no reviewRecorded when finalize returns none', async () => {
      const res = await request(app)
        .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
        .send({ mode: 'remix', characterId: 'castor', gainDb: 3 });
      const line = res.text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"splice_complete"'));
      expect(line, res.text).toBeTruthy();
      expect(line).not.toContain('reviewRecorded');
    });
  ```

  (b) In `server/src/routes/chapter-qa-repair.test.ts`, inside `describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (fs-51 verdict persistence)', …)`, after `threads the spliced take's embedding rows…`, add the test below. Again use the existing spy and add no new `vi.mock`.
  ```ts
    it('plan 285 — passes no `review` to finalize (PR 1 dark) and threads reviewRecorded onto qa_repair_complete', async () => {
      synthesiseChapterMock.mockReset();
      synthesiseChapterMock.mockImplementation(async () => ({ pcm: tone(0.5, 12000), sampleRate: SR }));
      const fin = await import('../audio/finalize-chapter-write.js');
      const real = (
        await vi.importActual<typeof import('../audio/finalize-chapter-write.js')>('../audio/finalize-chapter-write.js')
      ).finalizeChapterAudioWrite;
      const spy = vi.mocked(fin.finalizeChapterAudioWrite);
      spy.mockClear();
      spy.mockImplementationOnce(async (input) => ({ ...(await real(input)), reviewRecorded: false }));

      const { bookId: id } = await scaffoldVerdictBook('Review Dark Story');
      const res = await request(app)
        .post(`/api/books/${encodeURIComponent(id)}/chapters/1/audio-qa-repair`)
        .send({ dryRun: false, modelKey: 'kokoro-v1' });

      expect(spy).toHaveBeenCalledTimes(1);
      expect('review' in spy.mock.calls[0][0]).toBe(false);
      const done = parseSse(res.text).find((e) => e.type === 'qa_repair_complete');
      expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();
      expect(done!.reviewRecorded).toBe(false);
    });
  ```

  (c) In `server/src/routes/generation.test.ts`, add the top-level pass-through mock next to the existing `vi.mock` calls (`:35-120`):
  ```ts
  /* Plan 285 — passthrough spy so a test can (1) assert generation passes NO
     `review` to finalize in PR 1 and (2) force `reviewRecorded:false` to prove
     it reaches chapter_complete. Every other test still runs the real write. */
  vi.mock('../audio/finalize-chapter-write.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../audio/finalize-chapter-write.js')>();
    return { ...real, finalizeChapterAudioWrite: vi.fn(real.finalizeChapterAudioWrite) };
  });
  ```
  Then append this at the end of the file. Task 10 adds more tests to the same describe.
  ```ts
  describe('plan 285 — finalize review plumbing (PR 1 dark)', () => {
    afterEach(async () => {
      const fs = await import('node:fs');
      const audioRoot = join(bookDir, 'audio');
      if (fs.existsSync(audioRoot)) fs.rmSync(audioRoot, { recursive: true, force: true });
    });

    /** The raw SSE frame text for chapter N's live chapter_complete. */
    const completeLine = (text: string, chapterId: number) =>
      text
        .split('\n')
        .find((l) => l.startsWith('data: ') && l.includes(`"type":"chapter_complete","chapterId":${chapterId},`));

    it('passes no `review` to finalize and threads reviewRecorded onto the live chapter_complete', async () => {
      const fin = await import('../audio/finalize-chapter-write.js');
      const real = (
        await vi.importActual<typeof import('../audio/finalize-chapter-write.js')>('../audio/finalize-chapter-write.js')
      ).finalizeChapterAudioWrite;
      const spy = vi.mocked(fin.finalizeChapterAudioWrite);
      spy.mockClear();
      spy.mockImplementationOnce(async (input) => ({ ...(await real(input)), reviewRecorded: false }));

      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      expect(res.status).toBe(200);

      expect(spy).toHaveBeenCalledTimes(1);
      expect('review' in spy.mock.calls[0][0]).toBe(false);
      const done = parseTicks(res.text).find((t) => t.type === 'chapter_complete' && t.chapterId === 1);
      expect(done, `expected chapter_complete ch1, got ${res.text}`).toBeTruthy();
      expect(done!.reviewRecorded).toBe(false);
    });

    it('the chapter_complete line carries no reviewRecorded when finalize returns none', async () => {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      const line = completeLine(res.text, 1);
      expect(line, res.text).toBeTruthy();
      expect(line).not.toContain('reviewRecorded');
    });
  });
  ```

  Run these as **two separate recipe launches**, one `$Cmd` each:
  - Launch 1: `$Cmd = 'npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts -t "plan 285" --reporter=verbose'`
  - Launch 2: `$Cmd = 'npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test:slow -- src/routes/generation.test.ts -t "plan 285" --reporter=verbose'`. Poll this one with `Start-Sleep -Seconds 120`.
  - Expected FAIL: the three `threads reviewRecorded…` tests, each with `expected undefined to be false`.
  - Expected PASS: the "no reviewRecorded" tests, which are regression guards with a mutation in Step 4.
  - If the slow run prints "No test files found", the wrong script was used.

- [ ] **Step 2: Thread `reviewRecorded`**
  1. In `chapter-splice.ts`, inside the `splice_complete` send, add this after `hasPreviousAudio: true,` (`:565`):
     ```ts
             /* Plan 285 — present only when finalize was asked to record review state. */
             ...(result.reviewRecorded === undefined ? {} : { reviewRecorded: result.reviewRecorded }),
     ```
  2. In `chapter-qa-repair.ts`, add the same spread after `hasPreviousAudio: true,` (`:875`) in the `dryRun: false` `qa_repair_complete` send.
  3. In `generation.ts`:
     - Change the destructure at `:1857-1861` to `const { audioQa, audioModelKey: renderedModelKey, audioEngines, reviewRecorded } = await finalizeChapterAudioWrite({`.
     - In the live `chapter_complete` broadcast, add this after `audioQa,` (`:2064`):
       ```ts
               /* Plan 285 — present only when finalize was asked to record review state. */
               ...(reviewRecorded === undefined ? {} : { reviewRecorded }),
       ```

- [ ] **Step 3: Run the suites and typecheck.** These run the whole of each file, because the new top-level generation mock touches every test in it. Run each command once:
  ```
  npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts
  npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test:slow -- src/routes/generation.test.ts
  npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck
  ```
  Expected: all PASS / exit 0.

- [ ] **Step 4: Mutation checks.** Use the `-t "plan 285"` filtered runs from Step 1. Report each red, restore after each, and confirm the diff-stat check.
  1. In `chapter-splice.ts`, delete the `reviewRecorded` spread.
     - Expected red: splice `…threads reviewRecorded onto splice_complete`, with `expected undefined to be false`.
  2. In `chapter-splice.ts`, add `review: null,` to the `finalizeChapterAudioWrite({…})` argument.
     - Expected red: splice `…passes no \`review\` to finalize (PR 1 dark)…`, with `expected true to be false`.
  3. In `chapter-splice.ts`, replace the spread with `reviewRecorded: result.reviewRecorded ?? false,`.
     - Expected red: `the splice_complete line carries no reviewRecorded…`.
  4. In `generation.ts`, replace the spread with `reviewRecorded: reviewRecorded ?? false,`. Run the slow `-t "plan 285"` command.
     - Expected red: `the chapter_complete line carries no reviewRecorded…`.

- [ ] **Step 5: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/chapter-splice.ts server/src/routes/chapter-splice.test.ts server/src/routes/chapter-qa-repair.ts server/src/routes/chapter-qa-repair.test.ts server/src/routes/generation.ts server/src/routes/generation.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server): thread reviewRecorded onto splice/QA-repair/generation completion events (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 9 (6a): Server `review` validator, queue and queue-io (fast pool only)

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Create: `server/src/routes/review-request.ts`, `server/src/routes/review-request.test.ts`
- Modify `server/src/routes/queue.ts` (re-anchored):
  - `EnqueueRequestEntry` at `:75-84`;
  - the whitelist, where `inputs.push({` is at `:105` and the `fallbackConfirmed` spread is at `:116`.
- Modify `server/src/workspace/queue-io.ts` (re-anchored):
  - `QueueEntry` at `:39-85`, where `parkedAt?: string;` is at `:84`;
  - `EnqueueInput` at `:93-111`, where `fallbackConfirmed?: boolean;` is at `:110`;
  - `enqueue()`, where the `fallbackConfirmed` spread is at `:138`.
- Test: `server/src/routes/queue.test.ts`, `server/src/workspace/queue-io.test.ts`

**Dark-state note:** no client sets `review` in PR 1.

**Interfaces:**
- Consumes: `markInProgress` (`queue-io.ts`).
- Produces:
  ```ts
  // server/src/routes/review-request.ts
  export interface ReviewRequest { characterId: string; triggeredBy: string }
  export const INVALID_REVIEW: 'invalid';
  export function parseReviewRequest(raw: unknown): ReviewRequest | undefined | typeof INVALID_REVIEW;
  // queue-io.ts: QueueEntry.review?, EnqueueInput.review? — { characterId: string; triggeredBy: string }
  ```

- [ ] **Step 1: Write the failing tests**

  (a) `server/src/routes/review-request.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { parseReviewRequest, INVALID_REVIEW } from './review-request.js';

  describe('parseReviewRequest (plan 285)', () => {
    it('treats undefined and null as absent', () => {
      expect(parseReviewRequest(undefined)).toBeUndefined();
      expect(parseReviewRequest(null)).toBeUndefined();
    });
    it('accepts { characterId, triggeredBy } and strips extra fields', () => {
      expect(parseReviewRequest({ characterId: 'amy', triggeredBy: 'Amy voice change', x: 1 })).toEqual({
        characterId: 'amy',
        triggeredBy: 'Amy voice change',
      });
    });
    it('rejects every malformed shape', () => {
      for (const bad of [true, 'amy', [], {}, { characterId: '', triggeredBy: 't' }, { characterId: 'a' }, { characterId: 'a', triggeredBy: 3 }]) {
        expect(parseReviewRequest(bad)).toBe(INVALID_REVIEW);
      }
    });
  });
  ```
  (b) `server/src/workspace/queue-io.test.ts`, inside `describe('queue-io.enqueue', …)`:
  ```ts
    it('plan 285 — carries an optional review onto the stored entry, and markInProgress keeps it', () => {
      const review = { characterId: 'amy', triggeredBy: 'Amy voice change' };
      const f = enqueue(emptyFile(), [{ ...sampleEntry('e1'), review }, sampleEntry('e2')]);
      expect(f.entries.find((e) => e.id === 'e1')?.review).toEqual(review);
      expect(f.entries.find((e) => e.id === 'e2')).not.toHaveProperty('review');
      expect(markInProgress(f, 'e1').entries.find((e) => e.id === 'e1')?.review).toEqual(review);
    });
  ```
  (c) `server/src/routes/queue.test.ts`, inside `describe('POST /api/queue/enqueue', …)`:
  ```ts
    it('plan 285 — round-trips review through enqueue, GET and the claim (/start)', async () => {
      const review = { characterId: 'narrator', triggeredBy: 'Narrator voice change' };
      const enq = await request(app)
        .post('/api/queue/enqueue')
        .send({ entries: [{ id: 'r1', bookId: 'book-A', chapterId: 1, scope: 'this', review }] });
      expect(enq.status).toBe(200);
      expect(enq.body.entries[0].review).toEqual(review);
      const got = await request(app).get('/api/queue');
      expect(got.body.entries[0].review).toEqual(review);
      const started = await request(app).post('/api/queue/r1/start');
      expect(started.body.entries[0]).toMatchObject({ status: 'in_progress', review });
    });

    it('plan 285 — 400 on a malformed review; an entry without one stores no review key', async () => {
      const bad = await request(app)
        .post('/api/queue/enqueue')
        .send({ entries: [{ id: 'r2', bookId: 'book-A', chapterId: 1, scope: 'this', review: { characterId: 'x' } }] });
      expect(bad.status).toBe(400);
      const ok = await request(app)
        .post('/api/queue/enqueue')
        .send({ entries: [{ id: 'r3', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
      expect(ok.body.entries.find((e: { id: string }) => e.id === 'r3')).not.toHaveProperty('review');
    });
  ```

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/review-request.test.ts src/workspace/queue-io.test.ts src/routes/queue.test.ts`
  Expected: FAIL. `review-request.js` cannot load, `review` is undefined on the queue entries, and the malformed enqueue returns 200.

- [ ] **Step 2: Implement**
  1. Create `server/src/routes/review-request.ts`:
     ```ts
     /* Plan 285 (#3400) — the `review` intent a queue entry or generation request
        may carry: { characterId, triggeredBy }. Shared by routes/queue.ts (the
        enqueue whitelist) and routes/generation.ts (the request body) so both
        reject the same malformed shapes. Lives under routes/ so generation.ts
        gains no new import from audio/ or workspace/. Not set by any client in PR 1. */

     export interface ReviewRequest {
       characterId: string;
       triggeredBy: string;
     }

     export const INVALID_REVIEW = 'invalid' as const;

     /** undefined/null → absent. A plain object with a non-empty string
         characterId and a string triggeredBy → that pair (extra fields dropped).
         Anything else → INVALID_REVIEW. */
     export function parseReviewRequest(raw: unknown): ReviewRequest | undefined | typeof INVALID_REVIEW {
       if (raw === undefined || raw === null) return undefined;
       if (typeof raw !== 'object' || Array.isArray(raw)) return INVALID_REVIEW;
       const r = raw as Record<string, unknown>;
       if (typeof r.characterId !== 'string' || r.characterId.length === 0) return INVALID_REVIEW;
       if (typeof r.triggeredBy !== 'string') return INVALID_REVIEW;
       return { characterId: r.characterId, triggeredBy: r.triggeredBy };
     }
     ```
  2. In `queue-io.ts`, add this field to `QueueEntry` (after `parkedAt?: string;`) and to `EnqueueInput` (after `fallbackConfirmed?: boolean;`):
     ```ts
       /* Plan 285 — the A/B review intent, carried from enqueue to the generation
          request. Mirrored in openapi.yaml's QueueEntry. Not set by the client until PR 2. */
       review?: { characterId: string; triggeredBy: string };
     ```
     Then, in `enqueue()`, add `...(input.review ? { review: input.review } : {}),` after the `fallbackConfirmed` spread.
  3. In `queue.ts`:
     - Add `import { parseReviewRequest, INVALID_REVIEW } from './review-request.js';`.
     - Add `review?: unknown;` to `EnqueueRequestEntry`.
     - Inside the `for (const r of raw)` loop, add this before `inputs.push(`:
       ```ts
           /* Plan 285 — a malformed review 400s the batch (unlike modelKey, which is
              silently dropped): dropping it would turn a review render into a plain
              one, which PR 2 treats as "drop the chapter's pending entry". */
           const review = parseReviewRequest(r.review);
           if (review === INVALID_REVIEW) {
             return res.status(400).json({ error: `entry "${r.id}": review must be { characterId, triggeredBy }` });
           }
       ```
     - Add `...(review ? { review } : {}),` after the `fallbackConfirmed` spread in the pushed object.

- [ ] **Step 3: Run the suites and typecheck**

  Re-run the Step 1 command. Expected: PASS.

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
  Expected: exit 0.

- [ ] **Step 4: Mutation checks.** Report each red, restore after each, and confirm the diff-stat check.
  1. In `queue-io.ts`, delete `...(input.review ? { review: input.review } : {}),`. Run the Step 1 command.
     - Expected red: both review round-trip tests, with `expected undefined to deeply equal {…}`.
  2. In `queue.ts`, delete the `INVALID_REVIEW` 400 block. Run the same command.
     - Expected red: `400 on a malformed review…`, with `expected 200 to be 400`.

- [ ] **Step 5: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/review-request.ts server/src/routes/review-request.test.ts server/src/routes/queue.ts server/src/routes/queue.test.ts server/src/workspace/queue-io.ts server/src/workspace/queue-io.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server): validate review and carry it on the persisted queue entry (dark) (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 10 (6b): Generation request `review` — a 400 before SSE, and `reviewChapter` only on the rendered chapter (slow pool)

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify `server/src/routes/generation.ts` (re-anchored):
  - imports (`:22-103`);
  - `RunningJob` (`:364`), where `fallbackConfirmed: boolean;` is at `:385`;
  - the fake-job literal (`:576`);
  - `GenerationRequestBody` (`:699`), where `fallbackConfirmed?: unknown;` is at `:713`;
  - the handler head (`:718-720`);
  - the job literal (`:1282`);
  - the live `chapter_complete` broadcast. It was at `:2041-2065` on the base; Task 8 moved it, so after Task 8's edit find it by `audioModelKey: renderedModelKey,` … `audioQa,` (the live broadcast, not the replay `send`), followed by Task 8's `...(reviewRecorded === undefined ? {} : { reviewRecorded }),`. The replay loop (base `:1174-1194`) is unshifted by Task 8, but this task's own head and `RunningJob` additions push it down, so find it by `for (const ch of state.chapters) {` followed by `send({` / `type: 'chapter_complete',`.
- Test: `server/src/routes/generation.test.ts`, using the **slow pool** and `-t "plan 285"`.

**Dark-state note:** generation stamps `reviewChapter`, but finalize still gets no `review`. The test below asserts that.

**Interfaces:**
- Consumes:
  - from Task 9: `parseReviewRequest`, `INVALID_REVIEW`, `ReviewRequest` (`./review-request.js`);
  - from Task 8: the finalize spy and the `plan 285 — finalize review plumbing (PR 1 dark)` describe block, with its `completeLine` helper.
- Produces: `RunningJob.review: ReviewRequest | null`. It also adds two JSON 400 bodies, `{error:'invalid_review'}` and `{error:'review_requires_single_chapter'}`.

- [ ] **Step 1: Write the failing tests.** Add these inside Task 8's `describe('plan 285 — finalize review plumbing (PR 1 dark)', …)` in `generation.test.ts`:
  ```ts
    const REVIEW = { characterId: 'narrator', triggeredBy: 'Narrator voice change' };

    it('400 before any SSE header when review names ≠ 1 chapter, or is malformed', async () => {
      for (const body of [
        { modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1, 2], review: REVIEW },
        { modelKey: 'gemini-2.5-flash', force: true, review: REVIEW },
        { modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1], review: { characterId: 'narrator' } },
      ]) {
        const res = await request(app).post(`/api/books/${bookId}/generation`).send(body);
        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(['review_requires_single_chapter', 'invalid_review']).toContain(res.body.error);
      }
    });

    it('reviewChapter:true only on the chapter rendered with review — never a replay — and finalize still gets no review', async () => {
      const fs = await import('node:fs');
      const audioRoot = join(bookDir, 'audio');
      fs.mkdirSync(audioRoot, { recursive: true });
      fs.writeFileSync(join(audioRoot, '02-chapter-two.mp3'), 'DONE-CH2'); // replayed as done
      const fin = await import('../audio/finalize-chapter-write.js');
      const spy = vi.mocked(fin.finalizeChapterAudioWrite);
      spy.mockClear();

      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1], review: REVIEW });
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      const ch1 = ticks.find((t) => t.type === 'chapter_complete' && t.chapterId === 1);
      const ch2 = ticks.find((t) => t.type === 'chapter_complete' && t.chapterId === 2);
      expect(ch1, `expected chapter_complete ch1, got ${res.text}`).toBeTruthy();
      expect(ch2, `expected replayed chapter_complete ch2, got ${res.text}`).toBeTruthy();
      expect(ch1!.reviewChapter).toBe(true);
      expect(ch2).not.toHaveProperty('reviewChapter');
      expect('review' in spy.mock.calls[0][0]).toBe(false);
    });

    it('the chapter_complete line carries no reviewChapter without review', async () => {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      const line = completeLine(res.text, 1);
      expect(line, res.text).toBeTruthy();
      expect(line).not.toContain('reviewChapter');
    });
  ```

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test:slow -- src/routes/generation.test.ts -t "plan 285"`
  - Expected FAIL: the 400 test (`expected 200 to be 400`) and `ch1.reviewChapter` undefined.
  - Expected PASS: `no reviewChapter without review`. It is a regression guard, and its mutation is in Step 4.

- [ ] **Step 2: Implement in `generation.ts`**
  - Add the import `import { parseReviewRequest, INVALID_REVIEW, type ReviewRequest } from './review-request.js';`.
  - In `RunningJob`, add this after `fallbackConfirmed: boolean;` (`:385`):
    ```ts
      /** Plan 285 — the request's A/B review intent (null when absent). Stamps
          `reviewChapter: true` on THIS job's live chapter_complete. Not yet passed
          to finalize (PR 2). */
      review: ReviewRequest | null;
    ```
  - Add `review: null,` after `fallbackConfirmed` in the fake-job literal (`:576`), and `review,` after `fallbackConfirmed` in the real job literal (`:1282`).
  - In `GenerationRequestBody`, add `/** Plan 285 — see ReviewRequest. */ review?: unknown;` after `fallbackConfirmed?: unknown;` (`:713`).
  - In the handler head, add the following directly after `const body = (req.body ?? {}) as GenerationRequestBody;` (`:718`) and **above** `res.setHeader('Content-Type', 'text/event-stream');` (`:720`):
    ```ts
      /* Plan 285 — a review render must name exactly one chapter. Rejected with a
         JSON 400 BEFORE the SSE headers flush; the client already turns a non-OK
         response into chapter_failed + idle (api.ts realStreamGeneration). */
      const parsedReview = parseReviewRequest(body.review);
      if (parsedReview === INVALID_REVIEW) {
        return res
          .status(400)
          .json({ error: 'invalid_review', message: 'review must be { characterId, triggeredBy }.' });
      }
      if (parsedReview !== undefined) {
        const ids = Array.isArray(body.chapterIds) ? body.chapterIds : [];
        if (ids.length !== 1 || typeof ids[0] !== 'number' || !Number.isInteger(ids[0])) {
          return res.status(400).json({
            error: 'review_requires_single_chapter',
            message: 'A review render must name exactly one chapter.',
          });
        }
      }
      const review: ReviewRequest | null = parsedReview ?? null;
    ```
  - In the live `chapter_complete` broadcast, add this next to Task 8's `reviewRecorded` spread:
    ```ts
            /* Plan 285 — only the chapter actually rendered with `review`; the
               replay loop above never carries it. */
            ...(job.review !== null && job.chapterId === chapter.id ? { reviewChapter: true } : {}),
    ```

- [ ] **Step 3: Run and typecheck**

  Re-run the Step 1 command. Expected: PASS.

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
  Expected: exit 0.

- [ ] **Step 4: Mutation checks.** Use the filtered slow run from Step 1. Report each red, restore after each, and confirm the diff-stat check.
  1. Inside the replay loop's `send({ type: 'chapter_complete', … })` (base `:1179-1191`; after this task's edits find it by quoted text, as described in Files), add `...(review ? { reviewChapter: true } : {}),`.
     - Expected red: `reviewChapter:true only on the chapter rendered with review — never a replay…`.
  2. Delete the `review_requires_single_chapter` `if` block.
     - Expected red: `400 before any SSE header…`, with `expected 200 to be 400`.
  3. Change the broadcast spread to `reviewChapter: job.review !== null && job.chapterId === chapter.id,`.
     - Expected red: `the chapter_complete line carries no reviewChapter without review`. The line now contains `"reviewChapter":false`.

- [ ] **Step 5: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/generation.ts server/src/routes/generation.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server): accept review on the generation request; stamp reviewChapter (dark) (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 11 (6c): Client `review` plumbing

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify (re-anchored):
  - `src/store/queue-thunks.ts`: `EnqueueInput`, with `fallbackConfirmed?: boolean;` at `:56`;
  - `src/lib/api.ts`: `StreamArgs` at `:599-645`, where `fallbackConfirmed?: boolean;` is `:644`; and `realStreamGeneration` (base `:5894`, args `:5900`, body spread `:5931`; Task 6 added 4 lines above it and this task's own earlier sub-step (the `StreamArgs` member and comment, plus possibly the import line) adds about 3 more, so the numbers are only approximate (roughly `:5901` / `:5907` / `:5938`). Locate each by its quoted text: `function realStreamGeneration({`, `  fallbackConfirmed,` and `...(fallbackConfirmed ? { fallbackConfirmed: true } : {}),`);
  - `src/store/generation-stream-runner.ts`: `StreamOpenOpts`, with `fallbackConfirmed?: boolean;` at `:60`; and the `api.streamGeneration` call spread at `:321`;
  - `src/store/queue-dispatcher-middleware.ts`: the `runner.open` opts spread at `:278`.
- Tests:
  - new `src/lib/api-stream-review.test.ts`;
  - `src/store/queue-dispatcher-middleware.test.ts`;
  - new `src/mocks/mock-queue.test.ts`.

**Dark-state note:** nothing sets `review` in PR 1. The enqueue sites at `layout.tsx:2074-2083` are left untouched.

**Interfaces:**
- Consumes:
  - from Task 6: `ReviewRequest` (`src/lib/types.ts`) and the regenerated `QueueEntry.review` (`src/store/queue-slice.ts` derives `QueueEntry` from the generated types);
  - from Tasks 9–10: the server accepts `review` on enqueue and in the generation POST body.
- Produces: `EnqueueInput.review?`, `StreamOpenOpts.review?` and `StreamArgs.review?`, all typed `ReviewRequest`.

- [ ] **Step 1: Write the failing tests**

  (a) Create `src/lib/api-stream-review.test.ts`:
  ```ts
  /* Plan 285 — realStreamGeneration threads `review` into the generation POST
     body (nothing sets it in PR 1). Mirrors api-stream-fallback-confirmed.test.ts. */
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sseResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        controller.close();
      },
    });
    return { ok: true, status: 200, statusText: 'OK', body: stream, text: () => Promise.resolve('') } as unknown as Response;
  }

  describe('realStreamGeneration review', () => {
    it('sends review in the POST body when set', async () => {
      const { api } = await import('./api');
      fetchMock.mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
      const review = { characterId: 'amy', triggeredBy: 'Amy voice change' };
      const cancel = api.streamGeneration({
        bookId: 'book-A',
        modelKey: 'kokoro-v1',
        chapterIds: [1],
        force: true,
        review,
        onTick: () => {},
      });
      await new Promise((r) => setTimeout(r, 25));
      cancel();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).review).toEqual(review);
    });

    it('omits review when not set', async () => {
      const { api } = await import('./api');
      fetchMock.mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
      const cancel = api.streamGeneration({ bookId: 'book-A', modelKey: 'kokoro-v1', chapterIds: [1], force: true, onTick: () => {} });
      await new Promise((r) => setTimeout(r, 25));
      cancel();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('review');
    });
  });
  ```
  (b) In `src/store/queue-dispatcher-middleware.test.ts`, inside `describe('loud-fallback gate', …)` and directly after `it('threads fallbackConfirmed into the stream open for a confirmed entry', …)`, add:
  ```ts
      it('plan 285 — threads an entry review into the stream open; omits it otherwise', async () => {
        const review = { characterId: 'amy', triggeredBy: 'Amy voice change' };
        const store = makeStore(2);
        seed(store, [
          entry({ id: 'a1', bookId: 'book-A', chapterId: 1, review }),
          entry({ id: 'a2', bookId: 'book-B', chapterId: 2 }),
        ]);
        await flushMicro();
        const byBook = (b: string) =>
          streamGenerationMock.mock.calls.find((c) => (c[0] as { bookId?: string }).bookId === b)?.[0] as
            | { review?: unknown }
            | undefined;
        expect(byBook('book-A')?.review).toEqual(review);
        expect(byBook('book-B')).toBeDefined();
        expect(byBook('book-B')).not.toHaveProperty('review');
      });
  ```
  (c) Create `src/mocks/mock-queue.test.ts`:
  ```ts
  /* Plan 285 — the mock queue carries `review` through enqueue, like the real
     server (mock-queue.ts spreads the incoming entry; this pins that a future
     whitelist there keeps `review`). */
  import { describe, it, expect, beforeEach } from 'vitest';
  import { mockQueueRequest, resetMockQueue } from './mock-queue';

  beforeEach(() => resetMockQueue());

  describe('mock queue — review', () => {
    it('keeps review on the enqueued entry', async () => {
      const review = { characterId: 'amy', triggeredBy: 'Amy voice change' };
      const res = mockQueueRequest('/api/queue/enqueue', {
        method: 'POST',
        body: JSON.stringify({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this', review }] }),
      });
      const snap = (await res.json()) as { entries: Array<{ id: string; review?: unknown }> };
      expect(snap.entries[0].review).toEqual(review);
    });
  });
  ```

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test -- src/lib/api-stream-review.test.ts src/store/queue-dispatcher-middleware.test.ts src/mocks/mock-queue.test.ts`
  - Expected FAIL: the POST body has no `review`, and the dispatcher's `byBook('book-A')?.review` is undefined.
  - Expected PASS: `mock-queue.test.ts` and `api-stream-review › omits review when not set`. Both are regression guards; their mutations are in Step 4.

- [ ] **Step 2: Implement**
  1. `src/store/queue-thunks.ts`:
     - Change the type import to `import type { TtsModelKey, ReviewRequest } from '../lib/types';`.
     - In `EnqueueInput`, add this after `fallbackConfirmed?: boolean;`:
       ```ts
         /** Plan 285 — the A/B review intent; rides the persisted entry into the
             generation request. Nothing sets it until PR 2. */
         review?: ReviewRequest;
       ```
  2. `src/lib/api.ts`:
     - Add `ReviewRequest` to the existing type import from `./types` (`:63`).
     - In `StreamArgs`, add `review?: ReviewRequest;` after `fallbackConfirmed?: boolean;` (`:644`), with the comment `/** Plan 285 — single-chapter A/B review intent; forwarded in the POST body. */`.
     - In `realStreamGeneration`, add `review,` to the destructured args after `fallbackConfirmed,`, inside `function realStreamGeneration({`.
     - Add `...(review ? { review } : {}),` after the `...(fallbackConfirmed ? { fallbackConfirmed: true } : {}),` body spread inside `realStreamGeneration`'s `JSON.stringify({`.
  3. `src/store/generation-stream-runner.ts`:
     - Add `import type { ReviewRequest } from '../lib/types';`.
     - In `StreamOpenOpts`, add this after `fallbackConfirmed?: boolean;` (`:60`):
       ```ts
         /** Plan 285 — the entry's A/B review intent, forwarded to the server. */
         review?: ReviewRequest;
       ```
     - Add `...(opts.review ? { review: opts.review } : {}),` after the `fallbackConfirmed` spread at `:321`.
  4. `src/store/queue-dispatcher-middleware.ts`: after the `fallbackConfirmed` spread at `:278`, add:
     ```ts
               /* Plan 285 — carry the entry's A/B review intent to the server. */
               ...(e.review ? { review: e.review } : {}),
     ```

- [ ] **Step 3: Run the tests and typecheck**

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test -- src/lib/api-stream-review.test.ts src/store/queue-dispatcher-middleware.test.ts src/mocks/mock-queue.test.ts src/lib/api-stream-fallback-confirmed.test.ts`
  Expected: PASS.

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`
  Expected: exit 0.

- [ ] **Step 4: Mutation checks.** Report each red, restore after each, and confirm the diff-stat check.
  1. In `queue-dispatcher-middleware.ts`, delete the `review` spread. Run `…run test -- src/store/queue-dispatcher-middleware.test.ts`.
     - Expected red: `plan 285 — threads an entry review into the stream open…`.
  2. In `src/mocks/mock-queue.ts`'s `/enqueue` branch, change `...inp,` to `id: inp.id, bookId: inp.bookId, chapterId: inp.chapterId, scope: inp.scope,`. Run `…run test -- src/mocks/mock-queue.test.ts`.
     - Expected red: `keeps review on the enqueued entry`.
  3. In `realStreamGeneration`'s body, change `...(review ? { review } : {}),` to `review: review ?? null,`. Run `…run test -- src/lib/api-stream-review.test.ts`.
     - Expected red: `omits review when not set`, because the body now carries `"review":null`. The server would read `null` as absent, so the wire meaning would survive. The test still pins the key's absence, since every other optional field in this body follows that convention.

- [ ] **Step 5: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add src/store/queue-thunks.ts src/lib/api.ts src/store/generation-stream-runner.ts src/store/queue-dispatcher-middleware.ts src/lib/api-stream-review.test.ts src/store/queue-dispatcher-middleware.test.ts src/mocks/mock-queue.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(frontend): carry review from the queue entry into the generation POST (dark) (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 12 (7): Reparse/replace preflight and reset through the store, plus lock-order docs and INDEX

**Lane: auto-cloud (Cline): detach every test/typecheck.** Every `vitest`, `test:slow`, `typecheck`, `openapi:types` and `check:cycles` command in this task goes through the Global Constraints detach recipe and is polled. Only `git`, `gh`, reads and edits run in the foreground. Apply the Green rule and the contention rule (Global Constraints) to every result.

**Files:**
- Modify `server/src/routes/book-state.ts`. Re-anchored line numbers:
  - imports;
  - the reparse route at `:1283`, where `const { bookDir, state } = located;` is at `:1287`;
  - the replace route at `:1360`, where `const { bookDir, state } = located;` is at `:1369`;
  - the `applyReparse` Promise.all at `:1132-1205`, where the revisions arm is at `:1201-1203`;
  - the sibling-arm comment at `:1144-1150`.
- Modify `server/src/routes/book-state.reparse.test.ts`: the corrupt-cast test at `:964-986`, plus new tests. Note that this file already passes `vi.mock('../workspace/state-io.js')` through (`:45-48`). It is harmless here.
- Modify `server/src/routes/book-state.replace-manuscript.test.ts`: new tests.
- Modify `server/src/workspace/cast-lock.ts:18-24` (rule 4), `CLAUDE.md:582-584` (rule 4) and `docs/features/INDEX.md` (`### G. Generation`).
- Modify `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md`, at two places this task makes false:
  - `:373`. Its "only PR 1 changes an old client could observe" sentence names two changes; it must match this plan's Reversibility list.
  - `:477`. "PR 1's are none" must match the two release-notes entries this task adds: the technical one and the user-facing one.
- Modify `docs/release-notes-next.md` (one technical, operator-facing entry).
- Modify `RELEASE_NOTES.md`: add one short user-facing line at the top of the in-progress `# Castwright 1.15.0` list.

**Dark-state note:** a reset leaves `pending: []`, exactly what today's `rm` produced as far as any client can tell. The preflight only *refuses* a newer-schema file, which an old client could never have written.

**Interfaces:**
- Consumes (from Task 1):
  - `assertRevisionsResettable(bookDir): Promise<void>`;
  - `resetRevisions(bookDir): Promise<RevisionsFile>`.

- [ ] **Step 1: Write the failing tests**

  (a) In `book-state.reparse.test.ts`, replace the corrupt-cast test (`:964-986`) with:
  ```ts
    it('completes the reparse, deletes cast.json and RESETS revisions.json when cast.json is corrupt', async () => {
      const castPath = join(corruptBookDir, '.audiobook', 'cast.json');
      const revisionsPath = join(corruptBookDir, '.audiobook', 'revisions.json');
      // Truncated JSON — parses fine as a *file that exists* (existsSync true)
      // but JSON.parse throws on read, which is the case readJson's `null`
      // return for a MISSING file does not cover.
      writeFileSync(castPath, '{"characters":');
      writeFileSync(revisionsPath, JSON.stringify({ revisions: [{ id: 1 }] }));

      const res = await request(app).post(`/api/books/${corruptBookId}/reparse`);

      expect(res.status).toBe(200);
      // cast.json degraded to the missing-file path: deleted, not left corrupt.
      expect(existsSync(castPath)).toBe(false);
      // Cleanup-completeness check, not evidence about the cast arm: the
      // revisions arm (plan 285: a reset through the store under its own leaf
      // lock) runs beside the cast arm in the same Promise.all. It would catch
      // a future Promise.allSettled reshape that stopped sibling arms from
      // running to completion.
      const reset = JSON.parse(readFileSync(revisionsPath, 'utf8'));
      expect(reset).toMatchObject({ schema: 1, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} });
      expect(reset.fileId).toMatch(/^\d{15}-[0-9a-f]{8}$/);
    });
  ```
  (b) In `book-state.reparse.test.ts`, add these inside `describe('reparse handler — preserves manuscript-edits.json', …)` (`:134`):
  ```ts
    it('plan 285 — resets revisions.json to a NEW fileId and never deletes it', async () => {
      const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
      const OLD = '000000000000001-aaaaaaaa';
      writeFileSync(
        revisionsPath,
        JSON.stringify({
          schema: 1,
          fileId: OLD,
          rev: 7,
          pending: [
            { id: 'revision:1:1', chapterId: 1, characterId: 'eliza', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' },
          ],
          dismissed: ['d1'],
          acceptedSelections: {},
          timeline: {},
        }),
      );
      const res = await request(app).post(`/api/books/${bookId}/reparse`);
      expect(res.status).toBe(200);
      expect(existsSync(revisionsPath)).toBe(true);
      const after = JSON.parse(readFileSync(revisionsPath, 'utf8'));
      expect(after).toMatchObject({ schema: 1, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} });
      expect(after.fileId).not.toBe(OLD);
      expect(after.fileId).toMatch(/^\d{15}-[0-9a-f]{8}$/);
    });

    it('plan 285 — refuses a NEWER-schema revisions.json BEFORE deleting anything', async () => {
      const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
      const castPath = join(bookDir, '.audiobook', 'cast.json');
      const statePath = join(bookDir, '.audiobook', 'state.json');
      const audioFile = join(bookDir, 'audio', '01-chapter-one.mp3');
      mkdirSync(join(bookDir, 'audio'), { recursive: true });
      writeFileSync(audioFile, 'LIVE');
      writeFileSync(castPath, JSON.stringify({ characters: [{ id: 'eliza', name: 'Eliza' }] }));
      writeFileSync(revisionsPath, JSON.stringify({ schema: 2, pending: [] }));
      const stateBefore = readFileSync(statePath, 'utf8');

      const res = await request(app).post(`/api/books/${bookId}/reparse`);

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/schema=2/);
      /* FIRST, deliberately: applyReparse writes state.json synchronously in
         sequence (before its Promise.all), so this is the one check that is
         deterministically red when the preflight is missing. The cast/audio
         deletions run as Promise.all siblings and may still be in flight when
         the 500 returns. */
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
      expect(existsSync(castPath)).toBe(true);
      expect(readFileSync(audioFile, 'utf8')).toBe('LIVE');
      expect(JSON.parse(readFileSync(revisionsPath, 'utf8'))).toEqual({ schema: 2, pending: [] });
      rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    });
  ```
  (c) In `book-state.replace-manuscript.test.ts`, add these inside `describe('replace-manuscript handler', …)` (`:91`). The file already imports `readFileSync`, `existsSync` and `mkdirSync`.
  ```ts
    it('plan 285 — replace resets revisions.json to a NEW fileId and never deletes it', async () => {
      const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
      const OLD = '000000000000001-aaaaaaaa';
      writeFileSync(
        revisionsPath,
        JSON.stringify({
          schema: 1,
          fileId: OLD,
          rev: 7,
          pending: [
            { id: 'revision:1:1', chapterId: 1, characterId: 'wren', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' },
          ],
        }),
      );
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
      expect(res.status).toBe(200);
      expect(existsSync(revisionsPath)).toBe(true);
      const after = JSON.parse(readFileSync(revisionsPath, 'utf8'));
      expect(after).toMatchObject({ schema: 1, rev: 0, pending: [] });
      expect(after.fileId).not.toBe(OLD);
    });

    it('plan 285 — replace refuses a NEWER-schema revisions.json BEFORE touching the manuscript or cast', async () => {
      const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
      writeFileSync(revisionsPath, JSON.stringify({ schema: 2, pending: [] }));
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/schema=2/);
      expect(readFileSync(join(bookDir, 'manuscript.md'), 'utf8')).toBe(ORIGINAL_BODY);
      expect(existsSync(join(bookDir, '.audiobook', 'cast.json'))).toBe(true);
    });
  ```

  Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/book-state.reparse.test.ts src/routes/book-state.replace-manuscript.test.ts`
  Expected FAIL:
  - The reset tests fail with `ENOENT … revisions.json` or `expected false to be true`, because the file is deleted.
  - The refusal tests fail with `expected 200 to be 500`, because main deletes everything and succeeds.

- [ ] **Step 2: Implement in `server/src/routes/book-state.ts`**
  1. Add the import `import { assertRevisionsResettable, resetRevisions } from '../workspace/revisions-store.js';`.
  2. In the reparse route, directly after `const { bookDir, state } = located;` (`:1287`), add:
     ```ts
         /* Plan 285 — refuse a newer-schema revisions.json BEFORE anything is
            deleted or rewritten (applyReparse's state write + Promise.all). */
         await assertRevisionsResettable(bookDir);
     ```
  3. In the replace route, add the same three lines directly after `const { bookDir, state } = located;` (`:1369`). They must come before `parseManuscript`, the manuscript `writeFile` and the old-file `unlink`.
  4. Replace the revisions arm (`:1201-1203`)
     ```ts
         existsSync(revisionsJsonPath(bookDir))
           ? rm(revisionsJsonPath(bookDir), { force: true })
           : Promise.resolve(),
     ```
     with
     ```ts
         /* Plan 285 — RESET (new fileId, rev 0) through the store under its own
            leaf lock, never delete: a deleted file would read back fileId:null,
            which the PR 2 client cache treats as "older than any id". A corrupt
            file is replaced (as the rm did); a newer-schema one was already
            refused by the route's preflight. This arm sits BESIDE the
            withCastLock arm, never inside it. */
         resetRevisions(bookDir),
     ```
  5. In the comment above `withCastLock(bookDir, async () => {` (`:1144-1150`), replace
     ```
            in-lock reality — of the three sibling arms below, only the revisions
            and audio arms keep an existsSync guard (they gate an already-
            idempotent rm and acquire no lock, so no decision of theirs crosses a
            lock boundary); clearAnalysisCache's rm is unguarded too, same as this
            arm's.
     ```
     with
     ```
            in-lock reality — of the three sibling arms below, only the audio arm
            keeps an existsSync guard (it gates an already-idempotent rm and
            acquires no lock, so no decision of its crosses a lock boundary); the
            revisions arm resets revisions.json through the store under the
            per-book revisions leaf lock (plan 285), held beside this cast lock,
            never nested in it; clearAnalysisCache's rm is unguarded too, same as
            this arm's.
     ```
  6. Keep the `revisionsJsonPath` and `existsSync` imports. They are still used at `:285`, at `:790` and in the audio arm.

  The routes' existing catches already curate the error with `requestFailureMessage`. `UnsupportedSchemaError`'s message contains no path, so it passes through verbatim.

- [ ] **Step 3: Run the suites and typecheck.** `book-state.test.ts` is in the slow pool.
  ```
  npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/book-state.reparse.test.ts src/routes/book-state.replace-manuscript.test.ts src/routes/book-state.hydrate.test.ts
  npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test:slow -- src/routes/book-state.test.ts
  npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck
  ```
  Expected: all PASS / exit 0.

- [ ] **Step 4: Lock-order docs and INDEX**
  1. In `server/src/workspace/cast-lock.ts`, directly after rule 4's last line (` *      timeout.`, `:24`), insert the lines below. The key is spelled `<abs bookDir>`, never as template-literal syntax.
     ```ts
      *      The per-book REVISIONS lock (`revisions:<abs bookDir>`,
      *      revisions-store.ts, plan 285) is a LEAF outside this order: its holder
      *      writes only revisions.json and acquires no other lock, so it can never
      *      be one half of a cycle. Never take any lock while holding it.
     ```
  2. In `CLAUDE.md` (`:583-584`), replace
     ```
       order is **`design` → `library-voice` → `cast`** — never acquire an earlier
       class while holding a later one, or two requests deadlock. Since #2260 that
     ```
     with
     ```
       order is **`design` → `library-voice` → `cast`** — never acquire an earlier
       class while holding a later one, or two requests deadlock. The per-book
       `revisions` lock (`workspace/revisions-store.ts`, plan 285) is a **leaf**
       outside that order: nothing but revisions.json is written under it and no
       other lock is taken while it is held. Since #2260 that
     ```
  3. In `docs/features/INDEX.md`, add this at the end of the `### G. Generation` list:
     ```
     - [285 — revisions.json becomes server-owned (PR 1, server, dark)](285-revisions-server-ops.md) — `active`. A locked `workspace/revisions-store.ts` becomes the only reader/writer of revisions.json (`fileId`/`rev`, the schema-migrate seam, read-time normalisation, reparse/replace reset instead of delete behind a newer-schema preflight); accept/reject/dismiss become one server route each, running today's audio step (moved to `audio/previous-audio.ts`) before the JSON write; finalize gains a tri-state `review` and `review` rides the queue entry into the generation request — all dark until PR 2 cuts the client over. Fixes D1/D8 server-side; #3397/#3400 close with PR 2. Spec: `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md`.
     ```

- [ ] **Step 5: Spec sentences and release notes**
  1. In `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md`, find the paragraph that begins `The new routes and the store exist but nothing calls them. The only PR 1 changes an old client could observe are …` (line 373). Replace it with:
     ```
     The new routes and the store exist but nothing calls them. The PR 1 changes an old client could observe (the plan's Reversibility list, `docs/features/285-revisions-server-ops.md`):
     - reparse/replace **reset** the file under the lock instead of deleting it — observably the same: the old client's hydrate spreads the payload (`layout.tsx:915`) and an empty file reads like a missing one;
     - reparse/replace **refuse** a newer-schema revisions.json with a 500 **before** deleting or writing anything (main deleted it);
     - the single-book poll, the bulk poll and qa-report answer 500 for an unparseable revisions.json even when the book has no cast (main returned early and answered 200), for a newer-schema one cast or not (main answered 200), and — accepted, new — for valid JSON whose top level is not a plain object (`null`, `[]`, a string, a number), cast or not (main read every field as empty and answered 200); because the bulk route maps every book through one `Promise.all`, one such book fails the whole bulk response — the blast radius main already has for an unparseable file in a cast book;
     - D8 (pending with an empty cast) and the poll's extra fields, which the old `applyPoll`/`applyBackgroundPoll` ignore (`revisions-slice.ts:318-331`);
     - three new, uncalled routes (accept, reject, dismiss).
     ```
  2. In the same spec's Delivery list, replace line 477, `  - release notes. PR 1's are none: dark, with no shippable delta. Say so explicitly in the PR.`, with:
     ```
       - release notes. PR 1 carries one technical, operator-facing entry in `docs/release-notes-next.md` (reparse/replace refuse a newer-schema revisions.json before touching anything, and otherwise reset it rather than delete it; the polls and QA report answer 500 where they used to answer 200 — an unparseable file in a book with no confirmed cast, a newer-schema file, or a non-object top level — and one such book fails the whole bulk poll; three unused revisions routes) plus one user-facing `RELEASE_NOTES.md` line carrying only the forward-looking newer-version refusal (no user can reach it until a later version writes `schema: 2`). The bulk-poll side effect is technical-only: main already stalls the bulk poll on an unparseable file in a cast book; a book with no confirmed cast never enters the bulk request (`layout.tsx:1137-1146`); so the only newly reachable trigger is a cast book whose file has a non-object top level. Say so in the PR.
     ```
  3. In `docs/release-notes-next.md`, append this bullet at the end of the `## 🔌 Sync & server infrastructure` section. It is technical and operator-facing.
     ```
     - **Re-parse and replace-manuscript now refuse a `revisions.json` written by a newer server — before touching anything — instead of deleting it** (#3400). revisions.json now goes through the per-file schema seam (`schema-migrate.ts`) and a new server-side owner (`workspace/revisions-store.ts`, a per-book leaf lock with a `fileId`/`rev` stamp); a reparse/replace whose book carries a newer-schema file answers 500 with the "upgrade the server" message and leaves cast, audio, state and manuscript untouched, and otherwise *resets* the file (new `fileId`, empty) rather than removing it. The Revisions polls and the QA report now answer 500 in four cases where they previously answered 200: an unparseable revisions.json in a book with **no** confirmed cast (main never read the file there; a book with a cast already answered 500), a newer-schema file (cast or not), and valid JSON whose top level is not an object (`null`, `[]`, a string or a number; cast or not), and a numeric `schema` below 1 such as `0` (cast or not). One such book fails the whole bulk revisions poll, which stalls every other book's background drift badges until the file is fixed. The active book polls separately and is unaffected. The bulk poll only ever asks for non-active books that are past analysis (`layout.tsx:1137-1146` filters out `not_analysed`, `analysing`, `cast_pending`, `voices_pending`, `unreadable` and `orphaned`), so a book with no confirmed cast never enters it. Its `.then` has no `catch` (`layout.tsx` ~1153-1158), so one failing book is a silent unhandled rejection that stalls every *other* book's background drift badges. Main already does this for an unparseable file in a cast book, and the newer-schema case cannot be reached until a later version writes `schema: 2`. That leaves one newly reachable trigger in PR 1: a cast book whose revisions.json is valid JSON with a non-object top level (`null`, `[]`, a string or a number). A client catch and per-book isolation in the bulk route are owed in PR 2. The 500 carries the raw parse error or the "upgrade the server" message (neither contains a path); only a lock-acquisition timeout gets the curated contention message. Three new server routes (`POST …/revisions/{id}/accept`, `…/reject`, `POST …/drift/{id}/dismiss`) land unused — the app keeps writing revisions the old way until the client cutover (plan 285 PR 2).
     ```
  4. In `RELEASE_NOTES.md`, add this line as the first bullet under `# Castwright 1.15.0`. It matches its neighbours' voice: a bold plain-English lead, then one or two sentences.
     ```
     - **Reparsing or replacing a book is now refused, before anything is touched, if its review history was saved by a newer version of Castwright.** This is a safeguard for the future: rather than discarding that history along with the old cast and audio, Castwright asks you to update it first and leaves the book exactly as it was.
     ```
     Task 13 lists both notes in the PR body.

- [ ] **Step 6: Mutation checks.** Run `…server run test -- src/routes/book-state.reparse.test.ts`. Report each red, restore after each, and confirm the diff-stat check.
  1. Put the original `existsSync(revisionsJsonPath(bookDir)) ? rm(…) : Promise.resolve(),` arm back in place of `resetRevisions(bookDir),`.
     - Expected red: `plan 285 — resets revisions.json to a NEW fileId…`, with `expected false to be true`.
  2. Delete the reparse route's `await assertRevisionsResettable(bookDir);`.
     - Expected red: `plan 285 — refuses a NEWER-schema revisions.json BEFORE deleting anything`. `resetRevisions` still refuses inside the `Promise.all`, so the status is still 500.
     - The guaranteed red is the **`state.json` equality** (`expected '<rewritten state>' to be '<stateBefore>'`). `applyReparse` rewrites state.json at `await writeStateJsonAtomic(stateJsonPath(bookDir), { ...nextState, …` (base `~:1128`) in sequence, before the `Promise.all`.
     - The `cast.json` and audio checks may or may not also be red, depending on whether those sibling deletions finished before the 500. Do not rely on them.

- [ ] **Step 7: Commit and push**

```powershell
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/book-state.ts server/src/routes/book-state.reparse.test.ts server/src/routes/book-state.replace-manuscript.test.ts server/src/workspace/cast-lock.ts CLAUDE.md docs/features/INDEX.md docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md docs/release-notes-next.md RELEASE_NOTES.md
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "fix(server,docs): reset revisions.json through the store on reparse/replace (#3400)"
git -C C:/Claude/Projects/wt-3400-revisions-server-ops push
```

---

### Task 13: Verify, then open the PR (the final verify child)

**Lane: `claude`** (Claude Code). Run every command in this task in the foreground with the Bash tool's `timeout: 600000`. On this box, typecheck takes about 50 s and `check:cycles` about 15 s; the lint script is lane-safe too.

**Files:** none tracked are modified. The lint helper is written into your scratch dir. **Do not merge.**

**This task does not run the full batteries, and no task child does.** The reason is in Global Constraints → "Lanes and long commands". **The full batteries run in cloud `verify.yml` on the PR, which is the required, authoritative gate** (CLAUDE.md "Commit gate"). This task:
- runs the lane-sized checks;
- runs the replace refuse-before-delete test and the four mutation re-runs (single test files);
- opens the PR, whose body records the batteries as pending CI.

The coordinator then waits for a green `verify.yml` before running `pr-review-gate` and merging.

If any step fails, report it and stop. Do not fix anything inline. The coordinator dispatches a fix child.

- [ ] **Step 1: Confirm the tree is idle and clean, and refresh the base**
  1. Run `git -C <wt> status --porcelain`. Expected: empty.
  2. Run `git -C <wt> fetch origin`.
  3. Run `git -C <wt> rev-parse HEAD origin/fix/server-3400-revisions-server-ops`. Expected: the two hashes are identical, so everything is pushed.
  4. Run `git -C C:/Claude/Projects/Audiobook-Generator status --porcelain`. Expected: no entry that this run produced.
  5. Run `git -C <wt> diff --stat origin/main...HEAD`. Expected: exactly the spec, this plan, and the files named in Tasks 1–12's commit steps. Nothing else.
  6. From here on, every diff uses `git -C <wt> diff origin/main...HEAD`, never local `main`.

- [ ] **Step 2: The lane-sized checks.** Run all three in the foreground, each with `timeout: 600000`.
  1. `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck` (about 50 s).
  2. `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run check:cycles` (about 15 s). It needs network access for `npx madge@8.0.0`.
  3. **Lint exactly the changed files, and fail if nothing was linted.**
     - Don't use `npm run lint`: it is `eslint .`, which lints the whole tree.
     - Don't pass the files to the CLI from another cwd. Every file then reports "outside of base path".
     - Don't pass `src/lib/api-types.ts` explicitly either. The config ignores it (`eslint.config.mjs:51`), and an explicitly named ignored file produces a warning, which `--max-warnings 0` turns into exit 1.

     The helper below does the job. It sets the **worktree as its cwd** with `process.chdir`, so no `cd X &&` chain is needed. It then drives the worktree's own ESLint through its Node API:
     - `warnIgnored: false`, which is `--no-warn-ignored`, mirroring `scripts/hooks/pre-commit-lint.mjs`;
     - files the config ignores are dropped up front with `isPathIgnored`;
     - it reads the JSON results;
     - it asserts that the number of results equals the files passed minus those the config ignores.

     **A zero-file "green" exits 2 (FAIL).** Write it to `<scratch>/lint-changed.mjs`:
     ```js
     // Plan 285 Task 13 — lint exactly the files a diff range changed, from the
     // worktree as cwd, and FAIL if nothing was actually linted.
     // Usage: node lint-changed.mjs <worktree> [<git diff range>]   (default range: origin/main...HEAD)
     import { createRequire } from 'node:module';
     import { execFileSync } from 'node:child_process';
     import { existsSync } from 'node:fs';
     import { join } from 'node:path';

     const wt = process.argv[2];
     const range = process.argv[3] ?? 'origin/main...HEAD';
     if (!wt) { console.error('usage: node lint-changed.mjs <worktree> [range]'); process.exit(2); }
     process.chdir(wt); // ESLint's flat config resolves file paths against cwd ("outside of base path" otherwise)

     const require = createRequire(join(wt, 'package.json'));
     const { ESLint } = require('eslint'); // the worktree's own eslint, same as pre-commit-lint.mjs

     const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', range], { encoding: 'utf8' })
       .split('\n').map((s) => s.trim()).filter(Boolean);
     const lintable = changed.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(f) && existsSync(f));

     // Same flags as scripts/hooks/pre-commit-lint.mjs (`--no-warn-ignored`), via the API.
     const eslint = new ESLint({ cwd: wt, warnIgnored: false });
     const ignored = [];
     const kept = [];
     for (const f of lintable) (await eslint.isPathIgnored(f) ? ignored : kept).push(f);

     const results = kept.length ? await eslint.lintFiles(kept) : [];
     const errors = results.reduce((n, r) => n + r.errorCount, 0);
     const warnings = results.reduce((n, r) => n + r.warningCount, 0);
     console.log(JSON.stringify({ range, changed: changed.length, lintable: lintable.length, ignored, expected: kept.length, linted: results.length, errors, warnings }));

     if (kept.length === 0) { console.error('FAIL: zero files linted — a green with nothing linted is not a pass'); process.exit(2); }
     if (results.length !== kept.length) { console.error(`FAIL: linted ${results.length} of ${kept.length} expected files`); process.exit(2); }
     if (errors > 0 || warnings > 0) {
       console.log((await eslint.loadFormatter('stylish')).format(results));
       console.error(`FAIL: ${errors} error(s), ${warnings} warning(s) (max-warnings 0)`);
       process.exit(1);
     }
     console.log(`PASS: linted ${results.length} file(s), 0 errors, 0 warnings`);
     ```
     Run it with `node <scratch>/lint-changed.mjs C:/Claude/Projects/wt-3400-revisions-server-ops`.

     Expected: a JSON summary line whose `ignored` contains `src/lib/api-types.ts` and whose `linted` equals `expected`, which must be at least 1. That is followed by `PASS: linted N file(s), 0 errors, 0 warnings`, and the command exits 0.

     The plan author dry-ran this exact script against HEAD 0b24a402:
     - With the default range on the not-yet-implemented branch (docs-only diff), it printed `{"range":"origin/main...HEAD","changed":2,"lintable":0,"ignored":[],"expected":0,"linted":0,"errors":0,"warnings":0}` and `FAIL: zero files linted …`, exiting 2.
     - With range `d87ffb01^..d87ffb01`, a main commit that touches `src/lib/api-types.ts`, it printed `{"range":"d87ffb01^..d87ffb01","changed":32,"lintable":31,"ignored":["src/lib/api-types.ts"],"expected":30,"linted":30,"errors":0,"warnings":0}` and `PASS: linted 30 file(s), 0 errors, 0 warnings` in about 3.5 s, exiting 0.

  If any of the three fails, check whether it also fails on `origin/main`, per CLAUDE.md, and report the result either way.

- [ ] **Step 3: The replace refuse-before-delete test, run here.** `book-state.replace-manuscript.test.ts` is in the **fast** pool (it is not in `SLOW_FILES_TO_EXCLUDE`, `server/vitest.config.ts:35-58`). Run it with `timeout: 600000`:
  `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/book-state.replace-manuscript.test.ts -t "plan 285"`
  Expected: both `plan 285 — replace …` tests pass.

- [ ] **Step 4: PR-1 acceptance checklist.** Tick each item and give its evidence. Items marked **(CI)** cannot be confirmed in a lane: write "confirmed by verify.yml" against them, and the coordinator ticks them once CI is green.
  - [ ] **Only `revisions-store.ts` writes revisions.json.**
    - Run `git -C <wt> grep -n "revisionsJsonPath" -- server/src ':!*.test.ts'`.
    - The writers should be `revisions-store.ts` and the still-accepted PR-1 `PUT /state` revisions case in `book-state.ts`, and nothing else. Find that case by `case 'revisions':` / `await writeJsonAtomic(revisionsJsonPath(bookDir), body.patch);`.
    - `GET /state` (`}>(revisionsJsonPath(bookDir));`) still reads the file raw.
  - [ ] **The lock key is built in code in exactly one place.**
    - Run `` git -C <wt> grep -nE 'revisions:\$\{' -- 'server/src/**/*.ts' ':!*.test.ts' ``. Expect exactly one line: the `return` in `revisionsLockKey` in `revisions-store.ts`.
    - Comments must not match. The store header spells the key `"revisions:" + …` and `cast-lock.ts` spells it `revisions:<abs bookDir>`.
    - Then run `git -C <wt> grep -n "revisionsLockKey(" -- server/src ':!*.test.ts'`. Every call site should be inside `revisions-store.ts`.
  - [ ] **The revisions lock is a leaf.** Inside `revisions-store.ts`, no other lock call appears within a locked callback, and every `writeJsonAtomic` targets `revisionsJsonPath`.
  - [ ] **Schema seam.**
    - The store imports `migrateSeamDoc` and `stampSeamSchema`.
    - The `schema-migrate.ts` comments name the store as the writer that stamps.
    - **(CI)** The newer-schema, corrupt-file, non-object-top-level and preflight store tests are green.
  - [ ] **Preflight.**
    - `book-state.ts` calls `assertRevisionsResettable` in both routes before any deletion or write.
    - The **reparse** refuse-before-delete test is green; Step 5's mutation 4 pins it.
    - The **replace** refuse-before-delete test is green; Step 3 runs it.
  - [ ] **The old routes keep today's codes and order.**
    - The existing tests are unchanged. `git -C <wt> diff origin/main...HEAD -- server/src/routes/chapter-audio.test.ts` shows **only added lines**, which are the one new 409 test: no `-` lines other than the `---` file header.
    - **(CI)** The whole `chapter-audio.test.ts` file is green.
  - [ ] **Every finalize caller passes no `review`.**
    - The splice spy test is green; Step 5's mutation 3 pins it.
    - **(CI)** The QA-repair and generation spy tests are green.
  - [ ] **No new cross-layer import into generation.** `git -C <wt> diff origin/main...HEAD -- server/src/routes/generation.ts | grep "^+import"` shows only `./review-request.js`.
  - [ ] **`previous-audio.ts` does not import generation.** `git -C <wt> grep -n "generation" -- server/src/audio/previous-audio.ts` returns nothing.
  - [ ] **OpenAPI.** Every field added to an existing schema is optional, and the contract test passes. Step 2's typecheck enforces this.
  - [ ] **CLAUDE.md.**
    - It says "twenty" `requestFailureMessage` sites, and `git -C <wt> grep -n "requestFailureMessage(" -- "server/src/**/*.ts" ":!*.test.ts"` shows 20 call sites plus the definition.
    - It says "FIVE handlers" and names `applyReview`.
    - Rule 4 names the revisions leaf lock.
  - [ ] **The stale-comment fixes are present.**
    - `schema-migrate.ts`: both comments.
    - `revisions-slice.ts`: `applyPoll`.
    - The `revisions.test.ts` header.
    - Spec `:373`: the observable-changes list.
    - Spec `:477`: release notes.
  - [ ] **No restructure pending drop.** `git -C <wt> diff origin/main...HEAD -- server/src/routes/chapters-restructure.ts` is empty.
  - [ ] **No sidecar changes.** `git -C <wt> diff --stat origin/main...HEAD -- server/tts-sidecar` is empty.
  - [ ] **INDEX and release notes.**
    - INDEX has the 285 entry.
    - `docs/release-notes-next.md` has the single technical #3400 entry.
    - `RELEASE_NOTES.md` has the single user-facing line at the top of the in-progress section.
  - [ ] **(CI) Every battery is green:** typecheck, lint, test, test:server, test:server-slow, check:cycles and build. Write "confirmed by verify.yml".

- [ ] **Step 5: Re-run the four highest-value mutations.** Each is a single-file test run; use `timeout: 600000`. For each one:
  1. Make the mutation.
  2. Run the test.
     - If the red is the stated assertion, accept it on the first run.
     - If the red shows a contention signature (`Hook timed out in`, `Worker exited unexpectedly`, exit `3221226505` / `0xC0000409`), wait 60 s and re-run. If it is still contention, wait 2 minutes and retry, at most 3 runs in total. Then report `AGENT NEEDS INPUT` with the log tails.
     - Never change code to clear a contention red.
  3. Paste the red line.
  4. Restore the code and re-run. It must be green under the Green rule: exit 0, `Tests  N passed` with N ≥ 1, and no `failed`. For the `-t` run (mutation 3), use `--reporter=verbose` and confirm the `plan 285` titles appear.

  Afterwards, `git -C <wt> status --porcelain` must be empty.
  1. **Task 1 #1: lock key without `resolve`.** This is the locking invariant everything rests on. Run `…server run test -- src/workspace/revisions-store.test.ts`.
  2. **Task 4 #1: no `live_audio_missing` pre-check.** This is the only path that could delete the last copy of a take. Run `…server run test -- src/routes/revision-ops.test.ts`.
  3. **Task 8 #2: `review: null` at the splice caller.** This breaks the PR-1 dark invariant. Run `…server run test -- src/routes/chapter-splice.test.ts -t "plan 285"`.
  4. **Task 12 #2: delete the reparse preflight.** This is the one irreversible PR-1 behaviour. The guaranteed red is the `state.json` equality check. Run `…server run test -- src/routes/book-state.reparse.test.ts`.

- [ ] **Step 6: Verdict.**
  - **PASS** only if all of these hold:
    - Step 1's checks hold.
    - Steps 2 and 3 are green.
    - Every non-CI checklist item is ticked.
    - Every mutation went red and was restored to green.
  - Otherwise **FAIL**: give the reason and stop without opening a PR.

- [ ] **Step 7: Open the PR (PASS only).**
  1. Write `feat(server): server-owned revisions.json per-operation writes (dark)` to a scratch file and run `node C:/Claude/Projects/wt-3400-revisions-server-ops/scripts/validate-commit-msg.mjs <that file>`. Expected: exit 0.
  2. Write the body to a scratch file, following `.github/pull_request_template.md`:
     ```markdown
     ## Summary

     PR 1 of 2 for server-owned revisions.json (plan `docs/features/285-revisions-server-ops.md`, spec `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md` rev 9). Adds the locked revisions store (schema-migrate seam, `fileId`/`rev`), server-owned accept/reject/dismiss routes, the extracted A/B audio steps, the finalize `review` seam and the `review` queue/request plumbing — all **dark**: no caller passes `review`, no client calls the new routes, and the client remains the only writer of `pending`. Reparse/replace now reset revisions.json through the store instead of deleting it, and refuse a newer-schema file before deleting anything.

     Refs #3400
     Refs #3397

     Release notes:
     - **`docs/release-notes-next.md`** (technical, operator-facing): reparse/replace refuse a newer-schema revisions.json before touching anything, and otherwise reset it (new `fileId`, empty) rather than delete it; the Revisions polls and the QA report now answer 500 where they previously answered 200 — an unparseable revisions.json in a book with **no** confirmed cast (a book with a cast already answered 500), a newer-schema file, and valid JSON whose top level is not an object, cast or not — and one such book fails the whole bulk poll, silently stalling the other books' background drift badges (the client has no `catch`). Main already does that for an unparseable file in a cast book, and books with no confirmed cast never enter the bulk request (`layout.tsx:1137-1146`), so the only newly reachable trigger is a cast book whose file has a non-object top level. A client catch and per-book bulk isolation are owed in PR 2. Three new revisions routes land unused.
     - **`RELEASE_NOTES.md`** (user-facing): one line, forward-looking only — reparsing or replacing a book whose review history was saved by a newer Castwright is refused before anything is touched (no user can reach it until a later version writes `schema: 2`).

     ## Test plan

     - [ ] cloud `verify.yml` (required status check) — **pending**: the full batteries (typecheck, lint, test, test:server, test:server-slow, check:cycles, build) run there; they exceed a lane's per-command limit and were not run locally
     - [x] typecheck, check:cycles, and eslint on the changed files (with a linted-file-count assertion) — green locally (Task 13)
     - [x] replace refuse-before-delete test — green locally (Task 13)
     - [x] Mutation re-runs (each observed red, then restored green):
       - lock key without `resolve` → <observed red line>
       - no `live_audio_missing` pre-check → <observed red line>
       - `review: null` at the splice caller → <observed red line>
       - reparse preflight removed → <observed red line>
     - [ ] `pr-review-gate` pass (run by the coordinator once `verify.yml` is green)
     ```
     Replace each `<observed red line>` with the actual output from Step 5 before creating the PR. No placeholder may remain.
  3. Run `gh pr create --repo dudarenok-maker/Castwright --base main --head fix/server-3400-revisions-server-ops --title "feat(server): server-owned revisions.json per-operation writes (dark)" --body-file <body file>`.
  4. Do not merge. The coordinator waits for a green `verify.yml`, then runs the mandatory `pr-review-gate` pass, then merges.

- [ ] **Step 8: Report.** Include:
  - the verdict and the PR URL;
  - Step 2's three results, including the lint summary JSON line;
  - Step 3's result;
  - each checklist result with its evidence, noting which items are left to CI;
  - each mutation's observed red line.

---

## Self-review notes (plan author)

### Spec coverage

| Spec section | Task |
|---|---|
| §1 store, normalisation, `fileId`/`rev` | Task 1 |
| §1 two-phase operations | Task 2 |
| §1 reset and preflight | Tasks 1 and 12 |
| §2 audio extraction | Task 3 |
| §2 routes, errors and curation | Task 4 |
| §2 polls and D8 | Task 5 |
| §2 OpenAPI | Task 6 |
| §3 finalize tri-state | Task 7 |
| §3 SSE threading | Task 8 |
| §3 server `review` | Tasks 9 and 10 |
| §3 client `review` | Task 11 |
| Delivery (the CLAUDE.md lines, INDEX, the technical release-notes entry and the one user-facing RELEASE_NOTES.md line) | Tasks 4, 5, 7 and 12 |
| Verification and the PR | Task 13: lane-sized checks, the checklist, the mutations, the verdict and the PR. The full batteries run in cloud `verify.yml`. |
| Stale comments the work makes false (chore rule) | `schema-migrate.ts` in Task 1; `revisions-slice.ts` and the `revisions.test.ts` header in Task 5; spec `:373` and `:477` in Task 12 |

PR-2 items are deliberately absent: restore-unrecorded, the 400/410 switches, the restructure drop, caller values, and all of §4.

### Gaps the spec left open, and their resolutions (coordinator-confirmed)

1. **Corrupt file.** A parse failure **throws**, as on main. A top level that is not a plain object also throws as corrupt, never as "missing": an array, literal `null`, a string or a number. The store checks `existsSync` first, because `readJson` returns `null` both for a missing file and for one that contains literal `null`. The polls and qa-report return 500, and every store write refuses, so the store never overwrites the corrupt original. Reversibility item 3 gives the exact difference from main, including the whole-bulk-poll blast radius. The one exception is `resetRevisions` (reparse/replace), which replaces a corrupt file as the old `rm` did. In PR 1, the client's raw `PUT /state` still writes the file by design (Invariant 7).
2. **Newer schema.**
   - The store reads through `migrateSeamDoc` and stamps writes with `stampSeamSchema`.
   - A newer-schema file throws the path-free `UnsupportedSchemaError` (its own fixed message) on every read, write and reset, and is never downgraded.
   - Reparse and replace run `assertRevisionsResettable` **before** they delete or write anything. Replace's preflight also comes before its manuscript write and unlink.
3. **Missing `playable`.** A legacy entry without the flag is treated as playable, so it is kept only if `.previous.mp3` exists.
4. **No-op writes.** A drop with nothing to drop, or a repeated dismiss, neither writes nor bumps `rev`. The first store write to a legacy file mints `fileId` and sets `rev: 1`.
5. **Error-body shape.** Coded errors return `{error: code, message, state?}`. `restore_failed` carries no state. A non-coded 500 returns `{error: requestFailureMessage(...)}`, and **every new or reshaped 500 goes through `requestFailureMessage`**: revision-ops ×3, revisions ×2 and qa-report. That helper curates only a lock-acquisition timeout, whose key embeds a path. Every other error keeps its own message verbatim: the raw `SyntaxError` for a corrupt file, and `UnsupportedSchemaError`'s fixed "upgrade the server" text for a newer schema. Neither contains a path. CLAUDE.md's count is updated to the counted final number, 20.
6. **`reviewRecorded` semantics.**
   - It is absent when `review` is undefined, true when the record or drop lands, and false on failure.
   - The failure is a deliberate fifth swallow site, added to CLAUDE.md's list in Task 7.
   - The "carries no `reviewRecorded`/`reviewChapter`" tests assert the raw SSE line text. `JSON.stringify` drops `undefined`, so an unconditional `x: undefined` spread is wire-identical and not a defect. The mutations target a value-inventing default (`?? false`) instead.
7. **Malformed `review`.**
   - Enqueue and generation both return 400 `invalid_review`, and a `null` review counts as absent.
   - Generation also returns 400 `review_requires_single_chapter` unless the request names exactly one integer chapter id.
   - **Deliberate difference from `modelKey`:** the queue silently drops an unknown `modelKey` (`queue.ts:114`) but rejects a malformed `review` with 400. Dropping a review would quietly turn a review render into a plain one, which PR 2 treats as "drop the chapter's pending entry".
8. **Entry fields.**
   - Fixed values: `segments: []`, `confidence: 1`, `triggeredAgo: 'just now'`.
   - `oldDuration` is the chapter's `state.json` duration from before the write, or `''`.
   - `newDuration` is `formatDuration(durationSec)`.
   - An accept with no selection stores `{}`.
9. **QaRepairTick.** It gets `reviewRecorded` too, because the server sends the field on both completion events. The spec names only `SpliceTick`.
10. **File placement.**
    - The new routes go in `routes/revision-ops.ts`; `revisions.ts` stays the drift detector.
    - The `review` validator goes in `routes/review-request.ts`, so `generation.ts` gains no `audio/` or `workspace/` import.
    - The server's `queue-io` and finalize use the structural `{ characterId; triggeredBy }` type to avoid cross-layer imports.
11. **Server vs client claim.** The claim itself runs on the client. The server round-trip test covers enqueue → GET → `POST /:id/start`. Task 11 covers the client half: dispatcher → runner → POST body.
12. **Required vs optional on new schemas.** "Every new field optional" applies to fields added to existing schemas. `RevisionsState` and `RevisionOpError` are new schemas that only the new routes produce, and no PR-1 mock produces them, so `RevisionsState` is fully required.
13. **The `live_audio_missing` state source.** The 409's `state` comes from a fresh lock-free `readRevisions` taken after the pre-check. `chapter_busy` and `no_previous_audio` use step 1's `begin.file`, which is current to that step and made no write.

### Tests with no red-first step

Each of these passes before its change. Each one has a mutation, or is labelled a regression guard where no realistic mutation exists:

| Test | Task | Mutation, or why there is none |
|---|---|---|
| chapter-audio `409s (not 404) for an INVALID chapter id…` | 3 | Move the busy check after the parse |
| finalize `undefined: leaves revisions.json alone…` | 7 | Delete the `review === undefined` early return |
| splice `the splice_complete line carries no reviewRecorded…` | 8 | `?? false` default |
| generation `the chapter_complete line carries no reviewRecorded…` | 8 | `?? false` default |
| generation `the chapter_complete line carries no reviewChapter without review` | 10 | Unconditional boolean `reviewChapter` |
| poll `a corrupt revisions.json answers 500, as on main` | 5 | `.catch(() => emptyRevisionsFile())` on the read |
| poll `falls back to [] when persisted pending is not an array` | 5 | No realistic mutation exists. Even a non-array string iterates to non-objects that are all dropped. It is a **regression guard** inherited from #3376. |
| qa-report `configDrift is built from drift only…` | 5 | Read `pending` instead of `drift` |
| `mock-queue.test.ts` | 11 | Replace the entry spread with an explicit field list |
| `api-stream-review › omits review when not set` | 11 | Always send `review: review ?? null` |

Every other new test has a red-first step.

### Recipe dry run (plan author, 2026-10-03)

The launch and poll blocks were dry-run exactly as written, from scratch files only, with no tracked file touched. The launcher was run as `pwsh -NoProfile -File launch.ps1` and as `powershell -NoProfile -File launch.ps1`, and the poll the same way.

**Command `git --version & exit /b 3`** — both shells gave the same final poll:
- Under pwsh, the first poll was already `alive=False done=True`.
- Under 5.1, the first poll printed `alive=True done=False` / `still running -- keep polling, and IGNORE any EXIT= you can see`.
- The final poll in both: `alive=False done=True`, `EXIT=3`, `git version 2.54.0.windows.1`, `EXIT=3`.

(Historical note: the `set LOW_CONCURRENCY=1&& ` prefix below was part of an earlier draft of the rule. It is inert for a single file and is no longer used. The runs still prove that quoting and the env prefix survive `cmd.txt`.)

**Command `set LOW_CONCURRENCY=1&& node -e "console.log('Test Files  1 passed (1)'); console.log('LOW=' + process.env.LOW_CONCURRENCY)"`** — both shells gave:
- `alive=False done=True`, `Test Files  1 passed (1)`, `EXIT=0`, `LOW=1`.
- This shows that a quoted argument survives `cmd.txt`, that the env prefix reaches the child, and that the `Select-String` summary picks the line.

**Real vitest run.** The launch under `powershell` (5.1) and the poll under `pwsh` used the command `set LOW_CONCURRENCY=1&& npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/workspace/preserve-previous-audio.test.ts -t "preserve"`. The poll printed:
- `alive=False done=True`
- ` Test Files  1 passed (1)`
- `      Tests  5 passed | 1 skipped (6)`
- `EXIT=0`
- then the log tail (`> castwright-server@1.14.0 pretest` …)

### Type consistency

- `ChapterRef`, `StoredRevision` and `RevisionsState` come from Tasks 1–2 and are used in Tasks 4, 5, 7 and 12.
- `ReviewRequest` is defined twice: server-side in `routes/review-request.ts` and client-side in `src/lib/types.ts`.
- `completeLine` comes from Task 8 and is reused in Task 10.
