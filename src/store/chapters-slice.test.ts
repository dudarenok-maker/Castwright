// Pairs with docs/features/16-generation-stream.md

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { chaptersSlice, chaptersActions, type ChaptersState } from './chapters-slice';
import type { Chapter, GenerationTick } from '../lib/types';

const makeChapter = (id: number, overrides: Partial<Chapter> = {}): Chapter => ({
  id,
  title: `Chapter ${id}`,
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued', halloran: 'queued', eliza: 'queued' },
  ...overrides,
});

const baseState = (chapters: Chapter[]): ChaptersState => ({
  chapters,
  paused: false,
  lastError: null,
  generationStartedAt: null,
  pendingRegen: null,
  regenEpoch: 0,
  lastTickAt: null,
});

const tick = (t: Partial<GenerationTick> & { type: GenerationTick['type'] }): GenerationTick =>
  t as GenerationTick;

describe('chaptersSlice — applyGenerationTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T10:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  describe('progress', () => {
    it('flips the live character to in_progress and demotes the previous one to done', () => {
      const start = baseState([
        makeChapter(3, {
          state: 'in_progress',
          progress: 0.4,
          characters: { narrator: 'in_progress', halloran: 'queued', eliza: 'queued' },
        }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'progress', chapterId: 3, characterId: 'halloran', progress: 0.55, currentLine: 100, totalLines: 200 }),
      ));
      expect(next.chapters[0].characters).toEqual({
        narrator: 'done',
        halloran: 'in_progress',
        eliza: 'queued',
      });
      expect(next.chapters[0].progress).toBeCloseTo(0.55);
      expect(next.chapters[0].currentLine).toBe(100);
      expect(next.chapters[0].totalLines).toBe(200);
      expect(next.chapters[0].state).toBe('in_progress');
      expect(next.chapters[0].phase).toBe(null);
    });

    it('preserves skipped characters when promoting on progress', () => {
      const start = baseState([
        makeChapter(3, {
          state: 'in_progress',
          characters: { narrator: 'in_progress', halloran: 'skipped', eliza: 'queued' },
        }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'progress', chapterId: 3, characterId: 'eliza', progress: 0.7 }),
      ));
      expect(next.chapters[0].characters.halloran).toBe('skipped');
      expect(next.chapters[0].characters.narrator).toBe('done');
      expect(next.chapters[0].characters.eliza).toBe('in_progress');
    });

    it('sets generationStartedAt on the first progress tick and leaves it alone on later ticks', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress' })]);
      const t0 = Date.now();
      const after1 = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'progress', chapterId: 3, characterId: 'narrator', progress: 0.1 }),
      ));
      expect(after1.generationStartedAt).toBe(t0);
      vi.advanceTimersByTime(60_000);
      const after2 = chaptersSlice.reducer(after1, chaptersActions.applyGenerationTick(
        tick({ type: 'progress', chapterId: 3, characterId: 'narrator', progress: 0.2 }),
      ));
      expect(after2.generationStartedAt).toBe(t0);
    });

    it('does not crash when the tick references an unknown chapterId', () => {
      const start = baseState([makeChapter(3)]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'progress', chapterId: 99, characterId: 'narrator', progress: 0.5 }),
      ));
      expect(next.chapters).toEqual(start.chapters);
    });

    it('leaves per-character state alone when the tick names a character not in this chapter', () => {
      /* Regression: previously the previous-in-progress demotion ran even when
         the new characterId was unknown, so the active speaker silently went
         to `done` while synthesis kept running on an invisible speaker. The
         Generate view then rendered every row as "Done" while the chapter
         row still said "Generating". */
      const start = baseState([
        makeChapter(3, {
          state: 'in_progress',
          progress: 0.4,
          characters: { narrator: 'in_progress', halloran: 'queued', eliza: 'skipped' },
        }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'progress', chapterId: 3, characterId: 'ghost-speaker', progress: 0.6, currentLine: 80, totalLines: 200 }),
      ));
      expect(next.chapters[0].characters).toEqual({
        narrator: 'in_progress',
        halloran: 'queued',
        eliza: 'skipped',
      });
      /* Chapter-level counters still advance — the unknown speaker isn't a
         reason to drop the progress signal. */
      expect(next.chapters[0].progress).toBeCloseTo(0.6);
      expect(next.chapters[0].currentLine).toBe(80);
      expect(next.chapters[0].totalLines).toBe(200);
      expect(next.chapters[0].state).toBe('in_progress');
    });

    it('does not promote a skipped character even when the tick names them', () => {
      const start = baseState([
        makeChapter(3, {
          state: 'in_progress',
          characters: { narrator: 'in_progress', halloran: 'queued', eliza: 'skipped' },
        }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'progress', chapterId: 3, characterId: 'eliza', progress: 0.5 }),
      ));
      expect(next.chapters[0].characters).toEqual({
        narrator: 'in_progress',
        halloran: 'queued',
        eliza: 'skipped',
      });
    });
  });

  describe('chapter_assembling', () => {
    it('sets phase=assembling and defaults progress to 0.995', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', progress: 0.9 })]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'chapter_assembling', chapterId: 3 }),
      ));
      expect(next.chapters[0].phase).toBe('assembling');
      expect(next.chapters[0].state).toBe('in_progress');
      expect(next.chapters[0].progress).toBeCloseTo(0.995);
    });

    it('also starts the ETA clock if not already started', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress' })]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'chapter_assembling', chapterId: 3 }),
      ));
      expect(next.generationStartedAt).toBe(Date.now());
    });
  });

  describe('chapter_complete', () => {
    it('flips state to done, progress to 1, and all non-skipped characters to done', () => {
      const start = baseState([
        makeChapter(3, {
          state: 'in_progress',
          progress: 0.95,
          phase: 'assembling',
          characters: { narrator: 'in_progress', halloran: 'queued', eliza: 'skipped' },
        }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'chapter_complete', chapterId: 3, totalLines: 400 }),
      ));
      expect(next.chapters[0].state).toBe('done');
      expect(next.chapters[0].progress).toBe(1);
      expect(next.chapters[0].phase).toBe(null);
      expect(next.chapters[0].currentLine).toBe(400);
      expect(next.chapters[0].characters).toEqual({
        narrator: 'done',
        halloran: 'done',
        eliza: 'skipped',
      });
    });
  });

  describe('chapter_failed', () => {
    it('with chapterId → that chapter fails with errorReason; lastError stays null', () => {
      const start = baseState([
        makeChapter(3, { state: 'in_progress' }),
        makeChapter(4, { state: 'queued' }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'chapter_failed', chapterId: 3, errorReason: 'TTS sidecar timed out' }),
      ));
      expect(next.chapters[0].state).toBe('failed');
      expect(next.chapters[0].errorReason).toBe('TTS sidecar timed out');
      expect(next.chapters[1].state).toBe('queued');
      expect(next.lastError).toBe(null);
    });

    it('without chapterId (stream-level) populates lastError and fails the in-flight chapter', () => {
      const start = baseState([
        makeChapter(3, { state: 'in_progress' }),
        makeChapter(4, { state: 'queued' }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'chapter_failed', errorReason: 'modelKey rejected' }),
      ));
      expect(next.lastError).toBe('modelKey rejected');
      expect(next.chapters[0].state).toBe('failed');
      expect(next.chapters[0].errorReason).toBe('modelKey rejected');
      expect(next.chapters[1].state).toBe('queued');
    });

    it('without chapterId and no in-flight chapter still populates lastError', () => {
      const start = baseState([
        makeChapter(3, { state: 'queued' }),
        makeChapter(4, { state: 'queued' }),
      ]);
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'chapter_failed', errorReason: 'cast missing' }),
      ));
      expect(next.lastError).toBe('cast missing');
      expect(next.chapters.every(c => c.state === 'queued')).toBe(true);
    });
  });

  describe('idle', () => {
    it('clears pendingRegen and clears generationStartedAt when the queue is drained', () => {
      const start: ChaptersState = {
        ...baseState([makeChapter(3, { state: 'done' })]),
        pendingRegen: { chapterIds: [3], force: true },
        generationStartedAt: Date.now() - 60_000,
      };
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'idle' }),
      ));
      expect(next.pendingRegen).toBe(null);
      expect(next.generationStartedAt).toBe(null);
    });

    it('clears pendingRegen but keeps generationStartedAt while work remains', () => {
      const startedAt = Date.now() - 60_000;
      const start: ChaptersState = {
        ...baseState([makeChapter(3, { state: 'in_progress' })]),
        pendingRegen: { chapterIds: [3], force: true },
        generationStartedAt: startedAt,
      };
      const next = chaptersSlice.reducer(start, chaptersActions.applyGenerationTick(
        tick({ type: 'idle' }),
      ));
      expect(next.pendingRegen).toBe(null);
      expect(next.generationStartedAt).toBe(startedAt);
    });
  });
});

describe('chaptersSlice — regenerate reducers', () => {
  it('regenerateChapter (this) sets pendingRegen to just that chapter and bumps regenEpoch', () => {
    const start = baseState([
      makeChapter(3, { state: 'done', progress: 1, characters: { narrator: 'done', halloran: 'done', eliza: 'done' } }),
      makeChapter(4, { state: 'queued' }),
    ]);
    const next = chaptersSlice.reducer(start, chaptersActions.regenerateChapter({ chapterId: 3, scope: 'this' }));
    expect(next.pendingRegen).toEqual({ chapterIds: [3], force: true });
    expect(next.regenEpoch).toBe(1);
    expect(next.chapters[0].state).toBe('in_progress');
    expect(next.chapters[0].progress).toBeCloseTo(0.05);
    expect(next.chapters[0].characters.narrator).toBe('queued');
    expect(next.chapters[1].state).toBe('queued');
  });

  it('regenerateChapter (forward) targets the chapter and everything after', () => {
    const start = baseState([
      makeChapter(3, { state: 'done',  progress: 1 }),
      makeChapter(4, { state: 'done',  progress: 1 }),
      makeChapter(5, { state: 'queued' }),
    ]);
    const next = chaptersSlice.reducer(start, chaptersActions.regenerateChapter({ chapterId: 4, scope: 'forward' }));
    expect(next.pendingRegen).toEqual({ chapterIds: [4, 5], force: true });
    expect(next.regenEpoch).toBe(1);
    expect(next.chapters[0].state).toBe('done');
    expect(next.chapters[1].state).toBe('in_progress');
    expect(next.chapters[2].state).toBe('queued');
  });

  it('regenerateChapter clears lastError and generationStartedAt', () => {
    const start: ChaptersState = {
      ...baseState([makeChapter(3, { state: 'failed' })]),
      lastError: 'something exploded',
      generationStartedAt: Date.now() - 10_000,
    };
    const next = chaptersSlice.reducer(start, chaptersActions.regenerateChapter({ chapterId: 3, scope: 'this' }));
    expect(next.lastError).toBe(null);
    expect(next.generationStartedAt).toBe(null);
  });

  it('regenerateCharacter targets only chapters where the character is active', () => {
    const start = baseState([
      makeChapter(3, { state: 'done', characters: { narrator: 'done', halloran: 'done', eliza: 'skipped' } }),
      makeChapter(4, { state: 'done', characters: { narrator: 'done', halloran: 'done', eliza: 'done' } }),
    ]);
    const next = chaptersSlice.reducer(start, chaptersActions.regenerateCharacter({
      characterId: 'eliza', chapterIds: [3, 4],
    }));
    expect(next.pendingRegen).toEqual({ chapterIds: [4], force: true });
    expect(next.regenEpoch).toBe(1);
    expect(next.chapters[0].state).toBe('done');
    expect(next.chapters[0].characters.eliza).toBe('skipped');
    expect(next.chapters[1].state).toBe('in_progress');
    expect(next.chapters[1].characters.eliza).toBe('queued');
  });

  it('regenerateCharacter is a no-op when no chapter actually has the character', () => {
    const start = baseState([
      makeChapter(3, { state: 'done', characters: { narrator: 'done', halloran: 'skipped' } }),
    ]);
    const next = chaptersSlice.reducer(start, chaptersActions.regenerateCharacter({
      characterId: 'halloran', chapterIds: [3],
    }));
    expect(next.pendingRegen).toBe(null);
    expect(next.regenEpoch).toBe(0);
  });

  it('batchRegenerateCharacters skips chapters where none of the listed characters are active', () => {
    const start = baseState([
      makeChapter(3, { state: 'done', characters: { narrator: 'done', halloran: 'skipped', eliza: 'skipped' } }),
      makeChapter(4, { state: 'done', characters: { narrator: 'done', halloran: 'done',    eliza: 'done'    } }),
    ]);
    const next = chaptersSlice.reducer(start, chaptersActions.batchRegenerateCharacters({
      characterIds: ['halloran', 'eliza'], chapterIds: [3, 4],
    }));
    expect(next.pendingRegen).toEqual({ chapterIds: [4], force: true });
    expect(next.regenEpoch).toBe(1);
    expect(next.chapters[0].characters.halloran).toBe('skipped');
    expect(next.chapters[1].characters.halloran).toBe('queued');
    expect(next.chapters[1].characters.eliza).toBe('queued');
  });
});

describe('chaptersSlice — hydrateFromAnalysis', () => {
  it('seeds each chapter.characters from sentences when the server emits an empty map', () => {
    /* Regression: analysis.ts composes the AnalyseResponse with
       `chapters[i].characters = {}`. Without seeding here the Generate
       view's expanded chapter row shows no speakers until the first SSE
       tick names a character. */
    const start = baseState([]);
    const next = chaptersSlice.reducer(start, chaptersActions.hydrateFromAnalysis({
      bookId: 'b',
      manuscriptId: 'm',
      title: 'Bonus',
      phaseTimings: [],
      characters: [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', lines: 0, scenes: 0 },
        { id: 'halloran', name: 'Halloran', role: 'main',     color: 'magenta',  lines: 0, scenes: 0 },
      ] as never,
      chapters: [
        { id: 1, title: 'Chapter 1', duration: '00:00', state: 'queued', progress: 0, characters: {} },
        { id: 2, title: 'Chapter 2', duration: '00:00', state: 'queued', progress: 0, characters: {} },
      ],
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narrator', text: 'a' },
        { id: 2, chapterId: 1, characterId: 'narrator', text: 'b' },
        { id: 3, chapterId: 2, characterId: 'narrator', text: 'c' },
        { id: 4, chapterId: 2, characterId: 'halloran', text: 'd' },
      ] as never,
      libraryMatches: [],
    }));
    expect(next.chapters[0].characters).toEqual({ narrator: 'queued' });
    expect(next.chapters[1].characters).toEqual({ narrator: 'queued', halloran: 'queued' });
  });

  it('preserves a pre-populated chapter.characters map (does not clobber later state)', () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(start, chaptersActions.hydrateFromAnalysis({
      bookId: 'b',
      manuscriptId: 'm',
      title: 'Bonus',
      phaseTimings: [],
      characters: [] as never,
      chapters: [
        { id: 1, title: 'Chapter 1', duration: '00:00', state: 'in_progress', progress: 0.5,
          characters: { narrator: 'done', halloran: 'in_progress' } },
      ],
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narrator', text: 'a' },
        { id: 2, chapterId: 1, characterId: 'eliza',    text: 'b' },
      ] as never,
      libraryMatches: [],
    }));
    expect(next.chapters[0].characters).toEqual({ narrator: 'done', halloran: 'in_progress' });
  });
});

describe('chaptersSlice — misc reducers', () => {
  it('setPaused toggles the paused flag', () => {
    const start = baseState([makeChapter(3)]);
    expect(chaptersSlice.reducer(start, chaptersActions.setPaused(true)).paused).toBe(true);
    expect(chaptersSlice.reducer(start, chaptersActions.setPaused(false)).paused).toBe(false);
  });

  it('clearLastError clears the banner without touching anything else', () => {
    const start: ChaptersState = { ...baseState([makeChapter(3)]), lastError: 'modelKey rejected' };
    const next = chaptersSlice.reducer(start, chaptersActions.clearLastError());
    expect(next.lastError).toBe(null);
    expect(next.chapters).toEqual(start.chapters);
  });

  it('consumePendingRegen clears pendingRegen without touching anything else (Pause/Resume loop fix)', () => {
    /* Regression: pause aborts the SSE, idle tick never lands on the client,
       pendingRegen stays set, Resume reopens with force:true and wipes the
       in-flight chapter. The fix is to clear the spec the moment the view
       forwards it to the server — this reducer is the seam. */
    const start: ChaptersState = {
      ...baseState([makeChapter(3, { state: 'in_progress', progress: 0.4 })]),
      pendingRegen: { chapterIds: [3, 4, 5], force: true },
      regenEpoch: 7,
      generationStartedAt: Date.now() - 5_000,
      lastError: 'something',
    };
    const next = chaptersSlice.reducer(start, chaptersActions.consumePendingRegen());
    expect(next.pendingRegen).toBe(null);
    /* Everything else is preserved — the spec has been delivered, the run
       is still alive, the banner (if any) is still relevant. */
    expect(next.regenEpoch).toBe(7);
    expect(next.generationStartedAt).toBe(start.generationStartedAt);
    expect(next.lastError).toBe('something');
    expect(next.chapters).toEqual(start.chapters);
  });
});
