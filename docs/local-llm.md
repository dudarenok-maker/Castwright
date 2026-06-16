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

8 GB total on the dev box. Three things compete for it:

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

1. **`keepAliveFor()`** at `server/src/analyzer/ollama.ts:104`. The 4B sits in
   `RESIDENT_MODELS` and gets `keep_alive: '5m'` — Ollama holds it across the
   Stage 1 → Stage 2 → next-chapter loop, avoiding a multi-second weight
   reload between every call. The 9B / 8B fall through to `keep_alive: 0`,
   which unloads them as soon as the call returns.
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

The analyzer model is kept **resident** across the chapter loop (`keep_alive: '5m'`)
so it isn't unloaded+reloaded between sections — reloading a multi-GB model every
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

The candidates already in the model picker (`src/lib/models.ts:19`):

- **qwen3.5:9b** — ~6.6 GB resident. Strongest on edge cases in my testing.
  Leaves ~1 GB of headroom for KV cache at 16K context, which is tight. Right
  now we set its `keep_alive` to 0 so it doesn't squat between chapters; that
  means a multi-second reload between Stage 1 / Stage 2 / next chapter,
  which is real wall-clock overhead.
- **llama3.1:8b** — ~5.0 GB resident. Middle ground. Probably the sweet spot
  for "8B class, but with room for the KV cache and headroom".

If the goal is **"keep the analyzer resident across the loop, with a real
8B-class model"**, the lever is short:

1. **Pick llama3.1:8b** (or any 8B-class GGUF at Q4_K_M).
2. **Add the tag to `RESIDENT_MODELS`** in `server/src/analyzer/ollama.ts:94`.
   That flips `keep_alive` from 0 to `5m`, keeping the model in VRAM across
   the Stage 1 → Stage 2 → next-chapter loop the same way the 4B is held.
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
2. **Wall-clock per chapter** with `keep_alive: '5m'` active. The reload tax
   is what dominates if the model isn't held resident.
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
