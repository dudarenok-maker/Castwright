import type { SeriesMemoryDetail } from '../lib/types';

// Shared "carried across every book in a 6-book span" index array — factored
// out so a future span change (or a stale copy left behind by one) has one
// source of truth instead of N duplicated literals.
const HOLLOW_TIDE_FULL_SPAN = [1, 2, 3, 4, 5, 6];

// Populated by Task 11. Key = "<author>::<series>" — must match the library fixture exactly.
// Chosen series: "Northern Coast Trilogy" by "Marin Vale" (bookIds: sb, ns, cc).
export const MOCK_SERIES_MEMORY: Record<string, SeriesMemoryDetail> = {
  'Marin Vale::Northern Coast Trilogy': {
    series: {
      confirmedBookCount: 3,
      spanBooks: 3,
      books: [
        { bookId: 'sb', title: 'Solway Bay',          index: 1, principalCount: 8 },
        { bookId: 'ns', title: 'The Northern Star',   index: 2, principalCount: 9 },
        { bookId: 'cc', title: "Carrick's Compass",   index: 3, principalCount: 9 },
      ],
    },
    carried: {
      count: 4,
      bespokeCount: 3,
      designedCount: 3,
      // Ordered by totalLines desc — matches deriveSeriesMemory's "most-speaking-first" sort.
      characters: [
        {
          character: 'Narrator',
          aliases: [],
          voiceId: 'narrator',
          voiceLabel: 'Deep · Female · UK',
          engine: 'kokoro',
          voiceKind: 'preset',
          firstBookId: 'sb',
          lastBookId: 'cc',
          bookIndices: [1, 2, 3],
          carriedFullSpan: true,
          totalLines: 940,
        },
        {
          character: 'Carrick',
          aliases: [],
          voiceId: 'v-carrick',
          voiceLabel: 'Designed voice',
          engine: 'qwen',
          voiceKind: 'designed',
          firstBookId: 'sb',
          lastBookId: 'cc',
          bookIndices: [1, 2, 3],
          carriedFullSpan: true,
          totalLines: 610,
        },
        {
          character: 'Mara',
          aliases: [],
          voiceId: 'v-mara',
          voiceLabel: 'Designed voice',
          engine: 'qwen',
          voiceKind: 'designed',
          firstBookId: 'sb',
          lastBookId: 'ns',
          bookIndices: [1, 2],
          carriedFullSpan: false,
          totalLines: 340,
        },
        {
          character: 'Doran',
          aliases: [],
          voiceId: 'v-doran',
          voiceLabel: 'Designed voice',
          engine: 'qwen',
          voiceKind: 'designed',
          firstBookId: 'sb',
          lastBookId: 'cc',
          bookIndices: [1, 3],
          carriedFullSpan: false,
          totalLines: 155,
        },
      ],
    },
  },
  /* Marketing/wiki series-memory screenshots — the Hollow Tide series
     (hollow-tide.ts). Carried cast = 5 real HOLLOW_TIDE_VOICES entries:
     Narrator, Insp. Cray, Dr. Wren (the `usedIn: 3` recurring trio, designed
     in Book 1 and carried into Book 2) plus Constance Vale and Magistrate
     Cross (each real, book-specific voices in the source fixture — Constance
     in Book 1, Cross in Book 2 — promoted here to "carried across the
     series" so this fixture can honestly claim a fuller cast without
     inventing new voices). confirmedBookCount/spanBooks (6) are
     deliberately decoupled from `series.books` below (which stays scoped to
     the 2 real, cast books — see hollow-tide.ts's matching comment for why).
     Kept consistent with HOLLOW_TIDE_LIBRARY's series.seriesMemory summary
     (hollow-tide.ts) — same carriedCount (5), same confirmedBookCount (6),
     same spanBooks (6) — see hollow-tide.test.ts for the assertion that
     locks the two together. */
  'Marin Vale::The Hollow Tide': {
    series: {
      confirmedBookCount: 6,
      spanBooks: 6,
      books: [
        { bookId: 'hollow-tide-1', title: 'The Drowning Bell', index: 1, principalCount: 7 },
        { bookId: 'hollow-tide-2', title: 'Saltgrave',         index: 2, principalCount: 6 },
      ],
    },
    carried: {
      count: 5,
      bespokeCount: 0,
      designedCount: 0,
      /* lastBookId/bookIndices below claim the full 6-book span (matching
         confirmedBookCount/spanBooks above and carriedFullSpan on every
         entry), not just the 2 books that actually have rendered content —
         the reveal panel's per-row dot strip renders one dot per book in
         that span (series-memory-reveal.tsx's CarriedRow), so a [1,2]-only
         span would show mostly-empty strips despite carriedFullSpan: true.
         Ordered by totalLines desc, matching the Northern Coast entry's
         convention. */
      characters: [
        {
          character: 'Narrator',
          aliases: [],
          voiceId: 'v_marin_narrator',
          voiceLabel: 'Warm · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-6',
          bookIndices: HOLLOW_TIDE_FULL_SPAN,
          carriedFullSpan: true,
          totalLines: 610,
        },
        {
          character: 'Insp. Cray',
          aliases: [],
          voiceId: 'v_marin_cray',
          voiceLabel: 'Informative · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-6',
          bookIndices: HOLLOW_TIDE_FULL_SPAN,
          carriedFullSpan: true,
          totalLines: 480,
        },
        {
          character: 'Dr. Wren',
          aliases: [],
          voiceId: 'v_marin_wren',
          voiceLabel: 'Breezy · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-6',
          bookIndices: HOLLOW_TIDE_FULL_SPAN,
          carriedFullSpan: true,
          totalLines: 355,
        },
        {
          character: 'Constance Vale',
          aliases: [],
          voiceId: 'v_marin_constance',
          voiceLabel: 'Warm · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-6',
          bookIndices: HOLLOW_TIDE_FULL_SPAN,
          carriedFullSpan: true,
          totalLines: 95,
        },
        {
          character: 'Magistrate Cross',
          aliases: [],
          voiceId: 'v_marin_cross',
          voiceLabel: 'Informative · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          // Cross is a Saltgrave (Book 2) character in the source fixture
          // (HOLLOW_TIDE_VOICES, hollow-tide.ts) — firstBookId must say so,
          // not Book 1 like the other four (a copy-paste miss caught by
          // code review before this fixture's first real precedent existed).
          firstBookId: 'hollow-tide-2',
          lastBookId: 'hollow-tide-6',
          bookIndices: HOLLOW_TIDE_FULL_SPAN,
          carriedFullSpan: true,
          totalLines: 70,
        },
      ],
    },
  },
};
