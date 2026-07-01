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
};
