import { describe, expect, it } from 'vitest';
import { dedupSeriesPrior } from './series-prior-dedup.js';
import type { LibraryCharacterRecord } from './library-cast-scan.js';

function rec(
  bookId: string,
  bookTitle: string,
  character: { id: string; name?: string; aliases?: string[] },
): LibraryCharacterRecord {
  return { bookId, bookTitle, character };
}

describe('dedupSeriesPrior', () => {
  it('returns empty list for empty input', () => {
    expect(dedupSeriesPrior([])).toEqual([]);
  });

  it('merges same-name records across two books into one entry, preserving both source titles', () => {
    const input = [
      rec('b1', 'Keeper of the Lost Cities', { id: 'sophie', name: 'Sophie' }),
      rec('b2', 'Exile', { id: 'sophie', name: 'Sophie' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Sophie');
    expect(out[0].id).toBe('sophie');
    expect(out[0].fromBookTitles).toEqual(['Keeper of the Lost Cities', 'Exile']);
  });

  it('merges by alias overlap (Book B alias matches Book A name)', () => {
    const input = [
      rec('b1', 'Keeper', { id: 'sophie', name: 'Sophie' }),
      rec('b2', 'Exile', { id: 'foster', name: 'Foster', aliases: ['Sophie'] }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('sophie');
    expect(out[0].name).toBe('Sophie');
    /* Book B's name "Foster" is promoted to an alias on the merged
       entry so the prompt still recognises that token. */
    expect(out[0].aliases).toContain('Foster');
  });

  it('treats punctuation/case differences as the same character', () => {
    const input = [
      rec('b1', 'Keeper', { id: 'mr-forkle', name: 'Mr. Forkle' }),
      rec('b2', 'Exile', { id: 'forkle', name: 'mr forkle' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    /* First occurrence wins the canonical id + display name. */
    expect(out[0].id).toBe('mr-forkle');
    expect(out[0].name).toBe('Mr. Forkle');
    expect(out[0].fromBookTitles).toEqual(['Keeper', 'Exile']);
  });

  it('does NOT merge disjoint characters', () => {
    const input = [
      rec('b1', 'Keeper', { id: 'sophie', name: 'Sophie' }),
      rec('b1', 'Keeper', { id: 'keefe', name: 'Keefe' }),
      rec('b1', 'Keeper', { id: 'elwin', name: 'Elwin' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.id)).toEqual(['sophie', 'keefe', 'elwin']);
  });

  it('unions aliases across all sources without duplicates, skipping the canonical name', () => {
    const input = [
      rec('b1', 'Keeper', { id: 'keefe', name: 'Keefe', aliases: ['Keefester'] }),
      rec('b2', 'Exile', { id: 'keefe', name: 'Keefe', aliases: ['Keefester', 'Lord Hunkyhair'] }),
      rec('b3', 'Everblaze', {
        id: 'keefe-sencen',
        name: 'Keefe Sencen',
        aliases: ['Keefe'],
      }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    const entry = out[0];
    expect(entry.id).toBe('keefe');
    expect(entry.name).toBe('Keefe');
    /* Canonical-name alias collapsed; "Keefe Sencen" promoted from
       Book C's name; "Keefester" appears once even though two books
       declared it. */
    expect(entry.aliases).toEqual(['Keefester', 'Lord Hunkyhair', 'Keefe Sencen']);
    expect(entry.fromBookTitles).toEqual(['Keeper', 'Exile', 'Everblaze']);
  });

  it('alias-chain merges transitively (A↔B via alias, B↔C via name)', () => {
    /* Three records that look pairwise disjoint by name alone but
       union into one group through the alias bridges. Verifies the
       union-find shape, not just a single-pass name match. */
    const input = [
      rec('b1', 'Keeper', { id: 'a', name: 'Alpha', aliases: ['Beta'] }),
      rec('b2', 'Exile', { id: 'b', name: 'Beta', aliases: ['Gamma'] }),
      rec('b3', 'Everblaze', { id: 'c', name: 'Gamma' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(out[0].name).toBe('Alpha');
    expect(out[0].fromBookTitles).toEqual(['Keeper', 'Exile', 'Everblaze']);
  });

  it('preserves first-seen book-walk order in the output list', () => {
    const input = [
      rec('b1', 'Keeper', { id: 'sophie', name: 'Sophie' }),
      rec('b1', 'Keeper', { id: 'keefe', name: 'Keefe' }),
      rec('b2', 'Exile', { id: 'sophie', name: 'Sophie' }),
      rec('b2', 'Exile', { id: 'elwin', name: 'Elwin' }),
    ];
    const out = dedupSeriesPrior(input);
    /* Sophie appears first in b1, then b2 contributes Elwin. Order in
       output reflects the first occurrence of each group. */
    expect(out.map((e) => e.id)).toEqual(['sophie', 'keefe', 'elwin']);
  });

  it('drops empty/whitespace aliases so they do not bridge unrelated characters', () => {
    /* Defensive: a record with name="Sophie", aliases=[""] and another
       with name="Keefe", aliases=[""] should NOT merge via the empty
       string. */
    const input = [
      rec('b1', 'Keeper', { id: 'sophie', name: 'Sophie', aliases: ['', '   '] }),
      rec('b1', 'Keeper', { id: 'keefe', name: 'Keefe', aliases: [''] }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.id)).toEqual(['sophie', 'keefe']);
  });

  it('omits aliases / fromBookTitles when nothing to render (compact prompt)', () => {
    const input = [rec('b1', 'Standalone-like', { id: 'lone', name: 'Lone' })];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].aliases).toBeUndefined();
    expect(out[0].fromBookTitles).toEqual(['Standalone-like']);
  });
});
