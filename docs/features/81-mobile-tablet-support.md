---
status: draft
shipped: null
owner: null
---

# Mobile + tablet support (LAN-accessible over HTTPS)

> Status: draft (round in progress; six waves)
> Key files: `vite.config.ts`, `server/src/index.ts`, `playwright.config.ts`, `src/components/layout.tsx`, `src/views/{manuscript,cast,listen,confirm-cast,generation,upload,books}.tsx`, `src/components/listen/*.tsx`, `src/components/voice-library-panel.tsx`, `src/components/mini-player.tsx`, `src/modals/`, `index.html`, `tailwind.config.ts`, `package.json`, `scripts/print-cert-install-instructions.mjs` (new), `docs/BACKLOG.md`, `docs/features/INDEX.md`, `CLAUDE.md`.
> URL surface: indirect — every existing view + a new `GET /api/lan-urls` debug endpoint + a new `GET /cert/root.crt` static route on the Node server.
> OpenAPI ops: net-new `GET /api/lan-urls` (returns `{ urls: string[] }`). Existing ops unchanged.

## Benefit / Rationale

- **User:** the whole app becomes usable from a phone or tablet on the same LAN as the dev box. Drive the cast on a tablet, edit a chapter on the couch, listen on the phone, all over `https://<lan-ip>:8443` with no "Not Secure" warning.
- **Technical:** Playwright gains mobile + tablet projects so every future PR's e2e gate enforces no horizontal-scroll + visual-snapshot regression at three viewports, not one.
- **Architectural:** establishes the responsive breakpoint contract (`<640` mobile, `640–1024` tablet, `1024+` desktop) and the touch-equivalence rule (every desktop drag/hover affordance lists its tap replacement). Future view work has a fixed rule to follow rather than rediscovering at each component.

## Architectural impact

**New seams / extension points:**

- `LAN_HTTPS=1` env flag on the Node server flips `http.createServer` → `https.createServer` with mkcert-generated certs from the OS-default mkcert location.
- `GET /api/lan-urls` returns the same list `enumerateLanUrls` already logs at startup.
- `GET /cert/root.crt` (public read) streams the mkcert root CA so phones can download + trust it.
- `vite-plugin-mkcert` plugged into `vite.config.ts`; auto-installs the local root CA on first run, generates per-host certs covering `localhost` + every LAN IP.
- Three new `package.json` scripts: `dev:lan`, `start:lan`, `install:cert-mobile`.
- Playwright `projects` array extends from one to three: `chromium`, `mobile-chrome` (Pixel 7), `tablet-chrome` (iPad Pro 11).
- New Tailwind responsive utility conventions: every layout-containing view declares `sm:` / `md:` / `lg:` variants instead of single-width assumptions.
- New "tap-to-assign" affordance on cast voice library (parallel path alongside drag-and-drop, not a replacement).
- New tap-revealed "Split here" / "Merge with above" buttons on manuscript paragraph boundaries (parallel path alongside boundary drag).

**Invariants preserved:**

- **OpenAPI source of truth (`24-openapi-source-of-truth.md`).** `GET /api/lan-urls` is added to `openapi.yaml` before the route lands; types come from generated `api-types.ts`.
- **Design tokens (`25-design-tokens.md`).** No new hex literals; responsive padding / margin uses existing CSS-variable-backed Tailwind classes.
- **RTK Immer (`26-rtk-immer.md`).** Tap-to-assign state in cast view mutates via Immer drafts in the existing cast slice; no spread rewrites.
- **Concurrent multi-book invariant ([[project_concurrent_multibook_workflow]]).** Mobile chrome still surfaces global generation + analysis pills regardless of which book's view is active. Top-bar overflow on `<md:` must keep the active-stream pills visible (in the overflow menu, not dropped).
- **Mock toggle (`23-mock-toggle.md`).** New `/api/lan-urls` endpoint also has a mock implementation in `src/mocks/` that returns `['https://example-lan-ip:8443']` so e2e specs work in mock mode without the real Node server.
- **Dark mode (`archive/42-dark-mode.md`).** Every new responsive component honours `[data-theme="dark"]` token overrides — no light-only hex.

**Migration story:**

- No state.json / cast.json shape change. Pure code + tooling addition.
- mkcert root CA is per-dev-box; if a user already has mkcert installed, this round respects it.
- Mobile devices need a one-time root CA install (documented per-OS in this plan). Devices that skip it get the standard browser self-signed warning; they can dismiss-once and proceed.

**Reversibility:**

- Per-wave PRs are revertable. Wave 1 (LAN + HTTPS) is the only wave with new server-side state (the cert files + the new env flag); reverting it cleanly returns to HTTP-only loopback dev + HTTP all-interfaces production.
- Per-view responsive changes in Wave 3 are CSS-only at the boundary — reverting any single view's PR restores its desktop-only layout.

## Invariants to preserve

1. **`enumerateLanUrls` already binds all interfaces in production** — `server/src/index.ts:183` calls `app.listen(PORT)` with no host arg; do not narrow this to `127.0.0.1` even when adding HTTPS support. The HTTPS variant must also bind `::` (all interfaces) at `server/src/index.ts` (new `https.createServer(...).listen(8443)` call).
2. **Vite default host stays `127.0.0.1`** — `vite.config.ts:24`. The IPv6 stall comment must remain. CLI `--host 0.0.0.0` from `npm run dev:lan` overrides per-invocation.
3. **`hidden md:block` pattern from `src/components/mini-player.tsx:77`** is the canonical responsive-hide idiom — replicate, do not invent alternatives (e.g. no `lg-and-up:` custom breakpoints).
4. **Drag-and-drop voice assignment stays intact on desktop** — `src/views/cast.tsx:52-58` drag state + `onDragOver` / `onDragLeave` / `onDrop` handlers remain. Tap-to-assign is additive.
5. **Paragraph-boundary drag stays intact on desktop** — `src/views/manuscript.tsx` boundary drag handlers + cursor changes + `dragging-boundary` CSS class remain. Tap-revealed buttons are additive.
6. **Tailwind default breakpoints (`sm: 640`, `md: 768`, `lg: 1024`)** — `tailwind.config.ts` stays at defaults. Custom breakpoints would split the codebase between conventions.

## Responsive breakpoint strategy

| Viewport range | Tailwind prefix | Target devices | Layout rule |
|---|---|---|---|
| `<640px` | (default, no prefix) | portrait phones | single-column, drawers + bottom sheets for secondary content, modals become full-screen, hamburger menu in top bar |
| `640–1024px` | `sm:` and `md:` | tablets portrait/landscape, landscape phones | two-column where appropriate, condensed top bar, modals as dialog (not full-screen), secondary panes as right drawer |
| `≥1024px` | `lg:` and `xl:` | desktop, tablet landscape with wide screens | three-pane layouts (manuscript), full top bar, all panes always visible |

Mobile-first means: write the smallest layout first (no prefix), then add `md:` / `lg:` overrides for wider viewports. The existing 35 instances of responsive utilities across `src/` are not mobile-first — they assume desktop default and `hidden md:block` to show on desktop. New work follows the inverse convention: hide on desktop with `lg:hidden`, show on mobile by default.

## Touch-equivalence rules

For every desktop affordance, this plan ships its touch equivalent. Drag and hover are explicitly NOT supported on mobile — they're additive desktop conveniences.

| Desktop affordance | Touch equivalent | Wave |
|---|---|---|
| Drag voice from library → drop on character row | Tap voice → "assign mode" sticky pill → tap character row to assign | 4 |
| Drag paragraph boundary up/down | Tap-revealed "Split here" / "Merge with above" buttons at each boundary | 4 |
| Hover row → reveal action button | Always-visible action button on touch devices (CSS `(hover: none)` media query or `touch:` Tailwind variant) | 4 |
| Right-click / context menu | (none currently in app; preserve absence) | n/a |
| Hover voice card → preview audio | Tap voice card → preview audio + (if in assign mode) enter assign mode on second tap | 4 |

## LAN-over-HTTPS access protocol

**One-time setup (per dev box):**

1. Install `mkcert` (Windows: `scoop install mkcert` or `choco install mkcert`; macOS: `brew install mkcert`; Linux: package manager).
2. Run `mkcert -install` to create the local root CA + install it in the OS trust store.
3. `npm install` — `vite-plugin-mkcert` auto-generates per-host certs on first dev run.

**One-time setup (per mobile device on the LAN):**

1. On the dev box: `npm run install:cert-mobile`. This prints the LAN URL + a QR code linking to `https://<lan-ip>:8443/cert/root.crt`.
2. On the mobile device: scan the QR (or type the URL). Download the root CA file.
3. **iOS / iPadOS:** Settings → "Profile downloaded" banner → Install (enter passcode) → Settings → General → About → Certificate Trust Settings → enable trust for the mkcert root.
4. **Android:** Settings → Security → "Encryption & credentials" → Install a certificate → "CA certificate" → pick the downloaded file.
5. **macOS (Safari/Chrome):** double-click the downloaded `.crt` → Keychain Access → set Trust to "Always Trust".

After the per-device install, every `https://<lan-ip>:8443` URL is trusted with no warning. Trust persists across reboots until the mkcert root rotates (mkcert renews every few years; user re-runs `npm run install:cert-mobile` then).

**Run modes:**

- `npm run dev:lan` — Vite dev server on `https://0.0.0.0:5174` with HMR. Use for active mobile UI development.
- `npm run start:lan` — Production bundle served by Node on `https://0.0.0.0:8443`. Use for "let me try this on my phone right now."
- `npm start` (default) — current localhost-only dev workflow, unchanged.

**Fallback if mkcert proves friction-heavy:** `vite-plugin-basic-ssl` for dev + self-signed cert for Node prod. Each mobile device dismisses a per-session "Not Secure" warning. Documented as plan B in this section so a clean repo clone has two recoverable paths.

## Wave structure

Six waves, each its own branch + PR + merge. Wave 0 is the docs PR you're reading.

| Wave | Branch | Scope |
|---|---|---|
| 0 | `docs/docs-mobile-tablet-round-0` | This plan + BACKLOG entry + INDEX update |
| 1 | `feat/server-lan-https-mobile-baseline` | mkcert HTTPS, `LAN_HTTPS=1` flag, `/api/lan-urls` + `/cert/root.crt` routes, Playwright mobile + tablet projects, visual baseline lock |
| 2 | `feat/frontend-responsive-shell` | Layout chrome: top bar overflow, mini-player, modal shell, touch-target audit |
| 3 | `integration/responsive-views` (6 sub-branches) | Per-view responsive: manuscript, cast, listen, confirm-cast, generation+upload, books |
| 4 | `feat/frontend-touch-affordances` | Tap-to-assign voice, split/merge buttons on manuscript boundaries, hover-reveal audit |
| 5 | `test/e2e-mobile-coverage` | Full per-view × per-project visual baselines + horizontal-overflow assertions |
| 6 | `docs/docs-ship-mobile-tablet` | status → stable, ship notes, archive move, CLAUDE.md mobile-testing protocol section |

Per [[feedback_parallel_vs_sequential_agents]] and [[feedback_worktree_when_parallel_agents_possible]]: Wave 3 spawns six parallel agents on isolated worktrees. All other waves are sequential on the main checkout.

## Test plan

### Automated coverage (cumulative across waves)

- **Wave 1:**
  - Vitest server (`server/src/__tests__/lan-https.test.ts`) — `LAN_HTTPS=1` + valid certs present → server boots on 8443 over HTTPS; cert-not-present → friendly error referencing `mkcert -install`.
  - Vitest server (`server/src/__tests__/cors-lan.test.ts`) — `/api/books` with `Origin: https://192.168.1.50:8443` → 200.
  - Vitest server (`server/src/__tests__/root-cert-route.test.ts`) — `GET /cert/root.crt` returns the mkcert root CA with correct MIME (`application/x-x509-ca-cert`).
  - Vitest server (`server/src/__tests__/lan-urls-route.test.ts`) — `GET /api/lan-urls` returns the `enumerateLanUrls` output as JSON.
  - Playwright (`e2e/responsive-baseline.spec.ts`) — Books + Listen views under all three projects with `toHaveScreenshot()`.
- **Wave 2:**
  - Vitest RTL (`src/components/__tests__/layout.responsive.test.tsx`) — top-bar overflow menu shows below `md` (matchMedia mock).
  - Playwright (`e2e/responsive-chrome.spec.ts`) — top-bar overflow + modal full-screen at mobile project.
- **Wave 3 (one assertion per view, per sub-branch):**
  - Vitest update for each view's existing `*.test.tsx` — mobile-viewport render assertion.
  - Playwright extension to `e2e/responsive-baseline.spec.ts` — per-view no-horizontal-scroll assertion at 375×667.
- **Wave 4:**
  - Vitest RTL (`src/components/__tests__/voice-library-panel.tap-assign.test.tsx`) — tap voice → enter assign mode → tap char → assignment dispatched.
  - Vitest RTL (`src/views/__tests__/manuscript.split-merge-button.test.tsx`) — tap split button → reducer dispatched.
  - Playwright (`e2e/touch-assign.spec.ts`) under `mobile-chrome` project — tap-to-assign happy path.
- **Wave 5:**
  - Playwright (`e2e/responsive-coverage.spec.ts`) — every view × every project, no-horizontal-overflow + snapshot.
- **Wave 6:** none (docs-only).

### Manual acceptance walkthrough (after Wave 5)

1. **Cold install on a new dev box:** `mkcert -install` succeeds; `npm install` reports `vite-plugin-mkcert` set up.
2. **`npm run dev:lan`** → console prints `Local: https://localhost:5174` + `Network: https://192.168.x.x:5174`. Open the network URL on the dev box: no browser warning.
3. **`npm run install:cert-mobile`** → terminal shows a QR code + step-by-step iOS/Android instructions. Scan with phone, follow steps, confirm "Trusted" in cert settings.
4. **Open `https://192.168.x.x:5174` on the phone (Safari iOS):** address bar shows lock icon, no warning. Books view renders with single-column shelf.
5. **Navigate to Upload:** dropzone is full-width, file picker opens iOS Files. Pick a `.txt`, paste flow alternative works.
6. **Navigate to Cast (after analysis):** see card-list (not table), Library opens as bottom sheet via "Library" pill, tap a voice → "Assign" pill appears at bottom → tap a character row → assignment confirmed via toast.
7. **Navigate to Manuscript:** chapter list as left drawer (hamburger), inspector as bottom sheet, prose fills mid-area. Long-press / tap-reveal "Split here" button at a sentence boundary; tap → reducer fires.
8. **Navigate to Listen:** cover + title + meta stack vertically, mini-player sticky at bottom edge. Tap a chapter, audio plays.
9. **Repeat 4–8 on a tablet (iPad Safari landscape, 1024×768):** two-pane layouts appear where defined (e.g. manuscript shows chapter list as collapsible top strip + inspector as right drawer).
10. **Repeat 4–8 in landscape phone (667×375):** layouts stay legible, no horizontal scroll, tap targets ≥44×44.

## Out of scope

- **PWA / installable app** — no service worker, no offline mode, no manifest icons. Deferrable backlog item.
- **Native iOS/Android wrapper** — Capacitor/Tauri shell is a separate decision.
- **mDNS / Bonjour pretty hostnames** — accessing via raw LAN IP is acceptable. `https://audiobook.local:8443` is a follow-up item.
- **Public-CA HTTPS / Let's Encrypt** — only makes sense if the box gets a real domain + WAN exposure. Local mkcert root CA is the right call for LAN.
- **Sidecar LAN binding** — browser doesn't talk to sidecar; Node proxies. Sidecar stays loopback-only.
- **Touch gestures on Listen** (long-press for marker editing, swipe for chapter nav) — Wave 4 covers cast + manuscript only. Other surfaces are follow-up if needed.

## Ship notes

(To be filled when status flips to `stable`.)
