---
status: stable
shipped: 2026-05-21
owner: dudarenok@gmail.com
---

# 84 — Manuscript-diff rename guard for re-upload

> Status: stable
> Key files: `src/lib/chapter-override-conflict.ts`, `src/views/upload.tsx`, `src/components/manuscript-diff.tsx`, `src/store/chapters-slice.ts`
> URL surface: `#/upload` (re-upload diff modal)
> OpenAPI ops: none (the override clear is a local slice mutation; the server's state.json round-trip refreshes the title on the next PUT)

## Benefit / Rationale

- **User:** when you re-upload a manuscript that shifts chapter content (e.g. you split chapter 1 into two), the diff modal now flags any chapter renames (plan 78's `titleOverridden`) that point at content that no longer matches. On apply, the conflicting overrides are cleared so the new manuscript's parsed titles win — your manually-renamed chapter doesn't silently mis-attribute onto someone else's content. Closes BACKLOG (was unnumbered, between Could #19 and the Won't bucket).
- **Technical:** new pure helpers `detectOverrideConflicts` + `scanCandidateChapters` in `src/lib/chapter-override-conflict.ts`. The client-side chapter-heading scan (markdown `#` + "Chapter N" patterns) gives the modal a candidate chapter list before the server's authoritative parse runs at analyse time.
- **Architectural:** auto-drop-on-apply is the conservative v1 strategy — clears renames that may mis-attribute, leaves un-conflicting overrides alone. Per-row keep/drop selection is deferred (would need richer modal UX and is incremental on top of this seam).

## Architectural impact

- **New helper** `src/lib/chapter-override-conflict.ts` — pure, no slice dependency. Exports `scanCandidateChapters(text)` (markdown + Chapter N heading detection) and `detectOverrideConflicts(old, new)` (returns conflict rows for renames that drifted).
- **New reducer** `chaptersActions.clearOverrides({ chapterIds })` — sets `titleOverridden=false` on the listed chapter ids. Title text is left as-is (the PUT-state round-trip + re-parse refresh it).
- **`src/views/upload.tsx`** — `handleDiffApply` dispatches `clearOverrides` before `applyReupload` when conflicts are non-empty. Conflicts are computed via a `useMemo` against the chapters slice and the candidate source text.
- **`src/components/manuscript-diff.tsx`** — new optional `overrideConflicts` prop renders an amber banner above the sentence diff list, listing up to 5 conflicts plus an "and N more" overflow line.
- **No openapi change, no new server route.** The slice mutation is local; the state.json PUT cycle (existing plan 27 path) carries the flipped flag back to disk on the next manuscript-slice commit.

## Invariants to preserve

1. `detectOverrideConflicts` is pure — no slice/state dependency. Unit-testable in isolation (`src/lib/chapter-override-conflict.test.ts`).
2. `scanCandidateChapters` always returns at least one chapter (synthetic `Chapter 1` fallback when no headings parse) so callers never have to handle empty input.
3. `clearOverrides` only flips `titleOverridden` — the chapter's `title` text stays put. The server-side re-parse + state.json round-trip is the source of truth for the title after the override clears.
4. The conflict banner renders ONLY when `overrideConflicts.length > 0`. No banner = no conflicts detected = safe to apply.
5. The auto-drop happens BEFORE `applyReupload` so the chapter slice's flag flips while the chapter title is still the old override (debuggability — the audit trail in state.json shows the override was active just before the manuscript swap).

## Test plan

### Automated coverage

- `src/lib/chapter-override-conflict.test.ts` — 7 cases:
  - `scanCandidateChapters` — empty fallback, markdown headings, "Chapter N" patterns case-insensitive (3).
  - `detectOverrideConflicts` — no-conflict baselines (no overrides, override-title-still-matches), conflict on insert-shifted ids, conflict on dropped slot, deterministic ordering (4).
- `src/store/chapters-slice.test.ts` — new "chaptersSlice — clearOverrides (plan 84)" suite, 4 cases:
  - clears `titleOverridden` on listed ids; preserves others.
  - empty id list = no-op.
  - non-existent ids ignored.
  - title text is preserved through the flip.
- Existing slice + view tests continue green.

### Manual acceptance walkthrough

1. Open a book with 3 chapters. Rename chapter 2 via the pencil affordance (plan 78). State.json now carries `titleOverridden: true` on id 2.
2. Re-upload a manuscript that splits chapter 1 into two (so the original chapter 2 content is now at position 3).
3. The diff modal opens with the sentence diff. An amber banner above the sentence list shows "1 renamed chapter does not match the new manuscript", listing your renamed chapter 2 and pointing at the new heading at position 2.
4. Click Apply → modal closes, chapter slice's chapter 2 has `titleOverridden=false`. State.json PUT lands; the next book-state hydrate shows the new manuscript's chapter titles in place of your old override.

## Out of scope

- Per-row keep/drop picker — v1 auto-drops every flagged conflict. A follow-up could add a radio per row; the modal already has the conflict list ready to expand into UI controls.
- Authoritative server-side chapter parse at re-upload time — would catch more edge cases than the client-side heuristic in `scanCandidateChapters` (e.g. headings the heuristic missed), but requires a new endpoint or a re-parse pass in `previewReuploadDiff`.
- Migration / undo — clearing the override is one-way through this flow. Users wanting to restore a rename use the existing rename modal (plan 78) after the re-upload commits.

## Ship notes

Shipped 2026-05-21 — closes the BACKLOG entry that gated plan 78's graduation to stable. Plan 78 → stable + archived in the same diff. Bundles the bump-version.test.mjs env-leak fix from plan 85 defensively so pre-commit hooks pass on a fresh worktree.
