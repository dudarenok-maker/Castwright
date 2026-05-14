/* Manuscript slice — uploaded manuscript meta + sentences from the analysis
   response. Sentences live here (not in chapters) because they're a separate
   object the backend returns alongside chapters. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { initialSentences } from '../data/sentences';
import type {
  Sentence, UploadResponse, AnalyseResponse, ImportCandidate, BookStateJson,
} from '../lib/types';

export interface ManuscriptState {
  manuscriptId: string | null;
  title: string | null;
  format: UploadResponse['format'] | null;
  wordCount: number;
  sourceText: string | null;
  sentences: Sentence[];
  /** Parsed-but-not-yet-confirmed import (sits between Import and Confirm screens). */
  importCandidate: ImportCandidate | null;
}

const initialState: ManuscriptState = {
  manuscriptId: null,
  title: null,
  format: null,
  wordCount: 0,
  sourceText: null,
  sentences: initialSentences,
  importCandidate: null,
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
      s.importCandidate = null;
    },
    setImportCandidate: (s, a: PayloadAction<ImportCandidate | null>) => {
      s.importCandidate = a.payload;
    },
    /* Merge incoming analysis sentences with the current slice contents.
       On first hydrate (manuscriptId still null, state holds the demo
       fixture) replace wholesale. On re-analysis (manuscriptId already set,
       state holds the user's edited sentences from disk hydration or live
       edits) preserve every sentence whose (chapterId, id) matches an
       incoming one — this carries forward setSentenceCharacter /
       setSentencesCharacter reassignments. Sentences in state but NOT in
       incoming (typical for splitSentence offsprings, whose ids are
       assigned above the analyzer's max) are kept in narrative position.
       Sentences in incoming but NOT in state are appended. Without the
       merge a confirm → reanalyse cycle would silently stomp the user's
       manuscript edits.

       Keying by (chapterId, id) rather than id alone is load-bearing:
       sentence ids restart at 1 in every chapter, so a single-id key
       collapsed all sentences with id=N from earlier chapters onto the
       LAST chapter that owned that id — chapter 1's content vanished
       and the final chapter accumulated copies of every prior chapter
       starting at sentence 1. */
    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      const incoming = a.payload.sentences as unknown as Sentence[] | undefined;
      if (!incoming?.length) return;
      if (s.manuscriptId === null) { s.sentences = incoming; return; }

      const key = (x: Sentence) => `${x.chapterId}:${x.id}`;
      const incomingByKey = new Map<string, Sentence>(incoming.map(x => [key(x), x]));
      const stateKeys = new Set<string>(s.sentences.map(key));
      const merged: Sentence[] = [];
      for (const x of s.sentences) {
        const inc = incomingByKey.get(key(x));
        if (inc) {
          /* Sentence still exists in the new analysis. Refresh fields from
             incoming but preserve characterId (the user's reassignment) and
             text (in case the sentence was split — splitSentence rewrites
             text in place and the analyzer wouldn't know about it). */
          merged.push({ ...inc, characterId: x.characterId, text: x.text });
        } else {
          /* Either a split offspring (id assigned above analyzer max) or a
             sentence the new analysis dropped. Keep it — the GET-side merge
             on a reload would filter true orphans against the fresh cache. */
          merged.push(x);
        }
      }
      for (const inc of incoming) {
        if (!stateKeys.has(key(inc))) merged.push(inc);
      }
      s.sentences = merged;
    },

    /* Rehydrate from a disk-resident book state + manuscript-edits.json.
       Used when opening a previously-analysed book. */
    hydrateFromBookState: (s, a: PayloadAction<{
      state: BookStateJson;
      sentences: Sentence[] | null;
      wordCount?: number | null;
      format?: UploadResponse['format'] | null;
    }>) => {
      const { state, sentences, wordCount, format } = a.payload;
      s.manuscriptId = state.manuscriptId;
      s.title = state.title;
      s.importCandidate = null;
      if (typeof wordCount === 'number' && wordCount > 0) s.wordCount = wordCount;
      if (format) s.format = format;
      if (sentences?.length) s.sentences = sentences;
    },
    reset: (s) => {
      s.manuscriptId = null;
      s.title = null;
      s.format = null;
      s.wordCount = 0;
      s.sourceText = null;
      s.sentences = initialSentences;
      s.importCandidate = null;
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
