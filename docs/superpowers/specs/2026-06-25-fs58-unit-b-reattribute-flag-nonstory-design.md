---
title: 'fs-58 — LLM Script Review, Unit B: reattribute + flag_nonstory (+ cast-create)'
status: draft
date: 2026-06-25
issue: '#1040'
related:
  - 2026-06-23-fs58-llm-script-review-design.md (Unit A — the shared harness this builds on; §13 sketched Unit B)
  - fs-56 (#996) — established the coarse `useMarkCharacterStaleIfRendered` field-edit staleness trigger this reuses
  - fs-44 (#721) — MCP/agent surface; apply stays browser-only (the off-roster create flow has a UI confirm step)
  - Russian stage-2 attribution under-production (plan 221) — the mis-attribution pain `reattribute` targets
---

# fs-58 — LLM Script Review (Unit B)

> **Builds directly on Unit A** (`2026-06-23-fs58-llm-script-review-design.md`), which shipped the review
> pass, the op schema, the `POST /api/books/:bookId/script-review` endpoint + SSE, the `ScriptReviewDiff`
> modal, the client-side anchor resolver, and the per-op apply layer (`src/lib/script-review-apply.ts`).
> Unit B adds **two new op classes** to that harness — `reattribute` and `flag_nonstory` — plus one
> companion capability: **net-new cast-create**, which the off-roster `reattribute` path consumes and the
> inert "Add character" button finally activates.
>
> **Scope decisions (2026-06-25):** both classes ship in one spec; off-roster cast-create is **kept in v1**
> (a deliberate call after the adversarial review showed it is the largest new surface — see §10/M2 — so it
> is budgeted here as net-new UI, not reuse). Both new classes default **OFF** in the review modal.
>
> **Revised 2026-06-25 after a three-reviewer adversarial round** (§10). The first draft mis-framed three
> things as "free" (validation, persistence durability, staleness) and undercounted the server-schema +
> modal + slice work. Every section below reflects the corrected, code-grounded reality.

## 1. Summary

Two more operator-triggered, read-only Script Review classes on the Unit A harness:

- **`reattribute`** — re-assign a dialogue line to the correct speaker. On-roster: a one-click
  `characterId` reassignment. Off-roster (the line belongs to a never-detected character): the operator
  confirms a **model-proposed new cast member** (name + guessed gender/age), which is created and the line
  reassigned in the same accept flow.
- **`flag_nonstory`** — flag import residue (page numbers, running headers, ISBN lines, stray "Chapter N"
  lines) so it is **excluded from synthesis** via a new soft, reversible `excludeFromSynthesis` boolean.

Additive throughout — both classes OFF ⇒ today's behaviour exactly.

## 2. What Unit A provides — and the three seams the first draft got wrong

Unit A (shipped, PR #1047) gives Unit B the harness: the review pass on the `Analyzer` interface
(Ollama + Gemini + Fallback), the `prompt.scriptReview` registry knob, the skill prompt, the per-chapter
endpoint + SSE + RPD warning, the client-side anchor resolver `resolveAnchorOffset`
(`script-review-apply.ts:73`), the `ScriptReviewDiff` modal + the bookId-keyed `script-review-slice`, and
the apply layer `dispatchAcceptedOps`/`planApply` (`script-review-apply.ts:89,132`).

**Three corrections the adversarial round forced (§10):**

1. **Op validation is server-side AND strict, not client-only.** Both engines validate the model's response
   against `scriptReviewSchema` — a `.strict()` Zod object with `op: z.enum([...5 classes])`
   (`server/src/handoff/schemas.ts:224-243`; Ollama as a decode grammar `ollama.ts:319`, Gemini as
   `safeParse` `gemini.ts:316,363`). An unknown op or unknown field is **rejected**, the one retry fires,
   and a 2nd failure **fails the whole chapter**. The two new classes therefore extend the server schema
   too (§3.5b) — the single biggest correction.
2. **Persistence durability is NOT free across re-analysis.** The book-state PUT is whitelist-free for the
   `manuscript` slice (`book-state.ts:583`) so a new field round-trips to disk — but the hydrate-merge on
   re-analysis preserves only `characterId` + `text` and spreads the analyzer's fresh sentence over the
   rest (`manuscript-slice.ts:146`), silently dropping a new field. `flag_nonstory` must opt the field
   into that preserve-list (§4.2).
3. **Staleness primitives are coarser/finer than assumed.** The precise characterId-diff path
   (`isChapterReassignedSinceRender`, `src/lib/stale-chapters.ts:58`) covers `reattribute` for free, and a
   precise text-hash path also shipped post-Unit-A (`isChapterTextEditedSinceRender`, #1105) — but BOTH
   miss a flag-only change, and the coarse character-keyed marker over-marks for narrator residue. So
   `flag_nonstory` uses a **chapter-keyed** trigger (§4.5).

## 3. `reattribute`

### 3.1 Op envelope (client `ReviewOp` + server `ScriptReviewOp`/Zod)

Extends `ReviewOp` (`script-review-apply.ts:43`) AND the server `ScriptReviewOp` type + `scriptReviewSchema`
(`handoff/schemas.ts:224,245`) in lockstep:

```jsonc
{
  "id": 7,                          // target sentenceId (the input id, NOT a 1-based counter)
  "op": "reattribute",
  "anchor": "…verbatim substring…", // locate + TOCTOU-guard
  // EXACTLY ONE of:
  "characterId": "halloran",        // an EXISTING roster id, OR
  "proposed": { "name": "Ferra", "gender": "female", "ageRange": "adult" },
  "rationale": "Turn-taking: this reply is Ferra's, not the narrator's.",
  "confidence": 0.8
}
```

### 3.2 Apply — on-roster

After the anchor resolves found-and-unique, dispatch
`setSentenceCharacter({ chapterId, sentenceId: op.id, characterId })` + `onBoundaryMove`. **Staleness is
inherited free:** the precise path diffs rendered `characterId` against live (when a render map exists;
else the time-based `boundary_move` fallback, which `dispatchAcceptedOps` feeds unconditionally,
`script-review-apply.ts:167`). A reattribute of a rendered line reads stale with no new mechanism.

### 3.3 Apply — off-roster (model-proposed, operator-confirmed) — **net-new UI**

No reusable create-character form exists today (the typeahead picker and the chip reassigner are not
forms), and `ScriptReviewDiff.handleApply` is a **flat synchronous** accept/reject pass
(`script-review-diff.tsx:100-120`). The off-roster path therefore introduces real new structure, budgeted
here:

- **New `CreateCharacterForm` component** — name (required), gender, ageRange. Two entry points: (a) the
  off-roster confirm, pre-filled from `op.proposed`; (b) the now-live "Add character" button (empty fields).
- **An async apply path.** Accepting a `proposed` op does not dispatch synchronously. The modal gains a
  per-op confirm step; on confirm it `await`s `POST /api/books/:bookId/cast/create` (§3.4), then
  `addCharacter(resp) → setSentenceCharacter → onBoundaryMove`. Concretely: **resolve all `proposed`
  creates to real ids first** (sequentially, with the §3.3a dedupe), then run the existing synchronous
  `dispatchAcceptedOps` with those ids substituted in — keeping the structural/field-edit ordering intact.

**3.3a Dedupe / no-duplicate-cast (two holes the review caught):**
- **Name matches an existing roster member** (normalized, case/space-folded) → the confirm form's default
  action becomes **"reattribute to existing «X»"**, not create. The model is told `proposed` is only for
  the demonstrably-uncast (§5), but this is the enforcing guard, not advice.
- **Same proposed name on two ops in one accept batch** → the first create wins; subsequent same-name ops
  reattribute to the just-created id (an intra-batch normalized-name memo). Without it, one never-detected
  speaker fractures into two slug-suffixed cast rows + two voices.

The new member lands voice-unassigned (`voiceState: 'generated'`), surfaced in the Cast view's Status
column. **It will not synthesize until the operator assigns it a voice there** (existing flow, out of
scope — follow-up §8). Same end state as the existing `add-from-roster` reassign.

### 3.4 New server route — `POST /api/books/:bookId/cast/create`

Mirrors `cast-add-from-roster.ts`, minus the series lookup:

- **Body:** `{ name: string, gender?, ageRange?, role? }`. **Validation:** non-empty trimmed `name` (400);
  book exists + has `cast.json` (409, same precondition as add-from-roster).
- **Mint id:** readable slug from `name`; 3-byte hex suffix on collision against existing ids.
- **Append** to `cast.json` via `writeJsonAtomic`. `voiceState: 'generated'`, `color: 'unset'`, `role`
  default `'character'`, no `matchedFrom`. Response `{ character }` → `castActions.addCharacter`.
- **Middleware (inherited, must be acknowledged):** the route mounts under `/api`, so it inherits
  `requireLanToken` + `requireSameOrigin` CSRF (`app.ts:114-117`) — the frontend must send the LAN token +
  same-origin headers exactly as the other state-changing POSTs.
- **Registration:** import + `app.use('/api/books', castCreateRouter)` in `app.ts` (mirrors `app.ts:153`).
- **Mock parity:** `src/lib/api.ts` has a real + mock split — `cast/create` needs **both** a real fetch
  and a mock impl, or mock mode + e2e break (they run on `VITE_USE_MOCKS`).
- **Idempotency:** one click = one POST; the route does not dedupe (intra-run dedupe is client-side, §3.3a).

### 3.5 Client validation in `planApply` (signature change required)

`planApply`/`dispatchAcceptedOps` today take `live: {id,chapterId,text,characterId}[]` and **no roster**
(`script-review-apply.ts:89-92,132`). §3.5's on-roster check needs the roster, so **both signatures gain a
`roster: Set<string>` (live cast ids)** threaded from the modal (`script-review-diff.tsx:105-110`):

- `reattribute` is a **field edit**: runs after structural ops; rejected as un-appliable if its `id` was
  consumed by a `merge`/`split`/`extract` in the same run (free from the existing non-structural loop).
- Target `id` exists; `anchor` resolves found-and-unique; exactly one of `characterId`/`proposed`.
- `characterId`, when present, must be in `roster` — else un-appliable (prevents a silent no-op + bogus
  `boundary_move`). A `proposed` op is appliable at plan time (the create happens at confirm).

### 3.5b Server schema (`scriptReviewSchema`) — the strict gate

Extend `handoff/schemas.ts`: add `reattribute` to the `op` enum; add `characterId: z.string().optional()`
and `proposed: z.object({ name: z.string(), gender: z.enum([...]).optional(), ageRange:
z.enum([...]).optional() }).optional()`; express the **xor** with a `.superRefine` (a `.strict()` object
can't do it declaratively) rejecting both-or-neither. Keep the parallel client `ReviewOp` interface in
lockstep.

### 3.6 Granularity

**Per-chapter default** (whole-book is the existing opt-in). A chapter-opening tagless line whose speaker
is set by the previous chapter's last turn may be mis-resolved — an accepted v1 limitation; cross-chapter
context is a filed follow-up (§8).

## 4. `flag_nonstory`

### 4.1 New persisted field — `excludeFromSynthesis`

- **`openapi.yaml`** `Sentence` schema (`:4861`) — add `excludeFromSynthesis: { type: boolean }`.
- **`npm run openapi:types`** — regenerate `src/lib/api-types.ts` (the frontend `Sentence` inherits it,
  `src/lib/types.ts:43`). Unit B's only api-types regen.
- **Server Zod — mandatory:** `sentenceSchema` is `.strict()` (`handoff/schemas.ts:134`), so add
  `excludeFromSynthesis: z.boolean().optional()` or stored sentences carrying the field **fail
  re-validation** on the analysis-cache/handoff path (`SentenceOutput = z.infer<typeof sentenceSchema>`).

### 4.2 Op + apply + re-analysis preservation

```jsonc
{ "id": 12, "op": "flag_nonstory", "anchor": "…verbatim…", "rationale": "Running header / page residue." }
```

Apply → **new reducer** `setSentenceExcluded({ chapterId, sentenceId, excluded })` (a 4-line clone of
`setSentenceText`, `manuscript-slice.ts:280`), dispatched with `excluded: true`.

**Re-analysis preservation (the data-loss hole):** the hydrate-merge preserves only `characterId` + `text`
(`manuscript-slice.ts:146`). Add `excludeFromSynthesis: x.excludeFromSynthesis` to that preserve-list (and
mirror it in the GET-side filtered-merge reconciliation, `book-state.ts:287-293`) so a re-analyze/re-confirm
cycle does not silently re-admit flagged residue.

### 4.3 Synth filter + the all-excluded guard

`buildSentenceGroups` (`server/src/tts/synthesise-chapter.ts:694`) gains
`.filter((s) => !s.excludeFromSynthesis)` chained onto the existing empty-text filter (`:705-707`); the
`index` re-sequencing there already closes the gap (no PCM hole). Segment→sentence mapping keys on real
`sentenceIds`, not array position (`:710,1667`), so ASR-QA + the drift gate are unaffected.

**All-excluded chapter guard:** the generation guard `if (sentences.length === 0)` (`generation.ts:1048`)
checks the **raw** count, before the filter. A page where every sentence is residue yields `groups.length
=== 0` → `Buffer.concat([])` → a 0-byte PCM accepted as a "complete" chapter. **Add a post-exclude check**
(compute kept-count; treat all-excluded like the empty-chapter skip, or fail fast in `synthesiseChapter`
on `groups.length === 0 && !titleText`).

### 4.4 Manuscript UX — soft + reversible

Excluded sentences stay visible, greyed + strike-through, with a toggle to re-include via the same reducer.
Constraints from the render path (`manuscript.tsx:1473-1488`, inline `<span data-sentence-id>`, NOT
contentEditable): the toggle **must render outside the text span** (like the existing emotion/instruct
controls) or it corrupts the char-offset math the split affordance depends on; and an excluded line should
be **disabled as a drag/split/reassign target** while excluded (it keeps its `absIdx` slot, so merge/split
still technically work — but acting on an excluded line is wrong UX). Touch target ≥44×44 px.

### 4.5 Staleness — chapter-keyed

Excluding/re-including changes neither `characterId`, text, nor presence, so both precise paths
(characterId-diff and #1105 text-hash) no-op. Use a **chapter-keyed** stale trigger on the excluded
sentence's own `chapterId` (available in the apply layer) — NOT the coarse
`useMarkCharacterStaleIfRendered` (`stale-chapters.ts:116`), which marks every chapter the character speaks
in: residue is narrator-attributed and the narrator is in ~every chapter, so the coarse marker would mark
the **whole book** stale for one excluded header. (If no chapter-scoped `setStaleAudio` entry point exists,
add one — the data is already in hand.)

### 4.6 Positive fixture

`server/src/__fixtures__/import-residue.md`: real story sentences interleaved with residue placed
**mid-body** (a page number on its own line, a running header repeated across "pages", an ISBN line, a bare
"Chapter 3" line that became its own sentence). Mid-body is deliberate — `strip-front-matter.ts` already
clears leading-region copyright/ISBN/byline (`:63`) and `front-matter.ts` discards whole front-matter
chapters (`:51`), so the gap `flag_nonstory` fills is sentence-level residue inside narrative, not the
leading region. Synthetic = version-controllable, deterministic, license-clean.

## 5. Prompt extension

Extend `skills/audiobook-script-review.md` in the existing terse style:

- **`reattribute`** — "Re-assign a dialogue line when the current attribution is clearly wrong. Supply
  `anchor` (verbatim) and EITHER `characterId` (an EXISTING cast id from the input — **never invent a
  `characterId` not in the roster**) OR `proposed` `{ name, gender?, ageRange? }` when the true speaker is
  demonstrably NOT in the cast. Only when clearly wrong — when in doubt, omit."
- **`flag_nonstory`** — "Flag import residue that is NOT story content — page numbers, running
  headers/footers, ISBN lines, a bare chapter-number line that became its own sentence. Supply `anchor`
  (verbatim). NEVER flag story prose or dialogue. When in doubt, omit."

The `id`-is-the-input-sentenceId contract (`skills/...:28-30`) extends to both ops unchanged.

## 6. Operator UX (modal)

Both classes are new grouped sections in `ScriptReviewDiff`, requiring three concrete modal changes:

- **`CLASS_LABELS` + `OpPreview` switch** (`script-review-diff.tsx:19-25,34-69`) gain arms for both ops
  (reattribute before→after speaker, "→ + new: «Name»" for off-roster; flag_nonstory struck text).
- **Per-class default-OFF** is net-new slice state: `setReview` seeds **every** op selected
  (`script-review-slice.ts:52-54`). Add a class→default-selected map so `reattribute` + `flag_nonstory`
  seed **off** while Unit A's five seed on.
- **The async confirm sub-flow** (§3.3) — per-op confirm state + the `CreateCharacterForm` + the
  resolve-creates-then-dispatch path. This is the main new modal structure.

## 7. Testing & acceptance

- **Server schema (`scriptReviewSchema`):** `reattribute` (both `characterId` and `proposed` envelopes) +
  `flag_nonstory` parse; the xor `.superRefine` rejects both-or-neither; an unknown op still rejects.
- **`sentenceSchema`:** a sentence with `excludeFromSynthesis` round-trips re-validation (regression for
  the `.strict()` trap).
- **`cast/create` route:** mints id, appends atomically, collision → suffixed id, rejects empty name (400),
  missing cast.json (409); CSRF/LAN-token enforced.
- **Client apply (incl. signature change):** on-roster `reattribute` → `setSentenceCharacter`; a stale
  `characterId` not in `roster` → un-appliable (not a silent no-op); off-roster confirm → create-then-reassign
  yields the same store state as a manual create + reassign.
- **Dedupe:** proposed name == existing roster member → defaults to reattribute-to-existing (no duplicate
  cast row); same proposed name twice in one batch → one create, second reattributes to it.
- **flag_nonstory apply:** `setSentenceExcluded`; **re-analysis preserves the flag** (regression for the
  hydrate-merge wipe); excluded sentence produces no group/audio; index re-sequencing leaves no PCM hole;
  **all-excluded chapter skips cleanly** (no 0-byte "success").
- **Staleness:** `flag_nonstory` marks only its own chapter stale (not the whole book); `reattribute`
  caught by the precise path.
- **Frontend unit:** excluded sentence renders struck + toggle re-includes + is not a split/drag target;
  the confirm form pre-fills from `proposed`, edits, and defaults to reattribute-to-existing on a name match;
  per-class defaults seed the two new classes OFF.
- **E2E (Playwright):** per-chapter review → accept a `flag_nonstory` + an off-roster `reattribute` →
  manuscript shows the struck line + the new cast member → chapter reads stale. Append to
  `e2e/responsive/coverage.spec.ts` (or extend `e2e/script-review.spec.ts`).
- **api-types regen** required; **no sidecar/golden tier** (no TTS model in the pass).

## 8. Non-goals & follow-ups

**Non-goals:** no auto-voicing of a created off-roster character (manual in Cast view); no cross-chapter
`reattribute` context; no headless/server apply (the off-roster create has a UI confirm → browser-only,
an fs-44 dependency unchanged from Unit A); no `validate_instruct` (shipped via fs-56); no hard-delete of
non-story lines (soft + reversible by design).

**Follow-ups — file with the plan:**
1. **Auto-voice a created off-roster character.** *Benefit (user): off-roster reattribute audible in one pass.*
2. **Cross-chapter context for `reattribute`.** *Benefit (technical): closes the §3.6 straddle; weigh vs RPD.*
3. **Close #1040 + remove its `docs/BACKLOG.md` row** on ship; update `docs/features/INDEX.md`.

## 9. New-infra summary (corrected)

**New — server:** `scriptReviewSchema` enum + per-op fields + xor `.superRefine` (`handoff/schemas.ts`);
`POST /api/books/:bookId/cast/create` route + its `app.ts` mount; `excludeFromSynthesis` on `openapi.yaml`
+ `sentenceSchema` (`.optional()`); the `buildSentenceGroups` exclude filter + the all-excluded
`generation.ts` guard; `excludeFromSynthesis` in the GET-side filtered-merge (`book-state.ts`).
**New — client:** `api-types.ts` regen; `ReviewOp` two new ops + fields; `planApply`/`dispatchAcceptedOps`
**roster param** + the async resolve-creates path + intra-batch name dedupe; `setSentenceExcluded` reducer
+ `excludeFromSynthesis` in the hydrate-merge preserve-list (`manuscript-slice.ts:146`); chapter-keyed
stale trigger; `CreateCharacterForm` (shared: Add-character button + off-roster confirm); `ScriptReviewDiff`
`CLASS_LABELS`/`OpPreview` arms + the per-op confirm sub-flow + per-class default-OFF seeding in `setReview`;
real+mock `cast/create` in `api.ts`; the two prompt classes; the `import-residue.md` fixture.

**Reuses:** `setSentenceCharacter`, `castActions.addCharacter`, the precise characterId staleness path, the
review pass + `/script-review` endpoint + SSE, `resolveAnchorOffset`, the `cast-add-from-roster` persistence
pattern, the empty-text filter + index re-sequencing in `buildSentenceGroups`, the merge tombstone.

## 10. Adversarial review — resolutions (three reviewers, 2026-06-25)

Three independent code-grounded reviewers (reattribute/cast-create; flag_nonstory; harness/integration).

- **Blocker — apply layer has no roster** → `planApply`/`dispatchAcceptedOps` gain a `roster` param (§3.5).
- **M1 — strict server `scriptReviewSchema` rejects new ops** (the first draft's biggest miss; validation
  is server+client, not client-only) → §2/§3.5b extend the schema + xor `.superRefine`.
- **M2 — off-roster create is net-new UI, not reuse** (no form exists; modal is flat+sync) → §3.3/§6 own a
  `CreateCharacterForm` + an async confirm path; kept in v1 by explicit decision.
- **M3 — re-analysis wipes `excludeFromSynthesis`** (hydrate-merge preserves only characterId+text) →
  §4.2 adds it to the preserve-list.
- **M4 — all-excluded chapter → 0-byte PCM "success"** → §4.3 post-exclude guard.
- **M5 — per-class default-OFF is net-new slice state** (`setReview` seeds all on) → §6 seeding map.
- **M6 — duplicate-cast holes** (name==existing roster; same name twice in a run) → §3.3a dedupe.
- **M7 — flag_nonstory staleness over-marks the whole book** (narrator-attributed residue) → §4.5
  chapter-keyed trigger.
- **M8 — `cast/create` omitted CSRF/LAN-token + router mount + mock-API parity** → §3.4.
- **M9 — `sentenceSchema` is `.strict()`** → §4.1 mandatory `.optional()` add.
- **Minors:** line-number drift corrected (`buildSentenceGroups:694`, `useMarkCharacterStaleIfRendered:116`,
  `stale-chapters.ts` in `src/lib/`); the #1105 text-hash path noted (also misses the flag); prompt forbids
  inventing a `characterId` (§5); toggle renders outside the span + excluded line disabled as split target
  (§4.4); fixture residue mid-body (§4.6).

**What survived clean:** on-roster `reattribute` + free precise-path staleness + unconditional
`onBoundaryMove`; the `cast/create` route faithfully mirrors `add-from-roster`; the whitelist-free PUT
persistence; the synth filter's id-keyed segment mapping (no ASR/drift breakage); the reducer clones; the
fixture dir + non-redundancy vs front-matter stripping.
