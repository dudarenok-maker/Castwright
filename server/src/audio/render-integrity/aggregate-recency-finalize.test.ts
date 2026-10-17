/* #3524 pass 3 P1 — the stamped engine is resolved from a per-character render time that the
   REAL finalize writes, so a partial rewrite of an older chapter (qa-repair, Fix audio, a gain
   remix) that carries an untouched character's snapshot forward cannot make that chapter look
   like the character's most recent render. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { auditionSpy, audition } = vi.hoisted(() => {
  const state = { axis: 0 };
  const unit = (axis: number) => Float32Array.from(Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0)));
  const take = (axis: number, k: number) => {
    const v = Array.from(unit(state.axis), (x) => x);
    v[(axis + 2) % 8] = k * 0.005;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return Float32Array.from(v.map((x) => x / n));
  };
  return {
    audition: state,
    auditionSpy: vi.fn(async () => ({
      centroid: unit(state.axis),
      embeddings: Array.from({ length: 12 }, (_, k) => take(state.axis, k)),
      kind: 'audition' as const,
    })),
  };
});
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { finalizeChapterAudioWrite } from '../finalize-chapter-write.js';
import { scoreBook } from './aggregate.js';
import { readCentroids } from './centroids-io.js';
import { readVerdicts } from './verdicts-io.js';
import { castJsonPath, makeBookId } from '../../workspace/paths.js';

const vec = (axis: number, i: number) => {
  const v = new Array(8).fill(0);
  v[axis] = 1;
  v[(axis + 2) % 8] = i * 0.005;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / n));
};
const SR = 8000;
const tone = (sec: number) => {
  const n = Math.round(sec * SR);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  return b;
};

const CHAPTERS = [
  { id: 1, slug: 'ch1' },
  { id: 2, slug: 'ch2' },
];
const HERO = {
  id: 'hero', name: 'Hero', gender: 'female', attributes: [],
  overrideTtsVoices: { qwen: { name: 'Hero voice', libraryUuid: 'hq' }, coqui: { name: 'Ana Florence' } },
};
const SIDE = { id: 'side', name: 'Side', gender: 'male', attributes: [], overrideTtsVoices: { coqui: { name: 'Damien Black' } } };
const hist = { schema: 1, supersededBy: {} } as never;

let workspaceRoot: string;
let bookDir: string;
let bookId: string;

beforeEach(() => {
  auditionSpy.mockClear();
  audition.axis = 0;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'recency-finalize-'));
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
  writeFileSync(castJsonPath(bookDir), JSON.stringify({ characters: [HERO, SIDE] }));
});
afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const readSegs = (slug: string) => JSON.parse(readFileSync(join(bookDir, 'audio', `${slug}.segments.json`), 'utf8'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ch1 on Coqui (12 hero + 1 side), then ch2 on Qwen (12 hero + 1 outlier). */
async function renderBothChapters() {
  const ch1Segs = [
    ...Array.from({ length: 12 }, (_, i) => ({ groupIndex: i, characterId: 'hero', sentenceIds: [i], startSec: i * 0.1, endSec: i * 0.1 + 0.1, voiceName: 'Ana Florence' })),
    { groupIndex: 12, characterId: 'side', sentenceIds: [12], startSec: 1.2, endSec: 1.3, voiceName: 'Damien Black' },
  ];
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
    segments: ch1Segs, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'coqui', modelKey: 'coqui-xtts-v2',
    audioFormat: 'mp3', resynthesizedIndices: 'all',
    embeddings: [
      ...Array.from({ length: 12 }, (_, i) => ({ characterId: 'hero', sentenceIds: [i], vec: vec(3, i) })),
      { characterId: 'side', sentenceIds: [12], vec: vec(6, 0) },
    ],
  });
  await wait(30);
  const ch2Segs = Array.from({ length: 13 }, (_, i) => ({ groupIndex: i, characterId: 'hero', sentenceIds: [100 + i], startSec: i * 0.1, endSec: i * 0.1 + 0.1, voiceName: 'qwen-hq' }));
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 2, slug: 'ch2', title: 'C2' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
    segments: ch2Segs, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey: 'qwen3-tts-0.6b',
    audioFormat: 'mp3', resynthesizedIndices: 'all',
    embeddings: Array.from({ length: 13 }, (_, i) => ({ characterId: 'hero', sentenceIds: [100 + i], vec: i === 12 ? vec(5, 0) : vec(0, i) })),
  });
}

/** Re-record ONLY side's line in ch1 (qa-repair / Fix audio on another character). */
async function rerecordSideInCh1() {
  await wait(30);
  const back = readSegs('ch1');
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
    segments: back.segments, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'coqui', modelKey: 'coqui-xtts-v2',
    audioFormat: 'mp3', resynthesizedIndices: [12],
    reembeddedRows: [{ characterId: 'side', sentenceIds: [12], vec: vec(6, 1) }],
  });
}

describe('finalizeChapterAudioWrite — per-character renderedAt stamp (#3524 pass 3 P1)', () => {
  it("stamps a fresh snapshot and carries an untouched character's stamp forward unchanged", async () => {
    await renderBothChapters();
    const first = readSegs('ch1').characterSnapshots;
    expect(typeof first.hero.renderedAt).toBe('string');
    await rerecordSideInCh1();
    const after = readSegs('ch1').characterSnapshots;
    expect(after.hero.renderedAt).toBe(first.hero.renderedAt); // carried verbatim
    expect(after.side.renderedAt > first.side.renderedAt).toBe(true); // re-recorded, so fresh
  });
});

describe('scoreBook after a real finalize — a side-only rewrite of an OLDER chapter does not make it the newest render (#3524 pass 3 P1)', () => {
  async function resume() {
    await scoreBook(bookDir, CHAPTERS); // Resume scoring: no run key
    return {
      hero: (await readCentroids(bookDir))!['hero'],
      ch2: (await readVerdicts(join(bookDir, 'audio', 'ch2.render-integrity.json')))!,
    };
  }

  it('control: no rewrite, so hero is referenced from its Qwen voice', async () => {
    await renderBothChapters();
    expect((await resume()).hero.inBookVoiceName).toBe('qwen-hq');
  });

  it("after re-recording only side's ch1 line, Resume still builds hero's reference from qwen-hq and ch2's outlier is voice-mismatch", async () => {
    await renderBothChapters();
    await rerecordSideInCh1();
    const { hero, ch2 } = await resume();
    expect(hero.inBookVoiceName).toBe('qwen-hq');
    expect(ch2.find((r) => r.sentenceIds[0] === 112)!.verdict).toBe('voice-mismatch');
  });
});
