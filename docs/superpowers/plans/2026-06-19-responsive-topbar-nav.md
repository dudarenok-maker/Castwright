# Responsive Top-Bar Nav — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below `xl` (1280px), collapse the top-bar navigation into a leftmost hamburger that opens a portaled drawer, so the per-book tabs (and global nav) are always reachable on tablet/phone.

**Architecture:** Add a single in-file `NavDrawer` component to `src/components/top-bar.tsx` (mirrors the existing `HelpMenu`: local open state, portal-to-body, outside-click + Escape, unmounted-when-closed). The two inline `<nav>` strips become `hidden xl:flex`; the hamburger trigger is `xl:hidden`. The drawer renders stage-aware rows that call the exact same `setView` / global handlers the inline buttons do. Desktop (≥1280px) is unchanged.

**Tech Stack:** React 18 + TypeScript, Tailwind v4 (CSS-first `@theme` in `src/styles.css`), Vitest + React Testing Library (unit), Playwright (e2e: `chromium` / `mobile-chrome` / `tablet-chrome`).

**Spec:** `docs/superpowers/specs/2026-06-19-responsive-topbar-nav-design.md` (read it first).

## Global Constraints

- **Branch / workspace:** all work on `feat/frontend-responsive-topbar-nav`, in the isolated worktree `C:/Claude/Projects/_wt-topbar-nav`. The main checkout is shared with a concurrent session — do NOT switch branches there.
- **Scope = nav only.** Do NOT touch Help, Theme, Version, Status, Admin, queue, or avatar. No edits to `theme-toggle.tsx` or any component other than `top-bar.tsx` (+ `icons.tsx` for one new icon, `styles.css` for one keyframe).
- **Breakpoint = `xl` = 1280px** (Tailwind v4 default; no `--breakpoint-*` override exists, so use `xl:` directly).
- **Duplicate-selector safety:** the drawer MUST be unmounted when closed (`{open && createPortal(...)}`). Drawer rows use distinct `data-testid="nav-drawer-link-{id}"`; never reuse the inline buttons' name-only selectors.
- **Touch targets:** every drawer row and the hamburger ≥44px (`min-h-[44px]` / `w-11 h-11`).
- **Active row:** `aria-current="page"`.
- **Conventions (CLAUDE.md):** no hex literals (use the `--ink` etc. tokens via Tailwind classes); icons live in `src/lib/icons.tsx`; portaled overlays go to `document.body`.

---

### Task 1: Hamburger + NavDrawer in `top-bar.tsx` (unit-test driven)

**Files:**
- Modify: `src/lib/icons.tsx` (add `IconMenu`)
- Modify: `src/styles.css` (add `slide-in-left` keyframe + class)
- Modify: `src/components/top-bar.tsx` (add `NavDrawer`; gate inline navs; mount trigger)
- Test: `src/components/top-bar.test.tsx` (new `describe` block)

**Interfaces:**
- Consumes: the existing `TABS` and `GLOBAL_NAV` constants and the `Stage`/`View` types already in `top-bar.tsx`; props already on `TopBar` (`stage`, `view`, `setView`, `onHome`, `onOpenVoices`, `onOpenChangelog`).
- Produces: `NavDrawer` (in-file, not exported). DOM contract relied on by Task 2's e2e: `data-testid="topbar-nav-toggle"` (trigger), `data-testid="topbar-nav-drawer"` (panel), `data-testid="topbar-nav-scrim"` (scrim), `data-testid="nav-drawer-link-{id}"` (rows, where `{id}` ∈ `manuscript|cast|library|generate|listen|log` for a book, `books|voices|changelog` for global).

- [ ] **Step 1: Add the `IconMenu` icon**

In `src/lib/icons.tsx`, add next to `IconCheck`/`IconClose` (near line 22):

```tsx
export const IconMenu = (p: IconProps) => Svg(<path d="M4 6h16M4 12h16M4 18h16" />, p);
```

- [ ] **Step 2: Add the `slide-in-left` animation**

In `src/styles.css`, after the `@keyframes slide-in-right { … }` block (ends ~line 691) add:

```css
@keyframes slide-in-left {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(0);
  }
}
```

Then after the `.slide-in-right { … }` rule (~line 733) add:

```css
.slide-in-left {
  animation: slide-in-left 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}
```

- [ ] **Step 3: Write the failing unit tests**

Append this `describe` block to `src/components/top-bar.test.tsx`. Line 13 imports `{ render, screen, fireEvent }` from `@testing-library/react` — add **only** `within` to it (do NOT add `vi`; it is already imported from `vitest` on line 12). `TABS` is internal, so the tests reference testids, not the constant:

```tsx
describe('TopBar — responsive nav drawer (<xl hamburger)', () => {
  it('renders the hamburger trigger on a book stage and on global stages', () => {
    const { unmount } = renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    const toggle = screen.getByTestId('topbar-nav-toggle');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.className).toMatch(/xl:hidden/);
    unmount();
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    expect(screen.getByTestId('topbar-nav-toggle')).toBeInTheDocument();
  });

  it('does NOT render the hamburger on a stage with no nav (e.g. upload)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'upload', view: null })} />);
    expect(screen.queryByTestId('topbar-nav-toggle')).not.toBeInTheDocument();
  });

  it('keeps the drawer unmounted until the trigger is clicked (duplicate-selector safety)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });

  it('opens the drawer with the six per-book tabs when a book is open, active one marked', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const drawer = screen.getByTestId('topbar-nav-drawer');
    const d = within(drawer);
    expect(d.getByTestId('nav-drawer-link-manuscript')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-cast')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-library')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-generate')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-listen')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-log')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-cast')).toHaveAttribute('aria-current', 'page');
    expect(d.getByTestId('nav-drawer-link-manuscript')).not.toHaveAttribute('aria-current');
  });

  it('opens the drawer with the global nav on a global stage', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const d = within(screen.getByTestId('topbar-nav-drawer'));
    expect(d.getByTestId('nav-drawer-link-books')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-voices')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-changelog')).toBeInTheDocument();
  });

  it('every drawer row meets the 44px touch target', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'listen' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const rows = within(screen.getByTestId('topbar-nav-drawer')).getAllByRole('menuitem');
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.className).toMatch(/min-h-\[44px\]/);
  });

  it('clicking a per-book row calls setView and closes (unmounts) the drawer', () => {
    const setView = vi.fn();
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'listen', setView })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-cast'));
    expect(setView).toHaveBeenCalledWith('cast');
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });

  it('clicking the global Books / Voices / Change log rows calls the right handlers', () => {
    const onHome = vi.fn();
    const onOpenVoices = vi.fn();
    const onOpenChangelog = vi.fn();
    renderWithStore(
      <TopBar {...makeProps({ stage: 'books', onHome, onOpenVoices, onOpenChangelog })} />,
    );
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-changelog'));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-voices'));
    expect(onOpenVoices).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-books'));
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the drawer; outside-click (scrim) closes it too', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    expect(screen.getByTestId('topbar-nav-drawer')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
    /* Escape returns focus to the trigger (spec — HelpMenu parity). */
    expect(screen.getByTestId('topbar-nav-toggle')).toHaveFocus();
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('topbar-nav-scrim'));
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });

  it('the inline desktop nav strip is gated behind hidden xl:flex', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    const inlineNav = screen.getByRole('button', { name: 'Manuscript' }).closest('nav')!;
    expect(inlineNav.className).toMatch(/hidden/);
    expect(inlineNav.className).toMatch(/xl:flex/);
  });
});
```

- [ ] **Step 4: Run the new tests — verify they FAIL**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npx vitest run src/components/top-bar.test.tsx -t "responsive nav drawer"`
Expected: FAIL — `getByTestId('topbar-nav-toggle')` not found (the trigger doesn't exist yet).

- [ ] **Step 5: Implement — add the `NavDrawer` component**

In `src/components/top-bar.tsx`, update the icon import on line 3 to add `IconMenu` and `IconCheck`:

```tsx
import { IconArrowLeft, IconSpinner, IconClock, IconWarning, IconMenu, IconCheck, CastwaveMark } from '../lib/icons';
```

Then add this component just above `function HelpMenu(` (~line 371):

```tsx
/* <xl responsive nav. Below 1280px the inline tab/global strips are hidden
   (hidden xl:flex) and this hamburger opens a portaled left drawer with the
   SAME destinations. Mirrors HelpMenu: local open state, portal-to-body,
   outside-click + Escape, and — crucially — unmounted when closed so jsdom
   never sees the drawer rows alongside the inline strip (no duplicate
   selectors). Renders nothing on stages with no nav. */
function NavDrawer({
  stage,
  view,
  setView,
  onHome,
  onOpenVoices,
  onOpenChangelog,
}: {
  stage: Stage['kind'];
  view: View | null;
  setView: (v: View) => void;
  onHome: () => void;
  onOpenVoices: () => void;
  onOpenChangelog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const showGlobalNav = stage === 'books' || stage === 'voices' || stage === 'changelog';
  const hasNav = stage === 'ready' || showGlobalNav;

  /* Focus the first row when the drawer opens (HelpMenu parity). */
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  /* Outside-click + Escape dismissal. Escape returns focus to the trigger;
     outside-click intentionally does not (HelpMenu parity). */
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!hasNav) return null;

  const rows: Array<{ id: string; label: string; active: boolean; run: () => void }> =
    stage === 'ready'
      ? TABS.map((t) => ({
          id: t.id,
          label: t.label,
          active: view === t.id,
          run: () => setView(t.id),
        }))
      : GLOBAL_NAV.map((t) => ({
          id: t.id,
          label: t.label,
          active: stage === t.id,
          run: () => {
            if (t.id === 'books') onHome();
            else if (t.id === 'voices') onOpenVoices();
            else onOpenChangelog();
          },
        }));

  const select = (run: () => void) => {
    run();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open navigation menu"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="topbar-nav-toggle"
        onClick={() => setOpen((s) => !s)}
        className="xl:hidden shrink-0 inline-flex items-center justify-center w-11 h-11 min-h-[44px] min-w-[44px] rounded-full text-ink/70 hover:bg-ink/10 transition-colors"
      >
        <IconMenu className="w-5 h-5" />
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              data-testid="topbar-nav-scrim"
              onClick={() => setOpen(false)}
              className="xl:hidden fixed inset-x-0 top-16 bottom-0 bg-ink/30 z-40 fade-in"
            />
            <div
              ref={panelRef}
              data-testid="topbar-nav-drawer"
              role="menu"
              aria-label="Navigation"
              className="xl:hidden fixed top-16 bottom-0 left-0 w-[min(80vw,320px)] bg-canvas shadow-drawer z-50 overflow-y-auto scrollbar-thin slide-in-left p-2"
            >
              {rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  data-testid={`nav-drawer-link-${r.id}`}
                  aria-current={r.active ? 'page' : undefined}
                  onClick={() => select(r.run)}
                  className={`w-full min-h-[44px] flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-left transition-colors ${
                    r.active ? 'bg-ink/6 text-ink' : 'text-ink/70 hover:bg-ink/5'
                  }`}
                >
                  <span>{r.label}</span>
                  {r.active && <IconCheck className="w-4 h-4 shrink-0" />}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
```

- [ ] **Step 6: Implement — gate the inline strips and mount the trigger**

In `TopBar`'s JSX (`src/components/top-bar.tsx`): mount `NavDrawer` as the FIRST child inside the header's flex container, immediately before the logo `<button onClick={onHome}` (~line 272):

```tsx
        <NavDrawer
          stage={stage}
          view={view}
          setView={setView}
          onHome={onHome}
          onOpenVoices={onOpenVoices}
          onOpenChangelog={onOpenChangelog}
        />
        <button
          onClick={onHome}
          aria-label="Castwright — home"
```

Then gate BOTH inline `<nav>`s by prepending `hidden xl:flex` and removing the now-redundant leading `flex` (lines ~294 and ~307). Change each occurrence of:

```tsx
            <nav className="flex items-center gap-1 bg-ink/4 rounded-full p-1 shrink-0">
```

to:

```tsx
            <nav className="hidden xl:flex items-center gap-1 bg-ink/4 rounded-full p-1 shrink-0">
```

(There are exactly two — the `stage === 'ready'` TABS nav and the `showGlobalNav` GLOBAL_NAV nav.)

- [ ] **Step 7: Run the new tests — verify they PASS**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npx vitest run src/components/top-bar.test.tsx -t "responsive nav drawer"`
Expected: PASS (all 10).

- [ ] **Step 8: Run the WHOLE top-bar + layout suites — verify no regression**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npx vitest run src/components/top-bar.test.tsx src/components/layout.test.tsx`
Expected: PASS — in particular the existing "hides the global nav when a book is open" (one `Log`, no `Change log`) and "renders the Change log button" stay green (drawer is unmounted, so no duplicate matches).

- [ ] **Step 9: Commit**

```bash
cd C:/Claude/Projects/_wt-topbar-nav
git add src/lib/icons.tsx src/styles.css src/components/top-bar.tsx src/components/top-bar.test.tsx
git commit -m "feat(frontend): collapse top-bar nav into a hamburger drawer below xl"
```

---

### Task 2: E2E — hamburger reachability at tablet + phone

**Files:**
- Create: `e2e/responsive/topbar-nav.spec.ts`

**Interfaces:**
- Consumes: the `data-testid`s from Task 1 (`topbar-nav-toggle`, `nav-drawer-link-cast`); the stable mock book `sb` (Solway Bay) and `waitForListenViewReady` from `e2e/helpers` (both already used by `e2e/responsive/visual.spec.ts`).
- Produces: nothing downstream.

- [ ] **Step 1: Write the spec**

Create `e2e/responsive/topbar-nav.spec.ts`:

```ts
/* Plan 2026-06-19 — responsive top-bar nav. With a book open, the inline tab
 * strip is hidden below xl (1280); the hamburger drawer must be the path to
 * Cast/Manuscript/etc. Runs under all three projects (responsive/* glob):
 * skip the collapsed assertions on desktop chromium (1280, inline strip), and
 * skip the inline assertion on mobile/tablet. */
import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from '../helpers';

test.describe('top-bar nav — responsive collapse', () => {
  test('below xl: inline tabs are hidden and the hamburger drawer reaches Cast', async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 1280, 'desktop shows the inline strip; covered by the >=xl test');

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page);

    // The inline tab exists in the DOM but is display:none below xl.
    await expect(page.getByRole('button', { name: 'Cast', exact: true })).toBeHidden();
    // The hamburger IS the affordance.
    const toggle = page.getByTestId('topbar-nav-toggle');
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(page.getByTestId('topbar-nav-drawer')).toBeVisible();
    await page.getByTestId('nav-drawer-link-cast').click();

    await expect(page).toHaveURL(/books\/sb\/cast/);
    await expect(page.getByTestId('topbar-nav-drawer')).toHaveCount(0);
  });

  test('at/above xl: the inline strip shows and there is no hamburger', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width < 1280, 'mobile/tablet collapses; covered by the <xl test');

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page);

    await expect(page.getByRole('button', { name: 'Cast', exact: true })).toBeVisible();
    // The hamburger is in the DOM but display:none at xl — assert hidden, not absent.
    await expect(page.getByTestId('topbar-nav-toggle')).toBeHidden();
  });
});
```

- [ ] **Step 2: Run under tablet + mobile — verify PASS**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npx playwright test --project=tablet-chrome --project=mobile-chrome e2e/responsive/topbar-nav.spec.ts`
Expected: PASS (the `>=xl` test is skipped on both; the `<xl` test passes on both). If chromium isn't installed: `npx playwright install chromium` first.

- [ ] **Step 3: Run under desktop chromium — verify PASS**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npx playwright test --project=chromium e2e/responsive/topbar-nav.spec.ts`
Expected: PASS (the `<xl` test is skipped; the `>=xl` test confirms the inline strip + no hamburger at 1280).

- [ ] **Step 4: Commit**

```bash
cd C:/Claude/Projects/_wt-topbar-nav
git add e2e/responsive/topbar-nav.spec.ts
git commit -m "test(e2e): hamburger nav reachability at tablet/phone, inline at desktop"
```

---

### Task 3: Re-bless the tablet + mobile visual baselines

The top bar appears in the `ready` / `listen` / `generate` baselines. At 834 (tablet) and 412 (mobile) the bar changes (strip → hamburger), so those committed PNGs drift. chromium (1280) is unaffected (inline strip still shows). These projects run in the opt-in `test:e2e:mobile` and the release gate, not pre-push — but they MUST be re-blessed in this PR or the release fails.

**Files:**
- Modify (regenerate): `e2e/win32/responsive/visual.spec.ts/tablet-chrome/*.png`, `e2e/win32/responsive/visual.spec.ts/mobile-chrome/*.png`

- [ ] **Step 1: Confirm the chromium baselines do NOT drift (the "desktop unchanged" verification)**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npx playwright test --project=chromium --workers=1 e2e/responsive/visual.spec.ts`
Expected: PASS with no diffs. If any top-bar baseline drifts here, STOP — the `xl` boundary assumption is wrong (1280 fell below `xl`); investigate before re-blessing anything.

- [ ] **Step 2: Re-bless tablet + mobile baselines**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npx playwright test --project=tablet-chrome --project=mobile-chrome --update-snapshots e2e/responsive/visual.spec.ts`
Expected: snapshots rewritten; command exits 0.

- [ ] **Step 3: Eyeball the regenerated PNGs**

Open 2–3 of the changed files (e.g. `e2e/win32/responsive/visual.spec.ts/tablet-chrome/ready-light.png`) and confirm the top bar now shows the hamburger (no starved tab strip) and nothing else regressed. `git status` should list only `tablet-chrome/` + `mobile-chrome/` PNGs as modified — NOT `chromium/`.

- [ ] **Step 4: Commit**

```bash
cd C:/Claude/Projects/_wt-topbar-nav
git add e2e/win32/responsive/visual.spec.ts/tablet-chrome e2e/win32/responsive/visual.spec.ts/mobile-chrome
git commit -m "test(e2e): re-bless tablet/mobile visual baselines for hamburger nav"
```

> **Linux baselines:** CI/release run on Ubuntu and use `e2e/linux/...` baselines. After this PR merges (or before, if the release is imminent), regenerate them via the `.github/workflows/regen-visual-baselines.yml` workflow (Actions → Run workflow on this branch). Note this in the PR description so it isn't forgotten.

---

### Task 4: Docs — protocol amendment + ship bookkeeping

**Files:**
- Modify: `CLAUDE.md` (Mobile testing protocol table)
- Modify: `docs/superpowers/specs/2026-06-19-responsive-topbar-nav-design.md` (status on ship)

- [ ] **Step 1: Amend the mobile-protocol table**

In `CLAUDE.md`, in the "Mobile testing protocol (plan 81)" section, add a line under the viewport table noting the deviation:

```markdown
> **Top-bar nav exception (2026-06-19):** the top-bar navigation collapses into a
> hamburger drawer below `xl` (1280px), so a 1024–1279px desktop window shows the
> hamburger rather than the inline strip. The rest of the bar follows the generic
> `lg:`=desktop rule above. See `docs/superpowers/specs/2026-06-19-responsive-topbar-nav-design.md`.
```

- [ ] **Step 2: Commit**

```bash
cd C:/Claude/Projects/_wt-topbar-nav
git add CLAUDE.md
git commit -m "docs: note the <xl top-bar nav collapse in the mobile protocol"
```

- [ ] **Step 3: Full local verify**

Run: `cd C:/Claude/Projects/_wt-topbar-nav && npm run verify`
Expected: green. (If the worktree lacks `node_modules`, create a junction to the main checkout's first: `cmd //c mklink /J node_modules C:\Claude\Projects\Audiobook-Generator\node_modules` — or `npm ci`. The pre-push battery runs `test:e2e:visual` = chromium-only, which Task 3 Step 1 already confirmed green.)

- [ ] **Step 4: (On ship, after PR approval) flip the spec status + open the PR**

- Set the spec frontmatter `**Status:**` to `stable` and fill a short Ship notes line (date + merge SHA) once merged.
- Open the PR from `feat/frontend-responsive-topbar-nav` with a `## Summary` + `## Test plan`, link the spec, and (if the user has filed a `bug` issue for this) add `Closes #NN`. Note the Linux-baseline regen reminder from Task 3 in the PR body.

---

## Notes for the implementer

- **Do not** run `git switch`/`git checkout <branch>` in the shared main checkout (`C:/Claude/Projects/Audiobook-Generator`) — a concurrent session is using it. Work only in the worktree.
- The `bg-canvas` / `bg-ink/30` / `shadow-drawer` / `scrollbar-thin` classes are existing tokens (ProfileDrawer uses the same). `bg-canvas` keeps the drawer readable in dark mode (do not use `bg-white`).
- If `npx vitest`/`npx playwright` aren't resolvable in the worktree, it's missing `node_modules` — see Task 4 Step 3.
