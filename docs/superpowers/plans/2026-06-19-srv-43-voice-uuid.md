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
- Test: `server/src/tts/voice-mapping.test.ts`

**Interfaces:**
- Produces: `pickVoiceForEngine('qwen', voice)` returns `qwen-${voice.voiceUuid}` when `voiceUuid` is set and the voice is designed; the stored `overrideTtsVoices.qwen.name` when designed without a uuid (legacy); `''` when undesigned. `pickEmotionVariantVoice` derives the variant key as `${baseVoice}__${emotion}` from the (already resolved) base storage key.

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
    const designedName = voice.overrideTtsVoices?.qwen?.name;
    if (!designedName) return '';
    return voice.voiceUuid ? `qwen-${voice.voiceUuid}` : designedName;
  }

  const slotName = voice.overrideTtsVoices?.[engine]?.name;
  if (slotName) return slotName;
  // ... (unchanged: legacy overrideTtsVoice, then profile inference)
```

Delete the now-dead `if (engine === 'qwen') return '';` line further down (`:263`).

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
- Test: `server/src/routes/qwen-voice.test.ts`

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

  it('two same-named characters in different series get distinct uuids and distinct .pt paths', async () => {
    // arrange two standalone books each with character {id:'wren', voiceId:'wren'}
    const u1 = await ensureCharacterVoiceUuid(bookDirA, 'wren');
    const u2 = await ensureCharacterVoiceUuid(bookDirB, 'wren');
    expect(u1).not.toBe(u2);
    // after designing each (mocked fetch), assert the two written .pt paths differ
  });
});
```

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

(`CastFile`/`readJson`/`writeJsonAtomic`/`castJsonPath` are already imported; confirm `CastFile` is in scope — `persistEmotionVariant` uses it.)

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

(Reuse `seriesInfo` for the existing variant `persistEmotionVariant` call rather than recomputing it.)

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
- Modify: `server/src/routes/voice-match.ts` (`LibraryVoice` already got the field in Task 1; `projectLibraryVoice:82` copies it)
- Modify: `server/src/workspace/series-reuse-link.ts` (its `projectVoice` ~`:96-113` copies `voiceUuid`; the link stamp at `:309`)
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

Apply the identical `voiceUuid: c.voiceUuid` addition to the `projectVoice` function inside `series-reuse-link.ts` (~`:96-113`) that builds `priorVoices`.

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

- [ ] **Step 5: If the override-save test failed, preserve in `applyOverrideToCastFiles`**

Only if Step 2 showed stripping: confirm `normaliseCastCharacter` carries unknown fields; the `replacement: CastCharacter = { ...normalised }` at `voices.ts:614` preserves `voiceUuid` as long as `normaliseCastCharacter` returns it. If `normaliseCastCharacter` uses an explicit allowlist, add `voiceUuid` there.

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

At the call site(s) of `applyToBook`, resolve the canonical character's `voiceUuid` (read it from the canonical book's cast.json by `canonicalVoiceId`) and pass it through.

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

- [ ] **Step 4: Write it in the sidecar descriptor**

`main.py` `design_voice` — accept `voiceUuid` from the request payload (mirror how `voiceId`/`instruct` are read) and add it to the dumped dict (`:1571-1578`):

```python
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

where `voice_uuid = payload.get("voiceUuid")` (defaults to `None`).

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

### Task 10: Docs, verify, and close-out

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
- `qwenStorageKey` resolver + legacy fallback → Tasks 2 (synth), 3 (routes). ✓
- Mint/propagate lifecycle table: fresh single design + bulk → Task 4; `applyOverrideToCastFiles` preserve → Task 6; series reuse (`:308`/`:309` + candidate scan + `resolveReusedVoiceFields`) → Task 5; manual unify converge → Task 7; reparse preserve → Task 6; snapshot → Task 6; import (none) → no task (intentional). ✓
- Field plumbing (OpenAPI + api-types + aggregator) → Tasks 1, 9. ✓
- Sidecar inert descriptor → Task 8. ✓
- Out of scope (dedup re-bucket, display, migration) → no tasks (correct — explicitly excluded). ✓
- Tests: collision regression (Task 4), resolver units (Tasks 2/3), display-unchanged guard (implicit — `qwen.name` is never written by any task; add an explicit assertion in Task 4 that `qwen.name` stays human if desired), reuse/preserve/converge (Tasks 5–7), api-types (Task 9), sidecar (Task 8). ✓

**Placeholder scan:** route-level test bodies in Tasks 3–4 describe arrange/assert without full harness boilerplate — acceptable because they reuse the documented mocked-fetch pattern already in `qwen-voice.test.ts` (`:54-66,110,177`); the implementer copies that pattern. No `TODO`/`TBD`.

**Type consistency:** `qwenStorageKey(character, characterId)` (Task 3) is used consistently in Tasks 3–4. `ensureCharacterVoiceUuid(bookDir, characterId, seriesFilter?)` (Task 4) signature matches both call sites. `voiceUuid?: string` optional everywhere (Task 1) — consistent with the OpenAPI `voiceUuid` being non-required.
