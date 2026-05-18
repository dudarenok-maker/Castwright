---
status: draft
shipped: null
owner: null
---

# 49 — Release packages on git-tag push

> Status: draft
> Key files: `.github/workflows/release.yml` (new), `scripts/bump-version.ps1` (new), `scripts/build-release-zip.mjs` (new), `INSTALL.md` (new), `docs/BACKLOG.md` (entries), `README.md` (Releases link), `CONTRIBUTING.md` (Releasing section)
> URL surface: none — CI / packaging
> OpenAPI ops: none

## Benefit / Rationale

- **User:** the repo owner can hand a downloadable artefact to a deployer ("here, run this") instead of walking them through a git clone + dev-from-source flow. Cutting a release becomes one command (`pwsh scripts/bump-version.ps1 -Level minor && git push origin main vX.Y.Z`) instead of four manual file edits + a tag.
- **Technical:** introduces the first CI workflow that *writes* to GitHub state (Releases). Codifies a reproducible-from-tag build manifest so every release is rebuildable from its git ref alone.
- **Architectural:** establishes the release seam that the deferred [Could #15 — Windows installer](../BACKLOG.md) and [Could #16 — Docker image](../BACKLOG.md) hang off. Both extend `release.yml` with additional asset-upload steps; neither needs a separate pipeline.

## Architectural impact

- **New seams / extension points:**
  - `.github/workflows/release.yml` — tag-triggered build pipeline. Could-bucket installer / Docker items extend this same workflow (additional jobs / steps) rather than spawning sibling workflows.
  - `scripts/build-release-zip.mjs` — exports a manifest constant (include / exclude rules); both the script and the Vitest test import from this single source.
  - `scripts/bump-version.ps1` — sole sanctioned path for advancing version numbers; replaces ad-hoc file editing.
- **Invariants preserved:**
  - The CI gate from plan 38 / plan 44 (PR title + commit convention) is unaffected — the release workflow runs on tag push, not on PRs.
  - The pre-push `npm run verify` gate from CLAUDE.md "Commit gate" remains the source-of-truth correctness check; the release workflow re-runs `verify:quick` as a sanity net but is **not** the primary test gate.
  - Plan 27 book-state persistence is unaffected — the release zip ships application code only; per-book `state.json` lives under `WORKSPACE_DIR` which is operator-configured, not bundled.
- **Migration story:** none. Versions today (1.1.0 in both `package.json` files per commit `887368`) are already in lockstep; the bump script preserves that invariant going forward.
- **Reversibility:** delete the workflow file + the bump script + the plan; tags and releases on GitHub can be deleted via `gh release delete` and `git push origin :vX.Y.Z`. Per-release artefacts can be re-uploaded manually with `gh release upload` if the workflow is removed.

## Invariants to preserve

1. **Version lockstep** — `package.json:3` and `server/package.json:3` MUST always carry the same version string. `scripts/bump-version.ps1` enforces this both as a pre-flight check (refuses to run if the two have drifted) and as a post-condition (writes both simultaneously via `npm version`).
2. **Tag ↔ commit lockstep** — every `vX.Y.Z` tag MUST point at the `chore: bump version to X.Y.Z` commit. The bump script creates them together; the workflow never creates tags.
3. **Reproducibility from tag** — the release zip MUST be reproducible from the tagged commit alone. No `main`-vs-tag drift; no environment-derived metadata (build date is fine; build host name is not) embedded in the artefact.
4. **Asset-exclusion list** — the release zip MUST NOT include any of: `.env*` (except `.env.example`), `node_modules/`, `.venv/`, `voices/kokoro/*.onnx` (the ~1 GB Kokoro weights — deployer fetches via `install-kokoro.ps1`), `.git/`, `*.log`, `.run/`, `logs/`, `.verify-cache.json`, `e2e/`, `src/` (already pre-built into `dist/`), `CLAUDE.md`, `CONTRIBUTING.md`, anything under `scripts/tests/`.
5. **Verify gate** — the workflow MUST NOT publish the release if `npm run verify:quick` or `npm run build` fail on the tagged commit. (`verify:quick` not full `verify`: the tagged commit already passed pre-push verify on the developer machine; the release workflow's job is rebuild + sanity, not full re-test.)
6. **Release notes from git** — the GitHub release notes MUST be sourced from the annotated tag's message (`git tag -l --format='%(contents)' vX.Y.Z`), not hand-typed in the GitHub UI. Notes live in git.

## Test plan

### Automated coverage

- **Pester** (`scripts/tests/bump-version.Tests.ps1`, new): in a temp-dir copy of the two `package.json` files + lockfiles, runs the bump script and asserts: (a) both versions advance by the requested level, (b) lockfiles regenerate, (c) the commit is created with the expected `chore: bump version to X.Y.Z` subject, (d) the tag is created with an annotation containing the version. Mock or short-circuit `git` writes so the test does not pollute the real repo.
- **Vitest** (`scripts/tests/release-manifest.test.mjs`, new): imports the manifest constant from `scripts/build-release-zip.mjs` and asserts the path-matcher decisions for representative files — includes `server/tts-sidecar/main.py`, excludes `server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx`, excludes `node_modules/foo`, excludes `src/main.tsx` (pre-built), includes `scripts/lib/log-utils.psm1`, excludes `scripts/tests/foo.Tests.ps1`. Wired into the existing `npm run test` discovery (or into `test:hooks` if it stays at the `scripts/tests/` root).
- **No new e2e** — packaging surface; e2e adds no signal. The end-to-end check is the manual tag-push dry-run below.

### Manual acceptance walkthrough

1. On a scratch branch off `main`, run `pwsh scripts/bump-version.ps1 -Level patch -Force` (`-Force` bypasses the "must be on main" guard). Expected: four files modified (`package.json`, `package-lock.json`, `server/package.json`, `server/package-lock.json`), one commit created, one annotated tag (`v<new>`) created locally.
2. `pwsh scripts/bump-version.ps1 -Level patch -DryRun` on a clean tree prints the planned changes without mutating anything.
3. `node scripts/build-release-zip.mjs --version v0.0.0-dry --dry-run` lists the manifest entries without writing the zip; sanity-check the exclusion list.
4. `git push origin <scratch-branch> && git push origin v<new>` — observe `.github/workflows/release.yml` run in the Actions tab. Green = `verify:quick` + `build` + zip + sha256 + `gh release create` all succeeded.
5. Open the release page; download `audiobook-generator-v<new>.zip` and `.sha256`; verify the checksum.
6. On a clean Windows 11 host (or a sandboxed folder), extract the zip; follow `INSTALL.md` step-by-step; expect `npm start` to bring up the app at `http://localhost:5173` with the library visible.
7. Cleanup: `git push origin :v<new>` (delete remote tag), `gh release delete v<new>` (delete release), delete the scratch branch.

## Out of scope

- **Windows installer (Inno Setup / NSIS).** See [`docs/BACKLOG.md`](../BACKLOG.md) Could #15. Extends `release.yml` with a second asset.
- **Docker image + compose file.** See [`docs/BACKLOG.md`](../BACKLOG.md) Could #16. Extends `release.yml` with a `docker/build-push-action` job.
- **Code-signing / SmartScreen reputation.** Tracked alongside Could #15 (installer).
- **In-app auto-update.** Not a v1 concern; deployer manually re-extracts on upgrade per `INSTALL.md`.
- **Bundling Kokoro weights into the release artefact.** Decided 2026-05-18 — weights stay separately fetched via `install-kokoro.ps1` to keep the release zip small and within GitHub's 2 GB per-asset limit.

## Ship notes

(Filled when status flips to `stable`. Append: shipped date, commit SHA, first real tag pushed, release URL, any deltas vs. this spec.)
