/* Integration tests for the audio-QA repair router. Mirrors the fs-26 splice
   harness: WORKSPACE_DIR → tempdir before import, scaffold a book with a REAL
   rendered chapter (one healthy segment + one dead/silent segment, encoded via
   the actual encoder), then drive the repair through supertest.

   The dry-run SCAN is the new logic under test and needs no sidecar — it reads
   the rendered PCM back and flags the silent segment. The non-dry-run re-record
   path's synth+splice mechanics are covered by the segment-qa gate +
   build-synth-replacement + splice-chapter unit tests; here we only assert it
   degrades gracefully when there's nothing to re-synthesise from. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Repair Author';
const SERIES = 'Standalones';
const TITLE = 'Repair Story';
const SLUG = 'chapter-one';
const SR = 24_000;

let workspaceRoot: string;
let audioRoot: string;
let app: Express;
let bookId: string;

function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-repair-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ chapterQaRepairRouter }, { makeBookId }, mp3] = await Promise.all([
    import('./chapter-qa-repair.js'),
    import('../workspace/paths.js'),
    import('../tts/mp3.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_repair_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:02' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'amy', name: 'Amy', gender: 'female', attributes: [] },
        { id: 'castor', name: 'Castor', gender: 'female', attributes: [] },
      ],
    }),
  );

  /* Real chapter: 1s loud Amy (healthy) + 1s of DEAD SILENCE for Castor (a
     dropped generation). Encoded via the real MP3 encoder so the route's
     decode→scan pipeline runs against true bytes. */
  const amy = tone(1.0, 12000);
  const castorSilent = Buffer.alloc(SR * 2); // 1s of zeros
  const chapterPcm = Buffer.concat([amy, castorSilent]);
  const mp3Bytes = await mp3.encodePcmToAudio(chapterPcm, SR, { format: 'mp3', quality: 2 });
  writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3Bytes);
  writeFileSync(
    join(audioRoot, `${SLUG}.segments.json`),
    JSON.stringify({
      bookId,
      chapterId: 1,
      chapterTitle: 'Chapter 1',
      durationSec: 2.0,
      sampleRate: SR,
      modelKey: 'kokoro-v1',
      synthesizedAt: new Date().toISOString(),
      segments: [
        { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0 },
        { groupIndex: 1, characterId: 'castor', sentenceIds: [2], startSec: 1.0, endSec: 2.0 },
      ],
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', chapterQaRepairRouter);
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (dry-run scan)', () => {
  it('flags the dead/silent segment and leaves the audio untouched', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: true });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got ${res.text}`).toBeTruthy();
    expect(done!.dryRun).toBe(true);

    const flagged = done!.flagged as Array<{ segmentIndex: number; reasons: string[] }>;
    expect(flagged).toHaveLength(1);
    expect(flagged[0].segmentIndex).toBe(1); // Castor's silent segment
    expect(flagged[0].reasons.some((r) => /silent/i.test(r))).toBe(true);
    expect(done!.repaired).toEqual([]);

    // Dry run writes nothing — no rollback snapshot created.
    expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(false);
  });
});

describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (repair)', () => {
  it('fails gracefully when flagged segments have no cached analysis to re-synthesise', async () => {
    // No analysis cache for this fixture, so the re-record can't find sentences
    // → clean chapter_failed (not a crash). The scan still runs first.
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'qa_scan' || e.type === 'splice_start')).toBe(true);
    expect(events.some((e) => e.type === 'chapter_failed')).toBe(true);
  });

  it('rejects an unknown book', async () => {
    const res = await request(app)
      .post('/api/books/nope/chapters/1/audio-qa-repair')
      .send({ dryRun: true });
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'chapter_failed')).toBe(true);
  });
});
