# Character duplicate roster entries: live-view dedup + carryover reconciliation

**Date:** 2026-07-15
**Status:** Design — approved; revised after two adversarial-review rounds
**Scope:** Server analyzer / cast carryover — duplicate character roster entries
**Branch:** `fix/server-canonical-character-id-ingest`

## 1. Problem

Two related symptoms on a re-analysed, already-voiced book (`Ночной дозор`,
analyzer `gemma4-e4b`):

1. **Live "Cast so far" shows exact-duplicate names** during Phase 0 detection:
   `Антон` ×2, `Ольга` ×2, `Гарик` ×2, `Борис Игнатьевич` ×2–3, etc.
2. **The final `cast.json` also carries duplicates** — the on-disk cast (which
   already holds designed voices) has 24 duplicate rows across 10 name-groups.

## 2. Root cause (corrected)

An initial hypothesis — "the analyzer emits inconsistent character `id`s and the
roster merges only by `id`, so duplicates survive" — was **falsified** by
adversarial review plus on-disk evidence. The real causes are two *different*
mechanisms, neither of which is the ingest id.

### 2.1 Fresh finalization dedup already collapses same-name entries

`dedupeRosterByName` (`server/src/analyzer/roster-dedup.ts`) groups by
`normaliseNameKey(name)` and collapses any same-name group to one `safeId(name)`
survivor, rewriting the sentences. It runs **unconditionally** on every fresh
completion — `dedupAndPrepare(...)` at `analysis.ts:4264` (main) and
`analysis.ts:5360` (subset), with the in-code comment "dedup BEFORE the fold:
collapse same-name / token-subset roster duplicates and rewrite their sentences
onto the canonical id." So inconsistent model ids for the same name do **not**
survive a fresh run. The only same-name group Tier-1 leaves un-merged is a
**gender conflict** (`genders.size > 1`, `roster-dedup.ts:78-79`).

**Empirical proof:** all 24 duplicate rows in the on-disk `cast.json` have **no
`gender` field** (0 with gender, 0 gender conflicts). A fresh Tier-1 pass would
therefore have merged every one of them. They entered via a path that bypasses
dedup.

### 2.2 Symptom 1 — the live view skips the dedup

The live "Cast so far" SSE (`emitCastUpdate`) and the interim `cast.json`
(`buildInterimCast`) build their payload through `previewFoldForLiveView`
(`analysis.ts:740-745`), which runs `foldMinorCast` (descriptor/low-line
bucketing) but **not** `dedupeRosterByName`. So during Phase 0 the live roster —
merged only by model `id` in `mergeRosterChapter` — shows same-name entries with
divergent model ids as separate pills. A display-layer gap: the final cast is
already deduped; the live preview is not.

### 2.3 Symptom 2 — carryover re-adds voiced duplicates after dedup

On re-analysis of an already-voiced book, every cast write wraps the fresh
(deduped) roster in `mergeAnalysisResultWithExistingCast(priorCast, fresh)`. Its
carry-forward loop (`store/merge-analysis-cast.ts:192-195`) re-adds any
voiced/reused prior row the fresh roster "omitted" — a **post-dedup insertion
that never passes through `dedupeRosterByName`**.

When the prior `cast.json` itself already contains duplicate same-name voiced
rows (the legacy state of this book), the same-name fallback that would overlay a
prior voice onto the fresh survivor is **ambiguity-guarded off**
(`merge-analysis-cast.ts:146-153,160`): a normalised name held by >1 prior row is
treated as ambiguous and left to the id-only path. `applyRewriteToPriorCast` does
not save it either — its rewrite table is keyed on *fresh*-roster ids, which never
include the prior-only duplicate id. Result: the extra voiced prior rows survive
as 0-line duplicates. 11 of the 24 on-disk dup rows are voiced — the fingerprint.

The carryover merge runs at **five** cast.json write sites: three interim/stage-1
writes (`analysis.ts:3276`, `:3479`, `:5088`) that use the raw prior, and two
final writes (`:4472`, `:5576`) preceded by `applyRewriteToPriorCast`
(`:4464`/`:5568`). A fix confined to the final writes leaves the interim writes
reintroducing duplicates — and an interim state becomes the *persisted* state
when the final write is skipped (attribution-drift refusal, `analysis.ts:4455-4459`)
or the run is paused/interrupted before it. The reconciliation must therefore
apply to all five sites.

## 3. Design

Two independent, well-targeted fixes. Neither changes the analyzer id-source, so
there is no attribution-orphan risk, no cross-language id churn, and no new
gender algorithm to keep in sync with finalization.

### 3.1 Fix 1 — dedup the live view / interim cast

Run the **existing** finalization dedup on the preview payload so the live "Cast
so far" and the interim `cast.json` dedup consistently with the final cast.

In `previewFoldForLiveView` (`analysis.ts:740-745`), dedup **before** the fold
(mirroring the finalization order at `analysis.ts:4260-4265`):

```
foldMinorCast(dedupeRosterByName(characters, [], { language }).characters, [], { nameOnly: true, language })
```

- Reuses the identical Tier-1/Tier-2a logic — its *survivor count* is provably
  independent of line counts (Tier-1 is name/gender-gated; Tier-2a's merge
  condition is token/gender-only), so the live/interim dedup count equals the
  finalization dedup count on the same roster. This guaranteed agreement is why
  we do NOT canonicalize at ingest (that would add a divergent, order-sensitive
  gender guard).
- Safe with empty sentences: `lineCounts([])` is empty, every count defaults to
  0, no crash. Tier-2a survivor selection degrades deterministically to
  earliest-snapshot index (`roster-dedup.ts:152`). `suggestions` are discarded.
- Deterministic / no flicker: `rebuildRoster` iterates `chapterHints` in fixed
  narrative order, so the roster's insertion order (hence the Tier-2a snapshot
  order and the 0-line tie-break) is stable across every emit. A name deduped to
  one pill stays one pill — Fix 1 *reduces* live churn.
- `emitCastUpdate` fires per chapter completion, not many-per-second; dedup is
  O(n²) over tens of entries — negligible.
- `{ language }` is passed for symmetry with the finalization call even though
  `dedupeRosterByName` does not currently read it — future-proofing.

Scope note: Fix 1 aligns *dedup* behaviour. The interim/stage-1 `cast.json` still
runs through the carryover merge (fixed by Fix 2), and the nameOnly preview
intentionally skips the line-count fold + zero-line drops the final pass applies,
so the live/interim roster remains somewhat larger than the final cast. The final
write is authoritative and line-count-aware; a Tier-2a survivor's identity (which
of `Борис` / `Борис Игнатьевич` wins) can differ live vs final — cosmetic and
transient.

### 3.2 Fix 2 — reconcile the prior cast at read time (self-collapse same-name rows)

Reconcile the prior cast **at the point it is loaded** for merge, so every
downstream consumer — the three interim/stage-1 writes,
`seedReuseGuardsFromPriorCast`, and the two final writes — sees a prior cast with
**one row per name**. This covers all five write sites uniformly and is robust
under the drift-refusal / pause / interrupt paths that persist an interim write.

**There are two `priorCastForMerge` load points and the collapse must be applied
at both:** the streaming path (`~analysis.ts:2571`, after `pruneStaleReuseLinks`,
feeding sites `3276`/`3479`/`4472` + seed `3417`) **and** the subset re-analysis
path (`~analysis.ts:4916`, after the subset prune, feeding sites `5088`/`5568` +
seed `5426`). Applying it at only one leaves the other re-analysis path
uncollapsed. No other consumer reads a different prior-cast variable.

New pure helper `dedupePriorCastByName(priorCast)` in
`store/merge-analysis-cast.ts`:

- Group prior rows by `normaliseNameKey(name)`.
- For each group of ≥2, collapse to one survivor using a **bespoke-aware voice
  precedence** (highest wins):
  1. `voiceState: 'locked'`
  2. `voiceState: 'tuned'`
  3. carries a concrete bespoke voice (`overrideTtsVoices` / `overrideTtsVoice`
     / `voiceUuid`) — **even when `voiceState` is `generated`/absent**
  4. `voiceState: 'reused'` (reuse link, no bespoke voice)
  5. `generated` / none
  tie-break: more `lines`, then earliest.
  This guarantees a bespoke *designed* voice is never dropped in favour of a mere
  reuse link — the failure class of the 2026-07-14 Coalfall voice-strip incident,
  which a `voiceState`-only precedence (`applyRewriteToPriorCast:234-260`) would
  reintroduce.
- Union aliases across the group; carry the survivor's own id. Record dropped
  rows (id + dropped voiceState/voice) for the change-log.
- **Honor `notLinkedTo`:** never collapse two prior rows the user explicitly
  marked as not the same person.
- **Exclude narrator rows** (`NARRATOR_IDS` = `{'narrator','char-narrator'}`,
  `narrator-identity.ts:16`): the narrator has bespoke name-carry-forward logic
  in the merge and must not be folded by name.
- Return the collapsed cast + dropped log. Inputs not mutated.

After the self-collapse the prior cast holds one row per name, so the **existing**
ambiguity-guarded name-fallback in `mergeAnalysisResultWithExistingCast`
(`merge-analysis-cast.ts:156-167`) — previously disabled by the prior duplicates —
now bridges each surviving prior row onto its fresh same-name survivor at every
write site, riding its voice on and skipping the carry-forward. **No rewrite-table
augmentation and no per-site change is needed.** At the two final sites,
`applyRewriteToPriorCast` runs on the already-collapsed prior; its `dd.rewrites`
still remap any prior id matching a fresh dedup rewrite, with no double-remap.

Properties:
- One voice per character (bespoke-preferred); dropped voices logged. This is
  more aggressive than today's "retain a 0-line orphan" for the rare case of two
  genuinely-distinct same-name people the fresh run already merged — an accepted,
  logged trade, and guarded by `notLinkedTo`.
- Because the collapse precedes `seedReuseGuardsFromPriorCast` (`:3417`), that
  pass's same-name lookups become unambiguous too — a side benefit, not a
  regression.

## 4. Cross-language safety

Neither fix changes the analyzer id-source, so the language-risk surface is far
smaller than the rejected ingest approach. Both key on `normaliseNameKey` /
`normaliseForMatch` — the Plan-219 single normalization chokepoint, proven
multi-script safe (`safe-id.test.ts`): English/accented-Latin normalise
byte-identically to the legacy key; Cyrillic and CJK are preserved, not
transliterated; distinct non-Latin names never collide. Honorific handling
(`cjk-honorifics.ts`) is untouched. The reported Russian book plus en/de/es/fr and
zh/ja all route through the same name key, so behaviour is uniform across
languages.

## 5. Interactions & risks

- **Finalization dedup:** unchanged. Fix 1 reuses it earlier; Fix 2 operates on
  the prior cast, orthogonal to the fresh-roster dedup.
- **Attribution / sentence ids:** untouched — no roster id-source change, so no
  new orphan→narrator demotions and no interaction with `attributionDriftExceeded`.
- **Fix 2 voice handling:** the bespoke-aware precedence prevents dropping a
  designed voice for a reuse link. When two prior rows both hold *distinct*
  bespoke voices under one name (only from the legacy duplicate bug, or two
  genuinely-distinct same-name people the fresh run merged), one is kept and the
  other logged — the only correct single-character outcome; `notLinkedTo`
  protects deliberately-separated pairs. Flag in release notes for
  previously-duplicated books.
- **`applyRewriteToPriorCast`:** still runs at the two final sites on the
  already-collapsed prior; behaviour unchanged, no double-remap (single,
  non-chained lookup).
- **Bridge key mismatch (LOW, pre-existing):** the self-collapse groups by
  `normaliseNameKey` (deburrs accents, strips separators) while the name-fallback
  it relies on matches by `normaliseForMatch` (keeps accents/spaces). If a
  surviving prior row's display name differs from the fresh survivor's only by an
  accent/separator, the bridge misses and that voice reappears as a single 0-line
  orphan (not the full dup set). This is inherited from the existing id-drift
  carryover bridge, degrades gracefully, and does not affect the reported Cyrillic
  book (identical spellings match). Covered by an accented-Latin test + a
  release-note caveat; optionally closed fully by also emitting a
  `priorId → survivorId` map for the final sites.
- **Not in scope (logged as separate bug #1662):** Mechanism 2 — the same person
  under different display names (`шеф` = `Борис Игнатьевич` = `Гесер`). A
  coreference/alias problem the string-dedup cannot solve.

## 6. Testing

- **Fix 1 unit:** `previewFoldForLiveView` with a roster of same-name rows under
  divergent model ids returns one entry per name; count equals
  `dedupeRosterByName` on the same input; gender-conflict rows stay split;
  repeated calls are order-stable (no flicker); empty-sentence input does not
  crash.
- **Fix 2 unit:** two voiced same-name prior rows → one survivor, no 0-line
  duplicate after merge; **the row holding the only bespoke voice survives even
  when another row has a stronger `voiceState`** (Coalfall guard); `notLinkedTo`
  pair is NOT collapsed; dropped voice recorded; covered for en + Cyrillic + CJK
  names.
- **Fix 2 coverage:** an interim/stage-1 write (`3276`/`3479`/`5088`) on a
  duplicated-voiced prior no longer emits duplicates (guards the drift-refusal /
  interrupt persistence path); both the streaming and the **subset** re-analysis
  path apply the collapse (both load points `~2571` / `~4916`).
- **Fix 2 bridge edge:** an accented-Latin name whose prior/fresh spellings differ
  only by accent/separator degrades to a single 0-line orphan, not a full
  duplicate (documents the known `normaliseNameKey` vs `normaliseForMatch` gap).
- **Regression:** existing `merge-analysis-cast` tests (single-voice fallback,
  carry-forward, `fresh` strip, Coalfall guardrails) and `roster-dedup` tests
  stay green.
- **Suites:** re-run `merge-analysis-cast` / `roster-dedup` / `analysis` tests,
  then the full server suite.

## 7. Scope boundaries

- **In:** Fix 1 (live-view/interim dedup) + Fix 2 (read-time prior-cast
  self-reconciliation).
- **Rejected:** ingest-time id canonicalization — the finalization dedup already
  handles same-name/different-id on fresh runs; the ingest change is over-built
  (identity-source change for every character/language) and under-effective
  (fixes neither the live-view gap nor the carryover reintroduction), and adds an
  order-sensitive gender guard divergent from finalization.
- **Out → backlog bug [#1662](https://github.com/dudarenok-maker/Castwright/issues/1662):**
  Mechanism 2 — cross-name coreference merge (`шеф`/`Борис Игнатьевич`/`Гесер`),
  written up with this investigation.
- **In-flight analysis:** the currently-running analysis is unaffected; both
  fixes take effect on a subsequent re-analysis.
