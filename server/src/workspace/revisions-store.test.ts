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
