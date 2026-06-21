import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVerdicts, readVerdicts, type VerdictRow } from './verdicts-io.js';

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
