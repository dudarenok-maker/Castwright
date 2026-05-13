/* Cast slice — characters + their voice assignments. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Character, AnalyseResponse, VoiceMatchResponse } from '../lib/types';

export interface CastState { characters: Character[]; }

/* Empty initial state — the fixture seed (`initialCharacters` from
   ../data/characters) used to live here so the demo had something to show,
   but that meant a real book's Cast view briefly displayed fixture
   characters between click and async hydration. Hydration via
   `hydrateFromAnalysis` / `setCharacters` (from the layout's getBookState
   handler) is the only legitimate source for a real book. */
const initialState: CastState = { characters: [] };

export const castSlice = createSlice({
  name: 'cast',
  initialState,
  reducers: {
    setCharacters: (s, a: PayloadAction<Character[]>) => { s.characters = a.payload; },
    declineMatch: (s, a: PayloadAction<string>) => {
      const c = s.characters.find(x => x.id === a.payload);
      if (c) { c.matchedFrom = undefined; c.voiceState = 'generated'; }
    },
    /* Pin a character's voice so subsequent regenerates preserve it. The
       Profile Drawer's Lock button dispatches this; the change-log slice
       records the matching voice_lock event. */
    lockVoice: (s, a: PayloadAction<string>) => {
      const c = s.characters.find(x => x.id === a.payload);
      if (c) c.voiceState = 'locked';
    },
    updateCharacter: (s, a: PayloadAction<Character>) => {
      const next = a.payload;
      s.characters = s.characters.map(c => c.id === next.id ? { ...c, ...next } : c);
    },
    /* From POST /api/manuscripts/:id/analysis response. */
    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      const { characters } = a.payload;
      if (characters?.length) s.characters = characters;
    },
    /* From POST /api/books/:bookId/voice-match. */
    applyVoiceMatches: (s, a: PayloadAction<VoiceMatchResponse>) => {
      const { matches } = a.payload;
      const byId = Object.fromEntries((matches || []).map(m => [m.characterId, m]));
      s.characters = s.characters.map(c => {
        const m = byId[c.id];
        if (!m || !m.candidates?.length) return c;
        const top = m.candidates[0];
        return {
          ...c,
          voiceId: top.voiceId,
          matchedFrom: { bookTitle: top.fromBookTitle, confidence: top.score },
          matchFactors: top.factors,
          voiceState: 'reused',
        };
      });
    },
  },
});

export const castActions = castSlice.actions;
