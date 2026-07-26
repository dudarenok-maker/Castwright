# Audition Engine + Tier Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice preview renders in the engine picked for that character and at the Qwen tier the book is set to generate at, and there is one engine→modelKey mapper and one `TtsEngine` declaration per side of the wire.

**Architecture:** Delete the lossy frontend mapper (`sampleModelKeyForEngine`) and route every audition **and design** call site through `modelKeyForEngineChoice`, resolved from the **session** model key only. The audition `modelKey` is a shared cache key between the sample player and the design routes, so every site must compute the identical value — that constraint, not tier fidelity, is what fixes the call-site shape. Then fix the two server-side consequences: a fourth mapper in `voice-sample.ts`, and a "Sampled" scan anchored on the 0.6B filename literal.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend), Node/Express + TypeScript (server), Vitest for both.

**Spec:** `docs/superpowers/specs/2026-07-26-audition-engine-and-tier-fidelity-design.md`
**Issues:** Closes #1812, #1839, #1841, #1842.
**Branch:** `fix/frontend-audition-engine-tier`

**Wave 1 of two.** Wave 2 is the resolver progress signal (#1813), specified at
`docs/superpowers/specs/2026-07-26-resolver-prepass-progress-phase-design.md` and
planned once this merges. Independent in code; same delivery arc.

## Global Constraints

- **THE INVARIANT: one cache key.** `server/src/tts/voice-sample-cache.ts:1-9` — the sample player and the Qwen design route cache their ~12 s preview under the **same deterministic filename**, so designing produces exactly the file "Play 12s" later reads: *one synthesis, not two*. Every call site in Task 3 must therefore resolve to the **same** `modelKey` for the same character and session. Concretely: **pass exactly two arguments** to `modelKeyForEngineChoice` at every audition and design call site — never a third. A per-character tier would split the key, because bulk design (`cast.tsx:427`) sends one `modelKey` for N characters and cannot match a heterogeneous key.
- **Never gate the audition key on transient state.** Not on `ttsLifecycle.qwen1_7b.state` (`use-tts-lifecycle.ts:179` = *currently resident*, not *installed*), not on VRAM. The key must be a pure function of persisted state or the same character yields different filenames at different moments.
- **OpenAPI is the type source of truth** — never hand-write generated types.
- **Never delete a test without a replacement.** The `sampleModelKeyForEngine` describe block retires in Task 3; its cases must already exist in `tts-models.test.ts` from Task 2.
- **Do not use `--no-verify`.** Triage related-vs-pre-existing per CLAUDE.md's Commit gate.
- Frontend tests: `npm run test -- <path>`. Server: `npm run test:server -- <path>`.
- `piper` is unreachable from the UI (absent from `TTS_ENGINES` and from the picker's `installedEngines`, `profile-drawer.tsx:1163`). Changes to its arm are inert-but-correct.

---

### Task 1: One `TtsEngine` declaration

`openapi.yaml:4819` / `api-types.ts:3692` define `BaseVoice.engine` as **required**, enum `[coqui, gemini, piper, kokoro, qwen]` — identical members to both hand-written unions, so this is de-duplication, not narrowing.

**Files:**
- Modify: `src/lib/tts-voice-mapping.ts:12-19`
- Modify: `src/store/queue-slice.ts:17-22`
- Reference (unchanged): `src/lib/types.ts:115`

**Interfaces:**
- Consumes: nothing.
- Produces: one `TtsEngine` = `NonNullable<BaseVoice['engine']>`, re-exported from both modules so every existing import path keeps working.

- [ ] **Step 1: Replace the literal union in `tts-voice-mapping.ts`**

Line 12 currently reads `import type { Character, Voice, TtsModelKey } from './types';`. Replace it with:

```ts
import type { Character, Voice, TtsModelKey, TtsEngine } from './types';
```

Then replace lines 14-19 (the comment and the `export type TtsEngine = …` union) with:

```ts
/* Single source of truth for the engine union: the OpenAPI-derived type in
   ./types (BaseVoice.engine). Re-exported here so the many
   `import { TtsEngine } from './tts-voice-mapping'` call sites keep working,
   while there is exactly ONE declaration to keep in step with the contract.

   qwen is a BESPOKE per-character engine (plan 108) — no preset catalog; its
   "voice" is a designed voiceId living in overrideTtsVoices.qwen.name. It is in
   the union so the engine-aware resolver below can label it ("Designed voice" /
   "No voice designed yet") instead of falsely picking a Coqui/Kokoro preset. */
export type { TtsEngine };
```

Note this is `export type { TtsEngine };` (re-exporting the local import), **not** `export type { TtsEngine } from './types';` — the module's own functions use `TtsEngine` in type position, and a bare `export … from` creates no local binding, so the latter would not compile.

- [ ] **Step 2: Replace the literal union in `queue-slice.ts`**

Replace lines 17-22 with an import plus a re-export — `queue-slice` uses `TtsEngine` locally at line 27 (`requiredEngines?: TtsEngine[]`), so it needs both:

```ts
/* Plan 108 Wave 3 — the TTS engines a chapter requires, stamped server-side at
   enqueue time. The QueueEntry contract lives on the SERVER queue shape only
   (NOT in openapi.yaml), but the engine union it uses is the same one
   openapi.yaml already pins via BaseVoice.engine — so this re-exports the single
   declaration in ../lib/types rather than keeping a third hand-written copy in
   lockstep by hand. */
import type { TtsEngine } from '../lib/types';
export type { TtsEngine };
```

- [ ] **Step 3: Typecheck — this is the test for this task**

Run: `npm run typecheck`
Expected: PASS. A failure means the unions had already drifted — stop and report the exact TS error rather than adjusting the type to fit.

- [ ] **Step 4: Run the consuming suites**

Run: `npm run test -- src/lib/tts-voice-mapping.test.ts src/lib/tts-models.test.ts src/store`
Expected: PASS, no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tts-voice-mapping.ts src/store/queue-slice.ts
git commit -m "refactor(frontend): collapse the three TtsEngine declarations onto the OpenAPI-derived one

Refs #1839"
```

---

### Task 2: Complete the `modelKeyForEngineChoice` mirror

The frontend mapper's Qwen arm drops the session tier (`qwenTier ?? 'qwen3-tts-0.6b'`) and its `piper` arm returns the session key; the server's `canonicalModelKeyForEngine` does neither. Close both gaps.

The optional tier argument **stays** — the assign-guard callers (`voice-library-panel.tsx:264`, `profile-drawer.tsx:382`) pass it. That guard is engine-only and tier-agnostic (`server/src/routes/voice-library.ts:886`), so their behaviour is unchanged either way. Audition callers simply will not pass it (Task 3).

**Files:**
- Modify: `src/lib/tts-models.ts:190-226`
- Test: `src/lib/tts-models.test.ts:131-162`
- Reference (unchanged): `server/src/tts/model-keys.ts:87-120`

**Interfaces:**
- Consumes: `TtsEngine` from Task 1.
- Produces:
  - `higherQwenTier(a: TtsModelKey, b: TtsModelKey): TtsModelKey`
  - `modelKeyForEngineChoice(engineChoice: 'default' | TtsEngine, sessionModelKey: TtsModelKey, characterTier?: TtsModelKey | null): TtsModelKey`

  Task 3 calls `modelKeyForEngineChoice` with **two** arguments only.

- [ ] **Step 1: Write the failing table tests**

These are **mapper table coverage**, not the regression proof — the function that was broken is `sampleModelKeyForEngine`, which these never touch. The load-bearing regression tests are the call-site ones in Task 3. Append to the existing `describe('modelKeyForEngineChoice …')` block in `src/lib/tts-models.test.ts`:

```ts
  it('carries a Qwen session tier through instead of flattening to 0.6B', () => {
    /* The audition path resolves its tier from the SESSION key (the
       Start-generation modal writes ui.ttsModelKey and the cast pins together —
       layout.tsx:1731-1760), so a 1.7B book must preview at 1.7B. */
    expect(modelKeyForEngineChoice('qwen', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it('elevates to an explicit character tier over a lower session tier', () => {
    expect(modelKeyForEngineChoice('qwen', 'qwen3-tts-0.6b', 'qwen3-tts-1.7b')).toBe(
      'qwen3-tts-1.7b',
    );
  });

  it('never lets a lower character tier drag a higher session tier down', () => {
    /* Mirrors higherQwenTier's contract (server/src/tts/model-keys.ts:118). */
    expect(modelKeyForEngineChoice('qwen', 'qwen3-tts-1.7b', 'qwen3-tts-0.6b')).toBe(
      'qwen3-tts-1.7b',
    );
  });

  it('resolves a non-Qwen engine against a mismatched session key', () => {
    /* The table the retired sampleModelKeyForEngine got wrong: it returned the
       SESSION key for every non-Qwen engine. */
    expect(modelKeyForEngineChoice('kokoro', 'coqui-xtts-v2')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('coqui', 'kokoro-v1')).toBe('coqui-xtts-v2');
  });

  it('leaves a matching engine/key pair alone', () => {
    expect(modelKeyForEngineChoice('kokoro', 'kokoro-v1')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('coqui', 'coqui-xtts-v2')).toBe('coqui-xtts-v2');
    expect(modelKeyForEngineChoice('gemini', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
```

And a new block:

```ts
describe('higherQwenTier', () => {
  it('picks 1.7B over 0.6B in either argument order', () => {
    expect(higherQwenTier('qwen3-tts-1.7b', 'qwen3-tts-0.6b')).toBe('qwen3-tts-1.7b');
    expect(higherQwenTier('qwen3-tts-0.6b', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it('keeps `a` on a tie', () => {
    expect(higherQwenTier('qwen3-tts-0.6b', 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });
});
```

Add `higherQwenTier` to the import at `src/lib/tts-models.test.ts:11`. Do **not** re-add `modelKeyForEngineChoice('qwen', 'kokoro-v1') → 'qwen3-tts-0.6b'`; it already exists at line 142.

- [ ] **Step 2: Update the two `piper` assertions**

Replace the existing assertions at `tts-models.test.ts:160-161`:

```ts
  it('maps piper to its canonical key, mirroring the server table', () => {
    /* Changed here: previously fell back to the session key. Unreachable from
       the UI (piper is absent from TTS_ENGINES and from the engine picker's
       installedEngines), so this is alignment with
       server/src/tts/model-keys.ts canonicalModelKeyForEngine, not a behaviour
       change any user can observe. */
    expect(modelKeyForEngineChoice('piper', 'kokoro-v1')).toBe('piper-en-us-medium');
    expect(modelKeyForEngineChoice('piper', 'qwen3-tts-1.7b')).toBe('piper-en-us-medium');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -- src/lib/tts-models.test.ts`
Expected: FAIL — `('qwen','qwen3-tts-1.7b')` returns `'qwen3-tts-0.6b'`, the piper cases return the session key, and `higherQwenTier` fails to import. The `kokoro`/`coqui` mismatch cases **already pass** against the current mapper; that is expected and is why they are labelled table coverage.

- [ ] **Step 4: Implement**

In `src/lib/tts-models.ts`, replace lines 190-226 (from `import type { TtsEngine } from './types';` through the end of `modelKeyForEngineChoice`) with:

```ts
import type { TtsEngine } from './types';

/* Ordinal rank of the two Qwen quality tiers — 1.7B outranks 0.6B. Non-Qwen
   keys rank 0 (never meaningfully compared; callers only invoke this once both
   sides are known to be Qwen tiers). Mirror of server/src/tts/model-keys.ts. */
function qwenTierRank(key: TtsModelKey): number {
  return key === 'qwen3-tts-1.7b' ? 1 : 0;
}

/* The higher-ranked of two Qwen model keys. Mirror of the backend's
   higherQwenTier (server/src/tts/model-keys.ts): a per-character tier override
   is meant to ELEVATE one character above the run's default, so a character
   whose stored tier happens to be the lower one (stale, or simply never
   elevated) can never drag a run explicitly started at the higher tier back
   down. Ties keep `a`. */
export function higherQwenTier(a: TtsModelKey, b: TtsModelKey): TtsModelKey {
  return qwenTierRank(a) >= qwenTierRank(b) ? a : b;
}

/* THE frontend engine→modelKey mapper — mirror of the backend's
   canonicalModelKeyForEngine (server/src/tts/model-keys.ts). Resolves an engine
   CHOICE ('default' = use the session default; any real TtsEngine = a
   per-character override) to the concrete TtsModelKey that will ACTUALLY route.

   This is the only such mapper on the frontend. `sampleModelKeyForEngine`
   (formerly src/lib/tts-voice-mapping.ts) was a lossy second copy that returned
   the SESSION key for every non-Qwen engine — so a book on Coqui with a
   character overridden to Kokoro auditioned in Coqui (#1839). Add new engines
   here and in the server mirror together; there is nowhere else to add them.

   TWO CALLER SHAPES, and the difference matters:

   - Audition / design call sites pass TWO arguments. Their result is a shared
     CACHE KEY (server/src/tts/voice-sample-cache.ts) — the sample player and
     the design routes must land on one filename — so the tier must come from
     the session key alone. Passing a per-character tier there would split the
     key, since bulk design sends one modelKey for N characters.
   - The cloned-voice assign guard passes THREE, carrying a pending per-character
     1.7B pin. That guard reads only the ENGINE half
     (server/src/routes/voice-library.ts:886), so the tier is inert for it. */
export function modelKeyForEngineChoice(
  engineChoice: 'default' | TtsEngine,
  sessionModelKey: TtsModelKey,
  characterTier?: TtsModelKey | null,
): TtsModelKey {
  if (engineChoice === 'default') return sessionModelKey;
  switch (engineChoice) {
    case 'kokoro':
      return 'kokoro-v1';
    case 'qwen': {
      /* A non-Qwen session key carries no tier, so the 0.6B base is the floor. */
      const sessionTier: TtsModelKey = sessionModelKey.startsWith('qwen')
        ? sessionModelKey
        : 'qwen3-tts-0.6b';
      return higherQwenTier(characterTier ?? sessionTier, sessionTier);
    }
    case 'coqui':
      return 'coqui-xtts-v2';
    case 'piper':
      return 'piper-en-us-medium';
    case 'gemini':
      return sessionModelKey.startsWith('gemini-') ? sessionModelKey : 'gemini-2.5-flash';
    default:
      return sessionModelKey;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/lib/tts-models.test.ts`
Expected: PASS, including the three pre-existing Qwen cases at lines 142-147 unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tts-models.ts src/lib/tts-models.test.ts
git commit -m "fix(frontend): complete the modelKeyForEngineChoice mirror

Carries the Qwen session tier through instead of flattening to 0.6B, and maps
piper to its canonical key, matching canonicalModelKeyForEngine.

Refs #1839"
```

---

### Task 3: Migrate every call site, delete `sampleModelKeyForEngine`

Every site below passes **exactly two arguments**. Four of them (`cast.tsx:427`, `voice-readiness-gate.tsx:74`, `rebaseline-modal.tsx:277`, `script-review-diff.tsx:74`) are **design** requests, not auditions: server-side their `modelKey` only names the cached audition file (`design-voice-core.ts:206`) and the design request body carries no tier (`:272-278`). They are on the shared cache key, which is why they must move in lockstep with the play sites.

**Files:**
- Modify: `src/views/cast.tsx:53,427,500,1018-1021,1223`
- Modify: `src/modals/profile-drawer.tsx:31,655,665`
- Modify: `src/modals/voice-readiness-gate.tsx:24,74`
- Modify: `src/modals/rebaseline-modal.tsx:49,277`
- Modify: `src/components/script-review-diff.tsx:33,74`
- Modify: `src/lib/tts-voice-mapping.ts:369-384` (delete the function, keep `QWEN_MODEL_KEY`)
- Modify: `src/lib/tts-voice-mapping.test.ts:13,98-108`
- Modify: `src/views/cast.test.tsx:407`
- Test: `src/modals/profile-drawer.test.tsx`, `src/views/cast.test.tsx`

**Interfaces:**
- Consumes: `modelKeyForEngineChoice` (two-argument form) from Task 2; `TtsEngine` from Task 1.
- Produces: no new exports. `QWEN_MODEL_KEY` stays exported — `src/lib/play-emotion-variant.ts:15` and `src/components/script-review-voice-nudge.test.ts:3` import it.

- [ ] **Step 1: Write the failing regression test — wrong engine**

Add to the `describe('ProfileDrawer per-character engine + Qwen bespoke voice (plan 108)', …)` block in `src/modals/profile-drawer.test.tsx`, following the harness at `:1673-1689` exactly (`renderWithBook`, the `playSampleWithAutoLoad` mock, `baseChar`, `/Play 12s sample/i`):

```tsx
  it('auditions a Kokoro-overridden character in Kokoro, not the book default engine (#1839)', async () => {
    /* Book default is Coqui XTTS; this character is overridden to Kokoro via the
       engine picker (which offers coqui — profile-drawer.tsx:1163). Before the
       fix the request carried the PROJECT key (coqui-xtts-v2) and
       voice-sample.ts:121 derives the engine FROM that key on the
       character-audition branch, so the preview played in Coqui. */
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    const { store } = renderWithBook({ ...baseChar, ttsEngine: 'kokoro' });
    store.dispatch(uiSlice.actions.setTtsModelKey('coqui-xtts-v2'));

    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));

    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.modelKey).toBe('kokoro-v1');
  });
```

- [ ] **Step 2: Write the failing regression test — session tier**

```tsx
  it('auditions a Qwen character at the book tier, not the 0.6B floor (#1839)', async () => {
    /* The Start-generation modal writes ui.ttsModelKey and the cast pins
       together (layout.tsx:1731-1760), so a 1.7B session key means "this book
       renders at 1.7B" — the preview must match. */
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    const { store } = renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceStyle: 'a steady adult voice',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
    });
    store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-1.7b'));

    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));

    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.modelKey).toBe(
      'qwen3-tts-1.7b',
    );
  });
```

Confirm `uiSlice` is imported in this file (it is used at `:1908`); add the import if the describe block sits above that usage.

- [ ] **Step 3: Write the failing cache-key uniformity test**

This is the test that pins THE INVARIANT, and it belongs in `src/views/cast.test.tsx` because that is the file where the two sides diverge (`:427` design vs `:500` play). Follow the existing sample-assertion harness in that file (see `:407` for the store/dispatch shape and how the sample call is captured):

```tsx
it('resolves the same modelKey for a row sample and for bulk design, so both hit one cache file', async () => {
  /* voice-sample-cache.ts:1-9 — the sample player and the Qwen design route
     cache under the SAME deterministic filename: designing produces exactly
     the file "Play 12s" later reads. One synthesis, not two. If these two
     expressions ever diverge, design writes <scope>-A.mp3 and Play looks for
     <scope>-B.mp3: a silent second synthesis, and the row's "is this playing"
     prefix check stops matching. */
  const store = makeStore();
  store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-1.7b'));
  renderCast(store);

  fireEvent.click(screen.getByRole('button', { name: /Play sample/i }));
  await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalled());
  const playKey = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.modelKey;

  fireEvent.click(screen.getByRole('button', { name: /Design full cast/i }));
  const designAction = dispatchSpy.mock.calls
    .map((c) => c[0])
    .find((a) => a?.type === castDesignActions.designAllRequested.type);

  expect(designAction.payload.modelKey).toBe(playKey);
  expect(playKey).toBe('qwen3-tts-1.7b');
});
```

Adapt `makeStore`/`renderCast`/`dispatchSpy` and the two button names to whatever `cast.test.tsx` already defines — read its existing helpers first and reuse them rather than adding a parallel harness. The two assertions are what must hold.

- [ ] **Step 4: Run all three to verify they fail**

Run: `npm run test -- src/modals/profile-drawer.test.tsx src/views/cast.test.tsx`
Expected: FAIL — engine test gets `coqui-xtts-v2`, tier test gets `qwen3-tts-0.6b`, uniformity test gets `qwen3-tts-0.6b` for both (equal, but not the session tier, so the second assertion fails).

- [ ] **Step 5: Migrate `profile-drawer.tsx`**

Line 31 — drop `sampleModelKeyForEngine`, keep the rest:

```ts
import { resolveTtsVoiceForCharacter } from '../lib/tts-voice-mapping';
```

Line 15 already imports `modelKeyForEngineChoice`; no change needed there.

Line 655 — note this value feeds BOTH the Play button and the drawer's single design (`:934 modelKey: effectiveSampleModelKey`), which is exactly why it must not take a character tier:

```ts
  const effectiveSampleModelKey = modelKeyForEngineChoice(effectiveEngine, ttsModelKey);
```

Line 665:

```ts
  const currentModelKey = modelKeyForEngineChoice(currentEngine, ttsModelKey);
```

`charModelKey` stays untouched — it still drives the assign guard at `:382` and the Save path at `:1891`.

- [ ] **Step 6: Migrate `cast.tsx`**

Line 53 — drop `sampleModelKeyForEngine` from the `../lib/tts-voice-mapping` import, leaving its other named imports. Add `modelKeyForEngineChoice` to the existing `../lib/tts-models` import.

Line 427:

```ts
    const modelKey = modelKeyForEngineChoice('qwen', ttsModelKey);
```

Line 500:

```ts
    const effectiveModelKey = modelKeyForEngineChoice(effectiveEngine, ttsModelKey);
```

Lines 1018-1021 and 1223 — both currently call `sampleModelKeyForEngine(effectiveEngineFor(c), ttsModelKey)` inside a template literal. Replace both with:

```tsx
            const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${modelKeyForEngineChoice(
              effectiveEngineFor(c),
              ttsModelKey,
            )}`;
```

- [ ] **Step 7: Migrate the three design call sites**

`src/modals/voice-readiness-gate.tsx` — line 24 becomes `import { modelKeyForEngineChoice } from '../lib/tts-models';`, line 74:

```ts
          modelKey: modelKeyForEngineChoice('qwen', ttsModelKey),
```

`src/modals/rebaseline-modal.tsx` — line 49 becomes `import { modelKeyForEngineChoice } from '../lib/tts-models';`, line 277:

```ts
        modelKey: modelKeyForEngineChoice('qwen', ttsModelKey),
```

`src/components/script-review-diff.tsx` — line 33 becomes `import { modelKeyForEngineChoice } from '../lib/tts-models';`, line 74:

```ts
        modelKey: modelKeyForEngineChoice('qwen', ttsModelKey),
```

- [ ] **Step 8: Delete `sampleModelKeyForEngine`**

In `src/lib/tts-voice-mapping.ts`, delete lines 373-384 (its doc comment and body). **Keep** `QWEN_MODEL_KEY` and update its comment:

```ts
/* The 0.6B Qwen base key. Still used by the emotion-variant player
   (src/lib/play-emotion-variant.ts), which is pinned to that tier.
   To resolve the model key for an AUDITION or a design, use
   modelKeyForEngineChoice (src/lib/tts-models.ts) — the single
   engine→modelKey mapper on this side of the wire. */
export const QWEN_MODEL_KEY: TtsModelKey = 'qwen3-tts-0.6b';
```

- [ ] **Step 9: Delete the retired test block**

In `src/lib/tts-voice-mapping.test.ts`, delete the `describe('sampleModelKeyForEngine', …)` block at lines 98-108 and remove `sampleModelKeyForEngine` from the import at line 13. Keep `QWEN_MODEL_KEY` in that import. All four of its cases now live in `tts-models.test.ts` (Task 2), plus the two the old block never covered.

- [ ] **Step 10: Reword the now-coincidental assertion in `cast.test.tsx:407`**

`it('keeps the project model key + injects no qwen override for a non-Qwen row')` asserts `args.modelKey === store.getState().ui.ttsModelKey`. That passes only because `DEFAULT_TTS_MODEL` is `kokoro-v1` (`account-defaults.ts:54`) and `modelKeyForEngineChoice('kokoro','kokoro-v1')` → `'kokoro-v1'`. "Keeps the project model key" is the semantic this change removes, so make the assertion say what it now means:

```tsx
  it('resolves a non-Qwen row to its own engine key and injects no qwen override', () => {
```

and assert `expect(args.modelKey).toBe('kokoro-v1');` instead of comparing against `ui.ttsModelKey`.

- [ ] **Step 11: Run the FULL frontend suite**

Run: `npm run test`
Expected: PASS. Run the whole suite, not just the touched files — `cast.tsx` and `profile-drawer.tsx` are shared surfaces whose sample-URL shape distant view tests assert against.

- [ ] **Step 12: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no remaining reference to `sampleModelKeyForEngine`.

- [ ] **Step 13: Commit**

```bash
git add src/views/cast.tsx src/views/cast.test.tsx src/modals/profile-drawer.tsx src/modals/profile-drawer.test.tsx src/modals/voice-readiness-gate.tsx src/modals/rebaseline-modal.tsx src/components/script-review-diff.tsx src/lib/tts-voice-mapping.ts src/lib/tts-voice-mapping.test.ts
git commit -m "fix(frontend): audition in the character's engine at the book's tier

Routes every audition AND design call site through the single
modelKeyForEngineChoice mapper, resolved from the session key so both sides keep
landing on one shared cache file, and deletes the lossy sampleModelKeyForEngine.

Closes #1812
Refs #1839"
```

---

### Task 4: Fold the fourth mapper into `canonicalModelKeyForEngine`

**A pure de-duplication with no behaviour change.** Under its `engineForModelKey(modelKey) !== engine` guard (`voice-sample.ts:117`), `defaultModelKeyForEngine` and `canonicalModelKeyForEngine` agree on every reachable input: the `gemini` arm is only reached when `modelKey` is *not* Gemini (so the canonical version's `startsWith('gemini-')` branch is false and both return `'gemini-2.5-flash'`), `kokoro`/`piper`/`coqui` are the same constants, and `qwen` is unreachable because `isTtsEngine` (`voice-sample.ts:45-47`) deliberately excludes it. Do **not** write a test claiming a behaviour difference, and do **not** claim one in a comment.

**Files:**
- Modify: `server/src/routes/voice-sample.ts:49-58,113-119`
- Test: `server/src/routes/voice-sample.test.ts`

**Interfaces:**
- Consumes: `canonicalModelKeyForEngine(engine: TtsEngine, requestModelKey: TtsModelKey): TtsModelKey` from `server/src/tts/model-keys.ts` (pre-existing, re-exported by `../tts/index.js`).
- Produces: no new exports.

- [ ] **Step 1: Add characterisation tests FIRST (they pass before and after)**

These lock the existing behaviour so the refactor is provably inert. Match the file's existing app/spy setup:

```ts
it('re-picks a matching model key when a raw sample names a different engine', async () => {
  const res = await request(app)
    .post('/api/voices/any-voice/sample')
    .send({ modelKey: 'coqui-xtts-v2', rawEngine: 'kokoro', rawSpeaker: 'af_heart' });

  expect(res.status).toBe(200);
  expect(res.body.modelKey).toBe('coqui-xtts-v2'); // response echoes the REQUEST key
});

it('leaves the request key alone when it already routes to the requested engine', async () => {
  const res = await request(app)
    .post('/api/voices/any-voice/sample')
    .send({ modelKey: 'gemini-3.1-flash', rawEngine: 'gemini', rawSpeaker: 'Charon' });

  expect(res.status).toBe(200);
});
```

Read the file's existing assertions first — if it already spies on the provider, assert the effective key on that spy instead of the response body, which is the stronger check.

- [ ] **Step 2: Run — both must PASS before the change**

Run: `npm run test:server -- server/src/routes/voice-sample.test.ts`
Expected: PASS. If either fails, the characterisation is wrong; fix the test before touching the source.

- [ ] **Step 3: Implement**

Delete lines 49-58 (`defaultModelKeyForEngine` and its comment). Add `canonicalModelKeyForEngine` to the existing `../tts/index.js` import. Replace the body of the mismatch branch at `:117-119`:

```ts
    /* The client may have passed any modelKey it had handy (whatever the
       project's currently set to). Re-pick one that actually routes to the
       requested engine, otherwise selectTtsProvider would send a Coqui speaker
       name to the Gemini provider or vice versa.

       canonicalModelKeyForEngine (../tts/model-keys.ts) is the ONE
       engine→modelKey table on this side of the wire; the frontend mirror is
       modelKeyForEngineChoice (src/lib/tts-models.ts). Behaviour here is
       unchanged — under this guard the local table it replaced agreed on every
       reachable input. */
    if (engineForModelKey(modelKey) !== engine) {
      effectiveModelKey = canonicalModelKeyForEngine(engine, modelKey);
    }
```

- [ ] **Step 4: Run — both must still pass**

Run: `npm run test:server -- server/src/routes/voice-sample.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice-sample.ts server/src/routes/voice-sample.test.ts
git commit -m "refactor(server): fold defaultModelKeyForEngine into canonicalModelKeyForEngine

Behaviour-preserving: under the mismatch guard the two tables agreed on every
reachable input. Characterisation tests added first.

Closes #1812"
```

---

### Task 5: Stop anchoring the "Sampled" tier on the 0.6B literal

Once Task 3 lands, an audition on a 1.7B book is written as `<scope>-qwen3-tts-1.7b-<hash>.mp3`, and `hasCachedQwenSample` — which tests only the 0.6B prefix — silently drops that character out of the **Sampled** tier.

**Files:**
- Modify: `server/src/routes/voices.ts:65-69,244-253`
- Modify: `openapi.yaml` (the `sampled` field description)
- Test: `server/src/routes/voices.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

The harness writes real fixture files into a temp dir pointed at by `process.env.VOICE_SAMPLE_AUDIO_DIR` (`voices.test.ts:554-561`); `listVoiceSampleFiles` is **not** mocked. The response field is `sampled: boolean`, and the request **must** carry `?engine=qwen` (`voices.ts:249` returns `[]` otherwise). Add alongside the existing sampled tests at `:598-620`:

```ts
it('counts a 1.7B audition as sampled (#1839)', async () => {
  /* Once auditions follow the book's tier, the cached file is named
     <scope>-qwen3-tts-1.7b-<hash>.mp3. Anchoring the scan on the 0.6B literal
     dropped such a character out of the Sampled tier despite a good audition
     sitting on disk. Oduvan has no 0.6B file — only this one. */
  writeFileSync(join(sampleCacheDir, 'v_oduvan-qwen3-tts-1.7b-c0ffee.mp3'), 'fake-mp3');

  const res = await request(app).get('/api/voices?engine=qwen');
  const oduvan = res.body.voices.find((v: { id: string }) => v.id === 'v_oduvan');
  expect(oduvan.sampled).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:server -- server/src/routes/voices.test.ts`
Expected: FAIL — `oduvan.sampled` is falsy.

- [ ] **Step 3: Implement**

Replace lines 65-69:

```ts
/* The model keys the bespoke Qwen engine synthesises under — BOTH quality tiers
   (fs-56). Cached auditions are named `<scope>-<modelKey>-<hash>.mp3`, and an
   audition follows the book's session tier (#1839), so the `sampled` scan must
   match either. Mirror of the frontend's modelKeyForEngineChoice Qwen arm
   (src/lib/tts-models.ts). */
const QWEN_SAMPLE_MODEL_KEYS = ['qwen3-tts-0.6b', 'qwen3-tts-1.7b'] as const;
```

Update the comment at 244-248 so its worked example names both tiers:

```ts
  /* The voice-sample cache is workspace-global (not per-book), so read it once.
     Empty for preset engines — the `sampled` lifecycle tier is Qwen-only,
     matching the `generated` invariant. A character has been "Sampled" when a
     `<scope>-qwen3-tts-{0.6b,1.7b}-*.mp3` audition exists, where
     `scope = voiceId ?? char-<bookId>__<characterId>`. */
```

Replace the helper at 250-253:

```ts
  const hasCachedQwenSample = (sampleScope: string): boolean =>
    QWEN_SAMPLE_MODEL_KEYS.some((key) =>
      sampleFiles.some((f) => f.startsWith(`${sampleScope}-${key}-`)),
    );
```

- [ ] **Step 4: Update the OpenAPI description**

The `sampled` property's description in `openapi.yaml` hardcodes the 0.6B filename example (it surfaces in `src/lib/api-types.ts:3733`). Find it with:

Run: `grep -n "qwen3-tts-0.6b" openapi.yaml`

Update that example to `<scope>-qwen3-tts-{0.6b,1.7b}-*.mp3`, then regenerate:

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` updates with the new description text and no type changes.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:server -- server/src/routes/voices.test.ts`
Expected: PASS, including the pre-existing 0.6B sampled assertions at `:598-620`.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "fix(server): count either Qwen tier as a cached audition

Refs #1839"
```

---

### Task 6: The library-card preview follows the session tier (#1842)

The My-voices card hardcodes 0.6B on **both** sides of its own design/play pair —
`voice-library.ts:434` and `design-voice-core.ts:281` — and both use cache scope
`qwen-<uuid>`, so they share a cache key with each other. Same invariant as Task 3,
one level over: they move together or not at all.

The card and the cast row keep separate files regardless (different scopes:
`qwen-<uuid>` vs `voiceId ?? char-…`). What this fixes is the same voice
*sounding different* in the two places.

**Files:**
- Modify: `server/src/routes/voice-library.ts:432-434`
- Modify: `server/src/tts/design-voice-core.ts:281`
- Modify: `src/lib/api.ts:9556` (`realSampleLibraryVoice`)
- Modify: the My-voices card caller(s) that invoke `api.sampleLibraryVoice`
- Test: `server/src/routes/voice-library.test.ts`

**Interfaces:**
- Consumes: `modelKeyForEngineChoice` (two-argument form) from Task 2.
- Produces: `POST /api/voice-library/:voiceUuid/sample` accepts an optional
  `modelKey` in the body; `sampleLibraryVoice(voiceUuid, opts)` gains a `modelKey`.

- [ ] **Step 1: Write the failing server test**

```ts
it('renders a library sample at the requested Qwen tier', async () => {
  const res = await request(app)
    .post('/api/voice-library/uuid-1/sample')
    .send({ modelKey: 'qwen3-tts-1.7b' });

  expect(res.status).toBe(200);
  expect(res.body.url).toContain('qwen3-tts-1.7b');
});

it('defaults to 0.6B when the caller sends no modelKey', async () => {
  const res = await request(app).post('/api/voice-library/uuid-1/sample').send({});

  expect(res.status).toBe(200);
  expect(res.body.url).toContain('qwen3-tts-0.6b');
});

it('rejects a modelKey that does not route to Qwen', async () => {
  const res = await request(app)
    .post('/api/voice-library/uuid-1/sample')
    .send({ modelKey: 'kokoro-v1' });

  expect(res.status).toBe(400);
});
```

Match the file's existing app/fixture setup and its voiceUuid — read the
neighbouring `/sample` tests first and reuse their entry rather than inventing
`uuid-1`.

- [ ] **Step 2: Run to verify the first and third fail**

Run: `npm run test:server -- server/src/routes/voice-library.test.ts`
Expected: the default-0.6B test PASSES (current behaviour); the 1.7B and the
reject-non-Qwen tests FAIL.

- [ ] **Step 3: Implement the route**

In `server/src/routes/voice-library.ts`, replace lines 432-434:

```ts
    const body = (req.body ?? {}) as { text?: unknown; modelKey?: unknown };
    const voiceName = `qwen-${voiceUuid}`;
    /* #1842 — the card previews at the tier the caller's session will render at,
       so the same voice doesn't sound different on the card and on the cast row.
       Qwen-only: this endpoint synthesises `qwen-<uuid>`, which no other engine
       can voice. Omitted → the 0.6B base, keeping older callers working. */
    if (body.modelKey !== undefined) {
      if (!isTtsModelKey(body.modelKey) || engineForModelKey(body.modelKey) !== 'qwen') {
        return res.status(400).json({
          code: 'invalid_model',
          message: 'modelKey must be a Qwen model key.',
        });
      }
    }
    const modelKey: TtsModelKey = isTtsModelKey(body.modelKey) ? body.modelKey : 'qwen3-tts-0.6b';
```

Add `isTtsModelKey` and `engineForModelKey` to the file's existing `../tts/index.js`
import if they are not already there.

- [ ] **Step 4: Thread the tier into the preview design**

`design-voice-core.ts:281` hardcodes `modelKey: 'qwen3-tts-0.6b'` for the library
preview design, sharing scope `opts.storageKey` with the play route above. Add an
optional `modelKey` to that function's `opts` and use it, defaulting to
`'qwen3-tts-0.6b'`:

```ts
    modelKey: opts.modelKey ?? 'qwen3-tts-0.6b',
```

Declare it on the `opts` interface as `modelKey?: TtsModelKey` with a comment
pointing at the shared-cache-key reason. Then pass the caller's tier from whichever
route invokes it for the library preview, so design and play agree.

- [ ] **Step 5: Send the tier from the client**

In `src/lib/api.ts:9556`, add `modelKey` to the request body that
`realSampleLibraryVoice` posts, and to its signature plus the mock twin at
`:10396` (`mockSampleLibraryVoice`) so both halves of the `api` surface match.

At the My-voices card call site, pass the same expression every other site uses:

```ts
  modelKey: modelKeyForEngineChoice('qwen', ttsModelKey),
```

Find the caller with: `grep -rn "sampleLibraryVoice" src/`

- [ ] **Step 6: Run the tests**

Run: `npm run test:server -- server/src/routes/voice-library.test.ts`
Expected: PASS.

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/voice-library.ts server/src/routes/voice-library.test.ts server/src/tts/design-voice-core.ts src/lib/api.ts
git commit -m "fix(server,frontend): preview a library voice at the session tier

Closes #1842"
```

---

### Task 7: Gate the 1.7B tier picker on installed weights (#1841)

The signal already reaches the server — the sidecar reports
`qwen_base17_weights_present` (`main.py:6408`) and `sidecar-health.ts:204,279`
forwards it as `qwenBase17WeightsPresent`. Only the frontend `SidecarHealth` type
stops short. This is **installed**, not **loaded**: `VoiceEnginePicker`'s existing
`qwen17bAvailable` is residency-based and is deliberately left alone.

**Files:**
- Modify: `src/lib/api.ts:6073-6084` (type) and `:7491` (the mapping)
- Modify: `src/lib/use-tts-lifecycle.ts`
- Modify: `src/components/layout.tsx:1722-1728`
- Modify: `src/modals/start-generation.tsx:11-33`
- Test: `src/modals/start-generation.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TtsLifecycle.qwen1_7bInstalled: boolean`; `StartGenerationModal` gains
  `qwen17bInstalled?: boolean` (defaulting to `true`, so existing renders and tests
  are unaffected).

- [ ] **Step 1: Write the failing tests**

In `src/modals/start-generation.test.tsx` (create it if absent, following a
sibling modal test for the render harness):

```tsx
it('disables the 1.7B tier when its weights are not installed', () => {
  render(
    <StartGenerationModal
      defaultTier="qwen3-tts-0.6b"
      qwen17bInstalled={false}
      onClose={() => {}}
      onConfirm={() => {}}
    />,
  );

  const tier = screen.getByRole('radio', { name: /1\.7B/i }) as HTMLInputElement;
  expect(tier.disabled).toBe(true);
  expect(screen.getByText(/not downloaded/i)).toBeTruthy();
});

it('falls back to 0.6B when the cast is pinned to an uninstalled 1.7B', () => {
  /* Guard rail: layout passes defaultTier='qwen3-tts-1.7b' whenever any cast
     member is pinned there, which can outlive the weights being removed. */
  const onConfirm = vi.fn();
  render(
    <StartGenerationModal
      defaultTier="qwen3-tts-1.7b"
      qwen17bInstalled={false}
      onClose={() => {}}
      onConfirm={onConfirm}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /start/i }));
  expect(onConfirm).toHaveBeenCalledWith('qwen3-tts-0.6b');
});

it('leaves 1.7B selectable when the weights are present', () => {
  render(
    <StartGenerationModal
      defaultTier="qwen3-tts-0.6b"
      qwen17bInstalled
      onClose={() => {}}
      onConfirm={() => {}}
    />,
  );

  expect((screen.getByRole('radio', { name: /1\.7B/i }) as HTMLInputElement).disabled).toBe(false);
});
```

Adjust the role queries to the modal's real markup — read `start-generation.tsx:58`
onward first; if the tiers are buttons rather than radios, query by button name.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- src/modals/start-generation.test.tsx`
Expected: FAIL — the prop does not exist.

- [ ] **Step 3: Carry the field through the API type**

In `src/lib/api.ts`, add to the `SidecarHealth` interface beside
`qwenBase17Loaded` (`:6073`):

```ts
  /** 1.7B base WEIGHTS present on disk — distinct from `qwenBase17Loaded`,
      which is residency. The tier picker gates on this: the 1.7B base is a
      separate download (tts-sidecar `_qwen_base17_weights_present`). */
  qwenBase17WeightsPresent?: boolean;
```

and map it in the response parse near `:7491`, mirroring the adjacent
`qwenWeightsPresent` line.

- [ ] **Step 4: Expose it from the lifecycle hook**

In `src/lib/use-tts-lifecycle.ts`, add to the `TtsLifecycle` interface:

```ts
  /** True when the Qwen 1.7B base weights are on disk. INSTALLED, not loaded —
      `qwen1_7b.state === 'ready'` is residency and is a different question. */
  qwen1_7bInstalled: boolean;
```

and populate it from `sidecarHealth?.qwenBase17WeightsPresent === true` in the
returned object.

- [ ] **Step 5: Pass it to the modal**

In `src/components/layout.tsx`, on the `<StartGenerationModal …>` at `:1723`:

```tsx
          qwen17bInstalled={ttsLifecycle.qwen1_7bInstalled}
```

- [ ] **Step 6: Implement the gate**

In `src/modals/start-generation.tsx`, add the prop and apply it. Default it to
`true` so any caller that does not pass it behaves exactly as today:

```tsx
  /** False when the 1.7B base weights are not on disk — the tier is offered but
      disabled, since choosing it pins the whole cast (layout.tsx:1731-1760) to a
      model the box would have to download mid-run. Defaults true so an unwired
      caller keeps today's behaviour. */
  qwen17bInstalled?: boolean;
```

In the body, treat an uninstalled 1.7B as unselectable — both for the initial
selection and for the rendered option:

```tsx
  const tierAvailable = (id: TtsModelKey) => id !== 'qwen3-tts-1.7b' || qwen17bInstalled;
  const initial =
    TIERS.some((t) => t.id === defaultTier) && tierAvailable(defaultTier)
      ? defaultTier
      : 'qwen3-tts-0.6b';
```

Render the 1.7B row disabled when `!tierAvailable(t.id)`, with the reason
alongside its hint — "Not downloaded — add it from Models" — using the modal's
existing muted-text classes. Do not invent new colour literals; the file already
uses `text-ink/60`-style tokens.

- [ ] **Step 7: Run the tests**

Run: `npm run test -- src/modals/start-generation.test.tsx src/components/layout.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/lib/use-tts-lifecycle.ts src/components/layout.tsx src/modals/start-generation.tsx src/modals/start-generation.test.tsx
git commit -m "fix(frontend): gate the 1.7B tier picker on installed weights

Closes #1841"
```

---

### Task 8: Free an idle Qwen base instead of refusing the op

Admission already serialises (bounded poll) and evicts the analyzer once
(`capacity-retry.ts:116-120`), but never frees a resident TTS model — so a 1.7B
preview can fail after ~60 s while an unused 0.6B base holds the VRAM. Add a
second eviction lever, symmetric with the analyzer one.

**Files:**
- Modify: `server/src/gpu/capacity-retry.ts:51-71,97-133`
- Create: `server/src/gpu/evict-idle-tts.ts`
- Test: `server/src/gpu/capacity-retry.test.ts`, `server/src/gpu/evict-idle-tts.test.ts`

**Interfaces:**
- Consumes: `reconcileResidentQwenTiers(keep: { keep06: boolean; keep17: boolean }, signal?)` from `server/src/tts/ensure-sidecar-loaded.ts:182`; `activeGenerationBooks(): string[]` from `server/src/routes/generation.ts:602`; `engineForModelKey` from `server/src/tts/model-keys.ts`.
- Produces: `evictIdleQwenBase(opts: { modelKey?: TtsModelKey; signal?: AbortSignal }): Promise<boolean>` — true when it actually unloaded something. `CapacityRetryOpts` gains `evictIdleTts?: () => Promise<boolean>`.

- [ ] **Step 1: Write the failing tests for the helper**

Create `server/src/gpu/evict-idle-tts.test.ts`:

```ts
it('frees the OTHER Qwen tier when no render is in flight', async () => {
  const reconcile = vi.fn().mockResolvedValue(undefined);
  const freed = await evictIdleQwenBase({
    modelKey: 'qwen3-tts-1.7b',
    _reconcile: reconcile,
    _activeBooks: () => [],
  });

  expect(freed).toBe(true);
  /* Keep the tier this op needs, drop the other. */
  expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: true }, undefined);
});

it('keeps the 0.6B base when that is the tier being asked for', async () => {
  const reconcile = vi.fn().mockResolvedValue(undefined);
  await evictIdleQwenBase({
    modelKey: 'qwen3-tts-0.6b',
    _reconcile: reconcile,
    _activeBooks: () => [],
  });

  expect(reconcile).toHaveBeenCalledWith({ keep06: true, keep17: false }, undefined);
});

it('does nothing while any render is in flight', async () => {
  /* A resident base may be in active use, and a mixed-tier book can have BOTH
     tiers live at once (a character pinned above its book's tier). The render
     path already gets reconcileResidentQwenTiers at run start. */
  const reconcile = vi.fn();
  const freed = await evictIdleQwenBase({
    modelKey: 'qwen3-tts-1.7b',
    _reconcile: reconcile,
    _activeBooks: () => ['book-1'],
  });

  expect(freed).toBe(false);
  expect(reconcile).not.toHaveBeenCalled();
});

it('does nothing for a non-Qwen op', async () => {
  const reconcile = vi.fn();
  const freed = await evictIdleQwenBase({
    modelKey: 'kokoro-v1',
    _reconcile: reconcile,
    _activeBooks: () => [],
  });

  expect(freed).toBe(false);
  expect(reconcile).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:server -- server/src/gpu/evict-idle-tts.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the helper**

Create `server/src/gpu/evict-idle-tts.ts`:

```ts
/* Second eviction lever for capacity admission (#1839). Admission already
   evicts the analyzer Ollama once; this frees a resident Qwen BASE TIER the
   current op does not need, so an interactive preview can make room for itself
   instead of polling for ~60 s and failing while an idle base holds the VRAM.

   Deliberately narrow:
   - Qwen bases only. Coqui and Kokoro are button-driven — the user loaded them
     on purpose and silently unloading them would be surprising.
   - Only when NO render is in flight anywhere. A resident base during a render
     may be in active use, and a mixed-tier book can have both tiers live at
     once (a character pinned above its book's tier). This also makes the lever
     inert during generation by construction, which is correct: the render path
     already reconciles tiers at run start (ensure-sidecar-loaded.ts:182). */
import { reconcileResidentQwenTiers } from '../tts/ensure-sidecar-loaded.js';
import { activeGenerationBooks } from '../routes/generation.js';
import { engineForModelKey, type TtsModelKey } from '../tts/model-keys.js';

export interface EvictIdleQwenBaseOpts {
  /** The model key the blocked op is asking for. Its tier is the one KEPT. */
  modelKey?: TtsModelKey;
  signal?: AbortSignal;
  /** Injected for tests. */
  _reconcile?: typeof reconcileResidentQwenTiers;
  /** Injected for tests. */
  _activeBooks?: typeof activeGenerationBooks;
}

/** Returns true when it actually asked the sidecar to unload something. */
export async function evictIdleQwenBase(opts: EvictIdleQwenBaseOpts): Promise<boolean> {
  const activeBooks = opts._activeBooks ?? activeGenerationBooks;
  const reconcile = opts._reconcile ?? reconcileResidentQwenTiers;
  const { modelKey } = opts;

  if (!modelKey || engineForModelKey(modelKey) !== 'qwen') return false;
  if (activeBooks().length > 0) return false;

  const wants17 = modelKey === 'qwen3-tts-1.7b';
  await reconcile({ keep06: !wants17, keep17: wants17 }, opts.signal);
  return true;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:server -- server/src/gpu/evict-idle-tts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing wiring test**

Add to `server/src/gpu/capacity-retry.test.ts`, following its existing
no-capacity harness (it already builds 503 `{noCapacity:true,neededMb,deviceKey}`
responses — reuse that helper rather than writing a new one):

```ts
it('frees an idle TTS base before falling back to the poll', async () => {
  const evictIdleTts = vi.fn().mockResolvedValue(true);
  let calls = 0;
  const doPost = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? noCapacityResponse(4000, 'cuda:0') : new Response('ok', { status: 200 });
  });

  const res = await withCapacityRetry(doPost, {
    engine: 'qwen',
    evictIdleTts,
    /* Analyzer lever off, so the TTS lever is the only thing that can rescue it. */
    analyzerEvictWouldHelp: async () => false,
    pollMs: 0,
  });

  expect(res.status).toBe(200);
  expect(evictIdleTts).toHaveBeenCalledTimes(1);
  expect(doPost).toHaveBeenCalledTimes(2); // refused, freed, retried OK
});

it('does not retry the TTS eviction more than once', async () => {
  const evictIdleTts = vi.fn().mockResolvedValue(true);
  const doPost = vi.fn(async () => noCapacityResponse(4000, 'cuda:0'));

  await expect(
    withCapacityRetry(doPost, {
      engine: 'qwen',
      evictIdleTts,
      analyzerEvictWouldHelp: async () => false,
      pollMs: 0,
      maxAttempts: 3,
    }),
  ).rejects.toThrow(NoCapacityError);

  expect(evictIdleTts).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npm run test:server -- server/src/gpu/capacity-retry.test.ts`
Expected: FAIL — `evictIdleTts` is not an option.

- [ ] **Step 7: Wire the lever into the retry loop**

In `server/src/gpu/capacity-retry.ts`, add to `CapacityRetryOpts`:

```ts
  /** Injected "free a resident TTS model this op doesn't need" action —
      defaults to `evictIdleQwenBase` bound to this call's model key. Returns
      true when it actually unloaded something. */
  evictIdleTts?: () => Promise<boolean>;
```

Add `const evictIdleTts = opts.evictIdleTts ?? (async () => false);` beside the
other defaults, a `let evictedTts = false;` beside `let evicted = false;`, and a
second lever immediately after the analyzer block (`:116-120`), before the
attempt cap:

```ts
      /* Second lever: free a resident Qwen base this op doesn't need. Guarded to
         "no render in flight" inside evictIdleQwenBase, so it is inert during
         generation by construction. At most once per call, like the analyzer. */
      if (!evictedTts) {
        evictedTts = true;
        if (await evictIdleTts()) continue; // immediate retry after freeing VRAM
      }
```

Then in `server/src/tts/sidecar.ts`, at the `withCapacityRetry` call site
(`:297-320`), pass the bound lever:

```ts
      evictIdleTts: () => evictIdleQwenBase({ modelKey, signal }),
```

using the `modelKey` already in scope for that request. Import `evictIdleQwenBase`
from `../gpu/evict-idle-tts.js`.

- [ ] **Step 8: Run to verify they pass**

Run: `npm run test:server -- server/src/gpu/capacity-retry.test.ts server/src/gpu/evict-idle-tts.test.ts server/src/tts/sidecar.test.ts`
Expected: PASS.

- [ ] **Step 9: Watch for an import cycle**

`evict-idle-tts.ts` imports from `routes/generation.ts`, which is a heavy module.
If `npm run test:server` surfaces a cycle or a partially-initialised namespace
(the `importOriginal` flake documented in `model-keys.ts:1-13`), break it by
having `sidecar.ts` inject `_activeBooks` at the call site instead of letting the
helper import the route module directly. Do **not** ignore a cycle warning here.

Run: `npm run test:server`
Expected: PASS, no new flake.

- [ ] **Step 10: Commit**

```bash
git add server/src/gpu/evict-idle-tts.ts server/src/gpu/evict-idle-tts.test.ts server/src/gpu/capacity-retry.ts server/src/gpu/capacity-retry.test.ts server/src/tts/sidecar.ts
git commit -m "fix(server): free an idle Qwen base before refusing on capacity

Admission evicted only the analyzer, so a 1.7B preview could fail after a ~60s
poll while an unused 0.6B base held the VRAM. Guarded to no-render-in-flight, so
it is inert on the generation hot path.

Refs #1839"
```

---

### Task 9: Name what's holding the VRAM, loudly

Task 8 auto-frees what is safe to free (an idle Qwen base). It deliberately will
**not** touch Coqui or Kokoro. Refusing to evict them *and* staying quiet about
it is the worst combination — the user watches a preview fail with
`NoCapacityError`'s current message, which says only "free VRAM or attach a
second GPU" (`tts-errors.ts:20`) and never names the model to stop.

So when capacity is genuinely exhausted, the error names the resident
user-controlled models and says exactly what to do about each. The two are not
the same action:

- **Coqui XTTS** is button-driven (`ModelControlPill`) → "Stop it in the Models
  panel."
- **Kokoro** is the eagerly-resident fallback with **no Load/Stop pill**, gated by
  the `tts.preload.kokoro` setting → "Turn off *Preload Kokoro* in settings."

**Files:**
- Modify: `server/src/tts/tts-errors.ts:14-26`
- Create: `server/src/gpu/describe-vram-blockers.ts`
- Modify: `server/src/gpu/capacity-retry.ts` (pass blockers into the throw)
- Modify: `server/src/routes/voice-sample.ts` (surface it as a typed 503)
- Test: `server/src/gpu/describe-vram-blockers.test.ts`, `server/src/tts/tts-errors.test.ts`, `server/src/routes/voice-sample.test.ts`

**Interfaces:**
- Consumes: sidecar health booleans (`coquiLoaded`, `kokoroLoaded`, `qwenLoaded`, `qwenBase17Loaded`) via the existing `probeSidecarHealth` result shape (`sidecar-health.ts:193-208`).
- Produces:
  - `describeVramBlockers(health): VramBlocker[]` where `VramBlocker = { model: string; remedy: string }`
  - `NoCapacityError` gains `readonly blockers: VramBlocker[]` and folds them into its message.

- [ ] **Step 1: Write the failing tests for the describer**

Create `server/src/gpu/describe-vram-blockers.test.ts`:

```ts
it('names Coqui with the Models-panel remedy', () => {
  const out = describeVramBlockers({ coquiLoaded: true });
  expect(out).toEqual([
    { model: 'Coqui XTTS', remedy: 'Stop it in the Models panel.' },
  ]);
});

it('names Kokoro with the preload-setting remedy, not a Stop button', () => {
  /* Kokoro has NO Load/Stop pill — it is the eagerly-resident fallback gated by
     the tts.preload.kokoro setting, so "stop it" would be un-actionable. */
  const out = describeVramBlockers({ kokoroLoaded: true });
  expect(out).toEqual([
    { model: 'Kokoro', remedy: 'Turn off "Preload Kokoro" in settings.' },
  ]);
});

it('lists both when both are resident', () => {
  expect(describeVramBlockers({ coquiLoaded: true, kokoroLoaded: true })).toHaveLength(2);
});

it('never names a Qwen base — admission frees those itself', () => {
  /* Task 8's lever already handles an idle Qwen tier, so telling the user to go
     do it by hand would be noise. */
  expect(describeVramBlockers({ qwenLoaded: true, qwenBase17Loaded: true })).toEqual([]);
});

it('returns nothing when the sidecar reported nothing resident', () => {
  expect(describeVramBlockers({})).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:server -- server/src/gpu/describe-vram-blockers.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the describer**

Create `server/src/gpu/describe-vram-blockers.ts`:

```ts
/* Turns "the GPU is full" into "THIS is what's holding it, and here is the
   button that frees it" (#1839).

   Only lists models the USER controls and that admission deliberately will not
   auto-evict. A resident Qwen base is excluded on purpose: evict-idle-tts.ts
   already frees an idle one, so naming it here would be noise on top of an
   action already taken. The two remedies differ because the two models are
   controlled differently — Coqui has a Load/Stop pill, Kokoro does not. */

export interface VramBlocker {
  /** Display name, as the user sees it in the UI. */
  model: string;
  /** Imperative sentence naming the control that frees it. */
  remedy: string;
}

export interface VramBlockerHealth {
  coquiLoaded?: boolean;
  kokoroLoaded?: boolean;
  qwenLoaded?: boolean;
  qwenBase17Loaded?: boolean;
}

export function describeVramBlockers(health: VramBlockerHealth): VramBlocker[] {
  const out: VramBlocker[] = [];
  if (health.coquiLoaded) {
    out.push({ model: 'Coqui XTTS', remedy: 'Stop it in the Models panel.' });
  }
  if (health.kokoroLoaded) {
    out.push({ model: 'Kokoro', remedy: 'Turn off "Preload Kokoro" in settings.' });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:server -- server/src/gpu/describe-vram-blockers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing error-message test**

Add `server/src/tts/tts-errors.test.ts` (or extend it if present):

```ts
it('names the blocking models and their remedies in the message', () => {
  const err = new NoCapacityError('qwen', 4100, 'cuda:0', [
    { model: 'Coqui XTTS', remedy: 'Stop it in the Models panel.' },
  ]);

  expect(err.message).toContain('Coqui XTTS');
  expect(err.message).toContain('Stop it in the Models panel.');
  expect(err.blockers).toHaveLength(1);
});

it('falls back to the generic advice when nothing user-controlled is resident', () => {
  const err = new NoCapacityError('qwen', 4100, 'cuda:0', []);
  expect(err.message).toContain('free VRAM or attach a second GPU');
  expect(err.blockers).toEqual([]);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm run test:server -- server/src/tts/tts-errors.test.ts`
Expected: FAIL — the constructor takes three arguments.

- [ ] **Step 7: Extend the error**

In `server/src/tts/tts-errors.ts`, add an optional fourth parameter so every
existing three-argument call site keeps compiling:

```ts
  readonly blockers: VramBlocker[];

  constructor(engine: TtsEngine, neededMb: number, deviceKey: string, blockers: VramBlocker[] = []) {
    /* Name what is actually holding the memory. The generic "free VRAM" line is
       the fallback for when nothing user-controlled is resident — in that case
       the GPU is genuinely busy and there is no button to press. */
    const named = blockers.length
      ? ` ${blockers.map((b) => `${b.model} is loaded — ${b.remedy}`).join(' ')}`
      : ' — free VRAM or attach a second GPU.';
    super(`Not enough GPU memory for ${engine} (${neededMb}MB).${named}`);
    this.name = 'NoCapacityError';
    this.engine = engine;
    this.neededMb = neededMb;
    this.deviceKey = deviceKey;
    this.blockers = blockers;
  }
```

Note the generic branch keeps the exact substring `free VRAM or attach a second
GPU` so any existing assertion on it still matches — grep before changing:
`grep -rn "attach a second GPU" server/src src`.

- [ ] **Step 8: Populate blockers at the throw site**

In `capacity-retry.ts`, add an injected `describeBlockers?: () => Promise<VramBlocker[]>`
(defaulting to a probe of sidecar health through `describeVramBlockers`), and use
it where `NoCapacityError` is constructed:

```ts
      if (attempt + 1 >= maxAttempts) {
        throw new NoCapacityError(
          opts.engine as TtsEngine,
          noCap.neededMb,
          noCap.deviceKey,
          await describeBlockers(),
        );
      }
```

Inject rather than import the health route directly, for the same cycle reason
flagged in Task 8 Step 9.

- [ ] **Step 9: Surface it from the sample route**

In `server/src/routes/voice-sample.ts`, catch `NoCapacityError` around the
synthesis call and return a typed 503 the frontend can render, mirroring the
`chapter_failed` remediation shape already used at `generation.ts:1029`:

```ts
    if (e instanceof NoCapacityError) {
      return res.status(503).json({
        code: 'no_capacity',
        message: e.message,
        blockers: e.blockers,
      });
    }
```

Add a route test asserting the 503 body carries `code: 'no_capacity'` and the
blocker list.

- [ ] **Step 10: Run the server suite**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add server/src/gpu/describe-vram-blockers.ts server/src/gpu/describe-vram-blockers.test.ts server/src/tts/tts-errors.ts server/src/tts/tts-errors.test.ts server/src/gpu/capacity-retry.ts server/src/routes/voice-sample.ts server/src/routes/voice-sample.test.ts
git commit -m "fix(server): name the models holding VRAM when capacity runs out

NoCapacityError said only 'free VRAM' and never named what to stop. Coqui and
Kokoro get different remedies because they are controlled differently.

Refs #1839"
```

---

### Task 10: A Stop control wherever a voice model is resident

Task 9 names the model holding the VRAM. This gives that name a button.

The `ModelControlPill` already exists for both Kokoro and Coqui
(`generation.tsx:1000-1027`, wired to `ttsLifecycle.kokoro/coqui.onLoad/onStop`),
but it renders **only in the generation view** and **only** when
`enginesInUse.has(engine)` — i.e. when the open book's cast uses that engine.
Kokoro is the eagerly-resident fallback (`PRELOAD_KOKORO`, ~1 GB), so the common
case is that it holds VRAM while the user is on the cast or voices view, with no
control in reach. That is exactly the moment a preview fails for capacity.

**Files:**
- Modify: `src/components/layout.tsx` (the global `TtsNoticeBanner` slot)
- Modify: `src/lib/use-tts-lifecycle.ts` (expose resident-engine list, if not already derivable)
- Modify: `CLAUDE.md` (the stale "NO Load/Stop pill" claim)
- Test: `src/components/layout.test.tsx`

**Interfaces:**
- Consumes: `TtsLifecycle.kokoro` / `.coqui` (`onStop`, `state`) — already present.
- Produces: no new exports. A resident-model Stop control rendered globally.

- [ ] **Step 1: Read the existing global notice surface first**

`generation.tsx:1029-1033` documents that TTS Load/Stop notices moved to a single
global `<TtsNoticeBanner>` in `layout.tsx`, deliberately, to avoid a double render
against the one shared `useTtsLifecycle` instance. **Extend that component** —
do not add a second lifecycle consumer, or the double-render this comment warns
about comes straight back.

Run: `grep -n "TtsNoticeBanner" src/components/layout.tsx src/components/*.tsx`

- [ ] **Step 2: Write the failing test**

In `src/components/layout.test.tsx`, following its existing lifecycle-stub pattern:

```tsx
it('offers a Stop control for a resident voice model outside the generation view', async () => {
  /* Kokoro is eagerly resident (PRELOAD_KOKORO). Before this, its only Stop pill
     lived in the generation view behind enginesInUse — so on the cast/voices
     view it held ~1GB with no control in reach, which is exactly when a preview
     fails for capacity. */
  const onStop = vi.fn();
  renderLayoutAt('#/cast', { ttsLifecycle: stubLifecycle({ kokoro: { state: 'ready', onStop } }) });

  fireEvent.click(screen.getByRole('button', { name: /stop kokoro/i }));
  expect(onStop).toHaveBeenCalledTimes(1);
});

it('shows no Stop control when nothing is resident', () => {
  renderLayoutAt('#/cast', { ttsLifecycle: stubLifecycle({ kokoro: { state: 'idle' } }) });
  expect(screen.queryByRole('button', { name: /stop kokoro/i })).toBeNull();
});
```

Adapt `renderLayoutAt` / `stubLifecycle` to the helpers `layout.test.tsx` already
defines — `routes/index.test.tsx:365` shows the established `ttsLifecycle` stub
shape. Reuse it rather than writing a third one.

- [ ] **Step 3: Implement**

Render a Stop affordance for each engine whose lifecycle `state === 'ready'`,
inside the existing global notice component. Gate on residency (`state`), **not**
on `enginesInUse` — residency is the thing that costs VRAM, and it is what the
user needs to act on. Keep it quiet: this is a small inline control next to the
existing notice copy, not a persistent banner. Reuse `ModelControlPill` so the
control is the same object the generation view already shows.

Do not change the generation view's own pills — they stay, and both surfaces
share the one `useTtsLifecycle` instance as `generation.tsx:1029-1033` requires.

- [ ] **Step 4: Wire the blockers from Task 9 to it**

Where the no-capacity error surfaces its `blockers`, render each blocker beside
this control so the named model and the button that frees it are one unit rather
than a description and a scavenger hunt.

- [ ] **Step 5: Correct CLAUDE.md**

Under "Suggested follow-ups", the Kokoro bullet claims "NO Load/Stop pill — it's
just always available". Replace that clause with the truth: a pill exists and is
now reachable wherever the model is resident, gated on residency rather than on
the open book's cast.

- [ ] **Step 6: Run the tests**

Run: `npm run test -- src/components/layout.test.tsx src/views/generation.test.tsx`
Expected: PASS, and the generation view's own pills unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/components/layout.tsx src/components/layout.test.tsx src/lib/use-tts-lifecycle.ts CLAUDE.md
git commit -m "feat(frontend): stop a resident voice model from anywhere

The Kokoro/Coqui pill only rendered in the generation view behind enginesInUse,
so an eagerly-resident Kokoro held VRAM with no control in reach. Gates on
residency instead. Corrects CLAUDE.md's stale 'no Load/Stop pill' claim.

Refs #1839"
```

---

### Task 11: Release notes

**Files:**
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

- [ ] **Step 1: Check the in-progress version section**

Run: `head -40 RELEASE_NOTES.md`
Expected: an in-progress version section at the top. If the newest section is a *shipped* release instead, this is the first-PR-after-a-cut bootstrap case — follow CONTRIBUTING.md "Release notes"; do not invent a version number.

- [ ] **Step 2: Append the technical entry to `docs/release-notes-next.md`**

```markdown
- **Voice previews use the character's engine and the book's quality tier** — the
  audition request resolves its `modelKey` through the single
  `modelKeyForEngineChoice` mapper instead of the lossy `sampleModelKeyForEngine`
  copy, which returned the book's default key for every non-Qwen engine (so a
  Kokoro-overridden character in a Coqui book previewed in Coqui) and pinned every
  Qwen preview to 0.6B. The tier resolves from the session key, so previews and
  the design routes keep sharing one cached file. The My-voices card follows the
  same tier, so a voice can't sound different there than on the cast row. The
  Start-generation tier picker now disables 1.7B when its separately-downloaded
  weights aren't on disk. The three `TtsEngine` declarations and the four
  engine→modelKey mappers collapse to one per side.
  (#1812, #1839, #1841, #1842)
```

- [ ] **Step 3: Append the user-facing line to `RELEASE_NOTES.md`**

```markdown
- Voice previews now play in the engine you picked for that character, at the quality your book is set to render in — what you hear in the cast list is what you'll hear in the book, and the same voice sounds the same wherever you play it.
- The higher-quality 1.7B voice model is now greyed out until you've actually downloaded it, instead of failing partway into a run.
- Previewing a voice will now free up an idle voice model to make room for itself, rather than giving up when your graphics card looks full.
```

- [ ] **Step 4: Commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): release notes for audition engine + tier fidelity

Refs #1812
Refs #1839"
```

---

### Task 12: Verify and open the PR

- [ ] **Step 1: Run the branch-scoped battery**

Run: `npm run verify:fast:branch`
Expected: PASS. It typechecks frontend AND server together, so `server/node_modules` must exist in this worktree — it is junctioned. `TS2307: Cannot find module 'express'` means the junction broke, not the code.

- [ ] **Step 2: Push**

```bash
git push -u origin fix/frontend-audition-engine-tier
```

- [ ] **Step 3: Open the PR**

Title (must match the commit convention or `pr-title-lint.yml` rejects it):

```
fix(frontend,server): audition in the character's engine at the book's tier
```

Body keeps the template's `## Summary` / `## Test plan` sections and must contain all four literal lines:

```
Closes #1812
Closes #1839
Closes #1841
Closes #1842
```

Note it as **Wave 1 of two**, with Wave 2 (#1813, the resolver progress signal) to
follow on its own branch.

- [ ] **Step 4: Mandatory independent review**

Run the `code-review` gate (no `--fix`) per CLAUDE.md's Before-shipping checklist step 9, effort `medium` (single-concern `fix`, but multi-scope). Ask it specifically to re-check the one-cache-key invariant across all nine call sites — that is this change's failure mode.

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| Wrong engine on preview | 3 (regression test), 2 (table) |
| Qwen preview at the book's tier | 2, 3 |
| One-cache-key constraint | 3 (Step 3 test + the two-argument rule in Global Constraints) |
| Never gate the key on transient state | Global Constraints; no task introduces such a gate |
| VRAM gate stays at admission (no frontend gate) | no code by design; Task 8 strengthens admission itself |
| One `TtsEngine` | 1 |
| One mapper per side | 2 (frontend), 4 (server) |
| "Sampled" scan + OpenAPI description | 5 |
| Library-card preview tier (#1842) | 6 |
| 1.7B tier picker weights gate (#1841) | 7 |
| Admission frees an idle Qwen base | 8 |
| Hard-warn naming the resident blockers | 9 |
| A Stop control wherever a model is resident | 10 |
| Release notes | 11 |

No gaps. Note the spec's earlier "no-capacity UI copy is out of scope" line no
longer holds — Task 9 brings it in scope, and the spec says so.

**2. Placeholder scan**

Five steps deliberately say "read the file's existing helpers first and reuse them" — Task 3 Step 3 (`cast.test.tsx` harness), Task 4 Step 1 (provider spy), Task 5 Step 1 (already pinned to the real fixture pattern), Task 6 Step 1 (`voice-library.test.ts` fixture uuid), and Task 7 Step 1 (the modal's real markup: radios vs buttons). These are instructions to match a harness this plan has read only in part, not missing content: the assertions each must produce are stated exactly. Every other step carries its literal code.

Task 6 Step 5 and Task 7 Step 6 each end with a `grep` rather than a file:line, because the call sites are a small open set this plan did not enumerate exhaustively. The grep is the instruction, not a gap.

**3. Type consistency**

`higherQwenTier` and the three-argument `modelKeyForEngineChoice` are defined in Task 2 and used with those exact names in Task 3 — where every audition/design call site passes **two** arguments, per the Global Constraints rule. `characterQwenTier` from the pre-review draft is **gone**: session-tier resolution removes the need for it, and reintroducing it would break the one-cache-key invariant. `QWEN_SAMPLE_MODEL_KEYS` is introduced and consumed within Task 5.
