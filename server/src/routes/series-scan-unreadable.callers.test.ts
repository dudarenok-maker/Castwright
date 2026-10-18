/* #3711 PR #3714 review pass 4 -- `findAuthorSeriesForBookId` throws when nothing
   matched after an unreadable folder. Its callers differ in how they turn a throw
   into a response, and the raw fs error's message embeds the absolute workspace
   path, so each shape must answer a 500 whose body carries no path:
     - cast-tier lets it escape to the app's global error handler;
     - single-design catches it and answers `requestFailureMessage(e, ...)`, which
       passes any non-lock error's own message through verbatim.
   The target's state.json reads fine for the route's own resolve, then fails with
   an EBUSY whose message names the absolute path (the scan's read). */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const gate = vi.hoisted(() => ({ path: null as string | null, pass: 0, seen: 0 }));
vi.mock('../workspace/state-migrate.js', async (orig) => {
  const real = await orig<typeof import('../workspace/state-migrate.js')>();
  return {
    ...real,
    readStateJsonWithRecovery: vi.fn(async (path: string) => {
      if (gate.path && path === gate.path) {
        gate.seen += 1;
        if (gate.seen > gate.pass) {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: 'EBUSY' });
        }
      }
      return real.readStateJsonWithRecovery(path);
    }),
  };
});

const AUTHOR = 'Scan Author';
const SERIES = 'Scan Series';
const BOOK = 'Scan Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let statePath: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-scan-unreadable-callers-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { castTierRouter } = await import('./cast-tier.js');
  const { singleDesignRouter } = await import('./single-design.js');
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { voicesRouter } = await import('./voices.js');
  const { errorHandler } = await import('../error-handler.js');
  const { makeBookId, stateJsonPath } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
  statePath = stateJsonPath(dir);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'c1', name: 'Aria', role: 'lead', color: 'rose', voiceStyle: 'a warm voice' }],
    }),
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', castTierRouter);
  app.use('/api/books', singleDesignRouter);
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/voices', voicesRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  gate.path = null;
  gate.pass = 0;
  gate.seen = 0;
});

afterAll(() => {
  gate.path = null;
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('callers of findAuthorSeriesForBookId when the scan cannot read the target', () => {
  it('cast-tier (error escapes to the global handler): 500, body names no path', async () => {
    /* Count only the resolve reads: arm the gate, let the route's own resolve
       through, fail the scan. */
    gate.path = statePath;
    gate.pass = 1;
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/tier`)
      .send({ voiceId: 'v_x', ttsModelKey: null });
    expect(gate.seen).toBeGreaterThan(1); // the scan really did hit the failing read
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(workspaceRoot);
    expect(res.text).not.toContain('EBUSY');
  });

  it('single-design (caught, fixed fallback sentence): 500, body names no path', async () => {
    gate.path = statePath;
    gate.pass = 1;
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });
    expect(gate.seen).toBeGreaterThan(1);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(workspaceRoot);
    expect(res.text).not.toContain('EBUSY');
  });

  it('voices override (caught, own message passed through requestFailureMessage): 500, body names no path', async () => {
    gate.path = statePath;
    gate.pass = 0; // no resolve before the scan on this route
    const res = await request(app)
      .put('/api/voices/v_x/override')
      .send({ override: null, scope: 'series', bookId });
    expect(gate.seen).toBeGreaterThan(0);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(workspaceRoot);
    expect(res.text).not.toContain('EBUSY');
  });

  it('qwen-voice design (job registration, own message passed through requestFailureMessage): 500, body names no path', async () => {
    gate.path = statePath;
    gate.pass = 1;
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/c1/design-voice`)
      .send({ persona: 'a warm voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });
    expect(gate.seen).toBeGreaterThan(1);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(workspaceRoot);
    expect(res.text).not.toContain('EBUSY');
  });
});
