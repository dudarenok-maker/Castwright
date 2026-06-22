/* Mock workspace library used when VITE_USE_MOCKS=true.

   The shape matches GET /api/library — the design experience is unchanged
   from the static BOOKS seed in src/data/books.ts. Book IDs keep their
   short prototype slugs ('ns', 'sb', etc.) so the existing hash routes and
   analysis fixtures continue to resolve. */

import type { LibraryResponse } from '../lib/types';

export const MOCK_LIBRARY: LibraryResponse = {
  authors: [
    {
      name: 'Marin Vale',
      series: [
        {
          name: 'Northern Coast Trilogy',
          seriesMemory: {
            carriedCount: 4, bespokeCount: 3, designedCount: 3, confirmedBookCount: 3, spanBooks: 3,
            perBook: [
              { bookId: 'sb', index: 1, principalCount: 8, carriedPresent: 4 },
              { bookId: 'ns', index: 2, principalCount: 9, carriedPresent: 3 },
              { bookId: 'cc', index: 3, principalCount: 9, carriedPresent: 3 },
            ],
          },
          books: [
            {
              bookId: 'sb',
              title: 'Solway Bay',
              author: 'Marin Vale',
              series: 'Northern Coast Trilogy',
              seriesPosition: 1,
              isStandalone: false,
              status: 'complete',
              chapterCount: 18,
              completedChapters: 18,
              characterCount: 5,
              voiceCount: 5,
              voiceIds: ['narrator', 'v-carrick', 'v-mara', 'v-doran', 'v-elsie'],
              progress: 1.0,
              runtime: '11h 24m',
              lastWorkedOn: '3 days ago',
              coverGradient: ['#6B6663', '#1A1A1A'],
              tags: ['favourite', 'series-1'],
            },
            {
              bookId: 'ns',
              title: 'The Northern Star',
              author: 'Marin Vale',
              series: 'Northern Coast Trilogy',
              seriesPosition: 2,
              isStandalone: false,
              status: 'generating',
              chapterCount: 7,
              completedChapters: 2,
              characterCount: 4,
              voiceCount: 4,
              /* Book 2 reuses narrator/Carrick/Mara from Solway Bay + one new
                 voice — the series-consistency headline. */
              voiceIds: ['narrator', 'v-carrick', 'v-mara', 'v-tane'],
              progress: 0.42,
              runtime: '4h 38m',
              lastWorkedOn: '2 min ago',
              coverGradient: ['#3C194F', '#0F0E0D'],
              pinned: true,
              tags: ['series-1'],
            },
            {
              bookId: 'cc',
              title: "Carrick's Compass",
              author: 'Marin Vale',
              series: 'Northern Coast Trilogy',
              seriesPosition: 3,
              isStandalone: false,
              status: 'cast_pending',
              chapterCount: 22,
              completedChapters: 0,
              characterCount: 6,
              voiceCount: 3,
              /* All 3 ready voices were matched from the series library (hence
                 matchedFromLibrary: 3) — every id reused from Solway Bay. */
              voiceIds: ['narrator', 'v-carrick', 'v-doran'],
              matchedFromLibrary: 3,
              lastWorkedOn: 'Yesterday',
              coverGradient: ['#D4A04E', '#7B5A26'],
              tags: [],
            },
          ],
        },
        {
          name: 'Standalones',
          books: [
            {
              bookId: 'ts',
              title: 'Twilight Stations',
              author: 'Marin Vale',
              series: 'Standalones',
              seriesPosition: null,
              isStandalone: true,
              status: 'analysing',
              chapterCount: 0,
              completedChapters: 0,
              characterCount: 0,
              voiceCount: 0,
              voiceIds: [],
              progress: 0.34,
              lastWorkedOn: 'Just now',
              coverGradient: ['#A43C6C', '#3C194F'],
              tags: ['favourite'],
              /* fe-16 — the workspace's one Russian book, so the library spans
                 >1 language and the En/Русский filter pills render under mocks. */
              language: 'ru',
            },
          ],
        },
      ],
    },
  ],
};
