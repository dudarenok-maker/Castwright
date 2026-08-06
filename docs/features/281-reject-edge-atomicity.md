---
status: draft
---

# Reject-edge atomicity (#2166) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Not the same character" reject fail in the recoverable direction, heal the
books already stranded by it, and stop the client from undoing that healing.

**Architecture:** Three components that ship together. (1) The POST route writes its durable
`rejectedPairs` entry **before** the `notLinkedTo` edge, and both writes become fatal — so a
half-failure leaves the *visible* half (the chip + Undo), never the invisible one. (2) A new pure
module reconciles edges against `cast-id-history.json` at the two authoritative persist points in
`analysis.ts`, removing edges with no durable backing and writing back edges whose pair survived.
(3) `notLinkedTo` becomes server-owned on the whole-roster cast PUT, so a stale client cannot
re-PUT what the reconciliation just repaired.

**Tech Stack:** TypeScript (Node 20, ESM, `.js` import specifiers), Express, Vitest + supertest,
`writeJsonAtomic` + `withCastLock` / `withKeyLock`.

**Spec:** [`docs/superpowers/specs/2026-08-06-reject-edge-atomicity-design.md`](../superpowers/specs/2026-08-06-reject-edge-atomicity-design.md)
**Issue:** [#2166](https://github.com/dudarenok-maker/Castwright/issues/2166)
**Parent plan:** [`docs/features/278-cast-character-identity.md`](278-cast-character-identity.md), invariant 10.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Baseline commit.** Every `file:line` below is against `main` at `f31da8c2`. Re-verify a
  citation before editing at it; several were wrong in the sibling plan 280 and cost a task each.
- **Branch + worktree.** `fix/server-2166-reject-edge-atomicity`, cut via
  `node scripts/wt-new.mjs fix/server-2166-reject-edge-atomicity`. Do not work on `main`.
- **ESM specifiers.** Every intra-`server/src` import ends in `.js`, even for a `.ts` file.
- **The spine rule, stated once.** *The `rejectedPairs` entry is written first and removed last.
  The edge is created after it and destroyed before it.* POST inverts to satisfy it; **DELETE
  already satisfies it and MUST NOT be reordered.** Do not "symmetrise" the two verbs — the
  asymmetry is the design.
- **`history.rejected` is a backing record.** The legacy id-wide `rejected?: string[]` list
  (`cast-id-history.ts:54`) is still honoured by `buildCastResolver` (`cast-resolve.ts:108`
  builds `rejectedSet` from it, `:164` consults it). An edge backed only by that list is
  **legitimate** and must never be removed. Getting this wrong deletes real user decisions.
- **`analysis.ts`'s cast-lock guard.** `cast-lock.guard.test.ts:400-418` allowlists
  `routes/analysis.ts` for **exactly 5** unlocked `writeJsonAtomic(castJsonPath(` sites
  (`:3744, :3956, :4996, :5750, :6285`) and asserts the count **in both directions**. Any new
  cast.json write in that file must sit **textually inside** a `withCastLock(` call's parens in
  that same file — the scan is syntactic and call-graph-blind, so wrapping a *call into another
  module* does not count. Do not touch the allowlist.
- **Never `--no-verify`.** If a hook fails, triage per CLAUDE.md's Commit gate.
- **Test lanes.** `server/src/**/*.test.ts` runs under Vitest (`cd server && npm run test`).
  `src/routes/book-state.test.ts` is in the **slow** lane (`server/vitest.config.slow.ts`) — do
  not add tests there; `book-state-preserve-voices.test.ts` and
  `workspace/preserve-cast-voices.test.ts` are in the fast lane and are the right homes.
- **Mutation proof.** Every new assertion is mutated on its own line during implementation to
  prove it can fail, then reverted. A test that passes against unmodified `main` when it is meant
  to be a regression test is a plan failure, not a nice-to-have.

---

## Deviation from the spec, declared

The spec's reconciliation rule reads: *"`p ∈ rejectedPairs`, `p.to` is a live cast row, and **no**
edge anywhere in this book has `characterId === p.from` → write the edge on `p.to`."*

Taken literally that **under-heals a case the product supports**. D1 pair scope means one `from`
can legitimately be rejected against two different characters — `{from: 'x', to: 'A'}` and
`{from: 'x', to: 'B'}` both exist, and the original POSTs wrote an edge on A *and* on B.

The shape is documented, not hypothetical: `cast-id-history.ts:211-221` describes it directly —
*"reject X against both Y and Y' (two separate pairs), then retire Y into Y'"* — and
`cast-reject-orphan.ts:11-21` records D1 pair scope as existing precisely so a second, different
target stays independently rejectable.

**The failing case is PARTIAL loss, not total loss.** Edge on A survives, edge on B is lost. The
spec's rule asks "does any edge in this book name `x`?", sees A's, and skips **both** pairs — so B
never heals, and no amount of re-running fixes it. (Total loss is *not* a counter-example: read as
a set precomputed over the input roster, the spec's predicate is false for both pairs and both
would heal. The distinction matters because it decides which mutation can prove the rule — see
Task 2 Step 5.)

> Do not cite `cast-reject-orphan.ts:502`/`:560` for this. Those loops are real, but
> `matchingPairs = governingPairs.filter((p) => p.to === characterId)` (`:490`) means every element
> shares one `to` and varies by `from` — the many-`from`-one-`to` normalised-spelling shape, the
> mirror image of the case above.

The spec's blanket book-scoping exists to protect **one** case: `merge-analysis-cast.ts:473-480`
copies `old.notLinkedTo` onto a fresh row matched by *name*, so a legitimate edge can sit on a row
whose id is not any pair's `to`. Task 2 keeps that protection and drops the collateral damage by
naming the case directly:

> An existing edge for `from` is **relocated** when it sits on a row that is not `to` for any pair
> with that `from`. If a relocated edge for `from` exists, skip *every* add for that `from`
> (fail-safe: never duplicate). Otherwise add per-pair on `p.to` when that row lacks the edge.

**Removal stays exactly as the spec states it** — book-scoped, fail-safe, unchanged. Only the add
rule is tightened. Both behaviours are pinned by tests (Task 2, cases R7, R8 and **R8b** — R8b is
the discriminating one).

**Is the new rule ever worse than the spec's?** No. Removal is untouched. An add only ever lands
on a row that is some pair's own `to`. If a relocated edge for `from` exists, every add for that
`from` is skipped — identical to the spec's blanket behaviour. If none exists, every surviving edge
for that `from` already sits on a `to` of that `from`, so a per-pair add can never duplicate. The
rule heals strictly more and risks strictly no more.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/src/routes/cast-reject-orphan.ts` | modify | POST write order + both halves fatal + two distinct 500 messages |
| `server/src/routes/cast-reject-orphan-atomicity.test.ts` | **create** | Fault-injection + ordering pins. New file so its `vi.mock` cannot poison the existing suite's `Promise.all` dynamic import (`cast-reject-orphan.test.ts:106-109`) |
| `server/src/routes/cast-reject-orphan.failure-modes.test.ts` | modify | **Three of its cases pin the old order and go red.** See Task 1 Step 4 — this file is the one the fix breaks |
| `server/src/store/reject-edge-reconcile.ts` | **create** | Pure `(bookId, characters, history) → { adds, removes, next }`. No I/O, no locking |
| `server/src/store/reject-edge-reconcile.test.ts` | **create** | Unit tests for every reconciliation rule |
| `server/src/routes/analysis.ts` | modify | New best-effort `reconcileRejectEdges` helper + two call sites |
| `server/src/routes/analysis-reject-edge-reconcile.test.ts` | **create** | The helper's locking, reporting and no-op-write behaviour |
| `server/src/workspace/preserve-cast-voices.ts` | modify | `preserveNotLinkedToOnCastWrite` — the new server-owned-field pass, inserted after `preserveDesignedVoicesOnCastWrite` (which ends `:75`) |
| `server/src/workspace/preserve-cast-voices.test.ts` | modify | Unit tests for that pass |
| `server/src/routes/book-state.ts` | modify | Wire the pass into `preserveDesignedVoices`'s chain |
| `server/src/routes/book-state-preserve-voices.test.ts` | modify | Route-level: a PUT cannot move `notLinkedTo`; the oscillation regression |
| `docs/features/278-cast-character-identity.md` | modify | Invariant 10 becomes an enforced rule |
| `docs/release-notes-next.md`, `RELEASE_NOTES.md` | modify | Shipping notes |

---

## Task 1: POST writes the pair first, and both halves are fatal

**Files:**
- Modify: `server/src/routes/cast-reject-orphan.ts:339-402` (the write block) and `:97-110`
  (the module doc paragraph that states the superseded rule)
- Test: `server/src/routes/cast-reject-orphan-atomicity.test.ts` (create)
- Test: `server/src/routes/cast-reject-orphan.failure-modes.test.ts` (**modify — three cases at
  `:205`, `:216`, `:340` pin the behaviour this task inverts**)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks import. Behavioural contract only — after this task a failed
  `rejectOrphanedPair` leaves `cast.json` **byte-unchanged**.

### Why a new test file

`cast-reject-orphan.test.ts:106-109` imports the router inside `Promise.all([...])`. A `vi.mock`
factory is async and races that pattern (known repo failure mode). Rather than rewrite a
200-line suite, the fault-injection cases live in their own file that awaits its imports
**sequentially**.

- [ ] **Step 1: Write the failing test file**

Create `server/src/routes/cast-reject-orphan-atomicity.test.ts`:

```ts
/* #2166 — the reject's two writes must fail in the RECOVERABLE direction.
   The `rejectedPairs` entry drives the chip and Undo; the `notLinkedTo` edge
   is invisible on its own. So the pair is written FIRST and the edge second,
   and a failure of either is a 500 that names which half landed.

   Its own file (not cast-reject-orphan.test.ts) because this suite needs a
   `vi.mock` on state-io.js, and that suite imports its router inside a
   Promise.all — a shape that races an async mock factory. Imports here are
   awaited SEQUENTIALLY for the same reason. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* `vi.hoisted` rather than a module-level `let`: the mock factory is hoisted
   above every top-level binding, so a plain `let` is in its TDZ when the
   factory runs. */
const faults = vi.hoisted(() => ({
  failHistoryWrite: false,
  failCastWrite: false,
  /* Every attempted cast/history write, in order. This IS the route's own
     binding — the route imports `writeJsonAtomic` from this module — so it is
     a real ordering observation, not a spy attached to a copy. */
  calls: [] as string[],
}));

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (path: string, data: unknown) => {
      const which = path.endsWith('cast-id-history.json')
        ? 'history'
        : path.endsWith('cast.json')
          ? 'cast'
          : 'other';
      faults.calls.push(which);
      if (faults.failHistoryWrite && which === 'history') {
        throw new Error('simulated ENOSPC on cast-id-history.json');
      }
      if (faults.failCastWrite && which === 'cast') {
        throw new Error('simulated ENOSPC on cast.json');
      }
      return actual.writeJsonAtomic(path, data);
    },
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'Standalones';
const TITLE = 'The Hollow Tide';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

function writeBookOnDisk() {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
        { id: 'mairin', name: 'Mairin', role: 'character', color: 'unset' },
      ],
    }),
  );
  rmSync(join(bookDir, '.audiobook', 'cast-id-history.json'), { force: true });
}

function castBytes(): string {
  return readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8');
}

function readHistory(): Record<string, unknown> | null {
  const path = join(bookDir, '.audiobook', 'cast-id-history.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-reject-atomicity-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* Sequential, NOT Promise.all — see the header. */
  const { castRejectOrphanRouter } = await import('./cast-reject-orphan.js');
  const { makeBookId } = await import('../workspace/paths.js');

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  faults.failHistoryWrite = false;
  faults.failCastWrite = false;
  faults.calls.length = 0;
  writeBookOnDisk();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('#2166 — POST fails in the recoverable direction', () => {
  it('[A1] leaves cast.json byte-unchanged when the rejectedPairs write fails', async () => {
    const before = castBytes();
    faults.failHistoryWrite = true;

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(500);
    expect(castBytes()).toBe(before);
    expect(readHistory()).toBeNull();
  });

  it('[A2] says nothing was written when the rejectedPairs write fails', async () => {
    faults.failHistoryWrite = true;

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.body.error).toMatch(/nothing was written/i);
    expect(res.body.error).toMatch(/retry/i);
  });

  it('[A3] keeps the pair and says the link half is missing when the cast.json write fails', async () => {
    faults.failCastWrite = true;

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/rejection was recorded/i);
    expect(res.body.error).toMatch(/retry/i);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
    /* The half that failed really is absent — not merely unasserted. */
    expect(JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin')
      .notLinkedTo).toBeUndefined();
  });

  it('[A4] a retry after a cast.json failure reaches a complete state', async () => {
    faults.failCastWrite = true;
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    faults.failCastWrite = false;
    const retry = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(retry.status).toBe(200);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
    expect(
      JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin').notLinkedTo,
    ).toEqual([{ bookId, characterId: 'mairin_2' }]);
  });

  it('[A5] a retry after a rejectedPairs failure reaches a complete state', async () => {
    faults.failHistoryWrite = true;
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    faults.failHistoryWrite = false;
    const retry = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(retry.status).toBe(200);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
    expect(
      JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin').notLinkedTo,
    ).toEqual([{ bookId, characterId: 'mairin_2' }]);
  });
});

describe('#2166 — the two verbs are deliberately asymmetric', () => {
  /* Pinned so a later tidy-up cannot "symmetrise" the verbs back into
     agreement. Both orders exist to fail into the SAME visible state:
     pair present, edge absent. */

  it('[A6] POST writes the pair before the edge', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(200);
    expect(faults.calls).toEqual(['history', 'cast']);
  });

  it('[A7] DELETE removes the edge before the pair', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });
    faults.calls.length = 0;

    const res = await request(app)
      .delete(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(200);
    expect(faults.calls).toEqual(['cast', 'history']);
  });

  it('[A8] a half-failed DELETE lands in the SAME visible state as a half-failed POST', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    faults.failHistoryWrite = true;
    const res = await request(app)
      .delete(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(500);
    /* Edge gone, pair still there — chip renders, Undo retries, nothing is
       invisible. Exactly what [A3] asserts for the POST direction. */
    expect(
      JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin').notLinkedTo,
    ).toEqual([]);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
  });
});
```

- [ ] **Step 2: Run the tests and record which fail**

```bash
cd server && npx vitest run src/routes/cast-reject-orphan-atomicity.test.ts
```

Expected against unmodified `main`:

| Case | Expected now | Why |
|---|---|---|
| [A1] | **FAIL** | `cast.json` already carries the edge when the history write throws — this *is* #2166 |
| [A2] | **FAIL** | the "nothing was written" wording does not exist yet |
| [A3] | **FAIL** | the cast write throws out of the handler into finalhandler (express 5 auto-forwards a rejected handler promise, and this test app registers no error handler), so `res.body.error` is `undefined` and `.toMatch` throws |
| [A4] | PASS | **a pin, not a regression.** On `main` the cast write throws *first*, so nothing at all reaches disk and the retry trivially succeeds. It becomes load-bearing only *after* the reorder, where the retry has to complete a genuinely half-written state |
| [A5] | PASS | retry-after-pair-failure is the case the current module doc already reasons about |
| [A6] | **FAIL** | order is `['cast', 'history']` today |
| [A7] | PASS | DELETE already has the right order — that is the point of pinning it |
| [A8] | PASS | same |

Four already-green cases are deliberate: [A4], [A5], [A7] and [A8] are **pins**, not regressions.
If any of them fails here, the branch is not starting from the state this plan assumes — stop and
re-baseline rather than "fixing" them. Equally, if a case predicted **FAIL** passes, stop: do not
"strengthen" it against a defect that is not there.

- [ ] **Step 3: Reorder the writes in `cast-reject-orphan.ts`**

Replace `:339-342` (the `appendNotLinked` block) and reposition it after the pair write. The
block at `:344-359` (`historyBeforeReject` / `forgotSupersededTo`) stays exactly where it is —
it is a **pure read before any write**, which is what fix-round-1's I1 requires — and
`forgetSupersededId` stays last.

The final ordering inside the existing `withCastLock` span:

```ts
      /* #2166 — the pair is written FIRST and the edge second. Rationale in
         the module doc; the short version is that the `rejectedPairs` entry
         is what renders the chip and powers Undo, so a half-failure must
         leave THAT half, never the invisible one. */
      const historyBeforeReject = await loadCastIdHistory(bookDir);
      const forgotSupersededTo =
        historyBeforeReject.supersededBy[orphanedId] === characterId
          ? historyBeforeReject.supersededBy[orphanedId]
          : undefined;

      try {
        await rejectOrphanedPair(bookDir, orphanedId, characterId, forgotSupersededTo);
      } catch (rejectErr) {
        console.error(
          '[cast-reject-orphan] failed to record the rejection in cast-id-history.json — surfacing as a failure',
          rejectErr,
        );
        return res.status(500).json({
          error:
            'Failed to durably record the rejection. Retry — nothing was written, so a retry starts clean.',
        });
      }

      /* #2166 — FATAL, where it used to be an unguarded throw into
         errorHandler. The pair above has landed, so the rejection IS durably
         recorded and the chip will render; only the name-match suppression is
         missing, and the next analysis reconciles it (reject-edge-reconcile.ts).
         Retry is safe: `appendNotLinked` is idempotent by construction and
         `rejectOrphanedPair` returns early on an existing pair. */
      const changed = appendNotLinked(character, bookId, orphanedId);
      if (changed) {
        try {
          await writeJsonAtomic(castJsonPath(bookDir), { characters: cast.characters });
        } catch (castErr) {
          console.error(
            '[cast-reject-orphan] failed to write the notLinkedTo edge to cast.json — surfacing as a failure',
            castErr,
          );
          return res.status(500).json({
            error:
              'The rejection was recorded, but saving the character link failed. Retry — the rejection is already durable.',
          });
        }
      }

      if (forgotSupersededTo !== undefined) {
        // …unchanged block from :393-402…
      }
```

- [ ] **Step 4: Update the module doc paragraph at `:97-110`**

That paragraph currently asserts the superseded rule ("cast.json … is written first,
UNCONDITIONALLY, on BOTH verbs"). It is now wrong in a way a future reader would act on. Replace
it with the spine rule and keep its I5 sentence, which is still true of DELETE:

```
   #2166 — the two writes are ordered by which half is RECOVERABLE, not by
   which file is authoritative. The `rejectedPairs` entry drives
   `rejectedAgainst` -> the chip -> Undo; the `notLinkedTo` edge is invisible
   on its own, with no UI path to remove it. So: the pair is written FIRST and
   removed LAST; the edge is created after it and destroyed before it. POST
   therefore writes pair-then-edge, DELETE writes edge-then-pair, and BOTH
   fail into the same visible state (pair present, edge absent) which the chip
   exposes, a retry completes, and reject-edge-reconcile.ts heals at the next
   authoritative persist. This REPLACES the earlier "cast.json first,
   unconditionally, on BOTH verbs" rule: that symmetry is exactly what
   produced the asymmetric outcome, because the two verbs move in opposite
   directions. Do not re-symmetrise them.

   Both of POST's writes are fatal. Their 500 messages differ deliberately: a
   pair-write failure means NOTHING was written; a cast-write failure means the
   rejection is durable and only the link is missing. Retry is safe after
   either — `rejectOrphanedPair` returns early on an existing pair and
   `appendNotLinked`/`removeNotLinked` are idempotent.

   I5 (fix round 1) still applies to DELETE: its notLinkedTo removal is
   unconditional and first, so its 500 messages must not claim "nothing else
   was changed".
```

- [ ] **Step 5: Rewrite the three cases in `cast-reject-orphan.failure-modes.test.ts` that pin the OLD order**

**Do this deliberately, in this task, with the reasoning in the commit body.** These three tests
encode the pre-fix contract — one of them pins #2166's defect *as correct behaviour*. Leaving them
to surface at Ship time reads as "the fix broke something" instead of "the fix changed a contract
on purpose".

| Line | Case | Why it goes red | What to do |
|---|---|---|---|
| `:205` | `'rejectOrphanedPair failing still leaves the earlier notLinkedTo write in place (safe to retry)'` | asserts `mairin?.notLinkedTo` equals `[{ bookId, characterId: 'mayrin' }]` after the pair write throws. **This is #2166, pinned as correct.** | **Invert it.** Retitle to `'rejectOrphanedPair failing leaves cast.json untouched — the edge is never written (#2166)'` and assert `expect(mairin?.notLinkedTo).toBeUndefined();` |
| `:216` | `'a subsequent successful retry after a rejectOrphanedPair failure returns 200'` | final line `expect(second.body.alreadyPresent).toBe(true);` — post-reorder the first attempt writes no edge, so the retry's `appendNotLinked` returns `true` and `alreadyPresent` is `false` | Flip to `expect(second.body.alreadyPresent).toBe(false);` and replace the "already present from the first attempt" comment with: the first attempt wrote nothing, so the retry writes the edge for the first time |
| `:340` | `"POST's notLinkedTo write landing, then rejectOrphanedPair 500ing and never being retried, still leaves DELETE able to clear the edge"` | it manufactures the stranded state **through the POST route**, which this task makes impossible | Keep the test — DELETE's unconditional clear (`:537-540`) is still worth pinning for legacy books. **Change only its setup:** seed the stranded edge directly via `writeBookOnDisk` with `notLinkedTo` pre-populated and no `cast-id-history.json`, instead of producing it with a failing POST. Add a comment that the POST can no longer create this state and the case now covers books stranded *before* this fix |

Verified unaffected, do not touch: `:175`, `:196` (its `/failed to durably record/i` still matches
the new message), `:233`, `:258`, `:272`, `:290`, `:384`.

- [ ] **Step 6: Run all three suites**

```bash
cd server && npx vitest run src/routes/cast-reject-orphan-atomicity.test.ts src/routes/cast-reject-orphan.test.ts src/routes/cast-reject-orphan.failure-modes.test.ts
```

Expected: PASS, all three. `cast-reject-orphan.test.ts` must stay green **untouched** — if
something in *that* file moved, fix the route, not the test. That instruction does **not** extend
to `failure-modes.test.ts`, whose three cases Step 5 changed on purpose.

- [ ] **Step 7: Prove each new assertion can fail**

For each of [A1]–[A8]: mutate that assertion's own line (e.g. flip `toBe(before)` to `toBe('x')`),
confirm red, revert. Then mutate the *fix* — restore the old cast-write-first order — and confirm
[A1] and [A6] go red while [A7]/[A8] stay green. Record both in the commit body.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/cast-reject-orphan.ts \
        server/src/routes/cast-reject-orphan-atomicity.test.ts \
        server/src/routes/cast-reject-orphan.failure-modes.test.ts
git commit -m "fix(server): write the reject's pair before its edge (#2166)"
```

The commit body must name the three inverted cases and say why each moved — a reviewer seeing
`toEqual([...])` become `toBeUndefined()` in a failure-modes suite needs to know that was the
point, not collateral.

---

## Task 2: The pure reconciliation

**Files:**
- Create: `server/src/store/reject-edge-reconcile.ts`
- Test: `server/src/store/reject-edge-reconcile.test.ts`

**Interfaces:**
- Consumes: `CastIdHistory`, `RejectedPair` from `../store/cast-id-history.js` (Task 0 — already
  on `main`, `cast-id-history.ts:15-107`).
- Produces:
  ```ts
  export interface RejectEdge { characterId: string; orphanedId: string }
  export interface RejectEdgeReconcileResult<T> {
    adds: RejectEdge[];      // edge written back onto a live row
    removes: RejectEdge[];   // edge removed for having no durable backing
    next: T[];               // the reconciled roster
  }
  export function reconcileRejectEdges<T extends { id: string; notLinkedTo?: Array<{ bookId: string; characterId: string }> }>(
    bookId: string,
    characters: ReadonlyArray<T>,
    history: CastIdHistory,
  ): RejectEdgeReconcileResult<T>;
  ```
  `adds`/`removes` name the row in `characterId` and the orphaned id in `orphanedId`. Task 3
  imports this and nothing else from the module.

- [ ] **Step 1: Write the failing test**

Create `server/src/store/reject-edge-reconcile.test.ts`:

```ts
/* #2166 — the reconciliation that heals a half-written reject.
   Pure: no fs, no locking. Every rule in the design doc gets a case, and the
   two Criticals from the spec's review round get one each (R3, R7). */

import { describe, it, expect } from 'vitest';
import { reconcileRejectEdges } from './reject-edge-reconcile.js';
import type { CastIdHistory } from './cast-id-history.js';

const BOOK = 'book-hollow-tide';
const OTHER_BOOK = 'book-somewhere-else';

function history(over: Partial<CastIdHistory> = {}): CastIdHistory {
  return { schema: 1, supersededBy: {}, ...over };
}

function row(id: string, notLinkedTo?: Array<{ bookId: string; characterId: string }>) {
  return notLinkedTo === undefined ? { id } : { id, notLinkedTo };
}

describe('reconcileRejectEdges', () => {
  it('[R1] removes a same-book edge with no durable backing anywhere', () => {
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }])];
    const out = reconcileRejectEdges(BOOK, cast, history());

    expect(out.removes).toEqual([{ characterId: 'mairin', orphanedId: 'mairin_2' }]);
    expect(out.adds).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([]);
  });

  it('[R2] keeps an edge backed by a rejectedPairs entry', () => {
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }])];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.removes).toEqual([]);
    expect(out.adds).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R3] keeps an edge backed ONLY by the legacy id-wide `rejected` list', () => {
    /* The spec's revision-1 Critical. A book rejected between aa6616d8 and
       f6074ca8 recorded its decision here, not in rejectedPairs — and
       buildCastResolver still honours it (cast-resolve.ts:108/:164). Removing
       the edge would silently un-suppress the §4.4 matcher for a decision the
       user really made. */
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }])];
    const out = reconcileRejectEdges(BOOK, cast, history({ rejected: ['mairin_2'] }));

    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R4] writes the edge back when a pair survived but its edge is gone', () => {
    const cast = [row('mairin')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.adds).toEqual([{ characterId: 'mairin', orphanedId: 'mairin_2' }]);
    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R5] writes nothing when the pair targets a row that is not live', () => {
    const cast = [row('narrator')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.adds).toEqual([]);
    expect(out.removes).toEqual([]);
  });

  it('[R6] never touches a cross-book edge', () => {
    const cast = [row('mairin', [{ bookId: OTHER_BOOK, characterId: 'someone' }])];
    const out = reconcileRejectEdges(BOOK, cast, history());

    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: OTHER_BOOK, characterId: 'someone' }]);
  });

  it('[R7] leaves a relocated edge alone and does NOT duplicate it onto p.to', () => {
    /* merge-analysis-cast.ts:473-480 copies old.notLinkedTo onto a fresh row
       matched by NAME, so a legitimate edge can sit on a row whose id is not
       the pair's `to`. Row-scoped matching would delete it and write a
       duplicate. */
    const cast = [row('mairin_renamed', [{ bookId: BOOK, characterId: 'mairin_2' }]), row('mairin')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.removes).toEqual([]);
    expect(out.adds).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toBeUndefined();
  });

  it('[R8] heals BOTH rows when one `from` is rejected against two live characters', () => {
    /* D1 pair scope: the same orphaned id can be rejected against two
       different people, and the original POSTs wrote an edge on each. A
       blanket "no edge anywhere for this `from`" rule heals only the first.
       See the plan's "Deviation from the spec". */
    const cast = [row('mairin'), row('mara')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({
        rejectedPairs: [
          { from: 'mairin_2', to: 'mairin' },
          { from: 'mairin_2', to: 'mara' },
        ],
      }),
    );

    expect(out.adds).toEqual([
      { characterId: 'mairin', orphanedId: 'mairin_2' },
      { characterId: 'mara', orphanedId: 'mairin_2' },
    ]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R8b] heals the SURVIVING half when one of two pairs kept its edge', () => {
    /* THE discriminating case for the plan's declared deviation. The spec's
       blanket rule ("no edge anywhere in this book names this `from`") sees
       mairin's surviving edge and skips BOTH pairs, so `mara` never heals and
       re-running never fixes it. Unlike [R8], this case reddens under EITHER
       reading of the blanket rule — precomputed or live — which is what makes
       it the mutation target in Step 5. */
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }]), row('mara')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({
        rejectedPairs: [
          { from: 'mairin_2', to: 'mairin' },
          { from: 'mairin_2', to: 'mara' },
        ],
      }),
    );

    expect(out.adds).toEqual([{ characterId: 'mara', orphanedId: 'mairin_2' }]);
    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R9] reports nothing for an already-consistent book', () => {
    const cast = [
      row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }]),
      row('narrator'),
    ];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.adds).toEqual([]);
    expect(out.removes).toEqual([]);
  });

  it('[R10] removes only the unbacked edge, keeping a backed sibling on the same row', () => {
    const cast = [
      row('mairin', [
        { bookId: BOOK, characterId: 'mairin_2' },
        { bookId: BOOK, characterId: 'ghost_id' },
      ]),
    ];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.removes).toEqual([{ characterId: 'mairin', orphanedId: 'ghost_id' }]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R11] does not mutate its input on the REMOVE path', () => {
    const edges = [{ bookId: BOOK, characterId: 'mairin_2' }];
    const cast = [{ id: 'mairin', notLinkedTo: edges }];
    reconcileRejectEdges(BOOK, cast, history());

    expect(cast[0].notLinkedTo).toBe(edges);
    expect(edges).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R12] does not mutate its input on the ADD path', () => {
    /* [R11] runs with an empty history, so pass 2 never executes and the
       `next[idx] = { ...row, … }` line it is meant to cover is never reached. */
    const cast = [{ id: 'mairin' }, { id: 'mara' }];
    const snapshot = JSON.stringify(cast);
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(JSON.stringify(cast)).toBe(snapshot);
    expect(out.next[0]).not.toBe(cast[0]);
    expect(out.next[1]).toBe(cast[1]); // untouched rows pass through by reference
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd server && npx vitest run src/store/reject-edge-reconcile.test.ts
```

Expected: FAIL — `Failed to resolve import "./reject-edge-reconcile.js"`.

- [ ] **Step 3: Write the implementation**

Create `server/src/store/reject-edge-reconcile.ts`:

```ts
/* #2166 — reconcile a book's same-book `notLinkedTo` edges against the
   durable rejection records in cast-id-history.json.

   A reject writes two records of one decision: a `rejectedPairs` entry (the
   visible half — it renders the chip and powers Undo) and a one-sided
   `notLinkedTo` edge on cast.json (the invisible half — it suppresses the
   §4.4 name matcher and has no UI path of its own). cast-reject-orphan.ts now
   orders those writes so a half-failure always leaves the VISIBLE half; this
   module is the other side of that bargain, completing a half-written reject
   at the next authoritative persist and clearing an edge whose durable half
   is gone.

   PURE by design — no fs, no locking. analysis.ts owns the read, the
   `withCastLock`, and the write, because `cast-lock.guard.test.ts` is
   syntactic and call-graph-blind: a `writeJsonAtomic(castJsonPath(` inside
   THIS module would read as an unlocked write no matter how its caller is
   wrapped, and analysis.ts's allowlist entry is keyed on file AND count.

   BACKING. An edge is legitimate when the decision it encodes is recorded
   durably somewhere. Two places count:
     - a `rejectedPairs` entry with `from === edge.characterId`;
     - the LEGACY id-wide `rejected` list containing `edge.characterId`.
   The second is not optional. Books rejected between aa6616d8 and f6074ca8
   recorded the decision there, and `buildCastResolver` still honours it
   (cast-resolve.ts:108 builds `rejectedSet` from it, :164 consults it).
   Treating those edges as unbacked would delete real user decisions.

   MATCHING. Removal is BOOK-scoped on `edge.characterId`, never row-scoped on
   `pair.to`: merge-analysis-cast.ts:473-480 copies `old.notLinkedTo` onto a
   fresh row matched by NAME, so a legitimate edge can legitimately sit on a
   row whose id is not the pair's `to`. Row-scoped removal would delete it.

   ADDITION is per-pair on `pair.to`, because D1 pair scope lets one `from` be
   rejected against two different live characters and the original POSTs wrote
   an edge on each — a blanket "no edge anywhere for this `from`" rule heals
   only the first. The relocation case above is protected explicitly instead:
   an edge for `from` sitting on a row that is NOT `to` for any pair with that
   `from` is RELOCATED, and its presence suppresses every add for that `from`
   so nothing is ever duplicated. */

import type { CastIdHistory } from './cast-id-history.js';

export interface RejectEdge {
  /** The live cast row carrying (or receiving) the edge. */
  characterId: string;
  /** The orphaned id the edge names. */
  orphanedId: string;
}

export interface RejectEdgeReconcileResult<T> {
  adds: RejectEdge[];
  removes: RejectEdge[];
  /** The reconciled roster. Structurally equal to `characters` when both
      `adds` and `removes` are empty — the caller writes only when they are
      not, so an already-consistent book performs no disk write. */
  next: T[];
}

type NotLinked = { bookId: string; characterId: string };
type CastRow = { id: string; notLinkedTo?: NotLinked[] };

export function reconcileRejectEdges<T extends CastRow>(
  bookId: string,
  characters: ReadonlyArray<T>,
  history: CastIdHistory,
): RejectEdgeReconcileResult<T> {
  const pairs = history.rejectedPairs ?? [];
  const legacyRejected = new Set(history.rejected ?? []);
  const backedFroms = new Set(pairs.map((p) => p.from));

  /* `to`s per `from`, for the relocation test below. */
  const targetsByFrom = new Map<string, Set<string>>();
  for (const p of pairs) {
    const set = targetsByFrom.get(p.from) ?? new Set<string>();
    set.add(p.to);
    targetsByFrom.set(p.from, set);
  }

  const adds: RejectEdge[] = [];
  const removes: RejectEdge[] = [];

  /* Pass 1 — drop unbacked same-book edges. */
  const next = characters.map((c) => {
    const existing = c.notLinkedTo;
    if (!existing?.length) return c;
    const kept = existing.filter((e) => {
      if (e.bookId !== bookId) return true; // cross-book: never ours to judge
      if (backedFroms.has(e.characterId) || legacyRejected.has(e.characterId)) return true;
      removes.push({ characterId: c.id, orphanedId: e.characterId });
      return false;
    });
    return kept.length === existing.length ? c : ({ ...c, notLinkedTo: kept } as T);
  });

  /* Which `from`s have a RELOCATED edge — one sitting on a row that is not a
     `to` for that `from` (merge-analysis-cast.ts moved it onto a name match).
     Its presence suppresses every add for that `from`, so a relocated edge is
     never duplicated onto `p.to`.

     Read from `next` only because that is the array in hand; the set is the
     same either way. An edge pass 1 removed can never reach this branch — the
     `targetsByFrom.get(...)` guard is true only for a `from` that has a pair,
     which is exactly what put it in `backedFroms` and made pass 1 keep it. */
  const relocated = new Set<string>();
  for (const c of next) {
    for (const e of c.notLinkedTo ?? []) {
      if (e.bookId !== bookId) continue;
      const targets = targetsByFrom.get(e.characterId);
      if (targets && !targets.has(c.id)) relocated.add(e.characterId);
    }
  }

  /* Pass 2 — write back a pair whose edge is missing. */
  const byId = new Map(next.map((c, i) => [c.id, i]));
  for (const p of pairs) {
    if (relocated.has(p.from)) continue;
    const idx = byId.get(p.to);
    if (idx === undefined) continue; // `to` is not a live row — nothing to carry the edge
    const row = next[idx];
    const existing = row.notLinkedTo ?? [];
    if (existing.some((e) => e.bookId === bookId && e.characterId === p.from)) continue;
    next[idx] = { ...row, notLinkedTo: [...existing, { bookId, characterId: p.from }] } as T;
    adds.push({ characterId: p.to, orphanedId: p.from });
  }

  return { adds, removes, next };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd server && npx vitest run src/store/reject-edge-reconcile.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Prove each assertion can fail**

Mutate each of R1–R12 (including R8b) on its own line, confirm red, revert. Then mutate the **implementation** at
the two places the spec's Criticals live and confirm the right test catches each:
- delete `|| legacyRejected.has(e.characterId)` → **[R3] must go red**, nothing else.
- replace pass 2's `if (relocated.has(p.from)) continue;` with the spec's blanket rule — a set of
  every `from` named by any surviving same-book edge, **precomputed before pass 2** — and confirm
  **[R8b] goes red** while [R7] stays green.

  Target **[R8b], not [R8]**. Under a *precomputed* blanket set, [R8] (both edges lost) still
  passes, so mutating against it proves nothing — precisely the "mutation that reddens nothing"
  this step exists to catch. [R8b] reddens under either reading.

Record all three in the commit body. A mutation that reddens nothing means the case is not covered.

- [ ] **Step 6: Commit**

```bash
git add server/src/store/reject-edge-reconcile.ts server/src/store/reject-edge-reconcile.test.ts
git commit -m "feat(server): add the reject-edge reconciliation (#2166)"
```

---

## Task 3: Run the reconciliation at the two authoritative persists

**Files:**
- Modify: `server/src/routes/analysis.ts` — new helper after
  `clearNotLinkedEdgesForDroppedRejections` (ends `:291`); call sites after the
  `displacedByDeadTarget` block at `:5061-5072` and its mirror at `:6336-6347`
- Test: `server/src/routes/analysis-reject-edge-reconcile.test.ts` (create)

**Interfaces:**
- Consumes: `reconcileRejectEdges` from `../store/reject-edge-reconcile.js` (Task 2). The
  `RejectEdge` type is inferred from its return value — no type import needed.
- Produces: `export async function reconcileRejectEdgesOnDisk(bookDir: string, bookId: string |
  undefined, log: (phaseId: number, message: string) => void): Promise<void>` — exported **only**
  so its test can drive it directly; nothing else imports it.

### The lock constraint, restated because it is easy to get wrong

`writeJsonAtomic(castJsonPath(` must appear **textually inside** a `withCastLock(` call's parens
**in `analysis.ts` itself**. Do not move the write into `reject-edge-reconcile.ts` and wrap the
*call*: the guard cannot follow a function boundary, `analysis.ts`'s allowlist is keyed on file
**and count**, and the new module would become a sixth unlocked-looking write. Copy
`clearNotLinkedEdgesForDroppedRejections`'s shape (`:261-291`) exactly.

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/analysis-reject-edge-reconcile.test.ts`:

```ts
/* #2166 — analysis.ts's caller-side half of the reconciliation: its own
   withCastLock, its own best-effort try/catch, operator-visible reporting,
   and NO write at all when the book is already consistent. The rules
   themselves are unit-tested in store/reject-edge-reconcile.test.ts. */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileRejectEdgesOnDisk } from './analysis.js';

const BOOK_ID = 'book-hollow-tide';
let root: string;
let bookDir: string;

function seed(cast: object, history: object | null) {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
  if (history) {
    writeFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), JSON.stringify(history));
  } else {
    rmSync(join(bookDir, '.audiobook', 'cast-id-history.json'), { force: true });
  }
}

function readCast() {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}

function collectLog() {
  const lines: string[] = [];
  return { lines, log: (_phase: number, message: string) => void lines.push(message) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-reject-reconcile-'));
  bookDir = join(root, 'book');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('reconcileRejectEdgesOnDisk', () => {
  it('[C1] removes an unbacked edge and reports it', async () => {
    seed({ characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] }, null);
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(readCast().characters[0].notLinkedTo).toEqual([]);
    expect(lines.join('\n')).toMatch(/mairin/);
    expect(lines.join('\n')).toMatch(/m2/);
  });

  it('[C2] writes back an edge whose pair survived, and reports it', async () => {
    seed(
      { characters: [{ id: 'mairin' }] },
      { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'm2', to: 'mairin' }] },
    );
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(readCast().characters[0].notLinkedTo).toEqual([{ bookId: BOOK_ID, characterId: 'm2' }]);
    expect(lines.join('\n')).toMatch(/m2/);
  });

  it('[C3] performs NO write when the book is already consistent', async () => {
    seed(
      { characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] },
      { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'm2', to: 'mairin' }] },
    );
    const before = statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs;
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs).toBe(before);
    expect(lines).toEqual([]);
  });

  it('[C4] touches nothing when bookId is undefined', async () => {
    seed({ characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] }, null);
    const { log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, undefined, log);

    expect(readCast().characters[0].notLinkedTo).toEqual([{ bookId: BOOK_ID, characterId: 'm2' }]);
  });

  it('[C5] is best-effort — an unreadable cast.json does not throw', async () => {
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), 'not json at all');
    const { log } = collectLog();

    await expect(reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log)).resolves.toBeUndefined();
  });

  it('[C6] does not undo clearNotLinkedEdgesForDroppedRejections', async () => {
    /* #2133's helper is per-RETIREMENT: retireCharacterId drops a self-loop
       pair from history and the helper clears the matching edge. This
       reconciliation is per-PERSIST and derived from state — so it must see
       that as consistent, not as "a pair whose edge is missing".

       The book carries a LIVE pair+edge alongside the dropped one, so the
       reconciliation has real work-shaped input rather than an empty file it
       could ignore for any reason at all. */
    seed(
      {
        characters: [
          { id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] },
          { id: 'mara' },
        ],
      },
      { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'm2', to: 'mairin' }] },
    );
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(readCast().characters[1].notLinkedTo).toBeUndefined();
    expect(readCast().characters[0].notLinkedTo).toEqual([{ bookId: BOOK_ID, characterId: 'm2' }]);
    expect(lines).toEqual([]);
  });
});
```

> `mtimeMs` equality is the strongest available "no write happened" assertion that does not
> reach into `writeJsonAtomic`. If it proves flaky on a fast filesystem (two writes inside one
> timer tick), replace it with a byte comparison plus an `adds`/`removes` emptiness assertion —
> do **not** simply delete it. [C3] is the case that proves the reconciliation is not thrashing
> cast.json on every analysis.

- [ ] **Step 2: Run to verify it fails**

```bash
cd server && npx vitest run src/routes/analysis-reject-edge-reconcile.test.ts
```

Expected: FAIL — `reconcileRejectEdgesOnDisk` is not exported from `./analysis.js`.

- [ ] **Step 3: Add the helper to `analysis.ts`**

Add the import beside the existing store imports (the `cast-id-history.js` group ends at `:124`):

```ts
import { reconcileRejectEdges } from '../store/reject-edge-reconcile.js';
```

Insert the helper immediately after `clearNotLinkedEdgesForDroppedRejections` (which ends at
`:291`):

```ts
/* #2166 — the per-persist half of the reject-edge invariant. Its sibling
   above (`clearNotLinkedEdgesForDroppedRejections`, #2133) is PER-RETIREMENT
   and driven by `droppedSelfLoopRejections`; this one is PER-PERSIST and
   derived purely from state, which is what lets it heal a reject that failed
   between its two writes — a state no retirement ever reports. The two are
   compatible in either order: after the #2133 helper runs, pair and edge are
   both gone, so this sees nothing to do.

   Its OWN withCastLock, and the write is TEXTUALLY inside it, in this file.
   That is not stylistic: `cast-lock.guard.test.ts` is syntactic and
   call-graph-blind, and this file's allowlist entry is keyed on file AND
   count, so a write that lived in reject-edge-reconcile.ts (however well
   locked by its caller) would read as a sixth unlocked write here and redden
   the build. reject-edge-reconcile.ts is therefore PURE and this function
   owns the read, the lock and the write.

   Best-effort, mirroring every other id-history write in this file: a failure
   must not fail the analysis. A surviving stale edge merely re-suppresses one
   future §4.4 name-match until the next persist tries again.

   Exported only so analysis-reject-edge-reconcile.test.ts can drive it
   without standing up a full analysis run. */
export async function reconcileRejectEdgesOnDisk(
  bookDir: string,
  bookId: string | undefined,
  log: (phaseId: number, message: string) => void,
): Promise<void> {
  /* No bookId means no way to tell this book's edges from a cross-book one —
     see bookIdForRetirementCleanup, which already warns for this run. */
  if (!bookId) return;
  try {
    await withCastLock(bookDir, async () => {
      const cast = await readJson<{ characters?: CharacterOutput[] }>(castJsonPath(bookDir));
      if (!cast?.characters?.length) return;
      const history = await loadCastIdHistory(bookDir);
      const { adds, removes, next } = reconcileRejectEdges(bookId, cast.characters, history);
      if (!adds.length && !removes.length) return;
      await writeJsonAtomic(castJsonPath(bookDir), { characters: next });
      if (removes.length) {
        log(
          1,
          `Cleared ${removes.length} stranded "not the same character" link(s) with no recorded ` +
            `rejection (${removes.map((e) => `${e.characterId} -/- ${e.orphanedId}`).join(', ')}).`,
        );
      }
      if (adds.length) {
        log(
          1,
          `Restored ${adds.length} "not the same character" link(s) from a recorded rejection ` +
            `(${adds.map((e) => `${e.characterId} -/- ${e.orphanedId}`).join(', ')}).`,
        );
      }
    });
  } catch (err) {
    console.warn('[analysis] failed to reconcile reject edges (non-fatal)', err);
  }
}
```

**Add `loadCastIdHistory` to this file's `cast-id-history.js` import group** — it is **not**
currently imported. The group at `:119-124` is `retireCharacterId`,
`dropSupersededIdsReclaimedByLiveCast`, `dropSupersededTargetsNoLongerLive`,
`refuseRetirementsOfLiveIds`. Everything else the helper needs is already present: `readJson` /
`writeJsonAtomic` (`:107`), `withCastLock` (`:108`), `castJsonPath`, `CharacterOutput` (`:94`).

- [ ] **Step 4: Add the two call sites**

Main path — immediately after the `if (displacedByDeadTarget.length) { … }` block that closes at
`:5072`, still inside the `try`:

```ts
            /* #2166 — heal any reject whose two writes came apart, against
               this exact just-persisted roster. Best-effort; see the
               helper's own doc comment. */
            await reconcileRejectEdgesOnDisk(record.bookDir, retirementBookId, log);
```

Subset path — the mirror position, after the block closing at `:6347`, using that scope's
binding name:

```ts
            // #2166 — mirrors the main path's same-named call above.
            await reconcileRejectEdgesOnDisk(record.bookDir, subsetBookId, log);
```

Note the binding names differ by scope: `retirementBookId` (`:5012`) vs `subsetBookId` (`:6300`).
Both are `string | undefined` from `bookIdForRetirementCleanup`.

- [ ] **Step 4b: Pin that the two call sites exist**

Without this, `reconcileRejectEdgesOnDisk` could be exported and **never called** and every test on
the branch would still pass — [C1]–[C6] and [P9] all drive the helper directly. The analysis persist
path is not unit-drivable, so a source-level pin is the honest instrument, the same shape
`cast-lock.guard.test.ts` already uses. Add to `analysis-reject-edge-reconcile.test.ts`:

`readFileSync` is already in that file's `node:fs` import from Step 1; add only `node:url`.

```ts
import { fileURLToPath } from 'node:url';

it('[C7] is wired into BOTH authoritative persists', () => {
  /* A source scan, not a behavioural test — deliberately. The two call sites
     live inside the analysis persist path, which no unit test stands up, so
     without this the helper could be exported and never called and the whole
     branch would stay green. Mirrors cast-lock.guard.test.ts's approach. */
  const src = readFileSync(fileURLToPath(new URL('./analysis.ts', import.meta.url)), 'utf8');
  const calls = src.match(/await reconcileRejectEdgesOnDisk\(record\.bookDir,/g) ?? [];

  expect(calls).toHaveLength(2);
  expect(src).toContain('await reconcileRejectEdgesOnDisk(record.bookDir, retirementBookId, log)');
  expect(src).toContain('await reconcileRejectEdgesOnDisk(record.bookDir, subsetBookId, log)');
});
```

Its weakness is stated rather than hidden: it proves the *text* is present, not that it executes.
That is strictly more than zero, and it is what is available here.

- [ ] **Step 5: Run to verify it passes, and that the lock guard is still green**

```bash
cd server && npx vitest run src/routes/analysis-reject-edge-reconcile.test.ts src/workspace/cast-lock.guard.test.ts
```

Expected: PASS. The guard must still report `routes/analysis.ts` at **exactly 5** unlocked
writes. If it reports 6, the new write is outside the `withCastLock(` parens — fix the code, do
**not** touch `ALLOWED_UNLOCKED` (`cast-lock.guard.test.ts:400-418`).

- [ ] **Step 6: Prove the guard would catch a regression**

Temporarily hoist the `writeJsonAtomic` call out of the `withCastLock` callback, run
`cast-lock.guard.test.ts`, confirm it fails with "found 6 write(s)", then revert. A guard nobody
has watched fail is a guard nobody knows works.

- [ ] **Step 7: Prove each new assertion can fail**

Mutate [C1]–[C7] on their own lines; revert. Then delete the `if (!adds.length && !removes.length)
return;` early exit and confirm **[C3]** goes red, and delete one call site and confirm **[C7]**
goes red.

**Two cases here cannot be neutralised, and that is recorded rather than hidden:**
- **[C4]** pins the *outcome* of an absent `bookId`, not the `if (!bookId) return;` guard. Delete
  the guard and `reconcileRejectEdges(undefined, …)` compares `e.bookId !== undefined` → every edge
  is kept → no write → the test still passes. The guard is defensive and its effect is
  unobservable; keep it for clarity, but do not count [C4] as covering it.
- **[C6]** cannot redden against any implementation that derives adds solely from `rejectedPairs`.
  Its value is documentary — it states the #2133 interaction — not evidential.

Say both in the commit body. A pin that cannot fail is fine; a pin that cannot fail *and is
counted as coverage* is how this repo has shipped green-checking-nothing before.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis-reject-edge-reconcile.test.ts
git commit -m "feat(server): reconcile reject edges at the authoritative persists (#2166)"
```

---

## Task 4: `notLinkedTo` becomes server-owned on the cast PUT

**Files:**
- Modify: `server/src/workspace/preserve-cast-voices.ts` (**insert** at `:76`, after
  `preserveDesignedVoicesOnCastWrite` which ends `:75` — not an append; `rejectForeignCloneKeys`
  (`:123`), `sameStoredVoice` (`:181`) and `preserveClonedSlotsOnCastWrite` (`:229`) follow it)
- Modify: `server/src/routes/book-state.ts:126-146` (`preserveDesignedVoices`) and its import
  group at `:64-68`
- Test: `server/src/workspace/preserve-cast-voices.test.ts` (append a describe block)
- Test: `server/src/routes/book-state-preserve-voices.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  ```ts
  export function preserveNotLinkedToOnCastWrite<T extends { id: string }>(
    existing: ReadonlyArray<{ id: string } & Record<string, unknown>>,
    incoming: T[],
  ): T[];
  ```
  Same shape as its two siblings in that module, so it slots into
  `preserveDesignedVoices`'s chain without changing that function's signature.

### Why this is load-bearing, not tidying

`persistence-middleware.ts:69-94` PUTs `{ characters: s.cast.characters }` — the whole redux
roster, `notLinkedTo` included — on nine ordinary cast actions, and `book-state.ts:685-688`
writes it verbatim. `cast-slice.ts:50, 336, 409` merge incoming server state as
`notLinkedTo: existing.notLinkedTo ?? inc.notLinkedTo`, so **redux's array wins over the
server's**. Without this task, a client that hydrated before Task 3's reconciliation re-PUTs the
stale edge on the next unrelated cast edit and undoes the repair. The client keeps its optimistic
update — `applyNotLinked` still renders instantly — it simply can no longer *persist* that field.

- [ ] **Step 1: Write the failing unit tests**

Append to `server/src/workspace/preserve-cast-voices.test.ts` (add
`preserveNotLinkedToOnCastWrite` to the existing import list at `:18-20`):

```ts
/* #2166 — `notLinkedTo` is identity state written only by the dedicated
   reject / not-linked-to routes. The whole-roster cast PUT has no business
   carrying it: redux's merge prefers its own array over the server's, so a
   stale client would otherwise re-PUT edges the reconciliation just repaired. */
describe('preserveNotLinkedToOnCastWrite', () => {
  it('[P1] takes notLinkedTo from disk, discarding what the client sent', () => {
    const existing = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'x' }] }];
    const incoming = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'STALE' }] }];

    expect(preserveNotLinkedToOnCastWrite(existing, incoming)[0].notLinkedTo).toEqual([
      { bookId: 'b1', characterId: 'x' },
    ]);
  });

  it('[P2] restores notLinkedTo the client dropped entirely', () => {
    const existing = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'x' }] }];
    const incoming = [{ id: 'a' }];

    expect(preserveNotLinkedToOnCastWrite(existing, incoming)[0].notLinkedTo).toEqual([
      { bookId: 'b1', characterId: 'x' },
    ]);
  });

  it('[P3] clears a client-invented notLinkedTo when disk has none', () => {
    const existing = [{ id: 'a' }];
    const incoming = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'invented' }] }];

    /* Absent on disk means absent after the write — otherwise the PUT is
       still a writer of this field, just a quieter one. */
    expect(preserveNotLinkedToOnCastWrite(existing, incoming)[0].notLinkedTo).toBeUndefined();
  });

  it('[P4] leaves a brand-new character alone', () => {
    const existing = [{ id: 'a' }];
    const incoming = [{ id: 'a' }, { id: 'b', notLinkedTo: [{ bookId: 'b1', characterId: 'y' }] }];

    /* No on-disk row to be authoritative, so nothing to restore or clear —
       same scope every sibling pass in this module uses. */
    expect(preserveNotLinkedToOnCastWrite(existing, incoming)[1].notLinkedTo).toEqual([
      { bookId: 'b1', characterId: 'y' },
    ]);
  });

  it('[P5] touches no other field', () => {
    const existing = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'x' }] }];
    const incoming = [{ id: 'a', name: 'Renamed', ttsEngine: 'qwen' }];
    const out = preserveNotLinkedToOnCastWrite(existing, incoming);

    expect(out[0].name).toBe('Renamed');
    expect(out[0].ttsEngine).toBe('qwen');
  });

  it('[P6] returns incoming untouched when there is no existing cast', () => {
    const incoming = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'y' }] }];
    expect(preserveNotLinkedToOnCastWrite([], incoming)).toEqual(incoming);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd server && npx vitest run src/workspace/preserve-cast-voices.test.ts
```

Expected: FAIL — `preserveNotLinkedToOnCastWrite` is not exported.

- [ ] **Step 3: Implement the pass**

Insert into `server/src/workspace/preserve-cast-voices.ts` at `:76`, directly after
`preserveDesignedVoicesOnCastWrite` (which ends at `:75`). This is an insertion, not an append —
three more exports follow in that file.

```ts
/* #2166 — `notLinkedTo` is server-owned. Unlike PRESERVED_DESIGN_FIELDS above,
   which fill only a GAP and let an explicit incoming value win, this field is
   taken from disk unconditionally: the whole-roster cast PUT
   (persistence-middleware.ts fires it on nine ordinary cast actions) is never
   its authoritative writer — the reject-orphan and not-linked-to routes are.
   Without this, cast-slice.ts's `existing.notLinkedTo ?? inc.notLinkedTo`
   merge (redux's array beats the server's) lets a stale client re-PUT an edge
   that analysis.ts's reconciliation just repaired, and the two oscillate.

   Same scope as its siblings: characters that already exist on disk. A row the
   incoming write is introducing has no on-disk value to be authoritative, so
   it passes through. */
export function preserveNotLinkedToOnCastWrite<T extends { id: string }>(
  existing: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  incoming: T[],
): T[] {
  if (!existing.length) return incoming;
  const byId = new Map(existing.map((c) => [c.id, c]));
  return incoming.map((inc) => {
    const old = byId.get(inc.id);
    if (!old) return inc;
    const merged = { ...(inc as Record<string, unknown>) };
    if (old.notLinkedTo === undefined) delete merged.notLinkedTo;
    else merged.notLinkedTo = old.notLinkedTo;
    return merged as T;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd server && npx vitest run src/workspace/preserve-cast-voices.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing route-level test**

Append to `server/src/routes/book-state-preserve-voices.test.ts`. It uses that file's existing
module-scope `writeBook(dir, id, characters)` / `onDiskCast()` helpers and its
`PUT /api/books/:id/state` → 204 shape, and follows the per-`describe` `seedCast()` +
`beforeEach` pattern already used at `:239`. **Read those helpers before writing — do not invent
a harness; the sibling plan did and it cost a task.**

```ts
/* #2166 — the cast PUT is not a writer of notLinkedTo. persistence-middleware
   fires this PUT on nine ordinary cast actions carrying the whole redux
   roster, and cast-slice's `existing.notLinkedTo ?? inc.notLinkedTo` merge
   makes redux's array win — so without the server-owned pass a stale client
   re-PUTs edges the reconciliation just repaired. */
describe('book-state PUT cast — notLinkedTo is server-owned', () => {
  const seedCast = () =>
    writeBook(bookDir, bookId, [
      {
        id: 'mairin',
        name: 'Mairin',
        role: 'character',
        color: '#abc',
        notLinkedTo: [{ bookId, characterId: 'm2' }],
      },
    ]);

  beforeEach(() => seedCast());

  it('[P7] ignores a client-mutated notLinkedTo and keeps the on-disk value', async () => {
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({
        slice: 'cast',
        patch: {
          characters: [
            {
              id: 'mairin',
              name: 'Mairin',
              role: 'character',
              color: '#abc',
              notLinkedTo: [{ bookId, characterId: 'HIJACK' }],
            },
          ],
        },
      });
    expect(res.status).toBe(204);

    const mairin = onDiskCast().characters.find((c) => c.id === 'mairin')!;
    expect(mairin.notLinkedTo).toEqual([{ bookId, characterId: 'm2' }]);
  });

  it('[P8] still persists every other field the same PUT carried', async () => {
    /* The collateral-freeze check: a pass that froze the WHOLE character
       would satisfy [P7] and be badly wrong. */
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({
        slice: 'cast',
        patch: {
          characters: [
            {
              id: 'mairin',
              name: 'Mairin Renamed',
              role: 'lead',
              color: '#def',
              notLinkedTo: [{ bookId, characterId: 'HIJACK' }],
            },
          ],
        },
      });
    expect(res.status).toBe(204);

    const mairin = onDiskCast().characters.find((c) => c.id === 'mairin')!;
    expect(mairin.name).toBe('Mairin Renamed');
    expect(mairin.role).toBe('lead');
    expect(mairin.color).toBe('#def');
    expect(mairin.notLinkedTo).toEqual([{ bookId, characterId: 'm2' }]);
  });
});
```

- [ ] **Step 6: Wire it into the chain**

`server/src/routes/book-state.ts` — add to the import at `:64-68`:

```ts
  preserveNotLinkedToOnCastWrite,
```

and to `preserveDesignedVoices`, replacing `:144`:

```ts
  const characters = preserveNotLinkedToOnCastWrite(
    existingChars,
    preserveDesignedVoicesOnCastWrite(existingChars, restored),
  );
```

- [ ] **Step 7: Run both test files**

```bash
cd server && npx vitest run src/workspace/preserve-cast-voices.test.ts src/routes/book-state-preserve-voices.test.ts
```

Expected: PASS.

- [ ] **Step 8: Prove each assertion can fail**

Mutate [P1]–[P8] on their own lines; revert. Then remove the wiring at Step 6 and confirm
**[P7]** goes red — that is the only assertion proving the pass is actually *reached* by the
route rather than merely existing.

- [ ] **Step 9: Commit**

```bash
git add server/src/workspace/preserve-cast-voices.ts server/src/workspace/preserve-cast-voices.test.ts server/src/routes/book-state.ts server/src/routes/book-state-preserve-voices.test.ts
git commit -m "fix(server): make notLinkedTo server-owned on the cast PUT (#2166)"
```

---

## Task 5: The oscillation regression

**Files:**
- Test: `server/src/routes/book-state-preserve-voices.test.ts` (append one case)

**Interfaces:**
- Consumes: Task 3's `reconcileRejectEdgesOnDisk` and Task 4's `preserveNotLinkedToOnCastWrite`
  wiring. Adds no production code.

This is the case that proves the three components compose. It is its own task because it can fail
while every task above is green — that is exactly what makes it worth a reviewer's separate gate.

- [ ] **Step 1: Write the test**

Append to the same `describe` Task 4 added, so it inherits that block's `seedCast`/`beforeEach`.
It drives the reconciliation through Task 3's exported helper rather than standing up a whole
analysis run — the composition under test is *reconcile-then-PUT*, not the analysis pipeline.

```ts
  it('[P9] a repaired edge survives the next unrelated cast PUT', async () => {
    /* The oscillation the spec's review round found. Without Task 4, redux's
       `existing.notLinkedTo ?? inc.notLinkedTo` merge means the next ordinary
       cast edit re-PUTs the stale array and silently undoes the repair —
       which would make Task 3's reconciliation a coin-flip against the
       client rather than a fix. */
    const { reconcileRejectEdgesOnDisk } = await import('./analysis.js');

    // The stranded state: a same-book edge with NO rejectedPairs entry.
    expect(onDiskCast().characters[0].notLinkedTo).toEqual([{ bookId, characterId: 'm2' }]);

    await reconcileRejectEdgesOnDisk(bookDir, bookId, () => {});
    expect(onDiskCast().characters[0].notLinkedTo).toEqual([]);

    // What a client that hydrated BEFORE the repair would send next.
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({
        slice: 'cast',
        patch: {
          characters: [
            {
              id: 'mairin',
              name: 'Mairin Renamed',
              role: 'character',
              color: '#abc',
              notLinkedTo: [{ bookId, characterId: 'm2' }],
            },
          ],
        },
      });
    expect(res.status).toBe(204);

    const mairin = onDiskCast().characters.find((c) => c.id === 'mairin')!;
    expect(mairin.notLinkedTo).toEqual([]);
    expect(mairin.name).toBe('Mairin Renamed');
  });
```

`seedCast()` writes no `cast-id-history.json`, so the edge is genuinely unbacked — confirm that
before running, because a leftover history file from an adjacent test would make the
reconciliation a no-op and the whole case vacuous.

- [ ] **Step 2: Run, and prove it fails without Task 4**

```bash
cd server && npx vitest run src/routes/book-state-preserve-voices.test.ts
```

Expected: PASS. Then `git stash` Task 4's `book-state.ts` wiring only, re-run, and confirm [P9]
goes **red**; restore. A regression test that passes with the fix removed is testing nothing.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/book-state-preserve-voices.test.ts
git commit -m "test(server): pin the reject-edge oscillation regression (#2166)"
```

---

## Task 6: Docs, issue, release notes

**Files:**
- Modify: `docs/features/278-cast-character-identity.md` (invariant 10, `:223`)
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- File: one new GitHub issue

- [ ] **Step 1: Rewrite invariant 10**

Read `:223` first and match the surrounding style. It currently records the stranded edge as an
open residual; it becomes the enforced rule:

> **Invariant 10 — a reject's two writes are created together and destroyed together.** The
> `rejectedPairs` entry is written first and removed last; the `notLinkedTo` edge is created
> after it and destroyed before it, so both verbs fail into the *visible* state (chip renders,
> Undo works, retry completes). `reject-edge-reconcile.ts` heals a half-written reject at the
> next authoritative persist, and `notLinkedTo` is server-owned on the cast PUT so a stale client
> cannot undo that. Shipped by #2166 / plan 281. **Open residual:** a multi-pair DELETE can
> half-complete and become unretryable — see #NNNN.

- [ ] **Step 2: File the multi-pair DELETE issue**

```bash
gh issue create \
  --title "A multi-pair reject Undo can half-complete and become unretryable" \
  --label bug \
  --body "$(cat <<'EOF'
Found while designing #2166 (see `docs/superpowers/specs/2026-08-06-reject-edge-atomicity-design.md`,
"Deliberately not fixed here"). Not fixed there: two defensible answers and a changed failure
contract, so it fails the fix-now bar.

**The state.** In `cast-reject-orphan.ts`'s DELETE, `restoreSupersededId`
(`cast-id-history.ts:626-644`) succeeds for one pair and a later `unrejectOrphanedPair` (`:589`)
throws. The restored `supersededBy[orphanedId]` changes what `rejectedPairsGoverning` computes on
the retry: `resolveIgnoringPairRejects` now returns the `history` tier instead of a normalised
one, `normalisedTierRelevant` goes false (`cast-resolve.ts:276-293`), and the normalised-spelling
sibling pairs drop out of `governingPairs`. The retry can no longer see them, so it never removes
them — and #2166's reconciliation then writes their edges back.

**Why it is not #2166's.** #2166 orders the two writes so a half-failure is recoverable; this is
a case where the *retry itself* has been made blind. Fixing it means either ordering
`restoreSupersededId` against `unrejectOrphanedPair`, or making the DELETE's multi-pair loop
transactional — a design decision, not an obvious one-liner.

**Recorded at:** plan 278's invariant 10, and plan 281.
EOF
)"
```

Then replace `#NNNN` in Step 1 with the issue number, and add the same number to the spec's
"Deliberately not fixed here" section.

- [ ] **Step 3: Release notes**

`docs/release-notes-next.md` (technical, PR-refed):

```markdown
- **A failed "not the same character" click no longer silently suppresses name matching forever
  (#2166).** The reject's durable `rejectedPairs` entry is now written before its `notLinkedTo`
  edge and both halves are fatal, so a half-failure leaves the visible half — the chip renders and
  Undo works. A new reconciliation heals books already stranded by the old order at the next
  analysis, and `notLinkedTo` became server-owned on the cast PUT so a stale client cannot undo
  the repair. (PR #NNNN)
```

`RELEASE_NOTES.md`, in-progress version section at the top, brand voice:

```markdown
- Telling Castwright "that's not the same character" is now all-or-nothing. If saving that
  decision ever failed halfway, it used to leave an invisible mark that quietly stopped those two
  names from ever being matched again — with no way to undo it. Now a failure leaves the decision
  visible and undoable, and any book already carrying an invisible mark is cleaned up the next
  time it's analysed.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/278-cast-character-identity.md docs/release-notes-next.md RELEASE_NOTES.md docs/superpowers/specs/2026-08-06-reject-edge-atomicity-design.md
git commit -m "docs(docs): record the reject-edge invariant as enforced (#2166)"
```

---

## Ship

- [ ] `npm run verify:fast:branch` from the worktree root. Then `cd server && npm run test` in
      full — Tasks 1–5 touch four suites and a scoped run can hide a cross-suite break.
- [ ] **Add this plan to `docs/features/INDEX.md`** under its area, in **this** PR (before-shipping
      step 4). `280` is at `INDEX.md:48`; `281` currently has no entry.
- [ ] Push; open the PR titled `fix(server): make the reject's two writes fail recoverably`,
      body linking this plan and `Closes #2166`, plus "Also filed, found in passing: #NNNN".
      The body must also declare the three inverted `failure-modes.test.ts` cases (Task 1 Step 5)
      — an unannounced test inversion reads as scope creep to a reviewer.
- [ ] **On-box acceptance: none owed.** Every behaviour is provable by fault injection in unit
      tests — no GPU, no sidecar, no analyzer, no real book. Stated explicitly rather than
      silently skipped (CLAUDE.md before-shipping step 3). No register row, no run sheet.
- [ ] Mandatory `code-review` pass at **Premium** tier, effort `medium` (single-scope `fix`),
      before merge.
- [ ] After merge: set this plan's `status:` to `stable`, fill Ship notes, `git mv` to
      `docs/features/archive/`, and move its `INDEX.md` entry to `## Shipped (archive)`.

## Ship notes

_(filled at merge: date + SHA)_
