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

import { Router, type Request, type Response } from 'express';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  audioDir,
  castJsonPath,
  manuscriptEditsJsonPath,
  queueJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { readQueueFile, writeQueueFile } from '../workspace/queue-migrate.js';
import { completeEntry, markAwaitingConfirm, resetEntryToQueued } from '../workspace/queue-io.js';
import { computeQwenKokoroFallbackSet, type QwenFallbackChar } from '../tts/qwen-fallback-set.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { stampStateSchema } from '../workspace/state-migrate.js';
import { bookStateAudioFormat, findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { chapterAudioExists } from '../workspace/chapter-audio-file.js';
import { preserveExistingAsPrevious } from '../workspace/preserve-previous-audio.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { rebuildCacheFromEdits } from '../store/analysis-cache-rebuild.js';
import {
  engineForModelKey,
  isTtsModelKey,
  selectTtsProvider,
  type TtsEngine,
  type TtsModelKey,
  type TtsProvider,
} from '../tts/index.js';
import { resolveCharacterEngine } from '../tts/per-character-engine.js';
import { pickVoiceForEngine } from '../tts/voice-mapping.js';
import { getCachedUserSettings, getLastKnownQwenInstallState } from '../workspace/user-settings.js';
import {
  audioExtForFormat,
  encodePcmToAudio,
  writeChapterLufsFile,
  writeChapterPeaksFile,
} from '../tts/mp3.js';
import { DEFAULT_LOUDNORM_OPTIONS, type LoudnormOptions } from '../tts/loudnorm.js';
import { formatDuration } from '../audio/format-duration.js';
import {
  synthesiseChapter,
  toVoiceLike,
  buildHintFromCast,
  type CastCharacter,
  type ChapterSegment,
} from '../tts/synthesise-chapter.js';
import { hydrateCastReusedVoices } from '../tts/hydrate-reused-voice-workspace.js';
import { buildChapterTitleNarration } from '../tts/chapter-title-narration.js';
import { recordBatchThroughput, recordChapterThroughput } from '../tts/generation-stats.js';
import { ensureSidecarEngineReady } from '../tts/ensure-sidecar-loaded.js';
import { isTransient } from '../tts/retry.js';
import { describeSynthesisError, newCascadeState, recordNonFatal } from './generation-error.js';

export const generationRouter = Router();

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

/* Snapshot of a character's voice-relevant attributes captured at the
   moment a chapter is synthesised. The revisions route diffs this against
   the live cast.json to surface drift events ("voice swapped after this
   chapter rendered", "tone.warmth drifted 30 points", etc.). Kept narrow
   on purpose — only fields the drift detector reads. */
interface CharacterSnapshot {
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  voiceId?: string;
  voiceEngine?: string;
  /** The voice NAME actually used at synthesis time — the resolved output of
      `pickVoiceForEngine(charEngine, …)` (plan 108). Unlike `voiceId` (the
      library id, which doesn't change when only a per-engine override flips),
      this captures the real voice so the drift detector can catch an
      override-only change. Optional: segments written before plan 108 have no
      value → the detector treats it as "no signal" and falls back to voiceId. */
  resolvedVoiceName?: string;
  /** Engine this character ACTUALLY rendered in when it differs from its
      configured engine — `'kokoro'` when a Qwen character fell back (no
      designed voice, or Qwen unavailable). Undefined = rendered in its
      configured engine. Drives the "Fallback (Kokoro)" cast status. */
  renderedFallbackEngine?: string;
  /** Attribute list captured at synthesis time. The drift detector
      compares this against the current cast's attributes — a non-empty
      symmetric difference fires a drift event because attributes drive
      prebuilt-voice selection in tts-voice-mapping.ts. Sorted so the
      snapshot is stable across runs even when the analyzer emits the
      same set in different orders. */
  attributes?: string[];
}

interface ChapterSegmentsFile {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  durationSec: number;
  sampleRate: number;
  modelKey: TtsModelKey;
  synthesizedAt: string;
  segments: ChapterSegment[];
  /** Snapshot of cast character attributes at synthesis time, keyed by
      characterId. Used by /api/books/:bookId/revisions to detect drift
      between the current cast and what was actually rendered. Optional
      because pre-existing segments files written before this field landed
      have no snapshots; the revisions route treats them as "no signal". */
  characterSnapshots?: Record<string, CharacterSnapshot>;
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

  /* Per-character engine routing (plan 108). Engine is no longer one global
     choice: a character may carry its own `ttsEngine` (narrator on Kokoro, a
     bespoke character on Qwen, …). Build a per-engine provider cache — the
     default engine reuses the request's provider/modelKey — so
     `synthesiseChapter` routes each character to its own engine's provider
     without reconstructing it per group. */
  const canonicalModelKeyForEngine = (e: TtsEngine): TtsModelKey => {
    switch (e) {
      case 'kokoro':
        return 'kokoro-v1';
      case 'qwen':
        return 'qwen3-tts-0.6b';
      case 'coqui':
        return 'coqui-xtts-v2';
      case 'piper':
        return 'piper-en-us-medium';
      case 'gemini':
        return modelKey.startsWith('gemini-') ? modelKey : 'gemini-2.5-flash';
    }
  };
  const providerCache = new Map<TtsEngine, { provider: TtsProvider; modelKey: TtsModelKey }>();
  providerCache.set(engine, { provider, modelKey });
  const resolveForEngine = (e: TtsEngine): { provider: TtsProvider; modelKey: TtsModelKey } => {
    const cached = providerCache.get(e);
    if (cached) return cached;
    const mk = canonicalModelKeyForEngine(e);
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
    const initialTick = {
      chapterId: chapter.id,
      characterId: null,
      progress: 0.01,
      currentLine: 0,
      totalLines,
    };
    job.lastProgressTick = initialTick;
    broadcast(job, { type: 'progress', ...initialTick });

    try {
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
      await ensureSidecarEngineReady(engine, controller.signal);
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
        await ensureSidecarEngineReady('kokoro', controller.signal);
      }
      /* Wall around the synth phase only (all TTS — title beat + body groups;
         encode/disk happens after and is excluded) — drives the RTF rollup +
         the dev top-bar throughput pill. */
      const synthStartMs = Date.now();
      /* srv-17c recovery loop (see MAX_RECYCLE_RECOVERIES). Wraps ONLY the synth
         call: on a transient sidecar-down (recycle/respawn/crash, or a drain-503)
         we wait out the respawn on the readiness gate and re-render. AbortError
         and non-transient / poison errors re-throw to the outer catch unchanged. */
      let result: Awaited<ReturnType<typeof synthesiseChapter>>;
      for (let recovery = 0; ; recovery += 1) {
        try {
          result = await synthesiseChapter({
        sentences,
        cast: cast.characters,
        provider,
        modelKey,
        engine,
        resolveForEngine,
        qwenUnavailable,
        signal: controller.signal,
        chapterTitleNarration,
        narratorCharacterId: 'narrator',
        /* Title-beat ticks so the SSE stream doesn't go silent while the
           pre-body title synth runs (Coqui can take a couple of seconds for
           a short phrase, the stall detector fires at 30 s). currentLine: 0
           keeps the UI's "line N of M" caption at the pre-body state. */
        onTitleStart: () => {
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
        /* Live per-batch RTF (plan 127). Each completed Qwen batch feeds the
           rolling live-batch window so the dev pill shows throughput that moves
           mid-chapter, not just the per-chapter rollup below. */
        onBatchComplete: ({ genMs, audioMs }) => {
          recordBatchThroughput({ genMs, audioMs });
        },
          });
          break;
        } catch (synthErr) {
          /* Recoverable only while the run is live and the budget remains. Two
             recoverable shapes:
               1. a transient sidecar-down (connection drop on recycle/crash, or
                  a drain-503), and
               2. a ChapterSynthTimeoutError — a synth that HUNG past the per-call
                  ceiling. Under a host-RAM recycle the respawned sidecar can be
                  HTTP-up but still loading the model in-band, so the in-flight
                  call stalls to the timeout instead of failing fast. That timeout
                  is non-transient by construction, so without this it bubbles to
                  the outer catch and stops the run (2026-05-31 the Hollow Tide CH24). Ride
                  it out the same way: wait on the readiness gate, then re-render
                  against a sidecar that is actually ready.
             AbortError, poison, and every other fatal classifier error re-throw
             to the outer catch unchanged. */
          const isRecycleTimeout =
            (synthErr as { name?: string })?.name === 'ChapterSynthTimeoutError';
          if (
            (synthErr as { name?: string })?.name === 'AbortError' ||
            (!isTransient(synthErr) && !isRecycleTimeout) ||
            controller.signal.aborted ||
            recovery >= MAX_RECYCLE_RECOVERIES
          ) {
            throw synthErr;
          }
          console.warn(
            `[generation] chapter ${chapter.id} (${chapter.slug}): ${
              isRecycleTimeout
                ? 'synth stalled (likely a mid-render recycle)'
                : 'sidecar unavailable mid-synth (recycle/respawn)'
            } — riding out the respawn, re-attempt ${recovery + 1}/${MAX_RECYCLE_RECOVERIES}.`,
          );
          /* Polls through the supervisor respawn (srv-17b, 120 s budget); throws
             AbortError if the run is paused/displaced mid-wait. */
          await ensureSidecarEngineReady(engine, controller.signal);
        }
      }

      /* All per-group synthesis is done; the next stretch is disk-write
         work (encode MP3 → temp file → segments JSON → atomic rename →
         state.json update). Tell the client so it stops looking like a
         frozen 99 %. */
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
         written before the field landed. Drives both the codec dispatch
         in `encodePcmToAudio` (below) and the file extension that lands
         on disk. */
      const audioFormat = bookStateAudioFormat(state);
      const audioExt = audioExtForFormat(audioFormat);
      const audioPath = join(audioRoot, `${chapter.slug}.${audioExt}`);
      const segPath = join(audioRoot, `${chapter.slug}.segments.json`);
      const peaksPath = join(audioRoot, `${chapter.slug}.peaks.json`);
      const lufsPath = join(audioRoot, `${chapter.slug}.lufs.json`);

      /* EBU R128 loudness normalisation (plan 71). Default ON; opt out
         with AUDIO_LOUDNORM_ENABLED=false. The two-pass measure-then-apply
         flow runs inside encodePcmToAudio; the onLoudnessMeasured callback
         writes the sidecar JSON atomically next to the MP3. */
      const loudnorm: LoudnormOptions | undefined =
        process.env.AUDIO_LOUDNORM_ENABLED === 'false' ? undefined : DEFAULT_LOUDNORM_OPTIONS;
      const audioBuffer = await encodePcmToAudio(result.pcm, result.sampleRate, {
        format: audioFormat,
        quality: 2,
        loudnorm,
        onLoudnessMeasured: async (stats) => {
          try {
            await writeChapterLufsFile(stats, lufsPath);
          } catch (err) {
            /* Non-fatal — playback works without the sidecar; Wave 2's
               report-card UI degrades to "no data" gracefully. Log + carry on. */

            console.warn(
              `[generation] failed to write loudness sidecar for ${chapter.slug}: ${
                (err as Error).message
              }`,
            );
          }
        },
      });

      /* Atomic write: temp-then-rename so a crash mid-write doesn't leave a
         half-encoded file that scan.ts would mistake for a completed
         chapter. Per-chapter slug + pid + ts in the temp name means
         concurrent chapter writes (sibling chapter jobs of the same book,
         now separate dispatcher POSTs) never collide on the same temp
         path. */
      const tmpAudio = `${audioPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpAudio, audioBuffer);
      /* Snapshot the cast character attributes for every character that
         actually spoke in this chapter — narrows the snapshot to the
         characters the drift detector cares about and avoids bloating the
         segments file with the full cast on tiny chapters. */
      const speakingIds = new Set(result.segments.map((s) => s.characterId));
      /* Which characters actually fell back to Kokoro this render (any segment
         of theirs stamped renderedFallbackEngine) — surfaced on the snapshot so
         the cast/listen UI can show "Fallback (Kokoro)". */
      const fallbackByChar = new Map<string, string>();
      for (const s of result.segments) {
        if (s.renderedFallbackEngine) fallbackByChar.set(s.characterId, s.renderedFallbackEngine);
      }
      const characterSnapshots: Record<string, CharacterSnapshot> = {};
      for (const c of cast.characters) {
        if (!speakingIds.has(c.id)) continue;
        /* Per-character engine + the voice NAME actually rendered (plan 108).
           voiceEngine was the global run engine before; now it's this
           character's resolved engine. resolvedVoiceName captures the real
           pickVoiceForEngine output so the drift detector can catch an
           override-only change (same voiceId, different override) — see the
           revisions.ts comparison added in Wave 4. */
        const charEngine = resolveCharacterEngine(c, engine);
        const resolvedVoiceName = pickVoiceForEngine(
          charEngine,
          toVoiceLike(c),
          buildHintFromCast(c),
        );
        characterSnapshots[c.id] = {
          tone: c.tone,
          gender: c.gender,
          ageRange: c.ageRange,
          voiceId: c.voiceId,
          voiceEngine: charEngine,
          resolvedVoiceName: resolvedVoiceName || undefined,
          renderedFallbackEngine: fallbackByChar.get(c.id),
          /* Sorted for stable comparison — the analyzer's attribute order
             isn't deterministic across runs, so without the sort an
             order-only change would look like drift to the detector. */
          attributes:
            Array.isArray(c.attributes) && c.attributes.length
              ? [...c.attributes].sort((a, b) => a.localeCompare(b))
              : undefined,
        };
      }

      const segmentsFile: ChapterSegmentsFile = {
        bookId,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        durationSec: result.durationSec,
        sampleRate: result.sampleRate,
        modelKey,
        synthesizedAt: new Date().toISOString(),
        segments: result.segments,
        characterSnapshots,
      };
      /* Rollback preservation: rename the live `<slug>.mp3` +
         `.segments.json` to `.previous.*` BEFORE the new render lands.
         First renders no-op (nothing to preserve). The revision-diff
         player auditions the preserved pair (A) vs the new render (B);
         accept deletes `.previous.*`, reject restores them over current.
         Best-effort — never blocks the write. */
      await preserveExistingAsPrevious(audioRoot, chapter.slug);
      await writeJsonAtomic(segPath, segmentsFile);
      await rename(tmpAudio, audioPath);
      /* Plan 56: emit the waveform-envelope sibling alongside the MP3.
         Failure is non-fatal — peaks are a visualization aid, not load-
         bearing for playback — so we log + continue rather than abort the
         render. The chapter-audio meta endpoint's missing-file fallback
         returns `peaks: []` and the Listen view degrades gracefully. */
      try {
        await writeChapterPeaksFile(result.pcm, result.sampleRate, peaksPath);
      } catch (err) {
        console.warn(
          `[generation] failed to write peaks for ${chapter.slug}: ${(err as Error).message}`,
        );
      }

      /* Update state.json with the freshly-measured duration so the library
         + future playback slice can render it without re-reading the audio.
         Also stamp the TTS model key + render timestamp so the frontend
         can surface engine-drift badges without reading every segments
         file on chapter-list hydrate (see docs/features/archive/35-engine-drift-detection.md).

         With sibling chapters of the same book completing in parallel
         (separate dispatcher POSTs now), two handlers can race to
         read-modify-write state.json. read+write are not atomic — the
         second writer's read picks up the first writer's on-disk record
         (the rename is atomic), so each chapter's duration / audioModelKey
         lands eventually. The race window is narrow (sub-second between read
         and writeJsonAtomic on local SSD) and the only contested field is
         `chapters[i].duration` / `audioModelKey` / `audioRenderedAt` — both
         keyed by chapter id, so siblings cannot clobber each other's data.
         The risk is `updatedAt` carrying a slightly stale timestamp when
         reads interleave, which the scan layer tolerates. */
      const statePath = stateJsonPath(bookDir);
      const prev = await readJson<BookStateJson>(statePath);
      if (prev) {
        const formatted = formatDuration(result.durationSec);
        const next: BookStateJson = {
          ...prev,
          chapters: prev.chapters.map((c) =>
            c.id === chapter.id
              ? {
                  ...c,
                  duration: formatted,
                  audioModelKey: modelKey,
                  audioRenderedAt: segmentsFile.synthesizedAt,
                  /* A successful render clears any stale persisted failure so
                     the chapter no longer hydrates as "Failed" after reload. */
                  generationState: undefined,
                  generationError: undefined,
                }
              : c,
          ),
          updatedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(statePath, stampStateSchema(next));
      }

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

      broadcast(job, {
        type: 'chapter_complete',
        chapterId: chapter.id,
        characterId: null,
        progress: 1,
        currentLine: totalLines,
        totalLines,
        audioModelKey: modelKey,
        /* Belt-and-suspenders with the assembling tick (see line 616).
           The assembling tick is the primary carrier, but it can be missed
           when the page is hidden / the cross-book guard drops it / a
           parallel-chapter race coalesces ticks. Repeating
           durationSec on chapter_complete guarantees the chapter row in
           the Listen view shows the real audio length by the time the
           Done pill flips, even if assembling was lost on the wire. */
        durationSec: result.durationSec,
      });

      /* srv-16 — server-authoritative completion. The chapter is rendered +
         persisted, so mark its queue entry done now rather than waiting for the
         frontend to POST /complete on stream close (which a crash / closed tab
         skips). Only for a genuine single-chapter queue job — the back-compat
         `*` walker (chapterId null) carries no per-chapter entry. */
      if (job.queueEntryId != null && job.chapterId === chapter.id) {
        void markQueueEntryDoneOnDisk(job.queueEntryId, chapter.id);
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
      const initial = describeSynthesisError(e, engine);
      let { errorReason, fatal } = initial;
      console.error(`[generation] chapter ${chapter.id} (${chapter.slug}) failed:`, e);
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
                ? { ...c, generationState: 'failed', generationError: errorReason }
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
      if (fatal) {
        /* Back-compat `*` job only: set the flag AND abort the signal so the
           sequential loop stops at the next chapter. On a single-chapter job
           (the common queue path) there are no further chapters, so this is
           just a clean stop. Cross-chapter cascade no longer spans separate
           dispatcher POSTs — each chapter fails independently. */
        cascadeFatal = true;
        if (!controller.signal.aborted) controller.abort();
      }
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
