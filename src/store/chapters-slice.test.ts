// Pairs with docs/features/archive/16-generation-stream.md

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  aggregateStreamsByBook,
  chaptersSlice,
  chaptersActions,
  forwardRegenChapters,
  selectActiveStreams,
  selectAnyActiveStream,
  type ActiveStreamSnapshot,
  type ChaptersState,
} from './chapters-slice';
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
  lastError: null,
  generationStartedAt: null,
  lastTickAt: null,
  currentBookId: null,
  activeStreams: {},
  renderedSpeakersByChapter: {},
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

    describe('fs-13 completedSentenceIds set', () => {
      it('unions each completion tick\'s sentence ids into the chapter set, even out of narrative order', () => {
        let state = baseState([
          makeChapter(3, {
            state: 'in_progress',
            characters: { narrator: 'in_progress', halloran: 'queued', eliza: 'queued' },
          }),
        ]);
        /* A late-clustered character (eliza) completes BEFORE an earlier one —
           the set must reflect exactly what finished, not a position watermark. */
        state = chaptersSlice.reducer(
          state,
          chaptersActions.applyGenerationTick(
            tick({ type: 'progress', chapterId: 3, characterId: 'eliza', currentLine: 1, completedSentenceIds: [40, 41] }),
          ),
        );
        state = chaptersSlice.reducer(
          state,
          chaptersActions.applyGenerationTick(
            tick({ type: 'progress', chapterId: 3, characterId: 'narrator', currentLine: 2, completedSentenceIds: [1] }),
          ),
        );
        expect([...(state.chapters[0].completedSentenceIds ?? [])].sort((a, b) => a - b)).toEqual([
          1, 40, 41,
        ]);
      });

      it('de-dupes a sentence id re-delivered by a heartbeat replay (idempotent union)', () => {
        let state = baseState([makeChapter(3, { state: 'in_progress' })]);
        const dup = tick({
          type: 'progress',
          chapterId: 3,
          characterId: 'narrator',
          currentLine: 1,
          completedSentenceIds: [7, 8],
        });
        state = chaptersSlice.reducer(state, chaptersActions.applyGenerationTick(dup));
        state = chaptersSlice.reducer(state, chaptersActions.applyGenerationTick(dup));
        expect([...(state.chapters[0].completedSentenceIds ?? [])].sort((a, b) => a - b)).toEqual([
          7, 8,
        ]);
      });

      it('clears a stale set when a not-in-progress chapter receives a fresh progress tick (restart)', () => {
        /* A chapter that was done/queued/failed and gets a new progress tick is
           (re)starting — the prior run's completed set must not leak into it. */
        let state = baseState([
          makeChapter(3, {
            state: 'done',
            completedSentenceIds: [1, 2, 3, 4, 5],
            characters: { narrator: 'done', halloran: 'done', eliza: 'done' },
          }),
        ]);
        state = chaptersSlice.reducer(
          state,
          chaptersActions.applyGenerationTick(
            tick({ type: 'progress', chapterId: 3, characterId: 'narrator', currentLine: 1, completedSentenceIds: [1] }),
          ),
        );
        expect(state.chapters[0].completedSentenceIds).toEqual([1]);
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

  describe('chapter_verifying', () => {
    it('sets phase=verifying, keeps the row in_progress, and carries progress', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', progress: 0.9 })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_verifying', chapterId: 3, progress: 0.99 }),
        ),
      );
      expect(next.chapters[0].phase).toBe('verifying');
      expect(next.chapters[0].state).toBe('in_progress');
      expect(next.chapters[0].progress).toBeCloseTo(0.99);
    });

    it('defaults progress to 0.99 when the tick omits it', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', progress: 0.5 })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'chapter_verifying', chapterId: 3 })),
      );
      expect(next.chapters[0].progress).toBeCloseTo(0.99);
    });

    it('is cleared by a subsequent chapter_complete', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', phase: 'verifying' })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_complete', chapterId: 3, totalLines: 10 }),
        ),
      );
      expect(next.chapters[0].phase).toBe(null);
      expect(next.chapters[0].state).toBe('done');
    });
  });

  describe('chapter_recovering', () => {
    it('holds the row in_progress with phase=recovering and carries progress', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', progress: 0.6 })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_recovering', chapterId: 3, progress: 0.9 }),
        ),
      );
      expect(next.chapters[0].phase).toBe('recovering');
      expect(next.chapters[0].state).toBe('in_progress');
      expect(next.chapters[0].progress).toBeCloseTo(0.9);
    });

    it('keeps the existing progress when the tick omits it', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', progress: 0.42 })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'chapter_recovering', chapterId: 3 })),
      );
      expect(next.chapters[0].phase).toBe('recovering');
      expect(next.chapters[0].progress).toBeCloseTo(0.42);
    });

    it('is cleared by a subsequent chapter_complete', () => {
      const start = baseState([makeChapter(3, { state: 'in_progress', phase: 'recovering' })]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_complete', chapterId: 3, totalLines: 10 }),
        ),
      );
      expect(next.chapters[0].phase).toBe(null);
      expect(next.chapters[0].state).toBe('done');
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

    /* Regression for the duration='00:00' Listen-view bug: chapter_complete
       carries durationSec as a belt-and-suspenders fallback to the
       chapter_assembling tick (which can be dropped by the cross-book
       guard, parallel-chapter coalesce, or a hidden tab). The reducer
       must update ch.duration from this fallback so the chapter row
       flips to its real audio length the moment the Done pill lands. */
    it('updates ch.duration from durationSec when the chapter is stuck at 00:00', () => {
      const start = baseState([
        makeChapter(3, { state: 'in_progress', progress: 0.95, duration: '00:00' }),
      ]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_complete', chapterId: 3, totalLines: 400, durationSec: 768 }),
        ),
      );
      expect(next.chapters[0].duration).toBe('12:48');
    });

    it('updates ch.duration even if assembling already set it — idempotent re-stamp', () => {
      /* When assembling DID land first, the value the chapter_complete
         tick carries is the same one — re-applying it is a no-op the
         reducer pays trivially. This pins that the chapter_complete
         path doesn't gate on "duration looks empty" and silently regress
         to the assembling-only behavior. */
      const start = baseState([
        makeChapter(3, { state: 'in_progress', progress: 0.99, duration: '12:48' }),
      ]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_complete', chapterId: 3, totalLines: 400, durationSec: 768 }),
        ),
      );
      expect(next.chapters[0].duration).toBe('12:48');
    });

    it('leaves ch.duration alone when chapter_complete omits durationSec (older server)', () => {
      const start = baseState([
        makeChapter(3, { state: 'in_progress', progress: 0.99, duration: '11:14' }),
      ]);
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(
          tick({ type: 'chapter_complete', chapterId: 3, totalLines: 400 }),
        ),
      );
      expect(next.chapters[0].duration).toBe('11:14');
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
    it('clears generationStartedAt when the queue is drained', () => {
      const start: ChaptersState = {
        ...baseState([makeChapter(3, { state: 'done' })]),
        generationStartedAt: Date.now() - 60_000,
      };
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'idle' })),
      );
      expect(next.generationStartedAt).toBe(null);
    });

    it('keeps generationStartedAt while work remains', () => {
      const startedAt = Date.now() - 60_000;
      const start: ChaptersState = {
        ...baseState([makeChapter(3, { state: 'in_progress' })]),
        generationStartedAt: startedAt,
      };
      const next = chaptersSlice.reducer(
        start,
        chaptersActions.applyGenerationTick(tick({ type: 'idle' })),
      );
      expect(next.generationStartedAt).toBe(startedAt);
    });
  });
});

describe('chaptersSlice — regenerate reducers', () => {
  it('regenerateChapter (this) flips just that chapter to in_progress', () => {
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

  /* regenerateChapterIds tests — paired with plan 35's bulk-regen
     affordance. The reducer drives the drift-banner "Regenerate all"
     button: an explicit, possibly non-contiguous list of chapter ids
     gets re-queued on the active engine. Each test below pins one
     facet of the contract the middleware + view depend on. */
  it('regenerateChapterIds re-queues every listed chapter (head goes in_progress)', () => {
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
       stays untouched. The head row (id 3) goes in_progress; the
       middleware computes the canonical chapterIds + force from the action. */
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

  it('carries the per-chapter `held` ("Not queued") flag through hydrate', () => {
    /* Bug-1 regression: the user removed an un-rendered chapter from the queue;
       state.json persists `held`, and the row must re-hydrate as "Not queued"
       (held=true) rather than the misleading "Queued". */
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-a' },
          { id: 2, title: 'Chapter 2', slug: '02-b', held: true },
        ],
        completedSlugs: [],
        characters: cast,
      }),
    );
    expect(next.chapters[0].held).toBeUndefined();
    expect(next.chapters[1].held).toBe(true);
    /* `held` rides ON TOP of the underlying state — a held chapter is still
       `queued` underneath (the badge override + count filters read `held`). */
    expect(next.chapters[1].state).toBe('queued');
  });

  it('clears lastError + generationStartedAt on hydrate (fresh frame for the opened book)', () => {
    /* Plan 102 Should #5 removed `chapters.paused` — hydrate no longer has a
       pause flag to inadvertently flip, so the old "auto-start regression"
       trio collapses to this. Whether generation auto-attaches on open is now
       governed entirely by the generation-stream middleware's reconcile
       (hasWork && !queue.paused) — see its sticky-generation tests. Here we
       just pin that hydrate gives the opened book a clean error/ETA frame. */
    const start: ChaptersState = {
      ...baseState([]),
      lastError: 'stale error from a prior book',
      generationStartedAt: Date.now() - 60_000,
    };
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: ['01-chapter-one'],
        characters: cast,
      }),
    );
    expect(next.lastError).toBe(null);
    expect(next.generationStartedAt).toBe(null);
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

  /* Durable per-chapter failure status. A chapter that failed wrote no audio
     so it's absent from completedSlugs; before this, it re-hydrated as the
     misleading neutral "queued". Honor the persisted `generationState:'failed'`
     so it shows "Failed · reason" with a Retry control after a reload / once
     the (clearable) queue entry is gone. */
  it("hydrates a not-done chapter with generationState 'failed' as state 'failed' + errorReason", () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-chapter-one' },
          {
            id: 2,
            title: 'Chapter 2',
            slug: '02-chapter-two',
            generationState: 'failed',
            generationError: "Local TTS sidecar returned 400: Item 0: 'text' is required.",
          },
        ],
        completedSlugs: [],
        characters: cast,
      }),
    );
    expect(next.chapters[0].state).toBe('queued');
    expect(next.chapters[0].errorReason).toBeUndefined();
    expect(next.chapters[1].state).toBe('failed');
    expect(next.chapters[1].errorReason).toBe(
      "Local TTS sidecar returned 400: Item 0: 'text' is required.",
    );
  });

  it("lets a chapter on disk (done) win over a stale generationState 'failed'", () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters: [
          {
            id: 1,
            title: 'Chapter 1',
            slug: '01-chapter-one',
            generationState: 'failed',
            generationError: 'a stale failure that a later successful render should hide',
          },
        ],
        completedSlugs: ['01-chapter-one'],
        characters: cast,
      }),
    );
    expect(next.chapters[0].state).toBe('done');
    expect(next.chapters[0].errorReason).toBeUndefined();
  });

  it("hydrates as 'queued' when generationState is absent (unchanged baseline)", () => {
    const start = baseState([]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.hydrateFromBookState({
        chapters,
        completedSlugs: [],
        characters: cast,
      }),
    );
    expect(next.chapters[0].state).toBe('queued');
    expect(next.chapters[1].state).toBe('queued');
  });
});

describe('chaptersSlice — misc reducers', () => {
  it('requestStreamHalt is a no-op on slice state (the middleware reacts to the action)', () => {
    /* Plan 102 Should #5 — the analyzer "stop the stream NOW" signal carries
       no state; the generation-stream middleware observes the action type and
       closes the open SSE handle. The reducer must leave the slice untouched. */
    const start = baseState([makeChapter(3, { state: 'in_progress' })]);
    const next = chaptersSlice.reducer(start, chaptersActions.requestStreamHalt());
    expect(next).toEqual(start);
  });

  it('clearLastError clears the banner without touching anything else', () => {
    const start: ChaptersState = { ...baseState([makeChapter(3)]), lastError: 'modelKey rejected' };
    const next = chaptersSlice.reducer(start, chaptersActions.clearLastError());
    expect(next.lastError).toBe(null);
    expect(next.chapters).toEqual(start.chapters);
  });

  /* The old `consumePendingRegen` reducer was removed in plan 102 Should #5
     along with the `chapters.pendingRegen` field. The spec the SSE renders now
     lives in middleware-local state (generation-stream-middleware's
     `pendingSpec`) and is drained the instant the runner opens — covered by
     generation-stream-middleware.test.ts's open-side assertions. */
});

describe('chaptersSlice — setChapterHeld ("Not queued", Bug 1)', () => {
  it('sets held=true and resets transient generation state', () => {
    const start = baseState([
      makeChapter(1, {
        state: 'queued',
        progress: 0.4,
        currentLine: 12,
        totalLines: 30,
        errorReason: 'stale',
      }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.setChapterHeld({ chapterId: 1, held: true }),
    );
    expect(next.chapters[0].held).toBe(true);
    expect(next.chapters[0].state).toBe('queued');
    expect(next.chapters[0].progress).toBe(0);
    expect(next.chapters[0].currentLine).toBeUndefined();
    expect(next.chapters[0].totalLines).toBeUndefined();
    expect(next.chapters[0].errorReason).toBeUndefined();
  });

  it('held=false clears the flag (re-add path) without disturbing other rows', () => {
    const start = baseState([makeChapter(1, { state: 'queued', held: true }), makeChapter(2)]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.setChapterHeld({ chapterId: 1, held: false }),
    );
    expect(next.chapters[0].held).toBeUndefined();
    expect(next.chapters[0].state).toBe('queued');
    expect(next.chapters[1]).toEqual(start.chapters[1]);
  });

  it('is a no-op for an unknown chapter id', () => {
    const start = baseState([makeChapter(1)]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.setChapterHeld({ chapterId: 99, held: true }),
    );
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
     as backlog `fe-11`). */
  it('mirrors the inbound snapshot as the per-stream map (keyed by streamKey)', () => {
    const sibling: ActiveStreamSnapshot = {
      streamKey: 'book-sibling::4',
      bookId: 'book-sibling',
      chapterId: 4,
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
    expect(next.activeStreams).toEqual({ 'book-sibling::4': sibling });
    /* Per-chapter rows / pendingRegen / regenEpoch UNCHANGED — proves
       the cross-tab message doesn't contaminate per-tab UI state.
       This is the cross-bookId-isolation invariant the plan locks in. */
    expect(next.chapters).toEqual(start.chapters);
    expect(next.currentBookId).toBe(start.currentBookId);
  });

  it('accepts null to mirror a sibling clearActiveStream', () => {
    const start: ChaptersState = {
      ...baseState([]),
      activeStreams: {
        'book-x::2': {
          streamKey: 'book-x::2',
          bookId: 'book-x',
          chapterId: 2,
          modelKey: 'kokoro-v1',
          done: 5,
          total: 10,
          inProgress: 0,
          lastTickAt: 1000,
          halted: false,
        },
      },
    };
    const next = chaptersSlice.reducer(start, chaptersActions.applyExternalChaptersSnapshot(null));
    expect(next.activeStreams).toEqual({});
  });
});

describe('chaptersSlice — activeStreams per-stream map (queue-sole concurrency)', () => {
  const snap = (
    bookId: string,
    chapterId: number,
    over: Partial<ActiveStreamSnapshot> = {},
  ): ActiveStreamSnapshot => ({
    streamKey: `${bookId}::${chapterId}`,
    bookId,
    chapterId,
    modelKey: 'kokoro-v1',
    done: 0,
    total: 5,
    inProgress: 1,
    lastTickAt: 1000,
    halted: false,
    ...over,
  });

  it('setActiveStream keys by streamKey so two same-book chapters coexist', () => {
    /* Two chapters of the SAME book open independent streams under
       queue-sole concurrency; they must not collide under a shared bookId
       key. */
    let s = chaptersSlice.reducer(
      baseState([]),
      chaptersActions.setActiveStream(snap('book-A', 1)),
    );
    s = chaptersSlice.reducer(s, chaptersActions.setActiveStream(snap('book-A', 2, { done: 2 })));
    expect(Object.keys(s.activeStreams).sort()).toEqual(['book-A::1', 'book-A::2']);
    expect(s.activeStreams['book-A::2'].done).toBe(2);
    /* Both belong to book-A → the pill aggregates them as one book's run. */
    expect(
      selectActiveStreams({ chapters: s }).filter((st) => st.bookId === 'book-A'),
    ).toHaveLength(2);
  });

  it('clearActiveStream(streamKey) removes only that chapter’s stream and leaves the sibling’s pill alive', () => {
    let s = chaptersSlice.reducer(
      baseState([]),
      chaptersActions.setActiveStream(snap('book-A', 1)),
    );
    s = chaptersSlice.reducer(s, chaptersActions.setActiveStream(snap('book-A', 2)));
    s = chaptersSlice.reducer(s, chaptersActions.clearActiveStream('book-A::1'));
    expect(Object.keys(s.activeStreams)).toEqual(['book-A::2']);
    /* The remaining same-book stream keeps the pill alive. */
    expect(selectAnyActiveStream({ chapters: s })).toBe(true);
  });

  it('updateActiveStreamProgress targets the named streamKey and bumps lastTickAt', () => {
    let s = chaptersSlice.reducer(
      baseState([]),
      chaptersActions.setActiveStream(snap('book-A', 1)),
    );
    s = chaptersSlice.reducer(s, chaptersActions.setActiveStream(snap('book-A', 2)));
    s = chaptersSlice.reducer(
      s,
      chaptersActions.updateActiveStreamProgress({
        streamKey: 'book-A::2',
        done: 4,
        inProgress: 2,
      }),
    );
    expect(s.activeStreams['book-A::2'].done).toBe(4);
    expect(s.activeStreams['book-A::2'].inProgress).toBe(2);
    /* Sibling chapter untouched. */
    expect(s.activeStreams['book-A::1'].done).toBe(0);
    /* No-op when the streamKey has no open stream. */
    const after = chaptersSlice.reducer(
      s,
      chaptersActions.updateActiveStreamProgress({ streamKey: 'book-Z::9', done: 9 }),
    );
    expect(after.activeStreams['book-Z::9']).toBeUndefined();
  });

  it('the layout pill dedupes two same-book chapter streams (no double count)', () => {
    /* Each stream's snapshot is BOOK-WIDE (snapshotFromChapters counts every
       active chapter of the book), so two same-book chapter streams each
       report the book's full done/total. Naively summing yields 2×total
       (the `10/14` bug); aggregateStreamsByBook must collapse them to ONE
       book's `done/total/inProgress`. */
    let s = chaptersSlice.reducer(
      baseState([]),
      chaptersActions.setActiveStream(snap('book-A', 1, { done: 5, total: 7, inProgress: 2 })),
    );
    s = chaptersSlice.reducer(
      s,
      chaptersActions.setActiveStream(snap('book-A', 2, { done: 5, total: 7, inProgress: 2 })),
    );
    const agg = aggregateStreamsByBook(selectActiveStreams({ chapters: s }));
    expect(agg).toEqual({ done: 5, total: 7, inProgress: 2 });
  });

  describe('aggregateStreamsByBook', () => {
    it('returns zeros for no streams', () => {
      expect(aggregateStreamsByBook([])).toEqual({ done: 0, total: 0, inProgress: 0 });
    });

    it('passes a single stream through unchanged', () => {
      expect(
        aggregateStreamsByBook([snap('book-A', 1, { done: 3, total: 9, inProgress: 1 })]),
      ).toEqual({ done: 3, total: 9, inProgress: 1 });
    });

    it('dedupes same-book streams by taking the per-book max, absorbing tick skew', () => {
      /* Two snapshots of the same book momentarily disagree (one tick ahead);
         max picks the fresher counters rather than summing them. */
      const agg = aggregateStreamsByBook([
        snap('book-A', 1, { done: 5, total: 7, inProgress: 2 }),
        snap('book-A', 2, { done: 4, total: 7, inProgress: 3 }),
      ]);
      expect(agg).toEqual({ done: 5, total: 7, inProgress: 3 });
    });

    it('sums across DISTINCT books (Wave-3 multi-book run)', () => {
      const agg = aggregateStreamsByBook([
        snap('book-A', 1, { done: 1, total: 5, inProgress: 1 }),
        snap('book-A', 2, { done: 1, total: 5, inProgress: 1 }),
        snap('book-B', 1, { done: 2, total: 7, inProgress: 1 }),
      ]);
      expect(agg).toEqual({ done: 3, total: 12, inProgress: 2 });
    });
  });

  it('selectActiveStreams / selectAnyActiveStream read the map', () => {
    const empty = { chapters: baseState([]) };
    expect(selectActiveStreams(empty)).toEqual([]);
    expect(selectAnyActiveStream(empty)).toBe(false);
    const live = {
      chapters: chaptersSlice.reducer(
        baseState([]),
        chaptersActions.setActiveStream(snap('book-A', 1)),
      ),
    };
    expect(selectActiveStreams(live).map((x) => x.bookId)).toEqual(['book-A']);
    expect(selectAnyActiveStream(live)).toBe(true);
  });

  it('cross-book guard: a tick is dropped when streams are open but none is for the viewed book', () => {
    /* Slice holds book-A rows; a stream is open for book-B only. A progress
       tick for chapter 1 (which exists in book-A's rows) must NOT mutate them
       — it belongs to book-B (chapter ids collide across books). The guard
       now checks "some stream whose bookId === currentBookId". */
    let s: ChaptersState = {
      ...baseState([makeChapter(1, { state: 'queued' })]),
      currentBookId: 'book-A',
    };
    s = chaptersSlice.reducer(s, chaptersActions.setActiveStream(snap('book-B', 1)));
    const after = chaptersSlice.reducer(
      s,
      chaptersActions.applyGenerationTick({
        type: 'progress',
        chapterId: 1,
        progress: 0.9,
      } as GenerationTick),
    );
    expect(after.chapters[0].state).toBe('queued');
    expect(after.chapters[0].progress).toBe(0);
  });

  it('cross-book guard: a tick is APPLIED when some open stream IS for the viewed book', () => {
    /* book-A is the viewed book and has a stream open (chapter 2), while
       book-B also streams. A book-A progress tick for chapter 1 must apply —
       the guard sees a book-A stream and lets it through. */
    let s: ChaptersState = {
      ...baseState([makeChapter(1, { state: 'queued' })]),
      currentBookId: 'book-A',
    };
    s = chaptersSlice.reducer(s, chaptersActions.setActiveStream(snap('book-A', 2)));
    s = chaptersSlice.reducer(s, chaptersActions.setActiveStream(snap('book-B', 1)));
    const after = chaptersSlice.reducer(
      s,
      chaptersActions.applyGenerationTick({
        type: 'progress',
        chapterId: 1,
        progress: 0.9,
      } as GenerationTick),
    );
    expect(after.chapters[0].state).toBe('in_progress');
    expect(after.chapters[0].progress).toBe(0.9);
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
    const next = chaptersSlice.reducer(start, chaptersActions.clearOverrides({ chapterIds: [] }));
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
    const start = baseState([makeChapter(1, { title: 'My User Rename', titleOverridden: true })]);
    const next = chaptersSlice.reducer(start, chaptersActions.clearOverrides({ chapterIds: [1] }));
    // Title stays put for the moment — only the flag flips. The PUT-state
    // round-trip + re-parse refreshes the title.
    expect(next.chapters[0].title).toBe('My User Rename');
    expect(next.chapters[0].titleOverridden).toBe(false);
  });
});

/* Plan 87 — bounded parallel-chapter synthesis. With the server's worker
   pool running K chapters concurrently, the SSE wire now interleaves
   progress / chapter_assembling / chapter_complete ticks across chapters.
   `applyGenerationTick` already routes by `chapterId`, but the parallel
   path is a previously-unexercised seam: a tick for chapter B that lands
   between two of chapter A's ticks MUST mutate B's row without disturbing
   A's. These cases pin that contract. */
describe('chaptersSlice — applyGenerationTick (plan 87 interleaved chapter routing)', () => {
  it('interleaved progress ticks from chapter A and chapter B each mutate only their own row', () => {
    const start = baseState([
      makeChapter(1, {
        state: 'queued',
        characters: { narrator: 'queued', halloran: 'queued' },
      }),
      makeChapter(2, {
        state: 'queued',
        characters: { narrator: 'queued', eliza: 'queued' },
      }),
    ]);
    /* Wire order: ch1 0.01 → ch2 0.01 → ch1 0.3 → ch2 0.5 → ch1 0.7 */
    const t1 = chaptersSlice.reducer(
      start,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'progress',
          chapterId: 1,
          characterId: 'narrator',
          progress: 0.01,
          currentLine: 0,
          totalLines: 100,
        }),
      ),
    );
    const t2 = chaptersSlice.reducer(
      t1,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'progress',
          chapterId: 2,
          characterId: 'narrator',
          progress: 0.01,
          currentLine: 0,
          totalLines: 50,
        }),
      ),
    );
    const t3 = chaptersSlice.reducer(
      t2,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'progress',
          chapterId: 1,
          characterId: 'halloran',
          progress: 0.3,
          currentLine: 30,
          totalLines: 100,
        }),
      ),
    );
    const t4 = chaptersSlice.reducer(
      t3,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'progress',
          chapterId: 2,
          characterId: 'eliza',
          progress: 0.5,
          currentLine: 25,
          totalLines: 50,
        }),
      ),
    );
    const t5 = chaptersSlice.reducer(
      t4,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'progress',
          chapterId: 1,
          characterId: 'narrator',
          progress: 0.7,
          currentLine: 70,
          totalLines: 100,
        }),
      ),
    );
    /* Each row carries its own progress / currentLine — no cross-talk. */
    expect(t5.chapters[0].id).toBe(1);
    expect(t5.chapters[0].progress).toBeCloseTo(0.7);
    expect(t5.chapters[0].currentLine).toBe(70);
    expect(t5.chapters[0].totalLines).toBe(100);
    expect(t5.chapters[0].state).toBe('in_progress');
    expect(t5.chapters[0].characters.narrator).toBe('in_progress');
    expect(t5.chapters[0].characters.halloran).toBe('queued');

    expect(t5.chapters[1].id).toBe(2);
    expect(t5.chapters[1].progress).toBeCloseTo(0.5);
    expect(t5.chapters[1].currentLine).toBe(25);
    expect(t5.chapters[1].totalLines).toBe(50);
    expect(t5.chapters[1].state).toBe('in_progress');
    expect(t5.chapters[1].characters.narrator).toBe('queued');
    expect(t5.chapters[1].characters.eliza).toBe('in_progress');
  });

  it('chapter_complete for B mid-stream does not clobber A still in_progress', () => {
    /* The parallel pool finishes a fast short chapter B while a long
       chapter A is still synthesising. Routing B's chapter_complete must
       NOT touch A's row. */
    const start = baseState([
      makeChapter(1, {
        state: 'in_progress',
        progress: 0.4,
        currentLine: 40,
        totalLines: 100,
        characters: { narrator: 'in_progress', halloran: 'queued' },
      }),
      makeChapter(2, {
        state: 'in_progress',
        progress: 0.9,
        currentLine: 45,
        totalLines: 50,
        characters: { narrator: 'in_progress' },
      }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.applyGenerationTick(
        tick({ type: 'chapter_complete', chapterId: 2, totalLines: 50 }),
      ),
    );
    /* Chapter 1 — completely unchanged. */
    expect(next.chapters[0].state).toBe('in_progress');
    expect(next.chapters[0].progress).toBeCloseTo(0.4);
    expect(next.chapters[0].currentLine).toBe(40);
    expect(next.chapters[0].characters.narrator).toBe('in_progress');
    expect(next.chapters[0].characters.halloran).toBe('queued');
    /* Chapter 2 — flipped to done; non-skipped characters all done. */
    expect(next.chapters[1].state).toBe('done');
    expect(next.chapters[1].progress).toBe(1);
    expect(next.chapters[1].characters.narrator).toBe('done');
  });

  it('chapter_failed for B mid-stream does not flip A, even when A is in_progress', () => {
    /* Without per-chapter routing, the stream-level (no chapterId) failure
       path would flip the live in-progress chapter. We have to verify the
       per-chapter form leaves the OTHER in-progress chapter alone. */
    const start = baseState([
      makeChapter(1, { state: 'in_progress', progress: 0.5 }),
      makeChapter(2, { state: 'in_progress', progress: 0.5 }),
    ]);
    const next = chaptersSlice.reducer(
      start,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'chapter_failed',
          chapterId: 2,
          errorReason: 'TTS sidecar hiccup',
        }),
      ),
    );
    expect(next.chapters[0].state).toBe('in_progress');
    expect(next.chapters[0].progress).toBeCloseTo(0.5);
    expect(next.chapters[0].errorReason).toBeUndefined();
    expect(next.chapters[1].state).toBe('failed');
    expect(next.chapters[1].errorReason).toBe('TTS sidecar hiccup');
    /* Stream-level lastError is for the no-chapterId form only. */
    expect(next.lastError).toBe(null);
  });

  it('two parallel chapters both reach in_progress and both can be tracked simultaneously', () => {
    /* Pre-pool, only one chapter was ever in_progress at a time. With
       K>=2 the slice must tolerate multiple in_progress rows at once
       without any global "active chapter" assumption tripping over. */
    const start = baseState([
      makeChapter(1, { state: 'queued' }),
      makeChapter(2, { state: 'queued' }),
      makeChapter(3, { state: 'queued' }),
    ]);
    let s: ChaptersState = start;
    s = chaptersSlice.reducer(
      s,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'progress',
          chapterId: 1,
          characterId: 'narrator',
          progress: 0.05,
          currentLine: 0,
          totalLines: 10,
        }),
      ),
    );
    s = chaptersSlice.reducer(
      s,
      chaptersActions.applyGenerationTick(
        tick({
          type: 'progress',
          chapterId: 2,
          characterId: 'narrator',
          progress: 0.05,
          currentLine: 0,
          totalLines: 10,
        }),
      ),
    );
    const inProgress = s.chapters.filter((c) => c.state === 'in_progress');
    expect(inProgress.map((c) => c.id).sort()).toEqual([1, 2]);
    expect(s.chapters[2].state).toBe('queued');
  });
});

describe('forwardRegenChapters', () => {
  /* The 'forward' regen scope ("this and all subsequent") must expand to the
     anchor chapter plus every later chapter MINUS excluded ones. Excluded
     front/back-matter (Dedication, Copyright, CONTENTS) has no narration, so
     enqueuing it produces empty no-content queue entries — the bug this
     fixes. Mirrors the !c.excluded predicate already used by
     regenerateChapterIds and enqueueOnWork. */
  const chapters = [
    makeChapter(1),
    makeChapter(2),
    makeChapter(3, { excluded: true }), // back-matter in the forward range
    makeChapter(4),
  ];

  it('returns the anchor plus every later chapter, in order', () => {
    expect(forwardRegenChapters([makeChapter(1), makeChapter(2), makeChapter(3)], 1).map((c) => c.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it('drops chapters before the anchor', () => {
    expect(forwardRegenChapters(chapters, 2).map((c) => c.id)).toEqual([2, 4]);
  });

  it('omits an excluded chapter inside the forward range', () => {
    // chapter 3 is excluded → never enqueued even though 3 >= anchor 1
    expect(forwardRegenChapters(chapters, 1).map((c) => c.id)).toEqual([1, 2, 4]);
  });

  it('includes the anchor itself when it is not excluded', () => {
    expect(forwardRegenChapters(chapters, 4).map((c) => c.id)).toEqual([4]);
  });
});
