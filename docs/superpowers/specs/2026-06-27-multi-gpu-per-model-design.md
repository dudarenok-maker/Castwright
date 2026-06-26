---
title: Per-model GPU assignment (multi-GPU)
date: 2026-06-27
status: draft
---

# Per-model GPU assignment (multi-GPU)

> Revised three times under adversarial review. R1 fixed the engine-grammar /
> VRAM-allocator model; R2 (5-lens) surfaced the config + Node-orchestration
> gaps and split the work; R3 (5-lens) found the two-plan split was drawn in the
> **wrong place** — the safety net can't be built or tested until engines are
> *placeable* and cards are *visible*. This revision re-cuts into **three
> foundation-first plans**, reverts the unworkable "own the Ollama daemon"
> scope, and scopes the Node semaphore to **guards over the existing global
> pool** rather than a per-card rebuild.

## Problem

The TTS sidecar is single-GPU by design. Where engines *can* be GPU-pinned today
they default to one card (`QWEN_DEVICE=auto` → `cuda:0`; `COQUI_DEVICE` default
`auto`; `SPK_DEVICE`/`ASR_DEVICE` default **cpu**). On a 2-GPU box the second
card sits idle, and safety machinery on **both sides of the process boundary** is
single-card-bound:

- **Sidecar (Python):** the reserved-VRAM recycle ceiling, `/health` telemetry,
  and co-residency eviction read **device 0** (`_cuda_vram_mb`,
  `get_device_properties(0)`, `main.py:3342/4188`); the `_VdKokoroArbiter`
  (`main.py:457`) couples VoiceDesign↔Kokoro unconditionally, even across cards.
- **Server (Node):** the weighted GPU semaphore is a **single global token
  pool** (`gpu/semaphore.ts:36-152`); the analyzer↔TTS co-eviction
  (`gpu/gpu-load.ts`, `gpu/residency.ts`, `gpu/vram-state.ts`) keys on **one
  scalar total** sourced from device 0. Neither can express "card A / card B."

So a user can pin **only Qwen** to a second card today (its knob is a free
string; the others are enums or absent), and the moment two engines land on
different cards the safety net is blind or wrong. Per R2/R3, a naive picker would
make a 2-card box *more* OOM-prone and *unable* to run the parallel analyze+synth
that justifies the second card.

Reference hardware: **RTX 4070 Laptop 8 GB** (drives the display → *free* VRAM
well under 8 GB) and **RTX 5070 Ti 16 GB**. A verified stop-gap
(`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=1,0` in `server/.env`)
remaps the 16 GB card to the visible `cuda:0`. The feature retires this stop-gap
via an explicit `.env` cutover when Plan B lands (§B4).

## Goal

Let the user choose, **per model**, which GPU (or CPU) each runs on, with a
runtime — sidecar **and** server — that honors any assignment **safely**:
per-card recycle, same-card-only coupling, no harmful cross-card eviction, and
**observability of the card a model *actually* loaded onto** (not just the one
requested). A bad assignment must **degrade loudly and recoverably**, never
brick.

### Delivery: three foundation-first plans

R3 showed the safety net depends on two capabilities that don't exist yet —
**placing** an engine on a card, and **reading** per-card VRAM. So those come
first:

- **Plan 0 — Enablement.** Make every engine *placeable* (config knobs that
  accept a card) and every card *visible* (discovery + per-card VRAM + actual-card
  readback). No safety logic, no UI. Independently shippable and testable: pin any
  engine to either card via a knob and *see* where it landed.
- **Plan A — Device-aware safety net.** Per-device recycle, the ledger,
  `shares_device` coupling, the per-card mutex, and the Node guards. Now buildable
  **and** testable because Plan 0 lets you create cross-card configs and read
  per-card data.
- **Plan B — Picker UI + canonical UUID.** The Settings panel, UUID-based
  identity, and the analyzer's read-only row.

### Assignable units (6)

| Unit | Runtime | Device API | Knob (after Plan 0) |
|---|---|---|---|
| **Qwen** (Base + VoiceDesign, one assignment; peak ~6.5 GB) | torch | `cuda:N` via `.to()` | `QWEN_DEVICE` (string ✓ today) |
| **Coqui XTTS** (rarely loaded) | torch | `cuda:N` via `.to()` | `COQUI_DEVICE` (**enum → string**) |
| **ECAPA drift** (voice-consistency QA) | torch (speechbrain) | `cuda:N` via `.to()` | `SPK_DEVICE` (**enum → string**) |
| **Kokoro** (eager, ~1 GB) | **onnxruntime** | **ORT provider `device_id`** | **new `KOKORO_DEVICE`** |
| **Whisper ASR** (content QA / WER) | **CTranslate2** | **`device`+`device_index`** | **new `ASR_DEVICE` knob** |
| **Analyzer (Ollama)** | Ollama daemon (**user/OS-managed**) | daemon `CUDA_VISIBLE_DEVICES` | **OS-env, read-only in picker** (§B3) |

No uniform device grammar: three torch (`cuda:N`), Kokoro ORT (`device_id`),
Whisper CT2 (`device`+`device_index`). The analyzer is **not app-pinnable** — see
§B3 (revert of "own the daemon").

### Apply semantics

**Restart-to-apply** everywhere. In Plan-0/A worlds an assignment is a knob in
`server/.env` or a config override + the existing "restart sidecar" affordance;
the picker (Plan B) is just a nicer front-end to the same knobs. The analyzer
applies via OS-env + an Ollama service restart (§B3).

## Non-goals

- **Auto-placement** (cut — a 2-card box has one obvious layout).
- **App-owned Ollama daemon** (cut — see §B3 for why it's a no-op on Windows).
- **Synchronous per-card Node VRAM budgeting.** Node is not device-aware at
  acquire time (R3); we ship **guards over the global pool** (§A5), not a
  per-card semaphore rebuild.
- **Multi-process sidecar; live re-placement; sharding one model across cards.**

---

# Plan 0 — Enablement (placeable engines, visible cards)

## 0.1 Device discovery

`GET /devices` (sidecar) → server proxy → frontend:
`[{uuid, idx, name, total_mb, free_mb}]` + a `cpu` option, via
`torch.cuda.mem_get_info`/`get_device_properties`. **One canonical schema** used
everywhere (the picker dropdown *and* the `/health` card array §0.4 reuse these
exact field names — no `free` vs `free_mb` schism).

## 0.2 Config knobs — make every engine placeable

- **Widen `COQUI_DEVICE` and `SPK_DEVICE` from `enum` to `string`**
  (`registry.ts:424,281`; `coerceAndValidate` rejects non-enum values today,
  `resolver.ts:73`). (`SPK_DEVICE` is `enum[cpu,cuda]` — no `auto`.)
- **Add a `KOKORO_DEVICE` registry knob** and an **`ASR_DEVICE` registry knob**
  (neither exists today; ASR reaches the sidecar only via `.env` passthrough, and
  Kokoro selects providers by *type* not `device_id` — `main.py:843`). Both
  `apply:'restart-sidecar'`.
- Knob values accept the **legacy/runtime grammar** `{cuda:N | cuda | cpu |
  auto}`. (Canonical **UUID** storage is added in Plan B; Plan 0/A operate on
  index form.)

## 0.3 Device resolution + the engine adapter (Python) and ASR gate (Node)

- **`_resolve_torch_device` must resolve `cuda:N`/index properly** — today it
  returns a non-`auto` value verbatim into `torch.to(...)` (`main.py:1174`), so a
  bad index isn't validated.
- **Engine device-adapter (Python)** — one module translating a knob value into
  each engine's native API: torch `cuda:N` (Qwen/Coqui/SPK), ORT provider
  `device_id` (Kokoro), CT2 `device`+`device_index` (Whisper). All **Python-side**
  `*_DEVICE` reads route through it.
- **Node ASR gate is a SEPARATE change** (it cannot call the Python adapter):
  `asrRunsOnGpu()` is a TS `=== 'cuda'` test (`transcribe-client.ts:58`) that
  must parse `{cpu | cuda | cuda:N}` and still emit the GPU token for the indexed
  form — otherwise indexed ASR runs untracked → OOM.

## 0.4 Actual-card readback (closes the silent-CPU class)

- `/health` gains a **`gpus[]`** array (the existing `devices` field is an
  engine→family map, `main.py:4109` — do **not** collide). Each entry:
  `{uuid, idx, name, total_mb, free_mb, torch_reserved_mb, resident:[engine…]}`.
- **Each engine reports the card it *actually* loaded onto**, probed from the live
  module / ORT session (`get_providers()` exists, `main.py:4010`) — **not** the
  requested knob. ORT/CT2 silently fall back to CPU on a bad device; read-back +
  WARN + a structured `stale`/`fell_back` flag is the only honest signal (memory:
  `project_kokoro_cpu_onnxruntime_gpu_swap`).
- **Per-GPU `device-total`** — `gpu/device-total.ts` parses only the *first*
  nvidia-smi GPU (`:15`); make it per-GPU (`--id`/per-uuid) so Node can later read
  the right card's total.

## 0.5 `.env` shadow awareness

`resolveKnob` checks `process.env` **first** and returns `locked` before reading
config overrides (`resolver.ts:15`). The user's `.env` sets `COQUI_DEVICE`,
`ASR_DEVICE` — so a future picker write to those is a silent no-op. Plan 0
surfaces a **`locked-by-env`** state on each knob (consumed by the picker banner
in Plan B); the `.env` cutover that strips these lines lands with Plan B (§B4).

## Plan 0 testing

Now genuinely testable: pin any engine to either card via its knob and assert
`/health gpus[].resident` shows it on the requested card (or flags `fell_back`).
Pytest (shape, on a *new richer stub* that fabricates `mem_get_info`/`uuid`/
`memory_reserved` — the existing `_StubTorch` lacks all three): adapter resolves
each engine's dialect; `/devices` + `/health gpus[]` schema; per-GPU device-total.
Server vitest: ASR Node gate emits the token for `cuda:N`; knob widening accepts
`cuda:1`. **On-box**: confirm each engine lands where pinned.

---

# Plan A — Device-aware safety net

(Builds on Plan 0: engines are placeable, per-card VRAM and actual-card are
readable.)

## A1. `DeviceLedger` (sidecar) — thread-safe, never caches an index

Owns `engine → device` and per-device samples; read from **three thread
contexts** (the `_memory_watchdog` loop, the sync `/health`+`/devices` threadpool
threads, `asyncio.to_thread` workers). Therefore:

- **One `threading.Lock`** guards the map and any cached state (today's
  `_cuda_vram_mb` is stateless — safe by accident; the ledger is mutable).
- **Index is re-resolved and re-validated every sample, never cached.** A vanished
  card renumbers survivors *downward*, so a cached index silently reads the wrong
  healthy card (no exception). Each read asserts
  `get_device_properties(idx).uuid == expected`; mismatch ⇒ treat as vanished
  (ceiling → 0). This is what makes the "vanished → None" fail-safe real.
- **Two quantities, never conflated:** **driver free/total** (`mem_get_info`,
  sees all allocators — capacity/OOM) vs **torch reserved** (`memory_reserved`,
  torch pool only — fragmentation, torch cards only; Kokoro(ORT)/Whisper(CT2) are
  invisible to it).

## A2. Per-device recycle / watchdog

- **Fragmentation ceiling** (torch reserved): per torch-hosting card, fires on
  **any** crossing (OR rule); each card evaluated on its own freshly-read value.
- **Driver-free ceiling (new) — absolute floor, not a fraction.** A fraction
  self-satisfies on the idle display card (free is always "low") → boot-loop. Use
  an **absolute free-headroom floor**: recycle/self-exit when `free_mb < FLOOR`.
  **Default proposal: 1024 MB, per-card, env-overridable
  (`SIDECAR_VRAM_FREE_FLOOR_MB`); tune on-box.** This is the only OOM guard for a
  card hosting *only* ORT/CT2 engines (torch-reserved ≈ 0 there).
- **Blast-radius (documented limitation):** the hard self-exit (code 43) is
  **whole-process** (`_restart_pending`/`_drain_then_restart` are process-wide,
  `main.py:3485,3512`) — the 8 GB card crossing its ceiling aborts in-flight synth
  on the healthy 16 GB card. v1 accepts this; per-card drain on one
  `_inflight_synth` is deferred.
- **Crash-loop guard (new) — Plan A scope = detect + hold + log only.** A
  too-small assignment loops `load→cross→drain(≤180 s)→self-exit` forever, because
  living >`QUICK_DEATH_MS` (30 s) **resets** `consecutiveFailures`
  (`sidecar-supervisor.ts:40,263`) and `onChildExit` ignores `code`. Add a
  **code-43 streak detector** counting consecutive VRAM self-exits in a wall-clock
  window **regardless of uptime** (proposed: **3 self-exits / 10 min**); on trip,
  **hold TTS down + emit a FATAL log naming the offending card**. *Auto-revert of
  the assignment is deferred to Plan B* (it needs the config-override sink the
  picker owns; Plan A has no write path).

## A3. `shares_device` coupling — symmetric, resolved once

Both couplers gate on `shares_device(a, b)`: (1) load-time evict-to-free, and (2)
the synth-time `_VdKokoroArbiter` (`main.py:457`). `auto` resolves to a concrete
device at ledger init *before* any evaluation; `shares_device(cpu, *)` ⇒ false;
the VD↔Kokoro boolean is computed **once at startup into one flag both
`design()` and `kokoro_synth()` read** (an asymmetric predicate = no lock → the
8 GB three-way spill returns).

## A4. Per-card load/evict mutex

`_VD_KOKORO` covers only VoiceDesign↔Kokoro. Any other same-card pair Plan 0 now
allows (e.g. Coqui + ASR on one card) has a check-residency→evict→load TOCTOU
with no covering lock (`main.py:2147,2163`). Add a **per-physical-card load/evict
mutex** in the ledger; the whole sequence on a card holds it.

## A5. Node guards over the global pool (NOT a per-card rebuild)

R3: Node can't be synchronously device-aware (the semaphore is built eagerly with
one scalar budget, `semaphore.ts:152`; acquire-sites pass an engine *name* with no
card). So **keep the single global pool** and add two **best-effort guards**,
driven by the stored assignment intent (Node knows the *configured* card, even
when actual pinning is OS-env for the analyzer — divergence is best-effort, stated):

- **Don't cross-charge:** the analyzer's whole-budget cost
  (`engine-vram-cost.ts`, analyzer = 4) is **not** charged against the TTS pool
  when the analyzer's configured card differs from the TTS card — unblocking the
  parallel analyze+synth that justifies the second card.
- **Don't cross-evict:** `shouldEvictBeforeSidecarLoad` (`gpu/residency.ts:7`)
  returns **false** when the incoming engine's configured card differs from the
  analyzer's — it currently evicts the warm analyzer to "free" a card it isn't on.
- `costForEngine`'s unknown-key fallback of 1 (`engine-vram-cost.ts:58`) →
  conservative (refuse / high cost), since a mis-mapped engine shouldn't sneak
  past a tight pool.

This is ~80% of the benefit (no over-subscription regression, parallel
analyze+synth works) without the eventually-consistent per-card-budget rebuild.

## Plan A testing

Pytest (shape): ledger lock present; uuid mismatch ⇒ vanished; per-card
fragmentation OR fires on the 8 GB not the 16 GB; driver-free floor trips on a
synthetic low-free; `shares_device` cpu/auto/same truth table; code-43 streak
trips on an uptime-resetting loop. Server vitest: the two A5 guards (no
cross-charge, no cross-evict). **On-box (gating):** per-card recycle fires on the
right card; cross-card analyzer+synth runs in parallel; a forced ORT-CPU fallback
shows in `/health`. CI can't run these (`test:sidecar` venv-gated) — the on-box
checklist is a **named deliverable**, run by the one operator with the box.

---

# Plan B — Picker UI + canonical UUID

## B1. Canonical UUID identity

Store assignments as a GPU **UUID** (stable across driver/index drift); the
adapter (0.3) accepts `{uuid | cuda:N | cuda | cpu | auto}` so legacy pins keep
working. **Reconcile every stored UUID against `/devices` on read** (config lives
in shared `~/.castwright/user-settings.json` — a UUID is box-specific; a
copied-in file is caught only at runtime). Mark unresolved UUIDs `stale` in
`/health` + the picker.

## B2. Settings picker

One row per sidecar engine; a dropdown of `/devices` cards (each showing **free**
VRAM); the **stale badge compares assigned-vs-*actual*** (from 0.4), so a silent
CPU fallback is visible. A structured `/health` field **and a visible banner**
carry "fell back / shadowed-by-env / stale" — not a log WARN to grep (memory:
`feedback_self_service_observability`). Footprint pre-warn uses driver **free**
and Qwen **peak** (~6.5 GB), re-checked **at load time** in the sidecar (WDDM free
swings). On the crash-loop trip (A2), the picker now **auto-reverts** the
offending unit to its safe default and names it (the write path A2 deferred).

## B3. Analyzer row — read-only (revert of "own the daemon")

Owning `ollama serve` is a no-op on the common Windows box: Ollama runs on the
well-known port **11434** as an OS/tray-managed service that's already up, so
"adopt-don't-fight" never applies the pin, and killing it fights the service
manager (R3 daemon review). Instead: the analyzer row is **read-only**,
displaying the current placement and a link to the documented path — set
`CUDA_VISIBLE_DEVICES` (+ the existing `OLLAMA_FLASH_ATTENTION`/`KV_CACHE_TYPE`)
as OS/service env and restart Ollama (`docs/local-llm.md`). Zero new daemon code;
gated on `ANALYZER=local` (dormant under `ANALYZER=gemini`).

## B4. `.env` cutover

Strip `COQUI_DEVICE`/`ASR_DEVICE`/`SPK_DEVICE` **and**
`CUDA_VISIBLE_DEVICES`/`CUDA_DEVICE_ORDER` from `server/.env` (these live only in
the user's gitignored `.env`; **no code edits a user's `.env`** — it's a
documented manual step). The picker surfaces `locked-by-env` (from 0.5) until the
line is removed; the sidecar WARNs if `CUDA_VISIBLE_DEVICES` is still set while
the picker owns mapping.

## Plan B testing

Frontend vitest (rows, discovery dropdown, assigned-vs-actual badge, env-shadow
banner, analyzer read-only row); server vitest (UUID accept/reject + reconcile;
auto-revert on streak-trip); one Playwright e2e (Settings GPU panel vs mocked
`/devices`, select, persists). **On-box** acceptance sign-off, noting `/health`
`free/total` (driver) is VRAM truth while `torch_reserved` under-reports ORT/CT2
by design.

---

## Key files

**Plan 0** — `server/tts-sidecar/main.py` (new `/devices`, `gpus[]` in `/health`,
`_resolve_torch_device` index handling, engine adapter, actual-card probe);
`server/src/config/registry.ts` (widen `COQUI`/`SPK` enums→string; add `KOKORO`/
`ASR` knobs); `server/src/config/resolver.ts` (`locked-by-env` surfacing);
`server/src/tts/spawn-sidecar.ts` (knob injection); `server/src/tts/transcribe-client.ts`
(Node ASR `cuda:N` gate); `server/src/gpu/device-total.ts` (per-GPU); a new
`/devices` proxy route.

**Plan A** — `main.py` (`DeviceLedger` + lock, per-device recycle + driver-free
floor, `_VdKokoroArbiter` 457, per-card mutex, eviction call-sites);
`server/src/tts/sidecar-supervisor.ts` (code-43 streak detector);
`server/src/gpu/semaphore.ts` + `engine-vram-cost.ts` + `gpu-load.ts` +
`residency.ts` + `vram-state.ts` (the two A5 guards — all under `server/src/gpu/`).

**Plan B** — `~/.castwright/user-settings.json` (UUID storage + reconcile-on-read);
Settings view + GPU-assignment panel; `docs/local-llm.md` (analyzer row link);
`.env.example` (cutover doc).

## Open questions / deferred

- **Driver-free floor default (A2)** — 1024 MB proposed; confirm on-box (display
  card idle-free vs true-exhaustion margin).
- **Per-card recycle drain** — whole-process self-exit on any card's cross is a
  documented v1 limitation; per-card drain deferred.
- **Eventually-consistent per-card Node budgets** — the full per-UUID pool map
  (vs A5's guards) is a deliberate post-v1 item if the global pool proves limiting.
