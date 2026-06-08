# Variant-design Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user filter cast members (primary) and cross-book voices (secondary) by whether they still need emotion variants designed, and resurrect the dead fs-25 "Has variants" cast chip.

**Architecture:** One shared key-emitter (`statusFilterKeys` in `voice-status.ts`) gains a `Needs variants` key from the already-existing `countMissingVariants`. The cast view threads its already-computed `usedEmotions` into both the chip tally and the row predicate, and fixes the tally so `Variants` is actually counted. The Voices view caches sentences (already returned by `getBookState`) and adds an All/Has/Needs toggle over its Qwen "Designed voices" section.

**Tech Stack:** React 18 + TypeScript + Redux Toolkit; Vitest + React Testing Library (jsdom); Playwright (chromium).

**Spec:** `docs/superpowers/specs/2026-06-08-variant-design-filters-design.md`
**Branch:** `feat/frontend-variant-design-filters` (already cut)

> **Commit note:** husky's pre-commit can't spawn in some shells on this box (`Exec format error`). Each commit step uses `git commit --no-verify`; the task's own `npm run ...` test step is the gate. Run the full `npm run verify` once at the end (Task 6).

---

## File Structure

- `src/lib/voice-status.ts` — add optional `usedEmotions` param + `Needs variants` key to `statusFilterKeys`. (Pure, unit-tested.)
- `src/lib/voice-status.test.ts` — new cases for the `Needs variants` key.
- `src/views/cast.tsx` — thread `usedEmotions` into the tally + predicate; tally `Variants` and `Needs variants`; add `Needs variants` to `CHIP_ORDER`; add `CHIP_LABELS`.
- `src/views/cast.test.tsx` — chip render/count/filter cases (incl. the resurrected `Has variants`).
- `src/views/voices.tsx` — sentences cache; `missingVariantCountByVoiceId`; All/Has/Needs toggle gating the Qwen designed section.
- `src/views/voices.test.tsx` — toggle filter cases.
- `e2e/cast-variant-filter.spec.ts` — (optional, Task 5) browser-level cast filter check.
- `docs/BACKLOG.md`, spec frontmatter — issue hygiene (Task 6).

---

## Task 1: `Needs variants` filter key in `voice-status.ts`

**Files:**
- Modify: `src/lib/voice-status.ts:161-171`
- Test: `src/lib/voice-status.test.ts` (append to the `describe('statusFilterKeys …')` block at `:216`)

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe('statusFilterKeys — cast-view filter keys', …)` block (the `char`/`voice`/`QWEN`/`KOKORO` helpers already exist in this file):

```ts
  it('keys a designed Qwen character with an unmet in-use emotion as "Needs variants"', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x', variants: {} } } });
    const used = new Set(['angry']);
    expect(statusFilterKeys(c, voice({ generated: true }), QWEN, used)).toEqual([
      'Generated',
      'Needs variants',
    ]);
  });

  it('omits "Needs variants" when every in-use emotion has a designed variant', () => {
    const c = char({
      overrideTtsVoices: { qwen: { name: 'qwen-x', variants: { angry: { name: 'qwen-x-angry' } } } },
    });
    expect(statusFilterKeys(c, voice({ generated: true }), QWEN, new Set(['angry']))).toEqual([
      'Generated',
    ]);
  });

  it('omits "Needs variants" when usedEmotions is undefined', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x', variants: {} } } });
    expect(statusFilterKeys(c, voice({ generated: true }), QWEN)).toEqual(['Generated']);
  });

  it('never keys "Needs variants" for a non-Qwen character', () => {
    const c = char({ voiceState: 'generated' });
    expect(statusFilterKeys(c, undefined, KOKORO, new Set(['angry']))).toEqual(['Matched']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/voice-status.test.ts`
Expected: FAIL — the new cases get `['Generated']` etc. without the `'Needs variants'` element (the 4th param is ignored today).

- [ ] **Step 3: Implement the key**

Replace `statusFilterKeys` (`src/lib/voice-status.ts:161-171`) with:

```ts
export function statusFilterKeys(
  c: Character,
  voice: Voice | undefined,
  effectiveEngine: TtsEngine,
  /** fs-34 — the character's in-use non-neutral emotions
      (`usedEmotionsByCharacter(...).get(c.id)`). When provided, a Qwen-effective
      character with ≥1 in-use emotion lacking a designed variant also matches
      the "Needs variants" chip. Optional so existing callers keep compiling. */
  usedEmotions?: Set<string>,
): string[] {
  const { lifecycle, reused, hasEmotionVariants } = resolveVoiceStatus(c, voice, effectiveEngine);
  const keys = [lifecycle?.label ?? 'Unset'];
  if (reused) keys.push('Reused');
  if (hasEmotionVariants) keys.push('Variants');
  const isQwen = effectiveEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen';
  if (isQwen && countMissingVariants(c, usedEmotions) > 0) keys.push('Needs variants');
  return keys;
}
```

`countMissingVariants` is already defined in this file (`:74`) — no new import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/voice-status.test.ts`
Expected: PASS (all cases, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/voice-status.ts src/lib/voice-status.test.ts
git commit --no-verify -m "feat(frontend): emit Needs variants filter key from statusFilterKeys"
```

---

## Task 2: Cast-view chips — fix tally, thread emotions, label chips

**Files:**
- Modify: `src/views/cast.tsx` — `CHIP_ORDER` (`:105-117`), `statusKeysFor` (`:233-234`), `statusBuckets` memo (`:279-302`), chip label render (`:649`)
- Test: `src/views/cast.test.tsx` (append to the chip `describe` block near `:1011`)

`usedEmotions`, `countMissingVariants`, `usedEmotionsByCharacter`, and `resolveVoiceStatus` are already imported/computed in `cast.tsx` (`:25-26`, `:133`).

- [ ] **Step 1: Write the failing tests**

In `cast.test.tsx`, inside the chip-filter `describe`, add a designed-Qwen-with-missing-variant fixture and tests. Add this fixture next to `ghost`/`blank` (around `:1037`):

```ts
  // Designed Qwen voice, speaks an "angry" quote, but has NO angry variant ⇒ "Needs variants".
  const fury: Character = {
    id: 'fury',
    name: 'Fury',
    role: 'Rival',
    color: 'mentor',
    lines: 4,
    scenes: 1,
    attributes: [],
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-fury', variants: {} } },
  };
  // Designed Qwen voice WITH the matching variant ⇒ "Has variants", not "Needs variants".
  const calm: Character = {
    id: 'calm',
    name: 'Calm',
    role: 'Sage',
    color: 'mentor',
    lines: 4,
    scenes: 1,
    attributes: [],
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-calm', variants: { angry: { name: 'qwen-calm-angry' } } } },
  };
  const variantSentences: Sentence[] = [
    { id: 1, chapterId: 1, text: 'No!', characterId: 'fury', emotion: 'angry', kind: 'dialogue' },
    { id: 2, chapterId: 1, text: 'Peace.', characterId: 'calm', emotion: 'angry', kind: 'dialogue' },
  ];

  function renderVariantView() {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
    });
    return render(
      <Provider store={store}>
        <CastView
          characters={[fury, calm]}
          setCharacters={() => {}}
          library={library}
          sentences={variantSentences}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
  }

  it('renders the resurrected "Has variants" chip with its count', () => {
    renderVariantView();
    expect(chip(/^Has variants/).textContent).toContain('1'); // calm only
  });

  it('renders the "Needs variants" chip and filters to unmet-variant rows', () => {
    renderVariantView();
    expect(chip(/^Needs variants/).textContent).toContain('1'); // fury only
    fireEvent.click(chip(/^Needs variants/));
    expect(isPresent('Fury')).toBe(true);
    expect(isPresent('Calm')).toBe(false);
  });
```

Confirm `Sentence` is imported at the top of `cast.test.tsx`; if not, add it to the `../lib/types` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/views/cast.test.tsx`
Expected: FAIL — `chip(/^Has variants/)` and `chip(/^Needs variants/)` throw "Unable to find role button" (neither chip renders today).

- [ ] **Step 3a: Add `Needs variants` to `CHIP_ORDER` + a label map**

In `cast.tsx`, change the tail of `CHIP_ORDER` (`:113-117`) and add `CHIP_LABELS` right after it:

```ts
  'Unset',
  'Reused',
  /* fs-25 / fs-34 — variant capability chips, last. */
  'Variants',
  'Needs variants',
];

/* Display labels for chips whose internal key differs from what we want shown.
   The key stays stable (it flows through statusFilters + statusFilterKeys);
   only the chip text changes. */
const CHIP_LABELS: Record<string, string> = {
  Variants: 'Has variants',
  'Needs variants': 'Needs variants',
};
```

- [ ] **Step 3b: Thread `usedEmotions` into the row predicate**

Replace `statusKeysFor` (`cast.tsx:233-234`) with:

```ts
  const statusKeysFor = (c: Character): string[] =>
    statusFilterKeys(c, findVoiceForCharacter(c, library), effectiveEngineFor(c), usedEmotions.get(c.id));
```

- [ ] **Step 3c: Tally `Variants` and `Needs variants` in `statusBuckets`**

In the `statusBuckets` memo (`cast.tsx:279-302`), pull the full status + add the two variant tallies inside the loop, and add `usedEmotions` to the deps. Replace the memo body with:

```ts
  const statusBuckets = useMemo(() => {
    const tally = new Map<string, { color: StatusPillColor; count: number }>();
    for (const c of characters) {
      const effectiveEngine = c.ttsEngine ?? ttsEngine;
      const voice = findVoiceForCharacter(c, library);
      const { lifecycle, reused, hasEmotionVariants } = resolveVoiceStatus(c, voice, effectiveEngine);
      const lifecycleKey = lifecycle?.label ?? 'Unset';
      const lifecycleColor: StatusPillColor = lifecycle?.color ?? 'neutral';
      tally.set(lifecycleKey, {
        color: lifecycleColor,
        count: (tally.get(lifecycleKey)?.count ?? 0) + 1,
      });
      if (reused) {
        tally.set('Reused', { color: 'library', count: (tally.get('Reused')?.count ?? 0) + 1 });
      }
      if (hasEmotionVariants) {
        tally.set('Variants', { color: 'library', count: (tally.get('Variants')?.count ?? 0) + 1 });
      }
      const isQwen = effectiveEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen';
      if (isQwen && countMissingVariants(c, usedEmotions.get(c.id)) > 0) {
        tally.set('Needs variants', {
          color: 'warning',
          count: (tally.get('Needs variants')?.count ?? 0) + 1,
        });
      }
    }
    return CHIP_ORDER.filter((key) => tally.has(key)).map((key) => ({
      key,
      color: tally.get(key)!.color,
      count: tally.get(key)!.count,
    }));
  }, [characters, library, ttsEngine, usedEmotions]);
```

- [ ] **Step 3d: Render the chip label via the map**

In the chip button (`cast.tsx:649`), change `<span>{b.key}</span>` to:

```tsx
                  <span>{CHIP_LABELS[b.key] ?? b.key}</span>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/views/cast.test.tsx`
Expected: PASS — both new cases plus all pre-existing chip cases (which assert `/^Needs voice/`, `/^Matched/`, etc., unaffected by the label map).

- [ ] **Step 5: Commit**

```bash
git add src/views/cast.tsx src/views/cast.test.tsx
git commit --no-verify -m "feat(frontend): cast Has/Needs variants chips (+ fix dead fs-25 tally)"
```

---

## Task 3: Voices-view All/Has/Needs variants toggle

**Files:**
- Modify: `src/views/voices.tsx` — imports (`:6-28`), state, `hydrateForeignCast` (`:709-768`), a new `missingVariantCountByVoiceId` memo (beside `:232`), the section render (`:1096-1112`)
- Test: `src/views/voices.test.tsx` (new `describe` block at end of file)

- [ ] **Step 1: Write the failing test**

Append a new block to `voices.test.tsx`. It mounts the open-book path (ui ready stage + redux cast + redux manuscript sentences) so no async hydrate is needed:

```ts
describe('fe-34 — variant filter toggle', () => {
  const designedNeeds: Character = {
    id: 'fury', name: 'Fury', role: 'Rival', color: 'mentor', lines: 4, scenes: 1, attributes: [],
    ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-fury', variants: {} } },
  };
  const designedHas: Character = {
    id: 'calm', name: 'Calm', role: 'Sage', color: 'mentor', lines: 4, scenes: 1, attributes: [],
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-calm', variants: { angry: { name: 'qwen-calm-angry' } } } },
  };
  const sentences: Sentence[] = [
    { id: 1, chapterId: 1, text: 'No!', characterId: 'fury', emotion: 'angry', kind: 'dialogue' },
    { id: 2, chapterId: 1, text: 'Peace.', characterId: 'calm', emotion: 'angry', kind: 'dialogue' },
  ];
  const qwenLib: Voice[] = [
    { id: 'qwen-fury', character: 'Fury', bookId: 'b1', bookTitle: 'Book One', attributes: [],
      usedIn: 1, source: 'current', gradient: ['#000', '#111'],
      ttsVoice: { provider: 'qwen', name: 'qwen-fury', description: '' } },
    { id: 'qwen-calm', character: 'Calm', bookId: 'b1', bookTitle: 'Book One', attributes: [],
      usedIn: 1, source: 'current', gradient: ['#000', '#111'],
      ttsVoice: { provider: 'qwen', name: 'qwen-calm', description: '' } },
  ];

  function renderToggleView() {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer, cast: castSlice.reducer, manuscript: manuscriptSlice.reducer,
        notifications: notificationsSlice.reducer, voices: voicesSlice.reducer,
        library: librarySlice.reducer, rebaseline: rebaselineSlice.reducer,
      },
    });
    store.dispatch(uiActions.bookOpened({ bookId: 'b1' })); // ui.stage.kind = 'ready', bookId 'b1'
    store.dispatch(castActions.hydrate({ characters: [designedNeeds, designedHas] }));
    store.dispatch(manuscriptActions.setSentences(sentences));
    return render(
      <Provider store={store}>
        <LibraryView library={qwenLib} />
      </Provider>,
    );
  }

  it('narrows the designed voices to needs-variants when "Needs variants" is selected', () => {
    renderToggleView();
    expect(screen.getByText('Calm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Needs variants/ }));
    expect(screen.getByText('Fury')).toBeInTheDocument();
    expect(screen.queryByText('Calm')).toBeNull();
  });

  it('narrows to has-variants when "Has variants" is selected', () => {
    renderToggleView();
    fireEvent.click(screen.getByRole('button', { name: /^Has variants/ }));
    expect(screen.getByText('Calm')).toBeInTheDocument();
    expect(screen.queryByText('Fury')).toBeNull();
  });
});
```

> Match the real action creators/selectors used elsewhere in `voices.test.tsx` and the slices. If `uiActions.bookOpened` / `castActions.hydrate` / `manuscriptActions.setSentences` differ in name, grep the slice files and the top of `voices.test.tsx` for the exact creators already used to seed an open book, and substitute. The store-reducer set mirrors the file's other render helpers.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/views/voices.test.tsx`
Expected: FAIL — `getByRole('button', { name: /^Needs variants/ })` not found (no toggle yet).

- [ ] **Step 3a: Imports + state + open-book sentences**

In `voices.tsx`, add to the `../lib/voice-status` usage — it isn't imported yet, so add an import near `:28`:

```ts
import { usedEmotionsByCharacter, countMissingVariants } from '../lib/voice-status';
```

Add `Sentence` to the `../lib/types` import list (`:6-13`):

```ts
  Sentence,
```

Inside `LibraryView`, near the other `useState` hooks (after `:135`), add:

```ts
  /* fe-34 — variant filter for the Qwen "Designed voices" section. */
  const [variantFilter, setVariantFilter] = useState<'all' | 'has' | 'needs'>('all');
  /* fe-34 — sentences per foreign book, cached from the same getBookState the
     duplicate/compare flows already fetch. The open book reads redux below. */
  const [sentencesByBookId, setSentencesByBookId] = useState<Map<string, Sentence[]>>(
    () => new Map(),
  );
```

Add the open-book sentences selector next to the other selectors (after `:172`):

```ts
  const openBookSentences = useAppSelector((s) => s.manuscript.sentences);
```

- [ ] **Step 3b: Cache sentences on foreign hydrate**

In `hydrateForeignCast`, in the success branch right after the cast `setGlobalCastCache(...)` block (`:738-742`), add:

```ts
      const sents = res?.manuscriptEdits?.sentences ?? [];
      setSentencesByBookId((prev) => {
        const next = new Map(prev);
        next.set(bookId, sents);
        return next;
      });
```

- [ ] **Step 3c: `missingVariantCountByVoiceId` memo**

Add immediately after the existing `variantCountByVoiceId` memo (`:232-242`):

```ts
  /* fe-34 — per-voice count of in-use emotions that LACK a designed variant.
     Mirrors variantCountByVoiceId but needs the book's sentences (redux for
     the open book, the cache for foreign books — 0 until a book hydrates). */
  const missingVariantCountByVoiceId = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of qwenLibrary) {
      const source =
        v.bookId === currentBookId ? characters : (globalCastCache.get(v.bookId) ?? null);
      const ch = source ? findCharacterForVoice(v, source) : null;
      if (!ch) continue;
      const sents =
        v.bookId === currentBookId ? openBookSentences : (sentencesByBookId.get(v.bookId) ?? []);
      const used = usedEmotionsByCharacter(sents).get(ch.id);
      const n = countMissingVariants(ch, used);
      if (n > 0) map.set(v.id, n);
    }
    return map;
  }, [qwenLibrary, currentBookId, characters, globalCastCache, openBookSentences, sentencesByBookId]);
```

- [ ] **Step 3d: Apply the filter to the Qwen library + hide families**

Replace the `qwenGroups` memo (`:228`) with a filtered variant, and add a `showFamilies` flag:

```ts
  const filteredQwenLibrary = useMemo(() => {
    if (variantFilter === 'all') return qwenLibrary;
    const map = variantFilter === 'has' ? variantCountByVoiceId : missingVariantCountByVoiceId;
    return qwenLibrary.filter((v) => (map.get(v.id) ?? 0) > 0);
  }, [qwenLibrary, variantFilter, variantCountByVoiceId, missingVariantCountByVoiceId]);
  const qwenGroups = useMemo(
    () => buildQwenStatusGroups(filteredQwenLibrary, tab),
    [filteredQwenLibrary, tab],
  );
  /* When a variant filter is active, preset (non-Qwen) families and the
     "Needs a voice" bucket aren't variant-relevant, so hide everything but the
     matching Qwen designed voices. */
  const showFamilies = variantFilter === 'all';
```

> Delete the old `const qwenGroups = useMemo(() => buildQwenStatusGroups(qwenLibrary, tab), [qwenLibrary, tab]);` line so it isn't declared twice.

- [ ] **Step 3e: Render the toggle + gate families**

In the render, gate the families map on `showFamilies` (`:1076`):

```tsx
          {showFamilies && families.map((f) => (
```

Add the toggle control just above the families/qwen render, right after the `<div className={…dragging…}>` opens (after `:988`). Render it only when there are Qwen voices:

```tsx
          {qwenLibrary.length > 0 && (
            <div
              className="flex items-center gap-2 flex-wrap"
              role="group"
              aria-label="Filter by emotion variants"
            >
              <span className="text-xs text-ink/50">Variants:</span>
              {(['all', 'has', 'needs'] as const).map((key) => {
                const label = key === 'all' ? 'All' : key === 'has' ? 'Has variants' : 'Needs variants';
                const active = variantFilter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setVariantFilter(key)}
                    aria-pressed={active}
                    className={`min-h-[44px] sm:min-h-0 inline-flex items-center px-3 py-2 sm:py-1.5 rounded-full text-sm font-medium transition-colors ${
                      active
                        ? 'bg-ink text-canvas'
                        : 'border border-ink/10 bg-white text-ink/70 hover:text-ink hover:bg-ink/4'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
              {variantFilter !== 'all' && (
                <span className="text-[11px] text-ink/45">
                  Counts fill in as other books load.
                </span>
              )}
            </div>
          )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/views/voices.test.tsx`
Expected: PASS — toggle narrows the designed voices correctly.

- [ ] **Step 5: Typecheck the two changed views**

Run: `npm run typecheck`
Expected: no errors. (Catches a wrong action-creator name from the test note, or a missing `Sentence`/import.)

- [ ] **Step 6: Commit**

```bash
git add src/views/voices.tsx src/views/voices.test.tsx
git commit --no-verify -m "feat(frontend): Voices view Has/Needs variants toggle (fe-34)"
```

---

## Task 4: Run the frontend suite + lint

**Files:** none (verification only).

- [ ] **Step 1: Full frontend unit run**

Run: `npm run test`
Expected: PASS (all frontend specs). If a pre-existing chip test broke, it's almost certainly the label map — confirm those tests match on `/^Needs voice/` etc. (lifecycle keys, unaffected), not on `Variants`.

- [ ] **Step 2: Lint + format**

Run: `npm run lint`
Expected: clean. Fix any unused-import or formatting nits introduced.

- [ ] **Step 3: Commit (only if lint auto-fixed files)**

```bash
git add -A
git commit --no-verify -m "chore(frontend): lint fixups for variant filters"
```

---

## Task 5 (OPTIONAL): Playwright e2e for the cast Needs-variants filter

> **Scope call:** the mock pipeline currently has **no** Qwen-designed character, per-sentence emotions, or variant maps (`src/mocks/` has none). A real e2e needs new mock fixtures — a meaningful lift for a `moscow:could` item. The jsdom RTL tests in Tasks 2–3 already cover the redux + filter behaviour. **Recommendation: defer** unless the user wants the browser-level net. If deferred, say so in the PR's Test plan. The steps below are the path if you do it.

**Files:**
- Modify: a mock manuscript/cast fixture so one book renders a designed-Qwen character that speaks a non-neutral emotion with no matching variant (grep `src/mocks/canned-data.ts` + `src/mocks/voices.ts` + `src/mocks/manuscripts/` for the cast/sentence seams; add `emotion: 'angry'` to one dialogue sentence and an `overrideTtsVoices.qwen` with `variants: {}` on its character).
- Create: `e2e/cast-variant-filter.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';

test('cast view filters to characters needing emotion variants', async ({ page }) => {
  await page.goto('/#/books');
  // Open the seeded book and navigate to its cast view (mirror e2e/cast.spec.ts navigation).
  // …open book, land on #/books/:id/cast…
  const needs = page.getByRole('button', { name: /^Needs variants/ });
  await expect(needs).toBeVisible();
  await needs.click();
  // The designed-but-missing-variant character remains; a fully-voiced one is hidden.
  await expect(page.getByText('Fury')).toBeVisible();
  await expect(page.getByText('Calm')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- cast-variant-filter`
Expected: PASS. (Requires `npx playwright install chromium` once.)

- [ ] **Step 3: Commit**

```bash
git add e2e/cast-variant-filter.spec.ts src/mocks/
git commit --no-verify -m "test(e2e): cast Needs-variants filter"
```

---

## Task 6: Verify, issue hygiene, PR

**Files:**
- Modify: `docs/BACKLOG.md` (remove the fe-34 row, `:272-276`), spec frontmatter `status: draft → active`.

- [ ] **Step 1: Full battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build). This is the real gate (the commits used `--no-verify` because the hook can't spawn).

- [ ] **Step 2: File the dead-chip bug issue**

```bash
gh issue create --label bug --label area:fe \
  --title "fe — 'Has emotion variants' cast chip never renders (fs-25 tally omission)" \
  --body "statusBuckets in src/views/cast.tsx never tallied the 'Variants' key, so CHIP_ORDER.filter(key => tally.has(key)) always dropped it — the fs-25 'Has emotion variants' chip was unreachable. Fixed in the fe-34 PR by tallying Variants + adding Needs variants."
```

Note the returned issue number as `#BUG`.

- [ ] **Step 3: Remove the fe-34 backlog row**

Delete the `#### \`fe-34\` …` block in `docs/BACKLOG.md` (`:272-276`).

- [ ] **Step 4: Promote the spec status**

In `docs/superpowers/specs/2026-06-08-variant-design-filters-design.md`, change `**Status:** draft` to `**Status:** active`.

- [ ] **Step 5: Commit hygiene**

```bash
git add docs/BACKLOG.md docs/superpowers/specs/2026-06-08-variant-design-filters-design.md
git commit --no-verify -m "docs(frontend): close fe-34 backlog row + promote spec"
```

- [ ] **Step 6: Push + open a draft PR**

```bash
git push -u origin feat/frontend-variant-design-filters
gh pr create --draft \
  --title "feat(frontend): Has/Needs emotion-variant filters (fe-34)" \
  --body "$(cat <<'EOF'
## Summary
Adds "Has variants" / "Needs variants" filtering so the user can find cast members (and cross-book voices) that still need emotion variants designed — the missing slice in the book → cast workflow. Also resurrects the dead fs-25 "Has emotion variants" cast chip (the tally never counted it).

- Cast view: working Has variants + new Needs variants chips (Qwen-gated, live counts, filters rows).
- Voices view: All / Has / Needs variants toggle over the Qwen "Designed voices" section (fe-34). Foreign-book counts fill in lazily as casts/sentences hydrate.
- Shared `statusFilterKeys` gains a `Needs variants` key from the existing `countMissingVariants`.

## Test plan
- `src/lib/voice-status.test.ts` — Needs variants key across Qwen/non-Qwen/has/needs/undefined.
- `src/views/cast.test.tsx` — resurrected Has variants chip + Needs variants chip render/count/filter.
- `src/views/voices.test.tsx` — toggle narrows the designed section to has/needs.
- [e2e: deferred — mock pipeline lacks Qwen+emotion fixtures; RTL covers the logic] OR `e2e/cast-variant-filter.spec.ts`.
- `npm run verify` green locally.

Closes #595
Closes #BUG
EOF
)"
```

Replace `#BUG` with the issue number from Step 2. Leave the PR as a draft; run `gh pr ready` only after `npm run verify` is green (CI-cost default).

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1 voice-status → Task 1; §2 cast tally/threading/labels → Task 2; §3 voices cache+memo+toggle → Task 3; testing → Tasks 1–5; issue hygiene → Task 6. All spec sections map to a task.
- **Placeholder scan:** `#BUG` is an explicit "fill from Step 2 output" handle, not a vague TODO; the e2e navigation comment is inside the clearly-marked OPTIONAL task with a grep pointer. No "add error handling"/"write tests for the above" style gaps.
- **Type consistency:** `statusFilterKeys(c, voice, engine, usedEmotions?)` defined in Task 1 and called with the 4th arg in Task 2 (`usedEmotions.get(c.id)`). `variantFilter: 'all'|'has'|'needs'`, `sentencesByBookId: Map<string, Sentence[]>`, `missingVariantCountByVoiceId: Map<string,number>` used consistently in Task 3. `CHIP_LABELS` keys (`Variants`, `Needs variants`) match `CHIP_ORDER` entries.
- **Risk flagged:** Task 3's test uses assumed action-creator names (`bookOpened`/`hydrate`/`setSentences`) with an explicit instruction to grep the slices for the real names — the only spot needing live confirmation.
