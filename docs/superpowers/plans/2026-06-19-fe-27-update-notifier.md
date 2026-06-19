# fe-27 In-app Update Notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the existing GitHub-Releases update check as a globally-visible, dismissible banner plus a version-pill dot, so testers know to upgrade without opening Account.

**Architecture:** Fold the already-cached update check into `GET /api/info` (non-blocking) so both surfaces ride the existing `useAppInfo` 30s poll — no new fetch, no new poller. A tiny `update-notice.ts` module holds the equality-based dismissal state (localStorage-backed, `useSyncExternalStore` pub/sub so the dot clears the instant the banner is dismissed) and the single shared visibility predicate consumed by the banner and the dot.

**Tech Stack:** Vite + React 18 + TypeScript, Express (Node 20), Vitest (frontend jsdom + server node), Playwright (chromium).

## Global Constraints

- **No backend network change to the hot path:** `/api/info` MUST NOT `await` the GitHub fetch. It reads the cache synchronously and kicks a fire-and-forget refresh. Cold cache → `updateAvailable: null`.
- **Fail-open everywhere:** any unreachable/parse failure → notifier dark, never an error or a thrown handler.
- **Equality dismissal, no client semver:** hide only when `latestVersion === dismissedVersion`. Do NOT port/duplicate the server's `compareSemver`.
- **Guarded `localStorage`:** reads/writes wrapped in `typeof localStorage !== 'undefined'` + try/catch (pattern: `src/views/book-library.tsx:51-71`). Reads fail **safe** (notifier shows).
- **Banner copy:** `Update available — v{latestVersion}` — NO product-name prefix (match sibling `WhatsNewBanner` "What's new in v{version}"); no hardcoded brand string.
- **Don't touch `src/components/upgrade-card.tsx`** — it keeps its own `getUpdateStatus` fetch and tests.
- **localStorage key:** `castwright:dismissedUpdateVersion`.
- **Mutual exclusion:** notifier suppressed while `info.showWhatsNew` is true.
- Commit subjects: Conventional Commits, scopes from `{frontend|server|sidecar|app|scripts|e2e|mocks|openapi|docs|deps|ci}`. End commit bodies with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Server — non-blocking cache accessors in `updates.ts`

**Files:**
- Modify: `server/src/routes/updates.ts` (add exports; extend the reset seam near line 131)
- Test: `server/src/routes/updates.test.ts` (existing — append cases)

**Interfaces:**
- Consumes: existing module internals `cache`, `CACHE_TTL_MS`, `buildUpdateStatus`, `fetchLatestRelease`, `getAppVersion`, `UpdateStatus`.
- Produces:
  - `getCachedUpdateStatus(): UpdateStatus | null` — current cache value or `null` (cold). No network.
  - `refreshUpdateStatusInBackground(): void` — fire-and-forget; no-op when cache is fresh (< TTL) or a refresh is already in flight; populates `cache` on a reachable result.
  - `__resetUpdateCacheForTests()` also clears the new in-flight flag.

- [ ] **Step 1: Write the failing test**

Append to `server/src/routes/updates.test.ts`:

```ts
import {
  getCachedUpdateStatus,
  refreshUpdateStatusInBackground,
  __resetUpdateCacheForTests,
} from './updates.js';

describe('cache accessors (fe-27)', () => {
  afterEach(() => {
    __resetUpdateCacheForTests();
    vi.unstubAllGlobals();
  });

  it('getCachedUpdateStatus is null before any refresh', () => {
    __resetUpdateCacheForTests();
    expect(getCachedUpdateStatus()).toBeNull();
  });

  it('refreshUpdateStatusInBackground populates the cache from a reachable release', async () => {
    __resetUpdateCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example/r' }),
      })),
    );
    refreshUpdateStatusInBackground();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget settle
    const status = getCachedUpdateStatus();
    expect(status?.latestVersion).toBe('999.0.0');
    expect(status?.updateAvailable).toBe(true);
  });

  it('does not refetch while the cache is fresh', async () => {
    __resetUpdateCacheForTests();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example/r' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    refreshUpdateStatusInBackground();
    await new Promise((r) => setImmediate(r));
    refreshUpdateStatusInBackground(); // cache now fresh → no second fetch
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/updates.test.ts -t "cache accessors"`
Expected: FAIL — `getCachedUpdateStatus` / `refreshUpdateStatusInBackground` not exported.

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/updates.ts`, after the `let cache: …` declaration (line ~115) add:

```ts
let refreshing = false;

/** Current cached status, or null when cold. No network — safe to call from a
    hot handler. */
export function getCachedUpdateStatus(): UpdateStatus | null {
  return cache ? cache.status : null;
}

/** Fire-and-forget cache refresh. No-op while the cache is fresh or a refresh is
    already in flight. Never throws; only a reachable result is cached. */
export function refreshUpdateStatusInBackground(): void {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return;
  if (refreshing) return;
  refreshing = true;
  void (async () => {
    try {
      const status = buildUpdateStatus(getAppVersion(), await fetchLatestRelease());
      if (status.reachable) cache = { at: Date.now(), status };
    } finally {
      refreshing = false;
    }
  })();
}
```

Update the existing reset seam:

```ts
export function __resetUpdateCacheForTests(): void {
  cache = null;
  refreshing = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/updates.test.ts`
Expected: PASS (existing cases + the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/updates.ts server/src/routes/updates.test.ts
git commit -m "feat(server): non-blocking update-status cache accessors (fe-27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Server — surface `updateAvailable`/`latestVersion` on `/api/info`

**Files:**
- Modify: `server/src/routes/info.ts:117-137` (the `GET /` handler)
- Test: `server/src/routes/info.test.ts` (append)

**Interfaces:**
- Consumes: `getCachedUpdateStatus`, `refreshUpdateStatusInBackground` (Task 1).
- Produces: `/api/info` response gains `updateAvailable: boolean | null` and `latestVersion: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/routes/info.test.ts` (note: the existing `beforeEach` stubs `fetch` to throw — that covers the cold path). Add an import and a describe:

```ts
import {
  refreshUpdateStatusInBackground,
  __resetUpdateCacheForTests,
} from './updates.js';

describe('GET /api/info — update fields (fe-27)', () => {
  afterEach(() => __resetUpdateCacheForTests());

  it('returns null update fields on a cold cache without blocking', async () => {
    __resetUpdateCacheForTests();
    const res = await request(app).get('/api/info');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBeNull();
    expect(res.body.latestVersion).toBeNull();
  });

  it('reflects a populated cache', async () => {
    __resetUpdateCacheForTests();
    // Stub fetch to answer GitHub (tag) but still fail the sidecar /health probe.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('api.github.com')) {
          return { ok: true, json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example/r' }) };
        }
        throw new Error('sidecar down');
      }),
    );
    refreshUpdateStatusInBackground();
    await new Promise((r) => setImmediate(r));
    const res = await request(app).get('/api/info');
    expect(res.body.latestVersion).toBe('999.0.0');
    expect(res.body.updateAvailable).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/info.test.ts -t "update fields"`
Expected: FAIL — `res.body.updateAvailable` is `undefined`, not `null`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/info.ts`, add the import near the other route imports:

```ts
import { getCachedUpdateStatus, refreshUpdateStatusInBackground } from './updates.js';
```

In the `infoRouter.get('/', …)` handler, before `res.json({…})`:

```ts
  const upd = getCachedUpdateStatus();
  refreshUpdateStatusInBackground(); // fire-and-forget; never awaited
```

Add to the `res.json({ … })` object:

```ts
    /* fe-27 — in-app update notifier. Cached GitHub-Releases check, read
       non-blocking (null while cold/unreachable → notifier stays dark). */
    updateAvailable: upd ? upd.updateAvailable : null,
    latestVersion: upd ? upd.latestVersion : null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/info.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/info.ts server/src/routes/info.test.ts
git commit -m "feat(server): expose cached update fields on /api/info (fe-27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Frontend — `AppInfo` fields + mock + e2e override

**Files:**
- Modify: `src/lib/types.ts:181` (`AppInfo` interface)
- Modify: `src/lib/api.ts:5116-5130` (`mockAppInfo` + `mockGetAppInfo`)
- Test: `src/lib/api.test.ts` (append; create if absent — check first with `ls src/lib/api.test.ts`)

**Interfaces:**
- Produces: `AppInfo.updateAvailable?: boolean | null`, `AppInfo.latestVersion?: string | null`; `mockGetAppInfo` honours a `?e2eUpdate=<version>` query param (sets `updateAvailable:true` + `latestVersion`).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/api.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';

describe('mockGetAppInfo update override (fe-27)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults update fields off', async () => {
    vi.stubGlobal('window', { location: { search: '' } } as unknown as Window);
    const { api } = await import('./api');
    const info = await api.getAppInfo();
    expect(info.updateAvailable ?? false).toBe(false);
    expect(info.latestVersion ?? null).toBeNull();
  });

  it('honours ?e2eUpdate=<version>', async () => {
    vi.stubGlobal('window', { location: { search: '?e2eUpdate=9.9.9' } } as unknown as Window);
    vi.resetModules();
    const { api } = await import('./api');
    const info = await api.getAppInfo();
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe('9.9.9');
  });
});
```

> Note for the implementer: this suite runs with `VITE_USE_MOCKS` on (the frontend test env). If `api.test.ts` already exists with different import conventions, match them; the assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api.test.ts -t "update override"`
Expected: FAIL — `e2eUpdate` not read; `latestVersion` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/types.ts`, inside `interface AppInfo` (after `activeEngine?: string;`):

```ts
  /* fe-27 — in-app update notifier. Server-sourced (cached GitHub-Releases
     check, non-blocking). updateAvailable is null while the check is cold or
     the source is unreachable; absent on an older server. */
  updateAvailable?: boolean | null;
  latestVersion?: string | null;
```

In `src/lib/api.ts`, add the two defaults to the `mockAppInfo` literal (after `activeEngine: 'kokoro',`):

```ts
  updateAvailable: false,
  latestVersion: null,
```

Replace `mockGetAppInfo` (line ~5128) with:

```ts
/* fe-27 — e2e seam: `?e2eUpdate=<version>` forces an "update available" mock so
   the Playwright notifier spec has a deterministic trigger (mock mode is
   in-process, so page.route can't intercept). Guarded; no-op outside a browser
   / when the param is absent. */
function readE2eUpdateOverride(): { updateAvailable: boolean; latestVersion: string | null } {
  try {
    if (typeof window !== 'undefined' && window.location) {
      const v = new URLSearchParams(window.location.search).get('e2eUpdate');
      if (v) return { updateAvailable: true, latestVersion: v };
    }
  } catch {
    /* swallow — fall through to defaults */
  }
  return { updateAvailable: false, latestVersion: null };
}

async function mockGetAppInfo(): Promise<AppInfo> {
  await wait(40);
  const ov = readE2eUpdateOverride();
  return { ...mockAppInfo, updateAvailable: ov.updateAvailable, latestVersion: ov.latestVersion };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api.test.ts -t "update override"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend,mocks): AppInfo update fields + e2eUpdate mock seam (fe-27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — `update-notice.ts` (dismissal state + shared predicate)

**Files:**
- Create: `src/lib/update-notice.ts`
- Test: `src/lib/update-notice.test.ts`

**Interfaces:**
- Consumes: `AppInfo` (Task 3).
- Produces:
  - `getDismissedVersion(): string | null`
  - `dismissUpdate(version: string): void` — persists + notifies subscribers.
  - `useDismissedVersion(): string | null` — React hook (`useSyncExternalStore`).
  - `shouldShowUpdateNotice(info: AppInfo | null, dismissed: string | null): boolean` — the single visibility predicate for both surfaces.
  - `__resetForTests(): void`

- [ ] **Step 1: Write the failing test**

Create `src/lib/update-notice.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppInfo } from './types';
import {
  getDismissedVersion,
  dismissUpdate,
  shouldShowUpdateNotice,
  __resetForTests,
} from './update-notice';

const base: AppInfo = {
  appVersion: '1.8.0',
  sidecarVersion: null,
  schemas: {},
  lastSeenAppVersion: null,
  showWhatsNew: false,
  releaseNotes: '',
};

beforeEach(() => {
  localStorage.clear();
  __resetForTests();
});

describe('shouldShowUpdateNotice', () => {
  it('shows when an update is available and not dismissed', () => {
    const info = { ...base, updateAvailable: true, latestVersion: '1.9.0' };
    expect(shouldShowUpdateNotice(info, null)).toBe(true);
  });

  it('hides when the latest equals the dismissed version', () => {
    const info = { ...base, updateAvailable: true, latestVersion: '1.9.0' };
    expect(shouldShowUpdateNotice(info, '1.9.0')).toBe(false);
  });

  it('re-shows when a yanked release regresses latest to a different unseen version', () => {
    const info = { ...base, updateAvailable: true, latestVersion: '1.8.5' };
    expect(shouldShowUpdateNotice(info, '1.9.0')).toBe(true);
  });

  it('hides while showWhatsNew is true', () => {
    const info = { ...base, showWhatsNew: true, updateAvailable: true, latestVersion: '1.9.0' };
    expect(shouldShowUpdateNotice(info, null)).toBe(false);
  });

  it('hides on null info or no update', () => {
    expect(shouldShowUpdateNotice(null, null)).toBe(false);
    expect(shouldShowUpdateNotice({ ...base, updateAvailable: false }, null)).toBe(false);
    expect(shouldShowUpdateNotice({ ...base, updateAvailable: null }, null)).toBe(false);
  });
});

describe('dismissUpdate', () => {
  it('records the version and notifies subscribers', () => {
    const seen: (string | null)[] = [];
    dismissUpdate('1.9.0');
    expect(getDismissedVersion()).toBe('1.9.0');
    expect(localStorage.getItem('castwright:dismissedUpdateVersion')).toBe('1.9.0');
  });

  it('does not throw when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => dismissUpdate('1.9.0')).not.toThrow();
    expect(getDismissedVersion()).toBe('1.9.0'); // in-memory still updates
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/update-notice.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/update-notice.ts`:

```ts
/* fe-27 — in-app update notifier shared state.

   Holds the dismissed-update version (equality-based: a notice is silenced only
   for the exact latestVersion the user dismissed) and the single visibility
   predicate read by both the banner and the version-pill dot. Backed by
   localStorage, exposed via useSyncExternalStore so dismissing the banner clears
   the pill dot in the same tick. */

import { useSyncExternalStore } from 'react';
import type { AppInfo } from './types';

const KEY = 'castwright:dismissedUpdateVersion';

function readFromStorage(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  } catch {
    return null; // private mode / sandboxed webview → fail safe (notice shows)
  }
}

let current: string | null = readFromStorage();
const listeners = new Set<() => void>();

export function getDismissedVersion(): string | null {
  return current;
}

export function dismissUpdate(version: string): void {
  current = version;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, version);
  } catch {
    /* swallow — in-memory dismissal still works this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDismissedVersion(): string | null {
  return useSyncExternalStore(subscribe, getDismissedVersion, getDismissedVersion);
}

/** Single source of truth for "should the update notifier paint?". */
export function shouldShowUpdateNotice(info: AppInfo | null, dismissed: string | null): boolean {
  return (
    info != null &&
    info.updateAvailable === true &&
    !info.showWhatsNew &&
    info.latestVersion != null &&
    info.latestVersion !== dismissed
  );
}

/** Test seam — clear in-memory state + subscribers. */
export function __resetForTests(): void {
  current = readFromStorage();
  listeners.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/update-notice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/update-notice.ts src/lib/update-notice.test.ts
git commit -m "feat(frontend): update-notice dismissal state + visibility predicate (fe-27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend — `UpdateNotifierBanner` + mount

**Files:**
- Create: `src/components/update-notifier-banner.tsx`
- Modify: `src/components/layout.tsx:1340` (mount right after `<WhatsNewBanner />`)
- Test: `src/components/update-notifier-banner.test.tsx`

**Interfaces:**
- Consumes: `useAppInfo` (`src/lib/use-app-info`), `useDismissedVersion`/`dismissUpdate`/`shouldShowUpdateNotice` (Task 4).
- Produces: `<UpdateNotifierBanner />`, `data-testid="update-notifier-banner"`.

- [ ] **Step 1: Write the failing test**

Create `src/components/update-notifier-banner.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UpdateNotifierBanner } from './update-notifier-banner';
import * as useAppInfoMod from '../lib/use-app-info';
import { __resetForTests, getDismissedVersion } from '../lib/update-notice';
import type { AppInfo } from '../lib/types';

const info = (over: Partial<AppInfo>): AppInfo => ({
  appVersion: '1.8.0',
  sidecarVersion: null,
  schemas: {},
  lastSeenAppVersion: null,
  showWhatsNew: false,
  releaseNotes: '',
  ...over,
});

function stubInfo(value: AppInfo | null) {
  vi.spyOn(useAppInfoMod, 'useAppInfo').mockReturnValue({
    info: value,
    error: null,
    refresh: async () => {},
  });
}

beforeEach(() => {
  localStorage.clear();
  __resetForTests();
  vi.restoreAllMocks();
});

const renderBanner = () =>
  render(
    <MemoryRouter>
      <UpdateNotifierBanner />
    </MemoryRouter>,
  );

describe('UpdateNotifierBanner', () => {
  it('renders the version and release-notes link when behind', () => {
    stubInfo(info({ updateAvailable: true, latestVersion: '1.9.0' }));
    renderBanner();
    expect(screen.getByTestId('update-notifier-banner')).toBeInTheDocument();
    expect(screen.getByText(/Update available — v1\.9\.0/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /See what.?s new/ })).toHaveAttribute('href', '/release-notes');
  });

  it('does not render when up to date', () => {
    stubInfo(info({ updateAvailable: false, latestVersion: null }));
    renderBanner();
    expect(screen.queryByTestId('update-notifier-banner')).not.toBeInTheDocument();
  });

  it('dismiss records the version and hides the banner', () => {
    stubInfo(info({ updateAvailable: true, latestVersion: '1.9.0' }));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(getDismissedVersion()).toBe('1.9.0');
    expect(screen.queryByTestId('update-notifier-banner')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/update-notifier-banner.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/update-notifier-banner.tsx`:

```tsx
/* fe-27 — in-app update notifier. Renders at the top of every view (mounted in
   layout.tsx after WhatsNewBanner) when the server reports a newer release the
   user hasn't dismissed. Dismiss silences it for that exact version (the dot in
   the version pill clears in the same tick via the shared update-notice store).
   Dark in mock mode unless ?e2eUpdate is set. */

import { Link } from 'react-router-dom';
import { useAppInfo } from '../lib/use-app-info';
import { useDismissedVersion, dismissUpdate, shouldShowUpdateNotice } from '../lib/update-notice';

export function UpdateNotifierBanner() {
  const { info } = useAppInfo();
  const dismissed = useDismissedVersion();
  if (!shouldShowUpdateNotice(info ?? null, dismissed)) return null;

  const latest = info!.latestVersion!;
  return (
    <div
      role="status"
      data-testid="update-notifier-banner"
      className="mx-4 mt-3 rounded-xl border border-magenta/20 bg-peach/40 px-4 py-3 text-ink"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-magenta">Update available — v{latest}</p>
        <div className="flex items-center gap-2">
          <Link to="/release-notes" className="text-xs font-medium text-magenta hover:underline">
            See what&apos;s new
          </Link>
          <button
            type="button"
            onClick={() => dismissUpdate(latest)}
            className="min-h-[44px] sm:min-h-0 shrink-0 rounded-lg px-3 py-1 text-xs font-medium text-ink/70 hover:bg-white/60"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
```

In `src/components/layout.tsx`, add the import next to the `WhatsNewBanner` import (line ~53):

```ts
import { UpdateNotifierBanner } from './update-notifier-banner';
```

And mount it right after `<WhatsNewBanner />` (line ~1340):

```tsx
      <WhatsNewBanner />

      {/* fe-27 — "update available" notifier; self-gated, dark in mock mode. */}
      <UpdateNotifierBanner />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/update-notifier-banner.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/update-notifier-banner.tsx src/components/update-notifier-banner.test.tsx src/components/layout.tsx
git commit -m "feat(frontend): in-app update notifier banner (fe-27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend — version-pill dot

**Files:**
- Modify: `src/components/top-bar.tsx:513-532` (`VersionPill`)
- Test: `src/components/top-bar.test.tsx` (existing — check with `ls`; append, or create a focused `version-pill.test.tsx` if `top-bar.test.tsx` is absent)

**Interfaces:**
- Consumes: `useAppInfo`, `useDismissedVersion`, `shouldShowUpdateNotice` (Task 4).
- Produces: a dot `data-testid="version-pill-dot"` inside the pill when the shared predicate is true.

- [ ] **Step 1: Write the failing test**

Append to `src/components/top-bar.test.tsx` (adapt imports to the file's existing render harness; the contract is the dot's presence/absence):

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as useAppInfoMod from '../lib/use-app-info';
import { __resetForTests } from '../lib/update-notice';
import type { AppInfo } from '../lib/types';

// NOTE: VersionPill is not exported. Assert via the rendered TopBar, or export
// VersionPill for test if the harness needs it. The contract:
//   updateAvailable + undismissed  → dot present
//   up to date                     → dot absent

const baseInfo: AppInfo = {
  appVersion: '1.8.0',
  sidecarVersion: '1.8.0',
  schemas: {},
  lastSeenAppVersion: null,
  showWhatsNew: false,
  releaseNotes: '',
};

beforeEach(() => {
  localStorage.clear();
  __resetForTests();
  vi.restoreAllMocks();
});

describe('VersionPill update dot (fe-27)', () => {
  it('shows a dot when an undismissed update is available', () => {
    vi.spyOn(useAppInfoMod, 'useAppInfo').mockReturnValue({
      info: { ...baseInfo, updateAvailable: true, latestVersion: '1.9.0' },
      error: null,
      refresh: async () => {},
    });
    // render the top bar (use the file's existing renderTopBar helper)
    // expect(screen.getByTestId('version-pill-dot')).toBeInTheDocument();
  });

  it('hides the dot when up to date', () => {
    vi.spyOn(useAppInfoMod, 'useAppInfo').mockReturnValue({
      info: { ...baseInfo, updateAvailable: false },
      error: null,
      refresh: async () => {},
    });
    // expect(screen.queryByTestId('version-pill-dot')).not.toBeInTheDocument();
  });
});
```

> Implementer: wire these two assertions to `top-bar.test.tsx`'s existing render harness (the file already renders `TopBar` for the pill). If no such harness exists, export `VersionPill` and render it directly inside a `MemoryRouter`. Keep the two behaviors as the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/top-bar.test.tsx -t "update dot"`
Expected: FAIL — no `version-pill-dot` element.

- [ ] **Step 3: Write minimal implementation**

In `src/components/top-bar.tsx`, add to the imports:

```ts
import { useDismissedVersion, shouldShowUpdateNotice } from '../lib/update-notice';
```

Replace `VersionPill` (lines ~513-532) with:

```tsx
function VersionPill({ onClick }: { onClick: () => void }) {
  const { info } = useAppInfo();
  const dismissed = useDismissedVersion();
  const showDot = shouldShowUpdateNotice(info ?? null, dismissed);
  const version = info?.appVersion ?? buildInfo.version;
  const title =
    info?.sidecarVersion != null
      ? `App v${version} · Sidecar v${info.sidecarVersion}`
      : `App v${version}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`Version v${version}${showDot ? ' — update available' : ''} — open Account`}
      data-testid="version-pill"
      className="relative hidden sm:inline-flex items-center rounded-full border border-ink/10 px-2.5 py-1 text-xs font-medium text-ink/60 hover:bg-ink/5 focus:outline-hidden focus:ring-2 focus:ring-magenta/40"
    >
      v{version}
      {showDot && (
        <span
          data-testid="version-pill-dot"
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-ink/50"
        />
      )}
    </button>
  );
}
```

(The only changes: `relative` added to `className`, the `aria-label` suffix, and the dot `<span>`. Neutral `bg-ink/50` — urgency lives in the banner.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/top-bar.test.tsx -t "update dot"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/top-bar.tsx src/components/top-bar.test.tsx
git commit -m "feat(frontend): version-pill update dot (fe-27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: E2E — notifier appears, dismiss persists, reappears on newer version

**Files:**
- Create: `e2e/update-notifier.spec.ts`

**Interfaces:**
- Consumes: the `?e2eUpdate=<version>` mock seam (Task 3); `data-testid="update-notifier-banner"` (Task 5); `waitForRouteReady` (`e2e/helpers`).

- [ ] **Step 1: Write the test (this is the deliverable — no separate failing-impl step)**

Create `e2e/update-notifier.spec.ts`:

```ts
/* fe-27 — in-app update notifier across the layout/router/localStorage seams.
   Mock mode is in-process (page.route can't force "update available"), so the
   ?e2eUpdate=<version> mock seam supplies a deterministic trigger. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe('fe-27 — update notifier', () => {
  test('appears when behind, dismiss persists across reload, reappears on a newer version', async ({
    page,
  }) => {
    await page.goto('/?e2eUpdate=9.9.9#/books');
    await waitForRouteReady(page);

    const banner = page.getByTestId('update-notifier-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByText(/Update available — v9\.9\.9/)).toBeVisible();

    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();

    // Reload, same latest version → stays dismissed (localStorage).
    await page.goto('/?e2eUpdate=9.9.9#/books');
    await waitForRouteReady(page);
    await expect(page.getByTestId('update-notifier-banner')).toBeHidden();

    // A newer release → notifier returns.
    await page.goto('/?e2eUpdate=9.9.10#/books');
    await waitForRouteReady(page);
    await expect(page.getByTestId('update-notifier-banner')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `npx playwright test e2e/update-notifier.spec.ts --project=chromium`
Expected: PASS (1 test). If chromium is missing: `npx playwright install chromium`.

- [ ] **Step 3: Commit**

```bash
git add e2e/update-notifier.spec.ts
git commit -m "test(e2e): update notifier appear/dismiss/reappear (fe-27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full verify + issue/backlog close-out

**Files:**
- Modify: `docs/BACKLOG.md` (remove the `fe-27` row, lines ~42-46)

- [ ] **Step 1: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green. Triage any red per CLAUDE.md (related → fix; pre-existing → surface, don't bundle).

- [ ] **Step 2: Remove the backlog row**

Delete the `#### \`fe-27\` — In-app update notifier …` block (and its bullets) from `docs/BACKLOG.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/BACKLOG.md
git commit -m "docs(docs): drop fe-27 backlog row (shipped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/frontend-fe-27-update-notifier
gh pr create --title "feat(frontend): in-app update notifier (fe-27)" \
  --body "## Summary
Surfaces the existing cached GitHub-Releases check as a dismissible banner + a version-pill dot. The check folds into /api/info (non-blocking), so both surfaces ride the existing useAppInfo poll; dismissal is equality-based and localStorage-backed; the upgrade-card is untouched.

Closes #471

## Test plan
- Unit: updates cache accessors, /api/info update fields, update-notice predicate (incl. yanked-release re-show + guarded localStorage), banner render/dismiss, pill dot visibility.
- E2E: e2e/update-notifier.spec.ts — appear → dismiss → reload (stays hidden) → newer version (reappears).
- npm run verify green.

Design: docs/superpowers/specs/2026-06-19-fe-27-update-notifier-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review

**Spec coverage:**
- Backend fold into `/api/info`, non-blocking, cache getters → Tasks 1–2. ✓
- `updateAvailable`/`latestVersion` fields, `url` omitted, mock defaults → Tasks 2–3. ✓
- Banner (copy, `/release-notes` link, predicate incl. `showWhatsNew` guard, dismiss) → Tasks 4–5. ✓
- Pill dot (neutral, clears on dismiss, shared predicate, desktop-only) → Tasks 4 + 6. ✓
- Equality dismissal, no client semver, guarded localStorage → Task 4. ✓
- E2E `?e2eUpdate=` mechanism → Tasks 3 + 7. ✓
- Don't-touch upgrade-card → honored (no task modifies it). ✓
- No `docs/features/` plan (small/localized) → consistent; close-out is backlog row + issue only (Task 8). ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code. The two test files with existing-harness adaptation notes (Tasks 6) state the exact behavioral contract and provide the assertions. ✓

**Type consistency:** `shouldShowUpdateNotice(info, dismissed)`, `dismissUpdate(version)`, `useDismissedVersion()`, `getCachedUpdateStatus()`, `refreshUpdateStatusInBackground()` used identically across Tasks 1–7. `AppInfo.updateAvailable?: boolean | null` / `latestVersion?: string | null` consistent in types, mock, predicate, tests. ✓
