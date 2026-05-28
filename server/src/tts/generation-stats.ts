/* Live generation-throughput accumulator (RTF telemetry).

   The sidecar logs a per-batch `rtf` (pure forward compute) and the single
   /synthesize path logs a per-call `rtf`, but neither answers the operator's
   actual question while a long book renders: "how fast is the whole pipeline
   going right now?" This module folds each finished chapter's audio-seconds vs
   synth-wall into a ROLLING window so `generation.ts` can log a per-chapter
   rollup AND a tiny GET endpoint can feed the dev top-bar pill — letting the
   user self-monitor speed without grepping logs.

   RTF convention matches the sidecar: rtf = synthWall / audio, so < 1 is
   faster-than-realtime. `xRealtime` is the inverse (audio / synthWall), the
   "Nx realtime" figure. A run is grouped into one rolling window; a gap longer
   than RESET_MS (a fresh generation session, or simple idleness) starts a new
   window so a stat from yesterday never dilutes today's number. */

export interface GenerationStats {
  /** Rolling window: chapters folded in since the window opened. */
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
  /** ISO timestamp of the last fold, or null when the window is empty. */
  updatedAt: string | null;
}

/* Gap (ms) after the last chapter beyond which the next chapter opens a fresh
   rolling window. Chapters in a continuous run complete well inside this; a
   gap this long means the run finished/stalled, so the next chapter is a new
   session and shouldn't be averaged against the old one. */
const RESET_MS = 10 * 60_000;

interface WindowState {
  startMs: number;
  chapters: number;
  audioSec: number;
  synthMs: number;
  last: NonNullable<GenerationStats['last']>;
  updatedAtMs: number;
}

let state: WindowState | null = null;

const emptyStats = (): GenerationStats => ({
  chapters: 0,
  audioSec: 0,
  synthSec: 0,
  rtf: null,
  xRealtime: null,
  chaptersPerHour: null,
  last: null,
  updatedAt: null,
});

const project = (s: WindowState): GenerationStats => {
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

/** Fold a finished chapter into the rolling window and return the updated
    snapshot. `synthMs` is the wall time spent inside `synthesiseChapter`
    (all TTS — title beat + body, excludes encode/disk). */
export function recordChapterThroughput(
  input: { chapterId: number | string; audioSec: number; synthMs: number },
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
    return project(state);
  }

  state.chapters += 1;
  state.audioSec += input.audioSec;
  state.synthMs += input.synthMs;
  state.last = last;
  state.updatedAtMs = now;
  return project(state);
}

/** Current rolling snapshot. Returns the empty shape (all-null) when no
    chapter has been recorded yet or the window has gone idle past RESET_MS. */
export function getGenerationStats(now: number = Date.now()): GenerationStats {
  if (!state || now - state.updatedAtMs > RESET_MS) return emptyStats();
  return project(state);
}

/** Test-only: drop the rolling window so cases don't bleed into each other. */
export function __resetGenerationStatsForTest(): void {
  state = null;
}
