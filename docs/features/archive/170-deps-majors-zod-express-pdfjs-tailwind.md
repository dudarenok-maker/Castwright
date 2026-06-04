---
status: stable
shipped: 2026-06-02
owner: null
---

# 170 — Dependency major upgrades round 2 (srv-25 Zod 4 · srv-24 Express 5 · srv-26 pdfjs 5 · fe-20 Tailwind 4)

> Status: stable (shipped 2026-06-02 via PR #489, merge `ffc3016`)
> Key files: `server/package.json`, `package.json`, `server/src/analyzer/ollama.ts`,
> `server/src/handoff/schemas.ts`, `server/src/http.ts`, `server/src/error-handler.ts`,
> `server/src/parsers/pdf.ts`, `src/styles.css`, `postcss.config.js`, `tailwind.config.ts` (deleted)
> URL surface: none (toolchain/runtime bump). OpenAPI ops: none.
> Closes: #405 (srv-25), #406 (srv-24), #410 (srv-26), #409 (fe-20)

## Benefit / Rationale

The last four framework majors that plan 164 filed as research-complete and plan 167
deferred. Zero behaviour change; the existing battery is the regression net.

- **User:** none.
- **Technical:** back on supported major lines; **deletes the `zod-to-json-schema`
  dependency** (Zod 4 has native `z.toJSONSchema`); Tailwind 4's faster engine
  (autoprefixer + postcss-import boilerplate dropped). A fresh `npm install` prints
  zero new deprecation warnings (closes the srv-4 re-audit for this round).
- **Architectural:** supported Express 5 async-error pipeline; Tailwind theme is now
  CSS-first.

## What shipped (4 commits, one branch)

1. **srv-25 Zod 4** (`f1e50aa`) — `zod ^3.23.8 → ^4`, removed `zod-to-json-schema`.
2. **srv-24 Express 5** (`8fcf2a4`) — `express ^4.19.2 → ^5`, `@types/express → ^5`.
3. **srv-26 pdfjs 5** (`d302f27`) — `pdfjs-dist ^4.10.38 → ^5`.
4. **fe-20 Tailwind 4** (`1f9d76c`) — `tailwindcss ^3.4.10 → ^4`, `@tailwindcss/postcss`,
   `autoprefixer` removed.

## Architectural impact / decisions

- **Zod `z.toJSONSchema` options.** The single load-bearing call (Ollama
  constrained-decoding `format`, `ollama.ts`) went from
  `zodToJsonSchema(schema, { $refStrategy: 'none' })` to
  **`z.toJSONSchema(schema, { target: 'draft-07', reused: 'inline' })`** — `draft-07`
  keeps the dialect the old package emitted, `reused:'inline'` is the `$refStrategy:'none'`
  equivalent. The codebase has **no** string-format validators (`.email/.uuid/.url`)
  and no custom error maps, so the rest of the Zod surface was untouched. New
  `handoff/schemas.test.ts` pins the JSON-Schema shape (`additionalProperties:false`,
  `minItems:1`, no `$ref/$defs`) the decoder depends on.
- **Express `@types/express` 5 params type.** v5 widened `req.params` values to
  `string | string[]` (path-to-regexp v8 wildcards/repeats). 127 type errors. We use
  only single `:segment` params, so **`server/src/http.ts`** re-exports `Request`
  narrowed to `Record<string,string>` (the Express-4 shape) and every route file imports
  `Request`/`Response` from there instead of `'express'`.
- **Express 5 `res.sendFile` dotfiles.** v5's `send` upgrade defaults `dotfiles:'ignore'`,
  which 404s any path with a `.`-segment. `cover.jpg` and the share M4B both live under
  `.audiobook/`, so both 500'd. Restored with **`dotfiles:'allow'`** on those two calls
  only — `chapter-audio` (`audio/`) and `export` (`exports/`) serve non-dot paths, and
  serve-static's dotfiles default is unchanged between v4/v5 (the `/audio` + `/workspace`
  static mounts are unaffected).
- **Express 5 error handler.** New `server/src/error-handler.ts` mounted last in
  `index.ts` — Express 5 forwards async-handler rejections into the error pipeline (v4
  hung); this turns any uncaught throw/rejection into a clean `500 { error }`.
- **pdfjs 5.** Legacy ESM import (`pdfjs-dist/legacy/build/pdf.mjs`) is retained in v5;
  outline-only read needs no worker. v5 removed `isEvalSupported` from
  `DocumentInitParameters` — dropped (no-op for us). New committed fixture
  (`parsers/__fixtures__/outline-sample.pdf`) + un-mocked `pdf-outline.real.test.ts`
  drive the REAL v5 path (`pdf.test.ts` mocks pdfjs and couldn't catch a wiring break).
- **Tailwind 4.** `npx @tailwindcss/upgrade` did the bulk: `@import 'tailwindcss'` +
  `@theme` tokens in `styles.css`, deleted `tailwind.config.ts` (v4 auto-detects content),
  migrated `postcss.config.js`, and renamed utilities to preserve v3 visuals
  (`outline-none→outline-hidden`, `shadow-sm→shadow-xs`, `bg-ink/[0.04]→bg-ink/4`; 62
  files). Two hand-fixes: re-added `coarse-pointer`/`fine-pointer` as v4
  `@custom-variant` directives (were `addVariant` plugins in the deleted config; still used
  by touch affordances — desktop baselines can't catch them), and updated
  `match-detail.test.tsx`'s z-index regex (v4 emits `z-60`, v3 emitted `z-[60]`).

## Invariants to preserve

- Ollama structured-output JSON Schema stays `additionalProperties:false` / `minItems:1`
  / fully inlined — pinned by `handoff/schemas.test.ts`. Keep `ollama.ts`'s
  `z.toJSONSchema` options in sync with that test.
- Route handlers import `Request`/`Response` from **`server/src/http.ts`**, not `'express'`,
  so `req.params.x` stays `string`.
- Any `res.sendFile` of a path under a book's `.audiobook/` dir needs `dotfiles:'allow'`.
- The `coarse-pointer`/`fine-pointer` variants live as `@custom-variant` in `src/styles.css`.
- Tailwind theme/tokens live in `styles.css` (`@theme` + `:root` vars). There is no
  `tailwind.config.ts`.

## Test plan / Automated coverage

New tests (the seams the bumps touched that were previously uncovered or mock-hidden):
`handoff/schemas.test.ts` (Zod JSON-Schema contract), `error-handler.test.ts` (Express 5
async-reject backstop), `parsers/pdf-outline.real.test.ts` + fixture (real pdfjs v5). The
existing battery is the regression net for the rest.

Gate (green on `chore/deps-majors-plan-170`):

- `npm run typecheck` (frontend + server) · `npm run lint`
- `npm run test` — 2170 frontend · `npm run test:server` — 1750
- `npm run build` (Tailwind v4 engine; bundle intact)
- `npm run test:e2e:visual` — 14 win32 baselines green after re-baking `library-dark`
  (only surface to cross 0.05; the other 13 within tolerance).

## Ship notes

- **Shipped 2026-06-02** via PR #489 (merge commit `ffc3016`), closing #405/#406/#410/#409.
  CI `npm run verify` green (16m02s) on Linux — the Windows-only `analysis-pipelining`
  contention flake (180s timeout under full-parallel load; 6/6 in 3.4s isolated, PR #292)
  did not recur on CI. Local battery run green leg-by-leg before push.
- **Linux visual baselines owed:** Tailwind 4 shifts the Linux baselines too, but CI's
  `test:e2e` excludes the visual spec, so PR CI is unaffected. After merge, run the
  `regen-visual-baselines.yml` workflow (`workflow_dispatch`) to regenerate the Linux
  PNGs for v4 — it opens its own PR (same flow plan 167 used).
- **srv-4 deprecation re-audit:** confirm a fresh root + server `npm install` still prints
  zero new deprecation warnings (only the pre-existing `@google/genai` node-domexception
  chain remains, upstream-blocked).
