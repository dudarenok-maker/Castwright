// Pairs with docs/features/archive/12-manuscript-view.md

import { describe, expect, it } from 'vitest';
import { manuscriptSlice, manuscriptActions } from './manuscript-slice';
import type { Sentence } from '../lib/types';

const sentences = (
  xs: Array<Partial<Sentence> & { id: number; text: string; characterId: string }>,
): Sentence[] => xs.map((x) => ({ chapterId: 1, ...x }) as Sentence);

const baseState = (initial: Sentence[]) => ({
  bookId: null,
  manuscriptId: null,
  title: null,
  format: null,
  wordCount: 0,
  sourceText: null,
  sentences: initial,
  importCandidate: null,
  pendingReupload: null,
});

describe('manuscriptSlice — splitSentence', () => {
  it('splits one sentence at a single offset into two pieces', () => {
    const start = baseState(sentences([{ id: 1, text: 'Hello world.', characterId: 'narrator' }]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 1,
        offsets: [6],
        characterIds: ['narrator', 'eliza'],
      }),
    );
    expect(next.sentences).toHaveLength(2);
    expect(next.sentences[0]).toMatchObject({ id: 1, text: 'Hello ', characterId: 'narrator' });
    expect(next.sentences[1]).toMatchObject({ id: 2, text: 'world.', characterId: 'eliza' });
  });

  it('splits at multiple offsets into N+1 pieces with new sequential ids', () => {
    const start = baseState(
      sentences([
        { id: 5, text: 'abcdefghij', characterId: 'narrator' },
        { id: 6, text: 'unrelated', characterId: 'narrator' },
      ]),
    );
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 5,
        offsets: [3, 7],
        characterIds: ['narrator', 'halloran', 'eliza'],
      }),
    );
    expect(
      next.sentences.map((s) => ({ id: s.id, text: s.text, characterId: s.characterId })),
    ).toEqual([
      { id: 5, text: 'abc', characterId: 'narrator' },
      { id: 7, text: 'defg', characterId: 'halloran' },
      { id: 8, text: 'hij', characterId: 'eliza' },
      { id: 6, text: 'unrelated', characterId: 'narrator' },
    ]);
  });

  it('drops empty pieces when offsets land on boundaries', () => {
    const start = baseState(sentences([{ id: 1, text: 'abc', characterId: 'narrator' }]));
    // Offset 0 produces an empty leading piece; offset 3 (= text.length) produces an empty trailing piece.
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 1,
        offsets: [0, 3],
        characterIds: ['skip-a', 'narrator', 'skip-b'],
      }),
    );
    expect(next.sentences).toHaveLength(1);
    expect(next.sentences[0]).toMatchObject({ id: 1, text: 'abc', characterId: 'narrator' });
  });

  it('sorts unsorted offsets before slicing', () => {
    const start = baseState(sentences([{ id: 1, text: 'abcdef', characterId: 'narrator' }]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 1,
        offsets: [4, 2],
        characterIds: ['a', 'b', 'c'],
      }),
    );
    expect(next.sentences.map((s) => s.text)).toEqual(['ab', 'cd', 'ef']);
  });

  it('new ids continue from the global max id, not from the original sentence id', () => {
    const start = baseState(
      sentences([
        { id: 3, text: 'abcdef', characterId: 'narrator' },
        { id: 99, text: 'tail', characterId: 'narrator' },
      ]),
    );
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 3,
        offsets: [3],
        characterIds: ['narrator', 'narrator'],
      }),
    );
    const ids = next.sentences.map((s) => s.id);
    expect(ids).toEqual([3, 100, 99]);
  });

  it('falls back to the original characterId when characterIds array is short', () => {
    const start = baseState(sentences([{ id: 1, text: 'abcd', characterId: 'narrator' }]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 1,
        offsets: [2],
        characterIds: ['eliza'],
      }),
    );
    expect(next.sentences).toEqual([
      expect.objectContaining({ id: 1, text: 'ab', characterId: 'eliza' }),
      expect.objectContaining({ text: 'cd', characterId: 'narrator' }),
    ]);
  });

  it('is a no-op for an unknown sentenceId', () => {
    const start = baseState(sentences([{ id: 1, text: 'abc', characterId: 'narrator' }]));
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 1,
        sentenceId: 999,
        offsets: [1],
        characterIds: ['a', 'b'],
      }),
    );
    expect(next.sentences).toEqual(start.sentences);
  });

  /* Regression: same (chapterId, id) scoping bug as the reassign reducers
     above — splitSentence used findIndex by id alone, so requesting a split
     in chapter 2 would have sliced up chapter 1's same-id sentence instead. */
  it('splitSentence scopes by chapterId — chapter 2 split leaves chapter 1 untouched', () => {
    const start = baseState([
      { id: 1, chapterId: 1, text: 'ch1-keep', characterId: 'narrator' },
      { id: 3, chapterId: 1, text: 'ch1-id3-keep', characterId: 'eliza' },
      { id: 1, chapterId: 2, text: 'ch2-keep', characterId: 'narrator' },
      { id: 3, chapterId: 2, text: 'abcdef', characterId: 'narrator' },
    ]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.splitSentence({
        chapterId: 2,
        sentenceId: 3,
        offsets: [3],
        characterIds: ['narrator', 'halloran'],
      }),
    );
    expect(
      next.sentences.map((s) => ({
        chapterId: s.chapterId,
        id: s.id,
        text: s.text,
        characterId: s.characterId,
      })),
    ).toEqual([
      { chapterId: 1, id: 1, text: 'ch1-keep', characterId: 'narrator' },
      { chapterId: 1, id: 3, text: 'ch1-id3-keep', characterId: 'eliza' }, // untouched
      { chapterId: 2, id: 1, text: 'ch2-keep', characterId: 'narrator' },
      { chapterId: 2, id: 3, text: 'abc', characterId: 'narrator' }, // first split-piece keeps original id
      { chapterId: 2, id: 4, text: 'def', characterId: 'halloran' }, // new id, inserted after
    ]);
  });
});

describe('manuscriptSlice — setSentenceCharacter / setSentencesCharacter', () => {
  it('setSentenceCharacter reassigns a single sentence', () => {
    const start = baseState(
      sentences([
        { id: 1, text: 'a', characterId: 'narrator' },
        { id: 2, text: 'b', characterId: 'narrator' },
      ]),
    );
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 2, characterId: 'eliza' }),
    );
    expect(next.sentences[1].characterId).toBe('eliza');
    expect(next.sentences[0].characterId).toBe('narrator');
  });

  it('setSentencesCharacter reassigns multiple sentences at once', () => {
    const start = baseState(
      sentences([
        { id: 1, text: 'a', characterId: 'narrator' },
        { id: 2, text: 'b', characterId: 'narrator' },
        { id: 3, text: 'c', characterId: 'narrator' },
      ]),
    );
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.setSentencesCharacter({
        chapterId: 1,
        sentenceIds: [1, 3],
        characterId: 'halloran',
      }),
    );
    expect(next.sentences.map((s) => s.characterId)).toEqual(['halloran', 'narrator', 'halloran']);
  });

  it('fs-25 — setSentenceEmotion sets / clears a quote\'s emotion, scoped by (chapter, id)', () => {
    const start = baseState(
      sentences([
        { id: 1, text: 'a', characterId: 'narrator' },
        { id: 2, text: 'b', characterId: 'wren' },
      ]),
    );
    const tagged = manuscriptSlice.reducer(
      start,
      manuscriptActions.setSentenceEmotion({ chapterId: 1, sentenceId: 2, emotion: 'angry' }),
    );
    expect(tagged.sentences[1].emotion).toBe('angry');
    expect(tagged.sentences[0].emotion).toBeUndefined();
    // setting to 'neutral' clears it back to undefined (the default render).
    const cleared = manuscriptSlice.reducer(
      tagged,
      manuscriptActions.setSentenceEmotion({ chapterId: 1, sentenceId: 2, emotion: 'neutral' }),
    );
    expect(cleared.sentences[1].emotion).toBeUndefined();
  });

  describe('fs-33 — applyDetectedEmotions (bulk backfill, fill-only-empty)', () => {
    const start = () =>
      baseState(
        sentences([
          { id: 1, chapterId: 1, text: 'a', characterId: 'narrator' },
          { id: 2, chapterId: 1, text: 'b', characterId: 'wren' },
          { id: 3, chapterId: 1, text: 'c', characterId: 'marlow', emotion: 'sad' },
        ]),
      );

    it('fills emotion on sentences that have none', () => {
      const next = manuscriptSlice.reducer(
        start(),
        manuscriptActions.applyDetectedEmotions({
          chapterId: 1,
          annotations: [{ sentenceId: 2, emotion: 'angry' }],
        }),
      );
      expect(next.sentences.find((s) => s.id === 2)?.emotion).toBe('angry');
    });

    it('NEVER clobbers a hand-set emotion (manual always wins)', () => {
      const next = manuscriptSlice.reducer(
        start(),
        manuscriptActions.applyDetectedEmotions({
          chapterId: 1,
          annotations: [{ sentenceId: 3, emotion: 'excited' }],
        }),
      );
      // sentence 3 already had a manual 'sad' — detection must not overwrite it.
      expect(next.sentences.find((s) => s.id === 3)?.emotion).toBe('sad');
    });

    it('ignores a neutral annotation and is scoped by (chapterId, sentenceId)', () => {
      const withCh2 = baseState([
        ...sentences([{ id: 1, chapterId: 1, text: 'a', characterId: 'wren' }]),
        ...sentences([{ id: 1, chapterId: 2, text: 'a2', characterId: 'wren' }]),
      ]);
      const next = manuscriptSlice.reducer(
        withCh2,
        manuscriptActions.applyDetectedEmotions({
          chapterId: 2,
          annotations: [
            { sentenceId: 1, emotion: 'neutral' },
          ],
        }),
      );
      // neutral is a no-op; ch1's id-1 is untouched (scoped to ch2).
      expect(next.sentences.find((s) => s.chapterId === 2 && s.id === 1)?.emotion).toBeUndefined();
      expect(next.sentences.find((s) => s.chapterId === 1 && s.id === 1)?.emotion).toBeUndefined();
    });
  });

  /* Regression: sentence ids restart at 1 in every chapter (the hydrate merge
     keys by `${chapterId}:${id}` for the same reason — see the
     "keeps per-chapter sentence ids distinct" test below). The reassign
     reducers must scope by (chapterId, id), not id alone. Before the fix,
     clicking a character chip in the SegmentInspector for a chapter-2
     sentence silently mutated chapter 1's sentence with the same id and
     left the visible chapter unchanged — surfaced by the user as "clicks
     don't do anything". */
  it('setSentenceCharacter scopes by chapterId — chapter 2 reassignment leaves chapter 1 untouched', () => {
    const start = baseState([
      { id: 1, chapterId: 1, text: 'ch1-s1', characterId: 'narrator' },
      { id: 2, chapterId: 1, text: 'ch1-s2', characterId: 'narrator' },
      { id: 1, chapterId: 2, text: 'ch2-s1', characterId: 'narrator' },
      { id: 2, chapterId: 2, text: 'ch2-s2', characterId: 'narrator' },
    ]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.setSentenceCharacter({ chapterId: 2, sentenceId: 2, characterId: 'eliza' }),
    );
    expect(
      next.sentences.map((s) => ({ chapterId: s.chapterId, id: s.id, characterId: s.characterId })),
    ).toEqual([
      { chapterId: 1, id: 1, characterId: 'narrator' },
      { chapterId: 1, id: 2, characterId: 'narrator' }, // untouched — same id, different chapter
      { chapterId: 2, id: 1, characterId: 'narrator' },
      { chapterId: 2, id: 2, characterId: 'eliza' }, // the one we asked for
    ]);
  });

  it('setSentencesCharacter scopes by chapterId — chapter 2 batch leaves chapter 1 untouched', () => {
    const start = baseState([
      { id: 1, chapterId: 1, text: 'ch1-s1', characterId: 'narrator' },
      { id: 2, chapterId: 1, text: 'ch1-s2', characterId: 'narrator' },
      { id: 1, chapterId: 2, text: 'ch2-s1', characterId: 'narrator' },
      { id: 2, chapterId: 2, text: 'ch2-s2', characterId: 'narrator' },
    ]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.setSentencesCharacter({
        chapterId: 2,
        sentenceIds: [1, 2],
        characterId: 'halloran',
      }),
    );
    expect(
      next.sentences.map((s) => ({ chapterId: s.chapterId, id: s.id, characterId: s.characterId })),
    ).toEqual([
      { chapterId: 1, id: 1, characterId: 'narrator' }, // untouched
      { chapterId: 1, id: 2, characterId: 'narrator' }, // untouched
      { chapterId: 2, id: 1, characterId: 'halloran' },
      { chapterId: 2, id: 2, characterId: 'halloran' },
    ]);
  });
});

describe('manuscriptSlice — hydrateFromAnalysis merge', () => {
  /* Minimal payload shape — only the fields the reducer touches. */
  const analyse = (
    xs: Array<Partial<Sentence> & { id: number; text: string; characterId: string }>,
  ): import('../lib/types').AnalyseResponse =>
    ({ sentences: sentences(xs) }) as unknown as import('../lib/types').AnalyseResponse;

  it('replaces wholesale on first hydrate (manuscriptId null)', () => {
    const start = baseState(
      sentences([{ id: 1, text: 'demo-fixture', characterId: 'fixture-narrator' }]),
    );
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis(
        analyse([
          { id: 1, text: 'real', characterId: 'narrator' },
          { id: 2, text: 'second', characterId: 'eliza' },
        ]),
      ),
    );
    expect(next.sentences).toHaveLength(2);
    expect(next.sentences[0]).toMatchObject({ id: 1, text: 'real', characterId: 'narrator' });
    expect(next.sentences[1]).toMatchObject({ id: 2, text: 'second', characterId: 'eliza' });
  });

  it('preserves user characterId when re-analysing an opened book', () => {
    const start = {
      ...baseState(
        sentences([
          { id: 1, text: 'old', characterId: 'eliza' }, // user edited
          { id: 2, text: 'old', characterId: 'narrator' },
        ]),
      ),
      manuscriptId: 'mns_open',
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis(
        analyse([
          { id: 1, text: 'fresh-text-1', characterId: 'narrator' }, // analyzer guesses narrator
          { id: 2, text: 'fresh-text-2', characterId: 'halloran' },
        ]),
      ),
    );
    // id=1 keeps user's eliza; id=2 stays narrator (unedited so accept new value? — no, we preserve characterId regardless once manuscriptId set)
    expect(next.sentences[0]).toMatchObject({ id: 1, characterId: 'eliza' });
    expect(next.sentences[1]).toMatchObject({ id: 2, characterId: 'narrator' });
  });

  it('keeps split-sentence offsprings whose ids the new analysis does not produce', () => {
    // Start state mirrors what splitSentence would have produced: original id=5 split → 5,42,43.
    const start = {
      ...baseState(
        sentences([
          { id: 1, text: 'before', characterId: 'narrator' },
          { id: 5, text: 'first-piece', characterId: 'narrator' },
          { id: 42, text: 'middle-piece', characterId: 'halloran' },
          { id: 43, text: 'last-piece', characterId: 'eliza' },
          { id: 6, text: 'after', characterId: 'narrator' },
        ]),
      ),
      manuscriptId: 'mns_open',
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis(
        analyse([
          { id: 1, text: 'before-fresh', characterId: 'narrator' },
          { id: 5, text: 'fresh-unsplit', characterId: 'narrator' },
          { id: 6, text: 'after-fresh', characterId: 'narrator' },
        ]),
      ),
    );
    // Splits (42, 43) preserved in narrative order between 5 and 6.
    expect(next.sentences.map((s) => s.id)).toEqual([1, 5, 42, 43, 6]);
    // Split offsprings kept their edited text + characterId
    expect(next.sentences[2]).toMatchObject({
      id: 42,
      text: 'middle-piece',
      characterId: 'halloran',
    });
    expect(next.sentences[3]).toMatchObject({ id: 43, text: 'last-piece', characterId: 'eliza' });
    // Split parent (id=5) kept its text and characterId, didn't get refreshed to 'fresh-unsplit'.
    expect(next.sentences[1]).toMatchObject({
      id: 5,
      text: 'first-piece',
      characterId: 'narrator',
    });
  });

  it('appends genuinely-new analysis ids at the end', () => {
    const start = {
      ...baseState(sentences([{ id: 1, text: 'a', characterId: 'narrator' }])),
      manuscriptId: 'mns_open',
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis(
        analyse([
          { id: 1, text: 'a-fresh', characterId: 'narrator' },
          { id: 2, text: 'new', characterId: 'halloran' },
        ]),
      ),
    );
    expect(next.sentences.map((s) => s.id)).toEqual([1, 2]);
    expect(next.sentences[1]).toMatchObject({ id: 2, text: 'new', characterId: 'halloran' });
  });

  it('keeps an in-state id the new analysis dropped (treated like a split offspring)', () => {
    /* Edge case: the analyzer is non-deterministic enough that a sentence
       present in the prior run is absent in the new one. We keep the slice
       entry so the user's reassignment isn't silently wiped — the GET-side
       merge on a fresh reload would filter it as a true orphan. */
    const start = {
      ...baseState(
        sentences([
          { id: 1, text: 'a', characterId: 'narrator' },
          { id: 2, text: 'gone-in-new', characterId: 'eliza' },
        ]),
      ),
      manuscriptId: 'mns_open',
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis(
        analyse([{ id: 1, text: 'a-fresh', characterId: 'narrator' }]),
      ),
    );
    expect(next.sentences.map((s) => s.id)).toEqual([1, 2]);
  });

  it('keeps per-chapter sentence ids distinct when ids repeat across chapters', () => {
    /* Regression for the "whole book under the last chapter" bug. The
       analyzer restarts sentence ids at 1 in every chapter, so a merge
       that dedupes by id alone collapses every id=N onto whichever
       chapter is iterated last. Symptom: chapter 1 went empty in the
       manuscript view because all its sentences got reassigned the
       final chapter's chapterId. */
    const start = {
      ...baseState(
        sentences([
          { id: 1, chapterId: 1, text: 'ch1-s1-old', characterId: 'narrator' },
          { id: 2, chapterId: 1, text: 'ch1-s2-old', characterId: 'eliza' },
          { id: 1, chapterId: 2, text: 'ch2-s1-old', characterId: 'narrator' },
          { id: 2, chapterId: 2, text: 'ch2-s2-old', characterId: 'halloran' },
        ]),
      ),
      manuscriptId: 'mns_open',
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis({
        sentences: sentences([
          { id: 1, chapterId: 1, text: 'ch1-s1-new', characterId: 'narrator' },
          { id: 2, chapterId: 1, text: 'ch1-s2-new', characterId: 'narrator' },
          { id: 1, chapterId: 2, text: 'ch2-s1-new', characterId: 'narrator' },
          { id: 2, chapterId: 2, text: 'ch2-s2-new', characterId: 'narrator' },
        ]),
      } as unknown as import('../lib/types').AnalyseResponse),
    );
    expect(next.sentences).toHaveLength(4);
    expect(next.sentences.map((s) => ({ chapterId: s.chapterId, id: s.id }))).toEqual([
      { chapterId: 1, id: 1 },
      { chapterId: 1, id: 2 },
      { chapterId: 2, id: 1 },
      { chapterId: 2, id: 2 },
    ]);
    // User's per-chapter characterId edits all preserved (not stomped by collapse).
    expect(next.sentences.map((s) => s.characterId)).toEqual([
      'narrator',
      'eliza',
      'narrator',
      'halloran',
    ]);
  });

  it('is a no-op when the analysis returned no sentences', () => {
    const start = {
      ...baseState(sentences([{ id: 1, text: 'a', characterId: 'narrator' }])),
      manuscriptId: 'mns_open',
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis({
        sentences: [],
      } as unknown as import('../lib/types').AnalyseResponse),
    );
    expect(next.sentences).toEqual(start.sentences);
  });
});

describe('manuscriptSlice — bookId anchoring', () => {
  /* Cross-book navigation guard. The slice must record which book its
     current contents reflect so Layout can detect stale state when the
     user navigates between books — e.g. analysing Book A then opening
     Book B's Generate view from the global generation pill. Without
     this anchor, the title selector falls through to the stale Book A
     title. See src/components/layout.tsx and routes/index.tsx. */
  it('hydrateFromAnalysis stamps bookId from the payload', () => {
    const start = baseState([]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromAnalysis({
        bookId: 'bk_a',
        sentences: sentences([{ id: 1, text: 'a', characterId: 'narrator' }]),
      } as unknown as import('../lib/types').AnalyseResponse),
    );
    expect(next.bookId).toBe('bk_a');
  });

  it('hydrateFromBookState stamps bookId from state.bookId', () => {
    const start = baseState([]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.hydrateFromBookState({
        state: {
          bookId: 'bk_b',
          manuscriptId: 'mns_b',
          title: 'Book B',
        } as unknown as import('../lib/types').BookStateJson,
        sentences: null,
      }),
    );
    expect(next.bookId).toBe('bk_b');
    expect(next.title).toBe('Book B');
    expect(next.manuscriptId).toBe('mns_b');
  });

  it('reset clears bookId alongside the rest of the slice', () => {
    const start = { ...baseState([]), bookId: 'bk_a', manuscriptId: 'mns_a', title: 'Book A' };
    const next = manuscriptSlice.reducer(start, manuscriptActions.reset());
    expect(next.bookId).toBeNull();
    expect(next.manuscriptId).toBeNull();
    expect(next.title).toBeNull();
  });
});

/* ── Plan 74 — re-upload diff state transitions ─────────────────────── */

describe('manuscriptSlice — previewReuploadDiff', () => {
  it('captures the current slice into oldSnapshot and stashes the new candidate', () => {
    const start = {
      ...baseState(sentences([{ id: 1, text: 'Original.', characterId: 'narrator' }])),
      bookId: 'bk_a',
      sourceText: 'Original.',
      wordCount: 1,
      title: 'Book A',
      format: 'markdown' as const,
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.previewReuploadDiff({
        bookId: 'bk_a',
        newSourceText: 'Revised.',
        newSentences: sentences([{ id: 1, text: 'Revised.', characterId: 'narrator' }]),
        newWordCount: 1,
      }),
    );
    /* Live fields stay untouched — that's the "preview before apply" invariant. */
    expect(next.sourceText).toBe('Original.');
    expect(next.sentences[0].text).toBe('Original.');
    /* Pending slot holds both sides for the diff modal. */
    expect(next.pendingReupload).not.toBeNull();
    expect(next.pendingReupload?.bookId).toBe('bk_a');
    expect(next.pendingReupload?.oldSnapshot.sourceText).toBe('Original.');
    expect(next.pendingReupload?.newCandidate.sourceText).toBe('Revised.');
    expect(next.pendingReupload?.newCandidate.sentences[0].text).toBe('Revised.');
  });

  it('falls back to current title / format on the candidate when caller omits them', () => {
    const start = {
      ...baseState([]),
      bookId: 'bk_a',
      title: 'Book A',
      format: 'epub' as const,
    };
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.previewReuploadDiff({
        bookId: 'bk_a',
        newSourceText: 'New text.',
        newSentences: sentences([{ id: 1, text: 'New text.', characterId: 'narrator' }]),
        newWordCount: 2,
      }),
    );
    expect(next.pendingReupload?.newCandidate.title).toBe('Book A');
    expect(next.pendingReupload?.newCandidate.format).toBe('epub');
  });
});

describe('manuscriptSlice — applyReupload', () => {
  it('promotes pendingReupload.newCandidate into the live slice fields and clears the slot', () => {
    const start = {
      ...baseState(sentences([{ id: 1, text: 'Original.', characterId: 'narrator' }])),
      bookId: 'bk_a',
      sourceText: 'Original.',
      wordCount: 1,
      title: 'Book A',
      format: 'markdown' as const,
    };
    const previewed = manuscriptSlice.reducer(
      start,
      manuscriptActions.previewReuploadDiff({
        bookId: 'bk_a',
        newSourceText: 'Revised.',
        newSentences: sentences([{ id: 1, text: 'Revised.', characterId: 'narrator' }]),
        newWordCount: 2,
      }),
    );
    const next = manuscriptSlice.reducer(previewed, manuscriptActions.applyReupload());
    expect(next.sourceText).toBe('Revised.');
    expect(next.sentences[0].text).toBe('Revised.');
    expect(next.wordCount).toBe(2);
    expect(next.pendingReupload).toBeNull();
  });

  it('is a no-op when no pendingReupload is set', () => {
    const start = baseState([]);
    const next = manuscriptSlice.reducer(start, manuscriptActions.applyReupload());
    expect(next).toEqual(start);
  });
});

describe('manuscriptSlice — discardReupload', () => {
  it('clears pendingReupload without touching the live slice fields', () => {
    const start = {
      ...baseState(sentences([{ id: 1, text: 'Original.', characterId: 'narrator' }])),
      bookId: 'bk_a',
      sourceText: 'Original.',
    };
    const previewed = manuscriptSlice.reducer(
      start,
      manuscriptActions.previewReuploadDiff({
        bookId: 'bk_a',
        newSourceText: 'Revised.',
        newSentences: sentences([{ id: 1, text: 'Revised.', characterId: 'narrator' }]),
        newWordCount: 1,
      }),
    );
    const next = manuscriptSlice.reducer(previewed, manuscriptActions.discardReupload());
    expect(next.pendingReupload).toBeNull();
    /* Live fields were never mutated by previewReuploadDiff, so Discard
       leaves them at the pre-preview values. */
    expect(next.sourceText).toBe('Original.');
    expect(next.sentences[0].text).toBe('Original.');
  });
});

describe('manuscriptSlice — applyChapterRestructure', () => {
  it('rewrites chapterId + sentence id per the remap table (reorder shape)', () => {
    const start = baseState([
      { id: 1, chapterId: 1, characterId: 'a', text: 'A1' } as Sentence,
      { id: 2, chapterId: 1, characterId: 'a', text: 'A2' } as Sentence,
      { id: 1, chapterId: 2, characterId: 'b', text: 'B1' } as Sentence,
    ]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.applyChapterRestructure({
        sentenceRemap: [
          // Swap chapters: old 1 → new 2, old 2 → new 1; sentence ids unchanged.
          { oldChapterId: 1, oldSentenceId: 1, newChapterId: 2, newSentenceId: 1 },
          { oldChapterId: 1, oldSentenceId: 2, newChapterId: 2, newSentenceId: 2 },
          { oldChapterId: 2, oldSentenceId: 1, newChapterId: 1, newSentenceId: 1 },
        ],
      }),
    );
    // Sorted by (chapterId, id): old (2,1) → (1,1) first; old (1,1)/(1,2) → (2,1)/(2,2)
    expect(next.sentences.map((s) => ({ id: s.id, chapterId: s.chapterId, text: s.text }))).toEqual([
      { id: 1, chapterId: 1, text: 'B1' },
      { id: 1, chapterId: 2, text: 'A1' },
      { id: 2, chapterId: 2, text: 'A2' },
    ]);
  });

  it('renumbers per-chapter sentence ids on merge (4 sentences collapse into one chapter)', () => {
    const start = baseState([
      { id: 1, chapterId: 1, characterId: 'a', text: 'A1' } as Sentence,
      { id: 2, chapterId: 1, characterId: 'a', text: 'A2' } as Sentence,
      { id: 1, chapterId: 2, characterId: 'b', text: 'B1' } as Sentence,
      { id: 2, chapterId: 2, characterId: 'b', text: 'B2' } as Sentence,
    ]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.applyChapterRestructure({
        sentenceRemap: [
          { oldChapterId: 1, oldSentenceId: 1, newChapterId: 1, newSentenceId: 1 },
          { oldChapterId: 1, oldSentenceId: 2, newChapterId: 1, newSentenceId: 2 },
          { oldChapterId: 2, oldSentenceId: 1, newChapterId: 1, newSentenceId: 3 },
          { oldChapterId: 2, oldSentenceId: 2, newChapterId: 1, newSentenceId: 4 },
        ],
      }),
    );
    expect(next.sentences.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(next.sentences.every((s) => s.chapterId === 1)).toBe(true);
    expect(next.sentences.map((s) => s.text)).toEqual(['A1', 'A2', 'B1', 'B2']);
    // characterId preserved
    expect(next.sentences.map((s) => s.characterId)).toEqual(['a', 'a', 'b', 'b']);
  });

  it('drops sentences with no remap entry (orphan / split-discarded halves)', () => {
    const start = baseState([
      { id: 1, chapterId: 1, characterId: 'a', text: 'kept' } as Sentence,
      { id: 99, chapterId: 1, characterId: 'a', text: 'orphan' } as Sentence,
    ]);
    const next = manuscriptSlice.reducer(
      start,
      manuscriptActions.applyChapterRestructure({
        sentenceRemap: [
          { oldChapterId: 1, oldSentenceId: 1, newChapterId: 1, newSentenceId: 1 },
        ],
      }),
    );
    expect(next.sentences).toHaveLength(1);
    expect(next.sentences[0].text).toBe('kept');
  });
});
