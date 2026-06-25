---
title: 'fs-58 validate_instruct — Script Review class: flag/repair per-line instruct + vocalization'
status: stable
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

> **Revised 2026-06-25 over TWO adversarial review rounds (8 reviewers total).** Round 1 (apply/reducer,
> staleness, prompt/multilingual, architecture) found one design-defeating bug (the unconditional
> `boundary_move`, §6.3), three unimplementable-as-first-drafted claims (the `live` projection, the unwired
> book language, the overloaded `newText`), and a mis-scoped dependency. Round 2 **verified every round-1 fix
> correct against code** and caught the second-order details: the `setSentenceText` vocalization-wipe, a
> *fourth* (seed-time) `live` site that would silently zero the feature, the per-group/post-fallback `is17b`
> gate, and the dispatched-result-keyed carve-out. All resolved below; the audit trail is §12.

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
passes `scriptReviewSchema` as *both* the validate and grammar schema (`ollama.ts:319` / `gemini.ts:316` —
NOT `analyzer/index.ts:319`, a coincidental line-collision; corrected R2), so there is
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
`live` snapshot carries only `{id, chapterId, text, characterId}` (`script-review-apply.ts:90-91`). **Four
sites widen** to add `instruct?: string; vocalization?: boolean` (round-2 — the first draft missed the
seed-time builder):

1. the `planApply`/`dispatchAcceptedOps` `live` **type** (`script-review-apply.ts:90`);
2. the **Apply-time** snapshot builder in `script-review-diff.tsx:105`;
3. **the seed-time snapshot builder in `manuscript.tsx:695`** — it runs `planApply` the moment the SSE
   stream completes (the Task-11 seed-time validation). If it isn't widened, every `validate_instruct` op
   carries `instruct: undefined` → the §4.2 guards reject **all of them** into `unappliable` at seed → the
   feature **silently shows zero rows** ("the reviewer found nothing"). TypeScript can't catch this — the
   widened fields are optional, so `manuscript.tsx:695` keeps compiling. §9 adds a seed-time integration
   assertion.

Both production builders must add `instruct: s.instruct, vocalization: s.vocalization`. Without this, every
§4.2 guard and the §7 preview are dead on arrival.

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

**`setSentenceText` flag handling — TRI-STATE (corrected — §12 R1-4 + round-2 BLOCKER, flagged by 3
reviewers).** `strip_tag` already calls `setSentenceText` with **no** `vocalization` arg
(`script-review-apply.ts:145`), and a **committed regression test** (`script-review-apply.test.ts:246-282`,
"strip_tag preserves … vocalization") asserts a strip_tag preserves an existing `vocalization: true`. So a
naive `else delete` would wipe the flag on every strip_tag and break that test. The param must be
**tri-state** — distinguish absent from explicit-false:

```ts
if (a.payload.vocalization === undefined) { /* leave the flag untouched */ }
else if (a.payload.vocalization) sent.vocalization = true;
else delete sent.vocalization;   // explicit false ⇒ delete (never store vocalization:false)
```

The codebase omits `vocalization` when false everywhere (`applyDetectedInstruct` only sets `true`;
`split`/`merge` clear via `= undefined`), so an explicit `false` **deletes**, never stores. Note the
validate_instruct dispatch passes `op.vocalization`, which is itself `undefined` on an instruct-only row — so
the `undefined`-guard protects that path too, not just strip_tag.

**`planApply` guards** (un-appliable, never mis-applied), now readable against the widened `live`:

- target `id` exists in the live manuscript;
- an instruct **repair** is rejected when the sentence has **no current instruct** — repair must not author
  from nothing. **Discriminate strip-vs-repair on `op.newInstruct.trim() === ''`** (round-2), matching the
  reducer's trim, so a whitespace-only `newInstruct` is a *strip*, not a repair. (A **strip** on an
  instruct-less sentence is a no-op, dropped silently, **not** surfaced as un-appliable — §12 R1-3.) A repair
  whose `newInstruct` equals the current instruct is dropped as a no-op.
- a vocalization edit is rejected when the sentence is **not currently `vocalization: true`** (don't invent
  a vocalization);
- the id was not consumed by a structural op this run;
- **`strip_tag` and a vocalization edit are mutually exclusive per id** — both write `text`. Add a
  `text`-writer guard **distinct from the structural `consumed` set** (both are *non-structural*, so the
  existing `consumed.has(op.id)` check at `script-review-apply.ts:124` only covers structural-vs-anything).
  When both target one id, **`strip_tag` wins and the `validate_instruct` vocalization edit is the rejected
  one** — a **deterministic precedence** (strip_tag is the more conservative text op), NOT
  last-writer/emission-order (round-2: emission order is non-deterministic and untestable). §9 asserts the
  specific survivor regardless of op order (§12 R1-7).

*Dispatch needs no current-field data* — strip-vs-repair is fully encoded in the payload, so only `planApply`
and the §7 preview need the widened access (keeps the widening minimal; §12 R1-5). The apply layer trusts
the payload string verbatim — **no client-side English check** on a repaired instruct; the English guarantee
is prompt-only and operator-reviewed (§12 R1-8).

## 5. Prompt — multilingual (`skills/audiobook-script-review.md`)

### 5.1 Thread the book language (was unwired — §12 R3-1)

The review route passes **no `call.language`** today (`script-review.ts`), so `buildSystemInstruction`'s
language clause silently no-ops and the entire cross-lingual contract is dead. **Fix:** read
**`bookStateLanguage(located.state)`** (the canonical normaliser in `server/src/workspace/scan.ts` — every
other route uses it, not raw `state.language`, which is un-normalised BCP-47 like `'ru-RU'`) and add it as
`call.language` handed to `runScriptReviewChapter` (`StageCall.language?`, `analyzer/index.ts:61`, already
threads into `buildSystemInstruction`). (The same gap exists on the `annotate-emotion` sibling route — a
one-route fix here.) The prompt then references it: "The manuscript is in {language}; every `instruct` must
be English."

### 5.2 Serialized input — conditional, with the vocalization flag surfaced (§12 R3-3)

Feed a sentence's current `instruct` into the per-sentence input **only when it has one**, and **surface the
`vocalization: true` flag** for flagged sentences (the model cannot otherwise tell which sentences are
vocalization-annotated, since the sound is merged into `text`). A chapter with zero annotations contributes
nothing → the class is a no-op and free on books that never ran fs-57. **Cost caveat (§12 R3-7):** the cost
lands precisely on annotated chapters (the target population); a heavily-annotated chapter's per-sentence
input grows by the instruct phrase — confirm this does not tip a previously-passing chapter over the
route's overflow guard (`script-review.ts` → `chapter-failed`, budget `DEFAULT_STAGE2_CHUNK_CHAR_BUDGET` =
9000), whose "split it first" message would then be misleading. **Also update the skill's `## Input` section**
(`audiobook-script-review.md`) to document the two new conditional input fields (round-2) — what `instruct`
means (an English delivery direction) and that `vocalization: true` marks a machine-prepended sound — else
the model receives undocumented fields.

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
  sound and the `instruct` field. `strip_tag`'s prompt rule **already** prohibits touching vocalizations, so
  the prompt clarification ("leave intentional vocalizations to `validate_instruct`") is a **clarity nicety,
  not the safety mechanism** (round-2) — the real guard against both ops editing one sentence's text is the
  §4.2 mechanical text-writer mutual-exclusion.
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
   **iff both** (round-2 — two conjuncts that are NOT equivalent):
   - **(a) `group.instruct != null`** — an **explicit** instruct, NOT an emotion-derived fallback.
     `resolveInstructForGroup` returns a phrase for emotion-only groups too (`emotionToInstruct`), so gating
     on the resolver's non-empty result alone would wrongly stamp emotion-only groups (and
     `textHashForStale(undefined)` would crash). Hash the **raw explicit `group.instruct`**, never the
     resolved phrase.
   - **(b) the liveInstruct gate is open FOR THIS GROUP.** `is17b` is **per-group, not chapter-wide**: a
     mixed-engine chapter renders some groups on Qwen-1.7b and others on a Kokoro fallback, and `is17b` isn't
     in scope at the assembly/stamp loop (it's derived inside `synthBatch`/`synthGroupsBatched`). Re-derive
     it **per group from the POST-fallback route** — `routeFor(group).modelKey === 'qwen3-tts-1.7b'`
     (equivalently `r.renderedFallbackEngine !== 'kokoro'`). `applyQwenFallback` rewrites the route to the
     Kokoro key for a fallen-back group, so a Qwen-1.7b group that fell back to Kokoro is correctly
     **un-stamped** (its audio ignored the instruct) — preserving §6.3's per-group Kokoro guarantee.

   Add `instructHash?: string` to the segment type in **both** declarations
   (`synthesise-chapter.ts:295`, `server/src/audio/segments-io.ts:63`).
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
6. **OR-gate** (`generation.tsx:~1190`): add the **`useAppSelector`** for `s.chapters.renderedInstructByChapter`
   (mirror `generation.tsx:173`), its **memo** at `:672/683` building `instructEditedSinceRenderSet`, and a
   third clause beside the text and speaker checks —
   `(renderedInstructByChapter[ch.id] ? instructEditedSinceRenderSet.has(ch.id) : false) ||`.

**Map name is `renderedInstructByChapter`** (mirrors `renderedTextByChapter`; the earlier draft's
`…HashesByChapter` was wrong, §12 R2-1). **Declare it OPTIONAL on `ChaptersState`** (`renderedInstructByChapter?`)
— round-2: `renderedTextByChapter` is *non-optional* on the slice (`chapters-slice.ts:104`), which forced
#1105 to patch 3 `ChaptersState` test literals (`d634e172`). Making the instruct map optional avoids that
fixture churn (the GET-response type at `types.ts:427` is already optional). **No `openapi.yaml` change and
no `api-types.ts` regen** — the entire book-state GET response is **hand-typed**
(`renderedSpeakersByChapter`/`renderedTextByChapter` are in `src/lib/types.ts`, not openapi); adding an
openapi entry would be busywork (§12 R2-7 / R4-2).

### 6.3 The `boundary_move` carve-out — REQUIRED, or §6.2 is decorative (the killer, §12 R2-2 / R4-4)

`dispatchAcceptedOps` calls `onBoundaryMove(chapterId)` **unconditionally for every accepted op**
(`script-review-apply.ts:167`), and the OR-gate's `isChapterStaleFromReassign` clause is **engine-blind**
(fires off any `boundary_move`). So without a change, accepting an instruct repair time-stales the chapter
on **every** engine — the §6.2 precise stamp buys nothing and the §9 "Kokoro doesn't read stale" test fails
day one.

**Fix — make `boundary_move` emission keyed on what was actually DISPATCHED, surgically:** emit
`onBoundaryMove(chapterId)` only when an op actually changed `text`/structure/speaker. For
`validate_instruct`, emit it **iff the vocalization `setSentenceText` actually dispatched** — i.e. the row
carried `newVocalizationText` **and** `planApply` did **not** drop the vocalization half. **Key on the
applied result, NOT the raw payload** (round-2, the biggest residual hole): `planApply` can drop the
vocalization half of a "both" row independently (e.g. the sentence isn't currently `vocalization: true`)
while keeping the instruct repair. If the carve-out keyed on `op.newVocalizationText === undefined` (payload
presence), such a partially-dropped "both" row would still fire `boundary_move` and **false-stale Kokoro on
an instruct-only effective change** — exactly what the precise stamp exists to prevent. So `dispatchAcceptedOps`
tracks which reducers it dispatched per op and bumps `boundary_move` only for an actual text/structural/speaker
change. This is deliberately narrow:

- It does **not** touch `fix_emotion` (which has no precise hash path and legitimately relies on
  `boundary_move` for engine-blind staleness — broadening the carve-out would regress emotion staleness).
- A `validate_instruct` row whose vocalization edit **actually applied** **keeps** `boundary_move` (its text
  change legitimately stales every engine, and rides #1105 §6.1).

**Consequence to document:** the "engine-aware, Kokoro never false-flags" guarantee holds **only for an
applied-instruct-only effect**. A row whose vocalization text actually changed stales every engine — correct,
because its text changed.

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
edit, covers grammar too (§3). (2) the `validate_instruct` prompt section + the strip_tag clarity tweak + the
skill **`## Input`** field docs (`skills/audiobook-script-review.md`). (3) thread
**`bookStateLanguage(located.state)`** into the route `call` (`script-review.ts`) + the conditional serializer
surfacing the `instruct` + `vocalization:true` fields. (4) the **per-group, post-fallback-gated**
`instructHash` stamp + segment type in both decls (`synthesise-chapter.ts:295/1668`,
`server/src/audio/segments-io.ts:63`). (5) `collectRenderedInstructHashesByChapter`
(`server/src/audio/segments-io.ts`) + the GET wiring (`book-state.ts:451/479`).
*Frontend — the `renderedInstructByChapter` thread (mirror `renderedTextByChapter` site-for-site):* (6)
result type (`types.ts:427`); (7) hydrate (`layout.tsx:766`); (8) slice ×5 (`chapters-slice.ts`) — declare
the field **optional** (avoids `ChaptersState` test-literal churn); (9)
`isChapterInstructEditedSinceRender` (`stale-chapters.ts`) + the **`useAppSelector` (`generation.tsx:173`)** +
the memo (`:672/683`) + the OR-gate clause (`:1190`).
*Frontend — apply/UX:* (10) `ReviewOp` type (the 3 new fields) + the two-dispatch `case` + the new guards
(repair-vs-strip on `.trim()`, deterministic text-writer precedence) + the **dispatched-result-keyed**
`boundary_move` carve-out (`script-review-apply.ts`); (11) the **tri-state** `vocalization` param on
`setSentenceText` (`manuscript-slice.ts`); (12) **both** `live` snapshot builders
(`script-review-diff.tsx:105` Apply-time **and** `manuscript.tsx:695` seed-time) + `CLASS_LABELS` +
`OpPreview` branch (`script-review-diff.tsx`). **No `api-types.ts` regen; no `openapi.yaml` change** (§6.2;
persistence of the new sentence fields is free — `setSentenceText`/`setSentenceInstruct` middleware snapshots
the whole `sentences` array, `persistence-middleware.ts:121`). **No sidecar/golden tier** (no TTS model in
the review pass).

## 9. Testing & acceptance

- **Server unit:** parse/validate the op (strip vs repair; instruct-only / vocalization-only / both; stray
  field ignored); **multilingual fixture** — es/ru line + a contradicting English instruct → repair; a
  non-English instruct → repaired to English; a sound instruct → abstain.
- **Degradation gate (§12 R3-5; rescoped round-2 — the "assert LLM output unchanged" version is unrunnable:
  LLM output isn't byte-deterministic and the skill is one monolithic file with no toggle):** (a) a
  **prompt-assembly snapshot test** — assert the 5-class section text is byte-identical before/after adding
  the validate_instruct section (deterministic, no LLM); and (b) a **schema/parse test** — feed canned 5-class
  LLM responses through the widened `scriptReviewSchema` and assert they still parse identically. Any "5-class
  LLM output unchanged" check is a manual on-box spot-check, explicitly non-automated.
- **Client apply (`script-review-apply.test.ts`, widened `live` fixtures):** instruct strip → clear; repair
  → set; **repair rejected when no current instruct**; strip on instruct-less = silent no-op (not
  un-appliable); **rejected when consumed by a structural op**; **strip_tag + vocalization on one id → the
  strip_tag survives and the vocalization edit is rejected, REGARDLESS of op order** (deterministic
  precedence); vocalization strip **deletes** the flag (assert absent, not `=== false`), repair keeps it; a
  "both" row dispatches **two** reducers; a whitespace-only `newInstruct` is treated as a strip.
- **`setSentenceText` backward-compat (round-2, locks `script-review-apply.test.ts:246-282`):** a strip_tag
  accept (no `vocalization` arg) **leaves an existing `vocalization:true` intact** — guards the tri-state
  reducer against the wipe.
- **Seed-time guard (round-2):** a seeded `validate_instruct` op survives the **seed-time** `planApply`
  (`manuscript.tsx:695`), not just the Apply-time one — proves the widened seed projection reaches the op
  (catches the silent zero-rows failure).
- **`boundary_move` carve-out (keyed on dispatched result):** an applied-instruct-only accept does **NOT**
  emit `boundary_move`; a row whose vocalization edit **actually applied** **does**; a "both" row whose
  vocalization half was **dropped** by `planApply` does **NOT** (the false-stale-Kokoro hole); `fix_emotion`
  still does.
- **Staleness:** an instruct repair on a **liveInstruct-rendered** chapter reads stale (precise path); the
  **same repair on a Kokoro-rendered** chapter does **not** (no stamp, no boundary_move); a vocalization
  text edit reads stale (via #1105). Pin the `instructHash` cross-package vector + a whitespace-trim vector
  (§6.5), mirroring `segments-io.test.ts`/`stale-chapters.test.ts` for #1105.
- **Synth stamp (`synthesise-chapter.test.ts`):** `instructHash` written for a liveInstruct group with an
  explicit instruct; **absent** with the gate closed; **absent** for an emotion-only (no explicit) group;
  **absent** for a Qwen-1.7b group that **fell back to Kokoro** (per-group post-fallback route → `is17b`
  false), even though the chapter is on the 1.7b engine — the mixed-engine case (round-2).
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
4. At ship time (status → `stable`): create the `docs/features/` regression plan, add the `INDEX.md` row, and
   add a `release-notes-next.md` entry — the CLAUDE.md before-shipping checklist (this design spec satisfies
   none of those yet, which is correct for a `draft`).

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

## 12. Adversarial review — resolutions (two rounds, 8 reviewers, 2026-06-25)

### Round 1 (4 code-grounded reviewers: apply/reducer = R1, staleness = R2, prompt/multilingual = R3, architecture = R4)

Every finding folded above; the load-bearing ones:

- **R2-2 / R4-4 (BLOCKER, the killer):** `dispatchAcceptedOps` bumps `boundary_move` unconditionally + the
  stale clause is engine-blind → the precise instruct stamp is decorative and the Kokoro acceptance test
  fails. **→ §6.3 field-keyed carve-out** (skip boundary_move for instruct-only rows; keep it for
  vocalization/`fix_emotion`).
- **R2-1 / R3-2 / R4-3 (was BLOCKER, now resolved):** §6 depended on #1105, which was unmerged when first
  drafted. **#1105 merged (PR #1112)** → satisfied prerequisite; line numbers re-derived against `main`; map
  renamed `renderedInstructByChapter`.
- **R1-2 / R4-1 (BLOCKER):** `planApply`'s `live` carried no `instruct`/`vocalization`, so the guards + diff
  preview were unimplementable. **→ §4.1 widen the projection** (round-2: **4 sites**, incl. the seed-time
  `manuscript.tsx:695` builder).
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

### Round 2 (4 reviewers re-verified the round-1 fixes against code, then hunted second-order effects)

**All six round-1 staleness fixes, the apply fixes, and the prompt/route fixes were VERIFIED correct against
code.** New findings, folded above:

- **BLOCKER (3 reviewers + a committed test):** the `setSentenceText` extension `else delete` would wipe
  `vocalization:true` on every `strip_tag` apply, breaking `script-review-apply.test.ts:246-282`. **→ §4.2
  TRI-STATE param** (`undefined` = leave untouched; only explicit `false` deletes) + §9 backward-compat test.
- **BLOCKER (silent feature-killer):** a **fourth** `live`-projection site — the seed-time builder at
  `manuscript.tsx:695` — was missed; un-widened, every op is rejected at seed and the feature shows zero
  rows. **→ §4.1 four sites + §9 seed-time test.**
- **MAJOR (biggest residual staleness hole):** §6.3's carve-out keyed on the op **payload**, but `planApply`
  can drop a "both" row's vocalization half independently → false-stale Kokoro. **→ §6.3 key on the
  dispatched result, not the payload.**
- **MAJOR (`is17b` per-group):** the stamp gate is per-group and `is17b` isn't in scope at the stamp loop; a
  mixed-engine chapter (1.7b + Kokoro fallback) would mis-stamp. **→ §6.2 step 1 re-derive per group from
  the POST-fallback route; require explicit `group.instruct != null`.**
- **MAJOR:** text-writer precedence was order-dependent (**→ §4.2 deterministic: strip_tag wins**); the §9
  degradation gate was unrunnable as "LLM output unchanged" (**→ §9 prompt-assembly snapshot + parse test**);
  `renderedInstructByChapter` as a required field would churn 3 `ChaptersState` literals (**→ §6.2/§8
  declare it optional**).
- **Minors folded:** whitespace-only `newInstruct` = strip (§4.2); `bookStateLanguage(located.state)` not raw
  (§5.1); document the new fields in the skill `## Input` (§5.2); strip_tag reconciliation is clarity not
  safety (§5.3); the `useAppSelector` thread site (§6.2/§8); path-qualify `server/src/audio/segments-io.ts`;
  the ship-time regression-plan/INDEX/release-note follow-up (§10-4); persistence is free via the whole-array
  snapshot (§8).
- **Confirmed NOT gaps:** mock client op-agnostic; `ReviewOp`/SkillName/SKILL_FILES untouched; scope-honesty
  framing accurate (the instruct-only fallback drops only §6.2/§6.3 ≈ 40% of the work); overflow caveat
  proportionate.

## Ship notes

**Shipped 2026-06-25** — PR [#1116](https://github.com/dudarenok-maker/Castwright/pull/1116), merge commit
`48d238b7`, branch `docs/docs-fs58-validate-instruct`. Closes [#1041](https://github.com/dudarenok-maker/Castwright/issues/1041).

Built spec-first over two adversarial review rounds (spec + plan), then executed task-by-task via TDD (T1–T12,
33 files, +3014/−35). Full `npm run verify` green locally (lint, typecheck FE+server, 3186 frontend tests,
server + 264 server-slow, scripts, sidecar, 230 e2e, build). Plan:
[2026-06-25-fs58-validate-instruct.md](../plans/2026-06-25-fs58-validate-instruct.md).

**Owed (non-blocking):** on-box multilingual repair spot-check (LLM decision, non-automated, §9); the §5.2
overflow-budget acceptance check. Builds on fs-58 Unit A (#1047) + fs-57 (#1095) + #1105 (all on `main`).
