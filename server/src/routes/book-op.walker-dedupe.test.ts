/* #3711 PR #3714 review pass 2 -- the multi-book walkers remember the books they
   have written by their RESOLVED folder. The walk's directory scan is lock-free,
   so a book can move between the scan reading it and its per-book `withBookOp`:
   the step then resolves (and writes) the book where it lives NOW. If it moved
   into a directory the walk has yet to list, the walk reaches it again there and
   must skip it -- the write is idempotent, but `updated` (and the caller's
   `mutate`) would otherwise run twice for one book.

   The move is injected out of process, right after the walk's own lock-free read
   of the old folder (`afterRead`), so the per-book step finds the book at its
   new folder. The new folder sits in a series directory the walk lists AFTER the
   old one. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* path -> a hook run once, right after that path's first read (the read itself
   returns what was on disk before the hook ran). */
const afterRead = vi.hoisted(() => new Map<string, () => void>());
const castLockDirs = vi.hoisted(() => [] as string[]);

function fireAfterRead(path: string): void {
  const hook = afterRead.get(path);
  if (!hook) return;
  afterRead.delete(path);
  hook();
}

vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  return {
    ...actual,
    readStateJsonWithRecovery: async (path: string) => {
      const out = await actual.readStateJsonWithRecovery(path);
      fireAfterRead(path);
      return out;
    },
  };
});
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    readJson: async <T>(path: string): Promise<T | null> => {
      const out = await actual.readJson<T>(path);
      fireAfterRead(path);
      return out;
    },
  };
});
vi.mock('../workspace/cast-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/cast-lock.js')>();
  return {
    ...actual,
    withCastLock: <T>(bookDir: string, fn: () => Promise<T>): Promise<T> => {
      castLockDirs.push(bookDir);
      return actual.withCastLock(bookDir, fn);
    },
  };
});

const BOOK_ID = 'walk__s1__moved';
const VOICE_ID = 'voice-1';
const LIB_UUID = 'lib-uuid-1';

let workspaceRoot: string;
let paths: typeof import('../workspace/paths.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let voices: typeof import('./voices.js');
let usage: typeof import('../workspace/voice-library-usage.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-walker-dedupe-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  voices = await import('./voices.js');
  usage = await import('../workspace/voice-library-usage.js');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  afterRead.clear();
  castLockDirs.length = 0;
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  bookOp.__bookDirIndexForTest().clear();
});

/** Seed the book at `Walk/S1/Moved`, plus an EMPTY `Walk/S2` the walk lists
 *  after S1 (its title listing is taken only when the walk reaches it). */
function seed(): { oldDir: string; newDir: string } {
  const oldDir = join(paths.BOOKS_ROOT, 'Walk', 'S1', 'Moved');
  const newDir = join(paths.BOOKS_ROOT, 'Walk', 'S2', 'Moved');
  mkdirSync(join(oldDir, '.audiobook'), { recursive: true });
  mkdirSync(join(paths.BOOKS_ROOT, 'Walk', 'S2'), { recursive: true });
  writeFileSync(
    paths.stateJsonPath(oldDir),
    JSON.stringify({
      bookId: BOOK_ID,
      title: 'Moved',
      author: 'Walk',
      series: 'S1',
      isStandalone: false,
      castConfirmed: true,
      chapters: [],
      language: 'en',
    }),
  );
  writeFileSync(
    paths.castJsonPath(oldDir),
    JSON.stringify({
      characters: [
        {
          id: 'alice',
          name: 'Alice',
          voiceId: VOICE_ID,
          overrideTtsVoices: { qwen: { name: 'x', libraryUuid: LIB_UUID } },
        },
      ],
    }),
  );
  return { oldDir, newDir };
}

const moveOutOfProcess = (from: string, to: string) => () => renameSync(from, to);

describe('a book moved into a later folder mid-walk is written once', () => {
  it('forEachMatchingCastCharacter counts it (and calls mutate) once', async () => {
    const { oldDir, newDir } = seed();
    /* Moved right after the walk's lock-free state read of the old folder. */
    afterRead.set(paths.stateJsonPath(oldDir), moveOutOfProcess(oldDir, newDir));
    const mutate = vi.fn((c: object) => ({ ...c, touched: true }));

    const updated = await voices.forEachMatchingCastCharacter(VOICE_ID, undefined, mutate as never);

    expect(afterRead.size).toBe(0); // the move happened
    expect(updated).toBe(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    const cast = JSON.parse(readFileSync(paths.castJsonPath(newDir), 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    expect(cast.characters[0].touched).toBe(true);
  });

  it('clearLibraryVoiceReferences clears it in one per-book step', async () => {
    const { oldDir, newDir } = seed();
    /* Moved right after the walk's lock-free cast read of the old folder. */
    afterRead.set(paths.castJsonPath(oldDir), moveOutOfProcess(oldDir, newDir));

    await usage.clearLibraryVoiceReferences(LIB_UUID);

    expect(afterRead.size).toBe(0); // the move happened
    expect(castLockDirs.filter((d) => d === newDir)).toHaveLength(1);
    const cast = JSON.parse(readFileSync(paths.castJsonPath(newDir), 'utf8')) as {
      characters: Array<{ overrideTtsVoices?: Record<string, unknown> }>;
    };
    expect(cast.characters[0].overrideTtsVoices?.qwen).toBeUndefined();
  });
});
