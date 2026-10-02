---
status: active
shipped: null
owner: null
---

# 285 — revisions.json becomes server-owned: per-operation writes (PR 1, server, dark) (#3400, #3397)

> Status: active. PR 1 of 2 (server, dark). PR 2 (client cutover) gets its own plan revision after PR 1 merges.
> Key files:
> - `server/src/workspace/revisions-store.ts` (new — the only reader/writer of revisions.json)
> - `server/src/audio/previous-audio.ts` (new — today's A/B audio steps, moved unchanged)
> - `server/src/routes/revision-ops.ts` (new — accept / reject / dismiss)
> - `server/src/routes/review-request.ts` (new — the shared `review` validator)
> - `server/src/routes/revisions.ts`, `server/src/routes/chapter-audio.ts`, `server/src/routes/book-state.ts`,
>   `server/src/routes/generation.ts`, `server/src/routes/queue.ts`, `server/src/workspace/queue-io.ts`,
>   `server/src/audio/finalize-chapter-write.ts`, `server/src/routes/chapter-splice.ts`,
>   `server/src/routes/chapter-qa-repair.ts`, `server/src/app.ts`
> - `openapi.yaml`, `src/lib/api-types.ts` (generated), `src/lib/api.ts`, `src/lib/types.ts`,
>   `src/store/queue-thunks.ts`, `src/store/generation-stream-runner.ts`, `src/store/queue-dispatcher-middleware.ts`
> URL surface: none (no UI change in PR 1).
> OpenAPI ops: `POST /api/books/{bookId}/revisions/{revisionId}/accept`, `POST /api/books/{bookId}/revisions/{revisionId}/reject`,
> `POST /api/books/{bookId}/drift/{driftId}/dismiss`; reshaped `GET /api/books/{bookId}/revisions`, `GET /api/revisions`.

## Benefit / Rationale

- **User:** none visible in PR 1 (dark). PR 2 builds on it to fix #3397 (a Fix-audio prompt stuck or lost when the user leaves the book) and #3400 (stale client state erasing revisions.json).
- **Technical:** revisions.json gets one owner with a per-book lock, a `fileId`/`rev` version stamp, and read-time normalisation. Accept and reject become one server request each, and the JSON is written only after the audio step succeeds (D1). `pending` is returned even when the cast is empty (D8).
- **Architectural:** a leaf lock class (`revisions:<abs bookDir>`) is added outside the `design → library-voice → cast` order. The A/B audio steps move into `audio/previous-audio.ts` with no import of `routes/generation.ts`. Finalize gains a tri-state `review` seam that PR 2 switches on.

## Architectural impact

- **New seams:** `revisions-store.ts` (store API below), `previous-audio.ts` (`acceptPreviousAudio` / `restorePreviousAudio` / `findPreviousChapterAudio`), `FinalizeChapterAudioInput.review` + `FinalizeChapterAudioResult.reviewRecorded`, `review` on the queue entry and the generation request, `reviewChapter` / `reviewRecorded` on the SSE completion events.
- **Invariants preserved:** cast-lock rules 1–4 (the revisions lock is a leaf: nothing else is acquired while it is held, and nothing but revisions.json is written under it); OpenAPI stays the type source (`npm run openapi:types`); every field added to an existing schema is optional, so PR 1's mocks still typecheck.
- **Migration:** revisions.json gains `schema: 1`, `fileId`, `rev`. Legacy files are normalised on read and never rewritten by a read. The first store write mints `fileId` and sets `rev: 1`. Reparse and replace now **reset** the file (new `fileId`, `rev: 0`) instead of deleting it.
- **Reversibility:** revert the PR. PR 1 changes nothing an old client depends on except reparse/replace resetting instead of deleting, which the old client reads the same way (an empty file hydrates like a missing one).

## Invariants to preserve

1. **Between PR 1 and PR 2 the client is the only writer of `pending`.** Every finalize caller passes no `review` (asserted in `generation.test.ts`, `chapter-splice.test.ts`, `chapter-qa-repair.test.ts`), the new routes have no client caller, and the reparse/replace reset leaves `pending: []`, which is what the old delete produced.
2. The revisions lock key is `revisions:${path.resolve(bookDir)}`, built only by `revisionsLockKey` in `server/src/workspace/revisions-store.ts`.
3. Under that lock only revisions.json is written, and no other lock is acquired. The only other filesystem access is the read-only `.previous.mp3` existence probe used by normalisation.
4. Reads (`readRevisions`) take no lock and never write.
5. The old routes `DELETE …/audio/previous` and `POST …/audio/previous/restore` keep today's status codes and order: the `isGenerationActive` 409 comes **before** the chapter-id parse.
6. `audio/previous-audio.ts` does not import `routes/generation.ts`. `routes/generation.ts` gains no new import from `audio/` or `workspace/`.
7. `PUT /state` with `slice:'revisions'` is still accepted, and `GET /state` returns revisions.json **raw**.
8. No store error text reaches an SSE body. Finalize surfaces a store failure only as `reviewRecorded: false`.

## Test plan

### Automated coverage

- Vitest server `server/src/workspace/revisions-store.test.ts`: normalisation, `fileId`/`rev`, upsert/drop, accept/reject two-phase rules, idempotence, `revision_gone`, reset during an op, lock-key normalisation, lock serialisation in both orders, and `selection` validation.
- Vitest server `server/src/audio/previous-audio.test.ts`: the moved audio steps, including today's delete-then-rename residual.
- Vitest server `server/src/routes/chapter-audio.test.ts`: the existing old-route tests, unchanged, plus "invalid chapter during generation → 409".
- Vitest server `server/src/routes/revision-ops.test.ts`: every status code in the spec's table, the curated 500 on a lock timeout, the restore-failed → `live_audio_missing` → retried-reject recovery, and a concurrent double accept.
- Vitest server `server/src/routes/revisions.test.ts` and `qa-report.test.ts`: the new poll shape, pending with an empty cast (D8), and qa-report unaffected.
- Vitest frontend `src/lib/api-types.revisions-contract.test.ts`: the compile-time OpenAPI contract, enforced by `npm run typecheck`.
- Vitest server `server/src/audio/finalize-chapter-write.test.ts`: the `review` tri-state, keyed on `preserved`; store-call placement; a store failure → `reviewRecorded: false` with no leak.
- Vitest server `generation.test.ts`, `chapter-splice.test.ts`, `chapter-qa-repair.test.ts`: callers pass no `review`, and `reviewRecorded` is threaded onto the completion events.
- Vitest server `server/src/routes/review-request.test.ts`, `queue.test.ts`, `server/src/workspace/queue-io.test.ts`, and `generation.test.ts`: `review` validation, the enqueue → GET → claim round trip, a 400 before SSE, and `reviewChapter` only on the rendered chapter.
- Vitest frontend `src/lib/api-stream-review.test.ts`, `src/store/queue-dispatcher-middleware.test.ts`, `src/mocks/mock-queue.test.ts`: the client carries `review` from the entry into the POST body.
- Vitest server `book-state.reparse.test.ts`, `book-state.replace-manuscript.test.ts`: reparse and replace reset to a new `fileId` and never delete.
- No Playwright spec: PR 1 has no UI-visible behaviour. PR 2 owns the e2e.

### Manual acceptance walkthrough

None for PR 1. It is dark, and no UI path reaches the new code. PR 2 owes the on-box register row: splice → switch books → prompt appears; accept → `.previous` gone; re-splice → reject → original returns; reject during generation → 409 with pending unchanged.

## Out of scope

All of PR 2:
- callers passing `review` / `null`;
- the restructure pending drop;
- `restore-unrecorded`;
- normalised `GET /state`;
- `PUT slice:'revisions'` → 400;
- old routes → 410;
- every client change in spec §4.

Also out of scope: the chapter-take lifecycle (#3456) and the fsck m4a/ogg fix (#3457).

## Ship notes

(Filled in when PR 2 ships.)

---

# revisions.json server-ownership — PR 1 (server, dark) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the server half of spec rev 9: a locked revisions.json store, the extracted A/B audio steps, the accept/reject/dismiss routes, the finalize `review` seam, `review` plumbing through the queue and the generation request, and the reparse reset. All of it ships dark. The client remains the only writer of `pending`.

**Architecture:** `workspace/revisions-store.ts` owns revisions.json behind a leaf `withKeyLock`. Accept and reject are two-phase. Phase one reads the entry under the lock. The audio step (today's code, moved into `audio/previous-audio.ts`) then runs outside the lock. Phase two re-reads under the lock and writes only if the entry is still there. Finalize gets a tri-state `review` that every caller leaves `undefined` in PR 1. `review` travels on the persisted queue entry into the generation request, where it is validated and stamped `reviewChapter`. Nothing consumes it yet.

**Tech Stack:** Node 20 + Express + TypeScript (server), Vitest 5 + supertest, OpenAPI 3.0.3 + openapi-typescript 7, React/RTK (client type plumbing only).

**Spec:** `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md` (rev 9). Read §"Compatibility and the two PRs" first. This plan implements **PR 1 only**.

## Global Constraints

- **PR 1 is dark. Invariant: between PR 1 and PR 2 the client is the only writer of `pending`.** Every task states how it keeps this.
- Every finalize caller passes `review: undefined`, meaning the `review` key is absent from the call. Restructure's pending drop is **not** wired. `PUT /state` with `slice:'revisions'` is still accepted. `GET /state` returns revisions.json **raw**.
- The old routes call the extracted audio functions with **today's status codes and order**: the `isGenerationActive` 409 comes before the chapter-id parse, a bad chapter id is 404, and a restore throw is 500 `'Failed to restore previous audio.'`.
- The revisions lock is a **leaf**: key `revisions:${path.resolve(bookDir)}`, built only inside the store. While it is held, nothing else is acquired and no file other than revisions.json is written.
- `audio/previous-audio.ts` must not import `routes/generation.ts`. `routes/generation.ts` gains **no new import from `audio/` or `workspace/`**; its only new import is `./review-request.js`.
- `npm run check:cycles` must stay clean.
- **Every field added to an existing OpenAPI schema is optional.** `RevisionsState` is a new schema and is fully required.
- No store error text in any SSE body or 4xx body. Whole-request 500s go through `requestFailureMessage` (`server/src/workspace/file-lock.ts:214`).
- Commit subjects use `<type>(<scope>): <subject>` and stay at or under 100 characters. Scopes: frontend|server|sidecar|app|scripts|e2e|mocks|openapi|docs|deps|ci|ops. Multi-scope is comma-separated with no spaces.
- Never use `--no-verify`. Commit and push in the foreground. The coordinator owns the commit. The implementer stages exactly the listed files and reports.
- No `server/tts-sidecar/**` changes.
- Run only targeted tests per task. Run tests and typechecks with `npm --prefix`. Never use a `cd … &&` compound, because the Bash permission hook blocks it:
  - server: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- <path relative to server/>`
  - frontend: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test -- <path relative to repo root>`
  - typecheck (frontend + server): `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`
- Full batteries run only in Task 8.
- Work only in `C:\Claude\Projects\wt-3400-revisions-server-ops` (branch `fix/server-3400-revisions-server-ops`). Never touch `C:\Claude\Projects\Audiobook-Generator`.
- Every task ends with a **mutation check**: revert the named line, run the named test, and paste the observed red output into the report. Then restore the line and confirm green.

## Review Focus

1. **A corrupt revisions.json** (truncated JSON) should read as empty, and the next write replaces it. A **transient read error** (EBUSY/EISDIR) must fail the op loudly, not wipe the file. Pinned in Task 1.
2. **`revisionId` of `__proto__` / `constructor`** in the URL: expect a 404, no prototype pollution, and nothing written. Pinned in Tasks 1 and 3.
3. **A double-click on Approve** (two concurrent accepts for one id): expect both 200 and exactly one `accepted` timeline entry. Pinned in Task 3.
4. **Accept when neither live nor `.previous` audio exists:** expect it to proceed and clear the entry, with no `live_audio_missing`. Pinned in Task 3.
5. **The same bookDir spelled two ways** (`…/book` and `…/book/audio/..`): expect one lock and no lost update. Pinned in Task 1.

---

### Task 1: The revisions store

**Files:**
- Create: `server/src/workspace/revisions-store.ts`
- Test: `server/src/workspace/revisions-store.test.ts`

**Dark-state note:** the module is created but has no production caller in this task.

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` (`./state-io.js`); `revisionsJsonPath`, `audioDir` (`./paths.js`); `withKeyLock` (`./file-lock.js`); `hasPreviousAudio(audioRoot, slug): boolean` (`./preserve-previous-audio.js`).
- Produces (later tasks rely on these exact names):
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
  export type RevisionOpKind = 'accept' | 'reject';
  export type BeginResult =
    | { kind: 'proceed'; entry: StoredRevision; chapter: ChapterRef; file: RevisionsFile }
    | { kind: 'already-done'; file: RevisionsFile }
    | { kind: 'not-found'; file: RevisionsFile };
  export type CommitResult =
    | { kind: 'committed'; file: RevisionsFile }
    | { kind: 'already-done'; file: RevisionsFile }
    | { kind: 'gone'; file: RevisionsFile };
  export function revisionsLockKey(bookDir: string): string;
  export function mintFileId(nowMs?: number, suffix?: string): string;
  export function emptyRevisionsFile(fileId?: string | null): RevisionsFile;
  export function normaliseRevisions(raw: unknown, previousExists: (chapterId: number) => boolean): RevisionsFile;
  export function toRevisionsState(bookId: string, file: RevisionsFile): RevisionsState;
  export function parseSelection(raw: unknown): { ok: true; value: Selection | undefined } | { ok: false; message: string };
  export async function readRevisions(bookDir: string, chapters: readonly ChapterRef[]): Promise<RevisionsFile>;
  export async function resetRevisions(bookDir: string): Promise<RevisionsFile>;
  export async function recordPending(bookDir: string, chapters: readonly ChapterRef[], entry: StoredRevision): Promise<RevisionsFile>;
  export async function dropPendingForChapter(bookDir: string, chapters: readonly ChapterRef[], chapterId: number): Promise<RevisionsFile>;
  export async function dismissDriftId(bookDir: string, chapters: readonly ChapterRef[], driftId: string): Promise<RevisionsFile>;
  export async function beginRevisionOp(bookDir: string, chapters: readonly ChapterRef[], op: RevisionOpKind, revisionId: string): Promise<BeginResult>;
  export async function commitRevisionOp(bookDir: string, chapters: readonly ChapterRef[], op: RevisionOpKind, revisionId: string, selection?: Selection): Promise<CommitResult>;
  ```

- [ ] **Step 1: Write the failing test file** `server/src/workspace/revisions-store.test.ts`

```ts
/* Plan 285 Task 1 — the revisions.json store (spec §1). Pure store against a
   tempdir; no routes. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRevisions,
  resetRevisions,
  recordPending,
  dropPendingForChapter,
  dismissDriftId,
  beginRevisionOp,
  commitRevisionOp,
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

  it('reads a corrupt (unparseable) file as empty', async () => {
    writeFileSync(revisionsJsonPath(bookDir), '{"pending": [');
    expect(await readRevisions(bookDir, CHAPTERS)).toEqual(EMPTY);
  });

  it('propagates a non-parse read failure instead of reading it as empty (a write would wipe the file)', async () => {
    mkdirSync(revisionsJsonPath(bookDir)); // a directory where the file should be → EISDIR
    await expect(readRevisions(bookDir, CHAPTERS)).rejects.toThrow();
    await expect(recordPending(bookDir, CHAPTERS, serverEntry(1))).rejects.toThrow();
  });
});

describe('fileId / rev', () => {
  it('mints `${15-digit zero-padded epoch}-${random}`', () => {
    expect(mintFileId(1234, 'abcd1234')).toBe('000000000001234-abcd1234');
    expect(mintFileId()).toMatch(/^\d{15}-[0-9a-f]{8}$/);
  });

  it('mints a fileId on the first write to a legacy file and bumps rev on every write', async () => {
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
    const list = commit.file.timeline['1'];
    expect(list.map((t) => [t.id, t.eventKind, t.reversible])).toEqual([
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

  it('unknown and prototype-polluting ids are not-found and write nothing', async () => {
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

describe('lock', () => {
  it('normalises the key: two spellings of one bookDir share one lock', () => {
    expect(revisionsLockKey(join(bookDir, 'audio', '..'))).toBe(revisionsLockKey(bookDir));
    expect(revisionsLockKey(bookDir).startsWith('revisions:')).toBe(true);
  });

  it('concurrent writes through two spellings lose no update', async () => {
    await Promise.all([
      recordPending(bookDir, CHAPTERS, serverEntry(1, 'r1')),
      recordPending(join(bookDir, 'audio', '..'), CHAPTERS, serverEntry(2, 'r2')),
    ]);
    const file = await readRevisions(bookDir, CHAPTERS);
    expect(file.pending.map((p) => p.id).sort()).toEqual(['r1', 'r2']);
    expect(file.rev).toBe(2);
  });

  it('accept racing recordPending — commit queued first: committed, then the new entry lands', async () => {
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

  it('accept racing recordPending — upsert queued first: gone, and the new entry survives', async () => {
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

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/workspace/revisions-store.test.ts`
Expected: FAIL. The suite cannot load, with `Failed to load url ./revisions-store.js` or `Cannot find module`.

- [ ] **Step 3: Write the implementation** `server/src/workspace/revisions-store.ts`

```ts
/* Plan 285 (#3400) — the ONLY reader/writer of `<bookDir>/.audiobook/revisions.json`.
   Modelled on script-review-ledger.ts.

   LOCK. Every write runs under withKeyLock(revisionsLockKey(bookDir)). The key is
   `revisions:${path.resolve(bookDir)}`, normalised HERE so two callers that spell
   bookDir differently can never split the lock. The read, and every decision
   derived from it, happens inside the lock.

   LEAF LOCK. Nothing acquires any other lock while holding this one, and no file
   other than revisions.json is WRITTEN under it. (Normalisation probes
   `audio/<slug>.previous.mp3` for existence — a read-only stat, no lock, no
   write.) See the lock-order comment in cast-lock.ts.

   READS (readRevisions) take no lock: writeJsonAtomic renames atomically, so a
   reader always sees one whole version, and the GET handlers can never hit a
   lock timeout.

   ACCEPT / REJECT are two-phase (spec §2): beginRevisionOp (step 1, under the
   lock) → the caller's audio step (step 2, OUTSIDE the lock) → commitRevisionOp
   (step 3, under the lock, re-reads and writes only if the entry is still there).

   PR 1 IS DARK: no production code calls the write ops except resetRevisions
   (reparse / replace). The client remains the only writer of `pending`. */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './state-io.js';
import { audioDir, revisionsJsonPath } from './paths.js';
import { withKeyLock } from './file-lock.js';
import { hasPreviousAudio as previousAudioExists } from './preserve-previous-audio.js';

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

export type RevisionOpKind = 'accept' | 'reject';

export type BeginResult =
  | { kind: 'proceed'; entry: StoredRevision; chapter: ChapterRef; file: RevisionsFile }
  | { kind: 'already-done'; file: RevisionsFile }
  | { kind: 'not-found'; file: RevisionsFile };

export type CommitResult =
  | { kind: 'committed'; file: RevisionsFile }
  | { kind: 'already-done'; file: RevisionsFile }
  | { kind: 'gone'; file: RevisionsFile };

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

async function loadRaw(bookDir: string): Promise<unknown> {
  try {
    return await readJson<unknown>(revisionsJsonPath(bookDir));
  } catch (err) {
    /* A corrupt file reads as empty (the next write replaces it). Any OTHER
       read failure (EBUSY, EISDIR, EACCES…) propagates: reading it as empty
       would let the next write wipe a file that is merely unreadable now. */
    if (err instanceof SyntaxError) {
      console.warn(`[revisions-store] ${revisionsJsonPath(bookDir)} is not valid JSON; reading it as empty`);
      return null;
    }
    throw err;
  }
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

async function save(bookDir: string, file: RevisionsFile): Promise<RevisionsFile> {
  const next: RevisionsFile = { ...file, schema: 1, fileId: file.fileId ?? mintFileId(), rev: file.rev + 1 };
  await writeJsonAtomic(revisionsJsonPath(bookDir), next);
  return next;
}

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

export async function readRevisions(bookDir: string, chapters: readonly ChapterRef[]): Promise<RevisionsFile> {
  return load(bookDir, chapters);
}

export async function resetRevisions(bookDir: string): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const next = emptyRevisionsFile(mintFileId());
    await writeJsonAtomic(revisionsJsonPath(bookDir), next);
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/workspace/revisions-store.test.ts`
Expected: PASS, every test in the file green.

- [ ] **Step 5: Typecheck the server**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 6: Mutation checks** (report the observed red output for each; restore after each)

  1. In `revisionsLockKey`, replace `resolve(bookDir)` with `bookDir`. Run the Step 4 command. Expected: red on `normalises the key: two spellings of one bookDir share one lock`, with an `expected … to be …` diff of two different paths.
  2. In `normaliseRevisions`, delete the line `if (!previousExists(e.chapterId)) continue;`. Run Step 4. Expected: red on `drops drift, playable:false legacy entries…`, because the pending array gains the `b` entry, and on `treats a legacy entry with no playable flag…`.
  3. In `commitRevisionOp`, change the not-found branch to fall through and save anyway: replace `{ kind: 'gone', file }` with `{ kind: 'gone', file: await save(bookDir, file) }`. Run Step 4. Expected: red on `a reset while an op waits…`, because the on-disk `rev` is 1 instead of 0.
  4. In `loadRaw`, replace `if (err instanceof SyntaxError) {` with `if (true) {`. Run Step 4. Expected: red on `propagates a non-parse read failure…`, because the promise resolves instead of rejecting.

- [ ] **Step 7: Commit** (the coordinator runs this; the implementer stages and reports)

```bash
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/workspace/revisions-store.ts server/src/workspace/revisions-store.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server): add revisions.json store with a per-book leaf lock (#3400)"
```

---

### Task 2: Extract the A/B audio steps into `audio/previous-audio.ts`

**Files:**
- Create: `server/src/audio/previous-audio.ts`
- Create: `server/src/audio/previous-audio.test.ts`
- Modify: `server/src/routes/chapter-audio.ts:31-41` (imports), `:215`, `:232-237` (remove `findPreviousChapterAudio`), `:329`, `:374-441` (the DELETE and restore bodies)
- Test: `server/src/routes/chapter-audio.test.ts` (existing tests unchanged; one new test)

**Dark-state note:** the old routes still answer exactly as today. No revisions.json write is added.

**Interfaces:**
- Consumes: `renameWithRetry` (`../workspace/atomic-rename.js`); `findChapterAudio`, `ChapterAudioFile` (`../workspace/chapter-audio-file.js`).
- Produces:
  ```ts
  export function findPreviousChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null;
  export async function acceptPreviousAudio(audioRoot: string, slug: string): Promise<'deleted' | 'none'>;
  export async function restorePreviousAudio(audioRoot: string, slug: string): Promise<'restored' | 'none'>; // throws on a failed audio rename (today's 500)
  ```

- [ ] **Step 1: Write the failing unit test** `server/src/audio/previous-audio.test.ts`

```ts
/* Plan 285 Task 2 — the A/B audio steps, moved unchanged from
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

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/previous-audio.test.ts`
Expected: FAIL, with `Failed to load url ./previous-audio.js`.

- [ ] **Step 3: Create `server/src/audio/previous-audio.ts`** (bodies moved verbatim from `chapter-audio.ts:233-237`, `:389-393`, `:420-439`)

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

- [ ] **Step 5: Add the new old-route test** to `server/src/routes/chapter-audio.test.ts`. Place it inside `describe('POST /audio/previous/restore (reject)', …)`, directly after the existing `it('409s when a generation is in flight for the book', …)`:

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

- [ ] **Step 6: Run the chapter-audio suite** (it should pass already; this test pins today's order before the refactor)

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-audio.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 7: Refactor `server/src/routes/chapter-audio.ts` onto the new module**

  1. Imports: add `import { acceptPreviousAudio, restorePreviousAudio, findPreviousChapterAudio } from '../audio/previous-audio.js';`. Remove `import { unlink } from 'node:fs/promises';` and `import { renameWithRetry } from '../workspace/atomic-rename.js';`. Change `import { findChapterAudio, type ChapterAudioFile } from '../workspace/chapter-audio-file.js';` to `import { findChapterAudio } from '../workspace/chapter-audio-file.js';`, but only if `ChapterAudioFile` is no longer referenced. Typecheck tells you. Keep `existsSync` and `join`, which are still used by the peaks, lufs, and locate helpers.
  2. Delete the local `findPreviousChapterAudio` (lines 232-237, including its doc comment). The two GET call sites (`:215`, `:329`) now resolve to the import, with no other change.
  3. Replace the DELETE body after the chapter lookup (`:387-394`) with:
     ```ts
         const root = audioDir(located.bookDir);
         const outcome = await acceptPreviousAudio(root, chapter.slug);
         if (outcome === 'none') return res.status(404).json({ message: 'No preserved previous audio.' });
         res.status(204).end();
     ```
  4. Replace the restore body after the chapter lookup (`:416-440`) with the following. Leave the `isGenerationActive` block at `:403-409` exactly where it is, ABOVE the parse:
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
Expected: PASS. The existing tests are unchanged.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 9: Mutation check.** In `chapter-audio.ts`'s restore route, move the `if (isGenerationActive(req.params.bookId)) { … }` block so it sits after the `if (!chapter) return res.status(404)…` line. Run `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-audio.test.ts`. Expected red: `409s (not 404) for an INVALID chapter id…` with `expected 404 to be 409`. Restore the block and confirm green.

- [ ] **Step 10: Commit** (coordinator)

```bash
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/audio/previous-audio.ts server/src/audio/previous-audio.test.ts server/src/routes/chapter-audio.ts server/src/routes/chapter-audio.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "refactor(server): extract previous-take audio steps into audio/previous-audio.ts (#3400)"
```

---

### Task 3: Accept / reject / dismiss routes and the poll shape

**Files:**
- Create: `server/src/routes/revision-ops.ts`
- Create: `server/src/routes/revision-ops.test.ts`
- Modify: `server/src/app.ts:64` (import), `:312` (mount)
- Modify: `server/src/routes/revisions.ts:1-14` (header comment), `:18-19` (imports), `:34-43` (delete `RevisionsPersisted`), `:112-216` (`getRevisionsForBook` / `computeRevisionsForBook`), `:251-254` (bulk map)
- Modify: `server/src/routes/revisions.test.ts:167-183` and the `persisted pending echo` describe (`:537-583`)
- Modify: `server/src/routes/qa-report.test.ts` (one new test)
- Modify: `CLAUDE.md:629-632` (the `requestFailureMessage` count)

**Dark-state note:** the new routes have no client caller in PR 1. The poll's new fields are ignored by the old client, whose `applyPoll` reads only `drift` (`revisions-slice.ts:318-322`), and its bulk poll reads only `drift`. No write reaches revisions.json from a poll.

**Interfaces:**
- Consumes: Task 1's `beginRevisionOp`, `commitRevisionOp`, `dismissDriftId`, `readRevisions`, `parseSelection`, `toRevisionsState`, `ChapterRef`, `RevisionsState`, `StoredRevision`; Task 2's `acceptPreviousAudio`, `restorePreviousAudio`, `findPreviousChapterAudio`; `isGenerationActive` (`./generation.js`); `requestFailureMessage` (`../workspace/file-lock.js`).
- Produces:
  ```ts
  export const revisionOpsRouter: Router; // mounted at /api/books
  // routes/revisions.ts
  export type RevisionsPoll = RevisionsState & { drift: DriftEvent[] };
  export async function computeRevisionsForBook(bookId: string, bookDir: string, state: BookStateJson): Promise<RevisionsPoll>;
  export async function getRevisionsForBook(bookId: string): Promise<RevisionsPoll | null>;
  ```
  Error body for every coded failure: `{ error: <code>, message: string, state?: RevisionsState }`. Codes: `invalid_selection` 400, `book_not_found` 404, `revision_not_found` 404, `chapter_busy` 409, `no_previous_audio` 409, `live_audio_missing` 409, `revision_gone` 409, and `restore_failed` 500. Any other 500 is `{ error: requestFailureMessage(e, …) }`.

- [ ] **Step 1: Write the failing route test** `server/src/routes/revision-ops.test.ts`

```ts
/* Plan 285 Task 3 — accept / reject / dismiss (spec §2). Tempdir workspace +
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

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revision-ops.test.ts`
Expected: FAIL, with `Failed to load url ./revision-ops.js`.

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
       code itself is unchanged. */
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

- [ ] **Step 5: Mount the router** in `server/src/app.ts`. After line 64 (`import { revisionsRouter, revisionsBulkRouter } from './routes/revisions.js';`) add:

```ts
import { revisionOpsRouter } from './routes/revision-ops.js';
```

After line 312 (`app.use('/api', revisionsBulkRouter); …`) add:

```ts
app.use('/api/books', revisionOpsRouter); // plan 285 — server-owned accept / reject / dismiss (no client caller until PR 2)
```

- [ ] **Step 6: Write the failing poll tests in `server/src/routes/revisions.test.ts`**

  1. Add this helper after the `DriftEventOut`/`CharacterSnapshot` interfaces:
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
  2. In `returns empty pending + drift when there is no cast yet` and `returns empty drift when no segments files exist`, replace `expect(res.body).toEqual({ pending: [], drift: [] });` with `expect(res.body).toEqual(emptyPoll());`.
  3. Replace the whole `describe('GET /api/books/:bookId/revisions — persisted pending echo (#3376 part 1)', …)` block (`:537-583`) with:
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
         seed({ snapshots: { eliza: { voiceId: 'v1' } }, cast: [{ id: 'eliza', voiceId: 'v1' }] });
         writeFileSync(revisionsPath(), JSON.stringify({ pending: 'garbage' }));
         const res = await request(app).get(`/api/books/${bookId}/revisions`);
         expect(res.status).toBe(200);
         expect(res.body.pending).toEqual([]);
         expect(res.body.drift).toEqual([]);
       });

       it('bulk GET /api/revisions answers exactly { pending, drift } per book', async () => {
         writeFileSync(revisionsPath(), JSON.stringify({ schema: 1, fileId: 'f-1', rev: 2, pending: [serverEntry] }));
         const res = await request(app).get(`/api/revisions?bookIds=${bookId}`);
         expect(res.status).toBe(200);
         expect(res.body.byBookId[bookId]).toEqual({ pending: [serverEntry], drift: [] });
       });
     });
     ```
  4. Add to `server/src/routes/qa-report.test.ts`, inside `describe('GET /api/books/:bookId/qa-report', …)`. Import `rmSync` from `node:fs` if it is not already imported; `writeFileSync` already is:
     ```ts
       it('plan 285 — a pending revision does not leak into the qa-report body', async () => {
         const p = join(bookDir, '.audiobook', 'revisions.json');
         writeFileSync(
           p,
           JSON.stringify({
             schema: 1,
             fileId: 'f-1',
             rev: 1,
             pending: [
               { id: 'revision:1:1', chapterId: 1, characterId: 'n', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' },
             ],
           }),
         );
         const res = await request(app).get(`/api/books/${bookId}/qa-report`);
         rmSync(p, { force: true });
         expect(res.status).toBe(200);
         expect(res.body).not.toHaveProperty('pending');
         expect(res.body.configDrift).toEqual({ counts: { mild: 0, moderate: 0, severe: 0 }, events: [] });
       });
     ```

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revisions.test.ts src/routes/qa-report.test.ts`
Expected: FAIL in `revisions.test.ts`, on the `emptyPoll()` equality and on `returns pending even when the cast is EMPTY (D8)`. The `qa-report` test passes.

- [ ] **Step 7: Reshape `computeRevisionsForBook`** in `server/src/routes/revisions.ts`

  1. Replace the header comment (lines 1-14) with:
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
        dropped). The single-book poll answers the whole RevisionsState plus
        live `drift`, and returns `pending` even when the cast is empty (D8). The
        drift detector never creates pending — the user still chooses. */
     ```
  2. Imports: change `import { castJsonPath, revisionsJsonPath } from '../workspace/paths.js';` to `import { castJsonPath } from '../workspace/paths.js';`. Add `import { readRevisions, toRevisionsState, type RevisionsState, type StoredRevision } from '../workspace/revisions-store.js';`. Keep `readJson`, which the cast read still uses.
  3. Delete `interface RevisionsPersisted { … }` (lines 34-43).
  4. Add above `getRevisionsForBook`:
     ```ts
     /** Plan 285 — the single-book poll's shape: the store's RevisionsState plus live drift. */
     export type RevisionsPoll = RevisionsState & { drift: DriftEvent[] };
     ```
  5. Change `getRevisionsForBook`'s return type to `Promise<RevisionsPoll | null>`.
  6. Replace the head of `computeRevisionsForBook`, from its signature through the `const pending = …` line (`:125-153`), with:
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
       const castIdHistory = await loadCastIdHistory(bookDir);
       const castResolver = buildCastResolver(cast, castIdHistory);
       const dismissed = new Set(file.dismissed);
     ```
     Keep the existing `#2040` comment blocks above `loadCastIdHistory`/`buildCastResolver` verbatim.
  7. Replace the final `return { pending, drift: filtered };` with `return { ...base, drift: filtered };`.
  8. In the bulk route, replace
     ```ts
         const byBookId: Record<string, { pending: unknown[]; drift: DriftEvent[] }> = {};
         for (const [id, result] of entries) {
           if (result) byBookId[id] = result;
         }
     ```
     with
     ```ts
         const byBookId: Record<string, { pending: StoredRevision[]; drift: DriftEvent[] }> = {};
         for (const [id, result] of entries) {
           if (result) byBookId[id] = { pending: result.pending, drift: result.drift };
         }
     ```

- [ ] **Step 8: Run the poll + qa-report + route suites and typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/revisions.test.ts src/routes/qa-report.test.ts src/routes/revision-ops.test.ts`
Expected: PASS.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 9: Update the CLAUDE.md count.** First verify the count:

Run: `git -C C:/Claude/Projects/wt-3400-revisions-server-ops grep -n "requestFailureMessage(" -- "server/src/**/*.ts" ":!*.test.ts"`
Expected: 18 lines. That is the definition in `file-lock.ts` plus **17** call sites: book-state ×4, cast-design ×2, qwen-voice, revision-ops ×3, script-review, single-design, voice-library ×3, voice-style, voices.

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

- [ ] **Step 10: Mutation checks** (report the red output; restore after each)

  1. In `revision-ops.ts`, delete the whole `if (!findChapterAudio(…) && findPreviousChapterAudio(…)) { … }` block. Run `…run test -- src/routes/revision-ops.test.ts`. Expected red: `409 live_audio_missing when live is gone but .previous exists` (`expected 200 to be 409`) and `restore throws → 500 restore_failed; accept then refuses…`.
  2. In `revision-ops.ts`'s accept catch, replace `requestFailureMessage(e, (e as Error).message || 'Failed to accept revision.')` with `(e as Error).message`. Run the same file. Expected red: `a lock timeout answers the curated 500…`, with the body containing `SECRET-WORKSPACE`.
  3. In `revisions.ts`, change the empty-cast branch back to `return { ...base, pending: [], drift: [] };`. Run `…run test -- src/routes/revisions.test.ts`. Expected red: `returns pending even when the cast is EMPTY (D8)`.

- [ ] **Step 11: Commit** (coordinator)

```bash
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/revision-ops.ts server/src/routes/revision-ops.test.ts server/src/app.ts server/src/routes/revisions.ts server/src/routes/revisions.test.ts server/src/routes/qa-report.test.ts CLAUDE.md
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server,docs): add revision accept/reject/dismiss routes; poll reads through the store (#3400)"
```

---

### Task 4: OpenAPI for the PR-1 surface + generated types

**Files:**
- Modify: `openapi.yaml` at:
  - the generation request body (`:1772-1786`);
  - the splice inline schema (`:1850-1858`);
  - the qa-repair inline schema (`:1934-1954`);
  - a new block after the `/api/books/{bookId}/revisions:` path (`:2817-2829`);
  - the bulk description (`:2833-2838`);
  - `GenerationTick` (`:5691`);
  - `QueueEntry` (`~:5956`) and `QueueEnqueueEntry` (`~:6043`);
  - `RevisionsResponse` / `BulkRevisionsResponse` (`:6763-6793`);
  - `Revision` (`:6840`);
  - `BookStateResponse.revisions` (`:8004-8020`).
- Regenerate: `src/lib/api-types.ts` (`npm run openapi:types`)
- Modify: `src/lib/api.ts:646-672` (`SpliceTick`, `QaRepairTick` completion arms), `src/lib/types.ts:79-80` (export `ReviewRequest`)
- Create: `src/lib/api-types.revisions-contract.test.ts`

**Dark-state note:** this is a types-only change. No runtime code reads the new fields in PR 1.

**Interfaces:**
- Produces:
  - `components['schemas']['RevisionsState']`;
  - `components['schemas']['RevisionOpError']`;
  - `components['schemas']['ReviewRequest']`;
  - `export type ReviewRequest = components['schemas']['ReviewRequest']` in `src/lib/types.ts`;
  - optional `reviewChapter`/`reviewRecorded` on `GenerationTick`;
  - optional `review` on `QueueEntry` and `QueueEnqueueEntry`;
  - optional `reviewRecorded` on `SpliceTick`'s and `QaRepairTick`'s completion arms.

- [ ] **Step 1: Write the failing contract test** `src/lib/api-types.revisions-contract.test.ts`

```ts
/* Plan 285 Task 4 — the PR-1 revisions contract, pinned against the GENERATED
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
Expected: FAIL in `src/lib/api-types.revisions-contract.test.ts`. The errors include `Property 'RevisionsState' does not exist`, `Module '"./types"' has no exported member 'ReviewRequest'`, and `Property 'reviewRecorded' does not exist`.

- [ ] **Step 3: Edit `openapi.yaml`**

  (a) The generation request body: after the `force:` property (`:1784-1786`), add:
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
  Then add a `'400'` response under `responses:` for this path, next to `'200'`:
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

  (b) The splice inline schema (`:1856`, after `hasPreviousAudio: { type: boolean }`) and the qa-repair inline schema (`:1952`, after `hasPreviousAudio: { type: boolean }`) each get:
  ```yaml
                  reviewRecorded:
                    type: boolean
                    description: Plan 285 — on the completion frame only when finalize was asked to record A/B review state; false when that record failed (the new take is still live).
  ```

  (c) After the `/api/books/{bookId}/revisions:` path block (ending `:2829`), insert:
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
  Indent to match the sibling path blocks: two spaces before `/api/...`.

  (d) The bulk route description (`:2833-2838`): append the sentence `Plan 285 — each value carries exactly \`pending\` (read through the server store, normalised) and \`drift\`.`

  (e) `GenerationTick`: add these alongside the other optional properties, after `audioQa`:
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

  (f) `QueueEntry` and `QueueEnqueueEntry`: after each `fallbackConfirmed:` property block, add:
  ```yaml
        review:
          allOf:
            - $ref: '#/components/schemas/ReviewRequest'
          description: Plan 285 — the A/B review intent carried from enqueue to the generation request. Not set by the client until PR 2.
  ```

  (g) `RevisionsResponse`: after `timeline`, add:
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

  (h) `Revision`: after `hasPreviousAudio`, add:
  ```yaml
        origin:
          type: string
          enum: [server]
          description: Plan 285 — present on entries the server recorded; absent on legacy client-written ones.
  ```

  (i) After `Revision`, add three new component schemas:
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

  (j) `BookStateResponse.revisions` (`:8004-8020`): after `acceptedSelections`, add:
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

- [ ] **Step 4: Regenerate the types**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run openapi:types`
Expected: exit 0.
Then run `git -C C:/Claude/Projects/wt-3400-revisions-server-ops diff --stat src/lib/api-types.ts`. The diff should be additions only, plus the edited description strings. If the generator reformatted unrelated regions, stop and report.

- [ ] **Step 5: Hand-written types**

  1. `src/lib/types.ts`: after line 80 (`export type BulkRevisionsResponse = …`), add:
     ```ts
     /** Plan 285 — the A/B review intent a queue entry / generation request carries. */
     export type ReviewRequest = components['schemas']['ReviewRequest'];
     ```
  2. `src/lib/api.ts`, in the `splice_complete` arm of `SpliceTick` (`:663-671`), add after `hasPreviousAudio: boolean;`:
     ```ts
           /** Plan 285 — present only when finalize recorded (or failed to record) A/B review state. */
           reviewRecorded?: boolean;
     ```
  3. `src/lib/api.ts`, in the `qa_repair_complete` arm of `QaRepairTick`: add the same `reviewRecorded?: boolean;` member with the same comment.

- [ ] **Step 6: Typecheck and run the contract test**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`
Expected: exit 0. This also proves PR 1's partial mocks (`api.ts:1042`, `:1962-1973`) still compile.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test -- src/lib/api-types.revisions-contract.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation check.** In `openapi.yaml`, delete the `reviewRecorded:` property you added to `GenerationTick`. Re-run `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run openapi:types`, then `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`. Expected red: a TS error in `api-types.revisions-contract.test.ts` on the `GenerationTick['reviewRecorded']` assertion. Restore the property, regenerate, and confirm green.

- [ ] **Step 8: Commit** (coordinator)

```bash
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add openapi.yaml src/lib/api-types.ts src/lib/api.ts src/lib/types.ts src/lib/api-types.revisions-contract.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(openapi,frontend): describe server-owned revisions routes and review fields (#3400)"
```

---

### Task 5: Finalize `review` tri-state + `reviewRecorded` on the three completion events

**Files:**
- Modify: `server/src/audio/finalize-chapter-write.ts`:
  - the imports (`:14-46`);
  - `FinalizeChapterAudioInput` (`:77-109`);
  - `FinalizeChapterAudioResult` (`:111-122`);
  - `:359`, where the preserve result is kept;
  - after `:399`, where the store call goes;
  - the return (`:401-407`).
- Modify: `server/src/routes/chapter-splice.ts:513-521`, `server/src/routes/chapter-qa-repair.ts:802-813`, `server/src/routes/generation.ts:1857-1861` (destructure) and `:2030-2054` (broadcast)
- Test: `server/src/audio/finalize-chapter-write.test.ts`, `server/src/routes/chapter-splice.test.ts`, `server/src/routes/chapter-qa-repair.test.ts`, `server/src/routes/generation.test.ts`

**Dark-state note:** no caller passes `review`, so finalize never touches revisions.json in PR 1. That keeps the client the only writer of `pending`. The new spy tests assert the absence at all three call sites.

**Interfaces:**
- Consumes: Task 1's `recordPending`, `dropPendingForChapter`, `ChapterRef`; `formatDuration` (already imported).
- Produces:
  ```ts
  // FinalizeChapterAudioInput
  review?: { characterId: string; triggeredBy: string } | null;
  // FinalizeChapterAudioResult
  reviewRecorded?: boolean; // absent when review is undefined; true on a successful record/drop; false on a store failure
  ```
  The completion events `splice_complete`, `qa_repair_complete` (dryRun:false), and live `chapter_complete` carry `reviewRecorded` only when the result has it.

- [ ] **Step 1: Write the failing finalize tests.** Append to `server/src/audio/finalize-chapter-write.test.ts`:

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
    expect(result).not.toHaveProperty('reviewRecorded');
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
    expect(seen).toEqual({ duration: formatDuration(1.0), audioExists: true });
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

Add `import { formatDuration } from './format-duration.js';` to the file's imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/finalize-chapter-write.test.ts`
Expected: FAIL. TypeScript-in-vitest raises no error here, so the failure is runtime: `object + preserved` (`expected undefined to be true`) and the other review cases fail. The `undefined` case passes.

- [ ] **Step 3: Implement in `server/src/audio/finalize-chapter-write.ts`**

  1. Add the import: `import { recordPending, dropPendingForChapter, type ChapterRef } from '../workspace/revisions-store.js';`
  2. In `FinalizeChapterAudioInput`, after `embeddings?: EmbeddingRow[];`, add:
     ```ts
       /** Plan 285 (#3400) — the A/B review intent for this render.
           `undefined` (PR 1: every caller) — leave revisions.json alone.
           `null` — a plain render: drop the chapter's pending entry (its A side was just overwritten).
           object — a review render: upsert the chapter's single entry iff
           preserveExistingAsPrevious actually preserved; otherwise (a first
           render) drop any entry. Best-effort: never fails the render. */
       review?: { characterId: string; triggeredBy: string } | null;
     ```
  3. In `FinalizeChapterAudioResult`, after `audioEngines`, add:
     ```ts
       /** Plan 285 — absent when `review` was undefined; true when the record/drop
           landed; false when it failed (logged in full; the new take is live). */
       reviewRecorded?: boolean;
     ```
  4. At `:359`, change `await preserveExistingAsPrevious(audioRoot, chapter.slug);` to `const preserve = await preserveExistingAsPrevious(audioRoot, chapter.slug);`.
  5. Replace the final `return { … };` (`:401-407`) with:
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

     /** Plan 285 — best-effort with respect to the render. Errors are logged in
         full and surface ONLY as `false`: no store text (whose lock key embeds
         the absolute workspace path) may reach an SSE body. */
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
     ```
     The previous function's closing brace now closes `applyReview`. Make sure there is exactly one closing `}` at the end of the file.

- [ ] **Step 4: Run the finalize suite**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/finalize-chapter-write.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing caller tests.** These assert that no caller passes `review`, and that `reviewRecorded` is threaded onto each completion event.

  (a) `server/src/routes/chapter-splice.test.ts`: add this top-level mock next to the other `vi.mock` calls:
  ```ts
  /* Plan 285 — passthrough spy so a test can (1) assert the splice caller
     passes NO `review` in PR 1 and (2) force `reviewRecorded:false` to prove it
     reaches splice_complete. */
  vi.mock('../audio/finalize-chapter-write.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../audio/finalize-chapter-write.js')>();
    return { ...real, finalizeChapterAudioWrite: vi.fn(real.finalizeChapterAudioWrite) };
  });
  ```
  Then add, inside `describe('POST /:bookId/chapters/:chapterId/splice (remix)', …)`:
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
      expect(spy.mock.calls[0][0]).not.toHaveProperty('review');
      const done = parseSse(res.text).find((e) => e.type === 'splice_complete');
      expect(done, `expected splice_complete, got ${res.text}`).toBeTruthy();
      expect(done!.reviewRecorded).toBe(false);
    });

    it('plan 285 — splice_complete carries no reviewRecorded when finalize returns none', async () => {
      const res = await request(app)
        .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
        .send({ mode: 'remix', characterId: 'castor', gainDb: 3 });
      const done = parseSse(res.text).find((e) => e.type === 'splice_complete');
      expect(done).toBeTruthy();
      expect(done).not.toHaveProperty('reviewRecorded');
    });
  ```

  (b) `server/src/routes/chapter-qa-repair.test.ts`: add the same top-level `vi.mock('../audio/finalize-chapter-write.js', …)` block. Then add, inside `describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (fs-51 verdict persistence)', …)`, after the `writes the accepted take verdict…` test:
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
      expect(spy.mock.calls[0][0]).not.toHaveProperty('review');
      const done = parseSse(res.text).find((e) => e.type === 'qa_repair_complete');
      expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();
      expect(done!.reviewRecorded).toBe(false);
    });
  ```

  (c) `server/src/routes/generation.test.ts`: add the same top-level `vi.mock('../audio/finalize-chapter-write.js', …)` block next to the existing `vi.mock` calls. Then append at the end of the file:
  ```ts
  describe('plan 285 — finalize review plumbing (PR 1 dark)', () => {
    afterEach(async () => {
      const fs = await import('node:fs');
      const audioRoot = join(bookDir, 'audio');
      if (fs.existsSync(audioRoot)) fs.rmSync(audioRoot, { recursive: true, force: true });
    });

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
      expect(spy.mock.calls[0][0]).not.toHaveProperty('review');
      const done = parseTicks(res.text).find((t) => t.type === 'chapter_complete' && t.chapterId === 1);
      expect(done, `expected chapter_complete ch1, got ${res.text}`).toBeTruthy();
      expect(done!.reviewRecorded).toBe(false);
    });

    it('chapter_complete carries no reviewRecorded when finalize returns none', async () => {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      const done = parseTicks(res.text).find((t) => t.type === 'chapter_complete' && t.chapterId === 1);
      expect(done).toBeTruthy();
      expect(done).not.toHaveProperty('reviewRecorded');
    });
  });
  ```

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts src/routes/generation.test.ts`
Expected: FAIL on the three `threads reviewRecorded…` tests, with `expected undefined to be false`. Everything else passes, including the pre-existing tests under the passthrough mock.

- [ ] **Step 6: Thread `reviewRecorded`**

  1. `chapter-splice.ts`, in the `splice_complete` send (`:513-521`): after `hasPreviousAudio: true,`, add:
     ```ts
             /* Plan 285 — present only when finalize was asked to record review state. */
             ...(result.reviewRecorded === undefined ? {} : { reviewRecorded: result.reviewRecorded }),
     ```
  2. `chapter-qa-repair.ts`, in the `dryRun: false` `qa_repair_complete` send (`:802-813`): add the same spread after `hasPreviousAudio: true,`. Do **not** touch the dry-run send at `:268`.
  3. `generation.ts`: extend the destructure at `:1857-1861` to `const { audioQa, audioModelKey: renderedModelKey, audioEngines, reviewRecorded } = await finalizeChapterAudioWrite({`. Then, in the live `chapter_complete` broadcast (`:2031`), after `audioQa,`, add:
     ```ts
             /* Plan 285 — present only when finalize was asked to record review state. */
             ...(reviewRecorded === undefined ? {} : { reviewRecorded }),
     ```
     Do not touch the replay loop at `:1176-1194`.

- [ ] **Step 7: Run all four suites + typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/audio/finalize-chapter-write.test.ts src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts src/routes/generation.test.ts`
Expected: PASS.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 8: Mutation checks** (report the red output; restore after each)

  1. In `finalize-chapter-write.ts`, move the `const reviewRecorded = await applyReview(…)` line up to directly after `await rename(tmpAudio, audioPath);`. The `return` still uses the variable. Run the finalize suite. Expected red: `runs the store call AFTER the audio rename and the state.json write`, with the captured duration `'0:00'` instead of `'00:01'`.
  2. In `applyReview`, change `if (input.review !== null && preserved)` to `if (input.review !== null)`. Run the finalize suite. Expected red: `object + first render (nothing preserved)…`, because the pending list has 1 entry instead of being `[]`.
  3. In `chapter-splice.ts`, delete the `reviewRecorded` spread. Run `…run test -- src/routes/chapter-splice.test.ts`. Expected red: `…threads reviewRecorded onto splice_complete`, with `expected undefined to be false`.
  4. In `chapter-splice.ts`, add `review: null,` to the `finalizeChapterAudioWrite({…})` argument. Run the same file. Expected red: `…passes no \`review\` to finalize (PR 1 dark)…`, with `expected {…} not to have property "review"`.

- [ ] **Step 9: Commit** (coordinator)

```bash
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/audio/finalize-chapter-write.ts server/src/audio/finalize-chapter-write.test.ts server/src/routes/chapter-splice.ts server/src/routes/chapter-splice.test.ts server/src/routes/chapter-qa-repair.ts server/src/routes/chapter-qa-repair.test.ts server/src/routes/generation.ts server/src/routes/generation.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server): add finalize review tri-state and reviewRecorded on completion events (#3400)"
```

---

### Task 6: `review` plumbing through the queue and the generation request

**Files:**
- Create: `server/src/routes/review-request.ts`, `server/src/routes/review-request.test.ts`
- Modify: `server/src/routes/queue.ts`: the `EnqueueRequestEntry` interface (`:77-84`) and the whitelist (`:105-117`)
- Modify: `server/src/workspace/queue-io.ts`: `QueueEntry` (`:36-89`), `EnqueueInput` (`:97-117`), and `enqueue()` (`:122-139`)
- Modify: `server/src/routes/generation.ts`:
  - imports;
  - `RunningJob` (`:364-433`);
  - the fake-job literal (`:576-590`);
  - `GenerationRequestBody` (`:699-714`);
  - the handler head (`:716-725`);
  - the job literal (`:1282-1295`);
  - the live `chapter_complete` broadcast (`:2031`).
- Modify (client): `src/store/queue-thunks.ts:41-57` (`EnqueueInput`), `src/store/generation-stream-runner.ts:46-61` (`StreamOpenOpts`) and `:315-321` (the `api.streamGeneration` call), `src/lib/api.ts:599-644` (`StreamArgs`) and `:5865-5904` (`realStreamGeneration`), `src/store/queue-dispatcher-middleware.ts:266-280` (`runner.open` opts)
- Test: `server/src/routes/queue.test.ts`, `server/src/workspace/queue-io.test.ts`, `server/src/routes/generation.test.ts`, `src/lib/api-stream-review.test.ts` (new), `src/store/queue-dispatcher-middleware.test.ts`, `src/mocks/mock-queue.test.ts` (new)

**Dark-state note:** nothing in the client sets `review` in PR 1. The enqueue sites at `layout.tsx:2074-2083` are untouched. A generation job that receives `review` stamps `reviewChapter` but still calls finalize with no `review`, and the test below asserts it. So `pending` stays client-only.

**Interfaces:**
- Consumes: Task 4's `ReviewRequest` (`src/lib/types.ts`) and the regenerated `QueueEntry.review`; Task 5's finalize spy in `generation.test.ts`.
- Produces:
  ```ts
  // server/src/routes/review-request.ts
  export interface ReviewRequest { characterId: string; triggeredBy: string }
  export const INVALID_REVIEW: 'invalid';
  export function parseReviewRequest(raw: unknown): ReviewRequest | undefined | typeof INVALID_REVIEW;
  // queue-io.ts: QueueEntry.review?, EnqueueInput.review?  ({ characterId: string; triggeredBy: string })
  // generation.ts: RunningJob.review: ReviewRequest | null
  // client: EnqueueInput.review?, StreamOpenOpts.review?, StreamArgs.review?  (ReviewRequest)
  ```

- [ ] **Step 1: Write the failing server tests**

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
      for (const bad of [true, 'amy', [], {}, { characterId: '' , triggeredBy: 't' }, { characterId: 'a' }, { characterId: 'a', triggeredBy: 3 }]) {
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
  (d) `server/src/routes/generation.test.ts`, inside the `describe('plan 285 — finalize review plumbing (PR 1 dark)', …)` block from Task 5:
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
      expect(spy.mock.calls[0][0]).not.toHaveProperty('review');
    });

    it('no reviewChapter without review', async () => {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      const ch1 = parseTicks(res.text).find((t) => t.type === 'chapter_complete' && t.chapterId === 1);
      expect(ch1).toBeTruthy();
      expect(ch1).not.toHaveProperty('reviewChapter');
    });
  ```

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/review-request.test.ts src/workspace/queue-io.test.ts src/routes/queue.test.ts src/routes/generation.test.ts`
Expected: FAIL. `review-request.js` cannot be loaded; `review` is undefined on the queue entries; the generation 400 test sees `expected 200 to be 400`; `ch1.reviewChapter` is undefined.

- [ ] **Step 2: Implement the server side**

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
  2. `queue-io.ts`: add to `QueueEntry` (after `parkedAt?`) and to `EnqueueInput` (after `fallbackConfirmed?`):
     ```ts
       /* Plan 285 — the A/B review intent, carried from enqueue to the generation
          request. Mirrored in openapi.yaml's QueueEntry. Not set by the client until PR 2. */
       review?: { characterId: string; triggeredBy: string };
     ```
     In `enqueue()`'s `fresh.push({…})`, after the `fallbackConfirmed` spread, add `...(input.review ? { review: input.review } : {}),`.
  3. `queue.ts`: add `import { parseReviewRequest, INVALID_REVIEW } from './review-request.js';` and add `review?: unknown;` to `EnqueueRequestEntry`. Inside the `for (const r of raw)` loop, before `inputs.push(`, add:
     ```ts
         const review = parseReviewRequest(r.review);
         if (review === INVALID_REVIEW) {
           return res.status(400).json({ error: `entry "${r.id}": review must be { characterId, triggeredBy }` });
         }
     ```
     Then add `...(review ? { review } : {}),` after the `fallbackConfirmed` spread in the pushed object.
  4. `generation.ts`:
     - Import: `import { parseReviewRequest, INVALID_REVIEW, type ReviewRequest } from './review-request.js';`
     - `RunningJob`: after `fallbackConfirmed: boolean;`, add:
       ```ts
         /** Plan 285 — the request's A/B review intent (null when absent). Stamps
             `reviewChapter: true` on THIS job's live chapter_complete. Not yet passed
             to finalize (PR 2). */
         review: ReviewRequest | null;
       ```
     - In both `RunningJob` literals (`:576` fake job, `:1282` real job), add `review: null,` and `review,` respectively, after `fallbackConfirmed`.
     - `GenerationRequestBody`: add `review?: unknown;` with a one-line comment `/** Plan 285 — see ReviewRequest. */`.
     - Handler head: directly after `const body = (req.body ?? {}) as GenerationRequestBody;` and **above** `res.setHeader('Content-Type', 'text/event-stream');`, add:
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
     - In the live `chapter_complete` broadcast (`:2031`), next to the `reviewRecorded` spread from Task 5, add:
       ```ts
               /* Plan 285 — only the chapter actually rendered with `review`; the
                  replay loop above never carries it. */
               ...(job.review !== null && job.chapterId === chapter.id ? { reviewChapter: true } : {}),
       ```

- [ ] **Step 3: Run the server suites + typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/review-request.test.ts src/workspace/queue-io.test.ts src/routes/queue.test.ts src/routes/generation.test.ts`
Expected: PASS.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 4: Write the failing client tests**

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
  (b) `src/store/queue-dispatcher-middleware.test.ts`, inside `describe('loud-fallback gate', …)`, directly after `it('threads fallbackConfirmed into the stream open for a confirmed entry', …)`:
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
  /* Plan 285 — the mock queue carries `review` through enqueue, like the real server. */
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
Expected: FAIL. The POST body has no `review`, and the dispatcher's `byBook('book-A')?.review` is undefined. `mock-queue.test.ts` already PASSES, because the mock spreads `...inp`, so this test pins the behaviour.

- [ ] **Step 5: Implement the client plumbing**

  1. `src/store/queue-thunks.ts`: import `ReviewRequest` (`import type { TtsModelKey, ReviewRequest } from '../lib/types';`). Add to `EnqueueInput`, after `fallbackConfirmed?`:
     ```ts
       /** Plan 285 — the A/B review intent; rides the persisted entry into the
           generation request. Nothing sets it until PR 2. */
       review?: ReviewRequest;
     ```
  2. `src/lib/api.ts`: add `review?: ReviewRequest;` to `StreamArgs` after `fallbackConfirmed?`, with the comment `/** Plan 285 — single-chapter A/B review intent; forwarded in the POST body. */`. Add `ReviewRequest` to the file's existing `from './types'` type import. In `realStreamGeneration`, add `review,` to the destructured args after `fallbackConfirmed,`, and add `...(review ? { review } : {}),` to the `JSON.stringify({…})` body after the `fallbackConfirmed` spread.
  3. `src/store/generation-stream-runner.ts`: add to `StreamOpenOpts`, after `fallbackConfirmed?`:
     ```ts
       /** Plan 285 — the entry's A/B review intent, forwarded to the server. */
       review?: ReviewRequest;
     ```
     (`import type { ReviewRequest } from '../lib/types';`). In the `api.streamGeneration({…})` call (`:315-321`), add `...(opts.review ? { review: opts.review } : {}),` after the `fallbackConfirmed` spread.
  4. `src/store/queue-dispatcher-middleware.ts`: in the `runner.open(…)` opts object (`:270-279`), after the `fallbackConfirmed` spread, add:
     ```ts
               /* Plan 285 — carry the entry's A/B review intent to the server. */
               ...(e.review ? { review: e.review } : {}),
     ```

- [ ] **Step 6: Run the client tests + full typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test -- src/lib/api-stream-review.test.ts src/store/queue-dispatcher-middleware.test.ts src/mocks/mock-queue.test.ts src/lib/api-stream-fallback-confirmed.test.ts`
Expected: PASS.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck`
Expected: exit 0.

- [ ] **Step 7: Mutation checks** (report the red output; restore after each)

  1. `generation.ts`: inside the replay loop's `send({ type: 'chapter_complete', … })` (`:1179-1191`), add `...(review ? { reviewChapter: true } : {}),`. Run `…server run test -- src/routes/generation.test.ts`. Expected red: `reviewChapter:true only on the chapter rendered with review — never a replay…`, with `expected {…} not to have property "reviewChapter"`.
  2. `generation.ts`: delete the `review_requires_single_chapter` `if` block. Run the same file. Expected red: `400 before any SSE header…`, with `expected 200 to be 400`.
  3. `queue-io.ts`: delete `...(input.review ? { review: input.review } : {}),`. Run `…server run test -- src/routes/queue.test.ts src/workspace/queue-io.test.ts`. Expected red: both review round-trip tests, with `expected undefined to deeply equal {…}`.
  4. `queue-dispatcher-middleware.ts`: delete the `review` spread. Run `…run test -- src/store/queue-dispatcher-middleware.test.ts`. Expected red: `plan 285 — threads an entry review into the stream open…`.

- [ ] **Step 8: Commit** (coordinator)

```bash
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/review-request.ts server/src/routes/review-request.test.ts server/src/routes/queue.ts server/src/routes/queue.test.ts server/src/workspace/queue-io.ts server/src/workspace/queue-io.test.ts server/src/routes/generation.ts server/src/routes/generation.test.ts src/store/queue-thunks.ts src/lib/api.ts src/store/generation-stream-runner.ts src/store/queue-dispatcher-middleware.ts src/lib/api-stream-review.test.ts src/store/queue-dispatcher-middleware.test.ts src/mocks/mock-queue.test.ts
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "feat(server,frontend): carry review from queue entry to generation request (dark) (#3400)"
```

---

### Task 7: Reparse/replace reset through the store + lock-order docs + INDEX

**Why reset lives here and not in Task 5 (as the brief suggested):** Task 5 already spans finalize and three route test files. The reset is a separate `book-state.ts` change with its own two test files. It also pairs naturally with the leaf-lock documentation, because the reparse is the one place the revisions lock sits beside a `withCastLock`.

**Files:**
- Modify: `server/src/routes/book-state.ts`: the imports, the `applyReparse` Promise.all arm (`:1199-1203`), and the sibling-arm comment (`:1141-1150`)
- Modify: `server/src/routes/book-state.reparse.test.ts:964-986` (the corrupt-cast test) plus a new test; `server/src/routes/book-state.replace-manuscript.test.ts` (a new test)
- Modify: `server/src/workspace/cast-lock.ts:19-24` (rule 4), `CLAUDE.md:582-584` (rule 4), `docs/features/INDEX.md` (`### G. Generation`)

**Dark-state note:** a reset leaves `pending: []`, which is exactly what today's `rm` produced as far as any client can see. An empty file reads like a missing one (`revisions.ts`; `layout.tsx:915` spreads the payload). The client is still the only writer of `pending`.

**Interfaces:**
- Consumes: Task 1's `resetRevisions(bookDir): Promise<RevisionsFile>`.

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
  Add `readFileSync` to the file's `node:fs` import if it is missing.

  (b) In `book-state.reparse.test.ts`, inside `describe('reparse handler — preserves manuscript-edits.json', …)`, add:
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
  ```
  (c) In `book-state.replace-manuscript.test.ts`, inside `describe('replace-manuscript handler', …)`, add the same test, renamed `plan 285 — replace resets revisions.json to a NEW fileId and never deletes it`. Its request is:
  ```ts
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
  ```
  Use `const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');` and import `readFileSync` if missing. The seeded entry's `characterId` can be `'wren'`.

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/book-state.reparse.test.ts src/routes/book-state.replace-manuscript.test.ts`
Expected: FAIL. The three new or changed tests fail with `ENOENT … revisions.json` or `expected false to be true`, because the file was deleted.

- [ ] **Step 2: Implement the reset** in `server/src/routes/book-state.ts`

  1. Add the import `import { resetRevisions } from '../workspace/revisions-store.js';`.
  2. Replace the revisions arm
     ```ts
         existsSync(revisionsJsonPath(bookDir))
           ? rm(revisionsJsonPath(bookDir), { force: true })
           : Promise.resolve(),
     ```
     with
     ```ts
         /* Plan 285 — RESET (new fileId, rev 0) through the store under its own
            leaf lock, never delete: a deleted file would read back fileId:null,
            which the PR 2 client cache treats as "older than any id". This arm
            sits BESIDE the withCastLock arm, never inside it. */
         resetRevisions(bookDir),
     ```
  3. In the comment block above `withCastLock(bookDir, async () => {`, replace the sentence
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
  4. `revisionsJsonPath` and `existsSync` are still used elsewhere in the file, at `:285`, `:790`, and the audio arm. Do not remove those imports. Run typecheck to confirm nothing became orphaned.

- [ ] **Step 3: Run the suites + typecheck**

Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run test -- src/routes/book-state.reparse.test.ts src/routes/book-state.replace-manuscript.test.ts src/routes/book-state.test.ts src/routes/book-state.hydrate.test.ts`
Expected: PASS.
Run: `npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops/server run typecheck`
Expected: exit 0.

- [ ] **Step 4: Lock-order docs**

  1. `server/src/workspace/cast-lock.ts`: directly after rule 4's last line (` *      timeout.`, line 24), insert:
     ```ts
      *      The per-book REVISIONS lock (`revisions:<abs bookDir>`,
      *      revisions-store.ts, plan 285) is a LEAF outside this order: its holder
      *      writes only revisions.json and acquires no other lock, so it can never
      *      be one half of a cycle. Never take any lock while holding it.
     ```
  2. `CLAUDE.md`: replace
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
  3. `docs/features/INDEX.md`: add this entry at the end of the `### G. Generation` list:
     ```
     - [285 — revisions.json becomes server-owned (PR 1, server, dark)](285-revisions-server-ops.md) — `active`. A locked `workspace/revisions-store.ts` becomes the only reader/writer of revisions.json (`fileId`/`rev`, read-time normalisation, reparse/replace reset instead of delete); accept/reject/dismiss become one server route each, running today's audio step (moved to `audio/previous-audio.ts`) before the JSON write; finalize gains a tri-state `review` and `review` rides the queue entry into the generation request — all dark until PR 2 cuts the client over. Fixes D1/D8 server-side; #3397/#3400 close with PR 2. Spec: `docs/superpowers/specs/2026-10-01-revisions-server-ops-design.md`.
     ```

- [ ] **Step 5: Release notes — explicitly none.** PR 1 is dark and has no shippable delta, so do not edit `docs/release-notes-next.md` or `RELEASE_NOTES.md`. The PR body must say: "Release notes: none — dark server change, no user- or operator-visible effect (PR 2 carries the notes)."

- [ ] **Step 6: Mutation check.** In `book-state.ts`, put back the original `existsSync(revisionsJsonPath(bookDir)) ? rm(…) : Promise.resolve(),` arm in place of `resetRevisions(bookDir),`. Run `…server run test -- src/routes/book-state.reparse.test.ts`. Expected red: `plan 285 — resets revisions.json to a NEW fileId and never deletes it`, with `expected false to be true`. Restore and confirm green.

- [ ] **Step 7: Commit** (coordinator)

```bash
git -C C:/Claude/Projects/wt-3400-revisions-server-ops add server/src/routes/book-state.ts server/src/routes/book-state.reparse.test.ts server/src/routes/book-state.replace-manuscript.test.ts server/src/workspace/cast-lock.ts CLAUDE.md docs/features/INDEX.md
git -C C:/Claude/Projects/wt-3400-revisions-server-ops commit -m "fix(server,docs): reset revisions.json through the store on reparse/replace (#3400)"
```

---

### Task 8: Verification (the verify child)

**Files:** none modified. If any step below fails, report it and do not fix inline. The coordinator dispatches a fix.

- [ ] **Step 1: Confirm the worktree is idle and clean.** Run `git -C C:/Claude/Projects/wt-3400-revisions-server-ops status --porcelain`. Expected: empty after the Task 7 commit. Run `git -C C:/Claude/Projects/Audiobook-Generator status --porcelain`. Expected: no entry produced by this run.

- [ ] **Step 2: Full batteries** (run each in the foreground, one at a time)

```
npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run typecheck
npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run lint
npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test
npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test:server
npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run test:server-slow
npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run check:cycles
npm --prefix C:/Claude/Projects/wt-3400-revisions-server-ops run build
```
Expected: every command exits 0. `check:cycles` needs network for `npx madge@8.0.0`. If a test fails, first check whether it fails on `main` too, per CLAUDE.md's triage rule, and report it either way.

- [ ] **Step 3: PR-1 acceptance checklist** (tick each item with the evidence: test name or command output)

  - [ ] `revisions-store.ts` is the only code that writes revisions.json. Verify that `git -C <wt> grep -n "revisionsJsonPath" -- server/src ':!*.test.ts'` shows writes only in `revisions-store.ts` and the **still-accepted PR-1** `PUT /state` revisions case (`book-state.ts:789-790`). `GET /state` (`book-state.ts:285`) still reads raw.
  - [ ] The lock key is normalised (`revisionsLockKey` uses `path.resolve`), and only the store builds it: `git grep -n "revisions:" -- server/src ':!*.test.ts'`.
  - [ ] The revisions lock is a leaf. Inside `revisions-store.ts`, no `withCastLock`/`withKeyLock` call other than its own appears inside a locked callback, and no `writeJsonAtomic` targets any path other than `revisionsJsonPath`.
  - [ ] The old routes keep today's codes and order (`chapter-audio.test.ts` green, unchanged tests plus the new 409).
  - [ ] Every finalize caller passes no `review` (the three spy tests are green).
  - [ ] `routes/generation.ts` gained no import from `audio/` or `workspace/`: `git -C <wt> diff main -- server/src/routes/generation.ts | grep "^+import"` shows only `./review-request.js`.
  - [ ] `audio/previous-audio.ts` does not import `generation`: `git grep -n "generation" -- server/src/audio/previous-audio.ts` returns nothing.
  - [ ] Every field added to an existing OpenAPI schema is optional (`api-types.revisions-contract.test.ts` green under typecheck).
  - [ ] The CLAUDE.md count says seventeen, and `git grep -n "requestFailureMessage(" -- "server/src/**/*.ts" ":!*.test.ts"` shows 17 call sites plus the definition.
  - [ ] Restructure has no new pending drop: `git -C <wt> diff main -- server/src/routes/chapters-restructure.ts` is empty.
  - [ ] No `server/tts-sidecar/**` change: `git -C <wt> diff --stat main -- server/tts-sidecar` is empty.
  - [ ] INDEX has the 285 entry, and no release-notes files changed.

- [ ] **Step 4: Re-run the load-bearing mutations** (each red, then restored green; paste the red lines):
  - Task 1 #1 (lock key without `resolve`).
  - Task 1 #3 (commit writes on `gone`).
  - Task 2 (busy check moved after the parse).
  - Task 3 #1 (no `live_audio_missing` pre-check).
  - Task 3 #2 (uncurated 500).
  - Task 5 #1 (store call before the state.json write).
  - Task 5 #4 (`review: null` at the splice caller).
  - Task 6 #1 (`reviewChapter` on a replay).
  - Task 7 (`rm` instead of reset).

  After restoring, `git -C <wt> status --porcelain` must be empty. Byte-compare every restored file against `HEAD` with `git diff --exit-code`.

- [ ] **Step 5: Report** each checklist result, each mutation's observed red line, and any battery failure, with its main-vs-branch triage.

---

## Self-review notes (plan author)

- **Spec coverage:**
  - §1 store, normalisation, `fileId`/`rev`, reset, leaf lock: Tasks 1 and 7.
  - §2 audio extraction: Task 2.
  - §2 accept/reject/dismiss, errors, and curation: Task 3.
  - §2 polls and D8: Task 3.
  - §2 OpenAPI: Task 4.
  - §3 finalize tri-state, placement, best-effort, and SSE threading: Task 5.
  - §3 `review` on generation (queue whitelist, `queue-io`, `StreamArgs`, the body builder, the mock queue, the claim, the 400 above `:720`, `reviewChapter` only on the rendered chapter): Task 6.
  - Delivery's CLAUDE.md sentences: Tasks 3 and 7. INDEX: Task 7. Release notes are explicitly none.
  - PR-2 items (restore-unrecorded, the 400/410 switches, the restructure drop, caller values, every client change in §4) are deliberately absent.
- **Type consistency:** `ChapterRef`/`StoredRevision`/`RevisionsState` come from Task 1 and are used in Tasks 3, 5, and 7. `ReviewRequest` is server-side in `routes/review-request.ts` and client-side in `src/lib/types.ts`. The server's `queue-io` and finalize use the structural `{ characterId; triggeredBy }` to avoid cross-layer imports.
