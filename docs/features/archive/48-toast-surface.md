---
status: stable
shipped: 2026-05-18
owner: null
---

# Global toast surface (notifications slice + ToastStack)

> Status: stable
> Key files: `src/store/notifications-slice.ts`, `src/components/toast-stack.tsx`, `src/components/layout.tsx`, `src/store/generation-stream-middleware.ts`, `src/store/analysis-stream-middleware.ts`, `src/modals/export-audiobook.tsx`
> URL surface: none (transient UI overlay)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** transient stream / export failures used to fire silently — the analysing pill would just stop advancing, the export modal would close into "nothing happened", a chapter row would flip to `failed` while the user was on the Cast view and they'd never know. This toast surface closes the "did anything happen?" gap with a 6 s auto-dismissing notification that doesn't interrupt focus.
- **Technical:** consolidates three failure paths (analysis-stream catch, generation-stream stream-level halt, export modal 5xx) onto one slice + one render surface. Per-chapter failure ticks deliberately stay non-toasted to avoid spamming on multi-chapter cascades — the per-chapter UI already surfaces them.
- **Architectural:** keeps the existing `<ConfirmDialog>` (modal-level errors with a CTA, via `LayoutContext.showError`) and `<StaleAudioBanner>` (domain banner anchored under chapter audio) untouched. Each owns its niche after plan 48; the new `<ToastStack>` is purely additive.

## Architectural impact

- **New seams / extension points:**
  - `src/store/notifications-slice.ts` — `pushToast({ kind, message, dedupeKey? })`, `dismissToast(id)`, `dismissByKey(key)`. Selector `selectToasts` falls back to `[]` when the slice isn't registered, so existing test stores composed before plan 48 keep working without per-test churn.
  - `src/components/toast-stack.tsx` — fixed bottom-right `role="status"` (aria-live polite) stack; one component, mounted once in `layout.tsx` after the outlet. Each toast self-dismisses after 6 s with a `clearTimeout` cleanup that's safe under React 18 strict-mode double-invoke; a dedupe-bumped `createdAt` re-keys the effect so the timer resets.
  - `LayoutContext.pushToast` — exposed to route modules that already consume the outlet context, so call sites don't have to learn `useAppDispatch`. Middleware paths dispatch through the slice directly (they're outside React).
- **Invariants preserved:**
  - Plan 38 (commit gate): unchanged.
  - Plan 44 (PR hygiene): PR title + body conform to the new template.
  - Plan 46 (lint baseline): everything Prettier-formatted; `--max-warnings 0` lint passes.
  - Existing error surfaces (`<ConfirmDialog>` + `<StaleAudioBanner>`) are NOT migrated to toasts — they own their own UX shapes (modal + domain banner anchored to chapter audio). The toast surface is additive, not a replacement.
- **Migration story:** none. `selectToasts` defensive fallback means no existing test store needs updating; the slice can be registered or not.
- **Reversibility:**
  - Remove the `notifications` slice + ToastStack mount + the three middleware/modal dispatch sites → toast surface gone, all existing error paths fall back to their pre-plan-48 behaviour (silent for stream halts; missing-list-as-fake-chapter for export 5xx).

## Invariants to preserve

1. **`pushToast` MUST use the prepare callback for `id` + `createdAt`.** `notifications-slice.ts:46-58` — both fields are non-deterministic (UUID + Date.now), so they have to be stamped at dispatch time, not in the reducer. Putting them in the reducer would violate the "reducers are pure" rule.
2. **Dedupe MUST bump `createdAt` AND override `kind` / `message`** on a same-key push (`notifications-slice.ts:35-43`). The bumped timestamp re-keys the ToastStack's auto-dismiss effect (`toast-stack.tsx:36-44`) so a fresh 6 s window starts; overriding kind + message means a recovered-then-failed cycle surfaces the most recent state.
3. **Per-chapter `chapter_failed` ticks MUST NOT toast.** `generation-stream-middleware.ts:407-418` — only the stream-level halt (`chapterId == null`) at the new branch (~lines 419-435) toasts. Per-chapter failures already surface in the per-row UI; toasting them would spam on multi-chapter cascades.
4. **Export modal's `ExportIncompleteError` branch MUST stay in-modal.** `export-audiobook.tsx:265-272` — 409 carries a missing-chapters list that's the user's direct "regenerate this" path. Toasting + closing the modal would lose that affordance. Only the 5xx / non-409 `else` branch routes to toast.
5. **`<ToastStack/>` MUST mount at a higher z-index than the MiniPlayer.** `toast-stack.tsx:24` uses `z-[60]`; `mini-player.tsx:90` uses `z-50`. Otherwise the stack would render behind the player on the Listen view, defeating the point.

## Test plan

### Automated coverage

- **`src/store/notifications-slice.test.ts`** — 8 pure-reducer cases: push stamps id+createdAt, two pushes stack with no key, dedupe bumps createdAt (count stays 1), dedupe overrides kind, two different keys produce two toasts, dismiss removes-by-id, dismiss no-op on unknown id, dismissByKey selective.
- **`src/components/toast-stack.test.tsx`** — 6 component cases: renders nothing on empty, one-per-toast iteration, dedupeKey collapse renders only the latest, close-button dispatches dismiss, 6 s `vi.useFakeTimers` advance clears the toast, 5999 ms advance leaves it intact.
- **`e2e/toast-surface.spec.ts`** — 2 browser-level cases via `window.__store__` direct dispatch (mock-mode createBookExport always succeeds so the 5xx path isn't directly walkable): single push renders + auto-dismisses inside the 8 s envelope; three same-key pushes collapse to a single rendered toast.
- **Existing 869 frontend + 851 server tests** stay green; the slice's defensive selector means pre-plan-48 test stores don't need updating.

### Manual acceptance walkthrough

1. `npm run dev` → cold boot → open the Listen view of a complete book → click Export → kill the server mid-export (e.g. `taskkill /F /IM node.exe` on the analysis backend, or set `ANALYZER=fail` if available). Modal closes; a red toast bottom-right says "Export failed." Auto-dismisses after ~6 s.
2. Same book → start an analysis → kill the analyzer (or trigger a known halt code). Top-bar AnalysisPill flips to halted; a red toast bottom-right says the halt reason. Second halt within 6 s bumps the same toast instead of stacking.
3. Open dev tools → `window.__store__.dispatch({ type: 'notifications/pushToast', payload: { id: '1', kind: 'info', message: 'hello', createdAt: Date.now() } })` — toast renders bottom-right. Repeating with the same `id` does NOT bump (id is the dedupe primary key for in-place updates; user-facing dedupe uses `dedupeKey`).

## Out of scope

- Migrating `<StaleAudioBanner>` to the toast surface. Domain banner, anchored to chapter audio, not transient. Stays separate (BACKLOG bullet on plan 48 explicit).
- Toast actions / CTAs. Use `<ConfirmDialog>` for that — already wired in `layout.tsx` via `showError`. Adding a CTA to toasts would require a click target above the auto-dismiss timer, which is a larger UX shape than this plan covers.
- Sound / extended a11y (e.g. aria-live `assertive` on errors). Started with `role="status"` (polite) on the stack. axe-core a11y harness from plan 46 doesn't cover the toast surface — it's not mounted in the four-view spec. Tracked as a follow-up if real-world use surfaces a need.
- Per-toast persistence across reload. Transient by design.
- Toast persistence in redux-persist's whitelist. Not added; the slice is in-memory only.

## Ship notes

- Shipped 2026-05-18 on branch `feat/frontend-plan-48-toast-surface` via PR (commit SHA filled at merge).
- Seven plan-48 commits + one prerequisite (`ci(ci): force LF on husky hooks via .gitattributes`, which lands the `.gitattributes` file fixing a Windows + autocrlf hook-execution bug introduced when checking out branches with .husky scripts):
  1. `ci(ci): force LF on husky hooks via .gitattributes` — landed with `--no-verify` by explicit user authorization (the bypass IS the fix; the hook the gate enforces is what's broken until this commit lands).
  2. `feat(frontend): plan 48 add notifications slice + ToastStack`
  3. `test(frontend): plan 48 cover notifications dedupe + auto-dismiss`
  4. `feat(frontend): plan 48 mount ToastStack + extend layout context`
  5. `feat(frontend): plan 48 route stream errors through toast`
  6. `feat(frontend): plan 48 narrow export catch + toast on 5xx`
  7. `test(e2e): plan 48 walk forced toast push + dedupe collapse`
  8. `docs(docs): plan 48 ship + archive`
- Hot file conflict with plan 47 (listen-progress): both touch `src/components/layout.tsx` (mount ToastStack here, hydrate effect there) and `src/store/index.ts` (slice registration). Plan 48 ships first per the round plan; plan 47 rebases on the updated `LayoutContext` shape.
