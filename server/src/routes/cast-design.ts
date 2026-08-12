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
import { withCastLock } from '../workspace/cast-lock.js';
import {
  isLockAcquisitionTimeout,
  itemFailureReason,
  requestFailureMessage,
} from '../workspace/file-lock.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import type { Emotion } from '../handoff/schemas.js';
import { VARIANT_EMOTIONS, designQwenVoiceForCharacter, persistEmotionVariant, ensureCharacterVoiceUuid } from './qwen-voice.js';
import { sampleScopeForCharacter } from '../tts/voice-sample-cache.js';
import { applyOverrideToCastFiles } from './voices.js';
import { characterHasClonedSlot } from '../tts/clone-engines.js';
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
   per-character synthesis failure that should be recorded and skipped past).
   Widened to also recognize the existing drain-fence "recycling" 503
   ("Voice engine is recycling to free memory; retry shortly.") — that
   transient case never matched this regex before and was wrongly treated as
   an ordinary per-character failure (found auditing every 503 shape this
   route can return, see the design spec's review-findings section). */
const SIDECAR_DOWN_RE = /unreachable|did not complete within|stopped responding|recycling/i;

/* Bounded pause between GPU-busy ride-out retries. Deliberately short and
   NOT test-configurable (kept simple per the spec's non-goals) — real
   contention from another job almost always outlasts any reasonable
   constant anyway, so this only meaningfully helps a brief, sub-second
   blip; its main job is to not hammer the same busy resource in a tight
   loop before giving up and halting with a clear message. */
const GPU_BUSY_RIDEOUT_MS = 1_000;

/* Abort-aware setTimeout — same idiom as ensure-sidecar-loaded.ts:217,
   retry.ts:103, analyzer/gemini.ts:821 (each file keeps its own local copy
   rather than a shared export, matching this codebase's existing
   convention for this exact helper). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('cast-design GPU-busy ride-out sleep aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* "Sidecar is down or restarting" — a connection-level failure OR the
   sidecar's own CUDA-poison classification (which schedules a supervised
   restart, see server/tts-sidecar/main.py's _mark_cuda_poisoned). The
   existing ensureSidecarEngineReady health-poll is the right wait for both:
   it already treats a `poisoned: true` /health response as "keep waiting". */
function isSidecarRestartClass(e: unknown, message: string): boolean {
  return SIDECAR_DOWN_RE.test(message) || (e as { code?: string } | null)?.code === 'gpu_poisoned';
}

/* "GPU busy, no sidecar restart involved" — the Node-side GpuBusyError
   thrown by withGpuLoad when the local Ollama analyzer is resident and busy.
   Reusing ensureSidecarEngineReady for this would immediately re-throw
   ANOTHER GpuBusyError (it wraps the same withGpuLoad check), not resolve
   "ready" — so this class gets its own short explicit sleep instead. */
function isGpuBusyClass(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'GPU_BUSY';
}

interface CastFile {
  characters: CastCharacter[];
}

/* #1981 — the fresh-read/write pair shared by runPersonaPrePass and
   runDesignJob for persisting a generated persona onto a single character.
   Both call sites already re-read `fresh` immediately before writing
   (freshness-skip against a concurrent edit) — this just locks that
   existing read-through-write span rather than the (multi-second) LLM
   call above it, which stays outside the lock on purpose (see this file's
   per-site design note in the #1981 plan). Exported so the cross-writer
   race test can drive it directly — a full route call can't be timed
   against the job's internal write step deterministically, since the job
   runs detached from the request that started it.

   #1981 review fix round — also reused by voice-style.ts's `/generate-all`
   (widened here rather than forked: the review's own instruction). Return
   type widened from `void` to `boolean` — `true` when the character was
   found and the write landed, `false` when it had already been deleted by
   the time this write's OWN fresh read ran. `/generate-all` needs that
   signal to report results honestly: a character removed mid-batch by a
   concurrent edit is a silent, intentional SKIP (never resurrected by a
   stale write), not a false "success". This file's own two call sites
   still ignore the return value — a widened return type is safe for any
   caller that doesn't read it. */
export async function writeVoiceStylePersona(
  bookDir: string,
  characterId: string,
  persona: string,
): Promise<boolean> {
  return withCastLock(bookDir, async () => {
    const fresh = await readJson<CastFile>(castJsonPath(bookDir));
    const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
    if (fresh && idx !== -1) {
      fresh.characters[idx] = { ...fresh.characters[idx], voiceStyle: persona };
      await writeJsonAtomic(castJsonPath(bookDir), fresh);
      return true;
    }
    return false;
  });
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

/** GATE 2 fix-lane-1b — a character skipped by the clone-protection guard
    below (never designed at all, not even attempted), distinct from an
    ordinary freshness-skip or a mid-run character_failed: the sweep must
    REPORT who it protected, not just fold them silently into `skipped`. */
interface ClonedSkip {
  characterId: string;
  name: string;
}

interface DesignJob {
  controller: AbortController;
  subscribers: Set<DesignSubscriber>;
  bookId: string;
  bookDir: string;
  total: number;
  done: number;
  skipped: number;
  clonedSkips: ClonedSkip[];
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
    characters that lack one, BEFORE the design loop touches the sidecar —
    so persona generation (Ollama) and VoiceDesign (sidecar) don't interleave
    per-character. (Historically this pre-pass also let `preparePersonaBatch`
    reverse-evict the idle resident sidecar model once on a constrained GPU;
    that eviction step is retired — VRAM arbitration for the sidecar's own
    engines now lives in its capacity admission when SEG_CAPACITY_ADMISSION
    is on, or the sequential cast-review/render workflow when it's off.)

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
  const prep = await preparePersonaBatch(job.bookDir, job.controller.signal);

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
      await writeVoiceStylePersona(job.bookDir, characterId, persona);
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
    endJob(job, {
      type: 'idle',
      done: job.done,
      total: job.total,
      skipped: job.skipped,
      clonedSkips: job.clonedSkips,
      failures: job.failures,
    });
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

      /* GATE 2 fix-lane-1b — a design sweep must not retarget a cloned
         character off its clone. The applyOverrideToCastFiles call below
         pins ttsEngine = 'qwen' unconditionally; if this character already
         carries a cloned voice on coqui (the fail-safe, provenance-only
         characterHasClonedSlot test — the same guard I-B1 used at the
         voice-override route, not the uuid-validating resolution
         predicates in clone-engines.ts), that pin would silently retarget
         it off its clone while the marker stays intact — the wave's core
         never-silent-substitution property failing in disguise. The
         freshness-skip above already guarantees qwen itself has no name
         here, so a positive here can only be the OTHER clone-capable
         engine (coqui). The owner's decision (GATE 2 review): skip this
         character and report it — refusing the whole sweep would let one
         cloned character block designing the rest; retargeting is the
         defect itself. */
      if (characterHasClonedSlot(character)) {
        job.skipped += 1;
        job.clonedSkips.push({ characterId, name: character.name ?? characterId });
        broadcast(job, {
          type: 'character_skipped',
          characterId,
          name: character.name ?? characterId,
          reason: 'already_cloned',
        });
        continue;
      }
    } else {
      /* #1954 — the variant branch gets the clone gate the base branch above
         has had since GATE 2 fix-lane-1b. It was missing here, and that is
         what made the wrong-anchor mint reachable: the only pre-existing
         check is `overrideTtsVoices?.qwen?.name`, and a CLONED slot carries a
         name (`qwen-<libraryUuid>`), so a cloned character read as "base is
         designed, go ahead". The mint then anchored on
         `qwenStorageKey(...)` — a designed-voice key that cannot name a
         clone's artifact. See designQwenVoiceForCharacter (qwen-voice.ts) for
         why the resolution is refusal rather than correct anchoring.

         Same disposition as the base branch, and for the same reason: SKIP
         and report, don't fail the run — refusing the whole sweep would let
         one cloned character block designing everyone else's variants.
         Reported through the existing `clonedSkips` channel, which the UI
         already renders as "already cloned: <names>"
         (src/store/cast-design-stream-middleware.ts). */
      if (characterHasClonedSlot(character)) {
        job.skipped += 1;
        job.clonedSkips.push({ characterId, name: character.name ?? characterId });
        broadcast(job, {
          type: 'character_skipped',
          characterId,
          name: character.name ?? characterId,
          reason: 'already_cloned',
        });
        continue;
      }

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
      /* Persona fallback: when the character has no persona, generate one.
         Computed ONCE before the ride-out loop — a recycle retry re-renders the
         voice, not the persona. (Variants always have a base so a persona must
         already exist — but we apply the same fallback for safety.)

         ENGINE SPLIT: the LOCAL engine must NOT fall back here.  The pre-pass
         (`runPersonaPrePass`) owns local persona-gen; it runs before VoiceDesign
         loads and uses a safe GPU plan (evict or CPU).  If it failed for this
         character it already recorded a `character_failed` and the character ends
         up in `job.failures`.  Retrying here — with VoiceDesign already resident
         on the GPU — would call Ollama inside `withGpuLoad`, the exact plan-108
         OOM this pre-pass was built to prevent.  Skip silently (no second
         `character_failed` broadcast — the pre-pass already emitted one). */
      let persona = (character.voiceStyle ?? '').trim();
      if (!persona) {
        if (resolvePersonaEngine() === 'local') {
          /* Skip — the pre-pass owns local persona-gen and already recorded any
             failure; retrying here with an un-evicted GPU Ollama call as
             VoiceDesign loads is the plan-108 OOM. */
          continue;
        }
        persona = await generateVoiceStylePersona(character);
        await writeVoiceStylePersona(job.bookDir, characterId, persona);
      }

      /* bug #1411 code-review follow-up: must match sample-scope.ts's
         sampleScopeFor / voices.ts's read-side scope, or a bulk-designed
         voiceId-less character's audition caches under a scope the Voices
         Library never looks up and reads back as "Not sampled".
         sampleScopeForCharacter is the single shared source of this formula
         (voice-sample-cache.ts) — don't recompute it inline here. */
      const baseSampleVoiceId = sampleScopeForCharacter(
        { id: characterId, voiceId: character.voiceId },
        job.bookId,
      );
      const sampleVoiceId = emotion
        ? `${baseSampleVoiceId}__${emotion}`
        : baseSampleVoiceId;

      /* Ride-out retry loop: a recycle mid-design fails this attempt with an
         "unreachable"-class error while the supervisor respawns the sidecar.
         Wait for it to come back (ensureSidecarEngineReady polls /load through
         the respawn) and retry THIS character, up to MAX_RECYCLE_RIDEOUTS. */
      /* srv-43 — mint/persist a voiceUuid before the core names the .pt, but
         ONLY for a BASE design. A base design writes the `.pt` at the resulting
         `qwen-<uuid>` key, so minting is safe. A VARIANT must NOT mint: it
         doesn't write the base `.pt`, so stamping a fresh uuid would flip the
         base's storage key to `qwen-<uuid>` while its embedding still sits at the
         old key — orphaning it (silent Kokoro fallback on re-render; the variant
         mint then can't load its base). #1057: this is exactly how a bulk
         "Emotion variants" run orphaned every base. A variant anchors on the
         base's CURRENT key, so it reuses the character's existing voiceUuid. */
      const voiceUuid = emotion
        ? character.voiceUuid
        : await ensureCharacterVoiceUuid(job.bookDir, characterId, seriesFilter);
      const characterForDesign = { ...character, voiceUuid: voiceUuid ?? character.voiceUuid };

      let rideouts = 0;
      for (;;) {
        try {
          const { voiceId, fellBackToDesignVoice, fallbackReason } = await designQwenVoiceForCharacter({
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
               key is the character's voiceId/id, the name is the `qwen-…` id.
               fs-61 — pass job.bookDir so a standalone (no seriesFilter) writes
               ONLY this book instead of sweeping every book in the workspace
               sharing the same bare character id (e.g. "narrator"). */
            const matchKey = character.voiceId ?? character.id;
            await applyOverrideToCastFiles(
              matchKey,
              { engine: 'qwen', name: voiceId },
              seriesFilter,
              job.bookDir,
            );
            job.done += 1;
            broadcast(job, { type: 'character_designed', characterId, voiceId });
          } else {
            /* Variant path — record the slot and propagate it across the
               series (linked cast), the same scope the base voice uses. */
            await persistEmotionVariant(job.bookDir, characterId, emotion, voiceId, seriesFilter);
            job.done += 1;
            broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId,
              ...(fellBackToDesignVoice ? { viaFallback: true, fallbackReason } : {}) });
          }
          break;
        } catch (e) {
          const message = (e as Error).message || 'Voice design failed.';
          if (isSidecarRestartClass(e, message)) {
            /* Sidecar down/recycling/poison-restarting. Ride out the respawn
               and retry this character — unless we've exhausted the budget
               (genuinely dead) or the job was cancelled, in which case stop
               the run. */
            if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
              rideouts += 1;
              broadcast(job, { type: 'heartbeat', characterId }); // keep the pill alive through the respawn
              try {
                await ensureSidecarEngineReady('qwen', job.controller.signal);
              } catch {
                /* Only a genuine run-level abort is a clean stop here — the
                   outer loop's abort-check ends the job. Anything else (e.g.
                   ensureSidecarEngineReady's own withGpuLoad wrap throwing a
                   GpuBusyError mid-wait) falls through to retry instead of
                   silently dropping this character's accounting (bug found
                   during spec review — the old code broke unconditionally on
                   ANY throw here). rideouts is already bounded above. */
                if (job.controller.signal.aborted) break;
              }
              continue; // retry this character
            }
            /* Exhausted ride-outs (or aborted): a still-down sidecar would fail
               every remaining character identically — stop with a catastrophic
               error instead of grinding through N timeouts. */
            clearInterval(heartbeat);
            endJob(job, {
              type: 'error',
              code: 'sidecar_unavailable',
              message: `${message} (${job.done} of ${job.total} designed before this happened.)`,
            });
            return;
          }
          if (isGpuBusyClass(e)) {
            /* GPU busy (no restart involved) — a short bounded pause, then
               retry; NOT the sidecar health-poll (that would just re-throw
               the same GpuBusyError immediately, not actually wait). */
            if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
              rideouts += 1;
              broadcast(job, { type: 'heartbeat', characterId });
              try {
                await sleep(GPU_BUSY_RIDEOUT_MS, job.controller.signal);
              } catch {
                break; // aborted during the wait — clean stop
              }
              continue; // retry this character
            }
            clearInterval(heartbeat);
            endJob(job, {
              type: 'error',
              code: 'gpu_contention',
              message: `${message} (${job.done} of ${job.total} designed before this happened.)`,
            });
            return;
          }
          /* Per-character synthesis failure — record it and move on.
             #2292 (owner decision) — a `LockAcquisitionTimeoutError` out of
             the persist steps in this try (`applyOverrideToCastFiles`,
             `persistEmotionVariant`, `ensureCharacterVoiceUuid`,
             `writeVoiceStylePersona`) keeps this per-character shape — one
             contended character must not fail the other N — but reports
             contention rather than implying the character itself is at fault.
             The same string on both surfaces so the live toast and the
             end-of-job `failures` list can't disagree. */
          const reason = itemFailureReason(e, message);
          job.failures.push({ characterId, name: character.name ?? characterId, error: reason });
          broadcast(job, {
            type: 'character_failed',
            characterId,
            name: character.name ?? characterId,
            errorReason: reason,
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
    clonedSkips: job.clonedSkips,
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
    clonedSkips: [],
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
    /* Defensive — the loop catches per-character; a throw here is unexpected.
       #2260 FINAL ROUND (B2) — curated all the same. The REACHABLE contention
       path in this route is per-character and already reports
       `LOCK_CONTENTION_ITEM_REASON`; this outer handler is the backstop, and a
       backstop that leaks is still a leak. No fixture drives it (nothing is
       known to reach it), so this is consistency, not a covered fix. */
    /* #2260 FINAL ROUND (B2) nit — 'unknown' left this backstop unable to reach
       the Help entry `helpHrefForFailureCode` (src/lib/router.ts) links for a
       lock-contention failure, same as the analysis path's own
       `classifyAnalysisFailure` (failure-taxonomy.ts) already does. Two
       literal branches, not a `code` variable, so the literal `code: '...'`
       stays greppable/regex-extractable the way every other code on this
       event already is (see single-design.ts's identical nit for the guard
       this matters to). */
    if (isLockAcquisitionTimeout(e)) {
      endJob(job, {
        type: 'error',
        code: 'lock-contention',
        message: requestFailureMessage(e, (e as Error).message || 'Cast design failed.'),
      });
    } else {
      endJob(job, {
        type: 'error',
        code: 'unknown',
        message: requestFailureMessage(e, (e as Error).message || 'Cast design failed.'),
      });
    }
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
    clonedSkips: job.clonedSkips,
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
