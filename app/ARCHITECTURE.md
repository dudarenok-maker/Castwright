# Audiobook Prototype — Architecture

Split out of the original 4,030-line single-file HTML on $(date). Loads in the browser via Babel-standalone for direct iteration; migrate to Vite + TS + Tailwind before production.

## Tree
```
app/
  index.html              # loader — script tags in dependency order
  styles.css              # keyframes + .dot-grid + drag cursors
  tailwind-config.js      # theme tokens (colors, gradients, shadows, radii)
  app.jsx                 # root <App/> — stage/view/route state
  lib/
    types.js              # JSDoc domain models (TS targets)
    colors.js             # CHAR_COLORS + shade()
    time.js               # parseDuration / formatTime / parseRuntime / formatHours
    icons.jsx             # all <Icon*> SVG primitives
  data/                   # mock fixtures — also serve as API contract
    voice-library.js characters.js sentences.js chapters.js
    listener-apps.js export-queue.js walkthroughs.js regen-reasons.js
    books.js change-log.js revisions.js drift.js match-factors.js
    analysis-phases.js log-types.js
  components/             # shared UI primitives
    primitives.jsx top-bar.jsx waveform.jsx mini-player.jsx voice-library-panel.jsx
  views/                  # one per top-level screen
    upload analysing confirm-cast manuscript cast voices generation
    listen preview-listener book-library change-log revision-diff
  modals/                 # drawers + overlays
    match-detail profile-drawer regenerate character-regenerate
    batch-character-regenerate drift-report app-handoff
```

## Loader order
Each `<script type="text/babel">` runs in its own scope. Modules expose components by assigning to `window` at the bottom (`Object.assign(window, { ... })`). The HTML loads them in dependency order: lib → data → components → modals → views → app.

## When migrating to Vite + TS
1. Drop the `Object.assign(window, ...)` footers; replace with `export {...}`.
2. Convert each .js fixture to .ts with the typed shapes from `lib/types.js`.
3. Move `tailwind-config.js` → `tailwind.config.ts`.
4. Move `styles.css` keyframes into the global stylesheet (or use Tailwind animate plugin).
5. Pin React to 18 with proper deps; remove Babel-standalone.
