/* Unit tests for migrateLegacyChangeLogs — the one-shot wipe-and-fresh
   that runs at server bootstrap. Set WORKSPACE_DIR before importing the
   migration so paths.ts resolves against the tempdir (paths is read once
   at load time, same idiom scan.test.ts uses). */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let migrateLegacyChangeLogs: typeof import('./changelog-migrate.js').migrateLegacyChangeLogs;

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';

interface LogEntry {
  id?: number;
  at?: string;
  type: string;
  title?: string;
}

function bookDirFor(title: string): string {
  return join(workspaceRoot, 'books', AUTHOR, SERIES, title);
}

function seedBook(title: string, log: LogEntry[] | null, opts: { wrapEvents?: boolean } = {}): string {
  const bookDir = bookDirFor(title);
  const dotDir  = join(bookDir, '.audiobook');
  mkdirSync(dotDir, { recursive: true });
  /* state.json isn't strictly required by the migration (it walks dirs by
     name), but write one for realism so future code that depends on its
     presence isn't surprised by the fixture. */
  writeFileSync(join(dotDir, 'state.json'), JSON.stringify({ title }));
  if (log !== null) {
    /* Real on-disk shape is `{ events: [...] }` (book-state.ts:211 writes
       whatever the persistence middleware sends, and that wraps in
       `{ events: ... }`). The migration also tolerates a bare array, so a
       handful of tests use that shape to pin the defensive-parse branch. */
    const payload = opts.wrapEvents === false ? log : { events: log };
    writeFileSync(join(dotDir, 'change-log.json'), JSON.stringify(payload));
  }
  return bookDir;
}

function seedLegacySidecar(title: string): void {
  const dotDir = join(bookDirFor(title), '.audiobook');
  mkdirSync(dotDir, { recursive: true });
  writeFileSync(join(dotDir, 'change-log.legacy.json'), '[]');
}

function readJsonFromDisk(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'changelog-migrate-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const mod = await import('./changelog-migrate.js');
  migrateLegacyChangeLogs = mod.migrateLegacyChangeLogs;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* Wipe the books/ tree between cases so each test sees a clean workspace.
   The tempdir itself sticks around for the suite — only the books layout
   under it gets rebuilt. */
beforeEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

describe('migrateLegacyChangeLogs', () => {
  it('renames a log with chapter_complete entries to change-log.legacy.json and writes an empty array', async () => {
    /* The dominant noise case the migration exists for. A book that ran
       many generations has accumulated chapter_complete spam — we move
       it aside and start fresh. */
    const bookDir = seedBook('Noisy Book', [
      { id: 1, at: '2026-05-13T15:00:00.000Z', type: 'chapter_complete', title: 'Chapter 1 complete' },
      { id: 2, at: '2026-05-13T15:01:00.000Z', type: 'chapter_complete', title: 'Chapter 2 complete' },
      { id: 3, at: '2026-05-13T15:02:00.000Z', type: 'regenerate', title: 'Regenerated Chapter 1' },
    ]);

    const result = await migrateLegacyChangeLogs();

    expect(result.migrated).toEqual([bookDir]);
    expect(result.clean).toEqual([]);
    expect(result.alreadyMigrated).toEqual([]);

    /* Live file is now an empty `{ events: [] }` wrapper (matches what the
       persistence middleware writes on the next PUT). Legacy backup keeps
       the originals in their original shape. */
    expect(readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.json'))).toEqual({ events: [] });
    const legacyRaw = readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.legacy.json')) as { events: LogEntry[] };
    expect(legacyRaw.events).toHaveLength(3);
    expect(legacyRaw.events[0].type).toBe('chapter_complete');
    expect(legacyRaw.events[2].type).toBe('regenerate');
  });

  it('also handles bare-array legacy log files (older persistence shape) via defensive parse', async () => {
    /* Pre-wrap-events versions of the persistence middleware may have written
       a bare array. The migration's narrow-on-read keeps those compatible
       so users on older snapshots still get migrated. */
    const bookDir = seedBook('Bare Array Book', [
      { id: 7, at: '2026-05-13T09:00:00.000Z', type: 'chapter_complete', title: 'Chapter 7 complete' },
    ], { wrapEvents: false });

    const result = await migrateLegacyChangeLogs();

    expect(result.migrated).toEqual([bookDir]);
    expect(readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.json'))).toEqual({ events: [] });
    const legacyRaw = readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.legacy.json')) as LogEntry[];
    expect(legacyRaw).toEqual([
      { id: 7, at: '2026-05-13T09:00:00.000Z', type: 'chapter_complete', title: 'Chapter 7 complete' },
    ]);
  });

  it('leaves a log untouched when a sibling change-log.legacy.json already exists (re-run is a no-op)', async () => {
    /* The sentinel guarantee: a second boot must not clobber the fresh
       log the user has been accumulating new events into. */
    const bookDir = seedBook('Already Migrated Book', [
      { id: 99, at: '2026-05-14T12:00:00.000Z', type: 'generation_run_complete', title: 'Generated 3 chapters' },
    ]);
    seedLegacySidecar('Already Migrated Book');

    const beforeLive   = readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.json'));
    const beforeLegacy = readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.legacy.json'));

    const result = await migrateLegacyChangeLogs();

    expect(result.migrated).toEqual([]);
    expect(result.alreadyMigrated).toEqual([bookDir]);

    expect(readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.json'))).toEqual(beforeLive);
    expect(readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.legacy.json'))).toEqual(beforeLegacy);
  });

  it('leaves a log untouched when it contains no chapter_complete entries (already post-collapse)', async () => {
    /* A book that only has new-style rollup events is the post-migration
       steady state. No backup gets created — there is nothing legacy
       about it. */
    const bookDir = seedBook('Clean Book', [
      { id: 1, at: '2026-05-15T12:00:00.000Z', type: 'generation_run_complete', title: 'Generated 5 chapters' },
      { id: 2, at: '2026-05-15T12:30:00.000Z', type: 'voice_tune', title: 'Tuned Eliza' },
    ]);

    const result = await migrateLegacyChangeLogs();

    expect(result.clean).toEqual([bookDir]);
    expect(result.migrated).toEqual([]);
    expect(existsSync(join(bookDir, '.audiobook', 'change-log.legacy.json'))).toBe(false);
    const live = readJsonFromDisk(join(bookDir, '.audiobook', 'change-log.json')) as { events: LogEntry[] };
    expect(live.events).toHaveLength(2);
  });

  it('is a no-op for books with no change-log.json at all (freshly imported, never written)', async () => {
    /* Most-common state on a fresh workspace: the book exists on disk
       but no audit events have ever fired. Migration must skip without
       creating any sidecar files. */
    const bookDir = seedBook('Fresh Book', null);

    const result = await migrateLegacyChangeLogs();

    expect(result.migrated).toEqual([]);
    expect(result.clean).toEqual([]);
    expect(result.alreadyMigrated).toEqual([]);
    expect(existsSync(join(bookDir, '.audiobook', 'change-log.json'))).toBe(false);
    expect(existsSync(join(bookDir, '.audiobook', 'change-log.legacy.json'))).toBe(false);
  });
});
