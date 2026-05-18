---
status: active
shipped: null
owner: dudarenok
---

# 49 — Release packages on git-tag push

> Status: active (PR open)
> Key files: `.github/workflows/release.yml`, `scripts/bump-version.mjs`, `scripts/build-release-zip.mjs`, `scripts/start-app-prod.mjs`, `scripts/stop-app.mjs`, `server/tts-sidecar/scripts/install-kokoro.sh`, `server/src/frontend-static.ts`, `INSTALL.md`, `CONTRIBUTING.md` (Releasing section), `README.md` (Releases link).
> URL surface: `http://localhost:8080` (production-mode launch via `npm run start:prod`).
> OpenAPI ops: `PUT /api/user/settings/gemini-key` (new — UI-managed API key).

## Benefit / Rationale

- **User:** the repo owner can hand a downloadable artefact (`audiobook-generator-vX.Y.Z.zip`) to a deployer ("here, run this") instead of walking them through a git clone + dev-from-source flow. Cutting a release becomes one command (`node scripts/bump-version.mjs --level minor --notes-file …` + two `git push`es) instead of four manual file edits + a tag. Deployer is on Windows / macOS / Linux — the artefact works on all three from the same zip.
- **Technical:** introduces the first CI workflow that *writes* to GitHub state (Releases). Codifies a reproducible-from-tag build manifest so every release is rebuildable from its git ref alone. Adds a production-mode server path (`express.static(dist)` + `npm run start:prod`) that survives outside the dev orchestrator.
- **Architectural:** establishes the release seam that the deferred [Could #21 — Windows installer](../BACKLOG.md) and [Could #22 — Docker image](../BACKLOG.md) hang off. Both extend `release.yml` with additional asset-upload steps; neither needs a separate pipeline. Also unblocks [Could #37 — In-app multi-model management UX](../BACKLOG.md), which closes the "deployer can't install Ollama without leaving the app" gap that plan 49's Kokoro-only install bundle leaves.

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
- **Windows installer (Inno Setup / NSIS)** — BACKLOG Could #21. Extends `release.yml` with a second asset.
- **Docker image + compose file** — BACKLOG Could #22. Extends `release.yml` with a `docker/build-push-action` job.
- **Code-signing / SmartScreen reputation / macOS Gatekeeper notarization** — tracked alongside Could #21 (installer).
- **In-app auto-update** — not a v1 concern; deployer manually re-extracts on upgrade per `INSTALL.md`'s "Updating" section.
- **Bundling Kokoro weights into the release artefact** — decided 2026-05-18: weights stay separately fetched via `install-kokoro.{ps1,sh}` to keep the release zip small (~5-10 MB) and within GitHub's 2 GB per-asset limit.
- **Architecture-specific zips** (`-darwin-arm64.zip` vs `-darwin-x64.zip`). The current artefact is platform-independent — only relevant if we ever pre-bundle native binaries.

## Ship notes

(Filled when status flips to `stable`. Append: shipped date, commit SHA, first real tag pushed, release URL, any deltas vs. this spec.)
