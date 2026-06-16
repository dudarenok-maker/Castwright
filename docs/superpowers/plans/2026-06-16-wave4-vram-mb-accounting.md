# Wave 4 — VRAM MB-accounting policy + two-model-split warning — Implementation Plan

> ⏸️ **STATUS: DEFERRED — `moscow:could`, issue #845 / `fs-45`.** This plan is drafted
> and adversarial-review-hardened but **NOT executed**. An adversarial review (2026-06-16)
> concluded the MB engine is premature: with *guessed* cost numbers it makes the same
> evict/coexist decisions as Wave 1's `gpu.safeCoexistMb` threshold across 8/12/16 GB (and
> mis-evicts on a 12 GB card during voice design), so it adds OOM risk for ~no gain. **Revisit
> only when a real 12/16 GB box provides MEASURED VRAM telemetry** to populate
> `gpu.modelCostMb.*`. The two-model-split gotcha was instead documented in `docs/local-llm.md`
> (no UI). When reviving: re-check the review's BLOCKER 1 (make `incomingMb` a *trailing
> optional* arg so the ~5 passthrough mocks survive) and BLOCKER 2 (use measured, not guessed,
> design cost) — both captured in the #845 comment thread.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the coarse single-threshold eviction decision (`gpu.safeCoexistMb`) with a per-(engine, mode) **MB-accounting** policy, so 12/16 GB beta cards coexist *precisely* (a heavy combo that would overcommit is still caught), and warn at the settings surface when a two-model analysis split won't co-fit.

**Architecture:** A pure cost model (`costMb(key, mode?)`) + a pure `planLoad(state, residentMbs[], incomingMb)`. `withGpuLoad` gains the incoming engine's cost so it can call `planLoad` instead of the threshold; the eviction *action* (evict-all → verify → load under the mutex) is unchanged — only the *decision* gets MB-precise. A small read-only server route exposes `splitFits` so `model-settings-form.tsx` can render a warning without replicating the cost math.

**Tech Stack:** TS (Node ESM), Vitest, Express, the config registry, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md` §7. **Issue:** #845 (fs-45). Builds on plan 222 (Wave 1).

**Branch:** `feat/server-vram-mb-accounting` (off `main`, already checked out).

**Anchors (verified):** `withGpuLoad(loadFn)` (`server/src/gpu/gpu-load.ts:23`, currently uses `shouldEvictBeforeSidecarLoad`); call sites — `ensureSidecarEngineReady` (`server/src/tts/ensure-sidecar-loaded.ts`, wraps the `/load` loop) and `designQwenVoiceForCharacter` (`server/src/routes/qwen-voice.ts`, wraps the design fetch). Residents from `probeOllamaHealth().resident` (`ollama-health.ts`), tag-canonicalized at `ollama-health.ts:143`. VRAM from `getLastKnownVram()` (`gpu/vram-state.ts`). Sidecar engine costs precedent: `gpu.weight.*` (`server/src/tts/engine-vram-cost.ts`). Settings UI: `src/components/model-settings-form.tsx` (`analyzerPhase0Model`/`analyzerPhase1Model`); model labels `src/lib/models.ts`.

**Cost table (initial, registry `gpu.modelCostMb.*`, MB; biased UP on the OOM-critical design path):** ollama `qwen3.5:4b`=3500, `llama3.1:8b`=5000, `qwen3.5:9b`=6400; qwen `synth`=3700, qwen `design`=5000 (Base+VoiceDesign, non-additive — one value, never summed); coqui=3500; kokoro=1000; gemini/cloud=0; unknown→ a high fallback (`gpu.modelCostMb.unknown`, default 7000 — prefer evicting). Headroom reuses `gpu.vramHeadroomMb` (NEW knob, default 1024).

---

### Task 1: Cost model — `costMb(key, mode?)`
**Files:** Create `server/src/gpu/model-cost.ts` + `model-cost.test.ts`. Register knobs in `server/src/config/registry.ts`.
- [ ] Failing tests: `costMb('qwen3.5:9b')`=6400; `costMb('qwen','synth')`=3700 vs `costMb('qwen','design')`=5000 (NOT summed); tag-canonical `costMb('qwen3.5:9b-instruct-q4_K_M')`=6400 (prefix match, reuse the `ollama-health.ts:143` matcher or its helper); unknown id → the high fallback; `costMb('gemini')`=0.
- [ ] Implement `costMb` reading `gpu.modelCostMb.<key>` (live via `configValue`) with the table defaults; canonicalize Ollama tags before lookup. Register the `gpu.modelCostMb.*` + `gpu.vramHeadroomMb` knobs (ConfigKnob shape: `key`/`env`/`type:'integer'`/`min`/`default`/`apply`/`risk`/`label`/`help` — mirror `gpu.safeCoexistMb`). Run `npm run config:sync` and commit the regenerated `.env.example` (do NOT hand-edit it).
- [ ] Green; commit `feat(server): per-(engine,mode) VRAM MB cost model`.

### Task 2: `planLoad` + `splitFits` (pure)
**Files:** add to `server/src/gpu/residency.ts` (or `model-cost.ts`) + tests.
- [ ] Failing tests: `planLoad({cuda,8188},[6400],3700)` → `{fits:false}` (10100 > 8188−1024); `planLoad({cuda,12288},[6400],3700)` → `{fits:true}`; CPU → always fits; unknown total → `{fits:false}` (conservative); `splitFits('qwen3.5:9b','qwen3.5:4b',{cuda,8188})` → false, `(…,{cuda,16384})` → true. Pure — residents' MB injected (no live probe inside).
- [ ] Implement: `planLoad(state, residentMbs, incomingMb)` → CPU/unknown handling then `sum(residentMbs)+incomingMb ≤ totalMb − headroom`. `splitFits(a,b,state) = planLoad(state, [costMb(a)], costMb(b)).fits`. Keep `shouldEvictBeforeSidecarLoad` for now (Task 3 migrates callers off it; remove only once unused).
- [ ] Green; commit `feat(server): planLoad + splitFits MB-fit checks`.

### Task 3: Rewire `withGpuLoad` to MB precision
**Files:** `server/src/gpu/gpu-load.ts` + its call sites + `gpu-load.test.ts`.
- [ ] Failing tests: extend `gpu-load.test.ts` — `withGpuLoad(3700, loadFn)` on `{cuda,8188}` with a resident `[6400]` → evicts (10100 over budget); on `{cuda,12288}` → no evict, coexist; CPU → no evict; analysis-busy on a constrained card → `GpuBusyError`; eviction-verify fail-closed (unchanged). (Mock `costMb`/`probeOllamaHealth`/`planLoad` deps.)
- [ ] Implement: change signature to `withGpuLoad(incomingMb: number, loadFn)`. Decision becomes: read residents via `probeOllamaHealth().resident` → map through `costMb` → `planLoad(getLastKnownVram(), residentMbs, incomingMb).fits` ? `loadFn()` : (mutex → refuse-if-busy → evict-all → verify → load). The evict/verify/refuse machinery is unchanged. Update call sites to pass the incoming cost: `ensureSidecarEngineReady` → `costMb(engine, engine==='qwen'?'synth':undefined)`; `designQwenVoiceForCharacter` → `costMb('qwen','design')`. (Probing residents needs an async read; keep it inside the function. For determinism, planLoad stays pure — the probe + mapping happen in `withGpuLoad`, injected into planLoad.)
- [ ] Green (incl. the existing eviction-regression + the two hook tests still pass with the new signature); commit `feat(server): MB-precise eviction decision in withGpuLoad`.

### Task 4: `GET /api/gpu/split-fits` route
**Files:** a route (e.g. extend `server/src/routes/gpu-queue.ts` or new `gpu-policy.ts`) + test.
- [ ] Failing test: `GET /api/gpu/split-fits?a=qwen3.5:9b&b=qwen3.5:4b` → `{ fits: <bool>, totalMb, budgetMb }` using `splitFits` + `getLastKnownVram`. CPU/unknown → `fits:true`/conservative per `planLoad`.
- [ ] Implement the route; mount it. Add the client method in `src/lib/api.ts` (`getSplitFits(a,b)`), behind the mock too.
- [ ] Green; commit `feat(server): GET /api/gpu/split-fits for the settings split warning`.

### Task 5: Two-model-split warning in settings
**Files:** `src/components/model-settings-form.tsx` + test + e2e.
- [ ] Failing unit test: when `analyzerPhase0Model` ≠ `analyzerPhase1Model` and both are local (Ollama-shaped ids), and the (mocked) `getSplitFits` returns `{fits:false, totalMb:8188}`, the form renders a budget-worded warning ("won't both fit in your ~8 GB GPU — they'll reload between phases"). When `fits:true` (or either model is cloud/gemini, or phase0==phase1), NO warning.
- [ ] Implement: on the relevant model-pick change, call `api.getSplitFits(phase0, phase1)` (debounced/once) and render the inline warning (design tokens only, no hex). Gate on both-local.
- [ ] e2e (mandatory — crosses the settings/redux seam): in an analysing/account e2e, set two different local models, stub `getSplitFits`→false, assert the warning; set equal/cloud → none.
- [ ] Green; commit `feat(frontend): warn when a two-model local split won't co-fit VRAM`.

### Finalize
- [ ] `npm run config:check`; full `LOW_CONCURRENCY=1 npm run verify`; push (pre-push verify) → PR (`Closes #845`); flip plan 222 / spec §7 status note; consider removing now-unused `shouldEvictBeforeSidecarLoad` if Task 3 fully replaced it (else keep + note).

## Self-review notes
- Spec §7 coverage: cost table (T1), planLoad/splitFits (T2), MB-precise withGpuLoad (T3), split-fits route (T4), settings warning (T5).
- **Back-compat:** on 8 GB the MB decision yields the SAME evict-always behavior as the threshold (10100 > 7168), so Wave 1 boxes are unchanged. The win is 12/16 GB precision.
- **Risk:** `withGpuLoad` signature change touches 2 call sites — update both; the eviction-regression test must stay green. `costMb` unknown→high keeps the fail-safe (evict when unsure).
- Out of scope: per-model live-MB calibration; mid-run split confirm (pre-flight warning only).
