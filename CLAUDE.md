# Project context for Claude Code

Frontend for an audiobook-generation tool. Vite + React 18 + TypeScript +
Redux Toolkit. Mocked API surface today; designed to swap to a real backend
without changing component code.

## Commands
- `npm run dev` — Vite dev server (HMR) on `http://localhost:5173`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run build` — production build into `dist/`.
- `npm run openapi:types` — regenerate `src/lib/api-types.ts` from `openapi.yaml`.

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
