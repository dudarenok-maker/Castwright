/* Durable guard regression — PUT /:bookId/state slice=cast must never strip a
   designed Qwen voice off a GENERATED character (the 2026-06-05 The Drowning Bell
   incident).

   A generated character stores its bespoke voice in `overrideTtsVoices.qwen`
   with NO `voiceId` (unlike a reused character). The srv-14 denormalise pass
   only fills voices for REUSED characters (it walks `matchedFrom`), so it can't
   protect a generated one. When the analysing→cast-confirm flow persisted a
   voiceless in-memory cast, the PUT overwrote cast.json and erased the designed
   voice. `preserveDesignedVoicesOnCastWrite` (wired ahead of the denormalise
   pass) fills the dropped voice-design fields from the on-disk character.

   Kept in its own fast-tier file (NOT book-state.test.ts, pinned slow) so the
   fixture setup doesn't compound the slow-run hook-timeout pressure. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Preserve Author';
const SERIES = 'Preserve Series';
const TITLE = 'Only Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;

function writeBook(dir: string, id: string, characters: unknown[]): void {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${TITLE}`,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

function onDiskCast(): { characters: Array<Record<string, unknown> & { id: string }> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-preserve-voices-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  /* Berrin — a GENERATED character (no voiceId): her designed voice lives
     only in overrideTtsVoices.qwen. */
  writeBook(bookDir, bookId, [
    {
      id: 'berrin',
      name: 'Berrin',
      role: 'minor',
      color: '#abc',
      voiceState: 'generated',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
      voiceStyle: 'a wry, steady woman',
    },
  ]);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('book-state PUT cast — designed-voice preservation (durable strip guard)', () => {
  it('preserves a generated character\'s designed voice when the UI sends a voiceless cast', async () => {
    /* The strip payload: the cast-confirm flow re-derived the roster and lost
       Berrin's voice fields entirely. */
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [{ id: 'berrin', name: 'Berrin', role: 'minor', color: '#abc', voiceState: 'generated' }],
      },
    };
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    expect(res.status).toBe(204);

    const berrin = onDiskCast().characters.find((c) => c.id === 'berrin')!;
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
    expect(berrin.ttsEngine).toBe('qwen');
    expect(berrin.voiceStyle).toBe('a wry, steady woman');
  });

  it('lets a deliberate re-design overwrite the on-disk voice (incoming wins)', async () => {
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [
          {
            id: 'berrin',
            name: 'Berrin',
            role: 'minor',
            color: '#abc',
            voiceState: 'generated',
            ttsEngine: 'qwen',
            overrideTtsVoices: { qwen: { name: 'qwen-berrin-v2' } },
          },
        ],
      },
    };
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    expect(res.status).toBe(204);

    const berrin = onDiskCast().characters.find((c) => c.id === 'berrin')!;
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin-v2' } });
  });
});
