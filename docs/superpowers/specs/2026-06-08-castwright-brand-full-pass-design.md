# Castwright brand — full pass (design)

- **Date:** 2026-06-08
- **Backlog:** `fs-39` ([#631](https://github.com/dudarenok-maker/AudioBook-Generator/issues/631)) — "Rebrand the server + web app to Castwright"
- **Brand source of truth:** `brand/brand-guidelines.md`, design spec `docs/superpowers/specs/2026-06-07-castwright-brand-design.md`, narrative `docs/project-narrative.md`
- **Status:** draft (awaiting user review)

## Context

The product is now **Castwright** (`castwright.ai`) — _"Any book, performed by a full
cast — effortlessly. Even in your own voice."_ The companion Android app and the
web wordmark already ship under the brand. This pass finishes the job in two parts:

1. **A full package + repo rename to Castwright (Wave 0).** Originally `CLAUDE.md`
   pinned the internal name `audiobook-generator` because renaming breaks the fs-1
   self-upgrade flow. The user has **lifted that constraint**: the product is
   alpha-only, so existing installs can **reinstall fresh** rather than self-upgrade.
   The startup console line the user sees — `> audiobook-generator@1.6.0 start:prod`
   — is npm echoing the `package.json` `name`; the rename removes it at the source.
2. **A brand-presence pass (Waves 1-3)** — the moments that matter (narrator
   credit, exports, empty states, share surfaces, errors) carrying the brand.

The web UI itself is already ~95% branded: top-bar wordmark + Castwave SVG,
`index.html` title/description/OG, `manifest.webmanifest`, favicon, and all five
theme tokens in `styles.css` already match the guideline palette (Magenta
`#A43C6C`, Ink `#0F0E0D`, Peach `#F79A83`, Canvas `#FFFDFB`, Deep Purple `#3C194F`).

### Decisions taken during brainstorming

| Decision | Choice |
|---|---|
| Rename the npm package + release artifact | **Yes** — `castwright` / `castwright-server` / `castwright-vX.Y.Z.zip` |
| Self-upgrade from 1.6.0 | **Breaks, accepted** — alpha users reinstall fresh; first castwright release is a fresh manual install |
| Data-folder rename depth | **Rename them too** (`audiobook-workspace/` → `castwright-workspace/`, `~/.audiobook-generator` → `~/.castwright`); **no shipped user migration**; **one-time transition of OUR dev box's data** |
| Per-book `.audiobook/` subfolder | **Keep** (deliberate exception — generic structural name, ~40+ refs, every book on disk, zero brand value; flagged for veto) |
| GitHub repo | **Rename** `AudioBook-Generator` → `Castwright` (GitHub auto-redirects old URLs) |
| Narrator credit default | **"Castwright" over the cast-narrator name** (explicit user credit still wins) |
| Narrator-credit persistence | **Persist to book state** (server-side default + back-catalogue backfill) |
| Exported-file artist tag (ID3 TPE1) | **Keep author as artist when the credit is the brand default** (sentinel) |
| Delivery | **Wave 0 rename PR first**, then one spec → phased brand-pass PRs |

## Wave 0 — Package + repo rename to Castwright (first PR)

### A. npm package names + startup console

- Root `package.json` `name`: `audiobook-generator` → `castwright`.
- `server/package.json` `name`: `audiobook-generator-server` → `castwright-server`.
- Both `package-lock.json` regenerate via `npm install`.
- **Startup banner:** `start-prod.bat` / `stop-prod.bat` call `npm run --silent …`
  so npm's `> name@ver script` echo never prints; `scripts/start-app-prod.mjs`
  prints a `Castwright vX.Y.Z — Any book, performed by a full cast.` banner before
  `[READY]` (version from the existing `getAppVersion()` / package.json read).
  `scripts/start-app.ps1` gets a matching `Write-Status` banner for the `npm start`
  dev path (where npm's echo can't be suppressed after the fact).

### B. Release artifact + fs-1 upgrade flow (breaking, accepted)

- `scripts/build-release-zip.mjs:279,334` — zip name + internal dir prefix
  `audiobook-generator-${version}` → `castwright-${version}`.
- `server/src/upgrade/zip-validate.ts:26` — `TOP_DIR_RE` and the `bad-structure`
  reason string → `castwright-vX.Y.Z`. `server/src/upgrade/apply.ts` `topDir` doc.
- `.github/workflows/release.yml` — release title + asset name → Castwright.
- `scripts/bump-version.mjs:487` — tag message `Audiobook generator` → `Castwright`.
- Tests: `scripts/tests/{release-manifest,setup-versioned-install,archiver-zip,launch}.test.mjs`
  expected names → `castwright-*`; `server/src/upgrade/*.test.ts` prefix assertions.
- **Doc the break:** record in the fs-1 plan / README that the first castwright
  release is a fresh manual install — 1.6.0 cannot self-upgrade across the rename.

### C. Data folders (rename; no shipped user migration; dev-box transition)

- Default workspace: `server/src/workspace/paths.ts:30` `../audiobook-workspace`
  → `../castwright-workspace`. Update `WORKSPACE_SOURCE` doc + any test referencing
  the old default.
- Global settings: `server/src/workspace/user-settings.ts:39`
  `~/.audiobook-generator/user-settings.json` → `~/.castwright/user-settings.json`.
  Update the `LEGACY_USER_SETTINGS_PATH` comment + `test-setup.ts:5` note.
- **Keep** the per-book `.audiobook/` subfolder name (deliberate exception above).
- **No shipped migration** — fresh installs get fresh `castwright-*` dirs.
- **Dev-box transition (one-time, NOT wired into the app):**
  `scripts/transition-local-to-castwright.mjs` (dry-run default, `--apply`) that
  renames this machine's existing `audiobook-workspace/` → `castwright-workspace/`
  and `~/.audiobook-generator/` → `~/.castwright/`, so our real books + settings
  carry over. Documented as a dev tool only.

### D. GitHub repo rename

- `gh repo rename Castwright` + `git remote set-url origin …` (coordinated /
  user-run outward-facing action — confirmed before executing).
- Update `server/src/cover/openlibrary.ts:78,140` User-Agent URL, README badges /
  clone URLs, and any hardcoded repo links in docs. GitHub auto-redirects old URLs.

### E. CLAUDE.md + docs + fs-39 close-out

- **`CLAUDE.md`** brand note (lines ~8-13) — remove the "internal package name
  stays `audiobook-generator`" constraint; document the new names + the
  no-self-upgrade-across-rename caveat.
- `README.md` (line ~4 "internal package / repo name stays" note + zip-name refs),
  `INSTALL.md:1` title, `apps/android/README.md`, `.claude/skills/run-app/SKILL.md`.
- `docs/BACKLOG.md` — remove the fs-39 row; PR body `Closes #631`.

## Wave 1 — Narrator credit + persistent stamps (second PR)

### A. Narrator credit → "Castwright" (persisted)

Constant `DEFAULT_NARRATOR_CREDIT = 'Castwright'`, defined once on the frontend
(`src/store/book-meta-slice.ts`, exported) and once server-side (reused by the
book-state route + the three export builders); the duplication is documented.

- **Display** (`src/views/listen.tsx:147-150`): precedence collapses to
  `explicit credit (trimmed) → DEFAULT_NARRATOR_CREDIT`. The
  `characters.find(c => c.id === 'narrator')?.name` fallback is **removed**.
- **Redux hydrate** (`src/store/book-meta-slice.ts:79`):
  `narratorCredit: state.narratorCredit ?? DEFAULT_NARRATOR_CREDIT`. The
  `narratorFallback` payload field is **removed**.
- **Remove orphaned helper:** `narratorNameFromCast` (`book-meta-slice.ts:150`)
  is used only by the two `layout.tsx` hydrate call sites (`:737`, `:823`). Delete
  the helper, its `layout.tsx` import, both `narratorFallback` args, and the
  helper's tests (`book-meta-slice.test.ts:191-213`).
- **Server default (persistence):** the book-state GET returns
  `narratorCredit: 'Castwright'` when the stored field is empty/null
  (`server/src/routes/book-state.ts` / `server/src/workspace/scan.ts`); the
  existing meta-PUT path writes it through to `book-state.json` on the next save.
- **Back-catalogue backfill:** `scripts/repair-narrator-credit.mjs` (`--apply`,
  dry-run default) writes `"Castwright"` into existing books' empty credits.
- **Export artist reconciliation:** the artist fallback is duplicated across
  `build-mp3-folder.ts:71`, `build-mp3-zip.ts:89`, `build-m4b.ts:154`. Extract a
  shared `artistForExport(state)` returning the author when the credit is empty
  **or equals `DEFAULT_NARRATOR_CREDIT`**:
  ```
  const c = state.narratorCredit?.trim();
  return c && c !== DEFAULT_NARRATOR_CREDIT ? c : state.author;
  ```
  Net: visible Listen credit + the comment stamp say "Castwright", but TPE1 artist
  stays the author unless the user typed a real human narrator.

### B. Persistent brand stamps

- **Footer build-stamp** (`src/components/build-stamp.tsx`): prepend
  "Made with Castwright · " to the version stamp.
- **Export comment stamp:** add an optional `comment` field to `Id3Tags`
  (`server/src/export/id3-tags.ts`) → ID3v2.4 `COMM` frame via one extra
  `-metadata comment=…` arg, value `Rendered with Castwright · castwright.ai`;
  wire the same into the M4B metadata atoms (`server/src/export/build-m4b.ts`).

## Wave 2 — On-ramp + listener touchpoints (third PR)

- **Empty library** (`src/components/library/library-empty-states.tsx`): tagline
  sub-headline + Castwave icon (peach accent).
- **Upload screen** (`src/views/upload.tsx:217`): Castwave glyph on the existing
  "meet the cast" headline.
- **Listen header** (`src/components/listen/listen-header.tsx`): a quiet
  "Full-cast audiobook · made with Castwright" line near the credits.
- **Share surfaces** (`src/modals/share-clip.tsx`, `src/modals/share-link.tsx`):
  one-line brand attribution + `castwright.ai` link.
- **Analysing / generation** (`src/views/analysing.tsx`, `src/views/generation.tsx`):
  brand-voice subtitle ("Bringing your cast to life") in the existing header.

## Wave 3 — Brand home + voice (fourth PR)

- **`/about` brand page** (new route + view): Castwave logo, primary tagline,
  "Many voices, one machine" manifesto, `castwright.ai` link, app version. Linked
  from Account/Admin + the footer.
- **Error / toast copy** (`src/components/toast-stack.tsx` + error boundaries):
  rewrite generic copy in the brand tone (the guidelines supply examples).

## Out of scope

- The per-book `.audiobook/` subfolder rename (deliberate exception — see decisions).
- A shipped user-facing data migration (alpha users reinstall fresh).
- A sonic/audio brand signature (guideline "optional later").
- Visual redesign beyond brand-token application — the look stays pixel-stable.

## Testing (per CLAUDE.md "every PR improves coverage")

**Wave 0**
- Update the rename assertions in `scripts/tests/*.test.mjs` +
  `server/src/upgrade/*.test.ts` (new `castwright-` prefix; a regression case that
  an `audiobook-generator-*` prefix is now rejected as `bad-structure`).
- Extend `scripts/tests/start-app-prod.test.mjs` to assert the Castwright banner.
- Settings-path + default-workspace unit coverage points at the new names.
- `.bat --silent` + GitHub-repo rename verified manually (in verification steps).

**Wave 1**
- `book-meta-slice.test.ts` — hydrate defaults to "Castwright"; delete the
  `narratorNameFromCast` block. `listen.test.tsx` — rename the cast-narrator
  fallback case to "defaults to Castwright"; keep explicit-credit-wins green.
  Update the a11y fixture (`src/test/a11y.test.tsx:153`).
- New server test: book-state GET returns "Castwright" when empty.
- `server/src/export/*.test.ts` — `artistForExport` returns author for empty AND
  default-`"Castwright"` credits, the real credit otherwise; `id3-tags.test.ts`
  case for the `COMM` comment frame.
- One Playwright assertion: Listen header shows "Castwright" with no explicit credit.

**Waves 2-3** — paired component tests per surface; Playwright e2e for the
empty-state and the `/about` route (both cross router/redux seams).

## Verification (end-to-end)

1. `npm run verify` green after each wave (typecheck + all tests + e2e + build).
2. **Wave 0:** run `scripts/transition-local-to-castwright.mjs --apply` on the dev
   box → existing books + settings carry over under the new dir names. Double-click
   `start-prod.bat` → console leads with the Castwright banner, shows `[READY]`,
   **no** `> audiobook-generator@…` lines. `npm run build:release` (or equivalent)
   produces `castwright-vX.Y.Z.zip`. `git remote -v` points at the renamed repo.
3. **Wave 1:** a book with no explicit credit shows "narrated by Castwright"; an
   explicit credit wins. Export to MP3 + M4B → TPE1 artist is the **author**, the
   `COMM`/comment atom reads "Rendered with Castwright · castwright.ai". Footer
   shows "Made with Castwright · <version>". `repair-narrator-credit.mjs` dry-run
   then `--apply` backfills empty credits only.
