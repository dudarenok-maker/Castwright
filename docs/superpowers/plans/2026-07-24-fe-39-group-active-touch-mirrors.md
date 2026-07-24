# fe-39 — Decorative `group-active:` Touch Mirrors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give touch users a press-feedback flash on four decorative controls by adding a `group-active:X` variant mirroring each control's existing `group-hover:X`, with a class-presence regression test per control.

**Architecture:** Pure Tailwind-v4 variant additions. Each edit appends `group-active:` variant(s) alongside the existing `group-hover:` on one leaf `<span>`; no resting classes change, no component logic changes. Each of the four touched components already has a `.test.tsx`; each gets one added `it(...)` block asserting the mirror is present (and, for the Add-book tile, that no resting peach leaked in).

**Tech Stack:** React + TypeScript, Tailwind CSS v4 (CSS-first, no config file), Vitest + `@testing-library/react` (jsdom).

## Global Constraints

- **Add-only:** never change, remove, or reorder an existing resting or `group-hover:` class. Only append `group-active:` variant(s). — verbatim from spec "Approach".
- **Caveat (a):** the Add-book tile must **not** carry a bare (non-variant) resting `bg-peach` / `border-peach` / `text-white`. Peach appears only under `group-active:` / `hover:`. — verbatim from spec "Caveat (a)".
- **Tailwind is v4**, no `tailwind.config.js`. `group-active` is built-in; no config change. `active:` variants already compile in this repo (10+ files).
- **Test shape:** class-presence assertion against the **rendered DOM** `className` (jsdom, Tailwind not compiled) — never a raw-file source scan. Assert both the existing `group-hover:X` and the new `group-active:X` are present on the same element.
- **Commit style:** conventional commits. Frontend changes use `fix(frontend): …` or `test(frontend): …`. Hooks may bootstrap a Python venv and hang; commit with `git -c core.hooksPath=/dev/null` if a hook stalls (docs/tests/leaf-CSS only — no server code touched).
- **Line numbers** below are as of 2026-07-24 and may drift; anchor by the quoted className string, not the line number.

---

### Task 1: Rail play badge (`continue-listening-rail.tsx`)

**Files:**
- Modify: `src/components/library/continue-listening-rail.tsx` (~line 111, the play-badge `<span>`)
- Test: `src/components/library/continue-listening-rail.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on. (All four tasks are independent.)

The current element:
```tsx
<span className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-white/20 group-hover:bg-white/35 transition-colors grid place-items-center">
```
The `group` ancestor is the native `<button type="button">` card at line 84; `:active` chains to the wrapping `group` div, so the mirror fires on touch.

- [ ] **Step 1: Write the failing test**

Add this block to `continue-listening-rail.test.tsx`. It renders the rail with one item, reaches the card button by its accessible name, then asserts the play badge (the `bg-white/20` span inside it) carries both variants.

```tsx
it('play badge mirrors group-hover with group-active for touch press feedback (fe-39)', () => {
  render(<ContinueListeningRail items={items} onOpen={noop} onFinish={noop} onHide={noop} />);
  const card = screen.getByRole('button', { name: /Continue listening to The Coalfall Commission/i });
  const badge = card.querySelector('span.bg-white\\/20');
  expect(badge).not.toBeNull();
  expect(badge!.className).toContain('group-hover:bg-white/35');
  expect(badge!.className).toContain('group-active:bg-white/35');
});
```

Note: reuse the existing `items` / `noop` fixtures already defined in this test file (the existing "renders … Coalfall" test uses them). If the first item's title differs, match the accessible name to whatever the existing fixtures use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/library/continue-listening-rail.test.tsx -t "touch press feedback"`
Expected: FAIL — `expect(received).toContain('group-active:bg-white/35')`, received string lacks the token.

- [ ] **Step 3: Write minimal implementation**

In `continue-listening-rail.tsx`, on the play-badge span, add `group-active:bg-white/35` immediately after `group-hover:bg-white/35`:

```tsx
<span className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-white/20 group-hover:bg-white/35 group-active:bg-white/35 transition-colors grid place-items-center">
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/library/continue-listening-rail.test.tsx -t "touch press feedback"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/library/continue-listening-rail.tsx src/components/library/continue-listening-rail.test.tsx
git commit -m "fix(frontend): mirror rail play-badge hover with group-active for touch (fe-39)"
```

---

### Task 2: "Add book" tile (`library-grid.tsx`)

**Files:**
- Modify: `src/components/library/library-grid.tsx` (~line 559, the inner circle `<span>`)
- Test: `src/components/library/library-grid.test.tsx`

**Interfaces:**
- Consumes / Produces: nothing (independent task).

The current element (inner circle inside the `group` button `data-tour-id="new-book-btn"`):
```tsx
<span className="w-14 h-14 mx-auto rounded-full bg-white border border-ink/10 grid place-items-center group-hover:bg-peach group-hover:border-peach group-hover:text-white transition-colors text-ink">
```

- [ ] **Step 1: Write the failing test**

Add to `library-grid.test.tsx`. Reach the Add-book button (rendered when the grid shows the add tile — match how the existing tests trigger it; the button has `data-tour-id="new-book-btn"`), find the inner circle, assert all three `group-active:` mirrors are present **and** caveat (a): the resting classes are intact and no bare `bg-peach` leaked in.

The `NewBookCard` (Add-book tile, `data-tour-id="new-book-btn"`) renders inside `LibraryGrid` whenever the library is non-empty. Reuse the existing module-level `renderGrid(...)` helper and the `authorsWith(...)` fixture builder already in this file (the existing tests call `renderGrid(authorsWith(undefined))`).

```tsx
it('Add-book tile mirrors hover with group-active, no resting peach (fe-39, caveat a)', () => {
  renderGrid(authorsWith(undefined));
  const addBtn = document.querySelector('[data-tour-id="new-book-btn"]') as HTMLElement;
  expect(addBtn).not.toBeNull();
  const circle = addBtn.querySelector('span.rounded-full') as HTMLElement;
  expect(circle).not.toBeNull();
  // mirrors present
  expect(circle.className).toContain('group-active:bg-peach');
  expect(circle.className).toContain('group-active:border-peach');
  expect(circle.className).toContain('group-active:text-white');
  // resting appearance intact
  expect(circle.className).toContain('bg-white');
  expect(circle.className).toContain('border-ink/10');
  // caveat (a): peach only ever appears as a variant, never bare
  // (regex requires start-or-whitespace before the token, so `group-hover:bg-peach`
  //  and `group-active:bg-peach` — preceded by ':' — do NOT match)
  expect(circle.className).not.toMatch(/(^|\s)bg-peach(\s|$)/);
  expect(circle.className).not.toMatch(/(^|\s)border-peach(\s|$)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/library/library-grid.test.tsx -t "caveat a"`
Expected: FAIL — the three `group-active:` tokens are absent.

- [ ] **Step 3: Write minimal implementation**

On the inner-circle span, append the three mirrors after the existing `group-hover:` trio:

```tsx
<span className="w-14 h-14 mx-auto rounded-full bg-white border border-ink/10 grid place-items-center group-hover:bg-peach group-hover:border-peach group-hover:text-white group-active:bg-peach group-active:border-peach group-active:text-white transition-colors text-ink">
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/library/library-grid.test.tsx -t "caveat a"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/library/library-grid.tsx src/components/library/library-grid.test.tsx
git commit -m "fix(frontend): mirror Add-book tile hover with group-active for touch (fe-39)"
```

---

### Task 3: "Review ›" chip (`setup-wizard.tsx`)

**Files:**
- Modify: `src/components/setup/setup-wizard.tsx` (~line 459, the "Review ›" `<span>`)
- Test: `src/components/setup/setup-wizard.test.tsx`

**Interfaces:**
- Consumes / Produces: nothing (independent task).

The current element (inside the `group` `<button>` at line 442):
```tsx
<span className="text-xs font-medium text-ink/40 group-hover:text-magenta shrink-0">
  Review &rsaquo;
</span>
```

- [ ] **Step 1: Write the failing test**

The "Review ›" chips live in the local `SetupSummary` component, which the orchestrator renders immediately in **`mode="checklist"`** (`wizardStep` starts `null` → `SetupSummary`). No step navigation needed. Reuse the existing module-level `READINESS` fixture and the `SetupWizard` import already in this file. Each summary row renders a "Review ›" chip carrying `group-hover:text-magenta`; `.find(...)` on that class disambiguates and asserting the first is sufficient (all rows get the same mirror).

```tsx
it('Review chip mirrors group-hover with group-active for touch (fe-39)', () => {
  render(<SetupWizard readiness={READINESS} mode="checklist" onRefetch={() => {}} onFinish={() => {}} />);
  const chip = screen
    .getAllByText(/Review/)
    .find((el) => el.className.includes('group-hover:text-magenta'));
  expect(chip).toBeTruthy();
  expect(chip!.className).toContain('group-hover:text-magenta');
  expect(chip!.className).toContain('group-active:text-magenta');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/setup/setup-wizard.test.tsx -t "Review chip mirrors"`
Expected: FAIL — `group-active:text-magenta` absent.

- [ ] **Step 3: Write minimal implementation**

Append `group-active:text-magenta` after `group-hover:text-magenta`:

```tsx
<span className="text-xs font-medium text-ink/40 group-hover:text-magenta group-active:text-magenta shrink-0">
  Review &rsaquo;
</span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/setup/setup-wizard.test.tsx -t "Review chip mirrors"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/setup-wizard.tsx src/components/setup/setup-wizard.test.tsx
git commit -m "fix(frontend): mirror wizard Review chip hover with group-active for touch (fe-39)"
```

---

### Task 4: Voice-library drag icon (`voice-library-panel.tsx`)

**Files:**
- Modify: `src/components/voice-library-panel.tsx` (~line 388, the drag-icon `<span>`)
- Test: `src/components/voice-library-panel.test.tsx`

**Interfaces:**
- Consumes / Produces: nothing (independent task).

The current element (`group` ancestor is the `<div class="group … active:cursor-grabbing">` row at line 303, already proven to receive `:active`):
```tsx
<span className="text-ink/30 group-hover:text-ink/60 transition-colors mt-1 hidden md:inline">
  <IconDrag className="w-4 h-4" />
</span>
```
The span is `hidden md:inline` — press feedback is only observable on `md`+ touch devices; in jsdom (Tailwind not compiled) the element is present regardless, so the class-presence test is unaffected.

- [ ] **Step 1: Write the failing test**

The drag icon renders in the default (non-`isAssigningTarget`) branch of each voice row. Reuse the `makeVoice`/`makeCharacter` fixtures and the same `VoiceLibraryPanel` prop set the existing tests use (`library`, `characters`, `draggingVoiceId`, `setDraggingVoiceId`, `onOpenProfile`, `onPlaySample`). Query the drag-icon span via its unique `group-hover:text-ink/60` class (CSS-escape the `:` and `/`).

```tsx
it('drag icon mirrors group-hover with group-active for touch (fe-39)', () => {
  render(
    <VoiceLibraryPanel
      library={[makeVoice('v_marlow', 'Marlow')]}
      characters={[makeCharacter('marlow', 'v_marlow')]}
      draggingVoiceId={null}
      setDraggingVoiceId={vi.fn()}
      onOpenProfile={vi.fn()}
      onPlaySample={vi.fn()}
    />,
  );
  const dragIcon = document.querySelector('span.group-hover\\:text-ink\\/60');
  expect(dragIcon).not.toBeNull();
  expect(dragIcon!.className).toContain('group-hover:text-ink/60');
  expect(dragIcon!.className).toContain('group-active:text-ink/60');
});
```

Note: the drag-icon span is `hidden md:inline`, but jsdom does not compile Tailwind, so the element is present in the DOM regardless of viewport — the query resolves.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/voice-library-panel.test.tsx -t "drag icon mirrors"`
Expected: FAIL — `group-active:text-ink/60` absent.

- [ ] **Step 3: Write minimal implementation**

Append `group-active:text-ink/60` after `group-hover:text-ink/60`:

```tsx
<span className="text-ink/30 group-hover:text-ink/60 group-active:text-ink/60 transition-colors mt-1 hidden md:inline">
  <IconDrag className="w-4 h-4" />
</span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/voice-library-panel.test.tsx -t "drag icon mirrors"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/voice-library-panel.tsx src/components/voice-library-panel.test.tsx
git commit -m "fix(frontend): mirror voice-library drag-icon hover with group-active for touch (fe-39)"
```

---

### Task 5: Verification gates, #799 note, and PR

**Files:** none modified (verification + PR only).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no new errors. (Worktree needs `server/node_modules` for a clean typecheck — junction it from the main checkout if missing.)

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS. (Prettier is not a gate here — do not reformat; ESLint only.)

- [ ] **Step 3: Run the four updated test files together**

Run: `npm run test -- src/components/library/continue-listening-rail.test.tsx src/components/library/library-grid.test.tsx src/components/setup/setup-wizard.test.tsx src/components/voice-library-panel.test.tsx`
Expected: PASS, all four new assertions green. (Full frontend suite is **not** required — no shared component was touched; all four edits are leaf className changes.)

- [ ] **Step 4: One-time manual touch smoke-check**

Start the app, open Chrome DevTools, toggle device/touch emulation (activates `coarse-pointer` + `:active` on tap). Confirm a visible press-flash on at least control #1 (rail play badge) and control #2 (Add-book tile). Record the result in the PR body. Real iOS Safari is best-effort; DevTools touch emulation is accepted as sufficient because the fire-on-touch mechanism is confirmed native in the spec.

- [ ] **Step 5: Post the scope note to #799**

Post a comment on issue #799 recording the 4-of-7 decision: mirrors added to controls #1–#4 (rail badge, Add-book tile, Review chip, drag icon); `revision-diff.tsx:551`/`:584` and `manuscript.tsx:2088` dropped as verified no-ops (state-override and drag-state-redundant respectively); sibling container-level hover effects deliberately left unmirrored.

```bash
gh issue comment 799 --body "fe-39 scoped to 4 of 7 controls after live verification: mirrored #1 rail play badge, #2 Add-book tile, #3 Review chip, #4 voice-library drag icon. Dropped revision-diff badges (:551/:584 — tap flips isPlaying which overrides the color) and manuscript boundary tint (:2088 — drag sets isThisDragging, redundant). Sibling container-level hover effects (outer tile tint, card shadow, row bg) intentionally not mirrored — see spec."
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/frontend-fe-39-group-active-mirrors
gh pr create --title "fix(frontend): touch press-feedback parity via group-active mirrors (fe-39)" --body "<mini release notes: what/why, the 4 controls, the 3 dropped no-ops, test approach, manual smoke-check result>

Closes #799"
```

Expected: PR opens with `Closes #799` (literal) in the body. Validate the title against the repo's PR-title convention before creating.

---

## Notes for the implementer

- **Do the edits in the order above**, but the four component tasks are fully independent — a reviewer can accept or reject any one without the others.
- **Anchor edits by the quoted className string**, not line numbers (they drift).
- If a component's existing test file lacks a render path that reaches the touched element, add the minimal render/props to reach it (matching prop names/fixtures already used in that file) — do **not** invent a new test harness or fall back to a raw-file source scan.
- If a commit hook stalls on a Python venv bootstrap, these are leaf CSS/test/docs changes only (no server code) — `git -c core.hooksPath=/dev/null commit …` is acceptable; note it in the PR.
