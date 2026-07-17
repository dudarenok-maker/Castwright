---
status: draft
---

# Per-model analyzer keep-alive (Model Manager)

> Revised after an adversarial assumption-checker pass — see **Revision notes**
> at the end for the holes it caught and how they changed the design.

## Problem

`ollama ps` perpetually shows `UNTIL = Stopping…` for the resident analyzer
model even while analysis is actively streaming and the model stays at
`17 GB / 100% GPU`. This is not a hang — it is the direct, expected consequence
of how Castwright drives Ollama.

On every `/api/chat` call the analyzer sends a `keep_alive` chosen by
`keepAliveFor(model, accelerator)` (`server/src/analyzer/ollama.ts:183`):

```ts
export function keepAliveFor(model, accelerator = 'unknown') {
  if (!RESIDENT_MODELS.has(model)) return 0;                    // evict immediately
  if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;
  return resolveAnalyzerKeepAlive();                            // '5m'
}
```

`RESIDENT_MODELS` (`ollama.ts:151`) is a **hardcoded exact-match allowlist**:
`qwen3.5:4b`, `qwen3.5:9b`, `llama3.1:8b`, `gemma4-e4b-8gb`, **and**
`gemma4-e4b-8gb:latest` (both forms are listed deliberately — see the header
comment at `ollama.ts:146-149` — so the exact-match lookup hits however the
picker/env passes the tag). Any tag not in the set — including a user's custom
build such as `qwen36-castwright:latest` — falls to `return 0`, i.e.
`keep_alive: 0` ("unload the instant this request finishes"). Ollama renders that
scheduled eviction as `Stopping…`. Because analysis fires back-to-back
chapter/section requests, each new request re-touches the model before eviction
lands, so it stays resident but is *perpetually* scheduled to stop. The real cost
is at gaps (chapter boundaries, the stage-1 → stage-2 handoff): the model can
actually evict there and the next call pays a full ~17 GB cold reload.

The allowlist is a hardcoded per-box heuristic; the header comment
(`ollama.ts:145-150`) already flags "model-agnostic measured residency is the
deferred **#845** work." Custom/renamed models have no way to opt into a
resident window.

## Goal

Let the user set a keep-alive value **per model**, in **seconds**, from the
**Model Manager** (where models are pulled and listed) — and retire the
hardcoded allowlist, superseding it with configured values + shipped defaults
for the models we support.

Non-goals: a live per-*resident*-model dashboard control; touching the
cross-engine GPU eviction chokepoint (`gpu.safeCoexistMb`), which is orthogonal;
model-agnostic *measured* residency (#845 stays deferred).

## Design

### Data model — defaults in code, overrides in settings

- **`DEFAULT_KEEP_ALIVE_SECONDS`** — new constant in `analyzer/ollama.ts`,
  seeded with today's supported analyzer models at their current effective
  value (`'5m'` → `300`), keyed on the **normalized** (bare, no `:latest`) tag:

  ```ts
  const DEFAULT_KEEP_ALIVE_SECONDS: Record<string, number> = {
    'qwen3.5:4b': 300,
    'qwen3.5:9b': 300,
    'llama3.1:8b': 300,
    'gemma4-e4b-8gb': 300,
    // + the local persona model tag (see “Second consumer” below) so
    //   voice-design keep-alive stays at today’s 300s.
  };
  ```

- **`normalizeModelTag(tag)`** — new helper: strips a trailing `:latest` only
  (`gemma4-e4b-8gb:latest` → `gemma4-e4b-8gb`; `qwen3.5:9b` is left untouched —
  `9b` is a real tag, not `latest`). All default/override lookups and all UI
  writes go through it, so the `:latest` duplication the old allowlist needed is
  replaced by one normalization step, and a user setting `qwen36-castwright`
  also covers `qwen36-castwright:latest`.

- **`analyzerKeepAliveByModel: Record<string, number>`** — new optional field on
  `userSettingsSchema` (`server/src/workspace/user-settings.ts:109`). **Sparse**:
  stores only user overrides (normalized tag → seconds), never a full mirror of
  the defaults. Added to `DEFAULT_USER_SETTINGS` as `{}` so the synchronous
  cached read (below) never sees `undefined`. Chosen over per-key entries in the
  flat `configOverrides` map because model tags contain dots/colons
  (`qwen3.5:9b`) that collide with the dotted ConfigKnob-key convention and don't
  round-trip through `configValue`. A typed map keys on the tag verbatim and
  matches the existing typed-analyzer-field precedent (`analyzerPhase0Model`
  etc., `user-settings.ts:192-194`).

- **`resolveKeepAliveSeconds(model)`** — new resolver, replacing
  `resolveAnalyzerKeepAlive()`:
  `override[norm] ?? DEFAULT_KEEP_ALIVE_SECONDS[norm] ?? 0` where
  `norm = normalizeModelTag(model)`. Reads the override map **synchronously**
  from the module-level settings cache (`getCachedUserSettings()`,
  `user-settings.ts:364`) — treating a missing/empty map as `{}`. An
  unconfigured custom tag therefore defaults to `0` (today's behavior for
  non-allowlisted models) until the user sets it in the Model Manager.

### Seconds semantics

Integer seconds map straight onto Ollama's native `keep_alive`:
- `0` → unload immediately after the call (default for unconfigured tags).
- positive → seconds the model stays resident.
- `-1` → pin forever.

The UI documents these three cases inline.

### Server — delete the allowlist, rewrite the lookup

In `analyzer/ollama.ts`:

- **Remove `RESIDENT_MODELS`** and **`resolveAnalyzerKeepAlive()`**; add
  `DEFAULT_KEEP_ALIVE_SECONDS`, `normalizeModelTag()`, `resolveKeepAliveSeconds()`.
- **`keepAliveFor(model, accelerator)`** becomes:

  ```ts
  export function keepAliveFor(model, accelerator = 'unknown') {
    if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;  // safety rail kept
    return resolveKeepAliveSeconds(model);
  }
  ```

  Returns an **integer (seconds)** now, not the string `'5m'`. Ollama accepts an
  integer `keep_alive` natively. `RAM_HEAVY_MODELS`-on-CPU still clamps to `0`
  (leaving `qwen3.5:9b` resident on a CPU-only box would pin ~6.4 GB of system
  RAM) — this safety rail is orthogonal to the convenience allowlist and is
  deliberately retained; a per-model setting cannot re-introduce that footgun on
  CPU.

- **Second consumer (persona/voice-design).** `resolveAnalyzerKeepAlive()` is
  **also** called by `server/src/tts/persona-gpu-plan.ts:74`
  (`resolvePersonaGpuPlan` → `{ …, keepAlive: resolveAnalyzerKeepAlive() }`) for
  the constrained-but-idle local-persona GPU plan; it is mocked in
  `prepare-persona-batch.test.ts`. Deleting the reader would break typecheck;
  keeping the knob-read after retiring the knob would throw at runtime
  (`configValue` throws on unknown keys, `resolver.ts:65-68`). Fix:
  `persona-gpu-plan.ts` switches to `resolveKeepAliveSeconds(<persona model tag>)`.
  The persona model tag is resolved from the persona-engine layer
  (`resolvePersonaEngine`/`voice-style.ts`); the plan step identifies the exact
  accessor and **seeds that tag into `DEFAULT_KEEP_ALIVE_SECONDS` at 300** so
  voice-design keep-alive is byte-for-byte today's `'5m'`. Update
  `prepare-persona-batch.test.ts` mocks accordingly.

- **Retire the `analyzer.ollama.keepAlive` registry knob** (`registry.ts:1088`,
  string default `'5m'`) — nothing reads its value after the two consumers above
  move to the map. This is a config-registry change with mechanical fallout
  (see next subsection), not a code-only edit.

### Config-registry changes (do NOT skip — gates on these)

- `server/src/config/registry.ts`: remove the `analyzer.ollama.keepAlive` knob.
- **Run `npm run config:sync`** to regenerate `.env.example` (drops the generated
  `ANALYZER_KEEP_ALIVE` block at `.env.example:516`). `config:check`
  (`sync-env-example.ts --check`) runs in `verify:fast:branch` (pre-push) and
  cloud verify — a stale `.env.example` fails the push.
- `server/src/config/registry.test.ts:71-77` asserts the knob exists with a
  `'5m'` default — update/remove that case.
- `src/lib/api.ts:8956`: remove the knob from the mock config-registry mirror.

### Client type surface (PUT body must carry the new field)

The per-model map is written through the account-settings PUT, whose body type is
declared beyond the server zod schema:

- `openapi.yaml` — add `analyzerKeepAliveByModel` to `UserSettings` /
  `UserSettingsPatch` (`openapi.yaml:3277` region); regenerate/adjust the
  re-exported client types (`src/lib/types`).
- `src/lib/api.ts` — the mock `putUserSettings` must accept + echo the field so
  mock-mode round-trips.

### Persistence merge — send the COMPLETE map (landmine)

`writeUserSettings` shallow-merges (`{ ...current, ...validated }`,
`user-settings.ts:378`), so a PUT carrying `analyzerKeepAliveByModel: { tagX: 300 }`
**replaces the entire map**, dropping every other model's override — the same
class of bug as `reference_server_castjson_mutation_clobbered_by_client_full_cast_persist`.
Therefore an edit must merge into the **current** map client-side and PUT the
**full** map. This requires the Model Manager to actually hold the current map
(see UI).

### UI — per-model control in the Model Manager

In `src/views/model-manager.tsx`, the analyzer `ModelRow` (~line 458) already has
the tag in hand (`analyzerModel = item.id.slice('ollama:'.length)`, line 507).
The view today loads **inventory only** — it has no account-settings fetch or
selector. So:

- Wire `fetchAccountSettings` + an account-slice selector into the view so each
  row can read the current `analyzerKeepAliveByModel` map.
- Each analyzer (Ollama) row gets a small **keep-alive number field (seconds)**
  next to its Load/Unload `ModelControlPill`, showing the **configured** value
  (`override[norm] ?? DEFAULT_KEEP_ALIVE_SECONDS[norm]`; custom tags show `0`).
- Editing merges `{ [norm]: seconds }` into the current map and dispatches
  `saveAccountSettings({ analyzerKeepAliveByModel: <full merged map> })`
  (`account-slice.ts:53` → `PUT /api/user/settings`). A **reset** affordance
  deletes the tag's entry (falls back to the coded default).
- Inline helper copy: `0` = unload immediately, `-1` = keep forever, **and** a
  note that RAM-heavy models (`qwen3.5:9b`) unload on a CPU-only box regardless
  of this value — so the displayed number is the GPU-resident intent, which the
  CPU safety rail may override (reconciles acceptance #1 vs #5 below).

## Testing

- **Server unit (`ollama.test.ts` `keepAliveFor` region)**: this block currently
  asserts the string `'5m'` and the `:latest` allowlist case (`ollama.test.ts:200-223`).
  Rewrite → (a) supported model, no override → coded default `300` (integer);
  (b) `:latest` form resolves via normalization to the same default;
  (c) override wins over default; (d) unconfigured custom tag → `0`; (e) `-1`
  passes through; (f) `RAM_HEAVY_MODELS` on `cpu` clamps to `0` even with a
  positive override; (g) on `cuda`/`unknown` the override is honored. **Keep the
  wire-level assertion** that the resolved value actually reaches the `/api/chat`
  request body (`body.keep_alive`) — the highest-value regression guard; update
  it from `'5m'` to the integer.
- **User-settings schema test**: `analyzerKeepAliveByModel` accepts a sparse
  integer map, rejects non-integers, round-trips read/write; cold-cache read
  (via `_setUserSettingsCacheForTest`) treats a missing map as `{}`.
- **`registry.test.ts`**: knob-removal case updated.
- **`prepare-persona-batch.test.ts`**: persona plan resolves via the new resolver.
- **Frontend (`model-manager` test)**: the analyzer row renders the configured
  value from account state; an edit dispatches `saveAccountSettings` with the
  **full merged** map (assert other tags survive); reset clears the tag's entry.
- **Regression plan** under `docs/features/`, paired entries in
  `docs/release-notes-next.md` + `RELEASE_NOTES.md`, and a **docs sweep** of
  `docs/local-llm.md` (its `74-75, 280, 298` "add the tag to `RESIDENT_MODELS`"
  instructions become false).

## Scope (files touched)

- **Server:** `analyzer/ollama.ts` (+ `ollama.test.ts`),
  `workspace/user-settings.ts`, `config/registry.ts` (+ `registry.test.ts`),
  `tts/persona-gpu-plan.ts` (+ `prepare-persona-batch.test.ts`), `openapi.yaml`,
  `.env.example` (via `config:sync`).
- **Frontend:** `views/model-manager.tsx` (+ its test), `store/account-slice.ts`,
  `lib/api.ts` (mock `putUserSettings` + mock-registry mirror removal),
  `lib/types`.
- **Docs:** new regression plan, `docs/local-llm.md` sweep, two release-notes
  files.

## Acceptance

1. In the Model Manager, each analyzer (Ollama) row shows an editable keep-alive
   (seconds) with the correct **configured** value; the supported models show
   `300` by default, custom tags show `0`.
2. Setting `qwen36-castwright:latest` to `300` and running analysis keeps the
   model resident across chapter boundaries (`ollama ps` shows a real countdown,
   not immediate `Stopping…`, between requests).
3. Setting a model to `0` reproduces the immediate-unload behavior; `-1` pins it.
4. No live **code** symbol `RESIDENT_MODELS` or `resolveAnalyzerKeepAlive`
   remains in `server/` or `src/`; `.env.example` no longer generates
   `ANALYZER_KEEP_ALIVE`; `docs/local-llm.md` no longer instructs editing the
   allowlist. (Historical mentions in archived `docs/features/*` plans are left
   as-is.)
5. On a CPU-only box, `qwen3.5:9b` still unloads immediately (actual sent
   `keep_alive: 0`) regardless of its configured value; the UI notes this.
6. Editing one model's keep-alive leaves every other model's override intact
   (full-map merge, no clobber).
7. Voice-design (persona) keep-alive behavior is unchanged: the constrained-idle
   local-persona plan still resolves to `300`.

## Revision notes (adversarial pass)

The assumption-checker caught, and this spec now addresses:
1. **Second consumer** — `persona-gpu-plan.ts:74` also reads
   `resolveAnalyzerKeepAlive()`; the original "allowlist-only" claim was false.
   Now migrated to `resolveKeepAliveSeconds(personaModel)` with a seeded 300
   default.
2. **Five allowlist entries, not four** — `gemma4-e4b-8gb:latest` was omitted;
   added a `normalizeModelTag` step instead of re-listing both forms.
3. **Knob removal ≠ code-only** — added the mandatory `config:sync` /
   `.env.example` / `registry.test.ts` steps (pre-push + cloud gate on
   `config:check`).
4. **Clobbering merge** — `writeUserSettings` is shallow; edits must PUT the full
   map, and the Model Manager must first load account settings (it doesn't
   today).
5. **Cold-cache sync read** — `analyzerKeepAliveByModel` seeded as `{}` in
   `DEFAULT_USER_SETTINGS`; resolver treats missing as empty.
6. **UI honesty on CPU** — the 9B-on-CPU clamp means the displayed value is
   intent, not always the sent value; helper copy + acceptance #5 reconcile it.
7. **Wider type surface** — `openapi.yaml` + client `UserSettings`/`Patch` +
   mock `putUserSettings`; and the return type changes `string → number`, so the
   wire-level test is explicitly retained.
8. **"grep clean" reworded** — scoped to live code symbols + a docs sweep, since
   comments/archived plans legitimately still mention the old names.
