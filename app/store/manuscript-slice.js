/* Manuscript slice — holds the uploaded manuscript meta + sentences from
   the analysis response. Sentences are scoped here (not chapters-slice)
   because they're a separate object the backend returns alongside chapters. */

const manuscriptSlice = RTK.createSlice({
  name: 'manuscript',
  initialState: {
    manuscriptId: null,     // null until upload completes
    title: null,
    format: null,
    wordCount: 0,
    sourceText: null,
    sentences: initialSentences,  // seeded with fixtures for "open existing book" flow
  },
  reducers: {
    /* From POST /api/manuscripts response. */
    uploadComplete: (s, a) => {
      const { manuscriptId, title, format, wordCount, sourceText } = a.payload;
      s.manuscriptId = manuscriptId;
      s.title = title;
      s.format = format;
      s.wordCount = wordCount;
      s.sourceText = sourceText;
    },
    /* From POST /api/manuscripts/:id/analysis response. */
    hydrateFromAnalysis: (s, a) => {
      const { sentences } = a.payload;
      if (sentences?.length) s.sentences = sentences;
    },
    reset: (s) => {
      s.manuscriptId = null; s.title = null; s.format = null;
      s.wordCount = 0; s.sourceText = null;
      s.sentences = initialSentences;
    },
  },
});
window.manuscriptSlice = manuscriptSlice;
window.manuscriptActions = manuscriptSlice.actions;
