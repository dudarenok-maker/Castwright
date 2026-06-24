/* POST /api/books/:bookId/cast/:characterId/design-voice

   Plan 108, Wave 4 — proxies the TTS sidecar's bespoke Qwen voice-DESIGN
   flow for one cast member. Designing a voice caches a reusable speaker
   embedding under a stable voiceId and returns an AUDITION preview; it
   does NOT persist the per-character override (the Profile Drawer's Save
   commits that via PUT /api/voices/:voiceId/override with scope:'series').

   Body: `{ persona?, sampleVoiceId, modelKey }`.
   - `persona` defaults to the character's persisted `voiceStyle`. 400 when
     neither is present (the drawer always sends the edited textarea value,
     so this is the empty-persona guard).
   - `sampleVoiceId` + `modelKey` are the cache identity the "Play 12s"
     player (voice-sample.ts) will later compute. The drawer passes the same
     values it would send to /sample.

   The derived sidecar voiceId is `qwen-${character.voiceId ?? characterId}`,
   stable across designs so re-designing overwrites the same embedding.

   One-pass reuse: the audition is synthesised from the character's OWN line
   (the longest evidence quote — exactly what voice-sample.ts picks) and the
   resulting MP3 is written into the SAME on-disk sample cache, under the
   filename the player computes for (sampleVoiceId, modelKey, line, voiceId).
   So designing a voice and then clicking "Play 12s" is a cache hit — one
   synthesis, not two. The response is JSON `{ voiceId, url }` pointing at
   that cached file. A sidecar that's down → 502 with a clear message. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { mkdir, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { sidecarLanguageName } from '../tts/language.js';
import { castJsonPath, qwenVoiceSidecarPath, qwenVoicesDir } from '../workspace/paths.js';
import { safeSegment, assertContained, sanitizeIdSegment } from '../util/safe-path.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { EMOTIONS, type Emotion } from '../handoff/schemas.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import { encodePcmToAudio } from '../tts/mp3.js';
import { gpuSemaphore } from '../gpu/semaphore.js';
import { costForEngine } from '../tts/engine-vram-cost.js';
import { withDesignLock, isDesignBusy } from '../tts/design-lock.js';
import { buildHintFromCast, toVoiceLike, type CastCharacter } from '../tts/synthesise-chapter.js';
import { forEachMatchingCastCharacter } from './voices.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import {
  buildSampleText,
  voiceSampleAudioDir,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';
import { nanoid } from 'nanoid';

export const qwenVoiceRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

/* The base liveness-check interval. A design that exceeds this AND whose sidecar
   /health is still reachable is slow-but-alive — keep waiting (almost always a
   contended GPU). Only an unreachable sidecar or the absolute ceiling aborts.
   (Was a blind wall-clock abort that surfaced a false "Halted" while the sidecar
   was happily still designing.) */
const DESIGN_LIVENESS_INTERVAL_MS = 180_000;
/* Hard ceiling so a genuinely hung-but-pingable sidecar still fails eventually. */
const DESIGN_ABSOLUTE_MAX_MS = 600_000;

export type DesignLivenessResult =
  | { action: 'continue' }
  | { action: 'abort'; reason: 'unreachable' | 'absolute' };

/** Pure decision for the design liveness watchdog — easy to unit-test. */
export function evaluateDesignLiveness(p: {
  startedAt: number;
  now: number;
  health: 'reachable' | 'unreachable';
  absoluteMaxMs: number;
}): DesignLivenessResult {
  if (p.health === 'unreachable') return { action: 'abort', reason: 'unreachable' };
  if (p.now - p.startedAt >= p.absoluteMaxMs) return { action: 'abort', reason: 'absolute' };
  return { action: 'continue' };
}

/* Stable cache key for the designed voice — keyed on the character's
   voiceId when present (so a series-shared identity reuses one embedding)
   else the local character id. */
export function deriveQwenVoiceId(character: CastCharacter, characterId: string): string {
  return `qwen-${character.voiceId ?? characterId}`;
}

/* fs-25 — the expressive emotions a variant can be designed for (the enum minus
   `neutral`, which IS the base voice, not a variant). */
export const VARIANT_EMOTIONS = EMOTIONS.filter((e) => e !== 'neutral') as Exclude<
  Emotion,
  'neutral'
>[];

/* Emotion delivery clause sent to /qwen/mint-variant as `emotionInstruct`.
   The base persona is already baked into the base voice identity; this clause
   adds only the delivery modifier on top. Phrasings calibrated for the
   anchored-mint approach (Task 6): stronger contrast vs. base voice. */
const EMOTION_INSTRUCT: Record<Exclude<Emotion, 'neutral'>, string> = {
  whisper:
    'Delivered as a barely-there whisper, almost silent, pure soft breath with no vocal tone at all, hushed and intimate, faint enough that you strain to hear it.',
  angry:
    'Delivered with explosive, furious rage, shouting at the top of the voice, harsh and seething, sharp and aggressive, utterly enraged.',
  excited:
    'Delivered with bright, happy, upbeat excitement, cheerful and thrilled, full of joyful, positive energy.',
  sad: 'Delivered with quiet, downcast sadness, slow and subdued, low and weary, heavy and dejected.',
};

/* fs-25 / fe-32 / srv-37 — record a designed emotion variant onto a
   character's qwen slot. A variant voiceId is derived from the series-unified
   base voiceId (`qwen-<voiceId>__<emotion>`), so — exactly like the base voice
   carried by `applyOverrideToCastFiles` — it must TRAVEL to every linked
   character (same `voiceId`) across the books in the series; a per-book variant
   slot would break the linked-cast premise (the same character would render the
   emotion in one book and fall back to base in another). When `seriesFilter` is
   given the slot propagates series-wide (standalones excluded); without it the
   write stays book-scoped (a standalone, or a caller with no series context).
   Preserves the base `name` (defaulting it to the derived base id when the slot
   is fresh) and any sibling variants. No-op for an unknown character. Shared by
   the single design-voice route and the bulk "Design full cast" job. */
export async function persistEmotionVariant(
  bookDir: string,
  characterId: string,
  emotion: Exclude<Emotion, 'neutral'>,
  variantVoiceId: string,
  seriesFilter?: { author: string; series: string },
): Promise<void> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!cast || !character) return;
  const baseVoiceId = qwenStorageKey(character, characterId);

  /* Add/overwrite the emotion slot on a character's qwen override, defaulting
     the base name when the slot is fresh and preserving sibling variants. */
  const addVariant = (c: CastCharacter): CastCharacter => {
    const map = { ...(c.overrideTtsVoices ?? {}) };
    const qwen = map.qwen ?? { name: baseVoiceId };
    map.qwen = {
      ...qwen,
      name: qwen.name ?? baseVoiceId,
      variants: { ...(qwen.variants ?? {}), [emotion]: { name: variantVoiceId } },
    };
    return { ...c, overrideTtsVoices: map };
  };

  if (seriesFilter) {
    /* Linked-cast propagation across the series (matches on the linked
       identity `voiceId ?? id`, the same key applyOverrideToCastFiles uses). */
    await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, addVariant);
    return;
  }

  /* No series context — book-scoped write. */
  const idx = cast.characters.findIndex((c) => c.id === characterId);
  cast.characters[idx] = addVariant(character);
  await writeJsonAtomic(castJsonPath(bookDir), cast);
}

/* srv-43 — ensure a character has an immutable voiceUuid BEFORE its bespoke
   voice is designed (the .pt is named from qwenStorageKey, which reads the
   uuid). Idempotent: returns the existing uuid untouched. Mints under the
   per-book design lock so two concurrent designs of one character can't mint
   two uuids. Stamps the SAME uuid onto every linked-cast sibling (matching
   voiceId ?? id) so a series-shared voice keeps one identity — series-scoped
   when seriesFilter is given (mirrors persistEmotionVariant), else book-scoped.
   Returns undefined for an unknown character. */
export async function ensureCharacterVoiceUuid(
  bookDir: string,
  characterId: string,
  seriesFilter?: { author: string; series: string },
): Promise<string | undefined> {
  return withDesignLock(bookDir, async () => {
    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!cast || !character) return undefined;
    if (character.voiceUuid) return character.voiceUuid;

    const uuid = nanoid();
    const stamp = (c: CastCharacter): CastCharacter => ({ ...c, voiceUuid: uuid });

    if (seriesFilter) {
      await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, stamp);
      return uuid;
    }
    /* Book-scoped — stamp every character in THIS book sharing the linked id. */
    const linkId = character.voiceId ?? character.id;
    let dirty = false;
    for (let i = 0; i < cast.characters.length; i++) {
      if ((cast.characters[i].voiceId ?? cast.characters[i].id) === linkId) {
        cast.characters[i] = stamp(cast.characters[i]);
        dirty = true;
      }
    }
    if (dirty) await writeJsonAtomic(castJsonPath(bookDir), cast);
    return uuid;
  });
}

/* Preview/promote (plan 161). The A/B "current vs proposed" audition must NOT
   overwrite a character's live bespoke voice while the user is still deciding —
   but `deriveQwenVoiceId` is stable per character and the design route always
   (over)writes that embedding. So a comparison design stages under a sibling
   `-preview` id (a separate `.pt`/`.json` + a distinct audition cache file,
   since the cache key folds in the voiceId); the real voice is untouched until
   the user approves. `promote-voice` then moves the preview onto the real id
   (and evicts the sidecar's in-memory cache so the swap is seen); Cancel hits
   `discard-voice` to drop the preview. Keeping the COMMITTED id stable
   (`qwen-<id>`) avoids rippling the reuse/series/duplicate-detection logic that
   keys on it. */
const PREVIEW_SUFFIX = '-preview';
function previewVoiceIdFor(realVoiceId: string): string {
  return `${realVoiceId}${PREVIEW_SUFFIX}`;
}
export function qwenVoicePtPath(name: string): string {
  const p = join(qwenVoicesDir(), `${sanitizeIdSegment(safeSegment(name))}.pt`);
  assertContained(qwenVoicesDir(), p);
  return p;
}

/* GET /api/books/:bookId/cast/:characterId/designed-persona

   Plan 149 — surfaces the persona text (`instruct`) of a character's already
   DESIGNED Qwen voice, read from the voice sidecar JSON. The persona is
   persisted on the sidecar at design time but historically was NOT mirrored
   onto `character.voiceStyle` (and reuse copies only the override, never the
   persona) — so the Profile Drawer's "Voice persona" textarea reads blank for
   reused/origin characters whose voice is otherwise correctly designed. The
   drawer calls this lazily (only when `voiceStyle` is empty) to seed the
   textarea, so the persona shows and a re-design isn't blocked by the empty-
   persona 400 guard above.

   Returns 200 `{ instruct }` — an empty string when the sidecar/key is absent
   (a benign "no persona on disk", same as today's blank). 404 only for an
   unknown book/character. */
qwenVoiceRouter.get(
  '/:bookId/cast/:characterId/designed-persona',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    /* Same storage-key resolution as design-voice: an explicit per-character
       qwen override name (the storage key) wins, else the derived
       `qwenStorageKey` (so a REUSED character with an empty own override still
       resolves to its series-shared sidecar `.json`). */
    const voiceName =
      character.overrideTtsVoices?.qwen?.name ?? qwenStorageKey(character, characterId);
    const sidecar = await readJson<{ instruct?: string }>(qwenVoiceSidecarPath(voiceName)).catch(
      () => null,
    );
    const instruct = typeof sidecar?.instruct === 'string' ? sidecar.instruct : '';
    return res.status(200).json({ instruct });
  },
);

/* Shared design core — the sidecar `/qwen/design-voice` call + audition-cache
   write, extracted so BOTH the single-design route below and the bulk
   "Design full cast" job (server/src/routes/cast-design.ts) run the exact same
   path in-process (no HTTP-to-self). Serialized per book (`withDesignLock`) and
   GPU-fair (`gpuSemaphore`) so two designs for one book can't corrupt the
   shared `.pt`/audition-cache, and a bulk run can't oversubscribe the card
   against a concurrent generation/analysis. Throws on sidecar/encode failure
   with a user-facing message; the caller maps it (502 for the route, a
   per-character failure for the bulk job). Does NOT persist the per-character
   override or the emotion variant — that stays with the callers. */
export interface DesignQwenVoiceParams {
  bookDir: string;
  character: CastCharacter;
  characterId: string;
  /** Resolved, non-empty persona (the caller applies its own precedence). */
  persona: string;
  sampleVoiceId: string;
  modelKey: TtsModelKey;
  /** Sidecar language name (e.g. 'english') — baked into the cached voice. */
  language: string;
  /** When set, designs an emotion VARIANT under `<baseVoiceId>__<emotion>`. */
  emotion?: Exclude<Emotion, 'neutral'>;
  /** Stage under a `-preview` sibling id (A/B compare) instead of in place. */
  preview?: boolean;
  /** External cancel — aborts the in-flight sidecar call (e.g. the bulk job's
      controller on a Cancel) in addition to the internal timeout. */
  signal?: AbortSignal;
}

export async function designQwenVoiceForCharacter(
  p: DesignQwenVoiceParams,
): Promise<{ voiceId: string; url: string }> {
  const baseVoiceId = qwenStorageKey(p.character, p.characterId);
  const designedId = p.emotion ? `${baseVoiceId}__${p.emotion}` : baseVoiceId;
  const voiceId = p.preview ? previewVoiceIdFor(designedId) : designedId;
  const calibrationText = buildSampleText(toVoiceLike(p.character), buildHintFromCast(p.character));

  return withDesignLock(p.bookDir, async () => {
    const { withGpuLoad } = await import('../gpu/gpu-load.js');
    return withGpuLoad(async () => {
      const releaseGpu = await gpuSemaphore.acquire(costForEngine('qwen'));
      const sidecarUrl = getResolvedSidecarUrl();
      /* fs-55: emotion variants go to /qwen/mint-variant (anchored to the base
         identity, so the base persona is not re-described — only the delivery
         clause is added). Base voice design still goes to /qwen/design-voice. */
      const target = p.emotion
        ? `${sidecarUrl}/qwen/mint-variant`
        : `${sidecarUrl}/qwen/design-voice`;
      const controller = new AbortController();
      const startedAt = Date.now();
      let abortReason: 'unreachable' | 'absolute' | null = null;
      const livenessTimer = setInterval(() => {
        void (async () => {
          const { probeSidecarHealth } = await import('./sidecar-health.js');
          const health = (await probeSidecarHealth()).status; // 'reachable' | 'unreachable'
          const decision = evaluateDesignLiveness({
            startedAt,
            now: Date.now(),
            health,
            absoluteMaxMs: DESIGN_ABSOLUTE_MAX_MS,
          });
          if (decision.action === 'abort') {
            abortReason = decision.reason;
            controller.abort();
          } else {
            console.warn(
              `[qwen-voice] design slow (${Math.round((Date.now() - startedAt) / 1000)}s) ` +
                `— sidecar /health reachable, extending (ceiling ${DESIGN_ABSOLUTE_MAX_MS / 1000}s).`,
            );
          }
        })();
      }, DESIGN_LIVENESS_INTERVAL_MS);
      const onExternalAbort = () => controller.abort();
      if (p.signal) {
        if (p.signal.aborted) controller.abort();
        else p.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      try {
        let upstream: Awaited<ReturnType<typeof fetch>>;
        try {
          /* fs-55: emotion variant path sends { baseVoiceId, variantVoiceId,
             emotionInstruct, ... } to /qwen/mint-variant. The base path sends
             { voiceId, instruct, ... } to /qwen/design-voice unchanged. */
          const fetchBody = p.emotion
            ? JSON.stringify({
                baseVoiceId,
                variantVoiceId: voiceId,
                emotionInstruct: EMOTION_INSTRUCT[p.emotion],
                voiceUuid: p.character.voiceUuid ?? null,
                language: p.language,
                calibrationText,
              })
            : JSON.stringify({
                voiceId,
                voiceUuid: p.character.voiceUuid ?? null,
                instruct: p.persona,
                language: p.language,
                calibrationText,
              });
          upstream = await fetch(target, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: fetchBody,
          });
        } catch (e) {
          const err = e as { name?: string; message?: string };
          if (err.name === 'AbortError') {
            if (p.signal?.aborted) {
              throw new Error('Voice design was cancelled.');
            }
            if (abortReason === 'unreachable') {
              throw new Error(
                `TTS sidecar (${sidecarUrl}) stopped responding to /health during voice design — the process may have crashed or been recycled.`,
              );
            }
            throw new Error(
              `Sidecar ${target} did not complete within ${DESIGN_ABSOLUTE_MAX_MS}ms — voice design is unusually slow or the process is stuck.`,
            );
          }
          throw new Error(
            `TTS sidecar (${sidecarUrl}) is unreachable — ${err.message || 'request failed'}.`,
          );
        }
        if (!upstream.ok) {
          let detail = '';
          try {
            const body = (await upstream.json()) as { detail?: string; error?: string };
            detail = body.detail ?? body.error ?? '';
          } catch {
            /* not json */
          }
          throw new Error(
            detail ||
              `Sidecar ${target} returned ${upstream.status} ${upstream.statusText}.`,
          );
        }
        const sampleRate = Number(upstream.headers.get('X-Sample-Rate') ?? '24000') || 24000;
        const pcm = Buffer.from(await upstream.arrayBuffer());

        const fileName = voiceSampleFileName({
          cacheScope: p.sampleVoiceId,
          modelKey: p.modelKey,
          text: calibrationText,
          voiceName: voiceId,
        });
        const filePath = voiceSampleFilePath(fileName);
        const url = voiceSamplePublicUrl(fileName);
        try {
          await mkdir(voiceSampleAudioDir(), { recursive: true });
          const mp3 = await encodePcmToAudio(pcm, sampleRate);
          await writeFile(filePath, mp3);
        } catch (encErr) {
          throw new Error(
            `Designed the voice but failed to cache its preview: ${(encErr as Error).message}`,
          );
        }
        console.log(
          `[qwen-voice] book=${p.bookDir} character=${p.characterId} voiceId=${voiceId} ` +
            `→ cached ${fileName} (${pcm.length} bytes @ ${sampleRate}Hz)`,
        );
        // fs-45 v1: record the design peak (Base + VoiceDesign resident here).
        const { maybeSampleSidecarEngine } = await import('../gpu/sidecar-vram-sample.js');
        await maybeSampleSidecarEngine('qwen:design');
        return { voiceId, url };
      } finally {
        clearInterval(livenessTimer);
        if (p.signal) p.signal.removeEventListener('abort', onExternalAbort);
        releaseGpu();
      }
    });
  });
}

qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/design-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      persona?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
      preview?: unknown;
      emotion?: unknown;
    };

    /* fs-25 — optional emotion variant. When present it must be one of the
       expressive emotions (`neutral` is the base voice, not a variant). The
       variant is designed under `<baseVoiceId>__<emotion>`, its instruct gains
       the delivery clause, and the cast's qwen `variants[emotion]` slot is
       recorded on success. Absent → the original base-voice design. */
    let emotion: Exclude<Emotion, 'neutral'> | undefined;
    if (body.emotion !== undefined) {
      if (
        typeof body.emotion !== 'string' ||
        !(VARIANT_EMOTIONS as string[]).includes(body.emotion)
      ) {
        return res.status(400).json({
          error: `emotion must be one of: ${VARIANT_EMOTIONS.join(', ')} (neutral is the base voice).`,
        });
      }
      emotion = body.emotion as Exclude<Emotion, 'neutral'>;
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;
    /* Mutual exclusion: a bulk "Design full cast" run owns the book's designs
       (serializing via the per-book lock). Refuse a competing single design so
       a drawer click can't fight the bulk run for the same voiceId. */
    if (isDesignBusy(bookDir)) {
      return res.status(409).json({
        error:
          'A "Design full cast" run is in progress for this book. Wait for it to finish (or cancel it) before designing a single voice.',
      });
    }
    /* fs-2 — design the voice in the BOOK's language. The sidecar bakes this
       into the cached voice manifest, so every later /synthesize of this
       voice speaks the right language (synth itself carries no language).
       A Russian book therefore yields Russian-speaking designed voices. */
    const designLanguage = sidecarLanguageName(bookStateLanguage(located.state));

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before designing voices.',
      });
    }
    const character = cast.characters.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    /* Persona precedence: explicit body wins, else the persisted
       voiceStyle. Neither present → 400 (the user must generate or type
       a persona first). */
    const personaFromBody = typeof body.persona === 'string' ? body.persona.trim() : '';
    const persona = personaFromBody || (character.voiceStyle ?? '').trim();
    if (!persona) {
      return res.status(400).json({
        error:
          'No persona to design from — generate a voice style first or pass `persona` in the body.',
      });
    }

    /* Cache identity — the same (voiceId path, modelKey) the /sample player
       uses, so the audition we render here lands on the file it later reads.
       Required: without them we can't reproduce the player's cache key. */
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    if (!sampleVoiceId) {
      return res.status(400).json({
        error: '`sampleVoiceId` is required so the preview can be cached as the 12s sample.',
      });
    }
    if (!isTtsModelKey(body.modelKey)) {
      return res.status(400).json({
        error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}`,
      });
    }
    const modelKey = body.modelKey;

    /* Plan 161 — `preview:true` stages the design under a `-preview` sibling id
       so the live voice isn't overwritten during an A/B comparison; the drawer
       promotes it on approve. Default false keeps the original in-place design. */
    const isStandalone = located.state?.isStandalone === true;
    const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
    /* srv-43 — mint/persist a voiceUuid before the core names the .pt, but ONLY
       for a BASE design (which writes the `.pt` at the resulting `qwen-<uuid>`
       key). A VARIANT must NOT mint: it doesn't write the base `.pt`, so a fresh
       uuid would flip the base's storage key while its embedding stays at the
       old key — orphaning it (#1057). A variant reuses the character's existing
       voiceUuid and anchors on the base's current key. */
    const voiceUuid = emotion
      ? character.voiceUuid
      : await ensureCharacterVoiceUuid(bookDir, characterId, seriesInfo ?? undefined);
    const characterForDesign: CastCharacter = { ...character, voiceUuid: voiceUuid ?? character.voiceUuid };
    try {
      const { voiceId, url } = await designQwenVoiceForCharacter({
        bookDir,
        character: characterForDesign,
        characterId,
        persona,
        sampleVoiceId,
        modelKey,
        language: designLanguage,
        emotion,
        preview: body.preview === true,
      });
      /* fs-25 — record a (non-preview) emotion variant onto the character's
         qwen slot so generation can resolve it (Wave 2) and the cast UI can show
         the Variants badge. The base-voice design itself still persists via the
         drawer's Save. */
      if (emotion && body.preview !== true) {
        /* Propagate the variant across the series (linked cast) — book-scoped
           only for a standalone. Mirrors the base-voice series scope. */
        await persistEmotionVariant(
          bookDir,
          characterId,
          emotion,
          voiceId,
          seriesInfo ?? undefined,
        );
      }
      /* srv-43 — return voiceUuid so the drawer can stamp it locally without
         a refetch; the /sample player needs it to hit the uuid-keyed cache. */
      return res.status(200).json({ voiceId, url, voiceUuid });
    } catch (e) {
      /* The core throws a user-facing message for sidecar/encode/timeout
         failures — surface it as a 502 (the sidecar boundary). */
      const { GpuBusyError } = await import('../gpu/gpu-load.js');
      if (e instanceof GpuBusyError) {
        return res.status(409).json({ error: e.message, code: 'gpu_busy' });
      }
      return res.status(502).json({ error: (e as Error).message || 'Voice design failed.' });
    }
  },
);

/* POST /api/books/:bookId/cast/:characterId/promote-voice

   Plan 161 — commit a previewed design (from the drawer's A/B "Design &
   compare") onto the character's stable `qwen-<id>` voice. Moves the preview
   `.pt`/`.json` onto the real id, refreshes the cached audition under the real
   id so "Play 12s" serves the approved take, and evicts the sidecar's
   in-memory prompt cache so a synth that loaded the OLD embedding earlier this
   session can't keep serving it. Body: `{ previewVoiceId, sampleVoiceId,
   modelKey }`. Returns `{ voiceId, url }` (the real id + its audition URL). */
qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/promote-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      previewVoiceId?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
    };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    const realVoiceId = qwenStorageKey(character, characterId);
    const expectedPreview = previewVoiceIdFor(realVoiceId);
    const previewVoiceId =
      typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '';
    if (previewVoiceId !== expectedPreview) {
      return res.status(400).json({ error: `previewVoiceId must be "${expectedPreview}".` });
    }
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    if (!sampleVoiceId) return res.status(400).json({ error: '`sampleVoiceId` is required.' });
    if (!isTtsModelKey(body.modelKey)) {
      return res
        .status(400)
        .json({ error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}` });
    }
    const modelKey = body.modelKey;

    /* Move the staged embedding onto the stable id. rm-then-rename so a Windows
       rename over an existing file can't EPERM. A missing preview `.pt` means
       nothing was staged (e.g. a double-promote) → 409. */
    try {
      await rm(qwenVoicePtPath(realVoiceId), { force: true });
      await rename(qwenVoicePtPath(previewVoiceId), qwenVoicePtPath(realVoiceId));
    } catch (e) {
      return res
        .status(409)
        .json({ error: `No staged preview voice to promote (${(e as Error).message}).` });
    }
    await rm(qwenVoiceSidecarPath(realVoiceId), { force: true }).catch(() => {});
    await rename(qwenVoiceSidecarPath(previewVoiceId), qwenVoiceSidecarPath(realVoiceId)).catch(
      () => {},
    );

    /* Refresh the cached audition under the real id (same text, voiceName flips
       preview → real). Best-effort — a miss just means the next "Play 12s"
       synthesises fresh from the promoted `.pt`. */
    const calibrationText = buildSampleText(toVoiceLike(character), buildHintFromCast(character));
    const previewMp3 = voiceSampleFilePath(
      voiceSampleFileName({
        cacheScope: sampleVoiceId,
        modelKey,
        text: calibrationText,
        voiceName: previewVoiceId,
      }),
    );
    const realFileName = voiceSampleFileName({
      cacheScope: sampleVoiceId,
      modelKey,
      text: calibrationText,
      voiceName: realVoiceId,
    });
    await copyFile(previewMp3, voiceSampleFilePath(realFileName)).catch(() => {});
    await rm(previewMp3, { force: true }).catch(() => {});

    /* Evict the real id from the sidecar's in-memory prompt cache. Best-effort:
       a down/empty sidecar has nothing cached, and generation reads the fresh
       `.pt` from disk regardless. */
    try {
      await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: realVoiceId }),
      });
    } catch {
      /* sidecar unreachable — non-fatal */
    }

    /* srv-43 — return voiceUuid so the drawer can stamp it locally; the
       /sample player needs it to hit the uuid-keyed cache on the next play. */
    return res
      .status(200)
      .json({ voiceId: realVoiceId, url: voiceSamplePublicUrl(realFileName), voiceUuid: character.voiceUuid });
  },
);

/* POST /api/books/:bookId/cast/:characterId/discard-voice

   Plan 161 — drop a staged preview design (Cancel in the A/B compare).
   Best-effort cleanup of the preview `.pt`/`.json` + its cached audition;
   never touches the live voice. Body: `{ previewVoiceId, sampleVoiceId?,
   modelKey? }`. Always 200 `{ ok: true }` once the id is validated. */
qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/discard-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      previewVoiceId?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
    };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    const expectedPreview = previewVoiceIdFor(qwenStorageKey(character, characterId));
    const previewVoiceId =
      typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '';
    if (previewVoiceId !== expectedPreview) {
      return res.status(400).json({ error: `previewVoiceId must be "${expectedPreview}".` });
    }

    await rm(qwenVoicePtPath(previewVoiceId), { force: true }).catch(() => {});
    await rm(qwenVoiceSidecarPath(previewVoiceId), { force: true }).catch(() => {});
    if (typeof body.sampleVoiceId === 'string' && isTtsModelKey(body.modelKey)) {
      const calibrationText = buildSampleText(toVoiceLike(character), buildHintFromCast(character));
      const previewMp3 = voiceSampleFilePath(
        voiceSampleFileName({
          cacheScope: body.sampleVoiceId.trim(),
          modelKey: body.modelKey,
          text: calibrationText,
          voiceName: previewVoiceId,
        }),
      );
      await rm(previewMp3, { force: true }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  },
);

/* DELETE /api/books/:bookId/cast/:characterId/emotion-variant/:emotion

   fs-34 (fs-25 Wave 5e) — drop a designed emotion variant. Removes the
   `overrideTtsVoices.qwen.variants[emotion]` slot from cast.json and deletes the
   variant's `.pt` + `.json` on disk, so a bad design is discardable without
   touching the base voice. The base `qwen.name` and every other variant are
   preserved; an empty `variants` map is cleaned up so the Variants badge clears.
   Idempotent: removing an absent variant still returns 200. */
qwenVoiceRouter.delete(
  '/:bookId/cast/:characterId/emotion-variant/:emotion',
  async (req: Request, res: Response) => {
    const { bookId, characterId, emotion } = req.params;

    if (!(VARIANT_EMOTIONS as readonly string[]).includes(emotion)) {
      return res.status(400).json({
        error: `emotion must be one of: ${VARIANT_EMOTIONS.join(', ')}`,
      });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character || !cast) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    /* Drop the slot from cast.json (preserving base + sibling variants). */
    const qwenSlot = character.overrideTtsVoices?.qwen;
    if (qwenSlot?.variants && emotion in qwenSlot.variants) {
      delete qwenSlot.variants[emotion as Exclude<Emotion, 'neutral'>];
      if (Object.keys(qwenSlot.variants).length === 0) delete qwenSlot.variants;
      await writeJsonAtomic(castJsonPath(located.bookDir), cast);
    }

    /* Delete the designed embedding + its persona sidecar (best-effort). */
    const designedId = `${qwenStorageKey(character, characterId)}__${emotion}`;
    await rm(qwenVoicePtPath(designedId), { force: true }).catch(() => {});
    await rm(qwenVoiceSidecarPath(designedId), { force: true }).catch(() => {});

    /* Evict from the sidecar's in-memory prompt cache (best-effort). */
    try {
      await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: designedId }),
      });
    } catch {
      /* sidecar unreachable — non-fatal */
    }

    return res.status(200).json({ ok: true, removed: emotion });
  },
);
