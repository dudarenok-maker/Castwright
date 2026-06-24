/* "Design full cast" bulk-design job — server-owned, SSE-streamed.

   POST /api/books/:bookId/cast/design        — start a job (with characterIds)
                                                 OR re-subscribe to an in-flight
                                                 one (bare body, no list).
   GET  /api/books/:bookId/cast/design/status — is a job live? (cold-boot probe)
   POST /api/books/:bookId/cast/design/pause   — cancel the book's job.

   One in-memory job per book (`inFlightByBook`). It KEEPS RUNNING when its last
   SSE subscriber disconnects (unlike generation's orphan-abort) so a browser
   reload can re-attach via the bare POST and resume the pill — that's the
   reload-resilience the third status pill promises. Each designed voice is
   persisted to cast.json the instant it completes (idempotent), so a server
   restart loses only the live pill, never work: re-clicking finishes the rest.

   The per-character work reuses the EXACT single-design path:
     - `generateVoiceStylePersona` (Gemini) when the character has no persona,
     - `designQwenVoiceForCharacter` (sidecar design + audition cache, serialized
       per-book + GPU-fair via the shared design lock + semaphore),
     - `applyOverrideToCastFiles` to persist the override the way the drawer does
       (series scope for a series book, workspace scope for a standalone — which
       still writes the current book; the series filter would skip standalones).

   Concurrency hardening (targeted):
     - freshness-skip: re-read each character first; skip if it already has a
       Qwen voice (designed meanwhile, or a linked duplicate already got it),
     - mutual exclusion: refuse to start while an analysis run is live for the
       book (re-analysis rewrites the whole cast), and the single-design route
       refuses while THIS job is live (shared `design-lock` busy registry).

   Pairs with docs/features/NNN-design-full-cast.md. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { sidecarLanguageName } from '../tts/language.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import type { Emotion } from '../handoff/schemas.js';
import { VARIANT_EMOTIONS, designQwenVoiceForCharacter, persistEmotionVariant, ensureCharacterVoiceUuid } from './qwen-voice.js';
import { applyOverrideToCastFiles } from './voices.js';
import { resolvePersonaEngine, generateVoiceStylePersona } from '../analyzer/voice-style.js';
import { LocalUnreachableError } from '../analyzer/ollama.js';
import { preparePersonaBatch } from '../tts/persona-gpu-plan.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { markDesignBusy, clearDesignBusy, isAnalysisBusy, isDesignBusy } from '../tts/design-lock.js';
import { ensureSidecarEngineReady } from '../tts/ensure-sidecar-loaded.js';

type DesignScope = 'bases' | 'variants' | 'both';
interface VariantTask {
  characterId: string;
  emotions: Exclude<Emotion, 'neutral'>[];
}
/** One unit of work for the serial loop: a base voice (no emotion) or a variant. */
interface DesignTask {
  characterId: string;
  emotion?: Exclude<Emotion, 'neutral'>;
}

/** bases → base task per id; variants → one task per (char, emotion); both →
    for each character, its base (if requested) then its variant emotions, so a
    just-designed base is in place before its variants run. */
function buildTaskList(
  scope: DesignScope,
  characterIds: string[],
  variantTasks: VariantTask[],
): DesignTask[] {
  if (scope === 'bases') return characterIds.map((id) => ({ characterId: id }));
  if (scope === 'variants')
    return variantTasks.flatMap((t) => t.emotions.map((e) => ({ characterId: t.characterId, emotion: e })));
  const variantsById = new Map(variantTasks.map((t) => [t.characterId, t.emotions]));
  const ids = [...new Set([...characterIds, ...variantTasks.map((t) => t.characterId)])];
  const out: DesignTask[] = [];
  for (const id of ids) {
    if (characterIds.includes(id)) out.push({ characterId: id });
    for (const e of variantsById.get(id) ?? []) out.push({ characterId: id, emotion: e });
  }
  return out;
}

export const castDesignRouter = Router();

/* A back-to-back bulk run is statistically guaranteed to eventually hit a
   sidecar recycle (the committed/VRAM ceiling self-exit + supervisor respawn).
   When that lands mid-design the in-flight call fails with an "unreachable"-class
   error; rather than halt the whole job (the old behaviour — every remaining
   character would then fail identically), we wait for the respawn and RETRY the
   same character. Bounded so a genuinely-dead sidecar still stops the run
   instead of grinding forever. */
export const MAX_RECYCLE_RIDEOUTS = 2;

/* The error-message shapes that mean "the sidecar is down / recycling" (vs. a
   per-character synthesis failure that should be recorded and skipped past). */
const SIDECAR_DOWN_RE = /unreachable|did not complete within|stopped responding/i;

interface CastFile {
  characters: CastCharacter[];
}

interface DesignSubscriber {
  send: (payload: unknown) => void;
  res: Response;
  keepAlive: ReturnType<typeof setInterval>;
}

interface DesignFailure {
  characterId: string;
  name: string;
  error: string;
}

interface DesignJob {
  controller: AbortController;
  subscribers: Set<DesignSubscriber>;
  bookId: string;
  bookDir: string;
  total: number;
  done: number;
  skipped: number;
  failures: DesignFailure[];
  currentCharacterId: string | null;
  currentName: string | null;
}

/** One job per book (keyed by bookId). */
const inFlightByBook = new Map<string, DesignJob>();

/** Heartbeat cadence during a single (≤180s) design so the pill's 30s stall
    heuristic doesn't trip while the run is healthy. */
const HEARTBEAT_MS = 6000;

function broadcast(job: DesignJob, ev: unknown): void {
  for (const sub of job.subscribers) {
    try {
      sub.send(ev);
    } catch {
      /* dead socket — skip */
    }
  }
}

function endJob(job: DesignJob, finalEv?: unknown): void {
  if (finalEv) broadcast(job, finalEv);
  for (const sub of job.subscribers) {
    clearInterval(sub.keepAlive);
    try {
      sub.res.end();
    } catch {
      /* socket already gone */
    }
  }
  job.subscribers.clear();
  if (inFlightByBook.get(job.bookId) === job) inFlightByBook.delete(job.bookId);
  clearDesignBusy(job.bookDir);
}

/** Heartbeat cadence during the persona pre-pass — same value as the design
    loop's HEARTBEAT_MS so the pill's 30s stall heuristic never trips during
    either phase. */
const PERSONA_HEARTBEAT_MS = 6000;

/** LOCAL-engine only: generate `voiceStyle` personas for all base-task
    characters that lack one, BEFORE the design loop touches the sidecar.
    On a constrained GPU this lets `preparePersonaBatch` evict the idle
    resident model once (instead of once-per-character interleaved with
    VoiceDesign), preventing thrash and OOM.

    The `gemini` engine keeps its existing lazy-interleaved persona-gen
    inside `runDesignJob` unchanged — this function returns immediately for
    any non-local engine.

    Failure modes:
    - `LocalUnreachableError` → PROPAGATES (wholesale job abort).
    - Any other per-character error → recorded to `job.failures` +
      `character_failed` broadcast + continue (design loop will skip
      characters whose persona we could not set). */
async function runPersonaPrePass(job: DesignJob, tasks: DesignTask[]): Promise<void> {
  if (resolvePersonaEngine() !== 'local') return;

  // Deduplicate to base tasks only — variants always reuse the base persona.
  const baseIds = [...new Set(tasks.filter((t) => !t.emotion).map((t) => t.characterId))];
  if (baseIds.length === 0) return;

  // One GPU decision (evict / CPU-fallback) for the entire batch.
  const prep = await preparePersonaBatch(job.bookDir);

  // Emit the same `heartbeat` event type the design loop uses so the pill's
  // stall heuristic resets on a known event.
  const beat = setInterval(() => {
    broadcast(job, { type: 'heartbeat', characterId: job.currentCharacterId });
  }, PERSONA_HEARTBEAT_MS);

  try {
    for (const characterId of baseIds) {
      if (job.controller.signal.aborted) return;

      const cast = await readJson<CastFile>(castJsonPath(job.bookDir));
      const character = cast?.characters?.find((c) => c.id === characterId);
      if (!character) continue; // deleted mid-run — silently skip

      // Idempotent: already has a persona or is already designed.
      if ((character.voiceStyle ?? '').trim()) continue;
      if (character.overrideTtsVoices?.qwen?.name) continue;

      let persona: string;
      try {
        persona = await generateVoiceStylePersona(character, prep);
      } catch (err) {
        if (err instanceof LocalUnreachableError) throw err; // wholesale — propagate
        // Per-character failure: record + skip; the design loop will skip this char.
        const message = (err as Error).message || 'Persona generation failed.';
        job.failures.push({ characterId, name: character.name ?? characterId, error: message });
        broadcast(job, {
          type: 'character_failed',
          characterId,
          name: character.name ?? characterId,
          errorReason: message,
        });
        continue;
      }

      // Minimal-patch write so a concurrent edit to another character survives.
      const fresh = await readJson<CastFile>(castJsonPath(job.bookDir));
      const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
      if (fresh && idx !== -1) {
        fresh.characters[idx] = { ...fresh.characters[idx], voiceStyle: persona };
        await writeJsonAtomic(castJsonPath(job.bookDir), fresh);
      }
    }
  } finally {
    clearInterval(beat);
  }
}

/** The serial design loop — runs detached in the background; broadcasts to
    whatever subscribers are currently attached (zero during a reload gap). */
async function runDesignJob(
  job: DesignJob,
  tasks: DesignTask[],
  modelKey: TtsModelKey,
  language: string,
  seriesFilter: { author: string; series: string } | undefined,
): Promise<void> {
  await runPersonaPrePass(job, tasks);
  if (job.controller.signal.aborted) {
    endJob(job, { type: 'idle', done: job.done, total: job.total, skipped: job.skipped, failures: job.failures });
    return;
  }

  for (const task of tasks) {
    if (job.controller.signal.aborted) break;
    const { characterId, emotion } = task;

    /* Re-read fresh each iteration so a concurrent edit (rename, a manual
       design) is reflected, and the override write below races the smallest
       possible window. */
    const cast = await readJson<CastFile>(castJsonPath(job.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      /* Deleted/merged mid-run — silently skip (not a failure). */
      job.skipped += 1;
      broadcast(job, { type: 'character_skipped', characterId });
      continue;
    }

    if (!emotion) {
      /* Base voice — freshness-skip: someone designed this character (or a
         linked duplicate) since the list was captured — never clobber it. */
      if (character.overrideTtsVoices?.qwen?.name) {
        job.skipped += 1;
        broadcast(job, { type: 'character_skipped', characterId });
        continue;
      }
    } else {
      /* Variant — skip when the base is missing (can't make a variant without
         a base) or the variant is already designed (idempotent). */
      const baseName = character.overrideTtsVoices?.qwen?.name;
      const already = character.overrideTtsVoices?.qwen?.variants?.[emotion];
      if (!baseName || already) {
        job.skipped += 1;
        broadcast(job, { type: 'character_skipped', characterId });
        continue;
      }
    }

    job.currentCharacterId = characterId;
    job.currentName = character.name ?? characterId;
    broadcast(job, {
      type: 'progress',
      characterId,
      name: job.currentName,
      done: job.done,
      total: job.total,
    });

    const heartbeat = setInterval(() => broadcast(job, { type: 'heartbeat', characterId }), HEARTBEAT_MS);
    try {
      /* Persona fallback (Gemini) when the character has none, persisted
         minimal-patch so a concurrent edit to another character survives.
         Computed ONCE before the ride-out loop — a recycle retry re-renders the
         voice, not the persona. (Variants always have a base so a persona must
         already exist — but we apply the same fallback for safety.) */
      let persona = (character.voiceStyle ?? '').trim();
      if (!persona) {
        persona = await generateVoiceStylePersona(character);
        const fresh = await readJson<CastFile>(castJsonPath(job.bookDir));
        const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
        if (fresh && idx !== -1) {
          fresh.characters[idx] = { ...fresh.characters[idx], voiceStyle: persona };
          await writeJsonAtomic(castJsonPath(job.bookDir), fresh);
        }
      }

      const baseSampleVoiceId = character.voiceId ?? `char-${characterId}`;
      const sampleVoiceId = emotion
        ? `${baseSampleVoiceId}__${emotion}`
        : baseSampleVoiceId;

      /* Ride-out retry loop: a recycle mid-design fails this attempt with an
         "unreachable"-class error while the supervisor respawns the sidecar.
         Wait for it to come back (ensureSidecarEngineReady polls /load through
         the respawn) and retry THIS character, up to MAX_RECYCLE_RIDEOUTS. */
      /* srv-43 — mint/persist voiceUuid before the core names the .pt. */
      const voiceUuid = await ensureCharacterVoiceUuid(job.bookDir, characterId, seriesFilter);
      const characterForDesign = { ...character, voiceUuid: voiceUuid ?? character.voiceUuid };

      let rideouts = 0;
      for (;;) {
        try {
          const { voiceId } = await designQwenVoiceForCharacter({
            bookDir: job.bookDir,
            character: characterForDesign,
            characterId,
            persona,
            sampleVoiceId,
            modelKey,
            language,
            emotion,
            signal: job.controller.signal,
          });

          if (!emotion) {
            /* Base path — persist the override exactly as the drawer does. Match
               key is the character's voiceId/id, the name is the `qwen-…` id. */
            const matchKey = character.voiceId ?? character.id;
            await applyOverrideToCastFiles(matchKey, { engine: 'qwen', name: voiceId }, seriesFilter);
            job.done += 1;
            broadcast(job, { type: 'character_designed', characterId, voiceId });
          } else {
            /* Variant path — record the slot and propagate it across the
               series (linked cast), the same scope the base voice uses. */
            await persistEmotionVariant(job.bookDir, characterId, emotion, voiceId, seriesFilter);
            job.done += 1;
            broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId });
          }
          break;
        } catch (e) {
          const message = (e as Error).message || 'Voice design failed.';
          if (SIDECAR_DOWN_RE.test(message)) {
            /* Sidecar down/recycling. Ride out the respawn and retry this
               character — unless we've exhausted the budget (genuinely dead) or
               the job was cancelled, in which case stop the run. */
            if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
              rideouts += 1;
              broadcast(job, { type: 'heartbeat', characterId }); // keep the pill alive through the respawn
              try {
                await ensureSidecarEngineReady('qwen', job.controller.signal);
              } catch {
                /* aborted (pause) during the wait — stop cleanly; the outer
                   loop's abort-check ends the job. */
                break;
              }
              continue; // sidecar should be back — retry this character
            }
            /* Exhausted ride-outs (or aborted): a still-down sidecar would fail
               every remaining character identically — stop with a catastrophic
               error instead of grinding through N timeouts. */
            clearInterval(heartbeat);
            endJob(job, { type: 'error', code: 'sidecar_unavailable', message });
            return;
          }
          /* Per-character synthesis failure — record it and move on. */
          job.failures.push({ characterId, name: character.name ?? characterId, error: message });
          broadcast(job, {
            type: 'character_failed',
            characterId,
            name: character.name ?? characterId,
            errorReason: message,
          });
          break;
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  job.currentCharacterId = null;
  job.currentName = null;
  endJob(job, {
    type: 'idle',
    done: job.done,
    total: job.total,
    skipped: job.skipped,
    failures: job.failures,
  });
}

castDesignRouter.post('/:bookId/cast/design', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const body = (req.body ?? {}) as {
    characterIds?: unknown;
    modelKey?: unknown;
    scope?: unknown;
    variantTasks?: unknown;
  };
  const characterIds = Array.isArray(body.characterIds)
    ? body.characterIds.filter((x): x is string => typeof x === 'string')
    : null;

  const scope: DesignScope =
    body.scope === 'variants' || body.scope === 'both' ? body.scope : 'bases';
  const variantTasks: VariantTask[] = Array.isArray(body.variantTasks)
    ? (body.variantTasks as unknown[])
        .map((t) => t as { characterId?: unknown; emotions?: unknown })
        .filter(
          (t): t is VariantTask =>
            typeof t.characterId === 'string' &&
            Array.isArray(t.emotions) &&
            t.emotions.every(
              (e) => typeof e === 'string' && (VARIANT_EMOTIONS as string[]).includes(e),
            ),
        )
        .map((t) => ({ characterId: t.characterId, emotions: t.emotions as VariantTask['emotions'] }))
    : [];

  const hasWork =
    (characterIds !== null && characterIds.length > 0) ||
    (scope !== 'bases' && variantTasks.length > 0);

  const located = await findBookByBookId(bookId);
  if (!located) return res.status(404).json({ error: 'Book not found.' });
  const { bookDir } = located;

  const existing = inFlightByBook.get(bookId);
  const isStart = hasWork && !existing;

  /* Start-path validation BEFORE we flush SSE headers (so a 4xx is a real
     status code, not an SSE error event). */
  let modelKey: TtsModelKey | null = null;
  if (isStart) {
    if (isAnalysisBusy(bookDir)) {
      return res.status(409).json({
        error:
          'Analysis is running for this book. Wait for it to finish before designing the full cast (re-analysis rewrites the cast).',
      });
    }
    if (isDesignBusy(bookDir)) {
      return res.status(409).json({
        error:
          'A single voice design is in progress for this book. Wait for it to finish before designing the full cast.',
      });
    }
    if (!isTtsModelKey(body.modelKey)) {
      return res
        .status(400)
        .json({ error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}` });
    }
    modelKey = body.modelKey;
  }

  /* ── SSE setup (mirrors the analysis route's framing). */
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':ok\n\n');
  const keepAlive = setInterval(() => {
    try {
      res.write(':ka\n\n');
    } catch {
      /* socket gone */
    }
  }, 15_000);
  const send = (payload: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* dead socket */
    }
  };

  /* ── Subscribe path: re-attach to a live job, or idle if there's nothing
     to resume (a bare cold-boot probe POST for a book with no job). */
  if (!isStart) {
    if (!existing) {
      send({ type: 'idle', done: 0, total: 0, skipped: 0, failures: [] });
      clearInterval(keepAlive);
      return res.end();
    }
    const subscriber: DesignSubscriber = { send, res, keepAlive };
    existing.subscribers.add(subscriber);
    send({
      type: 'resume_from',
      total: existing.total,
      done: existing.done,
      currentName: existing.currentName,
    });
    res.on('close', () => {
      if (res.writableEnded) return;
      existing.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Do NOT abort — the job keeps running so a reload can re-attach. */
    });
    return;
  }

  /* ── Start path: register the job + run the loop detached. */
  let language: string;
  try {
    language = sidecarLanguageName(bookStateLanguage(located.state));
  } catch (e) {
    send({ type: 'error', code: 'unsupported_language', message: (e as Error).message });
    clearInterval(keepAlive);
    return res.end();
  }
  const isStandalone = located.state?.isStandalone === true;
  const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
  const seriesFilter = seriesInfo ?? undefined;

  const tasks = buildTaskList(scope, characterIds ?? [], variantTasks);

  const job: DesignJob = {
    controller: new AbortController(),
    subscribers: new Set(),
    bookId,
    bookDir,
    total: tasks.length,
    done: 0,
    skipped: 0,
    failures: [],
    currentCharacterId: null,
    currentName: null,
  };
  inFlightByBook.set(bookId, job);
  markDesignBusy(bookDir);
  const subscriber: DesignSubscriber = { send, res, keepAlive };
  job.subscribers.add(subscriber);
  res.on('close', () => {
    if (res.writableEnded) return;
    job.subscribers.delete(subscriber);
    clearInterval(keepAlive);
    /* Sticky: keep running for a reload re-attach. */
  });

  void runDesignJob(job, tasks, modelKey!, language, seriesFilter).catch((e) => {
    /* Defensive — the loop catches per-character; a throw here is unexpected. */
    endJob(job, {
      type: 'error',
      code: 'unknown',
      message: (e as Error).message || 'Cast design failed.',
    });
  });
});

castDesignRouter.get('/:bookId/cast/design/status', (req: Request, res: Response) => {
  const job = inFlightByBook.get(req.params.bookId);
  if (!job) return res.status(200).json({ active: false });
  return res.status(200).json({
    active: true,
    total: job.total,
    done: job.done,
    skipped: job.skipped,
    currentName: job.currentName,
    state: 'running',
    failures: job.failures,
  });
});

castDesignRouter.post('/:bookId/cast/design/pause', (req: Request, res: Response) => {
  const job = inFlightByBook.get(req.params.bookId);
  if (job && !job.controller.signal.aborted) job.controller.abort();
  return res.status(200).json({ ok: true, cancelled: !!job });
});
