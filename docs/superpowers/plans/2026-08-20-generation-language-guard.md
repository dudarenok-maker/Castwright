# Generation Language Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `server/src/routes/generation.ts`'s audio-render path into the
`#2246` language-guard mechanism, fixing the stream-termination defect that
would otherwise make the fix unobservable, and bounding the dispatcher drain
the fix would otherwise leave unbounded.

**Architecture:** Extend generation's existing `chapter_failed` +
`FailureCode` taxonomy with a new `'language-unset'` code. Fix every early
bail-out in `generation.ts` to properly close its SSE stream (`idle` before
`res.end()`). Wire `generation-stream-runner.ts` into the existing
`language-guard-bus` modal, gated by a per-book, TTL-bounded suppression map
that also gates the dispatcher's same-tick refill.

**Tech Stack:** Node/Express (server), Vite/React/TypeScript/Redux Toolkit
(frontend), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-generation-language-guard-design.md`
(issue #2515) — final after three assumption-checker passes.

> **Revision note.** This plan itself went through one assumption-checker
> pass, which found two defects load-bearing enough to need real decisions
> (not just fixes) — folded into Global Constraints below with the owner's
> answers — plus a batch of mechanical defects (wrong test assertions,
> fictional test helpers not matching the actual test files, a type error,
> an unstated execution-order conflict between two tasks touching the same
> file, a merge that removed an intermediate type-red state between two
> tasks). All are fixed in this version, verified against the actual test
> files' existing helpers rather than sketched.

## Global Constraints

- New `FailureCode` member is `'language-unset'` — kebab-case.
- Remediation copy: *"This book's language has not been set. Choose it in
  Book settings before continuing."* (parent design doc,
  `docs/superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md:316-319`).
  Note this is UX copy for the `remediation` field, not required to match
  `requireBookStateLanguage`'s actual thrown `errorReason` string verbatim —
  those are separate fields; see Task 3 for the real thrown string.
- Help category: `'voices'` (`src/data/help-categories.ts:9`).
- **Owner decision — pending-guard safety net:** `languageGuardPending`
  (the per-book suppression state in `generation-stream-runner.ts`) is
  **TTL-bounded, 2 minutes**, not a plain `Set` that only clears via
  `onRetry`/`onDismiss`. Reason: `use-language-guard.tsx` has a single
  app-wide modal slot, and a second `emitLanguageGuard` call from any of the
  now-nine guard-emitting call sites while one is pending silently overwrites
  it, dropping the first request's callbacks with no way to observe or
  recover. Without a TTL, that turns into a book permanently excluded from
  queue dispatch. The TTL bounds the exposure to the same order of magnitude
  as a user actually looking at the modal.
- **Owner decision — dispatch typing:** `StreamRunnerStore.dispatch` widens
  from `Dispatch` to `AppDispatch` (a **type-only** import of `AppDispatch`
  from `./index`, erased at compile time — does not reintroduce the runtime
  circular-import problem the narrow type existed to avoid) so `onRetry` can
  dispatch the `retryQueueEntry` thunk directly, matching the established
  idiom rather than a raw `runner.open()` replay.
- `onRetry` uses `retryQueueEntry(entryId)` (`src/store/queue-thunks.ts:260-269`)
  — never a direct `runner.open()` call.
- Work happens on the existing worktree/branch: worktree
  `C:\Claude\Projects\wt-2246-lang-recurrence`, branch
  `feat/server-2246-language-recurrence`. Do not create a new worktree.
- **Execution order:** Task 2 and Task 3 both modify
  `server/src/routes/generation.ts` and `generation.test.ts`. Task 2 must be
  completed and committed **before** Task 3 begins — do not dispatch them in
  parallel, and do not trust either task's line-number citations once the
  other has landed; match by surrounding code content, which every snippet
  below shows in full.

---

### Task 1: `language-unset` FailureCode — end to end

*(Design change items 4, 6, 7, 8, 9, 10, merged into one task specifically
to avoid a commit-boundary where `src/data/help-failures.ts` is
type-red — its `FailureCode` type derives from the generated
`api-types.ts`, so splitting the openapi/taxonomy half from the
help-failures half across two commits leaves the tree failing typecheck
between them, which `verify:fast:branch` would catch at push time either
way but is cleaner avoided.)*

**Files:**
- Modify: `openapi.yaml:6868-6898` (`FailureCode` enum)
- Modify: `src/lib/api-types.ts` (regenerated, not hand-edited)
- Modify: `server/src/routes/failure-taxonomy.ts:29-51` (`FailureCode` union)
- Modify: `server/src/routes/failure-remediations.ts` (`FAILURE_REMEDIATIONS`)
- Test: `server/src/routes/failure-taxonomy.test.ts:400-425`
- Modify: `src/data/help-failures.ts:28-79` (`CATEGORIES`, `TITLES`)
- Test: `src/data/help-failures.test.ts:13`
- Test: `src/data/help-categories.test.ts:23-24`

**Interfaces:**
- Produces: `FailureCode` union member `'language-unset'`, consumable by
  server code as `errorCode: 'language-unset'` and by frontend code as
  `ev.errorCode === 'language-unset'`.

- [ ] **Step 1: Add the enum member to `openapi.yaml`**

  In the `FailureCode` schema's `enum` list (`:6876-6898`), append:

  ```yaml
        enum:
          - vram-spill
          - sidecar-unreachable
          - analyzer-rate-limit
          - oom
          - disk-full
          - model-not-loaded
          - synth-timeout
          - xtts-speaker-desync
          - cuda-poisoned
          - auth
          - unknown
          - recycle-storm
          - analyzer-daily-quota
          - analyzer-truncated
          - analyzer-unreachable
          - analyzer-content-blocked
          - attribution-incomplete
          - attribution-collapse
          - gpu-acceleration-unavailable
          - voice-not-designed
          - cloned-voice-broken
          - lock-contention
          - language-unset
  ```

- [ ] **Step 2: Regenerate `api-types.ts`**

  Run: `npm run openapi:types`
  Expected: `FailureCode` type in `src/lib/api-types.ts` gains
  `"language-unset"`.

- [ ] **Step 3: Write the failing server test**

  In `failure-taxonomy.test.ts`, the test named
  `'has exactly one entry per FailureCode'` (`:400`), add `'language-unset'`
  to the sorted expected array:

  ```ts
  it('has exactly one entry per FailureCode', () => {
    expect(Object.keys(FAILURE_REMEDIATIONS).sort()).toEqual(
      [
        'analyzer-content-blocked',
        'analyzer-daily-quota',
        'analyzer-rate-limit',
        'analyzer-truncated',
        'analyzer-unreachable',
        'attribution-incomplete',
        'attribution-collapse',
        'auth',
        'cloned-voice-broken',
        'cuda-poisoned',
        'disk-full',
        'gpu-acceleration-unavailable',
        'language-unset',
        'lock-contention',
        'model-not-loaded',
        'oom',
        'recycle-storm',
        'sidecar-unreachable',
        'synth-timeout',
        'unknown',
        'vram-spill',
        'voice-not-designed',
        'xtts-speaker-desync',
      ].sort(),
    );
  });
  ```

- [ ] **Step 4: Run test to verify it fails**

  Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts -t "has exactly one entry per FailureCode"`
  Expected: FAIL — `language-unset` missing from `FAILURE_REMEDIATIONS`.

- [ ] **Step 5: Add the union member to `failure-taxonomy.ts`**

  Append `| 'language-unset'` before `| 'auth'` in the `FailureCode` type
  (`:29-51`):

  ```ts
  export type FailureCode =
    | 'vram-spill'
    | 'recycle-storm'
    | 'sidecar-unreachable'
    | 'analyzer-rate-limit'
    | 'analyzer-daily-quota'
    | 'analyzer-truncated'
    | 'analyzer-unreachable'
    | 'analyzer-content-blocked'
    | 'attribution-incomplete'
    | 'attribution-collapse'
    | 'oom'
    | 'disk-full'
    | 'model-not-loaded'
    | 'synth-timeout'
    | 'xtts-speaker-desync'
    | 'cuda-poisoned'
    | 'gpu-acceleration-unavailable'
    | 'voice-not-designed'
    | 'cloned-voice-broken'
    | 'lock-contention'
    | 'language-unset'
    | 'auth'
    | 'unknown';
  ```

- [ ] **Step 6: Add remediation copy to `failure-remediations.ts`**

  ```ts
    'language-unset': {
      userMessage: "This book's language has not been set.",
      remediation:
        "This book's language has not been set. Choose it in Book settings before continuing.",
    },
  ```

- [ ] **Step 7: Run server test, then typecheck**

  Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts`
  Expected: PASS (including the `_copyComplete` compile-time pin at
  `failure-taxonomy.ts:55-57`).
  Run: `cd server && npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 8: Write the failing frontend tests**

  In `src/data/help-failures.test.ts:13`:

  ```ts
  expect(HELP_FAILURE_ENTRIES.length).toBe(23);
  ```

  In `src/data/help-categories.test.ts`, the test titled
  `'has exactly 48 items (22 failures + 26 topics)'` at `:23-24`:

  ```ts
  it('has exactly 49 items (23 failures + 26 topics)', () => {
    expect(HELP_FAILURE_ENTRIES.length + HELP_TOPICS.length).toBe(49);
  });
  ```

- [ ] **Step 9: Run frontend tests to verify they fail**

  Run: `npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts`
  Expected: FAIL — counts still 22/48, and `CATEGORIES`/`TITLES` fail to
  compile against the widened `FailureCode` union (this is a **type** error,
  not something `vitest run`'s esbuild transpile surfaces directly — the
  count assertions are what actually go red here; the type error surfaces
  separately when `npx tsc --noEmit` runs in Step 11).

- [ ] **Step 10: Add the entries in `help-failures.ts`**

  In `CATEGORIES` (`:28-54`), after `'lock-contention': 'files',`:

  ```ts
    'language-unset': 'voices',
  ```

  In `TITLES` (`:56-79`), after `'lock-contention': 'Something else had the book open',`:

  ```ts
    'language-unset': "Book's language not set",
  ```

- [ ] **Step 11: Run tests and typecheck to verify green**

  Run: `npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts`
  Expected: PASS.
  Run: `npm run typecheck`
  Expected: PASS.

- [ ] **Step 12: Commit**

  ```bash
  git add openapi.yaml src/lib/api-types.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts src/data/help-failures.ts src/data/help-failures.test.ts src/data/help-categories.test.ts
  git commit -m "feat: add language-unset FailureCode end-to-end"
  ```

---

### Task 2: Stream termination for the eight non-language early bail-outs

*(Design change items 1 (eight of nine sites) and 2. No dependency on
Task 1 — this task never references `FailureCode`.)*

**Files:**
- Modify: `server/src/routes/generation.ts:730-737`, `:753-756`,
  `:759-762`, `:769-775`, `:833`, `:918-925`, `:1000-1006`, `:1047-1060`
- Test: `server/src/routes/generation.test.ts:504-514`, `:531-544`,
  `:1028-1043`, `:1208-1223`, plus two new tests

**Interfaces:**
- Produces: each of these eight bail-outs now emits `{ type: 'idle' }` as
  its final tick before `res.end()`, matching the existing precedent at
  `:1168-1171`.

- [ ] **Step 1: Update the three tests that hard-pin a 1-tick count**

  ```ts
  // :504-514 — invalid modelKey
  it('rejects an unsupported modelKey with a stream-level chapter_failed and ends', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'not-a-real-model' });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(2);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].chapterId).toBeUndefined();
    expect(ticks[0].errorReason).toMatch(/modelKey/i);
    expect(ticks[1].type).toBe('idle');
  });
  ```

  ```ts
  // :531-544 — disk-full block
  it('srv-28: block mode short-circuits with a disk-full chapter_failed and ends', async () => {
    diskFreeGb = 0.2;
    process.env.DISK_GUARD_MODE = 'block';
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(2);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].errorCode).toBe('disk-full');
    expect(ticks[0].chapterId).toBeUndefined();
    expect(String(ticks[0].remediation)).toMatch(/free up disk space/i);
    expect(ticks[1].type).toBe('idle');
  });
  ```

  ```ts
  // :1028-1043 — no analysed sentences
  it('still emits the original error when both cache AND manuscript-edits.json are empty', async () => {
    await cacheModule.clearAnalysisCache(MANUSCRIPT_ID);
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(2);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].errorReason as string).toMatch(/No analysed sentences cached/i);
    expect(ticks[1].type).toBe('idle');
  });
  ```

- [ ] **Step 2: Extend the existing sidecar-language test (`:1208-1223`)**

  Read that test as it exists today, then add an assertion that the
  final tick is `idle` (it currently only finds the `chapter_failed` tick
  without checking what follows it):

  ```ts
  const idleTick = ticks[ticks.length - 1];
  expect(idleTick.type).toBe('idle');
  ```

- [ ] **Step 3: Write two new tests for the remaining sites**

  Provider-selection failure and book-not-found need no special fixture —
  the first fails on an invalid `modelKey`-derived engine lookup path
  distinct from Step 1's invalid-`modelKey` test (this one exercises
  `selectTtsProvider` throwing for a *valid* `TtsModelKey` whose engine
  is unavailable — check `selectTtsProvider`'s actual throw conditions in
  `server/src/tts/provider.ts` before finalizing which `modelKey` value
  reliably triggers it in this test environment); the second needs only an
  unknown book id:

  ```ts
  it('emits idle after a book-not-found chapter_failed', async () => {
    const res = await request(app)
      .post(`/api/books/does-not-exist/generation`)
      .send({ modelKey: 'gemini-2.5-flash' });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(2);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].errorReason).toMatch(/No book found/i);
    expect(ticks[1].type).toBe('idle');
  });
  ```

  For cast-not-confirmed and the Qwen-unavailable/no-fallback-engine site
  (`:918-925`), check this file's existing fixtures first — search
  `generation.test.ts` for an existing test that already exercises
  cast-not-confirmed or a Qwen-unavailable non-English book (both are
  common enough conditions this suite likely already covers elsewhere);
  extend whichever existing test reaches that bail-out with the same
  `expect(ticks[ticks.length - 1].type).toBe('idle')` assertion Step 2
  uses, rather than building a new fixture from scratch. If no such
  existing test exists, write one following the `setBookLanguage`-style
  helper pattern at `:1075-1079` (a non-English, Qwen-unavailable book has
  no direct precedent in this file as of this plan's writing — verify
  before assuming one).

- [ ] **Step 4: Run all new/updated tests to verify they fail**

  Run: `cd server && npx vitest run src/routes/generation.test.ts`
  Expected: the five updated/new tests FAIL (still 1 tick, or missing
  `idle`); everything else in the file still PASSes.

- [ ] **Step 5: Add `idle` to the eight bail-out sites**

  `:730-737` (invalid modelKey):

  ```ts
    if (!isTtsModelKey(body.modelKey)) {
      send({
        type: 'chapter_failed',
        errorReason:
          'modelKey must be a supported TTS model id (e.g. coqui-xtts-v2, gemini-2.5-flash).',
      });
      send({ type: 'idle' });
      return res.end();
    }
  ```

  `:753-756` (provider selection):

  ```ts
    try {
      provider = selectTtsProvider(modelKey);
    } catch (e) {
      send({ type: 'chapter_failed', errorReason: (e as Error).message });
      send({ type: 'idle' });
      return res.end();
    }
  ```

  `:759-762` (book not found):

  ```ts
    const located = await findBookByBookId(bookId);
    if (!located) {
      send({ type: 'chapter_failed', errorReason: `No book found for id "${bookId}".` });
      send({ type: 'idle' });
      return res.end();
    }
  ```

  `:769-775` (cast not confirmed):

  ```ts
    const cast = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      send({
        type: 'chapter_failed',
        errorReason: 'Cast not confirmed yet — open the cast view first.',
      });
      send({ type: 'idle' });
      return res.end();
    }
  ```

  `:833` (sidecar language lookup):

  ```ts
    try {
      sidecarLang = sidecarLanguageName(bookLanguage);
    } catch (e) {
      send({ type: 'chapter_failed', errorReason: (e as Error).message });
      send({ type: 'idle' });
      return res.end();
    }
  ```

  `:918-925` (Qwen unavailable, no fallback engine):

  ```ts
    console.warn(`[generation] ${message}`);
    send({ type: 'chapter_failed', errorReason: message });
    send({ type: 'idle' });
    return res.end();
  ```

  `:1000-1006` (no analysed sentences):

  ```ts
    if (!analysis.chapters || Object.keys(analysis.chapters).length === 0) {
      send({
        type: 'chapter_failed',
        errorReason: 'No analysed sentences cached for this book. Re-run analysis first.',
      });
      send({ type: 'idle' });
      return res.end();
    }
  ```

  `:1047-1060` (disk-full block — preserve the existing comment, don't drop it):

  ```ts
      } else if (verdict.status === 'block') {
        /* Mirror the pre-flight guard short-circuit shape (a chapter_failed +
           res.end). Carry the fs-19 disk-full code + remediation so the
           frontend renders the same "what to do" line a mid-run ENOSPC would. */
        send({
          type: 'chapter_failed',
          errorReason: verdict.message,
          errorCode: 'disk-full',
          remediation:
            'Free up disk space on the workspace volume (delete old exports, or move the ' +
            'workspace to a larger drive), then start the run again.',
        });
        send({ type: 'idle' });
        return res.end();
      }
  ```

- [ ] **Step 6: Run tests to verify they pass**

  Run: `cd server && npx vitest run src/routes/generation.test.ts`
  Expected: PASS, all tests.

- [ ] **Step 7: Commit**

  ```bash
  git add server/src/routes/generation.ts server/src/routes/generation.test.ts
  git commit -m "fix(server): close the SSE stream on every early generation bail-out"
  ```

---

### Task 3: `language-unset` wiring on generation's own guard check

*(Design change item 3, plus item 1's ninth site. Depends on Task 1 and
Task 2 — see Global Constraints' execution-order note.)*

**Files:**
- Modify: `server/src/routes/generation.ts:800-805` (pre-Task-2 line
  numbers; re-locate by content, not line number, since Task 2 shifts
  everything below `:775` down by one line per site it touches above this
  one)
- Test: `server/src/routes/generation.test.ts` — new `describe` block

**Interfaces:**
- Consumes: `FailureCode` value `'language-unset'` (Task 1).
- Produces: on `requireBookStateLanguage` throw, a `chapter_failed` tick
  with `errorCode: 'language-unset'`, `chapterId` (when `requestedIds` —
  read, not modified, at `:741-743` — has exactly one element), followed
  by `idle`.

- [ ] **Step 1: Write the failing tests, in their own `describe` block**

  Add a new `describe` block near the end of `generation.test.ts`, using
  the same `beforeAll`-capture / `afterEach`-restore pattern the file's
  `fs-38 Wave 3c` block already uses at `:1055-1080` (`statePath()`,
  `originalState`, `afterEach` restoring it) — **not** a bespoke helper
  importing `stateJsonPath`/`writeJsonAtomic` from server internals, which
  don't exist as importable test utilities in this file:

  ```ts
  describe('POST /api/books/:bookId/generation — language-unset guard (#2515)', () => {
    const statePath = () => join(bookDir, '.audiobook', 'state.json');
    let fsModule: typeof import('node:fs');
    let originalState: string;

    beforeAll(async () => {
      fsModule = await import('node:fs');
      originalState = fsModule.readFileSync(statePath(), 'utf8');
    });

    afterEach(() => {
      fsModule.writeFileSync(statePath(), originalState);
    });

    function setBookLanguage(lang: string | null): void {
      const state = JSON.parse(fsModule.readFileSync(statePath(), 'utf8')) as Record<string, unknown>;
      state.language = lang;
      fsModule.writeFileSync(statePath(), JSON.stringify(state));
    }

    it('emits errorCode + chapterId for an unset-language book, single requested chapter', async () => {
      setBookLanguage(null);
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      expect(ticks).toHaveLength(2);
      expect(ticks[0].type).toBe('chapter_failed');
      expect(ticks[0].errorCode).toBe('language-unset');
      expect(ticks[0].chapterId).toBe(1);
      /* This is requireBookStateLanguage's/BookLanguageUnsetError's actual
         thrown message, verified against server/src/workspace/scan.ts's
         current implementation — NOT the remediation copy added in Task 1,
         which is a separate field with its own wording. */
      expect(String(ticks[0].errorReason)).toMatch(/no language is set for this book/i);
      expect(ticks[1].type).toBe('idle');
    });

    it('omits chapterId for the legacy multi-chapter unset-language open', async () => {
      setBookLanguage(null);
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true }); // no chapterIds
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      expect(ticks[0].chapterId).toBeUndefined();
      expect(ticks[0].errorCode).toBe('language-unset');
    });

    it('a book with a language set is unaffected', async () => {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      const ticks = parseTicks(res.text);
      expect(ticks.every((t) => t.errorCode !== 'language-unset')).toBe(true);
    });
  });
  ```

  Before finalizing, confirm `bookId`'s default fixture (set up in this
  file's top-level `beforeAll`) does carry `language: 'en'` — the third
  test's premise — by reading that setup; if it's a different language
  code, adjust the comment but not the assertion (any set language passes).

- [ ] **Step 2: Run tests to verify they fail**

  Run: `cd server && npx vitest run src/routes/generation.test.ts -t "language-unset guard"`
  Expected: FAIL — no `errorCode`/`chapterId` on the tick, and the exact
  `errorReason` match needs verifying against Step 1's confirmation of the
  real thrown string before this step is trusted.

- [ ] **Step 3: Implement — `generation.ts`, the `requireBookStateLanguage` catch**

  ```ts
    let bookLanguage: string;
    try {
      bookLanguage = requireBookStateLanguage(state);
    } catch (e) {
      send({
        type: 'chapter_failed',
        errorReason: (e as Error).message,
        errorCode: 'language-unset',
        ...(requestedIds && requestedIds.length === 1 ? { chapterId: requestedIds[0] } : {}),
      });
      send({ type: 'idle' });
      return res.end();
    }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  Run: `cd server && npx vitest run src/routes/generation.test.ts`
  Expected: PASS, all tests.

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/routes/generation.ts server/src/routes/generation.test.ts
  git commit -m "feat(server): classify generation's language-unset bail-out"
  ```

---

### Task 4: Streak-breaker exemption

*(Design change item 11. Depends on Task 1.)*

**Files:**
- Modify: `src/store/queue-dispatcher-middleware.ts:164`
- Test: `src/store/queue-dispatcher-middleware.test.ts`

**Interfaces:**
- Consumes: `FailureCode` value `'language-unset'` (Task 1).

- [ ] **Step 1: Write the failing test**

  In the `'consecutive-failure circuit breaker (srv-11)'` describe block
  (`:445` onward), add a sibling to the existing
  `'#1263: voice-not-designed failures never trip the breaker'` test
  (`:518-543`), using the same `makeStore`/`seed`/`failStream`/`requeue`/
  `toasts` helpers already defined in this file — copied verbatim in
  structure, substituting the error code:

  ```ts
  it('#2515: language-unset failures never trip the breaker', async () => {
    const store = makeStore(1);
    seed(store, [entry({ id: 'a3', bookId: 'book-A', chapterId: 3 })]);
    await flushMicro();

    for (let i = 0; i < 3; i++) {
      failStream(
        'book-A',
        3,
        "This book's language has not been set. Choose it in Book settings before continuing.",
        'language-unset',
      );
      await flushMicro();
      if (i < 2) {
        requeue(store, 'a3');
        await flushMicro();
      }
    }

    expect(store.getState().queue.paused).toBe(false);
    expect(toasts(store).some((t) => t.dedupeKey?.startsWith('queue-failure-breaker'))).toBe(
      false,
    );
    expect(store.getState().queue.entries.find((e) => e.id === 'a3')?.status).toBe('failed');
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/store/queue-dispatcher-middleware.test.ts -t "language-unset failures never trip"`
  Expected: FAIL — `queue.paused` is `true` after the third identical
  failure (no exemption yet).

- [ ] **Step 3: Implement — `queue-dispatcher-middleware.ts:164`**

  ```ts
            if (failure.errorCode !== 'voice-not-designed' && failure.errorCode !== 'language-unset') {
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npx vitest run src/store/queue-dispatcher-middleware.test.ts`
  Expected: PASS, including every pre-existing test in the file — this
  suite drives a **real** `createStreamRunner` (`:19`, `:128`), not a hand
  -rolled mock, so no test double needs updating for this change.

- [ ] **Step 5: Commit**

  ```bash
  git add src/store/queue-dispatcher-middleware.ts src/store/queue-dispatcher-middleware.test.ts
  git commit -m "fix(frontend): exempt language-unset from the queue streak breaker"
  ```

---

### Task 5: Frontend fan-in mechanism — `generation-stream-runner.ts`

*(Design change items 13, 15, 17 (change item 16's literal instruction —
adding `'language-unset'` to `IMMEDIATE_TOAST_ERROR_CODES` — is
deliberately NOT followed; see Step 4's note, which supersedes the design
text). Depends on Task 1, Task 3.)*

**Files:**
- Modify: `src/store/generation-stream-runner.ts:19` (imports), `:77-80`
  (`StreamRunnerStore`), `:82-102` (`OpenHandle`), `:104-152`
  (`StreamRunner` interface), `:184-196` (closure state), `:294-302`
  (`handles.set`), `:364-406` (`chapterId != null` branch)
- Test: `src/store/generation-stream-runner.test.ts`

**Interfaces:**
- Consumes: `retryQueueEntry` (`src/store/queue-thunks.ts:260-269`),
  `emitLanguageGuard` (`src/lib/language-guard-bus.ts:67-70`),
  `chaptersActions.clearLastError` (`src/store/chapters-slice.ts:144`,
  already imported via `chaptersActions` at `:28`).
- Produces: `StreamRunner.hasPendingLanguageGuard(bookId: string): boolean`.

- [ ] **Step 1: Write the failing tests**

  At the top of `generation-stream-runner.test.ts`, add mocks for the two
  new dependencies, alongside the existing `../lib/api` mock (`:23-30`):

  ```ts
  const emitLanguageGuardMock = vi.fn();
  vi.mock('../lib/language-guard-bus', () => ({
    emitLanguageGuard: (req: unknown) => emitLanguageGuardMock(req),
  }));

  const retryQueueEntryMock = vi.fn();
  vi.mock('./queue-thunks', () => ({
    retryQueueEntry: (id: string) => retryQueueEntryMock(id),
  }));
  ```

  In the existing `beforeEach` (`:32-35`), reset both:

  ```ts
  beforeEach(() => {
    streamGenerationMock.mockClear();
    cancelMock.mockClear();
    emitLanguageGuardMock.mockReset();
    retryQueueEntryMock.mockReset().mockReturnValue({ type: 'queue/retryQueueEntry/noop' });
  });
  ```

  Add the new tests, using the file's existing `makeRunner()` (`:71-75`,
  no arguments) and `onTickFor(bookId, chapterId)` (`:62-69`) helpers —
  not the fictional `captureOnTick`/`makeStore(opts)` signatures from an
  earlier draft of this plan:

  ```ts
  it('opens the language guard once for a language-unset failure, even on a non-viewed book', () => {
    emitLanguageGuardMock.mockReturnValue(true);
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('other-book'));
    runner.open('b1', 'gemini-2.5-flash', { chapterIds: [5], force: true }, { chapterId: 5, queueEntryId: 'q1' });
    onTickFor('b1', 5)({ type: 'chapter_failed', chapterId: 5, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
    expect(emitLanguageGuardMock).toHaveBeenCalledTimes(1);
    expect(emitLanguageGuardMock.mock.calls[0][0].selector).toEqual({ bookId: 'b1' });
    expect(emitLanguageGuardMock.mock.calls[0][0].shape).toBe('sse');
    expect(runner.hasPendingLanguageGuard('b1')).toBe(true);
  });

  it('does not re-emit for a second concurrent chapter of the same book', () => {
    emitLanguageGuardMock.mockReturnValue(true);
    const { runner } = makeRunner();
    runner.open('b1', 'gemini-2.5-flash', { chapterIds: [5], force: true }, { chapterId: 5, queueEntryId: 'q1' });
    runner.open('b1', 'gemini-2.5-flash', { chapterIds: [6], force: true }, { chapterId: 6, queueEntryId: 'q2' });
    onTickFor('b1', 5)({ type: 'chapter_failed', chapterId: 5, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
    onTickFor('b1', 6)({ type: 'chapter_failed', chapterId: 6, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
    expect(emitLanguageGuardMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to a toast and does not mark the book pending when emitLanguageGuard rejects', () => {
    emitLanguageGuardMock.mockReturnValue(false);
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    runner.open('b1', 'gemini-2.5-flash', { chapterIds: [5], force: true }, { chapterId: 5, queueEntryId: 'q1' });
    onTickFor('b1', 5)({ type: 'chapter_failed', chapterId: 5, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
    const toasts = store.getState().notifications.toasts;
    expect(toasts.some((t) => t.dedupeKey === 'language-unset:b1:5')).toBe(true);
    expect(runner.hasPendingLanguageGuard('b1')).toBe(false);
  });

  it('onRetry clears the pending book and retries via retryQueueEntry with the captured queueEntryId', () => {
    let capturedOnRetry: (() => void) | undefined;
    emitLanguageGuardMock.mockImplementation((req) => {
      capturedOnRetry = req.onRetry;
      return true;
    });
    const { runner } = makeRunner();
    runner.open('b1', 'gemini-2.5-flash', { chapterIds: [5], force: true }, { chapterId: 5, queueEntryId: 'q1' });
    onTickFor('b1', 5)({ type: 'chapter_failed', chapterId: 5, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
    expect(runner.hasPendingLanguageGuard('b1')).toBe(true);
    capturedOnRetry!();
    expect(runner.hasPendingLanguageGuard('b1')).toBe(false);
    expect(retryQueueEntryMock).toHaveBeenCalledWith('q1');
  });

  it('treats a pending guard older than 2 minutes as expired, allowing a fresh emission', () => {
    vi.useFakeTimers();
    try {
      emitLanguageGuardMock.mockReturnValue(true);
      const { runner } = makeRunner();
      runner.open('b1', 'gemini-2.5-flash', { chapterIds: [5], force: true }, { chapterId: 5, queueEntryId: 'q1' });
      onTickFor('b1', 5)({ type: 'chapter_failed', chapterId: 5, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
      expect(runner.hasPendingLanguageGuard('b1')).toBe(true);
      vi.advanceTimersByTime(2 * 60 * 1000 + 1);
      expect(runner.hasPendingLanguageGuard('b1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stream closes and no reconnect occurs once idle follows a language-unset chapter_failed', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'gemini-2.5-flash', { chapterIds: [5], force: true }, { chapterId: 5, queueEntryId: 'q1' });
    const key = 'b1::5';
    expect(runner.hasOpenStreamForChapter('b1', 5)).toBe(true);
    onTickFor('b1', 5)({ type: 'chapter_failed', chapterId: 5, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
    onTickFor('b1', 5)({ type: 'idle' } as GenerationTick);
    expect(runner.hasOpenStreamForChapter('b1', 5)).toBe(false);
  });

  it('a language-unset chapter_failed is recorded and retrievable via takeChapterFailure', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'gemini-2.5-flash', { chapterIds: [5], force: true }, { chapterId: 5, queueEntryId: 'q1' });
    onTickFor('b1', 5)({ type: 'chapter_failed', chapterId: 5, errorCode: 'language-unset', errorReason: 'x' } as GenerationTick);
    onTickFor('b1', 5)({ type: 'idle' } as GenerationTick);
    const failure = runner.takeChapterFailure('b1', 5);
    expect(failure?.errorCode).toBe('language-unset');
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/store/generation-stream-runner.test.ts -t "language guard"`
  Expected: FAIL — `hasPendingLanguageGuard` doesn't exist yet, and the
  fan-in logic isn't wired.

- [ ] **Step 3: Widen the dispatch type and add imports**

  ```ts
  import type { AppDispatch } from './index';
  import { emitLanguageGuard } from '../lib/language-guard-bus';
  import { retryQueueEntry } from './queue-thunks';
  ```

  Change `StreamRunnerStore` (`:77-80`):

  ```ts
  export interface StreamRunnerStore {
    dispatch: AppDispatch;
    getState: () => { chapters: ChaptersState };
  }
  ```

- [ ] **Step 4: Do NOT add `'language-unset'` to `IMMEDIATE_TOAST_ERROR_CODES`**

  That module-level set (`:72`) is checked unconditionally at `:395`,
  regardless of whether the guard modal opened — membership there would
  double-notify (toast + modal) on the success path. The fallback toast for
  a rejected/expired guard is dispatched explicitly in Step 7 instead. This
  supersedes the design doc's change item 16, which named this set as the
  mechanism; the design's own stated intent ("not as an unconditional toast
  alongside a successfully-opened modal") is what this step actually
  implements.

- [ ] **Step 5: Add `queueEntryId` to `OpenHandle` and capture it at `open()`-time**

  In `OpenHandle` (`:82-102`), add after `chapterId`:

  ```ts
    /** The queue entry this stream fulfils, when opened by the dispatcher.
        Null for the legacy back-compat open. Lets the language guard's
        onRetry call retryQueueEntry without duplicating the dispatcher's
        own open logic. */
    queueEntryId: string | null;
  ```

  In `open()`'s `handles.set(key, { ... })` call (`:294-302`):

  ```ts
    handles.set(key, {
      cancel,
      bookId,
      key,
      chapterId,
      modelKey,
      chapterIds: ids,
      completedChapterIds: [],
      queueEntryId: opts.queueEntryId ?? null,
    });
  ```

- [ ] **Step 6: Add the TTL-bounded pending map and `hasPendingLanguageGuard`**

  Alongside `chapterFailures`/`chapterAwaitingConfirm` (`:184-196`):

  ```ts
    /* Per-book language-guard suppression, TTL-bounded. Maps bookId → the
       timestamp its guard was opened. N concurrent workers of the same
       book hitting language-unset emit the guard exactly once while an
       entry is fresh here. The TTL (not a plain Set cleared only by
       onRetry/onDismiss) exists because use-language-guard.tsx has a
       single app-wide modal slot: a second emitLanguageGuard call from ANY
       of the nine guard-emitting call sites while one is pending silently
       overwrites it, dropping this book's callbacks with no signal. An
       unbounded Set would then leave hasPendingLanguageGuard true forever,
       permanently excluding the book from dispatcher STEP 2 claims
       (see queue-dispatcher-middleware.ts). The TTL bounds that exposure. */
    const LANGUAGE_GUARD_TTL_MS = 2 * 60 * 1000;
    const languageGuardPending = new Map<string, number>();

    const isLanguageGuardPending = (bookId: string): boolean => {
      const addedAt = languageGuardPending.get(bookId);
      if (addedAt == null) return false;
      if (Date.now() - addedAt > LANGUAGE_GUARD_TTL_MS) {
        languageGuardPending.delete(bookId);
        return false;
      }
      return true;
    };
  ```

  Add `hasPendingLanguageGuard` to the `StreamRunner` interface (`:104-152`,
  after `hasOpenStreamForChapter`):

  ```ts
    /** Is a language guard currently open (or recently opened) for this
        book? The dispatcher's STEP 2 claim loop skips a book while this is
        true, bounding the same-tick refill an unset-language book would
        otherwise drain into `failed` chapter by chapter. */
    hasPendingLanguageGuard(bookId: string): boolean;
  ```

  Add the implementation to `createStreamRunner`'s returned object,
  alongside the other query methods:

  ```ts
    hasPendingLanguageGuard: (bookId) => isLanguageGuardPending(bookId),
  ```

- [ ] **Step 7: Wire the fan-in logic into the `chapterId != null` branch**

  In `handleTickFor`'s `chapterId != null` branch, after the existing
  `IMMEDIATE_TOAST_ERROR_CODES` block (`:395-406`):

  ```ts
      /* Language-unset is deterministic and book-wide: N concurrent workers
         of the same book can each hit it independently, so route through a
         per-book, TTL-bounded suppression map rather than opening the guard
         once per failing stream. */
      if (ev.errorCode === 'language-unset' && !isLanguageGuardPending(bookId)) {
        const fallbackToast = (): void => {
          dispatch(
            notificationsActions.pushToast({
              kind: 'error',
              message: ev.errorReason ?? "This book's language has not been set.",
              dedupeKey: `language-unset:${bookId}:${ev.chapterId}`,
            }),
          );
        };
        const accepted = emitLanguageGuard({
          selector: { bookId },
          shape: 'sse',
          onRetry: () => {
            languageGuardPending.delete(bookId);
            dispatch(chaptersActions.clearLastError());
            if (handle.queueEntryId) {
              dispatch(retryQueueEntry(handle.queueEntryId)).catch(() => {
                /* Best-effort — the next queue snapshot reconciles. */
              });
            }
          },
          onDismiss: () => {
            languageGuardPending.delete(bookId);
            fallbackToast();
          },
        });
        if (accepted) {
          languageGuardPending.set(bookId, Date.now());
        } else {
          fallbackToast();
        }
      }
  ```

  `handle` here is the same `handle` constant already in scope at the top
  of `handleTickFor` (`const handle = handles.get(key)`, with an early
  `if (!handle) return` above it) — capture it directly in the `onRetry`
  closure as shown. Its `queueEntryId` field is written once at
  `open()`-time and never mutated, so it stays correct even after `close()`
  removes the handle from the `handles` map — do **not** re-derive it via a
  fresh `handles.get(key)` lookup inside `onRetry`, which would return
  `undefined` by the time the guard resolves.

- [ ] **Step 8: Run tests to verify they pass**

  Run: `npx vitest run src/store/generation-stream-runner.test.ts`
  Expected: PASS.

- [ ] **Step 9: Run frontend typecheck**

  Run: `npm run typecheck`
  Expected: PASS — confirms the `AppDispatch` type-only import doesn't
  reintroduce a runtime circular-import error (it's erased at compile
  time; typecheck is where a genuine type-level circularity would surface).

- [ ] **Step 10: Commit**

  ```bash
  git add src/store/generation-stream-runner.ts src/store/generation-stream-runner.test.ts
  git commit -m "feat(frontend): wire generation into the language guard, TTL-bounded fan-in suppression"
  ```

---

### Task 6: Dispatcher dispatch-gate

*(Design change item 12. Depends on Task 5.)*

**Files:**
- Modify: `src/store/queue-dispatcher-middleware.ts:219-224`
- Test: `src/store/queue-dispatcher-middleware.test.ts`

**Interfaces:**
- Consumes: `StreamRunner.hasPendingLanguageGuard` (Task 5).

- [ ] **Step 1: Write the failing test**

  Mirror the existing `'does not claim/open a new entry while the sidecar
  is recycling'` test (`:423-432`) — same structure, gating on the runner's
  pending-guard state instead of the queue's `recycling` flag. Because this
  suite drives a real `createStreamRunner` (not a mock), the fixture opens
  a language-unset stream first to make `hasPendingLanguageGuard` genuinely
  true, then seeds a second queued entry for the same book and confirms it
  isn't claimed:

  ```ts
  it('does not claim a second queued entry of a book with a pending language guard', async () => {
    const store = makeStore(2);
    seed(store, [
      entry({ id: 'a1', bookId: 'book-A', chapterId: 1 }),
      entry({ id: 'a2', bookId: 'book-A', chapterId: 2 }),
    ]);
    await flushMicro();
    // Both claimed initially (2 workers, 2 entries, same book — sibling
    // chapters stream concurrently per this file's own header comment).
    failStream('book-A', 1, "This book's language has not been set.", 'language-unset');
    await flushMicro();
    requeue(store, 'a1');
    await flushMicro();
    // a1 is queued again, but book-A now has a pending guard (chapter 1's
    // failure opened it) — STEP 2 must not re-claim a1.
    expect(store.getState().queue.entries.find((e) => e.id === 'a1')?.status).toBe('queued');
  });
  ```

  This test lives inside (or reuses the helpers of) the
  `'consecutive-failure circuit breaker'` describe block, since it needs
  the same `seed`/`failStream`/`requeue`/`flushMicro` helpers already
  defined there — place it in whichever describe block those helpers are
  actually scoped to (verify against the file: `requeue`/`toasts` are
  defined inside the breaker describe at `:448-456`; if this test needs to
  live outside that block, either hoist those two helpers or duplicate
  their four-line bodies locally).

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/store/queue-dispatcher-middleware.test.ts -t "pending language guard"`
  Expected: FAIL — `a1` gets re-claimed (`status` flips back to
  `'in_progress'`), no gate exists yet.

- [ ] **Step 3: Implement — `queue-dispatcher-middleware.ts:219-224`**

  ```ts
        for (const e of queue.entries) {
          if (slots <= 0) break;
          if (e.status !== 'queued') continue;
          if (inFlight.has(e.id)) continue;
          if (completed.has(e.id)) continue;
          if (runner.hasOpenStreamForChapter(e.bookId, e.chapterId)) continue;
          if (runner.hasPendingLanguageGuard(e.bookId)) continue;
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npx vitest run src/store/queue-dispatcher-middleware.test.ts`
  Expected: PASS — including every pre-existing test (the new condition is
  `false` for every book without a pending guard).

- [ ] **Step 5: Commit**

  ```bash
  git add src/store/queue-dispatcher-middleware.ts src/store/queue-dispatcher-middleware.test.ts
  git commit -m "fix(frontend): bound the queue drain while a book has a pending language guard"
  ```

---

### Task 7: Documentation fixes

*(Design change items 18, 19. Depends on Task 5 — describes what's
actually built.)*

**Files:**
- Modify: `src/modals/edit-book-meta.tsx:35-41`
- Modify: `docs/superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md:327`

No tests — doc-comment-only changes.

- [ ] **Step 1: Fix `edit-book-meta.tsx:35-41`**

  Replace:

  ```ts
  /** Task 9 — one of the three server failure shapes that open this modal in
      language-guard mode. `409` is the pre-flight HTTP 409 `language_unset`
      (chapter-splice / chapter-qa-repair / cast-merge); `sse` is the streaming
      `{ type:'error', code:'language_unset' }` envelope (cast-design /
      single-design / qwen-voice / generation); `batch` is the script-review
      200/207 per-item `itemFailureReason`. The modal only uses the kind for
      copy — the open/retry behaviour is the same for all three. */
  export type LanguageGuardShape = '409' | 'sse' | 'batch';
  ```

  With:

  ```ts
  /** Task 9 — one of the three server failure shapes that open this modal in
      language-guard mode. `409` is the pre-flight HTTP 409 `language_unset`
      (chapter-splice / chapter-qa-repair / analysis / qwen voice-design);
      `sse` is the streaming failure envelope — `{ type:'error',
      code:'language_unset' }` for cast-design / single-design / analysis,
      and generation's own `{ type:'chapter_failed', errorCode:'language-unset'
      }` (fs-19 taxonomy, not the shared error envelope — see
      docs/superpowers/specs/2026-08-20-generation-language-guard-design.md);
      `batch` is the script-review 200/207 per-item `itemFailureReason`. The
      modal only uses the kind for copy — the open/retry behaviour is the
      same for all three. */
  export type LanguageGuardShape = '409' | 'sse' | 'batch';
  ```

- [ ] **Step 2: Fix the parent design doc's tier-table row**

  In `docs/superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md:327`,
  replace:

  ```
  | **Streaming** — headers already flushed | `cast-design:768`, `single-design:304`, `qwen-voice:578` (all three already `send({type:'error', code:'unsupported_language'})` then `res.end()`), `generation:796`, `analysis:3163` (gate in the POST handler pre-detach; in-loop → SSE `error` via `classifyAnalysisFailure`) | `{ type: 'error', code: 'language_unset' }` in each route's **existing** error envelope |
  ```

  With:

  ```
  | **Streaming** — headers already flushed | `cast-design:768`, `single-design:304`, `qwen-voice:578` (all three already `send({type:'error', code:'unsupported_language'})` then `res.end()`), `analysis:3163` (gate in the POST handler pre-detach; in-loop → SSE `error` via `classifyAnalysisFailure`) | `{ type: 'error', code: 'language_unset' }` in each route's **existing** error envelope |
  | **Streaming, generation's own taxonomy** | `generation:800-805` | `chapter_failed` + `errorCode: 'language-unset'` (fs-19 `FailureCode`, not the shared envelope) — see `docs/superpowers/specs/2026-08-20-generation-language-guard-design.md` |
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/modals/edit-book-meta.tsx "docs/superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md"
  git commit -m "docs: correct the language-guard shape comments for generation's actual envelope"
  ```

---

## After all tasks: verify + ship

- [ ] Run `npm run verify:fast:branch` (matches this repo's pre-push gate).
- [ ] Add release-notes entries per CLAUDE.md step 5: append an entry to
  `docs/release-notes-next.md` (technical register) and a matching
  user-facing, brand-voice line to the in-progress version section at the
  top of `RELEASE_NOTES.md` — folded into whatever entry #2246's shipping
  PR already carries for the language-guard work, not a standalone line.
- [ ] Confirm PR #2492 (draft, `Closes #2246`) picks up these commits before
  leaving draft, per the owner's #2515 decision.
- [ ] Run the mandatory `pr-review-gate` pass before merge.
