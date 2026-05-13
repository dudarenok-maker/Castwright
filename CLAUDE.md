# Project context for Claude Code

Frontend for an audiobook-generation tool. Vite + React 18 + TypeScript +
Redux Toolkit. Mocked API surface today; designed to swap to a real backend
without changing component code.

## Commands
- `npm run dev` — Vite dev server (HMR) on `http://localhost:5173`.
- `npm run typecheck` — `tsc --noEmit` (frontend + server).
- `npm test` — Vitest single-run for the frontend.
- `npm run test:server` — Vitest single-run for the server.
- `npm run test:all` — frontend + server tests (matches the pre-commit hook).
- `npm run verify` — full battery: typecheck + all tests + build (matches the pre-push hook).
- `npm run verify:quick` — all tests, no typecheck/build (alias for `test:all`).
- `npm run build` — production build into `dist/`.
- `npm run openapi:types` — regenerate `src/lib/api-types.ts` from `openapi.yaml`.
- `cd server && npm run dev` — local analysis backend on `:8080`. Reads `server/.env`
  (Node 20.6+ native `process.loadEnvFile`, no dotenv dep).
  - `ANALYZER=manual` (default) — writes prompts to `server/handoff/inbox/`, waits
    for the user to drop JSON into `server/handoff/outbox/` (file-drop cowork flow).
  - `ANALYZER=gemini` + `GEMINI_API_KEY=…` — calls the free-tier Gemini API
    directly. Optional `GEMINI_MODEL` (default `gemini-2.5-flash`; flip to
    `gemini-3-flash` without code changes). See `server/.env.example`.

## Layout
- `src/main.tsx` — entry; mounts `<App/>` inside `<Provider>`.
- `src/App.tsx` — root component; selects off the discriminated-union `ui.stage`
  and renders the matching view + any active modals.
- `src/lib/` — `icons.tsx`, `time.ts`, `colors.ts`, `router.ts`, `api.ts`,
  `types.ts`, generated `api-types.ts`.
- `src/data/` — design fixtures (characters, chapters, voices, books, etc.).
- `src/store/` — RTK slices (`ui`, `cast`, `chapters`, `revisions`, `manuscript`)
  + `index.ts` (configureStore, typed `useAppDispatch`/`useAppSelector`, router
  install).
- `src/components/`, `src/modals/`, `src/views/` — UI.
- `src/mocks/canned-data.ts` + `src/mocks/manuscripts/` — mock API payloads.
- `openapi.yaml` (root) — **API contract**, source of truth for backend shapes.

## Conventions worth preserving
- **Discriminated-union `ui.stage`** (`src/store/ui-slice.ts`) — `{ kind: 'books'
  | 'upload' | 'analysing' | 'confirm' | 'ready' }`, with `view`/`currentChapterId`/
  `openProfileId` living *inside* the `ready` variant. Don't flatten.
- **Hash router grammar** (`src/lib/router.ts`) — pure `parseHash`/`stageToHash`,
  installed against the store via the `RouterStore` adapter so the router stays
  decoupled. Same URL grammar as the original prototype.
- **OpenAPI is the type source of truth** — `Character`/`Chapter`/`Sentence` etc.
  come from `src/lib/api-types.ts` (generated). Don't hand-write them.
- **Design tokens are CSS custom properties** — `src/styles.css` declares
  `--peach`, `--ink`, `--magenta`, etc.; `tailwind.config.ts` references those
  vars. No hex literals in component code.
- **Mocks behind `VITE_USE_MOCKS`** — `src/lib/api.ts` exports
  `api = USE_MOCKS ? mock : real`. Components only ever import from `api.*`;
  they never know which is which. `.env.development` sets the flag on.
- **RTK immer** — slice reducers mutate via Immer drafts. Don't rewrite to spreads.

## Testing discipline (REQUIRED for every change)

Every PR MUST improve automated coverage on top of updating its regression
plan. Regression plans under `docs/features/*.md` document invariants and
manual acceptance walkthroughs — they complement automated tests, they do
not replace them.

- New behaviour → ship paired automated test(s).
- Bug fix → ship a regression test that fails before the fix and passes after.
- Refactor → existing tests stay green; add coverage for any previously-uncovered seam you touched.
- Never delete or `.skip` a test without an explicit replacement or follow-up plan item.
- If a change lands in untested territory (e.g. the Python sidecar still has no pytest), the test scaffold itself is part of the work — do not ship code without it.

Harnesses:
- Frontend: `npm run test` (Vitest + jsdom + React Testing Library). Tests live next to the unit (`*.test.ts(x)`).
- Server: `cd server && npm run test` (Vitest + node env, real-ffmpeg integration where relevant). Same colocation.
- Sidecar (`server/tts-sidecar/`): pytest scaffold is the next coverage milestone; any new sidecar code MUST add it.
- Top-level `npm run test:all` runs both Vitest harnesses.

Canonical end-to-end manuscript for full-pipeline regression:
`C:\Users\dudar\Downloads\the Coalfall Commission.txt` (do not commit — copyrighted).
Cite this file from any regression plan that needs an e2e run rather than
inventing fresh fixtures. See `docs/features/28-chapter-audio-format.md` for
the canonical recipe.

## Out of scope until told otherwise
- New features. Surface area is final for v1.
- Visual redesign. Reproduce the existing look pixel-for-pixel.
- Backend work. This repo is the frontend that will call the OpenAPI spec.

## Suggested follow-ups (not requirements)
- Swap `src/lib/router.ts` for `react-router` v6 `createHashRouter` keeping the
  grammar identical.
- `redux-persist` on `ui` and `manuscript` slices.
- Real `<audio>` element in `MiniPlayer` once the backend returns URLs.
- Vitest + slice tests (`applyGenerationTick`, `applyVoiceMatches`).
- ESLint + Prettier, axe-core a11y pass.
- Align the `Sentence` shape with the OpenAPI spec (currently the fixtures use
  `{ id: string, charId, text }` while the spec uses `{ id: number, characterId,
  chapterId, text }`).

## Commit gate
Two-tier automated test gate, enforced by husky hooks in `.husky/`:
- **pre-commit** (`.husky/pre-commit`): runs `npm run verify:quick` —
  frontend + server tests. Refuses the commit if any Vitest spec is red.
- **pre-push** (`.husky/pre-push`): runs `npm run verify` — typecheck +
  all tests + build. Refuses the push if any step fails.

Hooks activate automatically after `npm install` via the `prepare` script
(husky v9 — sets `core.hooksPath` to `.husky/`). On a fresh clone, run
`npm install` once and you're done.

Working practice:
- Before committing anything non-trivial, run `npm run verify` — same battery
  as pre-push. Catching failures in the same turn beats catching them at
  push time.
- `npm run verify:quick` runs just the tests, matching pre-commit.
- **Do not use `--no-verify` to bypass.** If a hook fails, fix the underlying
  issue (or update the regression doc + paired test if behavior intentionally
  changed — see `docs/features/INDEX.md`).
- pytest scaffold for the Coqui sidecar (currently zero coverage; first test
  should be a `/synthesize` smoke that mocks the model load).
