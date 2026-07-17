# Cast Alias Re-point on Unlink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user unlinks an alias chip in the Profile Drawer, let them choose to **move that name (and its lines) onto an existing roster character** instead of only splitting it into a new standalone character.

**Architecture:** A destination dialog fronts the existing ✕-on-chip action. "Make it its own character" keeps today's `unlink-alias` path unchanged. "Move to X" hits a NEW server route (`POST /cast/repoint-alias`) that strips the alias from the source and appends it to X atomically, then dispatches a new `applyRepointAlias` reducer and re-opens the existing `ReassignLinesModal` (`unlink` source) seeded to X so the lines follow. The bulk-line-move modal (#1676 part c) is reused verbatim.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (Immer) frontend; Express + Node server; Vitest (jsdom + node) + Playwright.

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-07-17-cast-alias-repoint-on-unlink-design.md`. Every task's requirements implicitly include it.
- **No true delete.** The picker offers exactly two destinations: *new character* (existing behavior) and *existing character X* (new). No "drop the name entirely" outcome.
- **No undo for the alias-string transfer.** The *line* move keeps its existing one-level undo banner (part c). Do not add an undo slot for the membership change.
- **Reuse `ReassignLinesModal` verbatim** — its `unlink` source already accepts an arbitrary `aliasCharacterId` as default target. No modal change.
- **Design tokens only** — no hex literals; use existing Tailwind/CSS-var classes.
- **Touch targets** — every interactive control ≥44px on touch: `min-h-[44px] fine-pointer:min-h-0` (and `min-w-[44px] fine-pointer:min-w-0` for icon-only). Match the confirm-dialog buttons already in `reassign-lines.tsx`.
- **RTK Immer** — reducers mutate drafts; do not rewrite to spreads.
- **Commit convention** — `<type>(<scope>): <subject>`; allowed scopes include `server`, `frontend`, `e2e`, `docs`. Multi-scope: `feat(frontend,server): …`.
- **Branch:** `feat/fs-alias-repoint` (already cut off `main`; worktree `.claude/worktrees/feat+fs-alias-repoint`).

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/routes/cast-aliases.ts` | Add `POST /cast/repoint-alias`; reuse existing lineage helpers | Modify |
| `server/src/routes/cast-aliases.test.ts` | Server tests for the new route | Modify |
| `src/lib/api.ts` | `RepointAlias*` types + `realRepointAlias`/`mockRepointAlias` + wiring | Modify |
| `src/store/cast-slice.ts` | `applyRepointAlias` reducer | Modify |
| `src/store/cast-slice.test.ts` | Reducer tests | Modify |
| `src/store/persistence-middleware.ts` | `cast/applyRepointAlias` persist rule | Modify |
| `src/store/persistence-middleware.test.ts` | Persist-rule test | Modify |
| `src/modals/unlink-alias-dialog.tsx` | The destination picker dialog + `UnlinkDestination` type | Create |
| `src/modals/unlink-alias-dialog.test.tsx` | Dialog tests | Create |
| `src/modals/profile-drawer.tsx` | Render dialog before firing; widen `onUnlinkAlias` | Modify |
| `src/modals/profile-drawer.test.tsx` | Rewrite the 3 unlink tests for the dialog | Modify |
| `src/components/layout.tsx` | Split/move branches in the unlink handler | Modify |
| `e2e/cast-alias-edit.spec.ts` | Update existing chain for the dialog; add move-to-X path | Modify |
| `docs/features/1676-cast-bulk-line-reassignment.md` | Fold part (b) into the regression plan | Modify |
| `docs/features/INDEX.md`, `RELEASE_NOTES.md`, `docs/release-notes-next.md` | Housekeeping | Modify |

---

## Task 1: Server — `POST /cast/repoint-alias` route

**Files:**
- Modify: `server/src/routes/cast-aliases.ts`
- Test: `server/src/routes/cast-aliases.test.ts`

**Interfaces:**
- Consumes: existing module-level `impactedChaptersFromJournal(bookDir, sourceCharacterId, aliasKey, edits)` and `impactedChaptersFromChapterCast(manuscriptId, sourceCharacterId, edits, aliasKey)` in the same file; `normaliseAlias`, `findBookByBookId`, `readJson`, `writeJsonAtomic`, `castJsonPath`, `manuscriptEditsJsonPath`.
- Produces: `POST /:bookId/cast/repoint-alias` returning `{ impactedChapters: Array<{chapterId:number; candidateSentenceIds:number[]}>; alreadyPresent: boolean }`.

- [ ] **Step 1: Write the failing tests.** Append a new `describe` block to `server/src/routes/cast-aliases.test.ts`. The existing `beforeAll` seeds `saltgrave-figure` (aliases include `Garrow`) and `wren`; reuse it. Because tests share the tmp workspace and mutate `cast.json`, put repoint in its OWN describe that re-seeds `cast.json` in a local `beforeEach` so it is order-independent:

```ts
describe('cast-aliases router — repoint-alias', () => {
  beforeEach(() => {
    /* Re-seed a clean two-character cast (Garrow on Saltgrave, Wren empty)
       so this block is independent of the unlink block's mutations. */
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: [sourceCharacter, otherCharacter] }),
    );
  });

  it('moves the alias from source to target, returns impacted chapters, does not mutate edits', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/repoint-alias`)
      .set('Content-Type', 'application/json')
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow', targetCharacterId: 'wren' });

    expect(res.status).toBe(200);
    expect(res.body.alreadyPresent).toBe(false);
    expect(res.body.impactedChapters.map((c: { chapterId: number }) => c.chapterId)).toEqual([1, 4]);
    expect(res.body.impactedChapters[0].candidateSentenceIds).toEqual([1, 2, 3]);

    const cast = readDisk<{ characters: Array<{ id: string; name: string; aliases?: string[] }> }>('cast.json');
    // No new character minted — roster length unchanged.
    expect(cast.characters.map((c) => c.id)).toEqual(['saltgrave-figure', 'wren']);
    expect(cast.characters.find((c) => c.id === 'saltgrave-figure')!.aliases).toEqual(['Sior', 'Jurek', 'Shopkeeper']);
    expect(cast.characters.find((c) => c.id === 'wren')!.aliases).toEqual(['Garrow']);

    const edits = readDisk<{ sentences: Array<{ id: number; characterId: string }> }>('manuscript-edits.json');
    expect(edits.sentences.find((s) => s.id === 1)!.characterId).toBe('saltgrave-figure');
  });

  it('is idempotent when the target already carries the alias (alreadyPresent, still strips source)', async () => {
    // Pre-seed Garrow onto wren too.
    const cast = readDisk<{ characters: Array<{ id: string; aliases?: string[] }> }>('cast.json');
    cast.characters.find((c) => c.id === 'wren')!.aliases = ['Garrow'];
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/repoint-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow', targetCharacterId: 'wren' });

    expect(res.status).toBe(200);
    expect(res.body.alreadyPresent).toBe(true);
    const after = readDisk<{ characters: Array<{ id: string; aliases?: string[] }> }>('cast.json');
    expect(after.characters.find((c) => c.id === 'saltgrave-figure')!.aliases).toEqual(['Sior', 'Jurek', 'Shopkeeper']);
    expect(after.characters.find((c) => c.id === 'wren')!.aliases).toEqual(['Garrow']); // no dup
  });

  it('treats alias === target primary name as alreadyPresent (strip, no 400)', async () => {
    // Rename wren's alias case: move "Wren" (matches wren.name) — strip from source, no append, no error.
    const cast = readDisk<{ characters: Array<{ id: string; name: string; aliases?: string[] }> }>('cast.json');
    cast.characters.find((c) => c.id === 'saltgrave-figure')!.aliases = ['Sior', 'Wren'];
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/repoint-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Wren', targetCharacterId: 'wren' });

    expect(res.status).toBe(200);
    expect(res.body.alreadyPresent).toBe(true);
    const after = readDisk<{ characters: Array<{ id: string; name: string; aliases?: string[] }> }>('cast.json');
    expect(after.characters.find((c) => c.id === 'saltgrave-figure')!.aliases).toEqual(['Sior']);
    expect(after.characters.find((c) => c.id === 'wren')!.aliases ?? []).toEqual([]); // name already covers it
  });

  it('400s when target === source', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/repoint-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow', targetCharacterId: 'saltgrave-figure' });
    expect(res.status).toBe(400);
  });

  it('404s on unknown target', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/repoint-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow', targetCharacterId: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('404s when the alias is not on the source', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/repoint-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Nobody', targetCharacterId: 'wren' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `cd server && npx vitest run src/routes/cast-aliases.test.ts -t "repoint-alias"`
Expected: FAIL (404 for all — route not registered yet).

- [ ] **Step 3: Implement the route.** In `server/src/routes/cast-aliases.ts`, add after the `unlink-alias` handler (before the `add-alias` handler). Add a body interface and response type near the existing ones:

```ts
interface RepointBody {
  sourceCharacterId?: unknown;
  aliasName?: unknown;
  targetCharacterId?: unknown;
}

interface RepointResponse {
  impactedChapters: ImpactedChapter[];
  /** True when the target already carried the alias (or it equals the
      target's own name) — the append was a no-op, but the source strip
      still happened. Mirrors add-alias' idempotency flag. */
  alreadyPresent: boolean;
}
```

```ts
castAliasesRouter.post(
  '/:bookId/cast/repoint-alias',
  async (req: Request, res: Response<RepointResponse | { error: string }>) => {
    const { bookId } = req.params;
    const body = (req.body ?? {}) as RepointBody;
    const sourceCharacterId = normaliseAlias(body.sourceCharacterId);
    const aliasName = normaliseAlias(body.aliasName);
    const targetCharacterId = normaliseAlias(body.targetCharacterId);

    if (!sourceCharacterId || !aliasName || !targetCharacterId) {
      return res.status(400).json({
        error: 'sourceCharacterId, aliasName and targetCharacterId are required.',
      });
    }
    if (sourceCharacterId === targetCharacterId) {
      return res.status(400).json({ error: 'Source and target must differ.' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before editing aliases.',
      });
    }

    const source = cast.characters.find((c) => c.id === sourceCharacterId);
    if (!source) return res.status(404).json({ error: `Character "${sourceCharacterId}" not found.` });
    const target = cast.characters.find((c) => c.id === targetCharacterId);
    if (!target) return res.status(404).json({ error: `Character "${targetCharacterId}" not found.` });

    const aliasKey = aliasName.toLowerCase();
    const aliasIdx = (source.aliases ?? []).findIndex((a) => a.trim().toLowerCase() === aliasKey);
    if (aliasIdx === -1) {
      return res.status(404).json({ error: `Alias "${aliasName}" is not on character "${source.name}".` });
    }
    /* Preserve the chip's display casing when appending to the target. */
    const displayName = (source.aliases ?? [])[aliasIdx];

    /* Always strip from source. Append to target unless it already carries the
       alias OR the alias equals the target's own name (the name already covers
       it) — in either case, append is a no-op and alreadyPresent is true. */
    const nextSourceAliases = (source.aliases ?? []).filter((a) => a.trim().toLowerCase() !== aliasKey);
    const targetAliases = target.aliases ?? [];
    const alreadyPresent =
      aliasKey === target.name.trim().toLowerCase() ||
      targetAliases.some((a) => a.trim().toLowerCase() === aliasKey);
    const nextTargetAliases = alreadyPresent ? targetAliases : [...targetAliases, displayName];

    const nextCharacters: CharacterOutput[] = cast.characters.map((c) => {
      if (c.id === sourceCharacterId) return { ...c, aliases: nextSourceAliases };
      if (c.id === targetCharacterId) return { ...c, aliases: nextTargetAliases };
      return c;
    });

    await writeJsonAtomic(castJsonPath(bookDir), { characters: nextCharacters });

    /* Lineage is identical to unlink — same source-attributed candidate lines.
       Only the destination differs, and that never touches manuscript-edits. */
    const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
    let impactedChapters = await impactedChaptersFromJournal(bookDir, sourceCharacterId, aliasKey, edits);
    if (!impactedChapters) {
      impactedChapters = await impactedChaptersFromChapterCast(
        state.manuscriptId,
        sourceCharacterId,
        edits,
        aliasKey,
      );
    }

    console.log(
      `[cast-aliases] book=${bookId} repointed alias "${aliasName}" from ${sourceCharacterId}` +
        ` → ${targetCharacterId} (${impactedChapters.length} impacted chapters, alreadyPresent=${alreadyPresent})`,
    );

    return res.json({ impactedChapters, alreadyPresent });
  },
);
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd server && npx vitest run src/routes/cast-aliases.test.ts -t "repoint-alias"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add server/src/routes/cast-aliases.ts server/src/routes/cast-aliases.test.ts
git commit -m "feat(server): add cast/repoint-alias route (#1676 b)"
```

---

## Task 2: API client — types, real/mock, wiring

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes: Task 1's `POST /cast/repoint-alias`; existing `UnlinkAliasImpactedChapter` type.
- Produces: `api.repointAlias({ bookId, sourceCharacterId, aliasName, targetCharacterId }): Promise<RepointAliasResponse>` where `RepointAliasResponse = { impactedChapters: UnlinkAliasImpactedChapter[]; alreadyPresent: boolean }`.

- [ ] **Step 1: Add types** next to `UnlinkAliasArgs`/`AddAliasResponse` in `src/lib/api.ts`:

```ts
export interface RepointAliasArgs {
  bookId: string;
  sourceCharacterId: string;
  aliasName: string;
  targetCharacterId: string;
}
export interface RepointAliasResponse {
  /** Same lineage shape as unlink — candidate lines to (optionally) move to
      the target via the reused ReassignLinesModal (unlink source). */
  impactedChapters: UnlinkAliasImpactedChapter[];
  /** Target already carried the alias (or it equals the target's name). */
  alreadyPresent: boolean;
}
```

- [ ] **Step 2: Add `realRepointAlias`** next to `realAddAlias`:

```ts
async function realRepointAlias({
  bookId,
  sourceCharacterId,
  aliasName,
  targetCharacterId,
}: RepointAliasArgs): Promise<RepointAliasResponse> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/repoint-alias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceCharacterId, aliasName, targetCharacterId }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Re-point alias failed (${res.status}).`);
  }
  return res.json();
}
```

- [ ] **Step 3: Add `mockRepointAlias`** next to `mockAddAlias` (stateless, like the other alias mocks — the reducer applies the delta from the live store):

```ts
async function mockRepointAlias({ aliasName }: RepointAliasArgs): Promise<RepointAliasResponse> {
  await wait(60);
  if (!aliasName.trim()) throw new Error('Alias name cannot be empty.');
  /* impactedChapters intentionally empty (same reason as mockUnlinkAlias); the
     ReassignLinesModal renders its empty state. */
  return { impactedChapters: [], alreadyPresent: false };
}
```

- [ ] **Step 4: Wire into both api objects.** Add `repointAlias: realRepointAlias,` next to `unlinkAlias: realUnlinkAlias,` (~line 9390) and `repointAlias: mockRepointAlias,` next to `unlinkAlias: mockUnlinkAlias,` (~line 9668).

- [ ] **Step 5: Verify types compile.**

Run: `npm run typecheck`
Expected: PASS (no errors). This task has no standalone unit test — the mock/real client is exercised by Task 6 (layout wiring) and the e2e spec (Task 7). Typecheck is the gate that both api objects still share the same shape.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): add api.repointAlias client + types (#1676 b)"
```

---

## Task 3: Cast reducer `applyRepointAlias` + persist rule

**Files:**
- Modify: `src/store/cast-slice.ts`
- Modify: `src/store/persistence-middleware.ts`
- Test: `src/store/cast-slice.test.ts`, `src/store/persistence-middleware.test.ts`

**Interfaces:**
- Produces: `castActions.applyRepointAlias({ sourceCharacterId, aliasName, targetCharacterId })`.

- [ ] **Step 1: Write failing reducer tests.** Append to `src/store/cast-slice.test.ts` (mirror the `applyAddAlias` block at ~line 729). Use the same `makeState`/initial-cast helpers the neighboring tests use:

Uses the file's real idiom: `castSlice.reducer(start, action)` (NOT a bare `castReducer`) and `baseState([makeChar(id, { name, aliases })])` — copy the exact form from the `applyAddAlias` block at ~line 729.

```ts
describe('castSlice — applyRepointAlias (POST /cast/repoint-alias response)', () => {
  it('strips the alias off the source and appends it to the target', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Я', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Sior']);
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual(['Я']);
  });

  it('dedups case-insensitively on the target (no double add)', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: ['я'] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Я', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual(['я']);
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Sior']);
  });

  it('does not append when the alias equals the target primary name (still strips source)', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Антон', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'egor', aliasName: 'Антон', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual([]);
    expect(next.characters.find((c) => c.id === 'egor')!.aliases).toEqual(['Sior']);
  });

  it('is a no-op when the source or target is missing', () => {
    const start = baseState([
      makeChar('egor', { name: 'Егор', aliases: ['Я', 'Sior'] }),
      makeChar('anton', { name: 'Антон', aliases: [] }),
    ]);
    const next = castSlice.reducer(
      start,
      castActions.applyRepointAlias({ sourceCharacterId: 'ghost', aliasName: 'Я', targetCharacterId: 'anton' }),
    );
    expect(next.characters.find((c) => c.id === 'anton')!.aliases).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/store/cast-slice.test.ts -t "applyRepointAlias"`
Expected: FAIL ("applyRepointAlias is not a function").

- [ ] **Step 3: Implement the reducer.** In `src/store/cast-slice.ts`, add after `applyAddAlias` (Immer draft mutation, mirroring the strip in `applyUnlinkAlias` + the append guard in `applyAddAlias`):

```ts
/* From POST /api/books/:bookId/cast/repoint-alias — move an alias string
   off `sourceCharacterId` and onto `targetCharacterId`. Strip is
   unconditional; append is case-insensitive-idempotent and skipped when the
   alias equals the target's own name (the name already covers it). Idempotent
   under double-dispatch. Line movement is handled separately by the reassign
   modal, exactly as in the unlink flow. */
applyRepointAlias: (
  s,
  a: PayloadAction<{ sourceCharacterId: string; aliasName: string; targetCharacterId: string }>,
) => {
  const { sourceCharacterId, aliasName, targetCharacterId } = a.payload;
  const key = aliasName.trim().toLowerCase();
  if (!key) return;
  const source = s.characters.find((c) => c.id === sourceCharacterId);
  const target = s.characters.find((c) => c.id === targetCharacterId);
  if (!source || !target) return;
  source.aliases = (source.aliases ?? []).filter((n) => n.trim().toLowerCase() !== key);
  if (key === target.name.trim().toLowerCase()) return;
  const existing = target.aliases ?? [];
  if (!existing.some((n) => n.trim().toLowerCase() === key)) {
    target.aliases = [...existing, aliasName.trim()];
  }
},
```

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/store/cast-slice.test.ts -t "applyRepointAlias"`
Expected: PASS (4 tests).

- [ ] **Step 5: Write failing persist-rule test.** In `src/store/persistence-middleware.test.ts`, mirror the `applyAddAlias` test at ~line 163:

Mirror the `applyAddAlias` persist test at ~line 163 EXACTLY — real symbols are `baseState({ cast: {...} })`, `putBookState`, `advance(500)`, and the `{ slice: 'cast', patch: { characters } }` shape (NOT a bare `{ characters }`):

```ts
it('persists the full cast on applyRepointAlias so the moved alias is the authoritative last write', async () => {
  const next = vi.fn((x) => x);
  const state = baseState({
    cast: { characters: [{ id: 'egor', aliases: [] }, { id: 'anton', aliases: ['Я'] }] },
  });
  persistenceMiddleware(makeStore(state))(next)({ type: 'cast/applyRepointAlias' });
  await advance(500);
  expect(putBookState).toHaveBeenCalledWith('book-1', {
    slice: 'cast',
    patch: { characters: [{ id: 'egor', aliases: [] }, { id: 'anton', aliases: ['Я'] }] },
  });
});
```

> The middleware serializes current state on the action type — it does not run the reducer — so `state` is the post-repoint shape (source emptied, target holding the alias).

- [ ] **Step 6: Run to verify failure.**

Run: `npx vitest run src/store/persistence-middleware.test.ts -t "applyRepointAlias"`
Expected: FAIL (no PUT — rule absent).

- [ ] **Step 7: Add the persist rule.** In `src/store/persistence-middleware.ts` `PERSIST_RULES`, add next to `'cast/applyAddAlias'`:

```ts
/* Repoint mutates TWO characters (strip source + append target); mirror
   add-alias' full-cast persist so the latest redux wins any concurrent
   debounced cast PUT. The route also writes cast.json; this is the race-guard. */
'cast/applyRepointAlias': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
```

- [ ] **Step 8: Run to verify pass.**

Run: `npx vitest run src/store/persistence-middleware.test.ts -t "applyRepointAlias"`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/store/cast-slice.ts src/store/cast-slice.test.ts src/store/persistence-middleware.ts src/store/persistence-middleware.test.ts
git commit -m "feat(frontend): applyRepointAlias reducer + persist rule (#1676 b)"
```

---

## Task 4: Unlink destination dialog component

**Files:**
- Create: `src/modals/unlink-alias-dialog.tsx`
- Test: `src/modals/unlink-alias-dialog.test.tsx`

**Interfaces:**
- Produces:
  - `export type UnlinkDestination = { mode: 'split' } | { mode: 'move'; targetCharacterId: string };`
  - `export function UnlinkAliasDialog(props: { aliasName: string; sourceName: string; targets: Character[]; busy?: boolean; error?: string | null; onCancel: () => void; onConfirm: (destination: UnlinkDestination) => void; }): JSX.Element`

- [ ] **Step 1: Write failing tests.** Create `src/modals/unlink-alias-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnlinkAliasDialog } from './unlink-alias-dialog';

const targets = [
  { id: 'anton', name: 'Антон' },
  { id: 'narrator', name: 'Narrator' },
] as never;

function setup(overrides = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <UnlinkAliasDialog
      aliasName="Я"
      sourceName="Егор"
      targets={targets}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe('UnlinkAliasDialog', () => {
  it('defaults to "own character" and confirms a split', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'split' });
  });

  it('requires a target before "move" can continue', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole('radio', { name: /move/i }));
    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('combobox', { name: /move .* to/i }), { target: { value: 'anton' } });
    expect(continueBtn).toHaveProperty('disabled', false);
    fireEvent.click(continueBtn);
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'move', targetCharacterId: 'anton' });
  });

  it('Cancel fires onCancel and never onConfirm', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders an error line when error is set', () => {
    setup({ error: 'Backend exploded' });
    expect(screen.getByText(/Backend exploded/)).toBeTruthy();
  });

  it('disables both buttons while busy', () => {
    setup({ busy: true });
    expect(screen.getByRole('button', { name: /continue/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveProperty('disabled', true);
  });

  it('does not crash with an empty target list (only split selectable)', () => {
    setup({ targets: [] as never });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/modals/unlink-alias-dialog.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the component.** Create `src/modals/unlink-alias-dialog.tsx` (mirror the confirm `alertdialog` styling in `reassign-lines.tsx`; touch targets on every control):

```tsx
import { useState } from 'react';
import type { Character } from '../lib/types';

export type UnlinkDestination = { mode: 'split' } | { mode: 'move'; targetCharacterId: string };

interface Props {
  aliasName: string;
  sourceName: string;
  targets: Character[]; // roster minus source (cast \ this)
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (destination: UnlinkDestination) => void;
}

export function UnlinkAliasDialog({ aliasName, sourceName, targets, busy, error, onCancel, onConfirm }: Props) {
  const [mode, setMode] = useState<'split' | 'move'>('split');
  const [targetId, setTargetId] = useState('');
  const canConfirm = mode === 'split' || (mode === 'move' && targetId !== '');

  function confirm() {
    if (!canConfirm) return;
    onConfirm(mode === 'split' ? { mode: 'split' } : { mode: 'move', targetCharacterId: targetId });
  }

  return (
    <>
      <div onClick={busy ? undefined : onCancel} className="fixed inset-0 bg-ink/40 z-[60]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Unlink alias"
        className="fixed left-1/2 top-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 w-[min(440px,calc(100vw-32px))] bg-white rounded-2xl shadow-drawer p-6"
      >
        <h4 className="text-base font-bold text-ink mb-3">
          Unlink «{aliasName}» from {sourceName} — where should this name go?
        </h4>
        <div className="flex flex-col gap-2 mb-3">
          <label className="flex items-center gap-2 text-sm text-ink/80 min-h-[44px] fine-pointer:min-h-0">
            <input type="radio" name="unlink-dest" checked={mode === 'split'} onChange={() => setMode('split')} />
            Make «{aliasName}» its own character
          </label>
          <label className="flex items-center gap-2 text-sm text-ink/80 min-h-[44px] fine-pointer:min-h-0">
            <input type="radio" name="unlink-dest" checked={mode === 'move'} onChange={() => setMode('move')} />
            Move «{aliasName}» to
            <select
              aria-label={`Move ${aliasName} to`}
              value={targetId}
              disabled={mode !== 'move'}
              onChange={(e) => setTargetId(e.target.value)}
              className="text-sm px-2 py-1.5 rounded-full border border-ink/15 bg-white min-h-[44px] fine-pointer:min-h-0"
            >
              <option value="">Choose…</option>
              {targets.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="text-sm text-red-600/90 mb-3">⚠ {error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-ink/6 hover:bg-ink/10 disabled:opacity-40 min-h-[44px] fine-pointer:min-h-0"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy || !canConfirm}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-magenta text-white hover:bg-magenta/90 disabled:opacity-40 min-h-[44px] fine-pointer:min-h-0"
          >
            Continue
          </button>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/modals/unlink-alias-dialog.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/modals/unlink-alias-dialog.tsx src/modals/unlink-alias-dialog.test.tsx
git commit -m "feat(frontend): unlink destination dialog (#1676 b)"
```

---

## Task 5: Drawer integration — render dialog, widen callback, rewrite tests

**Files:**
- Modify: `src/modals/profile-drawer.tsx`
- Test: `src/modals/profile-drawer.test.tsx`

**Interfaces:**
- Consumes: `UnlinkAliasDialog`, `UnlinkDestination` (Task 4); existing `mergeCandidates?: Character[]` prop (= cast \ this).
- Produces: widened `onUnlinkAlias?: (sourceCharacterId: string, aliasName: string, destination: UnlinkDestination) => Promise<void>`.

- [ ] **Step 1: Rewrite the three existing unlink tests** in `src/modals/profile-drawer.test.tsx` to go through the dialog. **Widen the `renderDrawer` helper's `onUnlinkAlias` type at ~line 117** from the 2-arg `(sourceCharacterId, aliasName) => Promise<void>` to the 3-arg form carrying `destination` — editing only the `vi.fn()` call sites is not enough, the helper's declared type must widen too. `renderDrawer` already threads `mergeCandidates` (verified ~line 147); pass a non-empty `mergeCandidates` so the move option has targets (e.g. `[{ id: 'wren', name: 'Wren' }]`):

```tsx
it('clicking the X opens the dialog; confirming split dispatches onUnlinkAlias', async () => {
  const onUnlinkAlias = vi.fn().mockResolvedValue(undefined);
  renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
  fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
  // Dialog opens; default = split.
  fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
  await waitFor(() => {
    expect(onUnlinkAlias).toHaveBeenCalledWith('halloran', 'Garrow', { mode: 'split' });
  });
});

it('choosing "move to X" dispatches onUnlinkAlias with the move destination', async () => {
  const onUnlinkAlias = vi.fn().mockResolvedValue(undefined);
  renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
  fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
  fireEvent.click(await screen.findByRole('radio', { name: /move/i }));
  fireEvent.change(screen.getByRole('combobox', { name: /move .* to/i }), { target: { value: 'wren' } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => {
    expect(onUnlinkAlias).toHaveBeenCalledWith('halloran', 'Garrow', { mode: 'move', targetCharacterId: 'wren' });
  });
});

it('disables the dialog buttons while the unlink is in flight (no double-fire)', async () => {
  let resolveIt!: () => void;
  const onUnlinkAlias = vi.fn(() => new Promise<void>((r) => { resolveIt = r; }));
  renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
  fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
  fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /continue/i })).toHaveProperty('disabled', true);
  });
  resolveIt();
});

it('surfaces a server error inside the dialog without closing it', async () => {
  const onUnlinkAlias = vi.fn().mockRejectedValue(new Error('Backend exploded'));
  renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
  fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
  fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
  await screen.findByText(/Backend exploded/);
  // Dialog still open (Continue button still present).
  expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy();
});
```

Keep the existing `omits the X button when onUnlinkAlias is not provided` test as-is (still valid — no callback → no ✕).

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/modals/profile-drawer.test.tsx -t "Unlink"`
Expected: FAIL (dialog not wired; ✕ still fires the old 2-arg call).

- [ ] **Step 3: Widen the prop type + import.** In `src/modals/profile-drawer.tsx`:

```ts
import { UnlinkAliasDialog, type UnlinkDestination } from './unlink-alias-dialog';
```
```ts
onUnlinkAlias?: (
  sourceCharacterId: string,
  aliasName: string,
  destination: UnlinkDestination,
) => Promise<void>;
```

- [ ] **Step 4: Add dialog state + rewrite `runUnlinkAlias`.** Add near `aliasBusy`:

```ts
const [unlinkDialogAlias, setUnlinkDialogAlias] = useState<string | null>(null);
```
Replace `runUnlinkAlias` with a destination-aware version (the ✕ now only OPENS the dialog):

```ts
async function runUnlinkAlias(aliasName: string, destination: UnlinkDestination) {
  if (!onUnlinkAlias || aliasBusy) return;
  setAliasBusy(true);
  setAliasError(null);
  try {
    await onUnlinkAlias(character.id, aliasName, destination);
    setUnlinkDialogAlias(null); // close only on success
  } catch (e) {
    setAliasError((e as Error).message || 'Unlink failed.');
  } finally {
    setAliasBusy(false);
  }
}
```

- [ ] **Step 5: Point the ✕ at the dialog** (line ~1400): change `onClick={() => void runUnlinkAlias(a)}` to `onClick={() => setUnlinkDialogAlias(a)}` and drop the `disabled={aliasBusy}` on the chip ✕ (the dialog now owns the busy state; leave the button enabled so re-opening after a cancel works).

- [ ] **Step 6: Render the dialog.** Near the drawer's other conditional modals, add:

```tsx
{unlinkDialogAlias && onUnlinkAlias && (
  <UnlinkAliasDialog
    aliasName={unlinkDialogAlias}
    sourceName={character.name}
    targets={mergeCandidates ?? []}
    busy={aliasBusy}
    error={aliasError}
    onCancel={() => {
      if (aliasBusy) return;
      setUnlinkDialogAlias(null);
      setAliasError(null);
    }}
    onConfirm={(destination) => void runUnlinkAlias(unlinkDialogAlias, destination)}
  />
)}
```

- [ ] **Step 7: Run to verify pass.**

Run: `npx vitest run src/modals/profile-drawer.test.tsx`
Expected: PASS (all, including the rewritten unlink tests).

- [ ] **Step 8: Commit.**

```bash
git add src/modals/profile-drawer.tsx src/modals/profile-drawer.test.tsx
git commit -m "feat(frontend): route alias unlink through destination dialog (#1676 b)"
```

---

## Task 6: Layout wiring — split vs move branches

**Files:**
- Modify: `src/components/layout.tsx`

**Interfaces:**
- Consumes: `api.repointAlias` (Task 2), `castActions.applyRepointAlias` (Task 3), `UnlinkDestination` (Task 4), existing `ReassignSource` (`kind: 'unlink'`).

- [ ] **Step 1: Replace the `onUnlinkAlias` handler** (~lines 2105–2132) to branch on the destination. Import `UnlinkDestination` if not already available via the drawer's exported type:

```tsx
onUnlinkAlias={
  bookId
    ? async (sourceCharacterId, aliasName, destination) => {
        if (destination.mode === 'split') {
          const res = await api.unlinkAlias({ bookId, sourceCharacterId, aliasName });
          dispatch(castActions.applyUnlinkAlias({ sourceCharacterId, aliasName, newCharacter: res.newCharacter }));
          setReassignSource({
            kind: 'unlink',
            impactedChapters: res.impactedChapters,
            aliasCharacterId: res.newCharacter.id,
          });
        } else {
          const { targetCharacterId } = destination;
          const res = await api.repointAlias({ bookId, sourceCharacterId, aliasName, targetCharacterId });
          dispatch(castActions.applyRepointAlias({ sourceCharacterId, aliasName, targetCharacterId }));
          setReassignSource({
            kind: 'unlink',
            impactedChapters: res.impactedChapters,
            aliasCharacterId: targetCharacterId,
          });
        }
      }
    : undefined
}
```

- [ ] **Step 2: Verify typecheck + existing layout/reassign tests stay green.**

Run: `npm run typecheck && npx vitest run src/modals/reassign-lines.test.tsx`
Expected: PASS. (No new unit test here — the branch is covered end-to-end by the e2e spec in Task 7; the modal contract for both branches is already covered by `reassign-lines.test.tsx`'s `kind:'unlink'` case.)

- [ ] **Step 3: Commit.**

```bash
git add src/components/layout.tsx
git commit -m "feat(frontend): split vs move-to-X branches in unlink handler (#1676 b)"
```

---

## Task 7: e2e — update existing chain + add move-to-X path

**Files:**
- Modify: `e2e/cast-alias-edit.spec.ts`

- [ ] **Step 1: Update the existing test** so the ✕ → dialog → "own character" → Continue chain still reaches the modal. After `await unlinkCap.click();` (line ~68), insert the dialog interaction before asserting the modal:

```ts
/* #1676(b): the X now opens a destination dialog first. Default is
   "own character" (today's split), so Continue reaches the same modal. */
const dialog = page.getByRole('dialog', { name: 'Unlink alias' });
await expect(dialog).toBeVisible({ timeout: 5_000 });
await dialog.getByRole('button', { name: /continue/i }).click();
```

- [ ] **Step 2: Add a move-to-X test** in the same `describe`. It adds an alias to Halloran, then unlinks it choosing "Move to" another cast member, and asserts the reassign modal opens (seeded to the target). Pick a second character present on the mock confirm-cast view (e.g. the narrator or any other roster card — verify the exact name via the mock cast fixture):

```ts
test('user can move an alias onto another character (repoint), which opens the reassign modal', async ({ page }) => {
  await goToConfirm(page);
  await waitForRouteReady(page);
  const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(page.getByText('Also known as')).toBeVisible({ timeout: 10_000 });
  await page.getByText('Also known as').scrollIntoViewIfNeeded();

  await page.getByRole('button', { name: 'Add alias' }).click();
  const input = page.getByRole('textbox', { name: 'New alias name' });
  await input.fill('Skipper');
  await input.press('Enter');

  await page.getByRole('button', { name: 'Unlink Skipper' }).click();
  const dialog = page.getByRole('dialog', { name: 'Unlink alias' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /move/i }).click();
  // Select the first available target from the picker.
  const select = dialog.getByRole('combobox', { name: /move .* to/i });
  await select.selectOption({ index: 1 }); // index 0 = "Choose…"
  await dialog.getByRole('button', { name: /continue/i }).click();

  // Reassign modal opens (mock returns empty impactedChapters → empty state).
  const modal = page.getByRole('dialog', { name: 'Reassign lines' });
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await modal.getByRole('button', { name: 'Close' }).click();

  // Skipper chip is gone from Halloran (moved onto the target).
  await expect(page.getByRole('button', { name: 'Unlink Skipper' })).toHaveCount(0);
});
```

- [ ] **Step 3: Run the spec.**

Run: `npx playwright test e2e/cast-alias-edit.spec.ts --project=chromium`
Expected: PASS (2 tests). (Requires `npx playwright install chromium` once.)

> **Portal watch (finding from plan review):** the dialog renders inline in `ProfileDrawer`, whose root is `fixed … overflow-y-auto` with a slide animation. A `position: fixed` child should escape the clip at rest, but the repo has a prior "modal clipped by clip-path → portal to body" incident. If this e2e shows the dialog clipped/off-center, wrap it in `createPortal(…, document.body)` (mirror the existing `createPortal` usage in `profile-drawer.tsx`). jsdom unit tests (Task 4) are unaffected either way.

- [ ] **Step 4: Commit.**

```bash
git add e2e/cast-alias-edit.spec.ts
git commit -m "test(e2e): dialog + move-to-X alias repoint path (#1676 b)"
```

---

## Task 8: Docs — regression plan, INDEX, release notes

**Files:**
- Modify: `docs/features/1676-cast-bulk-line-reassignment.md`
- Modify: `docs/features/INDEX.md` (only if the title/scope line changes)
- Modify: `RELEASE_NOTES.md`, `docs/release-notes-next.md`

- [ ] **Step 1: Fold part (b) into the regression plan.** Widen the scope of `docs/features/1676-cast-bulk-line-reassignment.md` to cover b+c (retitle if it names only "bulk line reassignment"). Add a section documenting: the destination dialog (split vs move), the `repoint-alias` route + `applyRepointAlias` reducer + persist rule, and a manual acceptance walkthrough (unlink a mis-merged name → Move to X → lines follow → chip lands on X). Cite the new tests as the automated coverage.

- [ ] **Step 2: Update INDEX** if the plan's title/scope line changed. (If the entry already reads generically, no change — say so.)

- [ ] **Step 3: Release notes.** Append to `docs/release-notes-next.md` (technical register, ref this branch's PR) and add a matching brand-voice line to the in-progress version section at the TOP of `RELEASE_NOTES.md`:

> Unlinking a mis-merged name now lets you move it straight onto the right character — not just split it into a new one.

- [ ] **Step 4: Commit.**

```bash
git add docs/features/1676-cast-bulk-line-reassignment.md docs/features/INDEX.md RELEASE_NOTES.md docs/release-notes-next.md
git commit -m "docs(docs): fold alias-repoint (b) into regression plan + release notes (#1676 b)"
```

---

## Final verification

- [ ] **Full branch-scoped battery.**

Run: `npm run verify:fast:branch`
Expected: lint + typecheck + config:check + test:hooks + test + test:server + build all green (each scope-gated).

- [ ] **Open the PR.** Body: `Refs #1676` (this issue stays open only if further parts remain; part (b) completes the issue → use `Closes #1676`). Fill Summary + Test plan. Then run the mandatory `code-review` gate (medium effort — multi-scope `feat`), fold findings, merge.

---

## Self-review notes (author)

- **Spec coverage:** dialog (§1)→T4/T5; repoint route (§2)→T1; api layer (§3)→T2; reducer+persist (§4)→T3; layout wiring (§5)→T6; data flow→T6+T7; edge cases (name-collision, alreadyPresent, buckets, empty impacted, drift)→T1 tests + reused modal; testing (§Testing)→T1/T3/T4/T5/T7; release notes→T8. No gap.
- **Type consistency:** `UnlinkDestination` defined in T4, consumed identically in T5/T6; `RepointAliasResponse.{impactedChapters,alreadyPresent}` defined T2, produced T1, consumed T6; `applyRepointAlias` payload identical across T3/T6.
- **Known approximations flagged for the implementer:** the reducer/persist test snippets say "mirror the exact import/fixture idiom of the neighboring `applyAddAlias` block" rather than reproducing harness plumbing that must match the file; the e2e move-target name is "verify against the mock fixture." These are deliberate — the surrounding file is the source of truth for those mechanics.
