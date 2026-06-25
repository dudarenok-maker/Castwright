---
title: 'fs-58 validate_instruct — Script Review class: flag/repair per-line instruct + vocalization'
status: draft
date: 2026-06-25
issue: '#1041'
related:
  - 2026-06-23-fs58-llm-script-review-design.md (Unit A — the harness this class slots into; §9/§13 deferred validate_instruct)
  - 2026-06-24-fs57-nonverbal-vocalizations-instruct-design.md (fs-57 — owns the `instruct` field + the vocalization annotation this class polices)
  - fs-56 (#996) — manual instruct-editing UI; soft value-add (more hand-written instructs to keep honest), not a blocker
  - '#1105 — precise text-edit staleness — MERGED to main (PR #1112, 318b40c3); the seam §6 reuses + mirrors'
  - 198-stale-chapter-reassign-indicator.md (the staleness family: speaker #650 + text #1105; this class adds the instruct sibling)
  - fs-44 (#721) — server/headless apply path (this class inherits Unit A's browser-only apply dependency)
---

# fs-58 — `validate_instruct` Script Review class

> **The 6th Script Review class**, deferred in the Unit A spec (§9/§13) because the per-sentence
> `instruct` field didn't exist yet. It does now — **fs-57** (PR #1095) shipped the field, its persistence,
> its Zod type, and the `setSentenceInstruct` reducer; fs-58 **Unit A** (PR #1047) shipped the review-pass
> harness (read-only LLM pass → flat op envelope → client-side apply → `ScriptReviewDiff` modal); **#1105**
> (PR #1112) shipped the precise text-edit staleness seam this class mirrors for instruct. All three are on
> `main`, so this class is **buildable now**. fs-56 (#996, manual instruct editing) is a soft value-add (a
> hand-written instruct is likelier to contradict the line), **not a blocker**.

> **Revised 2026-06-25 after a 4-reviewer adversarial pass** (apply/reducer, staleness, prompt/multilingual,
> architecture). The review found one design-defeating bug (the unconditional `boundary_move`, §6.3), three
> unimplementable-as-first-drafted claims (the `live` projection lacked the fields the guards read; the
> review route passes no book language; `newText` was overloaded), and a mis-scoped dependency. All are
> resolved below; the audit trail is §12.

## 1. Summary

`validate_instruct` is a 6th class in the existing per-chapter script-review pass. It reviews and repairs
the two things fs-57's annotation pass writes per sentence:

- the English free-text **`instruct`** (a delivery direction), and
- an optional in-language **vocalization** (a pronounceable sound prepended into the sentence's `text`,
  flagged `vocalization: true`).

It **strips** a defective annotation or **repairs** it. It is additive and operator-reviewed: every change
is an accept/reject diff row; off (or nothing flagged) → today's behaviour exactly. No new LLM request — it
rides the existing per-chapter review call as one more op class.

**Scope note.** #1041 framed this instruct-only ("low-cost win", `moscow:could`). We widened it to
**instruct + vocalization** for completeness of the fs-57 surface. The honest cost picture (corrected after
review — §12 R4-8): the **vocalization half is cheap** (its staleness is *free* via #1105's text-hash,
§6.1), and the **expensive half is the precise instruct-stamp** (§6.2/§6.3 — the `renderedInstructByChapter`
thread + the `boundary_move` carve-out), which exists in the **instruct-only core too**. So the genuinely
small fallback if scope must shrink is **instruct-only with the engine-blind `boundary_move` time-heuristic**
(no precise stamp, no GET thread) — explicitly *not* "instruct-only + precise stamp", which is the costly
path. We are building the precise path (operator chose "do it right").

## 2. Background — what it polices

fs-57's `audiobook-instruct-annotation` pass (Stage 3) writes, per sentence:

- **`instruct`** — *always English*, even for a non-English manuscript (fs-57 hard rule). A short delivery
  phrase ("a long, tired sigh"). Resolved into the sidecar call **only** on the `qwen-1.7b + liveInstruct`
  path (`resolveInstructForGroup`, `server/src/tts/resolve-instruct.ts`); every other engine ignores it.
- **vocalization** — a pronounceable sound *in the manuscript's language* ("Ah!", "Ах…", "¡Ay!") prepended
  into `text`, with `vocalization: true` set on the sentence (the flag is **not** recoverable from `text`).

Both can misfire: an instruct that contradicts the line, is malformed, leaks speakable content, or (a
multilingual signal) was written in the book's language instead of English; a vocalization that's a
non-pronounceable stage-direction or in the wrong language. `validate_instruct` is the QA counterpart to
fs-57's generator.

## 3. The op — flat envelope, id-keyed (no anchor)

One row, `op: 'validate_instruct'`, keyed by `id` (the input `sentenceId`) — a **pure field-delta like
`fix_emotion`**, so it needs **no anchor**. A row may carry an instruct edit, a vocalization edit, or both.
**The vocalization text uses its own field `newVocalizationText`, NOT `newText`** (corrected after review,
§12 R3-4 / R1-1+7): `strip_tag` already owns `newText` with the *opposite* intent ("strip the narration tag
but NEVER touch a vocalization"), so reusing it would route a strip_tag edit into the vocalization reducer
and make the prompt self-contradictory. A distinct field disambiguates the envelope structurally.

```jsonc
{
  "id": 14,
  "op": "validate_instruct",
  "newInstruct": "",                      // present ⇒ instruct edit. "" = strip; non-empty = repair (English).
  "newVocalizationText": "She closed her eyes.", // present ⇒ vocalization text edit (book's language).
  "vocalization": false,                  // present WITH newVocalizationText ⇒ set/clear vocalization:true.
  "rationale": "instruct contradicts the calm line",  // required
  "confidence": 0.8                       // optional 0–1
}
```

Field presence is the discriminator (mirrors the flat-envelope decision in Unit A §4.3): an absent field is
"no change." `strip` vs `repair` is `newInstruct === ''` vs non-empty.

**Schema (`server/src/handoff/schemas.ts`, `scriptReviewSchema` :224-243):** add `'validate_instruct'` to
the `op` enum; add optional `newInstruct: z.string()`, `newVocalizationText: z.string()`,
`vocalization: z.boolean()`. The object is `.strict()` with all-optional fields, so the additions don't
break omitting-op cases. **This single edit also covers the Ollama grammar** — `runScriptReviewChapter`
passes `scriptReviewSchema` as *both* the validate and grammar schema (`analyzer/index.ts:319`), so there is
**no distinct grammar artifact** to edit (unlike stage1; corrected expectation, §12 R4-5). Per-op semantics
remain imperative client-side (Unit A §5.6) — Gemini can't constrain the union, Ollama only softly; so the
apply branch must **ignore stray fields** (a `validate_instruct` op carrying a spurious `mergeIds`/`emotion`
is applied as instruct/vocalization only).

## 4. Apply — client-side, reuses existing reducers

`validate_instruct` joins the **non-structural** apply pass alongside `fix_emotion` (`planApply` /
`dispatchAcceptedOps` in `src/lib/script-review-apply.ts`), so a structural op (`split`/`merge`/`extract`)
that consumed the id correctly rejects a same-id field edit (existing `consumed` set).

### 4.1 Widen the `live` projection (was unimplementable — §12 R1-2 / R4-1)

The guards and the diff preview must read the sentence's **current** `instruct`/`vocalization`, but the
`live` snapshot carries only `{id, chapterId, text, characterId}` (`script-review-apply.ts:90-91`, built at
`script-review-diff.tsx:105-110`). **Three sites widen** to add `instruct?: string; vocalization?: boolean`:
the `planApply`/`dispatchAcceptedOps` `live` type, the snapshot builder in `script-review-diff.tsx`, and the
test fixtures (§9). Without this, every §4.2 guard and the §7 preview are dead on arrival.

### 4.2 The dispatch + guards

| Field edit | Reducer | New? |
|---|---|---|
| instruct strip/repair | **`setSentenceInstruct`** (`manuscript-slice.ts:308`) — `''` trims to a delete; non-empty sets | exists (fs-56) — *no new reducer* |
| vocalization strip/repair | **`setSentenceText`** (`manuscript-slice.ts:280`) **extended** with an optional `vocalization?: boolean` | small extension |

The `validate_instruct` case dispatches **up to two reducers** (corrected — a single-dispatch `switch` case
would silently drop half a "both" row, §12 R1-1):

```ts
case 'validate_instruct': {
  if (op.newInstruct !== undefined)
    dispatch(setSentenceInstruct({ chapterId, sentenceId: op.id, instruct: op.newInstruct }));
  if (op.newVocalizationText !== undefined)
    dispatch(setSentenceText({ chapterId, sentenceId: op.id, text: op.newVocalizationText, vocalization: op.vocalization }));
  break;
}
```

**`setSentenceText` flag handling (corrected — §12 R1-4):** the codebase omits `vocalization` when false
everywhere (`applyDetectedInstruct` only ever sets `true`; `split`/`merge` clear via `= undefined`). So the
reducer must `if (vocalization) sent.vocalization = true; else delete sent.vocalization` — **never store
`vocalization: false`** (which would serialize into `manuscript-edits.json` and diverge from convention).

**`planApply` guards** (un-appliable, never mis-applied), now readable against the widened `live`:

- target `id` exists in the live manuscript;
- an instruct **repair** (`newInstruct !== ''`) is rejected when the sentence has **no current instruct** —
  repair must not author from nothing. (A **strip** on an instruct-less sentence is a no-op, dropped
  silently, **not** surfaced as un-appliable — corrected guard scoping, §12 R1-3.) A repair whose
  `newInstruct` equals the current instruct is dropped as a no-op.
- a vocalization edit is rejected when the sentence is **not currently `vocalization: true`** (don't invent
  a vocalization);
- the id was not consumed by a structural op this run;
- **`strip_tag` and a vocalization edit are mutually exclusive per id** — both write `text`, so two
  text-writers on one id would silently clobber (last-writer-wins). Add a `text`-writer guard mirroring the
  structural `consumed` set: a second `text`-writing op on an id already targeted is un-appliable (§12 R1-7).

*Dispatch needs no current-field data* — strip-vs-repair is fully encoded in the payload, so only `planApply`
and the §7 preview need the widened access (keeps the widening minimal; §12 R1-5). The apply layer trusts
the payload string verbatim — **no client-side English check** on a repaired instruct; the English guarantee
is prompt-only and operator-reviewed (§12 R1-8).

## 5. Prompt — multilingual (`skills/audiobook-script-review.md`)

### 5.1 Thread the book language (was unwired — §12 R3-1)

The review route passes **no `call.language`** today (`script-review.ts`), so `buildSystemInstruction`'s
language clause silently no-ops and the entire cross-lingual contract is dead. **Fix:** read
`located.state.language` in the route and add it to the `call` object handed to `runScriptReviewChapter`
(the same gap exists on the `annotate-emotion` sibling route — a one-route fix here). The prompt then
references it: "The manuscript is in {language}; every `instruct` must be English."

### 5.2 Serialized input — conditional, with the vocalization flag surfaced (§12 R3-3)

Feed a sentence's current `instruct` into the per-sentence input **only when it has one**, and **surface the
`vocalization: true` flag** for flagged sentences (the model cannot otherwise tell which sentences are
vocalization-annotated, since the sound is merged into `text`). A chapter with zero annotations contributes
nothing → the class is a no-op and free on books that never ran fs-57. **Cost caveat (§12 R3-7):** the cost
lands precisely on annotated chapters (the target population); a heavily-annotated chapter's per-sentence
input grows by the instruct phrase — confirm this does not tip a previously-passing chapter over the
route's overflow guard (`script-review.ts` → `chapter-failed`), whose "split it first" message would then be
misleading.

### 5.3 The contract

- The **line may be any supported language** (en / ru / es / fr / de); the **`instruct` is always English**.
  Judging an instruct against a non-English line is a cross-lingual consistency check — within model
  comprehension for the 5 supported languages.
- **Flag/repair an instruct** that (a) contradicts the line's content or emotion, (b) is malformed/empty of
  meaning, (c) leaks content meant to be *spoken*, or (d) **is written in the book's language instead of
  English**. A repaired instruct is **always English**.
- **Flag/repair a vocalization** that is a non-pronounceable stage-direction, or in the wrong language. A
  repaired vocalization stays **in the book's language**; stripping it restores the plain text and clears
  the flag. **Dropped subcase:** "duplicates already-spoken content" is **not** a contract case — the model
  cannot reconstruct the pre-prepend text from merged `text`, so the check is unsupportable (§12 R3-3).
- **Disambiguate from `strip_tag`** (§12 R3-4): `strip_tag` removes a third-person narration verb phrase
  that leaked into spoken text ("she said"); `validate_instruct` polices the machine-prepended non-verbal
  sound and the `instruct` field. Update `strip_tag`'s existing vocalization-protection rule to read "leave
  intentional vocalizations to `validate_instruct`."
- **`sentenceId` contract** preserved from the existing prompt: copy the id verbatim, never a 1-based
  counter. **Abstain when in doubt.**

## 6. Staleness — split by field, precise, #1105-anchored

An edit on an already-rendered chapter must mark it stale **only when it changes that chapter's audio**.

### 6.1 Vocalization repair → free via #1105 (now on main)

A vocalization strip/repair edits **`text`**, which changes the synth input on **every engine**. #1105's
`isChapterTextEditedSinceRender` (`src/lib/stale-chapters.ts:98`; `textHash` stamped at
`synthesise-chapter.ts:1668`; collected by `collectRenderedTextHashesByChapter`, `segments-io.ts:166`;
shipped as `renderedTextByChapter`) already catches any rendered sentence whose text changed. So vocalization
staleness is **free** — and #1105 is **merged** (PR #1112), so this is a satisfied prerequisite, not a gate.

### 6.2 Instruct repair → new precise stamp, mirroring `renderedTextByChapter` exactly

An instruct repair changes **no text**, so #1105 can't see it, and it only affects audio on the
`qwen-1.7b + liveInstruct` path. Add an instruct sibling that **mirrors the merged `renderedTextByChapter`
thread site-for-site** (groups are 1:1 with sentences since plan 70d, so `group.instruct === sentence.instruct`
— the per-segment stamp inverts cleanly to a per-sentence map):

1. **Stamp** (`synthesise-chapter.ts:~1668`, beside `textHash`): `instructHash: textHashForStale(group.instruct)`
   **iff** the group has an explicit `instruct` AND the liveInstruct gate was open
   (`resolveInstructForGroup(g, { is17b, liveInstruct }).instruct` non-empty). Hash the **raw explicit
   `instruct`**, not the resolved phrase (keeps the client diff trivial). Add `instructHash?: string` to the
   segment type (`synthesise-chapter.ts:295`, `segments-io.ts:63`).
2. **Collector** (`segments-io.ts:~166`): `collectRenderedInstructHashesByChapter`, a copy of
   `collectRenderedTextHashesByChapter` — invert `segments[].{sentenceIds, instructHash}` →
   `{chapterId: {sentenceId: hash}}`, **omitting chapters with zero stamped hashes** (so a Kokoro/base-Qwen
   render — gate closed, nothing stamped — reads "can't tell", never "all edited").
3. **GET** (`book-state.ts:451/479`): call the collector, add `renderedInstructByChapter` to the response.
4. **Client thread** mirroring `renderedTextByChapter`: result type (`src/lib/types.ts:427`); hydrate
   dispatch (`layout.tsx:766`); slice field + initialState + payload type + destructure + assign
   (`chapters-slice.ts:104/115/262/273/277`).
5. **Diff** (`src/lib/stale-chapters.ts`): `isChapterInstructEditedSinceRender(renderedInstructHashes,
   currentSentences)` — a copy of `isChapterTextEditedSinceRender` hashing `sent.instruct ?? ''` over the
   stamped ids only.
6. **OR-gate** (`generation.tsx:~1190`): add a third clause beside the text and speaker checks —
   `(renderedInstructByChapter[ch.id] ? instructEditedSinceRenderSet.has(ch.id) : false) ||` — with its
   memo at `:672/683`.

**Map name is `renderedInstructByChapter`** (mirrors `renderedTextByChapter`; the earlier draft's
`…HashesByChapter` was wrong, §12 R2-1). **No `openapi.yaml` change and no `api-types.ts` regen** — the
entire book-state GET response is **hand-typed** (`renderedSpeakersByChapter`/`renderedTextByChapter` are in
`src/lib/types.ts`, not openapi); adding an openapi entry would be busywork (§12 R2-7 / R4-2).

### 6.3 The `boundary_move` carve-out — REQUIRED, or §6.2 is decorative (the killer, §12 R2-2 / R4-4)

`dispatchAcceptedOps` calls `onBoundaryMove(chapterId)` **unconditionally for every accepted op**
(`script-review-apply.ts:167`), and the OR-gate's `isChapterStaleFromReassign` clause is **engine-blind**
(fires off any `boundary_move`). So without a change, accepting an instruct repair time-stales the chapter
on **every** engine — the §6.2 precise stamp buys nothing and the §9 "Kokoro doesn't read stale" test fails
day one.

**Fix — make `boundary_move` emission field-keyed, surgically:** emit `onBoundaryMove` for every accepted op
**except a `validate_instruct` row that carries *only* an instruct edit** (no `newVocalizationText`).
Concretely, skip iff `op.op === 'validate_instruct' && op.newVocalizationText === undefined`. This is
deliberately narrow:

- It does **not** touch `fix_emotion` (which has no precise hash path and legitimately relies on
  `boundary_move` for engine-blind staleness — broadening the carve-out would regress emotion staleness).
- A `validate_instruct` row that **also** edits vocalization text **keeps** `boundary_move` (its text change
  legitimately stales every engine, and rides #1105 §6.1).

**Consequence to document:** the "engine-aware, Kokoro never false-flags" guarantee holds **only for
instruct-only rows**. A "both" row stales every engine — correct, because its text changed.

### 6.4 Known scoped gap — emotion→explicit-instruct (§12 R2-5)

The stamp fires only on an *explicit* instruct, and `validate_instruct`'s repair-only guard means it can
never author an instruct onto an emotion-only-rendered sentence — so the false-negative is **closed for this
feature**. A separate path (fs-56 manual edit / an fs-57 re-run) adding an explicit instruct to a sentence
that rendered with only an emotion-derived instruct would not flag via this map. That is a pre-existing
manual-edit gap, **out of scope here** — documented, not fixed.

### 6.5 Hash invariant to pin (§12 R2-6)

The raw-vs-raw hash works because **both sides store the trimmed value** (`setSentenceInstruct:316` trims;
`buildSentenceGroups` carries it verbatim). A future server/headless apply (fs-44) **must trim before
persist** or the hash desyncs. §9 pins a leading/trailing-whitespace vector alongside the cross-package
`instructHash` vector.

## 7. Operator UX

The existing **"Review Script"** trigger and **`ScriptReviewDiff`** modal gain a `validate_instruct` group.
This needs (was missing — §12 R1-6): a **`CLASS_LABELS['validate_instruct']`** entry; an **`OpPreview`
branch** for the class (today unknown ops render `null`); and the widened live-sentence access (§4.1) so the
before→after can show the **current `instruct`/vocalization**, not just `text`. Pre-selected **ON** like the
other corrective classes; operator deselects per run and accept/rejects per row.

## 8. Touch-list (concrete, corrected)

*Server:* (1) `scriptReviewSchema` enum + `newInstruct`/`newVocalizationText`/`vocalization` fields — single
edit, covers grammar too (§3). (2) the `validate_instruct` prompt section + strip_tag reconciliation
(`skills/audiobook-script-review.md`). (3) thread `located.state.language` into the route `call`
(`script-review.ts`) + the conditional serializer surfacing the vocalization flag. (4) the `instructHash`
stamp + segment type (`synthesise-chapter.ts`, `segments-io.ts`). (5) `collectRenderedInstructHashesByChapter`
(`segments-io.ts`) + the GET wiring (`book-state.ts:451/479`).
*Frontend — the `renderedInstructByChapter` thread (mirror `renderedTextByChapter` site-for-site):* (6)
result type (`types.ts:427`); (7) hydrate (`layout.tsx:766`); (8) slice ×5 (`chapters-slice.ts`); (9)
`isChapterInstructEditedSinceRender` (`stale-chapters.ts`) + the memo + OR-gate clause (`generation.tsx`).
*Frontend — apply/UX:* (10) `ReviewOp` type + the two-dispatch `case` + the new guards + the
`boundary_move` carve-out (`script-review-apply.ts`); (11) the `vocalization` param on `setSentenceText`
(`manuscript-slice.ts`); (12) the widened `live` snapshot builder, `CLASS_LABELS`, and `OpPreview` branch
(`script-review-diff.tsx`). **No `api-types.ts` regen; no `openapi.yaml` change** (§6.2). **No sidecar/golden
tier** (no TTS model in the review pass).

## 9. Testing & acceptance

- **Server unit:** parse/validate the op (strip vs repair; instruct-only / vocalization-only / both; stray
  field ignored); **multilingual fixture** — es/ru line + a contradicting English instruct → repair; a
  non-English instruct → repaired to English; a sound instruct → abstain.
- **Degradation gate (§12 R3-5):** run the existing 5-class review fixtures **with and without** the
  `validate_instruct` section and assert the 5-class output is unchanged — proves the 6th class doesn't
  regress the other five in one call.
- **Client apply (`script-review-apply.test.ts`, widened `live` fixtures):** instruct strip → clear; repair
  → set; **repair rejected when no current instruct**; strip on instruct-less = silent no-op (not
  un-appliable); **rejected when consumed by a structural op**; **strip_tag + vocalization on one id →
  second text-writer un-appliable**; vocalization strip **deletes** the flag (assert absent, not `=== false`),
  repair keeps it; a "both" row dispatches **two** reducers.
- **`boundary_move` carve-out:** an instruct-only accept does **NOT** emit `boundary_move`; a vocalization
  (or "both") accept **does**; `fix_emotion` still does.
- **Staleness:** an instruct repair on a **liveInstruct-rendered** chapter reads stale (precise path); the
  **same repair on a Kokoro-rendered** chapter does **not** (no stamp, no boundary_move); a vocalization
  text edit reads stale (via #1105). Pin the `instructHash` cross-package vector + a whitespace-trim vector
  (§6.5), mirroring `segments-io.test.ts`/`stale-chapters.test.ts` for #1105.
- **Synth stamp (`synthesise-chapter.test.ts`):** `instructHash` written for a liveInstruct group with an
  explicit instruct; **absent** with the gate closed; **absent** for an emotion-only (no explicit) group.
- **Slice/mock (§12 R4-7):** extend `script-review-slice.test.ts` for a `validate_instruct` op in
  `toggleClass`/`opKey` (slice + mock are op-agnostic — no structural change); the dedicated slice is not
  wiped by a revisions poll and shows only the active book (Unit A invariant).
- **E2E (rescoped — §12 R4-6):** the mock has no Qwen-1.7b cast member, so liveInstruct can't render and the
  precise stale path can't be exercised live. Scope the e2e to: review → `validate_instruct` row → accept →
  `setSentenceInstruct`/`setSentenceText` fire → manuscript reflects the edit. Assert instruct-staleness at
  the **unit** level (above) or with a hand-seeded mock `renderedInstructByChapter` GET fixture, not via a
  real 1.7b render. Append the apply-path case to `e2e/responsive/coverage.spec.ts`.

## 10. Non-goals & follow-ups

**Non-goals:** re-attribution / split / emotion (other classes own those); **authoring** an instruct or
vocalization where none exists (repair-only); server/headless apply (browser-only — inherits Unit A's fs-44
#721 dependency); suggestion persistence across reload; any entitlement gate; fixing the
emotion→explicit-instruct manual-edit staleness gap (§6.4).

**Follow-ups to file with the plan:**
1. Update #1041 to the **instruct + vocalization** scope and re-check its `moscow:could` label.
2. Edit the fs-58 Unit A spec (§9/§13) + fs-57 spec to point at this delivered class (bidirectional capture).
3. (Optional) file the emotion→explicit-instruct staleness gap (§6.4) as a separate manual-edit follow-up.

## 11. Dependencies & linkage

- **Reuses:** the fs-58 review-pass harness (call path, flat envelope, `ScriptReviewDiff`, RPD warning, SSE
  job pattern); `setSentenceInstruct` (fs-56); `setSentenceText` (fs-58 Unit A); **#1105's `textHashForStale`
  + the `renderedTextByChapter` thread** (mirrored for instruct, §6.2).
- **New:** the `validate_instruct` op (enum + 3 fields + prompt section); the `vocalization` param on
  `setSentenceText`; the `instructHash` stamp + collector + `renderedInstructByChapter` thread +
  `isChapterInstructEditedSinceRender`; the `boundary_move` carve-out; the book-language thread into the
  route.
- **Depends on:** fs-57 ✔ shipped; fs-58 Unit A ✔ shipped; **#1105 ✔ merged** (PR #1112); fs-44 #721 (server
  apply) — inherited, deferred.

## 12. Adversarial review — resolutions (4 reviewers, 2026-06-25)

Four code-grounded reviewers (apply/reducer = R1, staleness = R2, prompt/multilingual = R3, architecture =
R4). Every finding folded above; the load-bearing ones:

- **R2-2 / R4-4 (BLOCKER, the killer):** `dispatchAcceptedOps` bumps `boundary_move` unconditionally + the
  stale clause is engine-blind → the precise instruct stamp is decorative and the Kokoro acceptance test
  fails. **→ §6.3 field-keyed carve-out** (skip boundary_move for instruct-only rows; keep it for
  vocalization/`fix_emotion`).
- **R2-1 / R3-2 / R4-3 (was BLOCKER, now resolved):** §6 depended on #1105, which was unmerged when first
  drafted. **#1105 merged (PR #1112)** → satisfied prerequisite; line numbers re-derived against `main`; map
  renamed `renderedInstructByChapter`.
- **R1-2 / R4-1 (BLOCKER):** `planApply`'s `live` carried no `instruct`/`vocalization`, so the guards + diff
  preview were unimplementable. **→ §4.1 widen the projection in 3 sites.**
- **R3-1 (BLOCKER):** the review route passes no book language → the multilingual contract no-ops. **→ §5.1
  thread `located.state.language`.**
- **R3-4 / R1-1+7 (MAJOR):** `newText` overloaded between `strip_tag` and the vocalization edit. **→ §3
  distinct `newVocalizationText` field + §4.2 text-writer mutual-exclusion guard + §5.3 prompt
  disambiguation.**
- **R3-3 (MAJOR):** the model can't see the `vocalization` flag or pre-prepend text. **→ §5.2 surface the
  flag; §5.3 drop the "duplicates spoken content" subcase.**
- **R1-1 (MAJOR):** a "both" row needs two dispatches. **→ §4.2 explicit two-conditional case.**
- **R1-4 (MAJOR):** `setSentenceText` must `delete` the flag, not store `false`. **→ §4.2.**
- **R3-5 (MAJOR):** no measurement that the 6th class doesn't regress the other five. **→ §9 degradation gate.**
- **R4-2 / R2-7 (MAJOR):** the GET-map thread is ~9 sites and the book-state response is hand-typed (no
  openapi). **→ §6.2/§8 full thread enumerated; openapi/api-types untouched.**
- **R2-4 (MAJOR):** the per-segment→per-sentence collector was omitted. **→ §6.2 step 2
  `collectRenderedInstructHashesByChapter`.**
- **R4-6 (MAJOR):** e2e can't drive a 1.7b liveInstruct render. **→ §9 rescoped e2e.**
- **Minors folded:** guard scoped to repairs (R1-3); ignore stray fields (R3-6); emotion→explicit gap
  documented (R2-5, §6.4); trim invariant pinned (R2-6, §6.5); conditional-input cost + overflow note
  (R3-7, §5.2); Ollama-grammar single-edit note (R4-5, §3); slice/mock tests (R4-7, §9).
