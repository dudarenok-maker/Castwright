/* #3711 PR #3714 review pass 3 (E) -- the by-id lookup behind
   `findAuthorSeriesForBookId` walks every book's state.json. A sibling whose
   state cannot be READ (here a real EISDIR: its state.json is a directory) used
   to fail the lookup of every other book, so `GET /api/books/:id/state` 500'd
   for any book sorting after it. It now skips that sibling; with no match it
   still fails (curated, path-free), since the unreadable folder may be the target
   itself. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let scan: typeof import('./series-cast-scan.js');
let BookStateUnreadableError: typeof import('./book-op-lock.js').BookStateUnreadableError;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-series-scan-unreadable-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  scan = await import('./series-cast-scan.js');
  ({ BookStateUnreadableError } = await import('./book-op-lock.js'));
  /* `Aaa/S/Odd` sorts first; its state.json is a directory. */
  mkdirSync(join(workspaceRoot, 'books', 'Aaa', 'S', 'Odd', '.audiobook', 'state.json'), { recursive: true });
  /* `Bbb/S/Junk` does not parse: no bookId, so not this book (and not an error). */
  mkdirSync(join(workspaceRoot, 'books', 'Bbb', 'S', 'Junk', '.audiobook'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'books', 'Bbb', 'S', 'Junk', '.audiobook', 'state.json'), '{ not json');
  const zed = join(workspaceRoot, 'books', 'Zed', 'Saga', 'Book');
  mkdirSync(join(zed, '.audiobook'), { recursive: true });
  writeFileSync(
    join(zed, '.audiobook', 'state.json'),
    JSON.stringify({ bookId: 'zed__saga__book', author: 'Zed', series: 'Saga', title: 'Book', chapters: [] }),
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('findAuthorSeriesForBookId with an unreadable sibling', () => {
  it('finds a readable book that sorts after it', async () => {
    expect(await scan.findAuthorSeriesForBookId('zed__saga__book')).toEqual({ author: 'Zed', series: 'Saga' });
  });

  it('fails with the curated error when nothing matched (the unreadable folder may be the book)', async () => {
    const err = await scan.findAuthorSeriesForBookId('nobody__s__here').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookStateUnreadableError);
    /* The raw fs error's message embeds the absolute path. */
    expect((err as Error).message).not.toContain(workspaceRoot);
    expect((err as Error).message).not.toContain('state.json');
  });
});
