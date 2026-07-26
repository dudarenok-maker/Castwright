# Audition Engine + Tier Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice preview renders in the engine picked for that character and at the Qwen tier the book is set to generate at, and there is one engine→modelKey mapper and one `TtsEngine` declaration per side of the wire.

**Architecture:** Delete the lossy frontend mapper (`sampleModelKeyForEngine`) and route every audition **and design** call site through `modelKeyForEngineChoice`, resolved from the **session** model key only. The audition `modelKey` is a shared cache key between the sample player and the design routes, so every site must compute the identical value — that constraint, not tier fidelity, is what fixes the call-site shape. Then fix the two server-side consequences: a fourth mapper in `voice-sample.ts`, and a "Sampled" scan anchored on the 0.6B filename literal.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend), Node/Express + TypeScript (server), Vitest for both.

**Spec:** `docs/superpowers/specs/2026-07-26-audition-engine-and-tier-fidelity-design.md`
**Issues:** Closes #1812, Closes #1839. Follow-ups already filed: #1841, #1842.
**Branch:** `fix/frontend-audition-engine-tier`

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

### Task 6: Release notes

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
  the design routes keep sharing one cached file. The three `TtsEngine`
  declarations and the four engine→modelKey mappers collapse to one per side.
  (#1812, #1839)
```

- [ ] **Step 3: Append the user-facing line to `RELEASE_NOTES.md`**

```markdown
- Voice previews now play in the engine you picked for that character, at the quality your book is set to render in — what you hear in the cast list is what you'll hear in the book.
```

- [ ] **Step 4: Commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): release notes for audition engine + tier fidelity

Refs #1812
Refs #1839"
```

---

### Task 7: Verify and open the PR

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

Body keeps the template's `## Summary` / `## Test plan` sections and must contain both literal lines:

```
Closes #1812
Closes #1839
```

Mention #1841 and #1842 as the deliberate out-of-scope follow-ups.

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
| VRAM gate stays at admission | no code — the design is to *not* add a frontend gate |
| One `TtsEngine` | 1 |
| One mapper per side | 2 (frontend), 4 (server) |
| "Sampled" scan + OpenAPI description | 5 |
| Release notes | 6 |

No gaps.

**2. Placeholder scan**

Three steps deliberately say "read the file's existing helpers first and reuse them" — Task 3 Step 3 (`cast.test.tsx` harness), Task 4 Step 1 (provider spy), Task 5 Step 1 (already pinned to the real fixture pattern). These are instructions to match a harness this plan has read only in part, not missing content: the assertions each must produce are stated exactly. Every other step carries its literal code.

**3. Type consistency**

`higherQwenTier` and the three-argument `modelKeyForEngineChoice` are defined in Task 2 and used with those exact names in Task 3 — where every audition/design call site passes **two** arguments, per the Global Constraints rule. `characterQwenTier` from the pre-review draft is **gone**: session-tier resolution removes the need for it, and reintroducing it would break the one-cache-key invariant. `QWEN_SAMPLE_MODEL_KEYS` is introduced and consumed within Task 5.
