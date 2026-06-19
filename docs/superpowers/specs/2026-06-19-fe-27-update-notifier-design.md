# fe-27 — In-app update notifier (design)

- **Date:** 2026-06-19
- **Issue:** [#471](https://github.com/dudarenok-maker/AudioBook-Generator/issues/471) (`fe-27`, `area:fe`, `moscow:must`)
- **Status:** approved (brainstorm) — ready for an implementation plan
- **Branch:** `feat/frontend-fe-27-update-notifier`

## Problem

The app can already tell when a newer release exists, but the only place that
shows is **inside the Account view**. A tester has to navigate there to find
out. The issue's own framing: _"this is the **prompt** that tells the user to
upgrade."_ There is no globally-visible, dismissible prompt. fe-27 supplies it.

## What already exists (no change)

- `GET /api/updates/latest` (`server/src/routes/updates.ts`) — queries GitHub
  Releases via the server proxy, **fail-open** (`reachable:false` on
  private-repo / offline / rate-limit, never throws), **1h cache**, semver
  compare, fully unit-tested. Mounted at `app.ts:125`.
- `api.getUpdateStatus()` → `{ reachable, currentVersion, latestVersion, updateAvailable, url }`.
- Account → Application-updates card (`src/components/upgrade-card.tsx`) shows
  "Update available: vX.Y.Z · View release" / "You're up to date", plus the
  apply flow. **Left untouched** — keeps its own inline `getUpdateStatus` fetch
  and its tests.

## Scope

Surface the existing update signal as a globally-visible, **dismissible** prompt
on two surfaces, with dismissal that lasts until the next release. One small
non-blocking server field; two additive frontend pieces. No refactor of working
code.

## Design

### 1. Backend — fold the cached check into `/api/info` (non-blocking)

`useAppInfo` (`src/lib/use-app-info.ts`) already polls `/api/info` every 30s and
is **already consumed by both target surfaces** (the version pill and the
what's-new banner). Riding it means no new client hook, no new fetch, and a
mid-session release is noticed on the next poll — for free.

- Expose from `updates.ts`:
  - `getCachedUpdateStatus(): UpdateStatus | null` — returns the current cache
    value (or `null` when cold), **no network**.
  - `refreshUpdateStatusInBackground(): void` — fire-and-forget; honours the
    existing 1h TTL; populates the cache. Never awaited by a request.
- `info.ts` (`GET /api/info`) reads `getCachedUpdateStatus()` synchronously and
  calls `refreshUpdateStatusInBackground()`. **It never awaits the GitHub call**,
  so the hot, 30s-polled endpoint never stalls (contrast: a blocking check would
  add up to 4s to the first request each hour). On a cold cache the first
  response carries `updateAvailable: null`; the next poll fills it in.
- Payload gains `updateAvailable: boolean | null` and `latestVersion: string |
  null`. **`url` is intentionally omitted** — the banner links in-app to
  `/release-notes`, and the Account card already reads `url` from its own route.
- `AppInfo` (`src/lib/types.ts`) gains the two fields; `mockGetAppInfo` /
  `mockAppInfo` (`src/lib/api.ts`) default them to `false` / `null` (no phantom
  notifier in mock mode), with the e2e override below.

### 2. Frontend — `UpdateNotifierBanner`

- New `src/components/update-notifier-banner.tsx`, mounted in `layout.tsx`
  **immediately after `<WhatsNewBanner/>`**.
- Reads `useAppInfo()` and the dismissed version from `localStorage`.
- **Visibility predicate (shared with the dot):**
  ```
  show = info.updateAvailable === true
      && !info.showWhatsNew          // never stack with the post-upgrade banner
      && info.latestVersion !== dismissedVersion
  ```
  The `showWhatsNew` guard closes the "upgraded to v1.9 while v1.10 is out" edge
  where both peach banners would otherwise paint together.
- Visual: mirror `WhatsNewBanner` (peach/magenta rounded banner, `role="status"`,
  44px-min dismiss button).
- Copy: **"Update available — v{latestVersion}"** (no product-name prefix — match
  the sibling `WhatsNewBanner`'s "What's new in v{version}", so no hardcoded
  brand string) + a "See what's new" link → `/release-notes` (in-app,
  private-repo-safe, brand-consistent).
- **Dismiss** writes `latestVersion` to `localStorage` key
  `castwright:dismissedUpdateVersion`.

### 3. Frontend — pill dot

- Augment `VersionPill` (`src/components/top-bar.tsx`): a small **neutral
  ink-tone** dot (urgency lives in the banner, not here) when the **same
  predicate** is true. The dot therefore **clears on dismiss** alongside the
  banner.
- `aria-label` gains "— update available". Click still opens Account (the apply
  flow). The pill is `hidden sm:inline-flex`, so the dot is desktop-only; phone
  testers are covered by the full-width banner.
- Rationale for keeping the dot despite sharing the banner's lifecycle: it is the
  **click-target into the apply flow** (the banner only links to release notes).

### 4. Dismissal semantics

- **Equality, not semver comparison.** Hide only when `latestVersion ===
  dismissedVersion`. This re-shows correctly if a release is yanked and `latest`
  regresses to an older-but-unseen version — and needs **zero** client-side
  semver code. `isVersionNewer` is **not** implemented (avoids duplicating the
  server's `compareSemver` and the divergence trap).
- **Guarded `localStorage`** — reuse the `src/views/book-library.tsx` pattern
  (`typeof localStorage !== 'undefined'` + try/catch). Writes that throw
  (private mode / sandboxed webview / quota) are swallowed; a garbage or missing
  read value fails **safe** (banner shows). Dismiss never breaks.
- **Cross-tab:** not propagated (the `BroadcastChannel` middleware is scoped to
  analysis/chapters and does not widen). Dismiss in tab A leaves tab B showing
  until reload. Acceptable for an S item; explicitly out of scope.

## Testing

- **Unit (frontend):**
  - Banner predicate: shows when behind; hidden when `latestVersion ===
    dismissedVersion`; **re-shows on a yank** (`latest` regresses to a value `!==`
    the dismissed one); hidden while `showWhatsNew`.
  - Dismiss writes the version to `localStorage`; a throwing `localStorage` does
    not break the dismiss handler; malformed/absent value → banner shows.
  - Pill dot visibility tracks the shared predicate (clears on dismiss).
- **Unit (server):** `info.ts` includes `updateAvailable` / `latestVersion` from
  `getCachedUpdateStatus()`; the handler does **not** await the GitHub fetch
  (cold cache → `null`, no stall); `refreshUpdateStatusInBackground` respects the
  TTL. Reuse the existing `__resetUpdateCacheForTests` seam between cases.
- **E2E (one Playwright spec) — mechanism decided here, not deferred:** mock mode
  returns `updateAvailable:false` and is in-process (so `page.route` can't force
  it). Add a **`?e2eUpdate=<version>` query-param** read in the mock `/api/info`
  path (`mockGetAppInfo`): when present, set `updateAvailable:true` +
  `latestVersion=<version>`. Spec: navigate with the param → banner appears →
  Dismiss → reload (param still set) → banner stays hidden (localStorage) → bump
  the param to a newer version → banner reappears.

## Out of scope

- Refactoring `upgrade-card.tsx` onto a shared hook (working, tested; the
  duplicate fetch both hit the 1h server cache — no real cost).
- Periodic/focus re-checks beyond the inherited 30s `useAppInfo` poll.
- Cross-tab dismissal sync.
- A `docs/features/` regression plan — per CLAUDE.md, this small/localized,
  frontend-only item rides on the issue + paired tests; this spec is the design
  of record. (The layout/router seam earns the e2e test above, not a plan doc.)

## Decisions on the record

- **Both surfaces** (banner + dot), dot **clears on dismiss** (user choice
  2026-06-19).
- **Fold into `/api/info`** rather than a new `useUpdateStatus` hook — chosen
  after three independent adversarial passes flagged that `useAppInfo` is not
  memoized, so a "shared hook" would not dedupe and would add a new pattern.
