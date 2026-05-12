/* Gemini TTS — single-speaker prebuilt-voice synthesis via @google/genai.
   Returns raw PCM bytes (24 kHz, 16-bit signed LE mono per the Gemini docs);
   the caller wraps in WAV before persisting. Model id is resolved per-call
   so the same provider instance can serve both selector options.

   Audio tags: inline bracketed cues (`[whispers]`, `[shouting]`, …) ride
   along inside `text` verbatim. Gemini's respect for them is informal —
   model treats them as suggestive context, not a documented control surface.
   An ElevenLabs v3 adapter (when added) consumes them as documented tags. */

import { GoogleGenAI } from '@google/genai';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import { resolveGeminiModelId } from './index.js';

interface GeminiTtsOptions {
  apiKey: string;
}

export class GeminiTtsProvider implements TtsProvider {
  private readonly client: GoogleGenAI;

  constructor(opts: GeminiTtsOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  async synthesize({ text, voiceName, modelKey }: SynthesizeInput): Promise<SynthesizeOutput> {
    const model = resolveGeminiModelId(modelKey);

    const response = await this.client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
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
