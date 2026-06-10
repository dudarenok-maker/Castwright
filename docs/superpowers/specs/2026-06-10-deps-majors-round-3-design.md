# Dependency majors round 3 — design

> Date: 2026-06-10 · Follows plan 164 (deps/CI hygiene), 167 (React cluster), 170 (Zod/Express/pdfjs/Tailwind).
> Branch: `worktree-deps-round-3` (isolated worktree). One PR, plan-170 style.

## Problem

A fresh `npm outdated` (2026-06-08 audit, re-confirmed 2026-06-10) surfaces a new wave of
majors behind, none yet tracked by an issue. Fold them into one deps round.

| Tier | Bump | Gate |
|---|---|---|
| Functional (server) | `pdfjs-dist 5 → 6` | real-path pdf test |
| Functional (server) | `pdf-parse 1 → 2` (+ drop `@types/pdf-parse`) | real-path pdf test |
| Tooling (root) | `eslint 9 → 10` (+ `@eslint/js`) | `npm run lint` |
| Tooling (root) | `concurrently 8 → 10` | dev scripts smoke |
| Tooling (root) | `jest-axe 9 → 10` | `npm run test:a11y` |
| Types | `@types/supertest 6 → 7` | `npm run typecheck` |
| Types | `@types/yauzl 2 → 3` | `npm run typecheck` |
| Non-major tail | `npm update` sweep (see below) | existing battery |

`@types/node` is intentionally **not** bumped to a new major — it tracks the runtime's Node
line (root on 25, server pinned to 20), not a free bump.

Non-major tail (accumulated since round 2, swept via `npm update`):
root — `react-router-dom 7.17`, `typescript-eslint`, `prettier 3.8.4`, `vite-plugin-mkcert 2.1`,
`@types/react`/`@types/node` patches; server — `@google/genai 2.8`, `undici 8.4`, `yauzl 3.4`.

## Decisions (from brainstorming)

1. **Single combined round, one branch/PR** — matching plan 170 (which bundled functional +
   tooling). Verified once locally with the full `npm run verify` battery before `gh pr ready`.
2. **Sweep the non-major tail too** — a separate `npm update` commit alongside the majors, so
   the round clears the whole `npm outdated` list and satisfies the srv-4 deprecation re-audit.
3. **Per-major issue tracking** (like plan 170 srv-24/25/26/fe-20) — a dedicated issue each for
   `pdfjs 6` and `pdf-parse 2`, plus one grouping the tooling/type majors; thin `BACKLOG.md` rows;
   `Closes #NN` on the PR; `Refs srv-4` for deprecation hygiene.

## Blast radius

- **Both functional bumps touch exactly one file:** `server/src/parsers/pdf.ts`. Nothing else
  imports `pdf-parse` or `pdfjs-dist`.
- Tooling/type bumps touch only config + lockfiles; the existing battery is the regression net.

## The risky half — `server/src/parsers/pdf.ts`

`pdf-parse` v2 is the **same author's** (`mehmet-kozan`) pure-TypeScript rewrite — a legit
successor, not a hostile fork. It ships its own types (so `@types/pdf-parse` is dropped) and
uses a class-based API instead of v1's single-call function.

- **v1 (today):** `const { text, info } = await pdfParse(buffer)`, then `info.Title` / `info.Author`.
- **v2 (target):**
  ```ts
  import { PDFParse } from 'pdf-parse';
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const { text } = await parser.getText();
    const info = await parser.getInfo();   // shape differs from v1's raw PDF dict
  } finally {
    await parser.destroy();
  }
  ```
- **The load-bearing seam:** v2's `getInfo()` returns a normalized shape (title/author/pages),
  NOT v1's raw `info.Title`/`info.Author`. The exact property names are verified against the
  real package during implementation and mapped back to the existing `metaTitle`/`metaAuthor`
  logic. This is the one behavioural risk in the round.
- **pdfjs-dist 6:** keep the `legacy/build/pdf.mjs` outline-read path; confirm v6's
  `getDocument` options + `getOutline()` shape didn't shift (v5→6 is a smaller jump than the
  v4→5 one that removed `isEvalSupported`). We keep our own `pdfjs-dist` dep for outline reading
  even though pdf-parse 2 bundles pdfjs internally — they are independent imports.

## Coverage this round owes (the parse-regression gate)

`pdf.test.ts` mocks pdfjs and so cannot catch a v2 wiring break — the same gap plan 170 hit.
Extend the **real-path** test `server/src/parsers/pdf-outline.real.test.ts` (+ its committed
fixture) to also assert v2 **text and metadata** (title/author) extraction against the real
`PDFParse`, not just the outline. Manual acceptance: parse one real PDF manuscript end-to-end
(chapter split + title/author/series) before shipping.

## Commit structure (one branch)

1. `chore(server): pdf-parse 2 + pdfjs-dist 6` — migration + extended real-path test (committed
   together since the two interact).
2. `chore(deps): eslint 10 + concurrently 10 + jest-axe 10` — tooling majors.
3. `chore(deps): @types/supertest 7 + @types/yauzl 3` — type majors.
4. `chore(deps): sweep non-major tail (npm update)` — accumulated minors/patches; srv-4 re-audit.

## Open risks (resolved during implementation, not the spec)

- **eslint 10** may drop deprecated rules/configs or shift flat-config defaults → caught by
  `npm run lint`; fix forward in commit 2.
- **pdfjs v6** `getDocument` option drift → caught by `test:server` real-path test; fix in commit 1.
- **`getInfo()` property names** → verified against the installed package, pinned by the new test.

## Verification gate

`npm run verify` (typecheck + all tests + e2e + build) — same battery as pre-push. Watch
specifically: `npm run lint` (eslint 10), `npm run test:server` (pdf real-path), and a fresh
dual `npm install` printing **zero new** deprecation warnings (the srv-4 re-audit; the
pre-existing upstream-blocked `@google/genai` node-domexception chain is the only allowed
remainder).

## Tracking & docs

- 3 Backlog-item issues (pdfjs 6 · pdf-parse 2 · tooling+types group) + thin `BACKLOG.md` rows.
- New plan `docs/features/NNN-deps-majors-round-3.md` from the plan-170 mould (status `stable`
  on ship, Ship notes filled with date + merge SHA); `docs/features/INDEX.md` updated.
