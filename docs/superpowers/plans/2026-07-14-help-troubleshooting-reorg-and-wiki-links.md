# Help Troubleshooting Reorg + Wiki Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flat 43-item Troubleshooting list into topical, collapsible, searchable categories, and add curated page-level "Read more on the wiki →" links across Help and Admin.

**Architecture:** Category assignment is data pinned by the type system (`satisfies Record<FailureCode, CategoryId>` + a `category` field on each topic); `help.tsx` groups all items by category into collapsible accordions with a client-side search box; a new `wiki-links.ts` map + `WikiLink` component render external page-level links, guarded by a test asserting each referenced wiki page file exists.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit; Vitest + React Testing Library; Playwright (chromium) for e2e. All Help data is static/bundled — zero network calls.

**Spec:** `docs/superpowers/specs/2026-07-14-help-troubleshooting-reorg-and-wiki-links-design.md` (adversarial review folded).

## Global Constraints

- **Zero network calls in the Help view** — all copy is static/bundled; the view must render with the server down (plan 209 invariant 2). Wiki links are inert `<a href>` until clicked.
- **`satisfies Record<FailureCode, …>` pins stay total** — every `FailureCode` (incl. `unknown`) must have a title AND a category, or `npm run typecheck` fails (plan 209 invariant 3).
- **Design tokens only** — no hex literals; use `text-ink`, `text-magenta`, `border-ink/10`, `bg-white`, etc. (existing classes in `help.tsx`).
- **Touch targets ≥44px on touch devices** — `min-h-[44px] fine-pointer:min-h-0` (and `min-w-[44px] fine-pointer:min-w-0` for icon-only). Never `sm:min-h-0` (kills the tablet target).
- **Links are page-level only** — no `#anchor` fragments (GitHub wiki slug fragility). `wikiUrl(page)` builds `${WIKI_BASE}/${page}`.
- **Commit per task** with Conventional Commits: `<type>(<scope>): <subject>`. Allowed scopes here: `frontend`, `e2e`, `docs`. Example: `feat(frontend): add wiki-links module`.
- **A GPU generation run may be active this session** — run only frontend Vitest (`npm run test`, torch-free) and Playwright; do NOT run `test:server`/`test:sidecar` batteries while a render is live.
- **Branch:** all work lands on `feat/frontend-help-troubleshooting-wiki-links` (cut in Task 0).

---

## File Structure

- `src/lib/wiki-links.ts` (**create**) — `WIKI_BASE`, `WikiPage` union, `wikiUrl()`, `CATEGORY_WIKI` + `ADMIN_WIKI` + `HELP_SECTION_WIKI` maps.
- `src/lib/wiki-links.test.ts` (**create**) — page-existence guard.
- `src/components/wiki-link.tsx` (**create**) — reusable `WikiLink` external-link component.
- `src/components/wiki-link.test.tsx` (**create**) — renders correct href/target/rel/label.
- `src/data/help-failures.ts` (**modify**) — add `CategoryId`, `CATEGORIES` pin, `category` on `HelpFailureEntry`.
- `src/data/help-categories.ts` (**create**) — ordered `HELP_CATEGORIES`.
- `src/data/help-topics.ts` (**modify**) — add `category` field to `HelpTopic` and all 24 topics.
- `src/data/help-categories.test.ts` (**create**) — category completeness guard.
- `src/views/help.tsx` (**modify**) — grouped accordion + search + wiki links.
- `src/views/help.test.tsx` (**modify**) — default state, expand/collapse, deep-link mount, search, wiki hrefs.
- `src/views/admin.tsx` (**modify**) — panel-header wiki links.
- `src/components/lan-access-card.tsx` (**modify**) — LAN wiki link.
- `src/views/admin.test.tsx` (**modify**) — admin wiki hrefs.
- `e2e/help.spec.ts` (**modify**) — fix 2 assertions, add search + wiki-href checks.
- `docs/features/209-help-troubleshooting-view.md` (**modify**) — record new IA + wiki surface.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` (**modify**) — release notes.

---

## Task 0: Cut the branch in an isolated worktree (no work on main)

All implementation runs in a **dedicated git worktree** on the feature branch — never on `main`, never in the primary checkout. The feature branch is cut **off the docs branch** (`docs/help-troubleshooting-reorg-spec`) so the spec + plan ride along into one PR.

- [ ] **Step 1: Create the worktree + feature branch off the docs branch**

```bash
# from the primary checkout root
git worktree add -b feat/frontend-help-troubleshooting-wiki-links \
  ../castwright-help-reorg docs/help-troubleshooting-reorg-spec
cd ../castwright-help-reorg
ls docs/superpowers/specs/2026-07-14-* docs/superpowers/plans/2026-07-14-*
```
Expected: worktree created on `feat/frontend-help-troubleshooting-wiki-links`; both spec + plan files listed (present on the branch).

- [ ] **Step 2: Activate hooks + deps in the worktree**

A fresh worktree has no active husky hooks and its own `node_modules` state. Run once:

```bash
npm install   # activates husky (core.hooksPath) and installs deps in the worktree
```
Expected: install completes; `.husky/_` present. (If `node_modules` is huge, a junction to the primary checkout's is acceptable per repo convention — but `npm install` must still run so husky activates.)

> Windows/worktree gotchas (see repo memory): don't `mklink /J` the whole `node_modules` blindly; `test:server` in a fresh worktree may trigger a real venv/torch bootstrap if `.venv` is absent — not relevant here (frontend-only), but avoid the server battery in the worktree while a GPU render is live.

---

## Task 1: `wiki-links.ts` module + page-existence guard

**Files:**
- Create: `src/lib/wiki-links.ts`
- Test: `src/lib/wiki-links.test.ts`

**Interfaces:**
- Produces: `WIKI_BASE: string`; `type WikiPage`; `wikiUrl(page: WikiPage): string`; `CATEGORY_WIKI: Record<CategoryId, WikiPage>`; `ADMIN_WIKI: Record<'modelManager' | 'advanced' | 'lanAccess' | 'admin', WikiPage>`; `HELP_SECTION_WIKI: Record<'gettingStarted' | 'keyboard' | 'troubleshooting', WikiPage>`.
- Consumes: nothing yet. `CATEGORY_WIKI` is typed `Record<string, WikiPage>` in this task (no dependency on `CategoryId`), and tightened to `satisfies Record<CategoryId, WikiPage>` in Task 3 Step 3d once `CategoryId` exists. The dependency is one-directional (`wiki-links.ts` will later import `CategoryId` from `help-failures.ts`; nothing imports back) — no cycle.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/wiki-links.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WIKI_BASE, wikiUrl, CATEGORY_WIKI, ADMIN_WIKI, HELP_SECTION_WIKI } from './wiki-links';

const here = dirname(fileURLToPath(import.meta.url));
const wikiDir = resolve(here, '../../docs/wiki');

describe('wiki-links', () => {
  it('wikiUrl builds a page-level GitHub wiki URL (no anchor)', () => {
    expect(wikiUrl('Troubleshooting')).toBe(`${WIKI_BASE}/Troubleshooting`);
    expect(wikiUrl('Troubleshooting')).not.toContain('#');
  });

  it('every referenced WikiPage exists as docs/wiki/<page>.md', () => {
    const pages = new Set<string>([
      ...Object.values(CATEGORY_WIKI),
      ...Object.values(ADMIN_WIKI),
      ...Object.values(HELP_SECTION_WIKI),
    ]);
    for (const page of pages) {
      const path = resolve(wikiDir, `${page}.md`);
      expect(existsSync(path), `missing wiki page: ${page}.md`).toBe(true);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/wiki-links.test.ts`
Expected: FAIL — `Failed to resolve import "./wiki-links"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/wiki-links.ts
/* Curated, page-level links out to the published GitHub wiki (Help + Admin).
   Page-level only — no #anchor fragments (GitHub wiki slug generation is not
   README-markdown slugging and is fragile to replicate). The guard test asserts
   each referenced page file exists under docs/wiki/. */

/* NOTE: hardcodes the repo owner. If the repo transfers to an org, update this. */
export const WIKI_BASE = 'https://github.com/dudarenok-maker/Castwright/wiki';

export type WikiPage =
  | 'Getting-Started'
  | 'Account-and-Settings'
  | 'Troubleshooting'
  | 'Voice-Engines'
  | 'Analysis-and-the-Analyzer'
  | 'Multi-language-Support'
  | 'Generating-Audio'
  | 'Reviewing-Cast-and-Assigning-Voices'
  | 'Advanced-Settings'
  | 'Exporting'
  | 'Model-Manager'
  | 'Mobile-Tablet-and-Companion-App'
  | 'Admin';

export function wikiUrl(page: WikiPage): string {
  return `${WIKI_BASE}/${page}`;
}

/* Best-fit wiki page per Troubleshooting category. Page-level, so retuning is a
   one-line edit. Keyed by CategoryId (src/data/help-failures.ts). */
export const CATEGORY_WIKI: Record<string, WikiPage> = {
  setup: 'Getting-Started',
  engines: 'Voice-Engines',
  analysis: 'Analysis-and-the-Analyzer',
  voices: 'Multi-language-Support',
  quality: 'Generating-Audio',
  cast: 'Reviewing-Cast-and-Assigning-Voices',
  performance: 'Advanced-Settings',
  files: 'Exporting',
  other: 'Troubleshooting',
};

export const ADMIN_WIKI = {
  modelManager: 'Model-Manager',
  advanced: 'Advanced-Settings',
  lanAccess: 'Mobile-Tablet-and-Companion-App',
  admin: 'Admin',
} satisfies Record<string, WikiPage>;

export const HELP_SECTION_WIKI = {
  gettingStarted: 'Getting-Started',
  keyboard: 'Account-and-Settings',
  troubleshooting: 'Troubleshooting',
} satisfies Record<string, WikiPage>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/wiki-links.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wiki-links.ts src/lib/wiki-links.test.ts
git commit -m "feat(frontend): add wiki-links module with page-existence guard"
```

---

## Task 2: `WikiLink` component

**Files:**
- Create: `src/components/wiki-link.tsx`
- Test: `src/components/wiki-link.test.tsx`

**Interfaces:**
- Consumes: `wikiUrl`, `WikiPage` from `src/lib/wiki-links.ts`; `IconExternal` from `src/lib/icons`.
- Produces: `WikiLink({ page, label?, className? }): JSX.Element` — renders `<a href={wikiUrl(page)} target="_blank" rel="noopener noreferrer">`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/wiki-link.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WikiLink } from './wiki-link';

describe('WikiLink', () => {
  it('renders a page-level external link with safe rel', () => {
    render(<WikiLink page="Troubleshooting" />);
    const a = screen.getByRole('link', { name: /read more on the wiki/i });
    expect(a).toHaveAttribute('href', 'https://github.com/dudarenok-maker/Castwright/wiki/Troubleshooting');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('accepts a custom label', () => {
    render(<WikiLink page="Admin" label="Admin guide" />);
    expect(screen.getByRole('link', { name: /admin guide/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/wiki-link.test.tsx`
Expected: FAIL — cannot resolve `./wiki-link`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/wiki-link.tsx
/* Curated outbound link to the published GitHub wiki. External, page-level.
   Used across the Help and Admin views (see src/lib/wiki-links.ts). */
import { wikiUrl, type WikiPage } from '../lib/wiki-links';
import { IconExternal } from '../lib/icons';

export function WikiLink({
  page,
  label = 'Read more on the wiki',
  className = '',
}: {
  page: WikiPage;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={wikiUrl(page)}
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/wiki-link.test.tsx`
Expected: PASS (2 tests).

> If `IconExternal` does not accept a `className` prop, pass sizing via its documented prop (check `src/lib/icons.tsx` `IconProps`); the icons use a shared `IconProps` — `className` is supported.

- [ ] **Step 5: Commit**

```bash
git add src/components/wiki-link.tsx src/components/wiki-link.test.tsx
git commit -m "feat(frontend): add reusable WikiLink component"
```

---

## Task 3: Category data model (`CategoryId`, `CATEGORIES` pin, topic `category`, `HELP_CATEGORIES`)

**Files:**
- Modify: `src/data/help-failures.ts`
- Modify: `src/data/help-topics.ts`
- Create: `src/data/help-categories.ts`
- Test: `src/data/help-categories.test.ts`
- Modify: `src/lib/wiki-links.ts` (tighten `CATEGORY_WIKI` type)

**Interfaces:**
- Produces: `CategoryId` (union) + `category` on `HelpFailureEntry` (from `help-failures.ts`); `category` on `HelpTopic` (from `help-topics.ts`); `HELP_CATEGORIES: { id: CategoryId; label: string }[]` (from `help-categories.ts`).
- Consumes: existing `FailureCode`, `HELP_FAILURE_ENTRIES`, `HELP_TOPICS`.

- [ ] **Step 1: Write the failing test**

```ts
// src/data/help-categories.test.ts
import { describe, expect, it } from 'vitest';
import { HELP_CATEGORIES } from './help-categories';
import { HELP_FAILURE_ENTRIES, type CategoryId } from './help-failures';
import { HELP_TOPICS } from './help-topics';

const IDS = new Set<CategoryId>(HELP_CATEGORIES.map((c) => c.id));

describe('help categories', () => {
  it('every failure entry has a category in HELP_CATEGORIES', () => {
    for (const e of HELP_FAILURE_ENTRIES) {
      expect(IDS.has(e.category), `${e.code} → ${e.category}`).toBe(true);
    }
  });

  it('every topic has a category in HELP_CATEGORIES', () => {
    for (const t of HELP_TOPICS) {
      expect(IDS.has(t.category), `${t.id} → ${t.category}`).toBe(true);
    }
  });

  it('every category id is unique and non-empty', () => {
    expect(IDS.size).toBe(HELP_CATEGORIES.length);
    expect(HELP_CATEGORIES.every((c) => c.label.length > 0)).toBe(true);
  });

  it('has exactly 43 items across all categories (19 failures + 24 topics)', () => {
    expect(HELP_FAILURE_ENTRIES.length + HELP_TOPICS.length).toBe(43);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/data/help-categories.test.ts`
Expected: FAIL — cannot resolve `./help-categories`, and `CategoryId`/`category` not exported.

- [ ] **Step 3a: Add `CategoryId` + `CATEGORIES` pin to `help-failures.ts`**

In `src/data/help-failures.ts`, add after the `FailureCode` type:

```ts
export type CategoryId =
  | 'setup'
  | 'engines'
  | 'analysis'
  | 'voices'
  | 'quality'
  | 'cast'
  | 'performance'
  | 'files'
  | 'other';

/* Topical bucket per failure code — pinned total so a new FailureCode without a
   category fails typecheck (mirrors the TITLES pin). */
const CATEGORIES = {
  'vram-spill': 'performance',
  'recycle-storm': 'engines',
  'sidecar-unreachable': 'engines',
  'analyzer-rate-limit': 'analysis',
  'analyzer-daily-quota': 'analysis',
  'analyzer-truncated': 'analysis',
  'analyzer-unreachable': 'analysis',
  'analyzer-content-blocked': 'analysis',
  'attribution-incomplete': 'analysis',
  oom: 'performance',
  'disk-full': 'files',
  'model-not-loaded': 'engines',
  'synth-timeout': 'engines',
  'xtts-speaker-desync': 'engines',
  'cuda-poisoned': 'performance',
  'gpu-acceleration-unavailable': 'performance',
  'voice-not-designed': 'voices',
  auth: 'analysis',
  unknown: 'other',
} satisfies Record<FailureCode, CategoryId>;
```

Then extend the entry interface and the mapper:

```ts
export interface HelpFailureEntry extends FailureRemediationCopy {
  code: FailureCode;
  title: string;
  category: CategoryId;
}

export const HELP_FAILURE_ENTRIES: HelpFailureEntry[] = (
  Object.keys(TITLES) as FailureCode[]
).map((code) => ({
  code,
  title: TITLES[code],
  category: CATEGORIES[code],
  ...FAILURE_REMEDIATIONS[code],
}));
```

- [ ] **Step 3b: Add `category` to `HelpTopic` and every topic in `help-topics.ts`**

Change the interface:

```ts
import type { CategoryId } from './help-failures';

export interface HelpTopic {
  id: string;
  title: string;
  body: string;
  category: CategoryId;
}
```

Add `category:` to each of the 24 entries per this table (add the field to the existing objects; do not reword copy):

| topic id | category |
|---|---|
| app-wont-start | setup |
| setup-not-ready | setup |
| models-missing | engines |
| languages-supported | voices |
| voices-hidden-wrong-language | voices |
| higher-quality-tier | quality |
| generation-slow | performance |
| amd-gpu | performance |
| multi-gpu-placement | performance |
| design-without-cloud-key | voices |
| vocalizations | quality |
| line-direction | quality |
| voice-consistency-flag | quality |
| script-review-fixes | cast |
| cast-carried-across-books | cast |
| engine-needs-repair | engines |
| phone-cant-reach | files |
| lan-token-pairing | files |
| where-files-live | files |
| audiobookshelf-export | files |
| caption-export | files |
| analysis-reloads-or-gpu-busy | analysis |
| ollama-model-not-in-list | analysis |
| picked-local-but-ran-on-gemini | analysis |

- [ ] **Step 3c: Create `help-categories.ts`**

```ts
// src/data/help-categories.ts
/* Ordered render list for the Help troubleshooting groups. `setup` first (it is
   open by default); `other` ("Something else", the unknown-failure bucket) last. */
import type { CategoryId } from './help-failures';

export const HELP_CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'setup', label: 'Setup & getting started' },
  { id: 'engines', label: 'Voice engines & models' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'voices', label: 'Voices & languages' },
  { id: 'quality', label: 'Quality & directing' },
  { id: 'cast', label: 'Cast & attribution' },
  { id: 'performance', label: 'Performance & GPU' },
  { id: 'files', label: 'Files, export & devices' },
  { id: 'other', label: 'Something else' },
];
```

- [ ] **Step 3d: Tighten `CATEGORY_WIKI` type in `wiki-links.ts`**

Change `CATEGORY_WIKI`'s type annotation from `Record<string, WikiPage>` to a pinned one:

```ts
import type { CategoryId } from '../data/help-failures';
// ...
export const CATEGORY_WIKI = {
  setup: 'Getting-Started',
  engines: 'Voice-Engines',
  analysis: 'Analysis-and-the-Analyzer',
  voices: 'Multi-language-Support',
  quality: 'Generating-Audio',
  cast: 'Reviewing-Cast-and-Assigning-Voices',
  performance: 'Advanced-Settings',
  files: 'Exporting',
  other: 'Troubleshooting',
} satisfies Record<CategoryId, WikiPage>;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- src/data/help-categories.test.ts src/lib/wiki-links.test.ts && npm run typecheck`
Expected: PASS (all category tests green; typecheck clean — the two `satisfies` pins prove totality).

- [ ] **Step 5: Commit**

```bash
git add src/data/help-failures.ts src/data/help-topics.ts src/data/help-categories.ts src/data/help-categories.test.ts src/lib/wiki-links.ts
git commit -m "feat(frontend): add troubleshooting category taxonomy as pinned data"
```

---

## Task 4: Grouped collapsible accordion in `help.tsx` (default `setup` open, deep-link mounts)

**Files:**
- Modify: `src/views/help.tsx`
- Modify: `src/views/help.test.tsx`

**Interfaces:**
- Consumes: `HELP_CATEGORIES`, `HELP_FAILURE_ENTRIES` (with `category`), `HELP_TOPICS` (with `category`), `CategoryId`.
- Produces: the grouped render used by Task 5 (search) and Task 6 (wiki links). Introduces a `HelpItem` union and a `CategoryGroup` sub-component within `help.tsx`.

- [ ] **Step 1: Write the failing tests** (replace the two existing tests + add new ones)

In `src/views/help.test.tsx`, replace the `renders a taxonomy entry…` and `marks the focused entry…` tests and add default-state/toggle tests:

```tsx
  it('opens the Setup group by default and leaves others collapsed', () => {
    renderHelp();
    // setup item visible…
    expect(screen.getByText("The app won't start")).toBeInTheDocument();
    // …a performance-group item is NOT mounted (group collapsed)
    expect(screen.queryByText('GPU out of memory (VRAM)')).toBeNull();
  });

  it('expands a group on header click and shows failure-card labels', () => {
    renderHelp();
    fireEvent.click(screen.getByRole('button', { name: /performance & gpu/i }));
    expect(screen.getByText('GPU out of memory (VRAM)')).toBeInTheDocument();
    // failure cards carry the What-you-saw / What-to-do labels (topic cards do not)
    expect(screen.getAllByText(/what to do/i).length).toBeGreaterThan(0);
  });

  it('mounts and marks the focused entry inside its auto-expanded group', () => {
    renderHelp('vram-spill'); // performance
    const el = document.getElementById('vram-spill');
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute('data-focused', 'true');
  });

  it('ignores an unknown focusCode (setup still the only open group)', () => {
    renderHelp('nonsense');
    expect(document.querySelector('[data-focused="true"]')).toBeNull();
    expect(screen.getByText("The app won't start")).toBeInTheDocument();
    expect(screen.queryByText('GPU out of memory (VRAM)')).toBeNull();
  });
```

(Delete the old `renders a taxonomy entry with What-you-saw / What-to-do` and `marks the focused entry when focusCode matches` tests — superseded above. Keep the three-sections, keybindings, and tour tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/views/help.test.tsx`
Expected: FAIL — `getByRole('button', { name: /performance & gpu/i })` not found; GPU text currently visible (old flat render).

- [ ] **Step 3: Rewrite the Troubleshooting section render in `help.tsx`**

Add imports at top:

```tsx
import { useState } from 'react';
import { HELP_CATEGORIES } from '../data/help-categories';
import type { CategoryId } from '../data/help-failures';
import { IconChevR, IconChevD } from '../lib/icons';
```

Add a normalized item model + grouping helper (module scope, below `GETTING_STARTED`):

```tsx
type HelpItem =
  | { kind: 'failure'; id: string; title: string; category: CategoryId; search: string; entry: (typeof HELP_FAILURE_ENTRIES)[number] }
  | { kind: 'topic'; id: string; title: string; category: CategoryId; search: string; topic: (typeof HELP_TOPICS)[number] };

const HELP_ITEMS: HelpItem[] = [
  ...HELP_FAILURE_ENTRIES.map((entry) => ({
    kind: 'failure' as const,
    id: entry.code,
    title: entry.title,
    category: entry.category,
    search: `${entry.title} ${entry.userMessage} ${entry.remediation} ${entry.helpDetail ?? ''}`.toLowerCase(),
    entry,
  })),
  ...HELP_TOPICS.map((topic) => ({
    kind: 'topic' as const,
    id: topic.id,
    title: topic.title,
    category: topic.category,
    search: `${topic.title} ${topic.body}`.toLowerCase(),
    topic,
  })),
];

function itemsFor(category: CategoryId): HelpItem[] {
  return HELP_ITEMS.filter((i) => i.category === category);
}
```

Inside `HelpView`, compute the focused category + initial expanded set (replace the existing `focusedEntryExists` line usage as needed — keep `focusedRef`):

```tsx
  const focusedCategory = HELP_FAILURE_ENTRIES.find((e) => e.code === focusCode)?.category;
  const [expanded, setExpanded] = useState<Set<CategoryId>>(() => {
    const s = new Set<CategoryId>(['setup']);
    if (focusedCategory) s.add(focusedCategory);
    return s;
  });
  const toggle = (id: CategoryId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
```

Replace the whole troubleshooting body (the `<h3>Failures the app can name</h3> … Common questions …` block, `help.tsx:254-297`) with a category loop:

```tsx
            <div className="mt-6 space-y-3">
              {HELP_CATEGORIES.map((cat) => {
                const items = itemsFor(cat.id);
                const open = expanded.has(cat.id);
                return (
                  <div key={cat.id} className="rounded-xl border border-ink/10 bg-white">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`cat-panel-${cat.id}`}
                      onClick={() => toggle(cat.id)}
                      className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3 min-h-[44px] fine-pointer:min-h-0 text-left"
                    >
                      <span className="font-semibold text-ink">
                        {cat.label}{' '}
                        <span className="font-normal text-ink/40">({items.length})</span>
                      </span>
                      {open ? (
                        <IconChevD className="w-4 h-4 text-ink/50 shrink-0" aria-hidden="true" />
                      ) : (
                        <IconChevR className="w-4 h-4 text-ink/50 shrink-0" aria-hidden="true" />
                      )}
                    </button>
                    {open && (
                      <div
                        id={`cat-panel-${cat.id}`}
                        className="px-4 sm:px-5 pb-4 space-y-3 border-t border-ink/5 pt-3"
                      >
                        {items.map((item) => (
                          <HelpItemCard key={item.id} item={item} focusCode={focusCode} focusedRef={focusedRef} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
```

Extract the per-item card (keeps the exact existing card markup for each kind) as a sub-component in `help.tsx`:

```tsx
function HelpItemCard({
  item,
  focusCode,
  focusedRef,
}: {
  item: HelpItem;
  focusCode?: string;
  focusedRef: React.RefObject<HTMLDivElement | null>;
}) {
  const focused = item.id === focusCode;
  const cardCls = `rounded-xl border p-4 sm:p-5 scroll-mt-24 ${
    focused ? 'border-magenta ring-2 ring-magenta/40 bg-magenta/5' : 'border-ink/10 bg-white'
  }`;
  if (item.kind === 'failure') {
    const e = item.entry;
    return (
      <div id={e.code} data-focused={focused ? 'true' : undefined} ref={focused ? focusedRef : undefined} className={cardCls}>
        <h4 className="font-semibold text-ink">{e.title}</h4>
        <p className="mt-2 text-sm text-ink/70">
          <span className="font-semibold text-ink/80">What you saw: </span>
          {e.userMessage}
        </p>
        <p className="mt-1.5 text-sm text-ink/70">
          <span className="font-semibold text-ink/80">What to do: </span>
          {e.remediation}
        </p>
        {e.helpDetail && <p className="mt-1.5 text-sm text-ink/50">{e.helpDetail}</p>}
      </div>
    );
  }
  const t = item.topic;
  return (
    <div id={t.id} data-focused={focused ? 'true' : undefined} ref={focused ? focusedRef : undefined} className={cardCls}>
      <h4 className="font-semibold text-ink">{t.title}</h4>
      <p className="mt-2 text-sm text-ink/70">{t.body}</p>
    </div>
  );
}
```

Keep the existing focus-scroll `useEffect` (`help.tsx:123-126`) as-is — the focused item now mounts because its category is in the initial `expanded` set. Remove the now-unused `focusedEntryExists` guard only if it becomes dead; otherwise leave it driving the effect condition.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/views/help.test.tsx`
Expected: PASS (default-open setup, toggle expands performance, deep-link mounts + `data-focused`, unknown code no-op).

- [ ] **Step 5: Commit**

```bash
git add src/views/help.tsx src/views/help.test.tsx
git commit -m "feat(frontend): group troubleshooting into collapsible categories"
```

---

## Task 5: Search / filter box

**Files:**
- Modify: `src/views/help.tsx`
- Modify: `src/views/help.test.tsx`

**Interfaces:**
- Consumes: `HELP_ITEMS`, `HELP_CATEGORIES`, the `expanded` state from Task 4.
- Produces: a `query` state that, when non-empty, overrides expansion (matching groups render only matching items; non-matching groups hidden) and shows an "N of 43" count.

- [ ] **Step 1: Write the failing tests**

```tsx
  it('filters items by search text and hides non-matching groups', () => {
    renderHelp();
    fireEvent.change(screen.getByRole('searchbox', { name: /search troubleshooting/i }), {
      target: { value: 'vram' },
    });
    expect(screen.getByText('GPU out of memory (VRAM)')).toBeInTheDocument();
    expect(screen.queryByText("The app won't start")).toBeNull();
  });

  it('shows a result count and clears back to grouped view', () => {
    renderHelp();
    const box = screen.getByRole('searchbox', { name: /search troubleshooting/i });
    fireEvent.change(box, { target: { value: 'gpu' } });
    expect(screen.getByText(/of 43/i)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '' } });
    // back to default: setup open, performance collapsed
    expect(screen.getByText("The app won't start")).toBeInTheDocument();
    expect(screen.queryByText('GPU out of memory (VRAM)')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/views/help.test.tsx`
Expected: FAIL — no `searchbox` role present.

- [ ] **Step 3: Add the search box + filter logic**

In `HelpView`, add state and a derived matcher:

```tsx
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (item: HelpItem) => q === '' || item.search.includes(q);
  const totalMatches = q === '' ? HELP_ITEMS.length : HELP_ITEMS.filter(matches).length;
```

Add the input just under the troubleshooting intro `<p>` (before the groups container). Use `IconSearch` and `IconClose`:

```tsx
            <div className="mt-6 relative max-w-md">
              <IconSearch className="w-4 h-4 text-ink/40 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="search"
                aria-label="Search troubleshooting"
                placeholder="Search troubleshooting…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full min-h-[44px] fine-pointer:min-h-0 rounded-xl border border-ink/15 bg-white pl-9 pr-3 py-2 text-sm text-ink placeholder:text-ink/40"
              />
              {q !== '' && (
                <span className="mt-2 block text-xs text-ink/50">{totalMatches} of {HELP_ITEMS.length}</span>
              )}
            </div>
```

Replace the **entire** group-loop container from Task 4 with this search-aware version (complete — do not leave any prose gaps). While `q !== ''`, a group is force-open and shows only its matching items; groups with no matches are hidden; the header count reflects `items.length` while searching, else the full `all.length`:

```tsx
            <div className="mt-6 space-y-3">
              {HELP_CATEGORIES.map((cat) => {
                const all = itemsFor(cat.id);
                const items = q === '' ? all : all.filter(matches);
                if (q !== '' && items.length === 0) return null; // hide non-matching groups while searching
                const open = q !== '' ? true : expanded.has(cat.id);
                const count = q === '' ? all.length : items.length;
                return (
                  <div key={cat.id} className="rounded-xl border border-ink/10 bg-white">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`cat-panel-${cat.id}`}
                      onClick={() => toggle(cat.id)}
                      disabled={q !== ''}
                      className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3 min-h-[44px] fine-pointer:min-h-0 text-left disabled:cursor-default"
                    >
                      <span className="font-semibold text-ink">
                        {cat.label} <span className="font-normal text-ink/40">({count})</span>
                      </span>
                      {open ? (
                        <IconChevD className="w-4 h-4 text-ink/50 shrink-0" aria-hidden="true" />
                      ) : (
                        <IconChevR className="w-4 h-4 text-ink/50 shrink-0" aria-hidden="true" />
                      )}
                    </button>
                    {open && (
                      <div
                        id={`cat-panel-${cat.id}`}
                        className="px-4 sm:px-5 pb-4 space-y-3 border-t border-ink/5 pt-3"
                      >
                        {items.map((item) => (
                          <HelpItemCard key={item.id} item={item} focusCode={focusCode} focusedRef={focusedRef} />
                        ))}
                        <div className="pt-1">
                          <WikiLink page={CATEGORY_WIKI[cat.id]} label="More on this in the wiki" className="text-xs" />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
```

> This block already includes the per-category `WikiLink` from Task 6 — when doing Task 5 before Task 6, omit the `WikiLink` line + its wrapping `<div>` and add them in Task 6; when doing them together, keep as shown. The `disabled={q !== ''}` on the header prevents toggling a force-open group mid-search (a click would otherwise mutate `expanded` invisibly).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/views/help.test.tsx`
Expected: PASS (filter hides non-matching, count shows, clear restores default).

- [ ] **Step 5: Commit**

```bash
git add src/views/help.tsx src/views/help.test.tsx
git commit -m "feat(frontend): add client-side search to troubleshooting"
```

---

## Task 6: Wire `WikiLink` into the Help view

**Files:**
- Modify: `src/views/help.tsx`
- Modify: `src/views/help.test.tsx`

**Interfaces:**
- Consumes: `WikiLink`, `HELP_SECTION_WIKI`, `CATEGORY_WIKI`.

- [ ] **Step 1: Write the failing test**

```tsx
  it('renders section-level and per-category wiki links', () => {
    renderHelp();
    const links = screen.getAllByRole('link', { name: /read more on the wiki/i });
    // at least the 3 section links + setup category link are present on first render
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('https://github.com/dudarenok-maker/Castwright/wiki/Getting-Started');
    expect(hrefs).toContain('https://github.com/dudarenok-maker/Castwright/wiki/Troubleshooting');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/views/help.test.tsx`
Expected: FAIL — no wiki links yet.

- [ ] **Step 3: Add the links**

Imports:

```tsx
import { WikiLink } from '../components/wiki-link';
import { HELP_SECTION_WIKI, CATEGORY_WIKI } from '../lib/wiki-links';
```

- Getting started section: add `<WikiLink page={HELP_SECTION_WIKI.gettingStarted} className="mt-4" />` after the intro `<p>` (near the "Take the tour" button).
- Keyboard shortcuts section: add `<WikiLink page={HELP_SECTION_WIKI.keyboard} className="mt-4" />` after its intro `<p>`.
- Troubleshooting section: add `<WikiLink page={HELP_SECTION_WIKI.troubleshooting} className="mt-4" />` after its intro `<p>`.
- Per category: inside the open panel body (after the items list), add:

```tsx
                        <div className="pt-1">
                          <WikiLink page={CATEGORY_WIKI[cat.id]} label="More on this in the wiki" className="text-xs" />
                        </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/views/help.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/help.tsx src/views/help.test.tsx
git commit -m "feat(frontend): add wiki links to Help sections and categories"
```

---

## Task 7: Wire `WikiLink` into the Admin view

**Files:**
- Modify: `src/views/admin.tsx`
- Modify: `src/components/lan-access-card.tsx`
- Modify: `src/views/admin.test.tsx`

**Interfaces:**
- Consumes: `WikiLink`, `ADMIN_WIKI`.

- [ ] **Step 1: Write the failing test**

`admin.test.tsx` has **no** `renderAdmin` helper — it renders `<AdminView/>` inline with a store + a `vi.mock('../lib/api', …)` block whose fns are given `mockResolvedValue`s (handles at `admin.test.tsx:25-28`, resolved in the file's `beforeEach`). Append this test **inside** the existing top-level `describe` (so it inherits that `beforeEach`), asserting only the two synchronous nav cards (`ModelManagerLink`, `AdvancedConfigLink`) — they render immediately and need no resolved fetch, avoiding the async `HealthBoard`/`ResourceTrends` panels:

```tsx
  it('links Admin nav cards out to the wiki', () => {
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    render(
      <Provider store={store}>
        <AdminView />
      </Provider>,
    );
    const hrefs = screen
      .getAllByRole('link', { name: /wiki/i })
      .map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('https://github.com/dudarenok-maker/Castwright/wiki/Model-Manager');
    expect(hrefs).toContain('https://github.com/dudarenok-maker/Castwright/wiki/Advanced-Settings');
  });
```

> `configureStore`, `render`, `Provider`, `screen`, `uiSlice`, `AdminView` are already imported at the top of `admin.test.tsx` (lines 1-6). The `beforeEach` in that file must already resolve the api mocks (`mockWorktrees.mockResolvedValue(...)`, etc.) — if it does not (some tests set them per-test), copy the resolutions from a neighboring test so the async panels don't throw on mount. The LAN link is covered separately in `lan-access-card`'s own test if one exists; otherwise a follow-up.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/views/admin.test.tsx`
Expected: FAIL — no wiki links in Admin.

- [ ] **Step 3: Add the links**

In `src/views/admin.tsx`, `import { WikiLink } from '../components/wiki-link'; import { ADMIN_WIKI } from '../lib/wiki-links';` and add a compact link in each panel header:
- `ModelManagerLink` (`admin.tsx:150`): add `<WikiLink page={ADMIN_WIKI.modelManager} label="Wiki" className="text-xs" />` in the text `<div>` under the `<p>`.
- `AdvancedConfigLink` (`admin.tsx:197`): `<WikiLink page={ADMIN_WIKI.advanced} label="Wiki" className="text-xs" />`.
- `HealthBoard` / `GenerationThroughput` / `ResourceTrends` headers: `<WikiLink page={ADMIN_WIKI.admin} label="Wiki" className="text-xs" />` next to each `<h3>`.

In `src/components/lan-access-card.tsx`: add `<WikiLink page={ADMIN_WIKI.lanAccess} label="Wiki" className="text-xs" />` in the card header.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/views/admin.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/admin.tsx src/components/lan-access-card.tsx src/views/admin.test.tsx
git commit -m "feat(frontend): add wiki links to Admin panels"
```

---

## Task 8: E2E — fix the two flagged assertions + add search/wiki checks

**Files:**
- Modify: `e2e/help.spec.ts`

- [ ] **Step 1: Update `e2e/help.spec.ts`**

Replace the two tests:

```ts
test('top-bar ? opens Help with all three sections', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('topbar-help').click();
  await page.getByRole('menuitem', { name: /^help$/i }).click();
  await expect(page).toHaveURL(/#\/help$/);
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Troubleshooting' })).toBeVisible();
  // Groups are collapsed by default (setup open); open Performance & GPU to see its content.
  await page.getByRole('button', { name: /performance & gpu/i }).click();
  await expect(page.getByText('GPU out of memory (VRAM)')).toBeVisible();
});

test('?code= deep-link focuses the matching entry', async ({ page }) => {
  await page.goto('/#/help?code=vram-spill');
  await expect(page.locator('#vram-spill')).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('#vram-spill')).toBeInViewport();
});

test('search filters the troubleshooting list', async ({ page }) => {
  await page.goto('/#/help');
  await page.getByRole('searchbox', { name: /search troubleshooting/i }).fill('vram');
  await expect(page.getByText('GPU out of memory (VRAM)')).toBeVisible();
  await expect(page.getByText("The app won't start")).toHaveCount(0);
});

test('help exposes a wiki link (href only, no navigation)', async ({ page }) => {
  await page.goto('/#/help');
  const link = page.getByRole('link', { name: /read more on the wiki/i }).first();
  await expect(link).toHaveAttribute('href', /github\.com\/.+\/wiki\//);
});
```

- [ ] **Step 2: Run e2e**

Run: `npm run test:e2e -- help.spec.ts`
Expected: PASS (4 tests). (Requires `npx playwright install chromium` once; the runner errors with a hint if chromium is missing.)

- [ ] **Step 3: Commit**

```bash
git add e2e/help.spec.ts
git commit -m "test(e2e): cover grouped troubleshooting, search, and wiki link"
```

---

## Task 9: Docs — regression plan + release notes

**Files:**
- Modify: `docs/features/209-help-troubleshooting-view.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

- [ ] **Step 1: Update plan 209**

In `docs/features/209-help-troubleshooting-view.md`, add to the architecture/invariants that the troubleshooting section is now grouped into `HELP_CATEGORIES` (data in `help-failures.ts` `CATEGORIES` + `help-topics.ts` `category`), collapsible with `setup` open by default, client-side searchable, and that `?code=` auto-expands the focused entry's group. Add invariant: "Invariant 3 now reads 'anchor present when its group is open'; the only deep-link path (`focusCode`) auto-expands." Add the wiki-link surface (`wiki-links.ts` page-level map + `WikiLink`, page-existence guard test) and update the Test plan list to include `help-categories.test.ts`, `wiki-links.test.ts`, `wiki-link.test.tsx`, and the new e2e cases.

- [ ] **Step 2: Update release notes**

Append to `docs/release-notes-next.md` (technical register, PR-refed) and add a matching brand-voice line to the top in-progress section of `RELEASE_NOTES.md`, e.g.:

> Troubleshooting help is now sorted into clear, searchable sections instead of one long list — and Help and Admin now link straight out to the matching guide in the wiki.

- [ ] **Step 3: Commit**

```bash
git add docs/features/209-help-troubleshooting-view.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): record troubleshooting reorg + wiki links in plan 209 and release notes"
```

---

## Task 10: Whole-branch verification + PR

- [ ] **Step 1: Frontend battery + typecheck** (torch-free; safe during a GPU render)

Run: `npm run test -- src/views/help.test.tsx src/views/admin.test.tsx src/data/help-categories.test.ts src/lib/wiki-links.test.ts src/components/wiki-link.test.tsx && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 2: Branch-scoped gate**

Run: `npm run verify:fast:branch`
Expected: green (or, if the GPU is pinned and local legs contend, push and let cloud `verify.yml` gate — see CLAUDE.md "Commit gate").

- [ ] **Step 3: File issues + open PR**

File a `type:feature` + `area:frontend` issue for the Troubleshooting reorg and (if not folded into one) a second for the wiki-link surface; add thin rows to `docs/BACKLOG.md` if they represent net-new backlog items. Open the PR with `Closes #NN` for each, title `feat(frontend): reorganize troubleshooting help and add wiki links`, filling `## Summary` + `## Test plan` and linking the plan. Then run the mandatory `code-review` pass (medium effort — single-scope `feat`) before merge.

---

## Self-Review

**Spec coverage:**
- A.1 taxonomy → Task 3 (data) + Task 4 (render order via `HELP_CATEGORIES`). ✓
- A.2 data model (pinned `CATEGORIES`, topic `category`, `HELP_CATEGORIES`) → Task 3. ✓
- A.3 accordion / default `setup` open / deep-link mount / search / invariant 3 → Tasks 4 + 5. ✓
- B.1 `wiki-links.ts` (page-level, owner comment) → Task 1. ✓
- B.1 `WikiLink` component → Task 2. ✓
- B.2 Help section + category links; Admin panel links → Tasks 6 + 7. ✓
- B.3 page-existence guard (no anchor) → Task 1 test. ✓
- C testing (unit incl. updated `help.test.tsx:42`, category completeness, wiki-links; e2e two-assertion fix + search + wiki href) → Tasks 3–8. ✓
- Rollout/docs (plan 209, release notes, issues) → Task 9 + Task 10 Step 3. ✓
- Offline invariant preserved (inert `<a>`) → Global Constraints + no fetch introduced. ✓

**Placeholder scan:** No TBD/TODO; all code steps carry real code; test commands have expected output. The only deliberately-deferred detail is matching `admin.test.tsx`'s existing render harness (Task 7 flags reading the file first — a real constraint, not a placeholder).

**Type consistency:** `CategoryId` defined in `help-failures.ts` (Task 3), imported by `help-topics.ts`, `help-categories.ts`, `wiki-links.ts`, `help.tsx`. `HelpItem`/`itemsFor`/`HELP_ITEMS`/`HelpItemCard` names consistent across Tasks 4–6. `wikiUrl`/`WikiPage`/`CATEGORY_WIKI`/`ADMIN_WIKI`/`HELP_SECTION_WIKI` consistent across Tasks 1–2, 6–7. `WikiLink({ page, label?, className? })` signature matches all call sites.

## Review notes (assumption-checker, 2026-07-14)

Adversarial pass on this plan, folded before dispatch:

1. **Task 5 search step was prose, not code (most dangerous).** Fixed: Task 5 Step 3 now inlines the complete search-aware group loop (force-open under query, header count source, empty-group suppression, `disabled` toggle).
2. **Task 7 referenced a non-existent `renderAdmin()` helper.** Fixed: replaced with the real inline harness (store + `<AdminView/>` via the file's imports/`beforeEach`), asserting the two synchronous nav cards to avoid the async panels (confirmed vs `admin.test.tsx:1-28`).
3. **Icon props accept `className`/`aria-hidden`.** Confirmed vs `icons.tsx:3` (`IconProps = SVGProps<SVGSVGElement>`); the Task 2 hedge is harmless.
4. **Task 4 lost failure-card label coverage.** Fixed: the expand test now also asserts the "What to do" label.
5. **Task 1 Interfaces contradicted itself on ordering.** Fixed: no cycle; `Record<string,WikiPage>` in Task 1, tightened in Task 3.
6. **Branch/worktree coordination (user decision).** All implementation runs in a dedicated worktree on `feat/frontend-help-troubleshooting-wiki-links`, cut **off `docs/help-troubleshooting-reorg-spec`** (spec + plan ride along → one PR). No work on `main`. Task 0 rewritten accordingly.
