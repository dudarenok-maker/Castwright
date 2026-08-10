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
> it measured `server/handoff/cache/*.json`, **not the library.** The cache
> directory holds **76 files and the workspace holds 20 live books** (plus 2 in
> `_trash`), so **54 caches are orphans with no book at all** — and three of the
> orphans were headline rows of revision 4's acceptance table, including both
> "collapsed" CJK books. Those books are deleted. Revision 4 also closed the CJK
> *instance* of its own Critical while leaving the *class* open behind a
> provably unreachable escape hatch, and shipped a mutation control that its own
> other change disarmed. Revision 5 restated every empirical claim from the
> workspace, threaded a "language unknown" through the resolution chain, and
> fixed the placebo. §Review findings round 4 records all twelve findings.
>
> **Revision 6 (2026-08-11).** Revision 5 went through a scoped re-review and
> **also did not survive it**: 3 of its 12 fixes failed, 2 more failed on their
> numbers, 3 were partial, and folding introduced 6 new defects including an
> interface block that contradicted its own prose 27 lines above. Three changes
> answer all of it.
>
> 1. **The pre-computed distribution is deleted.** This document hand-computed
>    its own acceptance numbers three times and got three different wrong
>    answers, for three different reasons: the cache directory instead of the
>    library (revision 4); `.upgrade-backups/` copies instead of live books (a
>    draft of revision 5); and a numerator that silently dropped D9's orphan
>    half *and* skipped the excluded-chapter filter §Universe mandates (revision
>    5, as shipped). Each attempt re-implemented `isSpokenLine`, the cast
>    resolver and the universe filters by hand and got a different subset wrong.
>    **Producing that table is Wave 1's job, using the real modules.** No share
>    figure appears in this document any more.
> 2. **D9 is narrowed: unresolvable ids are reported *alongside* the collapse
>    figure, never summed into it** (owner's decision, 2026-08-10). See
>    §Numerator.
> 3. **The `unmeasurable` producer is rebuilt around the reachable failure.**
>    Revision 5's `fallback` flag fires only when detection runs, and detection
>    runs only when `state.language` is absent — which no current import path
>    produces. The real hole is a **declared-but-wrong** language, and revision 6
>    corroborates the declaration on the one path where being wrong is expensive.
>
> §Review findings round 5 records all eighteen items.

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
| D9 | **The collapse figure counts both members of `NARRATOR_CHARACTER_IDS`. Unresolvable ids are measured and reported alongside it, never summed into it.** Added in revision 2 (R-C2), narrowed in revision 6 (R-6C1). |
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
> book; its cache is now 3.7 MB, 9 chapters and **15,069 sentences**. It is no
> longer an instance of `missing`, and it is a **real collapse** — which is what
> R-O2 wanted it for. The two denominators agree exactly (Δ 0.0) here, so D12
> does not disturb the calibration it unblocked. The `missing`-state discussion
> below is retained as the reasoning behind D11, not as a description of the
> book's current state.
>
> **Its share and its cast count are deliberately not stated here.** Revision 4
> said "58-member cast", from `stage1.characters` in the **analysis cache**;
> revision 5 corrected that to "27 non-narrator members" from `cast.json`, and
> **that was wrong too** — the file holds 35 characters, 34 of them non-narrator,
> and revision 5 got two other books' counts wrong in the same pass (R-6C3).
> `cast.json` is the identity of record
> per CLAUDE.md and `castCount` must be read from it, which is the durable
> lesson; the number itself is Wave 1's script's to print. Wave 2 acceptance
> criterion 8 previously carried the wrong figure and has been rewritten.

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

Reconnaissance over the 20 live books found the two denominators agreeing
**exactly (Δ 0.0) on every Russian, Spanish, French and German book**, and
diverging in two places, both of them the point: CJK, where `isSpokenLine`
counts nothing at all; and English, where `isSpokenLine` counts any leading dash
as dialogue but `en.dialogueOpen` is `null`.

**Every share figure previously quoted here has been deleted, and this is a
finding, not tidying** (R-6C3). Revisions 4 and 5 each stated how far the
denominator change moves individual books — "±0.2 points on every large book",
then "13.6% → 14.6% on _Unlocked_". Both were wrong, and the second was wrong in
*direction*: the pair it quoted was not two denominators at all, it was one
denominator computed with and without the excluded-chapter filter §Universe
mandates. The change on that book is a **drop**, not a rise, because the 58
dash-only lines leave the denominator.

The honest statement this document can make without re-deriving anything is
structural: **the two columns are not interchangeable at the margin, so the
threshold is set from the D12 column.** Whether any book sits near a plausible
boundary is a question for Wave 1's script, which computes it from the real
modules. Asserting it here is what has gone wrong three times.

**Language resolution.** The denominator now depends on knowing the language, so
resolution is its own tested function with an explicit chain:

1. `state.json`'s `language` field **read raw**, when present;
2. otherwise `detectManuscriptLanguage(sample)`
   (`server/src/tts/detect-language.ts:25` — pure, synchronous, script pre-pass
   for Cyrillic/CJK plus `franc` for the Latin set) over the cached sentence
   text, sampling its own `SAMPLE_CHARS` (20,000);
3. **corroboration**, on the `missing` path only — see below;
4. detection **surrendering rather than matching** ⇒ `unmeasurable`;
5. `conventionsFor()` returning `null` ⇒ `unmeasurable`.

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
`language` field — books analysed before the field existed — and they include
the largest in the corpus. Without detection they would all resolve
`unmeasurable`, which is the "feature turning itself off wholesale" failure this
spec already names in §Failure modes. (Revision 5 said these 7 hold "7.1k–13.6k
sentences each"; that was a hand-computed range and the low end is wrong by
26× — one of them is a short story. The count is not load-bearing and the range
is deleted rather than restated: R-6N3.)

**Step 3 is the one that closes the class, and revision 5's did not** (R-6C2).
Revision 5 made `unmeasurable` turn on detection surrendering — but **detection
only runs when `state.language` is absent, and no current import path leaves it
absent.** `import.ts:258` normalises the submitted language, hard-rejects
anything outside the seven-code registry (`:259-266`), and carries the
normalised value into the `state.json` literal at `:341`, written at `:343`;
staging returns `languageSupported: false` for anything else, so the only way
forward for an Italian, Portuguese or Polish manuscript is for the user to
**pick one of the seven.** That book therefore arrives with a *declared* language
that is confidently wrong, resolves at step 1, gets a conventions table, and
never reaches step 2 at all. Revision 5 replaced a guard over an empty set with
another guard over an empty set.

The reachable failure is **declared-but-wrong**, so the guard has to test the
declaration rather than only its absence:

> **When the measurement would otherwise return `missing`** — a real cast, and
> `spokenTotal === 0` under the declared language's conventions — **the declared
> language is corroborated** by running `detectManuscriptLanguage` over the same
> cached text. If detection **disagrees** with the declaration, or **surrenders**,
> the result is `unmeasurable`, not `missing`.
>
> **Corroboration is skipped outright when the cache holds no sentences at all**,
> and that carve-out is not an edge case — it is D11's own motivating book.

**The carve-out exists because without it this guard disarms the state it sits
in front of.** _Ночной дозор_ in its 2026-08-06 shape had `stage1` present and
`chapters: {}` — a full cast and **literally zero sentences.** Corroboration over
that book samples the empty string, `detect-language.ts:44` sees `letters === 0`,
surrenders, and by the rule above the book resolves `unmeasurable`: not badged,
not gated, a neutral "couldn't measure this" marker. **The canonical `missing`
case — the one R-O1 was raised on, the one the repo owner produced by cancelling
a re-run — would have been silently exempted by the guard added in the same
revision.**

That is this document's recurring failure shape, and it is worth naming rather
than quietly patching: a new guard whose detection envelope excludes its own
motivating case. Revision 4 shipped it (`unmeasurable`-first precedence over an
empty set), revision 5 shipped it (`fallback` on a branch no book reaches), and
revision 6 nearly shipped it a third time in the fix for the second.

The distinction the carve-out draws is real, not a patch:

| Cache | What it means | Verdict |
|---|---|---|
| **no sentences at all** | Phase 1 never ran. There is nothing to detect *from*, and the absence of text is itself the evidence of the abandoned run | `missing` — corroboration does not run |
| sentences present, detection **contradicts** the declaration | the book is probably not in the language it was imported as | `unmeasurable` |
| sentences present, detection **surrenders** (`letters === 0` over real sentences, or `franc` returns `und`) | there is text and it is unidentifiable | `unmeasurable` |

Three further properties make this the right shape rather than a wider one:

- **It runs on one path, and that path is already the expensive one.** A healthy
  book never reaches it, so the corroboration costs nothing on the hot path and
  cannot change any `ok` or `collapsed` verdict. It can only ever *downgrade* an
  accusation to "I can't tell", which is the direction a false positive needs.
- **It is exactly the contradiction that defines the state.** `missing` already
  fires on a contradiction — characters exist, nothing is theirs. "The text does
  not look like the language we are measuring it against" is a second, cheaper
  explanation for the same evidence, and preferring it is strictly safer than
  badging the book.
- **`unmeasurable` gets a live producer at last.** Steps 4 and 5 have none: all
  seven registry languages have conventions tables, and import admits nothing
  else. Without step 3 the only reachable producer is a corrupt cache, and the
  precedence machinery below would be decoration — the exact charge revision 5
  levelled at revision 4.

**Step 4 still needs the additive analyzer change, and its definition was too
narrow** (R-6N1). `detectManuscriptLanguage` ends
`return match ? result(match.code) : result('en')` (`detect-language.ts:60`) —
an unmatched manuscript is answered `'en'`, and because English *is* a supported
registry language the existing `supported` flag is `true` on that path.
**`supported` cannot distinguish a decision from a surrender.** So:

```ts
interface DetectionResult {
  language: string;
  supported: boolean;
  fallback: boolean;   // true on EVERY surrender branch, not just one
}
```

There are **two** surrender branches, and revision 5 named only the second:

| Line | Branch | Meaning |
|---|---|---|
| `detect-language.ts:44` | `if (letters === 0) return result('en')` | the sample has no letters at all — no evidence whatsoever |
| `detect-language.ts:60` | `: result('en')` | `franc` returned `und`, or matched nothing in the Latin registry |

Both must set `fallback: true`. Revision 5's "true ONLY on the `: result('en')`
branch" would have left a book of pure punctuation, numerals or unhandled script
answering `en` with `fallback: false` — confidently, from zero evidence. The
change is additive and no existing caller reads the field.

The measurement carries `languageSource: 'declared' | 'detected' | 'unknown'`.
`'unknown'` is a real value with real producers — a surrender at step 4, or a
declaration contradicted at step 3. Revision 4's `| null` arm had no producer
and was dead type: the tell that its design had no representation for "I don't
know".

**What corroboration does not do.** It does not correct the language, re-measure
against the detected one, or touch the analyzer's own resolution. A book that
lands in `unmeasurable` this way is *reported*, not repaired — the fix is for
the user to re-import it under a language the product supports, or for the
registry to gain that language, and neither is this spec's to do.

**Numerator (D9, narrowed in revision 6).** Of those, sentences **whose resolved
`characterId` is a member of `NARRATOR_CHARACTER_IDS`**
(`server/src/analyzer/narrator-identity.ts:26` — `['narrator', 'char-narrator']`,
centralised in #1895 precisely because it had been inline-copied across server
modules). Nothing else.

Resolution goes through `buildCastResolver` (`server/src/store/cast-resolve.ts:147`)
per the CLAUDE.md rule that an analyzer `characterId` is only an alias into
`cast.json`. That is what makes a **drifted-but-recorded** id resolve correctly
instead of counting as damage.

**Unresolvable ids are measured, reported, and deliberately excluded from the
share** (R-6C1). `buildCastResolver.resolve()` returning `undefined` is the
#2040 id-drift class, and it is a live condition: **8 of the 20 books in the
workspace carry ids their `cast.json` cannot resolve** — measured 2026-08-11
through `buildCastResolver` with each book's real `cast-id-history.json`, 1–5
distinct ids each. Revision 5 summed them in,
on the reasoning that at render time
`server/src/tts/synthesise-chapter.ts:2315-2326` substitutes the narrator for any
group whose `characterId` isn't in `cast` — _"falling back to the narrator voice
for this line"_ — so they are audibly narrator. **That reasoning conflates a
cached sentence with rendered audio, and the difference is the whole point of
the state:**

- The metric counts **sentences in the analysis cache**. Whether an unresolvable
  id was ever *heard* depends on whether the book has been rendered at all, and
  with what cast. `scripts/repair-cast-id-drift.mjs` declines to alias a
  never-rendered id for exactly this reason — _"no damage to repair"_.
- **The two conditions have different remedies.** Collapse is repaired by
  re-running analysis. Id drift is repaired by recording an alias — which is
  what the Cast view's orphan banner now does, since #2238 gave it the
  accept-a-match affordance it had been missing.
- **Summing them would gate generation on the wrong evidence.** The share badges
  a book and blocks its Generate button. A book whose ids drifted but whose
  attribution is intact would be blocked behind a "re-run analysis" prompt that
  cannot fix it, while the one control that can — the orphan banner — is not
  what the notice points at.

So `orphanSpoken` is a **sibling signal, reported on the same row and never
inside the same fraction.** Wave 1 prints both columns; Wave 2's collapse badge
reads the share only. Routing `orphanSpoken` to a user-facing surface of its own
is out of scope here — #2238 already built that surface, and connecting the
measurement to it is a follow-up, filed rather than folded.

**Orphans leave the denominator too, and getting this wrong reopens the hole one
level down.** Taking them out of the numerator alone would leave them diluting
the fraction: a book whose dialogue is *entirely* orphaned would score
`0 / spokenTotal` = **0%, perfectly healthy**, which is #1984's own failure shape
for the third time in this document. The share is therefore over the lines the
metric could attribute at all:

```
attributableSpoken = spokenTotal - orphanSpoken
share              = narratorIdSpoken / attributableSpoken
```

`spokenTotal` stays as it is — it is a property of the *text*, it is what
`missing` turns on, and it is what the gap columns compare against.
`attributableSpoken` is a separate reported field, so a reader can see how much
of the book the share actually speaks for. When `attributableSpoken` falls under
`MIN_SPOKEN_FOR_VERDICT` the share is `null` and no verdict is given — the
honest answer for a book whose ids have drifted wholesale, and the orphan banner
is the surface that can act on it.

**This is the one place the spec knowingly under-reports.** A book can be both
drifted and collapsed, and a reader of the share alone will not see the drift.
That is why the column is mandatory in Wave 1's output rather than optional, and
why §Wave 1 acceptance criteria requires it to be visibly non-zero on the books
that have it.

**Shape (Wave 1):**

```ts
interface AttributionMeasurement {
  language: string | null;       // resolved BCP-47 primary subtag; null iff 'unknown'
  languageSource: 'declared' | 'detected' | 'unknown';
  spokenTotal: number;           // isDialogueLine under the book's conventions
  pipelineSpoken: number;        // isSpokenLine's count — the comparand
  blindSpoken: number;           // conventions say dialogue, isSpokenLine does not
  overcountSpoken: number;       // isSpokenLine says dialogue, conventions do not
  narratorIdSpoken: number;      // resolved to a NARRATOR_CHARACTER_IDS member
                                 // — THE numerator
  orphanSpoken: number;          // unresolvable id; reported, NEVER summed in (D9)
  orphanIds: string[];           // the distinct unresolvable ids, for the drift surface
  attributableSpoken: number;    // spokenTotal - orphanSpoken — the DENOMINATOR
                                 // of the share; see D9. Not the same as spokenTotal.
  dashOnlySpoken: number;        // diagnostic — see below
  quietCastCount: number;        // non-narrator cast members with < 2 spoken lines
  castCount: number;             // non-narrator cast members, from cast.json
  chapters: {
    chapterId: number;
    spokenTotal: number;
    attributableSpoken: number;
    narratorIdSpoken: number;
    orphanSpoken: number;
  }[];
}
```

**There is deliberately no `narratorSpoken` field.** Revision 5 had one, defined
as `narratorIdSpoken + orphanSpoken`, and it is what let the measurement backing
that revision quietly compute a *third* thing again. A field whose name says
"renders as the narrator" but whose value must exclude ids that render as the
narrator is a trap for the next implementer; the share is computed from
`narratorIdSpoken` and nothing is named ambiguously (R-6C1).

**`languageSource` has no `| null` arm.** Revision 5 wrote the prose for
`'unknown'` and left `| null` in the interface block 27 lines below it — the
block an implementer actually copies (R-6N2). `language` is `null` exactly when
`languageSource === 'unknown'`, and that pairing is asserted.

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
| `castCount > 0` | casts of 10 and 9 on the two live books, measured |
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
The two caches observed at **99.2%** and **97.8%** narrator share are **orphans
whose books no longer exist in the workspace.** The damage was real and the
mechanism is real, but it is **historical**: the two CJK books that do exist both
went through the structure-engine branch and are healthy.

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
attribution — confirmed by counting them: zero `「` or `『` in any non-CJK cache.
**The fix is also not retroactive to stored attributions:** the metric
recomputes over cached sentence *text*, so denominators correct immediately even
for old caches, but a collapsed book keeps its stored `characterId`s until
re-analysed. (Revision 5 added "Wave 1 will correctly report them at ~99%" — of
the two *deleted* books, which Wave 1 will not report at all, because the script
walks the library. Deleted with the rest of the pre-computed numbers.)

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
| `overcountSpoken` | `isSpokenLine` says dialogue, conventions do not | **non-zero and fine** — the dash class; a substantial minority of books |

**`blindSpoken` is the regression signal.** It is what CJK produced — **104
lines on the live `ja` book and 122 on the live `zh` book**, invisible to
`isSpokenLine` — and after part 2 both must read 0, with no other row moving.
Those two figures are **the only per-book numbers this document still states**,
because they are the only ones two independent adversarial reviews re-derived
and agreed on; everything else is Wave 1's script's to print (R-6C3).
That is what makes it worth carrying permanently rather than deleting once CJK
is closed: **a newly non-zero value means the analyzer's definition of dialogue
has drifted from the language's again**, which is the failure class that
produced this entire revision.

**It is not a universal invariant, and revision 4 wrongly made it one**
(R-5M2). German is the counter-example, and **the gap is three times wider than
revision 5 said** (R-6C4). All four `de.quotePairs` forms, run through
`isSpokenLine` on 2026-08-11 in both positions:

| Form | Leading — `»Lass das.«` | Embedded — `Er sagte »Lass das.« und ging.` |
|---|---|---|
| `„…“` | spoken | spoken |
| `„…”` | spoken | **missed** |
| `„…"` | spoken | **missed** |
| `»…«` | **missed** | **missed** |

Only `„…“` is caught in both positions. The opener class carries `„` but not
`»`, so three of four are caught when the turn starts the sentence; the embedded
alternatives carry only `„[^“]+“` for German, so three of four are missed when
narration comes first. **This matters more than the count suggests**, because
`de.ts:7-9` says the ASCII `"` and the `”` glyph are what "real-world
manuscripts (incl. our translated demo books) **routinely**" use — so the two
forms that fail in embedded position are the common ones, not exotica.

**Revision 5 asserted "only `»…«` is missed, in both leading and embedded
position", explicitly overruling the round-4 reviewer who had said four forms
were affected.** The overrule was wrong and the reviewer was closer to right.
The measurement above is the correction, and §Out of scope and Wave 2 criterion
10 are widened to match — both previously named one form of three.

`blindSpoken` reads 0 on today's German book only because _Der Auftrag von
Coalfall_ opens every line with `„` at position 0. The next German import in any
other form would alarm permanently on a gap this spec declines to fix.

So the criterion is **"0 for the languages `isSpokenLine` covers, and any
*change* from the recorded per-language baseline is a finding"** — not "0
everywhere". The German gap is recorded as a known limitation below rather than
silently treated as a defect on every run.

**`overcountSpoken` is not a defect and must not be alarmed on.** It is the
leading-dash rule counting narration as dialogue in languages whose
`dialogueOpen` is `null`, and reconnaissance found it non-zero on half the
corpus. It is reported so the dash false positive is visible per book rather than
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
`languageSource`, `spokenTotal`, `narratorIdSpoken`, share, `orphanSpoken`,
`dashOnlySpoken`, `pipelineSpoken`, `blindSpoken`, `overcountSpoken`,
`castCount`) sorted by share descending, plus the worst chapter per book, and
writes a JSON report to the scratch path for follow-up.

**This script is the only place the distribution exists.** Everything it prints
was, in some earlier revision, hand-computed into this document instead — and
every one of those attempts was wrong. Three properties follow from that history
and are requirements, not style:

- **It walks the library, never the cache directory.** The workspace is the list
  of books; a cache file is an artifact that may outlive its book. On the
  reference box 54 of 76 caches have no book at all, so the two starting points
  differ by more than a factor of three.
- **It skips `.upgrade-backups/`.** That directory holds whole copies of the
  books tree, so a naïve recursive walk finds each book several times over and
  dedupes by `manuscriptId` to *a* copy — not necessarily the live one. That is
  how a draft of revision 5 produced cast counts from a backup.
- **It calls `computeAttributionMeasurement`, and applies §Universe.** No
  re-implementation of the filters, the resolver or `isSpokenLine` — the whole
  point is that the number in the report is the number the product computes.
  Revision 5's measurement skipped the excluded-chapter filter and changed two
  books' denominators by doing so.

Three rows must be **visibly distinct from a healthy book and from each other**,
because each is a state an earlier revision could not express: a book with a
cast and nothing attributed; a book whose language could not be corroborated;
and a book that has never been analysed. None may render as a blank row.

Its output is the input to the Wave 2 threshold decision. Pure helpers
unit-tested in `scripts/tests/`, matching the `build-companion-apk.test.mjs`
pattern.

## Wave 1 acceptance criteria

1. `computeAttributionMeasurement` is pure, has **no I/O**, and **imports** its
   building blocks rather than re-implementing any of them: `conventionsFor` /
   `LanguageConventions` for the denominator, `NARRATOR_CHARACTER_IDS` and
   `buildCastResolver` for the numerator, and `isSpokenLine` for
   `pipelineSpoken`. No second copy of anything.
2. **The language and the snapshot are resolved by an impure caller and passed
   in.** `detectManuscriptLanguage` is pure but reading `state.json` is not, and
   revision 5 put the whole chain inside the module that acceptance criterion 1
   requires to be pure (R-6M1). The split is the same one §Failure modes draws
   for `readAnalysisState`: one impure resolver does the file reads, the pure
   metric receives `{ language, languageSource }` and a sentence list.
3. **The share is `narratorIdSpoken / attributableSpoken`** (D9) — orphans are
   out of the numerator *and* out of the denominator. Asserted by a fixture
   whose orphan count is large enough to move the share under either mistake — a
   fixture with zero orphans proves nothing here. **A book whose dialogue is
   entirely orphaned reports `share: null`, never `0%`**, which is the assertion
   that catches the denominator half; without it, taking orphans out of the
   numerator alone reads a wholly-drifted book as perfectly healthy.
4. **`orphanSpoken` and `orphanIds` are non-zero and correct on the books that
   have unresolvable ids**, resolved through `buildCastResolver` with each
   book's real `cast-id-history.json`. A run that reports 0 everywhere means the
   resolver was bypassed, not that the corpus is clean.
5. The script runs against the live workspace and prints a row for every book,
   reporting — never silently skipping — books with no cache.
6. The script **flags a book with a cast and no attributed sentences
   distinctly** from a never-analysed one (D11), and prints whether an
   `analysis-state.json` snapshot exists, since that is what separates an
   abandoned run from a resumable one.
7. No threshold constant, no UI, no persisted state exists yet.
8. **Every book's language resolves**, and the row records `declared` /
   `detected` / `unknown`. A book that reaches `unknown` is reported distinctly
   from both a damaged book and a never-analysed one.
9. **`isSpokenLine` recognises `「…」` and `『…』`**, with a paired regression
   asserting `applyNarratorDefault` no longer demotes a CJK dialogue line to
   `narrator`.
10. **`blindSpoken` drops to 0 on both live CJK books** once criterion 9 lands,
    **and no other book's value changes.** Not "0 across the corpus" — the
    German gap is a recorded limitation, not a regression.
11. **`unmeasurable` is reachable from a real book shape**: a declared language
    contradicted by detection over the book's own text resolves there rather
    than to `missing`, proven by the fixture rows and their mutation controls.

**Criterion 10's control is an on-box acceptance item, not a CI test** (R-6M2).
It is a before/after replay of `isSpokenLine` over every sentence of every live
book, and the corpus is gitignored, machine-local and absent from a fresh clone
— a CI job asserting over it would pass vacuously wherever the books are not,
which is the failure shape this repo has hit before. CI gets the fixture-level
tests in §Testing; the corpus replay gets a register row and is run on the box.

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
MIN_SPOKEN_FOR_VERDICT          = 20   // book-level floor, on attributableSpoken
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
— `:3568`, `:4209`, `:6208` — are where the stamp is refreshed too. The third,
`:6208`, is the `'analysis-chapters'` site: a **subset** re-run, which must
recompute over the **whole book**, not the chapters it just did. (Revision 5
corrected these three line numbers and then named `:5740` for
`analysis-chapters` in the next sentence — R-6N4.)

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
one batch.** `persistDroppedQuotesBatch` has three call sites, none in a loop;
`:3568` and `:4209` are mutually exclusive branches of `runMainAnalyzerJob` — the
Phase-0 cache-hit path and the Phase-0b consolidation path — and both tag their
batch `'analysis-stream'` (R-6N5: revision 5 still cited the pre-correction
`:3184`/`:3824` here, in the document that corrected them);
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
| `ok` | — (including a book never analysed) | nothing | nothing | no |
| `collapsed` | `narratorIdSpoken / attributableSpoken` ≥ threshold, book or chapter | warning badge | full notice | yes |
| `missing` | `castCount > 0 && spokenTotal === 0 && (await readAnalysisState(dir)) === null && languageCorroborated` | warning badge | full notice | **yes** |
| `unmeasurable` | the book **has been analysed** and the measurement still could not be made: cache corrupt, the declared language contradicted by detection over the book's own text, detection surrendered, **or** the resolved language has no conventions table | neutral marker | _"Attribution health couldn't be measured for this book."_ | no |

**That `unmeasurable` cell is normative and revision 5's was not** (R-6M3).
Revision 5 fixed the rule in prose 80 lines below the table and left the table
itself reading "cache absent or corrupt, or the language has no conventions
table" — no analysed qualifier, no mention of the corroboration or the
surrender. An implementer coding from the table reproduces the exact defect the
prose fixed, and two further places said the old thing (§Edge cases and Wave 2
criterion 6, both corrected here). The rule lives in this cell; the prose below
explains it.

**The states are evaluated in a fixed order, and the order is the revision-4
fix:**

```
unmeasurable → missing → collapsed → ok
```

`unmeasurable` is tested **first**, so a book whose language could not be trusted
never reaches the `missing` test.

**Revision 4 claimed this precedence is what stopped a healthy CJK book being
badged. That was wrong** (R-5M1). `zh` and `ja` both have conventions tables
(`lang/index.ts:10`), so a CJK book never resolves `unmeasurable` in the first
place — **D12 alone closes R-4C1**, by giving the book a non-zero denominator.
Worse, under revision 4 the precedence rule guarded a state nothing could enter:
import rejects any language outside the seven-code registry
(`import.ts` `isSupportedLanguage`), all seven have tables, and detection could
only ever return a registry code or `'en'`. It was a guard over an empty set,
and its fixture tested an unreachable state.

**Revision 5's replacement was a guard over an empty set too, and revision 6's
is not** (R-6C2). Revision 5 rested the precedence on detection surrendering —
unreachable, because detection only runs when `state.language` is absent and
import always writes it. The corroboration step of §Language resolution is what
gives `unmeasurable` a producer a real book can reach: **a declared language
contradicted by the book's own text.** Order and reachability are one mechanism,
not two — a precedence rule over a state nothing can enter is decoration, and
this document has now written that decoration twice.

Concretely, the failure the precedence prevents: an Italian manuscript imported
as `en` (the only way it can enter, since staging refuses anything outside the
seven and the user must pick one) is measured against `en` conventions —
`dialogueOpen: null`, pairs `“”` / `""` / `‘’` — scores a near-zero denominator
on its `«…»` dialogue, and with a real cast and a completed run's deleted
snapshot satisfies every clause of `missing`. **That is R-4C1 in another
alphabet.** Corroboration runs `franc` over the book's own text and it does not
come back `en`, so the declaration is contradicted and the book is reported as
unmeasurable rather than accused of damage.

**Be precise about what detection can return here, because it constrains the
test** (and revision 5 was not). `detect-language.ts:57` restricts `franc` to
`only:` the registry's **Latin** codes — `en`, `es`, `fr`, `de`. An Italian
sample therefore does not resolve to `it` and rarely surrenders; it is pushed
onto the nearest registry Romance language. That is exactly what corroboration
needs — **disagreement**, not a correct identification — and it is why the guard
tests "does detection agree with the declaration", never "what is the language
really". A fixture asserting the detected code equals `it` would fail for a
reason that has nothing to do with the defect.

**`missing` is D11, and it is not a rounding case.** Revision 2 gave a book with
a cast and no attributed sentences `share: null` → `ok`, so _Ночной дозор_ in its
2026-08-06 state — a full cast, nothing attributed to any of it — would have
rendered as perfectly healthy in the library. That is the #1984 failure shape
reproduced inside the feature written to close #1984. It is arguably worse than
a 72% collapse: at 72% something is still attributed.

Its copy cannot reuse the collapsed notice, which would read "0 of 0 quoted
lines". It reads:

> ⚠ This book has a cast but no dialogue attributed to it.
> {castCount} cast members, and not one line assigned. Analysis built the cast
> but never finished attributing the text.

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
`AttributionMeasurement`; a separate caller resolves the snapshot, applies the
precedence order, and produces the state. The pure module never reads a file.

**Revision 5 drew that line for the snapshot and not for the language, which is
the same class of defect half-closed** (R-6M1). Step 1 of §Language resolution
reads `state.json`; step 3 reads the cached text to corroborate. Both are I/O,
and revision 5's Wave 1 criterion 1 nonetheless listed `detectManuscriptLanguage`
among the pure module's own imports. The resolver is therefore **one impure
function** — `resolveBookLanguage(bookDir, sentences)` — returning
`{ language, languageSource }`, which the pure metric receives as an argument
alongside the sentence list. `detectManuscriptLanguage` is itself pure, so the
resolver is thin; what makes it impure is the `state.json` read, and that is
exactly the boundary.

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
> that exists) **and the measurement still could not be trusted** — cache
> corrupt, the declared language contradicted, detection surrendered, or the
> resolved language has no conventions table.

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
| Zero spoken sentences, **cast present**, no analysis snapshot, **language corroborated** | State `missing` (D11). The contradiction is the signal. |
| Zero spoken sentences, **cast present**, no snapshot, but detection **contradicts** the declared language | State `unmeasurable`. The likelier explanation is that the book is not in the language it was imported as. |
| **Unresolvable `characterId`s present** | Counted into `orphanSpoken`/`orphanIds` and reported; removed from **both** halves of the share, and never a state of their own (D9). Repaired through the Cast orphan banner, not through re-analysis. |
| **Every dialogue line orphaned** (`attributableSpoken === 0`) | `share: null`, state `ok`, no badge, no gate — but `orphanSpoken` is the whole denominator and the row shows it. Not `0%`: a wholly-drifted book must not read as a healthy one. |
| Book never analysed | State `ok`, no badge, no marker. Reported by the script as `not analysed`. |
| Zero spoken sentences, **cast present**, snapshot `running`/`paused`/`halted` | State `ok`. An interrupted run is ordinary use; the AnalysisPill already says so, and badging it would train the warning into noise. |
| Under 20 **attributable** spoken sentences book-wide | `share: null`, no verdict. **Known gap:** a novella with 19 spoken lines, all narrator, is 100% collapsed and reports no verdict. Accepted — below 20 the figure is noise. The floor reads `attributableSpoken`, not `spokenTotal`, so a book pushed under it by id drift is silent rather than confidently wrong. |
| Chapter with 6 spoken lines, all narrator | Shows `100%` in the breakdown; does **not** trigger (under the 20-line trigger floor). |
| User excludes back-matter after analysis | Live compute picks it up; the library badge is patched in the same session. |
| First-person book | See below. |
| **CJK book, cast present, dialogue in `「」`** | Resolves at `zh`/`ja`, `spokenTotal > 0`, so `ok` or `collapsed` on its real share — **never `missing`**. This is R-4C1. |
| **Language absent from `state.json`** | `detectManuscriptLanguage` resolves it; `languageSource: 'detected'`. Applies to 7 of the 20 live books, including the largest. (Revision 5 said "7 of 22" here and "7 of 20" elsewhere in the same document — R-6N6.) |
| **Language resolves to one with no conventions table** | `unmeasurable`, evaluated before `missing`. Not badged, not gated, but visible. **No live producer today** — all seven registry languages have tables — so this arm is defensive, and the reachable producer is the contradiction row above. |

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

**Wave 1 — pure metric (Vitest, server).** `narratorIdSpoken` counts **both**
`narrator` and `char-narrator` — the `char-narrator` case is asserted explicitly,
since matching only `'narrator'` is the exact regression #1895 centralised the
constant to prevent; excluded chapters and `excludeFromSynthesis` removed from
both numerator and denominator; zero spoken → `0/0` handled; `quietCastCount` at
exactly 1 and 2 lines; `dashOnlySpoken` counts a dash-prefixed sentence with no
quote mark and does not count a dash-prefixed sentence that also contains one.

**Wave 1 — D9's exclusion, and it needs a fixture built to fail** (R-6C1). The
assertion is that `orphanSpoken` is populated **and the share does not move**.
A fixture with one orphan among a hundred lines cannot distinguish the two
formulas at the precision anyone will read, so the fixture is built with the
orphan count comparable to the narrator-id count — summing them changes the
share by tens of points, and the test observably goes red when D9 is mutated
back to a sum. The paired assertion is that `orphanIds` lists the distinct
unresolvable ids, since a count alone cannot drive the drift surface.

The resolver half needs its own care: **the cast-resolver test passes with
`buildCastResolver` removed entirely unless the retired id is the narrator's
own.** The fixture therefore retires `char-narrator` → `narrator`, not an
ordinary character, so deleting the resolver changes the numerator rather than
merely the orphan column.

**Wave 1 — the denominator and the language chain.** `isDialogueLine` returns
true for each language's own pairs and false for another language's (a `「」` line
is dialogue under `ja`, not under `en`); a declared `state.json` language wins
over detection and sets `languageSource: 'declared'`; a book with no declared
language resolves through `detectManuscriptLanguage` and sets `'detected'`; a
language with no conventions table yields `unmeasurable` **and never `missing`**,
asserted with a `castCount > 0` fixture so the precedence is what the test is
actually proving.

**Wave 1 — corroboration.** `detectManuscriptLanguage` is asserted to set
`fallback: true` on **both** surrender branches — the `letters === 0` pre-pass
(`:44`) and the `franc` miss (`:60`) — and `false` on a real match, with the
zero-letter case exercised by a sample of pure punctuation and numerals.
Corroboration itself is asserted to run **only** on the `missing` path: a healthy
book with a wrongly declared language stays `ok`/`collapsed` on its measured
share and does not become `unmeasurable`, because the guard must not be able to
suppress a real verdict.

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
**nowhere else**. (The underlying claim is confirmed on today's data — zero
`「`/`『` in any non-CJK cache — which is what makes the assertion safe to gate
on.)

**That replay is an on-box acceptance item, not a CI test** (R-6M2). The corpus
is gitignored and machine-local, so on any runner or fresh clone the walk finds
no books, the "differs on exactly two" assertion holds over an empty set, and the
check reports green having tested nothing — a vacuous pass, which is a failure
mode this repo has shipped before. It gets a register row and is run on the box.
CI's blast-radius coverage is the narrower, honest claim a fixture *can* carry:
that the new alternatives are anchored to `「」`/`『』` specifically, asserted by
mutating each new alternative in turn.

**Wave 2 — trigger.** Book-level at threshold ±1 sentence; a chapter trigger
firing while the book-level share is far below it; a chapter at 100% with 19
spoken lines **not** triggering and the same chapter with 20 triggering;
`triggeredBy` and `worstChapterId` correct in both directions.

**Wave 2 — the `missing` state (D11).** Nine fixtures that must resolve to
three different states, because the whole point of D11 is that revision 2
collapsed them into one:

| # | Fixture | `castCount` | `spokenTotal` | `analysis-state.json` | Expected |
|---|---|---|---|---|---|
| 1 | Pure-narration non-fiction | 0 | 0 | absent | `ok` |
| 2 | Cast built, nothing attributed, run abandoned | > 0 | 0 | absent **or 0 bytes** | `missing` |
| 3 | Cast built, nothing attributed, run **paused** | > 0 | 0 | `state: 'paused'` | `ok` — the pill owns it |
| 4 | **Book never analysed, no cache** | — | — | — | `ok`, reported `not analysed` |
| 5 | **Healthy `ja` book, dialogue in `「」`** (R-4C1) | > 0 | **> 0** | absent (run completed) | `ok` |
| 6 | **Healthy `de` book, dialogue in bare `»…«`** (R-5C2) | > 0 | **> 0** | absent | `ok` |
| 7 | **`en`-declared book whose text is not English** (R-6C2) | > 0 | 0 | absent | `unmeasurable` |
| 8 | **Sentences present but unidentifiable** — pure punctuation/numerals, `letters === 0` | > 0 | 0 | absent | `unmeasurable` |
| 9 | **Cast built, cache holds ZERO sentences** — the real Night Watch shape | > 0 | 0 | absent **or 0 bytes** | `missing` — corroboration skipped |

Each row disproves a different way of writing the rule too loosely, and a test
that omits any of them lets that looseness ship:

- Omit row 1 → `spokenTotal === 0` alone passes, badging every non-fiction book.
- Omit row 3 → dropping the `readAnalysisState` clause passes, badging every
  paused analysis.
- Row 2's **0-byte** variant is the real Night Watch file; a fixture using only
  an absent file leaves the unparseable path unproven.
- **Row 4 changed expectation in revision 6.** Revision 5 fixed the
  never-analysed rule in prose and left this row reading `unmeasurable`
  (R-6M3) — the fixture would have *pinned* the defect the prose removed,
  turning the test suite into the thing defending it.
- Omit row 5 → a `spokenTotal` built on `isSpokenLine` passes, badging every
  CJK book and blocking its generation.
- Omit row 6 → the same defect in every language whose dialogue marks
  `isSpokenLine` misses; see below for why this row, not row 5, is the one that
  can prove it.
- Omit row 7 → the reachable form of that defect ships: an Italian or Polish
  book imported under one of the seven supported languages is badged as damaged
  and blocked from generating.
- Omit row 8 → `fallback` is implemented on one surrender branch only, and a
  book with no letters at all is answered `en` with full confidence.
- **Omit row 9 → the corroboration step disarms `missing` entirely.** An
  empty-cache book has no text to detect from, so detection surrenders and the
  guard downgrades the verdict — exempting the exact book D11 was raised on.
  Rows 2 and 9 look alike and are not: row 2 fixes `spokenTotal === 0` with
  narration sentences present, row 9 fixes it with **no sentences at all**, and
  only row 9 exercises the carve-out. A suite carrying row 2 alone passes with
  the carve-out deleted.

**Mutation controls. Revision 4's version of this table was itself a placebo**
(R-5C2), and the way it failed is worth keeping visible: it specified row 5's
control as "revert the denominator to `isSpokenLine`" — but part 2 of the same
revision teaches `isSpokenLine` to read `「…」`, so after both changes land the
reverted denominator still returns `spokenTotal > 0` and **row 5 does not move.**
One change in the revision disarmed the control of another.

| Mutation | Row 5 (`ja`) | Row 6 (`de`) | Row 7 (wrong lang) | Row 8 (no letters) | Row 9 (empty cache) |
|---|---|---|---|---|---|
| Denominator reverted to `isSpokenLine` | **unchanged** — part 2 covers `「」` | **flips to `missing`** | unchanged | unchanged | unchanged |
| Denominator reverted **and** part 2 reverted | flips to `missing` | flips to `missing` | unchanged | unchanged | unchanged |
| `unmeasurable`-first precedence deleted | unchanged | unchanged | **flips to `missing`** | **flips to `missing`** | unchanged |
| Corroboration step deleted (step 3) | unchanged | unchanged | **flips to `missing`** | **flips to `missing`** | unchanged |
| `fallback` set on `:60` only, not `:44` | unchanged | unchanged | unchanged | **flips to `missing`** | unchanged |
| **Empty-cache carve-out deleted** | unchanged | unchanged | unchanged | unchanged | **flips to `unmeasurable`** |

Row 9's mutation is the one that matters most and is the easiest to leave out,
because deleting the carve-out breaks **no other row in the table** — every other
fixture has text. That is precisely why it needs its own row: a control nothing
else can move is the only thing standing between D11 and a guard that exempts it.

**Row 6 is why the German fixture exists, and its text is now constrained**
(R-6C5). `»…«` is dialogue under `de.quotePairs` and invisible to `isSpokenLine`
even after part 2, which makes it the only row a *single* mutation can move —
but that property is a property of the **text**, not of the language, and
revision 5 constrained row 5's text while leaving row 6's free. Measured
2026-08-11:

| Fixture text | `isSpokenLine` |
|---|---|
| `»Lass das.«` | **missed** ✔ usable |
| `»Lass das«, sagte er, »sofort.«` | spoken ✘ |
| `»Ja.« »Nein.«` | spoken ✘ |

The embedded rule `/«[^»]+»/` matches the **attribution span between two turns** —
`«, sagte er, »` — so any sentence carrying a mid-line `sagte`, or two turns in
one sentence, is already spoken and the control is a placebo again, one level
down, in the row promoted to be the real proof. **Those are the idiomatic German
shapes**, so an implementer writing natural German reproduces R-5C2 by writing
well.

> Row 6's fixture sentences each contain **exactly one `»` and one `«`, in that
> order, with no second turn and no mid-line attribution.** The test asserts
> `isSpokenLine` is `false` on each of them *directly*, as a precondition, so the
> fixture fails loudly if someone later makes it read more naturally.

Row 5's fixture text must likewise contain **real `「」`-quoted dialogue attributed
to real cast members** — not merely CJK prose — or even the two-mutation control
does not move it.

**Storage.** `analysedAt` reads from `cache.updatedAt`, falling back to mtime
only when the field is absent; the dismiss endpoint resolves `analysedAt`
server-side; a cache write between dismiss and read re-arms.

**Routes.** GET computes and rewrites the stamp; a subset re-run recomputes the
whole book; corrupt cache → `unmeasurable`, not 500; `GET /api/library` carries
the four-state value, with a case for each of the four asserted.

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

**There is no expected distribution here, and that absence is the design**
(R-6C3). Revisions 4 and 5 each printed a per-book table of shares as the
"expected shape" of Wave 1's output. Both were wrong, in different ways:

| Revision | What it measured | Why it was wrong |
|---|---|---|
| 4 | `server/handoff/cache/*.json` | The cache directory is not the library. 54 of its 76 files have no book at all, and three orphans were headline rows — including both "collapsed" CJK books, which are deleted. The acceptance was unsatisfiable. |
| 5 (draft) | the books tree, walked naïvely | `.upgrade-backups/` holds whole copies of that tree, so dedupe-by-`manuscriptId` kept backup copies and reported their cast counts. |
| 5 (shipped) | the books tree, correctly | The **numerator** dropped D9's orphan half and skipped the excluded-chapter filter §Universe mandates. Three cast counts wrong, and one book's figure wrong by ~50 points. |

The pattern is one thing three times: **the table was hand-computed by a script
that re-implemented `isSpokenLine`, `buildCastResolver` and the universe filters
instead of calling them.** Each re-implementation got a different subset wrong,
and each wrong table was then quoted as an acceptance criterion — so a criterion
this spec could not satisfy, or worse could satisfy only by reproducing the bug.

**So the acceptance is the run, not the numbers.** Register row for Wave 1: run
`scripts/measure-attribution.mjs` against the live workspace and record its
output verbatim. That output — computed by the real modules, through the real
`computeAttributionMeasurement` — **is** the distribution, and it is the input to
the Wave 2 threshold decision.

What the run must show, all of it structural and none of it a share:

1. **A row for every live book**, none blank, with `not analysed` / `missing` /
   `unmeasurable` visibly distinct from each other and from a healthy row.
2. **`blindSpoken` non-zero on exactly the two live CJK books before the part-2
   change, and zero on both after, with no other row moving.** This is the direct
   measurement of R-4C1 and the only acceptance figure that survives — because it
   was independently re-derived twice, by the round-4 and round-5 reviewers,
   agreeing.
3. **`orphanSpoken` non-zero on the books that carry unresolvable ids** — 8 of
   the 20 as of 2026-08-11 — **and the share unaffected by it** (D9). A run
   reporting orphans everywhere-zero means the resolver was bypassed.
4. **`overcountSpoken` non-zero on a substantial minority of books**, alarmed on
   nowhere — see §The gap column.
5. **The two historical CJK collapses do not appear**, because their books are
   deleted and the script walks the library. Their absence is the check that the
   script did not start from the cache directory.

**No live book has a one-character cast**, so revision 4's "cast-1 book at 96.2%
must not read as damaged" check is gone with the orphan it referred to. **That
check has no live proof and the D11 fixture row is its only evidence** — one more
reason not to drop it.

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
- **The German gap in `isSpokenLine` — three of the four `de.quotePairs` forms,
  not one.** `»…«` is missed in both positions; `„…”` and `„…"` are missed when
  the turn is embedded rather than leading, and `de.ts:7-9` records those two
  ASCII/`”` closers as what real manuscripts routinely use. Recorded as a known
  limitation (R-5M2, widened by R-6C4), not fixed: fixing it means touching the
  quote rules the analyzer acts on for a language with a live book, which is the
  wider blast radius this spec has consistently declined. Revision 5 named one
  form of three here, which understated a limitation the reader is being asked to
  accept.
- **Connecting `orphanSpoken` to the Cast orphan banner.** The measurement
  reports unresolvable ids (D9); routing them to the surface that can repair
  them — #2238's accept-a-match affordance — is a follow-up, filed rather than
  folded, so this spec stays a measurement plus a warning.
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
6. **A book with a corrupt cache neither 500s nor reads as healthy** — in the
   library as well as in the Cast view. A book with **no** cache at all is a
   different case and reads `ok`: it has never been analysed, so no claim is made
   about it (R-6M3 — revision 5 stated the rule correctly in prose and left this
   criterion, the states table and a fixture row all asserting the opposite).
7. The backfill stamps every existing book; the books Wave 1 identified as
   damaged badge, and books Wave 1 measured as healthy do not.
8. A book with a cast and no attributed sentences badges as `missing` and gates
   generation. **The named case is spent:** _Ночной дозор_ was re-analysed on
   2026-08-06 and is no longer an example of this state — it is a `collapsed`
   candidate. The state stays reachable on the normal path (cancelling an
   analysis is ordinary use), but it no longer has a live instance, so row 2 of
   the D11 fixture table is the only proof available and must not be dropped for
   lack of a real book. (Revision 5 quoted a cast count and a share here; both
   were wrong, and quoting them made this criterion load-bearing on a number
   nobody had re-derived — R-6C3.)
9. **A Chinese or Japanese book with attributed dialogue is neither badged nor
   gated** (R-4C1). Asserted against a `「」` fixture, with the mutation control
   from the D11 table.
10. **`blindSpoken` matches its recorded per-language baseline.** A *change* from
    that baseline is a finding; a standing non-zero value on a known gap is not.
    The German baseline is non-zero for **three** of four `de.quotePairs` forms,
    not one (R-6C4) — a baseline recorded from today's single `„`-at-position-0
    German book would read 0 and alarm on the next German import.
11. **An unresolvable `characterId` never badges a book on its own and never
    moves the share** (D9). A book whose only anomaly is id drift shows no
    collapse notice and no generation gate.

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
| R-4M3 | Major | A conventions denominator needs a language label, and **7 live books have none** (the finding said "of 22"; the corpus is 20 — R-6N6) — including the largest in it. Naïvely applied it would render them all `unmeasurable` | `detectManuscriptLanguage` fallback specified as step 2, with `languageSource` recorded |
| R-4Mi1 | Minor | Acceptance criterion 8 named Night Watch's 2026-08-06 state as the proof case for `missing`; that state no longer exists | Criterion rewritten — the fixture row is now the only proof, and is marked not-droppable |
| R-4Mi2 | Minor | "This spec changes no analyzer behaviour" and §Out of scope's "any change to the analyzer, including `isSpokenLine`" both became false | Both amended, with the single permitted change named explicitly |
| R-4Mi3 | Minor | **Found in revision 4's own self-review.** The gap was first specified as a single signed field, `blindSpoken = spokenTotal - pipelineSpoken`. The two definitions diverge in both directions, so an English dash book reads **−58**, making the acceptance criterion "`blindSpoken` is 0 across the corpus" false on healthy books | Split into `blindSpoken` and `overcountSpoken`, with only the former alarmed on |

**Round 4 — Premium adversarial gate on revision 4, 2026-08-10. Verdict: not
safe to approve.** Twelve findings; every one re-verified against the tree or the
workspace before folding, and two of the reviewer's own claims corrected in the
process (noted below).

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-5C1 | Critical | **Revision 4's empirical basis was the cache directory, not the library.** (The reviewer said "9 of 31 caches are orphans" and revision 5 repeated it; re-derived independently in revision 6, it is **54 of 76** — the finding whose whole content is *get the empirical basis right* stated a wrong empirical basis.) Three orphans were headline rows of the on-box table — including both "collapsed" CJK books at 99.2%/97.8%, which are **deleted**. The live CJK books measure 2.9% and 1.6%. The acceptance "the two CJK books must appear at all" was unsatisfiable | §On-box acceptance rebuilt from a workspace-joined measurement of all 20 live books; R-4M2 restated as historical evidence |
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

**Round 5 — scoped re-review of revision 5, 2026-08-10. Verdict: not safe to
approve.** Every round-4 fix was re-tested against the tree and the workspace:
**3 of 12 failed** (R-5C1, R-5C3, R-5M2), **2 more failed on their numbers**
(R-5Mi2, R-5Mi3), 3 were partial, 4 held, and the folding introduced **6 new
defects.** Every finding below was re-verified independently before folding, and
one of the reviewer's own figures was corrected in the process.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-6C1 | Critical | **The measurement backing revision 5 was not the metric revision 5 defines.** Its shares reproduce only with the orphan half of D9 dropped and the excluded-chapter filter off — so the document carried two incompatible definitions of its own metric, and the acceptance used the one §Universe forbids. Under the spec's own rules one book moved by ~50 points | **D9 narrowed** (owner's decision): the share counts narrator ids only; `orphanSpoken`/`orphanIds` report alongside it and never inside it. `narratorSpoken` **deleted** as a field — an ambiguous name is what let a third formula in. Rationale written out in §Numerator |
| R-6C2 | Critical | **`unmeasurable` still had no live producer.** `fallback` fires only when detection runs, and detection runs only when `state.language` is absent — but `import.ts:258-266` normalises and hard-rejects, so every book has one. The reachable hole is **declared-but-wrong**: an Italian book must be imported as one of the seven, is measured against the wrong conventions, and lands in `missing`. R-4C1 in another alphabet, untouched | Step 3 rebuilt as **corroboration on the `missing` path**: when a `missing` verdict is imminent, detection is run over the book's own text and a contradiction (or a surrender) yields `unmeasurable`. Precedence re-justified on that producer; two fixture rows and a mutation added |
| R-6C3 | Critical | **The pre-computed distribution was wrong for the third time in three revisions**, and its figures had become load-bearing — quoted in Wave 2 criterion 8 and in §The metric. Three cast counts wrong (34/32/14 stated as 27/26/12); _Unlocked_'s "13.6% → 14.6%" was one denominator with and without a filter, and the real move is a **drop** | **The distribution is deleted.** §On-box acceptance now specifies the *run* and five structural checks, none of them a share. The one surviving figure — `blindSpoken` on the two CJK books — is the one two independent reviewers re-derived and agreed on |
| R-6C4 | Critical | **Revision 5 overruled the round-4 reviewer on the German gap and the overrule was wrong.** Measured: leading position catches 3 of 4 forms, embedded catches **1** of 4. `de.ts:7-9` records the two forms that fail when embedded as the ones real manuscripts routinely use | Corrected with the measured table in §The gap column; §Out of scope and Wave 2 criterion 10 widened from one form to three |
| R-6C5 | Critical | **Row 6's German fixture was unconstrained, so the control it exists to provide is a placebo again.** `/«[^»]+»/` matches the attribution span *between two turns*, so `»Lass das«, sagte er, »sofort.«` and `»Ja.« »Nein.«` are already spoken — the idiomatic shapes. Only a bare single turn is missed | Fixture text constrained to exactly one `»…«` per sentence with no mid-line attribution, plus a **precondition assertion** that `isSpokenLine` is false on each fixture line, so the fixture fails loudly if it is later made to read more naturally |
| R-6M1 | Major | The pure/impure split was drawn for `readAnalysisState` and not for the language chain: step 1 reads `state.json`, yet Wave 1 criterion 1 put `detectManuscriptLanguage` inside the module it requires to be pure | Same split applied: one impure `resolveBookLanguage(bookDir, sentences)` returns `{ language, languageSource }`; the pure metric receives it |
| R-6M2 | Major | The corpus replay (R-5Mi1's fix) was specified as a Wave 1 paired regression, but the corpus is gitignored and machine-local — on CI or a fresh clone it asserts over an empty set and **passes vacuously** | Moved to on-box acceptance with a register row; CI keeps the narrower fixture-level claim, mutating each new alternative in turn |
| R-6M3 | Major | R-5M4's fix landed in prose only. Three normative places still said the old thing — the states-table rule cell, the D11 fixture row "No cache at all → `unmeasurable`", and Wave 2 criterion 6. The fixture row would have **pinned** the defect the prose removed | All three corrected; the states-table cell is now the normative statement and the prose explains it |
| R-6N1 | Minor | `fallback` was defined as true "ONLY on the `: result('en')` branch" — there are **two** surrender branches; `detect-language.ts:44` returns `en` when the sample has no letters at all | Both branches set `fallback`; fixture row 8 and a dedicated mutation added |
| R-6N2 | Minor | The `AttributionMeasurement` block declared `languageSource: … \| null` 27 lines below prose calling that arm "dead type" — and the block is what an implementer copies | Interface corrected to `'declared' \| 'detected' \| 'unknown'`, with the `language === null` pairing asserted |
| R-6N3 | Minor | "7.1k–13.6k sentences each" for the no-language books is wrong at the low end by 26× — one is a short story | Range deleted; the claim it supported does not need it |
| R-6N4 | Minor | R-5Mi4 corrected the three `persistDroppedQuotesBatch` line numbers and then named `:5740` for `analysis-chapters` in the next sentence | Corrected to `:6208` |
| R-6N5 | Minor | §The panel fix still cited the pre-correction `:3184`/`:3824` | Corrected to `:3568`/`:4209`, with what makes them mutually exclusive named |
| R-6N6 | Minor | "7 of 22 live books" and "7 of 20 live books" both present | Both now 20 |

**Two corrections to the reviewer, verified before folding.** The unresolvable-id
count is **8 of 20 books**, not the six the report lists — it missed the `zh`
translation and one other, measured through `buildCastResolver` with each book's
real `cast-id-history.json`. And the orphan-cache arithmetic re-derived
independently is **76 caches / 20 live books / 2 trashed / 54 orphans**, which
matches the reviewer exactly and settles revision 5's "nine of the 31".
