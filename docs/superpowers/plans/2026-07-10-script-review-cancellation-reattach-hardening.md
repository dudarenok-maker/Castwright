# Script Review — job cancellation and reattach-window hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #1481's two accepted fs-58 gaps — add a book-level cancel affordance for an in-flight script-review job, and harden the reattach-on-reload path so a TOCTOU race can no longer silently start a duplicate full re-review.

**Architecture:** Server-side: a new idempotent `POST .../script-review/cancel` reuses each job's existing `AbortController`, plus a fix so a mid-chapter cancel skips checkpointing the in-flight chapter instead of persisting a partial result, plus a new terminal `cancelled` SSE event; a new `POST .../script-review/attach` joins a live job like the create route's join branch but 404s instead of falling through to create. Client-side: `api.ts` gains `cancelScriptReview`/`attachScriptReview` (real + mock); `script-review-thunk.ts` extracts a pure `hydrateLedgerIntoBucket` helper so `attachToRunningReview` can fall back to a plain ledger re-read on a 404, and both `runReviewScript`/`attachToRunningReview` treat a `cancelled`-coded error as a normal, silent terminal state instead of a failure toast; `manuscript.tsx` wires the existing (already-built, currently-unused-by-script-review) `onCancel` prop on `SubstageProgressPill`.

**Tech Stack:** Express + Vitest + supertest (server), React + Redux Toolkit + Vitest + Testing Library (client), Playwright (e2e).

## Global Constraints

- Design of record: `docs/superpowers/specs/2026-07-10-script-review-cancellation-reattach-hardening-design.md` — every task below implements a specific section of it; consult it for the full "why," not just the "what."
- Cancel is **book-level, not chapter-scoped** (spec §3, §4.1) — no `chapterId` param on the cancel endpoint.
- Cancel is **idempotent** — always `200`, never `404`, `cancelled: false` when nothing was running (spec §5, §7).
- A chapter still being reviewed at the moment of cancellation is **never checkpointed** — only chapters that finished before the cancel survive (spec §2, §4.1).
- The reattach path (`attachToRunningReview`) must **never** gain its own `finally`/`clear` dispatch — `clear` stays hoisted in `hydrateScriptReview`'s `Promise.all(...).finally()` (spec §6). This is the single most important invariant in this plan to not regress; Task 5 exists specifically to avoid reopening it.
- `hydrateLedgerIntoBucket` is a **pure transform** — entries + an already-resolved `{sentences, characterIds, manuscriptId}` snapshot in, `dispatch(hydrateBucket(...))` out. It must never take `getState`/`subscribe` and must never fetch anything itself (spec §4.2).
- The create-or-join route (`POST /:bookId/script-review`) is **untouched** — it keeps serving the "click Review Script" flow exactly as today.
- Every new/changed behavior ships a paired automated test in the same task (CLAUDE.md "Testing discipline").

---

## Task 1: Server — cancel endpoint, in-flight-chapter checkpoint skip, terminal cancelled event

**Files:**
- Modify: `server/src/routes/script-review.ts:495-537` (insert the new cancel route after the existing `/selection` PATCH route)
- Modify: `server/src/routes/script-review.ts:673-676` (skip the checkpoint on a mid-chapter abort)
- Modify: `server/src/routes/script-review.ts:706-709` (terminal event on abort)
- Test: `server/src/routes/script-review.test.ts` (new `describe('cancellation (fs-58 follow-up #1481)')` block)

**Interfaces:**
- Consumes: the existing `mainScriptReviewJobByBook: Map<string, ScriptReviewJob>` and `subsetScriptReviewJobByChapter: Map<string, ScriptReviewJob>` module-level maps, `ScriptReviewJob.controller: AbortController`, `ScriptReviewJob.bookId: string` (all already defined at `script-review.ts:233-259`).
- Produces: `POST /api/books/:bookId/script-review/cancel` → `200 { ok: true, cancelled: boolean }`. A cancelled job's SSE stream now ends with `{ kind: 'error', code: 'cancelled', message: 'Review cancelled.' }` instead of hanging with no terminal event.

- [ ] **Step 1: Write the failing tests for the cancel endpoint and the checkpoint-skip fix**

Add this new `describe` block to `server/src/routes/script-review.test.ts`, directly after the closing `});` of the existing `describe('sticky job registry', ...)` block (which ends at line 987, right before `describe('ledger checkpointing', ...)` begins at line 989):

```ts
describe('cancellation (fs-58 follow-up #1481)', () => {
  it('cancel aborts a running whole-book job, sends a cancelled terminal event, and skips the in-flight chapter\'s checkpoint', async () => {
    const { readLedger } = await import('../workspace/script-review-ledger.js');
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
    ]);
    let releaseChapter1: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementationOnce(
      () => new Promise<ScriptReviewOutput>((resolve) => { releaseChapter1 = resolve; }),
    );
    runReview.mockResolvedValue({ ops: [] });

    const { done } = firePost(`/api/books/${bookId}/script-review`, {});
    done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20)); // let chapter 1's job register and reach the gated analyzer call

    const cancelRes = await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toEqual({ ok: true, cancelled: true });

    releaseChapter1?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const res = await done;

    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'cancelled')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(events.some((e) => e.kind === 'checkpoint')).toBe(false);

    const ledger = await readLedger(bookDir(), manuscriptId);
    expect(ledger.entries['1']).toBeUndefined();
  });

  it('cancel is idempotent — no job running for the book returns cancelled:false', async () => {
    const res = await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: false });
  });

  it('cancel aborts every running subset job for a book independently of a main job', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one.' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'Chapter two.' },
    ]);
    let releaseCh1: ((v: ScriptReviewOutput) => void) | undefined;
    let releaseCh2: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementation(async (_m, chapterId): Promise<ScriptReviewOutput> => {
      if (chapterId === 1) return new Promise((resolve) => { releaseCh1 = resolve; });
      return new Promise((resolve) => { releaseCh2 = resolve; });
    });

    const ch1 = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    ch1.done.catch(() => {});
    const ch2 = firePost(`/api/books/${bookId}/script-review`, { chapterId: 2 });
    ch2.done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    const cancelRes = await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    expect(cancelRes.body).toEqual({ ok: true, cancelled: true });

    releaseCh1?.({ ops: [] });
    releaseCh2?.({ ops: [] });
    const [res1, res2] = await Promise.all([ch1.done, ch2.done]);

    expect(parseSse(res1.text).some((e) => e.kind === 'error' && e.code === 'cancelled')).toBe(true);
    expect(parseSse(res2.text).some((e) => e.kind === 'error' && e.code === 'cancelled')).toBe(true);
  });

  it('a chapter fully completed before the cancel is still checkpointed and kept', async () => {
    const { readLedger } = await import('../workspace/script-review-ledger.js');
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one.' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'Chapter two.' },
    ]);
    let releaseChapter2: ((v: ScriptReviewOutput) => void) | undefined;
    runReview
      .mockResolvedValueOnce({ ops: [{ id: 1, op: 'strip_tag', newText: 'Chapter one fixed', rationale: 'r' }] })
      .mockImplementationOnce(
        () => new Promise<ScriptReviewOutput>((resolve) => { releaseChapter2 = resolve; }),
      );

    const { done } = firePost(`/api/books/${bookId}/script-review`, {});
    done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20)); // let chapter 1 finish and chapter 2's gated call start

    await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    releaseChapter2?.({ ops: [] });
    await done;

    const ledger = await readLedger(bookDir(), manuscriptId);
    expect(ledger.entries['1'].ops).toHaveLength(1); // chapter 1 (finished before cancel) survives
    expect(ledger.entries['2']).toBeUndefined(); // chapter 2 (in flight at cancel) does not
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/script-review.test.ts -t "cancellation"`
Expected: FAIL — `request(app).post('/api/books/:bookId/script-review/cancel')` 404s (route doesn't exist yet), so every new test fails.

- [ ] **Step 3: Add the cancel route**

In `server/src/routes/script-review.ts`, insert this new route immediately after the closing `);` of the existing `/selection` PATCH route (which ends at line 537) and before the `function setUpSse(res: Response): void {` declaration (line 539):

```ts
scriptReviewRouter.post(
  '/:bookId/script-review/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    // Book-level, not chapter-scoped (design spec §4.1): aborts whichever
    // job(s) are running for this book — the whole-book job if present,
    // plus every single-chapter subset job. Deliberately skips
    // findBookByBookId (unlike every other route in this file) — this
    // only touches in-memory job maps, so an unknown bookId is
    // indistinguishable from "nothing running for this book" and both
    // correctly no-op.
    const main = mainScriptReviewJobByBook.get(bookId);
    const subsets = [...subsetScriptReviewJobByChapter.values()].filter((j) => j.bookId === bookId);
    let cancelled = false;
    for (const job of [main, ...subsets]) {
      if (!job || job.controller.signal.aborted) continue;
      job.controller.abort();
      cancelled = true;
    }
    res.status(200).json({ ok: true, cancelled });
  },
);
```

- [ ] **Step 4: Run the tests to verify the idempotent-cancel and subset-fan-out tests pass, but the checkpoint-skip tests still fail**

Run: `cd server && npx vitest run src/routes/script-review.test.ts -t "cancellation"`
Expected: `cancel is idempotent` and `cancel aborts every running subset job` PASS. `skips the in-flight chapter's checkpoint` and `a chapter fully completed before the cancel is still checkpointed` FAIL — the SSE stream never emits `kind:'error',code:'cancelled'` yet (still hangs with no terminal event on abort), and the in-flight chapter still gets checkpointed.

- [ ] **Step 5: Skip the checkpoint on a mid-chapter abort**

In `server/src/routes/script-review.ts`, replace:

```ts
      }
      ({ actualMsTotal, actualCharsTotal } = accumulateChapterPacing({ actualMsTotal, actualCharsTotal }, chapterStartedAt, charsByChapter.get(chapterId) ?? 0));
      reviewedChapters += 1;
```

(the `}` that closes the per-chunk `for` loop, at line 674, followed by lines 675-676) with:

```ts
      }
      if (job.controller.signal.aborted) {
        // Cancelled mid-chapter: skip the checkpoint for this one chapter
        // entirely rather than persisting a partial result under a
        // "reviewed" chapter id. Mirrors the existing crash-recovery
        // invariant (a chapter only checkpoints once every one of its
        // chunks has been reviewed) — a cancel and a crash now leave the
        // ledger in the same shape for whichever chapter was in flight
        // (design spec §4.1).
        break;
      }
      ({ actualMsTotal, actualCharsTotal } = accumulateChapterPacing({ actualMsTotal, actualCharsTotal }, chapterStartedAt, charsByChapter.get(chapterId) ?? 0));
      reviewedChapters += 1;
```

- [ ] **Step 6: Send a terminal cancelled event instead of hanging silently on abort**

In the same file, replace:

```ts
  if (!job.controller.signal.aborted) {
    send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
    send({ kind: 'result', done: true, reviewedChapters, totalOps });
  }
```

with:

```ts
  if (job.controller.signal.aborted) {
    send({ kind: 'error', code: 'cancelled', message: 'Review cancelled.' });
  } else {
    send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
    send({ kind: 'result', done: true, reviewedChapters, totalOps });
  }
```

- [ ] **Step 7: Run the tests to verify they all pass**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS — every test in the file, including the 4 new `cancellation` tests and every pre-existing test (the `if (job.controller.signal.aborted) break;` and terminal-event changes only fire on an aborted signal, which no pre-existing test triggers).

- [ ] **Step 8: Commit**

```bash
cd server && npx vitest run src/routes/script-review.test.ts
cd ..
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): add script-review cancel endpoint (fs-58 follow-up #1481)

Book-level POST .../script-review/cancel reuses each running job's
existing AbortController. A mid-chapter cancel now skips the checkpoint
for the in-flight chapter entirely (previously it would have persisted
a partial result indistinguishable from a fully-reviewed chapter), and
the SSE stream now ends with a terminal cancelled event instead of
hanging with no terminal event at all.

Refs #1481"
```

---

## Task 2: Server — attach-only endpoint (404 instead of fall-through-to-create)

**Files:**
- Modify: `server/src/routes/script-review.ts:537` (insert after Task 1's new cancel route)
- Test: `server/src/routes/script-review.test.ts` (new `describe('reattach-only endpoint (fs-58 follow-up #1481)')` block)

**Interfaces:**
- Consumes: `mainScriptReviewJobByBook`, `subsetScriptReviewJobByChapter`, `subsetKey(bookId, chapterId): string`, `setUpSse(res)`, `makeSubscriber(res)`, `attachSubscriber(job, sub)` — all already defined in `script-review.ts`.
- Produces: `POST /api/books/:bookId/script-review/attach` → `200` SSE stream (join + replay) on a match, `404 { error: string }` on no match.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `server/src/routes/script-review.test.ts`, directly after the `describe('cancellation (fs-58 follow-up #1481)', ...)` block added in Task 1:

```ts
describe('reattach-only endpoint (fs-58 follow-up #1481)', () => {
  it('attach joins a live job and replays its buffered events, without starting a second analyzer call', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let release: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementation(async () => new Promise<ScriptReviewOutput>((resolve) => { release = resolve; }));

    const first = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const attach = firePost(`/api/books/${bookId}/script-review/attach`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    release?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const [, attachRes] = await Promise.all([first.done, attach.done]);

    expect(runReview).toHaveBeenCalledTimes(1); // attach joined, did not start a second analyzer call
    expect(attachRes.text).toContain('"kind":"ops"');
    expect(attachRes.text).toContain('strip_tag');
  });

  it('attach 404s when no job matches the requested chapter, and leaves the actually-running chapter untouched', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    runReview.mockResolvedValue({ ops: [] });
    const running = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).post(`/api/books/${bookId}/script-review/attach`).send({ chapterId: 2 });
    expect(res.status).toBe(404);

    await running.done;
  });

  it('attach 404s when no job is running at all for the book', async () => {
    const res = await request(app).post(`/api/books/${bookId}/script-review/attach`).send({});
    expect(res.status).toBe(404);
  });

  it('attach to a whole-book job (no chapterId) joins it and replays events', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let release: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementation(async () => new Promise<ScriptReviewOutput>((resolve) => { release = resolve; }));

    const first = firePost(`/api/books/${bookId}/script-review`, {});
    await new Promise((r) => setTimeout(r, 20));

    const attach = firePost(`/api/books/${bookId}/script-review/attach`, {});
    await new Promise((r) => setTimeout(r, 20));

    release?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const [, attachRes] = await Promise.all([first.done, attach.done]);

    expect(attachRes.text).toContain('"kind":"ops"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/script-review.test.ts -t "reattach-only endpoint"`
Expected: FAIL — the `/attach` route doesn't exist, so every request 404s from Express's default handler (which happens to make the two 404 tests pass by accident) but the two join tests fail (`attachRes.text` is empty/an Express 404 body, not an SSE stream).

- [ ] **Step 3: Add the attach route**

In `server/src/routes/script-review.ts`, insert this new route immediately after Task 1's cancel route and before `function setUpSse(res: Response): void {`:

```ts
scriptReviewRouter.post(
  '/:bookId/script-review/attach',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const requestedChapterId: number | undefined =
      typeof req.body?.chapterId === 'number' ? req.body.chapterId : undefined;

    // Join-only — the create route's join branch, minus the create half.
    // No new job is ever registered here (design spec §4.2): a scope with
    // no matching entry in either map 404s instead of falling through to
    // create, which is what closes the reattach TOCTOU race.
    const job =
      requestedChapterId !== undefined
        ? subsetScriptReviewJobByChapter.get(subsetKey(bookId, requestedChapterId))
        : mainScriptReviewJobByBook.get(bookId);

    if (!job) {
      res.status(404).json({ error: 'No running review to attach to.' });
      return;
    }

    setUpSse(res);
    const sub = makeSubscriber(res);
    attachSubscriber(job, sub);
    res.on('close', () => {
      job.subscribers.delete(sub);
      clearInterval(sub.keepAlive);
    });
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Commit**

```bash
cd server && npx vitest run src/routes/script-review.test.ts
cd ..
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): add script-review attach-only endpoint (fs-58 follow-up #1481)

POST .../script-review/attach joins a live job exactly like the create
route's join branch, but 404s instead of falling through to create a new
job when no job matches the requested scope — closes the reattach
TOCTOU race where a client's join lands just after the job it meant to
join already finished.

Refs #1481"
```

---

## Task 3: openapi.yaml — document the two new operations, regenerate api-types.ts

**Files:**
- Modify: `openapi.yaml:2806` (insert after the existing `/selection` path, before `/cast/{characterId}/emotion-variant/{emotion}`)
- Generated: `src/lib/api-types.ts` (via `npm run openapi:types` — do not hand-edit)

**Interfaces:**
- Consumes: nothing new — no new `components.schemas` entries are needed, since both endpoints' request/response shapes are simple enough to inline.
- Produces: `operationId: cancelScriptReview`, `operationId: attachScriptReview` in the generated `paths` type (informational; no hand-written code in this codebase currently imports the `paths` type, only `components.schemas`, so this step is documentation-of-contract, not a functional dependency for Tasks 4-7).

- [ ] **Step 1: Add both operations to openapi.yaml**

In `openapi.yaml`, insert the following two path entries immediately after the closing of the existing `/api/books/{bookId}/script-review/selection` path (which ends at line 2806, right before the blank line preceding `/api/books/{bookId}/cast/{characterId}/emotion-variant/{emotion}:` at line 2808):

```yaml
  /api/books/{bookId}/script-review/cancel:
    post:
      summary: Cancel any in-flight script-review job(s) for a book (fs-58 follow-up)
      operationId: cancelScriptReview
      description: |
        Aborts whichever script-review job(s) are currently running for this
        book — the whole-book job if present, plus every single-chapter
        subset job — via each job's existing AbortController. Book-level,
        not chapter-scoped: the client's progress pill is keyed by bookId
        only. Idempotent: returns `cancelled: false` (still 200) when
        nothing is running, so a double-click or a stale pill never 404s.
        Chapters already checkpointed to the ledger before the cancel are
        kept; the chapter that was still being reviewed at the moment of
        cancellation is not checkpointed at all.
      parameters:
        - { in: path, name: bookId, required: true, schema: { type: string } }
      responses:
        '200':
          description: Cancel applied (or was a no-op — nothing was running)
          content:
            application/json:
              schema:
                type: object
                required: [ok, cancelled]
                properties:
                  ok: { type: boolean }
                  cancelled:
                    type: boolean
                    description: 'false when no job was running for this book.'

  /api/books/{bookId}/script-review/attach:
    post:
      summary: Attach to an already-running script-review job, without creating one (fs-58 follow-up)
      operationId: attachScriptReview
      description: |
        Joins an existing script-review job for the requested scope and
        replays its buffered events, identical to the create-or-join route's
        join branch — but never creates a new job. Used exclusively by the
        client's reattach-on-reload path to close a TOCTOU race: if the job
        finished between the client's `GET /state` call and this attach, a
        404 here (instead of silently starting a fresh review) tells the
        client to fall back to a plain ledger re-read.
      parameters:
        - { in: path, name: bookId, required: true, schema: { type: string } }
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                chapterId:
                  {
                    type: integer,
                    description: 'Optional chapter id — when present, attaches to that chapter''s single-chapter job only; when absent, attaches to the whole-book job.',
                  }
      responses:
        '200':
          description: SSE stream of buffered-then-live ops/phase/result events, same shape as the create route.
          content:
            text/event-stream:
              schema: { type: object }
        '404':
          description: No running review matches the requested scope.
```

- [ ] **Step 2: Regenerate api-types.ts**

Run: `npm run openapi:types`
Expected: exits 0, `src/lib/api-types.ts` is rewritten.

- [ ] **Step 3: Verify the new operations landed in the generated file**

Run: `grep -c "cancelScriptReview\|attachScriptReview" src/lib/api-types.ts`
Expected: a non-zero count (both operationIds appear as comments/keys in the generated `paths` type).

- [ ] **Step 4: Run typecheck to confirm nothing broke**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "docs(docs): document script-review cancel/attach endpoints in openapi.yaml

Adds cancelScriptReview and attachScriptReview operations for the two
new fs-58 follow-up routes (#1481) and regenerates api-types.ts.

Refs #1481"
```

---

## Task 4: Client `api.ts` — cancelScriptReview + attachScriptReview (real + mock)

**Files:**
- Modify: `src/lib/api.ts` (new real/mock functions, registered in both the `real`/`mock` export objects; `mockReviewScript` gains cancellation-awareness)
- Modify: `src/lib/api-review-script.test.ts` (new tests for the real functions)
- Modify: `src/lib/api.test.ts` (new tests for the mock functions)

**Interfaces:**
- Consumes: `ReviewScriptOpts`, `ReviewScriptResult`, `ReviewScriptError`, `wait()`, `readMockScriptReviewState`/`writeMockScriptReviewState`, `mockScriptReviewKey` (all already defined in `api.ts`).
- Produces: `api.cancelScriptReview(bookId: string): Promise<{ ok: boolean; cancelled: boolean }>`; `api.attachScriptReview(bookId: string, opts?: ReviewScriptOpts): Promise<ReviewScriptResult | null>` — consumed by Task 5 (`script-review-thunk.ts`) and Task 6 (`manuscript.tsx`).

- [ ] **Step 1: Write the failing tests for the real functions**

Append to `src/lib/api-review-script.test.ts`:

```ts
describe('realCancelScriptReview', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('POSTs to the cancel endpoint and returns the parsed result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, cancelled: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('./api');
    const result = await api.cancelScriptReview('bk');
    expect(result).toEqual({ ok: true, cancelled: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/books/bk/script-review/cancel', { method: 'POST' });
  });
});

describe('realAttachScriptReview', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves to null on a 404 instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const { api } = await import('./api');
    const result = await api.attachScriptReview('bk', { chapterId: 1 });
    expect(result).toBeNull();
  });

  it('replays buffered ops events on a successful join', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ kind: 'ops', chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }),
      JSON.stringify({ kind: 'result', done: true, reviewedChapters: 1, totalOps: 1 }),
    ])));
    const { api } = await import('./api');
    const ops: Array<{ chapterId: number; ops: unknown[] }> = [];
    const result = await api.attachScriptReview('bk', { chapterId: 1, onOps: (e) => ops.push(e) });
    expect(ops).toEqual([{ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }]);
    expect(result).toEqual({ reviewedChapters: 1, totalOps: 1 });
  });

  it('throws a cancelled-coded ReviewScriptError when the joined stream ends in a cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ kind: 'error', code: 'cancelled', message: 'Review cancelled.' }),
    ])));
    const { api, ReviewScriptError } = await import('./api');
    let caught: unknown;
    try {
      await api.attachScriptReview('bk', { chapterId: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewScriptError);
    expect((caught as InstanceType<typeof ReviewScriptError>).code).toBe('cancelled');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/api-review-script.test.ts`
Expected: FAIL with `api.cancelScriptReview is not a function` / `api.attachScriptReview is not a function`.

- [ ] **Step 3: Implement realCancelScriptReview and realAttachScriptReview**

In `src/lib/api.ts`, insert the following immediately after `realPatchScriptReviewSelection` (which ends at line 3425) and before `export function mockScriptReviewKey` (line 3239 — note this is actually declared BEFORE the real functions in the file; insert the two new functions right after `realPatchScriptReviewSelection`'s closing `}` at line 3425, before the blank line at 3426 that precedes `export async function mockGetScriptReviewState` at line 3427):

```ts
export interface CancelScriptReviewResult {
  ok: boolean;
  cancelled: boolean;
}

async function realCancelScriptReview(bookId: string): Promise<CancelScriptReviewResult> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/script-review/cancel`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to cancel script review (${res.status}).`);
  return res.json();
}

/* fs-58 follow-up (#1481) — a SEPARATE function from realReviewScript, not a
   shared call: it reuses the same fetch+reader SSE-parsing approach against
   the new /attach URL, but realReviewScript hardcodes
   `if (res.status === 404) throw new ReviewScriptError(...)` (line 3147),
   which is the wrong behavior here — a 404 means "no job to join," an
   expected, handled outcome (design spec §4.2), not a failure. */
async function realAttachScriptReview(
  bookId: string,
  { chapterId, signal, onPhase, onThrottle, onOps, onChapterFailed, onCheckpoint }: ReviewScriptOpts = {},
): Promise<ReviewScriptResult | null> {
  const body: Record<string, unknown> = {};
  if (chapterId !== undefined) body.chapterId = chapterId;
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/script-review/attach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok || !res.body) throw new Error(`Script-review attach failed (${res.status}).`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result: ReviewScriptResult | null = null;

  const handle = (p: Record<string, unknown>) => {
    switch (p.kind) {
      case 'phase': {
        const phaseEvent = parseSubstagePhaseEvent(p);
        if (phaseEvent) onPhase?.(phaseEvent);
        break;
      }
      case 'throttle':
        if (typeof p.chapterIndex === 'number' && typeof p.waitMs === 'number') {
          onThrottle?.({
            chapterId: p.chapterIndex,
            waitMs: p.waitMs,
            reason: String(p.reason ?? ''),
          });
        }
        break;
      case 'ops':
        if (typeof p.chapterId === 'number' && Array.isArray(p.ops)) {
          onOps?.({
            chapterId: p.chapterId,
            ops: p.ops as import('./script-review-apply').ReviewOp[],
          });
        }
        break;
      case 'chapter-failed':
        if (typeof p.chapterId === 'number') {
          onChapterFailed?.({ chapterId: p.chapterId, message: typeof p.message === 'string' ? p.message : 'Chapter review failed.' });
        }
        break;
      case 'checkpoint':
        if (typeof p.chapterId === 'number' && typeof p.version === 'number') {
          onCheckpoint?.({ chapterId: p.chapterId, version: p.version });
        }
        break;
      case 'result':
        result = {
          reviewedChapters: typeof p.reviewedChapters === 'number' ? p.reviewedChapters : 0,
          totalOps: typeof p.totalOps === 'number' ? p.totalOps : 0,
        };
        break;
      case 'error':
        throw new ReviewScriptError(
          typeof p.message === 'string' ? p.message : 'Script review failed.',
          typeof p.code === 'string' ? p.code : 'unknown',
        );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      if (!dataLines.length) continue;
      handle(JSON.parse(dataLines.join('\n')) as Record<string, unknown>);
    }
  }

  if (!result) throw new Error('Script-review attach stream ended without a result event.');
  return result;
}
```

- [ ] **Step 4: Register the real functions in the `real` export object**

In `src/lib/api.ts`, in the large `real`-named export object, replace:

```ts
  reviewScript: realReviewScript,
  getScriptReviewState: realGetScriptReviewState,
  discardScriptReview: realDiscardScriptReview,
  resolveScriptReviewOps: realResolveScriptReviewOps,
  patchScriptReviewSelection: realPatchScriptReviewSelection,
```

with:

```ts
  reviewScript: realReviewScript,
  cancelScriptReview: realCancelScriptReview,
  attachScriptReview: realAttachScriptReview,
  getScriptReviewState: realGetScriptReviewState,
  discardScriptReview: realDiscardScriptReview,
  resolveScriptReviewOps: realResolveScriptReviewOps,
  patchScriptReviewSelection: realPatchScriptReviewSelection,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/api-review-script.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing tests for the mock functions**

Add this new `describe` block to `src/lib/api.test.ts`, directly after the closing `});` of the existing `describe('mock-mode script-review resolve/selection persistence (fs-58 PR-review Finding 2)', ...)` block:

```ts
describe('mock-mode script-review cancellation (fs-58 follow-up #1481)', () => {
  const cancelBookId = 'book-mock-cancel';

  beforeEach(() => {
    sessionStorage.clear();
  });

  it('mockCancelScriptReview clears the running flag and reports cancelled:true when a job was running', async () => {
    sessionStorage.setItem(mockScriptReviewKey(cancelBookId), JSON.stringify({
      running: { lastPhase: { progress: 0.5, label: 'Reviewing script' } },
      entries: {},
    }));
    const result = await mockCancelScriptReview(cancelBookId);
    expect(result).toEqual({ ok: true, cancelled: true });
    const state = await mockGetScriptReviewState(cancelBookId);
    expect(state.kind).toBe('ledger');
  });

  it('mockCancelScriptReview is idempotent — cancelled:false when nothing is running', async () => {
    const result = await mockCancelScriptReview(cancelBookId);
    expect(result).toEqual({ ok: true, cancelled: false });
  });

  it('mockAttachScriptReview resolves to null when nothing is running', async () => {
    const result = await mockAttachScriptReview(cancelBookId, {});
    expect(result).toBeNull();
  });

  it('mockAttachScriptReview seeds onPhase from the running job\'s lastPhase and resolves non-null when a job is running', async () => {
    sessionStorage.setItem(mockScriptReviewKey(cancelBookId), JSON.stringify({
      running: { lastPhase: { progress: 0.4, label: 'Reviewing script' } },
      entries: {},
    }));
    const phases: Array<{ progress: number }> = [];
    const result = await mockAttachScriptReview(cancelBookId, { onPhase: (p) => phases.push(p) });
    expect(phases).toEqual([{ progress: 0.4, label: 'Reviewing script' }]);
    expect(result).toEqual({ reviewedChapters: 0, totalOps: 0 });
  });

  it('mockReviewScript throws a cancelled-coded ReviewScriptError if mockCancelScriptReview clears the running flag mid-run', async () => {
    const runPromise = mockReviewScript(cancelBookId, {});
    // Let the mock reach its first phase tick (60ms, sets `running` non-null)
    // before cancelling — cancelling before the first tick would race the
    // mock's own initial write and isn't the scenario under test.
    await new Promise((r) => setTimeout(r, 100));
    await mockCancelScriptReview(cancelBookId);

    let caught: unknown;
    try {
      await runPromise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewScriptError);
    expect((caught as InstanceType<typeof ReviewScriptError>).code).toBe('cancelled');
  });
});
```

Add `mockReviewScript`, `mockCancelScriptReview`, `mockAttachScriptReview`, `ReviewScriptError` to the top-of-file import block in `src/lib/api.test.ts` (currently `import { mockGetSetupReadiness, ..., mockGetScriptReviewState, mockResolveScriptReviewOps, mockPatchScriptReviewSelection, mockScriptReviewKey, type LedgerEntryDTO, api } from './api';` at lines 2-21) — insert `mockReviewScript, mockCancelScriptReview, mockAttachScriptReview, ReviewScriptError,` into that same named-import list (order doesn't matter; keep alongside the other script-review mock imports).

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run src/lib/api.test.ts -t "mock-mode script-review cancellation"`
Expected: FAIL — `mockReviewScript`, `mockCancelScriptReview`, `mockAttachScriptReview` are not exported yet, and `mockReviewScript` doesn't check for cancellation.

- [ ] **Step 8: Implement mockCancelScriptReview and mockAttachScriptReview, export mockReviewScript, make mockReviewScript cancellation-aware**

In `src/lib/api.ts`, change `async function mockReviewScript(` (line 3262) to `export async function mockReviewScript(` — exported the same way `mockResolveScriptReviewOps`/`mockPatchScriptReviewSelection` already are, so `api.test.ts` can drive it directly.

Still inside `mockReviewScript`, replace the body from the `const noteCheckpoint = ...` closure through the end of the timeline (down to and including the first `noteCheckpoint(3, 1);` call) — i.e. replace:

```ts
  const noteCheckpoint = (chId: number, version: number) => {
    versionAccum[chId] = version;
    onCheckpoint?.({ chapterId: chId, version });
  };

  await wait(60);
  notePhase({ progress: 0.25, label: 'Reviewing script', chapterId: 1, chapterIndex: 1, totalChapters: 3 });
  await wait(500);
  notePhase({
    progress: 0.5,
    label: 'Reviewing script',
    chapterId: 3,
    chapterIndex: 2,
    totalChapters: 3,
    estRemainingMs: 20_000,
  });
  await wait(500);
  notePhase({
    progress: 0.85,
    label: 'Reviewing script',
    chapterId: 3,
    chapterIndex: 3,
    totalChapters: 3,
    estRemainingMs: 5_000,
  });
  await wait(400);
  /* fs-58 Unit A: strip_tag on sentence id:1 (chapterId:3). */
  noteOps(3, [{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }]);
  noteCheckpoint(3, 1);
```

with:

```ts
  const noteCheckpoint = (chId: number, version: number) => {
    versionAccum[chId] = version;
    onCheckpoint?.({ chapterId: chId, version });
  };
  /* fs-58 follow-up (#1481) — mirrors the real server's job-registry abort
     check so the mandated e2e Cancel spec has something real to observe.
     `notePhase` writes `running` non-null on every tick; if it now reads
     null, something else (mockCancelScriptReview) cleared it since our own
     last tick — nothing else writes this book's mock state concurrently.
     Checked only BETWEEN ticks, never before the first one (which would
     misfire on a fresh run that hasn't ticked yet). */
  const throwIfCancelled = () => {
    if (readMockScriptReviewState(bookId).running === null) {
      throw new ReviewScriptError('Review cancelled.', 'cancelled');
    }
  };

  await wait(60);
  notePhase({ progress: 0.25, label: 'Reviewing script', chapterId: 1, chapterIndex: 1, totalChapters: 3 });
  await wait(500);
  throwIfCancelled();
  notePhase({
    progress: 0.5,
    label: 'Reviewing script',
    chapterId: 3,
    chapterIndex: 2,
    totalChapters: 3,
    estRemainingMs: 20_000,
  });
  await wait(500);
  throwIfCancelled();
  notePhase({
    progress: 0.85,
    label: 'Reviewing script',
    chapterId: 3,
    chapterIndex: 3,
    totalChapters: 3,
    estRemainingMs: 5_000,
  });
  await wait(400);
  throwIfCancelled();
  /* fs-58 Unit A: strip_tag on sentence id:1 (chapterId:3). */
  noteOps(3, [{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }]);
  noteCheckpoint(3, 1);
```

Now add `mockCancelScriptReview` and `mockAttachScriptReview` immediately after `mockPatchScriptReviewSelection`'s closing `}` (at line 3481) and before the `/* fs-34 — drop a designed Qwen emotion variant... */` comment (line 3483):

```ts
export async function mockCancelScriptReview(bookId: string): Promise<CancelScriptReviewResult> {
  const state = readMockScriptReviewState(bookId);
  const cancelled = state.running !== null;
  writeMockScriptReviewState(bookId, { running: null, entries: state.entries });
  return { ok: true, cancelled };
}

export async function mockAttachScriptReview(
  bookId: string,
  { onPhase }: ReviewScriptOpts = {},
): Promise<ReviewScriptResult | null> {
  const state = readMockScriptReviewState(bookId);
  if (!state.running) return null;
  onPhase?.(state.running.lastPhase);
  return { reviewedChapters: 0, totalOps: 0 };
}
```

- [ ] **Step 9: Register the mock functions in the `mock` export object**

In `src/lib/api.ts`, in the large `mock`-named export object, replace:

```ts
  reviewScript: mockReviewScript,
  getScriptReviewState: mockGetScriptReviewState,
  discardScriptReview: mockDiscardScriptReview,
  resolveScriptReviewOps: mockResolveScriptReviewOps,
  patchScriptReviewSelection: mockPatchScriptReviewSelection,
```

with:

```ts
  reviewScript: mockReviewScript,
  cancelScriptReview: mockCancelScriptReview,
  attachScriptReview: mockAttachScriptReview,
  getScriptReviewState: mockGetScriptReviewState,
  discardScriptReview: mockDiscardScriptReview,
  resolveScriptReviewOps: mockResolveScriptReviewOps,
  patchScriptReviewSelection: mockPatchScriptReviewSelection,
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run src/lib/api.test.ts src/lib/api-review-script.test.ts`
Expected: PASS — all tests in both files, including every pre-existing one (the `mockReviewScript` timeline change is additive-only: `throwIfCancelled()` only fires when `running` reads `null` after having been set non-null, which no pre-existing test triggers).

- [ ] **Step 11: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 12: Commit**

```bash
npx vitest run src/lib/api.test.ts src/lib/api-review-script.test.ts
npm run typecheck
git add src/lib/api.ts src/lib/api.test.ts src/lib/api-review-script.test.ts
git commit -m "feat(frontend): add cancelScriptReview/attachScriptReview to the api layer (fs-58 follow-up #1481)

Real implementations hit the two new server routes from Task 1/2.
attachScriptReview resolves to null on a 404 instead of throwing (an
expected outcome, not a failure). Mock-mode gets matching
mockCancelScriptReview/mockAttachScriptReview, and mockReviewScript
itself becomes cancellation-aware (checks between its timed phase ticks
whether mockCancelScriptReview cleared the running flag) so the
mandated e2e Cancel spec (Task 7) has real behavior to observe — e2e
always runs against api.mock, never the real server.

Refs #1481"
```

---

## Task 5: Client thunk — reattach hardening + cancellation awareness in script-review-thunk.ts

**Files:**
- Modify: `src/store/script-review-thunk.ts`
- Modify: `src/store/script-review-thunk.test.ts`

**Interfaces:**
- Consumes: `api.attachScriptReview` (Task 4), `ReviewScriptError` (Task 4), `LedgerEntryDTO` (already exported from `api.ts`).
- Produces: `attachToRunningReview` now calls `api.attachScriptReview` and, on a `null` result, dispatches `hydrateBucket` via the new (unexported) `hydrateLedgerIntoBucket` helper instead of falling through to a fresh review. Both `runReviewScript` and `attachToRunningReview` silently swallow a `cancelled`-coded `ReviewScriptError` instead of toasting it. `attachToRunningReview` still never dispatches `clear` itself.

- [ ] **Step 1: Write the failing tests**

First, update the top-of-file mock in `src/store/script-review-thunk.test.ts`. Replace:

```ts
vi.mock('../lib/api', () => ({
  api: {
    reviewScript: vi.fn(),
    getScriptReviewState: vi.fn(),
    discardScriptReview: vi.fn(),
    resolveScriptReviewOps: vi.fn(),
    patchScriptReviewSelection: vi.fn(),
  },
}));
```

with:

```ts
vi.mock('../lib/api', () => ({
  api: {
    reviewScript: vi.fn(),
    attachScriptReview: vi.fn(),
    getScriptReviewState: vi.fn(),
    discardScriptReview: vi.fn(),
    resolveScriptReviewOps: vi.fn(),
    patchScriptReviewSelection: vi.fn(),
  },
  // Re-derived here (mirrors analysis-stream-middleware.test.ts's identical
  // AnalysisError pattern) so `err instanceof ReviewScriptError` inside
  // script-review-thunk.ts's own code resolves against the SAME class
  // reference this mock factory exports — a plain vi.fn()-based stub
  // couldn't satisfy an instanceof check.
  ReviewScriptError: class ReviewScriptError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));
```

Then update the top-of-file import line. Replace:

```ts
import { api } from '../lib/api';
import type { ReviewScriptOpts } from '../lib/api';
```

with:

```ts
import { api, ReviewScriptError } from '../lib/api';
import type { ReviewScriptOpts } from '../lib/api';
```

Now update the 3 existing tests that mock `api.reviewScript` for the running-job/attach path — each needs only `api.reviewScript` changed to `api.attachScriptReview`.

Test 1 — find (inside `describe('hydrateScriptReview', ...)`, the test titled `'when kind is "running" with non-empty entries, hydrates the ledger entries AND attaches to the running job...'`):

```ts
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 7, version: 1 });
      opts.onOps?.({ chapterId: 7, ops: [{ id: 2, op: 'strip_tag', newText: 'Chapter seven fixed', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
```

replace with:

```ts
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 7, version: 1 });
      opts.onOps?.({ chapterId: 7, ops: [{ id: 2, op: 'strip_tag', newText: 'Chapter seven fixed', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
```

Test 2 — find (the test titled `'attaches to multiple concurrently-running jobs from the running array and merges both into the bucket'`):

```ts
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      // Both joins replay through the same api.reviewScript mock — key off
      // the requested chapterId (threaded via opts) to reply with each
      // job's own ops, so the two attaches don't cross-contaminate.
      const chapterId = opts.chapterId;
      if (chapterId === 5) {
        opts.onCheckpoint?.({ chapterId: 5, version: 1 });
        opts.onOps?.({ chapterId: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }] });
      } else if (chapterId === 9) {
        opts.onCheckpoint?.({ chapterId: 9, version: 1 });
        opts.onOps?.({ chapterId: 9, ops: [{ id: 2, op: 'strip_tag', newText: 'Nine fixed', rationale: 'r' }] });
      }
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
```

replace with:

```ts
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      // Both joins replay through the same api.attachScriptReview mock —
      // key off the requested chapterId (threaded via opts) to reply with
      // each job's own ops, so the two attaches don't cross-contaminate.
      const chapterId = opts.chapterId;
      if (chapterId === 5) {
        opts.onCheckpoint?.({ chapterId: 5, version: 1 });
        opts.onOps?.({ chapterId: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }] });
      } else if (chapterId === 9) {
        opts.onCheckpoint?.({ chapterId: 9, version: 1 });
        opts.onOps?.({ chapterId: 9, ops: [{ id: 2, op: 'strip_tag', newText: 'Nine fixed', rationale: 'r' }] });
      }
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
```

Test 3 — find (the test titled `'dispatches setActive exactly once (seeded from the first job\'s replay) and clear exactly once, only after ALL concurrent jobs settle'`):

```ts
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      if (opts.chapterId === 5) await fivePromise;
      else if (opts.chapterId === 9) await ninePromise;
      return { reviewedChapters: 1, totalOps: 0 } as never;
    });
```

replace with:

```ts
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      if (opts.chapterId === 5) await fivePromise;
      else if (opts.chapterId === 9) await ninePromise;
      return { reviewedChapters: 1, totalOps: 0 } as never;
    });
```

There is also a SEPARATE, older `describe('attachToRunningReview', ...)` block (lines 490-580, right after the `describe('runReviewScript — version delivery', ...)` block and before `describe('discardReview', ...)`) predating the round-5 refactor — its 3 tests call `attachToRunningReview` directly and 2 of them mock `api.reviewScript` too. These need the identical `api.reviewScript` → `api.attachScriptReview` substitution, or Task 5 lands with 2 red tests (their `onOps`/`onCheckpoint`/rejection wiring would sit on a mock `attachToRunningReview` no longer calls).

Test 4 — find (the test titled `'does NOT dispatch setActive or clear itself — that is hydrateScriptReview\'s job now'`):

```ts
    vi.mocked(api.reviewScript).mockResolvedValue({ reviewedChapters: 0, totalOps: 0 } as never);
```

replace with:

```ts
    vi.mocked(api.attachScriptReview).mockResolvedValue({ reviewedChapters: 0, totalOps: 0 } as never);
```

Test 5 — find (the test titled `'dispatches setReview with the ops/versions delivered by the join\'s own replay — not double-counted with the GET /state snapshot'`):

```ts
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 5 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
```

replace with:

```ts
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 5 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
```

Test 6 — find (the test titled `'dispatches an error toast when the join POST rejects, mirroring runReviewScript\'s catch path'`):

```ts
    vi.mocked(api.reviewScript).mockRejectedValue(new Error('join failed'));
```

replace with:

```ts
    vi.mocked(api.attachScriptReview).mockRejectedValue(new Error('join failed'));
```

Finally, append these new tests immediately after this older `describe('attachToRunningReview', ...)` block's closing `});` (line 580) and before `describe('discardReview', ...)` (line 582) — keeping every `attachToRunningReview`-focused describe block adjacent, rather than at the true end of the file:

```ts
describe('attachToRunningReview — reattach-race hardening (fs-58 follow-up #1481)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on a null (404) attach result, falls back to a fresh ledger re-read via hydrateBucket instead of starting a fresh review', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockResolvedValue(null);
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'ledger',
      entries: {
        '5': {
          manuscriptId: 'ms-1',
          version: 3,
          ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }],
          selected: {},
          completedAt: '2026-01-01',
        },
      },
    });

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      {
        dispatch,
        sentences: [{ id: 1, chapterId: 5, text: 'Five fixed', characterId: 'c1' }],
        characterIds: new Set(['c1']),
        manuscriptId: 'ms-1',
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.hydrateBucket(
        expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 5: 3 } }),
      ),
    );
    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.setReview.type)).toBe(false);
    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.clear.type)).toBe(false);
  });

  it('never dispatches clear itself, even on error — clear stays hoisted in hydrateScriptReview (round-5 fix, must not regress)', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockRejectedValue(new Error('boom'));

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      { dispatch, sentences: [], characterIds: new Set(), manuscriptId: 'ms-1' },
    );

    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.clear.type)).toBe(false);
  });

  it('a cancelled-coded ReviewScriptError is swallowed without a toast', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockRejectedValue(new ReviewScriptError('Review cancelled.', 'cancelled'));

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      { dispatch, sentences: [], characterIds: new Set(), manuscriptId: 'ms-1' },
    );

    expect(dispatch.mock.calls.some((c) => c[0].type === notificationsActions.pushToast.type)).toBe(false);
  });
});

describe('runReviewScript — cancellation (fs-58 follow-up #1481)', () => {
  it('a cancelled-coded ReviewScriptError is swallowed without a toast, and clear still fires', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockRejectedValue(new ReviewScriptError('Review cancelled.', 'cancelled'));

    await runReviewScript('book-1', {
      dispatch, wholeBook: true, model: 'test-model', sentences: [], characterIds: new Set(), manuscriptId: 'ms-1',
    });

    expect(dispatch.mock.calls.some((c) => c[0].type === notificationsActions.pushToast.type)).toBe(false);
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types[types.length - 1]).toBe(scriptReviewActions.clear.type);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/script-review-thunk.test.ts`
Expected: FAIL — `attachToRunningReview` still calls `api.reviewScript`, so all 5 tests just re-targeted onto `api.attachScriptReview` (3 in `describe('hydrateScriptReview', ...)`, 2 in `describe('attachToRunningReview', ...)`) fail (their mock is never hit — `api.attachScriptReview` is an unconfigured `vi.fn()` returning `undefined`), and the new tests fail (no `cancelled`-code handling, no `hydrateLedgerIntoBucket` fallback).

- [ ] **Step 3: Add the LedgerEntryDTO import and the hydrateLedgerIntoBucket helper**

In `src/store/script-review-thunk.ts`, replace the top-of-file import:

```ts
import type { AppDispatch, RootState } from './index';
import { api } from '../lib/api';
import { planApply, type ReviewOp } from '../lib/script-review-apply';
import { scriptReviewActions, opKey, type ReviewOpWithChapter } from './script-review-slice';
import { notificationsActions } from './notifications-slice';
```

with:

```ts
import type { AppDispatch, RootState } from './index';
import { api, ReviewScriptError, type LedgerEntryDTO } from '../lib/api';
import { planApply, type ReviewOp } from '../lib/script-review-apply';
import { scriptReviewActions, opKey, type ReviewOpWithChapter } from './script-review-slice';
import { notificationsActions } from './notifications-slice';
```

Then, immediately before the `export async function attachToRunningReview(` declaration, insert:

```ts
/** Transform+dispatch a book's ledger entries into its scriptReview bucket.
    Pure — takes the entries and an already-resolved manuscript/cast
    snapshot as plain arguments, and does no fetching of its own. This is
    what makes it callable from both hydrateScriptReview's top block
    (which already has both in scope from its own GET /state +
    waitForManuscriptAndCast calls) and attachToRunningReview's 404
    fallback below (which has no getState/subscribe in scope, but already
    receives sentences/characterIds/manuscriptId directly in its own opts
    — see design spec §4.2). No-ops on an empty entries map. */
function hydrateLedgerIntoBucket(
  bookId: string,
  entries: Record<string, LedgerEntryDTO>,
  snapshot: { dispatch: AppDispatch; sentences: ReviewLiveSentence[]; characterIds: Set<string>; manuscriptId: string },
): void {
  const { dispatch, sentences, characterIds, manuscriptId } = snapshot;
  const chapterEntries = Object.entries(entries);
  if (chapterEntries.length === 0) return;

  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};
  const persistedSelected: Record<string, boolean> = {};
  for (const [chapterKey, entry] of chapterEntries) {
    const chapterId = Number(chapterKey);
    versionByChapter[chapterId] = entry.version;
    for (const op of entry.ops as unknown as ReviewOp[]) allOps.push({ ...op, chapterId });
    Object.assign(persistedSelected, entry.selected);
  }

  const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
    appliable: ReviewOpWithChapter[];
    unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
  };
  const selected: Record<string, boolean> = {};
  for (const o of appliable) {
    const key = opKey(o.chapterId, o.id, o.op);
    selected[key] = key in persistedSelected ? persistedSelected[key] : !DEFAULT_OFF.has(o.op);
  }

  dispatch(scriptReviewActions.hydrateBucket({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter, selected }));
}
```

Note: `DEFAULT_OFF` is already a module-level `const` in this file (defined at line 204, *below* `attachToRunningReview`'s current start at line 144 — i.e. also below where `hydrateLedgerIntoBucket` is being inserted). No new declaration is needed, and no functional issue either: `hydrateLedgerIntoBucket` is a hoisted `function` declaration that only reads `DEFAULT_OFF` when it's *called* (never at module-evaluation time), and by the time anything calls it the whole module — including `DEFAULT_OFF`'s `const` initializer — has already finished evaluating once. This is a plain forward reference inside a function body, not a temporal-dead-zone violation.

- [ ] **Step 4: Update attachToRunningReview**

Replace the entire body of `attachToRunningReview` (from its `export async function attachToRunningReview(` signature through its closing `}`) with:

```ts
export async function attachToRunningReview(
  bookId: string,
  running: RunningReviewState,
  opts: { dispatch: AppDispatch; sentences: ReviewLiveSentence[]; characterIds: Set<string>; manuscriptId: string },
): Promise<void> {
  const { dispatch, sentences, characterIds, manuscriptId } = opts;
  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};

  try {
    const result = await api.attachScriptReview(bookId, {
      ...(running.chapterId !== undefined ? { chapterId: running.chapterId } : {}),
      onPhase: ({ progress, label, chapterIndex, totalChapters, estRemainingMs }) =>
        dispatch(
          scriptReviewActions.updateProgress({ bookId, progress, label, chapterIndex, totalChapters, estRemainingMs }),
        ),
      onOps: ({ chapterId, ops }: { chapterId: number; ops: ReviewOp[] }) => {
        for (const op of ops) allOps.push({ ...op, chapterId });
      },
      onChapterFailed: () => {},
      onCheckpoint: ({ chapterId, version }: { chapterId: number; version: number }) => {
        versionByChapter[chapterId] = version;
      },
    });
    if (result === null) {
      // TOCTOU: the job finished between GET /state and this join — fall
      // back to a plain ledger re-read instead of silently starting a
      // fresh review (design spec §4.2).
      const freshState = await api.getScriptReviewState(bookId);
      hydrateLedgerIntoBucket(bookId, freshState.entries, { dispatch, sentences, characterIds, manuscriptId });
      return;
    }
    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter }));
  } catch (err) {
    // Cancellation (fs-58 follow-up #1481) is a normal, silent terminal
    // state, not a failure — mirrors detect-emotions-button.tsx's silent
    // AbortError handling and analysis-stream-middleware.ts's
    // code==='aborted' handling. Deliberately NO finally/clear here — see
    // the module-level comment above this function for why.
    if (err instanceof ReviewScriptError && err.code === 'cancelled') return;
    dispatch(
      notificationsActions.pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Script review failed.',
      }),
    );
  }
}
```

- [ ] **Step 5: Remove the now-stale "known, accepted limitation" comment**

In `src/store/script-review-thunk.ts`, delete the entire comment block (it directly follows `attachToRunningReview`'s closing `}` and precedes `const DEFAULT_OFF = ...`) that begins `// Known, accepted limitation — a narrow reattach race.` and ends `// instead of silently absorbing them.` — this comment describes exactly the TOCTOU gap this task closes, so it is now false.

- [ ] **Step 6: Suppress the cancelled-code toast in runReviewScript**

In the same file, inside `runReviewScript`, replace:

```ts
  } catch (err) {
    dispatch(
      notificationsActions.pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Script review failed.',
      }),
    );
  } finally {
    dispatch(scriptReviewActions.clear({ bookId }));
  }
```

with:

```ts
  } catch (err) {
    if (!(err instanceof ReviewScriptError && err.code === 'cancelled')) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Script review failed.',
        }),
      );
    }
  } finally {
    dispatch(scriptReviewActions.clear({ bookId }));
  }
```

- [ ] **Step 7: Simplify hydrateScriptReview's top block to call the new helper**

In the same file, inside `hydrateScriptReview`, replace:

```ts
  const chapterEntries = Object.entries(state.entries);
  if (chapterEntries.length > 0) {
    const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe, bookId);

    const allOps: ReviewOpWithChapter[] = [];
    const versionByChapter: Record<number, number> = {};
    const persistedSelected: Record<string, boolean> = {};
    for (const [chapterKey, entry] of chapterEntries) {
      const chapterId = Number(chapterKey);
      versionByChapter[chapterId] = entry.version;
      // entry.ops is the generated ScriptReviewLedgerEntry's deliberately-loose
      // `{[key: string]: unknown}[]` (openapi.yaml keeps the per-op-kind shape
      // permissive rather than duplicating ReviewOp's discriminated shape) —
      // the `unknown` bounce recovers the concrete shape this code already
      // knows the ledger actually carries.
      for (const op of entry.ops as unknown as ReviewOp[]) allOps.push({ ...op, chapterId });
      Object.assign(persistedSelected, entry.selected);
    }

    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    const selected: Record<string, boolean> = {};
    for (const o of appliable) {
      const key = opKey(o.chapterId, o.id, o.op);
      selected[key] = key in persistedSelected ? persistedSelected[key] : !DEFAULT_OFF.has(o.op);
    }

    dispatch(scriptReviewActions.hydrateBucket({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter, selected }));
  }
```

with:

```ts
  const chapterEntries = Object.entries(state.entries);
  if (chapterEntries.length > 0) {
    const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe, bookId);
    hydrateLedgerIntoBucket(bookId, state.entries, { dispatch, sentences, characterIds, manuscriptId });
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/store/script-review-thunk.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
npx vitest run src/store/script-review-thunk.test.ts
npm run typecheck
git add src/store/script-review-thunk.ts src/store/script-review-thunk.test.ts
git commit -m "feat(frontend): reattach-race hardening + cancellation awareness in script-review-thunk (fs-58 follow-up #1481)

attachToRunningReview now calls api.attachScriptReview and, on a 404
(job finished in the TOCTOU gap), falls back to a fresh ledger re-read
via the new hydrateLedgerIntoBucket helper instead of the old create
route silently starting a duplicate full re-review. Both
runReviewScript and attachToRunningReview now treat a cancelled-coded
ReviewScriptError as a normal, silent terminal state instead of an
error toast. attachToRunningReview still never dispatches clear itself
— that stays hoisted in hydrateScriptReview per the existing round-5
fix, which this task does not reopen.

Refs #1481"
```

---

## Task 6: Client UI — wire the Cancel button on the script-review progress pill

**Files:**
- Modify: `src/views/manuscript.tsx`
- Modify: `src/views/manuscript.test.tsx`

**Interfaces:**
- Consumes: `api.cancelScriptReview` (Task 4), the existing `onCancel?: () => void` prop on `SubstageProgressPill` (`src/components/substage-progress-pill.tsx` — already built, currently unused by the script-review call site).
- Produces: a visible "Cancel" button on the script-review progress pill that calls `api.cancelScriptReview(bookId)`.

- [ ] **Step 1: Write the failing test**

In `src/views/manuscript.test.tsx`, update the top-of-file mock. Replace:

```ts
const { reviewScript, createCharacter, getScriptReviewState, discardScriptReview } = vi.hoisted(() => ({
  reviewScript: vi.fn(),
  createCharacter: vi.fn(),
  getScriptReviewState: vi.fn().mockResolvedValue({ kind: 'ledger', entries: {} }),
  discardScriptReview: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: { ...(actual as { api: object }).api, reviewScript, createCharacter, getScriptReviewState, discardScriptReview },
  };
});
```

with:

```ts
const { reviewScript, createCharacter, getScriptReviewState, discardScriptReview, cancelScriptReview } = vi.hoisted(() => ({
  reviewScript: vi.fn(),
  createCharacter: vi.fn(),
  getScriptReviewState: vi.fn().mockResolvedValue({ kind: 'ledger', entries: {} }),
  discardScriptReview: vi.fn().mockResolvedValue(undefined),
  cancelScriptReview: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: { ...(actual as { api: object }).api, reviewScript, createCharacter, getScriptReviewState, discardScriptReview, cancelScriptReview },
  };
});
```

Then add this new test at the end of the `describe('ManuscriptView — script-review planApply quarantine at seed', ...)` block — insert it as the last `it(...)` inside that block, immediately before the block's closing `});` (the block starts at line 1046 and its final existing test, `'shows chapter count + ETA on the Review Script inline chip while a review runs'`, ends around line 1285):

```ts
  it('clicking Cancel on the progress pill calls api.cancelScriptReview with the book id', async () => {
    const user = userEvent.setup();
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [liveSentence] as never,
        },
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-1',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });

    let triggerResolve!: () => void;
    reviewScript.mockImplementation(
      (
        _bookId: string,
        opts?: { onPhase?: (e: { progress: number; label?: string }) => void },
      ) => {
        opts?.onPhase?.({ progress: 0.3, label: 'Reviewing script' });
        return new Promise<void>((resolve) => {
          triggerResolve = resolve;
        });
      },
    );

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[quarantineChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[liveSentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-chapter'));
    await waitFor(() => expect(screen.getByTestId('review-script-progress')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelScriptReview).toHaveBeenCalledWith('bk-1');

    /* Settle the mock's promise before the test ends — same cleanup
       discipline as the sibling "shows chapter count + ETA" test above. */
    triggerResolve();
    reviewScript.mockReset();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/views/manuscript.test.tsx -t "clicking Cancel on the progress pill"`
Expected: FAIL — `screen.getByRole('button', { name: 'Cancel' })` throws (no Cancel button rendered yet, since the pill's `onCancel` prop isn't wired).

- [ ] **Step 3: Add handleCancelReview and wire it onto the pill**

In `src/views/manuscript.tsx`, add a new function immediately after `handleReviewScript`'s closing `}` (which ends at line 861) and before `function handleReviewExisting() {` (line 863):

```ts
  function handleCancelReview() {
    if (!bookId) return;
    void api.cancelScriptReview(bookId);
  }
```

Then replace:

```ts
              {reviewSubstage && (
                <SubstageProgressPill
                  testId="review-script-progress"
                  detailTestId="review-script-progress-detail"
                  status={reviewSubstage.label}
                  detailText={reviewSubstageDetailText}
                  percent={reviewSubstage.progress}
                />
              )}
```

with:

```ts
              {reviewSubstage && (
                <SubstageProgressPill
                  testId="review-script-progress"
                  detailTestId="review-script-progress-detail"
                  status={reviewSubstage.label}
                  detailText={reviewSubstageDetailText}
                  percent={reviewSubstage.progress}
                  onCancel={handleCancelReview}
                />
              )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/views/manuscript.test.tsx -t "clicking Cancel on the progress pill"`
Expected: PASS.

- [ ] **Step 5: Run the full manuscript test file to confirm no regressions**

Run: `npx vitest run src/views/manuscript.test.tsx`
Expected: PASS — every test in the file.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
npx vitest run src/views/manuscript.test.tsx
npm run typecheck
git add src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): wire the Cancel button on the script-review progress pill (fs-58 follow-up #1481)

SubstageProgressPill's onCancel prop already existed (built for
detect-emotions) but script-review's call site never passed it —
wires handleCancelReview, which fire-and-forgets
api.cancelScriptReview(bookId), matching the void handleReviewScript(...)
convention already used on the same button.

Refs #1481"
```

---

## Task 7: E2E — Cancel button mid-review

**Files:**
- Modify: `e2e/script-review-pill-progress.spec.ts`

**Interfaces:**
- Consumes: Task 4's `mockCancelScriptReview`/cancellation-aware `mockReviewScript`, Task 6's wired Cancel button.
- Produces: browser-level proof that clicking Cancel stops the pill, re-enables the button, and allows an immediate fresh review — the one part of this feature that's meaningfully hard to fake in Vitest+jsdom (real button → SSE-shaped mock stream → store wiring, end to end).

- [ ] **Step 1: Write the failing test**

Add this new `test(...)` inside the existing `test.describe('script-review pill progress (analysis-pill Task 10)', ...)` block in `e2e/script-review-pill-progress.spec.ts`, immediately after the existing (and only) test in that file:

```ts
  test('cancel button stops an in-flight review — pill clears, button re-enables, a fresh review can start (fs-58 follow-up #1481)', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    const pill = page.getByTestId('review-script-progress');
    await expect(pill).toBeVisible({ timeout: 5_000 });

    const cancelBtn = pill.getByRole('button', { name: 'Cancel' });
    await expect(cancelBtn).toBeVisible({ timeout: 3_000 });
    await cancelBtn.click();

    /* mockReviewScript's next cancellation checkpoint after the click lands
       ~500ms later (its wait(500) between phase ticks) — generous timeout
       so this isn't a race against the mock's own internal timing. */
    await expect(pill).toBeHidden({ timeout: 3_000 });
    await expect(reviewBtn).toBeEnabled({ timeout: 3_000 });

    /* A fresh review can start immediately after — the 409-shaped
       conflict-lock this whole feature exists to release is gone. */
    await reviewBtn.click();
    await expect(pill).toBeVisible({ timeout: 5_000 });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- script-review-pill-progress`
Expected: FAIL — `pill.getByRole('button', { name: 'Cancel' })` isn't found (this test only fails if Tasks 4-6 aren't yet applied; since this plan executes them in order, by this point they already are — run this step anyway as the explicit red/green checkpoint the skill requires. If Tasks 1-6 are already committed, this step should already PASS; treat an unexpected failure here as a signal to re-check Task 6's wiring before proceeding).

- [ ] **Step 3: Run the test again (no implementation step needed — Tasks 4-6 already did the work)**

Run: `npm run test:e2e -- script-review-pill-progress`
Expected: PASS.

- [ ] **Step 4: Run the full e2e suite's script-review specs to confirm no regressions**

Run: `npm run test:e2e -- script-review`
Expected: PASS — `script-review.spec.ts`, `script-review-instruct.spec.ts`, `script-review-persistence.spec.ts`, `script-review-pill-progress.spec.ts` all green.

- [ ] **Step 5: Commit**

```bash
npm run test:e2e -- script-review
git add e2e/script-review-pill-progress.spec.ts
git commit -m "test(e2e): cancel button mid-review (fs-58 follow-up #1481)

Browser-level proof that Cancel stops the pill, re-enables the Review
Script button, and lets a fresh review start immediately after —
closes the loop on #1481's cancel affordance.

Refs #1481"
```

---

## After all tasks: before-shipping checklist

Once all 7 tasks are committed on the implementation branch (cut per CLAUDE.md's Branching workflow — e.g. `feat/frontend-script-review-cancel-reattach-1481`, off latest `main`, in its own worktree per the standing "all work in a separate branch and worktree" instruction for this effort):

1. Update `docs/features/INDEX.md` if this plan needs an entry (check whether fs-58's persistence plan already covers this area — likely just add a follow-up note rather than a new top-level entry).
2. Append an entry to `docs/release-notes-next.md` and a matching user-facing line to the in-progress version section of `RELEASE_NOTES.md`.
3. Open the PR with `Closes #1481` in the body.
4. Run `npm run verify:fast:branch` locally.
5. Once pushed and `verify.yml` is green, run the mandatory `code-review` pass (this PR is multi-scope — server + frontend + e2e + docs — so `high` effort per the model-routing table's PR-review-effort rule).
6. Merge.
