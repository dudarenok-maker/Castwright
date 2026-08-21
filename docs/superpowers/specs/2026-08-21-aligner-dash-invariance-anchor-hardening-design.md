# Aligner dash-invariance + anchor hardening — design

Status: approved for planning (revised after assumption-checker pass — see
"Revision history")
Date: 2026-08-21
Issue: [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)
Supersedes: the implementation on `fix/server-2537-dash-invariant-align` (PR
[#2577](https://github.com/dudarenok-maker/Castwright/pull/2577)) as it stands
at commit `9262412a` — see "Disposition of PR #2577" below.

## Revision history

**v1 → v2 (this revision), after a mandatory adversarial `assumption-checker`
pass.** The pass found v1 had real design gaps, not just wording issues —
several of its central claims were false or overclaimed, and its testing plan
could not have caught a fourth silent failure of the exact shape as the first
three. v2 fixes each; see inline notes marked **[v2]** at each changed
section. Full findings are not reproduced here — this file states the
corrected design directly.

## Problem

`alignSentences` and `locateSentenceOffsets`
(`server/src/analyzer/dialogue-structure/aligner.ts`) locate each sentence in
a chapter's raw body by substring-searching a "needle" built from the
sentence's cached, normalized `text`. **[v2 — corrected mechanism]** The
inconsistency is not a deterministic upstream `.replace()` stage; it is the
stage-2 model itself stochastically dropping (or reshaping) a leading
paragraph-dash marker on some sentences and not others (confirmed precedent:
#2306, "the model silently stripped the leading dash from its returned text",
`server/src/store/attribution-health.criteria.test.ts:60`). That means the
variation this design must tolerate is broader than "dash present vs.
absent" — glyph choice, spacing, and even mid-run re-segmentation (a
continuation segment gaining a spurious leading dash — see
`aligner.test.ts:407-415`) all vary too. This design tolerates dash
presence/absence and glyph/spacing variation; segmentation drift is out of
scope (see "Out of scope").

Today's needle construction (`normalize(s.text)`, no dash handling) inherits
this instability: the SAME sentence can locate a different raw span
depending on which form the model happened to emit for that particular
cached run. Confirmed on real data: 22 of 23 books in the local library are
unaffected, but the 23rd — *Ночной дозор*, a dash-dialogue-dense Russian
novel — shows 14 fields diverge when its cache is compared straight vs. with
every leading dash stripped (`docs/testing/onbox-acceptance-register.md`,
E11 §item 2). That specific comparison is a **acceptance probe**, not
production behavior — production never runs a deterministic strip; it is the
tool used to detect that the aligner's output depends on a property (dash
presence) it shouldn't.

Three implementation attempts on `fix/server-2537-dash-invariant-align` have
each failed independent PR review:

1. **Unconditional strip** (`40bee7ff`) — strips *one* leading dash from
   every needle regardless of cache form. Reopens a real false-match risk in
   sparse-anchor runs (below). Rejected before an on-box run.
2. **"Keep the dash if the cache had one"** (`6dddbdc0`) — the needle
   construction is a literal identity transform
   (`hadLeadingDash[i] ? t : t.replace(...)` returns `t` on both branches),
   confirmed both synthetically (0 diffs, 6,610 sentence evaluations) and on
   a real on-box re-run (identical 14-field divergence). **[v2 — corrected]**
   The needle construction was a no-op, but this commit's unconditional
   backward-extension (§2 below) is a real, live behavior change that
   *survives* into the current branch state and is not itself a no-op — the
   "attempts 2–3 were no-ops" framing in v1 was inaccurate on this point.
3. Applies the same needle-construction no-op to `locateSentenceOffsets`
   (`3053f5dd`), **[v2 — corrected]** but this commit's backward-extension
   for that function is real and already gated on the (defective)
   `hadLeadingDash` flag — it is not, as v1 said, entirely missing. The work
   owed there is deleting the gate and fixing the needle construction it
   gates, not adding new logic from scratch.

## Why unconditional stripping is necessary — and what "byte-identical" actually requires

**[v2 — corrected]** v1 claimed `normalize(s.text).replace(/^-\s*/, '')`
(stripping *one* leading dash) makes needles byte-identical across cache
forms "by construction." That is false when the model emits more than one
leading dash glyph — e.g. `"—— Да."` (doubled em dash, the exact shape
`aligner.test.ts:407-415`'s own fixture comment documents as a real model
behavior: a continuation segment "re-prefixed... as if it were a fresh
line"). Trace it: `normalize("—— Да.")` → `"-- да."`; stripping one leading
`-\s*` leaves `"- да."` — still carrying a dash, and **not** equal to
`normalize("Да.").replace(/^-\s*/, '') === "да."`. One strip is not enough.

The corrected construction strips **all** leading dash-groups, not just one:

```ts
const needles = sentences.map((s) => normalize(s.text).replace(/^(-\s*)+/, ''));
```

`(-\s*)+` repeats until no leading `-` remains, however many the model
emitted. With this, `normalize("—— Да.").replace(/^(-\s*)+/, '') === "да."`
and `normalize("Да.").replace(/^(-\s*)+/, '') === "да."` — genuinely
identical. This is the form both `alignSentences` and `locateSentenceOffsets`
must use; a needle-builder helper should be extracted and exported (or
otherwise made independently testable) specifically so the invariance
property test in Testing item 1 can assert equality on the needle array
itself, not infer it from behavior — this is what closes the gap that let
attempt 2 read as green.

**Downstream, this claim is solid**: every E11-diverging field
(`narratorIdSpoken`, `unknownOriginNarrator`, `unattributedSpeech`,
`splitSpeech`, `tagNarratorSpan`, per-chapter `attributableSpoken`) derives
from `alignSentences`' `spans` / `sentence.characterId` via
`server/src/store/attribution-health.ts:140-290`, and nothing else on that
path reads `s.text` directly. Identical needles ⇒ identical `locateNeedles`
output ⇒ identical measurement on that path. (`cross-examine.ts:225` is a
**separate** consumer that reads the cached sentence text's leading dash
directly, outside the aligner — out of scope, see "Out of scope".)

**[v2 — added]** Empty needles: if every leading dash-group is stripped and
nothing remains (a sentence cached as just a dash, or dash + whitespace),
the needle is `""`. `fillRun` already treats a zero-length needle as
unresolved (`aligner.ts:250`, `results[i] = null`) — this is the correct,
existing behavior and needs no new code, but Testing item 1 must include this
case explicitly rather than leave it implicit.

**[v2 — added] Language gating.** `dialogueOpen` is `null` for en/de/ja/zh
(`server/src/analyzer/dialogue-structure/lang/{en,de,ja,zh}.ts`), and
`server/src/analyzer/narrator-default.test.ts:96,109` pins as an explicit
invariant that a leading dash is **not** a dialogue marker in those
languages — it can be real content (a list-item marker, a hyphenated
opener). v1's unconditional strip+extension applied to every language would
change span boundaries on English/German/Japanese/Chinese books, which are
the majority of the corpus, for zero benefit — #2537 is specifically about
dash-dialogue languages. **The strip and the backward-extension both apply
only when the chapter's language has a non-null `dialogueOpen`** (ru/es/fr
today). The implementer must thread the chapter's resolved convention (or an
equivalent boolean) into `alignSentences`/`locateSentenceOffsets` — check
whether `ParagraphEvidence`/the call sites already carry this, or whether it
needs adding as a parameter; this is an implementation detail, but the gating
itself is not optional. When the gate is false, needle construction and
extension both fall back to today's (`main`) behavior exactly — this is
itself a testable parity requirement, not just an absence of a code path.

## The separate concern: false-match risk in sparse-anchor runs

The file already has a robustness mechanism for short/common needles:
`#2187`'s two-pass anchor system. Needles ≥ `ANCHOR_MIN_LEN` (24 normalized
chars) become "anchors" in a first pass (`findAnchors`) and bound a monotonic
cursor; every shorter needle is resolved in a second pass (`fillRun`),
strictly confined to the interval between its two neighboring anchors —
"structurally impossible" to escape, **provided anchors exist reasonably
close on both sides**.

Attempt 1's rejected regression only reproduces in a run with **no anchor at
all**. In that degenerate case Pass B's search is effectively unbounded over
the whole run, and a short needle can bind to the wrong occurrence of common
text. "Keep the dash to dodge this" is not real protection (a
differently-shaped decoy defeats it too) — dash presence in the needle was
never the actual safety mechanism; anchor density is.

`findAnchors`' own code comment documents an adjacent, pre-existing gap:
anchors are chosen by length alone with **no uniqueness check**, so a
duplicated ≥24-char sentence can mis-anchor at the wrong occurrence and
strand the rest of its run.

**[v2 — corrected mechanism]** v1 proposed folding both gaps into one rule —
lower the anchor floor *and* require uniqueness, in a single conjunct — and
claimed this "closes" the duplicate-anchor gap. Two things were wrong with
that:

1. **The proposed uniqueness check (`indexOf(needle, pos + needle.length) ===
   -1`, i.e. "no second occurrence forward of the found match") does not
   detect the failure mode the file's comment actually describes.** That
   failure requires the needle's *true* corresponding occurrence to sit
   **behind** the monotonic cursor (already passed, unreachable) while a
   coincidental match still exists at/after the cursor — `findMatch` finds
   that coincidental match, and a forward-only uniqueness check sees no
   second occurrence ahead, so it accepts a wrong anchor with total
   confidence. This is a structural blind spot of the monotonic-cursor
   design generally (not something a local check at the candidate-selection
   step can close), and this design does not claim to close it — see revised
   residual below. What the forward check **does** correctly close: the case
   where the true occurrence is genuinely ambiguous going forward (a
   duplicate exists later in the same accessible region) — that case is
   real and worth rejecting rather than silently guessing.
2. **Lowering the anchor floor and requiring uniqueness are opposite-signed,
   not complementary.** A lower floor admits shorter candidate needles;
   shorter needles recur more often in natural language, so the uniqueness
   conjunct rejects disproportionately from exactly the newly-admitted band.
   Whether the net anchor count in a sparse, dash-dense run goes up or down
   is an **empirical question this design cannot answer from first
   principles** — it depends on the actual repetition rate of
   moderate-length dialogue lines in the target corpus.

**Corrected mechanism — reject-if-ambiguous, applied uniformly, not
anchor-eligibility tuning:**

Rather than trying to tune anchor *eligibility* to hit a favorable anchor
count (approach v1 took, and which point 2 above shows is not analytically
tractable), apply one consistent principle to **both** passes: **never
silently accept a match that has a second, indistinguishable occurrence
within the region actually being searched.** Concretely:

- **Pass A (`findAnchors`)**: unchanged eligibility floor (`ANCHOR_MIN_LEN`)
  — do not lower it (point 2 above; a lower floor's net effect is unknown and
  this design does not gate merge on resolving that unknown). **Add** the
  uniqueness check to existing eligible candidates: an otherwise-eligible
  candidate is only accepted as an anchor if `findMatch` cannot find a second
  occurrence forward of the accepted one, within the remaining haystack. This
  alone closes the *forward*-duplicate sub-case of the documented gap (not
  the behind-cursor sub-case — see residual).
- **Pass B (`fillRun`), new**: for a needle below `ANCHOR_MIN_LEN` located
  within its bounded run, check for a second occurrence of that needle
  **within a bounded local window** of the run's haystack (reuse the
  existing `WINDOW` constant, 4096 chars — not the whole run, which could be
  large and would reject legitimately-repeated short dialogue, e.g. two
  different characters both saying "Да." far apart in the same run). If a
  second occurrence exists within that window, treat the match as
  unresolved (`null`) rather than silently accepting `indexOf`'s first hit.
  This is what directly closes the attempt-1 regression fixture: normalized
  `"да."` has a second, *nearby* occurrence (the real `"— Да."` a few
  characters later) inside `"...где правда.\n\n— Да."`, so the ambiguous
  first hit is rejected instead of silently bound to `"правда"`.

This is deliberately **not** full Approach B (uniqueness-gated matching for
every short needle everywhere) — it is scoped to a bounded local window,
applied only when ambiguity is locally detectable, and it can only ever
convert a currently-wrong silent match into an honest miss; it cannot turn a
currently-correct unique match into a wrong one. **It trades recall for
precision** on ambiguous cases: some sentences that were previously
(possibly correctly, possibly not) matched will now report unaligned. This
is the right trade for a system whose downstream already has an
`unattributedSpeech` metric to absorb it, but it is a real, measurable
change on ALL books, not just dash-dense ones, and must be validated as such
— see Testing item 4's non-regression requirement on the wider library, not
only the dash-dense target chapter.

### Explicit residual (not closed by this design)

Two residuals, stated precisely rather than as one vague gap:

1. A run where every sentence's needle recurs within its own local window
   (e.g. an exchange of entirely duplicated one-word replies with nothing
   distinctive nearby) still resolves to unaligned rather than correct — this
   design trades a silent wrong match for an honest miss here, it does not
   make the sentence align correctly.
2. **The behind-cursor duplicate-anchor sub-case is not addressed at all** —
   a structural limitation of the monotonic-cursor architecture, not
   something this design's mechanism can reach. State this explicitly in the
   code (matching the file's existing "KNOWN RESIDUAL" comment pattern) — do
   not claim the duplicate-anchor gap is closed, only narrowed.

### Disposition of PR #2577

Rework the existing branch (`fix/server-2537-dash-invariant-align`) and PR
(#2577) in place. Replace the needle-construction and backward-extension
logic from all three prior commits outright per the corrected design above
— **[v2]** including `locateSentenceOffsets`'s existing (not merely
proposed) backward-extension block, whose `hadLeadingDash` gate must be
removed and whose needle construction must be fixed to match. The bookkeeping
commits (release notes, on-box register note) get amended once the real fix
lands and is validated — the on-box register note in particular currently
describes the rejected/no-op mechanisms and will need correcting to describe
whatever actually ships.

## Testing

**[v2 — added]** No criterion below may be satisfied by a near-no-op. In
particular, `alignedPct` (`aligner.ts:369`,
`aligned.filter(a => a.spans.length > 0).length`) **must not be used alone as
a correctness bar** — it *rises* on a false-positive match (a wrong but
non-empty span still counts as aligned) and is already near-saturated
(~98%) on low-dash-density chapters, so it cannot discriminate a real fix
from cosmetic noise. Use it only as a coarse sanity check, never as the sole
pass/fail signal.

1. **Invariance property test** (both functions, only for languages where
   the gate in "Language gating" is true): generate sentence pairs varying
   dash count (1, 2, 3+ leading glyphs), glyph choice
   (`-`/`–`/`—`/`&mdash;`/`&ndash;`), and spacing, assert byte-identical
   needles via the exported/testable needle-builder (not inferred from
   behavior). Assert the with-dash needle differs from naive
   `normalize(s.text)`. Include the empty-needle case (dash-only cached
   text) and assert it resolves to `null`, not a crash or a spurious match.
   Also assert that when the language gate is false, needle construction is
   byte-identical to `main`'s current (unconditional, no dash handling)
   behavior — this is the parity requirement from "Language gating" made
   concrete.
2. **Regression tests** for the attempt-1 repro (`"— Да."` vs. decoy
   `"правда"`) and the independent review's N4 decoy variant: **both must now
   resolve to `spans: []` (rejected as ambiguous), not to the wrong span, and
   not required to resolve to the *correct* span** — per the corrected
   mechanism above, precision is what's guaranteed here, not recall. State
   this explicitly in the test's own assertion and comment so it cannot be
   silently weakened later without the intent being visible. This also
   resolves the direct contradiction in v1 between three sections that each
   implied a different fate for this exact fixture.
3. **Anchor/window-uniqueness unit tests**: (a) a duplicated ≥24-char
   sentence, forward-duplicate shape, no longer silently mis-anchors — it is
   left for Pass B instead; (b) a short needle with a second occurrence
   *within* the local window resolves to unaligned; (c) a short needle whose
   only other occurrence is *outside* the local window still resolves
   normally (this is the case that protects `alignedPct` on legitimately
   repeated short dialogue spread across a long run — must be tested
   explicitly, not just asserted in prose).
4. **Real-data validation.** **[v2 — corrected]** `server/handoff/cache/mns_oyK7Po6BiT.json`
   and the real `Ночной дозор` manuscript live **only in the primary
   checkout's local workspace** (`C:\AudiobookWorkspace`), not in any git
   worktree, not in CI, and not in a fresh clone — by this repo's own
   definition (CLAUDE.md, "Behaviour only real hardware can prove") this
   *is* on-box acceptance work, not a PR-time automated gate, and v1 was
   wrong to describe it as bakeable into CI. Treat it as such:
   - The implementer runs the GPU-free replay recipe
     (`docs/features/247-dialogue-structure-attribution.md`) locally against
     **one chapter** (empirically confirm which of chapters 1/6/7/8 the E11
     register's per-chapter shifts show as most affected — do not guess),
     both straight and dash-stripped, and reports the result in the PR —
     this is manual, local, evidence attached to the PR body, not a CI step.
   - **The correctness instrument is a per-sentence span diff against
     `main`, not `alignedPct`.** For every sentence whose resolved span
     changes between `main` and this branch on the validation chapter, the
     change must be inspected and classified: newly-correct (was wrong or
     unaligned on `main`, now right), newly-ambiguous-rejected (was a false
     positive on `main`, now honestly unaligned — an improvement), or
     regressed (was correct on `main`, now wrong or unaligned — **any single
     instance of this blocks merge**). Report the counts of each category in
     the PR body.
   - This PR-level chapter replay does **not** discharge E11 item (2), which
     is a whole-library (23-book), whole-chapter `measure-attribution.mjs`
     double-run — a materially different, larger check. Update the E11
     register row to reflect that the fix has landed and been spot-validated
     on one chapter, but the row **stays open** until the full
     `measure-attribution.mjs` on-box re-run is actually performed and
     recorded, per the register's own existing discharge rule.
   - **Non-regression on the wider library**: because the Pass B
     ambiguity-rejection change (unlike pure needle-construction) can affect
     *any* book's alignment, not just dash-dense ones, the on-box re-run's
     existing "22/23 books remain byte-identical" check must be re-run and
     is expected to **still hold** (this design should not touch behavior on
     non-dash-dialogue-convention chapters at all, per the language gate) —
     call this out explicitly as an acceptance bar for whoever performs the
     eventual full on-box run, not something this PR alone can prove.
5. Existing `aligner.test.ts` / `scene-breaks.test.ts` suites (other than the
   two fixtures reworked per item 2) must stay green. Verify
   `locateSentenceOffsets`'s docstring claim of sharing `alignSentences`'
   semantics (fuzzy fallback excepted) actually holds — by construction
   (shared helper) or an explicit parity test.
6. **[v2 — added] Performance.** The uniqueness/window checks add real cost —
   measured (session benchmark, random Cyrillic haystack) at roughly
   16–100ms per 110-240kB chapter depending on candidate volume, comparable
   in magnitude to the file's own existing recorded worst-case locate cost
   (`aligner.ts:290-291`, "303ms vs 197ms"). This is not assumed negligible.
   Benchmark the actual implementation against the validation chapter and a
   representative low-dash-density chapter, and report both numbers in the
   PR body — if either exceeds roughly 2× the pre-fix baseline, flag it for
   a design follow-up rather than shipping silently.

## Out of scope

- Approach C (composite-needle localization for consecutive short dialogue
  blocks) — left as a follow-up if the residual above is hit often enough in
  practice to matter.
- Full Approach B (uniqueness-gated matching for every needle length
  everywhere, no local-window scoping) — broader blast radius than the
  corrected mechanism above; not pursued.
- Fixing the model's own stochastic dash-dropping at the source — this
  design makes the aligner tolerant of the inconsistency, it does not
  prevent it.
- `cross-examine.ts:225`'s direct read of the cached sentence text's leading
  dash (`opts.dialogueOpen.test(as.sentence.text ?? '')`) — a separate
  consumer of the same upstream instability, outside the aligner, whose
  behavior still varies with cache form after this design ships. Worth its
  own follow-up issue; not folded in here to keep this change reviewable.
- Behind-cursor duplicate-anchor resolution (see residual) — would need a
  non-monotonic or lookback-capable matching scheme, a materially larger
  change than this design's scope.
