/* #3524 — regression: the audition voice-check reference must be built (or
   kept) from a render in the character's CURRENT cast.json voice, not from the
   first chapter in book order.

   Repro (the review's): ch1 and ch2 both rendered on qwen-OLD, then the cast
   moves the character to qwen-NEW and ONLY ch2 is re-rendered. Before the fix
   `voiceInfoByChar` still came from ch1's (OLD) snapshot, so the persisted OLD
   audition matched and was reused verbatim, and every NEW-voice line in the
   re-rendered ch2 scored `voice-mismatch`.

   `auditionCentroid` is mocked at the module boundary (as in
   aggregate-audition-voice-reassign.test.ts); the assertion surface is its call
   count, the persisted `auditionVoice` identity, and ch2's verdict rows. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The axis the mocked audition "sounds like" — flipped between passes so the
// centroid it returns tracks the voice it was asked to render.
const { auditionSpy, audition } = vi.hoisted(() => {
  const state = { axis: 0 };
  const unit = (axis: number) => Float32Array.from(Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0)));
  // A spread of jittered takes around the axis, so the audition's clean-band
  // thresholds are non-degenerate (one lone embedding gives a zero-width band).
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
// The server's saved default engine must play no part in scoring (#3524 pass 2); the engine
// tests below set it to something other than the engine rendered, to prove it is ignored.
const { defaultModelKey } = vi.hoisted(() => ({ defaultModelKey: { value: 'qwen3-tts-0.6b' } }));
vi.mock('../../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/user-settings.js')>()),
  getResolvedTtsModelKey: () => defaultModelKey.value,
}));
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';
import { readCentroids } from './centroids-io.js';
import { readVerdicts, deriveBookOutline } from './verdicts-io.js';
import { buildAudioQaReport } from '../qa-report.js';

const CHAPTERS = [
  { id: 1, slug: 'ch1' },
  { id: 2, slug: 'ch2' },
];

// Unit vector on one axis with a tiny deterministic jitter (dim 8).
const vec = (axis: number, i: number) => {
  const v = new Array(8).fill(0);
  v[axis] = 1;
  v[(axis + 2) % 8] = i * 0.005;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / n));
};

/** Write one chapter with 3 'thurid' anchors (below CENTROID_MIN_N=10 → the
 *  audition path) whose embeddings sit on `axis` and whose snapshot records
 *  `resolvedVoiceName`. */
async function writeChapter(dir: string, slug: string, chapterId: number, axis: number, voice: string) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: 3 }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    vec: vec(axis, i),
  }));
  await writeEmbeddings(join(dir, 'audio', `${slug}.embeddings.json`), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', `${slug}.segments.json`),
    JSON.stringify({
      chapterId,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
      })),
      characterSnapshots: {
        thurid: { voiceEngine: 'qwen', modelKey: 'qwen3-tts-1.7b', resolvedVoiceName: voice },
      },
    }),
  );
}

/** cast.json gives thurid a designed Qwen voice: a `libraryUuid` slot resolves
 *  to `qwen-<libraryUuid>` via pickVoiceForEngine. */
function writeCast(dir: string, libraryUuid: string) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        {
          id: 'thurid',
          name: 'Thurid',
          overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid } },
        },
      ],
    }),
  );
}

describe('scoreBook — the audition reference follows the current cast voice (#3524)', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
  });

  it('rebuilds the audition from the NEW voice after a partial re-render, so the re-rendered chapter is not voice-mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-cur-voice-'));
    writeCast(dir, 'old');
    await writeChapter(dir, 'ch1', 1, 0, 'qwen-old');
    await writeChapter(dir, 'ch2', 2, 0, 'qwen-old');

    // Pass 1 — both chapters on OLD.
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-old');

    // The cast moves to NEW; only ch2 is re-rendered under it (far-off vectors).
    writeCast(dir, 'new');
    await writeChapter(dir, 'ch2', 2, 1, 'qwen-new');
    audition.axis = 1;

    // Pass 2 — partial re-render of ch2.
    await scoreBook(dir, CHAPTERS, ['ch2']);
    expect(auditionSpy).toHaveBeenCalledTimes(2);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-new');

    const ch2 = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(ch2).not.toBeNull();
    expect(ch2!.length).toBeGreaterThan(0);
    expect(ch2!.filter((r) => r.verdict === 'voice-mismatch')).toEqual([]);
  });

  it('keeps first-chapter-wins for a character with no cast.json row (no current voice known)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-cur-voice-nocast-'));
    await writeChapter(dir, 'ch1', 1, 0, 'qwen-old');
    await writeChapter(dir, 'ch2', 2, 0, 'qwen-old');

    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    // ch2 re-rendered on a different voice, but with no cast row there is no
    // "current voice" to prefer: ch1's snapshot still wins, the OLD audition is reused.
    await writeChapter(dir, 'ch2', 2, 1, 'qwen-new');
    audition.axis = 1;
    await scoreBook(dir, CHAPTERS, ['ch2']);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-old');
  });
});

/* #3524 child 2 — the IN-BOOK anchor pool follows the current cast voice.
   12 lines per chapter (≥ CENTROID_MIN_N = 10) so each chapter alone is enough
   for the in-book path; `stamp` is the per-segment voice stamp (`voiceName`),
   or null for a legacy unstamped segment that falls back to the chapter's
   snapshot `resolvedVoiceName`. */
async function writeBulkChapter(
  dir: string,
  slug: string,
  chapterId: number,
  axis: number | Float32Array,
  snapshotVoice: string,
  stamp: string | null,
) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: 12 }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    // Identical vectors per chapter ("one angle"): any jitter would put the
    // lowest-cosine NEW line under the in-book severe-edge percentile by design.
    vec: typeof axis === 'number' ? vec(axis, 0) : axis,
  }));
  await writeEmbeddings(join(dir, 'audio', `${slug}.embeddings.json`), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', `${slug}.segments.json`),
    JSON.stringify({
      chapterId,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
        ...(stamp != null ? { voiceName: stamp } : {}),
      })),
      characterSnapshots: {
        thurid: { voiceEngine: 'qwen', modelKey: 'qwen3-tts-1.7b', resolvedVoiceName: snapshotVoice },
      },
    }),
  );
}

const cos = (a: number[], b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('scoreBook — in-book anchors pool only from the current cast voice (#3524)', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
  });

  it('builds the in-book centroid from the NEW-voice lines only and records inBookVoiceName', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-inbook-cur-'));
    writeCast(dir, 'new');
    await writeBulkChapter(dir, 'ch1', 1, 0, 'qwen-old', 'qwen-old');
    await writeBulkChapter(dir, 'ch2', 2, 1, 'qwen-new', 'qwen-new');

    await scoreBook(dir, CHAPTERS);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBe('qwen-new');
    expect(cos(row.centroid, vec(1, 3))).toBeGreaterThan(0.99);
    const ch2 = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(ch2!.length).toBeGreaterThan(0);
    expect(ch2!.filter((r) => r.verdict === 'voice-mismatch')).toEqual([]);
  });

  it('resolves an unstamped legacy line through its chapter snapshot voice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-inbook-legacy-'));
    writeCast(dir, 'new');
    await writeBulkChapter(dir, 'ch1', 1, 0, 'qwen-old', null); // legacy, snapshot OLD → not an anchor
    await writeBulkChapter(dir, 'ch2', 2, 1, 'qwen-new', null); // legacy, snapshot NEW → anchor

    await scoreBook(dir, CHAPTERS);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBe('qwen-new');
    expect(cos(row.centroid, vec(1, 3))).toBeGreaterThan(0.99);
  });

  it('pools every line and records no inBookVoiceName for a character with no cast.json row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-inbook-nocast-'));
    // OLD at 0°, NEW at 20° in the axis-0/1 plane: close enough to stay one
    // unimodal pool, far enough that pooling both (centroid at 10°) is
    // distinguishable from NEW alone (cosine 1).
    const rad = (20 * Math.PI) / 180;
    const newVec = Float32Array.from([Math.cos(rad), Math.sin(rad), 0, 0, 0, 0, 0, 0]);
    await writeBulkChapter(dir, 'ch1', 1, 0, 'qwen-old', 'qwen-old');
    await writeBulkChapter(dir, 'ch2', 2, newVec, 'qwen-new', 'qwen-new');

    await scoreBook(dir, CHAPTERS);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBeUndefined();
    expect(cos(row.centroid, newVec)).toBeGreaterThan(0.97);
    expect(cos(row.centroid, newVec)).toBeLessThan(0.995);
  });
});

/* #3524 child 4 — a line rendered under a voice the character no longer has is
   `inconclusive`, never scored against the current-voice reference; and a
   character with no line in its current voice yet gets no new reference. */
describe('scoreBook — old-voice lines score inconclusive (#3524)', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
  });

  async function repro(dir: string) {
    writeCast(dir, 'old');
    await writeChapter(dir, 'ch1', 1, 0, 'qwen-old');
    await writeChapter(dir, 'ch2', 2, 0, 'qwen-old');
    await scoreBook(dir, CHAPTERS);
    writeCast(dir, 'new');
    await writeChapter(dir, 'ch2', 2, 1, 'qwen-new');
    audition.axis = 1;
    return scoreBook(dir, CHAPTERS, ['ch2']);
  }

  it('writes every ch1 (old-voice) row inconclusive and counts no mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-old-voice-'));
    const result = await repro(dir);

    const ch1 = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(ch1!.length).toBe(3);
    for (const r of ch1!) {
      expect(r.verdict).toBe('inconclusive');
      expect(r.fixable).toBe(false);
    }
    const ch2 = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(ch2!.filter((r) => r.verdict === 'voice-mismatch')).toEqual([]);
    expect(result.mismatchCount).toBe(0);
  });

  it('flags ch1 as inconclusive in the book outline, not as an issue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-old-voice-outline-'));
    await repro(dir);

    const outline = await deriveBookOutline(dir, CHAPTERS);
    expect(outline.inconclusiveChapterIds).toContain(1);
    expect(outline.issues.filter((r) => r.chapterId === 1)).toEqual([]);
  });

  it('builds no reference for a character with no current-voice line yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-no-cur-line-'));
    writeCast(dir, 'old');
    await writeChapter(dir, 'ch1', 1, 0, 'qwen-old');
    await writeChapter(dir, 'ch2', 2, 0, 'qwen-old');
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    writeCast(dir, 'new'); // reassigned, nothing re-rendered
    const scored: string[] = [];
    await scoreBook(dir, CHAPTERS, undefined, { onCharacterScored: (id) => scored.push(id) });

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    // The stale old-voice audition is replaced by a marker row: no usable reference.
    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('too-short');
    expect(row.noCurrentVoiceReference).toBe(true);
    expect(scored).toEqual(['thurid']);
    for (const slug of ['ch1', 'ch2']) {
      const rows = await readVerdicts(join(dir, 'audio', `${slug}.render-integrity.json`));
      expect(rows!.length).toBe(3);
      for (const r of rows!) {
        expect(r.verdict).toBe('inconclusive');
        expect(r.referenceKind).toBe('too-short');
      }
    }
  });

  it('still scores old lines against the reference when the character has no cast.json row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-old-voice-nocast-'));
    await writeChapter(dir, 'ch1', 1, 0, 'qwen-old');
    await writeChapter(dir, 'ch2', 2, 0, 'qwen-old');
    await scoreBook(dir, CHAPTERS);

    const ch1 = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(ch1!.length).toBe(3);
    expect(ch1!.every((r) => r.verdict !== 'inconclusive')).toBe(true);
  });
});

/** Per-line stamped chapter: each line carries its own `voiceName`/`baseVoiceName`
 *  (as a real render stamps them) and the chapter snapshot names `snapshotVoice`. */
type Line = { sid: number; axis: number; jitter: number; voice: string; fallback?: string | null };
async function writeChapterLines(dir: string, slug: string, chapterId: number, lines: Line[], snapshotVoice: string, charId = 'thurid', engine = 'qwen', snapModelKey = engine === 'qwen' ? 'qwen3-tts-1.7b' : 'coqui-xtts-v2') {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = lines.map((l) => ({ characterId: charId, sentenceIds: [l.sid], vec: vec(l.axis, l.jitter) }));
  await writeEmbeddings(join(dir, 'audio', `${slug}.embeddings.json`), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', `${slug}.segments.json`),
    JSON.stringify({
      chapterId,
      modelKey: 'qwen3-tts-1.7b',
      segments: lines.map((l) => ({
        characterId: charId,
        sentenceIds: [l.sid],
        renderedFallbackEngine: l.fallback ?? null,
        voiceName: l.voice,
        baseVoiceName: l.voice,
      })),
      characterSnapshots: {
        [charId]: { voiceEngine: engine, modelKey: snapModelKey, resolvedVoiceName: snapshotVoice },
      },
    }),
  );
}

describe('scoreBook — fallback lines and partial re-records (#3524 review pass 1)', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
  });

  it('a Kokoro-fallback line of a designed-voice character is still scored acoustically (voice-mismatch, fixable), not inconclusive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-fallback-cast-'));
    writeCast(dir, 'h');
    // The fallback line is stamped with the FALLBACK engine's voice (synthesise-chapter.ts).
    const lines: Line[] = [{ sid: 100, axis: 5, jitter: 0, voice: 'af_heart', fallback: 'kokoro' }];
    for (let i = 0; i < 12; i++) lines.push({ sid: i, axis: 0, jitter: i, voice: 'qwen-h' });
    await writeChapterLines(dir, 'ch1', 1, lines, 'qwen-h');
    // `writeCast` pins the id to 'thurid'; the lines above use it too.

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    const rows = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const fb = rows!.find((r) => r.sentenceIds[0] === 100)!;
    expect(fb.verdict).toBe('voice-mismatch');
    expect(fb.fixable).toBe(true);
  });

  it('a partial re-record that leaves the chapter snapshot on the OLD voice still rebuilds the audition from the NEW voice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-partial-rerecord-'));
    writeCast(dir, 'old');
    const old3: Line[] = [0, 1, 2].map((sid) => ({ sid, axis: 0, jitter: sid, voice: 'qwen-old' }));
    await writeChapterLines(dir, 'ch1', 1, old3, 'qwen-old');
    await writeChapterLines(dir, 'ch2', 2, old3, 'qwen-old');
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    // The cast moves to NEW; a Fix-audio splice re-records ch2 lines 0-1 (stamped NEW);
    // line 2 is untouched, so finalize's last-wins snapshot still names OLD.
    writeCast(dir, 'new');
    await writeChapterLines(
      dir,
      'ch2',
      2,
      [
        { sid: 0, axis: 1, jitter: 0, voice: 'qwen-new' },
        { sid: 1, axis: 1, jitter: 1, voice: 'qwen-new' },
        { sid: 2, axis: 0, jitter: 2, voice: 'qwen-old' },
      ],
      'qwen-old',
    );
    audition.axis = 1;
    await scoreBook(dir, CHAPTERS, ['ch2']);

    expect(auditionSpy).toHaveBeenCalledTimes(2);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-new');
    const ch2 = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    const by = Object.fromEntries(ch2!.map((r) => [r.sentenceIds[0], r]));
    expect(by[0].verdict).not.toBe('voice-mismatch');
    expect(by[1].verdict).not.toBe('voice-mismatch');
    expect(by[2].verdict).toBe('inconclusive');
  });

  it('#3676 — a too-short row built from the OLD voice is re-auditioned after a partial re-record leaves the snapshot on OLD', async () => {
    auditionSpy.mockImplementationOnce((async () => ({ kind: 'too-short' as const })) as never);
    const dir = mkdtempSync(join(tmpdir(), 'spk-partial-tooshort-'));
    writeCast(dir, 'old');
    const old3: Line[] = [0, 1, 2].map((sid) => ({ sid, axis: 0, jitter: sid, voice: 'qwen-old' }));
    await writeChapterLines(dir, 'ch1', 1, old3, 'qwen-old');
    await scoreBook(dir, [CHAPTERS[0]]);
    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-old');

    writeCast(dir, 'new');
    await writeChapterLines(
      dir,
      'ch1',
      1,
      [
        { sid: 0, axis: 1, jitter: 0, voice: 'qwen-new' },
        { sid: 1, axis: 0, jitter: 1, voice: 'qwen-old' },
        { sid: 2, axis: 0, jitter: 2, voice: 'qwen-old' },
      ],
      'qwen-old',
    );
    await scoreBook(dir, [CHAPTERS[0]]);
    expect(auditionSpy).toHaveBeenCalledTimes(2);
    expect((auditionSpy.mock.calls[1] as unknown[])[0]).toMatchObject({ voiceName: 'qwen-new' });
  });
});

describe('scoreBook — a character with no current-voice line is not pending forever (#3524)', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
  });
  const CH1 = [CHAPTERS[0]];

  it('A: reassigned before it was ever scored — one pass clears charactersPending, lines stay inconclusive, a later current-voice line rebuilds a real reference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pending-reassigned-'));
    writeCast(dir, 'new');
    await writeChapterLines(dir, 'ch1', 1, [0, 1, 2].map((sid) => ({ sid, axis: 0, jitter: sid, voice: 'qwen-old' })), 'qwen-old');

    await scoreBook(dir, CH1);
    const report = await buildAudioQaReport(dir, CH1);
    expect(report.voiceDrift.charactersPending).toEqual([]);
    const marked = (await readCentroids(dir))!['thurid'];
    expect(marked.noCurrentVoiceReference).toBe(true);
    const rows = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(rows!.every((r) => r.verdict === 'inconclusive')).toBe(true);
    expect(auditionSpy).not.toHaveBeenCalled();

    // The chapter is re-rendered in the new voice: the marked row is not reused.
    await writeChapterLines(dir, 'ch1', 1, [0, 1, 2].map((sid) => ({ sid, axis: 1, jitter: sid, voice: 'qwen-new' })), 'qwen-new');
    audition.axis = 1;
    await scoreBook(dir, CH1);
    const rebuilt = (await readCentroids(dir))!['thurid'];
    expect(rebuilt.noCurrentVoiceReference).toBeUndefined();
    expect(rebuilt.referenceKind).toBe('audition');
    expect(rebuilt.auditionVoice?.voiceName).toBe('qwen-new');
  });

  it('B: rendered entirely on the fallback engine — one pass clears charactersPending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pending-allfallback-'));
    writeCast(dir, 'h');
    await writeChapterLines(
      dir, 'ch1', 1,
      [0, 1, 2].map((sid) => ({ sid, axis: 5, jitter: sid, voice: 'af_heart', fallback: 'kokoro' })),
      'af_heart',
    );
    await scoreBook(dir, CH1);
    const report = await buildAudioQaReport(dir, CH1);
    expect(report.voiceDrift.charactersPending).toEqual([]);
    expect(auditionSpy).not.toHaveBeenCalled();
  });
});

describe("scoreBook — the current voice's engine is the book's CURRENT default, not the first chapter's (#3524)", () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
    defaultModelKey.value = 'qwen3-tts-0.6b';
  });

  it('after a default switch Coqui → Qwen, a character with no ttsEngine is referenced from its Qwen voice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-engine-switch-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(dir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'thurid',
            name: 'Thurid',
            overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'hq' }, coqui: { name: 'Ana Florence' } },
          },
        ],
      }),
    );
    // ch1 rendered while the book default was Coqui; ch2 after it switched to Qwen.
    const coqui: Line[] = Array.from({ length: 12 }, (_, i) => ({ sid: i, axis: 3, jitter: i, voice: 'Ana Florence' }));
    const qwen: Line[] = Array.from({ length: 12 }, (_, i) => ({ sid: i, axis: 0, jitter: i, voice: 'qwen-hq' }));
    await writeChapterLines(dir, 'ch1', 1, coqui, 'Ana Florence', 'thurid', 'coqui');
    await writeChapterLines(dir, 'ch2', 2, qwen, 'qwen-hq', 'thurid', 'qwen');

    await scoreBook(dir, CHAPTERS);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBe('qwen-hq');
    const ch2 = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(ch2!.some((r) => r.verdict !== 'inconclusive')).toBe(true);
    const ch1 = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(ch1!.every((r) => r.verdict === 'inconclusive')).toBe(true);
  });

  it('a partial re-record under the new engine builds the audition in the current voice\'s engine and tier, not the old snapshot\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-engine-override-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(dir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'thurid',
            name: 'Thurid',
            overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'hq' }, coqui: { name: 'Ana Florence' } },
          },
        ],
      }),
    );
    // finalize's real shape: the snapshot stamps the FRESH render's engine (Qwen) and tier, with
    // `resolvedVoiceName` last-wins over the untouched Coqui line; two lines were re-recorded on Qwen.
    await writeChapterLines(
      dir,
      'ch1',
      1,
      [
        { sid: 0, axis: 1, jitter: 0, voice: 'qwen-hq' },
        { sid: 1, axis: 1, jitter: 1, voice: 'qwen-hq' },
        { sid: 2, axis: 3, jitter: 2, voice: 'Ana Florence' },
      ],
      'Ana Florence',
      'thurid',
      'qwen',
      'qwen3-tts-0.6b',
    );
    audition.axis = 1;
    await scoreBook(dir, [CHAPTERS[0]]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((auditionSpy.mock.calls[0] as unknown[])[0]).toMatchObject({
      voiceName: 'qwen-hq',
      modelKey: 'qwen3-tts-0.6b',
    });
  });
});

/* #3524 pass 2 — A(i): generation forces a non-English book's un-pinned characters
   onto Qwen (or their cloned engine) whatever the default engine is, so scoring must
   resolve the engine the same way. */
function writeCastRow(dir: string, row: Record<string, unknown>) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [{ id: 'thurid', name: 'Thurid', ...row }] }));
}
/** 12 on-axis lines in `voice` plus one off-axis outlier (sid 99). */
const withOutlier = (voice: string): Line[] => [
  ...Array.from({ length: 12 }, (_, i) => ({ sid: i, axis: 0, jitter: i, voice })),
  { sid: 99, axis: 5, jitter: 0, voice },
];

describe('scoreBook — a non-English book scores against the engine generation actually retargets to (#3524 pass 2 A(i))', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
    defaultModelKey.value = 'coqui-xtts-v2';
  });

  it('explicit default Coqui, un-pinned character on a non-English book: the current voice is the Qwen voice, so the outlier is voice-mismatch (not the marker)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-nonenglish-retarget-'));
    writeCastRow(dir, { overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'h' } } });
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify({ language: 'ru' }));
    await writeChapterLines(dir, 'ch1', 1, withOutlier('qwen-h'), 'qwen-h');

    await scoreBook(dir, [CHAPTERS[0]]);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.noCurrentVoiceReference).toBeUndefined();
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBe('qwen-h');
    const rows = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(rows!.find((r) => r.sentenceIds[0] === 99)!.verdict).toBe('voice-mismatch');
  });
});

/* #3524 pass 2 A(ii) — "the engine actually rendered": the character's own `ttsEngine`,
   else the scoring run's model key, else (Resume scoring, no run) the engine stamped on its
   most recently rendered lines. The server's saved default plays no part. */
describe('scoreBook — the current engine is the one actually rendered, not the server default (#3524 pass 2 A(ii))', () => {
  const BOTH_SLOTS = {
    overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'hq' }, coqui: { name: 'Ana Florence' } },
  };
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
    defaultModelKey.value = 'qwen3-tts-0.6b'; // the server default is Qwen; the book was rendered on Coqui
  });

  async function coquiBook(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'spk-session-engine-'));
    writeCastRow(dir, BOTH_SLOTS);
    await writeChapterLines(dir, 'ch1', 1, withOutlier('Ana Florence'), 'Ana Florence', 'thurid', 'coqui');
    return dir;
  }
  const expectRealCoquiReference = async (dir: string) => {
    const row = (await readCentroids(dir))!['thurid'];
    expect(row.noCurrentVoiceReference).toBeUndefined();
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBe('Ana Florence');
    const rows = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(rows!.find((r) => r.sentenceIds[0] === 99)!.verdict).toBe('voice-mismatch');
  };

  it("scoring that follows a render uses that run's model key: a Coqui-rendered book under a Qwen server default builds a real Coqui reference", async () => {
    const dir = await coquiBook();
    await scoreBook(dir, [CHAPTERS[0]], undefined, { runModelKey: 'coqui-xtts-v2' });
    await expectRealCoquiReference(dir);
  });

  it("Resume scoring (no run key) resolves the engine from the character's most recently rendered lines", async () => {
    const dir = await coquiBook();
    await scoreBook(dir, [CHAPTERS[0]]);
    await expectRealCoquiReference(dir);
  });

  it('a settings default that reads kokoro (remote sidecar not yet polled as Qwen-installed) cannot overwrite a real reference with a marker', async () => {
    const dir = await coquiBook();
    defaultModelKey.value = 'kokoro-v1';
    await scoreBook(dir, [CHAPTERS[0]]);
    await expectRealCoquiReference(dir);
    await scoreBook(dir, [CHAPTERS[0]]); // a second pass keeps the real reference
    await expectRealCoquiReference(dir);
  });

  it("the character's own ttsEngine wins over the run key", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-own-engine-'));
    writeCastRow(dir, { ...BOTH_SLOTS, ttsEngine: 'coqui' });
    await writeChapterLines(dir, 'ch1', 1, withOutlier('Ana Florence'), 'Ana Florence', 'thurid', 'coqui');
    await scoreBook(dir, [CHAPTERS[0]], undefined, { runModelKey: 'qwen3-tts-0.6b' });
    await expectRealCoquiReference(dir);
  });
});

describe("scoreBook — the audition renders at the character's Qwen tier (#3524 pass 2 B)", () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 1;
    defaultModelKey.value = 'qwen3-tts-0.6b';
  });

  it('a character pinned to 1.7B, moved from Coqui to Qwen with a partial re-record, auditions at 1.7B (not the canonical 0.6B)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-tier-pinned-'));
    writeCastRow(dir, {
      ttsEngine: 'qwen',
      ttsModelKey: 'qwen3-tts-1.7b',
      overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'hq' }, coqui: { name: 'Ana Florence' } },
    });
    // ch1 still on Coqui; in ch2 lines 0-1 were re-recorded on Qwen at the character's 1.7B tier and
    // line 2 was left untouched — finalize stamps the fresh render's engine/tier on the snapshot, with
    // `resolvedVoiceName` last-wins over the untouched line.
    await writeChapterLines(dir, 'ch1', 1, [0, 1, 2].map((sid) => ({ sid, axis: 3, jitter: sid, voice: 'Ana Florence' })), 'Ana Florence', 'thurid', 'coqui');
    await writeChapterLines(
      dir, 'ch2', 2,
      [
        { sid: 0, axis: 1, jitter: 0, voice: 'qwen-hq' },
        { sid: 1, axis: 1, jitter: 1, voice: 'qwen-hq' },
        { sid: 2, axis: 3, jitter: 2, voice: 'Ana Florence' },
      ],
      'Ana Florence', 'thurid', 'qwen', 'qwen3-tts-1.7b',
    );

    await scoreBook(dir, CHAPTERS);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((auditionSpy.mock.calls[0] as unknown[])[0]).toMatchObject({ voiceName: 'qwen-hq', modelKey: 'qwen3-tts-1.7b' });
  });
});
