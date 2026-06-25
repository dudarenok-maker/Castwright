/* POST /api/books/:bookId/generation — SSE stream of GenerationTick events.

   Replaces the mocked streamGeneration. Loads the confirmed cast + cached
   analysis sentences, walks each target chapter, calls synthesiseChapter,
   then atomically writes:
     audio/<slug>.mp3             — concatenated PCM encoded as MP3 (LAME VBR V2)
     audio/<slug>.segments.json   — per-group timing metadata
   and updates the chapter's `duration` in .audiobook/state.json.

   Resumability: a chapter is "complete" iff an `.mp3` exists for it on
   disk. Partial chapters never land on disk because we hold the PCM in
   memory until the whole chapter is done.

   Pause semantics: when the client closes the SSE (Pause button), we DO NOT
   abort the chapter in flight — it finishes its remaining groups and persists
   its MP3. The outer loop checks `pauseRequested` between chapters and
   bails. Resume = new POST, picks up from disk state (the just-finished
   chapter has an MP3 now, so the loop starts on the next one). At connect
   time we replay `chapter_complete` ticks for every already-done chapter so
   a reconnecting client reconciles state in one round-trip. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { mkdir } from 'node:fs/promises';
import {
  audioDir,
  castJsonPath,
  manuscriptEditsJsonPath,
  queueJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { readQueueFile, writeQueueFile } from '../workspace/queue-migrate.js';
import {
  completeEntry,
  markAwaitingConfirm,
  resetEntryToQueued,
  setPaused,
} from '../workspace/queue-io.js';
import { computeQwenKokoroFallbackSet, type QwenFallbackChar } from '../tts/qwen-fallback-set.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { stampStateSchema } from '../workspace/state-migrate.js';
import {
  bookStateAudioFormat,
  bookStateLanguage,
  findBookByBookId,
  type BookStateJson,
} from '../workspace/scan.js';
import { isNonEnglish, sidecarLanguageName } from '../tts/language.js';
import { chapterAudioExists } from '../workspace/chapter-audio-file.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { rebuildCacheFromEdits } from '../store/analysis-cache-rebuild.js';
import {
  canonicalModelKeyForEngine,
  engineForModelKey,
  isTtsModelKey,
  selectTtsProvider,
  type TtsEngine,
  type TtsModelKey,
  type TtsProvider,
} from '../tts/index.js';
import { resolveCharacterEngine } from '../tts/per-character-engine.js';
import { finalizeChapterAudioWrite } from '../audio/finalize-chapter-write.js';
import { clearMismatchedDesignedVoices } from '../tts/verify-designed-voice-language.js';
import {
  getCachedUserSettings,
  getLastKnownQwenInstallState,
  getResolvedSidecarUrl,
} from '../workspace/user-settings.js';
import { appendTelemetry } from '../tts/resource-telemetry.js';
import { probeSidecarHealth } from './sidecar-health.js';
import { abortInFlightSplice } from './chapter-job-coordination.js';
import {
  synthesiseChapter,
  ChapterStallError,
  type CastCharacter,
} from '../tts/synthesise-chapter.js';
import { hydrateCastReusedVoices } from '../tts/hydrate-reused-voice-workspace.js';
import { buildChapterTitleNarration } from '../tts/chapter-title-narration.js';
import { recordBatchThroughput, recordChapterThroughput } from '../tts/generation-stats.js';
import { ensureSidecarEngineReady, SIDECAR_ENGINES } from '../tts/ensure-sidecar-loaded.js';
import {
  asrEnabled,
  resolveAsrRerecords,
  resolveAsrSampleEvery,
  buildCastNameAllowlist,
} from '../tts/segment-asr-qa.js';
import { describeSynthesisError, newCascadeState, recordNonFatal } from './generation-error.js';
import type { FailureCode } from './failure-taxonomy.js';
import { AVG_CHAPTER_BYTES, diskGuardMode, evaluateDiskGuard } from '../workspace/disk-guard.js';
import { configValue } from '../config/resolver.js';
import { scoreBook } from '../audio/render-integrity/aggregate.js';

export const generationRouter = Router();

/* srv-36 — render-integrity score pass, wired to every chapter-done seam.
   Re-scores the WHOLE book on each chapter completion so centroids incorporate
   all rendered audio (not just the single just-finished chapter). Single-flight
   per bookId so concurrent chapter-done events coalesce into one scoreBook run
   instead of racing duplicate work + the centroids.json write. Non-fatal: a
   scoring failure must never break generation. */
const scoringInFlight = new Map<string, Promise<void>>();

export async function afterChapterFinalized(
  ctx: { bookId: string; bookDir: string; chapters: { id: number; slug: string }[] },
) {
  if (!configValue('qa.speaker.enabled')) return;
  if (scoringInFlight.has(ctx.bookId)) return;
  /* Fire-and-forget: kick the score pass off and return immediately — the
     caller (chapter-completion path) must NOT await it. scoreBook can make
     unbounded blocking sidecar calls (the audition-centroid path renders the
     sample K=12× + ECAPA-embeds each, per too-thin/bimodal character), and it
     feeds no progress to the per-chapter no-progress watchdog. Awaiting it here
     turned a slow-but-progressing score pass into a 720s assembly stall on the
     8GB box (#1029). The pass is non-fatal (.catch) and self-cleaning (.finally);
     a stale verdict file just gets overwritten on the next chapter's pass. */
  const run = scoreBook(ctx.bookDir, ctx.chapters)
    // generation.ts has NO `log`/`logger` symbol — it logs via console.warn throughout.
    .catch((e) => console.warn(`[generation] render-integrity score pass failed: ${String(e)}`))
    .finally(() => scoringInFlight.delete(ctx.bookId));
  scoringInFlight.set(ctx.bookId, run);
}

/* srv-17c — in-worker recovery for a sidecar that dies mid-synth. A host-RAM
   recycle (plan 143), a crash, or an OOM drops the connection on the in-flight
   `/synthesize` (or returns the drain-503 from a recycling sidecar) — both
   surface as a `transient` error AFTER `withTtsRetry`'s short budget exhausts.
   The srv-17b readiness gate only protects the NEXT chapter; the one already
   mid-synth would otherwise fail + abort the run (recovered only by a later
   manual Retry / boot sweep — the ch36/ch46 drops). So on a transient throw we
   ride out the supervisor respawn via `ensureSidecarEngineReady` and re-render
   the chapter on its own worker, up to this many times before falling through
   to the normal fatal path (so a genuinely-dead sidecar still surfaces and we
   never loop forever). CUDA-poison carries `poisoned:true` → `transient:false`,
   so it is excluded here and still surfaces immediately (only a restart fixes
   a poisoned context). */
const MAX_RECYCLE_RECOVERIES = 2;

/* Per-chapter no-progress watchdog (2026-06-02 the drowning bell ch52 stall). A
   chapter that makes NO forward progress — no group/batch completes and no
   assembly milestone lands — for this long is aborted and recorded as a
   `generationError`, instead of hanging the queue forever with no breadcrumb.
   This is the whole-chapter catch-all that complements the per-CALL
   `SIDECAR_CALL_TIMEOUT_MS`: it covers the post-synth assembly phase (encode /
   ffmpeg loudnorm / disk), which has no per-call ceiling, AND any synth wedge
   that survives a disabled/raised call timeout. Generous default (12 min) —
   comfortably above the longest legitimate single batch (~5 min observed) and
   the 10-min per-call ceiling, so a normally-slow batch or a recycle-respawn
   ride-out never false-trips. `0` disables. */
function chapterNoProgressMs(): number {
  const raw = Number(process.env.CHAPTER_NO_PROGRESS_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 720_000;
}

/* Pre-assembly per-sentence QA gate retry budget (segment-qa.ts). How many
   times a `suspect` sentence is re-recorded before keeping the best take.
   Default 2; `0` disables the gate (byte-identical to pre-gate). */
function resolveSegmentQaRerecords(): number {
  return configValue<number>('qa.seg.maxRerecords');
}

/* ASR content-QA pass (srv-31) — resolvers shared with the repair route live in
   segment-asr-qa.ts (asrEnabled / resolveAsrRerecords / resolveAsrSampleEvery /
   buildCastNameAllowlist). OFF by default via SEG_ASR_ENABLED. */

/* side-11 item 2 — soft recycle at the chapter boundary. The sidecar raises
   `recycle_pending` in /health once committed-private memory crosses the SOFT
   threshold (SIDECAR_RECYCLE_SOFT_MB, below the hard watchdog ceiling). Reading
   it between chapters lets us trigger a CLEAN recycle (POST /recycle → drain →
   respawn) at a boundary — earlier than the hard ceiling (sustained RTF) and
   without cutting a chapter mid-synth. Best-effort throughout: a flaky/timed-out
   health read or recycle POST must NEVER block or fail generation — the hard
   watchdog remains the backstop. */
const BOUNDARY_RECYCLE_PROBE_TIMEOUT_MS = 2_000;

async function getSidecarRecyclePending(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOUNDARY_RECYCLE_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${getResolvedSidecarUrl()}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { recycle_pending?: unknown };
    return body.recycle_pending === true;
  } catch {
    return false; // unreachable / timeout — let generation proceed
  } finally {
    clearTimeout(timer);
  }
}

async function triggerSidecarRecycle(): Promise<void> {
  try {
    await fetch(`${getResolvedSidecarUrl()}/recycle`, { method: 'POST' });
  } catch {
    /* best-effort — the hard watchdog still recycles if this never lands */
  }
}

/* Per-chapter job tracker. Each entry is a RunningJob: one AbortController +
   a Set of currently-attached SSE subscribers. Designed so the server-side
   work outlives any single client connection — a browser reload closes the
   client's SSE but the job keeps generating, and the post-reload client
   re-subscribes to receive subsequent ticks. The audio that's already on
   disk shows up in the catch-up replay every new subscriber gets at attach
   time, so a user who reloads mid-run sees both the completed chapters
   AND the live progression of the in-flight one(s).

   Concurrency model (queue-sole): the queue dispatcher fires one POST per
   chapter, so jobs are keyed by `${bookId}::${chapterId}` and N concurrent
   chapters run uniformly across all books — including sibling chapters of the
   same book. A forced request for chapter X displaces only chapter X's prior
   job, never sibling chapter Y.

   Pause semantics live on POST /pause now, not on SSE close. SSE close
   only unsubscribes the closing observer; a job keeps running until either
   (a) it finishes, (b) /pause is called (aborts every job for the book), or
   (c) a regen POST (chapterIds + force) displaces THIS chapter's job. */
interface Subscriber {
  send: (ev: unknown) => void;
  res: Response;
}

interface RunningJob {
  controller: AbortController;
  subscribers: Set<Subscriber>;
  bookId: string;
  /** The chapter this job renders. Under the queue-sole-concurrency model
      (one queue worker = one chapter) every dispatcher POST carries exactly
      one chapter, so a job's identity is `${bookId}::${chapterId}`. The
      legacy/back-compat path (no chapterIds, or a multi-id caller) walks all
      targets sequentially under a single job keyed `${bookId}::*` — its
      chapterId is null. */
  chapterId: number | null;
  /** Plan 102 — workspace queue entry id this job is processing. Carried
      back on every broadcast tick (including `resume_from`) so the
      frontend dispatcher can correlate ticks to the right queue row even
      when entries from different books interleave. Null when this job
      started outside the queue surface (legacy callers; back-compat). */
  queueEntryId: string | null;
  /** Loud-fallback gate — true when the dispatcher re-dispatched this entry
      AFTER the user confirmed its Qwen→Kokoro fallback. The worker skips the
      gate (renders straight through) for a confirmed entry, so a confirm →
      re-claim → re-enter cycle doesn't re-prompt. Default false. */
  fallbackConfirmed: boolean;
  /** The chapter the loop is currently synthesising. Set at the top of
      each loop iteration and cleared on chapter_complete / break. Used
      by the catch-up replay so a post-reload subscriber's UI immediately
      knows which chapter is in flight, rather than waiting for the next
      progress tick (which can be 30+ s away on a long narrator block). */
  currentChapterId: number | null;
  /** Last per-chapter progress emission, replayed for new subscribers so
      they see something better than "queued" for the in-flight chapter
      until the next live tick lands. Cleared on chapter_complete. */
  lastProgressTick: {
    chapterId: number;
    characterId: string | null;
    progress: number;
    currentLine: number;
    totalLines: number;
  } | null;
  /** Bug E — run-level aggregates injected into every broadcast tick so
      the global header pill can keep moving (counters AND heartbeat)
      even when the user has navigated to a different book. Without
      these on the wire, the frontend's chapters-slice cross-book guard
      drops per-chapter ticks and the pill freezes at its open-time
      snapshot, eventually flipping to "Stalled" after 30 s. */
  runTotal: number;
  /** Stable for the life of the run — count of non-excluded chapters
      that already had audio on disk at job start AND are NOT being
      (re)generated in this run. The dynamic `done` count is
      `runDoneBase + completedThisRun.size`. */
  runDoneBase: number;
  /** Chapter ids the loop has reported chapter_complete for in this
      run. The frontend reads `runDone` as `runDoneBase + this.size`. */
  completedThisRun: Set<number>;
  /** Chapter ids currently between first synthesise tick and
      chapter_complete / chapter_failed. */
  runInProgress: Set<number>;
}

/* Primary registry — one entry per in-flight chapter, keyed
   `${bookId}::${chapterId}` (or `${bookId}::*` for the back-compat
   sequential job). The queue dispatcher fires one POST per chapter, so the
   queue's N workers map directly onto N concurrent chapter jobs across all
   books — including multiple chapters of the SAME book. A forced request for
   chapter X displaces only chapter X's prior job, never a sibling chapter Y
   of the same book. */
const inFlightByChapter: Map<string, RunningJob> = new Map();

/* Secondary index — every job for a book, used ONLY by (a)
   `isGenerationActive(bookId)` and (b) the subscribe/reload path (a bare
   resume subscribes to ALL of the book's in-flight jobs) and (c) /pause
   (aborts EVERY job for the book). Kept in lock-step with inFlightByChapter
   on register/deregister. */
const inFlightByBook: Map<string, Set<RunningJob>> = new Map();

function chapterKey(bookId: string, chapterId: number | null): string {
  return `${bookId}::${chapterId == null ? '*' : chapterId}`;
}

/* fs-26 — let the splice route displace an in-flight generation of the same
   chapter (and the back-compat `*` job that may be rendering it) before it
   reads the chapter's audio for splicing, so the two never race on the same
   files. Aborting is idempotent; a no-op when nothing is in flight. */
export function abortInFlightChapterJob(bookId: string, chapterId: number): void {
  inFlightByChapter.get(chapterKey(bookId, chapterId))?.controller.abort();
  inFlightByChapter.get(chapterKey(bookId, null))?.controller.abort();
}

/* srv-16 — serialise every server-side `.queue.json` read-modify-write through
   one promise chain. There's no file-level lock, and the server now mutates the
   queue from two concurrent contexts (per-chapter completion below + the
   srv-12 orphan-recovery reset), so without this two near-simultaneous chapter
   completions could each read the same snapshot and the later write would drop
   the earlier removal. The frontend `/complete` is still a backstop, so a race
   would only fall back to today's behaviour — but serialising makes it correct
   for N>1 workers. The chain swallows errors so one failed mutation can't wedge
   the next. */
let queueMutationChain: Promise<unknown> = Promise.resolve();
function serializeQueueMutation(mutate: () => Promise<void>): Promise<void> {
  const next = queueMutationChain.then(mutate, mutate);
  queueMutationChain = next.catch(() => undefined);
  return next;
}

/* srv-16 — mark a chapter's queue entry done from the SERVER once the chapter
   is actually rendered + persisted, instead of relying solely on the frontend
   dispatcher POSTing /complete on stream close. The frontend path is fragile:
   a hard server kill (the 2026-05-30 OOM incident) or a closed tab bypasses it,
   leaving rendered chapters stuck `in_progress` forever (`done` never climbs,
   and on the next boot they look like orphans to re-dispatch). Idempotent: a
   missing entry (frontend already removed it, or it was a force-regen with no
   queue row) is a no-op. */
async function markQueueEntryDoneOnDisk(entryId: string, chapterId: number): Promise<void> {
  await serializeQueueMutation(async () => {
    try {
      const before = await readQueueFile(queueJsonPath());
      if (!before.entries.some((e) => e.id === entryId)) return; // already gone — frontend won the race.
      await writeQueueFile(queueJsonPath(), completeEntry(before, entryId, 'done'));
    } catch (err) {
      console.warn(
        `[generation] failed to mark queue entry ${entryId} (chapter ${chapterId}) done: ${
          (err as Error).message
        }`,
      );
    }
  });
}

/* Loud-fallback gate — park a chapter's queue entry on `awaiting_confirm` from
   the SERVER once the worker detects an undesigned-voice Qwen→Kokoro fallback,
   stamping the affected characters for the modal. Serialised through the same
   chain as the done-flip so it can't race the srv-12 orphan-reset / srv-16
   done-flip. Idempotent: a missing entry (already gone) or one no longer
   in_progress is a no-op (markAwaitingConfirm guards both). */
async function markQueueEntryAwaitingConfirmOnDisk(
  entryId: string,
  fallbackCharacters: QwenFallbackChar[],
): Promise<void> {
  await serializeQueueMutation(async () => {
    try {
      const before = await readQueueFile(queueJsonPath());
      const after = markAwaitingConfirm(before, entryId, fallbackCharacters);
      if (after !== before) await writeQueueFile(queueJsonPath(), after);
    } catch (err) {
      console.warn(
        `[generation] failed to park queue entry ${entryId} on fallback confirm: ${
          (err as Error).message
        }`,
      );
    }
  });
}

function registerJob(key: string, job: RunningJob): void {
  inFlightByChapter.set(key, job);
  let set = inFlightByBook.get(job.bookId);
  if (!set) {
    set = new Set();
    inFlightByBook.set(job.bookId, set);
  }
  set.add(job);
}

function deregisterJob(key: string, job: RunningJob): void {
  /* Only drop the primary entry if it still points at THIS job — a newer
     regen of the same chapter may have already displaced us. */
  if (inFlightByChapter.get(key) === job) {
    inFlightByChapter.delete(key);
  }
  const set = inFlightByBook.get(job.bookId);
  if (set) {
    set.delete(job);
    if (set.size === 0) inFlightByBook.delete(job.bookId);
  }
}

/** True when any generation job is currently in flight for the book. Exposed
    so sibling routes can refuse operations that would race the write path
    (chapter-audio reject restore would clobber a mid-render file). */
export function isGenerationActive(bookId: string): boolean {
  return (inFlightByBook.get(bookId)?.size ?? 0) > 0;
}

/** fs-1 — true when ANY book has a generation job in flight. The upgrade gate
    refuses to swap the running code out from under an active render. Returns the
    busy book ids so the 409 can name them. */
export function activeGenerationBooks(): string[] {
  const out: string[] = [];
  for (const [bookId, set] of inFlightByBook) {
    if (set.size > 0) out.push(bookId);
  }
  return out;
}

function broadcast(job: RunningJob, ev: unknown): void {
  /* Inject run-level aggregates into every outgoing tick (Bug E).
     Done = chapters that were already on disk at job-start (not in
     scope for this run) PLUS chapters this run has completed.
     InProgress = chapters between first synthesise tick and
     chapter_complete / chapter_failed.

     Plan 102 — also stamp `queueEntryId` on every tick (when this job is
     queue-driven) so the frontend dispatcher can correlate ticks back to
     the queue row regardless of which book the user is currently viewing. */
  const enriched =
    ev && typeof ev === 'object'
      ? {
          ...(ev as Record<string, unknown>),
          runDone: job.runDoneBase + job.completedThisRun.size,
          runTotal: job.runTotal,
          runInProgress: job.runInProgress.size,
          ...(job.queueEntryId ? { queueEntryId: job.queueEntryId } : {}),
        }
      : ev;
  for (const sub of job.subscribers) {
    try {
      sub.send(enriched);
    } catch {
      /* A subscriber whose socket already died is harmless to skip — the
         cleanup hook on req.on('close') will drop it from the Set on its
         own tick. We don't want one dead socket to abort the broadcast
         for the rest of the room. */
    }
  }
}

function endAllSubscribers(job: RunningJob, finalEv?: unknown): void {
  for (const sub of job.subscribers) {
    if (finalEv) {
      try {
        sub.send(finalEv);
      } catch {
        /* see broadcast() */
      }
    }
    try {
      sub.res.end();
    } catch {
      /* socket already closed */
    }
  }
  job.subscribers.clear();
}

interface GenerationRequestBody {
  modelKey?: unknown;
  chapterIds?: unknown;
  force?: unknown;
  /** Plan 102 — workspace queue entry id this POST is fulfilling. Optional
      for back-compat (existing callers don't set it; pre-plan-102 servers
      ignored the field). When present, the server stores it on the
      RunningJob and stamps every broadcast tick + the resume_from ack
      with it so the frontend dispatcher can correlate ticks back to the
      right queue row. */
  queueEntryId?: unknown;
  /** Loud-fallback gate — set by the dispatcher when it re-dispatches an entry
      the user has CONFIRMED for Qwen→Kokoro fallback, so the worker renders
      straight through instead of re-parking it. Optional / back-compat. */
  fallbackConfirmed?: unknown;
}

generationRouter.post('/:bookId/generation', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const body = (req.body ?? {}) as GenerationRequestBody;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (!isTtsModelKey(body.modelKey)) {
    send({
      type: 'chapter_failed',
      errorReason:
        'modelKey must be a supported TTS model id (e.g. coqui-xtts-v2, gemini-2.5-flash).',
    });
    return res.end();
  }
  const modelKey: TtsModelKey = body.modelKey;
  const engine = engineForModelKey(modelKey);
  const force = body.force === true;
  const requestedIds = Array.isArray(body.chapterIds)
    ? (body.chapterIds.filter((n) => typeof n === 'number' && Number.isInteger(n)) as number[])
    : null;
  /* Plan 102 — workspace queue entry id this POST is fulfilling. Optional;
     null when called outside the queue surface. Stored on the RunningJob
     and stamped on every broadcast tick + the resume_from ack. */
  const queueEntryId = typeof body.queueEntryId === 'string' ? body.queueEntryId : null;
  const fallbackConfirmed = body.fallbackConfirmed === true;

  let provider;
  try {
    provider = selectTtsProvider(modelKey);
  } catch (e) {
    send({ type: 'chapter_failed', errorReason: (e as Error).message });
    return res.end();
  }

  const located = await findBookByBookId(bookId);
  if (!located) {
    send({ type: 'chapter_failed', errorReason: `No book found for id "${bookId}".` });
    return res.end();
  }
  const { bookDir, state } = located;

  /* Cast must be confirmed for synthesis to know which voice each character
     speaks in. The frontend should gate the generate button on this, but
     we double-check server-side so a stale URL doesn't kick off a bad run. */
  const cast = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
  if (!cast?.characters?.length) {
    send({
      type: 'chapter_failed',
      errorReason: 'Cast not confirmed yet — open the cast view first.',
    });
    return res.end();
  }

  /* Hydrate reused characters' bespoke voices from their source book before any
     routing/synth decision. A reused Qwen character carries only voiceId +
     matchedFrom on disk (the reuse write paths don't copy the engine/override),
     so without this `pickVoiceForEngine('qwen', …)` would resolve to '' and the
     chapter would fall back to Kokoro instead of the designed voice. Folding the
     source book's `ttsEngine` + `overrideTtsVoices` onto the character here means
     every downstream consumer (engine detection, synthesiseChapter routing,
     drift snapshots) sees the real designed voice. No-op for non-reused or
     already-designed characters. */
  cast.characters = await hydrateCastReusedVoices(cast.characters);

  /* fs-2 — never-cross-language enforcement (server-authoritative layer). For a
     non-English book, Kokoro (English-only) cannot speak the text, so EVERY
     character — including the narrator — must render in a designed Qwen voice.
     We force `ttsEngine = 'qwen'` here, AFTER hydration, so a stale/hand-edited
     cast.json or a reused English engine setting can't leak an English voice
     into a Russian book. Undesigned characters are then blocked (not silently
     downgraded to Kokoro) by `forbidKokoroFallback` at the synthesiseChapter
     call below. English books are untouched (byte-identical to pre-fs-2). */
  const bookLanguage = bookStateLanguage(state);
  const nonEnglishBook = isNonEnglish(bookLanguage);
  if (nonEnglishBook) {
    for (const c of cast.characters) c.ttsEngine = 'qwen';
    /* fs-2 / fs-32c — force re-design on cross-language reuse. Shared with the
       splice re-record path: clears any designed Qwen voice whose baked
       manifest language ≠ the book's, so the forbidKokoroFallback gate blocks
       it as undesigned rather than reading wrong-language audio. */
    let sidecarLang: string;
    try {
      sidecarLang = sidecarLanguageName(bookLanguage);
    } catch (e) {
      send({ type: 'chapter_failed', errorReason: (e as Error).message });
      return res.end();
    }
    const clearedVoices = await clearMismatchedDesignedVoices(
      cast.characters,
      sidecarLang,
      bookLanguage,
    );
    if (clearedVoices.length > 0) {
      const names = clearedVoices.map((c) => c.name).join(', ');
      send({
        type: 'warning',
        code: 'voice_language_mismatch',
        message:
          `${clearedVoices.length} designed voice(s) were cleared because they were designed for a ` +
          `different language than this book — re-design ${names} before generating.`,
      });
    }
  }

  /* Per-character engine routing (plan 108). Engine is no longer one global
     choice: a character may carry its own `ttsEngine` (narrator on Kokoro, a
     bespoke character on Qwen, …). Build a per-engine provider cache — the
     default engine reuses the request's provider/modelKey — so
     `synthesiseChapter` routes each character to its own engine's provider
     without reconstructing it per group. Canonical engine→key mapping is the
     shared `canonicalModelKeyForEngine` (also drives the drift stamp). */
  const providerCache = new Map<TtsEngine, { provider: TtsProvider; modelKey: TtsModelKey }>();
  providerCache.set(engine, { provider, modelKey });
  const resolveForEngine = (e: TtsEngine): { provider: TtsProvider; modelKey: TtsModelKey } => {
    const cached = providerCache.get(e);
    if (cached) return cached;
    const mk = canonicalModelKeyForEngine(e, modelKey);
    const built = { provider: selectTtsProvider(mk), modelKey: mk };
    providerCache.set(e, built);
    return built;
  };

  /* Dual-model advisory (plan 108). If the cast mixes engines but the user
     hasn't opted into keeping both resident, warn that enabling dual-model
     mode avoids engine-swap latency. Advisory only — the run proceeds; the
     sidecar lazy-loads each engine on first use. */
  const requiredEngines = new Set(cast.characters.map((c) => resolveCharacterEngine(c, engine)));
  /* Qwen→Kokoro fallback gate. When the cast routes anyone to Qwen but Qwen
     isn't installed/loaded (last-known install-state), mark the engine
     unavailable so synthesiseChapter falls those characters back to Kokoro
     instead of hard-failing the chapter. (A character with a designed Qwen
     voice on a healthy Qwen engine is unaffected — that fallback only fires on
     an undesigned voice or an unavailable engine.) */
  const qwenInUse = requiredEngines.has('qwen');
  const qwenState = getLastKnownQwenInstallState();
  const qwenUnavailable = qwenInUse && qwenState !== 'ready' && qwenState !== 'loaded';
  /* NEVER silently downgrade a Qwen book to Kokoro. When the whole cast's Qwen
     characters are about to render in the wrong engine (wrong voices) because
     Qwen reads unavailable, say so loudly — server log + a UI warning toast
     (surfaced by generation-stream-runner). The most common trigger is a stale
     sidecar whose /health predates qwen_install_state; deriveQwenInstallState
     (sidecar-health.ts) now blocks that specific cause, but a genuinely
     uninstalled / weights-missing / load-failed Qwen still lands here, and that
     downgrade must be visible, not silent. (Stale-build incident, 2026-05-29 —
     docs/features/archive/135-qwen-loud-fallback.md.) */
  if (qwenUnavailable && nonEnglishBook) {
    /* fs-2 — a non-English book CANNOT fall back to Kokoro (English-only), so an
       unavailable Qwen engine is fatal, not an advisory. Abort the whole run
       before any chapter renders rather than emitting cross-language garbage. */
    const message =
      `This ${bookLanguage} book requires Qwen, but Qwen is unavailable ` +
      `(install-state: ${qwenState}). English Kokoro voices cannot read ` +
      `${bookLanguage} text, so no chapter can be generated. Start/refresh the ` +
      `TTS sidecar and load Qwen, then regenerate.`;
    console.warn(`[generation] ${message}`);
    send({ type: 'chapter_failed', errorReason: message });
    return res.end();
  }
  if (qwenUnavailable) {
    const message =
      `Qwen is unavailable (install-state: ${qwenState}), so every Qwen character ` +
      `will render in Kokoro — generic fallback voices, NOT the designed Qwen ` +
      `voices. Check the TTS sidecar (a stale or unloaded sidecar is the usual ` +
      `cause), then regenerate affected chapters.`;
    console.warn(`[generation] ${message}`);
    send({
      type: 'warning',
      code: 'qwen_unavailable_kokoro_fallback',
      message,
      qwenInstallState: qwenState,
    });
  }
  if (requiredEngines.size > 1 && !getCachedUserSettings().dualModelEnabled) {
    const list = [...requiredEngines].sort().join(' + ');
    const message =
      `This book mixes TTS engines (${list}) but dual-model mode is off. Generation ` +
      `will still run, but turning on "Keep both TTS engines loaded" in Account ` +
      `settings avoids engine-swap latency.`;
    console.warn(`[generation] ${message}`);
    send({
      type: 'warning',
      code: 'dual_model_off_multi_engine',
      message,
      engines: [...requiredEngines].sort(),
    });
  }

  /* Plan 80 — manuscript-edits.json is the canonical post-analysis sentence
     list: it carries every per-sentence characterId reassignment the user
     has made in the manuscript view, every split-offspring sentence (ids
     above the analyzer's max), and every cross-chapter remap from
     merge/split/reorder. The analysis cache is the analyzer's frozen
     output — it lags any edit the user has made. When edits exist they
     always win, so we rebuild the cache from edits before synth.
     Subsumes the post-merge auto-heal path from plan 70c (that path was
     a strict subset: "cache empty AND edits exist") and additionally
     covers the regenerate-after-speaker-edit case that 70c missed. */
  const editsPath = manuscriptEditsJsonPath(bookDir);
  const editsSnapshot = await readJson<{ sentences?: unknown[] }>(editsPath);
  const hasEdits = Array.isArray(editsSnapshot?.sentences) && editsSnapshot.sentences.length > 0;
  if (hasEdits) {
    await rebuildCacheFromEdits(state.manuscriptId, editsPath).catch((e) => {
      console.error('[generation] rebuild cache from edits failed', e);
    });
  }
  const analysis = await loadAnalysisCache(state.manuscriptId);
  if (!analysis.chapters || Object.keys(analysis.chapters).length === 0) {
    send({
      type: 'chapter_failed',
      errorReason: 'No analysed sentences cached for this book. Re-run analysis first.',
    });
    return res.end();
  }

  const audioRoot = audioDir(bookDir);
  await mkdir(audioRoot, { recursive: true });

  /* Decide which chapters to (re)generate. Default: every chapter that does
     not already have an audio file on disk. `force` overrides existence.
     Excluded chapters (front/back-matter the user opted out of narrating)
     are always skipped — even an explicit requestedIds=[...] that lists an
     excluded chapter is filtered out, since generating audio for an
     excluded chapter would silently undo the user's choice.

     Computed BEFORE the catch-up replay so the replay can skip in-scope
     chapters (see comment on the replay loop). */
  const targetChapters = state.chapters.filter((c) => {
    if (c.excluded) return false;
    if (requestedIds && !requestedIds.includes(c.id)) return false;
    if (force) return true;
    return !chapterAudioExists(audioRoot, c.slug);
  });
  const targetIdSet = new Set(targetChapters.map((c) => c.id));

  /* srv-28 — pre-flight disk-space guard. Estimate this run's footprint
     (target chapters × AVG_CHAPTER_BYTES) and compare against the free space on
     the audio volume. Default mode WARN rides the existing toast path; BLOCK
     short-circuits with a disk-full failure before any chapter renders; OFF
     skips. Best-effort: a probe failure (statfs throw) never blocks the run. */
  const diskMode = diskGuardMode();
  if (diskMode !== 'off' && targetChapters.length > 0) {
    try {
      const verdict = await evaluateDiskGuard(
        audioRoot,
        {
          estimatedBytes: targetChapters.length * AVG_CHAPTER_BYTES,
          basis: 'generation',
          chapters: targetChapters.length,
        },
        { mode: diskMode },
      );
      if (verdict.status === 'warn') {
        send({ type: 'warning', code: 'disk_low', message: verdict.message });
      } else if (verdict.status === 'block') {
        /* Mirror the pre-flight guard short-circuit shape (a chapter_failed +
           res.end). Carry the fs-19 disk-full code + remediation so the
           frontend renders the same "what to do" line a mid-run ENOSPC would. */
        send({
          type: 'chapter_failed',
          errorReason: verdict.message,
          errorCode: 'disk-full',
          remediation:
            'Free up disk space on the workspace volume (delete old exports, or move the ' +
            'workspace to a larger drive), then start the run again.',
        });
        return res.end();
      }
    } catch (e) {
      console.warn('[generation] disk guard probe failed (continuing):', (e as Error).message);
    }
  }

  /* srv-16 — if this queue-driven POST's sole target chapter already has audio
     on disk (rendered before a crash/restart, so it's excluded from
     targetChapters and nothing will render), no chapter_complete fires to drive
     Hook 1 — so complete its queue entry here. Without this, a re-dispatched
     entry for an already-finished chapter loops in_progress->queued forever
     across boots. Guarded to a single-chapter, non-force queue POST whose
     target is already-on-disk. */
  if (queueEntryId != null && !force && requestedIds && requestedIds.length === 1) {
    const onlyId = requestedIds[0];
    const ch = state.chapters.find((c) => c.id === onlyId);
    if (ch && !ch.excluded && !targetIdSet.has(onlyId) && chapterAudioExists(audioRoot, ch.slug)) {
      void markQueueEntryDoneOnDisk(queueEntryId, onlyId);
    }
  }

  /* Plan 102 — emit `resume_from` as the FIRST event on every new subscriber
     (cold connect AND post-reconnect after `tsx watch` restart or production
     server bounce). Carries the snapshot of already-completed chapter ids in
     this book so the frontend dispatcher can dedupe the upcoming
     chapter_complete catch-up replay. When the POST carries a queueEntryId
     (queue-driven dispatch), it rides along so the frontend can correlate
     this resume back to the right queue row. For a subscribe-to-existing
     POST (browser reload mid-run), the existing job's queueEntryId wins —
     the in-flight job's id is what represents reality. Always emitted, even
     for back-compat callers without a queueEntryId, so the frontend has a
     single canonical signal to gate the rest of its catch-up handling. */
  /* For the resume_from queueEntryId: when an in-flight job already exists for
     this book, its id represents reality. With per-chapter jobs there can be
     several; the targeted chapter's job wins when this POST names one,
     otherwise any of the book's jobs is as good a correlation anchor as
     another (a bare resume re-subscribes to all of them anyway). */
  const bookJobs = inFlightByBook.get(bookId);
  const targetedChapterId = requestedIds && requestedIds.length === 1 ? requestedIds[0] : null;
  const existingForResume =
    (targetedChapterId != null
      ? inFlightByChapter.get(chapterKey(bookId, targetedChapterId))
      : undefined) ?? (bookJobs ? [...bookJobs][0] : undefined);
  const effectiveQueueEntryId = existingForResume?.queueEntryId ?? queueEntryId;
  const onDiskCompleted = state.chapters
    .filter((c) => !c.excluded && !targetIdSet.has(c.id) && chapterAudioExists(audioRoot, c.slug))
    .map((c) => c.id);
  send({
    type: 'resume_from',
    ...(effectiveQueueEntryId ? { queueEntryId: effectiveQueueEntryId } : {}),
    resumeFromCompletedChapterIds: onDiskCompleted,
  });

  /* Catch-up replay: emit a chapter_complete for every chapter already on
     disk so a reconnecting client (post-pause, page refresh, etc.) snaps to
     the latest state without needing a separate GET. Cheap — one tick per
     done chapter. We do this BEFORE deciding the queue so the client sees
     state even when nothing new is queued.

     Excluded chapters are skipped — even if stale audio is still on disk
     from before they were excluded, we don't want to tell the frontend
     the chapter is "complete" when the user opted out of narrating it.

     In-scope chapters (force-regen targets whose audio still exists on
     disk because the synthesis loop hasn't overwritten it yet) are also
     skipped — emitting chapter_complete here would race the live run and
     snap the chapter's UI back to "Done" before the synthesis loop's
     first progress tick lands, freezing the row at the stale duration
     and making the regen look like a no-op. (Repro that prompted this
     guard: screenshot 2026-05-21 174722.) */
  for (const ch of state.chapters) {
    if (ch.excluded) continue;
    if (targetIdSet.has(ch.id)) continue;
    if (chapterAudioExists(audioRoot, ch.slug)) {
      const cachedSentences = analysis.chapters[ch.id] ?? [];
      send({
        type: 'chapter_complete',
        chapterId: ch.id,
        characterId: null,
        progress: 1,
        currentLine: cachedSentences.length,
        totalLines: cachedSentences.length,
        /* Replay the engine stamp so a reconnecting client gets drift
           signal without a separate state hydrate. State.chapters here
           was already lazy-backfilled by findBookByBookId for legacy
           audio. */
        ...(ch.audioModelKey ? { audioModelKey: ch.audioModelKey as TtsModelKey } : {}),
      });
    }
  }

  if (targetChapters.length === 0) {
    send({ type: 'idle' });
    return res.end();
  }

  /* This POST's chapter identity. Under the queue-sole-concurrency model the
     dispatcher fires one chapter per POST (chapterIds:[id], force:true), so a
     single target = the job's chapter. A no-ids / multi-id caller is the
     back-compat path: one job keyed `${bookId}::*` walks all targets
     sequentially (no within-book pool). */
  const jobChapterId: number | null = targetChapters.length === 1 ? targetChapters[0].id : null;
  const key = chapterKey(bookId, jobChapterId);

  /* Two dispatch modes for this POST:
       - "Subscribe": no chapterIds + no force (a bare resume / browser
         reload). The connection joins EVERY in-flight job for this book's
         subscriber set; no loop is re-entered and nothing is aborted. The
         catch-up replay above has already snapped this client to the current
         on-disk state; subsequent broadcast ticks bring the rest. This is
         where browser-reload survival lives — a page-reload's bare POST lands
         here and the original run(s) keep generating untouched.
       - "Start / displace": chapterIds + force (regen) OR no existing job
         for THIS chapter. We abort only the SAME chapter's prior job (regen
         of chapter X wants a fresh run with the new spec; a sibling chapter Y
         of the same book is never touched). The loop runs in this request's
         lexical scope.
     Pause used to piggyback on SSE close; it doesn't any more — see the
     dedicated POST /pause endpoint below. SSE close ONLY unsubscribes
     this observer now; the job carries on for other observers (or for
     no observers at all). */
  const isDisplacing = (requestedIds !== null && requestedIds.length > 0) || force;
  if (!isDisplacing) {
    /* Bare resume — subscribe to every live job for this book (there may be
       several concurrent chapters) and replay each one's last tick so a
       post-reload UI flips each in-flight chapter out of "queued" without
       waiting for the next group boundary. Never abort. */
    const liveJobs = [...(inFlightByBook.get(bookId) ?? [])].filter(
      (j) => !j.controller.signal.aborted,
    );
    if (liveJobs.length > 0) {
      for (const existing of liveJobs) {
        const subscriber: Subscriber = { send, res };
        existing.subscribers.add(subscriber);
        req.on('close', () => existing.subscribers.delete(subscriber));
        if (existing.lastProgressTick) {
          send({ type: 'progress', ...existing.lastProgressTick });
        } else if (existing.currentChapterId != null) {
          /* Sub-second window where the loop just entered a chapter but hasn't
             emitted a group-boundary tick yet. Send a minimal in-progress
             marker so the row still flips out of "queued". */
          send({
            type: 'progress',
            chapterId: existing.currentChapterId,
            characterId: null,
            progress: 0.01,
            currentLine: 0,
            totalLines: 0,
          });
        }
      }
      /* Keep `res` open. Each subscribed job ends this response via
         endAllSubscribers() when it drains or is paused; the FIRST job to
         finish closes the socket, which is fine — the catch-up replay + the
         remaining jobs' broadcasts already reached this client. */
      return;
    }
    /* No live job for this book — fall through to start a fresh run. */
  }

  /* Displace ONLY this chapter's prior job (or the back-compat `*` job). A
     forced request for chapter X must not abort sibling chapter Y. */
  const existing = inFlightByChapter.get(key);
  if (existing) existing.controller.abort();
  /* fs-26 — a fresh regen of this chapter also displaces any in-flight splice
     of it, so the two never race on the same `<slug>.mp3`/.segments.json pair. */
  abortInFlightSplice(bookId, jobChapterId);
  const controller = new AbortController();
  /* Bug E — seed run-level aggregates from disk state. runTotal = all
     non-excluded chapters; runDoneBase = non-excluded chapters whose
     audio exists on disk AND aren't in this run's scope (force-regen of
     a chapter drops it from "done base" because it's about to be
     overwritten — done count rebounds via completedThisRun as it
     finishes). */
  const nonExcluded = state.chapters.filter((c) => !c.excluded);
  const runDoneBase = nonExcluded.filter(
    (c) => !targetIdSet.has(c.id) && chapterAudioExists(audioRoot, c.slug),
  ).length;
  const job: RunningJob = {
    controller,
    subscribers: new Set([{ send, res }]),
    bookId,
    chapterId: jobChapterId,
    queueEntryId,
    fallbackConfirmed,
    currentChapterId: null,
    lastProgressTick: null,
    runTotal: nonExcluded.length,
    runDoneBase,
    completedThisRun: new Set(),
    runInProgress: new Set(),
  };
  registerJob(key, job);

  /* SSE close on the starter connection is just an unsubscribe — the job
     keeps running for any other observers. If the starter was the only
     subscriber, the loop generates audio to disk silently; the next
     subscriber to attach picks up via the catch-up replay. */
  /* `res.on('close')` (not `req`) is the reliable client-gone signal: once
     express.json() has consumed the request body the `req` stream is already
     ended, so `req.on('close')` can miss a mid-stream disconnect. The response
     stays open for the SSE, so its `close` is what actually fires when the
     socket tears down. */
  res.on('close', () => {
    for (const sub of job.subscribers) {
      if (sub.res === res) {
        job.subscribers.delete(sub);
        break;
      }
    }

    /* srv-12 — orphan recovery. On success the frontend POSTs /complete BEFORE
       the SSE closes, so the entry is already done-pruned (or marked failed) by
       now. An entry STILL `in_progress` at last-subscriber-close is therefore
       abnormal: the watcher vanished mid-run (tab closed / network drop) with no
       one to drive the chapter to /complete. Reset it `in_progress`→`queued` so
       the dispatcher re-claims it on the next boot/snapshot, and abort the
       now-unwatched synthesis to free the GPU.

       Gated three ways so we only touch genuine orphans:
         - `job.subscribers.size === 0` — this was the LAST subscriber.
         - `job.queueEntryId` is set — a queue-driven run (not a legacy caller).
         - the job is still REGISTERED (`inFlightByChapter.get(key) === job`) —
           i.e. the loop hasn't reached deregisterJob, so the run hasn't drained
           normally. A completed/displaced job is already deregistered, so we
           skip it and never resurrect a done entry.
       `resetEntryToQueued` is itself a no-op for a missing / non-in_progress id,
       so a race against the frontend-owned lifecycle can't flip a done/failed
       entry back to queued. */
    if (
      job.subscribers.size === 0 &&
      job.queueEntryId != null &&
      inFlightByChapter.get(key) === job
    ) {
      const orphanEntryId = job.queueEntryId;
      /* srv-16 — through the shared serializer so this reset can't race a
         concurrent per-chapter completion (read-modify-write on one file). */
      void serializeQueueMutation(async () => {
        try {
          const before = await readQueueFile(queueJsonPath());
          const after = resetEntryToQueued(before, orphanEntryId);
          if (after !== before) await writeQueueFile(queueJsonPath(), after);
        } catch (err) {
          console.warn(
            `[generation] orphan-recovery: failed to reset queue entry ${orphanEntryId} to queued: ${
              (err as Error).message
            }`,
          );
        }
      });
      if (!job.controller.signal.aborted) job.controller.abort();
    }
  });

  /* Cascade detector — if the same non-fatal reason fails two chapters in
     a row (only reachable on the back-compat `*` job that walks multiple
     chapters sequentially), the failure is deterministic (e.g. sidecar
     mis-routing every character to an invalid speaker_id). Escalate to fatal
     on the second hit so the user gets one clean banner instead of a long
     stream of identical chapter_failed ticks. See screenshot 2026-05-13
     181647 for the cascade we're killing. Under the queue-sole-concurrency
     model each dispatcher POST carries exactly one chapter, so the cascade
     within a single job never spans chapters — cross-chapter escalation now
     lives at the queue layer (out of scope; each chapter fails
     independently). */
  const cascade = newCascadeState();

  /* Fatal escalation flag — only meaningful on the back-compat sequential
     loop, where it stops the loop from picking up a fresh chapter after the
     cascade fired. */
  let cascadeFatal = false;

  /* Process a single chapter end-to-end. Each job's loop runs exactly one of
     these (the common single-chapter case) or walks the back-compat target
     list sequentially. The job's own `synthesiseChapter` call carries its own
     `onGroupStart` heartbeat; `controller.signal` threads through so pause or
     same-chapter regen displacement aborts this chapter's in-flight synth. */
  const processOneChapter = async (chapter: (typeof targetChapters)[number]): Promise<void> => {
    if (controller.signal.aborted) return;
    if (cascadeFatal) return;

    /* Pin this chapter as in-flight on the job so the subscribe-side
       catch-up replay has something to emit for a post-reload client.
       Cleared on chapter_complete / chapter_failed / abort. */
    job.currentChapterId = chapter.id;
    job.lastProgressTick = null;
    job.runInProgress.add(chapter.id);

    const sentences = analysis.chapters[chapter.id] ?? [];
    if (sentences.length === 0) {
      /* Bug E: drop from in-flight before continuing so the aggregate
         stays accurate when the next chapter is added. */
      job.runInProgress.delete(chapter.id);
      broadcast(job, {
        type: 'chapter_failed',
        chapterId: chapter.id,
        errorReason: 'No sentences available for this chapter — analysis cache is incomplete.',
      });
      return;
    }

    /* fs-58 Unit B — all-excluded guard. If every sentence is flagged
       excludeFromSynthesis, synthesiseChapter would receive an empty group
       list and produce a 0-byte "complete". Fail early with a distinct reason
       instead so the user knows what happened. */
    const keptCount = sentences.filter((s) => !s.excludeFromSynthesis).length;
    if (keptCount === 0) {
      job.runInProgress.delete(chapter.id);
      broadcast(job, {
        type: 'chapter_failed',
        chapterId: chapter.id,
        errorReason: 'All content in this chapter is flagged non-story — nothing to synthesise.',
      });
      return;
    }

    /* Loud-fallback gate. Before emitting any progress, check whether this
       chapter would SILENTLY render an undesigned Qwen voice in Kokoro. If so,
       park the entry on `awaiting_confirm` and release this worker (without
       failing the chapter) so the user can confirm (render anyway) or skip —
       other chapters keep flowing. Scope: queue-driven runs only (there's a row
       to flip), Qwen healthy (the qwenUnavailable all-cast case has its own
       loud warning above), and not already confirmed for this entry. */
    if (qwenInUse && !qwenUnavailable && job.queueEntryId != null && !job.fallbackConfirmed) {
      const speakingIds = new Set(sentences.map((s) => s.characterId));
      const speakers = cast.characters.filter((c) => speakingIds.has(c.id));
      const fallbackSet = computeQwenKokoroFallbackSet(speakers, engine);
      if (fallbackSet.length > 0) {
        /* Flip in_progress → awaiting_confirm FIRST (serialised, so the srv-12
           res-close orphan-reset + srv-16 done-flip see a non-in_progress entry
           and no-op), then broadcast + return without rendering. */
        await markQueueEntryAwaitingConfirmOnDisk(job.queueEntryId, fallbackSet);
        job.runInProgress.delete(chapter.id);
        job.currentChapterId = null;
        broadcast(job, {
          type: 'chapter_awaiting_fallback_confirm',
          chapterId: chapter.id,
          fallbackCharacters: fallbackSet,
        });
        return;
      }
    }

    const totalLines = sentences.length;
    /* srv-27 — expected audio length for the post-synthesis QA gate. ~14 chars
       per second is a typical narration rate (≈150 wpm at ~5.5 chars/word incl.
       spaces); used only as a coarse band (0.5×–2.5×) to flag truncated /
       runaway renders, so the exact constant isn't load-bearing. */
    const QA_CHARS_PER_SEC = 14;
    const totalChars = sentences.reduce((sum, s) => sum + (s.text?.length ?? 0), 0);
    const expectedSec = totalChars > 0 ? totalChars / QA_CHARS_PER_SEC : null;
    const initialTick = {
      chapterId: chapter.id,
      characterId: null,
      progress: 0.01,
      currentLine: 0,
      totalLines,
    };
    job.lastProgressTick = initialTick;
    broadcast(job, { type: 'progress', ...initialTick });

    /* Per-chapter no-progress watchdog (2026-06-02 the drowning bell ch52). A
       chapter-scoped controller chained to the job controller: a pause /
       displacement abort still propagates, but the watchdog can also abort
       JUST this chapter without touching sibling work. `bumpProgress` is called
       on every real forward step (group/batch completion + each assembly
       milestone); if none lands within `noProgressMs`, `stallGuard` rejects with
       a ChapterStallError. We Promise.race the body against `stallGuard` so even
       a synchronously-hung await (e.g. a wedged ffmpeg in assembly that ignores
       the abort) is escaped — aborting `chapterCtrl` is best-effort cancellation
       on top. */
    const chapterCtrl = new AbortController();
    const onParentAbort = () => chapterCtrl.abort();
    if (controller.signal.aborted) chapterCtrl.abort();
    else controller.signal.addEventListener('abort', onParentAbort, { once: true });
    let lastProgressAt = Date.now();
    let stallPhase: 'synthesis' | 'assembly' = 'synthesis';
    const bumpProgress = () => {
      lastProgressAt = Date.now();
    };
    const noProgressMs = chapterNoProgressMs();
    let watchdogFired = false;
    let stallTimer: ReturnType<typeof setInterval> | null = null;
    let rejectStall: ((e: unknown) => void) | null = null;
    const stallGuard =
      noProgressMs > 0
        ? new Promise<never>((_, reject) => {
            rejectStall = reject;
          })
        : null;

    /* Wraps ensureSidecarEngineReady at the two primary preload sites so a
       GpuBusyError (analysis in progress on a constrained card) surfaces as a
       user-facing "Generation paused" message rather than an unhandled throw. */
    async function ensureReadyOrPause(eng: TtsEngine, sig: AbortSignal | undefined): Promise<void> {
      try {
        await ensureSidecarEngineReady(eng, sig);
      } catch (e) {
        const { GpuBusyError } = await import('../gpu/gpu-load.js');
        if (e instanceof GpuBusyError) {
          throw new Error(`Generation paused: ${(e as Error).message}`); // user-facing pause, NOT a breaker-tripping crash
        }
        throw e;
      }
    }

    try {
      const renderBody = async (chapterSignal: AbortSignal): Promise<void> => {
      /* Build the spoken chapter-title phrase from chapter.id + chapter.title.
         Returns null only when both inputs are unusable (defensive — every
         confirmed chapter has at least an id), in which case `?? undefined`
         lets `synthesiseChapter` skip the title beat the same way it does
         for callers that haven't opted in. */
      const chapterTitleNarration =
        buildChapterTitleNarration({ id: chapter.id, title: chapter.title }) ?? undefined;
      /* Preload gate: confirm the engine's sidecar model is resident BEFORE any
         synth leaves, so a cold start pauses here instead of N queue workers
         racing the lazy load. Idempotent + best-effort (the sidecar
         `_base_load_lock` is the correctness guarantee; this is the explicit
         "wait until ready" on top). Honours the run abort. */
      await ensureReadyOrPause(engine, chapterSignal);
      /* Warm Kokoro ONLY when this chapter will actually render a Qwen→Kokoro
         fallback — either the whole-cast `qwenUnavailable` case, or a confirmed
         per-character undesigned-voice fallback (an unconfirmed one parked the
         chapter above and never reaches here). A fully-designed, healthy all-Qwen
         book never loads Kokoro now — previously `if (qwenInUse)` warmed it
         unconditionally, wasting ~1 GB of VRAM and oversubscribing an 8 GB card.
         Kokoro is intentionally NOT eager-loaded at boot when Qwen is default. */
      const willFallBackToKokoro =
        qwenUnavailable ||
        (qwenInUse &&
          computeQwenKokoroFallbackSet(
            cast.characters.filter((c) =>
              new Set(sentences.map((s) => s.characterId)).has(c.id),
            ),
            engine,
          ).length > 0);
      if (willFallBackToKokoro) {
        await ensureReadyOrPause('kokoro', chapterSignal);
      }
      /* Wall around the synth phase only (all TTS — title beat + body groups;
         encode/disk happens after and is excluded) — drives the RTF rollup +
         the dev top-bar throughput pill. */
      const synthStartMs = Date.now();
      /* srv-17c recovery is now IN-LOOP (C1, Wave 3): synthesiseChapter recovers
         a mid-render recycle from the failed synth site via the `onRecoverRecycle`
         hook below (riding out the respawn on the readiness gate) WITHOUT
         re-rendering completed groups. See the hook + MAX_RECYCLE_RECOVERIES. */
      /* srv-31 — surface the ASR content-QA pass as a "verifying" phase. Fired
         per sampled group (onProgress) AND per drift re-record (onRerecord);
         both bump the no-progress watchdog and broadcast a chapter_verifying
         tick. Carrying counters at totalLines keeps the row near 99 % without
         resetting ch.phase (a `progress` tick would flip it back to null). */
      const emitVerifying = () => {
        bumpProgress();
        broadcast(job, {
          type: 'chapter_verifying',
          chapterId: chapter.id,
          characterId: null,
          progress: 0.99,
          currentLine: totalLines,
          totalLines,
        });
      };
      const result = await synthesiseChapter({
        sentences,
        cast: cast.characters,
        provider,
        modelKey,
        engine,
        resolveForEngine,
        qwenUnavailable,
        /* fs-2 — block the Kokoro fallback on non-English books so an undesigned
           Qwen voice fails the chapter loudly instead of reading the book's
           language through an English voice. English books keep the graceful
           fallback (forbidKokoroFallback = false). */
        forbidKokoroFallback: nonEnglishBook,
        bookLanguage,
        signal: chapterSignal,
        chapterTitleNarration,
        narratorCharacterId: 'narrator',
        /* Title-beat ticks so the SSE stream doesn't go silent while the
           pre-body title synth runs (Coqui can take a couple of seconds for
           a short phrase, the stall detector fires at 30 s). currentLine: 0
           keeps the UI's "line N of M" caption at the pre-body state. */
        onTitleStart: () => {
          bumpProgress();
          const tick = {
            chapterId: chapter.id,
            characterId: 'narrator',
            progress: 0.005,
            currentLine: 0,
            totalLines,
          };
          job.lastProgressTick = tick;
          broadcast(job, { type: 'progress', ...tick });
        },
        /* Tick AT THE START of each group so the client's 30s "Worker has
           gone quiet" stall detector resets even when a single group is a
           multi-minute synth call (long narrator block on CPU XTTS).
           Without this, group-complete was the only tick and the SSE went
           silent for the entire duration of each call.

           This job owns its own `synthesiseChapter` call, so its heartbeat
           is independent of any concurrent chapter's job. */
        onGroupStart: ({ group, totalGroups, completed }) => {
          /* currentLine / progress report the COUNT of groups finished so far,
             NOT this group's narrative position. Under parallel dispatch
             (poolWidth > 1) + Qwen batching the in-flight items tick at
             different positions and the heartbeat re-fires them, so a
             position-based currentLine ping-pongs backward (the "17 ↔ 25,
             stalled" bug). `completed` is a single monotonic counter shared by
             every concurrent worker, so it only ever climbs. group.characterId
             still drives the active-speaker highlight. */
          const progress = Math.min(0.99, completed / Math.max(1, totalGroups));
          const tick = {
            chapterId: chapter.id,
            characterId: group.characterId,
            progress,
            currentLine: completed,
            totalLines,
          };
          job.lastProgressTick = tick;
          broadcast(job, { type: 'progress', ...tick });
        },
        onGroupComplete: ({ group, totalGroups, completed }) => {
          /* Real forward progress — a group finished. (We deliberately do NOT
             bump on onGroupStart: withHeartbeat re-fires it every ~10s as a
             local timer regardless of sidecar liveness, so bumping there would
             mask a genuinely wedged synth from the watchdog.) */
          bumpProgress();
          const progress = Math.min(0.99, completed / Math.max(1, totalGroups));
          const tick = {
            chapterId: chapter.id,
            characterId: group.characterId,
            progress,
            currentLine: completed,
            totalLines,
            /* fs-13 — carry the just-completed group's sentence ids so the
               frontend can track an EXACT per-character done SET under
               out-of-order completion (poolWidth > 1 + Qwen batching), instead
               of approximating each character's bar from the chapter-wide
               `currentLine` count. The chapter-level count above is unchanged
               (still the monotonic group count). Only the completion tick
               carries this — the onGroupStart heartbeat must NOT, or a started-
               but-unfinished group would read as done. */
            completedSentenceIds: group.sentenceIds,
          };
          job.lastProgressTick = tick;
          broadcast(job, { type: 'progress', ...tick });
        },
        /* Live per-batch RTF (plan 127). Each completed Qwen batch feeds the
           rolling live-batch window so the dev pill shows throughput that moves
           mid-chapter, not just the per-chapter rollup below. */
        onBatchComplete: ({ genMs, audioMs }) => {
          bumpProgress();
          recordBatchThroughput({ genMs, audioMs });
        },
        /* srv-36 — the post-synth SPK embed pass is CPU-bound and emits no SSE
           tick of its own; feed the no-progress watchdog per embed so a long
           pass (many groups) can't be killed mid-flight (sibling of #1029). */
        onEmbedProgress: bumpProgress,
        /* Pre-assembly per-sentence QA gate (segment-qa.ts): re-record a
           sentence whose rendered PCM is dead/silent, has a long internal
           silence run, or drifts far from its text-predicted length, BEFORE
           the chapter is concatenated. Tunable via SEG_QA_MAX_RERECORDS
           (default 2; 0 disables). The thresholds default from segment-qa.ts'
           own env (SEG_QA_*), so we don't pass `segmentQaThresholds` here. */
        maxSegmentRerecords: resolveSegmentQaRerecords(),
        onSegmentRerecord: () => {
          /* Keep both the server no-progress watchdog and the client stall
             timer fed while a suspect sentence re-records (serial, after the
             pool), and re-broadcast the last tick so the SSE isn't silent. No
             new SSE shape — the re-record surfaces as continued progress. */
          bumpProgress();
          if (job.lastProgressTick) broadcast(job, { type: 'progress', ...job.lastProgressTick });
        },
        /* ASR content-QA pass (srv-31) — OFF unless SEG_ASR_ENABLED. Transcribes
           each sentence and re-records "fluent but wrong words" drift. The cast
           names form the proper-noun allowlist; the non-English language hint is
           threaded so the WER is meaningful (Phase 6). Both the per-group
           progress and any drift re-record emit a `chapter_verifying` tick via
           `emitVerifying` (a `progress` tick would reset the row's phase). */
        ...(asrEnabled()
          ? {
              asr: {
                maxRerecords: resolveAsrRerecords(),
                sampleEvery: resolveAsrSampleEvery(),
                language: nonEnglishBook ? bookLanguage : undefined,
                nameAllowlist: buildCastNameAllowlist(cast.characters),
                onProgress: emitVerifying,
                onRerecord: emitVerifying,
              },
            }
          : {}),
        /* C1 (srv-17c, Wave 3) — recover in-loop (preserves completed groups)
           instead of the old outer for-loop that re-rendered the WHOLE chapter
           on a mid-render recycle (the RTF collapse). synthesiseChapter now calls
           this hook from the failed synth site, waits out the respawn on the
           readiness gate, and re-attempts ONLY that work item; every already-
           filled `results[]` slot survives because the function never restarts.
           Recoverable = a transient sidecar-down (recycle/respawn/crash drop, or
           a drain-503 — both `transient` once withTtsRetry's short budget
           exhausts) OR a ChapterSynthTimeoutError (a synth that HUNG because the
           respawned sidecar was still loading the model in-band — non-transient
           by construction, classified recoverable inside withRecycleRecovery).
           MAX_RECYCLE_RECOVERIES is the shared per-chapter budget; on exhaustion
           synthesiseChapter throws RecycleStormError, which the outer catch maps
           to chapter_failed (Task 3 names it). AbortError, poison, and every
           other fatal classifier error still re-throw unchanged. */
        maxRecycleRecoveries: MAX_RECYCLE_RECOVERIES,
        onRecoverRecycle: async ({ engine: recEngine, attempt }) => {
          console.warn(
            `[generation] chapter ${chapter.id} (${chapter.slug}): sidecar unavailable ` +
              `mid-synth (recycle/respawn) — riding out the respawn, re-attempt ` +
              `${attempt}/${MAX_RECYCLE_RECOVERIES} (preserving completed groups).`,
          );
          /* C2 (Wave 3) — the readiness wait below can take up to ~210 s
             (READINESS_TIMEOUT_MS); without a tick the SSE goes silent and the
             client's 30 s "Worker has gone quiet" stall banner fires for what is
             actually a healthy respawn ride-out. Emit a chapter_recovering tick
             immediately + on a 10 s heartbeat so BOTH watchdogs stay fed: the
             server no-progress guard (bumpProgress) and the client stall detector
             (< 30 s). 0.9 progress + the last currentLine keep the bar where
             synthesis left it. Mirrors emitVerifying (srv-31). */
          const emitRecovering = () => {
            bumpProgress();
            broadcast(job, {
              type: 'chapter_recovering',
              chapterId: chapter.id,
              characterId: null,
              /* Hold the bar where synthesis left it rather than snapping to a
                 fixed 0.9 — a recycle can fire at any group position, so a hard
                 0.9 would visibly REGRESS the bar (e.g. 0.95 → 0.9) for the
                 ride-out, then jump forward. Reuse the last real tick's progress
                 (same idiom as currentLine below); 0.9 is only the pre-first-tick
                 seed. */
              progress: job.lastProgressTick?.progress ?? 0.9,
              currentLine: job.lastProgressTick?.currentLine ?? 0,
              totalLines,
            });
          };
          emitRecovering();
          const beat = setInterval(emitRecovering, 10_000);
          beat.unref?.();
          /* Polls through the supervisor respawn (srv-17b, 120 s budget); throws
             AbortError if the run is paused/displaced mid-wait → propagates out
             of synthesiseChapter as a clean stop (the outer catch returns on
             AbortError). */
          try {
            await ensureSidecarEngineReady(recEngine, chapterSignal);
          } finally {
            clearInterval(beat);
          }
        },
      });

      /* All per-group synthesis is done; the next stretch is disk-write
         work (encode MP3 → temp file → segments JSON → atomic rename →
         state.json update). Tell the client so it stops looking like a
         frozen 99 %. This phase has no per-call timeout, so the no-progress
         watchdog is the only ceiling on a wedged ffmpeg/encode here — mark the
         phase (so a stall names "assembly") and bump as we enter it. */
      stallPhase = 'assembly';
      bumpProgress();
      broadcast(job, {
        type: 'chapter_assembling',
        chapterId: chapter.id,
        characterId: null,
        progress: 0.995,
        currentLine: totalLines,
        totalLines,
        totalGroups: result.segments.length,
        durationSec: result.durationSec,
      });

      /* Per-book audio format (plan 72) — defaults to mp3 for state files
         written before the field landed. */
      const audioFormat = bookStateAudioFormat(state);

      /* srv-29 — converged encode + persist tail. finalizeChapterAudioWrite
         owns the loudnorm encode + sidecars, the advisory QA verdict, the
         per-character drift snapshots, the `.previous.*` preservation + atomic
         write + peaks sibling, and the state.json duration/model/QA stamp —
         byte-identical to what this route inlined, and shared with the fs-26
         splice path so a re-record persists the same way. `onEncoded` fires the
         no-progress watchdog bump right after the long encode step, exactly
         where the inlined `bumpProgress()` used to sit. expectedSec carries the
         same char-derived QA estimate as before (srv-27). */
      const {
        audioQa,
        audioModelKey: renderedModelKey,
        audioEngines,
      } = await finalizeChapterAudioWrite({
        bookId,
        bookDir,
        chapter: { id: chapter.id, slug: chapter.slug, title: chapter.title },
        pcm: result.pcm,
        sampleRate: result.sampleRate,
        durationSec: result.durationSec,
        segments: result.segments,
        cast: cast.characters,
        defaultEngine: engine,
        modelKey,
        audioFormat,
        expectedSec: expectedSec ?? undefined,
        onEncoded: bumpProgress,
        embeddings: result.embeddings,
      });
      if (audioQa.status === 'suspect') {
        console.warn(
          `[generation] chapter ${chapter.id} (${chapter.slug}) flagged SUSPECT by audio QA: ` +
            audioQa.reasons.join(' '),
        );
      }

      /* srv-36 — trigger the render-integrity score pass for the whole book
         now that this chapter's embeddings are on disk. Passes the FULL
         state.chapters list (not `chapter` / `targetChapters`) so the
         centroid is built from all rendered chapters, not just the one that
         just finished. Single-flight + non-fatal (see afterChapterFinalized).
         NOT awaited (#1029): the score pass runs in the background so a slow
         audition-centroid render can't starve the no-progress watchdog and
         stall assembly. */
      afterChapterFinalized({
        bookId,
        bookDir,
        chapters: state.chapters.map((c) => ({ id: c.id, slug: c.slug })),
      });

      /* Chapter finished — clear the per-chapter tracking so a subscriber
         that arrives between this chapter and the next doesn't see a stale
         in-progress tick replayed against an already-done chapter. The
         audioModelKey rides along so the slice can stamp the chapter
         immediately without waiting for a state.json reload (otherwise
         an in-session engine switch wouldn't flag drift until the user
         navigates away and back).

         Only clear `currentChapterId` if it's still pointing at THIS
         chapter. On the back-compat `*` job a later chapter in the same
         sequential loop may have written its own id into the slot — clearing
         unconditionally would erase a still-valid in-progress marker. */
      if (job.currentChapterId === chapter.id) {
        job.currentChapterId = null;
        job.lastProgressTick = null;
      }
      /* Bug E: bump run-level aggregates BEFORE broadcast so the emitted
         tick carries the post-completion state. */
      job.runInProgress.delete(chapter.id);
      job.completedThisRun.add(chapter.id);

      /* RTF rollup. The sidecar logs per-batch compute rtf; this is the
         end-to-end pipeline figure (synth wall ÷ audio) the operator watches
         while a book renders, plus a rolling run average that also feeds the
         dev top-bar throughput pill (GET /api/generation/stats). */
      const synthSec = (Date.now() - synthStartMs) / 1000;
      const audioSec = result.durationSec;
      const chapterRtf = audioSec > 0 ? synthSec / audioSec : 0;
      const roll = recordChapterThroughput({
        chapterId: chapter.id,
        audioSec,
        synthMs: Date.now() - synthStartMs,
        title: chapter.title ?? null,
        bookId: job.bookId,
        modelKey,
      });
      console.info(
        `[generation] chapter ${chapter.id} "${chapter.title ?? ''}" rendered: ` +
          `lines=${totalLines} groups=${result.segments.length} ` +
          `audio=${audioSec.toFixed(1)}s synth=${synthSec.toFixed(1)}s ` +
          `rtf=${chapterRtf.toFixed(2)} (${(audioSec / Math.max(synthSec, 0.001)).toFixed(2)}x realtime); ` +
          `run: ${roll.chapters} ch, ${roll.rtf != null ? `rtf=${roll.rtf.toFixed(2)}` : 'rtf=–'}` +
          (roll.chaptersPerHour != null ? `, ${roll.chaptersPerHour.toFixed(1)} ch/hr` : ''),
      );

      /* fs-20 — per-run resource telemetry. FIRE-AND-FORGET: never await, never
         block the hot path. A best-effort sidecar /health probe (its own 2 s
         budget) supplies the VRAM + committed-host figures; a timeout / down
         sidecar just records nulls. */
      void (async () => {
        let vramReservedMb: number | null = null;
        let vramTotalMb: number | null = null;
        let committedHostMb: number | null = null;
        /* Only probe the sidecar for a sidecar-backed engine — a cloud engine
           (gemini) has no local model to report VRAM for, and probing it would
           touch the sidecar needlessly (side-11 boundary-recycle guard). */
        if (SIDECAR_ENGINES.has(engine)) {
          try {
            const health = await probeSidecarHealth();
            if (health.status === 'reachable') {
              vramReservedMb = health.vramReservedMb ?? null;
              vramTotalMb = health.vramTotalMb ?? null;
              committedHostMb = health.committedMb ?? null;
            }
          } catch {
            /* leave nulls — the probe is best-effort observability. */
          }
        }
        await appendTelemetry({
          at: new Date().toISOString(),
          bookId: job.bookId,
          bookTitle: state.title ?? null,
          chapterId: chapter.id,
          title: chapter.title ?? null,
          modelKey,
          rtf: audioSec > 0 ? chapterRtf : null,
          audioSec,
          wallSec: synthSec,
          vramReservedMb,
          vramTotalMb,
          committedHostMb,
        });
      })();

      broadcast(job, {
        type: 'chapter_complete',
        chapterId: chapter.id,
        characterId: null,
        progress: 1,
        currentLine: totalLines,
        totalLines,
        /* The engine the audio ACTUALLY rendered in (per-character routing,
           plan 108), not the request default — so a narrator-on-Qwen chapter
           regenerated under a Kokoro default doesn't flash a false Kokoro
           drift badge (false-drift fix, 2026-06-07). */
        audioModelKey: renderedModelKey,
        audioEngines,
        /* Belt-and-suspenders with the assembling tick (see line 616).
           The assembling tick is the primary carrier, but it can be missed
           when the page is hidden / the cross-book guard drops it / a
           parallel-chapter race coalesces ticks. Repeating
           durationSec on chapter_complete guarantees the chapter row in
           the Listen view shows the real audio length by the time the
           Done pill flips, even if assembling was lost on the wire. */
        durationSec: result.durationSec,
        /* srv-27 — advisory QA verdict so the frontend can stamp a "Suspect"
           badge the moment the Done pill flips, without a state.json reload. */
        audioQa,
      });

      /* srv-16 — server-authoritative completion. The chapter is rendered +
         persisted, so mark its queue entry done now rather than waiting for the
         frontend to POST /complete on stream close (which a crash / closed tab
         skips). Only for a genuine single-chapter queue job — the back-compat
         `*` walker (chapterId null) carries no per-chapter entry. */
      if (job.queueEntryId != null && job.chapterId === chapter.id) {
        void markQueueEntryDoneOnDisk(job.queueEntryId, chapter.id);
      }
      }; /* end renderBody */

      if (stallGuard) {
        stallTimer = setInterval(
          () => {
            if (Date.now() - lastProgressAt >= noProgressMs) {
              watchdogFired = true;
              chapterCtrl.abort(); // best-effort cancel of any abort-aware in-flight synth
              rejectStall?.(new ChapterStallError(noProgressMs, stallPhase));
            }
          },
          Math.min(noProgressMs, 15_000),
        );
        const body = renderBody(chapterCtrl.signal).catch((err) => {
          /* After the watchdog fires, the body's own AbortError (the expected
             downstream of our chapterCtrl.abort) is swallowed so stallGuard's
             ChapterStallError is the rejection the outer catch sees. */
          if (watchdogFired) return;
          throw err;
        });
        await Promise.race([body, stallGuard]);
      } else {
        await renderBody(chapterCtrl.signal);
      }
    } catch (e) {
      /* AbortError = our own controller fired (regen displacement or
         explicit /pause). Don't report it as a chapter failure — silently
         exit the worker; the outer `idle` + cleanup below handles the rest. */
      if ((e as { name?: string })?.name === 'AbortError') {
        /* Drop the in-flight marker before breaking — keeps cross-book
           runInProgress accurate if the abort race left us mid-chapter. */
        job.runInProgress.delete(chapter.id);
        return;
      }
      /* A ChapterStallError is the no-progress watchdog firing — record the
         clear stall message (non-fatal: a single stalled chapter fails and the
         queue advances; the cascade counter below still escalates if stalls
         repeat across chapters, which signals a systemic wedge). */
      const isStall = (e as { name?: string })?.name === 'ChapterStallError';
      /* C3 (Wave 3) — RecycleStormError: synthesiseChapter exhausted the in-loop
         recycle-recovery budget on a single chapter (the sidecar thrashed while
         rendering it). Short-circuit BEFORE describeSynthesisError so the named
         code/remediation ride through (the taxonomy entry would also classify it
         correctly, but the literal object keeps the wording owned here and avoids
         re-deriving it). Non-fatal per chapter. The run-stop is the queue PAUSE
         set below (on the queue path: one POST = one chapter, so the
         cross-chapter cascade can never escalate). The cascade still escalates
         only on the back-compat `*` job, which loops many chapters in one POST. */
      const isRecycleStorm = (e as { name?: string })?.name === 'RecycleStormError';
      const initial = isStall
        ? {
            errorReason: (e as Error).message,
            fatal: false,
            code: 'synth-timeout' as FailureCode,
            remediation:
              'Click Retry on this chapter. If it stalls repeatedly, restart the TTS sidecar to ' +
              'clear a wedged GPU state, then retry.',
          }
        : isRecycleStorm
          ? {
              errorReason: (e as Error).message,
              fatal: false,
              code: 'recycle-storm' as FailureCode,
              remediation:
                'Restart the TTS sidecar (clears a thrashing/leaking process) and/or lower ' +
                'generation concurrency, then Retry. If it persists, the host-memory leak ' +
                '(side-11) needs headroom.',
            }
          : describeSynthesisError(e, engine);
      let { errorReason, fatal } = initial;
      /* fs-19 — the structured code + remediation ride alongside the legacy
         reason on both the broadcast and the persisted state. Const (not part of
         the cascade re-write below, which only touches the human reason). */
      const { code: errorCode, remediation } = initial;
      if (isStall) {
        console.error(
          `[generation] chapter ${chapter.id} (${chapter.slug}) STALLED during ${stallPhase}: ` +
            `no progress for ${Math.round(noProgressMs / 1000)}s — recorded as failed so the queue advances.`,
        );
      } else if (isRecycleStorm) {
        const recoveries = (e as { recoveries?: number })?.recoveries ?? MAX_RECYCLE_RECOVERIES;
        console.error(
          `[generation] chapter ${chapter.id} (${chapter.slug}) RECYCLE STORM: sidecar recycled ` +
            `${recoveries}× on one chapter — recorded non-fatal. On the queue path the run is ` +
            `stopped by pausing the queue (below); the back-compat \`*\` job relies on the cascade.`,
        );
      } else {
        console.error(`[generation] chapter ${chapter.id} (${chapter.slug}) failed:`, e);
      }
      if (!fatal) {
        const cascadeResult = recordNonFatal(cascade, errorReason);
        if (cascadeResult.fatal) {
          fatal = true;
          errorReason = `${errorReason} (Stopping run — same failure repeated across chapters; fix the upstream cause before retrying.)`;
        }
      }
      /* Bug E: failed chapter is no longer in progress (audio not on
         disk so it doesn't count as done either — runDone stays put). */
      job.runInProgress.delete(chapter.id);
      broadcast(job, {
        type: 'chapter_failed',
        chapterId: chapter.id,
        errorReason,
        /* fs-19 — structured failure class + remediation so the frontend can
           render a concrete "what to do" line under the reason without parsing
           it. */
        errorCode,
        remediation,
      });
      /* Durably record the failure in state.json so the chapter survives a
         reload / queue-clear as "Failed · reason" instead of re-hydrating as
         the misleading "Queued" (no audio on disk → absent from
         completedSlugs). Mirrors the success-path read-modify-write above.
         Wrapped in try/catch so a persistence hiccup never masks the real
         synthesis failure the user needs to see. */
      try {
        const statePath = stateJsonPath(bookDir);
        const prev = await readJson<BookStateJson>(statePath);
        if (prev) {
          const next: BookStateJson = {
            ...prev,
            chapters: prev.chapters.map((c) =>
              c.id === chapter.id
                ? {
                    ...c,
                    generationState: 'failed',
                    generationError: errorReason,
                    /* fs-19 — persist the structured class + remediation so a
                       reloaded failed chapter re-hydrates with its "what to do"
                       line, not just the reason. */
                    generationErrorCode: errorCode,
                    generationRemediation: remediation,
                  }
                : c,
            ),
            updatedAt: new Date().toISOString(),
          };
          await writeJsonAtomic(statePath, stampStateSchema(next));
        }
      } catch (persistErr) {
        console.warn(
          `[generation] failed to persist error state for chapter ${chapter.id}:`,
          persistErr,
        );
      }
      /* C3 (Wave 3) — recycle storm on the QUEUE path: pause the queue so a
         thrashing sidecar stops the run instead of grinding chapter after
         chapter. The dispatcher fires ONE POST per chapter, so the cross-chapter
         cascade above (recordNonFatal) can never escalate on this path — this
         server-side pause is the faithful "stop the run". Runs AFTER the
         chapter_failed broadcast + state persist, so the failure surfaces
         regardless. fatal stays false (the queue-pause is the run-stop; flipping
         fatal would needlessly take the `*`-job controller.abort() path).
         BEST-EFFORT: a queue-write hiccup must never mask the real chapter
         failure, so this is wrapped + warns on error only. The back-compat `*`
         job (no queueEntryId) is untouched — it keeps relying on the cascade. */
      if (isRecycleStorm && job.queueEntryId != null) {
        try {
          const before = await readQueueFile(queueJsonPath());
          await writeQueueFile(queueJsonPath(), setPaused(before, true));
          console.error(
            '[generation] RECYCLE STORM: paused the queue — restart the TTS sidecar / ' +
              'restore headroom, then resume.',
          );
        } catch (pauseErr) {
          console.warn(
            `[generation] failed to pause the queue after a recycle storm on chapter ${chapter.id}:`,
            pauseErr,
          );
        }
      }
      if (fatal) {
        /* Back-compat `*` job only: set the flag AND abort the signal so the
           sequential loop stops at the next chapter. On a single-chapter job
           (the common queue path) there are no further chapters, so this is
           just a clean stop. Cross-chapter cascade no longer spans separate
           dispatcher POSTs — each chapter fails independently. */
        cascadeFatal = true;
        if (!controller.signal.aborted) controller.abort();
      }
    } finally {
      /* Tear down the no-progress watchdog + the parent-abort bridge on every
         exit path (success, failure, stall, pause) so neither leaks a timer or
         a listener across chapters. */
      if (stallTimer) clearInterval(stallTimer);
      controller.signal.removeEventListener('abort', onParentAbort);
    }
  };

  /* One queue worker = one chapter. The dispatcher fires a separate POST per
     chapter (chapterIds:[id], force:true), so the queue's N workers ARE the
     concurrency authority — N chapters run concurrently across all books,
     including sibling chapters of the same book. There is no within-book
     pool here any more; this job renders exactly its target(s).

     The common case is a single chapter. The back-compat path (no chapterIds
     or a multi-id caller) walks `targetChapters` sequentially under one job —
     no pool, no cross-book impact — purely so legacy / direct callers still
     get every requested chapter. Real GPU concurrency is bounded by the
     `gpuSemaphore` each `synthesize` acquires; the queue bounds how many
     chapter jobs exist at once. */
  for (const chapter of targetChapters) {
    if (controller.signal.aborted || cascadeFatal) break;
    await processOneChapter(chapter);
    /* side-11 item 2 — at this chapter boundary, if the sidecar has crossed the
       SOFT committed threshold, trigger a CLEAN recycle now (drain → respawn)
       instead of waiting for the hard watchdog to fire mid-chapter. Awaiting the
       POST guarantees the sidecar's 503 fence is up before this job's SSE closes,
       so the NEXT chapter's dispatcher POST only opens afterwards and its
       `ensureSidecarEngineReady` gate polls cleanly through the respawn. Sidecar
       engines only (cloud engines have nothing to recycle); skipped on abort. */
    if (!controller.signal.aborted && SIDECAR_ENGINES.has(engine)) {
      if (await getSidecarRecyclePending()) await triggerSidecarRecycle();
    }
  }

  deregisterJob(key, job);

  /* Broadcast idle + end every attached response (the starter + any
     subscribers that joined via page reload / mid-run open). After this
     point the job is dead; the next /generation POST sees no existing
     entry and starts a fresh run. */
  endAllSubscribers(job, { type: 'idle' });
});

/* POST /api/books/:bookId/generation/pause — explicit pause signal.
   Browser reload also closes the SSE, so we can't piggyback on that any
   more (see RunningJob comment block above). This endpoint is the single
   signal the route uses to stop a running job: middleware POSTs here on
   setPaused(true), the loop's AbortError catch fires, all subscribers
   get an `idle` tick and their responses end.

   Idempotent: returns 200 even when no job is running (treats it as a
   no-op so a double-click on Pause doesn't 404). */
generationRouter.post('/:bookId/generation/pause', (req: Request, res: Response) => {
  const { bookId } = req.params;
  /* Abort EVERY in-flight job for the book — with per-chapter jobs a book may
     have several concurrent chapters, and the local-analyzer halt needs the
     GPU freed for ALL of them, not just one. */
  const jobs = inFlightByBook.get(bookId);
  let aborted = false;
  if (jobs) {
    for (const job of jobs) {
      if (!job.controller.signal.aborted) {
        job.controller.abort();
        aborted = true;
      }
    }
  }
  res.status(200).json({ ok: true, paused: (jobs?.size ?? 0) > 0 || aborted });
});
