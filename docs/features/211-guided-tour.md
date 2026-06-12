---
status: active
shipped: null
owner: null
---

# fe-38 — Guided product tour (in-app spotlight onboarding)

> Status: active — implementation in progress on `feat/frontend-guided-tour`.
> Key files: `src/lib/tour-steps.ts` (step registry), `src/store/tour-slice.ts` (state + thunks), `src/components/tour/tour-overlay.tsx` (spotlight renderer), `src/components/library/library-empty-states.tsx` (entry CTA), `src/components/top-bar.tsx` (? menu), `src/views/help.tsx` (re-entry button); server: `server/src/routes/tour.ts` (`GET/POST /api/tour`), `server/src/workspace/user-settings.ts` (`tourCompletedAt`).
> URL surface: no dedicated hash route — overlay mounts at the app root; persisted state is server-side.
> OpenAPI ops: `GET /api/tour/status`, `POST /api/tour/complete`

## Benefit / Rationale

- **User:** turns a cold first open into a guided, self-paced product demo — walks the user through all five pipeline stages (Library → Manuscript → Cast → Generate → Listen) on the bundled sample book without waiting for analysis, GPU design, or generation. The Listen finale plays real pre-rendered audio. Non-technical deployers can reach confident product understanding in a single session.
- **Technical:** a declarative per-screen step registry feeds both the linear first-run tour _and_ on-demand per-screen mini-tours from one source of truth; the tour engine drives real Redux navigation (no fake/simulated screens). Completion is server-side (`tourCompletedAt`) so the no-re-nag guarantee survives localStorage clears and holds across devices.
- **Architectural:** the spotlight overlay is mounted once at the app root as a portal sibling to the stage views and self-gates on `tour.active`; it is inert otherwise. The step registry is pure data — copy lives in one file, translatable. The `tour` slice does NOT persist to `redux-persist` (completion is server-sourced at boot, not locally stored).

## Architectural impact

- **New seams:** `tour` slice in `src/store/` (new reducer registered in `index.ts`); `src/lib/tour-steps.ts` (step registry + `TourStep`/`TourScreen` types); `src/components/tour/tour-overlay.tsx` (portal, mounts at root); `api.getTourStatus` + `api.completeTour` on both real and mock api objects; `tourCompletedAt` in `UserSettings`; `GET /api/tour/status` + `POST /api/tour/complete` routes.
- **Invariants preserved:** the discriminated-union `ui.stage` is unchanged — the tour navigates by dispatching existing actions (`openBook`, `changeView`, `setOpenProfileId`); no new stage variant is added. `data-tour-id` anchors are additive attributes on existing elements; they do not replace or modify `data-testid` attributes.
- **Migration story:** `tourCompletedAt` is additive on `UserSettings`; absent on upgrade means the tour invitation fires once on first open (via the empty-library CTA if the library is empty, or via the `?` menu). No cast.json / state.json / manuscript-edits.json shape change.
- **Reversibility:** remove the `tour` slice, the `<TourOverlay />` mount from `layout.tsx`, the `tourCompletedAt` field, the `/api/tour` routes, and the entry-point additions from `library-empty-states.tsx`/`top-bar.tsx`/`help.tsx`. The `data-tour-id` attributes are inert if the overlay is removed.
- **fs-22 coupling:** the tour finale (s10) plays pre-rendered chapter 1 audio from the bundled sample; this requires amending the `fs-22` spec (whose original Non-Goal was "no pre-rendered audio") to bundle exactly one chapter. This amendment is a companion deliverable.
- **Stacking:** the overlay sits at `z-[75]+` (above the cast drawer at z-40/50 and nested modals at z-60/70); the lit cutout passes pointer events through so the highlighted control stays clickable even inside an open drawer.

## Invariants to preserve

1. **The tour drives real navigation.** `goToStep()` dispatches real Redux actions (`openBook`, `changeView`, `setOpenProfileId`) before the overlay measures the anchor — every spotlight lands on a genuine screen, never a mocked one. `tour-slice.ts` → `navigateForStep()`.
2. **Heavy flows are never auto-triggered.** Steps whose `kind === 'explain'` (s3 New book, s8 Design full cast, s9 Generate) point at the control and explain it; the tour never invokes analysis, voice design, or generation. `src/lib/tour-steps.ts` — the `kind` field.
3. **Anchor-missing degrades to centered bubble.** If `document.querySelector('[data-tour-id="…"]')` returns null or a zero-size rect within the retry window, the step renders a centered bubble with the same copy. The tour never crashes or points at empty space. `tour-overlay.tsx` → `measure()` + retry timeouts.
4. **`tourCompletedAt` is server-sourced.** The `completedAt` field in `TourState` is hydrated at boot by `fetchTourStatus()` (mirrors `fetchAccountSettings`). The tour slice does not use `redux-persist`. Presence of `completedAt` suppresses the empty-library invitation.
5. **`data-testid="topbar-help"` is preserved.** The `?` button becomes a popover menu, but `data-testid="topbar-help"` stays on the trigger so the e2e suite doesn't break. `top-bar.tsx`.
6. **The `?` menu's "Help" item still navigates to `#/help`.** The Help link in the new popover is an `<a href="#/help">` (or equivalent dispatch), unchanged from the prior direct link. Deep-links from analysing/generation (`helpHrefForFailureCode`) are separate `<a>` tags and are unaffected.
7. **Cross-tab isolation.** The tour is device/tab-local; the `tour` slice does not emit `BroadcastChannel` messages (plan 63). A second tab is not dragged through the spotlight.
8. **Sample provisioning is idempotent.** `startLinearTour()` calls `api.loadSample('the-coalfall-commission')` only when the sample book is not already in the store. A returning user who kept the sample doesn't trigger a destructive re-provision. `tour-slice.ts` → `startLinearTour()`.

## Test plan

### Automated coverage

- **Vitest server** (`server/src/workspace/user-settings.test.ts`) — `tourCompletedAt` describe block: `getResolvedTourCompletedAt()` returns null before any write; `writeTourCompletedAt` persists and the getter reflects it; field is absent from the general PUT (`FORBIDDEN_KEYS`).
- **Vitest server** (`server/src/routes/tour.route.test.ts`) — `GET /api/tour/status` returns `{ completedAt: null }` before completion; `POST /api/tour/complete` stamps an ISO timestamp and the subsequent GET reflects it.
- **Vitest frontend** (`src/lib/api.tour.test.ts`) — mock `getTourStatus`/`completeTour` round-trip; `_resetMockTour` resets state between tests.
- **Vitest frontend** (`src/store/tour-slice.test.ts`) — reducer: starts inactive, `startTour`, `setStepIndex`, `endTour`, `markCompletedLocally`; thunks: `fetchTourStatus.fulfilled` hydrates `completedAt`; navigation: `goToStep` drives correct `ui.stage.view` per step; `opensDrawer` step sets `openProfileId`; `prevStep` off a drawer step clears it.
- **Vitest frontend** (`src/lib/tour-steps.test.ts`) — registry integrity: 13 steps in 5-station order; every `screen` is a valid `TourScreen`; every non-null anchor is unique; `stepsForScreen('cast')` returns the cast mini-tour in order.
- **Component (RTL)** (`src/components/tour/tour-overlay.test.tsx`) — renders nothing when inactive; renders bubble title/body for active step; missing-anchor → centered fallback (`data-anchored="false"`); Skip ends the tour.
- **Component (RTL)** (`src/components/library/library-empty-states.test.tsx`) — "Take the guided tour" CTA fires `onStartTour`; suppressed when `tourCompleted` is true.
- **Vitest frontend** (`src/lib/tour-anchors.test.tsx`) — smoke: `companion-app-banner` carries `data-tour-id` after Task 9.
- **Vitest frontend** (`src/components/top-bar.test.tsx`) — rewrite of assertion at line 120: trigger is a button with `aria-expanded`; menu contains "Help", "Take the tour", "Show me this screen"; `data-testid="topbar-help"` still present.
- **Playwright e2e** (`e2e/guided-tour.spec.ts`) — golden path: empty library → "Take the guided tour" → sample provisions → steps advance across real Manuscript / Cast (drawer opens for s7) / Generate / Listen screens → `chapter-1-play` present + playable → finish → `tourCompletedAt` set → reload shows no re-nag. Plus: Cast mini-tour via the `?` menu replays s6–s8 only. Responsive case appended to `e2e/responsive/coverage.spec.ts`.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`) unless noted.

1. **Empty library, cold boot at `#/`** — library is empty, "Take the guided tour" CTA is visible. Click it. Expected: sample provisions (`api.loadSample` called), `tour.active = true`, step s1 "Welcome to Castwright" centered bubble.
2. **Advance through Library steps (s1–s3)** — Next on s1 → s2 spotlight on the sample book card; Next → s3 spotlight on New book button (`kind: explain`). Back returns to s2.
3. **Manuscript station (s4–s5)** — Next from s3 navigates to `#/books/<id>/manuscript`; s4 spotlights a specific dialogue line; s5 spotlights the first chapter-boundary handle.
4. **Cast station (s6–s8)** — s6 spotlights the cast roster; s7 opens the profile drawer and spotlights it; Back from s7 closes the drawer and returns to s6. s8 is `kind: explain` centered on the roster.
5. **Generate station (s9)** — navigates to `#/books/<id>/generate`; "Resume generation" control is spotlighted; copy explains it's `kind: explain` (tour never triggers generation).
6. **Listen station (s10–s13)** — navigates to `#/books/<id>/listen`; s10 spotlights the chapter-1 play button (enabled, ch.1 `hasAudio`). Click Play and confirm audio plays (real rendered chapter 1 from bundled sample — **OWED on-box** once the fs-22 audio bundle ships). s11 companion banner; s12 M4B download tile; s13 centered "Done".
7. **Finish** — click Done on s13 → `POST /api/tour/complete` called, `tourCompletedAt` set, overlay dismissed.
8. **Reload** — reload the page (still pointing at the sample book). Expected: the empty-library "Take the guided tour" CTA is gone (library is no longer empty); the `?` menu still offers "Take the tour" for replay; no automatic re-offer.
9. **Replay via `?` menu** — click `?` → "Take the tour" → tour restarts at s1. Expected: `api.loadSample` is NOT called destructively (sample already present).
10. **Per-screen mini-tour** — with the Cast view open, click `?` → "Show me this screen" → only s6–s8 play; overlay ends after s8 without navigating away.
11. **Skip** — start the tour, click Skip. Expected: tour ends immediately, `tourCompletedAt` is NOT stamped (Skip ≠ finish).
12. **Esc key** — start the tour; press Esc. Expected: tour ends (same as Skip).
13. **Reduced motion** — `prefers-reduced-motion: reduce` set in browser. Expected: no smooth-scroll or CSS transition on step advance.

### OWED on-box acceptance

- **Chapter-1 audio playback (s10)** — requires the fs-22 bundled sample to ship with one pre-rendered chapter 1 (full Qwen cast). Until that bundle lands, s10 shows the play button enabled (the anchor exists) but the audio itself cannot play in mock/dev mode. Mark complete only after a real on-box run with the bundled audio confirmed audible.

## Out of scope

- Auto-running analysis, voice design, or generation from inside the tour.
- Stage re-entry for the _Analysing_ screen — explained from outside, not replayed live.
- Tours for secondary surfaces (Account, Admin, Model Manager, Advanced, Voices library) — the registry makes adding them trivial later.
- Step-level progress persistence across reloads — only the binary `tourCompletedAt` is stored; a half-finished tour re-offers from s1.
- Cross-tab sync — tour state is device/tab-local.

## Ship notes

_(To be filled when status flips to `stable`. Include: shipped date, PR SHA, any behaviour delta vs. the spec above. Then move to `docs/features/archive/`.)_
