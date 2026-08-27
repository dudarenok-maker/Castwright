# Re-applying the foreign delta on a stale cast.json merge base

**Date:** 2026-08-27
**Status:** **FALSIFIED at review round 2 — do not implement.** Its central
premise does not hold (§13). Kept, and kept in detail, because five predecessor
designs died undocumented enough to be re-proposed; this one records exactly
where it broke so attempt 8 starts from here. A decision is owed before any
further work — see §13.3.
**Issues:** #2015 (srv-82) — the rebuild half.
**Builds on:** `docs/superpowers/specs/2026-08-06-cast-merge-base-serialise-and-detect-design.md`
(the detection half, shipped as PR #2185) and
`docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` §6, §12.2, §13.
**Supersedes nothing.**

**On citations.** Claims here were checked against source, and §12 records which
of them survived an adversarial pass and which did not. The first draft of this
document asserted that the merge recomputes `name` from the fresh roster, citing
`merge-analysis-cast.ts`'s **header comment**; the function body at `:451-457`
does the opposite for the narrator. That is the same failure the 2026-08-06
spec's review named as its standing lesson — a "verified" stamp that was a
transcription — reproduced here one document later, on the exact character B4
measured. **Cite the body, never the header.** Where this document cites a
symbol rather than a line, that is deliberate.

## 1. What is left after #2185, and why it is not enough

#2185 shipped the *detection* half of #2015: `readPriorCastForMerge` captures a
fingerprinted snapshot under the cast lock, `CastMergeBase` carries that
fingerprint as mutable run state advanced at each write, and each of the five
merge-base write sites compares-and-sets inside one hold. On a mismatch it logs
and emits a `cast_merge_base_stale` SSE advisory.

**Then it writes the stale base over the foreign change anyway.** That was
deliberate — merge behaviour unchanged, so no data lost that is not already lost
today — and paired with an explicit bet: frequency data should decide whether the
rebuild is worth its risk, because four designs had already died on that path.

B4 (PR #2190) settled the *severity* half on a real book with a real analyzer: a
concurrent `POST /cast/add-alias` during attribution produced exactly one
advisory, and the alias was **gone** afterwards (`narrator.aliases ==
['Narrator']`). The advisory's "may have been overwritten" is literal. The
frequency half remains unmeasured — see §8.

### 1.1 The structural finding that reshapes the problem

**The five sites are not peers.** Verified against `server/src/routes/analysis.ts`:

| Site | Route | Payload built by | Kind |
|---|---|---|---|
| per-chapter interim | main | `overlayInterimCastForLiveView` | provisional |
| stage-1 | main | `overlayInterimCastForLiveView` | provisional |
| final | main | `mergeAnalysisResultWithExistingCast` | **authoritative** |
| per-chapter interim | subset | `overlayInterimCastForLiveView` | provisional |
| final | subset | `mergeAnalysisResultWithExistingCast` | **authoritative** |

Every payload is `{ characters }`.

Now trace the B4 loss against the shipped detector. A foreign alias lands during
chapter 3. The chapter-4 interim write takes the lock, observes the mismatch,
emits the advisory — **and then advances the baseline to its own payload**
(`cast-merge-base.ts`'s unconditional advance, whose comment states the advance
is deliberate). By the time the authoritative final write runs, on-disk matches
the baseline, so it reports **no conflict at all** and clobbers with
`merge(capturedPrior, fresh)`.

So a repair local to the detecting site is not merely incomplete — **detection at
an interim site currently *consumes* the signal the authoritative write needed.**
The foreign delta must be **accumulated into run state at whichever site observes
it, and re-applied at every subsequent write including the authoritative one.**

## 2. What we already hold at conflict time

All three sides of a three-way merge are in hand inside the existing hold, at
**zero additional I/O**:

- **`theirs`** — the live on-disk value. `readJsonWithFingerprint` returns
  `{ value, fingerprint }` and `writeChecked` destructures **only the
  fingerprint**, discarding a parsed value it has already paid for.
- **`base`** — the value whose hash the baseline is. See §4.1: free at every
  advance, and free at capture too, because `readPriorCastForMerge` also already
  parses the file and discards the wrapper.
- **`ours`** — the pending payload.

No new read, no new lock, no new lock class, no change to the lock order. **This
claim is now literally true**; the first draft asserted it while §4.3 introduced
a lazy `cast-id-history.json` read inside the hold. §4.4 removes the need for
that read entirely rather than excusing it.

## 3. Decision: a foreign-delta ledger

At a conflict, compute the allowlisted foreign delta `base → theirs`, append it
to a run-scoped ledger, and apply the accumulated ledger to every payload
immediately before it is written, inside the same hold.

### 3.1 Why not the two obvious alternatives

**Rejected — repair locally at the detecting site.** §1.1's baseline-advance
blinding means the authoritative write finds on-disk matching its baseline and
clobbers. This reproduces the B4 loss exactly while appearing to fix it.

**Rejected — recompute the merge against live on-disk state.** At any interim
site `theirs` is overwhelmingly *this run's own previous output*, so re-running
`mergeAnalysisResultWithExistingCast(theirs, fresh)` is precisely the "iteration
N re-reads the interim cast iteration N−1 wrote" behaviour the 2026-07-31 spec §6
rejected as silently degrading srv-13's carry-forward. It also re-opens the
fresh-run path that killed design 3.

**The ledger never re-runs the merge.** The merge already ran against the correct
pre-run base; the ledger re-applies only fields the merge itself designates as
not-analyzer-owned. srv-13's carry-forward is untouched by construction.

**This is not a re-run of a dead design.** Design 3 died on `mergeCore`'s
`if (!existing.length) return { characters: fresh }` short-circuit being reached
with an empty base on a fresh run. The ledger never calls `mergeCore`, so that
line is unreachable from this path.

### 3.2 The re-apply mirrors `mergeCore`'s overlay block

The first draft framed the allowlist as "consume `PRESERVED_VOICE_FIELDS` by
reference" and claimed that made the two drift-proof. It does not, because the
merge does not treat its fields uniformly. `mergeCore`'s overlay block is three
distinct rules, and the re-apply must mirror all three:

1. **Nine replacement-semantics fields** — the loop over `PRESERVED_VOICE_FIELDS`
   (`voiceId`, `voiceUuid`, `voiceState`, `matchedFrom`, `overrideTtsVoices`,
   `overrideTtsVoice`, `ttsEngine`, `voiceStyle`, `notLinkedTo`), copied only
   when the prior value is not `undefined`.
2. **`aliases` — UNIONED, not replaced** (`unionAliases(old.aliases,
   fresh.aliases)`). A replacement-shaped re-apply violates §3.3 in **both**
   directions: it drops a fresh-derived alias a clean run would have kept, and it
   enforces a foreign alias *removal* a clean run would have re-added by union.
   Since replacement is perfectly idempotent, §7's idempotency test cannot catch
   this — it needs its own test.
3. **The narrator's `name`** — carried forward when
   `NARRATOR_CHARACTER_IDS.includes(id) && typeof name === 'string' &&
   !isDefaultNarratorName(name)`. See §3.3.

So the invariant enforced by test is **structural alignment with `mergeCore`'s
overlay block**, not by-reference consumption of one constant. The list of nine
is still consumed by reference; the other two rules are mirrored explicitly, the
same way `mergeCore` itself writes them.

### 3.3 The governing invariant

> **The re-apply rescues a field if and only if an uncontended run would have
> preserved it.**

An upper bound alone is not enough — the first draft stated it one-sided ("only
rescue what a clean run keeps") and then used it to justify an exclusion the
merge body contradicts. Stated as a biconditional it does real work in both
directions:

- Rescuing **more** makes a raced run keep what a clean run drops. A behaviour
  that diverges on the presence of a race is unreproducible and untestable from
  the user's side — worse than the loss it replaces.
- Rescuing **less** is the bug this document exists to fix, and it is how `name`
  was wrongly excluded.

**`name` is IN, for the narrator only, on exactly `mergeCore`'s condition.** A
non-default narrator name is a user rename that a clean run preserves; excluding
it would lose a foreign rename of the one character B4's evidence is about.
`name` for every other character is **out**: the merge takes it from the fresh
roster.

**`tier` is out** — written by `applyTierToCastFiles`, not carried forward.

**Field deletions are IN.** `mergeCore` copies a preserved field only when
`old[key] !== undefined`, and the fresh roster carries no voice fields — so a
user *clearing* a voice is honoured by a clean run. The delta must therefore
encode three states per field (set / unchanged / **cleared**), not two. A
set-only delta silently un-does foreign clears, and — unlike an unresolvable id —
would never be counted.

## 4. Mechanism

### 4.1 `CastMergeBase` tracks base value and base hash as one three-state pair

The first draft said `baseValue` moves "in lockstep" with `baseline` while giving
it two states against `baseline`'s three — conflating "we deleted the file" with
"detection disabled", in a design whose predecessor spent a section arguing that
this exact conflation is a defect.

Instead the base is **one discriminated value** mirroring the fingerprint's three
states exactly: a parsed value with its hash / `ABSENT` / `null`. Advanced
together, never separately. `markDeleted()` moves the pair to `ABSENT`; a `null`
capture (carryover-sourced) is never advanced, unchanged from today.

**The captured base must be `{ characters }`-shaped, like every advance.**
`readPriorCastForMerge` returns `{ rows, fingerprint, source }` and discards
`cast.value`, so a naive implementation gives the *initial* base a bare-array
shape while every advance is an object — and `computeForeignDelta` would then
return empty for the **first** conflict of every run, silently, with no drop
count. That window — capture to first write — is the one the 2026-08-06 spec §3a
calls "the whole reason #2015 exists". `readPriorCastForMerge` returns the parsed
value alongside the rows; it has already paid for it.

### 4.2 One hook does the risky work, and it is wrapped

```
writeChecked(
  payload,
  onConflict: (c: { expected, observed, outcome }) => void,
  reconcile?: (payload, ctx: { base, theirs, conflicted }) => payload,
): Promise<void>
```

Order **inside one hold**:

1. read + fingerprint (unchanged);
2. compare (unchanged);
3. **`reconcile(payload, ctx)`** — new. Appends to the ledger and applies it.
   Wrapped: on throw, log and write the untransformed payload.
4. `writeJsonAtomic(path, reconciled)`;
5. advance the base pair to `{ value: reconciled, hash: fingerprintOfWrite(reconciled) }`;
6. **`onConflict`, if step 2 mismatched** — now carrying the reconcile *outcome*.

Two corrections from the first draft, both load-bearing:

**All domain work moved out of `onConflict` and into `reconcile`.**
`cast-merge-base.ts`'s existing contract says in terms that `onConflict` must not
throw, and it is called *before* `writeJsonAtomic`. The first draft put delta
computation over arbitrary parsed on-disk JSON there while wrapping only the
transform. A throw at the final site escapes the site's `catch (castWriteErr)`
(not a lock timeout, so not parked), lands in `catch (persistErr)`, which logs
"Non-fatal — the analysis result still streams back to the client" and falls
through to `send({ kind: 'result' })` — **cast.json and state.json unwritten, a
success reported.** That is exactly the #2295 silent-success class five rounds of
review closed. `onConflict` keeps its narrow log-and-emit contract, unchanged.

**`onConflict` moved after the write (step 6), so it can report an outcome.** §6
requires the advisory to distinguish a repair from a clobber; at the first
draft's step-2 position nothing knows yet whether anything was rescued, making §6
unimplementable. Moving it costs one thing, stated plainly: if the write throws,
no advisory is emitted — but a throwing write fails the job, which is strictly
louder than an advisory. It keeps **one** event, so none of the 2026-08-06 spec
§4's six-item delivery list re-opens.

Step 5 advancing off the *reconciled* payload rather than the original is not
cosmetic: advancing off the original would leave the baseline describing bytes
never written, and the next site would report a phantom conflict against this
run's own write.

### 4.3 The ledger — new pure module `server/src/store/cast-foreign-delta.ts`

No I/O, no lock awareness — the same posture as `cast-fingerprint.ts`:

- `computeForeignDelta(base, theirs)` — per-character allowlisted changes for ids
  present in **both** sides, encoding set / cleared per §3.3, mirroring
  `mergeCore`'s three rules per §3.2.
- `createForeignDeltaLedger()` — accumulates across the run.
- `applyForeignDelta(characters, ledger, idMap)` — re-applies, returning the new
  roster plus per-outcome counts.

**An empty ledger makes `reconcile` the identity function**, so the common path
is byte-identical to today and pays no extra syscall. Combined with §4.4 removing
the history read, **the conflict path adds no I/O either.**

`computeForeignDelta` must be **total over `theirs`**: unparseable bytes still
produce a real hash and therefore a genuine conflict with `theirs === null`
(`cast-fingerprint.ts` returns `{ value: null, fingerprint: hash }` on a parse
failure). A `null`/malformed `theirs` yields an empty delta, not a throw.

### 4.4 Id mapping: the in-memory rewrite table, not `cast-id-history.json`

The first draft resolved foreign ids through `buildCastResolver` plus a lazily
read `cast-id-history.json`. **That cannot work, and it fails in the worst
direction: silently, at the two sites that matter.** At the authoritative sites
the id rewrite is computed in memory (`composeRewrites(dd.rewrites,
folded.rewrites)` → `applyRewriteToPriorCast`), the write happens, and the
retirements that would put that mapping into `cast-id-history.json` are recorded
**after** the write — a fact the code states in a comment at the site ("record
AFTER the authoritative cast.json write"). Both job bodies have this ordering. So
at transform time the history file provably cannot contain the mapping being
looked up, `buildCastResolver` returns `undefined`, and every delta entry for a
deduped or folded character is dropped-and-counted at precisely the two sites
§1.1 argues are the whole point. The design would have paid a new in-lock read to
buy nothing.

**Instead: `reconcile` closes over the in-memory rewrite table**, which is in
scope at both authoritative call sites. The three provisional sites have no
rewrite and pass an identity map.

This is strictly better than the resolver on a second count. `buildCastResolver`
has normalised-id and normalised-history tiers — a fuzzy matcher. The three
interim sites deliberately use the *non*-fallback merge because a fuzzy match at
an interim write "has repeatedly turned that ambiguity into a durably swapped
character id" (srv-87 / #2086). Threading a resolver through all five sites would
reintroduce a fuzzy id matcher at the three the repo deliberately removed one
from. **Exact id match everywhere, after an explicit rewrite mapping.**

An entry whose id does not match after mapping is **dropped and counted** — a
known-lost user edit reaches the log and §6's advisory. Silently discarding it
would recreate #2015's own defect one level down.

### 4.5 The two remaining locked decisions

- **ABSENT base ⇒ no re-apply.** `computeForeignDelta` returns empty when the
  base is `ABSENT` or `null`. The advisory still fires, so fresh-run *detection*
  survives exactly as #2185 built it. Design 3's failure mode cannot recur
  because no rebuild path exists there at all (§3.1).
- **Field-level only.** A foreign-*added* character is not rescued. §3.3's
  biconditional would in fact **require** it — `mergeCore` carries voiced/reused
  rows the fresh roster omitted — so this is a deliberate, owner-chosen
  under-rescue and the one place the design knowingly falls short of its own
  invariant. Recorded as the first residual in §9, not buried.

## 5. What does not change

- No new lock, no new lock class, no change to `design → library-voice → cast`.
  `buildCastResolver` is gone from the design; `loadCastIdHistory` takes no lock
  in any case. **Note for a future editor:** the id-history *mutators*
  (`retireCharacterId` and four others) lock `cast-id-history:${bookDir}` — an
  **undocumented fourth key class** absent from CLAUDE.md's stated order. This
  design is safe because it never calls one inside the hold. Documenting that
  class is a chore this work surfaced; §10 carries it.
- No new SSE `kind`. The advisory keeps `code: 'cast_merge_base_stale'`, so
  dedupe, `trackForReplay`, both readers, the UI consumer and the mock are
  untouched.
- `mergeAnalysisResultWithExistingCast` and `overlayInterimCastForLiveView` are
  not modified and not re-run.
- The three fingerprint states and `UNREADABLE`'s comparison-suppression are
  unchanged. `UNREADABLE` skips the comparison, so `reconcile` sees
  `conflicted: false` and applies only the already-accumulated ledger.
- `readPriorCastForMerge`'s lock and two-file fallback are unchanged; it returns
  one additional already-parsed field (§4.1).

## 6. The advisory's text stops being true

The shipped message says the foreign change "may have been overwritten". After a
successful re-apply that is wrong; leaving it trains the user to distrust a
message now reporting a *repair*. Per §4.2 step 6 the emit happens after the
write, so the outcome is known and the message can distinguish repaired from
clobbered. A conflict where nothing was rescued keeps wording equivalent to
today's.

The `code` is unchanged (§5). What moves:

1. the shared message constant in `analysis.ts` — genuinely hoisted, consumed by
   both job bodies (verified);
2. `src/lib/api-cast-merge-base-warning.test.ts`, which pins the literal in three
   places. **`src/views/analysing.test.tsx` does NOT** — it asserts a synthetic
   string and will not break on a text change. The first draft claimed both;
   do not "fix" the one that does not need fixing.
   `server/src/routes/analysis.test.ts` and `analysis.merge-base-detect.test.ts`
   assert `code` only.
3. `openapi.yaml`'s warning description prose, mirrored verbatim into
   `src/lib/api-types.ts` — so `npm run openapi:types` produces a real diff and
   **the PR is not docs-only**. Nothing enforces that the yaml prose is edited;
   §7 adds a test that does.

## 7. Testing

The 2026-08-06 spec's rules carry over in full: mutation-verified against the
primitive the site actually calls, `--retry=0`, multi-chapter and Start-fresh
runs both mandatory, outcomes asserted rather than mechanisms. Added here:

- **The negative control remains the most important test.** An uncontended,
  multi-chapter, Start-fresh run emits zero advisories **and** `reconcile` is
  provably the identity — asserted on the written bytes, not on a spy.
- **The B4 shape, end to end**, with a fixture that **includes a dedup/fold id
  rewrite**. Without the rewrite this test passes under §4.4's broken first
  design, which is how that fatal finding stayed invisible.
- **The approach-B failure, explicitly:** a conflict detected at an *interim*
  site must still be present after the *authoritative* write. Without it, §1.1's
  blinding ships green through everything else here.
- **`aliases` union vs replacement**, discriminating explicitly: a foreign alias
  is rescued **and** a fresh-derived alias survives. Neither the B4 test nor the
  idempotency test can tell union from replacement (§3.2 rule 2).
- **A foreign narrator rename is rescued; a non-narrator rename is not** — §3.3
  in both directions.
- **A foreign field *clear* is re-applied** (§3.3), not silently un-done.
- **ABSENT base rescues nothing**, while still emitting the advisory.
- **An unmappable foreign id is dropped *and counted***, asserted on the count.
- **`reconcile` throwing writes the untransformed payload and does not fail the
  job** — the §4.2 fail-safe, mutation-verified.
- **A malformed (`theirs === null`) on-disk cast yields an empty delta, not a
  throw** (§4.3).
- **Idempotency:** applying an accumulated ledger twice equals applying it once,
  including the array-shaped `aliases` and `notLinkedTo`.
- **Structural alignment with `mergeCore`'s overlay block** (§3.2), so the two
  cannot drift.
- **`openapi.yaml` prose and the message constant agree**, so item 3 of §6
  cannot be half-done.
- **srv-13's voice/reuse carry-forward provably unchanged** — from #2015's own
  acceptance criteria.

## 8. Frequency is still unmeasured, and this ships an instrument

The repo owner has not observed `cast_merge_base_stale` fire on a real book since
#2185 merged, and has not checked. The 2026-08-06 bet is still open. This design
does not gate on it: B4 established the loss is real, and the cost here is
bounded — no new lock, no merge change, no new I/O, identity on the common path.

The ledger yields per-run counts of conflicts observed, entries re-applied,
entries dropped, and entries cleared. **The instrument's blind spot, stated
because an acceptance row will be read against it:** a foreign change touching
only analyzer-owned fields and a foreign change the delta failed to encode both
present as "conflict observed, nothing rescued". The counts discriminate dropped
ids and clears explicitly for that reason; what remains indistinguishable is a
genuinely analyzer-owned-only foreign edit, which is the correct no-op.

## 9. Residual risks, accepted

- **A foreign-added character is not rescued** (§4.5) — the one knowing
  departure from §3.3's biconditional, owner-chosen.
- **Between the Start-fresh `rm` and the first interim write, nothing is
  rescued.** `markDeleted()` moves the base to `ABSENT`, so §4.5 disables the
  re-apply for a window covering Phase 0a chapter 1. Detection still fires.
  Unlisted in the first draft, and it matters because the 2026-08-06 spec calls
  fresh "the single most important case".
- **A foreign writer that retires ids defeats the delta.** A concurrent
  `performCastMerge` removes an id and adds another, so "ids present in both
  sides" finds nothing and the delta is empty. Detected and reported, not
  repaired.
- **A foreign edit to an analyzer-owned field is still lost**, by design
  (`name` for non-narrators, `tier`). The invariant working, not a gap.
- **An `UNREADABLE` read still suppresses the comparison**, so a conflict during
  an I/O blip is missed and clobbered exactly as today. Unchanged from #2185.
- **The window is not narrowed.** This repairs a detected collision; it does not
  shorten the read→write window. #2015's premise is unchanged.
- **In-process only**, inherited from the cast-lock design.

## 10. Shipping

`Closes #2015`. One PR.

Carried in the same PR as chores this work surfaced: documenting the
`cast-id-history:${bookDir}` lock class in CLAUDE.md's lock-order rule (§5).

Owed on merge: an on-box acceptance register row for the real-book run — §8's
instrument against a real analyzer and a real concurrent cast edit, recording
conflicts observed / re-applied / dropped / cleared. Per CLAUDE.md this converts
into a row rather than blocking the merge, but the row, the run sheet and the
live view all move in the shipping PR.

## 11. Rejected designs, cumulative

Carried forward so attempt 7 does not restart from a blank page. Designs 1–4 are
detailed in the 2026-08-06 spec; 5–7 are this document's.

1. "Analysis owns cast.json" via `markAnalysisBusy` — consulting an unlocked
   registry is itself check-then-act.
2. Route-level `isAnalysisBusy` admission gate — most sites cannot express a
   refusal; a ~20-route contract change buying no correctness guarantee.
3. A `rev: number` counter — the fresh `rm` resets rev, the rebuild re-reads an
   absent cast, `mergeCore` short-circuits on an empty base, every designed voice
   is dropped on every fresh run.
4. A sha256 fingerprint alone — died on the capture point; solved by #2185's lock
   around the two-file fallback.
5. Repair locally at the detecting site — §3.1; reproduces the B4 loss while
   appearing to fix it.
6. Recompute the merge against live on-disk state — §3.1; degrades srv-13's
   carry-forward and re-opens design 3's path.
7. Map foreign ids through `buildCastResolver` + `cast-id-history.json` — §4.4;
   the mapping provably is not on disk yet at transform time, so it fails
   silently at the two sites that matter, and it reintroduces a fuzzy id matcher
   at the three sites srv-87 removed one from.

## 12. Review history

**2026-08-27 — adversarial assumption-checker pass (Premium tier).** One finding
fatal to a mechanism, four fatal-if-shipped but fixable in prose, eight prose
corrections. Each was re-verified against source before being folded in.

Fatal, mechanism changed (§4.4): id mapping via `buildCastResolver` +
`cast-id-history.json` cannot work, because retirements are recorded after the
write. Replaced with the in-memory rewrite table, which also removes the design's
only new I/O and its only fuzzy matcher.

Fatal if shipped, fixed in place: delta computation inside `onConflict` could
re-open the #2295 silent-success class (§4.2); `aliases` needs union semantics,
which the idempotency test cannot detect (§3.2); the narrator's `name` was
excluded by citing a header comment the function body contradicts (§3.3); §6's
outcome-reporting requirement was unimplementable at the first draft's emit point
(§4.2 step 6).

Corrected prose: §2's "no new read" contradicted §4.3; the captured base had a
different shape from every advance, silently emptying the first conflict of every
run (§4.1); field deletions were unencoded (§3.3); `baseValue` was two-state
against a three-state fingerprint (§4.1); the fresh-run rescue window and the
id-retiring foreign writer were unlisted residuals (§9); `analysing.test.tsx`
does not pin the message constant (§6); the `cast-id-history` lock class is
undocumented (§5).

**Confirmed sound and unchanged:** §1.1's structural finding and its site table;
§2's "`writeChecked` discards the parsed value"; §3.2's list of nine; §3.1's
citation of the 2026-07-31 spec §6; and that no part of this design is a re-run
of designs 1–4. Round 2 re-verified all five and they hold — they are the only
part of this document that survived.

## 13. Round 2 — why this design is falsified

**2026-08-27 — adversarial round 2 (Premium tier), targeting round 1's rewrites.**
Four findings fatal to the *mechanism*, not to the prose. Each was re-verified
against source before being accepted. §§1–12 above are left as written, so the
failure is legible rather than tidied away.

### 13.1 The central premise is false

**§3.3's biconditional is unachievable over the chosen field set, because the
allowlisted fields are not owned by the prior cast alone.** Three run-scoped
passes mutate exactly those fields, on both sides, before `mergeCore` runs:

- `linkSeriesReuseAtAnalysis` (`server/src/workspace/series-reuse-link.ts`)
  stamps `voiceId`, `voiceUuid`, `matchedFrom`, `voiceState`, `ttsEngine`,
  `overrideTtsVoices`, `voiceStyle` **and** `aliases` onto the **fresh** roster
  — verified by reading the function body.
- `pruneStaleReuseLinks` → `clearStaleLink` *deletes* seven of them from the
  prior.
- `dropReuseContinuityKeepDesignedVoice` strips three more on a Start-fresh run.

So for eight of the eleven fields the payload's value is a function of `base`
**and** `fresh` **and** two run-scoped transforms, and `theirs − base` cannot
invert any of them. §3.3's stated justification — *"the fresh roster carries no
voice fields"* — is simply false.

**And `merge-analysis-cast.ts`'s own header said so all along**, in a sentence
quoted in this design's very first source read: *"a fresh reuse-link stamped
this run (linkSeriesReuseAtAnalysis) on a previously voiceless character is left
intact."* Round 1's headline lesson was **cite the body, not the header**; the
premise that killed the design was contradicted by the header *and* the body,
and was read past twice.

The worst instance is concrete, not theoretical: re-applying a foreign
`matchedFrom` that `pruneStaleReuseLinks` deliberately cleared **resurrects the
stale cross-series link that pass exists to kill.** The ledger does not turn a
raced run into a clean run; it produces a third state, and at least one point in
that state is a bug the repo has already fixed once.

### 13.2 Three further fatal findings

- **The captured base aliases the array the run mutates.** `readPriorCastForMerge`
  returns `rows = cast.value.characters` — the same objects — and
  `pruneStaleReuseLinks` mutates them in place afterwards. So
  `computeForeignDelta` would read this run's *own* deletions in reverse and
  report them as foreign edits. §4.1's "it has already paid for it" is wrong: the
  capture needs a deep copy, which is real cost §2 claims the design does not pay.
- **§6 is still unimplementable; round 1 moved the emit's position but not its
  gate.** Step 6 still fires "if step 2 mismatched", and §1.1 — this document's
  own foundational finding — proves the authoritative site sees no mismatch once
  an interim write has advanced the baseline. The site whose outcome the user
  keeps is guaranteed silent, and the interim site's "repaired" message is what
  last-wins dedupe leaves standing. A toast claiming a repair over a field that
  was then dropped is strictly worse than #2185's honest wording.
- **§4.4's id map is the wrong table and an incomplete one.** The applied table
  is `stripEstablishedAsciiRewrites(composeRewrites(…), …)`, not the bare
  composition (#2584/#2570 exists for that difference); `dedupePriorCastByName`'s
  fold desynchronises the namespace at **all five** sites, so the three
  provisional sites do not have an identity map either; and `mergedFinal.retirements`
  is missing. Worse in kind: `applyRewriteToPriorCast` resolves a canonical-id
  collision by `voiceStateRank` — and `voiceState` is itself a delta field — so a
  foreign edit can change *which row wins*, and applying the loser's fields onto
  the winner welds one character's voice onto another. That is the srv-87/#2086
  swapped-identity class.

### 13.3 The finding that outlives this design, and the decision owed

**The shipped #2185 detector can fire on an uncontended run.** `recordRetirements`
runs at job start — after the capture, before all five write sites — and calls
`clearNotLinkedEdgesForDroppedRejections`
(`server/src/store/not-linked-edges.ts`), which takes the cast lock and writes
`cast.json` **without advancing the baseline**. `reconcileRejectEdgesOnDisk` has
the same shape at persist. Verified: both write through `writeJsonAtomic`, neither
touches `CastMergeBase`. Reachable whenever a run records a retirement that drops
a self-loop rejection.

This is a defect in shipped code that this design work surfaced, and it reframes
#2015 rather than sitting inside it:

1. §7's negative control — "an uncontended run emits zero advisories" — is not
   valid as written, and #2185's own passing negative control means only that its
   fixture had no dropped rejections.
2. §8's instrument would count the run's own writes as foreign conflicts,
   contaminating the very frequency measurement it exists to produce.
3. "The frequency half remains unmeasured" may be the wrong description of what
   #2185 has been recording since it merged.

**The decision owed, and it is the repo owner's:** whether the next round fixes
the self-inflicted conflict source first — which is a bounded, well-specified
change, and which must land before any frequency number means anything — or
whether #2015's repair half is withdrawn and the detector's honest wording is
accepted as the terminal answer. Attempt 8 should not begin before that is
settled, because the field-set question in §13.1 has a different answer depending
on it.
