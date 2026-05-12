/* Manuscript slice — uploaded manuscript meta + sentences from the analysis
   response. Sentences live here (not in chapters) because they're a separate
   object the backend returns alongside chapters. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { initialSentences } from '../data/sentences';
import type { Sentence, UploadResponse, AnalyseResponse } from '../lib/types';

export interface ManuscriptState {
  manuscriptId: string | null;
  title: string | null;
  format: UploadResponse['format'] | null;
  wordCount: number;
  sourceText: string | null;
  sentences: Sentence[];
}

const initialState: ManuscriptState = {
  manuscriptId: null,
  title: null,
  format: null,
  wordCount: 0,
  sourceText: null,
  sentences: initialSentences,
};

export const manuscriptSlice = createSlice({
  name: 'manuscript',
  initialState,
  reducers: {
    uploadComplete: (s, a: PayloadAction<UploadResponse>) => {
      const { manuscriptId, title, format, wordCount, sourceText } = a.payload;
      s.manuscriptId = manuscriptId;
      s.title = title;
      s.format = format;
      s.wordCount = wordCount;
      s.sourceText = sourceText;
    },
    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      const sentences = a.payload.sentences as unknown as Sentence[] | undefined;
      if (sentences?.length) s.sentences = sentences;
    },
    reset: (s) => {
      s.manuscriptId = null;
      s.title = null;
      s.format = null;
      s.wordCount = 0;
      s.sourceText = null;
      s.sentences = initialSentences;
    },
  },
});

export const manuscriptActions = manuscriptSlice.actions;
