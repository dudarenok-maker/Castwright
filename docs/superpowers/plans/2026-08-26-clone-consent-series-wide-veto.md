# Clone-Consent Series-Wide Veto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining clone-consent TOCTOU/scope gaps tracked on #2006 (srv-81) by making both `voices.ts`'s `applyOverrideToCastFiles` (base-voice override) and `qwen-voice.ts`'s `persistEmotionVariant` (emotion-variant) refuse a write the instant a clone exists **anywhere in the linked series**, not just in the requesting book — checked fresh immediately before the write, not trusted from a stale pre-GPU snapshot — while leaving every other engine, every other route, and `forEachMatchingCastCharacter`'s shared signature untouched.

**Architecture:** One already-exported/soon-to-be-exported predicate, `hasClonedSlotAmongMatches` (`voices.ts`), is reused at four call sites (two upfront pre-GPU checks, two write-time re-checks) instead of the book-local `characterHasClonedSlot` test each currently uses. Both write functions add a residual-window backstop inside their per-book mutate closure (the walk still takes nonzero time after the fresh scan passes) and both callers of each write function branch on its new typed outcome instead of assuming success. A new `clonedElsewhereInSeries` field on the `Character` API shape lets the two frontend gates mirror the same rule. No lock-model change (best-effort, not fully atomic — #2000 §3.2 stays out of scope), no change to `forEachMatchingCastCharacter`'s signature or its other two callers.

**Tech Stack:** TypeScript, Express, Vitest (server), React + Redux Toolkit + Vitest/RTL (frontend), OpenAPI (`openapi.yaml` → `npm run openapi:types`).

**Spec:**
- `docs/superpowers/specs/2026-08-22-clone-consent-voices-override-refusal-design.md` (v2 — `voices.ts`/`applyOverrideToCastFiles`, `cast-design.ts:544`, frontend `clonedElsewhereInSeries`)
- `docs/superpowers/specs/2026-08-26-clone-consent-qwen-voice-refusal-design.md` (v5 — `qwen-voice.ts`/`persistEmotionVariant`, both its call sites)

Both specs travel with this plan — read the relevant section before starting a task; this plan does not restate their rationale, only the concrete diffs.

## Global Constraints

- **No signature change to `forEachMatchingCastCharacter`** (`server/src/routes/voices.ts:779-861`) or its `mutate` parameter — both specs commit to this explicitly; its other two callers (`applyTierToCastFiles`, `ensureCharacterVoiceUuid`'s `stamp`) are out of scope.
- **Not fully atomic.** Every fresh series-wide check races the walk that follows it; the residual window is closed by a per-book backstop inside the mutate closure, not by a lock. Do not reach for `#2000 §3.2`'s workspace-lock model — it is explicitly out of scope for this work.
- **No artifact teardown on refusal, anywhere.** A refused write never deletes an already-minted `.pt`/embedding — see the qwen-voice spec's "Why the just-minted artifact is left alone" for why.
- **`otherThanEngine` stays specific to `voices.ts`'s own SET-branch asymmetry** — every new call site in this plan passes it as `undefined` except `applyOverrideToCastFiles`'s own existing SET branch.
- **One user-facing refusal message per concern, reused everywhere it fires**: `clonedVariantRefusal` (qwen-voice.ts) for the variant path, the (new) book-agnostic base-voice message for the base-voice path — never a third, slightly-different wording at a new call site.
- **This branch is ~12 lines behind `main`** in `qwen-voice.ts` (missing #2246's `language_unset` block) as of the specs' own citations. Most of this plan's own citations were independently re-verified against the worktree on 2026-08-26 by directly reading the files, not by trusting the specs — but not uniformly: `qwen-voice.test.ts:1504-1660ish` (Task 5) and `openapi.yaml`'s exact insertion line (Task 9) are approximate. Re-verify any citation you're about to act on against the actual working tree first regardless of what this plan claims.
- **Every task that changes a shared function's return type must update every existing call site and every existing test that consumes the old shape in the same commit.** This plan's own enumeration (Task 2) was checked against a mandatory review pass and still initially missed `server/src/routes/variant-propagation.test.ts`, which imports both `applyOverrideToCastFiles` and `persistEmotionVariant` via `typeof import(...)` type aliases — now called out explicitly in Task 2 and Task 5. Grep again before committing regardless (`grep -rln "applyOverrideToCastFiles\|persistEmotionVariant" server/src --include=*.ts`); a missed call site is a build break, not a design gap.
- **A cloned character in a series book whose cast isn't yet confirmed (`castConfirmed: false`) must still be refused — a decision the user made explicitly.** `hasClonedSlotAmongMatches`'s series/workspace scan skips any book (including potentially the caller's own) whose `state.castConfirmed` is false, matching its existing scanning convention everywhere else. Left unpatched, that would let a cloned-but-unconfirmed character's design attempt silently pass the upfront gate it used to fail (today's plain `characterHasClonedSlot(character)` check has no such filter). Fixed by keeping that plain, unconditional check as a first-line OR alongside the new series-wide call at all FOUR upfront sites (Tasks 3, 4, 7, 8): `characterHasClonedSlot(character) || await hasClonedSlotAmongMatches(...)`. The two write-time fresh checks (Task 2's inside `applyOverrideToCastFiles`, Task 6's inside `persistEmotionVariant`'s series branch) do NOT need the same patch: `forEachMatchingCastCharacter`'s own walk applies the identical `castConfirmed` filter to what it will actually WRITE to, so an unconfirmed caller's own book can never be silently overwritten there regardless of what the upfront gate caught — the castConfirmed gap only ever affected the upfront refusal (GPU-waste + user-facing message), never cast.json integrity.
- **`otherThanEngine` asymmetry between the upfront and write-time checks is deliberate, not a bug — but it means the two layers are not equivalent.** Every upfront check this plan adds (Tasks 3, 7, 8) passes `otherThanEngine: undefined` (any clone-capable engine blocks). The write-time check inside `applyOverrideToCastFiles` (Task 2) is called with `otherThanEngine = override.engine` (`'qwen'` for every design caller), which — per `voices.ts`'s existing SET-branch asymmetry — excludes a qwen-clone from consideration. Net effect: the upfront gate is strictly *more* conservative than the write-time gate behind it, so a real qwen-cloned-on-a-sibling-book character is always caught upstream and the write-time `applyOverrideToCastFiles` path can only be exercised for that exact case via a mock, never a real fixture (a coqui-cloned-sibling fixture exercises it for real). This is safe (over-inclusive refusal, never under-inclusive) but is a real constraint on what the write-time tests in Tasks 2/3/4 can prove with real fixtures vs. mocks — don't try to "fix" this asymmetry by loosening the upfront check.

---

## File Structure

| File | Responsibility in this plan |
|---|---|
| `server/src/routes/voices.ts` | Export `hasClonedSlotAmongMatches`; new batched `findClonedVoiceIdsAmongMatches`; `applyOverrideToCastFiles` gains the fresh series-wide check + typed `{updated, skipped}` return + residual backstop; its own route handler updated for the new shape. |
| `server/src/routes/single-design.ts` | Upfront check upgraded to series-wide; write-time `{updated, skipped}` outcome now wired to a `clone_protected` SSE error instead of discarded. |
| `server/src/routes/cast-design.ts` | New branch at the base-voice call site (`:544`) mirroring the variant branch; base AND variant upfront checks (`:402-412`, `:430-440`) both upgraded to series-wide; variant write-time call (`:555`) branches on `persistEmotionVariant`'s new outcome. |
| `server/src/routes/qwen-voice.ts` | `persistEmotionVariant` return type becomes a 3-state union; book-scoped and series-scoped branches both gain a fresh/residual clone check; `clonedVariantRefusal` reworded; JSON route's upfront check and write-time integration both upgraded. |
| `server/src/routes/book-state.ts` | `GET /:bookId/state` computes `clonedElsewhereInSeries` per character via ONE batched scan per request; `PUT /:bookId/state`'s two cast-merge normalisers strip the field so it can't round-trip into `cast.json`. |
| `openapi.yaml` / `src/lib/api-types.ts` | New `clonedElsewhereInSeries: boolean` field on `Character`; new/previously-undocumented `200`/`409` responses on `PUT /api/voices/{voiceId}/override`; `clone_protected` added to `SingleDesignEvent.code`. |
| `src/modals/profile-drawer.tsx`, `src/components/emotion-variant-designer.tsx` | Both clone gates read the new field in addition to the existing book-local provenance check; copy reworded. |

Existing test files touched: `server/src/routes/voices.test.ts`, `server/src/routes/single-design.test.ts`, `server/src/routes/cast-design.test.ts`, `server/src/routes/qwen-voice.test.ts`, `server/src/routes/book-state.test.ts`, `server/src/routes/openapi-design-parity.test.ts` (registers the new `clone_protected` code — Task 3), `server/src/routes/variant-propagation.test.ts` (re-run only, not edited — Task 2/5 confirm it), plus new/updated frontend tests for the two gated components.

---

### Task 1: Export `hasClonedSlotAmongMatches` and fix its stale doc comment

**Files:**
- Modify: `server/src/routes/voices.ts:588-645`
- Test: `server/src/routes/voices.test.ts` (new, small, at the end of the existing `describe('GET /api/voices...')` block or its own top-level `describe`)

**Interfaces:**
- Produces: `export async function hasClonedSlotAmongMatches(voiceId: string, seriesFilter?: { author: string; series: string }, otherThanEngine?: TtsEngine, onlyBookDir?: string): Promise<boolean>` — exported, AND gains a 4th parameter (see Step 3a below — found necessary under review, not present in either source spec). Every later task in this plan imports this from `./voices.js`.

**This task also closes a scope-mismatch defect found under review, beyond a bare export.** `hasClonedSlotAmongMatches` originally took no book-scoping parameter at all — every call is either workspace-wide or series-wide. But `forEachMatchingCastCharacter` (the function whose write this predicate gates) has a THIRD mode: when `seriesFilter` is absent and `onlyBookDir` is given, it scans only that one book (`voices.ts:809-826`) — the fs-61 guard against a bare shared id like `narrator` silently matching an unrelated standalone book elsewhere in the workspace. Every upfront/write-time check this plan adds for a standalone book (Tasks 2, 3, 4, 7, 8) calls with `seriesFilter: undefined`, which — without this fix — would make the CHECK scan the whole workspace even though the WRITE it's gating is correctly scoped to one book. That reopens exactly the hole fs-61 closed, one layer up, at the gate instead of the write: a user designing a voice in one standalone book could be refused because an unrelated standalone book elsewhere in the workspace happens to share the bare id and carries a clone. Step 3a below adds a matching `onlyBookDir` special case to `hasClonedSlotAmongMatches` itself, mirroring `forEachMatchingCastCharacter`'s own condition exactly, so every caller downstream (Tasks 2-4, 7-8) can pass the same `onlyBookDir` it already has in scope and get the correctly-narrowed check.

- [ ] **Step 1: Write the failing test — the function is importable from outside `voices.ts`**

```ts
// server/src/routes/voices.test.ts (add near the top-level describes, after existing imports)
it('hasClonedSlotAmongMatches is exported for reuse by qwen-voice.ts and single-design.ts', async () => {
  const mod = await import('./voices.js');
  expect(typeof mod.hasClonedSlotAmongMatches).toBe('function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run server/src/routes/voices.test.ts -t "hasClonedSlotAmongMatches is exported"`
Expected: FAIL — `mod.hasClonedSlotAmongMatches` is `undefined` (the function exists but is not exported).

- [ ] **Step 3: Export the function ONLY — no behavioural change yet**

At `voices.ts:615`, change just the declaration:

```ts
async function hasClonedSlotAmongMatches(
```

to:

```ts
export async function hasClonedSlotAmongMatches(
```

Leave the body exactly as it is today — the `onlyBookDir` fix is a separate step (Step 6) with its own failing test (Step 5), so this task stays test-first at each behavioural change rather than implementing ahead of its test.

- [ ] **Step 3b: Make the export actually callable from this file's own tests**

`voices.test.ts` does not use plain top-level imports for functions under test — it binds them via module-scope `let` declarations assigned inside its own `beforeAll` from a single dynamic `import('./voices.js')` (`voices.test.ts:65`, `:147-153`: `const { …, applyOverrideToCastFiles: aotcf } = await import('./voices.js'); applyOverrideToCastFiles = aotcf;`). A bare `hasClonedSlotAmongMatches(...)` call in a test body will be a `ReferenceError` unless it follows the same pattern. Add, alongside the existing declarations:

```ts
// near voices.test.ts:65
let hasClonedSlotAmongMatches: typeof import('./voices.js').hasClonedSlotAmongMatches;
```

and in the `beforeAll` at `:147-153`, extend the destructuring and assignment:

```ts
const { voicesRouter, applyTierToCastFiles: atcf, applyOverrideToCastFiles: aotcf, hasClonedSlotAmongMatches: hcsam } =
  await import('./voices.js');
// ...
hasClonedSlotAmongMatches = hcsam;
```

(Task 9 adds `findClonedVoiceIdsAmongMatches` to this same pattern when it introduces that function.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run server/src/routes/voices.test.ts -t "hasClonedSlotAmongMatches is exported"`
Expected: PASS.

- [ ] **Step 5: Write a failing test for the scope-mismatch defect, against REAL isolated fixtures — and confirm it actually fails**

`hasClonedSlotAmongMatches` originally took no book-scoping parameter — every call is either workspace-wide or series-wide. But `forEachMatchingCastCharacter` (the function whose write this predicate gates) has a THIRD mode: when `seriesFilter` is absent and `onlyBookDir` is given, it scans only that one book (`voices.ts:809-826`) — the fs-61 guard against a bare shared id like `narrator` silently matching an unrelated standalone book elsewhere in the workspace. Every upfront/write-time check this plan adds for a standalone book (Tasks 2, 3, 4, 7, 8) calls with `seriesFilter: undefined` — without a matching fix here, the CHECK would scan the whole workspace even though the WRITE it gates stays correctly single-book-scoped, reopening fs-61's hole one layer up.

Mint two dedicated, fresh, isolated standalone books via this file's own `writeBookOnDisk` helper (`voices.test.ts:70-102`) — do NOT reuse `standaloneA`/`standaloneB` (they exist for a different describe's own fixture and neither carries a clone). Add near the top of the file, alongside the other top-level constants:

```ts
const SCOPE_TEST_AUTHOR = 'Ines Halvorsen';
```

Then the test itself:

```ts
describe('hasClonedSlotAmongMatches — onlyBookDir scope (found under review)', () => {
  let bookOneDir: string;
  let bookTwoDir: string;

  beforeEach(() => {
    bookOneDir = writeBookOnDisk(
      workspaceRoot, SCOPE_TEST_AUTHOR, 'Standalones', 'Onyx Reach', 'book-onyx',
      [{ id: 'narrator', name: 'Narrator' }], // no clone
      true,
    );
    bookTwoDir = writeBookOnDisk(
      workspaceRoot, SCOPE_TEST_AUTHOR, 'Standalones', 'Salt Line', 'book-salt',
      [{ id: 'narrator', name: 'Narrator', overrideTtsVoices: { coqui: { name: 'clone-x', provenance: 'cloned' } } }],
      true,
    );
  });

  it('with no seriesFilter but an onlyBookDir, scopes the scan to that one book — a clone in an unrelated standalone book sharing the same bare id must not cause a false refusal', async () => {
    const result = await hasClonedSlotAmongMatches('narrator', undefined, undefined, bookOneDir);
    expect(result).toBe(false);
  });
});
```

Both books are standalone and share the bare id `narrator`. `bookTwoDir`'s copy is cloned; `bookOneDir`'s is not. Because `seriesFilter` is absent, TODAY's (pre-fix) 3-parameter function ignores `onlyBookDir` and falls all the way through to the workspace-wide triple loop — and critically, its `if (seriesFilter) { if (state.isStandalone === true) continue; ... }` guard only runs when `seriesFilter` is truthy, so with `seriesFilter` absent NEITHER standalone book is excluded from the scan. The scan reaches `bookTwoDir`'s cloned `narrator` and returns `true` — this test's `expect(result).toBe(false)` genuinely fails against the current 3-parameter function.

Run: `npm run test -- --run server/src/routes/voices.test.ts -t "onlyBookDir scope"`
Expected: **FAIL** (confirms the test is red against the real, current, unfixed code — not vacuously passing either way, which is what an earlier revision of this task shipped and a review pass caught).

- [ ] **Step 6: Implement the `onlyBookDir` special case, mirroring `forEachMatchingCastCharacter`'s own condition exactly**

At `voices.ts:615-645`, change the signature and body:

```ts
async function hasClonedSlotAmongMatches(
  voiceId: string,
  seriesFilter?: { author: string; series: string },
  otherThanEngine?: TtsEngine,
): Promise<boolean> {
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        if (seriesFilter) {
          if (state.isStandalone === true) continue;
          if (state.author !== seriesFilter.author || state.series !== seriesFilter.series) continue;
        }
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        for (const c of cast.characters) {
          if ((c.voiceId ?? c.id) !== voiceId) continue;
          const cloned = otherThanEngine
            ? CLONE_ENGINE_LIST.some(
                (e) => e !== otherThanEngine && hasClonedProvenance(c, e),
              )
            : characterHasClonedSlot(c);
          if (cloned) return true;
        }
      }
    }
  }
  return false;
}
```

to (this is the 3a fix — the new branch mirrors `forEachMatchingCastCharacter`'s own condition at `voices.ts:809`, `!seriesFilter && onlyBookDir`, exactly):

```ts
export async function hasClonedSlotAmongMatches(
  voiceId: string,
  seriesFilter?: { author: string; series: string },
  otherThanEngine?: TtsEngine,
  onlyBookDir?: string,
): Promise<boolean> {
  const cloned = (c: CastCharacter): boolean =>
    otherThanEngine
      ? CLONE_ENGINE_LIST.some((e) => e !== otherThanEngine && hasClonedProvenance(c, e))
      : characterHasClonedSlot(c);

  /* Mirrors forEachMatchingCastCharacter's own onlyBookDir special case
     (voices.ts:809) exactly: a caller with no series context must not fall
     through to a workspace-wide scan on a bare character id (fs-61) — that
     would make THIS predicate refuse across unrelated standalone books even
     though the write it gates stays correctly single-book-scoped. */
  if (!seriesFilter && onlyBookDir) {
    const cast = await readJson<CastJson>(castJsonPath(onlyBookDir));
    if (!cast?.characters?.length) return false;
    for (const c of cast.characters) {
      if ((c.voiceId ?? c.id) !== voiceId) continue;
      if (cloned(c)) return true;
    }
    return false;
  }

  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        if (seriesFilter) {
          if (state.isStandalone === true) continue;
          if (state.author !== seriesFilter.author || state.series !== seriesFilter.series) continue;
        }
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        for (const c of cast.characters) {
          if ((c.voiceId ?? c.id) !== voiceId) continue;
          if (cloned(c)) return true;
        }
      }
    }
  }
  return false;
}
```

Replace the comment above it (`voices.ts:588-614`, currently scoped to "the clear branch below" and one caller) with:

```ts
/* Read-only scan: does any confirmed-cast character matching `voiceId`
   (optionally scoped to a series, optionally excluding one engine) carry a
   consented cloned voice? Exported — reused by:
     - this file's own PUT /:voiceId/override (both the CLEAR and SET
       upfront checks, and applyOverrideToCastFiles's own fresh write-time
       check, all below);
     - single-design.ts's upfront gate;
     - qwen-voice.ts's persistEmotionVariant (write-time) and its two
       callers' upfront checks.
   Walks the SAME (workspace- or series-scoped) match set
   forEachMatchingCastCharacter does, but read-only — deliberately NOT
   implemented by reusing forEachMatchingCastCharacter itself (which always
   persists, even for a no-op mutate) — a validation pass must not touch disk.

   `otherThanEngine` serves ONLY voices.ts's own SET-branch asymmetry (a SET
   pins `ttsEngine` to the incoming engine, so a clone on a DIFFERENT
   clone-capable engine would go inert — see the SET branch below); every
   other caller passes it as `undefined`, meaning "any clone-capable engine
   counts".

   `onlyBookDir` scopes the scan to exactly one book when `seriesFilter` is
   absent — mirrors forEachMatchingCastCharacter's own special case
   (voices.ts:809) so a caller with no series context (a standalone book)
   gets a book-scoped check instead of an accidental workspace-wide one on a
   bare shared id (fs-61). Ignored whenever `seriesFilter` is present, same
   as forEachMatchingCastCharacter. */
```

- [ ] **Step 7: Run the test to verify it now passes**

Run: `npm run test -- --run server/src/routes/voices.test.ts -t "onlyBookDir scope"`
Expected: PASS.

- [ ] **Step 8: Run the full voices.ts test file to confirm no regression**

Run: `npm run test -- --run server/src/routes/voices.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts
git commit -m "refactor(server): export hasClonedSlotAmongMatches, add its onlyBookDir scope"
```

---

### Task 2: `applyOverrideToCastFiles` — series-wide fresh check + typed return + residual backstop

**Files:**
- Modify: `server/src/routes/voices.ts:731` (route handler call site), `server/src/routes/voices.ts:875-954` (`applyOverrideToCastFiles`)
- Modify: `openapi.yaml` (the `PUT /api/voices/{voiceId}/override` path's response documentation)
- Test: `server/src/routes/voices.test.ts` (new tests + migrate ~7 existing call sites off the old `Promise<number>` shape)

**Interfaces:**
- Consumes: `hasClonedSlotAmongMatches` (Task 1), `forEachMatchingCastCharacter` (unchanged, `voices.ts:779`), `characterHasClonedSlot`/`hasClonedProvenance`/`CLONE_ENGINE_LIST` (already imported at `voices.ts:67-70`).
- Produces: `applyOverrideToCastFiles(voiceId, override, seriesFilter?, onlyBookDir?): Promise<{ updated: number; skipped: Array<{ bookDir: string; characterId: string; reason: string }> }>` — **breaking change** from today's `Promise<number>`. Tasks 3 and 4 depend on this exact shape.
- **Also consumed (not just produced) by `server/src/routes/variant-propagation.test.ts:30-31, :188`**, which type-aliases `typeof import('./voices.js').applyOverrideToCastFiles` and `typeof import('./qwen-voice.js').persistEmotionVariant`. Neither alias captures or asserts on a return value in that file, so this change does not require an edit there, but run its suite in Step 6 anyway to confirm — this file was missed by this plan's own first-pass enumeration and only surfaced under review.

- [ ] **Step 1: Write the failing tests (new behavior)**

Add to `voices.test.ts`, near the existing `describe('applyOverrideToCastFiles — standalone book-scoping (fs-61)', ...)` block:

```ts
describe('applyOverrideToCastFiles — series-wide veto (v2)', () => {
  /* Fresh, dedicated fixture — do NOT reuse AUTHOR/SERIES/BOOK_ONE/BOOK_TWO
     (voices.test.ts:30-33): those books' cast.json already has fixed
     characters (char-brann / v_brann) seeded once in this file's top-level
     beforeAll and read by ~8 other describes; `setOverrideOnDisk` can only
     rewrite an EXISTING character's override, it cannot mint a character
     with a NEW voiceId like 'shared-voice-id'. This describe mints its own
     two books via this file's `writeBookOnDisk` helper (:70-102), each
     seeded with two characters whose ids/voiceIds this describe controls
     directly, and rewrites both books fresh in `beforeEach` so no test can
     leak state into another. */
  const VETO_AUTHOR = 'Petra Solberg';
  const VETO_SERIES = 'The Amber Coast';
  const VETO_BOOK_ONE = 'First Light';
  const VETO_BOOK_TWO = 'Second Light';
  let bookOneDir: string;
  let bookTwoDir: string;

  function seedVetoBooks(bookOneCloned: boolean, bookTwoCloned: boolean) {
    const charFor = (cloned: boolean) => [
      {
        id: 'shared',
        name: 'Shared',
        voiceId: 'shared-voice-id',
        ...(cloned ? { overrideTtsVoices: { coqui: { name: 'clone-x', provenance: 'cloned' } } } : {}),
      },
      { id: 'uncloned', name: 'Uncloned', voiceId: 'uncloned-voice-id' },
    ];
    bookOneDir = writeBookOnDisk(
      workspaceRoot, VETO_AUTHOR, VETO_SERIES, VETO_BOOK_ONE, 'book-veto-one',
      charFor(bookOneCloned),
    );
    bookTwoDir = writeBookOnDisk(
      workspaceRoot, VETO_AUTHOR, VETO_SERIES, VETO_BOOK_TWO, 'book-veto-two',
      charFor(bookTwoCloned),
    );
  }

  it('refuses the ENTIRE propagation when a clone exists on a sibling book, not just that book', async () => {
    seedVetoBooks(true, false); // book one's 'shared' is cloned; book two's is not
    const result = await applyOverrideToCastFiles(
      'shared-voice-id',
      { engine: 'qwen', name: 'qwen-new-pick' },
      { author: VETO_AUTHOR, series: VETO_SERIES },
    );
    expect(result.updated).toBe(0);
    expect(result.skipped).toEqual([
      { bookDir: '(series-wide)', characterId: 'shared-voice-id', reason: 'already_cloned' },
    ]);
    // Neither book was written — this is the corrected v2 behavior; v1 would
    // have written book two and only skipped book one.
    const bookTwo = readCastFromDisk(workspaceRoot, VETO_AUTHOR, VETO_SERIES, VETO_BOOK_TWO);
    expect(
      (bookTwo.characters[0].overrideTtsVoices as { qwen?: { name?: string } } | undefined)?.qwen
        ?.name,
    ).toBeUndefined();
  });

  it('with a seriesFilter AND onlyBookDir both set (the real single-design.ts/cast-design.ts shape), the refusal is still "(series-wide)", not the caller\'s own book — onlyBookDir is not a scoping parameter once seriesFilter is present', async () => {
    seedVetoBooks(true, false);
    const result = await applyOverrideToCastFiles(
      'shared-voice-id',
      { engine: 'qwen', name: 'qwen-new-pick' },
      { author: VETO_AUTHOR, series: VETO_SERIES },
      bookOneDir, // present, but forEachMatchingCastCharacter ignores it whenever seriesFilter is set
    );
    expect(result.skipped[0].bookDir).toBe('(series-wide)');
  });

  it('with onlyBookDir set and NO seriesFilter (the genuine single-book case), the refusal entry names that exact book', async () => {
    seedVetoBooks(true, false);
    const result = await applyOverrideToCastFiles(
      'shared-voice-id',
      { engine: 'qwen', name: 'qwen-new-pick' },
      undefined,
      bookOneDir,
    );
    expect(result.skipped[0].bookDir).toBe(bookOneDir);
  });

  it('proceeds and reports updated>0, skipped:[] when no clone exists anywhere in the match set', async () => {
    seedVetoBooks(false, false);
    const result = await applyOverrideToCastFiles(
      'uncloned-voice-id',
      { engine: 'qwen', name: 'qwen-pick' },
      { author: VETO_AUTHOR, series: VETO_SERIES },
    );
    expect(result.updated).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
  });

  it('residual-window case: a clone injected after the fresh scan but before the walk reaches that book lands in skipped, other books still update', async () => {
    /* Critical fixture requirement, found under review: seed NEITHER book
       cloned. If book two starts cloned, the FRESH series-wide check (which
       runs before forEachMatchingCastCharacter's walk even starts) refuses
       the whole call immediately and the walk this test is trying to
       instrument never runs at all — an earlier revision of this test made
       exactly that mistake and the interception it scripted below was
       unreachable. The clone must be injected mid-walk, not pre-seeded. */
    seedVetoBooks(false, false);

    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const bookTwoCastPath = join(bookTwoDir, '.audiobook', 'cast.json');
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let callsForBookTwoPath = 0;
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (path !== bookTwoCastPath) return actual.readJson(path);
      callsForBookTwoPath += 1;
      // Call #1 is the fresh hasClonedSlotAmongMatches scan's read — let it
      // through unheld (book two has no clone yet at this point, by design
      // above). Call #2 is forEachMatchingCastCharacter's own per-book read
      // inside its lock — hold THAT one open so the direct writer below can
      // land first.
      if (callsForBookTwoPath === 2) {
        intercepted = true;
        await gate;
      }
      return actual.readJson(path);
    });

    let resultPromise: ReturnType<typeof applyOverrideToCastFiles> | undefined;
    try {
      resultPromise = applyOverrideToCastFiles(
        'shared-voice-id',
        { engine: 'qwen', name: 'qwen-new-pick' },
        { author: VETO_AUTHOR, series: VETO_SERIES },
      );
      const deadline = Date.now() + 2000;
      while (!intercepted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(intercepted).toBe(true);

      // Write the clone marker directly to disk while book two's read is held.
      setOverrideOnDisk(workspaceRoot, VETO_AUTHOR, VETO_SERIES, VETO_BOOK_TWO, {
        coqui: { name: 'clone-x', provenance: 'cloned' },
      });
      released();
    } finally {
      released();
      spy.mockImplementation(actual.readJson);
      await resultPromise?.catch(() => {});
    }

    const result = await resultPromise!;
    expect(result.updated).toBeGreaterThan(0); // book one still got it
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ characterId: 'shared-voice-id', reason: 'already_cloned' }),
    );
    const bookOne = readCastFromDisk(workspaceRoot, VETO_AUTHOR, VETO_SERIES, VETO_BOOK_ONE);
    expect(
      (bookOne.characters[0].overrideTtsVoices as { qwen?: { name?: string } } | undefined)?.qwen?.name,
    ).toBe('qwen-new-pick');
    const bookTwo = readCastFromDisk(workspaceRoot, VETO_AUTHOR, VETO_SERIES, VETO_BOOK_TWO);
    expect(
      (bookTwo.characters[0].overrideTtsVoices as { qwen?: { name?: string } } | undefined)?.qwen?.name,
    ).toBeUndefined(); // book two's own residual backstop declined the write
  });
  /* Load-bearing and worth stating: this test's premise — that book one is
     written before the walk reaches book two, so gating book two's read
     proves something about a book visited AFTER an unrelated write —
     depends on `forEachMatchingCastCharacter`'s directory walk visiting
     'First Light' before 'Second Light'. `listDirs` (voices.ts) is presumed
     to return entries in a stable, sorted order (as this file's own
     pre-existing race tests, e.g. 'workspace walk: a concurrent
     propagation...', already rely on) — this is not a new assumption this
     task introduces, but re-verify it holds if `listDirs`'s ordering ever
     changes. */

  it('mutation-verified: deleting the fresh series-wide check turns the sibling-clone test red', () => {
    /* Not automated — run by hand once, per this repo's testing discipline
       (paired mutation verification, not a permanent test). Comment out the
       `if (await hasClonedSlotAmongMatches(...)) { return {...}; }` block at
       the top of applyOverrideToCastFiles, re-run
       `npm run test -- --run server/src/routes/voices.test.ts -t "refuses the ENTIRE propagation"`,
       confirm it goes red (book two would now get `updated` and the sibling
       clone would be silently overwritten), capture that failure output,
       then restore the code and confirm the test is green again. Paste the
       captured red-run output into the PR description. */
  });
});
```

**Note for the implementer:** the mutation-verification item above has no automated body by design (it verifies the *absence* of a guard, which can't be asserted as a standing test without deleting the guard permanently) — its instructions are the deliverable, and the PR body must show the captured failure output per this repo's testing discipline. Every OTHER test in this block, including the residual-window one, has a real, executable body above — do not leave any of them as comment-only stubs; Vitest passes an empty `it()` body silently, which is indistinguishable from a real assertion in CI output.

This block's fixture went through two revisions under review. The first assumed `setOverrideOnDisk`/`readCastFromDisk` and this file's shared `AUTHOR`/`SERIES`/`BOOK_ONE`/`BOOK_TWO` fixture (voices.test.ts:30-33) could seed characters with custom voiceIds like `'shared-voice-id'` — they cannot; `setOverrideOnDisk` only rewrites an *existing* character's override field, and that shared fixture's characters are fixed (`char-brann`/`v_brann`) and consumed by ~8 other describes with no safe way to add new ids to it. The revision above instead mints two fully dedicated books via `writeBookOnDisk` (`voices.test.ts:70-102`, real signature: `writeBookOnDisk(workspace, author, series, title, bookId, characters, isStandalone = false)`, returns the bookDir) inside each test itself (or a shared `seedVetoBooks` helper), so every test controls its own character ids and clone state directly rather than depending on a fixture built for a different describe. A second, independent bug the first revision's residual-window test carried: it pre-seeded book two's `'shared-voice-id'` as ALREADY cloned in its own `beforeEach`, which means the FRESH series-wide check (which runs before the walk even starts) refuses the whole call immediately — the interception this test scripts against `forEachMatchingCastCharacter`'s own read is never reached, because that function is never called. The revision above seeds neither book cloned and injects the clone only during the held read, which is the only way to actually reach the walk's own per-book backstop. `writeBookOnDisk`, `readCastFromDisk`, and `setOverrideOnDisk` are real, top-level, module-scope helpers in this file (`:70-102`, `:104-107`, `:126-139`) — verify them against the actual current file before writing code regardless, the same caution this whole plan's revision history keeps re-learning.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm run test -- --run server/src/routes/voices.test.ts -t "series-wide veto"`
Expected: FAIL — `result.updated` etc. are `undefined` today (`applyOverrideToCastFiles` still returns a bare number).

- [ ] **Step 3: Implement the fresh check + typed return + residual backstop**

Replace `applyOverrideToCastFiles` (`voices.ts:875-954`) with:

```ts
export async function applyOverrideToCastFiles(
  voiceId: string,
  override: { engine: TtsEngine; name: string } | null,
  seriesFilter?: { author: string; series: string },
  onlyBookDir?: string,
): Promise<{ updated: number; skipped: Array<{ bookDir: string; characterId: string; reason: string }> }> {
  const otherThanEngine = override === null ? undefined : override.engine;
  /* Which sentinel a caller gets right: forEachMatchingCastCharacter's own
     branch at voices.ts:809 only honours `onlyBookDir` when `seriesFilter`
     is ABSENT — with a seriesFilter present it always runs the general
     multi-book walk regardless of onlyBookDir (voices.ts:827-861). Both
     single-design.ts and cast-design.ts pass BOTH a seriesFilter AND
     job.bookDir, so `onlyBookDir` does NOT mean "this call touches exactly
     that book" whenever seriesFilter is set — using it as a per-entry label
     in that case would name the WRONG book (the caller's own, when the
     clone could be on any matched sibling). Only compute a real single-book
     label when seriesFilter is absent, matching forEachMatchingCastCharacter's
     own condition exactly. */
  const singleBookDir = !seriesFilter ? onlyBookDir : undefined;
  /* v2 — fresh, series-wide re-check immediately before any write, replacing
     the caller's stale pre-scan. Refuses the WHOLE propagation on a hit —
     no book is written — rather than the v1 per-book-independent contract.
     See docs/superpowers/specs/2026-08-22-clone-consent-voices-override-
     refusal-design.md "The decision this spec finalizes". This IS a
     genuinely series-wide (or workspace-wide) verdict, not a per-book one —
     labelled accordingly rather than with the residual backstop's
     "unknown" sentinel below. */
  if (await hasClonedSlotAmongMatches(voiceId, seriesFilter, otherThanEngine, onlyBookDir)) {
    return {
      updated: 0,
      skipped: [{
        bookDir: singleBookDir ?? (seriesFilter ? '(series-wide)' : '(workspace-wide)'),
        characterId: voiceId,
        reason: 'already_cloned',
      }],
    };
  }
  const skipped: Array<{ bookDir: string; characterId: string; reason: string }> = [];
  const updated = await forEachMatchingCastCharacter(
    voiceId,
    seriesFilter,
    (original) => {
      /* Residual-window backstop: the walk still takes nonzero time after
         the fresh scan above passed. Immune to unrelated intermediate
         writes because it re-checks the FRESH per-book read
         forEachMatchingCastCharacter already did before calling this
         closure. `singleBookDir` names this entry's book ONLY in the
         genuinely single-book case (no seriesFilter, onlyBookDir set) —
         the same case forEachMatchingCastCharacter itself treats as
         single-book. Every other case (a series or workspace walk touching
         possibly-many books) can't attribute a specific book from inside
         this closure, so it uses '(unknown)' — no caller of this function
         reads `skipped[].bookDir` for logic, only `skipped.length`, so this
         is for human/API-consumer legibility, not correctness. */
      const cloned = override === null
        ? characterHasClonedSlot(original)
        : CLONE_ENGINE_LIST.some((e) => e !== override.engine && hasClonedProvenance(original, e));
      if (cloned) {
        skipped.push({ bookDir: singleBookDir ?? '(unknown)', characterId: voiceId, reason: 'already_cloned' });
        return original; // unchanged — dirty=true still fires (harmless idempotent rewrite)
      }
      const normalised = normaliseCastCharacter(original);
      const replacement: CastCharacter = { ...normalised };
      if (override === null) {
        delete replacement.overrideTtsVoices;
      } else {
        const map = { ...(normalised.overrideTtsVoices ?? {}) };
        const nextSlot = { ...(map[override.engine] ?? {}), name: override.name };
        if (!hasClonedProvenance(normalised, override.engine)) {
          delete nextSlot.libraryUuid;
          delete nextSlot.provenance;
        }
        map[override.engine] = nextSlot;
        replacement.overrideTtsVoices = map;
        replacement.ttsEngine = override.engine;
      }
      delete replacement.overrideTtsVoice;
      return replacement;
    },
    onlyBookDir,
  );
  if (updated > 0) invalidateBaseVoiceCache();
  return { updated, skipped };
}
```

(The mutate closure body after the `cloned` branch is unchanged from today's implementation — only the clone check and the wrapping return shape are new.)

- [ ] **Step 4: Update the one production call site whose destructuring changes shape — the route handler**

At `voices.ts:731-739`:

```ts
// before:
const updates = await applyOverrideToCastFiles(voiceId, parsed, seriesFilter);
if (updates === 0) {
  const where = seriesFilter
    ? `in series "${seriesFilter.author} / ${seriesFilter.series}"`
    : 'in any confirmed cast';
  return res
    .status(404)
    .json({ error: `No character with voiceId "${voiceId}" found ${where}.` });
}
res.status(204).end();

// after:
const { updated, skipped } = await applyOverrideToCastFiles(voiceId, parsed, seriesFilter);
if (updated === 0 && skipped.length === 0) {
  const where = seriesFilter
    ? `in series "${seriesFilter.author} / ${seriesFilter.series}"`
    : 'in any confirmed cast';
  return res
    .status(404)
    .json({ error: `No character with voiceId "${voiceId}" found ${where}.` });
}
if (updated === 0 && skipped.length > 0) {
  return res.status(409).json({
    error:
      `Voice "${voiceId}" has a consented cloned voice on a linked character somewhere in ` +
      `this series — the override was not applied anywhere. Reassign that character directly instead.`,
    skipped,
  });
}
if (skipped.length > 0) {
  return res.status(200).json({ updated, skipped });
}
res.status(204).end();
```

This implements the response table from the sibling spec's "Response contract for `voices.ts` `PUT /:voiceId/override`" section (204 / 200-partial / 409-with-skipped / 404, in that order).

- [ ] **Step 5: Migrate every existing test that consumes the old `Promise<number>` shape**

Grep first to catch anything this plan's own reading missed:

Run: `grep -n "applyOverrideToCastFiles(" server/src/routes/voices.test.ts`

Apply this transform at each hit that captures the return value as a bare number (confirmed present at the following; re-check the grep output for any this plan didn't enumerate):

- `voices.test.ts:1790` (`const n = await applyOverrideToCastFiles(...)`) → `const { updated: n } = await applyOverrideToCastFiles(...)` (keeps the rest of the test, which asserts `expect(n).toBe(1)`, unchanged).
- `voices.test.ts:1811` → same transform (`expect(n).toBeGreaterThanOrEqual(2)` stays as-is).
- `voices.test.ts:1916-1973` (the `overridePromise: Promise<number>` race test): change the type annotation `let overridePromise: Promise<number> | undefined;` to `let overridePromise: Promise<{ updated: number; skipped: unknown[] }> | undefined;`, and change the destructuring at the `Promise.all` site from `[n, wrote] = await Promise.all([overridePromise, personaPromise]);` to `[{ updated: n }, wrote] = await Promise.all([overridePromise, personaPromise]);` (braces added around the first destructured element; `n`'s own declaration, `let n: number;`, is unchanged).
- `voices.test.ts:2005-2069` (the `walkPromise` race test) and `voices.test.ts:2089+` (the per-book-lock test): identical transform — `Promise<number>` → `Promise<{ updated: number; skipped: unknown[] }>`, and `[n, wrote]`/`[n, writerSettled]` destructuring becomes `[{ updated: n }, wrote]` / `[{ updated: n }, writerSettled]`.
- `voices.test.ts:1615` and `:1768-1769` (calls whose return is never captured) — no change needed.

- [ ] **Step 6: Also run `variant-propagation.test.ts` — a consumer this plan's first pass missed**

Run: `npm run test -- --run server/src/routes/variant-propagation.test.ts`
Expected: PASS. This file type-aliases both `applyOverrideToCastFiles` and `persistEmotionVariant` (`typeof import(...)`) but does not capture or assert on either's return value, so no edit is expected here — this step exists to confirm that, not to skip it.

- [ ] **Step 7: Update `openapi.yaml` for `PUT /api/voices/{voiceId}/override`'s new/previously-undocumented responses**

The route's existing documentation lists only `204`/`400`/`404`. This step both documents this task's new `200` and closes a pre-existing gap the sibling spec flagged and this plan had dropped: the `409` already exists in code (`voices.ts:713`, `:724`, both pre-existing) but was never in `openapi.yaml` either. Find the path entry (`grep -n "override:" openapi.yaml` near the `/api/voices/{voiceId}/override` path item) and add, alongside the existing `204`/`400`/`404` responses:

```yaml
        '200':
          description: >-
            Applied to at least one linked character, but at least one other
            linked character was skipped (a residual-window clone, or —
            pre-existing — a same-book conflict). See `skipped`.
          content:
            application/json:
              schema:
                type: object
                required: [updated, skipped]
                properties:
                  updated: { type: integer }
                  skipped:
                    type: array
                    items:
                      type: object
                      required: [bookDir, characterId, reason]
                      properties:
                        bookDir: { type: string }
                        characterId: { type: string }
                        reason: { type: string }
        '409':
          description: >-
            Refused entirely — a consented cloned voice exists on this
            linked character somewhere in the series (or, for a SET, on a
            different clone-capable engine). No book was written.
          content:
            application/json:
              schema:
                type: object
                required: [error]
                properties:
                  error: { type: string }
                  skipped:
                    type: array
                    items:
                      type: object
                      required: [bookDir, characterId, reason]
                      properties:
                        bookDir: { type: string }
                        characterId: { type: string }
                        reason: { type: string }
```

- [ ] **Step 8: Check the frontend's `PUT /override` client for the new `200` response**

Grep `src/lib/api.ts` for the function that calls `PUT /api/voices/:voiceId/override` (search for `/override` or `setVoiceOverride`; it is `realSetVoiceOverride`, currently `Promise<void>`, throws on `!res.ok`, never calls `.json()`). Before this task, that endpoint only ever returned `204` (no body) or an error status; this task adds a `200` with a JSON body reporting a PARTIAL success (some linked books updated, some refused). Today's client silently treats the new `200` exactly like the old `204` — success, nothing read from the body — which means a user who asked to propagate a voice across a series and had it silently apply to only SOME books gets no different feedback than full success. **This is a real product gap this task's own change creates, not something to silently bless as "no change required."** Fixing the UI to surface partial success is out of scope for this backend-focused plan (it needs a UI decision this plan shouldn't make unilaterally, mirroring the same judgment-call carve-out the qwen-voice spec applied to its own analogous UI gap) — but do not close this step by declaring it a non-issue. File a follow-up issue naming the gap explicitly (per this repo's incidental-findings rule: a finding that needs a design decision is filed with the decision named, not silently deferred) rather than treating today's "any 2xx is success" behavior as sufficient.

- [ ] **Step 9: Run the full voices.ts test file**

Run: `npm run test -- --run server/src/routes/voices.test.ts`
Expected: PASS — every existing test green under the new shape, plus the new series-wide-veto tests from Step 1.

- [ ] **Step 10: Commit**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts openapi.yaml src/lib/api.ts
git commit -m "feat(server): applyOverrideToCastFiles refuses the whole propagation on a series-wide clone"
```

---

### Task 3: `single-design.ts` — series-wide upfront check + wire the write-time outcome

**Note — this task extends beyond the sibling spec's literal text.** The spec states single-design.ts's write-time behavior is "unchanged from v1: a non-empty `skipped` for its own book means refuse that job" — but direct inspection of the current code (`single-design.ts:179-184`) shows the call to `applyOverrideToCastFiles` today discards its return value entirely and unconditionally emits a `'designed'` success event, the exact defect the sibling spec fixed at `cast-design.ts:544` for the bulk job. This is the same shape, in a file this plan already touches, found during plan authoring — per this repo's incidental-findings rule it is fixed in this same round, not filed separately. The upfront check (`single-design.ts:273`) is upgraded to series-wide for the same reason `qwen-voice.ts`'s JSON route upfront check was (Task 7) — a character cloned on a sibling book is a stable, routine case, not a rare race, and leaving the upfront check book-local here would make every such attempt run a full GPU round before failing at the write-time check this task also adds.

**Files:**
- Modify: `server/src/routes/single-design.ts:103-192` (`runSingleDesign`), `single-design.ts:230-311` (route handler)
- Test: `server/src/routes/single-design.test.ts`

**Interfaces:**
- Consumes: `hasClonedSlotAmongMatches` (Task 1), `applyOverrideToCastFiles` (Task 2's new return shape).

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/routes/single-design.test.ts, new describe block after the
// existing 'single-design job — clone protection (GATE 2 fix-lane-1b)' one

describe('single-design job — series-wide clone veto (#2006)', () => {
  /* This file's own `writeBookOnDisk(dir, id)` (single-design.test.ts:50) is
     a fixed-shape helper for THIS ONE book (bookDir/BOOK_ID, characters
     c1/c2) — it takes no characters param and can't mint a sibling book, so
     don't try to reuse it for this. Write the sibling book directly,
     mirroring its exact on-disk shape (state.json + manuscript.txt +
     cast.json), in the SAME series (AUTHOR/SERIES) so
     findAuthorSeriesForBookId's real (unmocked) scan finds it. `c1` (this
     file's existing fixture character, no `voiceId` of its own — so its
     link key is the bare id `'c1'`) is the target; the sibling's character
     shares that same link key via its OWN `voiceId: 'c1'` and carries the
     clone. */
  let siblingDir: string;

  beforeEach(() => {
    siblingDir = join(workspaceRoot, 'books', AUTHOR, SERIES, 'Sibling Book');
    mkdirSync(join(siblingDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(siblingDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'sibling-book-id',
        manuscriptId: 'm_sibling-book-id',
        title: 'Sibling Book',
        author: AUTHOR,
        series: SERIES,
        seriesPosition: 2,
        isStandalone: false,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(siblingDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(siblingDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'sibling-c1', name: 'Aria (sibling)', voiceId: 'c1',
            overrideTtsVoices: { coqui: { name: 'clone-y', provenance: 'cloned' } },
          },
        ],
      }),
    );
  });

  it('refuses (409) up front when the character is cloned on a SIBLING book, not this one', async () => {
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    expect(applyOverrideStub).not.toHaveBeenCalled();
  });

  it('write-time: when applyOverrideToCastFiles reports a series-wide skip, the job ends with a clone_protected error event instead of "designed"', async () => {
    applyOverrideStub.mockResolvedValueOnce({
      updated: 0,
      skipped: [{ bookDir, characterId: 'c1', reason: 'already_cloned' }],
    });
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

    expect(res.status).toBe(200); // SSE stream itself opens fine
    const events = collectSse(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ code: 'clone_protected' });
    expect(events.some((e) => e.type === 'designed')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `npm run test -- --run server/src/routes/single-design.test.ts -t "series-wide clone veto"`
Expected: FAIL — today's code either doesn't 409 for a sibling-book clone (upfront check is book-local), or emits `'designed'` unconditionally (write-time result discarded).

- [ ] **Step 3: Update the applyOverrideStub's default return shape**

At `single-design.test.ts:31`:

```ts
// before:
const applyOverrideStub = vi.fn(async () => 1);
// after:
const applyOverrideStub = vi.fn(async () => ({ updated: 1, skipped: [] }));
```

- [ ] **Step 4: Reorder `isStandalone`/`seriesInfo` earlier and upgrade the upfront check**

**Confirm before moving anything**: this reorder is the mirror image of Task 7's move in `qwen-voice.ts` (which goes the OTHER way — moves the CHECK down rather than the series lookup up — specifically to avoid pushing a workspace scan ahead of unrelated 400 validators). The two tasks aren't inconsistent, but the safety of moving the lookup UP here, rather than moving the check DOWN as Task 7 does, depends entirely on this file's own layout: verify that every validator/early-return between the character lookup (`:256`) and the clone check's current position (`:273`) — re-check this range directly rather than trusting this citation — sits BEFORE `:256`, not between it and `:273`. As of this plan's own reading, `single-design.ts`'s three 400 validators (persona, sampleVoiceId, modelKey) sit at `:242-250`, above the character lookup, so moving the lookup up to `:256` does NOT push the scan ahead of any of them here. It DOES, however, move the scan ahead of the SSE framing (`res.flushHeaders()` etc., `:280-286`) and the `unsupported_language` early return (`:302-309`) that currently sit between the old and new positions — meaning a request for an unsupported language now pays a workspace scan before its own error, where it didn't before. This is a minor, not a blocking cost (a single directory walk, not per-character), but name it rather than silently absorb it, the same way Task 7 explicitly weighed its own version of this tradeoff.

At `single-design.ts:310-311`, the computation currently sits AFTER the clone check (`:273`) and the SSE framing (`:280-286`). Move it up, immediately after the character lookup (`single-design.ts:256`):

```ts
const isStandalone = located.state?.isStandalone === true;
const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
```

Then change the check at `single-design.ts:273-278` from:

```ts
if (!preview && characterHasClonedSlot(character)) {
  return res.status(409).json({
    error: `"${character.name ?? characterId}" already has a cloned voice and cannot be designed on Qwen without silently retargeting it off that clone.`,
    code: 'clone_protected',
  });
}
```

to:

```ts
if (!preview && (characterHasClonedSlot(character) || await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesInfo ?? undefined, undefined, bookDir))) {
  return res.status(409).json({
    error: `"${character.name ?? characterId}" has a consented cloned voice on a linked character somewhere in this series and cannot be designed on Qwen without silently retargeting it off that clone.`,
    code: 'clone_protected',
  });
}
```

Remove the now-unused `isStandalone`/`seriesInfo` computation at the old location (`:310-311`) — it's the same two lines, just moved.

- [ ] **Step 5: Wire the write-time outcome**

At `single-design.ts:174-192`, change:

```ts
const matchKey = character.voiceId ?? character.id;
await applyOverrideToCastFiles(
  matchKey,
  { engine: 'qwen', name: voiceId },
  seriesFilter,
  job.bookDir,
);
endJob(job, {
  type: 'designed',
  characterId: job.characterId,
  name: job.characterName,
  voiceId,
  url,
  voiceUuid: characterForDesign.voiceUuid,
});
```

to:

```ts
const matchKey = character.voiceId ?? character.id;
const { updated, skipped } = await applyOverrideToCastFiles(
  matchKey,
  { engine: 'qwen', name: voiceId },
  seriesFilter,
  job.bookDir,
);
if (updated === 0 && skipped.length > 0) {
  endJob(job, {
    type: 'error',
    code: 'clone_protected',
    message: `"${job.characterName}" has a consented cloned voice on a linked character somewhere in this series — the design was not persisted.`,
  });
  return;
}
endJob(job, {
  type: 'designed',
  characterId: job.characterId,
  name: job.characterName,
  voiceId,
  url,
  voiceUuid: characterForDesign.voiceUuid,
});
```

- [ ] **Step 6: Add the import**

At the top of `single-design.ts`, alongside the existing `import { applyOverrideToCastFiles } from './voices.js';` (line 30), add `hasClonedSlotAmongMatches` to that same import:

```ts
import { applyOverrideToCastFiles, hasClonedSlotAmongMatches } from './voices.js';
```

- [ ] **Step 7: Register the new `'clone_protected'` `error` event code — a mechanical guard will otherwise fail this task's own suite**

`server/src/routes/openapi-design-parity.test.ts` extracts every `type: 'error', code: '<literal>'` pair from `single-design.ts`'s source via regex and asserts the extracted set equals a hardcoded array, which it separately asserts equals `openapi.yaml`'s `SingleDesignEvent.code` enum. Step 5 just added exactly this shape (`endJob(job, { type: 'error', code: 'clone_protected', message: … })`), so both sides of that test need the new code or the whole file goes red — not only the tests this task's own Step 1 added.

1. In `openapi-design-parity.test.ts`, find the hardcoded array (`grep -n "design_failed" server/src/routes/openapi-design-parity.test.ts`) and add `'clone_protected'` to it. **Position matters**: both sides of this comparison are `.sort()`ed before comparing, so the array's literal order in the source doesn't need to match the enum's — but `'clone_protected'` alphabetically precedes `'design_failed'`, so if you're editing in place rather than appending, put it first, not last, or the `.sort()` step (not manual ordering) is what actually makes this safe either way. Simplest: just add it anywhere in the array and let `.sort()` do the work — don't try to hand-order it.
2. In `openapi.yaml`, find `SingleDesignEvent`'s `code` property (`SingleDesignEvent.code`'s `enum`, currently `[design_failed, lock-contention, not_found, unsupported_language]`) and add `clone_protected` to its `enum` list — order doesn't matter here either, for the same reason.
3. **Separately, an existing test's title is now misleading, not just its data**: `openapi-design-parity.test.ts:191`'s test title hardcodes "the four codes" (or similar wording naming today's four) — update the title's wording so it doesn't claim a count this task just changed. This is a chore the work makes owed (CLAUDE.md's incidental-findings rule), fixed in this same commit, not filed separately.
4. **Also check `openapi.yaml`'s own prose**: the codes are documented twice — once in the `enum`, once in nearby descriptive prose (`grep -n "design_failed" openapi.yaml` finds both). Update the prose list too, in the same edit, so the two don't drift.
5. **A comment in `openapi-design-parity.test.ts` (near `:192-199`) explains that `clone_protected` is deliberately excluded from the regex-matched set because it names "the unrelated plain-JSON 409"** — the pre-existing upfront gate's `res.status(409).json({ error, code: 'clone_protected' })` shape, which the regex's `type: 'error', code: '...'` pattern was never meant to catch. This task adds a SECOND, legitimate use of the same code string, in a DIFFERENT shape (`endJob(job, { type: 'error', code: 'clone_protected', ... })`, an SSE event) — which the regex DOES match. Both are correct; `clone_protected` now genuinely appears in this file via two distinct response shapes for two distinct moments (upfront refusal vs. write-time refusal), not a contradiction. Update that comment so it explains both shapes rather than asserting the code is regex-invisible, which is no longer true for its second occurrence.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test -- --run server/src/routes/single-design.test.ts server/src/routes/openapi-design-parity.test.ts`
Expected: PASS — including all pre-existing tests in `single-design.test.ts` (the `applyOverrideStub` default-return-shape change from Step 3 must not break the "first design" / "preview" describe blocks, which only assert `applyOverrideStub` was/wasn't called, not its return value), and `openapi-design-parity.test.ts` green with the new code registered on both sides.

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/single-design.ts server/src/routes/single-design.test.ts server/src/routes/openapi-design-parity.test.ts openapi.yaml
git commit -m "fix(server): single-design refuses on a series-wide clone instead of silently discarding the check"
```

---

### Task 4: `cast-design.ts:544` — mirror the variant branch's clone-skip reporting, and upgrade the base-voice upfront check to series-wide

**This task also resolves an inconsistency between Task 3 and Task 8.** An earlier revision of this plan left the base-voice branch's upfront check (`cast-design.ts:402-412`) book-local while upgrading the variant branch's (`:430-440`, Task 8) and `single-design.ts`'s (Task 3) to series-wide — on the stated grounds that the sibling spec's "Signature change" section lists no upfront change for the base branch. Under review, that reasoning didn't survive: it is the identical fact pattern Task 3's own preamble uses to justify the identical upgrade one file over ("leaving the upfront check book-local here would make every such attempt run a full GPU round before failing at the write-time check this task also adds"). A character cloned on a sibling book is exactly as routine and exactly as deterministic a case for the base-voice path as for the variant path or the single-design path — there is no principled reason to leave this one book-local. This task upgrades it too, for consistency with Tasks 3 and 8 rather than as a new decision.

**Files:**
- Modify: `server/src/routes/cast-design.ts:402-412` (base-voice upfront check, upgraded), `cast-design.ts:537-551` (write-time, mirrored)
- Test: `server/src/routes/cast-design.test.ts`

**Interfaces:**
- Consumes: `applyOverrideToCastFiles`'s new `{updated, skipped}` return (Task 2), `hasClonedSlotAmongMatches` (Task 1 — this task is what actually adds the import to `cast-design.ts`; Task 8 relies on it already being present by the time it runs).

- [ ] **Step 1: Write the failing tests**

Add near the existing `'GATE 2 fix-lane-1b: skips a coqui-cloned character instead of retargeting it, and reports it'` test in `cast-design.test.ts` (~line 350):

```ts
it('base-voice path: a series-wide clone (sibling book) is reported through clonedSkips instead of silently "designed"', async () => {
  // Requires a second book in this file's SERIES/AUTHOR fixture with a
  // character sharing the target voiceId, carrying a consented clone.
  // (Mirror this file's top-level workspaceRoot/AUTHOR/SERIES/BOOK setup
  // to add a sibling book directory in beforeEach for this describe.)
  const res = await request(app)
    .post(`/api/books/${bookId}/cast/design`)
    .send({ characterIds: ['linked-char'], modelKey: QWEN_KEY });

  expect(res.status).toBe(200);
  const events = parseSse(res.text);
  expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'linked-char')).toBe(false);
  expect(
    events.some(
      (e) =>
        e.type === 'character_skipped' &&
        e.characterId === 'linked-char' &&
        e.reason === 'already_cloned',
    ),
  ).toBe(true);
  const idle = events.find((e) => e.type === 'idle');
  expect(idle?.clonedSkips).toContainEqual({ characterId: 'linked-char', name: expect.any(String) });
});

it('base-voice path, upfront: a series-wide clone (sibling book) is reported before any sidecar call, not after', async () => {
  // Same sibling-book fixture as the write-time test above.
  const res = await request(app)
    .post(`/api/books/${bookId}/cast/design`)
    .send({ characterIds: ['linked-char'], modelKey: QWEN_KEY });

  expect(res.status).toBe(200);
  const events = parseSse(res.text);
  expect(
    events.some(
      (e) => e.type === 'character_skipped' && e.characterId === 'linked-char' && e.reason === 'already_cloned',
    ),
  ).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled(); // no sidecar call reached for this character
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- --run server/src/routes/cast-design.test.ts -t "base-voice path"`
Expected: FAIL — today's write-time code at `:544-551` calls `applyOverrideToCastFiles` and unconditionally does `job.done += 1; broadcast(..., 'character_designed', ...)`, so `character_skipped` never fires for that path; today's upfront check at `:402-412` is book-local `characterHasClonedSlot`, so a sibling-book clone isn't caught until (in this task's own fixed code) the write-time check, after a full sidecar round-trip.

- [ ] **Step 3: Upgrade the base-voice upfront check to series-wide**

At `cast-design.ts:402-412`, change:

```ts
      if (characterHasClonedSlot(character)) {
        job.skipped += 1;
        job.clonedSkips.push({ characterId, name: character.name ?? characterId });
        broadcast(job, {
          type: 'character_skipped',
          characterId,
          name: character.name ?? characterId,
          reason: 'already_cloned',
        });
        continue;
      }
```

to:

```ts
      if (characterHasClonedSlot(character) || await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter, undefined, job.bookDir)) {
        job.skipped += 1;
        job.clonedSkips.push({ characterId, name: character.name ?? characterId });
        broadcast(job, {
          type: 'character_skipped',
          characterId,
          name: character.name ?? characterId,
          reason: 'already_cloned',
        });
        continue;
      }
```

Add the import — `cast-design.ts:50` currently has `import { applyOverrideToCastFiles } from './voices.js';`; extend it:

```ts
import { applyOverrideToCastFiles, hasClonedSlotAmongMatches } from './voices.js';
```

(Task 8, which upgrades the variant branch's own upfront check at `:430-440`, relies on this import already being present — do this task first, or add the import once and note it in both tasks' commits.)

- [ ] **Step 4: Implement the mirrored write-time branch**

At `cast-design.ts:544-551`, change:

```ts
const matchKey = character.voiceId ?? character.id;
await applyOverrideToCastFiles(
  matchKey,
  { engine: 'qwen', name: voiceId },
  seriesFilter,
  job.bookDir,
);
job.done += 1;
broadcast(job, { type: 'character_designed', characterId, voiceId });
```

to:

```ts
const matchKey = character.voiceId ?? character.id;
const { updated, skipped } = await applyOverrideToCastFiles(
  matchKey,
  { engine: 'qwen', name: voiceId },
  seriesFilter,
  job.bookDir,
);
if (updated === 0 && skipped.length > 0) {
  job.skipped += 1;
  job.clonedSkips.push({ characterId, name: character.name ?? characterId });
  broadcast(job, {
    type: 'character_skipped',
    characterId,
    name: character.name ?? characterId,
    reason: 'already_cloned',
  });
} else {
  job.done += 1;
  broadcast(job, { type: 'character_designed', characterId, voiceId });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- --run server/src/routes/cast-design.test.ts -t "base-voice path"`
Expected: PASS.

- [ ] **Step 6: Run the full cast-design.ts test file**

Run: `npm run test -- --run server/src/routes/cast-design.test.ts`
Expected: PASS (no other test in this file destructures the base-voice call's return value, so this is additive).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "fix(server): bulk-design base-voice path is series-wide and reports a clone skip instead of discarding it"
```

---

### Task 5: `persistEmotionVariant` — return-contract change + book-scoped branch check

**Files:**
- Modify: `server/src/routes/qwen-voice.ts:99-107` (`clonedVariantRefusal`), `qwen-voice.ts:144-209` (`persistEmotionVariant`)
- Test: `server/src/routes/qwen-voice.test.ts:1504-1660ish` (the existing `describe('persistEmotionVariant', ...)` block)

**Interfaces:**
- Produces: `type PersistEmotionVariantOutcome = 'applied' | 'skippedClone' | 'notFound'`; `persistEmotionVariant(...): Promise<PersistEmotionVariantOutcome>` — changed from `Promise<void>`. Task 6 (series branch), Task 7, and Task 8 all consume this.
- Also type-aliased (not asserted-on) by `server/src/routes/variant-propagation.test.ts:30` — Step 6 below re-runs that file's suite to confirm the `void`→union change doesn't need an edit there (same note as Task 2's Step 6).

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('persistEmotionVariant', ...)` block in `qwen-voice.test.ts` (after the existing `beforeEach`/`afterEach`):

```ts
it('book-scoped: no clone — returns applied and records the variant', async () => {
  const outcome = await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry');
  expect(outcome).toBe('applied');
});

it('book-scoped: clone present at call time — returns skippedClone and does not mutate the field', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  await writeFile(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        {
          id: 'wren',
          voiceId: 'wren',
          overrideTtsVoices: { coqui: { name: 'clone-x', provenance: 'cloned' } },
        },
      ],
    }),
  );
  const outcome = await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry');
  expect(outcome).toBe('skippedClone');
  const cast = JSON.parse(await readFile(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
  expect(cast.characters[0].overrideTtsVoices.qwen).toBeUndefined();
});

it('is a no-op returning notFound for an unknown character', async () => {
  const outcome = await persistEmotionVariantFn(bookDir, 'ghost', 'angry', 'x');
  expect(outcome).toBe('notFound');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts -t "book-scoped:"`
Expected: FAIL — `persistEmotionVariant` currently resolves to `undefined` (its return type is `void`), and the book-scoped branch never checks for a clone at all.

- [ ] **Step 3: Reword `clonedVariantRefusal`**

At `qwen-voice.ts:99-107`, change:

```ts
export function clonedVariantRefusal(name: string): string {
  return (
    `"${name}" uses a cloned voice, so emotion variants are unavailable — ` +
    `they are only offered for a designed voice. Minting one would re-derive a ` +
    `new performance of a real person's voice under a key their consent record ` +
    `does not cover and revoking consent does not erase. Assign a designed ` +
    `voice to this character to use emotion variants.`
  );
}
```

to:

```ts
export function clonedVariantRefusal(name: string): string {
  return (
    `"${name}" is linked to a cloned voice somewhere in this series, so emotion variants are unavailable — ` +
    `they are only offered for a designed voice. Minting one would re-derive a ` +
    `new performance of a real person's voice under a key their consent record ` +
    `does not cover and revoking consent does not erase. Remove the clone from ` +
    `every linked book to use emotion variants for this character.`
  );
}
```

- [ ] **Step 4: Change the return type and the book-scoped branch**

At `qwen-voice.ts:144-209`, change the signature (line 144-150):

```ts
export async function persistEmotionVariant(
  bookDir: string,
  characterId: string,
  emotion: Exclude<Emotion, 'neutral'>,
  variantVoiceId: string,
  seriesFilter?: { author: string; series: string },
): Promise<void> {
```

to:

```ts
export type PersistEmotionVariantOutcome = 'applied' | 'skippedClone' | 'notFound';

export async function persistEmotionVariant(
  bookDir: string,
  characterId: string,
  emotion: Exclude<Emotion, 'neutral'>,
  variantVoiceId: string,
  seriesFilter?: { author: string; series: string },
): Promise<PersistEmotionVariantOutcome> {
```

Change the early-out at `qwen-voice.ts:153`:

```ts
if (!cast || !character) return;
```

to:

```ts
if (!cast || !character) return 'notFound';
```

**Also patch the series branch's own bare `return;` right now, temporarily** — Task 6 replaces this whole branch properly, but between THIS task's commit and Task 6's, the function's declared return type is already `Promise<PersistEmotionVariantOutcome>` while the series branch (`qwen-voice.ts:186-189`) still has a bare `return;`, which fails to typecheck. At `qwen-voice.ts:189`:

```ts
    await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) =>
      addVariant(c, baseVoiceId),
    );
    return;
```

change the last line only, to keep this task's own commit type-checking and behaviourally unchanged (still applies unconditionally, exactly as today — Task 6 is what adds the actual clone check to this branch):

```ts
    await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) =>
      addVariant(c, baseVoiceId),
    );
    return 'applied'; // temporary — Task 6 replaces this whole branch with the real series-wide check
```

Change the book-scoped branch at `qwen-voice.ts:200-208` (Task 6 handles the series branch above it, lines 168-190, separately):

```ts
await withCastLock(bookDir, async () => {
  const fresh = await readJson<CastFile>(castJsonPath(bookDir));
  const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
  if (!fresh || idx === -1) return;
  const freshCharacter = fresh.characters[idx];
  const baseVoiceId = qwenStorageKey(freshCharacter, characterId);
  fresh.characters[idx] = addVariant(freshCharacter, baseVoiceId);
  await writeJsonAtomic(castJsonPath(bookDir), fresh);
});
```

to:

```ts
return withCastLock(bookDir, async () => {
  const fresh = await readJson<CastFile>(castJsonPath(bookDir));
  const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
  if (!fresh || idx === -1) return 'notFound';
  const freshCharacter = fresh.characters[idx];
  if (characterHasClonedSlot(freshCharacter)) return 'skippedClone';
  const baseVoiceId = qwenStorageKey(freshCharacter, characterId);
  fresh.characters[idx] = addVariant(freshCharacter, baseVoiceId);
  await writeJsonAtomic(castJsonPath(bookDir), fresh);
  return 'applied';
});
```

`characterHasClonedSlot` is already imported at `qwen-voice.ts:56`.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts -t "book-scoped:" -t "no-op returning notFound"`
Expected: PASS.

- [ ] **Step 6: Run the full existing `persistEmotionVariant` describe block**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts -t "persistEmotionVariant"`
Expected: PASS — every pre-existing test in this block calls `persistEmotionVariantFn(...)` without capturing or asserting on the return value (confirmed by inspection: `qwen-voice.test.ts:1550-1660`), so the `void` → union-type change is additive and breaks nothing there. TypeScript will still typecheck fine since none of them type-annotate the awaited result.

- [ ] **Step 7: Also run `variant-propagation.test.ts`**

Run: `npm run test -- --run server/src/routes/variant-propagation.test.ts`
Expected: PASS — same "type-aliased but not asserted-on" situation as Task 2's Step 6.

- [ ] **Step 8: Typecheck before committing**

Run: `npm run typecheck`
Expected: PASS. Vitest alone (Steps 5-7) does not typecheck — this is what actually catches the series branch's return-type mismatch if the temporary `return 'applied';` patch from Step 4 was skipped or mis-applied.

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(server): persistEmotionVariant returns a typed outcome and checks the book-scoped branch for a clone"
```

---

### Task 6: `persistEmotionVariant` — series branch: fresh check + residual backstop + count threading

**Files:**
- Modify: `server/src/routes/qwen-voice.ts:47` (import), `qwen-voice.ts:168-190` (series branch)
- Test: `server/src/routes/qwen-voice.test.ts`

**Interfaces:**
- Consumes: `hasClonedSlotAmongMatches` (Task 1), `forEachMatchingCastCharacter`'s existing `Promise<number>` return (`voices.ts:779`, already imported at `qwen-voice.ts:47`).

- [ ] **Step 1: Write the failing tests**

```ts
it('series-scoped: two linked books, no clones anywhere — both get the variant, returns applied', async () => {
  // Second temp bookDir sharing voiceId 'wren' — write it in this test
  // (mirror bookDirFresh's beforeEach shape above), pass a seriesFilter,
  // and mock/point findAuthorSeriesForBookId-equivalent scanning at both
  // directories the way this file's own series-scope helpers already do
  // elsewhere (search this file for an existing seriesFilter-based
  // persistEmotionVariant/forEachMatchingCastCharacter integration test to
  // copy the workspace-root wiring from, rather than re-deriving it).
  const outcome = await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry', {
    author: 'A', series: 'S',
  });
  expect(outcome).toBe('applied');
});

it('series-scoped: clone on a DIFFERENT linked book — skippedClone, and NO book (including uncloned ones) gets the variant', async () => {
  // Seed the sibling book's character with a consented cloned slot instead
  // of a qwen override. Assert via direct cast.json reads of BOTH books
  // that neither gained a qwen variant.
  const outcome = await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry', {
    author: 'A', series: 'S',
  });
  expect(outcome).toBe('skippedClone');
});

it('series-scoped: no confirmed-cast book matches at all — returns notFound, distinct from applied', async () => {
  // seriesFilter that matches zero books in the workspace scan.
  const outcome = await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry', {
    author: 'nonexistent-author', series: 'nonexistent-series',
  });
  expect(outcome).toBe('notFound');
});

it('series-scoped: residual-window skip on one linked book still returns applied (other books updated) and logs a warning', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Inject a clone directly onto one linked book's character AFTER the
  // fresh hasClonedSlotAmongMatches call would have already passed — e.g.
  // by mocking hasClonedSlotAmongMatches (imported from voices.js) to
  // resolve false once, then writing the clone marker to that one book's
  // cast.json before forEachMatchingCastCharacter's walk reaches it (same
  // scripted-interleaving technique as voices.test.ts's own residual-window
  // test in Task 2 — gate on that specific book's cast.json read).
  const outcome = await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry', {
    author: 'A', series: 'S',
  });
  expect(outcome).toBe('applied'); // the OTHER matched book still got it
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('residual-window skip'));
  warnSpy.mockRestore();
});
```

Follow this file's own established convention (seen at `qwen-voice.test.ts:1590-1660`, the `#1981` concurrent-write test) for scripting an interleaving via `vi.mocked(stateIo.readJson).mockImplementation(...)` — reuse that exact pattern for the residual-window test rather than inventing a new harness.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts -t "series-scoped:"`
Expected: FAIL — the series branch today propagates unconditionally with no clone check at all, and returns `undefined`.

- [ ] **Step 3: Implement the series branch**

Add the import at `qwen-voice.ts:47`:

```ts
// before:
import { forEachMatchingCastCharacter } from './voices.js';
// after:
import { forEachMatchingCastCharacter, hasClonedSlotAmongMatches } from './voices.js';
```

Replace the series branch (`qwen-voice.ts:168-190`):

```ts
if (seriesFilter) {
  const baseVoiceId = qwenStorageKey(character, characterId);
  await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) =>
    addVariant(c, baseVoiceId),
  );
  return;
}
```

with:

```ts
if (seriesFilter) {
  const baseVoiceId = qwenStorageKey(character, characterId);

  /* Fresh, series-wide re-check immediately before the walk — replaces the
     caller's stale pre-GPU snapshot. A hit refuses the WHOLE propagation:
     no book is written. See the qwen-voice spec's "Series-wide check,
     reused, not reimplemented". */
  const stillCloned = await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter);
  if (stillCloned) return 'skippedClone';

  /* Residual-window backstop: the walk still takes nonzero time after the
     scan above passed. Threading the walk's own returned count through
     (rather than discarding it, as an earlier revision did) is what lets
     'applied' and 'notFound' be told apart below. */
  let residualSkip = false;
  const updated = await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) => {
    if (characterHasClonedSlot(c)) {
      residualSkip = true;
      return c; // unchanged — this book's own write correctly declined
    }
    return addVariant(c, baseVoiceId);
  });
  if (residualSkip) {
    console.warn(
      `[persistEmotionVariant] residual-window skip: a clone appeared on a linked book for ${characterId} between the series-wide scan and this walk reaching it (${updated} book(s) still received the variant).`,
    );
  }
  return updated > 0 ? 'applied' : 'notFound';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts -t "series-scoped:"`
Expected: PASS.

- [ ] **Step 5: Run the full qwen-voice.ts test file**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(server): persistEmotionVariant series branch vetoes on a series-wide clone, with a residual-window backstop"
```

---

### Task 7: `qwen-voice.ts` JSON route — series-wide upfront check + write-time integration

**Files:**
- Modify: `server/src/routes/qwen-voice.ts:590-605` (upfront check, reordered against `:638-639`), `qwen-voice.ts:668-681` (write-time call site)
- Test: `server/src/routes/qwen-voice.test.ts` (the existing `describe('#1954 — emotion variants for a CLONED voice', ...)` block, ~line 670)

**Interfaces:**
- Consumes: `hasClonedSlotAmongMatches` (already imported by Task 6), `persistEmotionVariant`'s new outcome (Tasks 5-6), `findAuthorSeriesForBookId` (already imported at `qwen-voice.ts:48`).

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('#1954 — emotion variants for a CLONED voice', ...)` block:

```ts
it('409s before any GPU design call when the character is cloned on a SIBLING book, not this one (v5 upfront fix)', async () => {
  // Seed a second book in the same series whose matching character
  // (shared voiceId) carries a consented cloned slot; THIS book's own
  // character has none. Spy on designQwenVoiceForCharacter (or the
  // sidecar fetch mock this file already uses elsewhere) to assert zero
  // invocations.
  const res = await request(app)
    .post(`/api/books/${bookId}/cast/linked-char/design-voice`)
    .send({ persona: 'x', sampleVoiceId: 'char-linked', modelKey: 'qwen3-tts-0.6b', emotion: 'angry' });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('clone_protected');
  // assert the sidecar/design-core mock was never called for this request
});

it('write-time: when persistEmotionVariant resolves skippedClone, the route answers 409 clone_protected', async () => {
  // Mock persistEmotionVariant (imported by this test file's module under
  // test) to resolve 'skippedClone' for this one call.
  const res = await request(app)
    .post(`/api/books/${bookId}/cast/c1/design-voice`)
    .send({ persona: 'x', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b', emotion: 'angry' });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('clone_protected');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts -t "409s before any GPU design call"`
Expected: FAIL — today's upfront check is book-local, and the write-time call site never inspects `persistEmotionVariant`'s return.

- [ ] **Step 3: Move the clone check down to where `isStandalone`/`seriesInfo` already sit — do NOT move the series lookup earlier**

An earlier revision of this plan moved `isStandalone`/`seriesInfo` (currently computed at `:638-639`) up to replace the check at `:600-605`. Under review that was wrong: between those two positions sit three early-return 400 validators (missing-persona `:612-617`, missing-`sampleVoiceId` `:623-627`, bad-`modelKey` `:628-632`) that have nothing to do with cloning — moving the series lookup (a full workspace directory scan via `findAuthorSeriesForBookId`) above them would make every malformed request pay that scan before its 400, and it orphans the "Plan 161" comment that sits directly above the existing `:635-637` computation. The fix that actually matches this handler's control flow: leave `isStandalone`/`seriesInfo` exactly where they are; move the CHECK down to sit right next to them instead.

Delete the existing check at `:600-605`:

```ts
    if (emotion && characterHasClonedSlot(character)) {
      return res.status(409).json({
        error: clonedVariantRefusal(character.name ?? characterId),
        code: 'clone_protected',
      });
    }
```

(leaving the persona/`sampleVoiceId`/`modelKey` 400 validators immediately below it untouched and in their original position), and insert the upgraded check immediately after the existing `isStandalone`/`seriesInfo` computation at `:638-639` (which stays exactly where it is, "Plan 161" comment and all):

```ts
    const isStandalone = located.state?.isStandalone === true;
    const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
    if (emotion && (characterHasClonedSlot(character) || await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesInfo ?? undefined, undefined, bookDir))) {
      return res.status(409).json({
        error: clonedVariantRefusal(character.name ?? characterId),
        code: 'clone_protected',
      });
    }
```

Net effect: the three unrelated 400s still run first and still pay no workspace-scan cost; the clone check (now series-wide) runs once, right where the series info it needs is already computed, still strictly before `ensureCharacterVoiceUuid`/`designQwenVoiceForCharacter` (i.e. still before any GPU work).

- [ ] **Step 4: Wire the write-time integration**

At `qwen-voice.ts:668-681`, change:

```ts
      if (emotion && body.preview !== true) {
        await persistEmotionVariant(
          bookDir,
          characterId,
          emotion,
          voiceId,
          seriesInfo ?? undefined,
        );
      }
      return res.status(200).json({ voiceId, url, voiceUuid });
```

to:

```ts
      if (emotion && body.preview !== true) {
        const outcome = await persistEmotionVariant(
          bookDir,
          characterId,
          emotion,
          voiceId,
          seriesInfo ?? undefined,
        );
        if (outcome === 'skippedClone') {
          return res.status(409).json({
            error: clonedVariantRefusal(character.name ?? characterId),
            code: 'clone_protected',
          });
        }
        /* 'notFound' (no confirmed-cast book in scope matched this
           character at write time — a genuinely empty write, not a
           refusal) falls through to the same 200 as 'applied' below.
           This is NOT a new gap this task introduces: before this task,
           persistEmotionVariant returned void unconditionally and the
           route always answered 200 regardless of whether anything was
           actually written for this exact case — this branch makes that
           pre-existing disposition explicit rather than changing it. Only
           'skippedClone' is new, deliberate refusal-reporting behaviour;
           'notFound' intentionally keeps today's behaviour, named rather
           than left as a silent fallthrough. */
      }
      return res.status(200).json({ voiceId, url, voiceUuid });
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts -t "409s before any GPU design call" -t "write-time: when persistEmotionVariant"`
Expected: PASS.

- [ ] **Step 6: Run the full qwen-voice.ts test file**

Run: `npm run test -- --run server/src/routes/qwen-voice.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(server): design-voice route's clone gate is series-wide, both upfront and at write time"
```

---

### Task 8: `cast-design.ts` SSE bulk job — series-wide upfront check + write-time integration (variant path)

**Files:**
- Modify: `server/src/routes/cast-design.ts:430-440` (upfront), `cast-design.ts:552-559` (write-time)
- Test: `server/src/routes/cast-design.test.ts`

**Interfaces:**
- Consumes: `hasClonedSlotAmongMatches` (import from `./voices.js`), `persistEmotionVariant`'s new outcome (Tasks 5-6). `seriesFilter` is already in scope at both sites (`runDesignJob`'s own parameter).

- [ ] **Step 1: Write the failing tests**

Add near the existing variant-branch clone tests in `cast-design.test.ts` (~line 700):

```ts
it('variant upfront: a series-wide clone (sibling book) is reported before any GPU call, not after', async () => {
  // Same sibling-book fixture as Task 4's test — reuse it if this describe
  // shares a beforeEach with Task 4's, otherwise add an equivalent one.
  const res = await request(app)
    .post(`/api/books/${bookId}/cast/design`)
    .send({ characterIds: ['linked-char'], modelKey: QWEN_KEY, emotion: 'angry' });

  expect(res.status).toBe(200);
  const events = parseSse(res.text);
  expect(
    events.some(
      (e) => e.type === 'character_skipped' && e.characterId === 'linked-char' && e.reason === 'already_cloned',
    ),
  ).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled(); // no sidecar call reached for this character
});

it('variant write-time: persistEmotionVariant resolving skippedClone reports through the same clonedSkips channel', async () => {
  // Mock persistEmotionVariant (this test file's module under test import)
  // to resolve 'skippedClone' for one call.
  const res = await request(app)
    .post(`/api/books/${bookId}/cast/design`)
    .send({ characterIds: ['c1'], modelKey: QWEN_KEY, emotion: 'angry' });

  const events = parseSse(res.text);
  expect(
    events.some(
      (e) => e.type === 'character_skipped' && e.characterId === 'c1' && e.reason === 'already_cloned',
    ),
  ).toBe(true);
  expect(events.some((e) => e.type === 'variant_designed' && e.characterId === 'c1')).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- --run server/src/routes/cast-design.test.ts -t "variant upfront:" -t "variant write-time:"`
Expected: FAIL — today's upfront variant check (`:430`) is book-local `characterHasClonedSlot`, and the write-time call (`:555`) discards `persistEmotionVariant`'s return.

- [ ] **Step 3: Upgrade the upfront check**

At `cast-design.ts:430-440`, change:

```ts
      if (characterHasClonedSlot(character)) {
        job.skipped += 1;
        job.clonedSkips.push({ characterId, name: character.name ?? characterId });
        broadcast(job, {
          type: 'character_skipped',
          characterId,
          name: character.name ?? characterId,
          reason: 'already_cloned',
        });
        continue;
      }
```

to:

```ts
      if (characterHasClonedSlot(character) || await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter, undefined, job.bookDir)) {
        job.skipped += 1;
        job.clonedSkips.push({ characterId, name: character.name ?? characterId });
        broadcast(job, {
          type: 'character_skipped',
          characterId,
          name: character.name ?? characterId,
          reason: 'already_cloned',
        });
        continue;
      }
```

The import (`applyOverrideToCastFiles, hasClonedSlotAmongMatches` from `./voices.js`) was already added by Task 4, which makes the identical upgrade to the base-voice branch's own upfront check (`:402-412`) for consistency — do Task 4 before this task, or if doing them out of order, add the import here instead and note it in this task's commit.

- [ ] **Step 4: Wire the write-time integration**

At `cast-design.ts:552-559`, change:

```ts
          } else {
            await persistEmotionVariant(job.bookDir, characterId, emotion, voiceId, seriesFilter);
            job.done += 1;
            broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId,
              ...(fellBackToDesignVoice ? { viaFallback: true, fallbackReason } : {}) });
          }
```

to:

```ts
          } else {
            const outcome = await persistEmotionVariant(job.bookDir, characterId, emotion, voiceId, seriesFilter);
            if (outcome === 'skippedClone') {
              job.skipped += 1;
              job.clonedSkips.push({ characterId, name: character.name ?? characterId });
              broadcast(job, {
                type: 'character_skipped',
                characterId,
                name: character.name ?? characterId,
                reason: 'already_cloned',
              });
            } else {
              /* 'applied' AND 'notFound' both reach here, deliberately —
                 same pre-existing disposition as the JSON route (Task 7),
                 not a new gap this task introduces. See that task's own
                 comment for the full rationale. */
              job.done += 1;
              broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId,
                ...(fellBackToDesignVoice ? { viaFallback: true, fallbackReason } : {}) });
            }
          }
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm run test -- --run server/src/routes/cast-design.test.ts -t "variant upfront:" -t "variant write-time:"`
Expected: PASS.

- [ ] **Step 6: Run the full cast-design.ts test file**

Run: `npm run test -- --run server/src/routes/cast-design.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "feat(server): bulk-design variant path's clone gate is series-wide, both upfront and at write time"
```

---

### Task 9: `clonedElsewhereInSeries` — API field + backend wiring

**This task's biggest risk is performance, not location.** Under review, the naive approach — call `hasClonedSlotAmongMatches` once per character on the book's canonical GET — was found to turn a single book-state fetch into `C × B` full-workspace directory walks (each doing two uncached `readJson` calls per book): a 30-character book in a 20-book workspace becomes ~1,200 file reads and JSON parses, serially, on every page load. Neither design spec caught this because neither one wrote out the call site's loop; it only became visible when the plan specified where the call actually lands. This task adds a **batched** scan (one walk per request, not one per character) instead.

**The serialization site**, found under review (grep commands in an earlier revision of this task did not actually find it — corrected here): `server/src/routes/book-state.ts`'s `GET /:bookId/state` handler, whose own code and comments describe it as the canonical book read (the frontend's `characters` slice is populated from this response). **Re-confirm this against the actual working tree before editing** — read the handler yourself rather than trusting this citation, per this plan's own established caution; if `book-state.ts` has been restructured since 2026-08-26, `grep -n "castConfirmed" server/src/routes/book-state.ts` and read outward from there.

**The write path is a second real risk, separate from performance.** `PUT /:bookId/state`'s two cast-merge normalisers in the same file (currently `~:119` and `~:151`) do a bare `{ ...cast, characters }` spread with no field allowlist. A derived, GET-only field spread onto a character object will round-trip verbatim into `cast.json` if the frontend ever sends a previously-fetched character back in a state-save payload (which its autosave path does) — freezing a stale boolean into the on-disk cast permanently, with nothing to invalidate it. This task strips the field at that boundary explicitly.

**Files:**
- Modify: `server/src/routes/voices.ts` (new batched scan function), `openapi.yaml` (Character schema, near where the `overrideTtsVoices` block ends — grep `overrideTtsVoices:` and read forward, don't trust a specific line number), `src/lib/api-types.ts` (regenerated, not hand-edited)
- Modify: `server/src/routes/book-state.ts` (both the GET response — compute the field — and the PUT write-path normalisers — strip it)
- Test: `server/src/routes/voices.test.ts` (new function), `server/src/routes/book-state.test.ts` (GET computes it; PUT strips it)

**Interfaces:**
- Produces: `findClonedVoiceIdsAmongMatches(seriesFilter?, excludeBookDir?): Promise<Set<string>>` (new, `voices.ts`) — one walk, returns every voiceId with a clone anywhere in the matched scope, instead of `hasClonedSlotAmongMatches`'s one-walk-per-voiceId `boolean`. Also produces `Character.clonedElsewhereInSeries?: boolean` on the API shape. Task 10 consumes the latter from the frontend.

- [ ] **Step 1: Write the failing test for the batched scan**

```ts
// voices.test.ts, new describe near hasClonedSlotAmongMatches's own coverage.
// This describe is self-contained (its own beforeEach), not nested inside
// Task 2's own describe — do not reach for that block's local variables.
describe('findClonedVoiceIdsAmongMatches', () => {
  /* Own dedicated fixture, same reasoning as Task 2's describe: this file's
     shared AUTHOR/SERIES/BOOK_ONE/BOOK_TWO fixture can't mint new voiceIds
     and is consumed by other describes. Mint via writeBookOnDisk
     (voices.test.ts:70-102) instead. */
  const SCAN_AUTHOR = 'Odalys Marchetti';
  const SCAN_SERIES = 'The Winter Ferry';
  let bookOneDir: string;

  beforeEach(() => {
    bookOneDir = writeBookOnDisk(
      workspaceRoot, SCAN_AUTHOR, SCAN_SERIES, 'Departure', 'book-scan-one',
      [
        {
          id: 'shared', name: 'Shared', voiceId: 'shared-voice-id',
          overrideTtsVoices: { coqui: { name: 'clone-x', provenance: 'cloned' } },
        },
        { id: 'uncloned', name: 'Uncloned', voiceId: 'uncloned-voice-id' },
      ],
    );
    writeBookOnDisk(
      workspaceRoot, SCAN_AUTHOR, SCAN_SERIES, 'Arrival', 'book-scan-two',
      [
        { id: 'shared', name: 'Shared', voiceId: 'shared-voice-id' }, // uncloned here
        { id: 'uncloned', name: 'Uncloned', voiceId: 'uncloned-voice-id' },
      ],
    );
  });

  it('returns the set of voiceIds cloned anywhere in the series scan, in one pass', async () => {
    const ids = await findClonedVoiceIdsAmongMatches({ author: SCAN_AUTHOR, series: SCAN_SERIES });
    expect(ids.has('shared-voice-id')).toBe(true);
    expect(ids.has('uncloned-voice-id')).toBe(false);
  });

  it('excludes a clone on the given excludeBookDir', async () => {
    // 'shared-voice-id' is cloned only on bookOneDir's own copy (seeded
    // above; 'Arrival' carries no clone at all). Excluding bookOneDir must
    // make the returned set NOT include it.
    const ids = await findClonedVoiceIdsAmongMatches({ author: SCAN_AUTHOR, series: SCAN_SERIES }, bookOneDir);
    expect(ids.has('shared-voice-id')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- --run server/src/routes/voices.test.ts -t "findClonedVoiceIdsAmongMatches"`
Expected: FAIL — the function doesn't exist yet.

- [ ] **Step 3: Implement the batched scan**

Add to `voices.ts`, near `hasClonedSlotAmongMatches`:

```ts
/* Batched sibling of hasClonedSlotAmongMatches: ONE walk of the matched
   scope returns every voiceId with a consented cloned slot anywhere in it,
   instead of one walk PER voiceId. Exists specifically so a caller who
   needs a per-character answer for MANY characters at once (Character API
   serialization, below) does one scan and then O(1) Set lookups, rather
   than re-walking the whole workspace once per character — the latter is
   an O(characters × books) cost on a hot read path. `excludeBookDir` drops
   one specific book from consideration (used to answer "cloned on some
   OTHER linked book", excluding the caller's own). */
export async function findClonedVoiceIdsAmongMatches(
  seriesFilter?: { author: string; series: string },
  excludeBookDir?: string,
): Promise<Set<string>> {
  const cloned = new Set<string>();
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        if (excludeBookDir && bookDir === excludeBookDir) continue;
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        if (seriesFilter) {
          if (state.isStandalone === true) continue;
          if (state.author !== seriesFilter.author || state.series !== seriesFilter.series) continue;
        }
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        for (const c of cast.characters) {
          if (characterHasClonedSlot(c)) cloned.add(c.voiceId ?? c.id);
        }
      }
    }
  }
  return cloned;
}
```

**Also wire the new function into `voices.test.ts`'s binding pattern** — same as Task 1 Step 3b did for `hasClonedSlotAmongMatches`: add `let findClonedVoiceIdsAmongMatches: typeof import('./voices.js').findClonedVoiceIdsAmongMatches;` near `voices.test.ts:65`, add `findClonedVoiceIdsAmongMatches: fcvim` to the `beforeAll`'s destructuring (`:147`), and `findClonedVoiceIdsAmongMatches = fcvim;` to its assignment block (`:152-155`). A bare call in the test body (Step 1 above) is a `ReferenceError` without this.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- --run server/src/routes/voices.test.ts -t "findClonedVoiceIdsAmongMatches"`
Expected: PASS.

- [ ] **Step 5: Confirm the serialization site, then write the failing GET test**

`server/src/routes/book-state.ts:238` (`bookStateRouter.get('/:bookId/state', ...)`) is the real handler — verified by direct reading, not by trusting either spec's citation. It reads cast.json at `:251` as `const cast = await readJson<{ characters: unknown[] }>(castJsonPath(bookDir));`, then later mutates `cast.characters` **in place** to backfill a `lines` field (`:380-385`) — that in-place-mutation shape is the established pattern to follow here, not building a new `characters` array (an earlier revision of this task assumed the latter and was wrong). The final response is `res.json({ state: stateView, cast, ... })` at `:567-569` — `cast` (with its now-mutated `characters`) goes out verbatim.

Add a test to `book-state.test.ts`: given a book in a series where a linked character (same `voiceId`) is cloned on a DIFFERENT confirmed-cast book, `GET /:bookId/state`'s response body's `cast.characters` has the matching entry carrying `clonedElsewhereInSeries: true`; given no such sibling clone (or a clone only on THIS book's own copy), it is `false` — reuse this plan's established two-book-same-series fixture pattern (Tasks 2/4/8).

- [ ] **Step 6: Run to verify it fails**

Run: `npm run test -- --run server/src/routes/book-state.test.ts -t "clonedElsewhereInSeries"`
Expected: FAIL — the field does not exist on the response yet.

- [ ] **Step 7: Add the field to `openapi.yaml`**

In the `Character` schema, immediately after the `overrideTtsVoices` property block, add:

```yaml
        clonedElsewhereInSeries:
          type: boolean
          description: |
            True when a consented cloned voice exists on some OTHER linked
            character in this book's series — false or absent when the only
            clone (if any) is this book's own copy (already exposed via
            overrideTtsVoices.*.provenance) or there is none. Excludes the
            caller's own book deliberately, to avoid a redundant "double
            true" when both this book and a sibling are independently
            cloned. A UX convenience for the two frontend clone gates
            (profile-drawer.tsx, emotion-variant-designer.tsx) — the
            backend's own series-wide checks (#2006) are what actually
            enforce consent; a stale value here degrades to "the button is
            offered when it shouldn't be," never to "the write happens when
            it shouldn't." Computed fresh on every GET — see book-state.ts's
            write-path normalisers for why it must never be accepted back
            from a client PUT.
```

- [ ] **Step 8: Regenerate the frontend types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` gains `clonedElsewhereInSeries?: boolean` on the generated `Character` type. Do not hand-edit that file.

- [ ] **Step 9: Compute the field on GET — ONE scan per request, not per character, mutating `cast.characters` in place**

Add the imports (alongside `book-state.ts`'s existing import block, `:12-79`):

```ts
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { findClonedVoiceIdsAmongMatches } from './voices.js';
```

In the `GET /:bookId/state` handler, immediately after the existing `lines`-backfill block (`:380-385` — `state` and `bookDir` are already in scope from earlier in this same handler, `:243-244`; `req.params.bookId` is the route param):

```ts
const isStandalone = state.isStandalone === true;
const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(req.params.bookId);
const clonedVoiceIds = seriesInfo
  ? await findClonedVoiceIdsAmongMatches(seriesInfo, bookDir)
  : new Set<string>();
if (cast?.characters && Array.isArray(cast.characters)) {
  for (const c of cast.characters as Array<{ id?: unknown; voiceId?: unknown } & Record<string, unknown>>) {
    if (!c || typeof c !== 'object') continue;
    const linkId = (typeof c.voiceId === 'string' ? c.voiceId : undefined)
      ?? (typeof c.id === 'string' ? c.id : undefined);
    c.clonedElsewhereInSeries = linkId ? clonedVoiceIds.has(linkId) : false;
  }
}
```

Placed after the `lines` backfill purely to keep the two `cast.characters` mutation passes adjacent — order between them doesn't matter, since each only touches its own field.

- [ ] **Step 10: Check for an import-cycle regression before going further**

`book-state.ts` importing from `./voices.js` is new. Run: `npx --yes madge@8.0.0 --circular --extensions ts server/src` (or `npm run check:cycles` if that script wraps the same invocation — confirm via `package.json`) and compare against `server/madge-cycles-allowlist.json`. If a new cycle appears and is genuinely load-bearing (unlikely — `voices.ts` does not import anything from `book-state.ts`), add it to the allowlist with justification; otherwise this step should simply pass. This plan's earlier revisions never mentioned this check at all — added here because a cross-route-module import is exactly the shape `check:cycles` (a required `verify.yml` leg, scope-gated to `server/**`) exists to catch.

- [ ] **Step 11: Strip the field on the write path so it can never persist into `cast.json`**

**Do not modify `denormaliseCastReusedVoices` or `preserveDesignedVoices`** (`book-state.ts:113-152`) — both already bind their own `const characters`, and both are the durable guard against the 2026-06-05 Drowning Bell voice-strip incident (`:122-128`'s comment); redeclaring `characters` inside either is a compile error, and replacing their existing binding would silently drop the reuse-hydration / designed-voice-preservation guarantee those functions exist for. Strip at the single point these two normalisers already funnel through instead — the write call itself, `book-state.ts:708-709`:

```ts
// before:
const guarded = await preserveDesignedVoices(bookDir, body.patch);
await writeJsonAtomic(castJsonPath(bookDir), await denormaliseCastReusedVoices(guarded));

// after:
const guarded = await preserveDesignedVoices(bookDir, body.patch);
const denormalised = await denormaliseCastReusedVoices(guarded);
await writeJsonAtomic(castJsonPath(bookDir), stripDerivedCharacterFields(denormalised));
```

Add the helper near the other two normalisers, following their own established "tolerates a non-cast-shaped patch" idiom exactly:

```ts
/* Strip fields the GET response computes fresh (currently just
   clonedElsewhereInSeries, #2006) before any cast write — a client that
   echoes back a just-fetched character (the autosave path does this) must
   never freeze a derived, point-in-time value into cast.json, where
   nothing would ever invalidate it. Tolerates a non-cast-shaped patch
   (returns it untouched), matching denormaliseCastReusedVoices and
   preserveDesignedVoices above. */
function stripDerivedCharacterFields(patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || !Array.isArray((patch as { characters?: unknown }).characters)) {
    return patch;
  }
  const cast = patch as { characters: Array<Record<string, unknown>> };
  const characters = cast.characters.map((c) => {
    const { clonedElsewhereInSeries: _derived, ...rest } = c;
    return rest;
  });
  return { ...cast, characters };
}
```

Add a regression test: PUT a `{ slice: 'cast', patch: { characters: [...] } }` body whose `characters` include `clonedElsewhereInSeries: true` on some character, then read `cast.json` directly off disk and assert the field is absent from the written file.

- [ ] **Step 12: Run the tests to verify everything passes**

Run: `npm run test -- --run server/src/routes/book-state.test.ts server/src/routes/voices.test.ts`
Expected: PASS.

- [ ] **Step 13: Typecheck**

Run: `npm run typecheck` (confirms `api-types.ts` regeneration didn't break any consumer, and that `stripDerivedCharacterFields`/the GET-side mutation both type-check against `book-state.ts`'s real surrounding types).
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts server/src/routes/book-state.ts server/src/routes/book-state.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): expose clonedElsewhereInSeries on Character via a batched scan, stripped on write"
```

---

### Task 10: Frontend clone gates read `clonedElsewhereInSeries`

**Files:**
- Modify: `src/modals/profile-drawer.tsx:1102-1111`
- Modify: `src/components/emotion-variant-designer.tsx:125-135`
- Test: each component's existing test file (find via `src/modals/profile-drawer.test.tsx`, `src/components/emotion-variant-designer.test.tsx` or equivalent — grep for the existing book-local-clone test to mirror)

**Interfaces:**
- Consumes: `Character.clonedElsewhereInSeries` (Task 9, via the regenerated `src/lib/api-types.ts`).

- [ ] **Step 1: Write the failing tests, against each file's REAL fixture pattern**

Neither file uses a `makeCharacter` helper (an earlier revision of this task invented one) — verified by reading both files directly:

`emotion-variant-designer.test.tsx`'s existing `describe('#1954 — cloned voices', ...)` (`:90-98`) uses a plain object literal passed straight as the `character` prop, backed by a redux store built via its own `makeStore(characters)` helper (`:17-22`):

```tsx
// emotion-variant-designer.test.tsx, inside describe('#1954 — cloned voices', ...)
it('replaces the designer with an actionable hint when clonedElsewhereInSeries is true, even with no book-local clone', () => {
  const clonedElsewhere = { id: 'lyra', name: 'Lyra', attributes: [], clonedElsewhereInSeries: true };
  const store = makeStore([clonedElsewhere]);
  render(
    <Provider store={store}>
      <EmotionVariantDesigner
        bookId="b1"
        character={clonedElsewhere as never}
        sampleVoiceId="v1"
        modelKey="qwen3-tts-0.6b"
        baseDesigned
        variants={undefined}
      />
    </Provider>,
  );
  const hint = screen.getByTestId('variant-cloned-hint');
  expect(hint.textContent).toMatch(/cloned voice/i);
  expect(screen.queryByTestId('variant-designer')).toBeNull();
});
```

`profile-drawer.test.tsx`'s existing `'[C-6] refuses a FIRST design when the character already has a cloned Coqui voice...'` test (`:1692-1714`) uses this file's own `renderWithBook({...baseChar, ...})` helper, `selectQwen()`, and asserts on the `qwen-design-error` testid plus a `dispatchSpy` non-call:

```tsx
// profile-drawer.test.tsx, near the existing [C-6] test
it('[C-6b] refuses a FIRST design when clonedElsewhereInSeries is true, even with no book-local clone', async () => {
  const { dispatchSpy } = renderWithBook({
    ...baseChar,
    clonedElsewhereInSeries: true,
  });
  dispatchSpy.mockClear();
  selectQwen();
  fireEvent.click(screen.getByTestId('qwen-design-voice'));

  expect(screen.getByTestId('qwen-design-error')).toHaveTextContent('cloned voice');
  expect(dispatchSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: castDesignActions.designSingleRequested.type }),
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- --run -t "clonedElsewhereInSeries"`
Expected: FAIL — neither gate reads this field yet.

- [ ] **Step 3: Update `emotion-variant-designer.tsx`**

At `emotion-variant-designer.tsx:125-135`, change:

```tsx
  const cloned =
    character.overrideTtsVoices?.qwen?.provenance === 'cloned' ||
    character.overrideTtsVoices?.coqui?.provenance === 'cloned';
  if (cloned) {
    return (
      <p data-testid="variant-cloned-hint" className="text-xs text-ink/50 mt-2">
        {character.name} uses a cloned voice, so emotion variants are unavailable — they are
        only offered for a designed voice. Assign a designed voice to add them.
      </p>
    );
  }
```

to:

```tsx
  const cloned =
    character.overrideTtsVoices?.qwen?.provenance === 'cloned' ||
    character.overrideTtsVoices?.coqui?.provenance === 'cloned' ||
    character.clonedElsewhereInSeries === true;
  if (cloned) {
    return (
      <p data-testid="variant-cloned-hint" className="text-xs text-ink/50 mt-2">
        {character.name} is linked to a cloned voice somewhere in this series, so emotion
        variants are unavailable — they are only offered for a designed voice. Remove the clone
        from every linked book to add them.
      </p>
    );
  }
```

- [ ] **Step 4: Update `profile-drawer.tsx`**

At `profile-drawer.tsx:1102-1111`, change:

```tsx
    if (
      !isRedesign &&
      (character.overrideTtsVoices?.qwen?.provenance === 'cloned' ||
        character.overrideTtsVoices?.coqui?.provenance === 'cloned')
    ) {
      setEngineError(
        `"${character.name}" already has a cloned voice and cannot be designed on Qwen without silently retargeting it off that clone.`,
      );
      return;
    }
```

to:

```tsx
    if (
      !isRedesign &&
      (character.overrideTtsVoices?.qwen?.provenance === 'cloned' ||
        character.overrideTtsVoices?.coqui?.provenance === 'cloned' ||
        character.clonedElsewhereInSeries === true)
    ) {
      setEngineError(
        `"${character.name}" is linked to a cloned voice somewhere in this series and cannot be designed on Qwen without silently retargeting it off that clone.`,
      );
      return;
    }
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm run test -- --run -t "clonedElsewhereInSeries"`
Expected: PASS.

- [ ] **Step 6: Run each component's full test file**

Run: `npm run test -- --run src/modals/profile-drawer.test.tsx src/components/emotion-variant-designer.test.tsx` (adjust paths to whatever Step 1's grep found)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modals/profile-drawer.tsx src/components/emotion-variant-designer.tsx <the two test files>
git commit -m "feat(frontend): clone gates disable on a series-wide clone, not just this book's own copy"
```

---

## Final verification

- [ ] Run `npm run typecheck` — confirms every changed signature (`applyOverrideToCastFiles`, `persistEmotionVariant`, the new `Character` field) type-checks across every consumer, not just the files this plan touched directly.
- [ ] Run `npm run test:fast` (frontend + server) — full regression sweep.
- [ ] Re-grep for any remaining bare-number consumer of `applyOverrideToCastFiles` or `void`-typed consumer of `persistEmotionVariant` this plan's own reading may have missed: `grep -rln "applyOverrideToCastFiles\|persistEmotionVariant" server/src --include=*.ts` — cross-check every hit against this plan's enumeration (Tasks 2, 3, 4, 5, 6, 7, 8), including `variant-propagation.test.ts`, which this plan's own first pass missed and a review pass caught.
- [ ] Confirm `openapi-design-parity.test.ts` is green (Task 3's `clone_protected` registration) and that `openapi.yaml`'s `PUT /api/voices/{voiceId}/override` documents `200`/`409` alongside the pre-existing `204`/`400`/`404` (Task 2).
- [ ] Confirm `clonedElsewhereInSeries` never appears in an on-disk `cast.json` after a `PUT /:bookId/state` round-trip (Task 9's write-path strip) — this is a correctness property, not just a passing test; spot-check by hand on a real book if time allows.
- [ ] Confirm the PR body's "Also fixed, found in passing" section names: Task 3's `single-design.ts` write-time-discard fix (goes beyond the sibling spec's literal text), and Task 4's base-voice-upfront-check upgrade (resolves an inconsistency this plan's own review pass found between Task 3 and Task 8, not something either spec asked for) — per this repo's incidental-findings rule.
- [ ] Follow this repo's Before-shipping checklist (docs/features regression plan — likely `docs/BACKLOG.md`/`docs/features/INDEX.md` entries for #2006 if one exists; release-notes-next.md + RELEASE_NOTES.md entries; on-box acceptance is NOT owed here — no real hardware/GPU/sidecar behavior is exercised by this change, it's pure cast.json logic).
- [ ] Close #2006 via `Closes #2006` in the PR body once all tasks land — confirm this is the LAST open TOCTOU gate the issue tracks before closing it outright rather than `Refs`.
