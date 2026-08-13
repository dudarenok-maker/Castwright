# Quote-delimiter validity in `findQuoteRuns` — design

Status: proposed · Issue: [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) · Blocks: [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) / [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279)

> **Revision 4.** Revision 3 (below) specified the resumed-skip bound as
> **computed once per accepted opener occurrence, anchored at the opening
> quote's interior start.** That rule is safe on both known-bug fixtures but
> is stricter than it needs to be: an opener sitting *inside* the turn — a
> legitimately nested one, e.g. the `“` in `‘He said “yes,” but I don’t
> believe him,’` — caps the search exactly as if it were a different turn's
> opener, so the rejected `don’t` apostrophe falls straight through to the
> never-delete fallback and the standard British shape (a single-quoted turn
> nesting a double-quoted one) never repairs; it comes out byte-identical to
> `main`'s truncation. **The bound now anchors at the REJECTED closer's own
> index and is recomputed at every rejection**, not computed once at the
> interior start — see "The bound on the resumed skip" below for the full
> rule and why anchoring later is still provably safe. This is a **narrower**
> claim than revision 3's, not a stronger one: it only ever lets the search
> pass an opener the rejection point has already moved past, and it is what
> the British-shape repair actually needs. Re-measured over the same 140-book
> English corpus: clean repairs rise from 936 under revision 3's originally
> specified (interior-start-anchored) rule to **938** under the rejection
> anchor that actually ships — see "Result — the merge axis" for the
> three-way comparison (unbounded 935 / bound at the opener 936 / bound at
> the rejection 938) and the PR body for the as-measured figures.
>
> A second, independent review finding this revision: the per-glyph `limit`
> only bounds a resumed skip within the SAME closer glyph's own scan. When an
> opener pairs with several closers (German's `„` → `“`/`”`/`"` is the one
> shipped example) and only some are apostrophe-shaped, a sibling closer's
> un-rejected FIRST occurrence — first occurrences are never bounded, by
> design — can still win the opener occurrence's `end` past a bound a
> *different* closer's rejection established, because that bound was scoped
> to the rejected glyph's own scan, not to the opener occurrence as a whole.
> The fix makes the bound a property of the **opener occurrence**: once any
> closer has been rejected for it, the finally-chosen `end` — from whichever
> glyph — must clear the bound from the *earliest* such rejection, or the
> never-delete fallback applies. **No shipped table has this shape** — German's
> `„` closer set has no apostrophe-shaped member — so this is FORWARD-COVER,
> not a live fix: it changes nothing on any measurement in this document. It
> matters once `#2286` pairs `‘`/`’` alongside another closer on one opener,
> which is exactly the shape this precondition names. See "The bound on the
> resumed skip" for the mechanism and the code's own doc comment
> (`parser.ts`, above `nearestOpenerAtOrAfter`) for the synthetic
> counter-example (`quotePairs = [['«','’'], ['«','»'], ['“','”']]`) that
> demonstrates the gap and its fix.
>
> Revision 3's banner, evidence, and rejected alternatives are kept below
> unchanged except where this revision's two findings require a correction —
> each such place is marked. Nothing else in revision 3 moved: the clause,
> the never-delete invariant, and the truncation-repair axis (949 repaired)
> are all unaffected by either finding.

> **Revision 3.** Revision 2 shipped clause D (an apostrophe-shaped glyph
> inside a word is not a closer) plus the never-delete-a-run invariant. An
> independent review of that PR found a **Critical**: when a closer was
> rejected, the scan kept looking for a *later* occurrence of the same glyph
> with no stop condition. A stray `’` sitting between two turns could walk the
> search straight through an intervening turn and land on a closer several
> turns away, merging everything in between: `Tom said the ‘phone wasn’t
> working. “I agree,” said Mary. It was the boys’ fault.` rejected the
> apostrophe in `wasn’t`, kept hunting, and swallowed Mary's whole turn on the
> way to `boys’`.
>
> Both measuring instruments in revision 2 missed this. The corpus metric
> defined harm as text containment, and a run that swallows several turns
> *contains* all of them — so `LOST = 0` and the merge scored as a `REPAIRED`
> win. The generated sweep could not generate the failure at all: `gap` (a
> stray delimiter between turns) and `apostrophes` (a contraction inside a
> turn) were separate families, and the failure needs both at once — a
> rejected apostrophe *and* a gap-seeded turn boundary downstream of it — which
> is their cross-product, not either family alone.
>
> The fix is a **bound on the resumed skip**: once a closer is rejected, the
> search for a later occurrence of the same glyph stops at the next opener
> glyph of *any* class. A closer's first occurrence is never bounded, which is
> what keeps nesting correct without leaning on the never-delete fallback.
> Rebuilding the corpus metric around this bug (containment scoring can't see
> a merge; an overlap-based classifier can) found the unbounded rule merging
> **8 paragraphs / 18 turns** — six of which the old metric's own "949
> repaired" headline had silently counted as wins. The bound brings both to
> zero. Two more restrictive bounds (stop at the next sentence break; cap the
> growth in characters) and one widening (treat a dash like whitespace in the
> elision clause, to close a residual under-repair) were measured against this
> corrected instrument and rejected. All are kept below with their evidence,
> because that evidence is what stops them being re-proposed.

## The problem

`#2288` was filed as "the engine blocks widening the `quotePairs` tables."
That framing hid the more important half.

**The defect is live on `main`, in English, at default settings.** `en.ts`
already ships `['‘','’']`, and single-quoted material is closed by the first
`’` — which in English is usually an apostrophe. Through the real
`parseChapterStructure`:

```
‘I don’t know,’ she said.                → speech: ["I don"]
‘We can’t go back,’ said Mary. ‘It isn’t safe.’
                                         → speech: ["We can", "It isn"]
‘Hello,’ he said. ‘Goodbye,’ she said.   → speech: ["Hello,", "Goodbye,"]   ✓ control
“I don’t know,” she said.                → speech: ["I don’t know,"]        ✓ control
```

`en.ts` excludes the *straight* single pair `['\'','\'']` for exactly this
reason; the rationale is recorded in
`docs/features/162-fs2-multilanguage.md:117`. It was never applied to the
smart pair. Reachability is not in question:
`analyzer.structure.enabled` defaults `true`
(`server/src/config/registry.ts:1273`) and `server/src/routes/analysis.ts:2177`
calls `parseChapterStructure` on the live path.

**Measured prevalence:** across 331 real books, `main` places a run delimiter
inside a word in **1,126 paragraphs** — 1,066 of them English. In the wild the
shape is single-quoted quotation *inside narration* (`… said, ‘Shan’t be a
minute.’`), not whole-book British convention; see "What the corpus cannot
say" below.

## Two mechanisms, not one

**M1 — an invalid delimiter is accepted.** An apostrophe is taken as a closing
quote. The evidence is local to the glyph and its neighbours. This is all
measured real-world damage, and it is live today.

**M2 — a gap-seeded run straddles the next turn.** A candidate seeded between
two turns runs to a closer at or past the next turn's opener; the genuine turn
is discarded for overlapping it. This needs drifted or mixed glyph sets, so in
practice it is a *widening* problem. **It is not addressed here** — see
"Rejected".

*(The Critical bug this revision fixes is a related but distinct failure: not
a gap-seeded candidate straddling a turn, but a **real** candidate's resumed
skip — a mechanism M1's own fix introduced — straddling one. Fixing it does
not touch M2, and M2's status is unchanged: #2286 stays blocked.)*

## The rule

**One clause, plus one invariant, plus one bound on the clause's own resumed
skip. Applied at candidate construction. The leftmost-wins acceptance loop is
not touched.**

**D — an apostrophe-shaped glyph inside a word is not a closer.** A `’` or `'`
is rejected as a closer when any of:

1. it has a cased letter on both sides — `O’Brien`, `don’t`, `l’homme`;
2. it is preceded by whitespace, `(`, `[` or `{` and followed by a cased
   letter — `’em`, `’cause`, `’tis`, `’alf`. A real closing quote is never
   preceded by whitespace: it closes onto the last character of the speech it
   terminates;
3. it is preceded by an **opener glyph of the same table** and followed by a
   cased letter — `‘’Tis nothing,’`, the turn-initial dialect elision.
   Accepting it closes the run on an empty interior, which produces no speech
   span at all: the turn is destroyed rather than truncated.

"Cased" means `\p{L}` plus `\p{M}` (so an NFD-decomposed base letter + combining
mark still counts as one letter) minus `Han`, `Hiragana`, `Katakana`, `Thai`.
Hangul is deliberately **not** excluded: modern Korean uses inter-word spacing
like English, so a `’` with Hangul on both sides is the mis-read-apostrophe
shape clause 1 exists to catch, not ordinary unspaced text.

**That exclusion is forward-cover, not live protection, and the difference is
worth stating precisely.** `en` is the only shipped table that pairs an
apostrophe-shaped glyph as a *closer*, so on today's tables the predicate never
reaches the script test at all: removing the exclusion entirely leaves all
725,066 corpus paragraphs byte-identical, and zh's `“他说‘你好’然后走了”` parses
correctly either way because its inner `’` is not a closer candidate. The
exclusion exists because **#2286 adds `['‘','’']` to `zh` and `ru`**, at which
point `好’然` becomes exactly the both-sides shape the first clause rejects. It
is deliberate defence for a table that is coming, and no test can currently
make it fail — which is why the zh test below is labelled a nesting
characterisation rather than coverage of this rule.

Scripts with no case and no table (Arabic, Hebrew, Devanagari) are unreachable
today; the implementation must not silently assume otherwise.

### The bound on the resumed skip

Rejecting a closer under clause D does not delete the opener's chance of being
matched — the scan resumes, looking for a *later* occurrence of the same
closer glyph. Left unbounded, that resumed search has no reason to stop at a
turn boundary, and clause D itself is what creates the first rejected
occurrence for it to resume past. This is the Critical review finding: a real
opener, rejecting a real (apostrophe-shaped) closer under clause D, wanders
forward through however many turns it takes to find *any* later occurrence of
that glyph — accepting one three turns away is no different, mechanically,
from accepting one three characters away.

**The bound: a resumed skip may not cross the nearest following opener glyph
of any class, anchored at the point of REJECTION and recomputed at every
further rejection.** *(Revision 4 correction: revision 3 originally specified
this bound as computed once per accepted opener occurrence, anchored at the
opening quote's interior start. That rule is not what ships — see the
revision-4 banner above for why the anchor moved.)* A closer's **first**
occurrence at any position is tested by clause D exactly as before, unbounded;
only a **later** occurrence of the same glyph, reached because an earlier one
was rejected, is bounded. Concretely: at the point a closer occurrence is
rejected — index `k` — compute the position of the nearest following opener
glyph in the table (its own class included), call it `limit`, and refuse the
next occurrence of the same glyph once its position is `>= limit`. If that
next occurrence is also rejected, `limit` is recomputed from ITS index, not
narrowed from the previous one — though this can never move `limit` earlier
than the search has already reached: the next occurrence of the glyph, if any,
lies in `[k, limit)`, which by construction contains no opener, so recomputing
from a point inside that range returns the identical `limit`.

**Anchoring at the rejection rather than at the opening quote's interior start
is what lets a legitimately nested opener stay inside the same turn.** An
opener sitting *inside* the turn — e.g. the `“` in `‘He said “yes,” but I
don’t believe him,’` — must not cap the search; only an opener strictly after
the point the scan is still hunting from can belong to a *different* turn. The
interior-start anchor cannot tell these apart (it caps at the FIRST opener
after the turn's start, nested or not); the rejection anchor can, because by
the time a rejection happens the scan has necessarily moved past any opener
that legitimately nests inside the turn up to that point.

**Precondition this bound does not by itself cover: an opener paired with
SEVERAL closers, only some apostrophe-shaped.** The argument above is
per-glyph — it bounds the resumed scan for the one closer glyph that
rejected, and says nothing about a *different* closer glyph paired with the
same opener. Because the finally-accepted `end` is a minimum taken across
every closer in the opener's set, an unrejected SIBLING closer's first
occurrence — never bounded, by the rule above — can still win `end` past a
bound a *different* closer's rejection established. The fix scopes the bound
to the OPENER OCCURRENCE rather than to one glyph's scan: once any closer has
been rejected for this opener occurrence, the finally-chosen `end` must clear
the bound from the *earliest* such rejection (by the monotonicity argument
above, the earliest rejection always yields the tightest bound), regardless of
which glyph `end` came from, or the never-delete fallback applies instead.
**No shipped table has this shape** — German's `„` is the only shipped opener
with several closers (`“`/`”`/`"`), and none of them is apostrophe-shaped —
so this is FORWARD-COVER, not a live fix, exercised only by a synthetic table
(`quotePairs = [['«','’'], ['«','»'], ['“','”']]`; see `parser.ts`'s doc
comment above `nearestOpenerAtOrAfter`), never by any corpus or sweep number
in this document. It matters once `#2286` pairs `‘`/`’` alongside another
closer on the same opener.

**Never bounding the first occurrence is what keeps nesting correct without
depending on the never-delete fallback.** `“He said ‘hi’ to me,”` has its outer
`”` positioned past the inner `‘`, i.e. past an opener — if first occurrences
were bounded the same way, this ordinary nesting case would only work by
accident of the fallback, not by the ordinary accept path. Bounding only the
*resumed* search leaves it untouched.

Both known-bug fixtures from the review, reproduced and fixed by the bound:

```
Tom said the ‘phone wasn’t working. “I agree,” said Mary. It was the boys’ fault.
  unbounded  ["phone wasn’t working. “I agree,” said Mary. It was the boys"]   ← Mary's turn destroyed
  bounded    ["phone wasn", "I agree,"]                                        ← identical to main

‘Yes’said Tom. “No,” said Mary. ‘Maybe,’ said Tom.
  unbounded  ["Yes’said Tom. “No,” said Mary. ‘Maybe,"]                        ← three turns merged into one
  bounded    ["Yes", "No,", "Maybe,"]                                          ← identical to main
```

Two tighter bounds (stop at the next sentence break; cap the growth in
characters) and one widening of clause D's elision test (treat a dash like
whitespace, to also close a residual under-repair) were measured against the
rebuilt corpus instrument and rejected — see "Bounding the resumed skip: what
else was tried" under Evidence, and "Rejected" for the full numbers.

**The invariant — a rule may move a run boundary, never delete a run.** If
rejecting closers leaves an opener with *no* valid closer at all — including
after the bound removes an otherwise-later one — fall back to the nearest
closer of any kind, i.e. exactly what `main` would have chosen. The fallback
itself is unaffected by the bound: it always resolves to a closer's first
occurrence, which is never bounded.

This invariant is not a refinement; it is what makes the clause safe. Without
it, D deletes **90 paragraphs' worth of speech** on the corpus, 74 of them
losing every turn — turning dialogue into narration, which is the same harm
class #2288 exists to fix.

A real corpus paragraph (`se/anne-parrish_the-perennial-bachelor.epub`), an
inner quotation whose only `’` is the contraction:

```
“ ‘Shoo fly! Don’t bother me!
   main            ["Shoo fly! Don"]     truncated
   D, no fallback  []                    ← ALL speech gone; the turn is narration
   D + fallback    ["Shoo fly! Don"]     no better than main, and no worse
```

Note what the fallback buys: not a repair, a **floor**. Where no valid closer
exists the output is exactly `main`'s. That is the whole point — the clause is
allowed to improve a paragraph or leave it alone, never to degrade it.

### Why acceptance is not touched

Every rule that changed *acceptance* destroyed nesting:

| rule | generated shapes | real paragraphs |
|---|---|---|
| role-based two-phase (option A) | −96 | 0 |
| shortest-first (option B) | −374 | −501 |
| per-paragraph convention election (option 2) | −254 | −161 |

The election rule fails for a reason that condemns the variant broadly: an
outer turn containing several inner quotations always loses, because counting
candidates favours the inner class. `“ ‘Oh, ’im?’ she says. ‘ ’E’s the cook’s
brother,’ she says. …”` collapses from one turn into five fragments.

**Note what this does *not* retire.** The evidence kills *count-based*
election. A length-weighted election returns the correct reading on that same
example and on the nesting family. It is untested at scale and is not proposed
here, but "option 2 is dead" would be an overclaim.

### Nesting is preserved, but it is NOT structural

Revision 1 asserted "leftmost-wins resolves nesting, therefore nesting is
structurally safe." That is false, and worth stating explicitly so no future
change re-derives it wrongly: leftmost-wins picks the outer run **only if the
outer candidate exists**. Deleting a candidate at construction time promotes
the inner run to top level:

```
‘He said “hi” to O’Brien.     main ["He said “hi” to O"]   D without fallback ["hi"]
X"He said “hi” to me."        main ["He said “hi” to me."] with opener rejection ["hi"]
```

Nesting survives **because of** the never-delete-a-run invariant, not because
the acceptance loop is untouched. Disjointness *is* structural; outer-wins is
not. The resumed-skip bound adds nothing to this argument and takes nothing
from it: it only ever narrows which *later* occurrence a rejected closer can
resume onto, and a closer's first occurrence — the one nesting depends on — is
never in its scope.

## Invariants preserved

- **Runs stay disjoint** — acceptance unchanged (`parser.ts:389-397`'s
  leftmost-wins cursor loop slices sequentially).
- **Nesting resolves to the OUTER run** in `en`, `zh`, `de` — contingent, per
  above; pinned by the sweep's `nest` family at both table sets.
- **#1601 stays fixed.** A `„` run still ends at the NEAREST of its closers.
  No clause can fire on `de`'s table at all (its closers `“ ” " «` are not
  apostrophe-shaped), so this is untouched by construction.
- **`dialogueOpen` / `crossExamine` untouched.**
- **A resumed skip cannot cross into a different turn.** New this revision: a
  rejected closer's search for a later occurrence of the same glyph is bounded
  to the nearest following opener glyph of any class, so it can move a run's
  end later within the same turn but can never reach past the next one.

## Evidence

### Corpus

331 public-domain books: **100 Standard Ebooks** (English, modern typesetting,
ingested through the product's own `parseEpub`) + **231 Project Gutenberg**
across `de/en/es/fr/ja/ru/zh`. 725,066 paragraphs, 238,601 carrying a quote
run. This is the corpus behind "The problem"'s prevalence figures and the
per-language truncation table below, and it is unchanged from revision 2.

**A second, narrower measurement was built this revision specifically to find
and bound the Critical review finding.** It reuses the same book set's English
arm — 140 books (100 Standard Ebooks + 40 Project Gutenberg `en`), 389,020
paragraphs, 174,267 carrying a quote run on either side — because English is
the only shipped table where clause D's apostrophe rejection is reachable at
all (see "That exclusion is forward-cover" above). It is scoped to English
because that is where the bug lives, not as a narrowing of the claim: nothing
here bears on `de`/`zh`/`es`/`fr`/`ja`/`ru`, which the original corpus already
covers.

### Control, before any result

The harness reimplements `findQuoteRuns` so a rule can be swapped without
editing the parser. It was verified against the **real** `parseChapterStructure`
first — **499,113 paragraphs, 0 mismatches** — over the four languages whose
`dialogueOpen` is `null`, on dash-free paragraphs, where a run maps 1:1 to a
speech span. Independently re-run with the restrictions relaxed: removing the
length cap gives 502,411 / 0; *including* dash paragraphs gives 544,711 / 239,
and all 239 are `parseDialogueSpans` splitting a run interior at an interior
dash-tag — the run→span mapping, not `findQuoteRuns`. The restriction is
necessary and hides no divergence.

Positive control: the sample contains **364 damaged paragraphs** under the
metric used in the results below (315 English), so the equivalence is not
proven over trivial text.

> Revision 1 quoted 27,661 here. That figure omitted the CJK subtraction the
> results table applies, so 27,037 zh and 267 ja paragraphs were counted as
> damaged for having an ideograph after a closer — normal spacing. Both
> numbers are real; only one is the document's metric. One definition is used
> throughout revision 2 and this one.

### Metric

Ground truth does not exist for real books, so each changed paragraph is
classified against `main`'s own output. Two metrics have now been used, and
the second replaces the first because the first has a proven blind spot.

**The original metric (containment, revision 1/2) asked "is each baseline
run's text contained in some candidate run".** That is structurally blind to
merging: a candidate run that swallows several baseline runs *contains* all of
them, so `LOST = 0` — and since the swallowing run's final boundary carried no
intra-word delimiter, the paragraph then scored `REPAIRED`. A destroyed
dialogue turn was counted as a win. This is exactly how revision 2's "949
repaired / 0 lost" missed the Critical bug: six of the eight paragraphs the
unbounded rule merges sit inside that same 949.

**The replacement metric (overlap, this revision) abandons containment.** Two
runs correspond iff their intervals overlap (half-open; touching is not
overlapping), and the class is read off the degrees of the resulting overlap
bipartite graph:

| degree | class |
|---|---|
| baseline run overlaps 0 candidates | `LOST` |
| candidate run overlaps 0 baselines | `GAINED` |
| candidate run overlaps ≥2 baselines | `MERGED` |
| baseline run overlaps ≥2 candidates | `SPLIT` |
| all degrees exactly 1, boundaries differ | `MOVED` |
| identical boundaries | `SAME` |

All applicable classes are returned as a set — nothing collapses to a winner —
so a repair can no longer mask a merge. A `repairedBoundary` flag (a baseline
run whose closing delimiter had an alphanumeric on both sides, whose
counterpart's does not) is reported *alongside* the class set, never instead of
it. 9 positive controls pass under exact set equality, including one built
specifically to be the case the old metric passed silently (a three-turn merge
that also repairs an intra-word boundary — old metric: 0 losses, `REPAIRED`;
new metric: `MERGED`, `repairedBoundary: true`, correctly not masked). Both
known-bug fixtures reproduce as `MERGED` under this instrument, confirming it
sees the bug the old one missed.

**Known blind spot carried over from revision 2, stated because it still
bounds every truncation number below:** the intra-word signature fires only on
a cased letter *immediately outside* a delimiter. A truncation whose bogus
closer is followed by a space — the possessive-plural class, `‘It was the
boys’ fault,’` → `["It was the boys"]` — is invisible to it, and lands in no
bucket. `main` and clause D fail it identically; it is pinned as a known limit
in the test suite, not fixed by this design.

### Result — the truncation-repair axis (revision 2, unchanged by the bound)

| | changed | REPAIRED | LOST | of which all speech gone | MOVED |
|---|---|---|---|---|---|
| D without the invariant | 1,036 | 949 | **86** | 74 | 1 |
| revision 1's three clauses | 1,040 | 949 | **90** | 74 | 1 |
| **D + never-delete invariant** | **950** | **949** | **0** | **0** | **1** |

Identical on `main`'s tables and on #2286's widened tables. Residual damaged
paragraphs **1,126 → 177**.

| lang | paragraphs | with runs | `main` damaged | after D | changed |
|---|---|---|---|---|---|
| en | 388,789 | 174,089 | 1,066 | 117 | 950 |
| de | 63,688 | 23,480 | 44 | 44 | 0 |
| zh | 92,598 | 29,901 | 1 | 1 | 0 |
| es/fr/ja/ru | 179,991 | 11,131 | 15 | 15 | 0 |

**The rule repairs English and touches nothing else.** German's 44 are the
largest remaining slice and no clause here can reach them: they are `»…«`
emphasis glued to words (`Woher aber der Name »Frühstücks«schiff?`). The
zh/ja residuals are fullwidth-Latin and title-marker artifacts.

This axis — does clause D repair an intra-word truncation without losing a
run — is what the containment metric can measure correctly, and the bound
changes nothing on it: the bound only ever affects a resumed skip, and a
paragraph counted here either never rejected a closer or found its accepted
closer before any bound could apply.

### Result — the merge axis (what the containment metric could not see)

Same English 140-book corpus (174,267 paragraphs with runs on either side),
scored by the overlap classifier, across three variants: no bound; the bound
computed once at the opener's interior start (revision 3's originally
specified rule, never shipped); and the bound anchored at each rejection,
recomputed per rejection (**shipped**, revision 4):

| | unbounded (D + invariant, no bound) | bound at the opener (interior start) | **bound at the rejection (shipped)** |
|---|---:|---:|---:|
| `MERGED` paragraphs | **8** | **0** | **0** |
| baseline turns swallowed | **18** | **0** | **0** |
| `repairedBoundary` | 943 | 936 | **938** |
| — of which also `MERGED` | 8 | 0 | 0 |
| **clean repairs** | 935 | 936 | **938** |
| repair shapes fixed (the 5 canonical cases) | 5/5 | 5/5 | 5/5 |
| British nesting shape (turn nesting a different-quote turn) repaired | — | no | **yes** |
| known-bug fixtures identical to `main` | 0/2 | 2/2 | **2/2** |

**Six of the eight unbounded merges sit inside revision 2's own "949 repaired"
headline** — the old metric counted them as wins because containment cannot
see a swallow. The other two are in paragraphs longer than 4,000 characters,
which the old harness's length cap skipped outright; it never saw them at all.
Both bounded variants eliminate all eight: at the opener anchor, a net
**gain** of one clean repair over unbounded (935 → 936) — three of the eight
formerly-merged paragraphs resolve to a correct repair once the bound stops
the over-run at the right place; the other five revert to `main`'s original
truncation, not fixed but not worse than before clause D existed either.

**The rejection anchor adds two further clean repairs over the opener anchor
(936 → 938).** The two bounded variants are otherwise identical on this axis —
same zero merges, same 5/5 canonical repair shapes, same known-bug fixtures —
and diverge only on paragraphs where the turn legitimately nests a
different-quote-style inner turn: the opener anchor caps the resumed search at
that inner opener (treating it exactly like a different turn's boundary) and
falls back to `main`'s truncation, where the rejection anchor lets the search
pass it and land on the turn's real closer. See "The bound on the resumed
skip" above for the mechanism and why passing a legitimately-nested opener is
still provably safe.

### Bounding the resumed skip: what else was tried

The bound that shipped stops a resumed skip at the next opener glyph of *any*
class in the table, anchored at the rejection (`B_opener` in the measurement
scripts named the STOP CONDITION — next opener of any class — not the anchor;
the anchor-point correction is this revision's own finding, above, and these
alternatives were evaluated against that stop condition regardless of which
anchor was live when each was measured). Two more restrictive bounds and one
widening were built and scored against the same corpus and are not shipped:

- **A sentence-boundary bound** (stop at `/[.!?]\s/`) looked safer on paper —
  it leaves only 267 `OVERRUN` paragraphs (a `>22`-character-growth flag used
  to triage candidates for hand review) against the opener bound's 713 — but
  costs **47 unambiguously genuine repairs** (small, unarguable growth) because
  `Mr. `, `Dr. `, and `St. ` are false sentence breaks: the limit lands before
  a turn's real closer purely because of an abbreviation, and the rule can only
  ever *lose* a repair from this, never gain a merge. Its total reverted count
  is 472 of 713 candidate paragraphs; a hand-adjudication (below) later showed
  the underlying 713 contain no actual harm, which means everything past the
  47 unambiguous cases that this bound "protects against" was never a bug to
  begin with.
- **A raw growth cap** (revert if a pair's growth exceeds N characters) reverts
  138 repairs at a 200-character cap alone, for **zero measured harm
  prevented**: a stratified hand-adjudication of 156 of the 713
  `>22`-character-growth paragraphs — a full census of the top growth decile
  (74 paragraphs, including the single largest, 1,407 characters) plus a
  seeded random sample of the rest, plus every paragraph flagged by two
  independent automated hunts for the failure shape — found **zero** cases
  where the extra text was anything but genuine speech. A follow-up exhaustive
  audit of all **1,264** rejected-closer sites inside those 713 paragraphs
  found no genuine closing quote among them at all — the mechanism a cap would
  be defending against does not occur in this corpus. **The corpus's single
  largest over-run (1,407 characters, a Sherlock Holmes monologue `main` had
  amputated after four characters) is its single largest repair.** A cap is a
  pure-cost knob on this evidence.
- **Widening clause D's elision test to treat a dash like whitespace**
  (`—’pon`, `–’tis` read the same as `’em`) is not a bound but a widening,
  tried to close a residual under-repair the opener bound leaves (below). It
  is corpus-identical to the shipped rule apart from repairing that one
  paragraph, but a synthetic interrupted-turn probe
  (`‘I only meant—’Ah, never mind,’ he broke off.`) reproduces, through a
  dash-preceded glued closer, the exact narration-swallowing mechanism the
  bound exists to prevent — and well-typeset public-domain prose systematically
  lacks the missing-space-after-closer defect that would ever exercise the new
  branch, so a corpus zero here proves nothing. Rejected; see "Rejected" for
  the full evidence.

**What the opener bound leaves unfixed:** the same 156-paragraph adjudication
found six paragraphs — one dash-preceded (`jail—’pon`), five dialect-final
(`harmonizin’`, `pitchin’`, `question o’`, `a dam’`, `bes’`) — where the new
boundary lands *early*, one apostrophe short of the turn's real end. All six
are strictly better than `main` (still speech, never narration, never a lost
turn) and are pinned as known limits in the test suite rather than fixed; the
dash-widening above was the one candidate fix for the dash case, and it was
rejected.

### Generated sweep

**2,170 distinct shapes (2,408 scorings — `de` and `ru` duplicate because
several pairs share an opener), six families**, at both table sets, each with
intended turns known by construction:

`gap` (a stray delimiter between turns) · `apostrophes` (contractions inside
turns) · `nest` (an outer turn containing 1–3 inner quotes) · `units` (an inch
mark) · **`british`** (single-quote dialogue with contractions, elisions,
possessives, apostrophe names, turn-initial `‘’Tis`).

**D + invariant: +161 repaired / −0 regressed.** Zero regressions in every
family at both table sets, including all six `nest` arms.

> Two families exist because earlier revisions of this sweep could not test the
> rule they were meant to gate. v1 had only `gap`, so it never generated an
> apostrophe inside a quoted turn and scored the apostrophe rule `+0/−0` —
> which reads as "safe" and meant "never exercised". v2 added `apostrophes`
> but still never generated a whitespace-preceded apostrophe, so the elision
> clause was equally unexercised. `british` closes both, and is the only
> coverage the target convention has at all.
>
> **`gap` and `apostrophes` remaining separate families is also why this sweep
> could not have caught the Critical bug.** The failure needs a rejected
> apostrophe *and* a gap-seeded downstream turn in the same paragraph — their
> cross-product, which no family in this sweep generates. This is stated
> plainly in "What the corpus cannot say" below, because it is a gap in the
> sweep's coverage, not only the corpus's.

### What the corpus cannot say

**Zero of the 140 English books use single-quote dialogue as their convention.**
Standard Ebooks normalises to the American convention; Gutenberg plain text is
largely ASCII (the French arm carries 165,061 straight `'` against 71,172
curly `’`). Every one of the 949 repairs is a *nested or narration-embedded*
single-quoted passage inside a double-quoted book.

So the corpus bounds the regression rate for double-quote-convention books —
which is the overwhelming majority of what users will feed the product — and
says **nothing** about the regression rate for a whole-book single-quote
manuscript. That class is covered only by the `british` sweep family, which is
hand-authored and therefore weaker evidence.

**Three further gaps, surfaced by the Critical finding and worth stating with
equal weight, because this document already once claimed "0 lost" on the
strength of a corpus that did not see the counter-example:**

1. **The old containment metric could not see a merge, by construction — not
   as a rare miss, but as a structural blind spot.** A candidate that swallows
   several baseline runs *contains* all of them, so `LOST = 0` and the merge
   itself scored as a repair. Six of the eight paragraphs the unbounded rule
   actually merges were sitting inside the "949 repaired" figure this document
   published in revision 2. A metric that cannot represent a failure mode
   cannot report its absence, however clean the printed numbers look.
2. **The generated sweep could not generate the failure either, for a
   structural reason of its own.** `gap` and `apostrophes` were, and remain,
   separate families; the Critical bug is their cross-product — a rejected
   apostrophe *and* a gap-seeded downstream turn in the same paragraph. No
   single-family sweep, however large, was ever going to hit a two-family
   interaction. "+161/−0, zero regressions" was a true statement about the
   families that existed, not a general safety claim.
3. **Neither known-bug string appears anywhere in either corpus, despite both
   being ordinary English.** `‘phone wasn’t working` and `‘Yes’said Tom` are
   the kind of typesetting a bad OCR pass or a hand-made EPUB produces
   constantly — a missing space after a closing quote — and 331 carefully
   typeset public-domain books contain neither. So every corpus-zero in this
   document — `LOST`/`GAINED`/`SPLIT` at 0, and now `MERGED` at 0 under the
   bound — is a fact about well-typeset input, not a bound on a user's own,
   possibly much worse-typeset, book. The instrument was rebuilt to see a
   class of harm it previously could not; that does not mean it can now see
   every class, on every corpus, that a user's manuscript could contain.

## Rejected

**`G` — a unit mark or possessive is not an opener.** Rejected outright.
On the shipped tables it changes 4 paragraphs, repairs **0**, and loses 4:
`he said"hello" and left.` → no speech; `он сказал"Привет" и ушёл.` → no
speech. A missing space after a speech verb is a routine OCR artifact. Narrowed
to digit-preceded openers only, it changes **0** paragraphs on the shipped
tables. Its only real benefit is French arc-second marks (`55' 30"`) on tables
#2286 would add, so it can be reconsidered with the widening.

**`H` — drop a candidate that shares its closer with a nested candidate.**
Rejected as unreachable. Two candidates can share an `end` only if they share a
closer *position*; all closers are one code unit, so that means the same glyph
— i.e. one closer glyph belonging to two opener classes. Enumerated over both
table sets, the only table with a shared closer glyph is `wide/de`, which is
excluded permanently. **H changes 0 of 725,066 corpus paragraphs on both table
sets.** Revision 1 claimed it "measures clean everywhere and reduces #2286 to a
pure table change"; 0/0 on the shipped tables is a theorem, not a measurement,
and it does not fix the `en`+`«»` case either.

**`B_sentence` — bound the resumed skip at the next sentence break instead of
the next opener.** Rejected. `/[.!?]\s/`, limit = the index of the trailing
whitespace (requiring the whitespace is load-bearing: without it a turn's own
final full stop, e.g. `wait.”`, would bound its own closer, since the
punctuation there is immediately followed by the closer). Destroys **47
unambiguously genuine, small-growth repairs** on the shipped English corpus
because `Mr.`/`Dr.`/`St.` are false sentence breaks — the limit lands earlier
than the turn's real closer purely on an abbreviation, and the effect is
one-directional: it can only lose a repair, never gain a merge. 472 of 713
candidate paragraphs revert in total; the later hand-adjudication (see
"Bounding the resumed skip: what else was tried" and #2 below) showed the
`OVERRUN` population this bound was trying to protect against contains no
actual harm, so what it buys beyond the unambiguous 47 is nothing.

**A raw growth cap on the resumed skip (revert past N characters).** Rejected.
At a 200-character cap, 138 of 713 candidate repairs revert for **zero**
measured harm prevented: a 156-paragraph stratified hand-adjudication (a
census of the top growth decile including the 1,407-character maximum, a
seeded random sample of the rest, and every paragraph two independent
automated hunts flagged as structurally capable of the harm shape) found
**zero** harmful paragraphs, and a complete audit of all **1,264**
rejected-closer sites inside the 713 flagged paragraphs found **no genuine
closing quote among them** — the mechanism a cap exists to stop does not occur
in this corpus at all. The corpus's single largest over-run is also its single
largest repair. A cap on this evidence is a pure cost with no offsetting
benefit.

**Widen clause D's elision test to treat a dash like whitespace.** Rejected.
Corpus-identical to the shipped rule apart from repairing one residual
under-repair (`‘It’s like being in jail—’pon my word…’`, where the shipped
rule stops early at `’pon`'s dash-preceded apostrophe). A synthetic probe —
`‘I only meant—’Ah, never mind,’ he broke off.` — reproduces real harm through
the identical mechanism: the widened clause rejects a genuinely closed,
dash-preceded `’` as an elision opener, and the resumed search (still bounded,
but now bounded at the *wrong* place because the true closer was itself
rejected) swallows the narration past it. Well-typeset public-domain prose
systematically lacks the missing-space-after-a-genuine-closer defect that
would ever exercise the new rejection branch, so a corpus reading of "zero
regressions" here proves nothing — the same caveat this document already
states about the existing rule applies with equal or greater force to a *new*
rejection branch added on top of it. The six residual under-repairs (the
dash-preceded one included) are pinned as known limits in the test suite
instead.

**M2 generally.** No rule proposed here addresses the gap-seeded straddle, so
**#2286 stays blocked** and this design does not unblock it. `de` gains no
opener regardless: it already carries `['»','«']`, and adding the Swiss
`['«','»']` makes both glyphs bidirectionally ambiguous.

## Scope

**One clause, one bound, one PR, no table changes.** `#2288` stays the ticket
for this work, reframed around the live defect. The bound is part of the same
change, not a follow-up: it closes a failure mode the clause itself introduced,
found before merge by independent review, on the same corpus and with no table
changes of its own.

The owner previously approved a three-clause PR on revision 1's evidence. That
evidence was wrong: `G` is a regression on the shipped tables and `H` is
unreachable code. Shipping either would add untested surface with no measured
benefit, so both are dropped and this is reported rather than re-asked.

## Test plan

Unit tests on the `parseChapterStructure` path — not `isSpokenLine` — because
the absence of engine-path coverage is what let the first widening bug through.

- **Run *count* is asserted in every case.** Revision 1's test plan pinned only
  content, so a suite built from it would have passed on all 74 turn-loss
  paragraphs.
- One case per D sub-clause: both-sides (`O’Brien`, `don’t`), whitespace-then-
  letter (`’em`, `’cause`), opener-then-letter (`‘’Tis`).
- **The never-delete invariant, directly:** a paragraph whose only closers are
  apostrophes must still produce its runs, unchanged from `main`.
- **The resumed-skip bound, directly:** the two known-bug fixtures from the
  Critical review, asserted against `parseChapterStructure`'s measured output
  (not predicted), plus a mutation/neutralisation check — forcing the bound's
  `limit` back to `line.length` and confirming the targeted tests fail for the
  expected reason, so the tests are proven to actually depend on the bound and
  not to pass by coincidence.
- **British single-quote convention**, the whole `british` sweep family — the
  convention the problem statement is about and the corpus has no example of.
- **Nesting** in `en`, `zh` and `de`, including an outer turn containing three
  inner quotes; plus the promotion cases above, which are the ones that break
  if a future change deletes a candidate. *Only the shipped table set is
  testable:* `findQuoteRuns` is module-private and its pairs come from
  `conv.quotePairs`, so with no table changes there is no way to drive the
  widened set through `parseChapterStructure`. The widened-set evidence stays
  in the generated sweep and moves into unit tests with #2286.
- zh's `“他说‘你好’然后走了”` stays one run — a **nesting characterisation**, not
  coverage of the script exclusion, which is unreachable today (above).
- Regression cases for the shapes this does **not** fix, asserted at current
  output so a future fix has a failing test to flip rather than a silent gap:
  the possessive-plural truncation (`‘It was the boys’ fault,’`), German `»…«`
  emphasis glued to a word, same-glyph nesting fragmentation, and — new this
  revision — the dash-preceded under-repair (`‘It’s like being in jail—’pon my
  word…’`), each with a one-line note on *why* it isn't fixed (the dash case
  specifically notes the widening was tried and rejected).
- Salvage from PR #2286: its `parser.test.ts` closer-driven and multi-turn
  cases, and `lang/index.test.ts`'s duplicate-pair guard widened to `zh`/`ja`.
- Not applicable: golden-audio and on-box acceptance — no audio, sidecar or GPU
  surface is touched.
