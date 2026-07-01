// server/src/workspace/series-memory.test.ts
import { describe, it, expect } from 'vitest';
import { deriveSeriesMemory, summarize, type SeriesBookInput, type SeriesCharacterInput } from './series-memory.js';

const ch = (o: Partial<SeriesCharacterInput> & { characterId: string }): SeriesCharacterInput => ({
  name: o.name ?? o.characterId, aliases: [], voiceId: null, voiceName: null, voiceLabel: 'Designed voice',
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

  it('carries a character whose originating book has a null reuse voiceId but a stable engine voice name', () => {
    // Real-world (KOTC): the book where a character DEBUTS never gets the
    // cross-book reuse `voiceId` stamped — only the per-engine voice name
    // (overrideTtsVoices[engine].name → here `voiceName`). Later books carry
    // BOTH. The voice never changed, so the character must count as carried.
    // Regression: the old single-`voiceId` set saw {null, 'v_q_marrow'} and
    // dropped the whole main cast that debuts in book 1.
    const books = baseBooks();
    for (const b of books) {
      const m = b.characters.find((c) => c.characterId === `${b.bookId}-marrow`)!;
      m.voiceName = 'qwen-marrow'; // engine voice name — identical in every book
      if (b.bookId === 'b1') m.voiceId = null; // originating book: no reuse key yet
    }
    const d = deriveSeriesMemory(books)!;
    const marrow = d.carried.characters.find((c) => c.character === 'Marrow')!;
    expect(marrow).toBeDefined();
    expect(marrow.bookIndices).toEqual([1, 2, 3]);
    expect(marrow.carriedFullSpan).toBe(true);
    expect(marrow.voiceId).toBe('v_q_marrow'); // canonical id from a voiced appearance
  });

  it('carries a character voiced consistently but name-dropped (no engine voice) in one book', () => {
    // Real-world (KOTC Lord Cassius / Ro / Flori): a character speaks with one
    // voice across books, but in one book is a bare mention with ttsEngine=null
    // → no engine voice name. The reuse voiceId stays stable, so it's the same
    // voice. A null facet in one appearance must NOT poison the whole component.
    const books = baseBooks();
    const cassius = (b: SeriesBookInput) => b.characters.find((c) => c.characterId === `${b.bookId}-marrow`)!;
    for (const b of books) {
      cassius(b).voiceName = 'qwen-marrow';
      cassius(b).voiceId = 'v_q_marrow';
    }
    // Book 2: bare mention — engine + voiceName null, but reuse voiceId persists.
    cassius(books[1]).voiceName = null;
    cassius(books[1]).engine = null;
    const d = deriveSeriesMemory(books)!;
    const m = d.carried.characters.find((c) => c.character === 'Marrow')!;
    expect(m).toBeDefined();
    expect(m.bookIndices).toEqual([1, 2, 3]);
  });

  it('excludes a character re-cast mid-series (engine voice name changed even if reuse id stable)', () => {
    // Both facets guard a voice change: flipping only the engine voice name
    // (a genuine re-voicing) must still drop the character.
    const books = baseBooks();
    for (const b of books) b.characters.find((c) => c.characterId === `${b.bookId}-marrow`)!.voiceName = 'qwen-marrow';
    books[2].characters.find((c) => c.characterId === 'b3-marrow')!.voiceName = 'qwen-marrow-RECAST';
    const d = deriveSeriesMemory(books)!;
    expect(d.carried.characters.find((c) => c.character === 'Marrow')).toBeUndefined();
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

  it('merges two UNLINKED components that share one bespoke engine voice (missed matchedFrom)', () => {
    // Real-world (KOTC): Keefe is re-detected fresh in one book, so its
    // matchedFrom never links it to the main Keefe — leaving a singleton
    // [book 3] component beside the carried [1,2] one. Same engine voice name
    // (`voiceName`) → same character; the second merge pass unifies them.
    const books = baseBooks();
    // Drop the matchedFrom on b3-marrow so it is NOT linked by the graph, and give
    // it a fresh id + NULL reuse voiceId — exactly how a re-detection looks. Only
    // the shared engine voice name can reunite it (Pass B).
    const b3m = books[2].characters.find((c) => c.characterId === 'b3-marrow')!;
    b3m.matchedFrom = null;
    b3m.characterId = 'b3-marrow-refresh';
    b3m.voiceId = null;
    for (const b of books) {
      const m = b.characters.find((c) => c.name === 'Marrow')!;
      m.voiceName = 'qwen-marrow';
    }
    const d = deriveSeriesMemory(books)!;
    const rows = d.carried.characters.filter((c) => c.character === 'Marrow');
    expect(rows).toHaveLength(1); // not split into two
    expect(rows[0].bookIndices).toEqual([1, 2, 3]); // book 3 reunited
  });

  it('merges alias/spelling-drift duplicates that share a bespoke voiceId', () => {
    // "Wylie" (bk1) and "Wylie Endal" (bk2) — different name AND id, no
    // matchedFrom between them, but the same designed voiceId. One carried row.
    const books = baseBooks();
    // Drop book-3 Marrow so the Wylie pair below is an isolated component.
    books[2].characters = books[2].characters.filter((c) => c.characterId !== 'b3-marrow');
    const a = books[0].characters.find((c) => c.characterId === 'b1-marrow')!;
    const b = books[1].characters.find((c) => c.characterId === 'b2-marrow')!;
    a.name = 'Wylie'; b.name = 'Wylie Endal';
    a.matchedFrom = null; b.matchedFrom = null; // graph does NOT link them
    a.voiceId = b.voiceId = 'v_q_wylie';
    a.voiceName = b.voiceName = null;
    const d = deriveSeriesMemory(books)!;
    const rows = d.carried.characters.filter((c) => c.voiceId === 'v_q_wylie');
    expect(rows).toHaveLength(1);
    expect(rows[0].bookIndices).toEqual([1, 2]);
  });

  it('does NOT merge two unlinked components that carry DIFFERENT bespoke voices', () => {
    // "Councilor Emery" [1,2] and "Councillor Emery" [3,4] — same person, but the
    // user designed two different voices. They must stay separate (the voice DID
    // change); unifying them is the upstream matcher's job, and would correctly
    // EXCLUDE — never a false "carried" row. Here: distinct designed voices →
    // two independent carried characters, never collapsed by the voice merge.
    const link = (bookId: string, characterId: string) => ({ bookId, characterId });
    const books: SeriesBookInput[] = [1, 2, 3, 4].map((index) => ({
      bookId: `b${index}`, index, title: `Book ${index}`,
      characters: [
        ch({ characterId: `b${index}-edda`, name: 'Edda', voiceId: 'v_q_edda',
          matchedFrom: index > 1 ? link(`b${index - 1}`, `b${index - 1}-edda`) : null }),
        ch({ characterId: `b${index}-vale`, name: 'Vale', voiceId: 'v_q_vale',
          matchedFrom: index > 1 ? link(`b${index - 1}`, `b${index - 1}-vale`) : null }),
      ],
    }));
    // Emery as TWO unlinked designed voices.
    books[0].characters.push(ch({ characterId: 'b1-emery', name: 'Emery', voiceId: 'v_q_emery_a' }));
    books[1].characters.push(ch({ characterId: 'b2-emery', name: 'Emery', voiceId: 'v_q_emery_a', matchedFrom: link('b1', 'b1-emery') }));
    books[2].characters.push(ch({ characterId: 'b3-emery', name: 'Emery', voiceId: 'v_q_emery_b' }));
    books[3].characters.push(ch({ characterId: 'b4-emery', name: 'Emery', voiceId: 'v_q_emery_b', matchedFrom: link('b3', 'b3-emery') }));
    const d = deriveSeriesMemory(books)!;
    const emeryRows = d.carried.characters.filter((c) => c.character === 'Emery');
    expect(emeryRows).toHaveLength(2); // distinct voices → not merged
    expect(emeryRows.map((r) => r.bookIndices).sort()).toEqual([[1, 2], [3, 4]]);
  });

  it('chip N equals reveal row count (summarize.carriedCount === characters.length)', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    expect(summarize(d).carriedCount).toBe(d.carried.characters.length);
  });

  it('sorts bespoke (designed/cloned) rows above preset rows when totalLines ties (all 0)', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    const lastBespokeIdx = d.carried.characters.map((c) => c.voiceKind !== 'preset').lastIndexOf(true);
    const firstPresetIdx = d.carried.characters.findIndex((c) => c.voiceKind === 'preset');
    expect(firstPresetIdx).toBeGreaterThan(lastBespokeIdx); // all bespoke before any preset
  });

  it('sums totalLines for a carried character across every book it appears in', () => {
    const books = baseBooks();
    const marrow = (idx: number) => books[idx].characters.find((c) => c.name === 'Marrow')!;
    marrow(0).lineCount = 10;
    marrow(1).lineCount = 20;
    marrow(2).lineCount = 30;
    const d = deriveSeriesMemory(books)!;
    const row = d.carried.characters.find((c) => c.character === 'Marrow')!;
    expect(row.totalLines).toBe(60);
  });

  it('sorts by totalLines desc (biggest speaking part first), overriding the bespoke/preset tie-break', () => {
    const books = baseBooks();
    // Narrator (preset) speaks far more than the bespoke cast — it should still lead.
    for (const b of books) {
      for (const c of b.characters) c.lineCount = c.name === 'Narrator' ? 50 : 5;
    }
    const d = deriveSeriesMemory(books)!;
    expect(d.carried.characters[0].character).toBe('Narrator');
    expect(d.carried.characters[0].totalLines).toBe(150); // 50 lines * 3 books
    expect(d.carried.characters.every((c, i, arr) => i === 0 || c.totalLines <= arr[i - 1].totalLines)).toBe(true);
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

  it('counts a character whose voice was designed in a LATER book and reused into the FIRST book (forward matchedFrom)', () => {
    // User scenario: Marrow's voice is first DESIGNED in book 2, then reused
    // BACKWARD into book 1 (the client confirm-matcher links against any prior
    // confirmed book, not only earlier ones) AND forward into book 3. So
    // b1-marrow points FORWARD to b2-marrow, and b3-marrow points back to it —
    // b2-marrow has two incoming edges. The old directional tail-walk dropped
    // book 3 (or split Marrow in two); component connectivity keeps it as one
    // carried character spanning all three books.
    const books = baseBooks();
    const b1m = books[0].characters.find((c) => c.characterId === 'b1-marrow')!;
    const b2m = books[1].characters.find((c) => c.characterId === 'b2-marrow')!;
    const b3m = books[2].characters.find((c) => c.characterId === 'b3-marrow')!;
    b1m.matchedFrom = { bookId: 'b2', characterId: 'b2-marrow' }; // forward: book1 reuses later book2
    b2m.matchedFrom = null; // origin of the design
    b3m.matchedFrom = { bookId: 'b2', characterId: 'b2-marrow' }; // backward: book3 links to book2
    const d = deriveSeriesMemory(books)!;
    const marrowRows = d.carried.characters.filter((c) => c.voiceId === 'v_q_marrow');
    expect(marrowRows).toHaveLength(1); // one logical character, not split in two
    expect(marrowRows[0].bookIndices).toEqual([1, 2, 3]); // book 3 not dropped
    expect(marrowRows[0].carriedFullSpan).toBe(true);
    expect(d.carried.count).toBe(5); // unchanged headline — Marrow still ONE
  });

  it('does not split a forward-reused character into two carried rows across many books', () => {
    // Voice designed in book 2, reused backward into book 1, then carried
    // forward 2→3→4→5. b2 is the shared source with two incoming edges
    // (b1 forward, b3 backward), which the old tail-walk split into [1,2] and
    // [3,4,5] → double count. One component must yield ONE carried row.
    const link = (bookId: string, characterId: string) => ({ bookId, characterId });
    const books: SeriesBookInput[] = [1, 2, 3, 4, 5].map((index) => ({
      bookId: `b${index}`,
      index,
      title: `Book ${index}`,
      characters: [
        ch({ characterId: `b${index}-keefe`, name: 'Keefe', voiceId: 'v_q_keefe' }),
        ch({ characterId: `b${index}-edda`, name: 'Edda', voiceId: 'v_q_edda' }),
        ch({ characterId: `b${index}-vale`, name: 'Vale', voiceId: 'v_q_vale' }),
      ],
    }));
    const keefe = (i: number) => books[i].characters.find((c) => c.name === 'Keefe')!;
    keefe(0).matchedFrom = link('b2', 'b2-keefe'); // book 1 ← later book 2 (forward)
    keefe(1).matchedFrom = null; // origin
    keefe(2).matchedFrom = link('b2', 'b2-keefe'); // book 3 → book 2
    keefe(3).matchedFrom = link('b3', 'b3-keefe'); // book 4 → book 3
    keefe(4).matchedFrom = link('b4', 'b4-keefe'); // book 5 → book 4
    // Give Edda/Vale plain backward chains so the threshold (≥3 carried) is met.
    for (let i = 1; i < 5; i++) {
      books[i].characters.find((c) => c.name === 'Edda')!.matchedFrom = link(`b${i}`, `b${i}-edda`);
      books[i].characters.find((c) => c.name === 'Vale')!.matchedFrom = link(`b${i}`, `b${i}-vale`);
    }
    const d = deriveSeriesMemory(books)!;
    const keefeRows = d.carried.characters.filter((c) => c.voiceId === 'v_q_keefe');
    expect(keefeRows).toHaveLength(1);
    expect(keefeRows[0].bookIndices).toEqual([1, 2, 3, 4, 5]);
    expect(d.carried.count).toBe(3); // Keefe + Edda + Vale, each once
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
