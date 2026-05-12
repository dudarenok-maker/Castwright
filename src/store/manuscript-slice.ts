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

    /* User edit: reassign a single sentence to a different character. */
    setSentenceCharacter: (s, a: PayloadAction<{ sentenceId: number; characterId: string }>) => {
      const sent = s.sentences.find(x => x.id === a.payload.sentenceId);
      if (sent) sent.characterId = a.payload.characterId;
    },

    /* User edit: reassign a batch of sentences at once. Used by the
       boundary-drag handle and the segment inspector. */
    setSentencesCharacter: (s, a: PayloadAction<{ sentenceIds: number[]; characterId: string }>) => {
      const ids = new Set(a.payload.sentenceIds);
      for (const sent of s.sentences) {
        if (ids.has(sent.id)) sent.characterId = a.payload.characterId;
      }
    },

    /* User edit: split a sentence's text at the given offsets, producing
       N + 1 pieces, each assigned to its own characterId. Offsets are
       0-based character positions within the original sentence text.
       characterIds.length must equal offsets.length + 1. The first piece
       keeps the original sentence's id; subsequent pieces get new ids
       (max + 1, +2, …) inserted right after it. Empty pieces are skipped. */
    splitSentence: (s, a: PayloadAction<{ sentenceId: number; offsets: number[]; characterIds: string[] }>) => {
      const idx = s.sentences.findIndex(x => x.id === a.payload.sentenceId);
      if (idx < 0) return;
      const original = s.sentences[idx];
      const text = original.text;
      const sorted = [...a.payload.offsets].sort((x, y) => x - y);
      const bounds = [0, ...sorted, text.length];
      const maxId = s.sentences.reduce((m, x) => Math.max(m, x.id), 0);
      const pieces: typeof s.sentences = [];
      let newIdCounter = maxId;
      for (let i = 0; i < bounds.length - 1; i++) {
        const piece = text.slice(bounds[i], bounds[i + 1]);
        if (!piece) continue;
        const isFirst = pieces.length === 0;
        pieces.push({
          ...original,
          id: isFirst ? original.id : ++newIdCounter,
          text: piece,
          characterId: a.payload.characterIds[i] ?? original.characterId,
        });
      }
      if (pieces.length === 0) return;
      s.sentences.splice(idx, 1, ...pieces);
    },
  },
});

export const manuscriptActions = manuscriptSlice.actions;
