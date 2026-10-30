/* #3784 — the analysis carried-forward change-log append is a read -> write of
   change-log.json, and the book-state slice PUT rewrites the same file. The
   append must take the book's `book` lock so the two serialise; unlocked, a PUT
   landing between its read and write loses the event (or the PUT's revision
   check passes against a file the append is about to change). Deterministic:
   the lock is held by the test, no timing races. */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let bookDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'analysis-changelog-lock-'));
  process.env.WORKSPACE_DIR = root;
  bookDir = join(root, 'book');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('logCarriedForwardCharacters — book lock (#3784)', () => {
  it('waits for the held book lock instead of appending unlocked', async () => {
    const { logCarriedForwardCharacters } = await import('./analysis.js');
    const { withBookLock } = await import('../workspace/book-lock.js');
    const logPath = join(bookDir, '.audiobook', 'change-log.json');
    writeFileSync(logPath, JSON.stringify({ events: [{ id: 1, title: 'existing' }] }));

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = withBookLock('book-3784', async () => {
      held();
      await gate;
    });
    await holding;

    let settled = false;
    const append = logCarriedForwardCharacters('book-3784', bookDir, [{ id: 'c1', name: 'Ann' }]).then(
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect(JSON.parse(readFileSync(logPath, 'utf8')).events).toHaveLength(1);

    release();
    await holder;
    await append;
    const events = JSON.parse(readFileSync(logPath, 'utf8')).events;
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('Preserved designed voices across re-analysis');
  }, 60_000);
});
