---
status: draft
---

# Marketing screenshots refresh (post-v1.9.0)

## Context

The curated marketing screenshot set — staged in the git-ignored
`brand/go-to-market/launch-post-images/marketing-site/screenshots/` and mirrored
into the separate `Castwright-Website` repo's `public/screenshots/` — hasn't been
refreshed since v1.9.0. Two full release cycles (v1.10.0, v1.11.0) have shipped
substantial, marketing-worthy features with zero screenshot or (in most cases)
copy presence on the site: five-language support, emotion-aware voices, the
Higher-quality tier, the Quality Gate (Suspect chapters, voice-drift detection,
and the new book-level QA receipt), and series memory (cast carried across a
series + a shareable portrait card).

v1.11.0 is expected to be cut shortly after this work lands, so the Quality
Gate story should capture its full current shape — not just the per-chapter
Suspect/drift surfaces from v1.10, but the new book-level QA report card
(`src/components/qa-report-card.tsx`, shown on the Listen view and live during
generation) that ships in v1.11.

The raw capture output directory, `mockups/marketing-screens/` (git-ignored,
regenerable via `npm run capture:marketing`), is itself stale from mid-June
(59 files, newest dated 2026-06-14) against the 64 scenes currently registered
in `e2e/marketing/scenes.ts` — a full re-run is needed regardless of what's
newly added (file count and scene count aren't 1:1 anyway, since capture
emits per-viewport/per-theme variants).

The website's `RoadmapSection.astro` currently lists "A per-book quality report"
as **Planned** — that shipped. This is the clearest concrete signal that the
site has drifted behind the product.

## Goals

1. Identify which shipped-since-v1.9.0 stories have no screenshot representation
   today, and which existing capture-rail scenes can be reused as-is.
2. Extend `e2e/marketing/scenes.ts` (and, where needed, the `src/mocks/marketing/`
   fixtures) to reach the states these stories need, for the ones with no scene
   yet.
3. Re-run the full capture set, curate a subset (existing ~15 plus the new
   story-driven additions), convert to webp, and stage them in
   `brand/go-to-market/launch-post-images/marketing-site/screenshots/`.
4. Leave a handover document briefing a follow-up agent on the website-repo
   side of this work — copy updates, roadmap flips, and where each new
   screenshot belongs — without doing that work here.

## Non-goals

- No changes to the `Castwright-Website` repo in this pass.
- No coverage for multi-GPU per-model placement, offline/local voice design, or
  other shipped-since-v1.9.0 features not in the approved story list — these
  are called out explicitly in the handover doc as *not* covered, not silently
  dropped.
- No redesign of the capture harness itself (`capture.spec.ts`,
  `playwright.marketing.config.ts`) — only additive scene/fixture entries.

## Story → scene mapping

| Story | Scenes | Rail work needed |
|---|---|---|
| Quality Gate + voice drift | `chapter-suspect`, `voice-drift-report`, `preview-flagged` (existing, per-chapter/per-character); new `qa-report-card` scene for the v1.11 book-level receipt (`src/components/qa-report-card.tsx`, surfaced on `listen.tsx` and live during `generation.tsx`) | Existing three scenes need no rail changes — re-capture for **both** themes (the wiki task that built them only exported light) and stage into the marketing folder. The new `qa-report-card` scene is additive; confirm it renders with realistic (non-zero, mixed-pass) figures under the marketing fixtures rather than an all-clean or empty state. |
| Five-language support | `language-detect-russian`, `language-cast-confirm-german` | None — re-capture only (stale since mid-June); roadmap copy for this story is already accurate. |
| Emotion-aware voices + Higher-quality tier | New: a manuscript/script-review scene showing a line with both an emotion chip (`sentence-emotion-control.tsx`, `data-testid="emotion-chip"`) and a delivery-direction chip (`sentence-instruct-control.tsx`, `data-testid="instruct-chip"`) set to real values; a cast-view scene for the "Pin higher quality" flow (`src/views/cast.tsx:778` button `data-testid="pin-higher-quality"`, confirm dialog at `:1561`) | New scenes. **Verified against the current fixture**: `src/mocks/marketing/coalfall-manuscript.json` already has 9 sentences with `emotion` set (`excited`/`angry`/`whisper`) — no fixture change needed for the emotion half. Only `instruct`/delivery-direction is missing from every marketing fixture; the fixture patch is narrower than originally scoped — add an `instruct` value to one of those already-emotional coalfall sentences, so a single line carries both chips. (`hollow-tide.ts` has neither field on its sentences and is not the right host.) |
| Series memory + shareable cast card | New: the series-memory reveal panel (opened via `series-memory-chip.tsx`, `data-testid="series-memory-chip"`); the exportable card (`src/components/series-memory/share-card-modal.tsx` / `series-share-card.tsx`) | New scenes **plus a required fixture/mock fix, not just new scenes**. **Verified**: `src/mocks/series-memory.ts`'s `MOCK_SERIES_MEMORY` has exactly one entry, keyed `'Marin Vale::Northern Coast Trilogy'` — the *dev-mock* library (`canned-data.ts`), not the marketing one. The marketing-mode resolver, `getSeriesMemory: async (a, s) => MOCK_SERIES_MEMORY[`${a}::${s}`]` (`src/lib/api.ts:8853`), has **no `DEMO_CAPTURE` branch at all** — under `DEMO_CAPTURE` the library's series is `'The Hollow Tide'` (`hollow-tide.ts:217`), so the lookup key is `'Marin Vale::The Hollow Tide'`, which doesn't exist and returns `undefined`. Without a fix, the reveal panel and share-card modal (which opens from it) will render **empty**, and `capture.spec.ts`'s best-effort try/catch means the scene captures green while producing a blank shot — the exact #1286 failure mode this spec's own Verification section warns about. **Fix required**: add a `'Marin Vale::The Hollow Tide'` entry to `MOCK_SERIES_MEMORY` (or add an explicit `DEMO_CAPTURE` branch to the resolver) before writing these two scenes. |

Exact selectors, any additional fixture wiring, and click sequences are
resolved during implementation planning, not here — the pattern to follow is
the same one the Quality Gate plan already proved out (additive
`DEMO_CAPTURE`-gated fixture changes, `strict: true` scenes with
`waitForAfterAction` so a selector drift fails loudly instead of silently
capturing the wrong state).

## Staging pipeline

Add `scripts/stage-marketing-screenshots.mjs`: a small script driven by a
manifest (scene id → output filename) that selects the curated subset from
`mockups/marketing-screens/`, converts each to `.webp` via ffmpeg (quality 85,
matching the site's existing convention), and writes both theme variants into
`brand/go-to-market/launch-post-images/marketing-site/screenshots/`. This
replaces whatever ad hoc process produced the current set and makes the next
refresh a one-command job instead of a from-scratch audit like this one.

## Verification

For every new or re-captured scene that feeds this pass, read the actual PNG
(not just confirm the capture run exited green) and check the specific claim
it's supposed to prove — e.g., "both the emotion chip and delivery-direction
chip are visibly set on this line," "both carried voices show in the reveal
panel," "the confirm dialog, not just the triggering button, is in frame,"
"the QA report card shows realistic mixed figures, not an all-zero or
all-clean placeholder state." `capture.spec.ts`'s scenes wrap their `action` in
a best-effort try/catch, so a green Playwright run on its own proves nothing
about correctness — this bit the Quality Gate plan (#1286) once already.

## Testing

This work touches real behavior, not just docs — the `getSeriesMemory`
fixture fix, any `instruct` fixture addition, and the new
`scripts/stage-marketing-screenshots.mjs` all need paired automated tests per
CLAUDE.md's testing discipline, following existing precedent: a
`DEMO_CAPTURE`-gated resolver change gets a Vitest case the way the Quality
Gate plan's `src/lib/api-demo-capture.test.ts` covered `mockGetChapterAudio`/
`mockPollRevisions`; a new `scripts/*.mjs` gets a colocated
`scripts/tests/*.test.mjs` the way other scripts in this repo already do (e.g.
`scripts/build-release-zip.mjs` → `scripts/tests/release-manifest.test.mjs`).
The manual PNG-read verification above is necessary but not sufficient on its
own.

## Branch / PR scope note

This work is not docs-only — it lands changes under `e2e/`, `src/mocks/`, and
a new `scripts/*.mjs`, none of which qualify for CLAUDE.md's docs-only
code-review exemption or CI fast-path. The eventual PR should carry a
non-`docs` commit type (the initial spec commit on this branch was `docs`,
which was correct for the spec-only commit itself, but the implementation
commits that follow are `feat`/`chore`-scoped) and, since it spans multiple
scopes (`e2e`, `mocks`, `scripts`), the mandatory independent PR review runs
at the `high` effort tier per the model-routing table's multi-scope rule.

## Handover doc

Write `brand/go-to-market/marketing-screenshots-handover-2026-07-08.md`
(git-ignored, matching the rest of `brand/`) for a follow-up agent working in
`Castwright-Website`. Contents:

- Which roadmap card(s) to flip off "Planned" — at minimum "A per-book quality
  report."
- A mapping of each new screenshot to the page/section it likely belongs on.
- Honest-copy notes per new story, drawn from the already-written
  `RELEASE_NOTES.md` language rather than reinvented from scratch.
- An explicit "not covered by this pass" list (multi-GPU placement, offline
  voice design, etc.) so it isn't assumed handled.

## Out of scope until told otherwise

- Editing `Castwright-Website` directly.
- New capture-rail scenes for stories outside the four approved above.
