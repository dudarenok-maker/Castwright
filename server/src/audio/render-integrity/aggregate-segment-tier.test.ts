/* #4225 — the in-book row's tier is read from each anchor segment's own `renderedModelKey` stamp,
   never inferred from the chapter snapshot's keys. Driven through the real
   finalizeChapterAudioWrite + scoreBook. */
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
import { readCentroids, auditionCentroidUsableForCurrent, IN_BOOK_MIXED_TIER } from './centroids-io.js';
import { castJsonPath, makeBookId } from '../../workspace/paths.js';
import type { TtsModelKey } from '../../tts/index.js';

const T06: TtsModelKey = 'qwen3-tts-0.6b';
const T17: TtsModelKey = 'qwen3-tts-1.7b';
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
/* Lines 0-11 are Castor's, line 12 is Bram's. */
const CASTOR_LINES = Array.from({ length: 12 }, (_, i) => i);
const BRAM_LINE = 12;

let workspaceRoot: string;
let bookDir: string;
let bookId: string;

beforeEach(() => {
  auditionSpy.mockClear();
  workspaceRoot = mkdtempSync(join(tmpdir(), 'segment-tier-score-'));
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

const segPath = () => join(bookDir, 'audio', 'ch1.segments.json');
const readSegs = () => JSON.parse(readFileSync(segPath(), 'utf8'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ch1 fully rendered at 0.6B: 12 Castor lines + 1 Bram line. */
async function renderAt06() {
  const segments = [
    ...CASTOR_LINES.map((i) => ({ groupIndex: i, characterId: 'castor', sentenceIds: [i], startSec: i * 0.1, endSec: i * 0.1 + 0.1, voiceName: 'qwen-cq' })),
    { groupIndex: BRAM_LINE, characterId: 'bram', sentenceIds: [BRAM_LINE], startSec: 1.2, endSec: 1.3, voiceName: 'qwen-bq' },
  ];
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
    segments, cast: [CASTOR, BRAM] as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey: T06,
    audioFormat: 'mp3', resynthesizedIndices: 'all',
    embeddings: [
      ...CASTOR_LINES.map((i) => ({ characterId: 'castor', sentenceIds: [i], vec: vec(0, i) })),
      { characterId: 'bram', sentenceIds: [BRAM_LINE], vec: vec(5, 0) },
    ],
  });
}

/** Re-record only the given lines at `modelKey` (qa-repair / Fix audio). */
async function rerecord(indices: number[], modelKey: TtsModelKey) {
  await wait(30);
  const back = readSegs();
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
    segments: back.segments, cast: [CASTOR, BRAM] as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey,
    audioFormat: 'mp3', resynthesizedIndices: indices,
    reembeddedRows: indices.map((i) =>
      i === BRAM_LINE
        ? { characterId: 'bram', sentenceIds: [i], vec: vec(5, 1) }
        : { characterId: 'castor', sentenceIds: [i], vec: vec(0, i) },
    ),
  });
}

/** Drop every segment's tier stamp: a chapter written before segments were stamped. */
function stripSegmentStamps() {
  const f = readSegs();
  for (const s of f.segments) delete s.renderedModelKey;
  writeFileSync(segPath(), JSON.stringify(f));
}

/** Strip Castor's snapshot to its pre-2026-07-06 shape: no tier key of any kind. */
function stripCastorSnapshotKeys() {
  const f = readSegs();
  for (const k of ['modelKey', 'renderedModelKey', 'renderedAt', 'renderedEngine']) delete f.characterSnapshots.castor[k];
  writeFileSync(segPath(), JSON.stringify(f));
}

async function castorRow() {
  await scoreBook(bookDir, CHAPTERS);
  const row = (await readCentroids(bookDir))!['castor'];
  expect(row.referenceKind).toBe('in-book');
  return row;
}

describe('scoreBook reads the in-book anchor tier from per-segment stamps (#4225)', () => {
  it('a re-record at 1.7B and a later one back at 0.6B leaves both tiers in the chapter: the row is mixed, usable at neither', async () => {
    await renderAt06();
    await rerecord([0], T17);
    await rerecord([1], T06);
    /* The snapshot's two keys agree again, although line 0 is still a 1.7B take. */
    expect(readSegs().characterSnapshots.castor).toMatchObject({ modelKey: T06, renderedModelKey: T06 });
    expect(readSegs().segments[0].renderedModelKey).toBe(T17);

    const row = await castorRow();

    expect(row.inBookModelKey).toBe(IN_BOOK_MIXED_TIER);
    expect(auditionCentroidUsableForCurrent(row, 'qwen-cq', T06)).toBe(false);
    expect(auditionCentroidUsableForCurrent(row, 'qwen-cq', T17)).toBe(false);
  });

  it("a legacy Castor is not stamped with the tier another character's re-record moved onto the chapter", async () => {
    await renderAt06();
    stripSegmentStamps();
    stripCastorSnapshotKeys();
    await rerecord([BRAM_LINE], T17);
    await rerecord([0], T17);
    /* Finalize's freeze seed copied the moved chapter key onto Castor's snapshot, under both keys. */
    expect(readSegs().characterSnapshots.castor).toMatchObject({ modelKey: T17, renderedModelKey: T17 });

    const row = await castorRow();

    expect(row.inBookModelKey).toBeUndefined();
    expect(auditionCentroidUsableForCurrent(row, 'qwen-cq', T17)).toBe(false);
  });

  it("a fully stamped single-tier chapter stamps that tier, whatever the snapshot's frozen key says", async () => {
    await renderAt06();
    await rerecord(CASTOR_LINES, T17);
    expect(readSegs().characterSnapshots.castor).toMatchObject({ modelKey: T17, renderedModelKey: T06 });

    const row = await castorRow();

    expect(row.inBookModelKey).toBe(T17);
    expect(auditionCentroidUsableForCurrent(row, 'qwen-cq', T17)).toBe(true);
  });

  it('a legacy chapter (no segment stamps) yields no in-book stamp, even with tier keys on its snapshot', async () => {
    await renderAt06();
    stripSegmentStamps();
    expect(readSegs().characterSnapshots.castor).toMatchObject({ modelKey: T06, renderedModelKey: T06 });

    const row = await castorRow();

    expect(row.inBookModelKey).toBeUndefined();
    expect(auditionCentroidUsableForCurrent(row, 'qwen-cq', T06)).toBe(false);
  });
});
