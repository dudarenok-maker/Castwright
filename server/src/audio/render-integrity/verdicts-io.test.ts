import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVerdicts, readVerdicts, deriveBookOutline, type VerdictRow } from './verdicts-io.js';

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
});
