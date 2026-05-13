// Pairs with docs/features/12-manuscript-view.md

import { describe, expect, it } from 'vitest';
import { manuscriptSlice, manuscriptActions } from './manuscript-slice';
import type { Sentence } from '../lib/types';

const sentences = (xs: Array<Partial<Sentence> & { id: number; text: string; characterId: string }>): Sentence[] =>
  xs.map(x => ({ chapterId: 1, ...x } as Sentence));

const baseState = (initial: Sentence[]) => ({
  manuscriptId: null,
  title: null,
  format: null,
  wordCount: 0,
  sourceText: null,
  sentences: initial,
  importCandidate: null,
});

describe('manuscriptSlice — splitSentence', () => {
  it('splits one sentence at a single offset into two pieces', () => {
    const start = baseState(sentences([
      { id: 1, text: 'Hello world.', characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({ sentenceId: 1, offsets: [6], characterIds: ['narrator', 'eliza'] }),
    );
    expect(next.sentences).toHaveLength(2);
    expect(next.sentences[0]).toMatchObject({ id: 1, text: 'Hello ', characterId: 'narrator' });
    expect(next.sentences[1]).toMatchObject({ id: 2, text: 'world.', characterId: 'eliza' });
  });

  it('splits at multiple offsets into N+1 pieces with new sequential ids', () => {
    const start = baseState(sentences([
      { id: 5, text: 'abcdefghij', characterId: 'narrator' },
      { id: 6, text: 'unrelated', characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        sentenceId: 5, offsets: [3, 7],
        characterIds: ['narrator', 'halloran', 'eliza'],
      }),
    );
    expect(next.sentences.map(s => ({ id: s.id, text: s.text, characterId: s.characterId }))).toEqual([
      { id: 5, text: 'abc',  characterId: 'narrator' },
      { id: 7, text: 'defg', characterId: 'halloran' },
      { id: 8, text: 'hij',  characterId: 'eliza'   },
      { id: 6, text: 'unrelated', characterId: 'narrator' },
    ]);
  });

  it('drops empty pieces when offsets land on boundaries', () => {
    const start = baseState(sentences([
      { id: 1, text: 'abc', characterId: 'narrator' },
    ]));
    // Offset 0 produces an empty leading piece; offset 3 (= text.length) produces an empty trailing piece.
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        sentenceId: 1, offsets: [0, 3],
        characterIds: ['skip-a', 'narrator', 'skip-b'],
      }),
    );
    expect(next.sentences).toHaveLength(1);
    expect(next.sentences[0]).toMatchObject({ id: 1, text: 'abc', characterId: 'narrator' });
  });

  it('sorts unsorted offsets before slicing', () => {
    const start = baseState(sentences([
      { id: 1, text: 'abcdef', characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        sentenceId: 1, offsets: [4, 2],
        characterIds: ['a', 'b', 'c'],
      }),
    );
    expect(next.sentences.map(s => s.text)).toEqual(['ab', 'cd', 'ef']);
  });

  it('new ids continue from the global max id, not from the original sentence id', () => {
    const start = baseState(sentences([
      { id: 3, text: 'abcdef', characterId: 'narrator' },
      { id: 99, text: 'tail',  characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({ sentenceId: 3, offsets: [3], characterIds: ['narrator', 'narrator'] }),
    );
    const ids = next.sentences.map(s => s.id);
    expect(ids).toEqual([3, 100, 99]);
  });

  it('falls back to the original characterId when characterIds array is short', () => {
    const start = baseState(sentences([
      { id: 1, text: 'abcd', characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({ sentenceId: 1, offsets: [2], characterIds: ['eliza'] }),
    );
    expect(next.sentences).toEqual([
      expect.objectContaining({ id: 1, text: 'ab', characterId: 'eliza' }),
      expect.objectContaining({ text: 'cd', characterId: 'narrator' }),
    ]);
  });

  it('is a no-op for an unknown sentenceId', () => {
    const start = baseState(sentences([
      { id: 1, text: 'abc', characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({ sentenceId: 999, offsets: [1], characterIds: ['a', 'b'] }),
    );
    expect(next.sentences).toEqual(start.sentences);
  });
});

describe('manuscriptSlice — setSentenceCharacter / setSentencesCharacter', () => {
  it('setSentenceCharacter reassigns a single sentence', () => {
    const start = baseState(sentences([
      { id: 1, text: 'a', characterId: 'narrator' },
      { id: 2, text: 'b', characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.setSentenceCharacter({ sentenceId: 2, characterId: 'eliza' }),
    );
    expect(next.sentences[1].characterId).toBe('eliza');
    expect(next.sentences[0].characterId).toBe('narrator');
  });

  it('setSentencesCharacter reassigns multiple sentences at once', () => {
    const start = baseState(sentences([
      { id: 1, text: 'a', characterId: 'narrator' },
      { id: 2, text: 'b', characterId: 'narrator' },
      { id: 3, text: 'c', characterId: 'narrator' },
    ]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.setSentencesCharacter({ sentenceIds: [1, 3], characterId: 'halloran' }),
    );
    expect(next.sentences.map(s => s.characterId)).toEqual(['halloran', 'narrator', 'halloran']);
  });
});
