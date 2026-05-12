# Project context for Claude Code

This repo is a UI/UX prototype of an audiobook-generation tool. It currently
runs as a static HTML file (`app/index.html`) with in-browser Babel and
UMD-from-CDN React/Redux. **Your job is to convert it into a real
production-shaped app using the playbook in `HANDOFF.md`** — do not start
new design work.

## What's in the box
- `app/` — the prototype source. Read-only reference; do not edit in place.
  - `app/index.html` — entry HTML, loads everything via `<script>` tags.
  - `app/app.jsx` — root React component.
  - `app/lib/*.js` — pure utilities (icons, time, colors, router, **api**).
  - `app/data/*.js` — design fixtures (characters, chapters, voices, etc).
  - `app/store/*.js` — Redux Toolkit slices.
  - `app/components/*`, `app/modals/*`, `app/views/*` — React components.
  - `app/styles.css` — single stylesheet, design tokens as CSS variables.
  - `app/openapi.yaml` — **API contract**, source of truth for backend shapes.
  - `app/mocks/canned-data.js` — composed mock payloads matching the OpenAPI.
- `app/ARCHITECTURE.md` — module map and state-shape reference.
- `app/package.json`, `app/vite.config.ts`, `app/tsconfig.json` — scaffolding
  for the new build. Move these to the root as part of the migration.
- `HANDOFF.md` — **read this first**. Step-by-step migration plan.

## Conventions worth preserving
- **Discriminated-union `ui.stage`** — see `store/ui-slice.js`. Keep this; it's
  the right shape.
- **Hash router grammar** — `lib/router.js` documents the URL ↔ store mapping.
  Replace the implementation (use `react-router`), keep the grammar identical.
- **API contract lives in `openapi.yaml`** — generate types from it, don't
  hand-write `Character`/`Chapter`/`Sentence` interfaces.
- **Design tokens are CSS custom properties** — `styles.css` declares `--peach`,
  `--ink`, `--magenta`, etc. and Tailwind references them. Don't reintroduce
  hex literals in component code.
- **Mocks behind `USE_MOCKS` flag** — every `mock*` function in `lib/api.js`
  must keep working in dev. Real `fetch()` lives behind the same `api.*`
  surface; the components never know which is which.

## Out of scope until told otherwise
- New features. The prototype's surface area is final for v1.
- Visual redesign. The look is approved; reproduce it pixel-for-pixel.
- Backend work. You're building the frontend that will call the OpenAPI spec.

## Definition of done
1. `npm run dev` boots a Vite dev server, app loads with HMR.
2. `npm run typecheck` is clean.
3. `npm run build` produces a working `dist/`.
4. All 6 stages from the URL grammar are reachable and styled.
5. Mocks work end-to-end with `VITE_USE_MOCKS=true`.
6. No `Object.assign(window, …)` remains. No CDN `<script>` tags.
7. No in-browser Babel. No `file://` assumption.
