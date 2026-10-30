/* Plan 289 (#3784) — the pure token maker. */
import { describe, expect, it } from 'vitest';
import {
  CAST_REVISION_FIELDS,
  STATE_REVISION_FIELDS,
  mintEditEpoch,
  sliceRevision,
  staleFields,
} from './slice-revision.js';

const salt = { manuscriptId: 'mns_1', editEpoch: 'ep_a' };

describe('sliceRevision', () => {
  it('is stable under key order, at any depth', () => {
    const a = sliceRevision('cast', { characters: [{ id: 'x', a: 1, b: { c: 1, d: 2 } }] }, salt);
    const b = sliceRevision('cast', { characters: [{ b: { d: 2, c: 1 }, id: 'x', a: 1 }] }, salt);
    expect(a).toEqual(b);
  });

  it('keeps array order significant', () => {
    const a = sliceRevision('cast', { characters: [1, 2] }, salt);
    const b = sliceRevision('cast', { characters: [2, 1] }, salt);
    expect(a.characters).not.toBe(b.characters);
  });

  it('moves every token when the epoch or the manuscriptId changes', () => {
    const content = { title: 'T', author: 'A', castConfirmed: false, notes: null, tags: [] };
    const base = sliceRevision('state', content, salt);
    for (const other of [
      { ...salt, editEpoch: 'ep_b' },
      { ...salt, manuscriptId: 'mns_2' },
      { manuscriptId: salt.manuscriptId },
    ]) {
      const moved = sliceRevision('state', content, other);
      for (const f of STATE_REVISION_FIELDS) expect(moved[f], f).not.toBe(base[f]);
    }
  });

  it('gives one token per carried field and none for chapters / updatedAt', () => {
    const rev = sliceRevision('state', { title: 'T', chapters: [{ id: 1 }], updatedAt: 'x' }, salt);
    expect(Object.keys(rev).sort()).toEqual([...STATE_REVISION_FIELDS].sort());
    expect(rev).not.toHaveProperty('chapters');
    expect(rev).not.toHaveProperty('updatedAt');
    expect(Object.keys(sliceRevision('manuscript', null, salt)).sort()).toEqual(['mergedAwayKeys', 'sentences']);
    expect(Object.keys(sliceRevision('changeLog', null, salt))).toEqual(['events']);
    expect(Object.keys(sliceRevision('cast', null, salt))).toEqual([...CAST_REVISION_FIELDS]);
  });

  it('moves only the field whose value changed', () => {
    const a = sliceRevision('state', { title: 'T1', author: 'A' }, salt);
    const b = sliceRevision('state', { title: 'T2', author: 'A' }, salt);
    expect(a.title).not.toBe(b.title);
    expect(a.author).toBe(b.author);
  });

  it('distinguishes an absent file, an absent field, null and a literal sentinel string', () => {
    const absentFile = sliceRevision('manuscript', null, salt).sentences;
    const absentField = sliceRevision('manuscript', {}, salt).sentences;
    const nullField = sliceRevision('manuscript', { sentences: null }, salt).sentences;
    const literal = sliceRevision('manuscript', { sentences: '<absent-file>' }, salt).sentences;
    expect(new Set([absentFile, absentField, nullField, literal]).size).toBe(4);
  });

  it('treats an undefined-valued key like an absent one', () => {
    expect(sliceRevision('state', { title: undefined }, salt).title).toBe(sliceRevision('state', {}, salt).title);
  });
});

describe('mintEditEpoch', () => {
  it('mints distinct non-empty ids', () => {
    const a = mintEditEpoch();
    expect(a).toMatch(/^ep_[\w-]{10}$/);
    expect(mintEditEpoch()).not.toBe(a);
  });
});

describe('staleFields', () => {
  const cur = { a: 'c1', b: 'c2', c: 'c3' };

  it('is stale only when base is present, base != current and next != current', () => {
    expect(staleFields({ a: 'old' }, cur, { a: 'new' })).toEqual(['a']);
  });

  it('is never stale when the base equals current', () => {
    expect(staleFields({ a: 'c1' }, cur, { a: 'new' })).toEqual([]);
  });

  it('is never stale when the post-merge value is a no-op against current', () => {
    expect(staleFields({ a: 'old' }, cur, { a: 'c1' })).toEqual([]);
  });

  it('ignores a carried field with no base token', () => {
    expect(staleFields({ b: 'old' }, cur, { a: 'new' })).toEqual([]);
  });

  it('only considers carried fields (the keys of next)', () => {
    expect(staleFields({ a: 'old', b: 'old' }, cur, { b: 'new' })).toEqual(['b']);
  });

  it('lists every stale field', () => {
    expect(staleFields({ a: 'o', b: 'o', c: 'c3' }, cur, { a: 'n', b: 'n', c: 'n' })).toEqual(['a', 'b']);
  });
});
