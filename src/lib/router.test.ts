// Pairs with docs/features/archive/01-hash-router.md

import { describe, expect, it } from 'vitest';
import { stageToHash, stageEqual } from './router';
import type { Stage } from './types';

describe('stageToHash', () => {
  it('null/undefined → root', () => {
    expect(stageToHash(null)).toBe('#/');
    expect(stageToHash(undefined)).toBe('#/');
  });

  it('books → #/', () => {
    expect(stageToHash({ kind: 'books' })).toBe('#/');
  });

  it('upload → #/new', () => {
    expect(stageToHash({ kind: 'upload' })).toBe('#/new');
  });

  it('voices → #/voices', () => {
    expect(stageToHash({ kind: 'voices' })).toBe('#/voices');
  });

  it('changelog → #/log', () => {
    expect(stageToHash({ kind: 'changelog' })).toBe('#/log');
  });

  it('model-manager → #/models (fs-23)', () => {
    expect(stageToHash({ kind: 'model-manager' })).toBe('#/models');
  });

  it('about → #/about', () => {
    expect(stageToHash({ kind: 'about' })).toBe('#/about');
  });

  it('analysing with bookId → #/books/:id/analysing', () => {
    expect(stageToHash({ kind: 'analysing', bookId: 'ns', manuscriptId: null })).toBe(
      '#/books/ns/analysing',
    );
  });

  it('analysing without bookId falls back to #/new', () => {
    expect(stageToHash({ kind: 'analysing', bookId: undefined, manuscriptId: null })).toBe('#/new');
  });

  it('confirm without openProfileId → #/books/:id/confirm', () => {
    expect(stageToHash({ kind: 'confirm', bookId: 'ns', openProfileId: null })).toBe(
      '#/books/ns/confirm',
    );
  });

  it('confirm with openProfileId → #/books/:id/confirm?profile=', () => {
    expect(stageToHash({ kind: 'confirm', bookId: 'ns', openProfileId: 'halloran' })).toBe(
      '#/books/ns/confirm?profile=halloran',
    );
  });

  it('ready with default chapter=3 omits chapter query param', () => {
    const stage: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'manuscript',
      currentChapterId: 3,
      openProfileId: null,
    };
    expect(stageToHash(stage)).toBe('#/books/ns/manuscript');
  });

  it('ready with non-default chapter includes chapter query param', () => {
    const stage: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 5,
      openProfileId: null,
    };
    expect(stageToHash(stage)).toBe('#/books/ns/cast?chapter=5');
  });

  it('ready with openProfileId includes profile query param', () => {
    const stage: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 3,
      openProfileId: 'halloran',
    };
    expect(stageToHash(stage)).toBe('#/books/ns/cast?profile=halloran');
  });

  it('ready with both chapter and profile combines query params', () => {
    const stage: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'generate',
      currentChapterId: 7,
      openProfileId: 'eliza',
    };
    expect(stageToHash(stage)).toBe('#/books/ns/generate?chapter=7&profile=eliza');
  });
});

describe('stageEqual', () => {
  it('both null/undefined', () => {
    expect(stageEqual(null, null)).toBe(true);
    expect(stageEqual(undefined, undefined)).toBe(true);
    expect(stageEqual(null, { kind: 'books' })).toBe(false);
    expect(stageEqual({ kind: 'books' }, null)).toBe(false);
  });

  it('different kinds are not equal', () => {
    expect(stageEqual({ kind: 'books' }, { kind: 'upload' })).toBe(false);
  });

  it('different bookId is not equal', () => {
    expect(
      stageEqual(
        { kind: 'confirm', bookId: 'a', openProfileId: null },
        { kind: 'confirm', bookId: 'b', openProfileId: null },
      ),
    ).toBe(false);
  });

  it('confirm with differing openProfileId is not equal', () => {
    expect(
      stageEqual(
        { kind: 'confirm', bookId: 'ns', openProfileId: null },
        { kind: 'confirm', bookId: 'ns', openProfileId: 'halloran' },
      ),
    ).toBe(false);
  });

  it('ready with differing view is not equal', () => {
    const a: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 3,
      openProfileId: null,
    };
    const b: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'manuscript',
      currentChapterId: 3,
      openProfileId: null,
    };
    expect(stageEqual(a, b)).toBe(false);
  });

  it('ready with differing currentChapterId is not equal', () => {
    const a: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 3,
      openProfileId: null,
    };
    const b: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 7,
      openProfileId: null,
    };
    expect(stageEqual(a, b)).toBe(false);
  });

  it('ready with differing openProfileId is not equal', () => {
    const a: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 3,
      openProfileId: null,
    };
    const b: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 3,
      openProfileId: 'halloran',
    };
    expect(stageEqual(a, b)).toBe(false);
  });

  it('identical ready stages are equal', () => {
    const stage: Stage = {
      kind: 'ready',
      bookId: 'ns',
      view: 'cast',
      currentChapterId: 3,
      openProfileId: 'halloran',
    };
    expect(stageEqual(stage, { ...stage })).toBe(true);
  });

  it('same kind + same bookId for non-ready stages are equal', () => {
    expect(
      stageEqual(
        { kind: 'confirm', bookId: 'ns', openProfileId: null },
        { kind: 'confirm', bookId: 'ns', openProfileId: null },
      ),
    ).toBe(true);
    expect(stageEqual({ kind: 'books' }, { kind: 'books' })).toBe(true);
  });

  it('stageEqual distinguishes help focusCode', () => {
    expect(stageEqual({ kind: 'help' }, { kind: 'help' })).toBe(true);
    expect(stageEqual({ kind: 'help', focusCode: 'a' }, { kind: 'help', focusCode: 'b' })).toBe(false);
  });
});

describe('stageToHash — fe-29 help route', () => {
  it('serialises the help stage', () => {
    expect(stageToHash({ kind: 'help' })).toBe('#/help');
    expect(stageToHash({ kind: 'help', focusCode: 'vram-spill' })).toBe('#/help?code=vram-spill');
  });
});
