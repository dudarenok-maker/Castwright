/* Gemini voice-style persona generator (plan 108). Mocks @google/genai's
   non-streaming generateContent and the Gemini-key resolver; asserts:
     - the prompt carries the profile (gender/age/role/description/tone)
       AND the dialogue evidence quotes
     - the call is pinned to gemini-3.1-flash-lite (env-overridable)
     - the model's output is cleaned (fences, label, wrapping quotes stripped)
     - a missing API key throws a clear message before any network call
   No network — the SDK is stubbed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { geminiRateLimiter } from './rate-limit.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

const generateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

let mockApiKey: string | null = 'test-key';
vi.mock('../workspace/user-settings.js', () => ({
  getResolvedGeminiApiKey: () => mockApiKey,
}));

const BIANA: CastCharacter = {
  id: 'biana',
  name: 'Biana',
  role: 'protagonist',
  gender: 'female',
  ageRange: 'teen',
  description: 'A poised, fashionable girl who hides insecurity behind confidence.',
  tone: { warmth: 70, pace: 55, authority: 60, emotion: 65 },
  evidence: [
    { quote: 'I can handle myself, thanks.' },
    { quote: "Don't look at me like that." },
    'You really think I would forget?',
  ],
};

beforeEach(() => {
  generateContent.mockReset();
  geminiRateLimiter._reset();
  mockApiKey = 'test-key';
  delete process.env.VOICE_STYLE_MODEL;
  generateContent.mockResolvedValue({
    text: 'a poised, confident teenage girl, warm and a little playful, mid-paced',
  });
});

describe('buildVoiceStylePrompt', () => {
  it('includes the profile fields and the dialogue evidence quotes', async () => {
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = buildVoiceStylePrompt(BIANA);
    expect(prompt).toContain('Biana');
    expect(prompt).toContain('protagonist');
    expect(prompt).toContain('female');
    expect(prompt).toContain('teen');
    expect(prompt).toContain('hides insecurity');
    /* Tone glossed into words (warmth 70 → warm, pace 55 → mid-paced). */
    expect(prompt).toContain('warm');
    expect(prompt).toContain('mid-paced');
    /* The dialogue quotes are the strongest signal — they must be present. */
    expect(prompt).toContain('I can handle myself, thanks.');
    expect(prompt).toContain('You really think I would forget?');
    /* Output-shape instruction so the model returns ONLY the persona. */
    expect(prompt).toMatch(/Output ONLY/i);
  });

  it('requests the official Qwen VoiceDesign format (pitch, purpose clause, objectivity)', async () => {
    /* Plan 160: the persona must mirror Qwen3-TTS's VoiceDesign guidance —
       a 15–40-word descriptive sentence covering pitch + the other voice
       dimensions and ending with a purpose/scenario clause, written as
       objective voice qualities rather than the character's feelings/plot. */
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = buildVoiceStylePrompt(BIANA);
    /* Pitch is the dimension the old prompt omitted. */
    expect(prompt).toMatch(/pitch/i);
    /* A purpose/scenario clause is requested + exemplified. */
    expect(prompt).toMatch(/audiobook narration|character dialogue/i);
    /* Objectivity principle: voice qualities, not feelings/backstory/plot. */
    expect(prompt).toMatch(/NOT the character's feelings/i);
    /* The 15–40-word length band replaces the old "~30 words" cap. */
    expect(prompt).toMatch(/15\s*[–-]\s*40 words/);
  });

  it('caps the quote block so a chatty character cannot blow out the prompt', async () => {
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const chatty: CastCharacter = {
      id: 'chatty',
      name: 'Chatty',
      evidence: Array.from({ length: 20 }, (_, i) => ({ quote: `line ${i}` })),
    };
    const prompt = buildVoiceStylePrompt(chatty);
    expect(prompt).toContain('line 0');
    expect(prompt).toContain('line 5');
    /* Only the first 6 quotes are kept. */
    expect(prompt).not.toContain('line 6');
  });
});

describe('cleanPersona', () => {
  it('strips code fences, a leading label, and wrapping quotes', async () => {
    const { cleanPersona } = await import('./voice-style.js');
    expect(cleanPersona('```\na warm voice\n```')).toBe('a warm voice');
    expect(cleanPersona('Persona: a warm voice')).toBe('a warm voice');
    expect(cleanPersona('"a warm voice"')).toBe('a warm voice');
    expect(cleanPersona('Voice style: “a warm voice”')).toBe('a warm voice');
  });

  it('collapses multi-line output into a single instruct line', async () => {
    const { cleanPersona } = await import('./voice-style.js');
    expect(cleanPersona('a warm,\n  steady\nvoice')).toBe('a warm, steady voice');
  });
});

describe('generateVoiceStylePersona', () => {
  it('pins the model to gemini-3.1-flash-lite and returns the cleaned persona', async () => {
    const { generateVoiceStylePersona } = await import('./voice-style.js');
    const persona = await generateVoiceStylePersona(BIANA);
    expect(persona).toBe(
      'a poised, confident teenage girl, warm and a little playful, mid-paced',
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
    const call = generateContent.mock.calls[0][0] as { model: string; contents: string };
    expect(call.model).toBe('gemini-3.1-flash-lite');
    /* The single call carries this one character's profile only. */
    expect(call.contents).toContain('Biana');
  });

  it('honours the VOICE_STYLE_MODEL env override', async () => {
    process.env.VOICE_STYLE_MODEL = 'gemini-3-flash-preview';
    const { generateVoiceStylePersona } = await import('./voice-style.js');
    await generateVoiceStylePersona(BIANA);
    const call = generateContent.mock.calls[0][0] as { model: string };
    expect(call.model).toBe('gemini-3-flash-preview');
  });

  it('cleans a fenced/labelled model response', async () => {
    generateContent.mockResolvedValue({
      text: '```\nPersona: a warm, gravelly older man, slow and weary\n```',
    });
    const { generateVoiceStylePersona } = await import('./voice-style.js');
    const persona = await generateVoiceStylePersona(BIANA);
    expect(persona).toBe('a warm, gravelly older man, slow and weary');
  });

  it('throws a clear message when no Gemini API key resolves (no network call)', async () => {
    mockApiKey = null;
    const { generateVoiceStylePersona } = await import('./voice-style.js');
    await expect(generateVoiceStylePersona(BIANA)).rejects.toThrow(/GEMINI_API_KEY is required/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('throws when the model returns an empty persona', async () => {
    generateContent.mockResolvedValue({ text: '   ' });
    const { generateVoiceStylePersona } = await import('./voice-style.js');
    await expect(generateVoiceStylePersona(BIANA)).rejects.toThrow(/empty persona/);
  });
});
