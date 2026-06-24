/* POST /api/voices/:voiceId/sample
   Synthesises a ~12-second voice preview via the TTS provider selected by
   `modelKey` (local sidecar or Gemini) and serves it from the static /audio
   mount. Files are cached on disk keyed by voiceId + modelKey + paramHash,
   so a repeat click is instant and engine-specific. Encoded to MP3 via the
   same `encodePcmToAudio` boundary used by chapter audio (plan 28). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { safeSegment } from '../util/safe-path.js';
import {
  engineForModelKey,
  isTtsModelKey,
  selectTtsProvider,
  TTS_MODEL_LABELS,
  type TtsEngine,
  type TtsModelKey,
} from '../tts/index.js';
import { encodePcmToAudio } from '../tts/mp3.js';
import { pcmDurationSec } from '../tts/pcm.js';
import { pickVoiceForEngine, type CharacterHint, type VoiceLike } from '../tts/voice-mapping.js';
import {
  buildSampleText,
  djb2,
  voiceSampleAudioDir,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';

export const voiceSampleRouter = Router();

/* Fixed neutral preview script used by the "Base voices" tab and the
   family-header Play buttons. Same text for every (engine, speaker)
   combination so the user can A/B compare without the prompt changing
   under them. Kept short (~12s spoken) to stay under the sidecar's
   synth budget. */
const RAW_SAMPLE_TEXT =
  'Hello — this is the unmodified model voice. ' +
  'Listen for tone, pacing, and pronunciation; ' +
  'no profile attributes have been applied.';

function isTtsEngine(value: unknown): value is TtsEngine {
  return value === 'coqui' || value === 'gemini' || value === 'piper' || value === 'kokoro';
}

/* Pick a sensible modelKey for a given engine when the caller didn't supply
   one that matches. Used by the raw-sample branch: a client clicking Play
   on a Gemini base voice while the project is set to a Coqui modelKey
   shouldn't have to know to re-pick — the server routes via the engine. */
function defaultModelKeyForEngine(engine: TtsEngine): TtsModelKey {
  if (engine === 'gemini') return 'gemini-2.5-flash';
  if (engine === 'piper') return 'piper-en-us-medium';
  if (engine === 'kokoro') return 'kokoro-v1';
  return 'coqui-xtts-v2';
}

voiceSampleRouter.post('/:voiceId/sample', async (req: Request, res: Response) => {
  const { voiceId } = req.params;
  const body = (req.body ?? {}) as {
    modelKey?: unknown;
    voice?: VoiceLike;
    text?: string;
    characterHint?: CharacterHint;
    rawEngine?: unknown;
    rawSpeaker?: unknown;
  };

  if (!isTtsModelKey(body.modelKey)) {
    return res.status(400).json({
      code: 'invalid_model',
      message: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}`,
    });
  }
  const modelKey: TtsModelKey = body.modelKey;
  const voice: VoiceLike = body.voice ?? { id: voiceId };

  /* Compute the synthesis inputs up front so the cache filename can include
     a hash of (text, voiceName). Otherwise an attribute edit (gender, age,
     tone) that picks a different prebuilt voice or evidence line would
     silently return the previous run's audio.

     Raw-sample branch: when the client sets `rawEngine` + `rawSpeaker`, the
     picker is bypassed entirely and the named speaker is synthesised
     directly with the fixed neutral script. The cache key drops the voiceId
     and shifts onto `raw-<engine>-<speaker>` so unused base voices share
     one cache slot across every voiceId path the request happened to land
     on, and so toggling between auto-resolved and raw samples for the same
     voiceId doesn't trample each other. */
  const isRawSample =
    isTtsEngine(body.rawEngine) &&
    typeof body.rawSpeaker === 'string' &&
    body.rawSpeaker.trim().length > 0;

  let engine: TtsEngine;
  let text: string;
  let voiceName: string;
  let cacheScope: string;
  let effectiveModelKey: TtsModelKey = modelKey;
  if (isRawSample) {
    engine = body.rawEngine as TtsEngine;
    voiceName = (body.rawSpeaker as string).trim();
    text = (body.text && body.text.trim()) || RAW_SAMPLE_TEXT;
    cacheScope = `raw-${engine}-${djb2(voiceName).toString(36).slice(0, 6)}`;
    /* The client may have passed any modelKey it had handy (whatever the
       project's currently set to). Re-pick one that actually routes to the
       requested engine, otherwise selectTtsProvider would send a Coqui
       speaker name to the Gemini provider or vice versa. */
    if (engineForModelKey(modelKey) !== engine) {
      effectiveModelKey = defaultModelKeyForEngine(engine);
    }
  } else {
    engine = engineForModelKey(modelKey);
    text = (body.text && body.text.trim()) || buildSampleText(voice, body.characterHint);
    voiceName = pickVoiceForEngine(engine, voice, body.characterHint);
    cacheScope = voiceId;
  }
  const fileName = voiceSampleFileName({ cacheScope, modelKey: effectiveModelKey, text, voiceName });
  const filePath = voiceSampleFilePath(safeSegment(fileName));
  const publicUrl = voiceSamplePublicUrl(fileName);

  if (existsSync(filePath)) {
    return res.json({ url: publicUrl, durationSec: null, cached: true, modelKey });
  }

  await mkdir(voiceSampleAudioDir(), { recursive: true });

  let provider;
  try {
    provider = selectTtsProvider(effectiveModelKey);
  } catch (err) {
    return res.status(500).json({
      code: 'provider_unavailable',
      message: (err as Error).message,
    });
  }

  console.info(
    `[tts] ${cacheScope} → ${voiceName} (engine=${engine}, model=${effectiveModelKey}, ${text.length} chars, file=${fileName})`,
  );

  try {
    const { pcm, sampleRate } = await provider.synthesize({
      text,
      voiceName,
      modelKey: effectiveModelKey,
    });
    /* Compute duration from raw PCM before encode — MP3 frame counting would
       force a probe step. PCM bytes/sec is exact for 16-bit mono. */
    const durationSec = pcmDurationSec(pcm.length, sampleRate);
    /* No loudnorm for voice samples — only chapter audio gets the EBU R128
       pass (plan 71). Voice samples are short auditions where program-level
       normalisation has no listening benefit and would add ~20 % latency to
       every Play-sample click. */
    const mp3 = await encodePcmToAudio(pcm, sampleRate);
    await writeFile(filePath, mp3);
    return res.json({ url: publicUrl, durationSec, cached: false, modelKey });
  } catch (err) {
    const msg = (err as Error).message ?? 'TTS synthesis failed.';
    /* #1063 — the sidecar returns 409 `voice_not_designed` when the requested
       voice/variant has no cached embedding (a bad-input condition, not an
       engine fault). Surface it as a clean 4xx with a distinct code + actionable
       message instead of re-wrapping it as the generic 502 `tts_failed` below,
       so the UI can say "design this voice first". The raw `msg` is the
       "Local voice engine returned 409: {json}" wrapper (sidecar.ts) — we
       replace it with friendly copy rather than echo the JSON body. */
    if (/voice_not_designed|not been designed yet/i.test(msg)) {
      return res.status(409).json({
        code: 'voice_not_designed',
        message:
          'This voice or emotion variant has not been designed yet — design it first, then play the sample.',
      });
    }
    /* ffmpeg-not-on-PATH is a deploy issue, not a runtime TTS issue —
       surface it as its own code so the UI can hint at the install fix
       (scripts/start-app.ps1 preflight should normally prevent this). */
    const isEncoderMissing = /Failed to spawn ffmpeg/i.test(msg);
    const isSidecarDown = /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(msg);
    const isRateLimit = /429|rate|quota/i.test(msg);
    const status = isEncoderMissing ? 503 : isSidecarDown ? 503 : isRateLimit ? 429 : 502;
    const code = isEncoderMissing
      ? 'encoder_unavailable'
      : isSidecarDown
        ? 'sidecar_down'
        : isRateLimit
          ? 'rate_limited'
          : 'tts_failed';
    return res.status(status).json({ code, message: msg });
  }
});
