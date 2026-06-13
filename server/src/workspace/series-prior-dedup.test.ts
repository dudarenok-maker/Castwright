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
      rec('b1', 'The Hollow Tide', { id: 'wren', name: 'Wren' }),
      rec('b2', 'The Ebb', { id: 'wren', name: 'Wren' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Wren');
    expect(out[0].id).toBe('wren');
    expect(out[0].fromBookTitles).toEqual(['The Hollow Tide', 'The Ebb']);
  });

  it('merges by alias overlap (Book B alias matches Book A name)', () => {
    const input = [
      rec('b1', 'The Hollow Tide', { id: 'wren', name: 'Wren' }),
      rec('b2', 'The Ebb', { id: 'foster', name: 'Foster', aliases: ['Wren'] }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('wren');
    expect(out[0].name).toBe('Wren');
    /* Book B's name "Foster" is promoted to an alias on the merged
       entry so the prompt still recognises that token. */
    expect(out[0].aliases).toContain('Foster');
  });

  it('treats punctuation/case differences as the same character', () => {
    const input = [
      rec('b1', 'The Hollow Tide', { id: 'mr-casper', name: 'Mr. Casper' }),
      rec('b2', 'The Ebb', { id: 'casper', name: 'mr casper' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    /* First occurrence wins the canonical id + display name. */
    expect(out[0].id).toBe('mr-casper');
    expect(out[0].name).toBe('Mr. Casper');
    expect(out[0].fromBookTitles).toEqual(['The Hollow Tide', 'The Ebb']);
  });

  it('does NOT merge disjoint characters', () => {
    const input = [
      rec('b1', 'The Hollow Tide', { id: 'wren', name: 'Wren' }),
      rec('b1', 'The Hollow Tide', { id: 'marlow', name: 'Marlow' }),
      rec('b1', 'The Hollow Tide', { id: 'oduvan', name: 'Oduvan' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.id)).toEqual(['wren', 'marlow', 'oduvan']);
  });

  it('unions aliases across all sources without duplicates, skipping the canonical name', () => {
    const input = [
      rec('b1', 'The Hollow Tide', { id: 'marlow', name: 'Marlow', aliases: ['Marlowes'] }),
      rec('b2', 'The Ebb', { id: 'marlow', name: 'Marlow', aliases: ['Marlowes', 'Sir Singe'] }),
      rec('b3', 'The Tidewatcher’s Oath', {
        id: 'marlow-halden',
        name: 'Marlow Halden',
        aliases: ['Marlow'],
      }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    const entry = out[0];
    expect(entry.id).toBe('marlow');
    expect(entry.name).toBe('Marlow');
    /* Canonical-name alias collapsed; "Marlow Halden" promoted from
       Book C's name; "Marlowes" appears once even though two books
       declared it. */
    expect(entry.aliases).toEqual(['Marlowes', 'Sir Singe', 'Marlow Halden']);
    expect(entry.fromBookTitles).toEqual(['The Hollow Tide', 'The Ebb', 'The Tidewatcher’s Oath']);
  });

  it('alias-chain merges transitively (A↔B via alias, B↔C via name)', () => {
    /* Three records that look pairwise disjoint by name alone but
       union into one group through the alias bridges. Verifies the
       union-find shape, not just a single-pass name match. */
    const input = [
      rec('b1', 'The Hollow Tide', { id: 'a', name: 'Alpha', aliases: ['Beta'] }),
      rec('b2', 'The Ebb', { id: 'b', name: 'Beta', aliases: ['Gamma'] }),
      rec('b3', 'The Tidewatcher’s Oath', { id: 'c', name: 'Gamma' }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(out[0].name).toBe('Alpha');
    expect(out[0].fromBookTitles).toEqual(['The Hollow Tide', 'The Ebb', 'The Tidewatcher’s Oath']);
  });

  it('preserves first-seen book-walk order in the output list', () => {
    const input = [
      rec('b1', 'The Hollow Tide', { id: 'wren', name: 'Wren' }),
      rec('b1', 'The Hollow Tide', { id: 'marlow', name: 'Marlow' }),
      rec('b2', 'The Ebb', { id: 'wren', name: 'Wren' }),
      rec('b2', 'The Ebb', { id: 'oduvan', name: 'Oduvan' }),
    ];
    const out = dedupSeriesPrior(input);
    /* Wren appears first in b1, then b2 contributes Oduvan. Order in
       output reflects the first occurrence of each group. */
    expect(out.map((e) => e.id)).toEqual(['wren', 'marlow', 'oduvan']);
  });

  it('drops empty/whitespace aliases so they do not bridge unrelated characters', () => {
    /* Defensive: a record with name="Wren", aliases=[""] and another
       with name="Marlow", aliases=[""] should NOT merge via the empty
       string. */
    const input = [
      rec('b1', 'The Hollow Tide', { id: 'wren', name: 'Wren', aliases: ['', '   '] }),
      rec('b1', 'The Hollow Tide', { id: 'marlow', name: 'Marlow', aliases: [''] }),
    ];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.id)).toEqual(['wren', 'marlow']);
  });

  it('omits aliases / fromBookTitles when nothing to render (compact prompt)', () => {
    const input = [rec('b1', 'Standalone-like', { id: 'lone', name: 'Lone' })];
    const out = dedupSeriesPrior(input);
    expect(out).toHaveLength(1);
    expect(out[0].aliases).toBeUndefined();
    expect(out[0].fromBookTitles).toEqual(['Standalone-like']);
  });
});
