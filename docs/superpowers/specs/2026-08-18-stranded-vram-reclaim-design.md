# Reclaiming a stranded VRAM pool without an admission failure — design

Status: **draft** ·
Issue: [#1996](https://github.com/dudarenok-maker/Castwright/issues/1996)
(`needs-plan`) ·
Closes on merge: [#1976](https://github.com/dudarenok-maker/Castwright/issues/1976),
whose criterion 1 is #1996's whole content ·
Supersedes attempt 1: [PR #2029](https://github.com/dudarenok-maker/Castwright/pull/2029)
(its `/unload` hook was rejected with a Critical and removed) ·
Follows: [PR #1993](https://github.com/dudarenok-maker/Castwright/pull/1993),
which shipped the admission-failure-path reclaim this design deliberately does
not touch.

---

## Summary

A finished render leaves a reserved-but-unallocated PyTorch caching-allocator
pool on the render card — measured at **3968 MB on an 8 GB card** with the
engine reporting unloaded. The driver counts it as used, so `/capacity` reads
several GB pessimistic and later operations are refused on a figure that is
wrong. The memory is **fully reclaimable**: a load/unload cycle on that same
stranded state recovered it to 389 MB.

PR #1993 already reclaims it *the instant any operation would be refused*. The
residual gap — this design's entire subject — is the case where **nobody asks**:
the pool sits there, the card looks full to every other process on the box, and
nothing in the sidecar ever calls `empty_cache()` again.

The lever is a fourth idle watchdog that fires a reclaim when a card has been
quiet long enough, holds a pool big enough to matter, and has no live
reservation. It is **owner-agnostic**, which is what makes it buildable: it
never needs to know which engine stranded the pool.

---

## 1. What is already shipped

#1976 listed five acceptance criteria. Four are discharged; this design is the
fifth. Verified against `main` at `1d9ea75c`, not taken from the issue text.

| # | Criterion | State |
|---|---|---|
| 1 | Reserved pool returns to near-baseline after a render, no restart | **open — this design** |
| 2 | A failed admission reclaims + re-probes once before refusing | shipped, `main.py:4011` `_reclaim_stranded_cache`, PR #1993 |
| 3 | Regression test: an admission failing on the stale figure succeeds after reclaim | shipped, `tests/test_placement.py:1048-1352` |
| 4 | `/health` reports per-device reserved VRAM | shipped, `main.py:8015` `_cuda_vram_mb_per_device` |
| 5 | ASR reservation accounts for residency | shipped, split out as #2094, closed |

---

## 2. The mechanism

### 2.1 Why the pool survives

Every reclaim in `main.py` is a **side effect of dropping a resident model**.
`unload()`, `unload_design()`, `maybe_free_idle*` and all three idle watchdogs
converge on `_reclaim_after_drop`, which runs `gc.collect()` then
`torch.cuda.empty_cache()`.

`empty_cache()` is **process-wide**, not per-device. `main.py:3788-3804` records
this as verified against the installed torch 2.11.0+cu128: the call takes no
device argument, and `NativeCachingAllocator::emptyCache()` loops every device's
allocator internally.

Those two facts together give the exact residual condition:

> **Whichever engine drops next clears the whole process's stranded pool,
> whoever stranded it.** The pool therefore survives exactly one state: something
> is resident and keeps being touched, so no TTL elapses and no drop happens —
> *and* nothing gets refused, so #1993 never fires.

That is precisely the reported state: `qwen_loaded: false` with `asr_loaded:
true` and `spk_loaded: true`, both being exercised.

### 2.2 Why "which engine owns the pool" stops being load-bearing

#1996 records this as an open question blocking the design, because a hook keyed
on one engine's unload path would miss a pool owned by a different engine. That
is true — and it is an argument against *that kind of hook*, which review has
already killed for an unrelated reason.

**A reclaim with no residency precondition does not need the answer.** It frees
whatever the allocator is holding and nothing references, on every device, in
one call. The question is worth settling for its own sake, and §6 makes the
instrument that settles it a by-product — but it is not a prerequisite for
this work.

---

## 3. Rejected alternatives

**A. Hook the reclaim onto `POST /unload`** — attempt 1, PR #2029. Rejected in
review, recorded on #1996. Nothing issues `/unload` at render completion (the
three producers fire at run *start*, *mid*-render at a phase boundary, and on
user action), its engine allowlist is `{coqui, kokoro, qwen}` so ASR and SPK
cannot reach it at all, and because `evictEngineForPhase` calls it **during** a
render, a reclaim there would run a full-heap `gc.collect()` and a
device-synchronising `cudaFree` up to ~80 times on a 40-chapter mixed book.

**B. Hook it onto the three existing idle watchdogs.** This is where #1996's own
comment points, and it is wrong in both directions. When a watchdog fires it
already reclaims via `_reclaim_after_drop` — the hook adds nothing. When no
watchdog fires there is nothing resident to free — the hook never runs. It
covers everything except the one state §2.1 identifies.

**C. Node signals render completion.** Matches criterion 1's literal wording and
fires promptly, at the cost of a new cross-process contract and a second
producer to keep correct — and it inherits attempt 1's failure mode, where the
assumed completion caller turned out not to be on the completion path. It also
misses every non-render source of a stranded pool (a design-mint batch, an
aborted render, a direct sidecar user). Rejected in favour of an autonomous
sidecar, which needs no cooperation from anything.

**D. Quiet-only, with no pool-size floor.** Simplest predicate, but it runs a
full-heap collection and a device-synchronising `cudaFree` on cards holding
nothing worth reclaiming. The floor costs one subtraction.

---

## 4. The design

Four parts, all in `server/tts-sidecar/main.py`.

### 4.1 The quiet clock — `ReservationLedger`

`ReservationLedger` (`main.py:3662`) records a per-device `_last_release`
monotonic stamp inside `release()` (`main.py:3685`), under the lock that method
already holds, and exposes a `quiet_seconds(device_key)` reader.

**Why here and nowhere else.** All eleven GPU entry points run inside `async
with _placement.reservation(...)` (`main.py:9628, 9663, 9688, 9729, 9907, 10029,
10125, 10328, 10549, 10714, 10789`), and every one of them ends at the single
`self.ledger.release(held)` in that context manager's `finally`
(`main.py:4456`). A stamp there cannot miss an entry point. A hand-maintained
list of handlers can, and enumerating callers by hand is exactly what sank
attempt 1.

A hold that is never released (a crashed worker) leaves `engines_holding`
non-empty, so the predicate blocks rather than fires. The failure direction is
safe.

### 4.2 The watchdog

`_stranded_cache_watchdog`, started and stopped alongside the existing three in
the lifespan block (`main.py:665-678`), matching their established shape: a
fixed tick, `asyncio.to_thread` for anything that can block, `CancelledError`
re-raised, every other exception logged and swallowed so a watchdog never dies.

Tick interval follows the same derivation the others use
(`min(30.0, max(5.0, ttl / 4))`) — 30 s at the default TTL.

Per tick, for each device, when the predicate holds it calls
`PlacementController._reclaim_stranded_cache(device_key)` (`main.py:4011`) —
**not** `_reclaim_device_cache` and not `self.reclaim` directly. That method
carries the in-use check and the 30 s per-device cooldown, and calling anything
below it re-opens the guards PR #1993's review put there. Attempt 1 called the
wrong level and passed `f"unload:{engine_id}"` as a device key, which made
`engines_holding()` vacuously empty.

### 4.3 The predicate

All four must hold for a device:

1. **No live reservation** — `ledger.engines_holding(device_key)` is empty.
2. **Quiet** — `quiet_seconds(device_key) >= _STRANDED_IDLE_SECONDS`.
3. **A pool worth reclaiming** — `reserved_mb - allocated_mb >=
   _STRANDED_FLOOR_MB` on that device.
4. **Not already reclaimed for this quiet period** — a latch keyed on the
   `_last_release` stamp the reclaim ran against, cleared only when a new
   operation on that device moves the stamp.

**Clause 4 is load-bearing, not defensive decoration.** A pool that
`empty_cache()` genuinely cannot return — because it is allocated, not cached —
leaves clauses 1–3 permanently true on an idle box. Without the latch the
watchdog would run a full-heap `gc.collect()` and a device-synchronising
`cudaFree` every cooldown interval, forever, on a machine doing nothing. The 30 s
cooldown inside `_reclaim_stranded_cache` rate-limits that; it does not stop it.

### 4.4 Device-key derivation — a binding constraint

The watchdog **must** derive its device keys from the same source the ledger and
`probe_capacity` use, where `kind = "rocm" if _cuda_is_rocm() else "cuda"`
(`main.py:3491`).

`_cuda_vram_mb_per_device()` hardcodes `f"cuda:{i}"` (`main.py:8038`). On an AMD
box the ledger's live reservations are keyed `rocm:0` while that helper reports
`cuda:0`, so a watchdog iterating its keys would call `engines_holding("cuda:0")`,
get an empty set, and **reclaim during a live operation** — bypassing guard 1
entirely on exactly the platform nobody tests on. Either fix the helper's prefix
or bridge it explicitly; do not iterate its keys as-is.

---

## 5. Constants, not knobs

`_STRANDED_IDLE_SECONDS = 120.0` and `_STRANDED_FLOOR_MB = 512` are module
constants.

This follows `_RECLAIM_COOLDOWN_SECONDS`' stated reasoning (`main.py:3839-3845`):
a registry knob is for a tradeoff an operator would want to make, and per
CLAUDE.md it costs a registry entry, a `config:sync`, a Settings row, an
`.env.example` line and a wiki row. These two have one defensible value each.

120 s matches the grain of the existing TTLs (`ASR_IDLE_TTL`,
`QWEN_DESIGN_IDLE_TTL`) and is comfortably longer than a between-chapter gap, so
a live book render is never pessimised by having its pool freed and re-grown.
512 MB is well above incidental allocator slack and well below the ~3.9 GB
measured strand.

---

## 6. The instrument

`_cuda_vram_mb_per_device()` reports `reserved_mb` and `total_mb` but not
**allocated**, so `reserved - allocated` — the stranded quantity itself, and
clause 3's own input — cannot be read from outside the process today.

Adding `allocated_mb` to that payload makes `/health` show the pool appear after
a render and vanish after the reclaim. That is the predicate's input, the
on-box acceptance evidence, and the measurement that settles #1996's
"which engine owns the pool" question, all from one field.

The existing scalar `vram_reserved_mb` keeps its current-device-only meaning; a
live Node consumer reads it (`server/src/routes/sidecar-health.ts`), and its own
docstring (`main.py:8019-8029`) records that PR #1993 added the per-device map
*alongside* it deliberately rather than redefining the existing field.

---

## 7. Testing

Unit-testable in full via the seams `tests/test_placement.py` already uses — an
injected `reclaim` hook and an injected probe — plus an injected clock and an
injected per-device pool reader.

**The bar is set by attempt 1's failure.** Its five tests all passed with the
reclaim moved to *before* the model was freed, because they asserted that the
hook was called rather than when. Every clause here therefore ships with a
mutation that must turn a test red:

| Mutation | Test that must fail |
|---|---|
| Remove the floor check (clause 3) | no reclaim when the pool is below the floor |
| Remove the quiet check (clause 2) | no reclaim before the idle window elapses |
| Remove the in-use check (clause 1) | no reclaim while a reservation is held |
| Remove the latch (clause 4) | **exactly one** reclaim across N ticks with no intervening operation |
| Iterate `cuda:` keys on a ROCm-keyed ledger | no reclaim when the ledger holds `rocm:0` |

And the one that matters most — **a positive**, per the standing lesson that
proving a guard blocks proves nothing until you prove it permits:

> With an engine **resident but idle**, a pool above the floor, and the quiet
> window elapsed, the reclaim **does** fire.

That is the #1976 shape. A suite that only proved the guards block would pass
while covering none of the reported bug.

---

## 8. On-box acceptance

This cannot be proven at PR time — it needs a real render on a real card, so per
the Before-shipping checklist it converts into a register row rather than
blocking the merge. Recording it does block: the row, the run sheet and the live
view all move in the shipping PR.

What to observe:

1. Render a chapter to completion on the 8 GB card. Confirm via `/health`'s new
   `allocated_mb` and `nvidia-smi` that a pool above the floor is stranded.
2. Leave the box idle. Within one tick past the idle window, the pool returns to
   near-baseline (`nvidia-smi` under ~500 MiB) with **no process restart**, and
   the reclaim logs exactly once.
3. **The negative:** during a live multi-chapter render, confirm the reclaim
   never fires between chapters — no log line for the whole book.
4. Record which device held the pool, settling #1996's open question as a
   by-product.

---

## 9. Not in scope

The admission-failure path (#1993, shipped — unchanged by this work), ASR
footprint sizing (#2094, closed), the memory watchdog's recycle thresholds
(`_VRAM_SOFT_FRACTION` / `_VRAM_HARD_FRACTION`, `main.py:8150-8151` — a
different metric with its own path; note #1976's issue body cites these at
`:6980-6994`, which the file has since outgrown), the scalar
`vram_reserved_mb` field's meaning, and any Node-side change.

---

## 10. Risks

- **A pool that is allocated, not cached, is not reclaimable by anything here.**
  The predicate will observe it, fire once, free nothing, and latch. That is the
  correct outcome — a genuine leak is a different bug — but the log line must
  report before/after so the on-box run can tell the two apart rather than
  reading a no-op as a success.
- **The idle window is a guess about between-chapter gaps.** If a real book
  render pauses longer than 120 s between chapters (a slow analyzer step, a long
  assembly), the pool is freed and the next chapter's first line pays a fresh
  `cudaMalloc`. Correctness is unaffected; throughput takes a one-off hit. Step 3
  of the on-box run is what would catch it.
