---
status: stable
shipped: 2026-05-18
amended: 2026-05-22
owner: dudarenok-maker
---

# Bulk-apply library sync on confirm-cast

> **Bug D amendment (2026-05-22):** the sync-checkbox auto-tick is now
> gated on match confidence. Apply All flips Reuse for every eligible
> row (Bug C behaviour unchanged), but auto-ticks the "Sync profile
> with `<book>`" checkbox **only for rows where `matchedFrom.confidence
> < 0.9`**. High-confidence matches (≥ 0.9) keep the sync checkbox as
> a deliberate per-card opt-in because the library record is already a
> good fit; the user shouldn't have to untick every confident match
> after a one-click bulk. Threshold lives at module top of
> `src/views/confirm-cast.tsx` as `SYNC_AUTO_THRESHOLD = 0.9`;
> undefined confidence is treated as low-confidence (defensive — older
> voice-match payloads omitted the field). The unapplied count `N`
> changes shape: a row is "applied" once its decision is Reuse AND
> (the row is high-conf OR its override is on). A cast of only
> high-confidence matches reaches "Clear all syncs" on first render
> with zero checkboxes ticked. Clear-syncs path still sweeps every
> eligible override off (including any high-conf manual ticks) —
> symmetric escape hatch. See `src/views/confirm-cast.test.tsx` (the
> four "Bug D" cases) for the regression lock and
> `e2e/bulk-sync-library.spec.ts` for the browser-level golden path
> exercising the 0.94 / 0.89 / 0.86 fixture confidences.

> **Bug C amendment (2026-05-19):** the pill now flips Reuse decision
> AND ticks sync overrides in one click. The original behaviour (sync
> overrides only) produced no visible effect on cards the user had
> previously toggled to "Generate fresh", because the per-card sync
> checkbox is gated on `decision === 'match'`. Apply path sets BOTH
> `decisions='match'` and `overrides=true` for every eligible
> character; Clear-syncs path stays overrides-only to avoid
> destructively reverting decisions the user explicitly chose. Pill
> relabelled to **"Apply all N matches"** / **"Clear all syncs"** where
> N is the count of currently-unapplied eligible cards (decision !=
> match OR override off). See `src/views/confirm-cast.test.tsx`
> ("flips Reuse decision on cards previously toggled to Generate") for
> the regression lock. *(Note: the Bug-D amendment above further
> tightens the override half — high-confidence rows are no longer
> ticked by Apply All.)*

> Status: stable
> Key files: `src/views/confirm-cast.tsx`, new `src/views/confirm-cast.test.tsx`, new `e2e/bulk-sync-library.spec.ts`
> URL surface: `#/books/<id>/confirm` (no router grammar change)
> OpenAPI ops: none (purely a UI compression over existing `POST /api/library-cast/override`)

## Benefit / Rationale

- **User:** large manuscripts in long-running series carry many characters that were already cast in prior books (12+ for Keeper-of-the-Lost-Cities-scale projects). Today the "Continuity preserved" footer's "Sync profile" checkbox is opt-in per-character and defaults off, so the user clicks once per card before clicking "Confirm cast." A "Sync N profiles from library" pill at the top of the view compresses N clicks to 1, with per-card untick still available for the rare exception (e.g. a character has grown up between books and the analyzer's fresher description is wanted instead of the library record). Manual link-prior (plan 09 §"Manual continuity link", shipped 2026-05-17) still handles the inverse case where the auto-matcher missed.
- **Technical:** purely additive on the existing batch path. `handleConfirm` in `src/views/confirm-cast.tsx:62-86` already iterates characters, gates on `decisions[c.id] === 'match' && overrides[c.id] && target?.bookId`, and fires each opted-in override through `POST /api/library-cast/override` via `Promise.allSettled`. The pill needs only to call `setOverrides` once with an object spread covering every eligible character; the existing batch fires unchanged on "Confirm cast". No new endpoint, no new Redux action, no new mocks.
- **Architectural:** completes the plan 09 §94 "Bulk-accept-all UI" item that was explicitly deferred to a v1 follow-up. Closes a v1 ergonomics gap without re-opening any of plan 09's matcher-side invariants (score floors, candidate ordering, alias dedup).

## Architectural impact

- **New seams:** none — the work is one component-local handler + one new visual element in `src/views/confirm-cast.tsx`.
- **Invariants preserved:**
  - Plan 09 invariant: `overrides` defaults off per character; the bulk pill is an explicit user action, not an automatic ticker. The destructive override (analyzer description → library description) still requires deliberate user assent (one click for the cast vs. N clicks today).
  - Plan 26 (RTK Immer drafts): N/A — `overrides` is local React state (`useState`), not a slice; the pill writes via `setOverrides`, not via a reducer.
  - Plan 25 (Design tokens): the new pill uses existing tokens (`--peach`, `--ink`, etc.) via the `PrimaryButton` / `Pill` primitives in `src/components/primitives.tsx`. No hex literals.
- **Migration story:** none. No persisted state changes; `state.json` / `cast.json` shape is untouched. The library-cast-override calls fire through the same endpoint and write the same fields as today.
- **Reversibility:** trivial. Removing the pill (one block of JSX + one handler) reverts to per-character clicking. No data shape to roll back.

## Invariants to preserve

*(Invariants 3 + 4 below were rewritten on 2026-05-22 to reflect Bug C + Bug D — the original v1 wording referred to a "Sync N profiles from library" label and a constant-N count that no longer exist. The Bug C + Bug D amend notes at the top of this file are the authoritative changelog.)*

1. The pill appears **only** when at least one character has `c.matchedFrom?.bookId && c.matchedFrom?.characterId` (the same predicate `confirm-cast.tsx` uses for `canOverrideLibrary`). When zero characters are eligible, the pill is hidden entirely.
2. The pill toggles **only eligible characters**. Characters whose `matchedFrom` is missing the bookId/characterId handle (older voice-match payloads, unmatched-from-the-start cards) are not affected; the bulk action is "sync everyone the matcher matched," not "match everyone."
3. The pill label is **"Apply all N matches"** / **"Clear all syncs"** (Bug C) where `N` is the count of currently-unapplied eligible cards — *dynamic*, not constant. After Bug D, "applied" splits by confidence: a low-confidence row (`< SYNC_AUTO_THRESHOLD = 0.9`) is applied iff `decision === 'match' && overrides[id]`; a high-confidence row is applied iff `decision === 'match'` (the override is irrelevant because Apply All doesn't write it). A cast of only high-confidence matches reads "Clear all syncs" from first render.
4. Per-character toggles continue to work after a bulk apply — the user can untick a low-conf row's sync exception, or manually tick a high-conf row's sync, and the pill label immediately reflects the new state. Manual ticks on high-conf rows are preserved across Apply All clicks (not force-cleared).
5. Existing `handleConfirm` batch in `confirm-cast.tsx` is the only path to `POST /api/library-cast/override`. The pill does NOT fire requests directly — it only updates local state. This keeps "Confirm cast" as the single commit point.

## Test plan

> **Historical — superseded.** This section describes the v1 test scope as planned before ship. Bug C (2026-05-19) widened the apply path to also flip Reuse, and Bug D (2026-05-22) gated the override auto-tick on confidence. The current canonical coverage lives in the bulk-apply pill describe block of `src/views/confirm-cast.test.tsx` (35 cases including the four "Bug D" cases) and the asymmetric e2e assertions in `e2e/bulk-sync-library.spec.ts`. The wording below is preserved as an artefact of how the v1 plan was scoped, not as a current spec.

### Automated coverage

- **Vitest unit (`src/views/confirm-cast.test.tsx`)** — new spec (verify if file exists; if not, create alongside the view). Cases:
  - Render with 3 matched + 2 unmatched characters → pill renders with text "Sync 3 profiles from library".
  - Click pill → every matched character's checkbox is ticked; unmatched ones unchanged.
  - Click pill again → every checkbox cleared.
  - Untick one matched character's checkbox manually after a bulk tick → pill text flips to "Sync 1 profile from library".
  - Render with 0 matched characters → pill is absent from the DOM.
- **Playwright e2e (`e2e/bulk-sync-library.spec.ts`)** — new spec mirroring `e2e/manual-continuity-link.spec.ts` structure. Cold-boot → paste fixture → analysing → confirm. Assert pill renders, click it, assert all matched characters' "Sync profile" checkboxes are ticked. Click "Confirm cast and review manuscript", assert library-cast-override responses come back (network log or resulting Redux updates). Mock-mode only.
- If `src/mocks/canned-data.ts` only seeds one pre-matched character today (ANALYSIS_NORTHERN_STAR), extend the fixture to seed two more so the bulk button's count is meaningful in tests — currently Halloran is the only one with `matchedFrom` set on the canned response.

### Manual acceptance walkthrough

> **Historical — superseded.** Steps 4–7 below assume the v1 "Sync N profiles from library" label and the original tick-everything behaviour. Bug C renamed the pill and widened the apply path to include the Reuse decision; Bug D narrowed the auto-tick to confidence `< 0.9`. For a current walkthrough, see Verification step 3 in `~/.claude/plans/twinkling-wobbling-stonebraker.md` (or simply run the seeded mock cast — Narrator 0.94 / Eliza 0.89 / Marcus 0.86 — and observe that Apply All leaves Narrator's sync unticked).

Run in mock mode (`npm run dev` + `VITE_USE_MOCKS=true`).

1. **Cold boot at `#/`** → library cards visible.
2. **Click "Start a new book"** → `#/new`, upload modal opens.
3. **Paste a tiny manuscript + confirm metadata** → land at `#/books/<id>/analysing`. Click "Start analysis" → wait for the four mock phases.
4. **Land at `#/books/<id>/confirm`** → cast cards render. **Expected:** pill appears above the card grid, text "Sync N profiles from library" where N matches the number of cards showing "Continuity preserved" footers.
5. **Click pill** → every "Sync profile" checkbox below ticks; pill text flips to "Clear all syncs".
6. **Untick one character's checkbox manually** → pill text flips back to "Sync 1 profile from library".
7. **Click pill again** → the unticked checkbox re-ticks; pill text returns to "Clear all syncs".
8. **Click "Confirm cast and review manuscript"** → library-cast-override responses fire for every ticked character; the view transitions to the ready stage.
9. **Cold-boot a book whose analyser fixture has zero `matchedFrom` characters** → confirm pill is absent.

## Out of scope

- Defaulting per-character "Sync profile" checkbox to on. Considered and rejected — discoverability of an explicit pill beats a hidden default flip, and the override silently overwrites analyzer-generated descriptions.
- Score-floor filtering on the bulk **for the Reuse decision** — the matcher's `voice-match.ts::scoreOne` floor already gates which characters carry `matchedFrom`; adding a second threshold in the UI would silently exclude legitimate matches. *(Note: Bug D (2026-05-22) introduced a confidence threshold for the **sync-checkbox auto-tick only** — every eligible row still gets its Reuse decision flipped, so this out-of-scope item still holds for the decision half. See the Bug D amend at top.)*
- Server-side batch endpoint. The existing per-character POST loop in `handleConfirm` is fast enough at N=20 (~1s wall-clock total) and the request fan-out simplifies error reporting per character. A batch endpoint would be premature optimisation.
- Persisting bulk-tick state across sessions. `overrides` is intentionally local (`useState`); confirm-cast is a one-shot view, not a returning surface.

## Ship notes

Shipped 2026-05-18 via PR landing on `feat/frontend-plan-41-bulk-sync`.
Final shape:

- `src/views/confirm-cast.tsx` — bulk-sync pill renders between the centred
  header block and the cast-card grid via `<PrimaryButton variant="dark"
size="sm" icon={false}>`. Pill visibility predicate mirrors the per-card
  `canOverrideLibrary` predicate exactly (`!!onOverrideLibrary &&
!!c.matchedFrom?.bookId && !!c.matchedFrom?.characterId`) — pill hidden
  in mock environments where the per-card checkbox is itself hidden, and
  hidden when no character carries the full library handle. Label is
  dynamic: when not all eligible are ticked, it reads `Sync N profiles
from library` where N is the count of currently-unticked eligible
  characters; when all are ticked, it flips to `Clear all syncs`. The
  `setOverrides` call uses the functional-update form so a near-simultaneous
  per-card click (still spread from a stale closure) can't clobber the
  bulk set. The existing `handleConfirm` batch (`confirm-cast.tsx:96-123`)
  remains the only POST path — pill mutates local state only.
- Vitest cases under `src/views/confirm-cast.test.tsx` — new
  `ConfirmCastView — bulk sync pill` describe covers: 3 matched + 2
  unmatched renders `Sync 3 profiles from library`; 1 matched singularises
  to `Sync 1 profile from library`; clicking ticks every matched checkbox
  - unmatched cards unaffected; clicking again clears + label inverts to
    `Clear all syncs`; bulk-tick + per-card untick of one flips the label
    to `Sync 1 profile from library` (per the worked example in invariant
    4); pill absent when zero eligible OR when `onOverrideLibrary` isn't
    provided (mock environments).
- Playwright e2e at `e2e/bulk-sync-library.spec.ts` — walks cold-boot
  → paste → analysing → confirm; asserts `Sync 3 profiles from library`
  pill renders; clicks it; asserts all three matched checkboxes tick +
  label flips to `Clear all syncs`; clicks `Confirm cast` and lands on
  the manuscript route.
- Fixture seed in `src/data/characters.ts` + `src/data/match-factors.ts`
  — Narrator's existing `matchedFrom` rounded out with `bookId: 'sb'` +
  `characterId: 'narrator_sb'`, plus new full-handle `matchedFrom` on
  Eliza + Marcus (and matching `MATCH_FACTORS` entries). Halloran is
  intentionally left without `matchedFrom` so the
  `manual-continuity-link.spec.ts` test still uses him as the unlinked
  target. Visual baselines for `confirm.png` and `confirm-dark.png`
  re-blessed for the new pill + the two extra "Continuity preserved"
  footers; the manual-continuity-link assertion was scoped to `.first()`
  for the same reason.

Final commit on the branch: `c7c87e6` (pre-doc-flip; the doc-flip commit
references this SHA back).
