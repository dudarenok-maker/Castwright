/* srv-14 regression — PUT /:bookId/state slice=cast denormalises a reused
   character's bespoke (qwen) voice from its source book at write time.

   The auto-match apply path stamps `matchedFrom` + `voiceId` +
   `voiceState:'reused'` on the frontend, then persists through the generic
   PUT /state cast funnel — but never copies the source character's designed
   voice (`ttsEngine` + `overrideTtsVoices.qwen`). This test asserts the
   server-side denormalisation pass fills those fields so on-disk cast.json is
   self-complete after an auto-match (no read-time hydration needed).

   Kept in its own fast-tier file (NOT book-state.test.ts, which is pinned to
   the slow config) so the two-book fixture setup doesn't compound the
   hook-timeout pressure on the slow run. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Reuse Author';
const SERIES = 'Reuse Series';
const SOURCE_TITLE = 'Book One';
const TARGET_TITLE = 'Book Two';

let workspaceRoot: string;
let app: Express;
let sourceBookId: string;
let targetBookId: string;
let targetBookDir: string;

function writeBook(
  bookDir: string,
  bookId: string,
  title: string,
  characters: unknown[],
): void {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${title}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: title === SOURCE_TITLE ? 1 : 2,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-reuse-denorm-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  sourceBookId = makeBookId(AUTHOR, SERIES, SOURCE_TITLE);
  targetBookId = makeBookId(AUTHOR, SERIES, TARGET_TITLE);

  const booksRoot = join(workspaceRoot, 'books', AUTHOR, SERIES);
  /* Source book — Wren carries the designed qwen voice. */
  writeBook(join(booksRoot, SOURCE_TITLE), sourceBookId, SOURCE_TITLE, [
    {
      id: 'wren',
      name: 'Wren',
      role: 'protagonist',
      color: '#abc',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'voice_wren_designed' } },
      voiceStyle: 'a poised, confident teenage girl',
    },
  ]);
  targetBookDir = join(booksRoot, TARGET_TITLE);
  writeBook(targetBookDir, targetBookId, TARGET_TITLE, []);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('book-state PUT cast — reused-voice denormalisation (srv-14)', () => {
  it('stamps ttsEngine + overrideTtsVoices.qwen onto a reused character at write time', async () => {
    /* Mirrors what applyVoiceMatches → persistence-middleware sends: identity
       fields (voiceId/matchedFrom/voiceState) but NO bespoke voice fields. */
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [
          {
            id: 'wren',
            name: 'Wren',
            role: 'protagonist',
            color: '#def',
            voiceId: 'wren',
            voiceState: 'reused',
            matchedFrom: {
              bookId: sourceBookId,
              characterId: 'wren',
              bookTitle: SOURCE_TITLE,
              confidence: 0.92,
            },
          },
        ],
      },
    };
    const res = await request(app)
      .put(`/api/books/${targetBookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    expect(res.status).toBe(204);

    const onDisk = JSON.parse(
      readFileSync(join(targetBookDir, '.audiobook', 'cast.json'), 'utf8'),
    );
    const wren = onDisk.characters.find((c: { id: string }) => c.id === 'wren');
    expect(wren.ttsEngine).toBe('qwen');
    expect(wren.overrideTtsVoices.qwen.name).toBe('voice_wren_designed');
    /* The persona is denormalised the same way (srv-18). */
    expect(wren.voiceStyle).toBe('a poised, confident teenage girl');
    /* Identity fields survive the pass untouched. */
    expect(wren.voiceState).toBe('reused');
    expect(wren.matchedFrom.bookId).toBe(sourceBookId);
  });

  it('leaves a character that already owns a qwen voice untouched', async () => {
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [
          {
            id: 'wren',
            name: 'Wren',
            role: 'protagonist',
            color: '#def',
            voiceId: 'wren',
            voiceState: 'reused',
            ttsEngine: 'qwen',
            overrideTtsVoices: { qwen: { name: 'own_explicit_voice' } },
            matchedFrom: {
              bookId: sourceBookId,
              characterId: 'wren',
              bookTitle: SOURCE_TITLE,
              confidence: 0.92,
            },
          },
        ],
      },
    };
    const res = await request(app)
      .put(`/api/books/${targetBookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    expect(res.status).toBe(204);

    const onDisk = JSON.parse(
      readFileSync(join(targetBookDir, '.audiobook', 'cast.json'), 'utf8'),
    );
    const wren = onDisk.characters.find((c: { id: string }) => c.id === 'wren');
    expect(wren.overrideTtsVoices.qwen.name).toBe('own_explicit_voice');
  });

  it('passes through a non-reused character (no matchedFrom) unchanged', async () => {
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [{ id: 'newchar', name: 'NewChar', role: 'minor', color: '#111' }],
      },
    };
    const res = await request(app)
      .put(`/api/books/${targetBookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    expect(res.status).toBe(204);

    const onDisk = JSON.parse(
      readFileSync(join(targetBookDir, '.audiobook', 'cast.json'), 'utf8'),
    );
    const c = onDisk.characters.find((x: { id: string }) => x.id === 'newchar');
    expect(c.overrideTtsVoices).toBeUndefined();
    expect(c.ttsEngine).toBeUndefined();
  });
});
