---
status: draft
---

# Per-model analyzer keep-alive (Model Manager)

> Revised twice after adversarial assumption-checker passes — see **Revision
> notes** at the end for what each pass caught and how it changed the design.

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
`gemma4-e4b-8gb:latest` (both forms are listed deliberately — header comment
`ollama.ts:146-149` — so the exact-match lookup hits however the picker/env
passes the tag). Any tag not in the set — including a user's custom build such as
`qwen36-castwright:latest` — falls to `return 0`, i.e. `keep_alive: 0` ("unload
the instant this request finishes"). Ollama renders that scheduled eviction as
`Stopping…`. Because analysis fires back-to-back chapter/section requests, each
new request re-touches the model before eviction lands, so it stays resident but
is *perpetually* scheduled to stop. The real cost is at gaps (chapter boundaries,
the stage-1 → stage-2 handoff): the model can actually evict there and the next
call pays a full ~17 GB cold reload.

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
model-agnostic *measured* residency (#845 stays deferred); making the persona
(voice-design) keep-alive itself per-model (it stays a fixed constant — see
below).

## Design

### Data model — defaults in code, overrides in settings

- **`DEFAULT_KEEP_ALIVE_SECONDS`** — new constant in `analyzer/ollama.ts`,
  seeded with today's supported analyzer models at their current effective value
  (`'5m'` → `300`), keyed on the **normalized** (bare, no `:latest`) tag:

  ```ts
  const DEFAULT_KEEP_ALIVE_SECONDS: Record<string, number> = {
    'qwen3.5:4b': 300,
    'qwen3.5:9b': 300,
    'llama3.1:8b': 300,
    'gemma4-e4b-8gb': 300,
  };
  ```

- **`normalizeModelTag(tag)`** — new helper: strips a trailing `:latest` only
  (`gemma4-e4b-8gb:latest` → `gemma4-e4b-8gb`; `qwen3.5:9b` untouched — `9b` is a
  real tag, not `latest`; Ollama itself treats bare `== :latest`, so collapsing
  is correct). All default/override lookups go through it, replacing the `:latest`
  duplication the allowlist needed; a user setting `qwen36-castwright` also covers
  `qwen36-castwright:latest`.

- **`analyzerKeepAliveByModel: Record<string, number>`** — new optional field on
  `userSettingsSchema` (`user-settings.ts:109`), `.default({})`. **Sparse**:
  stores only user overrides (normalized tag → seconds). Also added to
  `DEFAULT_USER_SETTINGS` as `{}` so the synchronous cached read never sees
  `undefined`. Chosen over per-key entries in the flat `configOverrides` map
  because model tags contain dots/colons that collide with the dotted
  ConfigKnob-key convention and don't round-trip through `configValue`; a typed
  map keys on the tag verbatim (precedent: `analyzerPhase0Model` etc.,
  `user-settings.ts:192-194`).

- **`resolveKeepAliveSeconds(model)`** — new resolver replacing
  `resolveAnalyzerKeepAlive()`:
  `override[norm] ?? DEFAULT_KEEP_ALIVE_SECONDS[norm] ?? 0`, `norm =
  normalizeModelTag(model)`. Reads the override map **synchronously** from
  `getCachedUserSettings()` (`user-settings.ts:364`), treating a missing/empty
  map as `{}`. An unconfigured custom tag therefore defaults to `0` (today's
  behavior for non-allowlisted models) until set in the Model Manager.

### Seconds semantics

Integer seconds map straight onto Ollama's native `keep_alive`: `0` → unload
immediately (default for unconfigured tags); positive → seconds resident; `-1` →
pin forever. The UI documents all three.

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

  Returns an **integer (seconds)** now, not the string `'5m'` (Ollama accepts an
  integer `keep_alive` natively). `RAM_HEAVY_MODELS`-on-CPU still clamps to `0`
  (leaving `qwen3.5:9b` resident on a CPU-only box would pin ~6.4 GB system RAM) —
  a safety rail orthogonal to the allowlist, deliberately retained.

### Persona / voice-design keep-alive — fixed constant, NOT per-model

`resolveAnalyzerKeepAlive()` is **also** read by
`server/src/tts/persona-gpu-plan.ts:74` (`resolvePersonaGpuPlan` →
`{ …, keepAlive: resolveAnalyzerKeepAlive() }`) for the constrained-but-idle
local-persona GPU plan, and mocked in `prepare-persona-batch.test.ts:51`. Today
that value is **`'5m'` unconditionally — model-independent**. Routing it through
the new per-model resolver would make persona keep-alive depend on
`resolvePersonaLocalModel()` (`voice-style.ts:67`), which falls back to
`getResolvedOllamaModel()` — so a user on a **custom analyzer model** (the exact
motivating case) with no override would get persona `keep_alive: 0` and
reload-thrash between back-to-back cast-review designs. That is a behavior
regression.

**Decision:** decouple persona from the per-model map. Introduce a fixed
`PERSONA_KEEP_ALIVE_SECONDS = 300` constant; `persona-gpu-plan.ts` uses it
directly (integer `300` in place of `resolveAnalyzerKeepAlive()`). Voice-design
keep-alive is then byte-for-byte today's behavior for every configuration.
Update `prepare-persona-batch.test.ts` to expect `300`. (`PersonaGpuPlan.keepAlive`
is already typed `string | number`, so the integer is fine.)

### Retire the `analyzer.ollama.keepAlive` registry knob

Nothing reads its value once the two consumers above move off it. Removal is a
config-registry change with mechanical fallout that gates the branch:

- `config/registry.ts`: remove the `analyzer.ollama.keepAlive` knob
  (`registry.ts:1088`).
- **Run `npm run config:sync`** to regenerate `.env.example` (drops the generated
  `ANALYZER_KEEP_ALIVE` block, `.env.example:516`). `config:check`
  (`sync-env-example.ts --check`) runs in `verify:fast:branch` (pre-push) + cloud
  verify — a stale `.env.example` fails the push.
- `config/registry.test.ts:71-77` asserts the knob with a `'5m'` default —
  update/remove that case. (No broader registry golden exists; the group-count /
  uniqueness assertions are unaffected by a removal.)
- `src/lib/api.ts:8956`: remove the knob from the mock config-registry mirror.

### Expose the resolved value to the client (no frontend mirror)

The Model Manager must show each model's keep-alive, but `DEFAULT_KEEP_ALIVE_SECONDS`
and `normalizeModelTag` are **server-only** — the frontend cannot import them, and
hand-mirroring them into `src/` would re-introduce exactly the server→client drift
this feature deletes. Instead, the **server resolves and exposes** the value on
the data the Model Manager already fetches:

- `server/src/routes/models-inventory.ts`: for each analyzer (`ollama:`) item, add
  - `keepAliveSeconds: number` — the resolved configured value
    (`override[norm] ?? default[norm] ?? 0`), pre-CPU-clamp (display = intent), and
  - `keepAliveIsOverride: boolean` — whether a user override exists (drives the
    reset affordance).
- Mirror the two new fields in the `ModelInventoryItem` type in `src/lib/api.ts`
  and the mock inventory builder.

The client reads `item.keepAliveSeconds` / `item.keepAliveIsOverride` directly —
no defaults constant or normalize helper on the frontend.

### Client type surface (PUT body must carry the new field)

- `openapi.yaml`: add `analyzerKeepAliveByModel` to `UserSettings` (3031) /
  `UserSettingsPatch` (3277); **regenerate `src/lib/api-types.ts` via
  `npm run openapi:types`** (`src/lib/types.ts:108` derives `UserSettings` from
  the generated schema). NOTE: there is **no** `openapi:types --check` CI gate, so
  this regen is manual and won't be caught if skipped — call it out in the plan.
- `src/lib/api.ts`: **`mockPutUserSettings` (`api.ts:6644`) is a hard whitelist**
  that destructures a fixed field list — it silently drops unknown fields. Add
  `analyzerKeepAliveByModel` there, or the "other tags survive" test fails in
  mock mode.

### Persistence merge — send the COMPLETE map (landmine)

`writeUserSettings` shallow-merges (`{ ...current, ...validated }`,
`user-settings.ts:378`), so a PUT carrying a partial
`analyzerKeepAliveByModel` **replaces the entire map**, dropping every other
model's override (class: `reference_server_castjson_mutation_clobbered_by_client_full_cast_persist`).
Edits must merge into the **current** map client-side and PUT the **full** map.

### UI — per-model control in the Model Manager

In `src/views/model-manager.tsx`, the analyzer `ModelRow` (~line 458) already has
the tag (`analyzerModel = item.id.slice('ollama:'.length)`, line 507) and now the
resolved value on `item`. The view loads **inventory only** today, so:

- To PUT the full merged map it still needs the *current* map: wire
  `fetchAccountSettings` + an account-slice selector into the view (read side for
  the merge; display comes from `item.keepAliveSeconds`).
- Each analyzer row gets a small **keep-alive number field (seconds)** next to its
  Load/Unload `ModelControlPill`, showing `item.keepAliveSeconds`.
- Editing merges `{ [normalize(tag)]: seconds }` into the current map and
  dispatches `saveAccountSettings({ analyzerKeepAliveByModel: <full merged map> })`
  (`account-slice.ts:53` → `PUT /api/user/settings`). **Reset** (shown when
  `item.keepAliveIsOverride`) deletes the tag's entry (falls back to default).
- Helper copy: `0` = unload immediately, `-1` = keep forever; a note that
  RAM-heavy models (`qwen3.5:9b`) unload on a CPU-only box regardless of this
  value (displayed number is GPU-resident intent — reconciles acceptance #1 vs #5).

### Manual Load button honors the setting

`POST /api/ollama/load` (`ollama-health.ts:409`, `warmOllamaModel`) currently
warms with a hardcoded `keep_alive: '5m'`. Since the Load pill sits in the **same
row** as the new field, a mismatch is the same honesty problem as the CPU clamp.
Change the warm route to warm with `resolveKeepAliveSeconds(model)` so Load holds
for the configured window. A model configured `0` warms then does not persist —
consistent with its setting; the row's field makes that visible.

## Testing

- **`ollama.test.ts`**: rewrite the `keepAliveFor` block (`200-223`) — (a)
  supported model, no override → `300` (integer); (b) `:latest` normalizes to the
  same default; (c) override wins; (d) unconfigured custom tag → `0`; (e) `-1`
  passes through; (f) `RAM_HEAVY` on `cpu` → `0` even with a positive override;
  (g) `cuda`/`unknown` honors the override. **Both** wire-level assertions that
  `body.keep_alive` reaches `/api/chat` must move `'5m'` → `300`: the one at
  `~226` **and the second in the happy-path streaming describe at `ollama.test.ts:161`**
  (model `qwen3.5:9b`, stale `RESIDENT_MODELS` comment at 154-160) — the earlier
  dynamic-models plan already flagged this out-of-block assertion.
- **User-settings schema test**: `analyzerKeepAliveByModel` accepts a sparse
  integer map, rejects non-integers, round-trips; cold-cache read (via
  `_setUserSettingsCacheForTest`) treats a missing map as `{}`.
- **`registry.test.ts`**: knob-removal case updated.
- **`prepare-persona-batch.test.ts`**: persona plan resolves to `300` via the
  fixed constant (not the per-model resolver).
- **`models-inventory` test**: analyzer items carry `keepAliveSeconds`
  (override/default/0) and `keepAliveIsOverride`.
- **Frontend (`model-manager` test)**: row renders `item.keepAliveSeconds`; an
  edit dispatches `saveAccountSettings` with the **full merged** map (assert other
  tags survive); reset (when `keepAliveIsOverride`) clears the tag's entry.
- **Regression plan** under `docs/features/`, paired `docs/release-notes-next.md`
  + `RELEASE_NOTES.md` lines, and a **docs sweep** of `docs/local-llm.md`
  (`74-75, 280, 298` "add the tag to `RESIDENT_MODELS`" instructions become
  false).

## Scope (files touched)

- **Server:** `analyzer/ollama.ts` (+`ollama.test.ts`), `workspace/user-settings.ts`,
  `routes/models-inventory.ts`, `routes/ollama-health.ts` (warm route),
  `config/registry.ts` (+`registry.test.ts`), `tts/persona-gpu-plan.ts`
  (+`prepare-persona-batch.test.ts`), `openapi.yaml`, `.env.example` (via
  `config:sync`).
- **Frontend:** `views/model-manager.tsx` (+test), `store/account-slice.ts`,
  `lib/api.ts` (`ModelInventoryItem` type + mock inventory builder + mock
  `putUserSettings` whitelist + mock-registry mirror removal), `lib/api-types.ts`
  (via `openapi:types`), `lib/types.ts`.
- **Docs:** new regression plan, `docs/local-llm.md` sweep, two release-notes
  files.

## Acceptance

1. Each analyzer (Ollama) row in the Model Manager shows an editable keep-alive
   (seconds) reading `item.keepAliveSeconds`; supported models show `300`, custom
   tags show `0`. No `DEFAULT_KEEP_ALIVE_SECONDS`/`normalizeModelTag` mirror
   exists under `src/`.
2. Setting `qwen36-castwright:latest` to `300` and running analysis keeps the
   model resident across chapter boundaries (`ollama ps` shows a real countdown,
   not immediate `Stopping…`, between requests).
3. Setting a model to `0` reproduces immediate-unload; `-1` pins it.
4. No live **code** symbol `RESIDENT_MODELS`/`resolveAnalyzerKeepAlive` remains in
   `server/` or `src/`; `.env.example` no longer generates `ANALYZER_KEEP_ALIVE`;
   `docs/local-llm.md` no longer instructs editing the allowlist. (Archived
   `docs/features/*` mentions left as-is.)
5. On a CPU-only box, `qwen3.5:9b` still unloads immediately (actual sent
   `keep_alive: 0`) regardless of its configured value; the UI notes this.
6. Editing one model's keep-alive leaves every other model's override intact
   (full-map merge, no clobber) — verified in mock mode too.
7. Voice-design (persona) keep-alive is unchanged for **every** configuration
   (fixed `300`), including a custom analyzer model with no override.
8. Clicking Load on a row warms the model for its configured keep-alive window
   (not a hardcoded 5 min).

## Revision notes

**Pass 1** caught: (1) the persona second consumer (originally mis-labelled
allowlist-only); (2) five allowlist entries not four (`:latest`); (3) knob removal
needs `config:sync`/`.env.example`/`registry.test`; (4) shallow-merge clobber +
Model Manager has no account fetch; (5) cold-cache sync read; (6) CPU-clamp UI
honesty; (7) wider `openapi`/client-type surface + `string→number`; (8)
"grep clean" scoped to live code + docs sweep.

**Pass 2** (this revision) caught: **(A)** the client can't compute the display
value from a server-only constant → server now exposes `keepAliveSeconds` /
`keepAliveIsOverride` on the inventory item (no frontend mirror);
**(B)** routing persona through the per-model resolver would regress persona
keep-alive `300→0` for custom/unconfigured models → persona decoupled onto a fixed
`PERSONA_KEEP_ALIVE_SECONDS = 300`; **(C)** a second wire assertion at
`ollama.test.ts:161` also asserts `'5m'` → added to the test-update list;
**(D)** the manual `/load` warm route hardcodes `'5m'` → now honors
`resolveKeepAliveSeconds(model)`; plus the `mockPutUserSettings` hard-whitelist
and the `openapi:types`→`api-types.ts` regen (no `--check` gate) are named
explicitly.
