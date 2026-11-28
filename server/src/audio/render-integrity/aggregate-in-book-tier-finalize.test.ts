/* #3518 pass-3 P3-1 — a partial write by ANOTHER character rewrites the chapter file's `modelKey` and
   carries an untouched character's snapshot and segments forward verbatim. A legacy character (no
   segment stamp, #4225) must therefore stay an UNKNOWN-tier anchor: the chapter-level key no longer
   describes that character's takes. Driven through the real finalizeChapterAudioWrite + scoreBook. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { auditionSpy } = vi.hoisted(() => {
  const unit = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  return {
    auditionSpy: vi.fn(async () => ({ centroid: unit, embeddings: Array.from({ length: 12 }, () => unit), kind: 'audition' as const })),
  };
});
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { finalizeChapterAudioWrite } from '../finalize-chapter-write.js';
import { scoreBook } from './aggregate.js';
import { readCentroids } from './centroids-io.js';
import { castJsonPath, makeBookId } from '../../workspace/paths.js';

const T06 = 'qwen3-tts-0.6b';
const T17 = 'qwen3-tts-1.7b';
const SR = 8000;
const tone = (sec: number) => {
  const n = Math.round(sec * SR);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  return b;
};
const vec = (axis: number, i: number) => {
  const v = new Array(8).fill(0);
  v[axis] = 1;
  v[(axis + 2) % 8] = i * 0.005;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / n));
};

const CHAPTERS = [{ id: 1, slug: 'ch1' }];
const CASTOR = { id: 'castor', name: 'Castor', gender: 'male', attributes: [], overrideTtsVoices: { qwen: { name: 'Castor voice', libraryUuid: 'cq' } } };
const BRAM = { id: 'bram', name: 'Bram', gender: 'male', attributes: [], overrideTtsVoices: { qwen: { name: 'Bram voice', libraryUuid: 'bq' } } };
const hist = { schema: 1, supersededBy: {} } as never;

let workspaceRoot: string;
let bookDir: string;
let bookId: string;

beforeEach(() => {
  auditionSpy.mockClear();
  workspaceRoot = mkdtempSync(join(tmpdir(), 'in-book-tier-finalize-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookId = makeBookId('A', 'S', 'T');
  bookDir = join(workspaceRoot, 'books', 'A', 'S', 'T');
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'x');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId, manuscriptId: 'm', title: 'T', author: 'A', series: 'S', seriesPosition: null, isStandalone: true,
      manuscriptFile: 'manuscript.txt', castConfirmed: true,
      chapters: CHAPTERS.map((c) => ({ id: c.id, title: `C${c.id}`, slug: c.slug, duration: '0:00' })),
      coverGradient: ['#000', '#fff'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(castJsonPath(bookDir), JSON.stringify({ characters: [CASTOR, BRAM] }));
});
afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const readSegs = () => JSON.parse(readFileSync(join(bookDir, 'audio', 'ch1.segments.json'), 'utf8'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ch1 fully rendered at 0.6B: 12 Castor lines + 1 Bram line. */
async function renderAt06() {
  const segments = [
    ...Array.from({ length: 12 }, (_, i) => ({ groupIndex: i, characterId: 'castor', sentenceIds: [i], startSec: i * 0.1, endSec: i * 0.1 + 0.1, voiceName: 'qwen-cq' })),
    { groupIndex: 12, characterId: 'bram', sentenceIds: [12], startSec: 1.2, endSec: 1.3, voiceName: 'qwen-bq' },
  ];
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
    segments, cast: [CASTOR, BRAM] as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey: T06,
    audioFormat: 'mp3', resynthesizedIndices: 'all',
    embeddings: [
      ...Array.from({ length: 12 }, (_, i) => ({ characterId: 'castor', sentenceIds: [i], vec: vec(0, i) })),
      { characterId: 'bram', sentenceIds: [12], vec: vec(5, 0) },
    ],
  });
}

/** Strip Castor to its pre-2026-07-06 shape: unstamped segments and no snapshot tier key of any kind. */
function makeCastorLegacy() {
  const f = readSegs();
  for (const k of ['modelKey', 'renderedModelKey', 'renderedAt', 'renderedEngine']) delete f.characterSnapshots.castor[k];
  for (const s of f.segments) if (s.characterId === 'castor') delete s.renderedModelKey;
  writeFileSync(join(bookDir, 'audio', 'ch1.segments.json'), JSON.stringify(f));
}

/** Re-record ONLY Bram's line at 1.7B (qa-repair / Fix audio on another character). */
async function rerecordBramAt17() {
  await wait(30);
  const back = readSegs();
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
    segments: back.segments, cast: [CASTOR, BRAM] as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey: T17,
    audioFormat: 'mp3', resynthesizedIndices: [12],
    reembeddedRows: [{ characterId: 'bram', sentenceIds: [12], vec: vec(5, 1) }],
  });
}

async function castorRow() {
  await scoreBook(bookDir, CHAPTERS);
  const row = (await readCentroids(bookDir))!['castor'];
  expect(row.referenceKind).toBe('in-book');
  return row;
}

describe('scoreBook after a real partial finalize — a legacy unstamped character is an unknown-tier anchor (#3518 P3-1)', () => {
  it("legacy Castor (no tier key) is NOT stamped 1.7B after Bram's line is re-recorded at 1.7B: no stamp at all", async () => {
    await renderAt06();
    makeCastorLegacy();
    await rerecordBramAt17();
    expect(readSegs().modelKey).toBe(T17); // the chapter-level key moved...
    expect(readSegs().characterSnapshots.castor.modelKey).toBeUndefined(); // ...while Castor's snapshot was carried forward untouched
    expect((await castorRow()).inBookModelKey).toBeUndefined();
  });

  it('legacy Castor carries no stamp before the rewrite either (the chapter key is never trusted)', async () => {
    await renderAt06();
    makeCastorLegacy();
    expect((await castorRow()).inBookModelKey).toBeUndefined();
  });

  it("control: a modern (stamped) Castor stays stamped 0.6B after Bram's line is re-recorded at 1.7B", async () => {
    await renderAt06();
    await rerecordBramAt17();
    expect((await castorRow()).inBookModelKey).toBe(T06);
  });
});
