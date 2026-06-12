/* Integration tests for the series-cast route (rebaseline whole-series
   aggregation). Mirrors the series-roster.test.ts fixture shape, but the
   characters carry the FULL cast.json fields the rebaseline modal needs
   (lines, voiceStyle, overrideTtsVoices, ttsEngine) so the assertions can
   pin full-fidelity pass-through. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';

let workspaceRoot: string;
let app: Express;
let keeperBookId: string;
let bonusBookId: string;
let unlockedBookId: string;
let standaloneBookId: string;
let siblingBookId: string;

interface SeedChar {
  id: string;
  name: string;
  voiceId?: string;
  lines?: number;
  voiceStyle?: string;
  ttsEngine?: string;
  overrideTtsVoices?: Record<string, { name: string }>;
}

function seed(
  workspace: string,
  author: string,
  series: string,
  title: string,
  opts: { confirmed: boolean; characters: SeedChar[]; isStandalone?: boolean },
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-series-cast-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  keeperBookId = seed(workspaceRoot, AUTHOR, SERIES, 'The Hollow Tide', {
    confirmed: true,
    characters: [
      { id: 'narrator', name: 'Narrator', lines: 400 },
      { id: 'wren', name: 'Wren', voiceId: 'v_wren', lines: 120, voiceStyle: 'bright teen' },
      { id: 'hart', name: 'Hart', voiceId: 'v_hart', lines: 40 },
    ],
  });
  bonusBookId = seed(workspaceRoot, AUTHOR, SERIES, 'the Coalfall Commission', {
    confirmed: true,
    characters: [
      {
        id: 'marlow',
        name: 'Marlow',
        voiceId: 'v_marlow',
        lines: 90,
        voiceStyle: 'sardonic charmer',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'marlow-designed' } },
      },
      { id: 'nim', name: 'Nim', voiceId: 'v_nim', lines: 15 },
    ],
  });
  unlockedBookId = seed(workspaceRoot, AUTHOR, SERIES, 'The Floodmark', {
    confirmed: false,
    characters: [{ id: 'narrator', name: 'Narrator', lines: 10 }],
  });
  standaloneBookId = seed(workspaceRoot, AUTHOR, SERIES, 'Some Standalone', {
    confirmed: true,
    isStandalone: true,
    characters: [{ id: 'lonely', name: 'Lonely Speaker', lines: 5 }],
  });
  siblingBookId = seed(workspaceRoot, AUTHOR, 'Different Series', 'Sibling Book', {
    confirmed: true,
    characters: [{ id: 'unrelated', name: 'Unrelated', lines: 50 }],
  });

  const { seriesCastRouter } = await import('./series-cast.js');
  app = express();
  app.use('/api/books', seriesCastRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/books/:bookId/series-cast', () => {
  it('returns the full cast of every OTHER confirmed series book, excluding itself', async () => {
    const res = await request(app).get(`/api/books/${keeperBookId}/series-cast`);
    expect(res.status).toBe(200);
    /* The Hollow Tide itself excluded → Bonus Marlow's 2 characters remain. */
    const ids = (res.body.characters as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual(['marlow', 'nim']);
  });

  it('passes through full cast.json fidelity (lines / voiceStyle / overrideTtsVoices / ttsEngine)', async () => {
    /* Query from The Floodmark's vantage so The Hollow Tide #1 + Bonus surface. */
    const res = await request(app).get(`/api/books/${unlockedBookId}/series-cast`);
    expect(res.status).toBe(200);
    const marlow = (res.body.characters as Array<Record<string, unknown>>).find(
      (c) => c.id === 'marlow',
    );
    expect(marlow).toMatchObject({
      lines: 90,
      voiceStyle: 'sardonic charmer',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'marlow-designed' } },
      voiceId: 'v_marlow',
    });
    /* Provenance tags for a future consumer. */
    expect(marlow?.sourceBookId).toBe(bonusBookId);
    expect(marlow?.sourceBookTitle).toBe('the Coalfall Commission');
  });

  it('excludes unconfirmed casts and standalones', async () => {
    const res = await request(app).get(`/api/books/${bonusBookId}/series-cast`);
    expect(res.status).toBe(200);
    const ids = (res.body.characters as Array<{ id: string }>).map((c) => c.id).sort();
    /* Bonus excluded itself. The Hollow Tide #1 surfaces 3. The Floodmark unconfirmed,
       Standalone isStandalone, Sibling different-series — all excluded. */
    expect(ids).toEqual(['hart', 'narrator', 'wren']);
  });

  it('excludes books in a different series even when the author matches', async () => {
    const res = await request(app).get(`/api/books/${keeperBookId}/series-cast`);
    expect(res.status).toBe(200);
    const ids = (res.body.characters as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain('unrelated');
  });

  it('a standalone still sees its series-mates (only its own cast is excluded)', async () => {
    /* Matches the series-roster convention: a standalone sitting under a
       series folder can still aggregate that series' regulars — the thing
       that doesn't flow back is the standalone's OWN cast. Some Standalone
       sees The Hollow Tide #1 (3) + Bonus (2) = 5; its own "lonely" is excluded. */
    const res = await request(app).get(`/api/books/${standaloneBookId}/series-cast`);
    expect(res.status).toBe(200);
    const ids = (res.body.characters as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual(['hart', 'marlow', 'narrator', 'nim', 'wren']);
  });

  it('returns 200 with empty characters for an unknown bookId', async () => {
    const res = await request(app).get('/api/books/does__not__exist/series-cast');
    expect(res.status).toBe(200);
    expect(res.body.characters).toEqual([]);
  });

  it('returns 200 with empty characters for a lone book in its series', async () => {
    const res = await request(app).get(`/api/books/${siblingBookId}/series-cast`);
    expect(res.status).toBe(200);
    expect(res.body.characters).toEqual([]);
  });
});
