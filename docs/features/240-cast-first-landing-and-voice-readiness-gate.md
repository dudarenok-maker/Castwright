---
status: draft
shipped: null
owner: null
---

# Cast-first landing + pre-flight voice-readiness gate (fe-46)

> Status: draft — approved plan, adversarially reviewed, awaiting implementation
> Spec: `docs/superpowers/specs/2026-07-04-voice-design-generation-flow-design.md`
> Key files: `src/store/ui-slice.ts`, `src/store/start-generation-flow.ts`,
> `src/store/voice-readiness-selectors.ts` (new), `src/lib/cast-sort.ts` (new),
> `src/modals/voice-readiness-gate.tsx` (new), `src/views/cast.tsx`,
> `src/components/layout.tsx`, `src/store/generation-stream-middleware.ts`,
> `src/store/queue-thunks.ts`, `server/src/workspace/queue-io.ts`, `server/src/routes/queue.ts`
> URL surface: `#/books/<id>/cast` (new confirm landing), `#/books/<id>/manuscript`
> OpenAPI ops: `POST /api/queue/enqueue` (optional `fallbackConfirmed` per entry)

## Benefit / Rationale

- **User:** voice design becomes a first-class step of the flow (confirm → Cast →
  Manuscript → Generate) instead of a detour; nobody reaches generation unvoiced without an
  explicit, informed choice. Non-English books can no longer start a run that is guaranteed
  to fail per chapter.
- **Technical:** a single reusable voice-readiness selector replaces three independent
  reimplementations of "has a designed voice" (cast view `needsVoiceIds`, tier-modal 1.7B
  guard, and now the gate); the per-entry `fallbackConfirmed` flag becomes stampable at
  enqueue, de-duplicating the pre-flight and per-chapter prompts.
- **Architectural:** locks in the analysis-busy gate idiom (selector + message builder +
  enqueue-choke-point backstop) as THE pattern for pre-generation gates.

## Architectural impact

- **New seams:** `src/store/voice-readiness-selectors.ts`
  (`selectUndesignedQwenCharacters` / `selectIsBookNonEnglish` /
  `voiceReadinessGateMessage`), `src/lib/cast-sort.ts` (extracted `compareCastRows` +
  `UNKNOWN_BUCKET_IDS` — required so the eager store bundle never imports the lazy-loaded
  `cast.tsx`), `ui.voiceReadinessGate` state + `voiceReadinessGate` modal,
  `EnqueueInput.fallbackConfirmed` (client + server).
- **Preserved:** server fallback semantics untouched; the per-chapter
  `awaiting_fallback_confirm` gate remains the backstop for entries enqueued outside the
  pre-flight path (lone per-chapter clicks, resumed runs, post-proceed roster changes on
  entries not yet stamped).
- **Migration story:** none — `fallbackConfirmed` is already an optional per-entry field in
  queue state; enqueue merely gains the ability to set it.
- **Reversibility:** each half reverts independently (one-token `confirmCast` literal; the
  gate is a pre-modal step in `startGenerationFlow` that can be short-circuited).

## Design decisions (user-locked)

1. **Reorder + gate** — the flow teaches the step; the gate enforces it.
2. **Soft for English, hard for non-English** — English gets "Proceed anyway — generic
   Kokoro fallback voices"; non-English books omit the proceed affordance entirely.
3. **Always land on Cast** after confirm, for all books/engines.
4. Frontend-led; no engine/synthesis changes.

## Implementation steps

Work order (each independently verifiable): 2a → 2b → 1 → 3 → 4 → new e2e → docs →
`npm run verify`. Branch: `feat/frontend-voice-design-flow` (multi-scope frontend+server →
PR review gate at `high` effort per model-routing).

### 1. Reorder: confirm → Cast

- `src/store/ui-slice.ts` `confirmCast`: `view: 'manuscript'` → `view: 'cast'` (one token;
  `openBook` already defaults reopened books to Cast — this removes an inconsistency).
- `src/views/cast.tsx`: new prop `onContinueToManuscript`; `PrimaryButton variant="dark"`
  labelled **"Continue to manuscript"** + `IconChevR`, last item in the header action row.
  Always visible, never disabled — the gate lives at generation start, not navigation.
- `src/routes/index.tsx`: wire it to `dispatch(uiActions.changeView('manuscript'))`.
- `src/views/confirm-cast.tsx`: rename the CTA (**"Confirm cast and design voices"**) and
  update the caption ("We'll start generating chapter audio with these voices." is now
  inaccurate).
- `src/lib/tour-steps.ts`: reorder so Cast steps precede Manuscript steps (pure array
  reorder; each step drives its own `changeView`).

### 2. Reusable voice-readiness selector

- **2a (prerequisite):** extract `UNKNOWN_BUCKET_IDS` + `compareCastRows` from `cast.tsx`
  into `src/lib/cast-sort.ts`; `cast.tsx` imports them back. No behaviour change.
- **2b:** new `src/store/voice-readiness-selectors.ts` (sibling idiom to
  `analysis-substage-selectors.ts`):
  - `selectUndesignedQwenCharacters(state, bookId)` — **all** characters whose effective
    engine (`c.ttsEngine ?? engineForModelKey(state.ui.ttsModelKey)`) resolves to Qwen and
    whose `resolveVoiceStatus(...).lifecycle?.label === 'Needs voice'` — the EXACT
    semantics of the cast view's `needsVoiceIds` (NO lines filter), so the gate's "Design
    full cast" and the cast view's button always design the same roster and counts agree.
    Sorted by `compareCastRows`; returns `{id, name, lines}[]`. `bookId` param kept for API
    symmetry with `selectAnalysisBusyForBook` even though `state.cast` is
    single-book-scoped — comment this so it isn't "cleaned up" later.
  - **Gate firing condition** is narrower than the list: fire only when
    `some(c => c.lines > 0)` — a 0-line undesigned character can never trigger the server
    fallback, so it must not block generation (it still appears in the list / gets
    designed by the CTA).
  - `selectIsBookNonEnglish(state, bookId)` — `library.books` lookup, flat `!== 'en'`
    (mirrors the existing check in `cast.tsx`; no BCP-47 subtag parsing client-side).
  - `voiceReadinessGateMessage(state, bookId)` — message-builder pair mirroring
    `analysisBusyMessage` (distinct copy for English fallback vs non-English hard block).
  - Accepted approximation: whole-cast scope, not per-queued-chapter parity with the
    server's `computeQwenKokoroFallbackSet` — correct for the full-run CTA this gate
    guards; revisit only on observed false positives.

### 3. Pre-flight gate surface

- `src/store/start-generation-flow.ts`: new step *before* `openStartGenPrompt` — if
  `castRendersOnQwen` and the firing condition holds, dispatch
  `uiActions.openVoiceReadinessGate({ bookId })` and stop. Tier choice stays in the
  existing tier modal (partially-designed casts still need 0.6B/1.7B for their designed
  characters — deliberately NOT merged).
- `src/store/ui-slice.ts`: `voiceReadinessGate: { bookId } | null` +
  `openVoiceReadinessGate`/`closeVoiceReadinessGate` (mirrors `startGenPrompt`).
- New `src/modals/voice-readiness-gate.tsx`, mounted in `layout.tsx` alongside
  `StartGenerationModal`:
  - Lists undesigned characters (name + line count, talk-time order).
  - Primary CTA **"Design full cast"** → `changeView('cast')` +
    `castDesignActions.designAllRequested({ bookId, characterIds: <full undesigned list>,
    modelKey: sampleModelKeyForEngine('qwen', ttsModelKey), scope: 'bases',
    variantTasks: [] })` (same payload shape as the cast view's `startDesign('bases')` →
    same middleware, same DesignPill/progress UI) + close gate.
  - **In-flight design guard:** reads `castDesign.active`; if a run is active the primary
    CTA becomes **"View design progress"** → `changeView('cast')` + close, with NO
    `designAllRequested` dispatch (re-dispatching aborts/restarts the running SSE).
  - English: secondary text-button **"Proceed anyway — generic Kokoro fallback voices"** →
    close gate + `openStartGenPrompt({ fallbackConfirmed: true })`.
  - Non-English: **omit the proceed prop/button entirely** (not just disabled); fixed copy
    "This book can't fall back to a generic voice — every speaking character needs a
    designed voice." Cancel is the only other affordance.
- Follow-up TODO (don't block): converge `layout.tsx`'s ad-hoc 1.7B `hasDesignedVoice`
  check onto the new selector (third reimplementation today).

### 4. De-dupe vs the per-chapter `awaiting_fallback_confirm` gate

Stamp the existing per-entry `fallbackConfirmed` flag at enqueue time:

- **Server:** `server/src/workspace/queue-io.ts` — `EnqueueInput` + `enqueue()` accept
  optional `fallbackConfirmed` (conditional spread alongside `requiredEngines`/`multiTts`).
  `server/src/routes/queue.ts` — `EnqueueRequestEntry` + per-entry loop forward
  `r.fallbackConfirmed === true`. No changes to the dispatcher middleware or
  `generation.ts` — they already read `e.fallbackConfirmed` generically.
- **Frontend flag path (single, verified end-to-end)** — the tier modal's confirm is what
  actually dispatches `requestStartGeneration`, so the flag rides through it:
  1. `startGenPrompt` ui-state gains `fallbackConfirmed?: boolean`; `openStartGenPrompt`
     accepts the optional payload (only the gate's proceed-anyway passes `true`).
  2. `requestStartGeneration` widens to `PayloadAction<{ fallbackConfirmed?: boolean } |
     undefined>` (reducer stays a no-op).
  3. `layout.tsx` tier-modal confirm forwards `ui.startGenPrompt?.fallbackConfirmed`.
  4. `generation-stream-middleware.ts` — `enqueueOnWork()` (currently argless, ignores the
     action) takes `fallbackConfirmed: boolean` from the payload and conditionally spreads
     `{ fallbackConfirmed: true }` onto each fresh `EnqueueInput`. Client `EnqueueInput`
     type gains the field; `enqueueQueueEntries` forwards it unchanged.
- **Scoping (the de-dupe answer):** only entries created by *that* proceed-anyway dispatch
  carry the flag — chapters enqueued later re-trigger the per-chapter gate, entry-scoped
  for free.
- **Accepted residual (resume):** `enqueueOnWork` skips already-queued chapters, so on a
  resumed run pre-existing entries stay unstamped and the per-chapter gate still fires for
  them — a second prompt, but safe and correct. Do NOT bulk-confirm at pre-flight; a
  follow-up can reuse `POST /confirm-fallback` per entry if it annoys.
- **Accepted residual (blanket stamp):** every fresh chapter of the proceed-anyway run is
  stamped, so a sentence reassigned to an undesigned character AFTER proceeding renders
  without a fresh warning — English-only by construction, within explicit user consent.
- Non-English never reaches this path (no proceed exists), so `MissingDesignedVoiceError`
  is never suppressed.

## Invariants to preserve

1. `confirmCast` lands on `view: 'cast'` (`src/store/ui-slice.ts`) — the cast-first flow
   is the product decision, not an accident to "fix" back.
2. `selectUndesignedQwenCharacters` and the cast view's `needsVoiceIds` share one
   definition of "needs a voice" (`resolveVoiceStatus` lifecycle) — never fork them.
3. The gate FIRES only on speaking (`lines > 0`) undesigned characters; the design CTA
   covers the full undesigned roster. List ⊇ firing set, by design.
4. `enqueueQueueEntries` stays the single enqueue choke point; `requestStartGeneration`
   stays the single `ENQUEUE_TRIGGER_TYPES` entry (`generation-stream-middleware.ts`).
5. `fallbackConfirmed` is per-queue-entry, never per-book — the de-dupe scoping depends
   on it.
6. Non-English gate has NO proceed affordance (prop omitted, not disabled).
7. `src/lib/cast-sort.ts` stays free of React/store imports (store-eager module, consumed
   by the lazy `cast.tsx` and the eager selector alike).

## Test plan

### Automated coverage

- Vitest unit (`src/store/ui-slice` tests) — `confirmCast` lands on `'cast'`.
- Vitest unit (`src/lib/cast-sort.test.ts`) — extracted comparator behaviour.
- Vitest unit (`src/store/voice-readiness-selectors.test.ts`) — empty cast; designed
  excluded; 0-line undesigned INCLUDED in list but firing condition false when only 0-line
  members are undesigned; per-character `ttsEngine:'qwen'` override included when project
  default is non-Qwen; sort order; `selectIsBookNonEnglish` true/false/missing-book.
- Vitest unit (`src/store/start-generation-flow.test.ts`, exists) — speaking undesigned →
  `openVoiceReadinessGate`; only 0-line undesigned → `openStartGenPrompt`; fully designed →
  unchanged; non-Qwen → bypass unchanged.
- Vitest unit (`src/modals/voice-readiness-gate.test.tsx`) — English shows proceed,
  non-English omits it; Design-full-cast payload = full undesigned roster;
  `castDesign.active` → "View design progress" variant with no `designAllRequested`.
- Vitest unit (ui-slice/layout) — `openStartGenPrompt({fallbackConfirmed:true})` persists
  on state; tier-modal confirm forwards it into `requestStartGeneration`.
- Vitest unit (`generation-stream-middleware.test.ts`, exists) — flag stamps every FRESH
  auto-enqueued entry; already-queued chapters untouched.
- Vitest server (`queue-io.test.ts`, `queue.test.ts`) — enqueue persists the flag.
- Vitest server (`generation-fallback-gate.test.ts`) — fresh entry with the flag skips the
  per-chapter gate on its FIRST run (not just on confirm-retry).
- Playwright e2e (`e2e/cast-first-landing-and-voice-gate.spec.ts`, new) — (1) confirm →
  `#/cast` → "Continue to manuscript" → `#/manuscript`; (2) English + undesigned: gate
  lists them, "Proceed anyway" falls through to the tier modal and generation starts;
  (3) "Design full cast" from the gate → `#/cast` + design run; once designed, no gate;
  (4) non-English: gate has NO proceed affordance. ⚠ resolve at implementation time
  whether `src/mocks/` can seed a non-English book with an undesigned Qwen character
  (`page.addInitScript` persisted-state trick as in `design-full-cast.spec.ts`).
- **Existing e2e that break:** 14 spec files (~24 sites) assert `#/manuscript` right after
  the Confirm click (`bulk-sync-library`, `generation-parallel`, `generation-resume`,
  `generation-stuck-queued`, `manuscript-detect-emotions{,-instruct}`,
  `manuscript-emotion-preview`, `manuscript-instruct-edit`,
  `manuscript-low-confidence-triage`, `manuscript-promote-first-sentence`,
  `manuscript-reassign-picker`, `new-book-flow`, `queue-modal`,
  `start-generation-tier-prompt`). Add `confirmCastAndReachManuscript(page)` to
  `e2e/helpers.ts` (click Confirm [new label] → wait `#/cast` → click "Continue to
  manuscript" → wait `#/manuscript`) and swap all sites to it.

### Manual acceptance walkthrough

Mock mode (`VITE_USE_MOCKS=true`):

1. Upload/analyse a book → confirm stage → click **"Confirm cast and design voices"** →
   expected hash `#/books/<id>/cast`, cast roster + "Continue to manuscript" visible.
2. Click **"Continue to manuscript"** → `#/books/<id>/manuscript`.
3. With undesigned Qwen characters, click **"Approve cast & start generating"** → the
   voice-readiness gate lists them (talk-time order).
4. English book: **"Proceed anyway"** → tier modal → confirm → generation starts, no
   per-chapter fallback prompts for that run's chapters.
5. Non-English book: gate shows the hard-block copy, no proceed button.
6. From the gate, **"Design full cast"** → `#/cast`, design pill running; while running,
   re-trigger the gate → primary CTA reads "View design progress".
7. Lone "Generate this chapter" on a book with undesigned speakers → per-chapter
   `awaiting_confirm` backstop still fires (unchanged).

## Out of scope

- The pre-existing non-English per-chapter dead-end ("Render anyway" →
  `MissingDesignedVoiceError`) — separate `bug` issue.
- `openapi.yaml` `QueueEnqueueRequest` schema drift vs the real `entries[]` route —
  separate chore issue; don't "fix" mid-PR.
- Tier-modal 1.7B guard convergence onto the new selector — TODO/fast-follow.
- Release-notes entries land with the implementation PR, not this docs PR.

## Ship notes

(To be filled at ship: date, SHA, behaviour delta vs spec.)
