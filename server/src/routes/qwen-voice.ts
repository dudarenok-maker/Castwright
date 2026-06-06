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
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { EMOTIONS, type Emotion } from '../handoff/schemas.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { isTtsModelKey, TTS_MODEL_LABELS } from '../tts/index.js';
import { encodePcmToAudio } from '../tts/mp3.js';
import {
  buildHintFromCast,
  toVoiceLike,
  type CastCharacter,
} from '../tts/synthesise-chapter.js';
import {
  buildSampleText,
  voiceSampleAudioDir,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';

export const qwenVoiceRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

/* Cold voice-design (load VoiceDesign model transiently + generate a
   reference clip + distil the clone prompt) can take noticeably longer
   than a warm synth on first call, so budget generously like the load
   proxy rather than the 2s health probe. The sidecar now voices only the
   short CALIBRATION_TEXT on the heavy 1.7B reference model (the audition
   on the 0.6B Base still speaks the full quote), so a warm design lands in
   ~60-90s — but a cold first-design (1.7B load + CUDA kernel JIT) plus a
   max-length audition can still approach two minutes, so keep headroom. */
const DESIGN_TIMEOUT_MS = 180_000;

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

/* Emotion delivery clause appended to a character's persona when designing an
   emotion variant, so the heavy VoiceDesign model bakes the delivery into the
   variant's cached embedding (Qwen has no synth-time emotion lever). The base
   persona is preserved verbatim; only the delivery is added. */
const EMOTION_INSTRUCT: Record<Exclude<Emotion, 'neutral'>, string> = {
  whisper: 'Delivered in a soft, hushed whisper.',
  angry: 'Delivered angrily, with raised intensity and edge.',
  excited: 'Delivered with bright, energetic excitement.',
  sad: 'Delivered sadly — subdued, downcast, and heavy.',
};

/** Append the emotion delivery clause to a persona for variant design. */
export function buildVariantInstruct(persona: string, emotion: Exclude<Emotion, 'neutral'>): string {
  return `${persona.trim()} ${EMOTION_INSTRUCT[emotion]}`.trim();
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
function qwenVoicePtPath(name: string): string {
  return join(qwenVoicesDir(), `${name}.pt`);
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

    /* Same voiceId resolution as design-voice: an explicit per-character qwen
       override wins, else the stable `qwen-${voiceId}` key (so a REUSED
       character with an empty own override still resolves to its series-shared
       sidecar). */
    const voiceName = character.overrideTtsVoices?.qwen?.name ?? deriveQwenVoiceId(character, characterId);
    const sidecar = await readJson<{ instruct?: string }>(qwenVoiceSidecarPath(voiceName)).catch(
      () => null,
    );
    const instruct = typeof sidecar?.instruct === 'string' ? sidecar.instruct : '';
    return res.status(200).json({ instruct });
  },
);

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
    const sampleVoiceId =
      typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
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
    const baseVoiceId = deriveQwenVoiceId(character, characterId);
    /* A variant is designed under a distinct, stable id so it doesn't overwrite
       the base embedding; re-designing the same emotion overwrites the variant. */
    const designedId = emotion ? `${baseVoiceId}__${emotion}` : baseVoiceId;
    const voiceId = body.preview === true ? previewVoiceIdFor(designedId) : designedId;
    /* For a variant, bake the delivery clause into the persona the heavy
       VoiceDesign model sees. */
    const instructForDesign = emotion ? buildVariantInstruct(persona, emotion) : persona;
    /* The audition speaks the character's own line — the longest evidence
       quote, picked exactly as voice-sample.ts's buildSampleText does, so the
       text component of the cache key matches the player's by construction. */
    const calibrationText = buildSampleText(toVoiceLike(character), buildHintFromCast(character));

    const sidecarUrl = getResolvedSidecarUrl();
    const target = `${sidecarUrl}/qwen/design-voice`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESIGN_TIMEOUT_MS);
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceId,
          instruct: instructForDesign,
          language: designLanguage,
          calibrationText,
        }),
      });
      clearTimeout(timer);
      if (!upstream.ok) {
        let detail = '';
        try {
          /* The sidecar reports failures as FastAPI's `{ detail }` (both its
             HTTPException 4xx and its 500 catch-all), NOT `{ error }`. Reading
             only `.error` here silently dropped the real reason — e.g. a CUDA
             "Cannot copy out of meta tensor" load failure surfaced to the user
             as a bare "returned 500" with no cause. Prefer `detail`, fall back
             to `error` for any endpoint that uses that shape. */
          const body = (await upstream.json()) as { detail?: string; error?: string };
          detail = body.detail ?? body.error ?? '';
        } catch {
          /* not json */
        }
        return res.status(502).json({
          error:
            detail ||
            `Sidecar /qwen/design-voice returned ${upstream.status} ${upstream.statusText}.`,
        });
      }
      const sampleRate = Number(upstream.headers.get('X-Sample-Rate') ?? '24000') || 24000;
      const pcm = Buffer.from(await upstream.arrayBuffer());

      /* Pre-populate the voice-sample cache so the subsequent "Play 12s"
         (and the drawer's own "Play sample") is a hit — no second synth.
         voiceName = the designed voiceId, matching pickVoiceForEngine('qwen',…). */
      const fileName = voiceSampleFileName({
        cacheScope: sampleVoiceId,
        modelKey,
        text: calibrationText,
        voiceName: voiceId,
      });
      const filePath = voiceSampleFilePath(fileName);
      const url = voiceSamplePublicUrl(fileName);
      try {
        /* Always (over)write. Designing is an explicit (re)generate: the
           audition we just synthesised IS the fresh voice. The cache key
           (text + voiceId) is unchanged across re-designs of the same
           character, so a stale file from a prior design must be replaced —
           otherwise "Play 12s" (and the drawer's own post-design playback,
           which reads this same URL) would serve the previous voice and the
           re-design would look like it did nothing. */
        await mkdir(voiceSampleAudioDir(), { recursive: true });
        const mp3 = await encodePcmToAudio(pcm, sampleRate);
        await writeFile(filePath, mp3);
      } catch (encErr) {
        return res.status(502).json({
          error: `Designed the voice but failed to cache its preview: ${(encErr as Error).message}`,
        });
      }
      /* fs-25 — record a (non-preview) emotion variant onto the character's
         qwen slot so generation can resolve it (Wave 2) and the cast UI can show
         the Variants badge. Preserves any existing base `name`; defaults it to
         the derived base id when the slot is fresh so base lines still resolve.
         The base-voice design itself still persists via the drawer's Save. */
      if (emotion && body.preview !== true) {
        character.overrideTtsVoices = character.overrideTtsVoices ?? {};
        const qwenSlot = character.overrideTtsVoices.qwen ?? { name: baseVoiceId };
        qwenSlot.variants = { ...(qwenSlot.variants ?? {}), [emotion]: { name: voiceId } };
        character.overrideTtsVoices.qwen = qwenSlot;
        await writeJsonAtomic(castJsonPath(bookDir), cast);
      }
      console.log(
        `[qwen-voice] book=${bookId} character=${characterId} voiceId=${voiceId} ` +
          `→ cached ${fileName} (${pcm.length} bytes @ ${sampleRate}Hz)`,
      );
      return res.status(200).json({ voiceId, url });
    } catch (e) {
      clearTimeout(timer);
      const err = e as { name?: string; message?: string };
      const isTimeout = err.name === 'AbortError';
      return res.status(502).json({
        error: isTimeout
          ? `Sidecar /qwen/design-voice did not complete within ${DESIGN_TIMEOUT_MS}ms — voice design is unusually slow or the process is stuck.`
          : `TTS sidecar (${sidecarUrl}) is unreachable — ${err.message || 'request failed'}.`,
      });
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

    const realVoiceId = deriveQwenVoiceId(character, characterId);
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
      voiceSampleFileName({ cacheScope: sampleVoiceId, modelKey, text: calibrationText, voiceName: previewVoiceId }),
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

    return res.status(200).json({ voiceId: realVoiceId, url: voiceSamplePublicUrl(realFileName) });
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

    const expectedPreview = previewVoiceIdFor(deriveQwenVoiceId(character, characterId));
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
    const designedId = `${deriveQwenVoiceId(character, characterId)}__${emotion}`;
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
