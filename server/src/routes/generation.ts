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
  stateJsonPath,
} from '../workspace/paths.js';
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
  type TtsModelKey,
} from '../tts/index.js';
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
  type CastCharacter,
  type ChapterSegment,
} from '../tts/synthesise-chapter.js';
import { buildChapterTitleNarration } from '../tts/chapter-title-narration.js';
import { describeSynthesisError, newCascadeState, recordNonFatal } from './generation-error.js';

export const generationRouter = Router();

/* Per-bookId job tracker. Each entry is a RunningJob: one AbortController +
   a Set of currently-attached SSE subscribers. Designed so the server-side
   work outlives any single client connection — a browser reload closes the
   client's SSE but the job keeps generating, and the post-reload client
   re-subscribes to receive subsequent ticks. The audio that's already on
   disk shows up in the catch-up replay every new subscriber gets at attach
   time, so a user who reloads mid-run sees both the completed chapters
   AND the live progression of the in-flight one.

   Pause semantics live on POST /pause now, not on SSE close. SSE close
   only unsubscribes the closing observer; the job keeps running until
   either (a) the queue drains, (b) /pause is called, or (c) a regen POST
   (chapterIds + force) displaces the job. */
interface Subscriber {
  send: (ev: unknown) => void;
  res: Response;
}

interface RunningJob {
  controller: AbortController;
  subscribers: Set<Subscriber>;
  bookId: string;
  /** Plan 102 — workspace queue entry id this job is processing. Carried
      back on every broadcast tick (including `resume_from`) so the
      frontend dispatcher can correlate ticks to the right queue row even
      when entries from different books interleave. Null when this job
      started outside the queue surface (legacy callers; back-compat). */
  queueEntryId: string | null;
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

const inFlightByBook: Map<string, RunningJob> = new Map();

/** True when a generation job is currently in flight for the book. Exposed
    so sibling routes can refuse operations that would race the write path
    (chapter-audio reject restore would clobber a mid-render file). */
export function isGenerationActive(bookId: string): boolean {
  return inFlightByBook.has(bookId);
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
  const existingForResume = inFlightByBook.get(bookId);
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

  /* Two dispatch modes for this POST:
       - "Subscribe": no chapterIds + no force, AND a non-aborted job is
         already running for this book. The connection joins the existing
         job's subscriber set; the loop is NOT re-entered. The catch-up
         replay above has already snapped this client to the current
         on-disk state, so subsequent broadcast ticks bring it the rest.
         Browser-reload survival lives here — the page-reload's new POST
         lands in this branch and the original run keeps generating
         untouched.
       - "Start / displace": chapterIds + force (regen) OR no existing
         job. We abort any existing job (regen explicitly wants a fresh
         run with the new spec; a duplicate Resume against a still-live
         job is benign because the existing branch handles that). The
         loop runs in this request's lexical scope.
     Pause used to piggyback on SSE close; it doesn't any more — see the
     dedicated POST /pause endpoint below. SSE close ONLY unsubscribes
     this observer now; the job carries on for other observers (or for
     no observers at all). */
  const isDisplacing = (requestedIds !== null && requestedIds.length > 0) || force;
  const existing = inFlightByBook.get(bookId);
  if (existing && !existing.controller.signal.aborted && !isDisplacing) {
    const subscriber: Subscriber = { send, res };
    existing.subscribers.add(subscriber);
    req.on('close', () => existing.subscribers.delete(subscriber));
    /* Replay the in-flight chapter's last known tick so a post-reload UI
       immediately flips that chapter to in_progress instead of staring at
       a stale "queued" until the next group boundary lands (which on a
       long narrator block can be 30+ s away). Without this the user sees
       the in-progress chapter look "gone" for a beat after reload, which
       was the visible symptom that prompted this fix. */
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
    /* Keep `res` open. The job's loop will end this response via
       endAllSubscribers() when it drains or is paused. */
    return;
  }

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
    queueEntryId,
    currentChapterId: null,
    lastProgressTick: null,
    runTotal: nonExcluded.length,
    runDoneBase,
    completedThisRun: new Set(),
    runInProgress: new Set(),
  };
  inFlightByBook.set(bookId, job);

  /* SSE close on the starter connection is just an unsubscribe — the job
     keeps running for any other observers. If the starter was the only
     subscriber, the loop generates audio to disk silently; the next
     subscriber to attach picks up via the catch-up replay. */
  req.on('close', () => {
    for (const sub of job.subscribers) {
      if (sub.res === res) {
        job.subscribers.delete(sub);
        break;
      }
    }
  });

  /* Cascade detector — if the same non-fatal reason fails two chapters in
     a row, the failure is deterministic (e.g. sidecar mis-routing every
     character to an invalid speaker_id) and the rest of the queue will hit
     the same wall. Escalate to fatal on the second hit so the user gets one
     clean banner instead of a long stream of identical chapter_failed
     ticks. See screenshot 2026-05-13 181647 for the cascade we're killing.

     Plan 87: the cascade state is shared across the worker pool. With K>1
     the next-failure-classified-as-fatal still aborts the controller, which
     short-circuits the remaining queued chapters and lets the in-flight
     siblings finish (or be aborted via the same signal — synthesiseChapter
     forwards it into the sidecar fetch). */
  const cascade = newCascadeState();

  /* Plan 87 — fatal escalation flag. Workers check this between chapters so
     a parallel cascade fires the abort exactly once and the remaining queue
     drains cleanly. The signal-abort path handles in-flight siblings; this
     flag stops a worker from picking up a fresh chapter after the cascade
     has been detected. */
  let cascadeFatal = false;

  /* Plan 87 — process a single chapter end-to-end (the body that used to
     live inline in the for…await loop). Kept identical to the serial
     behaviour byte-for-byte; the only call-site change is that multiple
     of these may now run concurrently inside the worker pool below.

     Per-chapter watchdog: each invocation has its own independent
     `synthesiseChapter` call with its own `onGroupStart` heartbeat, so a
     stalled chapter no longer blocks siblings. The shared `controller.signal`
     still threads through every call — pause or regen displacement aborts
     all in-flight chapters at once, matching the K=1 contract. */
  const processOneChapter = async (chapter: (typeof targetChapters)[number]): Promise<void> => {
    if (controller.signal.aborted) return;
    if (cascadeFatal) return;

    /* Pin this chapter as in-flight on the job so the subscribe-side
       catch-up replay has something to emit for a post-reload client.
       Cleared on chapter_complete / chapter_failed / abort.

       Plan 87: with K>1, multiple chapters may be in flight concurrently.
       `currentChapterId` / `lastProgressTick` track the most-recent
       in-flight chapter — the catch-up replay only needs *something*
       in-progress to render, and a tick from the most-recent chapter is
       as good as any other. Per-chapter resume granularity comes from
       the `runInProgress` set, which the broadcast() enricher reads. */
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
      const result = await synthesiseChapter({
        sentences,
        cast: cast.characters,
        provider,
        modelKey,
        engine,
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

           Plan 87: each chapter's onGroupStart fires independently — a
           stalled sibling chapter doesn't suppress this chapter's
           heartbeat because they're separate `synthesiseChapter` calls. */
        onGroupStart: ({ group, totalGroups }) => {
          const firstSentenceId = group.sentenceIds[0];
          const positional = sentences.findIndex((s) => s.id === firstSentenceId);
          /* progress reports the lower bound for this group — group.index/totalGroups
             rather than (index+1)/total — so the bar doesn't visibly snap forward
             at start and then sit still while the call runs. */
          const progress = Math.min(0.99, group.index / Math.max(1, totalGroups));
          const tick = {
            chapterId: chapter.id,
            characterId: group.characterId,
            progress,
            currentLine: positional >= 0 ? positional + 1 : group.index + 1,
            totalLines,
          };
          job.lastProgressTick = tick;
          broadcast(job, { type: 'progress', ...tick });
        },
        onGroupComplete: ({ group, totalGroups }) => {
          const progress = Math.min(0.99, (group.index + 1) / totalGroups);
          const lastSentenceId = group.sentenceIds[group.sentenceIds.length - 1];
          /* currentLine is positional; clamp to sentences.length so the UI's
             "line N of M" reads naturally even when sentence ids aren't 1..N. */
          const positional = sentences.findIndex((s) => s.id === lastSentenceId);
          const tick = {
            chapterId: chapter.id,
            characterId: group.characterId,
            progress,
            currentLine: positional >= 0 ? positional + 1 : group.index + 1,
            totalLines,
          };
          job.lastProgressTick = tick;
          broadcast(job, { type: 'progress', ...tick });
        },
      });

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
         concurrent chapter writes (plan 87) never collide on the same
         temp path. */
      const tmpAudio = `${audioPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpAudio, audioBuffer);
      /* Snapshot the cast character attributes for every character that
         actually spoke in this chapter — narrows the snapshot to the
         characters the drift detector cares about and avoids bloating the
         segments file with the full cast on tiny chapters. */
      const speakingIds = new Set(result.segments.map((s) => s.characterId));
      const characterSnapshots: Record<string, CharacterSnapshot> = {};
      for (const c of cast.characters) {
        if (!speakingIds.has(c.id)) continue;
        characterSnapshots[c.id] = {
          tone: c.tone,
          gender: c.gender,
          ageRange: c.ageRange,
          voiceId: c.voiceId,
          voiceEngine: engine,
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
         file on chapter-list hydrate (see docs/features/35-engine-drift).

         Plan 87: with K>1 chapters completing in parallel, two workers
         can race to read-modify-write state.json. read+write are not
         atomic — the second writer's read picks up the first writer's
         on-disk record (the rename is atomic), so each chapter's
         duration / audioModelKey lands eventually. The race window is
         narrow (sub-second between read and writeJsonAtomic on local
         SSD) and the only contested field is `chapters[i].duration` /
         `audioModelKey` / `audioRenderedAt` — both keyed by chapter id,
         so siblings cannot clobber each other's data. The risk is
         `updatedAt` carrying a slightly stale timestamp when reads
         interleave, which the scan layer tolerates. */
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

         Plan 87: only clear `currentChapterId` if it's still pointing at
         THIS chapter. With K>1 a sibling chapter that started after us
         may have written its own id into the slot — clearing
         unconditionally would erase a still-valid in-progress marker. */
      if (job.currentChapterId === chapter.id) {
        job.currentChapterId = null;
        job.lastProgressTick = null;
      }
      /* Bug E: bump run-level aggregates BEFORE broadcast so the emitted
         tick carries the post-completion state. */
      job.runInProgress.delete(chapter.id);
      job.completedThisRun.add(chapter.id);
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
           plan-87 parallel-chapter race coalesces ticks. Repeating
           durationSec on chapter_complete guarantees the chapter row in
           the Listen view shows the real audio length by the time the
           Done pill flips, even if assembling was lost on the wire. */
        durationSec: result.durationSec,
      });
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
      const initial = describeSynthesisError(e);
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
      if (fatal) {
        /* Plan 87: with K>1, set the flag AND abort the shared signal so
           in-flight siblings exit and pending workers short-circuit. K=1
           behaviour stays byte-identical (signal abort is a no-op when
           nothing else is in flight). */
        cascadeFatal = true;
        if (!controller.signal.aborted) controller.abort();
      }
    }
  };

  /* Plan 87 — bounded worker pool. Replaces the original `for…await
     synthesiseChapter` loop at this site with K concurrent workers that
     pull from a shared index. K=1 reproduces the serial loop byte-for-byte
     (one worker, sequential pulls, same processOneChapter body), so
     setting `GEN_CHAPTER_CONCURRENCY=1` is the safety valve.

     Why an index-pulling pool rather than `Promise.all(map(...))`:
     - Bounds the concurrency without spinning up N pending promises.
     - Each worker picks the next available chapter from a shared cursor,
       so a fast chapter doesn't block on a slow sibling.
     - Natural respect for the cascade-fatal flag: each worker checks the
       flag at the top of its loop and bails out cleanly.

     The sidecar `/synthesize` route is already concurrent (asyncio.to_thread
     offload, GIL-releasing inference — pinned by
     server/tts-sidecar/tests/test_concurrent_synthesis.py:214-244). Kokoro
     v1 is ~1 GB resident and two concurrent inferences fit on an 8 GB GPU
     without eviction; that's the documented default. */
  const concurrencyEnv = process.env.GEN_CHAPTER_CONCURRENCY;
  const parsedConcurrency = concurrencyEnv ? Number.parseInt(concurrencyEnv, 10) : NaN;
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1 ? parsedConcurrency : 2;
  const effectiveConcurrency = Math.min(concurrency, targetChapters.length || 1);

  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  for (let workerId = 0; workerId < effectiveConcurrency; workerId++) {
    workers.push(
      (async () => {
        while (true) {
          if (controller.signal.aborted || cascadeFatal) return;
          const i = nextIndex++;
          if (i >= targetChapters.length) return;
          const chapter = targetChapters[i];
          await processOneChapter(chapter);
        }
      })(),
    );
  }
  await Promise.all(workers);

  /* Only deregister if we're still the current job — a newer regen may have
     already displaced us, and removing its entry would defeat the dispatcher
     for a third caller. */
  if (inFlightByBook.get(bookId) === job) {
    inFlightByBook.delete(bookId);
  }

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
  const job = inFlightByBook.get(bookId);
  if (job && !job.controller.signal.aborted) {
    job.controller.abort();
  }
  res.status(200).json({ ok: true, paused: job != null });
});
