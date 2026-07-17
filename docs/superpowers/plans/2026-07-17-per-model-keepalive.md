# Per-model analyzer keep-alive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set an Ollama analyzer keep-alive per model (in seconds) from the Model Manager, and retire the hardcoded `RESIDENT_MODELS` allowlist + `analyzer.ollama.keepAlive` knob.

**Architecture:** Defaults live in a server code constant; user overrides live in a sparse `analyzerKeepAliveByModel` map in `user-settings.json`. A synchronous resolver (`resolveKeepAliveSeconds`) reads `override ?? default ?? 0` and feeds both the analyzer chat path and the manual `/load` warm route. The server exposes each model's *resolved* value on the inventory payload so the Model Manager renders it without mirroring server constants into the frontend. The persona/voice-design path is decoupled onto a fixed 300 s constant (it was always model-independent).

**Tech Stack:** Node/Express + zod (server), Vitest (server + frontend), React + Redux Toolkit (frontend), Ollama `/api/chat` + `/api/generate` keep_alive.

**Design of record:** `docs/superpowers/specs/2026-07-17-per-model-keepalive-design.md` (twice adversarially reviewed).

## Global Constraints

- **Seconds semantics** map onto Ollama native `keep_alive`: `0` = unload immediately, positive = seconds resident, `-1` = pin forever. `keepAliveFor` returns an **integer** now (was the string `'5m'`).
- **Every new env var must be a registry knob + `.env.example`** — but here we are *removing* a knob; run `npm run config:sync` in the same task so `config:check` (pre-push + cloud) stays green.
- **Commit convention:** `<type>(<scope>): <subject>`; scope `server` or `frontend`. Husky is active in this worktree (real hooks).
- **No hex literals / design tokens** rule and **44px touch targets** (`min-h-[44px] fine-pointer:min-h-0`) apply to any new control.
- **Do not run torch-importing server suites while a GPU generation is active** (pre-commit flagged ~46% util at spec time). Prefer targeted `vitest run <file>` for server tests; check `nvidia-smi` before a full `test:server`.
- Client keys the override map by the **raw inventory tag** (`item.id.slice('ollama:'.length)`); the server resolver tolerates both raw and `:latest`-normalized forms. The frontend never imports `normalizeModelTag`/`DEFAULT_KEEP_ALIVE_SECONDS`.

---

### Task 1: `analyzerKeepAliveByModel` field on user settings

**Files:**
- Modify: `server/src/workspace/user-settings.ts` (schema ~239, `DEFAULT_USER_SETTINGS` ~320)
- Test: `server/src/workspace/user-settings.test.ts`

**Interfaces:**
- Produces: `UserSettings.analyzerKeepAliveByModel: Record<string, number>` (defaults `{}`); readable synchronously via `getCachedUserSettings().analyzerKeepAliveByModel`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/workspace/user-settings.test.ts`:

```ts
import { userSettingsSchema, DEFAULT_USER_SETTINGS } from './user-settings.js';

describe('analyzerKeepAliveByModel', () => {
  it('defaults to an empty object when absent', () => {
    const parsed = userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS });
    expect(parsed.analyzerKeepAliveByModel).toEqual({});
  });
  it('accepts a sparse integer map', () => {
    const parsed = userSettingsSchema.parse({
      ...DEFAULT_USER_SETTINGS,
      analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 300, 'foo:bar': 0 },
    });
    expect(parsed.analyzerKeepAliveByModel['qwen36-castwright:latest']).toBe(300);
  });
  it('rejects a non-integer keep-alive', () => {
    expect(() =>
      userSettingsSchema.parse({
        ...DEFAULT_USER_SETTINGS,
        analyzerKeepAliveByModel: { 'foo:bar': 1.5 },
      }),
    ).toThrow();
  });
  it('is present in DEFAULT_USER_SETTINGS', () => {
    expect(DEFAULT_USER_SETTINGS.analyzerKeepAliveByModel).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts -t analyzerKeepAliveByModel`
Expected: FAIL (`analyzerKeepAliveByModel` is `undefined`).

- [ ] **Step 3: Add the schema field**

In `user-settings.ts`, immediately before the closing `});` of `userSettingsSchema` (after `tourCompletedAt`, ~line 238):

```ts
  /* Per-model Ollama analyzer keep-alive (seconds). Sparse override map:
     model tag → seconds (0 = unload immediately, -1 = pin, N = resident N s).
     Absent tags fall through to DEFAULT_KEEP_ALIVE_SECONDS in analyzer/ollama.ts
     and then to 0. NOT in FORBIDDEN_KEYS — the general Account/Model-Manager
     PUT is the sanctioned write path (mirrors configOverrides). Read
     synchronously by resolveKeepAliveSeconds. Optional-with-default so legacy
     files load unchanged. */
  analyzerKeepAliveByModel: z.record(z.string(), z.number().int()).default({}),
```

- [ ] **Step 4: Add the default**

In `DEFAULT_USER_SETTINGS`, after `configOverrides: {},` (~line 315):

```ts
  /* Per-model analyzer keep-alive — empty by default; every model falls
     through to its coded default (see DEFAULT_KEEP_ALIVE_SECONDS). */
  analyzerKeepAliveByModel: {},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts -t analyzerKeepAliveByModel`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/workspace/user-settings.ts server/src/workspace/user-settings.test.ts
git commit -m "feat(server): add analyzerKeepAliveByModel to user settings schema"
```

---

### Task 2: `resolveKeepAliveSeconds` + integer `keepAliveFor` (delete `RESIDENT_MODELS`)

**Files:**
- Modify: `server/src/analyzer/ollama.ts` (151-185)
- Test: `server/src/analyzer/ollama.test.ts` (126-218)

**Interfaces:**
- Consumes: `getCachedUserSettings().analyzerKeepAliveByModel` (Task 1).
- Produces:
  - `normalizeModelTag(tag: string): string`
  - `resolveKeepAliveSeconds(model: string): number`
  - `hasKeepAliveOverride(model: string): boolean`
  - `keepAliveFor(model: string, accelerator?: Accelerator): number` (now integer)
  - `DEFAULT_KEEP_ALIVE_SECONDS: Record<string, number>`
- Keeps (temporarily, removed in Task 3): `resolveAnalyzerKeepAlive()`.

- [ ] **Step 1: Rewrite the `keepAliveFor` unit-test block**

Replace the **entire** `keep_alive policy` describe (`ollama.test.ts` lines **192-252** — it contains two pure-function `it`s at 195/218 **and three wire-level `expect(body.keep_alive).toBe('5m')` tests** at 232/241/250, all of which must go) with the block below. Wire-level coverage is retained by the happy-path assertion (line 161, updated further down).

```ts
import { _setUserSettingsCacheForTest, _resetUserSettingsCache, DEFAULT_USER_SETTINGS } from '../workspace/user-settings.js';

describe('OllamaAnalyzer — keep_alive policy (per-model seconds)', () => {
  afterEach(() => _resetUserSettingsCache());

  it('returns the coded default (300) for supported models, 0 for unknown', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    expect(keepAliveFor('qwen3.5:4b')).toBe(300);
    expect(keepAliveFor('llama3.1:8b')).toBe(300);
    expect(keepAliveFor('qwen3.5:9b')).toBe(300);
    expect(keepAliveFor('gemma4-e4b-8gb')).toBe(300);
    expect(keepAliveFor('gemma4-e4b-8gb:latest')).toBe(300); // normalized to bare
    expect(keepAliveFor('placeholder:test-7b')).toBe(0);
  });

  it('lets a user override win, including -1 (pin) and 0 (evict)', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    _setUserSettingsCacheForTest({
      ...DEFAULT_USER_SETTINGS,
      analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 600, 'qwen3.5:4b': 0, 'llama3.1:8b': -1 },
    });
    expect(keepAliveFor('qwen36-castwright:latest')).toBe(600);
    expect(keepAliveFor('qwen3.5:4b')).toBe(0);   // override beats the 300 default
    expect(keepAliveFor('llama3.1:8b')).toBe(-1);
  });

  it('clamps RAM-heavy 9B to 0 on CPU even with a positive override', async () => {
    const { keepAliveFor } = await import('./ollama.js');
    _setUserSettingsCacheForTest({
      ...DEFAULT_USER_SETTINGS,
      analyzerKeepAliveByModel: { 'qwen3.5:9b': 900 },
    });
    expect(keepAliveFor('qwen3.5:9b', 'cuda')).toBe(900);
    expect(keepAliveFor('qwen3.5:9b', 'cpu')).toBe(0);
    expect(keepAliveFor('qwen3.5:9b', 'unknown')).toBe(900);
    expect(keepAliveFor('qwen3.5:4b', 'cpu')).toBe(300); // small model unaffected
  });
});
```

Also update the happy-path wire assertion at **line 161** (`body.keep_alive`, model `qwen3.5:9b`), and replace the stale `RESIDENT_MODELS` comment at 152-157:

```ts
    /* qwen3.5:9b resolves to its coded default keep-alive (300 s) — see
       DEFAULT_KEEP_ALIVE_SECONDS in ollama.ts; unknown tags get 0. */
    expect(body.keep_alive).toBe(300);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts -t keep_alive`
Expected: FAIL (`keepAliveFor` still returns `'5m'` / the pins differ).

- [ ] **Step 3: Rewrite `ollama.ts` 151-185**

Replace lines 151-185 with:

```ts
/* Coded keep-alive defaults (seconds) for the analyzer models Castwright
   supports out of the box. Keyed on the NORMALIZED (bare, no ':latest') tag.
   User overrides in userSettings.analyzerKeepAliveByModel win; anything not
   listed and not overridden falls to 0 (unload immediately). 300 = the former
   global '5m' the retired RESIDENT_MODELS allowlist applied. */
const DEFAULT_KEEP_ALIVE_SECONDS: Record<string, number> = {
  'qwen3.5:4b': 300,
  'qwen3.5:9b': 300,
  'llama3.1:8b': 300,
  'gemma4-e4b-8gb': 300,
};

/* Models unsafe to keep resident on CPU (would pin ~6.4 GB system RAM for the
   whole window). Clamped to 0 on a CPU-only box regardless of the configured
   value. Orthogonal to the per-model map — a deliberate safety rail. */
const RAM_HEAVY_MODELS = new Set(['qwen3.5:9b']);

/** Strip a trailing ':latest' only (Ollama treats bare == :latest). Leaves real
    tags like 'qwen3.5:9b' untouched. */
export function normalizeModelTag(tag: string): string {
  return tag.endsWith(':latest') ? tag.slice(0, -':latest'.length) : tag;
}

/** Resolved keep-alive (seconds) for `model`: user override (raw or normalized
    key) → coded default (normalized) → 0. Reads the settings cache synchronously
    so it is safe at the request-body build site. */
export function resolveKeepAliveSeconds(model: string): number {
  const map = getCachedUserSettings().analyzerKeepAliveByModel ?? {};
  const norm = normalizeModelTag(model);
  const override = map[model] ?? map[norm];
  if (override !== undefined) return override;
  return DEFAULT_KEEP_ALIVE_SECONDS[norm] ?? 0;
}

/** True when the user has an explicit override for `model` (either key form). */
export function hasKeepAliveOverride(model: string): boolean {
  const map = getCachedUserSettings().analyzerKeepAliveByModel ?? {};
  return map[model] !== undefined || map[normalizeModelTag(model)] !== undefined;
}

/** Live-read the resident-model keep-alive window (registry wins; default '5m').
    DEPRECATED — retained only until the persona path (Task 3) stops calling it. */
export function resolveAnalyzerKeepAlive(): string {
  return configValue<string>('analyzer.ollama.keepAlive');
}

/** `keep_alive` (integer seconds) for an Ollama /api/chat call. Per-model via
    resolveKeepAliveSeconds; RAM-heavy models clamp to 0 on CPU. */
export function keepAliveFor(model: string, accelerator: Accelerator = 'unknown'): number {
  if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;
  return resolveKeepAliveSeconds(model);
}
```

Add the import at the top of `ollama.ts` if not already present:

```ts
import { getCachedUserSettings } from '../workspace/user-settings.js';
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts`
Expected: PASS (keep_alive policy block + happy-path stream). NOTE: `_setUserSettingsCacheForTest(partial)` and `_resetUserSettingsCache()` already exist in `user-settings.ts` (`~745`/`~756`) — the setter merges the partial over `DEFAULT_USER_SETTINGS`, the reset nulls the cache. No new helper needed; do NOT call the setter with `null`.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts server/src/workspace/user-settings.ts
git commit -m "feat(server): resolve analyzer keep_alive per model (seconds), drop RESIDENT_MODELS"
```

---

### Task 3: Decouple persona keep-alive onto a fixed 300 s constant

**Files:**
- Modify: `server/src/tts/persona-gpu-plan.ts` (8, 62-75)
- Modify: `server/src/analyzer/ollama.ts` (remove `resolveAnalyzerKeepAlive`)
- Test: `server/src/tts/prepare-persona-batch.test.ts` (48-52 + the keepAlive assertion)

**Interfaces:**
- Produces: `PERSONA_KEEP_ALIVE_SECONDS = 300` (local const in `persona-gpu-plan.ts`).
- Removes: `resolveAnalyzerKeepAlive` export from `ollama.ts`.

- [ ] **Step 1: Update the persona test expectation**

In `prepare-persona-batch.test.ts`, delete the `resolveAnalyzerKeepAlive` mock (lines 48-52) — it no longer exists. Then find the assertion that checks the plan's `keepAlive` for the constrained-idle branch and change it from `'5m'` to `300`. If the file mocks `../analyzer/ollama.js` only for that symbol, remove the whole `vi.mock('../analyzer/ollama.js', …)` block; keep any other ollama mock it needs. Example expected assertion:

```ts
expect(plan).toEqual({ onCpu: false, evict: true, keepAlive: 300 });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/tts/prepare-persona-batch.test.ts`
Expected: FAIL (`keepAlive` is `'5m'`).

- [ ] **Step 3: Replace the persona keep-alive source**

In `persona-gpu-plan.ts`: remove the import `import { resolveAnalyzerKeepAlive } from '../analyzer/ollama.js';` (line 8). Add near the top, after the imports:

```ts
/* Voice-design (persona) keep-alive is a fixed window, independent of the
   per-model analyzer map: the persona local model is kept warm across a
   cast-review session (back-to-back designs) then freed by the design idle
   watchdog. 300 s preserves the historical '5m'. */
const PERSONA_KEEP_ALIVE_SECONDS = 300;
```

Change line 74 from `keepAlive: resolveAnalyzerKeepAlive()` to `keepAlive: PERSONA_KEEP_ALIVE_SECONDS`.

- [ ] **Step 4: Remove the dead reader**

In `ollama.ts`, delete the `resolveAnalyzerKeepAlive` function (the block added-back in Task 2 Step 3, marked DEPRECATED). Confirm nothing else imports it:

Run: `git grep -n resolveAnalyzerKeepAlive -- server/ src/`
Expected: no matches (comments included, since we removed them).

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && npx vitest run src/tts/prepare-persona-batch.test.ts src/analyzer/ollama.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/persona-gpu-plan.ts server/src/tts/prepare-persona-batch.test.ts server/src/analyzer/ollama.ts
git commit -m "feat(server): pin persona keep-alive to a fixed 300s, drop resolveAnalyzerKeepAlive"
```

---

### Task 4: Retire the `analyzer.ollama.keepAlive` registry knob

**Files:**
- Modify: `server/src/config/registry.ts` (1088-1096)
- Modify: `server/src/config/registry.test.ts` (71-77)
- Modify: `src/lib/api.ts` (mock registry mirror ~8956)
- Regenerated: `server/.env.example` (via `npm run config:sync` — it writes `server/.env.example`, NOT a root file; the `ANALYZER_KEEP_ALIVE` block is at `server/.env.example:517`)

- [ ] **Step 1: Update the registry test**

In `registry.test.ts`, remove/adjust the case at 71-77 that asserts the `analyzer.ollama.keepAlive` knob exists with default `'5m'`. If it's a standalone `it(...)`, delete it; if it's an assertion inside a broader "these knobs exist" test, remove just that line.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/config/registry.test.ts`
Expected: FAIL only if you left an assertion referencing the knob; otherwise proceed — the removal in Step 3 is what this test now guards against regressions of.

- [ ] **Step 3: Remove the knob + mock mirror**

In `registry.ts`, delete the whole knob object at 1088-1096 (`key: 'analyzer.ollama.keepAlive'`). In `src/lib/api.ts`, delete the mirrored descriptor at ~8956 (same key).

- [ ] **Step 4: Regenerate `.env.example`**

Run: `npm run config:sync`
Then verify: `git diff --stat server/.env.example` shows the `ANALYZER_KEEP_ALIVE` block removed.

- [ ] **Step 5: Verify the config gate is green**

Run: `npm run config:check`
Expected: PASS (no drift). Then `cd server && npx vitest run src/config/registry.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts src/lib/api.ts server/.env.example
git commit -m "chore(server): retire analyzer.ollama.keepAlive knob (superseded by per-model map)"
```

---

### Task 5: Expose resolved keep-alive on the inventory payload

**Files:**
- Modify: `server/src/routes/models-inventory.ts` (interface 70-87, analyzer build 299-312)
- Modify: `src/lib/api.ts` (`ModelInventoryItem` mirror 5979-5994, mock inventory builder)
- Test: `server/src/routes/models-inventory.test.ts`

**Interfaces:**
- Consumes: `resolveKeepAliveSeconds`, `hasKeepAliveOverride` (Task 2).
- Produces: analyzer `ModelInventoryItem` carries `keepAliveSeconds?: number` and `keepAliveIsOverride?: boolean`.

- [ ] **Step 1: Write the failing test**

In `models-inventory.test.ts`: `buildModelInventory(deps)` is **synchronous** and takes injected deps via the file's existing `baseDeps(over)` helper (`~line 75`), invoked as `baseDeps({ ollama: { reachable, models: [{name,size}], resident } })`. Add the imports `_setUserSettingsCacheForTest, _resetUserSettingsCache, DEFAULT_USER_SETTINGS` from `../workspace/user-settings.js` (not currently imported here), then add:

```ts
afterEach(() => _resetUserSettingsCache()); // don't leak the seeded override into later cases

it('analyzer items carry resolved keepAliveSeconds and override flag', () => {
  _setUserSettingsCacheForTest({ analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 300 } });
  const res = buildModelInventory(
    baseDeps({
      ollama: {
        reachable: true,
        models: [{ name: 'qwen36-castwright:latest', size: 1 }, { name: 'qwen3.5:4b', size: 1 }],
        resident: [],
      },
    }),
  );
  const custom = res.items.find((i) => i.id === 'ollama:qwen36-castwright:latest');
  const supported = res.items.find((i) => i.id === 'ollama:qwen3.5:4b');
  expect(custom?.keepAliveSeconds).toBe(300);
  expect(custom?.keepAliveIsOverride).toBe(true);
  expect(supported?.keepAliveSeconds).toBe(300); // coded default
  expect(supported?.keepAliveIsOverride).toBe(false);
});
```

(Confirm the real `baseDeps` `ollama` shape and adjust field names if they differ.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/models-inventory.test.ts -t keepAliveSeconds`
Expected: FAIL (fields undefined).

- [ ] **Step 3: Add the fields to the interface (server)**

In `models-inventory.ts`, add to `ModelInventoryItem` (after `integrity?`):

```ts
  /* Analyzer-only: resolved per-model keep-alive (seconds) and whether the
     value is a user override (vs coded default). Absent for tts/asr rows. */
  keepAliveSeconds?: number;
  keepAliveIsOverride?: boolean;
```

- [ ] **Step 4: Populate them in the analyzer build**

In `models-inventory.ts`, import at top: `import { resolveKeepAliveSeconds, hasKeepAliveOverride } from '../analyzer/ollama.js';`. In the `for (const m of ollama.models)` push (299-312), add:

```ts
      keepAliveSeconds: resolveKeepAliveSeconds(m.name),
      keepAliveIsOverride: hasKeepAliveOverride(m.name),
```

- [ ] **Step 5: Mirror on the client type + mock**

In `src/lib/api.ts`, add the same two optional fields to the `ModelInventoryItem` interface (5979-5994). Find the mock inventory builder (the mock backing `getModelInventory`) and set `keepAliveSeconds`/`keepAliveIsOverride` on its analyzer rows (e.g. `300` / `false`) so mock-mode renders a value.

- [ ] **Step 6: Run to verify it passes + typecheck**

Run: `cd server && npx vitest run src/routes/models-inventory.test.ts -t keepAliveSeconds` → PASS
Run: `npm run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/models-inventory.ts server/src/routes/models-inventory.test.ts src/lib/api.ts
git commit -m "feat(server): expose resolved keepAliveSeconds on analyzer inventory items"
```

---

### Task 6: Client type surface for the settings patch

**Files:**
- Modify: `openapi.yaml` (`UserSettings` ~3031, `UserSettingsPatch` ~3277)
- Regenerated: `src/lib/api-types.ts` (via `npm run openapi:types`)
- Modify: `src/lib/api.ts` (`mockPutUserSettings` 6644-6680)
- Test: `src/lib/api.test.ts` (or the nearest mock-settings test)

- [ ] **Step 1: Write the failing mock round-trip test**

Add (adapt import paths to the mock-mode test that already exercises `putUserSettings`):

```ts
it('mockPutUserSettings persists analyzerKeepAliveByModel', async () => {
  const out = await api.putUserSettings({ analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 300 } });
  expect(out.analyzerKeepAliveByModel['qwen36-castwright:latest']).toBe(300);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/api.test.ts -t analyzerKeepAliveByModel`
Expected: FAIL (mock whitelist drops the field).

- [ ] **Step 3: Add the field to openapi + regenerate types**

In `openapi.yaml`, add to both the `UserSettings` and `UserSettingsPatch` schemas:

```yaml
        analyzerKeepAliveByModel:
          type: object
          additionalProperties:
            type: integer
          description: Per-model Ollama analyzer keep-alive in seconds (0 unload, -1 pin).
```

Run: `npm run openapi:types` (regenerates `src/lib/api-types.ts`; NOTE — there is no `--check` CI gate, so this manual regen is mandatory here).

- [ ] **Step 4: Add the field to the mock whitelist**

In `mockPutUserSettings` (`api.ts:6644`), add `analyzerKeepAliveByModel` to BOTH the destructure (6648-6660) and the `Object.entries({...})` block (6664-6676):

```ts
  const {
    displayName,
    // …existing fields…
    dualModelEnabled,
    analyzerKeepAliveByModel,
  } = patch;
  Object.assign(
    MOCK_USER_SETTINGS,
    Object.fromEntries(
      Object.entries({
        displayName,
        // …existing fields…
        dualModelEnabled,
        analyzerKeepAliveByModel,
      }).filter(([, v]) => v !== undefined),
    ),
  );
```

Ensure `MOCK_USER_SETTINGS` initializes `analyzerKeepAliveByModel: {}`.

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `npx vitest run src/lib/api.test.ts -t analyzerKeepAliveByModel` → PASS
Run: `npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): thread analyzerKeepAliveByModel through the settings PUT contract"
```

---

### Task 7: Per-model keep-alive control in the Model Manager

**Files:**
- Modify: `src/views/model-manager.tsx` (`ModelManagerView` ~73, `ModelRow` 458-590)
- Modify: `src/store/account-slice.ts` (already exposes `fetchAccountSettings`/`saveAccountSettings`)
- Test: `src/views/model-manager.test.tsx`

**Interfaces:**
- Consumes: `item.keepAliveSeconds`, `item.keepAliveIsOverride` (Task 5); the override map at `s.account.analyzerKeepAliveByModel` — the account slice is **flat** (`AccountState extends UserSettings`, `account-slice.ts:22`), there is **no** `s.account.settings` sub-object; `saveAccountSettings` (existing, `account-slice.ts:53`).

- [ ] **Step 1: Write the failing test**

The real harness in `model-manager.test.tsx` is: `vi.mock('../lib/api', …)` with `putUserSettings: vi.fn()` and `getModelInventory: vi.fn()` (spy via `vi.mocked(api.putUserSettings)` / `vi.mocked(api.getModelInventory)`), inline `configureStore` + `<Provider>` to render, and fixtures `SETTINGS_FIXTURE` / `INVENTORY`. Account state is preloaded **flat** via `preloadedState`. Add:

```tsx
it('renders the analyzer keep-alive and saves the full merged map on edit', async () => {
  vi.mocked(api.getModelInventory).mockResolvedValue({
    ts: 't', sidecarReachable: true,
    items: [{ ...ANALYZER_ITEM_FIXTURE, id: 'ollama:qwen36-castwright:latest',
              label: 'qwen36-castwright:latest', keepAliveSeconds: 0, keepAliveIsOverride: false }],
  });
  const putSpy = vi.mocked(api.putUserSettings).mockResolvedValue({} as never);

  const store = configureStore({
    reducer: rootReducer,
    // account is flat: AccountState extends UserSettings — seed an existing override
    preloadedState: { account: { ...ACCOUNT_DEFAULTS, analyzerKeepAliveByModel: { 'qwen3.5:4b': 120 } } },
  });
  render(<Provider store={store}><ModelManagerView /></Provider>);

  const field = await screen.findByTestId('keepalive-ollama:qwen36-castwright:latest');
  expect(field).toHaveValue(0);
  fireEvent.change(field, { target: { value: '300' } });
  fireEvent.blur(field);

  await waitFor(() =>
    expect(putSpy).toHaveBeenCalledWith({
      analyzerKeepAliveByModel: { 'qwen3.5:4b': 120, 'qwen36-castwright:latest': 300 },
    }),
  );
});
```

(Adapt `ANALYZER_ITEM_FIXTURE` / `ACCOUNT_DEFAULTS` / `rootReducer` to the file's actual fixture + store-setup names.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/views/model-manager.test.tsx -t keep-alive`
Expected: FAIL (no field).

- [ ] **Step 3: Load account settings into the view**

`model-manager.tsx` already imports `useAppDispatch` (line 13) — **add `useAppSelector`** to that import. In `ModelManagerView`, dispatch the fetch on mount and select the map from the **flat** account slice:

```tsx
const dispatch = useAppDispatch();
const keepAliveMap = useAppSelector((s) => s.account.analyzerKeepAliveByModel ?? {});
useEffect(() => { void dispatch(fetchAccountSettings()); }, [dispatch]);
```

Pass `keepAliveMap` down to `ModelInventory` → `ModelRow`. (`fetchAccountSettings` is imported from `../store/account-slice`.)

- [ ] **Step 4: Add the control to `ModelRow`**

For analyzer rows only, next to the `ModelControlPill` (552-560), add:

```tsx
{isAnalyzer && analyzerModel && (
  <label className="flex items-center gap-1 text-[11px] text-ink/60">
    keep-alive
    <input
      type="number"
      data-testid={`keepalive-${item.id}`}
      defaultValue={item.keepAliveSeconds ?? 0}
      onBlur={(e) => {
        const secs = Math.trunc(Number(e.currentTarget.value));
        if (!Number.isFinite(secs)) return;
        const next = { ...keepAliveMap, [analyzerModel]: secs };
        void dispatch(saveAccountSettings({ analyzerKeepAliveByModel: next })).then(onChanged);
      }}
      className="w-16 min-h-[44px] fine-pointer:min-h-0 rounded-md border border-ink/15 bg-white px-2 text-right text-ink"
      aria-label={`Keep-alive seconds for ${item.label}`}
    />
    s
    {item.keepAliveIsOverride && (
      <button
        type="button"
        data-testid={`keepalive-reset-${item.id}`}
        onClick={() => {
          const next = { ...keepAliveMap };
          delete next[analyzerModel];
          void dispatch(saveAccountSettings({ analyzerKeepAliveByModel: next })).then(onChanged);
        }}
        className="min-h-[44px] fine-pointer:min-h-0 text-ink/45 hover:text-ink"
        aria-label="Reset to default"
      >
        ↺
      </button>
    )}
  </label>
)}
```

Add a one-line helper under the row group: `0 = unload now · -1 = keep forever · RAM-heavy models unload on CPU regardless`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/views/model-manager.test.tsx`
Expected: PASS. Then `npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/model-manager.tsx src/views/model-manager.test.tsx
git commit -m "feat(frontend): per-model keep-alive control in the Model Manager"
```

---

### Task 8: Manual Load button honors the configured keep-alive

**Files:**
- Modify: `server/src/routes/ollama-health.ts` (`warmOllamaModel` ~409)
- Test: `server/src/routes/ollama-health.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `ollama-health.test.ts`:

```ts
it('warms with the model's configured keep-alive, not a hardcoded 5m', async () => {
  _setUserSettingsCacheForTest({
    ...DEFAULT_USER_SETTINGS,
    analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 1800 },
  });
  fetchMock.mockResolvedValue(okJson({}));
  await warmOllamaModel('qwen36-castwright:latest');
  const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
  expect(body.keep_alive).toBe(1800);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts -t "configured keep-alive"`
Expected: FAIL (`keep_alive` is `'5m'`).

- [ ] **Step 3: Read the configured value in the warm route**

In `ollama-health.ts`, import `resolveKeepAliveSeconds` from `../analyzer/ollama.js` and replace the hardcoded `keep_alive: '5m'` in `warmOllamaModel`'s `callOllamaGenerate` body (~409) with `keep_alive: resolveKeepAliveSeconds(model)`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ollama-health.ts server/src/routes/ollama-health.test.ts
git commit -m "feat(server): manual Ollama Load honors per-model keep-alive"
```

---

### Task 9: Docs — regression plan, local-llm sweep, release notes

**Files:**
- Create: `docs/features/<n>-per-model-keepalive.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/local-llm.md` (74-75, 280, 298)
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: Write the regression plan**

Copy `docs/features/TEMPLATE.md` → `docs/features/<n>-per-model-keepalive.md`, `status: active`. Document: the invariant (`keepAliveFor` = `override ?? default ?? 0`, integer seconds; RAM-heavy CPU clamp; persona fixed 300; `/load` honors the value), the Model Manager acceptance walkthrough (set `qwen36-castwright:latest` → 300, observe `ollama ps` countdown), and the fixture (`the-coalfall-commission.md`). Add its INDEX.md entry.

- [ ] **Step 2: Sweep `docs/local-llm.md`**

Replace the "add the tag to `RESIDENT_MODELS`" instructions (74-75, 280, 298) with "set the model's keep-alive (seconds) in the Model Manager." Verify: `git grep -n RESIDENT_MODELS -- docs/local-llm.md` → no matches.

- [ ] **Step 3: Release notes**

`docs/release-notes-next.md` (technical): "Per-model Ollama analyzer keep-alive (seconds) in the Model Manager; retired the hardcoded RESIDENT_MODELS allowlist and the `analyzer.ollama.keepAlive` knob (#NN)."
`RELEASE_NOTES.md` (brand voice, in-progress section): "Keep any analyzer model warm between chapters — set its keep-alive right in the Model Manager, no config file needed."

- [ ] **Step 4: Commit**

```bash
git add docs/features docs/local-llm.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(server): regression plan + local-llm sweep + release notes for per-model keep-alive"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` → PASS
- [ ] `cd server && npx vitest run src/analyzer/ollama.test.ts src/routes/models-inventory.test.ts src/routes/ollama-health.test.ts src/tts/prepare-persona-batch.test.ts src/config/registry.test.ts src/workspace/user-settings.test.ts` → PASS
- [ ] `npx vitest run src/views/model-manager.test.tsx src/lib/api.test.ts` → PASS
- [ ] `npm run config:check` → PASS (no `.env.example` drift)
- [ ] `git grep -n 'RESIDENT_MODELS\|resolveAnalyzerKeepAlive\|analyzer.ollama.keepAlive' -- server/src src` → only archived-doc matches, no live code
- [ ] `npm run verify:fast:branch` → PASS (only when no GPU generation is active — check `nvidia-smi`)
- [ ] Open the PR with `Closes #NN`; run the mandatory `code-review` gate before merge.
