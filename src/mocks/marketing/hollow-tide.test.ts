import { describe, it, expect } from 'vitest';
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
  HOLLOW_TIDE_POSED,
  HOLLOW_TIDE_VOICES,
} from './hollow-tide';

describe('Hollow Tide marketing fixtures', () => {
  it('exposes the Marin Vale "The Hollow Tide" three-book series', () => {
    const marin = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Marin Vale');
    expect(marin).toBeDefined();
    const series = marin!.series.find((s) => s.name === 'The Hollow Tide');
    expect(series?.books.map((b) => b.bookId)).toEqual([
      'hollow-tide-1',
      'hollow-tide-2',
      'hollow-tide-3',
    ]);
  });

  it('includes Coalfall as a Castwright standalone on the shelf', () => {
    const cw = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Castwright');
    expect(cw?.series[0].books[0].bookId).toBe('coalfall-commission');
  });

  it('poses the three books at finished / generating / analysing', () => {
    const byId = new Map(
      HOLLOW_TIDE_LIBRARY.authors[0].series[0].books.map((b) => [b.bookId, b]),
    );
    expect(byId.get('hollow-tide-1')?.status).toBe('complete');
    expect(byId.get('hollow-tide-2')?.status).toBe('generating');
    expect(byId.get('hollow-tide-3')?.status).toBe('analysing');
  });

  it('provides a book state for every library book', () => {
    for (const bookId of ['hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3']) {
      expect(HOLLOW_TIDE_BOOK_STATES.get(bookId)?.state.bookId).toBe(bookId);
    }
  });

  it('marks recurring cast as reused with matchedFrom provenance', () => {
    const cast = HOLLOW_TIDE_BOOK_STATES.get('hollow-tide-2')?.cast?.characters ?? [];
    const reused = cast.filter((c) => c.voiceState === 'reused');
    expect(reused.length).toBeGreaterThanOrEqual(3);
    expect(reused[0].matchedFrom?.bookTitle).toBe('The Drowning Bell');
  });

  it('carries posed analysing + generating snapshots', () => {
    expect(HOLLOW_TIDE_POSED.analysing.bookId).toBe('hollow-tide-3');
    expect(HOLLOW_TIDE_POSED.analysing.phaseProgress).toBeGreaterThan(0);
    expect(HOLLOW_TIDE_POSED.generating.bookId).toBe('hollow-tide-2');
  });

  it('book-state map and library agree on ids', () => {
    for (const author of HOLLOW_TIDE_LIBRARY.authors)
      for (const series of author.series)
        for (const book of series.books)
          expect(HOLLOW_TIDE_BOOK_STATES.has(book.bookId)).toBe(true);
  });

  describe('HOLLOW_TIDE_VOICES', () => {
    it('contains 10 voices covering all 10 characters', () => {
      expect(HOLLOW_TIDE_VOICES.voices).toHaveLength(10);
    });

    it('every voice has id, character, bookId, bookSeries, gradient, usedIn, source, ttsVoice', () => {
      for (const v of HOLLOW_TIDE_VOICES.voices) {
        expect(v.id).toBeTruthy();
        expect(v.character).toBeTruthy();
        expect(v.bookId).toBeTruthy();
        expect(v.bookSeries).toBe('The Hollow Tide');
        expect(v.gradient).toHaveLength(2);
        expect(typeof v.usedIn).toBe('number');
        expect(['current', 'library']).toContain(v.source);
        expect(v.ttsVoice.name).toBeTruthy();
      }
    });

    it('recurring principals have usedIn >= 3 and source current', () => {
      const recurring = HOLLOW_TIDE_VOICES.voices.filter((v) => v.usedIn >= 3);
      expect(recurring.map((v) => v.character).sort()).toEqual(
        ['Dr. Wren', 'Insp. Cray', 'Narrator'].sort(),
      );
      for (const v of recurring) expect(v.source).toBe('current');
    });

    it('book-2 voices belong to hollow-tide-2', () => {
      const book2 = HOLLOW_TIDE_VOICES.voices.filter((v) => v.bookId === 'hollow-tide-2');
      expect(book2.map((v) => v.character).sort()).toEqual(
        ['Magistrate Cross', 'Remy Halse', 'Sable Orn'].sort(),
      );
    });

    it('at least two voices share a base ttsVoice name (family with >1 member)', () => {
      const nameCounts = new Map<string, number>();
      for (const v of HOLLOW_TIDE_VOICES.voices) {
        nameCounts.set(v.ttsVoice.name, (nameCounts.get(v.ttsVoice.name) ?? 0) + 1);
      }
      const shared = [...nameCounts.values()].filter((n) => n > 1);
      expect(shared.length).toBeGreaterThanOrEqual(1);
    });
  });
});
