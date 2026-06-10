---
title: fs-22 — Bundled demo book (real, generate-able) + Replace-manuscript feature
date: 2026-06-11
status: draft
issues:
  - fs-22 (#475) — Bundled demo book (real, generate-able)
  - (new) Replace-manuscript feature — file a Backlog-item issue under area:fs
---

# fs-22 — Bundled demo book + Replace-manuscript

## Summary

Ship **The Coalfall Commission** — an original Castwright work, not public domain —
as a bundled demo book a new user can load on first run and generate with the real
pipeline. The bundle carries a fully-designed 14-character cast (Qwen designed voices
**and** a Kokoro preset fallback), so "Try the sample" lands on **Ready** and a single
**Generate** produces real full-cast audio on any box with a GPU — Qwen if present,
Kokoro otherwise.

Producing that bundle first requires updating the existing on-disk book (whose
manuscript was revised from a single 4-minute scene into a 2-chapter, 14-character
showcase) **without destroying its 5 already-designed voices**. Rather than a one-time
disk swap, we build a reusable **Replace-manuscript** feature: upload a new file onto an
existing book, re-detect chapters, and preserve cast via the existing srv-13 carryover.

Two deliverables, one hard dependency between them:

1. **Replace-manuscript feature** (reusable; foundation for producing the demo content).
2. **fs-22 bundling** (capture → load → affordance), which can only be frozen once the
   content exists.

## Goals

- A new user loads the demo in one click and reaches **Ready** with all 14 characters
  cast — no upload, no analysis wait, no per-character voice design.
- Clicking **Generate** produces real audio end-to-end (doubles as a smoke test).
- The demo "just works" on a box without Qwen by falling back to a Kokoro full cast.
- Authors can revise a manuscript on an existing book without losing designed voices.
- Licensing is trivially clean: the text is original Castwright work.

## Non-goals

- **No pre-rendered audio in the bundle.** The user generates locally (keeps the smoke
  test honest and the bundle small).
- **No re-analysis on load.** The bundle ships the attribution (analysis cache +
  `manuscript-edits.json`), so "who speaks each line" is already known; generation is the
  only pipeline step the demo exercises.
- **No new book identity on replace.** Replace-manuscript keeps bookId/dir/metadata; it
  is not "create a new book."
- No CI GPU smoke test. The generate→audio check is scripted/manual on a GPU box.

---

## Part A — Replace-manuscript feature

### Server: `POST /api/books/:bookId/replace-manuscript`

Multipart `{ file }`, mirroring `/api/import`. Flow:

1. Locate the book (`findBookByBookId`); `404` if absent.
2. Parse the uploaded buffer through the existing `parseManuscript` dispatcher
   (`buffer`, `fileName`, `sourcePath`) — same routing as `/import` and `reparse`.
3. Write the new manuscript into the book dir. If the new extension differs from
   `state.manuscriptFile`, write the new file, delete the old one, and update
   `state.manuscriptFile`. (e.g. `manuscript.epub` → `manuscript.md`.)
4. Run the **shared reparse core** (below) against the freshly-parsed result.
5. Return the fresh `BookStateJson` so the library re-hydrates without a second
   round-trip (same response contract as `reparse`).

Book **identity is preserved**: bookId, directory, title, author, series, cover, and the
`ManuscriptRecord` registration are untouched. Parsed title/author from the new file are
ignored — replacing a manuscript is not a re-import.

### Refactor: extract the reparse core

The current `POST /api/books/:bookId/reparse` body (book-state.ts ~741) does, after
parsing: carryover snapshot → delete `cast.json` → regenerate chapters (preserving
`excluded` by id then slug) → `castConfirmed: false` → `manuscript-edits.json` id
reconciliation (via the GET-side merge) → orphaned-audio cleanup → `change-log` append.

Extract everything **after** "obtain a `parsed` result" into:

```
applyReparse(bookDir, state, parsed, { changeLogType: 'reparse' | 'replace-manuscript' })
  → nextState
```

- `reparse` reads the on-disk buffer, parses, then calls `applyReparse(..., 'reparse')`.
- `replace-manuscript` writes the uploaded buffer, parses, then calls
  `applyReparse(..., 'replace-manuscript')`.

Carryover preservation is **character-keyed** (matchedFrom / voiceId / voiceState /
designed voice / notLinkedTo / aliases), so it is robust to the heavy chapter/sentence
restructuring in the Coalfall revision — the 5 surviving character names (Narrator, Wren,
Master Oduvan, Maerin, Coalfall) rehydrate their designed voices on the next analysis;
the 9 new characters come up un-voiced.

### Frontend: book-card menu item

In `src/components/library/library-grid.tsx`, beside "Re-parse manuscript":

- "Replace manuscript…" → triggers a hidden `<input type="file">`.
- On file pick → destructive `ConfirmDialog`: eyebrow "Replace", body "Re-detects
  chapters and discards generated audio for this book. Designed voices are preserved
  where characters still match."
- On confirm → `api.replaceManuscript(bookId, file)` → on success, run the **same**
  post-reparse redux reset the reparse path runs in `src/routes/index.tsx`
  (`manuscriptActions.reset()`, clear cast slice) so a stale open-book view can't show
  pre-replace state.

### Tests (Part A)

- **Server** (`book-state` suite): replace a book's manuscript with a structurally
  different file → assert chapters changed, `castConfirmed: false`, carryover written,
  designed-voice slice resurrected for a surviving character on next analysis, edits
  reconciled by id, old manuscript file removed when the extension changes.
- **e2e**: book-card menu → "Replace manuscript…" → pick fixture → confirm → lands on
  the cast/ready stage. (Reuses the responsive coverage harness pattern.)

---

## Part B — fs-22 bundle

### Bundle contents (`samples/the-coalfall-commission/`, committed)

The live book's finished `.audiobook/` **minus `audio/`**, plus voice files:

```
samples/the-coalfall-commission/
  manuscript.md
  .audiobook/
    state.json            # castConfirmed: true  → loads onto Ready
    cast.json             # 14 chars, each carrying BOTH overrideTtsVoices.qwen + .kokoro
    <analysis cache>      # attribution: who speaks each line
    manuscript-edits.json # manual edits / emotion tags
  voices/qwen/
    qwen-<char>.{pt,json} # 14 designed voices + emotion variants (~600 KB–1 MB)
  README.md               # licensing note: original Castwright work, all rights reserved
```

Binary `.pt` files (Qwen speaker embeddings, ~20 KB each) are committed directly — small
and stable enough that git-tracking them is fine. No `audio/`. No machine-specific paths.

### Fallback cast (Kokoro)

Each of the 14 characters carries, in `cast.json`, both:
- `overrideTtsVoices.qwen` — the designed voice (full showcase), and
- `overrideTtsVoices.kokoro` — a distinct English Kokoro preset (`af_/am_/bf_/bm_`).

Casting the Kokoro presets by age/gender from the cast sheet: Sela (girl 8) · Wren
(girl 13) · Maerin (woman 40s) · Widow Casper (woman 80s) on the `*f_*` voices; the six
men + Coalfall (deep `bm_`, best-effort non-human) + the bell on `*m_*`. The twins (Brann
/ Berrin) get two distinct male presets so the fallback still separates them.

Generation already routes per-character through `overrideTtsVoices[engine]`, so the
fallback needs **no new routing**: with Qwen loaded the designed cast plays; otherwise the
selected engine resolves to the Kokoro presets. (Verify: confirm the generation path
resolves the active engine's entry from this map and that a missing Qwen surfaces the
existing "model not loaded" affordance rather than a hard failure.)

### Capture script: `scripts/capture-sample-book.mjs`

Re-runnable. Copies the live workspace book → `samples/the-coalfall-commission/`,
stripping `audio/`, normalising any absolute paths, and pulling the referenced
`voices/qwen/qwen-*.{pt,json}` for every character + variant in `cast.json`. This is how
the bundle is **frozen after** the content is produced live, and how it's re-blessed after
any later manuscript/cast edit. Prints a manifest (files + total size).

### Loader: `POST /api/samples/the-coalfall-commission/load`

- Copies `samples/.../` → workspace book dir
  (`books/Castwright/Standalones/The Coalfall Commission`).
- Merges `voices/qwen/*` into the workspace `voices/qwen/` **without clobbering** an
  existing same-named voice.
- Mints a fresh `manuscriptId`; registers the `ManuscriptRecord` (so the analysis
  pipeline is wired) exactly as the `/api/books` route does.
- **Idempotent:** if the book already exists, no-op with a clear response (and optionally a
  `?reset=1` to overwrite). Never silently destroys a user's edited copy.

### Affordance: "Try the sample"

- **Book-library empty state** (overlaps fe-28's first-run guidance) — primary entry.
- **Upload view** (`src/views/upload.tsx`) — secondary, per the issue's "Key files."
- Click → calls the loader → navigates to the loaded book on **Ready**.

### Tests (Part B)

- **e2e**: from an empty library, "Try the sample" → book appears → opens to **Ready**
  with 14 characters assigned. (The load path is mockable; the real copy is exercised by a
  server/integration test.)
- **Server**: loader copies the tree, merges voices without clobber, is idempotent, and
  registers the manuscript.
- **Scripted/manual GPU smoke** (not CI): load → Generate → assert audio renders (Qwen and
  Kokoro paths), folded into the golden-audio recipe notes.

---

## Delivery sequence (hard dependency)

The bundle cannot be frozen until the content exists, and the content needs Part A.

1. **Wave 1 — Replace-manuscript feature.** ✅ SHIPPED 2026-06-11 (branch
   `feat/fs-replace-manuscript`, issue #723, plan `docs/features/205-replace-manuscript.md`).
   Gate before Wave 2: `npm run verify` green → **merge to `main` and `npm run build`
   locally**, so Wave 2 runs against a proper prod build (not a dev worktree). The merge +
   local prod build is an explicit gate before Wave 2.
2. **Wave 2 — Produce content live (manual, GPU box, on the merged prod build).** Restart
   prod (`start:lan` / prod launcher off the freshly-built `main`), then use the new
   feature: replace the Coalfall manuscript → 5 voices preserved → design the 9 new Qwen
   voices → assign Kokoro presets to all 14 → generate once to sanity-check. Not a code PR.
3. **Wave 3 — fs-22 bundling.** Capture script + loader + affordance + fallback wiring +
   tests, one branch/PR (`feat/fs-bundled-demo-book`). Gate: `npm run verify` green and the
   `capture-sample-book` output committed.
4. **Wave 4 — Release packaging.** Include `samples/` in the release zip; document the
   Qwen requirement (and the Kokoro fallback) in INSTALL/README.

## v1 Definition of Done

A fresh user clicks **Try the sample**, lands on **Ready** with the full 14-character
cast assigned, and **Generate** produces real audio (Qwen if present, Kokoro otherwise).
Licensing documented (original Castwright work). An e2e locks the load→Ready path; the
Replace-manuscript feature ships with server + e2e coverage; the capture script is
committed and re-runnable.

## Risks / open questions

- **`.pt` portability** — Qwen speaker embeddings are produced against a pinned Qwen
  build; a divergent install could fail to load them. Mitigation: the golden-audio harness
  already pins Qwen; document the supported engine version. Low risk, flag for Wave 2.
- **Kokoro casting quality** — 28 presets can't match 14 bespoke designs (esp. non-human
  Coalfall and the bell). Fallback is "works + sounds full-cast," not "matches the
  showcase." Acceptable by decision.
- **Bundle/zip size** — text + JSON + ~1 MB voices is negligible; confirm the release
  packaging picks up `samples/`.
- **Backlog hygiene** — file a new Backlog-item issue for the Replace-manuscript feature
  (area:fs) and keep fs-22 (#475) as the bundling item; both get thin BACKLOG.md rows.
