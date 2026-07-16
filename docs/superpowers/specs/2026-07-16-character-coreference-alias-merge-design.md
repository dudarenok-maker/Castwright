# Character coreference — Tier-3 alias merge

**Issue:** #1662 — "Character coreference: same person under different display
names not merged (шеф = Борис Игнатьевич = Гесер)"
**Date:** 2026-07-16
**Status:** draft
**Sibling work (shipped):** Mechanism 1 —
`docs/superpowers/specs/2026-07-15-character-dedup-liveview-and-carryover-design.md`
(live-view dedup + carryover self-reconciliation, merged #1666).

## Problem

The analyzer's roster dedup collapses characters that share a **normalized
name**, but cannot merge a single character detected under **different display
names**. On _Ночной дозор_ (Sergei Lukyanenko, Russian), one character appears
as three separate cast rows — `шеф` (id `boss`), `Борис Игнатьевич`, and
`Гесер` — all the same person. They survive as distinct cast members with
distinct designed voices.

`dedupeRosterByName` (`server/src/analyzer/roster-dedup.ts`) merges only:

- **Tier-1** — exact `normaliseNameKey(name)` match, gender-gated, auto-merge.
- **Tier-2a** — token-subset (`Борис` ⊂ `Борис Игнатьевич`), single superset,
  auto-merge.
- **Tier-2b** — diminutive → _suggestion only_.

None of these can know that `шеф` (a role word), `Борис Игнатьевич` (given +
patronymic), and `Гесер` (a separate proper name) denote one person. It is a
semantic coreference judgment, not a string operation.

## Key insight: the evidence already exists

The model frequently records the coreference as **aliases**. In the observed
`cast.json`, the `Борис Игнатьевич` row carried `aliases: ['Гесер', 'шеф']`, and
the `boss`/`шеф` row carried `aliases: ['Борис Игнатьевич']`. The equivalence is
already captured in `character.aliases` — nothing currently uses cross-row alias
evidence to collapse the roster. This is the signal Tier-3 exploits, with **no
schema or prompt change** required.

## Chosen approach

Approach "1 feeding 3" from the issue: a new **Tier-3 alias-coreference pass** in
`roster-dedup.ts` that **auto-merges where the alias evidence is strong** and
**emits a user-confirmable suggestion where it is weak-but-distinctive**.

Rejected alternatives:

- **Analyzer-emitted coreference edges** (new "same-as" prompt field) — richer,
  but requires a prompt change and reruns of every cached analysis to benefit,
  when the alias data already carries the signal. Deferred, not for v1.
- **Pure suggest-only** — zero false-merge risk but leaves the obvious
  `шеф = Борис` duplicates standing on every analysis. The evidence-gated policy
  auto-cleans the strong cases and routes only the ambiguous ones to
  confirmation.

## Design

### Placement and data flow

A new Tier-3 pass runs inside `dedupeRosterByName`, **after Tier-2a**
(token-subset auto-merge) and **before Tier-2b** (diminutive suggestions):

1. Tier-1 exact-name auto-merge (unchanged).
2. Tier-2a token-subset auto-merge (unchanged).
3. **Tier-3 alias coreference (new)** — strong edges → auto-merge; weak
   distinctive overlaps → suggestions.
4. Tier-2b diminutive suggestions (unchanged).

Tier-3's rewrites join the **existing transitive-collapse loop** so a victim
that was itself a Tier-1/2a canonical still resolves to a single final id.
Tier-3's suggestions **concatenate** with Tier-2b's into the same returned
`suggestions[]`. Both the input signature
(`dedupeRosterByName(characters, sentences, { language })`) and the return
contract (`{ characters, rewrites, suggestions }`) are **unchanged** — Tier-3
needs no new inputs (the `notLinkedTo` guard was dropped, see Guards), so callers
(`dedupAndPrepare` in `server/src/routes/analysis.ts`, then `writeSuggestions` →
`pruneSuggestionsToRoster`) are untouched.

### Normalization

Each non-narrator row gets a normalized **name-key** (`normaliseNameKey(name)`)
and a normalized **alias-set** (`normaliseNameKey` applied to every string in
`aliases[]`, empties dropped). All Tier-3 comparisons operate on these
normalized forms so matching is diacritic/case/whitespace-insensitive and
consistent with Tier-1.

### Strong signal → auto-merge (union-find)

A candidate link exists when one row's _name_ appears in the other's
_name ∪ alias_ set:
`normaliseNameKey(A.name) ∈ B.aliasSet` (or the symmetric `B.name ∈ A.aliasSet`).
This is a deliberate "this specific other character is also known as X" claim by
the model. Whether that candidate link is **strong** (auto-merge) or **weak**
(suggestion) depends on the shape of the linking token:

- **Multi-token name link → strong (directional).** If the linking name has ≥2
  tokens after normalization (whitespace-separated, e.g. `Борис Игнатьевич` —
  given + patronymic, first + last), a one-directional match auto-merges. A
  full proper name is structurally very unlikely to be a _different_
  character's actual name, so directional trust is safe here.
- **Single-token name link → strong only if MUTUAL.** If the linking name is a
  bare single word (`шеф`, `Гесер`, `мать`), it auto-merges **only when both
  rows name each other** (`A.name ∈ B.aliasSet` AND `B.name ∈ A.aliasSet`). A
  one-sided single-token link downgrades to a weak suggestion (see below).

**Why the single-token mutuality gate exists.** A bare single-token name is
often a _role word_ that is simultaneously one minor character's whole name and
a principal's alias. Concretely: a minor doorman the model literally names
`шеф` (`name: "шеф"`), plus the principal `Борис Игнатьевич` carrying
`aliases: ["шеф", …]`. `normaliseNameKey("шеф") ∈ Борис.aliasSet` would, under
naive directional matching, **auto-merge the doorman into Boris** — a false
merge, and _more_ likely in the Russian/CJK role-word material this feature
targets. Requiring mutuality for single-token links defuses it: the doorman
never names Boris back, so it degrades to a suggestion the user can reject,
while the genuine `шеф ↔ Борис` case (mutual in the observed `cast.json`) still
auto-merges.

- Build a graph of **strong** edges only over non-narrator rows and compute
  **connected components (union-find)**. This collapses `шеф ↔ Борис ↔ Гесер`
  into **one** component even where two members never reference each other
  directly, provided each edge in the chain is strong (mutual for bare words,
  or directional via a multi-token name). A member reachable only through a
  weak edge is _not_ pulled into the component — it surfaces as a suggestion
  against the survivor instead.
- Each component merges into a single survivor chosen to **prefer the real
  name** (see "Survivor selection"). Field merge uses the existing
  `mergeCharacterFields` (already unions names+aliases, longest description,
  deduped evidence, tone, gender, ageRange).
- For every non-survivor member, record `rewrites[victim.id] = survivor.id` and
  drop it from the roster. Sentence reattribution happens through the existing
  rewrite map applied in `dedupAndPrepare`.

### Survivor selection (prefer the real name)

Tier-3's survivor determines the **user-visible name and id** of a principal
(unlike Tier-1/2a, whose members share a name, making the choice moot). "Most
lines" alone would often crown a role word — `шеф` recurs in dialogue tags far
more than the formal `Борис Игнатьевич` — so the merged principal would display
under the role word. The survivor is therefore chosen by, in order:

1. **Most name tokens** — a fuller proper name (`Борис Игнатьевич`, 2 tokens)
   beats a bare word (`шеф`/`Гесер`, 1 token). Cheap, language-agnostic, and it
   picks the desired survivor in the motivating case.
2. **Most attributed lines** — tiebreak among equal-token names.
3. **Earliest roster order** — final deterministic tiebreak.

The survivor keeps **its own original id** (not a freshly derived `safeId`), so
its line count stays accurate and no extra id remap is introduced; all other
members rewrite onto it.

### Weak signal → suggestion (distinctive-only)

After strong merges, over the **surviving** rows, a pair becomes a
`MergeSuggestion` in either of these cases — but **only when the shared/ linking
name string appears on exactly two rows** in the roster (a distinctive
descriptor, not a broadly-tagged role word):

- **Downgraded single-token link** — a one-sided bare-word name link that failed
  the mutuality gate (e.g. the `шеф`-doorman ↔ `Борис` case above): the doorman's
  name `шеф` appears on exactly two rows (its own name + Boris's alias) → one
  suggestion.
- **Shared third-party alias** — two rows share an alias where **neither's name
  links the other** (no candidate link at all), and that alias appears on exactly
  two rows.

A name/alias string present on **3+ rows** is treated as a generic role word
(`the guard`, `мальчик`) and emits **nothing** — this keeps the cast page from
flooding with low-value cards.

Suggestion shape matches the existing contract:
`{ sourceId, targetId, reason }`, with `source = fewer lines`,
`target = more lines` (tie → stable order), mirroring Tier-2b. Reason string,
e.g. `Both known as «the Reaper»`.

### Guards (apply to both strong merges and weak suggestions)

- **Gender gate** — reuse `gendersConflict`; two rows with conflicting _concrete_
  genders produce neither a merge nor a suggestion. (Absent gender on either side
  does not block, matching existing tiers.)
- **Single-token mutuality gate** — the primary false-merge guard, described
  under "Strong signal" above: a bare-word name link auto-merges only when
  mutual, so a role-word-named minor is never directionally absorbed into a
  principal.
- **Never touch `narrator`** — the existing `NARRATOR_ID` skip is preserved
  throughout Tier-3.

**`notLinkedTo` is deliberately NOT a Tier-3 guard.** The issue named it, but the
code shows it is the wrong instrument: `notLinkedTo` is a **cross-book** series
annotation for the voice matcher — `cast-not-linked-to.ts` rejects same-book
pairs outright (_"not-linked-to is for CROSS-book pairs; use cast/merge for
same-book duplicates"_) and it is consumed only in `voice-override-linked.ts` to
suppress cross-book voice reuse. Its entries point at **other books'** character
ids, and the field is not present on the fresh `stage1.characters` that
`dedupeRosterByName` sees anyway. Wiring it in would guard nothing real while
reading as protection that cannot fire. Tier-3 relies instead on the
single-token mutuality gate + gender gate. **There is no in-book "these two are
different people" signal in the system today** (same-book separation is a
`cast/merge` action, which records merges, not keep-aparts); adding one is a
noted follow-up, out of scope here.

### Ordering / interaction notes

- Tier-3 runs on the roster **after** Tier-1/2a have already collapsed
  exact-name and token-subset duplicates, so it only ever adds merges/suggestions
  among rows those tiers left standing. Tier-1/2a behavior is untouched.
- **Hard invariant: Tier-3 MUST run before `foldMinorCast`.** The fold rolls
  every folded background character's name into the `Unknown male`/`Unknown
  female` bucket's `aliases` (`analysis.ts:4318`). If Tier-3 ran _after_ the
  fold, those accumulated names would turn the two Unknown buckets into
  strong-edge magnets and mis-merge unrelated principals. The current call order
  (`dedupAndPrepare` at `analysis.ts:4264`, then `foldMinorCast` at `:4305`)
  already satisfies this; the invariant must be preserved.
- Tier-3 rewrites are folded into the existing post-Tier-2a transitive-collapse
  loop (or an equivalent pass positioned to see Tier-3 edges) so all rewrite
  chains resolve to a single final id before return.
- `pruneSuggestionsToRoster` continues to drop any suggestion whose source/target
  id is not a standing row after the later `foldMinorCast` pass — Tier-3
  suggestions are subject to the same pruning, so a weak suggestion pointing at a
  row that a later fold removed is discarded automatically.

## Blast radius / correctness

- **Language-agnostic.** Named-linkage is pure normalized set membership — no
  per-language role-word table. Russian patronymics, English nicknames, and CJK
  all work identically.
- **The `Captain A` / `Captain B` false-merge is structurally excluded.** Neither
  name is in the other's aliases, so there is no strong edge and no auto-merge;
  and if `the Captain` is aliased on 3+ rows, no weak suggestion either. If it is
  on exactly two genuinely-distinct rows, the worst case is a single _suggestion_
  the user declines — never an auto-merge.
- **The role-word-as-name false-merge is defused by the mutuality gate.** The
  harder case — a minor character whose _whole name_ is a role word (`шеф`) that
  is also a principal's alias — would sail through naive directional matching.
  The single-token mutuality gate blocks it: a one-sided bare-word link becomes
  a _suggestion_, never an auto-merge, so the doorman is never silently absorbed
  into Boris.
- **Additive.** No changes to `characterSchema`, the analyzer prompt, or the
  `MergeSuggestion` contract. Cached analyses benefit on their next dedup pass
  without re-running the model.

## Testing

Server (`server/src/analyzer/roster-dedup.test.ts`):

- **3-way auto-merge (mutual):** `шеф` (id `boss`, aliases `[Борис Игнатьевич]`),
  `Борис Игнатьевич` (aliases `[Гесер, шеф]`), `Гесер` (aliases `[Борис
  Игнатьевич]`) collapse to **one** survivor; sentences reattribute to the
  survivor id; survivor's `aliases` union all three display names.
- **Survivor prefers the real name:** in the case above, the survivor's name/id
  is `Борис Игнатьевич` (2 tokens) — **not** `шеф` even when `шеф` has more
  attributed lines.
- **Multi-token one-sided link auto-merges:** only `boss` lists `Борис
  Игнатьевич`, and `Борис Игнатьевич` (≥2 tokens) does not list back → still a
  strong directional merge.
- **Single-token one-sided link does NOT auto-merge (doorman case):** minor row
  `name: "шеф"` with no alias back, principal `Борис Игнатьевич` with
  `aliases: ["шеф"]` → **no merge**; because `шеф` is on exactly two rows, it
  emits **one suggestion** instead.
- **Single-token mutual link auto-merges:** both rows name each other with a bare
  word → strong.
- **Transitivity:** a component linked only through strong edges (`A`↔`B`,
  `B`↔`C`, no direct `A`↔`C` edge) collapses to one row; a member reachable only
  via a weak edge stays separate and becomes a suggestion.
- **Stable survivor regardless of union-find iteration order** — the same
  component yields the same survivor id and merged fields no matter the order
  members are unioned.
- **Negative — shared role word, no name-link:** `Captain A` / `Captain B` both
  aliased `the Captain`, neither name-linked → **no merge**; if `the Captain` is
  on 3+ rows → **no suggestion**.
- **Weak distinctive:** a name/alias shared by **exactly two** rows → **one**
  suggestion; shared by **3+** rows → none.
- **Gender guard:** conflicting concrete gender blocks a strong merge **and** any
  suggestion.
- **No regression:** the existing Tier-1 / Tier-2a / Tier-2b cases stay green.

Frontend:

- Cast page (`src/views/cast.tsx`) renders a Tier-3 `MergeSuggestion` through the
  existing `MergeSuggestionCard` path — covered by the existing
  `merge-suggestion-card.test.tsx` plus a cast-view case asserting a Tier-3
  suggestion card appears and its accept action collapses the pair. **No new
  frontend feature work** — Tier-3 suggestions reuse the Tier-2b pipeline
  end-to-end (server `writeSuggestions` → `/cast/merge-suggestions` →
  `MergeSuggestionCard`).

## Acceptance

- A character detected under multiple display names that the model links via
  aliases is **auto-merged** into one cast row — gender-gated, transitively
  across a connected component of strong edges. Strong = a multi-token name link
  (directional) or a mutual single-token link.
- The merged survivor displays under the **real name** (most name tokens), not a
  role word, even when the role word has more attributed lines.
- A one-sided **single-token** (bare-word) link does **not** auto-merge; it
  surfaces as a **merge suggestion on the cast page** when the word is on exactly
  two rows.
- Two rows sharing a **distinctive** name/alias (exactly two rows) surface as a
  suggestion; a broadly shared role word (3+ rows) surfaces nothing.
- No regression to Tier-1 / Tier-2a / Tier-2b; no false-merge of two genuinely
  distinct same-role-word people, including the role-word-as-name case (covered
  by negative tests).
- Works across languages (Russian patronymics, English nicknames, CJK) with no
  per-language table.

## Key files

- `server/src/analyzer/roster-dedup.ts` — new Tier-3 pass; extend the transitive
  rewrite collapse to see Tier-3 edges.
- `server/src/analyzer/roster-merge-fields.ts` — reused `mergeCharacterFields`
  (name/alias union already present); no change expected.
- `server/src/handoff/schemas.ts` — `character.aliases` (read only; no schema
  change). `notLinkedTo` is _not_ consulted (see Guards).
- `server/src/routes/analysis.ts` — `dedupAndPrepare` / `writeSuggestions`
  callers. **No signature change needed** — Tier-3 needs no `bookId` (the
  `notLinkedTo` guard was dropped); it reuses the existing
  `dedupeRosterByName(characters, sentences, { language })` shape.
- `server/src/analyzer/ru-diminutives.ts` — precedent for Tier-2b's
  language-specific table (unchanged; Tier-3 needs no such table).
- `src/views/cast.tsx`, `src/components/merge-suggestion-card.tsx` — existing
  cast-page suggestion surface (reused, no feature change).
- `server/src/analyzer/roster-dedup.test.ts` — Tier-3 coverage.

## Out of scope

- Analyzer prompt changes to emit explicit coreference edges (deferred
  alternative).
- Any per-language role-word / nickname table for Tier-3 (named-linkage is
  language-agnostic; Tier-2b's `ru-diminutives` table is unchanged).
- Cross-book coreference (this is in-book roster dedup only; `notLinkedTo`'s
  cross-book pairs are neither consumed nor extended here).
- **An in-book "keep these two separate" signal** (follow-up). Today same-book
  separation is only a `cast/merge` action that records merges, so there is no
  persisted way for a user to tell the analyzer "these two auto-merged rows are
  actually different people, don't re-merge on the next analysis." If Tier-3
  auto-merges prove too aggressive in practice, a persisted per-book keep-apart
  annotation (consulted by dedup) is the right fix — filed separately, not built
  here.
