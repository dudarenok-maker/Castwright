import { describe, it, expect } from 'vitest';
import { buildLabelledChapter, buildRosterSnapshot, buildSilverSkeleton } from './capture.js';
import { LabelledChapterSchema } from './schema.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

const s = (id: number, chapterId: number, characterId: string, text: string): SentenceOutput => ({
  id, chapterId, characterId, text,
});

describe('buildLabelledChapter', () => {
  it('filters to the chapter, orders by id, maps characterId→speakerId', () => {
    const sentences = [
      s(3, 44, 'valkyrie', 'Line C'),
      s(1, 44, 'narrator', 'Line A'),
      s(2, 45, 'skulduggery', 'other chapter'),
      s(2, 44, 'skulduggery', 'Line B'),
    ];
    const out = buildLabelledChapter('CHAPTER BODY', sentences, 44);
    expect(out.chapterText).toBe('CHAPTER BODY');
    expect(out.lines).toEqual([
      { text: 'Line A', speakerId: 'narrator' },
      { text: 'Line B', speakerId: 'skulduggery' },
      { text: 'Line C', speakerId: 'valkyrie' },
    ]);
  });
});

describe('buildRosterSnapshot', () => {
  it('keeps id/name/gender/aliases and falls back name→id', () => {
    const out = buildRosterSnapshot([
      { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female', aliases: ['Val'] },
      { id: 'narrator' },
    ]);
    expect(out.characters).toEqual([
      { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female', aliases: ['Val'] },
      { id: 'narrator', name: 'narrator' },
    ]);
  });
});

describe('buildSilverSkeleton (Task 8)', () => {
  const roster = [
    { id: 'valkyrie', name: 'Valkyrie Cain' },
    { id: 'skulduggery', name: 'Skulduggery Pleasant' },
  ];

  it('seeds lines from current attribution and schema-parses without priorExchange when none is supplied', () => {
    const sentences = [
      s(2, 44, 'skulduggery', 'Line B'),
      s(1, 44, 'narrator', 'Line A'),
    ];
    const out = buildSilverSkeleton('CHAPTER BODY', sentences, roster);

    expect(() => LabelledChapterSchema.parse(out)).not.toThrow();
    expect(out.chapterText).toBe('CHAPTER BODY');
    // seeded from current attribution, ordered by sentence id — no label
    // corrections invented here, just the characterId→speakerId adapter map.
    expect(out.lines).toEqual([
      { text: 'Line A', speakerId: 'narrator' },
      { text: 'Line B', speakerId: 'skulduggery' },
    ]);
    expect(out.priorExchange).toBeUndefined();
  });

  it('repairs quote-continuation lines the current attribution defaulted to narrator', () => {
    // The book's current attribution attributes only the opener; the rest of a
    // multi-sentence speech defaults to narrator (issue #1769). The seed must
    // carry the corrected continuation labels, not the circular ones.
    const sentences = [
      s(1, 44, 'skulduggery', '“Good enough.'),
      s(2, 44, 'narrator', 'See here.'),
      s(3, 44, 'narrator', 'Happy to help.”'),
      s(4, 44, 'narrator', 'He walked off.'),
    ];
    const out = buildSilverSkeleton('CHAPTER BODY', sentences, roster);
    expect(out.lines).toEqual([
      { text: '“Good enough.', speakerId: 'skulduggery' },
      { text: 'See here.', speakerId: 'skulduggery' },
      { text: 'Happy to help.”', speakerId: 'skulduggery' },
      { text: 'He walked off.', speakerId: 'narrator' }, // outside the quote — unchanged
    ]);
  });

  it('attaches the prior chapter final two-speaker exchange when prior-chapter sentences are supplied', () => {
    const sentences = [s(1, 44, 'narrator', 'Line A')];
    const priorSentences = [
      s(1, 43, 'valkyrie', 'Are you coming?'),
      s(2, 43, 'skulduggery', 'Right behind you.'),
    ];
    const out = buildSilverSkeleton('CHAPTER BODY', sentences, roster, priorSentences);
    const parsed = LabelledChapterSchema.parse(out);

    expect(parsed.priorExchange).toEqual({
      turns: [
        { speakerId: 'valkyrie', speakerName: 'Valkyrie Cain', text: 'Are you coming?' },
        { speakerId: 'skulduggery', speakerName: 'Skulduggery Pleasant', text: 'Right behind you.' },
      ],
    });
  });

  it('omits priorExchange when the supplied prior-chapter sentences do not form a two-speaker exchange', () => {
    const sentences = [s(1, 44, 'narrator', 'Line A')];
    const priorSentences = [s(1, 43, 'valkyrie', 'Solo line, no reply.')];
    const out = buildSilverSkeleton('CHAPTER BODY', sentences, roster, priorSentences);

    expect(out.priorExchange).toBeUndefined();
    expect(() => LabelledChapterSchema.parse(out)).not.toThrow();
  });
});
