# Script Review Persistence & Unactioned-Feedback Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Script Review (fs-58) findings survive reload/disconnect (both mid-run and after completion), stop the results modal from silently discarding findings on an ordinary click, and surface + gate on unresolved findings so a user never blindly re-runs a review over work they haven't dealt with yet.

**Architecture:** A server-side sticky job registry (mirroring `analysis.ts`'s split main/subset map pattern) detaches the LLM review loop from any one HTTP connection, checkpointing each completed chapter's raw findings into a per-book on-disk ledger (`.script-review-pending.json`) via a serialized write queue. The client reconciles with this ledger + any running job on mount, re-derives appliability locally (the server never computes it), and the results modal's "close" and "discard" actions are split so an accidental click can never lose data.

**Tech Stack:** Express (server routes), Vitest (server + client tests), Redux Toolkit (client slice/thunks), React (`ScriptReviewDiff` modal, `manuscript.tsx`), Playwright (e2e regression).

## Global Constraints

- Server persists **raw findings only, never appliability** — `unappliable` is always re-derived client-side via `planApply` against live manuscript state (spec §4.2).
- `version` is a **book-scoped monotonic counter** stored at the ledger file's top level (`nextVersion`), never a per-entry counter (spec §4.2).
- **All four** ledger-mutating paths (chapter-completion upsert, selection-sync PATCH, `/resolve`, `/discard`) go through one in-process per-book write queue (spec §4.2) — reuse `withKeyLock` from `server/src/workspace/file-lock.ts` (already used this way by `server/src/routes/book-state.ts:35`), keyed by `bookId`.
- The job registry mirrors `analysis.ts`'s **two separate maps** (main/subset) — never a single `Map<bookId, job>` (spec §4.1).
- `res.on('close')` on the review route must **only remove a subscriber**, never abort the controller (spec §4.1) — this is the opposite of today's `script-review.ts:257-261` behavior and is the core of the "survives reload" guarantee.
- The results modal's backdrop/X button must dispatch a **non-destructive** hide action; only "Dismiss all" discards, and it gets a confirmation prompt (spec §6.2).
- Applying selected ops must **not** discard ops the user left unselected (spec §6.5) — this changes existing `handleApply`/`runProposed` behavior in `script-review-diff.tsx`.
- E2E regression tests for this feature must run at a **≥1280px (`xl`) viewport** — the nav tab strip they click is `hidden xl:flex` below that (spec §8).
- No changes to which op classes exist or to staleness/anchor-resolution logic (spec §3) — `planApply`/`dispatchAcceptedOps` in `src/lib/script-review-apply.ts` keep their existing behavior for op classification and application.

---

## File Structure

**Server (new):**
- `server/src/workspace/script-review-ledger.ts` — ledger file I/O: read (with `manuscriptId` staleness pruning), upsert-on-chapter-complete (always mints a fresh version, replacing any prior entry), resolve (remove named op keys), discard (remove whole entries), all serialized per-book via `withKeyLock` (`./file-lock.js`).
- `server/src/workspace/script-review-ledger.test.ts` — unit tests for the ledger module in isolation (no HTTP).

**Server (modified):**
- `server/src/workspace/paths.ts` — add `scriptReviewLedgerJsonPath(bookDir)`.
- `server/src/routes/script-review.ts` — sticky job registry (two maps), checkpointing wired into the per-chapter loop, new `GET /state`, `POST /discard`, `POST /resolve`, `PATCH /selection` handlers.
- `server/src/routes/script-review.test.ts` — extend with sticky/checkpoint/mutation-endpoint coverage.

**Client (modified):**
- `src/store/script-review-slice.ts` — `ScriptReviewBucket` gains `manuscriptId`, `versionByChapter` (per-chapter, not a single bucket-wide version — a whole-book review spans many chapters, each with its own ledger version), `visible`; new `hideReview`/`showReview`/`removeBucket`/`resolveOpsLocally`/`hydrateBucket` reducers; `setReview` payload extended.
- `src/store/script-review-slice.test.ts` — extend for new reducers.
- `src/store/script-review-thunk.ts` — new `hydrateScriptReview` (reconciliation on mount) and `attachToRunningReview` thunks; `runReviewScript` gains the checkpoint-aware ledger fields on `setReview`.
- `src/store/script-review-thunk.test.ts` — extend.
- `src/lib/api.ts` — client methods for `GET .../state`, `POST .../discard`, `POST .../resolve`, `PATCH .../selection` (real + mock); `ReviewScriptOpts` also gains `onCheckpoint`, and the SSE consumer parses the new `checkpoint` event kind (Task 9).
- `src/lib/apply-proposed.ts` — `applyProposedReattributions` reports per-op success (including deduped-name ops), not just aggregate counts.
- `src/lib/apply-proposed.test.ts` — extend.
- `src/components/script-review-diff.tsx` — hide-vs-discard split, per-op `/resolve` wiring, cancel/abort → `hideReview`.
- `src/components/script-review-diff.test.tsx` — extend (the direct regression test for the reported bug lives here at the unit level; the e2e spec covers the full click-through).
- `src/views/manuscript.tsx` — badge computation on the Review Script button, the three-way click state machine, mount-time reconciliation wiring, plus a `manuscriptId` selector threaded into the live-run call (Task 9).
- `src/views/manuscript.test.tsx` — extend.

**E2E (new):**
- `e2e/script-review-persistence.spec.ts` — Playwright regression spec, `xl` viewport pinned.

---

### Task 1: Server ledger persistence module

**Files:**
- Create: `server/src/workspace/script-review-ledger.ts`
- Modify: `server/src/workspace/paths.ts`
- Test: `server/src/workspace/script-review-ledger.test.ts`

**Interfaces:**
- Consumes: `readJson`/`writeJsonAtomic` (`server/src/workspace/state-io.ts`), `withKeyLock` (`server/src/workspace/file-lock.ts` — same directory, imported as `./file-lock.js`).
- Produces (for Task 2+ to import):
  - `interface LedgerEntry { manuscriptId: string; version: number; ops: unknown[]; selected: Record<string, boolean>; completedAt: string }`
  - `interface LedgerFile { nextVersion: number; entries: Record<string, LedgerEntry> }` (key = `String(chapterId)`)
  - `async function readLedger(bookDir: string, manuscriptId: string): Promise<LedgerFile>` — reads the file (empty `{nextVersion:1,entries:{}}` if missing/corrupt), drops any entry whose `manuscriptId` doesn't match the given one, and does **not** write the pruned result back (pruning is a read-time view; the next write naturally persists it).
  - `async function upsertChapterEntry(bookDir: string, bookId: string, params: { chapterId: number; manuscriptId: string; ops: unknown[] }): Promise<LedgerEntry>` — locked via `withKeyLock(bookId, ...)`. **Always replaces** whatever entry (if any) previously existed for this chapter, minting a fresh `version` from `nextVersion` every time — it never merges/concatenates into an existing entry's `ops`. This is deliberately simpler than an earlier draft that merged same-manuscript entries without bumping version: within one job run a chapter is checkpointed exactly once (Task 3's loop visits each chapter once), so there is never a legitimate same-run "add more ops to this chapter's entry" case — the only way `upsertChapterEntry` sees a pre-existing entry for a chapter is a stale one left over from an earlier run that was never resolved/discarded, and merging into that would silently duplicate findings. Always-replace-and-bump-version removes that failure mode entirely.
  - `async function resolveOps(bookDir: string, bookId: string, params: { chapterId: number; version: number; appliedOpKeys: string[] }): Promise<{ ok: boolean }>` — locked; no-ops (`{ok:false}`) if the entry is missing or its `version` doesn't match; otherwise removes the named keys from `ops`/`selected`, deletes the entry if `ops` is now empty, returns `{ok:true}`.
  - `async function discardChapters(bookDir: string, bookId: string, chapterIds: number[]): Promise<void>` — locked; removes each named entry unconditionally (no version check — discard is not a stale-write hazard the way resolve/PATCH are, since it's a direct user action on the currently-visible bucket).
  - `async function patchSelection(bookDir: string, bookId: string, params: { chapterId: number; version: number; selected: Record<string, boolean> }): Promise<{ ok: boolean }>` — locked; same version-check no-op rule as `resolveOps`; merges (not replaces) the given keys into the entry's `selected` map.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/workspace/script-review-ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readLedger,
  upsertChapterEntry,
  resolveOps,
  discardChapters,
  patchSelection,
} from './script-review-ledger.js';

let bookDir: string;

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'script-review-ledger-'));
});
afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

describe('script-review-ledger', () => {
  it('readLedger returns an empty envelope when no file exists', async () => {
    const ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger).toEqual({ nextVersion: 1, entries: {} });
  });

  it('upsertChapterEntry creates a new entry and mints version 1, then version 2 for a different chapter', async () => {
    const first = await upsertChapterEntry(bookDir, 'book-1', {
      chapterId: 3,
      manuscriptId: 'ms-1',
      ops: [{ id: 1, op: 'strip_tag' }],
    });
    expect(first.version).toBe(1);
    const second = await upsertChapterEntry(bookDir, 'book-1', {
      chapterId: 4,
      manuscriptId: 'ms-1',
      ops: [{ id: 2, op: 'fix_emotion' }],
    });
    expect(second.version).toBe(2);
  });

  it('upsertChapterEntry always replaces the prior entry and mints a fresh version, never merging ops', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    const replaced = await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 2, op: 'fix_emotion' }] });
    expect(replaced.version).toBe(2);
    expect(replaced.ops).toEqual([{ id: 2, op: 'fix_emotion' }]);
  });

  it('readLedger drops an entry whose manuscriptId no longer matches the current one', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-old', ops: [{ id: 1, op: 'strip_tag' }] });
    const ledger = await readLedger(bookDir, 'ms-new');
    expect(ledger.entries).toEqual({});
  });

  it('resolveOps removes named keys and deletes the entry once empty, only with a matching version', async () => {
    await upsertChapterEntry(bookDir, 'book-1', {
      chapterId: 3,
      manuscriptId: 'ms-1',
      ops: [{ id: 1, op: 'strip_tag' }, { id: 2, op: 'fix_emotion' }],
    });
    const staleResult = await resolveOps(bookDir, 'book-1', { chapterId: 3, version: 999, appliedOpKeys: ['3:1:strip_tag'] });
    expect(staleResult.ok).toBe(false);
    const okResult = await resolveOps(bookDir, 'book-1', { chapterId: 3, version: 1, appliedOpKeys: ['3:1:strip_tag'] });
    expect(okResult.ok).toBe(true);
    let ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3'].ops).toHaveLength(1);
    await resolveOps(bookDir, 'book-1', { chapterId: 3, version: 1, appliedOpKeys: ['3:2:fix_emotion'] });
    ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3']).toBeUndefined();
  });

  it('discardChapters removes entries unconditionally', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    await discardChapters(bookDir, 'book-1', [3]);
    const ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3']).toBeUndefined();
  });

  it('a discard-then-re-review of the same chapter mints a new version, so a stale write against the old version no-ops', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    await discardChapters(bookDir, 'book-1', [3]);
    const recreated = await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 9, op: 'fix_emotion' }] });
    expect(recreated.version).toBe(2);
    const staleWrite = await patchSelection(bookDir, 'book-1', { chapterId: 3, version: 1, selected: { '3:9:fix_emotion': false } });
    expect(staleWrite.ok).toBe(false);
  });

  it('patchSelection merges selection overrides without touching ops, gated by version', async () => {
    await upsertChapterEntry(bookDir, 'book-1', { chapterId: 3, manuscriptId: 'ms-1', ops: [{ id: 1, op: 'strip_tag' }] });
    const result = await patchSelection(bookDir, 'book-1', { chapterId: 3, version: 1, selected: { '3:1:strip_tag': false } });
    expect(result.ok).toBe(true);
    const ledger = await readLedger(bookDir, 'ms-1');
    expect(ledger.entries['3'].selected).toEqual({ '3:1:strip_tag': false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/workspace/script-review-ledger.test.ts`
Expected: FAIL — `Cannot find module './script-review-ledger.js'`

- [ ] **Step 3: Add the path helper**

In `server/src/workspace/paths.ts`, add after `analysisStateJsonPath`:

```typescript
/** fs-58 follow-up — per-chapter checkpointed script-review findings, keyed
    by chapterId, with a book-scoped `nextVersion` counter at the top level.
    Sibling to analysis-state.json. See script-review-ledger.ts for the I/O. */
export function scriptReviewLedgerJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'script-review-pending.json');
}
```

- [ ] **Step 4: Implement the ledger module**

```typescript
// server/src/workspace/script-review-ledger.ts
/* fs-58 follow-up — per-chapter checkpointed script-review ledger.
   Persists RAW findings only, never appliability (that's a client-side,
   live-manuscript-dependent computation — see script-review-apply.ts's
   planApply). `version` is a book-scoped monotonic counter stored at the
   file's top level, not a per-entry counter, so a discard-then-re-review
   of the same chapter can never mint a value the deleted entry already
   used — see the design spec §4.2 for why a per-entry counter would
   defeat the stale-write guard. upsertChapterEntry ALWAYS replaces the
   prior entry (never merges ops into it) — a chapter is checkpointed
   exactly once per job run, so any pre-existing entry it finds is stale
   leftover from an earlier, never-resolved run, not something to append
   to. All mutations are serialized per-book via withKeyLock so the four
   writer paths (upsert, resolve, discard, PATCH) never clobber each other. */

import { readJson, writeJsonAtomic } from './state-io.js';
import { scriptReviewLedgerJsonPath } from './paths.js';
import { withKeyLock } from './file-lock.js';

export interface LedgerEntry {
  manuscriptId: string;
  version: number;
  ops: unknown[];
  selected: Record<string, boolean>;
  completedAt: string;
}

export interface LedgerFile {
  nextVersion: number;
  entries: Record<string, LedgerEntry>;
}

const EMPTY_LEDGER: LedgerFile = { nextVersion: 1, entries: {} };

async function loadRaw(bookDir: string): Promise<LedgerFile> {
  const raw = await readJson<LedgerFile>(scriptReviewLedgerJsonPath(bookDir));
  if (!raw || typeof raw !== 'object' || !raw.entries) return { ...EMPTY_LEDGER };
  return raw;
}

/** Read the ledger, pruning any entry whose manuscriptId no longer matches
    the book's current one (a reparse renumbered its sentence ids — see
    spec §4.2/§7). The prune is read-time only; it isn't written back here,
    the next mutating call naturally persists the smaller entry set. */
export async function readLedger(bookDir: string, manuscriptId: string): Promise<LedgerFile> {
  const ledger = await loadRaw(bookDir);
  const entries: Record<string, LedgerEntry> = {};
  for (const [chapterId, entry] of Object.entries(ledger.entries)) {
    if (entry.manuscriptId === manuscriptId) entries[chapterId] = entry;
  }
  return { nextVersion: ledger.nextVersion, entries };
}

export async function upsertChapterEntry(
  bookDir: string,
  bookId: string,
  params: { chapterId: number; manuscriptId: string; ops: unknown[] },
): Promise<LedgerEntry> {
  return withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    const key = String(params.chapterId);
    const entry: LedgerEntry = {
      manuscriptId: params.manuscriptId,
      version: ledger.nextVersion,
      ops: params.ops,
      selected: {},
      completedAt: new Date().toISOString(),
    };
    ledger.nextVersion += 1;
    ledger.entries[key] = entry;
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
    return entry;
  });
}

export async function resolveOps(
  bookDir: string,
  bookId: string,
  params: { chapterId: number; version: number; appliedOpKeys: string[] },
): Promise<{ ok: boolean }> {
  return withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    const key = String(params.chapterId);
    const entry = ledger.entries[key];
    if (!entry || entry.version !== params.version) return { ok: false };
    const removed = new Set(params.appliedOpKeys);
    entry.ops = (entry.ops as Array<{ __key?: string }>).filter((_, i) => {
      // Keys are computed by the caller (route layer) the same way the client
      // does — opKey(chapterId, id, op) — so we accept them pre-serialized
      // rather than re-deriving the format here (kept out of this module to
      // avoid a duplicate opKey implementation drifting from the client's).
      return !removed.has(params.appliedOpKeys[i] === undefined ? '' : entry.ops[i] === entry.ops[i] ? (entry as unknown as { __opKeys: string[] }).__opKeys?.[i] ?? '' : '');
    });
    for (const key2 of params.appliedOpKeys) delete entry.selected[key2];
    if (entry.ops.length === 0) {
      delete ledger.entries[key];
    } else {
      ledger.entries[key] = entry;
    }
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
    return { ok: true };
  });
}

export async function discardChapters(bookDir: string, bookId: string, chapterIds: number[]): Promise<void> {
  await withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    for (const id of chapterIds) delete ledger.entries[String(id)];
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
  });
}

export async function patchSelection(
  bookDir: string,
  bookId: string,
  params: { chapterId: number; version: number; selected: Record<string, boolean> },
): Promise<{ ok: boolean }> {
  return withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    const key = String(params.chapterId);
    const entry = ledger.entries[key];
    if (!entry || entry.version !== params.version) return { ok: false };
    entry.selected = { ...entry.selected, ...params.selected };
    ledger.entries[key] = entry;
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
    return { ok: true };
  });
}
```

**Note on `resolveOps`'s key matching:** the placeholder key-matching expression above is deliberately wrong and gets replaced in the next step — `ReviewOp` doesn't carry a `chapterId` field on its own (it lives on the ledger entry, one chapter per entry), so an op's key within THIS module is `` `${chapterId}:${op.id}:${op.op}` `` using the entry's own chapterId. Fix it now:

- [ ] **Step 4b: Fix `resolveOps`'s op-key filtering**

Replace the `resolveOps` body's filtering block with:

```typescript
    const removed = new Set(params.appliedOpKeys);
    entry.ops = (entry.ops as Array<{ id: number; op: string }>).filter(
      (op) => !removed.has(`${params.chapterId}:${op.id}:${op.op}`),
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/script-review-ledger.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/workspace/script-review-ledger.ts server/src/workspace/script-review-ledger.test.ts server/src/workspace/paths.ts
git commit -m "feat(server): add per-chapter script-review ledger persistence"
```

---

### Task 2: Sticky job registry (mirrors `analysis.ts`'s split main/subset maps)

**Files:**
- Modify: `server/src/routes/script-review.ts` (the `POST /:bookId/script-review` handler, replacing lines 190–416)
- Test: `server/src/routes/script-review.test.ts` (append)

**Interfaces:**
- Consumes: nothing new from Task 1 yet (ledger wiring is Task 3).
- Produces (for Task 3+ to import from `script-review.ts`):
  - `interface ScriptReviewJob { controller: AbortController; subscribers: Set<ScriptReviewSubscriber>; bookId: string; chapterId?: number; replay: ScriptReviewReplayState }`
  - The two module-level maps (`mainScriptReviewJobByBook`, `subsetScriptReviewJobByBook`) themselves — Task 4's `GET /state` reads both directly (it doesn't know in advance which scope, if any, is running, so a single-scope lookup helper wouldn't fit); Task 5's mutation endpoints don't need to check job state at all, since discard/resolve/selection-PATCH only ever touch the persisted ledger, never in-flight job memory (design spec §7 — "discard only ever touches the persisted ledger, never an in-flight job's in-memory state"). No shared lookup helper is needed between tasks; keep the maps module-private.

Today's handler (`script-review.ts:190-416`) runs the whole per-chapter loop synchronously inside one request, with `res.on('close')` aborting the controller (`:257-261`). This task detaches it: the loop runs against a `ScriptReviewJob` object that outlives any single response, events broadcast to every subscriber in `job.subscribers`, and `res.on('close')` only removes the calling subscriber.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/script-review.test.ts` (reusing the existing `writeBook`/`app` test harness already in that file):

```typescript
describe('sticky job registry', () => {
  it('a second POST for the same chapter joins the running job and is replayed its ops', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
    ]);
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    runReview.mockImplementation(async () => {
      await gate;
      return { ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] };
    });

    const first = request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20)); // let the first request register the job

    const second = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    releaseFirst?.();
    await first;

    expect(second.text).toContain('"kind":"ops"');
    expect(second.text).toContain('strip_tag');
  });

  it('a whole-book POST while a single-chapter job is running for the same book is rejected with 409', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
    ]);
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    runReview.mockImplementation(async () => { await gate; return { ops: [] }; });

    const first = request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const conflict = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(conflict.status).toBe(409);

    releaseFirst?.();
    await first;
  });

  it('res.on("close") removes only the disconnecting subscriber; the job keeps running and completes', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let resolveReview: ((v: { ops: unknown[] }) => void) | undefined;
    runReview.mockImplementation(
      () => new Promise((resolve) => { resolveReview = resolve; }),
    );

    const req = request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    req.abort(); // simulate client disconnect
    await new Promise((r) => setTimeout(r, 20));

    resolveReview?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });

    // A fresh connection should see the job either already finished or still
    // running to completion — never aborted by the earlier disconnect.
    await new Promise((r) => setTimeout(r, 50));
    const reconnect = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    expect(reconnect.status).toBe(200);
  });

  it('the requested model is threaded through to selectAnalyzerForPhase, not dropped by the detached job runner', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    runReview.mockResolvedValue({ ops: [] });
    await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1, model: 'gemini-3.5-flash' });
    expect(selectAnalyzerForPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'phase1', model: 'gemini-3.5-flash' }),
    );
  });
});
```

- [ ] **Step 1b: Make the existing `selectAnalyzerForPhase` mock call-recordable**

This file's existing `vi.mock('../analyzer/select-analyzer.js', ...)` block (near the top of `script-review.test.ts`) stubs `selectAnalyzerForPhase` with a plain arrow function, which the new test above can't assert call-args against. Wrap it in a `vi.fn()` — change the `vi.hoisted` block from:

```typescript
const { runReview, engineState } = vi.hoisted(() => ({
  runReview: vi.fn(),
  engineState: { engine: 'gemini' as 'gemini' | 'local' },
}));
```

to also hoist a mock for the selector:

```typescript
const { runReview, engineState, selectAnalyzerForPhaseMock } = vi.hoisted(() => ({
  runReview: vi.fn(),
  engineState: { engine: 'gemini' as 'gemini' | 'local' },
  selectAnalyzerForPhaseMock: vi.fn(),
}));
```

Then in the `vi.mock('../analyzer/select-analyzer.js', ...)` factory, replace the `selectAnalyzerForPhase: () => ({...})` arrow function with:

```typescript
    selectAnalyzerForPhase: selectAnalyzerForPhaseMock.mockImplementation(() => ({
      analyzer: fakeAnalyzer,
      engine: engineState.engine,
      model: 'test-model',
      fallbackModel: null,
    })),
```

This is an additive change to the existing mock setup — every pre-existing test in this file keeps passing unchanged, since `selectAnalyzerForPhaseMock` still returns the exact same fake analyzer/engine/model shape, just via a spyable `vi.fn()` instead of a bare arrow function.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/script-review.test.ts -t "sticky job registry"`
Expected: FAIL — a fresh (non-sticky) route aborts on disconnect and has no 409 conflict handling, so the join/409/survive-disconnect assertions fail.

- [ ] **Step 3: Replace the POST handler with the sticky, subscriber-broadcast version**

In `server/src/routes/script-review.ts`, insert before the existing `scriptReviewRouter.post(...)` block (which this step replaces entirely, lines 190–416):

```typescript
export interface ScriptReviewSubscriber {
  send: (payload: unknown) => void;
  res: Response;
  keepAlive: NodeJS.Timeout;
}

export interface ScriptReviewReplayState {
  opsEvents: Array<{ kind: 'ops'; chapterId: number; ops: unknown[] }>;
  chapterFailedEvents: Array<{ kind: 'chapter-failed'; chapterId: number; message: string }>;
  lastPhase: Record<string, unknown> | null;
  result: { kind: 'result'; done: true; reviewedChapters: number; totalOps: number } | null;
  errorEvent: Record<string, unknown> | null;
  /** One entry per chapter checkpointed to the ledger this run (Task 3) —
      the ONLY channel that tells a live/reattaching client each chapter's
      ledger `version`, which it must echo back on /resolve and the
      selection PATCH (design spec §5). Without this, a client that ran or
      reattached to a review has no way to learn versions at all, and every
      resolve/PATCH call would silently no-op (Task 9 consumes this). */
  checkpointEvents: Array<{ kind: 'checkpoint'; chapterId: number; version: number }>;
}

export interface ScriptReviewJob {
  controller: AbortController;
  subscribers: Set<ScriptReviewSubscriber>;
  bookId: string;
  /** Set only for a single-chapter run; absent means whole-book. */
  chapterId?: number;
  replay: ScriptReviewReplayState;
}

/* Two separate maps — mirrors analysis.ts's inFlightAnalysisByManuscript /
   inFlightSubsetByManuscript split (server/src/routes/analysis.ts:1678-1684).
   A whole-book job and a single-chapter job for the same book must never be
   mistaken for each other: unlike analysis.ts (which lets main+subset run
   concurrently because they don't share output), both scopes here would
   checkpoint into the SAME per-chapter ledger (Task 3), so this route adds a
   stricter rule analysis.ts doesn't need — see design spec §4.1. */
const mainScriptReviewJobByBook: Map<string, ScriptReviewJob> = new Map();
const subsetScriptReviewJobByBook: Map<string, ScriptReviewJob> = new Map();

function broadcast(job: ScriptReviewJob, payload: Record<string, unknown>): void {
  for (const sub of job.subscribers) sub.send(payload);
}

function attachSubscriber(job: ScriptReviewJob, sub: ScriptReviewSubscriber): void {
  job.subscribers.add(sub);
  const { opsEvents, chapterFailedEvents, checkpointEvents, lastPhase, errorEvent, result } = job.replay;
  for (const ev of opsEvents) sub.send(ev);
  for (const ev of chapterFailedEvents) sub.send(ev);
  for (const ev of checkpointEvents) sub.send(ev);
  if (lastPhase) sub.send(lastPhase);
  if (errorEvent) sub.send(errorEvent);
  if (result) sub.send(result);
}

scriptReviewRouter.post(
  '/:bookId/script-review',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const requestedChapterId: number | undefined =
      typeof req.body?.chapterId === 'number' ? req.body.chapterId : undefined;
    const requestedModel: string | undefined =
      typeof req.body?.model === 'string' ? req.body.model : undefined;

    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const manuscriptId = located.state.manuscriptId;
    if (!manuscriptId) {
      res.status(409).json({ error: 'Book has not been analysed yet.' });
      return;
    }

    /* Join/conflict rule (design spec §4.1). */
    const targetMap = requestedChapterId !== undefined ? subsetScriptReviewJobByBook : mainScriptReviewJobByBook;
    const conflictMap = requestedChapterId !== undefined ? mainScriptReviewJobByBook : subsetScriptReviewJobByBook;
    const existingConflict = conflictMap.get(bookId);
    if (existingConflict) {
      res.status(409).json({
        error:
          requestedChapterId !== undefined
            ? 'A whole-book review is already running for this book.'
            : 'A single-chapter review is already running for this book.',
      });
      return;
    }
    const existingSameScope = targetMap.get(bookId);
    if (existingSameScope && existingSameScope.chapterId === requestedChapterId) {
      setUpSse(res);
      const sub = makeSubscriber(res);
      attachSubscriber(existingSameScope, sub);
      res.on('close', () => {
        existingSameScope.subscribers.delete(sub);
        clearInterval(sub.keepAlive);
      });
      return;
    }

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, located.bookDir);
    const allChapterIds = [...byChapter.keys()].sort((a, b) => a - b);
    const excludedChapterIds = new Set<number>(
      located.state.chapters.filter((c) => c.excluded).map((c) => c.id),
    );
    let chapterIds = allChapterIds;
    if (requestedChapterId !== undefined) {
      chapterIds = allChapterIds.filter((id) => id === requestedChapterId);
    } else {
      chapterIds = allChapterIds.filter((id) => !excludedChapterIds.has(id));
    }

    const castFile = await readJson<CastFile>(castJsonPath(located.bookDir));
    const roster: CastCharacterSlim[] = castFile?.characters ?? [];

    setUpSse(res);
    if (byChapter.size === 0) {
      res.write(
        `data: ${JSON.stringify({ kind: 'error', code: 'no_attribution', message: 'Run analysis first — there are no attributed sentences to review.' })}\n\n`,
      );
      res.end();
      return;
    }
    if (chapterIds.length === 0) {
      res.write(
        `data: ${JSON.stringify({ kind: 'error', code: 'no_such_chapter', message: `Chapter ${requestedChapterId} has no attributed sentences to review.` })}\n\n`,
      );
      res.end();
      return;
    }

    const job: ScriptReviewJob = {
      controller: new AbortController(),
      subscribers: new Set(),
      bookId,
      chapterId: requestedChapterId,
      replay: { opsEvents: [], chapterFailedEvents: [], checkpointEvents: [], lastPhase: null, result: null, errorEvent: null },
    };
    targetMap.set(bookId, job);
    const sub = makeSubscriber(res);
    job.subscribers.add(sub);
    res.on('close', () => {
      job.subscribers.delete(sub);
      clearInterval(sub.keepAlive);
    });

    void runScriptReviewJob(job, { located, manuscriptId, allChapterIds, excludedChapterIds, chapterIds, byChapter, roster, model: requestedModel })
      .finally(() => {
        if (targetMap.get(bookId) === job) targetMap.delete(bookId);
      });
  },
);

function setUpSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':ok\n\n');
}

function makeSubscriber(res: Response): ScriptReviewSubscriber {
  const keepAlive = setInterval(() => {
    try {
      res.write(':ka\n\n');
    } catch {
      /* socket gone */
    }
  }, 15_000);
  const send = (payload: unknown): void => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* dead socket */
    }
  };
  return { send, res, keepAlive };
}
```

- [ ] **Step 4: Restore the per-chapter loop as a detached job runner**

Still in `script-review.ts`, add the extracted loop body (previously inline in the POST handler) as its own function, changing every `send(...)` call to `broadcast(job, ...)` plus recording into `job.replay`, and changing the abort check from `closed` to `job.controller.signal.aborted`:

```typescript
async function runScriptReviewJob(
  job: ScriptReviewJob,
  ctx: {
    located: Awaited<ReturnType<typeof findBookByBookId>> & object;
    manuscriptId: string;
    allChapterIds: number[];
    excludedChapterIds: Set<number>;
    chapterIds: number[];
    byChapter: Map<number, SentenceOutput[]>;
    roster: CastCharacterSlim[];
    /** The client's requested analyzer model (req.body?.model), captured at
        job creation and threaded through here — today's route passes this
        straight to selectAnalyzerForPhase (script-review.ts:289); the
        detached job runner must keep doing so, or every review silently
        falls back to the default model regardless of what was requested. */
    model: string | undefined;
  },
): Promise<void> {
  const { located, manuscriptId, allChapterIds, excludedChapterIds, chapterIds, byChapter, roster, model } = ctx;
  const send = (payload: Record<string, unknown>): void => {
    if (payload.kind === 'ops') job.replay.opsEvents.push(payload as ScriptReviewReplayState['opsEvents'][number]);
    else if (payload.kind === 'chapter-failed') job.replay.chapterFailedEvents.push(payload as ScriptReviewReplayState['chapterFailedEvents'][number]);
    else if (payload.kind === 'phase') job.replay.lastPhase = payload;
    else if (payload.kind === 'error') job.replay.errorEvent = payload;
    else if (payload.kind === 'result') job.replay.result = payload as ScriptReviewReplayState['result'];
    else if (payload.kind === 'checkpoint') job.replay.checkpointEvents.push(payload as ScriptReviewReplayState['checkpointEvents'][number]);
    broadcast(job, payload);
  };
  const heartbeat = makeThrottledHeartbeat(send, 2000);
  const selection = selectAnalyzerForPhase({ phase: 'phase1', model });

  let totalOps = 0;
  let reviewedChapters = 0;
  let actualMsTotal = 0;
  let actualCharsTotal = 0;
  const charsByChapter = buildCharsByChapter(chapterIds, byChapter);
  try {
    for (let i = 0; i < chapterIds.length; i += 1) {
      if (job.controller.signal.aborted) break;
      const chapterId = chapterIds[i];
      send({
        kind: 'phase',
        phaseId: 0,
        progress: i / chapterIds.length,
        label: 'Reviewing script',
        chapterId,
        ...chapterPacingPhaseFields({
          index: i,
          totalChapters: chapterIds.length,
          actualMsTotal,
          actualCharsTotal,
          charsByChapter,
          remainingChapterIds: chapterIds.slice(i),
        }),
      });
      const chapterStartedAt = Date.now();
      const priorId = priorChapterIdFor(chapterId, allChapterIds, excludedChapterIds);
      const priorExchange = priorId !== null ? priorChapterBoundaryExchange(byChapter.get(priorId) ?? [], roster) : null;
      const chunks = chunkSentencesByBudget(byChapter.get(chapterId) ?? [], {
        charBudget: chapterChunkBudget(selection.engine),
        overlap: 3,
        serialize: (s) => JSON.stringify({ id: s.id, characterId: s.characterId, text: s.text }),
      });
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (job.controller.signal.aborted) break;
        const prompt = buildScriptReviewChapterInbox(
          manuscriptId, chapterId, chunkWithContext(chunk), roster, index === 0 ? priorExchange : null,
        );
        try {
          const result = await selection.analyzer.runScriptReviewChapter(manuscriptId, chapterId, prompt, {
            signal: job.controller.signal,
            language: bookStateLanguage(located.state),
            onChunk: (info) => heartbeat(0, chapterId, { receivedBytes: info.receivedBytes, elapsedMs: info.elapsedMs, sinceLastChunkMs: info.sinceLastChunkMs }),
            onThrottle: (waitMs, reason) => send({ kind: 'throttle', phaseId: 0, chapterIndex: chapterId, model: selection.model, waitMs, reason }),
          });
          const owned = result.ops.filter((op) => ownsOp(chunk.coreIds, primarySentenceId(op)));
          if (owned.length) {
            send({ kind: 'ops', chapterId, ops: owned });
            totalOps += owned.length;
          }
        } catch (err) {
          if (err instanceof AnalysisAbortedError) break;
          if (err instanceof DailyQuotaExhaustedError) {
            send({ kind: 'error', code: 'quota_exhausted', message: 'Daily analyzer quota exhausted. Already-reviewed chapters are streamed — re-run to finish.', resetAt: err.resetAt instanceof Date ? err.resetAt.toISOString() : undefined });
            for (const sub of job.subscribers) sub.res.end();
            return;
          }
          send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
        }
      }
      ({ actualMsTotal, actualCharsTotal } = accumulateChapterPacing({ actualMsTotal, actualCharsTotal }, chapterStartedAt, charsByChapter.get(chapterId) ?? 0));
      reviewedChapters += 1;
    }
  } finally {
    for (const sub of job.subscribers) clearInterval(sub.keepAlive);
  }
  if (!job.controller.signal.aborted) {
    send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
    send({ kind: 'result', done: true, reviewedChapters, totalOps });
  }
  for (const sub of job.subscribers) sub.res.end();
}
```

Note: `job.controller.signal.aborted` never actually gets set to `true` by a disconnect anymore (that was the old behavior this task removes) — the controller exists so a *future* explicit cancel path could still abort it, but nothing in this task calls `.abort()`. The loop's abort checks are dead code paths today, kept only because `runScriptReviewChapter`'s `signal` option still expects a real `AbortSignal`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS, including the 3 new sticky-registry tests and all pre-existing tests in this file (the loop body is unchanged in behavior, just relocated).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): make script-review sticky via a split main/subset job registry"
```

---

### Task 3: Wire per-chapter ledger checkpointing into the job loop

**Files:**
- Modify: `server/src/routes/script-review.ts`
- Test: `server/src/routes/script-review.test.ts` (append)

**Interfaces:**
- Consumes: `upsertChapterEntry` from Task 1's `server/src/workspace/script-review-ledger.ts`.
- Produces: nothing new for later tasks — this task closes the "crash mid-chapter loses only that chapter" guarantee (spec §2).

- [ ] **Step 1: Write the failing test**

Append to `server/src/routes/script-review.test.ts`:

```typescript
describe('ledger checkpointing', () => {
  it('checkpoints a chapter to the ledger as soon as it completes, even with zero subscribers attached', async () => {
    const { readLedger } = await import('../workspace/script-review-ledger.js');
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
    ]);
    let resolveChapter2: (() => void) | undefined;
    runReview
      .mockResolvedValueOnce({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] })
      .mockImplementationOnce(() => new Promise<{ ops: unknown[] }>((resolve) => {
        resolveChapter2 = () => resolve({ ops: [] });
      }));

    const req = request(app).post(`/api/books/${bookId}/script-review`).send({});
    req.abort(); // disconnect before chapter 2 even starts — job keeps running
    await new Promise((r) => setTimeout(r, 30));

    const ledgerMidRun = await readLedger(bookDir(), manuscriptId);
    expect(ledgerMidRun.entries['1'].ops).toHaveLength(1);
    expect(ledgerMidRun.entries['1'].manuscriptId).toBe(manuscriptId);

    resolveChapter2?.();
    await new Promise((r) => setTimeout(r, 30));
    const ledgerAfter = await readLedger(bookDir(), manuscriptId);
    // Chapter 2 produced zero ops, so no entry is created for it.
    expect(ledgerAfter.entries['2']).toBeUndefined();
  });

  it('broadcasts a checkpoint event carrying the minted version once a chapter is upserted', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    runReview.mockResolvedValue({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    expect(res.text).toContain('"kind":"checkpoint"');
    expect(res.text).toMatch(/"chapterId":1,"version":\d+/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/script-review.test.ts -t "ledger checkpointing"`
Expected: FAIL — `ledgerMidRun.entries['1']` is `undefined` (nothing is written to the ledger yet).

- [ ] **Step 3: Wire the upsert call after each chapter finishes**

In `server/src/routes/script-review.ts`'s `runScriptReviewJob`, import `upsertChapterEntry` at the top of the file:

```typescript
import { upsertChapterEntry } from '../workspace/script-review-ledger.js';
```

Then, inside the per-chapter `for` loop, after the chunk `for` loop ends and pacing is accumulated (right after `reviewedChapters += 1;`), add:

```typescript
      const chapterOps = job.replay.opsEvents
        .filter((e) => e.chapterId === chapterId)
        .flatMap((e) => e.ops);
      if (chapterOps.length > 0) {
        const entry = await upsertChapterEntry(located.bookDir, job.bookId, {
          chapterId,
          manuscriptId,
          ops: chapterOps,
        });
        // Broadcast the minted version so a live or reattaching client can
        // learn it — this is the ONLY channel that delivers a chapter's
        // ledger version to the client; without it, /resolve and the
        // selection PATCH have nothing to echo back and silently no-op
        // (design spec §5, and the version-delivery gap this fixes).
        send({ kind: 'checkpoint', chapterId, version: entry.version });
      }
```

(`job.replay.opsEvents` already accumulates every `ops` event for this run via `send()`'s bookkeeping from Task 2 — filtering by `chapterId` here picks out just this chapter's, since a chapter can span multiple chunks/events. The `send()` call above also records this `checkpoint` event into `job.replay.checkpointEvents`, per Task 2's Step 4 bookkeeping.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS (all tests, including the new checkpointing one).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): checkpoint each completed chapter to the script-review ledger"
```

---

### Task 4: `GET /:bookId/script-review/state` reconciliation endpoint

**Files:**
- Modify: `server/src/routes/script-review.ts`
- Test: `server/src/routes/script-review.test.ts` (append)

**Interfaces:**
- Consumes: `mainScriptReviewJobByBook`/`subsetScriptReviewJobByBook` (Task 2, module-private, read directly since this handler is itself defined in the same file), `readLedger` (Task 1).
- Produces (consumed by Task 8's client hydration thunk):
  - Running-job shape: `{ kind: 'running'; chapterId?: number; replay: { opsEvents, chapterFailedEvents, checkpointEvents, lastPhase, result, errorEvent } }` (the handler returns `running.replay` as-is, so this must list every field `ScriptReviewReplayState` — Task 2 — actually carries, including `checkpointEvents`, which Task 9's version-delivery fix depends on)
  - Ledger-only shape: `{ kind: 'ledger'; entries: Record<string, LedgerEntry> }`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/script-review.test.ts`:

```typescript
describe('GET /:bookId/script-review/state', () => {
  it('returns kind:"ledger" with existing entries when no job is running', async () => {
    const { upsertChapterEntry } = await import('../workspace/script-review-ledger.js');
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    await upsertChapterEntry(bookDir(), bookId, {
      chapterId: 1,
      manuscriptId,
      ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('ledger');
    expect(res.body.entries['1'].ops).toHaveLength(1);
  });

  it('returns kind:"running" with the replay buffer while a job is in flight', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let resolveReview: ((v: { ops: unknown[] }) => void) | undefined;
    runReview.mockImplementation(() => new Promise((resolve) => { resolveReview = resolve; }));

    const req = request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.body.kind).toBe('running');
    expect(res.body.chapterId).toBe(1);

    resolveReview?.({ ops: [] });
    await req;
  });

  it('returns kind:"ledger" with empty entries for a book with neither a job nor pending findings', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.body).toEqual({ kind: 'ledger', entries: {} });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/script-review.test.ts -t "GET /:bookId/script-review/state"`
Expected: FAIL — 404 (no such route yet).

- [ ] **Step 3: Implement the endpoint**

In `server/src/routes/script-review.ts`, add after the POST handler and import `readLedger` alongside `upsertChapterEntry`:

```typescript
import { upsertChapterEntry, readLedger } from '../workspace/script-review-ledger.js';
```

```typescript
scriptReviewRouter.get(
  '/:bookId/script-review/state',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const runningMain = mainScriptReviewJobByBook.get(bookId);
    const runningSubset = subsetScriptReviewJobByBook.get(bookId);
    const running = runningMain ?? runningSubset;
    if (running) {
      res.json({ kind: 'running', chapterId: running.chapterId, replay: running.replay });
      return;
    }
    const manuscriptId = located.state.manuscriptId;
    if (!manuscriptId) {
      res.json({ kind: 'ledger', entries: {} });
      return;
    }
    const ledger = await readLedger(located.bookDir, manuscriptId);
    res.json({ kind: 'ledger', entries: ledger.entries });
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): add GET /:bookId/script-review/state reconciliation endpoint"
```

---

### Task 5: Mutation endpoints — `POST /discard`, `POST /resolve`, `PATCH /selection`

**Files:**
- Modify: `server/src/routes/script-review.ts`
- Test: `server/src/routes/script-review.test.ts` (append)

**Interfaces:**
- Consumes: `discardChapters`, `resolveOps`, `patchSelection` (Task 1).
- Produces (consumed by Task 7's client `api.ts` methods): the three request/response shapes below.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/script-review.test.ts`:

```typescript
describe('mutation endpoints', () => {
  async function seedEntry() {
    const { upsertChapterEntry } = await import('../workspace/script-review-ledger.js');
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    return upsertChapterEntry(bookDir(), bookId, {
      chapterId: 1,
      manuscriptId,
      ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }],
    });
  }

  it('POST /discard removes the named chapters entirely', async () => {
    await seedEntry();
    const res = await request(app)
      .post(`/api/books/${bookId}/script-review/discard`)
      .send({ chapterIds: [1] });
    expect(res.status).toBe(200);
    const state = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(state.body.entries['1']).toBeUndefined();
  });

  it('POST /resolve removes only the named op keys and no-ops on a stale version', async () => {
    const entry = await seedEntry();
    const stale = await request(app)
      .post(`/api/books/${bookId}/script-review/resolve`)
      .send({ chapterId: 1, version: entry.version + 1, appliedOpKeys: ['1:1:strip_tag'] });
    expect(stale.body.ok).toBe(false);

    const ok = await request(app)
      .post(`/api/books/${bookId}/script-review/resolve`)
      .send({ chapterId: 1, version: entry.version, appliedOpKeys: ['1:1:strip_tag'] });
    expect(ok.body.ok).toBe(true);
    const state = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(state.body.entries['1']).toBeUndefined(); // was the only op — entry deleted
  });

  it('PATCH /selection merges overrides and no-ops on a stale version', async () => {
    const entry = await seedEntry();
    const res = await request(app)
      .patch(`/api/books/${bookId}/script-review/selection`)
      .send({ chapterId: 1, version: entry.version, selected: { '1:1:strip_tag': false } });
    expect(res.body.ok).toBe(true);
    const state = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(state.body.entries['1'].selected).toEqual({ '1:1:strip_tag': false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/script-review.test.ts -t "mutation endpoints"`
Expected: FAIL — 404 for all three routes.

- [ ] **Step 3: Implement the three endpoints**

In `server/src/routes/script-review.ts`, import the remaining ledger functions:

```typescript
import { upsertChapterEntry, readLedger, discardChapters, resolveOps, patchSelection } from '../workspace/script-review-ledger.js';
```

```typescript
scriptReviewRouter.post(
  '/:bookId/script-review/discard',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const chapterIds: number[] = Array.isArray(req.body?.chapterIds) ? req.body.chapterIds : [];
    await discardChapters(located.bookDir, bookId, chapterIds);
    res.json({ ok: true });
  },
);

scriptReviewRouter.post(
  '/:bookId/script-review/resolve',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const { chapterId, version, appliedOpKeys } = req.body ?? {};
    if (typeof chapterId !== 'number' || typeof version !== 'number' || !Array.isArray(appliedOpKeys)) {
      res.status(400).json({ error: 'chapterId, version, and appliedOpKeys are required.' });
      return;
    }
    const result = await resolveOps(located.bookDir, bookId, { chapterId, version, appliedOpKeys });
    res.json(result);
  },
);

scriptReviewRouter.patch(
  '/:bookId/script-review/selection',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const { chapterId, version, selected } = req.body ?? {};
    if (typeof chapterId !== 'number' || typeof version !== 'number' || typeof selected !== 'object') {
      res.status(400).json({ error: 'chapterId, version, and selected are required.' });
      return;
    }
    const result = await patchSelection(located.bookDir, bookId, { chapterId, version, selected });
    res.json(result);
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS — full file green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): add discard/resolve/selection mutation endpoints for script review"
```

This closes out the server side. Tasks 6+ are client-side.

---

### Task 6: Extend `script-review-slice.ts` — `manuscriptId`/`versionByChapter`/`visible`, hide-vs-discard reducers

**Files:**
- Modify: `src/store/script-review-slice.ts`
- Test: `src/store/script-review-slice.test.ts` (create if it doesn't already exist — check first with `Glob "src/store/script-review-slice.test.ts"`; if present, append to it instead of overwriting)

**Interfaces:**
- Produces (for Task 8/9/10/12/13 to import):
  - `ScriptReviewBucket` gains `manuscriptId: string`, `versionByChapter: Record<number, number>` (per-chapter — a whole-book review spans many chapters, each with its own ledger version), `visible: boolean`.
  - `scriptReviewActions.setReview({ bookId, ops, unappliable, manuscriptId, versionByChapter })` (payload extended; always sets `visible: true`).
  - `scriptReviewActions.hideReview({ bookId })` — sets `visible: false`; never touches `ops`/`selected`/`unappliable`.
  - `scriptReviewActions.showReview({ bookId })` — sets `visible: true`.
  - `scriptReviewActions.removeBucket({ bookId })` — deletes the whole bucket (replaces the old `clearReview` name; kept as the low-level primitive the discard thunk calls after a successful server call).
  - `scriptReviewActions.resolveOpsLocally({ bookId, opKeys: string[] })` — removes the named ops/selected keys; deletes the bucket entirely if `ops` becomes empty.
  - `export function selectVisibleReview(state: RootState, bookId: string): ScriptReviewBucket | undefined` — like `selectActiveReview` but returns `undefined` when the bucket exists but `visible` is `false`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/store/script-review-slice.test.ts
import { describe, it, expect } from 'vitest';
import { scriptReviewSlice, scriptReviewActions, selectActiveReview, selectVisibleReview, opKey } from './script-review-slice';
import type { RootState } from './index';

function makeOp(id: number, op: string, chapterId = 1) {
  return { id, op, chapterId, rationale: 'r' } as never;
}

describe('script-review-slice — hide vs discard', () => {
  it('setReview always sets visible:true and stores manuscriptId/version', () => {
    const state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [makeOp(1, 'strip_tag')], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 3 } }),
    );
    expect(state.byBook['b1']?.visible).toBe(true);
    expect(state.byBook['b1']?.manuscriptId).toBe('ms-1');
    expect(state.byBook['b1']?.versionByChapter).toEqual({ 1: 3 });
  });

  it('hideReview flips visible to false without touching ops/selected', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [makeOp(1, 'strip_tag')], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.hideReview({ bookId: 'b1' }));
    expect(state.byBook['b1']?.visible).toBe(false);
    expect(state.byBook['b1']?.ops).toHaveLength(1);
  });

  it('showReview flips visible back to true', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.hideReview({ bookId: 'b1' }));
    state = scriptReviewSlice.reducer(state, scriptReviewActions.showReview({ bookId: 'b1' }));
    expect(state.byBook['b1']?.visible).toBe(true);
  });

  it('removeBucket deletes the bucket entirely', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.removeBucket({ bookId: 'b1' }));
    expect(state.byBook['b1']).toBeUndefined();
  });

  it('resolveOpsLocally removes named ops and deletes the bucket once empty', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag'), makeOp(2, 'fix_emotion')],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1 },
      }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.resolveOpsLocally({ bookId: 'b1', opKeys: [opKey(1, 1, 'strip_tag')] }));
    expect(state.byBook['b1']?.ops).toHaveLength(1);
    state = scriptReviewSlice.reducer(state, scriptReviewActions.resolveOpsLocally({ bookId: 'b1', opKeys: [opKey(1, 2, 'fix_emotion')] }));
    expect(state.byBook['b1']).toBeUndefined();
  });

  it('selectVisibleReview returns undefined when the bucket is hidden, selectActiveReview still returns it', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.hideReview({ bookId: 'b1' }));
    const root = { scriptReview: state } as unknown as RootState;
    expect(selectVisibleReview(root, 'b1')).toBeUndefined();
    expect(selectActiveReview(root, 'b1')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/script-review-slice.test.ts`
Expected: FAIL — `setReview`'s payload type doesn't accept `manuscriptId`/`versionByChapter`; `hideReview`/`showReview`/`removeBucket`/`resolveOpsLocally`/`selectVisibleReview` don't exist.

- [ ] **Step 3: Implement the slice changes**

In `src/store/script-review-slice.ts`, update `ScriptReviewBucket`:

```typescript
export interface ScriptReviewBucket {
  ops: ReviewOpWithChapter[];
  unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
  selected: Record<string, boolean>;
  /** The manuscript these ops' sentence ids belong to — a reparse changes
      this, which invalidates the bucket (see hydration in Task 8). One value
      for the whole bucket: readLedger already drops any entry whose
      manuscriptId doesn't match the book's current one before the client
      ever sees it, so every chapter remaining in a hydrated bucket shares
      this same value. */
  manuscriptId: string;
  /** Per-CHAPTER ledger version (design spec §4.2's version nonce is minted
      per ledger entry, i.e. per chapter — a whole-book bucket spans many
      chapters, each with its own). Keyed by chapterId. Echoed back on
      /resolve and the selection PATCH for that chapter so a stale write
      against a discarded-and-recreated entry no-ops server-side. */
  versionByChapter: Record<number, number>;
  /** Whether the results modal is currently shown. Closing (X/backdrop) sets
      this false WITHOUT touching ops/selected — only discardReview (Task 12)
      removes the bucket outright. */
  visible: boolean;
}
```

Replace the `setReview` reducer's payload type and body. `manuscriptId`/`versionByChapter` are **optional with defaults** for now (`''`/`{}`) so `script-review-thunk.ts:89`'s existing call site keeps compiling and behaving as before until Task 8 deliberately rewrites it to pass real values:

```typescript
    setReview: (
      s,
      a: PayloadAction<{
        bookId: string;
        ops: ReviewOpWithChapter[];
        unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
        manuscriptId?: string;
        versionByChapter?: Record<number, number>;
      }>,
    ) => {
      const { bookId, ops, unappliable, manuscriptId = '', versionByChapter = {} } = a.payload;
      const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']);
      const selected: Record<string, boolean> = {};
      for (const o of ops) {
        selected[opKey(o.chapterId, o.id, o.op)] = !DEFAULT_OFF.has(o.op);
      }
      s.byBook[bookId] = { ops, unappliable, selected, manuscriptId, versionByChapter, visible: true };
    },
```

Keep `clearReview` exactly as it is today (do not remove or rename it yet — every existing call site in `script-review-diff.tsx` keeps working unmodified), and add the new reducers alongside it:

```typescript
    /** Hide the modal without touching any data — the X button / backdrop
        click (design spec §6.2). */
    hideReview: (s, a: PayloadAction<{ bookId: string }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (bucket) bucket.visible = false;
    },
    /** Reopen a hidden bucket (the badge/re-run-gate "Review existing" path). */
    showReview: (s, a: PayloadAction<{ bookId: string }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (bucket) bucket.visible = true;
    },
    /** Delete a book's bucket entirely — the same behavior as clearReview,
        under the name Task 12's discardReview thunk will call after a
        successful server discard. clearReview itself is removed in Task 12
        once every call site has migrated to hideReview/removeBucket. */
    removeBucket: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.byBook[a.payload.bookId];
    },
    /** Remove specific applied ops (by opKey) from a book's bucket, deleting
        the whole bucket once none remain — the client-side mirror of the
        server's /resolve (Task 5), applied optimistically once the server
        call succeeds (Task 13). */
    resolveOpsLocally: (s, a: PayloadAction<{ bookId: string; opKeys: string[] }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (!bucket) return;
      const removed = new Set(a.payload.opKeys);
      bucket.ops = bucket.ops.filter((o) => !removed.has(opKey(o.chapterId, o.id, o.op)));
      for (const key of a.payload.opKeys) delete bucket.selected[key];
      if (bucket.ops.length === 0) delete s.byBook[a.payload.bookId];
    },
```

Add the new selector after `selectActiveReview`:

```typescript
/** Like selectActiveReview, but returns undefined for a hidden bucket — use
    this to gate the modal's render, not selectActiveReview (which still
    answers "does this book have a pending review at all", used by the
    unresolved-findings badge in Task 10). */
export function selectVisibleReview(state: RootState, bookId: string): ScriptReviewBucket | undefined {
  const bucket = state.scriptReview.byBook[bookId];
  return bucket?.visible ? bucket : undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/store/script-review-slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm existing callers still compile untouched**

Run: `npx tsc --noEmit -p .`
Expected: no new errors — `script-review-thunk.ts:89`'s existing `setReview({ bookId, ops: appliable, unappliable })` call still typechecks (the new fields are optional) and every `clearReview` call site in `script-review-diff.tsx` is untouched. Task 9 deliberately starts passing real `manuscriptId`/`versionByChapter` values from the live run and the reattach path; Task 12 deliberately replaces `clearReview` call sites with `hideReview`/the new discard thunk.

- [ ] **Step 6: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-slice.test.ts
git commit -m "feat(frontend): add manuscriptId/version/visible to the script-review bucket"
```

---

### Task 7: `api.ts` client methods for the new endpoints

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.test.ts` (append if it exists; otherwise `Glob "src/lib/api*.test.ts"` first to find the right file — this codebase's convention is one shared api test file per the `reviewScript` precedent, so extend whichever file already tests `reviewScript`/`realReviewScript`)

**Interfaces:**
- Produces (consumed by Task 8's hydration thunk, Task 12's discard thunk, Task 13's resolve/PATCH calls):
  - `api.getScriptReviewState(bookId: string): Promise<{ kind: 'running'; chapterId?: number; replay: unknown } | { kind: 'ledger'; entries: Record<string, LedgerEntryDTO> }>`
  - `api.discardScriptReview(bookId: string, chapterIds: number[]): Promise<void>`
  - `api.resolveScriptReviewOps(bookId: string, params: { chapterId: number; version: number; appliedOpKeys: string[] }): Promise<{ ok: boolean }>`
  - `api.patchScriptReviewSelection(bookId: string, params: { chapterId: number; version: number; selected: Record<string, boolean> }): Promise<{ ok: boolean }>`
  - `interface LedgerEntryDTO { manuscriptId: string; version: number; ops: unknown[]; selected: Record<string, boolean>; completedAt: string }`

- [ ] **Step 1: Write the failing tests**

```typescript
// appended to the existing api test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('script-review persistence endpoints', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('getScriptReviewState GETs the state endpoint and returns the parsed body', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'ledger', entries: {} }),
    });
    const { realApi } = await import('./api'); // adjust to however real* functions are exported/imported for direct test in this file
    const result = await realApi.getScriptReviewState('book-1');
    expect(fetch).toHaveBeenCalledWith('/api/books/book-1/script-review/state', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ kind: 'ledger', entries: {} });
  });

  it('discardScriptReview POSTs the chapter ids', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const { realApi } = await import('./api');
    await realApi.discardScriptReview('book-1', [3, 4]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/books/book-1/script-review/discard',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ chapterIds: [3, 4] }) }),
    );
  });

  it('resolveScriptReviewOps POSTs chapterId/version/appliedOpKeys and returns { ok }', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const { realApi } = await import('./api');
    const result = await realApi.resolveScriptReviewOps('book-1', { chapterId: 3, version: 2, appliedOpKeys: ['3:1:strip_tag'] });
    expect(result).toEqual({ ok: true });
  });

  it('patchScriptReviewSelection PATCHes chapterId/version/selected and returns { ok }', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: false }) });
    const { realApi } = await import('./api');
    const result = await realApi.patchScriptReviewSelection('book-1', { chapterId: 3, version: 2, selected: { '3:1:strip_tag': false } });
    expect(result).toEqual({ ok: false });
  });
});
```

Note: this codebase's `api.ts` doesn't export a `realApi` object directly in the source shown above — it builds `api = USE_MOCKS ? mock : real` from two large literal objects at the bottom of the file (around line 8678 for the real one, 8948 for the mock one). Adjust the test's import to whatever this file actually exports for testing the real implementation directly (check the top of the existing `reviewScript`-covering test file for the established pattern — likely `vi.stubGlobal` on `fetch` plus importing the same `api` object with `VITE_USE_MOCKS` forced off, or a named export of the real functions). Mirror that exact pattern rather than inventing a new one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/api.test.ts -t "script-review persistence endpoints"`
Expected: FAIL — the four methods don't exist yet.

- [ ] **Step 3: Implement the real functions**

In `src/lib/api.ts`, add near `realReviewScript` (around line 3133):

```typescript
interface LedgerEntryDTO {
  manuscriptId: string;
  version: number;
  ops: unknown[];
  selected: Record<string, boolean>;
  completedAt: string;
}
type ScriptReviewStateDTO =
  | { kind: 'running'; chapterId?: number; replay: unknown }
  | { kind: 'ledger'; entries: Record<string, LedgerEntryDTO> };

async function realGetScriptReviewState(bookId: string): Promise<ScriptReviewStateDTO> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/script-review/state`, { method: 'GET' });
  if (!res.ok) throw new Error(`Failed to load script-review state (${res.status}).`);
  return res.json();
}

async function realDiscardScriptReview(bookId: string, chapterIds: number[]): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/script-review/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapterIds }),
  });
  if (!res.ok) throw new Error(`Failed to discard script-review findings (${res.status}).`);
}

async function realResolveScriptReviewOps(
  bookId: string,
  params: { chapterId: number; version: number; appliedOpKeys: string[] },
): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/script-review/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Failed to resolve script-review ops (${res.status}).`);
  return res.json();
}

async function realPatchScriptReviewSelection(
  bookId: string,
  params: { chapterId: number; version: number; selected: Record<string, boolean> },
): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/script-review/selection`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Failed to sync script-review selection (${res.status}).`);
  return res.json();
}
```

- [ ] **Step 4: Implement the mock functions**

```typescript
async function mockGetScriptReviewState(_bookId: string): Promise<ScriptReviewStateDTO> {
  return { kind: 'ledger', entries: {} };
}
async function mockDiscardScriptReview(_bookId: string, _chapterIds: number[]): Promise<void> {}
async function mockResolveScriptReviewOps(): Promise<{ ok: boolean }> {
  return { ok: true };
}
async function mockPatchScriptReviewSelection(): Promise<{ ok: boolean }> {
  return { ok: true };
}
```

- [ ] **Step 5: Register both sets in the exported `api` objects**

Add to the real-implementation object (alongside `reviewScript: realReviewScript,` around line 8693):

```typescript
  getScriptReviewState: realGetScriptReviewState,
  discardScriptReview: realDiscardScriptReview,
  resolveScriptReviewOps: realResolveScriptReviewOps,
  patchScriptReviewSelection: realPatchScriptReviewSelection,
```

Add to the mock-implementation object (alongside `reviewScript: mockReviewScript,` around line 8963):

```typescript
  getScriptReviewState: mockGetScriptReviewState,
  discardScriptReview: mockDiscardScriptReview,
  resolveScriptReviewOps: mockResolveScriptReviewOps,
  patchScriptReviewSelection: mockPatchScriptReviewSelection,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): add api client methods for script-review persistence endpoints"
```

---

### Task 8: Reconciliation thunk — hydrate from the ledger on mount

**Files:**
- Modify: `src/store/script-review-slice.ts` (one more reducer)
- Modify: `src/store/script-review-thunk.ts`
- Test: `src/store/script-review-thunk.test.ts` (extend — this file already exists per the design research; if not found, create it)

**Interfaces:**
- Consumes: `api.getScriptReviewState` (Task 7), `planApply` (`src/lib/script-review-apply.ts`, unchanged).
- Produces (consumed by Task 10):
  - `scriptReviewActions.hydrateBucket({ bookId, ops, unappliable, manuscriptId, versionByChapter, selected })` — a lower-level reducer than `setReview`: takes the **fully pre-computed** `selected` map (DEFAULT_OFF baseline already merged with persisted overrides by the thunk) instead of recomputing it from scratch, since the ledger's `selected` field stores only explicit overrides (design spec §4.2) and `setReview`'s existing DEFAULT_OFF computation has no overlay mechanism.
  - `export async function hydrateScriptReview(bookId: string, opts: { dispatch: AppDispatch; getState: () => RootState; subscribe: (listener: () => void) => () => void }): Promise<void>` — the reconciliation entry point Task 10 calls on mount.
  - `waitForManuscriptAndCast` (internal, not exported) — resolves once `state.manuscript.manuscriptId` and `state.cast.characters` are both populated, so a hydration that races the manuscript/cast load doesn't misclassify every op as unappliable (design spec §4.3).

- [ ] **Step 1: Write the failing tests**

This file already hoists a module mock for `../lib/api` (`vi.mock('../lib/api', () => ({ api: { reviewScript: vi.fn() } }))` near the top of `script-review-thunk.test.ts`). **Extend that existing declaration** rather than adding a second, conflicting mock mechanism — a per-test `vi.spyOn`/dynamic-import accessor spy on a module that's already whole-module-mocked doesn't reliably expose new methods. Change it to:

```typescript
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

Then append the tests, using `vi.mocked(api.getScriptReviewState)` against the already-mocked import:

```typescript
// appended to src/store/script-review-thunk.test.ts
import { describe, it, expect, vi } from 'vitest';
import { hydrateScriptReview } from './script-review-thunk';
import { scriptReviewActions } from './script-review-slice';
import { api } from '../lib/api';

function makeFakeStore(initial: { manuscriptId: string | null; characters: Array<{ id: string }>; sentences: unknown[] }) {
  let state = {
    manuscript: { manuscriptId: initial.manuscriptId, sentences: initial.sentences },
    cast: { characters: initial.characters },
  };
  const listeners: Array<() => void> = [];
  return {
    getState: () => state as never,
    subscribe: (fn: () => void) => { listeners.push(fn); return () => {}; },
    setManuscriptReady: (manuscriptId: string, sentences: unknown[], characters: Array<{ id: string }>) => {
      state = { manuscript: { manuscriptId, sentences }, cast: { characters } };
      listeners.forEach((l) => l());
    },
  };
}

describe('hydrateScriptReview', () => {
  it('dispatches hydrateBucket from a ledger-only state response, waiting for manuscript+cast readiness first', async () => {
    const dispatch = vi.fn();
    const fakeStore = makeFakeStore({ manuscriptId: null, characters: [], sentences: [] });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'ledger',
      entries: { '1': { manuscriptId: 'ms-1', version: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }], selected: { '1:1:strip_tag': false }, completedAt: '2026-01-01' } },
    });

    const promise = hydrateScriptReview('book-1', { dispatch, getState: fakeStore.getState, subscribe: fakeStore.subscribe });
    // Not resolved yet — manuscript/cast aren't ready.
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).not.toHaveBeenCalled();

    fakeStore.setManuscriptReady('ms-1', [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }], [{ id: 'c1' }]);
    await promise;

    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.hydrateBucket(
        expect.objectContaining({
          bookId: 'book-1',
          manuscriptId: 'ms-1',
          versionByChapter: { 1: 5 },
          selected: expect.objectContaining({ '1:1:strip_tag': false }),
        }),
      ),
    );
  });

  it('resolves immediately without dispatching when the ledger has no entries', async () => {
    const dispatch = vi.fn();
    const fakeStore = makeFakeStore({ manuscriptId: 'ms-1', characters: [{ id: 'c1' }], sentences: [] });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({ kind: 'ledger', entries: {} });

    await hydrateScriptReview('book-1', { dispatch, getState: fakeStore.getState, subscribe: fakeStore.subscribe });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/script-review-thunk.test.ts -t "hydrateScriptReview"`
Expected: FAIL — `hydrateScriptReview` and `scriptReviewActions.hydrateBucket` don't exist yet.

- [ ] **Step 3: Add the `hydrateBucket` reducer**

In `src/store/script-review-slice.ts`, add alongside `setReview`:

```typescript
    /** Hydrate a bucket from the persisted ledger (Task 8). Unlike setReview
        (the live-run-completion path, which computes `selected` fresh from
        DEFAULT_OFF), the caller here has ALREADY merged the DEFAULT_OFF
        baseline with the ledger's persisted override map — the ledger only
        ever stores explicit overrides (design spec §4.2), so there's no
        recomputation to do inside the reducer. */
    hydrateBucket: (
      s,
      a: PayloadAction<{
        bookId: string;
        ops: ReviewOpWithChapter[];
        unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
        manuscriptId: string;
        versionByChapter: Record<number, number>;
        selected: Record<string, boolean>;
      }>,
    ) => {
      const { bookId, ops, unappliable, manuscriptId, versionByChapter, selected } = a.payload;
      s.byBook[bookId] = { ops, unappliable, selected, manuscriptId, versionByChapter, visible: true };
    },
```

- [ ] **Step 4: Implement `hydrateScriptReview`**

In `src/store/script-review-thunk.ts`, add:

```typescript
import { api } from '../lib/api';
import type { RootState } from './index';

const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']);

interface ManuscriptCastSnapshot {
  sentences: ReviewLiveSentence[];
  characterIds: Set<string>;
  manuscriptId: string;
}

function snapshotIfReady(getState: () => RootState): ManuscriptCastSnapshot | null {
  const state = getState();
  const manuscriptId = state.manuscript.manuscriptId;
  const characters = state.cast?.characters;
  if (!manuscriptId || !characters) return null;
  return {
    manuscriptId,
    characterIds: new Set(characters.map((c) => c.id)),
    sentences: state.manuscript.sentences.map((s) => ({
      id: s.id,
      chapterId: s.chapterId,
      text: s.text,
      characterId: s.characterId,
      instruct: s.instruct,
      vocalization: s.vocalization,
    })),
  };
}

/** Resolves once the manuscript + cast for the CURRENT book are loaded.
    Guards against the false-zero-badge bug: hydrating before either is
    ready would make planApply mark every op unappliable (design spec §4.3). */
function waitForManuscriptAndCast(
  getState: () => RootState,
  subscribe: (listener: () => void) => () => void,
): Promise<ManuscriptCastSnapshot> {
  return new Promise((resolve) => {
    const immediate = snapshotIfReady(getState);
    if (immediate) {
      resolve(immediate);
      return;
    }
    const unsubscribe = subscribe(() => {
      const snapshot = snapshotIfReady(getState);
      if (snapshot) {
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

export async function hydrateScriptReview(
  bookId: string,
  opts: { dispatch: AppDispatch; getState: () => RootState; subscribe: (listener: () => void) => () => void },
): Promise<void> {
  const { dispatch, getState, subscribe } = opts;
  const state = await api.getScriptReviewState(bookId);
  if (state.kind === 'running') return; // Task 9 handles this branch.
  const chapterEntries = Object.entries(state.entries);
  if (chapterEntries.length === 0) return;

  const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe);

  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};
  const persistedSelected: Record<string, boolean> = {};
  for (const [chapterKey, entry] of chapterEntries) {
    const chapterId = Number(chapterKey);
    versionByChapter[chapterId] = entry.version;
    for (const op of entry.ops as ReviewOp[]) allOps.push({ ...op, chapterId });
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

Add `opKey` to the existing import from `./script-review-slice` at the top of the file (it currently only imports `scriptReviewActions` and `ReviewOpWithChapter`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/store/script-review-thunk.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-thunk.ts src/store/script-review-thunk.test.ts
git commit -m "feat(frontend): hydrate script-review findings from the persisted ledger on mount"
```

---

### Task 9: Deliver ledger versions to the live client — reattach without resetting progress, and fix the "Apply never resolves" gap

**Files:**
- Modify: `src/lib/api.ts` (`ReviewScriptOpts`, `realReviewScript`, `mockReviewScript`)
- Modify: `src/store/script-review-thunk.ts` (both `runReviewScript` and the new `attachToRunningReview`)
- Modify: `src/views/manuscript.tsx` (one line — thread `manuscriptId` into the existing `handleReviewScript`'s `runReviewScript` call)
- Test: `src/store/script-review-thunk.test.ts` (extend)

**This task exists to close a critical gap the independent review of this plan found**: Task 3's server-side checkpoint mints a `version` for each chapter, but nothing delivered that version to the *live* client — `runReviewScript`'s existing `setReview` dispatch (`script-review-thunk.ts:89`) never gained `manuscriptId`/`versionByChapter` in any earlier task, so in the most common flow (run a review, click Apply in the same session) `resolveAppliedOps` (Task 13) would find every chapter's version `undefined` and silently skip *both* the server `/resolve` call and the local bucket update — applied ops would neither be persisted as resolved nor removed from the badge. The fix: the server broadcasts a `checkpoint` event per chapter (Task 3); this task threads that event through the client's SSE consumer and into both `runReviewScript` (the live-run path) and the new `attachToRunningReview` (the reattach path), so both end up dispatching `setReview` with real values.

**Interfaces:**
- Consumes: `ScriptReviewJob`'s `checkpoint` SSE event (Task 3), the `{ kind: 'running'; chapterId?; replay }` DTO Task 4's `GET /state` returns (fetched once by `hydrateScriptReview`, Task 8).
- Produces:
  - `ReviewScriptOpts` (in `api.ts`) gains `onCheckpoint?: (ev: { chapterId: number; version: number }) => void`.
  - `RunReviewScriptOpts` gains a required `manuscriptId: string`.
  - `attachToRunningReview(bookId, running, opts): Promise<void>` — reattaches, seeds progress from the replay (never resets to 0%), and **does** dispatch `setReview` with real `manuscriptId`/`versionByChapter` once the job's terminal event arrives (an earlier draft of this task deliberately skipped this dispatch; the independent review confirmed that directly contradicts design spec §4.3's "a completed-while-you-were-reconnecting run still ends up populating `byBook[bookId]` correctly").
  - `hydrateScriptReview`'s `kind === 'running'` branch is rewired to await manuscript/cast readiness and call `attachToRunningReview` with real values, instead of Task 8's placeholder early-return.

- [ ] **Step 1: Write the failing tests**

```typescript
// appended to src/store/script-review-thunk.test.ts
// (runReviewScript is already imported by this file's existing tests;
// add attachToRunningReview to that same import line)
import { runReviewScript, attachToRunningReview } from './script-review-thunk';

describe('runReviewScript — version delivery', () => {
  it('accumulates versionByChapter from onCheckpoint events and stamps them onto the final setReview dispatch', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId, opts) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 7 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
    await runReviewScript('book-1', {
      dispatch, wholeBook: false, chapterId: 1, model: 'test-model',
      sentences: [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setReview(
        expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 1: 7 } }),
      ),
    );
  });
});

describe('attachToRunningReview', () => {
  it('seeds progress from the replay buffer instead of resetting to 0', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockResolvedValue({ reviewedChapters: 0, totalOps: 0 } as never);
    const runningState = {
      kind: 'running' as const,
      chapterId: undefined,
      replay: {
        opsEvents: [{ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }],
        chapterFailedEvents: [],
        checkpointEvents: [{ chapterId: 1, version: 5 }],
        lastPhase: { progress: 0.4, label: 'Reviewing script' },
        result: null,
        errorEvent: null,
      },
    };
    await attachToRunningReview('book-1', runningState, {
      dispatch,
      sentences: [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setActive(expect.objectContaining({ bookId: 'book-1', progress: 0.4 })),
    );
    expect(dispatch).not.toHaveBeenCalledWith(scriptReviewActions.setActive(expect.objectContaining({ progress: 0 })));
  });

  it('dispatches setReview with the ops/versions delivered by the join\'s own replay — not double-counted with the GET /state snapshot', async () => {
    const dispatch = vi.fn();
    // Simulates Task 2's attachSubscriber: the join POST replays every
    // buffered event through the SAME onOps/onCheckpoint callbacks a live
    // stream would use. attachToRunningReview must rely on THIS, not on
    // pre-seeding from runningState.replay, or each op would count twice.
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId, opts) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 5 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
    const runningState = {
      kind: 'running' as const,
      chapterId: undefined,
      replay: {
        // Deliberately non-empty (same op/version the mock below replays —
        // that's fine, detection doesn't rely on the values differing).
        // attachToRunningReview's type no longer even exposes these fields
        // (see RunningReviewState below), so this object only typechecks
        // because it's assigned to a variable first, not an inline literal
        // (TS skips excess-property checks on variables) — if
        // attachToRunningReview regressed to reading opsEvents/
        // checkpointEvents from BOTH this snapshot and the mock's replay,
        // the op would be pushed into allOps twice and the ops.length===1
        // assertion below would fail. The assertion is what catches the
        // regression, not any value mismatch.
        opsEvents: [{ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }],
        chapterFailedEvents: [],
        checkpointEvents: [{ chapterId: 1, version: 5 }],
        lastPhase: { progress: 0.9, label: 'Reviewing script' },
        result: null,
        errorEvent: null,
      },
    };
    await attachToRunningReview('book-1', runningState, {
      dispatch,
      sentences: [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });
    const setReviewCall = dispatch.mock.calls.find(([action]) => action.type === 'scriptReview/setReview');
    expect(setReviewCall?.[0].payload).toEqual(
      expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 1: 5 } }),
    );
    // The critical assertion: exactly ONE copy of the op, not two.
    expect(setReviewCall?.[0].payload.ops).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/script-review-thunk.test.ts -t "version delivery|attachToRunningReview"`
Expected: FAIL — `onCheckpoint` isn't threaded anywhere; `attachToRunningReview` doesn't exist; `runReviewScript` doesn't accept `manuscriptId`.

- [ ] **Step 3: Add `onCheckpoint` to `api.ts`'s SSE consumer**

In `src/lib/api.ts`, add `onCheckpoint?: (ev: { chapterId: number; version: number }) => void;` to the `ReviewScriptOpts` interface. In `realReviewScript`'s `handle` function (the `switch (p.kind)` block that already handles `'phase'`, `'throttle'`, `'ops'` — see `api.ts` around line 3154), add a new arm:

```typescript
      case 'checkpoint':
        if (typeof p.chapterId === 'number' && typeof p.version === 'number') {
          onCheckpoint?.({ chapterId: p.chapterId, version: p.version });
        }
        break;
```

and destructure `onCheckpoint` alongside the existing `{ chapterId, model, signal, onPhase, onThrottle, onOps, onChapterFailed }: ReviewScriptOpts = {}` parameter. In `mockReviewScript` (`api.ts` around line 3218), **add `onCheckpoint` to its own destructured parameter list too** — it currently destructures only `{ onOps, onPhase, onChapterFailed: _onChapterFailed }: ReviewScriptOpts = {}`, so `onCheckpoint` isn't in scope to call yet. Then call `onCheckpoint?.({ chapterId: 1, version: 1 })` (or per-chapter, matching whatever canned chapter ids the mock already emits ops for) right after each of its existing `onOps?.(...)` calls, so mock mode exercises the same code path.

- [ ] **Step 4: Rewrite `runReviewScript` to accumulate and stamp versions**

In `src/store/script-review-thunk.ts`, add `manuscriptId: string` to `RunReviewScriptOpts`:

```typescript
export interface RunReviewScriptOpts {
  dispatch: AppDispatch;
  wholeBook: boolean;
  chapterId?: number;
  model: string;
  sentences: ReviewLiveSentence[];
  characterIds: Set<string>;
  /** The book's current manuscriptId (design spec §4.2) — stamped onto the
      setReview dispatch at the end of the run, alongside the versions
      accumulated from onCheckpoint below, so the bucket carries the same
      identifiers the ledger does. */
  manuscriptId: string;
}
```

Replace the body:

```typescript
export async function runReviewScript(bookId: string, opts: RunReviewScriptOpts): Promise<void> {
  const { dispatch, wholeBook, chapterId, model, sentences, characterIds, manuscriptId } = opts;
  const allOps: ReviewOpWithChapter[] = [];
  const failed: Array<{ chapterId: number; message: string }> = [];
  const versionByChapter: Record<number, number> = {};
  dispatch(scriptReviewActions.setActive({ bookId, progress: 0, label: 'Reviewing script' }));
  try {
    await api.reviewScript(bookId, {
      ...(wholeBook ? {} : { chapterId }),
      model,
      onPhase: ({ progress, label, chapterIndex, totalChapters, estRemainingMs }) =>
        dispatch(
          scriptReviewActions.updateProgress({ bookId, progress, label, chapterIndex, totalChapters, estRemainingMs }),
        ),
      onOps: ({ chapterId: chId, ops }: { chapterId: number; ops: ReviewOp[] }) => {
        for (const op of ops) allOps.push({ ...op, chapterId: chId });
      },
      onChapterFailed: (e: { chapterId: number; message: string }) => failed.push(e),
      onCheckpoint: ({ chapterId: chId, version }: { chapterId: number; version: number }) => {
        versionByChapter[chId] = version;
      },
    });
    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    if (appliable.length === 0 && unappliable.length === 0 && failed.length > 0) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message:
            failed.length === 1
              ? failed[0].message
              : `${failed.length} chapters couldn't be reviewed (too large or failed).`,
        }),
      );
    } else {
      if (failed.length > 0) {
        dispatch(
          notificationsActions.pushToast({
            kind: 'warn',
            message: `${failed.length} chapter(s) skipped; showing the rest.`,
          }),
        );
      }
      dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter }));
    }
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
}
```

- [ ] **Step 5: Implement `attachToRunningReview`**

```typescript
// Deliberately narrow — this is NOT the full GET /state running shape
// (that's Task 4's ScriptReviewReplayState, which also carries opsEvents/
// checkpointEvents/result/errorEvent). attachToRunningReview only ever
// reads `lastPhase` (for the progress seed); it must get its ops/versions
// exclusively from the join POST's own replay, never from this snapshot
// (see the comment above attachToRunningReview for why). Only declaring
// the field this function actually uses closes off a future "helpfully"
// reading opsEvents/checkpointEvents here and reintroducing the
// double-count this task exists to fix — the wider server response object
// still satisfies this narrower type structurally, so no caller changes.
interface RunningReviewState {
  kind: 'running';
  chapterId?: number;
  replay: {
    lastPhase: { progress: number; label: string; chapterIndex?: number; totalChapters?: number; estRemainingMs?: number } | null;
  };
}

/** Reattach to a job already running server-side (design spec §4.1/§4.3) —
    e.g. after a reload mid-review. Seeds ONLY the progress pill from the
    replay's lastPhase (never progress:0, which would visibly reset it) —
    it deliberately does NOT seed `allOps`/`versionByChapter` from
    `running.replay` before joining. The join POST below re-subscribes via
    Task 2's join-or-create route, and Task 2's `attachSubscriber` ALREADY
    replays every buffered `ops`/`checkpoint` event to a newly-joining
    subscriber through these same `onOps`/`onCheckpoint` callbacks — so
    seeding from the snapshot AND joining would double-count every
    pre-reattach op (each op ends up in `allOps` twice: once from the GET
    /state snapshot, once from the join's own replay). Relying on the
    join's replay alone is both correct and simpler: by the time
    `api.reviewScript` resolves, `allOps`/`versionByChapter` hold each
    chapter's ops/version exactly once, whether they arrived via replay or
    live streaming after that. */
export async function attachToRunningReview(
  bookId: string,
  running: RunningReviewState,
  opts: { dispatch: AppDispatch; sentences: ReviewLiveSentence[]; characterIds: Set<string>; manuscriptId: string },
): Promise<void> {
  const { dispatch, sentences, characterIds, manuscriptId } = opts;
  const seedProgress = running.replay.lastPhase?.progress ?? 0;
  dispatch(
    scriptReviewActions.setActive({ bookId, progress: seedProgress, label: running.replay.lastPhase?.label ?? 'Reviewing script' }),
  );

  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};

  try {
    await api.reviewScript(bookId, {
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
    // The join-or-create route (Task 2) attaches this call as a subscriber
    // to the SAME job (assuming it's still running — see the known TOCTOU
    // caveat below) and Task 2's attachSubscriber replays every buffered
    // event before any live ones, so by the time api.reviewScript resolves
    // allOps/versionByChapter hold every chapter's ops/version exactly once.
    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter }));
  } finally {
    dispatch(scriptReviewActions.clear({ bookId }));
  }
}
```

**Known, accepted limitation — a narrow reattach race.** There's a TOCTOU window between `hydrateScriptReview`'s `GET /state` call (which reports `kind: 'running'`) and this function's join POST: if the job finishes in that gap, Task 2's registry no longer has an entry to join, and the POST falls through to *create* a fresh job — silently starting a full re-review instead of attaching. This is a narrow, low-probability race (the window is a network round-trip plus `waitForManuscriptAndCast`, not the whole review duration), and its worst case is wasted analyzer time on an already-mostly-complete book, not data loss — every chapter that job had already checkpointed is still safely in the ledger regardless. Building a dedicated attach-only endpoint to close this race entirely is out of scope for this plan; call it out explicitly here rather than leaving it undiscovered, matching this plan's practice elsewhere (e.g. §3's accepted full-server-restart data loss) of naming known gaps instead of silently absorbing them.

- [ ] **Step 6: Rewire `hydrateScriptReview`'s running branch**

Replace Task 8's placeholder:

```typescript
  if (state.kind === 'running') return; // Task 9 handles this branch.
```

with:

```typescript
  if (state.kind === 'running') {
    const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe);
    await attachToRunningReview(bookId, state, { dispatch, sentences, characterIds, manuscriptId });
    return;
  }
```

- [ ] **Step 7: Thread `manuscriptId` into the existing live-run call site**

In `src/views/manuscript.tsx`, add a selector near `bookId` (around line 133) and pass it through the existing `handleReviewScript`'s `runReviewScript(...)` call (line 758) — this is the ONLY change this task makes to `manuscript.tsx`; Task 11 later refactors this same function further and just carries the field forward:

```typescript
  const manuscriptId = useAppSelector((s) => s.manuscript.manuscriptId);
```

```typescript
      await runReviewScript(bookId, {
        dispatch,
        wholeBook,
        chapterId: wholeBook ? undefined : currentChapterId ?? undefined,
        model: reviewModel,
        sentences: sentencesRef.current.map((s) => ({
          id: s.id,
          chapterId: s.chapterId,
          text: s.text,
          characterId: s.characterId,
          instruct: s.instruct,
          vocalization: s.vocalization,
        })),
        characterIds: new Set(characters.map((c) => c.id)),
        manuscriptId: manuscriptId ?? '',
      });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/store/script-review-thunk.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/api.ts src/store/script-review-thunk.ts src/store/script-review-thunk.test.ts src/views/manuscript.tsx
git commit -m "fix(frontend): deliver ledger versions to the live client so Apply actually resolves"
```

---

### Task 10: Wire hydration into `manuscript.tsx` mount + the unresolved-findings badge

**Files:**
- Modify: `src/store/script-review-slice.ts` (one pure helper)
- Modify: `src/views/manuscript.tsx`
- Test: `src/views/manuscript.test.tsx` (extend)

**Interfaces:**
- Consumes: `hydrateScriptReview` (Task 8/9).
- Produces: `export function unresolvedCountForChapters(bucket: ScriptReviewBucket | undefined, chapterIds: number[]): number` — counts ops in `bucket.ops` whose `chapterId` is in `chapterIds`. `bucket.ops` already holds only the currently-appliable set (post-`planApply`, per Tasks 8/9's seeding) — this task does not re-run `planApply` on every render; no change to staleness invalidation is in scope (design spec §3).

- [ ] **Step 1: Write the failing tests**

```typescript
// appended to src/views/manuscript.test.tsx (adjust imports/setup to match this file's existing render harness)
import { unresolvedCountForChapters } from '../store/script-review-slice';

describe('unresolvedCountForChapters', () => {
  it('counts only ops in the given chapters', () => {
    const bucket = {
      ops: [
        { id: 1, op: 'strip_tag', chapterId: 1, rationale: 'r' },
        { id: 2, op: 'fix_emotion', chapterId: 2, rationale: 'r' },
      ],
      unappliable: [],
      selected: {},
      manuscriptId: 'ms-1',
      versionByChapter: { 1: 1, 2: 1 },
      visible: true,
    } as never;
    expect(unresolvedCountForChapters(bucket, [1])).toBe(1);
    expect(unresolvedCountForChapters(bucket, [1, 2])).toBe(2);
    expect(unresolvedCountForChapters(undefined, [1])).toBe(0);
  });
});

it('shows a count badge on the Review Script button when the current chapter has unresolved findings', async () => {
  // Render ManuscriptView with a pre-populated scriptReview.byBook bucket for
  // the current chapter (mirror this file's existing render-with-store setup)
  // and assert the button's accessible text contains the count, e.g.
  // "Review Script (1)" — match whatever label format Step 3 below produces.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/views/manuscript.test.tsx -t "unresolvedCountForChapters"`
Expected: FAIL — the helper doesn't exist.

- [ ] **Step 3: Implement the helper and wire mount-time hydration + the badge**

In `src/store/script-review-slice.ts`, add:

```typescript
/** Count of currently-appliable, unresolved ops touching any of the given
    chapters — the "Review Script" button badge (design spec §6.3). */
export function unresolvedCountForChapters(bucket: ScriptReviewBucket | undefined, chapterIds: number[]): number {
  if (!bucket) return 0;
  const set = new Set(chapterIds);
  return bucket.ops.filter((o) => set.has(o.chapterId)).length;
}
```

In `src/views/manuscript.tsx`, import `useStore` from `'react-redux'`, `hydrateScriptReview` from `'../store/script-review-thunk'`, and `unresolvedCountForChapters` from `'../store/script-review-slice'`. Add a mount effect near the other `bookId`-keyed effects (after the `hasActiveReview` selector around line 145):

```typescript
  const store = useStore<RootState>();
  useEffect(() => {
    if (!bookId) return;
    void hydrateScriptReview(bookId, { dispatch, getState: store.getState, subscribe: store.subscribe });
    // Intentionally no cleanup/abort: hydration is a one-shot reconciliation
    // per mount, and the sticky job registry (server Task 2) makes a
    // duplicate in-flight POST from attachToRunningReview safe to abandon.
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace the badge-less button label at line 863 (`{reviewLoading ? 'Reviewing…' : 'Review Script'}`) with a count-aware version. Add above the button JSX (near `reviewSubstage`, around line 139):

```typescript
  const currentChapterUnresolvedCount = useAppSelector((s) =>
    bookId ? unresolvedCountForChapters(s.scriptReview?.byBook[bookId], [currentChapter.id]) : 0,
  );
  const wholeBookUnresolvedCount = useAppSelector((s) =>
    bookId ? unresolvedCountForChapters(s.scriptReview?.byBook[bookId], chapters.map((c) => c.id)) : 0,
  );
```

Then change the button label:

```typescript
                  {reviewLoading
                    ? 'Reviewing…'
                    : currentChapterUnresolvedCount > 0
                      ? `Review Script (${currentChapterUnresolvedCount})`
                      : 'Review Script'}
```

And the whole-book menu item (around line 886-890), append a badge span:

```typescript
                      Review whole book
                      {wholeBookUnresolvedCount > 0 && (
                        <span className="ml-1.5 text-xs font-semibold text-ink/70">
                          ({wholeBookUnresolvedCount} unresolved)
                        </span>
                      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/views/manuscript.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-slice.ts src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): hydrate script review on mount and badge unresolved findings"
```

---

### Task 11: Review Script click state machine + re-run confirm dialog

**Files:**
- Modify: `src/store/script-review-thunk.ts` (new `discardReview` thunk)
- Modify: `src/views/manuscript.tsx`
- Test: `src/store/script-review-thunk.test.ts`, `src/views/manuscript.test.tsx` (extend both)

**Interfaces:**
- Produces (consumed by Task 12): `export async function discardReview(bookId: string, chapterIds: number[], opts: { dispatch: AppDispatch }): Promise<void>` — calls `api.discardScriptReview`, then dispatches `scriptReviewActions.removeBucket({ bookId })` (a whole-bucket removal is correct here even for a partial-chapter discard from the confirm gate, since the client only ever holds one in-progress review's worth of chapters per book at a time — the same simplification the existing single-bucket-per-book model already makes).
- Produces: `manuscript.tsx`'s `handleReviewScript` now implements the three-way check from design spec §6.4 instead of only `if (!bookId || reviewLoading) return`.

- [ ] **Step 1: Write the failing tests**

```typescript
// appended to src/store/script-review-thunk.test.ts
// Uses the file's hoisted vi.mock('../lib/api', ...) — already extended
// with discardScriptReview by Task 8 — via vi.mocked(), NOT a per-test
// vi.spyOn(module, 'api', 'get') accessor spy (that pattern doesn't work
// against a module already whole-module-mocked; see Task 8's fix).
describe('discardReview', () => {
  it('calls the discard API then removes the bucket', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.discardScriptReview).mockResolvedValue(undefined);
    await discardReview('book-1', [3, 4], { dispatch });
    expect(api.discardScriptReview).toHaveBeenCalledWith('book-1', [3, 4]);
    expect(dispatch).toHaveBeenCalledWith(scriptReviewActions.removeBucket({ bookId: 'book-1' }));
  });
});
```

```typescript
// appended to src/views/manuscript.test.tsx
it('clicking Review Script with unresolved findings in scope opens a confirm dialog instead of starting a new run', async () => {
  // Render with a pre-seeded scriptReview.byBook bucket holding an op for
  // the current chapter, click data-testid="review-script-chapter", and
  // assert a confirm dialog (data-testid="review-script-confirm-gate")
  // appears with "Review existing" and "Discard and start new" actions,
  // and that runReviewScript/api.reviewScript was NOT called.
});

it('"Review existing" in the confirm dialog reopens the hidden modal without discarding', async () => {
  // Same setup; click "Review existing"; assert scriptReviewActions.showReview
  // was dispatched and discardScriptReview was NOT called.
});

it('"Discard and start new" calls discardReview then starts a fresh run', async () => {
  // Same setup; click "Discard and start new"; assert discardScriptReview WAS
  // called with the current chapter's id, then api.reviewScript was called.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/script-review-thunk.test.ts src/views/manuscript.test.tsx -t "discardReview|confirm dialog|Review existing|Discard and start new"`
Expected: FAIL — `discardReview` doesn't exist; the confirm gate doesn't exist.

- [ ] **Step 3: Implement `discardReview`**

In `src/store/script-review-thunk.ts`:

```typescript
export async function discardReview(
  bookId: string,
  chapterIds: number[],
  opts: { dispatch: AppDispatch },
): Promise<void> {
  await api.discardScriptReview(bookId, chapterIds);
  opts.dispatch(scriptReviewActions.removeBucket({ bookId }));
}
```

- [ ] **Step 4: Implement the click state machine**

In `src/views/manuscript.tsx`, add local state for the confirm gate near `reviewMenuOpen` (around line 142):

```typescript
  const [confirmGate, setConfirmGate] = useState<{ wholeBook: boolean; chapterIds: number[]; count: number } | null>(null);
  const scriptReviewBucket = useAppSelector((s) => (bookId ? s.scriptReview?.byBook[bookId] : undefined));
  const jobActiveForBook = useAppSelector((s) => !!(bookId && s.scriptReview?.activeStreams[bookId]));
```

Replace `handleReviewScript` (lines 752-778) with:

```typescript
  async function startNewReview(wholeBook: boolean) {
    if (!bookId) return;
    setReviewLoading(true);
    setReviewMenuOpen(false);
    try {
      await runReviewScript(bookId, {
        dispatch,
        wholeBook,
        chapterId: wholeBook ? undefined : currentChapterId ?? undefined,
        model: reviewModel,
        sentences: sentencesRef.current.map((s) => ({
          id: s.id, chapterId: s.chapterId, text: s.text, characterId: s.characterId,
          instruct: s.instruct, vocalization: s.vocalization,
        })),
        characterIds: new Set(characters.map((c) => c.id)),
        manuscriptId: manuscriptId ?? '', // selector already added in Task 9
      });
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleReviewScript(wholeBook: boolean) {
    if (!bookId || reviewLoading) return;
    if (!wholeBook && currentChapterId == null) return;

    // Case 1 (design spec §6.4): a job is already running for this book,
    // any scope. The button is already disabled via reviewLoading/
    // analysisBusy in the common case; this is the defensive check for
    // e.g. a job attached via hydrateScriptReview on a different tab/mount.
    if (jobActiveForBook) return;

    const targetChapterIds = wholeBook ? chapters.filter((c) => !c.excluded).map((c) => c.id) : [currentChapterId!];
    const unresolvedCount = unresolvedCountForChapters(scriptReviewBucket, targetChapterIds);
    if (unresolvedCount > 0) {
      setConfirmGate({ wholeBook, chapterIds: targetChapterIds, count: unresolvedCount });
      return;
    }

    await startNewReview(wholeBook);
  }

  function handleReviewExisting() {
    if (!bookId) return;
    dispatch(scriptReviewActions.showReview({ bookId }));
    setConfirmGate(null);
  }

  async function handleDiscardAndStartNew() {
    if (!bookId || !confirmGate) return;
    const { wholeBook, chapterIds } = confirmGate;
    setConfirmGate(null);
    await discardReview(bookId, chapterIds, { dispatch });
    await startNewReview(wholeBook);
  }
```

Add the confirm dialog JSX right before the `{hasActiveReview && bookId && <ScriptReviewDiff bookId={bookId} />}` line (786):

```typescript
      {confirmGate && (
        <>
          <div className="fixed inset-0 bg-ink/40 z-50" aria-hidden="true" />
          <div className="fixed inset-0 z-50 grid place-items-center p-4 pointer-events-none">
            <div
              data-testid="review-script-confirm-gate"
              className="bg-white rounded-3xl shadow-float w-full max-w-md pointer-events-auto p-6 space-y-4"
            >
              <p className="text-sm text-ink/80">
                You have {confirmGate.count} unresolved suggestion{confirmGate.count === 1 ? '' : 's'} in{' '}
                {confirmGate.wholeBook ? 'this book' : `chapter ${currentChapter.id}`}. Review them, or discard
                and start a new review?
              </p>
              <div className="flex items-center gap-3">
                <button
                  data-testid="review-script-confirm-review-existing"
                  onClick={handleReviewExisting}
                  className="px-4 min-h-[44px] sm:min-h-0 py-2 rounded-full bg-ink text-canvas text-sm font-semibold"
                >
                  Review existing
                </button>
                <button
                  data-testid="review-script-confirm-discard"
                  onClick={() => void handleDiscardAndStartNew()}
                  className="px-4 min-h-[44px] sm:min-h-0 py-2 rounded-full border border-ink/20 text-ink text-sm font-semibold"
                >
                  Discard and start new
                </button>
              </div>
            </div>
          </div>
        </>
      )}
```

Import `discardReview` and `unresolvedCountForChapters` and `scriptReviewActions` (already imported for `selectActiveReview`) at the top of `manuscript.tsx`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/store/script-review-thunk.test.ts src/views/manuscript.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/script-review-thunk.ts src/store/script-review-thunk.test.ts src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): gate Review Script clicks on unresolved findings"
```

---

### Task 12: `ScriptReviewDiff` hide-vs-discard split — the direct fix for the reported bug

**Files:**
- Modify: `src/components/script-review-diff.tsx`
- Modify: `src/views/manuscript.tsx` (render gate)
- Test: `src/components/script-review-diff.test.tsx` (extend — create if it doesn't exist yet)

**Interfaces:**
- Consumes: `hideReview`, `discardReview` (Task 11), `selectVisibleReview` (Task 6).
- Produces: the modal's X button and backdrop click are non-destructive; "Dismiss all" is the sole destructive action and requires confirmation.

- [ ] **Step 1: Write the failing tests**

```typescript
// appended to src/components/script-review-diff.test.tsx
it('clicking the backdrop dispatches hideReview, not a discard — this is the regression test for the reported data-loss bug', () => {
  // Render with a seeded bucket; click the backdrop (the element with
  // aria-hidden="true" sibling to the dialog, or query by the fixed
  // inset-0 bg-ink/40 class per this file's existing render conventions);
  // assert scriptReviewActions.hideReview was dispatched and
  // api.discardScriptReview was NOT called.
});

it('the X button dispatches hideReview, not a discard', () => {
  // Click data-testid="close-button"; assert hideReview dispatched, no discard call.
});

it('"Dismiss all" requires confirmation before discarding', () => {
  // Click data-testid="dismiss-button"; assert a confirmation prompt appears
  // (data-testid="dismiss-confirm") and api.discardScriptReview has NOT
  // been called yet; click the confirm button; assert it WAS called with
  // every chapterId present in the bucket's ops.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/script-review-diff.test.tsx -t "hideReview|Dismiss all"`
Expected: FAIL — `handleClose`/`handleDismiss` still dispatch `clearReview` unconditionally with no confirmation step.

- [ ] **Step 3: Rewire close/backdrop to `hideReview`, and add a confirm step to Dismiss all**

In `src/components/script-review-diff.tsx`, import `discardReview` from `'../store/script-review-thunk'` and add local state near the existing `confirm` state (line 193):

```typescript
  const [confirmDismiss, setConfirmDismiss] = useState(false);
```

Replace `handleClose` (lines 214-216):

```typescript
  function handleClose() {
    dispatch(scriptReviewActions.hideReview({ bookId }));
  }
```

Replace `handleDismiss` (lines 218-220) to open the confirm step instead of discarding directly:

```typescript
  function handleDismiss() {
    setConfirmDismiss(true);
  }

  async function confirmDismissAll() {
    const chapterIds = [...new Set(ops.map((o) => o.chapterId))];
    setConfirmDismiss(false);
    await discardReview(bookId, chapterIds, { dispatch });
  }
```

Add a confirm overlay, rendered right after the existing off-roster confirm block (after line 394, before the backdrop `<div>` at line 397):

```typescript
      {confirmDismiss && (
        <>
          <div className="fixed inset-0 bg-ink/50 z-[60]" aria-hidden="true" />
          <div className="fixed inset-0 z-[60] grid place-items-center p-4 pointer-events-none">
            <div
              data-testid="dismiss-confirm"
              className="bg-white rounded-3xl shadow-float w-full max-w-sm pointer-events-auto p-6 space-y-4"
            >
              <p className="text-sm text-ink/80">
                Discard {ops.length} unresolved suggestion{ops.length === 1 ? '' : 's'}? This can&apos;t be undone.
              </p>
              <div className="flex items-center gap-3">
                <button
                  data-testid="dismiss-confirm-yes"
                  onClick={() => void confirmDismissAll()}
                  className="px-4 min-h-[44px] sm:min-h-0 py-2 rounded-full bg-ink text-canvas text-sm font-semibold"
                >
                  Discard
                </button>
                <button
                  data-testid="dismiss-confirm-cancel"
                  onClick={() => setConfirmDismiss(false)}
                  className="px-4 min-h-[44px] sm:min-h-0 py-2 rounded-full border border-ink/20 text-ink text-sm font-semibold"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}
```

- [ ] **Step 4: Swap the modal's render gate in `manuscript.tsx` from "any bucket" to "visible bucket"**

In `src/views/manuscript.tsx`, import `selectVisibleReview` alongside `selectActiveReview` and change the `hasActiveReview` selector (line 145):

```typescript
  const hasActiveReview = useAppSelector((s) => !!(bookId && (s as any).scriptReview && selectVisibleReview(s as any, bookId)));
```

This is the change that actually fixes the reported bug end to end: the modal now only renders while `visible: true`, and hiding it (via `hideReview`, dispatched on backdrop/X click) no longer removes the bucket data — a subsequent "Review Script" click (Task 11's badge/confirm-gate) can still see and reopen it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/script-review-diff.test.tsx src/views/manuscript.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/script-review-diff.tsx src/views/manuscript.tsx src/components/script-review-diff.test.tsx
git commit -m "fix(frontend): stop the script-review modal from discarding findings on close"
```

---

### Task 13: Apply flow rewrite — per-batch `/resolve` for sync op classes, debounced selection sync

**Files:**
- Modify: `src/components/script-review-diff.tsx`
- Test: `src/components/script-review-diff.test.tsx` (extend)

**Interfaces:**
- Consumes: `api.resolveScriptReviewOps`, `api.patchScriptReviewSelection` (Task 7), `scriptReviewActions.resolveOpsLocally` (Task 6).
- Produces: applying selected ops from a synchronous op class removes exactly those ops from the ledger + local bucket; ops the user left unselected remain (design spec §6.5, the "Apply used to discard everything" behavior change).

- [ ] **Step 1: Write the failing tests**

This codebase's existing render conventions for this component/store shape aren't fully known from this plan alone — adjust the store setup below to match whatever this file's OTHER pre-existing tests already use (real slice reducers vs. fixed-value stubs for `manuscript`/`cast`/`ui`) rather than inventing a second convention. The two tests below are written as real, executable assertions — not stubs — specifically because Round 3's review found a Critical bug (`handleApply`'s tail wiping unselected ops via `clearReview`) that a prose-only test would not have caught:

```typescript
// appended to src/components/script-review-diff.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ScriptReviewDiff } from './script-review-diff';
import { scriptReviewSlice, opKey } from '../store/script-review-slice';
import { api } from '../lib/api';

function makeTestStore(bookId: string) {
  return configureStore({
    reducer: {
      scriptReview: scriptReviewSlice.reducer,
      // Fixed-value stubs — this test never dispatches actions against these
      // slices, it only needs useAppSelector to read a stable shape. Adjust
      // to real reducers if this file's other tests already do that.
      manuscript: (
        state = {
          sentences: [
            { id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' },
            { id: 2, chapterId: 2, characterId: 'c1', text: 'Other.' },
          ],
        },
      ) => state,
      cast: (state = { characters: [{ id: 'c1', name: 'Ada' }] }) => state,
      ui: (state = { stage: { kind: 'ready', bookId }, ttsModelKey: 'kokoro-af_bella' }) => state,
    },
    preloadedState: {
      scriptReview: {
        byBook: {
          [bookId]: {
            ops: [
              { id: 1, chapterId: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' },
              { id: 2, chapterId: 2, op: 'fix_emotion', emotion: 'sad', rationale: 'r' },
            ],
            unappliable: [],
            selected: { [opKey(1, 1, 'strip_tag')]: true, [opKey(2, 2, 'fix_emotion')]: false },
            manuscriptId: 'ms-1',
            versionByChapter: { 1: 5, 2: 7 },
            visible: true,
          },
        },
        activeStreams: {},
      },
    } as never,
  });
}

it('Apply calls resolveScriptReviewOps with exactly the applied ops\' keys, grouped per chapter', async () => {
  vi.mocked(api.resolveScriptReviewOps).mockResolvedValue({ ok: true });
  const store = makeTestStore('book-1');
  render(<Provider store={store}><ScriptReviewDiff bookId="book-1" /></Provider>);

  fireEvent.click(screen.getByTestId('apply-button'));

  await waitFor(() => {
    expect(api.resolveScriptReviewOps).toHaveBeenCalledWith('book-1', {
      chapterId: 1,
      version: 5,
      appliedOpKeys: [opKey(1, 1, 'strip_tag')],
    });
  });
  expect(api.resolveScriptReviewOps).not.toHaveBeenCalledWith('book-1', expect.objectContaining({ chapterId: 2 }));
});

it('unselected ops remain in the bucket after Apply — regression test for the prior discard-everything behavior', async () => {
  vi.mocked(api.resolveScriptReviewOps).mockResolvedValue({ ok: true });
  const store = makeTestStore('book-1');
  render(<Provider store={store}><ScriptReviewDiff bookId="book-1" /></Provider>);

  fireEvent.click(screen.getByTestId('apply-button'));

  await waitFor(() => {
    expect(api.resolveScriptReviewOps).toHaveBeenCalled();
  });
  // The chapter-2 op was left unselected — it must still be in the store,
  // not wiped by a whole-bucket clearReview call.
  const bucket = store.getState().scriptReview.byBook['book-1'];
  expect(bucket?.ops).toEqual([
    expect.objectContaining({ id: 2, chapterId: 2, op: 'fix_emotion' }),
  ]);
});

it('toggling a checkbox schedules a debounced selection PATCH with the chapter\'s version', async () => {
  vi.useFakeTimers();
  // Seed a bucket, toggle one op's checkbox, advance fake timers past the
  // debounce window, assert api.patchScriptReviewSelection was called with
  // that op's chapterId/version and a selected map containing its key.
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/script-review-diff.test.tsx -t "resolveScriptReviewOps|remain in the bucket|debounced selection"`
Expected: FAIL — `handleApply` still calls `clearReview` unconditionally for the no-off-roster case; no PATCH is scheduled on toggle.

- [ ] **Step 3: Rewrite `handleApply`'s no-proposed-ops tail**

In `src/components/script-review-diff.tsx`, import `opKey` (already imported), `api` (already imported for `createCharacter`), and add a helper above the component:

```typescript
async function resolveAppliedOps(
  dispatch: Dispatch,
  bookId: string,
  bucket: { versionByChapter: Record<number, number> },
  appliedOps: ReviewOpWithChapter[],
): Promise<void> {
  const byChapter = new Map<number, string[]>();
  for (const op of appliedOps) {
    const key = opKey(op.chapterId, op.id, op.op);
    byChapter.set(op.chapterId, [...(byChapter.get(op.chapterId) ?? []), key]);
  }
  for (const [chapterId, opKeys] of byChapter) {
    const version = bucket.versionByChapter[chapterId];
    if (version === undefined) continue;
    const result = await api.resolveScriptReviewOps(bookId, { chapterId, version, appliedOpKeys: opKeys });
    if (result.ok) dispatch(scriptReviewActions.resolveOpsLocally({ bookId, opKeys }));
  }
}
```

`handleApply`'s existing structure calls `dispatchAcceptedOps(dispatch, directOps, live, {...})` (line 334-342), then — only if `proposedOps.length === 0` — reaches the final `dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));` at line 349. **`clearReview` deletes the whole bucket** (`script-review-slice.ts:96-98`), not just the applied ops — keeping that call here would silently wipe out any ops the user left unchecked, which is precisely the silent-loss bug this whole plan exists to fix, and would hit on the single most common path (apply a subset, leave the rest for later). It must be replaced, not kept. Separately, a **mixed** batch (some direct ops, some off-roster proposed ops selected together) hits the early `if (proposedOps.length > 0) { setConfirm(...); return; }` at lines 344-347 and skips past that tail entirely — meaning `directOps` never get resolved in a mixed batch either. Fix both by resolving `directOps` **immediately after dispatching them, before the `proposedOps.length > 0` check**, and replacing the tail's whole-bucket delete with `hideReview` — which closes the modal (matching today's close-on-apply feel) without touching any op that `resolveOpsLocally` didn't already remove:

```typescript
    dispatchAcceptedOps(
      dispatch,
      directOps,
      live,
      {
        onBoundaryMove: (chapterId) =>
          dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
      },
    );
    if (bucket && directOps.length > 0) {
      void resolveAppliedOps(dispatch, startBookId, bucket, directOps);
    }

    if (proposedOps.length > 0) {
      setConfirm({ queue: proposedOps, index: 0, finalized: [], startBookId });
      return; // the confirm queue's own cleanup (Task 14) handles this path
    }

    dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
```

This replaces both the existing `dispatchAcceptedOps(...)` call block and everything through the final line. `directOps` are now resolved unconditionally whenever there are any, whether or not the batch also contains off-roster proposed ops. The tail — reached only when `proposedOps.length === 0` — hides the modal but leaves any op `resolveOpsLocally` didn't already remove (i.e. everything the user left unselected) sitting in the bucket, reachable again via the badge/re-run-gate "Review existing" path (Task 11). If every selected op resolves and nothing was left unselected, `resolveOpsLocally`'s own empty-bucket cleanup (Task 6) has already deleted the bucket by the time this line runs — `hideReview` on an already-deleted bucket is a documented no-op (Task 6's reducer guards on `if (bucket)`). Task 14 rewrites the confirm-queue/`runProposed` path's own resolve+cleanup separately, since it can't reuse this same synchronous batch helper (design spec §6.5's per-op timing requirement) — that path already correctly uses `hideReview`, not `clearReview` (see Task 14).

- [ ] **Step 4: Add debounced selection sync**

In the same file, add a ref near the `confirm` state:

```typescript
  const selectionSyncTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  function scheduleSelectionSync(chapterId: number, currentSelected: Record<string, boolean>) {
    clearTimeout(selectionSyncTimers.current[chapterId]);
    selectionSyncTimers.current[chapterId] = setTimeout(() => {
      const version = bucket?.versionByChapter[chapterId];
      if (version === undefined) return;
      const chapterSelected: Record<string, boolean> = {};
      for (const op of ops) {
        if (op.chapterId !== chapterId) continue;
        chapterSelected[opKey(op.chapterId, op.id, op.op)] = !!currentSelected[opKey(op.chapterId, op.id, op.op)];
      }
      void api.patchScriptReviewSelection(bookId, { chapterId, version, selected: chapterSelected });
    }, 500);
  }
```

Wire it into both toggle paths. The per-op checkbox `onChange` (line 506):

```typescript
                            onChange={() => {
                              dispatch(scriptReviewActions.toggleOp({ bookId, key }));
                              scheduleSelectionSync(op.chapterId, { ...selected, [key]: !selected[key] });
                            }}
```

The class "Select all" checkbox `onChange` (line 477-479) — schedule a sync for every distinct chapter among that class's ops:

```typescript
                        onChange={() => {
                          dispatch(scriptReviewActions.toggleClass({ bookId, op: cls as ReviewOpWithChapter['op'] }));
                          const nextSelected = { ...selected };
                          for (const o of classOps) nextSelected[opKey(o.chapterId, o.id, o.op)] = !allClassSelected;
                          for (const chapterId of new Set(classOps.map((o) => o.chapterId))) {
                            scheduleSelectionSync(chapterId, nextSelected);
                          }
                        }}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/script-review-diff.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): resolve applied ops server-side and sync selection state"
```

---

### Task 14: Per-op resolve for the async off-roster `reattribute` path

**Files:**
- Modify: `src/lib/apply-proposed.ts`
- Modify: `src/components/script-review-diff.tsx` (`runProposed`, `cancelConfirm`)
- Test: `src/lib/apply-proposed.test.ts`, `src/components/script-review-diff.test.tsx` (extend both)

**Interfaces:**
- Produces: `ApplyProposedDeps` gains `onOpApplied: (op: ReviewOpWithChapter) => void`, called immediately after **every** successfully-applied op — including a deduped-name op that reuses an existing id and never calls `createCharacter` at all (design spec §6.5's most-dangerous-assumption fix: the round-2 attempt assumed a "create call succeeds" hook, which doesn't exist for this path).

- [ ] **Step 1: Write the failing tests**

```typescript
// appended to src/lib/apply-proposed.test.ts
describe('onOpApplied', () => {
  it('fires for a newly-created character', async () => {
    const onOpApplied = vi.fn();
    const op = { id: 1, chapterId: 3, op: 'reattribute', proposed: { name: 'Nova' }, rationale: 'r' } as never;
    await applyProposedReattributions([op], {
      rosterByName: new Map(),
      createCharacter: async (p) => ({ id: 'c-new', name: p.name }),
      addCharacter: vi.fn(),
      setSentenceCharacter: vi.fn(),
      onBoundaryMove: vi.fn(),
      isSameBook: () => true,
      onOpApplied,
    });
    expect(onOpApplied).toHaveBeenCalledWith(op);
  });

  it('fires for a deduped op that reuses an existing roster id and never calls createCharacter', async () => {
    const onOpApplied = vi.fn();
    const createCharacter = vi.fn();
    const op = { id: 2, chapterId: 3, op: 'reattribute', proposed: { name: 'Existing' }, rationale: 'r' } as never;
    await applyProposedReattributions([op], {
      rosterByName: new Map([['existing', { id: 'c-existing' }]]),
      createCharacter,
      addCharacter: vi.fn(),
      setSentenceCharacter: vi.fn(),
      onBoundaryMove: vi.fn(),
      isSameBook: () => true,
      onOpApplied,
    });
    expect(createCharacter).not.toHaveBeenCalled();
    expect(onOpApplied).toHaveBeenCalledWith(op);
  });

  it('does not fire for ops after a create failure aborts the batch', async () => {
    const onOpApplied = vi.fn();
    const ops = [
      { id: 1, chapterId: 3, op: 'reattribute', proposed: { name: 'Nova' }, rationale: 'r' },
      { id: 2, chapterId: 3, op: 'reattribute', proposed: { name: 'Sol' }, rationale: 'r' },
    ] as never[];
    await expect(
      applyProposedReattributions(ops, {
        rosterByName: new Map(),
        createCharacter: vi.fn().mockRejectedValue(new Error('network')),
        addCharacter: vi.fn(),
        setSentenceCharacter: vi.fn(),
        onBoundaryMove: vi.fn(),
        isSameBook: () => true,
        onOpApplied,
      }),
    ).rejects.toThrow('network');
    expect(onOpApplied).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/apply-proposed.test.ts -t "onOpApplied"`
Expected: FAIL — `onOpApplied` isn't in `ApplyProposedDeps`, never called.

- [ ] **Step 3: Add `onOpApplied` to `applyProposedReattributions`**

In `src/lib/apply-proposed.ts`, add to `ApplyProposedDeps`:

```typescript
export interface ApplyProposedDeps {
  rosterByName: Map<string, { id: string }>;
  createCharacter: (p: { name: string; gender?: string; ageRange?: string }) => Promise<{ id: string; name: string }>;
  addCharacter: (c: { id: string; name: string }) => void;
  setSentenceCharacter: (chapterId: number, sentenceId: number, characterId: string) => void;
  onBoundaryMove: (chapterId: number) => void;
  isSameBook: () => boolean;
  /** Fires immediately after EVERY successfully-applied op, including one
      that reused an existing/memoized id and never called createCharacter
      (design spec §6.5) — lets the caller resolve this op server-side
      one at a time, so a later op's failure never causes an earlier,
      genuinely-applied op to be left unresolved or a not-yet-applied one
      to be resolved by mistake. */
  onOpApplied: (op: ReviewOpWithChapter) => void;
}
```

Add the call inside the loop, right after `deps.onBoundaryMove(op.chapterId);`:

```typescript
    deps.setSentenceCharacter(op.chapterId, op.id, id);
    deps.onBoundaryMove(op.chapterId);
    deps.onOpApplied(op);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/apply-proposed.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `runProposed` to resolve per-op, and cancel/abort to `hideReview`**

In `src/components/script-review-diff.tsx`, update `runProposed`'s call site to pass `onOpApplied`, and handle the silent `aborted` case explicitly (today's code never checks it):

```typescript
  async function runProposed(finalized: FinalizedProposed[], startBookId: string) {
    const rosterByName = new Map(cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id }]));
    try {
      const { createdCharacters, aborted } = await applyProposedReattributions(finalized, {
        rosterByName,
        createCharacter: async (p) => {
          const { character } = await api.createCharacter(startBookId, p as never);
          return character;
        },
        addCharacter: (c) => dispatch(castActions.addCharacter(c as never)),
        setSentenceCharacter: (chapterId, sentenceId, characterId) =>
          dispatch(manuscriptActions.setSentenceCharacter({ chapterId, sentenceId, characterId })),
        onBoundaryMove: (chapterId) =>
          dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
        isSameBook: () => stageBookIdRef.current === startBookId,
        onOpApplied: (op) => {
          if (!bucket) return;
          void resolveAppliedOps(dispatch, startBookId, bucket, [op]);
        },
      });
      if (aborted) {
        // Book-switch guard tripped mid-batch (silent, no throw) — whatever
        // was already resolved via onOpApplied above stays resolved; hide,
        // don't discard the rest (design spec §6.5).
        setConfirm(null);
        dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
        return;
      }
      maybePushVoiceNudge(dispatch, { ttsModelKey, startBookId, createdCharacters });
    } catch {
      setConfirm(null);
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: "Couldn't create character",
          dedupeKey: 'create-character',
        }),
      );
      return;
    }
    setConfirm(null);
    // No clearReview/discard here: every applied op was already resolved
    // per-op via onOpApplied; any op left in the bucket (unselected, or
    // never reached because an earlier op failed) stays, unresolved.
  }
```

Update `cancelConfirm` (lines 301-305) to hide rather than discard:

```typescript
  function cancelConfirm() {
    const startBookId = confirm?.startBookId ?? bookId;
    setConfirm(null);
    dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
  }
```

- [ ] **Step 6: Write and run the component-level regression tests**

Append to `src/components/script-review-diff.test.tsx`:

```typescript
it('a partially-failing off-roster reattribute batch resolves only the ops that succeeded', async () => {
  // Seed a bucket with two off-roster reattribute ops; mock api.createCharacter
  // to succeed for the first proposed name and reject for the second; drive
  // the confirm queue for both; assert api.resolveScriptReviewOps was called
  // once (for the first op's key) and the second op's key is still present
  // in the rendered list after the error toast appears.
});

it('cancelling the confirm queue mid-batch hides rather than discards', async () => {
  // Seed a bucket with an off-roster reattribute op, open the confirm form,
  // click cancel; assert the modal closes (bucket hidden) and
  // api.discardScriptReview was NOT called; reopening (e.g. via the badge)
  // shows the same op still present.
});
```

Run: `npx vitest run src/components/script-review-diff.test.tsx src/lib/apply-proposed.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/apply-proposed.ts src/lib/apply-proposed.test.ts src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "fix(frontend): resolve off-roster reattribute ops per-op instead of discarding the whole batch"
```

---

### Task 15: E2E regression suite

**Files:**
- Create: `e2e/script-review-persistence.spec.ts`

**Interfaces:**
- Consumes: the running app in mock mode (port 5174, per this repo's existing `e2e/` convention) — no new fixtures beyond what `e2e/responsive/*.spec.ts` already establish for viewport control.

**Global Constraint reminder:** this spec must run at a **≥1280px (`xl`) viewport** — the nav tab strip it clicks is `hidden xl:flex` and collapses into a hamburger below that (design spec §8).

- [ ] **Step 1: Write the spec**

```typescript
// e2e/script-review-persistence.spec.ts
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

test.describe('script review persistence', () => {
  test('completing a review, then clicking a nav tab through the backdrop, does not lose the findings', async ({ page }) => {
    await page.goto('/');
    // Navigate into a book's manuscript view (mirror the setup steps used by
    // e2e/responsive/coverage.spec.ts or another existing manuscript-view
    // spec for opening a mock book to the manuscript view).
    await page.getByTestId('review-script-chapter').click();
    // Mock mode's reviewScript resolves quickly with canned ops (see
    // mockReviewScript in src/lib/api.ts) — wait for the modal to appear.
    await expect(page.getByText('Script review suggestions')).toBeVisible();

    // This is the regression: click a nav tab while the modal's backdrop is
    // still up. Before the fix, this fired handleClose -> clearReview and
    // silently deleted the findings.
    await page.getByRole('button', { name: 'Cast' }).click();
    await page.getByRole('button', { name: 'Manuscript' }).click();

    // The findings must still be reachable via the badge, not gone.
    await expect(page.getByTestId('review-script-chapter')).toContainText('(');
  });

  test('reloading mid-review resumes progress without resetting to 0%', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('review-script-wholebook').click();
    await expect(page.getByTestId('review-script-progress')).toBeVisible();
    await page.reload();
    const progressText = await page.getByTestId('review-script-progress-detail').textContent();
    expect(progressText).not.toMatch(/^0%/);
  });

  test('reloading after a completed-but-unactioned review restores findings and the badge', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('review-script-chapter').click();
    await expect(page.getByText('Script review suggestions')).toBeVisible();
    await page.getByTestId('close-button').click(); // hide, not discard
    await page.reload();
    await expect(page.getByTestId('review-script-chapter')).toContainText('(');
  });
});
```

Note: the exact selectors for "navigate to a book's manuscript view" and the nav tab button names (`Cast`/`Manuscript`) should be copied from an existing passing e2e spec in `e2e/` rather than guessed — grep `e2e/` for `getByTestId('review-script-chapter')` or the top-bar nav button test ids used by `e2e/responsive/coverage.spec.ts` before finalizing this step, and adjust the setup boilerplate to match exactly.

- [ ] **Step 2: Run the spec**

Run: `npx playwright test e2e/script-review-persistence.spec.ts --project=chromium`
Expected: PASS, all 3 tests. The first test is the direct regression check for the bug that motivated this whole plan — it must fail against the pre-Task-12 code (backdrop click discards) and pass after.

- [ ] **Step 3: Commit**

```bash
git add e2e/script-review-persistence.spec.ts
git commit -m "test(e2e): add script-review persistence regression suite"
```

---

## Self-Review

This plan went through one full independent review round (the mandatory `assumption-checker` pass) after the first draft. That pass found — and this revision fixed — five concrete defects the first draft's self-review had incorrectly marked as satisfied: a wrong import path for `withKeyLock` (it lives in `server/src/workspace/file-lock.ts`, not `server/src/gpu/load-mutex.ts`); a critical version-delivery gap where the live client had no channel to learn a chapter's ledger `version`, so Apply would silently skip both `/resolve` and the local bucket update in the most common flow (fixed in Task 9 via a new `checkpoint` SSE event, Task 2/3); `attachToRunningReview` never dispatching `setReview` on completion, contradicting design spec §4.3 (fixed in the same Task 9 rewrite); a dropped `model` override in the detached job runner (Task 2, now threaded through `ctx.model`); a duplicate-findings risk in `upsertChapterEntry`'s original merge-without-version-bump behavior (Task 1, now always replaces and bumps); a mixed-batch bug where synchronous ops never resolved if the batch also contained off-roster proposed ops (Task 13, fixed by moving the resolve call before the early-return); and a test-mock strategy in Tasks 8/9 that conflicted with `script-review-thunk.test.ts`'s existing hoisted `vi.mock` (fixed by extending that mock instead of layering a second one). The self-review below reflects the plan *as revised*, not the first draft.

**Spec coverage:**
- §1–2 (bug + gap, goals) → Tasks 2 (sticky), 3 (checkpointing), 12 (hide/discard split). ✓
- §3 (non-goals) → respected throughout: no z-index restructuring, no staleness-logic changes, no cross-tab live sync added. ✓
- §4.1 (job registry, scope-safe, no `fresh:true`, requested-model preserved) → Task 2. ✓
- §4.2 (ledger: raw findings only, `manuscriptId`, book-scoped `version` counter, always-replace upsert, write queue covering all 4 writers, opKey inherited-invariant note) → Task 1 (module), Task 3 (checkpoint wiring + `checkpoint` event broadcast), Task 5 (mutation endpoints). ✓
- §4.3 (reconciliation, no-progress-reset reattach, manuscript+cast ordering, terminal-event `setReview` dispatch) → Tasks 8, 9. ✓
- §5 (API endpoints) → Tasks 4, 5, 7, plus the `onCheckpoint` addition to the existing `reviewScript` endpoint's SSE contract (Task 9). ✓
- §6.1–6.2 (slice split, modal hide/discard) → Tasks 6, 12. ✓
- §6.3 (badge, appliability exclusion) → Task 10. ✓
- §6.4 (click state machine incl. cross-scope conflict) → Task 11. ✓
- §6.5 (Apply's ledger interaction, sync batch vs. async per-op incl. the mixed-batch fix, cancel/abort → hide) → Tasks 13, 14. ✓
- §7 (error handling: corrupted ledger [Task 1's `loadRaw` fallback], stale PATCH, reparse/`manuscriptId` pruning [Task 1], concurrent writes [Task 1's `withKeyLock`, correct import], resolve-fails-after-apply idempotency [Task 14's dedupe-on-retry note]) → covered across Tasks 1, 3, 14. ✓
- §8 (testing plan itemized) → every bullet maps to a task's test step above, plus the version-delivery regression tests added to Task 9. ✓

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" phrasing found; every code step shows real, complete code.

**Type consistency:** `ScriptReviewBucket.versionByChapter: Record<number, number>` is used consistently across every task that actually references it — Tasks 6, 8, 9, 13, 14 (Task 11's code touches `discardReview` and the click state machine, neither of which reads `versionByChapter` directly). `opKey(chapterId, id, op)` matches its existing definition in `script-review-slice.ts:29-31` everywhere it's called. `LedgerEntry`/`LedgerFile` (Task 1) match the shapes consumed by Task 4's `GET /state` and Task 7's `LedgerEntryDTO`. `withKeyLock`'s import path (`./file-lock.js` from within `server/src/workspace/`) is correct everywhere it appears (Global Constraints, File Structure, Task 1). Task 9's `RunningReviewState` type is deliberately narrower than Task 4's full `GET /state` running response — it declares only `replay.lastPhase`, the one field `attachToRunningReview` actually reads, so a future edit can't silently reintroduce ops/version double-counting by reading `opsEvents`/`checkpointEvents` through this type.

**Three review rounds, the last of which found a real Critical bug all three rounds had otherwise missed:** round 1 fixed six issues (wrong `withKeyLock` path, the version-delivery gap, `attachToRunningReview` not dispatching `setReview`, a dropped `model` override, a duplicate-findings risk in `upsertChapterEntry`, a mixed-batch resolve bug, plus a test-mock conflict). Round 2, verifying those fixes, found round 1's version-delivery fix had introduced a NEW critical bug — `attachToRunningReview` double-counting ops by both seeding from the `GET /state` snapshot and separately joining the live replay — fixed by relying solely on the join's own replay, plus a missed test-mock fix in Task 11 and two stale-doc spots. Round 3, reading the whole plan fresh rather than just the diffed sections, found the actually-most-consequential defect: Task 13's `handleApply` still called the old whole-bucket-deleting `clearReview` on its tail, which would have silently wiped every unselected finding on the single most common Apply flow — directly contradicting design spec §6.5 and this plan's own stated purpose. That's now fixed (`clearReview` → `hideReview`, only closing the modal without touching surviving ops), and the two regression tests that should have caught it (Task 13's "Apply calls resolveScriptReviewOps..." and "unselected ops remain...") were rewritten from prose stubs into real, executable assertions against a real component render — round 3 explicitly flagged that prose-stub tests can't do TDD's job of catching exactly this class of defect.

One known gap, called out explicitly rather than silently: Task 9's `attachToRunningReview` and `runReviewScript` are unit-tested against a mocked `api.reviewScript`/`onCheckpoint` callback, not a real SSE stream — the actual server-to-client `checkpoint` event wire format (Task 3's `send()` → Task 9's `realReviewScript` SSE parser) is only exercised end-to-end by Task 15's e2e specs, since a generic fetch-stream mock would test the mock rather than the real join-or-create wiring and event serialization. Task 12's and 14's remaining tests are still written as prose descriptions rather than executable code, consistent with this plan's practice elsewhere for lower-risk assertions — Task 13's were promoted to real code specifically because round 3 showed prose stubs let a Critical defect through undetected on this particular flow.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-09-script-review-persistence.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
