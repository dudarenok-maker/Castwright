import { describe, it, expect } from 'vitest';
import { buildLabelledChapter, buildRosterSnapshot } from './capture.js';
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
