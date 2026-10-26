/* Gemini voice-style persona generator (plan 108). Mocks @google/genai's
   non-streaming generateContent and the Gemini-key resolver; asserts:
     - the prompt carries the profile (gender/age/role/description/tone)
       AND the dialogue evidence quotes
     - the call is pinned to gemini-3.1-flash-lite (env-overridable)
     - the model's output is cleaned (fences, label, wrapping quotes stripped)
     - a missing API key throws a clear message before any network call
   No network — the SDK is stubbed.

   Task A: buildVoiceStylePrompt is now async (reads the skill .md). The
   node:fs/promises readFile is mocked to return a canonical skill text so
   the test never touches the real filesystem and verifies the static
   instruction is sourced from the file. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzerRateLimiter } from './rate-limit.js';
import { registerKnownSecretsProvider } from './known-secrets-gate.js';
import { PERSONA_ABSOLUTE_MAX_MS } from './ollama.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import {
  resolveVoiceStyleModel,
  resolvePersonaSelection,
  resolvePersonaLocalModel,
  personaSharesGpu,
  generateVoiceStylePersona,
} from './voice-style.js';

const generateContentStream = vi.fn();

/* Keep the importOriginal spread: gemini-transport.ts imports ApiError and uses it at runtime (redactGeminiError). */
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    models = { generateContentStream };
  },
}));

async function* stream(items: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const item of items) yield item;
}
const STOP = (text: string) => stream([{ text, candidates: [{ finishReason: 'STOP' }] }]);

let mockApiKey: string | null = 'test-key';
let mockSettingsPatch: Record<string, unknown> = {};
vi.mock('../workspace/user-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/user-settings.js')>();
  return {
    ...actual,
    getResolvedGeminiApiKey: () => mockApiKey,
    readConfigOverrides: () => ({}),
    getCachedUserSettings: () => ({ ...actual.DEFAULT_USER_SETTINGS, ...mockSettingsPatch }),
  };
});
vi.mock('../config/ollama-resolved.js', () => ({
  getResolvedOllamaModel: () => 'llama2',
  getResolvedOllamaUrl: () => 'http://127.0.0.1:11434',
}));

function ENDPOINT(over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint {
  return {
    id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:18080/v1', gpu: 'none', concurrency: 1,
    requestCeilingMs: 1_800_000, structuredOutput: 'schema', reasoningStyle: 'not_controllable',
    reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 32768, ...over,
  };
}

// vi.hoisted: this test file has a static top-level `import ... from './voice-style.js'`
// (above), which transitively imports '../config/resolver.js'. That means the resolver's
// vi.mock factory below runs while THIS file's own module graph is still resolving —
// before any plain top-level `const`/`let` here has executed. A bare
// `const configValueMock = vi.fn()` / `let realConfigValue` referenced from inside the
// factory hits a TDZ ReferenceError at that point (verified). vi.hoisted is the
// established fix for exactly this ordering (cf. `gpu-load.test.ts`,
// `mp3-spawn-args.test.ts`): it hoists the variable creation itself above the mock
// registrations, so the factory always sees initialized bindings.
const { configValueMock, realConfigValueRef } = vi.hoisted(() => ({
  configValueMock: vi.fn(), // proven pattern here — cf. `generateContent` at line 24
  realConfigValueRef: { current: undefined as ((key: string) => unknown) | undefined },
}));
function delegateConfigValue(key: string) {
  if (key === 'analyzer.personaGeneration.engine') return process.env.PERSONA_GEN_ENGINE || 'gemini';
  if (key === 'analyzer.personaGeneration.localModel') return process.env.PERSONA_GEN_LOCAL_MODEL || '';
  return realConfigValueRef.current!(key); // real impl for analyzer.gemini.voiceStyleModel
}
vi.mock('../config/resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/resolver.js')>();
  realConfigValueRef.current = actual.configValue;
  configValueMock.mockImplementation(delegateConfigValue);
  return { ...actual, configValue: configValueMock };
});

/* Canonical static instruction text — matches the content of
   skills/audiobook-voice-style.md so the assertions below are stable
   even if the real file path changes. Swap out readFile so the test
   is filesystem-independent. */
const SKILL_TEXT = `You design voices for an audiobook. From the character profile below, write ONE voice-design persona that a text-to-speech model will use to synthesise this character's voice. Describe how the voice SOUNDS, then end with a short purpose clause.

Cover these dimensions: gender, apparent age, pitch (high / medium / low), speaking pace, timbre (e.g. warm, crisp, rich, gravelly, bright), and the dominant emotional register. State the apparent age with a concrete word or band ("a child of about eight", "a man in his seventies", "an elderly woman") — never leave it implied. End with the use — "suitable for audiobook narration" for a narrator, otherwise "for expressive character dialogue".

Make age audible, not just stated — translate it into how the voice physically sounds:
- Elderly / old: pair the explicit age word with aging acoustics — a dry rasp or gravel, a thinner, reedier or breathier edge, and often a faint tremor or quaver — at a slower, more deliberate pace. Do NOT describe an old voice as merely "deep"; age tends to thin and fray a voice rather than deepen it.
- Child / young: brighter, higher, lighter and more energetic.
- Middle-aged: fuller and steadier, without the fraying of age.

Rules:
- Output ONLY the persona. No preamble, no quotes, no markdown, no name.
- One to three sentences, roughly 15–40 words. Every word must add a voice quality — don't repeat synonyms.
- Combine multiple dimensions and be specific ("deep", "crisp", "fast-paced"), never vague ("nice").
- Describe physical, perceptual voice qualities — NOT the character's feelings, backstory, or plot.
- Don't imitate a real or famous person.
- English.

Example (teenager): A bright teenage girl's voice, medium-high pitch and mid-paced, warm and lightly playful with a faintly nervous edge, suited to expressive character dialogue.
Example (elderly man): An elderly man's voice in his seventies, low-to-medium pitch and gravelly, with a dry rasp and a faint tremor; slow and deliberate, carrying worn, unshakable authority, for expressive character dialogue.`;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
      const p = String(args[0]);
      if (p.endsWith('audiobook-voice-style.md')) return Promise.resolve(SKILL_TEXT);
      return actual.readFile(...args);
    }),
  };
});

const MAERIN: CastCharacter = {
  id: 'maerin',
  name: 'Maerin',
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
  generateContentStream.mockReset();
  analyzerRateLimiter._reset();
  mockApiKey = 'test-key';
  mockSettingsPatch = {};
  delete process.env.VOICE_STYLE_MODEL;
  generateContentStream.mockImplementation(async () =>
    STOP('a poised, confident teenage girl, warm and a little playful, mid-paced'),
  );
  configValueMock.mockClear();                          // reset call history (impl-preserving)
  configValueMock.mockImplementation(delegateConfigValue);
});

describe('buildVoiceStylePrompt', () => {
  it('includes the profile fields and the dialogue evidence quotes', async () => {
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = await buildVoiceStylePrompt(MAERIN);
    expect(prompt).toContain('Maerin');
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

  it('sources the static instruction from the skill .md file', async () => {
    /* Task A assertion: the known phrases from SKILL_TEXT are present,
       confirming the prompt is built from the .md rather than inline code. */
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = await buildVoiceStylePrompt(MAERIN);
    expect(prompt).toContain('You design voices for an audiobook');
    expect(prompt).toContain('Character profile:');
    expect(prompt).toContain('Voice-design persona:');
  });

  it('requests the official Qwen VoiceDesign format (pitch, purpose clause, objectivity)', async () => {
    /* Plan 160: the persona must mirror Qwen3-TTS's VoiceDesign guidance —
       a 15–40-word descriptive sentence covering pitch + the other voice
       dimensions and ending with a purpose/scenario clause, written as
       objective voice qualities rather than the character's feelings/plot. */
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = await buildVoiceStylePrompt(MAERIN);
    /* Pitch is the dimension the old prompt omitted. */
    expect(prompt).toMatch(/pitch/i);
    /* A purpose/scenario clause is requested + exemplified. */
    expect(prompt).toMatch(/audiobook narration|character dialogue/i);
    /* Objectivity principle: voice qualities, not feelings/backstory/plot. */
    expect(prompt).toMatch(/NOT the character's feelings/i);
    /* The 15–40-word length band replaces the old "~30 words" cap. */
    expect(prompt).toMatch(/15\s*[–-]\s*40 words/);
  });

  it('instructs the model to make age audible (explicit age word + aging acoustics, not just "deep")', async () => {
    /* Master Oduvan regression: an elderly profile produced a persona with no
       age word and a "deep-pitched" cue, which Qwen VoiceDesign reads as a
       prime-age baritone. The prompt must (a) demand an explicit age word and
       (b) translate age into acoustics — including the guard against describing
       an old voice as merely "deep". */
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = await buildVoiceStylePrompt(MAERIN);
    /* Age must be stated explicitly, not left implied. */
    expect(prompt).toMatch(/apparent age with a concrete word or band/i);
    /* Age must be translated into how the voice physically sounds. */
    expect(prompt).toMatch(/Make age audible/i);
    /* Elderly voices carry aging acoustics (tremor/quaver). */
    expect(prompt).toMatch(/tremor|quaver/i);
    /* The anti-"deep" guard — the exact thing that broke Oduvan. */
    expect(prompt).toMatch(/do NOT describe an old voice as merely "deep"/i);
  });

  it('caps the quote block so a chatty character cannot blow out the prompt', async () => {
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const chatty: CastCharacter = {
      id: 'chatty',
      name: 'Chatty',
      evidence: Array.from({ length: 20 }, (_, i) => ({ quote: `line ${i}` })),
    };
    const prompt = await buildVoiceStylePrompt(chatty);
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
    expect(cleanPersona('Voice style: "a warm voice"')).toBe('a warm voice');
  });

  it('collapses multi-line output into a single instruct line', async () => {
    const { cleanPersona } = await import('./voice-style.js');
    expect(cleanPersona('a warm,\n  steady\nvoice')).toBe('a warm, steady voice');
  });

  describe('cleanPersona <think> guard', () => {
    it('strips a leading <think>…</think> block a local thinking model may emit', async () => {
      const { cleanPersona } = await import('./voice-style.js');
      const raw = '<think>The character is a gruff miner, so low pitch…</think>\nA gruff, low-pitched man\'s voice, slow and weary, for audiobook narration.';
      expect(cleanPersona(raw)).toBe(
        "A gruff, low-pitched man's voice, slow and weary, for audiobook narration.",
      );
    });

    it('leaves a persona with no think block unchanged', async () => {
      const { cleanPersona } = await import('./voice-style.js');
      const raw = 'A bright teenage girl\'s voice, medium-high pitch, for audiobook narration.';
      expect(cleanPersona(raw)).toBe(raw);
    });
  });
});

describe('persona generation config', () => {
  const ENV_KEYS = ['VOICE_STYLE_MODEL', 'PERSONA_GEN_ENGINE', 'PERSONA_GEN_LOCAL_MODEL'];
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.restoreAllMocks();
  });

  it('resolveVoiceStyleModel reflects the registry default and an env override', () => {
    expect(resolveVoiceStyleModel()).toBe('gemini-3.1-flash-lite'); // registry default, not a code literal
    process.env.VOICE_STYLE_MODEL = 'gemini-3.1-pro';
    expect(resolveVoiceStyleModel()).toBe('gemini-3.1-pro');
    // Revert-proof: prove it reads the registry KEY, not process.env directly.
    resolveVoiceStyleModel();
    expect(configValueMock).toHaveBeenCalledWith('analyzer.gemini.voiceStyleModel');
  });

  it('resolvePersonaSelection: gemini by default, local, and an endpoint model id', () => {
    expect(resolvePersonaSelection()).toEqual({ engine: 'gemini', model: 'gemini-3.1-flash-lite' });
    process.env.PERSONA_GEN_ENGINE = 'local';
    expect(resolvePersonaSelection()).toEqual({ engine: 'local', model: 'llama2' });
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3-30b';
    expect(resolvePersonaSelection()).toEqual({ engine: 'openai', endpointId: 'lab', model: 'qwen3-30b' });
  });

  it('resolvePersonaLocalModel: blank inherits the analyzer model; explicit wins', async () => {
    const { getResolvedOllamaModel } = await import('../config/ollama-resolved.js');
    expect(resolvePersonaLocalModel()).toBe(getResolvedOllamaModel()); // blank ⇒ inherit
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:9b';
    expect(resolvePersonaLocalModel()).toBe('qwen3.5:9b');
  });
});

describe('personaSharesGpu', () => {
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    delete process.env.QWEN_DEVICE;
    mockSettingsPatch = {};
  });
  const onEndpoint = (gpu: string) => {
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT({ gpu })] };
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
  };

  it("local shares the GPU (today's rule); gemini never does", () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    expect(personaSharesGpu()).toBe(true);
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    expect(personaSharesGpu()).toBe(false);
  });

  it('an endpoint on no card does not share; one on any card does', () => {
    onEndpoint('none');
    expect(personaSharesGpu()).toBe(false);
    onEndpoint('any');
    expect(personaSharesGpu()).toBe(true);
  });

  it('an endpoint pinned to a card shares only with a Qwen on that card (unknown card fails closed)', () => {
    onEndpoint('cuda:1');
    process.env.QWEN_DEVICE = 'cuda:1';
    expect(personaSharesGpu()).toBe(true);
    process.env.QWEN_DEVICE = 'cuda:0';
    expect(personaSharesGpu()).toBe(false);
    process.env.QWEN_DEVICE = 'cpu';
    expect(personaSharesGpu()).toBe(false);
    process.env.QWEN_DEVICE = 'auto';
    expect(personaSharesGpu()).toBe(true);
  });

  it('an endpoint id missing from settings fails closed', () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:gone::qwen3';
    expect(personaSharesGpu()).toBe(true);
  });

  it('an endpoint on any card shares only with a Qwen on a card (W3d same-card rule)', () => {
    onEndpoint('any');
    process.env.QWEN_DEVICE = 'cpu';
    expect(personaSharesGpu()).toBe(false);
    process.env.QWEN_DEVICE = 'cuda:1';
    expect(personaSharesGpu()).toBe(true);
  });
});

describe('generateVoiceStylePersona — gemini', () => {
  it('pins the model to gemini-3.1-flash-lite and returns the cleaned persona', async () => {
    const persona = await generateVoiceStylePersona(MAERIN);
    expect(persona).toBe('a poised, confident teenage girl, warm and a little playful, mid-paced');
    expect(generateContentStream).toHaveBeenCalledTimes(1);
    const call = generateContentStream.mock.calls[0][0] as { model: string; contents: unknown };
    expect(call.model).toBe('gemini-3.1-flash-lite');
    expect(JSON.stringify(call.contents)).toContain('Maerin');
  });

  it('honours the VOICE_STYLE_MODEL env override', async () => {
    process.env.VOICE_STYLE_MODEL = 'gemini-3-flash-preview';
    await generateVoiceStylePersona(MAERIN);
    expect((generateContentStream.mock.calls[0][0] as { model: string }).model).toBe('gemini-3-flash-preview');
    delete process.env.VOICE_STYLE_MODEL;
  });

  it('cleans a fenced/labelled model response', async () => {
    generateContentStream.mockImplementation(async () =>
      STOP('```\nPersona: a warm, gravelly older man, slow and weary\n```'),
    );
    await expect(generateVoiceStylePersona(MAERIN)).resolves.toBe('a warm, gravelly older man, slow and weary');
  });

  it('throws a clear message when no Gemini API key resolves (no network call)', async () => {
    mockApiKey = null;
    await expect(generateVoiceStylePersona(MAERIN)).rejects.toThrow(/GEMINI_API_KEY is required/);
    expect(generateContentStream).not.toHaveBeenCalled();
    mockApiKey = 'test-key';
  });

  it('throws when the model returns an empty persona', async () => {
    generateContentStream.mockImplementation(async () => STOP('   '));
    await expect(generateVoiceStylePersona(MAERIN)).rejects.toThrow(/empty persona/);
  });

  it("acquires the limiter with today's estimate: ceil(prompt.length / 4) + 200", async () => {
    const acquire = vi.spyOn(analyzerRateLimiter, 'acquire');
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = await buildVoiceStylePrompt(MAERIN);
    await generateVoiceStylePersona(MAERIN);
    expect(acquire.mock.calls[0][0]).toBe('gemini-3.1-flash-lite');
    expect(acquire.mock.calls[0][1]).toBe(Math.ceil(prompt.length / 4) + 200);
    acquire.mockRestore();
  });
});

const CHAR = { id: 'miner', name: 'Old Tom' } as CastCharacter;

describe('generateVoiceStylePersona — local and endpoint dispatch', () => {
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    mockApiKey = 'test-key';
    mockSettingsPatch = {};
    vi.restoreAllMocks();
  });
  const DONE = (text: string) => ({ text, reasoningSeen: false, finish: 'stop' as const, receivedBytes: text.length });

  it('local: one free-text request through the Ollama transport with the caller placement; never Gemini', async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const send = vi.spyOn(OllamaTransport.prototype, 'send').mockResolvedValue(DONE("A weary miner's voice."));
    await expect(generateVoiceStylePersona(CHAR, { onCpu: true, keepAlive: 300 })).resolves.toBe("A weary miner's voice.");
    expect(send).toHaveBeenCalledOnce();
    const req = send.mock.calls[0][0];
    expect(req.structuredOutput).toEqual({ mode: 'off' });
    expect(req.freeText).toEqual({ onCpu: true, keepAlive: 300, absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS });
    expect(req.temperature).toBe(0.2); // analyzer.ollama.temperature default — main's persona call sent it
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('local with the daemon down throws LocalUnreachableError (no Gemini fallback)', async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const { LocalUnreachableError } = await import('./ollama.js');
    vi.spyOn(OllamaTransport.prototype, 'send').mockRejectedValue(new LocalUnreachableError('Ollama unreachable'));
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(LocalUnreachableError);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('endpoint: routes through OpenAITransport with no Ollama placement and no temperature', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT()] };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const send = vi.spyOn(OpenAITransport.prototype, 'send').mockResolvedValue(DONE('A calm voice.'));
    await expect(generateVoiceStylePersona(CHAR, { onCpu: true, keepAlive: 300 })).resolves.toBe('A calm voice.');
    const req = send.mock.calls[0][0];
    expect(req.freeText).toEqual({ absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS }); // no onCpu / keepAlive for an endpoint
    expect(req.temperature).toBeUndefined();
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('endpoint missing from settings → AnalyzerEndpointMissingError(source persona) before any call', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:gone::qwen3';
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const { AnalyzerEndpointMissingError } = await import('./errors.js');
    const send = vi.spyOn(OpenAITransport.prototype, 'send');
    const err = (await generateVoiceStylePersona(CHAR).catch((e: unknown) => e)) as InstanceType<typeof AnalyzerEndpointMissingError>;
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err.endpointId).toBe('gone');
    expect(err.source).toBe('persona');
    expect(send).not.toHaveBeenCalled();
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('endpoint key stored for another origin → AnalyzerKeyOriginError before any call', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = {
      analyzerEndpoints: [ENDPOINT()],
      analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.9:18080', key: 'sk-test' } },
    };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const { AnalyzerKeyOriginError } = await import('./errors.js');
    const send = vi.spyOn(OpenAITransport.prototype, 'send');
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(AnalyzerKeyOriginError);
    expect(send).not.toHaveBeenCalled();
  });

  it('an unreachable endpoint propagates AnalyzerUnreachableError (no Gemini fallback)', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT()] };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const { AnalyzerUnreachableError } = await import('./errors.js');
    vi.spyOn(OpenAITransport.prototype, 'send').mockRejectedValue(new AnalyzerUnreachableError('Lab is unreachable', 'openai'));
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(AnalyzerUnreachableError);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('forwards the caller abort signal to the transport request (every engine)', async () => {
    const ac = new AbortController();
    process.env.PERSONA_GEN_ENGINE = 'local';
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const ollamaSend = vi.spyOn(OllamaTransport.prototype, 'send').mockResolvedValue(DONE('A voice.'));
    await generateVoiceStylePersona(CHAR, { onCpu: false, keepAlive: 0, signal: ac.signal });
    expect(ollamaSend.mock.calls[0][0].signal).toBe(ac.signal);
    expect(ollamaSend.mock.calls[0][0].freeText).toEqual({ onCpu: false, keepAlive: 0, absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS });

    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT()] };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const openaiSend = vi.spyOn(OpenAITransport.prototype, 'send').mockResolvedValue(DONE('A voice.'));
    await generateVoiceStylePersona(CHAR, { signal: ac.signal });
    expect(openaiSend.mock.calls[0][0].signal).toBe(ac.signal);
  });
});

describe('generateVoiceStylePersona gemini branch redaction (#3084 P22)', () => {
  const SECRET = 'AIzaSy-persona-echo-secret-1';
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    registerKnownSecretsProvider({ known: () => [], load: async () => [] });
  });

  it('an error whose message echoes a saved secret reaches the caller redacted, as the Ollama persona path does', async () => {
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    registerKnownSecretsProvider({ known: () => [SECRET], load: async () => [SECRET] });
    vi.spyOn(analyzerRateLimiter, 'acquire').mockResolvedValue(undefined as any);
    generateContentStream.mockRejectedValue(new Error(`upstream said key ${SECRET} is invalid`));
    const err = await generateVoiceStylePersona(CHAR).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe('upstream said key [redacted] is invalid');
    expect(`${(err as Error).stack}`).not.toContain(SECRET);
  });

  it('an error with no secret in it is rethrown as the same object', async () => {
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    vi.spyOn(analyzerRateLimiter, 'acquire').mockResolvedValue(undefined as any);
    const upstream = new Error('quota exceeded');
    generateContentStream.mockRejectedValue(upstream);
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBe(upstream);
  });
});

describe("persona generation reads its own model's reasoning entry (#3084 wave 5, P18)", () => {
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    delete process.env.PERSONA_GEN_LOCAL_MODEL;
    mockSettingsPatch = {};
    vi.restoreAllMocks();
  });

  it("the persona local model sends its own entry, not another model's", async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    mockSettingsPatch = { analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'on', 'qwen3.5:9b': 'model-default' } } };
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const send = vi
      .spyOn(OllamaTransport.prototype, 'send')
      .mockResolvedValue({ text: 'A voice.', reasoningSeen: false, finish: 'stop', receivedBytes: 8 });
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:9b';
    await generateVoiceStylePersona(CHAR);
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:4b';
    await generateVoiceStylePersona(CHAR);
    expect(send.mock.calls.map(([sent]) => sent.reasoning)).toEqual(['model-default', 'on']);
  });
});
