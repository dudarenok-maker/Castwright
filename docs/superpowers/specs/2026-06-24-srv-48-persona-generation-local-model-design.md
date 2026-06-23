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

Both callers compute their plan via the shared `resolvePersonaGpuPlan(bookDir)`
(see "GPU coexistence") and thread `onCpu` + `keepAlive` into the local branch;
the GPU plan also evicts the idle sidecar first under the load-mutex.

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

`generatePersonaViaOllama(prompt, model, opts?: { onCpu?: boolean; keepAlive?: string | number }): Promise<string>`

- POSTs to `${getResolvedOllamaUrl()}/api/chat` with the prompt as a single
  user message, `stream: false`, **no `format`**, `think: false`, and a low
  `temperature`. The caller passes a fully-resolved plan (from
  `resolvePersonaGpuPlan`); this helper just executes it.
- **`onCpu`** → sends `num_gpu: 0` (CPU) **and skips the GPU semaphore** (a CPU
  call is not a GPU op; acquiring the semaphore would pointlessly queue it behind
  GPU synthesis). When `onCpu` is false, it acquires
  `gpuSemaphore.acquire(costForEngine('analyzer'))` / release around the fetch
  (mirroring `OllamaAnalyzer.chat()` at `ollama.ts:515-523`).
- **`keepAlive`** → caller-controlled, because the two paths want opposite
  things: the bulk **GPU pre-pass** passes the analyzer's resident window so the
  model stays warm across N personas (one resident window); the single-design
  and CPU paths pass `0` so the model doesn't linger. (A hardcoded `keep_alive:0`
  would have made the pre-pass reload the model N times — the contradiction the
  adversarial review caught.)
- On connection failure, reuses `classifyConnectError()` to raise
  `LocalUnreachableError` with its existing operator message. This requires
  **exporting** `classifyConnectError` from `ollama.ts` (currently
  module-private) — a one-line export, no behaviour change.
- Returns the raw model text; the caller runs it through `cleanPersona()`,
  exactly as the Gemini path does. (VRAM *sampling* is unnecessary for a
  one-shot call and is skipped.)
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
> the simple "mirror the analyzer" framing in #1038 missed it. Both call sites
> share **one** per-call decision, `resolvePersonaGpuPlan` (table under "Decided
> strategy"); the **bulk** path adds batching (a guarded persona *pre-pass*) on
> top. The user's governing principle: **the reverse-evict hazard is only real
> while generation is actually running** — so evict-and-GPU when the sidecar is
> idle (~15 s/persona), and fall back to CPU (~60 s+) only when a render is in
> flight, never disturbing it.
>
> "Constrained card" = `shouldEvictBeforeSidecarLoad(getLastKnownVram())` is
> true (`residency.ts:7-11`: GPU below `gpu.safeCoexistMb`, or unknown total).
> A ≥12/16 GB card coexists fine and takes neither special path; CPU-only
> installs never touch VRAM.
>
> **Scope note:** this lifts srv-48 above a pure "chore" — it adds the shared
> `resolvePersonaGpuPlan` decision, a multi-book-safe reverse-evict primitive,
> and a guarded pre-pass in `cast-design.ts` (with `persona_pass` progress).
> Accepted as part of this design.

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

### Decided strategy (user, 2026-06-24)

Both call sites share **one per-call GPU/CPU decision**; the bulk path adds
batching on top. The unifying principle the user named: **the reverse-evict
hazard is only real when generation is actually running** — if the sidecar is
idle, evicting its (idle, warm) model and running persona gen on the GPU is safe
and **fast (~15 s)**; if generation IS in flight, don't touch the sidecar, fall
back to CPU (**~60 s+**, but safe). The CPU fallback is a real slowdown — ~4×
per persona — so it is reserved for the genuinely-unsafe case, not the default.

**Shared decision — `resolvePersonaGpuPlan(bookDir)`:**

| Card / accel | Other GPU work in flight? | Plan |
|---|---|---|
| roomy (≥ `gpu.safeCoexistMb`) or CPU accel | — | GPU (or native CPU); **no evict** — models coexist / no VRAM |
| constrained | **no** (sidecar idle) | **evict** idle warm sidecar model, then **GPU** persona (~15 s) |
| constrained | **yes** (synthesis/design/analysis) | **CPU** persona (`num_gpu:0`, ~60 s+); **no evict** — never disturb a live render |

"Other GPU work in flight" = `gpuSemaphore.inFlight > 0` OR `isAnyDesignBusy()`
(excluding this `bookDir`) OR `isAnyAnalysisBusy()`. "Constrained" =
`shouldEvictBeforeSidecarLoad(getLastKnownVram())`.

**Single design (drawer) — the decision, N=1.** The single-design persona call
runs `resolvePersonaGpuPlan` and threads the result into `generateViaOllama`
(`onCpu`, and whether to evict first under the load-mutex). No batch machinery,
no `runDesignJob` changes — just the shared decision so a constrained-but-idle
box gets the 15 s GPU path instead of a 60 s CPU wait, and a busy box stays
safe. (CPU calls use `keep_alive: 0` and do **not** acquire the GPU semaphore —
they aren't GPU ops.)

**Bulk "Design full cast" — guarded persona pre-pass.** `runDesignJob`
(`cast-design.ts:159`) gains a pre-pass that, **before** the design loop touches
the sidecar, generates personas for every task character that lacks one (same
freshness/skip rules as the main loop) and persists each. It runs
`resolvePersonaGpuPlan(job.bookDir)` once:

1. **GPU plan (idle constrained card).** Reverse-evict the idle warm sidecar
   model once (a `unloadResidentSidecar` analog of `unloadResidentOllama`, or
   `POST /api/sidecar/unload`, verified via `/api/sidecar/health`), under the
   GPU **load-mutex** (`withGpuLoadLock`) so the evict+first-Ollama-load is
   atomic w.r.t. other GPU loads. Then generate all personas with Ollama
   **resident on GPU** — `keep_alive` set to the analyzer's resident window
   (NOT 0) so the model stays warm across the N calls (one resident window, ~15 s
   each, no per-call reload). The batching is the bulk path's only addition over
   the single-design decision.
2. **CPU plan (generation in flight).** Skip the evict; generate personas on CPU
   (`num_gpu: 0`, `keep_alive: 0`, no semaphore) — safe, ~60 s+ each, never
   disturbs another book's render.
3. **Then the existing design loop runs.** The first `designQwenVoiceForCharacter`
   → `withGpuLoad` evicts the now-resident Ollama before loading VoiceDesign —
   the normal one-directional path. No per-character Ollama↔VoiceDesign thrash.

If a generation *starts* mid-pre-pass, its `withGpuLoad` may evict the pre-pass's
resident Ollama; the next persona call simply reloads (degrades to a reload, not
a corruption). The common single-book case never hits this.

For the `gemini` engine the pre-pass is off-GPU (Gemini is remote) and the
safety probe / evict are skipped — behaviour identical to today, just relocated
ahead of the design loop. The pre-pass's GPU machinery is load-bearing only for
`local` on a constrained card.

### Pre-pass resume / progress / error semantics

The bulk job is sticky and resumable (`cast-design.ts:9-14`), so the pre-pass
must not break re-attach:

- **Progress.** Emit a distinct `persona_pass` phase event (e.g.
  `{ type: 'persona_pass', done, total }`) so the pill can show "Preparing
  personas…" without polluting the design `done/total` counters. The
  `resume_from` payload gains a phase marker so a reload mid-pre-pass re-attaches
  correctly.
- **Idempotent on resume.** Personas are persisted as generated; a re-run /
  resume skips characters that already have a `voiceStyle`, so the pre-pass is
  safe to re-enter.
- **Per-character failure.** A persona-gen failure for one character records a
  `job.failures` entry and is **skipped** in the design loop (can't design
  without a persona) — the run continues for the rest, matching the existing
  per-character `character_failed` behaviour. A wholesale failure (Ollama
  unreachable for the engine) ends the job with a clear error, as today.

## Known limitations & caveats

- **Persona quality.** Per the issue, a small local model may produce weaker
  personas than `gemini-3.1-flash-lite`. `local` is positioned as an opt-in /
  offline fallback, not a quality-equal peer — hence the `gemini` default.
- **GPU coexistence on an 8 GB card** — resolved by the shared
  `resolvePersonaGpuPlan` decision above. **Latency reality:** a local persona is
  **~15 s on GPU** and **~60 s+ on CPU** (per the operator's measurement). So the
  CPU fallback (only taken when generation is genuinely in flight on a
  constrained card) is a real ~4× slowdown — for a large cast designed *while a
  book is rendering*, the pre-pass could add minutes. That is the deliberate
  price of never disturbing a live render; the common idle case stays on the
  ~15 s GPU path. ≥12/16 GB cards and CPU-only installs take neither special
  path.
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
  `generatePersonaViaOllama` (caller-controlled `onCpu` → `num_gpu:0` + skip
  semaphore; caller-controlled `keepAlive`) — or co-locate it in
  `voice-style.ts` and import the exported `classifyConnectError` +
  `getResolvedOllamaUrl` + `gpuSemaphore`/`costForEngine`.
- A new `resolvePersonaGpuPlan(bookDir)` helper (in `voice-style.ts` or a small
  GPU-side module) implementing the decision table — reads
  `shouldEvictBeforeSidecarLoad`, `gpuSemaphore.inFlight`, `isAnyDesignBusy`,
  `isAnyAnalysisBusy`.
- `server/src/config/registry.ts` — the two new knobs (engine, localModel).
- `server/src/routes/cast-design.ts` — bulk persona **pre-pass** (run
  `resolvePersonaGpuPlan` → GPU-evict-then-resident or CPU; then the existing
  design loop) plus the `persona_pass` progress event + resume marker.
- `server/src/routes/ollama-health.ts` (or a sibling) — a reverse-evict
  primitive (`unloadResidentSidecar` + verify, under `withGpuLoadLock`),
  analogous to `unloadResidentOllama`/`verifyOllamaEvicted`. *(Or call the
  sidecar's `POST /api/sidecar/unload` directly — the plan picks.)*
- The single-design caller (`qwen-voice.ts` / the voice-style route) — run
  `resolvePersonaGpuPlan` and thread the result.
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
6. **GPU path: semaphore + resident keep_alive** — with `onCpu:false`, the call
   acquires/releases `gpuSemaphore` and sends the resident `keep_alive` from the
   caller (spy the semaphore; assert acquire-once + release; assert body).
7. **CPU path: no semaphore, num_gpu:0** — with `onCpu:true`, the call sends
   `num_gpu: 0`, `keep_alive: 0`, and does **NOT** acquire `gpuSemaphore` (assert
   the spy was not called) — so a CPU persona never queues behind GPU synthesis.
8. **Gemini rate-limiter retained** — the `gemini` branch still calls
   `geminiRateLimiter.acquire` (spy; assert called), so the branch split can't
   silently drop it.
9. **`resolvePersonaGpuPlan` decision table** — drive the three rows: roomy card
   → GPU/no-evict; constrained + idle (`gpuSemaphore.inFlight===0`,
   not-busy) → evict + GPU; constrained + generation-in-flight
   (`inFlight>0` or `isAnyDesignBusy`/`isAnyAnalysisBusy`) → CPU/no-evict.
10. **Bulk pre-pass ordering** (`cast-design` test) — for a `local`-engine job on
    a mocked constrained + idle card: the sidecar evict + all persona generations
    happen **before** the first `designQwenVoiceForCharacter` (assert call order
    with spies) and personas are persisted. On a mocked generation-in-flight box:
    **no** evict, personas generated on CPU, designs still run. Roomy card /
    `gemini`: no evict.

## Acceptance

- Offline install with `personaGeneration.engine: local` and a running Ollama
  daemon can design Qwen voices end to end (persona → `POST /qwen/design-voice`).
- Default install behaviour is unchanged: `gemini` engine,
  `gemini-3.1-flash-lite`, hard error when no key.
- The persona model is configurable from settings; no model id is hardcoded as
  a fallback literal in `voice-style.ts`.
- A full-cast design under the `local` engine on an 8 GB box does **not** OOM,
  via `resolvePersonaGpuPlan`: idle → evict + GPU persona (~15 s); generation in
  flight → CPU persona (~60 s+), which never disturbs the live render. Verified
  on-box on an 8 GB card — treated as a hard gate, not an assumption.
- A bulk cast-design started **while another book is rendering** completes
  without interrupting that render (the pre-pass takes the CPU path).
- The `gemini` branch still rate-limits (no 429 regression from the split), and
  a `<think>`-prefixed local response still yields a clean persona.
- Bulk local cast-design runs the persona pre-pass (one resident GPU window, or
  CPU when busy) — no per-character Ollama↔VoiceDesign thrash.
- All ten paired tests green; `npm run verify` passes.
