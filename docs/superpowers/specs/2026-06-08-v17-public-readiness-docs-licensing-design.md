# v1.7.0 public-readiness: docs cleanup + licensing wrap-up

**Date:** 8 June 2026
**Status:** design (approved in brainstorming; pending spec review)
**Scope:** `docs` — `README.md`, `INSTALL.md`, `CONTRIBUTING.md`, new `LICENSE`,
new `brand/LICENSE`, new `NOTICE`, new `docs/licensing.md`.
**Companion to:** `brand/monetisation-free-vs-gated-2026-06-08.md` (§5 action
items, §7 distribution & licensing), `brand/brand-guidelines.md`,
`docs/project-narrative.md`.

---

## Goal

Prepare the user-facing documentation and the licensing artifacts for the first
**public** GitHub release of Castwright, cut as v1.7.0 (possibly v1.8.0 — see
"Release framing"). Two threads:

1. **Docs cleanup** — turn the developer-oriented `README.md` into an
   app/user/deployer-facing document; tidy `INSTALL.md` for a first-time public
   reader; keep `CONTRIBUTING.md` / `CLAUDE.md` as the developer home.
2. **Licensing wrap-up** — create all the licensing files the monetisation doc's
   repo-opening checklist calls for (`LICENSE`, `brand/LICENSE`, `NOTICE`,
   contribution terms), and record the engine-licence audit and the remaining
   repo-opening steps in one place (`docs/licensing.md`).

## Non-goals (this pass)

- **Do not flip the repo to public.** The user is building the companion website
  (`castwright.ai`) first; the visibility flip + any "we're now open / buy the
  Cast Pass" messaging waits for that. The LICENSE governs the code regardless of
  repo visibility, so the files and the README license statement are written in
  their final public form now; only the `gh repo edit --visibility public` step
  is deferred.
- **Do not rewrite git history** (the secret/fixture scrub). It is destructive
  and force-push-bound; this pass writes the exact checklist into
  `docs/licensing.md` but executes nothing.
- **Do not bump `package.json` versions.** That is `scripts/bump-version.mjs` at
  release time.
- **Do not touch** `apps/android/README.md` or `server/tts-sidecar/README.md` —
  both are correctly-scoped component *developer* readmes.
- No CLA-assistant bot wiring, no branch-protection enable, no licence-key
  (`fs-`) seam — all recorded as follow-ups in `docs/licensing.md`.

## Release framing (load-bearing constraint)

v1.7.0 is the **first real public release**. Every earlier version
(v1.0–v1.6.0) was limited to a single user (the author) and the alpha circle.
Consequences for the docs:

- There is **no public upgrade history**. The first upgrade any public user will
  ever perform is *this release → the next one*.
- `INSTALL.md` drops all the per-version migration notes (v1.5.x→1.6.0
  converter, "v1.4.0 → v1.5.0 notes", "v1.3.x → v1.4.0 notes"). They documented
  one person's private migrations.
- `README.md` drops comparative / changelog framing: the inline `(v1.4.0)` /
  `(v1.3.0)` feature tags and the "v1.6.0 cannot self-upgrade across the rename /
  alpha installs reinstall fresh" note. Capabilities are presented as features of
  v1, full stop. (This matches `CONTRIBUTING.md` → "Release notes" → "What stays
  out": no comparative phrasing on an initial release.)
- The exact number may be 1.7.0 or 1.8.0 depending on when the website + other
  prerequisites land. Prose uses the `vX.Y.Z` placeholder for artifact names (the
  repo's existing convention) and the phrase "the first public release" for
  release-history semantics, so the docs survive either number.

---

## 1. `README.md` — strip to an app/user-facing document

The current README (~338 lines) mixes user content with developer content that
is **already fully documented** in `CONTRIBUTING.md` (branching, commit
convention, worktrees, parallel sessions, releasing) and `CLAUDE.md` (testing
discipline, commands). So "strip to app-focused" is mostly deletion + a pointer,
not migration.

**Keep & sharpen:**

- Title, tagline, one-paragraph "what is this".
- "What it does" — the ingest → analyse → cast → generate → listen/export
  pipeline in plain language.
- **Features** — condensed to clean capability bullets. Remove every inline
  version tag. Group by surface (Ingest, Voice & cast, Generation, Listening,
  Library, Export, Companion app) so a prospective user reads capabilities, not a
  changelog.
- **Quickstart (for users)** — lead with "download the release zip → follow
  `INSTALL.md`", not git-clone. One short "Building from source" line pointing to
  `CONTRIBUTING.md` for the contributor path.
- **Companion app (Android)** — keep; it's user-facing. Trim the duplicated
  server-side LAN setup detail down to a pointer into `INSTALL.md`.
- **Releases** — keep (zip + apk + unsigned iOS, with `.sha256`).
- **License** — rewrite (see §3).

**Remove (replace with a single "Building from source / contributing →
CONTRIBUTING.md" line):**

- Testing harness table + verify batteries.
- Parallel sessions / worktrees section.
- Commit-gate / husky detail.
- The exhaustive internal `src/` layout tree (a contributor reads the code; a
  user does not need it). A short, high-level "How it's built" paragraph
  (Vite + React frontend, Node/Express server, Python TTS sidecar, Flutter
  companion) is enough.
- The deployer env-knob list → **moves into `INSTALL.md` Configuration** (that's
  where a deployer looks).

## 2. `INSTALL.md` — cleanup pass

Already user-facing and solid; no structural rewrite. Changes:

- **Absorb the Configuration env-knob reference** from README into a single
  "Configuration" section (ANALYZER / GEMINI_* / LAN_HTTPS / LAN_AUTH_TOKEN /
  WORKSPACE_DIR / AUDIO_LOUDNORM_ENABLED / GEN_WORKERS / GPU_VRAM_BUDGET, etc.).
- **Remove the historical migration sections** ("One-time conversion when you
  adopt v1.6.0", "v1.4.0 → v1.5.0 notes", "v1.3.x → v1.4.0 notes") per the
  release-framing constraint.
- **Rewrite "Updating"** as forward-looking only: from this first public release
  onward, upgrading is one click in **Account → Application updates** (the
  versioned-directory mechanism that has existed since 1.6.0 ships in the box, so
  a fresh install already has it — no one-time conversion, because there is no
  prior *public* install to convert). Keep the manual-fallback subsection.
- Make version references consistent with "first public release" framing.

## 3. Licensing files (created now; repo stays private until the flip)

Copyright/licensor identity: legal holder **Mikhail Dudarenok**, product/brand
**Castwright** referenced alongside — e.g. *"Castwright — Copyright © 2026
Mikhail Dudarenok"*.

- **`LICENSE`** (root) — **FSL-1.1-Apache-2.0**, the official Functional Source
  License template (Apache-2.0 future licence variant). Fields: Licensor =
  *Mikhail Dudarenok*; the "Software" line names Castwright. FSL permits any use
  **except** a competing product/service; each release's code converts to plain
  Apache-2.0 two years after its publication date.
- **`brand/LICENSE`** — **all rights reserved** for the `brand/` assets (logos,
  wordmarks, the Castwave mark), with an explicit fair-use permission for
  articles / reviews. States plainly that a code licence is not a licence to the
  identity. Header: *"Castwright brand assets — Copyright © 2026 Mikhail
  Dudarenok. All rights reserved."*
- **`NOTICE`** (root) — public third-party / bundled-component attributions plus
  the **engine-licence audit summary**:
  - **Kokoro** — bundled weights; licence stated and **verified at the pinned
    release version** (expected Apache-2.0).
  - **Coqui XTTS v2** — **CPML, non-commercial → NOT bundled**; download-on-demand
    from the original source only, licence shown at install, positioned as a
    user-supplied optional engine.
  - **Qwen3-TTS** — weight licence **verified** (Qwen releases vary between
    Apache-2.0 and the Qwen licence); download-on-demand if restricted.
  - Rule of thumb recorded: *the installer may fetch weights from their official
    home; the release zip bundles nothing whose licence is unverified.*
  - Implementation note: the Kokoro and Qwen3 licence claims are **web-verified
    at their pinned versions while writing `NOTICE`** (the audit is a pre-launch
    blocker per monetisation §5/§7.1). If a version cannot be verified
    confidently, `NOTICE` records "verify before bundling" rather than asserting.
- **README License section** — replaces *"Private — not currently licensed for
  redistribution"* with: a one-line **source-available (FSL-1.1-Apache-2.0, not
  OSI open source)** statement and why; the `brand/` carve-out; the bundled-model
  notice (pointer to `NOTICE`); and the **"issues welcome, PRs by invitation"**
  contribution stance.

## 4. `CONTRIBUTING.md` — contribution-licensing terms

Add a short **"Contributing & licensing"** section near the top:

- The repo is **source-available under FSL-1.1-Apache-2.0**, not OSI open source.
- **DCO sign-off required** on any external contribution (`Signed-off-by:` via
  `git commit -s`); a lightweight **CLA** is required before a non-trivial
  external PR is merged (cla-assistant wiring is a flagged follow-up).
- Current posture: **"issues welcome, PRs by invitation"** until the CLA bot is
  in place (per monetisation §7.1 — retrofitting a CLA after contributors
  accumulate is painful).
- `brand/` assets are not covered by the code licence (pointer to
  `brand/LICENSE`).

## 5. `docs/licensing.md` — the licensing-compliance home (new)

Single place that records, for the maintainer:

- The licence model (FSL code, all-rights-reserved brand, download-on-demand for
  non-commercial engine weights) and *why* (links to monetisation §7).
- **Engine-licence audit table** with verification status + date per engine.
- **Repo-opening checklist** (from monetisation §5 action item 6), with each item
  marked done / pending:
  - `LICENSE`, `brand/LICENSE`, `NOTICE`, README statement, CONTRIBUTING terms —
    *done in this pass*.
  - **Git history secret/fixture scrub** — *pending*; exact targets (`.env`,
    keys, the legacy copyrighted manuscript fixture) and the recommended
    `git filter-repo` command sketch, flagged destructive.
  - cla-assistant bot; `gh repo edit --visibility public`; branch protection on
    `main`; the licence-key (`fs-`) seam.
- Trade-mark action (AU registration via IP Australia) referenced as a tracked
  follow-up (ops-12), not executed here.

---

## File-by-file change list

| File | Action |
|---|---|
| `README.md` | Restructure → app-focused; rewrite License section; remove dev sections + version tags + self-upgrade note |
| `INSTALL.md` | Add Configuration section; remove historical migration sections; rewrite Updating as forward-looking |
| `CONTRIBUTING.md` | Add "Contributing & licensing" section (FSL / DCO / CLA / PRs-by-invitation) |
| `LICENSE` | **New** — FSL-1.1-Apache-2.0 |
| `brand/LICENSE` | **New** — all rights reserved + fair-use note |
| `NOTICE` | **New** — third-party + bundled-engine attributions + audit summary |
| `docs/licensing.md` | **New** — licence model, engine audit, repo-opening checklist, flagged follow-ups |

## Testing / verification

Docs-and-licensing change — no automated tests apply. Verification:

- `npm run verify:fast:scoped` on commit (docs scope skips the test legs; the
  commit-msg hook validates the subject).
- Manual: every internal link in the rewritten README/INSTALL resolves; no
  remaining "Private — not licensed" string; no remaining inline `(vX.Y.Z)`
  feature tags in README; no broken pointer to removed sections.
- The engine-licence claims in `NOTICE` are each tied to a verification source +
  date.

## Ship notes

_(filled at merge)_
