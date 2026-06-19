# srv-43 — Stable per-voice `voiceUuid` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every designed Qwen voice a stable, immutable `voiceUuid` so two same-named characters in unrelated series no longer collide on the same `voices/qwen/<key>.pt` (silent last-write-wins overwrite).

**Architecture:** Split the one overloaded string (`overrideTtsVoices.qwen.name`) into two roles. `voiceUuid` (a `nanoid` minted at design time, stored on the `Character`) becomes the canonical identity; the on-disk/sidecar **storage key** is derived as `qwen-<voiceUuid>`. `overrideTtsVoices.qwen.name` stays the **human display label** (unchanged) — so display, cross-book dedup, and the voices-view family grouping are untouched. A `qwenStorageKey(...)` resolver returns `qwen-<voiceUuid>` when a uuid is present and falls back to the legacy name when absent, so **existing voices keep working with zero migration** (forward-only).

**Tech Stack:** TypeScript (Node/Express server + Vite/React frontend), Vitest, Python sidecar (pytest), OpenAPI codegen (`npm run openapi:types`), `nanoid` (already a `server/package.json` dep).

**Spec:** `docs/superpowers/specs/2026-06-19-srv-43-voice-uuid-design.md`. **Issue:** [#934](https://github.com/dudarenok-maker/Castwright/issues/934).

## Global Constraints

- **Branch:** `chore/server-srv-43-voice-uuid` (worktree `C:\Claude\Projects\AB-wt-srv43`).
- **Qwen-only.** Coqui / Kokoro / Gemini use shared catalog voices — never touch their paths.
- **Forward-only.** No on-disk migration, no schema bump, no `upgrade-coordinator` wiring. Legacy (no-`voiceUuid`) voices MUST keep resolving to their existing `qwen-<voiceId??id>.pt` via the fallback.
- **`overrideTtsVoices.qwen.name` stays human and UNCHANGED.** It is user-facing (`src/views/cast.tsx:1412`). Never write a `voiceUuid` into it. `cross-book-duplicates.ts`, the voices-view family grouping, and all display surfaces are out of scope.
- **No change to the synthesis pipeline or the sidecar synth contract** — only the voice-mapping resolver changes which string is produced.
- **`voiceUuid` is OPTIONAL** in every type and in OpenAPI (additive; mock fixtures must not break).
- **Mint under `withDesignLock`** so concurrent designs of one character can't mint two uuids.
- Tests are GPU-free: `server/src/routes/qwen-voice.test.ts` mocks `global.fetch` + `selectTtsProvider`/`synthesize`.
- Run `npm run typecheck` and the relevant `cd server && npm run test -- <file>` after each task; `npm run verify` before the final commit.
- Commit-message convention `<type>(<scope>): <subject>`; allowed scopes include `server`, `sidecar`, `openapi`, `frontend`, `docs`.

---

### Task 1: Type plumbing — add optional `voiceUuid` to every voice/character shape

Foundation task: a pure type + schema addition with no behavior change. Verified by `npm run typecheck` (the test for a type-only change). Every later task depends on these fields existing.

**Files:**
- Modify: `openapi.yaml` (`Character` schema ~`:4349`; `Voice` schema ~`:3804`)
- Modify: `src/lib/api-types.ts` (regenerated, do not hand-edit)
- Modify: `server/src/tts/synthesise-chapter.ts:199` (`CastCharacter`)
- Modify: `server/src/tts/voice-mapping.ts` (`VoiceLike`, ~`:34-55`)
- Modify: `server/src/workspace/series-reuse-link.ts:54` (`LinkableCharacter`)
- Modify: `server/src/workspace/library-cast-scan.ts:17` (`LibraryCastCharacter`)
- Modify: `server/src/routes/voice-match.ts:70` (`LibraryVoice`)
- Modify: `server/src/routes/voice-override-linked.ts:47` (`PersistedCharacter`)
- Modify: `server/src/tts/hydrate-reused-voice.ts:33` (`ReuseHydratable`), `:62` (`ResolvedReusedVoice`)
- Modify: `server/src/routes/cast-link-prior.ts:47`

**Interfaces:**
- Produces: an optional `voiceUuid?: string` on every shape above (and `voiceUuid: { type: string }` in the two OpenAPI schemas). Consumed by all later tasks.

- [ ] **Step 1: Add `voiceUuid` to the OpenAPI `Character` schema**

In `openapi.yaml`, directly after the `voiceId` line in the `Character` schema (~`:4349`):

```yaml
        voiceId: { type: string }
        voiceUuid:
          {
            type: string,
            description: 'Immutable per-voice identity (nanoid) minted at design time (srv-43). The on-disk/sidecar storage key derives from it (qwen-<voiceUuid>); overrideTtsVoices.qwen.name stays the human display label. Absent on voices designed before srv-43 (legacy name-keyed fallback).',
          }
        voiceState: { type: string, enum: [generated, tuned, reused, locked] }
```

- [ ] **Step 2: Add `voiceUuid` to the OpenAPI `Voice` schema**

In `openapi.yaml`, in the `Voice` schema `properties` (after the `id` property, ~`:3808`):

```yaml
        voiceUuid:
          {
            type: string,
            description: 'srv-43 — the designed voice''s immutable identity, copied from the source Character. Optional; absent for catalog voices and pre-srv-43 designs.',
          }
```

- [ ] **Step 3: Regenerate API types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` regenerates with `voiceUuid?: string` on `Character` and `Voice`. Do not hand-edit.

- [ ] **Step 4: Add `voiceUuid?: string` to the server character/voice interfaces**

`server/src/tts/synthesise-chapter.ts` — in `interface CastCharacter`, immediately after `voiceId?: string;` (`:199`):

```typescript
  voiceId?: string;
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time.
      The Qwen storage key derives from it (qwen-<voiceUuid>); absent on
      voices designed before srv-43 (legacy name-keyed fallback). */
  voiceUuid?: string;
```

Add the same `voiceUuid?: string;` line next to the existing `voiceId?: string` (or, for `VoiceLike`/`LibraryVoice`, next to the comparable identity field) in: `voice-mapping.ts` `VoiceLike`, `series-reuse-link.ts` `LinkableCharacter`, `library-cast-scan.ts` `LibraryCastCharacter`, `voice-match.ts` `LibraryVoice` (add `voiceUuid?: string;`), `voice-override-linked.ts` `PersistedCharacter`, `hydrate-reused-voice.ts` `ReuseHydratable` **and** `ResolvedReusedVoice`, and `cast-link-prior.ts` local character type.

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (no errors). Confirms every interface accepts the new optional field and the regenerated `api-types.ts` is consistent.

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts server/src
git commit -m "fix(openapi,server): add optional voiceUuid to Character/Voice shapes (srv-43)"
```

---

### Task 2: Synth-key resolution in `voice-mapping.ts`

Make the synth path produce `qwen-<voiceUuid>` (falling back to the stored name) instead of returning the display name verbatim. This is the change that routes generation at the new `.pt`.

**Files:**
- Modify: `server/src/tts/voice-mapping.ts` (`pickVoiceForEngine` ~`:243-269`, `pickEmotionVariantVoice` ~`:17-32`)
- Modify: `server/src/tts/synthesise-chapter.ts` (`toVoiceLike` ~`:623-631`) — **load-bearing: see Step 4a**
- Test: `server/src/tts/voice-mapping.test.ts`, `server/src/tts/synthesise-chapter.test.ts`

**Interfaces:**
- Produces: `pickVoiceForEngine('qwen', voice)` returns `qwen-${voice.voiceUuid}` when `voiceUuid` is set and the voice is designed; the stored `overrideTtsVoices.qwen.name` (or the legacy singular `overrideTtsVoice.name`) when designed without a uuid; `''` when undesigned. `pickEmotionVariantVoice` derives the variant key as `${baseVoice}__${emotion}` from the (already resolved) base storage key. `toVoiceLike` now carries `voiceUuid` through to the resolver.

> **BLOCKER caught in plan review:** `toVoiceLike` (`synthesise-chapter.ts:623`) builds the `VoiceLike` that EVERY synth-time `pickVoiceForEngine` call consumes (generation `:730/:807/:874`, `applyQwenFallback`, and `character-snapshots.ts:33`). It currently copies `id`/`character`/`attributes`/`overrideTtsVoices`/`overrideTtsVoice` but **not** `voiceUuid`. Without Step 4a, the resolver below sees `undefined` in production → falls back to the legacy name → loads the wrong `.pt` → **every newly-designed voice plays nothing**, while the unit tests (which construct `VoiceLike` directly) stay green. Step 4a is mandatory.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/tts/voice-mapping.test.ts`:

```typescript
import { pickVoiceForEngine, pickEmotionVariantVoice } from './voice-mapping.js';

describe('srv-43 qwen storage key', () => {
  it('returns qwen-<voiceUuid> for a designed voice that has a uuid', () => {
    const voice = {
      id: 'wren',
      voiceUuid: 'V1StGXR8Z5',
      overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
    };
    expect(pickVoiceForEngine('qwen', voice)).toBe('qwen-V1StGXR8Z5');
  });

  it('falls back to the stored name for a legacy designed voice (no uuid)', () => {
    const voice = { id: 'wren', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } };
    expect(pickVoiceForEngine('qwen', voice)).toBe('qwen-wren');
  });

  it('returns empty string for an undesigned qwen character', () => {
    expect(pickVoiceForEngine('qwen', { id: 'wren' })).toBe('');
  });

  it('derives the emotion-variant key from the resolved base storage key', () => {
    expect(
      pickEmotionVariantVoice('qwen', { angry: { name: 'ignored-legacy-name' } }, 'angry', 'qwen-V1StGXR8Z5'),
    ).toBe('qwen-V1StGXR8Z5__angry');
  });

  it('resolves a uuid-backed qwen designed voice via the legacy singular field too', () => {
    const voice = {
      id: 'wren',
      voiceUuid: 'V1StGXR8Z5',
      overrideTtsVoice: { engine: 'qwen' as const, name: 'qwen-wren' },
    };
    expect(pickVoiceForEngine('qwen', voice)).toBe('qwen-V1StGXR8Z5');
  });
});
```

Add to `server/src/tts/synthesise-chapter.test.ts` a SYNTH-PATH test (this is the one that would catch the `toVoiceLike` blocker — the unit tests above never exercise `toVoiceLike`):

```typescript
it('toVoiceLike carries voiceUuid so generation resolves qwen-<uuid>', () => {
  const c = { id: 'wren', voiceUuid: 'V1StGXR8Z5', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } };
  expect(pickVoiceForEngine('qwen', toVoiceLike(c as never))).toBe('qwen-V1StGXR8Z5');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm run test -- voice-mapping.test.ts`
Expected: FAIL (current code returns `qwen-wren` / the variant's stored `name`, not the uuid-derived keys).

- [ ] **Step 3: Add the qwen storage-key branch to `pickVoiceForEngine`**

In `voice-mapping.ts`, replace the opening of `pickVoiceForEngine` (the generic slot return at `:248-249` plus the later qwen `''` at `:263`) so qwen is handled first:

```typescript
export function pickVoiceForEngine(
  engine: TtsEngine,
  voice: VoiceLike,
  hint?: CharacterHint,
): string {
  /* srv-43 — Qwen is bespoke (no catalog). A designed voice resolves to its
     STORAGE key, not the human display name: qwen-<voiceUuid> when a uuid was
     minted (post-srv-43), else the stored name (legacy fallback). Undesigned
     → '' (cast view shows "no voice designed yet"). Handle before the generic
     slot return so the uuid path wins. */
  if (engine === 'qwen') {
    /* Preserve the legacy singular `overrideTtsVoice` fallback too — a qwen
       voice carrying only the un-normalised singular field must still count as
       designed (matches the generic path's :250-256 behavior). */
    const designedName =
      voice.overrideTtsVoices?.qwen?.name ??
      (voice.overrideTtsVoice?.engine === 'qwen' ? voice.overrideTtsVoice.name : undefined);
    if (!designedName) return '';
    return voice.voiceUuid ? `qwen-${voice.voiceUuid}` : designedName;
  }

  const slotName = voice.overrideTtsVoices?.[engine]?.name;
  if (slotName) return slotName;
  // ... (unchanged: legacy overrideTtsVoice, then profile inference)
```

Delete the now-dead `if (engine === 'qwen') return '';` line further down (`:263`). (Verified safe in plan review: the early branch returns for all qwen cases, so the catalog path — which would otherwise fall through to Coqui's table — is unreachable for qwen; non-qwen engines bypass the new branch entirely.)

- [ ] **Step 4a (BLOCKER fix): Populate `voiceUuid` in `toVoiceLike`**

In `server/src/tts/synthesise-chapter.ts`, the `toVoiceLike` return (~`:623-631`) lists fields explicitly. Add `voiceUuid`:

```typescript
  return {
    id: c.voiceId ?? c.id,
    character: c.name,
    attributes: c.attributes,
    overrideTtsVoices: c.overrideTtsVoices,
    overrideTtsVoice: c.overrideTtsVoice,
    voiceUuid: c.voiceUuid,
  };
```

(Match the real field list in the file — the point is adding `voiceUuid: c.voiceUuid`.) Without this, generation, `applyQwenFallback`, and `character-snapshots.ts:33` all resolve the wrong key for uuid-backed voices.

- [ ] **Step 4: Derive the variant key from the base in `pickEmotionVariantVoice`**

Replace the variant lookup (`:28-31`) so the variant key derives from the resolved base storage key instead of the stored variant name:

```typescript
  if (engine !== 'qwen') return baseVoice;
  if (!emotion || emotion === 'neutral') return baseVoice;
  /* srv-43 — derive the variant storage key from the (already uuid-resolved)
     base; a designed variant slot only signals PRESENCE. Missing → base. */
  return variants?.[emotion] ? `${baseVoice}__${emotion}` : baseVoice;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npm run test -- voice-mapping.test.ts`
Expected: PASS. Also run the full file's pre-existing tests — they must stay green.

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/voice-mapping.ts server/src/tts/voice-mapping.test.ts
git commit -m "fix(server): resolve qwen synth key from voiceUuid (srv-43)"
```

---

### Task 3: Storage-key resolver in `qwen-voice.ts` routes

Route every file/key consumer in the routes through a `qwenStorageKey(character, characterId)` resolver. Behavior-preserving for legacy voices (no uuid → unchanged); diverges only once a uuid exists (Task 4).

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (`deriveQwenVoiceId` stays; add `qwenStorageKey`; `designQwenVoiceForCharacter:265`, `persistEmotionVariant:141`, `designed-persona:224`, `promote-voice:548`, `discard-voice:642`, `delete-variant:703`)
- Modify: `server/src/tts/verify-designed-voice-language.ts` (~`:30-33`) — **BLOCKER, see Step 4b**
- Test: `server/src/routes/qwen-voice.test.ts`, `server/src/tts/verify-designed-voice-language.test.ts`

**Interfaces:**
- Produces: `export function qwenStorageKey(character: CastCharacter, characterId: string): string` → `character.voiceUuid ? 'qwen-' + character.voiceUuid : deriveQwenVoiceId(character, characterId)`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/qwen-voice.test.ts`:

```typescript
import { qwenStorageKey, deriveQwenVoiceId } from './qwen-voice.js';

describe('srv-43 qwenStorageKey', () => {
  it('derives the storage key from voiceUuid when present', () => {
    const c = { id: 'wren', voiceId: 'wren', voiceUuid: 'V1StGXR8Z5' };
    expect(qwenStorageKey(c, 'wren')).toBe('qwen-V1StGXR8Z5');
  });

  it('falls back to deriveQwenVoiceId when no voiceUuid (legacy)', () => {
    const c = { id: 'wren', voiceId: 'wren' };
    expect(qwenStorageKey(c, 'wren')).toBe(deriveQwenVoiceId(c, 'wren'));
    expect(qwenStorageKey(c, 'wren')).toBe('qwen-wren');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test -- qwen-voice.test.ts -t "qwenStorageKey"`
Expected: FAIL with "qwenStorageKey is not a function".

- [ ] **Step 3: Add the resolver next to `deriveQwenVoiceId`**

In `qwen-voice.ts`, immediately after `deriveQwenVoiceId` (`:89-91`):

```typescript
/* srv-43 — the on-disk/sidecar STORAGE key for a character's bespoke voice.
   Prefers the immutable voiceUuid (globally unique → no cross-series collision);
   falls back to the legacy name-derived key for voices designed before srv-43.
   deriveQwenVoiceId stays the HUMAN display label written into qwen.name. */
export function qwenStorageKey(character: CastCharacter, characterId: string): string {
  return character.voiceUuid ? `qwen-${character.voiceUuid}` : deriveQwenVoiceId(character, characterId);
}
```

- [ ] **Step 4: Route the file/key consumers through it**

Replace `deriveQwenVoiceId(character, characterId)` / `deriveQwenVoiceId(p.character, p.characterId)` with `qwenStorageKey(...)` at exactly these sites (leave the `qwen.name` display writes alone):
- `designQwenVoiceForCharacter:265` — `const baseVoiceId = qwenStorageKey(p.character, p.characterId);`
- `persistEmotionVariant:141` — `const baseVoiceId = qwenStorageKey(character, characterId);`
- `designed-persona:224` — `const voiceName = qwenStorageKey(character, characterId);` (the sidecar `.json` lives at the storage key, not the display name)
- `promote-voice:548` — `const realVoiceId = qwenStorageKey(character, characterId);`
- `discard-voice:642` — `const expectedPreview = previewVoiceIdFor(qwenStorageKey(character, characterId));`
- `delete-variant:703` — `const designedId = `${qwenStorageKey(character, characterId)}__${emotion}`;`

- [ ] **Step 4b (BLOCKER fix): Route `verify-designed-voice-language.ts` through `qwenStorageKey`**

`server/src/tts/verify-designed-voice-language.ts` `clearMismatchedDesignedVoices` (~`:30-33`) reads the manifest by the **human name** — `const designedName = c.overrideTtsVoices?.qwen?.name;` then `qwenVoiceSidecarPath(designedName)`. For a uuid-backed voice the manifest lives at `qwen-<uuid>.json`, so this reads `qwen-wren.json` → miss → it concludes "language mismatch" and **deletes `c.overrideTtsVoices.qwen`** (treats a correctly-designed voice as undesigned), and the `forbidKokoroFallback` gate then blocks generation. Runs on full-generate AND fs-26 splice re-record for every non-English book. Fix: resolve the manifest path via the storage key.

```typescript
// import { qwenStorageKey } from '../routes/qwen-voice.js';
const designedName = qwenStorageKey(c, c.id);          // was: c.overrideTtsVoices?.qwen?.name
if (!designedName) continue;                           // keep the existing undesigned guard
const manifest = await readJson<{ language?: string }>(qwenVoiceSidecarPath(designedName)).catch(() => null);
```

Confirm the existing "no qwen voice → skip" guard still holds: `qwenStorageKey` returns a non-empty string even for undesigned characters, so gate the language check on the character actually having a qwen override (`if (!c.overrideTtsVoices?.qwen?.name && !c.voiceUuid) continue;`) before resolving the path — preserve the current "only check designed voices" behavior. Add a regression case to `verify-designed-voice-language.test.ts`: a uuid-backed voice with a matching-language manifest at `qwen-<uuid>.json` is NOT cleared.

- [ ] **Step 5: Write a route-level fallback test**

Add a test that a designed character WITHOUT a `voiceUuid` still designs to `qwen-<voiceId>.pt` (legacy behavior unchanged), and one WITH a pre-set `voiceUuid` designs to `qwen-<uuid>.pt`. Use the existing mocked-fetch harness in this file (see `:54-66,110,177` for the fetch/`writeFile` mock pattern); assert on the `.pt` path passed to the write.

```typescript
it('legacy character (no voiceUuid) designs at qwen-<voiceId>.pt', async () => {
  // ...arrange a confirmed cast character { id:'wren', voiceId:'wren' } with no voiceUuid,
  // call designQwenVoiceForCharacter, assert the written .pt path ends with 'qwen-wren.pt'.
});
it('character with voiceUuid designs at qwen-<uuid>.pt', async () => {
  // ...same but voiceUuid:'V1StGXR8Z5'; assert the path ends with 'qwen-V1StGXR8Z5.pt'.
});
```

- [ ] **Step 6: Run the tests**

Run: `cd server && npm run test -- qwen-voice.test.ts`
Expected: PASS (including the file's pre-existing tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): route qwen .pt/key consumers through qwenStorageKey (srv-43)"
```

---

### Task 4: Mint + persist `voiceUuid` at design time

The load-bearing correctness task. Mint a uuid onto the character (and its linked siblings) and persist it **before** the design core names the `.pt`. Wire into both design entry points. After this, fresh designs are collision-free.

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (import `nanoid`; add `ensureCharacterVoiceUuid`; call it in the single-design route before `designQwenVoiceForCharacter`, ~`:479`)
- Modify: `server/src/routes/cast-design.ts` (call it before `designQwenVoiceForCharacter`, ~`:242`)
- Test: `server/src/routes/qwen-voice.test.ts`

**Interfaces:**
- Consumes: `forEachMatchingCastCharacter` (from `voices.ts`), `qwenStorageKey` (Task 3), `withDesignLock`.
- Produces: `export async function ensureCharacterVoiceUuid(bookDir: string, characterId: string, seriesFilter?: { author: string; series: string }): Promise<string | undefined>` — idempotently mints + persists + stamps siblings; returns the uuid (or `undefined` for an unknown character).

- [ ] **Step 1: Write the failing tests (headline collision regression)**

Add to `server/src/routes/qwen-voice.test.ts`:

```typescript
describe('srv-43 mint + collision regression', () => {
  it('mints a voiceUuid on the character and persists it', async () => {
    // arrange a confirmed standalone cast with character { id:'wren', voiceId:'wren' }, no voiceUuid
    const uuid = await ensureCharacterVoiceUuid(bookDir, 'wren');
    expect(uuid).toMatch(/.+/);
    const cast = await readCast(bookDir);
    expect(cast.characters.find((c) => c.id === 'wren')!.voiceUuid).toBe(uuid);
  });

  it('is idempotent — a second call returns the same uuid, no re-mint', async () => {
    const a = await ensureCharacterVoiceUuid(bookDir, 'wren');
    const b = await ensureCharacterVoiceUuid(bookDir, 'wren');
    expect(b).toBe(a);
  });

  it('two same-named characters in different series get distinct .pt paths (collision regression)', async () => {
    // arrange two standalone books each with character {id:'wren', voiceId:'wren'}.
    // Spy on torch-save / the .pt write (the mocked-fetch harness already intercepts
    // the sidecar PCM response and the file write — see :54-66,110,177). DESIGN BOTH
    // characters end-to-end and capture the .pt path each design writes.
    const ptA = await designAndCapturePtPath(bookDirA, 'wren'); // helper: runs the design route, returns qwenVoicePtPath written
    const ptB = await designAndCapturePtPath(bookDirB, 'wren');
    expect(ptA).not.toBe(ptB);                 // <-- the real regression assertion (fails on main: both 'qwen-wren.pt')
    expect(ptA).toMatch(/qwen-.+\.pt$/);
  });
});
```

> **Plan-review note:** the earlier draft of this test only asserted `u1 !== u2`, which merely proves `nanoid()` is random — it does NOT exercise `qwenStorageKey` or the `.pt` write, so it would pass on `main` and catch nothing. The marquee regression MUST design both characters and assert the two written `.pt` paths differ (on `main` both resolve to `qwen-wren.pt` → the assertion fails, proving the regression is real).

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npm run test -- qwen-voice.test.ts -t "mint"`
Expected: FAIL with "ensureCharacterVoiceUuid is not a function".

- [ ] **Step 3: Import `nanoid` and add `ensureCharacterVoiceUuid`**

In `qwen-voice.ts` imports (after `:44`):

```typescript
import { nanoid } from 'nanoid';
```

Add (near `persistEmotionVariant`, mirroring its series/book-scope structure):

```typescript
/* srv-43 — ensure a character has an immutable voiceUuid BEFORE its bespoke
   voice is designed (the .pt is named from qwenStorageKey, which reads the
   uuid). Idempotent: returns the existing uuid untouched. Mints under the
   per-book design lock so two concurrent designs of one character can't mint
   two uuids. Stamps the SAME uuid onto every linked-cast sibling (matching
   voiceId ?? id) so a series-shared voice keeps one identity — series-scoped
   when seriesFilter is given (mirrors persistEmotionVariant), else book-scoped.
   Returns undefined for an unknown character. */
export async function ensureCharacterVoiceUuid(
  bookDir: string,
  characterId: string,
  seriesFilter?: { author: string; series: string },
): Promise<string | undefined> {
  return withDesignLock(bookDir, async () => {
    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!cast || !character) return undefined;
    if (character.voiceUuid) return character.voiceUuid;

    const uuid = nanoid();
    const stamp = (c: CastCharacter): CastCharacter => ({ ...c, voiceUuid: uuid });

    if (seriesFilter) {
      await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, stamp);
      return uuid;
    }
    /* Book-scoped — stamp every character in THIS book sharing the linked id. */
    const linkId = character.voiceId ?? character.id;
    let dirty = false;
    for (let i = 0; i < cast.characters.length; i++) {
      if ((cast.characters[i].voiceId ?? cast.characters[i].id) === linkId) {
        cast.characters[i] = stamp(cast.characters[i]);
        dirty = true;
      }
    }
    if (dirty) await writeJsonAtomic(castJsonPath(bookDir), cast);
    return uuid;
  });
}
```

(`CastFile`/`readJson`/`writeJsonAtomic`/`castJsonPath` are already imported, `forEachMatchingCastCharacter` is imported at `:45`, and `nanoid@^5.0.7` is in `server/package.json`.)

> **Do NOT move this call inside `designQwenVoiceForCharacter`.** That function already runs inside `withDesignLock(p.bookDir, …)`, and `withDesignLock` is a per-book promise chain (not re-entrant) — minting inside it would self-deadlock. The plan correctly mints in the route/bulk caller *before* invoking the design core (two sequential lock acquisitions, never nested).

- [ ] **Step 4: Wire into the single-design route**

In the design-voice route, before the `designQwenVoiceForCharacter(...)` call (~`:480`), mint + re-read so the character passed to the core carries the uuid. Use the same series scope the variant path computes (`:498-499`):

```typescript
    const isStandalone = located.state?.isStandalone === true;
    const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
    /* srv-43 — mint/persist voiceUuid before the core names the .pt. */
    const voiceUuid = await ensureCharacterVoiceUuid(bookDir, characterId, seriesInfo ?? undefined);
    const characterForDesign: CastCharacter = { ...character, voiceUuid: voiceUuid ?? character.voiceUuid };
    try {
      const { voiceId, url } = await designQwenVoiceForCharacter({
        bookDir,
        character: characterForDesign,
        // ...rest unchanged
```

**Hoist explicitly:** `isStandalone`/`seriesInfo` are currently declared *inside* the `if (emotion && body.preview !== true)` block (`:498-499`). Move both declarations up to here (before the design call) and **delete the inner declarations**, so the variant `persistEmotionVariant` call reuses these — not a recompute. (Inner-block scoping means leaving them wouldn't fail to compile, but it's a redundant second `findAuthorSeriesForBookId` call.)

- [ ] **Step 5: Wire into the `cast-design.ts` bulk job**

In `cast-design.ts`, before the `designQwenVoiceForCharacter({...})` call (~`:242`):

```typescript
      const voiceUuid = await ensureCharacterVoiceUuid(job.bookDir, characterId, seriesFilter);
      const characterForDesign = { ...character, voiceUuid: voiceUuid ?? character.voiceUuid };
      const { voiceId } = await designQwenVoiceForCharacter({
        bookDir: job.bookDir,
        character: characterForDesign,
        // ...rest unchanged
```

Import `ensureCharacterVoiceUuid` from `./qwen-voice.js`.

- [ ] **Step 6: Run the tests**

Run: `cd server && npm run test -- qwen-voice.test.ts`
Expected: PASS (collision regression green; pre-existing tests green).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/cast-design.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): mint+persist voiceUuid at design time, both entry points (srv-43)"
```

---

### Task 5: Propagate `voiceUuid` through series reuse

So two books in a series share ONE voice (one uuid, one `.pt`): copy the source voice's `voiceUuid` onto the reused character. Requires the reuse candidate to expose it.

**Files:**
- Modify: `server/src/workspace/series-reuse-link.ts` — **its OWN `projectVoice` (~`:96-113`) is the REQUIRED edit** (it builds the `priorVoices`/`best.voice` the `:309` stamp reads); the link stamp at `:309`; the `clearStaleLink` revert at `:156-166`
- Modify: `server/src/routes/voice-match.ts` (`projectLibraryVoice:82`) — separate path (the voice-match route); update for that route's consistency, but it is NOT what makes the `:309` test pass
- Modify: `server/src/tts/hydrate-reused-voice.ts` (`resolveReusedVoiceFields` carries `voiceUuid` for the denormalise path)
- Test: `server/src/workspace/series-reuse-link.test.ts`

**Interfaces:**
- Consumes: `LibraryVoice.voiceUuid` (Task 1).
- Produces: a reused character ends with `c.voiceUuid === best.voice.voiceUuid`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/workspace/series-reuse-link.test.ts` a case: an earlier book in a series has a confirmed character `{ id:'wren', voiceId:'wren', voiceUuid:'U1', overrideTtsVoices:{qwen:{name:'qwen-wren'}} }`; a later book has a fresh `{ id:'wren' }`. After `linkSeriesReuse(...)`, assert the later book's `wren` has `voiceUuid === 'U1'`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test -- series-reuse-link.test.ts -t "voiceUuid"`
Expected: FAIL (`voiceUuid` is `undefined` on the reused row).

- [ ] **Step 3: Copy `voiceUuid` into the projection(s)**

In `voice-match.ts` `projectLibraryVoice` (`:86-98`), add to the returned object:

```typescript
  return {
    voiceId,
    voiceUuid: c.voiceUuid,
    // ...rest unchanged
  };
```

Apply the identical `voiceUuid: c.voiceUuid` addition to the `projectVoice` function inside `series-reuse-link.ts` (~`:96-113`) that builds `priorVoices` — **this is the one the `:309` stamp actually reads**, so it's required for Step 1's test to pass. The `voice-match.ts` edit is for the separate voice-match route.

- [ ] **Step 4: Stamp the uuid on the reused character**

In `series-reuse-link.ts`, right after the existing `c.voiceId = best.voice.voiceId;` (`:309`):

```typescript
    c.voiceId = best.voice.voiceId;
    /* srv-43 — inherit the source voice's immutable identity so both books
       share one uuid → one .pt (the intended reuse). */
    if (best.voice.voiceUuid) c.voiceUuid = best.voice.voiceUuid;
```

- [ ] **Step 5: Carry `voiceUuid` through `resolveReusedVoiceFields`**

In `hydrate-reused-voice.ts`, add `voiceUuid` to `ResolvedReusedVoice` (Task 1 added the optional field) and populate it in the resolve return (`:101-104`):

```typescript
    if (hasOwnQwenVoice(source)) {
      return {
        ttsEngine: source.ttsEngine ?? 'qwen',
        overrideTtsVoices: source.overrideTtsVoices ?? {},
        voiceStyle: source.voiceStyle,
        voiceUuid: source.voiceUuid,
      };
    }
```

And in `series-reuse-link.ts`'s `resolveReusedVoiceFields` consumer (`:335-338`), carry it onto `c`:

```typescript
      if (resolved) {
        c.ttsEngine = c.ttsEngine ?? resolved.ttsEngine ?? null;
        c.overrideTtsVoices = { ...resolved.overrideTtsVoices, ...(c.overrideTtsVoices ?? {}) };
        c.voiceStyle = c.voiceStyle ?? resolved.voiceStyle;
        c.voiceUuid = c.voiceUuid ?? resolved.voiceUuid;
      }
```

- [ ] **Step 5b (MAJOR fix): Clear `voiceUuid` on a stale-link revert**

`series-reuse-link.ts` `clearStaleLink` (~`:156-166`) deletes `voiceId`/`overrideTtsVoices`/`voiceStyle`/`ttsEngine` when a prior link no longer holds — but **not `voiceUuid`**. A reverted character would keep the old shared uuid, and the next design hits `ensureCharacterVoiceUuid`'s idempotent "already has uuid → reuse" path → writes into the OLD shared `.pt` → re-introduces the exact cross-identity collision srv-43 prevents. Add the delete alongside the others:

```typescript
    delete c.voiceId;
    delete c.voiceUuid;          // srv-43 — drop the inherited identity on unlink
    delete c.overrideTtsVoices;
    // ...rest unchanged
```

Add a test: a character whose link is cleared loses `voiceUuid`, and a subsequent `ensureCharacterVoiceUuid` mints a FRESH one (not the old shared value).

- [ ] **Step 6: Run the tests**

Run: `cd server && npm run test -- series-reuse-link.test.ts hydrate-reused-voice.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/voice-match.ts server/src/workspace/series-reuse-link.ts server/src/tts/hydrate-reused-voice.ts server/src/workspace/series-reuse-link.test.ts
git commit -m "fix(server): propagate voiceUuid through series reuse (srv-43)"
```

---

### Task 6: Preserve `voiceUuid` on reparse, override-save, and snapshots

Three "carry the uuid through a cast mutation" guarantees. Each has a focused test.

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts:33` (`PRESERVED_VOICE_FIELDS`)
- Modify: `server/src/audio/character-snapshots.ts:38`
- Verify (likely no change): `server/src/routes/voices.ts` `applyOverrideToCastFiles` preserves it via the spread + `normaliseCastCharacter`
- Test: `server/src/store/merge-analysis-cast.test.ts`, `server/src/routes/voices.test.ts`

- [ ] **Step 1: Write the failing tests**

`merge-analysis-cast.test.ts`: a prior character with `voiceUuid:'U1'` survives a reparse/merge (assert the merged record still has `voiceUuid:'U1'`).
`voices.test.ts`: a cast with two linked characters both carrying `voiceUuid:'U1'`; after `applyOverrideToCastFiles('wren', {engine:'qwen', name:'qwen-wren'})`, both still have `voiceUuid:'U1'` (override-save must not strip it).

- [ ] **Step 2: Run to verify they fail / confirm baseline**

Run: `cd server && npm run test -- merge-analysis-cast.test.ts voices.test.ts -t "voiceUuid"`
Expected: the merge test FAILS (field stripped); the `applyOverrideToCastFiles` test may already pass if the spread preserves it — if so, it's a regression guard (keep it).

- [ ] **Step 3: Add `voiceUuid` to `PRESERVED_VOICE_FIELDS`**

`merge-analysis-cast.ts:32`:

```typescript
export const PRESERVED_VOICE_FIELDS = [
  'voiceId',
  'voiceUuid',
  'voiceState',
  // ...rest unchanged
] as const;
```

- [ ] **Step 4: Snapshot the uuid**

`character-snapshots.ts`, in the snapshot object (`:34-49`), after `voiceId: c.voiceId,`:

```typescript
      voiceId: c.voiceId,
      voiceUuid: c.voiceUuid,
```

Add `voiceUuid?: string;` to the `CharacterSnapshot` type if it explicitly lists fields.

- [ ] **Step 5: Confirm `applyOverrideToCastFiles` preserves `voiceUuid` (regression guard — plan review verified it already does)**

Plan review confirmed `normaliseCastCharacter` (`:130-143`) returns either `c` or a `{ ...c, ... }` **spread** (not an allowlist), and `applyOverrideToCastFiles`'s `replacement: CastCharacter = { ...normalised }` (`:614`) preserves the field. So the override-save test from Step 1 should PASS as-is — keep it as a regression guard. **No code change expected here**; only if the test unexpectedly fails, check whether `normaliseCastCharacter` was changed to an allowlist and add `voiceUuid` there.

- [ ] **Step 6: Run the tests**

Run: `cd server && npm run test -- merge-analysis-cast.test.ts voices.test.ts character-snapshots.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/store/merge-analysis-cast.ts server/src/audio/character-snapshots.ts server/src/routes/voices.ts server/src/store/merge-analysis-cast.test.ts server/src/routes/voices.test.ts
git commit -m "fix(server): preserve voiceUuid across reparse, override-save, snapshots (srv-43)"
```

---

### Task 7: Converge `voiceUuid` on manual unify (approve-duplicate)

When the user declares two separately-designed voices the same, point both at the **canonical** voice's uuid (the other `.pt` then orphans, correctly).

**Files:**
- Modify: `server/src/routes/voice-override-linked.ts` (`applyToBook:169-195`; thread the canonical uuid from the caller)
- Test: `server/src/routes/voice-override-linked.test.ts`

**Interfaces:**
- Produces: `applyToBook(bookDir, ids, canonicalVoiceId, canonicalVoiceUuid, override)` — sets `voiceUuid = canonicalVoiceUuid` on every unified row.

- [ ] **Step 1: Write the failing test**

`voice-override-linked.test.ts`: two characters with different uuids (`U1`, `U2`) declared the same with canonical `U1`; after the route runs, both rows have `voiceUuid:'U1'`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test -- voice-override-linked.test.ts -t "voiceUuid"`
Expected: FAIL (the non-canonical row keeps `U2`).

- [ ] **Step 3: Thread + set the canonical uuid**

Add a `canonicalVoiceUuid: string | undefined` parameter to `applyToBook` and set it in the mapped row (`:182`):

```typescript
    const next: PersistedCharacter = { ...c, voiceId: canonicalVoiceId };
    if (canonicalVoiceUuid) next.voiceUuid = canonicalVoiceUuid;
```

At the call site, the canonical character is **already in hand** — `voice-override-linked.ts` reads `source` (~`:92`) and derives `canonicalVoiceId = source.voiceId ?? source.id` (~`:99`). So pass `source.voiceUuid` straight into `applyToBook`; no new cast.json read is needed. (`PersistedCharacter` gained `voiceUuid` in Task 1.)

- [ ] **Step 4: Run the test**

Run: `cd server && npm run test -- voice-override-linked.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice-override-linked.ts server/src/routes/voice-override-linked.test.ts
git commit -m "fix(server): converge voiceUuid to canonical on manual unify (srv-43)"
```

---

### Task 8: Persist `voiceUuid` in the sidecar descriptor (inert)

Satisfy the issue's acceptance (uuid in the sidecar voice descriptor). Inert/forward-looking — nothing keys on it.

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (add `voiceUuid` to the `/qwen/design-voice` request body, `:313-318`)
- Modify: `server/tts-sidecar/main.py` (`design_voice` accepts `voiceUuid`; write it to the descriptor `:1571-1578`)
- Test: `server/tts-sidecar/tests/test_kokoro.py` or `test_synthesize.py` (a `design_voice` descriptor round-trip)

- [ ] **Step 1: Write the failing pytest**

In the sidecar tests, design a voice with a `voiceUuid` in the request and assert the written `<voiceId>.json` descriptor contains `"voiceUuid": "<that value>"`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:sidecar` (skips with a banner if the venv isn't bootstrapped — in that case note it and verify the Node side only).
Expected: FAIL (descriptor has no `voiceUuid`).

- [ ] **Step 3: Send `voiceUuid` from the server**

`qwen-voice.ts` design body (`:313-318`):

```typescript
            body: JSON.stringify({
              voiceId,
              voiceUuid: p.character.voiceUuid ?? null,
              instruct: instructForDesign,
              language: p.language,
              calibrationText,
            }),
```

- [ ] **Step 4: Write it in the sidecar descriptor (THREE spots — `design_voice` is a typed positional method, NOT a `payload` dict)**

In `main.py`, `QwenEngine.design_voice` (`:1493`) has the signature `(voice_id, instruct, language, calibration_text)` — there is **no `payload`** in scope. The HTTP route `qwen_design_voice` (`:3172`) parses the request dict and calls the method **positionally** via `asyncio.to_thread(...)` (`:3211-3217`). So make three coordinated changes:

(a) In the route `qwen_design_voice` (~`:3186`, where it does `body.get("voiceId")`), extract the new field:

```python
    voice_uuid = body.get("voiceUuid")
```

(b) Pass it as a new positional/keyword arg in the `asyncio.to_thread` call (`:3211-3217`):

```python
    await asyncio.to_thread(qwen.design_voice, voice_id, instruct, language, calibration_text, voice_uuid)
```

(c) Add the parameter to the method signature (`:1493`) and write it into the descriptor dict (`:1571-1578`):

```python
    def design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid=None):
        # ...
                    {
                        "voiceId": voice_id,
                        "voiceUuid": voice_uuid,
                        "instruct": instruct,
                        "language": lang,
                        "refText": ref_text,
                        "baseModel": self.BASE_MODEL,
                        "designModel": self.VOICEDESIGN_MODEL,
                    },
```

(Default `voice_uuid=None` keeps any other caller / older request body working — the field is inert.)

- [ ] **Step 5: Run the pytest**

Run: `npm run test:sidecar`
Expected: PASS (or SKIP banner on an unbootstrapped venv — then the Node-side body change is covered by typecheck).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/tts-sidecar/main.py server/tts-sidecar/tests
git commit -m "fix(sidecar,server): persist inert voiceUuid in the voice descriptor (srv-43)"
```

---

### Task 9: Surface `voiceUuid` on the derived `Voice` (API honesty)

The voices aggregator copies `c.voiceUuid` onto each derived `Voice` so the API matches the OpenAPI schema (no v1 frontend consumer, but keeps the contract honest and future cross-book features ready).

**Files:**
- Modify: `server/src/routes/voices.ts` (the voices aggregator, ~`:335-361`)
- Test: `server/src/routes/voices.test.ts`

- [ ] **Step 1: Write the failing test**

`voices.test.ts`: a confirmed cast character with `voiceUuid:'U1'` → the derived `Voice` from the voices list endpoint has `voiceUuid:'U1'`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test -- voices.test.ts -t "voiceUuid"`
Expected: FAIL (derived `Voice` has no `voiceUuid`).

- [ ] **Step 3: Copy the field in the aggregator**

In the object the aggregator builds for each derived `Voice` (`voices.ts:335-361`), add:

```typescript
    voiceUuid: c.voiceUuid,
```

- [ ] **Step 4: Run the test**

Run: `cd server && npm run test -- voices.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts
git commit -m "fix(server): surface voiceUuid on the derived Voice (srv-43)"
```

---

### Task 10: Carry `voiceUuid` into the "Play 12s" audition path (frontend + design response)

**Plan-review MAJOR.** The audition player resolves the qwen voice via `pickVoiceForEngine(body.voice, …)` (`server/src/routes/voice-sample.ts:114-118`), which returns `qwen-<uuid>` **only if `body.voice.voiceUuid` is set**. The design route caches its one-pass audition under the storage key (`qwen-<uuid>`). So if the Profile Drawer's in-memory voice (especially right after a design, before any refetch) lacks `voiceUuid`, the player both misses that cache and synthesises from the legacy `qwen-<name>.pt` (which no longer exists for a uuid voice) → wrong/no preview audio. The server resolver is already correct (Task 2); this task makes the frontend actually send the uuid.

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` — the design route's response `{ voiceId, url }` gains `voiceUuid` (and `promote-voice`'s response) so the drawer can seed it without a refetch
- Modify: `openapi.yaml` — the design-voice / promote-voice response schema + the `/sample` request `voice` shape gain `voiceUuid` (then `npm run openapi:types`)
- Modify: the Profile Drawer + voice-compare drawer (frontend) — put `voiceUuid` on the in-memory voice after design and include it in the `/sample` request body's `voice`
- Test: `server/src/routes/voice-sample.test.ts` (a qwen `/sample` whose `voice` carries `voiceUuid` resolves `voiceName === qwen-<uuid>`); a frontend test if the drawer logic crosses a testable seam

- [ ] **Step 1: Write the failing server test**

`voice-sample.test.ts`: POST `/sample` with a qwen `voice` carrying `{ voiceUuid:'U1', overrideTtsVoices:{qwen:{name:'qwen-wren'}} }` → the resolved `voiceName` handed to the sidecar/cache is `qwen-U1` (not `qwen-wren`). Fails before the field flows through.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test -- voice-sample.test.ts -t "voiceUuid"`
Expected: FAIL (resolves `qwen-wren` because `body.voice` carries no uuid / `VoiceLike` mapping drops it).

- [ ] **Step 3: Return `voiceUuid` from the design + promote responses**

In `qwen-voice.ts`, the design route returns `res.status(200).json({ voiceId, url })` (`:508`) and promote returns `{ voiceId, url }` (`:614`). Add `voiceUuid` (the value `ensureCharacterVoiceUuid` returned / `qwenStorageKey`'s source) so the drawer can stamp it locally:

```typescript
      return res.status(200).json({ voiceId, url, voiceUuid });
```

- [ ] **Step 4: Plumb `voiceUuid` through OpenAPI + frontend**

Add `voiceUuid` to the design/promote response schema and to the `/sample` request `voice` object in `openapi.yaml`; `npm run openapi:types`. In the Profile Drawer (and the A/B voice-compare drawer), after a successful design/promote set `voiceUuid` on the in-memory voice from the response, and include `voiceUuid` on the `voice` sent to `/sample`. (Confirm `pickVoiceForEngine`'s `VoiceLike` input on the server side already reads it — Task 2.)

- [ ] **Step 5: Run the tests**

Run: `cd server && npm run test -- voice-sample.test.ts` and the relevant frontend test (`npm run test -- <drawer>.test.tsx`).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/voice-sample.test.ts openapi.yaml src/lib/api-types.ts src/
git commit -m "fix(server,frontend): carry voiceUuid into the audition/sample path (srv-43)"
```

---

### Task 11: Docs, verify, and close-out

**Files:**
- Create: `docs/features/<n>-srv-43-voice-uuid.md` (from `docs/features/TEMPLATE.md`) — or fold into an existing Qwen-voice plan if one fits; set frontmatter `status: stable` with Ship notes after merge.
- Modify: `docs/features/INDEX.md` (new entry), `docs/BACKLOG.md` (remove the `srv-43` row, `:116-120`)

- [ ] **Step 1: Write the regression plan doc**

Document the invariant (storage key = `qwen-<voiceUuid>` with legacy fallback; `qwen.name` stays human), the forward-only decision, and a manual acceptance walkthrough (design two same-named characters in different standalone books → confirm two distinct `voices/qwen/qwen-<uuid>.pt` files, both playable). Cite the canonical fixture if an e2e run is wanted.

- [ ] **Step 2: Update INDEX and BACKLOG**

Add the plan to `docs/features/INDEX.md`; remove the `srv-43` row from `docs/BACKLOG.md` (`:116-120`).

- [ ] **Step 3: Run the full battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build). If a leg is red and pre-existing on `main`, surface it rather than fixing in-scope.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(docs): srv-43 regression plan + INDEX/BACKLOG close-out (Closes #934)"
```

- [ ] **Step 5: Open the PR**

Push the branch; open a PR titled `fix(server): stable per-voice voiceUuid to prevent cross-series collisions (srv-43)` with `Closes #934` in the body and a link to the spec + plan.

---

## Self-Review

**Spec coverage:**
- Split storage/name (`voiceUuid` = storage, `name` = human) → Tasks 1–3. ✓
- `qwenStorageKey` resolver + legacy fallback → Tasks 2 (synth + `toVoiceLike`), 3 (routes + `verify-designed-voice-language`). ✓
- Mint/propagate lifecycle table: fresh single design + bulk → Task 4; `applyOverrideToCastFiles` preserve → Task 6; series reuse (`:309` + `projectVoice` + `resolveReusedVoiceFields`) → Task 5; stale-link revert clears uuid → Task 5b; manual unify converge → Task 7; reparse preserve → Task 6; snapshot → Task 6; import (none) → no task (intentional). ✓
- Field plumbing (OpenAPI + api-types + aggregator) → Tasks 1, 9. ✓
- Audition/`/sample` resolution (frontend carries `voiceUuid`) → Task 10. ✓
- Sidecar inert descriptor → Task 8. ✓
- Out of scope (dedup re-bucket, display, migration) → no tasks (correct — explicitly excluded). ✓
- Tests: collision regression that designs both + asserts distinct `.pt` (Task 4), resolver units + the `toVoiceLike` synth-path test (Task 2), reuse/revert/preserve/converge (Tasks 5–7), `/sample` (Task 10), api-types (Task 9), sidecar (Task 8). ✓

**Round-4 adversarial-review fixes folded in (3-reviewer plan pass):**
- BLOCKER `toVoiceLike` drops `voiceUuid` → Task 2 Step 4a + synth-path test.
- BLOCKER `verify-designed-voice-language.ts` reads the human name → Task 3 Step 4b.
- MAJOR `clearStaleLink` keeps the old uuid (re-collision) → Task 5 Step 5b.
- MAJOR Task 8 sidecar snippet (no `payload`; positional typed method) → Task 8 Step 4 rewritten (3 spots).
- MAJOR collision test was tautological → Task 4 Step 1 now designs both + asserts distinct `.pt`.
- MAJOR `/sample` audition needs frontend `voiceUuid` → new Task 10.
- MAJOR qwen branch dropped legacy singular `overrideTtsVoice` → Task 2 Step 3 fixed.
- Minors: `seriesInfo` hoist deletion explicit (Task 4); self-deadlock warning (Task 4); `projectVoice` (not `projectLibraryVoice`) is the required edit (Task 5); Task 7 canonical uuid already in hand (no new read); `normaliseCastCharacter` confirmed a spread (Task 6 Step 5 = regression guard, no code change).

**Placeholder scan:** route-level test bodies describe arrange/assert without full harness boilerplate — acceptable because they reuse the documented mocked-fetch pattern in `qwen-voice.test.ts` (`:54-66,110,177`). No `TODO`/`TBD`.

**Type consistency:** `qwenStorageKey(character, characterId)` consistent across Tasks 3/4. `ensureCharacterVoiceUuid(bookDir, characterId, seriesFilter?)` matches both call sites. `voiceUuid?: string` optional everywhere — consistent with the non-required OpenAPI field.
