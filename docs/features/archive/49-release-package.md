---
status: stable
shipped: 2026-05-18
owner: dudarenok
---

# 49 — Release packages on git-tag push

> Status: stable
> Key files: `.github/workflows/release.yml`, `scripts/bump-version.mjs`, `scripts/build-release-zip.mjs`, `scripts/start-app-prod.mjs`, `scripts/stop-app.mjs`, `server/tts-sidecar/scripts/install-kokoro.sh`, `server/src/frontend-static.ts`, `INSTALL.md`, `CONTRIBUTING.md` (Releasing section), `README.md` (Releases link).
> URL surface: `http://localhost:8080` (production-mode launch via `npm run start:prod`).
> OpenAPI ops: `PUT /api/user/settings/gemini-key` (new — UI-managed API key).

## Benefit / Rationale

- **User:** the repo owner can hand a downloadable artefact (`audiobook-generator-vX.Y.Z.zip`) to a deployer ("here, run this") instead of walking them through a git clone + dev-from-source flow. Cutting a release becomes one command (`node scripts/bump-version.mjs --level minor --notes-file …` + two `git push`es) instead of four manual file edits + a tag. Deployer is on Windows / macOS / Linux — the artefact works on all three from the same zip.
- **Technical:** introduces the first CI workflow that *writes* to GitHub state (Releases). Codifies a reproducible-from-tag build manifest so every release is rebuildable from its git ref alone. Adds a production-mode server path (`express.static(dist)` + `npm run start:prod`) that survives outside the dev orchestrator.
- **Architectural:** establishes the release seam that the deferred [`ops-1` — Windows installer](../BACKLOG.md) and [`ops-2` — Docker image](../BACKLOG.md) hang off. Both extend `release.yml` with additional asset-upload steps; neither needs a separate pipeline. Also unblocks [Could #37 — In-app multi-model management UX](../BACKLOG.md), which closes the "deployer can't install Ollama without leaving the app" gap that plan 49's Kokoro-only install bundle leaves.

## Architectural impact

- **New seams / extension points:**
  - `.github/workflows/release.yml` — tag-triggered build pipeline. Could-bucket installer / Docker items extend this same workflow (additional jobs / steps) rather than spawning sibling workflows.
  - `scripts/build-release-zip.mjs` — exports a `MANIFEST` constant + a pure `matchesManifest()` function (cross-platform, no shell-out); both the CLI and the Vitest test import from this single source.
  - `scripts/bump-version.mjs` — sole sanctioned path for advancing version numbers; replaces ad-hoc file editing. Cross-platform Node (no PowerShell dependency).
  - `scripts/start-app-prod.mjs` + `scripts/stop-app.mjs` — production-mode launch / stop pair, deployer-facing. The Windows-only PowerShell `start-app.ps1` / `stop-app.ps1` pair stays for the dev workflow.
  - `server/src/frontend-static.ts` — `mountFrontendStatic(app, distDir)` helper, gated on `NODE_ENV=production` OR `dist/index.html` existence. Extracted from `index.ts` so the colocated unit test can drive it.
  - `server/user-settings.json.geminiApiKey` + `PUT /api/user/settings/gemini-key` — UI-managed Gemini API key, replaces the read-only ApiKeyPill at `src/views/account.tsx:470`. Env-var `GEMINI_API_KEY` still wins.
- **Invariants preserved:**
  - The CI gate from plan 38 / plan 44 (PR title + commit convention) is unaffected — the release workflow runs on tag push, not on PRs.
  - The pre-push `npm run verify` gate from CLAUDE.md "Commit gate" remains the source-of-truth correctness check; the release workflow re-runs `verify:quick` on all three deployer OSes as a sanity net.
  - Plan 27 book-state persistence is unaffected — the release zip ships application code only; per-book `state.json` lives under `WORKSPACE_DIR` which is operator-configured, not bundled.
- **Migration story:** none. Versions today (1.1.0 in both `package.json` files) are already in lockstep; the bump script preserves that invariant going forward. Existing `server/user-settings.json` files load unchanged — the new `geminiApiKey` field is optional with a `null` default.
- **Reversibility:** delete the workflow file + the bump script + the plan; tags and releases on GitHub can be deleted via `gh release delete` and `git push origin :vX.Y.Z`. Per-release artefacts can be re-uploaded manually with `gh release upload` if the workflow is removed.

## Invariants to preserve

1. **Version lockstep** — `package.json:3` and `server/package.json:3` MUST always carry the same version string. `scripts/bump-version.mjs` enforces this both as a pre-flight check (refuses to run if the two have drifted) and as a post-condition (writes both simultaneously via `npm version`).
2. **Tag ↔ commit lockstep** — every `vX.Y.Z` tag MUST point at the `chore: bump version to X.Y.Z` commit. The bump script creates them together; the workflow never creates tags.
3. **Reproducibility from tag** — the release zip MUST be reproducible from the tagged commit alone. No `main`-vs-tag drift; no environment-derived metadata embedded in the artefact.
4. **Asset-exclusion list** — the release zip MUST NOT include any of: `.env*` (except `.env.example`), `node_modules/`, `.venv/`, `voices/kokoro/*.onnx` (the ~1 GB Kokoro weights — deployer fetches via `install-kokoro.{ps1,sh}`), `.git/`, `*.log`, `.run/`, `logs/`, `.verify-cache.json`, `e2e/`, `docs/`, `scripts/tests/`, `server/tts-sidecar/tests/`, `CLAUDE.md`, `CONTRIBUTING.md`, and maintainer-only scripts (`bump-version.mjs`, `build-release-zip.mjs`, `start-app.ps1`). The `MANIFEST` constant in `scripts/build-release-zip.mjs` is the source of truth.
5. **Verify gate** — the workflow MUST NOT publish the release if `npm run verify:quick` or `npm run build` fail on the tagged commit on ANY of the three OSes in the verify matrix. (`verify:quick` not full `verify`: the tagged commit already passed pre-push verify on the developer machine; the workflow's job is rebuild + cross-OS sanity, not full re-test.)
6. **Release notes from git** — the GitHub release notes MUST be sourced from the annotated tag's message (`git tag -l --format='%(contents)' vX.Y.Z`), not hand-typed in the GitHub UI. Notes live in git.
7. **API key never echoed** — `GET /api/user/settings` MUST NEVER return the plaintext `geminiApiKey`. Only the redacted `apiKeyStatus: 'set' | 'unset'` boolean leaves the server. The dedicated `PUT /api/user/settings/gemini-key` endpoint is the ONLY write path that accepts the field; the general `PUT /api/user/settings` strips it (per `FORBIDDEN_KEYS`).

## Test plan

### Automated coverage

- **node:test** (`scripts/tests/bump-version.test.mjs`): in a temp-dir copy of the four files + a throwaway git repo, runs the bump script and asserts: (a) both versions advance by the requested level, (b) lockfiles regenerate, (c) the commit is created with the expected `chore: bump version to X.Y.Z` subject, (d) the tag is annotated and points at the bump commit, (e) lockstep drift is rejected at pre-flight, (f) dirty trees are rejected, (g) `--dry-run` is purely informational. 8 tests, all green.
- **node:test** (`scripts/tests/release-manifest.test.mjs`): imports `MANIFEST` and `matchesManifest` from `scripts/build-release-zip.mjs` and asserts the path-matcher decisions for 33 representative include / exclude paths — includes `server/tts-sidecar/main.py`, excludes Kokoro weights, excludes maintainer-only scripts, retains `.gitkeep` in keep-empty dirs. 69 assertions, all green.
- **vitest** (`server/src/frontend-static.test.ts`): drives `mountFrontendStatic()` with a real tempdir containing `dist/index.html`; asserts the static mount returns 200 for `GET /` and does NOT shadow `/api/*` routes. Also asserts the no-op behaviour in dev mode and the "missing build artefact" reason in production mode without dist/.
- **vitest** (`server/src/routes/user-settings.test.ts` — extended): asserts the new `PUT /api/user/settings/gemini-key` persists the key, flips `apiKeyStatus`, never echoes the plaintext on subsequent GETs, clears on `{key:null}`, env-var override wins, whitespace-only coerces to null, missing-payload returns 400.
- **vitest** (`src/views/account.test.tsx` — extended): asserts the new `GeminiKeyField` exposes a writable password input, fires `api.putGeminiKey(...)` on Save with trimmed value, fires `(null)` on Clear, flashes "Saved.", and CRITICALLY: even with text in the API key field, the form-wide Save MUST NOT include the secret in its patch (separate write surfaces, by design).
- **No new e2e** — packaging surface; e2e adds no signal. The end-to-end check is the manual tag-push dry-run below + the release workflow's own three-OS verify matrix.

### Manual acceptance walkthrough

1. On a scratch branch off `main`, run `node scripts/bump-version.mjs --level patch --force --dry-run` (`--force` bypasses the "must be on main" guard). Expected: prints the plan + DRY-RUN marker; no mutations.
2. Drop `--dry-run`: four files modified (`package.json`, `package-lock.json`, `server/package.json`, `server/package-lock.json`), one commit created, one annotated tag (`v<new>`) created locally.
3. `git push origin <scratch-branch> && git push origin v<new>` — observe `.github/workflows/release.yml` run in the Actions tab. Three matrix verify legs (ubuntu / macos / windows) must go green; then publish job assembles `audiobook-generator-v<new>.zip` + `.sha256` and creates the GitHub Release.
4. Open the release page; download the zip + `.sha256`; verify the checksum (`shasum -a 256 -c …` on POSIX, `Get-FileHash` on Windows).
5. On a clean Windows 11 host (or sandboxed folder), extract; follow `INSTALL.md` Windows section step-by-step; expect `npm run start:prod` to bring up the app at `http://localhost:8080`.
6. Ask one macOS alpha tester to repeat (5) using `INSTALL.md`'s macOS section. Linux is validated indirectly via the ubuntu-latest verify leg + the workflow's actual zip-build job running on Ubuntu — an explicit Linux alpha tester is welcome but not gating.
7. Cleanup: `git push origin :v<new>` (delete remote tag), `gh release delete v<new> --yes` (delete release), delete the scratch branch.

## Out of scope

- **In-app multi-model management UX** — tracked as BACKLOG Could #37 (Account-tab "Install Ollama" + "Pull model" + "Refresh available models" affordances, and optional Coqui XTTS pre-install script). Plan 49 closes the Gemini-key gap; the rest stays manual until #37 ships.
- **Windows installer (Inno Setup / NSIS)** — backlog `ops-1`. Extends `release.yml` with a second asset.
- **Docker image + compose file** — backlog `ops-2`. Extends `release.yml` with a `docker/build-push-action` job.
- **Code-signing / SmartScreen reputation / macOS Gatekeeper notarization** — tracked alongside `ops-1` (installer).
- **In-app auto-update** — not a v1 concern; deployer manually re-extracts on upgrade per `INSTALL.md`'s "Updating" section.
- **Bundling Kokoro weights into the release artefact** — decided 2026-05-18: weights stay separately fetched via `install-kokoro.{ps1,sh}` to keep the release zip small (~5-10 MB) and within GitHub's 2 GB per-asset limit.
- **Architecture-specific zips** (`-darwin-arm64.zip` vs `-darwin-x64.zip`). The current artefact is platform-independent — only relevant if we ever pre-bundle native binaries.

## Ship notes

- **Shipped:** 2026-05-18 as `v1.2.2`.
- **Commit:** `e367c93c8ea0d75bbaa9b450ee66f57b4086c500` (`chore: bump version to 1.2.2`).
- **Release:** [v1.2.2 — Audiobook generator](https://github.com/dudarenok-maker/AudioBook-Generator/releases/tag/v1.2.2), asset `audiobook-generator-v1.2.2.zip` + `.sha256`, body sourced from the annotated tag.
- **Dry-runs that surfaced the deltas:** `v1.2.0` and `v1.2.1` were both tagged and pushed but never published — each fell over on a different cross-platform CI gap. The third real attempt (`v1.2.2`) was the first one to make it through the verify matrix + publish job. Two retracted tags are evidence the verify gate (invariant 5) does what it claims; CONTRIBUTING.md's "delete release + tag, fix forward" recipe was exercised twice end-to-end.

### Deltas vs. spec

The spec called for a single-shot release; reality needed four follow-up fixes before `v1.2.2` shipped. All are now baked into the workflow + npm scripts; future tag pushes don't need any of them re-applied.

1. **ffmpeg install on the verify matrix** (PR #29, `ci(ci): install ffmpeg per-OS before release verify`). GitHub runners don't ship ffmpeg pre-installed; the server's `preflight-ffmpeg.cjs` hook refused to run. Workflow now does `apt-get install` / `brew install` / `choco install` per matrix OS before invoking `verify:quick`. Plan didn't anticipate this — `SKIP_FFMPEG_PREFLIGHT=1` is the documented escape hatch but it silently skips `mp3.test.ts`, weakening the gate.
2. **Cross-platform test:hooks + test:scripts wrappers** (PR #30, `ci(scripts,ci): cross-platform test:hooks + test:scripts wrappers`). Three sub-issues, all environmental:
   - `node --test scripts/tests/*.test.mjs` depended on shell glob expansion. Windows cmd.exe doesn't expand. Replaced with `scripts/run-hooks-tests.mjs` (globs in JS via `fast-glob`).
   - `test:scripts` / `test:sidecar` invoked `powershell` directly. Ubuntu runners only ship `pwsh` (PowerShell 7+). Replaced with `scripts/run-powershell.mjs` that picks `pwsh` when available, falls back to `powershell.exe` on Windows so the maintainer's local environment (which only has Windows PowerShell 5.1) keeps working without a hard `pwsh` prereq.
   - macOS happened to ship a `powershell` shim that resolved to `pwsh`, so the verify on macOS passed v1.2.0 / v1.2.1 before falling over elsewhere — both wrappers preserve that path.
3. **E2e cold-load stabilisation** (PR #31, `fix(e2e): absorb cold-load + toast auto-dismiss races on contended hosts`). Pre-push verify on the v1.2.2 bump failed at the local e2e gate — `revision-diff.spec.ts` + 7 others timed out at `page.goto('/')` under parallel-worker contention. Not gated by the release matrix (which runs `verify:quick`, no e2e), but blocked `git push` via the husky pre-push hook. Bumped local `retries: 2` (matching CI) + `use.navigationTimeout: 60_000` in `playwright.config.ts`; bumped `toast-surface.spec.ts`'s auto-dismiss margin from 8 s to 12 s. Post-fix: 0 hard failures, 5 flaky-pass on a 30-spec suite.
4. **Tag annotation in publish job** (PR #32, `fix(ci): fetch tag annotations in release publish job`). v1.2.2 actually shipped — the workflow went green, the zip + SHA-256 uploaded — but the GitHub Release body came out as the bare commit subject (`chore: bump version to 1.2.2`) instead of the long annotation. Root cause: `actions/checkout@v4` defaults to `fetch-tags: false` even with `fetch-depth: 0`. The tag *object* never reached the runner, so `git tag -l --format='%(contents)'` fell back to the commit subject. Workflow now sets `fetch-tags: true` on the publish job's checkout. v1.2.2's body was restored manually via `gh release edit --notes-file …` from the local tag annotation; future tags need no manual restoration.

### Spec invariants — final status

All seven invariants from the "Invariants to preserve" section held in shipped form:

1. **Version lockstep** — ✅ both `package.json` files at `1.2.2`. `scripts/bump-version.mjs`'s pre-flight check refused to run on the two retracted attempts because the working tree was already at the bumped version (lockstep was intact, just the wrong number); refresher cycle was clean.
2. **Tag ↔ commit lockstep** — ✅ `v1.2.2` points at the `chore: bump version to 1.2.2` commit. v1.2.0 / v1.2.1 retractions used `git push origin :vX.Y.Z` + `git tag -d vX.Y.Z` per the documented recipe; no force-pushes of published tags.
3. **Reproducibility from tag** — ✅ the zip content is derived from the tagged commit alone; nothing leaks in from the runner environment apart from the version-string-in-the-archive's-name (which is the tag name itself).
4. **Asset-exclusion list** — ✅ verified by `scripts/tests/release-manifest.test.mjs` (69 assertions, green on all three OSes in the v1.2.2 matrix).
5. **Verify gate** — ✅ enforced harder than expected: v1.2.0 + v1.2.1 *did not publish* because verify failed on at least one matrix leg each time. The "publish job needs verify" dependency held.
6. **Release notes from git** — ✅ restored to true after PR #32. v1.2.2 itself was the counter-example that forced the fix; from here on the workflow is the source.
7. **API key never echoed** — ✅ `server/src/routes/user-settings.test.ts` and `src/views/account.test.tsx` extensions are green; the dedicated `PUT /api/user/settings/gemini-key` is the only write path and `GET /api/user/settings` returns only `apiKeyStatus: 'set' | 'unset'`.
