<!--
Release notes for the NEXT version (technical register — this IS the GitHub
release body). bump-version.mjs feeds this file verbatim as the annotated-tag
message → release.yml, and uses it by DEFAULT (no --notes-file needed).
Everything in this HTML comment is invisible in the rendered release, so it
never leaks into the body.

TWO-FILE SHAPE (v1.15.0 onward when a cycle outgrows the limit): GitHub rejects
a release body over 125,000 characters, so a large cycle keeps the complete
technical changelog in docs/release-notes/vX.Y.Z-full.md (linked from the foot
of this file by an absolute URL pinned to the tag) and this file carries the
condensed body: keep it well under ~60,000 characters. A cycle that fits simply
keeps its full text here and needs no archive. Bug fixes belong in the notes
only if the bug could have affected the previously published version; a fix to
something introduced this cycle is folded into that feature's description.

Keep it current for each release:
  1. Update the version marker below.
  2. Rewrite the body (theme paragraph → ## ✨ Headline features with
     ### … (new) subsections → emoji-themed sections → bold-lead bullets with
     (#PR) refs → **Full changelog:** vPREV...vNEW footer). v1.7.0 is the
     canonical example; see CONTRIBUTING.md "Release notes".

The marker is what bump-version checks: if it doesn't match the version being
cut, the bump refuses (so a stale file can't ship as the body). The
user-facing, brand-voice notes live separately in RELEASE_NOTES.md (#/release-notes).

release-notes-next-version: 1.16.0

Cycle opened 2026-11-13 (v1.15.0 shipped 2026-11-13; first PR of the new
cycle reopens this file per CONTRIBUTING.md "Release notes"). Populated
PR-by-PR as the v1.16.0 cycle progresses — do not reconstruct from git
history at cut time.
-->

## ⚙️ Setup, prerequisites & dependencies

- **Dependabot root-npm-group refresh: 14 updates landed, no majors, no advisories** (#4065). Runtime: `@reduxjs/toolkit` 2.13.0→2.14.0 (faster `createAction`/`createReducer` dispatch path; pulls `immer` 11.1.8→11.2.9; its RTK Query, listener-middleware and entity-adapter fixes don't reach the app, which uses none of them and has no direct `immer` import), `react-redux` 9.3.0→9.3.1 (`connect` and `Provider` server-state fixes; the app uses the hooks API with a client-only `<Provider>`), `react-router` 8.5.0→8.5.1 (SSR, router `lazy`, fetcher and `<Form>` fixes; the app is a plain `createHashRouter` with `React.lazy` views and none of those) and `@tanstack/react-virtual` 3.14.22→3.14.26 (`virtual-core` 3.19.7→3.19.11 computes `getOffsetForIndex` from current measurements, which reaches `scrollToIndex` over measured rows in `src/views/manuscript.tsx`; covered by `e2e/manuscript-virtualisation.spec.ts`). Dev-only: `@playwright/test` 1.64.1→1.65.0 (Chromium 156→158, **every dev box needs `npx playwright install chromium` again** before `npm run test:e2e`), `vitest` 5.0.5→5.1.0, `@vitejs/plugin-react` 6.1.2→6.2.1, `tailwindcss`/`@tailwindcss/vite` 4.3.3→4.3.4 (production CSS rule-for-rule equivalent), `lightningcss` 1.32→1.33, `vite` 8.3.5→8.3.6 (dev-server hardening: `.wasm` outside `server.fs` is refused and served HTML attributes are escaped, which reaches the LAN dev server), `postcss` 8.5.31→8.5.32, `typescript-eslint` 8.72.0→8.72.1 (still supports `typescript<6.1.0`), `globals` and `@types/node`. No Node `engines` changes, no new install scripts, and no `overrides` or waivers touched.

## 🧪 Test gates

- **A version-only `__version__` bump of `server/tts-sidecar/version.py` is now exempt from the sidecar-acceptance gate** (content-checked, fails closed), and the release runbook routes the bump through a PR before the tag push (#4120). The gate's, `verify.yml`'s and `verify-cache`/pre-push's changed-file lists now use `--no-renames`, so a move out of `server/tts-sidecar/**` lists its source path.
