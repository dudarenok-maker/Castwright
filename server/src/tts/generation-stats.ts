/* Live generation-throughput accumulator (RTF telemetry).

   The sidecar logs a per-batch `rtf` (pure forward compute) and the single
   /synthesize path logs a per-call `rtf`, but neither answers the operator's
   actual question while a long book renders: "how fast is the whole pipeline
   going right now?" This module tracks two things `generation.ts` feeds it:

     1. PER-CHAPTER rolling window — folds each finished chapter's audio vs
        synth-wall. A lagging SUMMARY (updates only when a chapter completes,
        ~tens of minutes apart).
     2. PER-BATCH live window — each Qwen batch reports its sidecar compute
        (genMs) + audio (audioMs); we keep the recent few so the dev pill shows
        a number that moves every ~batch. This is the figure the user can ACT
        on mid-chapter (the per-chapter rollup is too coarse).
     3. PER-CHAPTER history ring — a bounded, newest-first list of each finished
        chapter's own RTF (+ title/book/engine) so the dev Worktrees view can
        render the trend across a run ("is it deteriorating or consistent?")
        without grepping logs. INDEPENDENT of the rolling window's RESET_MS
        idle reset — an idle gap blanks the aggregate but must NOT blank the
        history. In-memory only: survives a sidecar recycle (this Node process
        persists; only the Python sidecar restarts per-batch), resets on a full
        server restart (a restart is a new session).

   A tiny GET endpoint exposes all three so the user self-monitors speed without
   grepping logs.

   RTF convention matches the sidecar everywhere: rtf = wall / audio, so < 1 is
   faster-than-realtime. `xRealtime` is the inverse (audio / wall). The chapter
   window groups one run; a gap > RESET_MS starts fresh so yesterday's stat
   never dilutes today's. The batch window is independent — it reports while the
   FIRST chapter is still rendering (when the chapter window is still empty). */

/** One finished chapter's own throughput, for the history ring. `rtf` is
    `synthSec / audioSec` (< 1 = faster than realtime) or `null` when the
    chapter produced no audio (guards a divide-by-zero from corrupting the
    deterioration comparison the view draws). */
export interface ChapterThroughputRecord {
  chapterId: number | string;
  title: string | null;
  bookId: string | null;
  modelKey: string | null;
  rtf: number | null;
  /** B1 — QA-driven re-record wall ÷ audio (the cost the gate fixes move).
      null when not split (generationWorkers > 1) or no audio. */
  rerecordRtf: number | null;
  /** B1 — always-on verify floor (transcribe + embed) ÷ audio. null as above. */
  verifyRtf: number | null;
  audioSec: number;
  synthSec: number;
  at: string;
}

export interface GenerationStats {
  // ── per-chapter rolling window (lagging summary) ──────────────────────
  /** Chapters folded in since the window opened. */
  chapters: number;
  /** Rolling totals over the window. */
  audioSec: number;
  synthSec: number;
  /** synthSec / audioSec over the window (< 1 = faster than realtime). */
  rtf: number | null;
  /** audioSec / synthSec — the "Nx realtime" figure. */
  xRealtime: number | null;
  /** chapters ÷ window-wall-hours. */
  chaptersPerHour: number | null;
  /** The most-recently-finished chapter's own figures. */
  last: {
    chapterId: number | string;
    rtf: number;
    audioSec: number;
    synthSec: number;
    at: string;
  } | null;
  /** ISO timestamp of the last chapter fold, or null when the window is empty. */
  updatedAt: string | null;

  // ── per-batch live window (responsive, the actionable number) ─────────
  /** Aggregate ΣgenMs / ΣaudioMs over the recent-batch window (< 1 = faster
      than realtime). The headline LIVE figure; null when no batch is recent. */
  liveBatchRtf: number | null;
  /** The single most-recent batch's rtf. */
  lastBatchRtf: number | null;
  /** How many batches the live window is averaging. */
  batchesInWindow: number;
  /** ISO timestamp of the most-recent batch, or null when none is recent. */
  batchUpdatedAt: string | null;

  // ── per-chapter history ring (trend, newest-first) ────────────────────
  /** Recent finished chapters, NEWEST-FIRST, capped at MAX_HISTORY. Survives
      the rolling-window RESET_MS reset (its whole value is the cross-pause
      trend). The dev Worktrees view renders this as the throughput table. */
  recentChapters: ChapterThroughputRecord[];
}

/* Gap (ms) after the last chapter beyond which the next chapter opens a fresh
   rolling window. Chapters in a continuous run complete well inside this. */
const RESET_MS = 10 * 60_000;

/* A batch older than this (no batch in the last N min) means generation is no
   longer live → the pill drops the readout. Generous vs the ~90 s batch cadence
   so the number doesn't flicker to null between batches. */
const BATCH_IDLE_MS = 5 * 60_000;
/* Cap the live window so `liveBatchRtf` stays "recent" (and memory is bounded)
   — an aggregate over roughly the last dozen batches. */
const MAX_BATCHES = 12;
/* Cap the per-chapter history ring. ~200 small records covers multiple books /
   a long run while keeping memory trivial — the big-book ceiling is ~60 chapters. */
const MAX_HISTORY = 200;

interface WindowState {
  startMs: number;
  chapters: number;
  audioSec: number;
  synthMs: number;
  last: NonNullable<GenerationStats['last']>;
  updatedAtMs: number;
}

interface BatchRecord {
  at: number;
  genMs: number;
  audioMs: number;
}

let state: WindowState | null = null;
let batches: BatchRecord[] = [];
let history: ChapterThroughputRecord[] = [];

const emptyChapter = (): Pick<
  GenerationStats,
  'chapters' | 'audioSec' | 'synthSec' | 'rtf' | 'xRealtime' | 'chaptersPerHour' | 'last' | 'updatedAt'
> => ({
  chapters: 0,
  audioSec: 0,
  synthSec: 0,
  rtf: null,
  xRealtime: null,
  chaptersPerHour: null,
  last: null,
  updatedAt: null,
});

const projectChapter = (s: WindowState) => {
  const synthSec = s.synthMs / 1000;
  const windowSec = Math.max((s.updatedAtMs - s.startMs) / 1000, 0);
  return {
    chapters: s.chapters,
    audioSec: s.audioSec,
    synthSec,
    rtf: s.audioSec > 0 ? synthSec / s.audioSec : null,
    xRealtime: synthSec > 0 ? s.audioSec / synthSec : null,
    chaptersPerHour: windowSec > 0 ? (s.chapters / windowSec) * 3600 : null,
    last: s.last,
    updatedAt: new Date(s.updatedAtMs).toISOString(),
  };
};

const projectBatch = (
  now: number,
): Pick<
  GenerationStats,
  'liveBatchRtf' | 'lastBatchRtf' | 'batchesInWindow' | 'batchUpdatedAt'
> => {
  const recent = batches.filter((b) => now - b.at <= BATCH_IDLE_MS);
  if (recent.length === 0) {
    return { liveBatchRtf: null, lastBatchRtf: null, batchesInWindow: 0, batchUpdatedAt: null };
  }
  const genMs = recent.reduce((a, b) => a + b.genMs, 0);
  const audioMs = recent.reduce((a, b) => a + b.audioMs, 0);
  const latest = recent[recent.length - 1];
  return {
    liveBatchRtf: audioMs > 0 ? genMs / audioMs : null,
    lastBatchRtf: latest.audioMs > 0 ? latest.genMs / latest.audioMs : null,
    batchesInWindow: recent.length,
    batchUpdatedAt: new Date(latest.at).toISOString(),
  };
};

/** Fold a finished chapter into the rolling window and return the updated
    snapshot. `synthMs` is the wall time spent inside `synthesiseChapter`
    (all TTS — title beat + body, excludes encode/disk). */
export function recordChapterThroughput(
  input: {
    chapterId: number | string;
    audioSec: number;
    synthMs: number;
    title?: string | null;
    bookId?: string | null;
    modelKey?: string | null;
    rerecordMs?: number | null;
    transcribeMs?: number | null;
    embedMs?: number | null;
  },
  now: number = Date.now(),
): GenerationStats {
  const synthSec = input.synthMs / 1000;
  const last: WindowState['last'] = {
    chapterId: input.chapterId,
    rtf: input.audioSec > 0 ? synthSec / input.audioSec : 0,
    audioSec: input.audioSec,
    synthSec,
    at: new Date(now).toISOString(),
  };

  /* History ring — push BEFORE the window-reset branch so it always records,
     independent of the RESET_MS idle reset. Newest-first, capped. `rtf` is
     null (not 0) on no-audio so the view renders a dash and skips the tint. */
  const hasAudio = input.audioSec > 0;
  const rerecordRtf =
    hasAudio && input.rerecordMs != null ? input.rerecordMs / 1000 / input.audioSec : null;
  const verifyMs =
    input.transcribeMs != null || input.embedMs != null
      ? (input.transcribeMs ?? 0) + (input.embedMs ?? 0)
      : null;
  const verifyRtf = hasAudio && verifyMs != null ? verifyMs / 1000 / input.audioSec : null;

  history.unshift({
    chapterId: input.chapterId,
    title: input.title ?? null,
    bookId: input.bookId ?? null,
    modelKey: input.modelKey ?? null,
    rtf: input.audioSec > 0 ? synthSec / input.audioSec : null,
    rerecordRtf,
    verifyRtf,
    audioSec: input.audioSec,
    synthSec,
    at: new Date(now).toISOString(),
  });
  history = history.slice(0, MAX_HISTORY);

  /* Fresh window on first fold or after an idle gap. Anchor the window start
     at this chapter's synth START (now − synthMs) so chapters/hr counts the
     first chapter's own wall, not a zero-width window. */
  if (!state || now - state.updatedAtMs > RESET_MS) {
    state = {
      startMs: now - input.synthMs,
      chapters: 1,
      audioSec: input.audioSec,
      synthMs: input.synthMs,
      last,
      updatedAtMs: now,
    };
    return getGenerationStats(now);
  }

  state.chapters += 1;
  state.audioSec += input.audioSec;
  state.synthMs += input.synthMs;
  state.last = last;
  state.updatedAtMs = now;
  return getGenerationStats(now);
}

/** Fold one completed Qwen batch into the LIVE window and return the updated
    snapshot. `genMs` is the sidecar's forward-compute wall, `audioMs` the audio
    the batch produced — so `liveBatchRtf` is genMs ÷ audioMs over recent
    batches, the responsive figure the pill shows mid-chapter. */
export function recordBatchThroughput(
  input: { genMs: number; audioMs: number },
  now: number = Date.now(),
): GenerationStats {
  batches.push({ at: now, genMs: input.genMs, audioMs: input.audioMs });
  // Bound to recent + capped count so the live aggregate stays current.
  batches = batches.filter((b) => now - b.at <= BATCH_IDLE_MS).slice(-MAX_BATCHES);
  return getGenerationStats(now);
}

/** Current snapshot. Chapter fields go all-null once the chapter window idles
    past RESET_MS; batch fields go all-null once no batch is within
    BATCH_IDLE_MS. The two are independent — the batch readout is live while the
    first chapter is still rendering (chapter window still empty). */
export function getGenerationStats(now: number = Date.now()): GenerationStats {
  const chapter =
    state && now - state.updatedAtMs <= RESET_MS ? projectChapter(state) : emptyChapter();
  /* `history` is already newest-first and capped; the RESET_MS reset above
     blanks the aggregate but must NOT touch the history trend. */
  return { ...chapter, ...projectBatch(now), recentChapters: history };
}

/** Test-only: drop both windows so cases don't bleed into each other. */
export function __resetGenerationStatsForTest(): void {
  state = null;
  batches = [];
  history = [];
}
