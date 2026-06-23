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

`generateVoiceStylePersona(character, opts?)` becomes a dispatcher over a
resolved engine; both branches share `buildVoiceStylePrompt()` and
`cleanPersona()`, so only the model call differs. `opts.onCpu` is forwarded to
the local branch (default false) so callers control the CPU-pin:

```
generateVoiceStylePersona(character, opts?)   // opts.onCpu?: boolean
  → resolvePersonaEngine()                    // 'local' | 'gemini', from registry
  → engine === 'gemini'
       ? generateViaGemini(character)         // existing inline GoogleGenAI path
       : generateViaOllama(character, opts)   // new thin Ollama path (onCpu → num_gpu:0)
```

Two callers thread `onCpu` differently (see "GPU coexistence"): the
single-design route passes `shouldEvictBeforeSidecarLoad(...)`; the bulk
pre-pass passes `false` (it evicts the sidecar up front instead).

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

`generatePersonaViaOllama(prompt: string, model: string, opts?: { onCpu?: boolean }): Promise<string>`

- POSTs to `${getResolvedOllamaUrl()}/api/chat` with the prompt as a single
  user message, `stream: false`, **no `format`**, `think: false`, and a low
  `temperature`. When `opts.onCpu` is set, sends `num_gpu: 0` to keep the call
  off the GPU (the single-design CPU-pin path). Callers decide: the single-design
  route passes `onCpu: shouldEvictBeforeSidecarLoad(getLastKnownVram())`; the
  bulk pre-pass passes `onCpu: false` (it has already evicted the sidecar).
- On connection failure, reuses `classifyConnectError()` to raise
  `LocalUnreachableError` with its existing operator message. This requires
  **exporting** `classifyConnectError` from `ollama.ts` (currently
  module-private) — a one-line export, no behaviour change.
- Returns the raw model text; the caller runs it through `cleanPersona()`,
  exactly as the Gemini path does.
- **Acquires the GPU semaphore** (`gpuSemaphore.acquire(costForEngine('analyzer'))`
  / release, mirroring `OllamaAnalyzer.chat()` at `ollama.ts:515-523`) and passes
  `keep_alive: 0` so the persona model never *lingers* in VRAM. **Necessary but
  NOT sufficient** for OOM-safety on a constrained card — the semaphore only
  serialises concurrent Node ops; it does not evict an already-resident sidecar
  model. See "GPU coexistence" below for the unresolved part. (VRAM *sampling*
  is genuinely unnecessary for a one-shot call and is skipped.)
- **`<think>` guard.** A local *thinking* model may ignore `think: false` and
  emit `<think>…</think>` ahead of the persona. The structured analyzer path is
  protected by Zod-constrained decoding; the freeform persona path is not. So
  `cleanPersona()` must additionally strip a leading `<think>…</think>` block
  (covered by a paired test) — otherwise the reasoning preamble lands in the
  `instruct`.

### Preserve the Gemini rate limiter

The refactor splits the function into branches. The `gemini` branch MUST retain
`geminiRateLimiter.acquire(model, estTokens)` (`voice-style.ts:163`) — a
generate-all run of N characters would otherwise compound into a 429 storm.
This is a regression risk of the split, called out so the plan locks it with a
test.

## Error & fallback behaviour

Mirrors the analyzer's deliberate asymmetry (Q2):

- `engine: gemini`, no key resolves → **throw** the existing clear message
  (set a key from Account → Server configuration, or switch
  `personaGeneration.engine` to `local`). No silent fallback to local.
- `engine: local`, daemon unreachable → throw `LocalUnreachableError`'s message
  ("Start the daemon or set …"). No auto-jump to Gemini.
- Empty model response → the existing per-branch "returned an empty persona"
  error.

## GPU coexistence — RESOLVED (path-specific)

> **Status: DECIDED (user, 2026-06-24).** The adversarial review surfaced this;
> the simple "mirror the analyzer" framing in #1038 missed it. The two call
> sites get **different** strategies because they have different shapes:
>
> - **Bulk "Design full cast"** → **persona pre-pass** (resolution 3). Generate
>   every needed persona up front (Ollama resident), then run the design loop;
>   the first design's `withGpuLoad` evicts Ollama before VoiceDesign loads. One
>   Ollama-resident window, no per-character thrash. On a constrained card, do a
>   **single up-front sidecar evict** first so the GPU pre-pass has room if a
>   prior single-design already warmed VoiceDesign (one reverse-evict per run,
>   not 2N).
> - **Single design (drawer)** → **CPU-pin** (resolution 1). For one persona a
>   pre-pass is meaningless; on a constrained card issue the persona `/api/chat`
>   with `num_gpu: 0` so a seconds-scale CPU call never competes with the
>   (possibly warm) VoiceDesign for VRAM. Roomy card → GPU.
>
> "Constrained card" = `shouldEvictBeforeSidecarLoad(getLastKnownVram())` is
> true (`residency.ts:7-11`: GPU below `gpu.safeCoexistMb`, or unknown total).
> A ≥12/16 GB card coexists fine and takes neither special path; CPU never
> touches VRAM.
>
> **Scope note:** this lifts srv-48 above a pure "chore" — the bulk path is a
> real (small) restructure of `cast-design.ts`'s loop, not just a new branch in
> `voice-style.ts`. Accepted as part of this design.

Today persona generation is off-GPU (Gemini), so it needs no GPU arbitration.
The local path introduces a **new on-GPU consumer** at a point in the flow that
already has heavy models resident.

Evidence from the bulk "Design full cast" loop (`cast-design.ts:166-312`),
per character:

```
line 221:  persona = await generateVoiceStylePersona(character)   // local → Ollama, on GPU
line 246:  await designQwenVoiceForCharacter({ ..., persona })     // Qwen VoiceDesign, on GPU
```

The persona call at `:221` sits **outside** the design-lock + GPU machinery that
guards `designQwenVoiceForCharacter` (`cast-design.ts:16-22`). Qwen VoiceDesign
(1.7B, ~4–5 GB) is kept **warm-resident across the cast-review session**, and
CLAUDE.md's plan-108 note warns: *"don't add a third heavy model on top — that
was the plan-108 OOM."*

**Why the semaphore is not enough.** `gpuSemaphore` (`semaphore.ts`) is a
token-budget that only *serialises concurrent Node ops* — it never evicts a
model. After a design completes it releases its tokens, but VoiceDesign stays
**warm-resident in the sidecar**. The next persona Ollama call then finds the
tokens free and loads **on top of** the resident VoiceDesign → OOM on an 8 GB
box.

**Why there is no existing eviction path.** Cross-engine eviction
(`withGpuLoad`, `gpu-load.ts:23-39`) is **one-directional**: before a *sidecar
load* it evicts the *resident Ollama* (`unloadResidentOllama` + fail-closed
`verifyOllamaEvicted`). There is **no reverse path** that evicts a resident
sidecar model before an *Ollama* load — the normal flow never needs one because
analysis always precedes generation. Cast-design inverts that ordering.

**Where it does / doesn't bite** (`residency.ts:7-11`,
`shouldEvictBeforeSidecarLoad`): a card **≥ `gpu.safeCoexistMb`** (12/16 GB)
coexists fine — no problem there. **CPU** Ollama never touches VRAM — fine
(slow). The hazard is precisely the **8 GB GPU**, this project's primary target.

### Decided strategy

**Single design (drawer) — CPU-pin on constrained cards.** When
`shouldEvictBeforeSidecarLoad(getLastKnownVram())` is true, `generateViaOllama`
issues the persona `/api/chat` with `num_gpu: 0` (CPU). A single 15–40-word
persona is a seconds-scale CPU task, so it never competes with a warm
VoiceDesign for VRAM and "just works" offline. On a roomy card it runs on GPU.
No cast-design restructure for this path.

**Bulk "Design full cast" — persona pre-pass.** `runDesignJob`
(`cast-design.ts:159`) gains a pre-pass that, **before** the design loop touches
the sidecar, generates personas for every task character that lacks one (same
freshness/skip rules as the main loop) and persists each. Sequence:

1. If the engine is `local` **and** the card is constrained, evict the sidecar
   once up front (reverse-evict, so the GPU pre-pass has room even if a prior
   single-design warmed VoiceDesign). Reuse the existing eviction primitives —
   a `unloadResidentSidecar` analog of `unloadResidentOllama`, or the sidecar's
   `POST /api/sidecar/unload` — verified before proceeding.
2. Generate all needed personas with Ollama **resident on GPU** (fast; one
   resident window; persisted per character via the existing minimal-patch
   write).
3. Run the existing design loop. The first `designQwenVoiceForCharacter` →
   `withGpuLoad` evicts the resident Ollama before loading VoiceDesign — the
   normal one-directional path. No per-character Ollama↔VoiceDesign thrash.

For the `gemini` engine the pre-pass is a no-op restructure (personas can still
be generated inline as today, or in the same pre-pass off-GPU — behaviour
identical). The pre-pass branch is only load-bearing for `local`.

## Known limitations & caveats

- **Persona quality.** Per the issue, a small local model may produce weaker
  personas than `gemini-3.1-flash-lite`. `local` is positioned as an opt-in /
  offline fallback, not a quality-equal peer — hence the `gemini` default.
- **GPU coexistence on an 8 GB card** — resolved per-path above. Single design:
  a few seconds of CPU latency per persona. Bulk: one up-front sidecar evict per
  run, no per-character thrash. ≥12/16 GB cards and CPU installs take neither
  special path.
- **Malformed local model id.** A `PERSONA_GEN_LOCAL_MODEL` without a `:`
  (a Gemini-style id) is passed straight to Ollama → a reachable-but-errored
  hard fail at the daemon. The analyzer never hits this because it *infers*
  engine from the `:`; here the engine is explicit, so the id is trusted. We do
  not add validation — the daemon's error is surfaced verbatim — but it is
  noted so the failure mode is understood.

## Files touched

- `server/src/analyzer/voice-style.ts` — dispatcher, new resolvers, the
  `generateViaOllama` branch, rewired `resolveVoiceStyleModel()`, retained
  `geminiRateLimiter` on the Gemini branch, and a `<think>…</think>` strip added
  to `cleanPersona()`.
- `server/src/analyzer/ollama.ts` — export `classifyConnectError`; add
  `generatePersonaViaOllama` (acquires `gpuSemaphore`, `keep_alive: 0`,
  optional `num_gpu: 0` via `opts.onCpu`) — or co-locate it in `voice-style.ts`
  and import the exported `classifyConnectError` + `getResolvedOllamaUrl` +
  `gpuSemaphore`/`costForEngine`.
- `server/src/config/registry.ts` — the two new knobs (engine, localModel).
- `server/src/routes/cast-design.ts` — bulk persona **pre-pass** (constrained
  local → up-front sidecar evict, then GPU persona gen for all needed
  characters, then the existing design loop).
- `server/src/routes/ollama-health.ts` (or a sibling) — a reverse-evict
  primitive (`unloadResidentSidecar` + verify), analogous to the existing
  `unloadResidentOllama`/`verifyOllamaEvicted`, used only by the bulk pre-pass
  on constrained cards. *(Or call the sidecar's `POST /api/sidecar/unload`
  directly — the plan picks.)*
- The single-design caller (`single-design.ts` / the voice-style route) — pass
  `onCpu` based on `shouldEvictBeforeSidecarLoad`.
- `server/src/analyzer/voice-style.test.ts` + a `cast-design` test — paired
  tests (below).

No frontend, no e2e (the config UI auto-renders the knobs; the GPU paths are
server-internal).

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
5. **`<think>` strip** — a mocked Ollama response prefixed with
   `<think>…</think>` yields a clean persona with the block removed (locks the
   `cleanPersona` change; fails before, passes after).
6. **GPU semaphore + keep_alive** — the local path acquires/releases
   `gpuSemaphore` around its call and sends `keep_alive: 0` (spy/mock the
   semaphore; assert acquire-once + release; assert the request body).
7. **Gemini rate-limiter retained** — the `gemini` branch still calls
   `geminiRateLimiter.acquire` (spy; assert called), so the branch split can't
   silently drop it.
8. **CPU-pin on constrained card (single design)** — with
   `shouldEvictBeforeSidecarLoad` mocked true, `onCpu` is set and the request
   body carries `num_gpu: 0`; mocked false → no `num_gpu: 0` (GPU path).
9. **Bulk pre-pass ordering** (`cast-design` test) — for a `local`-engine job
   on a mocked constrained card: the sidecar evict + all persona generations
   happen **before** the first `designQwenVoiceForCharacter` call (assert call
   order with spies), and personas are persisted. On a roomy card / `gemini`
   engine, no up-front evict is issued.

## Acceptance

- Offline install with `personaGeneration.engine: local` and a running Ollama
  daemon can design Qwen voices end to end (persona → `POST /qwen/design-voice`).
- Default install behaviour is unchanged: `gemini` engine,
  `gemini-3.1-flash-lite`, hard error when no key.
- The persona model is configurable from settings; no model id is hardcoded as
  a fallback literal in `voice-style.ts`.
- A full-cast design under the `local` engine on an 8 GB box does **not** OOM,
  per the chosen GPU-coexistence resolution (recommended: CPU-pin the persona
  call when `shouldEvictBeforeSidecarLoad` is true). Verified on-box on an 8 GB
  card — a measurement this design treats as a hard gate, not an assumption.
- The `gemini` branch still rate-limits (no 429 regression from the split), and
  a `<think>`-prefixed local response still yields a clean persona.
- Bulk local cast-design runs the persona pre-pass (evict → all personas → all
  designs) — no per-character Ollama↔VoiceDesign thrash.
- All nine paired tests green; `npm run verify` passes.
