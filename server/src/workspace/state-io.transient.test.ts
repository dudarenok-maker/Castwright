/* #3625 review pass 2 — two data-loss shapes in the state.json backup chain:

   1. A TRANSIENT read error (EBUSY / EPERM / EIO) on a healthy main file must
      propagate, not fall back to `.bak.1`. `.bak.1` is the state before the last
      write, so substituting it and then writing back silently reverts that write
      (a lost sibling stamp). Only an unparseable main file recovers.
   2. A failed tmp write must neither leave the main file absent nor rotate the
      backup chain: the tmp is written FIRST, rotation (rename-away) and the
      tmp -> main rename follow, so main and `.bak.1-3` are untouched on failure. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inject = vi.hoisted(() => ({
  readFailPath: null as string | null,
  readFailsLeft: 0,
  writeFailSubstr: null as string | null,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: ((p: unknown, ...rest: unknown[]) => {
      if (inject.readFailsLeft > 0 && typeof p === 'string' && p === inject.readFailPath) {
        inject.readFailsLeft -= 1;
        return Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));
      }
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof actual.readFile,
    writeFile: ((p: unknown, ...rest: unknown[]) => {
      if (inject.writeFailSubstr && typeof p === 'string' && p.includes(inject.writeFailSubstr)) {
        return Promise.reject(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof actual.writeFile,
  };
});

const AUTHOR = 'Transient';
const SERIES = 'Standalones';
const TITLE = 'Transient Book';

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let statePath: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-transient-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { makeBookId } = await import('./paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  statePath = join(bookDir, '.audiobook', 'state.json');
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  rmSync(join(bookDir, '.audiobook'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
});

afterEach(() => {
  inject.readFailPath = null;
  inject.readFailsLeft = 0;
  inject.writeFailSubstr = null;
});

function baseState(chapterExtra: Record<string, unknown>) {
  return {
    bookId,
    manuscriptId: 'm_transient',
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: true,
    chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', uuid: 'u-1', ...chapterExtra }],
    language: 'en',
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('a transient read error does not revert the previous write (#3625)', () => {
  it('patchStateCover rejects on one EBUSY and chapter 1 keeps its audioModelKey stamp', async () => {
    const { writeStateJsonAtomic } = await import('./state-migrate.js');
    const { patchStateCover } = await import('../cover/store.js');
    await writeStateJsonAtomic(statePath, baseState({}) as never);
    await writeStateJsonAtomic(statePath, baseState({ audioModelKey: 'kokoro-v1' }) as never);

    inject.readFailPath = statePath;
    inject.readFailsLeft = 1;
    await expect(
      patchStateCover(bookDir, { id: 'c1', source: 'openlibrary', coverUrl: 'http://x/y.jpg' } as never),
    ).rejects.toThrow(/EBUSY/);

    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(onDisk.chapters[0].audioModelKey).toBe('kokoro-v1');
  });

  it('readJsonWithRecovery still recovers from a PARSE failure', async () => {
    const { readJsonWithRecovery } = await import('./state-io.js');
    writeFileSync(`${statePath}.bak.1`, JSON.stringify({ v: 1 }));
    writeFileSync(statePath, '{"v":');
    await expect(readJsonWithRecovery(statePath, { keep: 3 })).resolves.toEqual({ v: 1 });
  });
});

describe('a failed write leaves the main file in place (#3625)', () => {
  it('a tmp-write failure keeps main intact and the book still findable', async () => {
    const { writeStateJsonAtomic } = await import('./state-migrate.js');
    const { findBookByBookId } = await import('./scan.js');
    await writeStateJsonAtomic(statePath, baseState({}) as never);
    const before = readFileSync(statePath, 'utf8');

    inject.writeFailSubstr = '.tmp-';
    await expect(
      writeStateJsonAtomic(statePath, baseState({ audioModelKey: 'kokoro-v1' }) as never),
    ).rejects.toThrow(/ENOSPC/);
    inject.writeFailSubstr = null;

    expect(existsSync(statePath)).toBe(true);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    const found = await findBookByBookId(bookId);
    expect(found).not.toBeNull();
  });
});

describe('a failed tmp write does not rotate the backup chain (#3625 review)', () => {
  it('three failed writes over a torn main leave .bak.1-3 good and recovery working', async () => {
    const { writeJsonAtomic, readJsonWithRecovery } = await import('./state-io.js');
    writeFileSync(statePath, '{"v":'); // torn main
    writeFileSync(`${statePath}.bak.1`, JSON.stringify({ v: 1 }));
    writeFileSync(`${statePath}.bak.2`, JSON.stringify({ v: 2 }));
    writeFileSync(`${statePath}.bak.3`, JSON.stringify({ v: 3 }));

    inject.writeFailSubstr = '.tmp-';
    for (let i = 0; i < 3; i += 1) {
      await expect(writeJsonAtomic(statePath, { v: 9 }, { rotate: { keep: 3 } })).rejects.toThrow(/ENOSPC/);
    }
    inject.writeFailSubstr = null;

    expect(JSON.parse(readFileSync(`${statePath}.bak.1`, 'utf8'))).toEqual({ v: 1 });
    expect(JSON.parse(readFileSync(`${statePath}.bak.2`, 'utf8'))).toEqual({ v: 2 });
    expect(JSON.parse(readFileSync(`${statePath}.bak.3`, 'utf8'))).toEqual({ v: 3 });
    expect(readFileSync(statePath, 'utf8')).toBe('{"v":');
    await expect(readJsonWithRecovery(statePath, { keep: 3 })).resolves.toEqual({ v: 1 });
  });

  it('leaves no tmp droppings after a failed write', async () => {
    const { writeJsonAtomic } = await import('./state-io.js');
    const { readdirSync } = await import('node:fs');
    writeFileSync(statePath, JSON.stringify({ v: 1 }));
    inject.writeFailSubstr = '.tmp-';
    await expect(writeJsonAtomic(statePath, { v: 2 }, { rotate: { keep: 3 } })).rejects.toThrow(/ENOSPC/);
    inject.writeFailSubstr = null;
    expect(readdirSync(join(bookDir, '.audiobook')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});
