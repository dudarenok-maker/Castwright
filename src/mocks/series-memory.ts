import type { SeriesMemoryDetail } from '../lib/types';

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
     (hollow-tide.ts). Carried cast = the three `usedIn: 3` recurring voices
     in HOLLOW_TIDE_VOICES (hollow-tide.ts:790-823): Narrator, Insp. Cray, Dr.
     Wren, all designed in Book 1 and carried into Book 2. Kept consistent
     with HOLLOW_TIDE_LIBRARY's series.seriesMemory summary (hollow-tide.ts) —
     same carriedCount (3), same confirmedBookCount (2) — see
     hollow-tide.test.ts for the assertion that locks the two together. */
  'Marin Vale::The Hollow Tide': {
    series: {
      confirmedBookCount: 2,
      spanBooks: 4,
      books: [
        { bookId: 'hollow-tide-1', title: 'The Drowning Bell', index: 1, principalCount: 7 },
        { bookId: 'hollow-tide-2', title: 'Saltgrave',         index: 2, principalCount: 6 },
      ],
    },
    carried: {
      count: 3,
      bespokeCount: 0,
      designedCount: 0,
      // Ordered by totalLines desc, matching the Northern Coast entry's convention.
      characters: [
        {
          character: 'Narrator',
          aliases: [],
          voiceId: 'v_marin_narrator',
          voiceLabel: 'Warm · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-2',
          bookIndices: [1, 2],
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
          lastBookId: 'hollow-tide-2',
          bookIndices: [1, 2],
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
          lastBookId: 'hollow-tide-2',
          bookIndices: [1, 2],
          carriedFullSpan: true,
          totalLines: 355,
        },
      ],
    },
  },
};
