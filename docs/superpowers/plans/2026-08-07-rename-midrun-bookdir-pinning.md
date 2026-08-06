# Refuse a book rename mid-analysis, and let the merge base follow one anyway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A book rename (`PUT /api/books/{bookId}/state`, `slice: 'state'`, when
Author / Series / Title changes the on-disk folder) is **refused with a 409 while
an analysis is registered for that book**, and the analysis run's own
directory-pinned write sites resolve the book directory **at write time** rather
than from a string copied at job start — so a rename that ever did reach a live
run cannot recreate the pre-rename directory and split the book's state across
two folders.

**Architecture:** Two layers, deliberately overlapping.

- **Layer 1 — the guard (primary).** `server/src/routes/book-state.ts`'s rename
  branch calls `isAnalysisBusy(bookDir)` (`server/src/tts/design-lock.ts`) and
  returns `409` before it moves anything. That registry is already ref-counted
  per `bookDir` and already refuses a bulk cast-design for exactly this reason
  (`server/src/routes/cast-design.ts:684`), so the machinery is proven and the
  cost on a normal rename is one `Map.get`. **No lock is taken** — it is a pure
  predicate, so it cannot interact with the documented
  `design → library-voice → cast` lock order.
- **Layer 2 — the follow (defence in depth).** `createCastMergeBase` takes a
  `() => string` accessor instead of a `string`, and `writeChecked` resolves the
  directory once per call. In `analysis.ts` a small `liveBookDir(job)` helper
  re-reads the manuscript record so `writeAnalysisState` / `deleteAnalysisState`
  follow a rename too. `markAnalysisBusy` / `clearAnalysisBusy` stay **pinned**
  on purpose — see [Design decisions](#design-decisions).

**Tech Stack:** TypeScript (Node 20 ESM), Express + supertest, Vitest,
`server/src/workspace/cast-lock.ts`, `writeJsonAtomic`, React + RTK on the
frontend, `openapi-typescript` for the generated client types.

**Issue:** `Closes #2165`
**Design source:** issue #2165's body plus its design-investigation comment
(the comment corrects the body twice and is the authoritative version).
**Status:** draft — not started.

---

## Global Constraints

Every task's requirements implicitly include these.

- **The decision is made. Do not re-open it.** Option 3 (refuse with 409) is the
  primary fix; option 1 (the merge base follows the rename) is defence in depth.
  Option 2 (pin-and-refuse at each write site) is rejected and must not reappear
  in any form — no per-write-site directory comparison, no "abort the run"
  concept.
- **A *waiting* rename is out of bounds.** The guard refuses; it never blocks,
  queues, or retries. Holding anything across a multi-minute analysis is the one
  variant of this design that is genuinely dangerous.
- **The 409 must fire only when the folder actually moves.** The guard goes
  *inside* `if (newDir !== bookDir)`. The persistence middleware autosaves
  `slice: 'state'` patches (`castConfirmed`, `prosodyEnabled`,
  `prosodyAnnotated`, notes, tags) continuously, including during an analysis;
  none of those move a folder and all of them must keep returning 204. A guard
  hoisted above that branch breaks normal use of the app during every analysis.
- **The fingerprint baseline is path-independent — do not "fix" it.** It is a
  sha256 of `cast.json`'s raw bytes (`server/src/workspace/cast-fingerprint.ts`)
  and every advance is `fingerprintOfWrite(payload)`, derived from the payload.
  A directory rename carries the bytes across intact, so at the new path the
  observed fingerprint still equals the baseline: no phantom
  `cast_merge_base_stale`, no missed detection. Issue #2165's body claims
  otherwise; its own follow-up comment retracts that. Adding any
  path-awareness to the baseline is out of scope and wrong.
- **Cast-lock rule 2 stays intact.** In `writeChecked`, resolve the directory
  **once**, before `withCastLock`, and use that same value for both the lock key
  and the path. Resolving twice would let the lock key and the write path
  disagree.
- **`markAnalysisBusy` / `clearAnalysisBusy` are a matched pair.** They mutate a
  ref-counted `Map<string, number>`. Marking under one key and clearing under
  another leaks the first entry forever *and* underflows the second. Neither
  call may be routed through a live accessor.
- **Assert outcomes, not mechanisms.** "cast.json is at the new path and the old
  directory does not exist" is the assertion. "the call site passes a function"
  is not — it passes vacuously.
- **`--retry=0` on every verification run.** `retry: 1` is live in this repo and
  has produced a false green (#2028).
- **`server/src/routes/book-state.test.ts` is in the slow tier**
  (`server/vitest.config.slow.ts`'s `SLOW_FILES`) and is therefore **skipped by
  `npm run test:server`**. This plan deliberately puts the new guard tests in a
  *new* file so they run in the fast tier. Do not "consolidate" them into
  `book-state.test.ts` — that would move the primary fix's coverage out of
  pre-push and out of the scoped fast lane.
- **Never `--no-verify`.**

---

## File Structure

Files this plan touches. Line numbers are as verified on `main` @ the branch
point; if a number has drifted, locate the site by the quoted anchor text.

```
server/src/workspace/cast-merge-base.ts          MODIFIED  createCastMergeBase signature + writeChecked
server/src/workspace/cast-merge-base.test.ts     MODIFIED  14 call sites updated + 1 new case
server/src/routes/analysis.ts                    MODIFIED  liveBookDir() helper; 6 read sites
server/src/routes/analysis.rename-midrun.test.ts NEW       defence-in-depth regression (2 cases)
server/src/routes/book-state.ts                  MODIFIED  the 409 guard + one import
server/src/routes/book-state.rename-analysis-busy.test.ts  NEW  the guard's regression (3 cases)
openapi.yaml                                     MODIFIED  putBookState's 409 description
src/lib/api-types.ts                             REGENERATED  npm run openapi:types
src/lib/api.ts                                   MODIFIED  realPutBookState error extraction
src/lib/api-put-book-state-error.test.ts         NEW       wire-level error-message test
docs/release-notes-next.md                       MODIFIED  technical register entry
RELEASE_NOTES.md                                 MODIFIED  brand-voice line
docs/superpowers/plans/2026-08-07-rename-midrun-bookdir-pinning.md  MODIFIED  Ship notes
```

**Not touched, with reasons:**

- `docs/testing/onbox-acceptance-register.md` — **no row.** Every behaviour here
  is provable in-process: an Express app over a `mkdtemp` workspace, a stub
  analyzer, and a `renameSync`. No GPU, no sidecar, no real analyzer, no real
  book is involved at any point. There is nothing a box could show that the
  suite does not.
- `docs/features/INDEX.md` — no entry. `INDEX.md` indexes `docs/features/`
  plans; a scoped server bug-fix plan living under `docs/superpowers/plans/`
  does not get one (precedent:
  `docs/superpowers/plans/2026-08-06-cast-merge-base-serialise-and-detect.md`,
  which has no INDEX entry either).
- `e2e/` — no Playwright spec. The change crosses no router / redux / layout
  seam: it alters the *text* of an error toast that already exists and already
  has coverage (`src/routes/index.test.tsx`, "surfaces an error toast and leaves
  the menu re-openable when putBookState rejects"). And e2e runs mock-only —
  `mockPutBookState` never issues a 409, so a spec could not reach the new path
  without inventing mock-side machinery for it.
- `server/src/workspace/cast-lock.guard.test.ts` — no change needed. The guard
  is deliberately syntactic and already cannot see `cast-merge-base.ts`'s write
  (it uses an extracted path variable, `const path = castJsonPath(bookDir)`,
  which the occurrence regex does not match — documented in that file's own
  FALSE NEGATIVES list, lines 95–112). Task 1 keeps that shape, so the guard's
  allowlist arithmetic is unchanged. Confirm it still passes; do not edit it.

---

## Design decisions

Recorded here so the implementer does not re-litigate them.

### Does the plan also fix `job.bookDir`'s three consumers?

**Yes for two of them, deliberately no for the third.**

`AnalysisJob.bookDir` (`analysis.ts:2304`) is a string copy taken at job creation
(`analysis.ts:2750` main, `:5487` subset). It drives:

| Consumer | Sites | Disposition |
|---|---|---|
| `writeAnalysisState(job.bookDir, …)` | `:2409`, `:2436` | **Fixed** — routed through `liveBookDir(job)` |
| `deleteAnalysisState(job.bookDir)` | `:2565` | **Fixed** — routed through `liveBookDir(job)` |
| `markAnalysisBusy` / `clearAnalysisBusy(job.bookDir)` | `:2764`, `:5501`, `:2596` | **Left pinned, on purpose** |

**Why fix the first two.** They are the highest-frequency damage in the whole
defect: `persistRunningSnapshot` fires on a ~5-second throttle for the entire
run, so a slipped-through rename resurrects the old directory *repeatedly*, not
once — and `deleteAnalysisState` then misses the real file, leaving a stale
`running`→`paused` snapshot that `scanActiveAnalyses` later surfaces as a
resumable analysis for a book that finished. Both follow from one four-line
helper and are covered by the same test fixture the merge-base regression needs,
so the marginal cost is one assertion. "Defence in depth" that only defends one
of the three disk writes is not defence in depth.

**Why the busy pair must stay pinned.** `markAnalysisBusy` / `clearAnalysisBusy`
mutate a ref-counted `Map<string, number>` (`design-lock.ts`). A live accessor
would let `clearAnalysisBusy` run under a different key than the `markAnalysisBusy`
that paired with it: the old key's count never drops to zero (leaked forever, and
`isAnalysisBusy(oldDir)` stays true for the process's life) while the new key
underflows to `<= 0` and is deleted, releasing a guard that a sibling job may
still hold. Pinning is the *correct* behaviour for a matched pair — this is the
one of the four sites that is not defective.

The obvious alternative — a `renameAnalysisBusy(oldDir, newDir)` re-key called
from the rename branch — is **rejected as unreachable code**: layer 1 refuses the
rename precisely when the registry is non-empty for that book, so the re-key
could only ever run in the case it is not needed. Adding it would be a
permanently-untestable branch.

### Is there any path that renames a book without going through the 409?

**Verified: no, not in-process.** `renameWithRetry(bookDir, newDir)` at
`book-state.ts:848` is the only site in `server/src` that moves a *book
directory* — every other `renameWithRetry` caller moves a file within a book
(`cover/store.ts`, `cover/upload.ts`, `export/sync-folder.ts`,
`routes/chapter-audio.ts`, `routes/export.ts`, `routes/exports-portable.ts`,
`workspace/changelog-migrate.ts`, `workspace/fsck-orphan-audio.ts`,
`workspace/preserve-previous-audio.ts`, `audio/rewrite-chapter-slugs.ts`).
`rec.bookDir = newDir` at `book-state.ts:856` is likewise the only assignment to
a record's `bookDir` outside record construction.

One gap remains and is **explicitly out of scope**: a user (or OneDrive, or
Explorer) renaming the folder *outside* the process. That bypasses the guard,
but it also bypasses `rec.bookDir = newDir`, so the in-memory record is stale
and layer 2 does not help either — the whole record is wrong, not just one field.
That is a separate, pre-existing problem with a different shape (workspace
re-scan / record invalidation), not a variant of this one. Do not attempt it
here; if the implementer wants it tracked, file it as its own `bug` issue rather
than widening this branch.

### Release notes: yes, both files

This ships a **new user-visible refusal**. Renaming a book is a benign-feeling
action and blocking it reads as a bug unless it is explained — which is exactly
the strongest argument the design investigation raised against option 3. The
counter-measure is telling the user, in the release notes and in the message
itself, that the refusal is transient and self-clearing. Both
`docs/release-notes-next.md` (technical register, PR-refed) and `RELEASE_NOTES.md`
(brand voice, v1.15.0 section) get an entry, per Before-shipping checklist step 5.

### Frontend: in scope, narrowly

`realPutBookState` (`src/lib/api.ts:2338`) throws
``Book state PUT failed (${res.status}): ${await res.text()}``. The message
reaches the user verbatim — `BooksRoute`'s `onEditBook` handler
(`src/routes/index.tsx:149-157`) passes it straight into `showError`, and that is
the **only** funnel: `EditBookMetaModal` is rendered by `library-grid.tsx:428`
and `library-table.tsx:435`, both of which route through `onEditBook` in
`views/book-library.tsx` → `routes/index.tsx`. So the failure is *not* silent
today. What it is, is developer-grade: the user would read

> Book state PUT failed (409): {"error":"Analysis is running for this book. …"}

Task 4 extracts the `error` field. This is in scope **because this PR creates the
refusal** — shipping a new 409 whose message renders as a JSON envelope is
shipping the defect, not inheriting it. It is six lines, it improves the two
pre-existing 409s on the same route for free, and no test asserts the current
string (verified: the literal appears only at `src/lib/api.ts:2346`).

---

## Task 1 — `createCastMergeBase` resolves the book directory at write time

**Files:**
- `server/src/workspace/cast-merge-base.ts` (modify)
- `server/src/workspace/cast-merge-base.test.ts` (modify)

**Interfaces:**

```ts
export function createCastMergeBase(
  resolveBookDir: () => string,
  capturedFingerprint: string | null,
): CastMergeBase;
```

The parameter becomes an accessor **only** — not `string | (() => string)`. A
union would leave a `typeof` branch in the hot path forever; a single shape makes
"someone passed a pinned string again" a compile error, which is the cheapest
possible guard.

**Steps:**

- [ ] 1.1 In `server/src/workspace/cast-merge-base.ts`, change the signature and
      add the doc comment:

  ```ts
  /**
   * @param resolveBookDir Resolves the book's CURRENT directory. #2165 — a
   *   `string` captured here would be pinned for the life of the run, and a
   *   rename mid-run (`book-state.ts`'s `rec.bookDir = newDir`) could not reach
   *   it; `writeJsonAtomic` mkdir's its parent, so the write would not fail —
   *   it would recreate the pre-rename directory and drop cast.json where
   *   nothing reads it.
   */
  export function createCastMergeBase(
    resolveBookDir: () => string,
    capturedFingerprint: string | null,
  ): CastMergeBase {
  ```

- [ ] 1.2 In `writeChecked`, resolve once at the top and use that value for both
      the lock key and the path. Replace the opening of the method body:

  ```ts
      async writeChecked(payload, onConflict) {
        /* #2165 — resolved ONCE per call, before the lock is taken, so the lock
           key and the write path can never disagree. Re-resolving inside the
           hold would let a rename land between them.

           The baseline needs no adjustment for a move: it is a sha256 of
           cast.json's raw BYTES (cast-fingerprint.ts) and every advance below
           is `fingerprintOfWrite(payload)` — derived from the payload, never
           from a path. A rename carries the bytes across intact, so at the new
           path the observed fingerprint still equals the baseline: no phantom
           conflict, no missed detection. The ABSENT/markDeleted path is
           likewise unaffected — an absent file is still absent after a move. */
        const bookDir = resolveBookDir();
        await withCastLock(bookDir, async () => {
          const path = castJsonPath(bookDir);
  ```

  Everything below `const path = …` is unchanged.

- [ ] 1.3 In `server/src/workspace/cast-merge-base.test.ts`, update all 14
      existing construction sites from `createCastMergeBase(dir, …)` to
      `createCastMergeBase(() => dir, …)`. They are at lines 55, 81, 100, 127,
      145, 167, 185, 204, 221, 233, 247, 309, 336, 337 (the last two are the
      `a` / `b` pair in the serialisation describe). Purely mechanical — no
      other change to those cases.

- [ ] 1.4 Extend that file's fs/path imports to cover the new case:

  ```ts
  import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, renameSync, readFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { basename, dirname, join } from 'node:path';
  ```

- [ ] 1.5 Append the new describe block to
      `server/src/workspace/cast-merge-base.test.ts`:

  ```ts
  describe('createCastMergeBase — the directory is resolved at WRITE time (#2165)', () => {
    it('a rename between two writes lands cast.json in the NEW directory and does not recreate the old one', async () => {
      const oldDir = makeBookDir();
      const newDir = join(dirname(oldDir), `${basename(oldDir)}-renamed`);
      let current = oldDir;
      try {
        writeFileSync(castJsonPath(oldDir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
        const base = createCastMergeBase(() => current, await captureOf(oldDir));
        const onConflict = vi.fn();

        await base.writeChecked({ characters: [{ id: 'a' }, { id: 'b' }] }, onConflict);

        /* Exactly what book-state.ts does on a rename: move the folder, then
           point the record at the new path. */
        renameSync(oldDir, newDir);
        current = newDir;

        await base.writeChecked(
          { characters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
          onConflict,
        );

        expect(existsSync(castJsonPath(newDir))).toBe(true);
        expect(JSON.parse(readFileSync(castJsonPath(newDir), 'utf8')).characters).toHaveLength(3);
        /* The resurrection assertion — the whole of #2165 in one line. */
        expect(existsSync(oldDir)).toBe(false);
        /* And no phantom conflict: the fingerprint is over bytes, not a path,
           so the move carries the baseline across intact (design correction 1). */
        expect(onConflict).not.toHaveBeenCalled();
      } finally {
        rmSync(oldDir, { recursive: true, force: true });
        rmSync(newDir, { recursive: true, force: true });
      }
    });
  });
  ```

- [ ] 1.6 Run `cd server && npx vitest run src/workspace/cast-merge-base.test.ts --retry=0`.
      All existing cases plus the new one green.

**Paired test:** `server/src/workspace/cast-merge-base.test.ts` — "a rename
between two writes lands cast.json in the NEW directory and does not recreate the
old one".

**The mutation that makes it fail:** hoist the resolve out of `writeChecked`
back to the factory body (`const bookDir = resolveBookDir();` immediately after
`let baseline = …`). The second write then goes to the captured `oldDir`,
`writeJsonAtomic` mkdir's it back into existence, and **both**
`existsSync(oldDir)` (now `true`) and the 3-character length assertion at
`newDir` (file absent → `readFileSync` throws) fail.

**Deliverable:** `cast-merge-base.ts` compiles with the accessor signature; its
whole suite is green including the new regression.

- [ ] 1.7 Commit: `fix(server): resolve the cast merge base's book directory at write time`

---

## Task 2 — `analysis.ts` wires the accessor and follows a rename for `analysis-state.json`

**Files:**
- `server/src/routes/analysis.ts` (modify)
- `server/src/routes/analysis.rename-midrun.test.ts` (new)

**Interfaces:**

```ts
/** The job's CURRENT book directory, or null when it has no workspace book. */
function liveBookDir(job: AnalysisJob): string | null;
```

**Steps:**

- [ ] 2.1 Extend the store import at `server/src/routes/analysis.ts:10`:

  ```ts
  import { getManuscript, getOrHydrateManuscript } from '../store/manuscripts.js';
  ```

- [ ] 2.2 Insert the helper immediately above `persistRunningSnapshot`
      (i.e. above the `async function persistRunningSnapshot(` at ~`:2401`, after
      the `ANALYSIS_STATE_WRITE_THROTTLE_MS` constant):

  ```ts
  /* #2165 — the job's CURRENT book directory. `job.bookDir` is a string copy
     taken at job creation; renaming the book mid-run mutates the
     ManuscriptRecord in place (book-state.ts's `rec.bookDir = newDir`) but
     cannot reach that copy, so a disk write keyed on it recreates the
     pre-rename directory and lands the file where nothing reads it. Re-read
     the record instead.

     Falls back to the pinned copy when the record has been dropped from the
     store (`removeManuscript`, e.g. a reparse mid-run): a possibly-stale
     directory is still strictly better than skipping the write, and it is
     exactly today's behaviour.

     NOT for markAnalysisBusy/clearAnalysisBusy. Those are a matched pair over
     a ref-counted Map; clearing under a different key than the one marked
     would leak the old entry forever AND underflow the new one, releasing a
     guard a sibling job may still hold. The busy key stays pinned — and
     book-state.ts's #2165 guard is what keeps it correct, by refusing the
     rename while the analysis is registered. */
  function liveBookDir(job: AnalysisJob): string | null {
    return getManuscript(job.manuscriptId)?.bookDir ?? job.bookDir;
  }
  ```

- [ ] 2.3 In `persistRunningSnapshot` (~`:2401`), replace the first line and the
      write target:

  ```ts
  async function persistRunningSnapshot(job: AnalysisJob, force: boolean): Promise<void> {
    const bookDir = liveBookDir(job);          // #2165
    if (!bookDir) return;
    const phase = job.replay.lastPhase;
    if (!phase) return;
    const now = Date.now();
    if (!force && now - job.lastDiskWriteAt < ANALYSIS_STATE_WRITE_THROTTLE_MS) return;
    job.lastDiskWriteAt = now;
    try {
      await writeAnalysisState(bookDir, {
  ```

  The snapshot object literal and the `catch` are unchanged.

- [ ] 2.4 In `persistTerminalSnapshot` (~`:2428`), the same two edits:

  ```ts
  ): Promise<void> {
    const bookDir = liveBookDir(job);          // #2165
    if (!bookDir) return;
    const phase = job.replay.lastPhase;
    try {
      await writeAnalysisState(bookDir, {
  ```

- [ ] 2.5 In `endJob`'s terminal branch (~`:2564`), keep the outer
      `if (job.bookDir)` — that is the "this job has a workspace book at all"
      test, and the pinned copy answers it correctly — and change only the
      delete target:

  ```ts
        if (job.kind === 'main') {
          /* #2165 — the CURRENT directory, not the pinned copy: deleting the
             pre-rename path leaves the real analysis-state.json behind, and
             scanActiveAnalyses later offers it as a resumable analysis for a
             book that finished. */
          const dir = liveBookDir(job);
          if (dir) void deleteAnalysisState(dir);
        }
  ```

- [ ] 2.6 Leave `markAnalysisBusy(job.bookDir)` (`:2764`, `:5501`) and
      `clearAnalysisBusy(job.bookDir)` (`:2596`) **exactly as they are.** Add a
      one-line comment at `:2596` so the asymmetry is not read as an oversight:

  ```ts
    /* Pinned deliberately (#2165) — mark/clear must use the same key or the
       ref count leaks on one side and underflows on the other. */
    if (job.bookDir) clearAnalysisBusy(job.bookDir);
  ```

- [ ] 2.7 Wire the main-path merge base (`:3020`):

  ```ts
      const castBase: CastMergeBase | null = recordRef.bookDir
        ? createCastMergeBase(
            /* #2165 — live, not pinned. The `!` is sound: the ternary already
               proved bookDir non-null, and bookDir only ever goes non-null →
               non-null (issue #2165's "Why it wasn't caught"). */
            () => liveBookDir(job) ?? recordRef.bookDir!,
            priorSnapshot.fingerprint,
          )
        : null;
  ```

- [ ] 2.8 Wire the subset-path merge base (`:5618`) the same way — note the
      record is named `record` in `runSubsetAnalyzerJob`, not `recordRef`:

  ```ts
    const castBase: CastMergeBase | null = record.bookDir
      ? createCastMergeBase(
          () => liveBookDir(job) ?? record.bookDir!,   // #2165 — live, not pinned
          priorSnapshot.fingerprint,
        )
      : null;
  ```

- [ ] 2.9 Create `server/src/routes/analysis.rename-midrun.test.ts`. It is
      modelled directly on `server/src/routes/analysis.fresh-cast-lock.test.ts`
      — read that file first. **What it reuses from that shape:** the tmpdir
      `WORKSPACE_DIR` set *before* any workspace-touching module is imported;
      the three `vi.hoisted`/`vi.mock` stubs (`ollama-health`,
      `gpu/analyzer-device-state`, `analyzer/select-analyzer`) that keep
      `runMainAnalyzerJob` off any real Ollama/GPU boundary; `buildSelection` /
      `setPhase1Selection` / `buildPhase1Analyzer`; the hand-built `AnalysisJob`
      literal cast with `as unknown as AnalysisJob`; and above all the
      **hanging Phase-0 analyzer gate** — a `runStage1Chapter` that awaits a
      promise the test resolves — which is what gives the test a deterministic
      mid-run window to act in. **What it does differently:** the mid-run act is
      a `renameSync` + a record mutation instead of a concurrent HTTP request,
      and it does not need the `state-io` `readJson` interceptor at all, so that
      `vi.mock` is dropped.

  ```ts
  /* #2165 — the DEFENCE-IN-DEPTH layer. book-state.ts now refuses a rename
     while an analysis is registered (see
     book-state.rename-analysis-busy.test.ts), so this file deliberately does
     NOT go through the route: it performs the rename the way book-state.ts
     would (renameSync + `rec.bookDir = newDir`) directly against a live run,
     and asserts that even a rename that somehow reached a running job cannot
     resurrect the pre-rename directory.

     Shape borrowed wholesale from analysis.fresh-cast-lock.test.ts: a real
     workspace-backed book in a tmpdir, the three analyzer/GPU mocks that keep
     runMainAnalyzerJob off any real boundary, and a stub Phase-0 analyzer that
     hangs on a gate so the test owns a deterministic mid-run window. */

  import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
  import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
  import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
  import type { AnalysisJob } from './analysis.js';

  const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
    detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
    setLastKnownAnalyzerDeviceMock: vi.fn(),
  }));
  vi.mock('./ollama-health.js', () => ({ detectOllamaDevice: detectOllamaDeviceMock }));
  vi.mock('../gpu/analyzer-device-state.js', () => ({
    setLastKnownAnalyzerDevice: setLastKnownAnalyzerDeviceMock,
  }));
  vi.mock('../analyzer/select-analyzer.js', async () => {
    const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
      '../analyzer/select-analyzer.js',
    );
    return {
      ...actual,
      selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
        const g = globalThis as Record<string, unknown>;
        if (opts.phase === 'phase1' && g.__analyzer_device_test_phase1_selection) {
          return g.__analyzer_device_test_phase1_selection;
        }
        return actual.selectAnalyzerForPhase(
          opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
        );
      },
      isPerPhaseModelSelectionActive: () => false,
    };
  });

  const AUTHOR = 'Rename Midrun Author';
  const SERIES = 'Standalones';
  const OLD_TITLE = 'Rename Midrun Book';
  const NEW_TITLE = 'Rename Midrun Book Renamed';
  const CHAPTER_BODY = 'Nova said the plan out loud.';

  let workspaceRoot: string;

  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-rename-midrun-test-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  });

  function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
    return { analyzer, engine: 'gemini', model, fallbackModel: null };
  }

  function buildPhase1Analyzer(): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () => Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(_manuscriptId: string, chapterId: number): Promise<Stage2ChapterOutput> {
        return {
          sentences: [
            { id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: CHAPTER_BODY },
          ],
        };
      },
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  /* Seeds a workspace book + its in-memory ManuscriptRecord and returns the
     pieces each case needs. Fresh manuscriptId per case so the module-level
     job maps and the manuscript store can't leak between them. */
  async function seedRunnableBook(): Promise<{
    manuscriptId: string;
    oldDir: string;
    newDir: string;
    job: AnalysisJob;
    releasePhase0: () => void;
    phase0Selection: AnalyzerSelection;
  }> {
    const manuscriptId = `test-rename-midrun-${Date.now()}-${Math.random()}`;
    const oldDir = join(workspaceRoot, 'books', AUTHOR, SERIES, OLD_TITLE);
    const newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_TITLE);
    mkdirSync(join(oldDir, '.audiobook'), { recursive: true });

    const { makeBookId } = await import('../workspace/paths.js');
    const bookId = makeBookId(AUTHOR, SERIES, OLD_TITLE);
    writeFileSync(
      join(oldDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId,
        manuscriptId,
        title: OLD_TITLE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(oldDir, 'manuscript.md'), `# Chapter One\n\n${CHAPTER_BODY}\n`);
    const { castJsonPath } = await import('../workspace/paths.js');
    writeFileSync(
      castJsonPath(oldDir),
      JSON.stringify({
        characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] }],
      }),
    );

    const { putManuscript } = await import('../store/manuscripts.js');
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: OLD_TITLE,
      wordCount: 10,
      byteSize: 100,
      uploadedAt: new Date().toISOString(),
      sourceText: CHAPTER_BODY,
      chapterHints: [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }],
      bookDir: oldDir,
    });

    let releasePhase0!: () => void;
    const phase0Gate = new Promise<void>((resolve) => {
      releasePhase0 = resolve;
    });
    const phase0Analyzer: Analyzer = {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        await phase0Gate;
        return { characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc' }] };
      },
      runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };

    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId,
      kind: 'main',
      bookDir: oldDir,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;

    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection =
      buildSelection(buildPhase1Analyzer(), 'phase1-model');

    return {
      manuscriptId,
      oldDir,
      newDir,
      job,
      releasePhase0,
      phase0Selection: buildSelection(phase0Analyzer, 'phase0-model'),
    };
  }

  /* Exactly what book-state.ts:848-858 does: move the folder, then point the
     in-memory record at the new path. */
  async function renameLikeBookState(manuscriptId: string, oldDir: string, newDir: string) {
    const { getManuscript, putManuscript } = await import('../store/manuscripts.js');
    renameSync(oldDir, newDir);
    const rec = getManuscript(manuscriptId)!;
    rec.bookDir = newDir;
    putManuscript(rec);
  }

  describe('#2165 — a rename that reaches a live analysis run does not resurrect the old directory', () => {
    it(
      "the run's cast.json write follows the rename",
      async () => {
        const seed = await seedRunnableBook();
        const { runMainAnalyzerJob } = await import('./analysis.js');
        const { castJsonPath } = await import('../workspace/paths.js');
        const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
        const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
        process.env.STAGE2_COVERAGE_RETRIES = '0';

        let jobPromise: Promise<void> | undefined;
        try {
          jobPromise = runMainAnalyzerJob(
            seed.job,
            getManuscript(seed.manuscriptId)! as never,
            seed.phase0Selection,
            { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
          );
          jobPromise.catch(() => {});

          /* Let the run reach (and hang in) Phase 0. */
          await new Promise((r) => setTimeout(r, 300));
          await renameLikeBookState(seed.manuscriptId, seed.oldDir, seed.newDir);

          seed.releasePhase0();
          await jobPromise.catch(() => {});
        } finally {
          seed.releasePhase0();
          if (jobPromise) await jobPromise.catch(() => {});
          removeManuscript(seed.manuscriptId);
          process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
        }

        /* Per-mechanism assertions — one mechanism at a time, so a failure
           names the site that broke. */
        expect(existsSync(castJsonPath(seed.newDir))).toBe(true);
        expect(existsSync(castJsonPath(seed.oldDir))).toBe(false);
        /* Whole-outcome assertion: NOTHING recreated the pre-rename folder. */
        expect(existsSync(seed.oldDir)).toBe(false);
      },
      30_000,
    );

    it(
      "the run's analysis-state.json snapshot follows the rename",
      async () => {
        const seed = await seedRunnableBook();
        const { runMainAnalyzerJob } = await import('./analysis.js');
        const { analysisStateJsonPath } = await import('../workspace/paths.js');
        const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
        const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
        process.env.STAGE2_COVERAGE_RETRIES = '0';

        let jobPromise: Promise<void> | undefined;
        try {
          jobPromise = runMainAnalyzerJob(
            seed.job,
            getManuscript(seed.manuscriptId)! as never,
            seed.phase0Selection,
            { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
          );
          jobPromise.catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
          await renameLikeBookState(seed.manuscriptId, seed.oldDir, seed.newDir);

          /* Abort rather than complete: the paused terminal snapshot IGNORES
             the ~5s throttle, so it lands deterministically inside a short
             test — and unlike terminal success it is not immediately deleted. */
          seed.job.controller.abort();
          seed.releasePhase0();
          await jobPromise.catch(() => {});
          /* endJob's snapshot write is fire-and-forget (`void`). */
          await new Promise((r) => setTimeout(r, 400));
        } finally {
          seed.releasePhase0();
          if (jobPromise) await jobPromise.catch(() => {});
          removeManuscript(seed.manuscriptId);
          process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
        }

        expect(existsSync(analysisStateJsonPath(seed.newDir))).toBe(true);
        expect(existsSync(analysisStateJsonPath(seed.oldDir))).toBe(false);
        expect(existsSync(seed.oldDir)).toBe(false);
      },
      30_000,
    );
  });
  ```

- [ ] 2.10 Do **not** add this file to `server/vitest.config.slow.ts`'s
      `SLOW_FILES` — it belongs in the parallel fast tier, alongside
      `analysis.fresh-cast-lock.test.ts`, which is also not listed there.

- [ ] 2.11 Run `cd server && npx vitest run src/routes/analysis.rename-midrun.test.ts --retry=0`,
      then `cd server && npm run test` (whole fast tier) to confirm nothing else
      regressed — the merge-base call sites are hot and
      `analysis.merge-base-detect.test.ts` exercises them.

**Paired tests:** `server/src/routes/analysis.rename-midrun.test.ts` — the two
cases above.

**The mutation that makes each fail:**
- Case 1: revert step 2.7 to `createCastMergeBase(recordRef.bookDir, …)` (with
  Task 1's signature widened back to a string). The interim per-chapter write
  then mkdir's `oldDir` back and writes there:
  `existsSync(castJsonPath(seed.oldDir))` becomes `true` and
  `existsSync(castJsonPath(seed.newDir))` becomes `false`.
- Case 2: revert step 2.4's `liveBookDir(job)` to `job.bookDir` in
  `persistTerminalSnapshot`. The paused snapshot lands in the resurrected
  `oldDir`: `existsSync(analysisStateJsonPath(seed.newDir))` becomes `false`.

**Deliverable:** a live analysis run's `cast.json` and `analysis-state.json`
writes both follow a rename; the pre-rename directory is never recreated.

- [ ] 2.12 Commit: `fix(server): follow a mid-run rename for the merge base and analysis-state writes`

---

## Task 3 — refuse the rename with 409 while an analysis is registered

**Files:**
- `server/src/routes/book-state.ts` (modify)
- `server/src/routes/book-state.rename-analysis-busy.test.ts` (new)
- `openapi.yaml` (modify)
- `src/lib/api-types.ts` (regenerated)

**Interfaces:** no new exports. Reuses
`isAnalysisBusy(bookDir: string): boolean` from
`server/src/tts/design-lock.ts`.

**Steps:**

- [ ] 3.1 Add the import to `server/src/routes/book-state.ts`, next to the other
      cross-module route imports (after the `../store/…` block, ~`:55`):

  ```ts
  import { isAnalysisBusy } from '../tts/design-lock.js';
  ```

- [ ] 3.2 Insert the guard as the **first** statement inside
      `if (newDir !== bookDir) {` (`book-state.ts:835`), *above* the existing
      `existsSync(newDir)` collision check:

  ```ts
        if (newDir !== bookDir) {
          /* #2165 — refuse while an analysis is registered for this book. A
             running analysis pins this directory in four places (the cast
             merge-base writer, analysis-state.json's throttled snapshot
             writes, its end-of-run delete, and this very busy key); moving the
             folder out from under it recreates the pre-rename directory and
             splits the book's state across two folders.

             A pure predicate over a ref-counted in-memory Map — NO lock is
             taken here, so it cannot interact with the global
             design → library-voice → cast lock order. Refuse only; never wait.
             Waiting would hold a request open across a multi-minute run.

             Reported BEFORE the path-collision 409 below on purpose: this one
             is transient and self-clearing, so naming it first stops the user
             changing a title they didn't need to change.

             Deliberately inside this branch — a PUT that moves no folder
             (castConfirmed, prosody flags, notes, tags: the autosaves the
             persistence middleware fires constantly, including during an
             analysis) must keep returning 204. */
          if (isAnalysisBusy(bookDir)) {
            return res.status(409).json({
              error:
                'Analysis is running for this book. Wait for it to finish before renaming it — a rename mid-analysis would split the book across two folders.',
            });
          }
          if (existsSync(newDir)) {
  ```

- [ ] 3.3 Create `server/src/routes/book-state.rename-analysis-busy.test.ts`:

  ```ts
  /* #2165 — the PRIMARY guard: PUT /:bookId/state refuses with 409 when the
     patch would move the book's folder while an analysis is registered for it.

     Its own file rather than a new case in book-state.test.ts, for two reasons:
     book-state.test.ts is pinned into the single-fork slow tier
     (server/vitest.config.slow.ts) and so is skipped by `npm run test:server` —
     the primary fix's coverage belongs in the fast, pre-push tier; and the
     design-lock busy registry is module-global state this file can own and
     clear without risking a leak into that file's other suites. Same precedent
     as book-state-preserve-voices.test.ts.

     Only the guard is under test here — no analyzer runs. `markAnalysisBusy`
     is exactly what a real run calls at job creation (analysis.ts:2764), so
     driving the registry directly tests the guard at its real seam. */

  import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
  import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
  import { mkdtemp } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import express, { type Express } from 'express';
  import request from 'supertest';

  const AUTHOR = 'Busy Rename Author';
  const SERIES = 'Standalones';
  const TITLE = 'Busy Rename Book';
  const NEW_TITLE = 'Busy Rename Book Renamed';

  let workspaceRoot: string;
  let app: Express;
  let bookId: string;
  let bookDir: string;
  let newDir: string;
  let markAnalysisBusy: (d: string) => void;
  let clearAnalysisBusy: (d: string) => void;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-busy-rename-test-'));
    process.env.WORKSPACE_DIR = workspaceRoot;

    /* Dynamic, after WORKSPACE_DIR — the workspace path module caches its root
       at first import (see book-state.test.ts's own note). */
    const { bookStateRouter } = await import('./book-state.js');
    const { makeBookId } = await import('../workspace/paths.js');
    /* Same module instance book-state.ts holds: ESM caches by specifier and
       nothing here calls vi.resetModules(). */
    const designLock = await import('../tts/design-lock.js');
    markAnalysisBusy = designLock.markAnalysisBusy;
    clearAnalysisBusy = designLock.clearAnalysisBusy;

    bookId = makeBookId(AUTHOR, SERIES, TITLE);
    bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_TITLE);

    app = express();
    app.use(express.json());
    app.use('/api/books', bookStateRouter);
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  function seedBook(): void {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder body');
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId,
        manuscriptId: 'm_busy_rename',
        title: TITLE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  afterEach(() => {
    /* Belt and braces — a leaked busy entry would make every later case 409.
       clearAnalysisBusy is a decrement, so call it until the map is clean. */
    for (let i = 0; i < 4; i++) clearAnalysisBusy(bookDir);
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  });

  describe('#2165 — PUT /:bookId/state refuses a rename while an analysis is registered', () => {
    it('409s a title change and leaves the folder exactly where it was', async () => {
      seedBook();
      markAnalysisBusy(bookDir);

      const res = await request(app)
        .put(`/api/books/${bookId}/state`)
        .set('Content-Type', 'application/json')
        .send({ slice: 'state', patch: { title: NEW_TITLE } });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/analysis is running/i);
      expect(existsSync(bookDir)).toBe(true);
      expect(existsSync(newDir)).toBe(false);
      /* Nothing was written: state.json still carries the old title. */
      const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
      expect(onDisk.title).toBe(TITLE);
    });

    it('still accepts a state patch that moves no folder while the analysis runs', async () => {
      seedBook();
      markAnalysisBusy(bookDir);

      /* The negative control that matters most: the persistence middleware
         autosaves patches like this throughout an analysis. If the guard is
         hoisted above the `newDir !== bookDir` branch, this is the case that
         catches it. */
      const res = await request(app)
        .put(`/api/books/${bookId}/state`)
        .set('Content-Type', 'application/json')
        .send({ slice: 'state', patch: { castConfirmed: false, notes: 'still editable' } });

      expect(res.status).toBe(204);
      expect(existsSync(bookDir)).toBe(true);
    });

    it('accepts the same rename once the analysis has cleared', async () => {
      seedBook();
      markAnalysisBusy(bookDir);
      clearAnalysisBusy(bookDir);

      const res = await request(app)
        .put(`/api/books/${bookId}/state`)
        .set('Content-Type', 'application/json')
        .send({ slice: 'state', patch: { title: NEW_TITLE } });

      expect(res.status).toBe(204);
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(bookDir)).toBe(false);
    });

    it('keeps the guard ref-counted — a sibling subset job still holds it', async () => {
      seedBook();
      markAnalysisBusy(bookDir); // main
      markAnalysisBusy(bookDir); // subset
      clearAnalysisBusy(bookDir); // main finishes first

      const res = await request(app)
        .put(`/api/books/${bookId}/state`)
        .set('Content-Type', 'application/json')
        .send({ slice: 'state', patch: { title: NEW_TITLE } });

      expect(res.status).toBe(409);
      expect(existsSync(newDir)).toBe(false);
    });
  });
  ```

- [ ] 3.4 Update `openapi.yaml`'s `putBookState` 409 description (`:3329-3335`)
      to name the fourth cause:

  ```yaml
          '409':
            description: |
              Refused (nothing was written). Either the write would have replaced
              a character's consented cloned voice, or it would have overwritten an
              analysed manuscript with an empty sentence list, or the new
              Author/Series/Title path is already taken, or an analysis is
              currently running for this book and the patch would move its folder
              (renaming mid-analysis would split the book's state across two
              directories — retry once the run finishes).
  ```

- [ ] 3.5 Run `npm run openapi:types` from the repo root and **commit the
      resulting `src/lib/api-types.ts` diff**. `openapi-typescript` emits every
      `description` into the generated file as JSDoc, so a prose-only
      `openapi.yaml` edit *does* stale `api-types.ts` — and `verify.yml` has a
      dedicated leg that regenerates and diffs it
      (`::error::src/lib/api-types.ts is stale`). Skipping this reds CI.

- [ ] 3.6 Run `cd server && npx vitest run src/routes/book-state.rename-analysis-busy.test.ts --retry=0`,
      then `cd server && npm run test:server-slow` — `book-state.test.ts`'s
      existing rename suite lives there and must stay green (its three rename
      cases never mark the book busy, so they must all still pass).

**Paired tests:** `server/src/routes/book-state.rename-analysis-busy.test.ts` —
four cases.

**The mutation that makes each fail:**
- Case 1 ("409s a title change"): delete the `if (isAnalysisBusy(bookDir))`
  block. The PUT returns 204, the folder moves, and all four assertions flip.
- Case 2 ("still accepts a state patch that moves no folder"): hoist the guard
  above `if (newDir !== bookDir)`. The non-renaming patch then 409s instead of
  204 — this is the case that catches the single most damaging way to get the
  guard wrong.
- Case 3 ("accepts the same rename once cleared"): make the guard unconditional
  (e.g. `if (true)`) or key it on `isAnyAnalysisBusy()` instead of this book.
  Returns 409 and the folder never moves.
- Case 4 (ref-counting): change `clearAnalysisBusy` to `analysisBusy.delete` in
  `design-lock.ts`, or key the guard on a boolean set. The first clear releases
  the guard, the PUT 204s, and `existsSync(newDir)` becomes `true`.

**Deliverable:** the rename is refused, with a message the user can act on, and
every non-renaming `slice: 'state'` PUT is unaffected.

- [ ] 3.7 Commit: `fix(server,openapi): refuse a book rename while an analysis is running`

---

## Task 4 — the refusal reads as a sentence, not a JSON envelope

**Files:**
- `src/lib/api.ts` (modify)
- `src/lib/api-put-book-state-error.test.ts` (new)

**Interfaces:** none changed — `realPutBookState(bookId, req): Promise<void>`
still rejects with an `Error`; only the message changes.

**Steps:**

- [ ] 4.1 Replace `realPutBookState`'s error branch (`src/lib/api.ts:2338-2348`):

  ```ts
  async function realPutBookState(bookId: string, req: PutStateRequest): Promise<void> {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      /* #2165 — every deliberate refusal this route sends (an analysis is
         running, an Author/Series/Title collision, a cloned-voice consent
         refusal) is a 409 carrying `{ error: '…' }`, and that sentence reaches
         the user verbatim through BooksRoute's showError. Surface the sentence,
         not the envelope. Non-JSON bodies (a proxy's 502 page, an empty 500)
         fall through to the raw text exactly as before. */
      const body = await res.text();
      let detail = body || res.statusText;
      try {
        const parsed = JSON.parse(body) as { error?: unknown };
        if (typeof parsed.error === 'string' && parsed.error) detail = parsed.error;
      } catch {
        /* not JSON — keep the raw body */
      }
      throw new Error(`Book state PUT failed (${res.status}): ${detail}`);
    }
  }
  ```

- [ ] 4.2 Create `src/lib/api-put-book-state-error.test.ts`:

  ```ts
  /* #2165 — PUT /api/books/{bookId}/state now has a fourth deliberate 409 (an
     analysis is running and the patch would move the book's folder). That
     message reaches the user verbatim via BooksRoute's showError, so the wire
     layer must unwrap `{ error }` rather than handing over the JSON envelope.

     Mocks global fetch, mirroring api-analysis-state.test.ts. */

  import { afterEach, describe, expect, it, vi } from 'vitest';
  import { api } from './api';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('api.putBookState — refusal messages', () => {
    it("surfaces the server's error sentence on a 409, not the JSON envelope", async () => {
      const message =
        'Analysis is running for this book. Wait for it to finish before renaming it — a rename mid-analysis would split the book across two folders.';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: message }), { status: 409 })),
      );

      await expect(
        api.putBookState('book-1', { slice: 'state', patch: { title: 'New' } }),
      ).rejects.toThrow(message);

      const err = await api
        .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
        .catch((e: Error) => e);
      expect((err as Error).message).not.toContain('{"error"');
      expect((err as Error).message).toContain('409');
    });

    it('falls back to the raw body when it is not JSON', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

      const err = await api
        .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
        .catch((e: Error) => e);
      expect((err as Error).message).toContain('boom');
      expect((err as Error).message).toContain('500');
    });

    it('resolves on 204 without reading a body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        api.putBookState('book-1', { slice: 'state', patch: { title: 'New' } }),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
  ```

  **Note:** `api.putBookState` resolves to `realPutBookState` only when
  `VITE_USE_MOCKS` is off. If the frontend test env has mocks on, this file must
  import `realPutBookState`'s module-level binding the same way its sibling
  `api-analysis-state.test.ts` reaches a real implementation through `api`;
  verify by running the file and, if `fetch` is never called, export nothing new
  — instead assert against the real function via the same `api` object after
  confirming `import.meta.env.VITE_USE_MOCKS` is unset for the vitest run
  (`vitest.config.ts` / `src/test-setup`). Do not add a production export purely
  for the test.

- [ ] 4.3 Run `npx vitest run src/lib/api-put-book-state-error.test.ts --retry=0`,
      then `npm run test -- --retry=0` for the whole frontend suite —
      `src/routes/index.test.tsx`'s edit-metadata block exercises the same
      funnel.

**Paired test:** `src/lib/api-put-book-state-error.test.ts`.

**The mutation that makes it fail:** restore the one-liner
``${(await res.text()) || res.statusText}``. Case 1's
`not.toContain('{"error"')` fails immediately (the message becomes the raw
envelope), while cases 2 and 3 still pass — which is the point: only the
unwrapping is under test, the fallback and the happy path are controls.

**Deliverable:** a user who renames a book mid-analysis sees the refusal as a
readable sentence in the existing error toast.

- [ ] 4.4 Commit: `fix(frontend): surface the book-state PUT refusal message instead of the JSON body`

---

## Task 5 — release notes, plan status, and ship

**Files:**
- `docs/release-notes-next.md` (modify)
- `RELEASE_NOTES.md` (modify)
- `docs/superpowers/plans/2026-08-07-rename-midrun-bookdir-pinning.md` (modify)

**Steps:**

- [ ] 5.1 Append to `docs/release-notes-next.md`, in the existing bug-fix
      section of the v1.15.0 body (technical register; keep the file's
      bold-lead-bullet + `(#PR)` shape):

  > **Renaming a book while it is being analysed is refused instead of splitting
  > the book across two folders.** `PUT /api/books/{bookId}/state` now returns
  > `409` when the patch would move the on-disk folder and an analysis is
  > registered for that book (`isAnalysisBusy`, the same ref-counted registry
  > that already gates bulk cast design). A patch that moves no folder is
  > unaffected. As defence in depth, the run's own `cast.json` merge-base writes
  > and its `analysis-state.json` snapshots now resolve the book directory at
  > write time instead of from a copy pinned at job start, so a rename that ever
  > did reach a live run can no longer recreate the pre-rename directory. (#PR)

- [ ] 5.2 Append to the v1.15.0 section of `RELEASE_NOTES.md` (brand voice,
      end-state, no diary):

  > - **Renaming a book while Castwright is still reading it now waits its
  >   turn.** Change a book's author, series or title mid-analysis and Castwright
  >   used to move the folder out from under the run — which could quietly leave
  >   your cast in the old folder and everything else in the new one, so the app
  >   read a book with nobody in it. Castwright now asks you to wait until the
  >   analysis finishes, and says so plainly. Everything else about a book stays
  >   editable while it's being analysed.

- [ ] 5.3 Fill this plan's **Ship notes** (below) with the shipped date and the
      merge SHA, and set `**Status:**` to `stable`. Leave the file where it is —
      `docs/superpowers/plans/` has no archive convention.

- [ ] 5.4 Run `npm run verify:fast:branch` from the repo root. Then, because the
      branch-scoped battery does **not** include the slow tier, also run
      `cd server && npm run test:server-slow` by hand — `book-state.test.ts`
      lives there and this branch edits `book-state.ts`.

- [ ] 5.5 Open the PR:
  - **Branch:** `fix/server-rename-midrun-bookdir` (from
    `<type>/<scope>-<slug>`; the primary fix is a server fix, so `server` is the
    branch scope even though the diff also touches `frontend`, `openapi`, and
    `docs`).
  - **Title / commit convention:** `fix(server,frontend): refuse a book rename while an analysis is running`
    — multi-scope is comma-separated with no spaces (CONTRIBUTING.md
    "Multi-scope changes"). Per-commit scopes are as given in each task above:
    `fix(server)` ×2, `fix(server,openapi)`, `fix(frontend)`, `docs(docs)`.
  - **Body:** must contain the literal line `Closes #2165` (not backticked, not
    qualified — a backticked or "at ship time" phrasing does not auto-close).
    Keep the template's `## Summary` / `## Test plan` sections; link this plan
    doc. State explicitly that no on-box acceptance row is owed and why.
  - **Review gate:** a `code-review` pass at `medium` effort (single-scope
    `fix` semantics, multi-scope diff → treat as `high` if the reviewer's
    routing table says so), dispatched to the Premium tier, before merge.
  - **Merge:** "Create a merge commit" only.

**Deliverable:** merged PR, issue #2165 closed by it.

---

## Ship notes

*(fill at merge)*

- **Shipped:**
- **Merge SHA:**
- **PR:**
- **Observed:**
