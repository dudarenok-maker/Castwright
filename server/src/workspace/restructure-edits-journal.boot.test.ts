/* #4227 — the boot sweep replays crashed restructures' edits journals, book by book. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const writeFlag = vi.hoisted(() => ({ failUnder: '' }));
vi.mock('../store/analysis-cache-rebuild.js', () => ({
  refreshCacheFromEdits: vi.fn(async () => 'rebuilt'),
}));
vi.mock('./state-io.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...real,
    writeJsonAtomic: vi.fn(async (...args: Parameters<typeof real.writeJsonAtomic>) => {
      const p = String(args[0]);
      if (writeFlag.failUnder && p.startsWith(writeFlag.failUnder) && p.endsWith('manuscript-edits.json')) {
        throw new Error('edits write boom');
      }
      return real.writeJsonAtomic(...args);
    }),
  };
});

import type { RestructureSentence } from './restructure.js';
import type { BookStateJson } from './scan.js';
import type { ChapterHint } from '../store/manuscripts.js';

let root: string;
let mod: typeof import('./restructure-edits-journal.js');
let gate: typeof import('./restructure-gate.js');
let locks: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let applyMerge: typeof import('./restructure.js').applyMerge;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'restructure-edits-journal-boot-test-'));
  process.env.WORKSPACE_DIR = root;
  mod = await import('./restructure-edits-journal.js');
  gate = await import('./restructure-gate.js');
  locks = await import('./book-op-lock.js');
  paths = await import('./paths.js');
  applyMerge = (await import('./restructure.js')).applyMerge;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  writeFlag.failUnder = '';
  // each test sees only its own books
  rmSync(join(root, 'books'), { recursive: true, force: true });
});

const sha = (b: string): string => createHash('sha256').update(b).digest('hex');

function makeSentences(): RestructureSentence[] {
  const out: RestructureSentence[] = [];
  for (const c of [1, 2, 3]) {
    for (const id of [1, 2]) out.push({ id, chapterId: c, characterId: 'narr', text: `c${c}s${id}` });
  }
  return out;
}

const hints = (): ChapterHint[] => [
  { id: 1, title: 'One', body: 'a' },
  { id: 2, title: 'Two', body: 'b' },
  { id: 3, title: 'Three', body: 'c' },
];

interface Crashed {
  bookId: string;
  manuscriptId: string;
  dir: string;
  editsPath: string;
  journalPath: string;
  result: ReturnType<typeof import('./restructure.js').applyMerge>;
}

/** A book in the crashed shape: merged state.json, old edits, a journal. */
function crashedBook(withJournal = true): Crashed {
  const i = ++n;
  const author = `Author ${i}`;
  const title = `Title ${i}`;
  const bookId = paths.makeBookId(author, 'Standalones', title);
  const manuscriptId = `m_boot_${i}`;
  const dir = join(root, 'books', author, 'Standalones', title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  const oldState = {
    bookId,
    manuscriptId,
    title,
    author,
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: ['One', 'Two', 'Three'].map((t, k) => ({
      id: k + 1,
      title: t,
      slug: `0${k + 1}-${t.toLowerCase()}`,
      uuid: `uuid-${i}-${k + 1}`,
    })),
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as BookStateJson;
  const result = applyMerge(oldState, hints(), makeSentences(), { chapterIds: [1, 2] });
  const editsBytes = JSON.stringify({ sentences: makeSentences() });
  const editsPath = join(dir, '.audiobook', 'manuscript-edits.json');
  const journalPath = join(dir, '.audiobook', 'restructure-edits-journal.json');
  writeFileSync(editsPath, editsBytes);
  writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify(result.state));
  if (withJournal) {
    writeFileSync(
      journalPath,
      JSON.stringify({
        schema: 1,
        editsSha256: sha(editsBytes),
        chapters: result.state.chapters.map((c) => ({ id: c.id, uuid: c.uuid! })),
        remap: result.remap,
      }),
    );
  }
  return { bookId, manuscriptId, dir, editsPath, journalPath, result };
}

const readEdits = (b: Crashed) =>
  JSON.parse(readFileSync(b.editsPath, 'utf8')) as { sentences: RestructureSentence[] };

describe('replayAllRestructureEditsJournals (#4227)', () => {
  it('B1 repairs a crashed book at boot. Red if: the sweep does not replay a book that has a journal', async () => {
    const b = crashedBook();
    const r = await mod.replayAllRestructureEditsJournals();
    expect(r.replayed).toContain(b.bookId);
    expect(readEdits(b)).toEqual({ sentences: b.result.sentences });
    expect(readEdits(b).sentences.some((s) => s.chapterId === 3)).toBe(false);
    expect(existsSync(b.journalPath)).toBe(false);
  });

  it('B2 a held gate defers it. Red if: the beginRestructure check is deleted', async () => {
    const b = crashedBook();
    const before = readFileSync(b.editsPath);
    expect(gate.beginRestructure(b.manuscriptId)).toBe(true);
    try {
      const r = await mod.replayAllRestructureEditsJournals();
      expect(r.skipped).toContain(b.bookId);
      expect(r.replayed).not.toContain(b.bookId);
    } finally {
      gate.endRestructure(b.manuscriptId);
    }
    expect(existsSync(b.journalPath)).toBe(true);
    expect(readFileSync(b.editsPath).equals(before)).toBe(true);
    const again = await mod.replayAllRestructureEditsJournals();
    expect(again.replayed).toContain(b.bookId);
  });

  it('B3 a running job defers it. Red if: the bookJobKinds check is deleted', async () => {
    const b = crashedBook();
    const before = readFileSync(b.editsPath);
    const release = locks.__addBookJobToken(b.bookId, 'render');
    try {
      const r = await mod.replayAllRestructureEditsJournals();
      expect(r.skipped).toContain(b.bookId);
      expect(r.replayed).not.toContain(b.bookId);
    } finally {
      release();
    }
    expect(existsSync(b.journalPath)).toBe(true);
    expect(readFileSync(b.editsPath).equals(before)).toBe(true);
    const again = await mod.replayAllRestructureEditsJournals();
    expect(again.replayed).toContain(b.bookId);
  });

  it("B4 one book's failure does not stop the walk. Red if: the per-book try/catch is removed", async () => {
    const a = crashedBook();
    const b = crashedBook();
    writeFlag.failUnder = a.dir;
    const r = await mod.replayAllRestructureEditsJournals();
    expect(r.errors.map((e) => e.bookId)).toEqual([a.bookId]);
    expect(r.errors[0]!.message).toContain('edits write boom');
    expect(existsSync(a.journalPath)).toBe(true);
    expect(r.replayed).toEqual([b.bookId]);
    expect(existsSync(b.journalPath)).toBe(false);
  });

  it('B5 a book without a journal is not touched. Red if: the journal-exists filter is dropped', async () => {
    const b = crashedBook(false);
    const files = ['manuscript-edits.json', 'state.json'].map((f) => join(b.dir, '.audiobook', f));
    const snap = files.map((f) => ({ f, bytes: readFileSync(f), mtime: statSync(f).mtimeMs }));
    const r = await mod.replayAllRestructureEditsJournals();
    expect(r).toEqual({ replayed: [], discarded: [], skipped: [], errors: [] });
    for (const s of snap) {
      expect(readFileSync(s.f).equals(s.bytes)).toBe(true);
      expect(statSync(s.f).mtimeMs).toBe(s.mtime);
    }
  });
});
