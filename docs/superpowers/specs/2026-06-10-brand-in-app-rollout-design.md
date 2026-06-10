# Brand-in-app rollout — v1.7.0 wave (design spec)

**Date:** 10 June 2026
**Status:** draft — awaiting user review before plan
**Source plan:** `brand/brand-in-app-plan-2026-06-10.md` (brand-side master, local-only)
**Brand decisions of record:** `brand/BRAND_CHANGELOG.md` (2026-06-10 entry, v2 of the brand system)

## What this is

The work to land the 10 June brand decisions *inside the application*, plus the
gaps the audit found (no real `/about` page, placeholder release notes, no
single source for brand strings). Scope confirmed with the user as **Must +
Should** (plan items 1–9). This is a copy / assets / links wave — no visual
redesign, no backend feature work.

## Why now

The SVG brand masters were refreshed on 10 June, but the committed
`public/og.png` and favicons were rendered from the **pre-refresh** masters. So
every link preview and browser tab currently ships the *retired* tagline and the
`.ai` lockup. This isn't cleanup — the app is actively broadcasting dead brand
until item 3 lands. That item leads the wave.

## Decisions of record

Confirmed with the user (10 June):

1. **Scope:** Must + Should (items 1–9).
2. **/about content outline:** approved as-is (the 7-block table below).
3. **Brand strings:** single-sourced in a new `src/lib/brand.ts`.
4. **Release-notes link target:** **in-app**, not a GitHub URL — the repo is
   still private, so alpha testers can't open a GitHub Releases page. A GitHub
   link gets added later at the public flip.
5. **Release-notes register (user direction):** the in-app notes are written in
   **brand voice for listeners/readers** — benefit-framed, no technical detail,
   no version-soup. Technical readers go to GitHub. Two registers, two doors.
6. **Notes are written + shipped in this wave** (user direction) — not merely
   drafted in this spec. The v1.7.0 notes become real, visible artifacts so the
   voice can be reviewed in the running app.
7. **Release gates enforce real notes** (user direction) — placeholder notes must
   be unable to reach a published release, at both the tag-creation gate
   (`bump-version.mjs`) and the publish gate (`release.yml`).

### Two-register file mapping (the repo already separates them)

| File | Audience / register | Surface | This wave |
|---|---|---|---|
| `RELEASE_NOTES.md` | **Users — brand voice** | Bundled in the zip; rendered by the in-app `#/release-notes` route | Replace the `v9.9.9` placeholder with real v1.7.0 brand-voice notes |
| `docs/release-notes-next.md` | **Technical** (`## Features` headers per CONTRIBUTING) | Fed to `bump-version --notes-file` → tag annotation → GitHub Release body | Complete it: all ~10 v1.7.0 plot points in the technical register |

Structural decisions made by default (per repo scope-discipline; flagged for
override):

- **A — Two PRs.** Items 1–8 are `frontend`/`ops` scope → one integration branch
  `feat/frontend-brand-v2-rollout`, verified once, one PR. **Item 9 is Flutter
  (`app` scope)** → a separate timeboxed audit branch that opens its own
  follow-up only if it finds breaches. The frontend wave does not block on it.
- **B — In-app notes mechanism.** A new `#/release-notes` route (registered in
  the router grammar beside `about`/`advanced`/`models`) renders the bundled
  `RELEASE_NOTES.md`, linked from *Account → Application updates* and the
  `/about` "What's new" block.

## Grounding facts (verified against the repo, 10 June)

- Old tagline is live in `src/views/about.tsx:23`, verbatim as the audit reported.
- New binding tagline (`…kept true, kept yours, book after book`) and all v2
  rules are locked in `BRAND_CHANGELOG.md`.
- Both asset masters exist: `brand/castwright-og.svg`, `brand/castwright-glyph.svg`.
- Both release-notes files are placeholders: `RELEASE_NOTES.md` = `v9.9.9` stub;
  `docs/release-notes-next.md` covers only fs-42.
- Current version is **1.6.0** (`package.json`); the notes target **1.7.0**.
  **The actual `1.6.0 → 1.7.0` tag is a separate release act, not part of this
  PR** — this wave drafts the notes and adds the bump guard.
- Item 7's device signal already exists: the sidecar `/health` returns a
  `device` field (`cuda`/`mps`/`cpu`), surfaced by `probeSidecarHealth()` as
  `result.device` (`server/src/routes/sidecar-health.ts`). No new endpoint.
  (`server/src/routes/devices.ts` is a name-collision — companion tokens, not
  hardware.)
- Router grammar (`src/lib/router.ts`) already cases `about`/`advanced`/`models`;
  `release-notes` slots in the same way.
- `scripts/bump-version.mjs` already accepts `--notes-file <path>` and, when
  absent, tags with a **placeholder annotation** behind only a soft `[NOTE]`
  reminder — no hard gate. `--cleanup=verbatim` preserves `##` section headers.
- `.github/workflows/release.yml` reads the tag annotation (`%(contents)`) into
  `release/tag-notes.md` and publishes it as the GitHub Release body; a comment
  concedes "the body will be brief — that's expected" for placeholder tags.
  No step currently rejects placeholder notes.

## The work, in landing order (one PR, items 1–8)

`brand.ts` (item 2) lands **first** in the branch so every later item diffs
against constants, not string literals — this keeps snapshot churn contained.
Item 3 (assets) is the most urgent by impact and can land in parallel.

### Item 2 — `src/lib/brand.ts` (single source)
Export `TAGLINE`, `TAGLINE_SHORT` ("Any book, fully cast."), `MANIFESTO`,
`TEASER` plus its mandatory in-development flag text, and `DOMAIN`. Refactor the
six current literals (`about.tsx`, `library-empty-states.tsx`, `upload.tsx`,
`analysing.tsx`, `generation.tsx`, the share modals) to import them. Tests assert
against the constants, never against copied strings.
*Benefit (architectural):* the next brand change is a one-line diff.

### Item 3 — re-render public assets
Re-run `scripts/render-brand-pngs.mjs` against the corrected
`brand/castwright-og.svg`; extend it to render `favicon-16/32` (and the shipped
`favicon.svg`) from `brand/castwright-glyph.svg` per the ≤32px rule; larger icons
stay on the full mark. Verify Android launcher icons are untouched (source
unchanged).
*Benefit (brand):* retired copy stops shipping in every share + tab.

### Item 1 — rebuild `/about`
Approved 7-block order:

| Block | Content | Source |
|---|---|---|
| Identity | Castwave mark · new tagline · manifesto | guidelines §2 |
| What it is | 2–3 sentences, house register, incl. the Apple-Silicon hardware-honesty line | guidelines §3 |
| Coming next | *Even in your own voice* — **with the "In development" flag** | guidelines §2 teaser rule |
| Credits | "Voices by Kokoro, Coqui XTTS and Qwen3-TTS" — named + linked | guidelines §3 |
| Licence | One line: source-available (FSL-1.1-Apache-2.0), link to LICENSE/NOTICE | repo LICENSE |
| What's new | version + sha (exists) **+ link to `#/release-notes`** | build-info + item 5 |
| Alpha ask | The narrative's call: more testers, esp. Apple Silicon / non-NVIDIA, with the contact/issues path | `project-narrative.md` |

*Benefit (user/brand):* the only in-product explanation of the product stops
being a stub, and the teaser stops breaching its own honesty rule.

### Item 4 — neutral tokens
Add the six §5 neutrals to `src/styles.css` (`--ink-soft #4A4440`,
`--ink-mute #5A534E`, `--line #D9CFC7`, `--line-soft #EEE2DA`,
`--canvas-mute #CFC8C2`, `--peach-ink #5A2417`) and reference them from
`tailwind.config.ts`; sweep component code for hardcoded near-greys that should
adopt them.
*Benefit (technical):* closes guidelines §9 open item; one neutral vocabulary.

### Item 5 — release notes, written + linked + gated
1. **Write `RELEASE_NOTES.md`** with the real v1.7.0 **brand-voice** notes
   (listener audience, outcomes not mechanics) — shipped in this wave so they're
   visible in-app immediately. Draft below for voice review.
2. **Complete `docs/release-notes-next.md`** with the full ~10-point v1.7.0
   changelog in the **technical** register (`## Features` headers per
   CONTRIBUTING) — this is the GitHub Release body source, not user-facing.
3. **`#/release-notes` route** renders the bundled `RELEASE_NOTES.md`; "What's
   new" links it from *Account → Application updates* and `/about`.
4. **Release gate, two points:**
   - `bump-version.mjs` — refuse to tag a real release when `RELEASE_NOTES.md`
     is still the placeholder, or when no real `--notes-file` is supplied
     (the soft `[NOTE]` reminder becomes a hard pre-flight failure). `--dry-run`
     and an explicit escape hatch (`--force`) remain.
   - `release.yml` — add a guard step that fails the publish if the resolved
     notes (`tag-notes.md` and/or the bundled `RELEASE_NOTES.md`) are a
     placeholder, so a hand-cut tag bypassing `bump-version.mjs` still can't
     publish empty notes.
*Benefit (user):* testers see what changed without archaeology; the update flow
stops dead-ending. *Benefit (release-safety):* a placeholder can no longer reach
a published release by any path.

#### Draft — in-app v1.7.0 notes (for voice review)

> **Castwright 1.7.0**
>
> **It runs on a Mac now.** Apple Silicon is a first-class home for Castwright —
> it finds your Mac's graphics on its own, no setup, no drivers. (Intel Macs
> work too, just slower.)
>
> **Your whole cast can act.** Design expressive, emotion-aware voices for every
> character in one pass — not just your leads. Each performance stays true from
> the first chapter to the last.
>
> **Long books you can walk away from.** Big manuscripts now ride out the rough
> patches on their own and keep going, so a full performance finishes while
> you're doing something else.
>
> **Take your library with you.** Pair your phone in one scan and listen
> offline, with chapters, progress and playback speed that follow you.
>
> **Smaller things that add up.** Smarter cover search, cleaner exports, and a
> new place to tune the finer settings when you want to.

*Voice notes:* no "effortlessly"/"seamless"; "performed"/"perform" not
"narrate"; outcomes over mechanics; licensing/CLA/repo-paperwork plot points are
deliberately **omitted** (not user-facing — they live in the GitHub changelog).

### Item 7 — "Will it run on my machine?" device panel
A small panel (first-run / Account → Models) showing the detected device read
from `health.device` (CUDA / `mps` / CPU) with the honest per-platform line
("a gaming PC or laptop with an 8 GB GPU, or any Apple Silicon Mac"). Audit the
in-app GPU-not-detected error strings for NVIDIA-only phrasing.
*Benefit (user):* filters support pain before it arrives.

### Item 8 — teaser governance test
A grep-style test: any rendered occurrence of "Even in your own voice" must carry
the in-development flag within the same component. Inverts when fs-38 ships (flag
must then be *gone*).
*Benefit (brand):* the teaser rule survives contributors who never read the guidelines.

### Item 6 — verification gate (woven through, not a final step)
Paired tests per repo discipline: `about.test.tsx` updated to the new content;
brand coverage asserts the new tagline everywhere via `brand.ts`; teaser-flag
unit test; og/favicon regenerated (hash or dimension check in the render
script's test); neutrals present in `styles.css`; `#/release-notes` renders.
**Release-gate tests** (extend `scripts/tests/bump-version.test.mjs`): the
placeholder guard rejects a tag when `RELEASE_NOTES.md` is the stub / no real
notes file; a real notes file passes. The `release.yml` guard step gets a
unit-testable predicate (placeholder-detection helper) with its own test. End on
`npm run verify` green.

## Separate track (item 9 — `app` scope, own PR)

Timebox to ~1 hour: audit the Flutter companion's surfaces (pairing, library,
player) against the same checklist — tagline / short-form usage, no `.ai` in
lockups, engine credits where voices are shown. Scope of any fix is unknown
until audited; the audit's findings become a follow-up issue, not part of the
frontend wave.

## Out of scope for this wave

castwright.ai website (com-6), Cast Pass surfaces (com-1), sonic-asset production
(§8), the actual 1.7.0 version tag, and any visual redesign.

## Risks

| Risk | Mitigation |
|---|---|
| OG/favicon regeneration drifts from SVG masters again | The render script is the only path (item 3); one documented command |
| Teaser flag dropped in a future refactor | Item 8's test |
| Release-notes link 404s before a GitHub release exists | In-app route sidesteps it entirely; GitHub link deferred to public flip |
| String refactor churns snapshots | `brand.ts` lands first so later items diff against constants |
| In-app notes drift back toward a technical changelog | Voice notes in item 5 + review of the draft above before build |
| Placeholder notes reach a published release | Two-point gate (item 5.4): `bump-version.mjs` pre-flight + `release.yml` guard step, each with a test |

## Repo-convention conversion

When this converts to execution: each frontend item maps to an `fe-`/`ops-`
GitHub issue with a thin `docs/BACKLOG.md` row, and the wave gets one
`docs/features/` regression plan (per CLAUDE.md). Item 9 gets its own `app`-scope
issue.
