# ch44 residual: addressee-name tag fix + eval corpus hygiene — design

> Status: draft (design thread). Belongs to the attribution eval/tuning work stream
> ([`docs/features/265-attribution-eval-tuning.md`], invariant home
> [`docs/features/247-dialogue-structure-attribution.md`]). Sequenced as the item
> explicitly deferred "next after #1758".

## Goal

Recover the real ch44 raw→deterministic attribution loss by fixing one genuine
wrong-voice bug in the deterministic engine — an **addressee/bystander name inside a
tag clause anchored as a *strong* speaker** — while separating that real loss from
**eval-fixture label noise** that currently makes the loss look larger than it is.
Measure-first: clean the corpus and re-baseline before touching engine code.

## Problem / diagnosis (grounded, on-box)

A single chunked ch44 pass (`qwen36-cw-iq4-32k`) dumped every per-line raw✓→det✗ flip
joined with the `crossExamine` reason that caused it. **9 apparent regressions, net −7**
this run. Tracing each back to the ch44 text + roster splits them into two unrelated
causes:

### Cause 1 — real parser bug: tag-name matches a non-speaker name (≈5 of 9)

`findRosterName` (`name-matcher.ts`) is first-matching-token-wins with **no
subject/object awareness**. So the tag clause's *addressee* or *bystander* name is
minted as a **strong `tag-name`**, and rule #2 (strong tags outrank the model,
`247` invariant #2) faithfully force-corrects the model's *correct* answer to the
wrong character:

| Tag clause (real ch44 text) | Real speaker | `findRosterName` returns | Result |
|---|---|---|---|
| `"Fireball," he said to Valkyrie.` | Skulduggery (pronoun `he`) | **Valkyrie** (addressee, after `to`) | Skulduggery's 3 lines → Valkyrie |
| `"I overestimated you," a voice said and Valkyrie turned.` | the Torment (`a voice`) | **Valkyrie** (bystander, after `and`) | line → Valkyrie |

The speaker is a pronoun / non-name; the only roster name in the clause is an
addressee (`to X`) or a bystander in a conjoined clause (`and X <verb>`). Because it
mints a **strong** tag, even the model getting it right cannot survive.

### Cause 2 — eval-fixture label noise: det is right, the labels are wrong (≈4 of 9)

Every remaining "regression" is a **continuation sentence of a multi-sentence
utterance** mislabelled `narrator` in the committed ch44 fixture:

```
"Look at what you've done," Sanguine said. "…You have emerged triumphant…. Curse you."
                                             ^ fixture labels these narrator
```

The engine's **continuation exemption** (`247` invariant #3) *correctly* attributes
them to the speaker (Sanguine / the old man) — and is **scored as a regression for
being right**. The fixture violates the very invariant the engine implements. This
inflates the apparent det drop: the *true* ch44 raw→det loss is materially smaller
than the headline `81.8 → 79.2`.

### Bonus data defect: duplicate roster id (handled in scoring, NOT by editing the roster)

The ch44 roster carries both `unknown-male` (alias `"The Torment"`) **and** a separate
`the_torment` id. The model answers `the_torment`; truth says `unknown-male`; scored
wrong though semantically identical. **Do not delete `the_torment`** — the shared
`"The Torment"`/`"Torment"` tokens currently make the `torment` stem *ambiguous* in
`buildNameIndex` (`name-matcher.ts:16-22`) and therefore **dropped**, so "Torment"
never anchors. Deleting the id makes the stem *unique → it would start anchoring as a
strong `tag-name`*, silently mutating parser behaviour mid-measurement. The correct fix
is **scorer-side only**: wire the scorer's existing but unused `aliasMap`/`resolveId`
seam (`scorer.ts:31-38`, currently called with no map at `run-eval.ts:78`) to
canonicalize `the_torment → unknown-male`, sourced from an explicit equivalence list —
the roster and name index are untouched.

## Approach — three deltas over ONE frozen model sample

The whole item is motivated by a single-run `81.8 → 79.2`. Raw attribution varies
run-to-run (model sampling) and the deterministic pass is a pure transform of *that
run's* raw — so re-querying the model at each stage would make the "lift" a comparison
of **different** raw inputs, i.e. indistinguishable from noise. **The design is
therefore built on a frozen-raw A/B, not staged re-runs** (see Measurement below). The
three deltas — two scoring-side, one engine-side — are all evaluated over the *same*
captured raw.

### ① Fixture label cleanup (scoring-side)

- **Hand-edit** `server/src/analyzer/attribution-eval/corpus/playing-with-fire-ch44.en.labelled.json`:
  relabel the continuation-as-`narrator` lines to their actual speaker. **Scope is
  strict:** only a sentence whose **own text is quoted** and which sits in an
  *uninterrupted single-speaker quoted run* (never a genuine interleaved beat such as
  `"Look." Sanguine turned. "You've won."` — the middle stays narrator). The plan
  **records each relabelled line's quoted text + new speaker** so a reviewer can verify
  every flip against the quotation *without the (git-ignored) book* — the diff is
  otherwise unreviewable, and "unambiguously assigns" must not be a self-serving
  assertion by the person raising the score.

### ② Scorer alias canonicalization (scoring-side)

- Wire the `aliasMap` described under "Bonus data defect" above (`the_torment →
  unknown-male`). Pure eval-side; no roster or parser change.

### ③ Parser fix — a tag-name must be the *speaker*, not an addressee/bystander

**Principle (preserves rule #2):** a roster-name match becomes a **strong `tag-name`**
only when it is the **subject** of the speech/beat verb. A name in addressee or
bystander position is not the speaker; the span falls through to the existing pronoun
path.

**Decided heuristic — addressee reject-list, resolved against the verb position
(language-general, per-language marker data):**

- A roster name appearing **before** the speech/beat verb is *treated as* the subject →
  **accept** (`Anton said`, `Sanguine said, shaking his head`; adverb gaps like
  `X slowly said` are before-verb, unaffected). We take the **nearest** name before the
  verb — which as a bonus resolves perception frames (`"…," Valkyrie heard Skulduggery
  say.` → nearest-before-`say` is `Skulduggery`, not the leftmost `Valkyrie`). Whether
  it fully lands is confirmed at measure time; until then it stays on the residual list,
  not claimed as fixed.
- A roster name appearing **after** the verb is accepted only as a clean inverted
  subject (`said Anton`, `сказала Майрин`, `sagte Meister Oduvan`) — i.e. **rejected**
  when separated from the verb by any of:
  - an **addressee preposition** (`to`/`at`/… · de `zu`/`an` · es `a` · fr `à` · ru `к`),
  - a **bystander conjunction** (`and`/`but` · `und`/`aber` · `y`/`pero` · `et`/`mais` ·
    `и`/`но`), or
  - a **subject pronoun** — the language-general clause that makes **Russian's caseless
    dative** work: `сказал он Валери` ("said he Valkyrie[dat]") has no preposition, but
    the pronoun `он` between the verb and `Валери` marks `Валери` as the non-subject.
    Every `LanguageConventions` already carries `pronouns`, so this needs no new data.
- On rejection, `applyTag` proceeds to `classifyPronoun` as if no name were found.
  **Honest fall-through semantics (correcting the earlier draft's false "worst case =
  flag" claim):** the rejected span becomes a *pronoun/alternation* attribution whose
  correctness depends on window composition. In a clean window it lands right or flags;
  but gender resolution picks "the unique male **participant**" and two-party windows
  run **alternation fill** (`windows.ts:62-66, 71, 99-101`) → `source:'alternation'`,
  bucket `corrected` — **so rejection can produce a *new* confident-wrong in a
  male–male window.** This is a strict improvement *in expectation* (a strong-tag error
  is unconditional; the pronoun path is right whenever the window is clean), **not
  unconditionally**. The eval must therefore assert the rejected lines specifically do
  not regress, including a male–male window case.

**Contracts to pin (were underspecified):**

- `findRosterName` returns only the first id, no position — insufficient for
  `"Skulduggery said to Valkyrie"` (accept the *earlier* subject, reject the later
  addressee). Replace with a concrete `findSubjectName(text, index, conv) →
  { id, tokenStart } | null`: enumerate **all** roster-name occurrences with token
  offsets, return the first in subject position.
- **Token-boundary matching, not substring.** `hasStem` is substring (`parser.ts:16-18`:
  `call`⊂"recalled", `add`⊂"saddle", `say`⊂"essay"), so verb/preposition *positions*
  computed via substring are phantom. The subject/verb/preposition logic keys on
  tokenized words with boundaries.
- **Closed preposition set** — an explicit, tested list (`to`, `at`, `toward`,
  `towards`, `for`; **no `…`, and explicitly excluding `from`/`of`**, which sit before
  real inverted subjects: `came a shout from Skulduggery`).

**Extension point:** optional `addresseePrepositions?` + `tagClauseConjunctions?` on
`LanguageConventions` (`types.ts`), **populated for every supported language**
(en/de/es/fr/ru) with its own markers. Presence of `addresseePrepositions` is the
per-language opt-in; an **unsupported/unknown language resolves to the empty convention
table** (no markers, no verbs) → `findSubjectName` finds no verb → legacy first-match →
**byte-identical** (247 invariant #4 preserved). Reject logic lives in `parser.ts`. Rule
#2 is untouched — a genuine subject-name tag stays strong.

**Why language-general, not English-only:** the bug is not English-specific
(`sagte er zu X`, `le dijo a X`, `dit-il à X`, `сказал он Валери` all mis-anchor a
non-speaker today). The logic is one algorithm keyed on per-language marker data plus the
shared `pronouns`; the existing dialogue-structure suite (incl. the RU dash fixture and
the DE #1598 cases) uses only clean subject/inverted tags and stays green (verified: no
test asserts the old addressee behaviour). **Measurement caveat:** the eval corpus is
English-only, so the *quantified* lift is English; ru/de/es/fr correctness rests on
per-language unit tests + the green existing suite, with real-book acceptance for those
languages deferred to `#1759`'s fixtures. This is a correctness fix (removing a provable
wrong-anchor), not model/language tuning — so shipping it for all languages now is
right, even though only English is eval-measured.

## Measurement — frozen-raw A/B (the load-bearing methodology)

- **Freeze once:** capture the model's raw stage-2 output for ch44 over N runs (N≥3),
  persist to disk. This is the *only* model interaction.
- **Replay deterministically:** the ③ parser fix is gated behind the (empty-by-default)
  `addresseePrepositions` field, so **off vs on is a same-process toggle** — run the
  deterministic pass (parser + `crossExamine`) over each frozen raw run with the
  reject-list **off** (baseline) then **on** (treatment). The engine delta is now pure:
  identical raw both sides, no re-query. `diff-runs.ts` gives the changed-line list.
- **Attribute each delta separately** over the same frozen raw: (①+②) scoring-only
  change with reject-list off shows how much was *label/alias noise*; (③) reject-list
  off→on under the cleaned labels shows the *real engine lift*.
- **Guards:** no other fixture regresses under the same frozen-raw replay — name the
  specific committed **Coalfall** assertion(s) that must not move (the plan cites them);
  ch43/45/46 changed-line count from ③ is reported, not hand-waved. Numbers land in
  `docs/features/265`.

## Test plan

- **`parser.test.ts`** (unit, primary gate):
  - reject: `"he said to Valkyrie"` (addressee → pronoun `he`), `"a voice said and
    Valkyrie turned"` (bystander → no subject name).
  - keep-strong (regression guard): `"said Anton"`, `"Anton said"`, `"Sanguine said,
    shaking his head"`, `"Skulduggery said to Valkyrie"` (earlier subject accepted,
    later addressee ignored), `"came a shout from Skulduggery"` (`from` NOT an addressee
    marker → still strong).
  - non-English convention with no `addresseePrepositions` → current behaviour intact.
- **`name-matcher.test.ts`**: `findSubjectName` token-offset + token-boundary cases
  (multi-name clause; substring non-match like `essay`/`recalled` must not register as
  a verb).
- **Scorer**: `aliasMap` canonicalization (`the_torment`≡`unknown-male`) unit case in
  the scorer/harness tests; the roster file is unchanged.
- **Eval gate:** the frozen-raw A/B above — (①+②) noise share, (③) real lift, no
  fixture regresses (incl. the named Coalfall assertion + a male–male-window
  non-regression assertion for the rejected lines).

## Risks & invariants

- **Rule #2 stays intact** (fix A, not fix B): we make the *evidence* more precise; we
  never weaken strong-tag force-correction. The `247` invariant #2 text is unchanged.
- **Fall-through is not unconditionally safe** (see ③): rejection trades a strong-tag
  error for a pronoun/alternation attribution that can mis-fire in a male–male window —
  bounded by the eval's rejected-line non-regression assertion, not by assumption.
- **False-negative risk** (suppressing a real subject tag): bounded by the keep-strong
  guards (incl. `from`/`of` exclusion) and the frozen-raw no-regression gate.
- **Measurement honesty:** frozen-raw A/B isolates the engine delta from sampling; the
  fixture relabels are recorded quotation-by-quotation so raising the score can't hide
  a mislabel.

## Out of scope

- Rule #2 / `crossExamine` force-correct **policy** changes (fix B).
- **Non-English *measurement*** (not the fix itself) — the eval corpus is English-only,
  so ru/de/es/fr get the same fix + unit tests now, but their *quantified* acceptance is
  deferred to `#1759`'s fixtures. The convention markers ship populated for all five.
- Escalation (`det → final` −0.6 is a separate, smaller lever).
- **Residual checklist (post-measure, not designed-for blind):**
  - The `"Hey," → melissa-edgley` misfire (1 of 9, a name-bleed of a different shape) —
    confirm whether it survives the frozen-raw replay.
  - The perception-verb frame (`Valkyrie heard Skulduggery say`) — nearest-name-before-
    verb *should* now resolve it (→ `Skulduggery`); confirm at measure time before
    claiming it fixed.

## Ship notes

(Filled at `stable`: commit SHA, frozen-raw A/B numbers — (①+②) noise share and (③)
engine lift vs. the `81.8 → 79.2` headline — any behaviour delta vs. this design.)
