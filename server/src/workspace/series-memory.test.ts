// server/src/workspace/series-memory.test.ts
import { describe, it, expect } from 'vitest';
import { deriveSeriesMemory, summarize, type SeriesBookInput, type SeriesCharacterInput } from './series-memory.js';

const ch = (o: Partial<SeriesCharacterInput> & { characterId: string }): SeriesCharacterInput => ({
  name: o.name ?? o.characterId, aliases: [], voiceId: null, voiceLabel: 'Designed voice',
  engine: 'qwen', voiceKind: 'designed', isPrincipal: true, matchedFrom: null, ...o,
});
// A 3-book series: 3 designed principals carried 1->3; one preset principal carried; one late joiner.
function baseBooks(): SeriesBookInput[] {
  return [
    { bookId: 'b1', index: 1, title: 'One', characters: [
      ch({ characterId: 'b1-marrow', name: 'Marrow', voiceId: 'v_q_marrow' }),
      ch({ characterId: 'b1-edda', name: 'Edda', voiceId: 'v_q_edda' }),
      ch({ characterId: 'b1-vale', name: 'Vale', voiceId: 'v_q_vale' }),
      ch({ characterId: 'b1-narr', name: 'Narrator', voiceId: 'v_kok_emma', engine: 'kokoro', voiceKind: 'preset' }),
    ] },
    { bookId: 'b2', index: 2, title: 'Two', characters: [
      ch({ characterId: 'b2-marrow', name: 'Marrow', voiceId: 'v_q_marrow', matchedFrom: { bookId: 'b1', characterId: 'b1-marrow' } }),
      ch({ characterId: 'b2-edda', name: 'Edda', voiceId: 'v_q_edda', matchedFrom: { bookId: 'b1', characterId: 'b1-edda' } }),
      ch({ characterId: 'b2-vale', name: 'Vale', voiceId: 'v_q_vale', matchedFrom: { bookId: 'b1', characterId: 'b1-vale' } }),
      ch({ characterId: 'b2-narr', name: 'Narrator', voiceId: 'v_kok_emma', engine: 'kokoro', voiceKind: 'preset', matchedFrom: { bookId: 'b1', characterId: 'b1-narr' } }),
      ch({ characterId: 'b2-sela', name: 'Sela', voiceId: 'v_q_sela' }), // late joiner (no prior)
    ] },
    { bookId: 'b3', index: 3, title: 'Three', characters: [
      ch({ characterId: 'b3-marrow', name: 'Marrow', voiceId: 'v_q_marrow', matchedFrom: { bookId: 'b2', characterId: 'b2-marrow' } }),
      ch({ characterId: 'b3-edda', name: 'Edda', voiceId: 'v_q_edda', matchedFrom: { bookId: 'b2', characterId: 'b2-edda' } }),
      ch({ characterId: 'b3-vale', name: 'Vale', voiceId: 'v_q_vale', matchedFrom: { bookId: 'b2', characterId: 'b2-vale' } }),
      ch({ characterId: 'b3-narr', name: 'Narrator', voiceId: 'v_kok_emma', engine: 'kokoro', voiceKind: 'preset', matchedFrom: { bookId: 'b2', characterId: 'b2-narr' } }),
      ch({ characterId: 'b3-sela', name: 'Sela', voiceId: 'v_q_sela', matchedFrom: { bookId: 'b2', characterId: 'b2-sela' } }),
    ] },
  ];
}

describe('deriveSeriesMemory', () => {
  it('counts carried characters, not voiceIds, and reports bespoke/designed', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    expect(d).not.toBeNull();
    // Marrow, Edda, Vale (designed, full span), Narrator (preset, full span), Sela (designed, joined Bk2)
    expect(d.carried.count).toBe(5);
    expect(d.carried.designedCount).toBe(4); // Marrow,Edda,Vale,Sela
    expect(d.carried.bespokeCount).toBe(4);
    const marrow = d.carried.characters.find((c) => c.character === 'Marrow')!;
    expect(marrow.carriedFullSpan).toBe(true);
    expect(marrow.bookIndices).toEqual([1, 2, 3]);
    const sela = d.carried.characters.find((c) => c.character === 'Sela')!;
    expect(sela.carriedFullSpan).toBe(false); // joined Bk2
    expect(sela.firstBookId).toBe('b2');
  });

  it('treats two different characters sharing one preset voice as TWO carried, not one', () => {
    const books = baseBooks();
    // Add a second character on the SAME kokoro voice as Narrator, carried across all 3.
    for (const b of books) b.characters.push(ch({
      characterId: `${b.bookId}-guard`, name: 'Guard', voiceId: 'v_kok_emma',
      engine: 'kokoro', voiceKind: 'preset',
      matchedFrom: b.index === 1 ? null : { bookId: books[b.index - 2].bookId, characterId: `${books[b.index - 2].bookId}-guard` },
    }));
    const d = deriveSeriesMemory(books)!;
    expect(d.carried.count).toBe(6); // Narrator AND Guard both count
  });

  it('excludes a character re-cast mid-series (voiceId changed)', () => {
    const books = baseBooks();
    books[2].characters.find((c) => c.characterId === 'b3-vale')!.voiceId = 'v_q_vale_RECAST';
    const d = deriveSeriesMemory(books)!;
    expect(d.carried.characters.find((c) => c.character === 'Vale')).toBeUndefined();
    expect(d.carried.count).toBe(4);
  });

  it('returns null below threshold (no bespoke carry)', () => {
    // All-preset carried cast → no markers even if many carried.
    const books = baseBooks().map((b) => ({ ...b, characters: b.characters.map((c) => ({ ...c, engine: 'kokoro', voiceKind: 'preset' as const })) }));
    expect(deriveSeriesMemory(books)).toBeNull();
  });

  it('returns null below threshold (fewer than 3 books)', () => {
    expect(deriveSeriesMemory(baseBooks().slice(0, 2))).toBeNull();
  });

  it('summarize() reports per-book carriedPresent rising as joiners arrive', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    const s = summarize(d);
    expect(s.carriedCount).toBe(5);
    expect(s.perBook.find((p) => p.index === 1)!.carriedPresent).toBe(4); // Sela not yet
    expect(s.perBook.find((p) => p.index === 2)!.carriedPresent).toBe(5);
    expect(s.spanBooks).toBe(3);
  });

  it('handles a mid-series GAP (present 1 and 3, absent 2) → carried, not full span', () => {
    const books = baseBooks();
    // Remove Vale from book 2; book-3 Vale matchedFrom skips to book 1.
    books[1].characters = books[1].characters.filter((c) => c.characterId !== 'b2-vale');
    books[2].characters.find((c) => c.characterId === 'b3-vale')!.matchedFrom = { bookId: 'b1', characterId: 'b1-vale' };
    const d = deriveSeriesMemory(books)!;
    const vale = d.carried.characters.find((c) => c.character === 'Vale')!;
    expect(vale.bookIndices).toEqual([1, 3]);
    expect(vale.carriedFullSpan).toBe(false);
  });

  it('renamed-via-alias collapses to ONE carried row with the latest name + aliases', () => {
    const books = baseBooks();
    // Marrow is revealed as "The Warden" in book 3 (same voiceId, alias carries old name).
    const b3m = books[2].characters.find((c) => c.characterId === 'b3-marrow')!;
    b3m.name = 'The Warden'; b3m.aliases = ['Marrow'];
    const d = deriveSeriesMemory(books)!;
    const rows = d.carried.characters.filter((c) => c.voiceId === 'v_q_marrow');
    expect(rows).toHaveLength(1);              // one character, not two
    expect(rows[0].character).toBe('The Warden'); // canonical = latest
    expect(rows[0].aliases).toContain('Marrow');
  });

  it('chip N equals reveal row count (summarize.carriedCount === characters.length)', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    expect(summarize(d).carriedCount).toBe(d.carried.characters.length);
  });

  it('sorts bespoke (designed/cloned) rows above preset rows', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    const lastBespokeIdx = d.carried.characters.map((c) => c.voiceKind !== 'preset').lastIndexOf(true);
    const firstPresetIdx = d.carried.characters.findIndex((c) => c.voiceKind === 'preset');
    expect(firstPresetIdx).toBeGreaterThan(lastBespokeIdx); // all bespoke before any preset
  });

  it('does not hang on a cyclic matchedFrom (A→B→A self-cycle)', () => {
    // b2-marrow points back to b1-marrow which points back to b2-marrow → cycle.
    const books = baseBooks();
    books[0].characters.find((c) => c.characterId === 'b1-marrow')!.matchedFrom =
      { bookId: 'b2', characterId: 'b2-marrow' };
    // deriveSeriesMemory must return (not hang); result may be null or a valid detail.
    const result = deriveSeriesMemory(books);
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('does not double-count a shared ancestor when two tails matchedFrom the same prior character', () => {
    // Two book-3 characters both claim b1-marrow as their ancestor.
    const books = baseBooks();
    // Add a second tail in b3 that also matchedFrom b1-marrow.
    books[2].characters.push(ch({
      characterId: 'b3-marrow-alt', name: 'Marrow-Alt', voiceId: 'v_q_marrow',
      matchedFrom: { bookId: 'b1', characterId: 'b1-marrow' },
    }));
    const result = deriveSeriesMemory(books);
    if (result === null) return; // threshold not met — that is also an acceptable (non-phantom) outcome
    // b1-marrow must appear in at most one carried character's bookIndices.
    const appsInB1 = result.carried.characters.filter((c) => c.bookIndices.includes(1) && c.voiceId === 'v_q_marrow');
    // One chain consumed b1-marrow; the second tail's walk stopped at the shared node → no phantom duplicate.
    expect(appsInB1.length).toBeLessThanOrEqual(1);
  });
});
