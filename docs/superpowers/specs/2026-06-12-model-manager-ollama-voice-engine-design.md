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
one analyzer model does **not** evict another analyzer model — Ollama manages
VRAM itself, and each row's residency mirrors live `ollama ps`. This matches how
Ollama actually works (`ollama ps` can show several resident models).

### Decisions

- **Independent per model** (not single-active radio). Confirmed with user.
- **Analysis still runs the *configured* default model**, not whatever you warm
  — warming a non-default model is an advisory / residency-inspection action.
- **A1 — TTS load evicts ALL resident analyzer models** (confirmed with user).
  Adversarial-review finding: today the Generate-screen "Load TTS" flow
  auto-evicts the analyzer via `api.unloadAnalyzer()` with no model, which
  resolves to the *configured default* only. Once a user can warm a *non-default*
  Ollama model from the new controls, that model would stay resident alongside
  the TTS engine → co-residency OOM on an 8 GB GPU. Fix: a no-model
  `POST /api/ollama/unload` evicts **every** currently-resident Ollama model
  (probe `ollama ps`, send `keep_alive: 0` per resident tag), so the existing
  TTS auto-evict path frees all analyzer VRAM. An explicit `{ model }` still
  targets just that one (the per-row Unload button).

### Backend (`server/src/routes/ollama-health.ts`)

- `POST /api/ollama/load` accepts an optional `{ model }` in the body; when
  absent, falls back to `getResolvedOllamaModel()` (the Analysing-screen pill
  keeps working unchanged). It keeps threading the analyzer's `num_ctx` /
  `num_gpu` for **whatever** model is named (the load-time cache-key caveat) so
  a warmed model isn't force-reloaded on the first real analysis call.
- `POST /api/ollama/unload`:
  - with an explicit `{ model }` → evict just that model (`keep_alive: 0`).
  - with **no** model → per A1, probe `ollama ps` and evict **every** resident
    model. (`express.json` is mounted globally at `index.ts:120`, confirmed —
    the route can read the body.)

### Frontend (`src/views/model-manager.tsx`, `src/lib/api.ts`)

- `hasControl`: replace the `isAnalyzerDefault` clause with "any present
  analyzer row" — every Ollama model gets the pill, default or not. (All
  `kind: 'analyzer'` rows are Ollama; cloud Gemini isn't a disk artifact and
  isn't in the inventory.)
- `doLoad` / `doStop` derive the model name with
  **`item.id.slice('ollama:'.length)`** — A3: tags contain colons
  (`ollama:qwen3.5:4b`), so a `split(':')` would mis-target; mirror
  `performRemoval`. Pass it: `api.loadAnalyzer({ model })` /
  `api.unloadAnalyzer({ model })`. `realLoadAnalyzer` / `realUnloadAnalyzer`
  gain an optional `{ model }` arg and POST it as the body.
- **Bug fix surfaced by this change:** `controlState` currently maps
  `!sidecarReachable → 'unreachable'`. That's wrong for analyzer rows — the
  voice engine being down must not grey out Ollama Load buttons. Scope the
  unreachable signal per-kind: analyzer rows ignore `sidecarReachable`. (An
  unreachable Ollama daemon already yields zero analyzer rows, so there is
  nothing to mis-label.)
- **A4 (minor a11y):** thread `engineLabel` into the pill's *button*
  aria-label so N analyzer Load buttons don't all read the identical
  "Load model (analyzer)".
- **A2 — Mock must demonstrate the feature:** the mock app exposes exactly one
  Ollama model (`qwen3.5:4b`, the default), so there is currently **no
  non-default row** to show the new pill on. Add a second, non-default mock
  Ollama model, and replace the single `MOCK_OLLAMA_MODEL_LOADED` boolean with
  a per-model resident `Set<string>` so the manager's Load/Stop round-trips
  visibly in mock mode (and an e2e spec can exercise a non-default row).

---

## Part B — "TTS" → "Voice engine" user-facing copy

Scope confirmed with user: **all user-facing TTS copy** — in-app strings, docs,
**and the user-visible TEXT of server/sidecar-thrown error messages** (decision
B). **Out of scope:** code identifiers, type / field names, OpenAPI
`description:` text, and code comments — these stay as-is.

> **Adversarial-review note:** the initial spec listed ~5 strings; the real
> surface is much larger and the replacement is **not one-to-one**. A blind
> find-replace produces garbage ("voice engine model key"). The plan's first
> task is a comprehensive grep across `src/`, `server/`, `server/tts-sidecar/`,
> and the docs to build the exact per-string replacement map below before
> touching anything.

### Replacement mapping (apply per-string, by sense)

| Source phrase | Replacement |
|---|---|
| "TTS sidecar" | "voice engine" |
| "TTS engine" / "TTS engines" | "voice engine" / "voice engines" |
| "TTS model" | "voice engine" (or "voice" where it means the voice) |
| "TTS voice" | "voice" |
| "Loading TTS…" / "Loading TTS model…" | "Loading voice engine…" |

### Known in-app strings (non-exhaustive — confirm via the grep task)

- `ModelControlPill.tsx` — `kindNoun` `'TTS model'` → `'Voice engine'`
  (analyzer side stays `'Analyzer'`).
- `profile-drawer.tsx` — the **"TTS engine for this character"** select label
  (source lives here, *not* cast.tsx), "Loading TTS model (~30s)…", "the TTS
  voice line above".
- `generation.tsx` — "Recovering — restarting TTS engine…", "current TTS
  model", "The TTS engine may be synthesising…".
- `queue-modal.tsx` — 'Mixes TTS engines. Turn on "Keep both TTS engines
  loaded"…'.
- `voices.tsx` — "Loading TTS…" ×2, "switch your TTS model".
- `data/help-topics.ts` — "TTS sidecar" ×3.
- `data/help-failures.ts` — recycle-storm title "TTS engine keeps restarting"
  → "Voice engine keeps restarting".
- `model-settings-form.tsx` — already mostly "voice engine"; verify the
  engine-picker sub-label (it is **not** literally "TTS engine" — earlier
  guess was wrong).

### Server / sidecar error text (decision B)

- Grep `server/src/` and `server/tts-sidecar/` for user-visible "TTS" in
  thrown error messages / status strings (e.g. "TTS sidecar process is not
  running. Launch the app via start-app.ps1.", analyzer/chapter `errorReason`
  text like "TTS sidecar timed out"). Rename the visible text only; identifiers
  and types stay.

### Docs

- `README.md` — "TTS engines" heading / prose → "Voice engines".
- `INSTALL.md` — "Account → Defaults for new books → TTS engine" references →
  the new UI label.

### Lockstep test / fixture updates (matching new copy, not changing intent)

- `help-failures.test.ts` (title pin), `model-manager.test.tsx` (describe name
  + pill copy), `generation.test.tsx:416` (the "restarting TTS engine…"
  assertion), `profile-drawer.test.tsx` (the `getByLabelText` query + the
  sidecar-error assertions), `chapters-slice.test.ts:523` (errorReason
  fixture), and any sidecar pytest asserting renamed message text.
- e2e specs querying the visible label `getByLabel('TTS engine for this
  character')`: `e2e/cast.spec.ts`, `e2e/voice-design-progress.spec.ts`,
  `e2e/single-voice-design-background.spec.ts`.

---

## Testing

- **Server** (`ollama-health.test.ts`):
  - `load` with explicit `{ model }` targets that model and threads
    `num_ctx`/`num_gpu`; absent body → configured default.
  - `unload` with explicit `{ model }` evicts just that model; **no body →
    evicts every model from `ollama ps`** (A1). Update the existing
    single-model unload test to the enumerate-all behavior.
- **Frontend** (`model-manager.test.tsx`): a non-default Ollama row renders a
  Load/Unload pill; the action calls `api.loadAnalyzer`/`unloadAnalyzer` with
  that row's model name (sliced, not split); the pill is **not** greyed out
  when only the voice engine (sidecar) is unreachable.
- **e2e** (A2): with the second non-default mock Ollama model, one spec drives
  Load/Unload on the non-default row in mock mode.
- **Copy:** `model-manager.test.tsx` / `help-failures.test.ts` /
  `generation.test.tsx` assert the new "voice engine" strings; e2e label
  queries updated.
- `npm run verify` before shipping (typecheck + all tests + e2e + build).

## Out of scope

- Single-active (radio) Ollama loading — rejected for "independent per model".
- Renaming code identifiers, type/field names, OpenAPI descriptions, comments.
- Changing which model analysis actually runs (still the configured default).
