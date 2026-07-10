# Library header book-count copy fix

Issue: #1461 — "Library header hardcodes 'carry through to book seven' — inconsistent with the six-book series story"

## Problem

`src/components/library/library-chrome.tsx:100` hardcodes a specific book number in the library welcome subhead:

> Voices stay consistent across a series — characters who appear in book one carry through to book seven.

This is fixed copy shown to every user regardless of how many books they actually have, and it reads oddly for anyone whose library isn't seven books deep. It's also internally inconsistent with the same screen's series-memory chip and reveal/share-card copy, which say "5 voices, 6 books" / "Six books in, not a voice changed."

## Fix

Make the line number-agnostic instead of picking a different hardcoded number, so it stays true for every library regardless of size:

```diff
- — characters who appear in book one carry through to book seven.
+ — characters who appear in book one carry through, book after book.
```

No data derivation needed — this is static copy, not tied to any per-user book count.

## Scope

Single-line JSX text change in `library-chrome.tsx`. No component logic or props are affected. No unit/component test asserts this exact string (`library-chrome.test.tsx` has no match on it).

This string is also captured by two screenshot suites, since the subhead sits above the fold on the library view (`#/`):
- `e2e/responsive/visual.spec.ts` — `library` / `library (dark)` (`toHaveScreenshot('library.png'/'library-dark.png')`)
- `e2e/marketing/scenes.ts` — `library-shelf` (desktop/phone/tablet) and `library-shelf-full` (desktop, full-page)

## Testing

**Not currently gated by CI.** `e2e/responsive/visual.spec.ts` skips its whole `describe` block on any platform without a committed baseline directory (`visual.spec.ts:50-58`), and only `e2e/win32/...` baselines are committed today — `e2e/linux/...` doesn't exist yet (that's the separate, in-flight `regen-visual-baselines.yml` initiative). PR CI runs on Ubuntu, so the `e2e-visual` job in `verify.yml` reports `library`/`library (dark)` as skipped regardless of this change.

**Locally verified across all three Playwright projects:** ran `npx playwright test --project=chromium --workers=1 e2e/responsive/visual.spec.ts -g library --update-snapshots`, then `npx playwright test --project=mobile-chrome --project=tablet-chrome --workers=1 e2e/responsive/visual.spec.ts -g library --update-snapshots` — all within the suite's `maxDiffPixelRatio: 0.05` tolerance (`visual.spec.ts:92`).
- `chromium` and `mobile-chrome`: zero diff, no baseline files touched.
- `tablet-chrome`: `library.png` (light theme only) *did* drift and was regenerated — at that viewport width the paragraph still wraps to two lines but the new copy shifts a couple of pixels; committed the regenerated baseline alongside the source change. `library-dark.png` was unaffected.

CI doesn't exercise `mobile-chrome`/`tablet-chrome` at all (`verify.yml` has no mobile/tablet e2e job), so this was purely a local-dev-loop check — but it caught a real baseline drift the `chromium`-only check would have missed, now folded into this change instead of left stale.

**Deferred, by explicit decision:** `e2e/marketing/scenes.ts`'s `library-shelf` / `library-shelf-full` scenes render the same header; regenerating them is being handled separately, not in this change.

Otherwise: visual/manual check that the subhead reads correctly.
