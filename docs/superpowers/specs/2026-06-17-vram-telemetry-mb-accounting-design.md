# Self-calibrating VRAM MB-accounting policy + two-model-split UI — Design

**Issue:** #845 (`fs-45`) · **Area:** `area:fs` · **Priority:** `moscow:could` · `needs-plan`
**Date:** 2026-06-17 · **Builds on:** plan 222 (Wave 1 GPU eviction/residency), spec
`2026-06-16-vram-budget-aware-gpu-policy-design.md` §7 (which this supersedes for Wave 4), and the
**already-built measured-VRAM modules** parked on branch `feat/server-dynamic-analyzer-models` /
tag `backup/dynamic-analyzer-models-pre-rebase` (see "Existing foundation" below — reuse, don't rebuild).

## Problem

Wave 1 gave 12/16 GB cards coexistence via a single coarse threshold (`gpu.safeCoexistMb`): a roomy
card simply doesn't evict. Correct for the common case but blunt — a heavy combination on a 12 GB
card (a 9B analyzer resident + a Qwen voice-design load) can pass the coarse threshold yet still
overcommit and OOM.

The obvious fix — a per-(engine, mode) MB cost table fed into a `planLoad` budget check — was
drafted and then **deferred** (`docs/superpowers/plans/2026-06-16-wave4-vram-mb-accounting.md`). An
adversarial review (2026-06-16, on #845) found the deferral correct **as drafted**: with *guessed*
cost numbers, `planLoad` reproduces Wave 1's threshold decisions across 8/12/16 GB and even
**mis-evicts on a 12 GB card during voice design** (9B 6400 + design 5000 = 11400 > 12288 − 1024).
Guessed numbers add OOM risk for ~no decision-quality gain.

**This design removes the guessing.** Costs are no longer authored constants — they are **measured
per-machine, per-model, during real usage**, and the table self-tunes from the high (OOM-safe)
defaults *downward* toward this box's true footprint. OOM risk decays with use; numbers are specific
to this card and the exact model *variants* in play.

## Existing foundation (reuse, do NOT rebuild)

The hard, well-tested half of this already exists on `feat/server-dynamic-analyzer-models` (built
for plan 222 adaptive analyzer keep-alive, parked, never merged to `main`). fs-45 **revives and
extends** it; it does not re-implement it.

- **`server/src/analyzer/model-vram-stats.ts`** — the measured-VRAM store + sampler:
  - `sampleAndRecordVram(url, model, numCtx)` reads Ollama `/api/ps`, finds the resident model, and
    records `size_vram` **only if ≥95 % GPU-resident** (`GPU_RESIDENT_FRACTION` — a partial CPU/GPU
    split under-reports the true need and would teach the engine a model "fits" when it spilled).
    Best-effort, never throws, 1 s abort budget (it runs inside the analyzer GPU lock).
  - Append-only **JSONL** at `telemetryDir()/model-vram-stats.jsonl` (`<WORKSPACE_ROOT>/.telemetry/`),
    capped at 1000 lines. Append-only on purpose — a read-modify-write JSON object loses concurrent
    updates (mirrors `resource-telemetry.ts`).
  - **Key = `canonicalVramKey(model, numCtx)`** = `<tag-or-:latest>@<numCtx>`. Two refinements I would
    otherwise have missed: (1) num_ctx is part of the key because **KV-cache VRAM scales with context**;
    (2) bare family ⇄ `:latest` are the same model, but `:4b` vs `:9b` are not.
  - Aggregation today = **EMA (α 0.3)**, both an async `emaForModelAsync` and a boot-primed sync cache
    (`emaForModelSync`) for the hot `keepAliveFor()` path. `_emaFromRecords` shows the fold pattern.
- **`server/src/gpu/device-total.ts`** — boot-time **`nvidia-smi --query-gpu=memory.total`** probe,
  cached synchronously (`getDeviceTotalVramMb()`). **NVIDIA-only**: non-NVIDIA / no `nvidia-smi` → `null`,
  which *disables* adaptive eviction (callers fall back to the flat knob).
- Consumed by `analyzer/ollama.ts` `keepAliveFor(model)` — adaptive analyzer eviction — and the
  `gpu.*` registry knobs already exist.

**Two corrections to my first-draft architecture, forced by reading this code:**
1. "The server never shells to a GPU vendor tool" is **false** — `device-total.ts` already shells to
   `nvidia-smi` at boot. So there *is* server-side precedent; the AMD story is "extend device-total or
   degrade", not "the server must stay pure".
2. The analyzer-model store already exists with **better keying** (`@numCtx`) and a **resident-fraction
   guard** I didn't have. The spec adopts both verbatim.

## Goals / Non-goals

**Goals**
- Reuse the built analyzer sampler; **extend** measurement to the TTS engines (the genuinely-unbuilt
  part) so the MB cost table is measured end to end.
- Make the eviction/coexistence decision MB-precise so 12/16 GB cards coexist *precisely* without
  evicting in the common case.
- Warn at the settings surface when a two-model analysis split won't co-fit.
- One honest read-only **calibration status line** so beta testers see the engine working and report back.
- Cross-platform by construction (CUDA / ROCm / DirectML / MPS / CPU): vendor tools are best-effort
  enrichment, and absent them the engine degrades to the Wave-1 threshold — never a hard dependency.

**Non-goals**
- Active / synthetic calibration passes — measurement is **passive only** (driven by real loads).
- Per-op live-MB re-measurement mid-run.
- Touching the concurrency semaphore (`gpu.weight.*` / `gpu.vramBudget`) — a *different* axis (how many
  ops co-run as integer tokens), not an MB budget. Untouched.
- A mid-analysis split *confirmation* dialog — pre-flight **warning** only.
- A user-editable cost table / reset controls — the status line is read-only.
- Reworking the existing **EMA**-driven `keepAliveFor()` behavior — it stays as is (see "EMA vs p95").

## Architecture

Four units (Unit 1 already exists; 1-TTS, 2-resolver-extension, 3-decision, 4-frontend are the work).

```
 Real usage (analyzer chats + TTS loads)
        │  samples appended {at,key,vramMb}
        ▼
 model-vram-stats.jsonl  ──reads──▶  Cost resolver  ──MB──▶  Decision engine
 (telemetryDir, existing)            costMb(key,mode?)        planLoad / splitFits /
   ▲        ▲          ▲             EMA→keepAlive             withGpuLoad (MB-precise)
   │Ollama  │torch     │sidecar       p95+margin→eviction              │
   │size_vram reserved  gpu_used_mb  default<MIN_SAMPLES   ┌───────────┼────────────┐
   │(built) (qwen/coqui) (kokoro,new)                      ▼           ▼            ▼
                                              GET /api/gpu/split-fits  warning  calibration line
 device-total.ts (nvidia-smi, existing) ──▶ getDeviceTotalVramMb() / getLastKnownVram()
```

### Unit 1 — Analyzer telemetry (EXISTS) + Unit 1-TTS (NEW)

Revive `model-vram-stats.ts` + `device-total.ts` onto the fs-45 branch unchanged. **Extend** the store
with TTS-engine sample keys, written through the *same* append-only JSONL + the *same* record shape
(`{at, key, vramMb}`), so there is one telemetry file and one read path:

| Key | Source | Vendor-agnostic? | Notes |
|---|---|---|---|
| `<tag>@<numCtx>` (analyzer) | Ollama `/api/ps` `size_vram` | **Yes** (HTTP API) | **Built.** Exact, per-variant, ≥95 %-resident guard. |
| `qwen:synth` | sidecar `/health` `vram_reserved_mb` delta | **Yes** (torch) | **Base 0.6B only.** Gates generation↔analyzer coexistence. |
| `qwen:design` | sidecar `/health` `vram_reserved_mb` delta | **Yes** (torch) | **Base + VoiceDesign 1.7B** (transient). **Design only — never during generation.** |
| `coqui` | sidecar `/health` `vram_reserved_mb` delta | **Yes** (torch) | |
| `kokoro` | sidecar `gpu_used_mb` delta across eager startup | best-effort | onnxruntime invisible to torch — see Unit 1a. |

**`qwen:synth` and `qwen:design` are separate sample pools and must never cross-contaminate.** A
design-time peak (Base+VoiceDesign) must not inflate `synth` (generation would needlessly evict the
analyzer); a synth sample must not deflate `design`. Mode is known at the call site that triggers the
load. TTS deltas use torch `vram_reserved_mb` (process-scoped, so concurrent non-sidecar allocations
don't contaminate them) measured around the load under the existing GPU lock; apply the same
fully-resident sanity guard in spirit (discard a non-positive or absurd delta).

#### Unit 1a — Kokoro / onnxruntime blind spot (cross-platform)

torch can't see Kokoro's onnxruntime allocation, so Kokoro needs a whole-GPU "used MB" reading. Put it
in the **sidecar**, which already detects accelerator family (`main.py:_accel_family`:
`cuda`/`rocm`/`directml`/`mps`/`cpu`) and can dispatch the right probe:

- `cuda` → `nvidia-smi --query-gpu=memory.used` · `rocm` → `rocm-smi` used-memory ·
  `directml`/`mps`/`cpu`/probe-absent → **omit `gpu_used_mb`**.

The sidecar exposes `gpu_used_mb` on `/health`; the server computes Kokoro's startup delta (baseline →
post-Kokoro) from sidecar numbers. Kokoro loads **eagerly at startup before anything else**, so the
delta attributes unambiguously. **Why the sidecar and not server-side `nvidia-smi` (which device-total
already uses):** device-total needs only the *total* (one number, NVIDIA-only is acceptable since
non-NVIDIA disables the engine anyway); `gpu_used_mb` is per-vendor *and* must work on ROCm, where only
the sidecar knows it's really ROCm-behind-a-`cuda`-device-string.

**Graceful degradation:** absent a probe, **Kokoro keeps its default**; the engine never *requires* a
vendor tool. Low-stakes — on the proven on-box DirectML path Kokoro fell back to **CPU (0 VRAM)**, and
its ~1 GB default is small next to the analyzer/Qwen costs that drive eviction.

**AMD/DirectML floor:** on a DirectML-only box `getDeviceTotalVramMb()` is `null` (no `nvidia-smi`) and
sidecar `vram_total_mb` is `None` → no budget → the MB engine **falls back to the Wave-1 threshold**
(`planLoad` unknown-total path). No regression, no false precision. (Optional, deferred: teach
`device-total.ts` a `rocm-smi` fallback so ROCm cards get the MB engine too.)

### Unit 2 — Cost resolver: `costMb(key, mode?)`

Reads the existing JSONL records (filtered by key) — **two aggregations off the same samples**:

- **EMA (existing)** keeps driving `keepAliveFor()` — untouched.
- **`costMb` uses p95 + margin** for the OOM-critical eviction/coexistence decision:
  - `gemini`/cloud → 0. Unknown id → high fallback (`gpu.modelCostMb.unknown`, default 7000 — prefer
    evicting when unsure).
  - **`< MIN_SAMPLES` (default 5) → the registry default** (biased high, OOM-safe). A new machine
    behaves exactly as the static plan would have — safe by construction.
  - **`≥ MIN_SAMPLES` → `p95(samples) + margin`**, margin = `max(10 %, 512 MB)` (registry knob). The
    measured value **may go below the default** — that's the point (a 12 GB card measuring Qwen design
    at ~4200 coexists where the 5000 guess evicted).

**Why p95 for eviction but EMA for keep-alive (deliberate, asymmetric):** the two consumers have
opposite risk postures. `keepAliveFor()` smoothing a wrong call just reloads a model — cheap; EMA's
central-tendency is fine. An eviction OOM is catastrophic and unrecoverable mid-render — so the
eviction path wants the conservative high-quantile + margin, never the average. Same raw samples, two
reads (`_emaFromRecords` and a new `_p95FromRecords`).

Registry defaults (initial, biased UP on the OOM-critical design path; MB): analyzer rows fall back to
the per-tag default only until measured (analyzer is the *measured-first* path in practice); qwen
`synth`=3700, qwen `design`=5000 (Base+VoiceDesign, non-additive — one value, never summed);
coqui=3500; kokoro=1000; unknown=7000.

### Unit 3 — Decision engine

- **`planLoad(state, residentMbs[], incomingMb)`** (pure): `sum(residentMbs) + incomingMb ≤ totalMb −
  headroom`, headroom = `gpu.vramHeadroomMb` (new knob, default 1024). `totalMb` from
  `getDeviceTotalVramMb()` (boot nvidia-smi) ?? `getLastKnownVram().totalMb` (sidecar) — prefer the
  boot probe (the sidecar is typically down during analysis). CPU → always fits. Unknown/`null` total →
  **`{ fits: false }`** conservatively (decline to coexist when blind; caller evicts — today's behavior).
- **`splitFits(a, b, state)`** = `planLoad(state, [costMb(a)], costMb(b)).fits`.
- **`withGpuLoad(loadFn, incomingMb?)`** — incoming cost is a **trailing optional arg** (prior review's
  BLOCKER 1: the ~5 passthrough mocks survive; omitted → today's `shouldEvictBeforeSidecarLoad`
  threshold). Provided → residents via `probeOllamaHealth().resident` → map through `costMb` →
  `planLoad(...).fits` ? `loadFn()` : (mutex → refuse-if-busy → evict-all → verify-closed → load).
  **The evict/verify/refuse machinery is unchanged — only the decision becomes MB-precise.** `planLoad`
  stays pure (probe + mapping happen in `withGpuLoad`, injected). Call sites pass the cost:
  `ensureSidecarEngineReady` → `costMb(engine, engine==='qwen'?'synth':undefined)`;
  `designQwenVoiceForCharacter` → `costMb('qwen','design')`.

### Unit 4 — Frontend surfaces

- **`GET /api/gpu/split-fits?a=&b=`** → `{ fits, totalMb, budgetMb }` (uses `splitFits` + the total
  resolution above; CPU/unknown conservative). Client `api.getSplitFits(a, b)`, mock-backed.
- **Two-model-split warning** in `src/components/model-settings-form.tsx`: when `analyzerPhase0Model` ≠
  `analyzerPhase1Model`, **both local** (Ollama-shaped ids), and `getSplitFits` → `fits:false`, render
  an inline warning ("These two models won't both fit in your ~12 GB GPU — they'll reload between
  phases, slowing analysis."). No warning when equal, either cloud/gemini, or it fits. Debounced,
  design tokens only.
- **Calibration status line** (read-only beta-tester signal) in diagnostics/settings: e.g. *"VRAM
  calibration: 8 of 11 models measured on this GPU (RTX 4070, 12 GB)"* vs *"using defaults"*. Counts
  keys with ≥ MIN_SAMPLES. No controls.

## Telemetry identity & staleness

The JSONL has no GPU stamp today. fs-45 adds a lightweight guard: persist the boot
`getDeviceTotalVramMb()` (+ GPU name when available) as a one-line header/sidecar marker; if it differs
from the live probe at boot, **rotate** the stats file (rename to `.stale`) so numbers from another card
never drive a decision. Ollama re-pulls self-correct already (size_vram read live). This is the only
change to the existing store's persistence contract.

## Data flow (12 GB card mid-design)

1. Analysis with `qwen3.5:9b` (num_ctx 32768) → Ollama `size_vram` ≈ 6100 MB, ≥95 % resident → sample
   `qwen3.5:9b@32768`.
2. After ≥5 samples, `costMb('qwen3.5:9b@32768')` = `p95 + margin` ≈ 6700 (honest, may be ↑ or ↓ vs 6400).
3. Design a voice → `costMb('qwen','design')` from measured design peaks ≈ 4200 + margin ≈ 4720 (vs 5000).
4. `withGpuLoad(designFn, 4720)`: residents `[6700]`, `planLoad({total 12288},[6700],4720)` → `11420 ≤
   11264`? **No → evict.** Guessed 6400+5000 also evicted — but on a card with even slightly lower real
   costs, or 16 GB, the measured path **coexists** where the guess evicted. The win is precision on real
   hardware, earned by measurement.

## Testing

- **Reuse:** port the existing `model-vram-stats.test.ts` + `device-total.test.ts` unchanged (they pin
  the resident-fraction guard, canonical key incl. `@numCtx`, EMA fold, nvidia-smi parse, null-on-absent).
- **TTS sampling (new):** `qwen:synth` vs `qwen:design` recorded to separate pools, no cross-contamination;
  non-positive/absurd delta discarded; Kokoro startup-delta from sidecar `gpu_used_mb`.
- **Sidecar:** `gpu_used_mb` present on cuda/rocm, omitted on directml/cpu (mock family + probe).
- **Resolver:** `<MIN_SAMPLES`→default; `≥MIN_SAMPLES`→p95+margin (incl. below-default); unknown→high;
  gemini→0; EMA path still returns its value for `keepAliveFor`.
- **Decision:** `planLoad` fit math (evict 8 GB, coexist 12 GB, unknown-total→not-fits, CPU→fits);
  `splitFits` true/false; `withGpuLoad` trailing-optional arg (omitted→threshold unchanged;
  provided→MB), eviction-verify fail-closed unchanged, analysis-busy→`GpuBusyError`.
- **Staleness:** fingerprint change → stats file rotated.
- **Route + frontend unit:** `/api/gpu/split-fits` shape; warning shows on local mismatch + `fits:false`,
  hidden on equal/cloud/`fits:true`; calibration line renders measured-vs-default counts.
- **e2e** (settings/redux seam, mandatory): two different local models + stubbed `getSplitFits:false` →
  warning; equal/cloud → none.
- **Regression plan:** new `docs/features/NN-vram-mb-accounting.md` (`needs-plan`).

## Risks & mitigations

- **p95 below true peak → OOM.** Additive margin + conservative `<MIN_SAMPLES` cold-start + unknown-total
  → not-fits. The resident-fraction guard prevents spilled (under-reported) samples from poisoning the pool.
- **EMA/p95 divergence confusing.** Documented asymmetric-risk rationale; both are pure reads of one log.
- **`withGpuLoad` signature churn.** Trailing-optional arg keeps existing call sites/mocks green.
- **Reviving a 33-commits-behind branch.** Port the *modules* (small, self-contained) onto a fresh
  fs-45 branch off current `main`; do not merge the stale branch. Re-run their tests after porting.
- **Semaphore confusion.** Explicit non-goal — `gpu.weight.*` is untouched.

## Open implementation choices (deferred to the plan)

- Exact staleness-marker format (header line vs sidecar `.meta` file) and rotation vs truncation.
- Whether `gpu_used_mb` Kokoro sampling is one-shot at startup or also opportunistic.
- Status-line placement (diagnostics view vs model-settings footer).
- Whether to land the optional `rocm-smi` device-total fallback now or defer to an AMD follow-up.
