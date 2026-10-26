---
status: active
issue: 3711
---

# 288 — Per-book operation lock, and folder moves refused while a long job runs (#3711)

## Why

A folder-renaming `PUT /api/books/:bookId/state` can queue behind a per-book operation. As soon as that
operation releases the `state-json` lock (#3700), the rename runs — while the operation is still writing to
the folder it resolved earlier. `writeJsonAtomic` creates its parent directory, so every such write to the
vacated path **recreates the old folder**. The series then holds two folders for one book. The moved book
keeps a stale `cast.json`. The in-memory `ManuscriptRecord` points back at the old folder (the #2165 split).
A cast-slice autosave does the same with no `state.json` involved. Both probes are in the issue.

## Decisions (owner, 2026-10-18 — final)

1. A per-book operation lock, `book-op:<bookId>`, built on `withKeyLock`. A folder move or delete holds it.
2. **Quick** per-book operations hold book-op for their whole span, so a move waits for them.
3. While a **long** job is registered for the book, a rename/move is **refused** with 409 "busy, retry when
   it finishes". This generalises today's `isAnalysisBusy` refusal (`routes/book-state.ts:1120`).
   Registration happens under book-op, and the move checks the registry under book-op. Long jobs do **not**
   hold book-op while they run. Locking each write step of a long job is rejected.
4. All of it ships in one PR.

## Design

### Primitive — `server/src/workspace/book-op-lock.ts` (new)

#### `withBookOp(bookId, fn, opts?)`

Signature: `withBookOp(bookId, fn: (book: BookHandle) => Promise<T>, opts?: { hintDir?: string }): Promise<T | typeof BOOK_GONE>`.

- It acquires `withKeyLock('book-op:' + bookId)` with the default 10 s budget.
- After acquiring, it resolves the book through `resolveBook`.
- If the book is gone, it returns `BOOK_GONE` and does not call `fn`.
- Otherwise it calls `fn(book)`, where `book = { bookId, bookDir, state, held }`, and sets `held = false` in
  `finally`.
- On an acquisition timeout it does what `withStateJsonLock` does (`file-lock.ts:343-364`): logs the raw
  error, then rethrows `Error(LOCK_CONTENTION_REQUEST_ERROR)` with `code: LOCK_ACQUISITION_TIMEOUT_CODE` kept.

#### `withBookOps(bookIds[], fn: (books) => …)`

- Dedupes and sorts the ids, then chains one `withKeyLock` per id, as `withCastLocks` does
  (`cast-lock.ts:89-99`).
- Returns `BOOK_GONE` if any of the books is gone. Rejects an empty list.
- **Never nest `withBookOp`; two or more books always go through `withBookOps`.**

#### `withBookOpAtDir(dir, fn)`

- The startup sweeps' per-book step (`migrateLegacyChangeLogs`, `fsckAllBooks`). It reads the `state.json`
  at `dir`: with a `bookId` it runs `withBookOp(bookId, ({bookDir}) => fn(bookDir), {hintDir: dir})`, so a
  rename that queued ahead of the sweep hands `fn` the moved folder; a book without a `bookId` runs
  `fn(dir)` unlocked, because no route can move it. `BOOK_GONE` means the book vanished while the sweep
  queued, and the step is skipped. A throw from one book's step (its state turning unreadable under the lock,
  a lock timeout behind a slow holder) is caught by the sweep loop, logged, and skips that book only; the
  next startup retries it (PR #3714 review pass 3).

#### `peekBook(bookId, hintDir?)`

- A read-only resolve that takes **no lock**. It runs the same resolver and returns `{bookDir, state}` or
  `null`.
- It is the only sanctioned pre-lock resolve, for the two-span pattern (below). Nothing it returns may feed a
  write.
- It writes nothing that a later resolve trusts: no index update, no record heal, no backfill, and no change
  to the **duplicate-bookId verdict** (`duplicateBookIds`). An unlocked walk can see one twin while a mover
  has the other mid-rename, so only a locked resolve may add to or clear the verdict; a peek only reads it.

#### `resolveBook(bookId, hintDir?)`

A candidate is accepted only if its `.audiobook/state.json` carries `bookId`. It is read with
`readStateJsonWithRecovery`. A state that is absent or does not parse is "not this book". Any other read
failure (`EBUSY`/`EPERM`/`EIO`/`EISDIR`, which #3625's reader rethrows on purpose) is **not** absence (PR
#3714 review pass 2), but it fails only what it can change (review pass 3, **owner decision 2026-10-18**):
- on the hint or the index entry (where the book is believed to live) it fails the resolve with the path-free
  `BookStateUnreadableError` (raw error to the server log);
- the walk **skips past** an unreadable folder. A later match is returned **non-authoritatively** (no index
  write, no duplicate-verdict change) -- the same folder the unlocked `findBookBy` returns at that moment;
- unless the id is a **known duplicate** (`duplicateBookIds`, or this walk finds a second match): the
  unreadable folder may be the first twin, so the resolve fails;
- **no match** after an unreadable folder fails ("gone" is unproved), so DELETE never treats it as gone;
- an unreadable folder after the first match leaves that match non-authoritative, as before.

**Accepted residual (owner, 2026-10-18):** a legacy duplicate nobody has detected yet (no locked walk has seen
both twins) whose **first** twin is unreadable resolves to the **second** twin while the fault lasts, so a
write in that window lands in the second twin (pinned by `book-op.read-errors.test.ts` (b)). The alternative
-- failing every book that sorts after any unreadable folder, permanently, since such a book can never become
indexed -- was the pass-3 regression.

`mintBookId` / `isBookIdTaken` never refuse. An unreadable state's id is unknown and **not derivable from its
path** (a renamed book keeps its old id), so while any state is unreadable no id is proved free:
`isBookIdTaken` answers "taken" (the bundle importer then mints), and `mintBookId` appends `-u<8 hex>` -- a
suffix the `-2`, `-3`, ... counter never produces -- instead of the base or a counter id. One unreadable book
therefore never blocks an unrelated import, at the cost of an uglier id for imports made during the fault
**(coordinator call)**. `GET /state`'s series lookup (`series-cast-scan.ts`) skips an unreadable sibling the
same way and rethrows only when it finds no match.

Candidates are tried in order:
1. `hintDir`.
2. The in-memory index, `bookDirById: Map<bookId, bookDir>`.
3. A full tree walk.

The walk keeps **today's first-match behaviour**: the same order as `findBookBy`, `scan.ts:1020-1055`. If a
second match exists, it logs a warning naming both paths (server log only) and records the id as a
**duplicate**; a duplicated id is **never indexed**, so every resolve of it by id walks and gets the first
match. Only an **authoritative** locked resolve writes the index and heals the record: the index's own entry,
or a walk that found exactly one folder and read every other one. A caller's `hintDir` is not authoritative
(a sweep or walker hinting the second twin must not make it every later resolve's answer -- PR #3714 review
pass 1). **(coordinator call)**

A live `ManuscriptRecord` is healed only when `rec.bookId === bookId` **(coordinator call)**. Twin books can
share a `manuscriptId`: twins that predate #3823 (a bundle import now mints a fresh id whenever its write would add a
carrier of an id another book holds; an overwrite of a target that already carries the bundle's id keeps
it), or a hand-copied folder.

#### Sanctioned movers

These are the only code allowed to rename or remove a book folder. Each takes a `BookHandle` and throws if
`book.held` is false **or the handle is not in a module-private `WeakSet` of live handles** (so a `{ ...book }`
copy or a hand-built `{ held: true }` object is refused). This capability token replaces AsyncLocalStorage
(finding f). `moveBookFolder` also refuses a `newDir` that is not under `BOOKS_ROOT`. `removeBookFolder`
keeps the out-of-process defence: under its state-json lock it judges the handle's dir with the **recovering**
reader (#3625). A state recovered from `.bak.1` (a stranded rotation) or one that no longer parses at all is
still this book and is removed. Only a state that is **gone** (no main, no backup) or carries a **different
bookId** means the folder was moved or replaced out of process: it then re-resolves the book by id (a full
walk) and deletes it where it now lives, or resolves `'gone'` (the route answers 204) if it is nowhere.
`peekBook` writes nothing a later resolve trusts (no index update, no record heal, no backfill) and never
adds to or clears the duplicate verdict (an unlocked walk can see one twin while a mover has the other
mid-rename); only the locked resolves heal, and they apply the same lazy `audioModelKey` backfill
`findBookBy` does.

**`moveBookFolder(book, newDir, buildNext: (fresh) => BookStateJson)`** runs these steps in order:
1. Refuses with `BookBusyError(kinds)` if `bookJobKinds(book.bookId)` is non-empty.
2. Enters `withBookPathClaim`.
3. Enters `withStateJsonLock(old)`:
   - re-reads `fresh`;
   - computes `next = buildNext(fresh)`;
   - refuses with `BookPathTakenError` if `newDir` already exists.
4. Runs `mkdir(dirname(newDir))`.
5. Enters `withStateJsonLock(new)`:
   - `renameWithRetry`;
   - heals the `ManuscriptRecord` and the index;
   - writes `next` to the new `state.json`.
6. Runs `rmdir` on the old series and author directories, still inside the claim.

**`removeBookFolder(book)`**:
1. Refuses with `BookBusyError` first.
2. Runs `rm(dir, {recursive})` under `withStateJsonLock(dir)`.
3. Deletes the index entry.

Both movers' own state reads curate a read failure to `BookStateUnreadableError` (raw error to the log), so
no 500 body carries the fs error's absolute path (review pass 3).

The DELETE route's **stateless** branch (a book with no parseable state, addressed by its path-derived id)
refuses (`book_busy`) while a long job is registered under that path-derived id, then re-reads the folder
inside its state-json lock with a reader that rethrows a read failure: an unreadable state refuses the
delete, and a state that now parses to **any** real `bookId` is refused with 409 `book_changed`, job or not,
since a renamed book's job is not keyed by the path-derived id and taking that id's book-op there would invert
the lock order (review pass 3; wording corrected in review pass 4).

**Errors from the movers** (finding i):
- `EPERM`/`EBUSY`/`EACCES` → `BookFolderInUseError`. These come after `renameWithRetry`'s own retries.
- An `rm` that fails after `state.json` is already gone → `BookPartlyDeletedError`.

#### `withBookPathClaim(fn)`

- One workspace-wide key, `book-path-claim`. It is held across "is this Author/Series/Title path free →
  mkdir parents → create or rename into it".
- Holders:
  - the movers above;
  - the book creators: `import.ts`, `samples.ts`, and `importPortableBundle`.
- Creators hold it only for the collision checks, the mkdir/rename into place, and their first `state.json`
  write. **The bundle importer stages outside the claim** (see finding c).
- *(My call. It closes finding h, the id-minting race, and the creator-vs-rename path collision with one
  primitive.)*

#### `mintBookId(author, series, title)`

- Called under the claim, by **non-sample** creators only **(coordinator call)**.
- Returns `makeBookId(...)`. If no `state.json` in the workspace carries that id, it is used as-is.
- `isBookIdTaken(bookId)` is the same scan exposed on its own. The bundle importer calls it under the claim
  to KEEP an incoming bundle id when it is free, and mints only on a collision.
- Otherwise it appends `-2`, `-3`, … to the **title** slug until the id is free. This keeps `parseBookId`'s
  three parts.

#### Test hook

`__keyWaitersForTest(key)` in `file-lock.ts` generalises `__stateJsonWaitersForTest` (`:330`). The old
function stays as a wrapper.

### Busy registry — `server/src/workspace/book-jobs.ts` (new leaf; imports nothing from `routes/`)

**Where the pieces live.** The token registry itself (the `bookId → tokens` map, `bookJobKinds`, and the
internal `__addBookJobToken`) lives in **`book-op-lock.ts`**, so the movers can read it without a
`book-op-lock ↔ book-jobs` import cycle. **`book-jobs.ts` owns `runBookJob`**, the only caller of
`__addBookJobToken` (guard G5 pins that) and the only registration function it exports. `runBookJob`'s `done`
promise carries a pre-attached no-op catch, so a caller that never awaits it cannot crash the process with an
unhandled rejection; a caller that does await it still sees the rejection.

**`runBookJob(bookId, kind, fn, opts?)` — the only way to register (coordinator call).**

Signature: `runBookJob(bookId, kind, fn: (lease: BookJobLease) => Promise<T>, opts?: {hintDir}): Promise<typeof BOOK_GONE | { done: Promise<T> }>`.

What it does:
1. Under `withBookOp`, adds a unique token for `(bookId, kind)`.
2. Releases book-op.
3. **Invokes `fn(lease)` exactly once**, inside an `async` wrapper whose `finally` releases the token. The
   lease is `{ bookId, bookDir, state }`.
4. Resolves to `{ done }` as soon as `fn` has been invoked. `done` settles when `fn`'s promise settles and the
   token has been released.

Guarantees and errors:
- An early return or a **synchronous throw** inside `fn` is still released, because the wrapper is `async`.
- There is no separate `release()` to forget.
- A timed-out registration rethrows the curated contention error.
- A gone book → `BOOK_GONE`, with `fn` never called.

**No TTL** *(coordinator call)*. A TTL would release the token under a live job. If a sidecar hangs, the job
stays registered until its calls hit their own timeouts (scoring's calls are bounded by this PR, task 4). A
server restart is the only other recovery, and it clears the in-memory registry. The 409 names the kind, so
the user knows what is holding the book.

**How a route uses it:**
- **Request-scoped job** (generation SSE, splice, QA repair, single-design stream, qwen `design-voice`,
  voice-style ×2, `GET export/portable`): the whole handler body after registration is `fn`. The route
  `await`s `done`.
- **Detached job** (cast-design, script-review, `POST exports`, resume-scoring, analysis): `fn` runs the
  pre-start checks against `lease`, sends the HTTP response, then runs the job. The route `await`s only the
  registration and attaches `.catch(log)` to `done`. The old `void runX(...)` becomes
  `void runBookJob(id, kind, (lease) => runX(lease, ...))`. This closes the leak paths:
  - script-review's early returns (`script-review.ts:726,739,779,797`);
  - its throw before the inner `try`, which is only caught by the `.catch` at `:442`.
- **Children of a job that write the book** stay inside `done`:
  - Generation collects every un-awaited `afterChapterFinalized(...)` promise (`generation.ts:1974`) into
    `job.children`.
  - A `finally` around the job body awaits `drainChildren(job)` before `fn` returns. It is not a plain
    `Promise.allSettled(job.children)`: that snapshots the array, and a child pushed while the earlier ones
    are awaited would be missed. `drainChildren` loops until no new child appears. The `finally` means a
    body that throws after pushing a child still waits for it.
  - A throw out of the chapter loop (outside `processOneChapter`'s own handling) used to skip the normal-path
    `deregisterJob` / `endAllSubscribers`. A `catch` now deregisters the job, broadcasts the curated
    `chapter_failed` frame (the lock-contention sentence for a lock timeout, else "Could not start the
    render.") and `idle` to every subscriber, then rethrows.
  - The no-progress watchdog can abandon a chapter whose synth ignores abort. Once `watchdogFired`, that
    chapter returns before its finalize and again right after it, so a late-resolving synth cannot write the
    book (it could recreate a moved folder) or start scoring.
  - `triggerScoring` resolves only after scoring's own `runBookJob` registration has resolved. So when
    generation's token is released, scoring's token is already held, and no move can slip in between.
  - Any other un-awaited child that writes the book follows the same rule.
- **Never call `runBookJob` while holding book-op.** It takes book-op itself.

**Other registry API:**
- `kind`: `'render' | 'scoring' | 'analysis' | 'design' | 'script-review' | 'export'`.
- `bookJobKinds(bookId)`: a synchronous read, used only by the movers and by tests.

**Existing path-keyed registries stay.** `analysisBusy`, `designBusy` and `reviewBusy` (`tts/design-lock.ts:69-136`),
the design chains, and the generation and splice maps are unchanged. They encode different exclusions and are
not the move gate (finding l).

**Registration failures on SSE routes** — headers are already flushed (`generation.ts:756-760`), so the
failure becomes the route's existing terminal frame carrying the curated sentence **(coordinator call)**:

| Route | Frame |
|---|---|
| generation, splice, QA repair | `send({type:'chapter_failed', errorReason}); send({type:'idle'}); res.end()` — the existing shape at `generation.ts:797-800` |
| analysis | `send({kind:'error', code:'book_not_found' \| 'lock-contention', message})` |
| single-design stream | its existing `endJob` SSE terminal |

The sentences:
- `BOOK_GONE` → "Book not found."
- Timeout → `LOCK_CONTENTION_REQUEST_ERROR`.
- The busy refusal does not apply: registering is never refused, because jobs coexist.

### Quick vs long — the classification rule

- **Long:** the operation's span includes any of:
  - a model, sidecar or LLM call **with no explicit bound of a few seconds**;
  - an unbounded wait, such as a rate limiter;
  - a whole-book encode or archive.

  A long operation registers through `runBookJob` and holds no book-op.
- **Quick:** everything else that writes the book folder, **including bounded sidecar calls**. For example
  the cache evicts under `EVICT_FETCH_TIMEOUT_MS` (`qwen-voice.ts:791-819,923`) are quick **(coordinator call)**.
  A quick operation holds book-op for its whole span.

**Two-span pattern (sanctioned).** A quick operation may:
1. `peekBook` before the lock;
2. do slow, write-free preparation off that result;
3. then commit inside `withBookOp`. The commit re-resolves and re-validates. On a mismatch, **reparse only**
   answers **409 `{error, code:'manuscript_changed'}`** "The manuscript changed while it was being
   prepared — retry." Restructure drops its advisory flags instead (see the table).

The pattern is allowed per route **(coordinator call)**:

| Route | Before the lock (`peekBook`) | Re-validated inside |
|---|---|---|
| `POST /:bookId/reparse` (`book-state.ts:1476`) | `readFile` + `parseManuscript` (one re-peek and retry on ENOENT) | `manuscriptFile` + size + `mtimeMs` fingerprint; `assertRevisionsResettable` runs inside |
| `POST /:bookId/chapters/*` restructure (`chapters-restructure.ts:154-178`) | `parseForLegacyTitleFlags` (and a cold `ManuscriptRecord` hydrate) | the same fingerprint; on a mismatch the advisory title flags are **dropped silently**, with **no 409** *(coordinator call)*. The commit re-reads the record for the manuscript id the **locked** state names (`getOrHydrateManuscript`, hydrating under the lock when cold; 404 when absent), not the prepared one: a reparse it queued behind replaces the store entry (review pass 4), and a bundle overwrite replaces the book, possibly under a new manuscript id, and drops both ids' records (review pass 5). When the ids agree, the commit's read is usually the record the prep cached. The prep's hydrate runs unlocked, so it caches only when no `putManuscript` / `removeManuscript` landed on the id while it read and parsed; otherwise it takes the writer's record or reads again once (review pass 6) |
| `POST /:bookId/cover` (`cover.ts:66-91`) | candidate search + `fetchCoverJpeg` | nothing (a cover is title-independent once chosen) |
| `POST /:bookId/cover/upload` (`cover.ts:156`) | upload re-encode | nothing |
| `POST /:bookId/resume-scoring` (`qa-report.ts:56`) | early 404 / `isGenerationActive` 409 only | the chapter list comes from `lease.state` inside `runBookJob` |
| `POST /:bookId/replace-manuscript` (`:1558`) | upload parse (no disk read, no peek) | — |

| Long job | Entry point(s), wrapped in `runBookJob` |
|---|---|
| `render` | generation POST (`generation.ts:732`; the lease replaces the resolve at `:796`; the subscribe-to-existing branch returns from `fn` early); splice (`chapter-splice.ts:103`); QA repair (`chapter-qa-repair.ts:100`) |
| `scoring` | `triggerScoring` (`generation.ts:117-207`) around the whole `scoreBook`, using `lease.bookDir` and not `ctx.bookDir`; resume-scoring |
| `analysis` | main `POST /:id/analysis` (`analysis.ts:3738`) and subset `POST /:id/analysis/chapters` (`:7419`) — see finding l / item 9 below. Both run on the record for the manuscript the **lease** names, re-read inside `fn` (the request's record was captured before it queued on book-op, so an overwrite queued ahead of it may have replaced the book); a lease naming another manuscriptId refuses the start `unknown_manuscript` (review pass 6) |
| `design` | `POST /:bookId/cast/design` (`cast-design.ts:750`), `…/design-voice/stream` (`single-design.ts:235`), `…/design-voice` (`qwen-voice.ts:557`, request-scoped, `fn` = the handler's work from the resolve to its last write); voice-style generate and generate-all (`voice-style.ts:47,110`, request-scoped, `fn` = the LLM loop plus `writeVoiceStylePersona` calls; *my call: long*) |
| `script-review` | `POST /:bookId/script-review` (`script-review.ts:312`). It registers always, not only when `pinnedLocal` (`:827`). |
| `export` | `POST /:bookId/exports` (`export.ts:332`, detached: `fn` = `createExportJob`'s body plus `runExportJob`); `GET /:bookId/export/portable` (`exports-portable.ts:40`, request-scoped) |

`annotate-emotion`, `instruct-annotation` and `voice-match` **write nothing in the book** (their file headers
say so) and are not registered *(my call)*.

### Lock order

**design → library-voice → book-op → book-path-claim → cast → book → state-json**, with
**cast → cast-id-history**. (`book` arrived with #3594; see "Reconciliation with #3594's `book` lock"
below.)

These nest under book-op:
- `revision-op → revisions`;
- `listen-stats`;
- `script-review-ledger`;
- `state-json`. It is a leaf, except in `moveBookFolder`, which nests `old → new` under the claim.

Re-verified against decision 3:

- **design** (`withDesignLock`, `tts/design-lock.ts:26`; callers `qwen-voice.ts:258,466`).
  - It is held only inside design jobs, which hold no book-op.
  - Its holders still take book-op **inside** it for one reason: the series sweeps write **other** books'
    `cast.json`, and those books are not registered. The sweeps are `applyOverrideToCastFiles` /
    `persistEmotionVariant` → `forEachMatchingCastCharacter` (`voices.ts:902-937`).
- **library-voice** (callers: `voice-library.ts:1605`, assign; `:2258`, DELETE).
  - Both take book-op **inside the library-voice lock** *(coordinator wording fix)*. Assign does so for its
    one target book. The DELETE does so per book in `clearLibraryVoiceReferences` (`voice-library-usage.ts:110`).
  - Nothing that holds book-op takes library-voice: the cast PUT slice and the DELETE-assign route take
    cast only.
- **No book-op holder takes design or library-voice, or calls `runBookJob`.** Guard G2 pins this.
- **Walkers hold one book's book-op at a time.** Two-book routes use `withBookOps`. Re-entry fails at the
  10 s timeout, with the key in the log.

### Scope rules

- **One level only.** Lock at the route handler, the `runBookJob` call, or a walker's per-book step. Never
  inside a shared helper: `applyReparse`, `withVerifiedBookDir`, the cast-merge-base resolvers, or
  `finalizeChapterAudioWrite`.
- **No resolve before the lock.** Nothing calls `findBookByBookId` before `withBookOp`/`runBookJob`, except
  `peekBook` in the two-span routes above.
- **Walkers.**
  - `forEachMatchingCastCharacter`'s multi-book branch and `clearLibraryVoiceReferences` keep discovering
    books by tree walk.
  - Each book's write runs as `withBookOp(state.bookId, b => withCastLock(b.bookDir, …), {hintDir: dir})`.
    Inside the step, the walker **re-applies its scope filter to `b.state`**, so a sibling renamed out of the
    series is skipped.
  - A book whose `state.json` lacks `bookId` gets the write **under its cast lock as today, without book-op**
    *(coordinator call)*. `findBookBy`'s predicate (`state.bookId === bookId`, `scan.ts:964`) can never match
    such a book. No route resolves it, so the API cannot move it, and there is no move race. This is no
    regression: the book still receives the write.
  - The `onlyBookDir` branch (`voices.ts:877`) takes no book-op. Its documented precondition: the caller
    holds book-op for that book, or is that book's registered job.
  - **Callers of the multi-book branch hold no book-op.**
- **Two-book routes.** `cast-link-prior` (`:120`), `cast-not-linked-to` (`:89,193`) and
  `library-cast-override` (`:98`) use `withBookOps([a,b], ([A,B]) => withCastLocks([A.bookDir,B.bookDir], …))`.
- **Series loops.** `cast-series-patch` (`:158`) and `voice-override-linked` (`:152`) take one `withBookOp`
  per sibling. **The sibling's resolve happens inside that step**, through the handle and never through a
  `findBookByBookId` in the loop body *(coordinator call; guard G3b)*.

### Behaviour (what the client sees)

Every refusal body is `{ error: <sentence>, code: <code> }`, with the sentence in `error` **(coordinator call)**.
The frontend already surfaces `error` verbatim.

| Situation | Response |
|---|---|
| Rename while a long job is registered | **409** `code:'book_busy'`. For analysis, the sentence stays verbatim (`book-state.ts:1125`). Other kinds: "This book is busy (rendering audio / scoring audio / designing voices / reviewing the script / exporting). Wait for it to finish before renaming it — a rename now would split the book across two folders." It is checked before the path-collision 409 (`code:'book_path_taken'`), as today. |
| DELETE while a long job is registered | **409** `code:'book_busy'` "This book is busy (…). Stop it or wait for it to finish, then delete it." *(My call: refuse.)* |
| Reparse while a long job is registered | **409** `code:'book_busy'` "This book is busy (…). Stop it or wait for it to finish, then re-parse it." Checked FIRST inside `book-op`, before the newer-schema revisions refusal (#3717). |
| Replace-manuscript while a long job is registered | **409** `code:'book_busy'` "This book is busy (…). Stop it or wait for it to finish, then replace its manuscript." Checked FIRST inside `book-op`, before the newer-schema revisions refusal (#3717). |
| Chapter restructure (merge / split / reorder / bulk exclude AND bulk include / rename / refresh-titles) while a long job is registered | **409** `code:'book_busy'` "This book is busy (…). Stop it or wait for it to finish, then change the chapters." Checked FIRST inside `applyRestructure`, the `withBookOp` callback's first statement, ahead of the restructure-gate claim and the `book` lock (#3774). Any `BookJobKind`, analysis included. |
| Single-chapter EXCLUDE (`excluded: true`) while a long job is registered | **409** `code:'book_busy'` "This book is busy (…). Stop it or wait for it to finish, then exclude chapters." Checked FIRST inside `book-op`, ahead of the chapter lookup and the audio delete (#3774). Include (`excluded: false`) deletes no audio and is NOT refused by the server (operator decision, PR #3779 review). The Generate view disables its Include button (and Retry / Accept smaller cast on an include-origin error row) while `GET /api/books/:bookId/busy` (lock-free read of `bookJobKinds`) reports any job or this tab's own subset run is live, and shows the reason as a line on the row. Every route into the include flow re-reads `/busy` at click time before the include POST and refuses (toast, nothing sent) while busy or while this tab's own run is live; it fails closed, so a read that errors also refuses. While an include's subset run is live the view disables the controls that start a job on this book (Resume generation, Regenerate, Regenerate all, a chapter's Generate / Retry / Regenerate, per-character Regenerate, and the QA card's Resume scoring) with a visible reason. That block is derived from the store's analysis snapshot (`activeStream`: this book, `kind: 'subset'`, `subsetOrigin: 'include'`, running), not from component state, and the origin is the SERVER's record: the subset start POST carries `origin` (`include` | `reanalyse`, default `reanalyse`), the job keeps it, and `GET /api/books/:bookId/analysis/state` reports it as `subsetOrigin` for a live run (not persisted); the layout's per-book hydrate and the stream middleware's refusal re-read both copy it into the snapshot, so the block survives the view remounting, a book switch and back, a reload and a second tab. In the tab that started the include it also holds until a Cancel / failure rollback settles (a module-level, per-tab pending flag, because the snapshot goes paused / halted before the lease is released); another tab is not held through the rollback. A block that comes from the store alone (a reload or a tab opened mid-run, where the stream that would end it died with the old page) ends with the run's lease: a hydrate that finds no live subset run drops a stale include snapshot for the book once it has been quiet for 30 s, and the Generate view's `/busy` poll, which also runs while the block comes from the store, clears it when `/busy` reports no `analysis` job and the snapshot has been quiet for more than 30 s (`isStaleIncludeSnapshot`, shared by both). A registered run always reports `analysis`, so it is never cleared; a run that has NOT registered yet reports nothing either (the job registers after the include POST, the subset POST and their bounded waits), so quiet time only counts once the snapshot has registration evidence (`serverConfirmed`: a server tick landed on it, it was rebuilt from the server's own answer by the hydrate or the middleware restore, or `/busy` reported `analysis` while it was held), and the Generate view never clears while its own include request is pending; a snapshot that never gets that evidence (the clicking tab closed before the job registered, leaving another tab's unconfirmed broadcast copy) is dropped once it is more than 2 minutes old (`UNCONFIRMED_INCLUDE_MAX_MS`, counted from the click) while `/busy` shows no `analysis` job; a hydrated snapshot's `lastTickAt` is the server's clock, so a client clock behind the server delays the end; Resume is enabled again within about 30 s plus one poll of the run ending. A re-analyse run (`subsetOrigin: 'reanalyse'`) never blocks. The click-time `/busy` read is bounded (8 s, then it fails closed) and the include does not start if the view was left during it. The 5 s `/busy` poll runs only while some row can show an include-flow button or the block comes from the store snapshot. Within the Generate view an Include → Cancel rollback therefore meets only the include's own subset run, which Cancel stops with `/analysis/pause`. Not gated, because they start jobs from outside the Generate view (any job started outside it): the queue modal, the layout-level regenerate confirm, the Listen view's export and fix-line splice, the manuscript view's starts (including script review), the routes view's starts, the Cast drawer's voice design, and the Listen view's own QA card (Resume scoring) and QA repair render; a job started from one of those during an include still makes the rollback give up after 20 s with a gap note (and a toast while the view that started the include is still mounted). |
| DELETE of a gone book | **204** (idempotent, unchanged: `book-state.ts:1787-1790`) *(coordinator call)* |
| DELETE half-done (`rm` failed after `state.json` was gone) | **409** `code:'book_partly_deleted'` "The book was removed from your library, but some of its files in its folder are still open in another program and were left behind. Close that program and delete the leftover \"<title>\" folder by hand." It does **not** advise a retry *(coordinator call)*. |
| Waiter resumes after an in-process move | It continues on the moved folder (200/204). |
| Waiter resumes after a delete | **404** "Book not found." For a job start: the SSE frame above. |
| Rename/delete queued behind a quick op for more than 10 s | The existing curated **500** `LOCK_CONTENTION_REQUEST_ERROR`. |
| Rename/DELETE hits `EPERM`/`EBUSY` while `state.json` is still present | **409** `code:'book_folder_in_use'` "The book's folder is in use (for example a chapter is playing or open in another program). Close it and retry." No path in the body. |
| Reparse prep raced a manuscript change | **409** `code:'manuscript_changed'`. Restructure never refuses for this: it drops its advisory title flags. |

**Frontend — no code change.**
- Rename: `realPutBookState` unwraps `error` (`src/lib/api.ts:2475-2497`). The `bookMeta/commitDraft` toast
  strips the envelope and rolls back (`src/store/persistence-middleware.ts:74-90`).
- Delete: `realDeleteBook` (`api.ts:5224-5235`) → `showError` (`src/routes/index.tsx:149-151`).

**OpenAPI.** The `PUT /api/books/{bookId}/state` 409 description (`openapi.yaml:4004`) gains the new codes.
`DELETE /api/books/{bookId}` is added (task 9). Then run `npm run openapi:types`.

## Findings addressed

**a. Finalize's ebur128 hold — moot.**
- Finalize takes no book-op.
- Its only callers are registered render jobs: `generation.ts:1912`, `chapter-splice.ts:528`, `chapter-qa-repair.ts:790`.
- A move is refused for the whole registration.
- Its `state.json` stamp keeps its absent-refusal (`state-migrate.ts:152-173`) as out-of-process defence.

So it needs no lock against moves. Reparse and replace-manuscript are closed by #3717, and the chapter
restructure routes and the single-chapter exclude toggle by #3774: all are refused with 409 `book_busy`
while a long job is registered. Restructure's older analysis-only gate (`beginRestructure`, code
`analysis_running`) stays: its claim half is what refuses an analysis START mid-restructure, and its probe
still answers for an analysis job that has no `runBookJob` lease (a hand-registered one in a test).

**b. Restructure's unbounded `withBookLock` (`chapters-restructure.ts:72-99`) is deleted.**
- It is replaced by book-op, with the **10 s budget kept** *(my call)*.
- The slow parse leaves the lock through the two-span pattern (reparse, restructure, replace-manuscript).
- What remains under book-op is filesystem work: cache clear, `rm audio/`, slug renames (`:248`), and
  `rebuildCacheFromEdits`. That is seconds even on large books.
- A pathological queue gets the curated 500 instead of an unbounded wait.

**c. Duplicate bookIds.**
- **Existing duplicates are not refused** *(coordinator call)*. Resolution keeps today's first-match choice,
  plus a server-log warning naming both paths. They stay editable, renamable and deletable as today. No
  regression.
  - **Caveat:** a duplicate created **out of process after its id was indexed** (for example a copied folder
    that sorts earlier) is not seen: the indexed folder still verifies, so resolves keep answering it (no
    walk runs) until a restart or a removal drops the index entry, while the unlocked first-match GET may show the earlier
    copy. Repairing duplicates is #3713.
- **New duplicates cannot be minted:**
  - `import.ts:379` and the bundle importer's fresh and `rename` paths (`scan-import-folder.ts:140,217`) call
    `mintBookId` under the claim.
  - A bundle whose `state.bookId` is taken elsewhere gets a minted id.
  - A rename keeps its bookId, which is now safe, because no creator can re-mint it.
- **Samples keep their deterministic id** *(coordinator call)*. The tour hardcodes it (`src/lib/tour-steps.ts:21`;
  mock `SAMPLE_BOOK_ID`, `src/lib/api.ts:1214`).
  - Today `samples.ts:90` detects "already loaded" **by path**.
  - This PR changes it to **by bookId anywhere on disk** (`resolveBook`). A renamed sample then counts as
    loaded (`{bookId, alreadyLoaded:true}`) instead of being copied in a second time under the same id.
  - The path check stays too, under the claim.
- **Overwrite import keeps the existing book's bookId** *(my call)*. Exact sequence *(coordinator call)*:
  1. Stage every entry into `<workspace>/.staging/<nonce>/`. This is outside `books/` and on the same
     volume, with **no lock and no write under `books/`**.
  2. Read the existing target's `state.json` **unlocked** → `existingId`.
  3. Run `withBookOp(existingId)`. On `BOOK_GONE`, fall back to the fresh-import path. On
     `bookJobKinds(existingId)` non-empty, refuse with a 409 `book_busy`.
  4. Enter `withBookPathClaim`.
  5. Re-check that the target path still carries `existingId`. If not, refuse with the existing
     `BundleConflictError`.
  6. Rewrite the staged `state.json`'s `bookId` to `existingId`.
  7. Run the per-file renames from staging over the live files. This replaces the bare `withStateJsonLock`
     at `:351`, and holds `state-json(target)` as today.
  8. Release, then `rm` the staging directory.
- **Fresh and `rename` bundle imports:**
  1. Stage into `.staging/`.
  2. Under the claim only: collision check → `mintBookId` → `mkdir` the parents → **one directory rename** of
     the staged tree into place *(coordinator call: stage before the claim)*.
- **Containment**: the importer does not rely on yauzl alone refusing `..` entry names. A bundle-supplied
  `state.manuscriptFile` or `audio/` entry name that resolves outside the staging or book folder is an
  `InvalidBundleError` (`scan-import-folder.containment.test.ts`). The author, series and title it supplies go
  through `bookDirByDisplay`, which already sanitises each segment and asserts containment under
  `BOOKS_ROOT` (`workspace/paths.ts`; no change was needed there).
- **Staging cleanup** *(coordinator call)*: `sweepStaleStaging` (`workspace/portable-staging.ts`, `STAGING_MAX_AGE_MS`
  = 1 h) removes `<workspace>/.staging/` entries older
  than 1 h. It is **awaited before the server accepts imports**: it runs before `listen` in `index.ts`,
  costs one `readdir`, and an entry under an hour old is kept, because it may belong to a live import.
- **Folders without `state.json`** never resolve, as today (404).
- **Repair of existing duplicates is filed as its own issue.** The decision owed: which copy keeps the id,
  and how queue, backup (`bookBackupsDir(bookId)`) and series references move.

**d. Cross-book writers — all take book-op per book:**
- `cast-tier` (`cast-tier.ts:38`) and `voices PUT /:voiceId/override` (`voices.ts:784`) go through the
  walker step.
- The design sweeps also go through the walker step, inside `withDesignLock`.
- `cast-link-prior`, `cast-not-linked-to` ×2 and `library-cast-override` use `withBookOps`.
- `cast-series-patch` and `voice-override-linked` use per-sibling steps.
- Voice-library assign: library-voice → `withBookOp` → cast (`voice-library.ts:1605-1958`).
- `DELETE /:voiceUuid/assign` (`:2039`): `withBookOp` → cast.
- `POST /promote` (`voice-library.ts:1021`): the book is resolved and its `cast.json` read inside one
  `withBookOp`, which is then released before the copy and the library-entry write. Promote never writes the
  book (the origin `cast.json` is untouched), so the lock only guarantees it does not read a vacated path
  and answer a spurious "No character".
- `DELETE /:voiceUuid` (`:2255`): library-voice → the per-book step.

No caller of a multi-book walker holds book-op, so there is no re-entry.

**e. Writers outside the mutating `/:bookId` routes.**
- `GET /:bookId/export/portable` (`exports-portable.ts:79-85`) is a request-scoped `export` job.
- `migrateLegacyChangeLogs` (`index.ts:197`) and `fsckAllBooks` (`index.ts:216`) stay fire-and-forget. Each
  book's step runs through `withBookOpAtDir(dir, fn)` (= `withBookOp(state.bookId, …, {hintDir})`). A book without a `bookId` is processed
  unlocked, because it cannot be moved through the API *(my call)*.
- `backgroundFetchCover` (`import.ts:460`): the fetch runs outside, and the write runs inside one `withBookOp`.
- The GET-time backfill in `findBookBy` (`scan.ts:1163`) is already safe: it writes through
  `updateStateJsonLocked` (absent → skip), and the mover holds `state-json(old)`.

**f. AsyncLocalStorage tracking — dropped, with no runtime order check.** These replace it:
- the `BookHandle.held` capability check;
- the 10 s timeout's named error (#2260);
- the guard;
- the tests.

Fire-and-forget children cannot produce false positives. They now run inside `runBookJob`'s `fn`, after
book-op is released.

**g. Mixed keying — harmless.** A path key goes wrong only if the path changes while the key is held or queued.
- Under book-op, only a mover changes the path, and it holds book-op exclusively.
- Under a registered job, moves are refused.
- GET backfills take `state-json(old)`, which the mover also holds.

What remains is out-of-process moves. That is pre-existing, and #3706's absent-state refusals and
`withVerifiedBookDir` still cover it.

**h. The empty-parent `rmdir` race (`book-state.ts:1204-1211`) is fixed by `withBookPathClaim`.** The mover's
`rmdir` and every mkdir+rename-into-a-series-directory run under the claim.

**i. Windows directory rename with open files.**
- It fails after `renameWithRetry`'s ~1.8 s schedule (`atomic-rename.ts:22`). The open files come from
  express.static streaming, an external player, or a clip's ffmpeg.
- Decision 3 removes the in-process render and export holders.
- Today the failure is a **500 carrying the raw `EPERM … 'C:\…'` message** (`book-state.ts:1240`). That is a
  pre-existing path leak over the LAN. It is **fixed here** with the curated 409 `book_folder_in_use`.
- A half-done `rm` gets the `book_partly_deleted` 409 (above).
- A crash-safe, staged DELETE is **filed, not fixed**. It needs a design pass: where the trash directory
  lives, and the boot-time recovery.

**j. `resolveBook` fast path.**
1. `hintDir` (walkers and sweeps).
2. Else the index, written only by an **authoritative** locked resolve (the index's own entry, or a walk
   that found exactly one folder and read every other one) and by the movers. A duplicated id is never
   indexed.
3. Either way, verified by **one** `state.json` read.

It falls back to the O(N) walk only on a miss or a verification failure. An autosave of a uniquely-held id is
O(1) after the first resolve, **but only while every folder in the library reads**: a walk that skipped an
unreadable `state.json` is non-authoritative and writes no index entry, so while any folder is unreadable a
not-yet-indexed id walks the library on every resolve (review pass 4). A **duplicated** id walks on every
resolve.

**k. Guard** — see below. The blind spots are listed there. The allowlist ends with only `no-book-write`,
`cross-book-walker` and `job-lease` entries, so no no-op wraps are needed.

**l. Path-keyed busy registries** (`cast-design.ts:793-799`, `single-design.ts:252`, `analysisBusy`)
**stay correct**, because the path cannot change while their job is registered.

**Analysis specifics** *(coordinator calls)*:
- `job.bookDir` comes from **`lease.bookDir`**, not `record.bookDir` (`analysis.ts:4029`). `markAnalysisBusy`
  keys on it.
- `runBookJob`'s registration `await` sits **after** the awaits at `:3939-3943` and **before** the
  synchronous re-check window `:3948-4046`. That keeps #3004's window `await`-free.
- The join and refusal paths return from `fn` immediately, which releases the token.
- **The lease is released only when the job's tracked units actually settle:** `endJob`, then `liveWork`
  drains to 0. It is **not** released at `MAIN_DRAIN_DEADLINE_MS` (`analysis.ts:3011`, timer `:3696`).
  - `releaseBusyAndPin` keeps firing at the deadline for the busy flag and the pin.
  - `fn` awaits a separate `drained` promise, resolved when `liveWork === 0 && ended`.

The #2165 residual is **closed**: registration and move exclude each other under book-op. The comments at
`book-state.ts:1142-1160` and `analysis.ts:3711-3720` are rewritten, and the second `isAnalysisBusy`
re-check is deleted.

A job whose folder is deleted or renamed **out of process** keeps its token until it settles. Its writes
behave as they do today.

## Guard — `server/src/workspace/book-op-lock.guard.test.ts`

It uses the same opaque-range tokenizer as `state-json-lock.guard.test.ts`. The allowlist is keyed on file
**and** count. Each check has a negative-control fixture that must fail.

- **G1 movers.** Outside `book-op-lock.ts`, a `rename(`, `renameWithRetry(`, `rm(`, `rmdir(` or `cp(` whose
  first argument is `bookDir`, `located.bookDir`, `book.bookDir`, `dir` or `old(Series|Author)Dir` fails.
- **G2 handlers.** These handlers are checked:
  - every `POST`/`PUT`/`PATCH`/`DELETE` whose path starts with `/:bookId`, in both single-line and
    multi-line `router.x(\n '/:bookId…'` forms;
  - `/:id/analysis*`;
  - `GET /:bookId/export/portable`;
  - the enumerated workspace-level writers: `voices PUT /:voiceId/override`, voice-library assign
    POST/DELETE and `DELETE /:voiceUuid`, `library-cast/override`, and the portable import.

  The rule:
  - Each must contain `withBookOp(`, `withBookOps(` or `runBookJob(`, or carry an allowlist entry
    `{file, route, reason}`.
  - The reasons are `no-book-write`, `cross-book-walker` and `job-lease` (the handler writes the
    book only on behalf of a live job whose lease is held: `POST /:id/analysis/pause`).
  - Inside a `withBookOp*` callback, `runBookJob(`, `withDesignLock(` and `withLibraryVoiceLock(` are
    forbidden.
  - Entries carry `pending:T<n>` during the PR. The final assertion is that none remain.
- **G3 resolve-before-lock.**
  - **G3a.** In a guarded handler, no `findBookByBookId(`/`findBookByManuscriptId(` outside a
    `withBookOp*`/`runBookJob` callback. `peekBook(` is allowed **(coordinator call)**.
  - **G3b.** In `cast-series-patch.ts`, `voice-override-linked.ts`, `voices.ts` and
    `voice-library-usage.ts`, no `findBookByBookId(` token anywhere inside a `for`/`while` body. Siblings
    resolve through the step's handle.
- **G4 multi-book.**
  - Every `withCastLocks(` sits inside a `withBookOps(` callback.
  - In `voices.ts` and `voice-library-usage.ts`, every `withCastLock(` sits inside a `withBookOp(` callback,
    except the `onlyBookDir` branch (count 1).
- **G5 long-job registration.** Each long-job file has a declared per-file minimum count of `runBookJob(`
  tokens **only** *(coordinator call)*. The files: `generation.ts`, `chapter-splice.ts`,
  `chapter-qa-repair.ts`, `qa-report.ts`, `analysis.ts`, `cast-design.ts`, `single-design.ts`,
  `qwen-voice.ts`, `voice-style.ts`, `script-review.ts`, `export.ts`, `exports-portable.ts`. Also
  `book-jobs.ts` exports no other registration function.

**Blind spots** (covered by tests and the review catalogue, not the guard):
- aliased imports or re-exports;
- a captured `bookDir` used after a callback returns;
- a new long job in a file G5 doesn't list;
- an un-awaited book-writing child left outside `done`;
- a writer reached through a helper (call-graph-blind);
- a quick op misclassified as `no-book-write`;
- the right lock with the wrong id;
- a `peekBook` result fed into a write.

## Tasks (one PR; each test-first — write the failing test, then make it pass)

1. **Primitive and registry.**
   - Files: `workspace/book-op-lock.ts`, `workspace/book-jobs.ts`, `file-lock.ts` (`__keyWaitersForTest`).
   - Unit tests: `book-op-lock.test.ts`, `book-jobs.test.ts`.
   - Guard scaffold: G1-G5, with today's allowlist as `pending:T<n>`.
   - Accept when:
     - FIFO works;
     - a waiter after a move gets the new `bookDir`;
     - `BOOK_GONE` after a delete never calls `fn`;
     - the hint/index path verifies the bookId and falls back;
     - a duplicate resolves to the first match and logs a warning;
     - the record heal is skipped when `rec.bookId !== bookId`;
     - `withBookOps` sorts, dedupes and rejects an empty list;
     - a timeout is curated and keeps `code`;
     - a released handle makes the movers throw;
     - `runBookJob` releases when `fn` **throws synchronously**, **returns early**, rejects or resolves;
     - a gone book is never registered;
     - `peekBook` takes no lock;
     - `mintBookId` suffixes.
2. **Movers in `book-state.ts`.**
   - PUT state → `moveBookFolder`. Every slice runs under `withBookOp`.
   - DELETE → `removeBookFolder`. Drop the three-attempt loop (`:1801-1811`). `BOOK_GONE` → 204.
   - Write the 409 bodies with `code`.
   - Tests in `book-op.rename-probes.test.ts`. **P1/P2 must fail on `main` on the assertion, not on an import**
     *(coordinator call)*:
     - **Gating.** The test gates with what exists on `main`: it holds `withCastLock(bookDir, …)` from
       `cast-lock.ts`, exactly as the issue's probe did.
     - **Waiting.** It is timing-free. It reads `__keyWaitersForTest` through a namespace import
       (`const fl = await import('../workspace/file-lock.js'); const keyWaiters = (fl as Record<string, unknown>).__keyWaitersForTest`).
       - On `main` (property undefined), it waits for the rename's own response to settle. That is
         immediate there, because nothing blocks it.
       - On the branch, it polls `keyWaiters('book-op:<id>') === 1`.
     - It then releases the gate, awaits both requests, and asserts.
     - **P1** (reparse vs rename) asserts: one folder; no old folder; the change-log is in the new folder;
       no stale `cast.json`; the record is healed.
     - **P2** (cast autosave vs rename) asserts: the new `cast.json` is in the new folder; no old folder.
     - On `main`, both fail at "old folder recreated" / "stale `cast.json`". Record that red run in the PR body.
   - Also test:
     - P2-reverse;
     - delete-then-waiter → 404, nothing recreated;
     - DELETE of a gone book → 204;
     - EPERM → 409 `book_folder_in_use` with no path in the body;
     - half-delete → 409 `book_partly_deleted`;
     - the `rmdir` race (renames out of and into one series) lands both.
   - Update `book-state.rename-analysis-busy.test.ts` to register through `runBookJob`. Its "registers after
     the first check" case becomes "an analysis registration queued behind a rename starts on the new folder".
3. **The rest of `book-state.ts`, restructure and backup restore.**
   - Two-span reparse (with the `manuscript_changed` 409 test) and restructure (test: a fingerprint
     mismatch drops the flags and the restructure still succeeds).
   - Replace-manuscript.
   - Exclude, held, listen-progress, listen-stats, shelf-status.
   - Delete `withBookLock`.
   - `backup.ts` restore.
   - Accept when each has a test that a rename queued behind it lands everything in the new folder.
4. **Long jobs through `runBookJob`.** Cover every row of the long-job table, the SSE failure frames,
   generation's `job.children` + `allSettled`, `triggerScoring` resolving after its registration, and
   analysis's `drained` release.
   - **Scoring bound** *(coordinator call)*. The audition synth (`audition-centroid.ts:184`) and
     `embedSegment` (`tts/embed-client.ts:72-85`) are unbounded today: embed-client keeps its header and body
     timeouts unlimited on purpose (`:30`). Bound each call with `AbortSignal.timeout(SYNTH_CALL_TIMEOUT_MS)`,
     the existing per-call ceiling (`tts/synthesise-chapter.ts:167`; 600 000 ms default, env
     `SIDECAR_CALL_TIMEOUT_MS`; export it). A timeout counts as the existing non-terminal transient
     (`aggregate.ts:282`). Render's own embed calls are not changed.
   - Tests through **real entry points**, with the job gated by the existing mocks:
     - rename gets 409 during render (generation POST), design (`cast/design`), the script-review run and
       export (POST + GET portable);
     - DELETE gets 409 during render;
     - the registry is empty after the failure, early-return and success paths, including script-review's
       `:726`-style early returns;
     - a rename attempted just as a render's last chapter finalizes is refused (scoring already holds);
     - an analysis whose deadline fired still holds the lease until `liveWork` drains;
     - a scoring call that never returns times out and releases;
     - an analysis start after a delete → SSE error, nothing registered.
5. **Single-book quick routes.**
   - The routes: `cast-create`, `cast-add-from-roster`, `cast-aliases` ×3, `cast-link-orphan`,
     `cast-merge-suggestions` ×2, `cast-reject-orphan` ×2, `cast-merge`, `revision-ops` ×3, the
     `chapter-audio` previous routes ×2, cover ×4 (two-span where listed), the `script-review`
     discard/resolve/selection routes, and `qwen-voice` promote/discard/emotion-variant DELETE (quick: their
     evicts are bounded).
   - Accept when their G2 pending entries are gone and each file family has one "rename queued behind it" test.
6. **Cross-book.** Implement:
   - the `withBookOps` routes;
   - the walker step with the scope re-check; a book without a `bookId` gets the cast-lock-only write
     (test: it still receives the write);
   - the series loops (G3b);
   - voice-library assign and DELETE.

   Tests:
   - link-prior vs a rename of the other book;
   - a walker vs a sibling rename;
   - a sibling renamed out of the series mid-walk is skipped;
   - voice-library DELETE vs a rename;
   - `voice-library-write-seam.guard.test.ts` and `voice-library-usage.test.ts` stay green.
7. **Creators and ids.** Implement:
   - claim + `mintBookId` in `import.ts`;
   - samples detection by bookId;
   - the bundle importer (staging outside `books/`, the overwrite sequence, fresh/rename by one directory rename);
   - `backgroundFetchCover`'s write step;
   - the startup sweeps, per book.

   Tests:
   - rename A/S/T→T2, then import A/S/T → distinct ids, both resolve;
   - a renamed sample → `alreadyLoaded`, no second copy, and the tour id still resolves;
   - a bundle id used elsewhere → minted;
   - an overwrite keeps the id and is refused while busy;
   - an overwrite whose target changed id → conflict;
   - an overwrite whose target `state.json` cannot be read → the curated `BookStateUnreadableError`, nothing
     replaced, the id kept (review pass 4; a parse failure still reads as "no id");
   - a cover fetched after a rename lands in the new folder;
   - a sweep queued behind book-op writes to the moved folder;
   - the staging sweep removes entries older than 1 h, keeps younger ones, and runs before `listen`.

   File the "repair existing duplicate bookIds" issue, naming the decision.
8. **Incidental — `cast/tier` on a standalone updates nothing** *(coordinator call; fix here)*.
   - The cause:
     - `findAuthorSeriesForBookId` returns `{author, series}` for a standalone too (`series-cast-scan.ts:68-73`);
     - `cast-tier.ts:37` passes that as the series filter;
     - the walker then skips every standalone, the anchor included (`voices.ts:910`).
   - The fix:
     - `applyTierToCastFiles` gains an `onlyBookDir` parameter (it passes it through to `forEachMatchingCastCharacter`);
     - when `isStandalone`, `cast-tier` calls it with no filter and `onlyBookDir = book.bookDir`, inside
       `withBookOp` (the `onlyBookDir` precondition);
     - series books keep the walker path.
   - Regression test: a standalone tier pin is persisted (red before the fix). No other book with the same
     `voiceId` is touched.
9. **Incidental — document `DELETE /api/books/{bookId}`** in `openapi.yaml`: 204, 409 `book_busy` /
   `book_folder_in_use` / `book_partly_deleted`, 500. Then `npm run openapi:types`. The existing
   openapi-parity tests stay green.
10. **Close the guard and the docs.**
    - Guard: no `pending:` entries remain, and the negative controls fail.
    - CLAUDE.md lock bullet: the order, the quick/long rule (bounded sidecar calls are quick), `runBookJob`
      only, the two-span pattern with `peekBook`, never nest `withBookOp`.
    - The `cast-lock.ts` header, rule 4.
    - The `file-lock.ts` nesting note (book-op adds one level; voice-library DELETE goes library-voice →
      book-op → cast, per book).
    - The `tts/design-lock.ts` header.
    - Reviewer-brief entry 29: an addendum, "fixed for moves by `book-op` + `book-jobs`, PR #…".
    - Reviewer-brief **new entry 39** (originally 30; renumbered after #3594 added 30–38): "a book-folder writer outside `withBookOp` and outside a `runBookJob`
      `fn` (an un-awaited child, a registration released at a deadline, a resolve before the lock)".
      Checkable: hold book-op or a job, queue a rename, and assert that it waits or gets 409.
    - The PUT state 409 description.
    - `docs/release-notes-next.md`.
    - `RELEASE_NOTES.md`: "Renaming or deleting a book while it's rendering, analysing, designing voices,
      reviewing or exporting now asks you to wait, instead of quietly splitting it across two folders."
    - The `docs/features/INDEX.md` row.
    - Run `npm run verify:fast:branch`.

## Acceptance

- P1/P2 fail on `main` at their assertions and pass on the branch.
- Every long-job kind refuses rename and DELETE with 409, with the folder unchanged.
- A rename queued behind any quick op lands every write in the new folder and recreates no old path.
- Every job's token is released on every exit path, including a synchronous throw, an early return and an
  analysis past its drain deadline. A scoring call cannot hold the token past `SYNTH_CALL_TIMEOUT_MS`.
- No new duplicate bookId can be created. Existing duplicates behave as today, plus a warning.
- A standalone `cast/tier` pin persists.
- These stay green: `book-state.absent-state.test.ts`, `book-state.concurrent-state.test.ts`,
  `book-state.rename-analysis-busy.test.ts` (updated), `analysis.rename-midrun.test.ts` (unchanged
  out-of-process defence), and every cast-lock, state-json-lock and voice-library guard/race suite.
  `npm run check:cycles` passes.
- The guard allowlist holds only `no-book-write`, `cross-book-walker` and `job-lease` entries.
- **No on-box acceptance is owed.** Every behaviour is provable by fault injection.

## Reconciliation with #3594's `book` lock

#3594 (#3400, merged to `main` as 4c109a86 while this PR was open) added a second per-book lock,
`withBookLock` (`workspace/book-lock.ts`), and a reparse-busy marker. Merging `main` into this branch
kept both locks and removed the marker.

**One combined order:** `design → library-voice → book-op → book-path-claim → cast → book → state-json`,
with `cast → cast-id-history`, and `revision-op → revisions`, `listen-stats` and
`script-review-ledger` under book-op.

The two locks do different jobs:
- **book-op** is the operation-and-move lock (this plan).
- **`book`** is the narrower state.json / manuscript-edits.json consistency lock. It is keyed by
  bookId, re-entrant within one async context, has no acquisition timeout, and is always taken
  **inside** book-op (or by a path that holds no book-op, such as the workspace scan's self-heal).

Two invariants hold everywhere: no `book` holder takes book-op, and no path takes `book` before `cast`.

Where each path sits:
- **PUT `/state`:** `withBookOp` stays outermost. The `cast` slice keeps `withCastLock` (book-op →
  cast, never under `book`). The `manuscript` slice and a non-moving `state` write take
  `withBookLock` → `state-json`. A move calls `moveBookFolder` without `book` held;
  `moveBookFolder` takes `withBookLock` itself, inside the path claim (book-op → book-path-claim →
  book → state-json), so a `book`-only writer (the scan heal, `updateStateAtDir`) cannot interleave
  with a move.
- **Chapter restructure:** the two-span prep, then `withBookOp` → #3594's `beginRestructure` gate →
  `withBookLock` → `applyRestructureClaimed` (using the handle's `bookDir`).
- **Reparse / replace-manuscript:** the two-span flow under `withBookOp`; inside `applyReparse`,
  #3594's `withLocatedBook` locked step (book-op → book → state-json) and its backstop stay.
- **Exclude / held toggles:** `withBookOp` → `withBookLock` → `updateStateJsonLocked`.
- **`restore-unrecorded`:** `withBookOp` → #3594's `hasPendingForChapter` (409 `has_revision`) →
  `revision-op` → restore. The legacy `DELETE …/audio/previous` keeps #3594's 410 `moved`.

**Owner decision (2026-10-19): a rename during a reparse or replace-manuscript waits, then
succeeds.** book-op already covers the whole destructive commit, so #3594's refusal machinery is
redundant and was removed: `markReparseBusy` / `clearReparseBusy` / `isReparseBusy`
(`tts/design-lock.ts`), `locateAndMarkReparseBusy`, `answerAbsentOrMoved`, the
`REPARSE_UNSTABLE_409` / `REPARSE_MOVED_409` sentences, the `busyDir` clear, and the PUT's
reparse/analysis 409s (`moveBookFolder`'s `assertNotBusy` covers analysis with `book_busy`).
These stay, as defence against a move made outside the server: the backstop in `applyReparse`'s
locked step (`fresh.bookDir !== bookDir → null`, now answered 409 `book_moved`, "This book was moved
while it was being re-parsed. Reload and try again.", when the book still resolves elsewhere, and 404
only when it is gone), analysis's
`assertWriteTargetStable`, and `restructure-gate.ts`.

Pinned by `book-state.replace-manuscript-rename.test.ts` (a queued rename waits, then lands at the
new folder, and the old path is never recreated), `book-op-lock.test.ts` (a `book`-only holder
excludes `moveBookFolder`), and `chapters-restructure.test.ts` (book-op → gate → book).

## Out of scope

- Repair of pre-existing duplicate bookIds (filed, with the decision owed).
- A crash-safe staged DELETE (filed, finding i).
- Quick ops racing a running long job on the same book. That is pre-existing and not a move.
- Out-of-process moves and deletes. The existing #3706 and `withVerifiedBookDir` defences stay.

## Ship notes

_(fill on merge)_
