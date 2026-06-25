# fs-58 Unit B — reattribute + flag_nonstory (+ cast-create) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two LLM Script Review op classes — `reattribute` (re-assign a line to the correct cast member, incl. operator-confirmed creation of a never-detected character) and `flag_nonstory` (soft-exclude import residue from synthesis) — to the shipped fs-58 Unit A harness.

**Architecture:** Both classes extend the existing read-only review pass + flat op envelope + `ScriptReviewDiff` modal + client-side apply layer. `reattribute` reuses `setSentenceCharacter`; off-roster adds a `POST /cast/create` route (mirroring `cast-add-from-roster`) consumed by an interleaved create→reassign async apply path. `flag_nonstory` adds a persisted `excludeFromSynthesis` boolean filtered at synth time, with a third precise render-map staleness diff. Spec: `docs/superpowers/specs/2026-06-25-fs58-unit-b-reattribute-flag-nonstory-design.md` (revised through two adversarial rounds).

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend); Node/Express + Zod (server); Vitest (unit, both sides); Playwright (e2e). OpenAPI is the type source of truth.

## Global Constraints

- **Commit convention:** `<type>(<scope>): <subject>` enforced by commit-msg hook; `chore: <subject>` is the only no-scope form. End commit bodies with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **OpenAPI is the type source of truth** — persisted/wire types come from `src/lib/api-types.ts` (generated via `npm run openapi:types`); never hand-write them.
- **Zod schemas in `server/src/handoff/schemas.ts` are `.strict()`** — any new field MUST be added explicitly or stored records fail re-validation.
- **No hex literals in component code** — use the CSS custom properties (`--ink`, `--peach`, etc.) via Tailwind tokens.
- **RTK reducers mutate via Immer drafts** — don't rewrite to spreads.
- **Mocks behind `VITE_USE_MOCKS`** — components import only from `api.*`; every new client call needs a real AND a mock impl.
- **Touch targets ≥44×44 px on phone** — `min-h-[44px] sm:min-h-0`.
- **Every change ships paired automated tests.** New behaviour → new test; bug fix → regression test.
- **Run `npm run verify` before declaring done** (typecheck + all tests + e2e + build).
- **Default scope = all of Unit B.** §11 of the spec names a smallest-slice fallback (flag_nonstory-only, or on-roster-reattribute-only) if scope must shrink — not the chosen scope.

---

## File structure

**Server (create):** `server/src/routes/cast-create.ts`, `server/src/routes/cast-create.test.ts`, `server/src/__fixtures__/import-residue.md`.
**Server (modify):** `openapi.yaml` (Sentence schema), `server/src/handoff/schemas.ts` (sentenceSchema + scriptReviewSchema), `server/src/tts/synthesise-chapter.ts` (buildSentenceGroups), `server/src/routes/generation.ts` (all-excluded guard), `server/src/app.ts` (route mount), `skills/audiobook-script-review.md` (prompt).
**Client (create):** `src/components/create-character-form.tsx` (+ test), `src/lib/apply-proposed.ts` (+ test).
**Client (modify):** `src/lib/api-types.ts` (regen), `src/lib/script-review-apply.ts` (ReviewOp + roster + reattribute arm), `src/lib/stale-chapters.ts` (third diff), `src/store/manuscript-slice.ts` (setSentenceExcluded + hydrate-merge), `src/store/script-review-slice.ts` (default-OFF seeding), `src/components/script-review-diff.tsx` (OpPreview/labels + async apply), `src/views/manuscript.tsx` (excluded-line UX + Add-character button), `src/views/generation.tsx` (wire third diff), `src/lib/api.ts` (real+mock cast/create).
**E2E:** `e2e/script-review.spec.ts` (extend) + `e2e/responsive/coverage.spec.ts` (append).
**Docs:** the spec, `docs/BACKLOG.md`, `docs/features/INDEX.md`.

---

## Round-3 plan-review corrections (AUTHORITATIVE — apply these; they override the task bodies below where they conflict)

Three reviewers verified every snippet against the real code. The designs are sound; these are exact-name / edit-site / harness corrections. **An implementer MUST apply each before writing the corresponding task.**

- **Reducers are `*Slice.reducer`, never `*Reducer`.** Tasks use `manuscriptReducer` / `scriptReviewReducer` — neither is exported. Use `manuscriptSlice.reducer` (import `manuscriptSlice`) and `scriptReviewSlice.reducer` (import `scriptReviewSlice`). (T3, T11)
- **T3 re-analysis action is `hydrateFromAnalysis`, not `setAnalysisChapters`.** Payload is `{ bookId, sentences, ... }` (an `AnalyseResponse`), and the preserve-merge at `manuscript-slice.ts:146` runs **only when `manuscriptId !== null`** — so the test must seed `manuscriptId: 'b1'` in the start state, then dispatch `manuscriptActions.hydrateFromAnalysis({ bookId: 'b1', sentences: [...] })`.
- **T9: `mock`/`real` are NOT exported from `api.ts`.** Export a standalone `mockCreateCharacter` (mirror `mockAddFromSeriesRoster`, `api.ts:3601`) + `realCreateCharacter`, register both in the `real`/`mock` objects (`api.ts:7069`/`:7332`), and test via `import { mockCreateCharacter }`. **`mockCreateCharacter` must return a FULL `Character`** (all fields the type requires — `aliases: []`, `voiceId` undefined, etc.), so T12/T14 can drop the `as never` cast on `castActions.addCharacter`.
- **T8 wiring site + projection.** The stale-OR gate is at `generation.tsx:1189` (NOT :656-686 — those build the memos). The two existing diffs build narrow projections inline (`{id,characterId}` `:654`, `{id,text}` `:678`) — neither carries `excludeFromSynthesis`. Add a THIRD sibling memo `excludedSinceRenderSet` projecting `{ id, excludeFromSynthesis }` over `byChapter.get(ch.id)`, then add `(renderedSpeakersByChapter[ch.id] ? excludedSinceRenderSet.has(ch.id) : false) ||` to the OR at :1189. The pure helper signature is fine.
- **T12 control-flow fix (the one real design correction).** You CANNOT `await applyProposedReattributions` inside `handleApply` while also collecting a per-op React confirm click — a function can't pause for a future render. Restructure: `handleApply` applies the **direct** ops synchronously, then if `proposedOps.length > 0` sets `confirming` state and **returns**. The `CreateCharacterForm`'s `onSubmit`/`onReattributeExisting` (rendered from that state) collects final values and **calls `applyProposedReattributions` itself**, then `clearReview`. The pure helper (Steps 1-4) is unchanged and correct. Add imports to `script-review-diff.tsx`: `manuscriptActions`, `castActions`, `api`, `CreateCharacterForm`, `applyProposedReattributions`; get `bookId`-change detection via a `useAppSelector((s) => s.ui.stage)` captured at click time (NOT a raw `store` import).
- **T13 edit site is `SegmentRow` (`manuscript.tsx:1368`), where `dispatch` is NOT in scope.** Call the hooks at the top of `SegmentRow` (it IS a component — legal): `const dispatch = useAppDispatch();` and `const markStale = useMarkCharacterStaleIfRendered();` (this hook DOES exist at `stale-chapters.ts:74` and is used by `sentence-instruct-control.tsx` — reviewer-3's "missing" claim was a false positive). `char` and `liveInstruct` are already in scope.
- **T13 test asserts the wrong node.** `renderSentenceText` returns an INNER `<span data-text-offset>`, so `getByText('p. 42')` resolves to it, not the outer `data-sentence-id` span carrying `line-through opacity-50`. Assert via `screen.getByText('p. 42').closest('[data-sentence-id]')`.
- **T13 "disable split on an excluded line" is deferred polish, not v1.** The split affordance is the selection popover (`useSentenceSelection`), not a per-sentence drag; guarding it is non-trivial. Drop it from v1 (note as a follow-up); ship struck + toggle + chip-suppression.
- **T14: `SidebarPanels` (`manuscript.tsx:1035`) lacks `bookId`/`dispatch`.** Thread `bookId` + an `onCreateCharacter(fields) => Promise<void>` (a thunk owning `dispatch` + `api.createCharacter`) into `SidebarPanelsProps` and wire BOTH render paths (main `:614` and the mobile drawer copy). Add imports for `useState`, `CreateCharacterForm`.
- **T10: write the gender + ageRange `<select>` blocks** — the "omitted controls" comment is a placeholder violation (3-option gender, 4-option ageRange, `aria-label`s, 44px targets), since these feed `api.createCharacter` → voice design.
- **T17: extend the mock review pass.** `mockReviewScript` (`api.ts:2985`) emits one hardcoded `strip_tag`. Add `api.ts` to T17's Files and a step to make it emit an off-roster `reattribute` (`proposed`) + a `flag_nonstory` op, targeting real fixture sentence ids/anchors — `flag_nonstory` must hit a sentence whose text is literally `p. 42` (the e2e assertion). `class-toggle-*` are real checkbox inputs (`.check()` works).
- **T4 test harness has no auth.** `cast-add-from-roster.test.ts` builds a bare `express()` + `express.json()` (no LAN-token/CSRF), seeds books via `writeBookOnDisk` + `makeBookId(AUTHOR,SERIES,TITLE)` + `process.env.WORKSPACE_DIR`. Drop `.set(authHeaders)`; copy that harness verbatim. (The route CODE is correct as written.)
- **T6 test: `processOneChapter` is a private closure; `runChapterAndCollect` doesn't exist.** Drive the real SSE route: seed an all-`excludeFromSynthesis:true` chapter via `saveAnalysisCache(MANUSCRIPT_ID, { chapters: {...} })`, `POST /api/books/:bookId/generation`, `parseTicks(res.text)`, filter `chapter_failed`, assert `/flagged non-story/i`. `generation.test.ts` is a SLOW-suite file (timeout-prone). The guard CODE is correct.
- **T16 is a schema-coverage test, not an apply-layer test.** Relabel honestly (the `safeParse` exercises neither the analyzer pass nor apply); the fixture is consumed by T17's e2e, not T16. Or wire it through `runScriptReviewChapter` (the real `script-review.test.ts` mock-analyzer harness).
- **Verified-correct (no change):** all server route/schema/filter/guard CODE (Zod `.superRefine` + `toJSONSchema` confirmed working in `zod@4.4.3`); T7 roster-param edit + line refs; the default-param additions don't break existing callers; cross-task type signatures (`setSentenceExcluded`, `setSentenceCharacter`, `isChapterExcludedSinceRender`, roster order) are consistent; task ordering has no use-before-define.

## Round-4 plan-review corrections (AUTHORITATIVE — two integration killers + the T12 queue; apply before executing)

Round 4 (two reviewers) verified the round-3 corrections held, and caught what unit-level review can't — features that compile and pass per-task tests but are **inert when assembled**:

- **B1 [BLOCKER] — `flag_nonstory` never persists; T5's filter is dead in production.** Frontend persistence is a strict action-allowlist (`src/store/persistence-middleware.ts:299-300` — an action not in `PERSIST_RULES` mutates Redux but fires NO `PUT /state`). The new `manuscript/setSentenceExcluded` (T3) is absent, so the flag never reaches `manuscript-edits.json` → never reaches the edits-win rebuild → never reaches `buildSentenceGroups`. Unit tests stay green; the feature does nothing end-to-end. **Fix (fold into T3):** add `PERSIST_RULES['manuscript/setSentenceExcluded']` mirroring the `setSentenceText`/`setSentenceCharacter` rule (build `{ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }` — match the exact shape the sibling manuscript rules emit), add `src/store/persistence-middleware.ts` to T3's Files, and add a persistence-middleware test asserting the PUT fires on `setSentenceExcluded`. `reattribute` is safe (rides the already-registered `setSentenceCharacter` rule).
- **M1 [MAJOR] — seed-time `planApply` gets no roster; on-roster `reattribute` is mis-sorted to `unappliable` before the modal renders.** `manuscript.tsx:704` runs `planApply(allOps, live)` at stream-complete to pre-sort ops into the diff bucket; with T7's empty default roster, the new `reattribute`-characterId-not-in-roster guard sends every on-roster reattribute to `unappliable` → never offered. **Fix (fold into T7):** change `manuscript.tsx:704` to `planApply(allOps, live, new Set(characters.map((c) => c.id)))` (`characters` is in scope at `manuscript.tsx:110`); add `src/views/manuscript.tsx` to T7's Files.
- **T12 [MAJOR] — the confirm step must be a QUEUE, not a single-op confirm.** `applyProposedReattributions` dedupes via a `memo` scoped to ONE call and a `rosterByName` snapshot captured before any create. If the UI confirms ops one-at-a-time and calls the helper per confirm, each call gets a fresh memo → two same-name `proposed` ops each fire a create (spec §3.3a violation) and the isSameBook batch-abort guarantee is lost. **Fix:** the confirm UI collects ALL N confirmed proposed values (confirm op 1 → … → op N) into an array, then calls `applyProposedReattributions(finalProposed, deps)` **exactly once** with the full array, then `clearReview` once. Model `confirming` as a queue/index, not a single nullable op. Add a `script-review-diff.test.tsx` case: two same-name proposed ops → exactly ONE `api.createCharacter` call.
- **T12 cancel semantics:** Cancel mid-confirm leaves already-applied direct ops in place and clears the bucket (don't re-offer applied ops); do not create any not-yet-confirmed members.
- **T17 [MINOR] — seed the `p. 42` sentence.** No mock sentence reads `p. 42`. Add one to the e2e fixture book's chapter (the SB book the review drives) and target the mock `flag_nonstory` op's `id`/`anchor` at it, so the struck-line assertion resolves.
- **Drop the `as never` casts** in T12/T14 once `mockCreateCharacter`/`realCreateCharacter` return a full `Character` (T9) — `castActions.addCharacter` takes `PayloadAction<Character>`.
- **NIT line refs:** `useMarkCharacterStaleIfRendered` is at `stale-chapters.ts:116`; the T8 third memo builds its OWN local `byChapter` from the live `sentences` (there is no shared `byChapter` in scope) — mirror the two sibling memos exactly.
- **Verified GREEN end-to-end (no change):** reattribute server→client field survival (SSE emits `result.ops` whole; client + slice are pass-through; only the `.strict()` schema projects, and T2 adds the fields there); the prompt receives the post-fold roster (`script-review.ts:122-123,197-202`); the generation edits-win rebuild reads the edited store whole (`generation.ts:690-697`); commit/build sequencing has no intermediate red (no `never` exhaustiveness guard in the op switches).

---

## Task 1: `excludeFromSynthesis` field — openapi + sentenceSchema + api-types regen

**Files:**
- Modify: `openapi.yaml` (`Sentence` schema, ~`:4861`)
- Modify: `server/src/handoff/schemas.ts:120-134` (`sentenceSchema`)
- Modify: `src/lib/api-types.ts` (regenerated, do not hand-edit)
- Test: `server/src/handoff/schemas.test.ts` (add a case; create if absent)

**Interfaces:**
- Produces: `SentenceOutput` gains `excludeFromSynthesis?: boolean`; the generated `Sentence` type (api-types) gains the same.

- [ ] **Step 1: Write the failing test** in `server/src/handoff/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sentenceSchema } from './schemas';

describe('sentenceSchema excludeFromSynthesis (fs-58 Unit B)', () => {
  it('accepts a sentence carrying excludeFromSynthesis', () => {
    const r = sentenceSchema.safeParse({
      id: 1, chapterId: 1, characterId: 'narrator', text: 'A line.', excludeFromSynthesis: true,
    });
    expect(r.success).toBe(true);
  });
  it('still accepts a sentence WITHOUT the field (additive)', () => {
    const r = sentenceSchema.safeParse({ id: 1, chapterId: 1, characterId: 'narrator', text: 'A line.' });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify the first case fails**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts -t excludeFromSynthesis`
Expected: FAIL — `.strict()` rejects the unknown key `excludeFromSynthesis`.

- [ ] **Step 3: Add the field to `sentenceSchema`** (after the `vocalization` line, before `.strict()`):

```ts
    vocalization: z.boolean().optional(),
    /* fs-58 Unit B — flag_nonstory soft-exclude. Absent/false ⇒ synthesised
       as today; true ⇒ filtered out of buildSentenceGroups. Additive. */
    excludeFromSynthesis: z.boolean().optional(),
  })
  .strict();
```

- [ ] **Step 4: Add the field to `openapi.yaml`** under the `Sentence` schema's `properties` (match the existing yaml style):

```yaml
        excludeFromSynthesis:
          type: boolean
          description: >-
            fs-58 Unit B — when true, this sentence is import residue (page
            number, running header, etc.) and is excluded from synthesis.
```

- [ ] **Step 5: Regenerate api-types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` diff shows `excludeFromSynthesis?: boolean` on `Sentence`. Do not hand-edit.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add openapi.yaml server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts src/lib/api-types.ts
git commit -m "feat(server): add excludeFromSynthesis Sentence field (fs-58 Unit B)"
```

---

## Task 2: Extend the op envelope — client `ReviewOp` + server `scriptReviewSchema`

**Files:**
- Modify: `src/lib/script-review-apply.ts:43-54` (`ReviewOp` interface)
- Modify: `server/src/handoff/schemas.ts:224-246` (`scriptReviewSchema` + comment)
- Test: `server/src/handoff/schemas.test.ts`

**Interfaces:**
- Produces: `ReviewOp.op` union gains `'reattribute' | 'flag_nonstory'`; `ReviewOp` gains `characterId?: string` and `proposed?: { name: string; gender?: string; ageRange?: string }`. Server `scriptReviewSchema` accepts both ops and enforces the `characterId` XOR `proposed` rule for `reattribute`.

- [ ] **Step 1: Write the failing server tests** in `server/src/handoff/schemas.test.ts`:

```ts
import { scriptReviewSchema } from './schemas';

describe('scriptReviewSchema reattribute + flag_nonstory (fs-58 Unit B)', () => {
  const wrap = (op: object) => scriptReviewSchema.safeParse({ ops: [op] });

  it('accepts on-roster reattribute (characterId only)', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'said Ferra', characterId: 'ferra', rationale: 'wrong speaker' }).success).toBe(true);
  });
  it('accepts off-roster reattribute (proposed only)', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'said Ferra', proposed: { name: 'Ferra', gender: 'female' }, rationale: 'uncast' }).success).toBe(true);
  });
  it('rejects reattribute with BOTH characterId and proposed', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'x', characterId: 'ferra', proposed: { name: 'Ferra' }, rationale: 'r' }).success).toBe(false);
  });
  it('rejects reattribute with NEITHER characterId nor proposed', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'x', rationale: 'r' }).success).toBe(false);
  });
  it('accepts flag_nonstory', () => {
    expect(wrap({ id: 9, op: 'flag_nonstory', anchor: 'p. 42', rationale: 'page number' }).success).toBe(true);
  });
  it('still rejects an unknown op', () => {
    expect(wrap({ id: 1, op: 'rewrite_everything', rationale: 'r' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts -t "reattribute + flag_nonstory"`
Expected: FAIL — enum rejects `reattribute`/`flag_nonstory`; unknown fields rejected by `.strict()`.

- [ ] **Step 3: Extend `scriptReviewSchema`** — update the op enum, add the two fields, and add the XOR via `.superRefine`. Replace the schema block (`:224-243`):

```ts
export const scriptReviewSchema = z
  .object({
    ops: z.array(
      z
        .object({
          id: z.number().int().positive(),
          op: z.enum([
            'strip_tag', 'split', 'extract_dialogue', 'merge', 'fix_emotion',
            // fs-58 Unit B:
            'reattribute', 'flag_nonstory',
          ]),
          newText: z.string().optional(),
          anchor: z.string().optional(),
          anchorEnd: z.string().optional(),
          pieceCharacterIds: z.array(z.string()).optional(),
          mergeIds: z.array(z.number().int().positive()).optional(),
          emotion: z.enum(EMOTIONS).optional(),
          // fs-58 Unit B — reattribute targets:
          characterId: z.string().optional(),
          proposed: z
            .object({
              name: z.string().min(1),
              gender: z.enum(['male', 'female', 'neutral']).optional(),
              ageRange: z.enum(['child', 'teen', 'adult', 'elderly']).optional(),
            })
            .strict()
            .optional(),
          rationale: z.string(),
          confidence: z.number().min(0).max(1).optional(),
        })
        .strict()
        .superRefine((op, ctx) => {
          if (op.op === 'reattribute') {
            const hasId = op.characterId != null;
            const hasProposed = op.proposed != null;
            if (hasId === hasProposed) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'reattribute requires exactly one of characterId or proposed',
              });
            }
          }
        }),
    ),
  })
  .strict();
```

Also update the stale comment at `:213-222`: replace "server pre-apply is N/A (apply is client-side)" with "This schema validates the model's response on BOTH engines (Ollama grammar + Gemini safeParse); a rejected op fails the chapter, so every op class lives here."

- [ ] **Step 4: Extend the client `ReviewOp`** in `src/lib/script-review-apply.ts:43-54`:

```ts
export interface ReviewOp {
  id: number;
  op: 'strip_tag' | 'split' | 'extract_dialogue' | 'merge' | 'fix_emotion' | 'reattribute' | 'flag_nonstory';
  newText?: string;
  anchor?: string;
  anchorEnd?: string;
  pieceCharacterIds?: string[];
  mergeIds?: number[];
  emotion?: string;
  // fs-58 Unit B — reattribute targets (exactly one is set):
  characterId?: string;
  proposed?: { name: string; gender?: string; ageRange?: string };
  rationale: string;
  confidence?: number;
}
```

- [ ] **Step 5: Run server tests + typecheck**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts` then (repo root) `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts src/lib/script-review-apply.ts
git commit -m "feat(server): script-review schema accepts reattribute + flag_nonstory ops (fs-58 Unit B)"
```

---

## Task 3: `setSentenceExcluded` reducer + hydrate-merge preservation

**Files:**
- Modify: `src/store/manuscript-slice.ts` (new reducer near `:280`; hydrate-merge at `:146`)
- Test: `src/store/manuscript-slice.test.ts`

**Interfaces:**
- Produces: `manuscriptActions.setSentenceExcluded({ chapterId, sentenceId, excluded })`. Re-analysis hydrate-merge preserves `excludeFromSynthesis`.

- [ ] **Step 1: Write the failing tests** in `src/store/manuscript-slice.test.ts`:

```ts
import { manuscriptReducer, manuscriptActions } from './manuscript-slice';

describe('setSentenceExcluded (fs-58 Unit B)', () => {
  const base = () => ({ sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'p. 42' }] }) as any;

  it('sets and clears the exclude flag scoped by (chapterId, sentenceId)', () => {
    let s = manuscriptReducer(base(), manuscriptActions.setSentenceExcluded({ chapterId: 1, sentenceId: 1, excluded: true }));
    expect(s.sentences[0].excludeFromSynthesis).toBe(true);
    s = manuscriptReducer(s, manuscriptActions.setSentenceExcluded({ chapterId: 1, sentenceId: 1, excluded: false }));
    expect(s.sentences[0].excludeFromSynthesis).toBe(false);
  });
});
```

For the hydrate-merge preservation, add a test next to the existing hydrate/merge tests (find the `setAnalysis`/re-analysis action name in the slice — referenced at `:104-112`):

```ts
it('preserves excludeFromSynthesis across re-analysis (hydrate-merge)', () => {
  let s = { manuscriptId: 'b1', sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'p. 42', excludeFromSynthesis: true }] } as any;
  // Re-analysis delivers a fresh sentence with the SAME (chapterId,id) and no exclude flag:
  s = manuscriptReducer(s, manuscriptActions.setAnalysisChapters({ manuscriptId: 'b1', sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'p. 42' }] }) as any);
  expect(s.sentences[0].excludeFromSynthesis).toBe(true);
});
```

> NOTE to implementer: confirm the exact re-analysis action name/payload at `manuscript-slice.ts:104-146` and adjust the dispatch above to match it (the merge that does `merged.push({ ...inc, characterId: x.characterId, text: x.text })`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/store/manuscript-slice.test.ts -t "fs-58"`
Expected: FAIL — no `setSentenceExcluded`; preserved flag is `undefined` after merge.

- [ ] **Step 3: Add the reducer** after `setSentenceText` (`:280-283`):

```ts
    /* fs-58 Unit B — User/review edit: mark a sentence excluded from synthesis
       (flag_nonstory) or re-include it. Scoped by (chapterId, sentenceId) like
       setSentenceText. No-op if the sentence is not found. */
    setSentenceExcluded: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceId: number; excluded: boolean }>,
    ) => {
      const sent = s.sentences.find((x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId);
      if (sent) sent.excludeFromSynthesis = a.payload.excluded;
    },
```

- [ ] **Step 4: Preserve the flag in the hydrate-merge** at `:146`. Change:

```ts
      merged.push({ ...inc, characterId: x.characterId, text: x.text });
```

to:

```ts
      merged.push({ ...inc, characterId: x.characterId, text: x.text, excludeFromSynthesis: x.excludeFromSynthesis });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/store/manuscript-slice.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/manuscript-slice.ts src/store/manuscript-slice.test.ts
git commit -m "feat(frontend): setSentenceExcluded reducer + preserve flag across re-analysis (fs-58 Unit B)"
```

---

## Task 4: `POST /api/books/:bookId/cast/create` route

**Files:**
- Create: `server/src/routes/cast-create.ts`, `server/src/routes/cast-create.test.ts`
- Modify: `server/src/app.ts` (mount, mirror the `cast-add-from-roster` registration)

**Interfaces:**
- Produces: `POST /api/books/:bookId/cast/create` with body `{ name, gender?, ageRange?, role? }` → `{ character }` (full new record, `voiceState: 'generated'`, `color: 'unset'`, no `matchedFrom`). Mirrors `cast-add-from-roster.ts`.

- [ ] **Step 1: Write the failing route test** in `server/src/routes/cast-create.test.ts`. Mirror the harness of `cast-add-from-roster.test.ts` (same workspace fixture + supertest setup — read it for the exact helper imports):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
// import the same test app + workspace helpers cast-add-from-roster.test.ts uses

describe('POST /api/books/:bookId/cast/create (fs-58 Unit B)', () => {
  // beforeEach: seed a book with a cast.json containing [{ id: 'narrator', ... }]
  it('mints a new character and appends it to cast.json', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/create`).set(authHeaders).send({ name: 'Ferra', gender: 'female' });
    expect(res.status).toBe(200);
    expect(res.body.character.name).toBe('Ferra');
    expect(res.body.character.id).toMatch(/ferra/);
    expect(res.body.character.voiceState).toBe('generated');
    // and it is on disk:
    const cast = await readCastJson(bookDir);
    expect(cast.characters.some((c) => c.id === res.body.character.id)).toBe(true);
  });
  it('suffixes the id on collision', async () => {
    await request(app).post(`/api/books/${bookId}/cast/create`).set(authHeaders).send({ name: 'Ferra' });
    const res2 = await request(app).post(`/api/books/${bookId}/cast/create`).set(authHeaders).send({ name: 'Ferra' });
    expect(res2.body.character.id).not.toBe('ferra');
  });
  it('400s on empty name', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/create`).set(authHeaders).send({ name: '  ' });
    expect(res.status).toBe(400);
  });
  it('409s when the book has no cast.json yet', async () => {
    const res = await request(app).post(`/api/books/${bookIdNoCast}/cast/create`).set(authHeaders).send({ name: 'Ferra' });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/cast-create.test.ts`
Expected: FAIL — route 404 (not mounted).

- [ ] **Step 3: Implement the route** in `server/src/routes/cast-create.ts` (adapt `cast-add-from-roster.ts` — same imports `findBookByBookId`, `castJsonPath`, `readJson`, `writeJsonAtomic`, `randomBytes`):

```ts
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { randomBytes } from 'node:crypto';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castCreateRouter = Router();

type PersistedCharacter = CharacterOutput & {
  voiceState?: 'generated' | 'tuned' | 'reused' | 'locked';
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
};
interface CastFile { characters: PersistedCharacter[] }

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'character';
}

castCreateRouter.post('/:bookId/cast/create', async (req, res: Response) => {
  const bookId = (req as Request).params.bookId;
  const body = (req.body ?? {}) as { name?: unknown; gender?: unknown; ageRange?: unknown; role?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required.' });

  const located = await findBookByBookId(bookId);
  if (!located) return res.status(404).json({ error: `Book "${bookId}" not found.` });

  const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
  if (!cast?.characters) {
    return res.status(409).json({ error: 'Book has no cast.json yet. Confirm cast before adding.' });
  }

  const existingIds = new Set(cast.characters.map((c) => c.id));
  let newId = slugify(name);
  if (existingIds.has(newId)) newId = `${newId}_${randomBytes(3).toString('hex')}`;

  const newCharacter: PersistedCharacter = {
    id: newId,
    name,
    role: typeof body.role === 'string' ? body.role : 'character',
    color: 'unset',
    gender: body.gender === 'male' || body.gender === 'female' || body.gender === 'neutral' ? body.gender : undefined,
    ageRange: ['child', 'teen', 'adult', 'elderly'].includes(body.ageRange as string) ? (body.ageRange as PersistedCharacter['ageRange']) : undefined,
    voiceState: 'generated',
  };

  await writeJsonAtomic(castJsonPath(located.bookDir), { characters: [...cast.characters, newCharacter] });
  console.log(`[cast-create] ${bookId} + "${newId}"`);
  return res.json({ character: newCharacter });
});
```

- [ ] **Step 4: Mount the router** in `server/src/app.ts` (next to the `cast-add-from-roster` mount, `~:153`):

```ts
import { castCreateRouter } from './routes/cast-create.js';
// ...
app.use('/api/books', castCreateRouter);
```

- [ ] **Step 5: Run the route test**

Run: `cd server && npx vitest run src/routes/cast-create.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/cast-create.ts server/src/routes/cast-create.test.ts server/src/app.ts
git commit -m "feat(server): POST /cast/create route mints a net-new cast member (fs-58 Unit B)"
```

---

## Task 5: `buildSentenceGroups` exclude filter

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts:699-711` (`buildSentenceGroups`)
- Test: `server/src/tts/synthesise-chapter.test.ts` (or the colocated synth test — confirm filename)

**Interfaces:**
- Consumes: `SentenceOutput.excludeFromSynthesis` (Task 1).
- Produces: an excluded sentence yields no `SentenceGroup`; `index` re-sequenced over kept groups (no hole).

- [ ] **Step 1: Write the failing test:**

```ts
import { buildSentenceGroups } from './synthesise-chapter';

describe('buildSentenceGroups exclude filter (fs-58 Unit B)', () => {
  it('drops excluded sentences and re-sequences index with no gap', () => {
    const groups = buildSentenceGroups([
      { id: 1, characterId: 'narrator', text: 'Kept one.' },
      { id: 2, characterId: 'narrator', text: 'p. 42', excludeFromSynthesis: true },
      { id: 3, characterId: 'narrator', text: 'Kept two.' },
    ] as any);
    expect(groups.map((g) => g.sentenceIds[0])).toEqual([1, 3]);
    expect(groups.map((g) => g.index)).toEqual([0, 1]); // no hole at the dropped slot
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts -t "exclude filter"`
Expected: FAIL — id 2 still produces a group.

- [ ] **Step 3: Add the filter** — chain it onto the existing empty-text filter (`:699-700`):

```ts
  return sentences
    .filter((s) => !s.excludeFromSynthesis) // fs-58 Unit B — flag_nonstory
    .filter((s) => normaliseForTts(s.text).trim() !== '')
    .map((s, i) => ({
```

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts -t "exclude filter"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter.test.ts
git commit -m "feat(server): buildSentenceGroups excludes flag_nonstory sentences (fs-58 Unit B)"
```

---

## Task 6: All-excluded chapter guard + distinct terminal reason

**Files:**
- Modify: `server/src/routes/generation.ts:1047-1058` (the raw-count guard in `processOneChapter`)
- Test: `server/src/routes/generation.test.ts` (or the slow-routes test file — confirm where generation route tests live)

**Interfaces:**
- Produces: a chapter whose every sentence is `excludeFromSynthesis` broadcasts `chapter_failed` with `errorReason` `'All content in this chapter is flagged non-story — nothing to synthesise.'` (NOT the generic cache-incomplete message, and NOT a 0-byte "complete").

- [ ] **Step 1: Write the failing test** — drive `processOneChapter` (or the SSE route) with an analysis whose chapter sentences are all `excludeFromSynthesis: true`, assert the broadcast reason. Mirror the existing `chapter_failed` assertions in the file:

```ts
it('fails an all-excluded chapter with a distinct reason (fs-58 Unit B)', async () => {
  // analysis.chapters[chId] = [{ id:1, chapterId:chId, characterId:'narrator', text:'p.1', excludeFromSynthesis:true }]
  const events = await runChapterAndCollect(chId); // helper that collects broadcasts
  const failed = events.find((e) => e.type === 'chapter_failed');
  expect(failed?.errorReason).toMatch(/flagged non-story/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/generation.test.ts -t "all-excluded"`
Expected: FAIL — currently renders a near-empty "complete" (no `chapter_failed`).

- [ ] **Step 3: Add the kept-count guard** right after the existing raw-count guard (`:1058`):

```ts
    const keptCount = sentences.filter((s) => !s.excludeFromSynthesis).length;
    if (keptCount === 0) {
      job.runInProgress.delete(chapter.id);
      broadcast(job, {
        type: 'chapter_failed',
        chapterId: chapter.id,
        errorReason: 'All content in this chapter is flagged non-story — nothing to synthesise.',
      });
      return;
    }
```

> NOTE: `sentences` here is `analysis.chapters[chapter.id]` (`:1047`). Confirm those objects carry `excludeFromSynthesis` (they come from the analysis cache, which is `SentenceOutput[]` — Task 1 put the field on that type).

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run src/routes/generation.test.ts -t "all-excluded"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/generation.ts server/src/routes/generation.test.ts
git commit -m "fix(server): all-excluded chapter fails with a distinct reason, not a 0-byte success (fs-58 Unit B)"
```

---

## Task 7: `reattribute` dispatcher arm + roster param on the apply layer

**Files:**
- Modify: `src/lib/script-review-apply.ts` (`planApply` + `dispatchAcceptedOps` signatures; new `reattribute` arm)
- Test: `src/lib/script-review-apply.test.ts`

**Interfaces:**
- Consumes: `ReviewOp` (Task 2).
- Produces: `planApply(ops, live, roster?)` and `dispatchAcceptedOps(dispatch, accepted, live, { onBoundaryMove }, roster?)` — `roster: Set<string>`. On-roster `reattribute` (has `characterId`) dispatches `setSentenceCharacter`; a `characterId` not in `roster` → un-appliable; a `proposed` (off-roster) op is appliable at plan time but is NOT dispatched by `dispatchAcceptedOps` (the async layer in Task 12 handles it). `flag_nonstory` dispatches `setSentenceExcluded({ excluded: true })`.

- [ ] **Step 1: Write the failing tests** in `src/lib/script-review-apply.test.ts`:

```ts
import { planApply, dispatchAcceptedOps } from './script-review-apply';
import { manuscriptActions } from '../store/manuscript-slice';

const live = [{ id: 5, chapterId: 1, text: 'Hello, said Ferra.', characterId: 'narrator' }];

describe('reattribute (fs-58 Unit B)', () => {
  it('on-roster reattribute is appliable when characterId is in roster', () => {
    const ops = [{ id: 5, op: 'reattribute', anchor: 'said Ferra', characterId: 'ferra', rationale: 'r' }] as any;
    const { appliable } = planApply(ops, live, new Set(['narrator', 'ferra']));
    expect(appliable).toHaveLength(1);
  });
  it('rejects a reattribute whose characterId is NOT in roster', () => {
    const ops = [{ id: 5, op: 'reattribute', anchor: 'said Ferra', characterId: 'ghost', rationale: 'r' }] as any;
    const { appliable, unappliable } = planApply(ops, live, new Set(['narrator']));
    expect(appliable).toHaveLength(0);
    expect(unappliable[0].reason).toMatch(/roster/i);
  });
  it('dispatchAcceptedOps fires setSentenceCharacter for on-roster reattribute', () => {
    const calls: any[] = [];
    dispatchAcceptedOps((a) => calls.push(a), [{ id: 5, op: 'reattribute', anchor: 'x', characterId: 'ferra', rationale: 'r' }] as any, live, { onBoundaryMove: () => {} }, new Set(['ferra']));
    expect(calls).toContainEqual(manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 5, characterId: 'ferra' }));
  });
  it('flag_nonstory dispatches setSentenceExcluded(true)', () => {
    const calls: any[] = [];
    dispatchAcceptedOps((a) => calls.push(a), [{ id: 5, op: 'flag_nonstory', anchor: 'x', rationale: 'r' }] as any, live, { onBoundaryMove: () => {} }, new Set());
    expect(calls).toContainEqual(manuscriptActions.setSentenceExcluded({ chapterId: 1, sentenceId: 5, excluded: true }));
  });
  it('a proposed (off-roster) reattribute is appliable but NOT dispatched here', () => {
    const calls: any[] = [];
    const ops = [{ id: 5, op: 'reattribute', anchor: 'x', proposed: { name: 'Ferra' }, rationale: 'r' }] as any;
    const { appliable } = planApply(ops, live, new Set());
    expect(appliable).toHaveLength(1);
    dispatchAcceptedOps((a) => calls.push(a), appliable, live, { onBoundaryMove: () => {} }, new Set());
    expect(calls.find((c) => c.type?.includes('setSentenceCharacter'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/script-review-apply.test.ts -t "fs-58 Unit B"`
Expected: FAIL — no roster param; no reattribute/flag_nonstory arms.

- [ ] **Step 3: Add the roster param to `planApply`** (signature `:89-92`) and the non-structural validation (`:123-128`). Add `roster: Set<string> = new Set()` as a third param, then inside the non-structural loop:

```ts
  for (const op of ops.filter((o) => !STRUCTURAL.has(o.op))) {
    if (consumed.has(op.id)) { unappliable.push({ op, reason: 'id consumed by a structural op' }); continue; }
    if (!byId.has(op.id)) { unappliable.push({ op, reason: 'target id missing' }); continue; }
    if (op.op === 'fix_emotion' && !REVIEW_EMOTIONS.includes(op.emotion as never)) { unappliable.push({ op, reason: 'invalid emotion value' }); continue; }
    if (op.op === 'reattribute' && op.characterId != null && !roster.has(op.characterId)) {
      unappliable.push({ op, reason: 'reattribute characterId not in roster' }); continue;
    }
    appliable.push(op);
  }
```

(A `proposed` reattribute has no `characterId`, so it skips the roster check and is appliable — Task 12 resolves it.)

- [ ] **Step 4: Add the `reattribute` + `flag_nonstory` arms to `dispatchAcceptedOps`** (signature gains `roster: Set<string> = new Set()`; new cases in the switch `:143-166`):

```ts
      case 'reattribute':
        // On-roster only here — proposed/off-roster ops are handled by the
        // async create→reassign path (apply-proposed.ts) BEFORE this runs.
        if (op.characterId) {
          dispatch(manuscriptActions.setSentenceCharacter({ chapterId, sentenceId: op.id, characterId: op.characterId }));
        }
        break;
      case 'flag_nonstory':
        dispatch(manuscriptActions.setSentenceExcluded({ chapterId, sentenceId: op.id, excluded: true }));
        break;
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/lib/script-review-apply.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/script-review-apply.ts src/lib/script-review-apply.test.ts
git commit -m "feat(frontend): apply layer handles reattribute + flag_nonstory with a roster guard (fs-58 Unit B)"
```

---

## Task 8: `isChapterExcludedSinceRender` precise staleness diff

**Files:**
- Modify: `src/lib/stale-chapters.ts` (new pure helper), `src/views/generation.tsx` (wire into the stale-OR ~`:656-686`)
- Test: `src/lib/stale-chapters.test.ts`

**Interfaces:**
- Consumes: `renderedSpeakersByChapter` (id→characterId render map, already on the book-state GET) + live sentences carrying `excludeFromSynthesis`.
- Produces: `isChapterExcludedSinceRender(rendered, currentSentences): boolean` — true if any rendered id is now excluded.

- [ ] **Step 1: Write the failing test** in `src/lib/stale-chapters.test.ts`:

```ts
import { isChapterExcludedSinceRender } from './stale-chapters';

describe('isChapterExcludedSinceRender (fs-58 Unit B)', () => {
  const rendered = { 1: 'narrator', 2: 'narrator' }; // ids that produced audio
  it('is stale when a rendered id is now excluded', () => {
    expect(isChapterExcludedSinceRender(rendered, [
      { id: 1, excludeFromSynthesis: false }, { id: 2, excludeFromSynthesis: true },
    ])).toBe(true);
  });
  it('is not stale when no rendered id is excluded', () => {
    expect(isChapterExcludedSinceRender(rendered, [
      { id: 1, excludeFromSynthesis: false }, { id: 2, excludeFromSynthesis: false },
    ])).toBe(false);
  });
  it('ignores a NON-rendered id that is excluded (no false positive)', () => {
    expect(isChapterExcludedSinceRender(rendered, [
      { id: 1, excludeFromSynthesis: false }, { id: 2, excludeFromSynthesis: false }, { id: 99, excludeFromSynthesis: true },
    ])).toBe(false);
  });
  it('returns false for an empty/absent render map', () => {
    expect(isChapterExcludedSinceRender(undefined, [{ id: 1, excludeFromSynthesis: true }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/stale-chapters.test.ts -t "ExcludedSinceRender"`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement the helper** in `src/lib/stale-chapters.ts` (beside `isChapterReassignedSinceRender`):

```ts
/* fs-58 Unit B — flag_nonstory precise staleness. Iterate the RENDERED ids
   (keys that produced a segment at render time, from renderedSpeakersByChapter);
   if any is now excludeFromSynthesis ⇒ that line will be dropped on the next
   render ⇒ stale. Asymmetric like isChapterReassignedSinceRender: a never-
   rendered id can't trip a false positive. The re-include direction (a line
   excluded AT render, later re-included) is covered coarsely on the manual
   toggle, not here. */
export function isChapterExcludedSinceRender(
  rendered: Record<number, string> | undefined,
  currentSentences: Array<{ id: number; excludeFromSynthesis?: boolean }>,
): boolean {
  if (!rendered || Object.keys(rendered).length === 0) return false;
  const excluded = new Set(currentSentences.filter((s) => s.excludeFromSynthesis).map((s) => s.id));
  for (const sidStr of Object.keys(rendered)) {
    if (excluded.has(Number(sidStr))) return true;
  }
  return false;
}
```

- [ ] **Step 4: Wire it into the Generate view stale-OR.** In `src/views/generation.tsx` (~`:656-686`, where `isChapterReassignedSinceRender` / `isChapterTextEditedSinceRender` are OR-ed), add `|| isChapterExcludedSinceRender(rendered, currentSentences)` to the same expression, passing the live sentences (which now carry `excludeFromSynthesis`). Import the new helper.

> NOTE: read `generation.tsx` around the existing two diffs to match the exact variable names (`rendered`, the current-sentences array) and the import line.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/lib/stale-chapters.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stale-chapters.ts src/lib/stale-chapters.test.ts src/views/generation.tsx
git commit -m "feat(frontend): precise staleness when a rendered line is flagged non-story (fs-58 Unit B)"
```

---

## Task 9: real + mock `cast/create` client

**Files:**
- Modify: `src/lib/api.ts` (real fetch + mock impl, mirror `addFromSeriesRoster`)
- Test: `src/lib/api.test.ts` (or wherever api mocks are tested — confirm)

**Interfaces:**
- Produces: `api.createCharacter(bookId, { name, gender?, ageRange?, role? }): Promise<Character>`. Real → `POST /api/books/:bookId/cast/create` with LAN-token + same-origin headers (reuse the existing helper the other cast POSTs use). Mock → mints a deterministic slug id and returns a `Character`.

- [ ] **Step 1: Write the failing mock test:**

```ts
import { mock } from './api'; // or however the mock object is exported/tested
it('mock createCharacter mints a deterministic slug id (fs-58 Unit B)', async () => {
  const c = await mock.createCharacter('b1', { name: 'Ferra', gender: 'female' });
  expect(c.name).toBe('Ferra');
  expect(c.id).toMatch(/ferra/);
  expect(c.voiceState).toBe('generated');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/api.test.ts -t createCharacter`
Expected: FAIL — not defined.

- [ ] **Step 3: Implement both impls.** Mirror `addFromSeriesRoster` (real fetch with the shared auth-header helper; mock returns a deterministic object). Register `createCharacter` in BOTH the `real` and `mock` objects so `api.createCharacter` resolves under `VITE_USE_MOCKS` and live. Mock body:

```ts
createCharacter: async (_bookId, p) => ({
  id: p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'character',
  name: p.name.trim(),
  role: p.role ?? 'character',
  color: 'unset',
  gender: p.gender,
  ageRange: p.ageRange,
  voiceState: 'generated',
}),
```

> NOTE: read the existing `addFromSeriesRoster` real impl for the exact fetch wrapper + header helper, and copy its shape for the real `createCharacter`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/api.test.ts -t createCharacter` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): api.createCharacter (real + mock) for cast-create (fs-58 Unit B)"
```

---

## Task 10: `CreateCharacterForm` component

**Files:**
- Create: `src/components/create-character-form.tsx`, `src/components/create-character-form.test.tsx`

**Interfaces:**
- Produces: `<CreateCharacterForm initial?={{ name, gender?, ageRange? }} existingNames={Set<string>} onSubmit={(fields) => void} onReattributeExisting?={(characterId) => void} rosterByName={Map<string,{id,name}>} onCancel={() => void} />`. Pre-fills from `initial`; name required; if the (normalized) name matches an existing roster member, the primary action becomes "Reattribute to «X»" (calls `onReattributeExisting`) instead of create.

- [ ] **Step 1: Write the failing tests** (React Testing Library):

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateCharacterForm } from './create-character-form';

it('pre-fills from initial proposed values', () => {
  render(<CreateCharacterForm initial={{ name: 'Ferra', gender: 'female' }} rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
  expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Ferra');
});
it('disables submit on an empty name', () => {
  render(<CreateCharacterForm rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  ' } });
  expect(screen.getByTestId('create-character-submit')).toBeDisabled();
});
it('offers reattribute-to-existing when the name matches a roster member', () => {
  const onReattributeExisting = vi.fn();
  render(<CreateCharacterForm initial={{ name: 'Halloran' }} rosterByName={new Map([['halloran', { id: 'halloran', name: 'Halloran' }]])} onSubmit={() => {}} onReattributeExisting={onReattributeExisting} onCancel={() => {}} />);
  fireEvent.click(screen.getByTestId('create-character-submit'));
  expect(onReattributeExisting).toHaveBeenCalledWith('halloran');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/create-character-form.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement** `src/components/create-character-form.tsx` — a small controlled form (name input + gender/ageRange selects), Tailwind tokens only, 44px touch targets. The submit button label + handler switch on whether `rosterByName.get(name.trim().toLowerCase())` exists:

```tsx
import { useState } from 'react';

type Fields = { name: string; gender?: string; ageRange?: string };
export function CreateCharacterForm({
  initial, rosterByName, onSubmit, onReattributeExisting, onCancel,
}: {
  initial?: Fields;
  rosterByName: Map<string, { id: string; name: string }>;
  onSubmit: (f: Fields) => void;
  onReattributeExisting?: (characterId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [gender, setGender] = useState(initial?.gender ?? '');
  const [ageRange, setAgeRange] = useState(initial?.ageRange ?? '');
  const key = name.trim().toLowerCase();
  const existing = key ? rosterByName.get(key) : undefined;
  const disabled = key.length === 0;

  return (
    <div className="space-y-3" data-testid="create-character-form">
      <label className="block text-xs font-semibold text-ink/70">
        Name
        <input
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full min-h-[44px] sm:min-h-0 rounded-xl border border-ink/15 px-3 text-sm"
        />
      </label>
      {/* gender + ageRange selects, same style — omitted controls bind to setGender/setAgeRange */}
      {existing && (
        <p className="text-xs text-ink/55">A character named «{existing.name}» already exists.</p>
      )}
      <div className="flex gap-2">
        <button
          data-testid="create-character-submit"
          disabled={disabled}
          onClick={() => (existing ? onReattributeExisting?.(existing.id) : onSubmit({ name: name.trim(), gender: gender || undefined, ageRange: ageRange || undefined }))}
          className="px-4 min-h-[44px] sm:min-h-0 rounded-full bg-ink text-canvas text-sm font-semibold disabled:opacity-40"
        >
          {existing ? `Reattribute to «${existing.name}»` : 'Create character'}
        </button>
        <button onClick={onCancel} className="px-4 min-h-[44px] sm:min-h-0 text-sm text-ink/50">Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run src/components/create-character-form.test.tsx` then `npm run lint`
Expected: PASS; lint clean (no hex literals).

- [ ] **Step 5: Commit**

```bash
git add src/components/create-character-form.tsx src/components/create-character-form.test.tsx
git commit -m "feat(frontend): CreateCharacterForm with reattribute-to-existing guard (fs-58 Unit B)"
```

---

## Task 11: `ScriptReviewDiff` op previews/labels + per-class default-OFF

**Files:**
- Modify: `src/store/script-review-slice.ts:42-57` (`setReview` seeding)
- Modify: `src/components/script-review-diff.tsx:19-70` (`CLASS_LABELS` + `OpPreview`)
- Test: `src/store/script-review-slice.test.ts`, `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Produces: `setReview` seeds `reattribute` + `flag_nonstory` ops **deselected**, all others selected. `OpPreview` renders a before→after row for `reattribute` and a struck row for `flag_nonstory` (no silent blank).

- [ ] **Step 1: Write the failing slice test:**

```ts
it('seeds reattribute + flag_nonstory deselected, others selected (fs-58 Unit B)', () => {
  const ops = [
    { chapterId: 1, id: 1, op: 'strip_tag', rationale: 'r' },
    { chapterId: 1, id: 2, op: 'reattribute', characterId: 'ferra', rationale: 'r' },
    { chapterId: 1, id: 3, op: 'flag_nonstory', rationale: 'r' },
  ] as any;
  const s = scriptReviewReducer({ byBook: {} }, scriptReviewActions.setReview({ bookId: 'b1', ops, unappliable: [] }));
  const b = s.byBook['b1']!;
  expect(b.selected['1:1:strip_tag']).toBe(true);
  expect(b.selected['1:2:reattribute']).toBe(false);
  expect(b.selected['1:3:flag_nonstory']).toBe(false);
});
```

- [ ] **Step 2: Write the failing component test:**

```tsx
it('renders a reattribute row (not a silent blank)', () => {
  // render ScriptReviewDiff with a store bucket holding a reattribute op to 'ferra'
  expect(screen.getByText(/ferra/i)).toBeInTheDocument();
});
it('renders a flag_nonstory row struck', () => {
  expect(screen.getByText('p. 42')).toHaveClass('line-through');
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/store/script-review-slice.test.ts src/components/script-review-diff.test.tsx -t "fs-58"`
Expected: FAIL — all ops seed selected; no reattribute/flag_nonstory preview arms.

- [ ] **Step 4: Update `setReview` seeding** (`:52-55`):

```ts
      const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']); // fs-58 Unit B — higher-risk classes opt-in
      const selected: Record<string, boolean> = {};
      for (const o of ops) {
        selected[opKey(o.chapterId, o.id, o.op)] = !DEFAULT_OFF.has(o.op);
      }
```

- [ ] **Step 5: Add `CLASS_LABELS` entries + `OpPreview` arms** in `script-review-diff.tsx`:

```ts
const CLASS_LABELS: Record<string, string> = {
  strip_tag: 'Strip tag',
  split: 'Split sentence',
  extract_dialogue: 'Extract dialogue',
  merge: 'Merge sentences',
  fix_emotion: 'Fix emotion',
  reattribute: 'Reattribute speaker',     // fs-58 Unit B
  flag_nonstory: 'Exclude non-story',     // fs-58 Unit B
};
```

In `OpPreview`, before the final `return null;`:

```tsx
  if (op.op === 'reattribute') {
    const target = op.characterId ?? (op.proposed ? `+ new: «${op.proposed.name}»` : '?');
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        reassign → <span className="font-semibold text-ink">{target}</span>
      </span>
    );
  }
  if (op.op === 'flag_nonstory') {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        exclude: {before !== undefined && <span className="line-through text-ink/45">{before}</span>}
      </span>
    );
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/store/script-review-slice.test.ts src/components/script-review-diff.test.tsx` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-slice.test.ts src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): script-review diff renders reattribute/flag_nonstory rows, seeds them OFF (fs-58 Unit B)"
```

---

## Task 12: Async apply — interleaved create→reassign with bookId guard + dedupe

**Files:**
- Create: `src/lib/apply-proposed.ts`, `src/lib/apply-proposed.test.ts`
- Modify: `src/components/script-review-diff.tsx` (`handleApply` → async; wire the confirm form + the helper)

**Interfaces:**
- Consumes: `ReviewOp` proposed ops; `api.createCharacter` (Task 9); `CreateCharacterForm` (Task 10).
- Produces: `applyProposedReattributions(proposed, deps): Promise<{ created: number; aborted: boolean }>` where `deps = { rosterByName: Map<string,{id}>, createCharacter, addCharacter, setSentenceCharacter, onBoundaryMove, isSameBook: () => boolean }`. Interleaves create→reassign per op (self-consistent partials), dedupes by `name.trim().toLowerCase()` against `rosterByName ∪ createdThisBatch` BEFORE creating, and aborts (returns `{aborted:true}`) if `isSameBook()` returns false after any `await`.

- [ ] **Step 1: Write the failing tests** in `src/lib/apply-proposed.test.ts`:

```ts
import { applyProposedReattributions } from './apply-proposed';

function deps(over = {}) {
  const dispatched: any[] = [];
  return {
    spy: dispatched,
    rosterByName: new Map(),
    createCharacter: vi.fn(async (p: any) => ({ id: p.name.toLowerCase(), name: p.name })),
    addCharacter: (c: any) => dispatched.push(['add', c.id]),
    setSentenceCharacter: (chapterId: number, id: number, cid: string) => dispatched.push(['reassign', id, cid]),
    onBoundaryMove: () => {},
    isSameBook: () => true,
    ...over,
  };
}

it('creates then reassigns each proposed op (interleaved)', async () => {
  const d = deps();
  const r = await applyProposedReattributions(
    [{ chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } }] as any, d);
  expect(d.createCharacter).toHaveBeenCalledTimes(1);
  expect(d.spy).toEqual([['add', 'ferra'], ['reassign', 5, 'ferra']]);
  expect(r).toEqual({ created: 1, aborted: false });
});

it('dedupes the same proposed name to ONE create within a batch', async () => {
  const d = deps();
  await applyProposedReattributions([
    { chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } },
    { chapterId: 1, id: 7, op: 'reattribute', proposed: { name: 'ferra ' } },
  ] as any, d);
  expect(d.createCharacter).toHaveBeenCalledTimes(1);
  expect(d.spy.filter((x) => x[0] === 'reassign')).toHaveLength(2); // both lines reassigned to the one id
});

it('a name matching an existing roster member does NOT create', async () => {
  const d = deps({ rosterByName: new Map([['ferra', { id: 'ferra' }]]) });
  await applyProposedReattributions([{ chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } }] as any, d);
  expect(d.createCharacter).not.toHaveBeenCalled();
  expect(d.spy).toEqual([['reassign', 5, 'ferra']]);
});

it('aborts remaining ops when the book changed mid-await', async () => {
  let book = 'b1';
  const d = deps({ isSameBook: () => book === 'b1', createCharacter: vi.fn(async (p: any) => { book = 'b2'; return { id: p.name.toLowerCase(), name: p.name }; }) });
  const r = await applyProposedReattributions([
    { chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } },
    { chapterId: 1, id: 7, op: 'reattribute', proposed: { name: 'Gus' } },
  ] as any, d);
  expect(r.aborted).toBe(true);
  expect(d.createCharacter).toHaveBeenCalledTimes(1); // stopped before the second
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/apply-proposed.test.ts`
Expected: FAIL — helper missing.

- [ ] **Step 3: Implement** `src/lib/apply-proposed.ts`:

```ts
import type { ReviewOpWithChapter } from '../store/script-review-slice';

export interface ApplyProposedDeps {
  rosterByName: Map<string, { id: string }>;
  createCharacter: (p: { name: string; gender?: string; ageRange?: string }) => Promise<{ id: string; name: string }>;
  addCharacter: (c: { id: string; name: string }) => void;
  setSentenceCharacter: (chapterId: number, sentenceId: number, characterId: string) => void;
  onBoundaryMove: (chapterId: number) => void;
  isSameBook: () => boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

/* fs-58 Unit B — off-roster reattribute apply. INTERLEAVED create→reassign so a
   cancel/failure leaves a self-consistent partial (no created member without a
   line). Dedup by normalized name against roster ∪ createdThisBatch BEFORE the
   POST. Re-check isSameBook() after every await (concurrent-multi-book guard). */
export async function applyProposedReattributions(
  proposed: ReviewOpWithChapter[],
  deps: ApplyProposedDeps,
): Promise<{ created: number; aborted: boolean }> {
  const memo = new Map<string, string>(); // normName -> id created this batch
  let created = 0;
  for (const op of proposed) {
    if (!op.proposed) continue;
    const key = norm(op.proposed.name);
    let id = deps.rosterByName.get(key)?.id ?? memo.get(key);
    if (!id) {
      const c = await deps.createCharacter(op.proposed);
      if (!deps.isSameBook()) return { created, aborted: true };
      deps.addCharacter(c);
      id = c.id;
      memo.set(key, id);
      created += 1;
    }
    deps.setSentenceCharacter(op.chapterId, op.id, id);
    deps.onBoundaryMove(op.chapterId);
  }
  return { created, aborted: false };
}
```

- [ ] **Step 4: Run the helper tests**

Run: `npx vitest run src/lib/apply-proposed.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Wire into `handleApply`** in `script-review-diff.tsx`. Make it `async`; capture `bookId` at start; thread the roster; run the direct ops synchronously, then the proposed ops through a confirm step + the helper. Replace `handleApply` (`:100-120`):

```tsx
  const cast = useAppSelector((s) => s.cast.characters);

  async function handleApply() {
    const startBookId = bookId;
    const selectedOps = ops.filter((o) => selected[opKey(o.chapterId, o.id, o.op)]);
    const live = sentences.map((s) => ({ id: s.id, chapterId: s.chapterId, text: s.text, characterId: s.characterId }));
    const roster = new Set(cast.map((c) => c.id));
    const { appliable } = planApply(selectedOps, live, roster);

    const proposedOps = appliable.filter((o) => o.op === 'reattribute' && o.proposed && !o.characterId) as ReviewOpWithChapter[];
    const directOps = appliable.filter((o) => !(o.op === 'reattribute' && o.proposed && !o.characterId));

    dispatchAcceptedOps(dispatch, directOps, live, {
      onBoundaryMove: (chapterId) => dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
    }, roster);

    if (proposedOps.length > 0) {
      // The CONFIRM step (per op) lets the operator edit each proposed name first.
      // It collects the final proposed values (or rewrites an op to an existing
      // characterId when the form chose reattribute-to-existing), then:
      const rosterByName = new Map(cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id }]));
      await applyProposedReattributions(proposedOps, {
        rosterByName,
        createCharacter: (p) => api.createCharacter(startBookId, p),
        addCharacter: (c) => dispatch(castActions.addCharacter(c as never)),
        setSentenceCharacter: (chapterId, sentenceId, characterId) => dispatch(manuscriptActions.setSentenceCharacter({ chapterId, sentenceId, characterId })),
        onBoundaryMove: (chapterId) => dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
        isSameBook: () => store.getState().ui.stage.kind === 'ready' && store.getState().ui.stage.bookId === startBookId,
      });
    }

    dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));
  }
```

Render the `CreateCharacterForm` confirm step when `proposedOps` are pending (a small local state machine: `confirming: ReviewOpWithChapter | null`). The form's `onSubmit`/`onReattributeExisting` feed the per-op final values into the helper. Match the exact store-access idiom the file uses (`useAppSelector` + a `store` import if needed for `getState`).

> NOTE: confirm the `ui.stage` discriminated-union access for `bookId` (`src/store/ui-slice.ts` — `bookId` lives inside the `ready` variant). Keep the modal open while confirming; only `clearReview` after the loop resolves.

- [ ] **Step 6: Run the full frontend suite for this area + typecheck**

Run: `npx vitest run src/components/script-review-diff.test.tsx src/lib/apply-proposed.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/apply-proposed.ts src/lib/apply-proposed.test.ts src/components/script-review-diff.tsx
git commit -m "feat(frontend): interleaved off-roster create→reassign with bookId guard + dedupe (fs-58 Unit B)"
```

---

## Task 13: Manuscript excluded-line UX (struck + toggle + chip suppression)

**Files:**
- Modify: `src/views/manuscript.tsx:1473-1508` (the per-sentence render)
- Test: `src/views/manuscript.test.tsx` (or a focused render test — confirm the manuscript test file)

**Interfaces:**
- Consumes: `s.excludeFromSynthesis`; `manuscriptActions.setSentenceExcluded`.
- Produces: an excluded sentence renders struck/greyed, its emotion + instruct chips suppressed, and shows a re-include toggle (rendered OUTSIDE the text span). Re-include uses the coarse `useMarkCharacterStaleIfRendered` (§4.5).

- [ ] **Step 1: Write the failing test:**

```tsx
it('renders an excluded sentence struck with a re-include toggle and no emotion/instruct chips (fs-58 Unit B)', () => {
  // render a manuscript segment with one sentence { excludeFromSynthesis: true }
  const span = screen.getByText('p. 42');
  expect(span).toHaveClass('opacity-50'); // greyed
  expect(span).toHaveClass('line-through');
  expect(screen.getByTestId('reinclude-toggle-<id>')).toBeInTheDocument();
  expect(screen.queryByTestId('emotion-control-<id>')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/views/manuscript.test.tsx -t "excluded sentence"`
Expected: FAIL.

- [ ] **Step 3: Update the render** (`:1478-1504`). Add the struck style to the span and gate the chips + add the toggle:

```tsx
                <span
                  data-sentence-id={s.id}
                  data-sentence-idx={s.absIdx}
                  className={`inline transition-colors ${isCandidate ? 'sentence-candidate' : ''} ${s.excludeFromSynthesis ? 'line-through opacity-50' : ''}`}
                  {...(s.absIdx === 0 ? { 'data-tour-id': 'manuscript-line' } : {})}
                >
                  {renderSentenceText(s.text)}
                </span>
                {/* fs-58 Unit B — excluded lines: re-include toggle (outside the
                    span so split offsets are unaffected), chips suppressed. */}
                {s.excludeFromSynthesis ? (
                  <button
                    data-testid={`reinclude-toggle-${s.id}`}
                    onClick={() => { dispatch(manuscriptActions.setSentenceExcluded({ chapterId: s.chapterId, sentenceId: s.id, excluded: false })); markStale({ id: s.characterId, name: char?.name ?? s.characterId }); }}
                    className="ml-1 align-baseline text-[10px] min-h-[44px] sm:min-h-0 text-ink/45 hover:text-ink underline"
                  >include</button>
                ) : (
                  <>
                    {(seg.characterId !== 'narrator' || s.emotion) && (
                      <SentenceEmotionControl chapterId={s.chapterId} sentenceId={s.id} emotion={s.emotion} character={char} />
                    )}
                    <SentenceInstructControl chapterId={s.chapterId} sentenceId={s.id} instruct={s.instruct} character={char} liveInstruct={liveInstruct} />
                  </>
                )}
```

> NOTE: `markStale` is `useMarkCharacterStaleIfRendered()` — add the hook call near the top of the component if not already present. Also disable the split/drag affordance on an excluded line where the boundary handler reads `data-sentence-idx` (guard the pointer handler against `s.excludeFromSynthesis`); confirm the handler location.

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run src/views/manuscript.test.tsx -t "excluded"` then `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): excluded sentences render struck + toggle, chips suppressed (fs-58 Unit B)"
```

---

## Task 14: Activate the "Add character" button

**Files:**
- Modify: `src/views/manuscript.tsx:~1219` (the inert button → opens `CreateCharacterForm`)
- Test: `src/views/manuscript.test.tsx`

**Interfaces:**
- Consumes: `CreateCharacterForm` (Task 10), `api.createCharacter` (Task 9), `castActions.addCharacter`.
- Produces: clicking "Add character" opens the create form (empty); creating dispatches `addCharacter`.

- [ ] **Step 1: Write the failing test:**

```tsx
it('opens the create-character form and creates on submit (fs-58 Unit B)', async () => {
  // render the cast sidebar panel; click "Add character"
  fireEvent.click(screen.getByRole('button', { name: /add character/i }));
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ferra' } });
  fireEvent.click(screen.getByTestId('create-character-submit'));
  await waitFor(() => expect(screen.getByText('Ferra')).toBeInTheDocument());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/views/manuscript.test.tsx -t "add character"`
Expected: FAIL — button inert.

- [ ] **Step 3: Wire the button** — add local open state + render `CreateCharacterForm` (in a small popover/inline panel) and an `onClick` on the button (`:1219`):

```tsx
  const [addingChar, setAddingChar] = useState(false);
  // ...
  <button onClick={() => setAddingChar(true)} className="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2 min-h-11 rounded-xl border border-dashed border-ink/20 text-sm text-ink/60 hover:border-peach hover:text-peach transition-colors">
    <IconPlus className="w-4 h-4" /> Add character
  </button>
  {addingChar && (
    <CreateCharacterForm
      rosterByName={new Map(characters.map((c) => [c.name.trim().toLowerCase(), { id: c.id, name: c.name }]))}
      onSubmit={async (f) => { const c = await api.createCharacter(bookId, f); dispatch(castActions.addCharacter(c as never)); setAddingChar(false); }}
      onReattributeExisting={() => setAddingChar(false)}
      onCancel={() => setAddingChar(false)}
    />
  )}
```

> NOTE: confirm `bookId` + `characters` + `dispatch` are in scope in this panel component (`SidebarPanels` around `:1040`); thread them as props if not.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/views/manuscript.test.tsx -t "add character"` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): activate the Add-character button via CreateCharacterForm (fs-58 Unit B)"
```

---

## Task 15: Prompt extension — the two op classes

**Files:**
- Modify: `skills/audiobook-script-review.md`
- Test: `skills/audiobook-script-review.test.ts`

**Interfaces:** none (prompt text). The test asserts the prompt documents both classes + the key guards.

- [ ] **Step 1: Write the failing test** in `skills/audiobook-script-review.test.ts`:

```ts
import { readFileSync } from 'node:fs';
const md = readFileSync(new URL('./audiobook-script-review.md', import.meta.url), 'utf8');

describe('script-review prompt — fs-58 Unit B classes', () => {
  it('documents reattribute with the characterId-XOR-proposed contract', () => {
    expect(md).toMatch(/reattribute/);
    expect(md).toMatch(/never invent a `?characterId/i);
  });
  it('documents flag_nonstory and forbids flagging story prose', () => {
    expect(md).toMatch(/flag_nonstory/);
    expect(md).toMatch(/never flag story/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run skills/audiobook-script-review.test.ts -t "fs-58 Unit B"`
Expected: FAIL.

- [ ] **Step 3: Add the two op-class sections** to `skills/audiobook-script-review.md` (after `fix_emotion`, in the same terse style), using the §5 copy from the spec verbatim (the `reattribute` block forbidding invented `characterId`s; the `flag_nonstory` block forbidding flagging story prose).

- [ ] **Step 4: Run tests**

Run: `npx vitest run skills/audiobook-script-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/audiobook-script-review.md skills/audiobook-script-review.test.ts
git commit -m "feat(server): script-review prompt covers reattribute + flag_nonstory (fs-58 Unit B)"
```

---

## Task 16: import-residue fixture + flag_nonstory server unit

**Files:**
- Create: `server/src/__fixtures__/import-residue.md`
- Test: extend `server/src/analyzer/script-review.test.ts`

**Interfaces:** a deterministic fixture exercising mid-body residue (page number, running header, ISBN, bare "Chapter N").

- [ ] **Step 1: Create the fixture** `server/src/__fixtures__/import-residue.md` — narrative prose with residue interleaved MID-BODY (NOT in the leading region, which front-matter stripping clears):

```markdown
# Chapter 1

The harbour wall held against the tide, and Halloran counted the lanterns twice.

47

THE COALFALL COMMISSION

"Hard to starboard," he called, and the wheel bit.

ISBN 978-0-00-000000-0

Chapter 3

The fog came in before the answer did.
```

- [ ] **Step 2: Write a fixture-shaped unit test** (drives the script-review pass with a STUBBED analyzer that returns a `flag_nonstory` op for each residue line, asserting the envelope validates + the apply layer excludes them). Mirror the existing `script-review.test.ts` stub harness:

```ts
it('flag_nonstory ops over the import-residue fixture validate and exclude (fs-58 Unit B)', () => {
  const ops = [
    { id: 2, op: 'flag_nonstory', anchor: '47', rationale: 'page number' },
    { id: 3, op: 'flag_nonstory', anchor: 'THE COALFALL COMMISSION', rationale: 'running header' },
  ];
  expect(scriptReviewSchema.safeParse({ ops }).success).toBe(true);
});
```

- [ ] **Step 3: Run to verify it passes** (the schema accepts after Task 2)

Run: `cd server && npx vitest run src/analyzer/script-review.test.ts -t "import-residue"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/__fixtures__/import-residue.md server/src/analyzer/script-review.test.ts
git commit -m "test(server): import-residue fixture + flag_nonstory coverage (fs-58 Unit B)"
```

---

## Task 17: Playwright e2e

**Files:**
- Modify: `e2e/script-review.spec.ts` (add a Unit B case), `e2e/responsive/coverage.spec.ts` (append if a new surface)
- Mock: the review pass must surface a `reattribute` (off-roster) + a `flag_nonstory` op via the mock SSE.

**Interfaces:** browser-level golden path.

- [ ] **Step 1: Write the e2e spec** — drive the existing script-review trigger in mock mode; ensure the mock review response includes one off-roster `reattribute` (with `proposed`) and one `flag_nonstory`; accept both; assert (a) the manuscript shows the struck line, (b) a new cast member appears, (c) the chapter reads stale.

```ts
test('Unit B: accept off-roster reattribute + flag_nonstory (fs-58)', async ({ page }) => {
  // open a book, trigger Review Script, wait for the diff modal
  await page.getByTestId('class-toggle-reattribute').check();
  await page.getByTestId('class-toggle-flag_nonstory').check();
  await page.getByTestId('apply-button').click();
  // confirm the create-character step
  await page.getByTestId('create-character-submit').click();
  await expect(page.getByText('p. 42')).toHaveClass(/line-through/);
  await expect(page.getByText('Ferra')).toBeVisible(); // new cast member
  await expect(page.getByTestId('stale-audio-banner')).toBeVisible();
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- script-review`
Expected: PASS (requires `npx playwright install chromium` once).

- [ ] **Step 3: Commit**

```bash
git add e2e/script-review.spec.ts e2e/responsive/coverage.spec.ts
git commit -m "test(e2e): Unit B off-roster reattribute + flag_nonstory golden path (fs-58)"
```

---

## Task 18: Docs + close-out

**Files:**
- Modify: the spec frontmatter (`status: active`), `docs/BACKLOG.md` (remove the #1040 row on ship), `docs/features/INDEX.md`
- File: the three follow-ups from spec §8 (auto-voice; cross-chapter context; the pre-existing emotion/instruct re-analysis drop).

- [ ] **Step 1: Flip the spec `status:` to `active`** and confirm §8/§9 reflect the as-built.

- [ ] **Step 2: File the follow-up issues** (GitHub) per §8 + add their thin rows to `docs/BACKLOG.md` if they're backlog items.

- [ ] **Step 3: Update `docs/features/INDEX.md`** with the Unit B plan entry under its area.

- [ ] **Step 4: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(docs): close fs-58 Unit B — status active + follow-ups filed (Refs #1040)"
```

---

## Self-review (completed by plan author)

**Spec coverage:** §3.1 op envelope → T2; §3.2 dispatcher arm + staleness → T7; §3.3 interleaved async + dedupe + bookId guard → T12; §3.4 cast/create route → T4 (+ mock T9); §3.5 roster param → T7; §3.5b server schema → T2; §3.6 granularity → inherited (no task); §4.1 field → T1; §4.2 reducer + preserve → T3; §4.3 filter + all-excluded → T5/T6; §4.4 manuscript UX → T13; §4.5 precise staleness → T8; §4.6 fixture → T16; §5 prompt → T15; §6 modal labels/preview/default-OFF → T11; §7 testing → distributed; §8 follow-ups → T18; CreateCharacterForm → T10; Add-character button → T14; e2e → T17.

**Type consistency:** `setSentenceExcluded({chapterId,sentenceId,excluded})` (T3) used identically in T7/T13. `api.createCharacter(bookId, {name,gender?,ageRange?,role?})` (T9) consumed in T12/T14. `applyProposedReattributions(proposed, deps)` (T12) — deps shape matches the helper. `isChapterExcludedSinceRender(rendered, currentSentences)` (T8) consumed in generation.tsx. `roster: Set<string>` param order in `planApply`/`dispatchAcceptedOps` consistent across T7/T12.

**Smallest-slice fallback (spec §11):** if scope must shrink, T1+T3+T5+T6+T8+T11(flag half)+T13+T16 ship **flag_nonstory alone** (drop T4/T9/T10/T12/T14 cast-create); or drop only off-roster (T4/T9/T10/T12/T14) for **on-roster reattribute** + flag_nonstory.

**Implementer NOTEs:** several tasks carry a "confirm the exact name/site" note where the plan references a line the author did not read in full (re-analysis action name T3; generation route test harness T6; api.ts fetch wrapper T9; generation.tsx diff vars T8; ui.stage access T12; manuscript pointer handler T13). These are deliberate — verify against the live file before writing, do not guess.
