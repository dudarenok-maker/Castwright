# Local LLM in the analyzer — how we use it, and how to grow it

> Audience: future-me, opening this in ~3 months wondering "can we move to an
> 8B and still keep everything resident?". Written 2026-05-15.

This is not a regression plan (those live in `docs/features/29-…` for the
analyzer surface and `…/14-…` for the TTS sidecar). This is the _why_ — the
shape of the VRAM budget, the role the LLM plays, and the tradeoffs we'd hit
moving up a model size.

## What the local LLM actually does

Two stages, both pure JSON-in / JSON-out, both schema-constrained:

- **Stage 1 — cast detection.** Once per book (`whole_book_stage1`), then a
  per-chapter pass (`per_chapter_stage1`) that refines the cast against the
  actual chapter prose. Output: a list of characters with names, aliases, and
  a short bio line each.
- **Stage 2 — sentence-level attribution.** Per chapter. Output: every
  sentence tagged with which character speaks it (or `narrator`). This is the
  load-bearing one — it runs N times per book and dominates wall-clock.

The dispatch lives in `server/src/analyzer/ollama.ts:117` (`OllamaAnalyzer`).
Both stages share the same retry loop, the same Zod-derived JSON schema, and
the same streaming-NDJSON read path.

## Why Ollama, not the SDK or a sidecar

We deliberately did **not** fold the LLM into the Python sidecar that hosts
XTTS. Reasons:

1. Ollama already has the GGUF loader, weight cache, and `keep_alive` eviction
   built in. Re-implementing those in Python to share a process gives nothing
   back.
2. Crash isolation. An XTTS OOM doesn't take the analyzer down and vice
   versa; the Node server treats them as two independent HTTP upstreams with
   independent health probes.
3. We can swap the analyzer model just by changing a tag — the rest of the
   stack doesn't know or care which weights are loaded.

The Node ↔ Ollama interface is plain `POST /api/chat` with `stream: true`.
No SDK. Errors are classified into "daemon unreachable" (→ Gemini fallback)
vs. "daemon up but misbehaving" (→ hard-fail and surface the error). The
classifier is `classifyConnectError` at `server/src/analyzer/ollama.ts:441`
and the policy is documented at the top of the same file.

## The VRAM budget — the actual constraint

8 GB total on the dev box — the site's "sweet spot" tier (`HARDWARE_LINE` in
`src/lib/brand.ts`). The site's entry-point tier is 6 GB (`GPU_VRAM_BUDGET`
drops to `6` there, per INSTALL.md's config table); the budget below scales
down accordingly — expect the 9B/8B analyzer options and Coqui to no longer
co-reside with anything else, and more frequent cross-engine eviction via
`withGpuLoad`. Three things compete for the 8 GB case:

| Tenant                 | Resident size     | When it's loaded                    |
| ---------------------- | ----------------- | ----------------------------------- |
| Analyzer (qwen3.5:4b)  | ~3.0 GB           | During Stage 1 + Stage 2            |
| Analyzer (qwen3.5:9b)  | ~6.6 GB           | During Stage 1 + Stage 2            |
| Analyzer (llama3.1:8b) | ~5.0 GB           | During Stage 1 + Stage 2            |
| XTTS v2 (Coqui)        | ~3.5 GB w/ fp16   | During generation                   |
| KV cache (16K ctx)     | ~1.0–1.5 GB extra | Same window as the analyzer weights |

These numbers are at default Ollama Q4_K_M quant. They are not gospel — Ollama
shows the true resident size in `/api/ps`, which our health probe already
surfaces (`server/src/routes/ollama-health.ts:34`).

Two pipeline phases never run concurrently — analysis runs to completion
before generation starts. So the question is **not** "fit both at once" but
"fit each, and switch cleanly".

We mediate the switch in two places:

1. **`keepAliveFor()`** at `server/src/analyzer/ollama.ts`. Each model's
   `keep_alive` (an integer number of seconds) is resolved per model —
   a user override set in the Model Manager, else a coded default
   (`DEFAULT_KEEP_ALIVE_SECONDS`, `300` for the four models Castwright ships
   suggestions for), else `0`. `300` holds a model across the Stage 1 →
   Stage 2 → next-chapter loop, avoiding a multi-second weight reload between
   every call; `0` (the fallback for an unconfigured custom tag) unloads it
   as soon as the call returns. See
   [docs/features/263-per-model-keepalive.md](features/263-per-model-keepalive.md).
2. **The in-app Load/Stop pill.** `ModelControlPill` on the Analysing screen
   calls `POST /api/ollama/load` (warm) or `/unload` (evict). Loading the
   analyzer auto-evicts XTTS first via `api.unloadSidecar()` (see
   `src/views/analysing.tsx:616`) and surfaces a banner so the user sees the
   swap happen.

The `/load` endpoint is subtle: it **must** warm with the same `num_ctx` the
analyzer uses on real calls (`ANALYZER_NUM_CTX = 16384`), because Ollama keys
the in-VRAM model on `(model, num_ctx)`. Warming with the default 2048 and
then running analysis at 16384 triggers a silent full reload mid-stream,
which used to surface as "Analysis stream ended without a result event" with
no other signal. The reasoning is at `server/src/routes/ollama-health.ts:161`.

### Keeping the analyzer warm + the analyzer↔TTS / two-model-split gotcha (plan 222)

The analyzer model is kept **resident** across the chapter loop (`keep_alive`,
seconds, configured per model in the Model Manager — default `300` for the
supported models) so it isn't unloaded+reloaded between sections — reloading a multi-GB model every
section is the "VRAM sawtooth" / mid-stream stall that hurts large (especially
Cyrillic) books. A resident analyzer can't co-reside with a TTS/voice-design load
on a small GPU, so the server **evicts the resident analyzer before any sidecar
TTS/voice-design load** (or returns a 409 if an analysis is mid-flight), then loads.
On a roomy card (detected VRAM ≥ `GPU_SAFE_COEXIST_MB`, default 11000 MB) nothing
is evicted — analyzer + TTS coexist. See `server/src/gpu/` + plan 222.

**Two-model analysis split — troubleshooting.** If you set TWO *different local*
models for the two analysis phases (`ANALYZER_PHASE0_MODEL` + `ANALYZER_PHASE1_MODEL`),
they can't both stay resident on a small GPU — they'll **reload between phases**,
slowing the run (each phase pays a cold model load). On an 8 GB card this is
unavoidable. To avoid it: use the **same** local model for both phases, pair **one
local + one cloud** model (Gemini uses no VRAM), or run on a **larger card** (12/16 GB)
where both co-reside. A VRAM-aware in-app warning + per-model MB budgeting is tracked
but deferred (issue #845 / `fs-45`) until there's measured telemetry from real
12/16 GB hardware.

## The TTS sidecar side of the budget

The analyzer table above is half the VRAM picture. The sidecar hosts three
synth engines plus Whisper ASR, each with its own resident size, preload
default, and eviction behaviour. The engine map is `ENGINES` in
`server/tts-sidecar/main.py:3401` (`coqui` / `kokoro` / `qwen`); ASR and the
speaker-embedding model (`SPK`) are standalone singletons outside that map
(`main.py:3301`, `3398`).

| Engine                      | Resident size    | Preload default                              | Idle eviction                              |
| ---------------------------- | ---------------- | --------------------------------------------- | -------------------------------------------- |
| Coqui XTTS v2                 | ~3.5 GB (fp16)    | `PRELOAD_COQUI=false` — button-driven          | none; explicit `/unload` only                |
| Kokoro v1                     | ~1 GB             | `PRELOAD_KOKORO=false` (fs-60) — warms on demand; opt in to eager | on-demand; warms on first synth or `/load`   |
| Qwen 0.6B-Base                | ~1.2 GB           | `PRELOAD_QWEN=false` — button-driven           | none; explicit `/unload` only                |
| Qwen 1.7B-Base                | ~3.4 GB           | `PRELOAD_QWEN_BASE17=false`                    | `QWEN_BASE17_IDLE_TTL` (default 120s)         |
| Qwen 1.7B-VoiceDesign          | ~4–5 GB           | never preloaded; always transient              | `QWEN_DESIGN_IDLE_TTL` (default 120s), or freed immediately at the next real `/synthesize` |
| Whisper ASR                   | 0 on CPU / ~150–400 MB on CUDA | `SEG_ASR_ENABLED=false`, `ASR_DEVICE=cpu` | `ASR_IDLE_TTL` (default 120s), CUDA mode only |

(Env-var defaults + comments: `server/src/config/registry.ts:462-682`; sidecar
watchdog wiring: `main.py:3416-3538`. Correction vs. an old note that had
floated around as `autoPreloadKokoro`: the real var is `PRELOAD_KOKORO`.)

**Peak-under-load footprints (capacity-aware admission).** The resident
sizes in the table above are steady-state; admission needs the true DECODE
PEAK, which is higher than the resident weight size. `FootprintTable` in
`main.py` seeds these peaks as COLD-START PRIORS — the anchors below are the
machine-parseable ground truth a parity test (`test_footprints.py`) checks
against `SEED_FOOTPRINTS_MB`. They're measured real per-op decode peaks
(0.6B ~1952 MB, 1.7B mint ~5654 MB) rounded up with margin, refined once the
sidecar has real usage: once an engine/tier has accumulated >= 5 per-op
observations (each op's own CUDA peak, reset right before the op starts —
not the process-lifetime high-water mark), the seed is superseded by the
windowed p95 of the last 64 observations, which tracks real usage up OR
down instead of ratcheting to a single worst-case spike forever.

The two rare, heavy 1.7B **design-family** ops carry their own keys —
`qwen.1.7b.mint` (the base+base co-load behind `/qwen/mint-variant`) and
`qwen.1.7b.design` (`/qwen/design-voice`'s VoiceDesign load) — so they learn
their own p95 instead of being diluted by the far-more-frequent plain 1.7B
synth (`qwen.1.7b`, ~3915 MB) and getting its under-sized reservation (#1738).
Mint's seed (6144) sits just above its measured ~5654 MB peak; design's (7168)
is deliberately higher and **unmeasured** — a VoiceDesign-1.7B + 0.6B-Base load
whose real peak is still owed a measurement (#1742), so it errs toward
refuse-not-OOM until the window learns the true value.

<!-- footprint:kokoro=1200 -->
<!-- footprint:qwen=3072 -->
<!-- footprint:qwen.1.7b=6144 -->
<!-- footprint:qwen.1.7b.mint=6144 -->
<!-- footprint:qwen.1.7b.design=7168 -->
<!-- footprint:coqui=3584 -->
<!-- footprint:asr=400 -->
<!-- footprint:spk=200 -->

**Load/unload path.** `POST /api/sidecar/load` (Node proxy
`server/src/routes/sidecar-health.ts:325`, 90s budget) and `POST
/api/sidecar/unload` (same file, `:368`, 2s budget) front the sidecar's own
`/load` / `/unload` handlers (`main.py:4903` onward), which are idempotent
per-engine via a `_load_lock`. This is the same pair `ModelControlPill` calls
for Coqui/Qwen; Kokoro has no pill because it's never explicitly loaded or
unloaded — see the table above.

**Co-residency — what the sidecar actually enforces vs. what it doesn't:**

- **Qwen 1.7B-VoiceDesign ↔ 1.7B-Base are mutually exclusive.** Loading
  either evicts the other; symmetric (`main.py:2532-2543`,
  `test_qwen_design_base17_exclusion.py`).
- **VoiceDesign evicts resident Kokoro first** (`main.py:2518-2531`,
  `_VD_KOKORO.design()` arbiter) — Kokoro's "always resident" default above
  is the thing that gets bumped.
- **Qwen 0.6B-Base and 1.7B-VoiceDesign DO co-reside** during an active
  design session — `_ensure_base_loaded()` runs alongside
  `_ensure_design_loaded()` (`main.py:2546`).
- **Loading any TTS engine evicts the resident analyzer first**, unless the
  card is roomy (`GPU_SAFE_COEXIST_MB`, default 11000 MB) — this is the
  `withGpuLoad` path already covered above (`server/src/gpu/gpu-load.ts:28`).
- **VoiceDesign vs. ASR is *not* a hard sidecar-side exclusion.** There's no
  eviction code linking the two the way there is for VoiceDesign↔Base17 or
  VoiceDesign↔Kokoro — they're independent singletons with their own idle-TTL
  watchdogs. Any serialization between them comes only from the Node-side
  weighted semaphore below (or, if that's disabled, the blunt
  `GPU_CONCURRENCY=1` fallback that serializes every GPU op process-wide). If
  you've seen this written elsewhere as a guaranteed exclusion, treat it as
  "governed by the semaphore," not as sidecar-enforced.

**The weighted VRAM semaphore.** `server/src/gpu/semaphore.ts:35`
(`GpuSemaphore`, token-budget FIFO) gates concurrent GPU ops across *every*
engine, not just ASR. Weights live in
`server/src/tts/engine-vram-cost.ts:15-32`:

```
kokoro: 1   qwen: 1   coqui: 3   gemini: 0   analyzer: 4   asr: 1   spk: 1
```

Budget is `GPU_VRAM_BUDGET` (default `0` = disabled, which falls back to
`GPU_CONCURRENCY`, default `1` — i.e. fully serial GPU access). The suggested
budget for an 8 GB card is **4** (comment at `engine-vram-cost.ts:69-80`),
which is enough for e.g. `asr(1) + qwen(1) + kokoro(1)` concurrently but not
`analyzer(4) + anything`.

Per-engine device pins (which physical GPU each engine targets, for
multi-GPU boxes) are covered later in this doc under "Moving from
`CUDA_VISIBLE_DEVICES` to per-engine pins" — same `registry.ts` config
surface, `tts.{coqui,kokoro,qwen}.device`.

## Pinning the analyzer to 100% GPU

By default Ollama makes its own GPU-vs-CPU layer-split decision on every model
load, based on a headroom heuristic. The heuristic is twitchy on an 8 GB card
under real load. After moving to `llama3.1:8b` at `num_ctx 16384`, `ollama ps`
reported `8.0 GB, 8%/92% CPU/GPU` — Ollama had silently offloaded ~8% of
layers (~640 MB) to system RAM. That offload is the largest single drag on
stage-2 wall-clock at that model size, and the UI gives no signal it's
happening.

Two complementary levers pin the analyzer to GPU-only:

1. **Daemon env vars** — KV-cache quantisation. Set as Windows system env
   vars (not session env), then restart the Ollama service so the daemon
   picks them up:
   - `OLLAMA_FLASH_ATTENTION=1`
   - `OLLAMA_KV_CACHE_TYPE=q8_0`

   `q8_0` halves the KV cache footprint vs. the default `f16` — at
   `num_ctx 16384` for an 8B model, that's roughly 2.0 GB → 1.0 GB, well
   above the ~640 MB we needed to recover. Flash-attention is a
   prerequisite for the KV-quant code path on most Ollama builds, so set
   them together. Both can be undone by deleting the env vars and
   restarting Ollama; neither bakes anything into the model weights.

2. **`ANALYZER_NUM_GPU` in the request body** — see
   `server/src/analyzer/ollama.ts` (the constant lives next to
   `ANALYZER_NUM_CTX`). We thread `num_gpu: 999` into both
   `/api/chat` (analyzer calls) and `/api/generate` (the in-app `/load`
   warm-up). 999 is the standard "all layers" idiom — Ollama clamps to the
   real layer count per model (32 for llama3.1:8b, 40 for qwen3.5:9b). We
   prefer this over a hard-coded `32` so the knob stays correct if the
   default model swaps to a tag with a different layer count.

   Without this hint, Ollama keeps making the auto-split decision and the
   recovered VRAM from `q8_0` just becomes more headroom for the heuristic
   to leave unused. With it, Ollama either loads every layer to GPU or
   returns a clean OOM at load time — exactly the failure mode we want
   (visible, actionable) instead of silent slowdown.

**Verification.** After setting the env vars + restarting Ollama, click Load
on the in-app analyzer pill, then in PowerShell:

```
ollama ps
```

Expect roughly:

```
NAME           SIZE      PROCESSOR    CONTEXT
llama3.1:8b    ~7.0 GB   100% GPU     16384
```

SIZE should drop ~1 GB (KV cache halved). PROCESSOR should read `100% GPU`,
not `X% CPU/Y% GPU`. If it still shows a split, the daemon didn't pick up
the env vars — most commonly because they were set in a user shell rather
than as system env vars, or because the Ollama service was restarted before
the env vars were saved. `Get-Item Env:OLLAMA_KV_CACHE_TYPE` in a fresh
PowerShell window after restart is the quickest sanity check.

## Why qwen3.5:4b is the default

Three reasons, in order of weight:

1. **It fits resident with the KV cache and still leaves headroom.** 3 GB
   weights + ~1 GB KV cache at 16K context = ~4 GB, on an 8 GB card. The
   other 4 GB is enough breathing room for the OS, the browser, and CUDA's
   own working set. We can take a chapter spike (long chapter, big sentence
   list) without paging.
2. **Schema-constrained decoding makes the "smarter model" gain shrink.** We
   pass each Zod schema through Zod 4's native `z.toJSONSchema` (`runStage` in
   `server/src/analyzer/ollama.ts`) and Ollama's sampler is constrained
   to only emit tokens that keep the output a valid prefix of a value
   matching that schema. The 4B can't go off the rails structurally; the
   remaining variance is semantic, which is where bigger models help — but
   _less_ than they would without constrained decoding.
3. **Retry policy already absorbs most failures.** Validation-retry handles
   schema near-misses (replay-and-correct at low temperature), and
   `invalid-json` failures get a temperature bump + assistant-turn drop on
   retry (`INVALID_JSON_RETRY_TEMPERATURE = 0.6`). What's left after both is
   genuine inability — i.e. the work the bigger model would actually do.

The known weak spot is character-attribution edge cases on dialogue-dense
chapters where the speaker isn't named near the line. That's the kind of
thing an 8B might genuinely fix. See `project_qwen_invalid_json_experiment`
in memory for the deferred root-cause measurement pass.

## Moving up to an 8B: the actual options

> Since plan 221 the analyzer pickers are **dynamic** — they show the union of
> the curated `MODEL_OPTIONS` below and whatever you've actually pulled into
> Ollama (live, via `/api/ollama/health`). So you can `ollama pull` any tag and
> select it without editing this list; the curated entries below are the
> suggestions + their VRAM notes. Since plan 263, `keepAliveFor` resolves
> `keep_alive` per model (seconds) from a Model Manager-configured override
> or a coded default — there is no hardcoded resident-set list to edit.
> Cross-engine eviction before a TTS load is plan 222's `withGpuLoad`.

The curated candidates in the model picker (`src/lib/models.ts`):

- **qwen3.5:9b** — ~6.6 GB resident. Strongest on edge cases in my testing.
  Leaves ~1 GB of headroom for KV cache at 16K context, which is tight. It
  ships with the same `300`s coded default as the other supported models
  (Model Manager → keep-alive field); on a tight 8 GB card, set it to `0`
  there so it doesn't squat between chapters — that trades a multi-second
  reload between Stage 1 / Stage 2 / next chapter for the freed headroom.
- **llama3.1:8b** — ~5.0 GB resident. Middle ground. Probably the sweet spot
  for "8B class, but with room for the KV cache and headroom".

If the goal is **"keep the analyzer resident across the loop, with a real
8B-class model"**, the lever is short:

1. **Pick llama3.1:8b** (or any 8B-class GGUF at Q4_K_M).
2. **Set the model's keep-alive (seconds) in the Model Manager** — `llama3.1:8b`
   already ships a coded default of `300`; a custom/renamed tag defaults to
   `0` until you set it there. That keeps the model in VRAM across the
   Stage 1 → Stage 2 → next-chapter loop the same way the 4B is held.
3. **Verify under load.** Run a chapter analysis with `nvidia-smi -l 1` open
   alongside. Resident should sit around 5–6.5 GB (weights + KV) and stay
   stable across chapter boundaries (no reload pulse). If you see the
   resident drop to zero and re-climb between chapters, the keep-alive isn't
   sticking — check the Ollama log for "model unloaded" lines.
4. **Re-check the auto-evict flow.** Click XTTS Load on the Generate screen
   after analysis finishes; analyzer should evict cleanly and XTTS should
   load. The existing test (`src/views/analysing.test.tsx:365`) covers the
   reverse direction; an 8B that won't evict on demand is the main risk.

### What would _not_ fit

- **qwen3.5:9b held resident across the loop.** 6.6 GB weights + ~1.5 GB KV
  at 16K = 8.1 GB. Over budget. Either drop to `num_ctx: 8192` (smaller KV,
  but we picked 16K specifically because chapters were brushing the limit at
  8K — see `ANALYZER_NUM_CTX` at `server/src/analyzer/ollama.ts:115`) or
  accept the per-call reload tax.
- **Anything plus XTTS at the same time.** Not a new constraint — the
  pipeline is already sequential. Worth re-stating because every model size
  conversation eventually rediscovers it.

### Quantisation as a separate lever

We're using whatever Ollama defaults to per tag (Q4_K_M for most). The
budgets above are at that quant. Q5_K_M / Q6_K push the resident size up
~15–25% per step and _might_ recover some accuracy; Q3 quants shrink the
weights but hit quality more visibly than schema-constrained decoding can
mask. Worth a measurement pass if the 8B move happens, but it's a separate
investigation — don't fold it in.

## Things to measure before flipping the default

The 4B is the default because it's _predictable_, not because it's
necessarily the best quality/throughput trade. Before changing
`DEFAULT_MODEL` (which is sourced from `FRONTEND_ACCOUNT_DEFAULTS` at
`src/lib/account-defaults.ts`), measure:

1. **First-attempt validation rate** per model on Stage 2 across the
   canonical e2e manuscript (`server/src/__fixtures__/the-coalfall-commission.md`). A model
   that's "smarter" but burns a retry every chapter loses on wall-clock.
2. **Wall-clock per chapter** with a `300`s keep-alive active (Model Manager).
   The reload tax is what dominates if the model isn't held resident.
3. **Resident size under real chapter load.** Long-chapter KV-cache spikes
   are the thing that pushes a "fits in theory" model into OOM territory.
   `nvidia-smi` during a Stage-2 pass on the longest chapter is the truth.
4. **Character-attribution quality on dialogue-dense passages.** The
   subjective measure that motivates the move in the first place. Pick 3–5
   chapters where the 4B currently struggles and diff the cast.json /
   attribution output between models.

Out of scope here: replacing Ollama with vLLM / TGI / llama.cpp directly.
Ollama's `keep_alive` + GGUF cache is doing real work for us; the cost of
ripping it out exceeds anything we'd reasonably gain on a single-GPU dev box.

## Moving from CUDA_VISIBLE_DEVICES to per-engine pins

If you previously set `CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=1,0`
in `server/.env` as a multi-GPU stop-gap, the Advanced Configuration device
picker (Voice engine & device) now replaces it with per-engine pins that
survive a driver renumber. To cut over:

1. Set each engine's device (Qwen/Coqui/Kokoro) explicitly in Advanced
   Configuration to the card you want.
2. Remove the `CUDA_DEVICE_ORDER` and `CUDA_VISIBLE_DEVICES` lines from
   `server/.env`.
3. Restart the server (a raw env var needs a server restart, not just a
   sidecar restart — see the design spec's "Apply semantics").

The sidecar logs a WARNING at startup if `CUDA_VISIBLE_DEVICES` is still set,
since it silently overrides every per-engine pin.
