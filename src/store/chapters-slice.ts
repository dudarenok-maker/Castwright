/* Chapters slice — generation state per chapter and per character-in-chapter. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { initialChapters } from '../data/chapters';
import type { Chapter, Character, GenerationTick, AnalyseResponse, BookStateJson } from '../lib/types';

export interface ChaptersState { chapters: Chapter[]; paused: boolean; }

const initialState: ChaptersState = { chapters: initialChapters, paused: false };

export const chaptersSlice = createSlice({
  name: 'chapters',
  initialState,
  reducers: {
    setChapters: (s, a: PayloadAction<Chapter[]>) => { s.chapters = a.payload; },
    setPaused:   (s, a: PayloadAction<boolean>)   => { s.paused = a.payload; },

    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      const { chapters } = a.payload;
      if (chapters?.length) s.chapters = chapters;
    },

    /* Rebuild chapters from a disk-resident state.json + the set of completed
       audio slugs. Used when opening a previously-analysed book. */
    hydrateFromBookState: (s, a: PayloadAction<{
      chapters: BookStateJson['chapters'];
      completedSlugs: string[];
      characters: Character[];
    }>) => {
      const { chapters, completedSlugs, characters } = a.payload;
      const done = new Set(completedSlugs);
      const perCharInitial: Record<string, 'done' | 'queued'> = {};
      const queuedChar: Record<string, 'queued'> = {};
      for (const c of characters) queuedChar[c.id] = 'queued';
      s.chapters = chapters.map(c => ({
        id: c.id,
        title: c.title,
        duration: c.duration ?? '00:00',
        state: done.has(c.slug) ? 'done' : 'queued',
        progress: done.has(c.slug) ? 1 : 0,
        characters: done.has(c.slug)
          ? Object.fromEntries(characters.map(ch => [ch.id, 'done' as const]))
          : { ...queuedChar },
      } as Chapter & { characters: typeof perCharInitial }));
    },

    applyGenerationTick: (s, a: PayloadAction<GenerationTick>) => {
      const ev = a.payload;
      if (!ev || ev.type === 'idle') return;
      s.chapters = s.chapters.map(ch => {
        if (ch.id !== ev.chapterId) return ch;
        if (ev.type === 'chapter_failed') {
          return { ...ch, state: 'failed', errorReason: ev.errorReason };
        }
        if (ev.type === 'chapter_complete') {
          const characters = Object.fromEntries(Object.entries(ch.characters || {}).map(
            ([k, v]) => [k, v === 'skipped' ? 'skipped' : 'done'])) as Chapter['characters'];
          return { ...ch, state: 'done', progress: 1, currentLine: ev.totalLines, characters };
        }
        // progress
        const characters: Chapter['characters'] = { ...(ch.characters || {}) };
        for (const k of Object.keys(characters)) {
          if (characters[k] === 'queued' && (ev.progress ?? 0) > 0.6) characters[k] = 'in_progress';
          if (characters[k] === 'in_progress' && (ev.progress ?? 0) > 0.95) characters[k] = 'done';
        }
        return { ...ch, progress: ev.progress ?? ch.progress, currentLine: ev.currentLine, characters };
      });
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

    regenerateChapter: (s, a: PayloadAction<{ chapterId: number; scope: 'this' | 'forward' }>) => {
      const { chapterId, scope } = a.payload;
      s.chapters = s.chapters.map(c => {
        if (c.id === chapterId || (scope === 'forward' && c.id > chapterId)) {
          return {
            ...c,
            state:    c.id === chapterId ? 'in_progress' : 'queued',
            progress: c.id === chapterId ? 0.05 : 0,
            characters: Object.fromEntries(
              Object.entries(c.characters).map(([k, v]) => [k, v === 'done' ? 'queued' : v])
            ) as Chapter['characters'],
          };
        }
        return c;
      });
    },

    regenerateCharacter: (s, a: PayloadAction<{ characterId: string; chapterIds: number[] }>) => {
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

    batchRegenerateCharacters: (s, a: PayloadAction<{ characterIds: string[]; chapterIds: number[] }>) => {
      const { characterIds, chapterIds } = a.payload;
      s.chapters = s.chapters.map(ch => {
        if (!chapterIds.includes(ch.id)) return ch;
        const newChars: Chapter['characters'] = { ...ch.characters };
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

export const chaptersActions = chaptersSlice.actions;
