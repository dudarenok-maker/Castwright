# Reconcile dynamic analyzer models with main's GPU-residency (#840) — design

- **Status:** active — **Part A only** (dynamic-list reconciliation + keep-alive
  knob). The measured-residency (#845) half is **DEFERRED** to its own Wave-4
  branch after a second adversarial pass found the flat-reserve design reopens
  the 8 GB OOM #840 fixed, and its producer is inert on the headless path. See
  "Deferred: #845" below for the constraints the follow-up must honor.
- **Date:** 2026-06-16
- **Context:** `main` shipped a GPU-residency/eviction system (PR #840, plan
  222) while `feat/server-dynamic-analyzer-models` was in flight. This spec
  reconciles the two into one coherent system.
- **Scope:** server (analyzer keep-alive, GPU residency policy) + the rebase.
  The dynamic-list frontend half is orthogonal and rebases unchanged.

## The collision, precisely

The branch and main are **complementary layers**, colliding in exactly one
function:

| Layer | main #840 (shipped) | this branch (built) | Resolution |
|---|---|---|---|
| Cross-engine evict-before-TTS-load | `withGpuLoad` → `shouldEvictBeforeSidecarLoad(safeCoexistMb=11000)` → evict+verify, 409-on-busy | (none — assumed it existed) | **Keep main's. It IS the auto-evict the branch's keep-alive spec hand-waved.** |
| Per-call Ollama keep_alive TTL | `keepAliveFor(model, accelerator)`: RESIDENT_MODELS→'5m', 9B-on-CPU→0 | rewritten: knob + measured-EMA eviction | **Keep main's structure; make the `'5m'` literal the `ANALYZER_KEEP_ALIVE` knob. Drop the branch's measured eviction here (redundant with `withGpuLoad`).** |
| Measured `size_vram` → residency threshold | static total-capacity threshold; measured headroom is **planned Wave 4 / #845** | built `model-vram-stats` + `/api/ps` sampler + device-total probe (wired to the wrong seam) | **Re-aim the built modules into `residency.ts` to deliver #845 (measured headroom).** |

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | main's #840 system | **Keep entirely** — `withGpuLoad`, `residency.ts`, `vram-state.ts`, `load-mutex.ts`, `safeCoexistMb`, the accelerator-aware `keepAliveFor` shape. |
| 2 | Dynamic-list half | **Rebase unchanged** — `gemma-4 E4B` install entry, `engineForModelId` safety fix, `pullable`, pickers/Model Manager, merge-on-top. (Branch tasks 1,7,8,9,10,11.) |
| 3 | `keepAliveFor` | **main's logic + `ANALYZER_KEEP_ALIVE` knob** replacing the `'5m'` literal (default `'5m'`, preserving shipped behavior). RESIDENT_MODELS + accelerator branch retained. Drop the branch's measured-eviction rewrite, **delete the `keepAliveAdaptive` knob**, and remove the now-dead `getDeviceTotalVramMb`/`emaForModelSync`/`KEEPALIVE_HEADROOM`/`FALLBACK_RESERVE_MB` symbols from `ollama.ts`. |
| 4 | Measured residency (#845) | **DEFERRED** to its own Wave-4 branch (see below). Not in Part A. |
| 5 | Measured-VRAM modules | **Delete from Part A** (`gpu/device-total.ts`, `analyzer/model-vram-stats.ts` + tests + the `index.ts` wiring + the `chat()` sampler) — they have no consumer once #4 is deferred, and dead code isn't shipped. They survive in branch history (commits `985d473e`, `aaf6e46d`, `69fa0dc2`, `305e3fd4`) for the #845 branch to resurrect. |
| 6 | Docs/help | plan 221 → **dynamic-list + keep-alive knob only** (strip its measured-eviction sections, point them at #845); reconcile `local-llm.md` against main's; **rewrite the `analyzer-unloads-between-runs` Help topic** (it currently describes the dropped per-call eviction — reframe to main's keep-alive + `withGpuLoad` eviction, de-duped against main's #849 topic). The other two topics stay. File #845 + the deferred-semaphore-weights row in BACKLOG. |

## Deferred: #845 (measured residency, Wave 4) — constraints for the follow-up

A second adversarial pass killed the flat-`sidecarReserveMb` design proposed
here. The follow-up branch MUST honor these (else it reopens #840's OOM):

1. **Per-(engine, mode) cost table, not a flat reserve.** The decision must be
   `(totalMb − analyzerResidentMb) < costFor(incomingEngine, mode) + cudaHeadroom`
   where `costFor` knows VoiceDesign ≈ 5000, Coqui ≈ 3500, Qwen Base ≈ 1200,
   Kokoro ≈ 1000. A flat reserve (e.g. 4000) coexists then OOMs when VoiceDesign
   (~5 GB) loads onto a 3 GB-resident analyzer on an 8 GB card. Pass the
   incoming engine/mode INTO `shouldEvictBeforeSidecarLoad` (signature change).
2. **A real producer on the headless path.** `analyzerResidentMb` must be the
   summed `/api/ps size_vram` across ALL resident models, sampled while the
   analyzer is provably resident, BEFORE generation's `withGpuLoad`. The probe
   functions (`probeOllamaHealth`/`detectOllamaDevice`) do NOT do this today
   (names-only / boolean), and `vram-state` is fed by the sidecar `/health`
   poll which is down during analysis. The branch's in-`chat()` sampler (inside
   the GPU lock) was the only correct producer — resurrect that, writing the
   resident-sum, not the per-(model,numCtx) EMA (which `residency.ts` can't
   consume as-is).
3. **Gate the coexist branch.** `withGpuLoad`'s coexist path bypasses the lock,
   `verifyOllamaEvicted`, AND `isAnyAnalysisBusy()`. A measured-coexist decision
   must still refuse-on-busy (no sidecar load concurrent with in-flight
   analysis) and must bias every doubt (stale sample, partial-offload
   under-count, unknown) toward the static evict, never toward coexist.
4. **size_vram under-counts** (excludes KV cache + CUDA context) — the cost
   table's `cudaHeadroom` must absorb that, and any null/stale read falls back
   to main's static `safeCoexistMb` threshold.

File as issue `srv-XX` (#845). The built modules in branch history
(`device-total.ts`, `model-vram-stats.ts`) are a starting point but the
consumer (`residency.ts` integration) is the hard, footgun-heavy part.

## (Superseded design sketch — see #845 constraints above, do NOT implement as flat reserve)

Today (`origin/main` `gpu/residency.ts`):
```
shouldEvictBeforeSidecarLoad(v): boolean
  cpu → false; totalMb null → true; else totalMb < safeCoexistMb (11000)
```
This evicts on EVERY 8 GB card regardless of how much the analyzer actually
holds — so a small analyzer (e.g. `qwen3.5:4b` ~3 GB, or the `gemma-4 E4B`
edge model ~5 GB) that *could* coexist with a small engine (Kokoro ~1 GB) on
8 GB is needlessly evicted. The measured upgrade fixes exactly that — and it's
the original motivation for adding the edge model.

**Measured policy.** Extend `VramState` with `analyzerResidentMb: number | null`
(the measured `size_vram` of resident Ollama models, summed). New decision:
```
shouldEvictBeforeSidecarLoad(v):
  if accelerator === 'cpu': return false
  if totalMb == null: return true                 // unknown card → conservative (unchanged)
  if analyzerResidentMb == null: return totalMb < safeCoexistMb   // no measurement yet → main's static fallback
  // measured headroom: would the incoming engine fit alongside what the analyzer actually holds?
  return (totalMb - analyzerResidentMb) < gpu.sidecarReserveMb     // not enough room left → evict
```
- New knob `gpu.sidecarReserveMb` (default ~4000 — a conservative single-engine
  reserve; Coqio/XTTS is the largest at ~3.5 GB). `apply: 'live'`, risk high.
- **Total fallback to main's static behavior** whenever `analyzerResidentMb`
  is null (no `/api/ps` sample yet, Ollama unreachable, or a non-GPU box) — so
  a fresh box behaves exactly as #840 ships today, and the measured path only
  *relaxes* needless evictions once a real sample exists. **It never evicts
  MORE than main does** when measured (bias toward main's safe behavior).
- `analyzerResidentMb` is populated from the `/api/ps` probe that
  `probeOllamaHealth`/`detectOllamaDevice` already run — sum `size_vram` across
  resident models. Cached alongside `vram-state.ts` (or a sibling), refreshed
  on each probe. The `model-vram-stats` EMA store is reused to smooth the
  per-call sample; `device-total` (nvidia-smi boot probe) provides `totalMb`
  when the sidecar hasn't reported it.

**Why this is safe-by-construction:** the measured branch can only return
`false` (coexist) where main returned `true` (evict) when there's genuine
measured headroom; with no measurement it is byte-identical to main. The
failure mode of a stale/under-measured `analyzerResidentMb` is a *needless
evict* (slow, safe), not an overcommit — because we compare against the
card total minus a conservative engine reserve, and `withGpuLoad`'s
`verifyOllamaEvicted` fail-closed still guards the actual load.

> **This is footgun-adjacent eviction code** (registry: "Footguns live here").
> It MUST get its own adversarial review before implementation, with the
> over-commit direction (evict too little → OOM) as the primary attack.

## `keepAliveFor` reconciliation (#3)

Keep main's:
```
keepAliveFor(model, accelerator='unknown'):
  if !RESIDENT_MODELS.has(model): return 0
  if RAM_HEAVY_MODELS.has(model) && accelerator==='cpu': return 0
  return resolveAnalyzerKeepAlive()     // ← was the literal '5m'; now the knob, default '5m'
```
`ANALYZER_KEEP_ALIVE` knob (branch Task 2) is retained with default `'5m'`
(NOT `'1m'` — preserve main's shipped linger). The branch's adaptive
measured-eviction in this function is dropped (withGpuLoad owns active
eviction).

## Rebase strategy

Branch base `af233e67` → current `main` (33 commits ahead). Given the heavy
divergence and that the measured-VRAM middle commits (Tasks 3–6) are being
dropped, prefer a **fresh integration branch off `origin/main`** + selective
re-apply of Part A over a replay-all `git rebase` (which would conflict hard on
Task 6 then need a revert). Preserve the current branch as the fallback / #845
source.

**Files changed on BOTH sides** (from `comm -12` of each side's changed-file
list — the authoritative conflict set; the earlier hand-written list was wrong):
- `server/src/analyzer/ollama.ts` — keep main's `keepAliveFor(model, accelerator)`; replace its `'5m'` literal with `resolveAnalyzerKeepAlive()`; do NOT bring the branch's measured rewrite, sampler call, or dead imports.
- `server/src/analyzer/ollama.test.ts` — take main's keep-alive tests; add only a knob-default assertion. Discard the branch's `keepAliveFor` describe + the `routeChat`/`chatBody` harness (only needed for the dropped in-`chat()` sampler).
- `server/src/config/registry.ts` — keep main's `gpu.safeCoexistMb`; add ONLY `analyzer.ollama.keepAlive` (default **`'5m'`**, not `'1m'`). Do NOT add `keepAliveAdaptive`.
- `server/src/routes/ollama-health.ts` — **keep BOTH**: main's `unloadResidentOllama`/`verifyOllamaEvicted` AND the branch's `pullable` + `/refresh`→delegate.
- `server/src/routes/ollama-health.test.ts` — keep both sides' appended cases.
- `src/views/analysing.tsx` — keep main's `serverModelByPhase` reflow AND the branch's `engineForModelId` classifier + dynamic `modelGroups` + the error-gated `fetchAnalyzerModels` dispatch.
- `src/lib/api.ts` — keep main's diagnostics/health rewrite AND the branch's `pullable` field + mock.
- `docs/local-llm.md`, `docs/features/INDEX.md`, `docs/BACKLOG.md` — merge both; keep plan 221 (trimmed to Part A) + plan 222; backlog gets the #845 row + the deferred-semaphore row.
- `server/.env.example` — regenerate via `npm run config:sync` after the knob set settles (fixes the current `config:check` failure; the branch's measured-eviction prose must go).
- `src/data/help-topics.ts` — rewrite `analyzer-unloads-between-runs` per Decision #6.

**NOT a conflict** (branch never touched it): `scripts/verify-cache.mjs` — auto-resolves to main's (keeps `isVitestPoolCrash`/#850). The earlier list wrongly flagged it.

**Deleted in Part A** (no consumer once #845 deferred): `server/src/gpu/device-total.ts` (+test), `server/src/analyzer/model-vram-stats.ts` (+test), their `index.ts` wiring.

## What of the branch survives vs changes

- **Survives (rebase clean):** Task 1 (install list), 7 (pullable), 8 (model helpers), 9 (engine classifier), 10 (thunk + mock), 11 (pickers/Model Manager), 12/13 (docs/help, reconciled).
- **Re-aimed:** Tasks 3, 4, 5 (device-total, vram-stats, sampler) → feed `residency.ts` instead of `keepAliveFor`.
- **Reverted/reworked:** Task 6 (keepAliveFor rewrite) → main's + knob. Task 2 (knob) → kept, default `'5m'`, layered on main's keepAliveFor.

## Testing

- `residency.test.ts` (main has one): add cases — measured headroom relaxes a needless evict (small analyzer + room → coexist); never evicts less safely than the static path; null measurement → identical to main's static threshold; the `verifyOllamaEvicted` fail-closed still guards.
- `model-vram-stats` / `device-total` tests survive (re-aimed consumer).
- `keepAliveFor` test: knob replaces `'5m'`; RESIDENT_MODELS + 9B-on-CPU behavior preserved.
- Dynamic-list tests (8,9,10,11) survive the rebase.
- Full `npm run verify` green post-rebase (incl. the `config:sync` fix).

## Risks

1. **Eviction-policy correctness (footgun).** Mandatory adversarial review of the measured-headroom decision before implementation — attack the overcommit direction.
2. **Rebase scope.** 33 commits; the `ollama.ts` conflict is the delicate one. Resolve by taking main wholesale then re-applying the knob + dropping the chat() sampler, not by hand-merging the diffs.
3. **Two `/api/ps`-derived notions of "on GPU"** (main's sidecar-`vram_total_mb` accelerator vs Ollama `size_vram`) — keep them as distinct inputs; don't conflate.

## Open questions

- `gpu.sidecarReserveMb` default (4000?) — tune against the real engine sizes (Coqui ~3.5 GB, Qwen ~1.2 GB, Kokoro ~1 GB) in the plan.
- Whether measured `analyzerResidentMb` should also retire the separate `safeCoexistMb` knob or sit alongside it (lean: keep `safeCoexistMb` as the no-measurement fallback).
