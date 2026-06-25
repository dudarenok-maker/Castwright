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
> **Revised 2026-06-25 after TWO adversarial rounds (five reviewers total; §10).** Round 1 corrected three
> "free" mis-framings (validation, persistence durability, staleness) and the undercounted server-schema +
> modal + slice work. Round 2 verified those fixes against the code and caught the off-roster async flow's
> remaining blockers (no `reattribute` dispatcher arm; orphan-row + multi-book-race windows; dedupe vs
> roster-guard contradiction) and the staleness hand-wave. Every section reflects the corrected,
> code-grounded reality; §11 names a smallest-slice fallback.

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
   `flag_nonstory` adds a **third precise render-map diff** (`isChapterExcludedSinceRender`) in the same
   family, reusing the existing render-map keys — NOT a new `setStaleAudio` variant (§4.5).

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

**New dispatcher arm (not "existing sync dispatch").** `dispatchAcceptedOps`'s switch has five arms today
(`script-review-apply.ts:143-166`) and **no `reattribute` arm** — a `reattribute` op currently falls
through silently (only `onBoundaryMove` fires). Unit B adds `case 'reattribute': dispatch(setSentenceCharacter({
chapterId, sentenceId: op.id, characterId: op.characterId! }))`. This arm applies BOTH the on-roster op and
the off-roster op after its `proposed` has been resolved to a real `characterId` (§3.3).

**Staleness is inherited free:** the precise path diffs rendered `characterId` against live (when a render
map exists; else the time-based `boundary_move` fallback, which `dispatchAcceptedOps` feeds unconditionally,
`script-review-apply.ts:167`). A reattribute of a rendered line reads stale with no new mechanism.

### 3.3 Apply — off-roster (model-proposed, operator-confirmed) — **net-new UI**

No reusable create-character form exists today (the typeahead picker and the chip reassigner are not
forms), and `ScriptReviewDiff.handleApply` is a **flat synchronous** accept/reject pass
(`script-review-diff.tsx:100-120`). The off-roster path therefore introduces real new structure, budgeted
here:

- **New `CreateCharacterForm` component** — name (required), gender, ageRange. Two entry points: (a) the
  off-roster confirm, pre-filled from `op.proposed`; (b) the now-live "Add character" button (empty fields).
- **An async apply path — INTERLEAVED create→reassign, NOT create-all-first** (round 2: create-all-first
  guarantees orphan cast rows on cancel/partial-failure). The accepted batch is applied in order; for each
  op:
  1. **Structural ops + field edits** (Unit A's five + on-roster `reattribute` + `flag_nonstory`) →
     the existing synchronous `dispatchAcceptedOps` path, unchanged.
  2. **Off-roster `reattribute` (has `proposed`)** → resolve the identity against `roster ∪ createdThisBatch`
     by the normalized key `name.trim().toLowerCase()` (the codebase's prevailing fold, `cast-slice.ts:291,318`):
     - **already present** (roster member or a member created earlier in this batch) → treat as an on-roster
       reattribute to that id (no POST);
     - **new** → `await POST …/cast/create` → `addCharacter(resp)` → record `{ key, id }` in the batch memo;
     - then **immediately** `dispatch(setSentenceCharacter(...))` + `onBoundaryMove` for THIS op before
       advancing. So every created member gets its reassignment in the same step — any cancel/failure leaves
       a **self-consistent** partial (no created member without its line).
- **Concurrent-multi-book guard.** Capture `ui.stage.bookId` at apply-start; **re-check after every
  `await`** (the only suspension points). On mismatch — the operator switched books mid-confirm — **abort
  the remaining ops** and surface a toast; `s.manuscript.sentences`/`s.cast` are single-global-per-hydrated-book
  (`script-review-diff.tsx:76`), so a post-await dispatch would otherwise corrupt the wrong manuscript (the
  `revisions applyPoll` class of bug, [[project_revisions_pending_wholesale_replace]]).

**3.3a Dedupe / no-duplicate-cast (the normalized key is load-bearing):** the dedupe MUST run **before** the
POST (so only one create fires) and use `name.trim().toLowerCase()` — `addCharacter` dedupes by **id only**
(`cast-slice.ts:271`), so two same-name ops that reach the route mint two distinct slug-suffixed ids and
`addCharacter` will NOT collapse them. Two cases:
- **Name matches an existing roster member** → confirm form defaults to **"reattribute to existing «X»"**,
  not create (the enforcing guard for §5's "demonstrably-uncast only").
- **Same proposed name twice in one batch** → first create wins (recorded in the batch memo); the second
  resolves to that id (the `roster ∪ createdThisBatch` lookup above).

**Roster snapshot is augmented, not stale.** §3.5's on-roster validity check uses `roster ∪ createdThisBatch`,
so a dedupe-rewritten op pointing at a just-created id is NOT rejected as off-roster.

The new member lands voice-unassigned (`voiceState: 'generated'`), surfaced in the Cast view's Status
column (the exact `applyUnlinkAlias`/`add-from-roster` end state — voice-unassigned members already render a
Status pill, so no selector breaks). **It will not synthesize until the operator assigns it a voice there**
(existing flow, out of scope — follow-up §8). **Accepted limitation:** if a created member's own reassignment
dispatch then fails, it is a voice-unassigned orphan row — benign (the Cast view tolerates it; the operator
can delete or assign it), stated rather than silently engineered around.

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
- `characterId`, when present, must be in **`roster ∪ createdThisBatch`** — else un-appliable (prevents a
  silent no-op + bogus `boundary_move`). The augmented set is what reconciles the §3.3a dedupe (which
  rewrites a same-name op to a just-created id) with this guard; validating against the start-of-batch
  roster alone would reject the dedupe-rewritten op. A pre-resolution `proposed` op is appliable at plan
  time (its id is minted at confirm).

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
(`merged.push({ ...inc, characterId: x.characterId, text: x.text })`, `manuscript-slice.ts:146`). Add
`excludeFromSynthesis: x.excludeFromSynthesis` to that single object — sufficient and self-contained, no
structural reshape. This covers BOTH explicit re-analyze and the **confirm-cast** path (which re-analyzes);
without it, confirming cast silently re-admits flagged residue (§7 tests both). The GET-side site
(`book-state.ts:287-293`) is an orphan **filter** keyed on `s.id`, not a field-dropping merge — it passes
each surviving sentence through whole, so **no mirror is needed there** (round-2 corrected: the round-1
"second merge" was a misread).

*Co-located pre-existing gap (NOT Unit B scope):* the same `:146` merge also drops user-set `emotion` /
`instruct` on re-analysis. That predates Unit B and is out of scope here — filed as a follow-up (§8), not
fixed in this line, to keep the change surgical.

### 4.3 Synth filter + the all-excluded guard

`buildSentenceGroups` (`server/src/tts/synthesise-chapter.ts:694`) gains
`.filter((s) => !s.excludeFromSynthesis)` chained onto the existing empty-text filter (`:705-707`); the
`index` re-sequencing there already closes the gap (no PCM hole). Segment→sentence mapping keys on real
`sentenceIds`, not array position (`:710,1667`), so ASR-QA + the drift gate are unaffected.

**All-excluded chapter guard:** the route guard `if (sentences.length === 0)`
(**`server/src/routes/generation.ts:1048`** — not `tts/`) checks the **raw** count before the filter and
broadcasts a generic `chapter_failed` ("analysis cache incomplete"). A page where every sentence is residue
passes that guard but `buildSentenceGroups` returns zero groups → `Buffer.concat([])` → a near-0-byte PCM
accepted as "complete." **Add a post-exclude kept-count** (the count of sentences surviving
`!excludeFromSynthesis`, computed at the route alongside the raw guard) and, when it is 0 with a non-empty
raw count, broadcast a **distinct terminal reason** ("all content flagged non-story — nothing to
synthesise") rather than the misleading cache-incomplete message. (Fail-fast belt-and-suspenders in
`synthesiseChapter` on `groups.length === 0 && !titleText` is optional.)

### 4.4 Manuscript UX — soft + reversible

Excluded sentences stay visible, greyed + strike-through, with a toggle to re-include via the same reducer.
Constraints from the render path (`manuscript.tsx:1473-1488`, inline `<span data-sentence-id>`, NOT
contentEditable):
- the toggle **must render outside the text span** (like the existing emotion/instruct controls) or it
  corrupts the char-offset math the split affordance depends on;
- the line is **disabled as a drag/split/reassign target** while excluded (it keeps its `absIdx` slot, so
  merge/split still technically work — but acting on an excluded line is wrong UX);
- **suppress the per-sentence emotion + instruct chips** (`SentenceEmotionControl`/`SentenceInstructControl`,
  `manuscript.tsx:~1489,~1498`) on an excluded line — a line that won't synthesise must not invite the
  operator to tune its delivery. Touch target ≥44×44 px.

### 4.5 Staleness — a third precise render-map diff (mirrors `reattribute`)

Excluding/re-including changes neither `characterId`, text, nor presence, so the two existing precise diffs
(`isChapterReassignedSinceRender` characterId, `isChapterTextEditedSinceRender` #1105 text-hash) no-op. The
architecturally-consistent fix is a **third precise diff in the same family**, NOT a new `setStaleAudio`
variant (`setStaleAudio` is character-keyed only, `ui-slice.ts:53-57` — there is no chapter-keyed entry
point; the precise staleness `reattribute` inherits lives in the Generate view's render-map diff,
`generation.tsx:~656-686`, not in `setStaleAudio`).

**`isChapterExcludedSinceRender(rendered, currentSentences)`** — a pure helper beside the other two
(`src/lib/stale-chapters.ts`). It **reuses the existing `renderedSpeakersByChapter` keys** (the ids that
actually produced a segment at render time): iterate those keys; if the live sentence with that id is now
`excludeFromSynthesis === true` → **stale** (a rendered line will now be dropped). This needs the live
`currentSentences` to carry `excludeFromSynthesis` (it will) — and **no segments.json schema change** for
this, the important direction. Wire it into the Generate view's stale-OR alongside the existing two diffs.

*The re-include-after-render direction* (a line excluded at render, later re-included → its audio is
missing) can't be caught by rendered-keys iteration (the line was never a rendered key). It is rarer and
operator-initiated; cover it with the coarse `useMarkCharacterStaleIfRendered` (`stale-chapters.ts:116`) on
the **manual re-include toggle only** (over-marks, but a deliberate re-include is a stronger signal). The
review-accept path only ever excludes (sets the flag true), so it always takes the precise direction.

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
  **interleaved create→reassign** path with the per-`await` `bookId` re-check. This is the main new modal
  structure. `OpPreview` returns `null` for an unrecognised op (a silent blank row), so the new arms need a
  test asserting the reattribute/flag_nonstory rows actually render (§7).

## 7. Testing & acceptance

- **Server schema (`scriptReviewSchema`):** `reattribute` (both `characterId` and `proposed` envelopes) +
  `flag_nonstory` parse; the xor `.superRefine` rejects both-or-neither; an unknown op still rejects.
- **`sentenceSchema`:** a sentence with `excludeFromSynthesis` round-trips re-validation (regression for
  the `.strict()` trap).
- **`cast/create` route:** mints id, appends atomically, collision → suffixed id, rejects empty name (400),
  missing cast.json (409); CSRF/LAN-token enforced.
- **Client apply (incl. signature change):** the new `reattribute` dispatcher arm fires
  `setSentenceCharacter`; a stale `characterId` not in `roster ∪ createdThisBatch` → un-appliable (not a
  silent no-op); off-roster confirm → interleaved create→reassign yields the same store state as a manual
  create + reassign.
- **Dedupe (normalized `name.trim().toLowerCase()`):** proposed name == existing roster member → defaults
  to reattribute-to-existing (no duplicate cast row); same proposed name twice in one batch → exactly one
  POST, second op resolves to the created id.
- **Cancel/multi-book safety:** cancelling mid-confirm leaves a self-consistent partial (no created member
  without its reassignment); switching `ui.stage.bookId` during an `await` aborts remaining ops (no
  wrong-book dispatch).
- **flag_nonstory apply:** `setSentenceExcluded`; **re-analysis preserves the flag via BOTH explicit
  re-analyze AND the confirm-cast path** (regression for the hydrate-merge wipe); excluded sentence produces
  no group/audio; index re-sequencing leaves no PCM hole; **all-excluded chapter ends with the distinct
  "all content flagged non-story" terminal reason** (no 0-byte "success", not the generic cache-incomplete
  message).
- **Staleness:** an excluded *rendered* line marks its chapter stale via `isChapterExcludedSinceRender`
  (precise, not whole-book); `reattribute` caught by the existing precise path.
- **Frontend unit:** excluded sentence renders struck + toggle re-includes + is not a split/drag target +
  its emotion/instruct chips are suppressed; `OpPreview` renders the reattribute (before→after) and
  flag_nonstory rows (no silent blank); the confirm form pre-fills from `proposed`, edits, and defaults to
  reattribute-to-existing on a name match; per-class defaults seed the two new classes OFF. The **mock
  `cast/create`** mints a deterministic slug id so the dedupe + e2e assertions are meaningful.
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
3. **Hydrate-merge drops user-set `emotion`/`instruct` on re-analysis** (`manuscript-slice.ts:146`) — a
   pre-existing gap surfaced by round 2, NOT introduced by Unit B. *Benefit (user): manual delivery edits
   survive a re-analyze, like reassignments already do.*
4. **Close #1040 + remove its `docs/BACKLOG.md` row** on ship; update `docs/features/INDEX.md`.

## 9. New-infra summary (corrected)

**New — server:** `scriptReviewSchema` enum + per-op fields + xor `.superRefine` (`handoff/schemas.ts`);
`POST /api/books/:bookId/cast/create` route + its `app.ts` mount; `excludeFromSynthesis` on `openapi.yaml`
+ `sentenceSchema` (`.optional()`); the `buildSentenceGroups` exclude filter + the all-excluded kept-count
guard + distinct terminal reason in **`server/src/routes/generation.ts:1048`**. *(No GET-side merge change —
`book-state.ts:287-293` is an id-keyed filter that passes sentences through whole.)*
**New — client:** `api-types.ts` regen; `ReviewOp` two new ops + fields; the new **`case 'reattribute'`
dispatcher arm**; `planApply`/`dispatchAcceptedOps` **roster param** (validated against `roster ∪
createdThisBatch`) + the **interleaved async create→reassign path** with per-`await` `bookId` re-check +
intra-batch `name.trim().toLowerCase()` dedupe; `setSentenceExcluded` reducer + `excludeFromSynthesis` in
the hydrate-merge preserve-list (`manuscript-slice.ts:146`); **`isChapterExcludedSinceRender`** precise diff
in `stale-chapters.ts` + its wire-in to the Generate view's stale-OR + the coarse re-include fallback;
`CreateCharacterForm` (shared: Add-character button + off-roster confirm); the excluded-line manuscript
treatment (struck + toggle + **emotion/instruct chip suppression** + disabled split target); `ScriptReviewDiff`
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

**What survived clean (round 1):** on-roster `reattribute` + free precise-path staleness + unconditional
`onBoundaryMove`; the `cast/create` route faithfully mirrors `add-from-roster`; the whitelist-free PUT
persistence; the synth filter's id-keyed segment mapping (no ASR/drift breakage); the reducer clones; the
fixture dir + non-redundancy vs front-matter stripping.

### Round 2 (two reviewers, 2026-06-25) — verifying the round-1 fixes + new holes

- **R2-B1 — `dispatchAcceptedOps` has NO `reattribute` arm** ("run existing sync dispatch" was incoherent)
  → §3.2 adds the explicit `case 'reattribute'`.
- **R2-B2 — create-all-first guarantees orphan cast rows on cancel/partial** → §3.3 switches to
  **interleaved create→reassign** (self-consistent partials); residual single-op failure accepted + stated.
- **R2-B3 — dedupe vs roster guard contradict** → §3.3a/§3.5 validate against `roster ∪ createdThisBatch`.
- **R2-M1 — async `await` opens a concurrent-multi-book corruption window** → §3.3 per-`await` `bookId`
  re-check + abort.
- **R2-M2 — dedupe normalization must match (id-only `addCharacter` won't collapse name-dupes)** → §3.3a
  pins `name.trim().toLowerCase()`, dedupe **before** the POST.
- **R2-M3 — `flag_nonstory` staleness hand-waved real infra** (`setStaleAudio` is character-keyed only; no
  chapter entry point) → §4.5 specifies the **`isChapterExcludedSinceRender`** precise diff reusing the
  existing render-map keys (no segments.json change for the exclude direction).
- **R2-M4 — phantom path + misleading terminal state** → §4.3 corrects to `routes/generation.ts:1048` and a
  distinct "all content flagged non-story" reason; **deletes** the no-op `book-state.ts:287-293` mirror.
- **R2-M5 — excluded lines still render emotion/instruct chips** → §4.4 suppresses them.
- **R2-minors:** `OpPreview` silent-blank → §6/§7 test; mock id parity → §7; emotion/instruct re-analysis
  drop is a **pre-existing** gap → follow-up §8.3 (not Unit B scope); voice-unassigned member + drift/ASR
  re-confirmed clean.

## 11. Smallest valuable slice (if scope must shrink)

The harness is shared, so two clean cuts exist (record per Unit A's §11 precedent):

1. **`flag_nonstory` only** — drops the entire cast-create surface (the `CreateCharacterForm`, the async
   confirm, the `cast/create` route, the dedupe, the roster threading). Ships the complete exclude story
   (field + filter + all-excluded guard + precise staleness + manuscript UX) on its own. *Smallest, lowest-risk.*
2. **On-roster `reattribute` only** — keeps `reattribute` but drops `proposed`/off-roster create (the
   largest surface, R2-B2/B3/M1). §3.2 proves the on-roster path is nearly free (the dispatcher arm + roster
   param). The off-roster create then becomes its own follow-up.

Default scope remains **all of Unit B** (both classes + off-roster create), per the 2026-06-25 decision.
