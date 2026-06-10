# Brand-in-app rollout — v1.7.0 wave (design spec)

**Date:** 10 June 2026
**Status:** draft — revised after adversarial critical review (assumptions validated vs code)
**Source plan:** `brand/brand-in-app-plan-2026-06-10.md` (brand-side master, local-only)
**Brand decisions of record:** `brand/BRAND_CHANGELOG.md` (2026-06-10 entry, v2 of the brand system)

## What this is

The work to land the 10 June brand decisions *inside the application*, plus the
gaps the audit found (no real `/about` page, placeholder release notes, no
single source for brand strings, no in-app version history). This is a copy /
assets / links wave — no visual redesign, no backend feature work.

## Why now

The SVG brand masters were refreshed on 10 June, but the committed `public/og.png`
*and* the `index.html` meta tags *and* `public/manifest.webmanifest` still carry
the **retired** tagline and the `.ai` lockup. So every link preview, browser tab,
SEO snippet, and installed-PWA description currently broadcasts dead brand. This
isn't cleanup — it's stopping live drift. Brand-correctness leads the wave.

## Decisions of record

Confirmed with the user (10 June):

1. **Scope:** Must + Should, minus the items the review proved cross-scope (see
   §"Separate follow-up tracks"). The single coherent PR is frontend/ops/brand.
2. **/about content outline:** approved as-is (the 7-block table below).
3. **Brand strings:** single-sourced in a new `src/lib/brand.ts` (for React);
   static files that can't import it get direct edits + a guard test.
4. **Release-notes link target:** **in-app**, not a GitHub URL — the repo is still
   private. GitHub link added later at the public flip.
5. **Release-notes register:** in-app notes are **brand voice for listeners**;
   technical readers go to the GitHub release. Two registers, two doors.
6. **Notes are a multi-version history** (newest-first), so a user jumping
   1.5.0 → 1.7.0 sees everything between. Backfill **1.5.0** (first full product),
   **1.6.0**, **1.7.0** in brand voice.
7. **Notes written + shipped in this wave** — real, visible artifacts, not just a
   spec draft.
8. **Release gates enforce real notes** at both the tag-creation gate
   (`bump-version.mjs`) and the publish gate (`release.yml`).
9. **Device panel (item 7) splits to a separate sidecar-scope follow-up** — the
   review proved it needs Python changes to be honest (see findings C1).

## Critical review findings (10 June) — what changed vs the original plan

Four read-only agents validated every assumption against code. Net: most held,
the scariest one (runtime notes access) was *already solved*, and three were
wrong enough to change the plan.

- **C1 — Device panel can't read `mps` (REOPENED as separate track).** `/health`'s
  `device` field is set **only when Coqui is loaded**, resolves `cuda`/`cpu`
  **never `mps`**, and Kokoro (the default eager engine) + Qwen report no device.
  Normal state (Kokoro resident, Coqui idle) → `health.device === null`. An honest
  panel needs sidecar work (resolve + report the active engine's device incl.
  `mps` at startup). **User decision: split item 7 to its own sidecar-scope plan.**
  `server/tts-sidecar/main.py:2536` (`device = coqui._resolved_device if model_loaded else None`),
  `:914-929` (Qwen `_resolve_torch_device` *does* do `mps`, but isn't reported).
- **C2 — Multi-version history collides with the pipeline.** `RELEASE_NOTES.md`
  is **regenerated per-release** by `scripts/build-release-zip.mjs`
  (`generateReleaseNotes()`) from the **tag annotation** — single version,
  *technical* register. So (a) an accumulating history would be clobbered each
  release and (b) users currently see *technical* notes in the What's-New banner.
  **Fix: decouple** (see item 5). The GitHub release body keeps coming from the
  tag annotation via `release.yml`; the in-app brand history becomes a committed,
  hand-maintained file the bundler stops overwriting.
- **C3 — Three brand-string sites the plan's scan missed**, all the same
  broadcast problem as `og.png`: `index.html` meta `description` (`:9`) +
  `og:description` (`:22`); `public/manifest.webmanifest` description (`:4`); and
  `src/lib/build-info.ts:35` ("Made with Castwright"). The first three are static
  (no React) → direct edits + a guard test, not a `brand.ts` import. Folded into
  items 2/3.
- **C4 — Runtime notes access is already wired (good news).** `GET /api/info`
  returns `releaseNotes` (server reads `RELEASE_NOTES.md` from disk,
  `server/src/routes/info.ts:67`); `useAppInfo()` exposes it; `WhatsNewBanner` +
  `UpgradeCard` already render it. `#/release-notes` just consumes
  `info.releaseNotes`. **No new endpoint.** The banner currently renders a raw
  `<pre>` — fine for a stub, ugly for a multi-version history (see item 5).
- **C5 — Router mechanism is React Router, not just the hash union.** Routes are
  lazy-mounted in `src/routes/index.tsx` (e.g. `{ path: 'about', element:
  <AboutRoute/> }` with `useHydrateStage`). Adding `release-notes` = `Stage` union
  + `stageToHash` case + a lazy route + `useHydrateStage`. Proven pattern, ~4
  small touch-points.

## The work, in landing order (one PR: frontend/ops/brand)

`brand.ts` (item 2) lands **first** so later items diff against constants. Item 3
(assets + static brand strings) is most urgent by impact and runs in parallel.

### Item 2 — `src/lib/brand.ts` (single source) + static-site sweep
Export `TAGLINE`, `TAGLINE_SHORT` ("Any book, fully cast."), `MANIFESTO`,
`TEASER` (+ its mandatory in-development flag text), `DOMAIN`. Refactor the
verified React literal sites to import them:
`about.tsx`, `library/library-empty-states.tsx:16`, `upload.tsx:221`,
`analysing.tsx:985`, `generation.tsx:802`, `modals/share-clip.tsx:340`,
`modals/share-link.tsx:172`. **Static sites that can't import** (C3) get direct
edits: `index.html:9,22`, `public/manifest.webmanifest:4`. Decide whether the
build-info stamp prefix (`build-info.ts:35`) stays literal (it's "Made with
Castwright", not a retired string — likely leave, but route through `brand.ts`
for consistency). Tests assert against constants, never copied strings.
*Benefit (architectural):* the next brand change is a one-line diff.

### Item 3 — public assets (hand-designed favicons) + fix static brand copy
**The favicons are hand-designed by the user** — `public/favicon-16.png`,
`favicon-32.png`, `favicon.svg` are committed as provided (plus a refreshed
`public/og.png`), NOT rendered from the glyph. Therefore **reconcile
`scripts/render-brand-pngs.mjs` so a future re-run can't clobber them**: remove
(or guard) the `favicon-16/32` JOBS, and the `og.png` JOB if the committed file
is bespoke rather than a faithful render of `brand/castwright-og.svg` (verify
during implementation — if a fresh render reproduces it byte-for-byte, the JOB
can stay; otherwise drop it). The `icon-512/192`, `apple-touch`, and Android
launcher JOBS stay on `castwright-icon.svg` (unchanged master). Pair with the C3
static-copy fixes (same broadcast problem). Add a render-script test asserting it
no longer writes the hand-designed favicon paths.
*Benefit (brand):* retired copy stops shipping in shares, tabs, SEO, and the PWA;
the hand-designed favicons survive future asset re-renders.

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
| Alpha ask | More testers, esp. Apple Silicon / non-NVIDIA, with the contact/issues path | `project-narrative.md` |

*Benefit (user/brand):* the only in-product explanation stops being a stub, and
the teaser stops breaching its own honesty rule.

### Item 4 — neutral tokens
Add the six §5 neutrals to `src/styles.css` (`--ink-soft #4A4440`,
`--ink-mute #5A534E`, `--line #D9CFC7`, `--line-soft #EEE2DA`,
`--canvas-mute #CFC8C2`, `--peach-ink #5A2417`); reference from
`tailwind.config.ts`; sweep hardcoded near-greys that should adopt them.
*Benefit (technical):* closes guidelines §9 open item; one neutral vocabulary.

### Item 5 — release notes: multi-version, brand voice, linked, gated, decoupled

**Two-register file mapping (decoupled per C2):**

| File | Audience | Surface | This wave |
|---|---|---|---|
| `RELEASE_NOTES.md` (committed, **maintained**, multi-version, newest-first) | **Users — brand voice** | `GET /api/info` → `useAppInfo()` → `#/release-notes` + What's-New banner + Upgrade dialog | Replace stub with brand-voice **1.7.0 + 1.6.0 + 1.5.0** entries |
| `docs/release-notes-next.md` (technical, `## Features`) | **Technical** | `bump-version --notes-file` → tag annotation → GitHub Release body | Complete the v1.7.0 technical changelog |

Work:
1. **Write `RELEASE_NOTES.md`** as a newest-first, multi-version brand-voice
   history (1.7.0/1.6.0/1.5.0). Ships in this wave → visible in-app immediately.
   Draft below for voice review.
2. **Complete `docs/release-notes-next.md`** with the full ~10-point v1.7.0
   changelog in the technical register.
3. **Decouple the bundler (C2):** edit `scripts/build-release-zip.mjs` so it
   **stops regenerating** `RELEASE_NOTES.md` from the tag annotation — the
   committed brand file ships as-is. The GitHub body still derives from the tag
   annotation in `release.yml` (unchanged).
4. **`#/release-notes` route** (C5) renders `info.releaseNotes` as a readable
   multi-version history (markdown, not raw `<pre>`); "What's new" links it from
   *Account → Application updates* and `/about`. The What's-New **banner** shows
   only the latest entry (top section), full history at the route.
5. **Release gate, two points:**
   - `bump-version.mjs` — refuse to tag a real release unless `RELEASE_NOTES.md`'s
     **top entry matches the new version** and isn't the placeholder, and a real
     `--notes-file` is supplied. `--dry-run` / `--force` remain escape hatches.
   - `release.yml` — guard step fails the publish if the resolved notes are a
     placeholder, so a hand-cut tag bypassing `bump-version.mjs` still can't ship
     empty notes.
*Benefit (user):* multi-version testers see the whole story without archaeology.
*Benefit (release-safety):* a placeholder can't reach a published release by any path.

#### Draft — in-app brand-voice notes (for voice review)

> **Castwright 1.7.0**
> - **It runs on a Mac now.** Apple Silicon is a first-class home for Castwright —
>   it finds your Mac's graphics on its own, no setup, no drivers. (Intel Macs
>   work too, just slower.)
> - **Your whole cast can act.** Design expressive, emotion-aware voices for every
>   character in one pass — not just your leads — and each performance stays true
>   from the first chapter to the last.
> - **Long books you can walk away from.** Big manuscripts ride out the rough
>   patches on their own and keep going, so a full performance finishes while
>   you're elsewhere.
> - **Take your library with you.** Pair your phone in one scan and listen
>   offline, with chapters, progress and speed that follow you.
> - **Smaller things that add up.** Smarter cover search, cleaner exports, and a
>   new place to tune the finer settings.
>
> **Castwright 1.6.0**
> - **Voices that remember.** Characters keep the same voice across a whole
>   series, so book two sounds like book one.
> - **A library that makes sense.** Your books group by author and series, with
>   covers, so a growing shelf stays easy to navigate.
> - *(fill from the 1.6.0 plot points — brand voice, outcomes only)*
>
> **Castwright 1.5.0 — the first full Castwright**
> - **Any book, performed by a full cast.** Turn a manuscript into a full-cast
>   performance — every character its own voice, start to finish.
> - **Your book never leaves the house.** Everything runs on your own machine.
> - *(fill from the 1.5.0 baseline — this is the foundational release)*

*Voice notes:* no "effortlessly"/"seamless"; "performed"/"perform" not "narrate";
outcomes over mechanics; licensing/CLA/repo-paperwork omitted (GitHub-only).
**1.6.0 / 1.5.0 bullets to be completed from the changelog/narrative during
implementation — voice register reviewed here.**

### Item 6 — verification gate (woven through)
Paired tests per repo discipline: `about.test.tsx` to the new content; brand
coverage asserts the new tagline everywhere via `brand.ts`; **a guard test that
no retired tagline survives anywhere** incl. `index.html` + `manifest.webmanifest`
(C3); teaser-flag unit test; og/favicon regenerated (hash/dimension check);
neutrals present in `styles.css`; `#/release-notes` renders the history.
**Release-gate tests** in `scripts/tests/bump-version.test.mjs`: placeholder /
version-mismatch rejected, real notes pass; `release.yml` guard gets a
unit-testable placeholder-detection predicate + test. End on `npm run verify`.

### Item 8 — teaser governance test
A test: any rendered "Even in your own voice" must carry the in-development flag
within the same component. Inverts when fs-38 ships (flag must then be gone).
Cheap, frontend-only — stays in this wave.

### Item 7 — device panel: sensible-now slice (server-sourced) — fs-43, in this wave
User direction: do what's sensible now, file the deep part. C1 proved the
*precise* active-device readout needs sidecar work, but an honest, useful panel
ships now without it:
- A "Will it run on my machine?" panel showing the per-platform hardware-honesty
  line (brand copy) + the **host** platform/arch, sourced from the **server**
  (`os.platform()` / `os.arch()` → Apple Silicon / Windows / Linux), surfaced via
  `GET /api/info`. The server runs the models; the browser may be a LAN phone, so
  client-side (`navigator`) detection would be wrong — this is the load-bearing
  reason it's server-sourced.
- Best-effort: surface the existing `health.device` (cuda/cpu) when a model is
  loaded; an honest "load a voice to confirm the GPU" state otherwise.
- Audit + fix the **frontend** GPU-not-detected strings for NVIDIA-only phrasing.
*Benefit (user):* answers "will it run on my Mac/PC?" honestly today — esp. the
new Apple Silicon path, which `os.arch()` detects reliably.

## Separate follow-up tracks (own scope, own PR)

- **side-14 — device ground-truth (`sidecar`), deep half of fs-43.** The sidecar
  resolves + reports the actual torch device per active/default engine at
  startup, regardless of load state, incl. `mps` **ground-truth** (Qwen
  `_resolve_torch_device` already computes mps at `server/tts-sidecar/main.py:914-929`
  but never reports it; Coqui device is load-gated at `:2536`; Kokoro reports
  none), with pytest + Node passthrough. Then the panel upgrades from "host is
  capable of X" to "currently running on X", and the sidecar-side error strings
  get the NVIDIA-only audit. fs-43 (#705) is re-scoped to the sensible panel
  above; side-14 carries this deep work.
- **app-16 — companion-app brand audit (`app`).** Timebox ~1h: audit Flutter
  surfaces (pairing/library/player) for tagline/short-form, no `.ai` in lockups,
  engine credits. Findings → follow-up issue. Own branch.

## Out of scope for this wave

castwright.ai website (com-6), Cast Pass surfaces (com-1), sonic assets (§8), the
actual 1.7.0 version tag, and any visual redesign.

## Risks

| Risk | Mitigation |
|---|---|
| Asset/static brand copy drifts from SVG masters again | Render script is the only path (item 3); C3 static fixes + the item-6 no-retired-tagline guard test |
| Teaser flag dropped in a future refactor | Item 8's test |
| Release-notes link 404s before a GitHub release | In-app route sidesteps it; GitHub link deferred to public flip |
| String refactor churns snapshots | `brand.ts` lands first |
| In-app notes drift back to a technical changelog | Voice notes + draft review (item 5) |
| Placeholder/wrong-version notes reach a release | Two-point gate (item 5.5), each with a test |
| Bundler re-clobbers the committed brand notes | Item 5.3 removes the regeneration; a test pins that `build-release-zip` ships the committed file verbatim |

## Repo-convention conversion

Each frontend item → an `fe-`/`ops-` issue + thin `docs/BACKLOG.md` row; one
`docs/features/` regression plan for the wave. Item 7 → its own `sidecar`-scope
issue; item 9 → its own `app`-scope issue.
