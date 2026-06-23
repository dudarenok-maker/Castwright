---
status: draft
issue: 1038
backlog-id: srv-48
area: srv
---

# srv-48 — Local-model option for voice-design persona generation

## Problem

`generateVoiceStylePersona()` (`server/src/analyzer/voice-style.ts:147`) is
**Gemini-only**. It resolves a Gemini API key and throws hard when none is
present (`voice-style.ts:148-155`). There is no local-model path. So an
offline / local-only install can ingest, analyse (local Ollama), and
synthesise (Qwen sidecar) — but **cannot design Qwen voices**, because the
persona that seeds `POST /qwen/design-voice` can't be generated.

This is inconsistent with the analyzer, which already offers a clean provider
switch (`engine === 'local' | 'gemini'`, env `ANALYZER`) with local Ollama and
mutual fallback. Persona generation should mirror that switch.

A second, related defect: the registry knob `analyzer.gemini.voiceStyleModel`
(`registry.ts:769`, default `gemini-3.1-flash-lite`) **already exists but is
disconnected from the code**. `resolveVoiceStyleModel()` (`voice-style.ts:52`)
reads only the `VOICE_STYLE_MODEL` env var and otherwise returns a hardcoded
string literal — it never reads the registry default. The model default lives
in code, not in settings.

## Goals

1. A provider toggle for persona generation (`local | gemini`), surfaced as a
   registry setting + env, defaulting to `gemini` (the locked quality
   decision), with local Ollama as an opt-in so a no-Gemini install can design
   voices.
2. Model defaults sourced from the registry, not hardcoded in code — both the
   Gemini model and the local model.
3. Behaviour that mirrors the analyzer's deliberate asymmetry: explicit
   opt-in, no silent cross-provider fallback.

## Non-goals

- Persona internationalisation (fs-62 / #1034, closed won't-fix). The persona
  stays **English** — Qwen VoiceDesign's `instruct` is English/Chinese only;
  the spoken language + accent ride a separate calibration channel. Do not
  translate the persona into the book's language.
- Any change to the `Analyzer` interface or its stage methods.
- Frontend work. The Account → Server configuration UI auto-renders registry
  knobs, so the new toggle and model fields surface for free.

## Locked decisions (this design)

- **Q1 — defaults source: registry (option B).** Both the provider toggle and
  the model defaults are sourced from the registry via `configValue()`. The
  disconnected `voiceStyleModel` knob is wired up in the same change.
- **Q2 — fallback: explicit opt-in (option B).** Mirror the analyzer 1:1. No
  silent cross-provider fallback. `gemini` + no key throws; `local` + daemon
  down throws. An offline user sets `personaGeneration.engine: local`
  themselves.
- **Q3 — local model: dedicated knob (option B), blank-inherit default.** A
  `personaGeneration.localModel` knob, default `''`, where blank means "inherit
  the analyzer's resolved local model" (`getResolvedOllamaModel()`). The local
  model default thus lives in exactly one place (`DEFAULT_OLLAMA_MODEL`); a
  fresh install needs zero new download.
- **Q4 — wiring: thin dedicated module (option A).** A small provider switch
  inside `voice-style.ts`; the local path is a thin Ollama helper that does
  **not** go through the `Analyzer` interface. Interfaces stay honest; we don't
  need `FallbackAnalyzer` because we chose explicit opt-in.

## Architecture

`generateVoiceStylePersona(character)` becomes a dispatcher over a resolved
engine; both branches share `buildVoiceStylePrompt()` and `cleanPersona()`, so
only the model call differs:

```
generateVoiceStylePersona(character)
  → resolvePersonaEngine()                    // 'local' | 'gemini', from registry
  → engine === 'gemini'
       ? generateViaGemini(character)         // existing inline GoogleGenAI path
       : generateViaOllama(character)         // new thin Ollama path
```

### Registry knobs

Three `ConfigKnob` entries in the `KNOBS` array (`registry.ts`), group
`analyzer-models`, `apply: 'live'`:

| key | env | type | default | notes |
|---|---|---|---|---|
| `analyzer.personaGeneration.engine` | `PERSONA_GEN_ENGINE` | enum `['local','gemini']` | `gemini` | new — the provider toggle |
| `analyzer.gemini.voiceStyleModel` | `VOICE_STYLE_MODEL` | string | `gemini-3.1-flash-lite` | exists — wire the resolver to read it |
| `analyzer.personaGeneration.localModel` | `PERSONA_GEN_LOCAL_MODEL` | string | `''` | new — blank ⇒ inherit `getResolvedOllamaModel()` |

### Resolvers (`voice-style.ts`)

- `resolveVoiceStyleModel()` — replace its hardcoded-literal body with
  `configValue<string>('analyzer.gemini.voiceStyleModel')`. `configValue`
  already resolves env (`VOICE_STYLE_MODEL`) → user override → registry default,
  so the env-override behaviour is preserved and the disconnected-knob bug is
  fixed.
- `resolvePersonaEngine(): 'local' | 'gemini'` — reads
  `configValue('analyzer.personaGeneration.engine')`.
- `resolvePersonaLocalModel(): string` — reads
  `configValue('analyzer.personaGeneration.localModel')`; when blank, falls
  through to `getResolvedOllamaModel()`.

### The local Ollama call

`OllamaAnalyzer.chat()` is `private` and welded to the structured-JSON stage
flow (Zod `format`, validation-retry loop, handoff inbox/error files) — the
wrong shape for a single freeform sentence. So add a small standalone helper:

`generatePersonaViaOllama(prompt: string, model: string): Promise<string>`

- POSTs to `${getResolvedOllamaUrl()}/api/chat` with the prompt as a single
  user message, `stream: false`, **no `format`**, `think: false`, and a low
  `temperature`.
- On connection failure, reuses `classifyConnectError()` to raise
  `LocalUnreachableError` with its existing operator message. This requires
  **exporting** `classifyConnectError` from `ollama.ts` (currently
  module-private) — a one-line export, no behaviour change.
- Returns the raw model text; the caller runs it through `cleanPersona()`,
  exactly as the Gemini path does.
- No GPU semaphore / VRAM sampling — a one-shot persona call is not the
  analysis hot loop, so it does not need the analyzer's VRAM arbitration.

## Error & fallback behaviour

Mirrors the analyzer's deliberate asymmetry (Q2):

- `engine: gemini`, no key resolves → **throw** the existing clear message
  (set a key from Account → Server configuration, or switch
  `personaGeneration.engine` to `local`). No silent fallback to local.
- `engine: local`, daemon unreachable → throw `LocalUnreachableError`'s message
  ("Start the daemon or set …"). No auto-jump to Gemini.
- Empty model response → the existing per-branch "returned an empty persona"
  error.

## Files touched

- `server/src/analyzer/voice-style.ts` — dispatcher, new resolvers, the
  `generateViaOllama` branch, rewired `resolveVoiceStyleModel()`.
- `server/src/analyzer/ollama.ts` — export `classifyConnectError`; add
  `generatePersonaViaOllama` (or co-locate it in `voice-style.ts` and import
  the exported `classifyConnectError` + `getResolvedOllamaUrl`).
- `server/src/config/registry.ts` — the two new knobs (engine, localModel).
- `server/src/analyzer/voice-style.test.ts` — paired tests (below).

No frontend, no e2e.

## Testing

`voice-style.test.ts` (server Vitest, `node` env, `fetch` mocked):

1. **Provider selection** — `PERSONA_GEN_ENGINE=local` routes to the Ollama
   path; default / `gemini` routes to the `GoogleGenAI` path.
2. **Local happy-path** — a mocked Ollama `/api/chat` response yields a clean
   persona (covers `generateViaOllama` + `cleanPersona`).
3. **No-provider error** — `gemini` engine with no key throws; `local` engine
   with a connection-refused fetch surfaces `LocalUnreachableError`.
4. **Knob-wiring regression** — `resolveVoiceStyleModel()` reflects a registry
   override, locking the disconnected-knob fix (fails before the rewire,
   passes after).

## Acceptance

- Offline install with `personaGeneration.engine: local` and a running Ollama
  daemon can design Qwen voices end to end (persona → `POST /qwen/design-voice`).
- Default install behaviour is unchanged: `gemini` engine,
  `gemini-3.1-flash-lite`, hard error when no key.
- The persona model is configurable from settings; no model id is hardcoded as
  a fallback literal in `voice-style.ts`.
- All four paired tests green; `npm run verify` passes.
