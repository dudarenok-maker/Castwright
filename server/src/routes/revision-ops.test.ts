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

const { busy, failRestore, unlinkGate } = vi.hoisted(() => ({
  busy: { value: false },
  failRestore: { value: false },
  /* One-shot gate: the first unlink whose path matches parks until released. */
  unlinkGate: {
    match: null as null | ((p: string) => boolean),
    entered: null as null | (() => void),
    release: null as null | Promise<void>,
  },
}));

vi.mock('./generation.js', () => ({ isGenerationActive: () => busy.value }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    unlink: async (p: Parameters<typeof real.unlink>[0]) => {
      if (unlinkGate.match?.(String(p))) {
        const { entered, release } = unlinkGate;
        unlinkGate.match = null;
        entered?.();
        await release;
      }
      return real.unlink(p);
    },
  };
});
vi.mock('../workspace/file-lock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/file-lock.js')>();
  return { ...real, withKeyLock: vi.fn(real.withKeyLock) };
});
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

beforeEach(async () => {
  const { withKeyLock } = await import('../workspace/file-lock.js');
  vi.mocked(withKeyLock).mockClear();
  unlinkGate.match = null;
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

/* #3400 pass 2 — every pending entry in production today is a LEGACY one
   (client-written: no `origin`), which normalisation keeps only while
   `.previous.mp3` exists. The op's own audio step consumes `.previous`, so
   step 3 must still find the entry (by id, in the stored list). */
function legacyEntry(chapterId: number) {
  const { origin: _origin, ...rest } = entry(chapterId, `revision:${chapterId}:narrator`);
  return rest;
}
describe('legacy (origin-less) pending entries commit like server ones (#3400)', () => {
  const LEGACY_ID = 'revision:1:narrator';

  it('accept: 200, timeline entry recorded, entry removed', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([legacyEntry(1)]);
    const res = await accept(LEGACY_ID);
    expect(res.status).toBe(200);
    expect(res.body.pending).toEqual([]);
    expect(res.body.timeline['1']).toMatchObject([{ id: LEGACY_ID, eventKind: 'accepted' }]);
    expect(disk().pending).toEqual([]);
    expect(existsSync(prev())).toBe(false);
  });

  it('reject: 200, live is PREV, outcome recorded, entry removed', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([legacyEntry(1)]);
    const res = await reject(LEGACY_ID);
    expect(res.status).toBe(200);
    expect(readFileSync(live(), 'utf8')).toBe('PREV');
    expect(res.body.timeline['1']).toMatchObject([{ id: LEGACY_ID, eventKind: 'rejected' }]);
    expect(disk().pending).toEqual([]);
  });

  it('a retried legacy accept answers 200 already-done, not 404', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([legacyEntry(1)]);
    await accept(LEGACY_ID);
    const again = await accept(LEGACY_ID);
    expect(again.status).toBe(200);
    expect(again.body.timeline['1']).toHaveLength(1);
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

/* #3400 review pass 1 — accept/reject are serialised per chapter across steps
   1-3. Park the FIRST op's slow unlink, fire the opposing op, let the parked op
   finish: the second op must see the first one's outcome, never act on a
   half-moved pair. */
function parkUnlink(match: (p: string) => boolean) {
  let entered!: () => void;
  let release!: () => void;
  const hit = new Promise<void>((r) => (entered = r));
  unlinkGate.release = new Promise<void>((r) => (release = r));
  unlinkGate.entered = entered;
  unlinkGate.match = match;
  return { hit, release };
}
/* Resolves once a SECOND op has called withKeyLock for a `revision-op:` key —
   i.e. it has queued behind the parked first one (withKeyLock registers its
   place synchronously on call). Deterministic: no sleep. */
async function secondOpQueued() {
  const { withKeyLock } = await import('../workspace/file-lock.js');
  await vi.waitFor(() => {
    const opCalls = vi.mocked(withKeyLock).mock.calls.filter(([k]) => String(k).startsWith('revision-op:'));
    expect(opCalls.length).toBeGreaterThanOrEqual(2);
  });
}

describe('accept / reject on one chapter are serialised (#3400)', () => {
  it('reject mid-restore, then accept: accept answers 404 after the reject lands; the restored take survives; one timeline entry', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const gate = parkUnlink((p) => p.endsWith('01-one.mp3'));
    const rejecting = reject('r1').then((r) => r);
    await gate.hit;
    const accepting = accept('r1').then((r) => r);
    await secondOpQueued();
    gate.release();
    const [rej, acc] = await Promise.all([rejecting, accepting]);
    expect(rej.status).toBe(200);
    expect(acc.status).toBe(404);
    expect(acc.body.error).toBe('revision_not_found');
    expect(readFileSync(live(), 'utf8')).toBe('PREV');
    expect(existsSync(prev())).toBe(false);
    expect(disk().timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'rejected' }]);
  });

  it('accept mid-delete, then reject: reject answers 404 after the accept lands; live survives; one timeline entry', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const gate = parkUnlink((p) => p.endsWith('01-one.previous.mp3'));
    const accepting = accept('r1').then((r) => r);
    await gate.hit;
    const rejecting = reject('r1').then((r) => r);
    await secondOpQueued();
    gate.release();
    const [acc, rej] = await Promise.all([accepting, rejecting]);
    expect(acc.status).toBe(200);
    expect(rej.status).toBe(404);
    expect(readFileSync(live(), 'utf8')).toBe('LIVE');
    expect(existsSync(prev())).toBe(false);
    expect(disk().timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'accepted' }]);
  });

  it('two concurrent rejects for one id: both 200, live is the restored take, one timeline entry', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([entry(1, 'r1')]);
    const gate = parkUnlink((p) => p.endsWith('01-one.mp3'));
    const first = reject('r1').then((r) => r);
    await gate.hit;
    const second = reject('r1').then((r) => r);
    await secondOpQueued();
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(readFileSync(live(), 'utf8')).toBe('PREV');
    expect(disk().timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'rejected' }]);
  });

  it.each(['accept', 'reject'] as const)('%s: an entry recorded between the lock-free pre-read and begin re-runs the op under the chapter key', async (op) => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    seed([]); // the pre-read finds no pending entry …
    const store = await import('../workspace/revisions-store.js');
    const { withKeyLock } = await import('../workspace/file-lock.js');
    const real = await vi.importActual<typeof import('../workspace/revisions-store.js')>(
      '../workspace/revisions-store.js',
    );
    /* … but one lands before the unkeyed begin runs. */
    vi.mocked(store.beginRevisionOp).mockImplementationOnce(async (dir, chapters, op, id) => {
      await real.recordPending(dir, chapters, entry(1, 'r1') as Parameters<typeof real.recordPending>[2]);
      return real.beginRevisionOp(dir, chapters, op, id);
    });
    const res = await (op === 'accept' ? accept('r1') : reject('r1'));
    expect(res.status).toBe(200);
    expect(res.body.timeline['1']).toMatchObject([{ id: 'r1', eventKind: op === 'accept' ? 'accepted' : 'rejected' }]);
    const keys = vi.mocked(withKeyLock).mock.calls.map(([k]) => String(k));
    expect(keys.filter((k) => k.startsWith('revision-op:') && k.endsWith(':1'))).toHaveLength(1);
  });

  it('ops on DIFFERENT chapters do not wait on each other', async () => {
    writeFileSync(live(), 'LIVE');
    writeFileSync(prev(), 'PREV');
    writeFileSync(live('02-two'), 'LIVE2');
    writeFileSync(prev('02-two'), 'PREV2');
    seed([entry(1, 'r1'), entry(2, 'r2')]);
    const gate = parkUnlink((p) => p.endsWith('01-one.mp3'));
    const parked = reject('r1').then((r) => r);
    await gate.hit;
    const other = await reject('r2');
    expect(other.status).toBe(200);
    expect(readFileSync(live('02-two'), 'utf8')).toBe('PREV2');
    gate.release();
    expect((await parked).status).toBe(200);
  });

  it('a lock timeout on the per-chapter key answers the curated 500 — no key or path in the body', async () => {
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    const { withKeyLock } = await import('../workspace/file-lock.js');
    vi.mocked(withKeyLock).mockClear();
    vi.mocked(withKeyLock).mockRejectedValueOnce(
      new LockAcquisitionTimeoutError('revision-op:C:/SECRET-WORKSPACE/book:1', 10_000),
    );
    seed([entry(1, 'r1')]);
    const res = await accept('r1');
    expect(vi.mocked(withKeyLock).mock.calls[0][0]).toMatch(/^revision-op:.*:1$/);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
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
