# fs-57 — Non-verbal Vocalizations + Live Context-Aware Instruct — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the analysis LLM write pronounceable non-verbal vocalizations ("Ah!", "Haah…", "Haha!") into a sentence's `text` plus a matching free-text delivery `instruct`, and make that `instruct` audible end-to-end through a live per-line instruct synth path on the Qwen 1.7B Base.

**Architecture:** Additive `instruct?` + `vocalization?` fields on the Sentence schema; a per-book `liveInstruct` flag gates a new 1.7B raw-`generate` ICL+instruct batched synth path (the existing `generate_voice_clone` + anchored-variant path stays for flag-off books); a new Phase-1 **Stage 3** analyzer pass emits vocalizations (book-language) + instruct (English), wired to the existing "Detect emotions" button; two guardrails (fs-58 Script Review already protects vocalization text — add a regression; srv-31 ASR gets a vocalization-token tolerance).

**Tech Stack:** TypeScript (Vite/React 18/RTK frontend; Node/Express server, Zod, Vitest), Python (FastAPI TTS sidecar, `qwen-tts` 0.1.1, pytest), OpenAPI → generated `api-types.ts`.

**Spec:** `docs/superpowers/specs/2026-06-24-fs57-nonverbal-vocalizations-instruct-design.md` (survived 4 adversarial review rounds).

## Global Constraints

- **OpenAPI is the type source of truth** — add fields to `openapi.yaml`, then `npm run openapi:types` to regenerate `src/lib/api-types.ts`. Never hand-edit `api-types.ts`. The Zod `schemas.ts` change alone is insufficient.
- **`sentenceSchema` is `.strict()`** — every new field is `.optional()`; an absent-field analysis MUST still parse.
- **Additive at the data layer only.** 0.6B / Kokoro / Coqui audio paths stay byte-identical. The 1.7B audio path changes only when a book's `liveInstruct` flag is on (default off).
- **`instruct` is English; vocalization `text` is the book's language** (the Qwen instruct channel is English-coupled).
- **RTK reducers mutate via Immer drafts** — don't rewrite to spreads.
- **No hex literals in components** — use the CSS-custom-property design tokens.
- **Pin `qwen-tts` 0.1.1** — the raw-`generate` bypass is version-fragile.
- **Commit convention:** `<type>(<scope>): <subject>` (e.g. `feat(server): …`, `feat(sidecar): …`, `feat(frontend): …`, `test(server): …`). Commit-msg hook enforces it.
- **Branch:** cut `feat/fs57-vocalizations-instruct` off `origin/main` before Task 1 (this plan currently lives on the docs branch).
- **Run before declaring a task done:** the leg matching the change — `cd server && npm test` (server), `npm test` (frontend), `npm run test:sidecar` (sidecar), `npm run typecheck`.

---

## File Structure

**New files:**
- `server/src/tts/emotion-instruct.ts` — pure `emotionToInstruct(emotion)` English-phrase map (synth-side fallback).
- `server/src/tts/emotion-instruct.test.ts`.
- `skills/audiobook-instruct-annotation.md` — the Stage-3 LLM skill prompt.
- `skills/audiobook-instruct-annotation.test.ts` — prompt snapshot/guard tests.
- `server/src/routes/instruct-annotation.ts` — Stage-3 SSE endpoint (own contract, NOT `detectEmotions`).
- `server/src/routes/instruct-annotation.test.ts`.
- `src/store/instruct-slice` additions OR `manuscript-slice` reducer `applyDetectedInstruct` (see Task 13) + tests.
- `server/tts-sidecar/tests/test_instruct_synth.py` — sidecar batched ICL+instruct + C2 empty-instruct gate.

**Modified files:**
- `server/src/handoff/schemas.ts:117-128` — `instruct?`, `vocalization?` on `sentenceSchema`.
- `openapi.yaml` (Sentence schema, ~4845-4867) — same two fields.
- `src/lib/api-types.ts` — regenerated.
- `server/src/tts/synthesise-chapter.ts` — thread `instruct`/`vocalization` through `SentenceGroup`; route 1.7B-`liveInstruct` to the new path; synth-side emotion→phrase.
- `server/src/tts/voice-mapping.ts:30-44` — `pickEmotionVariantVoice` no-op when `liveInstruct` on.
- `server/src/tts/sidecar.ts` — per-item `instruct` in the request body (single + batch).
- `server/tts-sidecar/main.py` — `synthesize_batch` accepts per-item instruct on the 1.7B path; instruct length cap; pin check.
- `server/src/tts/segment-asr-qa.ts:245-319` — `vocalizationAllowlist` token tolerance.
- `server/src/analyzer/gemini.ts` / `ollama.ts` — `runStage3Chapter`; `languagePreamble` Stage-3 clauses; `SKILL_TO_PROMPT_ID`.
- `server/src/config/registry.ts` — `prompt.instructAnnotation` knob.
- book-meta store + server book-state — `liveInstruct` boolean.
- `src/lib/api.ts` — `detectInstruct` (new) client.
- `src/components/detect-emotions-button.tsx` — fire Stage 3 alongside emotion; heavier confirm copy.
- `docs/features/INDEX.md` + a new `docs/features/NN-fs57-vocalizations-instruct.md` regression plan.

---

# Wave 1 — Data model + schema

### Task 1: Add `instruct?` + `vocalization?` to the Zod Sentence schema

**Files:**
- Modify: `server/src/handoff/schemas.ts:117-128`
- Test: `server/src/handoff/schemas.test.ts` (create if absent, else append)

**Interfaces:**
- Produces: `sentenceSchema` now accepts optional `instruct: string` and `vocalization: boolean`; `Sentence` type gains both as optional.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/handoff/schemas.test.ts
import { describe, it, expect } from 'vitest';
import { sentenceSchema } from './schemas';

describe('sentenceSchema fs-57 fields', () => {
  const base = { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' };

  it('parses without instruct/vocalization (pre-fs-57 analysis)', () => {
    expect(sentenceSchema.parse(base)).toMatchObject(base);
  });

  it('accepts optional instruct + vocalization', () => {
    const s = { ...base, text: 'Ah! Hello.', instruct: 'a short gasp', vocalization: true };
    expect(sentenceSchema.parse(s)).toMatchObject(s);
  });

  it('rejects a non-string instruct (strict)', () => {
    expect(() => sentenceSchema.parse({ ...base, instruct: 5 })).toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`instruct`/`vocalization` rejected by `.strict()`).

Run: `cd server && npx vitest run src/handoff/schemas.test.ts`
Expected: FAIL on the "accepts optional" case.

- [ ] **Step 3: Add the fields**

```ts
// server/src/handoff/schemas.ts — inside sentenceSchema, after emotion:
    emotion: z.enum(EMOTIONS).optional(),
    /* fs-57 — optional free-text delivery direction (English), live on the
       Qwen 1.7B liveInstruct path. Absent ⇒ today's behaviour. Additive. */
    instruct: z.string().optional(),
    /* fs-57 — Stage 3 authored a non-verbal vocalization into `text`. Drives
       the srv-31 ASR carve-out. Additive. */
    vocalization: z.boolean().optional(),
```

- [ ] **Step 4: Run it — expect PASS.**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts
git commit -m "feat(server): add optional instruct + vocalization to sentence schema (fs-57)"
```

---

### Task 2: Mirror the fields in OpenAPI + regenerate types

**Files:**
- Modify: `openapi.yaml` (the `Sentence` schema)
- Modify (generated): `src/lib/api-types.ts` via `npm run openapi:types`
- Test: `src/lib/api-types.test.ts` (a compile-time assertion; create)

**Interfaces:**
- Produces: `components['schemas']['Sentence']` carries optional `instruct?: string` and `vocalization?: boolean` for the frontend.

- [ ] **Step 1: Add to `openapi.yaml`** under the `Sentence` schema `properties:` (alongside `emotion`):

```yaml
        instruct:
          type: string
          description: >-
            fs-57 — optional free-text English delivery direction, live on the
            Qwen 1.7B liveInstruct path. Absent renders as today.
        vocalization:
          type: boolean
          description: >-
            fs-57 — true when Stage 3 authored a non-verbal vocalization into
            text; drives the ASR content-QA carve-out.
```

- [ ] **Step 2: Regenerate**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` diff adds `instruct?: string;` and `vocalization?: boolean;` to `Sentence`.

- [ ] **Step 3: Add a type assertion test**

```ts
// src/lib/api-types.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type { components } from './api-types';
type Sentence = components['schemas']['Sentence'];

describe('Sentence fs-57 fields', () => {
  it('has optional instruct + vocalization', () => {
    expectTypeOf<Sentence>().toMatchTypeOf<{ instruct?: string; vocalization?: boolean }>();
  });
});
```

- [ ] **Step 4: Run** `npx vitest run src/lib/api-types.test.ts` — expect PASS. Run `npm run typecheck` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts src/lib/api-types.test.ts
git commit -m "feat(server): mirror instruct + vocalization in openapi and regen types (fs-57)"
```

---

### Task 3: Synth-side `emotionToInstruct` English-phrase map

**Files:**
- Create: `server/src/tts/emotion-instruct.ts`
- Test: `server/src/tts/emotion-instruct.test.ts`

**Interfaces:**
- Produces: `emotionToInstruct(emotion: Emotion | undefined): string | undefined` — the §4.1 ladder fallback. `neutral`/`undefined` → `undefined` (no instruct). Imported by `synthesise-chapter.ts` in Task 8.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/emotion-instruct.test.ts
import { describe, it, expect } from 'vitest';
import { emotionToInstruct } from './emotion-instruct';

describe('emotionToInstruct', () => {
  it('maps each expressive emotion to an English phrase', () => {
    expect(emotionToInstruct('whisper')).toMatch(/whisper/i);
    expect(emotionToInstruct('angry')).toMatch(/anger|angrily|raised/i);
    expect(emotionToInstruct('excited')).toMatch(/excit|energ/i);
    expect(emotionToInstruct('sad')).toMatch(/sad|subdued|downcast/i);
  });
  it('returns undefined for neutral / absent', () => {
    expect(emotionToInstruct('neutral')).toBeUndefined();
    expect(emotionToInstruct(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** `cd server && npx vitest run src/tts/emotion-instruct.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// server/src/tts/emotion-instruct.ts
import type { Emotion } from '../handoff/schemas';

/* fs-57 §4.1 — synth-side fallback: when a 1.7B liveInstruct sentence has an
   emotion but no explicit instruct, derive an English delivery phrase. Kept
   here (not the analyzer) so the phrase vocabulary can evolve without
   re-analysis. neutral/absent ⇒ no instruct (plain ICL clone). */
const PHRASES: Record<Exclude<Emotion, 'neutral'>, string> = {
  whisper: 'in a soft, breathy whisper',
  angry: 'in an angry, raised voice',
  excited: 'with bright, energetic excitement',
  sad: 'in a subdued, downcast tone',
};

export function emotionToInstruct(emotion: Emotion | undefined): string | undefined {
  if (!emotion || emotion === 'neutral') return undefined;
  return PHRASES[emotion];
}
```

- [ ] **Step 4: Run** the test — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/emotion-instruct.ts server/src/tts/emotion-instruct.test.ts
git commit -m "feat(server): synth-side emotion->instruct English-phrase map (fs-57)"
```

---

### Task 4: Per-book `liveInstruct` flag (book-meta + server book-state)

**Files:**
- Modify: book-meta store slice `src/store/book-meta-slice.ts` (add `liveInstruct: boolean`, default `false`, + a `setLiveInstruct` reducer)
- Modify: server book-state read/write (`server/src/routes/book-state.ts`) to persist `liveInstruct` in the book-meta JSON
- Modify: `openapi.yaml` book-meta schema + regen types
- Test: `src/store/book-meta-slice.test.ts`; `server/src/routes/book-state.test.ts`

**Interfaces:**
- Produces: `liveInstruct: boolean` readable in `synthesise-chapter.ts` (via the generation route's book-meta load) and togglable in the UI (Task 16). Default **false**.

- [ ] **Step 1: Write the failing frontend reducer test**

```ts
// src/store/book-meta-slice.test.ts (append)
import { bookMetaReducer, bookMetaActions } from './book-meta-slice';
it('liveInstruct defaults off and toggles', () => {
  const s0 = bookMetaReducer(undefined, { type: '@@init' });
  expect(s0.liveInstruct ?? false).toBe(false);
  const s1 = bookMetaReducer(s0, bookMetaActions.setLiveInstruct(true));
  expect(s1.liveInstruct).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run src/store/book-meta-slice.test.ts` — expect FAIL.

- [ ] **Step 3: Add `liveInstruct` to the slice state + a `setLiveInstruct(boolean)` reducer** (Immer draft mutation), default `false` in `initialState`. Add `liveInstruct` to the book-meta OpenAPI schema and `npm run openapi:types`. Persist it in `book-state.ts` read/write (default `false` when absent).

- [ ] **Step 4: Run** both the frontend and server book-state tests — expect PASS. `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/store/book-meta-slice.ts src/store/book-meta-slice.test.ts openapi.yaml src/lib/api-types.ts server/src/routes/book-state.ts server/src/routes/book-state.test.ts
git commit -m "feat(server): per-book liveInstruct flag, default off (fs-57)"
```

---

# Wave 2 — Synthesis (live 1.7B instruct path)

> **Order:** the **C2 gate (Task 5) runs first** — establish what empty/neutral instruct produces before any "neutral parity" claim. Wave 2 is validated on hand-authored instruct fixtures (Stage 3 doesn't exist yet — spec m2).

### Task 5: Sidecar C2 gate — characterise empty/neutral per-item instruct

**Files:**
- Create: `server/tts-sidecar/tests/test_instruct_synth.py`
- (No production change yet — this task pins the contract the next tasks build to.)

**Interfaces:**
- Produces: a pinned answer to "does the batched raw `generate` accept an empty per-item instruct, or is a neutral placeholder needed?" — consumed by Task 6's batching design.

- [ ] **Step 1: Write a pytest that drives `_icl_instruct_synth` (or the raw `generate`) with `instruct=""` and with a neutral placeholder, asserting it returns valid PCM and recording which form is the no-op.** Mark `@pytest.mark.golden`-style gated on Kokoro/Qwen weights so it SKIPs on an unbootstrapped venv (mirror `test_qwen3.py`'s gating).

```python
# server/tts-sidecar/tests/test_instruct_synth.py
import pytest
from main import QwenEngine  # adjust import to the test harness pattern in test_qwen3.py

requires_qwen = pytest.mark.skipif(  # mirror existing weight-gating helper
    not QwenEngine.weights_present(), reason="Qwen weights not installed")

@requires_qwen
def test_empty_instruct_is_a_noop_or_needs_placeholder():
    eng = QwenEngine()
    eng._ensure_base17_loaded()
    icl = eng._load_voice_prompt_17b("<a designed test voice id>")
    wav_empty, sr = eng._icl_instruct_synth([icl], "This is a neutral line.", "", "en")
    assert sr > 0 and len(wav_empty) > 0
    # Record (assert) the chosen neutral form for Task 6; if empty is rejected,
    # switch to a pinned neutral placeholder and assert THAT is the no-op.
```

- [ ] **Step 2: Run** `npm run test:sidecar` on a box with weights — observe whether empty instruct is accepted.

- [ ] **Step 3: Pin the decision** in the test (empty string vs a fixed neutral placeholder e.g. `"in a neutral, natural narration voice"`) as the canonical no-op form; document it in a comment + the regression plan.

- [ ] **Step 4: Run** the test green (or SKIP on a no-weight box).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/tests/test_instruct_synth.py
git commit -m "test(sidecar): C2 gate — pin the empty/neutral instruct no-op form (fs-57)"
```

---

### Task 6: Sidecar — per-item instruct in `synthesize_batch` (1.7B path)

**Files:**
- Modify: `server/tts-sidecar/main.py` (`synthesize_batch` ~2342-2484; reuse `_icl_instruct_synth` core ~1553)
- Test: `server/tts-sidecar/tests/test_instruct_synth.py` (append); `server/tts-sidecar/tests/test_batch_synthesis.py`

**Interfaces:**
- Consumes: the Task 5 neutral form.
- Produces: `synthesize_batch` accepts `items: [{voice, text, instruct?}]`; on the **1.7B Base** path it builds per-item `instruct_ids` and runs one batched `generate` with heterogeneous voices + instructs. The 0.6B path ignores `instruct` (unchanged).

- [ ] **Step 1: Write the failing test** — a batched 1.7B call with two items carrying *different* instructs returns two PCM buffers, each non-empty, with no cross-bleed (assert lengths differ / both present). Weight-gated SKIP.

- [ ] **Step 2: Run** — expect FAIL (batch ignores `instruct`).

- [ ] **Step 3: Implement** — in the 1.7B branch of `synthesize_batch`, when any item has a non-empty `instruct`, build `instruct_ids` per item (reuse `w._build_instruct_text` + `w._tokenize_texts`), pass the per-item list to the raw `model.generate(..., instruct_ids=…, voice_clone_prompt=…)` (the `_icl_instruct_synth` mechanism, lifted to batch). Items without instruct use the Task-5 neutral form. Keep the call under `_synth_lock` + `_base17_activity()` exactly as the current 1.7B batch does.

- [ ] **Step 4: Run** — expect PASS. Run `test_batch_synthesis.py` — existing batch contracts stay green.

- [ ] **Step 5: Commit** `feat(sidecar): per-item instruct in batched 1.7B synth (fs-57)`.

---

### Task 7: Sidecar — instruct length cap + raw-`generate` drift guard

**Files:**
- Modify: `server/tts-sidecar/main.py` (clamp per-line instruct length, mirror the `design_voice` cap ~4105; add a guard assertion that `generate` accepts both `instruct_ids` + `voice_clone_prompt`)
- Test: `server/tts-sidecar/tests/test_instruct_synth.py`

- [ ] **Step 1:** Failing test — an over-long instruct is clamped/rejected (assert it doesn't raise a tokenizer overflow); a signature-introspection test asserts `generate`'s params include `instruct_ids` and `voice_clone_prompt` (fails loudly if `qwen-tts` drifts).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the clamp (reuse the `design_voice` char-cap constant) + an `inspect.signature` guard at module import or first synth.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(sidecar): instruct length cap + raw-generate drift guard (fs-57)`.

---

### Task 8: Server — thread `instruct`/`vocalization` through synthesis + route the 1.7B liveInstruct path

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts` (`SentenceGroup` ~265; resolution ~949-970; the per-group synth/batch call)
- Modify: `server/src/tts/voice-mapping.ts:30-44`
- Modify: `server/src/tts/sidecar.ts` (~91-102 single, ~174-178 batch — add per-item `instruct`)
- Test: `server/src/tts/synthesise-chapter.test.ts`; `server/src/tts/voice-mapping.test.ts`; `server/src/tts/sidecar.test.ts`

**Interfaces:**
- Consumes: `emotionToInstruct` (Task 3), `liveInstruct` (Task 4), Task 6's sidecar contract.
- Produces: when `liveInstruct` is on AND the character is on the 1.7B tier, each group resolves `instruct = group.instruct ?? emotionToInstruct(group.emotion)` and the sidecar request carries it; `pickEmotionVariantVoice` returns the base voice (no `__emotion`) on that path.

- [ ] **Step 1:** Failing unit test on the resolution helper — given `liveInstruct=true`, tier=1.7B, a group with `emotion:'angry'` and no `instruct`, the resolved per-item payload carries `instruct: 'in an angry, raised voice'` and the voice is the **base** (no `__angry`). Given `liveInstruct=false`, the voice is `base__angry` and no `instruct` is sent (today's behaviour).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement:
  - Carry `instruct?` + `vocalization?` on `SentenceGroup` (from the sentence).
  - Add a `liveInstruct` boolean into the synth context (plumbed from the generation route's book-meta).
  - `pickEmotionVariantVoice(engine, variants, emotion, baseVoice, liveInstruct)` — when `engine==='qwen' && liveInstruct` return `baseVoice` (strict no-op); else today's logic. Update all call sites.
  - In the sidecar request builder, include `instruct` per item only when on the 1.7B-liveInstruct path; resolve via `group.instruct ?? emotionToInstruct(group.emotion)`.
- [ ] **Step 4:** Run the three test files — PASS. `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(server): thread instruct + route 1.7B liveInstruct synth path (fs-57)`.

---

### Task 9: Server — golden-audio instruct fixture + perf baseline

**Files:**
- Modify: `server/tts-sidecar/tests/golden/` (add an instruct fixture; reconcile the fs-55 variant golden test to 0.6B-only)
- Modify: the perf-guard harness referenced by `npm run test:golden-audio`
- Test: golden-audio suite

**Interfaces:**
- Produces: (a) identity-stability assertion (ECAPA cosine within tolerance across instructs); (b) audible-delivery-change assertion; (c) a **committed** batched-RTF baseline (incl. a heterogeneous-instruct-length batch) — replacing the parent spike's non-reproducible RTF 0.67.

- [ ] **Step 1:** Add the instruct golden fixture + the perf-baseline recorder (`--bless` path). Scope the existing fs-55 anchored-variant golden assertion to the 0.6B engine.
- [ ] **Step 2:** Run `npm run test:golden-audio:sidecar` on a weight box — record the baseline.
- [ ] **Step 3:** Commit the baseline JSON + fixture.
- [ ] **Step 4:** Re-run — green against the committed baseline.
- [ ] **Step 5:** Commit `test(sidecar): golden-audio instruct fixture + committed RTF baseline (fs-57)`.

---

# Wave 3 — Analysis (Phase-1 Stage 3)

### Task 10: The Stage-3 skill prompt + guard tests

**Files:**
- Create: `skills/audiobook-instruct-annotation.md`
- Test: `skills/audiobook-instruct-annotation.test.ts`

**Interfaces:**
- Produces: a skill that, given attributed sentences, returns `{ annotations: [{ sentenceId, text?, instruct?, vocalization? }] }` — vocalization `text` in the book's language, `instruct` in English, conservative (omit unless explicitly signalled), edit-in-place only (no new sentences), `id` copied verbatim from input (NOT a 1-based counter — the fs-58 contract bug).

- [ ] **Step 1: Write guard tests** asserting the prompt text contains: the strict envelope shape; "copy the sentenceId exactly from the input"; "vocalization text in the manuscript's language"; "instruct in English"; "never insert a new sentence — edit the existing sentence's text"; "omit unless the narrative makes the reaction explicit".

```ts
// skills/audiobook-instruct-annotation.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const txt = readFileSync(new URL('./audiobook-instruct-annotation.md', import.meta.url), 'utf8');
describe('instruct-annotation skill', () => {
  it('pins the strict envelope + id contract', () => {
    expect(txt).toContain('"annotations"');
    expect(txt).toMatch(/sentenceId.*exactly|exactly.*sentenceId/i);
    expect(txt).toMatch(/instruct.*English/i);
    expect(txt).toMatch(/edit the existing sentence|never insert a new sentence/i);
  });
});
```

- [ ] **Step 2:** Run — FAIL (file missing).
- [ ] **Step 3:** Write `audiobook-instruct-annotation.md` (model on `audiobook-emotion-annotation.md`'s strict, conservative structure; add the open-ended vocalization dialect guidance + worked examples in en/es/ru).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(server): Stage-3 instruct-annotation skill prompt (fs-57)`.

---

### Task 11: Analyzer `runStage3Chapter` + `prompt.instructAnnotation` knob

**Files:**
- Modify: `server/src/analyzer/gemini.ts` (add `runStage3Chapter`, `SKILL_TO_PROMPT_ID['script_review']`-style entry `instruct_annotation: 'prompt.instructAnnotation'`, schema)
- Modify: `server/src/analyzer/ollama.ts` (mirror)
- Modify: `server/src/analyzer/index.ts` (interface), `server/src/config/registry.ts` (`prompt.instructAnnotation` knob)
- Modify: `server/src/handoff/schemas.ts` (a `stage3ChapterSchema` envelope)
- Test: `server/src/analyzer/gemini.test.ts` (or the analyzer test home)

**Interfaces:**
- Produces: `runStage3Chapter(manuscriptId, chapterId, promptMd, call): Promise<{ annotations: Array<{ sentenceId: number; text?: string; instruct?: string; vocalization?: boolean }> }>` validated against `stage3ChapterSchema`.

- [ ] **Step 1:** Failing test — `runStage3Chapter` loads the `instruct_annotation` skill, calls the model, and validates the envelope (mock the model call as the existing analyzer tests do).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement, mirroring `runStage2Chapter` / the emotion pass. Add `stage3ChapterSchema` (`{ annotations: array of { sentenceId, text?, instruct?, vocalization? } }`, `.strict()`).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(server): runStage3Chapter instruct-annotation pass (fs-57)`.

---

### Task 12: `languagePreamble` Stage-3 clauses (es/ru/fr/de)

**Files:**
- Modify: `server/src/analyzer/gemini.ts` (`languagePreamble` ~182-209)
- Test: `server/src/analyzer/gemini.test.ts`

- [ ] **Step 1:** Failing test — for `language:'ru'` the preamble (in Stage-3 mode) instructs native-language vocalization + English instruct; for `'en'` it stays empty/byte-identical for non-Stage-3 calls.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Add a Stage-3 clause to each per-language block: "write the vocalization text in {language}; write the instruct in English." Keep English byte-identical for Stage 1/2.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(server): per-language Stage-3 vocalization clauses (fs-57)`.

---

### Task 13: Frontend `applyDetectedInstruct` reducer + audio-staleness + idempotency

**Files:**
- Modify: `src/store/manuscript-slice.ts` (add `applyDetectedInstruct`; reuse `setSentenceText` semantics + the dirty-for-regen path)
- Test: `src/store/manuscript-slice.test.ts`

**Interfaces:**
- Consumes: a Stage-3 annotation `{ sentenceId, text?, instruct?, vocalization? }`.
- Produces: `applyDetectedInstruct(payload)` — fill-only for `instruct`/`vocalization` (hand-set `instruct` wins); applies the `text` edit via the existing text-edit path (marks the sentence dirty for re-gen); **skips any sentence already `vocalization:true`** (idempotency — no double-prepend); drops annotations whose `sentenceId` is missing in the live manuscript (TOCTOU).

- [ ] **Step 1: Write failing tests**

```ts
// src/store/manuscript-slice.test.ts (append)
it('applyDetectedInstruct fills instruct + marks vocalization, edits text once', () => { /* … */ });
it('is idempotent — a second apply does not double-prepend the vocalization', () => { /* … */ });
it('never overwrites a hand-set instruct', () => { /* … */ });
it('drops an annotation whose sentenceId no longer exists', () => { /* … */ });
```

(Fill each with a concrete dispatch + assertion against the slice state, mirroring the existing `applyDetectedEmotions` tests.)

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the reducer (Immer draft): locate the sentence by id (drop if absent); if `vocalization` already true, skip text edit; else apply `text` and mark dirty; set `instruct`/`vocalization` only when currently empty/false.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(frontend): applyDetectedInstruct reducer w/ idempotency + staleness (fs-57)`.

---

### Task 14: Stage-3 SSE endpoint (own contract) + client

**Files:**
- Create: `server/src/routes/instruct-annotation.ts` (SSE, per-chapter, mirrors `detectEmotions`/`script-review.ts` streaming)
- Modify: `server/src/lib/api.ts` (real) — add `detectInstruct(bookId, opts)`; mirror in the mock `src/lib/api.ts` surface
- Test: `server/src/routes/instruct-annotation.test.ts`

**Interfaces:**
- Produces: `POST /api/manuscripts/:id/instruct-annotation` streaming `phase` / `annotation` / `result` events; `DetectInstructError` parallel to `DetectEmotionsError`. **Does not touch** the emotion endpoint/`detectEmotions`.

- [ ] **Step 1:** Failing route test — the endpoint streams annotations for attributed chapters and 4xx's with a typed error when there's no attribution (mirror the emotion-pass test).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the route (loop chapters, call `runStage3Chapter`, emit SSE) + the `detectInstruct` client.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(server): Stage-3 instruct-annotation SSE endpoint + client (fs-57)`.

---

### Task 15: Wire the "Detect emotions" button to also run Stage 3

**Files:**
- Modify: `src/components/detect-emotions-button.tsx`
- Test: `src/components/detect-emotions-button.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `api.detectInstruct` (Task 14), `applyDetectedInstruct` (Task 13).
- Produces: one operator action runs the emotion pass **and** Stage 3; confirm copy + progress cover the heavier (text-mutating, audio-invalidating) work.

- [ ] **Step 1:** Failing test — clicking confirm dispatches both `applyDetectedEmotions` and `applyDetectedInstruct` as their streams arrive; confirm copy mentions text changes.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement — after (or alongside) `api.detectEmotions`, call `api.detectInstruct` with the same abort controller; update the confirm dialog copy ("…also adds natural reactions like a gasp or sigh to the text").
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(frontend): run Stage 3 from the Detect-emotions trigger (fs-57)`.

---

### Task 16: `liveInstruct` operator toggle (book settings UI)

**Files:**
- Modify: the book-settings surface (where engine/tier controls live) + `book-meta-slice` action from Task 4
- Test: a component test + one Playwright e2e on the analysis surface

- [ ] **Step 1:** Failing test — toggling the control dispatches `setLiveInstruct` and persists via the book-state API.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Add the toggle (label: "Live expressive delivery (1.7B) — re-render to hear it"; default off; min-h-[44px] touch target).
- [ ] **Step 4:** Run — PASS; add the e2e.
- [ ] **Step 5:** Commit `feat(frontend): per-book liveInstruct toggle (fs-57)`.

---

# Wave 4 — Guardrails

### Task 17: srv-31 ASR vocalization-token tolerance

**Files:**
- Modify: `server/src/tts/segment-asr-qa.ts` (`ClassifyOptions` ~245-250; tolerance loop ~314-339)
- Modify: `server/src/tts/synthesise-chapter.ts` (pass the vocalization token(s) into the QA call when `vocalization:true`)
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Produces: `ClassifyOptions.vocalizationAllowlist?: Iterable<string>` — tokens tolerated exactly like `nameAllowlist`, so a prepended `"Ah!"` on a long lexical line doesn't count as drift while the words ARE still scored. (Refines spec §4.4: the bare-vocalization case is already handled by the existing `minChars` floor at line 274 — this covers only the edit-in-place long-sentence case.)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/segment-asr-qa.test.ts (append)
import { classifyTranscript } from './segment-asr-qa';
const CLEAN = { avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.2 };
it('tolerates a prepended vocalization token but still scores the words', () => {
  // Expected has the gasp; transcript dropped it but matches the words.
  const c = classifyTranscript(
    'Ah! I did not see you walk in there, Marcus, my friend.',
    'I did not see you walk in there, Marcus, my friend.',
    CLEAN,
    { vocalizationAllowlist: ['ah'] },
  );
  expect(c.verdict).toBe('ok'); // the dropped "ah" is tolerated
});
it('without the allowlist a real word drop still drifts', () => {
  const c = classifyTranscript(
    'Ah! I did not see you walk in there, Marcus, my friend at all today.',
    'walk in there, Marcus.',
    CLEAN,
  );
  expect(c.verdict).toBe('drift');
});
```

- [ ] **Step 2:** Run `cd server && npx vitest run src/tts/segment-asr-qa.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement — add `vocalizationAllowlist` to `ClassifyOptions`; fold its normalized tokens into the same `allow` set used by `nameAllowlist` (line 314-319). One-line union; the tolerance loop already honours `allow`.
- [ ] **Step 4:** In `synthesise-chapter.ts`, when a group's sentence is `vocalization:true`, pass the leading non-lexical token(s) as `vocalizationAllowlist`. Run — PASS.
- [ ] **Step 5:** Commit `feat(server): ASR vocalization-token tolerance for content-QA (fs-57)`.

---

### Task 18: fs-58 Script-Review round-trip regression

**Files:**
- Modify: `skills/audiobook-script-review.test.ts` (or a route test that exercises an apply)
- Test: same

**Interfaces:**
- Produces: a regression proving a sentence whose `text` is a vocalization AND carries an `instruct` survives a Script-Review pass unchanged (text not stripped, `instruct`/`vocalization` not dropped).

- [ ] **Step 1:** Failing test — feed a `strip_tag`-eligible-looking vocalization sentence (`text: 'Ah! he said'` where only "he said" is a tag) through the apply path; assert `"Ah!"` and `instruct` survive while the tag is removed.
- [ ] **Step 2:** Run — FAIL or PASS-by-accident; if it passes, tighten to a case that would regress without the guard.
- [ ] **Step 3:** If the apply path drops `instruct` on a `setSentenceText`, fix the reducer to preserve `instruct`/`vocalization` across a text edit.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `test(server): Script-Review preserves vocalization text + instruct (fs-57)`.

---

### Task 19: Regression plan doc + INDEX + backlog close-out

**Files:**
- Create: `docs/features/NN-fs57-vocalizations-instruct.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`; `docs/BACKLOG.md` (remove the fs-57 row)

- [ ] **Step 1:** Write the regression plan: invariants (additive-at-data-layer; 0.6B/Kokoro/Coqui byte-identical; liveInstruct default off; idempotent Stage 3; ASR tolerance; Script-Review guard) + the manual acceptance walkthrough (analyze a book → run the emotions/Stage-3 button → toggle liveInstruct → render on 1.7B → hear a sigh/laugh). Cite the Coalfall fixture + es/ru canaries.
- [ ] **Step 2:** Add the INDEX entry; remove the BACKLOG row.
- [ ] **Step 3:** Commit `docs(docs): fs-57 regression plan + index + backlog close-out (Closes #997)`.

---

## Self-Review

**Spec coverage:** §4.1 data model → Tasks 1,2,4 + ladder/marker in 8,13; §4.2 Stage 3 → Tasks 10–15; §4.3 synthesis → Tasks 5–9; §4.4 guardrails → Tasks 17,18; §5 testing → folded per task + 9,18,19; §2.1/§4.3 liveInstruct gate → Tasks 4,8,16. No uncovered section.

**Open refinement to confirm with the operator (surfaced during planning):** the spec §4.4 "dominance via total length" predicate is **superseded** by Task 17's token-tolerance approach, because the existing `minChars` floor already makes bare short vocalizations `inconclusive`. Functionally better; the spec should be reconciled to match (a one-line §4.4 edit).

**Placeholder scan:** the `<a designed test voice id>` in Task 5 and `NN` in Task 19 are intentional fill-at-execution values (a real designed voice on the box; the next free plan number) — every other step carries concrete code/commands.

**Type consistency:** `instruct?: string` / `vocalization?: boolean` consistent across schema (1), OpenAPI (2), envelope (11), reducer (13); `emotionToInstruct` (3) consumed in (8); `liveInstruct` (4) consumed in (8,16); `vocalizationAllowlist` (17) matches the `nameAllowlist` shape.
