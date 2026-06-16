# Self-calibrating VRAM telemetry (v1) + deferred MB-accounting engine — Design

**Issue:** #845 (`fs-45`) · **Area:** `area:fs` · **Priority:** `moscow:could` · `needs-plan`
**Date:** 2026-06-17 · **Builds on:** plan 222 (Wave 1 GPU eviction/residency), spec
`2026-06-16-vram-budget-aware-gpu-policy-design.md` §7, and the built-but-parked measured-VRAM modules
on branch `feat/server-dynamic-analyzer-models` / tag `backup/dynamic-analyzer-models-pre-rebase`.

## Decision: phase the work

This spec was adversarially reviewed twice (2026-06-17). Both reviews — one on correctness/OOM-safety,
one on scope/value — converged, from opposite directions, on **"do not build the decision engine yet"**:

- **The engine wouldn't change decisions on the real hardware.** On a 12 GB card (the RTX 4070 beta
  box) the measured path still evicts a 9B-analyzer + Qwen-design combo — identical to Wave 1's free
  `gpu.safeCoexistMb` threshold. MB-precision only flips a decision on 16 GB cards in a narrow combo
  band that can't be shown to be common.
- **The engine's TTS input can't be measured safely as first drafted.** The proposed TTS cost — a
  *delta* of the sidecar's process-wide, sticky `vram_reserved_mb` high-water mark — conflates
  "increment" with "footprint." For `qwen:design` (Base stays resident, VoiceDesign loads transiently)
  the delta captures only the VoiceDesign increment, recording a value *below* the true peak →
  `planLoad` would coexist → the documented plan-108 three-way OOM.
- **The two-model-split warning guards an anti-recommended config.** `model-settings-form.tsx` steers
  users toward a Gemma + **Gemini** (cloud) split to spread free-tier buckets; a local-local split is a
  discouraged power-user path.

So fs-45 ships in two phases:

- **v1 (this spec, this plan): the passive telemetry substrate.** Revive the already-built analyzer
  sampler + device-total probe, extend measurement to the TTS engines with an **OOM-safe absolute**
  reading (not a delta), persist per-machine. **Nothing consumes the data for a decision yet** — it
  records at near-zero risk so beta testers accumulate *real* per-card, per-variant numbers.
- **v2 (DEFERRED — separate future plan, gated): the decision engine.** `costMb`/`planLoad`/`splitFits`
  + MB-precise `withGpuLoad`, built **only once v1 telemetry from a real 12/16 GB card proves the MB
  decision would flip at least one real eviction** vs the Wave-1 threshold. The split-warning and the
  AMD/`rocm-smi` path are **dropped** unless evidence later justifies them.

This delivers the user's actual goal — *ship defaults, tune on the real machine, OOM risk decays with
use, numbers are machine- and variant-specific* — via the measurement, while deferring the engine that
the data hasn't yet earned.

## Existing foundation (reuse, do NOT rebuild)

Built for plan 222 adaptive analyzer keep-alive, parked, never merged to `main`. **Verified
self-contained** (both reviews): `model-vram-stats.ts` imports only `node:fs`/`node:path` +
`telemetryDir` (on `main` at `workspace/paths.ts:256`); `device-total.ts` imports only
`node:child_process`. Reviving the *modules* drags in no keep-alive/registry coupling.

- **`server/src/analyzer/model-vram-stats.ts`** — `sampleAndRecordVram(url, model, numCtx)` reads
  Ollama `/api/ps`, records `size_vram` **only if ≥95 % GPU-resident** (`GPU_RESIDENT_FRACTION`; a
  partial CPU/GPU split under-reports and would teach a model "fits" when it spilled). Best-effort,
  never throws, 1 s abort budget. Append-only **JSONL** at `telemetryDir()/model-vram-stats.jsonl`,
  capped (see M2 fix). Key = `canonicalVramKey(model, numCtx)` = `<tag-or-:latest>@<numCtx>` — num_ctx
  is in the key because **KV-cache VRAM scales with context**; `:4b`≠`:9b`. Has EMA (α 0.3) reads
  (`emaForModelSync/Async`) — **dormant in v1** (their only consumer, `keepAliveFor`, stays parked).
- **`server/src/gpu/device-total.ts`** — boot `nvidia-smi --query-gpu=memory.total` probe, cached
  synchronously (`getDeviceTotalVramMb()`). **NVIDIA-only**: non-NVIDIA / no `nvidia-smi` → `null`.

Note: the Ollama `size_vram` path is a **clean total resident footprint, not a delta** — the OOM
blocker below applies only to the TTS path, never the analyzer.

## v1 design — the passive telemetry substrate

### Unit A — Revive the analyzer sampler (record-only)

Port `model-vram-stats.ts` + `device-total.ts` onto a fresh fs-45 branch off current `main` (do **not**
merge the 33-commits-behind branch). Wire two things and nothing else:

- Boot init: `initVramStats()` (prime from disk) + `initDeviceTotalVram()` (nvidia-smi total).
- One record-only call on the analyzer chat path (the branch's `ollama.ts:615` site):
  `await sampleAndRecordVram(url, model, resolveAnalyzerNumCtx())` after a provably-resident chat.

**Do NOT wire `keepAliveFor()`'s adaptive-eviction branch** — that is a *decision* consuming telemetry,
which belongs to v2. `main`'s keep-alive behavior (flat `ANALYZER_KEEP_ALIVE` knob) is unchanged. v1 is
pure observation.

### Unit B — Extend measurement to the TTS engines (OOM-safe, absolute)

The B1 fix, stated as a principle: **record an absolute "reserved-at-peak" reading, never a delta.**
A delta of the sticky process-wide `memory_reserved()` can err *low* (unsafe → OOM). The absolute
reserved pool at an op's peak **over-estimates** the model's footprint (it includes sticky/overhead) —
and over-estimation is **conservative / OOM-safe** for any eventual eviction decision (you'd evict more
readily, never coexist into an overcommit). That asymmetry is the whole reason to switch.

- After a successful TTS op, read the sidecar's existing `/health` `vram_reserved_mb` (absolute) at the
  op's peak and record it as a sample for that engine+mode, into the **same JSONL**, same record shape
  `{at, key, vramMb}`.
- Keys (separate sample pools, **never cross-contaminated**): `qwen:synth` (Base 0.6B; generation),
  `qwen:design` (Base + VoiceDesign 1.7B peak; **design only, never generation**), `coqui`.
- **Guard (mirrors the ≥95 %-resident analyzer guard):** record only when the expected engine/model is
  the dominant resident — i.e. for `qwen:design`, only when VoiceDesign is actually loaded; for
  `qwen:synth`, only in a generation context with VoiceDesign *not* resident. This needs a
  "currently-resident engines" signal from the sidecar (see Open choices) so a sample taken while the
  wrong model is resident is discarded rather than mislabeled. Discard non-positive / absurd readings.
- **Kokoro is DEFERRED from v1.** Its onnxruntime allocation is invisible to torch, so it would need a
  net-new sidecar `gpu_used_mb` field with `nvidia-smi`/`rocm-smi` vendor dispatch — speculative and
  cross-vendor. Kokoro is ~1 GB and low-stakes; note it as a known measurement gap, revisit in v2.

### Unit C — Telemetry identity & staleness (M-fix)

The JSONL has no GPU stamp today. Persist the boot `getDeviceTotalVramMb()` (+ GPU name when available)
as a one-line sidecar marker; if it differs from the live probe at boot, **rotate** the stats file
(rename `.stale`) so numbers from another card never persist into a future decision. Ollama re-pulls
self-correct (size_vram read live).

### Folded review corrections

- **M2 — global 1000-line trim starves rare keys.** The analyzer samples on *every* chapter chat, so a
  low-frequency key (coqui, a second analyzer tag) can be trimmed out before reaching a useful count.
  Change the cap from a global last-N to **per-key last-N** (keep e.g. the last 50 samples *per key*),
  so a chatty key can't evict a rare key's history. (Matters for v2's reads and the eventual "N of M
  measured" legibility; harmless but worth doing while the file format is in hand.)
- **m1 — symbol name.** The sidecar family helper is **`_normalize_device_family`** (`main.py:2704`)
  (+ `_ort_providers_to_family`, `main.py:2690`), **not** `_accel_family`. Any v2/Kokoro work cites the
  correct name.
- **M1 — resident→key mapping (v2 note).** `probeOllamaHealth().resident` is **bare model names, no
  numCtx**; the only Ollama-resident model that matters is the analyzer, mapped to its key via
  `resolveAnalyzerNumCtx()`. TTS engines are not Ollama-resident. (Recorded here so v2 doesn't trip.)

### v1 explicit NON-goals

No `costMb`/`planLoad`/`splitFits`; no `withGpuLoad` rewire; no `GET /api/gpu/split-fits`; no
two-model-split warning; no calibration status line; no Kokoro `gpu_used_mb`; no AMD/`rocm-smi`; no
change to `keepAliveFor` or the concurrency semaphore (`gpu.weight.*` / `gpu.vramBudget`). v1 records;
it never decides.

## v2 (DEFERRED) — the decision engine, gated on evidence

Written down so the substrate is built toward it, but **not** in this plan. Trigger to start v2: v1
telemetry from a real 12/16 GB card shows the MB decision would flip ≥1 real eviction vs the threshold.

- `costMb(key, mode?)` = **p95(samples) + margin** for the OOM-critical decision (`< MIN_SAMPLES` →
  high default; gemini → 0; unknown → high fallback). p95 (not EMA) because eviction's risk posture is
  catastrophic-vs-cheap, unlike keep-alive's. Both are pure reads of the same log.
- `planLoad(state, residentMbs[], incomingMb)` (pure) + `splitFits`; `withGpuLoad(loadFn, incomingMb?)`
  with the **trailing-optional arg** (verified: keeps the ~5 single-param passthrough mocks green —
  `cast-design.test.ts`, `ensure-sidecar-loaded.test.ts`, `qwen-voice.test.ts`,
  `eviction-regression.test.ts`, `gpu-load.test.ts`; call-site tests must be *updated* to assert the
  cost is propagated, else a wiring regression goes uncaught). Evict/verify/refuse machinery unchanged.
- **Dropped from v2 unless evidence justifies:** the two-model-split warning (anti-recommended config),
  the AMD/`rocm-smi` path (speculative, zero code, untested hardware).

## Testing (v1)

- **Reuse:** port `model-vram-stats.test.ts` + `device-total.test.ts` (pin the ≥95 %-resident guard,
  `@numCtx` key, nvidia-smi parse, null-on-absent). Adjust the trim test for per-key capping.
- **Unit A:** boot init primes the cache; the analyzer chat path records a sample with the right key;
  best-effort failure never throws / never blocks the chat.
- **Unit B:** `qwen:synth` vs `qwen:design` write to separate pools, no cross-contamination; the
  resident-engine guard discards a sample taken while the wrong model is resident; absolute reading
  recorded (assert it is the `/health` reserved value, not a delta); non-positive/absurd discarded.
- **Unit C:** GPU-fingerprint change → stats file rotated to `.stale`; same fingerprint → appended.
- **No decision tests** — there is no decision in v1 (this is the point). A follow-up assertion that
  `keepAliveFor` / `withGpuLoad` behavior is **unchanged** from `main` guards against accidental wiring.
- **Regression plan:** new `docs/features/NN-vram-telemetry.md` (`needs-plan`) documenting the substrate
  + the v2 trigger condition + the manual "read the JSONL after a tester OOM" acceptance step.

## Risks & mitigations

- **Absolute reserved over-estimates footprint.** Intended — it's the OOM-safe direction. Documented so
  v2's `costMb` reads it knowing it's a conservative ceiling, not an exact footprint.
- **`qwen:synth` measured after a design session reads sticky-high reserved → over-conservative.** The
  resident-engine guard (VoiceDesign-not-resident for synth) plus measuring synth in a clean generation
  context mitigates; worst case is "evict when could coexist," never OOM.
- **Reviving a stale branch.** Port the small self-contained modules onto a fresh branch off `main`;
  re-run their tests after porting. Do not merge the branch.
- **Rare-key starvation.** Fixed by per-key trim (M2).
- **Best-effort recording masks bugs.** Recording is fire-and-forget by design; cover the record path
  with unit tests rather than relying on runtime signal.

## Open implementation choices (for the plan)

- The "currently-resident engines" signal Unit B's guard needs — does `/health` already expose loaded
  engines, or is a small additive field required? (Prefer reusing existing state.)
- Per-key trim N (50?) and whether to also keep a per-key rolling aggregate line for fast reads.
- Staleness marker format (header line vs sidecar `.meta`) and rotate vs truncate.
- Status-line + engine + warning are all v2 — not chosen here.
