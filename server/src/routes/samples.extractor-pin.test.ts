/* #4217 child 5 -- a sample parses its manuscript with the extractor version its
   bundle's stamp names (absent = 1), because the bundle ships a
   manuscript-edits.json made against that extraction. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { buildEpub } from '../test-utils/empty-href-epub.js';

const CHAPTER =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' +
  '<div class="p">First para one.</div><div class="p">First para two.</div></body></html>';

let workspaceRoot: string;
let samplesRoot: string;
let app: Express;
let resetSamples: () => void;

async function writeBundle(slug: string, title: string, extra: Record<string, unknown>) {
  const dir = join(samplesRoot, slug);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.epub'), await buildEpub([CHAPTER]));
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: 'bundle',
      manuscriptId: 'mns_bundle',
      title,
      author: 'Pin Test',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'One', slug: '01-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    }),
  );
}

const workspaceState = (title: string) =>
  JSON.parse(
    readFileSync(
      join(workspaceRoot, 'books', 'Pin Test', 'Standalones', title, '.audiobook', 'state.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-samples-pin-ws-'));
  samplesRoot = mkdtempSync(join(tmpdir(), 'audiobook-samples-pin-src-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { samplesRouter, setSamplesRoot, _resetSamplesRoot } = await import('./samples.js');
  setSamplesRoot(samplesRoot);
  resetSamples = _resetSamplesRoot;
  app = express();
  app.use(express.json());
  app.use('/api/samples', samplesRouter);
});

afterAll(() => {
  resetSamples?.();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (samplesRoot) rmSync(samplesRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('samples parse with the bundle extractor stamp', () => {
  it('S1: an unstamped bundle loads as version 1 (unsplit) and the copy stays unstamped', async () => {
    await writeBundle('pin-unstamped', 'Pin Unstamped', {});
    const res = await request(app).post('/api/samples/pin-unstamped/load');
    expect(res.status).toBe(200);
    const state = workspaceState('Pin Unstamped');
    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(state.manuscriptId as string)!.sourceText).not.toContain('\n\n');
    expect('manuscriptExtractorVersion' in state).toBe(false);
  });

  it('S1: a bundle stamped 2 loads split and the copy carries 2', async () => {
    await writeBundle('pin-stamped', 'Pin Stamped', { manuscriptExtractorVersion: 2 });
    const res = await request(app).post('/api/samples/pin-stamped/load');
    expect(res.status).toBe(200);
    const state = workspaceState('Pin Stamped');
    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(state.manuscriptId as string)!.sourceText).toContain('\n\n');
    expect(state.manuscriptExtractorVersion).toBe(2);
  });
});
