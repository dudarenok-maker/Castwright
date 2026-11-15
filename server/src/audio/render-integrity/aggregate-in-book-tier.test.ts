/* #3518 — an in-book centroid pools anchors from EVERY chapter, so the row must record the
   tier those anchors were rendered at: one model key when every pooled anchor shares it,
   IN_BOOK_MIXED_TIER when they differ, and nothing when any anchor's tier is unknown. The qa-repair
   route compares the CURRENT model key against that stamp (never one chapter's snapshot).
   Also pins parity of the audition row's `modelKey` with `currentCastModelKey`. */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// auditionCentroid is mocked at the module boundary (as in aggregate-current-voice.test.ts).
const { auditionSpy } = vi.hoisted(() => {
  const unit = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const take = (k: number) => {
    const v = Array.from(unit);
    v[2] = k * 0.005;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return Float32Array.from(v.map((x) => x / n));
  };
  return {
    auditionSpy: vi.fn(async () => ({ centroid: unit, embeddings: Array.from({ length: 12 }, (_, k) => take(k)), kind: 'audition' as const })),
  };
});
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';
import { readCentroids, IN_BOOK_MIXED_TIER } from './centroids-io.js';
import { currentCastModelKey } from './current-voice.js';

const T06 = 'qwen3-tts-0.6b';
const T17 = 'qwen3-tts-1.7b';
const CHAPTERS = [
  { id: 1, slug: 'ch1' },
  { id: 2, slug: 'ch2' },
];

interface Tier {
  /** snapshot.renderedModelKey */ rendered?: string;
  /** snapshot.modelKey */ snap?: string;
  /** segments-file modelKey */ chapter?: string;
  /** voice the lines were rendered in (default: the current cast voice, 'qwen-new') */ voice?: string;
  /** per-segment renderedFallbackEngine (default: none) */ fallback?: string;
}

const unit = () => Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);

/** 12 identical-vector 'thurid' lines (>= CENTROID_MIN_N so the in-book path is taken), all in qwen-new. */
async function writeChapter(dir: string, slug: string, chapterId: number, tier: Tier) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: 12 }, (_, i) => ({ characterId: 'thurid', sentenceIds: [i], vec: unit() }));
  await writeEmbeddings(join(dir, 'audio', `${slug}.embeddings.json`), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', `${slug}.segments.json`),
    JSON.stringify({
      chapterId,
      ...(tier.chapter ? { modelKey: tier.chapter } : {}),
      segments: rows.map((r) => ({ characterId: 'thurid', sentenceIds: r.sentenceIds, renderedFallbackEngine: tier.fallback ?? null, voiceName: tier.voice ?? 'qwen-new' })),
      characterSnapshots: {
        thurid: {
          voiceEngine: 'qwen',
          resolvedVoiceName: tier.voice ?? 'qwen-new',
          ...(tier.snap ? { modelKey: tier.snap } : {}),
          ...(tier.rendered ? { renderedModelKey: tier.rendered } : {}),
        },
      },
    }),
  );
}

function writeCast(dir: string, extra: Record<string, unknown> = {}) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'thurid', name: 'Thurid', ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'new' } }, ...extra }],
    }),
  );
}

async function inBookRow(tiers: [Tier, Tier]) {
  const dir = mkdtempSync(join(tmpdir(), 'inbook-tier-'));
  writeCast(dir);
  await writeChapter(dir, 'ch1', 1, tiers[0]);
  await writeChapter(dir, 'ch2', 2, tiers[1]);
  await scoreBook(dir, CHAPTERS);
  const row = (await readCentroids(dir))!['thurid'];
  expect(row.referenceKind).toBe('in-book');
  return row;
}

describe('scoreBook stamps the pooled anchors tier on the in-book row (#3518)', () => {
  it('uniform tier: the row carries that model key', async () => {
    const row = await inBookRow([{ snap: T17 }, { snap: T17 }]);
    expect(row.inBookModelKey).toBe(T17);
  });

  it('mixed tiers across chapters: the row is stamped mixed (a minority tier still counts)', async () => {
    const row = await inBookRow([{ snap: T06 }, { snap: T17 }]);
    expect(row.inBookModelKey).toBe(IN_BOOK_MIXED_TIER);
  });

  it('an anchor whose tier is unknown leaves the row without a concrete key', async () => {
    const row = await inBookRow([{ snap: T17 }, {}]);
    expect(row.inBookModelKey).toBeUndefined();
  });

  it('a snapshot whose renderedModelKey and modelKey differ (partial write at another tier) is an unknown-tier anchor', async () => {
    const row = await inBookRow([{ rendered: T06, snap: T17 }, { rendered: T06, snap: T17 }]);
    expect(row.inBookModelKey).toBeUndefined();
  });

  it('precedence per anchor: renderedModelKey wins over the chapter modelKey when the snapshot has no modelKey', async () => {
    const row = await inBookRow([{ rendered: T06, chapter: T17 }, { rendered: T06, chapter: T17 }]);
    expect(row.inBookModelKey).toBe(T06);
  });

  it('precedence per anchor: snapshot.modelKey wins over the chapter modelKey', async () => {
    const row = await inBookRow([{ snap: T17, chapter: T06 }, { snap: T17, chapter: T06 }]);
    expect(row.inBookModelKey).toBe(T17);
  });

  it('falls back to the chapter modelKey when the snapshot carries none', async () => {
    const row = await inBookRow([{ chapter: T06 }, { chapter: T06 }]);
    expect(row.inBookModelKey).toBe(T06);
  });

  /* The stamp covers exactly the POOLED anchors: a line the pool filters out must not leak its tier. */
  it('an old-voice line at another tier is not pooled, so it does not touch the stamp', async () => {
    const row = await inBookRow([{ snap: T17 }, { snap: T06, voice: 'qwen-old' }]);
    expect(row.inBookModelKey).toBe(T17);
  });

  it('a per-segment fallback line at another tier is not pooled, so it does not touch the stamp', async () => {
    const row = await inBookRow([{ snap: T17 }, { snap: T06, fallback: 'kokoro' }]);
    expect(row.inBookModelKey).toBe(T17);
  });
});

describe('scoreBook audition modelKey stays in parity with currentCastModelKey (#3518)', () => {
  /* 3 anchors per chapter would be too few for in-book, so use ONE chapter with 3 lines. */
  async function auditionRowFor(extra: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'audition-parity-'));
    writeCast(dir, extra);
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, i) => ({ characterId: 'thurid', sentenceIds: [i], vec: unit() }));
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: T06,
        segments: rows.map((r) => ({ characterId: 'thurid', sentenceIds: r.sentenceIds, renderedFallbackEngine: null, voiceName: 'qwen-new' })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', modelKey: T06, resolvedVoiceName: 'qwen-new' } },
      }),
    );
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    return { row: (await readCentroids(dir))!['thurid'], castChar: JSON.parse(JSON.stringify({ id: 'thurid', ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'new' } }, ...extra })) };
  }

  it.each([
    ['unpinned character', {}],
    ['character pinned to 1.7B (elevate-only)', { ttsModelKey: T17 }],
  ])('%s', async (_label, extra) => {
    const { row, castChar } = await auditionRowFor(extra);
    expect(row.referenceKind).toBe('audition');
    expect(row.auditionVoice?.modelKey).toBe(currentCastModelKey(castChar, 'qwen', T06));
  });
});
