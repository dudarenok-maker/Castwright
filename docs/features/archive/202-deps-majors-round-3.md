---
status: stable
shipped: 2026-06-10
owner: null
---

# 202 — Dependency major upgrades round 3 (srv-38 pdf-parse 2 · srv-39 pdfjs decouple · ops-13 tooling/type majors · ops-14 eslint 10 deferred)

> Status: stable (shipped 2026-06-10 via PR #712, merge `18436529`)
> Follows plan 164 (deps/CI hygiene), 167 (React cluster), 170 (Zod/Express/pdfjs 5/Tailwind 4).
> Key files: `server/package.json`, `server/src/parsers/pdf.ts`, `server/src/parsers/pdf.test.ts`,
> `server/src/parsers/pdf-real.test.ts` (was `pdf-outline.real.test.ts`),
> `server/vitest.config.ts`, `server/vitest.config.slow.ts`, root `package.json`, both lockfiles.
> URL surface: none. OpenAPI ops: none.
> Closes: srv-38, srv-39, ops-13. Refs: ops-14 (deferred), srv-4 (deprecation hygiene).
> Spec: `docs/superpowers/specs/2026-06-10-deps-majors-round-3-design.md`.

## Benefit / Rationale

The wave of majors a fresh `npm outdated` surfaced after plan 170 shipped (audit
2026-06-08). One combined round, plan-170 style; the existing battery is the
regression net plus one new real-path PDF test.

- **User:** none (toolchain/runtime bump). PDF ingestion behaviour is preserved.
- **Technical:** back on supported lines; **removes two direct deps** (`pdfjs-dist`
  and `@types/pdf-parse`); a fresh dual `npm install` prints zero new deprecation
  warnings beyond the pre-existing upstream-blocked `@google/genai` node-domexception
  chain (srv-4 re-audit).
- **Architectural:** PDF parsing now runs a single pdfjs (pdf-parse 2's bundled
  copy) instead of two side-by-side, removing a whole class of worker-version
  collision.

## What shipped (4 commits, one branch)

1. **srv-38 / srv-39 — pdf-parse 2 + drop direct pdfjs-dist** (`6213f396`).
2. **ops-13 (part) — concurrently 10 + jest-axe 10** (`fcbcc794`); eslint 10 deferred.
3. **ops-13 (part) — @types/supertest 7 + @types/yauzl 3** (`a584e31a`).
4. **tail sweep — `npm update`** (`fdf1d27f`): react-router 7.17, typescript-eslint
   8.61, prettier 3.8.4, vite-plugin-mkcert 2.1, @google/genai 2.8, undici 8.4,
   yauzl 3.4, type patches (lockfiles only).

Design spec committed first (`1ee3a8ef`).

## Architectural impact / decisions

- **pdf-parse 1 → 2 is a class-API rewrite** (same author, `mehmet-kozan`, pure TS,
  self-typed → `@types/pdf-parse` dropped). The single
  `const { text, info } = await pdfParse(buffer)` call became
  `new PDFParse({ data }).getText()/getInfo()/destroy()`. `getInfo().info` is the
  same raw PDF Info dict (`Title`/`Author`) v1 exposed, so the metadata-precedence
  logic is unchanged.
- **`getText({ pageJoiner: '' })` is mandatory.** v2 appends a
  `'\n-- N of M --'` marker to every page by default; left on, it pollutes chapter
  detection (and would leak into audio). v1 used bare form-feed page breaks.
- **Direct `pdfjs-dist` removed (the decided pivot from the spec's "bump to 6").**
  pdf-parse 2 bundles its own pdfjs (5.4.x); importing top-level `pdfjs-dist@6`
  alongside it puts two pdfjs in one process, which share global worker state and
  crash with `API version X does not match Worker version Y` **under tsx**
  (`npm run dev` on PDF upload — production/`node` and vitest were unaffected). The
  outline is now read from pdf-parse 2's `getInfo().outline` (the same bookmark
  tree pdfjs' `getOutline()` returned), so there is one pdfjs and one document
  load. `readPdfOutlineTitles` (the separate pdfjs reader) became the pure
  `extractOutlineTitles(outline)`.
- **`pdf-real.test.ts` routed to the serial slow config.** The only suite that
  loads the real pdf-parse 2 destabilises the parallel fork pool (`Worker exited
  unexpectedly`, ~2/3 of full runs; clean single-fork). Routed to
  `vitest.config.slow.ts` (mirror invariant kept with `vitest.config.ts`'s
  exclude) — same class as `generation-boundary-recycle.test.ts`.
- **eslint 9 → 10 DEFERRED (ops-14, upstream-blocked).** The latest published
  `eslint-plugin-react` (7.37.5) and `eslint-plugin-jsx-a11y` (6.10.2) still cap
  their eslint peer at `^9`; eslint 10 removes deprecated context APIs those
  plugins use, so `--legacy-peer-deps` risks broken lint rules. `concurrently 10`
  and `jest-axe 10` (no eslint peer) shipped in this round.
- **`@types/node` intentionally held.** It tracks the runtime's Node line
  (server pinned to Node 20), not a free major bump.

## Invariants to preserve

- `parsePdf` reads text + Info + outline from one `PDFParse` instance; pass
  `getText({ pageJoiner: '' })` to suppress the page marker.
- Do **not** add a direct `pdfjs-dist` dependency back — two pdfjs copies collide
  under tsx. Read the outline from `getInfo().outline`.
- `extractOutlineTitles` stays pure (front-matter filter + count-alignment in
  `parsePdf`); the count-mismatch guard keeps parseText titles.
- `pdf-real.test.ts` stays in both `SLOW_FILES` lists (slow config include + main
  config exclude) — it crashes the parallel pool otherwise.

## Test plan / Automated coverage

- `pdf.test.ts` — mock reshaped to the v2 `PDFParse` class; `getInfo()` yields
  `{ info, outline }`. Covers metadata precedence, outline replacement +
  front-matter filter + misalignment guard, malformed-outline tolerance.
- `pdf-real.test.ts` (new, serial tier) — drives the REAL pdf-parse 2: end-to-end
  parse, no `-- N of M --` marker leak, real `getInfo().outline` →
  `extractOutlineTitles`.
- Existing battery is the regression net for the tooling/type/tail bumps.

Gate (green on the branch): server typecheck + full server suite (parallel, 4/4
clean after the slow-routing) + `test:slow` (206) + frontend `test` (2561) +
`test:a11y` (jest-axe 10, 4/4) + concurrently 10 CLI smoke. Full `npm run verify`
before `gh pr ready`.

## Manual acceptance (owed)

- Parse a real multi-page PDF manuscript end-to-end (chapter split + title/author/
  series) to confirm v2 `getText` output quality on real content — the committed
  fixture is a degenerate recovery-mode PDF that can only guard wiring, not prose
  fidelity.

## Ship notes

- **Shipped 2026-06-10** via PR #712 (merge commit `18436529`), `--merge --admin`
  (CI billing-blocked; local `npm run verify` authoritative). Closed srv-38 #708,
  srv-39 #709, ops-13 #710; ops-14 #711 (eslint 10) stays open as the deferred
  follow-up. Local `main` pulled + `npm install` (root + server) + full `npm run
  build` green post-merge.
- **srv-4 re-audit:** confirmed — a fresh dual install prints zero new deprecation
  warnings beyond the pre-existing upstream-blocked `@google/genai` node-domexception
  chain.
- **Owed:** the manual real-multi-page-PDF acceptance above (the committed fixture
  guards wiring, not prose fidelity).
