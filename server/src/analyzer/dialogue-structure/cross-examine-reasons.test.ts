// AlignedSentence/SpanEvidence factories are the exact ones from
// cross-examine.test.ts:19-50 (mkSentence/speechSpan/narrationSpan/aligned).
import { describe, it, expect } from 'vitest';
import { crossExamine } from './cross-examine.js';
import type { AlignedSentence, AlignmentResult } from './aligner.js';
import type { EvidenceSource, SpanEvidence } from './types.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

let nextId = 1;
const mkSentence = (characterId: string): SentenceOutput => ({
  id: nextId++, chapterId: 1, characterId, text: 'driven by aligned spans, not text',
});
const speechSpan = (speaker?: { characterId: string; source: EvidenceSource }): SpanEvidence => ({
  kind: 'speech', start: 0, end: 1, speaker,
});
const narrationSpan = (): SpanEvidence => ({ kind: 'narration', start: 0, end: 1 });
const aligned = (sentence: SentenceOutput, spans: SpanEvidence[]): AlignedSentence => ({
  sentence, spans, lumped: false,
});

describe('crossExamine reasons', () => {
  it('emits a reason+bucket for EVERY sentence, not only flagged', () => {
    // Line 0: tag-name proves 'alice' (CONFIRMED, not flagged). Line 1: pure narration.
    const alignment: AlignmentResult = {
      aligned: [
        aligned(mkSentence('alice'), [speechSpan({ characterId: 'alice', source: 'tag-name' })]),
        aligned(mkSentence('narrator'), [narrationSpan()]),
      ],
      alignedPct: 100,
    };
    const result = crossExamine(alignment, {
      rosterIds: new Set(['alice', 'narrator']),
      unknownBucketIds: new Set(),
      alignmentFloorPct: 80,
    });
    expect(result.reasons).toHaveLength(result.sentences.length);
    for (let i = 0; i < result.sentences.length; i++) {
      expect(result.reasons[i].index).toBe(i);
      expect(typeof result.reasons[i].reason).toBe('string');
      expect(['confirmed', 'corrected', 'flagged', 'lumped']).toContain(result.reasons[i].bucket);
    }
    // The confirmed line is NOT flagged, yet still carries a reason — the whole point.
    expect(result.reasons[0].bucket).toBe('confirmed');
  });
});
