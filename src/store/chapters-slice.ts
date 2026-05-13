/* Chapters slice — generation state per chapter and per character-in-chapter.

   Source of truth for the Generate tab: chapter state, per-character status,
   the assembling sub-phase, the live `pendingRegen` spec that gets forwarded
   to the server's force/chapterIds payload, and a `lastError` banner for
   stream-level failures the per-chapter slot can't represent. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { initialChapters } from '../data/chapters';
import type { Chapter, Character, GenerationTick, AnalyseResponse, BookStateJson } from '../lib/types';

/* When the SSE has produced no tick for this long while a chapter is
   in_progress, the Generate view flips that chapter to a "Stalled" amber
   state. The middleware also surfaces the same threshold via the global
   header pill so the user knows the worker has gone quiet from any view. */
export const STALL_THRESHOLD_MS = 30_000;

export interface PendingRegenSpec {
  chapterIds: number[];
  force: true;
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
}

const initialState: ChaptersState = {
  chapters: initialChapters,
  paused: false,
  lastError: null,
  generationStartedAt: null,
  pendingRegen: null,
  regenEpoch: 0,
  lastTickAt: null,
};

export const chaptersSlice = createSlice({
  name: 'chapters',
  initialState,
  reducers: {
    setChapters: (s, a: PayloadAction<Chapter[]>) => { s.chapters = a.payload; },
    setPaused:   (s, a: PayloadAction<boolean>)   => { s.paused = a.payload; },
    clearLastError: (s) => { s.lastError = null; },

    /* Called by the Generate view the instant it opens an SSE with a regen
       spec, so a subsequent Pause → Resume cycle re-resumes "naturally"
       (no chapterIds, no force) instead of replaying force:true and wiping
       the just-completed audio. Without this, pendingRegen only clears on
       the server's `idle` tick — but an aborted SSE never delivers that
       tick, so the spec sticks around forever and every Resume kicks off
       a fresh force-regen of the whole target set. */
    consumePendingRegen: (s) => { s.pendingRegen = null; },

    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      const { chapters, sentences } = a.payload;
      if (!chapters?.length) return;
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
      chapters: BookStateJson['chapters'];
      completedSlugs: string[];
      characters: Character[];
    }>) => {
      const { chapters, completedSlugs, characters } = a.payload;
      const done = new Set(completedSlugs);
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
      } as Chapter));
      s.lastError = null;
      s.generationStartedAt = null;
      s.pendingRegen = null;
      s.lastTickAt = null;
      /* Always land paused after a hydrate so a page reload doesn't auto-
         resume a long-running generation behind the user's back. They have
         to explicitly click Resume — matches the "in-session only"
         continuation contract documented in plan + this file. */
      s.paused = true;
    },

    applyGenerationTick: (s, a: PayloadAction<GenerationTick>) => {
      const ev = a.payload;
      if (!ev) return;

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
           speaker would otherwise get silently flipped to `done` with nobody
           taking their place — the Generate view then renders every row as
           "Done" while synthesis quietly continues. Leaving state untouched
           keeps the active speaker visible. */
        const liveStatus = ch.characters[ev.characterId];
        if (liveStatus && liveStatus !== 'skipped') {
          for (const k of Object.keys(ch.characters)) {
            if (ch.characters[k] === 'in_progress' && k !== ev.characterId) {
              ch.characters[k] = 'done';
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
        return {
          ...ch,
          characters: { ...ch.characters, [characterId]: 'queued' },
          state:    ch.state === 'done' ? 'in_progress' : ch.state,
          progress: ch.state === 'done' ? 0.05 : ch.progress,
          phase:    null,
          errorReason: undefined,
        };
      });
      if (targetIds.length) {
        s.pendingRegen = { chapterIds: targetIds, force: true };
        s.regenEpoch += 1;
        s.lastError = null;
        s.generationStartedAt = null;
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
        return {
          ...ch,
          characters: newChars,
          state:    ch.state === 'done' ? 'in_progress' : ch.state,
          progress: ch.state === 'done' ? 0.05 : ch.progress,
          phase:    null,
          errorReason: undefined,
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
