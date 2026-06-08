# Castwright Wave 2 — On-ramp + listener touchpoints (plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Tasteful brand presence at the moments that matter — empty library, upload, Listen header, share modals, and the analysing/generation screens. Reuse the existing `<CastwaveMark/>` (`src/lib/icons.tsx`). Brand rules: the **primary tagline is fixed wording** ("Any book, performed by a full cast — effortlessly. Even in your own voice."); short form "Any book, fully cast."; manifesto "Many voices, one machine."; **Magenta = brand, Peach = action only**.

**Source of truth:** `docs/superpowers/specs/2026-06-08-castwright-brand-full-pass-design.md` (Wave 2).

Shared strings (use verbatim):
- Short form tagline: `Any book, fully cast.`
- Manifesto: `Many voices, one machine.`
- Listen line: `Full-cast audiobook · made with Castwright`
- Share attribution: `Made with Castwright · castwright.ai`

---

## Task 1 — On-ramp (empty library + upload)

**Files:** `src/components/library/library-empty-states.tsx`, `src/views/upload.tsx`. Tests: `src/views/book-library.test.tsx` (covers EmptyLibrary) or a new `library-empty-states.test.tsx`; `src/views/upload.test.tsx`.

- [ ] **Empty library** (`library-empty-states.tsx`, `EmptyLibrary`):
  - Replace the `<IconPlus/>` inside the round badge with `<CastwaveMark className="w-8 h-8" aria-hidden="true" />` and change the badge color from peach to brand: `bg-magenta/10 text-magenta` (Castwave is brand, not action). Import `CastwaveMark` from `../../lib/icons`.
  - Add a tagline sub-headline directly under the `<h3>Your library is empty</h3>`: `<p className="mt-2 text-sm text-ink/60">Any book, fully cast.</p>`.
  - **Fix the stale path:** in the `<code>` block change `audiobook-workspace/books/…` → `castwright-workspace/books/…` (Wave 0 renamed the default workspace dir).
  - Keep the "Import your first book" CTA button exactly as-is (peach/dark action is correct).
- [ ] **Upload** (`upload.tsx` ~line 215, the non-reupload branch): add a quiet subtitle between the `<MixedHeading … bold="meet the cast" />` block and the existing `<p className="mt-4 text-lg text-ink/70">`: `<p className="mt-3 text-sm text-ink/60">Any book, fully cast.</p>`. Do NOT add it to the reupload branch (keep that focused on "see what changed").
- [ ] **Tests (TDD):** add to `book-library.test.tsx` (or new `library-empty-states.test.tsx`) an assertion that the empty state renders "Any book, fully cast." and that the example path reads `castwright-workspace`. Add to `upload.test.tsx` an assertion the new-project headline area shows "Any book, fully cast." (and NOT on reupload). Watch fail → implement → pass.
- [ ] `npm run typecheck`; commit `feat(frontend): brand the empty-library + upload on-ramp (Castwave mark + tagline)`.

## Task 2 — Listener + share surfaces

**Files:** `src/components/listen/listen-header.tsx`, `src/modals/share-clip.tsx`, `src/modals/share-link.tsx`. Tests: `listen-header.test.tsx`, `share-clip.test.tsx`, `share-link.test.tsx`.

- [ ] **Listen header** (`listen-header.tsx`): after the credit `<p className="mt-3 text-ink/70">…</p>` block (closes ~line 238), add a quiet brand line:
  ```tsx
  <p className="mt-2 text-xs text-ink/50">Full-cast audiobook · made with Castwright</p>
  ```
- [ ] **Share-clip** (`share-clip.tsx`): in the footer row (`px-6 py-4 border-t …`, ~line 339), add a left-aligned attribution so the buttons stay right: change the footer to `justify-between` and prepend `<span className="text-[11px] text-ink/40">Made with Castwright · castwright.ai</span>` before the Cancel/Download buttons (wrap the two buttons in a `<div className="flex items-center gap-3">`). Keep `data-testid="share-clip-confirm"` intact.
- [ ] **Share-link** (`share-link.tsx`): in the footer (`px-6 py-4 border-t …`, ~line 171) do the same — `justify-between`, prepend the `Made with Castwright · castwright.ai` span (text-[11px] text-ink/40), keep the `Done` button right.
- [ ] **Tests (TDD):** `listen-header.test.tsx` asserts "made with Castwright" renders. `share-clip.test.tsx` + `share-link.test.tsx` assert the attribution line renders without breaking existing button/testid assertions. Watch fail → implement → pass.
- [ ] `npm run typecheck`; commit `feat(frontend): brand the Listen header + share modals (made with Castwright)`.

## Task 3 — Processing screens (analysing + generation)

**Files:** `src/views/analysing.tsx` (~line 974), `src/views/generation.tsx` (~line 791). Tests: `analysing.test.tsx`, `generation.test.tsx`.

- [ ] **Analysing** (`analysing.tsx`): after the description `<p className="mt-4 text-ink/70">…</p>` add a brand-voice manifesto line: `<p className="mt-2 text-sm text-ink/50">Many voices, one machine.</p>`.
- [ ] **Generation** (`generation.tsx`): after the `{completed} of … chapters complete` `<p className="mt-3 text-ink/60">` add `<p className="mt-1 text-sm text-ink/50">Many voices, one machine.</p>`.
- [ ] **Tests (TDD):** add an assertion in each view's test that "Many voices, one machine." renders during the analysing / generation stage. Watch fail → implement → pass. (These test files are large — add focused new `it(...)` cases; do not restructure existing tests.)
- [ ] `npm run typecheck`; commit `feat(frontend): brand-voice subtitle on analysing + generation screens`.

## Task 4 — Verify + PR

- [ ] `npm run verify` green.
- [ ] Push `feat/castwright-onramp-touchpoints`; `gh pr create` with `Refs #631` (Wave 2); body links spec + this plan.

## Notes
- Reuse `<CastwaveMark/>` — do NOT inline new SVGs. Color it `text-magenta` (brand), never peach.
- Keep additions minimal and quiet (small, muted text) — the look stays pixel-stable elsewhere.
- Primary tagline is fixed wording; only use the approved short form / manifesto strings above.
