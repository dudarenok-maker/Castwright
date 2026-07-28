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

The sidecar already solves this problem for four engines.
`PlacementController.admit` (`main.py:2365-2385`) calls `self.idle_evict(worst)`
**immediately before returning `noCapacity`**, then re-probes and retries the
fit. `_idle_evict` (`:2544-2580`) tries Qwen VoiceDesign, Qwen 1.7B-Base, ASR and
ECAPA via per-engine `maybe_free_idle*(ttl)` methods that are:

- **device-targeted** (#1721) — never frees an engine on a different card;
- **lock-free on the fast path**, then **re-validated under `_synth_lock`** and
  **skipped entirely while a forward is in flight** (`:3757-3775`).

This fires at exactly the moment §3 wants — real starvation, nothing speculative
— and is race-free by a mechanism already proven on four engines. Adding Coqui is
one new method and one branch.

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
model to make room for the analyzer LLM)."_ So **pressing Stop on Coqui during a
render can already crash that synth today** with `AttributeError: 'NoneType'
object has no attribute 'tts'` — user-reachable, with no auto-evict involved.

Folded into this scope (rather than filed separately) because it is a hard
prerequisite — auto-eviction makes the window far more likely to be hit — and
shipping both together means one on-box acceptance pass, not two.

**Change:** give `CoquiEngine` a `threading.Lock` `_synth_lock`, mirroring
`QwenEngine`'s. `synthesize()` holds it across the forward; `unload()` acquires
it before nulling. The same non-reentrancy rule applies as Qwen's: `unload()`
must not be called while already holding it (`:3691`), and `maybe_free_idle`
nulls inline rather than calling `unload()` (`:3763`).

### 4.2 `CoquiEngine.maybe_free_idle(ttl_seconds)`

Modelled directly on `QwenEngine.maybe_free_idle_design` (`:3752-3789`):

1. Lock-free fast-outs: nothing resident, or a synth in flight, or used within
   `ttl_seconds` → `False`.
2. Re-validate all three under `_synth_lock`; null `self._tts` inline.
3. Release the lock, then `gc.collect()` + `torch.cuda.empty_cache()` — matching
   `unload()`'s existing reclaim, which the 2026-05-30 host-RAM leak made
   mandatory (`:1345-1352`).
4. Return `True`.

Requires a `_last_used` monotonic stamp refreshed in `synthesize()`, and an
in-flight counter — both mirroring the Qwen fields.

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
both already take `engine: str`, so this is confined to widening the injected
callable's type (`Optional[Callable[[str], bool]]`, `:2287`) and its two call
sites (`:2375`, `:2450`) — the only signature change in the design.

**TTL: 30 s for Coqui, not the `0.0` its siblings use.** `0.0` means "evict now
regardless of recent use," which is right for a transient design model and wrong
for a primary engine that a mixed chapter may return to within seconds. 30 s is
long enough to ride out an inter-group gap and far shorter than the ~90 s reload
it protects. §6 records how to tell if it is mistuned.

### 4.4 `describe-vram-blockers.ts` must be updated

`gpu/describe-vram-blockers.ts:4-10` selects on "models the USER controls **and
that admission deliberately will not auto-evict**," and excludes a resident Qwen
base *because* `evict-idle-tts.ts` already frees it — "naming it here would be
noise on top of an action already taken."

Once admission auto-evicts Coqui, its `{ model: 'Coqui XTTS', remedy: 'Use its
Stop button' }` entry (`:36`) becomes exactly that noise: the user is told to
press a button the server just pressed. Drop the Coqui entry and update the
header's rationale. This is the one Node-side edit, and it is a deletion.

Note the consequence: a `NoCapacityError` that survives Coqui eviction will now
name fewer blockers. That is correct — the surviving blocker is genuinely not
Coqui — but the message must not become empty and unhelpful; verify the
no-blockers path still reads sensibly.

### 4.5 What deliberately does not change

`gpu/evict-idle-tts.ts` is **untouched** — no Coqui step, no rename, no relocated
`isAnyGenerationActive()` guard. Its existing test asserting the lever "never
grows into touching Coqui/Kokoro residency itself"
(`gpu/evict-idle-tts.test.ts:105-125`) therefore stays green and keeps its
meaning: Coqui residency is the **sidecar's** business, not this lever's. No new
registry, no leaf gate, no TTL plumbing on the Node side, and
`npx madge --circular --extensions ts server/src` stays at its 15-cycle baseline
untouched.

## 5. Testing

Sidecar-side, `server/tts-sidecar/tests/` (pytest, `npm run test:sidecar`):

- **`maybe_free_idle` contract**, mirroring the Qwen coverage: no-op when nothing
  resident; no-op within TTL; frees past TTL; returns `True` only when it freed.
- **The race the lock exists for** — a `maybe_free_idle` (and a bare `unload()`)
  attempted while a synth forward is in flight must not null `_tts`. This is the
  regression test for §4.1's bug and must fail before that fix.
- **`_idle_evict` wiring**: fires the Coqui branch on a matching card, skips a
  non-matching card, and **skips when the admitting engine is Coqui** (§4.3).
- **Admission end to end**: a starved non-Coqui op with an idle resident Coqui is
  admitted after the evict — #1894's scenario at the `PlacementController` seam,
  which is where `test_devices.py` already exercises `noCapacity`.

Node-side: update `gpu/describe-vram-blockers.test.ts` for the dropped entry
(`:6`, `:25` assert on it today) and confirm the `NoCapacityError` message path
still reads well with fewer blockers.

## 6. Owed on-box acceptance

Two things unit tests cannot reach, both needing a real 8 GB card:

1. Whether reclaiming ~3 GB actually admits the blocked op, or the freed VRAM is
   immediately taken by something else.
2. Whether the 30 s TTL (§4.3) is tuned right. **An evict→reload cycle repeating
   across chapters of one book means it is too short**; a render that still fails
   `NoCapacityError` with an idle Coqui resident means it is too long. Record
   which, with the observed interval.

Group with row A19 (the #1893 evict acceptance) — same card, same book setup.

## 7. Out of scope

- **#1393's cross-book tier union** — not a prerequisite, and not served by this
  design (§3).
- **Kokoro eviction** (§1).
- **Recalibrating `ENGINE_VRAM_COST`** — plan 249's accepted limitation #1.
- **Making `evictQwenForCoquiPhase` per-book** — plan 249's accepted
  limitation #2.
