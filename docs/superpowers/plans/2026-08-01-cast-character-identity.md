# Cast-authoritative character identity — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `#2040`'s silent narrator substitution by making `cast.json` the
authoritative character identity, recording every superseded analyzer id as an
alias, and resolving every render-derived `characterId` lookup through that
alias set.

**Architecture:** One new pure helper (`normaliseIdKey`) and one new resolver
module (`buildCastResolver`) replace eight raw `castById.get()` joins. A new
`idAliases` field on `Character` accumulates superseded ids; three write paths
in the analysis pipeline are hardened so it survives, and a new early remap pass
keeps the prior cast's ids instead of adopting the analyzer's fresh ones.

**Tech Stack:** TypeScript, Node 20+, Vitest (server + frontend), Zod schemas,
Playwright (e2e), Express routes.

**Design of record:**
[`docs/superpowers/specs/2026-08-01-cast-character-identity-design.md`](../specs/2026-08-01-cast-character-identity-design.md).
Read it before Task 1 — the section references below are to that file.

## Global Constraints

- **Never edit `src/lib/api-types.ts` by hand.** It is generated: change
  `openapi.yaml`, then run `npm run openapi:types`.
- **`aliases` and `idAliases` are different fields.** `aliases` holds display
  names; `idAliases` holds ids. Never match one against the other.
- **The resolver never matches on names.** Name matching happens only at
  merge/repair time (spec §4.2). The resolver is ids-only (spec §4.3).
- **Frozen `<slug>.segments.json` files are never rewritten to migrate ids**
  (spec §3). `chapter-qa-repair` rewriting a segments file as part of its normal
  repair job is not covered by that rule.
- **Every commit follows** `<type>(<scope>): <subject>` per CONTRIBUTING.md.
  Scopes used here: `server`, `frontend`, `scripts`, `docs`.
- **Run `npm run test:server` from `server/`**, `npm test` from the repo root
  for the frontend.
- **Do not use `--no-verify`.** If a hook fails, triage per CLAUDE.md.

## File Structure

| File | Responsibility |
|---|---|
| `server/src/util/character-id.ts` | **new** — `normaliseIdKey`, pure, no deps |
| `server/src/util/character-id.test.ts` | **new** — its unit tests |
| `server/src/store/cast-resolve.ts` | **new** — `buildCastResolver`, ids-only, tie-safe |
| `server/src/store/cast-resolve.test.ts` | **new** — resolver tier + tie tests |
| `server/src/handoff/schemas.ts` | add `idAliases` to `characterSchema` |
| `openapi.yaml` | add `idAliases` to `Character` |
| `server/src/workspace/preserve-cast-voices.ts` | union `idAliases` on client writes |
| `server/src/store/merge-analysis-cast.ts` | union `idAliases`; collision union; widen name fallback |
| `server/src/routes/analysis.ts` | the early remap pass (both paths) |
| `server/src/routes/cast-create.ts` | mint via `safeId` |
| `server/src/tts/synthesise-chapter.ts` | 4 join sites → resolver |
| `server/src/routes/revisions.ts` | 1 join site → resolver |
| `server/src/audio/render-integrity/aggregate.ts` | 1 join site → resolver |
| `server/src/routes/chapter-qa-repair.ts` | 1 join site → resolver |
| `server/src/audio/build-synth-replacement.ts` | `findDivergentSentences` → resolver |
| `server/src/audio/segments-io.ts` | widen the orphan collector |
| `src/store/cast-slice.ts` | carry `idAliases` through hydration |
| `src/views/cast.tsx` | banner split + un-record action |
| `scripts/repair-cast-id-drift.mjs` | **new** — the repair pass |
| `scripts/tests/repair-cast-id-drift.test.mjs` | **new** — its pure-helper tests |
| `docs/features/278-cast-character-identity.md` | **new** — regression plan |

---

# Wave 1 — resolve through the drift

Ships a working recovery of 68 of the 188 orphaned segments with no alias
recorded anywhere, because the normalised tiers alone match `the-torment` to the
cast's `the_torment`. **Wave 1 must not be split** — converting `:1526` without
`:1519` opens a clone-validation hole (spec §4.3).

### Task 1: `normaliseIdKey`

**Files:**
- Create: `server/src/util/character-id.ts`
- Test: `server/src/util/character-id.test.ts`

**Interfaces:**
- Produces: `normaliseIdKey(id: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normaliseIdKey } from './character-id.js';

describe('normaliseIdKey', () => {
  it('equates ids differing only by separator', () => {
    expect(normaliseIdKey('the_torment')).toBe(normaliseIdKey('the-torment'));
    expect(normaliseIdKey('lightning_dave')).toBe(normaliseIdKey('lightning-dave'));
  });

  it('equates ids differing only by case', () => {
    expect(normaliseIdKey('The-Torment')).toBe(normaliseIdKey('the-torment'));
  });

  it('collapses runs and trims edge separators', () => {
    expect(normaliseIdKey('__foo___bar__')).toBe('foo-bar');
    expect(normaliseIdKey('foo   bar')).toBe('foo-bar');
  });

  it('NEVER equates ids whose letters differ', () => {
    expect(normaliseIdKey('mairin')).not.toBe(normaliseIdKey('mayrin'));
    expect(normaliseIdKey('coalfall')).not.toBe(normaliseIdKey('coalfall-dragon'));
    expect(normaliseIdKey('pool-player-2')).not.toBe(normaliseIdKey('pool_player'));
  });

  it('preserves non-Latin characters', () => {
    expect(normaliseIdKey('мэйрин')).toBe('мэйрин');
    expect(normaliseIdKey('奥杜万')).toBe('奥杜万');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && npx vitest run src/util/character-id.test.ts`
Expected: FAIL — cannot resolve `./character-id.js`.

- [ ] **Step 3: Implement**

```ts
/** Collapse the separator/case differences that distinguish two ids minted for
    the SAME name by different code paths (#2040 RC2: cast-create.ts minted
    `the_torment` while the analyzer minted `the-torment`). This is an ENCODING
    difference, not a semantic guess — it never merges two ids whose letters
    differ, so `mairin` and `mayrin` stay distinct. Unicode-preserving, matching
    `safe-id.ts`'s `unicodeKebab` policy: a Cyrillic or CJK id must survive. */
export function normaliseIdKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-_\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd server && npx vitest run src/util/character-id.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/util/character-id.ts server/src/util/character-id.test.ts
git commit -m "feat(server): add normaliseIdKey for encoding-equivalent character ids"
```

### Task 2: `idAliases` on the schema and the API contract

**Files:**
- Modify: `server/src/handoff/schemas.ts` (`characterSchema`, near `aliases`)
- Modify: `openapi.yaml` (`Character`, line ~6451; `aliases` at ~6462)
- Regenerate: `src/lib/api-types.ts`
- Test: `server/src/handoff/schemas.test.ts` (create if absent)

**Interfaces:**
- Produces: `Character.idAliases?: string[]` on both the Zod and OpenAPI shapes.

**Why this task exists separately:** `characterSchema` is `.strict()`. Until the
field is declared, any cast.json carrying `idAliases` fails validation — so this
must land before anything writes one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { characterSchema } from './schemas.js';

describe('characterSchema idAliases', () => {
  it('accepts a character carrying idAliases', () => {
    const parsed = characterSchema.parse({
      id: 'mairin', name: 'Мэйрин', role: 'supporting', color: 'slot-3',
      idAliases: ['mayrin'],
    });
    expect(parsed.idAliases).toEqual(['mayrin']);
  });

  it('still accepts a character without it', () => {
    expect(() =>
      characterSchema.parse({ id: 'ren', name: 'Рен', role: 'supporting', color: 'slot-1' }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts`
Expected: FAIL — `.strict()` rejects the unrecognised key `idAliases`.

- [ ] **Step 3: Add the field to the Zod schema**

In `server/src/handoff/schemas.ts`, directly below the existing `aliases` entry:

```ts
    /* Every analyzer-assigned or previously-persisted id seen for this
       character (#2040). The analyzer is non-deterministic about ids across
       runs, and several paths rename a persisted id; a frozen segments.json or
       a stale analysis cache may still reference any of them. Read through
       this set via store/cast-resolve.ts — never match it against `aliases`,
       which holds display NAMES. */
    idAliases: z.array(z.string()).optional(),
```

- [ ] **Step 4: Add it to the OpenAPI contract**

In `openapi.yaml` under `Character.properties`, mirroring `aliases`:

```yaml
        idAliases:
          type: array
          items:
            type: string
          description: >-
            Superseded character ids previously used for this character.
            Render-time lookups resolve through this set so a frozen
            segments.json referencing an old id still finds its cast member.
```

- [ ] **Step 5: Regenerate the client types and confirm the field appears**

```bash
npm run openapi:types
git diff --stat src/lib/api-types.ts
```

Expected: `src/lib/api-types.ts` shows `idAliases?: string[]`. If the diff is
empty the generator did not pick it up — fix `openapi.yaml` rather than editing
the generated file.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts` → PASS.
Run: `npm run typecheck` from the repo root → clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server,frontend): declare idAliases on the Character contract"
```

### Task 3: `buildCastResolver`

**Files:**
- Create: `server/src/store/cast-resolve.ts`
- Test: `server/src/store/cast-resolve.test.ts`

**Interfaces:**
- Consumes: `normaliseIdKey` (Task 1)
- Produces:
  ```ts
  export interface CastResolution { character: CastRecord; viaAlias?: string }
  export function buildCastResolver(cast: readonly CastRecord[]): {
    resolve(characterId: string): CastResolution | undefined;
  }
  ```
  where `CastRecord = { id: string } & Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildCastResolver } from './cast-resolve.js';

const cast = [
  { id: 'narrator', name: 'Narrator' },
  { id: 'mairin', name: 'Мэйрин', idAliases: ['mayrin'] },
  { id: 'the_torment', name: 'Torment' },
];

describe('buildCastResolver', () => {
  it('tier 1: exact id', () => {
    expect(buildCastResolver(cast).resolve('mairin')?.character.id).toBe('mairin');
  });

  it('tier 2: exact alias, and reports viaAlias', () => {
    const r = buildCastResolver(cast).resolve('mayrin');
    expect(r?.character.id).toBe('mairin');
    expect(r?.viaAlias).toBe('mayrin');
  });

  it('tier 3: normalised id — the wave-1 recovery, with no alias recorded', () => {
    const r = buildCastResolver(cast).resolve('the-torment');
    expect(r?.character.id).toBe('the_torment');
    expect(r?.viaAlias).toBe('the-torment');
  });

  it('tier 4: normalised alias', () => {
    const c = [{ id: 'x', name: 'X', idAliases: ['foo_bar'] }];
    expect(buildCastResolver(c).resolve('foo-bar')?.character.id).toBe('x');
  });

  it('an exact id BEATS another row alias-claiming it', () => {
    const c = [
      { id: 'unknown-male', name: 'Unknown Male' },
      { id: 'timkin', name: 'Timkin', idAliases: ['unknown-male'] },
    ];
    expect(buildCastResolver(c).resolve('unknown-male')?.character.id).toBe('unknown-male');
  });

  it('returns undefined on a genuine miss', () => {
    expect(buildCastResolver(cast).resolve('nobody')).toBeUndefined();
  });

  it('returns undefined on a NORMALISED tie rather than guessing', () => {
    const c = [{ id: 'foo_bar', name: 'A' }, { id: 'foo-bar', name: 'B' }];
    expect(buildCastResolver(c).resolve('foo bar')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && npx vitest run src/store/cast-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { normaliseIdKey } from '../util/character-id.js';

type CastRecord = { id: string } & Record<string, unknown>;

export interface CastResolution {
  character: CastRecord;
  /** Set when the id matched through an alias or a normalised key rather than
      an exact id — callers may want to report the reconciliation. */
  viaAlias?: string;
}

const aliasesOf = (c: CastRecord): string[] =>
  Array.isArray(c.idAliases) ? (c.idAliases.filter((a) => typeof a === 'string') as string[]) : [];

/** Resolve a `characterId` from manuscript attribution or a frozen render
    against the book's cast, reading through superseded ids (#2040).
    IDS ONLY — display names are never consulted; name matching belongs to the
    merge/repair matcher (spec §4.2). */
export function buildCastResolver(cast: readonly CastRecord[]): {
  resolve(characterId: string): CastResolution | undefined;
} {
  const byId = new Map<string, CastRecord>();
  const byAlias = new Map<string, CastRecord>();
  /* Normalised maps carry `null` on collision so a tie falls through to the
     orphan path instead of silently rendering one character as another —
     strictly worse than the narrator substitution it would replace. */
  const byNormId = new Map<string, CastRecord | null>();
  const byNormAlias = new Map<string, CastRecord | null>();

  const put = (m: Map<string, CastRecord | null>, k: string, c: CastRecord) => {
    if (m.has(k) && m.get(k)?.id !== c.id) m.set(k, null);
    else if (!m.has(k)) m.set(k, c);
  };

  for (const c of cast) {
    if (!byId.has(c.id)) byId.set(c.id, c);
    put(byNormId, normaliseIdKey(c.id), c);
    for (const a of aliasesOf(c)) {
      if (!byAlias.has(a)) byAlias.set(a, c);
      put(byNormAlias, normaliseIdKey(a), c);
    }
  }

  return {
    resolve(characterId: string): CastResolution | undefined {
      const exact = byId.get(characterId);
      if (exact) return { character: exact };

      const alias = byAlias.get(characterId);
      if (alias) return { character: alias, viaAlias: characterId };

      const key = normaliseIdKey(characterId);
      const normId = byNormId.get(key);
      if (normId) return { character: normId, viaAlias: characterId };

      const normAlias = byNormAlias.get(key);
      if (normAlias) return { character: normAlias, viaAlias: characterId };

      return undefined;
    },
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd server && npx vitest run src/store/cast-resolve.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/store/cast-resolve.ts server/src/store/cast-resolve.test.ts
git commit -m "feat(server): add cast resolver reading through superseded character ids"
```

### Task 4: convert the four `synthesise-chapter.ts` join sites

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts` — `:1519`, `:1526`, `:2005`, `:2256`
- Test: `server/src/tts/synthesise-chapter.orphan-alias.test.ts` (new)

**Interfaces:**
- Consumes: `buildCastResolver` (Task 3)

**Read spec §4.3 before starting.** `:1519` is the one an earlier draft missed
and it is a safety gate, not a convenience.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
// Follow the harness already used by the neighbouring synthesise-chapter tests
// for building a chapter + cast fixture; do not invent a new one.

describe('#2040 orphaned characterId resolves through an alias', () => {
  it('renders in the aliased character voice, not the narrator', async () => {
    // cast: narrator + { id: 'mairin', idAliases: ['mayrin'], designed voice }
    // groups: one group with characterId 'mayrin'
    // EXPECT: the group renders with Мэйрин's voice
    // EXPECT: its segment carries NO renderedFallbackCharacterId
  });

  it('still records the #2023 orphan stamp on a genuine miss', async () => {
    // groups: one group with characterId 'nobody-at-all'
    // EXPECT: narrator voice AND renderedFallbackCharacterId === narrator id
  });

  it('puts the RESOLVED character into the cloned-voice pre-pass set', async () => {
    // cast: narrator + { id: 'the_torment', voiceState: 'tuned', cloned qwen voice }
    // groups: one group with characterId 'the-torment'
    // EXPECT: the pre-pass validates 'the_torment' — i.e. a broken clone for it
    //         throws UnresolvableClonedVoiceError rather than rendering silently.
    // This is the :1519 regression guard.
  });
});
```

- [ ] **Step 2: Run and confirm all three fail**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.orphan-alias.test.ts`
Expected: FAIL — the alias group falls to the narrator; the pre-pass validates nothing.

- [ ] **Step 3: Build the resolver once, beside `castById`**

At `synthesise-chapter.ts:1474`, immediately after the existing
`const castById = new Map(cast.map((c) => [c.id, c]));`, add:

```ts
/* #2040 — resolve a group's characterId through superseded ids before treating
   it as orphaned. castById stays for the exact-id fast paths that legitimately
   want strict identity. */
const castResolver = buildCastResolver(cast);
```

- [ ] **Step 4: Convert `:1519` and `:1526` together**

Replace the `inChapterCharacterIds` / `rendersNarrator` pair with:

```ts
const inChapterCharacterIds = new Set(
  groups.map((g) => castResolver.resolve(g.characterId)?.character.id ?? g.characterId),
);
/* IMPORTANT-1 (Task 6 review) — keep the original intent: a group whose id
   cannot be resolved AT ALL still renders as the narrator, so the narrator must
   be validated too. #2040 narrows this to a TRUE miss: a group that resolves
   through an alias now contributes its RESOLVED character above, and must not
   silently drop out of the pre-pass. */
const rendersNarrator =
  Boolean(titleText) || groups.some((g) => !castResolver.resolve(g.characterId));
if (rendersNarrator) inChapterCharacterIds.add(resolvedNarratorCharacterId);
```

- [ ] **Step 5: Convert `:2005` and `:2256`**

In `chapterHasQwenGroups` (`:2005`) replace `castById.get(g.characterId)` with
`castResolver.resolve(g.characterId)?.character`.

In `resolveGroup` (`:2256`) replace `let character = castById.get(group.characterId);`
with `let character = castResolver.resolve(group.characterId)?.character;`.
Leave the entire orphan branch below it unchanged — the `console.warn`, the
`orphanedFromId` capture, `applyQwenFallback`'s extra argument, and the
`renderedFallbackCharacterId` stamp all still apply on a true miss.

- [ ] **Step 6: Run the new tests, then the whole server suite**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.orphan-alias.test.ts` → PASS.
Run: `cd server && npm run test` → green. Investigate any pre-existing failure
per CLAUDE.md's triage rule rather than assuming it is yours.

- [ ] **Step 7: Commit**

```bash
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter.orphan-alias.test.ts
git commit -m "fix(server): resolve orphaned characterIds through cast aliases at render time"
```

### Task 5: convert the four remaining join sites

**Files:**
- Modify: `server/src/routes/revisions.ts:155`
- Modify: `server/src/audio/render-integrity/aggregate.ts:510`
- Modify: `server/src/routes/chapter-qa-repair.ts:408`
- Modify: `server/src/audio/build-synth-replacement.ts:200` (`findDivergentSentences`)
- Test: `server/src/audio/build-synth-replacement.alias.test.ts` (new)

**Interfaces:**
- Consumes: `buildCastResolver` (Task 3)

**`findDivergentSentences` is the one that matters.** Without it, Wave 2's remap
makes QA repair skip every drifted segment and makes chapter splice refuse
outright (spec §4.3).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { findDivergentSentences } from './build-synth-replacement.js';

describe('#2040 findDivergentSentences tolerates alias-only differences', () => {
  const cast = [{ id: 'mairin', name: 'Мэйрин', idAliases: ['mayrin'] }];

  it('does NOT report divergence when the two ids are the same character', () => {
    // segFile segment: characterId 'mayrin'; current sentence: characterId 'mairin'
    // EXPECT: no divergence reported
  });

  it('STILL reports divergence on a genuine reattribution', () => {
    // segFile segment: characterId 'mairin'; current sentence: characterId 'ren'
    // EXPECT: divergence reported with newOwner 'ren'
  });
});
```

- [ ] **Step 2: Run and confirm the first case fails**

Run: `cd server && npx vitest run src/audio/build-synth-replacement.alias.test.ts`
Expected: FAIL — the raw `!==` reports a divergence.

- [ ] **Step 3: Thread the cast into `findDivergentSentences`**

Give it the book's cast (its callers — `chapter-qa-repair.ts:442` and
`chapter-splice.ts:355` — already hold one), build the resolver, and compare
resolved identities rather than raw strings:

```ts
const resolver = buildCastResolver(cast);
const sameCharacter = (a: string, b: string): boolean => {
  if (a === b) return true;
  const ra = resolver.resolve(a)?.character.id;
  const rb = resolver.resolve(b)?.character.id;
  /* Both must RESOLVE to be treated as the same person. Two unresolvable ids
     that merely look alike are still a divergence — #1972's lesson is that
     guessing here can destroy correct audio. */
  return Boolean(ra && rb && ra === rb);
};
if (!sameCharacter(current.characterId, seg.characterId)) {
  out.push({ segmentIndex: idx, sentenceId: id, newOwner: current.characterId });
}
```

Update both call sites to pass the cast.

- [ ] **Step 4: Convert the three remaining lookups**

- `revisions.ts:155` — `castById.get(characterId)` → resolver; keep the
  `continue` on a miss.
- `aggregate.ts:510` — `castById.get(charId)` → resolver, for the hint only.
- `chapter-qa-repair.ts:408` — replace
  `cast.characters.find((c) => c.id === seg.characterId) ?? {}` with a resolver
  lookup, keeping `?? {}` for a true miss.

- [ ] **Step 5: Run the new test and the server suite**

Run: `cd server && npx vitest run src/audio/build-synth-replacement.alias.test.ts` → PASS.
Run: `cd server && npm run test` → green.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/revisions.ts server/src/audio/render-integrity/aggregate.ts \
        server/src/routes/chapter-qa-repair.ts server/src/audio/build-synth-replacement.ts \
        server/src/routes/chapter-splice.ts server/src/audio/build-synth-replacement.alias.test.ts
git commit -m "fix(server): resolve character ids through aliases in drift, QA and splice joins"
```

### Task 6: keep `idAliases` across a client cast write

**Files:**
- Modify: `server/src/workspace/preserve-cast-voices.ts`
- Test: `server/src/workspace/preserve-cast-voices.test.ts` (exists — extend it)

**Interfaces:**
- Consumes: nothing new.

`PRESERVED_DESIGN_FIELDS` uses fill-the-gap semantics. `idAliases` needs a
**union** instead — the set accumulates and must never shrink through a client
round-trip (spec §4.1).

- [ ] **Step 1: Write the failing test**

```ts
it('#2040 — a client write omitting idAliases does not erase it', () => {
  const existing = [{ id: 'mairin', idAliases: ['mayrin'] }];
  const incoming = [{ id: 'mairin', name: 'Мэйрин' }];
  expect(preserveDesignedVoicesOnCastWrite(existing, incoming)[0].idAliases).toEqual(['mayrin']);
});

it('#2040 — unions rather than replacing when the client sends a subset', () => {
  const existing = [{ id: 'mairin', idAliases: ['mayrin', 'meyrin'] }];
  const incoming = [{ id: 'mairin', idAliases: ['mayrin'] }];
  expect(preserveDesignedVoicesOnCastWrite(existing, incoming)[0].idAliases)
    .toEqual(['mayrin', 'meyrin']);
});
```

- [ ] **Step 2: Run and confirm both fail**

Run: `cd server && npx vitest run src/workspace/preserve-cast-voices.test.ts`
Expected: FAIL — `idAliases` is `undefined` in the first, `['mayrin']` in the second.

- [ ] **Step 3: Implement the union**

Inside `preserveDesignedVoicesOnCastWrite`, after the `PRESERVED_DESIGN_FIELDS`
loop and beside the `voiceUuid` rule:

```ts
/* #2040 — idAliases accumulates superseded analyzer ids and is what makes a
   frozen segments.json resolve. A client round-trip that omits or narrows it
   must not shrink the set, so this is a UNION, not the fill-the-gap semantics
   PRESERVED_DESIGN_FIELDS uses. */
const oldAliases = Array.isArray(old.idAliases) ? (old.idAliases as string[]) : [];
const incAliases = Array.isArray(merged.idAliases) ? (merged.idAliases as string[]) : [];
const union = [...new Set([...incAliases, ...oldAliases])];
if (union.length) merged.idAliases = union;
```

- [ ] **Step 4: Run and confirm both pass**

Run: `cd server && npx vitest run src/workspace/preserve-cast-voices.test.ts` → PASS.

- [ ] **Step 5: Carry the field through redux**

In `src/store/cast-slice.ts`, make `overlaySnapshotEntry` / `hydrateFromAnalysis`
preserve `idAliases` the same way they already preserve `aliases`. Add a
frontend test asserting a hydrate does not drop it.

- [ ] **Step 6: Run the frontend suite**

Run: `npm test` from the repo root → green.

- [ ] **Step 7: Commit**

```bash
git add server/src/workspace/preserve-cast-voices.ts server/src/workspace/preserve-cast-voices.test.ts src/store/cast-slice.ts src/store/cast-slice.test.ts
git commit -m "fix(server,frontend): union idAliases across cast writes and hydration"
```

### Task 7: Wave 1 gate

- [ ] **Step 1: Run the branch battery**

Run: `npm run verify:fast:branch`
Expected: every in-scope leg green.

- [ ] **Step 2: Confirm the recovery against real data, read-only**

Run the drift scan from the spec's §1.1 method against
`C:\AudiobookWorkspace\books`, with the resolver applied. Expected: the
_Playing with Fire_ orphans `the-torment` (67) and `lightning-dave` (1) now
resolve; the other 9 ids still do not. **Do not modify any book.**

- [ ] **Step 3: Commit any test-only adjustments, then stop for review.**

---

# Wave 2 — stop new drift being generated

**Read spec §4.4 in full before starting.** Two adversarial review rounds each
found an earlier version of this wave to be inert. The three parts of the id
invariant are not independent niceties — Task 8 without Task 10 is a no-op.

### Task 8: `applyRewriteToPriorCast` records the superseded id

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts:224-275`
- Test: `server/src/store/merge-analysis-cast.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```ts
it('#2040 — records the old id when a rewrite renames a row', () => {
  const { priorCast } = applyRewriteToPriorCast(
    [{ id: 'mairin', name: 'Мэйрин', voiceState: 'tuned' }],
    { mairin: 'mayrin' },
  );
  expect(priorCast[0].id).toBe('mayrin');
  expect(priorCast[0].idAliases).toEqual(['mairin']);
});

it('#2040 — on a COLLISION, unions the loser id AND the loser aliases', () => {
  const { priorCast } = applyRewriteToPriorCast(
    [
      { id: 'brann', name: 'Бранн', voiceState: 'tuned' },
      { id: 'brann-weir', name: 'Бранн', voiceState: 'generated', idAliases: ['brann_weir'] },
    ],
    { brann: 'brann-canonical', 'brann-weir': 'brann-canonical' },
  );
  expect(priorCast).toHaveLength(1);
  expect(priorCast[0].id).toBe('brann-canonical');
  expect(new Set(priorCast[0].idAliases))
    .toEqual(new Set(['brann', 'brann-weir', 'brann_weir']));
});
```

- [ ] **Step 2: Run and confirm both fail**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts -t "#2040"`
Expected: FAIL — `idAliases` undefined; the loser's set is discarded.

- [ ] **Step 3: Implement**

In `applyRewriteToPriorCast`, when building `remapped`, append `originalId`;
and in the collision branch, before discarding the loser, union
`{loser.id} ∪ loser.idAliases` into the winner. The dedup collapse **is** the
collision branch, so the second half is the one that fixes RC3's live path.

- [ ] **Step 4: Run and confirm both pass, then the file's whole suite**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/store/merge-analysis-cast.ts server/src/store/merge-analysis-cast.test.ts
git commit -m "fix(server): record superseded ids when a rewrite renames a cast row"
```

### Task 9: the merge unions `idAliases` — the anti-placebo task

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts:163-194`
- Test: `server/src/store/merge-analysis-cast.test.ts` (extend)

**Interfaces:**
- Consumes: Task 8's output shape.

Without this, Task 8's aliases are discarded eight lines later at
`analysis.ts:4767` → `:4775`, and Task 8's unit tests stay green while the
feature does nothing. That is the exact placebo shape this repo has been bitten
by; this task is what makes Task 8 real.

- [ ] **Step 1: Write the failing tests**

```ts
it('#2040 — preserves idAliases on the id-matched branch', () => {
  const out = mergeAnalysisResultWithExistingCast(
    [{ id: 'mairin', name: 'Мэйрин', idAliases: ['mayrin'], voiceState: 'tuned' }],
    [{ id: 'mairin', name: 'Мэйрин', role: 'supporting', color: 'slot-2' }],
  );
  expect(out[0].idAliases).toEqual(['mayrin']);
});

it('#2040 — preserves them on the NAME-FALLBACK branch and records the drift', () => {
  const out = mergeAnalysisResultWithExistingCast(
    [{ id: 'mairin', name: 'Мэйрин', idAliases: ['meyrin'], voiceState: 'tuned' }],
    [{ id: 'mayrin', name: 'Мэйрин', role: 'supporting', color: 'slot-2' }],
  );
  const row = out.find((c) => c.name === 'Мэйрин')!;
  expect(new Set(row.idAliases)).toEqual(new Set(['meyrin', 'mairin']));
});
```

- [ ] **Step 2: Run and confirm both fail**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts -t "idAliases"`
Expected: FAIL — `merged = { ...f }` rebuilds from the fresh row, dropping the field.

- [ ] **Step 3: Implement, mirroring the `aliases` union at `:180-181`**

Immediately after the existing `aliases` union inside the `overlaid` map:

```ts
/* #2040 — idAliases must survive the merge. This function rebuilds every row
   from the FRESH roster and overlays only PRESERVED_VOICE_FIELDS, so without
   this union every re-analysis erases the accumulated alias set — and with it
   every frozen segments.json's ability to resolve. When `old` was matched
   under a DIFFERENT id (the name-fallback branch), that id is itself now
   superseded and joins the set. */
const priorIds = Array.isArray(old.idAliases) ? (old.idAliases as string[]) : [];
const supersededByDrift = old.id !== f.id ? [old.id] : [];
const idAliases = [
  ...new Set([
    ...(Array.isArray(merged.idAliases) ? (merged.idAliases as string[]) : []),
    ...priorIds,
    ...supersededByDrift,
  ]),
].filter((a) => a !== f.id);
if (idAliases.length) merged.idAliases = idAliases;
```

- [ ] **Step 4: Run and confirm both pass**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts` → PASS.

- [ ] **Step 5: Add the end-to-end guard**

Add a test that drives a full analysis run (using the harness the existing
`analysis` route tests use) over a book whose `cast.json` already carries
`idAliases`, and asserts the written `cast.json` still carries them. This is the
only test in the plan that fails if the merge drops the field — Tasks 8 and 9's
unit tests are green either way.

- [ ] **Step 6: Commit**

```bash
git add server/src/store/merge-analysis-cast.ts server/src/store/merge-analysis-cast.test.ts server/src/routes/analysis.idaliases.test.ts
git commit -m "fix(server): union idAliases through the analysis cast merge"
```

### Task 10: the early remap pass — main path

**Files:**
- Modify: `server/src/routes/analysis.ts` — insert between `:4636` and `:4643`
- Create: `server/src/store/remap-fresh-to-prior.ts`
- Test: `server/src/store/remap-fresh-to-prior.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function remapFreshToPriorIds<C extends { id: string }, S extends { characterId: string }>(
    fresh: C[], sentences: S[], priorCast: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  ): { characters: C[]; sentences: S[]; rewrites: Record<string, string> };
  ```

**Placement is load-bearing** (spec §4.4). At `:4633-4636` `characters` is the
final roster and `folded.sentences` is in the same id space; at `:4643`
`phase1ValidIds` derives from it. Remapping roster and sentences **together**
before `:4643` makes `phase1ValidIds` correct for free. Remapping only the
roster would make `reconcileSentenceCharacterIds` demote every renamed
character's lines to the narrator and could trip `attributionDriftExceeded`,
refusing the cast.json write entirely.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps the prior id and rewrites the sentences to match', () => {
  const r = remapFreshToPriorIds(
    [{ id: 'mayrin', name: 'Мэйрин' }],
    [{ characterId: 'mayrin', id: 1 }],
    [{ id: 'mairin', name: 'Мэйрин' }],
  );
  expect(r.characters[0].id).toBe('mairin');
  expect(r.sentences[0].characterId).toBe('mairin');
  expect(r.rewrites).toEqual({ mayrin: 'mairin' });
});

it('refuses an ambiguous name match', () => {
  const r = remapFreshToPriorIds(
    [{ id: 'a1', name: 'Alden' }],
    [],
    [{ id: 'alden', name: 'Alden' }, { id: 'aldan', name: 'Alden' }],
  );
  expect(r.characters[0].id).toBe('a1');
  expect(r.rewrites).toEqual({});
});

it('honours a notLinkedTo edge', () => {
  const r = remapFreshToPriorIds(
    [{ id: 'x', name: 'Alden' }],
    [],
    [{ id: 'alden', name: 'Alden', notLinkedTo: ['x'] }],
  );
  expect(r.rewrites).toEqual({});
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd server && npx vitest run src/store/remap-fresh-to-prior.test.ts`

- [ ] **Step 3: Implement the helper**

Match on `normaliseForMatch(name)` (spec §11 Q1 — this is the canonical
normaliser for this design). One candidate on each side, no `notLinkedTo` edge,
or no rewrite. Return new arrays; do not mutate the inputs.

- [ ] **Step 4: Wire it in at the insertion point**

`characters` is `const` at `:4633`, so restructure that binding rather than
reassigning. Immediately before the `phase1ValidIds` comment block:

```ts
/* #2040 §4.4 — adopt the EXISTING cast's ids for characters this run merely
   re-slugged, before anything derives from the fresh ids. Roster and sentences
   move together: phase1ValidIds (below) is built from the roster, and
   reconcileSentenceCharacterIds would otherwise demote every renamed
   character's lines to the narrator. */
const remappedToPrior = remapFreshToPriorIds(characters0, folded.sentences, priorCastForMerge);
const characters = remappedToPrior.characters;
folded.sentences = remappedToPrior.sentences;
```

Rename the existing `:4633` binding to `characters0`.

- [ ] **Step 5: Snapshot the roster for `pruneSuggestionsToRoster`**

`dd.suggestions` carries ids in the **pre-remap** space. At `:4753`,
`pruneSuggestionsToRoster(dd.suggestions, characters)` would now filter every
suggestion out, silently emptying the merge-suggestion list. Pass the pre-remap
roster (`characters0`) there instead, and add a regression test asserting the
list is non-empty after a remap.

- [ ] **Step 6: Run the analysis route suite**

Run: `cd server && npm run test:server` and `npm run test:server-slow` → green.

- [ ] **Step 7: Commit**

```bash
git add server/src/store/remap-fresh-to-prior.ts server/src/store/remap-fresh-to-prior.test.ts server/src/routes/analysis.ts
git commit -m "fix(server): adopt existing cast ids before deriving anything from a fresh roster"
```

### Task 11: the early remap pass — subset path

**Files:**
- Modify: `server/src/routes/analysis.ts` — insert between `:5797` and `:5804`

Same helper, second call site. Per spec §11, it goes **after** the reuse-link
block at `:5776-5796`, keeping the two paths symmetric with the main path (which
runs `seedReuseGuardsFromPriorCast` at `:3702`, long before its own insertion
point). Apply the same `pruneSuggestionsToRoster` snapshot at `:5907`.

- [ ] **Step 1: Write a subset-path regression test** mirroring Task 10's, driving the per-chapter re-analysis route.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Wire the remap in after `:5796`, renaming the `enriched` binding as in Task 10.**
- [ ] **Step 4: Run `npm run test:server` and `test:server-slow` → green.**
- [ ] **Step 5: Commit** — `fix(server): apply the prior-id remap on the subset re-analysis path`

### Task 12: widen the name fallback past `isVoicedOrReused`

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts:147-174`
- Test: extend `merge-analysis-cast.test.ts`

This is RC1 and the riskiest change in the design (spec §9). The ambiguity guard
stays; only the voiced/reused precondition is dropped.

- [ ] **Step 1: Write the failing test** — an **unvoiced** prior character whose analyzer id drifted keeps its prior id rather than being silently replaced.
- [ ] **Step 2: Write the guard test** — two prior rows sharing a normalised name still refuse to match, and neither is welded.
- [ ] **Step 3: Run both, confirm the first fails and the second passes.**
- [ ] **Step 4: Drop the `isVoicedOrReused` precondition from the candidate set** (keep `ambiguousNames` and the one-fresh-row check).
- [ ] **Step 5: Run the full server suite** — this touches every book's merge, so a broad regression here is meaningful signal, not noise.
- [ ] **Step 6: Commit** — `fix(server): match a drifted analyzer id to an unvoiced cast row by name`

### Task 13: `cast-create` mints canonical ids

**Files:**
- Modify: `server/src/routes/cast-create.ts:40-47`
- Test: `server/src/routes/cast-create.test.ts` (extend)

**Note:** this file is also touched by `feat/server-1981-cast-lock`. Expect a
trivial conflict on whichever branch merges second (spec §10).

- [ ] **Step 1: Write the failing tests** — a created character named "The Torment" gets `the-torment`, and one named "Мэйрин" keeps its Cyrillic letters instead of collapsing to an empty/colliding id.
- [ ] **Step 2: Run, confirm both fail** (current output: `the_torment`, and an empty id for the Cyrillic name).
- [ ] **Step 3: Delete the private `slugify` and mint via `safeId`,** preserving the existing collision-suffix behaviour.
- [ ] **Step 4: Run the route suite → green.**
- [ ] **Step 5: Commit** — `fix(server): mint manually created character ids with safeId`

### Task 14: an alias must yield to a re-minted live id

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts`
- Test: extend `merge-analysis-cast.test.ts`

Exile's cache still carries `unknown-male` for five chapters, so `rebuildRoster`
will reintroduce a real `unknown-male` row. Exact-id-wins then reroutes Timkin's
21 frozen segments to the background bucket with no tie and no warning — 55
segments corpus-wide (spec §4.4).

- [ ] **Step 1: Write the failing test** — when a fresh roster introduces a row whose id equals an existing `idAliases` entry on another character, that entry is removed from the other character.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Implement the displacement** in the merge, after the union in Task 9: strip any `idAliases` entry that collides with a live fresh id.
- [ ] **Step 4: Run the suite → green.**
- [ ] **Step 5: Commit** — `fix(server): drop a superseded id alias when a live character reclaims it`

### Task 15: Wave 2 gate

- [ ] **Step 1:** `npm run verify:fast:branch` → green.
- [ ] **Step 2:** `cd server && npm run test:server-slow` → green.
- [ ] **Step 3:** Re-run the read-only drift scan. Expected: no book's `cast.json` has changed (nothing here writes to the workspace), and the resolver still recovers the wave-1 population.
- [ ] **Step 4:** Stop for review.

---

# Wave 3 — repair the existing books and surface the rest

### Task 16: widen the orphan collector

**Files:**
- Modify: `server/src/audio/segments-io.ts:292-314`
- Test: extend its colocated test

The collector currently skips any segment lacking `renderedFallbackCharacterId`.
Measured: **188 orphaned segments, 0 carrying the stamp** — every affected
render predates #2023, so the existing banner is empty on all five affected
books. And an alias-resolved id never takes the orphan branch, so it never gets
a stamp either: the "auto-reconciled" list would be empty by construction
(spec §4.6).

- [ ] **Step 1: Write the failing test** — a segment whose `characterId` is not an exact live cast id is reported, tagged with how it resolved (`exact` / `alias` / `normalised` / `unresolved`), even with no `renderedFallbackCharacterId`.
- [ ] **Step 2: Run, confirm it fails.**
- [ ] **Step 3: Replace the stamp gate with a resolver-based classification.** Keep the existing key/shape for backward compatibility with the current book-state consumer.
- [ ] **Step 4: Run the server suite → green.**
- [ ] **Step 5: Commit** — `fix(server): report every unresolved segment characterId, not only stamped ones`

### Task 17: banner split and the un-record path

**Files:**
- Modify: `src/views/cast.tsx:939-968`, `src/store/cast-slice.ts`
- Modify: `server/src/routes/cast-aliases.ts` (or a sibling) for the reject action
- Test: frontend unit tests + `e2e/` spec

- [ ] **Step 1: Write the frontend failing tests** — two banner sections render from the classified data, and the "not the same character" action dispatches a reject.
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement the split**: *auto-reconciled* (informational, collapsed) and *needs your decision* (actionable, showing the closest candidate).
- [ ] **Step 4: Implement the reject** — it removes the `idAliases` entry **and** writes a `notLinkedTo` edge, so the next re-analysis's name matcher does not simply re-record it (spec §4.6). Without the edge the un-record is not durable.
- [ ] **Step 5: Add an e2e spec** under `e2e/` covering both banner states.
- [ ] **Step 6: Run `npm test` and `npm run test:e2e` → green.**
- [ ] **Step 7: Commit** — `feat(frontend,server): split the orphaned-id banner and make rejecting a match durable`

### Task 18: the repair script

**Files:**
- Create: `scripts/repair-cast-id-drift.mjs`
- Create: `scripts/tests/repair-cast-id-drift.test.mjs`

- [ ] **Step 1: Write failing unit tests for the pure helpers** — candidate ranking (using `characterSnapshots`' `tone`/`gender`/`ageRange` and any `cast.json.bak.*` naming), and the re-render list's shape.
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement,** with these behaviours, all of which are requirements rather than suggestions:
  - **dry-run by default**; `--apply` to write;
  - **refuses `--apply` if a server is reachable** on the configured port — it writes `cast.json` out-of-process, which no in-process lock covers (spec §10);
  - writes `cast.json.bak.id-drift-<date>` before any change;
  - auto-records only Tier A / Tier B matches; reports everything else;
  - emits the re-render list (book, chapter, id, segment count, approximate duration).
- [ ] **Step 4: Run `npm run test:scripts` → green.**
- [ ] **Step 5: Run the script in DRY-RUN against the real workspace.** Expected: it proposes aliases for the drifted ids and reports the 24 unattributed segments (`silveny` 17, `lady-alina` 6, `sir-harding` 1) as needing a decision. **Do not pass `--apply` without the repo owner's explicit go-ahead** — it mutates real books.
- [ ] **Step 6: Commit** — `chore(scripts): add the cast id-drift repair pass`

### Task 19: documentation and the shipping checklist

**Files:**
- Create: `docs/features/278-cast-character-identity.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`, `CLAUDE.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/testing/onbox-acceptance-register.md`

- [ ] **Step 1: Write the regression plan** — invariants, the manual acceptance walkthrough, and the canonical fixture. Status `active`.
- [ ] **Step 2: Add the INDEX entry.**
- [ ] **Step 3: Add the invariant to `CLAUDE.md` "Conventions worth preserving"** — cast.json is the identity of record; any path changing a persisted id records the old one; the analyzer id is an alias.
- [ ] **Step 4: Append to both release-notes files** — technical entry plus a brand-voice user-facing line.
- [ ] **Step 5: Add an on-box acceptance row** for the wave-3 repair run against the real workspace, which cannot be proven in CI. Update the register, the run sheet, and the live HTML register via its recorded URL.
- [ ] **Step 6: Run `npm run check:onbox-register` → green.**
- [ ] **Step 7: Commit** — `docs(docs): add plan 278 and record the cast-identity invariant`

### Task 20: final gate

- [ ] **Step 1:** `npm run verify` (full local battery) → green.
- [ ] **Step 2:** Push and open the PR with `Closes #2040`.
- [ ] **Step 3:** Confirm cloud `verify.yml` and `pr-issue-link.yml` are green.
- [ ] **Step 4:** Run the mandatory independent `code-review` pass, triage findings, fold before merge.

---

## Self-review notes

- **Spec coverage.** §4.1 → Tasks 2, 6, 9. §4.2 → Tasks 1, 10. §4.3 → Tasks 3, 4,
  5. §4.4 → Tasks 8, 9, 10, 11, 12, 14. §4.5 → Task 13. §4.6 → Tasks 16, 17.
  §4.7 → Task 18. §5 → tests inside each task. §8 → Task 19.
- **Known gap, deliberate.** Spec §11 Q3 (moving the analysis-cache write after
  the remap) has no task. Cache drift stays masked rather than stopped. File it
  as a follow-up issue during Task 19 rather than widening this plan.
- **Type consistency.** `buildCastResolver` returns `CastResolution | undefined`
  everywhere; callers use `?.character`. `remapFreshToPriorIds` returns
  `{ characters, sentences, rewrites }` in Tasks 10 and 11 alike.
