---
status: stable
shipped: 2026-05-22
owner: null
---

# Merge cast duplicates from the Voices selection pill

> Status: stable
> Key files: `src/views/voices.tsx`, `src/lib/voice-character-link.ts`, `src/styles.css`
> URL surface: `#/voices` (global) and `#/books/<id>/library` (per-book)
> OpenAPI ops: reuses `POST /api/books/{bookId}/cast/merge` (defined for plan 10's profile-drawer flow)

## Benefit / Rationale

- **User:** Spotting a roster duplicate like "Wren" + "Wren Sparrow" under the same base voice (`af_aoede`) used to require opening one character's profile drawer, scrolling its merge picker, and selecting the other by name — fine when you know the duplicate exists, terrible for discovery. The Voices view is the only screen that surfaces same-base-voice duplicates side-by-side; promoting Merge onto its selection pill makes the duplicate visually obvious AND collapse-able in two clicks.
- **Technical:** Zero new transport — `api.mergeCharacters` + `castActions.applyMerge` already exist (`src/lib/api.ts:209`, `src/store/cast-slice.ts:100`) and the OpenAPI `Character.aliases[]` schema explicitly anticipates this use case ("Populated when the user merges a duplicate roster entry"). One new pure helper (`pickMergeSurvivor`) and one button.
- **Architectural:** Establishes the Voices pill as a multi-action surface (Compare + Merge + Clear) without breaking the Compare contract from plan 22a / plan 96. Tighter gating (same book, same base voice, non-bucket / non-narrator) than Compare — cross-book merges have no server route and would silently corrupt; same-base-voice is what makes the duplicate inference safe.

## Architectural impact

- **Survivor heuristic** (`src/lib/voice-character-link.ts`): a new pure `pickMergeSurvivor(a, b)` orders two characters by (1) substring containment of one trimmed lowercase name in the other → containing name wins, (2) longer trimmed name wins, (3) stable tiebreaker keeps the first-passed character. The voices pill renders selection in click order, so the user can re-select to flip the survivor when names tie.
- **Pill gating** (`src/views/voices.tsx` — `compareDerivations` memo): Merge button shows only when `selectedVoiceIds.length === 2 && badge === 'same'`. It's `disabled` (not hidden) when same-base-voice but cross-book or narrator/bucket, with `mergeDisabledReason` driving a tooltip. Compare keeps its existing semantics (cross-book allowed via plan 96).
- **Dark-mode contrast bug** in `.floating-pill-inverse` (`src/styles.css`): the existing rule pins the pill backdrop to literal `#14110f` and the pill-level `color` to `#f4efec` in dark mode, but Tailwind's `text-canvas` / `bg-canvas/N` utilities on descendants flip with the theme variable and override the inherited cream colour — painting dark-on-dark. Added descendant overrides scoped to `.floating-pill-inverse` only; fixes the voices pill AND the cast-view pill which uses the same shell.
- **No new redux action, no slice change, no API change, no OpenAPI change.** Reuses `applyMerge`'s existing local-state-preservation contract (voiceId, matchedFrom, voiceState are kept on the survivor; `aliases` arrives on the new server response).

## Invariants to preserve

- `Character.aliases?: string[]` schema comment in `src/lib/api-types.ts:2034-2042` documents the merge contract — the survivor accumulates source names as aliases. Server is authoritative; we don't compute aliases client-side.
- `applyMerge` in `src/store/cast-slice.ts:100-118` preserves `voiceId / matchedFrom / matchFactors / voiceState` on each surviving character because the server's character list doesn't carry those fields. Do not regress this — the voices-pill merge MUST funnel through the same reducer.
- `UNMERGEABLE_IDS = { narrator, unknown-male, unknown-female }` (`src/views/voices.tsx`) mirrors the local constants at `src/modals/profile-drawer.tsx:110-112` and the bucket/narrator guards at `src/modals/profile-drawer.tsx:204-205`. If those ids ever change, update both call sites.
- `.floating-pill-inverse` (`src/styles.css:410+`) is the only place inner pill colours get pinned in dark mode; do not reintroduce raw `bg-ink text-canvas` on a pill that needs to read dark in both themes. The cast-view pill at `src/views/cast.tsx:439` shares this class on purpose.

## Test plan

### Automated coverage

- Vitest unit (`src/lib/voice-character-link.test.ts` — `describe('pickMergeSurvivor')`) — covers substring rule, longer-name rule, and the stable tiebreaker.
- Vitest unit (`src/views/voices.test.tsx` — `describe('LibraryView merge-cast-duplicates affordance (plan 98)')`, kept as-is on archive for historical accuracy at ship-time) — covers:
  - Merge button appears with `Merge into <longer-name>` label on 2× same-voice same-book selection.
  - Merge button hidden on a cross-book pair (even with same base voice).
  - Merge button hidden on a different-base-voice pair.
  - Merge button hidden when narrator/bucket id is one of the two selected.
  - Click dispatches `api.mergeCharacters({ bookId, sourceId: shorter, targetId: longer })`, then `castActions.applyMerge`, then clears selection.
- E2E (`e2e/voices/*.spec.ts`) — none in this PR. The Compare flow on the same pill also has no e2e spec; treat both as a single follow-up once an e2e fixture file is established.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`) at `#/voices` for the global path, or `#/books/<id>/library` for the per-book path.

1. Open `#/voices`. Find the `af_aoede` (Kokoro) or `Charon` (Gemini) family with two characters sharing one base voice (mock canned data may need a quick edit to seed a duplicate pair).
2. Click the radio circles on `Wren` + `Wren Sparrow` (same `bookId`). Pill renders `Selected · 2 · same base voice ✓ · Compare · Merge into Wren Sparrow · Clear`.
3. Click `Merge into Wren Sparrow`. Toast appears: `Merged "Wren" into "Wren Sparrow".`. Pill collapses. The standalone `Wren` card disappears from the family. Open Wren Sparrow's profile drawer (click the card) → `Wren` shows as an alias chip in the drawer's alias section.
4. Toggle to dark mode (the existing theme toggle in the top bar). Re-select two duplicate cards. Confirm the `Selected` label, the `2` count badge, the Compare button enabled fill, the Merge button enabled fill, and the `Clear` text all read at full contrast against the dark pill backdrop — no dark-on-dark wash.
5. Cross-book pair: select one Wren from book A + one Wren from book B (same base voice). Pill shows `same base voice ✓` and Compare stays enabled (plan 96), but `Merge into ...` button is **hidden**.
6. Different-base-voice pair: select Wren (Charon) + Oduvan (Kore). Pill shows `different base voices`. Merge button **hidden**. Compare stays enabled across families.
7. Narrator-included pair: select Narrator + Wren Sparrow, both same base voice. Pill shows `same base voice ✓`, Compare enabled, Merge button **hidden** (narrator is in `UNMERGEABLE_IDS`).

## Out of scope

- Renaming the survivor to a third user-typed name ("Wren Sparrow (Lost Cities)"). Use the existing profile-drawer flow after the merge.
- Three-way merge in one click. Iterate two at a time — the pill already enforces 2× selection.
- Undo. The existing profile-drawer merge (`src/components/layout.tsx:1071-1072`) has no undo either; introducing one would need server work and is out of scope.
- E2E spec. The Compare flow on this same pill ships without one; both should land together as a follow-up once `e2e/voices/` has a baseline file.

## Ship notes

- **Shipped:** 2026-05-22 via PR #167, merge commit `77a9a89`.
- **No spec delta from the active plan.** Survivor heuristic, pill gating, dark-mode descendant CSS, and all five voices.test.tsx cases shipped exactly as drafted.
- **Bundled bug fix:** the `.floating-pill-inverse` dark-mode descendant overrides land in the same commit. The bug existed since plan 96 introduced the shell class; was tolerated until the Voices view added a third button (Merge) and the user pointed at the contrast on the existing Compare/Clear pair.
- **Tests landed and green:** 3 new cases in `src/lib/voice-character-link.test.ts` (`pickMergeSurvivor`), 5 new cases in `src/views/voices.test.tsx` (`describe('LibraryView merge-cast-duplicates affordance (plan 98)')` — kept as-is for historical accuracy at ship-time). Full battery `npm run verify` green on Linux CI; the two flaky Windows-only baselines (`analysing-dark.png`, `confirm-dark.png`) cleared per [feedback_visual_baselines_flaky_on_windows.md].
- **No follow-up surfaced.** Out-of-scope items (e2e spec, undo, three-way merge, renaming survivor to a typed third name) remain explicitly out of scope; none has appeared on the BACKLOG.
