/* Task 5 — attributeChapterStage2 gains an optional onStages snapshot
   callback so the attribution-eval runner can score raw model output,
   the deterministic (post-crossExamine) pass, and per-sentence reasons.
   Additive: with no callback, runtime behaviour is unchanged (covered by
   the pre-existing analysis.structure-engine.test.ts suite). */

import { describe, it, expect } from 'vitest';
import type { Analyzer } from '../analyzer/index.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { attributeChapterStage2 } from './analysis.js';

// Minimal English chapter: one tag-anchored speech line + one narration line.
const CHAPTER_BODY = '"Are you sure?" asked Alice.\n\nBob nodded and turned away.';
const CHARACTERS: CharacterOutput[] = [
  { id: 'alice', name: 'Alice', role: 'lead', color: '#111111', gender: 'female' },
  { id: 'bob', name: 'Bob', role: 'lead', color: '#222222', gender: 'male' },
];
const STAGE1: Stage1Output = { characters: CHARACTERS, chapters: [{ id: 1, title: 'Chapter One' }] };

// Full Analyzer stub (mirrors analysis.structure-engine.test.ts). runStage2Chapter
// returns a fixed raw attribution; runAttributionEscalation → null (escalation no-op).
function fakeAnalyzer(sentences: SentenceOutput[]): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.resolve({ sentences }),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
}

describe('attributeChapterStage2 onStages', () => {
  it('invokes onStages once with raw + deterministic + reasons', async () => {
    const captured: Array<{ raw: SentenceOutput[]; deterministic: SentenceOutput[]; reasons: unknown[] }> = [];
    const raw: SentenceOutput[] = [
      { id: 1, chapterId: 1, characterId: 'bob', confidence: 0.4, text: 'Are you sure?' },
      { id: 2, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'Bob nodded and turned away.' },
    ];
    await attributeChapterStage2({
      analyzer: fakeAnalyzer(raw),
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: STAGE1,
      chapter: { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      stageCall: { language: 'en' } as never,
      onStages: (s) => captured.push(s),
    });
    expect(captured).toHaveLength(1);
    expect(Array.isArray(captured[0].raw)).toBe(true);
    expect(Array.isArray(captured[0].deterministic)).toBe(true);
    // structure branch ran (en supported) → reasons align 1:1 to the deterministic snapshot.
    expect(captured[0].reasons).toHaveLength(captured[0].deterministic.length);
  });
});
