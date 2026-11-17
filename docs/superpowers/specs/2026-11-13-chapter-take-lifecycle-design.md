---
status: draft
revision: 11, final (the owner's binding decisions E16 to E18 folded, 2026-11-17, with the owner's approval to merge with no further check; revision 10 folded assumption-checker pass 9 on PR #4189 around E13 to E15; revision 9 folded pass 8 around E11 and E12; revision 8 folded pass 7 around E9 and E10; revision 7 folded pass 6 around E8; revision 6 folded pass 5 around E7; revision 5 folded pass 4 around E5-E6; revision 4 folded pass 3 around E1-E4; revision 3 folded passes A and 1 around D1-D4; revision 2 folded the manual check F1-F24, V2-V4, D)
issue: 3456
refs: [3400, 3397, 3457, 3518, 3524, 3704, 3711, 3717, 3774, 4166, 4167, 4195, 4204, 4205, 4206, 4211, 4220, 4223, 4224, 4227, 4230, 4233, 4234, 4235, 4236]
verified-at: 02059252 (since deb3fafa, #4208, #4184, #4245 and #4240 merged. Of the files this spec cites with a line anchor only server/src/gpu/evict-idle-tts.ts changed, by #4208, at :207 onward; its cited `keepForRunStart` at :141-150 did not move. #4240 changed server/src/routes/qwen-voice.ts, which is cited by name only. #4184 is docs only. No anchor moved. At deb3fafa, #4205 had moved server/src/routes/book-state.ts by +4 lines after :1124 and +12 after :1299. The changelogs and earlier decision lists keep the anchors they were written against)
decisions: OD1-OD8 accepted by the owner 2026-11-14; D1-D4, E1-E4 and E5-E6 binding 2026-11-15; E7 and E8 binding 2026-11-16; E9 to E18 binding 2026-11-17 (E11 and E12 restate the reach of E9 and E10; E13, E14 and E15 restate the reach of E11, E12 and R9-1; E16 confirms E15's tie rule); revision 9's decisions and R9-7 confirmed by the owner 2026-11-17; revision 10 accepted by the owner as a whole 2026-11-17, apart from what E17 and E18 add, so its decisions and the items under "Decisions made in revision 3" to "Decisions made in revision 8" are confirmed; revision 11's choices sit inside E16 to E18 and are covered by the owner's approval to merge it with no further check. Nothing is owed owner confirmation
---

# Chapter take lifecycle: who owns a chapter's live and `.previous` audio (#3456)

## Revision 11 changelog

This is the final revision. On 2026-11-17 the owner accepted revision 10 as a whole, apart from two
gaps that pass 9 listed as not folded. The owner decided those gaps as E16 to E18 (binding, quoted
under "Owner decisions") and approved merging this revision with no further check. So this revision
adds no open question, and every choice it makes sits inside E16 to E18 (R11-1 to R11-4, below).
Every anchor was re-checked against `origin/main` (`02059252`). Since `deb3fafa`:
- **#4208** (merged, #4102) changes `gpu/evict-idle-tts.ts` from `:207` onward. The anchor this spec
  cites there, `keepForRunStart` at `:141-150`, did not move.
- **#4240** (merged, #4238) changes `routes/qwen-voice.ts`, which this spec cites by name only.
- **#4245** (merged) changes a server test only. **#4184** (merged) is a docs spec.

No cited anchor moved.

| Item | Resolution in revision 11 |
|---|---|
| **E16 (owner): E15's tie rule** | Confirmed. Two different equal-size copies that nothing tells apart are both quarantined, and the part is recorded in `lost`. The take is incomplete, never mixed, and the slug is not blocked. Revision 10's other choices are confirmed too: the identical-copy rule, the name `take-fields.ts`, skipping a book's whole heal when one of its journals cannot be read or parsed, and step 8 stopping at the first failed unlink. All of them move from "Decisions made in revision 10" to "Owner decisions". Because revision 10 was accepted as a whole, the lists under "Decisions made in revision 3" to "Decisions made in revision 8" are confirmed too |
| **E17 (owner): the excluded-chapter gap** (pass 9's not-folded gap) | A render's chapter-start span re-reads `excluded` after its journal replay and inside the same span. If replay has now set `excluded: true` (a drop journal rolled forward, E12, E18), the chapter is skipped before anything is staged. It writes no take and no state. It sends no per-chapter frame, which is what the existing excluded-chapter skip sends (`generation.ts:1143-1149`, `:1287-1288`, `:1308-1311`), and it is never a failure. This is the in-lock re-check, and the caller's filter stays as it is. A test case is added, with the mutation "drop the post-replay re-check" (§4.1, §5.A Exclude, Tests, §7 Phase 4 step 1, where drop journals land) |
| **E18 (owner): Accept and drop journals' replay direction** (pass 9's not-folded gap, pre-existing) | Both get the rule that commit and `replace` journals already follow: before `installed` a journal rolls back, and at or after `installed` it rolls forward to completion. The rule is stated in the Journal rules' replay list, with each journal's phases in its own section. It was checked against E12, E14 and the drop journal's `.orphaned/<iso-date>-<jid>/` target. It applies to all three once R11-1 to R11-3 are in place. Test cases are added (§5.A Journal rules, Accept, Exclude, Tests, §7 Phases 3 and 4) |
| Pass 9's other not-folded notes: the gate's fail-closed test hook, and R9-2's per-part re-probe cost | Moved to the new §7.1, **Implementation notes (plan-level, not design-level)**. The hook needs no new export: the test stubs the leaf gate's own unregistered answers. The re-probe costs at most `RENAME_RETRY_WORST_CASE_MS` (about 3.6 s) per step, and only for a part that is absent at its first probe. Neither is a design question |
| Housekeeping | "Remaining", §8.3 and §8.4 are restated so that each holds only accepted residuals, pre-existing gaps with their own ticket, or on-box acceptance, and no open question of this design. §8.1 gains E16 to E18. `verified-at` is refreshed |

## Choices made in revision 11 (inside E16 to E18; covered by the owner's approval to merge)

- **R11-1 (where `installed` sits for Accept and drop).** Neither journal installs anything, so
  `installed` is the phase each one journals once every move has landed. That is the point where
  the spec already says a journal is "past its moves" (E12). Before it, replay undoes the moves. At
  or after it, replay runs the remaining record steps.
- **R11-2 (the drop target's date).** A drop journal records its event folder's name,
  `<iso-date>-<jid>`, when it is written. A rollback on a later day moves the only-copy part back
  from that recorded folder and never recomputes the date.
- **R11-3 (no collision in a drop's event folder).** When replay quarantines a foreign copy for a
  drop journal, the copy goes to that event folder's `foreign/` subfolder. So it can never take
  the name of the only-copy part the drop itself moved into the folder, which a rollback still has
  to move back. This is the nearest rule that keeps E18 as stated, never overwrites (OD8), and
  never leaves a mixed or half-excluded chapter.
- **R11-4 (where E17's re-check sits).** The re-check runs after `reconcileBook` and
  `reconcileSlug` and before `ensureTakeIdentity`, so a skipped chapter gets no mint either. It
  runs at chapter start only. A commit's step 0 cannot meet a new drop journal, because exclude is
  refused while the render is registered (#3774, `book-state.ts:2350-2359`). Any drop journal that
  existed before then was settled at chapter start: rolled back, rolled forward and skipped by E17,
  or the chapter ended after its record-step budget.

## Revision 10 changelog

Kept for history. Where revision 11 changed a resolution (the "Not folded" row below, and the
"owner to confirm" status of revision 10's decisions), the revision 11 changelog above wins.

`assumption-checker` pass 9 ran on revision 9 at head `f74c69fd` (PR #4189 comment "Assumption-checker
pass 9"). It cleared the gate: 0 Critical, 0 Significant and 7 Minors (L1–L7), plus non-gate notes.
Three Minors carried an owner question. The owner answered all three on 2026-11-17 as E13, E14 and
E15 (binding, quoted under "Owner decisions"), confirmed revision 9's decisions and R9-7, and
approved this revision as the design of record without a further pass. The other Minors needed no
decision, and this revision settles them (R10-1 to R10-4). Every anchor was re-checked against
`origin/main` (`deb3fafa`). Since `08742125`:
- **#4205** (merged, #4098) refuses a manuscript save while an analysis runs. It moves
  `routes/book-state.ts` by +4 lines after `:1124` and by +12 after `:1299`, re-anchored in §1
  onward. GET `/state`'s title refresh and uuid mint (`:457-485`) are unchanged.
- **#4214** (merged, #4163) touches the sidecar only.

| Finding (pass 9) | Resolution in revision 10 |
|---|---|
| **L1 → E13 (owner).** E11's epoch counts registrations only, so a render, splice or QA repair already running when the pass starts, which deregisters in a gap before the reconcile, was missed. That is the usual shape for another book's render | **E13.** The re-check also samples `isAnyGenerationActive()` when the pass starts, in the same synchronous read that takes the epoch. The pass skips its cleanup if either sample (at the start, or immediately before the reconcile) reads busy, or the epoch moved or is `null`. Revision 9's claims that E11 alone covered the chapter gap and another book's render are corrected. A test case is added, with the mutation "drop the start sample" (§5.A Scoring, Tests) |
| **L2 → E15 (owner).** R9-1 refused a non-segments part found at two slug names, which could freeze a mixed live take, behind R8-2's sentence naming neither the cause nor the file | **E15.** Every per-slug journal records each listed part's byte size when it lists its parts. At two slug names, a part that carries a `takeId` (segments, embeddings) is decided by it; any other part, and one its `takeId` cannot decide, by the size the journal recorded for the take the step moves. Two copies of that size are compared byte for byte, and identical copies are either one right. Two different copies that nothing decides are **both** quarantined, and the part is recorded in `lost`: the take is incomplete in that part, never mixed, and the slug is not blocked. Every per-slug step decides all of its parts before it renames any, and `promote` moves the audio first. No refusal is left for this shape, so R8-2's sentence is reached only by a rename the OS refuses, which is the cause it names (§5.A Journal rules, Reject, Remaining, Tests) |
| L3 (m): R9-1's install row and its test described a forward install that no replay performs | **R10-1.** A commit or `replace` journal before `installed` rolls back, so replay never installs forward. The "one side journal-unique" row drops install from its parenthetical, and the narrative is corrected. The install test now expects the old take live whole, the planted copy quarantined and the staged set swept. Revision 8's mutation moves to a case it does break, a discard rolled back onto a refilled slug name (§5.A Journal rules, Tests) |
| L4 (m): `check:cycles` fails, because `scan.ts` would import `chapter-take.ts`, which needs `scan.ts`'s state types and `state-migrate.ts` | **R10-2.** A second leaf, `workspace/take-fields.ts`, holds what `scan.ts` needs from the module: `TAKE_STATE_FIELDS`, `deriveTakeFields`, the heal's fill rule `healTakeFields`, the live-take predicate and the journal check. Its imports reach neither `scan.ts` nor `state-migrate.ts`. `scan.ts` imports the two leaves and never `chapter-take.ts`, which re-exports them; `persistHealPatches` keeps its locked write and applies the leaf's rule. No cycle is allowlisted (§4.3, §4.4, §5.A Ownership, Blast radius, §7 Phase 1) |
| L5 (m): "the next step 0 replays or supersedes them" did not say step 0 loops | **R10-3.** Step 0 repeats after it rolls back a superseding journal, until the slug has no journal, the journal in charge is superseded by this commit, or replay blocks or uses up its budget. So step 3 never writes a journal beside an unsuperseded one. Step 8 stops a chain's unlinks at the first failure (§5.A Commit steps 0 and 8, Journal rules) |
| L6 (m): R9-4's time match had no defined right-hand side for a legacy take with no `synthesizedAt` | **R10-4.** The match needs the entry's `previousRenderedAt` and the live segments' `synthesizedAt` both present, and equal. `synthesizedAt` is optional (`audio/segments-io.ts:70`). Two takes never share one, because finalize stamps it fresh on every write (`finalize-chapter-write.ts:686`). The residual (an id-less previous take whose segments carry no `synthesizedAt` gets no H17 retry) is listed under Remaining (§5.A Accept, Retry recognition, Remaining, Tests) |
| **L7 → E14 (owner).** E12's list left bundle `replace` journals off, and R9-7 refused an import over a carried drop journal whose owed `excluded` write the swap makes moot | **E14.** A `replace` journal past `installed` joins E12's supersedable list. A bundle `replace` may also supersede a carried drop journal stuck on record steps, rather than refuse the import. A carried Accept journal, and any other carried journal stuck on record steps, still refuses. R9-7 is restated (§4.1, §5.A Ownership, Commit step 0, Retries, State-write sites, Tests, §7 Phase 2 step 5) |
| Gap: the journal-unique kind omitted drop's jid-tagged `.orphaned/<iso-date>-<jid>/` target | Added to the kind (§5.A Journal rules) |
| Gap: "whenever anything synthesises anywhere" overstated E11 | Restated as "any render, splice or QA repair". Voice samples, voice-style, cast and single design, the `qwen-voice` routes and another book's scoring auditions are invisible to the gate, as on `main` (§5.A Scoring, Remaining) |
| Housekeeping | "Decisions made in revision 9" and R9-7 move under "Owner decisions", confirmed. `book-state.ts` is re-anchored and `verified-at` refreshed |
| Not folded (pass 9's other gaps and notes) | Accept and drop journals still have no stated replay direction (pre-existing). E12 lets a drop journal's replay succeed on a later chapter-start attempt and set `excluded: true`, and the span is not said to re-check `excluded` afterwards. The fail-closed test hook for the gate, and R9-2's per-part re-probe cost, are not named. None is in L1–L7 |
| Questions 1–3 | Q1 answered by E13, Q2 by E14, Q3 by E15 (§8.1) |

## Decisions made in revision 10 (confirmed by the owner 2026-11-17, E16)

Confirmed by E16 and now listed under "Owner decisions", with their reasons.

## Revision 9 changelog

Kept for history. Where revision 10 changed a resolution (E11's single sample, E12's list and R9-7,
R9-1's two-slug-name refusal and its install row, R9-6's "no cycle", the unstated step-0 loop and
R9-4's time match), the revision 10 changelog above wins.

`assumption-checker` pass 8 ran on revision 8 at head `498e9846` (PR #4189 comment "Assumption-checker
pass 8"). It cleared the gate: 0 Critical, 0 Significant and 10 Minors (K1–K10), plus non-gate
notes. Two Minors carried an owner question. The owner answered both on 2026-11-17 as E11 and E12
(binding, quoted under "Owner decisions"). The rest needed no decision, and this revision settles
them (R9-1 to R9-9). Every anchor was re-checked against `origin/main` (`08742125`). Since
`33f3647c`:
- **#4234** (merged, #4233) curates the splice and QA-repair SSE frames, scrubs ffmpeg messages
  through `ffmpegFailure` (`tts/ffmpeg-failure.ts`), and gives `classifyFailure` its fs handling.
  That is all of R7-5's widened scope, so R7-5 is **done on `main`**. Phase 2 step 4 no longer lands
  any of it; it only keeps the new frames on the curated path. It moves `chapter-splice.ts`,
  `chapter-qa-repair.ts`, `tts/mp3.ts` and `failure-taxonomy.ts`, re-anchored in §1 onward.

| Finding (pass 8) | Resolution in revision 9 |
|---|---|
| **Q1 / K3 / K4 → E11 (owner).** E9's per-book sample of `inFlightByBook` is empty between a queue render's chapters (K3), and cannot see another book's render on the same sidecar (K4) | **E11.** Resume's re-check uses the process-wide `isAnyGenerationActive()` (`gpu/active-generation-gate.ts:139-142`), the repo's documented eviction-safety predicate, which already folds in the splice/QA-repair registry's count, plus that registry's and generation's registration epoch (`readSpliceEpoch`, `:128-131`), read when the pass starts and compared just before the reconcile. A render chapter, splice or QA repair that registered at any point during the pass moves the epoch even when it has deregistered by the reconcile, which is the chapter gap (K3). Another book's render is seen (K4). The cost: Resume skips the cleanup whenever anything synthesises anywhere, and stray tiers wait for the next render's reconcile. R8-8's `hasInFlightSpliceForBook` and `isBookSynthesising` are withdrawn, and `chapter-job-coordination.ts` leaves the blast radius again. §5.A Scoring's "no per-book reader of `chapter-job-coordination.ts`" sentence is rewritten. E9 and E11 are restated together, and the test gains the gap and other-book cases (§5.A Scoring, Tests) |
| **Q2 / K6 → E12 (owner).** Step 0's supersedable list, §4.1's list and `:1533` disagreed, and drop's owed `excluded` write is not dominated by a commit | **E12.** A new render may supersede **a commit journal past `installed`, a restore journal or a promotion journal** (both past their moves, at `stamp` or later), and nothing else. Drop and Accept journals keep block-and-retry: the record-step budget, then the chapter ends. Step 0, the chapter-start list, Retries cause 3, the State-write sites row and the old `:1533` sentence now all cite one list (§4.1, §5.A Commit step 0) |
| K1 (m, the revision 8 regression): R8-1's "both present" row quarantined the source copy, which at install is the new render's staged part | **R9-1.** The row is defined **by name kind**. A journal-unique name (`.next-<takeId>`, `.discard-<jid>`) is never foreign. When one side is journal-unique, the copy at the slug name is the foreign one: quarantine it, then rename (or count the part done when the journal-unique side is the target). When both sides are slug names (preserve, promote, and rollbacks between live and previous), a segments part is decided by its `takeId` against the journal's ids; any other part found at both slug names is a move-step failure, revision 7's fail-closed refusal with R8-2's sentence. No path produces a mixed take. Test added (§5.A Journal rules, Tests) |
| K2 (m): "lost" was decided from one probe, inside OneDrive's documented transient-`ENOENT` window | **R9-2.** A part is recorded as lost only when it is absent under both names at every probe across `RENAME_RETRY_DELAYS_MS`' schedule (`atomic-rename.ts:22`, about 1.8 s base). The `ENOENT` re-probe uses the same schedule. That applies to the relabel journal's `lost` rows too. Row Q gains an OneDrive scan cell (§5.A Journal rules, §7 Phase 4) |
| K5 (m): supersession was one level deep, so a chain of three journals unlinked a journal that still named another | **R9-3.** Supersession **absorbs transitively**: `supersedes` is a list. A commit that supersedes a journal which itself supersedes others absorbs the whole chain, and step 8 unlinks it oldest first, so no journal is ever unlinked while it names one that is present. Replay reads **every** journal of a slug before it acts on any, and one unreadable journal stops the slug's replay as a record-step failure, acting on none (§5.A Commit step 3, step 8, Journal rules) |
| K7 (m): after R8-2's failed mint, the entry has no `previousTakeId`, and H17's Reject retry then answered `revision_gone` | **R9-4.** When an entry's `previousTakeId` is `null`, the Accept and Reject tables' "A" row matches a live take whose segments' `synthesizedAt` equals the entry's `previousRenderedAt`. No write is added (§5.A Retry recognition) |
| K8 (m): "only the scan heal runs while restructure releases `book`" missed GET `/state`'s title refresh and uuid mint | **R9-5.** Named. Both run under `book` without book-op (`book-state.ts:457-485`). The refresh rewrites `title` and `titleSynthesized`, and a slug is built from the id and title (`restructure.ts:126-128`), so the slug plan's inputs now list titles. The closure's re-check catches a refresh: the restructure answers its fixed 500 before it writes, and the retry re-plans. The uuid mint writes nothing the plan reads (§5.A Restructure) |
| K9 (m): no module was named for `canonicalDirKey` and the unaddressed set | **R9-6.** A new leaf, `workspace/book-dir-key.ts`, that imports nothing from `server/src` (only `node:path`), as `book-lock.ts` and the gate are leaves. `scan.ts`, `book-state-update.ts`, `chapter-take.ts` and `scan-import-folder.ts` import it, so `check:cycles` gains no cycle (§4.4, §5.A Ownership) |
| K10 (m): "no carried journal outlives the swap" contradicted R8-5's own record-step branch and its test | **R9-7.** The claim and the test are limited to a carried journal whose replay completes. One on E12's list stuck on record steps outlives the swap until `replace` supersedes it; any other carried journal stuck on record steps refuses the import with the curated 500. R8-5's "move steps have all landed" becomes E12's list (§5.A Ownership, Tests) |
| Note: R8-2's sentence said "this chapter's" but book-wide operations answer it too | **R9-8.** A book-wide variant, "Some of this book's audio files…", for backup restore, the bundle overwrite, the PUT and a new restructure (§5.A Ownership) |
| Note: J6's 28,800 | **R9-9.** Stated as an upper bound: it counts a fully rendered book scored again. From scratch, pass *k* sees about *k* chapters, so about 14,600 (§5.A Span length) |
| Note: #4234 moved, then merged | R7-5 is restated as done on `main` (above). Phase 2 step 4, Remaining, Tests, §7 and the blast radius drop the conditional |
| Note: #4235's acceptance criteria | Phase 2 step 4's PR restates #4235's criteria: E11 runs the pass and skips only its cleanup, rather than refusing Resume (§7 Phase 2 step 4) |
| Note: the bundle decodes under the claim | Pre-existing, not from revision 8, and unchanged: `replace` decodes an unindexed bundle take under the workspace-wide claim. Listed under Remaining |
| Questions 1–3 | Q1 answered by E11, Q2 by E12, Q3 by R9-1 and R9-3 (§8.1) |

Revision 9's decisions, and R9-7, are confirmed by the owner and now sit under "Owner decisions"
(revision 10).

## Revision 8 changelog

Kept for history. Where revision 9 changed a resolution (E9's per-book check and R8-8's query,
R8-1's "both present" row and single probe, E10's one-level `supersedes` and its list, R8-2's
mint-failure side effect and its one sentence, R8-3's gap claim, R8-4's unnamed module, R8-5's
claim and criteria, and J6's figure), the revision 9 changelog above wins.

`assumption-checker` pass 7 ran on revision 7 at head `73e37a24` (PR #4189 comment "Assumption-checker
pass 7"). It cleared the gate: 0 Critical, 0 Significant and 13 Minors (J1–J13), plus non-gate
notes. Two Minors carried an owner question. The owner answered both on 2026-11-17 as E9 and E10
(binding, quoted under "Owner decisions"). The rest needed no decision, and this revision settles
them (R8-1 to R8-9). Every anchor was re-checked against `origin/main` (`33f3647c`). Since `dbc30a2a`:
- **#4224** (merged, #4223) snapshots each chapter's audio into staging before the m4b probes it. It
  moves `export/build-m4b.ts` (the snapshot at `:83-93`, the probe at `:100-104`, the concat list at
  `:120`, the ffmpeg spawn at `:374`) and `export/build-mp3-zip.ts` (`:257` → `:275`). It rewrote the
  restructure comment at `chapters-restructure.ts:607-609` to cite `book-state.ts:660-675`, and that
  comment's claim is still false (J13).
- **PR #4234** (open, head `d0d78c12`) fixes #4233, the splice and QA-repair SSE leak that R7-5
  described. #4236 tracks the other routes that echo a raw `err.message`.
- **#4235** (open) is the resume pass reconciling beside a running splice or QA repair. E9 closes it.

| Finding (pass 7) | Resolution in revision 8 |
|---|---|
| **Q1 → E9 (owner).** E8's "starts at once" was read as "not queued behind another pass", checked when Resume is clicked. A render can register after the click and before the pass starts (J5), and during its minutes of auditions | **E9.** Immediately before a Resume pass reconciles, it re-checks that no render, splice or QA repair of the book is running, and skips the cleanup if one is. The check is synchronous, with no await between it and the call. That closes the click-to-start window and the audition window, and it **closes #4235**: a resume beside a running splice or QA repair no longer evicts its tier. The per-book query is new: `hasInFlightSpliceForBook(bookId)` in `routes/chapter-job-coordination.ts`, which owns the registry both splice and QA repair register in, composed with `isGenerationActive` in `routes/generation.ts`. Nothing under `server/src/gpu/` reads it, so CLAUDE.md's leaf-gate rule is kept without a new gate. E8 and E9 are restated together (§5.A Scoring) |
| **Q2 / J3 → E10 (owner).** Revision 7 ended a render at commit step 0, and discarded it, when a leftover journal past `installed` failed persistently on record steps only. Yet it commits the take, and fails loud, when the commit's own step-7 stamp fails on the same file | **E10.** A leftover per-slug journal whose move steps have all landed, and whose replay fails on record steps only, is **superseded** by the new commit. The new commit's journal names it (`supersedes`), absorbs its discard set and its owed entry drop, and installs its own take. If its own record step then fails, it fails loud at step 7 (R7-4's `take_details_pending`). The user keeps the render. "One journal per slug" becomes "at most one unsuperseded journal per slug" (§5.A Commit step 0, Journal rules) |
| J1 (m): a per-slug journal has no "absent under both names" row, so an externally deleted part blocks the chapter for good | **R8-1.** Every per-slug journal gains R5-1's fourth row: a part absent under both names is recorded in the journal's `lost`, logged, and replay continues. A rename that throws `ENOENT` re-probes both names once and takes the matching row, so `renameWithRetry`'s `ENOENT` retry can no longer turn a missing file into a blocked slug. An incomplete take is unrendered or unindexed (§4.2), as for a relabel (§5.A Journal rules) |
| J2 (m): retry/fail-fast inside the record class was still decided by `code`; EACCES was classed both ways, persistent EPERM ran to the watchdog, unlisted codes had no class, `ensureTakeIdentity`'s stamp was classed twice | **R8-2.** No class is decided by `code` any more. The **step** decides block/don't-block (R7-4, unchanged) and the **retry budget**: a move step retries inside `renameWithRetry`, as today; a record step gets three attempts of its own (once in the span, then twice between spans after 1 s and 2 s, R4-10's shape), never the 720 s watchdog. `code` chooses only the **sentence**. A move step has one sentence for every code. A record step's sentence is `requestFailureMessageFs`', and unlisted codes take its default. `ensureTakeIdentity` has one class: its `state.json` mirror is swallowed; its mint write into the take's own files fails a partial job's base read and is logged, without stopping, by a full render, which carries no base (§4.1, §5.A Ownership, Commit step 0, Retries) |
| J3 (m): the step-0 loss claim was overstated for ENOSPC and EROFS | Restated under E10 (§5.A Commit step 0). `main` loses the render too under ENOSPC (its lufs write at `:296` precedes the audio rename at `:777`) and under EROFS. What is left is narrower: a journal E10 cannot supersede, or the commit's own journal write, failing three times |
| J4 (m): the E7/E8 test counted calls to a function a real render's run-start reconcile also calls | The test now counts calls at the scoring pass's own call site: `triggerScoring` takes the post-audition reconcile through an injected seam, and only that seam's calls are counted. The running render, splice and QA repair are stubs that register and set residency, with no chapter POST, so no run-start reconcile runs in the harness. Cases for E9 are added (§5.A Tests) |
| J5 (m): "starts at once" was undecidable across the pending hand-off; "no render is running when it starts" was false | "Starts at once" is `triggerScoring`'s synchronous `scoringInFlight` check, with no await before it. The finished pass's `.finally` sets the in-flight marker for the oldest pending entry in the same synchronous callback that clears its own. The queued pass's re-read of chapters and its `uuid` → slug mapping (R7-12) run inside its own `runBookJob` body, from its lease. The false sentence is replaced by E9 (§5.A Scoring) |
| J6 (m): R7-8's recount left out the design's own per-character CAS reads | Counted: about 28,800 CAS reads for the 60-chapter example (about 8 speakers a chapter), so about 39,600 segments reads against `main`'s 14,400, counting scoring's phase-1 reads on both sides. The CAS parses the whole file (R8-9). The inaccurate "only the job's own stamps write take fields" is corrected (§5.A Span length) |
| J7 (m): R7-3's slug plan reads `audioRenderedAt`, which step 0 can write, so the assertion can fire and a promoted take stays behind | **R8-7.** `buildAudioOps`' presence test is an **OR**: a chapter is in the plan when it has `audioRenderedAt` **or** a take on disk (live by §4.2's predicate, or a previous take). Each step-0 write keeps that OR true for every chapter it was true for, so the plan is invariant under step 0 and a promoted take moves with its chapter. The plan's inputs are stated truthfully, and the closure's assertion stays as a tripwire (§5.A Restructure) |
| J8 (m): R7-7's "the decode never runs while `book` is held" was false for restructure step 0 and `reconcileBookTakes` | **R8-3.** The design is fixed, not the claim. Every entry point's step 0 runs before its caller takes `book`. Restructure reads its slug plan under `book`, releases it, runs step 0 under book-op → gate, and takes `book` again for the closure, which re-checks the plan. `restoreBackup` releases `book` after its swap, and `reconcileBookTakes` runs after it. `reconcileBookTakes` no longer decodes every unindexed chapter: it carries the pre-restore `duration` of a chapter the pre-restore state matches, and decodes only the rest. `dropAllTakes`' step 0 skips the multi-live decode, because exclude discards every live file. The test asserts the claim on all three paths (§4.4, §5.A Ownership, Restructure, Tests) |
| J9 (m): the heal's `book` key did not exclude the two unaddressed callers | **R8-4.** A `book` key taken from a directory always goes through `canonicalDirKey` (the heal at `scan.ts:811,1347`, `updateStateAtDir` at `book-state-update.ts:72`). An unaddressed handle takes `book` under its canonical directory key for its whole life, even after the bundle's swap mints an id. The heal checks the unaddressed set after it takes `book`, and skips a book in it (§4.4, §5.A Ownership) |
| J10 (m): a crash between the bundle swap and `replaceTakesFromBundle` replayed a local journal against the bundle's state | **R8-5.** The carried slugs' per-slug journals are replayed **before the claim** too, without lazy migration (renames and a stamp). A move-step failure refuses the import with `take_repair_pending`. A carried journal stuck on record steps only is superseded by the replace journal, as E10 lets a commit supersede one. The R7-10 discard after the swap is withdrawn (§5.A Ownership) |
| J11 (m): no rule for a chapter with no `uuid` | **R8-6.** A pending entry records a chapter by `uuid` when it has one, else by `id` and `slug` together (`sameChapter`'s match). At start, a chapter that matches neither is skipped and logged (§5.A Scoring) |
| J12 (m): R7-9's sentence over-promised and had no variant for other codes | One sentence for every code (R8-2), naming only what replays: "…Castwright finishes the move the next time one of these chapters is rendered or its take is changed, or when it restarts." (§5.A Restructure) |
| J13 (m): #4224 merged; anchors moved; Phase 4's correction of the restructure comment was conditional | `verified-at`, OD7, R-f, §5.A Readers and Remaining, §7 and Phase 4 step 1 now say #4224 is merged, with the new anchors. The m4b builder leaves the ffmpeg-holder list. Phase 4 corrects the comment's claim unconditionally: the filter at `book-state.ts:660-675` drops edits by sentence-id range and does not recover a renumbering |
| Note: R7-5's scope and heading | R7-5 now cites #4233 and PR #4234 and is widened to #4234's scope: the ffmpeg stderr scrub (`ffmpegFailure` in `tts/ffmpeg-failure.ts`), `classifyFailure`'s fs fallback, and its fs-before-signature-scan pre-check (`isFsPathError`). Phase 2 step 4 lands that scope only if #4234 has not merged. The heading no longer claims more than the fix does (§5.A Failure handling) |
| Note: #4235 | Cited, and closed by E9 (§5.A Scoring, Remaining, §7 Phase 2 step 4) |
| Note: R7-6's wording | The field list cannot live on `sameChapter`, a two-argument predicate, and `carryServerOwnedChapterFields` would strip the placeholder `duration`. The persist uses a new sibling in `chapter-uuid.ts`, `carryTakeStateFields`, which matches through `sameChapter`, copies the `TAKE_STATE_FIELDS` members the matched disk chapter has, and strips nothing (§4.3) |
| Note: R7-4's anchor | `RETRYABLE_CODES` is `atomic-rename.ts:41-47`: EPERM, EBUSY, ENOENT, EACCES and EIO |
| Questions 1–3 | Q1 answered by E9, Q2 by E10, Q3 by R8-1 and R8-2 (§8.1) |

## Decisions made in revision 8 (confirmed by the owner 2026-11-17, with revision 10 as a whole)

E9 and E10 left these open. Pass 7 gave each one's shape. Each item takes the narrowest option
that is safe.

- **R8-1 (lost parts in per-slug journals).** See the J1 row. The per-slug journals gain `lost`.
- **R8-2 (one retry rule per step).** See the J2 row. The move-step sentence is now one sentence for
  every code: "Some of this chapter's audio files could not be moved into place. Close any other
  program using the book's folder, and check free disk space and the folder's permissions, then
  try again." That replaces R7-4's two sentences.
- **R8-3 (decodes outside `book`).** See the J8 row. Carrying the pre-restore `duration` is the
  choice here: a backup restore changes no audio, so the pre-restore state described the audio on
  disk, and it is never worse than what the user had before restoring.
- **R8-4 (the `book` key for a directory).** See the J9 row.
- **R8-5 (carried journals replay before the claim).** See the J10 row.
- **R8-6 (chapters without a `uuid`).** See the J11 row. Minting a `uuid` first was the other option.
  It was not taken, because the mint is a swallowed lazy migration and can fail.
- **R8-7 (`buildAudioOps`' OR).** See the J7 row.
- **R8-8 (where E9's query lives).** See the E9 row. #4235 proposed refusing Resume while a splice
  or QA repair runs. E9 runs the pass and skips only its cleanup, so the auditions still happen, as
  E5 accepts beside synthesis.
- **R8-9 (the CAS reads the whole segments file).** See the J6 row. A bounded head read would depend
  on `takeId` being the file's first key, which a legacy file rewritten by `ensureTakeIdentity` does
  not guarantee.

## Revision 7 changelog

Kept for history. Where revision 8 changed a resolution (R7-4's code-based retry split and its two
sentences, R7-3's slug-plan inputs, R7-7's decode placement, R7-1's `book` key for unaddressed
handles, R7-9's sentence, R7-10's discard timing, R7-12's chapters without a `uuid`, the step-0 cost,
and the E7/E8 test), the revision 8 changelog above wins.

`assumption-checker` pass 6 ran on revision 6 at head `25e8ff80` (PR #4189 comment "Assumption-checker
pass 6"). It returned 0 Critical, 1 Significant (G1) and 10 Minors (G2–G11), plus five
contradictions/gaps and three questions. The owner answered the first half of the first question
on 2026-11-16 as E8 (binding, quoted under "Owner decisions"). Pass 6 said revision 7 could settle
everything else, which this revision does (R7-1 to R7-13). Every anchor was re-checked against
`origin/main` (`dbc30a2a`). Since `25c65c0a`:
- **#4216** (merged, #4054) moves `server/src/index.ts` by +4 lines after about `:200` (G11).
- **#4221** (merged, #4219) touches no file this spec cites.
- **#4224** is still open.
- **#4230** is filed: the re-analysis retitle gap that §8.3 said was owed a ticket.

| Finding (pass 6) | Resolution in revision 7 |
|---|---|
| **G1 (S): R6-1's queued passes reconcile.** On `main` a trigger that finds a pass in flight is dropped, so it never reconciles. R6-1 queues it, and the queued pass reconciled against a target captured earlier: a render trigger's `keep` from a render that may have ended, or a resume trigger's `usedQwenTiers`. A Quality re-render started while it waited was evicted | **E8.** A scoring pass runs the post-audition `reconcileResidentQwenTiers` **only when it starts at once**, that is, when no pass of the book is in flight as its trigger arrives. **A pass started from the pending list never reconciles**, whatever its triggers, because the tier set it captured may be stale by the time it runs. That is `main` parity: `main` drops those triggers. Restated together (§5.A Scoring): a render's own pass that starts at once reconciles against its `ctx.keep`, as on `main`; a resume pass that starts at once reconciles against `scoreBook`'s `usedQwenTiers`, as on `main` (the route refuses resume while the book generates, `qa-report.ts:71-74`); a partial job's pass never reconciles (E7). R6-1's per-key pending list stays, because it decides each pass's audition tier; its `keep` and `reconcile` fields are dropped. "Nothing is evicted under a running render" is narrowed to what the design closes, and the pre-existing paths are listed. The test is restated so that it can fail, and its parenthetical says that no pass is running (§5.A Scoring, Tests) |
| G2 (m): R6-11's order leaves a window: a rollback unlinks the journal without `book`, and the test's pause point exists only in the mutation's order | **R7-1.** **Every journal unlink takes `book`**: commit and restore cleanup, the in-span rollback, a replay's rollback, and a relabel's `cleanup`. It is the same `book` key `persistHealPatches` takes. The heal holds `book` across its segments read and its journal check, so a rollback that finishes during the heal waits for the heal before its journal disappears. The test now pauses the heal **between its segments read and its journal check**, a point that exists in the fixed order, while a commit rolls back (§4.4, §5.A Failure handling, Tests) |
| G3 (m): a source with no live segments can never read as "landed"; `land` has no row for "landed, temp present, target present" | **R7-2.** "Landed" no longer depends on segments. `land` records each source in the journal's `landing` list **before** it moves any part of that source, after it has quarantined every part already at the target's names. A source in `landing` owns its target names; a source not in it owns none. The table is rewritten around that, and every row is covered, including "in `landing`, temp present, target present" (quarantine the occupant, then rename). Sources with no segments (an unindexed legacy take, a legacy excluded chapter that kept `.previous.*`) land like any other. The cost is one small journal write per landing source (§5.A Restructure) |
| G4 (m): `relabelTakes`' step 0 promotes an only-previous slug before the plan is built, so `onlyCopy` is never true; drops run in two places | **R7-3.** Step 0 first builds the **slug plan** from a read under `book`. The slug plan depends only on chapter ids, slugs, `excluded` and the op, and step 0 writes none of them. Step 0 then runs `reconcileSlug` with **promotion off** for every slug the plan drops, as `dropAllTakes` does, and with promotion on for the others. `parts` and `onlyCopy` are listed **after** step 0, from disk. The closure rebuilds the plan from its fresh read and asserts that its slug plan is unchanged. Restructure drops run in `relabelTakes`' `drop` group, with `dropAllTakes`' only-copy rule; `dropAllTakes` serves exclude only. The entry-point table and Phase 4 step 1 say so (§5.A Ownership, Restructure) |
| G5 (m): R6-3's classes cannot be told apart from the error; the `book` lock has no timeout; persistent EACCES/EROFS/ENOSPC is retried for 720 s; a read error could quarantine a journal | **R7-4.** The class is decided by **the protocol step that threw**, never by `code` or `syscall`. A **move step** (a take-part rename, or a quarantine rename) blocks the slugs the journal names. A **record step** (a stamp, `dropEntry`, the review record, a journal or cursor write, a journal unlink) never blocks. A record-step failure is **transient** when it is a lock-acquisition timeout (`state-json` or `revisions`) or EBUSY/EPERM, and **persistent** when it is ENOSPC, EACCES or EROFS (`requestFailureMessageFs`' own split). Only a transient one is retryable cause 3. A persistent one fails fast, with `FS_PERMANENT_FAILURE_REQUEST_ERROR`, at the chapter-start span (before synthesis) and at commit step 0. "A `book` timeout" is removed everywhere. A **read** of a journal that fails is a transient record-step failure. Only a journal that does not parse (`SyntaxError`) or fails the journal schema is quarantined (§4.1, §5.A Ownership, Commit, Retries, Sweep) |
| G6 (m): the SSE path is not curated; the splice and QA-repair catch-alls send a raw message into `chapter_failed` | **R7-5.** Splice and QA repair's base-read span ends the job on any record-step failure, through `requestFailureMessageFs`, before anything is staged. Their catch-alls (`chapter-splice.ts:602`, `chapter-qa-repair.ts:923`) send `requestFailureMessageFs(err, (err as Error).message)` after their prefix. **This leak is live on `main` today**: a node fs error from finalize reaches the `chapter_failed` frame with the workspace path. It is reported for a separate fix. If that fix has not merged by Phase 2, Phase 2 step 4 lands it (§5.A Ownership, Failure handling) |
| G7 (m): `carryServerOwnedChapterFields` also carries the failure stamps | **R7-6.** The persist carries `TAKE_STATE_FIELDS` **only**, through the same `sameChapter` match with a field-list parameter, so the PUT keeps its current behaviour and the persist does not carry `generationState*`. A re-analysis still clears a chapter's failure stamps, as on `main`. An unmatched chapter keeps the rebuild's own values (its placeholder `duration`). The "it also keeps `duration`" reason is corrected: the heal already refills a `00:00` duration from the segments, so what `main` actually loses is `audioQa` and, once it exists, `audioTakeId` (§4.3) |
| G8 (m): the ffprobe `duration` fallback contradicts §6.1; the probe would run inside the leaf lock; two take-changing stamps are missing; `dropEntry` is an uncounted write site | **R7-7.** The fallback uses §6.1 step 2's **full decode**, run in the book-op span **before** the stamp takes `book`. A journalled op records the result in its journal, so replay never decodes again. A failed decode clears `duration` and logs. The backup-restore stamp (`reconcileBookTakes`) and the legacy-reject re-stamp (§6.1 step 5) join the take-changing stamps. `dropEntry` joins the State-write sites table as a `revisions.json` site, fail-loud at an entry point and swallowed at the boot fsck and in the background retries, and Phase 2 step 7's counts include it (§4.4, §5.A State-write sites) |
| G9 (m): the chapter-start span costs far more than "2N resolves instead of N" | **R7-8.** Counted honestly, and reduced. The design's in-job spans (chapter start, commit, the attempted marker, scoring's pre-read span and its per-character spans) resolve **without the segments backfill**: `withBookOp` gains `{ backfill: false }`, used by those spans only. Each span reads the journal listing once. A 60-chapter, 30-character render with one pass per chapter then makes the same ~7,200 segments reads as `main`, plus about 2,160 `state.json` reads and `audio/` listings. Without the change it would make about 130,000 (§5.A Span length) |
| G10 (m): the restructure 500 tells the user to "open the chapter again", and reads never replay | **R7-9.** The sentence now names a remedy that works: "…If they are still in use after that, close the other program. Castwright finishes the move the next time this book's audio is changed, or when it restarts." (§5.A Restructure) |
| G11 (m): `index.ts` anchors moved | Re-verified at `dbc30a2a`: `:545-551` → `:549-555`, `:549` → `:553`, `:382-392` → `:386-396`. `verified-at` is refreshed. No other cited file changed |
| Gap: "nothing is evicted under a running render" is broader than the design | Narrowed (E8 row). The paths that remain are pre-existing on `main` and are listed under Remaining: a pass that started at once, beside a render at another key that started during it; two concurrent renders at different keys (N9); and, new because partial passes are new, a render's run-start reconcile evicting a partial pass's audition tier mid-pass, which then reloads (§5.A Scoring) |
| Gap: R6-7's discard timing | **R7-10.** The per-slug journals on slugs the bundle carries are discarded **inside `replaceTakesFromBundle`**, after the swap, with the local takes. They are not discarded at the pre-claim replay, so an import that then fails (for example `BundleConflictError`, `scan-import-folder.ts:480`) leaves them to finish (§5.A Ownership) |
| Gap: R6-6's canonical key does not normalise Unicode | **R7-11.** Stated as out of scope. On darwin, an NFC display name and an NFD name on disk miss each other in the set, so the fence fails open for that book. Listed under Remaining (§5.A Ownership) |
| Gap: a queued pass starts after the in-flight pass's token is released, so a restructure can renumber `justFinalizedSlugs` first | **R7-12.** A pending entry records its chapters by `uuid`, and maps them to slugs from the chapters it re-reads when it starts. A chapter that no longer exists is skipped (§5.A Scoring) |
| Gap: the E7 test's parenthetical | Rewritten under E8. The test states that no pass is in flight, so the partial trigger starts at once. It asserts the call count, so it fails whatever `keep` the mutation passes |
| Notes: row Q's rename-away half; #4230 | **R7-13.** Row Q records both halves from this box (NTFS): with ffmpeg holding a hard-link snapshot, renaming a new take over the live name succeeded, **and** renaming the live file away to `.previous` succeeded. With ffmpeg holding the live file directly, the controls failed EPERM and EBUSY. Commit step 5 starts with a rename-away, so the claim that the m4b leaves the ffmpeg-holder list once #4224 merges rests on the second half. #4230 is described in the W16 row (§2) and §4.3, and cited in `refs:` |
| Questions 1–3 | Q1's first half answered by E8. Q1's second half (queued passes) settled by E8 too. Q2 by R7-2 and R7-3; Q3 by R7-4 and R7-5 (§8.1) |

## Decisions made in revision 7 (confirmed by the owner 2026-11-17, with revision 10 as a whole)

E8 left these open. Pass 6 said revision 7 could settle them without the owner. Each item takes the
narrowest option that is safe.

- **R7-1 (journal unlinks take `book`).** See the G2 row. It adds no lock edge: book-op → `book`
  already exists, and nothing else is taken while the unlink holds `book`.
- **R7-2 (`landing`).** See the G3 row. The relabel journal gains `landing: [k]`.
- **R7-3 (step 0's slug plan).** See the G4 row. The closure's assertion is unreachable under book-op
  and `book`; it fails the restructure with the existing fixed 500 if it ever fires.
- **R7-4 (classes by step).**
  - **Move step, any code:** the slug stays blocked. The entry point answers 409
    `take_repair_pending`. The sentence is R6-3's held-file sentence for EBUSY, EPERM and EACCES,
    which `renameWithRetry` already treats as transient (`atomic-rename.ts:42-45`), and
    "Some of this chapter's audio files could not be moved into place. Check free disk space and the
    book folder's permissions, then try again." for any other code.
  - **Record step, transient:** blocks nothing. Commit step 0 retries it as cause 3. The render's
    chapter-start span logs it and proceeds. A quick op answers its curated 500.
  - **Record step, persistent:** blocks nothing, and is never retried. The chapter-start span ends
    the chapter `chapter_failed` before synthesis, and commit step 0 sweeps the staged set and ends
    the chapter, both with `FS_PERMANENT_FAILURE_REQUEST_ERROR`. A quick op answers the same
    sentence as a 500. A render whose own step 7 stamp fails persistently still commits the take,
    and its `take_details_pending` frame carries "The new take was saved, but its details could not
    be recorded. Check free disk space and folder permissions." instead of R3-7's "they will be
    repaired".
  - **The cost:** a persistent failure at step 0 loses a synthesised render that `main` would have
    installed before its own stamp failed. In practice the chapter-start span catches the same
    failure before synthesis, so the loss needs the disk or permissions to fail during that one
    chapter's synthesis.
- **R7-5 (splice and QA repair curation).** See the G6 row.
- **R7-6 (persist carries take fields only).** See the G7 row. Failure stamps clearing on a
  re-analysis is kept, because a re-analysis can change the cast that a failure came from.
- **R7-7 (unindexed duration by decode).** See the G8 row.
- **R7-8 (backfill-free in-job spans).** See the G9 row. The backfill still runs in every
  registration and every quick operation's resolve, so a book is healed at least once per job. Within a running job,
  the only writers of take fields are the job's own stamps, which write every member.
- **R7-9 (restructure sentence).** See the G10 row.
- **R7-10 (bundle journal discard).** See the gap row.
- **R7-11 (Unicode out of scope).** See the gap row.
- **R7-12 (pending entries by `uuid`).** See the gap row.
- **R7-13 (row Q and #4230).** See the notes row.

## Revision 6 changelog

Kept for history. Where revision 7 changed a resolution (R6-1's reconcile on queued passes, R6-2's
segments-first `land` and plan-time `onlyCopy`, R6-3's error-based classes, R6-4's carry function,
R6-7's discard timing, R6-8's ffprobe, R6-11's unlink, and the chapter-start budget), the
revision 7 changelog above wins.

`assumption-checker` pass 5 ran on revision 5 at head `4ea60036` (PR #4189 comment "Assumption-checker
pass 5"). It returned 0 Critical, 1 Significant (C1) and 12 Minors (C2–C13), plus five
contradictions/gaps and three questions. The owner answered the first question on 2026-11-16 as E7
(binding, quoted under "Owner decisions"). Pass 5 said revision 6 could settle the other two, C2 and
every Minor, which this revision does (R6-1 to R6-12). Every anchor was re-checked against
`origin/main` (`25c65c0a`). Since `1e295990`:
- **#4195** (merged, #3518) drops a tier-mismatched centroid. It moves `aggregate.ts` and
  `chapter-qa-repair.ts` (C12).
- **#4220** (merged) cleans up temp writes. It moves `finalize-chapter-write.ts` by 2 lines after
  `:560` and leaves `tts/mp3.ts`'s line count unchanged.
- **#4206** (merged, #4166) routes `completedSlugs` (`book-state.ts:782-789`) and `scan.ts`'s
  `completedChapters` (`:750-754`) through `chapterAudioExists`. Both now count non-excluded
  chapters with a live take by the finder, which is the module's predicate (R4-1). R-d, R-l and N3
  are fixed on `main`; Phase 1 only re-points them at the module's accessor. It moves `book-state.ts`
  by −2 lines after `:785` and `scan.ts` by +1, then +2.
- **#4224** is still open. Besides the hard link that row Q tracks, it closes the m4b duration skew
  (#4223), corrects the stale `book-state.ts:166-185` comment, and keeps each chapter's handle open
  for the codec zip's whole build. That is still a Node holder, so "a Node holder never blocks a
  commit" holds (C13).

| Finding (pass 5) | Resolution in revision 6 |
|---|---|
| **C1 (S): a partial trigger's full-cast `keep` does not cover a render at another run key.** `computeUsedQwenTiers` follows the run key, and a QA repair or splice brings its own; its post-audition reconcile can evict a running render's 1.7B tier | **E7.** A scoring pass triggered by a partial job (QA repair, Fix-audio, splice) **never** runs the post-audition `reconcileResidentQwenTiers` (`generation.ts:215-216`). Only a render's own scoring pass reconciles. Nothing is evicted under a running render. The cost is stated: a stray tier, such as the 0.6B a partial pass auditioned at, can stay resident beside a running 1.7B render until the next render reconcile (the run-start reconcile at the render's next chapter POST, `generation.ts:1203-1220`, or a render's scoring pass). A partial trigger therefore carries no `keep`: the full-cast `keep` is moot for it and is dropped. A render's trigger keeps its own full-cast `keep`, unchanged from `main`. The E5 test is restated around a second run key (§5.A Scoring, Tests). |
| C2 (m): a merged re-run carries one `runModelKey`, so one side's characters audition at the other side's tier | **R6-1.** Triggers merge only when their `runModelKey` is equal. A trigger at another key queues its own pending pass. A merged pass reconciles only when one of its triggers is a render's, against the OR of the render triggers' `keep` (§5.A Scoring). |
| C3 (m): plan-time `parts` record lost parts on ordinary reorders and merges; `drop`'s only-copy rule is re-derived at replay; `land` leaves foreign audio live | **R6-2.** `clear-stale-previous` lists slugs only and probes their `.previous.*` parts **when it runs**, as today's Phase 1c does, so a part another group moved is never "lost". `drop` records `onlyCopy` per slug **at plan time**, and replay obeys it. `land` moves each source's segments **first**. Until a source's segments have landed, any part found at its target is foreign and is quarantined, audio included (§5.A Restructure). |
| C4 (m): a stuck journal's sentence and class are wrong for stamp/lock failures, corrupt parts and an unparseable book journal; splice and QA repair cannot answer 409 | **R6-3.** A replay failure has two classes. Only a **rename** failure blocks a slug with 409 `take_repair_pending`. A **stamp or lock** failure answers the existing curated 500 (and is retryable cause 3 at a commit's step 0), which reconciles the State-write sites table with R5-3/R5-4. The `metadata` group skips an unparseable part, as today's Phase 3 does, and records it. An unparseable journal of either kind is **quarantined**, not fail-closed. Splice and QA repair refuse with a `chapter_failed` frame carrying the code. R5-4's sentence no longer promises an automatic finish (§5.A Ownership, Restructure, State-write sites). |
| C5 (m): the analysis persist rebuilds `state.json`'s chapters and drops every take field; it is in no inventory | **R6-4.** The analysis persist (`routes/analysis.ts:8604-8630`, subset job `:10749-10775`) is **W16**, a D3 writer. It carries `TAKE_STATE_FIELDS` across its chapter rebuild through `carryServerOwnedChapterFields`, the PUT's own function, from the fresh state it already reads under `book` → `state-json`. `healTakeFields` keeps "never `audioTakeId`". R5-8's "slugs now move only through restructure" is corrected: the persist also recomputes slugs, which is pre-existing; the persist keeps the slug of a chapter with a live take (#4230; the W16 row in §2 and §4.3). |
| C6 (m): the PUT can still orphan a take (an omitted chapter, `excluded`, a map change at cursor `planned`) | **R6-5.** A PUT that sends `chapters` replays book journals first (it joins R5-5's whole-book writers). It answers 409 `slug_bound` when it omits a chapter that has a take on disk, or changes a matched chapter's `excluded`. A relabel's "did `state.json` land?" no longer compares chapter maps: the restructure's state write stamps the journal's id (`relabelJid`), which every later writer carries through (§4.3, §5.A Restructure). |
| C7 (m): R5-7's set needs a `finally` and a canonical key; backup restore re-locates the book without its handle | **R6-6.** Registration in the set is removed in a `finally`. The key is the canonical directory (resolved, `/`-separated, lower-cased on win32 and darwin), and a `BookHandle`'s directory is canonicalised the same way. Backup restore threads its `withBookOp` handle into `restoreBackup`, which uses the handle's directory instead of locating the book again (§5.A Ownership). |
| C8 (m): R5-5's replay runs under the workspace-wide path claim | **R6-7.** The bundle overwrite replays **before** it takes `withBookPathClaim`: under book-op in the `withBookOp` branch, and under its registered `UnaddressedBookHandle` in the other. Per-slug journals on slugs the bundle replaces are not replayed; they are discarded with the take, and lazy migration is skipped for those slugs (§5.A Ownership). |
| C9 (m): an entry can become visible again through `previousRenderedAt`; a previous take with no segments keeps the other take's fields | **R6-8.** Every module op that changes the live take other than a commit, Accept or Reject drops the chapter's pending entry, inside its journal: R3-5's promotion and `replaceTakesFromBundle`. A stamp that **changes** the live take writes every member, and clears a member the new segments lack. With no segments it clears every member except `duration`, which it probes from the audio (§4.4, §5.A Reject). |
| C10 (m): the pending-entry reconcile drops entries after a parked `stage` | **R6-9.** The reconcile reads the journal's plan, not the rewrite's report. An entry moves for every `stage` source with a previous take, whether or not it has landed, and an op on it answers `take_repair_pending` until the journal finishes (§5.A Restructure). |
| C11 (m): `relabelTakes`' step 0 does not resolve per-slug journals | **R6-10.** Step 0 runs `reconcileSlug` for every slug the plan names, and refuses the restructure with `take_repair_pending` when any of them, or a book journal, stays stuck (§5.A Restructure). |
| C12 (m): anchors drifted at `a99df2f3` | Re-verified at `25c65c0a`; `verified-at` refreshed. `aggregate.ts` (+29, +55 at the merge), `chapter-qa-repair.ts` (+2 after `:480`), `finalize-chapter-write.ts` (+2 after `:560`), and now `book-state.ts` (−2 after `:785`) and `scan.ts` (+1, then +2) are shifted in §1 onward. |
| C13 (m): #4227 is not cited; #4224's other effects are not recorded | §8.3, Remaining and the gap row now cite **#4227**. #4224's effects are recorded (above, §2.3 R-f, Remaining, §7). Row Q's hard-link cell is filled from the box (§7 Phase 4). |
| Gap: R5-2's skip does not cover the scan heal's window | **R6-11.** The heal reads the live segments **first** and checks for a journal **after**, both under `book`. A journal is written before any install and unlinked only after the stamp, which needs `book`, so the check sees every journal whose install the read could have seen (§4.4). |
| Gap: the State-write sites table vs R5-3/R5-4 | R6-3 (two failure classes). |
| Gap: `loadSegmentsFiles`' exact-name membership vs the case-insensitive read | **R6-12.** The classifier's filter includes `loadSegmentsFiles`' own exact-name `readdir` membership, so its population is exactly `loadSegmentsFiles`'. The join keeps the case-insensitive read. The "one difference" sentence is removed (§5.A Scoring). |
| Gap: the cursor's wording is off by one | The cursor names the **last completed** group. Replay runs the group **after** it, and the per-part test runs inside that group. Every sentence now says so (§5.A Restructure). |
| Gap: the chapter-start span's cost is not budgeted | Counted under Span length: one more `withBookOp` resolve per chapter of a render, beside the registration's own resolve (§5.A Span length). |
| Questions 1–3 | Q1 answered by E7; Q2 by R6-3; Q3 by R6-4 (§8.1). |

## Decisions made in revision 6 (confirmed by the owner 2026-11-17, with revision 10 as a whole)

E7 left these open. Pass 5 said revision 6 could settle them without the owner. Each item takes the
narrowest option that is safe.

- **R6-1 (merging by run key).** Pending re-runs are kept per book as a FIFO list, one entry per
  distinct `runModelKey` (the resume route's absent key is its own value). A trigger merges into the
  entry with its key, or appends a new one. The pass's `finally` starts the oldest pending entry.
  Within an entry the merge rules are unchanged. A merged pass runs the post-audition reconcile only
  when at least one of its triggers is a render's. Its target is then the OR of the render triggers'
  `keep`. Partial triggers contribute their slugs and no `keep`. A render's own pass, merged with a
  partial trigger at the same key, is still that render's pass. Its full-cast target covers the
  partial characters, because they are on the same run key. With no render trigger, a pass of resume
  triggers reconciles against `scoreBook`'s `usedQwenTiers`, as the resume route does today. A pass
  of partial triggers alone never reconciles (E7).
- **R6-2 (relabel parts).** `clearStalePrevious` lists slugs, not parts. The group probes each slug's
  `.previous.*` parts at run time. `drop` entries carry `onlyCopy`, fixed at plan time. `land` moves
  a source's segments first. See the C3 row.
- **R6-3 (failure classes, unparseable journals).**
  - **A rename-class failure** is EBUSY, EPERM or EACCES from a rename (or from quarantine, which is a
    rename) that outlasts `renameWithRetry`. It blocks the slugs the journal names. An entry point on
    one of them answers 409 `take_repair_pending` with: "Some of this chapter's audio files could not
    be moved into place. If another program is using the book's folder, close it, then try again."
  - **A stamp- or lock-class failure** is a `state-json`, `book` or `revisions` timeout, or a failed
    `state.json` write, during replay. The files are already where the journal put them, so a rename
    remedy would be wrong. It answers the existing curated sentence (`requestFailureMessageFs` or
    `LOCK_CONTENTION_REQUEST_ERROR`) as a 500. At a commit's step 0 it is retryable cause 3. At a
    render's chapter-start span it is logged and the chapter proceeds, because the commit's step 0
    retries it. It blocks nothing.
  - **A corrupt part.** The `metadata` group skips a segments or verdict file it cannot parse, as
    today's Phase 3 does (`rewrite-chapter-slugs.ts:262-305`). It logs the part and records it under
    the journal's `unreadable`, and does not block. The chapter is then unindexed or unscored, as on
    `main`.
  - **An unparseable journal, of either kind, is quarantined**, not fail-closed. It moves to
    `audio/.orphaned/<iso-date>-<jid>/` and is logged at every boot like any quarantine. The sweep
    then meets the jid-tagged names it was moving (`.discard-<jid>.*`, `<slug>.relabel-<jid>-<k>.*`)
    with no journal, and quarantines them into the same event folder, never unlinking them. That is
    the narrowest safe option:
    - every journal is written atomically (temp and rename), so a crash cannot leave one
      unparseable. Something outside the protocol damaged it;
    - the bytes it was moving survive, grouped by jid, for a person to reassemble;
    - fail-closed blocks the whole book, because an unparseable book journal names no slugs. No UI
      path can clear it (R3-6), which is pass 4's bricked book;
    - the cost is that the chapters it was moving read unrendered, with their takes in
      `.orphaned/`.

    A book journal still at cursor `planned` may have written the new hints; quarantining it leaves
    them over the old state, which is the hints/state mismatch `main` leaves after a crash there.
  - **Splice and QA repair** have already flushed their event-stream headers when they read their base
    (`chapter-splice.ts:132-136` before `:174`; `chapter-qa-repair.ts:122-126` before `:143`). Their
    refusal is the frame they already fail with, `chapter_failed`, carrying `code` and the sentence.
- **R6-4 (the analysis persist).** It carries `TAKE_STATE_FIELDS` across its rebuild with
  `carryServerOwnedChapterFields` (id **and** slug, `chapter-uuid.ts:149-170`), from the fresh state
  `updateStateAtDir` hands it under `book` → `state-json`. A chapter whose slug the persist changes
  matches nothing, so its fields drop, as today. This carry was chosen over letting `healTakeFields`
  fill `audioTakeId` for three reasons:
  - it also keeps `duration`, which the rebuild otherwise resets to the placeholder;
  - it keeps one rule shared with the PUT;
  - it writes only values it read from the same fresh state, so it can never fill a field from the
    wrong take. A heal fill can, which is why the heal never fills `audioTakeId`.
- **R6-5 (the PUT's chapters).** See the C6 row. `slug_bound` keeps its name and now covers every
  PUT that would unbind a take from its chapter. The `relabelJid` stamp replaces revision 5's
  `plannedSlugs` comparison.
- **R6-6 (unaddressed set and backup restore handle).** See the C7 row.
- **R6-7 (bundle overwrite replay placement).** See the C8 row.
- **R6-8 (entry drops, stamps that switch takes).** See the C9 row. The promotion's and the
  replace's journal carry a `dropEntry` step after the stamp. The journal is unlinked only after the
  drop lands, so a failed drop is retried by replay rather than lost.
- **R6-9 (pending-entry reconcile from the plan).** See the C10 row.
- **R6-10 (`relabelTakes`' step 0).** See the C11 row.
- **R6-11 (heal read order).** See the gap row.
- **R6-12 (classifier membership).** See the gap row.

## Revision 5 changelog

Kept for history. Where revision 6 changed a resolution (E5's full-cast `keep` for partial triggers,
R3-3's single `runModelKey`, R5-1's plan-time `parts`, R5-2's read order, R5-3/R5-4's single failure
class and sentence, R5-5's replay placement, R5-7's set, R5-8's "slugs move only through
restructure", B7's "one difference" and `plannedSlugs`), the revision 6 changelog above wins.

`assumption-checker` pass 4 ran on revision 4 at head `2b5f887b` (PR #4189 comment "Assumption-checker
pass 4"). It returned 0 Critical, 4 Significant (B1–B4), six Minors (B5–B10), six
contradictions/gaps and three questions. The owner answered the first two on 2026-11-15 as E5 and
E6 (binding, quoted under "Owner decisions"). The third was a design question that this revision
settles itself (R5-1 to R5-5). Every anchor was re-checked against `origin/main` (`1e295990`). Since
`c16da893`:
- **#4211** (merged) makes finalize remove its temp audio file on a failure before the rename.
  Finalize's anchors move by about 20 lines, and N5 is now fixed.
- **#4204** (merged) touches no file this spec cites.
- **#4206** is still open.
- **#4224** (open) makes the m4b export hard-link chapter snapshots into a staging directory, so its
  ffmpeg no longer opens the live chapter names. Once it merges, D4's ffmpeg-holder cases should
  shrink to the clip cut and the MP3 zip and folder exports. Whether NTFS lets a live name be
  renamed while ffmpeg holds a hard link to the same file is unverified, so row Q checks it. The
  design does not depend on it (OD7, R-f).

| Finding (pass 4) | Resolution in revision 5 |
|---|---|
| **B1 (S): a relabel group cannot be resumed from inside.** `stage` has no "partly staged" branch; `land` has no "temp gone, target present" branch, so a re-run quarantines freshly landed takes | **R5-1.** Every relabel group is now idempotent **per part**, not just at group boundaries. The journal lists each source's present parts. In `stage`, `drop` and `clear-stale-previous` a part is done when its source name is free and its journal-unique target holds it. A copy found at a vacated source name is foreign and is quarantined. That presence test is sound inside these groups because nothing lands on a slug before `land`. The `takeId` check reads whichever copy of the source's segments exists, at `from` or at `temp`. `land` gains "temp absent, target present → already landed", and that branch checks `takeId` on the segments part. A part that is absent under every name is recorded as lost and does not block replay. Fault injection now stops between two parts of one source in every group (§5.A Restructure, Tests). |
| **B2 (S): the scan heal re-fills a merged chapter's cleared take fields from the pre-merge take while a relabel is stuck**, and fill-only then makes that permanent | **R5-2.** `healTakeFields` skips any slug that a journal names: a per-slug journal for it, or a book journal whose plan touches it. That covers `backfillAudioModelKeysFromSegments` → `persistHealPatches`, in `withBookOp`'s resolve and on the library-scan paths. The check runs inside the heal's `book` lock, and the restructure writes its journal under that same lock (§4.4). |
| **B3 (S): after a parked stamp, the review entry is invisible and gets dropped; `takeId` matching would make the `audioTakeId` mirror a decision input** | **E6.** The A/B review entry is recorded **only after a successful stamp**. When the stamp is parked, no entry is recorded, and the chapter's old entry, which no longer describes the live and previous pair, is dropped. The journal stays at `installed` and carries everything replay needs to record the entry later. Replay records it right after its own stamp lands, so Restore appears once replay lands the stamp. `entryMatchesChapter` keeps matching against `state.json`'s `audioRenderedAt`, which a fail-loud stamp writes. It now also accepts the entry's recorded previous render time. The retry tables compare the **live segments'** `takeId`, which the module reads under book-op. `audioTakeId` is never read for a decision, so its mirror stamp stays swallowed. R4-7's "Restore is available" is corrected (§5.A Commit steps 3 and 7, Retry recognition, State-write sites). |
| **B4 (S): E3's wait cannot be observed for queue-driven renders**: one POST per chapter, and `inFlightByBook` empties between chapters | **E5.** A splice- or QA-repair-triggered pass runs whenever it fires. It no longer waits, and there is no `afterRenders` mark and no synth-job exit hook. It always runs with the **full-cast `keep`** (`computeUsedQwenTiers`), which pass 4 confirmed closes A5's tier eviction on its own. A merged re-run ORs its triggers' `keep` sets, so any pass a partial trigger contributes to runs with at least the full cast. The E3 test is restated to pin the full-cast `keep`, with a mutation that swaps in `result.usedQwenTiers` and must fail. `chapter-job-coordination.ts` leaves the blast radius. R3-4 and R4-9 are restated (§5.A Scoring). |
| B5 (m): R4-10's retry can land an older listen-progress autosave after a newer one | **R5-6.** A listen-progress write that carries no `listenedAt` takes its ordering time from when the server **received** it, before the first acquisition. A retried attempt applies srv-34's existing compare-and-set against that time (`book-state.ts:2813-2825`). So an older write's retry never overwrites a newer record, `markers` included. The client is unchanged. Listen-stats is a commutative max-merge and needs nothing. A partial job now requests scoring outside its commit span, so the registration retry never nests in book-op (§5.A Span length, Scoring). |
| B6 (m): the bundle overwrite of a target with no `bookId` runs without book-op, so `replaceTakesFromBundle` would have no handle | **R5-7.** That branch (`scan-import-folder.ts:570`) gets an `UnaddressedBookHandle`, minted inside its `withBookPathClaim`. Both unaddressed kinds register their directory in a process-local set. A module entry point given a `BookHandle` whose directory is in that set answers `book_busy`. That closes the window after the bundle's freshly minted id lands in `state.json`. The `withBookOp` branch (`:571`) threads its handle through `commitOverwrite` (§5.A Fence). |
| B7 (m): one segments read cannot be "the same population `loadSegmentsFiles` uses" | **One read, two filters.** Phase 1 reads each chapter's segments once. The join takes every file that parses, as `readSegmentsFile` does today. The engine classifier takes the subset with a numeric `chapterId`, through `loadSegmentsFiles`'s own predicate, extracted so both use one function. The `qa-report.ts` contract and the ABA close both hold, because the two filters see the same bytes (§5.A Scoring). |
| B8 (m): guard rule 3 has no binding resolver in `guard-scan.ts`; the plant misses the template-literal hop and non-first-argument writers | Phase 1 step 7 now budgets a same-function `const` resolver in `test-utils/guard-scan.ts`, with its own unit tests. Rule 3 follows three hop kinds: `join`/`resolve`, a template literal whose head is a tracked binding, and a `const` alias. Each mutation call has a per-call table of path arguments. `rename`, `renameWithRetry`, `copyFile` and `cp` use arguments 0 and 1. `writeChapterLufsFile` uses argument 1 and `writeChapterPeaksFile` argument 2. The rest use argument 0. The mutation check plants three shapes, and each must fail: the two-`join` rename, finalize's template-literal temp write (`:242-244`), and a peaks write through argument 2 (§5.A Guard, Tests). |
| B9 (m): the replay stamp's fail-loud row has callers with nothing to fail into | Split. Replay at an entry point that has a terminal outcome is fail-loud. Replay at the boot fsck (fire-and-forget, `index.ts:545-551`) and in R4-2's background `reconcileBook` retries is **swallow-and-log**: the journal stays, and the next entry point repeats it. The table now counts four new fail-loud sites, one moved, and four new swallow sites (§5.A State-write sites). |
| B10 (m): R4-4 lets the PUT move a chapter to a free slug, orphaning its take | **R5-8.** A chapter the PUT matches on disk (by `uuid`, else `id`) must keep its disk slug. Only an unmatched chapter may carry a new slug, and only one that no disk chapter holds and that has no take on disk. Anything else answers 409 `slug_bound` (§4.3, R4-4 restated). |
| Most dangerous assumption: a stuck book journal bricks the book | **R5-3, R5-4, R5-5.** A stuck journal blocks **only the slugs it names** (R5-3). Every entry point on a named slug answers `take_repair_pending` with a fixed sentence that names the remedy. A render fails such a chapter before synthesis, not at the watchdog with the wrong diagnosis (R5-4). The escape is defined: a lost or foreign part no longer blocks, every entry point and every boot retry, and only a file the OS refuses to move keeps a slug blocked. Whole-book writers resolve or refuse a pending journal before they swap state (R5-5). |
| Gap: R4-1: `findChapterAudio` returns its first hit | The module probes all three extensions itself, with the finder's per-extension probe. `findChapterAudio` stays the readers' first-hit finder. Until step 0 resolves an ambiguous slug, exports read the first hit in `EXT_PROBE_ORDER` (§4.2). |
| Gap: the relabel journal carries the whole `hintsPrior` | `hintsPrior` is dropped at the first cursor rewrite after `state-landed`, so it is written at most twice (§5.A Restructure). |
| Gap: a parked edits failure feeds the cache rebuild stale sentences; "covered by the GET-side reconciliation" is unsupported | Partly settled. When the edits write is parked, the cache rebuild is **skipped**, so it never rebuilds from pre-restructure ids against a renumbered state. The "covered" claim is withdrawn. The remaining edits/cache gap is the same one `main` has after a crash in that window. It is listed under Remaining and in §8.3 as owing a design pass, filed as #4227 (§5.A Restructure; the issue number added in revision 6). |
| Gap: whole-state writers judge a relabel journal against a state they just swapped | R5-5. Backup restore and the bundle overwrite replay every pending journal **before** they swap `state.json`, in the same span. A replay that fails refuses the operation with `take_repair_pending`. The reparse/replace wipe removes the journals together with the takes, which is what the user asked for. |
| Gap: the re-run's `afterRenders` | Moot: E5 removes `afterRenders`. |
| Gap: R4-7 and the caller's own writes; client auto-retry | On the `take_details_pending` path the take committed, so generation's follow-ups still run before the terminal frame: `afterChapterFinalized` (the attempted marker and the scoring trigger) and the queue-entry mark. A Retry, whether the user or a client queue starts it, is an ordinary re-render whose step 0 replay runs first, so whether the client auto-retries does not change the outcome (R4-7 restated). |
| Gap: whether a failed `reconcileBook` blocks unrelated slugs | No (R5-3). |
| Questions 1–3 | Q1 answered by E5, Q2 by E6, Q3 by R5-1 to R5-5 (§8.1). |

## Decisions made in revision 5 (confirmed by the owner 2026-11-17, with revision 10 as a whole)

E5 and E6 left these open. Pass 4 said revision 5 could settle B1 and B2 without the owner. Each
item takes the narrowest option that is safe.

- **R5-1 (per-part relabel idempotence).** The relabel journal lists each source's present parts,
  live and previous, in `COMPANION_SUFFIXES` order. Replay decides each part from what is on disk:
  - **`stage`** (from → temp), **`drop`** (slug → `.discard-<jid>.drop.*`) and
    **`clear-stale-previous`** (→ `.discard-<jid>.stale.*`):
    - source present, target absent → rename;
    - source absent, target present → done;
    - both present → the copy at the source name is foreign, because nothing in the protocol
      refills a vacated name. It is quarantined, and the part is done;
    - both absent → the part is lost: log it, record it in the journal, and continue.

    This presence test is sound inside these three groups. Their targets are journal-unique, and no
    take lands on any slug before `land`, so a vacated slug name cannot be refilled.
  - **The `takeId` check** reads the source's segments at `from` or at `temp`, whichever exists.
    When the copy at `from` carries another `takeId`, the take at `from` is not the one planned.
    Every part of that source still at `from` is quarantined, and those parts are recorded as lost.
    Parts already at `temp` carry on.
  - **`land`** (temp → target):
    - temp present, target absent → rename;
    - temp absent, target present → done, if the target's segments carry the source's `takeId` (the
      segments part is checked; the other parts follow it);
    - temp present, target present → the occupant is outside the plan: quarantine it, then rename.
      Two sources never share a target, so a part this journal landed can never be an occupant;
    - both absent → lost, as above.
  - A lost part leaves an incomplete take: no audio means the chapter reads unrendered, and no
    segments means it is unindexed (§4.2). It never blocks the book.
- **R5-2 (the heal skips journal-named slugs).** `healTakeFields`, which serves
  `backfillAudioModelKeysFromSegments` → `persistHealPatches` in `withBookOp`'s resolve and on the
  library-scan paths, contributes no patch for a slug that a journal names. That is either a per-slug
  journal file for it, or a book journal whose plan names it as a `from`, a `to`, a `drop` or a
  `clearStalePrevious`. The check is made in the locked merge, under `book`. The restructure writes
  its journal while it holds `book`, so a heal either runs before the restructure (and its fields are
  then recomputed by the restructure's own state write) or sees the journal. The unlocked first pass
  also skips the slug, so it does not report a fill it will not make. The fields stay absent until
  the journal clears, and the next heal fills them from the take that is live then.
- **R5-3 (scope of a stuck journal).** A journal that fails replay blocks only the slugs it names.
  For a book journal, those are the slugs it names as defined in R5-2. For a per-slug journal, it is
  its own slug.
  - An entry point attempts a book journal's replay only when one of its slugs is among them, or
    when it is a book-wide operation (a new restructure, backup restore, the bundle overwrite, the
    boot fsck).
  - An entry point on other slugs proceeds and logs the stuck journal once per span.
  - Scoring skips named slugs, as a CAS skip that does not re-arm.
  - A new restructure is refused while a book journal is stuck, because it needs the whole map.
- **R5-4 (what the user sees).** Each entry point on a named slug answers 409 `take_repair_pending`
  with one fixed, path-free sentence: "Some of this chapter's audio files could not be moved into
  place. If another program is using the book's folder, close it; Castwright finishes the move
  automatically." No new UI is added; the sentence reaches the existing error surfaces.
  - **A render** checks at its chapter-start span (the `startTakeId` span, §4.1). A named slug fails
    that chapter `chapter_failed` with the same code and sentence, **before** synthesis. A book
    journal that becomes stuck during the render fails commit step 0 the same way. It is not
    retryable cause 3, so the watchdog's "audio file in use" sentence is never the diagnosis.
  - **The escape.** Lost parts and foreign copies do not block (R5-1). Every entry point on a named
    slug, R4-2's background retries and every boot retry the replay. Only a file that the OS refuses
    to rename, under every name and in every retry, keeps a slug blocked. Quarantine is a rename too,
    so no software path can move such a file. Removing the cause (closing the holder, restoring the
    folder's permissions) is the user's action, and the next entry point finishes. The boot fsck logs
    each stuck journal with its book and slugs on every boot.
- **R5-5 (whole-book writers and a pending journal).** Backup restore and the bundle overwrite run
  `reconcileBook` and `reconcileSlug` for every slug **before** they swap `state.json`, inside the
  same book-op (or unaddressed) span. A replay that fails refuses the operation with
  `take_repair_pending`, and nothing is swapped. The reparse/replace wipe removes the journals with
  the takes: it discards every take on purpose, and `.orphaned/` stays (R4-5).
- **R5-6 (listen-progress ordering under retry).** See the B5 row. A write without `listenedAt`
  is ordered by its receive time on its retried attempts. A first attempt is unchanged.
- **R5-7 (the no-`bookId` bundle overwrite).** See the B6 row. The module accepts an
  `UnaddressedBookHandle` from exactly two callers, the fsck's walker and this branch. A second
  unaddressed handle for a directory already in the set is refused: the fsck skips the book for
  this boot, and the overwrite answers `book_busy`.
- **R5-8 (PUT slug binding, restated).** See the B10 row.

## Revision 4 changelog

Kept for history. Where revision 5 changed a resolution (A3's review record, A5's wait, R4-4, R4-7,
R4-8, R4-9, R4-10, and the replay stamp's class), the revision 5 changelog above wins.

`assumption-checker` pass 3 ran on revision 3 at head `aeb162a2` (PR #4189 comment "Assumption-checker
pass 3"). It returned 0 Critical, 5 Significant (A1–A5), nine Minors (A6–A14), seven
contradictions/gaps and three owner questions. The owner answered all three on 2026-11-15 as E1–E4
(binding, quoted under "Owner decisions"). Every anchor was re-checked against `origin/main`
(`c16da893`).

| Finding (pass 3) | Resolution in revision 4 |
|---|---|
| **A1 (S): the relabel journal replays a finished map; "roll back after `state.json`" leaves state naming new slugs over files at old names; Phases 1c and 3 are outside the journal** | **E1.** Relabel rolls **forward only** once `state.json` has landed. The journal carries a **step cursor** over ordered step groups (drop, stage, clear-stale-previous, land, metadata, cleanup) and each source's `takeId`. Replay resumes at the cursor and never re-runs a finished group, so a "Chapter N" merge's drop can no longer hit the renumbered survivor. Phases 1c and 3 are cursor groups. The pre-state rollback window covers the journal and `manuscript-hints.json` only. `manuscript-edits.json`, the ManuscriptRecord and the analysis cache are written after `state.json`, so they roll forward (§5.A Restructure). |
| **A2 (S): the 6 s deadline doesn't bound the span** | **E2.** The deadline is **removed**. A fully staged commit is never abandoned for being slow. The waiters that cannot wait get a bounded acquisition retry: the listen-progress and listen-stats PUTs, and `runBookJob`'s registration (§5.A Span length and contention). Migration's full decode runs at most once per slug, because nothing rolls it back any more. |
| **A3 (S): the D2 rethrow loses the review record; new `state.json` sites are unclassified; "fail-loud count unchanged" is false** | **E2.** After `installed`, a failing step **parks** its error, the remaining writes run, and the error is rethrown last (CLAUDE.md deferred rethrow). The commit journal carries `review`, `oldDuration`, `preserved` and the chapter ref, so replay can redo the review record. The journal is unlinked only after a successful stamp. A new table classifies every new `state.json` write site (§5.A State-write sites). The count claim is replaced by the table. |
| **A4 (S): guard rule 3 can't see extracted variables, variable suffixes or zip-relative paths** | **E4.** Rule 3 no longer claims variable-suffix or zip-relative writers. It catches what a syntactic scan really can: an inline path, or one reached through **same-function `const` bindings**, rooted at `audioDir(…)` or an `audio/` literal. The call list gains the sync variants, `copyFile`/`cp`, `createWriteStream`, write-flag `open`, `mkdir` and member-call forms. The blind spots are listed in the header in `state-json-lock.guard`'s shape. The mutation check plants finalize's real two-hop extracted-variable shape. A second, pinned case shows a parameter-rooted plant is a known false negative (§5.A Guard). |
| **A5 (S): a splice/QA-repair scoring pass would reconcile tiers beside a sibling render** | **E3.** A partial-job trigger **waits** while any synth job of the book runs (generation, splice or QA repair). It never starts a pass, or a tier reconcile, beside one. When the book's last synth job exits, the pass runs with the book's full-cast `keep` (`computeUsedQwenTiers`, as a render computes it at run start) (§5.A Scoring). R3-4 is restated. |
| A6 (m): scoring ABA mixes embeddings and segments; the verdict-file format change is unstated | Phase 1 of a pass reads each chapter's `segments.json` **once**. That one read feeds both the per-chapter join and the engine classification, over the same population `loadSegmentsFiles` uses. A chapter is scored only when its embeddings `takeId` equals that segments `takeId`. **Verdict files do not carry `takeId`**: nothing reads one, and the CAS reads the live segments. The bare-array format is unchanged (decision R4-6). |
| A7 (m): the attempted marker has no CAS id on an embed failure | The CAS id is the segments `takeId` read in phase 1, not the embeddings one. Generation's call uses the commit result's `newTakeId` (§5.A Scoring). |
| A8 (m): R3-5 makes OD6's quarantine, Accept's `live_audio_missing` and step 4's no-live branch dead; quarantine isn't gated on a journal | Reconciled (§4.2). `dropAllTakes` never promotes, so OD6's only-copy quarantine stays live. Accept's pre-check is **removed**: promotion runs first, and the converge row records the truth (decision R4-3). Step 4's no-live-take branch is **removed** as unreachable. Orphan-part quarantine runs only when no journal names the slug. |
| A9 (m): `TAKE_STATE_FIELDS` isn't the single list (restructure's `duration`, the scan heal, the PUT's `slug`) | §4.3 corrected. The list is the single **membership** list. Restructure's carry is a per-field rule over it: `duration` always, as today; the rest only for unchanged content. The scan heal becomes the module's `healTakeFields`: the one sanctioned book-op-less take-field writer, fill-absent only, never `audioTakeId`. The PUT can no longer rebind a chapter to another slug's takes (decision R4-4). |
| A10 (m): `liveStaging` assumes one server process | Stated as a precondition. book-op is process-local too, so a second process already breaks every lock in the order. Listed under Remaining. |
| A11 (m): a transient step-0 failure sweeps a healthy render | Step 0 is a **third retryable cause**: any failure before step 3 writes the commit's own journal keeps the staged set (§5.A Retries). |
| A12 (m): three anchors past end-of-file | Corrected: `book-jobs.ts:50-56`, `atomic-rename.ts:22-26`. `previous-audio.ts:128` is gone; R-k's variable-suffix sites are `chapter-audio-file.ts:57`, `rewrite-chapter-slugs.ts:105-106`, `previous-audio.ts:51`, finalize `:217` and `book-state.ts:2413`. |
| A13 (m): Phase 1 schedules R3-5 before `restoreTake` exists | Phase 1 keeps fsck case 1 (with real extensions). The journalled promotion replaces it in Phase 3 (§7). |
| A14 (m): `replaceTakesFromBundle` lock placement | It runs **after** the overwrite's `withStateJsonLock` rename loop returns, still under the claim and book-op, and before the `finally`'s record drops. A failure is parked, so those drops still run (§5.A Ownership). |
| Gap: "exactly one" vs "two or more → yes" | §4.2: a live take exists ⇔ **at least one** live audio file exists. Two or more is ambiguous and resolved at step 0. |
| Gap: `.orphaned/` is wiped by reparse; "backups skip it" is vacuous | The reparse/replace wipe removes every entry of `audio/` **except** `.orphaned/` (decision R4-5). The backup claim is withdrawn: auto-backup snapshots `state.json` only. |
| Gap: R-f / OD7 omit the MP3 zip and MP3 folder exports | Both are listed as ffmpeg holders (`applyId3v24Tags`, `export/id3-tags.ts:61-98`). D4 already covers them. |
| Gap: §5.D "job readers are covered by the CAS" is false for export | Corrected. `build-m4b` probes durations up front and reads the files later, so a commit in between ships old chapter marks over new audio. That race already exists on `main`. It is listed under Remaining and reported separately; the take module neither closes nor widens it. |
| Gap: R3-1 never fires for a legacy chapter | Generation reads `startTakeId` through `ensureTakeIdentity` in a short span at chapter start (§4.1). |
| Gap: R3-3's ctx merge; unbounded re-arm; a legacy first pass is wasted | The merge is specified: union of `justFinalizedSlugs`, OR of `keep`, latest `runModelKey`, chapters re-read. A CAS mismatch re-arms at most once per trigger chain. A persistent embeddings/segments mismatch is skipped and never re-arms. The caller runs `ensureTakeIdentity` for every chapter in one span **before** the pass reads (§5.A Scoring). |
| Gap: R3-7 skips the `generationState*` clear; Retry discards the pre-render take | The commit journal records `clearGenerationState`, so replay's stamp clears it too. The parked rethrow still records the review entry, so Restore is offered. Retry then behaves as any re-render of a chapter with a pending review does on `main` (decision R4-7). |
| Gap: the fsck has no `BookHandle` | `withBookOpAtDir` hands its callback a handle in both branches. For a book with no `bookId` it is an `UnaddressedBookHandle`, which the module accepts because no `/:bookId` route can reach that book (decision R4-8). |
| Gap: OD4 vs Edit 6b | Edit 6b supplies a **patch** per re-synthesised segment. At commit the carry-forward applies it to the live row instead of dropping that row (OD4 restated). |
| Owner questions 1–3 | Answered by E1–E3 (§8.1). |
| Live-take predicate: finder or readdir + regex? | **The finder** (`chapterAudioExists` / `findChapterAudio`), the same as exports and PR #4206. On a case-insensitive filesystem `<slug>.MP3` is live, so every reader agrees (§4.2, decision R4-1). |
| §2.3 lacks `scan.ts`'s `completedChapters` | Added as R-l (`scan.ts:749-752`; #4206 routes it through `chapterAudioExists`). |

## Decisions made in revision 4 (confirmed by the owner 2026-11-17, with revision 10 as a whole)

E1–E4 left these open. Each takes the option most consistent with them.

- **R4-1 (live-take predicate).** The module's predicate is the finder's: an `existsSync` probe of
  `<slug>.mp3`, `.m4a`, `.ogg` in `EXT_PROBE_ORDER` (`chapter-audio-file.ts:37-41,47-63`). It is
  not a readdir plus case-sensitive regex. "Two or more live files" means two or more of those
  probes hit. On a case-insensitive filesystem a probe matches a differently-cased name, so exports,
  `completedSlugs` (#4206), `completedChapters` and the module all agree.
- **R4-2 (stuck relabel).** When a relabel's roll-forward fails in-process after `state.json` has
  landed, the restructure answers 500 with a fixed sentence. The route then schedules a background
  `reconcileBook` with D4's backoff (1 s, 2 s, 4 s, then every 5 s, for up to 60 s), each attempt in
  its own `withBookOp` span. Past that, the next module entry point or the boot fsck finishes it.
- **R4-3 (Accept on the no-live-take shape).** Step 0's promotion runs first. Accept then meets the
  restored take and takes its converge row: the entry is removed, `rejected` is recorded, and the
  answer is 409 `revision_gone`. The `live_audio_missing` pre-check is removed.
- **R4-4 (PUT slug binding). Restated by R5-8.** On PUT `/state`, a chapter that matches a disk
  chapter (by `uuid`, else by `id`) must carry that chapter's disk slug. Only an unmatched chapter
  may carry another slug, and only one that no disk chapter holds and that has no take on disk.
  Otherwise the PUT answers 409 `slug_bound`. Revision 4 also let a matched chapter move to a free
  slug, which left its take at the old slug bound to nothing (pass 4, B10). Slugs now move only
  through restructure, which moves the files with them. No in-app caller sends `chapters` on this
  slice (`book-state.ts:1503`).
- **R4-5 (`.orphaned/` and the reparse wipe).** The reparse/replace wipe removes every entry of
  `audio/` except `.orphaned/`, so "never auto-deleted" holds.
- **R4-6 (verdict format).** The verdict file stays a bare array, with no `takeId`. The scoring CAS
  and the carry-forward read the live segments' `takeId`, so a verdict id would be a field nothing
  reads.
- **R4-7 (Retry after R3-7). Corrected by E6.** The `chapter_failed` frame carries the code
  `take_details_pending` and R3-7's sentence. Revision 4 said the review entry was already
  recorded, so Restore was available. That was false (pass 4, B3). Under E6 the entry is recorded
  only after a successful stamp, so **Restore appears once replay lands the stamp**. The first replay
  is the failing job's own catch-path `reconcileSlug`, so a transient failure shows Restore almost at
  once. A persistent one shows it at the first later entry point whose replay lands. Before the
  terminal frame, generation still runs its own follow-ups, because the take committed:
  `afterChapterFinalized` (the attempted marker and the scoring trigger) and the queue-entry mark. A
  Retry, whether the user or a client queue starts it, is an ordinary re-render. Its step 0 replay
  runs first, and may record the entry. Then, as on `main`, it discards the take that was previous
  when it commits.
- **R4-8 (fsck on an unaddressed book). Widened by R5-7.** `withBookOpAtDir` passes a `BookHandle`
  or an `UnaddressedBookHandle`. The module accepts the latter from the fsck's walker and from the
  bundle overwrite's no-`bookId` branch, and from nowhere else. That keeps today's case-1 recovery
  for books with no `bookId`.
- **R4-9 (synth jobs for E3). Withdrawn by E5.** No partial trigger waits any more, so no synth-job
  registry is read and no exit hook exists.
- **R4-10 (waiter retry bound).** The listen-progress/listen-stats PUTs and `runBookJob`'s
  registration retry a **pre-entry** book-op timeout up to twice more: three 10 s acquisitions, 30 s
  in all. Past that they answer the existing curated `lock_contention` sentence. R5-6 orders a
  retried listen-progress write by its receive time.

## Revision 3 changelog

Kept for history. Where revision 4 changed a row's resolution (the relabel journal, the span
deadline, R3-4, guard rule 3, verdict `takeId`s), the revision 4 changelog above wins.

Two `assumption-checker` passes ran on revision 2 (PR #4189 comments): pass A at head `f774b442`
and pass 1 at head `4653989f`. Together they returned 1 Critical and 8 Significant findings, plus
Minors and three owed questions. The owner settled the four that needed a decision on 2026-11-15
(D1–D4, binding, quoted under "Owner decisions"). Every finding was re-checked against
`origin/main` (`a9918640`). The cited server files are byte-identical to `3792b84b`, so revision 2's
anchors still hold, except where a row below corrects one.

| Finding (pass) | Resolution in revision 3 |
|---|---|
| **Critical: `takeSeq` has two meanings, so the CAS can't both close ABA and let partial jobs commit** (A, 1) | **D1.** `takeSeq`/`audioTakeSeq` are removed throughout. The CAS compares the live `takeId` only (§4.1). ABA is benign, and the reasoning is stated in §4.1. The Accept bump, the journal target seq and migration's seq steps are gone. There is a new positive-control race test, "a splice after Accept commits" (§5.A Tests). |
| Accept is not refused during jobs, and the journal stores no target seq, so replay double-bumps (A) | Nothing is bumped any more (D1). Replay is a pure function of what is on disk (§5.A Journal rules). |
| **S: OD3's roll-forward contradicts CLAUDE.md's fail-loud stamp; the failure-stamp guard keys on the field a failed stamp didn't write; replay may not run soon** (A1) | **D2.** A stamp failure after `installed` rethrows. "This take committed" is decided by the journal plus the live `segments.json` `takeId`, never by `state.json` (§5.A Commit, Failure handling). The failure-stamp guard reads the module's `takeCommitted`. Replay runs at every entry point and in the failing job's own catch path, not only at boot. OD3 is restated. |
| **S: W1–W12 misses bundle-import overwrite, backup restore and the PUT `/state` passthrough** (A2, 1) | **D3.** They become W13–W15 (§2.2). Each one goes through a module entry point: `replaceTakesFromBundle`, `reconcileBookTakes` and the shared `TAKE_STATE_FIELDS` list (§5.A Ownership). `chapter-uuid.ts`, `scan-import-folder.ts`, `backup.ts` and `auto-backup.ts` join the blast radius. |
| **S: take ids are minted only at boot** (A3, 1) | **D3.** `ensureTakeIdentity` mints lazily at every module entry point, for a book of any age (§4.1). The boot fsck is now just one more caller. |
| **S: scoring isn't protected** (embeddings are read before segments; a splice's prepare-time carry-forward overwrites verdicts scoring committed in between) (A4) | Embeddings and verdict files carry their take's `takeId` (§4.3). Scoring's CAS reads it from the embeddings file it scores. The OD4 carry-forward moves **into the commit span**, so it copies the verdicts that are live at commit, not the ones live at prepare (§5.A Commit step 4). |
| **S: `scoreBook` writes incrementally by design; the attempted marker stamps at pass start; `triggerScoring` drops triggers, so "picked up by the next pass" is false; the resume route is missing** (1) | `commitScoring` is **one short span per character write**, which keeps srv-36's incremental writes (§5.A Scoring). The attempted marker goes through the same CAS. `triggerScoring` gains a coalesced re-run flag in place of the silent drop (decision R3-3). `qa-report.ts` joins the blast radius. |
| **S: preparing outside the lock isn't safe** (an orphaned body writes after the watchdog releases the token; `writeJsonAtomic` recreates parent directories; nothing cleans `.next-*`) (A5, 1) | **D4.** Staging writes never create directories, and they check the signal before each part (§5.A Prepare). Every non-commit exit sweeps the staged and discard sets: abort, CAS mismatch, crash, watchdog abandonment. `reconcileSlug` and the fsck sweep anything left (§5.A Sweep). `completedSlugs` counts exact live names only (§2.3 R-d). |
| **S: "a live take exists" is never defined; the H6/N8 shape either faults or discards the only copy** (A6) | **D3.** §4.2 defines it on the live **audio** file. The H6/N8 shape (live segments, no live audio, previous present) has **no** live take. Its orphan segments are quarantined, and its previous take is the only copy and is never discarded. |
| **S: migration step 6 relies on a missing UI path** (A7) | Automatic promotion is kept for the unambiguous no-live-take shape: not excluded and no journal. It now runs as a journalled `restoreTake` at any entry point, not as fsck case 1's unjournalled renames (§6.1 step 6, decision R3-5). |
| **S: Windows holders.** An ffmpeg reader deterministically blocks the commit's renames (probe); only lock timeouts were retried; the 1 s cap undercuts OneDrive's 3.6 s budget; R-f mislabels the codec zip (1) | **D4.** EBUSY/EPERM keeps the staged take, rolls back what moved, and retries with a bound the assembly watchdog sees (`stallPhase = 'commit'`, §5.A Retries). The 1 s cap is removed in favour of a span deadline (decision R3-2). The live audio is moved first, so a held file fails before anything else moves. The protocol never renames **onto** a held name (§5.A Windows). R-f is corrected: the codec zip is a Node stream. Row Q's NTFS cells are recorded from the probe; OneDrive is still owed. |
| **S: commit-span contention.** Job registration and autosaves wait on book-op with no retry; an unbounded retry removes the watchdog ceiling; the span is more than ~15 parts; `renameWithRetry` retries ENOENT (A minor, 1) | A hard **span deadline** below the 10 s acquisition budget, so one commit can never time out a waiter (R3-2). Retries happen **between** spans, under the watchdog. The count is corrected to 21 renames. Absent parts are skipped, not retried (§5.A Span length). |
| **S: N9 is not closed** (`::*` and `::X` don't displace each other; the second commit discards the user's pre-render take) (A minor, 1) | A render records `startTakeId`. When another commit landed in between, the commit **keeps the original previous take** and discards the intervening one (§5.A Commit step 4, decision R3-1). Displacement keying is unchanged. |
| **S: OD4 parity claim is false** (on `main`, splice never touches verdicts) (1) | The claim is withdrawn. OD4 is restated as a visible change: after Fix-audio, the re-synthesised sentences read unscored until the next pass. The coalesced re-run (R3-3) and a splice/QA-repair scoring trigger bound that window (decision R3-4). |
| **S: relabel journalling is never designed** (restructure writes `state.json` before the renames; a permutation can't replay per slug) (1) | A **book-level** relabel journal holds the whole rename map. Its replay direction is decided from `state.json`'s slugs (§5.A Restructure). `reconcileBook` runs book journals before slug journals. |
| **S: Phase 1 scope understated** (~47 non-test files) (A minor, 1) | The blast radius is restated with the reader count and the unlisted readers named. "Smallest blast radius" is withdrawn as a reason. The B and C estimates are corrected, since they touch the same readers (§5.A Blast radius, §5 Comparison, §6). |
| **S: the guard is blind to variable-suffix and zip-named writers** (1) | The guard gains a second rule, on fs mutations under `audio/` (§5.A Guard). The three known variable-suffix sites are named and fold into the module. Bundle import routes `audio/` through the module, and a test pins that. The remaining blind spots are listed in the guard's header, as `cast-lock.guard` does. |
| m: `deriveSegmentsHeal` backfills raw `meta.modelKey`, contradicting the effective-key derivation and the "no-op otherwise" re-stamp (1) | One derivation, `deriveTakeFields`, used by the heal **and** the stamp (§4.4). Migration re-stamps every field only on the legacy-reject shape. Otherwise it fills absent fields, so "no-op otherwise" holds (§6.1 step 5). |
| m: lock placement is ambiguous (1) | Entry points take a live `BookHandle` and never lock. Callers lock at the one sanctioned level. `scoreBook` receives a `commit` callback from its caller, so it never calls `withBookOp` itself (§5.A Fence). |
| m: commit retry can't tell timeouts apart; steps 0 and 2 take `state-json` (A) | The retry treats only a **pre-entry** timeout as book-op contention (an `entered` flag). Inner timeouts follow the journal. Replay is idempotent, so a re-run is safe (§5.A Retries). |
| m: discard names can collide (A) | Discards carry a role tag: `.discard-<jid>.prev.*`, `.live.*`, `.stale.*` (§5.A Commit). |
| m: `audio/.orphaned/` has no bound, retention or surfacing (A) | Per-event subfolders, never auto-deleted (OD8). Quarantine happens only in the enumerated shapes. Boot logs a per-book count and byte total. Export and backup skip it. UI surfacing is decision R3-6. |
| m: `.previous.take.json` duplicates the stamp derivation (A) | Removed. The previous take's own `segments.json` is the source (§4.3). |
| m: retiring `revision-op` touches unlisted tests and comments (A) | Listed in the blast radius and in Phase 3. |
| m: exclude leaves take fields in `state.json` (1) | `dropAllTakes` clears `TAKE_STATE_FIELDS` in the same state write (§5.A Exclude). |
| m: §2.1's `duration` claim is wrong (`restructure.ts:394`) (1) | Corrected: `duration` is carried unconditionally, and the other take fields only when the content is unchanged. |
| m: book-level centroids and pending-attempts are written unfenced (1) | Declared out of the take: they are book-level, single-flight per book, and re-derived each pass (§4.3). |
| m: ffprobe at ±0.5 s is unreliable on legacy MP3s with no Xing header; it falls through to mtime (A, 1) | Duration matching uses a full decode, which runs only for the rare multi-live shape (§6.1 step 2). |
| §8 questions answered from code (1) | Folded into §8: the attempted marker is existence-only; verdict keys survive carry-forward. |
| Pass A owed questions 1–3; pass 1 owed questions 1–3 | Answered in §8.1, one line each, by D1–D4. |

## Decisions made in revision 3 (confirmed by the owner 2026-11-17, with revision 10 as a whole)

D1–D4 left these open. Each takes the option most consistent with them.

- **R3-1 (N9).** A render records `startTakeId`. If the live take changed before its commit, the
  commit discards the **intervening** live take and keeps the existing previous take (the user's
  pre-render audio), instead of the plain "live becomes previous". This refines OD2's
  last-writer-wins: it changes which take becomes the previous one, and it never refuses a commit.
- **R3-2 (contention). Withdrawn by E2.** Revision 3 had no `renameWithRetry` cap and a 6 s commit
  span deadline. E2 removes the deadline. The `renameWithRetry` cap stays removed, and the waiters
  that cannot wait retry instead (R4-10).
- **R3-3 (scoring triggers).** `triggerScoring` replaces "drop while in flight" with one coalesced
  re-run per book. A pass that drops a chapter on a CAS mismatch also requests the re-run.
  Revision 4 specifies the ctx merge and bounds the re-arm (§5.A Scoring).
- **R3-4 (OD4 visibility). Restated by E3, then by E5, then by E7.** Splice and QA repair trigger scoring after
  a commit. That bounds how long re-synthesised sentences read unscored. It is a behaviour change
  from `main`, where splice never re-scores. The pass runs whenever it fires (E5), and never runs the
  post-audition tier reconcile (E7). Revision 4's wait (E3, R4-9) is withdrawn.
- **R3-5 (no-live-take shape).** The previous take is promoted automatically, through a journalled
  `restoreTake`, when there is no live audio, the chapter is not excluded, and no journal exists
  for the slug. This keeps today's fsck-case-1 outcome without its unjournalled renames, instead
  of relying on a UI path that does not exist.
- **R3-6 (`.orphaned/`).** No UI surface in v1 (the surface area is final). A per-book boot log
  line, no auto-delete. Surfacing it is a separate feature, if wanted. The reparse wipe keeps it
  (R4-5).
- **R3-7 (stamp failure after install).** The job ends `chapter_failed` with a fixed sentence
  ("the new take was saved, but its details could not be recorded; they will be repaired"). It
  does **not** stamp `generationState: 'failed'`, because the take committed. The chapter's audio is
  the new take. Revision 4 adds the `generationState*` clear to replay and settles Retry (R4-7).
- **R3-8 (bundle overwrite).** For every chapter slug the bundle carries, the local take, previous
  take included, is replaced whole. A local chapter the bundle does not carry is left whole. That
  is take-granular "left in place", not file-granular.
- **R3-9 (backup restore).** After the old `state.json` is restored, the take fields are re-derived
  from the live `segments.json`. A backup restore no longer rewinds them to describe audio that is
  not on disk.

## Owner decisions

> **Accepted 2026-11-14:** the owner chose Option A (OD1) and accepted every other recommendation
> in this section as written.
>
> **Binding 2026-11-15 (D1–D4), after both assumption-checker passes:**
> - **D1.** Drop `takeSeq`. The CAS compares the per-commit random `takeId` only; a restore that
>   brings take A back brings A's `takeId` back, and a splice prepared against A then commits onto
>   A, which is correct because the content matches (ABA is benign). Positive-control race test: a
>   splice after Accept commits.
> - **D2.** A state stamp that fails after `installed` **rethrows** (the CLAUDE.md fail-loud site at
>   finalize's stamp is kept). The journal is the source of truth for "this take committed"; replay
>   is idempotent and runs at the module's entry points, not only at boot.
> - **D3.** The module owns **every** writer, including bundle-import overwrite, backup restore
>   and the PUT `/state` chapter passthrough. `takeId` is minted lazily at the module's own entry
>   points for any book of any age; the "a live take exists" definition is enforced there too,
>   including the H6/N8 shape.
> - **D4.** EBUSY/EPERM from an ffmpeg reader (m4b build, clips) keeps the staged take with a
>   bounded retry the assembly watchdog can see, never silently rolled back. The fsck and every
>   non-commit exit (abort, CAS mismatch, crash, watchdog abandonment) sweep `.next-*` /
>   `.discard-*`. `completedSlugs` must not count `.next-*`.
>
> **Binding 2026-11-15 (E1–E4), after assumption-checker pass 3:**
> - **E1.** Relabel/restructure rolls **forward only** once `state.json` has landed. The journal
>   carries a step cursor plus a per-source `takeId`, so replay resumes exactly where it stopped and
>   never re-runs a finished rename map. That closes the "Chapter N" merge-shape destruction. Phases
>   1c and 3 are covered too. Before `state.json` lands a failure may roll back, and the spec names
>   exactly which artifacts that window covers (hints, edits, ManuscriptRecord, analysis cache).
> - **E2.** Drop R3-2's 6 s commit deadline. A fully staged commit is never abandoned for being slow
>   (e.g. on OneDrive). The waiters that can't wait get a bounded retry: the listen-progress and
>   listen-stats autosaves, and job registration. Steps after `installed` park their errors and
>   rethrow after the remaining writes (the CLAUDE.md deferred-rethrow rule). The journal carries
>   the review input (`input.review`, `oldDuration`) so replay can redo the review record. Every new
>   `state.json` write site is classified as fail-loud or swallow, and §5.A's "count unchanged"
>   claim is fixed.
> - **E3.** R3-4 changes: a splice- or QA-repair-triggered scoring pass **waits** while any render
>   of the book is running. It runs no tier reconcile beside a sibling render, then runs with the
>   normal full-cast `keep` set. *(Restated by E5: the wait is withdrawn.)*
> - **E4.** Guard rule 3 drops its claim to catch variable-suffix and zip-relative writers. They are
>   listed as known blind spots, consistent with `state-json-lock.guard.test.ts`'s own header. The
>   guard keeps whatever it can genuinely catch. Its mutation check uses a realistic
>   extracted-variable shape, not a planted literal.
>
> **Binding 2026-11-15 (E5–E6), after assumption-checker pass 4:**
> - **E5 (answers pass 4's B4 / Q1).** Restate E3. A splice- or QA-repair-triggered scoring pass runs
>   whenever it fires. It no longer waits for "no render running", because that cannot be observed
>   for queue-driven renders: the queue makes one POST per chapter, and `inFlightByBook` empties
>   between chapters. It always runs with the **full-cast `keep`** set, which pass 4 confirmed closes
>   A5's tier eviction on its own. The wait and the new exit-hook callback are dropped. E3's test is
>   restated to pin the full-cast `keep`, which is what actually protects.
> - **E6 (answers pass 4's B3 / Q2).** The A/B review entry is recorded **only after a successful
>   stamp**, and Restore appears once replay lands the stamp. `audioTakeId` stays a mirror, not a
>   decision input, so its mirror stamp may stay swallowed. R4-7's "Restore is available" claim is
>   fixed. The journal carries what replay needs to record the entry later.
>
> **Binding 2026-11-16 (E7), after assumption-checker pass 5:**
> - **E7 (answers pass 5's C1 / Q1).** A scoring pass triggered by a partial job (QA repair,
>   Fix-audio, splice) **never** runs the post-audition tier reconcile
>   (`reconcileResidentQwenTiers`, `generation.ts` ~:215-216). Only a full render's own scoring pass
>   reconciles. Nothing is evicted under a running render, and any stray tiers are cleaned the next
>   time a render's pass runs. *(This restates E5's protection: E5's full-cast `keep` for a partial
>   trigger is moot and is dropped, §5.A Scoring.)*
>
> **Binding 2026-11-16 (E8), after assumption-checker pass 6:**
> - **E8 (answers pass 6's G1 / Q1).** A Resume-scoring pass runs the post-audition tier reconcile
>   **only if it starts at once**. Starting at once means no render is running; resume is refused
>   during generation, as on `main`. **Any pass that was queued behind another and starts later
>   never reconciles**, because its captured tier set may be stale by then. *(This also resolves G1:
>   a pass started from R6-1's pending list never reconciles, which matches `main`, where such
>   triggers are dropped. A render's own pass that starts at once still reconciles, §5.A Scoring.)*
>
> **Binding 2026-11-17 (E9–E10), after assumption-checker pass 7:**
> - **E9 (answers pass 7's Q1).** Immediately before a Resume pass reconciles, it re-checks that no
>   render, splice or QA repair of the book is running. If one is, it skips the cleanup. This closes
>   the click-to-start window, and it closes #4235 (Resume evicting a running repair's tier).
> - **E10 (answers pass 7's Q2 / J3).** When a leftover journal past `installed` fails only on record
>   steps, the next render's commit **supersedes** that journal and installs its own take. If its own
>   record step then fails, it fails loud at step 7, which R7-4 already allows. The user keeps the
>   render they waited for. *(This replaces revision 7's "end at step 0 and discard the render" for
>   this case.)*
>
> **Binding 2026-11-17 (E11–E12), after assumption-checker pass 8:**
> - **E11 (answers pass 8's Q1; restates E9's reach).** Resume's re-check before the cleanup uses
>   the process-wide `isAnyGenerationActive()`, the repo's documented "is an eviction safe" check,
>   plus the splice/QA-repair registry, instead of a per-book check. That covers the chapter-gap
>   case (K3) and other books' renders sharing the sidecar (K4). The cost: Resume skips the cleanup
>   more often, and stray tiers wait for the next render's pass.
> - **E12 (answers pass 8's Q2; restates E10's reach).** A new render may supersede **commit
>   journals past `installed`, restore journals and promotion journals only**. Drop and Accept
>   journals are not superseded; they keep block-and-retry. *(Widened by E14 to `replace` journals.)*
>
> **Binding 2026-11-17 (E13–E15), after assumption-checker pass 9:**
> - **E13 (answers pass 9's L1 / Q1; restates E11's reach).** E11's re-check also samples
>   `isAnyGenerationActive()` at the **start** of the Resume pass, alongside the epoch, as well as
>   immediately before the reconcile. If either sample was busy, the pass skips the cleanup. That
>   closes the "already running at the start, ends in a chapter gap" case, which leaves the residual
>   list.
> - **E14 (answers pass 9's L7 / Q2; restates E12's reach).** Bundle **`replace`** journals join
>   E12's supersedable list. A carried drop journal may be superseded by the `replace` instead of
>   refusing the import. R9-7 is restated to match.
> - **E15 (answers pass 9's L2 / Q3; restates R9-1).** The journal records each part's **size** at
>   step 3, so replay can tell the genuine copy when a part is present at two slug names. That
>   closes the two-fault mixed-take case (a crash mid-`promote`, then a sync client restoring the
>   rejected audio). Each part is decided from its size plus the `takeId`, and "no path produces a
>   mixed take" must hold. Any refusal that remains must not answer R8-2's sentence, which names
>   neither its cause nor the file; a curated, path-free sentence is fine.
>
> **Confirmed 2026-11-17, with revision 10 (revision 9's decisions, moved here from "Decisions made
> in revision 9"):**
> - **R9-1 (both present at two slug names).** Decide by name kind; at two slug names, segments by
>   `takeId`. *(Its refusal of every other part is replaced by E15.)*
> - **R9-3 (chains absorb).** Preventing chains was the other option: refuse to supersede a journal
>   that still names a present one. It was not taken, because that journal would then take the
>   record-step budget and end the chapter, which is revision 7's discarded render, the outcome E10
>   removed, in the case where the disk is already refusing record writes.
> - **R9-4 (match by time).** Minting at step 3 was the other option. It was not taken: it repeats the
>   write that just failed, so it can fail the same way. *(Revision 10 requires both times present,
>   R10-4.)*
> - **R9-6 (`workspace/book-dir-key.ts`).** The name is new. *(Revision 10 adds the second leaf,
>   R10-2.)*
> - **E11's "registry" as the epoch.** One sample of `isAnyGenerationActive()` still reads idle in a
>   render's chapter gap; the gate's own header says so (`:155-159`). The re-check therefore reads
>   the registration epoch too. *(E13 adds the start sample.)*
> - **E12 and `replace`.** *(Answered by E14: `replace` joins the list.)*
> - **R9-7 (carried journals at the bundle overwrite).** A carried journal whose replay completes does
>   not outlive the swap. One on E12's list (as widened by E14) stuck on record steps outlives the
>   swap until the `replace` supersedes it, and so does a carried drop journal (E14). Any other
>   carried journal stuck on record steps refuses the import with the curated 500.
>
> **Binding 2026-11-17 (E16–E18), with revision 11 (the owner accepted revision 10 as a whole,
> apart from the two gaps that E17 and E18 close):**
> - **E16 (confirms revision 10's E15 tie rule).** "Two different equal-size copies that can't be
>   told apart: quarantine both and record the part as `lost`. The take is incomplete, never mixed,
>   and the slug is not blocked." Revision 10's other choices are confirmed with it: the
>   identical-copy rule, the name `take-fields.ts`, skipping the whole book's heal if a journal
>   can't be read, and the step-8 stop.
> - **E17 (the excluded-chapter gap).** A render's chapter-start journal replay can set
>   `excluded: true`, for example through a pending drop journal under E12. "After replay, the
>   render re-reads `excluded` within the same lock span. If the chapter is now excluded, it aborts
>   before staging anything. It writes no take and no state, and it reports the chapter as skipped
>   and excluded, not failed," matching the existing excluded-chapter skip. It is the in-lock
>   re-check, not a replacement for the caller's skip (§4.1).
> - **E18 (Accept and drop journals get a replay direction).** "The rule matches the others: before
>   `installed` a journal rolls back, and at or after `installed` it rolls forward to completion."
>   Where the rule cannot apply as stated, the nearest consistent rule is taken, the one that never
>   leaves a mixed or half-excluded state, and recorded as an R11 choice (R11-1 to R11-3; §5.A
>   Journal rules).
>
> **Confirmed 2026-11-17, with revision 11 (revision 10's decisions, moved here from "Decisions made
> in revision 10"; E16):**
> - **E15's undecided copies (both quarantined, the part lost).** The other option was a refusal
>   with its own sentence naming the two files (pass 9's question 3). It was not taken. A refusal
>   freezes whatever the two copies left at the live name, which can be the mixed take E15 rules
>   out, and a user cannot tell two equal-size copies apart either. Both copies survive in the
>   journal's `.orphaned/` event folder.
> - **E15's identical copies.** Two byte-identical copies at two slug names are treated as the
>   protocol's: the copy at the target counts, and the other is quarantined, never unlinked.
> - **R10-2 (`workspace/take-fields.ts`).** The name is new. The heal skips the whole book for that
>   scan when the leaf cannot read or parse one of the book's journals.
> - **R10-3 (step 8 stops at the first failed unlink).**
>
> Pass 9 cleared the `assumption-checker` gate on revision 9, and the owner approved revision 10 as
> the design of record without a further pass (2026-11-17). The owner then approved merging
> revision 11, which folds E16 to E18, with no further check (2026-11-17). Row Q's OneDrive cells
> must run on the box before Phase 2 (the NTFS cells are recorded, §5.A Windows). That is on-box
> acceptance, not a design question (§8.4).

**OD1 — Which component owns a chapter's take files, and how is everything else fenced?**
Three options are costed in §5. **Accepted: Option A.**
- One module, `workspace/chapter-take.ts`, is the only code that writes, renames or deletes a take
  part, or writes a take field in `state.json`.
- Every mutation runs inside a short `withBookOp` span that the caller holds.
- Long jobs prepare their new take outside the lock and **commit** it inside one span.
- The commit is guarded by a compare-and-swap (CAS) on the live take's filename-safe random
  `takeId` (D1), and by the job's abort signal.

**OD2 (F5) — A multi-chapter render running alongside a splice of one of its chapters.**
- **Accepted:** a multi-chapter (`*`) render aborts any in-flight splice or QA repair of a chapter
  **when it starts that chapter** (`abortInFlightSplice(bookId, chapter.id)` per chapter, not once
  per job). Full renders carry **no** base token.
- **Why no token:** a full render replaces every part and depends on nothing in the live take, so
  "the live take changed since I started" has no meaning for its *content*. Its commit is
  last-writer-wins. R3-1 decides which take becomes the previous one.
- A splice that starts *after* the render reached its chapter still aborts the whole `*` job
  (`abortInFlightChapterJob`, `generation.ts:521-524`). That is today's behaviour, unchanged.

**OD3 (F7), restated by D2 — What happens when a commit has installed the new take, and a later
step fails?**
- **The take stays committed.** Once the `installed` phase is journalled, the new take **is** the
  chapter. No rollback, ever.
- **The failure is loud, and deferred (E2, E6).** A failed `state.json` stamp is **parked**. The
  discard cleanup still runs, and then the parked error rethrows into the job's terminal outcome
  (R3-7). The review record does **not** run after a failed stamp (E6): an entry recorded over a
  stale `state.json` is invisible to every read and is dropped at the next revisions write
  (`revisions-store.ts:199-203,290-308`). The journal is **not** unlinked, so it stays at
  `installed`, and the next `reconcileSlug` re-runs the stamp, then the review record, then the
  cleanup. The first such run is the
  failing job's own catch path. It is idempotent: the stamp is a pure function of the live
  `segments.json`, and the review entry is keyed by `takeId`.
- **The review record stays best-effort**, as plan 285 decided. It surfaces as
  `reviewOutcome: 'failed'`, and `restore-unrecorded` stays the way back. The journal carries its
  inputs (§5.A Commit step 3), so replay can redo it after a crash.

**OD4 (F3) — Scoring verdicts and embeddings after a partial re-record (splice, QA repair).**
- **Accepted: carry them forward.** For each segment the write did **not** re-synthesise, its rows
  are copied from the live take **at commit, inside the span**. The CAS guarantees that take is the
  job's base, and copying at commit keeps any verdict scoring committed meanwhile. Rows for
  re-synthesised segments are dropped, then replaced where the job has something for them:
  - **embeddings:** the job's fresh `reembeddedRows`;
  - **verdicts:** QA repair's Edit 6b is a **patch** (`cosine`, `verdict`, `severity`, `fixable`)
    over an existing row (`chapter-qa-repair.ts:892-898`). For a re-synthesised segment the job
    supplies a patch for, the carry-forward keeps the live row and applies the patch instead of
    dropping the row. Every other re-synthesised segment's verdict row is dropped.
- **Not parity (corrected).** On `main`, a splice never touches the verdict file, so stale rows for
  re-synthesised segments keep applying. After this change those sentences read unscored until a
  scoring pass, which R3-4 triggers. `deriveBookOutline`, the `qa.speaker.autoRepair` loop and Edit
  6b keep their inputs.
- A full render starts with no verdicts. Scoring is triggered as today, by
  `afterChapterFinalized`.

Smaller decisions:

| | Decision | Accepted |
|---|---|---|
| OD5 | Which files and fields belong to a take | §4.3: seven sibling files, plus `TAKE_STATE_FIELDS` in `state.json` |
| OD6 | What excluding a chapter does to its takes | Drop the previous take, every live sibling, the take fields, and the pending entry. When the previous take is the **only** copy (§4.2), quarantine it instead of deleting it (F16). |
| OD7 (F20) | How export is fenced | **Reject** (and `restore-unrecorded`) refuse `book_busy` while an export runs. **Accept is not refused**: it renames only the previous take away, which no ffmpeg export reads (the portable bundle skips `.previous.`, `build-portable-book.ts:149`), and a Node stream does not block a rename-away (probe, §5.A Windows). A render's commit during an export **waits** under D4 while ffmpeg holds the live file. The ffmpeg holders are the clip cut and, through `applyId3v24Tags` (`export/id3-tags.ts:61-98`), the MP3 zip (`build-mp3-zip.ts:275`) and MP3 folder (`build-mp3-folder.ts:116`) exports (revision 4). The m4b builder was one until #4224 merged (at `33f3647c`): it now hard-links each chapter's audio into staging (a copy when linking fails, `export/build-m4b.ts:83-93`), and its ffprobe and ffmpeg open the snapshots, not the live names (`:100-104`, `:120`, `:374`). Row Q's hard-link cells are recorded from this box (NTFS, 2026-11-16). While ffmpeg holds a hard-link snapshot, renaming a new take over the live name succeeds, and renaming the live file away to `.previous` succeeds too; with ffmpeg holding the live file itself, the same two renames fail EPERM and EBUSY. Commit step 5 begins with a rename-away of the live audio, so it is the second half that takes the m4b off the ffmpeg-holder list. The copy fallback is a short Node read, which never blocks a rename-away. Nothing in this design depends on it (revisions 6 to 8). |
| OD8 | What migration does with a file it cannot place | Quarantine to `audio/.orphaned/`; never delete, never overwrite (F6) |

## 1. Why now, and what changed since the issue was filed

#3400 (plan 285/286) made `revisions.json` server-owned and moved the audio step into
`server/src/audio/previous-audio.ts` **unchanged**. It filed this issue for everything about the
audio files themselves.

Between the issue (2026-10-02) and `3792b84b`, other changes closed part of the space:

- **#3711 (plan 288).** Every quick per-book operation holds `book-op:<bookId>` for its whole span:
  - accept, reject and `restore-unrecorded`;
  - exclude;
  - every restructure;
  - reparse and replace;
  - the fsck's per-book step;
  - the bundle overwrite and backup restore.

  Long jobs (render, scoring, export, …) register through `runBookJob` instead. **So the quick
  operations are already mutually exclusive per book.**
- **#3774.** Restructure and exclude are refused while any long job is registered.
- **#3717.** Reparse and replace are refused the same way. So are the bundle overwrite and backup
  restore (`backup.ts:44-49`).
- **#3704 / #3400.** `rewriteChapterSlugs` moves and deletes `.previous.*` with the live take.
- **#3457.** The fsck no longer promotes `.previous.mp3` over a live `.m4a`/`.ogg`.
- **#3700 / #3625.** Every `state.json` read-modify-write named in the issue now runs under the
  `state-json` leaf lock.

The remaining question is therefore narrower. **The things left to fence are:**
1. the long-job **commit** of a take (finalize, called from generation, splice and QA repair);
2. **QA repair's post-finalize writes**;
3. **scoring's** verdict and attempted-marker writes;
4. the **whole-book writers** that bypass take semantics: bundle overwrite, backup restore, the
   state PUT and the analysis persist's chapter rebuild (D3; the last added in revision 6);
5. the **lock-free readers**.

The take files also need **one naming scheme**, a **defined fidelity**, a **defined "live take"**,
and a **recovery rule that does not guess**.

## 2. Inventory at `3792b84b` (re-checked at `25c65c0a`: finalize moved by #4211 and #4220, `aggregate.ts` and `chapter-qa-repair.ts` by #4195, `book-state.ts` and `scan.ts` by #4206; re-checked again at `dbc30a2a`: only `index.ts` moved, by #4216; and at `33f3647c`: the export builders moved, by #4224; and at `08742125`: `chapter-splice.ts`, `chapter-qa-repair.ts` and `tts/mp3.ts` moved, by #4234; and at `deb3fafa`: `book-state.ts` moved, by #4205)

### 2.1 The files

| File | Written by | Moved by preserve? | Restructure |
|---|---|---|---|
| `<slug>.{mp3,m4a,ogg}` (live) | finalize `:777`; bundle overwrite | yes, always **to `.previous.mp3`** (`preserve-previous-audio.ts:38`) | moved/deleted |
| `<slug>.segments.json` | finalize `:776`; restructure metadata rewrite; bundle overwrite | yes | moved/deleted |
| `<slug>.peaks.json` | finalize `:780`; bundle overwrite | **no** | moved/deleted |
| `<slug>.lufs.json` | finalize `:296` (**before** preserve) | **no** | moved/deleted |
| `<slug>.embeddings.json` | finalize `:699`/`:768` (**before** preserve); QA repair Edit 6b (`chapter-qa-repair.ts:870`) | **no** | moved/deleted |
| `<slug>.render-integrity.json` | scoring (`aggregate.ts:1077`, per character via `mergeVerdictRows`, `verdicts-io.ts:42-58`); QA repair Edit 6b `writeVerdicts` (`chapter-qa-repair.ts:~876-905`) | **no** | moved/deleted |
| `<slug>.render-integrity-attempted.json` | `writeAttempted` in generation (`generation.ts:295`) and scoring (`aggregate.ts:667`); existence-only | **no** | moved/deleted |
| `<slug>.previous.mp3`, `.previous.segments.json` | preserve | — | moved/deleted |
| `<slug>.previous.peaks.json` / `.previous.lufs.json` | **nothing** (always absent) | — | listed, never present |
| `<slug>.<ext>.tmp-<pid>-<ts>` | finalize `:242-244` | — | removed on a throw before the rename since #4211 (`:188-206`); a crash still leaves it (#4167) |
| `state.json` chapter: `duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa` | finalize `:791-817`; backup restore (whole file); PUT `/state` (carried, `chapter-uuid.ts:121-170`) | **no** | `duration` carried **unconditionally** (`restructure.ts:394`); the other four only when the content is unchanged (`restructure.ts:409-416`) |

Scoring does **not** write embeddings (V3). Embeddings are written only by finalize and QA repair.
Book-level scoring files (centroids, pending-attempts) are not take parts (§4.3).

### 2.2 Writers

| # | Writer | Where | Locks today | Races |
|---|---|---|---|---|
| W1 | **Finalize** | `audio/finalize-chapter-write.ts:188-833` | None for the files. `state-json` for the stamp (`:791`). `revisions` in `applyReview` (`:823`). Its caller is a `render` job (no book-op). | Lufs and embeddings are written before preserve (H4). If `:777` fails, the **new** segments (`:776`) sit next to the old audio or none (H6). It interleaves with reject (H9), with a second finalize (N9), and with the fsck (N8). |
| W2 | **Generation** | `routes/generation.ts:858` (`runBookJob`); calls W1 at `:1996` | No book-op; abort-based displacement keyed `${bookId}::X` / `::*` (`:513-515`) | Finalize gets no signal. Bails at `:1957` (before assembly) and `:2044` (after finalize) only (H8). The watchdog releases the token while an abort-ignoring body can still run (`:2225-2243`) (N15). A `*` job's `abortInFlightSplice(bookId, null)` (`:1383`) is a no-op (`chapter-job-coordination.ts:54`) (H16 → OD2). `::*` and `::X` jobs don't displace each other (`:1318-1319`, `:1379-1383`) (N9). |
| W3 | **Splice** | `routes/chapter-splice.ts:178`; calls W1 at `:559` | No book-op; `registerSplice` at `:340` | Reads segments (`:189`) before it registers; the last abort check is `:530` (H7). Never triggers scoring (`:593-604`). |
| W4 | **QA repair** | `routes/chapter-qa-repair.ts:147`; calls W1 at `:810` | No book-op; registers at `:337` | Reads **and decodes** the audio (`:154-167`) before it registers (H7). **Edit 6b** writes embeddings (`:870`) and verdicts (`:~876-905`) **after** finalize returns, outside any fence (F4). Never triggers scoring (`:912-925`). |
| W5 | **Accept** | `routes/revision-ops.ts:65-121` → `acceptPreviousAudio` (`previous-audio.ts:27-34`) | `book-op` → `revision-op` → `revisions` | No busy check. `.previous.mp3` only (`previous-audio.ts:19-23`). |
| W6 | **Reject** | `revision-ops.ts:123-182` → `restorePreviousAudio` (`previous-audio.ts:39-61`) | as W5 | Unlinks the live take first (`:45-48`) (H1). Restores to `<slug>.mp3` (`:22`, `:51`) (H13). Swallows a failed segments rename (`:58`) (H2). Busy check is generation only (`generation.ts:661`) (H9). Restores audio and segments only, and **leaves `state.audioRenderedAt` naming the rejected take** (H3, F2). |
| W7 | **restore-unrecorded** | `routes/chapter-audio.ts:404-452` | `isGenerationActive`, then `book-op`; `revision-op` around the restore only | `has_revision` (`:420`) versus finalize's lock-free `recordPending` (H20). |
| W8 | **Restructure** | `chapters-restructure.ts:291-334` → `rewriteChapterSlugs` (Phase 0 deletes `rewrite-chapter-slugs.ts:128-152`; Phase 1 to temp `:154-184`; Phase 1b deletes `:186-208`; Phase 1c stale-previous clear `:210-236`; Phase 2 temp to target `:238-254`; Phase 3 segments and verdict `chapterId` rewrite `:256-306`) | `book-op` → gate → `book`; refused while jobs run | Writes `manuscript-hints.json` (`:587`), `state.json` (`:610`) and `manuscript-edits.json` (`:623`), then the ManuscriptRecord (`:643`), and only then the audio ops (`:650-654`), best-effort; no journal (N16). A replay of a finished map is not a no-op: a "Chapter N" merge gives the survivor a slug that Phase 0/1b deleted (`:128-131`). `buildAudioOps` skips a chapter with no `audioRenderedAt` (`restructure.ts:443`). |
| W9 | **Exclude** | `book-state.ts:2330-2450`; deletes at `:2419-2431` | `book-op` → `book` → `state-json`; refused while jobs run | Leaves `.previous.*`, every sidecar (H22) and the take fields in `state.json` (`:2353-2378`). Leaves the entry (N2). The fsck later promotes the previous take (N1). |
| W10 | **Boot fsck** | `workspace/fsck-orphan-audio.ts:57-132`; per-book step under book-op (`:165`); fire-and-forget at `index.ts:553`, its only caller | `book-op` per book | Skips books it cannot resolve (`:164-172`, `book-op-lock.ts:489`). Case 1 (`:85-108`) promotes `.previous.mp3` to `<slug>.mp3` (`:86,91`) **and `.previous.segments.json` over `<slug>.segments.json`** (`:93-96`) when no live audio exists (`:89`) (N1, N8, H18). |
| W11 | **Scoring** | `aggregate.ts:1077` (verdicts, per character), `:667` (attempted, at pass start); a `scoring` job via `triggerScoring` (`generation.ts:143`) and `resume-scoring` (`qa-report.ts:59-76`) | none | Reads embeddings (`:631`) before segments (`:672`). Files verdicts under whichever take is live when it writes (N7). `triggerScoring` **drops** a trigger while a pass is in flight (`:143`). |
| W12 | **Reparse / replace** | `book-state.ts:2141,2223` | `book-op`; refused while jobs run | Wipes `audio/` wholesale (fixed: H16, first half). |
| W13 | **Bundle-import overwrite** | `import/scan-import-folder.ts:518-535` | `book-op`; `state-json` around the rename loop; refused while jobs run | Renames the bundle's zip-named audio, segments and peaks over live files and **leaves every other local part** (`:15-19`): a mixed take (N11). The ids it brings are not checked. |
| W14 | **Backup restore** | `routes/backup.ts:37-55` → `workspace/auto-backup.ts:209-270` | `book-op`; refused while jobs run | Swaps an old `state.json` in, take fields included, while the audio on disk stays current (N12). |
| W15 | **PUT `/state` chapter passthrough** | `workspace/chapter-uuid.ts:121-170` (`carryServerOwnedChapterFields`) | `book-op` → `book` → `state-json` | Only the five fields in `SERVER_OWNED_CHAPTER_FIELDS` come from disk. Any new take field (`audioTakeId`) would **pass through from the client** (N13). |
| W16 | **Analysis persist chapter rebuild** (revision 6, C5) | `routes/analysis.ts:8604-8630` (main job), `:10749-10775` (subset job), inside `updateStateAtDir` (`:8582`, `:10731`) | A long job: no book-op; `book` → `state-json` around the rebuild | Rebuilds `chapters` from the record's hints. It recomputes a `slug` with restructure's formula (`restructure.ts:127`) only for a chapter with no live take (below), and carries only `excluded`, `held`, `uuid` and `titleOverridden`, and resets `duration` to the placeholder. Every other take field is dropped and left for the heal, which never fills `audioTakeId`. The persist keeps the previous chapter's slug (matched by `id`) when a live take exists at it, through `slugKeepingTake` (`server/src/workspace/keep-take-slug.ts`), and recomputes it only for a chapter with no live take (#4230). |

### 2.3 Readers

Pass 1 counted **about 47 non-test server files** that build or read a take name. The rows below
are the ones with a named hazard. The others are listed in the blast radius (§5.A).

| # | Reader | Where | Hazard |
|---|---|---|---|
| R-a | GET live audio meta/file | `chapter-audio.ts:236-276,316-366`, no lock | 404 inside reject's unlink-then-rename window; transient audio/segments skew. A Node read stream: it does not block a rename-away, but it does block a rename-**onto** (EPERM, probe) |
| R-b | GET previous meta/file | `chapter-audio.ts:284-312,367-370` | Served as `audio/mpeg` at `audio/previous.mp3` whatever the bytes (H14) |
| R-c | Revisions read view | `revisions-store.ts:121-145` via `hasPreviousAudio` (`preserve-previous-audio.ts:75-77`) | `.previous.mp3` only; must move with the naming |
| R-d | `completedSlugs` | `book-state.ts:782-789` | N3, **fixed** by #4206 (merged at `25c65c0a`): it counts the chapters `chapterAudioExists` finds. It must also never count `<slug>.next-<id>.mp3` (D4): it uses the module's live-take predicate (§4.2), which is that finder |
| R-e | `chapterLufs` | `book-state.ts:801-831` | Rejected take's loudness after a reject (H3) |
| R-f | Export builders | `routes/export.ts:522` (`export` job); `findChapterAudio` | Takes can be mixed mid-export. `build-m4b` used to probe every chapter's duration up front and concatenate later, so a commit in between shipped old chapter marks over new audio (#4223). **Fixed by #4224** (merged at `33f3647c`): it snapshots each chapter's audio into staging first (`export/build-m4b.ts:83-93`) and probes and concatenates the snapshots (`:100-104`, `:120`). **ffmpeg holders of a live file:** the MP3 zip (`build-mp3-zip.ts:275`) and MP3 folder (`build-mp3-folder.ts:116`) exports, through `applyId3v24Tags`'s `ffmpeg -i <live mp3>` (`export/id3-tags.ts:61-98`), and the clip cut (R-h). The m4b builder's ffmpeg (`build-m4b.ts:374`) now holds only its snapshots. The codec zip (`build-codec-zip.ts`) is a **Node stream**; #4224 keeps each chapter's handle open for the whole build, which is still a Node holder. |
| R-g | Companion sync manifest | `library-sync-manifest.ts:85-112` | Stale `fileSize`/`urlSuffix`; heals on the next sync |
| R-h | Clip | `routes/clip.ts:73,93-104`; **ffmpeg** `-c copy` holder | R-a window; blocks rename-away of the live file (EBUSY, probe) (N4) |
| R-i | Portable export | `build-portable-book.ts:141-157` | Its filter (`startsWith(slug.)` + an audio extension) would ship staged `.next-*`/`.discard-*` files (F15) |
| R-j | QA report, cast-audio-currency | `audio/qa-report.ts`, `store/cast-audio-currency.ts` | After a reject, `state` describes the rejected take (H3/F2) |
| R-k | Variable-suffix builders | `workspace/chapter-audio-file.ts:57`, `rewrite-chapter-slugs.ts:105-106` (`suffixPath`), `previous-audio.ts:51`, `finalize-chapter-write.ts:217`, `routes/book-state.ts:2423` | Build `<slug>.<suffix>` from a runtime suffix. The guard sees finalize's shape (same-function `const` chain from `audioDir`) but not the others (a parameter root, a helper's return, an array iterated in a loop). They fold into the module in Phase 1, so they are removed, not guarded (§5.A Guard) |
| R-l | Library scan `completedChapters` | `workspace/scan.ts:750-754` | **Fixed** by #4206 (merged at `25c65c0a`): it used to count **files** matching `/\.(mp3\|m4a\|opus)$/i`, which missed `.ogg`, counted `.previous.mp3` and would have counted a staged `.next-*.mp3`. It now counts non-excluded chapters that `chapterAudioExists` finds, which is the module's live-take predicate, like R-d |

## 3. Hazards, verified at `3792b84b` (re-checked at `25c65c0a`, `dbc30a2a`, `08742125` and `deb3fafa`)

Status key: **P** present, **F** fixed, **Pt** partly fixed, **N** newly found.

| ID | Hazard | Status | Evidence |
|---|---|---|---|
| H1 | Reject unlinks the live take before renaming the previous one in | P (mitigated by the `live_audio_missing` pre-check, `revision-ops.ts:92`) | `previous-audio.ts:45-55` |
| H2 | Reject swallows a failed segments rename | P | `previous-audio.ts:58` |
| H3 | Reject restores audio and segments only; state fields and sidecars stay with the rejected take | P | `previous-audio.ts:39-61` |
| H4 | New lufs and embeddings are written before preserve | P | finalize `:296`, `:699`, `:768` vs `:775` |
| H5 | Unlocked `state.json` writers | **F** (#3700/#3625) | guard `state-json-lock.guard.test.ts` |
| H6 | A failed finalize rename leaves no live audio | P, **worse**: the new segments are already live (`:776`), the tmp file is now removed (#4211), there is no stamp | `:775-777` |
| H7 | Splice and QA repair read before they register | P | splice `:185` vs `:336`; QA repair `:150-163` vs `:333` |
| H8 | Stalled or displaced generation still commits | **Pt** (#3711) | `:1957`, `:2044`; finalize takes no signal |
| H9 | No exclusion between accept/reject and running jobs | **Pt** (#3711: no job can *start* during either) | `generation.ts:661` sees generation only; accept checks nothing |
| H10 | Rename leaves `.previous` under the old slug | **F** (#3400/#3704) | `rewrite-chapter-slugs.ts:45-55` |
| H11 | Split/merge keep `.previous` | **F**; residual at `restructure.ts:443` | `rewrite-chapter-slugs.ts:128-146` |
| H12 | `.previous` is always `.mp3` | P | `preserve-previous-audio.ts:38`; `revisions-store.ts:38,143` |
| H13 | Restore and fsck promote to `<slug>.mp3` | P | `previous-audio.ts:22,51`; `fsck-orphan-audio.ts:86,91` |
| H14 | The A-side routes are mp3-only | P | `chapter-audio.ts:304,367-370` |
| H15 | The fsck promotes over a live m4a/ogg | **F** (#3457) | `fsck-orphan-audio.ts:89` |
| H16 | Reparse races jobs; `abortInFlightSplice(null)` is a no-op | **F** for reparse (#3717); the no-op is P (→ OD2) | `generation.ts:1383` |
| H17 | Reject's audio succeeds, its JSON fails, the retry gets `no_previous_audio`, and "Keep new take" records `accepted` | P | `revision-ops.ts:149-173` |
| H18 | The fsck promotes before the user retries Reject | P | `fsck-orphan-audio.ts:85-108` |
| H19 | A failed `recordPending` leaves a stale entry | **Pt** (`entryMatchesChapter`, `revisions-store.ts:199-203`; legacy entries uncovered) | — |
| H20 | `restore-unrecorded` check-then-act | **Pt** | `chapter-audio.ts:417-431` |
| H22 | Exclude leaves the previous take, sidecars and take fields | P | `book-state.ts:2365-2390,2419-2431` |
| N1 | **The fsck resurrects an excluded chapter's audio** | N | Exclude leaves `.previous.mp3`; fsck case 1 never reads `state.json` |
| N2 | A pending entry survives exclude; Reject restores audio onto an excluded chapter | N | — |
| N3 | `completedSlugs` misses `.ogg` and counts a lone `.previous.mp3` | **F** (#4166, fixed by #4206) | `book-state.ts:782-789` |
| N4 | **Windows, verified on NTFS by pass 1's probe.** An ffmpeg reader of the live file (m4b build, clip cut) makes rename-away fail EBUSY, rename-onto fail EPERM, and unlink fail EBUSY. A Node `openSync` holder makes rename-onto fail EPERM only. Preserve swallows its failure, so today a commit during an export can leave old audio + new segments, or **two live files** on a format switch. | N, NTFS confirmed; OneDrive owed (row Q) | probe (PR #4189, pass 1); `preserve-previous-audio.ts:42-51`; finalize `:776-777` |
| N5 | Finalize tmp leaked on a throw | **F** (#4167, fixed by #4211; a crash still leaves it, and the sweep unlinks it) | `:188-206,242-244` |
| N6 | `splice_complete`/QA-repair completion always send `hasPreviousAudio: true` | N (minor) | `chapter-splice.ts:600`, `chapter-qa-repair.ts:921` |
| N7 | Scoring files verdicts and attempted markers under whichever take is live; QA repair's Edit 6b writes embeddings and verdicts after finalize, unfenced | N | `aggregate.ts:631,667,672,1077`; `chapter-qa-repair.ts:870,~876-905` |
| N8 | The fsck runs alongside requests. Between finalize's segments write (`:776`) and its audio install (`:777`), live audio is absent, so case 1 promotes `.previous.mp3` **and renames `.previous.segments.json` over the new segments**. | N | `fsck-orphan-audio.ts:89-96` |
| N9 | Two renders of one chapter (`::*` and `::X`, which don't displace each other) interleave, and the second commit discards the user's pre-render take | N | `generation.ts:513-515,1318-1319,1379-1383` |
| N10 | `revision-op` is redundant: its only holders (`revision-ops.ts:58`, `chapter-audio.ts:429`) are inside `withBookOp` | N (observation, confirmed by pass A) | — |
| N11 | Bundle overwrite leaves a mixed take: the bundle's audio/segments/peaks beside the local lufs, embeddings, verdicts and previous take | N | `scan-import-folder.ts:15-19,518-535` |
| N12 | Backup restore brings back take fields that describe audio no longer on disk | N | `backup.ts:37-55`; `auto-backup.ts:209-270` |
| N13 | The state PUT would pass a client-supplied take id straight through | N (latent: it bites the moment `audioTakeId` exists) | `chapter-uuid.ts:121-170` |
| N14 | Staged and discard files have no owner on abort, CAS mismatch, crash or watchdog abandonment, and `completedSlugs` would have counted a staged `.next-*.mp3` (no longer since #4206: the finder never probes `.next-*`) | N (in revision 2's design) | `book-state.ts:782-789` |
| N15 | A watchdog-abandoned render body keeps running after its token is released; any write that creates parent directories can then recreate a moved folder (the #3711 split-book mechanism) | N | `generation.ts:1954-1966,2225-2243,2499-2505`; `book-op-lock.ts:5-10` |
| N16 | Restructure writes `state.json` before its audio ops, best-effort, so a crash between them leaves state naming slugs whose files sit at the old names | N | `chapters-restructure.ts:605-610,650-654` |
| F2 | **Legacy rejects left `state.audioRenderedAt` (and `duration`/`audioModelKey`/`audioEngines`/`audioQa`) naming the rejected take while the live segments are the restored one.** `deriveSegmentsHeal` fills only *absent* fields (`scan.ts:1244-1289`), so this never heals. | N, data on disk today | `previous-audio.ts:39-61`; `revision-ops.ts:149-173` |

## 4. The take: identity, liveness, fidelity, metadata

### 4.1 Identity (F1, F13, F14; D1, D3)

A take has **one** identifier, its **`takeId`**: 16 lowercase base32 characters from
`crypto.randomBytes`, so it is filename-safe on NTFS.
- It is minted at every commit.
- It is stored in the take's own `segments.json` (`takeId`) and its `embeddings.json` (§4.3), and
  mirrored in `state.json`'s `audioTakeId`. The verdict file does not carry it (R4-6).
- **The live `segments.json` is the truth.** `audioTakeId` is a derived mirror that
  `stampStateFromLiveTake` writes, like the other take fields.

**There is no sequence number (D1).** The CAS compares the base `takeId` a partial job read with
the live `segments.json`'s `takeId` at commit. Nothing else.

**Why ABA is benign.** A take's parts move together and keep their `takeId` (§4.3), so
"`takeId` = A" means "the parts on disk are take A's parts".
- **Prepared against A, live is A again at commit** (Reject restored A after a render made B
  live). The splice commits onto A. That is correct: its base content *is* the live content.
- **Prepared against B, live is A at commit.** Mismatch: the staged files are swept and the SSE
  event says "the chapter changed while this ran; retry".
- **Prepared against B, Accept in between.** Accept leaves B live (it only discards the previous
  take), so the splice commits. That is the positive control (§5.A Tests).
- **Two commits in one millisecond** get distinct random ids (F13).

**Lazy minting (D3).** `ensureTakeIdentity(handle, slug)` runs at the start of **every** module
entry point, under the caller's book-op, for a book of any age:
- live take present (§4.2) and its `segments.json` lacks `takeId` → mint one, write it into the
  live `segments.json` and `embeddings.json`, then `stampStateFromLiveTake`;
- previous take present and lacking a `takeId` → mint one into `.previous.segments.json` (and its
  previous embeddings, if any);
- the boot fsck is just one more caller. A book that is skipped at boot, has no `bookId`, or was
  imported after boot gets its ids on its first touch.

**Where a partial job reads its base (F2, H7).** Splice and QA repair register first. Then, in one
short span of their own, they call `ensureTakeIdentity` and read the live `segments.json` (and QA
repair's decode input) and its `takeId`. So no partial job ever runs against an id-less base, and
the read sits after registration. A mint that fails ends the job in that span, through
`requestFailureMessageFs` (R7-5): a partial job cannot commit without a base id. That is the one
place a failed mint stops anything (R8-2, revision 8).

**Where a full render reads `startTakeId` (R3-1).** At chapter start, after OD2's per-chapter splice
abort, generation opens one short span, calls `ensureTakeIdentity` and reads the live take's id
(or `null` when there is no live take). So R3-1 also fires for a chapter whose take was id-less
when the render started. The same span runs the chapter's journal replay. If a journal naming the
chapter's slug stays stuck on a **move-step** failure, the chapter fails `take_repair_pending`
here, before any synthesis is spent on it (R5-4). A **record-step** failure (revision 8, R8-2 and
E10, with E12's list in revision 9, widened by E14 in revision 10) is handled by what the journal
still owes:
- **a supersedable journal (E12, E14):** a commit or bundle `replace` journal at `installed` or
  later, or a restore or promotion journal at `stamp` or later, that is, past every move. The
  failure is logged and the chapter proceeds. The commit will supersede that journal (E10, §5.A
  Commit step 0), so nothing here can cost the render. A `replace` journal owes what a commit's
  does (a stamp, its `dropEntry`, its discards and its file), and the superseding commit dominates
  each of them the same way. This is the one list; step 0 and Retries cite it. (A bundle `replace`
  may also supersede a carried drop journal, E14, §5.A Ownership; a render's commit may not);
- **any other record step** (a journal read; a drop or Accept journal past its moves; a
  rolled-back journal's unlink; a relabel journal's cursor or `metadata` write): it gets the
  record-step budget, three attempts in all, the first in
  this span and two more in fresh spans after 1 s and 2 s. If the third fails, the chapter ends
  `chapter_failed` before synthesis, with `requestFailureMessageFs`' sentence for the last error.
  `code` chooses that sentence and nothing else: it never decides whether to retry (pass 7, J2).

**The span re-checks `excluded` after replay (E17, revision 11).** A drop journal that the render
cannot supersede (E12) can still finish during this span, in its first attempt or in a later one
of the record-step budget. It rolls forward from `installed` (E18) and writes `excluded: true`. The
caller chose its chapters from the lease's state before that write (`generation.ts:1143-1149`), so
the chapter is still in the run. Each attempt of the span therefore re-reads the chapter's
`excluded` from a fresh `state.json` read, after `reconcileBook` and `reconcileSlug` and before
`ensureTakeIdentity` (R11-4). If it is now excluded, the chapter is skipped:
- **nothing is staged or written.** No synthesis runs, there is no `.next-*` part, no mint, no
  `startTakeId`, no `generationState*` stamp and no attempted marker. The only writes are the ones
  the drop journal's own replay made;
- **it reports what the existing excluded-chapter skip reports**, which is nothing for that
  chapter. On `main` an excluded chapter is filtered out of `targetChapters` before the loop
  (`generation.ts:1143-1149`), the catch-up replay skips it (`:1287-1288`), and a POST left with no
  target answers only `idle` (`:1308-1311`). Here `processOneChapter` returns with no frame, as its
  early returns for an aborted or fatal run do (`:1502-1503`). The loop goes on to the next target,
  and the job ends with its usual `idle`. So a single-chapter queue POST sends exactly the frames
  a POST for an already-excluded chapter sends on `main`. There is no `chapter_failed` and no
  `chapter_complete`, the queue-entry mark and `afterChapterFinalized` do not run, and the skip is
  logged;
- **it is the in-lock re-check, not a replacement.** The caller's filter still decides the run's
  chapters from the lease's state, as on `main`. The re-check only covers a chapter that replay
  excluded after that decision. A commit's step 0 needs no second re-check: exclude is refused
  while the render is registered (#3774, `book-state.ts:2350-2359`), so no drop journal can appear
  after this span, and every one that existed before it was settled here (R11-4).

`ensureTakeIdentity`'s own failures never stop a full render. Its `state.json` mirror is swallowed
(State-write sites), and a failed mint into the live segments leaves the take id-less, so the render
proceeds with `startTakeId: null` and R3-1 loses only its tiebreak. A full render carries no base,
so its commit does not need the id (R8-2). The entry it records then has `previousTakeId: null`
when the take that became previous was id-less, and the retry tables match that entry by its
`previousRenderedAt` instead (R9-4, §5.A Retry recognition), so H17's Reject retry survives the
mint that the next entry point makes, whenever that take's segments carry a `synthesizedAt`
(R10-4). The span resolves without the segments backfill and
reads the journal listing once (R7-8, §5.A Span length).

Restructure carries `audioTakeId` across a rename with the other take fields. Staging, discard and
journal **file names use `takeId` or a fresh journal id, never a timestamp.**

### 4.2 "A live take exists" (D3)

The module exports one predicate. Every entry point, the fsck, `completedSlugs` (R-d),
`completedChapters` (R-l) and the export builders use it:

- **Live audio** of a slug is what the existing finder sees (R4-1): an `existsSync` probe of
  `<slug>.mp3`, `<slug>.m4a` and `<slug>.ogg`, in `EXT_PROBE_ORDER`, on the sanitised slug
  (`chapter-audio-file.ts:37-41,47-63`). It is **not** a readdir plus a case-sensitive regex. The
  two differ on a case-insensitive filesystem (NTFS, APFS by default): there the probe also sees
  `<slug>.MP3`, a regex would not, and exports would disagree with the module. PR #4206 uses the
  finder for `completedSlugs` and `completedChapters`.
  `findChapterAudio` returns its **first** hit (`chapter-audio-file.ts:47-63`), so it cannot report
  two. The module therefore runs the finder's per-extension probe for all three extensions itself
  (revision 5). `findChapterAudio` stays the readers' first-hit finder. Until step 0 resolves an
  ambiguous slug, exports read the first hit in `EXT_PROBE_ORDER`.
  `<slug>.next-<id>.mp3`, `.discard-*`, `.previous.*` and `*.tmp-*` are never probed, so they never
  count.
- **A live take exists ⇔ at least one live audio file exists.** Segments and sidecars do not make a
  take live. With **two or more** (two probes hit), the take is ambiguous. Step 0 of every entry
  point resolves it (§6.1 step 2) before anything else, so every later step sees exactly one.
- **Orphan parts are quarantined only when no journal names the slug.** `reconcileSlug` replays any
  journal first. A journal whose replay fails leaves the slug untouched, quarantine included, so a
  rollback never loses the segments it needs.
- **R3-5's promotion runs at step 0 of every entry point except `dropAllTakes`**, and only for a
  chapter that is not excluded and has no journal. `relabelTakes`' step 0 also skips it for the
  slugs its plan drops (R7-3, revision 7). Three consequences:
  - `dropAllTakes` never promotes, so OD6's only-copy quarantine is live (exclude meets the
    no-live-take shape as it is).
  - Accept never meets the shape: promotion has run, so Accept takes its converge row (R4-3). The
    `live_audio_missing` pre-check is removed.
  - Commit step 4 never meets "no live take, previous present". The only no-live-take shape left at
    step 4 is a first render, with no previous take, which has nothing to keep. Step 4's
    no-live-take branch is removed.

| Shape on disk | Live take? | What the module does |
|---|---|---|
| live audio + live segments | yes | normal |
| live audio, no live segments (legacy) | yes, **unindexed** | a commit preserves it whole; a partial job refuses with "re-render needed" (no segments to splice) |
| **H6/N8: live segments, no live audio, previous present** | **no** | with no journal for the slug, the live segments (and any live sidecars) are **orphan parts**: they are quarantined to `.orphaned/` first, never renamed onto. The previous take is the **only copy** and is never discarded. Then R3-5 promotes it, unless the entry point is `dropAllTakes` or the chapter is excluded (both quarantine it instead) |
| live segments, no live audio, no previous | no | with no journal, orphan parts quarantined; the chapter reads unrendered |
| no live audio, previous present | no | R3-5, with the same exceptions |
| two or more live audio files | yes, **ambiguous** | §6.1 step 2 resolves it at step 0, before any other step |

### 4.3 Fidelity (OD5)

A take is preserved, restored, accepted, relabelled and deleted as one unit:

| Part | Member? | Carries `takeId`? |
|---|---|---|
| audio `<slug>.<ext>` | yes | no (the name and the segments identify it) |
| `segments.json` | yes | **yes, the truth** |
| `peaks.json`, `lufs.json` | yes | no |
| `embeddings.json` | yes | **yes**: an optional `takeId` beside `version` and `rows` (`embeddings-io.ts:17-20`). Scoring scores a chapter only when it equals the segments `takeId` it read (§5.A Scoring) |
| `render-integrity.json`, `render-integrity-attempted.json` | yes (OD4 for partial writes) | **no** (R4-6). The verdict file stays a bare array (`verdicts-io.ts:26-28`); the attempted marker is existence-only. Both writes are fenced by the live segments' `takeId` |
| `state.json` `TAKE_STATE_FIELDS`: `duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa`, `audioTakeId` | yes: **derived** from the live `segments.json` (§4.4); a previous take's fields are derived from its own `.previous.segments.json` on restore | — |
| `generationState*`, `excluded`, `title`, `slug`, `uuid` | no | — |
| book-level centroids, pending-attempts | **no**: book-level, single-flight per book (`scoringInFlight`), re-derived each pass | — |

`.previous.take.json` (revision 2) is **removed**. It duplicated what the previous take's own
segments already give the stamp.

`TAKE_STATE_FIELDS` is exported from the module. It is the single **membership** list: which
`state.json` fields belong to a take. Every consumer reads it. Where a consumer needs a per-field
rule, the rule is stated over the list, never as a second list:
- **`stampStateFromLiveTake`** sets every member it can derive.
- **`chapter-uuid.ts`'s `SERVER_OWNED_CHAPTER_FIELDS`** becomes `TAKE_STATE_FIELDS`. Today it is
  exactly the first five members (`chapter-uuid.ts:121-127`), so adding `audioTakeId` closes N13.
- **The PUT's `slug`** is not a take field, but it is what binds a chapter to its take files. R4-4,
  as restated by R5-8, stops the PUT changing a matched chapter's slug at all
  (`chapter-uuid.ts:147` passes every other field through). A free target slug is refused too: it
  would leave the chapter's take at its old slug, bound to nothing, and its server-owned fields
  would drop, because `carryServerOwnedChapterFields` matches on `id` and `slug`
  (`chapter-uuid.ts:149-170`).
  - **Revision 6 (R6-5, C6).** The PUT replaces `chapters` wholesale (`book-state.ts:1528-1536`), so
    the slug rule alone does not bind every take. A PUT that sends `chapters` also answers 409
    `slug_bound` when it omits a disk chapter that has a take on disk (live or previous), or when it
    changes a matched chapter's `excluded`. Excluding goes through the exclude route, which runs
    `dropAllTakes`. Before it compares anything, the PUT runs `reconcileBook` under its book-op, as
    the other whole-book writers do (R5-5), and refuses with `take_repair_pending` while a book
    journal stays stuck on a move-step failure.
  - Revision 5 said "slugs now move only through restructure". That is not true: the analysis
    persist (W16) recomputes the slug for a chapter with no live take. For a chapter with a live take
    it keeps the slug (#4230), so the take is never left behind by a retitle.
- **Restructure's carry** is a rule over the list, and keeps today's behaviour: `duration` is
  carried unconditionally (`restructure.ts:394`); every other member, `audioTakeId` included, is
  carried only when the content is unchanged (`restructure.ts:409-416`).
- **Exclude's clear** clears every member.
- **The analysis persist's rebuild (W16, R6-4, restated by R7-6; revision 8 names the function)** carries every
  member from the fresh state it already reads under `book` → `state-json`. It uses the PUT's match
  (`sameChapter`: `id` **and** `slug`, `chapter-uuid.ts:38-40`), through a new sibling of the PUT's
  carry in `chapter-uuid.ts`, `carryTakeStateFields(incoming, existing)`. For each rebuilt chapter it
  finds the disk chapter by `id` (`indexById`) and accepts it only when `sameChapter` holds, as
  `carryServerOwnedChapterFields` does (`:153-156`). It then copies each `TAKE_STATE_FIELDS` member
  that disk chapter has, and **strips nothing**. Revision 7 put a field-list parameter "on
  `sameChapter`", which is a two-argument predicate and cannot take one. The persist does **not**
  go through `carryServerOwnedChapterFields`, as a whole or with a list, because that function:
  - also carries `CLIENT_CLEARABLE_CHAPTER_FIELDS` (`generationState`, `generationError`,
    `generationErrorCode`, `generationRemediation`, `chapter-uuid.ts:131-136`);
  - deletes every listed field from every incoming chapter before it copies (`:158-159`), so an
    unmatched chapter would lose the rebuild's placeholder `duration`.

  So:
  - a re-analysis still clears every chapter's failure stamps, as on `main`, where the rebuilt
    chapters never carry them (`analysis.ts:8604-8630,10749-10775`). That is wanted: a re-analysis
    can change the cast that a failure came from, so the old failure no longer describes the
    chapter;
  - an unmatched chapter keeps the rebuild's own values, its placeholder `duration` included;
  - a chapter with a live take keeps its slug (#4230), so it matches and its take fields carry; a
    chapter with no live take whose slug changes still matches nothing, and its members drop, which
    is harmless because it has no take;
  - the carry writes only values it read in the same locked read, so it can never fill a member
    from the wrong take.

  What this saves over `main` is `audioQa`, which is not in `HEALED_KEYS` (`scan.ts:1165`), and
  `audioTakeId`, which the heal never fills. `duration` is not a saving: the heal already refills a
  `00:00` duration from the segments (`scan.ts:1221,1266-1270`). Revision 6 said otherwise.
- **The scan heal** (`HEALED_KEYS`, `scan.ts:1165`) takes its fill rule from the module as
  `healTakeFields` (§4.4), which lives in the module's leaf `workspace/take-fields.ts` with this
  list (R10-2). It fills only absent members, never `audioTakeId`. `uuid` stays the heal's own
  non-take field.

### 4.4 `deriveTakeFields` and `stampStateFromLiveTake` (F2, F21)

`deriveTakeFields(segments)` is one pure function. It is used by the stamp **and** by `scan.ts`'s
`deriveSegmentsHeal`, which today backfills the raw `meta.modelKey` (`scan.ts:1281`):

| `state.json` field | Derived from |
|---|---|
| `duration` | `formatDuration(durationSec)` |
| `audioModelKey` | `effectiveAudioModelKey(engineBreakdownFromSnapshots(characterSnapshots), modelKey)`, exactly as finalize does (`:676-677`), **never the raw `modelKey`** |
| `audioEngines` | the same breakdown |
| `audioRenderedAt` | `synthesizedAt` |
| `audioQa` | `qa` |
| `audioTakeId` | `takeId` |

`stampStateFromLiveTake(handle, slug)` runs inside `book` → `state-json` and sets every field it
derives. What it does with a field it cannot derive depends on whether the take changed (R6-8,
revision 6):
- **A stamp of the same take** (`ensureTakeIdentity`'s mirror, migration's fill of absent fields)
  leaves such a field as it is.
- **A stamp that changes which take is live**, or that moves `state.json` onto the live take from
  fields describing another one, writes every member. That means the commit, restore, R3-5's
  promotion, `replaceTakesFromBundle`, `reconcileBookTakes` after a backup restore, migration's
  legacy-reject re-stamp (§6.1 step 5), and their replays (revision 7 adds the last two, R7-7). A
  member the new live segments lack is **cleared**, never left describing the take that was live
  before. So a backup's `audioQa` from an older take does not survive over a live take with no
  `qa`. When the new live take has no `segments.json` at all (an unindexed take, §4.2), every member
  is cleared except `duration`. Such takes exist: `main`'s preserve swallows a failed segments
  rename after the audio has moved (`preserve-previous-audio.ts:53-66`). Revision 5 left those
  fields as they were, so restoring such a take kept the rejected take's fields, the F2/H3 shape.
  - **`duration` of an unindexed take (R7-7, revision 7)** is measured by §6.1 step 2's **full
    decode** (`ffmpeg -i <f> -f null -`), not by ffprobe's header estimate, which is about 7× too
    long on legacy MP3s with no Xing header (`tts/mp3.ts:173-177`). Revision 6 used ffprobe for
    exactly these takes, which are mostly legacy. The decode runs in the caller's book-op span
    **before** the stamp takes `book`, never inside `book` → `state-json`, whose other waiters have a
    10 s budget. A journalled op (restore, promotion, replace) records the measured seconds in its
    journal before its first rename, so a replay stamps from the journal and never decodes again.
  - **No decode ever runs while `book` is held (R8-3, revision 8).** Revision 7 claimed that and
    then placed two decoding paths inside `book` (pass 7, J8). `book` has no acquisition timeout
    (`book-lock.ts:57-86`), and the library-scan heal takes it (`scan.ts:811,1194`), so a decode
    there could hang a library listing. The rule is now general: **every entry point's step 0 runs
    before its caller takes `book`**, and so does every decode. The two paths revision 7 got wrong:
    - **restructure** reads its slug plan under `book`, releases it, runs `relabelTakes`' step 0
      (which may promote, R3-5, and resolve a multi-live slug, §6.1 step 2) under book-op → gate,
      and takes `book` again for its closure (§5.A Restructure);
    - **backup restore** releases `book` once `restoreBackup` has swapped `state.json`, and
      `reconcileBookTakes` runs after that, under book-op alone. Each chapter's stamp takes `book`
      → `state-json` for its own write only.
  - **`reconcileBookTakes` rarely decodes (R8-3).** Revision 7 had it decode every unindexed
    chapter on every restore, which is not rare. A backup restore changes no audio, so the
    `state.json` it replaces described the audio on disk. `restoreBackup` therefore reads that
    pre-restore state before its swap, and `reconcileBookTakes` gives an unindexed live take the
    pre-restore `duration` of the chapter it matches there (`sameChapter`). It decodes only a chapter
    that matches nothing, or whose pre-restore `duration` is absent.
  - **`dropAllTakes` never decodes.** Its step 0 skips §6.1 step 2's multi-live resolution, because
    exclude discards every live file whichever one is chosen.
  - **A failed decode** clears `duration` and logs the chapter. Nothing can refill it until the next
    render, because there are no segments for the heal to read. That is still better than `main`,
    whose Reject never stamps, so `duration` keeps describing the rejected take.
  - The decode costs seconds per long chapter, under book-op. It runs only for an unindexed take
    becoming live, which is rare.

A **commit's** stamp also clears
`generationState*` in the same write, as finalize does today (`:806-809`). The commit journal
records `clearGenerationState: true`, so a replayed commit stamp clears them too (R3-7).

**`healTakeFields`** is the scan heal's fill rule, moved into the module (A9). It is a pure
function in the module's leaf `workspace/take-fields.ts` (R10-2, below): given the fresh chapter
`persistHealPatches` read under its lock, the heal's patches and the slugs the book's journals
name, it returns the merged chapter. `persistHealPatches` (`scan.ts:1188-1237`) keeps its locked
write and applies the rule inside its `updateStateJsonLocked` callback, so the write keeps today's
lock shape. The heal is one of the **two** take-field writers that run without book-op, and
`persistHealPatches` is on the guard's allowlist by name. The other is the analysis persist's
carry (W16), which only carries values it read (§4.3). That is safe because of how it writes,
which is today's `persistHealPatches` unchanged:
- it runs under `book` → `state-json`;
- it re-derives from the live segments under the lock;
- it fills only absent members, never `audioTakeId`;
- **it skips every slug a journal names (R5-2, revision 5)**, checked **after** it reads the
  segments (R6-11, revision 6).

A commit's stamp serialises with it on `book`. A heal that lands before the stamp is overwritten by
it. A heal that lands after the stamp finds nothing absent. Its callers (`scan.ts:809,1347`) are
unchanged, and it stays on CLAUDE.md's swallow list ("segments backfill").

**Why the skip is needed (pass 4, B2).** Revision 4 said a heal is always followed by a stamp, and
that is not true while a journal is open:
- The heal runs inside every `withBookOp` resolve, before the callback and so before any entry
  point's replay (`book-op-lock.ts:262,424`, `scan.ts:1304-1347`). It also runs on the unlocked
  library-scan paths (`scan.ts:823,1126`).
- A merge's surviving chapter keeps its slug with `contentChanged: true`. The restructure drops its
  take fields (`restructure.ts:409-416`) and emits a delete on that slug (`:450-452`). Under E1 the
  delete runs in the `drop` group, after `stage`.
- While a relabel is stuck at `stage`, the pre-merge take still sits at the slug. A heal there would
  fill the merged chapter's fields from that take. Once replay drops the take, nothing corrects
  them: the heal is fill-only, and a dropped take is never stamped.
- `main` avoids this because restructure holds `book` across both its state write and its audio ops
  (`chapters-restructure.ts:331`). `persistHealPatches`'s own comment names this merge shape
  (`scan.ts:1209-1213`). E1's journal outlives that span.

So the heal contributes no patch for a slug that a per-slug journal names, or that a book journal
names as a `from`, a `to`, a `drop` or a `clearStalePrevious`. The check is made in the locked merge
under `book`. The restructure writes its journal while it holds `book`, so the heal sees either the
pre-restructure state, which the restructure's own state write then recomputes, or the journal.

**Read first, then check (R6-11, revision 6).** Revision 5 said the same skip covered a commit or
restore journal whose install a replay may still roll back. That held only for the heal in a
`withBookOp` resolve, which book-op serialises with commits. The library-scan heal holds only
`book`, and a commit's renames take no `book` until its stamp. A heal that checked "no journal"
first could then read segments that the commit's step 6 had just installed, and fill fields from a
take that a rollback then removes. So the heal reads each slug's live segments **first** and checks
for a journal **after**, both under `book`, which it holds across the two. That order closes it:
- a commit or restore writes its journal (step 3) before it installs anything;
- **every journal unlink takes `book` (R7-1, revision 7).** That covers cleanup after a stamp, and
  also the paths that never stamp: the in-span rollback before `installed`, a replay's rollback in
  `reconcileSlug`, and a relabel's `cleanup`. The unlink takes the same `book` key that
  `persistHealPatches` takes (`scan.ts:1194`). Revision 6 said "it unlinks the journal only after
  its stamp, and the stamp needs `book`". That was true only on the success path: a rollback
  unlinked its journal holding book-op alone, so a library-scan heal could read installed segments,
  the rollback could finish and unlink, and the heal's check would then find no journal (pass 6,
  G2).

**The key both sides take (R8-4, revision 8).** The heal keys `book` on `state.bookId ?? bookDir`
(`scan.ts:811,1347`). Revision 7 said the unlink takes "the same key", which held only for a book
with an id (pass 7, J9). The two unaddressed callers have none: the fsck walker's book has no id,
and the no-`bookId` bundle overwrite's book gains a freshly minted one at the swap (`:490`), while
its directory comes from `bookDirByDisplay` and can be spelt differently from the walk's. So:
- a `book` key taken from a directory always goes through `canonicalDirKey` (Ownership, below):
  the heal's fallback, and `updateStateAtDir`'s (`book-state-update.ts:72`);
- an `UnaddressedBookHandle` takes `book` under `canonicalDirKey(handle.bookDir)` for its whole life,
  for every unlink and stamp, even after the swap has given the book an id;
- the heal checks the process-local unaddressed set **after** it takes `book`, and skips a book
  whose canonical directory is in it. The handle registers in the set before it does any take
  work, so a heal that started after registration skips the book, and a heal that started before
  it read a state with no id and holds the same canonical key the handle's writes wait on. The skip
  is a swallowed lazy migration, so the next scan repeats it.
- **Where they live (R9-6, revision 9; pass 8, K9).** `canonicalDirKey` and the unaddressed set
  live in a new leaf, `workspace/book-dir-key.ts`, which imports nothing from `server/src` (only
  `node:path`), as `book-lock.ts` and `gpu/active-generation-gate.ts` are leaves. `scan.ts`,
  `book-state-update.ts`, `chapter-take.ts` and `scan-import-folder.ts` import it. Revision 9 said
  that kept `check:cycles` clean. It keeps only the leaf's own edges clean (pass 9, L4): `scan.ts`
  also needed the module's heal rule, derivation and predicate, below.
- **What `scan.ts` takes from the module, and from where (R10-2, revision 10; pass 9, L4).**
  `chapter-take.ts` imports `scan.ts`'s state types (`BookStateJson`, `scan.ts:55`) and
  `updateStateJsonLocked` from `state-migrate.ts`, which imports `scan.ts`'s types back
  (`state-migrate.ts:30`). A type-only import is an edge for `check:cycles`: the allowlisted
  `scan.ts` ↔ `chapter-uuid.ts` cycle is one `import type` (`chapter-uuid.ts:24`,
  `madge-cycles-allowlist.json:10`), and `scan.ts` ↔ `state-migrate.ts` is the same (`:11`). So
  `scan.ts` importing `chapter-take.ts` would close new cycles whatever moved where. Instead, what
  `scan.ts` needs lives in a second leaf, `workspace/take-fields.ts`:
  - `TAKE_STATE_FIELDS`, `deriveTakeFields`, `healTakeFields`' fill rule, the live-take predicate
    (§4.2), and `journalNamedSlugs`, the heal's journal check, which lists the book's `audio/`
    journals and reads its book journals' plans with `node:fs`. A journal it cannot read or parse
    makes the heal skip the whole book for that scan, a swallowed lazy migration that the next
    scan repeats;
  - its input types are structural, declared in the leaf (the six members, and the segments
    fields `deriveTakeFields` reads), so it imports neither `scan.ts` nor `audio/segments-io.ts`;
  - its whole import closure is at most `audio/format-duration.ts` (no imports),
    `audio/engine-breakdown.ts` (whose only import is `tts/model-keys.ts`, which has none),
    `workspace/chapter-audio-file.ts` (until its take-name builder folds into the leaf, Blast
    radius) and `util/safe-path.ts`, which between them import only each other and `node:`
    builtins, and `node:` builtins. None reaches `scan.ts`.

  `scan.ts` imports the two leaves and never `chapter-take.ts`, which re-exports the leaf's names,
  so callers still see one module. `chapter-take.ts` → `scan.ts` then closes no cycle, provided
  nothing in `scan.ts`'s own import closure imports `chapter-take.ts`. Phase 1's reader migration
  therefore points `scan.ts`, and any module `scan.ts` reaches, at the leaf, not at `chapter-take.ts`
  (§7 Phase 1 step 2). `check:cycles` against `madge-cycles-allowlist.json` is the gate that
  catches a miss. No cycle is added to the allowlist. The guard (below) treats `take-fields.ts` as
  part of the module.

So if the read saw installed segments, their journal still exists when the check runs: a rollback
can finish its renames during the heal, but its unlink waits for the heal's `book`. The slug is
skipped. If the check sees no journal, the read saw either the take from before the commit, which
the commit's stamp then overwrites, or a finished commit, whose stamp left nothing absent. Taking
`book` for an unlink adds no edge: book-op → `book` exists, and nothing else is taken while it is
held.

The stamp is a pure function of the live `segments.json`, so running it twice is the same as
running it once. It is used by:
- the commit;
- restore;
- journal replay;
- `ensureTakeIdentity`;
- `reconcileBookTakes` (backup restore, W14);
- migration's legacy-reject re-stamp (§6.1 step 5).

## 5. Options

### Option A: one take module, commits inside a book-op span (accepted)

**Ownership (F4, F19; D3).**

`chapter-take.ts` holds:
- the **only** take-path builders, plus read-only accessors for readers;
- the live-take predicate (§4.2) and `TAKE_STATE_FIELDS` (§4.3), re-exported from its leaf
  `workspace/take-fields.ts`, with `deriveTakeFields` and `healTakeFields` (R10-2, §4.4);
- every take mutation.

Each entry point takes a live `BookHandle`, and each starts with `reconcileBook` (book journals),
then `reconcileSlug` and `ensureTakeIdentity` for each slug it touches.

**A stuck journal blocks only the slugs it names (R5-3, revision 5).** A book journal names the slugs
it lists as a `from`, a `to`, a `drop` or a `clearStalePrevious`. A per-slug journal names its own
slug. `reconcileBook` attempts a book journal only when the entry point touches one of the slugs it
names, or is book-wide: a new restructure, backup restore, the bundle overwrite, a PUT that sends
`chapters` (R6-5), the boot fsck.
- **What a failed replay answers depends on the protocol step that threw (R7-4, revision 7).**
  Revision 6 decided the class from the error. That cannot work: `writeJsonAtomic` ends in
  `renameWithRetry(tmp, path)` (`state-io.ts:392`), so a `state.json` write on a held file fails
  with exactly the EBUSY/EPERM/EACCES-from-a-rename that revision 6 called the rename class (pass 6,
  G5). The class is therefore a property of the step, never of `code` or `syscall`:
  - **Move step** (a take-part rename, or a quarantine, which is a rename), with any error code: the
    slug stays blocked. Its retries are `renameWithRetry`'s own, which retries EPERM, EBUSY, ENOENT,
    EACCES and EIO for about 3.6 s (`atomic-rename.ts:41-47`). A rename that throws `ENOENT` is not
    a move-step failure: replay re-probes both names and takes the matching row, "lost" included
    (R8-1, Journal rules). An entry point on a named slug answers 409 `take_repair_pending` with
    **one sentence for every code** (R8-2, revision 8): "Some of this chapter's audio files could
    not be moved into place. Close any other program using the book's folder, and check free disk
    space and the folder's permissions, then try again." A **book-wide** operation that refuses
    with `take_repair_pending` (backup restore, the bundle overwrite, a PUT that sends `chapters`,
    a new restructure) answers the same sentence with "this book's" for "this chapter's"
    (R9-8, revision 9; pass 8), because none of them is about one chapter. Revision 7 chose between two sentences by
    `code`, which gave EACCES a held-file diagnosis here and a permanent one at a record step out of
    the same `renameWithRetry` call (pass 7, J2). A job that has already flushed its event-stream
    headers (splice, `chapter-splice.ts:136-140`; QA repair, `chapter-qa-repair.ts:126-130`) sends
    the `chapter_failed` frame it already fails with, carrying `code: 'take_repair_pending'` and the
    same sentence, as a render's `chapter_failed` does. **Since E15 (revision 10) a move step
    refuses only when the OS refuses a rename**, which is the cause the sentence names. Revision 9
    also refused two copies of one part at two slug names, behind this sentence, which named neither
    that cause nor the file (pass 9, L2); E15 decides those copies instead (Journal rules).
  - **Record step** (a stamp, `dropEntry`, the review record, a journal or cursor write, a journal
    unlink, or a read of a journal or part that replay decides from): the files are where the
    journal put them, so nothing is blocked. **Nothing about it is decided by `code` (R8-2,
    revision 8).** Revision 7 split it into transient (a lock timeout, EBUSY, EPERM) and persistent
    (ENOSPC, EACCES, EROFS) through `requestFailureMessageFs`' message table, which chooses wording
    and was never a retryability oracle: a permanent EPERM (an ACL deny) then ran to the 720 s
    watchdog and ended "in use", and EIO, EMFILE and ENOENT had no class at all (pass 7, J2). Now:
    - **at a quick op**, it answers `requestFailureMessageFs(err, FS_FAILURE_REQUEST_ERROR)` as a
      500 at once. The user's retry is the next attempt;
    - **in a job** (a render's chapter-start span, a commit's step 0, splice and QA repair's
      base-read span), it gets the **record-step budget**: three attempts, the first in the span
      and two more in fresh spans after 1 s and 2 s, the shape of R4-10's three acquisitions. The
      watchdog never bounds it. After the third, the job ends with
      `requestFailureMessageFs(err, FS_FAILURE_REQUEST_ERROR)`, which answers
      `LOCK_CONTENTION_REQUEST_ERROR`, `FS_PERMANENT_FAILURE_REQUEST_ERROR` or
      `FS_FAILURE_REQUEST_ERROR` by the last error, and the fixed fallback for anything that is not
      an fs error. `code` chooses that sentence and nothing else;
    - **one exception, E10 with E12's list as widened by E14:** at a render's chapter-start span
      and a commit's step 0, a supersedable journal (a commit or `replace` journal at `installed`
      or later, a restore or promotion journal at `stamp` or later, §4.1) is not retried at all. The
      commit supersedes it (Commit step 0). A drop or Accept journal is not on the list and gets
      the budget.

    There is no "`book` timeout": `withBookLock` is a bare promise chain with no acquisition
    timeout (`book-lock.ts:57-86`). Revision 6 named one.
  - **Unparseable journal:** quarantined with the jid-tagged files it was moving (R6-3). It then
    blocks nothing. "Unparseable" means the bytes do not parse (`readJson`'s `SyntaxError`,
    `state-io.ts:205-222`) or they parse and fail the journal schema. A journal that cannot be **read**
    (EBUSY, EPERM, or any other error from the read) is a record-step failure and is never
    quarantined, as `readStateJsonWithRecovery` (`state-migrate.ts`) keeps "unreadable" apart from
    "unparseable" (pass 6, G5).
  - **Splice and QA repair's base-read span (R7-5)** ends the job on a record-step failure that
    outlasts its budget, before anything is staged: the `chapter_failed` frame carries
    `requestFailureMessageFs(err, FS_FAILURE_REQUEST_ERROR)`, never the error's own message. The
    user retries, and the retry is the entry point that replays.
- An entry point on other slugs proceeds, and logs the stuck journal once per span.
- A new restructure is refused while a book journal is stuck, because it needs the whole map. It is
  refused too while a per-slug journal on a slug its plan names is stuck (R6-10).
- Scoring skips named slugs, as a CAS skip that does not re-arm.

Revision 4 had every entry point fail on any failed book replay. That turned one locked file into an
unrenderable book (pass 4, most dangerous assumption).

**What recovers a blocked slug (corrected in revision 6).** Revision 5's sentence said "Castwright
finishes the move automatically". That is true only for R4-2's 60 s of background retries after a
restructure. After that, only an entry point on a named slug, a book-wide operation or a reboot
replays the journal. Reads never do. So the sentence now tells the user to try again once the
holder is closed, and the try is the entry point that finishes it.

| Entry point | Replaces or serves |
|---|---|
| `commitTake` | finalize's preserve and install |
| `acceptTake` | accept's audio step |
| `restoreTake` | reject's audio step; R3-5's promotion |
| `dropAllTakes` | exclude's deletes (revision 7: exclude only, R7-3) |
| `relabelTakes` | restructure renames **and** delete ops: `rewriteChapterSlugs` moves into the module, and its `drop` group applies `dropAllTakes`' only-copy rule (R7-3) |
| `commitScoring` | the scoring and attempted-marker writes (F23) |
| `replaceTakesFromBundle` | the bundle overwrite's `audio/` subtree (W13, R3-8) |
| `reconcileBookTakes` | after a backup restore (W14, R3-9), and the fsck's per-book step |
| `stampStateFromLiveTake` | the state stamp (§4.4) |
| `reconcileSlug` / `reconcileBook` | journal replay and the sweep |
| `ensureTakeIdentity` | lazy minting (§4.1) |
| `healTakeFields` | the scan heal's take-field fill rule (§4.4), in the leaf `take-fields.ts` and applied by `scan.ts`'s `persistHealPatches` (R10-2); the one entry point that takes no `BookHandle` |

- QA repair's Edit 6b embeddings (fresh rows) and verdict **patches** become **staged inputs** to
  `commitTake` (OD4). They are no longer post-finalize writes.
- The reparse/replace wipe of `audio/` stays where it is, on an **allowlist**. It is a
  whole-directory removal under book-op with no job registered, and it touches no single take. It
  removes every entry of `audio/` **except `.orphaned/`** (R4-5). Today it is
  `rm(ad, { recursive: true })` (`book-state.ts:1838`), which would take `.orphaned/` with it. The
  wipe also removes every journal and every relabel temp name with the takes (R5-5). It discards
  every take on purpose, so there is nothing for a journal to finish.
- The bundle overwrite's generic rename loop **excludes `audio/`**, and a test pins that. The
  module installs each bundle chapter as a whole live take: it mints a `takeId` when the bundle's
  segments lack one, stamps state, and replaces that slug's local live and previous takes whole.
  It is the commit protocol with both local takes discarded (journal `op:'replace'`).
  - **Placement (A14).** `replaceTakesFromBundle` runs **after** the overwrite's
    `withStateJsonLock` rename loop has returned (`scan-import-folder.ts:526-535`), still under the
    claim and book-op, inside the `try` whose `finally` drops the ManuscriptRecords and clears the
    cache (`:537-555`). It is never called inside the loop: its stamp takes `book` → `state-json`,
    and `state-json` is not re-entrant, so a call inside the loop would wait out its own 10 s
    timeout.
  - **A failure is parked.** The remaining chapters are still installed, the `finally` still runs,
    and then the error rethrows into the import's outcome.
  - **A pending journal is resolved first (R5-5).** Before the rename loop swaps `state.json`, the
    overwrite runs `reconcileBook` and `reconcileSlug`, in the same book-op (or unaddressed) span. A
    replay that fails on a move-step failure refuses the import with `take_repair_pending`, and
    nothing is swapped. Backup restore does the same before it restores `state.json`, over every
    slug. Otherwise a relabel journal would be judged against a state that the writer just swapped
    in (pass 4): past `state-landed`, its audio would move to slugs that the restored state does not
    name.
  - **Where that replay runs (R6-7, revision 6).** `commitOverwrite`'s span is a
    `withBookPathClaim` (`scan-import-folder.ts:476`), a **workspace-wide** key. `reconcileSlug`
    includes lazy migration, whose multi-live step decodes audio in full, and `renameWithRetry`
    can spend about 3.6 s on each held part. Under the claim, that could hold every other book's
    move, create and import past their 10 s budget. So the replay runs **before** the claim is
    taken: under book-op in the `withBookOp` branch (book-op is taken before the claim there, lock
    order book-op → book-path-claim), and under the registered `UnaddressedBookHandle` in the
    other branch (below). It is also scoped to what the overwrite keeps:
    - `reconcileBook` runs every book journal, because a relabel that is left half-done would leave
      temp names behind whatever the bundle installs;
    - `reconcileSlug`, lazy migration included, runs for the local chapters the bundle does
      **not** carry. Those are the takes the overwrite leaves whole (R3-8);
    - **for a slug the bundle does carry, the per-slug journal is replayed too, without lazy
      migration (R8-5, revision 8).** That replay is renames and a stamp, which are fast, and it
      never decodes. Revision 7 left those journals unreplayed and discarded them inside
      `replaceTakesFromBundle`, after the swap (R7-10). A crash between the swap and that discard
      then left a local commit or restore journal to be replayed against the **bundle's** state:
      the local take rolled forward or back, the bundle's audio for the slug was lost with the
      import's stage directory, and the state described the bundle while the disk held the local
      take (pass 7, J10). Replayed before the claim, **a carried journal whose replay completes**
      does not outlive the swap (revision 9 limits the claim to that case; pass 8, K10). An import
      that fails after such a replay (for example `BundleConflictError`,
      `scan-import-folder.ts:480`) leaves nothing pending, because the journals have finished;
    - a carried slug's journal whose replay fails on a **move step** refuses the import with
      `take_repair_pending`, as any other replay does (R5-5). One on E12's supersedable list (§4.1,
      with E14's `replace` journals) whose replay fails on **record steps** only does not refuse,
      and it **does** outlive the swap: `replaceTakesFromBundle`'s `replace` journal supersedes it
      after the swap, exactly as a commit does under E10 (Commit step 0), absorbing its discard set.
      **So does a carried drop journal stuck on record steps (E14, revision 10; pass 9, L7).** What
      it owes is moot or dominated after the swap: the `excluded: true` write and the take-field
      clear by the swap itself, which replaces `state.json` with the bundle's and so decides
      `excluded`; its entry drop by the `replace`'s own `dropEntry` (R6-8); its discard set and its
      file by the `replace`'s step 8. A render's commit still may not supersede a drop journal
      (E12), because no commit swaps `state.json`. Any other carried journal whose replay fails on
      record steps (an Accept journal, a rolled-back journal owing its unlink, a journal that cannot
      be read) refuses the import with `requestFailureMessageFs`' curated 500, and nothing is
      swapped. Revision 8 admitted every journal "whose move steps have all landed", which
      disagreed with step 0's list (K10); revision 9 refused a carried drop journal too (pass 9,
      L7). If the server crashes before the supersession, the next replay of that journal finishes
      it against the state that is then on disk, the bundle's: a commit, restore, promotion or
      `replace` journal stamps `state.json` from the local take that is still live, so the state
      describes the disk, and a drop journal finishes the exclude it owed on that chapter. Either
      way the bundle's audio for that slug is lost with the stage directory, and the user imports
      again.
  - **Handles (R5-7, restated by R6-6).** The `withBookOp` branch (`scan-import-folder.ts:571`)
    threads its handle through `commitOverwrite`; today its callback ignores the handle. The branch
    for a target with no `bookId` (`:570`) holds no book-op, because no `/:bookId` route can reach
    that book. It mints an `UnaddressedBookHandle` **before** the claim (revision 5 minted it inside
    the claim), so that R6-7's replay can run under it, and holds it until `commitOverwrite`
    returns. Once the bundle's `state.json` lands, though, the book carries a freshly minted id
    (`:490`), and a route that learned the id from a library listing could reach it while the
    handle is still held. So both unaddressed kinds (the fsck's and this one) register their
    directory in a process-local set.
    - **Registration ends in a `finally`.** A throwing overwrite or fsck step still removes its
      entry, so a failure never leaves the book `book_busy` until a restart.
    - **The key is canonical.** A `BookHandle`'s `bookDir` comes from the index or a walk, but the
      overwrite's comes from `bookDirByDisplay` (`scan-import-folder.ts:559`), so the same folder
      can arrive spelt two ways. Both sides use one function, `canonicalDirKey`: `path.resolve`,
      separators normalised to `/`, a trailing separator dropped, and lower-cased on win32 and
      darwin, whose default filesystems are case-insensitive. The same function forms every `book`
      lock key taken from a directory, and an unaddressed handle keys its `book` acquisitions on it
      for its whole life (R8-4, §4.4). It and the set live in the leaf `workspace/book-dir-key.ts`
      (R9-6, §4.4).
    - **Unicode normalisation is out of scope (R7-11, revision 7).** The key does not normalise
      NFC against NFD. On darwin a display-derived NFC name and an NFD name on disk would miss each
      other in the set, and the fence would fail open for that book while the overwrite runs. That is
      an edge case (a book folder whose name has a precomposable character, imported on darwin) and
      is listed under Remaining.
    - A module entry point given a `BookHandle` whose canonical directory is in the set answers
      `book_busy`. A second unaddressed handle for a directory already in the set is refused: the
      fsck skips the book for this boot, and the overwrite answers `book_busy`.
    - **What the set fences.** It fences the module's entry points, so it closes the window for take
      writes. It does not fence the PUT, cast or listen-progress writes that reach the freshly
      minted id. That gap is pre-existing on `main` and is not widened here.
- **Backup restore's handle (R6-6, revision 6).** Today `withBookOp(bookId, () => …
  restoreBackup(bookId, file))` ignores its handle (`routes/backup.ts:45-53`), and `restoreBackup`
  locates the book again itself through `withLocatedBook` (`workspace/auto-backup.ts:209-214`). That
  is B6's shape. `restoreBackup` now takes the handle and uses its `bookDir`. It keeps the `book`
  lock for its own writes (book-op → `book`), reads the pre-restore `state.json` before its swap,
  and **releases `book`** before it calls `reconcileBookTakes` with the same handle and that
  pre-restore state, so no decode runs inside `book` (R8-3, §4.4).
- The PUT `/state` (W15) owns no take files. It is covered by `TAKE_STATE_FIELDS`, and by R4-4 (as
  restated by R5-8 and R6-5) for the slug binding.
- The analysis persist (W16) owns no take files either. It is covered by `TAKE_STATE_FIELDS`
  through its carry (R6-4, §4.3).

**The guard** is `workspace/chapter-take.guard.test.ts`, in the shape of
`state-json-lock.guard.test.ts`: the shared TypeScript-parser-backed scan in
`test-utils/guard-scan.ts`, over `server/src` non-test files. It is a **tripwire, not a proof** (E4).
D3 ("the module owns every writer") rests on the module's API and on review. The guard catches the
shapes below and lists the rest as blind spots. It fails on:
1. any template literal or `join` that forms `<slug>.<takeSuffix>` (the module's suffix table,
   `.previous.*`, `.next-*` and `.discard-*` included) outside the module (`chapter-take.ts` and
   its leaf `take-fields.ts`, R10-2) and its allowlist;
2. any **mutation call** whose path argument comes from such an expression. The mutation calls
   are:
   - `rename`, `renameWithRetry`, `rm`, `unlink`, `writeFile`, `writeJsonAtomic`, `writeEmbeddings`,
     `writeVerdicts`, `mergeVerdictRows`, `writeAttempted`, `writeChapterPeaksFile`,
     `writeChapterLufsFile`;
   - their `*Sync` variants, `copyFile`/`cp`, `createWriteStream`, `mkdir`, and `open`/`openSync`
     with a write-flag literal;
   - each matched as a bare call or as a member call (`fs.rm`, `fsp.rename`);
3. any mutation call outside the module whose path argument is rooted at `audioDir(…)` or an
   `audio/` literal, **either inline or through `const` bindings in the same function**, followed
   transitively. Rule 3 sees such a write whatever the suffix, because it follows the root, not the
   suffix.
   - **The resolver is new code (revision 5).** `test-utils/guard-scan.ts` today exposes literal
     and comment range detection and file collection only, with no scope or binding resolution
     (`:1-60,144-226`). Phase 1 step 7 adds a same-function `const` resolver to it, with its own unit
     tests.
   - **Hop kinds.** A binding is tracked when its initialiser is:
     - a root;
     - a `join`/`resolve` call with a tracked argument;
     - a template literal whose head expression is tracked;
     - another tracked `const` (an alias).
   - **Path arguments, per call.** `rename`, `renameWithRetry`, `copyFile` and `cp` use arguments 0
     and 1. `writeChapterLufsFile(payload, path)` uses argument 1, and
     `writeChapterPeaksFile(pcm, sampleRate, path)` argument 2. Every other mutation call uses
     argument 0.
   - **Finalize has all three hop kinds**, and it is the realistic shape:
     - `audioRoot = audioDir(bookDir)`, then `audioPath = join(audioRoot, …)` (`:215-217`), then
       `rename(…, audioPath)` (`:777`);
     - `tmpAudio = \`${audioPath}.tmp-…\`` (`:242`), then `writeFile(tmpAudio, …)` (`:244`), the
       #4167 site;
     - `writeChapterLufsFile(payload, lufsPath)` (`:296`) and
       `writeChapterPeaksFile(pcm, sampleRate, peaksPath)` (`:780`).

**Blind spots**, listed in the guard's header in the shape of `state-json-lock.guard.test.ts`'s
"FALSE NEGATIVES":
- **a variable suffix or root that arrives from outside the function**: a parameter (`audioRoot`
  in `rewriteChapterSlugs`, `findChapterAudio`), a helper's return value (`suffixPath`,
  `rewrite-chapter-slugs.ts:105-106`), a `let` that is reassigned;
- **a path taken from an array or loop variable**: exclude's
  `for (const p of [segmentsPath, ...audioCandidates]) rm(p)` (`book-state.ts:2421-2427`);
- **a zip-relative path**: the bundle overwrite's `rename(join(stage, rel), join(targetDir, rel))`
  (`scan-import-folder.ts:528-530`), which has no `audioDir(` and no `audio/` literal;
- an aliased named import (`import { rename as mv }`);
- a variable from another module;
- a new caller of a module entry point that holds no book-op (the `BookHandle` capability check
  catches that at runtime instead);
- `scripts/*.mjs` and anything outside `server/src`.

Every blind-spot site on `main` (R-k, exclude's loop, `rewriteChapterSlugs`, `previous-audio.ts`,
the bundle loop's `audio/` entries) **folds into the module in Phase 1**. They are removed, not
guarded.

**Allowlist:**
- read-only builders in R-a…R-k, which migrate to the module's accessors in Phase 1, after which
  the allowlist shrinks to zero;
- the reparse wipe.

**Fence and lock placement.**
- **Entry points never lock.** Each one takes a live `BookHandle` (book-op's capability token),
  and the module refuses a stale or hand-built one, as `moveBookFolder` does. That keeps book-op's
  "one level only, never inside a shared helper" and "never nest" rules.
- **Quick operations** (accept, reject, exclude, restructure, the bundle overwrite, backup restore,
  the fsck step) already hold book-op at their route or walker level. They pass their handle in.
- **The fsck's handle (R4-8).** `withBookOpAtDir` (`book-op-lock.ts:475-490`) hands its callback a
  directory today, and runs unlocked for a book with no `bookId`. It changes to hand over a handle in
  both branches: book-op's `BookHandle` when the book resolves, and an `UnaddressedBookHandle`
  otherwise. The module accepts the unaddressed kind from the fsck's walker and from the bundle
  overwrite's no-`bookId` branch only (R5-7). No `/:bookId` route can reach such a book until it
  gains an id. The process-local set of unaddressed directories (Ownership, above) refuses the one
  route that could reach it after the bundle's id lands, and refuses a second unaddressed holder.
- **A long job** opens `withBookOp` only at its own commit site, around `commitTake`. It holds no
  book-op of its own, so this is not nesting.
- **Scoring:** `scoreBook` is a shared function, so it never calls `withBookOp`. Its caller
  (`triggerScoring`'s `runBookJob` body, or the resume route) passes a
  `commit: (fn) => withBookOp(bookId, fn)` callback, and `scoreBook` calls `commitScoring` through
  it.
- Finalize splits into `prepareTake` (no lock) and the caller-invoked `commitTake`.

**Prepare** (`prepareTake`, no lock; N14, N15). Every new part is written to
`<slug>.next-<takeId>.<suffix>`: audio; segments (with `takeId`); peaks; lufs; embeddings (fresh
rows only, with `takeId`); fresh verdicts, if any. QA repair's verdict patches stay in memory and
are passed to `commitTake`, which applies them at step 4.
- **Nothing live is touched.**
- **No directory is ever created.** The staging writer opens each file with `wx` in the existing
  `audio/` directory. If the directory is gone (the book moved after a watchdog released the
  token), it gets ENOENT and stops. It never recreates the folder (N15).
- **The signal is checked before each part.** Generation's watchdog aborts `chapterCtrl`, so an
  abandoned body stops at its next part.
- The module records each in-process staged `takeId` in a process-local `liveStaging` set until the
  job's commit or exit. The sweep (below) uses that set to tell a live staging from an orphan.
- **Precondition: one server process per workspace (A10).** Nothing enforces it. The only
  single-owner guard is the sidecar port's (`index.ts:386-396`). book-op is process-local too, so a
  second process already breaks every lock in the order. The sweep only makes that failure louder:
  it deletes the other process's staging. Enforcing a single owner is out of scope (§5.A Remaining).

**Commit** (`commitTake(handle, staged, {base, startTakeId, signal})`), inside the caller's span:

0. `reconcileBook`, `reconcileSlug(slug)`, `ensureTakeIdentity(slug)`: replay any leftover
   journal (F8), resolve an ambiguous or no-live-take shape (§4.2, §6.1), and sweep orphans. What a
   failure here does depends on the step that threw and on what the journal still owes (R7-4,
   restated by R8-2 and E10 in revision 8):
   - **a move-step failure** of a journal that names this slug, book or per-slug: the commit sweeps
     its staged set and ends the chapter `take_repair_pending`. It is not retried until the
     watchdog, which would report "the audio file is in use", the wrong diagnosis (R5-4);
   - **a record-step failure of a supersedable journal** (E12's list as widened by E14, §4.1: a
     commit or `replace` journal at `installed` or later, a restore or promotion journal at
     `stamp` or later, and nothing else): **E10.** The commit **supersedes** it and goes on. Every file is where that journal put them,
     so its take is simply the live take this commit preserves or discards. What the journal still
     owes is dominated by this commit: its stamp by step 7's stamp, which writes every member
     (§4.4); its review record or entry drop by this commit's own, which describes the live and
     previous pair that will then exist; its discard set and its own file by step 8. The commit's
     journal records it in `supersedes` (step 3), and nothing of the old journal is replayed again
     on its own (Journal rules). **Drop and Accept journals are not on the list (E12).** A drop
     journal owes the `excluded: true` write (Exclude, below), which no commit's stamp makes, and
     an Accept journal's owed record is not shown to be dominated; they keep block-and-retry;
   - **any other record-step failure** (a journal read; a drop or Accept journal past its moves; a
     rolled-back journal's unlink; a relabel journal's cursor or `metadata` write):
     retryable cause 3, within the record-step budget of
     three attempts (Retries). After the third, the commit sweeps its staged set and ends the
     chapter with `requestFailureMessageFs(err, FS_FAILURE_REQUEST_ERROR)`.

   **Step 0 repeats until it settles (R10-3, revision 10; pass 9, L5).** When `reconcileSlug` rolls
   back a superseding journal that stopped before `installed`, the journals it named are leftovers
   again. Step 0 then reads the slug's journals and decides again, in the same span, and repeats
   until the slug has no journal, or the journal in charge is on the list above and this commit
   supersedes it, or replay blocks on a move step, or a record step uses up its budget. So step 3
   never writes this commit's journal beside an unsuperseded one. Revision 9 left the next step 0
   to replay them, and a commit that stopped after one rollback wrote its journal beside the
   unsuperseded first journal, the two-journal state that the Journal rules call impossible.

   `ensureTakeIdentity`'s failures do not stop a full render's commit (§4.1, R8-2).

   **What step 0 can still cost (restated in revision 8; pass 7, J3).** Revision 7 said a persistent
   failure here lost "a render that `main` would have installed", and that the chapter-start span
   caught it first. Neither held. `main`'s finalize writes lufs (`:296`), embeddings (`:699`/`:768`)
   and segments (`:776`) before its audio rename (`:777`), so ENOSPC fails it before the install,
   and EROFS fails every write. And a journal created during synthesis (an Accept on the same chapter,
   or a sibling `::X` render whose stamp parked, N9) is first met here, not at the chapter-start
   span. Under E10 the leftover-journal case keeps the render. Step 0 now discards a finished render
   only when a journal off E12's list fails three times, or when this commit's own journal
   write fails before anything has moved. The second is a disk or folder that refuses the commit's
   own writes, where `main` fails too. The first is the one loss left that `main` does not have: a
   journal read, a drop or Accept journal's record step, a rolled-back journal's unlink, or a
   relabel journal's record step failing three times on a file `main` would never touch. A
   journal that cannot be read cannot say what it owes, and a relabel journal is a book journal
   that names other chapters, so neither can be superseded by one chapter's commit. The others are
   left off by E12, the owner's list (revision 9; revision 8's sentence here said E10 was scoped to
   a journal past `installed` while step 0 above listed Accept and drop, pass 8, K6). A `replace`
   journal is on the list since E14 (revision 10). All are rare.
1. Refuse if `signal.aborted` (H8).
2. CAS, partial writers only (OD2): the live `segments.json`'s `takeId` must equal `base`. A
   mismatch sweeps the staged set and returns `changed`.
3. Write the journal `<slug>.take-journal.<journalId>.json`:
   ```
   {op:'commit', phase:'discard', newTakeId, liveTakeId, prevTakeId, keepPrevious, parts,
    chapter:{id, slug, uuid}, clearGenerationState:true,
    review: undefined | null | {characterId, triggeredBy},
    preserved, oldDuration, newDuration,
    entry: {takeId, renderedAt, previousTakeId, previousRenderedAt} | null,
    supersedes: [{jid, discards, dropEntry}],        // E10, revision 8; a list, R9-3
    lost: [part]}                                     // R8-1, revision 8
   ```
   - It lists only the parts **present** on disk at this moment, so no rename ever targets an
     absent optional part.
   - **Each listed part carries its byte size (E15, revision 10; pass 9, L2).** `parts` records,
     for each part of the live take, the previous take and the staged take, the size it has at this
     moment, from the same probe that lists it. Replay uses it to decide a part found at two slug
     names (Journal rules). Every other per-slug journal records its parts' sizes the same way
     when it is written: the `replace` journal here, and the restore, promotion, accept and drop
     journals when they list theirs.
   - **`supersedes` (E10).** Set when step 0 superseded a leftover journal: its `jid`, the
     `.discard-<jid>.*` names it still owed unlinking, and whether it still owed an entry drop or
     review record (`dropEntry`). Step 7 runs that drop, after a successful stamp and before this
     commit records its own entry. Step 8 unlinks the old discards, then the old journal, then
     this one, each under `book`.
   - **Chains absorb (R9-3, revision 9; pass 8, K5).** `supersedes` is a list, oldest first. When
     the journal step 0 supersedes is itself a superseding journal (a commit whose step-8 unlink
     of its own superseded journal failed and was parked), this commit copies that journal's
     `supersedes` entries and then appends that journal itself. So every journal of the chain is
     named by the one journal in charge, and step 8 unlinks the chain oldest first. Revision 8
     held one `jid`, and a third commit unlinked the middle journal while it still named the
     first, which then replayed its stale entry over the newest one's.
   - **The review inputs (A3)** are what `applyReview` reads today (`finalize-chapter-write.ts:841-883`):
     - `review` is finalize's `input.review`: absent means "leave the review state alone", `null`
       means "drop the pending entry", and an object means "record one when `preserved`";
     - `oldDuration` is the pre-stamp `state.json` duration, read in this span;
     - `preserved` is true when a live take becomes previous at step 5.
   - **The entry's identity stamps (E6, revision 5)** are fixed here, because a replay may run long
     after the job's memory is gone, and by then step 5 has moved the parts they come from:
     - `takeId` is `newTakeId`, and `renderedAt` is the new segments' `synthesizedAt`. That is what
       the stamp writes into `audioRenderedAt`.
     - `previousTakeId` and `previousRenderedAt` belong to whichever take becomes previous: the live
       take under `preserved`, or the existing previous take under `keepPrevious` (R3-1).
     - `entry` is `null` when nothing becomes previous.

     The entry's `chapterUuid` comes from `chapter`. Its `ChapterRef` list is read from `state.json`
     when the entry is recorded, after the stamp, not from a pre-stamp snapshot. So replay can
     record the entry without the job's memory or the pre-stamp state.
4. **Choose what becomes previous.** The previous take stays, and the live take is discarded
   instead, in one case. **R3-1, for a full render:** the live `takeId` ≠ `startTakeId`, and the
   existing previous take's `takeId` = `startTakeId`. Another render committed meanwhile, and the
   previous take is the user's pre-render audio.

   (Revision 3's "no live take exists" case is gone. After step 0's promotion (§4.2), "no live take"
   means a first render with no previous take, and there is nothing to keep. **Interim:** the
   promotion arrives in Phase 3, so Phase 2's `commitTake` keeps the only-copy rule ("no live take,
   previous present → keep previous") until Phase 3 step 1 removes it with its test.)

   Otherwise, the old previous take (all parts) moves to `.discard-<jid>.prev.*`. Parts are
   **renamed, never unlinked** (F9). For a partial writer, compute the OD4 carry-forward **now**,
   from the live verdicts and embeddings. Apply QA repair's verdict patches to the live rows they
   name. Write the result over the staged files.
5. `phase:'preserve'` (or, under `keepPrevious`, `phase:'discard-live'`):
   - **the live audio moves first.** It is the only file ffmpeg can hold, so a held file fails
     before anything else has moved (D4);
   - then each other live part moves to `.previous.<suffix>` with the **real extension**
     (`.previous.m4a`), or to `.discard-<jid>.live.*` under `keepPrevious`.

   Every rename refuses an existing target, by an `existsSync` check under the lock. A target that
   is present is a fault, not something to overwrite.
6. `phase:'install'`: rename each staged part onto its live name. Every live name is now free,
   because step 5 moved what was there. A different-extension live audio left over (N4) moves to
   `.discard-<jid>.stale.*`. **The protocol never renames onto a held name.** Step 5's
   existing-target check applies here too: a live name refilled from outside since step 5 is a
   fault, and the commit rolls back (Failure handling), so nothing installs onto it.
7. `phase:'installed'`, journalled. **From here the take is committed (D2).** The remaining steps
   run in order, and each one that fails **parks** its error (E2, the CLAUDE.md deferred rethrow):
   - `stampStateFromLiveTake`, plus the `generationState*` clear. On failure the error is parked.
     When the stamp fails on the same refusal that made step 0 supersede a leftover journal, this
     is where the render fails loud (E10): the take is committed, and the chapter ends
     `take_details_pending`.
   - **Only if the stamp succeeded and `supersedes.dropEntry` is set (E10):** drop the chapter's
     pending entry first, best-effort with the same swallow as below.
   - **Only if the stamp succeeded (E6):** record or drop the review entry from the journal's
     `review` and `entry` inputs, best-effort (OD3). It keeps its deliberate swallow: an error
     surfaces only as `reviewOutcome: 'failed'`. The entry id is derived from `newTakeId`
     (`revision:<chapterId>:<newTakeId>`), so recording it twice is a no-op.
     - **Why not before the stamp.** `entryMatchesChapter` honours a stamped entry only while
       `audioRenderedAt` equals the entry's `renderedAt` (`revisions-store.ts:199-203`), and every
       `ChapterRef` is built from `state.json` (`:252-257,284-307`). An entry recorded over a failed
       stamp would be invisible to every read and op, and dropped at the next revisions write
       (`:290-308`). That includes a sibling's `recordPending`, which passes its own pre-stamp
       snapshot (`finalize-chapter-write.ts:791-823`).
     - **When the stamp is parked**, no entry is recorded, and the step reports
       `reviewOutcome: 'none'`. The chapter's old pending entry, if any, is still **dropped**
       (best-effort, same swallow). Its two takes are no longer the live and previous pair, so no op
       on it can be right. In Phase 2, before Phase 3's retry tables exist, `main`'s Accept would
       otherwise discard the wrong take. Dropping it is a `revisions.json` write and does not depend
       on `state.json`. Replay stamps first, then records the new entry. **Restore appears once
       replay lands the stamp.**
8. `phase:'cleanup'`: unlink the `.discard-<jid>.*` set, and each superseded journal's discards and
   then its file, oldest first (E10, R9-3). Then unlink the journal, **only if the stamp succeeded**
   and every superseded journal is gone. A parked stamp error leaves the journal at `installed`, so the next
   `reconcileSlug` re-runs the stamp and then records the entry; a failed unlink of the superseded
   journal is parked the same way, so this journal is never unlinked while it still names one.
   **The chain's unlinks stop at the first failure (R10-3, revision 10; pass 9, L5):** when a
   superseded journal's discards or file fail to unlink, no later journal of the chain is unlinked
   in this run, so no journal is unlinked while it names one that is still present, the middle of
   a chain included. Last of all, rethrow the parked error, if any.

**Failure handling.**
- **Before `installed`:** roll back from the journal, in reverse order, inside the same span:
  installed parts back to `.next-*`, `.previous.*` back to live, discards back to previous. The
  staged set is **kept** when the cause is retryable (below). Otherwise it is swept. A rollback step
  that itself fails leaves the journal for the next `reconcileSlug`. The rollback's last step, the
  journal unlink, takes `book` (R7-1, §4.4), as every journal unlink does.
- **At or after `installed` (D2):** the take is committed. The remaining writes run (steps 7–8), and
  then the parked error rethrows.
  - **Generation's outer catch** asks `takeCommitted(handle, slug, newTakeId)`: the live
    `segments.json` `takeId` = `newTakeId`, or a journal for `newTakeId` at `installed` or later.
    When it is true, the catch skips the `generationState: 'failed'` stamp
    (`generation.ts:2369`), runs one `reconcileSlug` in a fresh span, and ends the job
    `chapter_failed` with code `take_details_pending` and R3-7's sentence (R4-7). The take
    committed, and a deferred rethrow binds the caller too. So before that terminal frame,
    generation still runs `afterChapterFinalized` (the attempted marker and the scoring trigger,
    after the span) and the queue-entry mark (`generation.ts:2042-2072`), as a successful commit
    would. When `requestFailureMessageFs` maps the parked error to
    `FS_PERMANENT_FAILURE_REQUEST_ERROR` (ENOSPC, EACCES, EROFS), the frame's sentence is "The new
    take was saved, but its details could not be recorded. Check free disk space and folder
    permissions." instead of R3-7's "they will be repaired". That is `code` choosing a sentence,
    which R8-2 allows; it decides no retry.
  - **Splice and QA repair** do the same with their own terminal frames.
  - **Terminal frames are curated, at the source and at the catch-all (R7-5; done on `main` by
    #4234, merged at `08742125`).** This was #4233, live on `main` independently of this design.
    #4234 landed all of R7-5's widened scope, so this design adds none of it:
    - the splice and QA-repair catch-alls (`chapter-splice.ts:606-609`, `chapter-qa-repair.ts:927-929`)
      send `requestFailureMessageFs(err, …)` with their prefix inside the fallback, and log the raw
      error. A node fs error and a lock timeout get the curated sentences; any other error keeps
      its message, which is path-free at the source;
    - ffmpeg failures reject through `ffmpegFailure` (`tts/ffmpeg-failure.ts:29`; for example
      `tts/mp3.ts:398,546`): a one-line, path-scrubbed message, with the full stderr on
      `err.ffmpegStderr` for the log;
    - generation's `classifyFailure` (`routes/failure-taxonomy.ts:481`) runs its `isFsPathError`
      pre-check (`:469`) before any signature regex, and answers the `requestFailureMessageFs`
      sentence for a node fs error (`:494-518`).

    **What this design still needs from it.** Every new terminal frame this design adds goes
    through the same seams: the `take_repair_pending` and `take_details_pending` frames carry fixed
    sentences, and the base-read span's record-step failure ends through
    `requestFailureMessageFs(err, FS_FAILURE_REQUEST_ERROR)` (Ownership, above). Phase 2 step 4
    keeps those on the curated path and adds no call site beyond the ones it names. #4236 tracks
    the other routes that still echo a raw `err.message`; it is not part of this design.
  - The fail-loud and swallow classification of every new `state.json` write site is in the
    table below. It replaces revision 3's "the fail-loud count is unchanged", which was false.

**State-write sites (A3).** CLAUDE.md lists each site where a lock timeout out of a `state.json`
write either fails loud (rethrown into a terminal outcome) or is swallowed on purpose. This design
moves one site and adds eight (revision 5 splits the replay row):

| Site | Class | Why |
|---|---|---|
| `commitTake` step 7 stamp (moved from finalize's `:791`) | **fail-loud**, deferred | D2. Parked, rethrown after cleanup; the review record waits for a successful stamp (E6); the journal keeps both owed |
| `restoreTake` `stamp` phase (Reject, `restore-unrecorded`) | **fail-loud**, deferred | New: today's reject does not stamp. Parked, rethrown after cleanup of the discard set; the journal stays at `stamp` |
| journal replay's stamp (commit and restore roll-forward, R3-5's promotion, replace; and a drop journal's roll-forward `state.json` write, E18, which is the same replay site), at an entry point that has a terminal outcome | **fail-loud** to that entry point | The journal stays. It is a record step, so it never answers 409 `take_repair_pending`, which is only for a move step (R7-4). At a quick op: the curated 500 at once. At a render's chapter-start span and a commit's step 0: a journal on E12's supersedable list (§4.1, with E14's `replace` journals) is logged and then superseded by the commit (E10); at a bundle overwrite, a carried journal on that list, or a carried drop journal (E14), is superseded by the `replace` journal; any other gets the record-step budget of three attempts and then ends the chapter with `requestFailureMessageFs`' sentence (R8-2). Its class never depends on `code` (§4.1, Commit step 0) |
| journal replay's stamp at the **boot fsck** (fire-and-forget, `index.ts:549-555`) | **swallow** (logged), revision 5 | Nothing to fail into. The journal stays, and the next entry point on the slug repeats the replay |
| journal replay's stamp in **R4-2's background `reconcileBook` retries** | **swallow** (logged), revision 5 | The request already answered its fixed 500. The journal stays, and the next attempt or entry point repeats it |
| `reconcileBookTakes` (backup restore, R3-9) | **fail-loud**, deferred | Otherwise restored take fields describe absent audio (N12). Parked across chapters, rethrown after the last |
| `replaceTakesFromBundle` stamp (R3-8) | **fail-loud**, deferred | As above, under the import's claim; the `finally` still runs |
| `ensureTakeIdentity`'s mirror stamp | **swallow** (logged), everywhere. This is its one class (R8-2, revision 8): revision 7 also listed it under retryable cause 3, which pass 7 (J2) found contradictory, and it is no longer there. Its mint into the take's own segments is not a `state.json` site; a failed mint stops only a partial job's base read (§4.1) | It writes only derived mirrors. Every entry point repeats it. No decision reads `audioTakeId` (E6): the CAS and the Accept/Reject retry tables read the live segments' `takeId` under book-op, and `entryMatchesChapter` reads `audioRenderedAt`, which only fail-loud stamps write. Same reasoning as `scan.ts`'s lazy migrations |
| migration's legacy-reject re-stamp (§6.1 step 5) | **swallow** (logged) | The shape persists until it succeeds, so the next entry point repeats it |
| `dropAllTakes`'s take-field clear | not new | It rides exclude's existing `state.json` write, which keeps its class |
| **`dropEntry`** (R3-5's promotion and `replaceTakesFromBundle`, R6-8): a `revisions.json` write under book-op → `revisions`, at an entry point that has a terminal outcome (revision 7, R7-7) | **fail-loud**, deferred | New. Parked, rethrown after the remaining steps; the journal is kept, so the next replay drops the entry. An entry point that would then act on that entry (Accept, Reject) replays first, so it never acts on a stale one; if the drop fails again, it answers the curated 500. The boot fsck and R4-2's background retries swallow it, as their stamp rows do. CLAUDE.md's enumeration counts `applyReview`'s `revisions` write, so it owes `dropEntry` a line too |

`healTakeFields` keeps the scan heal's place on the swallow list. Phase 2 updates CLAUDE.md's two
enumerations, and the counts in them, to match this table: five new fail-loud sites (four on
`state.json`, plus `dropEntry` on `revisions.json`), one moved, and four new swallow sites (revision 5
adds the fsck and background replay rows, which also cover `dropEntry` there).

**Retries and the watchdog (F18; D4).**
- **The three retryable causes**, all of which keep the staged set:
  1. **A book-op acquisition timeout.** Recognised by an `entered` flag set as the first statement
     inside the `withBookOp` callback. A timeout with `entered = false` is contention for book-op
     itself.
  2. **A held file**: EBUSY or EPERM from step 5 or 6, after the in-span rollback.
  3. **A record-step failure before step 3 writes this commit's journal (A11, restated by R7-4,
     then by R8-2 and E10 in revision 8, by E12 in revision 9, and by E14 in revision 10)**, from a
     journal step 0 cannot supersede: a journal read, a drop or Accept journal's record step, a rolled-back
     journal's unlink, a relabel journal's cursor or `metadata` write. Any error, of
     any `code`. Nothing of this commit has moved yet, and replay is idempotent, so re-running
     step 0 is safe. **Its bound is the record-step budget, not the watchdog:** three attempts in
     all, the first in the span and two more between spans after 1 s and 2 s. After the third, the
     chapter ends with `requestFailureMessageFs(err, FS_FAILURE_REQUEST_ERROR)` and the staged set
     is swept. Revision 7 retried only the "transient" codes, until the 720 s watchdog, and failed
     the "persistent" ones at once. A permanent EPERM then ended at the watchdog as "the chapter's
     audio file is in use", and EIO, EMFILE and ENOENT had no class (pass 7, J2). Three things are
     **not** cause 3:
     - **a move-step failure** of any journal that names the slug, a leftover one or the promotion
       journal step 0 itself started. It ends `take_repair_pending`. Revision 5 listed "a held file
       met by step 0's promotion" under this cause, and also carved out only book journals. That
       made step 0 retry what the chapter-start span refused (pass 5, C4); both now refuse;
     - **a supersedable journal (E12's list as widened by E14, §4.1).** It is superseded at once,
       never retried (E10, Commit step 0). A drop or Accept journal is not on the list, so it is
       cause 3;
     - **`ensureTakeIdentity`'s failures.** Its mirror stamp is swallowed, and a full render
       commits without the id (§4.1). Revision 7 listed "`ensureTakeIdentity`'s stamp" here while
       the State-write sites table called it a swallow site (pass 7, J2).

     Revision 6 also listed a "`book` timeout" here. The `book` lock has no acquisition timeout
     (`book-lock.ts:57-86`), so there is none to retry.

  A failure at step 7 is not retried: the take is committed, and the error is parked and rethrown
  (above).
- **Each retry runs between spans**, never inside one, with backoff (1 s, 2 s, 4 s, then every 5 s).
  Cause 3 stops after its third attempt (above); causes 1 and 2 run on.
- **The bound for causes 1 and 2 is the assembly watchdog.** Generation sets `stallPhase = 'commit'` once when it
  enters the commit phase, and does **not** call `bumpProgress()` on retries. The existing
  no-progress ceiling therefore still bounds the wait.
  - If the watchdog fires between spans, the job fails as a stall named "commit". The message is
    the fixed sentence "the chapter's audio file is in use (an export or clip may be running); the
    render was not saved". The exit path sweeps the staged set. So it is reported, never silent
    (D4).
  - While a span is open, `committing = true` makes the watchdog defer its abort until the span
    exits. Only the span's own work bounds that wait. A fully staged commit is never abandoned for
    being slow (E2), so a slow OneDrive commit lands where `main` would also have landed it.
- **`afterChapterFinalized`** (the attempted marker and the scoring trigger) runs **after** the span
  is released, and writes through `commitScoring`.

**Sweep (D4).** `reconcileSlug` and the fsck sweep the orphans, under book-op:
- `.next-<id>.*` with no journal naming `<id>` and `<id>` not in `liveStaging`: unlinked. These are
  never the user's audio: a staged take is not a take until `installed`.
- `.discard-<jid>.*` whose journal exists: handled by replay.
- `.discard-<jid>.*` with no journal: quarantined, not unlinked. The protocol unlinks the journal
  **last**, so this shape means something outside the protocol removed it.
- A relabel temp name, `<slug>.relabel-<jid>-<k>.*`, is handled the same way: by replay while its
  book journal exists, and quarantined, never unlinked, without one. It holds a chapter's take
  between `stage` and `land`.
- `*.tmp-<pid>-<ts>` (#4167): unlinked.
- **A journal that cannot be read** (EBUSY, EPERM: a scanner or sync client holding it) is left where
  it is. That is a record-step failure (R7-4, R8-2), not damage, and quarantining it would move
  a healthy relabel journal, and every take it was moving, into `.orphaned/`.
- **A journal that does not parse (R6-3, revision 6)** (`SyntaxError`), or parses and fails the
  journal schema, of either kind, is quarantined to
  `audio/.orphaned/<iso-date>-<jid>/` and logged; it is never replayed and never blocks. The
  jid-tagged names it was moving then have no journal, so the rules above quarantine them into the
  same event folder. Journals are written atomically, so this shape means something outside the
  protocol damaged one. The chapters it was moving read unrendered until a person restores the
  files from `.orphaned/`.
- **Every non-commit exit** sweeps its own staged set in a short span: abort, CAS mismatch,
  watchdog abandonment, and a job's `finally`. A crash leaves it for the next `reconcileSlug` or
  the boot fsck, where `liveStaging` is empty.

**Journal rules (F8; D2).**
- **Every entry point replays first** (`reconcileBook`, then `reconcileSlug`), scoped as R5-3 says
  (Ownership, above).
- **Replay** looks at a journal's `op` and `phase`, and at what is on disk:
  - **a commit** (or a bundle `replace`), before `installed`: roll back. From `installed` on: roll
    forward (the stamp with its `generationState*` clear; then, only once the stamp has succeeded,
    the review record from the journal's `review` and `entry` inputs (E6); then cleanup), parking
    errors as step 7 does.
  - **a restore**: as in the reject table below.
  - **an Accept or a drop (E18, revision 11):** the same rule as a commit. Before `installed`, roll
    back. From `installed` on, roll forward to completion. Neither journal installs anything, so
    its `installed` is the phase it journals once every move has landed, the point E12 calls "past
    its moves" (R11-1). Accept's phases are in its table and drop's in Exclude's (both below):
    - **rolling back** moves each part from its discard name back to its slug name, the audio
      last, deciding each part by the rows below. For a drop that includes the only-copy part,
      which comes back from the event folder the journal recorded when it was written (R11-2). A
      rolled-back Accept leaves the previous take whole and the entry pending, so the user's retry
      runs it again. A rolled-back drop leaves the chapter not excluded, with its takes whole and
      its take fields unchanged. A part recorded as lost on the way is the only exception, as for
      every journal (below). Nothing is half-moved and nothing is half-excluded;
    - **rolling forward** runs the remaining record steps. For Accept that is its `revisions.json`
      write recording `accepted`, then cleanup. For a drop it is the `state.json` write that sets
      `excluded: true` and clears the take fields, then `dropEntry`, then cleanup. A record-step
      failure keeps E12's block-and-retry: the record-step budget in a job, the curated 500 at a
      quick op. A carried drop journal at the bundle overwrite may instead be superseded by the
      `replace` (E14), which runs only from `installed` on, as every supersession does;
    - **E18 checked against E12, E14 and the drop target.** E12 is about record-step failures past
      the moves, which is the roll-forward half, so nothing in it changes. E14 supersedes only a
      carried drop journal stuck on record steps, so it too is at or after `installed`. Before
      `installed` a carried drop journal rolls back in the pre-claim replay, and a move-step failure
      there refuses the import, as for any journal. The drop target under
      `audio/.orphaned/<iso-date>-<jid>/` is journal-unique, so its rollback takes the "source
      journal-unique" row. Two things are added so that the rule applies as stated. The event
      folder's name is recorded at write time, so a later day's replay finds it (R11-2). And a
      foreign copy that replay quarantines for a drop goes to the folder's `foreign/` subfolder, so
      it never takes the only-copy part's name before that part moves back (R11-3);
  - **a relabel**: resume at its cursor (Restructure, below). Never roll back once `state.json` has
    landed (E1).
- **Idempotence of per-slug journals.** For a commit, replace, restore, accept or drop journal,
  every rename step, forward or in a rollback, decides each part from what is on disk. **Which row
  applies depends on the kind of each name (R9-1, revision 9; pass 8, K1).** A name is
  **journal-unique** (`.next-<takeId>.*`, `.discard-<jid>.*`, and drop's only-copy target under
  `audio/.orphaned/<iso-date>-<jid>/`, which nothing outside the protocol creates; the last added
  in revision 10, pass 9) or a **slug name** (the slug's live or `.previous.*` name, which a sync
  client or Explorer can refill once the protocol vacates it):

  | Source name | Target name | Replay does |
  |---|---|---|
  | present | absent | rename |
  | absent | present | done |
  | present | present, **one side journal-unique** | the copy at the **slug name** is the foreign one. Target journal-unique (a discard, drop's only-copy move, or install's rollback to `.next-*`): the part already moved; quarantine the source copy; done. Source journal-unique (a discard rolled back): the slug name was refilled; quarantine the target copy, then rename. No replay installs forward (R10-1, below) |
  | present | present, **both slug names** (`promote`, and a rollback between live and previous, such as preserve's) | decided per part by E15 (below): the copy the journal identifies as the protocol's is kept and the other is quarantined; then rename, or done when the protocol's copy is already at the target. Two different copies that nothing identifies are **both** quarantined, and the part is recorded in `lost` |
  | absent | absent | **lost (R8-1):** only after the re-probe below finds it absent at every probe; then append the part to the journal's `lost`, log it, continue |

  - **Deciding a part at two slug names (E15, revision 10; pass 9, L2).** For each part, in order:
    1. a part that carries a `takeId` (segments, and embeddings, §4.3) is decided by it, against
       the journal's ids (`liveTakeId`, `prevTakeId`, `newTakeId` for a commit or `replace`; the
       live and previous takes' ids for a restore or promotion): the copy that carries the id of the
       take the step moves is the protocol's;
    2. any other part, and a `takeId` part that neither or both copies decide, is decided by size:
       the copy whose byte size equals the size the journal recorded for that part of the take the
       step moves (Commit step 3) is the protocol's;
    3. when both copies have that size, they are compared byte for byte. Identical copies (a sync
       client restoring the very file the protocol moved) are either one right: the copy at the
       target counts, and the other is quarantined;
    4. two different copies that neither the id nor the size tells apart, or two copies neither of
       which has the recorded size, are **both** quarantined into the journal's event folder,
       `audio/.orphaned/<iso-date>-<jid>/`, and the part is appended to `lost` with both basenames
       and logged. The take is incomplete in that part, as for any lost part (below). Neither copy
       can be live afterwards, so the take is never mixed, nothing is unlinked, and the slug is not
       blocked.
  - **Every per-slug step decides all of its parts before it renames any (E15).** A step probes
    every part it lists, takes each part's row (quarantining any foreign copy), and only then
    renames. So a step stops between two parts only on a rename the OS refuses, never on a
    decision. `promote` moves the audio first, as `discard-live` and `preserve` do (Reject, below).
  - **The two-fault case E15 closes (pass 9, the most dangerous assumption).** A Reject's journal is
    at `promote`, a crash stopped it part-way, and a sync client then restores one of B's live files,
    which it saw moved away at `discard-live`. Replay meets A's copy at `.previous.*` and B's at the
    live name. A's has the size the restore journal recorded for that part of the previous take, so
    B's copy is quarantined and A's part is promoted, and A ends whole and live. Revision 9 refused
    every such part other than segments. Readers never consult journals (§4.2), so the refusal left
    the live take as the fault had made it, for example B's audio over A's segments, which the
    Listen view played, and blocked the chapter, and the book's restore, overwrite and restructure,
    behind R8-2's sentence, which named neither the cause nor the file.
  - **Why by kind (pass 8, K1; corrected in revision 10, pass 9, L3).** Revision 8's third row said
    "the copy at the source name is foreign" for every step, copied from R5-1, whose targets are all
    journal-unique. A per-slug journal's targets include slug names. Revisions 8 and 9 both read a
    commit stopped after step 5, with its live audio name refilled from outside (step 5 moved the
    live audio away, a sync client restored it), as an install going forward. **No replay installs
    forward (R10-1):** a commit or `replace` journal before `installed` rolls back (above), and
    step 6's first run refuses a refilled live name (Commit step 6). On that rollback, install's
    undo meets the refilled live name with the staged copy still at `.next-<takeId>`, which is
    journal-unique, so the copy at the live name is foreign and is quarantined; the preserved take
    then moves back from `.previous.*`, and the staged set is swept. Where revision 8's row is
    really wrong is a discard rolled back onto a refilled slug name: it quarantined the protocol's
    discarded part and left the foreign copy in its place. So **no replay path leaves a mixed take**:
    a copy at a slug name is kept only when the journal identifies it, and two copies it cannot tell
    apart are both moved out. A copy that an outside program puts at a live name is live only until
    the next entry point replays the slug.
  - **Why the both-absent row (pass 7, J1).** Revision 7 had only the first two rows here; only the
    relabel journal had R5-1's "absent under both names". A part deleted from outside the protocol
    while a per-slug journal was pending (Explorer, a sync client propagating a delete) was then
    renamed anyway. `renameWithRetry` retries `ENOENT` for about 3.6 s (`atomic-rename.ts:41-47`)
    and rethrows, which is a move-step failure, so the slug was blocked for good, behind a sentence
    that could never work.
  - **The re-probe (R9-2, revision 9; pass 8, K2).** A part is recorded as lost only when it is
    absent under both names at a first probe **and** at a re-probe after each delay of
    `RENAME_RETRY_DELAYS_MS` (`atomic-rename.ts:22`, about 1.8 s in all). OneDrive can move a just
    written file into its own staging for scanning and drop it back milliseconds later (the
    helper's own header, `:7-9`), and a part recorded as lost that then drops back is a
    `.next-<id>` file no journal names, which the sweep **unlinks** (Sweep). The same schedule
    serves a rename that throws `ENOENT`: replay re-probes both names on it and takes the matching
    row, so `ENOENT` never blocks a slug. Revision 8 re-probed once, with no wait.
  - **What a lost part leaves.** An incomplete take: with no audio the chapter reads unrendered, and
    with no segments it is unindexed (§4.2), as for a relabel. A lost live audio part of a commit
    being rolled back leaves no live take, and the next step 0 meets §4.2's no-live-take shape. A
    stamp after a lost segments part clears every member except `duration` (§4.4). A part E15
    could not decide leaves the same, with both copies kept in `.orphaned/`. Replay always
    converges.
  - Step 5's in-span "a present target is a fault" check is unchanged: it guards a first run, where
    the journal has just listed what is present.

  Inside the protocol, under book-op, nothing refills a vacated slug name, so the table above meets
  "both present" only after a fault from outside. A relabel moves takes between **different
  chapters'** slugs, so the presence test is not sound **across** its groups. A relabel uses a
  cursor across groups (A1), and a per-part test **inside** the group that runs next, the one
  after the group the cursor names, where the presence test is sound again (R5-1, R6-2,
  Restructure below). The stamp is a pure function of the live segments, and the review entry is
  keyed by `takeId`. Nothing counts.
- **At most one unsuperseded journal per slug (E10, revision 8; chains R9-3).** Revision 7 said
  "one journal per slug". A commit that supersedes a leftover journal (Commit step 0) now leaves
  two or more on disk until its cleanup: its own, whose `supersedes` list names every journal of
  the chain, and those. Replay of the slug runs the journal no other one names, and never replays
  a named journal on its own:
  - **replay reads every journal of the slug before it acts on any (R9-3, revision 9; pass 8,
    K5).** Which journal is in charge depends on the others' `supersedes`, so a journal that cannot
    be read (EBUSY, EPERM, Sweep) stops the slug's replay: it is a record-step failure, and no
    journal of the slug is acted on until every one reads. Otherwise a superseded journal would
    look like a plain leftover while the journal naming it was unreadable;
  - **the superseding journal before `installed`** rolls back, and its rollback unlinks only its
    own file. The journals it named are then leftovers again, the one no other names in charge,
    with every file where they left them. The same step 0 then decides the slug again, and repeats
    until it settles (R10-3, Commit step 0), so a commit never writes its journal beside them;
  - **from `installed` on**, it rolls forward: its stamp, the superseded journals' owed entry
    drops, its own entry, then step 8's unlinks, oldest first, its own last.

  So a crash at any point leaves exactly one journal in charge. **More than one unsuperseded
  journal for a slug** should be impossible under book-op. If it happens, the entry point refuses
  with a fixed 500, and the fsck quarantines **every** unsuperseded journal of the slug, with the
  jid-tagged files they name, into one `audio/.orphaned/` event folder, as R6-3 does, and logs
  them. Nothing orders two random jids, so none is preferred; the live take stays where it is, and
  the next entry point's stamp describes it. Revision 8 said "the extra journals" without saying
  which (pass 8, K5).
- **Unique names.** The journal id is fresh per operation, so names never collide.
- **Not boot-only.** Recovery runs at every entry point, in the failing job's catch path, and at
  boot.

**Accept** (`acceptTake`). The `live_audio_missing` pre-check (`revision-ops.ts:92`) is **removed**
(R4-3). Step 0's promotion (§4.2) has already turned "no live take plus a previous take" into a live
take A, so Accept meets the converge row below. Accept **changes no take field** and bumps nothing
(D1). What it does depends on the live `takeId` (F17):

| Live `takeId` is… | Accept does |
|---|---|
| the entry's `takeId` (B) | moves the previous take to `.discard-<jid>.prev.*`, then cleanup; commits `accepted` |
| the entry's `previousTakeId` (A), or, when that is `null`, a take whose segments' `synthesizedAt` is present and equals the entry's `previousRenderedAt`, which is present too (R9-4, R10-4) | **a reject's audio step already ran**. Accept and reject converge: the entry is removed, `rejected` (the truth) is appended, and the answer is 409 `revision_gone` with the state |
| anything else | `revision_gone`, entry kept as today |

The first row's journal is `op:'accept'`. Its phases and what a replay does at each (E18, revision
11; R11-1):

| Phase | Action | Replay |
|---|---|---|
| `discard-prev` | move each `.previous.*` part to `.discard-<jid>.prev.*`, the audio first | roll back: move them back to `.previous.*` |
| `installed` | journalled once every move has landed | roll forward from here |
| `record` | the `revisions.json` write that records `accepted` and removes the entry | roll forward |
| `cleanup` | unlink the discard set, then the journal | roll forward |

**Reject** (`restoreTake`). Journal `op:'restore'`. The phases, with what a replay does at each:

| Phase | Action | Replay before the next phase |
|---|---|---|
| `discard-live` | move live parts to `.discard-<jid>.live.*`, the live audio first | move them back (roll back) |
| `promote` | rename each `.previous.*` part onto its live name (target checked absent), the audio first (E15) | roll forward: finish the renames, deciding a part found at both names by E15 (Journal rules) |
| `stamp` | `stampStateFromLiveTake`, now from A's own segments. A failure is parked | roll forward |
| `cleanup` | unlink the discard set; unlink the journal only if the stamp succeeded; rethrow a parked error | roll forward |

At every point, each take exists whole on disk (H1, H2). R3-5's promotion is the same op with no
`discard-live` phase.

**Ops that change the live take drop its entry (R6-8, revision 6).** A pending entry pairs the take
that was live (B) with the one that was previous (A). After R3-5 promotes A over a lost B, or after
a bundle overwrite brings back a take with A's `synthesizedAt`, `audioRenderedAt` equals the entry's
`previousRenderedAt`, so the entry matches again (Matching, below). Accept or Reject on it would then
record a `rejected` the user never chose (pass 5, C9). So every module op that changes which take is
live, other than a commit, Accept and Reject, drops the chapter's pending entry. That is R3-5's
promotion and `replaceTakesFromBundle`; `dropAllTakes` already drops it.
- The drop is a **journal step**, `dropEntry`, after the stamp and before cleanup. The journal is
  unlinked only after the drop lands, so a failed `revisions.json` write is retried by the next
  replay, not lost. It uses the existing `book-op` → `revisions` edge. It is a record step (R7-4),
  and a new write site in the State-write sites table (R7-7, revision 7).
- Reject itself does not drop the entry. Its own `revisions.json` write records `rejected` and
  removes the entry, which is what H17's retry needs to keep matching through
  `previousRenderedAt`.

**Retry recognition (H17, H18).** Recorded entries gain `takeId` (B) and `previousTakeId` (A), plus
the existing `renderedAt`. Reject compares the live `takeId`:

| Live `takeId` is… | Reject does |
|---|---|
| B | runs the restore |
| A (or, when `previousTakeId` is `null`, a take whose segments' `synthesizedAt` is present and equals the entry's `previousRenderedAt`, which is present too, R9-4, R10-4) | the audio step is already done: commits `rejected` |
| anything else | `revision_gone` |

Both tables read the **live segments'** `takeId`, inside the module under book-op. They never read
`state.json`'s `audioTakeId` mirror (E6).

**An entry with no `previousTakeId` (R9-4, revision 9; pass 8, K7).** When a full render's mint
failed (§4.1, R8-2), the take that became previous at its commit was id-less, so step 3 recorded
`previousTakeId: null`. The next entry point's `ensureTakeIdentity` then mints that take a fresh id,
which no entry carries, and a Reject retry met "anything else". So the "A" row of both tables also
matches, when the entry's `previousTakeId` is `null`, a live take whose segments' `synthesizedAt`
equals the entry's `previousRenderedAt`. That is the same time `entryMatchesChapter` already
accepts (Matching, below), and the routes that bring a take back with A's time drop the entry first
(R6-8), so it never matches a stale entry. A previous take with no segments has neither an id nor a
time, and its entry matches on `renderedAt` alone, as a legacy entry does. Minting at step 3 was
the alternative; it repeats the write that just failed.
- **Both times must be present (R10-4, revision 10; pass 9, L6).** `synthesizedAt` is optional
  (`audio/segments-io.ts:70`), and legacy takes, exactly the id-less ones this row is for, can lack
  it. The row matches only when the entry's `previousRenderedAt` and the live segments'
  `synthesizedAt` are **both present and equal**. A naive `===` with both absent would take the "A"
  row and record a `rejected` the user never chose (C9's shape). Two different takes never share a
  `synthesizedAt`: finalize stamps it fresh on every write, partial writers included
  (`finalize-chapter-write.ts:686`), so only A itself carries A's time, and the routes that bring A
  back by another way drop the entry (R6-8).
- **The residual.** An id-less previous take whose segments carry no `synthesizedAt` gets no H17
  retry: a Reject whose `revisions.json` write failed answers `revision_gone` on its retry instead
  of committing `rejected`. That is no worse than `main`, where the same retry fails (H17). It is
  listed under Remaining.

**Matching (E6, revision 5).** Revision 4 widened `entryMatchesChapter` to `takeId ∈ {B, A}`, but
named no chapter-side source. Revisions-store builds every `ChapterRef` from `state.json`, so the
only cheap source was the `audioTakeId` mirror, which would have made the mirror a decision input
(pass 4, B3). Instead:
- Recorded entries also carry `previousRenderedAt`, A's `synthesizedAt`, from the commit journal's
  `entry` (step 3).
- `entryMatchesChapter` matches when `chapter.audioRenderedAt` is the entry's `renderedAt` **or**
  its `previousRenderedAt`. An entry without `previousRenderedAt` matches on `renderedAt` alone, as
  today.
- `audioRenderedAt` is already today's decision input, and only fail-loud stamps write it.
- The widening keeps H17's retry visible. Reject's `stamp` phase writes A's `synthesizedAt` into
  `audioRenderedAt`. If its `revisions.json` write then fails, the entry must still match, so that
  the retry meets the "A → commits `rejected`" row instead of `revision_not_found`.
- A take with neither time (a later render C) does not match, so a stale entry stays invisible.
- A take that comes back with A's time by another route (R3-5's promotion, a bundle overwrite) would
  match. Those routes drop the entry first (R6-8, above), so the widening never resurfaces a stale
  entry.

Legacy entries with no stamps are unchanged. **`revision-op` is retired** (N10).

**Exclude** (`dropAllTakes`, OD6, F16):
- journal `op:'drop'`; it moves the live take, the previous take and every sidecar to the discard
  set;
- in the same `state.json` write that sets `excluded`, it clears `TAKE_STATE_FIELDS`;
- it unlinks the discard set and drops the pending entry;
- **if there is no live take**, the previous take (the only copy) moves to `audio/.orphaned/`
  instead of being deleted. This rule is reachable, because `dropAllTakes`'s step 0 never promotes
  (§4.2).

The drop journal's phases and what a replay does at each (E18, revision 11; R11-1 to R11-3):

| Phase | Action | Replay |
|---|---|---|
| `discard` | move the live take (audio first), the previous take and every sidecar to `.discard-<jid>.*`, or the only copy to the event folder `audio/.orphaned/<iso-date>-<jid>/` that the journal names | roll back: move every part back to its slug name, the only copy from the recorded folder (R11-2); a foreign copy at a slug name goes to that folder's `foreign/` subfolder (R11-3) |
| `installed` | journalled once every move has landed | roll forward from here |
| `state` | the one `state.json` write that sets `excluded: true` and clears `TAKE_STATE_FIELDS` | roll forward |
| `dropEntry` | drop the pending entry | roll forward |
| `cleanup` | unlink the discard set, then the journal; the only copy stays in `.orphaned/` | roll forward |

So a drop either never happened (rolled back: not excluded, takes whole apart from any part
recorded as lost) or completes (rolled
forward: excluded, takes gone or quarantined). A render that meets the forward half at its chapter
start skips the chapter (E17, §4.1).

**Restructure** (`relabelTakes`; N16; E1). **Once `state.json` has landed, a relabel only rolls
forward.**

*Why revision 3's design failed (A1).* It replayed the map "whole" with the per-slug presence
test. That is not a no-op on a finished map. A "Chapter N" merge deletes a slug that the
renumbering then gives to the surviving chapter (`rewrite-chapter-slugs.ts:128-131`). A replay
re-runs that delete, finds the slug present (it now holds the survivor's take), and drops it. And
an in-process rollback after `state.json` left state naming the new slugs over files at the old
names.

*Write order.* Today's order is kept:
1. `manuscript-hints.json` (`chapters-restructure.ts:587`);
2. `state.json` (`:610`);
3. `manuscript-edits.json` (`:623`);
4. the ManuscriptRecord (`:643`);
5. the audio (`:650`);
6. the pending-entry reconcile (`:672`);
7. the analysis cache (`:685`).

The journal is written before step 1. Step 2's `state.json` write also stamps the book-level field
`relabelJid: <jid>` (R6-5, revision 6), in the same atomic write as the new chapter map.

*The journal.* `audio/.take-journal.relabel.<jid>.json`:
```
{op:'relabel', jid, cursor,
 hintsPrior: {existed, content} | null,              // the rollback window's only artifact
 stage: [{from, to, temp, takeId, prevTakeId, parts, newChapterId, newChapterTitle}],
 drop: [{slug, parts, onlyCopy}],                     // R6-2, R7-3: onlyCopy fixed after step 0
 clearStalePrevious: [slug],                          // R6-2: parts probed when the group runs
 landing: [k],                                        // R7-2: stage indexes `land` has begun
 lost: [{slug, part}],                                // R5-1: parts absent under every name
 unreadable: [{slug, part}]}                          // R6-3: parts `metadata` could not parse
```
- `temp` is `<from>.relabel-<jid>-<k>`, unique to the journal.
- `takeId`/`prevTakeId` are each source's live and previous `takeId`, or `null` when that take has
  no segments (an unindexed legacy take, §4.2). A `null` id skips the `takeId` check below.
- `stage[].parts` and `drop[].parts` list the parts present on disk when the journal is written,
  **after** step 0 (R7-3, revision 7), live and previous, in `COMPANION_SUFFIXES` order
  (revision 5). Replay decides each one by itself (R5-1,
  below), as the commit journal's `parts` do. That is sound for these two groups, because each part
  they list belongs to one old chapter and only this group moves it (`restructure.ts:442-471`).
- **`clearStalePrevious` lists slugs, not parts (R6-2, revision 6).** Revision 5 listed the parts
  present at plan time, which `stage` and `drop` then move first. On a reorder, each `to` that is
  also a `from` holds the moving chapter's `.previous.*` at plan time, and `stage` moves it to temp.
  On the canonical "Chapter N" merge, `drop` moves the dropped chapter's `.previous.*`. Either way
  revision 5's group found the planned parts absent under both names and recorded them as lost. The
  group now probes each listed slug's `.previous.*` parts when it runs, as today's Phase 1c does
  (`rewrite-chapter-slugs.ts:217-236`). What it finds at that point is stale by construction:
  `stage` has moved every source's previous take to its temp name, and nothing lands before `land`.
- **`drop[].onlyCopy` (R6-2)** is true when the slug had no live take but had a previous take when
  the journal is written, after step 0. Step 0 does not promote a slug the plan drops (R7-3), so this
  is the value `dropAllTakes` would read. Replay obeys the recorded value: quarantine the previous parts when it is true, discard them
  otherwise. Revision 5 re-derived the rule at replay. After a stop that had already moved the live
  audio, that turned "has a live take" into "the previous take is the only copy", so replay
  quarantined a previous take it should have discarded.
- **`hintsPrior` is dropped** at the first cursor rewrite after `state-landed` (revision 5). It
  holds the whole prior `manuscript-hints.json`, every chapter body, so it is written at most twice.
  Nothing after `state-landed` can roll the hints back.
- `relabelTakes`' step 0 runs **before** the restructure's `withStateJsonLock` closure (`:386`),
  under book-op → gate, and **outside `book`** (R8-3, revision 8). Revision 7 ran it under
  book-op → gate → `book`, where its promotion and multi-live decodes held `book`, which has no
  acquisition timeout and which the library-scan heal waits on (pass 7, J8). In order (R7-3,
  restated in revision 8):
  1. **The slug plan.** Step 0 takes `book`, reads `state.json`, computes the slug plan, and
     releases `book`. The slug plan is `buildAudioOps`' map of which slugs are a `from`, a `to`, a
     `drop` or a `clearStalePrevious`. **Its inputs, stated truthfully (pass 7, J7; titles added in
     revision 9, pass 8, K8):** chapter ids, slugs, titles (with `titleSynthesized`, because a new
     slug is built from the id and the title, `restructure.ts:126-128`, and the transform renumbers
     app-made titles, `chapters-restructure.ts:387-389`), `excluded`, the op, and `buildAudioOps`'
     presence test. Revision 7 omitted the last,
     and that test read `audioRenderedAt` alone (`restructure.ts:443`), which step 0 itself can
     write: R3-5's promotion of an unindexed previous take clears it (R6-8), and the legacy-reject
     re-stamp rewrites it. **The presence test is now an OR (R8-7):** a chapter is in the plan when
     it has `audioRenderedAt` **or** a take on disk, a live take by §4.2's predicate or a previous
     take. Each write step 0 can make keeps that OR true for every chapter it was true for: a
     promotion turns a previous take into a live one; a re-stamp, a mint or a multi-live
     resolution leaves a live take live; an orphan-part quarantine touches no chapter whose audio
     is on disk and writes no `audioRenderedAt`. So the plan is invariant under step 0, and a
     promoted take moves with its chapter, as on `main`, where a stale `audioRenderedAt` kept it in
     the plan. Revision 6 needed "every slug the plan names" before the closure built the plan
     (pass 6, G4).
  2. `reconcileBook`, then `reconcileSlug` for every slug the slug plan names (R6-10, revision 6).
     For a `drop` slug, `reconcileSlug` runs with **promotion off**, as `dropAllTakes`' does (§4.2):
     a dropped chapter's only copy is quarantined by `drop`, not promoted first and then discarded.
     Every other slug may promote (R3-5).
  3. `ensureTakeIdentity` for every chapter with a take. The ids therefore exist before the
     closure.
  4. The journal's `parts`, `onlyCopy`, `takeId` and `prevTakeId` are read from disk now, after
     everything step 0 changed.

  The restructure then takes `book` again, as today (`chapters-restructure.ts:331`), and its closure
  rebuilds the plan from its fresh read (`:386-392`) and asserts that its slug plan equals step
  0's. Step 0 writes no id, slug, title or `excluded`, and its writes keep the presence OR true.
  book-op plus the gate keep out every writer that holds book-op. **Three writers hold only `book`,
  and can run while it is released (revision 9 names the last two; pass 8, K8):**
  - the library-scan heal, which fills absent take fields from a live take, so it can only fill
    `audioRenderedAt` for a chapter the OR already admits;
  - GET `/state`'s **title refresh** (`book-state.ts:457-485`, `refreshChapterTitles` from
    `:319`, its rewrite at `:430-441`), which rewrites `title` and `titleSynthesized` when the book's
    `chapterTitleParserVersion` is behind. That can change a planned target slug;
  - GET `/state`'s **uuid mint** in the same span, which writes `uuid` only, which the plan does
    not read.

  So the assertion **can** fire, once per book after a bump of the title parser's version, when a
  GET lands in the gap. That is what the tripwire is for: the restructure fails with the existing
  fixed 500 before it writes anything, and the retry re-plans against the refreshed titles, which
  the refresh's version stamp keeps from changing again. Revision 8 said the heal was the only
  writer in the gap, and revision 7 that the assertion "cannot fire" (pass 7, J7; pass 8, K8). Inside the closure, the journal write is a
  plain file write that takes no lock: `state-json` is a leaf.
  - **Why `reconcileSlug` is named (pass 5, C11).** A per-slug journal is named
    `<slug>.take-journal.<jid>.json`. A relabel that moved its slug's parts would strand that journal
    at the old slug, where its replay would stamp another chapter or fail its `takeId` test. §5.A's
    rule for entry points already covers it; step 0 now says so.
  - The restructure is **refused** with `take_repair_pending` when a book journal, or a per-slug
    journal on any slug the plan names, stays stuck on a move-step failure (R5-3, R6-3).

*The cursor* names the **last completed** group (revision 6 fixes the wording). Replay runs the
group **after** it. `planned` means the journal is written and nothing after it is confirmed. The
values, in order:
1. `planned`;
2. `state-landed`;
3. `stage` (sources → temp);
4. `drop` (delete ops → `.discard-<jid>.drop.*`, with the only-copy rule);
5. `clear-stale-previous` (→ `.discard-<jid>.stale.*`; today's Phase 1c);
6. `land` (temp → target);
7. `metadata` (today's Phase 3: the segments and verdict `chapterId` rewrite);
8. `cleanup`.

The route rewrites the journal atomically as each group **completes**: about six small writes per
restructure, plus one per source as `land` begins it (R7-2, below), not one per file. Revision 4 folds today's Phases 0 and 1b into one `drop` group,
after `stage`. With every source at its temp name and nothing landed yet, a drop can only meet a
slug's old occupant, which is what Phase 0's ordering existed to guarantee.

*Replay runs the group after the cursor and never re-runs a finished group.* The cursor is
rewritten only when a group completes, so a crash or a failed rename normally stops **inside** the
group after it, between two parts of one source. Revision 4 argued that a re-run was safe only at
group boundaries (pass 4, B1): a source half-moved in `stage` failed its own `takeId` check, and a
finished `land` re-run quarantined every chapter's freshly landed take. Revision 5 makes every group
idempotent **per part** (R5-1), and revision 6 settles which parts each group decides (R6-2):
- **`stage` (from → temp), `drop` (slug → `.discard-<jid>.drop.*`), `clear-stale-previous`
  (→ `.discard-<jid>.stale.*`).** For each part (listed for `stage` and `drop`; probed at the slug
  when the group runs for `clear-stale-previous`):

  | Source name | Target name | Replay does |
  |---|---|---|
  | present | absent | rename |
  | absent | present | done |
  | present | present | the copy at the source name is foreign (nothing in the protocol refills a vacated name): quarantine it; done |
  | absent | absent | `stage`, `drop`: lost: append to `lost`, log, continue. `clear-stale-previous` never meets this row, because it only acts on parts it finds |

  The presence test is sound here. Every target is journal-unique, and no take lands on any slug
  before `land`, so a slug name this group vacated cannot be refilled.
  - **The `takeId` check** reads the source's segments wherever they are: at `from`, or at `temp`
    once they have moved. When the copy at `from` carries another `takeId`, the take at `from` is
    not the one planned. Every part of that source still at `from` is quarantined and recorded as
    lost. Parts already at `temp` carry on.
- **`land` (temp → target), keyed on `landing` (R7-2, revision 7).** Revision 6 decided "landed"
  from the source's segments: temp holding none and the target's segments carrying the source's
  `takeId`. A source with no segments (an unindexed legacy take, or a legacy excluded chapter that
  kept `.previous.*` and `audioRenderedAt`, H22, N1, `restructure.ts:443`) could then never read as
  landed, and replay quarantined its own landed audio as foreign. Its table also had no row for
  "landed, temp present, target present" (pass 6, G3). So "landed" is now recorded, not inferred.
  For each source `k`, `land` does, in order:
  1. if `k` is not in `landing`: quarantine every take part present under the target slug's names,
     live and previous, every suffix, to `.orphaned/`. Nothing of `k` has moved yet, so anything
     there is outside the plan;
  2. append `k` to `landing`, an atomic journal rewrite;
  3. rename each of `k`'s parts from temp to target.

  From step 2 on, the target's names belong to `k`. Two sources never share a target, `stage` and
  `clear-stale-previous` have vacated every previous take at a target slug, and nothing else lands
  there. So replay decides each part from `landing` alone:

  | `k` in `landing`? | Part at temp | Part at target | Replay does |
  |---|---|---|---|
  | no | any | any | steps 1–3 above: quarantine whatever is at the target's names, record `k`, then rename |
  | yes | present | absent | rename |
  | yes | present | present | the occupant is outside the plan (it cannot be `k`'s, whose copy is still at temp): quarantine it to `.orphaned/` (never overwritten), then rename |
  | yes | absent | present | already landed: done |
  | yes | absent | absent | lost: append to `lost`, log, continue |

  A source with no segments lands like any other. Foreign audio is never left beside a source's
  segments, because step 1 clears the whole target before anything of `k` arrives. A crash after the
  last land rename and before the cursor write re-runs `land` as a no-op: every source is in
  `landing`, and every part is at its target.
- **A lost part never blocks.** Every "lost" row in these groups is reached only after R9-2's
  re-probe (Journal rules) finds the part absent at every probe. It leaves an incomplete take: with no audio the chapter reads
  unrendered, and with no segments it is unindexed (§4.2). `lost` is logged at `cleanup`.
- **`metadata`:** each rewrite sets fixed values. It runs only on the target of a source in
  `landing` (R7-2), and, where the source has a recorded `takeId` (or previous `takeId`), only when
  the target's segments still carry it, so a replay never rewrites another chapter's metadata. A segments or verdict file it cannot parse is **skipped** and recorded under
  `unreadable`, as today's Phase 3 is best-effort over a corrupt file
  (`rewrite-chapter-slugs.ts:262-305`). It never blocks the slug (R6-3, revision 6). The chapter is
  then unindexed or unscored, as it would be on `main`.
- **`cleanup`:** unlink the discard set, then the journal, under `book` (R7-1).

*Did `state.json` land?* With the cursor at `state-landed` or later: yes. With the cursor at
`planned` (a crash between the state write and the cursor write), it landed exactly when
`state.json`'s `relabelJid` equals the journal's `jid` (R6-5, revision 6). Then replay advances
and rolls forward; otherwise it rolls back.
- **Why not compare chapter maps.** Revision 5 compared `state.json`'s chapter map with a planned
  map. A later writer can change the map before replay runs: a PUT that sends `chapters`, or the
  analysis persist (W16), which rebuilds it from the hints. The comparison then read "did not land",
  and replay rolled the hints back over a state that had landed (pass 5, C6).
- **Why the stamp survives.** It is a book-level field, and every later `state.json` writer spreads
  the state it read: commit stamps, the PUT (`book-state.ts:1509-1512`), the analysis persist
  (`...prev`), exclude and the heal. Backup restore and the bundle overwrite swap the whole file,
  but they replay every book journal first (R5-5). The reparse wipe removes the journals.
- The field is never cleared. A later relabel overwrites it with its own fresh `jid`.

*The rollback window: before `state.json` lands.* Exactly two artifacts are written in it:
- **the journal itself**;
- **`manuscript-hints.json`**, when `hintsWritten`. Rollback restores `hintsPrior`: it rewrites the
  prior content, or removes the file if none existed.

Nothing else is in the window, because nothing else has been written yet:
- `manuscript-edits.json`, the ManuscriptRecord and the analysis cache come **after** `state.json`;
- so do the audio groups.

A failed state write therefore restores the hints, deletes the journal and fails the restructure,
as today. A crash in the window is undone the same way by replay.

*After `state.json` lands: forward only.*
- **In-process.** A failure in the edits write, the ManuscriptRecord, an audio group, the pending
  reconcile or the cache rebuild is **parked**. The remaining writes still run, and the parked
  error rethrows last (the CLAUDE.md deferred rethrow).
  - An audio group that fails on a move step, with any code (a held file that outlasts
    `renameWithRetry`, EACCES, a full disk), stops at its cursor, with the journal kept. The
    restructure answers 500 with one fixed sentence for every code (R8-2, revision 8): "The
    chapters were changed, but some audio files could not be moved into place. Castwright will keep
    trying for a minute. If that does not work, close any other program using the book's folder, and
    check free disk space and the folder's permissions. Castwright finishes the move the next time
    one of these chapters is rendered or its take is changed, or when it restarts." Revision 5's
    "they will be moved into place automatically" was true only for R4-2's 60 s of retries (R6-3).
    Revision 6's "open the chapter again" named a read, and reads never replay a journal (pass 6,
    G10). Revision 7's "the next time this book's audio is changed" was broader than what replays:
    re-rendering a chapter the journal does not name does not replay it, and its held-file wording
    had no variant for other codes (pass 7, J12). The sentence now names only what does: an entry
    point on a named slug (a render, splice, QA repair, Accept, Reject or exclude of one of those
    chapters, which the sentence calls "rendered or its take is changed"), or the boot fsck at a
    restart. A book-wide
    operation replays it too, and the sentence leaves that out, because a user does not reach for a
    restructure or a restore to finish a move.
  - The route then schedules the background `reconcileBook` retries of R4-2. Their replay stamp is
    a swallow site (State-write sites).
  - Until the journal finishes, it blocks only the slugs it names (R5-3). An entry point on one of
    them answers `take_repair_pending` (R5-4).
  - The pending-entry reconcile and the cache rebuild keep their best-effort catches, and still run
    after a parked audio failure.
  - **The pending-entry reconcile reads the plan (R6-9, revision 6).** Today it moves an entry only
    for a chapter whose `.previous.mp3` the rewrite reported moving, and drops every other touched
    chapter's entry (`restructure.ts:159-176`; `chapters-restructure.ts:668-672`). After a parked
    `stage`, that would drop the entries of chapters whose takes the journal will still land
    (pass 5, C10). It now moves an entry for every `stage` source whose `prevTakeId` is not null,
    whether or not its parts have landed, to the source's new chapter. It drops the entries of
    `drop` slugs and of `clearStalePrevious` slugs. While the journal is stuck, an Accept or Reject
    on a moved entry meets a journal-named slug and answers `take_repair_pending` (R5-3). Once the
    journal finishes, the entry matches as usual: it carries `chapterUuid` and its render times.
  - **A parked edits write skips the cache rebuild (revision 5).** `refreshCacheFromEdits` reads
    `editsPath` from disk in `replace` mode (`store/analysis-cache-rebuild.ts:57-72,107-119`). After
    a failed edits write it would rebuild the cache from the pre-restructure, old-id sentences
    against a renumbered state, a second case of a later write depending on a parked one. The cache
    is left as it is, which is the state `main` leaves after a crash in the same window (Remaining).
- **After a crash.** Replay finishes the audio from the cursor. The relabel journal does not redo
  the edits write: its payload is every sentence. The cache and the ManuscriptRecord are derived.
  - A restart rehydrates the record from the hints, which landed before `state.json`.
  - A crash between the state write and the edits write leaves today's gap. Revision 4 said the
    GET-side edits/cache reconciliation (`book-state.ts:598-606`, the filter at `:660-675`) covered it. It does not: that
    reconciliation drops edits by sentence-id range, not by chapter renumbering (pass 4). The claim
    is withdrawn, and the gap is listed under Remaining as a pre-existing, accepted residual whose
    fix is #4227's own design pass, outside this design (§8.3). The restructure's own comment (`chapters-restructure.ts:605-609`) still says
    partial state "is recoverable via the reconciliation filter". #4224 (merged at `33f3647c`)
    corrected only its anchor, to `book-state.ts:660-675`, where the filter keeps an edit whose id
    is still in the cache or above its maximum and drops the rest, by sentence-id range. That does
    not recover a renumbering, so the claim is still false. Phase 4 corrects the claim itself,
    unconditionally (pass 7, J13).
    **Update (2026-11-17, #4227):** closed on `main` by a separate edits journal (`.audiobook/restructure-edits-journal.json`, `workspace/restructure-edits-journal.ts`), written before the state write and replayed at the next restructure or at server start; it adds no `state.json` field and is independent of the relabel journal above.
  - Pending entries are not reconciled by replay. A server-recorded entry carries `chapterUuid` and
    its render times, so `entryMatchesChapter` refuses it on the wrong chapter
    (`revisions-store.ts:199-203`, widened as in Retry recognition).

*Also:*
- The rename covers every take suffix, with previous for all three extensions. Drops run in this
  journal's `drop` group, not through `dropAllTakes`, and use `dropAllTakes`' only-copy rule,
  decided when the journal is written (`drop[].onlyCopy`, R6-2, R7-3). `dropAllTakes` serves
  exclude only.
- `buildAudioOps`' presence test is `audioRenderedAt` **or** a take on disk, live by
  `chapterAudioExists` or previous (R8-7, step 0 above). That also closes H11's residual
  (`restructure.ts:443`).

**Scoring** (`commitScoring`, F23; R3-3; E5, E7, E8).
- **Ids exist before the pass reads.** The pass's caller first opens one span through its `commit`
  callback and runs `ensureTakeIdentity` for every chapter. So a legacy book's first pass reads
  embeddings and segments that already carry ids. Revision 3 minted them inside `commitScoring`,
  after the scorer had read id-less files, which wasted that pass.
- **One segments read per chapter (A6).** On `main`, phase 1 reads embeddings (`aggregate.ts:631`),
  then segments (`:672`), and then `loadSegmentsFiles` reads every chapter's segments again for
  engine classification (`:711`). Commits do not abort scoring, and Reject is allowed during it
  (`revision-ops.ts:141` checks generation only). So the three reads can come from different
  takes.
  - Phase 1 now reads each chapter's `segments.json` **once**. Revision 4 called that one read "the
    same population `loadSegmentsFiles` uses", which was not true (pass 4, B7). The two reads apply
    different filters today:
    - `loadSegmentsFiles` keeps a file that `readdir` lists, that `readJson` parses, and whose
      `chapterId` is a number (`audio/segments-io.ts:201-221`);
    - phase 1's `readSegmentsFile` keeps any file that `readFile` and `JSON.parse` accept, with no
      `chapterId` check (`aggregate.ts:480-488`).
  - **One read, two filters (revision 5).** The read is a single `readFile` plus parse per chapter.
    The per-chapter join consumes every file that parses, as `readSegmentsFile` does today. The
    engine classifier (`resolveConfiguredEngineByChar`) consumes the subset whose `chapterId` is a
    number, through `loadSegmentsFiles`'s own predicate, extracted so that both use one function.
    - **The classifier's filter includes `loadSegmentsFiles`' exact-name membership (R6-12,
      revision 6).** `loadSegmentsFiles` admits a chapter only when one `readdirSync` of `audio/`
      lists `<slug>.segments.json` by its exact name (`audio/segments-io.ts:207-219`), and
      `qa-report.ts` still calls it. On a case-insensitive filesystem the single `readFile` also
      finds a differently cased name, which `readdir`'s exact-name set does not contain. So the
      extracted predicate takes that name set as an input: the pass makes the same one `readdir` per
      pass, and the classifier admits a parsed file only when its exact name is in the set and its
      `chapterId` is a number. Revision 5 said the classifier's population was exactly
      `loadSegmentsFiles`', and in the next sentence that it also took the case-insensitive read;
      both could not hold (pass 5).
    - So the classifier's population is exactly `loadSegmentsFiles`', and the shared contract with
      `qa-report.ts` that `aggregate.ts:698-710` protects holds. The per-chapter join keeps the
      case-insensitive read, as `readSegmentsFile` does today, so chapters whose segments lack a
      `chapterId`, or whose name differs only in case, are still scored.
    - The two filters see the same bytes, so the ABA close below holds for both.
  - **A chapter is scored only when its embeddings `takeId` equals that segments `takeId`.** That
    id is the chapter's scored id, the CAS token.
  - A chapter whose two ids differ (stale or legacy embeddings, or a commit between the two reads)
    is skipped for this pass and logged. It **does not** re-arm the re-run: a persistent mismatch
    would otherwise re-arm every pass, and each pass costs GPU auditions.
- **Incremental writes are kept (srv-36).** Each per-character `mergeVerdictRows` becomes one
  `commitScoring` call: one short span per character, covering that character's affected chapters.
  Inside it, a chapter's rows are written only if its live segments `takeId` still equals its
  scored id. A chapter that changed mid-pass is dropped, logged, and requests a re-run (below). The
  verdict file keeps its bare-array format (R4-6).
- **The attempted marker** (#1436) goes through the same call, existence-only. Its CAS id is the
  segments `takeId` read in phase 1, which exists even when the embeddings do not: the
  `justFinalized` embed-failure case (`aggregate.ts:666-670`) is exactly the one #1436 needs.
  Generation's per-chapter call (`generation.ts:295`) becomes a single-chapter `commitScoring`
  whose CAS id is the commit result's `newTakeId`. A mismatch there means a later commit already
  replaced the take, and the marker is not written.
- **`triggerScoring`** keeps its single flight per book (`generation.ts:143`). A trigger that arrives
  while a pass is in flight is **queued** in a pending re-run instead of being dropped. Each trigger
  carries a `source`: `'render'` (`afterChapterFinalized`), `'partial'` (splice, QA repair) or
  `'resume'` (the resume route). The resume route uses the same path.
  - **Merge only at an equal run key (R6-1, revision 6).** Pending re-runs are a per-book FIFO list
    with one entry per distinct `runModelKey`; the resume route's absent key is its own value. A
    trigger merges into the entry with its key, or appends a new entry. The pass's `finally` starts
    the oldest entry. Revision 5 merged every trigger into one re-run and kept "the most recent
    trigger's" key. But `scoreBook` applies `runModelKey` to every character with lines in any
    `justFinalized` chapter, which decides its engine and its audition tier (`aggregate.ts:765`,
    `:976`). So a render trigger merged with a QA repair at another key auditioned one side's
    characters at the other side's tier, the non-comparable speaker space #3518 and #3524 guard
    against (pass 5, C2). The per-key list stays in revision 7 for that reason alone: it decides
    each pass's audition tier. It no longer decides any reconcile (E8, below).
  - **"Starts at once" is decided synchronously (J5, revision 8).** A pass starts at once exactly
    when `triggerScoring`'s single-flight check (`scoringInFlight.has(bookId)`, today
    `generation.ts:143`) finds no pass of the book in flight, with no await before the check. The
    book's in-flight marker is **continuous across the hand-off**: the finished pass's `.finally`
    (today `:230`) takes the oldest pending entry and sets the marker for it in the same synchronous
    callback that clears its own, before any await. Everything asynchronous the queued pass needs,
    its re-read of `chapters` and its `uuid` → slug mapping (below), runs inside its own
    `runBookJob` body, from its own lease. So a trigger that arrives during the hand-off finds a
    pass in flight and is queued, and single flight holds. Revision 7 left both rules unstated, and
    if the `.finally` had awaited that work before re-setting the marker, a trigger in the gap would
    have started a second pass beside the queued one (pass 7, J5).
  - Within one entry:
    - `justFinalizedChapters`: the union of every merged trigger's chapters, recorded by chapter
      `uuid` (R7-12, revision 7), or, for a chapter with no `uuid`, by its `id` and `slug` together
      (R8-6, revision 8). The `uuid` mint is a swallowed lazy migration, and the analysis persist
      carries `uuid` only when the previous chapter had one (`analysis.ts:8594-8616`), so a chapter
      can lack one (pass 7, J11). When the entry starts, inside its job body, they are mapped to
      slugs from the chapters it re-reads: by `uuid`, else by `sameChapter`'s `id`-and-`slug`
      match. A chapter that matches nothing (it no longer exists, or a restructure renumbered a
      chapter that had no `uuid`) is skipped and logged; its characters then audition at their
      resolved key in that pass, the #3518 class, for that chapter only. A queued pass registers its
      own scoring job only when it starts, after the in-flight pass's token is released
      (`book-jobs.ts:50-78`), so a restructure can run in between and renumber the slugs a trigger
      named. `drainChildren`'s "by the time this render's token is released scoring's is already
      held" (`generation.ts:2500-2504`) holds only for a pass that starts at once. The set drives
      #1436's stamping, so no chapter's own trigger is lost;
    - `runModelKey`: the entry's key, which every merged trigger shares;
    - `chapters`: re-read when the re-run starts, inside its job body.

    Revision 6 also kept a `keep` (the OR of the render triggers') and a `reconcile` flag per
    entry. Both are dropped: a queued pass never reconciles (E8).
  - **Re-arm bound.** A mid-pass CAS mismatch requests a re-run only when the pass was **not**
    itself a mismatch-requested re-run. A chain of passes therefore re-arms on mismatch at most
    once. New triggers always re-arm.
- **Which passes run the post-audition tier reconcile (E7, E8, E9, E11, E13; restated together in
  revision 10).** A pass runs `reconcileResidentQwenTiers` (`generation.ts:215-216`;
  `tts/ensure-sidecar-loaded.ts:236` onward) after its auditions only when **all** of these hold:
  1. **it started at once** (E8): `triggerScoring`'s synchronous single-flight check found no pass
     of the book in flight when its trigger arrived (J5, above);
  2. **its trigger is a render's or a resume's** (E7);
  3. **for a resume pass, no render, splice or QA repair of any book was running when the pass
     started or is running at the reconcile, and none registered in between** (E9 as restated by
     E11 and E13). When the pass starts, in one synchronous read, it samples
     `isAnyGenerationActive()` and reads the registration epoch `readSpliceEpoch()` (E13).
     Immediately before the reconcile, synchronously, with no await between the check and the
     call, `isAnyGenerationActive()` is sampled again and the epoch is read again. The pass
     reconciles only when both samples are false and the two epoch reads are equal. If either
     sample is busy, the epoch moved, or the epoch reader is unregistered at either read (`null`,
     which the gate says to treat as "moved"), the pass skips the cleanup and logs it.

  | Trigger | Starts at once (no pass in flight) | Queued behind a pass, started from the pending list |
  |---|---|---|
  | `'render'` (a render's own pass) | reconciles against its `ctx.keep`, the run's full-cast set (`:207-216`), as on `main` | **never** reconciles (E8) |
  | `'resume'` | reconciles against `scoreBook`'s own `usedQwenTiers`, as on `main` (`:215`), **unless** a render, splice or QA repair of **any** book was running when the pass started (E13) or is running immediately before the reconcile, or one registered after the pass started; then it skips the cleanup (E9, E11, E13) | **never** reconciles (E8) |
  | `'partial'` (splice, QA repair) | **never** reconciles (E7) | **never** reconciles (E7, E8) |

  - **Why E9 (pass 7, J5, Q1).** Revision 7 said that, because the route refuses resume while the
    book generates (`qa-report.ts:71-74`), "no render is running when it starts". That held when the
    request arrived, not when the pass reconciled. Two awaits sit between the route's
    `isGenerationActive` check and the pass's start, the route's own `runBookJob` (`:75`) and
    `triggerScoring`'s registration, up to 30 s with R4-10's retry, and the pass then auditions for
    minutes. A render that registered in either window lost its tier. And `isGenerationActive`
    counts generation jobs only (`generation.ts:661-663`), so a resume beside a running splice or
    QA repair evicted the tier it was synthesising with: **#4235**, pre-existing on `main`. E9's
    re-check closes these, and so **closes #4235**. #4235 proposed refusing Resume while a splice
    or QA repair runs; E9 lets the pass score and skips only its cleanup, so its auditions still run
    beside synthesis, which E5 accepts. The route's own refusal during generation is unchanged.
  - **Why E11's reach (pass 8, K3, K4, Q1).** Revision 8 implemented E9 as one per-book sample of
    `inFlightByBook` plus the splice registry. That sample had two holes:
    - **the chapter gap (K3).** The queue makes one POST per chapter, and `deregisterJob` empties
      `inFlightByBook` between chapters (`generation.ts:610-622`), the same B4 finding that
      withdrew E3's wait (below). A reconcile that landed in a gap evicted the queue render's tier;
    - **other books (K4).** `reconcileResidentQwenTiers` unloads from the one sidecar every book
      shares (`ensure-sidecar-loaded.ts:288-289`). A resume of book A whose `usedQwenTiers` is
      0.6B alone evicted 1.7B under a render of book B.

    E11 takes the repo's own eviction-safety predicate. `isAnyGenerationActive()`
    (`gpu/active-generation-gate.ts:139-142`) is process-wide, folds in the splice/QA-repair
    registry's count (`setInFlightSpliceCounter`, `chapter-job-coordination.ts:21`), and fails
    closed when generation has not registered. The gate reserves the eviction decision for it
    (`:165-170`). It closes K4. A single sample of it still reads idle in a render's chapter gap,
    as the gate's own header says (`:155-159`). So the re-check also compares the **registration
    epoch**, `readSpliceEpoch()` (`:128-131`): the registry's count of every `registerSplice` ever
    made (`chapter-job-coordination.ts:25-26,40`) plus generation's count of every `registerJob`
    (`generation.ts:582-585,683`). A queue render's next chapter, or a splice or QA repair, that
    registered at any point after the pass started moves it, even if it has deregistered by the
    reconcile. That closes K3 for every gap in which a registration falls during the pass's
    minutes of auditions.
  - **Why E13 (pass 9, L1, Q1).** The epoch counts registrations only: `deregisterJob`
    (`generation.ts:610-622`) never touches it. So revision 9 missed a job **already running when
    the pass started** that deregistered before the reconcile, with nothing registering in
    between, and the reconcile then landing in the gap that followed, where the gate reads idle
    (`gpu/active-generation-gate.ts:155-159`). For another book's render that is the common shape:
    a pass of a few minutes that starts mid-chapter and reconciles in the gap after it. The same
    held for a splice or QA repair of any book running at the start. Revision 9 said E11 covered
    the chapter gap and another book's render, which held only when the pass straddled the next
    registration. E13 samples `isAnyGenerationActive()` in the same synchronous read that takes the
    epoch at the start, and skips the cleanup if it was busy then. "Idle at the start, no
    registration in between, idle at the reconcile" then means nothing ran during the pass, apart
    from the windows below. It skips more often, the direction E11 already accepts.
  - **No new query, no new import edge.** `generation.ts` already imports from
    `gpu/active-generation-gate.ts` (`:105-110`), `isAnyGenerationActive` among them (`:109`, for
    the run-start reconcile at `:1216`), and registers its providers there (`:682-683`), so the
    re-check adds one name, `readSpliceEpoch`, to an existing import. R8-8's `hasInFlightSpliceForBook` and
    `isBookSynthesising` are withdrawn, and `chapter-job-coordination.ts` gains nothing. CLAUDE.md's
    leaf-gate rule is untouched: the gate is the leaf, and the route reads it.
  - **What E11 and E13 still do not see.** A render that has started but not reached `registerJob`,
    whose own run-start reconcile runs first (`generation.ts:1216-1217`); the gate documents that
    window (`:30-49`). A job that registers during the reconcile's own `/health` await
    (`ensure-sidecar-loaded.ts:244`). A pass whose whole span, from its start to its reconcile,
    falls inside one chapter gap, which is a POST round-trip against minutes of auditions: it reads
    idle at both samples and sees no registration. In each, the job's next synthesis reloads its
    tier: a reload, not a failure, and narrower than `main`, which has no re-check at all. A job
    already running at the start is no longer among them (E13). The gate sees renders, splices and
    QA repairs only: voice samples, voice-style, cast and single design, the `qwen-voice` routes and
    another book's scoring auditions are invisible to it, so a resume can still evict their tier, as
    on `main` (revision 10; pass 9).

  - **Why a queued pass never reconciles (E8, pass 6, G1).** On `main`, a trigger that finds a pass
    in flight is dropped (`generation.ts:143`), so it never reconciles. Revision 6 queued it, and the
    queued pass reconciled against a target captured when it was queued: a render trigger's `keep`,
    from a render that may have ended, or a resume trigger's `usedQwenTiers`, which follow each
    character's resolved key and not any running render (`aggregate.ts:1145-1148`). Nothing checks
    for a running render when a queued pass starts: the resume route checks `isGenerationActive`
    only when the request arrives. Pass 6's reachable case: a QA repair's partial pass starts; the
    user clicks Resume scoring, which is accepted and queued; the user starts a Quality (1.7B)
    re-render of another chapter; the partial pass ends without reconciling; the resume pass
    auditions at the characters' stamped 0.6B and reconciles against `{keep06}`, evicting 1.7B
    under the re-render. Under E8 the queued resume pass never reconciles, which is `main` parity.
  - **Why a partial pass never reconciles (E7, revision 6).** `computeUsedQwenTiers` puts every Qwen
    character without an elevating `ttsModelKey` on the run's key
    (`tts/per-character-engine.ts:43-58,70-80`), so the full-cast set is a property of a run, not
    of the book. Each request brings its own run key: a render from its POST body
    (`generation.ts:830-831,1019-1021`), a QA repair from `body.modelKey ?? segFile.modelKey`
    (`chapter-qa-repair.ts:310-315`; the Listen view omits `modelKey` on purpose, so the chapter's
    own render key wins), a splice re-record from its request. Nothing serialises a repair against
    a render. So revision 5's full-cast `keep` for a partial trigger, computed for a QA repair on a
    chapter rendered at 0.6B while a queue renders at 1.7B, was `{keep06}` and evicted 1.7B under
    the queue's next chapter (pass 5, C1). A partial trigger therefore carries no `keep`.
- **Partial-job triggers run at once (E5).** After a successful commit, splice and QA repair request
  scoring with `source: 'partial'`. They do it from their exit path, after they have deregistered
  and **outside any commit span**. `runBookJob`'s registration takes book-op itself, so requesting it
  inside a span would nest.
  - **No wait.** The pass starts whenever `triggerScoring` would start one: at once, or as the
    queued pending re-run when a pass is already in flight. Revision 4 made it wait while any synth
    job of the book ran (E3, R4-9). Pass 4 showed that this cannot be observed for a queue-driven
    render (B4). The queue makes one POST per chapter (`generation.ts:387-391,497-503,1192-1193`),
    and `deregisterJob` empties `inFlightByBook` between chapters (`:610-619`), so the wait fired in
    every gap. There is therefore no `afterRenders` mark and no synth-job exit hook. The same finding
    is why E11's resume re-check is not a per-book sample either: it reads the leaf gate's
    process-wide `isAnyGenerationActive()` and its registration epoch, and adds no per-book reader
    of `chapter-job-coordination.ts` (revision 8's `hasInFlightSpliceForBook` was one, and is
    withdrawn).
- **What the design closes, and what it does not.** Revision 6 said "nothing is evicted under a
  running render". That was broader than the design (pass 6). What E7, E8, E9 and E11 close is
  narrower: **a partial job's pass never evicts a tier, a queued pass never does, and a resume pass
  never does while a render, splice or QA repair of any book is running, or when one was running at
  its start or registered during the pass** (E9, E11 and E13, which also close #4235). These eviction paths remain, all
  pre-existing on `main` and none widened here:
  - a render's own pass that started at once reconciles after its auditions, and a render at
    another run key, or a splice or QA repair, that started during those auditions loses its tier.
    On `main` the same happens. E9, E11 and E13 are the owner's decisions for a resume pass only,
    so a render's own pass keeps `main`'s behaviour;
  - a resume pass in E11's and E13's blind windows (above): a render that has not yet registered, a
    job that registers during the reconcile's await, a pass that lies wholly inside one chapter gap,
    or synthesis the gate does not see (voice samples, design, another book's scoring auditions);
  - two concurrent renders of one book at different keys (`::*` and `::X`, N9) evict each other's
    tier through their own passes;
  - the run-start reconcile at a render's chapter POST targets that render's own set
    (`generation.ts:1216-1217`; `keepForRunStart`, `gpu/evict-idle-tts.ts:141-150`). It can evict a
    tier that a concurrent QA repair or splice is synthesising with, as on `main`. **New because
    partial passes are new:** it can also evict a partial pass's audition tier mid-pass, which then
    reloads at the pass's next audition. That is a reload, not a failure.
- **The cost (E7, E8, E9, E11, E13).** A pass that never reconciles, or a resume pass that skips its
  cleanup under E9, E11 and E13, can leave a tier its auditions pulled, such as
  the 0.6B base beside a 1.7B render, resident beside the render's tier: the co-residency that the
  post-audition reconcile exists to prevent on an 8 GB card. It stays until the next render
  reconcile, which is the run-start reconcile at the render's next chapter POST
  (`generation.ts:1203-1220`; the queue sends one POST per chapter), or a pass that starts at once
  and reconciles. With no render running, it stays until the next render starts. **E11 and E13
  make the skip more frequent, stated honestly:** a resume pass now skips its cleanup whenever a
  render, splice or QA repair of any book is running at its start or at its reconcile, another
  book's render included, and whenever one registered during its auditions. On a busy box Resume
  therefore rarely cleans up, and its stray tiers wait for the next render's reconcile. E7, E8, E9,
  E11 and E13 accept that cost over evicting a running job's tier.
- **Auditions beside synthesis:** auditions can still run beside a sibling chapter's synthesis, as a
  render's own between-chapter scoring pass already does on `main`. E5 accepts that.

**Readers.**
- They stay lock-free, through the module's accessors. Each part changes by an atomic rename, so
  cross-file skew is limited to one rename window.
- The job readers that write back (splice, QA repair, scoring) are protected by the CAS. **The
  export job is not** (revision 4). `build-m4b` used to probe durations up front and concatenate
  later, so a commit to a chapter it had not reached yet shipped that chapter's old marks over its
  new audio (#4223). This design neither closes nor widens that. **#4224 closed it** outside this
  design (merged at `33f3647c`): the m4b now snapshots each chapter's audio before it probes, and
  probes and concatenates the snapshots (`export/build-m4b.ts:83-104,120`).
- The portable export lists **live parts from the module** (F15). The module excludes
  `.previous.*`, `.next-*`, `.discard-*`, `.take-journal.*` and `.orphaned/`. (Revision 3's
  "backups skip `.orphaned/` too" is withdrawn as vacuous: auto-backup snapshots `state.json` only,
  `auto-backup.ts:209-270`.)

**Windows (F9, N4; D4).**

Pass 1 probed NTFS on Windows 11 26300 with ffmpeg 8.1.1 and Node `fs`:

| Holder | rename-away | rename-onto | unlink, then rename |
|---|---|---|---|
| none | OK | OK | OK |
| Node `openSync` (R-a playback, the codec zip) | OK | **EPERM** | OK |
| `ffmpeg -re -i` reader (clip; by the same mechanism the MP3 zip/folder `applyId3v24Tags`; the m4b build until #4224) | **EBUSY** | **EPERM** | unlink **EBUSY** |

What the protocol does with each:
- **A Node holder never blocks a commit.** Only rename-onto fails under it, and the protocol never
  renames onto a held name: step 5 moves the live file away first, and step 6 installs onto a free
  name.
- **An ffmpeg holder blocks step 5's first rename.** That is the retry path above. Nothing else has
  moved yet, so the in-span rollback is empty.
- Every rename is `renameWithRetry`, with its full budget (`RENAME_RETRY_WORST_CASE_MS`, ~3.6 s,
  `atomic-rename.ts:22-26`, #915). Revision 2's 1 s cap stays removed. No span deadline replaces it
  (E2).
- **Row Q's NTFS cells are recorded** above. The OneDrive-backed cells, and real span timings, are
  still owed on the box (§7).

**Lock order.**
- No new class. The module uses existing edges only: `book-op → book → state-json` (the stamp) and
  `book-op → revisions`.
- `revision-op` is removed, and with it the `revision-op → revisions` edge.
- **New rule:** a long job takes book-op only at its commit site, around `commitTake` (or through
  scoring's `commit` callback), never across preparation.

**Span length and contention (F11; E2).**
- **Rename count.** A commit renames up to **21** parts: 7 parts × (discard old previous +
  preserve + install). It also writes the journal and the stamp, and unlinks at cleanup.
  `withBookOp`'s resolve adds `backfillAudioModelKeysFromSegments` (`book-op-lock.ts:262`),
  O(chapters), except in the module's in-job spans, which skip it (R7-8, below).
- **Typical:** tens of ms plus O(chapters) reads.
- **No deadline (E2).** Revision 3's 6 s span deadline is removed. A fully staged commit is never
  abandoned for being slow: a slow OneDrive commit, or one that meets an ambiguous slug, finishes.
  The long tail is:
  - `renameWithRetry`'s ~3.6 s worst case per rename;
  - step 0's migration on the rare multi-live shape, whose full decode (§6.1 step 2) takes seconds
    to tens of seconds for a long chapter. It runs **at most once per slug**: its outcome is a
    rename, and nothing rolls it back any more.
- **The waiters that cannot wait retry instead (R4-10).** Every book-op waiter has a 10 s
  acquisition budget (`file-lock.ts`, #2260). Three of them neither wait longer nor retry today:
  - the background autosaves `PUT …/listen-progress` (`book-state.ts:2754`) and
    `PUT …/listen-stats` (`book-state.ts:2921`);
  - job registration, `runBookJob`'s `withBookOp` (`book-jobs.ts:50-56`), which every long job,
    render included (`generation.ts:2495-2531`), registers through.

  Each retries a **pre-entry** book-op timeout (the `entered` flag, as the commit retry uses) up to
  twice more: three acquisitions, 30 s in all. Only then does it answer the existing curated
  `lock_contention` sentence. A timeout from inside the span is not retried. A dropped autosave is
  still repeated by the client's next tick. These are sequential re-acquisitions, never a nested
  `withBookOp`.
  - **Ordering under retry (R5-6, revision 5).** `withKeyLock` is a FIFO chain, but a waiter that
    times out re-enqueues at the **tail** (`file-lock.ts:279-286,305-351`). Two listen-progress
    autosaves queued behind a long span can therefore land out of order. The web client sends no
    `listenedAt` (`src/lib/api.ts:2780-2785`), so its writes are last-write-wins by landing order,
    `markers` included (`book-state.ts:2823-2858`). Today the older write simply fails; with a retry
    it could overwrite the newer one. So a write without `listenedAt` takes its ordering time from
    when the server **received** it, before the first acquisition. Its retried attempts apply
    srv-34's existing compare-and-set against that time (`book-state.ts:2828-2835`), exactly as if
    the caller had sent `listenedAt`. An older write's retry then finds a stored `updatedAt` at or
    after its own and returns the stored record. A first attempt is unchanged, and the client
    changes nothing. Listen-stats is a commutative max-merge (`:2930-2934`), so it needs no rule.
  - **Registration retry and render exit.** `drainChildren` holds each render's token until
    scoring's registration resolves (`generation.ts:2500-2505`), so with the retry a render's exit
    can stretch by up to 30 s. That holds a token, not a span, so nothing else waits on it.
- **What the design's spans cost to resolve (R7-8, revision 7; revision 6 undercounted it).** Every
  `withBookOp` resolve runs `backfillAudioModelKeysFromSegments` over every chapter, unconditionally
  (`book-op-lock.ts:251-263`, `scan.ts:1304-1324`): one small segments read per chapter, under
  book-op. Revision 6 counted only the chapter-start span, "about 2N resolves instead of N". The
  design opens more spans than that:
  - per chapter of a render: the registration (as on `main`), the chapter-start span, the commit
    span, and the attempted marker's single-chapter `commitScoring` span: about 4N;
  - per scoring pass: the scoring job's registration (as on `main`), the pre-read
    `ensureTakeIdentity` span, and one span per character write: about C + 2.

  **The count.** Take a 60-chapter, 30-character render with one scoring pass per chapter. The render
  path makes about 240 resolves, and the passes about 60 × 32 = 1,920. With the heal in each,
  that is about 2,160 × 60 ≈ 130,000 segments reads, against about 120 × 60 = 7,200 on `main`, whose
  render makes two resolves per chapter (its registration and its pass's). Commits and autosaves
  wait behind every one of those spans.

  **The reduction.** `withBookOp` gains `{ backfill: false }` in `BookOpOptions`
  (`book-op-lock.ts:406-411`). It skips only `backfillAudioModelKeysFromSegments` in `accept()`
  (`:251-263`); the resolve still reads `state.json` under the lock and still heals the index and
  record for a locked caller. The module's in-job spans pass it: the chapter-start span, the commit
  span, the attempted-marker span, and scoring's pre-read and per-character spans. Registrations and
  every quick operation keep the backfill, so a book is still healed at least once per job.
  Revision 7 justified the skip by saying the job's own stamps are the only writers of take fields
  inside a running job. That is not so: the analysis persist, the PUT and other jobs' commits write
  them too (pass 7, J6). The skip is still harmless: those writers either stamp every member
  themselves (§4.4) or carry members they read (§4.3), and the next registration or quick operation
  heals whatever is left. Each span also reads the `audio/` listing for journals **once** and shares
  it across its `reconcileBook` and `reconcileSlug` calls.

  **The recount, with the design's own CAS reads (revision 8; pass 7, J6).** Revision 7 counted the
  resolve-time backfill reads only, and called the result "the same ~7,200 segments reads as
  `main`". It left out the reads the design adds on purpose: each per-character `commitScoring`
  span reads the live segments `takeId` of every chapter in which that character has rows, which
  is `scoreAndMergeCharacter`'s one `mergeVerdictRows` per chapter per character
  (`aggregate.ts:1025-1077`). Per pass that is the sum, over chapters, of the characters who speak
  in each. For the example (60 chapters, 30 characters, about 8 speakers a chapter, one pass per
  chapter):

  | Segments reads | Design | `main` |
  |---|---|---|
  | resolve-time backfill | ~7,200 | ~7,200 |
  | scoring's phase-1 reads (one per chapter per pass after B7; two on `main`) | ~3,600 | ~7,200 |
  | per-character CAS reads (~480 a pass) | ~28,800 | none |
  | **total** | **~39,600** | **~14,400** |

  **The CAS row is an upper bound (R9-9, revision 9; pass 8 note).** It counts a book that is
  already fully rendered and is being scored again, where every pass sees 60 rendered chapters.
  The per-character loop runs only over chapters with embedding rows (`aggregate.ts:1025-1077`), so
  in a render from scratch pass *k* sees about *k* chapters: about 8 × (1 + … + 60) ≈ 14,600 CAS
  reads, roughly half. Scoring's phase-1 reads scale the same way on both sides.
  If every character speaks in every chapter, the CAS reads rise to about 108,000. Each one is a
  whole-file read and parse (R8-9): a bounded head read would depend on `takeId` being the file's
  first key, which a legacy file rewritten by `ensureTakeIdentity` does not guarantee. Each CAS
  span reads only its own character's chapters and holds book-op for milliseconds plus those
  reads, so the cost lands as many short spans, not one long one. The design also makes about
  2,160 `state.json` reads and `audio/` listings. Row Q's span timings include the scoring spans,
  so the waiter retry bound (R4-10) is measured against them too.
- **What remains.** A waiter queued behind more than 30 s of commits still gets `lock_contention`.
  Row Q measures real commit spans and waiter outcomes on OneDrive.
- **Absent parts are skipped**, never retried: the journal lists only the present parts (step 3),
  so `renameWithRetry` never spins on ENOENT.

**Hazards closed:** H1–H4, H6, H7, H8 (except a commit wedged inside the filesystem), H9,
H12–H14, H16 (via OD2), H17, H18, H19 (server entries), H20, H22, F2, N1, N2, N4 (it degrades to a
reported wait or a reported failure, never a mixed take), N6–N9, N11–N16.

**Remaining** (revision 11: every item is an accepted residual of this design. Each is
pre-existing on `main`, out of scope with its own ticket, or accepted by an owner decision. None is
an open question of this design):
- reader skew within one rename window;
- legacy client entries (H19);
- a commit wedged mid-rename inside the filesystem. Nothing interrupts a syscall; a server restart
  replays the journal;
- **the export's duration skew** (R-f, #4223) no longer remains: #4224, merged at `33f3647c`, closed
  it outside this design by snapshotting each chapter's audio into staging before the m4b probes it;
- **one server process per workspace** is assumed and not enforced (A10). That is the same
  precondition book-op already has;
- **a crash, or a parked failure, between restructure's state write and its edits write** leaves
  `manuscript-edits.json` keyed to the pre-restructure chapters. This is pre-existing on `main`, and
  it is **not** covered by the GET-side reconciliation, which drops edits by sentence-id range
  (revision 5 withdraws revision 4's claim). The design keeps it from spreading: a parked edits
  write skips the cache rebuild (§5.A Restructure). Closing it is #4227's own design pass, outside
  this design (§8.3);
- **a file the OS refuses to rename under every name** keeps the slugs a stuck journal names
  blocked, and only those, until the user removes the cause and tries again (R5-3, R5-4, R6-3);
- **stray Qwen tiers after a pass that does not reconcile** (E7, E8, E9, E11, E13): a tier that a
  splice- or QA-repair-triggered pass, a queued pass, or a resume pass that skipped its cleanup
  auditioned at can stay resident beside a running job's tier until a render's next chapter POST,
  or until the next render starts (§5.A Scoring). Under E11 and E13 a resume pass skips its cleanup
  whenever a render, splice or QA repair of any book runs at its start or its reconcile, or
  registered during the pass, so this is the common case for Resume on a busy box. E7, E8, E9, E11
  and E13 accept this over evicting a running job's tier;
- **the tier evictions that are pre-existing on `main`** (§5.A Scoring): a render's own pass that
  started at once can evict a render at another key, or a splice or QA repair, that started during
  its auditions; a resume pass can still evict in E11's and E13's blind windows (a render not yet
  registered, a job registering during the reconcile's await, a pass wholly inside one chapter
  gap), which reloads, and can evict the tier of synthesis the gate does not see (voice samples,
  voice-style, cast and single design, the `qwen-voice` routes, another book's scoring auditions),
  as on `main`; two concurrent renders at different keys (N9) evict each other's tier; a
  render's run-start reconcile can evict a concurrent partial job's synthesis tier, and now also a
  partial pass's audition tier, which reloads. **#4235** (a resume beside a running splice or QA
  repair) is **closed by E9**, and a resume beside another book's render (pass 8, K4) **by E11 and
  E13** (pass 9, L1);
- **Unicode normalisation of the unaddressed-set key** (R7-11): on darwin an NFC and an NFD spelling
  of one book folder miss each other, so the fence fails open for that book while a no-`bookId`
  bundle overwrite runs;
- **the splice and QA-repair SSE path leak** (R7-5, #4233) is **fixed on `main`** by #4234, merged
  at `08742125`. The other routes that still echo a raw `err.message` are #4236, outside this
  design;
- **a bundle take decoded under the workspace-wide claim** (pre-existing, pass 8 note): `replace`
  decodes an unindexed bundle take before its first rename, under `withBookPathClaim`, the hazard
  R6-7 moved replay out of the claim for. R8-3 moved decodes out of `book` only. Unchanged here;
- **a part deleted from outside the protocol** while a journal is pending is recorded as lost
  (R8-1), after R9-2's re-probe, and the chapter reads unrendered or unindexed until it is rendered
  again;
- **two different copies of one part at two slug names that the journal cannot tell apart** (E15):
  neither the `takeId` nor the recorded size decides them, so both are quarantined and the part is
  recorded as lost. The take is incomplete in that part, never mixed, and the slug is not blocked;
  the copies wait in `.orphaned/` for a person, and the chapter reads unrendered or unindexed, or
  lacks that sidecar, until it is rendered again. It needs two faults and a same-size collision;
- **an id-less previous take whose segments carry no `synthesizedAt`** (R10-4) gets no H17 retry:
  a Reject whose `revisions.json` write failed answers `revision_gone` on its retry, which `main`
  fails too;
- **an unparseable journal** quarantines the takes it was moving, so those chapters read unrendered
  until a person restores them from `.orphaned/` (R6-3). Journals are written atomically, so only
  damage from outside the protocol produces this.

**Blast radius (F24; corrected).** About **66–72 non-test server files** (revision 8 adds two, revision 10 one), plus tests. Revision 4 adds `book-jobs.ts`, `book-op-lock.ts`, `chapter-job-coordination.ts` and `embeddings-io.ts`, and drops `verdicts-io.ts`. Revision 5 drops `chapter-job-coordination.ts` again (E5: no exit hook) and adds `test-utils/guard-scan.ts` (rule 3's resolver). Its other changes land in files already listed: `audio/segments-io.ts` (the shared classifier predicate), `routes/chapters-restructure.ts` (no cache rebuild after a parked edits write) and `import/scan-import-folder.ts` (the handles, R5-7). Revision 6 adds `routes/analysis.ts` (W16's carry, R6-4). Its other changes land in files already listed: `routes/generation.ts` (trigger `source`, the per-key pending list, no reconcile for partial passes), `routes/backup.ts` and `workspace/auto-backup.ts` (the handle), `routes/book-state.ts` (the PUT's `chapters` checks and replay), `routes/chapters-restructure.ts` and `workspace/restructure.ts` (`relabelJid`, the plan-driven pending-entry reconcile, step 0's `reconcileSlug`), `workspace/scan.ts` (`relabelJid` in the state type; the heal's read-then-check order) and `audio/segments-io.ts` (the name set as a predicate input). Revision 7 adds no file. Its changes land in files already listed: `routes/generation.ts` (the at-once rule, E8; pending entries by `uuid`, R7-12), `workspace/book-op-lock.ts` (`{ backfill: false }`, R7-8), `workspace/chapter-uuid.ts` (the field-list parameter, R7-6), `routes/chapter-splice.ts` and `routes/chapter-qa-repair.ts` (curated frames, R7-5) and `routes/chapters-restructure.ts` (step 0's slug plan, R7-3). Revision 8 added `routes/chapter-job-coordination.ts` back (`hasInFlightSpliceForBook`, E9) and `workspace/book-state-update.ts` (the canonical directory key, R8-4). Revision 9 drops `routes/chapter-job-coordination.ts` again (E11 reads the leaf gate instead) and adds `workspace/book-dir-key.ts` (new, R9-6), so the count is unchanged. #4234 merged, so its files no longer join (R7-5). Revision 10 adds `workspace/take-fields.ts` (new, R10-2); its other changes land in files already listed: `routes/generation.ts` (E13's start sample), `import/scan-import-folder.ts` (E14's supersession of a carried drop journal) and `workspace/scan.ts` (the imports from the leaf). Revision 11 adds no file: E17's re-check lands in `routes/generation.ts`'s chapter-start span, and E18's Accept and drop phases in `workspace/chapter-take.ts`. Revision 8's other changes land in files already listed: `routes/generation.ts` (the resume re-check, now E11's `isAnyGenerationActive()` and epoch, the synchronous hand-off, chapters without a `uuid`), `workspace/restructure.ts` (the presence OR, R8-7), `routes/chapters-restructure.ts` (step 0 outside `book`, R8-3), `workspace/auto-backup.ts` (releasing `book`, the pre-restore `duration`, R8-3), `workspace/scan.ts` (the heal's key and set check, R8-4), `import/scan-import-folder.ts` (carried journals replayed before the claim, R8-5) and `workspace/chapter-uuid.ts` (`carryTakeStateFields`):

| Area | Files |
|---|---|
| New | `workspace/chapter-take.ts`, `workspace/chapter-take.guard.test.ts`, `workspace/book-dir-key.ts` (the leaf, R9-6), `workspace/take-fields.ts` (the module's leaf for `scan.ts`, R10-2) |
| Folded in / removed | `workspace/preserve-previous-audio.ts`, `audio/previous-audio.ts`, `audio/rewrite-chapter-slugs.ts`, the take-name builder in `workspace/chapter-audio-file.ts` |
| Finalize and callers | `audio/finalize-chapter-write.ts`, `routes/generation.ts` (commit site, signal, `committing`, `stallPhase`, failure-stamp check, `writeAttempted`, OD2 per-chapter abort, `startTakeId` span and its `take_repair_pending` check, `triggerScoring`'s per-key pending re-runs, re-arm bound, trigger `source`, and no post-audition reconcile for a partial-only pass (E7)), `routes/chapter-splice.ts`, `routes/chapter-qa-repair.ts` (registration-first base read, Edit 6b staged as rows and patches, exit-path scoring trigger) |
| Waiter retries (E2) | `workspace/book-jobs.ts` (registration retry), `routes/book-state.ts` (listen-progress and listen-stats PUT retry; listen-progress receive-time ordering, R5-6) |
| Revisions | `routes/revision-ops.ts`, `routes/chapter-audio.ts`, `workspace/revisions-store.ts` (`takeId`/`previousTakeId`/`previousRenderedAt`, `entryMatchesChapter` on `audioRenderedAt ∈ {renderedAt, previousRenderedAt}`, retire `revisionOpLockKey`) |
| Restructure | `routes/chapters-restructure.ts` (relabel journal, ordering, `relabelJid` in the state write), `workspace/restructure.ts` (`buildAudioOps`; carry list from `TAKE_STATE_FIELDS`; `pendingMovesAfterRestructure` from the plan, R6-9) |
| Book state, exclude, fsck, scan | `routes/book-state.ts` (exclude, `completedSlugs`, `chapterLufs`, the reparse wipe keeping `.orphaned/`, the PUT's slug-binding check), `workspace/fsck-orphan-audio.ts`, `workspace/book-op-lock.ts` (`withBookOpAtDir` hands over a handle), `workspace/scan.ts` (types, `completedChapters`, `deriveSegmentsHeal` via `deriveTakeFields`, `persistHealPatches` applying `healTakeFields`, all imported from `take-fields.ts`, never from `chapter-take.ts`, R10-2) |
| Whole-book writers (D3) | `import/scan-import-folder.ts`, `routes/backup.ts`, `workspace/auto-backup.ts`, `workspace/chapter-uuid.ts`, `routes/analysis.ts` (W16: both chapter rebuilds carry `TAKE_STATE_FIELDS`, revision 6) |
| Scoring | `audio/render-integrity/aggregate.ts` (one segments read per chapter, the embeddings/segments `takeId` check), `audio/render-integrity/embeddings-io.ts` (`takeId`), `routes/qa-report.ts` (resume). `verdicts-io.ts` is unchanged (R4-6) |
| Export | `routes/export.ts` (OD7 reject refusal), `export/build-portable-book.ts` (F15), and the `export/build-*.ts` builders (accessors) |
| Readers to accessors (Phase 1) | the rest of the ~47 files that read a take name, including `audio/segments-io.ts:218`, `routes/revisions.ts:151`, `export/build-captions.ts:135`, `export/build-mp3-folder.ts:62`, `library-sync-manifest.ts:104`, the sync manifest, `audio/qa-report.ts`, `store/cast-audio-currency.ts`, `routes/clip.ts` |
| Types and contract | `audio/segments-io.ts` (types), `openapi.yaml` + `src/lib/api-types.ts`, `src/lib/api.ts` (A-side URL, mocks) |
| Lock-order docs | `workspace/cast-lock.ts:40` and `workspace/book-op-lock.ts:17-18` comments, CLAUDE.md (lock order, and the fail-loud and swallow enumerations per the State-write sites table) |
| Tests that cite `revision-op` | `book-op.single-book-routes.test.ts:468`, `revision-ops.test.ts:542,574-578`, `chapter-audio.test.ts:603` |

**Tests (F22).**
- **Fault injection over the module**, parameterised over **every take part, the previous take's
  parts included**, and over every phase of the commit, restore, accept, drop and relabel
  journals, **and, inside each relabel group, every boundary between two parts of one source**
  (revision 5). Each injected failure leaves each take whole on disk, and replay converges. Running the
  replay twice equals running it once.
- **Race tests:**
  - **positive control (D1): a splice prepared after Accept commits;**
  - **ABA (D1):** render B → reject (A live) → a splice prepared against A commits onto A; a splice
    prepared against B is refused;
  - reject during a commit;
  - two renders of one chapter (`::*` and `::X`): the original previous take survives (R3-1);
  - splice CAS mismatch;
  - commit after abort;
  - watchdog during a commit, and between retry spans;
  - the failure stamp after a commit, with the stamp itself failing (D2/E2/E6): **no** review entry
    is recorded, the chapter's old pending entry is dropped, the discard set is still unlinked, the
    journal is **kept** at `installed`, the error rethrows last, and no `failed` stamp is written.
    Then a replay whose stamp lands fixes state, including the `generationState*` clear, and
    **then** records the entry. The entry is visible to the revisions read view (Restore is
    offered), and a sibling's `recordPending` afterwards does not drop it;
  - a crash after `installed` and before the review record: replay records the entry from the
    journal's `review` and `entry` inputs after its stamp, and a second replay leaves exactly one
    entry;
  - **matching without the mirror (E6):** with `audioTakeId` deliberately left stale (its swallowed
    mirror stamp failed), Accept and Reject still pick the right table row, because both read the
    live segments' `takeId`. A Reject whose audio step and stamp landed but whose `revisions.json`
    write failed is retried and commits `rejected`, matched through `previousRenderedAt`. The
    negative control: a later render C makes the entry invisible;
  - **an entry with no `previousTakeId` (R9-4, revision 9; pass 8, K7):** a full render whose
    chapter-start mint fails (injected) over an id-less live take commits, and records an entry with
    `previousTakeId: null`. A Reject restores that take, whose next entry point mints it a fresh id;
    its `revisions.json` write fails (injected), and the retry commits `rejected` through the
    `previousRenderedAt` row. The mutation that must fail: match the "A" row by `previousTakeId`
    alone, and the retry answers `revision_gone`. **Both times present (R10-4, revision 10; pass
    9, L6):** the same with a legacy id-less take whose segments carry no `synthesizedAt`, under an
    entry with no `previousRenderedAt`: the retry answers `revision_gone` and records nothing. The
    mutation that must fail: compare the two times with a bare `===`, and the absent pair matches
    and records `rejected`;
  - **listen-progress under retry (R5-6):** two autosaves with no `listenedAt` queue behind a span
    longer than 10 s; the older one's retry lands after the newer one and leaves the newer record,
    `markers` included;
  - scoring CAS against a splice landing mid-pass (the carry-forward keeps scoring's rows);
  - **scoring ABA (A6):** a splice commit C lands between a pass's embeddings and segments reads,
    then a Reject restores A. The chapter is skipped (embeddings `takeId` ≠ segments `takeId`) and
    no rows are written;
  - a dropped scoring trigger re-runs with the merged `justFinalizedChapters` (R3-3, R6-1, R7-12); a
    persistent embeddings/segments mismatch does not re-arm; a mismatch-requested re-run does not
    re-arm again; a restructure that runs between the in-flight pass's release and the queued
    pass's start leaves the queued pass stamping the renumbered chapters, mapped by `uuid`
    (R7-12); a triggered chapter with no `uuid` is mapped by `id` and `slug` and stays in
    `justFinalizedChapters`, so its characters audition at the run's `runModelKey`, and the same
    chapter renumbered by a restructure in between is skipped and logged (R8-6);
  - **merging by run key (R6-1, revision 6):** while a pass is in flight, a render trigger at 1.7B
    and a QA-repair trigger at 0.6B arrive. They queue as **two** pending passes, and each passes its
    own `runModelKey` to `scoreBook`, so each side's characters audition at their own tier. Two
    triggers at the same key merge into one. The mutation that must fail: merge across keys, and one
    side's characters audition at the other's tier;
  - **E7, E8, E9, E11 and E13 (restated in revision 10; pass 7, J4; pass 8, K3, K4; pass 9, L1).** The harness has **no scoring pass
    running** when each trigger under test arrives, unless the case says otherwise, so that
    trigger's pass starts at once rather than being queued. **It counts only the scoring pass's own
    reconcile.** Revision 7 counted every call to `reconcileResidentQwenTiers`, which a real
    render's run-start reconcile also makes at each chapter POST (`generation.ts:1216-1217`), so
    "zero" and "once" failed on correct code, and an implementer seeing red would loosen the
    assertion. So:
    - `triggerScoring` takes the post-audition reconcile through an injected seam (defaulting to
      `reconcileResidentQwenTiers`), and the assertions count calls to that seam only;
    - the running render, splice and QA repair are **stubs**: each registers as the real job does
      (a generation job in `inFlightByBook`, a `registerSplice` holder) and sets the resident tier,
      but makes no chapter POST, so no run-start reconcile runs in the harness at all.

    A mutation that lets a pass reconcile therefore fails whatever `keep` it passes. (Revision 6's
    parenthetical, "a full-cast `keep` computed at 0.6B evicts 1.7B", is dropped: an elevated
    character puts `keep17` into a 0.6B run's full cast, so it is not true in general.)
    1. **A partial pass started at once never reconciles (E7).** A render (stub) is running at run
       key 1.7B, with 1.7B resident, and no scoring pass is running. A partial job (a QA repair,
       then separately a splice) at run key 0.6B commits and triggers scoring. Its pass starts at
       the job's exit, without waiting, runs its auditions, and calls the seam **zero** times; 1.7B
       stays resident. Mutation that must fail: re-enable the post-audition reconcile for partial
       triggers.
    2. **A queued pass never reconciles (E8, the G1 case).** A partial job's pass is running. A
       **render** trigger at run key 1.7B arrives and is queued, and the render (stub) keeps
       running with 1.7B resident. The partial pass ends; the queued render pass starts from the
       pending list and calls the seam **zero** times; 1.7B stays resident. Separately, a
       **resume** trigger is queued the same way, and **nothing** is running or registers once its
       queued pass starts, so E11's and E13's re-check would let it through: it still calls the
       seam **zero** times. That case is what keeps E11 and E13 from masking E8. Mutation that must fail: let a
       queued pass reconcile when it carries a render or resume trigger (revision 6's R6-1 rule);
       the seam is called.
    3. **Positive controls (E8, `main` parity).** With no pass running, a render's own trigger
       calls the seam **once**, with its run's full-cast `ctx.keep`. With no pass and no render,
       splice or QA repair running in any book, and none registering during the pass, a resume
       trigger calls it **once**, with `scoreBook`'s `usedQwenTiers`. While the book generates, the resume route answers 409 and triggers
       nothing.
    4. **A resume pass re-checks before it reconciles (E9, E11, E13).** No pass is running, and the
       route accepts a resume trigger. Then, separately, each of these calls the seam **zero**
       times and leaves the resident tier:
       - a splice (stub) registers during the pass's auditions; a QA repair (stub) does the same;
       - a render (stub) registers after the route's check and before the pass starts, the
         click-to-start window;
       - **the chapter gap (K3):** a render (stub) registers a chapter during the auditions and
         deregisters before the reconcile, so `inFlightByBook` is empty at the reconcile and only
         the epoch moved;
       - **another book (K4):** a render (stub) of a second book is running at the reconcile;
       - **already running at the start (E13; pass 9, L1):** a render (stub) of a second book,
         and separately a splice (stub), is registered **before** the pass starts and deregisters
         before the reconcile, and nothing else registers in between, so the gate reads idle at
         the reconcile and the epoch has not moved; only the start sample saw it;
       - **fail closed:** the gate's generation provider is unregistered, or its epoch reader is.

       Four mutations must fail: drop the re-check, and every case calls the seam once; re-check
       with `isGenerationActive` alone, and the splice and QA-repair cases call it once (the #4235
       regression); re-check `isAnyGenerationActive()` without the epoch, and the chapter-gap case
       calls it once; drop the start sample (revision 9's E11), and the already-running case calls
       it once. Revision 8's per-book check (`isGenerationActive` plus the book's splices) fails the
       other-book case.
    5. **The hand-off keeps single flight (J5).** A pass ends while one entry is pending. A trigger
       injected between the `.finally` and the queued pass's registration is queued, not started:
       exactly one pass runs at a time. The mutation that must fail: await the queued pass's
       re-read in the `.finally` before re-setting the marker, and two passes overlap.

    Revision 5's E5 test had both tiers come from per-character elevation under one run key, so it
    could not see a second run key (pass 5, C1). Revision 6's E7 test had only a trigger that started
    at once, so it could not see a queued pass (pass 6, G1). Both are replaced. Revision 4's "no pass
    until the render's last job exits" test passed vacuously per chapter (pass 4, B4) and stays
    removed;
  - a legacy book's first pass scores (ids minted before the read).
- **Relabel (E1):** a "Chapter N" merge interrupted after each cursor group, then replayed twice,
  ends with every chapter's own take at its new slug. The regression case is a crash after `land`
  and before the journal unlink: the survivor's take is **not** dropped. Also: a failure of the state
  write restores the prior hints and leaves the audio untouched; an audio failure after the state
  write answers the fixed 500, parks, still rebuilds the cache, and the background `reconcileBook`
  finishes; a crash at cursor `planned` after the state write is detected from `state.json`'s
  `relabelJid` (R6-5). The same crash followed by a PUT that sends `chapters` with a changed map,
  and separately by an analysis persist, is still detected as landed and rolls forward; the hints
  are not rolled back. The mutation that must fail: decide by comparing chapter maps, as revision 5
  did.
  - **A stop between two parts of one source (R5-1, revision 5)**, in every group: in `stage`,
    after a source's segments reached `temp` and before its peaks moved; in `drop` and
    `clear-stale-previous`, after the first part moved; in `land`, after a source was recorded in
    `landing` and before any of its parts moved, and again after its first part moved and before
    its next (R7-2). Each is replayed twice. Each ends with every chapter's own take whole
    at its new slug, nothing quarantined, and `lost` empty. Revision 6 runs this matrix over **a
    reorder** (a permutation where every `to` is also a `from`, each with a pending A/B review) and
    over **the canonical "Chapter N" merge** where the dropped chapter has a previous take: the two
    shapes on which revision 5's plan-time `clearStalePrevious` parts recorded false losses
    (pass 5, C3).
  - **`drop`'s only-copy rule (R6-2, R7-3):** a stop in `drop` after the live audio moved, for a
    slug that had a live take when the journal was written, discards its previous take on replay and
    quarantines nothing. A "Chapter N" merge whose dropped chapter has **no** live take and a
    previous take quarantines that previous take as the only copy: step 0 does not promote it
    first. The mutation that must fail: let step 0 promote a drop slug, and the only copy is
    discarded at `cleanup`. A promotable slug the plan does **not** drop is promoted at step 0, and
    the journal lists the promoted live parts, so `land` never meets them as foreign.
  - **Foreign parts at a `land` target (R6-2, R7-2):** a target holding a foreign take (segments
    with another `takeId`, plus audio) before the source is recorded in `landing`: both the target's
    segments **and its audio** are quarantined, and the source's parts land. Then the "landed, temp
    present, target present" row: a stop after the source is recorded in `landing` and its segments
    landed, with foreign audio planted at the target before replay. Replay quarantines the foreign
    audio and lands the source's. No foreign audio is left as the chapter's live take, in either
    case.
  - **A source with no segments (R7-2):** an unindexed legacy take, and separately a legacy excluded
    chapter that kept `.previous.*`, moved by a reorder and stopped between two of its `land` parts.
    Replay finishes the move, quarantines nothing, and records nothing as lost. The mutation that
    must fail: decide "landed" from the target's segments, as revision 6 did, and the source's own
    landed audio is quarantined.
  - **Unparseable parts and journals (R6-3):** an unparseable `.previous.segments.json` at a
    `metadata` target is skipped and recorded under `unreadable`, and the slug is not blocked. A
    book journal, and separately a per-slug journal, replaced by bytes that do not parse is
    quarantined with its jid-tagged files into one `.orphaned/` event folder; the book's other
    chapters render; nothing is unlinked. A healthy relabel journal whose **read** fails with an
    injected EBUSY is left in place and replays once the fault is lifted; nothing is quarantined
    (R7-4). The mutation that must fail: treat any read error as unparseable.
  - **Pending entries after a parked `stage` (R6-9):** a reorder whose `stage` parks on an injected
    `EACCES`, for chapters with pending entries. Every `stage` source's entry moves to its new
    chapter, none is dropped, and once the fault is lifted and the journal finishes, Restore is
    offered on each. The mutation that must fail: move only the entries whose previous take the
    rewrite reported moving.
  - **Step 0's per-slug journals (R6-10):** a restructure over a slug with a per-slug commit journal
    stuck at `installed` on a lock-class stamp failure replays it before planning; with one stuck on
    a move-step failure, the restructure is refused with `take_repair_pending`.
  - **A crash after the last `land` rename and before the cursor write:** the re-run of `land` is a
    no-op, and no landed take is quarantined.
  - **Foreign and lost parts:** a part deleted under every name is recorded in `lost`, and replay
    finishes; a copy at `from` that carries another `takeId` is quarantined, and replay finishes.
  - **The heal skip (R5-2):** a "Chapter N" merge stuck at `stage` with the pre-merge take still at
    the survivor's slug. A `withBookOp` resolve, and a library scan, leave the merged chapter's take
    fields absent. After replay drops the take, they are still absent. The mutation that must fail:
    remove the skip, and the fields fill from the pre-merge take.
  - **The heal's read order and the locked unlink (R6-11, R7-1):** a commit runs steps 3–6 and
    stops before `installed`. A library-scan heal reads the installed segments and is paused
    **between its segments read and its journal check**, a point that exists in the fixed order.
    The commit then rolls back: its renames complete, and its journal unlink waits on `book`. The heal
    resumes, finds the journal, and skips the slug; then the unlink lands. Two mutations must fail:
    unlink the journal without `book`, and the heal finds no journal and fills the fields from the
    rolled-back take; and check-then-read, which fills them the same way. Revision 6's test paused
    the heal between a check and a read, a point that exists only in the mutation's order (pass 6,
    G2).
  - **Scope (R5-3/R5-4):** with a book journal stuck on an injected persistent `EACCES`, a render of
    an untouched chapter commits; a render of a named chapter fails before synthesis with
    `take_repair_pending` (never the watchdog's "in use" sentence); Accept on a named chapter
    answers the same; a splice and a QA repair on a named chapter end with a `chapter_failed` frame
    carrying `code: 'take_repair_pending'` (R6-3); a new restructure is refused; once the injected
    fault is lifted, the next entry point finishes the journal.
  - **Failure classes, by step (R6-3, R7-4, restated by R8-2 and E10):** a per-slug commit journal
    stuck at `installed` on an injected `state-json` timeout. Accept on that chapter answers the
    curated lock-contention 500, not `take_repair_pending`; a render of it proceeds past its
    chapter-start span, and its commit supersedes the journal at step 0 (E10); once the timeout is
    lifted, the commit's own stamp lands. The same journal stuck on an injected EBUSY from
    **`state.json`'s own rename** (inside `writeJsonAtomic`) is still a record-step failure: it never
    answers `take_repair_pending` and blocks no slug. The mutation that must fail: classify by the
    error's `code`/`syscall`, and that held `state.json` blocks the slug. The same journal stuck on
    an injected EBUSY from a **take-part** rename ends a render's chapter `take_repair_pending` at
    its chapter-start span and at step 0 alike, with the one move-step sentence. And the same
    journal stuck on an injected **EROFS** from its stamp: a render of the chapter is superseded at
    step 0 too, and fails loud at its own step 7 if the injection still holds (the supersession case
    above); it never reaches the watchdog. Accept answers `FS_PERMANENT_FAILURE_REQUEST_ERROR` as a
    500.
  - **No path in a terminal frame (R7-5; done on `main` by #4234):** #4234's own tests pin the
    curated splice and QA-repair catch-alls, the ffmpeg scrub and `classifyFailure`'s fs handling,
    so this design adds none of them. It adds only its own frames: a splice and a QA repair whose
    base-read span throws an injected node fs error with an absolute `path` end with a
    `chapter_failed` frame whose `errorReason` contains neither the workspace path nor the raw
    message; a `take_repair_pending` and a `take_details_pending` frame carry their fixed sentences
    and no path.
  - **Whole-book writers (R5-5):** a backup restore and a bundle overwrite over a book with a pending
    relabel journal finish the journal before they swap `state.json`, and refuse with
    `take_repair_pending` when the replay fails, swapping nothing. The bundle overwrite's replay
    runs **before** `withBookPathClaim` (R6-7): with a slow injected replay on book A, an import
    into book B is not held behind it. **Carried slugs (R8-5):** a per-slug commit journal at
    `installed` on a slug the bundle carries is replayed before the claim, without lazy migration
    (no decode is called), and the bundle's take is installed. For a carried journal whose
    replay **completes**, a crash injected between the swap and `replaceTakesFromBundle` leaves no
    local journal to replay against the bundle's state (R9-7: the claim is limited to that case).
    The mutation that must fail: skip the carried slugs' replay, as revision 7 did, and the crash
    case rolls the local take over the bundle's state. A carried journal stuck on a move step
    refuses the import with `take_repair_pending`. A carried commit journal stuck on its stamp only
    outlives the swap and is superseded by the `replace` journal, and the import succeeds; the same
    journal with the crash injected before the supersession is replayed at the next entry point,
    which stamps from the local take still live, so the state describes the disk. **E14 (revision
    10; pass 9, L7):** a carried drop journal stuck past its moves on an injected failure of its
    `state.json` write is superseded by the `replace` journal, and the import succeeds: the chapter
    takes the bundle's `excluded`, the drop's discard set is unlinked at the `replace`'s cleanup,
    and no pending entry is left. A carried `replace` journal from an earlier import, stuck at
    `installed` on its stamp, is superseded the same way. A carried **Accept** journal stuck on a
    record step still refuses the import with the curated 500 and swaps nothing. The mutation that
    must fail: refuse every carried drop journal (revision 9's R9-7), and the drop case's import
    fails. An overwrite that fails with `BundleConflictError` after its pre-claim replay leaves
    nothing pending.
  - **A parked edits write** skips the cache rebuild.
- **Windows-shaped tests:** an injected EBUSY/EPERM at step 5 keeps the staged set and retries; an
  exhausted wait reports the sentence and sweeps; a Node-held live file commits; a step-0 journal
  read that fails once keeps the staged set and commits on its second attempt (A11, R8-2).
- **Sweep:** an orphan `.next-*` is swept; one in `liveStaging` is not; a journal-less discard is
  quarantined; orphan parts are not quarantined while a journal names the slug; `completedSlugs` and
  `completedChapters` ignore `.next-*`.
- **Live-take predicate (R4-1):** on a case-insensitive filesystem `<slug>.MP3` is live, and the
  module, `completedSlugs` and `findChapterAudio` agree. With both `<slug>.mp3` and `<slug>.m4a`
  present, the module reports two live files while `findChapterAudio` returns the mp3.
- **Lazy minting:** an id-less book imported after boot gets ids at its first splice; a legacy
  chapter's first `::*`/`::X` interleave keeps the pre-render take (R3-1 with `startTakeId` minted at
  chapter start).
- **Whole-book writers:** a bundle overwrite leaves no mixed take, and its stamp is not taken inside
  the rename loop's `state-json` lock; a backup restore re-derives the take fields, through the
  handle `withBookOp` gave it (no second locate, R6-6); the PUT drops a client `audioTakeId` and
  refuses a slug rebinding with 409 `slug_bound` (R4-4); the reparse wipe keeps `.orphaned/` (R4-5)
  and removes the journals with the takes (R5-5).
- **The analysis persist (R6-4, R7-6):** a re-analysis of a rendered book whose titles are unchanged
  keeps every chapter's `TAKE_STATE_FIELDS`, `audioTakeId` and `audioQa` included, in both the main
  and the subset job. A chapter whose slug the persist changes loses them, as today. A chapter with
  a `generationState: 'failed'` stamp before the re-analysis has none after it, as on `main`. The
  mutations that must fail: drop the carry, and `audioTakeId` is absent after the re-analysis; carry
  through `carryServerOwnedChapterFields` as a whole, and the failure stamp survives.
- **Stamps that change the live take (R6-8, R7-7):** a Reject that restores a previous take with no
  `.previous.segments.json` leaves no field of the rejected take in `state.json`: every member is
  cleared except `duration`, which matches the restored audio's **decoded** length. The fixture is a
  legacy MP3 with no Xing header, whose ffprobe estimate is several times too long, so the mutation
  that probes instead of decoding fails. **The decode is never called while `book` is held (R8-3),
  asserted on all three decoding paths:** Reject's restore; a restructure whose step 0 promotes an
  unindexed previous take and resolves a multi-live slug; and a backup restore over a book with an
  unindexed chapter the pre-restore state does not match. The decoder stub fails the test if the
  `book` lock for the book is held when it runs. The mutation that must fail: run restructure's
  step 0 inside the closure's `book`, as revision 7 did. A backup restore over unindexed chapters
  the pre-restore state matches makes **no** decode and keeps their pre-restore `duration`. A
  replay of the restore stamps from the journal's recorded seconds without decoding again. A
  failed decode clears `duration`. A Reject onto a previous take whose segments lack `qa` clears
  `audioQa`. A backup restore whose `state.json` carries `audioQa` for an older take, over a live
  take whose segments lack `qa`, leaves no `audioQa`; and migration's legacy-reject re-stamp clears
  a member the live segments lack, in the same way.
- **Stale entries stay invisible (R6-8):** after R3-5 promotes A over a lost B, and separately after
  a bundle overwrite brings back A's `synthesizedAt`, the chapter has no pending entry, so no
  Accept or Reject can record an outcome the user did not choose. A promotion whose entry drop fails
  keeps its journal, and the next replay drops the entry. An Accept on that chapter, with the drop
  failing again, answers the curated 500 and records nothing (R7-7).
- **No deadline (E2):** a commit under a slow injected rename (several seconds per part) commits.
  A listen-progress PUT queued behind it retries its acquisition and lands. The negative control: it
  answers `lock_contention` only after its third timeout.
- **Format coverage:** m4a and ogg books through commit → reject → accept → relabel → drop → fsck.
- **Migration** fixtures for every §6.1 rule.
- **The guard test** (E4), with a mutation check per rule. Rule 3's mutation check plants each of
  **finalize's three hop kinds** (revision 5, B8) in a non-module file, and each plant must fail:
  1. two `join` hops into `rename`'s **second** argument
     (`` const audioRoot = audioDir(bookDir); const p = join(audioRoot, `${slug}.${ext}`); await rename(t, p) ``);
  2. a template-literal hop into `writeFile`, finalize's temp write at `:242-244`
     (`` const tmp = `${p}.tmp-${pid}`; await writeFile(tmp, buf) ``);
  3. a writer whose path is **not** the first argument (`await writeChapterPeaksFile(pcm, sr, p)`).

  An implementation that follows only `join`, or only arguments 0–1, fails plant 2 or plant 3. A
  further, pinned case plants the first shape with `audioRoot` as a function **parameter**, and
  asserts that the guard passes it: the documented blind spot. If a later improvement starts
  catching it, the pin flips and the header is updated. The resolver in `guard-scan.ts` has its own
  unit tests.
- **Bundle overwrite with no `bookId` (R5-7):** the overwrite installs takes through an
  `UnaddressedBookHandle`; a `/:bookId` write to the freshly minted id while the overwrite runs
  answers `book_busy`; the fsck skips a directory the overwrite holds. **R6-6:** the same directory
  spelt with different case and separators (the index's spelling against `bookDirByDisplay`'s) is
  still refused; an overwrite that throws mid-way leaves the set empty, so the next request on the
  book is not `book_busy`. An NFC and an NFD spelling of the same folder are not matched: a pinned
  case documents that out-of-scope edge (R7-11), and flips if a later change normalises.
- **PUT slug binding (R5-8, R6-5):** a matched chapter that moves to a free slug answers 409
  `slug_bound`; a new chapter on a free slug with no take is accepted; a PUT that omits a chapter
  with a take on disk, or flips a matched chapter's `excluded`, answers 409 `slug_bound` and writes
  nothing.
- **Replay-stamp classes (B9):** a replay stamp that fails at the boot fsck and in R4-2's background
  retries is logged and keeps the journal; at a quick op it answers the curated 500.
- **Backfill-free spans (R7-8):** across a render of a fixture book, the in-job spans
  (chapter start, commit, attempted marker, scoring's pre-read and per-character spans) never call
  `backfillAudioModelKeysFromSegments`, while every registration and quick operation still does;
  each span lists `audio/` once. The mutation that must fail: drop `{ backfill: false }` from one of
  them, and the call count rises.
- **The restructure sentence (R7-9, J12):** the fixed 500 after a parked audio group names no read
  as its remedy, and is the same for an injected EBUSY, EACCES and ENOSPC. After it, a render of a
  chapter the journal does **not** name leaves the journal pending, and a render of one it names
  finishes it, which is what the sentence promises.
- **Lost parts in per-slug journals (R8-1, J1; re-probe R9-2):** a commit journal stopped
  mid-preserve, a restore stopped mid-promote, and an accept and a drop journal each stopped after
  their first rename, with one listed part then deleted under both names. Replay records the part
  in `lost` only after its re-probe schedule, finishes (the accept and drop journals, before
  `installed`, by rolling back, E18), and unblocks the slug; the next render of
  the chapter commits, and a backup restore of the book is not refused. The same with the part
  deleted between replay's probe and its rename (an injected `ENOENT` from the rename): replay
  re-probes and records it as lost. **A part that drops back** (absent at the first probe, present
  at the second, the OneDrive scan shape) is renamed, not recorded as lost, and the sweep never
  unlinks it. The mutations that must fail: drop the both-absent row, and the slug answers
  `take_repair_pending` for good; treat `ENOENT` as a move-step failure, and the same; decide
  "lost" from one probe, and the dropped-back part is lost and then swept.
- **"Both present" by name kind and by size (R9-1, revision 9; pass 8, K1; restated by R10-1 and
  E15, revision 10; pass 9, L2, L3):**
  - **install with a refilled live name (R10-1):** a commit stopped after step 5 moved the live
    audio and before `installed`, with a copy planted at the live audio name (a sync client
    restoring it). Replay rolls back: install's undo quarantines the planted copy (its target,
    `.next-<takeId>`, is journal-unique), the old take moves back from `.previous.*` and is live
    whole, and the staged set is swept. Nothing of the new take is live;
  - **a discard rolled back onto a refilled slug name (R10-1):** a commit stopped after step 4 moved
    the old previous take to `.discard-<jid>.prev.*` and before `installed`, with a copy planted at
    `.previous.mp3`. Replay quarantines the planted copy and moves the discarded part back, so the
    old previous take is whole. The mutation that must fail: revision 8's row (quarantine the copy
    at the source name), and the genuine discarded part is quarantined while the planted copy stays
    as the previous take's audio;
  - **a discard with a refilled source name:** an Accept stopped after its `.previous.*` rename
    and before `installed`, with a copy planted at `.previous.*`. Replay rolls back (E18): it
    quarantines the planted copy, moves the discarded part back, and the previous take is whole
    with the entry still pending;
  - **two slug names, segments:** a commit stopped mid-preserve with a foreign
    `.previous.segments.json` planted. Replay keeps the copy carrying `liveTakeId` and quarantines
    the other;
  - **two slug names, not segments, decided by size (E15):** a commit stopped mid-preserve, after
    its live audio moved to `.previous.mp3`, with a foreign file of another size planted at the
    vacated live audio name. Replay keeps the copy whose size is the one step 3 recorded for the
    live take's audio, quarantines the planted copy, and the old take is live whole;
  - **the two-fault Reject (E15, pass 9's most dangerous assumption):** a Reject stopped part-way
    through `promote`, with B's live lufs (and, separately, B's live audio) restored at its live
    name from B's own bytes. Replay quarantines B's copy, promotes A's, and A is live whole: no
    file of B is live and the slug is not blocked;
  - **identical copies (E15):** the same with the planted copy byte-identical to the protocol's.
    The copy at the target counts, the other is quarantined, and nothing is recorded as lost;
  - **a tie (E15):** the same with a planted copy of the recorded size whose bytes differ. Both
    copies are quarantined into the journal's event folder, the part is recorded in `lost` with
    both basenames, replay finishes, the slug is not blocked, and no entry point answers
    `take_repair_pending`.

  The mutations that must fail: revision 9's row (refuse every non-segments part at two slug
  names), and the two-fault Reject answers `take_repair_pending` with B's file left live; and
  decide by presence alone, ignoring the recorded size, and the planted copy stays live.
- **Retry budget by step (R8-2, J2):** a commit's step 0 meets a leftover journal (one owing a
  rolled-back unlink) whose record step fails with an injected permanent EPERM. It is attempted
  three times, about 3 s in all, then the chapter ends with `FS_FAILURE_REQUEST_ERROR` and the
  staged set is swept; the watchdog never fires and "in use" is never sent. The same with EIO,
  EMFILE and ENOENT, each of which ends the same way. With EACCES, EROFS or ENOSPC the chapter ends
  after three attempts with `FS_PERMANENT_FAILURE_REQUEST_ERROR`. A failure that clears on the
  second attempt commits. The mutations that must fail: decide retry by `code` (EPERM then runs to
  the watchdog), and give the record step no budget (a cleared second attempt is lost). An injected
  failure of `ensureTakeIdentity`'s mint at a full render's chapter start and step 0 commits the
  render with `startTakeId: null`; at a splice's base-read span it ends the splice with the curated
  sentence.
- **Supersession (E10):** a per-slug commit journal stuck at `installed` because its stamp fails
  with an injected EACCES on `state.json`. A render of the chapter then synthesises, and its commit:
  - supersedes the leftover journal at step 0, without retrying it, and installs its own take;
  - with the injection still on, fails loud at its own step 7 with `take_details_pending` and the
    permanent-cause sentence, the render's audio live;
  - once the injection is lifted, a replay stamps, drops the superseded entry, records its own,
    and unlinks the old discards, the old journal and then its own.

  Fault injection at every phase of the superseding journal: before `installed`, its rollback
  leaves the old journal a plain leftover with its files where it left them; from `installed` on,
  replay never runs the old journal on its own, and a crash between the two unlinks leaves one
  journal in charge. The mutation that must fail: end the commit at step 0 as revision 7 did, and
  the render is discarded.
  - **A chain (R9-3, revision 9; pass 8, K5):** commit J2 supersedes J1 and its unlink of J1 fails
    (injected), so both stay; commit J3 then supersedes J2. J3's `supersedes` names J2 and J1; its
    cleanup unlinks J1, then J2, then itself, and the chapter's pending entry is J3's. The mutation
    that must fail: supersede one level only, and J1 replays its stale entry over J3's. With J2's
    read failing (injected EBUSY), replay acts on no journal of the slug, and J1 is not replayed
    as a plain leftover.
  - **Step 0 repeats, and step 8 stops (R10-3, revision 10; pass 9, L5):** J2 supersedes J1, which
    is stuck at `installed` on its stamp, and a crash stops J2 before `installed`. The next
    commit's step 0 rolls J2 back, decides the slug again in the same span, and supersedes J1, so
    its own journal names J1 and no two unsuperseded journals ever sit on the slug. The mutation
    that must fail: stop step 0 after one rollback, and the commit writes its journal beside an
    unsuperseded J1. Separately, in the chain case above, J1's unlink fails at J3's cleanup: J2
    is not unlinked in that run, and the next replay finishes the chain from J3. The mutation that
    must fail: carry on past the failure, and J2 is unlinked while it still names J1.
  - **A `replace` journal is supersedable (E14):** a bundle `replace` journal stuck at `installed`
    because its stamp fails (injected). A render of the chapter proceeds past its chapter-start
    span, supersedes it at step 0 without retrying it, and installs its own take; once the
    injection is lifted, a replay stamps, drops the entry and unlinks both journals. The mutation
    that must fail: leave `replace` off the list, and the chapter ends after the record-step
    budget, the render discarded.
  - **Off the list (E12):** a drop journal stuck past its moves on an injected failure of its
    `state.json` write (so the chapter is not yet `excluded`), and separately an Accept journal
    stuck past its moves on an injected record-step failure. A render of the chapter does not supersede it: the
    chapter-start span gives it the record-step budget, and after the third attempt the chapter
    ends with `requestFailureMessageFs`' sentence before synthesis. The drop's `excluded: true` is
    never reversed. The mutation that must fail: put drop on the list, and the render clears the
    exclude.
- **The post-replay `excluded` re-check (E17, revision 11):** a drop journal at `installed` whose
  `state.json` write fails on its first attempt only (injected), so the chapter is not yet
  excluded. A single-chapter queue POST for the chapter selects it. The chapter-start span's first
  attempt fails the record step, and the second, 1 s later, rolls the drop forward and writes
  `excluded: true`. The span's re-check then skips the chapter: the synth stub is called **zero**
  times, no `.next-*` part exists, `ensureTakeIdentity` is not called, the render writes nothing
  to `state.json` (the drop's write is the only one), and no attempted marker or scoring trigger
  follows. The SSE frames are compared with a POST for an already-excluded chapter on the same
  fixture, and both are `idle` alone, with no `chapter_failed` and no `chapter_complete`.
  Separately, a `*` render over two chapters, where the first meets the same journal, skips the
  first and renders the second. The mutation that must fail: drop the post-replay re-check, and
  the synth stub is called and a take is committed onto an excluded chapter.
- **Accept and drop replay directions (E18, revision 11):**
  - an Accept journal stopped mid-`discard-prev`, before `installed`: replay rolls back. The
    previous take is whole at `.previous.*`, the entry is still pending, and a retried Accept
    succeeds;
  - an Accept journal at `installed` whose `revisions.json` write failed (injected, then lifted):
    replay rolls forward. It records `accepted`, removes the entry and unlinks the discard set, and
    the previous take never comes back;
  - a drop journal stopped mid-`discard`, before `installed`, over a chapter whose only copy had
    already moved to its event folder: replay rolls back. The chapter is not excluded, its take
    fields are unchanged, and both takes are whole, the only copy back at `.previous.*`. The
    replay runs with the clock set to the next day, and the part still comes back from the
    folder the journal recorded (R11-2). With a foreign copy planted at `.previous.mp3`, that copy
    goes to the folder's `foreign/` subfolder and the only copy comes back, with neither file
    overwritten (R11-3);
  - a drop journal at `installed` whose `state.json` write failed (injected, then lifted): replay
    rolls forward. It writes `excluded: true`, clears the take fields, drops the entry and unlinks
    the discard set. The only copy stays in `.orphaned/`;
  - a carried drop journal before `installed` at a bundle overwrite rolls back in the pre-claim
    replay, and one at `installed` stuck on its `state.json` write is superseded by the `replace`
    (E14).

  The mutations that must fail: roll an Accept or drop journal back from `installed` on (the drop
  case then puts the takes back on a chapter the user asked to exclude, and the Accept case
  brings back a previous take the user accepted away); roll one forward from before `installed` (the first and third cases then end
  accepted and excluded instead of whole and pending); recompute the drop's event folder from the replay's
  date (the next-day case leaves the only copy stranded in a folder nothing names); and
  quarantine a drop's foreign copy into the event folder itself (the planted case collides with
  the only copy's name, and the quarantine refuses).
- **The slug plan under step 0 (R8-7, J7):** a restructure over a chapter whose only take is an
  unindexed previous take, and separately one with a legacy-reject shape. Step 0 promotes or
  re-stamps it, the closure's assertion does not fire, and the promoted take moves with its
  chapter. The mutation that must fail: test presence by `audioRenderedAt` alone, and the
  assertion fires (or, with it removed, the take stays at its old slug). **A GET in the gap (R9-5;
  pass 8, K8):** a book whose `chapterTitleParserVersion` is behind, with a GET `/state` injected
  while step 0 has released `book`. The refresh retitles a chapter, the closure's assertion fires,
  the restructure answers its fixed 500 having written nothing, and a retry succeeds against the
  refreshed titles.
- **The `book` key for an unaddressed handle (R8-4, J9):** a no-`bookId` bundle overwrite whose
  directory arrives spelt differently from the walk's, with a library-scan heal running across
  the swap. The heal either skips the book (it found the canonical directory in the unaddressed
  set) or holds the same canonical `book` key the overwrite's unlink waits on; it never fills a
  field from a take a rollback removes. The fsck walker's book does the same. The mutation that
  must fail: key the unaddressed handle's `book` on the minted id after the swap, and the heal and
  the unlink overlap.
- **One segments read (B7, R6-12):** a chapter whose segments lack a numeric `chapterId` is still
  scored, and is absent from the classifier's population, which equals `loadSegmentsFiles`'. On a
  case-insensitive filesystem, a chapter whose segments file differs from `<slug>.segments.json`
  only in case is scored by the join and absent from the classifier, exactly as `loadSegmentsFiles`
  omits it.
- **e2e:** the A/B player on an m4a book in mock mode.

### Option B: per-chapter manifest and generation counter

**Mechanism.**
- `audio/<slug>.take.json` = `{gen, live, previous}`, where `gen` is **monotonic**. Parts are named
  by generation (`<slug>.g<gen>.<suffix>`).
- A commit writes the new generation's parts, then makes **one atomic manifest write** under a
  short book-op span. Reject swaps `live` and `previous` with no file moves at all.
- The manifest is the truth **at every moment**, so recovery is "ignore unreferenced generations".
  It needs no journal and runs on any touch, not only at boot.

**Reader changes.** Every reader resolves through the manifest: the same ~47 files as A's Phase 1.

**Migration.** Synthesise a manifest from the flat files. The portable bundle and import flatten or
learn the layout. The whole-book writers (W13–W15) need the same treatment as in A.

**Closes** all of A plus reader skew. **About 70–75 files** (corrected: the reader count was
undercounted for every option).

### Option C: versioned take directories

**Mechanism.** `audio/<slug>/takes/<takeId>/…` with `live`/`previous` pointers. Pointer flips are
atomic, and restructure renames one directory per chapter.

**Migration.** A one-time move of every book's flat files, with its own recovery path. The portable
format changes.

**Closes** the same as B. **About 75–80 files**; highest risk.

### D. What A borrows from B, and what it no longer needs

Revision 2 borrowed two things from B:
1. **A monotonic generation**, to make the CAS immune to ABA. **Dropped (D1).** A per-commit random
   `takeId` makes ABA benign, because a take that comes back brings back its own content (§4.1).
   Keeping a counter coherent across `segments.json`, `state.json`, backups and the state PUT was
   the Critical finding.
2. **Recovery at any moment**, not only at boot. **Kept:** `reconcileSlug`/`reconcileBook` at every
   entry point, plus lazy minting (D3).

What A still lacks is B's reader atomicity across files. The job readers that write back (splice,
QA repair, scoring) are covered by the CAS, and UI readers refetch after every op. The export job
is **not** covered (corrected in revision 4). Its duration skew (R-f) was pre-existing on `main` (#4223, closed by #4224, merged at `33f3647c`), and
B's manifest would not have closed it either, because `build-m4b` probed before it read. Because the
module owns every path, B's manifest could later replace the journal inside the module without
touching any caller.

### Comparison

| | A | B | C |
|---|---|---|---|
| New lock class | none (retires `revision-op`) | none | none |
| Writer fence | book-op span + CAS (`takeId`) + signal | same, with `gen` | same |
| Reader consistency | per file | per take | per take |
| Recovery | journals, replayed at every entry point | the manifest is the truth | the pointer is the truth |
| Layout change | names only | generation-suffixed files | directories |
| Portable format | unchanged | changes or flattens | changes |
| Files touched | ~66–72 | ~70–75 | ~75–80 |

## 6. Recommendation and migration

**Option A**, as revised:

1. **The fence already exists.** Book-op serialises every quick operation. A adds short commit
   spans for the long-job writers that remain, routes the whole-book writers through the module,
   and adds a guard that sees every take write.
2. **It answers every reason the #3400 attempts failed:**
   - the exclusion is lexically scoped, so it cannot leak;
   - identity is a filename-safe random id read from the take itself, never inferred from absence
     or from a timestamp, and it moves with the take;
   - sidecars are staged, never captured from the wrong take.
3. **It keeps the layout and the portable format.** The flat files, the bundle and the export
   builders stay as they are. All three options touch the same ~47 readers, so file count is no
   longer a reason to prefer A; layout stability is.

**Book-op versus a per-chapter key (F12).** A per-chapter key is **not** a drop-in fallback.
- Restructure, exclude-prune, reparse and the fsck touch many chapters per operation, so each would
  have to take every affected chapter's key. That means a multi-key acquisition, ordered and
  bounded, with no existing `withKeyLocks` precedent for chapter keys.
- The key would also sit at a new place in the order (`book-op → take → book`).
- The guard would have to follow it.

Revisit only if row Q measures real contention despite the waiter retries (R4-10).

### 6.1 Migration (F2, F6; OD8; D3)

Migration is **not a boot-only pass**. It is what `reconcileSlug` and `ensureTakeIdentity` do the
first time they meet a legacy slug, at any entry point, under the caller's book-op. The boot fsck
is one caller among many. Every step is idempotent and **checks before it renames**: no rename may
replace an existing file. A target that already exists means the source is quarantined to
`audio/.orphaned/<iso-date>-<jid>/<name>` instead.

1. **Inventory first.** List every live audio file of each extension and every
   `.previous.{mp3,m4a,ogg}`. Sniff each one by magic bytes: an `ID3` tag or an MPEG sync word
   means mp3; `ftyp` at offset 4 means m4a; `OggS` means ogg. **Nothing is renamed yet.**
2. **Two or more live files.**
   - **Choosing the live one.** A file "matches" when its duration is within ±0.5 s of the live
     `segments.json`'s `durationSec`. The duration is measured by a **full decode**
     (`ffmpeg -i <f> -f null -`), not by ffprobe's header estimate, which is unreliable on legacy
     MP3s with no Xing header (`tts/mp3.ts:145-183`). This shape is rare, so the decode cost is
     paid rarely. It is paid inside the entry point's span, at most once per slug: the outcome is a
     rename, and with no span deadline (E2) nothing rolls it back. Exactly one match: that file stays
     live.
   - **The others.** If no previous take exists, one non-match becomes the previous take (with its
     real extension, the target checked absent). The rest are quarantined.
   - **Zero or several matches.** Every candidate except the newest by mtime is quarantined, and the
     case is logged.
3. **Wrong-name files.** Rename a live or previous file whose bytes disagree with its extension to
   the right extension, but only if that target is absent; otherwise quarantine it. This repairs
   earlier rejects on m4a/ogg books that wrote AAC or Opus bytes behind `.mp3`.
4. **Identity.** `ensureTakeIdentity` (§4.1).
5. **Re-stamp (F2).**
   - **The legacy-reject shape** is `state.json`'s `audioRenderedAt` ≠ the live segments'
     `synthesizedAt`. There, run `stampStateFromLiveTake` over every field.
     - A pending entry whose `renderedAt` named the rejected take then stops matching
       (`revision_not_found`). That is correct, because the reject already happened.
   - **Otherwise,** fill only the absent fields, through `deriveTakeFields`, as the heal does.
     Existing values are not rewritten, so the re-stamp is a no-op on a healthy chapter (including
     one whose `audioModelKey` came from the old raw-key heal).
6. **The no-live-take shape (F16, §4.2; R3-5).** Nothing here runs while a journal names the slug:
   replay runs first, and a failed replay leaves the slug untouched.
   - Orphan live segments and sidecars are quarantined first.
   - If the chapter is not excluded and the entry point is not `dropAllTakes`, the previous take is
     promoted by a journalled `restoreTake` with no `discard-live` phase.
   - If the chapter is excluded, or the entry point is `dropAllTakes`, the previous take is
     quarantined, as OD6 says.
   - This replaces fsck case 1's unjournalled renames **from Phase 3**, when `restoreTake` exists
     (§7). It no longer depends on a UI path that does not exist.

**`.orphaned/` (OD8; R3-6).**
- It is **never** auto-deleted. The reparse/replace wipe keeps it (R4-5).
- Quarantine happens only in the shapes enumerated above.
- Each event gets its own `<iso-date>-<jid>/` subfolder, so names never collide.
- The fsck logs a per-book line on every boot: the file count and total bytes.
- Exports skip it, because they enumerate live parts by slug through the module. (Backups never saw
  it: auto-backup snapshots `state.json` only.)

## 7. Phased rollout (each phase splits into roughly one-commit children)

**Done outside this design:** #4166 (N3, `completedSlugs`) is fixed by PR #4206, merged at
`25c65c0a`. It routes `completedSlugs` (`book-state.ts:782-789`) and `scan.ts`'s
`completedChapters` (`:750-754`) through `chapterAudioExists`, which is the module's predicate
(R4-1). So Phase 1 step 2 only re-points those two call sites at the module's accessor; it changes
no behaviour. #4167 (N5, the leaked tmp audio) is fixed by #4211. #4223 (the m4b duration skew) is
not part of this design; #4224 closed it, merged at `33f3647c`. #4233 (the splice and QA-repair SSE
leak) is fixed by #4234, merged at `08742125`, which is all of R7-5's scope; no phase lands any of it.

**Phase 1: identity, naming, liveness and lazy migration.** No behaviour change for a clean mp3
book.
1. `chapter-take.ts` skeleton:
   - suffix table and accessors;
   - the live-take predicate (§4.2) and `TAKE_STATE_FIELDS`;
   - the `takeId` type (segments, embeddings, `state.json`, `scan.ts` types; not verdicts, R4-6);
   - the sniffer, `deriveTakeFields` and `stampStateFromLiveTake` (with `effectiveAudioModelKey`);
   - `ensureTakeIdentity`;
   - the leaf `workspace/take-fields.ts` (R10-2), holding `TAKE_STATE_FIELDS`, `deriveTakeFields`,
     `healTakeFields`' fill rule and the live-take predicate, which `chapter-take.ts` re-exports.
     Its journal check, `journalNamedSlugs`, lands with the journals in Phase 2 step 2.

   Unit tests. `check:cycles` passes against the unchanged allowlist.
2. Readers move to the module's accessors (the ~47 files). R-k and the other blind-spot sites fold
   in. The portable export uses the module's live-part list (F15). `completedSlugs` and
   `completedChapters` use the live-take predicate. `deriveSegmentsHeal` uses `deriveTakeFields`,
   and `persistHealPatches` applies `healTakeFields` inside its locked write. `scan.ts`, and every
   module `scan.ts` reaches, takes these from the leaf `take-fields.ts`, never from
   `chapter-take.ts` (R10-2), so `check:cycles` gains no cycle.
3. Preserve, restore and the fsck use real extensions. **Fsck case 1 stays**, now with the real
   extension, until Phase 3 step 1 replaces it with the journalled promotion (A13).
   `revisions-store`'s existence check goes through the module. `withBookOpAtDir` hands its callback
   a handle (R4-8), and the process-local set of unaddressed directories lands with it (R5-7). The
   reparse wipe keeps `.orphaned/` (R4-5).
4. A-side routes for every extension, with the right mime type; the meta URL uses `urlSuffix`.
   OpenAPI, types, client and mocks.
5. Lazy migration (§6.1 steps 1–5) at the module's entry points and the fsck. Fixture tests for
   every rule. Step 6 lands in Phase 3.
6. `TAKE_STATE_FIELDS` wired into `chapter-uuid.ts` (W15), restructure's carry rule and the
   analysis persist's two chapter rebuilds (W16, R6-4, through `carryTakeStateFields`, R7-6); the PUT's slug-binding checks (R4-4, as
   restated by R5-8 and R6-5: a matched slug, an omitted chapter with a take, a changed
   `excluded`).
7. The guard test (rules 1–3, E4), with its read-only allowlist emptied as the steps above land.
   Rule 3 needs a same-function `const` resolver in `test-utils/guard-scan.ts`, which is new code
   with its own unit tests, and the three-plant mutation check (B8).
8. e2e: m4a A/B.

**Phase 2: commit protocol.** PR at `high` review depth. Row Q's OneDrive cells must be recorded
first.
1. `prepareTake`: staging every part with the non-creating writer, the signal checks and
   `liveStaging`; QA repair's Edit 6b embeddings and verdict patches as staged inputs.
2. `commitTake`: the journal with its review inputs, role-tagged discards (no unlink before
   cleanup), the interim only-copy rule (step 4), R3-1, the commit-time OD4 carry-forward (Edit 6b patches applied), the
   live-audio-first ordering, and the parked rethrow after `installed` with the journal kept on a
   failed stamp (E2); the review record only after a successful stamp, from the journal's `entry`
   (E6); `reconcileSlug`, `reconcileBook` and the sweep, with unparseable journals quarantined
   (R6-3); `healTakeFields`' skip of journal-named slugs, checked after its read (R5-2, R6-11);
   `take_repair_pending` for a per-slug journal stuck on a move-step failure, with the one
   move-step sentence, and the curated 500 for a record-step one, classed by the step that threw
   and never by `code` (R5-3, R5-4, R6-3, R7-4, R8-2); the per-slug journals' `lost` row and the
   `ENOENT` re-probe, both on `RENAME_RETRY_DELAYS_MS`' schedule (R8-1, R9-2), and the "both
   present" row by name kind (R9-1), with replay never installing forward (R10-1); every per-slug
   journal's part sizes, two copies at two slug names decided by `takeId` and recorded size, two
   undecided copies both quarantined as lost, every step deciding all its parts before it renames
   any, and `promote`'s audio first (E15); supersession of a journal on E12's list as widened by
   E14 only, with `supersedes` as a list that absorbs chains, every journal of a slug read before
   any is acted on, step 0 repeating until it settles and step 8 stopping at the first failed
   unlink, and "at most one unsuperseded journal per slug" (E10, E12, E14, R9-3, R10-3); the
   heal's `journalNamedSlugs` in the leaf `take-fields.ts` (R10-2); a journal read error never
   quarantines (R7-4); every journal unlink under `book` (R7-1), keyed through `canonicalDirKey`
   for an unaddressed handle, with the heal's set check, both in the leaf
   `workspace/book-dir-key.ts` (R8-4, R9-6); the
   take-switching stamp that clears members the new segments lack, its decoded `duration` for an
   unindexed take, never inside `book` (R8-3), and the backup-restore and legacy-reject stamps among
   them (R6-8, R7-7); `{ backfill: false }` for the module's in-job spans, and one journal listing
   per span (R7-8).
3. Generation:
   - the commit site, signal, `committing` and `stallPhase = 'commit'`;
   - the bounded between-span retry with the `entered` flag and all three causes, cause 3 limited
     to the record-step budget of three attempts (R8-2);
   - `takeCommitted` in the failure-stamp path, and R3-7's terminal frame with
     `take_details_pending` (R4-7), with `afterChapterFinalized` and the queue-entry mark still run
     before it, and the permanent-cause sentence chosen by `requestFailureMessageFs` (R7-4, R8-2);
   - `afterChapterFinalized` after the span;
   - OD2's per-chapter splice abort, and the `startTakeId` span with its stuck-journal check
     (R5-4; a move step fails the chapter, a journal on E12's list as widened by E14 is logged, any
     other record step gets the three-attempt budget, R8-2, E10, E12, E14), and
     `ensureTakeIdentity`'s failures never
     stopping a full render (R8-2);
   - the PUT's `reconcileBook` before it compares `chapters` (R6-5).
4. Splice and QA repair: registration-first base read, base tokens, the CAS-mismatch sentence, N6
   driven by the commit result, the `chapter_failed` frame with `code: 'take_repair_pending'`
   (R6-3), the base-read span ending through `requestFailureMessageFs` after its budget (R7-5,
   R8-2), and the exit-path scoring request outside the span, **with `source: 'partial'`, whose
   pass never runs the post-audition reconcile** (E7). #4233's fix is already on `main` (#4234);
   this step keeps its new frames on that curated path (R7-5). `triggerScoring`'s `source`, its
   per-key pending list with
   chapters by `uuid`, else by `id` and `slug` (R6-1, R7-12, R8-6), the synchronous hand-off of the
   in-flight marker (J5), the no-reconcile rule for partial passes (E7), the at-once rule for every
   other pass (E8), and the resume pass's re-check through the leaf gate's
   `isAnyGenerationActive()` and `readSpliceEpoch()`, both read at the pass's start and again
   before its reconcile (E9, E11, E13), land in the same step as the
   request, so no phase ships a pass that reconciles from the pending list, or a resume pass that
   reconciles beside a running job. This step's PR closes #4235, and its body restates #4235's
   acceptance criteria: #4235 asked the route to refuse Resume, with a "resume is refused" test,
   and E9 instead runs the pass and skips only its cleanup, so the PR's test is §5.A Tests' case 4,
   not a refusal (pass 8 note).
5. The bundle overwrite through `replaceTakesFromBundle`, placed after the rename loop (R3-8, A14),
   with both of its branches' handles (R5-7), the `finally` and the canonical key (R6-6), and its
   replay before the path claim (R6-7), the carried slugs' per-slug journals replayed there too
   without lazy migration, and superseded by the `replace` journal when on E12's list as widened
   by E14, or a drop journal, and stuck on record steps only, any other refusing the import (R8-5,
   R9-7 as restated by E14); backup restore through `reconcileBookTakes` with the threaded handle, after `book` is
   released, with the pre-restore `duration` carry (R3-9, R6-6, R8-3); both resolve a pending
   journal before they swap `state.json` (R5-5).
6. The waiter retries (R4-10): `runBookJob`'s registration, and the listen-progress and listen-stats
   PUTs, with listen-progress's receive-time ordering (R5-6).
7. Lock-order comments, and the CLAUDE.md lock-order sentence and the fail-loud and swallow
   enumerations (State-write sites table: five new fail-loud, `dropEntry` among them, one moved,
   four new swallow), and the `requestFailureMessageFs` handler list and call-site count for any
   call site this design adds (#4234 already updated them for its own, R7-5).

**Phase 3: fidelity, retry recognition, scoring.**
1. `restoreTake` with its journal phases, and R3-5's promotion (§6.1 step 6), which replaces fsck
   case 1; `acceptTake` with the live-token table, its journal phases and their replay direction
   (E18, R11-1), and the `live_audio_missing` pre-check removed (R4-3), and commit step 4's interim
   only-copy rule removed; entries gain
   `takeId`/`previousTakeId`/`previousRenderedAt`; `entryMatchesChapter` widens to
   `audioRenderedAt ∈ {renderedAt, previousRenderedAt}`, and the Accept/Reject tables read the live
   segments' `takeId` (E6); the promotion's and the replace's `dropEntry` step (R6-8), landing with
   the widening so no phase widens the match without it.
2. Retire `revision-op`: `revisionOpLockKey`, the two holders, the comments in `cast-lock.ts:40`
   and `book-op-lock.ts:17-18`, and the tests that cite it (`book-op.single-book-routes.test.ts:468`,
   `revision-ops.test.ts:542,574-578`, `chapter-audio.test.ts:603`), each replaced by an assertion
   on book-op.
3. `commitScoring`: the pre-read `ensureTakeIdentity` span; one segments read per chapter, with
   two filters over it (B7) and the embeddings/segments `takeId` check; one span per character write, with a per-chapter CAS on
   the live segments `takeId`; the `commit` callback from `triggerScoring` and the resume route; the
   merged re-run and its re-arm bound; named slugs of a stuck journal skipped (R5-3); the
   classifier's exact-name membership (R6-12).
   `generation.ts:295` goes through it.

**Phase 4: remaining fences.**
1. `dropAllTakes` for exclude (OD6, the take-field clear), with its journal phases and their replay
   direction, the event folder recorded at write time and replay's `foreign/` subfolder (E18,
   R11-1 to R11-3). The render's post-replay `excluded` re-check (E17, R11-4) lands in
   `routes/generation.ts`'s chapter-start span in the same step, because the drop journal is what
   can set `excluded` during a replay; no earlier phase has one. `relabelTakes` for restructure renames and
   delete ops (R7-3), with the cursor journal, the pre-state rollback window over hints only, forward-only
   replay, the parked rethrow and R4-2's background retries (E1); per-part idempotence with `lost`
   (R5-1); run-time `clearStalePrevious` probing (R6-2); `onlyCopy` and `parts` read after step 0,
   which builds the slug plan first, outside `book`, and never promotes a drop slug (R7-3, R8-3);
   `land` keyed on
   `landing` (R7-2); the restructure sentence (R7-9); the relabel journal unlink under `book`
   (R7-1); `unreadable` in `metadata` (R6-3); `relabelJid` in the state write (R6-5); step 0's
   `reconcileSlug` over the plan's slugs (R6-10); the plan-driven pending-entry reconcile (R6-9);
   `hintsPrior` dropped after `state-landed`; book-journal scope, the `take_repair_pending` answers
   and the restructure refusal (R5-3, R5-4); no cache rebuild after a parked edits write;
   `buildAudioOps`' presence test as `audioRenderedAt` **or** a take on disk (R8-7); the restructure
   sentence for every code (R8-2, J12); the comment at `chapters-restructure.ts:605-609` corrected,
   unconditionally. #4224 moved its anchor to `book-state.ts:660-675`, but its claim that partial
   state "is recoverable via the reconciliation filter" is still false, because that filter drops
   edits by sentence-id range and does not recover a renumbering (#4227, J13).
2. Reject and `restore-unrecorded` refuse `book_busy` during an export (OD7).
3. On-box register rows on all three surfaces:
   - **Row Q, the Windows matrix.** The NTFS cells are recorded from pass 1's probe (§5.A
     Windows). Still owed:
     - the same three columns on a **OneDrive-mounted** workspace, with each holder (ffmpeg export
       read, ffmpeg clip cut, Node read stream, none);
     - real commit-span timings, scoring's per-character spans included (no deadline, E2; R7-8),
       to check the 30 s waiter retry bound (R4-10);
     - **recorded 2026-11-16, NTFS, this box:** with ffmpeg holding a hard-link snapshot of a
       chapter's audio (PR #4224's staging), renaming a new take over the live name succeeds, and
       renaming the live file away to `.previous` succeeds too (revision 7 records the second half).
       With ffmpeg holding the live file directly, the controls fail EPERM and EBUSY respectively.
       Commit step 5 opens with the rename-away, so the second half is the one #4224's m4b case
       rests on. The OneDrive cells for both are still owed;
     - **the OneDrive scan window (R9-2):** a part probed while OneDrive has it in its own
       staging, to confirm the re-probe schedule outlasts the absence `atomic-rename.ts:7-9`
       describes;
     - waiter outcomes (autosave, job registration) while an export holds a live file and while a
       slow commit runs.
   - **An m4a book on real hardware:** render → splice → reject → accept, with the files listed
     before and after.

Each PR carries:
- release notes, technical and user-facing. Phase 1's line: "Reject restores the original take
  correctly on M4A and Opus books";
- the regression plan `docs/features/<n>-chapter-take-lifecycle.md`;
- an `INDEX.md` row.

### 7.1 Implementation notes (plan-level, not design-level)

These are inputs for the implementation plan. They are **not** design questions. The design
settles the behaviour, and each note only names how the plan meets it or what it costs. Pass 9
listed both as not named (revision 10 changelog), and revision 11 moves them here.

- **The gate's fail-closed test hook (§5.A Tests, case 4, "fail closed").** No new export is added
  to `gpu/active-generation-gate.ts`. The gate has no unregister function. Its own tests reach the
  unregistered state through `vi.resetModules()` and a fresh import
  (`active-generation-gate.test.ts:11-19`). That route is closed to the scoring test, because
  importing `routes/generation.ts` registers the providers (`generation.ts:682-683`). So the
  scoring test replaces the leaf with `vi.mock` for that case. Its `isAnyGenerationActive` returns
  `true` and its `readSpliceEpoch` returns `null`, which are the answers the gate itself gives when
  unregistered (`:139-142`, `:128-131`). The assertion stays the case's own: the seam is called
  zero times.
- **The cost of R9-2's per-part re-probe.** It is paid only for a part that is absent under both
  names at its first probe, and for a rename that throws `ENOENT`. On a healthy disk that is never,
  and each part costs one probe of two names, as today. When it is paid, a part is probed once and
  then again after each of `RENAME_RETRY_DELAYS_MS`' five delays (`atomic-rename.ts:22`), so six
  probes of two names. That takes 1.8 s on the base schedule, and at most
  `RENAME_RETRY_WORST_CASE_MS`, about 3.6 s, with full jitter (`:26`). A rename that throws
  `ENOENT` has already spent up to that much inside `renameWithRetry`, so that part costs at most
  about 7.2 s. **The plan runs one shared schedule per step:** E15 already has a step probe every
  part before it renames any, so the step re-probes all of its absent parts together. The cost is
  then about 3.6 s per step however many parts are absent, inside book-op's 10 s acquisition budget
  for any other operation waiting on the book. Probing one part after another would cost up to
  about 3.6 s per part. A take has seven parts (§4.3), and a commit journal can list the live,
  previous and staged takes, so replaying it would cost up to about 21 × 3.6 s, about 76 s,
  inside one span. With the shared schedule, a drop's `discard` step, which moves two takes, still costs one
  schedule.

## 8. Questions

### 8.1 Owed questions from all nine passes and the revision 11 decisions, answered

| Question | Answer |
|---|---|
| May a relabel ever roll back once `state.json` has landed? If so, which of hints, edits, the ManuscriptRecord and the analysis cache revert with it? (pass 3, Q1) | No (E1): forward only, from a step cursor plus each source's `takeId`. Only the journal and `manuscript-hints.json` are in the pre-state rollback window. Edits, the record and the cache are written after `state.json`, so they roll forward (§5.A Restructure). |
| Should a commit that has staged every part ever be abandoned for being slow? (pass 3, Q2) | No (E2): no deadline. The waiters that cannot wait retry their acquisition (R4-10). Steps after `installed` park and rethrow last. The journal carries the review inputs (§5.A Commit). |
| Does "a render of the book" mean a registered chapter POST or the whole render queue? Which signal should scoring read? (pass 4, Q1) | Neither (E5): the partial trigger no longer waits for renders, so it reads no signal. Revision 5 said it runs with the full-cast `keep`, which protects a render; pass 5 showed it does not across run keys, and E7 replaces it: a partial pass never reconciles (§5.A Scoring). |
| After a parked stamp, may the A/B entry be visible before `state.json` catches up? Is `audioTakeId` a decision input? (pass 4, Q2) | No, and no (E6). The entry is recorded only after a successful stamp, and Restore appears once replay lands it. `entryMatchesChapter` reads `audioRenderedAt`, the retry tables read the live segments' `takeId`, and the `audioTakeId` mirror stays swallowed (§5.A Commit, Retry recognition). |
| What makes a relabel group "done" for one source, and what may run against a slug that an unfinished journal names? (pass 4, Q3) | Per-part tests inside each group, including `land`'s "temp absent, target present" branch (R5-1). The scan heal skips journal-named slugs (R5-2). A stuck journal blocks only the slugs it names, and answers `take_repair_pending` there (R5-3, R5-4). Whole-book writers resolve it first or refuse (R5-5). |
| What does a splice- or QA-repair-triggered scoring pass do about Qwen tiers? (pass 3, Q3) | Revision 4: it waited while any synth job of the book ran, then ran with the full-cast `keep` (E3, R4-9). Revision 5: no wait; the full-cast `keep` alone (E5). Revision 6: no wait, and no post-audition reconcile at all (E7). |
| While a render of the book may be running at another Qwen run key, which tier set is a partial trigger's "full-cast `keep`"? Should a merged re-run combine triggers with different `runModelKey`s? (pass 5, Q1) | Neither question survives as asked (E7): a partial-only pass never reconciles, so it needs no `keep`. Stray tiers stay until the next render reconcile, a stated cost. Triggers merge only at an equal run key (R6-1). Revision 7 narrows "nothing is evicted under a running render" to what E7 and E8 close, and lists the pre-existing paths (§5.A Scoring). |
| What do a journal's blocked slugs and their sentence cover when the failure is not a held file? Is an unreadable book journal fail-closed or quarantined? (pass 5, Q2) | Two classes (R6-3). Only a rename-class failure blocks, with `take_repair_pending`. A stamp or lock failure answers the curated 500 and blocks nothing. `metadata` skips a corrupt part. An unparseable journal is quarantined with the files it was moving, not fail-closed (§5.A Ownership, Restructure). Revision 7 decides the class by the protocol step that threw, not the error (R7-4). |
| Is the analysis persist a D3 writer? Carry `TAKE_STATE_FIELDS`, or let the heal re-derive `audioTakeId`? (pass 5, Q3) | Yes, W16. It carries `TAKE_STATE_FIELDS`, and only those, over the PUT's `sameChapter` match; the heal keeps "never `audioTakeId`" (R6-4, restated by R7-6, §4.3). |
| Does "only a full render's own scoring pass reconciles" (E7) cover the resume route? What does a pass started from R6-1's pending list reconcile? (pass 6, Q1) | E8: a resume pass reconciles, against `scoreBook`'s `usedQwenTiers`, only when it starts at once, as on `main`, where the route refuses resume during generation. A pass started from the pending list never reconciles, whatever its triggers, which is `main` parity because `main` drops those triggers. A render's own pass that starts at once still reconciles (§5.A Scoring). |
| What makes a relabel source "landed" when it has no live segments? What does `land` do with a foreign occupant after a source's first part? Does `relabelTakes`' step 0 promote the slugs the plan drops, and which plan does it read? (pass 6, Q2) | "Landed" is recorded: a source joins `landing` before its first part moves, after its target names are cleared of anything outside the plan (R7-2). An occupant met later is quarantined, then the part lands. Step 0 builds the slug plan first, does not promote a drop slug, and the journal's `parts` and `onlyCopy` are read after it (R7-3) (§5.A Restructure). |
| Is the failure class decided by the protocol step or by the error? What does a persistent stamp failure do at commit step 0 and at the splice and QA-repair base read, without a path in the SSE frame? (pass 6, Q3) | By the step (R7-4). A persistent record-step failure (ENOSPC, EACCES, EROFS) is never retried: the chapter fails fast with `FS_PERMANENT_FAILURE_REQUEST_ERROR`, before synthesis where the chapter-start span sees it. Splice and QA repair's base read ends through `requestFailureMessageFs`, and their catch-alls are curated too (R7-5), which also fixes a leak live on `main` (§5.A Ownership, Commit, Failure handling). |
| Does E8's "starts at once" mean "not queued", checked when Resume is clicked, or "no render is running", checked by the pass itself? (pass 7, Q1) | E9: both. A resume pass that starts at once also re-checks, immediately before it reconciles, that no render, splice or QA repair of the book is running, and skips the cleanup if one is. That closes the click-to-start and audition windows, and #4235 (§5.A Scoring). |
| A leftover journal past `installed` owes only record steps, which fail persistently: end the new commit and discard the render, or supersede the journal and keep it? (pass 7, Q2) | E10: supersede. The new commit names the old journal, absorbs what it owes, installs its own take, and fails loud at its own step 7 if the same refusal hits its stamp (§5.A Commit step 0, Journal rules). |
| What does a per-slug journal's replay do with a part absent under both names? What bounds a record-step retry when `code` misstates persistence? (pass 7, Q3) | Records it as lost and continues, with an `ENOENT` re-probe (R8-1). A record step gets three attempts of its own, never the watchdog, and `code` chooses only the sentence (R8-2) (§5.A Ownership, Journal rules, Retries). |
| E9's reach: a literal per-book sample, a per-book signal that spans chapter gaps, or the process-wide `isAnyGenerationActive()`? (pass 8, Q1) | E11: the process-wide predicate, plus the registration epoch, so a registration during the pass is seen. Resume skips its cleanup more often, a stated cost. E13 adds a start sample for a job already running when the pass starts (pass 9) (§5.A Scoring). |
| E10's reach: restore and promotion journals too? Drop and Accept? (pass 8, Q2) | E12: commit journals past `installed`, restore journals and promotion journals only. Drop and Accept keep block-and-retry (§4.1, §5.A Commit step 0). |
| What does replay do when both names are present and the target is a slug name? What happens to a journal superseded by one that is itself superseded? (pass 8, Q3) | By name kind: the slug-name copy is foreign when the other side is journal-unique; at two slug names a segments part is decided by `takeId`, and anything else refused (R9-1), until E15 decided it by recorded size (pass 9). Chains absorb: `supersedes` is a list, unlinked oldest first, and replay reads every journal of a slug first (R9-3) (§5.A Journal rules, Commit). |
| E11's epoch sees only registrations made after the pass starts. Should the re-check also sample `isAnyGenerationActive()` at the start? (pass 9, Q1) | E13: yes. Both samples, at the start and before the reconcile, must read idle, and the epoch must not move. A job already running at the start is seen (§5.A Scoring). |
| Should a `replace` journal past `installed` join E12's list, and may a bundle `replace` supersede a carried drop journal? (pass 9, Q2) | E14: yes to both. A carried Accept journal still refuses the import (§4.1, §5.A Ownership, Commit step 0). |
| Should a non-segments part found at two slug names stay a refusal, or should the journal's recorded sizes decide it? (pass 9, Q3) | E15: sizes, with the `takeId` for the parts that carry one, and a byte compare at equal size. Two different copies nothing decides are both quarantined and the part is recorded as lost, so no replay path leaves a mixed take and no refusal is left for this shape (§5.A Journal rules; confirmed by E16 under "Owner decisions"). |
| Is E15's tie rule (both quarantined, the part lost) confirmed, with revision 10's other choices? (revision 11) | E16: yes. The take is incomplete, never mixed, and the slug is not blocked. The identical-copy rule, `take-fields.ts`, the whole-book heal skip and the step-8 stop are confirmed with it. |
| A drop journal's replay can set `excluded: true` during a render's chapter start. Does the render re-check it? (pass 9, not folded; revision 11) | E17: yes, inside the same span after replay. An excluded chapter is skipped before anything is staged, with no write and no frame, which is what the existing skip reports (`generation.ts:1143-1149`). It is the in-lock re-check, beside the caller's filter (§4.1). |
| Which way do Accept and drop journals replay? (pass 9, not folded; revision 11) | E18: back before `installed` and forward to completion from `installed` on, as commit and `replace` journals do. `installed` is the phase each journals once its moves have landed (R11-1). The drop's event folder is recorded at write time (R11-2), and replay's foreign copies for a drop go to its `foreign/` subfolder (R11-3) (§5.A Journal rules, Accept, Exclude). |
| Where does the canonical `takeSeq` live, and what exact equality does the commit test? Should Accept bump it? (A1, 1-1) | Nowhere: it is dropped (D1). The commit tests `live segments.takeId === base`. Accept bumps nothing. |
| A failed stamp after `installed`: swallow or rethrow? Which source decides "committed"? (A2) | Rethrow (D2). The journal at `installed` or later, or the live segments' `takeId`, decides; never `state.json` (`takeCommitted`). |
| Must the module own every whole-book and whole-state writer, and every book of any age, with minting and liveness enforced at its own entry points? (A3, 1-3) | Yes (D3): W13–W15 go through module entry points; `ensureTakeIdentity` and the §4.2 predicate run at every entry point. (Revision 3 also claimed that guard rule 3 sees zip-relative and variable-suffix writers. E4 withdraws that claim: they are listed blind spots, and every such site on `main` folds into the module.) |
| EBUSY/EPERM under an ffmpeg reader: keep the staged take and retry, bounded and watchdog-visible? What deletes `.next-*`/`.discard-*` on every non-commit exit? (1-2) | Yes (D4): a between-span retry under `stallPhase = 'commit'`, bounded by the no-progress watchdog. The sweep is in every non-commit exit, `reconcileSlug` and the fsck. |

### 8.2 Answered from code (pass 1)

- **Attempted-marker writers** are `generation.ts:295` and `aggregate.ts:667`. The marker is
  existence-only, so a staged or carried marker reads the same as a scored one.
- **Partial carry-forward:** verdict keys survive it. Carried rows for untouched segments keep their
  frozen `resolvedCharacterId` stamps (#3362).
- **ffprobe tolerance:** the header estimate usually falls through to mtime, so it is replaced by a
  full decode (§6.1 step 2).

### 8.3 Outside this design (pre-existing on `main`, with its own ticket)

The one item here is not an open question of this design. It is a gap that exists on `main` today,
and this design neither closes it nor widens it. It has its own ticket, and that ticket holds the
decision it owes. In this design it is an accepted residual (§5.A Remaining).

- **The edits/cache gap after restructure's state write (design pass owed, #4227).** A crash, or a
  parked failure, between restructure's `state.json` write and its `manuscript-edits.json` write
  leaves the saved sentences keyed to the pre-restructure chapters. `main` has the same gap after a
  crash there, and the GET-side reconciliation does not close it (§5.A Restructure). The decision
  owed is which behaviour is right: replaying the edits rewrite from a journal (its payload is every
  sentence), marking the saved sentences stale, or discarding them. #4227 holds those three options.
  This design only keeps the cache rebuild from compounding it.
  **Update (2026-11-17, #4227):** closed on `main` by a separate edits journal (`.audiobook/restructure-edits-journal.json`, `workspace/restructure-edits-journal.ts`), written before the state write and replayed at the next restructure or at server start; it adds no `state.json` field and is independent of the relabel journal above.

### 8.4 On-box acceptance owed (not a design question)

What is owed here is a measurement on the box, recorded before Phase 2, as §7's Phase 2 heading and Phase 4 step 3 say.
The design's answer holds as written. Only a measurement that contradicts it would reopen anything,
and that would go through a new ticket.

- **Row Q, OneDrive cells and timings** (§7 Phase 4). If OneDrive also blocks a rename-away under a
  Node holder, a commit would also wait during playback. The retry path covers it, but OD7 would
  then need revisiting. If real commit spans routinely exceed R4-10's 30 s waiter bound, that bound
  is revisited. The deadline is not reinstated (E2).
