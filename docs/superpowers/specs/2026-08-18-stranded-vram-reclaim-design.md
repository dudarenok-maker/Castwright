# What is actually stranded — measurement design for #1996

Status: **draft** ·
Issue: [#1996](https://github.com/dudarenok-maker/Castwright/issues/1996)
(`needs-plan`) ·
Parent: [#1976](https://github.com/dudarenok-maker/Castwright/issues/1976),
whose criterion 1 is #1996's whole content ·
Prior attempts: [PR #2029](https://github.com/dudarenok-maker/Castwright/pull/2029)
(the `/unload` hook — rejected in review) and **this document's own first
revision** (`cff012ec`, the idle-watchdog reclaim — withdrawn before approval;
see §1) ·
Follows: [PR #1993](https://github.com/dudarenok-maker/Castwright/pull/1993),
the shipped admission-failure-path reclaim.

---

## Summary

Two designs for #1996 have now failed for the same underlying reason: **nobody
has measured what the stranded pool is made of.** Both assumed it was
reclaimable cache that simply never got an `empty_cache()` call, and built a
lever to schedule one. The repo's own code contradicts that assumption in three
independent places (§1).

This revision therefore does not design a lever. It designs the **measurement
that decides which lever is even applicable**, specifies the small read-only
diagnostic that measurement needs, and records the constraints any future lever
must satisfy — so the next attempt starts from evidence rather than re-deriving
the same traps a third time.

**One reading settles it.** If the pool is uncollected cache, a scheduled
reclaim is the fix. If it is allocator fragmentation, `empty_cache()` can never
return it and the fix is a boundary recycle — machinery that already ships.
These have nothing in common, so building either before the reading is a coin
flip.

---

## 1. Why the lever premise was withdrawn

#1976 states the pool is "**fully reclaimable** — a load/unload cycle on that
same stranded state recovered it — it simply never gets reclaimed", and
concludes "It is not fragmentation that `empty_cache()` cannot compact." Both of
this issue's design attempts inherited that sentence. It does not survive
contact with the code.

| # | Evidence | Where |
|---|---|---|
| 1 | An unconditional, process-wide `gc.collect()` + `empty_cache()` **already runs every 60 s** whenever RSS ≥ 8192 MB — no residency precondition, no device key. That is exactly the action a new watchdog would schedule. | `main.py:7915` (`_MEM_WATCHDOG_INTERVAL`, commented "how often to LOG the memory line + **run the reclaim**"), `:8613-8614`, threshold `:7953-7960` |
| 2 | The repo already records that this class of pool may be unreclaimable in-process on the primary platform: *"On Windows torch has no `expandable_segments` …, so a fragmented reserved pool … `empty_cache()` can't compact it back, so only a fresh process resets it."* | `main.py:7986-7990` |
| 3 | The strand was measured **after** an unload whose own `_reclaim_after_drop` had already run `gc.collect()` + `empty_cache()`. | #1976's table (`qwen_loaded: false`); `main.py:1936-1943` |

**The load/unload inference is unsound.** #1976 concludes "not fragmentation"
because a load/unload cycle recovered the memory. But a **load** is an
allocation pass that refills and coalesces segments — recovery via load/unload is
the signature of fragmentation *as much as* of an uncalled reclaim, and
distinguishes nothing. The one thing it does rule out is "permanently leaked",
which was never the competing hypothesis.

**A second, independent failure of the withdrawn lever.** Every engine idle TTL
is exactly `120.0` s — VoiceDesign (`main.py:7678`), Qwen 1.7B-Base (`:7704`),
ASR (`:7762`), SPK (`:7815`) — and each drops its model and reclaims
process-wide when it fires. A quiet-window trigger set at that same grain is
redundant by construction: the moment it could fire, four existing watchdogs
already have. And the reported state — ASR and SPK resident *and being
exercised* — is the one state such a trigger can never fire in, because activity
keeps its clock moving.

The residual set is therefore much smaller than either attempt assumed: the
engines with **no** background TTL at all — **Coqui** (`main.py:2066-2068`
records the omission as deliberate), **Kokoro**, and **Qwen Base 0.6B**. Whether
any of those was resident during the measured strand is unknown, and is one of
the things §3 measures.

---

## 2. The two candidate mechanisms

| | **A — uncollected cache** | **B — fragmentation** |
|---|---|---|
| What is holding the memory | Cached blocks nothing references, awaiting an `empty_cache()` that never comes | Cached blocks split around live tensors; `empty_cache()` returns only whole free segments |
| `inactive_split_bytes` | Small relative to `reserved − allocated` | Dominates `reserved − allocated` |
| A manual `empty_cache()` on the stranded state | `reserved` drops sharply | `reserved` barely moves |
| The fix | Schedule a reclaim on a trigger the existing TTLs don't already cover | A **process recycle at a chapter boundary** — already built (`recycle_pending`, `_VRAM_SOFT_FRACTION`/`_VRAM_HARD_FRACTION` at `main.py:8150-8151`); the open question becomes whether its 90%-of-card threshold is the right trigger, since ~48% of the card stranded never approaches it |
| Effort | New watchdog + clock + predicate + tests | Threshold/trigger change to shipped machinery |

Mechanism B is not a worse outcome — it is a **cheaper** one, and it reuses code
that exists. What would be expensive is building A's watchdog and discovering
afterwards that it frees nothing, which is the failure mode both prior attempts
were on course for.

---

## 3. What must be measured

Four readings, on the box, with a real render. Each exists to discriminate, not
to characterise.

1. **The split.** Per device: `reserved_bytes.all.current`,
   `allocated_bytes.all.current`, `inactive_split_bytes.all.current` from
   `torch.cuda.memory_stats(i)`, at four points — fresh sidecar, mid-render,
   immediately post-render, and 180 s post-render (past every 120 s TTL).
   *Discriminates A from B, and shows whether the strand self-heals at the TTL.*
2. **The before/after pair.** On the stranded state, a **bare** `empty_cache()`
   with no load, and the same three figures immediately after.
   *This is the decisive reading.* It must be a bare reclaim: a load/unload cycle
   conflates the reclaim with an allocation pass and is what produced the unsound
   inference in the first place.
3. **Residency at the moment of the strand.** Which engines report loaded, from
   `/debug/memory`'s `engines` block — specifically whether any of Coqui,
   Kokoro or Qwen Base 0.6B (the three with no TTL) is among them.
   *Decides whether §1's residual set is the real one, and settles #1996's own
   "which engine owns the pool" question as a by-product.*
4. **RSS at the moment of the strand**, against the 8192 MB warn threshold.
   *Decides whether evidence row 1 actually applies to the observed session — if
   RSS sat below 8192 MB the 60 s reclaim was never firing, which weakens that
   row without rescuing the premise.*

---

## 4. The diagnostic surface this needs

**The existing surfaces cannot produce readings 1 or 2.** `/debug/memory`
(`main.py:9477`) reports `allocated_mb` and `reserved_mb` for the **current
device only** (`:9523-9532`) and carries no `inactive_split_bytes`;
`_cuda_vram_mb_per_device` (`:8015`) is per-device but reports only
`reserved_mb`/`total_mb`. Nothing anywhere exposes a bare, on-demand reclaim.

Two additions, both small, read-only in effect, and useful under either
mechanism:

- **Extend `/debug/memory`** with a per-device `memory_stats` block carrying
  `reserved`, `allocated`, `inactive_split` and `num_alloc_retries`. Purely
  additive; no existing field changes meaning.
- **Add `POST /debug/reclaim`** — one bare `_reclaim_device_cache()` call
  returning the per-device figures before and after, in one response. This is
  reading 2 in a single request, which matters because the two snapshots must
  bracket the reclaim with nothing else in between.

Both sit alongside the existing `/debug/codec-timing` pair (`main.py:9562`,
`:9567`), so the route family and its conventions already exist.

**Scope note.** `POST /debug/reclaim` performs a real reclaim, so it is not
inert. It is guarded by being a `/debug` route on a loopback-bound sidecar, and
it does exactly what the memory watchdog already does unprompted every 60 s.

---

## 5. The run sheet

The executable procedure lives at
[`docs/testing/1996-stranded-vram-measurement.md`](../../testing/1996-stranded-vram-measurement.md)
— exact requests, the four capture points, and a results table to fill in. It is
a **diagnostic** run, not an acceptance run: nothing is being accepted, so it
does not take a row in the on-box acceptance register.

---

## 6. The decision tree

| Reading 2 result | Mechanism | Next |
|---|---|---|
| `reserved` drops sharply on a bare `empty_cache()` | **A** | Design the trigger — but only for the residency set §1 identifies, at an interval that does **not** collide with the 120 s TTL band, and subject to every constraint in §7 |
| `reserved` barely moves; `inactive_split` dominates | **B** | Re-open the recycle threshold instead. No new watchdog; #1996's criterion 1 is answered by a boundary recycle, and the issue text needs correcting |
| The strand is gone at the 180 s capture | **Neither** | The pool self-heals at the existing TTLs. #1996's criterion 1 is already satisfied on `main`; what remains is #1993's admission-path reclaim covering the window before that, and the issue closes on evidence |

The third row is a live possibility and must not be treated as a null result —
it is the cheapest outcome and the one the current evidence most nearly
supports.

---

## 7. Constraints on any future lever

Findings from the adversarial pass over the withdrawn design. They are recorded
here because each cost real review effort to find, and each would otherwise be
re-derived — or shipped as a defect — by the next attempt.

1. **A per-device in-use check does not guard a process-wide action.**
   `_reclaim_stranded_cache` checks `engines_holding(device_key)` for one key
   (`main.py:4052`) while `empty_cache()` frees every device
   (`:3788-3804`). On a dual-GPU box — #1976's own topology — a quiet, stranded
   `cuda:0` passes the check while a render runs on `cuda:1`, and the reclaim
   fires a full-heap `gc.collect()` plus a device-synchronising `cudaFree` into
   it. Any unprompted trigger needs an **all-device** quiet check.
2. **The reclaim cooldown is shared mutable state.** `_last_reclaim`
   (`main.py:4055-4058`) is written by `_reclaim_stranded_cache` and read by the
   admission path. A new caller can put #1993's reclaim on cooldown and
   reintroduce the exact refusal #1993 exists to prevent. Separate the state or
   ship a regression test for it.
3. **`SEG_CAPACITY_ADMISSION=0` disables the ledger.** All eleven reservation
   sites are wrapped in `if _capacity_admission_enabled():` (`main.py:4473-4474`,
   the documented rollback path). With it off, nothing holds or releases, so any
   ledger-derived quiet signal reads "permanently quiet" and a trigger built on
   it fires into live work. Such a trigger must disable itself when the flag is
   off.
4. **A latch keyed on per-device activity wedges on the stranded card.** A
   stranded device reports less headroom, so `best_fit`/`try_hold`
   (`main.py:3713-3753`) route subsequent work *away* from it — its activity
   stamp never moves, and a latch waiting on that stamp never clears. The card
   that needs reclaiming is the one permanently excluded.
5. **Device keys are not uniformly `cuda:N`.** `probe_capacity` uses
   `kind = "rocm" if _cuda_is_rocm() else "cuda"` (`main.py:3491`) and also emits
   `cpu` and `mps:0` keys (`:3506-3510`), while `_cuda_vram_mb_per_device`
   hardcodes `f"cuda:{i}"` (`:8038`). Iterating the latter to key into the
   ledger silently bypasses the in-use guard on AMD. Note that *fixing* the
   prefix changes the keys of the shipped `/health` field
   `vram_reserved_mb_by_device`, which Node types and forwards
   (`server/src/routes/sidecar-health.ts:186`, `:491-492`) — that is a wire
   contract, not an implementation detail.
6. **Adding a background loop breaks a pinned test.**
   `tests/test_lifespan_order.py:44-54` hard-codes the nine startup handlers and
   asserts against the real lifespan. A fourth watchdog must update it, and must
   decide where in the ordering it belongs.
7. **The test bar is an ordering assertion, not a call assertion.** Attempt 1's
   five tests all stayed green when the reviewer moved the reclaim to *before*
   the model was freed. A mutation that relocates the call must turn a test red —
   including one that calls a lower level (`_reclaim_device_cache` or `reclaim`
   directly) and thereby skips the guards.
8. **`_reclaim_after_drop` is not one function.** There are separate
   implementations at `main.py:1917` (Coqui), `:7371` (ASR) and `:7599` (SPK),
   plus `_reclaim_host_and_vram` (`:1086`) and `_reclaim_device_cache` (`:3767`).
   A brief that names it in the singular sends an implementer looking for one
   thing that is five.

---

## 8. Not in scope

The admission-failure path (#1993, shipped), ASR footprint sizing (#2094,
closed), and any lever for criterion 1 — which is the point of this revision:
the lever is chosen by §6, after the reading, not before it.

---

## 9. Risks

- **The measurement may not reproduce.** The strand was observed once, during a
  session that also hit the committed-memory ceiling twice. If three renders
  produce no strand, that is itself the answer (decision-tree row 3) and must be
  recorded as such rather than retried until it appears.
- **`POST /debug/reclaim` mutates.** It performs a real reclaim, so a run sheet
  that calls it mid-render measures the wrong thing. The run sheet orders the
  captures so it is only ever called on a quiet box.
- **Correcting #1976's text is part of the work.** Its "fully reclaimable / not
  fragmentation" sentences are what sent two attempts down the same path; if the
  reading contradicts them, leaving them in place will send a third.
