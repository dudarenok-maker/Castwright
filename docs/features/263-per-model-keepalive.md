---
status: active
shipped: null
owner: null
---

# Per-model analyzer keep-alive (Model Manager)

> Status: active — server + frontend + tests landed; on-box `ollama ps` acceptance owed.
> Key files: `server/src/analyzer/ollama.ts`, `server/src/workspace/user-settings.ts`,
> `server/src/routes/models-inventory.ts`, `server/src/routes/ollama-health.ts`,
> `server/src/tts/persona-gpu-plan.ts`, `src/views/model-manager.tsx`,
> `src/store/account-slice.ts`, `src/lib/api.ts`
> URL surface: `#/admin` → Model Manager (admin-only; no new route)
> OpenAPI ops: `PUT /api/user/settings` (`UserSettings`/`UserSettingsPatch` gain
> `analyzerKeepAliveByModel`); `GET /api/models` (inventory items gain
> `keepAliveSeconds`/`keepAliveIsOverride`); `POST /api/ollama/load` (unchanged
> shape, changed behavior)

> **Update — srv-62 / #1709 (runtime-path fallback + pin-during-run).** Two
> changes landed after the original plan that supersede the runtime keep-alive
> resolution described in **Invariants 1 & 2** below; they are corrected inline,
> but read this first:
> - **Curated map removed → flat 30s fallback (#1711).** The coded
>   `DEFAULT_KEEP_ALIVE_SECONDS` map (four tags @ `300`, `0` for everything else)
>   is deleted. `resolveKeepAliveSeconds` now returns the user override or a flat
>   `DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS = 30`. Every uncurated fine-tune (e.g.
>   `qwen36-cw-iq3-64k:latest`) used to fall to `0` = evict-per-call, cold-loading
>   the model on every attribution chunk; it now holds 30s and stays resident
>   across a run. This is the runtime-path sibling of the #1706 warm-path floor
>   (Invariant 8).
> - **Pin the analyzer for the whole run (#1715, extended to review runs #1718).**
>   Attribution `/api/chat` calls land 120–200 s apart, so *any* finite idle TTL
>   (even 30, even a user's 90) lets Ollama evict between calls and cold-reload —
>   thrash that also opens a reload window where a transient unreachable trips the
>   cloud (Gemini) fallback into a hard failure. `keepAliveFor` therefore returns
>   `-1` (pin) while **any** analyzer run — analysis, subset-retry, or script
>   review — is in flight; the run's teardown (`routes/analysis.ts` `endJob`)
>   issues the matching `keep_alive:0` evict. **Net effect:** the per-model
>   seconds value now governs the *post-run* idle hold only; mid-run eviction can
>   no longer happen regardless of the value. This makes the exact fallback (30
>   vs a longer bridge) largely cosmetic — the reload-per-call tax srv-62 targeted
>   is eliminated by the pin.

## Benefit / Rationale

- **User:** any analyzer model — including a custom/renamed Ollama tag like
  `qwen36-castwright:latest` that the old hardcoded allowlist could never
  recognize — can be set to stay warm (or unload immediately, or pin forever)
  right from the Model Manager, with no config file or env var. `ollama ps`
  stops showing a perpetual `Stopping…` for a model that's actually in active
  use across chapter boundaries.
- **Technical:** deletes a hardcoded per-box allowlist (`RESIDENT_MODELS`) and
  the registry knob that fed it (`analyzer.ollama.keepAlive` / `ANALYZER_KEEP_ALIVE`),
  replacing both with a data-driven `override ?? default` resolver (the default a
  flat `30`s since srv-62/#1709) that works for any model tag, not just the four
  the codebase happened to name.
- **Architectural:** locks in the "server resolves, client only displays"
  pattern for a value the client can't compute itself — the Model Manager reads
  `item.keepAliveSeconds`/`item.keepAliveIsOverride` off the inventory payload
  rather than mirroring `DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS`/`normalizeModelTag` into
  `src/`, so server and client can never drift on what a given tag's keep-alive
  actually resolves to. Also locks in that a sparse per-model settings map (like
  `analyzerKeepAliveByModel`) must always be edited via full-map merge-then-PUT,
  never a partial PUT, because `writeUserSettings` shallow-merges at the
  top-level key only (class of bug this plan explicitly guards against — see
  Invariant 5).

## Architectural impact

- **New seams:** `analyzerKeepAliveByModel: Record<string, number>` on
  `UserSettings` (sparse override map, tag → seconds); `resolveKeepAliveSeconds(model)`
  and `normalizeModelTag(tag)` exported from `server/src/analyzer/ollama.ts` as
  the one place that knows how a tag resolves to a keep-alive value.
- **Removed:** the `RESIDENT_MODELS` hardcoded `Set`, `resolveAnalyzerKeepAlive()`
  (the old `'5m'`-string global resolver), and the `analyzer.ollama.keepAlive`
  registry knob (`ANALYZER_KEEP_ALIVE` env var) — nothing reads any of the three
  anymore.
- **Invariants preserved:** the `RAM_HEAVY_MODELS` CPU-clamp safety rail (plan
  221's original concern — leaving `qwen3.5:9b` resident on a CPU-only box pins
  ~6.4 GB system RAM) is untouched, just re-homed as a clamp on top of the new
  per-model resolver instead of a term inside the old allowlist check. The
  analyzer↔TTS cross-engine eviction chokepoint (`gpu.safeCoexistMb`, plan 222)
  is untouched — this plan only changes *how long* a model stays resident once
  loaded, not *whether* it gets evicted for a TTS/voice-design load.
- **Migration story:** none needed. `analyzerKeepAliveByModel` is additive with
  `.default({})`; an existing installation with no overrides gets the flat `30`s
  fallback for every tag (srv-62/#1709; originally this was `300` for four
  supported models and `0` for anything unlisted). No `state.json`/`cast.json`
  shape changes.
- **Reversibility:** an operator can restore per-call behavior for any model by
  setting its keep-alive to `0` in the Model Manager — no code revert needed.
  Reverting the whole feature (re-adding `RESIDENT_MODELS`) is a code revert of
  this plan's commits; nothing downstream depends on the new fields being
  present (the schema field is optional-with-default).

## Invariants to preserve

1. `keepAliveFor(model, accelerator)` (`server/src/analyzer/ollama.ts`) —
   **updated by srv-62/#1709.** Order: if **any** analyzer run is in flight
   (`isAnyAnalyzerRunBusy()` = analysis OR script review) it returns `-1` (pin)
   regardless of model/override/clamp; otherwise
   `RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu' ? 0 : resolveKeepAliveSeconds(model)`.
   Returns an **integer number of seconds** (`-1` = pin), not a duration string —
   Ollama's `keep_alive` accepts an integer natively. The run-scoped pin is the
   durable fix for mid-run eviction; run teardown (`routes/analysis.ts` `endJob`,
   plus the script-review job's `finally`) issues the matching `keep_alive:0`
   evict, so the pin is strictly run-scoped and the per-model value keeps its
   meaning as the *post-run* idle retention.
2. `resolveKeepAliveSeconds(model)` (`ollama.ts`) — **updated by srv-62/#1709.**
   = the first defined of: the user's raw-key override (`map[model]`), the user's
   normalized-key override (`map[normalizeModelTag(model)]`), or the flat
   `DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS` (`30`). The old curated
   `DEFAULT_KEEP_ALIVE_SECONDS` map (four tags @ `300`, `0`-fallthrough for
   everything else) was **deleted (#1711)**: an uncurated fine-tune with no
   override no longer falls to `0` (evict-per-call) but to `30`, a short bridge
   that survives back-to-back attribution calls. A user override still wins; `-1`
   still means pin forever.
3. `normalizeModelTag(tag)` (`ollama.ts:143`) strips a trailing `:latest` only
   — `gemma4-e4b-8gb:latest` → `gemma4-e4b-8gb`; `qwen3.5:9b` is untouched
   (`9b` is a real tag component, not the literal `latest`).
4. Seconds semantics are Ollama-native: `0` = unload immediately, a positive
   integer = seconds resident, `-1` = pin forever. An unconfigured custom tag now
   defaults to `30` (srv-62/#1709), not `0`. The Model Manager's helper copy (the
   keep-alive field's `title` tooltip) documents the default, all three explicit
   values, the run-scoped pin, and the CPU RAM-heavy clamp.
5. **Full-map merge, never partial PUT.** `writeUserSettings`
   (`server/src/workspace/user-settings.ts`) shallow-merges
   `{ ...current, ...validated }` at the top level, so a PUT carrying a
   partial `analyzerKeepAliveByModel` **replaces the entire map**. Every write
   site (`src/views/model-manager.tsx:585` edit path, `:597` reset path) reads
   the *current* merged map (`keepAliveMap`, sourced from account settings
   already fetched into the view) and PUTs the full merged object — never a
   single-key delta. `src/lib/api-put-user-settings-mock.test.ts` pins that
   editing one model's entry leaves every other model's override intact in
   mock mode.
6. **Persona (voice-design) keep-alive is a fixed constant, not per-model.**
   `PERSONA_KEEP_ALIVE_SECONDS = 300` (`server/src/tts/persona-gpu-plan.ts:14`)
   is used directly by `resolvePersonaGpuPlan`/`resolvePersonaCpuKeepAlive` —
   it does **not** route through `resolveKeepAliveSeconds`. This is deliberate:
   routing persona through the per-model map would make voice-design keep-alive
   depend on whatever analyzer model happens to be configured (via
   `resolvePersonaLocalModel()` → `getResolvedOllamaModel()`), so a user on a
   custom analyzer tag with no override would silently regress persona
   keep-alive from `300` to `0` and reload-thrash between back-to-back cast
   designs. Persona behavior is therefore byte-identical to before this plan
   for every configuration.
7. `models-inventory.ts` exposes the resolved value on every `ollama:`-prefixed
   inventory item: `keepAliveSeconds: resolveKeepAliveSeconds(m.name)`
   (`models-inventory.ts:319`, **pre**-CPU-clamp — display reflects configured
   intent, not the CPU-clamped runtime value) and
   `keepAliveIsOverride: hasKeepAliveOverride(m.name)` (`:320`). The frontend
   reads these two fields directly and contains **no** mirror of
   `DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS` or `normalizeModelTag` under `src/` — the
   server is the only place that resolver logic lives.
8. `POST /api/ollama/load` (`server/src/routes/ollama-health.ts`,
   `warmOllamaModel`) warms with `keep_alive:
   floorWarmKeepAlive(keepAliveFor(model, getLastKnownVram().accelerator))` — not
   a hardcoded `'5m'`. An **explicit Load means "hold it resident"**, so a
   resolved keep-alive of `0` is **floored up to `WARM_MIN_KEEP_ALIVE_SECONDS`
   (30)** rather than warming-and-evicting in the same call. Since srv-62/#1709
   made the runtime fallback a flat `30`, the only way a warm now resolves `0`
   (and thus hits the floor) is the `RAM_HEAVY_MODELS` CPU clamp — a custom tag
   with no override already resolves `30`. A positive per-model value is honored
   as-is; a negative keep-forever (`-1`) override passes through untouched (floor
   fires only on exactly `0`). This is the ONE place the warm path diverges from
   the analyzer chat path (Invariant 1), which during a run pins at `-1` and
   otherwise sends the unfloored, CPU-clamped value — the clamp's RAM-safety
   concern is about a model pinned across a long analysis loop, not a single 30s
   manual warm.
   **Supersedes this plan's original intent** that a `0`-keep-alive model "warms
   once and does not persist": warming with `keep_alive: 0` is Ollama's
   evict-immediately idiom, so it loaded the model and dropped it in the same
   call — the Analysing Load button looked dead and the pill snapped straight
   back to "Analyzer idle" for every non-defaulted custom tag (the reported
   regression). The 30s floor is a short bridge until analysis starts and takes
   over with its own per-call keep-alive.
9. No live **code** symbol `RESIDENT_MODELS` or `resolveAnalyzerKeepAlive`
   remains under `server/src` or `src`; `.env.example` no longer generates an
   `ANALYZER_KEEP_ALIVE` block; `docs/local-llm.md` no longer instructs editing
   an allowlist (see the sweep below). Historical mentions in archived
   `docs/features/*` plans (e.g. plan 221) are left as-is — they document what
   shipped at the time, not current behavior.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/ollama.test.ts`) — `keepAliveFor`/
  `resolveKeepAliveSeconds` block (**updated by srv-62/#1709**): ANY model with
  no override — formerly-curated (`qwen3.5:4b`, `llama3.1:8b`, `qwen3.5:9b`,
  `gemma4-e4b-8gb`) and uncurated (`qwen36-cw-iq4-32k:latest`,
  `placeholder:test-7b`) alike — resolves the flat `30` fallback (integer, not
  `'5m'`); a `:latest`-suffixed tag normalizes; a user override wins (`600`,
  `0`, `-1`); `RAM_HEAVY_MODELS` on `accelerator: 'cpu'` clamps to `0` even with
  a positive override while `cuda`/`unknown` honor it; and — the pin — while an
  analysis OR review run is in flight `keepAliveFor` returns `-1` for every case
  (uncurated fallback, override, and the CPU clamp), reverting to normal
  resolution once both runs end. The happy-path streaming block asserts at the
  wire level that `body.keep_alive` reaches `/api/chat` as the integer `30`.
- Vitest server (`server/src/workspace/user-settings.test.ts`) —
  `analyzerKeepAliveByModel` accepts a sparse integer map, rejects
  non-integers, round-trips through `writeUserSettings`; a cold-cache read
  (`_setUserSettingsCacheForTest`) treats a missing map as `{}` rather than
  throwing.
- Vitest server (`server/src/config/registry.test.ts`) — the removed
  `analyzer.ollama.keepAlive` knob case is deleted; no other registry
  assertion (group counts, key uniqueness) is affected by the removal.
- Vitest server (`server/src/tts/prepare-persona-batch.test.ts`) — the persona
  GPU plan resolves `keepAlive: 300` via the fixed `PERSONA_KEEP_ALIVE_SECONDS`
  constant, independent of any configured `analyzerKeepAliveByModel` override.
- Vitest server (`server/src/routes/models-inventory.test.ts`) — an analyzer
  inventory item carries `keepAliveSeconds` (the user override, else the flat
  `30` fallback) and `keepAliveIsOverride` (`true` only when a user override
  exists for that tag).
- Vitest server (`server/src/routes/ollama-health.test.ts`) — the `/load`
  warm route sends `floorWarmKeepAlive(keepAliveFor(model, accelerator))`, not
  a hardcoded `'5m'`: with no override every tag warms at the flat `30` fallback
  (the test asserts `keep_alive === 30` for `qwen3.5:9b`); a RAM-heavy model on a
  `cpu` accelerator resolves `0` and is floored back to `30` (explicit Load
  overrides the runtime clamp — Load must hold, not evict), while its
  `cuda`/`unknown` warm is the un-clamped `30`.
- Vitest server (`server/src/routes/user-settings.test.ts`) — the settings PUT
  route round-trips `analyzerKeepAliveByModel`.
- Vitest frontend (`src/views/model-manager.test.tsx`) — an analyzer row
  renders `item.keepAliveSeconds` in the seconds field; editing the field
  dispatches `saveAccountSettings` with the **full merged**
  `analyzerKeepAliveByModel` map (asserts other tags' overrides survive, not
  just the edited one); the reset (↺) button — shown only when
  `item.keepAliveIsOverride` — deletes just that tag's entry from the map.
- Vitest frontend (`src/lib/api-put-user-settings-mock.test.ts`) —
  `mockPutUserSettings` accepts and round-trips `analyzerKeepAliveByModel`
  (the mock whitelist previously would have silently dropped an unlisted
  field).
- `npm run config:check` — `.env.example` reflects the registry with
  `ANALYZER_KEEP_ALIVE` removed (no drift after `config:sync`).

If a surface area is untested: the live-hardware `ollama ps` countdown
behavior (Acceptance walkthrough below) has no automated equivalent — it is
an on-box manual check, called out explicitly rather than silently omitted.

### Manual acceptance walkthrough

Run against a real local Ollama install with at least one pulled model (the
canonical e2e manuscript, `server/src/__fixtures__/the-coalfall-commission.md`,
is a convenient real analysis to drive while observing `ollama ps`).

1. **Open `#/admin` → Model Manager**, with `server` running against a real
   Ollama daemon. Each Ollama-backed analyzer row shows a **keep-alive
   (seconds)** number field next to its Load/Unload control. With no override,
   every tag — curated or a custom/pulled fine-tune (e.g.
   `qwen36-castwright:latest`) — shows the flat `30` default (srv-62/#1709; the
   old per-tag `300`/`0` split is gone). Hovering the field shows the helper
   tooltip documenting the default, the `0`/positive/`-1` semantics, the
   run-scoped pin, and the CPU RAM-heavy clamp.
2. **Set `qwen36-castwright:latest`'s keep-alive field to `300`** and blur the
   field (tab or click away). Expect a `PUT /api/user/settings` carrying the
   full `analyzerKeepAliveByModel` map with `{ "qwen36-castwright:latest": 300,
   ... }` — the client keys the map with the **raw inventory tag**
   (`item.id.slice('ollama:'.length)`), `:latest` and all, since the frontend
   deliberately does not import `normalizeModelTag` (Invariant 7). The server
   resolver tolerates either form: `resolveKeepAliveSeconds` checks the raw-key
   override first, then the normalized-key override (Invariant 2), so a raw
   `qwen36-castwright:latest` key resolves correctly without any client-side
   normalization. Every previously-configured model's entry stays present
   unchanged. A ↺ reset button now appears next to the field (since
   `keepAliveIsOverride` is now `true` for this tag).
3. **Run an analysis** against that model, then in PowerShell run `ollama ps`
   repeatedly across a chapter boundary or two. Because the analyzer is **pinned
   for the duration of the run** (srv-62/#1709, Invariant 1), expect `UNTIL` to
   read `Forever` (or refresh with no `Stopping…`) across every attribution
   chunk — no cold reload between calls. When the run **ends**, teardown evicts
   and the field's configured seconds (default `30`) govern the idle hold. (A
   manual "Load" pill outside a run still warms with the floored keep-alive per
   Invariant 8.)
4. **Set the same field to `0`** and blur. **During an analysis run this is
   overridden by the pin** (`/api/chat` sends `-1`, Invariant 1) — the `0` only
   takes effect as the *post-run* idle, so once the run ends the model evicts
   immediately rather than lingering. **An explicit "Load" pill outside a run
   still warms it:** clicking Load warms with `keep_alive: 30` (the floor,
   Invariant 8), so `ollama ps` shows the model resident with an ~30s `UNTIL`
   countdown and the pill goes green — Load never load-then-evicts. This is the
   regression fix: before the floor, a `0`-resolving tag (default for any custom
   quant) made the Load button appear to do nothing.
5. **Set the field to `-1`.** Expect the model to stay resident indefinitely
   (`ollama ps` shows no eviction countdown) until manually unloaded.
6. **Click ↺ (reset)** on an overridden row. Expect the field to fall back to
   displaying the flat `30` default (srv-62/#1709 — same for every tag now) and
   the reset button to disappear; the PUT carries the map with that tag's key
   removed, every other override intact.
7. **On a CPU-only box** (no CUDA, and with no analysis run in flight — the pin
   would otherwise send `-1`), configure `qwen3.5:9b`'s keep-alive to a positive
   value. Expect the resolved post-run `keep_alive` to still be `0` (the
   `RAM_HEAVY_MODELS` CPU clamp overrides the configured value) — the UI's helper
   tooltip notes this caveat next to the field.
8. **Design a voice** (cast-review) with a custom analyzer model configured
   and no override set. Expect the persona/voice-design keep-alive to still
   behave as `300` (unchanged) — confirming persona never regressed to `0`
   via the per-model resolver.

## Out of scope

- A live per-*resident*-model dashboard control (showing the real-time
  countdown in-app) — the acceptance walkthrough above uses `ollama ps`
  directly; no in-app countdown UI is built.
- The cross-engine GPU eviction chokepoint (`gpu.safeCoexistMb`, plan 222) —
  orthogonal, untouched.
- Model-agnostic *measured* residency / VRAM telemetry-driven eviction — still
  deferred to `#845` (plan 223 is the telemetry-recording half; nothing here
  changes that).
- Making persona (voice-design) keep-alive itself configurable per-model — it
  stays the fixed `PERSONA_KEEP_ALIVE_SECONDS = 300` constant (Invariant 6).

## Ship notes

(Fill in when status flips to `stable`: shipped date, commit SHA, and move
this file to `docs/features/archive/` in the same PR.)
