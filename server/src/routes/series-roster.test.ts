/* Integration tests for the series-roster route.

   Seeds a tempdir workspace with three the Hollow Tide books (two confirmed, one
   not), one standalone, and one book in a different series, then asserts
   the GET endpoint returns only the in-series confirmed cast for a given
   bookId. Mirrors the series-cast-scan.test.ts fixture shape so the
   coverage stays consistent with the underlying scan. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Shannon Messenger';
const SERIES = 'The Hollow Tide';

let workspaceRoot: string;
let app: Express;
let keeperBookId: string;
let bonusBookId: string;
let unlockedBookId: string;
let standaloneBookId: string;
let siblingBookId: string;

function seed(
  workspace: string,
  author: string,
  series: string,
  title: string,
  opts: {
    confirmed: boolean;
    characters: Array<{
      id: string;
      name: string;
      voiceId?: string;
      aliases?: string[];
      gender?: string;
      ageRange?: string;
    }>;
    isStandalone?: boolean;
  },
): string {
  const bookId = `${author.toLowerCase().replace(/\s+/g, '-')}__${series.toLowerCase().replace(/\s+/g, '-')}__${title.toLowerCase().replace(/\s+/g, '-')}`;
  const dir = join(workspace, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${title.toLowerCase().replace(/\s+/g, '_')}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: opts.isStandalone === true,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: opts.confirmed,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: opts.characters.map((c) => ({ role: 'character', color: 'unset', ...c })),
    }),
  );
  return bookId;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-series-roster-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  keeperBookId = seed(workspaceRoot, AUTHOR, SERIES, 'The Hollow Tide', {
    confirmed: true,
    characters: [
      { id: 'narrator', name: 'Narrator' },
      {
        id: 'wren',
        name: 'Wren',
        voiceId: 'v_wren',
        aliases: ['Wren Sparrow'],
        gender: 'female',
        ageRange: 'teen',
      },
      { id: 'hart', name: 'Hart', voiceId: 'v_hart', gender: 'male', ageRange: 'teen' },
    ],
  });
  bonusBookId = seed(workspaceRoot, AUTHOR, SERIES, 'the Coalfall Commission', {
    confirmed: true,
    characters: [
      { id: 'marlow', name: 'Marlow', voiceId: 'v_marlow' },
      { id: 'ro', name: 'Ro', voiceId: 'v_ro' },
    ],
  });
  unlockedBookId = seed(workspaceRoot, AUTHOR, SERIES, 'Unlocked', {
    confirmed: false,
    characters: [{ id: 'narrator', name: 'Narrator' }],
  });
  standaloneBookId = seed(workspaceRoot, AUTHOR, SERIES, 'Some Standalone', {
    confirmed: true,
    isStandalone: true,
    characters: [{ id: 'lonely', name: 'Lonely Speaker' }],
  });
  siblingBookId = seed(workspaceRoot, AUTHOR, 'Different Series', 'Sibling Book', {
    confirmed: true,
    characters: [{ id: 'unrelated', name: 'Unrelated' }],
  });

  const { seriesRosterRouter } = await import('./series-roster.js');
  app = express();
  app.use('/api/books', seriesRosterRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/books/:bookId/series-roster', () => {
  it('returns confirmed series-mates for an in-series book, excluding itself', async () => {
    const res = await request(app).get(`/api/books/${keeperBookId}/series-roster`);
    expect(res.status).toBe(200);
    /* Keeper itself excluded → Bonus Marlow's 2 characters remain. */
    expect(res.body.characters).toHaveLength(2);
    const names = (res.body.characters as Array<{ name: string }>).map((c) => c.name).sort();
    expect(names).toEqual(['Marlow', 'Ro']);
  });

  it('preserves voiceId, aliases, gender, ageRange on each entry', async () => {
    /* Query from Unlocked's vantage so Keeper #1's full cast surfaces. */
    const res = await request(app).get(`/api/books/${unlockedBookId}/series-roster`);
    expect(res.status).toBe(200);
    const wren = (
      res.body.characters as Array<{
        name: string;
        voiceId?: string;
        aliases?: string[];
        gender?: string;
        ageRange?: string;
        bookId: string;
        bookTitle: string;
      }>
    ).find((c) => c.name === 'Wren');
    expect(wren).toBeDefined();
    expect(wren?.voiceId).toBe('v_wren');
    expect(wren?.aliases).toEqual(['Wren Sparrow']);
    expect(wren?.gender).toBe('female');
    expect(wren?.ageRange).toBe('teen');
    expect(wren?.bookId).toBe(keeperBookId);
    expect(wren?.bookTitle).toBe('The Hollow Tide');
  });

  it('excludes unconfirmed casts and standalones', async () => {
    const res = await request(app).get(`/api/books/${bonusBookId}/series-roster`);
    expect(res.status).toBe(200);
    const ids = (res.body.characters as Array<{ id: string }>).map((c) => c.id);
    /* Bonus excluded itself. Keeper #1 surfaces 3. Unlocked is unconfirmed
       (excluded). Standalone excluded by isStandalone gate. Sibling Book
       is in a different series (excluded). */
    expect(ids.sort()).toEqual(['hart', 'narrator', 'wren']);
  });

  it('excludes books in a different series even when the author matches', async () => {
    const res = await request(app).get(`/api/books/${keeperBookId}/series-roster`);
    expect(res.status).toBe(200);
    const ids = (res.body.characters as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain('unrelated');
  });

  it('returns 200 with empty characters for a standalone book', async () => {
    /* A standalone book asking "who else is in my series" can still see
       the series regulars (see series-cast-scan.test.ts §"returns [] for
       a standalone book" — the standalone's own cast is the thing that
       doesn't flow back). For Some Standalone, sitting under the the Hollow Tide
       folder, that means it sees the Hollow Tide #1 + Bonus Marlow = 5 characters. */
    const res = await request(app).get(`/api/books/${standaloneBookId}/series-roster`);
    expect(res.status).toBe(200);
    expect(res.body.characters).toHaveLength(5);
  });

  it('returns 200 with empty characters for an unknown bookId', async () => {
    const res = await request(app).get('/api/books/does__not__exist/series-roster');
    expect(res.status).toBe(200);
    expect(res.body.characters).toEqual([]);
  });

  it('does not include the sibling-series book in its own series-roster', async () => {
    /* The book in "Different Series" only sees its own series. Since
       it's the only book there, the roster is empty. */
    const res = await request(app).get(`/api/books/${siblingBookId}/series-roster`);
    expect(res.status).toBe(200);
    expect(res.body.characters).toEqual([]);
  });
});
