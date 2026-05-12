/* Cast slice — characters + their voice assignments. */
const castSlice = RTK.createSlice({
  name: 'cast',
  initialState: { characters: initialCharacters },
  reducers: {
    setCharacters: (s, a) => { s.characters = a.payload; },
    declineMatch: (s, a) => {
      const id = a.payload;
      const c = s.characters.find(x => x.id === id);
      if (c) { c.matchedFrom = undefined; c.voiceState = 'generated'; }
    },
    updateCharacter: (s, a) => {
      const next = a.payload;
      s.characters = s.characters.map(c => c.id === next.id ? { ...c, ...next } : c);
    },
    /* From POST /api/manuscripts/:id/analysis response. */
    hydrateFromAnalysis: (s, a) => {
      const { characters } = a.payload;
      if (characters?.length) s.characters = characters;
    },
    /* From POST /api/books/:bookId/voice-match — see lib/api.js. */
    applyVoiceMatches: (s, a) => {
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
window.castSlice = castSlice;
window.castActions = castSlice.actions;
