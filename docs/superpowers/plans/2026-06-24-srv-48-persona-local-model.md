# srv-48 — Local-Model Persona Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `local | gemini` provider toggle for voice-design persona generation (default `gemini`), so a no-Gemini install can design Qwen voices, with all model defaults sourced from the registry instead of hardcoded literals.

**Architecture:** `generateVoiceStylePersona()` becomes a thin dispatcher over a registry-resolved engine. The gemini branch is the existing inline Google-GenAI call (now reading the registry knob); the local branch is a new standalone Ollama helper that bypasses the structured-output `Analyzer` interface. On a constrained (8 GB) GPU the persona call runs on GPU when the sidecar is idle (evicting the idle warm model first) and falls back to CPU while a render is in flight — decided by a shared `resolvePersonaGpuPlan`. The bulk "Design full cast" path adds a `local`-only persona pre-pass; single-design routes the same decision.

**Tech Stack:** TypeScript (server, ES modules), Vitest (node env), Express routes, Ollama HTTP `/api/chat`, the existing `gpuSemaphore` token budget and sidecar `/unload` proxy.

**Spec:** `docs/superpowers/specs/2026-06-24-srv-48-persona-generation-local-model-design.md`

## Global Constraints

- **OpenAPI is the type source of truth** — never hand-write `Character`/`Chapter`/`Sentence`; they come from `src/lib/api-types.ts`. (No API-shape change in this plan.)
- **No hex literals in component code** — N/A (no frontend in this plan).
- **The persona stays English** — do NOT translate it; Qwen VoiceDesign `instruct` is English/Chinese only (`voice-style.ts` skill rule).
- **Mirror the analyzer's explicit opt-in** — NO silent cross-provider fallback: `gemini`+no-key throws; `local`+daemon-down throws.
- **Default behaviour unchanged** — `gemini` engine, `gemini-3.1-flash-lite`, hard error when no key; the `gemini` persona path stays lazy-interleaved (no pre-pass).
- **Every change ships paired tests** (server Vitest). Bug-fix-shaped changes (the disconnected knob) ship a regression test that fails before and passes after.
- **Commit convention:** `<type>(<scope>): <subject>` — e.g. `feat(server): …`, validated by the commit-msg hook. End commit messages with the `Co-Authored-By` trailer.
- **Run `cd server && npm run test` for server tests; `npm run typecheck` for types.** Do not run the full `npm run verify` while a sidecar model-load is in flight.
- **Tests:** server tests live next to the unit (`*.test.ts`), node env, real-ffmpeg where relevant. Mock `fetch` and modules with `vi`.

---

## File Structure

- `server/src/config/registry.ts` — add 2 knobs (`analyzer.personaGeneration.engine`, `analyzer.personaGeneration.localModel`); the `analyzer.gemini.voiceStyleModel` knob already exists.
- `server/src/analyzer/voice-style.ts` — the dispatcher, new resolvers, `<think>` strip, `onCpu`/`keepAlive` threading. Persona-gen home.
- `server/src/analyzer/ollama.ts` — `export` `classifyConnectError`; add `generatePersonaViaOllama`.
- `server/src/analyzer/persona-gpu-plan.ts` *(new)* — `resolvePersonaGpuPlan` + `unloadResidentSidecar` (GPU/concurrency decision + reverse-evict). Kept out of `voice-style.ts` so the LLM-call file stays focused.
- `server/src/tts/design-lock.ts` — add `isOtherBookDesignBusy(bookDir)`.
- `server/src/routes/generation.ts` — reuse existing `activeGenerationBooks()` (no change; imported by the plan).
- `server/src/routes/voice-style.ts` — single-character persona-gen site: thread the plan.
- `server/src/routes/cast-design.ts` — `local`-only persona pre-pass + heartbeats + pause.

Test files colocate: `voice-style.test.ts`, `persona-gpu-plan.test.ts`, `cast-design.test.ts` (extend if present).

---

## Task 1: Registry knobs + resolvers (wire the disconnected model knob)

**Files:**
- Modify: `server/src/config/registry.ts` (add 2 knobs near the existing `analyzer.gemini.voiceStyleModel` entry)
- Modify: `server/src/analyzer/voice-style.ts` (rewrite `resolveVoiceStyleModel`; add `resolvePersonaEngine`, `resolvePersonaLocalModel`)
- Test: `server/src/analyzer/voice-style.test.ts`

**Interfaces:**
- Produces: `resolveVoiceStyleModel(): string`, `resolvePersonaEngine(): 'local' | 'gemini'`, `resolvePersonaLocalModel(): string`.
- Consumes: `configValue<T>('key')` from `../config/resolver.js` (resolves env → user override → registry default); `getResolvedOllamaModel()` from `../workspace/user-settings.js`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/analyzer/voice-style.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveVoiceStyleModel,
  resolvePersonaEngine,
  resolvePersonaLocalModel,
} from './voice-style.js';

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
  });

  it('resolvePersonaEngine defaults to gemini, honours the env toggle', () => {
    expect(resolvePersonaEngine()).toBe('gemini');
    process.env.PERSONA_GEN_ENGINE = 'local';
    expect(resolvePersonaEngine()).toBe('local');
  });

  it('resolvePersonaLocalModel: blank inherits the analyzer model; explicit wins', () => {
    expect(resolvePersonaLocalModel()).toMatch(/:/); // inherited Ollama tag contains ':'
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:9b';
    expect(resolvePersonaLocalModel()).toBe('qwen3.5:9b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts -t "persona generation config"`
Expected: FAIL — `resolvePersonaEngine`/`resolvePersonaLocalModel` are not exported; `resolveVoiceStyleModel` may pass on default but fail the env case only if the literal path is wrong (it currently reads `VOICE_STYLE_MODEL` so that sub-case passes; the suite still fails to import the two new symbols).

- [ ] **Step 3: Add the registry knobs**

In `server/src/config/registry.ts`, immediately after the existing `analyzer.gemini.voiceStyleModel` knob (search for `'analyzer.gemini.voiceStyleModel'`), add:

```typescript
{
  key: 'analyzer.personaGeneration.engine',
  env: 'PERSONA_GEN_ENGINE',
  group: 'analyzer-models',
  label: 'Persona generation engine',
  help: '"gemini" (default) designs each cast member\'s voice persona via the Gemini API — the locked quality choice. "local" routes persona generation through the local Ollama daemon so a no-Gemini install can still design voices. No silent cross-provider fallback: gemini with no key, or local with the daemon down, fails with a clear message.',
  type: 'enum',
  options: ['local', 'gemini'],
  default: 'gemini',
  apply: 'live',
  risk: 'medium',
},
{
  key: 'analyzer.personaGeneration.localModel',
  env: 'PERSONA_GEN_LOCAL_MODEL',
  group: 'analyzer-models',
  label: 'Persona local model',
  help: 'Ollama model tag (e.g. qwen3.5:9b) used when persona generation engine is "local". Blank inherits the analyzer\'s resolved local model, so a box that has run local analysis needs no extra download.',
  type: 'string',
  default: '',
  apply: 'live',
  risk: 'low',
},
```

- [ ] **Step 4: Rewrite the resolvers in `voice-style.ts`**

In `server/src/analyzer/voice-style.ts`, add the import and replace `resolveVoiceStyleModel`:

```typescript
import { configValue } from '../config/resolver.js';
import { getResolvedOllamaModel } from '../workspace/user-settings.js';
```

Replace the existing `resolveVoiceStyleModel` body (the one that returns the `'gemini-3.1-flash-lite'` literal) with:

```typescript
/** Voice-style (persona) Gemini model. Sourced from the registry knob
    `analyzer.gemini.voiceStyleModel` (env VOICE_STYLE_MODEL → user override →
    default `gemini-3.1-flash-lite`). Previously this returned a hardcoded
    literal and ignored the knob — srv-48 wires it up. */
export function resolveVoiceStyleModel(): string {
  return configValue<string>('analyzer.gemini.voiceStyleModel');
}

/** Persona generation provider — `local` (Ollama) or `gemini`. Default gemini. */
export function resolvePersonaEngine(): 'local' | 'gemini' {
  return configValue<string>('analyzer.personaGeneration.engine') === 'local' ? 'local' : 'gemini';
}

/** Ollama model for the local persona path. Blank ⇒ inherit the analyzer's
    resolved local model (single source of truth, zero extra download). */
export function resolvePersonaLocalModel(): string {
  const explicit = configValue<string>('analyzer.personaGeneration.localModel').trim();
  return explicit.length > 0 ? explicit : getResolvedOllamaModel();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts -t "persona generation config"`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
cd server && npm run typecheck
git add server/src/config/registry.ts server/src/analyzer/voice-style.ts server/src/analyzer/voice-style.test.ts
git commit -m "feat(server): srv-48 persona-engine + localModel registry knobs, wire voiceStyleModel"
```

---

## Task 2: `cleanPersona` strips a leading `<think>…</think>` block

**Files:**
- Modify: `server/src/analyzer/voice-style.ts` (`cleanPersona`)
- Test: `server/src/analyzer/voice-style.test.ts`

**Interfaces:**
- Modifies: `cleanPersona(raw: string): string` (unchanged signature; new behaviour).

- [ ] **Step 1: Write the failing test**

```typescript
import { cleanPersona } from './voice-style.js';

describe('cleanPersona <think> guard', () => {
  it('strips a leading <think>…</think> block a local thinking model may emit', () => {
    const raw = '<think>The character is a gruff miner, so low pitch…</think>\nA gruff, low-pitched man\'s voice, slow and weary, for audiobook narration.';
    expect(cleanPersona(raw)).toBe(
      "A gruff, low-pitched man's voice, slow and weary, for audiobook narration.",
    );
  });

  it('leaves a persona with no think block unchanged', () => {
    const raw = 'A bright teenage girl\'s voice, medium-high pitch, for audiobook narration.';
    expect(cleanPersona(raw)).toBe(raw);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts -t "<think> guard"`
Expected: FAIL — the think block (and its content) leaks into the output.

- [ ] **Step 3: Add the strip to `cleanPersona`**

In `cleanPersona`, as the FIRST transformation (before the existing fence/label/quote strips), add:

```typescript
export function cleanPersona(raw: string): string {
  let s = stripCodeFences(raw).trim();
  /* Local thinking models may ignore think:false and emit a reasoning block
     ahead of the persona. The structured analyzer path is protected by
     constrained decoding; this freeform path is not. Drop a leading
     <think>…</think> (DOTALL) before the rest of the cleanup. */
  s = s.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  /* …existing leading-label strip, whitespace collapse, quote strip… */
  s = s.replace(/^(voice[- ]?design persona|persona|voice style|voice)\s*[:\-—]\s*/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'“”']+/, '').replace(/["'“”']+$/, '').trim();
  return s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts -t "<think> guard"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/voice-style.ts server/src/analyzer/voice-style.test.ts
git commit -m "fix(server): srv-48 strip <think> block from local persona output"
```

---

## Task 3: `generatePersonaViaOllama` helper + export `classifyConnectError`

**Files:**
- Modify: `server/src/analyzer/ollama.ts` (export `classifyConnectError`; add helper)
- Test: `server/src/analyzer/ollama.test.ts` (create if absent, else extend)

**Interfaces:**
- Produces: `generatePersonaViaOllama(prompt: string, model: string, opts?: { onCpu?: boolean; keepAlive?: string | number }): Promise<string>` — POSTs `/api/chat` (non-stream), returns raw assistant text. Throws `LocalUnreachableError` on connection failure.
- Produces: `export function classifyConnectError(err: unknown, url: string): Error` (was module-private).
- Consumes: `getResolvedOllamaUrl()` (user-settings), `gpuSemaphore` + `costForEngine('analyzer')`, `resolveOllamaTemperature()`.

- [ ] **Step 1: Write the failing test**

Create `server/src/analyzer/ollama.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { generatePersonaViaOllama, classifyConnectError, LocalUnreachableError } from './ollama.js';
import { gpuSemaphore } from '../gpu/semaphore.js';

function mockChatResponse(text: string) {
  // Non-streaming /api/chat returns one JSON object.
  return new Response(JSON.stringify({ message: { content: text }, done: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('generatePersonaViaOllama', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GPU path: acquires the semaphore and sends the caller keep_alive', async () => {
    const acquire = vi.spyOn(gpuSemaphore, 'acquire');
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(mockChatResponse('A warm voice.'));
    const out = await generatePersonaViaOllama('PROMPT', 'qwen3.5:9b', { onCpu: false, keepAlive: '5m' });
    expect(out).toBe('A warm voice.');
    expect(acquire).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.keep_alive).toBe('5m');
    expect(body.stream).toBe(false);
    expect(body.format).toBeUndefined();
    expect(body.think).toBe(false);
    expect(body.options?.num_gpu).toBeUndefined(); // GPU path leaves num_gpu unset
  });

  it('CPU path: num_gpu:0, keep_alive:0, and does NOT acquire the semaphore', async () => {
    const acquire = vi.spyOn(gpuSemaphore, 'acquire');
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(mockChatResponse('A cool voice.'));
    const out = await generatePersonaViaOllama('PROMPT', 'qwen3.5:9b', { onCpu: true });
    expect(out).toBe('A cool voice.');
    expect(acquire).not.toHaveBeenCalled();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options.num_gpu).toBe(0);
    expect(body.keep_alive).toBe(0);
  });

  it('connection refusal surfaces LocalUnreachableError', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );
    await expect(generatePersonaViaOllama('P', 'qwen3.5:9b', { onCpu: true })).rejects.toBeInstanceOf(
      LocalUnreachableError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts`
Expected: FAIL — `generatePersonaViaOllama` / `classifyConnectError` not exported.

- [ ] **Step 3: Export `classifyConnectError` and add the helper**

In `server/src/analyzer/ollama.ts`: change `function classifyConnectError(` to `export function classifyConnectError(`. Then add the helper (near the bottom, after the class), and the needed imports at the top if not present:

```typescript
import { getResolvedOllamaUrl } from '../workspace/user-settings.js';
// gpuSemaphore, costForEngine, resolveOllamaTemperature are already imported in this file.

/** One-shot freeform Ollama call for persona generation. Unlike
    OllamaAnalyzer.chat() this sends NO response `format` (freeform text),
    does not stream, and is GPU-plan aware:
      - onCpu  → num_gpu:0 (system RAM only) AND skip the GPU semaphore
                 (a CPU call must not queue behind GPU synthesis).
      - !onCpu → acquire gpuSemaphore(costForEngine('analyzer')) around the fetch.
      - keepAlive is caller-controlled (resident window for a bulk pre-pass; 0
        for one-shot / CPU). */
export async function generatePersonaViaOllama(
  prompt: string,
  model: string,
  opts: { onCpu?: boolean; keepAlive?: string | number } = {},
): Promise<string> {
  const onCpu = opts.onCpu === true;
  const url = getResolvedOllamaUrl();
  const body = {
    model,
    messages: [{ role: 'user' as const, content: prompt }],
    stream: false,
    think: false,
    keep_alive: opts.keepAlive ?? 0,
    options: {
      temperature: resolveOllamaTemperature(),
      ...(onCpu ? { num_gpu: 0 } : {}),
    },
  };

  const release = onCpu ? null : await gpuSemaphore.acquire(costForEngine('analyzer'));
  try {
    let response: Response;
    try {
      response = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw classifyConnectError(err, url);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama ${url} returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    const json = (await response.json().catch(() => ({}))) as { message?: { content?: string } };
    return json.message?.content ?? '';
  } finally {
    release?.();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd server && npm run typecheck
git add server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts
git commit -m "feat(server): srv-48 generatePersonaViaOllama helper + export classifyConnectError"
```

---

## Task 4: Dispatcher — `generateVoiceStylePersona` engine switch

**Files:**
- Modify: `server/src/analyzer/voice-style.ts` (`generateVoiceStylePersona`)
- Test: `server/src/analyzer/voice-style.test.ts`

**Interfaces:**
- Modifies: `generateVoiceStylePersona(character: CastCharacter, opts?: { onCpu?: boolean; keepAlive?: string | number }): Promise<string>` — new optional `opts` forwarded to the local branch.
- Consumes: `resolvePersonaEngine`, `resolvePersonaLocalModel`, `resolveVoiceStyleModel` (Task 1); `generatePersonaViaOllama` (Task 3); existing `buildVoiceStylePrompt`, `cleanPersona`, `geminiRateLimiter`, `getResolvedGeminiApiKey`.

- [ ] **Step 1: Write the failing test**

```typescript
import { generateVoiceStylePersona } from './voice-style.js';
import { geminiRateLimiter } from './rate-limit.js';

const CHAR = { id: 'miner', name: 'Old Tom' } as any;

describe('generateVoiceStylePersona dispatch', () => {
  const ENV = ['PERSONA_GEN_ENGINE', 'GEMINI_API_KEY', 'OLLAMA_MODEL'];
  afterEach(() => { for (const k of ENV) delete process.env[k]; vi.restoreAllMocks(); });

  it('local engine routes to Ollama and never touches Gemini', async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    const ollama = await import('./ollama.js');
    const spy = vi.spyOn(ollama, 'generatePersonaViaOllama').mockResolvedValue('A weary miner\'s voice.');
    const out = await generateVoiceStylePersona(CHAR, { onCpu: true });
    expect(out).toBe("A weary miner's voice.");
    expect(spy).toHaveBeenCalledOnce();
  });

  it('local engine with daemon down throws LocalUnreachableError (no Gemini fallback)', async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    const ollama = await import('./ollama.js');
    vi.spyOn(ollama, 'generatePersonaViaOllama').mockRejectedValue(
      new ollama.LocalUnreachableError('Ollama unreachable'),
    );
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(ollama.LocalUnreachableError);
  });

  it('gemini engine with no key throws the clear message', async () => {
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    await expect(generateVoiceStylePersona(CHAR)).rejects.toThrow(/GEMINI_API_KEY is required/);
  });

  it('gemini branch still acquires the rate limiter', async () => {
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    process.env.GEMINI_API_KEY = 'k';
    const acquire = vi.spyOn(geminiRateLimiter, 'acquire').mockResolvedValue(undefined as any);
    // Stub the Gemini SDK call so we don't hit the network.
    const genai = await import('@google/genai');
    vi.spyOn(genai.GoogleGenAI.prototype as any, 'constructor');
    vi.spyOn((genai as any).GoogleGenAI.prototype, 'models', 'get').mockReturnValue({
      generateContent: vi.fn().mockResolvedValue({ text: 'A persona.' }),
    });
    await generateVoiceStylePersona(CHAR);
    expect(acquire).toHaveBeenCalled();
  });
});
```

> NB: the Gemini-SDK stub in the last test is brittle; if `vi.spyOn` on the prototype getter fails on the installed `@google/genai` version, instead `vi.mock('@google/genai', …)` with a factory returning a fake `GoogleGenAI` whose `models.generateContent` resolves `{ text: 'A persona.' }`. The assertion that matters is `acquire` was called.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts -t "dispatch"`
Expected: FAIL — `generateVoiceStylePersona` does not branch on engine / accept `opts`.

- [ ] **Step 3: Refactor `generateVoiceStylePersona` into a dispatcher**

Replace the existing `generateVoiceStylePersona` with a dispatcher; keep the existing Gemini body verbatim as `generateViaGemini`:

```typescript
import { generatePersonaViaOllama } from './ollama.js';

export async function generateVoiceStylePersona(
  character: CastCharacter,
  opts: { onCpu?: boolean; keepAlive?: string | number } = {},
): Promise<string> {
  const engine = resolvePersonaEngine();
  return engine === 'local' ? generateViaOllama(character, opts) : generateViaGemini(character);
}

async function generateViaOllama(
  character: CastCharacter,
  opts: { onCpu?: boolean; keepAlive?: string | number },
): Promise<string> {
  const model = resolvePersonaLocalModel();
  const prompt = await buildVoiceStylePrompt(character);
  const persona = cleanPersona(await generatePersonaViaOllama(prompt, model, opts));
  if (!persona) {
    throw new Error(`Voice-style generation for "${character.id}" returned an empty persona.`);
  }
  return persona;
}

/* generateViaGemini = the previous generateVoiceStylePersona body, unchanged:
   getResolvedGeminiApiKey() guard → resolveVoiceStyleModel() → buildVoiceStylePrompt
   → geminiRateLimiter.acquire(model, estTokens) → GoogleGenAI generateContent
   → cleanPersona → empty-persona guard. MUST retain geminiRateLimiter.acquire. */
async function generateViaGemini(character: CastCharacter): Promise<string> {
  const apiKey = getResolvedGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is required to generate voice-style personas. ' +
        'Set it from Account → Server configuration → Gemini API key, ' +
        'or in server/.env for CI / power users.',
    );
  }
  const model = resolveVoiceStyleModel();
  const prompt = await buildVoiceStylePrompt(character);
  const estTokens = Math.ceil(prompt.length / 4) + 200;
  await geminiRateLimiter.acquire(model, estTokens);
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({ model, contents: prompt });
  const persona = cleanPersona(response.text ?? '');
  if (!persona) {
    throw new Error(`Voice-style generation for "${character.id}" returned an empty persona.`);
  }
  return persona;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts`
Expected: PASS (all voice-style tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd server && npm run typecheck
git add server/src/analyzer/voice-style.ts server/src/analyzer/voice-style.test.ts
git commit -m "feat(server): srv-48 persona dispatcher (local|gemini), retain gemini rate limiter"
```

---

## Task 5: Concurrency signals — `isOtherBookDesignBusy`

**Files:**
- Modify: `server/src/tts/design-lock.ts`
- Test: `server/src/tts/design-lock.test.ts` (create if absent)

**Interfaces:**
- Produces: `isOtherBookDesignBusy(bookDir: string): boolean` — true when ANY book *other than* `bookDir` has a bulk-design job live.
- (Global generation already exists: `activeGenerationBooks(): string[]` from `../routes/generation.js`.)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { markDesignBusy, clearDesignBusy, isOtherBookDesignBusy } from './design-lock.js';

describe('isOtherBookDesignBusy', () => {
  afterEach(() => { clearDesignBusy('/a'); clearDesignBusy('/b'); });

  it('ignores the querying book, sees other books', () => {
    expect(isOtherBookDesignBusy('/a')).toBe(false);
    markDesignBusy('/a');
    expect(isOtherBookDesignBusy('/a')).toBe(false); // self excluded
    markDesignBusy('/b');
    expect(isOtherBookDesignBusy('/a')).toBe(true);  // other book busy
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/design-lock.test.ts`
Expected: FAIL — `isOtherBookDesignBusy` not exported.

- [ ] **Step 3: Add the helper**

In `server/src/tts/design-lock.ts`, after `isAnyDesignBusy`:

```typescript
/** True when a bulk design is live for some book OTHER than `bookDir`. The
    persona pre-pass marks ITS book busy before probing, so the self-exclusion
    matters — `isAnyDesignBusy()` would always be true for the running job. */
export function isOtherBookDesignBusy(bookDir: string): boolean {
  for (const d of designBusy) if (d !== bookDir) return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/design-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/design-lock.ts server/src/tts/design-lock.test.ts
git commit -m "feat(server): srv-48 isOtherBookDesignBusy (self-excluding design-busy probe)"
```

---

## Task 6: Reverse-evict primitive — `unloadResidentSidecar`

**Files:**
- Create: `server/src/analyzer/persona-gpu-plan.ts`
- Test: `server/src/analyzer/persona-gpu-plan.test.ts`

**Interfaces:**
- Produces: `class GpuBusyForPersonaError extends Error` and `unloadResidentSidecar(): Promise<void>` — acquires the FULL `gpuSemaphore` budget, re-checks the durable generation flag, and if a render is active throws `GpuBusyForPersonaError` (releasing the budget); otherwise POSTs `/unload {engine:'qwen'}` to the sidecar and verifies via `/api/sidecar/health`.
- Consumes: `gpuSemaphore` (`.acquire`, `.budget`), `activeGenerationBooks()` (`../routes/generation.js`), `getResolvedSidecarUrl()` (`../workspace/user-settings.js`).

- [ ] **Step 1: Write the failing test**

Create `server/src/analyzer/persona-gpu-plan.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { gpuSemaphore } from '../gpu/semaphore.js';

describe('unloadResidentSidecar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses (no /unload) while a render is active, releasing the full budget', async () => {
    const mod = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');
    vi.spyOn(gen, 'activeGenerationBooks').mockReturnValue(['book-1']);
    const acquire = vi.spyOn(gpuSemaphore, 'acquire');
    const fetchSpy = vi.spyOn(global, 'fetch');
    await expect(mod.unloadResidentSidecar()).rejects.toBeInstanceOf(mod.GpuBusyForPersonaError);
    expect(acquire).toHaveBeenCalledWith(gpuSemaphore.budget); // full budget
    expect(fetchSpy).not.toHaveBeenCalled();                   // never sent /unload
    expect(gpuSemaphore.inFlight).toBe(0);                     // released in finally
  });

  it('unloads the qwen engine when idle and verifies health', async () => {
    const mod = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');
    vi.spyOn(gen, 'activeGenerationBooks').mockReturnValue([]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'idle' }), { status: 200 }),
    );
    await mod.unloadResidentSidecar();
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/unload'))!;
    expect(JSON.parse((call[1] as RequestInit).body as string).engine).toBe('qwen');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/persona-gpu-plan.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the primitive**

Create `server/src/analyzer/persona-gpu-plan.ts`:

```typescript
import { gpuSemaphore } from '../gpu/semaphore.js';
import { activeGenerationBooks } from '../routes/generation.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

/** Thrown when the sidecar can't be safely unloaded for a persona run because a
    render is active. The caller falls back to CPU persona generation. */
export class GpuBusyForPersonaError extends Error {
  readonly code = 'GPU_BUSY_FOR_PERSONA';
  constructor(message: string) {
    super(message);
    this.name = 'GpuBusyForPersonaError';
  }
}

/** Reverse-evict: free the sidecar's resident Qwen models so a local persona
    Ollama model fits on a constrained GPU. Holds the FULL gpuSemaphore budget
    (NOT just the load-mutex — synthesis holds the semaphore per-chunk and never
    takes the mutex, so the mutex alone would let a /synthesize run during the
    unload and fail that render's chapter). Re-checks the durable generation flag
    inside the hold and refuses if a render is active. Releases the budget in
    `finally` so a refused evict never wedges the GPU. */
export async function unloadResidentSidecar(): Promise<void> {
  const release = await gpuSemaphore.acquire(gpuSemaphore.budget);
  try {
    if (activeGenerationBooks().length > 0) {
      throw new GpuBusyForPersonaError('A render is active — skip the GPU persona pre-pass.');
    }
    const url = getResolvedSidecarUrl();
    const res = await fetch(`${url}/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'qwen' }), // frees Qwen Base + VoiceDesign
    });
    if (!res.ok) {
      throw new Error(`Sidecar /unload returned ${res.status} ${res.statusText}`);
    }
    // Verify the engine is no longer resident.
    const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => ({}));
    void health; // best-effort; the sidecar /unload is idempotent and returns 'idle'.
  } finally {
    release();
  }
}
```

> Confirm `${url}/health` is the correct sidecar health path during implementation (the Node route is `/api/sidecar/health`; the sidecar itself exposes `/health`). If a richer "is qwen resident?" check is available, assert on it; otherwise the idempotent `/unload` + 200 is sufficient.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/persona-gpu-plan.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd server && npm run typecheck
git add server/src/analyzer/persona-gpu-plan.ts server/src/analyzer/persona-gpu-plan.test.ts
git commit -m "feat(server): srv-48 unloadResidentSidecar (full-budget, fail-closed reverse-evict)"
```

---

## Task 7: `resolvePersonaGpuPlan` decision function

**Files:**
- Modify: `server/src/analyzer/persona-gpu-plan.ts`
- Test: `server/src/analyzer/persona-gpu-plan.test.ts`

**Interfaces:**
- Produces: `type PersonaGpuPlan = { onCpu: boolean; evict: boolean; keepAlive: string | number }` and `resolvePersonaGpuPlan(bookDir: string): PersonaGpuPlan`.
  - roomy card / CPU accel → `{ onCpu: false, evict: false, keepAlive: 0 }`
  - constrained + idle → `{ onCpu: false, evict: true, keepAlive: <resident> }`
  - constrained + busy (gen/inFlight/other-design/analysis) → `{ onCpu: true, evict: false, keepAlive: 0 }`
- Consumes: `shouldEvictBeforeSidecarLoad`, `getLastKnownVram` (`../gpu/…`), `gpuSemaphore.inFlight`, `activeGenerationBooks`, `isOtherBookDesignBusy`, `isAnyAnalysisBusy`, `resolveAnalyzerKeepAlive` (`./ollama.js`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';

describe('resolvePersonaGpuPlan', () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup({ constrained, inFlight, gen }: { constrained: boolean; inFlight: number; gen: string[] }) {
    const residency = await import('../gpu/residency.js');
    vi.spyOn(residency, 'shouldEvictBeforeSidecarLoad').mockReturnValue(constrained);
    const { gpuSemaphore } = await import('../gpu/semaphore.js');
    vi.spyOn(gpuSemaphore, 'inFlight', 'get').mockReturnValue(inFlight);
    const gen2 = await import('../routes/generation.js');
    vi.spyOn(gen2, 'activeGenerationBooks').mockReturnValue(gen);
    const dl = await import('../tts/design-lock.js');
    vi.spyOn(dl, 'isOtherBookDesignBusy').mockReturnValue(false);
    vi.spyOn(dl, 'isAnyAnalysisBusy').mockReturnValue(false);
    return import('./persona-gpu-plan.js');
  }

  it('roomy card → GPU, no evict', async () => {
    const mod = await setup({ constrained: false, inFlight: 0, gen: [] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: false, evict: false });
  });

  it('constrained + idle → evict + GPU + resident keepAlive', async () => {
    const mod = await setup({ constrained: true, inFlight: 0, gen: [] });
    const plan = mod.resolvePersonaGpuPlan('/a');
    expect(plan).toMatchObject({ onCpu: false, evict: true });
    expect(plan.keepAlive).not.toBe(0);
  });

  it('constrained + inFlight>0 → CPU, no evict', async () => {
    const mod = await setup({ constrained: true, inFlight: 1, gen: [] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: true, evict: false });
  });

  it('constrained + durable render but inFlight===0 → still CPU', async () => {
    const mod = await setup({ constrained: true, inFlight: 0, gen: ['book-2'] });
    expect(mod.resolvePersonaGpuPlan('/a')).toMatchObject({ onCpu: true, evict: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/persona-gpu-plan.test.ts -t "resolvePersonaGpuPlan"`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

Append to `server/src/analyzer/persona-gpu-plan.ts`:

```typescript
import { shouldEvictBeforeSidecarLoad } from '../gpu/residency.js';
import { getLastKnownVram } from '../gpu/vram-state.js';
import { isOtherBookDesignBusy, isAnyAnalysisBusy } from '../tts/design-lock.js';
import { resolveAnalyzerKeepAlive } from './ollama.js';

export interface PersonaGpuPlan {
  onCpu: boolean;
  evict: boolean;
  keepAlive: string | number;
}

/** Decide how the local persona call should use the GPU for `bookDir`. See the
    spec's decision table. "Busy" combines the instantaneous semaphore hold and
    the durable render flag (a render is mid-job even between per-chunk holds). */
export function resolvePersonaGpuPlan(bookDir: string): PersonaGpuPlan {
  const constrained = shouldEvictBeforeSidecarLoad(getLastKnownVram());
  if (!constrained) return { onCpu: false, evict: false, keepAlive: 0 };

  const busy =
    gpuSemaphore.inFlight > 0 ||
    activeGenerationBooks().length > 0 ||
    isOtherBookDesignBusy(bookDir) ||
    isAnyAnalysisBusy();

  return busy
    ? { onCpu: true, evict: false, keepAlive: 0 }
    : { onCpu: false, evict: true, keepAlive: resolveAnalyzerKeepAlive() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/persona-gpu-plan.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

```bash
cd server && npm run typecheck
git add server/src/analyzer/persona-gpu-plan.ts server/src/analyzer/persona-gpu-plan.test.ts
git commit -m "feat(server): srv-48 resolvePersonaGpuPlan decision (idle→GPU+evict, busy→CPU)"
```

---

## Task 8: Wire the single-character persona route

**Files:**
- Modify: `server/src/routes/voice-style.ts` (the generate-persona handler)
- Test: `server/src/routes/voice-style.test.ts` (create/extend)

**Interfaces:**
- Consumes: `resolvePersonaGpuPlan`, `unloadResidentSidecar`, `GpuBusyForPersonaError` (Tasks 6-7); `generateVoiceStylePersona(character, opts)` (Task 4).
- Behaviour: compute the plan; if `evict`, `await unloadResidentSidecar()` (on `GpuBusyForPersonaError`, downgrade to `onCpu: true`); call `generateVoiceStylePersona(character, { onCpu: plan.onCpu, keepAlive: plan.keepAlive })`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';

describe('voice-style route persona GPU plan', () => {
  afterEach(() => vi.restoreAllMocks());

  it('evict plan: unloads the sidecar then generates on GPU', async () => {
    const plan = await import('../analyzer/persona-gpu-plan.js');
    vi.spyOn(plan, 'resolvePersonaGpuPlan').mockReturnValue({ onCpu: false, evict: true, keepAlive: '5m' });
    const evict = vi.spyOn(plan, 'unloadResidentSidecar').mockResolvedValue();
    const vs = await import('../analyzer/voice-style.js');
    const gen = vi.spyOn(vs, 'generateVoiceStylePersona').mockResolvedValue('A persona.');
    // …invoke the handler's persona-generation path (extract a tested helper
    //   `generatePersonaForRoute(character, bookDir)` if the handler is hard to
    //   call directly; assert on these two spies)…
    // expect(evict).toHaveBeenCalled();
    // expect(gen).toHaveBeenCalledWith(expect.anything(), { onCpu: false, keepAlive: '5m' });
  });

  it('evict refused (GpuBusyForPersonaError) → CPU generation', async () => {
    const plan = await import('../analyzer/persona-gpu-plan.js');
    vi.spyOn(plan, 'resolvePersonaGpuPlan').mockReturnValue({ onCpu: false, evict: true, keepAlive: '5m' });
    vi.spyOn(plan, 'unloadResidentSidecar').mockRejectedValue(new plan.GpuBusyForPersonaError('busy'));
    const vs = await import('../analyzer/voice-style.js');
    const gen = vi.spyOn(vs, 'generateVoiceStylePersona').mockResolvedValue('A persona.');
    // …invoke; assert gen called with { onCpu: true, … }…
  });
});
```

> Implementation note: extract the route's persona step into a small exported helper, e.g. `export async function generatePersonaWithPlan(character, bookDir)`, so it's unit-testable without spinning the Express app. The two assertions above target that helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/voice-style.test.ts`
Expected: FAIL — helper not present / route doesn't apply the plan.

- [ ] **Step 3: Implement the helper and use it in the handler**

In `server/src/routes/voice-style.ts`:

```typescript
import {
  resolvePersonaGpuPlan,
  unloadResidentSidecar,
  GpuBusyForPersonaError,
} from '../analyzer/persona-gpu-plan.js';
import { generateVoiceStylePersona } from '../analyzer/voice-style.js';
import { resolvePersonaEngine } from '../analyzer/voice-style.js';

/** Generate one character's persona, applying the GPU plan for `bookDir`.
    Only the `local` engine consults the plan; `gemini` is off-GPU. */
export async function generatePersonaWithPlan(
  character: CastCharacter,
  bookDir: string,
): Promise<string> {
  if (resolvePersonaEngine() !== 'local') {
    return generateVoiceStylePersona(character); // gemini path, unchanged
  }
  let plan = resolvePersonaGpuPlan(bookDir);
  if (plan.evict) {
    try {
      await unloadResidentSidecar();
    } catch (err) {
      if (!(err instanceof GpuBusyForPersonaError)) throw err;
      plan = { onCpu: true, evict: false, keepAlive: 0 }; // a render slipped in — go CPU
    }
  }
  return generateVoiceStylePersona(character, { onCpu: plan.onCpu, keepAlive: plan.keepAlive });
}
```

Then replace the handler's direct `generateVoiceStylePersona(character)` call with `generatePersonaWithPlan(character, bookDir)` (the handler already resolves `bookDir` via `findBookByBookId`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/voice-style.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd server && npm run typecheck
git add server/src/routes/voice-style.ts server/src/routes/voice-style.test.ts
git commit -m "feat(server): srv-48 single-design persona honours the GPU plan"
```

---

## Task 9: Bulk "Design full cast" persona pre-pass

**Files:**
- Modify: `server/src/routes/cast-design.ts` (`runDesignJob` + a new `runPersonaPrePass`)
- Test: `server/src/routes/cast-design.test.ts` (create/extend)

**Interfaces:**
- Consumes: `resolvePersonaGpuPlan`, `unloadResidentSidecar`, `GpuBusyForPersonaError` (Tasks 6-7); `generateVoiceStylePersona(character, opts)` (Task 4); `resolvePersonaEngine` (Task 1).
- Behaviour: for the `local` engine only, before the design loop, run a pre-pass over the **base** task characters lacking a `voiceStyle`; persist each; emit heartbeats < 30 s; honour `job.controller.signal`. The `gemini` engine keeps the existing lazy-interleaved persona-gen inside the loop (unchanged).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';

describe('cast-design persona pre-pass', () => {
  afterEach(() => vi.restoreAllMocks());

  it('local idle: evict + all personas before the first design; variants skipped', async () => {
    const plan = await import('../analyzer/persona-gpu-plan.js');
    vi.spyOn(plan, 'resolvePersonaGpuPlan').mockReturnValue({ onCpu: false, evict: true, keepAlive: '5m' });
    const evict = vi.spyOn(plan, 'unloadResidentSidecar').mockResolvedValue();
    const vs = await import('../analyzer/voice-style.js');
    vi.spyOn(vs, 'resolvePersonaEngine').mockReturnValue('local');
    const order: string[] = [];
    vi.spyOn(vs, 'generateVoiceStylePersona').mockImplementation(async (c: any) => {
      order.push(`persona:${c.id}`);
      return 'A persona.';
    });
    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockImplementation(async (a: any) => {
      order.push(`design:${a.characterId}`);
      return { voiceId: 'qwen-x', url: '/x.mp3' };
    });
    // …drive runPersonaPrePass (or runDesignJob) with two base tasks + one variant…
    // expect(evict).toHaveBeenCalled();
    // expect(order.slice(0,2).every(s => s.startsWith('persona:'))).toBe(true);
    // expect(order).not.toContain('persona:<variant-char-from-variant-only-task>');
  });

  it('generation in flight: no evict, personas on CPU, designs still run', async () => {
    const plan = await import('../analyzer/persona-gpu-plan.js');
    vi.spyOn(plan, 'resolvePersonaGpuPlan').mockReturnValue({ onCpu: true, evict: false, keepAlive: 0 });
    const evict = vi.spyOn(plan, 'unloadResidentSidecar');
    // …drive; expect(evict).not.toHaveBeenCalled(); assert generateVoiceStylePersona called with {onCpu:true}…
  });

  it('gemini engine: no pre-pass batch (lazy interleave preserved)', async () => {
    const vs = await import('../analyzer/voice-style.js');
    vi.spyOn(vs, 'resolvePersonaEngine').mockReturnValue('gemini');
    const plan = await import('../analyzer/persona-gpu-plan.js');
    const evict = vi.spyOn(plan, 'unloadResidentSidecar');
    // …drive; expect(evict).not.toHaveBeenCalled()…
  });

  it('heartbeat < 30s during the pass and pause stops before designs', async () => {
    // mock a slow generateVoiceStylePersona; assert ≥1 heartbeat broadcast before
    // the first design, and that controller.abort() prevents any design call.
  });
});
```

> Implementation note: factor the loop body so `runPersonaPrePass(job, baseTasks, plan)` is callable in tests with injected spies, and `runDesignJob` calls it. The assertions target call order + the evict/CPU/heartbeat/abort behaviours; fill in the harness to match how `cast-design.test.ts` already constructs a `job` (reuse any existing test helper there).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts -t "pre-pass"`
Expected: FAIL — no pre-pass exists.

- [ ] **Step 3: Implement the pre-pass**

In `server/src/routes/cast-design.ts`, add the imports and a `runPersonaPrePass`, then call it at the top of `runDesignJob` (before the `for (const task of tasks)` loop):

```typescript
import { resolvePersonaEngine, generateVoiceStylePersona } from '../analyzer/voice-style.js';
import {
  resolvePersonaGpuPlan,
  unloadResidentSidecar,
  GpuBusyForPersonaError,
} from '../analyzer/persona-gpu-plan.js';

const PERSONA_HEARTBEAT_MS = 6000; // < the pill's 30s stall heuristic

/** local-engine only: generate personas for base characters lacking one BEFORE
    any design touches the sidecar, so a constrained GPU evicts the idle warm
    model once (not per-character). gemini stays lazy-interleaved in the loop. */
async function runPersonaPrePass(job: DesignJob, tasks: DesignTask[]): Promise<void> {
  if (resolvePersonaEngine() !== 'local') return;

  // base tasks only — variants always reuse the base persona.
  const baseIds = [...new Set(tasks.filter((t) => !t.emotion).map((t) => t.characterId))];
  if (baseIds.length === 0) return;

  let plan = resolvePersonaGpuPlan(job.bookDir);
  if (plan.evict) {
    try {
      await unloadResidentSidecar();
    } catch (err) {
      if (!(err instanceof GpuBusyForPersonaError)) throw err;
      plan = { onCpu: true, evict: false, keepAlive: 0 };
    }
  }

  const beat = setInterval(
    () => broadcast(job, { type: 'persona_pass', characterId: job.currentCharacterId }),
    PERSONA_HEARTBEAT_MS,
  );
  try {
    for (const characterId of baseIds) {
      if (job.controller.signal.aborted) return;
      const cast = await readJson<CastFile>(castJsonPath(job.bookDir));
      const character = cast?.characters?.find((c) => c.id === characterId);
      if (!character) continue;
      if ((character.voiceStyle ?? '').trim()) continue; // already has one — idempotent
      if (character.overrideTtsVoices?.qwen?.name) continue; // already designed — skip

      const persona = await generateVoiceStylePersona(character, {
        onCpu: plan.onCpu,
        keepAlive: plan.keepAlive,
      });
      const fresh = await readJson<CastFile>(castJsonPath(job.bookDir));
      const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
      if (fresh && idx !== -1) {
        fresh.characters[idx] = { ...fresh.characters[idx], voiceStyle: persona };
        await writeJsonAtomic(castJsonPath(job.bookDir), fresh);
      }
    }
  } finally {
    clearInterval(beat);
  }
}
```

Then, in `runDesignJob`, immediately before the `for (const task of tasks)` loop:

```typescript
  await runPersonaPrePass(job, tasks);
  if (job.controller.signal.aborted) { endJob(job, { type: 'idle', done: job.done, total: job.total, skipped: job.skipped, failures: job.failures }); return; }
```

(The existing per-character persona fallback at `cast-design.ts:219-228` stays — it still covers the `gemini` engine and any character the pre-pass skipped.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd server && npm run typecheck
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "feat(server): srv-48 local-only persona pre-pass for bulk cast design"
```

---

## Task 10: Full verify + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-24-srv-48-persona-generation-local-model-design.md` (`status:` → `active`)
- Modify: `server/.env.example` (document `PERSONA_GEN_ENGINE` / `PERSONA_GEN_LOCAL_MODEL`)

- [ ] **Step 1: Document the env vars**

Add to `server/.env.example`, near the analyzer/Gemini section:

```bash
# Persona generation (voice-design). Default 'gemini' (gemini-3.1-flash-lite).
# Set 'local' to design voices with no Gemini key (routes through Ollama).
# PERSONA_GEN_ENGINE=local
# PERSONA_GEN_LOCAL_MODEL=qwen3.5:9b   # blank inherits the analyzer's local model
```

- [ ] **Step 2: Flip the spec status**

In the spec frontmatter, change `status: draft` → `status: active`.

- [ ] **Step 3: Run the server test battery**

Run: `cd server && npm run test`
Expected: PASS (all server specs, including the new ones). Do NOT run while a sidecar model-load is in flight.

- [ ] **Step 4: Typecheck the whole project**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/.env.example docs/superpowers/specs/2026-06-24-srv-48-persona-generation-local-model-design.md
git commit -m "docs(server): srv-48 document persona-engine env vars; spec → active"
```

- [ ] **Step 6: Final full battery (no sidecar load in flight)**

Run: `npm run verify`
Expected: PASS (typecheck + tests + e2e + build). If a pre-existing unrelated failure appears, surface it to the user rather than fixing it in this branch.

---

## Self-Review

**Spec coverage:**
- Provider toggle + default gemini → Task 1. Model defaults from registry (wire voiceStyleModel) → Task 1. Blank-inherit localModel → Task 1.
- Explicit opt-in / no silent fallback → Task 4 (gemini-no-key throws; local-down throws). 
- `<think>` strip → Task 2. Local Ollama helper + export classifyConnectError + onCpu/keepAlive/semaphore-conditional → Task 3. Gemini rate-limiter retained → Task 4.
- Global generation + other-book design-busy signals → Task 5 (reuses `activeGenerationBooks`). Reverse-evict full-budget fail-closed → Task 6. Decision table → Task 7. Single-design wiring → Task 8. Bulk local-only pre-pass + heartbeats + pause + variants-skipped → Task 9.
- Env docs + status flip + verify → Task 10.
- The twelve spec tests map to: T1 (knob-wiring, engine/localModel resolvers = #1/#4 partial), T2 (#5 `<think>`), T3 (#2 local happy-path, #6 GPU semaphore+keepalive, #7 CPU no-semaphore, #3 LocalUnreachable), T4 (#1 provider selection, #3 no-provider, #8 rate-limiter), T6 (#10 fail-closed evict), T7 (#9 decision table incl. durable-vs-instantaneous), T9 (#11 ordering+variants+gemini-no-prepass, #12 heartbeat+pause).

**Placeholder scan:** Tasks 8 & 9 use prose "…drive the handler…" *inside test bodies* with an explicit instruction to extract a named, testable helper (`generatePersonaWithPlan`, `runPersonaPrePass`) — the production code for both is fully specified. This is the one area an executor must flesh the harness to match the existing `cast-design.test.ts` fixtures; flagged, not hidden.

**Type consistency:** `PersonaGpuPlan { onCpu; evict; keepAlive }` is produced in Task 7 and consumed in Tasks 8-9. `generateVoiceStylePersona(character, opts?)` opts shape `{ onCpu?; keepAlive? }` matches Tasks 3/4/8/9. `unloadResidentSidecar()` / `GpuBusyForPersonaError` defined Task 6, used Tasks 8-9. `isOtherBookDesignBusy(bookDir)` defined Task 5, used Task 7. `activeGenerationBooks()` is the existing export (verified `generation.ts:410`).

## Notes for the executor

- **Verify two anchors before coding:** `gpuSemaphore.budget` getter exists (`semaphore.ts:120`); the sidecar health path used by `unloadResidentSidecar` (Node route is `/api/sidecar/health`; the sidecar process exposes `/health`).
- **`@google/genai` mock** in Task 4's rate-limiter test is the most fragile spot — prefer a `vi.mock('@google/genai', …)` factory if prototype spying misbehaves.
- Tasks are dependency-ordered. 1→2→3→4 are the core LLM path; 5→6→7 the GPU/concurrency substrate; 8→9 the two call sites; 10 finalizes.
