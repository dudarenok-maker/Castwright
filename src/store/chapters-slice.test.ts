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
  currentBookId: null,
  activeStream: null,
});

const tick = (t: Partial<GenerationTick> & { type: GenerationTick['type'] }): GenerationTick =>
  t as GenerationTick;

describe('chaptersSlice — applyGenerationTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('progress', () => {
    it('flips the live character to in_progress and demotes the previous one back to queued (NOT done)', () => {
      /* Regression: previously the prior speaker was flipped to `done`, which
         was a lie when they had more lines later in the chapter. By line 13
         of an 82-line chapter every cast member had spoken once and the
         expanded row showed three full-green "Done" bars while 80 % of the
         work was still ahead. Real per-character completion now lives in
         the view, derived from manuscript line positions + currentLine. The
         slice just tracks "who is speaking right now". */
      const start = baseState([
        makeChapter(3, {
          state: 'in_progress',
          progress: 0.4,
          characters: { narrator: 'in_progress', halloran: 'queued', eliza: 'queued' },
        }),
      ]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({
            type: 'progress',
            chapterId: 3,
            characterId: 'halloran',
            progress: 0.55,
            currentLine: 100,
            totalLines: 200,
          }),
        ),
      );
      expect(next.chapters[0].characters).toEqual({
        narrator: 'queued',
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'progress', chapterId: 3, characterId: 'eliza', progress: 0.7 }),
        ),
      );
      expect(next.chapters[0].characters.halloran).toBe('skipped');
      expect(next.chapters[0].characters.narrator).toBe('queued');
      expect(next.chapters[0].characters.eliza).toBe('in_progress');
    });

    it('a previously-active character cycling back to active flips from queued → in_progress (no false "Done")', () => {
      /* End-to-end scenario from the bug screenshot: narrator speaks, then
         halloran, then narrator again. Pre-fix narrator would be "done" by
         the time halloran started; on the third tick narrator would promote
         back to in_progress but the expanded row had already flashed "Done"
         with a full-green bar mid-stream. Post-fix the slice just toggles
         the single in_progress slot and never lies about completion. */
      const start = baseState([
        makeChapter(3, {
          state: 'in_progress',
          characters: { narrator: 'in_progress', halloran: 'queued' },
        }),
      ]);
      const afterHalloran = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({
            type: 'progress',
            chapterId: 3,
            characterId: 'halloran',
            progress: 0.2,
            currentLine: 5,
          }),
        ),
      );
      expect(afterHalloran.chapters[0].characters).toEqual({
        narrator: 'queued',
        halloran: 'in_progress',
      });
      const afterNarratorAgain = chaptersSlice.reducer(
        afterHalloran,
        chaptersActions.applyGenerationTick(
          tick({
            type: 'progress',
            chapterId: 3,
            characterId: 'narrator',
            progress: 0.3,
            currentLine: 8,
          }),
        ),
      );
      expect(afterNarratorAgain.chapters[0].characters).toEqual({
        narrator: 'in_progress',
        halloran: 'queued',
      });
    });

    it('sets generationStartedAt on the first progress tick and leaves it alone on later ticks', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress' })]);
      const t0 = Date.now();
      const after1 = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'progress', chapterId: 3, characterId: 'narrator', progress: 0.1 }),
        ),
      );
      expect(after1.generationStartedAt).toBe(t0);
      vi.advanceTimersByTime(60_000);
      const after2 = chaptersSlice.reducer(
        after1,
        chaptersActions.applyGenerationTick(
          tick({ type: 'progress', chapterId: 3, characterId: 'narrator', progress: 0.2 }),
        ),
      );
      expect(after2.generationStartedAt).toBe(t0);
    });

    it('does not crash when the tick references an unknown chapterId', () => {
      const start = baseState([makeChapter(3)]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'progress', chapterId: 99, characterId: 'narrator', progress: 0.5 }),
        ),
      );
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({
            type: 'progress',
            chapterId: 3,
            characterId: 'ghost-speaker',
            progress: 0.6,
            currentLine: 80,
            totalLines: 200,
          }),
        ),
      );
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'progress', chapterId: 3, characterId: 'eliza', progress: 0.5 }),
        ),
      );
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'chapter_assembling', chapterId: 3 })),
      );
      expect(next.chapters[0].phase).toBe('assembling');
      expect(next.chapters[0].state).toBe('in_progress');
      expect(next.chapters[0].progress).toBeCloseTo(0.995);
    });

    it('also starts the ETA clock if not already started', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress' })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'chapter_assembling', chapterId: 3 })),
      );
      expect(next.generationStartedAt).toBe(Date.now());
    });

    it('captures durationSec into ch.duration so the completed row shows real audio length without a reload', () => {
      /* Regression: previously the slice ignored durationSec on the
         assembling tick, leaving ch.duration at the '00:00' seed from
         analysis until hydrateFromBookState read state.json on the next
         page load. The Generate row therefore reported every freshly-
         finished chapter as 0:00. */
      const start = baseState([makeChapter(3, { state: 'in_progress', duration: '00:00' })]);
      const subMinute = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_assembling', chapterId: 3, durationSec: 42.4 }),
        ),
      );
      expect(subMinute.chapters[0].duration).toBe('00:42');

      const overHour = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_assembling', chapterId: 3, durationSec: 3725.6 }),
        ),
      );
      expect(overHour.chapters[0].duration).toBe('01:02:06');
    });

    it('leaves ch.duration untouched when the assembling tick omits durationSec', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', duration: '12:34' })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'chapter_assembling', chapterId: 3 })),
      );
      expect(next.chapters[0].duration).toBe('12:34');
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_complete', chapterId: 3, totalLines: 400 }),
        ),
      );
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_failed', chapterId: 3, errorReason: 'TTS sidecar timed out' }),
        ),
      );
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_failed', errorReason: 'modelKey rejected' }),
        ),
      );
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_failed', errorReason: 'cast missing' }),
        ),
      );
      expect(next.lastError).toBe('cast missing');
      expect(next.chapters.every((c) => c.state === 'queued')).toBe(true);
    });
  });

  describe('idle', () => {
    it('clears pendingRegen and clears generationStartedAt when the queue is drained', () => {
      const start: ChaptersState = {
        ...baseState([makeChapter(3, { state: 'done' })]),
        pendingRegen: { chapterIds: [3], force: true },
        generationStartedAt: Date.now() - 60_000,
      };
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'idle' })),
      );
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
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'idle' })),
      );
      expect(next.pendingRegen).toBe(null);
      expect(next.generationStartedAt).toBe(startedAt);
    });
  });
});

describe('chaptersSlice — regenerate reducers', () => {
  it('regenerateChapter (this) sets pendingRegen to just that chapter and bumps regenEpoch', () => {
    const start = baseState([
      makeChapter(3, {
        state: 'done',
        progress: 1,
        characters: { narrator: 'done', halloran: 'done', eliza: 'done' },
      }),
      makeChapter(4, { state: 'queued' }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapter({ chapterId: 3, scope: 'this' }),
    );
    expect(next.pendingRegen).toEqual({ chapterIds: [3], force: true });
    expect(next.regenEpoch).toBe(1);
    expect(next.chapters[0].state).toBe('in_progress');
    expect(next.chapters[0].progress).toBeCloseTo(0.05);
    expect(next.chapters[0].characters.narrator).toBe('queued');
    expect(next.chapters[1].state).toBe('queued');
  });

  it('regenerateChapter resets currentLine so the derived per-character progress does not flash stale fractions', () => {
    /* Regression: the expanded chapter row derives "lines synthesised for
       this character" by counting manuscript line positions ≤
       chapter.currentLine. After a regenerate (e.g. on the stitching-fails
       retry path) currentLine kept its old value until the first new tick
       landed, so the row briefly showed the pre-failure fractional progress
       on top of a now-Queued chapter. Reset both currentLine to 0 here. */
    const start = baseState([
      makeChapter(3, {
        state: 'in_progress',
        progress: 0.6,
        currentLine: 40,
        totalLines: 82,
        characters: { narrator: 'in_progress', halloran: 'queued' },
      }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapter({ chapterId: 3, scope: 'this' }),
    );
    expect(next.chapters[0].currentLine).toBe(0);
  });

  it('regenerateChapter (forward) targets the chapter and everything after', () => {
    const start = baseState([
      makeChapter(3, { state: 'done', progress: 1 }),
      makeChapter(4, { state: 'done', progress: 1 }),
      makeChapter(5, { state: 'queued' }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapter({ chapterId: 4, scope: 'forward' }),
    );
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
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapter({ chapterId: 3, scope: 'this' }),
    );
    expect(next.lastError).toBe(null);
    expect(next.generationStartedAt).toBe(null);
  });

  it('regenerateCharacter targets only chapters where the character is active', () => {
    const start = baseState([
      makeChapter(3, {
        state: 'done',
        characters: { narrator: 'done', halloran: 'done', eliza: 'skipped' },
      }),
      makeChapter(4, {
        state: 'done',
        characters: { narrator: 'done', halloran: 'done', eliza: 'done' },
      }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateCharacter({
        characterId: 'eliza',
        chapterIds: [3, 4],
      }),
    );
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
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateCharacter({
        characterId: 'halloran',
        chapterIds: [3],
      }),
    );
    expect(next.pendingRegen).toBe(null);
    expect(next.regenEpoch).toBe(0);
  });

  it('batchRegenerateCharacters skips chapters where none of the listed characters are active', () => {
    const start = baseState([
      makeChapter(3, {
        state: 'done',
        characters: { narrator: 'done', halloran: 'skipped', eliza: 'skipped' },
      }),
      makeChapter(4, {
        state: 'done',
        characters: { narrator: 'done', halloran: 'done', eliza: 'done' },
      }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.batchRegenerateCharacters({
        characterIds: ['halloran', 'eliza'],
        chapterIds: [3, 4],
      }),
    );
    expect(next.pendingRegen).toEqual({ chapterIds: [4], force: true });
    expect(next.regenEpoch).toBe(1);
    expect(next.chapters[0].characters.halloran).toBe('skipped');
    expect(next.chapters[1].characters.halloran).toBe('queued');
    expect(next.chapters[1].characters.eliza).toBe('queued');
  });

  /* regenerateChapterIds tests — paired with plan 35's bulk-regen
     affordance. The reducer drives the drift-banner "Regenerate all"
     button: an explicit, possibly non-contiguous list of chapter ids
     gets re-queued on the active engine. Each test below pins one
     facet of the contract the middleware + view depend on. */
  it('regenerateChapterIds re-queues every listed chapter and stamps pendingRegen', () => {
    const start = baseState([
      makeChapter(3, {
        state: 'done',
        progress: 1,
        audioModelKey: 'coqui-xtts-v2',
        characters: { narrator: 'done', halloran: 'done', eliza: 'done' },
      }),
      makeChapter(4, { state: 'done', progress: 1, audioModelKey: 'coqui-xtts-v2' }),
      makeChapter(5, { state: 'queued', progress: 0 }),
      makeChapter(6, { state: 'done', progress: 1, audioModelKey: 'coqui-xtts-v2' }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapterIds({
        chapterIds: [3, 4, 6],
      }),
    );
    /* Non-contiguous list — chapter 5 was never drifted (queued), so it
       stays untouched. The pendingRegen list mirrors the targets in
       slice order so the head row (id 3) goes in_progress and the
       middleware POSTs the canonical chapterIds + force. */
    expect(next.pendingRegen).toEqual({ chapterIds: [3, 4, 6], force: true });
    expect(next.regenEpoch).toBe(1);
    expect(next.chapters[0].state).toBe('in_progress');
    expect(next.chapters[0].progress).toBeCloseTo(0.05);
    expect(next.chapters[0].characters.narrator).toBe('queued');
    expect(next.chapters[1].state).toBe('queued');
    expect(next.chapters[2].state).toBe('queued'); // chapter 5 untouched
    expect(next.chapters[3].state).toBe('queued');
  });

  it('regenerateChapterIds is a no-op when the list contains only unknown ids', () => {
    const start = baseState([makeChapter(3, { state: 'done' })]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapterIds({
        chapterIds: [99, 100],
      }),
    );
    expect(next.pendingRegen).toBe(null);
    expect(next.regenEpoch).toBe(0);
    expect(next.chapters[0].state).toBe('done');
  });

  it('regenerateChapterIds silently skips excluded chapters', () => {
    /* Plan 35 invariant 6: drift only matters for chapters that
       participate in the book. Re-queuing an excluded chapter would
       re-include it in the bargain — defensive skip here matches the
       view's activeChapters filter and keeps the bulk action honest
       even if a stale id list slips through. */
    const start = baseState([
      makeChapter(3, { state: 'done', audioModelKey: 'coqui-xtts-v2', excluded: false }),
      makeChapter(4, { state: 'queued', audioModelKey: 'coqui-xtts-v2', excluded: true }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapterIds({
        chapterIds: [3, 4],
      }),
    );
    expect(next.pendingRegen).toEqual({ chapterIds: [3], force: true });
    expect(next.chapters[0].state).toBe('in_progress');
    expect(next.chapters[1].state).toBe('queued'); // unchanged
    expect(next.chapters[1].excluded).toBe(true);
  });

  it('regenerateChapterIds clears lastError and generationStartedAt', () => {
    const start: ChaptersState = {
      ...baseState([makeChapter(3, { state: 'done' })]),
      lastError: 'previous run failed',
      generationStartedAt: Date.now() - 10_000,
    };
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.regenerateChapterIds({
        chapterIds: [3],
      }),
    );
    expect(next.lastError).toBe(null);
    expect(next.generationStartedAt).toBe(null);
  });
});

describe('chaptersSlice — hydrateFromAnalysis', () => {
  it('seeds each chapter.characters from sentences when the server emits an empty map', () => {
    /* Regression: analysis.ts composes the AnalyseResponse with
       `chapters[i].characters = {}`. Without seeding here the Generate
       view's expanded chapter row shows no speakers until the first SSE
       tick names a character. */
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromAnalysis({
        bookId: 'b',
        manuscriptId: 'm',
        title: 'Bonus',
        phaseTimings: [],
        characters: [
          {
            id: 'narrator',
            name: 'Narrator',
            role: 'narrator',
            color: 'narrator',
            lines: 0,
            scenes: 0,
          },
          { id: 'halloran', name: 'Halloran', role: 'main', color: 'magenta', lines: 0, scenes: 0 },
        ] as never,
        chapters: [
          {
            id: 1,
            title: 'Chapter 1',
            duration: '00:00',
            state: 'queued',
            progress: 0,
            characters: {},
          },
          {
            id: 2,
            title: 'Chapter 2',
            duration: '00:00',
            state: 'queued',
            progress: 0,
            characters: {},
          },
        ],
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'a' },
          { id: 2, chapterId: 1, characterId: 'narrator', text: 'b' },
          { id: 3, chapterId: 2, characterId: 'narrator', text: 'c' },
          { id: 4, chapterId: 2, characterId: 'halloran', text: 'd' },
        ] as never,
        libraryMatches: [],
      }),
    );
    expect(next.chapters[0].characters).toEqual({ narrator: 'queued' });
    expect(next.chapters[1].characters).toEqual({ narrator: 'queued', halloran: 'queued' });
  });

  it('preserves a pre-populated chapter.characters map (does not clobber later state)', () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromAnalysis({
        bookId: 'b',
        manuscriptId: 'm',
        title: 'Bonus',
        phaseTimings: [],
        characters: [] as never,
        chapters: [
          {
            id: 1,
            title: 'Chapter 1',
            duration: '00:00',
            state: 'in_progress',
            progress: 0.5,
            characters: { narrator: 'done', halloran: 'in_progress' },
          },
        ],
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'a' },
          { id: 2, chapterId: 1, characterId: 'eliza', text: 'b' },
        ] as never,
        libraryMatches: [],
      }),
    );
    expect(next.chapters[0].characters).toEqual({ narrator: 'done', halloran: 'in_progress' });
  });
});

describe('chaptersSlice — hydrateFromBookState', () => {
  const cast = [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', lines: 0, scenes: 0 },
    { id: 'halloran', name: 'Halloran', role: 'main', color: 'magenta', lines: 0, scenes: 0 },
    { id: 'eliza', name: 'Eliza', role: 'main', color: 'rose', lines: 0, scenes: 0 },
  ] as never;

  const chapters = [
    { id: 1, title: 'Chapter 1', slug: '01-chapter-one' },
    { id: 2, title: 'Chapter 2', slug: '02-chapter-two' },
  ];

  it('seeds each chapter with only its analysed speakers when chapterCharacters is provided (flicker regression)', () => {
    /* Pre-fix the reducer rebuilt every chapter's character map from the
       global cast — so the per-chapter filter from hydrateFromAnalysis got
       clobbered by the next getBookState fetch and the Generate view's
       pill list flickered from "filtered" to "everyone in the book". */
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: [],
        characters: cast,
        chapterCharacters: {
          1: ['narrator', 'halloran'],
          2: ['narrator', 'eliza'],
        },
      }),
    );
    expect(next.chapters[0].characters).toEqual({ narrator: 'queued', halloran: 'queued' });
    expect(next.chapters[1].characters).toEqual({ narrator: 'queued', eliza: 'queued' });
  });

  it('falls back to all-cast seeding when chapterCharacters is omitted (back-compat for older servers / pre-analysis)', () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: [],
        characters: cast,
      }),
    );
    expect(next.chapters[0].characters).toEqual({
      narrator: 'queued',
      halloran: 'queued',
      eliza: 'queued',
    });
  });

  it('marks completed chapters as done with only their analysed speakers (not all-cast)', () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: ['01-chapter-one'],
        characters: cast,
        chapterCharacters: {
          1: ['narrator', 'halloran'],
          2: ['narrator', 'eliza'],
        },
      }),
    );
    expect(next.chapters[0].state).toBe('done');
    expect(next.chapters[0].characters).toEqual({ narrator: 'done', halloran: 'done' });
    expect(next.chapters[1].state).toBe('queued');
    expect(next.chapters[1].characters).toEqual({ narrator: 'queued', eliza: 'queued' });
  });

  it('leaves paused=false when no chapters have completed audio on disk (auto-start regression)', () => {
    /* Before this fix the reducer unconditionally forced paused=true on
       every hydrate — which meant landing on Generate after confirming
       cast required an explicit Resume click before anything started. */
    const start: ChaptersState = { ...baseState([]), paused: false };
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: [],
        characters: cast,
      }),
    );
    expect(next.paused).toBe(false);
  });

  it('leaves paused untouched even when chapters are already on disk (sticky-generation contract)', () => {
    /* Reversed from the original "force paused=true on hydrate" rule.
       With the sticky-generation contract (plan 31, invariant 1a) the
       server-side job survives browser reload, so the client should
       always try to attach — forcing paused=true here would make the
       Generate button display Resume and the middleware suppress
       auto-attaching to the still-live job, exactly the symptom that
       prompted this fix (pill disappeared, in-progress chapter looked
       gone, button stuck on Resume). Pause is now an *explicit* signal
       only — setPaused dispatched from the Stop button or the
       local-analyzer guard — and is never inferred from disk state. */
    const start: ChaptersState = { ...baseState([]), paused: false };
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: ['01-chapter-one'],
        characters: cast,
      }),
    );
    expect(next.paused).toBe(false);
  });

  it('preserves a previously-set paused flag across hydrate (does not reset paused=true to false)', () => {
    /* Symmetric to the case above — once the user has explicitly paused,
       a follow-up hydrate (e.g. opening the same book again) must NOT
       silently clear the pause and resume. */
    const start: ChaptersState = { ...baseState([]), paused: true };
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: ['01-chapter-one'],
        characters: cast,
      }),
    );
    expect(next.paused).toBe(true);
  });

  /* Plan 77 — per-chapter EBU R128 sidecar hydration. The book-state
     response now carries `chapterLufs: Record<chapterId, payload | null>`;
     this reducer copies each value onto the runtime Chapter row's `lufs`
     field so the listen-view report card + per-row drift badge can read
     from one source of truth. */
  it('hydrates chapter.lufs from the chapterLufs map keyed by chapter id', () => {
    const start = baseState([]);
    const lufsPayload = {
      i: -16.02,
      lra: 8.4,
      tp: -2.1,
      target: -16,
      twoPass: true,
      measuredAt: '2026-05-20T12:00:00.000Z',
    };
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: [],
        characters: cast,
        chapterLufs: { 1: lufsPayload, 2: null },
      }),
    );
    expect(next.chapters[0].lufs).toEqual(lufsPayload);
    /* `null` entry distinguishes "fetched but no data" from
       "older server / not fetched" — the report card uses this for the
       per-row neutral badge vs. the empty-state banner. */
    expect(next.chapters[1].lufs).toBeNull();
  });

  it('leaves chapter.lufs undefined when chapterLufs is absent (older-server back-compat)', () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: [],
        characters: cast,
      }),
    );
    expect(next.chapters[0].lufs).toBeUndefined();
    expect(next.chapters[1].lufs).toBeUndefined();
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

describe('chaptersSlice — initial state (mock-leak regression)', () => {
  it('starts with an empty chapters array so the design fixture never renders for a real book', () => {
    /* The bug: opening a real book navigated to Generate before the async
       hydrateFromBookState landed; in that window the view rendered the
       design fixture (Moby-Dick-flavoured "The Berth at Liverpool" et al.)
       as if they were the user's book. The fix moves the fixture out of the
       slice's initial state — hydration is now the only legitimate source
       of chapter rows. Don't re-seed it. */
    const initial = chaptersSlice.getInitialState();
    expect(initial.chapters).toEqual([]);
  });
});

describe('chaptersSlice — applyExternalChaptersSnapshot (cross-tab inbound, plan 63)', () => {
  /* Plan 63 hydrate: the broadcast middleware translates inbound
     BroadcastChannel `sync:chapters` messages into this reducer.
     The reducer is intentionally narrow — only `activeStream` is
     mirrored. Per-chapter rows / pendingRegen / regenEpoch must
     stay untouched (broadcasting them would fan out regen side-
     effects across tabs, which is the racing-writes case parked
     as Won't #3). */
  it('replaces activeStream verbatim with the inbound snapshot', () => {
    const sibling = {
      bookId: 'book-sibling',
      modelKey: 'kokoro-v1' as const,
      done: 3,
      total: 10,
      inProgress: 1,
      lastTickAt: 12345,
      halted: false,
    };
    const start = baseState([makeChapter(1, { state: 'in_progress' })]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.applyExternalChaptersSnapshot(sibling),
    );
    expect(next.activeStream).toEqual(sibling);
    /* Per-chapter rows / pendingRegen / regenEpoch UNCHANGED — proves
       the cross-tab message doesn't contaminate per-tab UI state.
       This is the cross-bookId-isolation invariant the plan locks in. */
    expect(next.chapters).toEqual(start.chapters);
    expect(next.pendingRegen).toBe(start.pendingRegen);
    expect(next.regenEpoch).toBe(start.regenEpoch);
    expect(next.currentBookId).toBe(start.currentBookId);
  });

  it('accepts null to mirror a sibling clearActiveStream', () => {
    const start: ChaptersState = {
      ...baseState([]),
      activeStream: {
        bookId: 'book-x',
        modelKey: 'kokoro-v1',
        done: 5,
        total: 10,
        inProgress: 0,
        lastTickAt: 1000,
        halted: false,
      },
    };
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.applyExternalChaptersSnapshot(null),
    );
    expect(next.activeStream).toBeNull();
  });
});

describe('chaptersSlice — renameChapter (plan 78)', () => {
  it('updates the title and locks titleOverridden=true on the target chapter', () => {
    const start = baseState([
      makeChapter(1, { title: 'Chapter 1' }),
      makeChapter(2, { title: 'Chapter 2' }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.renameChapter({ chapterId: 2, title: 'The Hunt Begins' }),
    );
    expect(next.chapters[1].title).toBe('The Hunt Begins');
    expect(next.chapters[1].titleOverridden).toBe(true);
    // Untouched chapter stays untouched.
    expect(next.chapters[0].title).toBe('Chapter 1');
    expect(next.chapters[0].titleOverridden).toBeUndefined();
  });

  it('is a no-op when the chapter id does not exist', () => {
    const start = baseState([makeChapter(1)]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.renameChapter({ chapterId: 99, title: 'Nope' }),
    );
    expect(next).toEqual(start);
  });

  it('preserves other chapter state (progress, characters, excluded) across the rename', () => {
    const start = baseState([
      makeChapter(1, {
        title: 'Chapter 1',
        progress: 0.42,
        state: 'in_progress',
        excluded: true,
        characters: { narrator: 'in_progress', halloran: 'done', eliza: 'queued' },
      }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.renameChapter({ chapterId: 1, title: 'Renamed' }),
    );
    expect(next.chapters[0]).toMatchObject({
      title: 'Renamed',
      titleOverridden: true,
      progress: 0.42,
      state: 'in_progress',
      excluded: true,
      characters: { narrator: 'in_progress', halloran: 'done', eliza: 'queued' },
    });
  });
});

describe('chaptersSlice — clearOverrides (plan 84)', () => {
  it('clears titleOverridden on the listed chapter ids only', () => {
    const start = baseState([
      makeChapter(1, { title: 'One', titleOverridden: true }),
      makeChapter(2, { title: 'Two', titleOverridden: true }),
      makeChapter(3, { title: 'Three', titleOverridden: true }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.clearOverrides({ chapterIds: [1, 3] }),
    );
    expect(next.chapters[0].titleOverridden).toBe(false);
    expect(next.chapters[1].titleOverridden).toBe(true); // not in list
    expect(next.chapters[2].titleOverridden).toBe(false);
  });

  it('is a no-op when the id list is empty', () => {
    const start = baseState([makeChapter(1, { title: 'One', titleOverridden: true })]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.clearOverrides({ chapterIds: [] }),
    );
    expect(next.chapters[0].titleOverridden).toBe(true);
  });

  it('ignores chapter ids that do not exist', () => {
    const start = baseState([makeChapter(1, { title: 'One', titleOverridden: true })]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.clearOverrides({ chapterIds: [99, 42] }),
    );
    expect(next.chapters[0].titleOverridden).toBe(true);
  });

  it('preserves the chapter title (the new manuscript parse will overwrite it on the next state.json round-trip)', () => {
    const start = baseState([
      makeChapter(1, { title: 'My User Rename', titleOverridden: true }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.clearOverrides({ chapterIds: [1] }),
    );
    // Title stays put for the moment — only the flag flips. The PUT-state
    // round-trip + re-parse refreshes the title.
    expect(next.chapters[0].title).toBe('My User Rename');
    expect(next.chapters[0].titleOverridden).toBe(false);
  });
});
