# Serialising and detecting cast.json merge-base staleness

**Date:** 2026-08-06
**Status:** approved (design)
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

`fingerprint: null` means **"no compare-and-set is available for this run."**
That is the honest answer for carryover-sourced rows, and stating it explicitly
is what mechanism 4 could not do. A null fingerprint disables conflict
detection for that run rather than producing a wrong verdict.

**Safety of the lock (verified, not assumed).** Rule 1 forbids a locked function
calling another locked function on the same book. Both callers —
`analysis.ts:2850-2851` and `:5388` — sit at the top of their run, outside any
lock, and `applyReparse` never calls this function. Verified on `main` @
`5840b5f0`.

**Cost:** four test updates at `analysis.test.ts:2083-2132`, as #2015 predicted.

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

At `:3558`, `:3763`, `:4774` (main route) and `:5422`, `:5927` (subset route):
re-read cast.json, re-fingerprint, and compare against the captured value. A
mismatch against a **non-null** captured fingerprint is a conflict.

**The re-read, the comparison and the write all happen inside one
`withCastLock` hold** — per rule 2, wrapping only the write buys nothing, and a
check in a different scope from the write it guards is the check-then-act shape
this whole effort exists to remove.

A **null** captured fingerprint (a carryover-sourced or empty run) skips
detection entirely for that run. It must not be treated as "no conflict" in a
way that reports a false green — the distinction between *checked and clean*
and *not checkable* is recorded in the log line.

Each site must be checked against rule 1 before wrapping — a write already
inside a lock must not acquire a second one on the same book.

### 4. On conflict: log, notify, then write exactly as today

**Merge behaviour does not change.** The write proceeds with the same stale base
it uses today, so there is no regression risk and no work is destroyed. What
changes is that the event stops being silent:

- a structured log line with book, site, captured and observed fingerprints;
- a user-facing advisory on the analysis SSE.

The advisory follows the envelope this repo already uses on the splice,
generation and QA-repair streams — a stable machine-readable `code` plus a
human-readable `message`, so a caller can dedupe and route without parsing prose
(`openapi.yaml:1814-1829`):

```
{ kind: 'warning', code: 'cast_merge_base_stale', message: … }
```

The analysis stream today has exactly two payload shapes, `{kind:'phase'}` and
`{kind:'result'}` (`analysis.ts:1-5`). This adds a third. That is a contract
change and carries its full cost: `openapi.yaml`, a regenerated
`src/lib/api-types.ts` via `npm run openapi:types`, and the frontend reader in
`real.analyseManuscript`.

### 5. The allowlist shrinks; it does not retire

`cast-lock.guard.test.ts`'s `analysis.ts` entry is keyed on file **and** count.
Locking the writes changes the count, so the entry is updated with the new
number and a comment pointing at #2015 for the residual. Retiring it outright
requires the rebuild, which is out of scope.

## Testing

- **A Start-fresh run is mandatory.** A non-fresh test does not exercise the
  failure that killed design 3, and its absence is why that design reached
  review at all.
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
