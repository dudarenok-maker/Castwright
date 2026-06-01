/* Gemini voice-style persona generator (plan 108, Wave 4 dependency).

   Every cast member gets a short natural-language "voice style" persona —
   a Qwen voice-design `instruct` like:
     "A bright teenage girl's voice, medium-high pitch and mid-paced, warm
      and lightly playful with a faintly nervous edge, suited to expressive
      character dialogue."
   The Qwen sidecar designs a bespoke voice FROM such a persona
   (`POST /qwen/design-voice {voiceId, instruct, …}`), so the persona is the
   editable, durable seed of a character's designed voice.

   Locked decisions (user 2026-05-24):
     (a) model is pinned to `gemini-3.1-flash-lite` (env-overridable via
         `VOICE_STYLE_MODEL` for triage) — its own rate-limit bucket,
         500 RPD on the free tier;
     (b) ONE Gemini call PER CHARACTER — never batch multiple characters
         into one prompt, so a persona can't be contaminated by a
         neighbouring character's traits;
     (c) the persona is derived from the character's FULL profile —
         gender, age, role, description, tone metrics, AND their collected
         dialogue evidence quotes (reusing `buildHintFromCast`).

   Every call goes through the shared `geminiRateLimiter` so a generate-all
   batch can't compound into a 429 storm — same discipline as the analyzer's
   stage calls. A Gemini API key is required (same resolution as the
   analyzer); we fail with a clear message when it's absent. */

import { GoogleGenAI } from '@google/genai';
import { buildHintFromCast, type CastCharacter } from '../tts/synthesise-chapter.js';
import { getResolvedGeminiApiKey } from '../workspace/user-settings.js';
import { geminiRateLimiter } from './rate-limit.js';
import { stripCodeFences } from './gemini.js';

/** Pinned voice-style model. `gemini-3.1-flash-lite` per the locked
    decision; env-overridable for ops triage without a rebuild. */
export function resolveVoiceStyleModel(): string {
  const raw = process.env.VOICE_STYLE_MODEL?.trim();
  return raw && raw.length > 0 ? raw : 'gemini-3.1-flash-lite';
}

/* Tone metrics are 0–100. Translate the two that matter most for a voice
   persona (warmth + pace) into plain words so the model anchors on a
   register rather than guessing from raw numbers. Authority/emotion are
   passed through as numbers in the profile block — they nuance the
   description but don't need their own gloss. */
function describeTone(tone: CastCharacter['tone']): string | null {
  if (!tone) return null;
  const parts: string[] = [];
  if (typeof tone.warmth === 'number') {
    parts.push(tone.warmth >= 66 ? 'warm' : tone.warmth <= 33 ? 'cool/detached' : 'neutral warmth');
  }
  if (typeof tone.pace === 'number') {
    parts.push(tone.pace >= 66 ? 'fast-paced' : tone.pace <= 33 ? 'slow, measured' : 'mid-paced');
  }
  if (typeof tone.authority === 'number') {
    parts.push(`authority ${tone.authority}/100`);
  }
  if (typeof tone.emotion === 'number') {
    parts.push(`emotional intensity ${tone.emotion}/100`);
  }
  return parts.length ? parts.join(', ') : null;
}

/* Build the per-character prompt. A short profile block, up to a handful of
   representative dialogue quotes, and an explicit instruction to return ONLY
   the persona. The quotes are the strongest signal for timbre/temperament —
   the model should lean on how the character actually speaks, not just the
   analyzer's labels.

   The requested OUTPUT shape mirrors Qwen3-TTS's official VoiceDesign
   guidance (Alibaba Model Studio docs + the HF model card): a 15–40-word
   descriptive sentence covering gender / age / pitch / pace / timbre / emotion
   that ENDS with a purpose clause ("…for audiobook narration"), and the five
   principles — specificity, multidimensionality, objectivity, originality,
   conciseness. See docs/features/160-voicedesign-persona-format.md. */
export function buildVoiceStylePrompt(character: CastCharacter): string {
  const hint = buildHintFromCast(character);
  const lines: string[] = [];

  lines.push(`Name: ${character.name ?? character.id}`);
  if (hint.role) lines.push(`Role: ${hint.role}`);
  if (hint.gender) lines.push(`Gender: ${hint.gender}`);
  if (hint.ageRange) lines.push(`Age range: ${hint.ageRange}`);
  if (hint.description) lines.push(`Description: ${hint.description}`);
  const tone = describeTone(hint.tone);
  if (tone) lines.push(`Tone metrics: ${tone}`);

  /* Cap the quote block so a chatty character can't blow the prompt out;
     the first handful are enough to characterise the voice, and shorter
     prompts keep the flash-lite call fast + cheap. */
  const quotes = (hint.evidence ?? []).slice(0, 6);
  if (quotes.length) {
    lines.push('');
    lines.push('Dialogue evidence (how this character actually speaks):');
    for (const q of quotes) lines.push(`- "${q}"`);
  }

  return `You design voices for an audiobook. From the character profile below, write ONE voice-design persona that a text-to-speech model will use to synthesise this character's voice. Describe how the voice SOUNDS, then end with a short purpose clause.

Cover these dimensions: gender, apparent age, pitch (high / medium / low), speaking pace, timbre (e.g. warm, crisp, rich, gravelly, bright), and the dominant emotional register. End with the use — "suitable for audiobook narration" for a narrator, otherwise "for expressive character dialogue".

Rules:
- Output ONLY the persona. No preamble, no quotes, no markdown, no name.
- One to three sentences, roughly 15–40 words. Every word must add a voice quality — don't repeat synonyms.
- Combine multiple dimensions and be specific ("deep", "crisp", "fast-paced"), never vague ("nice").
- Describe physical, perceptual voice qualities — NOT the character's feelings, backstory, or plot.
- Don't imitate a real or famous person.
- English.

Example output: A bright teenage girl's voice, medium-high pitch and mid-paced, warm and lightly playful with a faintly nervous edge, suited to expressive character dialogue.

Character profile:
${lines.join('\n')}

Voice-design persona:`;
}

/* Strip anything the model wraps around the persona phrase: code fences,
   a leading "Persona:" label, wrapping quotes, trailing punctuation noise.
   Conservative — collapses internal whitespace/newlines to single spaces
   so a multi-line answer still lands as one clean instruct. */
export function cleanPersona(raw: string): string {
  let s = stripCodeFences(raw).trim();
  /* Drop a leading label like "Persona:" / "Voice:" the model sometimes
     prepends despite the instruction. */
  s = s.replace(/^(voice[- ]?design persona|persona|voice style|voice)\s*[:\-—]\s*/i, '');
  /* Collapse newlines + runs of whitespace into single spaces. */
  s = s.replace(/\s+/g, ' ').trim();
  /* Strip a single wrapping pair of quotes (straight or smart). */
  s = s.replace(/^["'“”']+/, '').replace(/["'“”']+$/, '').trim();
  return s;
}

/** Generate a voice-style persona for ONE character via a single
    `gemini-3.1-flash-lite` call, rate-limited through the shared limiter.
    Throws when no Gemini API key resolves, or when the model returns an
    empty response. */
export async function generateVoiceStylePersona(character: CastCharacter): Promise<string> {
  const apiKey = getResolvedGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is required to generate voice-style personas. ' +
        'Set it from Account → Server configuration → Gemini API key, ' +
        'or in server/.env for CI / power users.',
    );
  }

  const model = resolveVoiceStyleModel();
  const prompt = buildVoiceStylePrompt(character);
  /* Token estimate for the limiter — ~chars/4 plus a flat ceiling margin,
     same heuristic as the analyzer's estimateInputTokens. */
  const estTokens = Math.ceil(prompt.length / 4) + 200;

  await geminiRateLimiter.acquire(model, estTokens);

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: prompt,
  });

  const persona = cleanPersona(response.text ?? '');
  if (!persona) {
    throw new Error(`Voice-style generation for "${character.id}" returned an empty persona.`);
  }
  return persona;
}
