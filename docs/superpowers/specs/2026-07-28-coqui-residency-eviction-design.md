---
status: draft
date: 2026-07-28
---

# Reclaiming resident Coqui VRAM under starvation (#1894)

## Problem

`server/src/tts/synthesise-chapter.ts`'s fs-60 mixed-engine logic evicts **Qwen
for Coqui** (`evictQwenForCoquiPhase`) and never the reverse. There is no
`evictCoqui*` symbol anywhere in the tree, and nothing off the render path frees
XTTS either — a full sweep of `/unload` callers in `server/src` turns up only
`routes/sidecar-health.ts` (the user-triggered `POST /api/sidecar/unload`) and
the Ollama-side evictions, which are a different engine entirely.

So a chapter with zero Coqui presence, following one that used Coqui, inherits a
resident XTTS (~3 GB) it has no use for — on an 8 GB card, potentially crowding
out the Qwen render that chapter actually needs.

### What already happens today

This is **not** an unguarded crash, and the design changes shape because of it.
`/synthesize` goes through `withCapacityRetry` (`tts/sidecar.ts:310`). A render
starved by a resident Coqui polls with backoff, evicts the analyzer Ollama once
if that would help, and finally raises `NoCapacityError` naming the blocker:
_"Coqui XTTS — Use its Stop button, at the top of the window."_

`gpu/describe-vram-blockers.ts`'s header states that this is deliberate — it
lists only models "the USER controls **and that admission deliberately will not
auto-evict**."

The real defect is therefore narrower than the issue implies: **a render can
burn its whole retry budget and then fail, over VRAM the run provably does not
need.** A stall-then-fail, not a crash.

### Provenance

Audit-found, during Wave 3c's Task 22 eviction-symmetry review. **No observed
incident** — no OOM, recycle, or cold reload has been traced to a lingering
Coqui. That fact drove the choice of a reactive design over a proactive one
(§3).

### Corrections to the issue text

- The cited plan `docs/features/270-fs38-wave3c-xtts.md` does not exist; 270 is
  the OpenAPI setup surface. The relevant plans are
  `docs/features/249-fs60-xtts-language-eligibility.md` and
  `267-fs38-wave3-voice-clone.md`.
- The issue frames the constraint as "don't over-trigger on the common
  'next chapter uses Qwen' case." That constraint is real but secondary; §2
  covers what turned out to be the binding one.

## 1. The policy question, resolved

`gpu/evict-idle-tts.ts:10-12` states the opposite policy explicitly:

> Deliberately narrow:
>
> - Qwen bases only. Coqui and Kokoro are button-driven — the user loaded them
>   on purpose and silently unloading them would be surprising.

This reads as a blocking contradiction and is not one. That module is a
capacity-admission lever for **interactive** ops and early-returns on
`isAnyGenerationActive()` — it is inert during any render, by construction. A
render-path reclaim does not contradict its code.

What survives is the softer form: someone can press Load Coqui in another tab to
audition voices, and a render would silently unload it. Real, but not a carve-out
from a documented decision.

Against that sits an established precedent in the same direction:
`reconcileResidentQwenTiers` already evicts Qwen tiers the run's cast doesn't
need, at run start (`routes/generation.ts:1060`) and after each chapter's score
pass (`:192`). "The render path reclaims VRAM it doesn't need" is settled here.
This design extends it; it does not establish it.

**Kokoro stays excluded**, and not from timidity. It is ~1 GB, and
`PRELOAD_KOKORO` reloads it at every sidecar start, so evicting it buys little
and can fight a setting the user turned on. `describe-vram-blockers.ts` already
encodes exactly this asymmetry: Coqui's remedy is "press Stop" (durable),
Kokoro's is "change the setting" (because Stop is not durable). This design
follows that existing line rather than drawing a new one.

## 2. The binding constraint: nothing can answer "does anyone still need Coqui?"

Two facts make the issue's own suggested trigger unimplementable as written.

**Chapters render concurrently across books.** One queue worker renders one
chapter; the queue's N workers are the concurrency authority — "N chapters run
concurrently across all books, **including sibling chapters of the same book**"
(`routes/generation.ts:2227-2238`). At any chapter-complete hook, a sibling
chapter of the same book may still be mid-Coqui. "The last Coqui chapter" is not
observable from a single chapter's completion.

**Every existing eviction is a global sidecar unload decided from one book's
point of view.** That is exactly what #1393 is open about for the Qwen tier
reconcile, and what plan 249's accepted limitation #2 already records for
`evictQwenForCoquiPhase`. Coqui inherits the same race and it lands harder: a
cold XTTS reload is ~90 s (`tts/ensure-sidecar-loaded.ts`'s `LOAD_TIMEOUT_MS`
comment) where a Qwen tier reloads fast.

So closing #1894 requires a source of truth for in-flight engine demand. That is
the work, not the `/unload` call.

## 3. Approach: reactive, not proactive

`withCapacityRetry` already carries a hook documented as _"free a resident TTS
model this op doesn't need"_ (`gpu/capacity-retry.ts:73-76`), called at most once
per blocked call (`:160-163`), currently wired only to `evictIdleQwenBase`. This
design adds a second tenant to that hook.

**Reclaim fires only when an op is genuinely starved.** The issue's
over-triggering worry dissolves by construction: there is no prediction to get
wrong, because the design reacts to real starvation instead of guessing when
Coqui stops being needed.

### Rejected alternatives

**Proactive run-start reclaim** (extend the hygiene block at
`generation.ts:1060`: run's `requiredEngines` lacks Coqui + Coqui resident → one
best-effort `/unload`). ~15 lines, perfectly symmetric with the Qwen reconcile
three lines above. Rejected because it is a global unload decided from one
book's viewpoint — it can unload Coqui out from under a concurrently-rendering
book that is using it, costing that book a ~90 s cold reload. **For an
audit-found issue with no observed pain, that trades a hypothetical stall for a
reachable one.** It also only addresses the run-start half, not the case the
issue is titled after.

**Close as by-design.** Defensible: the existing failure is bounded and names the
button that fixes it. Rejected because a render can still stall for the full
retry budget and then fail over reclaimable VRAM — an outcome the server can
prevent with information it already has.

**Build #1393's registry first.** Correct and complete, and it would close the
open cross-book Qwen race too. Rejected as disproportionate to an audit finding;
§4's registry is a deliberate down payment on it instead.

## 4. Design

### 4.1 The reclaim step

`evictIdleTts` becomes two sequential reclaims tried in cost order: Qwen bases
first (unchanged — same `isAnyGenerationActive()` guard, same elevate-only rule),
then Coqui if that freed nothing. Returning `true` from either short-circuits
into an immediate retry, which is the existing contract.

**The `isAnyGenerationActive()` early return must be relocated, not kept.** It
sits at function scope today (`gpu/evict-idle-tts.ts:111`) and returns before
anything else runs; left there it would make the Coqui step inert during renders
— the exact failure §4.2 exists to prevent. It moves down to guard the Qwen step
only. `if (!modelKey) return false` (`:110`) stays at function scope.

The Coqui step fires only when all four hold:

1. **The blocked op is not itself Coqui** — `engineForModelKey(modelKey) !==
   'coqui'`, reusing the existing helper.
2. **Coqui is resident** — read through `gpu/sidecar-health-gate.ts`, the leaf
   gate `defaultDescribeBlockers` already uses for exactly this. No new import
   path, no new cycle risk.
3. **No Coqui synth is in flight.**
4. **No in-flight chapter needs Coqui** — the registry, §4.3.

Criterion 3 shifted meaning under per-chapter demand (§4.3): for **render**
traffic it is now subsumed, since a chapter mid-Coqui-synth has Coqui in its
registered demand and criterion 4 already blocks the evict. It earns its place
for **interactive** Coqui work — an audition or preview — which registers no
chapter demand and would otherwise be invisible.

The exported symbol is renamed `evictIdleQwenBase` → `evictIdleTtsModels`. Two
call sites (`tts/sidecar.ts:319`, `tts/design-voice-core.ts:169`) plus tests; the
old name becomes false the moment it can evict Coqui.

### 4.2 The guard that must NOT be inherited

`evictIdleQwenBase` early-returns on `isAnyGenerationActive()`, making it inert
during any render. **The Coqui step deliberately does not inherit that guard.**

#1894's scenario _is_ a render — the starved op is the next chapter's synth. A
Coqui step inert during generation would help only interactive previews and
would not touch the issue at all.

The blunt guard is replaced by the precise one: "no in-flight chapter needs
Coqui" plus "no Coqui synth in flight." That is strictly more informed than
`isAnyGenerationActive()`, which is why the registry is a requirement rather
than a convenience — and why the startup race (§4.4) matters more here than it
does for the Qwen lever, since we are removing the guard that made that race
benign.

### 4.3 The registry, and why per-chapter grain

One new module, `server/src/gpu/engine-demand-registry.ts`. It **imports
nothing** and owns its own `Map`, keyed by an opaque token, holding a set of
engine names plus an optional expiry. "Imports nothing" is what makes it
cycle-proof — the same property the three existing leaf gates rely on — so it
needs no provider indirection and no fourth gate file. Engine names are plain
`string`s deliberately: a `type`-only import still counts as a cycle edge (see
`gpu/qwen-tier-reconcile-gate.ts`), and `defaultEngineSynths` already uses
`Map<string, …>` for the same reason.

**Grain: the engine demand of the chapter each in-flight job is rendering — not
the run's whole cast.** This is the decision the design turns on.

A full-cast registry would report "Coqui needed" for a book's entire run if its
cast contains any Coqui character. #1894's titled case is precisely a book whose
cast includes Coqui characters rendering a chapter that has none — so a
full-cast registry returns "still needed," evicts nothing, and fixes only *other*
activities' leftovers. It would be a registry that does not fix the case it was
built for.

Per-chapter demand resolves each job's target chapter through the same
`resolveCharacterEngine` path the synth uses.

**Accepted cost: thrash.** A mixed book can evict Coqui after chapter 4 and
reload it (~90 s) at chapter 7. Accepted because the lever fires **only under
real starvation** — the alternative in that exact moment is not "keep rendering
smoothly," it is "poll the full retry budget and fail with `NoCapacityError`." A
90 s reload beats a failed chapter, and `evictedTts` already caps it at once per
blocked call. §6 records how to detect that this was the wrong call.

**Failure modes point the safe way, and the design leans on it.** A **leaked**
registration means we believe Coqui is demanded, decline to evict, and get
today's behaviour. A **missed** registration is the dangerous one — evicting
under a live render. So the design registers early and lets leaks expire, never
the reverse.

### 4.4 Closing the startup race

`gpu/active-generation-gate.ts`'s header documents a known window: `registerJob`
lands ~190 lines into a render's startup, so a render that has begun but not yet
registered is invisible. Its worst case for the Qwen lever is called benign (a
fast cold reload). For Coqui the same race costs ~90 s, which is not.

`requiredEngines` is computed at `routes/generation.ts:858`, well before
`registerJob`. Register the chapter's demand **there**, with a short TTL; let
`registerJob` promote it to durable; let the existing teardown release it. A
marker leaked by an early return simply expires.

**TTL: 60 s, as a module constant — not a settings knob.** It only has to span
`:858` → `registerJob`, which is bounded by the awaits in between (the disk-guard
probe and the run-start `reconcileResidentQwenTiers` fetch), so 60 s is generous
by an order of magnitude while still clearing a leak quickly. A knob would need a
registry entry, a `config:sync`, and a wiki row for a value no operator has any
basis to tune.

This avoids the `let`-hoisting surgery `active-generation-gate.ts`'s header
explicitly rejected, and it is not invented for this change: #1393's issue body
already specifies TTL-or-lifecycle liveness as what the registry needs
("robust to a crashed/aborted run that never deregisters"). Doing it here first
is the down payment.

### 4.5 Where the in-flight count is written

`tts/sidecar.ts` writes its per-engine in-flight count into the same registry.
Direction matters: `sidecar.ts` already imports from `gpu/`, so this adds no new
edge, whereas `gpu/` reaching into `tts/sidecar.ts` would close the cycle the
leaf-gate rule exists to prevent (`gpu/evict-idle-tts.ts` is itself reached
_from_ `tts/sidecar.ts`).

Verify with `npx madge --circular --extensions ts server/src`, which must stay at
its 15-cycle baseline.

### 4.6 Failure semantics

Inherited verbatim from #1893, shipped in #1898:

- A failed `/unload` returns `false` rather than throwing into the retry loop.
- The return value is **truthful** — `true` only when an unload actually went
  out (#1839 finding 1), or the caller `continue`s into a wasted immediate
  retry.
- The abort signal is forwarded, and an abort **propagates** rather than being
  swallowed, preserving `name === 'AbortError'` so
  `routes/generation.ts:2040`'s pause detector is not fooled.

### 4.7 Data flow

Blocked op receives 503 `{noCapacity}` → `evictIdleTts()` → Qwen step runs
unchanged → Coqui step: op is not Coqui? → health says resident? → registry says
undemanded? → `POST /unload {engine:'coqui'}` → returns `true` →
`withCapacityRetry` retries immediately.

## 5. Testing

Every input is already injectable — `withCapacityRetry` takes `evictIdleTts`,
`capacityProbe`, and `describeBlockers` as options; `SidecarTtsProvider` takes
`engineSynths` — so unit tests carry almost all of this.

- **Registry:** register / expire / promote / release; a leaked TTL entry stops
  suppressing after expiry; concurrent tokens union correctly.
- **The four gates, one test each proving the negative:** a Coqui-engine op does
  not evict itself; a non-resident Coqui is a no-op; a demanded Coqui is not
  evicted; an in-flight interactive Coqui synth is not evicted.
- **The scenario that matters:** a starved Qwen chapter with a resident,
  undemanded Coqui evicts it and retries — #1894 end to end through
  `withCapacityRetry`.
- **Ordering:** Qwen step first; a successful Qwen reclaim short-circuits and
  never reaches the Coqui step.
- **Failure semantics**, mirroring #1893's suite: non-ok `/unload` returns
  `false` rather than throwing; a rejected fetch likewise; an abort propagates
  with `name === 'AbortError'` intact.
- **Rename regression guard** so both existing call sites stay wired.

## 6. Owed on-box acceptance

Unit tests cannot reach two things, both of which need a real 8 GB card:

1. Whether reclaiming ~3 GB actually lets the blocked chapter through, or
   whether the freed VRAM is immediately consumed by something else.
2. Whether a mixed Qwen+Coqui book **thrashes** across chapter boundaries.

An evict→reload cycle repeating across chapters is the signal that per-chapter
grain (§4.3) was the wrong call and that lookahead suppression — skip the evict
when a later queued chapter of the same run is known to need Coqui again — is
needed. Record a row per the register's conventions saying exactly that.

## 7. Out of scope

- **#1393's cross-book tier union.** This design adds a per-*engine* set to
  answer one boolean; #1393 needs a per-*tier* union to make the Qwen reconcile's
  global unload safe. #1393 should widen this record rather than introduce a
  parallel one.
- **Kokoro eviction** (§1).
- **Recalibrating `ENGINE_VRAM_COST`** — plan 249's accepted limitation #1, and
  explicitly out of scope there too.
- **Making `evictQwenForCoquiPhase` per-book** — plan 249's accepted
  limitation #2.
