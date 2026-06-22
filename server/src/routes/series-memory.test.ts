// server/src/routes/series-memory.test.ts
// TDD: write failing test first, then implement the route.
// Uses a temp-workspace fixture matching the pattern from series-memory-scan.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Router } from 'express';

let root: string;
let seriesMemoryRouter: Router;

// Build the app INLINE per the repo pattern — there is NO shared make-app util.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/library', seriesMemoryRouter);
  return app;
}

function writeBook(
  author: string,
  series: string,
  title: string,
  pos: number,
  chars: unknown[],
  confirmed = true,
) {
  const dir = join(root, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.txt'), 'x');
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: `kell__ninth-house__${title.toLowerCase()}`,
      manuscriptId: `mid-${title.toLowerCase()}`,
      title,
      author,
      series,
      seriesPosition: pos,
      isStandalone: false,
      castConfirmed: confirmed,
      manuscriptFile: 'manuscript.txt',
      chapters: [], // 0 chapters → analysisComplete=true → castConfirmed drives status to 'complete'
      coverGradient: ['#000', '#fff'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  );
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: chars }),
  );
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'fe40-route-'));
  process.env.WORKSPACE_DIR = root;

  const c = (
    id: string,
    name: string,
    vid: string,
    from?: { bookId: string; characterId: string },
  ) => ({
    id,
    name,
    voiceId: vid,
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'some-qwen-voice' } },
    lines: Array(20).fill({}), // 20 lines > PRINCIPAL_LINE_FLOOR (5)
    matchedFrom: from ?? null,
  });

  const b1Id = 'kell__ninth-house__one';
  const b2Id = 'kell__ninth-house__two';

  writeBook('Kell', 'Ninth House', 'One', 1, [
    c('marrow', 'Marrow', 'vqm'),
    c('edda', 'Edda', 'vqe'),
    c('vale', 'Vale', 'vqv'),
  ]);
  writeBook('Kell', 'Ninth House', 'Two', 2, [
    c('marrow', 'Marrow', 'vqm', { bookId: b1Id, characterId: 'marrow' }),
    c('edda', 'Edda', 'vqe', { bookId: b1Id, characterId: 'edda' }),
    c('vale', 'Vale', 'vqv', { bookId: b1Id, characterId: 'vale' }),
  ]);
  writeBook('Kell', 'Ninth House', 'Three', 3, [
    c('marrow', 'Marrow', 'vqm', { bookId: b2Id, characterId: 'marrow' }),
    c('edda', 'Edda', 'vqe', { bookId: b2Id, characterId: 'edda' }),
    c('vale', 'Vale', 'vqv', { bookId: b2Id, characterId: 'vale' }),
  ]);

  // Dynamic import AFTER setting WORKSPACE_DIR so paths.ts picks up the temp root
  seriesMemoryRouter = (await import('./series-memory.js')).seriesMemoryRouter;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/library/series-memory', () => {
  it('returns the carried roster for a series above threshold', async () => {
    const res = await request(makeApp())
      .get('/api/library/series-memory')
      .query({ author: 'Kell', series: 'Ninth House' });
    expect(res.status).toBe(200);
    expect(res.body.carried.count).toBe(3);
    expect(res.body.carried.characters[0].voiceKind).toBe('designed');
  });

  it('404s for a series not found or below threshold', async () => {
    const res = await request(makeApp())
      .get('/api/library/series-memory')
      .query({ author: 'Nobody', series: 'None' });
    expect(res.status).toBe(404);
  });

  it('400s when author or series query param is missing', async () => {
    const res = await request(makeApp()).get('/api/library/series-memory').query({ author: 'Kell' });
    expect(res.status).toBe(400);
  });
});
