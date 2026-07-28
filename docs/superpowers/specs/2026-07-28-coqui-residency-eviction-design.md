---
status: draft
date: 2026-07-28
---

# Reclaiming resident Coqui VRAM under starvation (#1894)

## Problem

`server/src/tts/synthesise-chapter.ts`'s fs-60 mixed-engine logic evicts **Qwen
for Coqui** (`evictQwenForCoquiPhase`) and never the reverse. There is no
`evictCoqui*` symbol anywhere in the tree. Of the three `/unload` fetch sites in
`server/src` — `tts/ensure-sidecar-loaded.ts:206`, `tts/synthesise-chapter.ts:886`,
and `routes/sidecar-health.ts:399` — the two on the render path both target
`qwen`, and the third is the user's Stop button. The sidecar's own idle-evict
framework (`server/tts-sidecar/main.py:2544`) covers Qwen VoiceDesign, Qwen
1.7B-Base, ASR and ECAPA, but **not Coqui**. Nothing frees XTTS automatically.

So a chapter with zero Coqui presence, following one that used Coqui, inherits a
resident XTTS (~3 GB) it has no use for — on an 8 GB card, potentially crowding
out the Qwen render that chapter actually needs.

### What already happens today

This is **not** an unguarded crash, and the design's shape follows from that.
`/synthesize` goes through `withCapacityRetry` (`tts/sidecar.ts:169-171`,
`:304-320`). A render starved by a resident Coqui polls with backoff, evicts the
analyzer Ollama once if that would help, and finally raises `NoCapacityError`
naming the blocker: _"Coqui XTTS — Use its Stop button, at the top of the
window."_

`gpu/describe-vram-blockers.ts`'s header states this is deliberate — it lists
only models "the USER controls **and that admission deliberately will not
auto-evict**."

The real defect is therefore narrower than the issue implies: **a render can burn
its whole retry budget and then fail, over VRAM the run provably does not need.**
A stall-then-fail, not a crash.

### Provenance

Audit-found, during Wave 3c's Task 22 eviction-symmetry review. **No observed
incident.** That drove the choice of a reactive design over a proactive one (§3).

### Corrections to the issue text

- The cited plan `docs/features/270-fs38-wave3c-xtts.md` does not exist; 270 is
  the OpenAPI setup surface. The relevant plans are
  `docs/features/249-fs60-xtts-language-eligibility.md` and
  `267-fs38-wave3-voice-clone.md`.
- The issue frames the constraint as "don't over-trigger on the common 'next
  chapter uses Qwen' case." Real, but secondary — §2 covers the binding one.

## 1. The policy question, resolved

`gpu/evict-idle-tts.ts:10-12` states the opposite policy explicitly:

> Deliberately narrow:
>
> - Qwen bases only. Coqui and Kokoro are button-driven — the user loaded them
>   on purpose and silently unloading them would be surprising.

This reads as a blocking contradiction and is not one. That module is a
capacity-admission lever for **interactive** ops and early-returns on
`isAnyGenerationActive()` — inert during any render, by construction.

More decisively: **the sidecar already auto-evicts resident models under
starvation without asking**, via `_idle_evict` (§3). The question was never
"may the server reclaim VRAM the user loaded?" — it already does, for four
engines. The question is only which engines belong in that set.

**Kokoro stays out**, and not from timidity. It is ~1 GB, and `PRELOAD_KOKORO`
reloads it at every sidecar start, so evicting it buys little and can fight a
setting the user turned on. `describe-vram-blockers.ts` already encodes this
asymmetry: Coqui's remedy is "press Stop" (durable), Kokoro's is "change the
setting" (because Stop is not durable).

## 2. Why the obvious triggers don't work

Two facts kill the issue's own suggested trigger ("zero Coqui-cast characters in
this chapter AND Coqui currently resident").

**Chapters render concurrently across books.** One queue worker renders one
chapter; "N chapters run concurrently across all books, **including sibling
chapters of the same book**" (`routes/generation.ts:2227-2238`). At any
chapter-complete hook a sibling chapter may still be mid-Coqui, so "the last
Coqui chapter" is not observable from one chapter's completion.

**Every Node-side eviction is a global sidecar unload decided from one book's
point of view** — what #1393 is open about for the Qwen tier reconcile, and what
plan 249's accepted limitation #2 records for `evictQwenForCoquiPhase`. Coqui
inherits the same race, and harder: a cold XTTS load genuinely takes ~90 s
(`routes/sidecar-health.ts:337`; `LOAD_TIMEOUT_MS` at
`tts/ensure-sidecar-loaded.ts:50` is the matching abort budget).

**Cast-derived demand is also wrong, not merely imprecise.** `applyQwenFallback`
(`tts/synthesise-chapter.ts:1130-1197`) reroutes a **Qwen**-cast character to
**Coqui** at synth time when `forbidKokoroFallback && coquiEligible`
(`:1180-1187`), triggered by `!voiceName || qwenUnavailable` (`:1162`) — fs-60's
non-English fallback, and plan 249 invariant #5. A chapter whose cast resolves
to `{qwen}` can therefore synth on Coqui, so any demand set built from
`resolveCharacterEngine` **under**-reports Coqui in exactly the scenario
(non-English book, undesigned voice) most likely on this codebase. Under-reporting
is the fatal direction: it evicts under a live render.

The conclusion is not "build a better predictor." It is that Node cannot answer
this question safely, and should not try.

## 3. Approach: extend the sidecar's existing idle-evict

The sidecar already solves this problem for four engines. **Both** placement
entry points call `self.idle_evict(worst)` **immediately before returning
`noCapacity`**, then re-probe and retry the fit: `admit` (`main.py:2374-2381`)
and `reservation` (`:2448-2453`). The render path uses **`reservation`** —
`/synthesize` calls `_placement.reservation(engine_id, …)` at `:7380-7382` and
never `admit` — so the evict fires on the very first POST, without needing Node's
retry budget at all.

`_idle_evict` (`:2544-2580`) tries Qwen VoiceDesign, Qwen 1.7B-Base, ASR and
ECAPA via per-engine `maybe_free_idle*(ttl)` methods, all **device-targeted**
(#1721) so they never free an engine on a different card.

**Only the two Qwen methods carry the full race discipline** — lock-free fast
path, re-validated under `_synth_lock`, skipped entirely while a forward is in
flight (`:3752-3789`). `WhisperEngine.maybe_free_idle` (`:4913-4921`) and
`SpeakerEngine.maybe_free_idle` (`:5015-5023`) do not: no lock, no in-flight
counter, and their `unload()`s null unguarded while `transcribe`/`embed`
dereference the model. So the Qwen pair is the model to copy, and ASR/ECAPA are
two more instances of §4.1's bug rather than precedents (§7).

This fires at exactly the moment we want — real starvation, nothing speculative —
and is race-free by a mechanism proven on the Qwen pair. Adding Coqui is one new
method and one branch.

It answers a weaker question — *"has Coqui been idle?"* rather than *"does anyone
still need Coqui?"* — and that is sufficient: at the starvation moment in
#1894's scenario, Coqui has been idle since the last Coqui chapter ended.

### Rejected alternatives

**A Node-side engine-demand registry** (the first draft of this spec; superseded
after review). Register each in-flight job's engine demand, let the
`withCapacityRetry` `evictIdleTts` hook consult it. Rejected on four independent
grounds, any one sufficient:

1. **Grain contradiction.** Per-chapter demand is not computable where the race
   requires registering it. `requiredEngines` (`generation.ts:858`) is whole-cast;
   the per-chapter data is `analysis.chapters[chapter.id]`, read at `:1349`
   inside `processOneChapter` — i.e. *after* `registerJob` (`:1253`). Registering
   at `:858` yields the whole-cast grain that provably does not fix #1894's
   titled case.
2. **Fail-open by construction.** A registry that "imports nothing and owns its
   own `Map`" reads an empty map as *nothing is demanded*. The three existing
   leaf gates exist precisely to make the opposite structurally impossible —
   `active-generation-gate.ts:16-23`: _"FAIL CLOSED IS REQUIRED, NOT A
   PREFERENCE… Do NOT 'simplify' the unregistered default to `false`."_
3. **Cast-derived demand under-reports Coqui** (§2, `applyQwenFallback`).
4. **A Node-side unload has no serialization.** `CoquiEngine` has no synth lock
   at all (§4.1), and a Node-side check-then-unload is a TOCTOU that cannot
   acquire one.

It also had two secondary defects: a Coqui-op starved inside `withCapacityRetry`
holds `defaultEngineSynths.get('coqui')` for its whole poll (`tts/sidecar.ts:169`
acquires before `:171` posts), so an "is a Coqui synth in flight" check would
deadlock the pair; and `evictedTts` caps evictions per `withCapacityRetry` call,
i.e. per POST, not per chapter — a much weaker thrash bound than it appears.

**Proactive run-start reclaim** (extend `generation.ts:1060`'s hygiene block).
~15 lines, symmetric with the Qwen reconcile above it. Rejected: a global unload
from one book's viewpoint can strip Coqui from a concurrent book mid-render
(§2), and it only addresses the run-start half, not the titled case. For an
audit-found issue with no observed incident, that trades a hypothetical stall for
a reachable one.

**Close as by-design.** Defensible — the existing failure is bounded and names
the button that fixes it. Rejected because a render can still stall for the full
retry budget and then fail over reclaimable VRAM.

**Build #1393's registry first.** Disproportionate to an audit finding. Note it
is *not* a prerequisite and this design is not a down payment on it: #1393
requires **whole-cast** grain deliberately (`generation.ts:868-884` — the
superset is required so a not-yet-started chapter's tier is not evicted), which
is the opposite of what a per-chapter registry would have provided.

## 4. Design

Substantively this all lands in `server/tts-sidecar/main.py`. The one Node-side
edit is a **deletion** (§4.4); the Node eviction lever itself is untouched
(§4.5).

### 4.1 Prerequisite: `CoquiEngine` has no synth lock (a live bug)

`CoquiEngine` holds only an `asyncio` `_load_lock` (`main.py:1158`). `unload()`
(`:1327-1362`) sets `self._tts = None` with no lock, while `synthesize()`
(`:1364`) dereferences `self._tts.tts(...)` (`~:1403`) and `self._tts.synthesizer`
(`~:1414`) after its `assert`. `QwenEngine.unload` guards exactly this (`:3694`,
`with self._synth_lock:`); Coqui does not.

`unload()`'s own docstring says it is _"Used by POST /unload when the UI's Stop
button fires (or when the Analysing screen's Load button auto-evicts the TTS
model to make room for the analyzer LLM)."_ Both endpoints offload to the worker
pool — `/unload` does `await asyncio.to_thread(coqui.unload)` (`:6854`),
`/synthesize` does `await asyncio.to_thread(engine.synthesize, …)` (`:7392`) — so
they genuinely overlap and nothing serializes them. **Pressing Stop on Coqui
during a render can already crash that synth today** with `AttributeError:
'NoneType' object has no attribute 'tts'`, with no auto-evict involved.

Folded into this scope because auto-eviction makes the window far more likely to
be hit, and shipping both together means one on-box acceptance pass. Note this is
**not** a convention Coqui uniquely violates — ASR and ECAPA share the same
unguarded shape (§3), so this fixes the first of three (§7).

**Change:** give `CoquiEngine` a `threading.Lock` `_synth_lock`, mirroring
`QwenEngine`'s, and factor `unload()`'s body into `_unload_locked()`:

```python
def unload(self) -> None:
    with self._synth_lock:
        self._unload_locked()
```

so `maybe_free_idle` can call `_unload_locked()` under the lock it already
holds. That is what keeps §4.2 honest — see C1 there. `unload()` has exactly one
caller (`:6854`), so acquiring the lock inside it carries no self-deadlock risk,
same posture as Qwen's `:3691-3693`.

**`synthesize()` acquires the lock AFTER `self._ensure_loaded(model)` (`:1365`),
not before** — holding it across a cold load would block `/unload` for the full
~90 s. The residual window that leaves (between `_ensure_loaded` and the acquire,
where the bare `assert self._tts is not None` at `:1366` sits) is closed by
re-reading `self._tts` into a local **inside** the lock and asserting there, so
the forward never dereferences the attribute a concurrent unload can null.

**Why the lock costs no throughput** — and this is not obvious, so it belongs in
the spec rather than in someone's head: Node already holds Coqui to one
concurrent synth process-wide. `engineSynthSem` returns `new CountSemaphore(1)`
(`tts/sidecar.ts:56-59`, _"at most ONE synth call per engine in-flight"_) off the
module-level `defaultEngineSynths` singleton (`:54`, `:132`), and Coqui never
uses `/synthesize-batch` (Qwen-only, `:210`). So the lock can never be contended
by the only caller there is. **That safety margin is a Node-side invariant the
sidecar does not enforce and no sidecar test pins** — and
`test_concurrent_synthesis.py`'s Coqui contract would not catch a regression
either, because `_FakeCoquiEngine.synthesize` (`:100-122`) fully overrides the
real method, so its `peak_inflight >= 2` assertion pins the route's
`to_thread` offload, not engine-level parallelism. §5's new tests are the only
coverage.

### 4.2 `CoquiEngine.maybe_free_idle(ttl_seconds)`

Modelled on `QwenEngine.maybe_free_idle_design` (`:3752-3789`):

1. Lock-free fast-outs: nothing resident, or a synth in flight, or used within
   `ttl_seconds` → `False`.
2. Re-validate all three under `_synth_lock`, then call `_unload_locked()`
   (§4.1).
3. Return `True`.

Requires a `_last_used` monotonic stamp refreshed in `synthesize()`, and an
in-flight counter — both mirroring the Qwen fields.

**It must NOT null `self._tts` inline, the way Qwen's method does.** Qwen gets
away with a bare `self._design = None` because `_design` carries no paired
state. Coqui's `unload()` resets five more fields (`:1336-1344`), and one of them
is a shipped bug fix:

```python
self._device = self._requested_device   # #1730 gap 3
```

`_ensure_loaded` overwrites `self._device` with the **admitted** card (`:1302`),
and only the `/load` route passes an admitted override (`:6806`) — `synthesize()`
calls `self._ensure_loaded(model)` with no device (`:1365`), so a lazy cold load
reads whatever `self._device` holds. On a two-card box: `/load` admits Coqui to
`cuda:1` → `_device="cuda:1"` → an inline-null idle-evict → the next
`/synthesize` cold-loads Coqui **pinned to `cuda:1`**, bypassing placement
entirely. That is verbatim the bug the comment at `:1340-1343` exists to prevent.
Stale `_speakers` is a second, milder instance — `synthesize()` validates
`voice not in self._speakers` (`:1377`) against a manifest for a model that is no
longer loaded.

Routing through `_unload_locked()` removes both the drift risk and the
deadlock reason Qwen had for nulling inline, and is less code than duplicating
the teardown. It also inherits `unload()`'s existing `gc.collect()` +
`empty_cache()` reclaim (`:1345-1352`), which the 2026-05-30 host-RAM leak made
mandatory — that is Coqui's own precedent, deliberately, rather than ASR/SPK's
shared `_reclaim_host_and_vram()` (`:4908`, `:5011`).

### 4.3 The `_idle_evict` branch, and the one real gap

Add a Coqui branch to `_idle_evict` (`:2544`), device-gated by `_same_card` like
its siblings.

**`_idle_evict` does not know which engine is admitting**, and for Coqui that
matters in a way it did not for the existing four. Its signature is
`_idle_evict(device_key)`; the sibling engines are transient or secondary, so
freeing them can never be self-defeating. Coqui is a primary synth engine — a
starved **Coqui** op would evict the very model it is about to reload. Admission
does not give it a free pass for being resident ("being resident is not a free
pass", `:2352-2360`), so this is reachable.

**Change:** thread the admitting op's engine through to `idle_evict` and skip the
Coqui branch when it is `coqui`. `admit` (`:2341`) and `reservation` (`:2423`)
already take `engine: str`, so the change is mechanical but **wider than one
signature**: the injected callable's type (`Optional[Callable[[str], bool]]`,
`:2287`), its default lambda (`:2297`), `_idle_evict`'s own definition (`:2544`),
both call sites (`:2375`, `:2450`), and **8 existing test call sites** —
`tests/test_devices.py:360, 370, 381, 390, 392` (direct `main._idle_evict(…)`
calls) and `tests/test_placement.py:57, 101, 179` (injected `idle_evict=lambda
dk: …` doubles). Those 8 break on arity alone; their semantics survive, because
`_wire_evict_engines` (`test_devices.py:344-352`) patches only qwen/ASR/SPK, so a
new Coqui branch sees the real `CoquiEngine` with `_device="auto"` and
short-circuits on `_same_card`.

**TTL: 30 s, as a proper knob — not a literal.** `0.0` (what the four siblings
are called with) means "evict now regardless of recent use," right for a
transient design model and wrong for a primary engine a mixed chapter may return
to within seconds. But a bare `30` in `_idle_evict` would be the only untunable
TTL in the file. Every idle-evictable model has the same five-part shape —
default const, resolver with a 5 s floor, env var, registry knob, wiki row:

| | default | resolver | env | registry knob |
|---|---|---|---|---|
| Qwen design | `_DESIGN_IDLE_TTL_DEFAULT = 120.0` (`:5045`) | `_design_idle_ttl()` | `QWEN_DESIGN_IDLE_TTL` | `sidecar.qwenDesignIdleTtl` (`registry.ts:676`) |
| Qwen 1.7B | reuses 120.0 | `_base17_idle_ttl()` (`:5065`) | `QWEN_BASE17_IDLE_TTL` | `sidecar.qwenBase17IdleTtl` (`:686`) |
| ASR | `_ASR_IDLE_TTL_DEFAULT = 120.0` (`:5128`) | `_asr_idle_ttl()` (`:5132`) | `ASR_IDLE_TTL` | `sidecar.asrIdleTtl` (`:696`) |
| ECAPA | `_SPK_IDLE_TTL_DEFAULT = 120.0` (`:5181`) | `_spk_idle_ttl()` (`:5185`) | `SPK_IDLE_TTL` | `sidecar.spkIdleTtl` (`:706`) |

`:5179-5180` even pins the invariant: _"Must match the registry
`sidecar.spkIdleTtl` default."_ So Coqui gets `_COQUI_IDLE_TTL_DEFAULT = 30.0`,
`_coqui_idle_ttl()`, `COQUI_IDLE_TTL`, `sidecar.coquiIdleTtl`, and its
`docs/wiki/Advanced-Settings.md` row.

**Why 30 and not the siblings' 120:** all four of those are also driven by a
background watchdog, so their TTL is "how long before we reclaim proactively."
Coqui gets **only** the admission-path evict — nothing reclaims it in the
background — so its TTL is purely "how recently was this in use," and 120 s would
make the lever refuse in most real chapter gaps. §6 is where this gets tuned.

### 4.4 `describe-vram-blockers.ts` must be updated

`gpu/describe-vram-blockers.ts:4-10` selects on "models the USER controls **and
that admission deliberately will not auto-evict**," and excludes a resident Qwen
base *because* `evict-idle-tts.ts` already frees it — "naming it here would be
noise on top of an action already taken."

Once admission auto-evicts Coqui, its `{ model: 'Coqui XTTS', remedy: 'Use its
Stop button' }` entry (`:36`) becomes exactly that noise: the user is told to
press a button the server just pressed. Drop the Coqui entry and update the
header's rationale. This is the one Node-side edit, and it is a deletion.

**The "noise" argument is conditional, and the spec should not overstate it.**
The entry is redundant only when the evict *succeeded*. `describeBlockers()` runs
at give-up (`capacity-retry.ts:166-171`), and `maybe_free_idle` legitimately
refuses when Coqui is mid-forward for a sibling chapter — in that case dropping
the entry costs the user the one actionable line. Accepted anyway, because
pressing Stop at that moment would kill a live render: the honest remedy there is
"wait," not "press Stop," and an entry that advises a destructive action is worse
than no entry.

The no-blockers path is already safe: `NoCapacityError` (`tts/tts-errors.ts:21-34`)
defaults `blockers = []` and falls back to `` `${base} — free VRAM or attach a
second GPU.` ``, and `defaultDescribeBlockers` already returns `[]` on an
unregistered gate (`capacity-retry.ts:90-92`). Nothing assumes non-empty.

### 4.5 What deliberately does not change

`gpu/evict-idle-tts.ts` is **untouched** — no Coqui step, no rename, no relocated
`isAnyGenerationActive()` guard. Its existing test asserting the lever "never
grows into touching Coqui/Kokoro residency itself"
(`gpu/evict-idle-tts.test.ts:104`, the `#1839 finding 5` case) therefore stays
green and keeps its
meaning: Coqui residency is the **sidecar's** business, not this lever's. No new
registry, no leaf gate, no TTL plumbing on the Node side, and
`npx madge --circular --extensions ts server/src` stays at its 15-cycle baseline
untouched.

## 5. Testing

Sidecar-side, `server/tts-sidecar/tests/` (pytest, `npm run test:sidecar`):

- **`maybe_free_idle` contract**, mirroring the Qwen coverage at
  `test_qwen3.py:374-388, 492-505, 540-572`: no-op when nothing resident; no-op
  within TTL; frees past TTL; returns `True` only when it freed.
- **The race the lock exists for** — a `maybe_free_idle` (and a bare `unload()`)
  attempted while a synth forward is in flight must not null `_tts`. Regression
  test for §4.1's bug; must fail before that fix.
- **The state teardown C1 turns on** — after `maybe_free_idle`, `_device` is back
  to `_requested_device` and `_speakers` is cleared. This is what stops the
  #1730 gap-3 regression, and an inline-null implementation fails it.
- **`_idle_evict` wiring**: fires the Coqui branch on a matching card, skips a
  non-matching card, and **skips when the admitting engine is Coqui** (§4.3).
- **Admission end to end**: a starved non-Coqui op with an idle resident Coqui is
  admitted after the evict. This belongs in `test_placement.py`, alongside its
  existing `noCapacity` assertions (`:71, 88, 149, 159, 204`) and the
  evict-then-retry precedent `test_idle_evict_then_place` (`:91-104`) — **not**
  `test_devices.py`, whose `:258-273` is the route-level 503.
- **Arity fixes** for the 8 existing `_idle_evict` call sites listed in §4.3.
  Mechanical, but they are part of the work, not incidental.

Node-side: update `gpu/describe-vram-blockers.test.ts` (`:6`, `:8`, `:25` assert
on the dropped entry today).

## 6. Owed on-box acceptance

Two things unit tests cannot reach, both needing a real 8 GB card:

1. Whether reclaiming ~3 GB actually admits the blocked op, or the freed VRAM is
   immediately taken by something else.
2. Whether the 30 s TTL (§4.3) is tuned right. **An evict→reload cycle repeating
   across chapters of one book means it is too short**; a render that still fails
   `NoCapacityError` with an idle Coqui resident means it is too long. Record
   which, with the observed interval.

**Must be run pinned to a single card** (`CUDA_VISIBLE_DEVICES=0`). The dev box
is dual-GPU (`cuda:0` 4070 8 GB, `cuda:1` 5070Ti 16 GB), and `_worst_device_key`
(`:2321-2339`) picks the card with the **most** headroom — so with Coqui on a
full `cuda:0` and a roomy `cuda:1`, `idle_evict("cuda:1")` is what gets called
and `_same_card("cuda:0", "cuda:1")` declines. Unpinned, this acceptance can pass
or fail for entirely the wrong reason.

Group with row A19 (the #1893 evict acceptance) — same card, same book setup.

## 7. Out of scope

- **The same unguarded-unload race in ASR and ECAPA.** `WhisperEngine` and
  `SpeakerEngine` have §4.1's bug too (§3), and unlike Coqui they are *already*
  auto-evicted through `_idle_evict(0.0)` — so the race is live for them today.
  Discovered while verifying this design; needs its own issue. Not folded in
  here: it is a different engine pair with different in-flight accounting, and
  bundling it would make this change unreviewable.
- **#1393's cross-book tier union** — not a prerequisite, and not served by this
  design (§3).
- **Kokoro eviction** (§1).
- **Recalibrating `ENGINE_VRAM_COST`** — plan 249's accepted limitation #1.
- **Making `evictQwenForCoquiPhase` per-book** — plan 249's accepted
  limitation #2.
