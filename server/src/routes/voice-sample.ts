/* POST /api/voices/:voiceId/sample
   Synthesises a ~12-second voice preview via the TTS provider selected by
   `modelKey` (local sidecar or Gemini) and serves it from the static /audio
   mount. Files are cached on disk keyed by voiceId + modelKey, so a repeat
   click is instant and engine-specific. */

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
import { pcmToWav, wavDurationSec } from '../tts/wav.js';
import { pickVoiceForEngine, type CharacterHint, type VoiceLike } from '../tts/voice-mapping.js';

export const voiceSampleRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = resolve(__dirname, '..', '..', 'audio', 'voices');

/* Sample script. When the character has evidence quotes (real manuscript
   lines from the analyzer), pick the one closest to a target reading
   length so each voice actually sounds like *that character* — not a
   generic "Hello, I'm X" recitation. Falls back to a stock intro when
   no evidence is available (e.g. brand-new library voices). */
const TARGET_CHARS = 180;   // ≈12 s at typical English narration pace
const MIN_CHARS    = 80;
const MAX_CHARS    = 320;

function buildSampleText(voice: VoiceLike, hint?: CharacterHint): string {
  const cleaned = (hint?.evidence ?? [])
    .map(stripQuoteMarks)
    .filter(s => s.length >= MIN_CHARS && s.length <= MAX_CHARS);

  if (cleaned.length > 0) {
    cleaned.sort((a, b) => Math.abs(a.length - TARGET_CHARS) - Math.abs(b.length - TARGET_CHARS));
    return cleaned[0];
  }

  /* No usable evidence — at least use the longest available quote if any. */
  const anyQuote = (hint?.evidence ?? [])
    .map(stripQuoteMarks)
    .sort((a, b) => b.length - a.length)[0];
  if (anyQuote && anyQuote.length >= 30) {
    /* Pad short quotes with the character intro so the TTS has enough
       prosody to settle. */
    if (anyQuote.length < MIN_CHARS) {
      const name = voice.character?.trim() ?? '';
      return name ? `${name} said: ${anyQuote}` : anyQuote;
    }
    return anyQuote.slice(0, MAX_CHARS);
  }

  const name = voice.character?.trim() || 'an unnamed character';
  const attrs = (voice.attributes ?? []).slice(0, 5).join(', ') || 'no particular style';
  return `Hello. I'm ${name}. ${attrs}. Listen — every voice in this book carries the weight of who I am, and every line I speak should sound like it could only have come from me.`;
}

function stripQuoteMarks(s: string): string {
  return s.replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '').trim();
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

  const fileName = `${voiceId}-${modelKey}.wav`;
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

  const engine = engineForModelKey(modelKey);
  const text = (body.text && body.text.trim()) || buildSampleText(voice, body.characterHint);
  const voiceName = pickVoiceForEngine(engine, voice, body.characterHint);
  console.info(`[tts] ${voiceId} → ${voiceName} (engine=${engine}, model=${modelKey}, ${text.length} chars)`);

  try {
    const { pcm, sampleRate } = await provider.synthesize({ text, voiceName, modelKey });
    const wav = pcmToWav(pcm, sampleRate);
    await writeFile(filePath, wav);
    const durationSec = wavDurationSec(pcm.length, sampleRate);
    return res.json({ url: publicUrl, durationSec, cached: false, modelKey });
  } catch (err) {
    const msg = (err as Error).message ?? 'TTS synthesis failed.';
    const isSidecarDown = /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(msg);
    const isRateLimit = /429|rate|quota/i.test(msg);
    return res.status(isSidecarDown ? 503 : isRateLimit ? 429 : 502).json({
      code: isSidecarDown ? 'sidecar_down' : isRateLimit ? 'rate_limited' : 'tts_failed',
      message: msg,
    });
  }
});
