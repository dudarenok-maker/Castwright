---
status: stable
shipped: 2026-05-22
owner: null
---

# 95 — Editable "Also known as" aliases

> Status: stable
> Key files: `src/modals/profile-drawer.tsx`, `src/modals/reattribute-lines.tsx`, `src/store/cast-slice.ts`, `src/lib/api.ts`, `server/src/routes/cast-aliases.ts`
> URL surface: indirect — opens from the Profile Drawer (`src/components/layout.tsx`, mounted at every cast/listen/manuscript route).
> OpenAPI ops: `POST /api/books/{bookId}/cast/unlink-alias`, `POST /api/books/{bookId}/cast/add-alias` (contract-internal — same convention as `cast/merge`, not part of `openapi.yaml`).

## Benefit / Rationale

- **User:** when the auto-fold step (`server/src/analyzer/fold-minor-cast.ts:246-263`) or a manual merge over-grouped a real distinct cast member as an alias chip (e.g. `Garrow` sitting on `Saltgrave Figure`), the user could not recover. The chips were append-only. Now every chip carries a dismiss X that splits the alias back into its own standalone cast member, and a sibling `+ Add alias` button stitches in a name the analyzer missed.
- **Technical:** the merge endpoint at `server/src/routes/cast-merge.ts:141-151` rewrites `sentence.characterId` in place with no lineage column on the Sentence schema (`src/lib/api-types.ts:2121-2128`). Original speaker-name lineage is permanently lost at merge time. We compensate by reading `chapterCast` (the Phase-0a per-chapter raw roster, deliberately preserved across merges — `cast-merge.ts:14` "We deliberately do NOT touch chapterCast") to identify the chapters in which the alias originally appeared, then surfacing those chapters' candidate sentences in a Reattribute Lines modal so the user can move the right lines via the existing per-sentence picker (`manuscriptActions.setSentenceCharacter`).
- **Architectural:** opens a new pair of contract-internal routes (`cast/unlink-alias`, `cast/add-alias`) sibling to `cast/merge`. Both responses are delta-shaped (`newCharacter` + `impactedChapters` for unlink; `{ characterId, alias, alreadyPresent }` for add) — frontend dispatches `applyUnlinkAlias` / `applyAddAlias` reducers that mutate just the affected rows, rather than the full-cast replacement `applyMerge` does. No openapi.yaml entries (matches the existing `cast/merge`, `cast/link-prior`, `cast/add-from-roster` convention — these endpoints are contract-internal and don't ship in the typed client).

## Architectural impact

- **New seams / extension points.**
  - Server route file `server/src/routes/cast-aliases.ts` mounted at `/api/books` in `server/src/index.ts:142`. Two POST handlers, no GET.
  - Two delta reducers on `cast-slice.ts`: `applyUnlinkAlias` and `applyAddAlias`. Idempotent on retry; preserve local voice state on survivors via the same pattern `applyMerge` uses (`src/store/cast-slice.ts:100-118`).
  - New layout state slot `reattributeModal` in `src/components/layout.tsx` carrying `{ sourceCharacterId, sourceCharacterName, newCharacterId, aliasName, impactedChapters }`. Cleared on modal close.
  - Two new ProfileDrawer props `onUnlinkAlias` / `onAddAlias` (both optional — surfaces that don't wire them render the chip row read-only as before).

- **Invariants preserved.**
  - **Plan 24 (OpenAPI source of truth).** Cast-management endpoints (`merge`, `link-prior`, `add-from-roster`, and now `unlink-alias` / `add-alias`) are contract-internal: their typed interfaces live in `src/lib/api.ts` alongside the mock + real implementations. No openapi.yaml entries.
  - **Plan 23 (mock toggle).** Both endpoints get `real` + `mock` halves in `src/lib/api.ts`; mocks are stateless (the redux slice is authoritative in mock mode) so the cast view stays in sync without a shared mock-cast singleton.
  - **Plan 26 (RTK immer drafts).** Both new reducers mutate via Immer drafts — no spreads.
  - **Plan 00 (stage machine).** No `ui.stage` changes; the modal mounts at the layout level keyed off a regular `useState` slot (mirrors `RegenerateModal` and friends).

- **Migration story.** None. The Character schema already carries `aliases?: string[]` (`src/lib/api-types.ts:2039`); both new endpoints read + write that field via the existing `castJsonPath(bookDir)` reader. No state.json shape change.

- **Reversibility.** Roll back the route registration in `server/src/index.ts:142` and the two ProfileDrawer prop wires in `layout.tsx`. Existing aliases remain on disk; UI just goes back to read-only.

## Invariants to preserve

1. **Server route preserves `chapterCast`** — `cast-aliases.ts` reads but never writes `analysis-cache.chapterCast`. The merge route's deliberate non-mutation of this field (`cast-merge.ts:14`) is what makes the `impactedChapters` derivation possible; future routes must not touch it either.
2. **Sentence rewrites are user-driven only** — the unlink-alias route does NOT mutate `manuscript-edits.json.sentences[*].characterId`. Reattribution happens client-side via the existing `manuscriptActions.setSentenceCharacter` action so the rewrite is auditable (segments diff + change-log) and the user can pick individual sentences rather than getting a bulk move that catches false positives.
3. **Standalone character minting mirrors the analyzer fold's bucket factory** — `cast-aliases.ts::mintCharacterId` slugs the alias name + collision-suffixes; the synthesised character carries `role: 'character'` + `color: 'narrator'` and inherits `gender` + `ageRange` from the source (mirrors `makeBucket` at `server/src/analyzer/fold-minor-cast.ts:135-151`). Future surfaces that synthesise characters on the fly should follow the same shape.
4. **Reducer dispatches are delta-only** — `applyUnlinkAlias` takes `{ sourceCharacterId, aliasName, newCharacter }` (NOT a full characters list). `applyAddAlias` takes `{ characterId, aliasName }`. Both are idempotent on retry. Future endpoints in this family should follow the delta convention so mock mode doesn't need a shared cast singleton.
5. **The +Add alias affordance is visible even on aliasless characters** — the "Also known as" header + add button render whenever `onAddAlias` is wired, regardless of `character.aliases?.length`. Drops the previous-conditional reveal so the user can stitch in names without first triggering a merge.

## Test plan

### Automated coverage

- **Vitest unit** (`src/store/cast-slice.test.ts`) — `applyUnlinkAlias` strips the alias case-insensitively + trim-tolerantly, appends the new character with default `voiceState='generated'`, is idempotent on id collisions, preserves a tuned voice on the existing character; `applyAddAlias` appends + dedupes case-insensitively, refuses self-aliases, no-ops on unknown id / empty input.
- **Vitest unit** (`src/modals/profile-drawer.test.tsx`) — alias chip block renders an Unlink X per chip when `onUnlinkAlias` is wired and omits it otherwise; click fires `onUnlinkAlias` with `(characterId, aliasName)`; the X disables every chip's button while a request is in flight; `+ Add alias` button reveals the inline input, Enter dispatches `onAddAlias`, Escape cancels without dispatching; the section renders even when the character has no aliases (so the Add button is reachable).
- **Vitest unit** (`src/modals/reattribute-lines.test.tsx`) — renders one card per impacted chapter with candidate sentences, omits out-of-scope sentences; quick-set chip dispatches `manuscriptActions.setSentenceCharacter` and updates `aria-pressed`; source-chip reverts; Done fires `onClose`; empty-state copy renders both when `impactedChapters` is empty and when chapters carry only stale sentence IDs the manuscript slice can't hydrate.
- **Vitest server** (`server/src/routes/cast-aliases.test.ts`) — `unlink-alias` strips chip, creates standalone character, derives `impactedChapters` from seeded `chapterCast` (chapters where the alias name was in the Phase-0a roster), returns candidate sentence IDs from the right chapters only, does NOT mutate `manuscript-edits.json`, mints collision-suffixed ids on slug clash, 400/404 on the obvious bad-input cases. `add-alias` appends + dedupes + flips `alreadyPresent`, refuses self-aliases (400), 404 on unknown character.
- **Playwright e2e** (`e2e/cast-alias-edit.spec.ts`) — open Profile Drawer for Captain Halloran on confirm-cast, `+ Add alias` round-trip, click chip X, Reattribute Lines modal opens, Done closes, chip is gone, Add button is reachable again.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true` via `npm run dev`) unless noted:

1. **Cold boot at `#/`**. Click a book → analysing → Start analysis → confirm-cast. Expect: Captain Halloran's card visible.
2. **Click Halloran's card.** Profile Drawer opens. Scroll to **CAST ROSTER → Also known as**. Expect: section header visible; no alias chips (fixture has none); `+ Add alias` button visible.
3. **Click `+ Add alias`.** Inline input appears, autofocused. Type `Cap`, press Enter. Expect: input clears, a `Cap` chip appears with an X button on its right edge.
4. **Click the X on the `Cap` chip.** Expect: chip disappears, **Reattribute lines for Cap** modal opens. Mock mode returns no impacted chapters, so the empty-state copy renders ("Nothing to reattribute here.") with a Done button.
5. **Click Done.** Modal closes. Drawer remains open. `+ Add alias` is visible again (chip row is empty).
6. **Repeat in real mode** against a book that actually has aliases on a character (e.g. via the merge flow): the Reattribute Lines modal should list one card per chapter where the alias originally appeared in the Phase-0a roster, with candidate sentences attributed to the source character. Click the alias chip on a sentence row → the source chip's `aria-pressed` goes false, the alias chip's goes true, and the manuscript view (visit `#/books/<id>/manuscript`) shows the speaker label updated.

### Acceptance against the bug that motivated this plan

Originally reported (2026-05-22, screenshot for `Saltgrave Figure`): `Garrow`, a real distinct cast member, was wrongly folded into `Saltgrave Figure`'s aliases by the auto-fold step. Expected behaviour: open Saltgrave's profile → click X on the Garrow chip → modal lists the chapters where Garrow was originally detected → user reassigns Garrow's lines to the freshly-minted standalone Garrow character → manuscript view reflects the change.

## Out of scope

- **Deterministic sentence revert.** A merge journal (a sidecar JSON logging `{sourceId, sourceName, targetId, affectedSentenceIds}` at merge time) would let future un-links rewrite the exact sentences instead of relying on `chapterCast` as a lineage proxy. Worth a BACKLOG entry but not in this PR.
- **Bulk alias management.** No "Aliases Manager" modal across multiple characters at once — single-character chip edits cover the reported use case.
- **Re-running Phase 1 analysis on un-link.** Explicitly rejected (quota cost + destroys manual cast tweaks). The Reattribute Lines modal is the explicit user-driven alternative.
- **Cross-book alias migration.** Adding `Garrow` as an alias on this book does not retroactively update the matcher's behaviour against prior books. Future analyzer runs of *subsequent* books in the series will pick up the alias; for prior books the user would re-link via the existing `cast/link-prior` route.

## Ship notes

Shipped 2026-05-22 in PR [#142](https://github.com/dudarenok-maker/AudioBook-Generator/pull/142) — merge commit `57e082f`, feature commit `42334d8`. Behaviour matches the plan above; no deltas at ship.

Coverage at ship: 10 server vitest cases (`cast-aliases.test.ts`), 9 cast-slice cases, 9 profile-drawer cases, 7 reattribute-lines cases (new file), and 1 Playwright e2e (`cast-alias-edit.spec.ts`). E2e flaked once under the full `npm run verify` battery (passed on retry — same flake profile as the two pre-existing intermittent specs `listen-loudness-report` and `listen-rename-chapter`; covered by plan 45's `retry: 1`); passes cleanly in isolation.

Follow-up parked in `docs/BACKLOG.md`: a merge journal (`{sourceId, sourceName, targetId, affectedSentenceIds}` log written at merge time) would replace the `chapterCast`-as-lineage proxy with deterministic sentence revert — see the BACKLOG Should bucket.
