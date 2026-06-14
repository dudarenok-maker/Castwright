# fe-5 Coarse-Pointer Hover-Reveal Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every hover-*hidden action* reachable on touch devices by applying the `coarse-pointer:` / `fine-pointer:` Tailwind variants, leaving purely-decorative hover feedback untouched.

**Architecture:** Three reveal-tier controls get a touch fallback. Two hide via plain `opacity-0`, so an additive `coarse-pointer:opacity-100` deterministically wins (unprefixed utilities sort before variants in Tailwind v4). One (`generation.tsx`) hides via the `sm:` width breakpoint, which would create an equal-specificity ordering race against `coarse-pointer:` on tablets — so it is migrated to a `fine-pointer:`-gated hide (mutually-exclusive media queries, no race), which also restores its 44px touch target on tablets for free.

**Tech Stack:** Vite + React 18 + TypeScript, Tailwind v4 (`@custom-variant coarse-pointer`/`fine-pointer` in `src/styles.css`), Vitest + React Testing Library (unit), Playwright chromium/mobile-chrome/tablet-chrome (e2e).

**Spec:** `docs/superpowers/specs/2026-06-14-fe5-coarse-pointer-hover-audit-design.md`

---

## Background the engineer needs

- The variant is already defined: `src/styles.css:53` — `@custom-variant coarse-pointer (@media (pointer: coarse));` and `:54` `fine-pointer (@media (pointer: fine))`. No CSS/config change is needed; just use the variants in `className` strings.
- **Tailwind v4 ordering fact this plan relies on:** an *unprefixed* utility (`opacity-0`) always emits earlier in the generated stylesheet than any *variant* utility (`coarse-pointer:opacity-100`), so the variant wins by source order at equal specificity. But *two* variant utilities (`sm:opacity-0` vs `coarse-pointer:opacity-100`) have no guaranteed order — that is why `generation.tsx` is refactored instead of patched additively.
  - **This additive pattern is already shipped and working in-repo** — `src/views/manuscript.tsx:1368` and `src/components/library/continue-listening-rail.tsx:145` both use `opacity-0 group-hover:opacity-100 coarse-pointer:opacity-NN`. Tasks 2 & 3 copy that proven pattern. **Task 1's `fine-pointer:`-gated hide is the only mechanism with no in-repo precedent** — it's the one to scrutinise in review (manually confirm on a tablet emulator that the button is visible and 44px, and that a desktop mouse still hides-until-hover).
- **Playwright gotcha:** `toBeVisible()` does **not** consider `opacity` — an `opacity:0` element still reports visible. Assertions MUST read `getComputedStyle(el).opacity`.
- **Pointer emulation:** `mobile-chrome` (Pixel 7) reports `pointer: coarse`; `chromium` (Desktop Chrome) reports `pointer: fine`. The e2e branches on the *runtime* `matchMedia('(pointer: coarse)')` result so it is self-consistent on every project; `mobile-chrome` guarantees the coarse path is exercised.
- **The books grid renders on every viewport.** `src/views/book-library.tsx:199` forces `effectiveViewMode='card'` on mobile, and the default stored mode is `'card'`, so `<LibraryGrid>` (with its `aria-label="Book options"` button) is present on chromium/mobile/tablet. The table view's menu uses `aria-label="Actions for {title}"`, so `"Book options"` unambiguously targets the grid card.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/views/generation.tsx` | Per-character regenerate control | Migrate `sm:` hide → `fine-pointer:` hide; keep 44px touch target; fix comment |
| `src/components/library/library-grid.tsx` | Book-card options ⋯ trigger | `+ coarse-pointer:opacity-100` |
| `src/components/mini-player.tsx` | Scrubber thumb dot | `+ coarse-pointer:opacity-100` + `data-testid` hook |
| `src/views/generation.test.tsx` | Unit guard for the regenerate fix | Add 1 test |
| `src/views/book-library.test.tsx` | Unit guard for the options ⋯ fix | Add 1 test |
| `src/components/mini-player.test.tsx` | Unit guard for the thumb fix | Add 1 test |
| `e2e/responsive/coarse-pointer-reveals.spec.ts` | Real coarse-pointer behavior proof | Create |
| `docs/BACKLOG.md` | Backlog view | Remove the `fe-5` row |

---

## Task 1: Migrate the generation regenerate button to `fine-pointer:` gating

**Files:**
- Modify: `src/views/generation.tsx:1784-1799`
- Test: `src/views/generation.test.tsx`

- [ ] **Step 1: Write the failing unit test**

Add this test inside `src/views/generation.test.tsx`, in the existing
`describe('GenerationView — chapter & character metadata (regression for screenshot bug)')`
block (it already calls `renderView()` and expands a chapter row exposing the per-character
regenerate buttons). Place it after the existing
`it('renders per-character line + word counts …')` test:

```tsx
  it('regenerate-in-chapter button stays visible + 44px on touch (fe-5)', () => {
    renderView();
    // Chapters render collapsed; expand Chapter 1 so the per-character rows
    // (and their regenerate buttons) mount — mirrors the sibling test above.
    fireEvent.click(screen.getByText('Chapter 1'));
    // The regenerate buttons are labelled `Regenerate {name} in this chapter`.
    const btn = screen.getAllByRole('button', { name: /Regenerate .+ in this chapter/i })[0];
    // Touch fallback: base opacity-100 + the fine-pointer-gated hide (mouse only),
    // NOT the old sm: width-proxy that hid the action on tablets.
    expect(btn).toHaveClass('opacity-100');
    expect(btn).toHaveClass('fine-pointer:opacity-0');
    expect(btn).toHaveClass('fine-pointer:group-hover:opacity-100');
    expect(btn.className).not.toContain('sm:opacity-0');
    // WCAG 2.5.5: keep the 44px target on touch; mouse shrinks via fine-pointer.
    expect(btn).toHaveClass('min-w-[44px]');
    expect(btn).toHaveClass('min-h-[44px]');
    expect(btn).toHaveClass('fine-pointer:w-7');
    expect(btn).toHaveClass('fine-pointer:h-7');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/views/generation.test.tsx -t "stays visible \+ 44px on touch"`
Expected: FAIL — the button still has `sm:opacity-0` / lacks `fine-pointer:opacity-0`.

- [ ] **Step 3: Apply the implementation**

In `src/views/generation.tsx`, replace the comment block at lines 1784-1788 and the
`className` at line 1796. The current code is:

```tsx
                  {status !== 'skipped' && (
                    /* Hover-reveal is desktop-only; on touch (`hover: none`)
                        the button stays visible so users can actually reach it.
                        Touch target hits 44×44 via min-w/min-h on phone, while
                        desktop keeps the compact 28px hover-revealed swatch. */
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRegenerateCharacterInChapter(cid, chapter.id);
                      }}
                      title={`Regenerate ${c.name} in this chapter`}
                      aria-label={`Regenerate ${c.name} in this chapter`}
                      className="sm:opacity-0 sm:group-hover:opacity-100 text-ink/40 hover:text-magenta grid place-items-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:w-7 sm:h-7 rounded-full hover:bg-ink/6 transition-all"
                    >
```

Replace it with:

```tsx
                  {status !== 'skipped' && (
                    /* Hover-reveal is mouse-only. Gate the hide on `fine-pointer:`
                       (mice) rather than the `sm:` width breakpoint: `fine-pointer`
                       and `coarse-pointer` are mutually-exclusive media queries, so
                       touch devices (incl. tablets ≥640px) keep the button visible at
                       its full 44×44 target, while a mouse hides it until group-hover
                       and shrinks it to the compact 28px swatch. The old `sm:` proxy
                       hid the action on touch tablets — fe-5. */
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRegenerateCharacterInChapter(cid, chapter.id);
                      }}
                      title={`Regenerate ${c.name} in this chapter`}
                      aria-label={`Regenerate ${c.name} in this chapter`}
                      className="opacity-100 fine-pointer:opacity-0 fine-pointer:group-hover:opacity-100 text-ink/40 hover:text-magenta grid place-items-center min-w-[44px] min-h-[44px] fine-pointer:min-w-0 fine-pointer:min-h-0 fine-pointer:w-7 fine-pointer:h-7 rounded-full hover:bg-ink/6 transition-all"
                    >
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/views/generation.test.tsx -t "stays visible \+ 44px on touch"`
Expected: PASS.

- [ ] **Step 5: Run the full generation suite to confirm no regression**

Run: `npm run test -- src/views/generation.test.tsx`
Expected: PASS (all existing tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/views/generation.tsx src/views/generation.test.tsx
git commit -m "fix(frontend): reveal regenerate button on touch via fine-pointer gating (fe-5)"
```

---

## Task 2: Add the coarse-pointer fallback to the book-options ⋯ trigger

**Files:**
- Modify: `src/components/library/library-grid.tsx:250`
- Test: `src/views/book-library.test.tsx`

- [ ] **Step 1: Write the failing unit test**

Add this test in `src/views/book-library.test.tsx`. The file already has a module-level
`renderView({ loaded, authors })` helper and a `oneAuthor` fixture (one book → one grid
card), and an existing test reaches the card menu via `getByLabelText(/Book options/i)`.
Reuse them verbatim. Add a standalone `it(...)` inside the top-level `describe`:

```tsx
  it('book-options menu trigger is revealed on touch (coarse pointer) — fe-5', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    const trigger = screen.getAllByLabelText(/Book options/i)[0];
    expect(trigger).toHaveClass('coarse-pointer:opacity-100');
    // Desktop hover-reveal behavior preserved.
    expect(trigger).toHaveClass('opacity-0');
    expect(trigger).toHaveClass('group-hover:opacity-100');
  });
```

(`renderView` and `oneAuthor` are already defined at the top of this file — do not redefine
them. jsdom's default 1024px width keeps `effectiveViewMode='card'`, so the grid card and its
`aria-label="Book options"` trigger render.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/views/book-library.test.tsx -t "revealed on touch"`
Expected: FAIL — `coarse-pointer:opacity-100` is not yet on the element.

- [ ] **Step 3: Apply the implementation**

In `src/components/library/library-grid.tsx:250`, the current button className is:

```tsx
            className="w-7 h-7 grid place-items-center rounded-full bg-black/30 hover:bg-black/50 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
```

Change it to (insert `coarse-pointer:opacity-100` after `group-hover:opacity-100`):

```tsx
            className="w-7 h-7 grid place-items-center rounded-full bg-black/30 hover:bg-black/50 text-white opacity-0 group-hover:opacity-100 coarse-pointer:opacity-100 focus:opacity-100 transition-opacity"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/views/book-library.test.tsx -t "revealed on touch"`
Expected: PASS.

- [ ] **Step 5: Run the full book-library suite**

Run: `npm run test -- src/views/book-library.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/library/library-grid.tsx src/views/book-library.test.tsx
git commit -m "fix(frontend): reveal book-options menu on touch via coarse-pointer (fe-5)"
```

---

## Task 3: Add the coarse-pointer fallback to the mini-player scrubber thumb

**Files:**
- Modify: `src/components/mini-player.tsx:670-672`
- Test: `src/components/mini-player.test.tsx`

- [ ] **Step 1: Apply the implementation (component change first — it adds the test hook)**

In `src/components/mini-player.tsx`, the scrubber thumb span at line 671 is:

```tsx
              <span
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-canvas opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                style={{ left: `${progress * 100}%` }}
```

Change it to add `coarse-pointer:opacity-100` and a stable `data-testid` hook:

```tsx
              <span
                data-testid="scrubber-thumb"
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-canvas opacity-0 group-hover:opacity-100 coarse-pointer:opacity-100 transition-opacity pointer-events-none"
                style={{ left: `${progress * 100}%` }}
```

- [ ] **Step 2: Write the test**

Add this test to `src/components/mini-player.test.tsx` in a new `describe` block at the end
of the file. The file already defines `renderPlayer(ui)`, `noop`, and `chapter1`; the thumb
span renders unconditionally whenever the player mounts (no duration gating). Use this exact
prop set (copied from the resume test in this file):

```tsx
describe('MiniPlayer — scrubber thumb touch fallback (fe-5)', () => {
  it('thumb carries the coarse-pointer reveal fallback', () => {
    const { getByTestId } = renderPlayer(
      <MiniPlayer
        chapter={chapter1}
        bookId="book-1"
        onClose={noop}
        onPrev={noop}
        onNext={noop}
        prevAvailable={false}
        nextAvailable={true}
      />,
    );
    const thumb = getByTestId('scrubber-thumb');
    expect(thumb).toHaveClass('coarse-pointer:opacity-100');
    expect(thumb).toHaveClass('opacity-0'); // hidden by default for mouse
    expect(thumb).toHaveClass('group-hover:opacity-100');
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm run test -- src/components/mini-player.test.tsx -t "coarse-pointer reveal fallback"`
Expected: PASS (component change from Step 1 already applied).

- [ ] **Step 4: Run the full mini-player suite**

Run: `npm run test -- src/components/mini-player.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mini-player.tsx src/components/mini-player.test.tsx
git commit -m "fix(frontend): reveal scrubber thumb on touch via coarse-pointer (fe-5)"
```

---

## Task 4: Add the real coarse-pointer behavior e2e

**Files:**
- Create: `e2e/responsive/coarse-pointer-reveals.spec.ts`

- [ ] **Step 1: Create the spec**

Write `e2e/responsive/coarse-pointer-reveals.spec.ts`:

```ts
/* fe-5 — coarse-pointer hover-reveal proof.
 *
 * Runs across all three projects (chromium / mobile-chrome / tablet-chrome)
 * via the e2e/responsive/*.spec.ts testMatch glob. Playwright's toBeVisible()
 * ignores opacity, so we read getComputedStyle().opacity directly and branch
 * on the project's *runtime* pointer type: a coarse pointer (touch) must reveal
 * the action without hover; a fine pointer (mouse) must keep it hidden until
 * hover. mobile-chrome guarantees the coarse branch is exercised; chromium
 * (in the pre-push battery) covers the fine branch.
 */
import { test, expect } from '@playwright/test';

test.describe('coarse-pointer hover-reveal affordances (fe-5)', () => {
  test('book-options ⋯ trigger respects pointer type', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Book options' }).first();
    await trigger.waitFor({ state: 'attached', timeout: 10_000 });

    const { isCoarse, opacity } = await trigger.evaluate((el) => ({
      isCoarse: window.matchMedia('(pointer: coarse)').matches,
      opacity: getComputedStyle(el as HTMLElement).opacity,
    }));

    if (isCoarse) {
      // Touch: the menu trigger is reachable without any hover.
      expect(opacity, 'options trigger should be revealed on coarse pointer').toBe('1');
    } else {
      // Mouse: stays hidden until hover (desktop affordance unchanged).
      expect(opacity, 'options trigger should be hover-hidden on fine pointer').toBe('0');
    }
  });
});
```

- [ ] **Step 2: Run the spec on chromium (fine pointer — pre-push tier)**

Run: `npm run test:e2e -- coarse-pointer-reveals`
Expected: PASS — chromium reports fine pointer, asserts opacity `'0'`.

- [ ] **Step 3: Run the spec on mobile + tablet (coarse path)**

Run: `npx playwright test --project=mobile-chrome --project=tablet-chrome e2e/responsive/coarse-pointer-reveals.spec.ts`
Expected: PASS — mobile-chrome reports coarse pointer, asserts opacity `'1'`.

If `tablet-chrome` reports fine pointer (chromium iPad emulation can), it asserts the
fine branch and still passes — that is intentional and correct.

- [ ] **Step 4: Commit**

```bash
git add e2e/responsive/coarse-pointer-reveals.spec.ts
git commit -m "test(frontend): e2e proves coarse-pointer reveals book-options menu (fe-5)"
```

---

## Task 5: Retire the backlog row and run the full battery

**Files:**
- Modify: `docs/BACKLOG.md`

- [ ] **Step 1: Remove the fe-5 backlog block**

In `docs/BACKLOG.md`, delete the entire `fe-5` block (keep the `### UI & accessibility`
heading above it — `fs-14` lives under it). Remove these lines:

```markdown
#### `fe-5` — Broad hover-affordance audit with `coarse-pointer:` Tailwind variant ([#402](https://github.com/dudarenok-maker/AudioBook-Generator/issues/402))

- _What:_ Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (matches `@media (pointer: coarse)`) for touch devices that don't expose hover. First consumer is the manuscript boundary handle label. Sweep `src/` for all uses of `group-hover:` / `peer-hover:` / `hover:opacity-0` and apply the variant where the hover-revealed content is functional (e.g. action buttons), not purely decorative (e.g. card lift transitions).
- _Benefit (user):_ touch users get every action that mouse users do, without needing to discover hidden affordances.
_Full detail + acceptance:_ [#402](https://github.com/dudarenok-maker/AudioBook-Generator/issues/402).

```

(Leave the `### UI & accessibility` heading and the following `#### \`fs-14\`` block intact.)

- [ ] **Step 2: Commit**

```bash
git add docs/BACKLOG.md
git commit -m "docs(docs): retire fe-5 backlog row (shipped)"
```

- [ ] **Step 3: Run the full pre-push battery**

Run: `npm run verify`
Expected: PASS — typecheck + all unit tests + e2e (chromium) + build all green.
If `verify` reports a flake unrelated to these changes, re-run the single failing leg in
isolation and surface it per CLAUDE.md's triage rule rather than bypassing.

- [ ] **Step 4: Open the PR (draft)**

```bash
git push -u origin feat/frontend-fe5-coarse-pointer-reveals
gh pr create --draft --title "fix(frontend): coarse-pointer fallbacks for hover-hidden actions (fe-5)" --body "$(cat <<'EOF'
## Summary

Applies the `coarse-pointer:` / `fine-pointer:` Tailwind variants so the three
hover-*hidden actions* are reachable on touch:

- **Regenerate-in-chapter** (`generation.tsx`) — migrated off the `sm:` width
  proxy (which hid it on touch tablets) to a `fine-pointer:`-gated hide; keeps a
  44px touch target on touch, compact 28px hover swatch on mouse.
- **Book-options ⋯** (`library-grid.tsx`) — `+coarse-pointer:opacity-100`.
- **Scrubber thumb** (`mini-player.tsx`) — `+coarse-pointer:opacity-100`.

Purely-decorative hover feedback (color/bg shifts on already-visible controls) is
left untouched, per the issue's "not purely decorative" scope line.

Spec: `docs/superpowers/specs/2026-06-14-fe5-coarse-pointer-hover-audit-design.md`

## Test plan

- Unit (Vitest): className guards on all three reveals (`generation.test.tsx`,
  `book-library.test.tsx`, `mini-player.test.tsx`).
- E2E (`e2e/responsive/coarse-pointer-reveals.spec.ts`): asserts the book-options
  trigger is revealed under a real coarse pointer (mobile-chrome) and hidden under
  a fine pointer (chromium). Run `npm run verify` green locally.

Closes #402
EOF
)"
```

- [ ] **Step 5: When verify is green, mark the PR ready**

Run: `gh pr ready` (fires exactly one billed CI verify run before merge).

---

## Self-review notes

- **Spec coverage:** all three reveal-tier controls from the spec have a fix task (1/2/3) + paired test; the e2e (Task 4) satisfies the "real coarse-pointer simulation" acceptance; the decorative-tier "leave untouched" decision is enforced by *not* changing those files (no task touches them) — the spec's out-of-scope list is informational. Backlog/issue closure is Task 5.
- **Placeholder scan:** the only intentional "mirror the existing helper" notes are in Tasks 2 & 3, where the surrounding test file already defines the store/props helper and the engineer must reuse the real names rather than a guessed one — the exact selectors (`getByLabelText(/Book options/i)`, `getByTestId('scrubber-thumb')`, `getAllByRole('button', { name: /Regenerate .+ in this chapter/i })`) and assertions are fully specified.
- **Type/className consistency:** the className strings asserted in the unit tests (Task 1/2/3 Step 1) are byte-for-byte the strings written in the implementation steps (`opacity-100 fine-pointer:opacity-0 fine-pointer:group-hover:opacity-100 … fine-pointer:w-7 fine-pointer:h-7`; `coarse-pointer:opacity-100`).
