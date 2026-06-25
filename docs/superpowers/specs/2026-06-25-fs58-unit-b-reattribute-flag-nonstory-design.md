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
> pass, the flat-envelope op schema, the `POST /api/books/:bookId/script-review` endpoint + SSE, the
> `ScriptReviewDiff` modal, the client-side anchor resolver, and the per-op apply layer
> (`src/lib/script-review-apply.ts`). Unit B adds **two new op classes** to that harness — `reattribute`
> and `flag_nonstory` — plus one companion capability: **net-new cast-create**, which the off-roster
> `reattribute` path consumes and the inert "Add character" button finally activates.
>
> **Scope decision (2026-06-25):** both classes ship in one spec (they share the diff modal + review-pass
> plumbing); `flag_nonstory` carries more new infra (a persisted field + fixture) and that is called out
> honestly below. Both new classes default **OFF** in the review modal — higher-risk than Unit A's
> corrective set, so the operator opts in per run.

## 1. Summary

Two more operator-triggered, read-only Script Review classes on the Unit A harness:

- **`reattribute`** — re-assign a dialogue line to the correct speaker. When the correct speaker is already
  on the cast roster it is a one-click `characterId` reassignment; when the line demonstrably belongs to a
  character the analyzer never detected, the operator confirms a **model-proposed new cast member** (name +
  guessed gender/age), which is created and the line reassigned in the same accept flow.
- **`flag_nonstory`** — flag import residue (page numbers, running headers, ISBN lines, stray "Chapter N"
  lines) so it is **excluded from synthesis**. Soft and reversible: a new `excludeFromSynthesis` boolean
  leaves the sentence in the manuscript (rendered struck-through, with a toggle to re-include) and is
  filtered only at synth time.

Additive throughout — both classes OFF ⇒ today's behaviour exactly.

## 2. Background — what Unit A already provides

Unit A (shipped, PR #1047) gives Unit B everything structural:

- The review pass on the `Analyzer` interface (Ollama + Gemini + Fallback impls), the
  `prompt.scriptReview` registry knob, the skill prompt `skills/audiobook-script-review.md`, the
  per-chapter endpoint + SSE, and the `selectAnalyzer`/review-model knob + RPD warning
  (`REVIEW_MODEL_RPD` in `script-review-apply.ts`).
- The **flat op envelope** `{ id, op, ...payload, rationale, confidence }` with imperative per-op
  validation in `planApply` (`script-review-apply.ts:89`) and the client-side anchor resolver
  `resolveAnchorOffset` (NFC + quote/dash/ellipsis folds, found-and-unique check).
- The `ScriptReviewDiff` modal (`src/components/script-review-diff.tsx`) + the dedicated, non-polled,
  bookId-keyed suggestions slice (`src/store/script-review-slice.ts`).
- The apply layer `dispatchAcceptedOps` (`script-review-apply.ts:132`) that maps each accepted op to a
  manuscript reducer and emits `onBoundaryMove` per touched chapter.

Unit B extends exactly these seams. No new harness is built.

## 3. `reattribute`

### 3.1 Op envelope

Extends `ReviewOp` (`script-review-apply.ts:43`):

```jsonc
{
  "id": 7,                         // target sentenceId
  "op": "reattribute",
  "anchor": "…verbatim substring…", // locate + TOCTOU-guard, as every structural op
  // EXACTLY ONE of:
  "characterId": "halloran",       // an existing roster member, OR
  "proposed": { "name": "Ferra", "gender": "female", "ageRange": "adult" },
  "rationale": "Turn-taking: this reply is Ferra's, not the narrator's.",
  "confidence": 0.8
}
```

The model emits `characterId` when the true speaker is on the roster, and `proposed` when the line
demonstrably belongs to a never-detected character. `gender`/`ageRange` inside `proposed` are optional
hints (the operator can edit them at confirm; absent → sensible defaults).

### 3.2 Apply — on-roster

`reattribute` with `characterId` is a **field edit** (like `fix_emotion`): after the anchor resolves
found-and-unique against the live sentence, dispatch
`manuscriptActions.setSentenceCharacter({ chapterId, sentenceId: op.id, characterId })` + `onBoundaryMove`.

**Staleness is inherited free.** The precise path `isChapterReassignedSinceRender`
(`stale-chapters.ts:58`) already diffs rendered `characterId` against the live manuscript, and the apply
layer already emits `boundary_move`. A reattribute that changes a rendered sentence's speaker reads stale
with no new mechanism.

### 3.3 Apply — off-roster (model-proposed, operator-confirmed)

When the op carries `proposed`, accepting it does **not** dispatch immediately. It opens a small inline
**create-character confirm** step in the accept flow, pre-filled from `proposed`:

1. Operator reviews/edits `name`, `gender`, `ageRange` (name required; the form warns on a near-exact
   name match against the existing roster so the operator doesn't mint a duplicate).
2. Confirm → `POST /api/books/:bookId/cast/create` (§3.4) → on `{ character }`:
   `dispatch(castActions.addCharacter(character))` → `dispatch(setSentenceCharacter({ chapterId,
   sentenceId: op.id, characterId: character.id }))` → `onBoundaryMove(chapterId)`.

The new member lands **voice-unassigned** (`voiceState: 'generated'`), surfaced in the Cast view's Status
column like any uncast character. **It will not synthesize until the operator assigns it a voice in the
Cast view** — the existing voice-assignment flow, out of scope here. This is the same end state as the
existing `add-from-roster` reassign path, so it inherits that path's downstream behaviour.

### 3.4 New server route — `POST /api/books/:bookId/cast/create`

Mirrors `cast-add-from-roster.ts` (the proven net-new-character persistence pattern), minus the
series-roster lookup:

- **Body:** `{ name: string, gender?: 'male'|'female'|'neutral', ageRange?: 'child'|'teen'|'adult'|'elderly', role?: string }`.
- **Validation:** non-empty trimmed `name` (400 otherwise); the book must exist + have a `cast.json`
  (409 if cast not yet confirmed — same precondition as add-from-roster).
- **Mint id:** a readable slug from `name` (lowercased, non-alnum → `_`); random 3-byte hex suffix on
  collision against existing ids.
- **Append** the new record to `cast.json` via `writeJsonAtomic` (atomic-rename). `voiceState:
  'generated'`, `color: 'unset'`, `role` default `'character'`, no `matchedFrom` (this is a fresh
  character, not a series carry-over).
- **Response:** `{ character: <full new record> }` — the frontend dispatches `castActions.addCharacter`
  with it. Idempotency mirrors add-from-roster: one click = one POST; the route does not dedupe.

The inert "Add character" button (`src/views/manuscript.tsx:1219`) gets an `onClick` that opens the
**same create-character form** with empty fields (the standalone manual path), POSTing the same route. One
shared form component, two entry points (manual button + off-roster reattribute confirm).

### 3.5 Validation in `planApply`

- `reattribute` is a field edit: runs **after** structural ops; rejected as un-appliable if its `id` was
  consumed by a `merge`/`split`/`extract` in the same run.
- Target `id` must exist in the live manuscript; `anchor` must resolve found-and-unique.
- Exactly one of `characterId` / `proposed` present. `characterId`, when present, must be a **live cast
  id** (validated against the roster passed into the apply layer); an absent/stale `characterId` → un-appliable.
- A `proposed` op is always "appliable" at plan time (the create happens at accept); the confirm form
  enforces the non-empty name.

### 3.6 Granularity

**Per-chapter default** — consistent with the whole harness (whole-book remains the existing opt-in). A
chapter-opening tagless line whose speaker is determined by the *previous* chapter's last turn may be
mis-resolved; this is an accepted v1 limitation (cross-chapter context is a filed follow-up, §8). The
prompt is given one chapter's sentences + the post-fold roster, exactly as Unit A.

## 4. `flag_nonstory`

### 4.1 New persisted field — `excludeFromSynthesis`

A new optional boolean on `Sentence`:

- **`openapi.yaml`** — add `excludeFromSynthesis: { type: boolean }` to the `Sentence` schema.
- **`npm run openapi:types`** — regenerate `src/lib/api-types.ts` (the first Unit B change that needs an
  api-types regen; Unit A did not).
- **Server Zod** — add the optional field to `SentenceOutput` (`server/src/handoff/schemas.ts`).
- **Persistence is free** — the book-state PUT writes the whole sentence array
  (`book-state.ts`), so the flag round-trips to disk once it is on the sentence object.

### 4.2 Op + apply

```jsonc
{ "id": 12, "op": "flag_nonstory", "anchor": "…verbatim…", "rationale": "Running header / page residue." }
```

Apply → **new reducer** `manuscriptActions.setSentenceExcluded({ chapterId, sentenceId, excluded })`
(scoped by `(chapterId, sentenceId)` like `setSentenceText`/`setSentenceCharacter`; no-op if not found).
Accepting a `flag_nonstory` op dispatches it with `excluded: true`.

### 4.3 Synth filter

`buildSentenceGroups` (`server/src/tts/synthesise-chapter.ts:699`) gains
`.filter((s) => !s.excludeFromSynthesis)` alongside the existing empty-text drop. The `index`
re-sequencing already in place (the scatter-back slot key for the index-order concat) handles the
resulting gap exactly as it does for dropped empty lines — no PCM hole. An excluded sentence contributes
no audio and no segment.

### 4.4 Manuscript UX — soft + reversible

Excluded sentences stay **visible** in the manuscript editor, rendered greyed + strike-through, with a
small toggle ("Include" / an eye affordance, ≥44×44 px touch target per the mobile protocol) that flips
`excludeFromSynthesis` back off via the same reducer. Nothing is destroyed; the exclusion is fully
auditable and reversible from the editor.

### 4.5 Staleness

Excluding (or re-including) a sentence changes neither `characterId`, text, nor presence, so the precise
characterId-diff path misses it. **Reuse the coarse field-edit trigger fs-56 established**
(`useMarkCharacterStaleIfRendered`, `stale-chapters.ts:74`): on apply and on manual toggle, mark the
sentence's character's rendered chapters stale. Excluding a line changes the chapter's audio, so its
`done` chapters correctly read stale.

### 4.6 Positive fixture

Coalfall (`the-coalfall-commission.md`) is clean markdown with zero import artifacts, so this class needs
its own positive fixture. Ship a **small synthetic committed fixture**
(`server/src/__fixtures__/import-residue.md`): a handful of real story sentences interleaved with the
residue this class targets — a page number on its own line, a running header repeated across "pages", an
ISBN line, a bare "Chapter 3" line that became its own sentence. Synthetic is version-controllable,
deterministic, and license-clean — preferred over capturing a real PDF/EPUB import.

## 5. Prompt extension

Extend `skills/audiobook-script-review.md` with the two classes, in the existing terse op-spec style:

- **`reattribute`** — "Re-assign a dialogue line to the correct speaker when the current attribution is
  clearly wrong. Supply `anchor` (verbatim) and EITHER `characterId` (an existing cast id) OR `proposed`
  `{ name, gender?, ageRange? }` when the true speaker is demonstrably NOT in the cast. Only when
  attribution is clearly wrong — when in doubt, omit."
- **`flag_nonstory`** — "Flag import residue that is NOT story content — page numbers, running
  headers/footers, ISBN lines, a bare chapter-number line that became its own sentence. Supply `anchor`
  (verbatim). NEVER flag story prose or dialogue. When in doubt, omit."

## 6. Operator UX (modal)

Both classes appear as new grouped sections in `ScriptReviewDiff`, **default-deselected**:

- `reattribute` rows: before→after speaker; off-roster rows render as "→ + new: «Name»" and, on accept,
  expand the inline create-character confirm before dispatching.
- `flag_nonstory` rows: the residue text shown struck, with its rationale.

All other modal behaviour (per-class accept/reject, per-change drill-down, the dedicated slice, active-book
scoping) is inherited from Unit A unchanged.

## 7. Testing & acceptance

- **Server unit — parse + validation:** `reattribute` (roster `characterId` envelope + off-roster
  `proposed` envelope) and `flag_nonstory` parse; abstention (`reattribute` must not fire on a
  well-tagged line; `flag_nonstory` must not flag story prose).
- **`cast/create` route:** mints id, appends atomically, collision → suffixed id, rejects empty name
  (400), rejects missing cast.json (409).
- **Client apply:** on-roster `reattribute` → `setSentenceCharacter`; off-roster confirm →
  create-then-reassign yields the same store state as a manual add-from-create + reassign (incl. the new
  member in the cast slice); `flag_nonstory` → `setSentenceExcluded`; invalid/consumed-id ops rejected as
  un-appliable.
- **Synth filter:** an `excludeFromSynthesis` sentence produces no group and no audio; `index`
  re-sequencing leaves no hole in the concatenated PCM.
- **Staleness:** `flag_nonstory` apply (and manual toggle) marks the character's rendered chapter stale;
  `reattribute` is caught by the precise path (rendered-characterId diff).
- **Frontend unit:** an excluded sentence renders struck + the toggle re-includes; the off-roster confirm
  form pre-fills from `proposed`, edits, and warns on a near-duplicate name.
- **E2E (Playwright):** per-chapter review → diff → accept a `flag_nonstory` and an off-roster
  `reattribute` → manuscript shows the struck line + the new cast member → chapter reads stale. Append the
  case to `e2e/responsive/coverage.spec.ts` (or extend `e2e/script-review.spec.ts`).
- **api-types regen** is required (the `excludeFromSynthesis` field); **no sidecar/golden tier** (no TTS
  model in the review pass).

## 8. Non-goals & follow-ups

**Non-goals (Unit B):** no auto-voicing of a freshly-created off-roster character (manual in Cast view);
no cross-chapter context for `reattribute` (per-chapter, §3.6); no headless/server apply (the off-roster
create has a UI confirm step → browser-only, an fs-44 dependency unchanged from Unit A); no `validate_instruct`
(that shipped via fs-56); no hard-delete of non-story lines (soft + reversible by design).

**Follow-ups — file with the plan:**
1. **Auto-voice a created off-roster character** — today it lands voice-unassigned and is silent until the
   operator assigns a voice in the Cast view. *Benefit (user): off-roster reattribute becomes audible in
   one pass.*
2. **Cross-chapter context for `reattribute`** — feed the prior chapter's last turn so chapter-opening
   tagless lines resolve. *Benefit (technical): closes the §3.6 straddle limitation; weigh against RPD.*
3. **Close #1040 + remove its `docs/BACKLOG.md` row** on ship; update `docs/features/INDEX.md`.

## 9. New infra summary

**New:** `POST /api/books/:bookId/cast/create` route • `setSentenceExcluded` reducer •
`excludeFromSynthesis` field (`openapi.yaml` + **`api-types.ts` regen** + Zod `SentenceOutput`) • the
`buildSentenceGroups` exclude filter • the shared create-character form component (manual button +
off-roster confirm) • two new op classes in the prompt + envelope (`ReviewOp`) + `planApply` validation +
`dispatchAcceptedOps` mapping • the `import-residue.md` fixture.

**Reuses:** `setSentenceCharacter`, `castActions.addCharacter`, `useMarkCharacterStaleIfRendered`, the
precise characterId staleness path, the review pass + `/script-review` endpoint + SSE, `ScriptReviewDiff`
+ the dedicated suggestions slice, `resolveAnchorOffset`, the `cast-add-from-roster` persistence pattern.
