/* #4227 — the restructure edits journal and its replay, driven through every
   outcome on a temp book folder. The journal is built from a REAL applyMerge. */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const writeFlag = vi.hoisted(() => ({ fail: false }));
vi.mock('../store/analysis-cache-rebuild.js', () => ({
  refreshCacheFromEdits: vi.fn(async () => 'rebuilt'),
}));
vi.mock('./state-io.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...real,
    writeJsonAtomic: vi.fn(async (...args: Parameters<typeof real.writeJsonAtomic>) => {
      if (writeFlag.fail && String(args[0]).endsWith('manuscript-edits.json')) {
        throw new Error('edits write boom');
      }
      return real.writeJsonAtomic(...args);
    }),
  };
});

import { applyMerge, carryMergedAwayKeys, type RestructureSentence } from './restructure.js';
import type { BookStateJson } from './scan.js';
import type { ChapterHint } from '../store/manuscripts.js';

let root: string;
let mod: typeof import('./restructure-edits-journal.js');
let refresh: ReturnType<typeof vi.fn>;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'restructure-edits-journal-test-'));
  process.env.WORKSPACE_DIR = root;
  mod = await import('./restructure-edits-journal.js');
  refresh = (await import('../store/analysis-cache-rebuild.js')).refreshCacheFromEdits as never;
});

beforeEach(() => {
  writeFlag.fail = false;
  refresh.mockClear();
});

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

function makeState(): BookStateJson {
  const titles = ['One', 'Two', 'Three'];
  return {
    bookId: 'test-book',
    manuscriptId: 'mid-1',
    title: 'Test',
    author: 'Tester',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: titles.map((t, i) => ({
      id: i + 1,
      title: t,
      slug: `0${i + 1}-${t.toLowerCase()}`,
      uuid: `uuid-${i + 1}`,
    })),
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as BookStateJson;
}

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

interface Fixture {
  dir: string;
  editsPath: string;
  journalPath: string;
  statePath: string;
  oldState: BookStateJson;
  result: ReturnType<typeof applyMerge>;
  editsBytes: string;
  entry: Parameters<typeof import('./restructure-edits-journal.js').writeRestructureEditsJournal>[1];
}

/** Builds a book folder holding the OLD state, the old edits and a journal. */
async function fixture(opts: { mergedAwayKeys?: string[] } = {}): Promise<Fixture> {
  const dir = join(root, `book-${++n}`);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  const oldState = makeState();
  const result = applyMerge(oldState, hints(), makeSentences(), { chapterIds: [1, 2] });
  const editsBytes = JSON.stringify({
    sentences: makeSentences(),
    ...(opts.mergedAwayKeys ? { mergedAwayKeys: opts.mergedAwayKeys } : {}),
  });
  const f: Fixture = {
    dir,
    editsPath: join(dir, '.audiobook', 'manuscript-edits.json'),
    journalPath: join(dir, '.audiobook', 'restructure-edits-journal.json'),
    statePath: join(dir, '.audiobook', 'state.json'),
    oldState,
    result,
    editsBytes,
    entry: {
      editsSha256: sha(editsBytes),
      chapters: result.state.chapters.map((c) => ({ id: c.id, uuid: c.uuid! })),
      remap: result.remap,
    },
  };
  writeFileSync(f.editsPath, editsBytes);
  writeFileSync(f.statePath, JSON.stringify(oldState));
  await mod.writeRestructureEditsJournal(dir, f.entry);
  return f;
}

const landState = (f: Fixture): void => writeFileSync(f.statePath, JSON.stringify(f.result.state));
const readEdits = (f: Fixture) =>
  JSON.parse(readFileSync(f.editsPath, 'utf8')) as { sentences: RestructureSentence[]; mergedAwayKeys?: string[] };

describe('restructure edits journal replay (#4227)', () => {
  it('J1 replays the edits rewrite when the state landed. Red if: the rewrite, the unlink or the cache refresh is dropped', async () => {
    const f = await fixture();
    landState(f);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('replayed');
    expect(readEdits(f)).toEqual({ sentences: f.result.sentences });
    expect(readEdits(f).sentences.some((s) => s.chapterId === 3)).toBe(false);
    expect(existsSync(f.journalPath)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![2]).toEqual({ mode: 'replace' });
  });

  it('J2 carries the merged-away tombstones. Red if: the mergedAwayKeys carry is dropped from the rewrite', async () => {
    const f = await fixture({ mergedAwayKeys: ['3:1'] });
    landState(f);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('replayed');
    expect(readEdits(f).mergedAwayKeys).toEqual(carryMergedAwayKeys(['3:1'], f.result.remap));
    expect(readEdits(f).mergedAwayKeys).toEqual(['2:1']);
  });

  it('J3 discards when the state did not land. Red if: the chapter-list comparison (guard c) is deleted', async () => {
    const f = await fixture();
    const before = readFileSync(f.editsPath);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('discarded');
    expect(readFileSync(f.editsPath).equals(before)).toBe(true);
    expect(existsSync(f.journalPath)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('J4 discards when the edits were replaced since. Red if: the sha comparison (guard d) is deleted', async () => {
    const f = await fixture();
    landState(f);
    writeFileSync(f.editsPath, JSON.stringify({ sentences: makeSentences().slice(0, 3) }));
    const before = readFileSync(f.editsPath);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('discarded');
    expect(readFileSync(f.editsPath).equals(before)).toBe(true);
    expect(existsSync(f.journalPath)).toBe(false);
  });

  it('J5 returns none with no journal. Red if: the missing-journal early return is removed', async () => {
    const f = await fixture();
    landState(f);
    await mod.clearRestructureEditsJournal(f.dir);
    const edits = readFileSync(f.editsPath);
    const state = readFileSync(f.statePath);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('none');
    expect(readFileSync(f.editsPath).equals(edits)).toBe(true);
    expect(readFileSync(f.statePath).equals(state)).toBe(true);
  });

  it('J6 discards an unreadable journal. Red if: parse failure is not handled as a discard', async () => {
    const f = await fixture();
    landState(f);
    writeFileSync(f.journalPath, '{not json');
    const before = readFileSync(f.editsPath);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('discarded');
    expect(existsSync(f.journalPath)).toBe(false);
    expect(readFileSync(f.editsPath).equals(before)).toBe(true);
  });

  it('J7 discards a legacy state without uuids. Red if: guard c compares chapter ids only', async () => {
    const f = await fixture();
    const legacy = {
      ...f.result.state,
      chapters: f.result.state.chapters.map(({ uuid: _uuid, ...rest }) => rest),
    };
    writeFileSync(f.statePath, JSON.stringify(legacy));
    const before = readFileSync(f.editsPath);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('discarded');
    expect(readFileSync(f.editsPath).equals(before)).toBe(true);
  });

  it('J8 propagates a failing rewrite and keeps the journal. Red if: step 2e is wrapped in a catch that discards', async () => {
    const f = await fixture();
    landState(f);
    const before = readFileSync(f.editsPath);
    writeFlag.fail = true;
    await expect(mod.replayRestructureEditsJournal(f.dir, 'test-book')).rejects.toThrow('edits write boom');
    expect(existsSync(f.journalPath)).toBe(true);
    expect(readFileSync(f.editsPath).equals(before)).toBe(true);
  });

  it('J9 returns none and keeps the journal when state.json is absent. Red if: absent state discards', async () => {
    const f = await fixture();
    const { rmSync } = await import('node:fs');
    rmSync(f.statePath);
    expect(await mod.replayRestructureEditsJournal(f.dir, 'test-book')).toBe('none');
    expect(existsSync(f.journalPath)).toBe(true);
  });

  it('J10 write and clear helpers. Red if: the schema stamp is dropped or clear throws on ENOENT', async () => {
    const f = await fixture();
    expect(JSON.parse(readFileSync(f.journalPath, 'utf8'))).toEqual({ schema: 1, ...f.entry });
    await mod.clearRestructureEditsJournal(f.dir);
    await expect(mod.clearRestructureEditsJournal(f.dir)).resolves.toBeUndefined();
  });
});
