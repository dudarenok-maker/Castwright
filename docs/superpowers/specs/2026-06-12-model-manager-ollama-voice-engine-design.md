# Model Manager: per-model Ollama Load/Unload + "Voice engine" terminology

- **Date:** 2026-06-12
- **Branch:** `feat/frontend-model-manager-ollama-controls`
- **Status:** design approved, pending spec review

Two independent, mechanical changes shipped together on one branch:

1. Give **every installed Ollama model** its own Load/Unload control in the
   Model Manager (today only the *default* analyzer model has one).
2. Finish the **"TTS" → "Voice engine"** rename in user-facing copy (the Admin
   health board was already renamed; the rest of the app — and the docs that
   name the UI label — still say "TTS").

---

## Part A — Per-model Load/Unload for every Ollama model

### Current behavior

- The inventory lists each pulled Ollama tag as a row (`kind: 'analyzer'`,
  `id: 'ollama:<name>'`) with live residency from `ollama ps`
  (`models-inventory.ts` → `buildModelInventory`).
- The Load/Unload pill renders only when `hasControl` is true, which for
  analyzer rows requires `isAnalyzerDefault` — i.e. **only the configured
  default model** gets a pill (`model-manager.tsx:301`).
- `POST /api/ollama/load` and `/api/ollama/unload` (`ollama-health.ts:226`,
  `:249`) always target `getResolvedOllamaModel()` — the configured default —
  and ignore any caller-supplied target.

### Target behavior

Each installed Ollama model gets an independent Load/Unload control. Loading
one model does **not** evict the others — Ollama manages VRAM itself, and each
row's residency mirrors live `ollama ps`. This matches how Ollama actually
works (`ollama ps` can show several resident models).

### Decisions

- **Independent per model** (not single-active radio). Confirmed with user.
- **No auto-evict** of the TTS sidecar when loading an Ollama model here. This
  is a manual pre-warm; it mirrors today's default-analyzer pill, which also
  doesn't evict TTS. Note that **analysis still runs the *configured* default
  model**, not whatever you warm — warming a non-default model is an advisory /
  residency-inspection action.

### Backend (`server/src/routes/ollama-health.ts`)

- `POST /api/ollama/load` and `/api/ollama/unload` accept an optional
  `{ model }` in the request body. When absent, fall back to
  `getResolvedOllamaModel()` so the existing default-model callers (the
  Analysing-screen pill, the TTS auto-evict flow) keep working unchanged.
- The load path keeps threading the analyzer's `num_ctx` / `num_gpu` for
  **whatever** model is named (the load-time cache-key caveat) so a warmed
  model isn't force-reloaded on the first real analysis call.

### Frontend (`src/views/model-manager.tsx`, `src/lib/api.ts`)

- `hasControl`: replace the `isAnalyzerDefault` clause with "any present
  analyzer row" — every Ollama model gets the pill, default or not. (All
  `kind: 'analyzer'` rows are Ollama; cloud Gemini isn't a disk artifact and
  isn't in the inventory.)
- `doLoad` / `doStop` parse the model name out of `item.id`
  (`ollama:<name>`) and pass it: `api.loadAnalyzer({ model })` /
  `api.unloadAnalyzer({ model })`. `realLoadAnalyzer` / `realUnloadAnalyzer`
  gain an optional `{ model }` arg and POST it as the body.
- **Bug fix surfaced by this change:** `controlState` currently maps
  `!sidecarReachable → 'unreachable'`. That's wrong for analyzer rows — the TTS
  sidecar being down must not grey out Ollama Load buttons. Scope the
  unreachable signal per-kind: analyzer rows ignore `sidecarReachable`. (An
  unreachable Ollama daemon already yields zero analyzer rows, so there is
  nothing to mis-label.)
- **Mock:** replace the single `MOCK_OLLAMA_MODEL_LOADED` boolean with a
  per-model resident `Set<string>` so the manager's Load/Stop round-trips
  visibly in mock mode and the mock inventory reflects per-model residency.

---

## Part B — "TTS" → "Voice engine" user-facing copy

Scope confirmed with user: **all user-facing TTS copy**, including docs that
name the UI label. **Out of scope:** code identifiers, type / field names,
OpenAPI `description:` text, and code comments — these stay as-is.

### In-app strings

- `ModelControlPill.tsx` — `kindNoun`: `'TTS model'` → `'Voice engine'`. The
  analyzer side stays `'Analyzer'`.
- Account default-engine dropdown label + helper text → "Voice engine".
- Per-character picker label **"TTS engine for this character"** → **"Voice
  engine for this character"**.
- Generation cross-engine warnings ("different TTS engine" → "different voice
  engine").
- `src/data/help-failures.ts` — recycle-storm title "TTS engine keeps
  restarting" → "Voice engine keeps restarting".

### Docs

- `README.md` — "TTS engines" heading / prose → "Voice engines".
- `INSTALL.md` — the "Account → Defaults for new books → TTS engine" references
  name the UI label that's changing → "Voice engine".

### Lockstep test / spec updates (matching new copy, not changing intent)

- `src/data/help-failures.test.ts` — the title pin for recycle-storm.
- `model-manager.test.tsx` — assert the new "Voice engine" pill copy.
- e2e specs querying the visible label `getByLabel('TTS engine for this
  character')`: `e2e/cast.spec.ts`, `e2e/voice-design-progress.spec.ts`,
  `e2e/single-voice-design-background.spec.ts`.

---

## Testing

- **Server** (`ollama-health.test.ts`): load/unload with an explicit
  `{ model }` targets that model and threads `num_ctx`/`num_gpu`; an absent
  body still targets the configured default.
- **Frontend** (`model-manager.test.tsx`): a non-default Ollama row renders a
  Load/Unload pill; the action calls `api.loadAnalyzer`/`unloadAnalyzer` with
  that row's model name; the pill is not greyed out when only the TTS sidecar
  is unreachable.
- **Copy:** `model-manager.test.tsx` / `help-failures.test.ts` assert the new
  "Voice engine" strings; e2e label queries updated.
- `npm run verify` before shipping (typecheck + all tests + e2e + build).

## Out of scope

- Auto-evicting other engines when loading an Ollama model.
- Renaming code identifiers, type/field names, OpenAPI descriptions, comments.
- Changing which model analysis actually runs (still the configured default).
