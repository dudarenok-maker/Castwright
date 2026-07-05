import { describe, it, expect } from 'vitest';
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
  HOLLOW_TIDE_POSED,
  HOLLOW_TIDE_VOICES,
  HOLLOW_TIDE_CONTINUE,
  HOLLOW_TIDE_LISTEN_PROGRESS,
} from './hollow-tide';

describe('Hollow Tide marketing fixtures', () => {
  it('exposes the Marin Vale "The Hollow Tide" four-book series', () => {
    const marin = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Marin Vale');
    expect(marin).toBeDefined();
    const series = marin!.series.find((s) => s.name === 'The Hollow Tide');
    expect(series?.books.map((b) => b.bookId)).toEqual([
      'hollow-tide-1',
      'hollow-tide-2',
      'hollow-tide-3',
      'hollow-tide-4',
    ]);
  });

  it('includes Coalfall + its Russian edition + Der Bernsteinturm as Castwright standalones', () => {
    const cw = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Castwright');
    expect(cw?.series[0].books.map((b) => b.bookId)).toEqual([
      'coalfall-commission',
      'coalfall-commission-ru',
      'der-bernsteinturm',
    ]);
  });

  it('poses the four books at finished / generating / analysing / cast_pending', () => {
    const byId = new Map(
      HOLLOW_TIDE_LIBRARY.authors[0].series[0].books.map((b) => [b.bookId, b]),
    );
    expect(byId.get('hollow-tide-1')?.status).toBe('complete');
    expect(byId.get('hollow-tide-2')?.status).toBe('generating');
    expect(byId.get('hollow-tide-3')?.status).toBe('analysing');
    expect(byId.get('hollow-tide-4')?.status).toBe('cast_pending');
  });

  it('provides a book state for every library book', () => {
    for (const bookId of [
      'hollow-tide-1',
      'hollow-tide-2',
      'hollow-tide-3',
      'hollow-tide-4',
      'coalfall-commission',
      'coalfall-commission-ru',
      'der-bernsteinturm',
    ]) {
      expect(HOLLOW_TIDE_BOOK_STATES.get(bookId)?.state.bookId).toBe(bookId);
    }
  });

  describe('hollow-tide-4 — the one book with a genuinely undesigned character', () => {
    it('is cast-confirmed with zero chapters rendered', () => {
      const state = HOLLOW_TIDE_BOOK_STATES.get('hollow-tide-4')!.state;
      expect(state.castConfirmed).toBe(true);
      expect(HOLLOW_TIDE_BOOK_STATES.get('hollow-tide-4')!.completedSlugs).toHaveLength(0);
    });

    it("harbor-clerk omits voiceId/voiceState (not null/'unassigned') so it reads as Needs voice", () => {
      const cast = HOLLOW_TIDE_BOOK_STATES.get('hollow-tide-4')?.cast?.characters ?? [];
      const harborClerk = cast.find((c) => c.id === 'harbor-clerk');
      expect(harborClerk).toBeDefined();
      expect(harborClerk!.voiceId).toBeUndefined();
      expect(harborClerk!.voiceState).toBeUndefined();
      expect(harborClerk!.ttsEngine).toBe('qwen');
      // lines > 0 is what lets the voice-readiness gate actually fire (see
      // src/store/voice-readiness-selectors.ts).
      expect(harborClerk!.lines).toBeGreaterThan(0);
    });

    it('the other two cast members are fully designed (only harbor-clerk needs a voice)', () => {
      const cast = HOLLOW_TIDE_BOOK_STATES.get('hollow-tide-4')?.cast?.characters ?? [];
      const designed = cast.filter((c) => c.id !== 'harbor-clerk');
      expect(designed).toHaveLength(2);
      for (const c of designed) expect(c.voiceId).toBeTruthy();
    });
  });

  describe('Russian + German standalones (fs-1318 Tier D)', () => {
    it('carry their own BCP-47 language on the book state', () => {
      expect(HOLLOW_TIDE_BOOK_STATES.get('coalfall-commission-ru')?.state.language).toBe('ru');
      expect(HOLLOW_TIDE_BOOK_STATES.get('der-bernsteinturm')?.state.language).toBe('de');
    });

    it('carry their own BCP-47 language on the library entry', () => {
      const cw = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Castwright')!;
      const byId = new Map(cw.series[0].books.map((b) => [b.bookId, b]));
      expect(byId.get('coalfall-commission-ru')?.language).toBe('ru');
      expect(byId.get('der-bernsteinturm')?.language).toBe('de');
    });

    it('cast members carry names in their own language', () => {
      const ruCast = HOLLOW_TIDE_BOOK_STATES.get('coalfall-commission-ru')?.cast?.characters ?? [];
      expect(ruCast.map((c) => c.name)).toEqual(['Рассказчик', 'Рен']);
      const deCast = HOLLOW_TIDE_BOOK_STATES.get('der-bernsteinturm')?.cast?.characters ?? [];
      expect(deCast.map((c) => c.name)).toEqual(['Erzählerin', 'Wachtmeister Brandt']);
    });

    it('the 4 original English books are unaffected (language left unset)', () => {
      for (const bookId of ['hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3', 'hollow-tide-4', 'coalfall-commission']) {
        expect(HOLLOW_TIDE_BOOK_STATES.get(bookId)?.state.language).toBeUndefined();
      }
    });
  });

  describe('HOLLOW_TIDE_LISTEN_PROGRESS', () => {
    it('seeds a note and a re-record marker for hollow-tide-1', () => {
      const progress = HOLLOW_TIDE_LISTEN_PROGRESS.get('hollow-tide-1');
      expect(progress).toBeDefined();
      expect(progress!.markers).toHaveLength(2);
      expect(progress!.markers!.map((m) => m.kind)).toEqual(['note', 'rerecord']);
    });

    it('returns undefined for a book with no seeded progress', () => {
      expect(HOLLOW_TIDE_LISTEN_PROGRESS.get('hollow-tide-2')).toBeUndefined();
    });
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

  describe('voice totals (library "VOICES" stat)', () => {
    const allBooks = HOLLOW_TIDE_LIBRARY.authors.flatMap((a) =>
      a.series.flatMap((s) => s.books),
    );

    it('every book carries voiceIds (else the library VOICES total is 0)', () => {
      for (const b of allBooks) expect(Array.isArray(b.voiceIds)).toBe(true);
    });

    it('per-book voiceIds length matches voiceCount', () => {
      // voiceIds and voiceCount should agree for all books now.
      // voiceIdsOf's `voiceId ?? id` fallback pads in harbor-clerk's own id
      // for its undesigned slot, so voiceIds.length (3) counts the fallback id
      // correctly. voiceCount is also 3 to match.
      for (const b of allBooks) {
        expect(b.voiceIds!.length).toBe(b.voiceCount);
      }
    });

    it('distinct voices across the library is non-zero and reflects series reuse', () => {
      // Mirrors book-library.tsx: new Set(flatMap(voiceIds)).size.
      const distinct = new Set(allBooks.flatMap((b) => b.voiceIds ?? [])).size;
      // 10 across the Hollow Tide trilogy (narrator/Cray/Wren reused) + 1 new
      // (hollow-tide-4's undesigned harbor-clerk fallback id) + 13 Coalfall +
      // 2 Russian + 2 German.
      expect(distinct).toBe(28);
    });

    it('Coalfall counts agree with its 13-character cast', () => {
      const coalfall = allBooks.find((b) => b.bookId === 'coalfall-commission')!;
      expect(coalfall.characterCount).toBe(13);
      expect(coalfall.voiceCount).toBe(13);
    });
  });

  describe('HOLLOW_TIDE_CONTINUE', () => {
    it('poses exactly three resume cards', () => {
      expect(HOLLOW_TIDE_CONTINUE).toHaveLength(3);
    });

    it('every item is shape-valid against ContinueListeningItem', () => {
      for (const item of HOLLOW_TIDE_CONTINUE) {
        expect(typeof item.bookId).toBe('string');
        expect(typeof item.title).toBe('string');
        expect(typeof item.chapterId).toBe('number');
        expect(typeof item.currentSec).toBe('number');
        expect(typeof item.remainingSec).toBe('number');
        expect(item.completionPct).toBeGreaterThanOrEqual(0);
        expect(item.completionPct).toBeLessThanOrEqual(1);
        expect(() => new Date(item.updatedAt).toISOString()).not.toThrow();
      }
    });

    it('only features books that exist and have generated audio', () => {
      for (const item of HOLLOW_TIDE_CONTINUE) {
        expect(HOLLOW_TIDE_BOOK_STATES.has(item.bookId)).toBe(true);
        // hollow-tide-3 is still analysing — a resume card would misrepresent it.
        expect(item.bookId).not.toBe('hollow-tide-3');
      }
    });

    it('is ordered most-recently-updated first', () => {
      const times = HOLLOW_TIDE_CONTINUE.map((i) => new Date(i.updatedAt).getTime());
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThan(times[i - 1]);
    });

    it('leads with the nearly-finished book (92%)', () => {
      expect(HOLLOW_TIDE_CONTINUE[0].completionPct).toBe(0.92);
    });
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
