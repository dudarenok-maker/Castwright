import { describe, it, expect } from 'vitest';
import { evalFixture, rosterToStage1 } from './run-eval.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';

const roster: RosterSnapshot = { characters: [
  { id: 'narrator', name: 'Narrator' },
  { id: 'alice', name: 'Alice', gender: 'female' },
] };

const truth: LabelledChapter = {
  chapterText: '"Hi," Alice said.',
  lines: [
    { text: 'Hi,', speakerId: 'alice' },
    { text: 'Alice said.', speakerId: 'narrator' },
  ],
};

// Full Analyzer stub (runAttributionEscalation → null so escalation is a no-op).
const fakeAnalyzer: any = {
  runStage1: () => Promise.reject(new Error('not used')),
  runStage1Chapter: () => Promise.reject(new Error('not used')),
  runStage2Chapter: () => Promise.resolve({ sentences: [
    { id: 1, chapterId: 44, characterId: 'alice', text: 'Hi,' },
    { id: 2, chapterId: 44, characterId: 'narrator', text: 'Alice said.' },
  ] }),
  runEmotionChapter: () => Promise.reject(new Error('not used')),
  runScriptReviewChapter: () => Promise.reject(new Error('not used')),
  runStage3Chapter: () => Promise.reject(new Error('not used')),
  runAttributionEscalation: () => Promise.resolve(null),
};

describe('rosterToStage1', () => {
  it('pins roster ids and satisfies characterSchema required fields', () => {
    const s1 = rosterToStage1(roster, 44);
    expect(s1.characters.map((c) => c.id)).toEqual(['narrator', 'alice']);
    expect(s1.characters[1].role).toBeTruthy();
    expect(s1.characters[1].color).toBeTruthy();
  });
});

describe('evalFixture', () => {
  it('scores three stages against the real structure engine (en)', async () => {
    // en is a supported language → the structure branch runs for real; the fake's
    // runAttributionEscalation → null makes escalation a no-op. No config override needed.
    const res = await evalFixture({
      analyzer: fakeAnalyzer,
      manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
      stageCall: { language: 'en' } as never,
    });
    expect(res.raw.recall).toBeCloseTo(1);
    expect(res.final.recall).toBeCloseTo(1);
    expect(res.final.total).toBe(2);
  });
});
