# Handoff to Claude Code

The prototype currently runs as a static HTML file with in-browser Babel and
UMD-from-CDN React/Redux. To make it production-shaped, do the following in
order.

## 1. Install the build toolchain (blocker 3, 4)
Files already added: `package.json`, `vite.config.ts`, `tsconfig.json`.
```
cd app && npm install
npm run dev      # http://localhost:5173
```
Vite serves HMR; no more file:// loading (blocker 5).

## 2. Move source into `src/` and ESM-ify (blockers 1, 2)
Migrate this layout:
```
app/lib/*.js        → src/lib/*.ts
app/data/*.js       → src/data/*.ts
app/components/*    → src/components/*.tsx
app/views/*         → src/views/*.tsx
app/modals/*        → src/modals/*.tsx
app/store/*         → src/store/*.ts
app/app.jsx         → src/App.tsx
```

### File-conversion pattern
Each file currently ends with `Object.assign(window, { Foo, Bar })`. Convert
to ESM:

```js
// Before — app/components/mini-player.jsx
function MiniPlayer({ chapter, ... }) { ... }
Object.assign(window, { MiniPlayer });

// After — src/components/MiniPlayer.tsx
import { useState, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { IconPlay, IconPause /* ... */ } from '../lib/icons';
import { api } from '../lib/api';
import type { Chapter } from '../lib/api-types';

interface Props { chapter: Chapter | null; onClose: () => void; /* ... */ }
export function MiniPlayer({ chapter, onClose, ... }: Props) { ... }
```

Drop every `Object.assign(window, ...)`. Replace global lookups with
explicit imports. The Babel-scope hack goes away entirely.

## 3. Replace `index.html`
Vite uses a single root `index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="/src/styles.css" />
    <title>Audiobook generator</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
`src/main.tsx`:
```ts
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <Provider store={store}><App /></Provider>
);
```

## 4. Generate API types
```
npm run openapi:types
```
This produces `src/lib/api-types.ts` from `openapi.yaml`. Replace JSDoc
shapes in `lib/api.ts` with the generated types.

## 5. Keep mocks behind a flag
In `src/lib/api.ts`:
```ts
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';
export const api = USE_MOCKS ? mockApi : realApi;
```
Add `.env.development` with `VITE_USE_MOCKS=true`.

## Migration order (do not skip steps)
1. `lib/*` (no other deps) — icons, time, colors, router, api.
2. `data/*` — fixtures, depend only on `lib/icons` (log-types).
3. `store/*` — depends on data + RTK.
4. `components/*` — depends on lib + store.
5. `modals/*` and `views/*`.
6. `app.jsx` → `App.tsx`.

After each tier, run `npm run typecheck` before continuing.

## Importing into Claude Code

### What to include
Pull the whole project. Claude Code needs both the prototype source (as
reference) and the scaffolding (`package.json`, `vite.config.ts`,
`tsconfig.json`, `openapi.yaml`).

Files Claude Code should read first, in order:
1. `CLAUDE.md` (root) — high-level context and definition of done.
2. `HANDOFF.md` (this file) — migration steps.
3. `app/ARCHITECTURE.md` — module map.
4. `app/openapi.yaml` — API contract.

### What to ignore
`.gitignore` at the root already excludes:
- `node_modules/`, `dist/`, `.vite/`, `*.tsbuildinfo` — build artifacts.
- `.env*` (except `.env.example`) — secrets.
- `uploads/` — sandbox-only directory.
- `app/index.html` and `app/*.jsx` at the root level — these are the old
  static-Babel entry points; once migrated, they're dead weight. Keep
  `app/ARCHITECTURE.md` and `app/openapi.yaml` as reference (whitelisted).

### Getting the project to Claude Code
Pick one of:

**Option A — git (recommended).**
1. From this preview, download the project as a zip (project menu →
   download).
2. `unzip` locally, `cd` into the folder.
3. `git init && git add . && git commit -m "import prototype"`.
4. Push to GitHub.
5. In Claude Code: `claude` in the repo directory, or point Claude Code at
   the GitHub URL.

**Option B — direct folder.**
1. Download + unzip the project.
2. `cd` into the folder and run `claude` directly. Claude Code reads
   `CLAUDE.md` on startup.

### First prompt to Claude Code
> Read `CLAUDE.md` and `HANDOFF.md`. Execute the migration plan starting at
> step 1. After each tier in the migration order, run `npm run typecheck`
> and stop for confirmation before proceeding to the next tier.

This gives Claude Code a checkpoint per tier instead of one giant diff.

### Things to watch for during migration
- **Circular imports.** The current code uses `window.*` globals, which mask
  cycles. ESM will surface them. If TS complains about undefined imports at
  runtime, look for two files importing each other.
- **JSX in fixtures.** `data/log-types.js`, `data/characters.js`, and
  `data/walkthroughs.js` embed `<Icon* />` elements. Rename to `.tsx`.
- **Redux Toolkit immer.** Slice reducers mutate via Immer drafts. Keep that
  pattern — don't rewrite to spreads.
- **Hash router.** Replace `lib/router.js` with `react-router` v6 using
  `createHashRouter`. Mirror the URL grammar exactly:
  `#/`, `#/new`, `#/books/:id/analysing`, `#/books/:id/confirm`,
  `#/books/:id/:view?chapter=&profile=`.
- **Hex color literals.** A few may have crept back in. Grep for `#[0-9a-f]{6}`
  outside `styles.css` and replace with `var(--token)` references.

## Suggested follow-ups (not blockers)
- `redux-persist` on `ui` and `manuscript` slices.
- Replace `lib/router.js` with `react-router` v6 — same hash grammar.
- Real `<audio>` element in `MiniPlayer` once the backend returns URLs.
- Vitest + a handful of slice tests (`applyGenerationTick`,
  `applyVoiceMatches`).
- ESLint + Prettier, axe-core a11y pass.
