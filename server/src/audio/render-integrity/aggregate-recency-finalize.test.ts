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
import { resolveConfiguredEngineByChar, scoreBook } from './aggregate.js';
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

/** Make a chapter look pre-upgrade: no recency / frozen engine / frozen model key on any snapshot. */
function stripFrozenFields(slug: string) {
  const f = readSegs(slug);
  for (const s of Object.values(f.characterSnapshots) as Record<string, unknown>[]) {
    delete s.renderedAt;
    delete s.renderedEngine;
    delete s.renderedModelKey;
  }
  writeFileSync(join(bookDir, 'audio', `${slug}.segments.json`), JSON.stringify(f));
}

/** Re-record ONLY side's line in ch1(qa-repair / Fix audio on another character). */
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
    // Only a full render moves recency: a re-recorded line keeps its character's stamp.
    expect(after.side.renderedAt).toBe(first.side.renderedAt);
  });

  it('a partial write that re-synthesises EVERY line (no untouched segment) still keeps each character\'s prior stamps (the needsPriorFile clause)', async () => {
    await renderBothChapters();
    const first = readSegs('ch1').characterSnapshots;
    expect(first.hero.renderedEngine).toBe('coqui');
    expect(first.hero.renderedModelKey).toBe('coqui-xtts-v2');
    await wait(30);
    const back = readSegs('ch1');
    await finalizeChapterAudioWrite({
      bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
      segments: back.segments, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey: 'qwen3-tts-0.6b',
      audioFormat: 'mp3', resynthesizedIndices: Array.from({ length: 13 }, (_, i) => i),
    });
    const after = readSegs('ch1').characterSnapshots;
    for (const id of ['hero', 'side']) {
      expect(after[id].renderedAt).toBe(first[id].renderedAt);
      expect(after[id].renderedEngine).toBe('coqui');
      expect(after[id].renderedModelKey).toBe('coqui-xtts-v2');
    }
    expect(after.hero.voiceEngine).toBe('qwen'); // the write's own engine still lands in the rebuilt snapshot
  });
  it('a partial write never gives a character with no prior stamp one (legacy stays oldest)', async () => {
    await renderBothChapters();
    const legacy = readSegs('ch1');
    delete legacy.characterSnapshots.side.renderedAt;
    writeFileSync(join(bookDir, 'audio', 'ch1.segments.json'), JSON.stringify(legacy));
    await rerecordSideInCh1();
    expect(readSegs('ch1').characterSnapshots.side.renderedAt).toBeUndefined();
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

  it("re-recording one of HERO's own ch1 lines on Coqui (qa-repair / Fix audio) does not move hero's reference off Qwen, and ch2's rows are not inconclusive", async () => {
    await renderBothChapters();
    const control = (await resume()).ch2.map((r) => [r.sentenceIds[0], r.verdict]);
    await wait(30);
    const back = readSegs('ch1');
    await finalizeChapterAudioWrite({
      bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
      segments: back.segments, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'coqui', modelKey: 'coqui-xtts-v2',
      audioFormat: 'mp3', resynthesizedIndices: [0],
      reembeddedRows: [{ characterId: 'hero', sentenceIds: [0], vec: vec(3, 1) }],
    });
    const { hero, ch2 } = await resume();
    expect(hero.inBookVoiceName).toBe('qwen-hq');
    // ch2's rows score exactly as they did before the repair (none newly inconclusive).
    expect(ch2.map((r) => [r.sentenceIds[0], r.verdict])).toEqual(control);
    expect(ch2.filter((r) => r.verdict === 'inconclusive').length).toBeLessThanOrEqual(1);
    expect(ch2.find((r) => r.sentenceIds[0] === 112)!.verdict).toBe('voice-mismatch');
  });

  it("re-recording one of HERO's lines in her NEWEST chapter (ch2) on Coqui does not move her reference off Qwen either (N1: the engine is frozen with renderedAt)", async () => {
    await renderBothChapters();
    const control = (await resume()).ch2.map((r) => [r.sentenceIds[0], r.verdict]);
    await wait(30);
    const back = readSegs('ch2');
    back.segments[0] = { ...back.segments[0], voiceName: 'Ana Florence' };
    await finalizeChapterAudioWrite({
      bookId, bookDir, chapter: { id: 2, slug: 'ch2', title: 'C2' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
      segments: back.segments, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'coqui', modelKey: 'coqui-xtts-v2',
      audioFormat: 'mp3', resynthesizedIndices: [0],
      reembeddedRows: [{ characterId: 'hero', sentenceIds: [100], vec: vec(0, 1) }],
    });
    const snap = readSegs('ch2').characterSnapshots.hero;
    expect(snap.voiceEngine).toBe('coqui'); // the rebuilt snapshot still reports the write's engine (drift detection reads it)
    const { hero, ch2 } = await resume();
    expect(hero.inBookVoiceName).toBe('qwen-hq');
    expect(ch2.find((r) => r.sentenceIds[0] === 112)!.verdict).toBe('voice-mismatch');
    expect(ch2.filter((r) => r.verdict === 'inconclusive').length).toBeLessThanOrEqual(control.filter((r) => r[1] === 'inconclusive').length + 1);
  });

  it("a PRE-UPGRADE book (no frozen fields anywhere): a Fix on Coqui in hero's newest chapter still does not move her reference (L: the prior voiceEngine/modelKey seed the freeze)", async () => {
    await renderBothChapters();
    stripFrozenFields('ch1');
    stripFrozenFields('ch2');
    const control = await resume();
    expect(control.hero.inBookVoiceName).toBe('qwen-hq');
    expect(control.ch2.find((r) => r.sentenceIds[0] === 112)!.verdict).toBe('voice-mismatch');
    await wait(30);
    const back = readSegs('ch2');
    back.segments[0] = { ...back.segments[0], voiceName: 'Ana Florence' };
    await finalizeChapterAudioWrite({
      bookId, bookDir, chapter: { id: 2, slug: 'ch2', title: 'C2' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
      segments: back.segments, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'coqui', modelKey: 'coqui-xtts-v2',
      audioFormat: 'mp3', resynthesizedIndices: [0],
      reembeddedRows: [{ characterId: 'hero', sentenceIds: [100], vec: vec(0, 1) }],
    });
    const snap = readSegs('ch2').characterSnapshots.hero;
    expect(snap.renderedEngine).toBe('qwen'); // seeded from the prior voiceEngine
    expect(snap.renderedModelKey).toBe('qwen3-tts-0.6b');
    expect(snap.renderedAt).toBeUndefined(); // and still sorts oldest
    const { hero, ch2 } = await resume();
    expect(hero.inBookVoiceName).toBe('qwen-hq');
    expect(ch2.find((r) => r.sentenceIds[0] === 112)!.verdict).toBe('voice-mismatch');
  });

  it("a Fix on KOKORO in hero's first chapter does not turn her scoring off (C: the stochastic classification reads the frozen engine)", async () => {
    await renderBothChapters();
    // hero renders on Qwen in BOTH chapters
    await wait(30);
    const ch1 = readSegs('ch1');
    const qwenSegs = ch1.segments.map((s: Record<string, unknown>) => (s.characterId === 'hero' ? { ...s, voiceName: 'qwen-hq' } : s));
    await finalizeChapterAudioWrite({
      bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
      segments: qwenSegs, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey: 'qwen3-tts-0.6b',
      audioFormat: 'mp3', resynthesizedIndices: 'all',
      embeddings: [
        ...Array.from({ length: 12 }, (_, i) => ({ characterId: 'hero', sentenceIds: [i], vec: vec(0, i + 20) })),
        { characterId: 'side', sentenceIds: [12], vec: vec(6, 0) },
      ],
    });
    expect((await resume()).ch2.length).toBeGreaterThan(0);
    await wait(30);
    const back = readSegs('ch1');
    back.segments[0] = { ...back.segments[0], voiceName: 'af_heart' };
    await finalizeChapterAudioWrite({
      bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(1.3), sampleRate: SR, durationSec: 1.3,
      segments: back.segments, cast: [HERO, SIDE] as never, castIdHistory: hist, defaultEngine: 'kokoro', modelKey: 'kokoro-v1',
      audioFormat: 'mp3', resynthesizedIndices: [0],
      reembeddedRows: [{ characterId: 'hero', sentenceIds: [0], vec: vec(0, 1) }],
    });
    expect(readSegs('ch1').characterSnapshots.hero.voiceEngine).toBe('kokoro');
    rmSync(join(bookDir, 'audio', 'ch2.render-integrity.json'), { force: true });
    const { hero, ch2 } = await resume();
    expect(hero).toBeDefined();
    // the helper qa-report.ts builds its stochastic roster from (shared with scoreBook)
    expect(resolveConfiguredEngineByChar([readSegs('ch1'), readSegs('ch2')]).get('hero')).toBe('qwen');
    expect(ch2.length).toBe(13); // ch2 got a verdict file: hero is still scored
    expect(ch2.find((r) => r.sentenceIds[0] === 112)).toBeDefined();
  });
});
