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

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
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
   proxy rather than the 2s health probe. */
const DESIGN_TIMEOUT_MS = 120_000;

/* Stable cache key for the designed voice — keyed on the character's
   voiceId when present (so a series-shared identity reuses one embedding)
   else the local character id. */
export function deriveQwenVoiceId(character: CastCharacter, characterId: string): string {
  return `qwen-${character.voiceId ?? characterId}`;
}

qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/design-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      persona?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
    };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

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

    const voiceId = deriveQwenVoiceId(character, characterId);
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
          instruct: persona,
          language: 'English',
          calibrationText,
        }),
      });
      clearTimeout(timer);
      if (!upstream.ok) {
        let detail = '';
        try {
          detail = ((await upstream.json()) as { error?: string }).error ?? '';
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
        if (!existsSync(filePath)) {
          await mkdir(voiceSampleAudioDir(), { recursive: true });
          const mp3 = await encodePcmToAudio(pcm, sampleRate);
          await writeFile(filePath, mp3);
        }
      } catch (encErr) {
        return res.status(502).json({
          error: `Designed the voice but failed to cache its preview: ${(encErr as Error).message}`,
        });
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
