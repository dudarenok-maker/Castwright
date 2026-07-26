# Audition Engine + Tier Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice preview renders in the engine and Qwen quality tier the character will actually be generated in, and there is one engine→modelKey mapper and one `TtsEngine` declaration per side of the wire.

**Architecture:** Delete the lossy frontend mapper (`sampleModelKeyForEngine`) and route every audition call site through `modelKeyForEngineChoice`, which becomes a true mirror of the server's `canonicalModelKeyForEngine` — including a Qwen arm that preserves the tier via the existing `higherQwenTier` rule. Collapse the two hand-written `TtsEngine` unions onto the OpenAPI-derived one. Fix the two server-side consequences: a fourth mapper in `voice-sample.ts`, and a "Sampled" lifecycle scan that anchors on the 0.6B filename literal.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend), Node/Express + TypeScript (server), Vitest for both.

**Spec:** `docs/superpowers/specs/2026-07-26-audition-engine-and-tier-fidelity-design.md`
**Issues:** Closes #1812, Closes #1839
**Branch:** `fix/frontend-audition-engine-tier`

## Global Constraints

- **No hex literals in component code** — design tokens are CSS custom properties (`src/styles.css`). Not expected to come up here; no visual change is in scope.
- **OpenAPI is the type source of truth** — `Character`/`Voice`/`BaseVoice` etc. come from generated `src/lib/api-types.ts`. Never hand-write them.
- **RTK immer** — slice reducers mutate via Immer drafts. Don't rewrite to spreads.
- **Never delete a test without a replacement.** The `sampleModelKeyForEngine` describe block retires with its function; every one of its cases must have an equivalent in `tts-models.test.ts` first (Task 2), before the deletion in Task 3.
- **Do not use `--no-verify`.** If a hook fails, triage related-vs-pre-existing per CLAUDE.md's Commit gate.
- Frontend tests: `npm run test -- <path>`. Server tests: `npm run test:server -- <path>`.
- The engine picker offers only `kokoro | qwen | coqui` (`src/modals/profile-drawer.tsx:1163`). `piper` is unreachable from the UI today — changes to its arm are inert-but-correct, never load-bearing.

---

### Task 1: One `TtsEngine` declaration

Two hand-written literal unions duplicate the OpenAPI-derived type. `openapi.yaml:4819` defines `BaseVoice.engine` as `enum: [coqui, gemini, piper, kokoro, qwen]` — identical members to both, so this is a de-duplication, not a narrowing.

**Files:**
- Modify: `src/lib/tts-voice-mapping.ts:14-19`
- Modify: `src/store/queue-slice.ts:17-22`
- Reference (unchanged): `src/lib/types.ts:115`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a single `TtsEngine` = `NonNullable<BaseVoice['engine']>`, re-exported from `src/lib/tts-voice-mapping.ts` and `src/store/queue-slice.ts` so every existing import path keeps working unchanged.

- [ ] **Step 1: Replace the literal union in `tts-voice-mapping.ts`**

Replace lines 14-19:

```ts
/* qwen is a BESPOKE per-character engine (plan 108) — no preset catalog;
   its "voice" is a designed voiceId living in overrideTtsVoices.qwen.name.
   Kept in this union so the engine-aware resolver below can label it
   ("Designed voice" / "No voice designed yet") instead of falsely picking
   a Coqui/Kokoro preset for it. */
export type TtsEngine = 'coqui' | 'gemini' | 'piper' | 'kokoro' | 'qwen';
```

with:

```ts
/* Single source of truth for the engine union: the OpenAPI-derived type in
   ./types (BaseVoice.engine, openapi.yaml BaseVoice). Re-exported here so the
   many `import { TtsEngine } from './tts-voice-mapping'` call sites keep
   working, but there is exactly ONE declaration to keep in step with the
   contract.

   qwen is a BESPOKE per-character engine (plan 108) — no preset catalog; its
   "voice" is a designed voiceId living in overrideTtsVoices.qwen.name. It is
   in the union so the engine-aware resolver below can label it ("Designed
   voice" / "No voice designed yet") instead of falsely picking a Coqui/Kokoro
   preset for it. */
export type { TtsEngine } from './types';
```

The existing `import type { Character, Voice, TtsModelKey } from './types';` at line 12 becomes:

```ts
import type { Character, Voice, TtsModelKey, TtsEngine } from './types';
```

(the module's own functions reference `TtsEngine` as a value-position type, so it needs the import as well as the re-export).

- [ ] **Step 2: Replace the literal union in `queue-slice.ts`**

Replace lines 17-22:

```ts
/* Plan 108 Wave 3 — the TTS engines a chapter requires, stamped server-side at
   enqueue time. The contract lives on the SERVER queue shape only (NOT in
   openapi.yaml), so it's mirrored here as a local union rather than pulled from
   the generated api-types. Keep in lockstep with server/src/tts/index.ts
   TtsEngine. */
export type TtsEngine = 'coqui' | 'piper' | 'kokoro' | 'gemini' | 'qwen';
```

with:

```ts
/* Plan 108 Wave 3 — the TTS engines a chapter requires, stamped server-side at
   enqueue time. The QueueEntry contract lives on the SERVER queue shape only
   (NOT in openapi.yaml), but the engine union it uses is the same one
   openapi.yaml already pins via BaseVoice.engine — so this re-exports the
   single declaration in ../lib/types rather than keeping a third hand-written
   copy in lockstep by hand. */
export type { TtsEngine } from '../lib/types';
```

- [ ] **Step 3: Typecheck — this is the whole test for this task**

Run: `npm run typecheck`
Expected: PASS. A failure here is the finding — it would mean the unions had already drifted, which the spec says to report rather than paper over. If it fails, stop and report the exact TS error before changing anything else.

- [ ] **Step 4: Run the suites that consume these types**

Run: `npm run test -- src/lib/tts-voice-mapping.test.ts src/lib/tts-models.test.ts src/store`
Expected: PASS, no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tts-voice-mapping.ts src/store/queue-slice.ts
git commit -m "refactor(frontend): collapse the three TtsEngine declarations onto the OpenAPI-derived one

Refs #1839"
```

---

### Task 2: Make `modelKeyForEngineChoice` tier-preserving

The frontend mapper's Qwen arm drops the tier (`qwenTier ?? 'qwen3-tts-0.6b'`); the server's `canonicalModelKeyForEngine` preserves it. Bring the frontend into line by mirroring the server's `higherQwenTier` rule, so a per-character pin elevates and can never drag an explicitly-higher session tier down.

**Files:**
- Modify: `src/lib/tts-models.ts:190-226`
- Test: `src/lib/tts-models.test.ts:131-162`
- Reference (unchanged): `server/src/tts/model-keys.ts:87-120`

**Interfaces:**
- Consumes: `TtsEngine` from Task 1.
- Produces:
  - `higherQwenTier(a: TtsModelKey, b: TtsModelKey): TtsModelKey`
  - `characterQwenTier(raw: string | null | undefined): TtsModelKey | null`
  - `modelKeyForEngineChoice(engineChoice: 'default' | TtsEngine, sessionModelKey: TtsModelKey, characterTier?: TtsModelKey | null): TtsModelKey`

  Task 3 calls all three.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('modelKeyForEngineChoice …')` block in `src/lib/tts-models.test.ts`:

```ts
  it('preserves a Qwen session tier instead of collapsing to 0.6B (#1839)', () => {
    /* The old sampleModelKeyForEngine hardcoded 0.6B for every Qwen audition.
       On a 1.7B-default book that forced the 0.6B base resident ALONGSIDE the
       1.7B render base — the exact co-residency reconcileResidentQwenTiers
       exists to prevent. */
    expect(modelKeyForEngineChoice('qwen', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it('elevates to the character tier over a lower session tier', () => {
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

  it('resolves a non-Qwen session key to the 0.6B floor', () => {
    expect(modelKeyForEngineChoice('qwen', 'kokoro-v1')).toBe('qwen3-tts-0.6b');
  });
```

Add a new describe block covering the cases inherited from `sampleModelKeyForEngine` plus the wrong-engine case nothing covered:

```ts
describe('modelKeyForEngineChoice — engine fidelity (#1839: the preview must route to the character engine, not the book default)', () => {
  it('resolves kokoro against a Coqui project key', () => {
    /* The reachable bug: book on Coqui XTTS, character overridden to Kokoro.
       sampleModelKeyForEngine returned the project key, so the preview played
       in Coqui. voice-sample.ts:121 derives the engine FROM this key on the
       character-audition branch, so it is the routing decision. */
    expect(modelKeyForEngineChoice('kokoro', 'coqui-xtts-v2')).toBe('kokoro-v1');
  });

  it('resolves coqui against a Kokoro project key', () => {
    expect(modelKeyForEngineChoice('coqui', 'kokoro-v1')).toBe('coqui-xtts-v2');
  });

  it('keeps a matching engine/key pair unchanged', () => {
    expect(modelKeyForEngineChoice('kokoro', 'kokoro-v1')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('coqui', 'coqui-xtts-v2')).toBe('coqui-xtts-v2');
    expect(modelKeyForEngineChoice('gemini', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});

describe('higherQwenTier', () => {
  it('picks 1.7B over 0.6B in either argument order', () => {
    expect(higherQwenTier('qwen3-tts-1.7b', 'qwen3-tts-0.6b')).toBe('qwen3-tts-1.7b');
    expect(higherQwenTier('qwen3-tts-0.6b', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it('keeps `a` on a tie', () => {
    expect(higherQwenTier('qwen3-tts-0.6b', 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });
});

describe('characterQwenTier', () => {
  it('narrows the one persisted value that is a real pin', () => {
    expect(characterQwenTier('qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it('treats everything else as no pin', () => {
    expect(characterQwenTier('qwen3-tts-0.6b')).toBeNull();
    expect(characterQwenTier('kokoro-v1')).toBeNull();
    expect(characterQwenTier(null)).toBeNull();
    expect(characterQwenTier(undefined)).toBeNull();
  });
});
```

Extend the import at `src/lib/tts-models.test.ts:11` to include `higherQwenTier` and `characterQwenTier`.

- [ ] **Step 2: Update the two `piper` assertions in the existing block**

`piper` currently falls back to the session key. Making the mapper a true mirror of the server's table changes it to the canonical piper key. This is inert today — `piper` is not in `TTS_ENGINES` and the picker never offers it (`profile-drawer.tsx:1163`) — but it removes the last divergence between the two tables. Replace the existing assertions at `tts-models.test.ts:160-161`:

```ts
  it('maps piper to its canonical key, mirroring the server table', () => {
    /* Changed with #1839: previously fell back to the session key. Unreachable
       from the UI (piper is absent from TTS_ENGINES and from the engine
       picker's installedEngines), so this is alignment with
       server/src/tts/model-keys.ts canonicalModelKeyForEngine, not a
       behaviour change any user can observe. */
    expect(modelKeyForEngineChoice('piper', 'kokoro-v1')).toBe('piper-en-us-medium');
    expect(modelKeyForEngineChoice('piper', 'qwen3-tts-1.7b')).toBe('piper-en-us-medium');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -- src/lib/tts-models.test.ts`
Expected: FAIL. Specifically `modelKeyForEngineChoice('qwen', 'qwen3-tts-1.7b')` returns `'qwen3-tts-0.6b'`, `('kokoro', 'coqui-xtts-v2')` already passes, the piper cases return `'kokoro-v1'`/`'qwen3-tts-1.7b'`, and `higherQwenTier`/`characterQwenTier` fail to import.

- [ ] **Step 4: Implement**

In `src/lib/tts-models.ts`, replace the whole block from line 190 (`import type { TtsEngine } from './types';`) to the end of `modelKeyForEngineChoice` at line 226 with:

```ts
import type { TtsEngine } from './types';

/* Ordinal rank of the two Qwen quality tiers — 1.7B outranks 0.6B. Non-Qwen
   keys rank 0 (never meaningfully compared; callers only invoke this once both
   sides are already known to be Qwen tiers). Mirror of
   server/src/tts/model-keys.ts qwenTierRank. */
function qwenTierRank(key: TtsModelKey): number {
  return key === 'qwen3-tts-1.7b' ? 1 : 0;
}

/* The higher-ranked of two Qwen model keys. Mirror of the backend's
   higherQwenTier (server/src/tts/model-keys.ts): a per-character tier override
   is meant to ELEVATE one character above the run's default, so a character
   whose stored tier happens to be the lower one (stale, or simply never
   elevated) can never drag a run explicitly started at the higher tier back
   down. Ties keep `a` (the character's tier). */
export function higherQwenTier(a: TtsModelKey, b: TtsModelKey): TtsModelKey {
  return qwenTierRank(a) >= qwenTierRank(b) ? a : b;
}

/* Narrow a PERSISTED per-character tier to the one value that is actually a
   pin. openapi types `Character.ttsModelKey` as a bare nullable string, and
   only the 1.7B Quality tier is ever pinned per character (fs-56) — every
   other value, including a stale non-Qwen key left behind by an engine switch,
   means "no pin". Same narrowing the profile drawer seeds its local state with
   (src/modals/profile-drawer.tsx:322). */
export function characterQwenTier(raw: string | null | undefined): TtsModelKey | null {
  return raw === 'qwen3-tts-1.7b' ? 'qwen3-tts-1.7b' : null;
}

/* THE frontend engine→modelKey mapper — mirror of the backend's
   canonicalModelKeyForEngine (server/src/tts/model-keys.ts). Resolves an engine
   CHOICE ('default' means "use the session default", any real TtsEngine is a
   per-character override) to the concrete TtsModelKey that will ACTUALLY route:
   the assign request's intended `modelKey` for the cloned-voice wrong-engine
   guard, and the `modelKey` a voice audition is synthesised under.

   This is the only such mapper on the frontend. `sampleModelKeyForEngine`
   (formerly src/lib/tts-voice-mapping.ts) was a lossy second copy that returned
   the SESSION key for every non-Qwen engine — so a book on Coqui with a
   character overridden to Kokoro auditioned in Coqui (#1839). Add new engines
   here and in the server mirror together; there is nowhere else to add them.

   `characterTier` carries a per-character 1.7B pin (fs-56). The Qwen arm
   resolves it against the session tier with `higherQwenTier`, matching how
   synthesis itself resolves the pair — so a preview renders at the tier the
   character will be GENERATED at, reusing whichever Qwen base is already
   resident rather than forcing a second one alongside it (#1388). */
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
git commit -m "fix(frontend): make modelKeyForEngineChoice preserve the Qwen tier

Mirrors the server's canonicalModelKeyForEngine + higherQwenTier so a preview
resolves to the tier the character will actually render at.

Refs #1839"
```

---

### Task 3: Migrate every audition call site, delete `sampleModelKeyForEngine`

**Files:**
- Modify: `src/views/cast.tsx:53,427,499-500,1018-1021,1223`
- Modify: `src/modals/profile-drawer.tsx:31,655,665`
- Modify: `src/modals/voice-readiness-gate.tsx:24,74`
- Modify: `src/modals/rebaseline-modal.tsx:49,277`
- Modify: `src/components/script-review-diff.tsx:33,74`
- Modify: `src/lib/tts-voice-mapping.ts:369-384` (delete `sampleModelKeyForEngine`, keep `QWEN_MODEL_KEY`)
- Modify: `src/lib/tts-voice-mapping.test.ts:13,98-108` (delete the retired describe block)
- Test: `src/modals/profile-drawer.test.tsx`, `src/views/cast.test.tsx`

**Interfaces:**
- Consumes: `modelKeyForEngineChoice`, `characterQwenTier` from Task 2; `TtsEngine` from Task 1.
- Produces: no new exports. `QWEN_MODEL_KEY` (`tts-voice-mapping.ts:371`) stays exported — `src/lib/play-emotion-variant.ts:15` and `src/components/script-review-voice-nudge.test.ts:3` import it.

- [ ] **Step 1: Write the failing regression test — wrong engine**

Add to `src/modals/profile-drawer.test.tsx` (match the file's existing render helper and store setup; the assertion is what matters):

```tsx
it('auditions a Kokoro-overridden character in Kokoro, not the book default engine (#1839)', async () => {
  /* Book default is Coqui XTTS; this character is overridden to Kokoro via the
     engine picker. Before the fix the sample request carried the PROJECT key
     (coqui-xtts-v2) and voice-sample.ts:121 derived the engine from it, so the
     preview played in Coqui. */
  renderDrawer({
    ttsModelKey: 'coqui-xtts-v2',
    character: { ...baseCharacter, ttsEngine: 'kokoro' },
  });

  await userEvent.click(screen.getByRole('button', { name: /play|preview/i }));

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/sample'),
    expect.objectContaining({
      body: expect.stringContaining('"modelKey":"kokoro-v1"'),
    }),
  );
});
```

- [ ] **Step 2: Write the failing regression test — wrong tier**

```tsx
it('auditions a 1.7B-pinned character at 1.7B, not the 0.6B floor (#1839)', async () => {
  /* The 0.6B pin forced a SECOND Qwen base resident alongside the 1.7B render
     base — the co-residency reconcileResidentQwenTiers exists to prevent. */
  renderDrawer({
    ttsModelKey: 'qwen3-tts-0.6b',
    character: {
      ...baseCharacter,
      ttsEngine: 'qwen',
      ttsModelKey: 'qwen3-tts-1.7b',
      overrideTtsVoices: { qwen: { name: 'qwen-lord-vane' } },
    },
  });

  await userEvent.click(screen.getByRole('button', { name: /play|preview/i }));

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/sample'),
    expect.objectContaining({
      body: expect.stringContaining('"modelKey":"qwen3-tts-1.7b"'),
    }),
  );
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run test -- src/modals/profile-drawer.test.tsx`
Expected: FAIL — the first asserts `kokoro-v1` but gets `coqui-xtts-v2`; the second asserts `qwen3-tts-1.7b` but gets `qwen3-tts-0.6b`.

- [ ] **Step 4: Migrate `profile-drawer.tsx`**

Line 31 — drop `sampleModelKeyForEngine` from the import, keeping `resolveTtsVoiceForCharacter`:

```ts
import { resolveTtsVoiceForCharacter } from '../lib/tts-voice-mapping';
```

Line 15 already imports `modelKeyForEngineChoice` from `../lib/tts-models`; extend it with `characterQwenTier`:

```ts
import { TTS_MODEL_OPTIONS, engineForModelKey, modelKeyForEngineChoice, characterQwenTier } from '../lib/tts-models';
```

Line 655 — the PENDING choice, so it uses the drawer's live `charModelKey` state:

```ts
  const effectiveSampleModelKey = modelKeyForEngineChoice(
    effectiveEngine,
    ttsModelKey,
    charModelKey,
  );
```

Line 665 — the PERSISTED side of the A/B compare, so it uses the character's saved tier, not the pending one:

```ts
  const currentModelKey = modelKeyForEngineChoice(
    currentEngine,
    ttsModelKey,
    characterQwenTier(character.ttsModelKey),
  );
```

- [ ] **Step 5: Migrate `cast.tsx`**

Line 53 — drop `sampleModelKeyForEngine` from the `../lib/tts-voice-mapping` import block, leaving its other named imports intact. Add `modelKeyForEngineChoice` and `characterQwenTier` to the existing `../lib/tts-models` import.

Line 427 (`startDesign`):

```ts
    const modelKey = modelKeyForEngineChoice('qwen', ttsModelKey);
```

Line 500 (`playSampleFor`):

```ts
    const effectiveModelKey = modelKeyForEngineChoice(
      effectiveEngine,
      ttsModelKey,
      characterQwenTier(c.ttsModelKey),
    );
```

Lines 1018-1021 and 1223 (row sample-prefix construction) — both currently read:

```tsx
            const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${sampleModelKeyForEngine(
              effectiveEngineFor(c),
              ttsModelKey,
            )}`;
```

replace both with:

```tsx
            const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${modelKeyForEngineChoice(
              effectiveEngineFor(c),
              ttsModelKey,
              characterQwenTier(c.ttsModelKey),
            )}`;
```

These prefixes must resolve identically to `playSampleFor`'s `effectiveModelKey` or the "is this row's sample playing" check silently stops matching — same character, same three arguments, in both places.

- [ ] **Step 6: Migrate the three `'qwen'`-literal call sites**

`src/modals/voice-readiness-gate.tsx` — line 24 import becomes `import { modelKeyForEngineChoice } from '../lib/tts-models';`, line 74:

```ts
          modelKey: modelKeyForEngineChoice('qwen', ttsModelKey),
```

`src/modals/rebaseline-modal.tsx` — line 49 import becomes `import { modelKeyForEngineChoice } from '../lib/tts-models';`, line 277:

```ts
        modelKey: modelKeyForEngineChoice('qwen', ttsModelKey),
```

`src/components/script-review-diff.tsx` — line 33 import becomes `import { modelKeyForEngineChoice } from '../lib/tts-models';`, line 74:

```ts
        modelKey: modelKeyForEngineChoice('qwen', ttsModelKey),
```

All three previously resolved to a hardcoded `qwen3-tts-0.6b`. They now follow the session tier — so on a 1.7B-default book they audition at 1.7B, matching what that book renders. That is the intended consequence, not an accident: it is the same mismatch as the per-character case, one level up.

- [ ] **Step 7: Delete `sampleModelKeyForEngine`**

In `src/lib/tts-voice-mapping.ts`, delete lines 373-384 (the doc comment and the function). **Keep** `QWEN_MODEL_KEY` at 369-371 and update its comment to drop the dead reference:

```ts
/* The single model key the Qwen bespoke engine routes through by default.
   Mirror of the server's engineForModelKey: any 'qwen…' key maps to engine
   'qwen'. Still used by the emotion-variant player (src/lib/play-emotion-variant.ts).
   To resolve the model key for an AUDITION, use modelKeyForEngineChoice
   (src/lib/tts-models.ts) — it is the single engine→modelKey mapper. */
export const QWEN_MODEL_KEY: TtsModelKey = 'qwen3-tts-0.6b';
```

- [ ] **Step 8: Delete the retired test block**

In `src/lib/tts-voice-mapping.test.ts`, delete the `describe('sampleModelKeyForEngine', …)` block at lines 98-108 and remove `sampleModelKeyForEngine` from the import at line 13. Keep `QWEN_MODEL_KEY` in that import — line 100's replacement now lives in `tts-models.test.ts` (Task 2, Step 1), which asserts the same four cases plus the two the old block never covered.

- [ ] **Step 9: Run the full frontend suite**

Run: `npm run test`
Expected: PASS. Run the WHOLE suite, not just the touched files — `cast.tsx` and `profile-drawer.tsx` are shared surfaces whose sample-URL shape distant view tests assert against.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no remaining references to `sampleModelKeyForEngine`.

- [ ] **Step 11: Commit**

```bash
git add src/views/cast.tsx src/modals/profile-drawer.tsx src/modals/voice-readiness-gate.tsx src/modals/rebaseline-modal.tsx src/components/script-review-diff.tsx src/lib/tts-voice-mapping.ts src/lib/tts-voice-mapping.test.ts src/modals/profile-drawer.test.tsx
git commit -m "fix(frontend): audition in the character's own engine and tier

Routes every audition call site through the single modelKeyForEngineChoice
mapper and deletes the lossy sampleModelKeyForEngine copy.

Closes #1812
Refs #1839"
```

---

### Task 4: Fold the fourth mapper into `canonicalModelKeyForEngine`

`voice-sample.ts:53 defaultModelKeyForEngine` is a fourth engine→modelKey table — the same mapping minus Qwen, used by the raw base-voice branch.

**Files:**
- Modify: `server/src/routes/voice-sample.ts:49-58,117-119`
- Test: `server/src/routes/voice-sample.test.ts`
- Reference (unchanged): `server/src/tts/model-keys.ts:87`

**Interfaces:**
- Consumes: `canonicalModelKeyForEngine(engine: TtsEngine, requestModelKey: TtsModelKey): TtsModelKey` from `server/src/tts/model-keys.ts` (pre-existing).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/voice-sample.test.ts`:

```ts
it('re-picks a matching model key for a raw sample whose request key routes elsewhere', async () => {
  /* A client clicking Play on a Kokoro base voice while the project sits on
     Coqui shouldn't have to re-pick — the server routes via rawEngine. */
  const res = await request(app)
    .post('/api/voices/any-voice/sample')
    .send({ modelKey: 'coqui-xtts-v2', rawEngine: 'kokoro', rawSpeaker: 'af_heart' });

  expect(res.status).toBe(200);
  expect(synthesizeSpy).toHaveBeenCalledWith(
    expect.objectContaining({ modelKey: 'kokoro-v1' }),
  );
});

it('leaves a raw-sample request alone when its key already routes to the requested engine', async () => {
  const res = await request(app)
    .post('/api/voices/any-voice/sample')
    .send({ modelKey: 'gemini-3.1-flash', rawEngine: 'gemini', rawSpeaker: 'Charon' });

  expect(res.status).toBe(200);
  /* canonicalModelKeyForEngine preserves the requested Gemini variant rather
     than flattening it to 2.5 — a behaviour defaultModelKeyForEngine lacked. */
  expect(synthesizeSpy).toHaveBeenCalledWith(
    expect.objectContaining({ modelKey: 'gemini-3.1-flash' }),
  );
});
```

Match the file's existing app/spy setup; if `synthesizeSpy` is named differently there, use the existing name rather than introducing a second harness.

- [ ] **Step 2: Run to verify the second test fails**

Run: `npm run test:server -- server/src/routes/voice-sample.test.ts`
Expected: the first test PASSES (existing behaviour), the second FAILS — `defaultModelKeyForEngine('gemini')` returns `'gemini-2.5-flash'`, flattening the requested 3.1 variant.

- [ ] **Step 3: Implement**

Delete lines 49-58 (`defaultModelKeyForEngine` and its comment). Add `canonicalModelKeyForEngine` to the existing `../tts/index.js` import in the file's import block.

Replace lines 113-119:

```ts
    /* The client may have passed any modelKey it had handy (whatever the
       project's currently set to). Re-pick one that actually routes to the
       requested engine, otherwise selectTtsProvider would send a Coqui
       speaker name to the Gemini provider or vice versa.

       canonicalModelKeyForEngine (../tts/model-keys.ts) is the ONE
       engine→modelKey table on this side of the wire — the frontend mirror is
       modelKeyForEngineChoice (src/lib/tts-models.ts). Unlike the local copy
       this replaced, it preserves the requested Gemini variant instead of
       flattening every Gemini request to 2.5. */
    if (engineForModelKey(modelKey) !== engine) {
      effectiveModelKey = canonicalModelKeyForEngine(engine, modelKey);
    }
```

- [ ] **Step 4: Run to verify both pass**

Run: `npm run test:server -- server/src/routes/voice-sample.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice-sample.ts server/src/routes/voice-sample.test.ts
git commit -m "refactor(server): fold defaultModelKeyForEngine into canonicalModelKeyForEngine

Closes #1812"
```

---

### Task 5: Stop anchoring the "Sampled" tier on the 0.6B literal

With Task 3 landed, an audition can be written as `<scope>-qwen3-tts-1.7b-<hash>.mp3`. `hasCachedQwenSample` tests only the 0.6B prefix, so such a character would silently drop out of the **Sampled** lifecycle tier.

**Files:**
- Modify: `server/src/routes/voices.ts:65-69,244-253`
- Test: `server/src/routes/voices.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of them, but only *matters* once Task 3 lands).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/voices.test.ts`, alongside the existing Sampled-tier coverage:

```ts
it('counts a 1.7B audition as Sampled (#1839)', async () => {
  /* Once auditions follow the character's tier, the cached file is named
     <scope>-qwen3-tts-1.7b-<hash>.mp3. Anchoring the scan on the 0.6B literal
     dropped such a character out of the Sampled tier despite a good audition
     sitting on disk. */
  listVoiceSampleFilesMock.mockReturnValue(['char-vane-qwen3-tts-1.7b-abc123.mp3']);

  const res = await request(app).get('/api/voices');

  const vane = res.body.voices.find((v: { id: string }) => v.id === 'char-vane');
  expect(vane.lifecycle).toBe('sampled');
});
```

Match the file's existing mock names and the exact `lifecycle` field/value the neighbouring Sampled assertions use — read them first rather than assuming this shape.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:server -- server/src/routes/voices.test.ts`
Expected: FAIL — the character does not read as Sampled.

- [ ] **Step 3: Implement**

Replace lines 65-69:

```ts
/* The model keys the bespoke Qwen engine synthesises under — BOTH quality
   tiers (fs-56). Cached auditions are named `<scope>-<modelKey>-<hash>.mp3`
   and an audition now follows the character's own tier (#1839), so the
   `sampled` scan must match either. Mirror of the frontend's
   modelKeyForEngineChoice Qwen arm (src/lib/tts-models.ts). */
const QWEN_SAMPLE_MODEL_KEYS = ['qwen3-tts-0.6b', 'qwen3-tts-1.7b'] as const;
```

Replace the helper at 250-253:

```ts
  const hasCachedQwenSample = (sampleScope: string): boolean =>
    QWEN_SAMPLE_MODEL_KEYS.some((key) =>
      sampleFiles.some((f) => f.startsWith(`${sampleScope}-${key}-`)),
    );
```

Update the comment at 244-248 so its worked example no longer names only the 0.6B key:

```ts
  /* The voice-sample cache is workspace-global (not per-book), so read it
     once. Empty for preset engines — the `sampled` lifecycle tier is
     Qwen-only, matching the `generated` invariant. A character has been
     "Sampled" when a `<scope>-qwen3-tts-{0.6b,1.7b}-*.mp3` audition exists,
     where `scope = voiceId ?? char-<characterId>`. */
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:server -- server/src/routes/voices.test.ts`
Expected: PASS, including the pre-existing 0.6B Sampled assertions.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts
git commit -m "fix(server): count either Qwen tier as a cached audition

Refs #1839"
```

---

### Task 6: Release notes and issue hygiene

**Files:**
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Check the in-progress version section**

Run: `head -40 RELEASE_NOTES.md`
Expected: an in-progress version section at the top. If the most recent section is a *shipped* release rather than an in-progress one, this is the first-PR-after-a-cut bootstrap case — follow CONTRIBUTING.md "Release notes" rather than re-deriving it, and do not invent a version number.

- [ ] **Step 2: Append the technical entry**

To `docs/release-notes-next.md`:

```markdown
- **Voice previews use the character's own engine and quality tier** — the audition
  request now resolves its `modelKey` through the single `modelKeyForEngineChoice`
  mapper instead of the lossy `sampleModelKeyForEngine` copy, which returned the
  book's default key for every non-Qwen engine (so a Kokoro-overridden character in
  a Coqui book previewed in Coqui) and pinned every Qwen preview to 0.6B (forcing a
  second Qwen base resident alongside a 1.7B render). The three `TtsEngine`
  declarations and the four engine→modelKey mappers collapse to one per side.
  (#1812, #1839)
```

- [ ] **Step 3: Append the user-facing line**

To the in-progress version section at the top of `RELEASE_NOTES.md`, in brand voice:

```markdown
- Voice previews now play in the engine and quality you picked for that character — what you hear in the cast list is what you'll hear in the book.
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
Expected: PASS. This is the same battery pre-push runs. Note it typechecks frontend AND server together, so `server/node_modules` must be present in this worktree — it is junctioned; if you see `TS2307: Cannot find module 'express'`, the junction is broken, not the code.

- [ ] **Step 2: Push**

```bash
git push -u origin fix/frontend-audition-engine-tier
```

- [ ] **Step 3: Open the PR**

Title (must match the commit convention or `pr-title-lint.yml` rejects it):

```
fix(frontend,server): audition in the character's own engine and Qwen tier
```

Body keeps the template's `## Summary` / `## Test plan` sections and MUST contain both literal auto-close lines:

```
Closes #1812
Closes #1839
```

- [ ] **Step 4: Mandatory independent review**

Run the `code-review` gate (no `--fix`) per CLAUDE.md's Before-shipping checklist step 9. Effort `medium` — single-concern `fix`, but it spans frontend + server, so treat multi-scope as the tie-breaker toward `medium` rather than `low`. Triage and fold findings before merge.

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| Wrong engine on preview | 3 |
| Wrong Qwen tier / co-residency | 2, 3 |
| `higherQwenTier` as the tier rule | 2 |
| VRAM gate stays at admission | none needed — the spec's decision is to *not* add a frontend gate; Task 3 simply stops overriding the tier, leaving `withCapacityRetry` untouched |
| One `TtsEngine` | 1 |
| One mapper per side | 2 (frontend), 4 (server) |
| "Sampled" tier scan | 5 |
| Release notes | 6 |

No gaps.

**2. Placeholder scan**

The only deliberate soft spots are two "match the file's existing harness" notes (Task 4 Step 1, Task 5 Step 1). These are instructions to read neighbouring tests for their mock/field names rather than invent a parallel harness — a real risk in these two files, whose setups this plan has not read line-by-line. Every assertion they must produce is stated exactly.

**3. Type consistency**

`higherQwenTier`, `characterQwenTier`, and the three-argument `modelKeyForEngineChoice` are defined in Task 2 and used with those exact names and signatures in Task 3. `QWEN_SAMPLE_MODEL_KEYS` is introduced and consumed within Task 5. `canonicalModelKeyForEngine`'s signature in Task 4 matches `server/src/tts/model-keys.ts:87`.
