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

### Bonus data defect: duplicate roster id

The ch44 roster carries both `unknown-male` (alias `"The Torment"`) **and** a separate
`the_torment` id. The model answers `the_torment`; truth says `unknown-male`; scored
wrong though semantically identical. This silently depresses the whole ch44 number
independent of either cause above.

## Approach — two loosely-coupled workstreams, sequenced measure-first

### ① Corpus hygiene (lands first, re-baselines)

- **Hand-edit** `server/src/analyzer/attribution-eval/corpus/playing-with-fire-ch44.en.labelled.json`:
  relabel the continuation-as-`narrator` lines to their actual speaker. Scope strictly
  to lines the surrounding quote run unambiguously assigns (a continuation sentence
  inside a single speaker's quoted turn). A surgical, reviewable diff; each edit
  documented in the plan.
- **Dedup the roster** (`playing-with-fire.roster.json`): remove `the_torment`; its
  `"The Torment"` / `"Torment"` aliases already live on `unknown-male`. (Confirm no
  other fixture line's `speakerId` references `the_torment`; if any do, repoint them.)
- **Re-run ch44** → record the **true** raw / det / final baseline. This quantifies how
  much of the −2.6 was ever real, *before* any engine change.

> The corpus is git-ignored (copyrighted book text). These edits are to the local
> working corpus; the plan records the exact before/after label set so the change is
> reproducible against a fresh capture. The committed Coalfall guardrail is untouched.

### ② Parser fix — a tag-name must be the *speaker*, not an addressee/bystander

**Principle (preserves rule #2):** a `findRosterName` match becomes a **strong
`tag-name`** only when it is the **subject** of the speech/beat verb. A name in
addressee or bystander position is not the speaker; the span falls through to the
existing pronoun path.

**Decided heuristic — addressee reject-list (over verb-adjacency), resolved against the
verb position:**

- A roster name appearing **before** the speech/beat verb is the subject → **accept**
  (`Anton said`, `Sanguine said, shaking his head`). Adverb gaps (`X slowly said`) are
  before-verb → unaffected — this is why the reject-list is safer than a strict
  adjacency allow-list.
- A roster name appearing **after** the verb is accepted only as a clean inverted
  subject (`said Anton`) — i.e. **rejected** when separated from the verb by:
  - an **addressee preposition** (`to` / `at` / `toward(s)` / `for` / …), or
  - a **coordinating conjunction** introducing a bystander clause (`and` / `but` +
    name + its own verb).
- On rejection, `applyTag` proceeds to `classifyPronoun` exactly as if no name were
  found. `"he said to Valkyrie"` → `he` → male → window resolves to the unique male
  participant (Skulduggery), **or an honest flag** if the male is ambiguous. **Worst
  case: a confident-wrong becomes a flag** — a strict trust improvement.

**Extension point:** an optional `addresseePrepositions?: string[]` (and any bystander
conjunction set) added to `LanguageConventions` (`types.ts`), **English-populated**;
other languages default empty → **byte-identical to current behaviour**, matching the
established empty-table degrade pattern. The reject logic lives in `parser.ts`
(`applyTag` / a small position-aware helper); `findRosterName` gains a position-aware
variant or the caller re-scans the clause for the matched token's position. Rule #2 is
untouched — a genuine subject-name tag stays strong.

## Test plan

- **`parser.test.ts`** (unit, primary gate):
  - reject: `"he said to Valkyrie"` (addressee → pronoun `he`), `"a voice said and
    Valkyrie turned"` (bystander → no subject name).
  - keep-strong (regression guard): `"said Anton"`, `"Anton said"`, `"Sanguine said,
    shaking his head"`, `"X slowly said"` — all remain strong `tag-name`.
  - non-English convention with no `addresseePrepositions` → current behaviour intact.
- **Corpus / roster** validity: a small assertion (or capture-cli test) that no fixture
  `speakerId` references a removed roster id after the dedup.
- **Eval gate (on-box, iq4-32k, ≥3 runs), staged:**
  1. after ① — the true post-cleanup ch44 baseline (raw / det / final).
  2. after ② — the real lift; **no other fixture regresses** (ch43/45/46 + Coalfall
     guardrail within noise). Numbers recorded in `docs/features/265`.

## Risks & invariants

- **Rule #2 stays intact** (fix A, not fix B): we make the *evidence* more precise; we
  do not weaken strong-tag force-correction. The `247` invariant #2 text is unchanged.
- **False-negative risk** (suppressing a real subject tag) is bounded by the
  before-verb=always-accept rule and pinned by the keep-strong guards above; the eval's
  no-regression gate on the other fixtures is the backstop.
- **Corpus edits change the eval's own numbers** by design — the plan records the exact
  label deltas so the new baseline is auditable and reproducible.

## Out of scope

- Rule #2 / `crossExamine` force-correct **policy** changes (fix B).
- RU / DE addressee handling — the eval corpus is English-only today; the convention
  field ships empty for non-English (`#1759` will extend fixtures later).
- Escalation (`det → final` −0.6 is a separate, smaller lever).
- The `"Hey," → melissa-edgley` misfire (1 of 9, a name-bleed of a different shape) —
  **noted residual**: confirm whether it survives the re-measure during implementation
  rather than designing for it blind.

## Ship notes

(Filled at `stable`: commit SHA, on-box ① and ② eval numbers vs. the headline, any
behaviour delta vs. this design.)
