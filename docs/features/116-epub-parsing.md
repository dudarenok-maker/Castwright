---
status: stable
shipped: 2026-05-26
owner: null
---

# EPUB parsing — epub2 primary path + namespace-prefixed-OPF raw-zip fallback

> Status: stable
> Key files: `server/src/parsers/epub.ts`, `server/src/parsers/html-utils.ts`,
> `server/src/parsers/index.ts`, `server/src/routes/manuscripts.ts`,
> `scripts/gen-parser-fixtures.mjs`
> URL surface: `#/new` (no new routes) — owns the EPUB parser internals that
> [02 — Upload (paste or file)](02-upload-paste-or-file.md) delegates.
> OpenAPI ops: `POST /api/manuscripts` (existing)

## Benefit / Rationale

- **User:** Publisher EPUBs that previously failed to import with a cryptic
  `Import failed (500): EPUB had no extractable text in its spine.` now import
  cleanly. This is a whole class of files — any EPUB whose OPF package document
  namespaces its elements with an explicit `opf:` prefix (Simon & Schuster
  titles like *Stellarlune* are the canonical example). When an EPUB genuinely
  can't be read, the message now says **why** (DRM-protected / image-only /
  no readable spine) instead of the generic spine error.
- **Technical:** The `epub2` library's OPF walker only recognises *unprefixed*
  manifest/spine element names, so a prefixed OPF yields an empty `flow`. A
  `yauzl`-based raw-zip fallback re-parses the archive ourselves with
  namespace-prefix-tolerant regex, recovering the text. No new dependency —
  `yauzl` is already a direct server dep; `xml2js`/`adm-zip` stay transitive.
- **Architectural:** Establishes a two-tier parse strategy (library first,
  hand-rolled fallback) and a classified `UnusableEpubError` (HTTP 415) so the
  upload route surfaces actionable failures rather than opaque 500s.

## Architectural impact

- **Two parse paths, one assembly.** `parseEpub` runs `tryEpub2Parse` first; on
  zero chapters *or* any thrown error it falls back to `parseEpubRawZip`. Both
  produce a `RawMeta` + `ChapterHint[]` and funnel through the shared
  `assembleManuscript` (title/series-from-title heuristic + filename-metadata
  fallback), so metadata behaviour is identical regardless of which path ran.
- **`UnusableEpubError`** is defined in `epub.ts` (`extends Error`, mirrors
  `DrmProtectedError` in `mobi.ts`), re-exported from `parsers/index.ts`, and
  mapped to **HTTP 415** in `server/src/routes/manuscripts.ts` (alongside
  `UnsupportedFormatError`).
- **No shared-code changes.** `stripHtml` / `extractFirstHeading` /
  `GENERIC_NCX_RE` in `html-utils.ts` are reused unchanged; the raw-zip path
  extracts `<body>` (and drops `<script>`/`<style>`) *before* `stripHtml` via a
  local `htmlBodyOnly` helper, because — unlike epub2's `getChapter` — it holds
  the whole document and must not let `<head>`/`<title>` text leak into prose.
- **Reversibility:** the fallback only fires when the epub2 path extracts
  nothing, so every EPUB that imported before still takes the identical path.
  Removing the fallback reverts to the prior behaviour with zero migration.

## Invariants to preserve

- **epub2 stays the primary path.** `tryEpub2Parse` (`server/src/parsers/epub.ts`)
  returns `null` — never throws — when epub2 can't open the file or yields zero
  chapters, so `parseEpub` falls back instead of failing.
- **Fallback reads the same bytes.** When `opts.sourcePath` is set the fallback
  re-reads from disk; otherwise it uses the in-memory buffer (which may be empty
  when `sourcePath` wins). It uses `yauzl.fromBuffer` — no second temp file,
  preserving the Windows `%TEMP%`/OneDrive AV-race avoidance documented at the
  top of `epub.ts`.
- **OPF parsing is namespace-prefix-tolerant.** Manifest/spine/meta regexes use
  `<(?:\w+:)?item …>`, `<(?:\w+:)?itemref …>`, `<(?:\w+:)?meta …>` so an `opf:`
  (or any) prefix matches. hrefs resolve relative to the OPF's own directory
  (`opfDir`), trying both raw and URL-decoded keys.
- **Only XHTML/HTML/SVG spine docs become chapters** (`application/xhtml+xml`,
  `text/html`, `image/svg+xml`); `linear="no"` is **not** filtered (front matter
  holds real prose, and the epub2 path doesn't filter it either).
- **Zero-text is classified, never generic.** When even the fallback finds no
  text it throws `UnusableEpubError` with a DRM message (if
  `META-INF/encryption.xml` is present), an image-only message (if spine docs
  resolved but stripped empty), or a no-spine message — mapped to 415.

## Test plan

### Automated coverage

- **Vitest server (`server/src/parsers/epub.test.ts`) — 21 cases.** The
  pre-existing epub2-path cases (metadata, Calibre series, series-from-title,
  title-fallback, audio tags, `sourcePath` re-parse) are unchanged and lock the
  refactor. New cases:
  - *Namespace-prefixed OPF fallback* (`sample-opf-prefixed.epub`): recovers 2
    chapters epub2 cannot walk; prose phrase present; title/author + Calibre
    series carried through; audio-tag pipeline runs (`[emphatic]`,
    `[shouting]`); `sourcePath` re-parse works with no `%TEMP%/epub-*` dir.
    **Fails before the fix** — on `main` this fixture rejects with the old
    `EPUB had no extractable text in its spine.` message.
  - *Diagnostics*: `sample-epub-drm.epub` (has `META-INF/encryption.xml`)
    rejects with `UnusableEpubError` matching `/DRM/i`; `sample-epub-image-only.epub`
    rejects with `UnusableEpubError` matching `/image-only/i`.
- **Fixtures** are committed binaries built by `scripts/gen-parser-fixtures.mjs`
  (adm-zip, dev-time only). Regenerate with `node scripts/gen-parser-fixtures.mjs`
  from the repo root.

### Manual acceptance walkthrough

Run with the real server (`cd server && npm run dev`) — mocks bypass the parser.

1. **Drop a prefixed-OPF EPUB** on `#/new` — e.g. a Simon & Schuster title like
   *Stellarlune*. Expect: no 500; transitions to the analysing stage with a full
   chapter count and non-empty source text. (Verified against the real file:
   57 chapters, ~159.7k words, title "Stellarlune", author "Shannon Messenger".)
2. **Confirm no head/title leak** — chapter bodies start with prose or the real
   `<h1>` heading, not the document `<title>`.
3. **DRM negative path** — drop a DRM-protected EPUB (has `META-INF/encryption.xml`).
   Expect HTTP 415 surfaced as "This EPUB is DRM-protected. Convert it … with
   Calibre first…".

## Out of scope

- **NCX/nav-doc title parity in the fallback.** The fallback titles chapters
  from the body `<h1>` (else `Chapter N`); it does not parse `toc.ncx` /
  `nav.xhtml` navLabels the way the epub2 path does. Deferred — tracked on
  [BACKLOG](BACKLOG.md). Body-heading titles are sufficient for v1.
- **Front-matter trimming.** Title/dedication pages that carry text become
  chapters (same as the epub2 path). Front-matter detection is separate
  (`server/src/parsers/front-matter.ts`) and unchanged here.
- **MOBI DRM status alignment.** MOBI's `DrmProtectedError` still maps to 500 in
  `POST /api/manuscripts` (it predates this fix). Aligning it to 415 is a
  separate follow-up on [BACKLOG](BACKLOG.md) — not changed here to avoid
  coupling MOBI behaviour into an EPUB fix.

## Ship notes

**Shipped 2026-05-26** on branch `fix/server-epub-prefixed-opf-fallback`
(PR to `main`). Bug fix — diagnosed against the real failing file
`Calibre Library/Shannon Messenger/Stellarlune (655)/Stellarlune - Shannon Messenger.epub`,
whose `OEBPS/content.opf` (a valid `version="2.0"` package) prefixes every
element with `opf:`, defeating epub2's `parseManifest`/`parseSpine`.

**Behaviour delta vs. prior:** the only path that changed is the
zero-chapters-from-epub2 case, which previously threw a 500. Every EPUB that
imported before takes the identical epub2 path.
