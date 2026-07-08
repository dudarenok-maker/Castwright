import type { BookQaReport } from '../lib/types';

/* fs-51 mock fixture — a clean, fully-covered book, used by the mock API
   surface (VITE_USE_MOCKS=true) and as the e2e default. */
export const MOCK_QA_REPORT: BookQaReport = {
  bookId: 'demo-book',
  generatedAt: '2026-07-05T00:00:00.000Z',
  chaptersRendered: 12,
  chaptersTotal: 12,
  totalLines: 342,
  acoustic: { linesChecked: 342, linesRerecorded: 0, chaptersFlagged: 0 },
  asr: { linesVerified: 342, linesFlaggedDrift: 0 },
  voiceDrift: {
    attribution: 'full',
    chaptersEligible: 12,
    chaptersScored: 12,
    chaptersEmbedFailed: 0,
    charactersOnRoster: 18,
    charactersChecked: 18,
    charactersPending: [],
    mismatches: [],
    inconclusiveCount: 0,
    uncheckedCharacterIds: [],
  },
  configDrift: { counts: { mild: 0, moderate: 0, severe: 0 }, events: [] },
};
