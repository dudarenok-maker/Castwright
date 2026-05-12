/* Chapters slice — generation state per chapter and per character-in-chapter.
   Includes the regenerate-chapter / regenerate-character / batch-regenerate transitions. */
const chaptersSlice = RTK.createSlice({
  name: 'chapters',
  initialState: { chapters: initialChapters, paused: false },
  reducers: {
    setChapters: (s, a) => { s.chapters = a.payload; },
    setPaused:   (s, a) => { s.paused = a.payload; },
    /* From POST /api/manuscripts/:id/analysis response. */
    hydrateFromAnalysis: (s, a) => {
      const { chapters } = a.payload;
      if (chapters?.length) s.chapters = chapters;
    },
    /* From the generation stream — see lib/api.js mockStreamGeneration. */
    applyGenerationTick: (s, a) => {
      const ev = a.payload;
      if (!ev || ev.type === 'idle') return;
      s.chapters = s.chapters.map(ch => {
        if (ch.id !== ev.chapterId) return ch;
        if (ev.type === 'chapter_failed') {
          return { ...ch, state: 'failed', errorReason: ev.errorReason };
        }
        if (ev.type === 'chapter_complete') {
          // Mark per-character work as done.
          const characters = Object.fromEntries(Object.entries(ch.characters || {}).map(
            ([k, v]) => [k, v === 'skipped' ? 'skipped' : 'done']));
          return { ...ch, state: 'done', progress: 1, currentLine: ev.totalLines, characters };
        }
        // progress — also advance per-character status thresholds
        const characters = { ...(ch.characters || {}) };
        for (const k of Object.keys(characters)) {
          if (characters[k] === 'queued' && ev.progress > 0.6) characters[k] = 'in_progress';
          if (characters[k] === 'in_progress' && ev.progress > 0.95) characters[k] = 'done';
        }
        return { ...ch, progress: ev.progress, currentLine: ev.currentLine, characters };
      });
      // If a chapter just completed, promote the next queued one.
      if (ev.type === 'chapter_complete') {
        const stillBusy = s.chapters.some(c => c.state === 'in_progress');
        if (!stillBusy) {
          const nextIdx = s.chapters.findIndex(c => c.state === 'queued');
          if (nextIdx >= 0) {
            s.chapters[nextIdx] = { ...s.chapters[nextIdx], state: 'in_progress', progress: 0.02, currentLine: 1 };
          }
        }
      }
    },
    regenerateChapter: (s, a) => {
      const { chapterId, scope } = a.payload;
      s.chapters = s.chapters.map(c => {
        if (c.id === chapterId || (scope === 'forward' && c.id > chapterId)) {
          return {
            ...c,
            state:    c.id === chapterId ? 'in_progress' : 'queued',
            progress: c.id === chapterId ? 0.05 : 0,
            characters: Object.fromEntries(
              Object.entries(c.characters).map(([k,v]) => [k, v === 'done' ? 'queued' : v])
            ),
          };
        }
        return c;
      });
    },
    regenerateCharacter: (s, a) => {
      const { characterId, chapterIds } = a.payload;
      s.chapters = s.chapters.map(ch => {
        if (!chapterIds.includes(ch.id)) return ch;
        const cur = ch.characters[characterId];
        if (cur === 'skipped' || !cur) return ch;
        return {
          ...ch,
          characters: { ...ch.characters, [characterId]: 'queued' },
          state:    ch.state === 'done' ? 'in_progress' : ch.state,
          progress: ch.state === 'done' ? 0.85 : ch.progress,
        };
      });
    },
    batchRegenerateCharacters: (s, a) => {
      const { characterIds, chapterIds } = a.payload;
      s.chapters = s.chapters.map(ch => {
        if (!chapterIds.includes(ch.id)) return ch;
        const newChars = { ...ch.characters };
        characterIds.forEach(cid => {
          if (newChars[cid] && newChars[cid] !== 'skipped') newChars[cid] = 'queued';
        });
        return {
          ...ch,
          characters: newChars,
          state:    ch.state === 'done' ? 'in_progress' : ch.state,
          progress: ch.state === 'done' ? 0.78 : ch.progress,
        };
      });
    },
  },
});
window.chaptersSlice = chaptersSlice;
window.chaptersActions = chaptersSlice.actions;
