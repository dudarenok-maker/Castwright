/* Chapters slice — generation state per chapter and per character-in-chapter.

   Source of truth for the Generate tab: chapter state, per-character status,
   the assembling sub-phase, the live `pendingRegen` spec that gets forwarded
   to the server's force/chapterIds payload, and a `lastError` banner for
   stream-level failures the per-chapter slot can't represent. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
/* `initialChapters` (from ../data/chapters) used to seed `chapters` here so
   the design fixture was visible in the demo. That was a footgun: between
   the moment the user clicks a real book and the moment `hydrateFromBookState`
   lands (async fetch of .audiobook/state.json), the Generate view rendered
   the fixture's Moby-Dick-flavoured chapter titles as if they were the user's
   book — a confusing flash of wrong content. Start empty; hydration is the
   only legitimate source of chapter rows for a real book. The fixture still
   exists for the drift-report modal and the mock API. */
import type { Chapter, Character, GenerationTick, AnalyseResponse, BookStateJson, TtsModelKey } from '../lib/types';

/* When the SSE has produced no tick for this long while a chapter is
   in_progress, the Generate view flips that chapter to a "Stalled" amber
   state. The middleware also surfaces the same threshold via the global
   header pill so the user knows the worker has gone quiet from any view. */
export const STALL_THRESHOLD_MS = 30_000;

export interface PendingRegenSpec {
  chapterIds: number[];
  force: true;
}

/** Cross-book snapshot of the in-flight generation run. Set by the
    generation-stream middleware on openHandle and updated on every non-idle
    tick; cleared on closeHandle. Decouples the global header pill from
    `chapters.chapters` so the pill keeps reflecting the *generating* book
    even after the user navigates into a different book and the slice gets
    re-hydrated with that other book's chapter rows. */
export interface ActiveStreamSnapshot {
  bookId: string;
  modelKey: TtsModelKey;
  done: number;
  total: number;
  inProgress: number;
  /** Mirrors slice.lastTickAt at snapshot capture; preserved when the slice
      gets rehydrated for a different book so stall detection still works. */
  lastTickAt: number | null;
  /** Mirrors slice.lastError at snapshot capture; "halted" pill state. */
  halted: boolean;
}

export interface ChaptersState {
  chapters: Chapter[];
  paused: boolean;
  /** Stream-level error (e.g. modelKey rejected, cast missing, sidecar down).
      Surfaced as a banner; cleared on dismiss or on the next successful tick. */
  lastError: string | null;
  /** Set on the first progress tick of a run; cleared when the queue drains
      (idle tick with no in-flight or queued chapters). Drives the real ETA. */
  generationStartedAt: number | null;
  /** Forwarded to the next streamGeneration call as `chapterIds + force`.
      Set by the three regenerate reducers, cleared on `idle` so the spec
      survives Pause→Resume cycles. */
  pendingRegen: PendingRegenSpec | null;
  /** Monotonic counter the Generate view watches as a useEffect dep so it
      re-opens the SSE when a regenerate is requested. */
  regenEpoch: number;
  /** Wall-clock of the last non-idle tick. Combined with STALL_THRESHOLD_MS
      it drives the "Stalled" amber pill on the in-progress chapter row and
      the matching variant on the global header pill. Cleared on idle so a
      drained queue isn't reported as stalled. */
  lastTickAt: number | null;
  /** Which book the `chapters` array currently reflects. Maintained by
      `setChapters` / `hydrateFromBookState` / `hydrateFromAnalysis`. The
      middleware compares this with the open handle's bookId before applying
      per-chapter ticks — when the user navigates into a different book
      mid-run the slice gets repopulated with that book's rows, and ticks
      from the still-running stream would otherwise clobber them. */
  currentBookId: string | null;
  /** Cross-book progress snapshot — see ActiveStreamSnapshot. Non-null
      means a generation stream is open somewhere. */
  activeStream: ActiveStreamSnapshot | null;
}

const initialState: ChaptersState = {
  chapters: [],
  paused: false,
  lastError: null,
  generationStartedAt: null,
  pendingRegen: null,
  regenEpoch: 0,
  lastTickAt: null,
  currentBookId: null,
  activeStream: null,
};

export const chaptersSlice = createSlice({
  name: 'chapters',
  initialState,
  reducers: {
    setChapters: (s, a: PayloadAction<Chapter[]>) => { s.chapters = a.payload; },
    setPaused:   (s, a: PayloadAction<boolean>)   => { s.paused = a.payload; },
    clearLastError: (s) => { s.lastError = null; },

    /** Records which book's rows `chapters` currently reflects. Dispatched
        by Layout's per-book hydration effect (immediately after
        hydrateFromBookState/hydrateFromAnalysis seed the slice) and on
        goHome (with null) so the middleware's tick guard can detect when
        the slice has drifted from the still-streaming book. */
    setCurrentBookId: (s, a: PayloadAction<string | null>) => {
      s.currentBookId = a.payload;
    },

    /** Middleware → slice handshake: sets the cross-book snapshot when a
        stream opens, and replaces it on every non-idle tick with a fresh
        derive of done/total/inProgress/lastTickAt. */
    setActiveStream: (s, a: PayloadAction<ActiveStreamSnapshot>) => {
      s.activeStream = a.payload;
    },

    /** Middleware → slice handshake: cleared on closeHandle (pause,
        queue drain, store teardown). The header pill hides entirely when
        this is null. */
    clearActiveStream: (s) => { s.activeStream = null; },

    /* Called by the Generate view the instant it opens an SSE with a regen
       spec, so a subsequent Pause → Resume cycle re-resumes "naturally"
       (no chapterIds, no force) instead of replaying force:true and wiping
       the just-completed audio. Without this, pendingRegen only clears on
       the server's `idle` tick — but an aborted SSE never delivers that
       tick, so the spec sticks around forever and every Resume kicks off
       a fresh force-regen of the whole target set. */
    consumePendingRegen: (s) => { s.pendingRegen = null; },

    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      const { chapters, sentences, bookId } = a.payload;
      if (!chapters?.length) return;
      /* Atomically claim the slice for this bookId so the cross-book tick
         guard (top of applyGenerationTick) and the middleware's open/close
         gating both have a truthful frame of reference the instant
         chapters land. */
      if (bookId) s.currentBookId = bookId;
      /* Server emits `chapters[i].characters = {}` from analysis; the
         per-chapter speaker map is recoverable from sentences. Without
         this seeding the Generate view's expanded chapter row shows no
         speaker rows until the first SSE tick names a character. */
      const speakersByChapter: Record<number, Set<string>> = {};
      for (const sent of sentences ?? []) {
        (speakersByChapter[sent.chapterId] ??= new Set()).add(sent.characterId);
      }
      s.chapters = chapters.map(c => {
        const known = Object.keys(c.characters ?? {});
        if (known.length > 0) return c;
        const speakers = speakersByChapter[c.id];
        if (!speakers || speakers.size === 0) return c;
        return {
          ...c,
          characters: Object.fromEntries([...speakers].map(id => [id, 'queued' as const])),
        };
      });
    },

    /* Rebuild chapters from a disk-resident state.json + the set of completed
       audio slugs. Used when opening a previously-analysed book. */
    hydrateFromBookState: (s, a: PayloadAction<{
      /** Atomically claims the slice for this bookId so the cross-book
          tick guard has a truthful frame of reference the instant chapters
          land. Optional only because legacy test fixtures predate the
          field; production callers always pass it. */
      bookId?: string;
      chapters: BookStateJson['chapters'];
      completedSlugs: string[];
      characters: Character[];
      /** Per-chapter analysed speaker ids (chapterId → character id list).
          When present, each chapter row is seeded with ONLY the characters
          that actually speak in it. Absent (older server, or no analysis
          cache yet) — fall back to seeding every cast member as queued. */
      chapterCharacters?: Record<number, string[]>;
    }>) => {
      const { bookId, chapters, completedSlugs, characters, chapterCharacters } = a.payload;
      if (bookId) s.currentBookId = bookId;
      const done = new Set(completedSlugs);
      const allCastQueued: Record<string, 'queued'> = {};
      for (const c of characters) allCastQueued[c.id] = 'queued';
      const seedQueued = (chapterId: number): Record<string, 'queued'> => {
        const ids = chapterCharacters?.[chapterId];
        if (!ids || ids.length === 0) return { ...allCastQueued };
        const out: Record<string, 'queued'> = {};
        for (const id of ids) out[id] = 'queued';
        return out;
      };
      const seedDone = (chapterId: number): Record<string, 'done'> => {
        const ids = chapterCharacters?.[chapterId];
        const source = ids && ids.length > 0 ? ids : characters.map(ch => ch.id);
        const out: Record<string, 'done'> = {};
        for (const id of source) out[id] = 'done';
        return out;
      };
      s.chapters = chapters.map(c => ({
        id: c.id,
        title: c.title,
        duration: c.duration ?? '00:00',
        state: done.has(c.slug) ? 'done' : 'queued',
        progress: done.has(c.slug) ? 1 : 0,
        characters: done.has(c.slug) ? seedDone(c.id) : seedQueued(c.id),
        /* Persist the user's per-chapter exclude choice across hydrate so
           the Generate view greys excluded chapters out without waiting
           on a separate fetch. */
        excluded: c.excluded || undefined,
      } as Chapter));
      s.lastError = null;
      s.generationStartedAt = null;
      s.pendingRegen = null;
      s.lastTickAt = null;
      /* Land paused only when there's persisted progress to preserve — i.e.
         at least one chapter already has audio on disk. For a freshly-
         analysed book where everything is still queued, leaving paused
         alone (default false) lets the SSE middleware kick off generation
         the moment the user lands on the Generate view, instead of forcing
         a redundant click of Resume. The "page reload during a long run"
         safety still applies because any in-flight book has completed
         chapters by the time the user reloads — those flip this back to
         paused=true. */
      if (done.size > 0) s.paused = true;
    },

    applyGenerationTick: (s, a: PayloadAction<GenerationTick>) => {
      const ev = a.payload;
      if (!ev) return;

      /* Cross-book guard: when the user opens a different book mid-run, the
         slice gets re-hydrated with that other book's chapter rows. The
         middleware's still-open handle keeps streaming for the original
         book, but its ticks must NOT mutate the now-irrelevant slice — the
         cross-book progress snapshot (activeStream) keeps the header pill
         alive instead. The middleware updates activeStream out-of-band. */
      if (
        s.activeStream &&
        s.currentBookId &&
        s.activeStream.bookId !== s.currentBookId
      ) return;

      /* Start the ETA clock on the first real progress signal of a run. */
      if (s.generationStartedAt == null && (ev.type === 'progress' || ev.type === 'chapter_assembling')) {
        s.generationStartedAt = Date.now();
      }

      /* Every non-idle tick is a heartbeat — the view derives "stalled" from
         (now - lastTickAt) > STALL_THRESHOLD_MS while a chapter is in_progress.
         Set this before any early returns so a stream-level chapter_failed
         tick (no chapterId) still resets the heartbeat clock. */
      if (ev.type !== 'idle') s.lastTickAt = Date.now();

      if (ev.type === 'idle') {
        /* End-of-run: drop the regen spec so it doesn't auto-replay, and clear
           the elapsed clock so the next run starts a fresh ETA. */
        s.pendingRegen = null;
        const stillBusy = s.chapters.some(c => c.state === 'in_progress' || c.state === 'queued');
        if (!stillBusy) {
          s.generationStartedAt = null;
          s.lastTickAt = null;
        }
        return;
      }

      if (ev.type === 'chapter_failed') {
        if (ev.chapterId == null) {
          /* Stream-level setup error (modelKey, cast, sidecar). The whole
             queue is now blocked — surface as a banner AND flip the
             currently in-flight chapter to failed so the spinner stops. */
          s.lastError = ev.errorReason ?? 'Generation halted.';
          const live = s.chapters.find(c => c.state === 'in_progress');
          if (live) {
            live.state = 'failed';
            live.phase = null;
            live.errorReason = ev.errorReason ?? 'Generation halted.';
          }
          return;
        }
        const ch = s.chapters.find(c => c.id === ev.chapterId);
        if (ch) {
          ch.state = 'failed';
          ch.phase = null;
          ch.errorReason = ev.errorReason ?? 'Synthesis failed.';
        }
        return;
      }

      if (ev.chapterId == null) return;
      const ch = s.chapters.find(c => c.id === ev.chapterId);
      if (!ch) return;

      if (ev.type === 'chapter_assembling') {
        ch.phase = 'assembling';
        ch.state = 'in_progress';
        ch.progress = ev.progress ?? 0.995;
        if (ev.currentLine != null) ch.currentLine = ev.currentLine;
        if (ev.totalLines != null) ch.totalLines = ev.totalLines;
        return;
      }

      if (ev.type === 'chapter_complete') {
        ch.state = 'done';
        ch.progress = 1;
        ch.phase = null;
        if (ev.totalLines != null) ch.currentLine = ev.totalLines;
        /* Every non-skipped character is done by definition; preserve
           `skipped` for characters not in this chapter. */
        for (const k of Object.keys(ch.characters)) {
          if (ch.characters[k] !== 'skipped') ch.characters[k] = 'done';
        }
        return;
      }

      /* type === 'progress' — flip the live character and advance counters.
         Use the real `characterId` from the tick rather than progress
         thresholds; the server emits one per same-speaker group. */
      ch.state = 'in_progress';
      ch.phase = null;
      ch.progress = ev.progress ?? ch.progress;
      if (ev.currentLine != null) ch.currentLine = ev.currentLine;
      if (ev.totalLines != null) ch.totalLines = ev.totalLines;
      if (ev.characterId) {
        /* Only reconcile per-character state when the tick names a character
           we can promote. If the live speaker isn't in this chapter's cast
           (e.g. a quoted-character id that didn't survive cast confirmation,
           or any stray id the server happens to emit) the previously-active
           speaker would otherwise get silently flipped with nobody taking
           their place — the Generate view then renders every row as "Done"
           while synthesis quietly continues. Leaving state untouched keeps
           the active speaker visible.

           When we DO have a real new speaker, the previously-active one is
           flipped back to `queued`, NOT `done`. A character can speak many
           lines spread across a chapter (Narrator dominates, the others
           interleave); marking them `done` the moment another speaker takes
           a turn was a lie — by line 13 of 82 every cast member had spoken
           once and the expanded row showed three "Done" rows with full
           green bars while 80% of the chapter was still ahead. Real
           per-character completion is derived in the view from
           `chapter.currentLine` + manuscript line positions; the slice's
           status field just tracks "who is speaking right now". `done`
           still lands on `chapter_complete` for everyone non-skipped. */
        const liveStatus = ch.characters[ev.characterId];
        if (liveStatus && liveStatus !== 'skipped') {
          for (const k of Object.keys(ch.characters)) {
            if (ch.characters[k] === 'in_progress' && k !== ev.characterId) {
              ch.characters[k] = 'queued';
            }
          }
          ch.characters[ev.characterId] = 'in_progress';
        }
      }
    },

    regenerateChapter: (s, a: PayloadAction<{ chapterId: number; scope: 'this' | 'forward' }>) => {
      const { chapterId, scope } = a.payload;
      const targetIds: number[] = [];
      s.chapters = s.chapters.map(c => {
        const inScope = c.id === chapterId || (scope === 'forward' && c.id > chapterId);
        if (!inScope) return c;
        targetIds.push(c.id);
        return {
          ...c,
          state:    c.id === chapterId ? 'in_progress' : 'queued',
          progress: c.id === chapterId ? 0.05 : 0,
          phase:    null,
          errorReason: undefined,
          /* Reset line counters so the expanded row's derived per-character
             progress (which counts manuscript line positions ≤ currentLine)
             doesn't show stale fractions in the gap between regenerate
             firing and the first fresh `progress` tick landing. */
          currentLine: 0,
          characters: Object.fromEntries(
            Object.entries(c.characters).map(([k, v]) => [k, v === 'done' ? 'queued' : v])
          ) as Chapter['characters'],
        };
      });
      if (targetIds.length) {
        s.pendingRegen = { chapterIds: targetIds, force: true };
        s.regenEpoch += 1;
        s.lastError = null;
        s.generationStartedAt = null;
      }
    },

    regenerateCharacter: (s, a: PayloadAction<{ characterId: string; chapterIds: number[] }>) => {
      const { characterId, chapterIds } = a.payload;
      const targetIds: number[] = [];
      s.chapters = s.chapters.map(ch => {
        if (!chapterIds.includes(ch.id)) return ch;
        const cur = ch.characters[characterId];
        if (cur === 'skipped' || !cur) return ch;
        targetIds.push(ch.id);
        const wasDone = ch.state === 'done';
        return {
          ...ch,
          characters: { ...ch.characters, [characterId]: 'queued' },
          state:    wasDone ? 'in_progress' : ch.state,
          progress: wasDone ? 0.05 : ch.progress,
          phase:    null,
          errorReason: undefined,
          /* Same currentLine reset as regenerateChapter — see comment there. */
          currentLine: wasDone ? 0 : ch.currentLine,
        };
      });
      if (targetIds.length) {
        s.pendingRegen = { chapterIds: targetIds, force: true };
        s.regenEpoch += 1;
        s.lastError = null;
        s.generationStartedAt = null;
      }
    },

    /* Merge a subset-analysis response into the slice without wiping
       per-chapter state for chapters that weren't part of the subset.
       Used after a chapter is un-excluded and re-analyzed: the response
       contains the full chapter list, but only the subset's chapters
       have meaningful character maps. We update characters for chapters
       in `chapterIds` and leave the rest of the row (state/progress/
       phase/etc.) untouched. */
    mergeSubsetAnalysis: (s, a: PayloadAction<{ response: AnalyseResponse; chapterIds: number[] }>) => {
      const { response, chapterIds } = a.payload;
      const idSet = new Set(chapterIds);
      const speakersByChapter: Record<number, Set<string>> = {};
      for (const sent of response.sentences ?? []) {
        if (!idSet.has(sent.chapterId)) continue;
        (speakersByChapter[sent.chapterId] ??= new Set()).add(sent.characterId);
      }
      for (const ch of s.chapters) {
        if (!idSet.has(ch.id)) continue;
        const speakers = speakersByChapter[ch.id];
        if (!speakers) continue;
        ch.characters = Object.fromEntries(
          [...speakers].map(id => [id, 'queued' as const]),
        );
      }
    },

    /* Reflect a successful POST /chapters/:chapterId/exclude on the
       slice. The server is the source of truth (state.json + audio
       cleanup), this just keeps the UI consistent without waiting on a
       refetch. When un-excluding, the caller is responsible for kicking
       off subset analysis if the chapter has no cached attribution. */
    setChapterExcluded: (s, a: PayloadAction<{ chapterId: number; excluded: boolean }>) => {
      const { chapterId, excluded } = a.payload;
      const ch = s.chapters.find(c => c.id === chapterId);
      if (!ch) return;
      ch.excluded = excluded ? true : undefined;
      /* When newly excluded, reset transient generation state so the
         row doesn't leave behind a half-progress bar or in_progress
         spinner from before the exclude was applied. */
      if (excluded) {
        ch.state = 'queued';
        ch.progress = 0;
        ch.phase = null;
        ch.currentLine = undefined;
        ch.totalLines = undefined;
        ch.errorReason = undefined;
      }
    },

    batchRegenerateCharacters: (s, a: PayloadAction<{ characterIds: string[]; chapterIds: number[] }>) => {
      const { characterIds, chapterIds } = a.payload;
      const targetIds: number[] = [];
      s.chapters = s.chapters.map(ch => {
        if (!chapterIds.includes(ch.id)) return ch;
        const newChars: Chapter['characters'] = { ...ch.characters };
        let touched = false;
        characterIds.forEach(cid => {
          if (newChars[cid] && newChars[cid] !== 'skipped') {
            newChars[cid] = 'queued';
            touched = true;
          }
        });
        if (!touched) return ch;
        targetIds.push(ch.id);
        const wasDone = ch.state === 'done';
        return {
          ...ch,
          characters: newChars,
          state:    wasDone ? 'in_progress' : ch.state,
          progress: wasDone ? 0.05 : ch.progress,
          phase:    null,
          errorReason: undefined,
          currentLine: wasDone ? 0 : ch.currentLine,
        };
      });
      if (targetIds.length) {
        s.pendingRegen = { chapterIds: targetIds, force: true };
        s.regenEpoch += 1;
        s.lastError = null;
        s.generationStartedAt = null;
      }
    },
  },
});

export const chaptersActions = chaptersSlice.actions;
