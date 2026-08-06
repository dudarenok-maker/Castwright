# Serialising and detecting cast.json merge-base staleness

**Date:** 2026-08-06
**Status:** implemented — all 10 plan tasks complete on `fix/server-cast-merge-base-serialise` (2026-08-06); PR [#2185](https://github.com/dudarenok-maker/Castwright/pull/2185), open, not yet merged.
**Issues:** #2155 (carryover's unlocked touchers), #2015 (merge-base staleness)
**Supersedes nothing.** Builds on `docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` §6, §12.2, §13.

## Why this document exists

`server/src/routes/analysis.ts` reads a cast snapshot once near the top of a run
and uses it as the merge base for five writes spread across the whole Phase 0/1
pipeline. On a full book the window between the read and the last write is
minutes. Any cast.json write by another route inside that window is replayed
over and silently lost.

Four mechanisms have been designed for this and none survived review. They are
recorded on #2015 and summarised in "Rejected designs" below so this attempt
does not rediscover them.

This design deliberately takes **only the half that can be made safe now**:
serialise the accesses, and make the staleness *visible*. It does not attempt
the rebuild-on-conflict path, which is where designs 3 and 4 actually died.

## Scope

**In scope**

- #2155 in full — the carryover file's two unlocked touchers in `analysis.ts`.
- #2015's *detection* half — an honest capture point, and a conflict signal.

**Out of scope, explicitly**

- The rebuild-on-conflict path. #2015 stays open.
- #2014, #2149, #2131. Independent `srv` work; they must not ride a
  concurrency design.

## Rejected designs (from #2015 — do not re-propose)

1. **"Analysis owns cast.json" via `markAnalysisBusy`.** Consulting an unlocked
   registry is itself check-then-act — the defect class being fixed.
   `isAnalysisBusy` is a bare `Map` read with no coupling to the cast mutex.
2. **Route-level `isAnalysisBusy` admission gate.** Seven of thirty non-analysis
   write sites are internal helpers or run detached after `res.flushHeaders()`
   and have no status-code channel; two more (`cast-merge-suggestions.ts:92`,
   `cast-tier.ts:38`) write transitively and are invisible to a site-indexed
   enumeration. It is also a ~20-route `openapi.yaml` contract change buying
   something that is explicitly not a correctness guarantee.
3. **A `rev: number` counter.** Deterministically re-broke the 2026-07-14
   Coalfall voice-strip: the `fresh` block's `rm` resets on-disk rev to the
   read-path default `0`, the first interim write conflicts, the rebuild
   re-reads an *absent* cast, and `mergeAnalysisResultWithExistingCast`
   short-circuits on an empty base — dropping every bespoke designed voice on
   every fresh run.
4. **A sha256 content fingerprint.** The better primitive, but it died on the
   *capture point*: the snapshot comes from `readPriorCastForMerge`, a two-file
   fallback, so fingerprinting cast.json describes bytes the snapshot may not
   have come from.

**This design is attempt 5.** It keeps mechanism 4's primitive and fixes its
capture problem with a lock, which is the insight the earlier attempts lacked:
taking the cast lock around the two-file fallback makes "which file did these
rows come from" a decidable question answered *atomically with the read itself*.

## Design

### 1. Capture — `readPriorCastForMerge` returns a fingerprinted snapshot

`readPriorCastForMerge` (`analysis.ts:175-190`) currently returns bare rows.
It changes to return `{ rows, fingerprint, source }` and its body is wrapped in
`withCastLock(bookDir, …)`.

Inside the lock:

- read `cast.json`; if it has a non-empty `characters` array →
  `{ rows, fingerprint: sha256(bytes), source: 'cast' }`
- otherwise read the carryover; if it yields rows →
  `{ rows, fingerprint: null, source: 'carryover' }`
- otherwise → `{ rows: [], fingerprint: null, source: 'none' }`

The fingerprint hashes the **raw file bytes**, not a normalised or re-serialised
form. Any write changes the bytes, which is the property that makes this work
without requiring universal adoption of a schema field. It preserves the
existing precedence exactly — a non-empty cast.json wins over the carryover —
so this is a change of return *shape*, not of which rows are returned. An empty
`characters: []` in cast.json falls through to the carryover today and must
continue to.

**Implementation note:** the function currently reads via `readJson`, which
parses and discards the bytes. The locked body must read the raw bytes once and
parse *those*, not call `readJson` and then re-read the file to hash it — a
second read outside the same syscall pair reintroduces the very gap the lock
closes.

### 1a. The three fingerprint states

The fingerprint is a **three-state** value, not nullable-hash. Collapsing the
last two is what makes the detector fire on fresh runs.

| State | Meaning | Comparison behaviour |
|---|---|---|
| `sha256(bytes)` | a cast.json existed and these rows came from it | compare normally |
| `ABSENT` | no cast.json is expected to exist right now | matches only an absent file |
| `null` | rows came from the carryover, or nowhere | **detection disabled for this run** |

`null` and `ABSENT` are different claims. `null` says *"I cannot check."*
`ABSENT` says *"I can check, and the correct observation is that there is no
file."* A design that returns `null` for both silently disables detection on
every fresh run — the single most important case, because fresh is where
design 3 died.

`fingerprint: null` means **"no compare-and-set is available for this run."**
That is the honest answer for carryover-sourced rows, and stating it explicitly
is what mechanism 4 could not do. A null fingerprint disables conflict
detection for that run rather than producing a wrong verdict.

**Safety of the lock (verified, not assumed).** Rule 1 forbids a locked function
calling another locked function on the same book. Both callers —
`analysis.ts:2850-2851` and `:5388` — sit at the top of their run, outside any
lock, and `applyReparse` never calls this function. Verified on `main` @
`5840b5f0`.

**Cost:** the `describe` at `analysis.test.ts:2086-2136`, with three call sites
to update. (#2015 predicted "four test updates at `:2083-2132`"; the block is at
`:2086-2136` and has three, not four.)

### 2. #2155's two touchers ride the existing `cast` key

No new lock class. `applyReparse` already writes the carryover *inside*
`withCastLock` (`book-state.ts:996`), so riding the `cast` key is consistent by
construction with the file's only writer, and leaves the global order
`design → library-voice → cast` untouched. A fourth class would require
re-deriving every ordering rule — a permanent cost for a file with one writer
and two readers.

- **The read** (`:186`) is covered by §1.
- **The delete** (`:2928`) folds into the existing `withCastLock` hold at
  `:2924`, so cast.json and the carryover are discarded atomically. Only those
  two paths belong inside the hold; `manuscriptEditsJsonPath`'s `rm` (`:2925`)
  does not.

This closes the observability hole #2155 describes: a concurrent analysis can no
longer read the intermediate state where the carryover is written but cast.json
is not yet deleted.

### 3. Detect at the five write sites

The five sites, **verified by reading the file** (the numbers carried in #2015
and in this spec's first draft — `:3558`, `:3763`, `:4774`, `:5422`, `:5927` —
were never correct at any commit):

| Site | Route | Note |
|---|---|---|
| `:3646` | main | **inside the per-chapter loop** |
| `:3858` | main | stage-1 write |
| `:4898` | main | final write |
| `:5626` | subset | **inside the per-chapter loop** |
| `:6161` | subset | final write |

At each: re-read cast.json, re-fingerprint, compare against the **current
baseline**, write, then **advance the baseline**.

**The re-read, the comparison, the write and the baseline advance all happen
inside one `withCastLock` hold** — per rule 2, wrapping only the write buys
nothing, and a check in a different scope from the write it guards is the
check-then-act shape this whole effort exists to remove.

### 3a. The baseline-advance rule — without this, the detector is useless

**This is the correction that separates attempt 5 from failure 5.** The
captured fingerprint is not a run-long constant. Two of the five sites sit
inside per-chapter loops and write on every chapter, so the run *invalidates its
own baseline* almost immediately. Comparing every site against the value
captured at §1 would report a conflict from chapter 2 onward on every
multi-chapter book with **zero concurrent writers** — a detector that fires on
essentially 100% of runs, destroying both deliverables at once: the frequency
data becomes noise, and the user sees a warning on every single analysis.

The baseline is therefore **mutable run state**, advanced at exactly two places,
each inside the hold that causes the change:

1. **After each of the five writes** — `baseline := sha256(the bytes just
   written)`. Computed from the buffer that was written, not by re-reading.
2. **Inside the fresh block's locked `rm`** (`:2924`) — `baseline := ABSENT`.
   The §1 capture deliberately happens *before* this `rm` (the comment at
   `:2846-2847` mandates that ordering, so the rows survive the delete), which
   means the captured hash describes a file this run is about to delete. Without
   this reset the first write site re-reads an absent file against a live hash
   and reports a guaranteed false conflict — the fresh-run shape that killed
   design 3, resurfacing through a different mechanism.

A `null` baseline (carryover-sourced or empty) skips detection for the whole
run and is never advanced. It must not be recorded as "checked and clean" — the
log distinguishes *checked and clean* from *not checkable*.

**What remains detectable after this correction** is exactly the intended
window: a foreign write landing between this run's own consecutive holds,
including the long gap between the §1 capture and the first write. That window
is minutes on a full book, which is the whole reason #2015 exists.

Each site must be checked against rule 1 before wrapping — a write already
inside a lock must not acquire a second one on the same book. (Verified during
review: all five spans contain only pure helpers plus `writeJsonAtomic`, and
`analysis.ts` imports no design or library-voice lock, so no earlier-class
acquisition occurs inside a `cast` hold.)

### 4. On conflict: log, notify, then write exactly as today

**Merge behaviour does not change.** The write proceeds with the same stale base
it uses today, so **no data is lost that is not already lost today**.

That is a claim about data, not about behaviour. A noisy detector *is* a
user-visible regression — a warning banner on every analysis is worse than
today's silence, because it trains the user to ignore the one that matters.
The §3a baseline-advance rule is therefore not a refinement; it is the
precondition that makes this section's promise true at all.

What changes is that a genuine conflict stops being silent:

- a structured log line with book, site, captured and observed fingerprints;
- a user-facing advisory on the analysis SSE.

The advisory follows the envelope this repo already uses on the splice,
generation and QA-repair streams — a stable machine-readable `code` plus a
human-readable `message`, so a caller can dedupe and route without parsing prose
(`openapi.yaml:1814-1829`):

```
{ kind: 'warning', code: 'cast_merge_base_stale', message: … }
```

**The delivery path is where this design was most wrong, and it is the half
that decides whether the advisory reaches anyone at all.**

The header comment at `analysis.ts:1-5` says the stream has two payload shapes,
`{kind:'phase'}` and `{kind:'result'}`. **That comment is stale.** The wire
actually carries roughly fourteen kinds (`phase`, `result`, `log`, `eta`,
`cast-update`, `chapter-failed`, `chapter-resolved`, `series-prior`,
`heartbeat`, `throttle`, `error`, `main`, `subset`), and the frontend's union is
**hand-written** at `src/lib/api.ts:2679-2691` — *not* generated. So
`npm run openapi:types` does not touch the reader, and the first draft's cost
model was wrong in both directions.

The real cost, all of which is in scope:

1. `openapi.yaml` — the new `kind` and its `code`/`message` fields.
2. The **hand-written** union at `api.ts:2679-2691` — edited by hand, not
   regenerated. (That this union is hand-mirrored is itself the #2051 shape;
   not this lane's problem, but do not mistake it for generated.)
3. **Both readers.** `realAnalyseManuscript` *and* `realRunAnalysisForChapters`
   (`api.ts:5363`) — the subset route is a second consumer, and two of the five
   write sites (`:5626`, `:6161`) are on it. The `handle` chain silently ignores
   unknown kinds, so a missed reader fails *quietly*.
4. **`trackForReplay` (`analysis.ts:2338-2368`).** Its switch handles only
   `log`/`phase`/`eta`/`cast-update`/`chapter-failed`. Without a `warning` case,
   an advisory emitted while the user is disconnected is never replayed on
   reconnect — and a long, disconnected run is precisely the scenario with the
   widest race window. Omitting this drops the signal in the dominant case.
5. **A UI surface** that renders the advisory. Emitting a kind no component
   consumes is emitting into a void.
6. The **mock** API, so the mock and real paths do not diverge.

A missing item in 3, 4 or 5 does not fail a build or a test — it silently
discards the signal. That is why they are enumerated here rather than left to
implementation.

### 5. The allowlist shrinks; it does not retire

**Correction: the entry must be REMOVED, not renumbered.** Read
`cast-lock.guard.test.ts:386, 400-418, 450-457`: `scanFile` returns `null` when
a file has zero *unlocked* occurrences, and an allowlist entry whose file now
scans clean trips the guard's own "scan now finds ZERO unlocked occurrences —
update or **remove** this entry" branch. Locking all five writes takes
`analysis.ts`'s unlocked count to zero, so a `{ writes: 0 }` entry is not merely
wrong, it is impossible — leaving the entry in place fails the guard.

The first draft said the entry "shrinks but does not retire," conflating two
different things. **The allowlist tracks lockedness, not staleness.** Locking
the five writes retires the entry outright, and #2015 stays open regardless,
because the rebuild is a separate concern that the allowlist never measured.
So: the entry is deleted, and #2015's residual is recorded in prose at the
call sites and on the issue, not as an allowlist row.

## Testing

- **The negative control is the most important test in this list.** An
  uncontended, multi-chapter, Start-fresh run must emit **zero**
  `cast_merge_base_stale` events across all five sites. Without it, a detector
  with a ~100% false-positive rate passes every other test here — which is
  exactly what the first draft of this spec would have shipped. A detector
  needs a known-negative as much as a known-positive; asserting only that a
  real conflict is caught cannot distinguish a working detector from one that
  fires unconditionally.
- **A Start-fresh run is mandatory.** A non-fresh test does not exercise the
  failure that killed design 3, and its absence is why that design reached
  review at all. Fresh must be covered in *both* directions: zero events on an
  uncontended fresh run (the `ABSENT` baseline behaving), and a real conflict
  still caught on a contended one.
- **A multi-chapter run is mandatory**, not a single-chapter one. Two of the
  five sites are inside the per-chapter loop, so a single-chapter test executes
  each site once and cannot observe a stale-baseline false positive at all.
- Interleaving scripted with a gated `readJson`; mutation-verified against
  **the primitive the site actually calls**; `--retry=0`; 5+ separate process
  runs (`retry: 1` is live and has produced a false green — #2028).
- **Assert outcomes, never mechanisms.** The cast-lock guard is call-graph-blind
  by design, so a test asserting that a `withCastLock` token appears at a call
  site passes vacuously. Tests must assert that serialisation held and that a
  conflict was detected and surfaced.
- srv-13's voice/reuse carry-forward provably unchanged, with a test — carried
  forward from #2015's acceptance.
- A carryover-sourced run (`fingerprint: null`) must be shown to disable
  detection rather than report a false conflict.

## Consequences

**Gained:** #2155 closed. A capture primitive that survives the two-file
fallback. The five writes serialised. First-ever data on how often the race
actually fires.

**Not gained:** the stale base is still replayed on conflict; the concurrent
edit is still overwritten. It is now logged and surfaced, not silent.

**Deliberate bet:** frequency data should decide whether the rebuild is worth
its risk. Four designs have died on that path; committing to a fifth without
knowing whether the race fires weekly or never would be premature.

## Review history

**2026-08-06 — adversarial review (Fable tier, at the repo owner's explicit
request).** The reviewer verified claims against source rather than against this
document, and established one decisive fact first: `analysis.ts` is
byte-identical between the commit this spec cited as its verification base
(`5840b5f0`) and current HEAD — so every citation error below existed at the
moment the spec claimed to have verified it.

Findings folded in:

1. **Fatal, now fixed (§3a).** The captured fingerprint was treated as a
   run-long constant, but two of the five write sites are inside per-chapter
   loops and the run therefore invalidates its own baseline. As first written,
   the detector would have fired on ~100% of multi-chapter runs with no
   concurrent writer, and on *every* fresh run. Fixed by the baseline-advance
   rule.
2. **Fatal by omission, now fixed (Testing).** No test asserted that an
   uncontended run emits zero conflicts, so finding 1 would have shipped green
   through every test the spec listed.
3. **Mis-scoped (§4).** The claim that the analysis stream has "two payload
   shapes" was transcribed from a **stale header comment**; the wire carries
   ~14 kinds and the frontend union is hand-written, not generated. The
   delivery path — both readers, `trackForReplay`, a UI consumer, the mock —
   was largely absent, and each omission fails *silently*.
4. **Wrong (§5).** The allowlist entry must be removed, not renumbered; a
   zero-occurrence entry fails the guard outright.
5. **Wrong citations.** The five write-site line numbers were copied from aged
   issue text and were never correct at any commit.

**Independently re-verified and confirmed sound:** §1's lock safety (two
production callers, both outside any lock; `applyReparse` never calls it),
§2's carryover lock class, lock ordering (no earlier-class acquisition inside a
`cast` hold), throughput (no stall path), and the `openapi.yaml:1814-1829`
warning-envelope precedent.

**Standing lesson for the next reader.** Three of this spec's original
"verified" stamps were transcriptions from stale documents — an issue body and a
stale code comment — inside a document whose own governing instruction was not
to do that. Treat a "verified" claim as verified only where the citation was
re-checked against source; this section marks which ones were.
