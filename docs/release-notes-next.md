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

## 🔊 Generation quality & engine health

- **A chapter render that fails after its audio was encoded no longer leaves a chapter-sized temp file in the book's audio folder.** `finalizeChapterAudioWrite` wrote `<slug>.<ext>.tmp-<pid>-<ts>` before its fallible steps and only renamed it at the end, so any throw in between (the temp write itself, embeddings or segments write, the rename) leaked the file. The exported function is now a wrapper that removes the temp file on any exit before a successful rename, logs and swallows a failed removal, and rethrows the original error. Covered by `finalize-chapter-write.tmp-cleanup.test.ts`. Temp files leaked by earlier failures are not swept; that is #3456's boot sweep, not this fix (#4211, closes #4167).

## 🎭 Cast and re-analysis

- **A re-analysis no longer leaves a book without a narrator row when `cast.json` was rewritten during the run** (a first-upload job that was never registered, a tab without an analysis era, a hand edit on disk): the persist re-creates the narrator from the run's roster (no voice restored) and keeps its lines on it, drift-refused persists included. Every other row deleted mid-run still stays deleted (rule 13). (#4196)

## ⚙️ Setup, prerequisites & dependencies

- **Dependabot root-npm-group refresh: 14 updates landed, no majors, no advisories** (#4065). Runtime: `@reduxjs/toolkit` 2.13.0→2.14.0 (faster `createAction`/`createReducer` dispatch path; pulls `immer` 11.1.8→11.2.9; its RTK Query, listener-middleware and entity-adapter fixes don't reach the app, which uses none of them and has no direct `immer` import), `react-redux` 9.3.0→9.3.1 (`connect` and `Provider` server-state fixes; the app uses the hooks API with a client-only `<Provider>`), `react-router` 8.5.0→8.5.1 (SSR, router `lazy`, fetcher and `<Form>` fixes; the app is a plain `createHashRouter` with `React.lazy` views and none of those) and `@tanstack/react-virtual` 3.14.22→3.14.26 (`virtual-core` 3.19.7→3.19.11 computes `getOffsetForIndex` from current measurements, which reaches `scrollToIndex` over measured rows in `src/views/manuscript.tsx`; covered by `e2e/manuscript-virtualisation.spec.ts`). Dev-only: `@playwright/test` 1.64.1→1.65.0 (Chromium 156→158, **every dev box needs `npx playwright install chromium` again** before `npm run test:e2e`), `vitest` 5.0.5→5.1.0, `@vitejs/plugin-react` 6.1.2→6.2.1, `tailwindcss`/`@tailwindcss/vite` 4.3.3→4.3.4 (production CSS rule-for-rule equivalent), `lightningcss` 1.32→1.33, `vite` 8.3.5→8.3.6 (dev-server hardening: `.wasm` outside `server.fs` is refused and served HTML attributes are escaped, which reaches the LAN dev server), `postcss` 8.5.31→8.5.32, `typescript-eslint` 8.72.0→8.72.1 (still supports `typescript<6.1.0`), `globals` and `@types/node`. No Node `engines` changes, no new install scripts, and no `overrides` or waivers touched.

## 🐛 Other fixes

- **The Generate view no longer scrolls to chapter 3 on every plain load** (#4210, closes #4199). `ReadyRoute` defaults a chapterless URL to chapter 3 and `stageToHash` omits `?chapter=3`, so the plan-102 scroll effect smooth-scrolled `#chapter-3` into view on every load of `#/books/<id>/generate`. `GenerationView` now scrolls only when the URL itself carries a numeric `?chapter=` (read via `useSearchParams` and parsed the way `ReadyRoute` parses it, so a malformed value no longer lands on chapter 3). It scrolls when the URL names a chapter other than 3 at mount, and when `?chapter=` is set or edited, including to 3, while Generate is mounted; a cold `?chapter=3` link scrolls only when hydrating it leaves the persisted `ui.stage` unchanged; otherwise Layout's URL sync drops `?chapter=3` before the view mounts. In-app the param comes from `stageToHash` when the stage's chapter isn't 3, otherwise from a typed or shared URL; the chapter-3 stage default, the router grammar and the Manuscript view are unchanged. Covered by `src/views/generation.test.tsx` and `e2e/generate-explicit-chapter-scroll.spec.ts`.

- **A temp write that fails part-way no longer strands a partial `.tmp-*` file** (#4220, closes #4218). At six temp-then-rename sites the `writeFile` (or, in the sync-folder writer, the `copyFile`) to the temp path sat outside the `try` whose catch unlinks it, so an ENOSPC/EIO/EPERM mid-write left a partial file behind: `stagePortableLocally` (`routes/exports-portable.ts`, the whole-book bundle copy), `writeCoverFile` (`cover/store.ts`), and `writeChapterLufsFile` and `writeChapterPeaksFile` (`tts/mp3.ts`). Each write now sits inside that `try`; the original error still propagates unchanged, and the portable export's local copy stays best-effort. The two sync-folder copies (`writeToSyncFolder`, `writeFolderToSyncFolder` in `export/sync-folder.ts`) get the same defensive cleanup, and a copy failure there now also receives the Google Drive / OneDrive hint a rename failure already got: under such a destination the error carries the hint in a new message, with the same `code` and `cause` set to the original. Covered by a part-way-ENOSPC test per site in `exports-portable.test.ts`, `cover/store.test.ts`, `tts/mp3.test.ts` and `export/sync-folder.test.ts`.

- **Sentence merges survive re-analysis.** The analysis persist and per-chapter roll now carry `manuscript-edits.json`'s `mergedAwayKeys` (fs-58) forward, read under the `book` lock, and fold a tombstoned sentence in a take that predates the merge back into its survivor instead of writing it back; an unreadable edits file now fails the persist rather than being overwritten. The cast-merge route also keeps the tombstones. (#4213, closes #4155)

- **qa-repair no longer scores a re-recorded line against a reference voice recorded at a different Qwen quality tier.** It now derives each character's current model key from the cast plus the requested tier (`currentCastModelKey`, the same formula as the render's per-character stamp) and drops an `audition` centroid recorded at another tier. `scoreBook` now stamps the tier its pooled anchors were rendered at on each `in-book` centroid (`inBookModelKey`: the one key they share, or `mixed`), and qa-repair keeps that row only when the stamp equals the current key; a mixed-tier row, a row with an unknown-tier anchor (an anchor whose chapter snapshot carries two different keys, i.e. a partial write re-recorded lines off the frozen full-render tier, counts as unknown; so does one whose snapshot carries no tier key of its own, i.e. a chapter last fully rendered before 2026-07-06, whose in-book reference is therefore dropped, because the chapter-level key is rewritten by any partial write and is not trusted; see the second residual below for the case where that key still reaches the stamp) and a row written before the stamp (rebuilt, with a stamp, on the next scoring pass) are dropped; an `audition` row likewise records the tier of any real anchors blended into it (`auditionAnchorModelKey`, or `none` for fresh renders only), is usable only when that equals its own voice tier, and is not reused by `scoreBook` otherwise (an audition row whose real anchors sit in a pre-2026-07-06 chapter has no recorded anchor tier, so it is never stamped and is rebuilt on EVERY scoring pass, not only the first: every too-thin character with such an anchor is re-auditioned each pass, and so is an audition row that blends anchors of another tier than its voice, until the chapters carrying those anchors are regenerated; each re-audition renders `max(0, 6 - anchors)` clips plus up to 2 retries, so none at 6 to 9 anchors and up to 7 attempts, and it is a recurring cost, not a one-time one). Two residuals remain, both tracked in #4225 (a per-segment tier stamp at finalize would close both): a later same-tier partial write makes the snapshot's two keys agree again while the earlier off-tier lines remain; and finalize's freeze seed (`finalize-chapter-write.ts`, `prior?.renderedModelKey ?? prior?.modelKey ?? priorFile?.modelKey`) can carry a chapter key that another character's partial write already moved onto a pre-2026-07-06 snapshot, so that character's in-book row is stamped with the moved tier and is not dropped as stated above A dropped character is treated as "no reference"; the audition row's model key now comes from `currentCastModelKey` too (#4195, closes #3518).

- **Paragraph recovery now applies its split points in UTF-16 space, so an emoji or other astral character no longer shifts them** (#4204, closes #4165). In a dash-dialogue book where a source conversion collapsed several turns into one paragraph, each astral character (outside the BMP, such as an emoji; ★ ♥ © are single UTF-16 units and were never affected) earlier in the paragraph shifted every later split point one character right. A single one made recovery miss the turn; two placed the break one character too far right; more moved it further, and the parser then fabricated an unanchored speech span. The split stays length-preserving (each replaced unit is the whitespace immediately before the dash), and lines with no astral characters come out byte-identical to before.

## 🧪 Test gates

- **A version-only `__version__` bump of `server/tts-sidecar/version.py` is now exempt from the sidecar-acceptance gate** (content-checked, fails closed), and the release runbook routes the bump through a PR before the tag push (#4120). The gate's, `verify.yml`'s and `verify-cache`/pre-push's changed-file lists now use `--no-renames`, so a move out of `server/tts-sidecar/**` lists its source path.

## 📦 Dependencies

- **Dependabot server-npm group refresh: 9 updates landed, two majors** (#4121). Runtime: `@google/genai` 2.30.0→3.0.0, `entities` 8.1.0→9.0.0, `openai` 7.43.0→7.54.0, `express-rate-limit` 8.7.1→8.7.4, `cookie` 2.0.1→2.0.2, `undici` 8.12.3→8.12.4. Dev-only: `vitest` 5.0.5→5.1.0, `@types/node` 26.6.5→26.6.6, `supertest` 7.3.1→7.3.2. `@google/genai` 3.0 flips the Gemini Developer API default from `v1beta` to `v1`, and `v1` has no speech output (`speechConfig` / `responseModalities: AUDIO`), so every `new GoogleGenAI` (Gemini TTS, the analyzer transport, the model catalog) now pins `apiVersion: GEMINI_API_VERSION` (`'v1beta'`, exported from `analyzer/catalog/gemini-catalog.ts`); `analyzer/gemini-api-version.test.ts` and `tts/gemini.timeout.test.ts` assert the request path against a real-SDK local endpoint.
