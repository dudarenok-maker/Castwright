---
status: draft
date: 2026-08-06
---

# Attribution collapse visibility: measure it first, then say what happened

Design work behind **#1984** — _"Attribution collapse is invisible: the
dropped-quotes panel shows the last batch only, in a transient view, and never
the effect."_

> **Revision 3.** Revision 1 went through the mandatory adversarial review gate
> and did not survive it: the headline fix was a **placebo**, the metric's
> numerator matched **one of two** narrator ids and missed the orphan class
> entirely, the threshold was **uncalibrated**, and the "shared module"
> safeguard for the library badge **did not exist**. Revision 3 then folded a
> finding from the repo owner that revision 2's own state model could not
> express: a book with a **47-member cast and zero attributed sentences**
> (_Ночной дозор_) rendered as perfectly healthy — the #1984 failure shape,
> inside the feature built to close #1984. Every finding below was re-verified
> against the tree or the live workspace before folding. §Review findings
> records both rounds.
>
> **Revision 4 (2026-08-09).** Measuring the live corpus — the very step
> revision 3 deferred to Wave 1 — found that revision 3's own state model
> **badges a healthy Chinese or Japanese book as damaged and gates its
> generation.** `isSpokenLine` has no CJK bracket support, so every zh/ja book
> scores `spokenTotal === 0`; with a real cast and a completed run's deleted
> snapshot, all three clauses of `missing` are satisfied by a book with nothing
> wrong with it. This is the mirror of R-O1: that finding was a damaged book
> reading as healthy, this is a healthy book reading as damaged, and both come
> from a denominator that cannot see the dialogue it is counting. Revision 4
> makes the denominator language-aware, fixes `isSpokenLine` at the source, and
> reports the gap between the two definitions as a standing regression signal.
> §Review findings round 3 records it.
>
> **Revision 5 (2026-08-10).** Revision 4 went through the adversarial gate and
> **did not survive it.** Its central empirical error: the reconnaissance behind
> it measured `server/handoff/cache/*.json`, **not the library.** Nine of the 31
> caches are orphans with no book in the workspace, and three of them were the
> headline rows of revision 4's acceptance table — including both "collapsed"
> CJK books. Those books are deleted. The two CJK books that actually exist
> measure **2.9%** and **1.6%** and are healthy. Revision 4 also closed the CJK
> *instance* of its own Critical while leaving the *class* open behind a
> provably unreachable escape hatch, and shipped a mutation control that its own
> other change disarmed. Revision 5 restates every empirical claim from the
> workspace, threads a real "language unknown" through the resolution chain so
> `unmeasurable` becomes reachable, and fixes the placebo. §Review findings
> round 4 records all twelve findings.

## Problem

On 2026-07-14 a real book in the library — _Der Auftrag von Coalfall_ (de) —
lost **103 of its 144 quoted sentences to the narrator** during analysis.
Dialogue collapsed from 178 lines to 41; ten of thirteen cast members ended up
with almost nothing to say. The book then sat that way for **17 days**, found
only while chasing an unrelated bug. A library-wide sweep found one other
affected book (_Юный дрессировщик_, ru, 78%). Every other book measured ≤ 15%,
most 0–3%.

The signal was not absent. It could not have communicated the damage:

1. **Latest batch only.** `DroppedQuotesPanel`
   (`src/components/analysing/phase-card.tsx:252`) narrows to
   `batches[batches.length - 1]`. The book's ledger held 16 dropped
   attributions across 5 batches; the last held 1. The user was shown
   _"Verifier dropped 1 quote across 1 character."_
2. **Styled to recede.** A `<details>` at `text-[11px] text-ink/60`.
3. **Transient.** It exists only on the analysing screen. Once analysis
   finished there was no residue anywhere.
4. **It reports the cause, not the effect.** "N quotes dropped" is a
   verifier-internal statistic. The number that decides whether the book is
   usable is _"103 of 144 quoted sentences are now attributed to the narrator"_,
   and it is never computed anywhere.

Point 4 is the crux: **the two numbers are not proportional.** Dropping one
quote can re-attribute a long run of dialogue; dropping ten can be harmless.
Here, 16 drops produced a 72% collapse.

### What this is not

The corruption was produced by the pre-fix analyzer of
[#1598](https://github.com/dudarenok-maker/Castwright/issues/1598), which closed
11 minutes after this book's journal was written. It is about the fact that when
attribution collapses — for any reason, including future ones — the product does
not tell the user in terms they can act on.

**Revision 4 narrows one analyzer change into scope**, and only one:
`isSpokenLine` gains the CJK bracket pair (§The CJK denominator defect). Through
revision 3 this spec changed no analyzer behaviour at all; that is no longer
true, and §Out of scope is amended accordingly. Everything else about the
analyzer remains untouched.

## Decisions taken

| # | Decision |
|---|---|
| D1 | **Warn everywhere; require an acknowledgement before generating; never permanently refuse.** |
| D2 | **Book-level share OR any single chapter crosses the line.** Revised in revision 2 — see R-M8. |
| D3 | **Badge on the library card AND a banner in the Cast view.** Auto-clears on a good re-analysis; an explicit per-book dismiss handles false positives. |
| D4 | **A dismissal re-arms whenever the attribution data changes.** |
| D5 | **Copy leads with the effect; the verifier's cause is secondary.** |
| D6 | **The analysing-view panel sums the whole ledger** and labels it honestly. Revised in revision 2 — see R-C1. |
| D7 | **Stamp for the library, live compute for the detail surfaces.** |
| D8 | **Ship in two waves: measure, then decide.** The threshold is set from the real library, not from a sweep whose method no longer exists. See R-C3. |
| D9 | **"Narrator" means every id that renders in the narrator's voice** — both members of `NARRATOR_CHARACTER_IDS`, plus unresolvable ids. See R-C2. |
| D10 | **The Cast-view re-run confirms first when rendered audio exists.** |
| D11 | **"Cast built, nothing attributed" is its own alarm state**, not a quiet one. Added in revision 3 — see R-O1. |

---

# Wave 1 — measure

Wave 1 ships **no threshold and no UI.** It ships the metric and a read-only
script that prints the figure for every book in the real library, so the
threshold in Wave 2 is set from data rather than from a sweep whose counting
method is not in the tree.

### Prerequisite: _Ночной дозор_ must be re-analysed before the threshold is set

Wave 1's *implementation* is not blocked. The **threshold decision it exists to
inform** is, and by one specific book.

_Ночной дозор_ (Night Watch, ru, `mns_oyK7Po6BiT`) is the book plan 247 built
the `the-coalfall-commission.ru-dash.md` fixture from, because it is
**dash-delimited Russian** — i.e. the single strongest stressor of the
`isSpokenLine` dash rule that R-C3 turns on. Measured in the live workspace on
2026-08-06:

| | |
|---|---|
| `state.json` chapters | 9 |
| `cast.json` members | 47 |
| Sentences in the analysis cache | **0** — `stage1` present, `chapters: {}`, 0.4 MB |
| Cache `updatedAt` | 2026-07-17 |
| dropped-quotes batches | 18 (**308** cumulative drops; **7** in the last) |

Every other book's cache holds its sentences normally (13,582 / 12,835 / 11,428
/ 10,849 / 10,475 / 10,198 in the six largest), so this is not a wrong
assumption about where sentences live — it is this book.

**Cause: none. The repo owner started a re-run and stopped it** (confirmed
2026-08-06). Phase 0 wrote the cast, Phase 1 never ran, and the 0-byte
`analysis-state.json` is the aborted snapshot write. Not a defect — which is
precisely why D11 matters: this is the **normal path**, not a corruption, so any
user who cancels an analysis leaves a book in a state the library rendered as
healthy.

**Consequence for Wave 1:** the book that most stresses the dash rule
contributes a blank row, so a threshold set without re-analysing it is set from
books that do not exercise the failure mode. Order of work: re-analyse →
run the script → set the threshold.

> **Discharged 2026-08-06 — this prerequisite is met.** The owner re-analysed the
> book; its cache is now 3.7 MB, 9 chapters and **15,069 sentences**, with
> **27 non-narrator cast members** in `cast.json`. It is no longer an instance of
> `missing`. It measures **4,921 dialogue lines, 1,389 of them narrator =
> 28.2%** — the second-highest share among live books and a real collapse, which
> is what R-O2 wanted it for. The two denominators agree exactly (Δ 0.0) here, so
> D12 does not disturb the calibration it unblocked. The `missing`-state
> discussion below is retained as the reasoning behind D11, not as a description
> of the book's current state.
>
> **Revision 4 said "58-member cast"** (R-5Mi3). That figure came from
> `stage1.characters` in the **analysis cache**, not from `cast.json`. They are
> different things and `cast.json` is the identity of record per CLAUDE.md, so
> `castCount` — which the `missing` rule turns on — must be read from it. The
> other book revision 4 called "cast 20" (_Юный дрессировщик_) holds **7**.

**Second consequence — a real-world confirmation of D6.** Night Watch's ledger
holds 308 drops across 18 batches with 7 in the last. Today's panel would read
_"dropped 7 quotes · latest batch."_ Summing the whole ledger yields **308
across 18 passes**; the `runId` grouping revision 1 proposed would have shown
**7**. A second book, at 20× Coalfall's scale, independently confirming both the
bug and the fix.

## The metric

New pure module `server/src/store/attribution-health.ts`. No I/O, no model call.

**Universe.** Sentences from the book's analysis cache
(`cache.chapters: Record<number, SentenceOutput[]>`,
`server/src/store/analysis-cache.ts:79`), minus chapters marked `excluded` in
`state.json` (`server/src/workspace/scan.ts:77`) — EPUB back-matter would
otherwise skew the denominator — and minus sentences flagged
`excludeFromSynthesis` (`server/src/handoff/schemas.ts:135`).

**Denominator (D12, revision 4).** Sentences that are dialogue **under the
book's own language conventions** — not under `isSpokenLine`.

```ts
isDialogueLine(text, conventions)  // conventions.dialogueOpen matches at start,
                                   // OR a conventions.quotePairs opener starts
                                   // the line, OR an embedded open…close span
```

`LanguageConventions` and `conventionsFor` come from
`server/src/analyzer/dialogue-structure/lang/index.ts:14` — seven tested tables
(`ru`, `en`, `es`, `fr`, `de`, `zh`, `ja`) already carrying exactly the
open/close pairs and paragraph-dash markers this needs. Importing them rather
than authoring an eighth definition of "what is dialogue" is the point.

**Revision 3 mandated reusing `isSpokenLine` verbatim, on the reasoning that
measuring anything else would report a number the analyzer does not act on.
That reasoning is what produced the CJK defect** (§The CJK denominator defect):
a detector that shares its subject's definition of dialogue can only ever report
collapse its subject is capable of seeing. Where the analyzer's view is wrong,
the metric must be able to say so — that is the whole thesis of #1984.

Measured over the 20 live books, the two denominators agree **exactly (Δ 0.0) on
every Russian, Spanish, French and German book**, and to within a fraction of a
point on most English ones. They diverge in two places, both of them the point:
CJK, where `isSpokenLine` counts nothing at all; and English, where
`isSpokenLine` counts any leading dash as dialogue but `en.dialogueOpen` is
`null`.

**Revision 4 claimed "±0.2 points on every large book"; that was too strong**
(R-5Mi2). _Unlocked_ — 10,198 sentences, one of the largest — moves **13.6% →
14.6%**, driven by the 58 dash-only lines the spec itself names, and it is the
live book nearest a plausible threshold band. The honest statement is that the
change **moves no book across an obvious boundary in today's distribution**, not
that it moves nothing; the threshold is set from the D12 column and must be, as
the two columns are not interchangeable at the margin.

**Language resolution.** The denominator now depends on knowing the language, so
resolution is its own tested function with an explicit fallback chain:

1. `state.json`'s `language` field **read raw**, when present;
2. otherwise `detectManuscriptLanguage(sample)`
   (`server/src/tts/detect-language.ts:25` — pure, synchronous, script pre-pass
   for Cyrillic/CJK plus `franc` for the Latin set) over the cached sentence
   text, sampling its own `SAMPLE_CHARS` (20,000);
3. detection **surrendering rather than matching** ⇒ `unmeasurable`;
4. `conventionsFor()` returning `null` ⇒ `unmeasurable`.

**Step 1 must read `state.language` raw, and this is a trap** (R-5M3). The
in-tree accessor is `bookStateLanguage` (`server/src/workspace/scan.ts:314`),
whose own header tells callers never to read `state.language` directly — but it
delegates to `normaliseBookLanguage` (`server/src/tts/language.ts:23`), which
returns `DEFAULT_LANGUAGE` for an absent value. An implementer following the
documented convention gets `'en'` for every book with no language, and **step 2
never runs at all.** Everywhere else in the codebase wants a usable default;
this module is the one place that needs the difference between "declared
English" and "nothing declared", so it reads the field raw and says why.

**Step 2 is load-bearing, not a nicety.** 7 of the 20 live books have no
`language` field — the entire Keeper of the Lost Cities series, analysed before
the field existed — and they are among the **largest** books in the corpus
(7.1k–13.6k sentences each). Without detection they would all resolve
`unmeasurable`, which is the "feature turning itself off wholesale" failure this
spec already names in §Failure modes.

**Step 3 closes the class, and needs one additive analyzer change** (R-5C3).
`detectManuscriptLanguage` ends
`return match ? result(match.code) : result('en')` (`detect-language.ts:60`) —
an unmatched manuscript is answered `'en'`, and because English *is* a supported
registry language the existing `supported` flag is `true` on that path.
**`supported` cannot distinguish a decision from a surrender**, so simply
threading it through — revision 5's first instinct — would not have worked.
`DetectionResult` gains a third field:

```ts
interface DetectionResult {
  language: string;
  supported: boolean;
  fallback: boolean;   // true ONLY on the `: result('en')` surrender branch
}
```

Additive; no behaviour change for any existing caller. The metric maps
`fallback === true` ⇒ `unmeasurable`. Without it, an Italian, Portuguese or
Polish manuscript resolves to `en`, is measured against `en` conventions
(`dialogueOpen: null`; pairs `“”` / `""` / `‘’`), scores a near-zero denominator
on its `«…»` or em-dash dialogue, and — with a real cast and a completed run's
deleted snapshot — satisfies all three `missing` clauses. **That is R-4C1 again
in a different alphabet**, and `unmeasurable` cannot catch it because the
language *did* resolve to a table.

The measurement carries `languageSource: 'declared' | 'detected' | 'unknown'`.
`'unknown'` is a real value with a real producer — step 3 — which is what makes
`unmeasurable` reachable at all. Revision 4's `| null` arm had no producer and
was dead type: the tell that its design had no representation for "I don't
know".

**Numerator (D9).** Of those, sentences whose speaker renders in the narrator's
voice. That is three cases, not one:

| Case | Why it counts |
|---|---|
| Resolved id ∈ `NARRATOR_CHARACTER_IDS` | `server/src/analyzer/narrator-identity.ts:26` — `['narrator', 'char-narrator']`. Centralised in #1895 precisely because it had been inline-copied across server modules. |
| `buildCastResolver.resolve()` returns `undefined` | `server/src/store/cast-resolve.ts:147` — an unresolvable id. At render time `server/src/tts/synthesise-chapter.ts:2315-2326` substitutes the narrator for any group whose `characterId` isn't in `cast` — _"falling back to the narrator voice for this line"_. Audibly narrator, so it counts. |
| — | Everything else does not count. |

Resolution goes through `buildCastResolver` per the CLAUDE.md rule that an
analyzer `characterId` is only an alias into `cast.json`.

The two contributing cases are **reported separately** (`narratorIdSpoken`,
`orphanSpoken`) so the Wave 1 measurement can tell "attribution collapsed" from
"ids drifted" — the #2040 class — rather than blending them into one number.

**Shape (Wave 1):**

```ts
interface AttributionMeasurement {
  language: string | null;       // resolved BCP-47 primary subtag
  languageSource: 'declared' | 'detected' | null;
  spokenTotal: number;           // isDialogueLine under the book's conventions
  pipelineSpoken: number;        // isSpokenLine's count — the comparand
  blindSpoken: number;           // conventions say dialogue, isSpokenLine does not
  overcountSpoken: number;       // isSpokenLine says dialogue, conventions do not
  narratorIdSpoken: number;      // resolved to a NARRATOR_CHARACTER_IDS member
  orphanSpoken: number;          // unresolvable id → renders as narrator
  narratorSpoken: number;        // the sum; the figure the warning quotes
  dashOnlySpoken: number;        // diagnostic — see below
  quietCastCount: number;        // non-narrator cast members with < 2 spoken lines
  castCount: number;             // non-narrator cast members
  chapters: { chapterId: number; spokenTotal: number; narratorSpoken: number }[];
}
```

**`dashOnlySpoken` is the calibration diagnostic.** `isSpokenLine` returns true
for **any** sentence beginning `-`, `–`, `—`, `&mdash;` or `&ndash;`
(`narrator-default.ts:32`), not only for quote marks. In a Russian or French
novel — or any EPUB whose conversion prefixes continuation lines with a dash —
narration asides land in **both** numerator and denominator and inflate the
share. Counting how much of each book's denominator is dash-only, with no quote
mark present, is what tells us whether 40% is a sane line or a trap. The second
known-damaged book is Russian, where the em-dash is both the dialogue mark and
ordinary punctuation.

**`dashOnlySpoken` survives revision 4.** `ru.dialogueOpen` matches dashes too,
so Russian denominators carry the same dash-inflation under the conventions
denominator as under `isSpokenLine` — the diagnostic is still what tells us
whether a threshold is sane on the language that most stresses it.

## The CJK denominator defect

Found 2026-08-09 by measuring the live corpus. `isSpokenLine`
(`server/src/analyzer/narrator-default.ts:29`) tests these openers: dash entities
and literal dashes, then `[«„"“‘']`, then embedded `«»` / `„“` / `""` / `“”` /
`‘’` / word-anchored straight-single. **It contains no CJK corner brackets.** A
Chinese or Japanese dialogue line — `「别管。」`, `「放っておけ」と、…` — returns
`false`.

Seven CJK **caches** carry 28–125 bracket-quoted dialogue lines each and **every
one scores `spokenTotal: 0`.** Of those seven, **two have live books** — the
`ja` and `zh` Coalfall translations, with 104 and 122 dialogue lines and casts of
10 and 9. The other five are orphan caches whose books have been deleted
(R-5C1). The branch `feat/server-fs59-cjk-w5` does not fix this; its copy of the
file is byte-identical to `main`'s.

**Why that breaks revision 3.** A healthy, fully-analysed CJK book satisfies all
three clauses of `missing`:

| Clause | CJK reality |
|---|---|
| `castCount > 0` | 11–15 characters, measured |
| `spokenTotal === 0` | lexical blindness, not damage |
| `readAnalysisState() === null` | `deleteAnalysisState` fires on terminal success of a main run (`server/src/routes/analysis.ts:2743`) |

So the fix for #1984 would **badge every Chinese and Japanese book as damaged and
block its generation**. Revision 3 argues (§Failure modes) that `castCount` is
what separates a damaged book from legitimate pure narration. CJK defeats that
argument: a real cast *and* a zero spoken count, for a reason that has nothing to
do with the book.

**The fix is two-part.**

1. **The denominator becomes language-aware** (D12 above), so `zh`/`ja` resolve
   against their own `quotePairs` and the count is never zero for a book with
   dialogue.
2. **`isSpokenLine` gains the CJK pair at the source** — `「` and `『` join the
   opener class, and `「…」` / `『…』` join the embedded-span alternatives.

Part 2 is in scope because the blindness is not only a measurement problem. When
`conventionsFor(language)` returns `null`, `server/src/routes/analysis.ts:2281`
runs `applyNarratorDefault`, which demotes every line `isSpokenLine` rejects —
for a CJK book, all of its dialogue.

**Be precise about the evidence for this, because revision 4 was not** (R-5C1).
The two books observed at **99.2%** and **97.8%** narrator share are **orphan
caches whose books no longer exist in the workspace.** The damage was real and
the mechanism is real, but it is **historical**: both live CJK books went through
the structure-engine branch and measure 2.9% and 1.6%.

So part 2 is **defence in depth against an undiagnosed trigger**, not a repair of
present damage — and the spec says so rather than borrowing urgency it no longer
has. The justification that survives is: `zh`/`ja` have convention tables, so
that `null` branch should never have been reached for those books, and **nobody
knows why it was.** Until that is understood the same path can be reached again,
and when it is, `isSpokenLine` is the last thing standing between a CJK book and
total attribution loss. The change is small, its blast radius is provably
CJK-only, and the alternative is leaving a known-blind guard in front of an
unknown trigger.

**Blast radius is confined to CJK.** `「』` and their partners do not occur in
Latin or Cyrillic text, so no existing `en`/`ru`/`es`/`fr`/`de` book can change
attribution. **The fix is also not retroactive to stored attributions:** the
metric recomputes over cached sentence *text*, so denominators correct
immediately even for old caches, but the two collapsed books keep their stored
`characterId`s until re-analysed. Wave 1 will correctly report them at ~99%.

**What produced those two collapses is deliberately left unresolved.** `zh` and
`ja` both have convention tables (landed `a2f507d1`, 2026-07-13 16:03), and both
collapses post-date that commit, with a clean sibling book 21 minutes later — so
the trigger is run-dependent, most likely a language that never reached
`stageCall`, and it is **not proven**. It is not this spec's to fix; the gap
column below is what makes it visible.

### The gap column

The two definitions disagree in **both** directions, and a signed difference
would net them into one number that hides each. They are counted separately:

| Field | Meaning | Expected |
|---|---|---|
| `blindSpoken` | conventions say dialogue, `isSpokenLine` does not | **0 on today's corpus** after part 2 — but not a universal invariant; see the German gap |
| `overcountSpoken` | `isSpokenLine` says dialogue, conventions do not | **non-zero and fine** — the dash class; 10 of 20 live books, peaking at 58 |

**`blindSpoken` is the regression signal.** It is what CJK produced — **104
lines on the live `ja` book and 122 on the live `zh` book**, invisible to
`isSpokenLine` — and after part 2 both must read 0, with no other row moving.
That is what makes it worth carrying permanently rather than deleting once CJK
is closed: **a newly non-zero value means the analyzer's definition of dialogue
has drifted from the language's again**, which is the failure class that
produced this entire revision.

**It is not a universal invariant, and revision 4 wrongly made it one**
(R-5M2). German `»…«` is dialogue under `de.quotePairs` and invisible to
`isSpokenLine` even after part 2 — the opener class has no `»`, and the embedded
rule `«[^»]+»` matches the opposite order. `de.ts`'s own comment calls `»…«` the
alternate German form. It reads 0 today only because the corpus's one German
book, _Der Auftrag von Coalfall_, opens every line with `„` at position 0; the
next German import that uses `»…«` would alarm permanently on a gap this spec
declines to fix.

(Revision 4's round-3 finding claimed four German forms were affected. Two of
them — `„…"` and `„…”` — are in fact caught, because `„` is already in the
opener class. Only `»…«` is missed, in both leading and embedded position.
Verified by running all four.)

So the criterion is **"0 for the languages `isSpokenLine` covers, and any
*change* from the recorded per-language baseline is a finding"** — not "0
everywhere". The `»…«` gap is recorded as a known limitation below rather than
silently treated as a defect on every run.

**`overcountSpoken` is not a defect and must not be alarmed on.** It is the
leading-dash rule counting narration as dialogue in languages whose
`dialogueOpen` is `null` — 58 lines on one English book in the 2026-08-09 run.
It is reported so the dash false positive is visible per book rather than
inferred, and it overlaps `dashOnlySpoken` by construction; both are kept
because `dashOnlySpoken` is scoped to the dash rule specifically while
`overcountSpoken` catches any divergence in that direction.

Netting these into one signed field was a real defect in revision 4's own first
draft, caught in self-review: it would have made the acceptance criterion
"`blindSpoken` is 0 across the corpus" **false on healthy English books**, which
is the same shape of error as everything else in this document's history — a
number that cannot distinguish two conditions being asked to prove one of them.

## The measurement script

`scripts/measure-attribution.mjs` — read-only, writes nothing to any book.
Walks the workspace, prints one row per book (title, `language`,
`languageSource`, `spokenTotal`, `narratorSpoken`, share, `orphanSpoken`,
`dashOnlySpoken`, `pipelineSpoken`, `blindSpoken`, `overcountSpoken`) sorted by
share descending,
plus the worst chapter per book, and writes a JSON report to the scratch path
for follow-up.

Two rows must be **visibly distinct from a healthy book and from each other**,
because both are states revision 3 could not express: a book with a cast and
nothing attributed, and a book whose language could not be resolved. Neither may
render as a blank row.

Its output is the input to the Wave 2 threshold decision. Pure helpers
unit-tested in `scripts/tests/`, matching the `build-companion-apk.test.mjs`
pattern.

## Wave 1 acceptance criteria

1. `computeAttributionMeasurement` is pure, has no I/O, and **imports** its
   building blocks rather than re-implementing any of them: `conventionsFor` /
   `LanguageConventions` for the denominator, `NARRATOR_CHARACTER_IDS` for the
   numerator, `isSpokenLine` for `pipelineSpoken`, and
   `detectManuscriptLanguage` for the language fallback. Four imports, no
   second copy of anything.
2. An unresolvable `characterId` counts toward `narratorSpoken` via
   `orphanSpoken`, and is separately visible.
3. The script runs against the live workspace and prints a row for every book,
   skipping and reporting books with no cache.
4. The script **flags a book with a cast and no attributed sentences
   distinctly** from one with no cache at all — _Ночной дозор_ must be visibly a
   damaged book, not a blank row (D11). It also prints whether an
   `analysis-state.json` snapshot exists, since that is what separates an
   abandoned run from a resumable one.
5. No threshold constant, no UI, no persisted state exists yet.
6. **The language of every book in the live workspace resolves**, and the row
   records whether it was declared or detected. A book that resolves to no
   conventions table is reported as such, distinctly from both a damaged book
   and a blank row.
7. **`isSpokenLine` recognises `「…」` and `『…』`**, with a paired regression
   asserting `applyNarratorDefault` no longer demotes a CJK dialogue line to
   `narrator`, and a control asserting no `en`/`ru` line changes classification.
8. **`blindSpoken` drops from 104 and 122 to 0 on the two live CJK books** once
   criterion 7 lands, **and no other book's value changes.** Not "0 across the
   corpus" — the German `»…«` gap is a recorded limitation, not a regression.
9. **`unmeasurable` is reachable**: a book whose detection surrendered resolves
   there rather than to `missing`, proven by the row-7 fixture and its two
   mutation controls.

---

# Wave 2 — warn

Built only after the Wave 1 numbers are read. Everything below is settled
**except** the numeric threshold, which Wave 1 sets.

## Trigger (D2, revised)

Revision 1 triggered on the book-level share alone. That leaves partial damage
silent: a 40-chapter book where two chapters collapse completely scores
`60/1200 = 5%` and shows nothing — two hours of audio in the wrong voice, which
is the exact expense the issue says this exists to prevent.

**A book is collapsed when the book-level share crosses the threshold, OR when
any single chapter with at least `MIN_SPOKEN_PER_CHAPTER_TRIGGER` spoken
sentences crosses it.**

```
COLLAPSE_SHARE_THRESHOLD        = <set by Wave 1>
MIN_SPOKEN_FOR_VERDICT          = 20   // book-level floor
MIN_SPOKEN_PER_CHAPTER_TRIGGER  = 20   // a chapter may only TRIGGER above this
MIN_SPOKEN_PER_CHAPTER_DISPLAY  = 5    // a chapter shows a % above this
```

The display floor and the trigger floor are deliberately different, and
conflating them is the easy mistake: a 6-spoken-line chapter is worth showing a
number for and is not worth flagging a book over.

Hardcoded exported constants, **not** registry knobs — nobody asked for them to
be tunable, and a knob would owe an Advanced-Settings row and a config-sync
entry for no benefit.

## Storage and data flow

`GET /api/library` never reads the analysis cache and must not start: measured
on the reference box, the cache is **76 files, 24.9 MB total, largest 3.4 MB.**
Loading that to render a badge on every library navigation is not viable.

### `analysedAt` is a property of the data, not of who wrote it

`saveAnalysisCache` already stamps `updatedAt` on **every** write
(`server/src/store/analysis-cache.ts:146`). That is the identity used:

```
analysedAt = cache.updatedAt   (fallback: cache file mtime when the field is
                                absent, i.e. a cache written before the field
                                existed — `updatedAt?` is optional at :109)
```

This is load-bearing for three separate reasons:

- **It fixes the crashed-run hole (R-M6).** Phase 1 writes the cache per chapter.
  A run that dies mid-Phase-1 leaves a half-attributed cache but never reaches
  the success-path stamp write. Keyed on a write timestamp, a dismissal made
  before the crash would suppress the damage on every surface. Keyed on
  `cache.updatedAt`, the crash moved it, so the dismissal re-arms.
- **It removes the race revision 1 claimed to have removed (R-M2).** When
  `analysedAt` is a pure function of the cache, no write ordering between the
  backfill, the refresh, and the analysis routes can orphan a dismissal. Nothing
  needs a lock, because nothing is racing over a value anyone mints.
- **It survives a backup restore or a workspace move**, which file mtime does
  not (R-Mi4).

Consequence, accepted: a per-chapter retry moves `cache.updatedAt` and so
re-arms a dismissal for the whole book. With a per-chapter trigger now in play
that is the right behaviour — and if the retry fixed the chapter, the warning
auto-clears without the user doing anything.

### Two files

| File | Written by | Contains |
|---|---|---|
| `.audiobook/attribution-health.json` | analysis completion, any detail-surface read, the backfill script | the counts + `analysedAt`. **Pure derived cache — no user intent.** |
| `.audiobook/attribution-dismissal.json` | the dismiss endpoint only | `{ dismissedForAnalysedAt: string }` |

Path constants join `droppedQuotesJsonPath` in `server/src/workspace/paths.ts`.
Neither touches `cast.json`, so no `withCastLock` involvement and no new lock
class. There is no `measuredAt`: revision 1 introduced it as "load-bearing" and
gave it no consumer.

### Write sites at analysis completion

`persistDroppedQuotesBatch`'s three call sites in `server/src/routes/analysis.ts`
— `:3568`, `:4209`, `:6208` — are where the stamp is refreshed too.
`analysis-chapters` (`:5740`) is a **subset** re-run and must recompute over the
**whole book**, not the chapters it just did.

### API

`openapi.yaml` is edited first (it is the type source of truth), then
`npm run openapi:types`.

- `GET /api/books/:bookId/attribution-health` — computes live, rewrites the
  stamp, returns:

  ```ts
  type AttributionHealthResponse = AttributionMeasurement & {
    share: number | null;                             // null under the floor
    state: 'ok' | 'collapsed' | 'missing' | 'unmeasurable';
    triggeredBy: 'book' | 'chapter' | null;
    worstChapterId: number | null;
    analysedAt: string;
    dismissed: boolean;
  };
  ```

- `POST /api/books/:bookId/attribution-health/dismiss` — **takes no body.** The
  server reads `analysedAt` from the cache itself and writes the dismissal. A
  client-supplied timestamp (revision 1) could go stale between the client's GET
  and its POST, making the dismiss button do nothing, silently (R-M7).
- `GET /api/library` — each book gains
  `attributionState: 'ok' | 'collapsed' | 'missing' | 'unmeasurable'`. **Not a boolean:** a
  boolean cannot distinguish `unmeasurable` from `ok`, which is how revision 1
  reproduced the silence it was written to fix (R-M5).

### Keeping the badge and the banner honest

The badge reads the stamp; the detail surfaces compute live. They can disagree —
exclude some back-matter and the book becomes healthy while the badge persists.
Revision 1's answer, "the stamp catches up on the next read", is circular: the
next read *is* the detail surface, which the badge exists to drive you to.

So: **a detail-surface fetch also patches that book's `attributionState` in
`library-slice.ts`.** The badge updates in the same session, with no refetch and
no cache read on the library path.

### Backfill

`scripts/backfill-attribution-health.mjs` stamps every book that lacks one.
Because `analysedAt` comes from the cache, the backfill and the live path cannot
disagree about it. Books with no cache are skipped and reported.

## Surfaces and copy

One shared component, `src/components/attribution-collapse-notice.tsx`.

```
⚠  Most of this book's dialogue is being read by the narrator.

   72% of quoted lines (103 of 144) went to the narrator.
   10 of 13 cast members have almost nothing to say.

   The verifier dropped 16 quotes across 5 analysis passes,
   which is often the cause.

   [ Re-run analysis ]  [ Chapter breakdown ▾ ]
   [ Dropped quotes ▾ ] [ This book is fine — dismiss ]
```

- **"almost nothing to say"** is defined or it cannot be computed: non-narrator
  cast members with **fewer than 2** spoken sentences.
- When `triggeredBy === 'chapter'`, the heading names the chapter instead:
  _"Chapter 3's dialogue is being read by the narrator."_ A book-level 5% with a
  96% chapter must not open with "most of this book's dialogue".
- The cause line is **omitted entirely** when the ledger is empty. Collapse has
  other causes, and "dropped 0 quotes" would misdirect.
- Chapters under `MIN_SPOKEN_PER_CHAPTER_DISPLAY` show `—`.

### Placements

| Surface | Treatment |
|---|---|
| `src/views/confirm-cast.tsx` | Full notice above the cast list. **No `Re-run analysis` button** — `:240-244` already renders "Re-analyse manuscript"; a second identical button is noise. |
| `src/views/cast.tsx` | Full notice at the top, where the empty cast members are visibly the symptom. |
| `src/views/generation.tsx` / `src/store/start-generation-flow.ts` | The acknowledgement gate. |
| `src/components/library/library-grid.tsx` **and** `src/components/library/library-table.tsx` | The badge, in **both**. |

**The badge has no shared render path (R-M1).** `library-status-ui.tsx:24`
exports only `STATUS_UI: Record<LibraryBookStatus, StatusMeta>` — a map, no
component; the grid (`:167`) and the table (`:266`) each render their own pill.
Attribution-collapse is orthogonal to `LibraryBookStatus` (a book can be
`complete` *and* collapsed), and `library-status-ui.test.ts` pins a hardcoded
status list, so a new key is not representable there. The badge is therefore a
**new small shared component** rendered from both files — and the test asserts
it in both, because "I put it in the shared module" is precisely the false
comfort revision 1 shipped.

`unmeasurable` renders a distinct neutral marker in the library, not nothing.

### The generation gate (R-M3)

`start-generation-flow.ts` is not the only entry: `requestStartGeneration` is
dispatched from `start-generation-flow.ts:83` and `:93`, `layout.tsx:1823` (tier
prompt), and `clone-readiness-gate.tsx:238` ("proceed anyway"), and
`generation-stream-middleware.ts:72` enqueues on the action type.

Therefore:

- The attribution gate is the **first** gate in the thunk, before voice-readiness
  (`:56`), clone-readiness (`:69`), and the tier prompt (`:96`). The other three
  dispatch sites are *continuations of gates that run after it*, so placing it
  first leaves them correct and unbypassable.
- "Generate anyway" **re-enters the thunk** with `attributionAcknowledged: true`.
  It must not dispatch `requestStartGeneration` directly — that pattern
  (`clone-readiness-gate.tsx:238`) is correct for the *last* gate and would, from
  the first, skip the voice-readiness, clone, and tier gates entirely.
- A test asserts gate composition: a Qwen book that is both attribution-collapsed
  and voice-unready must see **both** gates, in order.

### The Cast-view re-run (D10, R-Mi1)

`confirm-cast.tsx`'s `onReanalyse` (wired at `:240-244`, labelled "Re-analyse
manuscript") resolves to a handler that dispatches
`changeLogActions.wipeBookShapeEvents()` (`src/routes/index.tsx:685`) then
`uiActions.reanalyse()`. Fired from the `ready`-stage Cast view on an
already-generated book, that wipes chapter-id-bearing history and invalidates
rendered audio.

So in the Cast view the button confirms first **when the book has rendered
audio**, naming what re-analysis will invalidate. On a book with no audio it
fires directly.

### The panel fix (D6, revised — R-C1)

Revision 1 proposed grouping batches by a new `runId`. **A run writes exactly
one batch.** `persistDroppedQuotesBatch` has three call sites, none in a loop,
and `:3184`/`:3824` are mutually exclusive branches;
`server/src/store/dropped-quotes.ts:55` states it outright — _"Multiple batches
accumulate across **re-runs**."_ The incident's 5 batches were 5 separate runs.
Under `runId` grouping the panel would find one batch and render "dropped 1
quote across 1 character" — byte-identical to today. It was a placebo, and its
"fails before, passes after" test constructed a fixture no writer can produce.

**The fix is to sum the whole ledger and label it honestly:**

> Verifier dropped 16 quotes across 5 analysis passes

replacing today's `latest.totalDropped` and its `· latest batch` disclaimer
(`phase-card.tsx:264-266`). No `runId`, no schema change, no threading through
the routes. This reproduces exactly the number #1984 says the user should have
seen.

The cost is the one revision 1 used to justify `runId`: a re-analysed, healthy
book still shows its old failures. That is acceptable because the label says
"across 5 analysis passes" rather than implying they are current, and because
the collapse notice — which is what the user acts on — appears only when the
book is actually collapsed now.

## Failure modes

The computation **fails open**, but failing open is how a book goes silent, so
there are **four** states and the library shows all four:

| State | Rule | Library | Cast view | Gates generation |
|---|---|---|---|---|
| `ok` | — | nothing | nothing | no |
| `collapsed` | share ≥ threshold, book or chapter | warning badge | full notice | yes |
| `missing` | `castCount > 0 && spokenTotal === 0 && (await readAnalysisState(dir)) === null` | warning badge | full notice | **yes** |
| `unmeasurable` | cache absent or corrupt, **or the language has no conventions table** | neutral marker | _"Attribution health couldn't be measured for this book."_ | no |

**The states are evaluated in a fixed order, and the order is the revision-4
fix:**

```
unmeasurable → missing → collapsed → ok
```

`unmeasurable` is tested **first**, so a book whose language could not be
resolved never reaches the `missing` test. The three clauses of `missing` are
unchanged from revision 3; only their reachability is.

**Revision 4 claimed this precedence is what stopped a healthy CJK book being
badged. That was wrong** (R-5M1). `zh` and `ja` both have conventions tables
(`lang/index.ts:10`), so a CJK book never resolves `unmeasurable` in the first
place — **D12 alone closes R-4C1**, by giving the book a non-zero denominator.
Worse, under revision 4 the precedence rule guarded a state nothing could enter:
import rejects any language outside the seven-code registry
(`import.ts` `isSupportedLanguage`), all seven have tables, and detection could
only ever return a registry code or `'en'`. It was a guard over an empty set,
and its fixture tested an unreachable state.

**The precedence earns its place only because of step 3.** Once detection can
report a surrender (`fallback`), `unknown` becomes a language state a real book
can actually be in, `unmeasurable` becomes reachable, and testing it before
`missing` is what stops an unidentifiable book being called damaged. Order and
reachability are one mechanism, not two: a precedence rule over a state nothing
can enter is decoration.

**`missing` is D11, and it is not a rounding case.** Revision 2 gave a book with
a cast and no attributed sentences `share: null` → `ok`, so _Ночной дозор_ — 47
cast members, nothing attributed to any of them — would have rendered as
perfectly healthy in the library. That is the #1984 failure shape reproduced
inside the feature written to close #1984. It is arguably worse than a 72%
collapse: at 72% something is still attributed.

Its copy cannot reuse the collapsed notice, which would read "0 of 0 quoted
lines". It reads:

> ⚠ This book has a cast but no dialogue attributed to it.
> 47 cast members, and not one line assigned. Analysis built the cast but never
> finished attributing the text.

**`missing` is distinguished from legitimate pure narration by `castCount`, not
by `spokenTotal`.** A non-fiction book or a pure-narration text has no
non-narrator cast members, so `castCount === 0` and it stays `ok`. The alarm
fires only on the contradiction: characters exist, and nothing is theirs.

**It is distinguished from an interrupted run by the analysis snapshot** — and
this half is what keeps it from becoming noise. Starting an analysis and
stopping it is an ordinary user action, not a corruption: Phase 0 writes the
cast, Phase 1 never runs, and the book is left with exactly the
cast-and-no-sentences shape. That is how _Ночной дозор_ reached its state (the
repo owner started a re-run and stopped it, confirmed 2026-08-06) — so this is
a **reachable state on the normal path**, not an exotic one.

Badging every paused analysis as damaged would fire the alarm during routine
use, which is how a warning gets trained into background noise. So `missing`
requires `readAnalysisState(bookDir) === null` as well. While a snapshot exists
in any state — `running`, `paused` or `halted` — the book is not badged, because
the existing AnalysisPill already owns that surface and says something truer.

**`readAnalysisState` is `async`** (`analysis-state.ts:85` —
`Promise<AnalysisStateFile | null>`), so it must be awaited. Written literally
as `readAnalysisState() === null` the clause compares a Promise to `null`, is
never true, and **makes `missing` silently unreachable** while every test that
does not exercise it still passes (R-5M5).

That also settles module ownership, which revision 4 left unstated: the state
derivation **does I/O and therefore cannot live in the pure module** Wave 1
acceptance criterion 1 requires. `attribution-health.ts` stays pure and returns
`AttributionMeasurement`; a separate Wave 2 caller resolves the snapshot, applies
the precedence order, and produces the state. The pure module never reads a file.

`readAnalysisState` returns `null` for an absent **or unparseable** file
(`server/src/store/analysis-state.ts:85-93`), which is what makes the rule work
on the real case: Night Watch's `analysis-state.json` is 0 bytes, so it reads as
no rehydratable state and correctly badges. A book with a live or resumable
snapshot does not.

**A book never analysed is `ok`, and the `unmeasurable` rule is scoped so that
this is not a contradiction** (R-5M4). Revision 4 said `unmeasurable` covers
"cache absent", evaluated first, and two paragraphs later that a never-analysed
book is `ok` — under the stated precedence the first won, so **every freshly
imported book would have shown the neutral "couldn't be measured" marker until
analysis finished**, training the reader to ignore the one marker introduced so
that silence could not read as health. The rule is therefore:

> `unmeasurable` = the book **has been analysed** (`castConfirmed`, or a cache
> that exists) **and the measurement still could not be made** — cache corrupt,
> or language unidentifiable.

A book with no analysis has nothing to measure and no claim is made about it: no
badge, no marker, `ok`. The script reports it as `not analysed`, distinct from
both a damaged book and an unmeasurable one.

`assertCacheChaptersShape` throws **inside `loadAnalysisCache`**
(`analysis-cache.ts:124`), not at measure time, so the catch must wrap the
**load**, not the metric.

**The cache is gitignored and lives outside the workspace** (`.gitignore:94`,
`CACHE_DIR` in `analysis-cache.ts`). A server reinstall or workspace move makes
every book `unmeasurable` — the feature turning itself off wholesale. That is
why `unmeasurable` is visible in the library: the failure announces itself
instead of reading as a clean bill of health.

### Edge cases, decided

| Case | Behaviour |
|---|---|
| Zero spoken sentences, **no non-narrator cast** (non-fiction, pure narration) | `share: null`, state `ok`. Nothing is missing — there were never any characters. |
| Zero spoken sentences, **cast present**, no analysis snapshot | State `missing` (D11). The contradiction is the signal. |
| Zero spoken sentences, **cast present**, snapshot `running`/`paused`/`halted` | State `ok`. An interrupted run is ordinary use; the AnalysisPill already says so, and badging it would train the warning into noise. |
| Under 20 spoken sentences book-wide | `share: null`, no verdict. **Known gap:** a novella with 19 spoken lines, all narrator, is 100% collapsed and reports no verdict. Accepted — below 20 the figure is noise. |
| Chapter with 6 spoken lines, all narrator | Shows `100%` in the breakdown; does **not** trigger (under the 20-line trigger floor). |
| User excludes back-matter after analysis | Live compute picks it up; the library badge is patched in the same session. |
| First-person book | See below. |
| **CJK book, cast present, dialogue in `「」`** | Resolves at `zh`/`ja`, `spokenTotal > 0`, so `ok` or `collapsed` on its real share — **never `missing`**. This is R-4C1. |
| **Language absent from `state.json`** | `detectManuscriptLanguage` resolves it; `languageSource: 'detected'`. Applies to 7 of 22 live books, including the largest. |
| **Language resolves to one with no conventions table** | `unmeasurable`, evaluated before `missing`. Not badged, not gated, but visible. |

### Known false positives

- **Dash-prefixed narration.** The larger of the two, and unmentioned in
  revision 1. Quantified in Wave 1 via `dashOnlySpoken`; the threshold is set
  against it. Still deliberately **not** fixed by changing the dash rule in
  `isSpokenLine`, which the analyzer also acts on — that is a much wider blast
  radius and its own piece of work. **Revision 4 note:** D12 removes this
  false positive from the *denominator* for languages whose `dialogueOpen` is
  `null` (English among them), because a leading dash is then not dialogue. It
  does **not** remove it for Russian, where `ru.dialogueOpen` matches dashes by
  design — which is why `dashOnlySpoken` survives and why the threshold is still
  calibrated against it. The CJK change in §The CJK denominator defect is a
  different rule in the same function and carries no dash implications.
- **First-person narration.** The analyzer resolves a first-person speaker to a
  roster character (`dialogue-structure/evidence.ts:28`, `windows.ts:56`), so a
  healthy first-person book should not trip this. If that resolution fails, the
  protagonist's dialogue legitimately lands on `narrator`.

Both are why D3 keeps a manual dismiss. Documented limitations, not defects to
design away.

## Testing

**Wave 1 — pure metric (Vitest, server).** `orphanSpoken` counts an unresolvable
id; `narratorIdSpoken` counts **both** `narrator` and `char-narrator` — the
`char-narrator` case is asserted explicitly, since matching only `'narrator'` is
the exact regression #1895 centralised the constant to prevent; excluded chapters
and `excludeFromSynthesis` removed from both numerator and denominator; zero
spoken → `0/0` handled; `quietCastCount` at exactly 1 and 2 lines;
`dashOnlySpoken` counts a dash-prefixed sentence with no quote mark and does not
count a dash-prefixed sentence that also contains one.

**Wave 1 — the denominator and the language chain (revision 4).**
`isDialogueLine` returns true for each language's own pairs and false for
another language's (a `「」` line is dialogue under `ja`, not under `en`); a
declared `state.json` language wins over detection and sets
`languageSource: 'declared'`; a book with no declared language resolves through
`detectManuscriptLanguage` and sets `'detected'`; a language with no conventions
table yields `unmeasurable` **and never `missing`**, asserted with a `castCount`
> 0 fixture so the precedence is what the test is actually proving.

**Wave 1 — `isSpokenLine` CJK.** A `「…」` line and a `『…』` line classify as
spoken; `applyNarratorDefault` leaves a CJK dialogue line's `characterId`
untouched (**fails before the change, passes after**).

**The blast-radius control must be the corpus replay, not a fixture** (R-5Mi1).
Revision 4 specified "a set of `en`/`ru` lines classify identically before and
after" — but a hand-authored Latin or Cyrillic fixture contains no `「『` by
construction, so it holds for *any* change to those characters and proves
nothing. The claim being tested is about the **real corpus**, so the control is:
run `isSpokenLine` over every sentence of all 20 live books before and after,
and assert the classification differs on **exactly** the two CJK books and
**nowhere else**. That is a genuine falsifiable check and the script already
walks the corpus to make it. (The underlying claim is confirmed on today's data
— zero `「`/`『` in any non-CJK cache — which is what makes the assertion safe to
gate on.)

**Wave 2 — trigger.** Book-level at threshold ±1 sentence; a chapter trigger
firing while the book-level share is far below it; a chapter at 100% with 19
spoken lines **not** triggering and the same chapter with 20 triggering;
`triggeredBy` and `worstChapterId` correct in both directions.

**Wave 2 — the `missing` state (D11).** Four fixtures that must resolve to three
different states, because the whole point of D11 is that revision 2 collapsed
them into one:

| Fixture | `castCount` | `spokenTotal` | `analysis-state.json` | Expected |
|---|---|---|---|---|
| Pure-narration non-fiction | 0 | 0 | absent | `ok` |
| Cast built, nothing attributed, run abandoned | 47 | 0 | absent **or 0 bytes** | `missing` |
| Cast built, nothing attributed, run **paused** | 47 | 0 | `state: 'paused'` | `ok` — the pill owns it |
| No cache at all | — | — | — | `unmeasurable` |
| **Healthy `ja` book, dialogue in `「」`** (R-4C1) | 13 | **> 0** | absent (run completed) | `ok` |
| **Healthy `de` book, dialogue in `»…«`** (R-5C2) | 13 | **> 0** | absent | `ok` |
| **Book whose language detection surrendered** (`fallback: true`) | 13 | 0 | absent | `unmeasurable` |

Each row disproves a different way of writing the rule too loosely, and a test
that omits any of them lets that looseness ship:

- Omit row 1 → `spokenTotal === 0` alone passes, badging every non-fiction book.
- Omit row 3 → dropping the `readAnalysisState` clause passes, badging every
  paused analysis.
- Row 2's **0-byte** variant is the real Night Watch file; a fixture using only
  an absent file leaves the unparseable path unproven.
- Omit row 5 → a `spokenTotal` built on `isSpokenLine` passes, badging every
  CJK book and blocking its generation.
- Omit row 6 → the same defect in every language whose dialogue marks
  `isSpokenLine` misses; see below for why this row, not row 5, is the one that
  can prove it.
- Omit row 7 → dropping the `unmeasurable`-first precedence passes, badging
  every book whose language could not be identified.

**Mutation controls. Revision 4's version of this table was itself a placebo**
(R-5C2), and the way it failed is worth keeping visible: it specified row 5's
control as "revert the denominator to `isSpokenLine`" — but part 2 of the same
revision teaches `isSpokenLine` to read `「…」`, so after both changes land the
reverted denominator still returns `spokenTotal > 0` and **row 5 does not move.**
One change in the revision disarmed the control of another.

| Mutation | Row 5 (`ja`) | Row 6 (`de` `»…«`) | Row 7 (unknown) |
|---|---|---|---|
| Denominator reverted to `isSpokenLine` | **unchanged** — part 2 covers `「」` | **flips to `missing`** | unchanged |
| Denominator reverted **and** part 2 reverted | flips to `missing` | flips to `missing` | unchanged |
| `unmeasurable`-first precedence deleted | unchanged | unchanged | **flips to `missing`** |
| `fallback` mapping deleted (step 3) | unchanged | unchanged | **flips to `missing`** |

**Row 6 is why the German fixture exists.** `»…«` is dialogue under
`de.quotePairs` (`de.ts`) and invisible to `isSpokenLine` **even after part 2**,
because the opener class has no `»` and the embedded rule is `«[^»]+»` — the
opposite order. It is therefore the only fixture in the table that a *single*
mutation can move, which makes it the real proof that the denominator change is
load-bearing. Row 5 keeps CJK covered but needs the two-mutation control, and the
spec says so rather than pretending otherwise.

Row 5's fixture text must still contain **real `「」`-quoted dialogue attributed
to real cast members** — not merely CJK prose — or even the two-mutation control
does not move it.

**Storage.** `analysedAt` reads from `cache.updatedAt`, falling back to mtime
only when the field is absent; the dismiss endpoint resolves `analysedAt`
server-side; a cache write between dismiss and read re-arms.

**Routes.** GET computes and rewrites the stamp; a subset re-run recomputes the
whole book; corrupt cache → `unmeasurable`, not 500; `GET /api/library` carries
the three-state value.

**Gate composition.** A book that is attribution-collapsed **and** voice-unready
sees both gates in order; "Generate anyway" does not skip the later three.

**The named regression test.** The incident's real ledger shape — 5 batches, one
per run, the last holding 1 entry — asserting the panel reads "16 quotes across
5 analysis passes". **Fails on `main`, passes after**, and unlike revision 1's
version it is a shape the writers actually produce.

**Frontend.** Notice states; the chapter-triggered heading variant; cause line
omitted on an empty ledger; badge asserted in **both** `library-grid` and
`library-table`; `unmeasurable` marker present in the library; dismissal clears
all surfaces.

**E2E (Playwright).** One spec: a collapsed book badges in the library, banners
in Cast, gates generation, and dismissal clears all three. Crosses
router/redux/layout seams, so required.

**Neutralisation proof — every assertion, not only thresholds.** Revision 1
scoped this to "every threshold assertion", and the gate found two more placebos
under that scope:

- The `excludeFromSynthesis` test passes with the filter deleted, because import
  residue is not quoted and `isSpokenLine` already excludes it. The fixture must
  therefore contain an `excludeFromSynthesis` sentence that **is** quoted.
- The cast-resolver test passes with `buildCastResolver` removed entirely unless
  the retired id is **the narrator's own**. The fixture retires
  `char-narrator` → `narrator`, not an ordinary character.

Each assertion is mutated on its own line and observed to go red, and the proof
is recorded in the PR body.

## On-box acceptance — owed

Wave 1's script output **is** an acceptance artifact: it is the first honest
measurement of the real library. Register row for Wave 1 — run
`scripts/measure-attribution.mjs` and record the distribution.

**The expected shape is known**, from the 2026-08-10 measurement that produced
revision 5 — **taken over the workspace, joined to the caches, with `castCount`
from `cast.json`**. Revision 4's version of this table was drawn from the cache
directory alone and named three books that do not exist (R-5C1); this is its
replacement. All 20 live books, D12 denominator:

| Book | Lang | Src | Cast | D | Share | blind | over |
|---|---|---|---|---|---|---|---|
| Юный дрессировщик | ru | decl | 7 | 262 | **75.6%** | 0 | 0 |
| Ночной дозор | ru | decl | 27 | 4921 | **28.2%** | 0 | 0 |
| Unlocked | en | detect | 22 | 1768 | 14.6% | 0 | **58** |
| Заказ Коалфолла | ru | decl | 12 | 123 | 8.1% | 0 | 0 |
| Unraveled | en | decl | 11 | 2238 | 3.4% | 0 | 5 |
| コールフォールの依頼 | ja | decl | 10 | 104 | 2.9% | **104** | 0 |
| Everblaze · Neverseen · Exile · Keeper · Stellarlune | en | detect | 34–53 | 3659–5954 | 1.9–2.8% | 0 | 1–6 |
| Bonus Keefe Story | en | detect | 3 | 96 | 2.1% | 0 | 1 |
| Scepter of the Ancients | en | decl | 22 | 2817 | 1.8% | 0 | 1 |
| 煤落的委托 | zh | decl | 9 | 122 | 1.6% | **122** | 0 |
| Playing with Fire | en | decl | 26 | 2346 | 1.2% | 0 | 2 |
| El Encargo · La Commande de Coalfall | es · fr | decl | 12 | 122–126 | 0.8% | 0 | 0 |
| The Lost Art of World Domination | en | decl | 3 | 187 | 0.5% | 0 | 0 |
| Der Auftrag von Coalfall · The Coalfall Commission | de · en | decl | 12 | 127 | **0%** | 0 | 0 |

Four things make this a real check rather than a restatement:

1. **The two CJK books are healthy — 2.9% and 1.6%** — and must read that way.
   Revision 4 asserted they would appear at 99.2% and 97.8%; those figures
   belong to two **orphan caches** whose books have been deleted, and stating
   them as an acceptance made it unsatisfiable.
2. **`blindSpoken` is non-zero on exactly two rows, both CJK (104 and 122).**
   That is the pre-fix state and the direct measurement of R-4C1. After the
   part-2 `isSpokenLine` change both must read 0, and no other row may move.
3. **`overcountSpoken` is non-zero on 10 of 20 books, peaking at 58** on
   _Unlocked_. It must not be alarmed on — see §The gap column.
4. **_Der Auftrag von Coalfall_, the incident book this spec opens with, now
   measures 0%.** It was re-analysed after #1598 closed. The document's own
   motivating case is healthy, which is worth knowing before reading a threshold
   off this distribution.

**No live book has a one-character cast**, so revision 4's "cast-1 book at 96.2%
must not read as damaged" check is gone with the orphan it referred to. The
smallest live casts are 3 (_Bonus Keefe Story_ 2.1%, _The Lost Art_ 0.5%), which
prove nothing about the `castCount` discriminator. **That check has no live
proof and the D11 fixture row is its only evidence** — one more reason not to
drop it.

Wave 2 register row — run the backfill, confirm exactly the expected books badge
and no first-person or dash-heavy book false-positives. Register, run sheet, and
live view all move in the shipping PR.

## Out of scope

- **Any analyzer change beyond the two named ones.** Revision 5 permits exactly
  two, both small and both argued in place: the CJK bracket pair on
  `isSpokenLine` (§The CJK denominator defect), and the additive
  `DetectionResult.fallback` field (§Language resolution). Nothing else. In
  particular the `conventionsFor(language) === null` path that runs
  `applyNarratorDefault` is **not** changed, and the run-dependent trigger behind
  the two historical 97–99% collapses is **not** diagnosed here — it gets its own
  issue, with the `blindSpoken` column as its evidence.
- **The German `»…«` gap in `isSpokenLine`.** Recorded as a known limitation
  (R-5M2), not fixed. Fixing it means touching the dash/quote rules the analyzer
  acts on for a language with a live book, which is the wider blast radius this
  spec has consistently declined.
- **Automatic re-analysis.** The button is the only trigger.
- **Threshold configurability.** No registry knob.
- **Live mid-run collapse warning** — the figure swings wildly over a novel's
  opening chapters.

## Wave 2 acceptance criteria

1. A book crossing the threshold book-wide **or** in any chapter with ≥ 20 spoken
   lines badges in the library grid **and** table, and shows a notice in Cast and
   at the confirm step, with the heading matching `triggeredBy`.
2. Starting generation on such a book requires an acknowledgement, and that
   acknowledgement does not bypass the voice-readiness, clone, or tier gates.
3. Dismissing clears all surfaces; any subsequent change to the analysis cache
   re-arms the warning.
4. A re-analysis that drops the figure below the threshold clears the warning
   with no user action, including the library badge, in the same session.
5. The analysing-view panel reports the ledger's cumulative drops across all
   batches, labelled as analysis passes.
6. A book with an absent or corrupt cache neither 500s nor reads as healthy —
   **in the library as well as in the Cast view.**
7. The backfill stamps every existing book; the books Wave 1 identified as
   damaged badge, and books Wave 1 measured as healthy do not.
8. A book with a cast and no attributed sentences badges as `missing` and gates
   generation. **The named case is spent:** _Ночной дозор_ was re-analysed on
   2026-08-06 and now holds 15,069 sentences across 9 chapters with 27
   non-narrator cast members in `cast.json`, so it is no longer an example of
   this state — it is a `collapsed`
   candidate at **28.2%**. The state stays reachable on the normal path
   (cancelling an analysis is ordinary use), but it no longer has a live
   instance, so row 2 of the D11 fixture table is the only proof available and
   must not be dropped for lack of a real book.
9. **A Chinese or Japanese book with attributed dialogue is neither badged nor
   gated** (R-4C1). Asserted against a `「」` fixture, with the mutation control
   from the D11 table.
10. **`blindSpoken` matches its recorded per-language baseline.** A *change* from
    that baseline is a finding; a standing non-zero value on a known gap (German
    `»…«`) is not.

## Review findings

Revision 1 went through the Premium-tier adversarial gate. Findings, all
re-verified against the tree before folding:

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-C1 | Critical | A run writes **one** batch; the `runId` fix was a placebo and its regression test unproducible | D6 rewritten — sum the whole ledger, `runId` deleted |
| R-C2 | Critical | Numerator matched only `'narrator'`, missing `char-narrator` and the orphan class | D9 added |
| R-C3 | Critical | 40% was calibrated against a sweep method not in the tree; the dash rule inflates the share | D8 added — Wave 1 measures first |
| R-M1 | Major | `library-status-ui.tsx` exports a map, not a component; the "shared module" safeguard did not exist | New shared badge component, asserted in both files |
| R-M2 | Major | The two-file split converted a lost write into an orphaned key | `analysedAt` derived from `cache.updatedAt` — no minted value to race over |
| R-M3 | Major | Four `requestStartGeneration` dispatch sites; a fourth gate could skip three existing ones | Gate placed first; re-enters the thunk; composition test |
| R-M4 | Major | Badge (stamp) and banner (live) disagree with no invalidation path | Detail fetch patches `library-slice` |
| R-M5 | Major | `unmeasurable` rendered nothing in the library — #1984's silence, reproduced | Three-state value + a visible neutral marker |
| R-M6 | Major | A crashed mid-Phase-1 run left a stale `analysedAt`, so a dismissal suppressed real damage | Fixed by `cache.updatedAt` |
| R-M7 | Major | Client-supplied `analysedAt` could go stale, making dismiss silently no-op | Server resolves it; endpoint takes no body |
| R-M8 | Major | Book-level-only trigger left partial damage silent | D2 revised — per-chapter trigger added |
| R-Mi1 | Minor | Cast-view re-run is destructive on a generated book; confirm step already has the button | D10 added; button dropped from the confirm step |
| R-Mi2 | Minor | Two specified tests could not fail | Fixtures respecified; neutralisation proof widened to every assertion |
| R-Mi3 | Minor | A subset re-run re-arms the whole book's dismissal | Accepted and documented — correct under a per-chapter trigger |
| R-Mi4 | Minor | mtime is not a stable identity across restore/move | `cache.updatedAt` used; mtime only as a legacy fallback |

**Round 2 — repo owner, 2026-08-06.** Verified against the live workspace, not
the tree:

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-O1 | Critical | A book with a cast and **zero attributed sentences** scored `share: null` → `ok`. _Ночной дозор_ — 47 cast members, nothing attributed — would have rendered as perfectly healthy: #1984's failure shape inside the fix for #1984 | D11 added — `missing` is its own alarm state, badged and gating |
| R-O2 | Major | The threshold could not be calibrated against the one book that most stresses the dash rule, because that book has nothing to measure | Wave 1 prerequisite added: re-analyse _Ночной дозор_ before setting the threshold |

**Round 3 — 2026-08-09, found by measuring the live corpus** rather than by
reading the tree. R-O2's prerequisite had been discharged (Night Watch was
re-analysed 2026-08-06), which made the measurement possible; the measurement
then invalidated part of the design it was meant to calibrate:

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-4C1 | Critical | `isSpokenLine` has no CJK bracket support, so all 7 zh/ja books score `spokenTotal: 0`. With a real cast and a completed run's deleted snapshot, a **healthy** CJK book satisfies all three `missing` clauses — the feature would badge it damaged and **block its generation**. The mirror of R-O1 | D12: language-aware denominator; `unmeasurable`-first precedence; two D11 fixture rows with mutation controls |
| R-4M1 | Major | The denominator inherited the analyzer's blindness by design ("measure what the analyzer acts on"), so any future blind spot of this class is invisible in the headline number too | Denominator moved to the language conventions; `blindSpoken` added as a permanent regression signal |
| R-4M2 | Major | `applyNarratorDefault` demotes all CJK dialogue whenever `conventionsFor(language)` is null — two live books at **99.2%** and **97.8%**. A measurement-only fix would leave the cause in place | `isSpokenLine` gains `「」『』`; blast radius argued CJK-only; the null-conventions path itself left to its own issue |
| R-4M3 | Major | A conventions denominator needs a language label, and **7 of 22 live books have none** — the largest in the corpus. Naïvely applied it would render them all `unmeasurable` | `detectManuscriptLanguage` fallback specified as step 2, with `languageSource` recorded |
| R-4Mi1 | Minor | Acceptance criterion 8 named Night Watch's 2026-08-06 state as the proof case for `missing`; that state no longer exists | Criterion rewritten — the fixture row is now the only proof, and is marked not-droppable |
| R-4Mi2 | Minor | "This spec changes no analyzer behaviour" and §Out of scope's "any change to the analyzer, including `isSpokenLine`" both became false | Both amended, with the single permitted change named explicitly |
| R-4Mi3 | Minor | **Found in revision 4's own self-review.** The gap was first specified as a single signed field, `blindSpoken = spokenTotal - pipelineSpoken`. The two definitions diverge in both directions, so an English dash book reads **−58**, making the acceptance criterion "`blindSpoken` is 0 across the corpus" false on healthy books | Split into `blindSpoken` and `overcountSpoken`, with only the former alarmed on |

**Round 4 — Premium adversarial gate on revision 4, 2026-08-10. Verdict: not
safe to approve.** Twelve findings; every one re-verified against the tree or the
workspace before folding, and two of the reviewer's own claims corrected in the
process (noted below).

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-5C1 | Critical | **Revision 4's empirical basis was the cache directory, not the library.** 9 of 31 caches are orphans with no book in the workspace, and 3 were the headline rows of the on-box table — including both "collapsed" CJK books at 99.2%/97.8%, which are **deleted**. The live CJK books measure 2.9% and 1.6%. The acceptance "the two CJK books must appear at all" was unsatisfiable | §On-box acceptance rebuilt from a workspace-joined measurement of all 20 live books; R-4M2 restated as historical evidence |
| R-5C2 | Critical | **The new fixture's mutation control was a placebo.** "Revert the denominator to `isSpokenLine`" cannot move row 5, because part 2 of the same revision teaches `isSpokenLine` to read `「…」`. One change disarmed the other's control | Two-mutation control stated honestly for row 5; **German `»…«` row added** as the fixture a *single* mutation can move |
| R-5C3 | Critical | **The class stayed open behind an unreachable guard.** An unsupported language (it, pt, pl) resolves to `'en'` via `detect-language.ts:60`, is measured against `en` conventions, and lands in `missing` — R-4C1 in another alphabet. `supported` cannot catch it: English *is* supported, so the flag is `true` on the surrender branch | `DetectionResult.fallback` added (additive); `languageSource: 'unknown'`; `fallback` ⇒ `unmeasurable` |
| R-5M1 | Major | The claim that `unmeasurable`-first precedence is "precisely how a healthy CJK book stopped being badged" is **false** — `zh`/`ja` have tables, so CJK never reaches it. D12 alone closes R-4C1. The guarded state was itself unreachable (import rejects non-registry languages), so its fixture tested nothing | Claim corrected; precedence re-justified as load-bearing **only because** R-5C3 makes `unknown` reachable |
| R-5M2 | Major | `blindSpoken === 0` was made a universal invariant. German `»…«` is dialogue under `de.quotePairs` and invisible to `isSpokenLine` even after part 2, so the next `»…«` import alarms permanently | Criterion changed to a per-language baseline with the `»…«` gap recorded as a known limitation. **Reviewer said four German forms; two of the four are caught (`„` is already an opener) — verified, only `»…«` is missed** |
| R-5M3 | Major | The detection fallback would silently never run: the in-tree accessor `bookStateLanguage` (`scan.ts:314`) returns `DEFAULT_LANGUAGE` for an absent language, so an implementer following the documented convention gets `'en'` for all 7 no-language books | Step 1 specified to read `state.language` **raw**, with the reason stated |
| R-5M4 | Major | Three contradictory behaviours for a never-analysed book: `unmeasurable` (the rule, evaluated first), `ok` (the prose), "skipped" (the script). The rule won, so every freshly imported book would show the neutral marker | `unmeasurable` scoped to "analysed **and** still unmeasurable"; never-analysed is `ok` and reported as `not analysed` |
| R-5M5 | Major | `readAnalysisState` is `async`; the literal rule `readAnalysisState() === null` is never true and makes `missing` silently unreachable. Also I/O, so the state derivation cannot live in the pure module | Rule awaited; module ownership stated — pure metric vs. impure state derivation |
| R-5Mi1 | Minor | The blast-radius control could not fail — a Latin/Cyrillic fixture has no `「『` by construction | Replaced with a before/after replay over the real corpus asserting exactly two books change |
| R-5Mi2 | Minor | "±0.2 points on every large book" contradicted by _Unlocked_ (13.6% → 14.6%) and by the spec's own next sentence | Restated: no book crosses an obvious boundary; the columns are not interchangeable at the margin |
| R-5Mi3 | Minor | "58-member cast" for _Ночной дозор_ came from `stage1.characters` in the cache, not `cast.json` (**27** non-narrator). "cast 20" for the other book is **7** | Corrected; `castCount` specified to read `cast.json`, the identity of record |
| R-5Mi4 | Minor | Three `persistDroppedQuotesBatch` line numbers stale (`:3184/:3824/:5740` → `:3568/:4209/:6208`); `cast-resolve.ts:105` → `:147`; `synthesise-chapter.ts:1553` is the abort throw | Corrected. **Reviewer also claimed `phase-card.tsx:252` → `:262`; verified and the spec was right.** The narrator substitution is `:2315-2326`, not the reviewer's `:1531` either |
