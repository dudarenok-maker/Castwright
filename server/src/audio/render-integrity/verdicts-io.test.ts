import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeVerdicts,
  readVerdicts,
  deriveBookOutline,
  writeAttempted,
  readAttempted,
  attemptedPath,
  mergeVerdictRows,
  type VerdictRow,
} from './verdicts-io.js';

// Spy on embeddings-io to assert deriveBookOutline NEVER touches it.
vi.mock('./embeddings-io.js', () => ({
  readEmbeddings: vi.fn(async () => { throw new Error('readEmbeddings must not be called by deriveBookOutline'); }),
  writeEmbeddings: vi.fn(),
  EMBEDDINGS_VERSION: '1',
}));

const SAMPLE_ROW: VerdictRow = {
  characterId: 'c1',
  sentenceIds: [1, 2, 3],
  verdict: 'voice-match',
  cosine: 0.92,
  severity: null,
  fixable: false,
  expectedEngine: 'kokoro',
  renderedEngine: 'kokoro',
  referenceKind: 'in-book',
  windowed: false,
};

describe('verdicts-io', () => {
  it('round-trips verdict rows and tolerates a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vrd-'));
    const p = join(dir, 'ch1.verdicts.json');

    await writeVerdicts(p, [SAMPLE_ROW]);
    const back = await readVerdicts(p);

    expect(back).not.toBeNull();
    expect(back).toHaveLength(1);
    expect(back![0]).toEqual(SAMPLE_ROW);

    expect(await readVerdicts(join(dir, 'nope.json'))).toBeNull();
  });

  it('preserves all verdict field values faithfully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vrd-'));
    const p = join(dir, 'ch2.verdicts.json');
    const mismatch: VerdictRow = {
      characterId: 'c2',
      sentenceIds: [10],
      verdict: 'voice-mismatch',
      cosine: 0.41,
      severity: 'severe',
      fixable: true,
      expectedEngine: 'kokoro',
      renderedEngine: 'coqui',
      referenceKind: 'audition',
      windowed: true,
    };
    const inconclusive: VerdictRow = {
      characterId: 'c3',
      sentenceIds: [11, 12],
      verdict: 'inconclusive',
      cosine: 0.6,
      severity: 'inconclusive',
      fixable: false,
      expectedEngine: 'kokoro',
      renderedEngine: 'kokoro',
      referenceKind: 'too-short',
      windowed: false,
    };
    await writeVerdicts(p, [mismatch, inconclusive]);
    const back = await readVerdicts(p);
    expect(back).toEqual([mismatch, inconclusive]);
  });
});

describe('attempted sentinel', () => {
  it('round-trips: absent by default, true after write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attempted-'));
    const p = attemptedPath(dir, 'ch1');

    expect(await readAttempted(p)).toBe(false);

    await writeAttempted(p);
    expect(await readAttempted(p)).toBe(true);
  });
});

describe('deriveBookOutline', () => {
  it('rolls up voice-mismatch counts and too-short characters across chapters', async () => {
    const bookDir = mkdtempSync(join(tmpdir(), 'outline-'));
    // deriveBookOutline reads from <bookDir>/audio/<slug>.render-integrity.json
    const audioDir = join(bookDir, 'audio');
    mkdirSync(audioDir);

    // Chapter 1: two voice-mismatches (one fixable, one not) + one voice-match
    const ch1Rows: VerdictRow[] = [
      {
        characterId: 'hero',
        sentenceIds: [1],
        verdict: 'voice-mismatch',
        cosine: 0.4,
        severity: 'severe',
        fixable: true,
        expectedEngine: 'qwen',
        renderedEngine: 'kokoro',
        referenceKind: 'in-book',
        windowed: false,
      },
      {
        characterId: 'villain',
        sentenceIds: [2],
        verdict: 'voice-mismatch',
        cosine: 0.45,
        severity: 'severe',
        fixable: false,
        expectedEngine: 'coqui',
        renderedEngine: 'kokoro',
        referenceKind: 'in-book',
        windowed: false,
      },
      {
        characterId: 'hero',
        sentenceIds: [3],
        verdict: 'voice-match',
        cosine: 0.9,
        severity: null,
        fixable: false,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'in-book',
        windowed: false,
      },
    ];

    // Chapter 2: one voice-mismatch (fixable) + two too-short characters → unchecked
    const ch2Rows: VerdictRow[] = [
      {
        characterId: 'narrator',
        sentenceIds: [10],
        verdict: 'voice-mismatch',
        cosine: 0.38,
        severity: 'severe',
        fixable: true,
        expectedEngine: 'qwen',
        renderedEngine: 'kokoro',
        referenceKind: 'in-book',
        windowed: false,
      },
      {
        characterId: 'sidekick',
        sentenceIds: [11],
        verdict: 'inconclusive',
        cosine: 0,
        severity: 'inconclusive',
        fixable: false,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'too-short',
        windowed: false,
      },
      {
        characterId: 'hero',
        sentenceIds: [12],
        verdict: 'inconclusive',
        cosine: 0,
        severity: 'inconclusive',
        fixable: false,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'too-short',
        windowed: false,
      },
    ];

    await writeVerdicts(join(audioDir, 'ch1.render-integrity.json'), ch1Rows);
    await writeVerdicts(join(audioDir, 'ch2.render-integrity.json'), ch2Rows);

    const result = await deriveBookOutline(bookDir, [
      { id: 1, slug: 'ch1' },
      { id: 2, slug: 'ch2' },
    ]);

    // issues = all voice-mismatch rows across both chapters
    expect(result.issues).toHaveLength(3);
    expect(result.issues.every((r) => r.verdict === 'voice-mismatch')).toBe(true);

    // counts
    expect(result.counts.suspect).toBe(3);   // 2 in ch1 + 1 in ch2
    expect(result.counts.fixable).toBe(2);   // ch1[0] + ch2[0]

    // uncheckedCharacters: DISTINCT characterIds with any too-short row, sorted
    // ch2 has sidekick + hero both too-short → ['hero', 'sidekick']
    expect(result.counts.uncheckedCharacters).toEqual(['hero', 'sidekick']);
  });

  it('skips missing verdict files gracefully and returns empty when no files exist', async () => {
    const bookDir = mkdtempSync(join(tmpdir(), 'outline-empty-'));
    mkdirSync(join(bookDir, 'audio'));

    const result = await deriveBookOutline(bookDir, [{ id: 1, slug: 'ch1' }]);

    expect(result.issues).toHaveLength(0);
    expect(result.counts.suspect).toBe(0);
    expect(result.counts.fixable).toBe(0);
    expect(result.counts.uncheckedCharacters).toHaveLength(0);
  });

  it('deriveBookOutline reports scoredChapterIds and inconclusiveChapterIds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outline-chapter-ids-'));
    const audioDir = join(dir, 'audio');
    mkdirSync(audioDir);

    await writeVerdicts(join(audioDir, 'ch1.render-integrity.json'), [
      {
        characterId: 'wren',
        sentenceIds: [1, 2],
        verdict: 'voice-mismatch',
        cosine: 0.4,
        severity: 'severe',
        fixable: true,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'in-book',
        windowed: false,
        chapterId: 1,
      },
    ]);
    await writeVerdicts(join(audioDir, 'ch2.render-integrity.json'), [
      {
        characterId: 'oduvan',
        sentenceIds: [5],
        verdict: 'inconclusive',
        cosine: 0,
        severity: 'inconclusive',
        fixable: false,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'too-short',
        windowed: false,
        chapterId: 2,
      },
    ]);

    const outline = await deriveBookOutline(dir, [
      { id: 1, slug: 'ch1' },
      { id: 2, slug: 'ch2' },
      { id: 3, slug: 'ch3' }, // never rendered — no file
    ]);

    expect(outline.issues).toEqual([expect.objectContaining({ characterId: 'wren', chapterId: 1 })]);
    expect(outline.scoredChapterIds.sort()).toEqual([1, 2]);
    expect(outline.inconclusiveChapterIds).toEqual([2]);
    expect(outline.counts.uncheckedCharacters).toEqual(['oduvan']);
  });

  it('reports attemptedChapterIds from sentinel files, independent of whether scoring completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outline-attempted-'));
    const audioDir = join(dir, 'audio');
    mkdirSync(audioDir);

    // ch1: attempted AND scored (a verdict file exists).
    await writeAttempted(attemptedPath(audioDir, 'ch1'));
    await writeVerdicts(join(audioDir, 'ch1.render-integrity.json'), [
      {
        characterId: 'wren',
        sentenceIds: [1],
        verdict: 'voice-match',
        cosine: 0.9,
        severity: null,
        fixable: false,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'in-book',
        windowed: false,
        chapterId: 1,
      },
    ]);

    // ch2: attempted but NOT scored (embeddings failed for this chapter — no verdict file).
    await writeAttempted(attemptedPath(audioDir, 'ch2'));

    // ch3: never attempted at all (no sentinel, no verdict file).

    const outline = await deriveBookOutline(dir, [
      { id: 1, slug: 'ch1' },
      { id: 2, slug: 'ch2' },
      { id: 3, slug: 'ch3' },
    ]);

    expect(outline.attemptedChapterIds).toEqual([1, 2]);
    expect(outline.scoredChapterIds).toEqual([1]);
  });
});

describe('mergeVerdictRows', () => {
  it('writes rows fresh when no file exists yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-merge-'));
    const path = join(dir, 'ch1.render-integrity.json');
    await mergeVerdictRows(path, 'narrator', [
      { characterId: 'narrator', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);
    const rows = await readVerdicts(path);
    expect(rows).toHaveLength(1);
    expect(rows![0].characterId).toBe('narrator');
  });

  it('replaces only the given character\'s rows, leaving other characters\' rows untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-merge-'));
    const path = join(dir, 'ch1.render-integrity.json');
    await mergeVerdictRows(path, 'narrator', [
      { characterId: 'narrator', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);
    await mergeVerdictRows(path, 'ren', [
      { characterId: 'ren', sentenceIds: [2], verdict: 'inconclusive', cosine: 0, severity: 'inconclusive', fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'too-short', windowed: false, chapterId: 1 },
    ]);
    // Re-merge narrator with a NEW row set — old narrator rows must be dropped, ren's rows survive.
    await mergeVerdictRows(path, 'narrator', [
      { characterId: 'narrator', sentenceIds: [1, 3], verdict: 'voice-match', cosine: 0.95, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);
    const rows = await readVerdicts(path);
    expect(rows!.filter((r) => r.characterId === 'narrator')).toHaveLength(1);
    expect(rows!.find((r) => r.characterId === 'narrator')!.sentenceIds).toEqual([1, 3]);
    expect(rows!.filter((r) => r.characterId === 'ren')).toHaveLength(1);
  });
});

describe('deriveBookOutline — verdictCharactersByChapter', () => {
  it('collects the distinct characterIds with verdict rows per chapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-outline-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeVerdicts(join(root, 'ch1.render-integrity.json'), [
      { characterId: 'narrator', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
      { characterId: 'ren', sentenceIds: [2], verdict: 'inconclusive', cosine: 0, severity: 'inconclusive', fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'too-short', windowed: false, chapterId: 1 },
    ]);
    const outline = await deriveBookOutline(dir, [{ id: 1, slug: 'ch1' }]);
    expect(outline.verdictCharactersByChapter.get(1)).toEqual(new Set(['narrator', 'ren']));
  });

  it('an unscored chapter has no entry in verdictCharactersByChapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-outline-'));
    const outline = await deriveBookOutline(dir, [{ id: 1, slug: 'ch1' }]);
    expect(outline.verdictCharactersByChapter.get(1)).toBeUndefined();
  });
});
