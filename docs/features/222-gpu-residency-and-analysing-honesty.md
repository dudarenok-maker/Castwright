---
status: active
shipped: 2026-06-16
owner: null
---

# 222 — GPU residency safety + analysing-view honesty

> Status: active — merged to `main` (Wave 0 #839, Wave 1 #840, W2+W3 #841); **on-box GPU acceptance owed** (real 8 GB eviction + 409 refusal + 12/16 GB coexistence).
> Key files: `server/src/gpu/{vram-state,residency,gpu-load,load-mutex}.ts`, `server/src/analyzer/ollama.ts` (`keepAliveFor`/`RESIDENT_MODELS`), `server/src/routes/ollama-health.ts` (`unloadResidentOllama`/`verifyOllamaEvicted`), `server/src/tts/ensure-sidecar-loaded.ts`, `server/src/routes/qwen-voice.ts`, `server/src/routes/analysis.ts` (phase `model` + section counts), `src/components/analysing/{phase-model-chip,phase-card}.tsx`, `src/views/analysing.tsx`, `src/lib/api.ts`.
> URL surface: `#/analysing` (chip + section progress); server eviction is runtime-only.
> OpenAPI ops: none (SSE/internal).
> Design spec + plans: `docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md`, `docs/superpowers/plans/2026-06-16-wave1-gpu-eviction-residency.md`, `docs/superpowers/plans/2026-06-16-wave2-3-analysing-honesty-progress.md`.

## Benefit / Rationale

- **User:** the analyzer model (`qwen3.5:9b`) stays warm across the analysis loop, killing the per-section ~6.35 GB unload/reload tax — the VRAM sawtooth + mid-stream stalls, worst on Cyrillic manuscripts that need the larger model. The analysing chip now shows the model the server *actually ran* (not the UI default), and large chapters show "section M/N" progress.
- **Technical:** a resident heavy analyzer can no longer OOM against a sidecar TTS/VoiceDesign load — the server evicts (or refuses with a 409) before any sidecar load on a constrained card, atomically under a load-mutex. On a roomy card it coexists.
- **Architectural:** introduces a single VRAM-budget chokepoint (`withGpuLoad`) + a respawn-resilient VRAM-state cache; the per-engine eviction decision is now one place (`shouldEvictBeforeSidecarLoad`) keyed on detected VRAM, tunable via `gpu.safeCoexistMb`.

## Architectural impact

- **New seams:** `gpu/vram-state.ts` (last-known VRAM cache, populated from sidecar `/health`), `gpu/residency.ts` (`shouldEvictBeforeSidecarLoad`), `gpu/gpu-load.ts` (`withGpuLoad` + `GpuBusyError`), `gpu/load-mutex.ts`. Registry knob `gpu.safeCoexistMb` (default 11000). Additive SSE fields: `model` on phase events; `sectionsDone`/`sectionsTotal` on live-tick chapters.
- **Invariants preserved:** OpenAPI-as-source-of-truth (no contract change — SSE only); discriminated-union `ui.stage` untouched; eviction never runs against an in-flight analysis (refuse-with-409 instead). The `GpuSemaphore` (execution token budget) is unchanged and orthogonal to the new load-mutex.
- **Reversibility:** the `keep_alive` flip is undone by removing `qwen3.5:9b` from `RESIDENT_MODELS` (`ollama.ts`). Eviction is gated by `gpu.safeCoexistMb` — set it to a huge value to force coexistence everywhere, or 0 to always evict. The analysing-view additions are display-only and degrade gracefully when the SSE fields are absent.

## Invariants to preserve

1. `withGpuLoad` (`server/src/gpu/gpu-load.ts`) runs the load **inside** the load-mutex on a constrained card: refuse-if-`isAnyAnalysisBusy` → `unloadResidentOllama()` (ALL residents) → `verifyOllamaEvicted()` (fail-closed) → `loadFn()`. Roomy card / CPU → `loadFn()` directly.
2. `shouldEvictBeforeSidecarLoad` (`gpu/residency.ts`): CPU → never; GPU + `totalMb == null`/unknown → evict (conservative); GPU `totalMb < gpu.safeCoexistMb` → evict; else coexist.
3. `unloadResidentOllama()` with no targets evicts **every** `/api/ps` resident (not a scoped name) — so a phase-env/quant-tagged resident isn't missed.
4. `keepAliveFor(model, accelerator)` (`ollama.ts`): `qwen3.5:9b` resident ('5m') only on a GPU; CPU → 0 (spare RAM). Default `accelerator='unknown'` → treated as GPU (the perf win), keeping existing 1-arg callers green.
5. Server-side load chokepoints both wrap in `withGpuLoad`: `ensureSidecarEngineReady` (generation preload, once before the poll loop) and `designQwenVoiceForCharacter` (voice design; route maps `GpuBusyError` → 409).
6. Analysis phase SSE events carry the resolved `model` id (`activeModelId`/`phase1ModelId`/`subsetModelId`); the chip prefers it over the Redux selection (`phase-model-chip.tsx`), Redux fallback only pre-stream.
7. Live-tick chapters carry `sectionsDone`/`sectionsTotal` (via `castInFlightEntryToLiveChapter`); `LiveChapterRow` renders the section line + sub-bar only when `sectionsTotal > 1`.

## Test plan

### Automated coverage
- `server/src/gpu/vram-state.test.ts` — cache respawn-resilience (reachable updates, unreachable no-op).
- `server/src/gpu/residency.test.ts` — threshold across cpu/null/8/12/16 GB.
- `server/src/routes/ollama-health.test.ts` — `unloadResidentOllama` (evict-all) + `verifyOllamaEvicted`.
- `server/src/gpu/gpu-load.test.ts` — evict→verify→load order; 12 GB bypass; refuse-on-busy; fail-closed.
- `server/src/gpu/eviction-regression.test.ts` — evict-precedes-load + refuse-on-analysis-busy (8 GB).
- `server/src/analyzer/ollama.test.ts` — `keepAliveFor` × accelerator + the resident 9B wire contract.
- `server/src/tts/ensure-sidecar-loaded.test.ts` — generation preload runs the gate before `/load`; cloud engines skip.
- `server/src/routes/qwen-voice.test.ts` — voice design returns 409 when busy.
- `server/src/routes/analysis.phase-model.test.ts` — phase events carry the resolved model (phase0/phase1).
- `server/src/routes/analysis.test.ts` — live-tick chapters carry section counts (`castInFlightEntryToLiveChapter`).
- `src/components/analysing/phase-model-chip.test.tsx` — chip prefers `serverModel`; Redux fallback pre-stream.
- `src/components/analysing/phase-card.test.tsx` — section line only when `sectionsTotal > 1`.
- `e2e/analysing-multi-model.spec.ts` — chip shows the server-reported label; section text renders from the mock live tick.

### Manual acceptance walkthrough (USER-RUN, live GPU — OWED)
1. **8 GB box, analyzer = `qwen3.5:9b`:** run analysis on a multi-chapter book. Expected: VRAM holds ~steady (no per-section sawtooth); `ollama ps` shows the 9B resident throughout; no mid-stream "no response" stalls. The analysing chip reads "Qwen3.5 9B (local)" (not 4B). Large chapters show "section M/N".
2. **8 GB, analysis finished → start generation (Qwen TTS):** expected the server evicts the 9B before the sidecar loads (≤ ~8 GB peak, no OOM).
3. **8 GB, start generation WHILE an analysis runs on another book:** expected a clear 409 "GPU busy with analysis" refusal, not an OOM.
4. **8 GB, voice design while analysis idle:** expected eviction then design; while analysis busy → 409.
5. **12/16 GB box (beta tester):** expected NO eviction — analyzer + TTS coexist (set `GPU_SAFE_COEXIST_MB` if the detected total straddles the default 11000).

## Out of scope — Wave 4 (BETA-RELEVANT follow-up, not deferred-indefinitely)

The core 12/16 GB coexistence already ships via the `gpu.safeCoexistMb` threshold (a roomy card simply doesn't evict). Wave 4 refines this for the beta audience, who will have **better cards than the 8 GB dev box**:

- **MB-accounting policy** — replace the single threshold with a per-(engine, mode) MB cost table vs detected VRAM minus headroom (non-additive Qwen synth-vs-design modes), so a 12 GB card with a *heavy* combo (e.g. 9B + Coqui + a lingering model) that passes the coarse threshold but would actually overcommit is caught. Design in spec §7.
- **Two-model analysis-split UI** — when phase0/phase1 use two different local models that won't co-fit, a budget-worded pre-flight warn + confirm (spec §6/§7).

Tracked for the beta because real testers run 12/16 GB cards; not required for the 8 GB path (which evicts unconditionally).

## Ship notes

- **Wave 0** (stray-key tolerance) — issue #842, PR #839, merged `af233e67`, 2026-06-16. Recovers chapters dropped by the strict-schema `chapterId` rejection.
- **Wave 1** (eviction + safe `keep_alive` flip) — issue #843, PR #840, merged `ed42178a`, 2026-06-16. Built via subagent-per-task on `fix/server-gpu-eviction-before-sidecar-load`.
- **W2 + W3** (model honesty + section progress) — issue #844, PR #841, merged `dc163972`, 2026-06-16.
- **Wave 4** (MB-accounting + split UI) tracked open as issue #845 (beta-relevant; see Out of scope).
- Design hardened across three adversarial-review passes (correctness/safety, scope/YAGNI, subagent-executability) before any code — see spec §11 + the plan "review fixes baked in" sections.
- **Remaining before `stable`:** the live-GPU acceptance walkthrough above (5 steps), then flip `status: stable` + archive. Wave 4 (above) is a separate follow-up.
