# ORT acceptance step C — A39 (register calls it A40 in this brief's stale numbering)

**Row:** *The in-app upgrade path applies the marker on a real installed release* ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../../features/282-ort-pip-consistency-marker.md)). Identified by title, not number — Castwright#2619's brief called this row A40; PR #2626 (wave 5, merged 05:22Z 2026-08-23) renumbered Group A and this row is **A39** on `main` as of this run (`docs/testing/onbox-acceptance-register.md:2419`). `A40` on `main` is now an unrelated Russian-XTTS row (#2026) — not touched. Run by: claude (Castwright#2619).

**Date:** 2026-08-23.

**VERDICT: STILL OWED — BLOCKED. No packaged release directory is available on this box.**

## Dependency check (issue's step 1)

Confirmed on `wt-2623-ort-acceptance` before running anything (the issue's own body records the gate as already promoted/lifted; verified independently here):

```
$ grep -n "extraRuntimeSteps\|nvidia-cudnn-cu12" server/tts-sidecar/scripts/install-ort.mjs
271:const NVIDIA_CUDNN_CONSTRAINT = 'nvidia-cudnn-cu12~=9.0';
348:export function extraRuntimeSteps(ortPackage) {
```
`preload_dlls`/`_preload_ort_cuda_dlls` present in `server/tts-sidecar/main.py`. Both present. `git log` on this worktree shows `2cbcdd73 Merge pull request #2617` already in history — no fetch/merge needed, already up to date with `origin/main`.

## What "a real installed release" means, per the code

Read `server/src/upgrade/paths.ts` and `server/src/upgrade/apply.ts` before searching, to know what to look for rather than guessing:

- `apply.ts:84`: `releaseDir = join(ctx.releasesDir, 'v${ctx.candidateVersion}')` — a real release is a subdirectory named `vX.Y.Z` under a `releases/` directory.
- `paths.ts:3-5` (own comment): *"`<install>/releases/vX.Y.Z`, so `installRoot` is two levels up... In a plain checkout (no `releases/` ancestor) `installRoot == repoRoot`... (apply is a dev-only path there)."*
- `paths.test.ts:12-23` confirms both cases in code: a path under a `releases/` ancestor (e.g. `/opt/audiobook/releases/v1.2.3`) resolves `installRoot` to the install root two levels up; a plain checkout resolves `installRoot` to the checkout itself, which is explicitly the **dev-only, not-a-real-release** case.

So the acceptance target is a directory tree that is: (a) not this git worktree or any other worktree/checkout, (b) sits under a `releases/` parent, (c) was produced by the packaging/install path (`npm ci` + extracted zip), not `git clone`. A dev checkout under `releases/` by coincidence would not qualify either — it has to have gone through `applyUpgrade`'s `extract`/`npmCi`/`pipInstall` steps, or the equivalent first-install path, to have a marker "already present from a prior bootstrap or self-heal" as the row requires.

## What was checked for a real installed release directory

- **Primary checkout and worktrees** — `C:\Claude\Projects\Audiobook-Generator` (the primary checkout) and `C:\Claude\Projects\wt-2623-ort-acceptance` (this worktree) are both git checkouts directly under `C:\Claude\Projects`, not under any `releases\` ancestor:
  ```
  Test-Path 'C:\Claude\Projects\Audiobook-Generator\..\releases'  → False
  (Get-Item 'C:\Claude\Projects\Audiobook-Generator').Parent.FullName → C:\Claude\Projects
  ```
  Confirms the dev-only branch of `paths.ts` applies to every checkout on this box — none of them is a real release layout.
- **Common Windows install locations** — searched for any `*astwright*` directory:
  ```
  Get-ChildItem 'C:\' -Directory -Filter '*astwright*'                         → (none)
  Get-ChildItem 'C:\Program Files' -Directory -Filter '*astwright*'            → (none)
  Get-ChildItem 'C:\Program Files (x86)' -Directory -Filter '*astwright*'      → (none)
  Get-ChildItem "$env:LOCALAPPDATA\Programs" -Directory                       → Common, Microsoft VS Code, Ollama, Paradox Interactive, Pinokio, Python
  Get-ChildItem "$env:LOCALAPPDATA" -Directory -Filter '*astwright*'           → (none)
  Get-ChildItem "$env:APPDATA" -Directory -Filter '*astwright*'                → (none)
  ```
  No Castwright installation anywhere `%LOCALAPPDATA%\Programs`, `Program Files`, `Program Files (x86)`, or the root of `C:\`.
- **Running process** — no `*astwright*` or `electron` process running:
  ```
  Get-Process | Where-Object { $_.ProcessName -match 'astwright|electron' }    → (none)
  ```
- **Uninstall registry (installer-based install would register here)**:
  ```
  HKLM:\...\Uninstall\* where DisplayName -match 'astwright'   → (none)
  HKCU:\...\Uninstall\* where DisplayName -match 'astwright'   → (none)
  ```

None of these surfaced a `releases/vX.Y.Z` tree, a running installed instance, or an installer registration. This box only has git checkouts (the primary repo and worktrees), which `paths.ts` itself designates as the dev-only, not-a-real-release case.

## Why this stops here rather than manufacturing one

The issue is explicit: *"If one is not [available], and you cannot produce one without a release cut (which you must never do — never push a tag, never cut a release), then record STILL OWED — blocked."* Producing a real `releases/vX.Y.Z` tree that has gone through the actual packaging pipeline (not a hand-copied checkout renamed to look like one) requires cutting a release, which is out of scope by the issue's own "Not in scope" list and by the standing rules on parent #2606/#2623. A hand-assembled directory that merely has the right shape would not exercise the real `applyUpgrade` code path against real packaging output, and would produce exactly the kind of confident-but-wrong answer the issue's own override section warns about for the CUDA-DLL question — the same principle applies here: a fake release proves nothing about the real path.

## Continuity with prior waves

This matches the standing conclusion already on record for this row: **Wave-3 step 2, 2026-08-20 — STILL OWED, not run. Needs a real installed Castwright release directory (`release/` layout).** (`docs/testing/onbox-wave3-results/step-2-ort-marker.md`, cited verbatim in the register row itself.) No installed release has appeared on this box between wave 3 and this run; the row remains owed for the same reason, now re-verified independently rather than assumed from the earlier note.

## What this run does not claim

No code in `server/src/upgrade/apply.ts` or `apply-ort-marker.test.ts` was exercised against a real `spawn`, a real `venvDir`, or a real packaged release directory — exactly the gap the register row itself describes as never having been driven. This run only establishes, with fresh evidence, that the prerequisite for doing so is absent on this box.

## Not in scope, not touched

A36, A37, A38 (already run in Castwright#2621 and #2620) and A40 (now an unrelated Russian-XTTS row per the register renumbering) — not touched. No fix was made to anything; nothing was found broken in passing. No release was cut, no tag was pushed.

**Live venv and worktree untouched** — this run only read files and ran read-only filesystem/process/registry queries; no venv, dev checkout, or worktree file was modified.

**No register edit made**, per the issue's acceptance criteria.
