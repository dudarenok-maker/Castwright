/* POST /api/voices/:voiceId/sample
   Synthesises a ~12-second voice preview via the TTS provider selected by
   `modelKey` (local sidecar or Gemini) and serves it from the static /audio
   mount. Files are cached on disk keyed by voiceId + modelKey + paramHash,
   so a repeat click is instant and engine-specific. Encoded to MP3 via the
   same `encodePcmToMp3` boundary used by chapter audio (plan 28). */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  engineForModelKey,
  isTtsModelKey,
  selectTtsProvider,
  TTS_MODEL_LABELS,
  type TtsModelKey,
} from '../tts/index.js';
import { encodePcmToMp3 } from '../tts/mp3.js';
import { pcmDurationSec } from '../tts/wav.js';
import { pickVoiceForEngine, type CharacterHint, type VoiceLike } from '../tts/voice-mapping.js';

export const voiceSampleRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
/* Tests override the on-disk cache root via VOICE_SAMPLE_AUDIO_DIR so a run
   doesn't leave files in the dev server's real audio dir. Production uses
   server/audio/voices/ which is also the static mount root in index.ts. */
const AUDIO_DIR = process.env.VOICE_SAMPLE_AUDIO_DIR
  ?? resolve(__dirname, '..', '..', 'audio', 'voices');

/* Sample script. The analyzer ships ≥3 evidence quotes per character,
   sorted longest-first server-side (see analysis.ts sortEvidence) and
   verified against the manuscript by verifyEvidenceAgainstSource. We
   feed the longest *real* quote to the TTS so each preview sounds like
   that character — even if it's short. We never pad with invented text
   (no "X said:" prefix, no canned intro tacked on); a 40-char real line
   beats a 200-char fabricated one for voice cloning. The canned
   "Hello. I'm…" script is only used when the evidence array is
   genuinely empty (brand-new library voices, all-fabricated rosters
   the verifier swept clean). */
const MAX_CHARS = 320;

function buildSampleText(voice: VoiceLike, hint?: CharacterHint): string {
  /* Defensive re-sort — the route also accepts a characterHint from
     the client where the array may not have been through sortEvidence
     (e.g. user edits in the profile drawer that haven't been saved). */
  const cleaned = (hint?.evidence ?? [])
    .map(stripQuoteMarks)
    .filter(s => s.length > 0)
    .sort((a, b) => b.length - a.length);

  const longest = cleaned[0];
  if (longest) {
    return longest.slice(0, MAX_CHARS);
  }

  const name = voice.character?.trim() || 'an unnamed character';
  const attrs = (voice.attributes ?? []).slice(0, 5).join(', ') || 'no particular style';
  return `Hello. I'm ${name}. ${attrs}. Listen — every voice in this book carries the weight of who I am, and every line I speak should sound like it could only have come from me.`;
}

function stripQuoteMarks(s: string): string {
  return s.replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '').trim();
}

/* DJB2 — short deterministic hash for cache filenames. We don't need crypto
   strength; we just need the same (text, voiceName) to map to the same file
   so repeat clicks hit cache, and any change to either bust it. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

voiceSampleRouter.post('/:voiceId/sample', async (req: Request, res: Response) => {
  const { voiceId } = req.params;
  const body = (req.body ?? {}) as { modelKey?: unknown; voice?: VoiceLike; text?: string; characterHint?: CharacterHint };

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
     silently return the previous run's audio. */
  const engine = engineForModelKey(modelKey);
  const text = (body.text && body.text.trim()) || buildSampleText(voice, body.characterHint);
  const voiceName = pickVoiceForEngine(engine, voice, body.characterHint);
  const paramHash = djb2(`${text}|${voiceName}`).toString(36).slice(0, 8);

  const fileName = `${voiceId}-${modelKey}-${paramHash}.mp3`;
  const filePath = resolve(AUDIO_DIR, fileName);
  const publicUrl = `/audio/voices/${fileName}`;

  if (existsSync(filePath)) {
    return res.json({ url: publicUrl, durationSec: null, cached: true, modelKey });
  }

  await mkdir(AUDIO_DIR, { recursive: true });

  let provider;
  try {
    provider = selectTtsProvider(modelKey);
  } catch (err) {
    return res.status(500).json({
      code: 'provider_unavailable',
      message: (err as Error).message,
    });
  }

  console.info(`[tts] ${voiceId} → ${voiceName} (engine=${engine}, model=${modelKey}, ${text.length} chars, hash=${paramHash})`);

  try {
    const { pcm, sampleRate } = await provider.synthesize({ text, voiceName, modelKey });
    /* Compute duration from raw PCM before encode — MP3 frame counting would
       force a probe step. PCM bytes/sec is exact for 16-bit mono. */
    const durationSec = pcmDurationSec(pcm.length, sampleRate);
    const mp3 = await encodePcmToMp3(pcm, sampleRate);
    await writeFile(filePath, mp3);
    return res.json({ url: publicUrl, durationSec, cached: false, modelKey });
  } catch (err) {
    const msg = (err as Error).message ?? 'TTS synthesis failed.';
    /* ffmpeg-not-on-PATH is a deploy issue, not a runtime TTS issue —
       surface it as its own code so the UI can hint at the install fix
       (scripts/start-app.ps1 preflight should normally prevent this). */
    const isEncoderMissing = /Failed to spawn ffmpeg/i.test(msg);
    const isSidecarDown = /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(msg);
    const isRateLimit = /429|rate|quota/i.test(msg);
    const status = isEncoderMissing ? 503 : isSidecarDown ? 503 : isRateLimit ? 429 : 502;
    const code = isEncoderMissing
      ? 'encoder_unavailable'
      : isSidecarDown ? 'sidecar_down'
      : isRateLimit ? 'rate_limited'
      : 'tts_failed';
    return res.status(status).json({ code, message: msg });
  }
});
