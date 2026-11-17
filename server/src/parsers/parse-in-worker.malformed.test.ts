import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBrokenOpfEpub,
  buildEmptyHrefEpub,
  buildMissingNcxTargetEpub,
  buildTruncatedEpub,
} from '../test-utils/empty-href-epub.js';
import { parseEpub, UnusableEpubError } from './epub.js';
import { parseManuscript } from './index.js';

/* Malformed-EPUB corpus through the parse worker (#4289). Outcomes are pinned
   to what in-process parsing does at BASE (probe, #4289 receipt):
     empty href   -> parses, 1 chapter
     broken OPF   -> CRASH (uncatchable epub2 throw in-process) -> worker: 415
     missing NCX  -> parses, 1 chapter
     truncated    -> plain Error from yauzl (500 today; not reclassified) */
const CRASH_SENTENCE = 'This EPUB could not be read: the file appears to be malformed.';
const SAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample.epub');

type Shape = {
  name: string;
  build: () => Promise<Buffer>;
  outcome: 'ok' | 'crash' | 'error';
  status: number;
};
const SHAPES: Shape[] = [
  { name: 'empty-href', build: buildEmptyHrefEpub, outcome: 'ok', status: 200 },
  { name: 'broken-opf', build: buildBrokenOpfEpub, outcome: 'crash', status: 415 },
  { name: 'missing-ncx', build: buildMissingNcxTargetEpub, outcome: 'ok', status: 200 },
  { name: 'truncated', build: buildTruncatedEpub, outcome: 'error', status: 500 },
];

describe('parseManuscript: malformed EPUBs match in-process outcomes', () => {
  for (const s of SHAPES) {
    it(`${s.name}`, async () => {
      const buffer = await s.build();
      const fileName = `${s.name}.epub`;
      if (s.outcome === 'ok') {
        const expected = await parseEpub(buffer, { fileName });
        await expect(parseManuscript({ buffer, fileName })).resolves.toStrictEqual(expected);
      } else if (s.outcome === 'crash') {
        const err = await parseManuscript({ buffer, fileName }).catch((e) => e);
        expect(err).toBeInstanceOf(UnusableEpubError);
        expect((err as Error).message).toBe(CRASH_SENTENCE);
      } else {
        const expected = await parseEpub(buffer, { fileName }).catch((e) => e);
        const err = await parseManuscript({ buffer, fileName }).catch((e) => e);
        expect(expected).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).constructor).toBe((expected as Error).constructor);
        expect((err as Error).message).toBe((expected as Error).message);
      }
    });
  }
});

describe('POST /api/import: malformed EPUBs answer the in-process outcome', () => {
  let workspaceRoot: string;
  let app: Express;
  beforeAll(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-import-malformed-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
    const { importRouter } = await import('../routes/import.js');
    app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api', importRouter);
  });
  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  for (const s of SHAPES) {
    it(`${s.name} -> ${s.status}`, async () => {
      const res = await request(app)
        .post('/api/import')
        .attach('file', await s.build(), { filename: `${s.name}.epub`, contentType: 'application/epub+zip' });
      expect(res.status).toBe(s.status);
    });
  }

  it('a sample.epub import right after the malformed ones answers 200', async () => {
    const res = await request(app)
      .post('/api/import')
      .attach('file', await readFile(SAMPLE), { filename: 'sample.epub', contentType: 'application/epub+zip' });
    expect(res.status).toBe(200);
  });
});
