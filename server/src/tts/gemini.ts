/* Gemini TTS — single-speaker prebuilt-voice synthesis via @google/genai.
   Returns raw PCM bytes (24 kHz, 16-bit signed LE mono per the Gemini docs)
   to the caller; the Node-side encoder turns the PCM into MP3 before
   persisting. Model id is resolved per-call so the same provider instance
   can serve both selector options.

   Audio tags: inline bracketed cues (`[whispers]`, `[shouting]`, …) ride
   along inside `text` verbatim. Gemini's respect for them is informal —
   model treats them as suggestive context, not a documented control surface.
   An ElevenLabs v3 adapter (when added) consumes them as documented tags. */

import { GoogleGenAI } from '@google/genai';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import { resolveGeminiModelId } from './model-keys.js';
import { GEMINI_VOICE_DESCRIPTIONS } from './voice-mapping.js';

interface GeminiTtsOptions {
  apiKey: string;
}

/* Conservative default. Used when the requested voice isn't in the
   documented Gemini prebuilt voice list — likely sign of a cross-engine
   bleed (a Coqui name like "Aaron Dreschner" arriving at the Gemini
   provider). Substituting rather than rejecting keeps the chapter
   generating; the loud warning surfaces the drift. */
const GEMINI_FALLBACK_VOICE = 'Zephyr';

export class GeminiTtsProvider implements TtsProvider {
  private readonly client: GoogleGenAI;

  constructor(opts: GeminiTtsOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  async synthesize({ text, voiceName, modelKey }: SynthesizeInput): Promise<SynthesizeOutput> {
    const model = resolveGeminiModelId(modelKey);

    /* Guard against cross-engine bleed. If `voiceName` isn't a documented
       Gemini prebuilt voice, the API would either reject with a confusing
       error or quietly fall through to a default — both leave the user
       wondering why their Coqui-flavoured catalog name appeared in a
       Gemini run. Substitute and log. */
    let actualVoice = voiceName;
    if (!(voiceName in GEMINI_VOICE_DESCRIPTIONS)) {
      const fallback =
        GEMINI_FALLBACK_VOICE in GEMINI_VOICE_DESCRIPTIONS
          ? GEMINI_FALLBACK_VOICE
          : Object.keys(GEMINI_VOICE_DESCRIPTIONS)[0];
      console.warn(
        `[tts:gemini] Voice "${voiceName}" is not in the Gemini prebuilt voice list — ` +
          `substituting "${fallback}". This usually means a non-Gemini voice name was ` +
          `passed to the Gemini provider (cross-engine bleed). Check that ` +
          `pickVoiceForEngine was called with engine='gemini' for this character.`,
      );
      actualVoice = fallback;
    }

    const response = await this.client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: actualVoice },
          },
        },
      },
    });

    const part = response.candidates?.[0]?.content?.parts?.[0];
    const inline = part?.inlineData;
    if (!inline?.data) {
      throw new Error(`Gemini TTS (${model}) returned no audio data.`);
    }

    const pcm = Buffer.from(inline.data, 'base64');
    const mimeType = inline.mimeType ?? 'audio/L16;codec=pcm;rate=24000';
    const sampleRate = parseRateFromMime(mimeType);

    return { pcm, sampleRate, mimeType };
  }
}

/* Gemini documents the response mime type as e.g. 'audio/L16;codec=pcm;rate=24000'.
   Fall back to 24 kHz if rate is missing — that's the documented default. */
function parseRateFromMime(mime: string): number {
  const m = mime.match(/rate=(\d+)/);
  return m ? Number(m[1]) : 24000;
}
