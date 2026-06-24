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
- **Branch:** cut `feat/fs57-vocalizations-instruct` **off the docs branch `docs/docs-fs57-vocalizations-spec`** (not bare `origin/main`) so the spec + this plan travel with the implementation (P-Mi2); rebase onto `origin/main` before opening the PR.
- **GPU box:** the Qwen weights are installed on the dev box, so the Wave 2 sidecar tasks (5, 6, 9) validate locally — they do **not** SKIP and do **not** owe a deferred on-box run.
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

  it('rejects a non-string instruct (string validator)', () => {
    expect(() => sentenceSchema.parse({ ...base, instruct: 5 })).toThrow();
  });
  it('still rejects unknown keys (.strict preserved)', () => {
    expect(() => sentenceSchema.parse({ ...base, bogus: 1 })).toThrow();
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

- [ ] **Step 3: Add a value round-trip test** (a runtime test, not a type-only assertion — `expectTypeOf` is a no-op at runtime unless vitest `test.typecheck` is enabled, P-Mi1). The real type guarantee comes from `npm run typecheck`; this locks that a Sentence value carrying the fields is accepted by code that consumes `Sentence`.

```ts
// src/lib/api-types.test.ts
import { describe, it, expect } from 'vitest';
import type { components } from './api-types';

describe('Sentence fs-57 fields', () => {
  it('accepts a value with instruct + vocalization', () => {
    const s: components['schemas']['Sentence'] = {
      id: 1, chapterId: 1, characterId: 'narrator', text: 'Ah! Hi.',
      instruct: 'a short gasp', vocalization: true,
    };
    expect(s.instruct).toBe('a short gasp');
    expect(s.vocalization).toBe(true);
  });
});
```

- [ ] **Step 4: Run** `npx vitest run src/lib/api-types.test.ts` — expect PASS. Run `npm run typecheck` — expect clean (this is the real type gate).

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

- [ ] **Step 1: Write a pytest that drives `_icl_instruct_synth` (or the raw `generate`) with `instruct=""` and with a neutral placeholder, asserting it returns valid PCM and recording which form is the no-op.** Keep the weight-gating helper (mirror `test_qwen3.py`) for CI/no-weight boxes, but **the weights are installed on the dev box, so this task runs green here** and closes the C2 gate (it does not defer).

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

- [ ] **Step 2: Run** `npm run test:sidecar` (weights present) — observe whether empty instruct is accepted.

- [ ] **Step 3: Pin the decision** in the test (empty string vs a fixed neutral placeholder e.g. `"in a neutral, natural narration voice"`) as the canonical no-op form, exported as a sidecar constant (e.g. `NEUTRAL_INSTRUCT`) so Task 6 + Task 8 import the same value; document it in a comment + the regression plan.

- [ ] **Step 4: Run** the test green on the dev box.

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
- Consumes: the Task 5 `NEUTRAL_INSTRUCT` form.
- Produces: `synthesize_batch` accepts a **batch-level `liveInstruct: bool`** plus `items: [{voice, text, instruct?}]`. **The path is chosen at batch level, not per item (P-C1):** when `liveInstruct` is true (1.7B only), **every** item runs the raw-`generate` bypass — items with an `instruct` use it, items without use `NEUTRAL_INSTRUCT` — so a single forward never mixes wrapper + bypass. When `liveInstruct` is false the batch uses `generate_voice_clone` exactly as today and `instruct` is ignored.

> **Why batch-level (P-C1):** one batched `generate` forward cannot mix the `generate_voice_clone` wrapper and the raw bypass. Keying off "any item has an instruct" would (a) leave a neutral item on the wrong path and (b) make an all-neutral `liveInstruct` batch silently use the wrapper. The batch-level flag is the only signal that keeps the whole 1.7B-`liveInstruct` tier on one path.

> **Single `/synthesize` scope (PR2-M3): batch-only for v1.** Chapter generation always batches, so the live-instruct path lands only on `synthesize_batch`. The single `/synthesize` endpoint (voice samples / auditions / previews) stays **instruct-free / neutral** — a preview is a voice identity check, not a per-line delivery. State this in the spec §4.3 + the regression plan; revisit only if previews need expressive delivery.

- [ ] **Step 1: Write the failing test** — (a) a `liveInstruct=true` batch with two items carrying *different* instructs returns two non-empty PCM buffers, no cross-bleed; (b) a `liveInstruct=true` batch with one instructed + one **neutral** item still routes BOTH through the bypass (assert the neutral item used `NEUTRAL_INSTRUCT`, e.g. via a spy/log on the generate call), never the wrapper; (c) a `liveInstruct=false` batch ignores `instruct` and calls `generate_voice_clone`.

- [ ] **Step 2: Run** — expect FAIL (batch has no `liveInstruct` param).

- [ ] **Step 3: Implement** — add `liveInstruct` to the `synthesize_batch` request model. In the 1.7B branch: **if `liveInstruct`**, build a per-item `instruct_ids` list (each item's `instruct` or `NEUTRAL_INSTRUCT`, via `w._build_instruct_text` + `w._tokenize_texts`) and call the raw `model.generate(..., instruct_ids=…, voice_clone_prompt=…)` (the `_icl_instruct_synth` mechanism lifted to batch); **else** the existing `generate_voice_clone` path. Keep the call under `_synth_lock` + `_base17_activity()` exactly as the current 1.7B batch does. The 0.6B branch ignores `liveInstruct`.

- [ ] **Step 4: Run** — expect PASS. Run `test_batch_synthesis.py` — existing batch contracts stay green.

- [ ] **Step 5: Commit** `feat(sidecar): batch-level liveInstruct path + per-item instruct on 1.7B (fs-57)`.

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
- Create: `server/src/tts/resolve-instruct.ts` — pure `resolveInstructForGroup` (P-Mo1)
- Test: `server/src/tts/resolve-instruct.test.ts`
- Modify: `server/src/tts/synthesise-chapter.ts` (`SentenceGroup` ~265; resolution ~949-970; the per-group synth/batch call)
- Modify: `server/src/tts/voice-mapping.ts:30-44`
- Modify: `server/src/tts/sidecar.ts` (~174-178 **batch only** — add `instruct` per item + batch-level `liveInstruct`; the single `/synthesize` body is unchanged, PR2-M3)
- Modify: `server/src/routes/generation.ts` (~485, ~604-613) — read `book-meta.liveInstruct` and pass into the synth context (P-M1)
- Test: `server/src/tts/voice-mapping.test.ts`; `server/src/tts/sidecar.test.ts`; `server/src/routes/generation.test.ts`

**Interfaces:**
- Consumes: `emotionToInstruct` (Task 3), `liveInstruct` (Task 4 / generation route), Task 6's batch-level sidecar contract.
- Produces: `resolveInstructForGroup(group, { is17b, liveInstruct }): { instruct?: string }` — pure; `is17b` is derived by the caller from the real model key (`canonicalModelKeyForEngine('qwen', modelKey) === 'qwen3-tts-1.7b'`, NOT an invented tier enum — PR2-M2). Returns `group.instruct ?? emotionToInstruct(group.emotion)` only when `is17b && liveInstruct`, else `{}`. The synth context carries `liveInstruct`; the sidecar request carries the batch-level `liveInstruct` + per-item `instruct` (the sidecar — not the server — substitutes `NEUTRAL_INSTRUCT` for empty items, PR2-Mi1); `pickEmotionVariantVoice` returns the base voice (no `__emotion`) on the liveInstruct path.

- [ ] **Step 0 (P-Mo1): Carve out the pure helper + test.** Write `resolve-instruct.test.ts` first:

```ts
// server/src/tts/resolve-instruct.test.ts
import { describe, it, expect } from 'vitest';
import { resolveInstructForGroup } from './resolve-instruct';

const grp = (o: Partial<{ emotion: string; instruct: string }>) =>
  ({ emotion: undefined, instruct: undefined, ...o }) as any;

describe('resolveInstructForGroup', () => {
  it('1.7B + liveInstruct: explicit instruct wins', () => {
    expect(resolveInstructForGroup(grp({ instruct: 'a tired sigh', emotion: 'angry' }),
      { is17b: true, liveInstruct: true })).toEqual({ instruct: 'a tired sigh' });
  });
  it('1.7B + liveInstruct: falls back to emotion phrase', () => {
    expect(resolveInstructForGroup(grp({ emotion: 'angry' }),
      { is17b: true, liveInstruct: true })).toEqual({ instruct: 'in an angry, raised voice' });
  });
  it('liveInstruct off: no instruct (today)', () => {
    expect(resolveInstructForGroup(grp({ emotion: 'angry' }),
      { is17b: true, liveInstruct: false })).toEqual({});
  });
  it('0.6B: never instruct', () => {
    expect(resolveInstructForGroup(grp({ instruct: 'x' }),
      { is17b: false, liveInstruct: true })).toEqual({});
  });
});
```

- [ ] **Step 1:** Run `cd server && npx vitest run src/tts/resolve-instruct.test.ts` — FAIL (module missing). Implement `resolve-instruct.ts` (imports `emotionToInstruct`). Run — PASS.
- [ ] **Step 2:** Failing tests for the wiring — `voice-mapping.test.ts` (the new `liveInstruct` param), `sidecar.test.ts` (batch-level `liveInstruct` + per-item `instruct` in the body), `generation.test.ts` (the route reads `book-meta.liveInstruct` and passes it to `synthesiseChapter`).
- [ ] **Step 3:** Implement:
  - Carry `instruct?` + `vocalization?` on `SentenceGroup` (from the sentence at the grouping site).
  - `pickEmotionVariantVoice(engine, variants, emotion, baseVoice, liveInstruct)` — when `engine==='qwen' && liveInstruct` return `baseVoice` (strict no-op); else today's logic. **Call sites to update (P-Mo3):** `synthesise-chapter.ts:~964` (the only production caller) + `voice-mapping.test.ts`; grep `pickEmotionVariantVoice` to confirm none missed.
  - In `generation.ts`, read `liveInstruct` from the loaded book-meta (PR2-Mi3: confirm the route loads book-meta — if not, add the load) and thread it into the `synthesiseChapter` options/context (default `false` when absent). Derive `is17b` from the resolved model key per group.
  - In `sidecar.ts`, set batch-level `liveInstruct` on the request and per-item `instruct` from `resolveInstructForGroup`. Empty items carry no `instruct` — the **sidecar** fills `NEUTRAL_INSTRUCT` (PR2-Mi1).
- [ ] **Step 4:** Run all four test files — PASS. `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(server): pure instruct resolver + liveInstruct wiring + 1.7B routing (fs-57)`.

---

### Task 8a: Batch-budget decision — instruct tokens vs the length-bucket batcher (P-M4 / spec R2-M4)

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts` (~536, the length-bucket batcher + `qwenBatchTokenBudget`)
- Test: `server/src/tts/synthesise-chapter.test.ts`

**Interfaces:**
- Produces: a settled, tested rule for whether a per-line `instruct`'s tokens count against `qwenBatchTokenBudget` when packing 1.7B-liveInstruct batches — so a long-instruct batch doesn't blow the per-forward budget.

- [ ] **Step 1:** Failing test — pack a batch of 1.7B-liveInstruct groups where the combined instruct length would exceed the budget if counted; assert the batcher splits (or doesn't) per the chosen rule, and that a normal no-instruct batch packs identically to today (no regression for `liveInstruct=false`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the decision: **count each item's resolved-instruct token estimate toward `qwenBatchTokenBudget`** on the liveInstruct path — including the `NEUTRAL_INSTRUCT` fill on neutral items, since on a liveInstruct batch *every* item carries `instruct_ids` (PR2-Mi2). Leave the flag-off path's bucketing byte-identical.
- [ ] **Step 4:** Run — PASS. `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(server): count instruct tokens against the Qwen batch budget (fs-57)`.

---

### Task 9: Server — golden-audio instruct fixture + flag-off byte-identical regression + perf baseline

**Files:**
- Modify: `server/tts-sidecar/tests/golden/` (add an instruct fixture; reconcile the fs-55 variant golden test to 0.6B-only)
- Modify: the perf-guard harness referenced by `npm run test:golden-audio`
- Test: golden-audio suite

**Interfaces:**
- Produces: (a) identity-stability assertion (ECAPA cosine within tolerance across instructs); (b) audible-delivery-change assertion; (c) **the C1 safety regression (P-M3 / PR2-M1) — primary is a deterministic code-path assertion**: with `liveInstruct=false`, the 1.7B render takes the `generate_voice_clone` branch with **no `instruct_ids`** and `pickEmotionVariantVoice` still returns `base__angry` (a request-shape / branch-spy assertion, not cross-run audio bytes); golden-audio equality is a *secondary* check, and its baseline must be blessed on **pre-Task-8 code** to mean "equals today," not blessed post-change; (d) a **committed** batched-RTF baseline (incl. a heterogeneous-instruct-length batch) — replacing the parent spike's non-reproducible RTF 0.67.

- [ ] **Step 1:** Add the instruct golden fixture + the **flag-off code-path regression** (PR2-M1, primary) + an optional pre-change golden baseline + the perf-baseline recorder (`--bless` path). Scope the existing fs-55 anchored-variant golden assertion to the 0.6B engine.
- [ ] **Step 2:** Run `npm run test:golden-audio:sidecar` (weights present on the dev box) — record the baseline.
- [ ] **Step 3:** Commit the baseline JSON + fixtures.
- [ ] **Step 4:** Re-run — green against the committed baselines (both flag-on instruct + flag-off byte-identical).
- [ ] **Step 5:** Commit `test(sidecar): golden-audio instruct fixture + flag-off regression + RTF baseline (fs-57)`.

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
- [ ] **Step 3:** Implement the reducer (Immer draft): locate the sentence by id (drop if absent); if `vocalization` already true, skip text edit; else apply `text` and mark dirty; set `instruct`/`vocalization` only when currently empty/false. **Known edge (P-Mi4, accepted for v1):** a vocalization the operator typed *by hand* leaves `vocalization=false`, so a later Stage-3 run could prepend a second gasp; document it in the regression plan (operator-authored vocalizations aren't auto-detected as such).
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

**Production token-extraction rule (P-M2).** The `vocalization` flag is a bare boolean with no stored span, so the server derives the allowlist tokens from `text` at synth time with a concrete rule: **when `vocalization===true`, take the leading run of `text` up to and including the first terminal mark (`!`, `…`, `.`, `?`) and tolerate its normalized tokens.** This matches how Stage 3 authors vocalizations (a short interjection + terminal mark prepended: `"Ah! …"`, `"Haah… …"`). Add a pure `leadingVocalizationTokens(text): string[]` helper (in `resolve-instruct.ts` or a sibling) so it is unit-tested independently of synthesis, rather than the hand-fed `['ah']` in the classify test below.

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
- [ ] **Step 3:** Add a `leadingVocalizationTokens` unit test + implementation (the P-M2 rule above): `leadingVocalizationTokens('Ah! I did not see you.')` → `['ah']`; `leadingVocalizationTokens('Haah… so tired.')` → `['haah']`; `leadingVocalizationTokens('No vocalization here.')` → still returns the first clause but is only *called* when `vocalization===true`.
- [ ] **Step 4:** Implement — add `vocalizationAllowlist` to `ClassifyOptions`; fold its normalized tokens into the same `allow` set used by `nameAllowlist` (line 314-319). One-line union; the tolerance loop already honours `allow`. In `synthesise-chapter.ts`, when a group's sentence is `vocalization:true`, pass `leadingVocalizationTokens(text)` as `vocalizationAllowlist`. Run all three tests — PASS.
- [ ] **Step 5:** Commit `feat(server): ASR vocalization-token tolerance for content-QA (fs-57)`.

---

### Task 18: fs-58 Script-Review round-trip regression

**Files:**
- Modify: `skills/audiobook-script-review.test.ts` (or a route test that exercises an apply)
- Test: same

**Interfaces:**
- Produces: (1) a **lock test** for the already-shipped fs-58 vocalization-strip guard; (2) a genuine **red-green** for the new requirement that `instruct`/`vocalization` survive a `setSentenceText` (`strip_tag`) apply.

> **Two distinct things (P-Mo2):** the fs-58 prompt guard ("never strip a vocalization") already shipped + is tested, so part (1) is a *characterization lock* (no new code, must pass immediately — if it fails, fs-58 regressed). Part (2) — preserving `instruct`/`vocalization` when Script Review rewrites a sentence's `text` — is **new, untested** behaviour and is the real red-green.

- [ ] **Step 1a (lock):** Assert the shipped guard text is present (mirror `audiobook-script-review.test.ts:27-52`) — passes immediately; fails only if fs-58 regresses.
- [ ] **Step 1b (red):** Failing test — apply a `strip_tag` op (`text: 'Ah! he said'` → `'Ah!'`) to a sentence carrying `instruct: 'a gasp'` + `vocalization: true`; assert the tag is removed **and** `instruct`/`vocalization` survive on the rewritten sentence.
- [ ] **Step 2:** Run 1b — expect FAIL if `setSentenceText` drops the sibling fields.
- [ ] **Step 3:** Fix the `setSentenceText` reducer (or the Script-Review apply) to preserve `instruct`/`vocalization` across a text rewrite.
- [ ] **Step 4:** Run both — PASS.
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

**Spec coverage:** §4.1 data model → Tasks 1,2,4 + ladder/marker in 8,13; §4.2 Stage 3 → Tasks 10–15; §4.3 synthesis → Tasks 5,6,7,8,8a,9; §4.4 guardrails → Tasks 17,18; §5 testing → folded per task + 9,18,19; §2.1/§4.3 liveInstruct gate → Tasks 4,8,16. No uncovered section.

**Open refinement to confirm with the operator (surfaced during planning):** the spec §4.4 "dominance via total length" predicate is **superseded** by Task 17's token-tolerance approach, because the existing `minChars` floor already makes bare short vocalizations `inconclusive`. Functionally better; the spec should be reconciled to match (a one-line §4.4 edit).

**Placeholder scan:** the `<a designed test voice id>` in Task 5 and `NN` in Task 19 are intentional fill-at-execution values (a real designed voice on the box; the next free plan number) — every other step carries concrete code/commands.

**Type consistency:** `instruct?: string` / `vocalization?: boolean` consistent across schema (1), OpenAPI (2), envelope (11), reducer (13); `emotionToInstruct` (3) consumed by `resolveInstructForGroup` (8); `liveInstruct` flows book-meta (4) → `generation.ts` → synth context → batch-level sidecar field (6,8); `NEUTRAL_INSTRUCT` is **sidecar-only** — defined + consumed in the Python sidecar (5,6); the TS server never imports it (sends empty instruct, the sidecar fills it). `is17b` derived from the real `modelKey` (not an invented tier enum). `vocalizationAllowlist` + `leadingVocalizationTokens` (17) match the `nameAllowlist` shape.

## Plan adversarial review — resolutions (round 1, 2026-06-24)

- **P-C1 — batch can't mix wrapper+bypass → FIXED in Tasks 6 + 8.** Path is now a **batch-level `liveInstruct`** signal, not per-item instruct presence (also noted in spec §4.3).
- **P-M1 — `liveInstruct` never wired → FIXED in Task 8.** Explicit `generation.ts` → `synthesiseChapter` plumbing step.
- **P-M2 — production allowlist token extraction undefined → FIXED in Task 17.** Concrete `leadingVocalizationTokens(text)` rule + its own unit test.
- **P-M3 — C1 safety unverified → FIXED in Task 9.** Flag-off byte-identical golden regression added.
- **P-M4 — batch-budget decision dropped → FIXED as new Task 8a.** Instruct tokens count against `qwenBatchTokenBudget` on the liveInstruct path.
- **P-Mo1 — untestable resolution unit → FIXED in Task 8 Step 0.** Pure `resolveInstructForGroup` extracted + tested.
- **P-Mo2 — Task 18 conflated lock + new work → FIXED.** Split into a lock test (shipped guard) + a red-green (instruct preservation across `setSentenceText`).
- **P-Mo3 — "update all call sites" vague → FIXED in Task 8.** Call sites enumerated (`synthesise-chapter.ts:~964` + grep check).
- **P-Mi1 — `expectTypeOf` no-op → FIXED in Task 2.** Swapped to a value round-trip test + `npm run typecheck` as the type gate.
- **P-Mi2 — impl branch wouldn't carry the plan → FIXED in Global Constraints.** Cut off the docs branch.
- **P-Mi3 — "(strict)" mislabel → FIXED in Task 1.** Relabelled + added a real `.strict()` unknown-key test.
- **P-Mi4 — manual-gasp double-prepend → FIXED in Task 13.** Documented as an accepted v1 edge.
- **Weights present → SKIP hedges struck in Tasks 5, 6, 9.** The C2 gate closes on-box.

## Plan adversarial review — resolutions (round 2, 2026-06-24)

- **PR2-M1 — flag-off "byte-identical" verified the wrong thing → FIXED in Task 9.** Primary guarantee is now a deterministic **code-path assertion** (wrapper branch, no `instruct_ids`); golden audio is secondary and, if used for equality, blessed on pre-Task-8 code.
- **PR2-M2 — invented `tier` enum → FIXED in Task 8.** Helper takes `is17b` derived from the real `modelKey`.
- **PR2-M3 — single `/synthesize` scope ambiguous → FIXED (Task 6 + spec §4.3).** Batch-only for v1; previews stay neutral.
- **PR2-Mi1 — `NEUTRAL_INSTRUCT` cross-language cross-ref → FIXED.** Sidecar-owned; the server sends empty instruct.
- **PR2-Mi2 — budget accounting → FIXED in Task 8a.** Counts every item's resolved instruct incl. the neutral fill.
- **PR2-Mi3 — book-meta load in `generation.ts` → FIXED in Task 8.** Confirm/add the load step.
