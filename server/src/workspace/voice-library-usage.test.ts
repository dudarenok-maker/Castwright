/* fs-38 Wave 1, Task 5 — unit tests for the voice-library usage scan +
   reference-clearing helpers. Mirrors the tempdir-workspace pattern from
   routes/voices.test.ts: a real books/ tree under a WORKSPACE_DIR temp
   root, seeded state.json + cast.json per book. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* #2123 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the lock-detector
   test at the bottom of this file can intercept this module's OWN in-lock
   `readJson(cast.json)` call inside `clearLibraryVoiceReferences`. Defaults
   to a plain passthrough — every other test in this file (including the
   `vi.resetModules()` + fresh dynamic import each `beforeEach` below) behaves
   exactly as if this mock weren't here. Same idiom as
   `cast-not-linked-to.test.ts`'s own #2123 mock. */
vi.mock('./state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

let dir: string;
let usageMod: typeof import('./voice-library-usage.js');

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  castConfirmed = true,
) {
  const bookDir = join(workspace, 'books', author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return bookDir;
}

function readCastFromDisk(workspace: string, author: string, series: string, title: string) {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-voicelib-usage-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  usageMod = await import('./voice-library-usage.js');
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('scanLibraryVoiceUsage', () => {
  it('finds a character whose cast.json overrideTtsVoices slot references the library voice', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        overrideTtsVoices: { qwen: { name: 'qwen-lib-1', libraryUuid: 'lib-uuid-1' } },
      },
      { id: 'char-other', name: 'Other' },
    ]);

    const usage = await usageMod.scanLibraryVoiceUsage('lib-uuid-1');

    expect(usage).toEqual([
      {
        bookId: 'book-one',
        bookTitle: 'Book One',
        characterId: 'char-marlow',
        characterName: 'Marlow',
      },
    ]);
  });

  it('returns empty when no cast.json references the voiceUuid', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      { id: 'char-marlow', name: 'Marlow', overrideTtsVoices: { qwen: { name: 'x' } } },
    ]);

    expect(await usageMod.scanLibraryVoiceUsage('lib-uuid-unused')).toEqual([]);
  });

  it('ignores unconfirmed casts and books with no characters', async () => {
    writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Draft Book',
      'draft-book',
      [{ id: 'char-x', overrideTtsVoices: { qwen: { name: 'x', libraryUuid: 'lib-uuid-1' } } }],
      false,
    );

    expect(await usageMod.scanLibraryVoiceUsage('lib-uuid-1')).toEqual([]);
  });

  it('finds references across multiple books and multiple engine slots', async () => {
    writeBookOnDisk(dir, 'Author A', 'Series A', 'Book A', 'book-a', [
      { id: 'char-a', name: 'A', overrideTtsVoices: { qwen: { name: 'x', libraryUuid: 'lib-uuid-1' } } },
    ]);
    writeBookOnDisk(dir, 'Author B', 'Series B', 'Book B', 'book-b', [
      {
        id: 'char-b',
        name: 'B',
        overrideTtsVoices: {
          coqui: { name: 'y' },
          xtts: { name: 'z', libraryUuid: 'lib-uuid-1' },
        },
      },
    ]);

    const usage = await usageMod.scanLibraryVoiceUsage('lib-uuid-1');
    const bookIds = usage.map((u) => u.bookId).sort();
    expect(bookIds).toEqual(['book-a', 'book-b']);
  });
});

describe('clearLibraryVoiceReferences', () => {
  it('removes only the matching engine slot, leaving sibling slots and other characters untouched', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        overrideTtsVoices: {
          qwen: { name: 'qwen-lib-1', libraryUuid: 'lib-uuid-1' },
          coqui: { name: 'preset-voice' },
        },
      },
      { id: 'char-other', name: 'Other', overrideTtsVoices: { qwen: { name: 'unrelated' } } },
    ]);

    await usageMod.clearLibraryVoiceReferences('lib-uuid-1');

    const cast = readCastFromDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One');
    const marlow = cast.characters.find((c) => c.id === 'char-marlow')!;
    const overrides = marlow.overrideTtsVoices as Record<string, unknown>;
    expect(overrides.qwen).toBeUndefined();
    expect(overrides.coqui).toEqual({ name: 'preset-voice' });

    const other = cast.characters.find((c) => c.id === 'char-other')!;
    expect((other.overrideTtsVoices as Record<string, unknown>).qwen).toEqual({ name: 'unrelated' });
  });

  it('is a no-op (no write) when nothing references the voiceUuid', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      { id: 'char-marlow', name: 'Marlow', overrideTtsVoices: { qwen: { name: 'unrelated' } } },
    ]);

    await usageMod.clearLibraryVoiceReferences('lib-uuid-does-not-exist');

    const cast = readCastFromDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One');
    expect((cast.characters[0].overrideTtsVoices as Record<string, unknown>).qwen).toEqual({
      name: 'unrelated',
    });
  });
});

/* #2123 (srv-87) — voice-library-usage.ts was one of two cast-lock-sweep
   sites with no BEHAVIOURAL lock detector (the other being
   cast-add-from-roster.ts). Correction to the sweep's own premise, found
   while building this test: the #2040-era measurement that flagged this
   file assumed it called `withCastLocks` (plural) — it doesn't.
   `clearLibraryVoiceReferences` calls `withCastLock` (singular, see its own
   block comment above: "never `withCastLocks` across every book at once —
   because ... this loop holds at most ONE cast lock at a time"). Neutralising
   `withCastLocks` therefore never touches this module at all; the racer below
   uses `withCastLock`, the SAME primitive the site calls, per this branch's
   own established convention (cast-not-linked-to.test.ts's #2123 comment).

   `clearLibraryVoiceReferences` reads `castJsonPath(bookDir)` TWICE per
   qualifying book: once inside `walkConfirmedCasts()`'s own scan (OUTSIDE any
   lock, deciding which books to visit) and once again, fresh, inside
   `withCastLock` (the real in-lock read the write is based on). Gating the
   FIRST occurrence would intercept the walker's unlocked scan read — a
   placebo, since the racer would then finish before the target ever asks for
   its lock. The fixture below seeds exactly one qualifying book, so the two
   reads of that book's cast.json happen in a known, strict order; the gate
   below tracks occurrences and only intercepts the SECOND.

   The racer touches `narrator.raceProbe` — a field `clearLibraryVoiceReferences`
   never reads or writes (it only ever rewrites characters whose
   `overrideTtsVoices` matched the target voiceUuid), so its survival is a
   clean signal independent of the module's own override-clearing logic. The
   fixture's `char-marlow` DOES reference the target voiceUuid, so the
   target's own write is exercised too — `assertRouteOutcome` checks marlow's
   `qwen` slot actually got cleared, so a no-op target trivially "preserving"
   the racer's write can't pass by accident.

   Same `racerEntered` mechanism assertion as cast-not-linked-to.test.ts's
   #2123 detector, for the same reason: the survival assertion alone would
   also pass if the unlocked racer's read+write happened to lose outright
   against the 80ms head start on a slow/contended box, which would mask a
   real regression. */
describe('#2123 — cast.json lock is real, and its read stays inside it', () => {
  const AUTHOR = 'Della Renwick';
  const SERIES = 'The Hollow Tide';
  const TITLE = 'Lock Detector Book';
  const VOICE_UUID = 'lib-uuid-lock-detector';

  beforeEach(() => {
    writeBookOnDisk(dir, AUTHOR, SERIES, TITLE, 'lock-detector-book', [
      { id: 'narrator', name: 'Narrator', role: 'narrator' },
      {
        id: 'char-marlow',
        name: 'Marlow',
        overrideTtsVoices: { qwen: { name: 'qwen-lib-1', libraryUuid: VOICE_UUID } },
      },
    ]);
  });

  async function runLockDetector(
    targetCall: () => Promise<void>,
    assertRouteOutcome: () => void,
  ): Promise<void> {
    const stateIo = await import('./state-io.js');
    const actual = await vi.importActual<typeof import('./state-io.js')>('./state-io.js');
    const { castJsonPath } = await import('./paths.js');
    const { withCastLock } = await import('./cast-lock.js');
    const bookDir = join(dir, 'books', AUTHOR, SERIES, TITLE);
    const bookCastPath = castJsonPath(bookDir);

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    // Two unlocked reads of this book's cast.json happen per qualifying book
    // (see block comment above): the walker's scan read (1st), then the
    // real in-lock read (2nd). Only the 2nd is the one under test.
    let seen = 0;
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (path === bookCastPath) {
        seen += 1;
        if (seen === 2 && !intercepted) {
          intercepted = true;
          const value = await actual.readJson(path); // real bytes, now — happens-before the racer's write
          await gate; // hold the RESOLUTION open until released below
          return value;
        }
      }
      return actual.readJson(path);
    });

    // Bypasses the spy entirely (uses `actual` directly) so the racer's own
    // read/write are never accidentally re-intercepted (and never counted
    // toward `seen`) — a plain, faithful `withCastLock` consumer.
    let racerEntered = false;
    async function raceWrite(): Promise<void> {
      await withCastLock(bookDir, async () => {
        racerEntered = true; // set on entry, before the read
        const cast = await actual.readJson<{
          characters: Array<Record<string, unknown>>;
        }>(bookCastPath);
        const narrator = cast!.characters.find((c) => c.id === 'narrator')!;
        (narrator as Record<string, unknown>).raceProbe = 'concurrent-writer-survived';
        await actual.writeJsonAtomic(bookCastPath, { characters: cast!.characters });
      });
    }

    let targetPromise: Promise<void> | undefined;
    let racePromise: Promise<void> | undefined;
    try {
      targetPromise = targetCall();
      targetPromise.catch(() => {});

      // Poll rather than a fixed sleep — same precedent as
      // cast-not-linked-to.test.ts's own #2123 detector.
      const deadline = Date.now() + 2000;
      while (!intercepted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(intercepted).toBe(true);

      racePromise = raceWrite();
      racePromise.catch(() => {});

      // Generous head start: completes fully when unlocked (the bug
      // window), or queues behind the target's held lock when locked (the
      // fix) — either way nothing depends on tuning a tight timing window.
      await new Promise((r) => setTimeout(r, 80));

      // Must hold even when the survival assertions below would still pass
      // by luck (a slow unlocked racer that loses the race anyway).
      expect(racerEntered).toBe(false);

      released();
      await Promise.all([targetPromise, racePromise]);
    } finally {
      // Idempotent: also fires here so a throw ANYWHERE above still
      // releases a held `readJson` rather than leaving it stuck forever.
      released();
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
      // On the failure path these are still in-flight — await them so the
      // test can't return while either is still running against fixtures
      // `afterEach` is about to delete.
      await Promise.allSettled([targetPromise, racePromise]);
    }

    assertRouteOutcome();

    const cast = readCastFromDisk(dir, AUTHOR, SERIES, TITLE);
    const narrator = cast.characters.find((c) => c.id === 'narrator');
    expect((narrator as Record<string, unknown>)?.raceProbe).toBe('concurrent-writer-survived');
  }

  it('a concurrent withCastLock writer on the same book survives clearLibraryVoiceReferences', async () => {
    await runLockDetector(
      () => usageMod.clearLibraryVoiceReferences(VOICE_UUID),
      () => {
        const cast = readCastFromDisk(dir, AUTHOR, SERIES, TITLE);
        const marlow = cast.characters.find((c) => c.id === 'char-marlow')!;
        const overrides = marlow.overrideTtsVoices as Record<string, unknown>;
        expect(overrides?.qwen).toBeUndefined();
      },
    );
  });
});
