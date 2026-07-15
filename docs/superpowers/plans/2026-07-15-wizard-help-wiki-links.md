# First-run wizard help & resources + per-step wiki deep-links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the first-run setup wizard a persistent "Need help?" footer (5 outbound links) on every step, plus a contextual "Learn more" wiki deep-link per step — closing fe-52 (#1615) and fe-53 (#1616) in one PR.

**Architecture:** Extend the existing `src/lib/wiki-links.ts` constants module (support links + a `StepId`-keyed page map), lift the wizard's `StepId`/`STEPS` into a shared `steps.ts` to avoid a lib→component import cycle, extract a generic `<ExternalLink>` primitive that both wiki links and GitHub-support links share, add a `<HelpResources>` footer mounted once in the wizard shell, and render the contextual link centrally in `GuidedWizard`. No new wiki pages — every target already exists and is live.

**Tech Stack:** Vite + React 18 + TypeScript, Vitest + React Testing Library (colocated `*.test.tsx`), Playwright (chromium, mock mode), Tailwind (design-token classes).

## Global Constraints

- **Branch:** `feat/frontend-fe-52-53-wizard-help-links` (already cut, in an isolated worktree). PR body must contain `Closes #1615` and `Closes #1616`.
- **External links:** every outbound `<a>` uses `target="_blank" rel="noopener noreferrer"`.
- **Wiki links are page-level only** — never append `#anchor` fragments.
- **URLs live only in `src/lib/wiki-links.ts`**, each block commented as externally-owned.
- **Touch targets ≥44px** on touch devices: use `min-h-[44px] fine-pointer:min-h-0` (already baked into the link primitive). No `sm:`-gated targets.
- **No hex literals in component code** — use token classes (`text-magenta`, `text-ink/60`, `border-ink/10`, …).
- **TDD + frequent commits:** each task writes its failing test first, then the minimal implementation, then commits. Commit subjects follow `<type>(<scope>): <subject>` (scope `frontend` for code, `docs` for docs-only).
- **Repo owner is hardcoded** in `WIKI_BASE`/`REPO_BASE` (`dudarenok-maker/Castwright`) — matches existing convention.
- **The 8 referenced wiki pages are all live (HTTP 200, checked 2026-07-15):** `Getting-Started`, `Installing-Castwright`, `Troubleshooting`, `Analysis-and-the-Analyzer`, `Voice-Engines`, `Account-and-Settings`, `Mobile-Tablet-and-Companion-App`, `Generating-Audio`.

## File Structure

- **Create** `src/components/setup/steps.ts` — `StepId` type + `STEPS` array, lifted from `setup-wizard.tsx`.
- **Modify** `src/components/setup/setup-wizard.tsx` — import `StepId`/`STEPS` from `steps.ts`; mount `<HelpResources>`; render contextual `<WikiLink>` in `GuidedWizard`.
- **Modify** `src/lib/wiki-links.ts` — add `Installing-Castwright` to `WikiPage`, `REPO_BASE`, `SUPPORT_LINKS`, `WIZARD_STEP_WIKI`.
- **Modify** `src/lib/wiki-links.test.ts` — extend guard to `WIZARD_STEP_WIKI`; assert step-map exhaustiveness.
- **Create** `src/components/external-link.tsx` — generic external link primitive.
- **Modify** `src/components/wiki-link.tsx` — become a thin wrapper over `<ExternalLink>`.
- **Create** `src/components/external-link.test.tsx`.
- **Create** `src/components/setup/help-resources.tsx` — the 5-link "Need help?" footer.
- **Create** `src/components/setup/help-resources.test.tsx`.
- **Modify** `src/components/setup/setup-wizard.test.tsx` — footer + contextual-link assertions.
- **Create** `e2e/setup-help-links.spec.ts` — one Playwright spec.
- **Edit (docs)** the 8 target pages under `docs/wiki/` — light arrival-lead pass.
- **Create (docs)** `docs/features/fe-52-53-wizard-help-links.md` + `docs/features/INDEX.md` entry.
- **Edit (docs)** `docs/release-notes-next.md` + `RELEASE_NOTES.md`.

---

### Task 1: Lift `StepId`/`STEPS` into a shared module

Pure refactor — no behavior change. Unblocks Task 2 (so `wiki-links.ts` can type-only import `StepId`). Verified by the existing `setup-wizard.test.tsx` staying green.

**Files:**
- Create: `src/components/setup/steps.ts`
- Modify: `src/components/setup/setup-wizard.tsx:22-43` (imports + local `StepId`/`STEPS`)
- Test: `src/components/setup/setup-wizard.test.tsx` (existing — must stay green)

**Interfaces:**
- Produces: `export type StepId = 'environment' | 'ffmpeg' | 'analysis' | 'voice' | 'defaults' | 'lanCert' | 'finish'` and `export const STEPS: { id: StepId; title: string }[]` from `src/components/setup/steps.ts`.

- [ ] **Step 1: Create the shared module**

Create `src/components/setup/steps.ts`:

```ts
/* Wizard step identity — the ordered first-run setup steps and their ids.
   Lifted out of setup-wizard.tsx (fe-52/fe-53) so src/lib/wiki-links.ts can
   type-only import StepId for its WIZARD_STEP_WIKI map without a lib->component
   runtime cycle. */
export type StepId =
  | 'environment'
  | 'ffmpeg'
  | 'analysis'
  | 'voice'
  | 'defaults'
  | 'lanCert'
  | 'finish';

export const STEPS: { id: StepId; title: string }[] = [
  { id: 'environment', title: 'Environment' },
  { id: 'ffmpeg', title: 'ffmpeg' },
  { id: 'analysis', title: 'Analysis' },
  { id: 'voice', title: 'Voice' },
  { id: 'defaults', title: 'Defaults' },
  { id: 'lanCert', title: 'LAN access' },
  { id: 'finish', title: 'Finish' },
];
```

- [ ] **Step 2: Rewire `setup-wizard.tsx` to import from it**

In `src/components/setup/setup-wizard.tsx`, add to the import block (after the `StepFinish` import, around line 30):

```ts
import { STEPS, type StepId } from './steps';
```

Then **delete** the now-duplicate local declarations (lines 32-43):

```ts
type StepId = 'environment' | 'ffmpeg' | 'analysis' | 'voice' | 'defaults' | 'lanCert' | 'finish';

const STEPS: { id: StepId; title: string }[] = [
  { id: 'environment', title: 'Environment' },
  { id: 'ffmpeg', title: 'ffmpeg' },
  { id: 'analysis', title: 'Analysis' },
  { id: 'voice', title: 'Voice' },
  { id: 'defaults', title: 'Defaults' },
  { id: 'lanCert', title: 'LAN access' },
  { id: 'finish', title: 'Finish' },
];
```

- [ ] **Step 3: Run the existing wizard suite — must stay green**

Run: `npm run test -- src/components/setup/setup-wizard.test.tsx`
Expected: PASS (all existing orchestration tests, unchanged behavior).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the `StepId`/`STEPS` import resolves; no other file referenced the removed locals).

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/steps.ts src/components/setup/setup-wizard.tsx
git commit -m "refactor(frontend): lift wizard StepId/STEPS into shared steps.ts"
```

---

### Task 2: Extend `wiki-links.ts` — support links + per-step map + guard

**Files:**
- Modify: `src/lib/wiki-links.ts`
- Test: `src/lib/wiki-links.test.ts`

**Interfaces:**
- Consumes: `StepId` from `src/components/setup/steps.ts` (Task 1, type-only).
- Produces: `export const REPO_BASE: string`; `export const SUPPORT_LINKS: { issues: string; discussions: string }`; `export const WIZARD_STEP_WIKI: Record<StepId, WikiPage>`; `'Installing-Castwright'` added to the `WikiPage` union.

- [ ] **Step 1: Write the failing guard/exhaustiveness test**

In `src/lib/wiki-links.test.ts`, add these imports to the existing top-of-file import list (extend the destructured `from './wiki-links'` import and add the `STEPS` import):

```ts
import { STEPS } from '../components/setup/steps';
```

Add `WIZARD_STEP_WIKI`, `SUPPORT_LINKS`, and `REPO_BASE` to the existing `} from './wiki-links';` destructure.

Then extend the existing `'every referenced WikiPage exists…'` test's `pages` Set to include the new map, and add a new test — append inside the `describe('wiki-links', …)` block:

```ts
  it('WIZARD_STEP_WIKI maps every wizard step to an existing wiki page', () => {
    for (const step of STEPS) {
      const page = WIZARD_STEP_WIKI[step.id];
      expect(page, `step ${step.id} has no wiki mapping`).toBeTruthy();
      const path = resolve(wikiDir, `${page}.md`);
      expect(existsSync(path), `missing wiki page: ${page}.md`).toBe(true);
    }
  });

  it('SUPPORT_LINKS point at the repo issues + discussions', () => {
    expect(SUPPORT_LINKS.issues).toBe(`${REPO_BASE}/issues`);
    expect(SUPPORT_LINKS.discussions).toBe(`${REPO_BASE}/discussions`);
  });
```

And update the existing page-existence test's Set literal to also spread the new map:

```ts
    const pages = new Set<string>([
      ...Object.values(CATEGORY_WIKI),
      ...Object.values(ADMIN_WIKI),
      ...Object.values(HELP_SECTION_WIKI),
      ...Object.values(WIZARD_STEP_WIKI),
      GEMINI_KEY_WIKI,
    ]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/lib/wiki-links.test.ts`
Expected: FAIL — `WIZARD_STEP_WIKI`, `SUPPORT_LINKS`, `REPO_BASE` are not exported yet (import/undefined errors).

- [ ] **Step 3: Implement the constants**

In `src/lib/wiki-links.ts`:

(a) Add the type-only import directly under the existing `import type { CategoryId }` line (line 6):

```ts
import type { StepId } from '../components/setup/steps';
```

(b) Add `'Installing-Castwright'` to the `WikiPage` union — insert after the `'Getting-Started'` line:

```ts
  | 'Getting-Started'
  | 'Installing-Castwright'
```

(c) Append at the end of the file:

```ts
/* GitHub support surfaces (fe-52). Repo owner hardcoded like WIKI_BASE — update
   on transfer. Issues + Discussions are both enabled on the repo. */
export const REPO_BASE = 'https://github.com/dudarenok-maker/Castwright';
export const SUPPORT_LINKS = {
  issues: `${REPO_BASE}/issues`, // "Report a problem"
  discussions: `${REPO_BASE}/discussions`, // "Ask a question"
} as const;

/* Per-step contextual "Learn more" deep-link for the first-run setup wizard
   (fe-53). Keyed by StepId so it stays exhaustive at compile time. Page-level;
   two install-flavoured steps share Installing-Castwright by design (its
   Prerequisites section leads with OS/GPU/accelerator + ffmpeg). */
export const WIZARD_STEP_WIKI = {
  environment: 'Installing-Castwright',
  ffmpeg: 'Installing-Castwright',
  analysis: 'Analysis-and-the-Analyzer',
  voice: 'Voice-Engines',
  defaults: 'Account-and-Settings',
  lanCert: 'Mobile-Tablet-and-Companion-App',
  finish: 'Generating-Audio',
} satisfies Record<StepId, WikiPage>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/lib/wiki-links.test.ts`
Expected: PASS (all guard + new tests).

- [ ] **Step 5: Typecheck (confirms the `satisfies Record<StepId, …>` exhaustiveness + no import cycle)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/wiki-links.ts src/lib/wiki-links.test.ts
git commit -m "feat(frontend): add wizard support links + per-step wiki map to wiki-links"
```

---

### Task 3: Extract `<ExternalLink>`, refactor `<WikiLink>` to wrap it

**Files:**
- Create: `src/components/external-link.tsx`
- Modify: `src/components/wiki-link.tsx`
- Test: `src/components/external-link.test.tsx` (new); `src/components/wiki-link.test.tsx` (existing — must stay green)

**Interfaces:**
- Produces: `export function ExternalLink({ href, label, className }: { href: string; label: string; className?: string }): JSX.Element`.
- `<WikiLink>` keeps its exact public API (`page`, optional `label` defaulting to `'Read more on the wiki'`, `className`) and renders identically.

- [ ] **Step 1: Write the failing `ExternalLink` test**

Create `src/components/external-link.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExternalLink } from './external-link';

describe('ExternalLink', () => {
  it('renders a new-tab link with safe rel, the given href and label', () => {
    render(<ExternalLink href="https://example.com/docs" label="Open docs" />);
    const a = screen.getByRole('link', { name: /open docs/i });
    expect(a).toHaveAttribute('href', 'https://example.com/docs');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- src/components/external-link.test.tsx`
Expected: FAIL — `external-link.tsx` does not exist.

- [ ] **Step 3: Create `ExternalLink`**

Create `src/components/external-link.tsx`:

```tsx
/* Curated outbound external link — new tab, safe rel, 44px touch target,
   external-link icon. Shared primitive behind WikiLink and the setup wizard's
   Help & resources footer. */
import { IconExternal } from '../lib/icons';

export function ExternalLink({
  href,
  label,
  className = '',
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 min-h-[44px] fine-pointer:min-h-0 text-sm font-medium text-magenta hover:underline ${className}`}
    >
      {label}
      <IconExternal className="w-3.5 h-3.5" aria-hidden="true" />
    </a>
  );
}
```

- [ ] **Step 4: Refactor `WikiLink` to wrap it**

Replace the entire body of `src/components/wiki-link.tsx` with:

```tsx
/* Curated outbound link to the published GitHub wiki. External, page-level.
   Thin wrapper over ExternalLink. Used across the Help and Admin views
   (see src/lib/wiki-links.ts). */
import { ExternalLink } from './external-link';
import { wikiUrl, type WikiPage } from '../lib/wiki-links';

export function WikiLink({
  page,
  label = 'Read more on the wiki',
  className = '',
}: {
  page: WikiPage;
  label?: string;
  className?: string;
}) {
  return <ExternalLink href={wikiUrl(page)} label={label} className={className} />;
}
```

- [ ] **Step 5: Run both link suites — both must pass**

Run: `npm run test -- src/components/external-link.test.tsx src/components/wiki-link.test.tsx`
Expected: PASS. `wiki-link.test.tsx` is unchanged and still green (identical rendered output: default label `'Read more on the wiki'`, `wikiUrl` href, `target`/`rel`).

- [ ] **Step 6: Commit**

```bash
git add src/components/external-link.tsx src/components/external-link.test.tsx src/components/wiki-link.tsx
git commit -m "refactor(frontend): extract ExternalLink primitive, WikiLink wraps it"
```

---

### Task 4: `<HelpResources>` footer component

**Files:**
- Create: `src/components/setup/help-resources.tsx`
- Test: `src/components/setup/help-resources.test.tsx`

**Interfaces:**
- Consumes: `ExternalLink` (Task 3); `wikiUrl`, `SUPPORT_LINKS` (Task 2).
- Produces: `export function HelpResources(): JSX.Element` — a bordered "Need help?" row of exactly 5 external links.

- [ ] **Step 1: Write the failing test**

Create `src/components/setup/help-resources.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelpResources } from './help-resources';

const BASE = 'https://github.com/dudarenok-maker/Castwright';

describe('HelpResources', () => {
  it('renders exactly 5 help links, each opening safely in a new tab', () => {
    render(<HelpResources />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('links to getting-started, install guide, troubleshooting, issues, discussions', () => {
    render(<HelpResources />);
    expect(screen.getByRole('link', { name: /getting started/i })).toHaveAttribute(
      'href', `${BASE}/wiki/Getting-Started`,
    );
    expect(screen.getByRole('link', { name: /install & setup/i })).toHaveAttribute(
      'href', `${BASE}/wiki/Installing-Castwright`,
    );
    expect(screen.getByRole('link', { name: /troubleshooting/i })).toHaveAttribute(
      'href', `${BASE}/wiki/Troubleshooting`,
    );
    expect(screen.getByRole('link', { name: /report a problem/i })).toHaveAttribute(
      'href', `${BASE}/issues`,
    );
    expect(screen.getByRole('link', { name: /ask a question/i })).toHaveAttribute(
      'href', `${BASE}/discussions`,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- src/components/setup/help-resources.test.tsx`
Expected: FAIL — `help-resources.tsx` does not exist.

- [ ] **Step 3: Implement `HelpResources`**

Create `src/components/setup/help-resources.tsx`:

```tsx
/* fe-52 — persistent "Need help?" footer for the first-run setup wizard.
   Five outbound links (new tab, safe rel), visible on every wizard surface.
   All URLs come from the shared src/lib/wiki-links.ts module. */
import { ExternalLink } from '../external-link';
import { wikiUrl, SUPPORT_LINKS } from '../../lib/wiki-links';

export function HelpResources() {
  return (
    <div className="mt-8 pt-5 border-t border-ink/10 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="text-sm font-medium text-ink/60">Need help?</span>
      <ExternalLink href={wikiUrl('Getting-Started')} label="Getting started" />
      <ExternalLink href={wikiUrl('Installing-Castwright')} label="Install &amp; setup" />
      <ExternalLink href={wikiUrl('Troubleshooting')} label="Troubleshooting" />
      <ExternalLink href={SUPPORT_LINKS.issues} label="Report a problem" />
      <ExternalLink href={SUPPORT_LINKS.discussions} label="Ask a question" />
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test -- src/components/setup/help-resources.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/help-resources.tsx src/components/setup/help-resources.test.tsx
git commit -m "feat(frontend): add Help & resources footer for the setup wizard"
```

---

### Task 5: Mount the footer + render the contextual "Learn more" link

**Files:**
- Modify: `src/components/setup/setup-wizard.tsx` (SetupWizard outer return `78-107`; GuidedWizard card block `165-167`; imports)
- Test: `src/components/setup/setup-wizard.test.tsx`

**Interfaces:**
- Consumes: `HelpResources` (Task 4); `WikiLink` (Task 3); `WIZARD_STEP_WIKI` (Task 2); `STEPS`/`StepId` (Task 1).
- Produces: no new exports — wires existing pieces into the wizard shell.

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `src/components/setup/setup-wizard.test.tsx` (after the closing of the existing `describe('SetupWizard', …)` block — reuses the file's `READINESS` fixture and the stubbed steps):

```tsx
const WIKI = 'https://github.com/dudarenok-maker/Castwright/wiki';

describe('SetupWizard — help & wiki links (fe-52/fe-53)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the persistent "Need help?" footer in guided mode', () => {
    render(
      <SetupWizard readiness={READINESS} mode="guided" onRefetch={() => {}} onFinish={() => {}} />,
    );
    expect(screen.getByText(/need help\?/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /report a problem/i })).toHaveAttribute(
      'href', 'https://github.com/dudarenok-maker/Castwright/issues',
    );
  });

  it('renders the "Need help?" footer on the re-entry summary board too', () => {
    render(
      <SetupWizard readiness={READINESS} mode="checklist" onRefetch={() => {}} onFinish={() => {}} />,
    );
    expect(screen.getByTestId('setup-summary-board')).toBeInTheDocument();
    expect(screen.getByText(/need help\?/i)).toBeInTheDocument();
  });

  it('shows a contextual "Learn more" link that retargets per step', () => {
    render(
      <SetupWizard readiness={READINESS} mode="guided" onRefetch={() => {}} onFinish={() => {}} />,
    );
    // Step 1 = Environment → Installing-Castwright
    expect(screen.getByRole('link', { name: /learn more/i })).toHaveAttribute(
      'href', `${WIKI}/Installing-Castwright`,
    );
    // advance to step 3 = Analysis → Analysis-and-the-Analyzer
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('step-analysis-stub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /learn more/i })).toHaveAttribute(
      'href', `${WIKI}/Analysis-and-the-Analyzer`,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- src/components/setup/setup-wizard.test.tsx`
Expected: FAIL — no "Need help?" text and no "Learn more" link yet.

- [ ] **Step 3: Add imports to `setup-wizard.tsx`**

After the `import { STEPS, type StepId } from './steps';` line (added in Task 1), add:

```ts
import { WikiLink } from '../wiki-link';
import { WIZARD_STEP_WIKI } from '../../lib/wiki-links';
import { HelpResources } from './help-resources';
```

- [ ] **Step 4: Mount `<HelpResources>` in the shell**

In the `SetupWizard` outer return, add `<HelpResources />` after the `{mode === 'guided' ? … : …}` ternary, still inside the wrapping `<div>`. The block becomes:

```tsx
      {mode === 'guided' ? (
        <GuidedWizard
          readiness={readiness}
          stepIndex={stepIndex}
          onStepChange={setStepIndex}
          onRefetch={onRefetch}
          onFinish={onFinish}
          onTryDemoBook={onTryDemoBook}
        />
      ) : (
        <ReEntryFlow
          readiness={readiness}
          onRefetch={onRefetch}
          onFinish={onFinish}
          onTryDemoBook={onTryDemoBook}
        />
      )}

      <HelpResources />
    </div>
  );
}
```

- [ ] **Step 5: Render the contextual link in `GuidedWizard`**

Replace the step-card block (currently lines 165-167):

```tsx
      <div className="rounded-2xl border border-ink/10 bg-white p-5 sm:p-6 shadow-card">
        {renderStep(step.id, readiness, onRefetch, onFinish, onTryDemoBook)}
      </div>
```

with an in-flow flex header row holding the right-aligned contextual link above the step body:

```tsx
      <div className="rounded-2xl border border-ink/10 bg-white p-5 sm:p-6 shadow-card">
        <div className="mb-3 flex flex-wrap justify-end">
          <WikiLink page={WIZARD_STEP_WIKI[step.id]} label="Learn more" />
        </div>
        {renderStep(step.id, readiness, onRefetch, onFinish, onTryDemoBook)}
      </div>
```

- [ ] **Step 6: Run the wizard suite — all green**

Run: `npm run test -- src/components/setup/setup-wizard.test.tsx`
Expected: PASS (existing orchestration tests + the 3 new ones).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/setup/setup-wizard.tsx src/components/setup/setup-wizard.test.tsx
git commit -m "feat(frontend): mount help footer + per-step Learn more in setup wizard"
```

---

### Task 6: Playwright e2e — footer + contextual link across viewports

**Files:**
- Create: `e2e/setup-help-links.spec.ts`

**Interfaces:**
- Consumes: the running mock app; the wizard is forced via the `?setup=notready` query (same pattern as `e2e/setup-gate.spec.ts`).

- [ ] **Step 1: Write the spec**

Create `e2e/setup-help-links.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const WIKI = 'https://github.com/dudarenok-maker/Castwright/wiki';

test.describe('first-run wizard — help & wiki links (fe-52/fe-53)', () => {
  test('persistent footer + per-step Learn more', async ({ page }) => {
    await page.goto('/#/?setup=notready');
    await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();

    // fe-52 — Help & resources footer present on the first step
    await expect(page.getByText(/need help\?/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /report a problem/i })).toHaveAttribute(
      'href', 'https://github.com/dudarenok-maker/Castwright/issues',
    );

    // fe-53 — contextual link targets the Environment step's page
    await expect(page.getByRole('link', { name: /learn more/i })).toHaveAttribute(
      'href', `${WIKI}/Installing-Castwright`,
    );

    // advance to the Analysis step (step 3) → contextual link retargets
    await page.getByRole('button', { name: /next/i }).click();
    await page.getByRole('button', { name: /next/i }).click();
    await expect(page.getByRole('link', { name: /learn more/i })).toHaveAttribute(
      'href', `${WIKI}/Analysis-and-the-Analyzer`,
    );
  });

  test('help footer stays visible on a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/#/?setup=notready');
    await expect(page.getByText(/need help\?/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /ask a question/i })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `npm run test:e2e -- setup-help-links`
Expected: PASS (2 tests). If chromium is missing, run `npx playwright install chromium` once first.

- [ ] **Step 3: Commit**

```bash
git add e2e/setup-help-links.spec.ts
git commit -m "test(frontend): e2e for wizard help footer + per-step wiki links"
```

---

### Task 7: Light editorial "arrival" pass on the linked wiki pages

Docs-only. For each page a new link points at, confirm its **opening** orients a first-run user arriving mid-setup; add or tighten a lead sentence only where it doesn't. Do **not** author new pages or restructure — this is a lead-paragraph check.

**Files (docs):**
- Edit as needed: `docs/wiki/Installing-Castwright.md`, `docs/wiki/Analysis-and-the-Analyzer.md`, `docs/wiki/Voice-Engines.md`, `docs/wiki/Account-and-Settings.md`, `docs/wiki/Mobile-Tablet-and-Companion-App.md`, `docs/wiki/Generating-Audio.md`, `docs/wiki/Getting-Started.md`, `docs/wiki/Troubleshooting.md`

- [ ] **Step 1: Read each page's first section**

Run: `for p in Installing-Castwright Analysis-and-the-Analyzer Voice-Engines Account-and-Settings Mobile-Tablet-and-Companion-App Generating-Audio Getting-Started Troubleshooting; do echo "== $p =="; sed -n '1,15p' "docs/wiki/$p.md"; done`

- [ ] **Step 2: For each page whose opening does NOT orient an arriving setup user, add one lead sentence**

Criterion: the first 1-2 lines should tell a reader who landed here from the setup wizard what the page covers and how it maps to the step they were on. Example lead for `Account-and-Settings.md` (only if its current opening dives straight into detail):

```markdown
> Setting up for the first time? This page explains the app-wide defaults the
> setup wizard's **Defaults** step lets you pre-pick — voice engine, models, and
> theme — and where to change them later.
```

Apply the equivalent one-line orienting lead to any other page that needs it. Pages that already open with a clear orienting sentence need no change — note them as verified in the commit body.

- [ ] **Step 3: Commit (only the pages you touched)**

```bash
git add docs/wiki/
git commit -m "docs(docs): orient wiki page leads for first-run wizard arrivals"
```

(If no page needed a change, skip the commit and record "all 8 target pages already orient an arriving user — no edits needed" in the Task 8 regression plan instead.)

---

### Task 8: Regression plan + INDEX + release notes

Docs-only. Records the invariants and the user-facing delta.

**Files (docs):**
- Create: `docs/features/fe-52-53-wizard-help-links.md`
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: Create the regression plan from the template**

Copy `docs/features/TEMPLATE.md` to `docs/features/fe-52-53-wizard-help-links.md` and fill it in. It MUST record these invariants (paired to their automated test):

- The Help & resources footer renders on **every** wizard surface — guided steps, re-entry summary board, re-entry drilled-in step — with exactly 5 links, all `target="_blank" rel="noopener noreferrer"` → `setup-wizard.test.tsx`, `help-resources.test.tsx`, `e2e/setup-help-links.spec.ts`.
- The contextual "Learn more" link targets the current step's mapped page and retargets on step change → `setup-wizard.test.tsx`, e2e.
- Every `WIZARD_STEP_WIKI` value + footer target exists as a `docs/wiki/*.md` file (dead-link guard) → `wiki-links.test.ts`. Note the guard is a local-file proxy; live status confirmed 200 for all 8 at ship time.
- `WikiLink` public API + rendered output unchanged after the `ExternalLink` extraction → `wiki-link.test.tsx`.

Set frontmatter `status: active`.

- [ ] **Step 2: Add the INDEX entry**

Add a line under the setup/wizard area in `docs/features/INDEX.md` pointing to `fe-52-53-wizard-help-links.md`.

- [ ] **Step 3: Append release notes (both files)**

To `docs/release-notes-next.md` (technical register), append:

```markdown
- **First-run wizard — help is now one click away (fe-52 / fe-53, #1615 / #1616).**
  Every setup step now shows a persistent "Need help?" footer (getting started,
  install guide, troubleshooting, report a problem, ask a question) plus a
  contextual "Learn more" deep-link to the wiki page for that step.
```

To the in-progress version section at the top of `RELEASE_NOTES.md` (user-facing, brand voice), add:

```markdown
- Stuck partway through setup? Every step of the first-run wizard now has help
  right where you are — a "Need help?" bar linking the guide, troubleshooting,
  and the community, plus a "Learn more" link to the wiki page for whatever
  you're on.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/fe-52-53-wizard-help-links.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): regression plan + release notes for wizard help/wiki links"
```

---

### Task 9: Verify, push, open the PR

**Files:** none (integration + handoff).

- [ ] **Step 1: Run the branch-scoped battery**

Run: `npm run verify:fast:branch`
Expected: PASS (lint, typecheck, config:check, test:hooks, test, test:server, build — each scope-gated to the diff).

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/frontend-fe-52-53-wizard-help-links
```

- [ ] **Step 3: Open the PR (title matches commit convention; body closes both issues)**

```bash
gh pr create --title "feat(frontend): wizard help & resources + per-step wiki deep-links" --body "$(cat <<'BODY'
## Summary

Closes #1615
Closes #1616

Adds a persistent "Need help?" footer to every first-run setup-wizard surface
(getting started, install guide, troubleshooting, report a problem, ask a
question) and a contextual "Learn more" wiki deep-link per step. URLs are
centralized in `src/lib/wiki-links.ts`; a guard test blocks dead links. Design:
`docs/superpowers/specs/2026-07-15-wizard-help-wiki-links-design.md`.

## Test plan

- Unit: `wiki-links.test.ts` (dead-link guard + step-map exhaustiveness),
  `external-link.test.tsx`, `help-resources.test.tsx`, `setup-wizard.test.tsx`
  (footer + contextual link).
- e2e: `e2e/setup-help-links.spec.ts` (footer + per-step link, phone viewport).
- Regression plan: `docs/features/fe-52-53-wizard-help-links.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 4: Confirm the PR links both issues and CI is running**

Run: `gh pr view --json title,body,url`
Expected: body contains `Closes #1615` and `Closes #1616`; `verify.yml` starts on the push.

- [ ] **Step 5: Run the mandatory independent code-review gate**

Per CLAUDE.md, a single-scope `feat` PR gets a **`low`-effort** `code-review` pass (no `--fix`) once fully staged. Triage and fold findings before merge.

---

## Self-Review

**Spec coverage:**
- fe-52 persistent footer → Tasks 4 + 5 (mount) + 6 (e2e). ✓
- fe-53 per-step contextual link → Tasks 2 (map) + 5 (render) + 6 (e2e). ✓
- Single constants module, externally-owned comments → Task 2. ✓
- `Installing-Castwright` exposed + no dead links (guard) → Task 2. ✓
- `StepId` shared module (no lib→component cycle) → Task 1. ✓
- `ExternalLink` extraction, `WikiLink` unchanged → Task 3. ✓
- Responsive (footer flex-wrap, in-flow contextual link) → Tasks 4/5 markup + Task 6 phone viewport. ✓
- Wiki content arrival pass → Task 7. ✓
- Regression plan + INDEX + release notes ×2 → Task 8. ✓
- Verify + PR closing both issues + code-review → Task 9. ✓

**Placeholder scan:** every code/step block contains real content; no TBD/TODO. ✓

**Type consistency:** `StepId`/`STEPS` (Task 1) consumed by `WIZARD_STEP_WIKI` (Task 2) and `GuidedWizard` (Task 5); `ExternalLink({href,label,className})` (Task 3) consumed by `HelpResources` (Task 4); `WIZARD_STEP_WIKI[step.id]` keyed by the same `StepId`. Names match across tasks. ✓
