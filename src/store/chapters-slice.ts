/* Chapters slice — generation state per chapter and per character-in-chapter.

   Source of truth for the Generate tab: chapter state, per-character status,
   the assembling sub-phase, and a `lastError` banner for stream-level
   failures the per-chapter slot can't represent. The generation control
   fields (`pendingRegen` / `regenEpoch` / `paused`) were removed in plan 102
   Should #5 — the queue (queue-slice + dispatcher) and the shared stream
   runner own scheduling now; the regen spec is computed by the
   generation-stream middleware from the regen action and passed straight to
   the runner. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { formatDuration } from '../lib/time';
/* `initialChapters` (from ../data/chapters) used to seed `chapters` here so
   the design fixture was visible in the demo. That was a footgun: between
   the moment the user clicks a real book and the moment `hydrateFromBookState`
   lands (async fetch of .audiobook/state.json), the Generate view rendered
   the fixture's Moby-Dick-flavoured chapter titles as if they were the user's
   book — a confusing flash of wrong content. Start empty; hydration is the
   only legitimate source of chapter rows for a real book. The fixture still
   exists for the drift-report modal and the mock API. */
import type {
  Chapter,
  ChapterLoudness,
  Character,
  GenerationTick,
  AnalyseResponse,
  BookStateJson,
  TtsModelKey,
} from '../lib/types';

/* When the SSE has produced no tick for this long while a chapter is
   in_progress, the Generate view flips that chapter to a "Stalled" amber
   state. The middleware also surfaces the same threshold via the global
   header pill so the user knows the worker has gone quiet from any view. */
export const STALL_THRESHOLD_MS = 30_000;

/** Cross-book snapshot of the in-flight generation run. Set by the
    generation-stream middleware on openHandle and updated on every non-idle
    tick; cleared on closeHandle. Decouples the global header pill from
    `chapters.chapters` so the pill keeps reflecting the *generating* book
    even after the user navigates into a different book and the slice gets
    re-hydrated with that other book's chapter rows. */
export interface ActiveStreamSnapshot {
  /** Composite stream key (`${bookId}::${chapterId}` or `${bookId}::*`).
      The `activeStreams` map is keyed by this so two concurrent chapters of
      the SAME book each get their own entry instead of colliding under a
      shared bookId key. */
  streamKey: string;
  bookId: string;
  /** The single chapter this stream renders, when known (null on the
      back-compat `*` open). */
  chapterId: number | null;
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
  /** Stream-level error (e.g. modelKey rejected, cast missing, sidecar down).
      Surfaced as a banner; cleared on dismiss or on the next successful tick. */
  lastError: string | null;
  /** Set on the first progress tick of a run; cleared when the queue drains
      (idle tick with no in-flight or queued chapters). Drives the real ETA. */
  generationStartedAt: number | null;
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
  /** Cross-book progress snapshots, keyed by the composite stream key
      (`${bookId}::${chapterId}`) — see ActiveStreamSnapshot. A non-empty map
      means at least one generation stream is open somewhere. Under
      queue-sole concurrency one stream = one chapter, so two chapters of the
      same book coexist as separate entries; the layout pill selectors
      aggregate across `Object.values`. */
  activeStreams: Record<string, ActiveStreamSnapshot>;
  /** #650 — render-time sentence→speaker map per rendered chapter
      (`{ [chapterId]: { [sentenceId]: characterId } }`), hydrated from the
      book-state GET. The Generate view diffs it against the live manuscript to
      flag a `done` chapter whose sentences were reassigned after it rendered.
      Empty for older servers / before the first hydrate; the view then falls
      back to the time-based change-log heuristic. */
  renderedSpeakersByChapter: Record<number, Record<number, string>>;
  /** #1105 — render-time sentence→textHash map per rendered chapter, hydrated from
      the book-state GET. The Generate view diffs it against the live manuscript text
      to flag a `done` chapter whose text was edited after it rendered. Empty for
      older servers / before the first hydrate; the view then falls back to the
      time-based change-log heuristic. */
  renderedTextByChapter: Record<number, Record<number, string>>;
}

const initialState: ChaptersState = {
  chapters: [],
  lastError: null,
  generationStartedAt: null,
  lastTickAt: null,
  currentBookId: null,
  activeStreams: {},
  renderedSpeakersByChapter: {},
  renderedTextByChapter: {},
};

export const chaptersSlice = createSlice({
  name: 'chapters',
  initialState,
  reducers: {
    setChapters: (s, a: PayloadAction<Chapter[]>) => {
      s.chapters = a.payload;
    },
    /** One-shot "halt the in-flight generation stream NOW" signal. Carries no
        state — it exists purely so the generation-stream middleware can
        observe the action and tear down the open SSE handle (+ POST /pause to
        the server) to free the GPU immediately. Used by the local-analyzer
        guard when a local analysis is about to start and needs the VRAM that
        TTS is holding. This is distinct from `queue.paused` (which stops the
        dispatcher from draining the NEXT entry but lets the in-flight chapter
        finish); the analyzer can't wait a whole chapter for the GPU. */
    requestStreamHalt: () => {
      /* No state mutation — the middleware reacts to the action type. */
    },
    clearLastError: (s) => {
      s.lastError = null;
    },

    /** fs-26 — after a per-character splice rewrites a chapter's audio in
        place, refresh the Listen row: update its duration (re-record changes
        it; a gain remix doesn't) and stamp a fresh `audioRenderedAt`. The
        mini-player's audio-meta fetch keys on `audioRenderedAt`, so this is
        the signal that the bytes changed even when the URL + duration are
        identical (the gain case) — it forces a cache-busted re-fetch. */
    markChapterAudioUpdated: (
      s,
      a: PayloadAction<{ chapterId: number; durationSec?: number; renderedAt: string }>,
    ) => {
      const ch = s.chapters.find((c) => c.id === a.payload.chapterId);
      if (!ch) return;
      if (a.payload.durationSec != null) ch.duration = formatDuration(a.payload.durationSec);
      ch.audioRenderedAt = a.payload.renderedAt;
    },

    /** Records which book's rows `chapters` currently reflects. Dispatched
        by Layout's per-book hydration effect (immediately after
        hydrateFromBookState/hydrateFromAnalysis seed the slice) and on
        goHome (with null) so the middleware's tick guard can detect when
        the slice has drifted from the still-streaming book. */
    setCurrentBookId: (s, a: PayloadAction<string | null>) => {
      s.currentBookId = a.payload;
    },

    /** Middleware → slice handshake: sets the cross-book snapshot for a stream
        when it opens, and replaces it on every non-idle tick with a fresh
        derive of done/total/inProgress/lastTickAt. Keyed by the snapshot's
        composite `streamKey` so concurrent streams — including two chapters
        of the same book — don't clobber each other. */
    setActiveStream: (s, a: PayloadAction<ActiveStreamSnapshot>) => {
      s.activeStreams[a.payload.streamKey] = a.payload;
    },

    /** Middleware → slice handshake: cleared on closeHandle (pause, queue
        drain, store teardown) for the stream that closed, by composite
        `streamKey`. The header pill hides entirely when no streams remain. */
    clearActiveStream: (s, a: PayloadAction<string>) => {
      delete s.activeStreams[a.payload];
    },

    /** Bug E — cross-book heartbeat + counter refresh from a server tick
        payload. Always bumps `lastTickAt` so the pill's stall check stays
        fresh; conditionally overwrites done/total/inProgress when the
        tick carried them. Used by the generation-stream middleware when
        the slice has been rehydrated for a DIFFERENT book and the
        per-chapter tick reducer's cross-book guard would otherwise drop
        the tick on the floor. Slice-matches-handle path keeps using
        `setActiveStream(snapshotFromChapters(...))` because the slice
        rows are authoritative there. Targets the snapshot for `streamKey`. */
    updateActiveStreamProgress: (
      s,
      a: PayloadAction<{ streamKey: string; done?: number; total?: number; inProgress?: number }>,
    ) => {
      const snap = s.activeStreams[a.payload.streamKey];
      if (!snap) return;
      snap.lastTickAt = Date.now();
      const { done, total, inProgress } = a.payload;
      if (done != null) snap.done = done;
      if (total != null) snap.total = total;
      if (inProgress != null) snap.inProgress = inProgress;
    },

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
      s.chapters = chapters.map((c) => {
        const known = Object.keys(c.characters ?? {});
        if (known.length > 0) return c;
        const speakers = speakersByChapter[c.id];
        if (!speakers || speakers.size === 0) return c;
        return {
          ...c,
          characters: Object.fromEntries([...speakers].map((id) => [id, 'queued' as const])),
        };
      });
    },

    /* Rebuild chapters from a disk-resident state.json + the set of completed
       audio slugs. Used when opening a previously-analysed book. */
    hydrateFromBookState: (
      s,
      a: PayloadAction<{
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
        /** Plan 77 — per-chapter EBU R128 loudness sidecar payloads keyed
          by chapter id, surfaced by the book-state endpoint. Drives the
          listen-view LUFS report card + per-row drift badges. Absent
          (older server) → every chapter row gets `lufs: undefined`;
          present with a `null` entry → fetched-but-no-data, render
          neutral. */
        chapterLufs?: Record<number, ChapterLoudness | null>;
        /** #650 — render-time sentence→speaker map per chapter. Absent on older
          servers → left empty, view falls back to the change-log heuristic. */
        renderedSpeakersByChapter?: Record<number, Record<number, string>>;
        /** #1105 — render-time sentence→textHash map per chapter. Absent on
          pre-#1105 servers/renders → left empty, view falls back to the
          change-log heuristic for text edits. */
        renderedTextByChapter?: Record<number, Record<number, string>>;
      }>,
    ) => {
      const {
        bookId,
        chapters,
        completedSlugs,
        characters,
        chapterCharacters,
        chapterLufs,
        renderedSpeakersByChapter,
        renderedTextByChapter,
      } = a.payload;
      if (bookId) s.currentBookId = bookId;
      s.renderedSpeakersByChapter = renderedSpeakersByChapter ?? {};
      s.renderedTextByChapter = renderedTextByChapter ?? {};
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
        const source = ids && ids.length > 0 ? ids : characters.map((ch) => ch.id);
        const out: Record<string, 'done'> = {};
        for (const id of source) out[id] = 'done';
        return out;
      };
      s.chapters = chapters.map(
        (c) =>
          ({
            id: c.id,
            title: c.title,
            duration: c.duration ?? '00:00',
            /* `done` (audio on disk) wins over a stale persisted failure, so a
           chapter that later rendered is never stuck showing "Failed".
           Otherwise honor the durable `generationState: 'failed'` so a
           failed chapter re-hydrates as "Failed · reason" with a Retry
           control instead of the misleading neutral "Queued" — the failure
           record no longer lives only in the (clearable) queue entry. */
            state: done.has(c.slug)
              ? 'done'
              : c.generationState === 'failed'
                ? 'failed'
                : 'queued',
            errorReason:
              !done.has(c.slug) && c.generationState === 'failed' ? c.generationError : undefined,
            /* fs-19 — re-hydrate the structured failure class + remediation so a
               failed chapter shows its "what to do" line after a reload. */
            generationErrorCode:
              !done.has(c.slug) && c.generationState === 'failed'
                ? c.generationErrorCode
                : undefined,
            generationRemediation:
              !done.has(c.slug) && c.generationState === 'failed'
                ? c.generationRemediation
                : undefined,
            /* srv-27 — carry the advisory QA verdict for done chapters so the
               "Suspect" badge survives a reload. */
            audioQa: done.has(c.slug) ? c.audioQa : undefined,
            progress: done.has(c.slug) ? 1 : 0,
            characters: done.has(c.slug) ? seedDone(c.id) : seedQueued(c.id),
            /* Persist the user's per-chapter exclude choice across hydrate so
           the Generate view greys excluded chapters out without waiting
           on a separate fetch. */
            excluded: c.excluded || undefined,
            /* "Not queued" hold — the user removed this un-rendered chapter
           from the queue. Re-hydrated from state.json so the row keeps
           reading "Not queued" (not "Queued") and the auto-work resume
           leaves it alone across a reload. */
            held: c.held || undefined,
            /* Engine-drift tracking (plan 35). Carry the TTS model key that
           rendered this chapter's existing audio so the chapter row can
           render a drift badge when it differs from the project's
           current ui.ttsModelKey. Absent on unrendered chapters; the
           server backfills it from segments.json for legacy chapters. */
            audioModelKey: c.audioModelKey,
            /* Per-engine voice-count breakdown (false-drift fix). One key on a
               uniform chapter, the full map on a mixed-engine chapter — drives
               the "Kokoro (1), Qwen (6)" caption. */
            audioEngines: c.audioEngines,
            audioRenderedAt: c.audioRenderedAt,
            /* Plan 77 — per-chapter EBU R128 loudness sidecar (plan 71)
           hydrated from the book-state response. `null` entry = sidecar
           absent on disk (legacy chapter / disabled / silent source);
           map key absent (older server) → undefined. The listen-view
           report card distinguishes both from "all-target" data. */
            lufs: chapterLufs ? (chapterLufs[c.id] ?? null) : undefined,
          }) as Chapter,
      );
      s.lastError = null;
      s.generationStartedAt = null;
      s.lastTickAt = null;
    },

    applyGenerationTick: (s, a: PayloadAction<GenerationTick>) => {
      const ev = a.payload;
      if (!ev) return;

      /* Cross-book guard: when the user opens a different book mid-run, the
         slice gets re-hydrated with that other book's chapter rows. The
         middleware's still-open handle keeps streaming for the original
         book, but its ticks must NOT mutate the now-irrelevant slice — the
         cross-book progress snapshot (activeStreams) keeps the header pill
         alive instead. The middleware updates activeStreams out-of-band.

         Map form: if streams are open but NONE is for the viewed book, this
         tick is for another book — drop it (chapter ids collide across
         books). With per-chapter stream keys, "is the viewed book streaming"
         is "does some snapshot's bookId === currentBookId" (a single book may
         have several concurrent chapter streams). The runner only applies a
         per-chapter tick when its handle's bookId === currentBookId, so a
         viewed-book stream + foreign-book stream can't be confused. */
      if (
        s.currentBookId &&
        Object.keys(s.activeStreams).length > 0 &&
        !Object.values(s.activeStreams).some((st) => st.bookId === s.currentBookId)
      )
        return;

      /* Start the ETA clock on the first real progress signal of a run. */
      if (
        s.generationStartedAt == null &&
        (ev.type === 'progress' || ev.type === 'chapter_assembling')
      ) {
        s.generationStartedAt = Date.now();
      }

      /* Every non-idle tick is a heartbeat — the view derives "stalled" from
         (now - lastTickAt) > STALL_THRESHOLD_MS while a chapter is in_progress.
         Set this before any early returns so a stream-level chapter_failed
         tick (no chapterId) still resets the heartbeat clock. */
      if (ev.type !== 'idle') s.lastTickAt = Date.now();

      if (ev.type === 'idle') {
        /* End-of-run: clear the elapsed clock so the next run starts a fresh
           ETA. */
        const stillBusy = s.chapters.some((c) => c.state === 'in_progress' || c.state === 'queued');
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
          const live = s.chapters.find((c) => c.state === 'in_progress');
          if (live) {
            live.state = 'failed';
            live.phase = null;
            live.errorReason = ev.errorReason ?? 'Generation halted.';
          }
          return;
        }
        const ch = s.chapters.find((c) => c.id === ev.chapterId);
        if (ch) {
          ch.state = 'failed';
          ch.phase = null;
          ch.errorReason = ev.errorReason ?? 'Synthesis failed.';
          /* fs-19 — carry the structured failure class + remediation onto the
             row so the failed-state box can render a "what to do" line under
             the reason without a state.json reload. */
          ch.generationErrorCode = ev.errorCode;
          ch.generationRemediation = ev.remediation;
        }
        return;
      }

      if (ev.chapterId == null) return;
      const ch = s.chapters.find((c) => c.id === ev.chapterId);
      if (!ch) return;

      if (ev.type === 'chapter_assembling') {
        ch.phase = 'assembling';
        ch.state = 'in_progress';
        ch.progress = ev.progress ?? 0.995;
        if (ev.currentLine != null) ch.currentLine = ev.currentLine;
        if (ev.totalLines != null) ch.totalLines = ev.totalLines;
        /* The assembling tick is the primary carrier of `durationSec` —
           capture it here so the row shows the real audio length while the
           disk-write phase is still ticking. chapter_complete carries the
           same value as a belt-and-suspenders fallback (see below) so the
           row never sits at the '00:00' seed when the assembling tick is
           dropped (cross-book guard, parallel-chapter coalesce, hidden
           tab). */
        if (ev.durationSec != null) ch.duration = formatDuration(ev.durationSec);
        return;
      }

      if (ev.type === 'chapter_verifying') {
        /* srv-31 ASR content-QA pass runs after synthesis, before assembly.
           Mirror chapter_assembling: hold the row in_progress with a distinct
           phase so the Generate view shows "Verifying speech…" instead of a
           frozen "Synthesising …" caption. */
        ch.phase = 'verifying';
        ch.state = 'in_progress';
        ch.progress = ev.progress ?? 0.99;
        if (ev.currentLine != null) ch.currentLine = ev.currentLine;
        if (ev.totalLines != null) ch.totalLines = ev.totalLines;
        return;
      }

      if (ev.type === 'chapter_recovering') {
        /* C2 (Wave 3) — sidecar recycled mid-render; the worker is riding out
           the respawn on the readiness gate (up to ~210 s). Mirror
           chapter_verifying: hold the row in_progress with a distinct phase so
           the view shows "Recovering…" instead of a frozen caption + the 30 s
           stall banner. Keep the existing progress when the tick omits it so the
           bar stays where synthesis left it. */
        ch.phase = 'recovering';
        ch.state = 'in_progress';
        ch.progress = ev.progress ?? ch.progress;
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
        /* Engine-drift tracking (plan 35). Stamp the rendered engine
           the moment the chapter completes so the drift badge can flip
           without waiting for a state.json reload. Absence in the tick
           is tolerated (older server before this field landed) — the
           chapter stays at its previously-hydrated value. */
        if (ev.audioModelKey) ch.audioModelKey = ev.audioModelKey;
        /* Carry the per-engine breakdown so a mixed-engine chapter's caption
           (or a corrected uniform stamp) is right the instant Done flips. */
        if (ev.audioEngines) ch.audioEngines = ev.audioEngines;
        /* srv-27 — stamp the advisory QA verdict so the "Suspect" badge can
           appear the moment the Done pill flips, without a state.json reload.
           Absent on an older server → leave the hydrated value. */
        if (ev.audioQa) ch.audioQa = ev.audioQa;
        /* Duration fallback: chapter_assembling is the primary carrier,
           but it can be dropped between the server and this reducer
           (cross-book guard at line 309, plan-87 parallel-chapter
           coalesce, hidden-tab throttling). Re-applying the same value
           on chapter_complete is idempotent when assembling already
           landed and load-bearing when it didn't. */
        if (ev.durationSec != null) ch.duration = formatDuration(ev.durationSec);
        return;
      }

      /* type === 'progress' — flip the live character and advance counters.
         Use the real `characterId` from the tick rather than progress
         thresholds; the server emits one per same-speaker group. */
      /* fs-13 — a progress tick on a chapter that wasn't already in_progress
         means a (re)start (queued→running, or a regenerate of a done/failed
         chapter). Clear any completed-id set carried over from a prior run
         BEFORE flipping the state below, so last run's exact bars can't leak
         into the fresh one. Covers every restart path in one place. */
      if (ch.state !== 'in_progress') ch.completedSentenceIds = [];
      ch.state = 'in_progress';
      ch.phase = null;
      ch.progress = ev.progress ?? ch.progress;
      if (ev.currentLine != null) ch.currentLine = ev.currentLine;
      if (ev.totalLines != null) ch.totalLines = ev.totalLines;
      /* fs-13 — union the just-completed group's sentence ids into the
         chapter's completed SET (the view intersects this with each
         character's sentence ids for an EXACT done count under out-of-order
         completion). Idempotent: a heartbeat-replayed id is absorbed by the
         Set. Only completion ticks carry this; the onGroupStart heartbeat
         omits it, so a started-but-unfinished group never counts as done. */
      if (ev.completedSentenceIds && ev.completedSentenceIds.length > 0) {
        const merged = new Set(ch.completedSentenceIds ?? []);
        for (const id of ev.completedSentenceIds) merged.add(id);
        ch.completedSentenceIds = [...merged];
      }
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
      s.chapters = s.chapters.map((c) => {
        const inScope = c.id === chapterId || (scope === 'forward' && c.id > chapterId);
        if (!inScope) return c;
        targetIds.push(c.id);
        return {
          ...c,
          state: c.id === chapterId ? 'in_progress' : 'queued',
          progress: c.id === chapterId ? 0.05 : 0,
          phase: null,
          errorReason: undefined,
          generationErrorCode: undefined,
          generationRemediation: undefined,
          /* Reset line counters so the expanded row's derived per-character
             progress (which counts manuscript line positions ≤ currentLine)
             doesn't show stale fractions in the gap between regenerate
             firing and the first fresh `progress` tick landing. */
          currentLine: 0,
          /* fs-13 — drop the prior run's completed-id set so the gap between
             regenerate firing and the first fresh progress tick doesn't show
             stale exact bars (the first tick clears it again, belt-and-suspenders). */
          completedSentenceIds: [],
          characters: Object.fromEntries(
            Object.entries(c.characters).map(([k, v]) => [k, v === 'done' ? 'queued' : v]),
          ) as Chapter['characters'],
        };
      });
      if (targetIds.length) {
        s.lastError = null;
        s.generationStartedAt = null;
      }
    },

    /* Bulk regenerate — re-queue an explicit, possibly non-contiguous list
       of chapters on the active engine. Used by the engine-drift banner's
       "Regenerate all" affordance (plan 35) where the targets are every
       chapter whose recorded audioModelKey differs from the project's
       current TTS engine, but the API is generic enough to drive any
       future bulk-regen entry point. Excluded chapters are silently
       skipped — drift only matters for chapters that participate in the
       book, and re-queuing an excluded one would re-include it in the
       bargain. The first id in the resolved list flips to in_progress
       so the row has an immediate affordance; everything else queues. */
    regenerateChapterIds: (s, a: PayloadAction<{ chapterIds: number[] }>) => {
      const targetSet = new Set(a.payload.chapterIds);
      const targetIds: number[] = [];
      s.chapters = s.chapters.map((c) => {
        if (!targetSet.has(c.id) || c.excluded) return c;
        targetIds.push(c.id);
        const isHead = targetIds.length === 1;
        return {
          ...c,
          state: isHead ? 'in_progress' : 'queued',
          progress: isHead ? 0.05 : 0,
          phase: null,
          errorReason: undefined,
          generationErrorCode: undefined,
          generationRemediation: undefined,
          currentLine: 0,
          /* fs-13 — see regenerate-from reducer above. */
          completedSentenceIds: [],
          characters: Object.fromEntries(
            Object.entries(c.characters).map(([k, v]) => [k, v === 'done' ? 'queued' : v]),
          ) as Chapter['characters'],
        };
      });
      if (targetIds.length) {
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
    mergeSubsetAnalysis: (
      s,
      a: PayloadAction<{ response: AnalyseResponse; chapterIds: number[] }>,
    ) => {
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
        ch.characters = Object.fromEntries([...speakers].map((id) => [id, 'queued' as const]));
      }
    },

    /* Reflect a successful POST /chapters/:chapterId/exclude on the
       slice. The server is the source of truth (state.json + audio
       cleanup), this just keeps the UI consistent without waiting on a
       refetch. When un-excluding, the caller is responsible for kicking
       off subset analysis if the chapter has no cached attribution. */
    setChapterExcluded: (s, a: PayloadAction<{ chapterId: number; excluded: boolean }>) => {
      const { chapterId, excluded } = a.payload;
      const ch = s.chapters.find((c) => c.id === chapterId);
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
        ch.generationErrorCode = undefined;
        ch.generationRemediation = undefined;
      }
    },

    /* "Not queued" hold toggle (mirrors setChapterExcluded, server is the
       source of truth via api.setChapterHeld). Set when the user deletes an
       un-rendered chapter's entry from the generation queue; cleared when they
       re-queue it. The flag OVERRIDES the row's "Queued" badge to "Not queued"
       and gates the auto-work resume + queued/completion counts (callers add
       `&& !c.held`), so a held chapter is no longer silently re-enqueued.
       Never set on a `done` chapter (the queue-delete wiring guards that), so
       the transient-state reset below can safely baseline it to `queued`. */
    setChapterHeld: (s, a: PayloadAction<{ chapterId: number; held: boolean }>) => {
      const { chapterId, held } = a.payload;
      const ch = s.chapters.find((c) => c.id === chapterId);
      if (!ch) return;
      ch.held = held ? true : undefined;
      if (held) {
        ch.state = 'queued';
        ch.progress = 0;
        ch.phase = null;
        ch.currentLine = undefined;
        ch.totalLines = undefined;
        ch.errorReason = undefined;
        ch.generationErrorCode = undefined;
        ch.generationRemediation = undefined;
      }
    },

    /* Plan 78 — reflect a successful POST /chapters/:chapterId/rename
       on the slice. Mirrors the `setChapterExcluded` pattern: server is
       the source of truth (writes state.json + renames the audio file
       on disk via rewriteChapterSlugs), this just keeps the UI consistent
       without waiting on a refetch. The `titleOverridden` flag rides
       along so the listen / restructure / generate rows can render a
       "manually renamed" cue if we ever surface one. NOT broadcast —
       same per-tab mutation policy as setChapterExcluded (see
       broadcast-middleware.ts). */
    renameChapter: (s, a: PayloadAction<{ chapterId: number; title: string }>) => {
      const { chapterId, title } = a.payload;
      const ch = s.chapters.find((c) => c.id === chapterId);
      if (!ch) return;
      ch.title = title;
      ch.titleOverridden = true;
    },

    /* Plan 84 — drop the `titleOverridden` flag on a set of chapter ids
       after a manuscript re-upload (plan 74) detected the chapter count
       or order changed. Without this, an old override stays attached to
       a numeric chapter id whose CONTENT is now entirely different — so
       the rename silently mis-attributes.

       The diff modal's apply path computes conflicts via
       `detectOverrideConflicts` (src/lib/chapter-override-conflict.ts)
       and dispatches this action with the offending ids before / after
       `manuscriptActions.applyReupload`. The chapter's `title` reverts
       to whatever the new manuscript's parse produced once the next
       state.json round-trip lands. */
    clearOverrides: (s, a: PayloadAction<{ chapterIds: number[] }>) => {
      const ids = new Set(a.payload.chapterIds);
      for (const ch of s.chapters) {
        if (ids.has(ch.id)) ch.titleOverridden = false;
      }
    },

    /* Cross-tab `BroadcastChannel` inbound hydrate (plan 63). Receives a
       sibling tab's post-mutation snapshot of the cross-book generation
       activeStream so the global header pill updates in tab B without a
       network round-trip when tab A starts/advances a run.

       Scope is intentionally narrow: only `activeStream` is mirrored,
       NOT `chapters[]` rows. Those are per-tab UI state — duplicating them
       across tabs would fire chapter-level regen side-effects in every tab
       simultaneously, which is the racing-writes case explicitly parked as
       backlog `fe-11`.

       Cross-bookId isolation: the snapshot carries its own bookId in the
       payload; we replace `activeStream` verbatim. The reducer never
       touches per-chapter rows, so tab B's open book stays clean even
       when tab A is generating a different book — only the header pill
       reflects the sibling activity. Echo suppression lives in the
       middleware (instanceId tag on outbound, ignore self-broadcasts). */
    applyExternalChaptersSnapshot: (s, a: PayloadAction<ActiveStreamSnapshot | null>) => {
      /* The broadcast wire still carries a single snapshot. Mirror it as the
         whole map keyed by its composite streamKey: a snapshot replaces the
         map with just that stream; null clears it. (Cross-tab fidelity is
         intentionally low — only the header pill consumes this.) */
      s.activeStreams = a.payload ? { [a.payload.streamKey]: a.payload } : {};
    },

  },
});

export const chaptersActions = chaptersSlice.actions;

/** The set of chapters a 'forward' regen ("this and all subsequent") affects:
    the anchor chapter plus every later one, minus excluded chapters. Excluded
    front/back-matter (Dedication, Copyright, CONTENTS) has no narration, so
    enqueuing it produces empty no-content queue entries. Mirrors the
    `!c.excluded` predicate used by `regenerateChapterIds` (above) and
    `enqueueOnWork` (generation-stream-middleware.ts). The regen modal uses
    this for the affected count, the ETA duration, AND the enqueued ids so the
    three can never diverge. */
export function forwardRegenChapters(chapters: Chapter[], anchorId: number): Chapter[] {
  return chapters.filter((c) => c.id >= anchorId && !c.excluded);
}

/* --- Active-stream selectors (plan 111 Wave 2) ----------------------------
   The single `activeStream` field became a per-book map; these give consumers
   a stable read surface that works whether 0, 1, or N streams are open. */

interface ChaptersRootShape {
  chapters: ChaptersState;
}

/** All open generation streams (one per book generating). Empty when idle. */
export const selectActiveStreams = (s: ChaptersRootShape): ActiveStreamSnapshot[] =>
  Object.values(s.chapters.activeStreams);

/** True when any generation stream is open. Replaces the old
    `if (chapters.activeStream)` truthiness checks. */
export const selectAnyActiveStream = (s: ChaptersRootShape): boolean =>
  Object.keys(s.chapters.activeStreams).length > 0;

/** Collapse the per-chapter stream snapshots into one done/total/inProgress
    triple for the top-bar generation pill.

    Each stream's snapshot is BOOK-WIDE — `snapshotFromChapters` counts every
    active chapter of the stream's book, not just the one chapter it renders
    (see generation-stream-runner.ts). So two concurrent chapters of the same
    book both report e.g. `5/7`; naively summing across streams yields `10/14`.
    We therefore dedupe by `bookId` (taking the max of each counter per book —
    same-book snapshots should be equal, `max` just absorbs transient
    tick-to-tick skew) and only then sum across DISTINCT books, which keeps the
    Wave-3 multi-book case (book A + book B generating at once) correct. */
export function aggregateStreamsByBook(streams: ActiveStreamSnapshot[]): {
  done: number;
  total: number;
  inProgress: number;
} {
  const byBook = new Map<string, { done: number; total: number; inProgress: number }>();
  for (const s of streams) {
    const cur = byBook.get(s.bookId);
    if (!cur) {
      byBook.set(s.bookId, { done: s.done, total: s.total, inProgress: s.inProgress });
    } else {
      cur.done = Math.max(cur.done, s.done);
      cur.total = Math.max(cur.total, s.total);
      cur.inProgress = Math.max(cur.inProgress, s.inProgress);
    }
  }
  let done = 0;
  let total = 0;
  let inProgress = 0;
  for (const b of byBook.values()) {
    done += b.done;
    total += b.total;
    inProgress += b.inProgress;
  }
  return { done, total, inProgress };
}
