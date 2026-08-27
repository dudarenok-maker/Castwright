# Re-applying the foreign delta on a stale cast.json merge base

**Date:** 2026-08-27
**Status:** draft — design approved in chat, not yet planned or implemented.
**Issues:** #2015 (srv-82) — the rebuild half.
**Builds on:** `docs/superpowers/specs/2026-08-06-cast-merge-base-serialise-and-detect-design.md`
(the detection half, shipped as PR #2185) and
`docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` §6, §12.2, §13.
**Supersedes nothing.**

**Line citations are load-bearing only where marked "verified".** Every claim in
§1–§3 was re-checked against source on 2026-08-27 rather than transcribed from
the issue body or from the two predecessor specs — the 2026-08-06 spec's own
review found that three of its "verified" stamps were transcriptions from stale
documents, and its standing lesson is not to repeat that. Where this document
cites a symbol rather than a line, that is deliberate.

## 1. What is left after #2185, and why it is not enough

#2185 shipped the *detection* half of #2015: `readPriorCastForMerge` captures a
fingerprinted snapshot under the cast lock, `CastMergeBase` carries that
fingerprint as mutable run state advanced at each write, and each of the five
merge-base write sites compares-and-sets inside one hold. On a mismatch it logs
and emits a `cast_merge_base_stale` SSE advisory.

**Then it writes the stale base over the foreign change anyway.** That was
deliberate — the spec's §4 says merge behaviour is unchanged, so no data is lost
that is not already lost today — and it was paired with an explicit bet:
frequency data should decide whether the rebuild is worth its risk, because four
designs had already died on that path.

B4 (PR #2190) settled the *severity* half of that bet on a real book with a real
analyzer: a concurrent `POST /cast/add-alias` during attribution produced exactly
one advisory, and the alias was **gone** afterwards (`narrator.aliases ==
['Narrator']`). The advisory's "may have been overwritten" is literal, not
hedged. The detector neither cries wolf nor under-reports, and the loss it
reports is real.

The *frequency* half remains unmeasured — see §8.

### 1.1 The structural finding that reshapes the problem

**The five sites are not peers, and treating them as peers is what makes a naive
fix wrong.** Verified by reading `server/src/routes/analysis.ts`:

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
(`cast-merge-base.ts`, the unconditional advance). By the time the authoritative
final write runs, on-disk matches the baseline, so it reports **no conflict at
all** and clobbers with `merge(capturedPrior, fresh)`.

So a fix that repairs the conflict only at the site that detected it is not
merely incomplete — **detection at an interim site currently *consumes* the
signal the authoritative write needed.** Any design whose repair is local is
wrong for this reason, and it is the shape a reviewer will reach for first.

The foreign delta must therefore be **accumulated into run state at whichever
site observes it, and re-applied at every subsequent write including the
authoritative one.**

## 2. What we already hold at conflict time

The repair needs a three-way merge's three sides. All three are already in hand
inside the existing hold, at zero additional I/O — this is the fact that makes
the design cheap, and it is why attempt 6 is worth making after five failures.

- **`theirs`** — the live on-disk value. `readJsonWithFingerprint` returns
  `{ value, fingerprint }` and `writeChecked` destructures **only the
  fingerprint**, discarding a fully parsed value it has already paid for.
- **`base`** — the value whose hash the baseline currently is. Not tracked today,
  but free to track: the baseline advance is `fingerprintOfWrite(payload)`, so
  the payload that produced it is in scope at the moment of the advance.
- **`ours`** — the pending payload, the argument to `writeChecked`.

No new read, no new lock, no new lock class, no change to the lock order
(`design → library-voice → cast`).

## 3. Decision: a foreign-delta ledger

At a conflict, compute the allowlisted foreign delta `base → theirs`, append it
to a run-scoped ledger, and apply the accumulated ledger to every payload
immediately before it is written, inside the same hold.

### 3.1 Why not the two obvious alternatives

Recorded so they are not re-proposed, in the manner of the four designs on #2015.

**Rejected — repair locally at the detecting site.** Simpler, no run state, and
provably loses the delta: §1.1's baseline-advance blinding means the
authoritative write finds on-disk matching its baseline and clobbers. This
reproduces the B4 loss exactly while appearing to fix it.

**Rejected — recompute the merge against live on-disk state.** One line to
describe: on conflict, re-run `mergeAnalysisResultWithExistingCast(theirs,
fresh)`. It has the largest blast radius of any option considered. At any
interim site `theirs` is overwhelmingly *this run's own previous output*, so
this is precisely the "iteration N re-reads the interim cast iteration N−1
wrote" behaviour the 2026-07-31 spec §6 rejected as silently degrading srv-13's
voice/reuse carry-forward. It also re-opens the fresh-run rebuild path that
killed design 3.

The ledger avoids both because **it never re-runs the merge.** The merge already
ran against the correct pre-run base; the ledger only re-applies fields the
merge itself designates as not-analyzer-owned. srv-13's carry-forward is
untouched by construction rather than by test.

### 3.2 The allowlist is `PRESERVED_VOICE_FIELDS`, not a new list

`server/src/store/merge-analysis-cast.ts` already exports the exact set of
per-character fields the analyzer never produces (verified):

```
voiceId, voiceUuid, voiceState, matchedFrom,
overrideTtsVoices, overrideTtsVoice, ttsEngine, voiceStyle, notLinkedTo
```

plus `aliases`, which the merge unions rather than replaces (`unionAliases`).

The re-apply consumes that constant **by reference**. A field added to it later
joins the re-apply automatically, and the two can never disagree by drift. §7
requires a test that fails if an implementer hardcodes a parallel copy.

### 3.3 The governing invariant

> **The re-apply may only rescue a field that an uncontended run would have
> preserved anyway.**

If it rescued more, the presence of a race would change the outcome in a *new*
direction — a conflicted run keeping something a clean run drops — and a
behaviour that diverges on the presence of a race is worse than the loss it
replaces, because it is unreproducible and untestable from the user's side.

This is what makes the allowlist principled rather than a taste call, and it
decides two fields that were live candidates during design and are **excluded**:

- **`name`** — `merge-analysis-cast.ts`'s header states that name, role,
  attributes, evidence, tone, lines, scenes and colour come from the fresh
  roster. A re-analysis legitimately recomputes a name; rescuing a foreign
  rename would make a raced run preserve what a clean run overwrites.
- **`tier`** — written by `applyTierToCastFiles`, not carried forward by the
  merge. Same reasoning.

Both were named as plausible allowlist members earlier in design and are
excluded on this invariant, not on oversight.

## 4. Mechanism

### 4.1 `CastMergeBase` tracks the base value alongside the base hash

`createCastMergeBase(resolveBookDir, capturedFingerprint)` gains the captured
*value*. Internally `baseValue` moves in lockstep with `baseline`:

- advanced to the written payload on every successful write, in the same place
  the hash advances;
- nulled by `markDeleted()`, alongside `baseline = ABSENT`;
- never advanced when `baseline === null` (detection disabled — the carryover
  case), matching the existing rule exactly.

The three-state fingerprint (`sha256` / `ABSENT` / `null`) and `UNREADABLE`'s
comparison-suppression semantics are **unchanged**. This design adds a parallel
value, not a fourth state.

### 4.2 `writeChecked` gains two hooks

```
writeChecked(
  payload,
  onConflict: (c: { expected, observed, base, theirs }) => void,
  transformPayload?: (payload: unknown) => unknown,
): Promise<void>
```

Order **inside one hold**, unchanged except where marked:

1. read + fingerprint (unchanged);
2. compare; on mismatch call `onConflict` — *now carrying `base` and `theirs`*;
3. **`transformPayload(payload)`** — new;
4. `writeJsonAtomic(path, transformed)`;
5. advance `baseline = fingerprintOfWrite(transformed)` and `baseValue =
   transformed`.

Because step 2 precedes step 3, **the site that detects a conflict also repairs
it** — the delta appended by `onConflict` is already in the ledger the transform
reads. Later sites re-apply the accumulated ledger idempotently.

Step 5 advancing off the *transformed* payload rather than the original is not
cosmetic: advancing off the original would leave the baseline describing bytes
that were never written, and the next site would report a phantom conflict
against this run's own write — the exact cascade `cast-merge-base.ts`'s existing
UNREADABLE comment warns about.

### 4.3 The ledger — new pure module `server/src/store/cast-foreign-delta.ts`

Three exports, no I/O, no lock awareness — the same posture as
`cast-fingerprint.ts`:

- `computeForeignDelta(base, theirs)` — per-character allowlisted field changes,
  for ids present in **both** sides, only where the value actually differs.
- `createForeignDeltaLedger()` — accumulates deltas across the run.
- `applyForeignDelta(characters, ledger, history)` — re-applies, returning the
  new roster plus a count of entries that could not be applied.

**An empty ledger makes the transform the identity function.** Conflicts are
rare, so the common path stays byte-identical to today and pays no extra
syscall. The id-history read that `applyForeignDelta` needs happens lazily at
the **first** conflict and is cached for the run, so an uncontended run never
performs it at all.

### 4.4 Id namespace — the one place this needs care

At the two authoritative sites the payload's character ids have already been
rewritten by dedup/fold (`applyRewriteToPriorCast`), while a foreign row's id
belongs to the pre-rewrite namespace. A raw id match would miss.

`applyForeignDelta` therefore resolves foreign ids through
`buildCastResolver(payloadCharacters, history)` (`server/src/store/cast-resolve.ts`),
per CLAUDE.md's standing rule that `cast.json` is the identity of record and a
`characterId` is only an alias into it. **No second id matcher is introduced.**

**An entry that fails to resolve is dropped AND counted.** A dropped entry is a
known-lost user edit; it reaches the server log and §6's advisory. Silently
discarding it would recreate #2015's original defect one level down — a loss
that the machinery designed to report losses does not report.

### 4.5 The three locked decisions, as behaviour

- **ABSENT base ⇒ no re-apply.** `computeForeignDelta` returns an empty delta
  when `base` is absent or null. The advisory still fires, so fresh-run
  *detection* survives exactly as #2185 built it (`ABSENT` exists precisely so
  fresh runs stay checkable). What does not exist on the fresh path is a rebuild
  — which is why design 3's failure mode cannot recur here: there is no code
  path that re-reads an absent cast and merges against an empty base.
- **Fail safe to today's behaviour.** The transform is *total* — an unrecognised
  shape returns its input unchanged — and is additionally wrapped so a throw
  logs and writes the untransformed payload. The re-apply is strictly an
  improvement layer; its failure never makes a run worse, or louder, than the
  detector #2185 already shipped.
- **Field-level only.** A foreign-*added* character is not rescued. Recorded as
  a residual in §9 rather than left implicit: §3.3's invariant would arguably
  permit rescuing an added *voiced* row, since `mergeCore` already carries
  voiced rows forward, and the decision to stay field-level was the repo
  owner's.

## 5. What does not change

Stated explicitly because the value of this design is how little it moves:

- No new lock, no new lock class, no change to `design → library-voice → cast`.
- No new SSE `kind`. The advisory keeps `code: 'cast_merge_base_stale'`, so
  dedupe, `trackForReplay`, both readers, the UI consumer and the mock are all
  untouched — none of the 2026-08-06 spec §4's six-item delivery list re-opens.
- `mergeAnalysisResultWithExistingCast` and `overlayInterimCastForLiveView` are
  not modified and not re-run.
- The three fingerprint states and `UNREADABLE`'s semantics are unchanged.
- `readPriorCastForMerge`'s capture, its lock, and its two-file fallback are
  unchanged.

## 6. The advisory's text stops being true

The shipped message says the foreign change "may have been overwritten". After a
successful re-apply that is wrong, and leaving it would train the user to
distrust a message that is now reporting a *repair*.

The `code` is unchanged (§5). What moves:

1. the shared message constant in `analysis.ts` (hoisted, so both job bodies
   already share one copy — verified);
2. its two frontend fixtures (`src/lib/api-cast-merge-base-warning.test.ts`,
   `src/views/analysing.test.tsx`);
3. `openapi.yaml`'s description prose for the warning, which describes behaviour
   that is changing — and therefore a regeneration of `src/lib/api-types.ts`
   (`npm run openapi:types`). **This makes the PR not docs-only.**

A conflict in which *every* entry was dropped or nothing was rescued keeps
wording equivalent to today's, because in that case nothing was repaired. The
message must distinguish the two outcomes rather than claim a repair that did
not happen.

## 7. Testing

The 2026-08-06 spec's testing rules carry over in full and are not restated
except where this design adds to them: mutation-verified against the primitive
the site actually calls, `--retry=0`, multi-chapter and Start-fresh runs both
mandatory, outcomes asserted rather than mechanisms.

Added here:

- **The negative control remains the most important test.** An uncontended,
  multi-chapter, Start-fresh run emits zero advisories **and** the transform is
  provably the identity — asserted on the written bytes, not on a spy.
- **The B4 shape, end to end:** a contended run rescues the alias. This is the
  regression test for the loss #2015 was filed for.
- **The approach-B failure, explicitly:** a conflict detected at an *interim*
  site must still be present after the *authoritative* write. Without this test,
  §1.1's blinding ships green through every other test listed here — it is the
  direct analogue of the 2026-08-06 review's "fatal by omission" finding.
- **ABSENT base rescues nothing**, while still emitting the advisory.
- **An unresolvable foreign id is dropped *and counted***, with the count
  reaching the log — asserted on the count, not merely on the absence of a
  crash.
- **The allowlist is consumed by reference:** a test that fails if the re-apply
  hardcodes a parallel copy of `PRESERVED_VOICE_FIELDS`. §3.2's drift-immunity
  claim is otherwise unenforced prose.
- **Idempotency:** applying an accumulated ledger twice equals applying it once.
  §4.2's "later sites re-apply idempotently" depends on it.
- **srv-13's voice/reuse carry-forward provably unchanged**, carried forward
  from #2015's own acceptance criteria.

## 8. Frequency is still unmeasured, and this ships an instrument

The repo owner has not observed `cast_merge_base_stale` fire on a real book
since #2185 merged, and has not checked. The 2026-08-06 spec's bet — that
frequency data should decide whether the rebuild is worth its risk — is
therefore still open.

This design does not gate on it, on the grounds that B4 established the *loss*
is real and destructive, and that this mechanism's cost is bounded: no new lock,
no merge change, identity transform on the common path.

Instead it ships the instrument. The ledger yields a per-run count of conflicts
observed, entries re-applied and entries dropped, at zero extra cost. That count
is what an on-box acceptance row should record on a real book — see §10.

## 9. Residual risks, accepted

- **A foreign-added character is not rescued** (§4.5). Field-level was chosen
  deliberately; §3.3's invariant would arguably permit rescuing an added
  *voiced* row.
- **A foreign edit to an analyzer-owned field is still lost**, by design —
  `name` and `tier` above. This is the invariant working, not a gap.
- **An `UNREADABLE` read still suppresses the comparison**, so a conflict during
  an I/O blip is missed and the foreign write is clobbered exactly as today.
  Unchanged from #2185, and its reasoning there still holds.
- **The window is not narrowed.** This design repairs a detected collision; it
  does not make the read→write window shorter. #2015's premise — that the window
  is an entire analysis run — is unchanged.
- **In-process only**, inherited from the whole cast-lock design.

## 10. Shipping

`Closes #2015`. One PR.

Owed on merge: an on-box acceptance register row for the real-book run — the
instrument in §8 against a real analyzer and a real concurrent cast edit,
recording conflicts observed / re-applied / dropped. Per CLAUDE.md this
converts into a row rather than blocking the merge, but the row, the run sheet
and the live view all move in the shipping PR.
