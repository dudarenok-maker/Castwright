---
status: active
shipped: null
owner: null
---

# VRAM telemetry substrate (fs-45 v1)

> Status: KNOWN: operational dependency (records real per-machine VRAM during normal use; no decision consumes it yet)
> Key files: `server/src/analyzer/model-vram-stats.ts`, `server/src/gpu/device-total.ts`, `server/src/gpu/telemetry-fingerprint.ts`, `server/src/gpu/sidecar-vram-sample.ts`, `server/src/analyzer/ollama.ts`, `server/src/tts/ensure-sidecar-loaded.ts`, `server/src/routes/qwen-voice.ts`, `server/src/routes/sidecar-health.ts`, `server/tts-sidecar/main.py`
> URL surface: none (server/sidecar-side; no UI in v1)
> OpenAPI ops: none (no new HTTP route in v1; one additive sidecar `/health` field `qwen_design_ever_loaded`)

## Benefit / Rationale

- **User:** nothing visible in v1. The payoff is future: OOM risk on 12/16 GB cards drops as the machine self-calibrates, so a later MB-accounting policy can coexist precisely instead of evicting blindly.
- **Technical:** real, per-machine, per-variant VRAM footprints are recorded during ordinary analysis + voice-design + generation, replacing the *guessed* cost numbers an earlier adversarial review (#845) rejected as premature. Each analyzer model variant (`qwen3.5:9b@32768`, etc.) and each TTS mode (`qwen:design`, `qwen:synth`, `coqui`) gets its own measured sample pool.
- **Architectural:** locks in the invariant that **v1 records but never decides** — no eviction/coexistence logic consumes the data, so it cannot regress GPU behavior. It opens the seam (the JSONL pool + the `device-total`/`fingerprint` plumbing) that the deferred v2 MB engine plugs into once the data proves it would flip a decision.

## Architectural impact

**New seams / extension points**
- `server/src/analyzer/model-vram-stats.ts` (revived from the parked `feat/server-dynamic-analyzer-models` branch) — the append-only JSONL store at `telemetryDir()/model-vram-stats.jsonl`, keyed `canonicalVramKey(model, numCtx)` for the analyzer and `qwen:design` / `qwen:synth` / `coqui` for TTS. Per-key last-50 trim (a chatty key can't starve a rare one). EMA helpers present but **dormant** (their only consumer, `keepAliveFor`, stays parked).
- `server/src/gpu/device-total.ts` — boot-time `nvidia-smi --query-gpu=memory.total` probe, cached synchronously. Non-NVIDIA / no nvidia-smi → `null`.
- `server/src/gpu/telemetry-fingerprint.ts` — `rotateStatsIfDeviceChanged()` renames the stats file to `.stale` when the device total changes (card swap / moved install), so another card's numbers never persist. `null` total is a no-op.
- `server/src/gpu/sidecar-vram-sample.ts` — `recordSidecarEngineVram` (absolute reading + discard guards), `sampleSidecarEngineVram` (the clean-process gate), `maybeSampleSidecarEngine` (env-gated probe+record one-liner used by the call sites).
- Sidecar: one additive `/health` field `qwen_design_ever_loaded` (a one-way process-lifetime flag set inside `QwenEngine._ensure_design_loaded`), mirrored as `qwenDesignEverLoaded` on `SidecarHealthResult`.
- Env gate `CASTWRIGHT_VRAM_SAMPLE` (read at call time): sampling is ON unless `=== '0'`. Production never sets it; fetch-count test suites set `'0'`.

**Invariants preserved**
- **v1 records; it never decides.** No `costMb`/`planLoad`/`splitFits`, no `withGpuLoad` signature change, no route, no frontend. `keepAliveFor()` and the concurrency semaphore (`gpu.weight.*`) behave exactly as on `main`.
- **OOM-safe by construction:** TTS samples are the **absolute** `vram_reserved_mb` at an op's peak, never a before/after delta (absolute over-estimates — the safe direction). `qwen:design` is sampled while VoiceDesign is resident (true peak); `qwen:synth`/`coqui` are sampled **only from a process that never loaded VoiceDesign** (the clean-process gate), so the sticky reserved pool reflects that engine's own peak, not a stale design peak.
- **synth and design are separate sample pools** and never cross-contaminate.
- **Best-effort:** every record/sample path is fire-and-forget and cannot throw into or block analysis/synthesis.

**Migration story**
- The JSONL is created on first sample; no existing data shape changes. The fingerprint marker (`vram-fingerprint.json`) is written on first boot. On a device-total change the stats file is rotated to `.stale` (kept for forensics, never read).

## The clean-process gate (why it exists)

`/health`'s `vram_reserved_mb` is torch `memory_reserved()` — a **sticky, process-wide high-water mark** that doesn't compact back until the process recycles. So after any voice-design session the reserved pool stays design-sized (~5 GB). Sampling `qwen:synth` at engine-ready in that same process would record a design-sized number into the synth pool (the `qwenLoaded` flag can't distinguish the modes — it tracks Base, resident in both). The gate samples `qwen:synth`/`coqui` only when `qwen_design_ever_loaded === false`, so in a clean process the sticky reserved IS that engine's true peak. The rare chapter-1 load-time-floor sample (taken before a forward pass) sits below v2's intended p95 and is discarded by it.

## Documented residual

Within a single process, switching between heavy engines (e.g. a Coqui synth then a Qwen synth) can leave a sticky-high reserved reading; the gate only excludes *design* contamination, not engine-switch contamination. Sidecar recycles reset it. v2's per-model sidecar accounting (if ever built) supersedes this. This is an acceptable over-estimate (OOM-safe direction) for a record-only substrate.

## v2 trigger (the deferred MB engine)

Start the deferred MB-accounting engine (`costMb` p95+margin → `planLoad`/`splitFits` → MB-precise `withGpuLoad`, spec `docs/superpowers/specs/2026-06-17-vram-telemetry-mb-accounting-design.md`) **only once telemetry from a real 12/16 GB card shows the MB decision would flip ≥1 real eviction** vs the Wave-1 `gpu.safeCoexistMb` threshold (plan 222). The two-model-split warning + AMD/`rocm-smi` path were dropped from scope by adversarial review unless evidence resurfaces them.

## Test plan / automated coverage

- `server/src/gpu/device-total.test.ts` — nvidia-smi parse, null-on-absent, sync cache.
- `server/src/analyzer/model-vram-stats.test.ts` — canonical key (`@numCtx`), ≥95%-resident guard, EMA fold, per-key last-50 trim (rare key survives).
- `server/src/gpu/telemetry-fingerprint.test.ts` — first-run marker, kept on same total, `.stale` rotation on change, null no-op.
- `server/src/analyzer/ollama-vram-sample.test.ts` — a real `runStage1Chapter` records an analyzer row (env gate ON); existing `ollama.test.ts` green with the gate OFF.
- `server/src/gpu/sidecar-vram-sample.test.ts` — absolute record + discard guards, separate synth/design pools, the gate's six permutations, env-off no-op.
- `server/src/tts/ensure-sidecar-vram.test.ts` — end-to-end: `ensureSidecarEngineReady('qwen')` records a `qwen:synth` row via the real `probeSidecarHealth` path.
- `server/tts-sidecar/tests/test_memory.py` — `/health` exposes `qwen_design_ever_loaded` (False on a fresh process).

## Manual acceptance (GPU box)

1. Run an analysis, then a voice design, then a generation **in fresh/recycled processes**; confirm `<WORKSPACE_ROOT>/.telemetry/model-vram-stats.jsonl` gains `…@<numCtx>`, `qwen:design`, and `qwen:synth`/`coqui` rows.
2. Design-then-generate in the **same** process records NO `qwen:synth` row (the clean-process gate).
3. Spoof/change the device total and confirm the stats file rotates to `.stale`.

## Ship notes

_Pending: shipped date + commit SHA when this lands on `main`._ Implemented on branch `feat/server-vram-telemetry-v1` (subagent-driven, per-task TDD + review). Refs #845.
