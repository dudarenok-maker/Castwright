# OpenAI-compatible analyzer — Wave 3 (PRs 3c, 3d) plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P11) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 3 — Endpoints become selectable (PRs 3c and 3d)

> Written against `origin/main` 2b63b451 **plus** the contract's products of W1, W2, 3a and 3b. Every `file:line` into a file that an earlier PR edits is a 2b63b451 line: re-read it before editing (Global Constraints). Lines inside files that only exist after an earlier PR (`capacity.ts`, `openai-transport.ts`, `schema-adapters.ts`, `analyzer-endpoints.ts`, `registry-knob-read.guard.test.ts`) are located by symbol, not number.

**Consumed from earlier PRs (contract names; not re-declared here):**
- W1: `server/src/analyzer/runner/transport.ts` (`ChatTransport`, `TransportRequest`, `TransportResult`, `StructuredOutputMode`); `runner/parse.ts` (`stripThink`, `stripCodeFences`); `errors.ts` (`AnalysisAbortedError`, `AnalyzerUnreachableError`, `AnalyzerHttpError`); `FallbackAnalyzer` falls back on `AnalyzerUnreachableError`; `OllamaTransport`, `GeminiTransport`.
- W2: `server/src/analyzer/capacity.ts` (`EngineCapacity`, `resolveCapacity`, `TODAY_LOCAL_CAPACITY`); the capacity-typed signatures of `resolveStage1ChunkCharBudget`, `resolveStage2ChunkCharBudget`, `chapterChunkBudget`; `catalog/gemini-catalog.ts` (`listGeminiModels`, `GeminiModelInfo`).
- 3a: `server/src/analyzer/model-id.ts` and `src/lib/model-id.ts` (`AnalysisEngine`, `inferEngineFromModelId` / `engineForModelId`, `parseEndpointModelId`, `endpointModelId`); `ModelOption.engine: AnalysisEngine`; `AnalysisStreamSnapshot.engine?: AnalysisEngine`; `ANALYSIS_ENGINE_VALUES` and the two `openapi.yaml` `analysisEngine` enums still held at `local | gemini`.
- 3b: `server/src/workspace/analyzer-endpoints.ts` (`analyzerEndpointSchema`, `AnalyzerEndpoint`, `defaultGpuForBaseUrl`, `keyOriginMatches`, `resolveUnloadUrl`, `findEndpointReferences`); user-settings `analyzerEndpoints`, `analyzerEndpointKeys` (server-only), GET-only `analyzerEndpointKeyStatus`; `transports/openai-transport.ts` `OpenAITransport`; `transports/endpoint-runtime.ts` (`noteEndpointModelUsed`, `lastUsedModel`, `endpointSemaphore`); `OpenAIAnalyzer`; `runner/schema-adapters.ts` (`adaptSchemaForOllama|Gemini|OpenAI`, `AdaptedSchema`, `structuredOutputLabel`); knobs `analyzer.ollama.structuredOutput`, `analyzer.gemini.structuredOutput`; error classes `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`, `AnalyzerCapabilityRejectedError`; `classifyAnalysisFailure` mapping them to `analyzer-endpoint-missing`, `auth`, `analyzer-request-rejected`; routes + mocks for `createAnalyzerEndpoint`, `updateAnalyzerEndpoint`, `deleteAnalyzerEndpoint`, `putAnalyzerEndpointKey`; real-only `detectAnalyzerEndpointContext`.
- **Assumed 3b frontend client names** (operationId → same-named function): `api.createAnalyzerEndpoint(body: AnalyzerEndpoint)`, `api.updateAnalyzerEndpoint(endpointId, body)`, `api.deleteAnalyzerEndpoint(endpointId)`, `api.putAnalyzerEndpointKey(endpointId, key: string | null)`, each resolving to the `UserSettings` GET shape; `detectAnalyzerEndpointContext({ baseUrl, endpointId?, model? })` exported from `src/lib/api.ts`, resolving to `{ contextTokens: number | null }`. If 3b shipped other names or shapes, rename at the 3d call sites only.

**Commands** (from the worktree root; never `cd`):
- one server test file: `npm --prefix server run test -- src/<path>.test.ts`
- one frontend test file: `npx vitest run src/<path>.test.tsx`
- one e2e spec: `npx playwright test --project=chromium e2e/<file>.spec.ts`
- no file edited in this wave is in `server/vitest.config.slow.ts` `SLOW_FILES` (lines 45-57).

---

### PR 3c — Catalogs, per-model rate limits, endpoint capacity, the Test action, pre-run checks

**Branch:** `feat/server,openapi-3084-w3c-catalog-test` — `node scripts/wt-new.mjs feat/server,openapi-3084-w3c-catalog-test` off the latest `main`.

**Delivers:**
- `GET /api/analyzer/models` (grouped live catalogs for Ollama, Gemini and every saved endpoint, 30 s cache, `refresh=1`, served limits, Test record, structured-output label) and `POST /api/analyzer/models/preview` (list an unsaved endpoint's models for the add form's context prefill).
- `modelLabel(id, catalog?)` replacing all nine `MODEL_OPTIONS.find(...)?.label ?? id`-shaped sites.
- Engine-aware exported `resolveLimits`, the `analyzerRateLimitsByModel` user-settings map, the retirement of the six `rate.*.gemma*` knobs (with a data migration), and a per-model limits editor in Advanced Settings.
- `resolveCapacity`'s endpoint branch and the per-request cap on context-family budgets.
- `POST /api/analyzer/models/test` + `server/src/analyzer/capabilities.ts`, persisted `analyzerCapabilitiesByModel`, a Test button with request-count confirmation that passes through the forward GPU guard.
- `server/src/analyzer/preflight.ts` wired before the first analyzer call of the analysis (main + subset), script-review, annotate-emotion and instruct-annotation routes.

**Must NOT change:**
- No picker, settings default or env path selects an endpoint model: `selectAnalyzer` keeps 3a's refusal for `openai`, the six picker-group builder sites keep `buildModelOptionGroups`, `ANALYSIS_ENGINE_VALUES` stays `local | gemini`.
- No eviction, in-flight accounting, `FallbackAnalyzer` or reverse-guard change.
- No `local` / `gemini` chunk budget changes: W2's pinning test stays byte-identical.

**Entry criteria:** 3b merged. PR #3163 (#3139) and PR #3201 (#3200) merged. Check: `server/src/config/registry-knob-read.guard.test.ts` exists on `main`, and `git grep -n "analyzer.engine'" -- server/src src` prints nothing. Task 3c.1 is written against #3163's diff as of 2026-09-11 (open, unmerged then); if its merged shape differs, apply the same intent to the merged code and note the difference in the PR body.

**Exit criteria:** every task's tests green; `npm run typecheck`, `npm run config:check`, `npm run check:cycles` and `npm run verify:fast:branch` green; one on-box register row recorded; `pr-review-gate` pass at depth `high` (multi-scope PR) folded.

---

### Task 3c.1: Engine-aware `resolveLimits`, the `analyzerRateLimitsByModel` map, retire the `rate.*.gemma*` knobs

**Files:**
- Modify: `server/src/analyzer/rate-limit.ts:22-84` — remove #3163's `allKnobs`/`resolveKnob` imports, `overrideValue` and `tpmLimit`; in `resolveLimits` (exported by W2 Task 2.3; its first statement is 3b Task 3b.10's `if (inferEngineFromModelId(model) === 'openai') return UNLIMITED;`) insert the settings-map read **ahead of** that early return. `analyzerRateLimiter` and the endpoint-unlimited default already exist (3b) and are not re-added.
- Modify: `server/src/workspace/user-settings.ts:69-95` (add a sibling migration after it), `:253` (schema field), `:334` (default), `:369` (migration hook)
- Modify: `server/src/config/registry.ts:13` (group label/help), `:1015-1075` (delete the rate-limits section and its six knobs)
- Modify: `server/src/config/registry-knob-read.guard.test.ts` (#3163) — the `rate.*` entry of `DECLARED_DYNAMIC_READERS` and the header's DYNAMIC READERS paragraph
- Modify: `server/src/force-rerun-triggers.test.ts` (#3163's `MAIN_COVERED` entry for `src/analyzer/rate-limit.ts`), `server/vitest.config.ts` (#3163's `rate-limit.ts` `forceRerunTriggers` line and the sentence of its comment that names it)
- Modify: `server/src/config/direct-env-reader-guard.test.ts:63-68` (comment that cites the retired registry defaults)
- Modify: `server/.env.example:80-98` (hand-written block, outside the managed block); the managed block at `:497-743` is regenerated by `npm run config:sync`
- Test: `server/src/analyzer/rate-limit.test.ts` (replace #3163's `describe('saved rate-limit overrides in user settings', …)`), Create `server/src/workspace/user-settings.rate-limits.test.ts`

**Interfaces:**
- Consumes: `inferEngineFromModelId` (3a), `getCachedUserSettings`, `_setUserSettingsCacheForTest`, `_resetUserSettingsCache` (`user-settings.ts:385`, `:946`, `:928`).
- Consumes also: W2's exported `resolveLimits(model: string): ModelLimits`; 3b's endpoint early return and `UNLIMITED` constant in it; 3b's `findEndpointReferences` classification guard in `server/src/workspace/analyzer-endpoints.test.ts` (its `FIELD_EXCLUDED` set).
- Produces: `resolveLimits` reads the map (signature unchanged); user-settings field `analyzerRateLimitsByModel: Record<string, { rpm?: number; tpm?: number; rpd?: number }>`; `export function migrateLegacyRateLimitOverrides(raw: unknown): unknown`.
- Also modify: `server/src/workspace/analyzer-endpoints.test.ts` (3b) — add `'analyzerRateLimitsByModel', // map keyed by model id, not a selection` to `FIELD_EXCLUDED`; the guard's `/model/i` filter matches the new field.

Keeps green (could break): the rest of `rate-limit.test.ts`, `server/src/config/registry.test.ts` (group list at `:6-21` is unchanged — the `rate-limits` group stays), `registry-knob-read.guard.test.ts`, `direct-env-reader-guard.test.ts`, `force-rerun-triggers.test.ts`, `output-heavy-tpm.test.ts`, `workspace/user-settings.test.ts`, `routes/config.test.ts`, `npm run config:check`.

- [ ] **Step 1: Write the failing tests**

In `server/src/analyzer/rate-limit.test.ts`, change the import at `:7` and replace #3163's whole `describe('saved rate-limit overrides in user settings', …)` block (and its now-unused `node:fs`/`node:os`/`node:path` imports) with:

```ts
import {
  GeminiRateLimiter,
  DailyQuotaExhaustedError,
  computeTpmWait,
  resolveLimits,
} from './rate-limit.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

describe('analyzerRateLimitsByModel (#3084 — replaces the rate.*.gemma* knobs)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetUserSettingsCache();
    delete process.env.GEMINI_RPM_GEMMA_4_31B_IT;
    delete process.env.GEMINI_TPM_GEMMA_4_31B_IT;
    delete process.env.GEMINI_RPM_OPENAI_LAB_QWEN3_30B;
  });

  it('resolveLimits reads a saved Gemini rpm from the user-settings map', () => {
    _setUserSettingsCacheForTest({ analyzerRateLimitsByModel: { 'gemma-4-31b-it': { rpm: 2 } } });
    expect(resolveLimits('gemma-4-31b-it')).toEqual({ rpm: 2, tpm: 16_000, rpd: 14_400 });
  });

  it('the limiter enforces the saved rpm: the third acquire in a minute waits on rpm', async () => {
    _setUserSettingsCacheForTest({ analyzerRateLimitsByModel: { 'gemma-4-31b-it': { rpm: 2 } } });
    const limiter = new GeminiRateLimiter();
    const onWait = vi.fn();
    await limiter.acquire('gemma-4-31b-it', 900, { onWait });
    await limiter.acquire('gemma-4-31b-it', 900, { onWait });
    const pending = limiter.acquire('gemma-4-31b-it', 900, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls[0][1]).toBe('rpm');
    await vi.advanceTimersByTimeAsync((onWait.mock.calls[0][0] as number) + 1);
    await pending;
  });

  it('env still beats the saved map', () => {
    process.env.GEMINI_RPM_GEMMA_4_31B_IT = '30';
    _setUserSettingsCacheForTest({ analyzerRateLimitsByModel: { 'gemma-4-31b-it': { rpm: 2 } } });
    expect(resolveLimits('gemma-4-31b-it').rpm).toBe(30);
  });

  it('a saved tpm of 0 means unlimited', async () => {
    _setUserSettingsCacheForTest({ analyzerRateLimitsByModel: { 'gemma-4-31b-it': { tpm: 0 } } });
    expect(resolveLimits('gemma-4-31b-it').tpm).toBe(Infinity);
    await expect(new GeminiRateLimiter().acquire('gemma-4-31b-it', 50_000)).resolves.toBeUndefined();
  });

  it('endpoint ids are unlimited until a field is saved, then honour exactly that field', () => {
    const id = 'openai:lab::qwen3-30b';
    _setUserSettingsCacheForTest({ analyzerRateLimitsByModel: {} });
    expect(resolveLimits(id)).toEqual({ rpm: Infinity, tpm: Infinity, rpd: Infinity });
    _setUserSettingsCacheForTest({ analyzerRateLimitsByModel: { [id]: { rpm: 4 } } });
    expect(resolveLimits(id)).toEqual({ rpm: 4, tpm: Infinity, rpd: Infinity });
  });

  it('the limiter enforces a saved endpoint rpm (the map is read ahead of the unlimited early return)', async () => {
    _setUserSettingsCacheForTest({ analyzerRateLimitsByModel: { 'openai:lab::qwen3-30b': { rpm: 1 } } });
    const limiter = new GeminiRateLimiter();
    const onWait = vi.fn();
    await limiter.acquire('openai:lab::qwen3-30b', 10, { onWait });
    const pending = limiter.acquire('openai:lab::qwen3-30b', 10, { onWait });
    await vi.advanceTimersByTimeAsync(10);
    expect(onWait.mock.calls[0]?.[1]).toBe('rpm');
    await vi.advanceTimersByTimeAsync((onWait.mock.calls[0][0] as number) + 1);
    await pending;
  });

  /* Infinity tolerance, the analyzerRateLimiter alias and "GEMINI_* env cannot throttle
     an endpoint" are pinned by 3b's rate-limit.endpoint.test.ts and stay green here. */
});
```

Create `server/src/workspace/user-settings.rate-limits.test.ts`:

```ts
/* #3084 W3 — analyzerRateLimitsByModel persistence and the one-time migration of the
   retired rate.*.gemma* config overrides. Fresh module + temp settings file per test,
   the same isolation #3163's rate-limit test used. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freshSettingsModule(initial: unknown) {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), 'cw-ratemap-'));
  const file = join(dir, 'user-settings.json');
  process.env.USER_SETTINGS_FILE = file;
  writeFileSync(file, JSON.stringify(initial));
  const ws = await import('./user-settings.js');
  return { ws, file };
}

afterEach(() => {
  delete process.env.USER_SETTINGS_FILE;
});

describe('analyzerRateLimitsByModel persistence (#3084)', () => {
  it('migrates saved rate.*.gemma* config overrides into the map and strips them from disk', async () => {
    const { ws, file } = await freshSettingsModule({
      configOverrides: { 'rate.rpm.gemma': 12, 'rate.tpm.gemma26': 0, 'analyzer.ollama.numCtx': 16384 },
    });
    const s = await ws.readUserSettings();
    expect(s.analyzerRateLimitsByModel).toEqual({
      'gemma-4-31b-it': { rpm: 12 },
      'gemma-4-26b-a4b-it': { tpm: 0 },
    });
    expect(s.configOverrides).toEqual({ 'analyzer.ollama.numCtx': 16384 });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.configOverrides['rate.rpm.gemma']).toBeUndefined();
    expect(onDisk.analyzerRateLimitsByModel['gemma-4-31b-it']).toEqual({ rpm: 12 });
  });

  it('a value already in the map wins over a legacy override for the same field', async () => {
    const { ws } = await freshSettingsModule({
      configOverrides: { 'rate.rpm.gemma': 12 },
      analyzerRateLimitsByModel: { 'gemma-4-31b-it': { rpm: 3 } },
    });
    expect((await ws.readUserSettings()).analyzerRateLimitsByModel['gemma-4-31b-it']).toEqual({ rpm: 3 });
  });

  it('a malformed saved override is dropped without resetting any other setting (P8)', async () => {
    const { ws, file } = await freshSettingsModule({
      defaultAnalysisModel: 'mistral:7b',
      configOverrides: { 'rate.rpm.gemma': -3, 'rate.tpm.gemma': 'fast', 'rate.rpd.gemma': 2.5, 'rate.rpm.gemma26': 0, 'rate.tpm.gemma26': 0 },
    });
    const s = await ws.readUserSettings();
    expect(s.defaultAnalysisModel).toBe('mistral:7b');
    expect(s.analyzerRateLimitsByModel).toEqual({ 'gemma-4-26b-a4b-it': { tpm: 0 } });
    expect(s.configOverrides).toEqual({});
    expect(JSON.parse(readFileSync(file, 'utf8')).defaultAnalysisModel).toBe('mistral:7b');
  });

  it('never throws on a shape it does not recognise, and leaves it for the schema (P8)', async () => {
    const { ws } = await freshSettingsModule({});
    for (const raw of [null, 'x', 42, [], { configOverrides: 'x' }, { configOverrides: 7 }, { configOverrides: null }, { configOverrides: [] }]) {
      expect(ws.migrateLegacyRateLimitOverrides(raw)).toBe(raw);
    }
    const brokenMap = { configOverrides: { 'rate.rpm.gemma': 12 }, analyzerRateLimitsByModel: 'broken' };
    expect(ws.migrateLegacyRateLimitOverrides(brokenMap)).toEqual({ configOverrides: {}, analyzerRateLimitsByModel: 'broken' });
    const brokenEntry = { configOverrides: { 'rate.rpm.gemma': 12 }, analyzerRateLimitsByModel: { 'gemma-4-31b-it': 'broken' } };
    expect(ws.migrateLegacyRateLimitOverrides(brokenEntry)).toEqual({ configOverrides: {}, analyzerRateLimitsByModel: { 'gemma-4-31b-it': 'broken' } });
  });

  it('the general PUT replaces the whole map (a model omitted from the patch is removed)', async () => {
    const { ws } = await freshSettingsModule({});
    await ws.writeUserSettings({
      analyzerRateLimitsByModel: { 'gemini-3.6-flash': { rpm: 2 }, 'openai:lab::m': { rpd: 100 } },
    });
    const after = await ws.writeUserSettings({ analyzerRateLimitsByModel: { 'openai:lab::m': { rpd: 50 } } });
    expect(after.analyzerRateLimitsByModel).toEqual({ 'openai:lab::m': { rpd: 50 } });
  });

  it('rejects an rpm below 1 and unknown fields', async () => {
    const { ws } = await freshSettingsModule({});
    await expect(ws.writeUserSettings({ analyzerRateLimitsByModel: { m: { rpm: 0 } } })).rejects.toThrow();
    await expect(ws.writeUserSettings({ analyzerRateLimitsByModel: { m: { burst: 3 } } })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/rate-limit.test.ts src/workspace/user-settings.rate-limits.test.ts`
Expected: FAIL — `expected { rpm: 30, tpm: 16000, rpd: 14400 } to deeply equal { rpm: 2, tpm: 16000, rpd: 14400 }` (the map is not read yet), the saved-endpoint rpm case sees no `rpm` wait (3b's early return), and the persistence suite fails with `expected undefined to deeply equal { 'gemma-4-31b-it': … }`.

- [ ] **Step 3: Implement**

`server/src/analyzer/rate-limit.ts` — remove #3163's `import { allKnobs } from '../config/registry.js';`, `import { resolveKnob } from '../config/resolver.js';`, `overrideValue` and `tpmLimit`. Keep 3b's `import { inferEngineFromModelId } from './model-id.js';`, its `UNLIMITED` constant and W2's `export`. Add under the existing imports:

```ts
import { getCachedUserSettings } from '../workspace/user-settings.js';
```

Replace the body of `resolveLimits` (W2-exported; 3b's early return is its first statement today) with:

```ts
function savedPositive(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/* A saved tpm of 0 means "no per-minute gate", matching the retired rate.tpm.* knobs'
   help text and the env sentinel in readTpmEnv. */
function savedTpm(n: number | undefined): number | undefined {
  return n === 0 ? Infinity : savedPositive(n);
}

/** Limits for one analyzer model id. Gemini ids: env GEMINI_{RPM,TPM,RPD}_<slug> →
    Settings map → BUILTIN_LIMITS → FALLBACK_LIMITS. OpenAI-compatible endpoint ids
    (`openai:<endpointId>::<model>`): Settings map → unlimited; endpoints deliberately
    have no env override (spec non-goal). Read on every acquire, so a saved change is live. */
export function resolveLimits(modelId: string): ModelLimits {
  const entry = getCachedUserSettings().analyzerRateLimitsByModel[modelId];
  if (inferEngineFromModelId(modelId) === 'openai') {
    return {
      rpm: savedPositive(entry?.rpm) ?? Infinity,
      tpm: savedTpm(entry?.tpm) ?? Infinity,
      rpd: savedPositive(entry?.rpd) ?? Infinity,
    };
  }
  const base = BUILTIN_LIMITS[modelId] ?? FALLBACK_LIMITS;
  const slug = envSlug(modelId);
  return {
    rpm: readEnvNumber(`GEMINI_RPM_${slug}`) ?? savedPositive(entry?.rpm) ?? base.rpm,
    tpm: readTpmEnv(`GEMINI_TPM_${slug}`) ?? savedTpm(entry?.tpm) ?? base.tpm,
    rpd: readEnvNumber(`GEMINI_RPD_${slug}`) ?? savedPositive(entry?.rpd) ?? base.rpd,
  };
}
```

The endpoint branch above replaces 3b's `return UNLIMITED;` (delete that line and the now-unused `UNLIMITED` constant): an unset field still resolves to `Infinity`, which 3b's `rate-limit.endpoint.test.ts` proves the limiter tolerates (`Number.isFinite(limits.tpm)` skips the fail-fast at `:207`; `length < Infinity`, `sum <= Infinity` and `count >= Infinity` behave). `acquire` (`:203`) keeps calling `resolveLimits(model)`, so a saved change applies on the next acquire.

In `server/src/workspace/analyzer-endpoints.test.ts` (3b), add to `FIELD_EXCLUDED`:

```ts
      'analyzerRateLimitsByModel', // map keyed by model id, not a selection (#3084 PR 3c)
```

`server/src/workspace/user-settings.ts` — after `migrateLegacyEagerLoadFields` (`:95`):

```ts
/* #3084 — the six rate.{rpm,tpm,rpd}.gemma[26] registry knobs (#3139) were retired
   into analyzerRateLimitsByModel. Move any saved override into the map (a value the map
   already holds wins) and drop the dead configOverrides keys. No-op once none remain. */
const LEGACY_RATE_KNOBS: ReadonlyArray<{ key: string; model: string; field: 'rpm' | 'tpm' | 'rpd' }> = [
  { key: 'rate.rpm.gemma', model: 'gemma-4-31b-it', field: 'rpm' },
  { key: 'rate.tpm.gemma', model: 'gemma-4-31b-it', field: 'tpm' },
  { key: 'rate.rpd.gemma', model: 'gemma-4-31b-it', field: 'rpd' },
  { key: 'rate.rpm.gemma26', model: 'gemma-4-26b-a4b-it', field: 'rpm' },
  { key: 'rate.tpm.gemma26', model: 'gemma-4-26b-a4b-it', field: 'tpm' },
  { key: 'rate.rpd.gemma26', model: 'gemma-4-26b-a4b-it', field: 'rpd' },
];

/* The smallest value analyzerRateLimitsByModel's schema accepts per field. A saved
   override below it is dropped, never copied: copying it would make
   userSettingsSchema.safeParse fail, and readUserSettings (:375-376) would then
   reset EVERY saved setting to defaults (P8). */
const LEGACY_RATE_MIN: Readonly<Record<'rpm' | 'tpm' | 'rpd', number>> = { rpm: 1, tpm: 0, rpd: 1 };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Runs on every settings READ, before schema validation. It never throws. It copies a
    legacy value only when the map's own schema accepts it. It leaves any shape it does
    not recognise to the schema. */
export function migrateLegacyRateLimitOverrides(raw: unknown): unknown {
  if (!isPlainObject(raw) || !isPlainObject(raw.configOverrides)) return raw;
  const overrides = raw.configOverrides;
  if (!LEGACY_RATE_KNOBS.some((k) => Object.hasOwn(overrides, k.key))) return raw;
  const nextOverrides: Record<string, unknown> = { ...overrides };
  for (const { key } of LEGACY_RATE_KNOBS) delete nextOverrides[key];
  const existing = raw.analyzerRateLimitsByModel;
  if (existing !== undefined && !isPlainObject(existing)) {
    /* A malformed saved map is the schema's to judge: drop only the dead knob keys. */
    return { ...raw, configOverrides: nextOverrides };
  }
  const map: Record<string, unknown> = { ...(existing ?? {}) };
  for (const { key, model, field } of LEGACY_RATE_KNOBS) {
    const value = overrides[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < LEGACY_RATE_MIN[field]) continue;
    const current = map[model];
    if (current !== undefined && !isPlainObject(current)) continue;
    const entry: Record<string, unknown> = { ...(current ?? {}) };
    if (entry[field] === undefined) entry[field] = value;
    map[model] = entry;
  }
  return { ...raw, configOverrides: nextOverrides, analyzerRateLimitsByModel: map };
}
```

Schema, after `analyzerKeepAliveByModel` (`:253`):

```ts
  /* #3084 — per-model analyzer rate limits (Advanced → Analyzer rate limits). Sparse:
     model id (Gemini id or `openai:<endpointId>::<model>`) → any of rpm/tpm/rpd.
     Gemini ids: env → this map → built-in table; endpoint ids: this map → unlimited.
     `tpm: 0` = unlimited. The general PUT writes the whole map (NOT in FORBIDDEN_KEYS);
     resolveLimits reads it synchronously on every acquire. */
  analyzerRateLimitsByModel: z
    .record(
      z.string(),
      z
        .object({
          rpm: z.number().int().min(1).optional(),
          tpm: z.number().int().min(0).optional(),
          rpd: z.number().int().min(1).optional(),
        })
        .strict(),
    )
    .default({}),
```

Default, after `analyzerKeepAliveByModel: {},` (`:334`): `analyzerRateLimitsByModel: {},`

Hook (`:369`): `const migrated = migrateLegacyRateLimitOverrides(migrateLegacyEagerLoadFields(raw));`

`server/src/config/registry.ts` — `:13` becomes:

```ts
  { id: 'rate-limits', label: 'Analyzer rate limits', help: 'Per-model request/token/day caps for Gemini models and OpenAI-compatible endpoints. Edit them in the per-model table in this section; GEMINI_{RPM,TPM,RPD}_<slug> env vars still win for Gemini ids.', risk: 'low', collapsedByDefault: false },
```

Delete `:1015-1075` (the `// ── rate-limits ──` comment and all six knobs) plus the blank line before `// ── audio-loudness`.

`registry-knob-read.guard.test.ts` (#3163) — delete the second `DECLARED_DYNAMIC_READERS` entry (`pattern: /^rate\.(rpm|tpm|rpd)\.[a-zA-Z0-9]+$/`). Replace the header paragraph that begins `DYNAMIC READERS. Two knob families` with:

```ts
   DYNAMIC READERS. One knob family is read through a COMPUTED key, not a
   string literal, so the occurrence scan below is structurally blind to it:
     - `qa.asr.maxWer.<lang>` — `tts/segment-asr-qa.ts` builds
       `` `qa.asr.maxWer.${lang}` `` and looks it up via
       `allKnobs().find(...)` + `resolveKnob(...)`.
   The `DECLARED_DYNAMIC_READERS` entry is verified against the ACTUAL file
   content below (not just trusted), so a declaration that stops matching
   reality fails the same as a missing read. (`rate.{rpm,tpm,rpd}.<slug>` was a
   second family until #3084 retired those knobs into the
   `analyzerRateLimitsByModel` user-settings map, which is not a registry knob;
   `analyzer/rate-limit.test.ts` "resolveLimits reads a saved Gemini rpm from the
   user-settings map" pins that read instead.)
```

`KNOWN_UNREAD` is not edited: the removed knobs leave `allKnobs()`, so they cannot appear in the unread set.

`server/src/force-rerun-triggers.test.ts` — delete #3163's `{ rel: 'src/analyzer/rate-limit.ts', file: 'the rate-limit dynamic-reader lookup', base: SERVER_ROOT },` and change its comment to `/* #3139/#3146: registry-knob-read.guard.test.ts reads this file's source text at RUNTIME to verify its DECLARED_DYNAMIC_READERS claim — the same #1847 runtime-read trap as the entries above. */`.

`server/vitest.config.ts` — delete the `'{**/server/src/analyzer/rate-limit.ts,**/.*/**/server/src/analyzer/rate-limit.ts}',` line; in the comment above it, replace `Its two DECLARED_DYNAMIC_READERS target files are` with `Its DECLARED_DYNAMIC_READERS target file is`, `these files' source text` with `that file's source text`, and `(e.g. \`rate.*\`'s \`overrideValue\` lookup in rate-limit.ts, or \`qa.asr.maxWer.<lang>\`'s lookup in segment-asr-qa.ts)` with `(\`qa.asr.maxWer.<lang>\`'s lookup in segment-asr-qa.ts)`.

`server/src/config/direct-env-reader-guard.test.ts:64-68` — replace the parenthetical with:

```ts
       `rate-limit.ts`'s `` process.env[`GEMINI_RPM_${slug}`] `` (audited by
       hand: it substitutes nothing a registry knob declares — since #3084 the
       fall-through is the `analyzerRateLimitsByModel` settings map, then the
       `BUILTIN_LIMITS` table, neither of which is a registry default).
```

`server/.env.example:80-98` — replace the hand-written block (it sits above the managed `BEGIN` marker at `:497`) with:

```
# Per-model rate limits for the analyzer (Gemini models and OpenAI-compatible
# endpoints). The server tracks RPM (requests/minute), TPM (input tokens/minute)
# and RPD (requests/day) per model id and waits proactively when a cap would be
# breached — including during retries — so 429/500 storms from hitting limits
# don't happen.
# Resolution for a Gemini model id:
#   GEMINI_{RPM,TPM,RPD}_<slug> env -> Advanced Settings "Analyzer rate limits"
#   (user-settings analyzerRateLimitsByModel) -> built-in table -> 5 RPM /
#   100000 TPM / 50 RPD.
# OpenAI-compatible endpoint models (openai:<endpointId>::<model>) have no env
# override: Advanced Settings -> unlimited.
# Built-in defaults match Google's free-tier values (pulled from
# aistudio.google.com/app/rate-limit on 2026-05-16):
#   gemini-3.5-flash-lite:  15 RPM, 250000 TPM, 500 RPD
#   gemini-3.1-flash-lite:  15 RPM, 250000 TPM, 500 RPD
#   gemini-3.6-flash:        5 RPM, 250000 TPM,  20 RPD
#   gemini-3-flash-preview:  5 RPM, 250000 TPM,  20 RPD
#   gemini-2.5-flash:        5 RPM, 250000 TPM,  20 RPD
#   gemma-4-31b-it:         30 RPM,  16000 TPM, 14400 RPD
#   gemma-4-26b-a4b-it:     30 RPM,  16000 TPM, 14400 RPD
# <slug> is the model id uppercased with non-alphanumeric runs replaced by `_`.
# Example:
#   GEMINI_RPM_GEMINI_3_1_FLASH_LITE=20
#   GEMINI_TPM_GEMINI_3_1_FLASH_LITE=400000
#   GEMINI_RPD_GEMINI_3_1_FLASH_LITE=1000
#   GEMINI_TPM_GEMMA_4_31B_IT=0
# Set TPM to `0` or `unlimited` for no per-minute token cap.
```

Then run `npm run config:sync` (removes the `# ── Gemini rate limits ──` section from the managed block) and `npm run config:check`.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/rate-limit.test.ts src/analyzer/rate-limit.endpoint.test.ts src/workspace/user-settings.rate-limits.test.ts src/workspace/analyzer-endpoints.test.ts src/config/registry.test.ts src/config/registry-knob-read.guard.test.ts src/config/direct-env-reader-guard.test.ts src/force-rerun-triggers.test.ts src/analyzer/output-heavy-tpm.test.ts src/workspace/user-settings.test.ts` then `npm run config:check`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `rate-limit.ts` Gemini branch: delete `?? savedPositive(entry?.rpm)` → red: "resolveLimits reads a saved Gemini rpm from the user-settings map", "the limiter enforces the saved rpm…". Restore.
2. `rate-limit.ts`: put 3b's `if (inferEngineFromModelId(modelId) === 'openai') return UNLIMITED;` back as the first statement (the map read no longer comes first) → red: "endpoint ids are unlimited until a field is saved, then honour exactly that field", "the limiter enforces a saved endpoint rpm…". Restore.
3. `user-settings.ts:369`: revert to `migrateLegacyEagerLoadFields(raw)` → red: "migrates saved rate.*.gemma* config overrides…". Restore.
4. `migrateLegacyRateLimitOverrides`: delete `|| value < LEGACY_RATE_MIN[field]` → red: "a malformed saved override is dropped without resetting any other setting (P8)". The saved `rpm: -3` reaches the map, the schema rejects it, and `defaultAnalysisModel` falls back to its default. Restore.
5. `migrateLegacyRateLimitOverrides`: replace `if (current !== undefined && !isPlainObject(current)) continue;` with nothing → red: "never throws on a shape it does not recognise…" (the broken entry `'broken'` is spread into `{0:'b',…}`). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/rate-limit.ts server/src/analyzer/rate-limit.test.ts server/src/workspace/user-settings.ts server/src/workspace/user-settings.rate-limits.test.ts server/src/workspace/analyzer-endpoints.test.ts server/src/config/registry.ts server/src/config/registry-knob-read.guard.test.ts server/src/config/direct-env-reader-guard.test.ts server/src/force-rerun-triggers.test.ts server/vitest.config.ts server/.env.example
git commit -m "feat(server): per-model analyzer rate limits replace the gemma rate knobs"
```

---

### Task 3c.2: `analyzerRateLimitsByModel` on the wire and in mock mode

**Files:**
- Modify: `openapi.yaml` — new schema immediately before `    UserSettingsPatch:` (`:4809`); property after `analyzerKeepAliveByModel` in `UserSettings` (`:4758-4762`) and in `UserSettingsPatch` (`:4865-4869`)
- Modify (generated): `src/lib/api-types.ts` via `npm run openapi:types`
- Modify: `src/lib/api.ts:6939` (`MOCK_USER_SETTINGS`), `:7312-7342` (`mockPutUserSettings` whitelist, both blocks)
- Test: `src/lib/api-put-user-settings-mock.test.ts`

**Interfaces:**
- Consumes: Task 3c.1's field shape.
- Produces: generated `components['schemas']['AnalyzerModelRateLimits']`; `UserSettings['analyzerRateLimitsByModel']` on the frontend.

Keeps green: `src/lib/api-put-user-settings-mock.test.ts`, `src/lib/api-types.test.ts`, `npm run typecheck`.

- [ ] **Step 1: Write the failing test** — append to `src/lib/api-put-user-settings-mock.test.ts`:

```ts
describe('mockPutUserSettings — analyzerRateLimitsByModel (#3084)', () => {
  it('persists the whole map', async () => {
    const out = await api.putUserSettings({
      analyzerRateLimitsByModel: { 'gemini-3.6-flash': { rpm: 2, rpd: 10 } },
    });
    expect(out.analyzerRateLimitsByModel).toEqual({ 'gemini-3.6-flash': { rpm: 2, rpd: 10 } });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npx vitest run src/lib/api-put-user-settings-mock.test.ts`  Expected: FAIL — `expected undefined to deeply equal { 'gemini-3.6-flash': { rpm: 2, rpd: 10 } }`.

- [ ] **Step 3: Implement**

`openapi.yaml`, before `    UserSettingsPatch:`:

```yaml
    AnalyzerModelRateLimits:
      type: object
      additionalProperties: false
      description: |
        #3084 — one model's saved analyzer rate limits. Absent fields fall through:
        Gemini ids env GEMINI_{RPM,TPM,RPD}_<slug> → this entry → built-in table;
        endpoint ids this entry → unlimited. `tpm: 0` means unlimited.
      properties:
        rpm: { type: integer, minimum: 1 }
        tpm: { type: integer, minimum: 0 }
        rpd: { type: integer, minimum: 1 }

```

In both `UserSettings` and `UserSettingsPatch`, after the `analyzerKeepAliveByModel` property:

```yaml
        analyzerRateLimitsByModel:
          type: object
          additionalProperties:
            $ref: '#/components/schemas/AnalyzerModelRateLimits'
          description: |
            #3084 — per-model analyzer rate limits keyed by model id (a Gemini id or
            `openai:<endpointId>::<model>`). PUT replaces the whole map.
```

Run `npm run openapi:types`.

`src/lib/api.ts:6939` — after `analyzerKeepAliveByModel: {},` add `analyzerRateLimitsByModel: {},`.
`src/lib/api.ts:7312-7342` — add `analyzerRateLimitsByModel,` after `analyzerKeepAliveByModel,` in the destructure (`:7324`) and in the `Object.entries({ … })` literal (`:7341`).

- [ ] **Step 4: Run and confirm it passes**  Run: `npx vitest run src/lib/api-put-user-settings-mock.test.ts src/lib/api-types.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof** — remove `analyzerRateLimitsByModel,` from the `Object.entries` literal only → red: "persists the whole map". Restore.

- [ ] **Step 6: Commit**
```bash
git add openapi.yaml src/lib/api-types.ts src/lib/api.ts src/lib/api-put-user-settings-mock.test.ts
git commit -m "feat(openapi,frontend): expose analyzerRateLimitsByModel on user settings"
```

---

### Task 3c.3: `capabilities.ts` — records, pre-run assertion, request plan, probe schema; `analyzerCapabilitiesByModel` storage

**Files:**
- Create: `server/src/analyzer/capabilities.ts`
- Create: `server/src/analyzer/__fixtures__/structured-output-label-cases.json`
- Modify: `server/src/workspace/user-settings.ts` — record schema above `userSettingsSchema` (`:111`), field after the Task 3c.1 field, default after `analyzerRateLimitsByModel: {},`, `FORBIDDEN_KEYS` (`:450-467`), writer after `writeGeminiApiKey` (`:809-820`)
- Test: `server/src/analyzer/capabilities.test.ts`, `server/src/analyzer/structured-output-label-cases.test.ts`

**Interfaces:**
- Consumes: `StructuredOutputMode`, `ChatTransport` (W1); `stripThink`, `stripCodeFences` (W1 `runner/parse.ts`); `AnalyzerCapabilityRejectedError` (3b); `structuredOutputLabel`, `AdaptedSchema` (3b); the eight grammar schemas the stage table sends (`server/src/handoff/schemas.ts`: `stage1GrammarSchema` `:246`, `stage1ChapterGrammarSchema` `:239`, `stage2ChapterSchema` `:167`, `emotionAnnotationSchema` `:174`, `nonStoryClassificationSchema` `:190`, `scriptReviewSchema` `:265`, `stage3ChapterSchema` `:332`, `escalationSchema` `:359`).
- Produces (contract names): `ProbeOutcome`, `ModelCapabilityRecord`, `capabilityRecordFor`, `assertConfiguredCapabilitiesAllowed`, `plannedTestRequestCount`, `ModelTestDeps`; plus `CONFIGURED_LEVEL_KEY`, `ALL_STRUCTURED_OUTPUT_MODES`, `STAGE_GRAMMAR_SCHEMAS`, `draft07`, `largestStageSchema`, `MARKER_KEY`, `newMarkerValue`, `withMarker`, `classifyMarkerProbe`; user-settings `analyzerCapabilitiesByModel`, `modelCapabilityRecordSchema`, `writeAnalyzerCapabilityRecord(modelId, record)`.
- Contract deviation (reported): the contract types `reasoning` keys and `configured.reasoning` as `ReasoningLevel`, which is born in W5. W3 uses `string`; W5 narrows.

Keeps green: `workspace/user-settings.test.ts`, `routes/user-settings.test.ts`.

- [ ] **Step 1: Write the failing tests**

Create `server/src/analyzer/__fixtures__/structured-output-label-cases.json` with inputs only — the `expected` column is captured in Step 3 from 3b's function, never typed by hand:

```json
[
  { "mode": "schema", "dropped": [], "outcome": null },
  { "mode": "schema", "dropped": ["$schema"], "outcome": null },
  { "mode": "schema", "dropped": ["$schema", "properties.name.minLength"], "outcome": null },
  { "mode": "schema", "dropped": [], "outcome": "enforced" },
  { "mode": "schema", "dropped": [], "outcome": "ignored" },
  { "mode": "schema", "dropped": ["properties.name.minLength"], "outcome": "ignored" },
  { "mode": "schema", "dropped": [], "outcome": "rejected" },
  { "mode": "json", "dropped": [], "outcome": null },
  { "mode": "off", "dropped": [], "outcome": null }
]
```

Create `server/src/analyzer/structured-output-label-cases.test.ts`:

```ts
/* #3084 — one case table for structuredOutputLabel, shared with the frontend twin
   (src/lib/structured-output-label.ts, Task 3c.6). `expected` is captured from 3b's
   server function with CAPTURE_LABELS=1, never written by hand. */
import { describe, it, expect } from 'vitest';
import cases from './__fixtures__/structured-output-label-cases.json' with { type: 'json' };
import { structuredOutputLabel } from './runner/schema-adapters.js';
import type { ModelCapabilityRecord } from './capabilities.js';
import type { StructuredOutputMode } from './runner/transport.js';

type LabelCase = {
  mode: StructuredOutputMode;
  dropped: string[];
  outcome: 'enforced' | 'ignored' | 'rejected' | null;
  expected?: string;
};

function recordFor(c: LabelCase): ModelCapabilityRecord | undefined {
  if (c.outcome === null) return undefined;
  return {
    serverUrl: 'http://127.0.0.1:8080/v1',
    testedAt: '2026-09-11T00:00:00.000Z',
    control: { ok: true },
    structuredOutput: { [c.mode]: { configured: c.outcome } },
    reasoning: {},
  };
}

describe('structuredOutputLabel case table (#3084)', () => {
  it.runIf(process.env.CAPTURE_LABELS === '1')('prints the expected column (capture only)', () => {
    const out = (cases as LabelCase[]).map(({ expected: _e, ...c }) => ({
      ...c,
      expected: structuredOutputLabel(c.mode, c.dropped, recordFor(c), 'configured'),
    }));
    console.log(JSON.stringify(out, null, 2));
  });

  it.each(cases as LabelCase[])('$mode dropped=$dropped outcome=$outcome', (c) => {
    expect(c.expected, 'run the capture step and paste the expected column').toBeTypeOf('string');
    expect(structuredOutputLabel(c.mode, c.dropped, recordFor(c), 'configured')).toBe(c.expected);
  });
});
```

Create `server/src/analyzer/capabilities.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  STAGE_GRAMMAR_SCHEMAS,
  draft07,
  largestStageSchema,
  withMarker,
  MARKER_KEY,
  classifyMarkerProbe,
  capabilityRecordFor,
  assertConfiguredCapabilitiesAllowed,
  plannedTestRequestCount,
  ALL_STRUCTURED_OUTPUT_MODES,
  CONFIGURED_LEVEL_KEY,
  type ModelCapabilityRecord,
} from './capabilities.js';
import { AnalyzerCapabilityRejectedError } from './errors.js';
import { DEFAULT_USER_SETTINGS } from '../workspace/user-settings.js';

const record = (over: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord => ({
  serverUrl: 'http://127.0.0.1:8080/v1',
  testedAt: '2026-09-11T10:00:00.000Z',
  control: { ok: true },
  structuredOutput: { schema: { configured: 'rejected' } },
  reasoning: {},
  ...over,
});

describe('probe schema', () => {
  it('largestStageSchema is the stage grammar with the longest serialised draft-07 JSON', () => {
    const sizes = STAGE_GRAMMAR_SCHEMAS.map(({ name, schema }) => ({
      name,
      chars: JSON.stringify(draft07(schema)).length,
    }));
    console.info('[capabilities] stage schema sizes', JSON.stringify(sizes)); // paste into the PR body
    const max = sizes.reduce((a, b) => (b.chars > a.chars ? b : a));
    expect(largestStageSchema().name).toBe(max.name);
    expect(JSON.stringify(largestStageSchema().schema).length).toBe(max.chars);
  });

  it('covers exactly the eight grammar schemas the stage runner sends', () => {
    expect(STAGE_GRAMMAR_SCHEMAS.map((s) => s.name).sort()).toEqual([
      'emotionAnnotationSchema',
      'escalationSchema',
      'nonStoryClassificationSchema',
      'scriptReviewSchema',
      'stage1ChapterGrammarSchema',
      'stage1GrammarSchema',
      'stage2ChapterSchema',
      'stage3ChapterSchema',
    ]);
  });

  it('withMarker adds one required single-value enum property and leaves the rest intact', () => {
    const base = draft07(z.object({ a: z.string() }));
    const out = withMarker(base, 'mk-abc');
    const props = out.properties as Record<string, unknown>;
    expect(props[MARKER_KEY]).toEqual({ type: 'string', enum: ['mk-abc'] });
    expect(out.required).toEqual(['a', MARKER_KEY]);
    expect(props.a).toEqual((base.properties as Record<string, unknown>).a);
  });

  it('classifyMarkerProbe: enforced only when the marker key carries the exact value', () => {
    expect(classifyMarkerProbe(`{"${MARKER_KEY}":"mk-1","characters":[]}`, 'mk-1')).toBe('enforced');
    expect(classifyMarkerProbe(`<think>hm</think>\n\`\`\`json\n{"${MARKER_KEY}":"mk-1"}\n\`\`\``, 'mk-1')).toBe('enforced');
    expect(classifyMarkerProbe('{"characters":[]}', 'mk-1')).toBe('ignored');
    expect(classifyMarkerProbe(`{"${MARKER_KEY}":"mk-2"}`, 'mk-1')).toBe('ignored');
    expect(classifyMarkerProbe('not json', 'mk-1')).toBe('ignored');
  });
});

describe('capabilityRecordFor', () => {
  it('returns the record while the server URL matches (trailing slash tolerated)', () => {
    const settings = { ...DEFAULT_USER_SETTINGS, analyzerCapabilitiesByModel: { 'openai:lab::m': record() } };
    expect(capabilityRecordFor(settings, 'openai:lab::m', 'http://127.0.0.1:8080/v1/')).toEqual(record());
  });

  it('discards the record after the base URL changes', () => {
    const settings = { ...DEFAULT_USER_SETTINGS, analyzerCapabilitiesByModel: { 'openai:lab::m': record() } };
    expect(capabilityRecordFor(settings, 'openai:lab::m', 'http://10.0.0.5:8080/v1')).toBeUndefined();
  });
});

describe('assertConfiguredCapabilitiesAllowed', () => {
  it('throws AnalyzerCapabilityRejectedError naming the setting and test date for a rejected configured mode', () => {
    let caught: unknown;
    try {
      assertConfiguredCapabilitiesAllowed(record(), { structuredOutput: 'schema', reasoning: undefined }, 'openai:lab::m');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnalyzerCapabilityRejectedError);
    expect(caught).toMatchObject({
      modelId: 'openai:lab::m',
      setting: 'structuredOutput',
      value: 'schema',
      testedAt: '2026-09-11T10:00:00.000Z',
    });
  });

  it('allows a mode the record did not reject, a missing record, and a record whose control failed', () => {
    expect(() => assertConfiguredCapabilitiesAllowed(record(), { structuredOutput: 'json', reasoning: undefined }, 'm')).not.toThrow();
    expect(() => assertConfiguredCapabilitiesAllowed(undefined, { structuredOutput: 'schema', reasoning: undefined }, 'm')).not.toThrow();
    expect(() =>
      assertConfiguredCapabilitiesAllowed(
        record({ control: { ok: false, error: 'boom' } }),
        { structuredOutput: 'schema', reasoning: undefined },
        'm',
      ),
    ).not.toThrow();
  });

  it('throws for a rejected configured reasoning level', () => {
    expect(() =>
      assertConfiguredCapabilitiesAllowed(
        record({ structuredOutput: {}, reasoning: { high: 'rejected' } }),
        { structuredOutput: 'schema', reasoning: 'high' },
        'm',
      ),
    ).toThrow(AnalyzerCapabilityRejectedError);
  });
});

describe('plannedTestRequestCount', () => {
  const deps = { configuredMode: 'schema' as const, offeredModes: ALL_STRUCTURED_OUTPUT_MODES, offeredLevels: [CONFIGURED_LEVEL_KEY] };
  it('configured = control + one check; all = control + the schema and json checks (the off check reuses the off-mode control)', () => {
    expect(plannedTestRequestCount({ modelId: 'm', scope: 'configured' }, deps)).toBe(2);
    expect(plannedTestRequestCount({ modelId: 'm', scope: 'all' }, deps)).toBe(3);
  });
  it('a configured off mode sends only the control request', () => {
    expect(plannedTestRequestCount({ modelId: 'm', scope: 'configured' }, { ...deps, configuredMode: 'off' })).toBe(1);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/capabilities.test.ts src/analyzer/structured-output-label-cases.test.ts`
Expected: FAIL — `Failed to load url ./capabilities.js` (module does not exist yet); the label table fails `run the capture step and paste the expected column`.

- [ ] **Step 3: Implement**

Create `server/src/analyzer/capabilities.ts`:

```ts
/* #3084 W3 — what a model accepts and enforces, recorded by the Test action (spec
   decision 2b) and checked before a run's first call. Pure helpers first; the request
   sequence (runModelTest) is appended by Task 3c.4. */
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { UserSettings } from '../workspace/user-settings.js';
import type { ChatTransport, StructuredOutputMode } from './runner/transport.js';
import type { AdaptedSchema } from './runner/schema-adapters.js';
import { stripCodeFences, stripThink } from './runner/parse.js';
import { AnalyzerCapabilityRejectedError } from './errors.js';
import {
  emotionAnnotationSchema,
  escalationSchema,
  nonStoryClassificationSchema,
  scriptReviewSchema,
  stage1ChapterGrammarSchema,
  stage1GrammarSchema,
  stage2ChapterSchema,
  stage3ChapterSchema,
} from '../handoff/schemas.js';

export type ProbeOutcome = 'enforced' | 'ignored' | 'rejected' | 'accepted';

export interface ModelCapabilityRecord {
  /** Endpoint baseUrl, Ollama URL, or 'gemini'. A record for another URL is discarded. */
  serverUrl: string;
  testedAt: string;
  control: { ok: true } | { ok: false; error: string };
  /** mode → reasoning-level key ('configured' in W3) → outcome. */
  structuredOutput: Partial<Record<StructuredOutputMode, Record<string, ProbeOutcome>>>;
  /** W5 narrows the key to ReasoningLevel; W3 records `{}`. */
  reasoning: Partial<Record<string, 'accepted' | 'rejected'>>;
}

export interface ModelTestDeps {
  transport: ChatTransport;
  serverUrl: string;
  configuredMode: StructuredOutputMode;
  offeredModes: readonly StructuredOutputMode[];
  /** W3: `[CONFIGURED_LEVEL_KEY]`. W5 adds the offered reasoning levels. */
  offeredLevels: readonly string[];
  adaptSchema: (draft07: Record<string, unknown>) => AdaptedSchema;
  now?: () => Date;
  markerValue?: () => string;
  redact?: (text: string) => string;
}

export const CONFIGURED_LEVEL_KEY = 'configured';
export const ALL_STRUCTURED_OUTPUT_MODES: readonly StructuredOutputMode[] = ['schema', 'json', 'off'];

export const STAGE_GRAMMAR_SCHEMAS: ReadonlyArray<{ name: string; schema: z.ZodType<unknown> }> = [
  { name: 'stage1GrammarSchema', schema: stage1GrammarSchema },
  { name: 'stage1ChapterGrammarSchema', schema: stage1ChapterGrammarSchema },
  { name: 'stage2ChapterSchema', schema: stage2ChapterSchema },
  { name: 'emotionAnnotationSchema', schema: emotionAnnotationSchema },
  { name: 'nonStoryClassificationSchema', schema: nonStoryClassificationSchema },
  { name: 'scriptReviewSchema', schema: scriptReviewSchema },
  { name: 'stage3ChapterSchema', schema: stage3ChapterSchema },
  { name: 'escalationSchema', schema: escalationSchema },
];

/** The exact conversion the stage runner uses (today `ollama.ts:504`). */
export function draft07(schema: z.ZodType<unknown>): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-07', reused: 'inline' }) as Record<string, unknown>;
}

/** The largest real stage schema by serialised length — measured at call time. */
export function largestStageSchema(): { name: string; schema: Record<string, unknown> } {
  let best = { name: STAGE_GRAMMAR_SCHEMAS[0].name, schema: draft07(STAGE_GRAMMAR_SCHEMAS[0].schema) };
  let bestChars = JSON.stringify(best.schema).length;
  for (const entry of STAGE_GRAMMAR_SCHEMAS.slice(1)) {
    const schema = draft07(entry.schema);
    const chars = JSON.stringify(schema).length;
    if (chars > bestChars) {
      best = { name: entry.name, schema };
      bestChars = chars;
    }
  }
  return best;
}

/** Required key the probe prompt never mentions: only an enforced schema produces it. */
export const MARKER_KEY = 'cw_probe_marker';

export function newMarkerValue(): string {
  return `mk-${randomBytes(6).toString('hex')}`;
}

export function withMarker(schema: Record<string, unknown>, marker: string): Record<string, unknown> {
  const properties = {
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
    [MARKER_KEY]: { type: 'string', enum: [marker] },
  };
  const required = [...((schema.required as string[] | undefined) ?? []), MARKER_KEY];
  return { ...schema, properties, required };
}

export function classifyMarkerProbe(text: string, marker: string): 'enforced' | 'ignored' {
  const candidate = stripCodeFences(stripThink(text).text).trim();
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>)[MARKER_KEY] === marker
      ? 'enforced'
      : 'ignored';
  } catch {
    return 'ignored';
  }
}

function sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export function capabilityRecordFor(
  settings: UserSettings,
  modelId: string,
  currentServerUrl: string,
): ModelCapabilityRecord | undefined {
  const stored = settings.analyzerCapabilitiesByModel[modelId];
  return stored && sameServer(stored.serverUrl, currentServerUrl) ? stored : undefined;
}

export function assertConfiguredCapabilitiesAllowed(
  record: ModelCapabilityRecord | undefined,
  configured: { structuredOutput: StructuredOutputMode; reasoning: string | undefined },
  modelId: string,
): void {
  if (!record || !record.control.ok) return;
  if (record.structuredOutput[configured.structuredOutput]?.[CONFIGURED_LEVEL_KEY] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(modelId, 'structuredOutput', configured.structuredOutput, record.testedAt);
  }
  if (configured.reasoning !== undefined && record.reasoning[configured.reasoning] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(modelId, 'reasoning', configured.reasoning, record.testedAt);
  }
}

export function plannedTestRequestCount(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'offeredLevels'>,
): number {
  /* The control request goes first, with no structured output (`off`). An `off` check
     therefore sends nothing more; only `schema` and `json` checks add requests. */
  const modes = input.scope === 'all' ? deps.offeredModes : [deps.configuredMode];
  return 1 + modes.filter((mode) => mode !== 'off').length * deps.offeredLevels.length;
}
```

`server/src/workspace/user-settings.ts` — above `export const userSettingsSchema` (`:111`):

```ts
const probeOutcomeSchema = z.enum(['enforced', 'ignored', 'rejected', 'accepted']);
const probeByLevelSchema = z.record(z.string(), probeOutcomeSchema);
/* #3084 — persisted shape of analyzer/capabilities.ts ModelCapabilityRecord (declared
   here, not imported, so user-settings stays a leaf of the analyzer import graph). */
export const modelCapabilityRecordSchema = z.object({
  serverUrl: z.string(),
  testedAt: z.string(),
  control: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]),
  structuredOutput: z.object({
    schema: probeByLevelSchema.optional(),
    json: probeByLevelSchema.optional(),
    off: probeByLevelSchema.optional(),
  }),
  reasoning: z.record(z.string(), z.enum(['accepted', 'rejected'])),
});
```

Field after `analyzerRateLimitsByModel`:

```ts
  /* #3084 — Test-action records keyed by model id. Server-written only
     (writeAnalyzerCapabilityRecord); stripped from the general PUT via FORBIDDEN_KEYS;
     returned by GET so Settings can show the outcome. */
  analyzerCapabilitiesByModel: z.record(z.string(), modelCapabilityRecordSchema).default({}),
```

Default: `analyzerCapabilitiesByModel: {},`. `FORBIDDEN_KEYS`, after `'tourCompletedAt',` (`:466`):

```ts
  /* #3084 Test-action records — written only by writeAnalyzerCapabilityRecord. */
  'analyzerCapabilitiesByModel',
```

After 3b's `mutateUserSettings` (the serialised read-decide-write helper 3b adds beside `writeGeminiApiKey`, `:809-820`):

```ts
/** #3084 — persist one Test-action record, replacing any earlier record for the id.
    Goes through mutateUserSettings so it serialises with endpoint and key writes. */
export async function writeAnalyzerCapabilityRecord(
  modelId: string,
  record: z.infer<typeof modelCapabilityRecordSchema>,
): Promise<UserSettings> {
  const validated = modelCapabilityRecordSchema.parse(record);
  return mutateUserSettings((current) => ({
    analyzerCapabilitiesByModel: { ...current.analyzerCapabilitiesByModel, [modelId]: validated },
  }));
}
```

In `server/src/workspace/analyzer-endpoints.test.ts` (3b), add to `FIELD_EXCLUDED` (its `/model/i` filter matches the new field):

```ts
      'analyzerCapabilitiesByModel', // Test records keyed by model id, not a selection (#3084 PR 3c)
```

(Add `server/src/workspace/analyzer-endpoints.test.ts` to this task's Step 4 run and Step 6 `git add`.)

Capture the label column: PowerShell `$env:CAPTURE_LABELS='1'; npm --prefix server run test -- src/analyzer/structured-output-label-cases.test.ts; Remove-Item Env:CAPTURE_LABELS` (Git Bash: `CAPTURE_LABELS=1 npm --prefix server run test -- src/analyzer/structured-output-label-cases.test.ts`). Replace the fixture's contents with the printed array, and paste it into the PR body.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/capabilities.test.ts src/analyzer/structured-output-label-cases.test.ts src/workspace/user-settings.test.ts src/routes/user-settings.test.ts`  Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `assertConfiguredCapabilitiesAllowed`: change the structured-output `=== 'rejected'` to `=== 'ignored'` → red: "throws AnalyzerCapabilityRejectedError naming the setting and test date…". Restore.
2. `capabilityRecordFor`: return `stored` unconditionally → red: "discards the record after the base URL changes". Restore.
3. `classifyMarkerProbe`: drop `=== marker` (any value counts) → red: "enforced only when the marker key carries the exact value". Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capabilities.ts server/src/analyzer/capabilities.test.ts server/src/analyzer/__fixtures__/structured-output-label-cases.json server/src/analyzer/structured-output-label-cases.test.ts server/src/workspace/user-settings.ts
git commit -m "feat(server): model capability records and the structured-output probe helpers"
```

---
### Task 3c.4: `runModelTest` — control request, configured check, marker probe, `scope: 'all'`

**Files:**
- Modify: `server/src/analyzer/capabilities.ts` (append; extend its imports)
- Test: Create `server/src/analyzer/capabilities.run-model-test.test.ts`

**Interfaces:**
- Consumes: Task 3c.3 helpers; `ChatTransport.send(req: TransportRequest): Promise<TransportResult>` (W1); `AnalyzerHttpError` (`httpStatus`), `AnalysisAbortedError` (W1).
- Produces: `runModelTest(input: { modelId: string; scope: 'configured' | 'all' }, deps: ModelTestDeps): Promise<ModelCapabilityRecord>`; `class ModelTestInconclusiveError`.

Rules (spec §2 "The Test action", P7):
- Requests run sequentially.
- The control request goes first. It uses **no structured output** (`off` mode), a trivial prompt and a 256-token cap. It never uses `json` mode: some servers reject `json_object` with a 400 (LM Studio), which would fail every test there. A failing control records the whole test as failed and marks nothing `rejected`.
- With the control OK, a 400 → `rejected`. The `schema` check → `enforced` / `ignored` by the marker. The `json` check → `accepted` / `rejected`; it is probed like any other mode.
- The `off` check sends nothing and records `accepted`, because the control already sent that exact request successfully.
- Any other failure after a good control is inconclusive. That covers a 5xx after the transport's own retries, a timeout, an unreachable server, and a `length` or `blocked` finish on a `schema` or `json` probe. It propagates, **no record is written**, and the route answers 502 (Task 3c.6), because a probe that could not be attributed must not be stored as a verdict. The rate limiter is acquired inside the Gemini and OpenAI transports for every request (W1/3b), so the test adds no limiter code; Ollama has no limiter today.

Keeps green: `capabilities.test.ts`.

- [ ] **Step 1: Write the failing test** — create `server/src/analyzer/capabilities.run-model-test.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  runModelTest,
  plannedTestRequestCount,
  largestStageSchema,
  MARKER_KEY,
  ALL_STRUCTURED_OUTPUT_MODES,
  CONFIGURED_LEVEL_KEY,
  ModelTestInconclusiveError,
  type ModelTestDeps,
} from './capabilities.js';
import { AnalyzerHttpError } from './errors.js';
import type { ChatTransport, TransportRequest, TransportResult } from './runner/transport.js';

const ok = (text: string): TransportResult => ({ text, reasoningSeen: false, finish: 'stop', receivedBytes: text.length });

function fakeTransport(respond: (req: TransportRequest, n: number) => TransportResult) {
  const calls: TransportRequest[] = [];
  const transport: ChatTransport = {
    kind: 'openai',
    model: 'qwen3-30b',
    send: vi.fn(async (req: TransportRequest) => {
      calls.push(req);
      return respond(req, calls.length);
    }),
  };
  return { transport, calls };
}

function deps(transport: ChatTransport, over: Partial<ModelTestDeps> = {}): ModelTestDeps {
  return {
    transport,
    serverUrl: 'http://127.0.0.1:8080/v1',
    configuredMode: 'schema',
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    offeredLevels: [CONFIGURED_LEVEL_KEY],
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
    now: () => new Date('2026-09-11T10:00:00.000Z'),
    markerValue: () => 'mk-fixed',
    ...over,
  };
}

const markerOf = (req: TransportRequest): string | undefined =>
  req.structuredOutput.mode === 'schema'
    ? (req.structuredOutput.schema.properties as Record<string, { enum?: string[] }>)[MARKER_KEY]?.enum?.[0]
    : undefined;

describe('runModelTest (#3084)', () => {
  it('a failing control request records the test as failed and marks nothing rejected', async () => {
    const { transport, calls } = fakeTransport(() => {
      throw new AnalyzerHttpError('openai', 400, '{"error":"response_format.type must be json_schema"}', 'HTTP 400');
    });
    const record = await runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'configured' }, deps(transport));
    expect(calls).toHaveLength(1);
    expect(calls[0].structuredOutput).toEqual({ mode: 'off' });
    expect(record.control).toMatchObject({ ok: false });
    expect(record.structuredOutput).toEqual({});
  });

  it('the control request sends no structured output, so a server that rejects json mode still passes it (LM Studio)', async () => {
    const { transport, calls } = fakeTransport((req) => {
      if (req.structuredOutput.mode === 'json') {
        throw new AnalyzerHttpError('openai', 400, "'response_format.type' must be 'json_schema' or 'text'", 'HTTP 400');
      }
      return ok('{"ok":true}');
    });
    const record = await runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'configured' }, deps(transport, { configuredMode: 'json' }));
    expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'json']);
    expect(record).toMatchObject({ control: { ok: true }, structuredOutput: { json: { configured: 'rejected' } } });
  });

  it('configured mode off sends only the control request and records it accepted', async () => {
    const { transport, calls } = fakeTransport(() => ok('{"ok":true}'));
    const d = deps(transport, { configuredMode: 'off' });
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, d);
    expect(calls).toHaveLength(1);
    expect(calls).toHaveLength(plannedTestRequestCount({ modelId: 'm', scope: 'configured' }, d));
    expect(record.structuredOutput).toEqual({ off: { configured: 'accepted' } });
  });

  it('marker present in the output → enforced', async () => {
    const { transport } = fakeTransport((req) =>
      ok(req.structuredOutput.mode === 'schema' ? `{"${MARKER_KEY}":"${markerOf(req)}"}` : '{"ok":true}'),
    );
    const record = await runModelTest({ modelId: 'openai:lab::qwen3-30b', scope: 'configured' }, deps(transport));
    expect(record).toMatchObject({
      control: { ok: true },
      structuredOutput: { schema: { configured: 'enforced' } },
      testedAt: '2026-09-11T10:00:00.000Z',
      serverUrl: 'http://127.0.0.1:8080/v1',
    });
  });

  it('a 200 without the marker → ignored', async () => {
    const { transport } = fakeTransport(() => ok('{"characters":[]}'));
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
    expect(record.structuredOutput).toEqual({ schema: { configured: 'ignored' } });
  });

  it('a 400 on the schema check after a good control → rejected', async () => {
    const { transport } = fakeTransport((_req, n) => {
      if (n === 1) return ok('{"ok":true}');
      throw new AnalyzerHttpError('openai', 400, 'json_schema unsupported', 'HTTP 400');
    });
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
    expect(record.structuredOutput).toEqual({ schema: { configured: 'rejected' } });
  });

  it('a Gemini ApiError-shaped status 400 also counts as rejected', async () => {
    const { transport } = fakeTransport((_req, n) => {
      if (n === 1) return ok('{"ok":true}');
      throw Object.assign(new Error('INVALID_ARGUMENT'), { status: 400 });
    });
    const record = await runModelTest({ modelId: 'gemini-3.6-flash', scope: 'configured' }, deps(transport));
    expect(record.structuredOutput).toEqual({ schema: { configured: 'rejected' } });
  });

  it('the schema probe sends the largest stage schema plus a required marker the prompt never mentions', async () => {
    const { transport, calls } = fakeTransport((req) => ok(`{"${MARKER_KEY}":"${markerOf(req) ?? ''}"}`));
    await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport));
    const probe = calls[1];
    expect(probe.structuredOutput.mode).toBe('schema');
    const sent = probe.structuredOutput.mode === 'schema' ? probe.structuredOutput.schema : {};
    const largest = largestStageSchema().schema;
    expect(Object.keys(sent.properties as object)).toEqual([...Object.keys(largest.properties as object), MARKER_KEY]);
    expect(sent.required).toContain(MARKER_KEY);
    const promptText = probe.system + probe.messages.map((m) => m.content).join('');
    expect(promptText).not.toContain(MARKER_KEY);
    expect(promptText).not.toContain('mk-fixed');
  });

  it('configured mode json → a json check recorded accepted', async () => {
    const { transport, calls } = fakeTransport(() => ok('{"ok":true}'));
    const record = await runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport, { configuredMode: 'json' }));
    expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'json']);
    expect(record.structuredOutput).toEqual({ json: { configured: 'accepted' } });
  });

  it("scope 'all' tests every mode, and the request count equals plannedTestRequestCount for both scopes", async () => {
    for (const scope of ['configured', 'all'] as const) {
      const { transport, calls } = fakeTransport((req) => ok(`{"${MARKER_KEY}":"${markerOf(req) ?? ''}","ok":true}`));
      const d = deps(transport);
      const record = await runModelTest({ modelId: 'm', scope }, d);
      expect(calls).toHaveLength(plannedTestRequestCount({ modelId: 'm', scope }, d));
      if (scope === 'all') {
        // off-mode control, then schema and json; the off check sends nothing
        expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'schema', 'json']);
        expect(record.structuredOutput).toEqual({
          schema: { configured: 'enforced' },
          json: { configured: 'accepted' },
          off: { configured: 'accepted' },
        });
      }
    }
  });

  it('a length finish on a schema or json probe is inconclusive, not ignored or accepted', async () => {
    for (const configuredMode of ['schema', 'json'] as const) {
      const { transport } = fakeTransport((_req, n) =>
        n === 1 ? ok('{"ok":true}') : { text: '{"char', reasoningSeen: true, finish: 'length', receivedBytes: 6 },
      );
      await expect(runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport, { configuredMode }))).rejects.toBeInstanceOf(
        ModelTestInconclusiveError,
      );
    }
  });

  it('a non-400 failure after a good control propagates (no record is produced)', async () => {
    const { transport } = fakeTransport((_req, n) => {
      if (n === 1) return ok('{"ok":true}');
      throw new AnalyzerHttpError('openai', 503, 'loading model', 'HTTP 503');
    });
    await expect(runModelTest({ modelId: 'm', scope: 'configured' }, deps(transport))).rejects.toBeInstanceOf(AnalyzerHttpError);
  });

  it('control failure text passes through redact and is capped at 500 chars', async () => {
    const { transport } = fakeTransport(() => {
      throw new AnalyzerHttpError('openai', 401, 'bad key sk-secret-123', `HTTP 401 bad key sk-secret-123 ${'x'.repeat(900)}`);
    });
    const record = await runModelTest(
      { modelId: 'm', scope: 'configured' },
      deps(transport, { redact: (t) => t.replaceAll('sk-secret-123', '[redacted]') }),
    );
    expect(record.control.ok).toBe(false);
    const error = record.control.ok ? '' : record.control.error;
    expect(error).toContain('[redacted]');
    expect(error.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(record)).not.toContain('sk-secret-123');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/capabilities.run-model-test.test.ts`
Expected: FAIL — `TypeError: runModelTest is not a function`.

- [ ] **Step 3: Implement** — in `server/src/analyzer/capabilities.ts` change the imports to `import type { ChatTransport, StructuredOutputMode, TransportRequest, TransportResult } from './runner/transport.js';` and `import { AnalysisAbortedError, AnalyzerCapabilityRejectedError, AnalyzerHttpError } from './errors.js';`, then append:

```ts
export class ModelTestInconclusiveError extends Error {
  constructor(
    readonly modelId: string,
    readonly mode: StructuredOutputMode,
    detail: string,
  ) {
    super(`The ${mode} check for ${modelId} was inconclusive (${detail}). Nothing was recorded; run the test again.`);
    this.name = 'ModelTestInconclusiveError';
  }
}

const PROBE_SYSTEM = 'You are a JSON generator. Output only JSON.';
const CONTROL_PROMPT = 'Reply with exactly this JSON object and nothing else: {"ok": true}';
const PROBE_PROMPT =
  'Return one JSON object that satisfies the response format you were given. Use empty arrays, zeros and short placeholder strings wherever a value is required.';
const CONTROL_MAX_OUTPUT_TOKENS = 256;
const PROBE_MAX_OUTPUT_TOKENS = 4096;

function isHttp400(err: unknown): boolean {
  if (err instanceof AnalyzerHttpError) return err.httpStatus === 400;
  return (err as { status?: unknown } | null)?.status === 400; // @google/genai ApiError
}

function sendProbe(
  transport: ChatTransport,
  structuredOutput: TransportRequest['structuredOutput'],
  prompt: string,
  maxOutputTokens: number,
): Promise<TransportResult> {
  const approxChars = PROBE_SYSTEM.length + prompt.length + JSON.stringify(structuredOutput).length;
  return transport.send({
    system: PROBE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    structuredOutput,
    temperature: 0,
    maxOutputTokens,
    estimatedInputTokens: Math.ceil(approxChars / 4) + 50,
    call: {},
  });
}

/** P7: only a `stop` finish is evidence. A `length` or `blocked` finish is inconclusive. */
function requireStop(result: TransportResult, modelId: string, mode: StructuredOutputMode): TransportResult {
  if (result.finish !== 'stop') throw new ModelTestInconclusiveError(modelId, mode, `finish=${result.finish}`);
  return result;
}

async function checkMode(modelId: string, mode: StructuredOutputMode, deps: ModelTestDeps): Promise<ProbeOutcome> {
  /* The control request already sent exactly this request (no structured output) and it
     succeeded, so an `off` check has nothing left to learn and sends nothing. */
  if (mode === 'off') return 'accepted';
  try {
    if (mode === 'schema') {
      const marker = (deps.markerValue ?? newMarkerValue)();
      const largest = largestStageSchema();
      const adapted = deps.adaptSchema(withMarker(largest.schema, marker));
      const result = requireStop(
        await sendProbe(
          deps.transport,
          { mode: 'schema', name: `castwright_probe_${largest.name}`, schema: adapted.schema },
          PROBE_PROMPT,
          PROBE_MAX_OUTPUT_TOKENS,
        ),
        modelId,
        mode,
      );
      return classifyMarkerProbe(result.text, marker);
    }
    /* `json` is probed like any other mode (never used for the control: LM Studio 400s it). */
    requireStop(await sendProbe(deps.transport, { mode: 'json' }, CONTROL_PROMPT, CONTROL_MAX_OUTPUT_TOKENS), modelId, mode);
    return 'accepted';
  } catch (err) {
    if (isHttp400(err)) return 'rejected';
    throw err;
  }
}

export async function runModelTest(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: ModelTestDeps,
): Promise<ModelCapabilityRecord> {
  const redact = deps.redact ?? ((t: string) => t);
  const base = {
    serverUrl: deps.serverUrl,
    testedAt: (deps.now ?? (() => new Date()))().toISOString(),
    reasoning: {},
  };
  try {
    /* Control: no structured output (P7). `json` would 400 on LM Studio and fail every test there. */
    await sendProbe(deps.transport, { mode: 'off' }, CONTROL_PROMPT, CONTROL_MAX_OUTPUT_TOKENS);
  } catch (err) {
    if (err instanceof AnalysisAbortedError) throw err;
    const text = err instanceof Error ? err.message : String(err);
    return { ...base, control: { ok: false, error: redact(text).slice(0, 500) }, structuredOutput: {} };
  }
  const modes = input.scope === 'all' ? deps.offeredModes : [deps.configuredMode];
  const structuredOutput: ModelCapabilityRecord['structuredOutput'] = {};
  for (const mode of modes) {
    for (const level of deps.offeredLevels) {
      const outcome = await checkMode(input.modelId, mode, deps);
      structuredOutput[mode] = { ...(structuredOutput[mode] ?? {}), [level]: outcome };
    }
  }
  return { ...base, control: { ok: true }, structuredOutput };
}
```

- [ ] **Step 4: Run and confirm it passes**  Run: `npm --prefix server run test -- src/analyzer/capabilities.run-model-test.test.ts src/analyzer/capabilities.test.ts`  Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. In `runModelTest`'s control `catch`, replace the `return { …control: { ok: false … } }` with `throw err` → red: "a failing control request records the test as failed…". Restore.
2. In `checkMode`, delete `if (isHttp400(err)) return 'rejected';` → red: "a 400 on the schema check after a good control → rejected", "a Gemini ApiError-shaped status 400…". Restore.
3. Replace `withMarker(largest.schema, marker)` with `largest.schema` → red: "marker present in the output → enforced", "the schema probe sends the largest stage schema plus a required marker…". Restore.
4. In `runModelTest`'s control call change `{ mode: 'off' }` to `{ mode: 'json' }` → red: "a failing control request records the test as failed…" (`calls[0].structuredOutput`) and "the control request sends no structured output, so a server that rejects json mode still passes it (LM Studio)" (the control fails, so nothing is `rejected`). Restore.
5. In `checkMode` delete `if (mode === 'off') return 'accepted';` → red: "configured mode off sends only the control request and records it accepted" and "scope 'all' tests every mode…" (one request more than `plannedTestRequestCount`). Restore.
6. In `checkMode` replace `requireStop(await sendProbe(deps.transport, { mode: 'json' }, …), modelId, mode);` with `await sendProbe(deps.transport, { mode: 'json' }, CONTROL_PROMPT, CONTROL_MAX_OUTPUT_TOKENS);` → red: "a length finish on a schema or json probe is inconclusive, not ignored or accepted" (the json pass resolves `accepted`). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capabilities.ts server/src/analyzer/capabilities.run-model-test.test.ts
git commit -m "feat(server): runModelTest records what a model accepts and enforces"
```

---
### Task 3c.5: Catalog core — live listings, served-limit prefill, key-origin rule, cache, preview

**Files:**
- Create: `server/src/analyzer/catalog/analyzer-catalog.ts`
- Test: Create `server/src/analyzer/catalog/analyzer-catalog.test.ts`

**Interfaces:**
- Consumes: `listGeminiModels(apiKey, { refresh })`, `GeminiModelInfo` (W2); `keyOriginMatches`, `AnalyzerEndpoint` (3b); `endpointModelId` (3a); `adaptSchemaFor*`, `structuredOutputLabel` (3b); Task 3c.3 (`capabilityRecordFor`, `STAGE_GRAMMAR_SCHEMAS`, `draft07`, `plannedTestRequestCount`, `ALL_STRUCTURED_OUTPUT_MODES`, `CONFIGURED_LEVEL_KEY`); `getResolvedOllamaUrl` (`user-settings.ts:597`), `getResolvedGeminiApiKey` (`:830`), `getCachedUserSettings` (`:385`); knobs `analyzer.ollama.structuredOutput`, `analyzer.gemini.structuredOutput` (3b).
- Produces: `AnalyzerCatalog`, `AnalyzerCatalogGroup`, `AnalyzerCatalogEntry`, `CatalogDeps`, `DEFAULT_CATALOG_DEPS`, `CATALOG_TTL_MS`, `buildAnalyzerCatalog(opts, deps?)`, `servedLimitsFromModelEntry(entry)`, `getCachedCatalogLimits(modelId)`, `previewEndpointModels(input, deps?)`, `EndpointModelsPreview`, `_resetCatalogCacheForTest()`.

Decisions encoded here:
- **Served context only** (06-local-server-facts "Consequences"): `max_model_len` (vLLM) → `meta.n_ctx` (llama.cpp per-slot; llama-swap config) → `context_length` (OpenRouter; llama-swap config). Never `meta.n_ctx_train`, never LiteLLM `max_input_tokens`. Output limit only from OpenRouter `top_provider.max_completion_tokens` (LiteLLM's `max_output_tokens` is a catalogue value, not served).
- **Key-origin rule:** a stored key whose origin no longer matches the base URL means no request at all; the group is listed as `failed` with a re-enter message. No stored key → the SDK is built with `apiKey: null`, which sends no `Authorization` header (`openai` 7.15 `client.js:391-393`); the test proves it over a real socket.
- **Group status** follows the master contract (`'ok' | 'fallback' | 'error'`) and spec §3 "Failure":
  - **Gemini:** no key → `fallback`, and no `models.list()` call. A failed listing → `fallback` with `error`. Neither carries models; the **frontend** overlays its curated Gemini list (`MODEL_OPTIONS` is a frontend constant).
  - **Ollama and endpoints:** a failed listing, or a stored key bound to another host → `error` with the message and no models. Ollama keeps plan 221's installed-only rule, so nothing is overlaid. Endpoint groups always appear, from saved settings.
- **Entry shape** follows the master contract: `{ id, label, contextTokens?, outputTokens?, capability?, offeredReasoningLevels? }`.
  - `label` is Gemini's `displayName ?? id`, the Ollama tag, or the endpoint's bare model name. The endpoint group's own `label` is the endpoint name.
  - W3c also adds `engine`, `model`, `structuredOutput` and `testPlan`; the Test button and the run label read them. `offeredReasoningLevels` arrives in wave 5.
  - The response carries only `groups`.
- **Cache:** raw listings (not entries) are cached 30 s per source key, failures included; `refresh` bypasses. Entries are rebuilt per call so a fresh Test record or a changed structured-output setting shows at once.
- **`dropped`** for an entry in `schema` mode is the union of what that provider's adapter drops across the eight stage grammars.

Keeps green: `catalog/gemini-catalog.test.ts` (W2), `capabilities.test.ts`.

- [ ] **Step 1: Write the failing test** — create `server/src/analyzer/catalog/analyzer-catalog.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildAnalyzerCatalog,
  previewEndpointModels,
  servedLimitsFromModelEntry,
  getCachedCatalogLimits,
  DEFAULT_CATALOG_DEPS,
  CATALOG_TTL_MS,
  _resetCatalogCacheForTest,
  type CatalogDeps,
} from './analyzer-catalog.js';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';

const lab = analyzerEndpointSchema.parse({
  id: 'lab',
  name: 'Lab server',
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  contextTokens: 32768,
});

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_USER_SETTINGS, analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...over };
}

function deps(over: Partial<CatalogDeps> = {}): CatalogDeps {
  let t = 1_000_000;
  return {
    settings: () => settings(),
    ollamaUrl: () => 'http://localhost:11434',
    geminiApiKey: () => null,
    listOllamaTags: vi.fn(async () => ['qwen3.5:4b']),
    listGemini: vi.fn(async () => [{ id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }]),
    listEndpoint: vi.fn(async () => [{ id: 'qwen3-30b', object: 'model', meta: { n_ctx: 32768, n_ctx_train: 262144 } }]),
    now: () => (t += 1),
    ...over,
  };
}

afterEach(() => _resetCatalogCacheForTest());

describe('servedLimitsFromModelEntry — served fields only (#3084 decision 3b)', () => {
  it.each([
    ['vLLM max_model_len', { id: 'm', max_model_len: 16384 }, { contextTokens: 16384 }],
    ['llama.cpp meta.n_ctx beats n_ctx_train', { id: 'm', meta: { n_ctx: 8192, n_ctx_train: 262144 } }, { contextTokens: 8192 }],
    ['llama.cpp with only n_ctx_train → nothing', { id: 'm', meta: { n_ctx_train: 262144 } }, {}],
    ['llama-swap context_length + meta.n_ctx → meta.n_ctx', { id: 'm', context_length: 40000, meta: { n_ctx: 32000 } }, { contextTokens: 32000 }],
    ['OpenRouter context_length + top_provider.max_completion_tokens', { id: 'm', context_length: 128000, top_provider: { context_length: 128000, max_completion_tokens: 16384 } }, { contextTokens: 128000, maxOutputTokens: 16384 }],
    ['LiteLLM catalogue max_input_tokens → nothing', { id: 'm', max_input_tokens: 200000, max_output_tokens: 8192 }, {}],
    ['vLLM max_model_len wins over context_length', { id: 'm', max_model_len: 4096, context_length: 999999 }, { contextTokens: 4096 }],
  ])('%s', (_name, entry, expected) => {
    expect(servedLimitsFromModelEntry(entry as Record<string, unknown>)).toEqual(expected);
  });
});

describe('buildAnalyzerCatalog', () => {
  it('returns Ollama, Gemini (fallback without a key, no list call) and one group per saved endpoint', async () => {
    const d = deps();
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(Object.keys(catalog)).toEqual(['groups']);
    expect(catalog.groups.map((g) => [g.kind, g.id, g.status])).toEqual([
      ['ollama', 'ollama', 'ok'],
      ['gemini', 'gemini', 'fallback'],
      ['endpoint', 'lab', 'ok'],
    ]);
    expect(catalog.groups[1].models).toEqual([]);
    expect(d.listGemini).not.toHaveBeenCalled();
    expect(catalog.groups[0].models[0]).toMatchObject({ id: 'qwen3.5:4b', label: 'qwen3.5:4b' });
    const entry = catalog.groups[2].models[0];
    expect(entry).toMatchObject({ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai', model: 'qwen3-30b', contextTokens: 32768 });
    expect(entry.testPlan).toEqual({ configured: 2, all: 3 });
  });

  it('lists Gemini with limits and display-name labels when a key is set', async () => {
    const d = deps({ geminiApiKey: () => 'k' });
    const catalog = await buildAnalyzerCatalog({ refresh: true }, d);
    expect(d.listGemini).toHaveBeenCalledWith('k', true);
    expect(catalog.groups[1].status).toBe('ok');
    expect(catalog.groups[1].models[0]).toMatchObject({
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      engine: 'gemini',
      contextTokens: 1_048_576,
      outputTokens: 65_536,
    });
  });

  it('a failed Gemini listing is a fallback group (the frontend overlays its curated list)', async () => {
    const d = deps({ geminiApiKey: () => 'k', listGemini: vi.fn(async () => { throw new Error('503 UNAVAILABLE'); }) });
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(catalog.groups[1]).toMatchObject({ kind: 'gemini', status: 'fallback', models: [] });
    expect(catalog.groups[1].error).toContain('503');
  });

  it('a stored key for another origin sends no request and marks the group error', async () => {
    const d = deps({ settings: () => settings({ analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'sk-x' } } }) });
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listEndpoint).not.toHaveBeenCalled();
    expect(catalog.groups[2]).toMatchObject({ status: 'error', models: [] });
    expect(catalog.groups[2].error).toMatch(/Re-enter the API key for Lab server/);
  });

  it('a matching stored key is passed to the listing', async () => {
    const d = deps({ settings: () => settings({ analyzerEndpointKeys: { lab: { origin: 'http://127.0.0.1:8080', key: 'sk-x' } } }) });
    await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listEndpoint).toHaveBeenCalledWith('http://127.0.0.1:8080/v1', 'sk-x');
  });

  it('a failed Ollama listing keeps the group, marked error, without models (installed-only)', async () => {
    const d = deps({ listOllamaTags: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) });
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(catalog.groups[0]).toMatchObject({ kind: 'ollama', status: 'error', models: [] });
    expect(catalog.groups[0].error).toContain('ECONNREFUSED');
  });

  it('caches listings for CATALOG_TTL_MS; refresh bypasses the cache', async () => {
    let now = 0;
    const d = deps({ now: () => now });
    await buildAnalyzerCatalog({ refresh: false }, d);
    now = CATALOG_TTL_MS - 1;
    await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listOllamaTags).toHaveBeenCalledTimes(1);
    await buildAnalyzerCatalog({ refresh: true }, d);
    expect(d.listOllamaTags).toHaveBeenCalledTimes(2);
    now = 10 * CATALOG_TTL_MS;
    await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listOllamaTags).toHaveBeenCalledTimes(3);
  });

  it('attaches a Test record only while its serverUrl matches, and labels from it', async () => {
    const rec = {
      serverUrl: 'http://127.0.0.1:8080/v1',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true as const },
      structuredOutput: { schema: { configured: 'ignored' as const } },
      reasoning: {},
    };
    const d = deps({ settings: () => settings({ analyzerCapabilitiesByModel: { 'openai:lab::qwen3-30b': rec } }) });
    const entry = (await buildAnalyzerCatalog({ refresh: false }, d)).groups[2].models[0];
    expect(entry.capability).toEqual(rec);
    expect(entry.structuredOutput.label).toBe('schema (not enforced)');

    _resetCatalogCacheForTest();
    const moved = deps({
      settings: () =>
        settings({
          analyzerEndpoints: [{ ...lab, baseUrl: 'http://127.0.0.1:9090/v1' }],
          analyzerCapabilitiesByModel: { 'openai:lab::qwen3-30b': rec },
        }),
    });
    expect((await buildAnalyzerCatalog({ refresh: false }, moved)).groups[2].models[0].capability).toBeUndefined();
  });

  it('getCachedCatalogLimits reads the last listing without fetching', async () => {
    const d = deps();
    expect(getCachedCatalogLimits('openai:lab::qwen3-30b')).toBeUndefined();
    await buildAnalyzerCatalog({ refresh: false }, d);
    expect(getCachedCatalogLimits('openai:lab::qwen3-30b')).toEqual({ contextTokens: 32768 });
  });
});

describe('previewEndpointModels', () => {
  it('suggests the smallest served context among the listed models', async () => {
    const out = await previewEndpointModels(
      { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: null },
      { listEndpoint: async () => [{ id: 'a', meta: { n_ctx: 32768 } }, { id: 'b', max_model_len: 8192 }, { id: 'c' }] },
    );
    expect(out).toEqual({
      status: 'ok',
      models: [{ model: 'a', contextTokens: 32768 }, { model: 'b', contextTokens: 8192 }, { model: 'c' }],
      suggestedContextTokens: 8192,
    });
  });

  it('reports a listing failure instead of throwing', async () => {
    const out = await previewEndpointModels(
      { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: null },
      { listEndpoint: async () => { throw new Error('401 Unauthorized'); } },
    );
    expect(out).toMatchObject({ status: 'failed', models: [] });
    expect(out.error).toContain('401');
  });
});

describe('DEFAULT_CATALOG_DEPS.listEndpoint over a real socket', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it('lists /v1/models through the openai SDK and sends no Authorization header without a key', async () => {
    let seenAuth: string | undefined = 'not-called';
    server = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-30b', object: 'model', created: 0, owned_by: 'x', meta: { n_ctx: 32768, n_ctx_train: 262144 } }] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const out = await DEFAULT_CATALOG_DEPS.listEndpoint(`http://127.0.0.1:${port}/v1`, null);
    expect(out.map((m) => m.id)).toEqual(['qwen3-30b']);
    expect((out[0].meta as Record<string, unknown>).n_ctx).toBe(32768);
    expect(seenAuth).toBeUndefined();
  });

  it('sends the key as a Bearer token when one is given', async () => {
    let seenAuth: string | undefined;
    server = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    await DEFAULT_CATALOG_DEPS.listEndpoint(`http://127.0.0.1:${port}/v1`, 'sk-local');
    expect(seenAuth).toBe('Bearer sk-local');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/catalog/analyzer-catalog.test.ts`
Expected: FAIL — `Failed to load url ./analyzer-catalog.js`.

- [ ] **Step 3: Implement** — create `server/src/analyzer/catalog/analyzer-catalog.ts`:

```ts
/* #3084 W3 — one catalog for every analyzer source: Ollama /api/tags, Gemini
   models.list() (only with a key), and each saved OpenAI-compatible endpoint's
   /v1/models through the openai SDK under the key-origin rule. Served context/output
   limits and the Test record ride on each entry; the frontend overlays curated labels. */
import OpenAI from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';
import { configValue } from '../../config/resolver.js';
import {
  getCachedUserSettings,
  getResolvedGeminiApiKey,
  getResolvedOllamaUrl,
  type UserSettings,
} from '../../workspace/user-settings.js';
import { keyOriginMatches, type AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
import { endpointModelId } from '../model-id.js';
import { listGeminiModels, type GeminiModelInfo } from './gemini-catalog.js';
import {
  ALL_STRUCTURED_OUTPUT_MODES,
  CONFIGURED_LEVEL_KEY,
  STAGE_GRAMMAR_SCHEMAS,
  capabilityRecordFor,
  draft07,
  plannedTestRequestCount,
  type ModelCapabilityRecord,
} from '../capabilities.js';
import {
  adaptSchemaForGemini,
  adaptSchemaForOllama,
  adaptSchemaForOpenAI,
  structuredOutputLabel,
  type AdaptedSchema,
} from '../runner/schema-adapters.js';
import type { StructuredOutputMode } from '../runner/transport.js';

export type CatalogGroupKind = 'ollama' | 'gemini' | 'endpoint';

/** Master-contract fields: id, label, contextTokens?, outputTokens?, capability?
    (offeredReasoningLevels? arrives in wave 5). W3c additions: engine, model,
    structuredOutput, testPlan. */
export interface AnalyzerCatalogEntry {
  id: string;
  /** Gemini `displayName ?? id`; the Ollama tag; an endpoint's bare model name. */
  label: string;
  contextTokens?: number;
  outputTokens?: number;
  capability?: ModelCapabilityRecord;
  engine: 'local' | 'gemini' | 'openai';
  model: string;
  structuredOutput: { mode: StructuredOutputMode; dropped: string[]; label: string };
  testPlan: { configured: number; all: number };
}

export interface AnalyzerCatalogGroup {
  kind: CatalogGroupKind;
  id: string;
  label: string;
  /** ok = listed. fallback = Gemini without a key or with a failed listing: no models, and the
      frontend overlays its curated list. error = an Ollama or endpoint listing failed: no models. */
  status: 'ok' | 'fallback' | 'error';
  error?: string;
  models: AnalyzerCatalogEntry[];
}

export interface AnalyzerCatalog {
  groups: AnalyzerCatalogGroup[];
}

export interface CatalogDeps {
  settings(): UserSettings;
  ollamaUrl(): string;
  geminiApiKey(): string | null;
  listOllamaTags(url: string): Promise<string[]>;
  listGemini(apiKey: string, refresh: boolean): Promise<GeminiModelInfo[]>;
  listEndpoint(baseUrl: string, apiKey: string | null): Promise<Array<Record<string, unknown>>>;
  now(): number;
}

export const CATALOG_TTL_MS = 30_000;
const OLLAMA_TAGS_TIMEOUT_MS = 2_000;
const ENDPOINT_LIST_TIMEOUT_MS = 10_000;

/* Listing-only dispatcher: short connect/header/body budgets — unlike the long-call
   analyzer dispatcher, a model list that takes more than 10 s is a failed listing. */
const LISTING_DISPATCHER = new Agent({
  connect: { timeout: 5_000 },
  headersTimeout: ENDPOINT_LIST_TIMEOUT_MS,
  bodyTimeout: ENDPOINT_LIST_TIMEOUT_MS,
});

async function listOllamaTags(url: string): Promise<string[]> {
  const resp = await fetch(`${url}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(OLLAMA_TAGS_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Ollama returned ${resp.status} ${resp.statusText}`);
  const body = (await resp.json()) as { models?: Array<{ name?: string; model?: string }> };
  return (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
}

async function listEndpoint(baseUrl: string, apiKey: string | null): Promise<Array<Record<string, unknown>>> {
  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey, // null → no Authorization header (openai client.js:391-393)
    maxRetries: 0,
    timeout: ENDPOINT_LIST_TIMEOUT_MS,
    fetch: undiciFetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'],
    fetchOptions: { dispatcher: LISTING_DISPATCHER } as unknown as RequestInit,
  });
  const out: Array<Record<string, unknown>> = [];
  for await (const model of client.models.list()) out.push(model as unknown as Record<string, unknown>);
  return out;
}

export const DEFAULT_CATALOG_DEPS: CatalogDeps = {
  settings: getCachedUserSettings,
  ollamaUrl: getResolvedOllamaUrl,
  geminiApiKey: getResolvedGeminiApiKey,
  listOllamaTags,
  listGemini: (apiKey, refresh) => listGeminiModels(apiKey, { refresh }),
  listEndpoint,
  now: () => Date.now(),
};

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Served limits only: max_model_len → meta.n_ctx → context_length; never
    meta.n_ctx_train, never LiteLLM max_input_tokens / max_output_tokens. */
export function servedLimitsFromModelEntry(entry: Record<string, unknown>): { contextTokens?: number; maxOutputTokens?: number } {
  const meta = entry.meta as Record<string, unknown> | undefined;
  const contextTokens = positiveInt(entry.max_model_len) ?? positiveInt(meta?.n_ctx) ?? positiveInt(entry.context_length);
  const topProvider = entry.top_provider as Record<string, unknown> | undefined;
  const maxOutputTokens = positiveInt(topProvider?.max_completion_tokens);
  return {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

interface RawModel {
  id: string;
  model: string;
  displayName?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
}
type Listing = { ok: true; models: RawModel[] } | { ok: false; error: string };

const listingCache = new Map<string, { at: number; listing: Listing }>();

export function _resetCatalogCacheForTest(): void {
  listingCache.clear();
}

async function cachedListing(key: string, refresh: boolean, now: () => number, load: () => Promise<RawModel[]>): Promise<Listing> {
  const hit = listingCache.get(key);
  if (!refresh && hit && now() - hit.at < CATALOG_TTL_MS) return hit.listing;
  let listing: Listing;
  try {
    listing = { ok: true, models: await load() };
  } catch (err) {
    listing = { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
  listingCache.set(key, { at: now(), listing });
  return listing;
}

/** Last known served limits for a model id, from any cached listing (TTL ignored). */
export function getCachedCatalogLimits(modelId: string): { contextTokens?: number; maxOutputTokens?: number } | undefined {
  for (const { listing } of listingCache.values()) {
    if (!listing.ok) continue;
    const hit = listing.models.find((m) => m.id === modelId);
    if (hit) {
      return {
        ...(hit.contextTokens !== undefined ? { contextTokens: hit.contextTokens } : {}),
        ...(hit.maxOutputTokens !== undefined ? { maxOutputTokens: hit.maxOutputTokens } : {}),
      };
    }
  }
  return undefined;
}

const droppedMemo = new Map<CatalogGroupKind, string[]>();
function droppedForKind(kind: CatalogGroupKind): string[] {
  const memo = droppedMemo.get(kind);
  if (memo) return memo;
  const adapt: (s: Record<string, unknown>) => AdaptedSchema =
    kind === 'gemini' ? adaptSchemaForGemini : kind === 'endpoint' ? adaptSchemaForOpenAI : adaptSchemaForOllama;
  const all = new Set<string>();
  for (const { schema } of STAGE_GRAMMAR_SCHEMAS) for (const d of adapt(draft07(schema)).dropped) all.add(d);
  const out = [...all].sort();
  droppedMemo.set(kind, out);
  return out;
}

const OFFERED = { offeredModes: ALL_STRUCTURED_OUTPUT_MODES, offeredLevels: [CONFIGURED_LEVEL_KEY] };

function toEntry(
  raw: RawModel,
  ctx: { kind: CatalogGroupKind; engine: AnalyzerCatalogEntry['engine']; mode: StructuredOutputMode; serverUrl: string; settings: UserSettings },
): AnalyzerCatalogEntry {
  const capability = capabilityRecordFor(ctx.settings, raw.id, ctx.serverUrl);
  const dropped = ctx.mode === 'schema' ? droppedForKind(ctx.kind) : [];
  const planDeps = { ...OFFERED, configuredMode: ctx.mode };
  return {
    id: raw.id,
    label: raw.displayName ?? raw.model,
    ...(raw.contextTokens !== undefined ? { contextTokens: raw.contextTokens } : {}),
    ...(raw.maxOutputTokens !== undefined ? { outputTokens: raw.maxOutputTokens } : {}),
    ...(capability ? { capability } : {}),
    engine: ctx.engine,
    model: raw.model,
    structuredOutput: { mode: ctx.mode, dropped, label: structuredOutputLabel(ctx.mode, dropped, capability, CONFIGURED_LEVEL_KEY) },
    testPlan: {
      configured: plannedTestRequestCount({ modelId: raw.id, scope: 'configured' }, planDeps),
      all: plannedTestRequestCount({ modelId: raw.id, scope: 'all' }, planDeps),
    },
  };
}

async function ollamaGroup(refresh: boolean, deps: CatalogDeps, settings: UserSettings): Promise<AnalyzerCatalogGroup> {
  const url = deps.ollamaUrl();
  const base = { kind: 'ollama' as const, id: 'ollama', label: 'Local Ollama' };
  const listing = await cachedListing(`ollama:${url}`, refresh, deps.now, async () =>
    (await deps.listOllamaTags(url)).map((name) => ({ id: name, model: name })),
  );
  /* Plan 221 installed-only: a failed /api/tags lists nothing, and nothing is overlaid. */
  if (!listing.ok) return { ...base, status: 'error', error: listing.error, models: [] };
  const mode = configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput');
  return { ...base, status: 'ok', models: listing.models.map((m) => toEntry(m, { kind: 'ollama', engine: 'local', mode, serverUrl: url, settings })) };
}

async function geminiGroup(refresh: boolean, deps: CatalogDeps, settings: UserSettings): Promise<AnalyzerCatalogGroup> {
  const base = { kind: 'gemini' as const, id: 'gemini', label: 'Gemini API' };
  const apiKey = deps.geminiApiKey();
  /* Spec §3: no key, or a failed listing, falls back to the curated list. The server has no
     curated list (it is the frontend's MODEL_OPTIONS), so the group carries no models and
     `fallback` tells the frontend to overlay it. */
  if (!apiKey) return { ...base, status: 'fallback', models: [] };
  const listing = await cachedListing('gemini', refresh, deps.now, async () =>
    (await deps.listGemini(apiKey, refresh)).map((m) => ({
      id: m.id,
      model: m.id,
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      ...(m.inputTokenLimit !== undefined ? { contextTokens: m.inputTokenLimit } : {}),
      ...(m.outputTokenLimit !== undefined ? { maxOutputTokens: m.outputTokenLimit } : {}),
    })),
  );
  if (!listing.ok) return { ...base, status: 'fallback', error: listing.error, models: [] };
  const mode = configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput');
  return { ...base, status: 'ok', models: listing.models.map((m) => toEntry(m, { kind: 'gemini', engine: 'gemini', mode, serverUrl: 'gemini', settings })) };
}

async function endpointGroup(endpoint: AnalyzerEndpoint, refresh: boolean, deps: CatalogDeps, settings: UserSettings): Promise<AnalyzerCatalogGroup> {
  const base = { kind: 'endpoint' as const, id: endpoint.id, label: endpoint.name };
  const stored = settings.analyzerEndpointKeys[endpoint.id];
  if (stored && !keyOriginMatches(stored, endpoint.baseUrl)) {
    return { ...base, status: 'error', error: `Re-enter the API key for ${endpoint.name}: the saved key belongs to a different host.`, models: [] };
  }
  const listing = await cachedListing(`endpoint:${endpoint.id}:${endpoint.baseUrl}`, refresh, deps.now, async () =>
    (await deps.listEndpoint(endpoint.baseUrl, stored?.key ?? null))
      .filter((raw) => typeof raw.id === 'string')
      .map((raw) => ({ id: endpointModelId(endpoint.id, raw.id as string), model: raw.id as string, ...servedLimitsFromModelEntry(raw) })),
  );
  if (!listing.ok) return { ...base, status: 'error', error: listing.error, models: [] };
  return {
    ...base,
    status: 'ok',
    models: listing.models.map((m) => toEntry(m, { kind: 'endpoint', engine: 'openai', mode: endpoint.structuredOutput, serverUrl: endpoint.baseUrl, settings })),
  };
}

export async function buildAnalyzerCatalog(opts: { refresh: boolean }, deps: CatalogDeps = DEFAULT_CATALOG_DEPS): Promise<AnalyzerCatalog> {
  const settings = deps.settings();
  const groups = await Promise.all([
    ollamaGroup(opts.refresh, deps, settings),
    geminiGroup(opts.refresh, deps, settings),
    ...settings.analyzerEndpoints.map((e) => endpointGroup(e, opts.refresh, deps, settings)),
  ]);
  return { groups };
}

export interface EndpointModelsPreview {
  status: 'ok' | 'failed';
  error?: string;
  models: Array<{ model: string; contextTokens?: number; maxOutputTokens?: number }>;
  /** Smallest served context among listed models — a conservative prefill. */
  suggestedContextTokens?: number;
}

export async function previewEndpointModels(
  input: { baseUrl: string; apiKey: string | null },
  deps: Pick<CatalogDeps, 'listEndpoint'> = DEFAULT_CATALOG_DEPS,
): Promise<EndpointModelsPreview> {
  try {
    const models = (await deps.listEndpoint(input.baseUrl, input.apiKey))
      .filter((raw) => typeof raw.id === 'string')
      .map((raw) => ({ model: raw.id as string, ...servedLimitsFromModelEntry(raw) }));
    const contexts = models.map((m) => m.contextTokens).filter((n): n is number => n !== undefined);
    return { status: 'ok', models, ...(contexts.length > 0 ? { suggestedContextTokens: Math.min(...contexts) } : {}) };
  } catch (err) {
    return { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 300), models: [] };
  }
}
```

The `'schema (not enforced)'` expectation in the Test-record case must equal row 5 of the captured label table (Task 3c.3); if 3b's text differs, change this assertion to the captured value.

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/catalog/analyzer-catalog.test.ts src/analyzer/catalog/gemini-catalog.test.ts` then `npm run check:cycles`. Expected: PASS; no new cycle.

- [ ] **Step 5: Mutation proof**
1. In `servedLimitsFromModelEntry` add `?? positiveInt(meta?.n_ctx_train)` → red: "llama.cpp with only n_ctx_train → nothing". Restore.
2. In `endpointGroup`, delete the `if (stored && !keyOriginMatches(…)) return …` block → red: "a stored key for another origin sends no request…". Restore.
3. In `cachedListing`, drop `!refresh &&` → red: "caches listings for CATALOG_TTL_MS; refresh bypasses the cache". Restore.
4. In `listEndpoint`, replace `apiKey,` with `apiKey: apiKey ?? 'no-key',` → red: "…sends no Authorization header without a key". Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/catalog/analyzer-catalog.ts server/src/analyzer/catalog/analyzer-catalog.test.ts
git commit -m "feat(server): analyzer model catalog across Ollama, Gemini and endpoints"
```

---
### Task 3c.6: Routes, OpenAPI, mocks and client — catalog GET, Test POST, preview POST

**Files:**
- Create: `server/src/analyzer/model-test-deps.ts`, `server/src/routes/analyzer-models.ts`
- Modify: `server/src/app.ts` — mount beside 3b's `analyzerEndpointsRouter` (2b63b451 neighbourhood: after `:319`)
- Modify: `openapi.yaml` — three paths after 3b's `/api/analyzer/endpoints/detect-context:` path; schemas before `    UserSettingsPatch:` (`:4809`); `analyzerCapabilitiesByModel` (readOnly) after the Task 3c.2 property in `UserSettings`
- Modify (generated): `src/lib/api-types.ts`
- Modify: `src/lib/types.ts` (after `UserSettingsPatch`, `:141-145`), `src/lib/api.ts` (`MOCK_USER_SETTINGS` `:6930-6940`, real functions after `realPutGeminiKey` `:6979`, mock functions after `mockGetGpuDevices` `:8623`, `real` object `:9947`, `mock` object `:10259`)
- Create: `src/lib/structured-output-label.ts`
- Test: Create `server/src/routes/analyzer-models.test.ts`, `server/src/analyzer/model-test-deps.test.ts`, `src/lib/structured-output-label.test.ts`, `src/lib/api-analyzer-catalog-mock.test.ts`

**Interfaces:**
- Consumes: Tasks 3c.3–3c.5; `OllamaTransport`, `GeminiTransport` (W1), `OpenAITransport` (3b); `adaptSchemaFor*` (3b); `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError` (3b); `readUserSettings`, `writeAnalyzerCapabilityRecord`; `parseEndpointModelId`, `endpointModelId` (3a frontend + server).
- Produces: `modelTestDepsFor(modelId, settings): ModelTestDeps`, `GeminiKeyMissingForTestError`; `analyzerModelsRouter` with `GET /models`, `POST /models/test`, `POST /models/preview` mounted at `/api/analyzer`; operationIds `getAnalyzerModels`, `testAnalyzerModel` (contract) and `previewAnalyzerEndpointModels` (**addition to the contract's route table** — the add-endpoint form must list an unsaved endpoint's models to prefill `contextTokens`, and the catalog only lists saved endpoints); frontend `api.getAnalyzerModels(refresh?)`, `api.testAnalyzerModel(body)`, `api.previewAnalyzerEndpointModels(body)`; types `AnalyzerCatalog`, `AnalyzerCatalogGroup`, `AnalyzerCatalogEntry`, `ModelCapabilityRecord`, `AnalyzerModelTestRequest`, `AnalyzerEndpointModelsPreviewRequest`, `AnalyzerEndpointModelsPreview`, `StructuredOutputMode`; `structuredOutputLabel` frontend twin; exported mocks `mockGetAnalyzerModels`, `mockTestAnalyzerModel`, `mockPreviewAnalyzerEndpointModels`.

HTTP mapping for `POST /models/test`: 400 bad body; 404 `{ code: 'analyzer-endpoint-missing' }`; 401 `{ code: 'auth' }` for a key-origin mismatch or a Gemini model without a key; 502 `{ error }` when the test was inconclusive or a non-400 request failed (nothing persisted); 200 the saved record (a failed control request is a saved record).

Keeps green: `server/src/app.test.ts` if present (route mount), `src/lib/api-types.test.ts`, `npm run typecheck`.

- [ ] **Step 1: Write the failing tests**

Create `server/src/analyzer/model-test-deps.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { modelTestDepsFor, GeminiKeyMissingForTestError } from './model-test-deps.js';
import { AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from './errors.js';
import { OpenAITransport } from './transports/openai-transport.js';
import { OllamaTransport } from './transports/ollama-transport.js';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768, structuredOutput: 'json' });
const settings = (over: Partial<UserSettings> = {}): UserSettings => ({ ...DEFAULT_USER_SETTINGS, analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...over });

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe('modelTestDepsFor (#3084)', () => {
  it('endpoint model → OpenAITransport, the endpoint URL and its own structured-output mode', () => {
    const d = modelTestDepsFor('openai:lab::qwen3-30b', settings());
    expect(d.transport).toBeInstanceOf(OpenAITransport);
    expect(d.serverUrl).toBe('http://127.0.0.1:8080/v1');
    expect(d.configuredMode).toBe('json');
    expect(d.offeredLevels).toEqual(['configured']);
  });

  it('a missing endpoint throws AnalyzerEndpointMissingError', () => {
    expect(() => modelTestDepsFor('openai:gone::m', settings())).toThrow(AnalyzerEndpointMissingError);
  });

  it('a key bound to another origin throws AnalyzerKeyOriginError before any transport exists', () => {
    expect(() =>
      modelTestDepsFor('openai:lab::m', settings({ analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'k' } } })),
    ).toThrow(AnalyzerKeyOriginError);
  });

  it('Ollama model → OllamaTransport and the Ollama URL', () => {
    const d = modelTestDepsFor('qwen3.5:4b', settings());
    expect(d.transport).toBeInstanceOf(OllamaTransport);
    expect(d.serverUrl).toBe('http://localhost:11434');
  });

  it('Gemini model without a key throws GeminiKeyMissingForTestError', () => {
    expect(() => modelTestDepsFor('gemini-3.6-flash', settings())).toThrow(GeminiKeyMissingForTestError);
  });
});
```

Create `server/src/routes/analyzer-models.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AnalyzerEndpointMissingError, AnalyzerKeyOriginError, AnalyzerHttpError } from '../analyzer/errors.js';

const h = vi.hoisted(() => ({
  buildAnalyzerCatalog: vi.fn(),
  previewEndpointModels: vi.fn(),
  modelTestDepsFor: vi.fn(),
  runModelTest: vi.fn(),
  writeAnalyzerCapabilityRecord: vi.fn(),
  readUserSettings: vi.fn(),
}));

vi.mock('../analyzer/catalog/analyzer-catalog.js', () => ({
  buildAnalyzerCatalog: h.buildAnalyzerCatalog,
  previewEndpointModels: h.previewEndpointModels,
}));
vi.mock('../analyzer/model-test-deps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analyzer/model-test-deps.js')>()),
  modelTestDepsFor: h.modelTestDepsFor,
}));
vi.mock('../analyzer/capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analyzer/capabilities.js')>()),
  runModelTest: h.runModelTest,
}));
vi.mock('../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/user-settings.js')>()),
  readUserSettings: h.readUserSettings,
  writeAnalyzerCapabilityRecord: h.writeAnalyzerCapabilityRecord,
}));

const { analyzerModelsRouter } = await import('./analyzer-models.js');
const { DEFAULT_USER_SETTINGS } = await import('../workspace/user-settings.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analyzer', analyzerModelsRouter);
  return app;
}

const RECORD = {
  serverUrl: 'http://127.0.0.1:8080/v1',
  testedAt: '2026-09-11T10:00:00.000Z',
  control: { ok: true },
  structuredOutput: { schema: { configured: 'ignored' } },
  reasoning: {},
};

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.readUserSettings.mockResolvedValue({
    ...DEFAULT_USER_SETTINGS,
    analyzerEndpoints: [],
    analyzerEndpointKeys: { lab: { origin: 'http://127.0.0.1:8080', key: 'sk-stored' } },
  });
});

describe('GET /api/analyzer/models', () => {
  it('passes refresh=1 through and returns the catalog', async () => {
    h.buildAnalyzerCatalog.mockResolvedValue({ groups: [] });
    const res = await request(makeApp()).get('/api/analyzer/models?refresh=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [] });
    expect(h.buildAnalyzerCatalog).toHaveBeenCalledWith({ refresh: true });
  });

  it('defaults refresh to false', async () => {
    h.buildAnalyzerCatalog.mockResolvedValue({ groups: [] });
    await request(makeApp()).get('/api/analyzer/models');
    expect(h.buildAnalyzerCatalog).toHaveBeenCalledWith({ refresh: false });
  });
});

describe('POST /api/analyzer/models/test', () => {
  it('runs the test, persists the record and returns it', async () => {
    const deps = { transport: {} };
    h.modelTestDepsFor.mockReturnValue(deps);
    h.runModelTest.mockResolvedValue(RECORD);
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RECORD);
    expect(h.runModelTest).toHaveBeenCalledWith({ modelId: 'openai:lab::m', scope: 'all' }, deps);
    expect(h.writeAnalyzerCapabilityRecord).toHaveBeenCalledWith('openai:lab::m', RECORD);
  });

  it('400 on a bad scope', async () => {
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'm', scope: 'everything' });
    expect(res.status).toBe(400);
  });

  it('404 analyzer-endpoint-missing for a deleted endpoint', async () => {
    h.modelTestDepsFor.mockImplementation(() => {
      throw new AnalyzerEndpointMissingError('gone', 'settings');
    });
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:gone::m', scope: 'configured' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('analyzer-endpoint-missing');
  });

  it('401 auth for a key bound to another host', async () => {
    h.modelTestDepsFor.mockImplementation(() => {
      throw new AnalyzerKeyOriginError('lab', 'Lab');
    });
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'configured' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth');
  });

  it('502 and nothing persisted when the test fails after a good control', async () => {
    h.modelTestDepsFor.mockReturnValue({});
    h.runModelTest.mockRejectedValue(new AnalyzerHttpError('openai', 503, 'loading', 'HTTP 503 loading'));
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'configured' });
    expect(res.status).toBe(502);
    expect(h.writeAnalyzerCapabilityRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/analyzer/models/preview', () => {
  it('uses the stored key only when its origin matches the previewed base URL', async () => {
    h.previewEndpointModels.mockResolvedValue({ status: 'ok', models: [] });
    await request(makeApp()).post('/api/analyzer/models/preview').send({ baseUrl: 'http://127.0.0.1:8080/v1', endpointId: 'lab' });
    expect(h.previewEndpointModels).toHaveBeenLastCalledWith({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'sk-stored' });
    await request(makeApp()).post('/api/analyzer/models/preview').send({ baseUrl: 'http://10.0.0.5:8080/v1', endpointId: 'lab' });
    expect(h.previewEndpointModels).toHaveBeenLastCalledWith({ baseUrl: 'http://10.0.0.5:8080/v1', apiKey: null });
  });

  it('a typed key wins and is never echoed back', async () => {
    h.previewEndpointModels.mockResolvedValue({ status: 'ok', models: [{ model: 'm', contextTokens: 8192 }], suggestedContextTokens: 8192 });
    const res = await request(makeApp()).post('/api/analyzer/models/preview').send({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-typed' });
    expect(h.previewEndpointModels).toHaveBeenLastCalledWith({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-typed' });
    expect(JSON.stringify(res.body)).not.toContain('sk-typed');
  });
});
```

Create `src/lib/structured-output-label.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import cases from '../../server/src/analyzer/__fixtures__/structured-output-label-cases.json';
import { structuredOutputLabel } from './structured-output-label';
import type { ModelCapabilityRecord, StructuredOutputMode } from './types';

type LabelCase = { mode: StructuredOutputMode; dropped: string[]; outcome: 'enforced' | 'ignored' | 'rejected' | null; expected: string };

describe('structuredOutputLabel frontend twin (#3084) — same table as the server', () => {
  it.each(cases as LabelCase[])('$mode dropped=$dropped outcome=$outcome → $expected', (c) => {
    const record: ModelCapabilityRecord | undefined =
      c.outcome === null
        ? undefined
        : { serverUrl: 'x', testedAt: '2026-09-11T00:00:00.000Z', control: { ok: true }, structuredOutput: { [c.mode]: { configured: c.outcome } }, reasoning: {} };
    expect(structuredOutputLabel(c.mode, c.dropped, record, 'configured')).toBe(c.expected);
  });
});
```

Create `src/lib/api-analyzer-catalog-mock.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mockGetAnalyzerModels, mockTestAnalyzerModel } from './api';
import type { ModelCapabilityRecord, UserSettings } from './types';

const endpoint = {
  id: 'lab-server', name: 'Lab server', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', concurrency: 1, requestCeilingMs: 1_800_000,
  structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 32768,
} as NonNullable<UserSettings['analyzerEndpoints']>[number];

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__SEED_ENDPOINT_MODELS__;
  delete g.__SEED_ANALYZER_CAPABILITIES__;
});

describe('mockGetAnalyzerModels (#3084)', () => {
  it('lists one group per saved endpoint with seeded models and the W3 test plan', async () => {
    (globalThis as Record<string, unknown>).__SEED_ENDPOINT_MODELS__ = { 'lab-server': ['qwen3-30b'] };
    const catalog = await mockGetAnalyzerModels(false, { analyzerEndpoints: [endpoint], analyzerCapabilitiesByModel: {}, apiKeyStatus: 'unset' });
    const group = catalog.groups.find((g) => g.kind === 'endpoint');
    expect(group).toMatchObject({ id: 'lab-server', label: 'Lab server', status: 'ok' });
    expect(group?.models[0]).toMatchObject({ id: 'openai:lab-server::qwen3-30b', label: 'qwen3-30b', engine: 'openai', testPlan: { configured: 2, all: 3 } });
    expect(Object.keys(catalog)).toEqual(['groups']);
    expect(catalog.groups.find((g) => g.kind === 'gemini')).toMatchObject({ status: 'fallback', models: [] });
  });

  it('labels from a seeded Test record for the same server URL', async () => {
    const rec: ModelCapabilityRecord = { serverUrl: 'http://127.0.0.1:8080/v1', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: { schema: { configured: 'ignored' } }, reasoning: {} };
    (globalThis as Record<string, unknown>).__SEED_ENDPOINT_MODELS__ = { 'lab-server': ['qwen3-30b'] };
    (globalThis as Record<string, unknown>).__SEED_ANALYZER_CAPABILITIES__ = { 'openai:lab-server::qwen3-30b': rec };
    const catalog = await mockGetAnalyzerModels(false, { analyzerEndpoints: [endpoint], analyzerCapabilitiesByModel: {}, apiKeyStatus: 'unset' });
    const entry = catalog.groups.find((g) => g.kind === 'endpoint')?.models[0];
    expect(entry?.capability).toEqual(rec);
    expect(entry?.structuredOutput.label).toBe('schema (not enforced)');
  });

  it('mockTestAnalyzerModel returns a record for the configured mode', async () => {
    const rec = await mockTestAnalyzerModel({ modelId: 'qwen3.5:4b', scope: 'configured' });
    expect(rec.control).toEqual({ ok: true });
    expect(rec.structuredOutput.schema?.configured).toBe('enforced');
  });
});
```

(The `'schema (not enforced)'` literal must equal row 5 of the captured table.)

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/model-test-deps.test.ts src/routes/analyzer-models.test.ts` and `npx vitest run src/lib/structured-output-label.test.ts src/lib/api-analyzer-catalog-mock.test.ts`
Expected: FAIL — `Failed to load url ./model-test-deps.js` / `./analyzer-models.js`; frontend `Failed to resolve import "./structured-output-label"` and `mockGetAnalyzerModels is not a function`.

- [ ] **Step 3: Implement**

Create `server/src/analyzer/model-test-deps.ts`:

```ts
/* #3084 W3 — builds the Test action's dependencies for one model id: the transport,
   the server URL its record binds to, the configured structured-output mode, and the
   provider's schema adapter. Enforces the key-origin rule before any transport exists. */
import { configValue } from '../config/resolver.js';
import { getResolvedGeminiApiKey, getResolvedOllamaUrl, type UserSettings } from '../workspace/user-settings.js';
import { resolveEndpointApiKey } from '../workspace/analyzer-endpoints.js';
import { inferEngineFromModelId, parseEndpointModelId } from './model-id.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import { OllamaTransport } from './transports/ollama-transport.js';
import { GeminiTransport } from './transports/gemini-transport.js';
import { OpenAITransport } from './transports/openai-transport.js';
import { adaptSchemaForGemini, adaptSchemaForOllama, adaptSchemaForOpenAI } from './runner/schema-adapters.js';
import { ALL_STRUCTURED_OUTPUT_MODES, CONFIGURED_LEVEL_KEY, type ModelTestDeps } from './capabilities.js';
import type { StructuredOutputMode } from './runner/transport.js';

export class GeminiKeyMissingForTestError extends Error {
  constructor() {
    super('Add a Gemini API key before testing a Gemini model.');
    this.name = 'GeminiKeyMissingForTestError';
  }
}

export function modelTestDepsFor(modelId: string, settings: UserSettings): ModelTestDeps {
  const offered = { offeredModes: ALL_STRUCTURED_OUTPUT_MODES, offeredLevels: [CONFIGURED_LEVEL_KEY] };
  const engine = inferEngineFromModelId(modelId);
  if (engine === 'openai') {
    const parsed = parseEndpointModelId(modelId);
    const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
    if (!parsed || !endpoint) throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? modelId, 'settings');
    // 3b Task 3b.5: null when no key is saved; throws AnalyzerKeyOriginError before any request.
    const apiKey = resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl);
    return {
      ...offered,
      transport: new OpenAITransport({ endpoint, apiKey, model: parsed.model }),
      serverUrl: endpoint.baseUrl,
      configuredMode: endpoint.structuredOutput,
      adaptSchema: adaptSchemaForOpenAI,
    };
  }
  if (engine === 'gemini') {
    const apiKey = getResolvedGeminiApiKey();
    if (!apiKey) throw new GeminiKeyMissingForTestError();
    return {
      ...offered,
      transport: new GeminiTransport({ apiKey, model: modelId }),
      serverUrl: 'gemini',
      configuredMode: configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput'),
      adaptSchema: adaptSchemaForGemini,
    };
  }
  const url = getResolvedOllamaUrl();
  return {
    ...offered,
    transport: new OllamaTransport({ url, model: modelId }),
    serverUrl: url,
    configuredMode: configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput'),
    adaptSchema: adaptSchemaForOllama,
  };
}
```

Create `server/src/routes/analyzer-models.ts`:

```ts
/* #3084 W3 — GET /api/analyzer/models (catalog), POST /api/analyzer/models/test (Test
   action), POST /api/analyzer/models/preview (list an unsaved endpoint's models so the
   add form can prefill its served context). Keys are never returned or logged. */
import { Router } from 'express';
import { z } from 'zod';
import type { Request, Response } from '../http.js';
import { buildAnalyzerCatalog, previewEndpointModels } from '../analyzer/catalog/analyzer-catalog.js';
import { runModelTest } from '../analyzer/capabilities.js';
import { modelTestDepsFor, GeminiKeyMissingForTestError } from '../analyzer/model-test-deps.js';
import { AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from '../analyzer/errors.js';
import { keyOriginMatches } from '../workspace/analyzer-endpoints.js';
import { readUserSettings, writeAnalyzerCapabilityRecord } from '../workspace/user-settings.js';

export const analyzerModelsRouter = Router();

analyzerModelsRouter.get('/models', async (req: Request, res: Response) => {
  try {
    res.json(await buildAnalyzerCatalog({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    console.error('[analyzer-models] GET /models failed', err);
    res.status(500).json({ error: 'Failed to list analyzer models.' });
  }
});

const testBodySchema = z.object({
  modelId: z.string().min(1).max(400),
  scope: z.enum(['configured', 'all']),
});

analyzerModelsRouter.post('/models/test', async (req: Request, res: Response) => {
  const parsed = testBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload.', issues: parsed.error.issues });
  const { modelId, scope } = parsed.data;
  let deps;
  try {
    deps = modelTestDepsFor(modelId, await readUserSettings());
  } catch (err) {
    if (err instanceof AnalyzerEndpointMissingError) {
      return res.status(404).json({ error: err.message, code: 'analyzer-endpoint-missing' });
    }
    if (err instanceof AnalyzerKeyOriginError || err instanceof GeminiKeyMissingForTestError) {
      return res.status(401).json({ error: err.message, code: 'auth' });
    }
    throw err;
  }
  try {
    const record = await runModelTest({ modelId, scope }, deps);
    await writeAnalyzerCapabilityRecord(modelId, record);
    return res.json(record);
  } catch (err) {
    console.warn(`[analyzer-models] test of ${modelId} did not complete: ${(err as Error).name}`);
    return res.status(502).json({ error: ((err as Error).message ?? 'Model test failed.').slice(0, 500) });
  }
});

const previewBodySchema = z.object({
  baseUrl: z.string().url().max(2000),
  endpointId: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  apiKey: z.string().min(1).max(4000).optional(),
});

analyzerModelsRouter.post('/models/preview', async (req: Request, res: Response) => {
  const parsed = previewBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload.', issues: parsed.error.issues });
  const { baseUrl, endpointId, apiKey } = parsed.data;
  let key: string | null = apiKey ?? null;
  if (key === null && endpointId) {
    const stored = (await readUserSettings()).analyzerEndpointKeys[endpointId];
    if (stored && keyOriginMatches(stored, baseUrl)) key = stored.key;
  }
  res.json(await previewEndpointModels({ baseUrl, apiKey: key }));
});
```

`server/src/app.ts` — import `import { analyzerModelsRouter } from './routes/analyzer-models.js';` beside the other route imports, and mount next to 3b's endpoints router:

```ts
app.use('/api/analyzer', analyzerModelsRouter); // #3084 — GET /models (catalog), POST /models/test (Test action), POST /models/preview
```

`openapi.yaml` — paths, after 3b's `/api/analyzer/endpoints/detect-context:` block:

```yaml
  /api/analyzer/models:
    get:
      summary: List analyzer models for Ollama, Gemini and every saved endpoint
      operationId: getAnalyzerModels
      description: |
        #3084 — grouped live catalogs with a 30 s server cache. A failed Ollama or endpoint
        listing keeps its group with `status: error` and no models; Gemini without a key, or
        with a failed listing, is `status: fallback` with no models (the client overlays its
        curated list). Entries carry a label, served context/output limits when known, the
        structured-output label, and the Test record whose `serverUrl` still matches.
      parameters:
        - name: refresh
          in: query
          required: false
          schema: { type: string, enum: ['1'] }
      responses:
        '200':
          description: Catalog
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerCatalog' }
        '500':
          description: Listing failed unexpectedly
  /api/analyzer/models/test:
    post:
      summary: Test what a model accepts and enforces (structured output)
      operationId: testAnalyzerModel
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AnalyzerModelTestRequest' }
      responses:
        '200':
          description: The saved capability record (a failed control request is still saved)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ModelCapabilityRecord' }
        '400': { description: Invalid body }
        '401': { description: 'Key bound to another host, or Gemini key missing (code: auth)' }
        '404': { description: 'Endpoint no longer configured (code: analyzer-endpoint-missing)' }
        '502': { description: Inconclusive test or request failure; nothing saved }
  /api/analyzer/models/preview:
    post:
      summary: List an endpoint's models before it is saved (context prefill)
      operationId: previewAnalyzerEndpointModels
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AnalyzerEndpointModelsPreviewRequest' }
      responses:
        '200':
          description: Listing outcome
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointModelsPreview' }
        '400': { description: Invalid body }
```

Schemas, before `    UserSettingsPatch:`:

```yaml
    ProbeOutcomeByLevel:
      type: object
      additionalProperties: { type: string, enum: [enforced, ignored, rejected, accepted] }
    ModelCapabilityRecord:
      type: object
      required: [serverUrl, testedAt, control, structuredOutput, reasoning]
      properties:
        serverUrl: { type: string }
        testedAt: { type: string, format: date-time }
        control:
          type: object
          required: [ok]
          properties:
            ok: { type: boolean }
            error: { type: string }
        structuredOutput:
          type: object
          properties:
            schema: { $ref: '#/components/schemas/ProbeOutcomeByLevel' }
            json: { $ref: '#/components/schemas/ProbeOutcomeByLevel' }
            off: { $ref: '#/components/schemas/ProbeOutcomeByLevel' }
        reasoning:
          type: object
          additionalProperties: { type: string, enum: [accepted, rejected] }
    AnalyzerCatalogEntry:
      type: object
      description: |
        Master-contract fields id, label, contextTokens, outputTokens, capability
        (offeredReasoningLevels arrives in wave 5); W3c adds engine, model,
        structuredOutput and testPlan.
      required: [id, label, engine, model, structuredOutput, testPlan]
      properties:
        id: { type: string }
        label: { type: string, description: "Gemini displayName or id; the Ollama tag; an endpoint's bare model name" }
        contextTokens: { type: integer, minimum: 1 }
        outputTokens: { type: integer, minimum: 1 }
        capability: { $ref: '#/components/schemas/ModelCapabilityRecord' }
        engine: { type: string, enum: [local, gemini, openai] }
        model: { type: string }
        structuredOutput:
          type: object
          required: [mode, dropped, label]
          properties:
            mode: { type: string, enum: [schema, json, 'off'] }
            dropped: { type: array, items: { type: string } }
            label: { type: string }
        testPlan:
          type: object
          required: [configured, all]
          properties:
            configured: { type: integer }
            all: { type: integer }
    AnalyzerCatalogGroup:
      type: object
      required: [kind, id, label, status, models]
      properties:
        kind: { type: string, enum: [ollama, gemini, endpoint] }
        id: { type: string }
        label: { type: string }
        status:
          type: string
          enum: [ok, fallback, error]
          description: 'fallback = Gemini without a key or with a failed listing (no models; the client overlays its curated list); error = an Ollama or endpoint listing failed (no models)'
        error: { type: string }
        models: { type: array, items: { $ref: '#/components/schemas/AnalyzerCatalogEntry' } }
    AnalyzerCatalog:
      type: object
      required: [groups]
      properties:
        groups: { type: array, items: { $ref: '#/components/schemas/AnalyzerCatalogGroup' } }
    AnalyzerModelTestRequest:
      type: object
      required: [modelId, scope]
      properties:
        modelId: { type: string }
        scope: { type: string, enum: [configured, all] }
    AnalyzerEndpointModelsPreviewRequest:
      type: object
      required: [baseUrl]
      properties:
        baseUrl: { type: string, format: uri }
        endpointId: { type: string, pattern: '^[a-z0-9-]{1,40}$' }
        apiKey: { type: string, writeOnly: true }
    AnalyzerEndpointModelsPreview:
      type: object
      required: [status, models]
      properties:
        status: { type: string, enum: [ok, failed] }
        error: { type: string }
        models:
          type: array
          items:
            type: object
            required: [model]
            properties:
              model: { type: string }
              contextTokens: { type: integer }
              maxOutputTokens: { type: integer }
        suggestedContextTokens: { type: integer }

```

In `UserSettings`, after `analyzerRateLimitsByModel`:

```yaml
        analyzerCapabilitiesByModel:
          type: object
          readOnly: true
          additionalProperties: { $ref: '#/components/schemas/ModelCapabilityRecord' }
          description: '#3084 — Test-action records keyed by model id; server-written only.'
```

Run `npm run openapi:types`.

`src/lib/types.ts`, after the `UserSettingsPatch` declaration:

```ts
export type AnalyzerCatalog = components['schemas']['AnalyzerCatalog'];
export type AnalyzerCatalogGroup = components['schemas']['AnalyzerCatalogGroup'];
export type AnalyzerCatalogEntry = components['schemas']['AnalyzerCatalogEntry'];
export type ModelCapabilityRecord = components['schemas']['ModelCapabilityRecord'];
export type AnalyzerModelTestRequest = components['schemas']['AnalyzerModelTestRequest'];
export type AnalyzerEndpointModelsPreviewRequest = components['schemas']['AnalyzerEndpointModelsPreviewRequest'];
export type AnalyzerEndpointModelsPreview = components['schemas']['AnalyzerEndpointModelsPreview'];
export type StructuredOutputMode = AnalyzerCatalogEntry['structuredOutput']['mode'];
```

Create `src/lib/structured-output-label.ts` — a line-for-line twin of 3b's server `structuredOutputLabel` (`runner/schema-adapters.ts`, 3b Task 3b.3), kept honest by the shared case table. 3b's adapters remove `$schema` silently, so `$schema` never reaches `dropped`; any entry in `dropped` is a real constraint:

```ts
/* #3084 — frontend twin of server/src/analyzer/runner/schema-adapters.ts
   structuredOutputLabel, used by the mock catalog. Driven by the same case table
   (server/src/analyzer/__fixtures__/structured-output-label-cases.json). */
import type { ModelCapabilityRecord, StructuredOutputMode } from './types';

export function structuredOutputLabel(
  mode: StructuredOutputMode,
  dropped: readonly string[],
  record: ModelCapabilityRecord | undefined,
  reasoningKey: string,
): string {
  if (mode !== 'schema') return mode;
  if (record?.structuredOutput.schema?.[reasoningKey] === 'ignored') return 'schema (not enforced)';
  return dropped.length > 0 ? 'schema (partial)' : 'schema';
}
```

`src/lib/api.ts`:
- `MOCK_USER_SETTINGS` (`:6939`): add `analyzerCapabilitiesByModel: {},`.
- Imports: add `AnalyzerCatalog`, `AnalyzerCatalogEntry`, `ModelCapabilityRecord`, `AnalyzerModelTestRequest`, `AnalyzerEndpointModelsPreviewRequest`, `AnalyzerEndpointModelsPreview`, `StructuredOutputMode` to the existing `./types` type import; `import { structuredOutputLabel } from './structured-output-label';`; `import { endpointModelId, parseEndpointModelId } from './model-id';`.
- After `realPutGeminiKey` (`:6979`):

```ts
async function realGetAnalyzerModels(refresh = false): Promise<AnalyzerCatalog> {
  const res = await fetch(`/api/analyzer/models${refresh ? '?refresh=1' : ''}`);
  if (!res.ok) throw new Error(`Analyzer model list failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}

async function realTestAnalyzerModel(body: AnalyzerModelTestRequest): Promise<ModelCapabilityRecord> {
  const res = await fetch('/api/analyzer/models/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Model test failed (${res.status})`);
  }
  return res.json();
}

async function realPreviewAnalyzerEndpointModels(body: AnalyzerEndpointModelsPreviewRequest): Promise<AnalyzerEndpointModelsPreview> {
  const res = await fetch('/api/analyzer/models/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Model preview failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}
```

- After `mockGetGpuDevices` (`:8623`):

```ts
/* #3084 — mock catalog derived from the mock settings' endpoints. Seeds (e2e):
   __SEED_ANALYZER_CATALOG__ (whole response), __SEED_ENDPOINT_MODELS__ (endpointId →
   model names), __SEED_ANALYZER_CAPABILITIES__ (modelId → Test record),
   __SEED_TEST_OUTCOME__ (schema outcome mockTestAnalyzerModel records). testPlan mirrors
   the server's plannedTestRequestCount for W3: configured = the off-mode control + 1 (just the
   control for an `off` model), all = control + the schema and json checks. Group statuses
   follow the contract: Gemini without a key is `fallback`. */
type MockCatalogSource = Pick<UserSettings, 'analyzerEndpoints' | 'analyzerCapabilitiesByModel' | 'apiKeyStatus'>;

function mockServerUrlFor(modelId: string, source: MockCatalogSource): string {
  const parsed = parseEndpointModelId(modelId);
  if (parsed) return source.analyzerEndpoints?.find((e) => e.id === parsed.endpointId)?.baseUrl ?? '';
  return modelId.includes(':') ? 'http://localhost:11434' : 'gemini';
}

export async function mockGetAnalyzerModels(_refresh = false, source: MockCatalogSource = MOCK_USER_SETTINGS): Promise<AnalyzerCatalog> {
  await wait(30);
  const g = globalThis as unknown as {
    __SEED_ANALYZER_CATALOG__?: AnalyzerCatalog;
    __SEED_ENDPOINT_MODELS__?: Record<string, string[]>;
    __SEED_ANALYZER_CAPABILITIES__?: Record<string, ModelCapabilityRecord>;
  };
  if (g.__SEED_ANALYZER_CATALOG__) return g.__SEED_ANALYZER_CATALOG__;
  const capabilities = { ...(source.analyzerCapabilitiesByModel ?? {}), ...(g.__SEED_ANALYZER_CAPABILITIES__ ?? {}) };
  const entry = (id: string, engine: AnalyzerCatalogEntry['engine'], model: string, mode: StructuredOutputMode, droppedIfSchema: string[]): AnalyzerCatalogEntry => {
    const serverUrl = mockServerUrlFor(id, source).replace(/\/+$/, '');
    const stored = capabilities[id];
    const record = stored && stored.serverUrl.replace(/\/+$/, '') === serverUrl ? stored : undefined;
    const dropped = mode === 'schema' ? droppedIfSchema : [];
    return {
      id,
      label: model,
      ...(record ? { capability: record } : {}),
      engine,
      model,
      structuredOutput: { mode, dropped, label: structuredOutputLabel(mode, dropped, record, 'configured') },
      testPlan: { configured: mode === 'off' ? 1 : 2, all: 3 },
    };
  };
  return {
    groups: [
      { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [entry('qwen3.5:4b', 'local', 'qwen3.5:4b', 'schema', [])] },
      source.apiKeyStatus === 'set'
        ? { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [entry('gemini-3.5-flash-lite', 'gemini', 'gemini-3.5-flash-lite', 'json', [])] }
        : { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'fallback', models: [] },
      ...(source.analyzerEndpoints ?? []).map((e) => ({
        kind: 'endpoint' as const,
        id: e.id,
        label: e.name,
        status: 'ok' as const,
        models: (g.__SEED_ENDPOINT_MODELS__?.[e.id] ?? ['mock-model']).map((m) =>
          entry(endpointModelId(e.id, m), 'openai', m, e.structuredOutput ?? 'schema', []),
        ),
      })),
    ],
  };
}

export async function mockTestAnalyzerModel(body: AnalyzerModelTestRequest): Promise<ModelCapabilityRecord> {
  await wait(60);
  const seeded = (globalThis as unknown as { __SEED_TEST_OUTCOME__?: 'enforced' | 'ignored' | 'rejected' }).__SEED_TEST_OUTCOME__ ?? 'enforced';
  const catalog = await mockGetAnalyzerModels(false);
  const mode = catalog.groups.flatMap((x) => x.models).find((m) => m.id === body.modelId)?.structuredOutput.mode ?? 'schema';
  const record: ModelCapabilityRecord = {
    serverUrl: mockServerUrlFor(body.modelId, MOCK_USER_SETTINGS),
    testedAt: new Date().toISOString(),
    control: { ok: true },
    structuredOutput:
      body.scope === 'all'
        ? { schema: { configured: seeded }, json: { configured: 'accepted' }, off: { configured: 'accepted' } }
        : { [mode]: { configured: mode === 'schema' ? seeded : 'accepted' } },
    reasoning: {},
  };
  Object.assign(MOCK_USER_SETTINGS, {
    analyzerCapabilitiesByModel: { ...(MOCK_USER_SETTINGS.analyzerCapabilitiesByModel ?? {}), [body.modelId]: record },
  });
  return record;
}

export async function mockPreviewAnalyzerEndpointModels(_body: AnalyzerEndpointModelsPreviewRequest): Promise<AnalyzerEndpointModelsPreview> {
  await wait(40);
  const seeded = (globalThis as unknown as { __SEED_ENDPOINT_PREVIEW__?: AnalyzerEndpointModelsPreview }).__SEED_ENDPOINT_PREVIEW__;
  return seeded ?? { status: 'ok', models: [{ model: 'mock-model', contextTokens: 32768 }], suggestedContextTokens: 32768 };
}
```

- `real` object (`:9947`): add `getAnalyzerModels: realGetAnalyzerModels, testAnalyzerModel: realTestAnalyzerModel, previewAnalyzerEndpointModels: realPreviewAnalyzerEndpointModels,`.
- `mock` object (`:10259`): add `getAnalyzerModels: mockGetAnalyzerModels, testAnalyzerModel: mockTestAnalyzerModel, previewAnalyzerEndpointModels: mockPreviewAnalyzerEndpointModels,`.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/model-test-deps.test.ts src/routes/analyzer-models.test.ts`, `npx vitest run src/lib/structured-output-label.test.ts src/lib/api-analyzer-catalog-mock.test.ts src/lib/api-types.test.ts`, `npm run typecheck`, `npm run check:cycles`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. Route `POST /models/test`: move `await writeAnalyzerCapabilityRecord(modelId, record);` into the `catch` before the 502 → red: "502 and nothing persisted…", "runs the test, persists the record…". Restore.
2. Route preview: drop the `keyOriginMatches(stored, baseUrl)` condition → red: "uses the stored key only when its origin matches…". Restore.
3. `structured-output-label.ts`: change `dropped.length > 0` to `false` → red: the frontend table test on the rows with a non-empty `dropped` and no `ignored` outcome (rows 2 and 3). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/model-test-deps.ts server/src/analyzer/model-test-deps.test.ts server/src/routes/analyzer-models.ts server/src/routes/analyzer-models.test.ts server/src/app.ts openapi.yaml src/lib/api-types.ts src/lib/types.ts src/lib/api.ts src/lib/structured-output-label.ts src/lib/structured-output-label.test.ts src/lib/api-analyzer-catalog-mock.test.ts
git commit -m "feat(server,openapi): analyzer catalog, model Test and endpoint preview routes"
```

---
### Task 3c.7: Frontend catalog state, `modelLabel(id)` and the nine label sites

**Files:**
- Create: `src/lib/model-label.ts`
- Modify: `src/lib/models.ts:172-198` (add `ModelOptionGroup` + `buildCatalogOptionGroups`; `buildModelOptionGroups` unchanged in this PR)
- Modify: `src/store/account-slice.ts:22-47` (state), `:81` (thunk), `:193-196` (reducer)
- Modify the nine label sites (re-grep first, see Step 3): `src/components/account-forms.tsx:10,16-19`; `src/components/model-settings-form.tsx:313,317,327` (callers); `src/components/analyzer-model-override-badge.tsx:16-20,38-39`; `src/components/analysing/phase-model-swap.tsx:2,81-82`; `src/components/analysing/phase-model-chip.tsx:1,70-75`; `src/components/analysing/phase-card.tsx:9,354`; `src/components/status-popover.tsx:35,165,307`; `src/components/analysis-model-picker.tsx:43`
- Test: Create `src/lib/model-label.test.ts`, `src/lib/model-label.guard.test.ts`, `src/lib/models.catalog-groups.test.ts`

**Interfaces:**
- Consumes: `AnalyzerCatalog` types (Task 3c.6); `parseEndpointModelId` (3a, `src/lib/model-id.ts`); `api.getAnalyzerModels`.
- Produces: `modelLabel(id: string, catalog?: AnalyzerCatalog | null): string`; `catalogEntryFor(id, catalog)`; `runLabelSuffixes(entry)` (the wave-5 hook: W3 returns `[structuredOutput.label]`, W5 appends `'+ custom params'`); `ModelOptionGroup`; `buildCatalogOptionGroups(catalog, opts, curated?)`; `AccountState.analyzerCatalog`; `fetchAnalyzerCatalog` thunk; `analyzerModelLabel(id, catalog?)`.

Label resolution order (spec §3 "Labels"): curated `MODEL_OPTIONS` label → for an endpoint id, `<endpoint name> · <model>` (endpoint id when the catalog is absent) → the catalog entry's `label` (Gemini's live `displayName`, else its id; the Ollama tag) → the raw id. An endpoint entry's own `label` is the bare model name, which is why endpoint ids are resolved before the entry label. Components that already read the store pass the catalog; `phase-card.tsx`'s throttle countdown and `status-popover.tsx` do not have a store read at those sites and call `modelLabel(id)` (curated + endpoint-id parsing still apply).

`buildCatalogOptionGroups` keeps plan 221's installed-only rule for Ollama (models.ts:144-155): a failed Ollama listing yields an empty group, not the curated list. The curated fallback applies to Gemini (whose curated list always showed before this change). Endpoint groups are included only when `opts.includeEndpoints` is true — 3c's only caller is the limits editor; the pickers switch in 3d.

Keeps green: `src/components/analysing/phase-model-chip.test.tsx`, `src/components/model-settings-form.test.tsx`, `src/lib/models.test.ts`, `src/store/account-slice.test.ts` (if present), `src/components/status-popover*.test.tsx`, `npm run typecheck`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/model-label.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { modelLabel, catalogEntryFor, runLabelSuffixes } from './model-label';
import type { AnalyzerCatalog } from './types';

const catalog: AnalyzerCatalog = {
  groups: [
    {
      kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok',
      models: [{ id: 'gemini-4.0-flash', label: 'Gemini 4.0 Flash', engine: 'gemini', model: 'gemini-4.0-flash', structuredOutput: { mode: 'json', dropped: [], label: 'json' }, testPlan: { configured: 2, all: 3 } }],
    },
    {
      kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok',
      models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai', model: 'qwen3-30b', structuredOutput: { mode: 'schema', dropped: ['$schema'], label: 'schema (not enforced)' }, testPlan: { configured: 2, all: 3 } }],
    },
  ],
};

describe('modelLabel (#3084)', () => {
  it('curated label first', () => {
    expect(modelLabel('qwen3.5:4b', catalog)).toBe('Qwen3.5 4B (local)');
  });
  it('the catalog entry label (live displayName) for an uncurated model', () => {
    expect(modelLabel('gemini-4.0-flash', catalog)).toBe('Gemini 4.0 Flash');
  });
  it('endpoint name · model for an endpoint id', () => {
    expect(modelLabel('openai:lab::qwen3-30b', catalog)).toBe('Lab server · qwen3-30b');
  });
  it('endpoint id · model when no catalog is loaded', () => {
    expect(modelLabel('openai:lab::qwen3-30b')).toBe('lab · qwen3-30b');
  });
  it('raw id otherwise (including an Ollama tag named openai:latest)', () => {
    expect(modelLabel('mistral:7b', catalog)).toBe('mistral:7b');
    expect(modelLabel('openai:latest', catalog)).toBe('openai:latest');
  });
  it('catalogEntryFor + runLabelSuffixes expose the structured-output label (W5 appends custom params)', () => {
    expect(runLabelSuffixes(catalogEntryFor('openai:lab::qwen3-30b', catalog))).toEqual(['schema (not enforced)']);
    expect(runLabelSuffixes(catalogEntryFor('unknown', catalog))).toEqual([]);
  });
});
```

Create `src/lib/model-label.guard.test.ts`:

```ts
/* #3084 — every analyzer model label goes through modelLabel. A new
   MODEL_OPTIONS.find(...) label lookup silently shows raw ids for live-listed and
   endpoint models; this fails the build instead. TTS_MODEL_OPTIONS is excluded by
   the lookbehind. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('analyzer model labels go through modelLabel (#3084)', () => {
  it('no source file resolves a label with MODEL_OPTIONS.find(...)', () => {
    const offenders = walk(SRC).filter((file) => /(?<![A-Z_])MODEL_OPTIONS\.find\(/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
```

Create `src/lib/models.catalog-groups.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCatalogOptionGroups, MODEL_OPTIONS } from './models';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from './types';

const e = (id: string, engine: AnalyzerCatalogEntry['engine'], model = id): AnalyzerCatalogEntry => ({
  id, label: model, engine, model, structuredOutput: { mode: 'schema', dropped: [], label: 'schema' }, testPlan: { configured: 2, all: 3 },
});

const catalog = (over: Partial<Record<'ollama' | 'gemini', 'ok' | 'fallback' | 'error'>> = {}): AnalyzerCatalog => ({
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: over.ollama ?? 'ok', models: over.ollama === 'error' ? [] : [e('qwen3.5:4b', 'local'), e('mistral:7b', 'local')] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: over.gemini ?? 'ok', models: over.gemini ? [] : [e('gemini-3.6-flash', 'gemini'), e('gemini-4.0-flash', 'gemini')] },
    { kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok', models: [e('openai:lab::qwen3-30b', 'openai', 'qwen3-30b')] },
  ],
});

describe('buildCatalogOptionGroups (#3084)', () => {
  it('overlays curated labels and keeps live-only models', () => {
    const groups = buildCatalogOptionGroups(catalog(), { includeEndpoints: false });
    const gemini = groups.find((g) => g.kind === 'gemini')!;
    expect(gemini.models.find((m) => m.id === 'gemini-3.6-flash')?.label).toBe('Gemini 3.6 Flash');
    expect(gemini.models.find((m) => m.id === 'gemini-4.0-flash')?.label).toBe('gemini-4.0-flash');
    const local = groups.find((g) => g.kind === 'ollama')!;
    expect(local.models.map((m) => m.label)).toEqual(['Qwen3.5 4B (local)', 'mistral:7b']);
    expect(groups.some((g) => g.kind === 'endpoint')).toBe(false);
  });

  it('a fallback Gemini group (no key, or a failed listing) shows the curated Gemini list', () => {
    const curatedGemini = MODEL_OPTIONS.filter((m) => m.engine === 'gemini').map((m) => m.id);
    const gemini = buildCatalogOptionGroups(catalog({ gemini: 'fallback' }), { includeEndpoints: false }).find((g) => g.kind === 'gemini')!;
    expect(gemini.status).toBe('fallback');
    expect(gemini.models.map((m) => m.id)).toEqual(curatedGemini);
  });

  it('a failed Ollama listing stays empty (installed-only, plan 221 invariant 1)', () => {
    const local = buildCatalogOptionGroups(catalog({ ollama: 'error' }), { includeEndpoints: false }).find((g) => g.kind === 'ollama')!;
    expect(local.models).toEqual([]);
    expect(local.status).toBe('error');
  });

  it('endpoint groups carry openai options labelled by model name when requested', () => {
    const groups = buildCatalogOptionGroups(catalog(), { includeEndpoints: true });
    expect(groups.find((g) => g.id === 'lab')).toMatchObject({ kind: 'endpoint', engine: 'openai', label: 'Lab server', models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai' }] });
  });

  it('null catalog → curated Gemini, empty Ollama', () => {
    const groups = buildCatalogOptionGroups(null, { includeEndpoints: true });
    expect(groups.map((g) => g.kind)).toEqual(['gemini', 'ollama']);
    expect(groups[0].models.length).toBe(MODEL_OPTIONS.filter((m) => m.engine === 'gemini').length);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npx vitest run src/lib/model-label.test.ts src/lib/model-label.guard.test.ts src/lib/models.catalog-groups.test.ts`
Expected: FAIL — `Failed to resolve import "./model-label"`; guard lists the 8 `MODEL_OPTIONS.find(` files; `buildCatalogOptionGroups is not a function`.

- [ ] **Step 3: Implement**

Re-grep the sites (the scout's list of 3 was incomplete; this grep finds 8 lines in 7 files, plus the picker fallback):
```bash
rg -n "(?<![A-Z_])MODEL_OPTIONS\.find\(" src --pcre2 -g '!*.test.*'
rg -n "selectedOption\?\.label \?\? selectedModel" src
```
Expected at 2b63b451: `account-forms.tsx:18`, `analyzer-model-override-badge.tsx:19`, `analysing/phase-model-swap.tsx:82`, `analysing/phase-model-chip.tsx:72`, `:75`, `analysing/phase-card.tsx:354`, `status-popover.tsx:165`, `:307`; and `analysis-model-picker.tsx:43`. Nine sites — the spec's "~9" was right.

Create `src/lib/model-label.ts`:

```ts
/* #3084 — the one analyzer model label resolver (spec §3 "Labels"). Order: curated
   MODEL_OPTIONS label → `<endpoint name> · <model>` for an OpenAI-compatible endpoint id →
   the catalog entry's `label` (Gemini's live displayName, else the id; the Ollama tag) →
   the raw id. */
import { MODEL_OPTIONS } from './models';
import { parseEndpointModelId } from './model-id';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from './types';

export function catalogEntryFor(id: string, catalog: AnalyzerCatalog | null | undefined): AnalyzerCatalogEntry | undefined {
  if (!catalog) return undefined;
  for (const group of catalog.groups) {
    const hit = group.models.find((m) => m.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/* A Map, not MODEL_OPTIONS.find(...): model-label.guard.test.ts bans that lookup shape. */
const CURATED_LABELS = new Map(MODEL_OPTIONS.map((m) => [m.id, m.label]));

export function modelLabel(id: string, catalog?: AnalyzerCatalog | null): string {
  const curated = CURATED_LABELS.get(id);
  if (curated) return curated;
  /* Endpoint ids first: an endpoint entry's own `label` is the bare model name. */
  const parsed = parseEndpointModelId(id);
  if (parsed) {
    const group = catalog?.groups.find((g) => g.kind === 'endpoint' && g.id === parsed.endpointId);
    return `${group?.label ?? parsed.endpointId} · ${parsed.model}`;
  }
  const entry = catalogEntryFor(id, catalog);
  if (entry) return entry.label;
  return id;
}

/** Suffixes a run label shows after the model name. W3: the structured-output label.
    W5 (custom payload) appends '+ custom params' here. */
export function runLabelSuffixes(entry: AnalyzerCatalogEntry | undefined): string[] {
  return entry ? [entry.structuredOutput.label] : [];
}
```

`src/lib/models.ts` — after `buildModelOptionGroups` (`:191`), add:

```ts
import type { AnalyzerCatalog, AnalyzerCatalogGroup } from './types';

export interface ModelOptionGroup {
  id: string;
  kind: AnalyzerCatalogGroup['kind'];
  engine: ModelOption['engine'];
  label: string;
  status: AnalyzerCatalogGroup['status'];
  error?: string;
  models: ModelOption[];
}

/** Picker/editor groups from the live catalog (#3084). Gemini: curated entries first
    (curated labels + hints), then live-only models; a `fallback` group (no key, or a
    failed listing) shows the curated list. Ollama: installed-only (plan 221 invariant 1) —
    an `error` group is empty. Endpoint groups only when `includeEndpoints`. */
export function buildCatalogOptionGroups(
  catalog: AnalyzerCatalog | null,
  opts: { includeEndpoints: boolean },
  curated: ModelOption[] = MODEL_OPTIONS,
): ModelOptionGroup[] {
  const curatedGemini = curated.filter((m) => m.engine === 'gemini');
  const geminiGroup = catalog?.groups.find((g) => g.kind === 'gemini');
  const liveGemini = geminiGroup?.status === 'ok' ? geminiGroup.models : [];
  const gemini: ModelOptionGroup = {
    id: 'gemini',
    kind: 'gemini',
    engine: 'gemini',
    label: 'Gemini API (cloud)',
    status: geminiGroup?.status ?? 'fallback',
    ...(geminiGroup?.error ? { error: geminiGroup.error } : {}),
    models:
      liveGemini.length === 0
        ? curatedGemini
        : [
            ...curatedGemini.filter((c) => liveGemini.some((l) => l.id === c.id)),
            ...liveGemini
              .filter((l) => !curatedGemini.some((c) => c.id === l.id))
              .map((l) => ({ id: l.id, label: l.label, engine: 'gemini' as const })),
          ],
  };
  const ollamaGroup = catalog?.groups.find((g) => g.kind === 'ollama');
  const local: ModelOptionGroup = {
    id: 'ollama',
    kind: 'ollama',
    engine: 'local',
    label: 'Local Ollama (default, on-device)',
    /* No catalog yet: nothing listed, so nothing to offer (installed-only). */
    status: ollamaGroup?.status ?? 'error',
    ...(ollamaGroup?.error ? { error: ollamaGroup.error } : {}),
    models:
      ollamaGroup?.status === 'ok'
        ? buildLocalModelOptions(ollamaGroup.models.map((m) => ({ name: m.model })), curated.filter((m) => m.engine === 'local'))
        : [],
  };
  const endpoints: ModelOptionGroup[] = opts.includeEndpoints
    ? (catalog?.groups ?? [])
        .filter((g) => g.kind === 'endpoint')
        .map((g) => ({
          id: g.id,
          kind: 'endpoint' as const,
          engine: 'openai' as const,
          label: g.label,
          status: g.status,
          ...(g.error ? { error: g.error } : {}),
          models: g.models.map((m) => ({ id: m.id, label: m.label, engine: 'openai' as const, ...(m.contextTokens ? { hint: `${m.contextTokens.toLocaleString()}-token context` } : {}) })),
        }))
    : [];
  return [gemini, local, ...endpoints];
}
```

(Move the `import type` line to the top of `models.ts` beside the existing `import { FRONTEND_ACCOUNT_DEFAULTS }` at `:97`.)

Note: a curated Gemini model the live listing does not return is dropped when the listing succeeded; that matches "live catalogs for every engine" and never hides a model the key can call.

`src/store/account-slice.ts`:
- import `import type { AnalyzerCatalog, UserSettings, UserSettingsPatch } from '../lib/types';` (extend `:10`).
- `AccountState` (`:22-35`): add

```ts
  /** #3084 — last GET /api/analyzer/models response. Fetched at the same moments as
      fetchAnalyzerModels (never on a healthy cloud run's analysing view). */
  analyzerCatalog: AnalyzerCatalog | null;
```

- `initialState` (`:37-47`): `analyzerCatalog: null,`.
- after `fetchAnalyzerModels` (`:81`):

```ts
export const fetchAnalyzerCatalog = createAsyncThunk(
  'account/fetchAnalyzerCatalog',
  async (opts: { refresh?: boolean } | undefined) => api.getAnalyzerModels(opts?.refresh ?? false),
);
```

- `extraReducers` (`:193-196`), add:

```ts
      .addCase(fetchAnalyzerCatalog.fulfilled, (state, action) => {
        state.analyzerCatalog = action.payload;
      })
```

Label sites:

`src/components/account-forms.tsx` — replace `:10` `import { MODEL_OPTIONS } from '../lib/models';` with `import { modelLabel } from '../lib/model-label';` and `import type { AnalyzerCatalog } from '../lib/types';`; replace `:16-19`:

```ts
export function analyzerModelLabel(id: string | null | undefined, catalog?: AnalyzerCatalog | null): string {
  if (!id) return 'server default';
  return modelLabel(id, catalog);
}
```

`src/components/model-settings-form.tsx:313,317,327` — pass `account.analyzerCatalog` as the second argument of each `analyzerModelLabel(...)`.

`src/components/analyzer-model-override-badge.tsx` — delete `:16-20`; add `import { modelLabel } from '../lib/model-label';`; after `:26` add `const catalog = useAppSelector((s) => s.account?.analyzerCatalog ?? null);`; `:38` `{modelLabel(selectedModel, catalog)}`; `:39` `({modelLabel(savedDefault, catalog)})`.

`src/components/analysing/phase-model-swap.tsx` — `:2` import becomes `import { buildLocalModelOptions, buildModelOptionGroups } from '../../lib/models';` plus `import { modelLabel } from '../../lib/model-label';`; after `:56` add `const analyzerCatalog = useAppSelector((s) => s.account.analyzerCatalog);`; `:81-82`:

```ts
    const overrideLabel = modelLabel(overrideModelId, analyzerCatalog);
```

(`overrideModelId` defaults to `''` (`:44`), so the old trailing `?? 'override'` could never fire; dropping it keeps today's output exactly.)

`src/components/analysing/phase-model-chip.tsx` — `:1` becomes `import { modelLabel } from '../../lib/model-label';`; before `if (phaseId === 2) return null;` (`:61`) add `const analyzerCatalog = useAppSelector((s) => s.account.analyzerCatalog ?? null);`; replace `:70-75`:

```ts
  const label =
    serverModel !== undefined
      ? modelLabel(serverModel, analyzerCatalog)
      : serverDefault
        ? 'Server default'
        : modelId != null
          ? modelLabel(modelId, analyzerCatalog)
          : 'Server default';
```

`src/components/analysing/phase-card.tsx` — `:9` becomes `import { modelLabel } from '../../lib/model-label';`; `:354` `const modelLabelText = modelLabel(model);` (the old local name collides with the import) and `:372` `<span className="font-semibold">Throttling {modelLabelText}</span>` — the local's only use.

`src/components/status-popover.tsx` — `:35` becomes `import { modelLabel } from '../lib/model-label';`; `:165` `{modelLabel(analysisSubstage.model)}`; `:307` `{modelLabel(analysis.model)}`.

`src/components/analysis-model-picker.tsx` — add `import { modelLabel } from '../lib/model-label';`; `:43` `const triggerLabel = selectedOption?.label ?? modelLabel(selectedModel);`.

After the edits both `rg` commands above return nothing.

- [ ] **Step 4: Run and confirm they pass**
Run: `npx vitest run src/lib/model-label.test.ts src/lib/model-label.guard.test.ts src/lib/models.catalog-groups.test.ts src/lib/models.test.ts src/components/analysing/phase-model-chip.test.tsx src/components/model-settings-form.test.tsx` then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `model-label.ts`: delete the `if (entry) return entry.label;` line → red: "the catalog entry label (live displayName) for an uncurated model". Restore.
2. Re-add `return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;` as the body of `analyzerModelLabel` → red: guard "no source file resolves a label with MODEL_OPTIONS.find(...)". Restore.
3. `buildCatalogOptionGroups`: make a failed Ollama listing return `curated.filter((m) => m.engine === 'local')` → red: "a failed Ollama listing stays empty…". Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/model-label.ts src/lib/model-label.test.ts src/lib/model-label.guard.test.ts src/lib/models.ts src/lib/models.catalog-groups.test.ts src/store/account-slice.ts src/components/account-forms.tsx src/components/model-settings-form.tsx src/components/analyzer-model-override-badge.tsx src/components/analysing/phase-model-swap.tsx src/components/analysing/phase-model-chip.tsx src/components/analysing/phase-card.tsx src/components/status-popover.tsx src/components/analysis-model-picker.tsx
git commit -m "feat(frontend): one modelLabel resolver backed by the live analyzer catalog"
```

---
### Task 3c.8: Per-model limits editor, Test button, forward GPU guard for the tested model

**Files:**
- Modify: `src/hooks/use-local-analyzer-guard.tsx:44-49` (option), `:64`, `:75-86` (engine + gate)
- Create: `src/components/settings/model-test-button.tsx`, `src/components/settings/analyzer-model-limits.tsx`
- Modify: `src/views/advanced.tsx` — import, and render inside the section after the knob rows (`:555`)
- Test: `src/hooks/use-local-analyzer-guard.test.tsx` (extend), Create `src/components/settings/analyzer-model-limits.test.tsx`

**Interfaces:**
- Consumes: `fetchAnalyzerCatalog`, `AccountState.analyzerCatalog`, `modelLabel` (Task 3c.7); `saveAccountSettings` (`account-slice.ts:53`); `api.testAnalyzerModel` (Task 3c.6); `ConfirmDialog` (`src/modals/confirm-dialog.tsx:20-41`); `engineForModelId` (3a).
- Produces: `useLocalAnalyzerGuard({ generatingBookTitle?, modelId? })`; `ModelTestButton({ entry, label })`; `describeTestOutcome(entry)`; `AnalyzerModelLimits()`.

Guard semantics in 3c: `modelId` (when given) replaces `ui.selectedModel` as the model being started. Gemini passes straight through; `local` prompts as today; an `openai` id **prompts** (fails closed) until 3d adds the card comparison. The only way to start an endpoint call in 3c is the Test button, so no run path changes.

Keeps green: `use-local-analyzer-guard.test.tsx` (existing six cases), `src/views/advanced*.test.tsx`, e2e `advanced-settings.spec.ts`.

- [ ] **Step 1: Write the failing tests**

`src/hooks/use-local-analyzer-guard.test.tsx` — change `Harness` (`:58-66`) to accept a model id and add three cases inside the `describe`:

```tsx
function Harness({ onProceed, modelId }: { onProceed: () => void; modelId?: string }) {
  const { guard, modal } = useLocalAnalyzerGuard({ modelId });
  return (
    <>
      <button onClick={() => guard(onProceed)}>Trigger</button>
      {modal}
    </>
  );
}
```

```tsx
  it('modelId overrides ui.selectedModel: a local model under test prompts even when a Gemini model is selected', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} modelId="qwen3.5:4b" />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('modelId overrides ui.selectedModel: a Gemini model under test passes through with a local model selected', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:4b', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} modelId="gemini-3.6-flash" />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('an OpenAI-compatible endpoint model fails closed (prompts) while a stream is active', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} modelId="openai:lab::qwen3-30b" />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
  });
```

Create `src/components/settings/analyzer-model-limits.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { chaptersSlice, type ActiveStreamSnapshot } from '../../store/chapters-slice';
import { librarySlice } from '../../store/library-slice';
import { AnalyzerModelLimits } from './analyzer-model-limits';
import { api } from '../../lib/api';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  api: { getAnalyzerModels: vi.fn(), putUserSettings: vi.fn(), testAnalyzerModel: vi.fn() },
}));
vi.mock('../../store/queue-thunks', () => ({ haltActiveGeneration: vi.fn(() => ({ type: 'test/halt' })) }));

const entry = (id: string, engine: AnalyzerCatalogEntry['engine'], model = id): AnalyzerCatalogEntry => ({
  id, label: model, engine, model, structuredOutput: { mode: 'schema', dropped: [], label: 'schema' }, testPlan: { configured: 2, all: 3 },
});

const CATALOG: AnalyzerCatalog = {
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [entry('qwen3.5:4b', 'local')] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [entry('gemini-3.6-flash', 'gemini')] },
    { kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok', models: [entry('openai:lab::qwen3-30b', 'openai', 'qwen3-30b')] },
  ],
};

const stream: ActiveStreamSnapshot = {
  streamKey: 'b::1', bookId: 'b', chapterId: 1, modelKey: 'kokoro-v1', done: 0, total: 3, inProgress: 1, lastTickAt: Date.now(), halted: false,
};

function renderLimits(opts: { activeStream?: ActiveStreamSnapshot } = {}) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer, chapters: chaptersSlice.reducer, library: librarySlice.reducer },
  });
  if (opts.activeStream) store.dispatch(chaptersSlice.actions.setActiveStream(opts.activeStream));
  render(
    <Provider store={store}>
      <AnalyzerModelLimits />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getAnalyzerModels).mockResolvedValue(CATALOG);
  vi.mocked(api.putUserSettings).mockImplementation(async (patch) => patch as never);
  vi.mocked(api.testAnalyzerModel).mockResolvedValue({
    serverUrl: 'gemini', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: {},
  });
});

describe('AnalyzerModelLimits (#3084)', () => {
  it('lists every catalog model; Ollama rows offer Test but no rate inputs', async () => {
    renderLimits();
    const gemini = await screen.findByTestId('model-limits-row-gemini-3.6-flash');
    expect(within(gemini).getByLabelText('Gemini 3.6 Flash RPM')).toBeInTheDocument();
    expect(screen.getByTestId('model-limits-row-openai:lab::qwen3-30b')).toBeInTheDocument();
    const local = screen.getByTestId('model-limits-row-qwen3.5:4b');
    expect(within(local).queryByLabelText(/RPM/)).toBeNull();
    expect(within(local).getByTestId('model-test-qwen3.5:4b')).toBeInTheDocument();
  });

  it('Save writes the whole map, omitting blank fields and empty models', async () => {
    renderLimits();
    fireEvent.change(await screen.findByLabelText('Gemini 3.6 Flash RPM'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Lab server · qwen3-30b TPM'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Lab server · qwen3-30b TPM'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('model-limits-save'));
    await waitFor(() =>
      expect(api.putUserSettings).toHaveBeenCalledWith({ analyzerRateLimitsByModel: { 'gemini-3.6-flash': { rpm: 3 } } }),
    );
  });

  it('Test shows the request count, switches to the all-modes count, and sends the chosen scope', async () => {
    renderLimits();
    fireEvent.click(await screen.findByTestId('model-test-gemini-3.6-flash'));
    expect(screen.getByTestId('model-test-request-count')).toHaveTextContent('2');
    expect(screen.getByText(/count against today's Gemini quota/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('model-test-scope-all'));
    // off-mode control + schema + json (the off check reuses the control)
    expect(screen.getByTestId('model-test-request-count')).toHaveTextContent('3');
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await waitFor(() => expect(api.testAnalyzerModel).toHaveBeenCalledWith({ modelId: 'gemini-3.6-flash', scope: 'all' }));
  });

  it('testing a local model while TTS is generating opens the GPU guard before any request; Wait sends nothing', async () => {
    renderLimits({ activeStream: stream });
    fireEvent.click(await screen.findByTestId('model-test-qwen3.5:4b'));
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));
    expect(api.testAnalyzerModel).not.toHaveBeenCalled();
  });

  it('testing a Gemini model while TTS is generating never opens the GPU guard', async () => {
    renderLimits({ activeStream: stream });
    fireEvent.click(await screen.findByTestId('model-test-gemini-3.6-flash'));
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(screen.queryByText('Pause audio generation to analyse?')).toBeNull();
    await waitFor(() => expect(api.testAnalyzerModel).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npx vitest run src/hooks/use-local-analyzer-guard.test.tsx src/components/settings/analyzer-model-limits.test.tsx`
Expected: FAIL — the guard's `modelId` cases fail (`Unable to find an element with the text: Pause audio generation to analyse?` / `proceed` called); `Failed to resolve import "./analyzer-model-limits"`.

- [ ] **Step 3: Implement**

`src/hooks/use-local-analyzer-guard.tsx`:
- `GuardOptions` (`:44-49`) gains:

```ts
  /** #3084 — the model about to be called, when it is not the run's selected model
      (e.g. Settings → Test on one model). Defaults to `ui.selectedModel`. */
  modelId?: string;
```

- `:62` signature: `export function useLocalAnalyzerGuard({ generatingBookTitle, modelId }: GuardOptions = {}): GuardResult {`
- `:75-86` become:

```ts
  /* Engine lookup — Ollama shares the card with the Voice engine. Gemini is a remote
     API and safe alongside TTS. An OpenAI-compatible endpoint fails closed here until
     the card comparison lands (#3084 W3d). */
  const engine = engineForModelId(modelId ?? selectedModel);

  const guard: GuardResult['guard'] = (proceed) => {
    if (engine === 'gemini' || !anyActiveStream) {
      proceed();
      return;
    }
    setPending(() => proceed);
  };
```

Create `src/components/settings/model-test-button.tsx`:

```tsx
/* #3084 — Settings "Test" for one analyzer model: confirms the request count (and the
   Gemini quota cost), routes through the forward GPU guard, runs POST
   /api/analyzer/models/test, then refreshes the catalog so the outcome shows. */
import { useState } from 'react';
import { useAppDispatch } from '../../store';
import { fetchAnalyzerCatalog } from '../../store/account-slice';
import { useLocalAnalyzerGuard } from '../../hooks/use-local-analyzer-guard';
import { ConfirmDialog } from '../../modals/confirm-dialog';
import { api } from '../../lib/api';
import type { AnalyzerCatalogEntry } from '../../lib/types';

export function describeTestOutcome(entry: AnalyzerCatalogEntry): string | null {
  const record = entry.capability;
  if (!record) return null;
  if (!record.control.ok) return `Test failed: ${record.control.error ?? 'the control request did not succeed'}`;
  return `${entry.structuredOutput.label} · tested ${record.testedAt.slice(0, 10)}`;
}

export function ModelTestButton({ entry, label }: { entry: AnalyzerCatalogEntry; label: string }) {
  const dispatch = useAppDispatch();
  const { guard, modal } = useLocalAnalyzerGuard({ modelId: entry.id });
  const [confirming, setConfirming] = useState(false);
  const [scopeAll, setScopeAll] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = scopeAll ? entry.testPlan.all : entry.testPlan.configured;
  const outcome = describeTestOutcome(entry);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.testAnalyzerModel({ modelId: entry.id, scope: scopeAll ? 'all' : 'configured' });
      await dispatch(fetchAnalyzerCatalog({ refresh: false }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid={`model-test-${entry.id}`}
        disabled={running}
        onClick={() => setConfirming(true)}
        className="px-3 py-1 rounded-full border border-ink/15 bg-white text-xs text-ink hover:bg-ink/5 disabled:opacity-50 min-h-[44px] fine-pointer:min-h-0"
      >
        {running ? 'Testing…' : 'Test'}
      </button>
      {outcome && (
        <span data-testid={`model-test-result-${entry.id}`} className="text-xs text-ink/60">
          {outcome}
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-rose-700">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={confirming}
        eyebrow="Test model"
        title={`Test ${label}?`}
        body={
          <>
            <p>
              This sends <b data-testid="model-test-request-count">{requests}</b> request{requests === 1 ? '' : 's'} to the
              model{entry.engine === 'gemini' ? ", and they count against today's Gemini quota" : ''}.
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scopeAll}
                onChange={(e) => setScopeAll(e.target.checked)}
                data-testid="model-test-scope-all"
              />
              Test every structured-output mode
            </label>
          </>
        }
        confirmLabel="Run test"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={() => {
          setConfirming(false);
          guard(() => void run());
        }}
        onClose={() => setConfirming(false)}
      />
      {modal}
    </span>
  );
}
```

Create `src/components/settings/analyzer-model-limits.tsx`:

```tsx
/* #3084 — Advanced Settings → Analyzer rate limits: per-model RPM/TPM/RPD for Gemini
   and endpoint models (whole-map save of analyzerRateLimitsByModel) plus the Test
   action for every catalog model. Blank = default: Gemini env → built-in table;
   endpoints unlimited. Ollama has no limiter, so its rows only offer Test. */
import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { fetchAnalyzerCatalog, saveAccountSettings } from '../../store/account-slice';
import { modelLabel } from '../../lib/model-label';
import type { UserSettings } from '../../lib/types';
import { ModelTestButton } from './model-test-button';

type LimitsMap = NonNullable<UserSettings['analyzerRateLimitsByModel']>;
type Field = 'rpm' | 'tpm' | 'rpd';
const FIELDS: readonly Field[] = ['rpm', 'tpm', 'rpd'];
const EMPTY: LimitsMap = {};

export function AnalyzerModelLimits() {
  const dispatch = useAppDispatch();
  const catalog = useAppSelector((s) => s.account.analyzerCatalog);
  const saved = useAppSelector((s) => s.account.analyzerRateLimitsByModel) ?? EMPTY;
  const [draft, setDraft] = useState<LimitsMap>(saved);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    void dispatch(fetchAnalyzerCatalog(undefined));
  }, [dispatch]);
  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const setField = (id: string, field: Field, raw: string) => {
    setDraft((prev) => {
      const nextEntry = { ...(prev[id] ?? {}) };
      const n = Number.parseInt(raw, 10);
      if (raw.trim() === '' || !Number.isFinite(n)) delete nextEntry[field];
      else nextEntry[field] = Math.max(field === 'tpm' ? 0 : 1, n);
      const next = { ...prev };
      if (Object.keys(nextEntry).length === 0) delete next[id];
      else next[id] = nextEntry;
      return next;
    });
  };

  const save = async () => {
    setStatus('saving');
    const action = await dispatch(saveAccountSettings({ analyzerRateLimitsByModel: draft }));
    setStatus(saveAccountSettings.fulfilled.match(action) ? 'saved' : 'error');
  };

  const groups = (catalog?.groups ?? []).filter((g) => g.models.length > 0);

  return (
    <div data-testid="analyzer-model-limits" className="py-3 space-y-4">
      <p className="text-xs text-ink/55">
        Leave a field blank to use the default: Gemini models use the GEMINI_RPM/TPM/RPD_&lt;model&gt; env vars, then the
        built-in free-tier limits; OpenAI-compatible endpoint models are unlimited. TPM 0 means unlimited. Local Ollama
        models have no rate limit and only offer Test.
      </p>
      {groups.map((g) => (
        <section key={`${g.kind}:${g.id}`}>
          <h4 className="text-xs font-semibold text-ink/70 mb-2">{g.label}</h4>
          {g.models.map((m) => {
            const label = modelLabel(m.id, catalog);
            return (
              <div key={m.id} data-testid={`model-limits-row-${m.id}`} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="text-sm text-ink flex-1 min-w-[10rem]">{label}</span>
                {g.kind !== 'ollama' &&
                  FIELDS.map((f) => (
                    <label key={f} className="inline-flex items-center gap-1 text-[11px] text-ink/60">
                      {f.toUpperCase()}
                      <input
                        type="number"
                        min={f === 'tpm' ? 0 : 1}
                        step={1}
                        value={draft[m.id]?.[f] ?? ''}
                        placeholder="default"
                        aria-label={`${label} ${f.toUpperCase()}`}
                        onChange={(e) => setField(m.id, f, e.target.value)}
                        className="w-24 px-2 py-1 rounded-lg border border-ink/15 bg-white text-sm text-ink min-h-[44px] fine-pointer:min-h-0"
                      />
                    </label>
                  ))}
                <ModelTestButton entry={m} label={label} />
              </div>
            );
          })}
        </section>
      ))}
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="model-limits-save"
          onClick={() => void save()}
          disabled={status === 'saving'}
          className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0"
        >
          {status === 'saving' ? 'Saving…' : 'Save rate limits'}
        </button>
        {status === 'saved' && <span className="text-xs text-magenta font-semibold">Saved.</span>}
        {status === 'error' && <span className="text-xs text-rose-700">Could not save rate limits.</span>}
      </div>
    </div>
  );
}
```

`src/views/advanced.tsx` — add `import { AnalyzerModelLimits } from '../components/settings/analyzer-model-limits';` with the other component imports, and immediately after the `groupDescriptors.map(...)` block closes (`:555`, before `{group.id === 'analyzer-models' && …}`):

```tsx
                  {group.id === 'rate-limits' && <AnalyzerModelLimits />}
```

- [ ] **Step 4: Run and confirm they pass**
Run: `npx vitest run src/hooks/use-local-analyzer-guard.test.tsx src/components/settings/analyzer-model-limits.test.tsx src/views` then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. Guard: revert `engineForModelId(modelId ?? selectedModel)` to `engineForModelId(selectedModel)` → red: "modelId overrides ui.selectedModel…" (both). Restore.
2. Guard: revert `engine === 'gemini'` to `engine !== 'local'` → red: "an OpenAI-compatible endpoint model fails closed…". Restore.
3. `ModelTestButton` `onConfirm`: replace `guard(() => void run())` with `void run()` → red: "testing a local model while TTS is generating opens the GPU guard…". Restore.
4. `setField`: remove `if (Object.keys(nextEntry).length === 0) delete next[id];` → red: "Save writes the whole map, omitting blank fields and empty models". Restore.

- [ ] **Step 6: Commit**
```bash
git add src/hooks/use-local-analyzer-guard.tsx src/hooks/use-local-analyzer-guard.test.tsx src/components/settings/model-test-button.tsx src/components/settings/analyzer-model-limits.tsx src/components/settings/analyzer-model-limits.test.tsx src/views/advanced.tsx
git commit -m "feat(frontend): per-model analyzer rate limits and a guarded model Test action"
```

---
### Task 3c.9: `resolveCapacity` endpoint branch and the per-request cap on context-family budgets

**Files:**
- Modify: `server/src/analyzer/capacity.ts` (W2) — the `engine === 'openai'` case of `resolveCapacity`
- Modify: `server/src/analyzer/token-budget.ts:47-51` (`cloudBodyCharBudgetForCap`; `cloudBodyCharBudget` delegates)
- Modify: `server/src/analyzer/stage1-chunk.ts`, `stage2-chunk.ts`, `chapter-chunker.ts` — the context-family return of each W2 resolver (at 2b63b451 these are the `engine === 'local'` paths: `stage1-chunk.ts:119-124`, `stage2-chunk.ts:76-81`, `chapter-chunker.ts:136`)
- Test: Create `server/src/analyzer/capacity.endpoint.test.ts`

**Interfaces:**
- Consumes: `EngineCapacity`, `resolveCapacity(sel)`, `TODAY_LOCAL_CAPACITY(numCtx)` (W2); `resolveLimits` (Task 3c.1); `getCachedCatalogLimits` (Task 3c.5); `parseEndpointModelId`, `endpointModelId` (3a); `AnalyzerEndpointMissingError` (3b); `analyzerEndpointSchema` (3b).
- Produces: `resolveCapacity({ engine: 'openai', model, endpoint? })` → `{ family: 'context', contextTokens: endpoint.contextTokens, maxOutputTokens, perRequestInputCap? }`; `cloudBodyCharBudgetForCap(capTokens, body, reservedChars?, reservedTokens?)`.

Rules (spec §6): endpoints are context family; `perRequestInputCap` = min of the endpoint's `maxInputTokensPerRequest` and its saved TPM limit, each only if set (unset TPM resolves to Infinity for endpoints and is ignored); when a cap is set, each context-family budget is additionally limited by `cloudBodyCharBudget`'s formula at that cap, with the same reservations that pass's request-cap branch uses (stage 1: roster chars + `STAGE1_CLOUD_RESERVED_TOKENS`; stage 2: none; chapter-level: the caller's `reservedChars`/`reservedTokens`). `sel.model` may be the full `openai:<id>::<model>` id or the bare model with `sel.endpoint`; the endpoint is looked up from cached settings when not passed; a missing endpoint throws `AnalyzerEndpointMissingError(endpointId, 'settings')`. `maxOutputTokens` = the manual value clamped to the served limit when known; `0` (Auto) → the served limit, or `null` when unknown (the transport computes `contextTokens − estimated input`, spec §7). Ollama and Gemini branches are untouched — W2's pinning test is the proof.

Keeps green: W2's capacity pinning test, `stage1-chunk.test.ts`, `stage2-chunk.test.ts`, `chapter-chunker.test.ts`, `token-budget.test.ts`, `output-heavy-tpm.test.ts`, `attribution-eval/review-run.test.ts`, route tests `annotate-emotion.test.ts:257`, `instruct-annotation.test.ts:302`, `script-review.test.ts:607`.

- [ ] **Step 1: Write the failing test** — create `server/src/analyzer/capacity.endpoint.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { resolveCapacity, TODAY_LOCAL_CAPACITY } from './capacity.js';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { resolveStage2ChunkCharBudget } from './stage2-chunk.js';
import { chapterChunkBudget } from './chapter-chunker.js';
import { cloudBodyCharBudget, cloudBodyCharBudgetForCap, resolveMaxInputTokensPerRequest } from './token-budget.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { _resetCatalogCacheForTest } from './catalog/analyzer-catalog.js';

const LATIN = 'The lamp guttered while Hart counted the coal sacks by the door. '.repeat(400);
const CYRILLIC = 'Фонарь мигал, пока Харт считал мешки с углём у двери. '.repeat(400);
const CJK = '灯火摇曳，哈特在门边数着煤袋。'.repeat(900);

function endpoint(over: Record<string, unknown> = {}) {
  return analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768, ...over });
}

afterEach(() => {
  _resetUserSettingsCache();
  _resetCatalogCacheForTest();
});

describe('resolveCapacity — endpoint branch (#3084 W3)', () => {
  it('context family, the endpoint context, no cap and no known output limit by default', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint()], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' })).toEqual({
      family: 'context',
      contextTokens: 32768,
      maxOutputTokens: null,
    });
  });

  it('perRequestInputCap is the min of maxInputTokensPerRequest and the saved TPM', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [endpoint({ maxInputTokensPerRequest: 8000 })],
      analyzerRateLimitsByModel: { 'openai:lab::qwen3-30b': { tpm: 6000 } },
    });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).perRequestInputCap).toBe(6000);
  });

  it('only the set cap counts (unset TPM is unlimited for endpoints)', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint({ maxInputTokensPerRequest: 8000 })], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).perRequestInputCap).toBe(8000);
  });

  it('accepts a bare model with an explicit endpoint', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'qwen3-30b', endpoint: endpoint({ contextTokens: 4096 }) }).contextTokens).toBe(4096);
  });

  it('a manual max output is kept when no served limit is known', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint({ maxOutputTokens: 2048 })], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).maxOutputTokens).toBe(2048);
  });

  it('a missing endpoint throws AnalyzerEndpointMissingError', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerRateLimitsByModel: {} });
    expect(() => resolveCapacity({ engine: 'openai', model: 'openai:gone::m' })).toThrow(AnalyzerEndpointMissingError);
  });
});

describe('budgets for an endpoint capacity', () => {
  it.each([['Latin', LATIN], ['Cyrillic', CYRILLIC], ['CJK', CJK]])(
    'without a cap, %s budgets equal the Ollama formula at the same context',
    (_script, body) => {
      const ep = { family: 'context' as const, contextTokens: 32768, maxOutputTokens: null };
      const ollama = TODAY_LOCAL_CAPACITY(32768);
      expect(resolveStage1ChunkCharBudget(ep, body)).toBe(resolveStage1ChunkCharBudget(ollama, body));
      expect(resolveStage2ChunkCharBudget(ep, body)).toBe(resolveStage2ChunkCharBudget(ollama, body));
      expect(chapterChunkBudget(ep, 500, body, 4000)).toBe(chapterChunkBudget(ollama, 500, body, 4000));
    },
  );

  it('a binding cap lowers the stage-2 budget to cloudBodyCharBudget at that cap', () => {
    const uncapped = { family: 'context' as const, contextTokens: 131072, maxOutputTokens: null };
    const capped = { ...uncapped, perRequestInputCap: 1500 };
    const expectedAtCap = cloudBodyCharBudgetForCap(1500, LATIN);
    expect(expectedAtCap).toBeLessThan(resolveStage2ChunkCharBudget(uncapped, LATIN));
    expect(resolveStage2ChunkCharBudget(capped, LATIN)).toBe(expectedAtCap);
  });

  it('a binding cap lowers stage 1 using stage 1 reservations, and chapter passes using the caller reservations', () => {
    const uncapped = { family: 'context' as const, contextTokens: 131072, maxOutputTokens: null };
    const capped = { ...uncapped, perRequestInputCap: 9000 };
    expect(resolveStage1ChunkCharBudget(capped, LATIN)).toBe(
      Math.min(resolveStage1ChunkCharBudget(uncapped, LATIN), cloudBodyCharBudgetForCap(9000, LATIN, 0, 7000)),
    );
    expect(resolveStage1ChunkCharBudget(capped, LATIN)).toBeLessThan(resolveStage1ChunkCharBudget(uncapped, LATIN));
    expect(chapterChunkBudget(capped, 1200, LATIN, 4000)).toBe(
      Math.min(chapterChunkBudget(uncapped, 1200, LATIN, 4000), cloudBodyCharBudgetForCap(9000, LATIN, 1200, 4000)),
    );
  });

  it.each([['Latin', LATIN], ['Cyrillic', CYRILLIC], ['CJK', CJK]])(
    'cloudBodyCharBudget is byte-identical to cloudBodyCharBudgetForCap at the knob cap (%s)',
    (_script, body) => {
      expect(cloudBodyCharBudget(body, 300, 7000)).toBe(cloudBodyCharBudgetForCap(resolveMaxInputTokensPerRequest(), body, 300, 7000));
    },
  );
});
```

The second `it` in "a binding cap lowers stage 1…" asserts a `Math.min` composition by design: the value is new behaviour defined as that composition (spec §6), and the preceding `toBeLessThan` proves the cap actually binds for this input.

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/capacity.endpoint.test.ts`
Expected: FAIL — `cloudBodyCharBudgetForCap is not a function` and the endpoint branch throwing (W2 does not handle `openai`).

- [ ] **Step 3: Implement**

`server/src/analyzer/token-budget.ts:47-51` becomes:

```ts
/** cloudBodyCharBudget at an explicit per-request token cap (#3084: an endpoint's
    perRequestInputCap). Same formula, same 2000-char floor. */
export function cloudBodyCharBudgetForCap(capTokens: number, body: string, reservedChars = 0, reservedTokens = 0): number {
  const availableTokens = Math.max(0, capTokens - reservedTokens);
  const perRequestChars = Math.floor(availableTokens * charsPerTokenForText(body));
  return Math.max(2000, perRequestChars - reservedChars);
}

export function cloudBodyCharBudget(body: string, reservedChars = 0, reservedTokens = 0): number {
  return cloudBodyCharBudgetForCap(resolveMaxInputTokensPerRequest(), body, reservedChars, reservedTokens);
}
```

(If W2 already parametrised `cloudBodyCharBudget` by a cap, keep W2's function and add `cloudBodyCharBudgetForCap` as a thin alias of it with this signature.)

`server/src/analyzer/capacity.ts` — imports:

```ts
import { getCachedUserSettings } from '../workspace/user-settings.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { endpointModelId, parseEndpointModelId } from './model-id.js';
import { resolveLimits } from './rate-limit.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import { getCachedCatalogLimits } from './catalog/analyzer-catalog.js';
```

Add the function below. W2's `resolveCapacity(sel: { engine: 'local' | 'gemini'; model: string })` (Task 2.3) has no `openai` case. Do not redefine it; widen it in place (next paragraph):

```ts
function resolveEndpointCapacity(sel: { model: string; endpoint?: AnalyzerEndpoint }): EngineCapacity {
  const parsed = parseEndpointModelId(sel.model);
  const endpointId = parsed?.endpointId ?? sel.endpoint?.id ?? sel.model;
  const endpoint = sel.endpoint ?? getCachedUserSettings().analyzerEndpoints.find((e) => e.id === endpointId);
  if (!endpoint) throw new AnalyzerEndpointMissingError(endpointId, 'settings');
  const fullId = endpointModelId(endpoint.id, parsed?.model ?? sel.model);
  const tpm = resolveLimits(fullId).tpm;
  const caps = [endpoint.maxInputTokensPerRequest, Number.isFinite(tpm) ? tpm : undefined].filter(
    (n): n is number => typeof n === 'number',
  );
  const served = getCachedCatalogLimits(fullId)?.maxOutputTokens;
  const manual = endpoint.maxOutputTokens > 0 ? endpoint.maxOutputTokens : undefined;
  const maxOutputTokens =
    manual !== undefined ? (served !== undefined ? Math.min(manual, served) : manual) : (served ?? null);
  return {
    family: 'context',
    contextTokens: endpoint.contextTokens,
    maxOutputTokens,
    ...(caps.length > 0 ? { perRequestInputCap: Math.min(...caps) } : {}),
  };
}
```

`resolveCapacity`: widen W2's signature in place to `export function resolveCapacity(sel: { engine: AnalysisEngine; model: string; endpoint?: AnalyzerEndpoint }): EngineCapacity`, and add `import type { AnalysisEngine } from './model-id.js';`, merging with the `model-id.js` import above. Keep W2's body. Insert `if (sel.engine === 'openai') return resolveEndpointCapacity(sel);` as its first statement. W2's `local` / `gemini` branches do not change, so W2's pinning test stays byte-identical.

Context-family returns — `stage1-chunk.ts` (import `cloudBodyCharBudgetForCap` from `./token-budget.js` beside `cloudBodyCharBudget`). The W2 context branch (today's `:119-124` body, parametrised by `capacity.contextTokens`) becomes:

```ts
  const contextBudget = stage1ChunkBudgetForEngine(
    configValue<number>('analyzer.stage1.chunkCharBudget'),
    capacity.contextTokens,
    'local',
    configValue<number>('analyzer.stage1.localInputFraction'),
  );
  if (capacity.perRequestInputCap === undefined) return contextBudget;
  return Math.min(
    contextBudget,
    cloudBodyCharBudgetForCap(capacity.perRequestInputCap, body ?? '', stage1RosterReservedChars(runningRoster), STAGE1_CLOUD_RESERVED_TOKENS),
  );
```

`stage2-chunk.ts` context branch (today's `:76-81`):

```ts
  const contextBudget = stage2ChunkBudgetForEngine(
    configured,
    capacity.contextTokens,
    'local',
    configValue<number>('analyzer.stage2.localInputFraction'),
  );
  if (capacity.perRequestInputCap === undefined) return contextBudget;
  return Math.min(contextBudget, cloudBodyCharBudgetForCap(capacity.perRequestInputCap, body ?? ''));
```

`chapter-chunker.ts` context branch (today's `:136`):

```ts
  if (capacity.family === 'context') {
    const contextBudget = resolveStage1ChunkCharBudget({ ...capacity, perRequestInputCap: undefined });
    if (capacity.perRequestInputCap === undefined) return contextBudget;
    return Math.min(contextBudget, cloudBodyCharBudgetForCap(capacity.perRequestInputCap, sampleText, reservedChars, reservedTokens));
  }
```

(Stripping the cap before delegating keeps stage 1's reservations out of the output-heavy passes, which reserve their own.)

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/capacity.endpoint.test.ts src/analyzer/stage1-chunk.test.ts src/analyzer/stage2-chunk.test.ts src/analyzer/chapter-chunker.test.ts src/analyzer/token-budget.test.ts src/analyzer/output-heavy-tpm.test.ts` plus W2's pinning test file, then `npm run check:cycles`. Expected: PASS; pinning values unchanged.

- [ ] **Step 5: Mutation proof**
1. `stage2-chunk.ts`: replace the capped `return Math.min(…)` with `return contextBudget;` → red: "a binding cap lowers the stage-2 budget…". Restore.
2. `resolveEndpointCapacity`: drop `Number.isFinite(tpm) ? tpm : undefined` from `caps` → red: "perRequestInputCap is the min of maxInputTokensPerRequest and the saved TPM". Restore.
3. `chapter-chunker.ts`: pass `capacity` (not the cap-stripped copy) to `resolveStage1ChunkCharBudget` → red: "…chapter passes using the caller reservations" (stage-1 reservations now leak in). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capacity.ts server/src/analyzer/capacity.endpoint.test.ts server/src/analyzer/token-budget.ts server/src/analyzer/stage1-chunk.ts server/src/analyzer/stage2-chunk.ts server/src/analyzer/chapter-chunker.ts
git commit -m "feat(server): endpoint capacity and per-request caps on context-family budgets"
```

---
### Task 3c.10: Pre-run checks — endpoint exists, key origin, capability record — before the first analyzer call

**Files:**
- Modify: `server/src/analyzer/select-analyzer.ts:61-100` (extract `resolvePhaseModelSelection`; `selectAnalyzerForPhase` delegates — behaviour-preserving)
- Create: `server/src/analyzer/preflight.ts`
- Modify: `server/src/routes/analysis.ts:3315-3316` (main POST), `:6543-6546` (subset POST)
- Modify: `server/src/routes/script-review.ts:36,42` (imports), `:695` (job start)
- Modify: `server/src/routes/annotate-emotion.ts` (imports; before `:147`), `server/src/routes/instruct-annotation.ts` (imports; before `:146`)
- Test: Create `server/src/analyzer/preflight.test.ts`, `server/src/analyzer/select-analyzer.phase-source.test.ts`, `server/src/routes/analysis.preflight.test.ts`; extend `server/src/routes/annotate-emotion.test.ts`, `server/src/routes/instruct-annotation.test.ts`, `server/src/routes/script-review.test.ts`

**Interfaces:**
- Consumes: `capabilityRecordFor`, `assertConfiguredCapabilitiesAllowed` (Task 3c.3); `keyOriginMatches` (3b); `inferEngineFromModelId`, `parseEndpointModelId` (3a); `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError` (3b); `classifyAnalysisFailure` (`failure-taxonomy.ts:492`, 3b's mappings); `getResolvedAnalysisEngine` (`user-settings.ts:781`), `getResolvedOllamaModel` (`:766`), `getResolvedOllamaUrl` (`:597`), `configValue`.
- Produces: `resolvePhaseModelSelection(opts: PerPhaseAnalyzerOptions): { modelId: string | null; source: 'env' | 'run-pick' | 'settings' | 'default' }`; `PreflightTarget`; `preflightTargets(phases, requestedModel, settings)`; `runAnalyzerPreflight(targets, settings): void`.

Order of checks per distinct model id: endpoint id exists in saved settings (else `AnalyzerEndpointMissingError(id, source)` — `source` is `env` for `ANALYZER_PHASE{0,1}_MODEL`, `run-pick` for the request's `model`, `settings` otherwise); a stored key whose origin differs from the base URL (`AnalyzerKeyOriginError`); a Test record for the current server URL that marks the configured structured-output mode `rejected` (`AnalyzerCapabilityRejectedError`). Ollama and Gemini ids get the capability check only. Each route answers with its SSE `error` event carrying `classifyAnalysisFailure`'s `code`, `message`, `remediation` and ends before `selectAnalyzerForPhase` runs. The env-var tier order is moved verbatim from `selectAnalyzerForPhase`; if #3141 changed that tier list on `main`, move `main`'s tiers.

Keeps green: `select-analyzer.test.ts`, `analysis.test.ts`, `analysis.phase-model.test.ts`, `analysis-pipelining.test.ts` (slow lane: `npm --prefix server run test:slow -- src/routes/analysis-pipelining.test.ts`), `annotate-emotion.test.ts`, `instruct-annotation.test.ts`, `script-review.test.ts`, `direct-env-reader-guard.test.ts` (the `process.env[phaseEnvKey]` read moves within `select-analyzer.ts`; its literal names keep the same occurrence count).

- [ ] **Step 1: Write the failing tests**

Create `server/src/analyzer/select-analyzer.phase-source.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { resolvePhaseModelSelection } from './select-analyzer.js';
import { DEFAULT_USER_SETTINGS } from '../workspace/user-settings.js';

afterEach(() => {
  delete process.env.ANALYZER_PHASE0_MODEL;
  delete process.env.ANALYZER_PHASE1_MODEL;
});

describe('resolvePhaseModelSelection (#3084)', () => {
  const settings = { ...DEFAULT_USER_SETTINGS, analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: null };
  it('env wins and is reported as env', () => {
    process.env.ANALYZER_PHASE0_MODEL = ' openai:lab::m ';
    expect(resolvePhaseModelSelection({ phase: 'phase0', model: 'qwen3.5:4b', userSettings: settings })).toEqual({ modelId: 'openai:lab::m', source: 'env' });
  });
  it('then the per-run pick', () => {
    expect(resolvePhaseModelSelection({ phase: 'phase0', model: 'qwen3.5:4b', userSettings: settings })).toEqual({ modelId: 'qwen3.5:4b', source: 'run-pick' });
  });
  it('then saved settings', () => {
    expect(resolvePhaseModelSelection({ phase: 'phase0', userSettings: settings })).toEqual({ modelId: 'gemma-4-31b-it', source: 'settings' });
  });
  it('then the engine default (no id)', () => {
    expect(resolvePhaseModelSelection({ phase: 'phase1', userSettings: settings })).toEqual({ modelId: null, source: 'default' });
  });
});
```

Create `server/src/analyzer/preflight.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { runAnalyzerPreflight, preflightTargets } from './preflight.js';
import { AnalyzerCapabilityRejectedError, AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from './errors.js';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab server', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 });
const rejectedSchema = {
  serverUrl: 'http://127.0.0.1:8080/v1', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true as const },
  structuredOutput: { schema: { configured: 'rejected' as const } }, reasoning: {},
};
const settings = (over: Partial<UserSettings> = {}): UserSettings => ({
  ...DEFAULT_USER_SETTINGS, analyzerEndpoints: [lab], analyzerEndpointKeys: {}, analyzerCapabilitiesByModel: {}, ...over,
});

function thrown(fn: () => void): unknown {
  try { fn(); } catch (err) { return err; }
  return undefined;
}

afterEach(() => {
  delete process.env.ANALYZER_PHASE1_MODEL;
});

describe('runAnalyzerPreflight (#3084)', () => {
  it('passes a configured endpoint with no key and no record', () => {
    const s = settings();
    expect(() => runAnalyzerPreflight(preflightTargets(['phase0', 'phase1'], 'openai:lab::qwen3-30b', s), s)).not.toThrow();
  });

  it('a deleted endpoint from the per-run pick → AnalyzerEndpointMissingError source run-pick', () => {
    const s = settings({ analyzerEndpoints: [] });
    const err = thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::qwen3-30b', s), s));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'lab', source: 'run-pick' });
  });

  it('a deleted endpoint named by env → source env', () => {
    process.env.ANALYZER_PHASE1_MODEL = 'openai:gone::m';
    const s = settings();
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase1'], undefined, s), s))).toMatchObject({ endpointId: 'gone', source: 'env' });
  });

  it('a deleted endpoint saved as the phase model → source settings', () => {
    const s = settings({ analyzerPhase0Model: 'openai:gone::m' });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], undefined, s), s))).toMatchObject({ endpointId: 'gone', source: 'settings' });
  });

  it('a stored key for another host → AnalyzerKeyOriginError', () => {
    const s = settings({ analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'k' } } });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s))).toBeInstanceOf(AnalyzerKeyOriginError);
  });

  it('a Test record that rejected the configured mode refuses the run', () => {
    const s = settings({ analyzerCapabilitiesByModel: { 'openai:lab::m': rejectedSchema } });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s))).toBeInstanceOf(AnalyzerCapabilityRejectedError);
  });

  it('a rejection recorded against an old base URL is discarded', () => {
    const s = settings({ analyzerCapabilitiesByModel: { 'openai:lab::m': { ...rejectedSchema, serverUrl: 'http://10.0.0.5:8080/v1' } } });
    expect(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s)).not.toThrow();
  });

  it('an Ollama model whose configured schema mode was rejected at the Ollama URL is refused', () => {
    const s = settings({ analyzerCapabilitiesByModel: { 'qwen3.5:4b': { ...rejectedSchema, serverUrl: 'http://localhost:11434' } } });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'qwen3.5:4b', s), s))).toBeInstanceOf(AnalyzerCapabilityRejectedError);
  });
});
```

Create `server/src/routes/analysis.preflight.test.ts`:

```ts
/* #3084 — the main analysis POST refuses a run whose model points at a missing endpoint
   before any analyzer is selected (spec data-flow step 1). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { putManuscript, removeManuscript, type ChapterHint } from '../store/manuscripts.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

const { selectSpy } = vi.hoisted(() => ({ selectSpy: vi.fn() }));
vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: Parameters<typeof actual.selectAnalyzerForPhase>[0]) => {
      selectSpy(opts);
      return actual.selectAnalyzerForPhase(opts);
    },
  };
});

const { analysisRouter } = await import('./analysis.js');

afterEach(() => {
  removeManuscript('m_preflight');
  _resetUserSettingsCache();
  selectSpy.mockReset();
});

function parseSse(body: string): Array<Record<string, unknown>> {
  return body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice('data: '.length)));
}

describe('POST /api/manuscripts/:id/analysis — pre-run checks (#3084)', () => {
  it('refuses a per-run pick of a deleted endpoint with analyzer-endpoint-missing, before selection', async () => {
    const chapterHints = [{ id: 1, title: 'Chapter One', body: 'The lamp guttered.' }] as unknown as ChapterHint[];
    putManuscript({
      manuscriptId: 'm_preflight', format: 'plaintext', title: 'Stub', wordCount: 3, byteSize: 100,
      uploadedAt: new Date().toISOString(), sourceText: 'The lamp guttered.', chapterHints,
    });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);
    const res = await request(app).post('/api/manuscripts/m_preflight/analysis').send({ model: 'openai:gone::qwen3-30b' });
    expect(parseSse(res.text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'analyzer-endpoint-missing' }));
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
```

Append to `server/src/routes/annotate-emotion.test.ts` (inside `describe('POST /api/books/:bookId/annotate-emotion'`), and the same block to `instruct-annotation.test.ts` with the path `instruct-annotation`; add `import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';` at the top of each:

```ts
  it('#3084 — refuses a model on a deleted endpoint before the analyzer is called', async () => {
    writeBook(SENTENCES);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    try {
      const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({ model: 'openai:gone::m' });
      expect(parseSse(res.text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'analyzer-endpoint-missing' }));
      expect(runEmotion).not.toHaveBeenCalled();
    } finally {
      _resetUserSettingsCache();
    }
  });
```

(In `instruct-annotation.test.ts` the hoisted fake is the one that file's `vi.hoisted` declares at the same place as `runEmotion` here; assert `not.toHaveBeenCalled()` on that fake.)

Append to `server/src/routes/script-review.test.ts` (inside its POST `describe`; it already imports both user-settings helpers at `:19`):

```ts
  it('#3084 — refuses a model on a deleted endpoint before selecting an analyzer', async () => {
    writeBook(SENTENCES);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    selectAnalyzerForPhaseMock.mockClear();
    try {
      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ model: 'openai:gone::m' });
      expect(parseSse(res.text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'analyzer-endpoint-missing' }));
      expect(selectAnalyzerForPhaseMock).not.toHaveBeenCalled();
    } finally {
      _resetUserSettingsCache();
    }
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/select-analyzer.phase-source.test.ts src/analyzer/preflight.test.ts src/routes/analysis.preflight.test.ts src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts src/routes/script-review.test.ts`
Expected: FAIL — `resolvePhaseModelSelection is not a function`; `Failed to load url ./preflight.js`; route tests see no `analyzer-endpoint-missing` event (the run reaches selection, and 3a's `selectAnalyzer` refusal or the fake analyzer answers instead).

- [ ] **Step 3: Implement**

`server/src/analyzer/select-analyzer.ts` — replace `:61-100` with:

```ts
export type PhaseModelSource = 'env' | 'run-pick' | 'settings' | 'default';

/** The precedence chain of selectAnalyzerForPhase, without constructing an analyzer, so
    pre-run checks (#3084) validate the same model id the run will use and can name where
    it came from. Precedence (highest first): env ANALYZER_PHASE{0,1}_MODEL → per-request
    opts.model → user-settings analyzerPhase{0,1}Model → engine default (modelId null). */
export function resolvePhaseModelSelection(opts: PerPhaseAnalyzerOptions): { modelId: string | null; source: PhaseModelSource } {
  const phaseEnvKey = opts.phase === 'phase0' ? 'ANALYZER_PHASE0_MODEL' : 'ANALYZER_PHASE1_MODEL';
  const phaseEnvModel = process.env[phaseEnvKey];
  if (phaseEnvModel && phaseEnvModel.trim().length > 0) {
    return { modelId: phaseEnvModel.trim(), source: 'env' };
  }
  if (opts.model) return { modelId: opts.model, source: 'run-pick' };
  const settings = opts.userSettings ?? getCachedUserSettings();
  const settingsModelRaw = opts.phase === 'phase0' ? settings.analyzerPhase0Model : settings.analyzerPhase1Model;
  const settingsModel = settingsModelRaw?.trim();
  if (settingsModel && settingsModel.length > 0) return { modelId: settingsModel, source: 'settings' };
  return { modelId: null, source: 'default' };
}

/** Resolve an analyzer for the given phase — see resolvePhaseModelSelection for the
    precedence. The route layer caches the result per phase. */
export function selectAnalyzerForPhase(opts: PerPhaseAnalyzerOptions): AnalyzerSelection {
  const resolved = resolvePhaseModelSelection(opts);
  return resolved.modelId === null ? selectAnalyzer({}) : selectAnalyzer({ model: resolved.modelId });
}
```

Create `server/src/analyzer/preflight.ts`:

```ts
/* #3084 W3 — pre-run checks (spec data flow step 1): before a run's first analyzer call,
   every model id the run will use must name an existing endpoint, a key still bound to
   that endpoint's origin, and no Test record that rejected the configured structured-
   output mode. Env and per-run picks cannot be blocked at settings-save time, so this is
   where they fail — as analyzer-endpoint-missing / auth / analyzer-request-rejected. */
import { configValue } from '../config/resolver.js';
import {
  getResolvedAnalysisEngine,
  getResolvedOllamaModel,
  getResolvedOllamaUrl,
  type UserSettings,
} from '../workspace/user-settings.js';
import { resolveEndpointApiKey } from '../workspace/analyzer-endpoints.js';
import { inferEngineFromModelId, parseEndpointModelId } from './model-id.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import { assertConfiguredCapabilitiesAllowed, capabilityRecordFor } from './capabilities.js';
import { resolvePhaseModelSelection, type AnalysisPhase } from './select-analyzer.js';
import type { StructuredOutputMode } from './runner/transport.js';

export interface PreflightTarget {
  modelId: string;
  source: 'env' | 'run-pick' | 'settings';
}

function engineDefaultModelId(settings: UserSettings): string {
  const engine = getResolvedAnalysisEngine();
  if (engine === 'openai') return settings.defaultAnalysisModel;
  if (engine === 'gemini') return configValue<string>('analyzer.gemini.model');
  return getResolvedOllamaModel();
}

export function preflightTargets(
  phases: readonly AnalysisPhase[],
  requestedModel: string | undefined,
  settings: UserSettings,
): PreflightTarget[] {
  return phases.map((phase) => {
    const resolved = resolvePhaseModelSelection({ phase, model: requestedModel, userSettings: settings });
    if (resolved.modelId === null) return { modelId: engineDefaultModelId(settings), source: 'settings' };
    return { modelId: resolved.modelId, source: resolved.source === 'default' ? 'settings' : resolved.source };
  });
}

export function runAnalyzerPreflight(targets: readonly PreflightTarget[], settings: UserSettings): void {
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.modelId)) continue;
    seen.add(target.modelId);
    const engine = inferEngineFromModelId(target.modelId);
    if (engine === 'openai') {
      const parsed = parseEndpointModelId(target.modelId);
      const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
      if (!parsed || !endpoint) throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? target.modelId, target.source);
      resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl); // throws AnalyzerKeyOriginError for a key bound to another host
      assertConfiguredCapabilitiesAllowed(
        capabilityRecordFor(settings, target.modelId, endpoint.baseUrl),
        { structuredOutput: endpoint.structuredOutput, reasoning: undefined },
        target.modelId,
      );
    } else if (engine === 'gemini') {
      assertConfiguredCapabilitiesAllowed(
        capabilityRecordFor(settings, target.modelId, 'gemini'),
        { structuredOutput: configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput'), reasoning: undefined },
        target.modelId,
      );
    } else {
      assertConfiguredCapabilitiesAllowed(
        capabilityRecordFor(settings, target.modelId, getResolvedOllamaUrl()),
        { structuredOutput: configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput'), reasoning: undefined },
        target.modelId,
      );
    }
  }
}
```

`server/src/routes/analysis.ts` — import `import { preflightTargets, runAnalyzerPreflight } from '../analyzer/preflight.js';`. Main POST, between `const userSettings = await readUserSettings();` (`:3315`) and `let selection: AnalyzerSelection;` (`:3316`):

```ts
  /* #3084 — pre-run checks for both phases, before any analyzer is built or called. */
  try {
    runAnalyzerPreflight(preflightTargets(['phase0', 'phase1'], requestedModel, userSettings), userSettings);
  } catch (e) {
    const { code, userMessage: message, remediation, detail } = classifyAnalysisFailure(e, requestedModel ?? 'analyzer');
    send({ kind: 'error', code, message, remediation, detail });
    clearInterval(keepAlive);
    return res.end();
  }
```

Subset POST, between `const userSettings = await readUserSettings();` (`:6543`) and `let selection: AnalyzerSelection;` (`:6544`): the same block.

`server/src/routes/script-review.ts` — `:36` becomes `import { getCachedUserSettings, getResolvedGeminiApiKey, getResolvedAllowCloudFallback } from '../workspace/user-settings.js';`; add `import { classifyAnalysisFailure } from './failure-taxonomy.js';` and `import { preflightTargets, runAnalyzerPreflight } from '../analyzer/preflight.js';`. Before `const selection = selectAnalyzerForPhase({ phase: 'phase1', model });` (`:695`):

```ts
  try {
    const settings = getCachedUserSettings();
    runAnalyzerPreflight(preflightTargets(['phase1'], model, settings), settings);
  } catch (e) {
    const { code, userMessage: message, remediation } = classifyAnalysisFailure(e, model ?? 'analyzer');
    send({ kind: 'error', code, message, remediation });
    for (const sub of job.subscribers) sub.res.end();
    return;
  }
```

`server/src/routes/annotate-emotion.ts` and `instruct-annotation.ts` — add `import { getCachedUserSettings } from '../workspace/user-settings.js';`, `import { classifyAnalysisFailure } from './failure-taxonomy.js';`, `import { preflightTargets, runAnalyzerPreflight } from '../analyzer/preflight.js';`. Before `const selection = selectAnalyzerForPhase({ phase: 'phase1', model: req.body?.model });` (`annotate-emotion.ts:147`, `instruct-annotation.ts:146`):

```ts
    try {
      const settings = getCachedUserSettings();
      runAnalyzerPreflight(preflightTargets(['phase1'], req.body?.model, settings), settings);
    } catch (e) {
      const { code, userMessage: message, remediation } = classifyAnalysisFailure(e, req.body?.model ?? 'analyzer');
      send({ kind: 'error', code, message, remediation });
      clearInterval(keepAlive);
      res.end();
      return;
    }
```

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/select-analyzer.phase-source.test.ts src/analyzer/select-analyzer.test.ts src/analyzer/preflight.test.ts src/routes/analysis.preflight.test.ts src/routes/analysis.test.ts src/routes/analysis.phase-model.test.ts src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts src/routes/script-review.test.ts src/config/direct-env-reader-guard.test.ts`, then `npm --prefix server run test:slow -- src/routes/analysis-pipelining.test.ts`, then `npm run check:cycles`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `preflight.ts`: delete the `if (!parsed || !endpoint) throw …` line → red: "a deleted endpoint from the per-run pick…", the route tests. Restore.
2. `preflight.ts`: pass `'settings'` instead of `target.source` → red: "a deleted endpoint named by env → source env", "…per-run pick → … source run-pick". Restore.
3. `analysis.ts` main POST: delete the preflight `try/catch` block → red: `analysis.preflight.test.ts` (selection spy called; no `analyzer-endpoint-missing`). Restore.
4. `annotate-emotion.ts`: delete its preflight block → red: "#3084 — refuses a model on a deleted endpoint before the analyzer is called". Restore. Repeat for `instruct-annotation.ts` and `script-review.ts`.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/select-analyzer.ts server/src/analyzer/select-analyzer.phase-source.test.ts server/src/analyzer/preflight.ts server/src/analyzer/preflight.test.ts server/src/routes/analysis.ts server/src/routes/analysis.preflight.test.ts server/src/routes/script-review.ts server/src/routes/script-review.test.ts server/src/routes/annotate-emotion.ts server/src/routes/annotate-emotion.test.ts server/src/routes/instruct-annotation.ts server/src/routes/instruct-annotation.test.ts
git commit -m "feat(server): pre-run analyzer checks for endpoints, keys and Test records"
```

---

### Task 3c.11: Ship PR 3c

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md` (in-progress section at the top)
- Modify: `docs/testing/onbox-acceptance-register.md` (glance table `:556`, summary `:566`, a `> **Last change: …**` note above the existing ones at `:570`, new row in Group A after `### A106 …` at `:4458`, `<!-- next-id: A107 -->` at `:1298`)
- Create: `docs/testing/openai-analyzer-onbox-acceptance.md`
- Modify: `docs/testing/onbox-acceptance-register-live-view.html` (new `<details class="item">` after the A106 block at `:708-712`)

- [ ] **Step 1: Regenerate and check derived artifacts**
Run: `npm run openapi:types` (commit any diff), `npm run config:sync` then `npm run config:check`, `npm run typecheck`, `npm run check:cycles`. Expected: clean.

- [ ] **Step 2: On-box row (the Test action runs against real servers only on the box)**

Read the Group A marker; at 2b63b451 it is `<!-- next-id: A107 -->`. Its value at ship time is this row's id, written `‹row-3c›` below (no literal id in the steps), bump the marker by one in the same commit. Add to Group A, after the last row:

```markdown
### ‹row-3c› · Live structured output — Test action ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), PR #NNNN) · **GPU box with Ollama + a llama-swap endpoint on one card; a Gemini key**

The Test action (Advanced Settings → Analyzer rate limits → **Test**) sends a control
request with no structured output (`off` mode, so a server that rejects `json`, such as LM
Studio, still passes it), then the configured structured-output check with a schema marker
the prompt never mentions, and records `enforced` / `ignored` / `rejected`. Unit tests use fake transports;
only real servers show whether the recorded outcome matches what the model does.

- Run **Test** (configured) and **Test every mode** on `qwen3.5:4b` (Ollama), a `gemma-*`
  and a `gemini-*` model, and a llama-swap endpoint model with thinking on and off.
- Record each outcome and compare it with a hand request in the same mode: an `ignored`
  record must correspond to output without the marker; `enforced` to output with it.
- Record what the Gemini adapter drops (the entry's `structuredOutput.dropped` in
  `GET /api/analyzer/models`).
- Change the endpoint's base URL: the record disappears from the catalog entry.
- Criteria: `docs/testing/openai-analyzer-onbox-acceptance.md` § "Live structured output".
```

Glance table (`:556`): Group A rows `32` → `33` (or current + 1). Add a `> **Last change: <date> (#3084 W3c), <owed> → <owed + 1>.** Row **‹row-3c›** (live structured output — Test action) added.` note above the newest existing note. Run `npm run register:build`; copy the owed total it reports into the `**NN owed.**` line (`:566`) if it differs.

Create `docs/testing/openai-analyzer-onbox-acceptance.md`:

```markdown
# OpenAI-compatible analyzer — on-box acceptance run sheet (#3084)

Register rows: ‹row-3c› (this PR; id minted from Group A's next-id marker); wave 3's last PR extends it and adds the eviction and
long-prefill rows. Prerequisites: the GPU box, Ollama with `qwen3.5:4b`, a Gemini API key,
llama-swap serving one model with a per-model unload endpoint.

## Live structured output

1. Advanced Settings → Analyzer rate limits. For each of `qwen3.5:4b`, one `gemma-*`,
   one `gemini-*`, and the llama-swap model (thinking on, then off): click **Test**, confirm
   the request count (2; 1 for a model whose configured mode is `off`), run. Then **Test** with "Test every structured-output mode" (3: the off-mode control, `schema`, `json`).
   Result:
2. For each `schema` outcome, send one request by hand in `schema` mode and note whether the
   reply contains `cw_probe_marker`. `enforced` ⇔ present, `ignored` ⇔ absent.
   Result:
3. `GET /api/analyzer/models` → note each Gemini entry's `structuredOutput.dropped`.
   Result:
4. Change the llama-swap endpoint's base URL (e.g. `localhost` → `127.0.0.1`): the entry's
   `capability` is gone and the label no longer says "not enforced".
   Result:
```

Live view — after the A106 `</details>` (`:712` area), insert:

```html
    <details class="item">
      <summary><span class="num">‹row-3c›</span><span class="iname">Live structured output — Test action records match real model behaviour</span><span class="risk">GPU box, Ollama + llama-swap endpoint on one card, Gemini key</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Run Test (configured, then every mode) on qwen3.5:4b, a gemma-* and a gemini-* model, and a llama-swap endpoint model with thinking on and off. Each <code>enforced</code>/<code>ignored</code> outcome must match a hand request (marker present/absent); record the Gemini adapter's <code>dropped</code> list; a base-URL change discards the record.</p>
        <p>Criteria: <code>docs/testing/openai-analyzer-onbox-acceptance.md</code> § Live structured output. #3084.</p>
      </div>
    </details>
```

Run `npm run register:build` and `npm run check:onbox-register`. Save the page currently live at the register header's URL (`https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a`) to a local file and run `npm run check:onbox-register -- --against-published <that file>`; publish `docs/testing/onbox-acceptance-register-live-view.html` to that URL with the Artifact tool (`url` set) only when it passes.

- [ ] **Step 3: Release notes**

`docs/release-notes-next.md` (append):

```markdown
- **Analyzer model catalog, per-model rate limits, and a model Test action** (#3084, W3c). New `GET /api/analyzer/models` lists Ollama tags, Gemini `models.list()` (with a key) and every saved OpenAI-compatible endpoint's `/v1/models` (served context from `max_model_len` → `meta.n_ctx` → `context_length`, never `n_ctx_train`), cached 30 s with `refresh=1`. The six `rate.{rpm,tpm,rpd}.gemma[26]` registry knobs are retired into the `analyzerRateLimitsByModel` user-settings map (saved overrides migrate on first read); `resolveLimits` is exported and engine-aware (endpoints unlimited unless set). `POST /api/analyzer/models/test` runs a control request plus a schema-marker probe and stores `analyzerCapabilitiesByModel`; runs refuse before their first call when a model's endpoint is missing, its key is bound to another host, or its configured structured-output mode was recorded `rejected`. Nine model-label sites now use one `modelLabel` resolver.
```

`RELEASE_NOTES.md` (in-progress section):

```markdown
- **See every analyzer model you can use, set its limits, and test it.** Advanced Settings now lists the models your Ollama install, your Gemini key and your OpenAI-compatible servers actually offer, lets you set per-model request limits, and has a **Test** button that checks whether a model really follows Castwright's output format before you spend a whole book on it.
```

- [ ] **Step 4: Verify** — Run: `npm run verify:fast:branch`. Expected: green.

- [ ] **Step 5: Commit, push, PR**
```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/testing/onbox-acceptance-register.md docs/testing/openai-analyzer-onbox-acceptance.md docs/testing/onbox-acceptance-register-live-view.html
git commit -m "docs(docs): record W3c release notes and the live structured-output acceptance row"
git push -u origin feat/server,openapi-3084-w3c-catalog-test
```
PR title: `feat(server,openapi,frontend): analyzer catalog, per-model limits, model Test and pre-run checks`. Body: `## Summary` (the Delivers list), `## Test plan` (every test file above, the three mutation-proof red outputs per task, the captured label table, the printed stage-schema sizes), `Refs #3084`, and **Also fixed, found in passing:** the stale `direct-env-reader-guard.test.ts` comment that cited retired registry defaults; the hand-written `.env.example` rate-limit block now documents `0` as unlimited and the Settings tier; six label sites the scout inventory missed (all nine now use `modelLabel`). State that #3163's `rate-limit.ts` runtime-read trigger was removed with its guard entry.

- [ ] **Step 6: Review gate** — run the `pr-review-gate` skill at depth `high` (multi-scope `server,openapi,frontend`); fold findings; merge only with cloud `verify.yml` green.

---

### PR 3d — GPU coordination, eviction, fallback, selection, Settings UI: endpoints become selectable

**Branch:** `feat/server,frontend-3084-w3d-selectable` — `node scripts/wt-new.mjs feat/server,frontend-3084-w3d-selectable` off `main` after PR 3c merged.

**Delivers:**
- Endpoint calls on a GPU (`gpu !== 'none'`) count as analyzer calls in flight; TTS capacity eviction POSTs matching endpoints' unload URLs (same latch and in-flight gate as Ollama, not gated on Ollama's VRAM figure, capacity re-probed after an unload, a failure message that names the Unload URL setting).
- `FallbackAnalyzer` announces endpoint outages generically; `selectAnalyzer` builds `OpenAIAnalyzer` (with the Gemini fallback wrap under `allowCloudFallback`); `ANALYSIS_ENGINE_VALUES` and the `analysisEngine` OpenAPI enums accept `openai`; route engine branches classified and updated.
- Frontend: `defaultGpuForBaseUrl`, `endpointForModelId`, `analyzerSharesTtsDevice`; the forward and reverse guards and the generation hold compare cards; `activeStream.gpu` captured at every dispatch site; pickers list endpoint groups; the run label shows the structured-output mode.
- Settings → Analyzer endpoints (list/add/edit/delete, required context with prefill + Detect + "may load the model" confirm, key field with host-change re-entry, GPU picker, unload URL with `{model}` hint, concurrency, ceiling, structured output), Playwright spec, two new on-box rows and the extension of the 3c "Live structured output" row.

**Must NOT change:** Ollama eviction when no endpoint shares the card (existing `capacity-retry.test.ts` and `sidecar.test.ts` cases stay byte-for-byte green); Ollama-only route branches (`analysis.ts:3203`, `:3625`; `script-review.ts:724`, `:780`); `buildCloudEscalationAnalyzer` stays Gemini; no reasoning or custom-payload controls (wave 5).

**Entry criteria:** PR 3c merged.
**Exit criteria:** all task tests green; `npm run test:e2e -- e2e/analyzer-endpoints.spec.ts` green; `npm run verify:fast:branch` green; the 3c row extended and two new Group A rows recorded and the live view republished; `pr-review-gate` at depth `high` folded.

---
### Task 3d.1: In-flight accounting for endpoint calls on a GPU

**Files:**
- Modify: `server/src/analyzer/analyzer-concurrency.ts` (after `acquireAnalyzerSlot`, `:72`)
- Modify: `server/src/analyzer/transports/openai-transport.ts` (3b) — `send()`: right after the endpoint semaphore acquisition, and in the `finally` that releases it
- Modify: `server/src/gpu/capacity-retry.ts:20` (import), `:121-123` (doc), `:236-237` (default); `server/src/tts/sidecar.ts:162-164` (doc), `:193-194` (default) and its `getAnalyzerConcurrencyStats` import
- Test: `server/src/analyzer/analyzer-concurrency.test.ts` (extend), Create `server/src/analyzer/transports/openai-transport.in-flight.test.ts`

**Interfaces:**
- Consumes: `OpenAITransport` (3b) constructor `{ endpoint, apiKey, model, dispatcher? }`; `analyzerEndpointSchema` (3b); `TransportRequest` (W1).
- Produces (contract): `registerEndpointCallInFlight(): () => void`, `isAnyAnalyzerCallInFlight(): boolean`.

Planning interpretation (recorded in the brief): only endpoints with `gpu !== 'none'` register. Endpoint calls are counted separately from Ollama slots so `getAnalyzerConcurrencyStats().peak` keeps meaning "Ollama calls past the K limiter".

Keeps green: `analyzer-concurrency.test.ts`, 3b's `openai-transport.test.ts`, `capacity-retry.test.ts`, `sidecar.test.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/analyzer/analyzer-concurrency.test.ts`:

```ts
import { registerEndpointCallInFlight, isAnyAnalyzerCallInFlight, acquireAnalyzerSlot } from './analyzer-concurrency.js';

describe('endpoint in-flight accounting (#3084)', () => {
  it('a registered endpoint call counts until released; release is idempotent', () => {
    expect(isAnyAnalyzerCallInFlight()).toBe(false);
    const release = registerEndpointCallInFlight();
    expect(isAnyAnalyzerCallInFlight()).toBe(true);
    release();
    release();
    expect(isAnyAnalyzerCallInFlight()).toBe(false);
  });

  it('an Ollama slot alone also counts', async () => {
    const release = await acquireAnalyzerSlot('qwen3.5:4b', false);
    expect(isAnyAnalyzerCallInFlight()).toBe(true);
    release();
    expect(isAnyAnalyzerCallInFlight()).toBe(false);
  });
});
```

Create `server/src/analyzer/transports/openai-transport.in-flight.test.ts`:

```ts
/* #3084 — an endpoint call on a GPU is visible to TTS eviction's in-flight gate for
   exactly as long as it runs. Real http server + real undici Agent (Global Constraints). */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { OpenAITransport } from './openai-transport.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import { isAnyAnalyzerCallInFlight } from '../analyzer-concurrency.js';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const CHUNK = `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

async function heldServer(): Promise<{ baseUrl: string; received: Promise<void>; finish: () => void }> {
  let onReceived!: () => void;
  const received = new Promise<void>((r) => (onReceived = r));
  let held: ServerResponse | undefined;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    held = res;
    onReceived();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, received, finish: () => held?.end(CHUNK) };
}

function transportFor(baseUrl: string, gpu: string) {
  const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl, gpu, contextTokens: 4096 });
  return new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 2_000 } }) });
}

const REQUEST = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'hi' }],
  structuredOutput: { mode: 'off' as const },
  temperature: 0,
  estimatedInputTokens: 10,
  call: {},
};

describe('OpenAITransport in-flight registration (#3084)', () => {
  it('a gpu endpoint call is in flight while streaming and not after', async () => {
    const s = await heldServer();
    const pending = transportFor(s.baseUrl, 'cuda:0').send(REQUEST);
    await s.received;
    expect(isAnyAnalyzerCallInFlight()).toBe(true);
    s.finish();
    await pending;
    expect(isAnyAnalyzerCallInFlight()).toBe(false);
  });

  it("a gpu 'none' endpoint never registers", async () => {
    const s = await heldServer();
    const pending = transportFor(s.baseUrl, 'none').send(REQUEST);
    await s.received;
    expect(isAnyAnalyzerCallInFlight()).toBe(false);
    s.finish();
    await pending;
  });

  it('a failed call releases its registration', async () => {
    const s = await heldServer();
    const pending = transportFor(s.baseUrl, 'any').send(REQUEST);
    await s.received;
    server!.closeAllConnections();
    await pending.catch(() => undefined);
    expect(isAnyAnalyzerCallInFlight()).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/analyzer-concurrency.test.ts src/analyzer/transports/openai-transport.in-flight.test.ts`
Expected: FAIL — `registerEndpointCallInFlight is not a function` / `isAnyAnalyzerCallInFlight is not a function`.

- [ ] **Step 3: Implement**

`server/src/analyzer/analyzer-concurrency.ts`, after `acquireAnalyzerSlot` (`:72`):

```ts
/* #3084 — OpenAI-compatible endpoint calls on a GPU (endpoint.gpu !== 'none') register
   here so TTS capacity eviction never unloads a model mid-call. Counted apart from the
   Ollama K limiter so its peak stays an Ollama-only figure. */
let endpointInFlightCount = 0;

export function registerEndpointCallInFlight(): () => void {
  endpointInFlightCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    endpointInFlightCount--;
  };
}

/** True while any Ollama slot or any registered endpoint call is in flight. */
export function isAnyAnalyzerCallInFlight(): boolean {
  return inFlightCount > 0 || endpointInFlightCount > 0;
}
```

`openai-transport.ts` (3b) — import `registerEndpointCallInFlight` from `'../analyzer-concurrency.js'`; immediately after the line that awaits `endpointSemaphore(this.endpoint).acquire(...)`:

```ts
    const releaseInFlight = this.endpoint.gpu !== 'none' ? registerEndpointCallInFlight() : () => {};
```

and in the same `finally` that releases the semaphore, before that release: `releaseInFlight();`.

`capacity-retry.ts` — `:20` becomes `import { isAnyAnalyzerCallInFlight } from '../analyzer/analyzer-concurrency.js';`; the option doc at `:121-122` reads `/** Injected "is the analyzer mid-run" check — defaults to isAnyAnalyzerCallInFlight (Ollama slots + endpoint calls on a GPU). */`; `:236-237` becomes `const isAnalysisInFlight = opts.isAnalysisInFlight ?? isAnyAnalyzerCallInFlight;`.

`sidecar.ts` — replace its `getAnalyzerConcurrencyStats` import with `isAnyAnalyzerCallInFlight`; the doc at `:162-163` reads `/** Injected "is the analyzer mid-run" check — for testing only. Defaults to isAnyAnalyzerCallInFlight. */`; `:193-194` becomes `this.isAnalysisInFlight = opts.isAnalysisInFlight ?? isAnyAnalyzerCallInFlight;`.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/analyzer-concurrency.test.ts src/analyzer/transports/openai-transport.in-flight.test.ts src/analyzer/transports/openai-transport.test.ts src/gpu/capacity-retry.test.ts src/tts/sidecar.test.ts` then `npm run check:cycles`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `isAnyAnalyzerCallInFlight`: return `inFlightCount > 0` only → red: "a registered endpoint call counts…", "a gpu endpoint call is in flight while streaming…". Restore.
2. Transport: change `this.endpoint.gpu !== 'none'` to `true` → red: "a gpu 'none' endpoint never registers". Restore.
3. Transport: delete `releaseInFlight();` from `finally` → red: "a failed call releases its registration" and "…not after". Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/analyzer-concurrency.ts server/src/analyzer/analyzer-concurrency.test.ts server/src/analyzer/transports/openai-transport.ts server/src/analyzer/transports/openai-transport.in-flight.test.ts server/src/gpu/capacity-retry.ts server/src/tts/sidecar.ts
git commit -m "feat(server): count endpoint analyzer calls on a GPU as in flight"
```

---

### Task 3d.2: `gpu/endpoint-eviction.ts` — which endpoints share a card, and their unload POSTs

**Files:**
- Create: `server/src/gpu/endpoint-eviction.ts`
- Test: Create `server/src/gpu/endpoint-eviction.test.ts`

**Interfaces:**
- Consumes: `AnalyzerEndpoint`, `resolveUnloadUrl(endpoint, lastUsedModel)`, `keyOriginMatches` (3b); `lastUsedModel(endpointId)` (3b `endpoint-runtime.ts`); `getCachedUserSettings`.
- Produces (contract): `endpointsSharingDevice(endpoints, deviceKey)`, `evictEndpointsOnDevice(deviceKey, deps?): Promise<{ attempted: number }>`; plus `endpointUnloadNotes(deviceKey, settings?): string[]`.

Rules (spec §4 "Eviction"): an endpoint matches when `gpu === 'any'` or `gpu === deviceKey`; for each match with an unload URL, `{model}` is replaced by the endpoint's last-used model and an unload URL containing `{model}` with no model used since server start is skipped (brief's planning interpretation); the key is sent only under the origin rule, and an endpoint whose stored key no longer matches is skipped (no POST, not counted); POSTs are best-effort and sequential (llama-swap's unload blocks until the process stops, 06 fact 8), each bounded at 30 s. `attempted` counts POSTs actually sent. `endpointUnloadNotes` names every sharing endpoint without an unload URL, for the give-up message.

Import-cycle note: `server/src/gpu/` may not import a route module (CLAUDE.md "leaf gate" rule). This file imports only `workspace/*` and `analyzer/transports/endpoint-runtime.ts`; `npm run check:cycles` proves no new cycle.

Keeps green: `npm run check:cycles`.

- [ ] **Step 1: Write the failing test** — create `server/src/gpu/endpoint-eviction.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { endpointsSharingDevice, evictEndpointsOnDevice, endpointUnloadNotes } from './endpoint-eviction.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';

const ep = (id: string, gpu: string, unloadUrl?: string) =>
  analyzerEndpointSchema.parse({ id, name: id.toUpperCase(), baseUrl: `http://127.0.0.1:8080/v1`, gpu, contextTokens: 8192, ...(unloadUrl ? { unloadUrl } : {}) });

const settings = (endpoints: ReturnType<typeof ep>[], keys: UserSettings['analyzerEndpointKeys'] = {}): UserSettings => ({
  ...DEFAULT_USER_SETTINGS, analyzerEndpoints: endpoints, analyzerEndpointKeys: keys,
});

describe('endpointsSharingDevice (#3084)', () => {
  it("matches 'any' and the exact device key, never 'none' or another card", () => {
    const list = [ep('a', 'any'), ep('b', 'cuda:0'), ep('c', 'cuda:1'), ep('d', 'none')];
    expect(endpointsSharingDevice(list, 'cuda:0').map((e) => e.id)).toEqual(['a', 'b']);
    expect(endpointsSharingDevice(list, 'cuda:1').map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('evictEndpointsOnDevice (#3084)', () => {
  it('POSTs only matching endpoints with an unload URL, substituting {model}', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const s = settings([
      ep('swap0', 'cuda:0', 'http://127.0.0.1:8080/api/models/unload/{model}'),
      ep('swap1', 'cuda:1', 'http://127.0.0.1:8080/api/models/unload/{model}'),
      ep('nourl', 'cuda:0'),
    ]);
    const out = await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, lastUsedModel: () => 'qwen3-30b' });
    expect(out).toEqual({ attempted: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8080/api/models/unload/qwen3-30b');
    expect((fetch.mock.calls[0][1] as { method: string }).method).toBe('POST');
  });

  it('skips a {model} URL when no model has been used since server start', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const s = settings([ep('swap0', 'any', 'http://127.0.0.1:8080/api/models/unload/{model}')]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, lastUsedModel: () => undefined })).toEqual({ attempted: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the key as a Bearer token only when its origin matches, and skips a mismatched key', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const url = 'http://127.0.0.1:8080/api/models/unload';
    await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => settings([ep('a', 'any', url)], { a: { origin: 'http://127.0.0.1:8080', key: 'sk-a' } }), lastUsedModel: () => 'm' });
    expect((fetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-a');
    fetch.mockClear();
    const out = await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => settings([ep('a', 'any', url)], { a: { origin: 'http://10.0.0.5:8080', key: 'sk-a' } }), lastUsedModel: () => 'm' });
    expect(out).toEqual({ attempted: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a failing POST is best-effort: counted, logged, never thrown', async () => {
    const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = settings([ep('a', 'any', 'http://127.0.0.1:8080/unload'), ep('b', 'cuda:0', 'http://127.0.0.1:8080/unload')]);
    await expect(evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, lastUsedModel: () => 'm' })).resolves.toEqual({ attempted: 2 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('endpointUnloadNotes (#3084)', () => {
  it('names each sharing endpoint without an unload URL and the setting to fill in', () => {
    const notes = endpointUnloadNotes('cuda:0', settings([ep('lab', 'cuda:0'), ep('other', 'cuda:1'), ep('ok', 'any', 'http://127.0.0.1:8080/unload')]));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"LAB"');
    expect(notes[0]).toContain('Unload URL');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/gpu/endpoint-eviction.test.ts`  Expected: FAIL — `Failed to load url ./endpoint-eviction.js`.

- [ ] **Step 3: Implement** — create `server/src/gpu/endpoint-eviction.ts`:

```ts
/* #3084 W3 — TTS capacity eviction for OpenAI-compatible analyzer endpoints. When the
   sidecar denies admission on a card, endpoints assigned to that card (or to 'any') are
   asked to unload through their saved Unload URL. No VRAM figure exists for endpoints,
   so the caller does not gate this on analyzerEvictWouldHelp; it re-probes capacity after. */
import { fetch as undiciFetch } from 'undici';
import { getCachedUserSettings, type UserSettings } from '../workspace/user-settings.js';
import { keyOriginMatches, resolveUnloadUrl, type AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { lastUsedModel as defaultLastUsedModel } from '../analyzer/transports/endpoint-runtime.js';

const UNLOAD_TIMEOUT_MS = 30_000;

export function endpointsSharingDevice(endpoints: AnalyzerEndpoint[], deviceKey: string): AnalyzerEndpoint[] {
  return endpoints.filter((e) => e.gpu === 'any' || e.gpu === deviceKey);
}

export async function evictEndpointsOnDevice(
  deviceKey: string,
  deps: {
    fetch?: typeof undiciFetch;
    settings?: () => UserSettings;
    lastUsedModel?: (endpointId: string) => string | undefined;
  } = {},
): Promise<{ attempted: number }> {
  const doFetch = deps.fetch ?? undiciFetch;
  const settings = (deps.settings ?? getCachedUserSettings)();
  const lastModel = deps.lastUsedModel ?? defaultLastUsedModel;
  let attempted = 0;
  for (const endpoint of endpointsSharingDevice(settings.analyzerEndpoints, deviceKey)) {
    if (!endpoint.unloadUrl) continue;
    const url = resolveUnloadUrl(endpoint, lastModel(endpoint.id));
    if (!url) continue;
    const stored = settings.analyzerEndpointKeys[endpoint.id];
    if (stored && !keyOriginMatches(stored, url)) continue;
    attempted++;
    try {
      await doFetch(url, {
        method: 'POST',
        headers: stored ? { Authorization: `Bearer ${stored.key}` } : {},
        signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[gpu] unload request for analyzer endpoint "${endpoint.name}" failed: ${(err as Error).message}`);
    }
  }
  return { attempted };
}

/** Give-up notes for NoCapacityError: endpoints on this card that Castwright cannot unload. */
export function endpointUnloadNotes(deviceKey: string, settings: UserSettings = getCachedUserSettings()): string[] {
  return endpointsSharingDevice(settings.analyzerEndpoints, deviceKey)
    .filter((e) => !e.unloadUrl)
    .map(
      (e) =>
        `Analyzer endpoint "${e.name}" shares this card but has no Unload URL, so Castwright could not free it — set "Unload URL" for it in Model Manager → Analyzer endpoints.`,
    );
}
```

- [ ] **Step 4: Run and confirm it passes**  Run: `npm --prefix server run test -- src/gpu/endpoint-eviction.test.ts` then `npm run check:cycles`. Expected: PASS; no new cycle.

- [ ] **Step 5: Mutation proof**
1. `endpointsSharingDevice`: drop `e.gpu === 'any' ||` → red: "matches 'any' and the exact device key…". Restore.
2. Delete `if (stored && !keyOriginMatches(stored, url)) continue;` → red: "…skips a mismatched key". Restore.
3. Move `attempted++` below the `try` success path only (inside `try` after `await`) → red: "a failing POST is best-effort: counted…". Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/gpu/endpoint-eviction.ts server/src/gpu/endpoint-eviction.test.ts
git commit -m "feat(server): unload analyzer endpoints that share a card with TTS"
```

---

### Task 3d.3: Wire endpoint eviction into `withCapacityRetry` and `SidecarTtsProvider`

**Files:**
- Modify: `server/src/gpu/capacity-retry.ts:109-160` (options), `:233-243` (defaults), `:278-282` (eviction block), `:295-300`, `:323-330`, `:363-368` (give-up sites)
- Modify: `server/src/tts/tts-errors.ts:15-36` (`NoCapacityError` gains `notes`)
- Modify: `server/src/tts/sidecar.ts:147-171` (option), `:173-184` (field), `:186-197` (ctor), `:428-438` (pass-through)
- Test: `server/src/gpu/capacity-retry.test.ts` (new `describe`), `server/src/tts/tts-errors.test.ts` (extend), `server/src/tts/sidecar.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3d.1 `isAnyAnalyzerCallInFlight`, `registerEndpointCallInFlight`; Task 3d.2 `evictEndpointsOnDevice`, `endpointUnloadNotes`.
- Produces: `CapacityRetryOpts.evictEndpoints?: (deviceKey: string) => Promise<{ attempted: number }>` and `endpointUnloadNotes?: (deviceKey: string) => string[]`; `SidecarOptions.evictEndpoints?`; `new NoCapacityError(engine, neededMb, deviceKey, blockers?, notes?)`.

New block semantics (replacing `:278-282`):
- Ollama-only path unchanged: when no endpoint unload is attempted, `wouldHelp → evictOllama → latch → immediate retry` exactly as today.
- Shared latch and gate: endpoint unloads happen only on the first denial while `!isAnalysisInFlight()`, and set the same `evicted` latch.
- Not gated on `analyzerEvictWouldHelp`.
- After ≥1 unload POST the loop re-probes the card: enough free VRAM → retry at once; otherwise fall through to the idle-TTS lever and the poll wait (no immediate retry into the same denial).
- Give-up messages append `endpointUnloadNotes(deviceKey)` (the Unload URL setting is named when a sharing endpoint has none).

Keeps green: every existing case in `capacity-retry.test.ts` (a)–(f) and the design-budget suite, `sidecar.test.ts` (b)/(c), `tts-errors.test.ts`, `describe-vram-blockers.test.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/gpu/capacity-retry.test.ts` (it already defines `noCapacityResponse`, `okResponse`, `fakeDevices`):

```ts
import { registerEndpointCallInFlight } from '../analyzer/analyzer-concurrency.js';

describe('withCapacityRetry — analyzer endpoint eviction (#3084)', () => {
  it('no unload POST while an endpoint call is in flight (default gate)', async () => {
    const release = registerEndpointCallInFlight();
    try {
      let calls = 0;
      const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
      const evictEndpoints = vi.fn(async () => ({ attempted: 1 }));
      await withCapacityRetry(doPost, {
        engine: 'qwen',
        capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
        evictOllama: vi.fn(async () => {}),
        analyzerEvictWouldHelp: vi.fn(async () => true),
        evictEndpoints,
        pollMs: 1,
        maxAttempts: 5,
      });
      expect(evictEndpoints).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('unloads endpoints for the denied card even when evicting Ollama would not help', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:1') : okResponse()));
    const evictEndpoints = vi.fn(async () => ({ attempted: 1 }));
    const evictOllama = vi.fn(async () => {});
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:1', 500) },
      evictOllama,
      analyzerEvictWouldHelp: vi.fn(async () => false),
      isAnalysisInFlight: () => false,
      evictEndpoints,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(evictEndpoints).toHaveBeenCalledWith('cuda:1');
    expect(evictOllama).not.toHaveBeenCalled();
  });

  it('endpoint and Ollama eviction share the once-per-call latch', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls <= 2 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    const evictEndpoints = vi.fn(async () => ({ attempted: 1 }));
    const evictOllama = vi.fn(async () => {});
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight: () => false,
      evictEndpoints,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(evictEndpoints).toHaveBeenCalledTimes(1);
    expect(evictOllama).toHaveBeenCalledTimes(1);
  });

  it('re-probes capacity after an unload: enough free VRAM → immediate retry, no poll wait', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    let probes = 0;
    const read = vi.fn(async () => fakeDevices('cuda:0', ++probes === 1 ? 500 : 3_000));
    const started = Date.now();
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => false),
      isAnalysisInFlight: () => false,
      evictEndpoints: vi.fn(async () => ({ attempted: 1 })),
      evictIdleTts: vi.fn(async () => false),
      pollMs: 5_000,
      maxAttempts: 5,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('re-probes capacity after an unload: still short → takes the poll wait instead of retrying at once', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    const evictIdleTts = vi.fn(async () => false);
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => false),
      isAnalysisInFlight: () => false,
      evictEndpoints: vi.fn(async () => ({ attempted: 1 })),
      evictIdleTts,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(evictIdleTts).toHaveBeenCalledTimes(1);
    expect(doPost).toHaveBeenCalledTimes(2);
  });

  it('no endpoint attempted → Ollama path exactly as before (immediate retry after evictOllama)', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    const read = vi.fn(async () => fakeDevices('cuda:0', 500));
    const evictIdleTts = vi.fn(async () => false);
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight: () => false,
      evictEndpoints: vi.fn(async () => ({ attempted: 0 })),
      evictIdleTts,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(evictIdleTts).not.toHaveBeenCalled();
  });

  it('the give-up message names the Unload URL setting for a sharing endpoint without one', async () => {
    const doPost = vi.fn(async () => noCapacityResponse(2_000, 'cuda:0'));
    const err = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => false),
      isAnalysisInFlight: () => false,
      evictEndpoints: vi.fn(async () => ({ attempted: 0 })),
      endpointUnloadNotes: () => ['Analyzer endpoint "Lab" shares this card but has no Unload URL — set "Unload URL".'],
      describeBlockers: async () => [],
      isDesignResident: async () => false,
      pollMs: 1,
      maxAttempts: 2,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoCapacityError);
    expect((err as Error).message).toContain('Unload URL');
  });
});
```

Append to `server/src/tts/tts-errors.test.ts`:

```ts
describe('NoCapacityError notes (#3084)', () => {
  it('appends notes after the blocker text', () => {
    const err = new NoCapacityError('qwen', 3000, 'cuda:0', [], ['Analyzer endpoint "Lab" has no Unload URL.']);
    expect(err.message).toBe('Not enough GPU memory for qwen (3000MB) — free VRAM or attach a second GPU. Analyzer endpoint "Lab" has no Unload URL.');
  });
  it('without notes the message is unchanged', () => {
    expect(new NoCapacityError('qwen', 3000, 'cuda:0').message).toBe('Not enough GPU memory for qwen (3000MB) — free VRAM or attach a second GPU.');
  });
});
```

(Add `import { NoCapacityError } from './tts-errors.js';` if the file does not already import it.)

Append to `server/src/tts/sidecar.test.ts`, beside case (b) (it already defines `stubFetch`, `noCapacityResponse`, `okResponse`, `fakeDevices`, `SYNTH_INPUT`):

```ts
  it('#3084 — passes the injected evictEndpoints through to the capacity loop', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });
    const evictEndpoints = vi.fn(async () => ({ attempted: 0 }));
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight: () => false,
      evictEndpoints,
      capacityPollMs: 1,
      maxCapacityAttempts: 5,
    });
    await provider.synthesize(SYNTH_INPUT);
    expect(evictEndpoints).toHaveBeenCalledWith('cuda:0');
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/gpu/capacity-retry.test.ts src/tts/tts-errors.test.ts src/tts/sidecar.test.ts`
Expected: FAIL — `evictEndpoints` never called; message lacks `Unload URL`; `NoCapacityError` message ignores notes.

- [ ] **Step 3: Implement**

`server/src/tts/tts-errors.ts:21-35`:

```ts
  constructor(engine: TtsEngine, neededMb: number, deviceKey: string, blockers: VramBlocker[] = [], notes: string[] = []) {
    /* Name what is actually holding the memory (#1839). The generic "free VRAM"
       line is the fallback for when nothing user-controlled is resident — in
       that case the GPU is genuinely busy and there is no button to press.
       #3084: notes name analyzer endpoints Castwright could not unload. */
    const base = `Not enough GPU memory for ${engine} (${neededMb}MB)`;
    const main = blockers.length
      ? `${base}. ${blockers.map((b) => `${b.model} is loaded — ${b.remedy}`).join(' ')}`
      : `${base} — free VRAM or attach a second GPU.`;
    super(notes.length ? `${main} ${notes.join(' ')}` : main);
    this.name = 'NoCapacityError';
    this.engine = engine;
    this.neededMb = neededMb;
    this.deviceKey = deviceKey;
    this.blockers = blockers;
  }
```

`server/src/gpu/capacity-retry.ts`:
- import `import { evictEndpointsOnDevice, endpointUnloadNotes as defaultEndpointUnloadNotes } from './endpoint-eviction.js';`
- `CapacityRetryOpts`, after `isAnalysisInFlight?` (`:123`):

```ts
  /** #3084 — injected "unload analyzer endpoints on this card" action — defaults to
      evictEndpointsOnDevice. Shares the `evicted` latch and in-flight gate with Ollama;
      not gated on analyzerEvictWouldHelp (endpoints report no VRAM figure). */
  evictEndpoints?: (deviceKey: string) => Promise<{ attempted: number }>;
  /** #3084 — injected give-up notes naming sharing endpoints without an Unload URL. */
  endpointUnloadNotes?: (deviceKey: string) => string[];
```

- defaults, after `:237`:

```ts
  const evictEndpoints = opts.evictEndpoints ?? evictEndpointsOnDevice;
  const unloadNotes = opts.endpointUnloadNotes ?? ((deviceKey: string) => defaultEndpointUnloadNotes(deviceKey));
```

- replace `:278-282`:

```ts
      if (!evicted && !isAnalysisInFlight()) {
        const ollamaWouldHelp = await analyzerEvictWouldHelp(noCap.neededMb, freeMb);
        const { attempted } = await evictEndpoints(noCap.deviceKey);
        if (ollamaWouldHelp) await evictOllama();
        if (ollamaWouldHelp || attempted > 0) {
          evicted = true;
          if (attempted === 0) continue; // Ollama only: immediate retry, exactly as before
          /* An endpoint unload frees its card asynchronously from the sidecar's view:
             re-probe before retrying rather than retrying into the same denial. */
          const after = await capacityProbe.read({ fresh: true });
          const freeAfter =
            after.find((d) => d.kind !== 'cpu' && `${d.kind}:${d.index}` === noCap.deviceKey)?.freeMb ?? 0;
          if (freeAfter >= noCap.neededMb) continue;
        }
      }
```

- the three `new NoCapacityError(` sites (`:295-300`, `:323-330`, `:363-368`) gain a fifth argument: `unloadNotes(noCap.deviceKey)` at the first two and `unloadNotes(lastNoCap.deviceKey)` at the catch site.

`server/src/tts/sidecar.ts`:
- `SidecarOptions`, after `isAnalysisInFlight?` (`:164`): `/** #3084 — injected endpoint-unload action — for testing only. Defaults to evictEndpointsOnDevice (via withCapacityRetry). */ evictEndpoints?: (deviceKey: string) => Promise<{ attempted: number }>;`
- field after `:180`: `private readonly evictEndpoints: ((deviceKey: string) => Promise<{ attempted: number }>) | undefined;`
- ctor after `:194`: `this.evictEndpoints = opts.evictEndpoints;`
- pass-through after `isAnalysisInFlight: this.isAnalysisInFlight,` (`:434`): `evictEndpoints: this.evictEndpoints,`

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/gpu/capacity-retry.test.ts src/tts/tts-errors.test.ts src/tts/sidecar.test.ts src/gpu/describe-vram-blockers.test.ts src/gpu/endpoint-eviction.test.ts` then `npm run check:cycles`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. Wrap the endpoint call as `const { attempted } = ollamaWouldHelp ? await evictEndpoints(noCap.deviceKey) : { attempted: 0 };` → red: "unloads endpoints for the denied card even when evicting Ollama would not help". Restore.
2. Replace `if (freeAfter >= noCap.neededMb) continue;` with `continue;` → red: "…still short → takes the poll wait…". Restore.
3. Delete `evicted = true;` → red: "endpoint and Ollama eviction share the once-per-call latch". Restore.
4. Remove the fifth argument at the `:323-330` site → red: "the give-up message names the Unload URL setting…". Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/gpu/capacity-retry.ts server/src/gpu/capacity-retry.test.ts server/src/tts/tts-errors.ts server/src/tts/tts-errors.test.ts server/src/tts/sidecar.ts server/src/tts/sidecar.test.ts
git commit -m "feat(server): evict same-card analyzer endpoints before failing TTS admission"
```

---
### Task 3d.4: Selection builds `OpenAIAnalyzer`; fallback reason; the persisted enums accept `openai`

**Files:**
- Modify: `server/src/analyzer/index.ts` — replace 3a's refusing `if (engine === 'openai') { throw … }` branch (inserted before `:206`); the three `call.onFallback?.({ reason: 'Ollama unreachable' })` sites (`:289`, `:308`, `:343`)
- Modify: `server/src/workspace/user-settings.ts:98` (`ANALYSIS_ENGINE_VALUES`), `getResolvedAnalysisEngine` body (3a's version of `:781-783`)
- Modify: `server/src/config/registry.ts:1121-1129` (`analyzer.engine` `options`)
- Modify: `openapi.yaml:4628`, `:4831` (`analysisEngine` enums) + regenerate `src/lib/api-types.ts`
- Modify: `src/components/model-settings-form.tsx:112`, `:490-503` (engine select); `src/components/setup/step-defaults.tsx` (3a's `if (engine === 'openai') return;` narrowing in `handleAnalysisModelChange`)
- Test: 3a's `server/src/analyzer/select-analyzer-endpoint-id.test.ts` (the refusal case becomes the selection cases), `server/src/routes/user-settings.test.ts` (3a's "refuses analysisEngine "openai"…" case flips), Create `server/src/analyzer/fallback.endpoint-reason.test.ts`

**Interfaces:**
- Consumes: `OpenAIAnalyzer` (`server/src/analyzer/openai.ts`, 3b Task 3b.12); `resolveEndpointApiKey(state, endpoint, targetUrl)` (3b Task 3b.5); `AnalyzerEndpointMissingError`, `AnalyzerUnreachableError` (3b/W1); `parseEndpointModelId` (3a).
- Produces: `selectAnalyzer({ model: 'openai:<id>::<model>' })` → `{ analyzer: OpenAIAnalyzer | FallbackAnalyzer(OpenAIAnalyzer, GeminiAnalyzer), engine: 'openai', model: <full id>, fallbackModel }`; `selectAnalyzer({})` with a saved `analysisEngine: 'openai'` uses `defaultAnalysisModel`; `fallbackReasonFor(err)`.

`AnalyzerSelection.model` stays the **full** `openai:<id>::<model>` id so SSE `model` fields, labels and snapshots can resolve the endpoint; `OpenAIAnalyzer` receives the bare model. The fallback wrap is exactly the `local` rule (`index.ts:216-225`): key present and `allowCloudFallback` on. The announced reason stays `'Ollama unreachable'` for Ollama (existing tests and UI copy) and is `'Analyzer endpoint unreachable'` for an endpoint; `FallbackAnalyzer` never names a transport it did not run.

Keeps green: `select-analyzer.test.ts`, `fallback.test.ts`, `fallback-analyzer.test.ts`, `analysis.phase-model.test.ts`, `workspace/user-settings.test.ts`, `routes/user-settings.test.ts`, `src/components/model-settings-form.test.tsx`, `src/components/setup/step-defaults*.test.tsx`.

- [ ] **Step 1: Write the failing tests**

In 3a's `server/src/analyzer/select-analyzer-endpoint-id.test.ts`, delete the case `refuses an openai:<endpoint>::<model> id instead of handing it to Ollama` and add:

```ts
import { selectAnalyzer, FallbackAnalyzer } from './index.js';
import { selectAnalyzerForPhase } from './select-analyzer.js';
import { OpenAIAnalyzer } from './openai.js';
import { AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from './errors.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 });

describe('selectAnalyzer — OpenAI-compatible endpoints (#3084 PR 3d)', () => {
  afterEach(() => {
    _resetUserSettingsCache();
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANALYZER_PHASE1_MODEL;
  });

  it('an endpoint id builds OpenAIAnalyzer and keeps the full id as the model', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, allowCloudFallback: true });
    const s = selectAnalyzer({ model: 'openai:lab::qwen3-30b' });
    expect(s.engine).toBe('openai');
    expect(s.analyzer).toBeInstanceOf(OpenAIAnalyzer);
    expect(s.model).toBe('openai:lab::qwen3-30b');
    expect(s.fallbackModel).toBeNull();
  });

  it('with a Gemini key and cloud fallback on, wraps the endpoint in FallbackAnalyzer', () => {
    process.env.GEMINI_API_KEY = 'k';
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, allowCloudFallback: true });
    const s = selectAnalyzer({ model: 'openai:lab::qwen3-30b' });
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    expect(s.fallbackModel).not.toBeNull();
  });

  it('cloud fallback off → bare OpenAIAnalyzer even with a key', () => {
    process.env.GEMINI_API_KEY = 'k';
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, allowCloudFallback: false });
    expect(selectAnalyzer({ model: 'openai:lab::m' }).analyzer).toBeInstanceOf(OpenAIAnalyzer);
  });

  it('a saved openai engine uses defaultAnalysisModel', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, analysisEngine: 'openai', defaultAnalysisModel: 'openai:lab::m' });
    expect(selectAnalyzer({}).model).toBe('openai:lab::m');
  });

  it('a missing endpoint and a key bound to another host throw typed errors', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerEndpointKeys: {} });
    expect(() => selectAnalyzer({ model: 'openai:lab::m' })).toThrow(AnalyzerEndpointMissingError);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'k' } } });
    expect(() => selectAnalyzer({ model: 'openai:lab::m' })).toThrow(AnalyzerKeyOriginError);
  });

  it('an env phase model on an endpoint is selectable', () => {
    process.env.ANALYZER_PHASE1_MODEL = 'openai:lab::m';
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
    expect(selectAnalyzerForPhase({ phase: 'phase1' }).engine).toBe('openai');
  });
});
```

(Keep the file's existing `describe/it/expect/afterEach` import from `vitest`.)

In `server/src/routes/user-settings.test.ts`, replace 3a's `refuses analysisEngine "openai" until endpoints are selectable (#3084 PR 3a)` with:

```ts
  it('accepts analysisEngine "openai" now that endpoints are selectable (#3084 PR 3d)', async () => {
    const res = await request(app).put('/api/user/settings').send({ analysisEngine: 'openai' });
    expect(res.status).toBe(200);
    expect(res.body.analysisEngine).toBe('openai');
  });
```

Create `server/src/analyzer/fallback.endpoint-reason.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer } from './index.js';
import type { Analyzer, StageCall } from './types.js'; // analyzer types come from the W1 leaf, never index.ts
import { AnalyzerUnreachableError, LocalUnreachableError } from './errors.js';

function analyzer(runStage1Chapter: Analyzer['runStage1Chapter']): Analyzer {
  const unused = () => Promise.reject(new Error('unused'));
  return {
    runStage1: unused,
    runStage1Chapter,
    runStage2Chapter: unused,
    runEmotionChapter: unused,
    runScriptReviewChapter: unused,
    runStage3Chapter: unused,
    runAttributionEscalation: unused,
  } as Analyzer;
}

describe('FallbackAnalyzer reason text (#3084)', () => {
  it('announces an unreachable endpoint generically, then falls back', async () => {
    const primary = analyzer(() => Promise.reject(new AnalyzerUnreachableError('connect ECONNREFUSED', 'openai')));
    const fallback = analyzer(() => Promise.resolve({ characters: [] }));
    const onFallback = vi.fn();
    await new FallbackAnalyzer(primary, fallback).runStage1Chapter('m', 1, 'p', { onFallback } as unknown as StageCall);
    expect(onFallback).toHaveBeenCalledWith({ reason: 'Analyzer endpoint unreachable' });
  });

  it('keeps "Ollama unreachable" for Ollama', async () => {
    const primary = analyzer(() => Promise.reject(new LocalUnreachableError('down')));
    const fallback = analyzer(() => Promise.resolve({ characters: [] }));
    const onFallback = vi.fn();
    await new FallbackAnalyzer(primary, fallback).runStage1Chapter('m', 1, 'p', { onFallback } as unknown as StageCall);
    expect(onFallback).toHaveBeenCalledWith({ reason: 'Ollama unreachable' });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/select-analyzer-endpoint-id.test.ts src/analyzer/fallback.endpoint-reason.test.ts src/routes/user-settings.test.ts`
Expected: FAIL — `selectAnalyzer` throws 3a's "cannot run yet" error; reason is `'Ollama unreachable'` for the endpoint; the PUT returns 400.

- [ ] **Step 3: Implement**

`server/src/analyzer/index.ts` — imports: `import { OpenAIAnalyzer } from './openai.js';`, `import { resolveEndpointApiKey } from '../workspace/analyzer-endpoints.js';`, `import { parseEndpointModelId } from './model-id.js';` (merge with 3a's model-id import), `getCachedUserSettings` added to the existing user-settings import, `AnalyzerEndpointMissingError` and `AnalyzerUnreachableError` from `./errors.js`. Replace 3a's refusing branch with:

```ts
  if (engine === 'openai') {
    const settings = getCachedUserSettings();
    const modelId = opts.model ?? settings.defaultAnalysisModel;
    const parsed = parseEndpointModelId(modelId);
    const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
    if (!parsed || !endpoint) throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? modelId, 'settings');
    const primary = new OpenAIAnalyzer({ endpoint, apiKey: resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl), model: parsed.model });
    /* Same gate as the local branch: fall back to Gemini only on AnalyzerUnreachableError,
       only with a key and cloud fallback on (spec decision 4). */
    if (apiKey && getResolvedAllowCloudFallback()) {
      const fallbackModel = configValue<string>('analyzer.gemini.model');
      return {
        analyzer: new FallbackAnalyzer(primary, new GeminiAnalyzer({ apiKey, model: fallbackModel })),
        engine: 'openai',
        model: modelId,
        fallbackModel,
      };
    }
    return { analyzer: primary, engine: 'openai', model: modelId, fallbackModel: null };
  }
```

After the `FallbackAnalyzer` class opening (`:257`), add a module-level helper above the class:

```ts
/* The announced switch reason names only what actually failed. */
function fallbackReasonFor(err: AnalyzerUnreachableError): string {
  return err.transport === 'openai' ? 'Analyzer endpoint unreachable' : 'Ollama unreachable';
}
```

and change the three `call.onFallback?.({ reason: 'Ollama unreachable' });` lines (`:289`, `:308`, `:343`) to `call.onFallback?.({ reason: fallbackReasonFor(err) });` (inside each `if (err instanceof AnalyzerUnreachableError)` block W1 left).

`server/src/workspace/user-settings.ts:98`: `export const ANALYSIS_ENGINE_VALUES = ['local', 'gemini', 'openai'] as const;`. `getResolvedAnalysisEngine` body (3a's):

```ts
export function getResolvedAnalysisEngine(): AnalysisEngine {
  return getCachedUserSettings().analysisEngine;
}
```

and delete 3a's trailing "#3084 PR 3a: …cannot yield 'openai' until PR 3d widens that enum." sentence from its doc comment (now false).

`server/src/config/registry.ts:1121-1129` (`analyzer.engine`): `options: ['local', 'gemini', 'openai'],`.

`openapi.yaml:4628` and `:4831`: `enum: [local, gemini, openai]`; run `npm run openapi:types`.

`src/components/model-settings-form.tsx:112`: `const [analysisEngine, setAnalysisEngine] = useState<AnalysisEngine>(account.analysisEngine);` (import `type AnalysisEngine` from `../lib/model-id`). `:498`: `onChange={(e) => setAnalysisEngine(e.target.value as AnalysisEngine)}`. After `:502` add:

```tsx
            <option value="openai">OpenAI-compatible endpoint (uses the default analysis model's endpoint)</option>
```

`src/components/setup/step-defaults.tsx` — delete 3a's comment and `if (engine === 'openai') return;` from `handleAnalysisModelChange` (the saved enum now accepts it).

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/select-analyzer-endpoint-id.test.ts src/analyzer/select-analyzer.test.ts src/analyzer/fallback.endpoint-reason.test.ts src/analyzer/fallback.test.ts src/analyzer/fallback-analyzer.test.ts src/routes/user-settings.test.ts src/workspace/user-settings.test.ts src/config/registry.test.ts`, `npx vitest run src/components/model-settings-form.test.tsx src/components/setup`, `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. Replace `resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl)` with `settings.analyzerEndpointKeys[endpoint.id]?.key ?? null` → red: "a missing endpoint and a key bound to another host throw typed errors". Restore.
2. Drop the `if (apiKey && getResolvedAllowCloudFallback())` wrap → red: "with a Gemini key and cloud fallback on, wraps the endpoint…". Restore.
3. `fallbackReasonFor`: return `'Ollama unreachable'` always → red: "announces an unreachable endpoint generically…". Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/index.ts server/src/analyzer/select-analyzer-endpoint-id.test.ts server/src/analyzer/fallback.endpoint-reason.test.ts server/src/workspace/user-settings.ts server/src/routes/user-settings.test.ts server/src/config/registry.ts openapi.yaml src/lib/api-types.ts src/components/model-settings-form.tsx src/components/setup/step-defaults.tsx
git commit -m "feat(server,frontend): select OpenAI-compatible endpoints for analysis"
```

---

### Task 3d.5: Route engine branches — label, ETA seed, readiness gates

**Files:**
- Modify: `server/src/routes/analysis.ts` — 3a's `engineLabel` (replacing `:557-563`), `engineFallbackMsPerChar` (`:1214-1219`) and its callers (`:4029`, `:4289`)
- Modify: `server/src/routes/setup-diagnosis.ts:308-319` (input), `:321-331` (openai branch); `server/src/routes/setup-readiness.ts:40-52` (`BlockerCause`), `:150-165` (diagnosis input), `:203-211` (smoke check)
- Modify: `openapi.yaml:8346-8351` (`BlockerCause` enum) + regenerate `src/lib/api-types.ts`
- Test: 3a's `server/src/routes/analysis-engine-label.test.ts` (update), `server/src/routes/setup-diagnosis.test.ts` (extend)

**Interfaces:**
- Consumes: `parseEndpointModelId` (3a); `getCachedUserSettings`; `AnalyzerEndpoint`.
- Produces: `engineLabel(engine, modelId)` names the endpoint; `engineFallbackMsPerChar(engine, device, endpointGpu?)`; `AnalyzerDiagnosisInput.defaultEndpointConfigured: boolean`; `BlockerCause` `'endpoint-missing'`.

Classification of every engine-branch site the spec lists (`03-code-map.md` §1), with the change 3d makes (the full 60-row inventory is 3a's table; only rows marked "PR 3d" are acted on here):

| Site | Classification | Change in 3d |
|---|---|---|
| `routes/analysis.ts:561` `engineLabel` | label | endpoint → `<saved endpoint name> (<model>)`; endpoint id when the name is unknown |
| `routes/analysis.ts:1218` `engineFallbackMsPerChar` | shares GPU (local ETA seed) | endpoint with `gpu !== 'none'` gets the local rate for the detected device; `gpu: 'none'` keeps the cloud rate |
| `routes/analysis.ts:3203` run-end `unloadResidentOllama` | Ollama-specific | unchanged — endpoints unload only through capacity eviction (Task 3d.3) |
| `routes/analysis.ts:3625` `usesLocalAnalyzer` → `detectOllamaDevice` | Ollama-specific | unchanged — it probes Ollama's device; an endpoint run seeds with `'unknown'` → CUDA rate |
| `routes/analysis.ts:2182` `buildCloudEscalationAnalyzer` | Gemini-specific | unchanged (stays Gemini) |
| `routes/script-review.ts:724` warm Ollama | Ollama-specific | unchanged |
| `routes/script-review.ts:780` `pinnedLocal` keep-alive pin | Ollama-specific | unchanged |
| `routes/diagnostics.ts:259`, `:299` | Ollama- / Gemini-specific rows | unchanged — an endpoint engine reads "not in use (engine: openai)" |
| `routes/setup-diagnosis.ts:323` `diagnoseAnalyzer` | persisted-engine readiness gate | new `openai` branch: pass when the default model's endpoint is saved, else fail `endpoint-missing` (today it would demand Ollama) |
| `routes/setup-readiness.ts:204` smoke analyzer check | persisted-engine readiness gate | `openai` → `analyzerOk` = the default model's endpoint is saved |
| `routes/annotate-emotion.ts:147`, `instruct-annotation.ts:146`, `script-review.ts:695` | construction via `selectAnalyzerForPhase` | inherit Task 3d.4 |

Keeps green: `analysis.test.ts` (ETA tests), `setup-diagnosis.test.ts`, `setup-readiness.test.ts`, `setup-readiness.route.test.ts` (slow lane), `setup-readiness.orchestration.test.ts`, `src/components/setup/*` (readiness copy).

- [ ] **Step 1: Write the failing tests**

In `server/src/routes/analysis-engine-label.test.ts` (3a), replace both describes with:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { engineLabel, engineFallbackMsPerChar } from './analysis.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

afterEach(() => _resetUserSettingsCache());

describe('engineLabel (#3084 PR 3d)', () => {
  it('labels an endpoint by its saved name and model', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab server', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 8192 })],
    });
    expect(engineLabel('openai', 'openai:lab::qwen3:30b')).toBe('Lab server (qwen3:30b)');
  });
  it('falls back to the endpoint id when the endpoint is not saved', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    expect(engineLabel('openai', 'openai:lab::qwen3:30b')).toBe('Endpoint lab (qwen3:30b)');
  });
  it('keeps the Ollama and Gemini labels', () => {
    expect(engineLabel('local', 'qwen3.5:4b')).toBe('Ollama (qwen3.5:4b)');
    expect(engineLabel('gemini', 'no-such-model-id')).toBe('no-such-model-id');
  });
});

describe('engineFallbackMsPerChar (#3084 PR 3d)', () => {
  it('an endpoint on a GPU seeds with the local rate; gpu none with the cloud rate', () => {
    expect(engineFallbackMsPerChar('openai', 'cuda', 'cuda:1')).toBe(engineFallbackMsPerChar('local', 'cuda'));
    expect(engineFallbackMsPerChar('openai', 'cuda', 'any')).toBe(engineFallbackMsPerChar('local', 'cuda'));
    expect(engineFallbackMsPerChar('openai', 'cuda', 'none')).toBe(engineFallbackMsPerChar('gemini', 'cuda'));
  });
});
```

Append to `server/src/routes/setup-diagnosis.test.ts`, inside the `describe` that defines `ANALYZER_LOCAL_READY` usage (`:342-365` block):

```ts
  it('#3084 — openai engine passes when the default model names a saved endpoint, without needing Ollama', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, engine: 'openai', ollamaReachable: false, defaultEndpointConfigured: true });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });
  it('#3084 — openai engine fails endpoint-missing with a Model Manager action otherwise', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, engine: 'openai', defaultEndpointConfigured: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'endpoint-missing' });
    expect(r.action).toMatchObject({ kind: 'navigate', href: '#/models' });
  });
```

(Add `defaultEndpointConfigured: false,` to the `ANALYZER_LOCAL_READY` fixture object so the type stays complete.)

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/routes/analysis-engine-label.test.ts src/routes/setup-diagnosis.test.ts`
Expected: FAIL — label reads `Endpoint lab (qwen3:30b)`; the GPU endpoint gets the Gemini rate; `openai` diagnosis fails `ollama-unreachable`.

- [ ] **Step 3: Implement**

`server/src/routes/analysis.ts` — replace 3a's `engineLabel`:

```ts
/** Engine-aware label so SSE chunks read "Ollama (qwen3.5:9b)" for the local analyzer,
    "Gemma 4 31B" for Gemini, and "<endpoint name> (qwen3:30b)" for an OpenAI-compatible
    endpoint (#3084). The MODEL_LABELS lookup only covers Gemini ids. */
export function engineLabel(engine: AnalysisEngine, modelId: string): string {
  if (engine === 'openai') {
    const parsed = parseEndpointModelId(modelId);
    if (!parsed) return `Endpoint (${modelId})`;
    const name = getCachedUserSettings().analyzerEndpoints.find((e) => e.id === parsed.endpointId)?.name;
    return name ? `${name} (${parsed.model})` : `Endpoint ${parsed.endpointId} (${parsed.model})`;
  }
  return engine === 'local' ? `Ollama (${modelId})` : humanModel(modelId);
}
```

`:1214-1219`:

```ts
export function engineFallbackMsPerChar(
  engine: AnalysisEngine,
  device: 'cuda' | 'cpu' | 'unknown',
  endpointGpu?: string,
): number {
  if (engine === 'local') return localFallbackMsPerChar(device);
  if (engine === 'openai' && endpointGpu !== undefined && endpointGpu !== 'none') return localFallbackMsPerChar(device);
  return GEMINI_FALLBACK_MS_PER_CHAR;
}

/** The saved endpoint's gpu for an endpoint model id (#3084); undefined otherwise. */
function endpointGpuFor(modelId: string): string | undefined {
  const parsed = parseEndpointModelId(modelId);
  return parsed ? getCachedUserSettings().analyzerEndpoints.find((e) => e.id === parsed.endpointId)?.gpu : undefined;
}
```

`:4029`: `const fallbackMsPerChar = engineFallbackMsPerChar(selection.engine, analyzerDevice, endpointGpuFor(selection.model));`
`:4289`: `const msPerCharFallback = engineFallbackMsPerChar(selection.engine, analyzerDevice, endpointGpuFor(selection.model));`

`server/src/routes/setup-readiness.ts:50` (`// analyzer` line of `BlockerCause`): `| 'ollama-unreachable' | 'model-not-pulled' | 'no-gemini-key' | 'endpoint-missing'`.
`openapi.yaml:8350-8351`: append `endpoint-missing` before `pass` in the `BlockerCause` enum; run `npm run openapi:types`; `npm run typecheck` reports any frontend `Record<BlockerCause, …>` map that needs the key — add a `endpoint-missing` entry with the copy "Analyzer endpoint not configured" there.

`server/src/routes/setup-diagnosis.ts` — `AnalyzerDiagnosisInput` (`:308-319`) gains:

```ts
  /** #3084 — engine 'openai': the default analysis model names a saved endpoint. */
  defaultEndpointConfigured: boolean;
```

and `diagnoseAnalyzer` (`:321`) opens with:

```ts
  if (input.engine === 'openai') {
    return input.defaultEndpointConfigured
      ? diagnosis('pass', 'pass', 'The analyzer uses an OpenAI-compatible endpoint.', '')
      : diagnosis(
          'fail', 'endpoint-missing',
          'The default analysis model points at an analyzer endpoint that is not configured.',
          'Add the endpoint in Model Manager → Analyzer endpoints, or pick another default analysis model.',
          { kind: 'navigate', label: 'Open Model Manager', href: '#/models' },
        );
  }
```

`server/src/routes/setup-readiness.ts` — add `getCachedUserSettings` to the user-settings import (`:8-14`) and `import { parseEndpointModelId } from '../analyzer/model-id.js';`. Above the handler that calls `diagnoseAnalyzer`:

```ts
function defaultEndpointConfigured(): boolean {
  const settings = getCachedUserSettings();
  const parsed = parseEndpointModelId(settings.defaultAnalysisModel);
  return parsed !== null && settings.analyzerEndpoints.some((e) => e.id === parsed.endpointId);
}
```

`:156-165` input gains `defaultEndpointConfigured: defaultEndpointConfigured(),`. `:204-211` becomes:

```ts
    const engine = getResolvedAnalysisEngine();
    if (engine === 'gemini') {
      analyzerOk = getResolvedGeminiApiKey() != null;
      analyzerDetail = analyzerOk ? 'API key set' : 'no key';
    } else if (engine === 'openai') {
      analyzerOk = defaultEndpointConfigured();
      analyzerDetail = analyzerOk ? 'endpoint configured' : 'endpoint not configured';
    } else {
      const o = await probeOllamaHealth();
      analyzerOk = o.status === 'reachable';
      analyzerDetail = o.error ?? (o.modelPulled ? 'model pulled' : 'reachable');
    }
```

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/routes/analysis-engine-label.test.ts src/routes/setup-diagnosis.test.ts src/routes/setup-readiness.test.ts src/routes/setup-readiness.orchestration.test.ts`, `npm --prefix server run test:slow -- src/routes/setup-readiness.route.test.ts`, `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `engineFallbackMsPerChar`: delete the `openai` line → red: "an endpoint on a GPU seeds with the local rate…". Restore.
2. `diagnoseAnalyzer`: delete the `openai` branch → red: "#3084 — openai engine passes when the default model names a saved endpoint…". Restore.
3. `engineLabel`: return the id form unconditionally → red: "labels an endpoint by its saved name and model". Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/analysis.ts server/src/routes/analysis-engine-label.test.ts server/src/routes/setup-diagnosis.ts server/src/routes/setup-diagnosis.test.ts server/src/routes/setup-readiness.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): endpoint-aware analysis labels, ETA seed and readiness"
```

---
### Task 3d.6: Frontend card comparison — forward guard, reverse guard, generation hold, `activeStream.gpu`

**Files:**
- Create: `src/lib/analyzer-endpoints.ts`
- Modify: `src/store/analysis-slice.ts:26-33` (`gpu?` on the snapshot)
- Modify: `src/hooks/use-local-analyzer-guard.tsx` (the Task 3c.8 gate), `src/hooks/use-reverse-local-analyzer-guard.tsx:71-84`
- Modify: `src/store/generation-stream-middleware.ts:44-51` (root state type), `:97-106` (hold)
- Modify: `src/views/analysing.tsx:340-344` (engine + gpu), `:448`, `:804`, `:935` (dispatch payloads); `src/views/generation.tsx:288` (selector), `:422-428`, `:591-597`
- Test: Create `src/lib/analyzer-endpoints.test.ts`; extend `src/hooks/use-local-analyzer-guard.test.tsx`, `src/hooks/use-reverse-local-analyzer-guard.test.tsx`, `src/store/generation-stream-middleware.test.ts`

**Interfaces:**
- Consumes: `engineForModelId`, `parseEndpointModelId`, `AnalysisEngine` (3a `src/lib/model-id.ts`); `AnalyzerEndpoint` type (3b `src/lib/types.ts`); `engineForModelKey` (`src/lib/tts-models.ts:173`); `ConfigValues` / `KnobValue.effective` (`src/lib/types.ts:926-940`); `config` slice (`src/store/index.ts:208`).
- Produces (contract, with one type deviation): `defaultGpuForBaseUrl(baseUrl)`; `endpointForModelId(settings: Pick<UserSettings, 'analyzerEndpoints'>, id)` (the contract's `AccountSettings` type does not exist; `AccountState` and `UserSettings` are both assignable to this `Pick`); `analyzerSharesTtsDevice({ engine, endpointGpu, ttsDeviceKey })`; plus `ttsDeviceKeyFor(modelKey, values)`, `snapshotGpuFor(modelIds, settings)`, `AnalysisStreamSnapshot.gpu?: string`.

Rules (spec §4): Ollama shares as today; Gemini never; an endpoint shares when its `gpu` is `any` or equals the TTS target card; an endpoint id missing from settings counts as `any` (fail closed); `gpu: 'none'` never shares. **TTS target card:** the pinned `tts.<engine>.device` value (`cuda:N`) for the generation's TTS model key, read from the `config` slice; `auto`, `cpu`, an un-hydrated config slice or an unknown engine → unknown, and an unknown card counts as shared by any endpoint on a GPU (fail closed). The forward guard reads the active generation's `modelKey`; the reverse guard and the generation hold read the account's effective TTS model key (`resolvedTtsModelKey ?? defaultTtsModelKey`). **Snapshot `gpu`:** for a run with endpoint models, one distinct non-`none` card → that card; several → `any`; all `none` → `none`; no endpoint model → omitted. `layout.tsx:865`'s cold-boot rehydration has no model id in `AnalysisStateResponse` (`src/lib/types.ts:591-611`), so it stays without `gpu`, and an `openai` snapshot without `gpu` is treated as `any` — the reverse guard prompts rather than guesses.

Keeps green: the existing cases of all three guard/middleware test files; `src/views/analysing.test.tsx`; `src/views/generation*.test.tsx`; `src/components/layout*.test.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/analyzer-endpoints.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { defaultGpuForBaseUrl, endpointForModelId, analyzerSharesTtsDevice, ttsDeviceKeyFor, snapshotGpuFor } from './analyzer-endpoints';
import type { AnalyzerEndpoint, ConfigValues } from './types';

const ep = (id: string, gpu: string): AnalyzerEndpoint =>
  ({ id, name: id, baseUrl: 'http://127.0.0.1:8080/v1', gpu, concurrency: 1, requestCeilingMs: 1_800_000, structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 8192 }) as AnalyzerEndpoint;

const knob = (key: string, effective: string) => ({ key, effective, source: 'override' as const, locked: false, overridden: true });

describe('defaultGpuForBaseUrl (#3084)', () => {
  it.each([
    ['http://localhost:8080/v1', 'any'],
    ['http://127.0.0.1:8080/v1', 'any'],
    ['http://[::1]:8080/v1', 'any'],
    ['http://192.168.1.20:8080/v1', 'none'],
    ['https://openrouter.ai/api/v1', 'none'],
    ['not a url', 'none'],
  ])('%s → %s', (url, expected) => {
    expect(defaultGpuForBaseUrl(url)).toBe(expected);
  });
});

describe('analyzerSharesTtsDevice (#3084)', () => {
  it.each([
    ['local shares', { engine: 'local', endpointGpu: undefined, ttsDeviceKey: 'cuda:1' }, true],
    ['gemini never', { engine: 'gemini', endpointGpu: undefined, ttsDeviceKey: 'cuda:0' }, false],
    ['endpoint any', { engine: 'openai', endpointGpu: 'any', ttsDeviceKey: 'cuda:1' }, true],
    ['endpoint same card', { engine: 'openai', endpointGpu: 'cuda:0', ttsDeviceKey: 'cuda:0' }, true],
    ['endpoint other card', { engine: 'openai', endpointGpu: 'cuda:1', ttsDeviceKey: 'cuda:0' }, false],
    ['endpoint none', { engine: 'openai', endpointGpu: 'none', ttsDeviceKey: undefined }, false],
    ['endpoint missing from settings fails closed', { engine: 'openai', endpointGpu: undefined, ttsDeviceKey: 'cuda:0' }, true],
    ['TTS card unknown fails closed', { engine: 'openai', endpointGpu: 'cuda:1', ttsDeviceKey: undefined }, true],
  ] as const)('%s', (_n, input, expected) => {
    expect(analyzerSharesTtsDevice(input)).toBe(expected);
  });
});

describe('ttsDeviceKeyFor / endpointForModelId / snapshotGpuFor (#3084)', () => {
  const values: ConfigValues = { 'tts.kokoro.device': knob('tts.kokoro.device', 'cuda:1'), 'tts.qwen.device': knob('tts.qwen.device', 'auto') };
  it('reads a pinned cuda:N for the TTS engine, unknown otherwise', () => {
    expect(ttsDeviceKeyFor('kokoro-v1', values)).toBe('cuda:1');
    expect(ttsDeviceKeyFor('qwen3-tts-0.6b', values)).toBeUndefined();
    expect(ttsDeviceKeyFor('kokoro-v1', undefined)).toBeUndefined();
    expect(ttsDeviceKeyFor(undefined, values)).toBeUndefined();
  });
  it('finds the endpoint of an endpoint id only', () => {
    const settings = { analyzerEndpoints: [ep('lab', 'cuda:0')] };
    expect(endpointForModelId(settings, 'openai:lab::m')?.gpu).toBe('cuda:0');
    expect(endpointForModelId(settings, 'qwen3.5:4b')).toBeUndefined();
    expect(endpointForModelId(settings, 'openai:gone::m')).toBeUndefined();
  });
  it('collapses a run to one gpu tag', () => {
    const settings = { analyzerEndpoints: [ep('a', 'cuda:0'), ep('b', 'cuda:1'), ep('n', 'none')] };
    expect(snapshotGpuFor(['openai:a::m'], settings)).toBe('cuda:0');
    expect(snapshotGpuFor(['openai:a::m', 'openai:b::m'], settings)).toBe('any');
    expect(snapshotGpuFor(['openai:n::m', 'gemini-3.6-flash'], settings)).toBe('none');
    expect(snapshotGpuFor(['openai:gone::m'], settings)).toBe('any');
    expect(snapshotGpuFor(['qwen3.5:4b'], settings)).toBeUndefined();
  });
});
```

Append to `src/hooks/use-local-analyzer-guard.test.tsx` (the Task 3c.8 `Harness` takes `modelId`). Change `makeStore` to include `account: accountSlice.reducer` and `config: configSlice.reducer` and accept optional `endpoints` and `ttsDevice`:

```tsx
import { accountSlice } from '../store/account-slice';
import { configSlice, fetchConfig } from '../store/config-slice';

function makeStore(opts: { selectedModel: string; activeStream: ActiveStreamSnapshot | null; endpoints?: unknown[]; ttsDevice?: string }) {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer, chapters: chaptersSlice.reducer, library: librarySlice.reducer, account: accountSlice.reducer, config: configSlice.reducer },
  });
  store.dispatch(uiSlice.actions.setSelectedModel(opts.selectedModel));
  if (opts.activeStream) store.dispatch(chaptersSlice.actions.setActiveStream(opts.activeStream));
  if (opts.endpoints) store.dispatch({ type: 'account/fetch/fulfilled', payload: { analyzerEndpoints: opts.endpoints } });
  if (opts.ttsDevice) {
    store.dispatch(
      fetchConfig.fulfilled(
        { groups: [], descriptors: [], values: { 'tts.coqui.device': { key: 'tts.coqui.device', effective: opts.ttsDevice, source: 'override', locked: false, overridden: true } }, restartPending: false, cudaEnvShadow: false, envCleanupCandidates: [] },
        '',
        undefined,
      ),
    );
  }
  return store;
}
```

(`account/fetch/fulfilled` is `fetchAccountSettings.fulfilled`, `account-slice.ts:49,155-160`; its reducer `Object.assign`s the payload.) `liveSnapshot.modelKey` is `'coqui-xtts-v2'`, so the test pins `tts.coqui.device`. Replace 3c.8's fail-closed endpoint case with:

```tsx
  const lab = (gpu: string) => [{ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu, concurrency: 1, requestCeilingMs: 1_800_000, structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 8192 }];

  it('prompts for an endpoint on the TTS card', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: lab('cuda:0'), ttsDevice: 'cuda:0' });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
  });

  it('passes through for an endpoint on another card', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: lab('cuda:1'), ttsDevice: 'cuda:0' });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('passes through for an endpoint with gpu none', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: lab('none') });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an endpoint id missing from settings', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: [], ttsDevice: 'cuda:0' });
    render(<Provider store={store}><Harness onProceed={vi.fn()} modelId="openai:gone::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
  });
```

Append to `src/hooks/use-reverse-local-analyzer-guard.test.tsx` (add `account` and `config` reducers to its `makeStore`, `:22-27`):

```tsx
  const endpointSnapshot = (gpu?: string): AnalysisStreamSnapshot => ({ ...liveLocalSnapshot, engine: 'openai', ...(gpu ? { gpu } : {}) });

  it('#3084 — an endpoint run on gpu none never prompts', () => {
    const store = makeStore({ activeStream: endpointSnapshot('none') });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('#3084 — an endpoint run on a GPU prompts (TTS card unknown → fail closed)', () => {
    const store = makeStore({ activeStream: endpointSnapshot('cuda:1') });
    render(<Provider store={store}><Harness onProceed={vi.fn()} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
  });

  it('#3084 — a cold-boot endpoint snapshot without gpu prompts', () => {
    const store = makeStore({ activeStream: endpointSnapshot() });
    render(<Provider store={store}><Harness onProceed={vi.fn()} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
  });
```

Append to `src/store/generation-stream-middleware.test.ts`, beside the local/gemini hold cases (`:188-228`; its store already has `analysis` and `account`):

```ts
  it('#3084 — holds on explicit start while an endpoint analysis on a GPU is alive on the same book', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(analysisActions.setActiveStream({ bookId: 'b1', engine: 'openai', gpu: 'any', state: 'running', model: 'openai:lab::m', phase: 'phase1', done: 1, total: 5, lastTickAt: Date.now() } as never));
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('#3084 — enqueues when the endpoint analysis runs on gpu none', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(analysisActions.setActiveStream({ bookId: 'b1', engine: 'openai', gpu: 'none', state: 'running', model: 'openai:lab::m', phase: 'phase1', done: 1, total: 5, lastTickAt: Date.now() } as never));
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    expect(enqueueCalls().length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npx vitest run src/lib/analyzer-endpoints.test.ts src/hooks/use-local-analyzer-guard.test.tsx src/hooks/use-reverse-local-analyzer-guard.test.tsx src/store/generation-stream-middleware.test.ts`
Expected: FAIL — `Failed to resolve import "./analyzer-endpoints"`; the other-card and gpu-none endpoint cases prompt (3c fails every endpoint closed); the reverse guard and hold ignore `openai` snapshots.

- [ ] **Step 3: Implement**

Create `src/lib/analyzer-endpoints.ts`:

```ts
/* #3084 W3 — frontend view of analyzer endpoints for GPU coordination (spec §4): which
   saved endpoint a model id names, whether an analyzer run shares the TTS card, and the
   card tag captured on the analysis snapshot. Unknown always fails closed. */
import { engineForModelId, parseEndpointModelId, type AnalysisEngine } from './model-id';
import { engineForModelKey } from './tts-models';
import type { AnalyzerEndpoint, ConfigValues, TtsModelKey, UserSettings } from './types';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Mirror of the server's defaultGpuForBaseUrl: a loopback host shares every card. */
export function defaultGpuForBaseUrl(baseUrl: string): 'any' | 'none' {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase()) ? 'any' : 'none';
  } catch {
    return 'none';
  }
}

export function endpointForModelId(
  settings: Pick<UserSettings, 'analyzerEndpoints'>,
  id: string,
): AnalyzerEndpoint | undefined {
  const parsed = parseEndpointModelId(id);
  return parsed ? settings.analyzerEndpoints?.find((e) => e.id === parsed.endpointId) : undefined;
}

export function analyzerSharesTtsDevice(input: {
  engine: AnalysisEngine;
  endpointGpu: string | undefined;
  ttsDeviceKey: string | undefined;
}): boolean {
  if (input.engine === 'local') return true;
  if (input.engine === 'gemini') return false;
  const gpu = input.endpointGpu ?? 'any';
  if (gpu === 'none') return false;
  if (gpu === 'any' || input.ttsDeviceKey === undefined) return true;
  return gpu === input.ttsDeviceKey;
}

const DEVICE_KNOB: Partial<Record<ReturnType<typeof engineForModelKey>, string>> = {
  qwen: 'tts.qwen.device',
  kokoro: 'tts.kokoro.device',
  coqui: 'tts.coqui.device',
};

/** The card a TTS model is pinned to (`cuda:N`), or undefined when auto/cpu/unknown. */
export function ttsDeviceKeyFor(modelKey: TtsModelKey | undefined, values: ConfigValues | undefined): string | undefined {
  if (!modelKey || !values) return undefined;
  const knob = DEVICE_KNOB[engineForModelKey(modelKey)];
  const effective = knob ? values[knob]?.effective : undefined;
  return typeof effective === 'string' && /^cuda:\d+$/.test(effective) ? effective : undefined;
}

/** The gpu tag an analysis snapshot carries for the run's model ids. */
export function snapshotGpuFor(
  modelIds: readonly string[],
  settings: Pick<UserSettings, 'analyzerEndpoints'>,
): string | undefined {
  const gpus = modelIds
    .filter((id) => engineForModelId(id) === 'openai')
    .map((id) => endpointForModelId(settings, id)?.gpu ?? 'any');
  if (gpus.length === 0) return undefined;
  const sharing = [...new Set(gpus.filter((g) => g !== 'none'))];
  if (sharing.length === 0) return 'none';
  return sharing.length === 1 ? sharing[0] : 'any';
}
```

`src/store/analysis-slice.ts` — after `engine?` (`:33`):

```ts
  /** #3084 — card tag of the endpoint(s) the run uses ('none' | 'any' | 'cuda:N'),
      captured with `engine`. Absent for Ollama/Gemini runs and for cold-boot snapshots,
      where the reverse guard treats an openai run as 'any'. */
  gpu?: string;
```

`src/hooks/use-local-analyzer-guard.tsx` — add imports `import { analyzerSharesTtsDevice, endpointForModelId, ttsDeviceKeyFor } from '../lib/analyzer-endpoints';`; after the existing selectors add:

```tsx
  const analyzerEndpoints = useAppSelector((s) => s.account?.analyzerEndpoints);
  const configValues = useAppSelector((s) => s.config?.values);
  const generatingModelKey = useAppSelector((s) => Object.values(s.chapters.activeStreams)[0]?.modelKey);
```

and replace 3c.8's engine + gate with:

```tsx
  const targetModel = modelId ?? selectedModel;
  const shares = analyzerSharesTtsDevice({
    engine: engineForModelId(targetModel),
    endpointGpu: endpointForModelId({ analyzerEndpoints: analyzerEndpoints ?? [] }, targetModel)?.gpu,
    ttsDeviceKey: ttsDeviceKeyFor(generatingModelKey, configValues),
  });

  const guard: GuardResult['guard'] = (proceed) => {
    if (!shares || !anyActiveStream) {
      proceed();
      return;
    }
    setPending(() => proceed);
  };
```

`src/hooks/use-reverse-local-analyzer-guard.tsx:71-84`:

```tsx
  const activeStream = useAppSelector((s) => s.analysis?.activeStream ?? null);
  const libraryBooks = useAppSelector((s) => s.library?.books ?? []);
  const ttsModelKey = useAppSelector((s) => s.account?.resolvedTtsModelKey ?? s.account?.defaultTtsModelKey);
  const configValues = useAppSelector((s) => s.config?.values);

  const [pending, setPending] = useState<(() => void) | null>(null);

  /* #3084 — shares the card: Ollama always; an endpoint on 'any' or the TTS card (an
     unknown card or a snapshot without gpu fails closed); Gemini and gpu 'none' never. */
  const sharesGpu =
    activeStream?.engine !== undefined &&
    analyzerSharesTtsDevice({
      engine: activeStream.engine,
      endpointGpu: activeStream.gpu,
      ttsDeviceKey: ttsDeviceKeyFor(ttsModelKey, configValues),
    });

  const guard: GuardResult['guard'] = (proceed) => {
    if (!activeStream || !sharesGpu) {
      proceed();
      return;
    }
    setPending(() => proceed);
  };
```

(import `analyzerSharesTtsDevice`, `ttsDeviceKeyFor` from `../lib/analyzer-endpoints`.)

`src/store/generation-stream-middleware.ts` — `StreamableRootState` (`:44-51`) gains `account?: { resolvedTtsModelKey?: TtsModelKey; defaultTtsModelKey?: TtsModelKey };` and `config?: { values: ConfigValues };` (import the two types from `../lib/types`, and the two helpers from `../lib/analyzer-endpoints`). `:99-106`:

```ts
      const analysisSnap = after.analysis?.activeStream ?? null;
      if (
        analysisSnap != null &&
        analysisSnap.engine !== undefined &&
        analyzerSharesTtsDevice({
          engine: analysisSnap.engine,
          endpointGpu: analysisSnap.gpu,
          ttsDeviceKey: ttsDeviceKeyFor(after.account?.resolvedTtsModelKey ?? after.account?.defaultTtsModelKey, after.config?.values),
        }) &&
        analysisSnap.bookId === stageBookId &&
        analysisSnap.state !== 'paused' &&
        analysisSnap.state !== 'halted'
      ) {
```

and update the `:48-50` comment to "honours the same card rule the reverse-local-analyzer guard enforces (#3084: Ollama, or an endpoint on the TTS card)".

`src/views/analysing.tsx` — replace 3a's `:344` line and its comment with:

```tsx
  /* #3084 — engine + card captured into the cross-navigation snapshot (read by the
     reverse guard). Ollama beats endpoints beats Gemini, so a mixed run is never
     under-reported; isLocalAnalyzer above still gates only Ollama probing. */
  const analyzerEndpoints = useAppSelector((s) => s.account.analyzerEndpoints);
  const effectiveEngine: AnalysisEngine = isLocalAnalyzer
    ? 'local'
    : effectiveModelIds.some((id) => engineForModelId(id) === 'openai')
      ? 'openai'
      : 'gemini';
  const effectiveGpu = snapshotGpuFor(effectiveModelIds, { analyzerEndpoints: analyzerEndpoints ?? [] });
```

(import `snapshotGpuFor` from `../lib/analyzer-endpoints`). At `:448`, `:804`, `:935` add `gpu: effectiveGpu,` on the line after `engine: effectiveEngine,`.

`src/views/generation.tsx` — after `:288` add `const analyzerEndpoints = useAppSelector((s) => s.account.analyzerEndpoints);`; after `:422` and after `:591` add `const gpu = snapshotGpuFor([selectedAnalyzerModelId], { analyzerEndpoints: analyzerEndpoints ?? [] });`; in both payloads add `gpu,` after `engine,` (`:428`, `:597`).

- [ ] **Step 4: Run and confirm they pass**
Run: `npx vitest run src/lib/analyzer-endpoints.test.ts src/hooks/use-local-analyzer-guard.test.tsx src/hooks/use-reverse-local-analyzer-guard.test.tsx src/store/generation-stream-middleware.test.ts src/views/analysing.test.tsx src/views` then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `analyzerSharesTtsDevice`: change `input.endpointGpu ?? 'any'` to `?? 'none'` → red: "endpoint missing from settings fails closed", forward "fails closed for an endpoint id missing from settings". Restore.
2. `analyzerSharesTtsDevice`: delete `|| input.ttsDeviceKey === undefined` → red: "TTS card unknown fails closed", reverse "an endpoint run on a GPU prompts…". Restore.
3. Middleware: revert to `analysisSnap.engine === 'local'` → red: "#3084 — holds on explicit start while an endpoint analysis on a GPU is alive…". Restore.
4. `snapshotGpuFor`: return `sharing[0]` for several cards → red: "collapses a run to one gpu tag". Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/analyzer-endpoints.ts src/lib/analyzer-endpoints.test.ts src/store/analysis-slice.ts src/hooks/use-local-analyzer-guard.tsx src/hooks/use-local-analyzer-guard.test.tsx src/hooks/use-reverse-local-analyzer-guard.tsx src/hooks/use-reverse-local-analyzer-guard.test.tsx src/store/generation-stream-middleware.ts src/store/generation-stream-middleware.test.ts src/views/analysing.tsx src/views/generation.tsx
git commit -m "feat(frontend): GPU guards compare the endpoint's card with the TTS card"
```

---
### Task 3d.7: Pickers list endpoint models; the run label shows the structured-output mode

**Files:**
- Modify: `src/lib/models.ts:172-198` (`buildModelOptionGroups` returns `ModelOptionGroup[]`; add `buildAnalyzerPickerGroups`)
- Modify: `src/components/analysis-model-picker.tsx:22-25` (prop type)
- Modify the six group-builder sites and their fetch triggers: `src/views/analysing.tsx:310-311,319`; `src/routes/index.tsx:990-994`; `src/views/upload.tsx:39-43`; `src/components/setup/step-defaults.tsx:44-49`; `src/components/model-settings-form.tsx:98-103`; `src/components/analysing/phase-model-swap.tsx:56-57,105`
- Modify the seven `<optgroup key={g.engine}` lines to `key={g.id}`: `src/routes/index.tsx:1058`, `src/views/analysing.tsx:1380`, `src/components/analysing/phase-model-swap.tsx:113`, `src/components/model-settings-form.tsx:266,345,367`, `src/components/setup/step-defaults.tsx:168`
- Modify: `src/components/analysing/phase-model-chip.tsx:61-75,106-109` (suffix); `src/components/model-settings-form.tsx:260-264` (testid), `:324-330` (default-model label)
- Test: Create `src/lib/models.picker-groups.test.ts`, `src/components/analysing/phase-model-chip.output-mode.test.tsx`

**Interfaces:**
- Consumes: `buildCatalogOptionGroups`, `ModelOptionGroup`, `catalogEntryFor`, `runLabelSuffixes`, `fetchAnalyzerCatalog`, `AccountState.analyzerCatalog` (Task 3c.7); `buildLocalModelOptions` (`models.ts:156`).
- Produces: `buildAnalyzerPickerGroups({ localTags, catalog, endpoints }, curated?)`; `data-testid="account-default-analysis-model"` and `data-testid="analyzer-default-model-label"` (used by Task 3d.9).

Rules: the Ollama group keeps coming from `localAnalyzerModels` (plan 221 installed-only, `models.ts:144-155`); Gemini from the catalog with the curated fallback; one group per saved endpoint that has catalog models, in saved order, labelled `<name> (OpenAI-compatible)`. Endpoints with no listed models are left out of pickers (free-text entry lives in Settings, Task 3d.8). The catalog is fetched **at the same moments** `fetchAnalyzerModels` is dispatched today, so the analysing view still never probes on a healthy cloud run (`analysing.tsx:306-320`). The chip suffix appears only when a catalog entry exists for the model; stores without a catalog (every existing test) render exactly today's text.

Keeps green: `src/lib/models.test.ts`, `src/components/analysing/phase-model-chip.test.tsx`, `src/components/analysing/phase-model-swap*.test.tsx`, `src/views/upload*.test.tsx`, `src/components/setup/step-defaults*.test.tsx`, `src/components/model-settings-form.test.tsx` (add `getAnalyzerModels: vi.fn().mockResolvedValue({ groups: [] })` to its `vi.mock('../lib/api'…)` factory, `:13-22`, since the form now dispatches the catalog fetch on mount), e2e `model-manager-analyzer-knobs.spec.ts`, `analysing-multi-model.spec.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/models.picker-groups.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildAnalyzerPickerGroups, buildModelOptionGroups, MODEL_OPTIONS } from './models';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from './types';

const e = (id: string, engine: AnalyzerCatalogEntry['engine'], model = id): AnalyzerCatalogEntry => ({
  id, label: model, engine, model, structuredOutput: { mode: 'schema', dropped: [], label: 'schema' }, testPlan: { configured: 2, all: 3 },
});

const catalog: AnalyzerCatalog = {
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [e('mistral:7b', 'local')] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'fallback', models: [] },
    { kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok', models: [e('openai:lab::qwen3-30b', 'openai', 'qwen3-30b')] },
    { kind: 'endpoint', id: 'empty', label: 'Empty', status: 'error', error: 'connect ECONNREFUSED', models: [] },
  ],
};

describe('buildAnalyzerPickerGroups (#3084)', () => {
  it('Gemini first, then the installed Ollama tags, then endpoint groups with models', () => {
    const groups = buildAnalyzerPickerGroups({
      localTags: [{ name: 'qwen3.5:4b' }],
      catalog,
      endpoints: [{ id: 'lab', name: 'Lab server' }, { id: 'empty', name: 'Empty' }],
    });
    expect(groups.map((g) => g.id)).toEqual(['gemini', 'ollama', 'lab']);
    expect(groups[1].models.map((m) => m.id)).toEqual(['qwen3.5:4b']);
    expect(groups[2]).toMatchObject({ label: 'Lab server (OpenAI-compatible)', engine: 'openai' });
    expect(groups[2].models.map((m) => m.id)).toEqual(['openai:lab::qwen3-30b']);
  });

  it('without a catalog → exactly today\'s groups (curated Gemini + installed Ollama)', () => {
    const today = buildModelOptionGroups([{ id: 'qwen3.5:4b', label: 'Qwen3.5 4B (local)', engine: 'local' }]);
    const groups = buildAnalyzerPickerGroups({ localTags: [{ name: 'qwen3.5:4b' }], catalog: null, endpoints: [] });
    expect(groups.map((g) => ({ id: g.id, label: g.label, models: g.models.map((m) => m.id) }))).toEqual(
      today.map((g) => ({ id: g.id, label: g.label, models: g.models.map((m) => m.id) })),
    );
    expect(groups[0].models.length).toBe(MODEL_OPTIONS.filter((m) => m.engine === 'gemini').length);
  });

  it('every group has a distinct id (optgroup keys)', () => {
    const groups = buildAnalyzerPickerGroups({ localTags: [], catalog, endpoints: [{ id: 'lab', name: 'Lab server' }] });
    expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
  });
});
```

Create `src/components/analysing/phase-model-chip.output-mode.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen } from '@testing-library/react';
import { accountSlice, fetchAnalyzerCatalog } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { PhaseModelChip } from './phase-model-chip';
import type { AnalyzerCatalog } from '../../lib/types';

const CATALOG: AnalyzerCatalog = {
  groups: [
    {
      kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok',
      models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai', model: 'qwen3-30b', structuredOutput: { mode: 'schema', dropped: [], label: 'schema (not enforced)' }, testPlan: { configured: 2, all: 3 } }],
    },
  ],
};

function renderChip(withCatalog: boolean) {
  const store = configureStore({ reducer: { account: accountSlice.reducer, ui: uiSlice.reducer } });
  if (withCatalog) store.dispatch(fetchAnalyzerCatalog.fulfilled(CATALOG, '', undefined));
  render(
    <Provider store={store}>
      <PhaseModelChip phaseId={0} state="streaming" serverModel="openai:lab::qwen3-30b" />
    </Provider>,
  );
}

describe('PhaseModelChip structured-output suffix (#3084)', () => {
  it('shows the endpoint label and the recorded mode', () => {
    renderChip(true);
    expect(screen.getByTestId('phase-model-chip-0')).toHaveTextContent('Lab server · qwen3-30b · schema (not enforced)');
  });
  it('without a catalog shows only the model label', () => {
    renderChip(false);
    const chip = screen.getByTestId('phase-model-chip-0');
    expect(chip).toHaveTextContent('lab · qwen3-30b');
    expect(chip).not.toHaveTextContent('schema');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npx vitest run src/lib/models.picker-groups.test.ts src/components/analysing/phase-model-chip.output-mode.test.tsx`
Expected: FAIL — `buildAnalyzerPickerGroups is not a function`; the chip lacks `· schema (not enforced)`.

- [ ] **Step 3: Implement**

`src/lib/models.ts` — `buildModelOptionGroups` (`:178-191`) keeps its behaviour and gains group identity:

```ts
export function buildModelOptionGroups(localOptions: ModelOption[]): ModelOptionGroup[] {
  return [
    { id: 'gemini', kind: 'gemini', engine: 'gemini', label: 'Gemini API (cloud)', status: 'ok', models: MODEL_OPTIONS.filter((m) => m.engine === 'gemini') },
    { id: 'ollama', kind: 'ollama', engine: 'local', label: 'Local Ollama (default, on-device)', status: 'ok', models: localOptions },
  ];
}

/** Every analyzer picker's groups (#3084): Gemini (catalog, curated fallback), the
    installed Ollama tags, then each saved endpoint that has listed models. */
export function buildAnalyzerPickerGroups(
  input: {
    localTags: Array<{ name: string; size?: number }>;
    catalog: AnalyzerCatalog | null;
    endpoints: ReadonlyArray<{ id: string; name: string }>;
  },
  curated: ModelOption[] = MODEL_OPTIONS,
): ModelOptionGroup[] {
  const fromCatalog = buildCatalogOptionGroups(input.catalog, { includeEndpoints: true }, curated);
  const gemini = fromCatalog.find((g) => g.kind === 'gemini')!;
  const local: ModelOptionGroup = {
    id: 'ollama',
    kind: 'ollama',
    engine: 'local',
    label: 'Local Ollama (default, on-device)',
    status: 'ok',
    models: buildLocalModelOptions(input.localTags, curated.filter((m) => m.engine === 'local')),
  };
  const endpointGroups = input.endpoints
    .map((e) => fromCatalog.find((g) => g.kind === 'endpoint' && g.id === e.id))
    .filter((g): g is ModelOptionGroup => g !== undefined && g.models.length > 0)
    .map((g) => ({ ...g, label: `${g.label} (OpenAI-compatible)` }));
  return [gemini, local, ...endpointGroups];
}
```

(When `catalog` is null, `buildCatalogOptionGroups` returns the curated Gemini list — identical to today's Gemini group; the test pins it.)

`src/components/analysis-model-picker.tsx:22-25`: `groups?: ModelOptionGroup[];` (import the type from `../lib/models`).

Group-builder sites — each becomes (names per site):

`src/views/analysing.tsx:310-311`:
```tsx
  const localAnalyzerModels = useAppSelector((s) => s.account.localAnalyzerModels);
  const analyzerCatalog = useAppSelector((s) => s.account.analyzerCatalog);
  const analyzerEndpointList = useAppSelector((s) => s.account.analyzerEndpoints);
  const analyzerModelGroups = buildAnalyzerPickerGroups({ localTags: localAnalyzerModels, catalog: analyzerCatalog, endpoints: analyzerEndpointList ?? [] });
```
and `:319` `if (error) { void dispatch(fetchAnalyzerModels()); void dispatch(fetchAnalyzerCatalog(undefined)); }` (Task 3d.6 already selects `analyzerEndpoints` in this component; reuse that selector instead of `analyzerEndpointList` if it sits above `:311`.)

`src/routes/index.tsx:990-994`:
```tsx
  const localAnalyzerModels = useAppSelector((s) => s.account.localAnalyzerModels);
  const analyzerCatalog = useAppSelector((s) => s.account.analyzerCatalog);
  const analyzerEndpoints = useAppSelector((s) => s.account.analyzerEndpoints);
  const modelGroups = buildAnalyzerPickerGroups({ localTags: localAnalyzerModels, catalog: analyzerCatalog, endpoints: analyzerEndpoints ?? [] });
  useEffect(() => {
    void dispatch(fetchAnalyzerModels());
    void dispatch(fetchAnalyzerCatalog(undefined));
  }, [dispatch]);
```

`src/views/upload.tsx:39-43` — same five changes with `analysisModelGroups` as the name.

`src/components/setup/step-defaults.tsx:44-49` and `src/components/model-settings-form.tsx:98-103` — same, reading `account.localAnalyzerModels`, `account.analyzerCatalog`, `account.analyzerEndpoints` from the component's existing `account` selector.

`src/components/analysing/phase-model-swap.tsx:56-57` — same selectors, `modelGroups = buildAnalyzerPickerGroups(…)`; `:105` `onFocus={() => { void dispatch(fetchAnalyzerModels()); void dispatch(fetchAnalyzerCatalog(undefined)); }}`.

Each file: import `buildAnalyzerPickerGroups` (drop `buildModelOptionGroups`/`buildLocalModelOptions` imports that become unused) and `fetchAnalyzerCatalog` from `account-slice`.

The seven `<optgroup key={g.engine}` lines listed above become `<optgroup key={g.id}` (two endpoint groups would otherwise share the key `openai`).

`src/components/analysing/phase-model-chip.tsx` — import `catalogEntryFor, runLabelSuffixes` beside `modelLabel`; after the `label` computation (Task 3c.7's `:70-75` replacement):

```tsx
  const suffixModel = serverModel ?? (serverDefault ? undefined : modelId ?? undefined);
  const suffixes = suffixModel ? runLabelSuffixes(catalogEntryFor(suffixModel, analyzerCatalog)) : [];
  const displayLabel = suffixes.length > 0 ? `${label} · ${suffixes.join(' · ')}` : label;
```

and `:108` `{label}` → `{displayLabel}`.

`src/components/model-settings-form.tsx:260-264` — add `data-testid="account-default-analysis-model"` to the "Analysis model" `<select>`. `:324-330` — the OFF branch's default model span becomes:

```tsx
              <span data-testid="analyzer-default-model-label" className="font-medium text-ink">
                {[analyzerModelLabel(defaultAnalysisModel, account.analyzerCatalog), ...runLabelSuffixes(catalogEntryFor(defaultAnalysisModel, account.analyzerCatalog))].join(' · ')}
              </span>
```

(import `catalogEntryFor`, `runLabelSuffixes` from `../lib/model-label`).

- [ ] **Step 4: Run and confirm they pass**
Run: `npx vitest run src/lib/models.picker-groups.test.ts src/lib/models.test.ts src/components/analysing src/components/model-settings-form.test.tsx src/components/setup src/views/upload.test.tsx src/views/analysing.test.tsx` then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `buildAnalyzerPickerGroups`: drop the `g.models.length > 0` filter → red: "Gemini first, then the installed Ollama tags, then endpoint groups with models" (the `empty` group appears). Restore.
2. `buildAnalyzerPickerGroups`: build the Ollama group from the catalog's Ollama listing instead of `localTags` → red: same test (`mistral:7b` instead of `qwen3.5:4b`). Restore.
3. `phase-model-chip.tsx`: render `{label}` again → red: "shows the endpoint label and the recorded mode". Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/models.ts src/lib/models.picker-groups.test.ts src/components/analysis-model-picker.tsx src/views/analysing.tsx src/routes/index.tsx src/views/upload.tsx src/components/setup/step-defaults.tsx src/components/model-settings-form.tsx src/components/model-settings-form.test.tsx src/components/analysing/phase-model-swap.tsx src/components/analysing/phase-model-chip.tsx src/components/analysing/phase-model-chip.output-mode.test.tsx
git commit -m "feat(frontend): analyzer pickers list endpoint models and show the output mode"
```

---
### Task 3d.8: Settings → Analyzer endpoints (list, add, edit, delete, key, Detect, GPU, unload URL)

**Files:**
- Create: `src/components/settings/analyzer-endpoints-section.tsx`
- Modify: `src/components/model-settings-form.tsx:57-88` (new group + nav entry), `:538` (render after the Server configuration section)
- Test: Create `src/components/settings/analyzer-endpoints-section.test.tsx`

**Interfaces:**
- Consumes (3b): thunks `createAnalyzerEndpoint(input)`, `updateAnalyzerEndpoint({ endpointId, input })`, `deleteAnalyzerEndpoint(endpointId)`, `saveAnalyzerEndpointKey({ endpointId, key })`; `AnalyzerEndpointError { status, code, message, details }`; standalone `detectAnalyzerEndpointContext({ baseUrl, flavor: 'llama.cpp' | 'llama-swap', model?, apiKey?, endpointId?, allowModelLoad? })` → `{ contextTokens, source }`; types `AnalyzerEndpoint`, `AnalyzerEndpointInput`; GET field `analyzerEndpointKeyStatus: Record<string, 'set' | 'unset' | 'origin-mismatch'>`. From 3c/3d: `api.previewAnalyzerEndpointModels`, `api.getGpuDevices` (`api.ts:8914`), `fetchAnalyzerCatalog`, `ModelTestButton`, `modelLabel`, `defaultGpuForBaseUrl`, `saveAccountSettings`, `endpointModelId`.
- Produces: `AnalyzerEndpointsSection()`; exported helpers `slugifyEndpointId(name, taken)`, `validateEndpointDraft(draft, original, keyStatus)`; the test ids Task 3d.9 uses: `add-endpoint`, `endpoint-name`, `endpoint-base-url`, `endpoint-key`, `endpoint-no-key`, `endpoint-key-reentry`, `endpoint-gpu`, `endpoint-unload-url`, `endpoint-concurrency`, `endpoint-ceiling-minutes`, `endpoint-structured-output`, `endpoint-max-output-tokens`, `endpoint-context-tokens`, `endpoint-context-error`, `endpoint-max-input-tokens`, `endpoint-list-models`, `endpoint-detect-flavor`, `endpoint-detect-model`, `endpoint-detect`, `endpoint-save`, `endpoint-cancel`, `endpoint-save-error`, `endpoint-row-<id>`, `endpoint-edit-<id>`, `endpoint-delete-<id>`, `endpoint-row-error-<id>`, `endpoint-free-model-<id>`, `endpoint-use-free-model-<id>`.

Behaviour (spec §3, §4, decisions 3b/3c/4):
- **Context size is required.** Save refuses without an integer ≥ 512 and shows `endpoint-context-error`. **List models** calls the preview route and prefills the smallest served context only when the field is empty. **Detect** reads llama.cpp `/props` directly; with flavor `llama-swap` and a model chosen it first confirms "Detecting may load <model> on the server" and then sends `allowModelLoad: true`. Nothing probes automatically.
- **Key.** Password field; typed keys are written through `saveAnalyzerEndpointKey` after the endpoint write, so the key binds to the saved base URL's origin. When editing changes the origin and a key is saved (`set` or `origin-mismatch`), `endpoint-key-reentry` explains the key is only sent to the old host and Save is blocked until a key is typed or "This server needs no key" (`endpoint-no-key`) is ticked (which clears the saved key).
- **GPU.** Options `none`, `any` and each device from `GET /api/gpu/devices` as `cuda:<idx>`; new endpoints follow `defaultGpuForBaseUrl(baseUrl)` until the user picks.
- **Unload URL.** Optional; the hint shows `{model}` substitution with a llama-swap example; a different origin from the base URL is refused client-side (the server refuses too).
- **Delete.** A 409 `referenced` refusal shows its message and details under the row.
- **Free-text model.** Each saved endpoint row takes a model id and sets `defaultAnalysisModel` to `openai:<id>::<model>` — the path when listing fails.
- **Test.** Each catalog model of the endpoint gets `ModelTestButton` (forward GPU guard included).
- ID: slug of the name on create (`[a-z0-9-]`, ≤ 40, unique with `-2`, `-3`…), fixed on edit.

Keeps green: `src/components/model-settings-form.test.tsx` (its `vi.mock('../lib/api')` factory gains `getGpuDevices: vi.fn().mockResolvedValue({ devices: [], cpu: true })` and `previewAnalyzerEndpointModels: vi.fn()`), e2e `model-manager-*.spec.ts`.

- [ ] **Step 1: Write the failing test** — create `src/components/settings/analyzer-endpoints-section.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { chaptersSlice } from '../../store/chapters-slice';
import { librarySlice } from '../../store/library-slice';
import { configSlice } from '../../store/config-slice';
import { AnalyzerEndpointsSection, slugifyEndpointId } from './analyzer-endpoints-section';
import { api, AnalyzerEndpointError, detectAnalyzerEndpointContext } from '../../lib/api';
import type { AnalyzerEndpoint } from '../../lib/types';

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    AnalyzerEndpointError: actual.AnalyzerEndpointError,
    detectAnalyzerEndpointContext: vi.fn(),
    api: {
      getGpuDevices: vi.fn(),
      getAnalyzerModels: vi.fn(),
      previewAnalyzerEndpointModels: vi.fn(),
      createAnalyzerEndpoint: vi.fn(),
      updateAnalyzerEndpoint: vi.fn(),
      deleteAnalyzerEndpoint: vi.fn(),
      putAnalyzerEndpointKey: vi.fn(),
      putUserSettings: vi.fn(),
      testAnalyzerModel: vi.fn(),
    },
  };
});
vi.mock('../../store/queue-thunks', () => ({ haltActiveGeneration: vi.fn(() => ({ type: 'test/halt' })) }));

const LAB: AnalyzerEndpoint = {
  id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', concurrency: 1, requestCeilingMs: 1_800_000,
  structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 32768,
};

function renderSection(seed: { endpoints?: AnalyzerEndpoint[]; keyStatus?: Record<string, 'set' | 'unset' | 'origin-mismatch'> } = {}) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer, chapters: chaptersSlice.reducer, library: librarySlice.reducer, config: configSlice.reducer },
  });
  store.dispatch({ type: 'account/fetch/fulfilled', payload: { analyzerEndpoints: seed.endpoints ?? [], analyzerEndpointKeyStatus: seed.keyStatus ?? {} } });
  render(
    <Provider store={store}>
      <AnalyzerEndpointsSection />
    </Provider>,
  );
  return store;
}

const settingsWith = (endpoints: AnalyzerEndpoint[]) => ({ analyzerEndpoints: endpoints, analyzerEndpointKeyStatus: {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getGpuDevices).mockResolvedValue({
    devices: [
      { uuid: 'GPU-0', idx: 0, name: 'RTX 4070 Laptop', total_mb: 8000, free_mb: 6000 },
      { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
    ],
    cpu: true,
  });
  vi.mocked(api.getAnalyzerModels).mockResolvedValue({ groups: [] });
});

describe('slugifyEndpointId', () => {
  it('slugs the name and de-duplicates', () => {
    expect(slugifyEndpointId('Lab Server #2', [])).toBe('lab-server-2');
    expect(slugifyEndpointId('Lab', ['lab'])).toBe('lab-2');
    expect(slugifyEndpointId('!!!', [])).toBe('endpoint');
  });
});

describe('AnalyzerEndpointsSection (#3084)', () => {
  it('refuses to save without a context size', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(await screen.findByTestId('endpoint-context-error')).toBeInTheDocument();
    expect(api.createAnalyzerEndpoint).not.toHaveBeenCalled();
  });

  it('GPU defaults to any for a loopback host and none for a remote host; lists detected cards', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://localhost:8080/v1' } });
    expect(screen.getByTestId('endpoint-gpu')).toHaveValue('any');
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'https://openrouter.ai/api/v1' } });
    expect(screen.getByTestId('endpoint-gpu')).toHaveValue('none');
    await waitFor(() => expect(screen.getByRole('option', { name: /RTX 5070 Ti \(cuda:1\)/ })).toBeInTheDocument());
  });

  it('creates the endpoint, then writes the typed key bound to the saved base URL', async () => {
    vi.mocked(api.createAnalyzerEndpoint).mockResolvedValue(settingsWith([LAB]));
    vi.mocked(api.putAnalyzerEndpointKey).mockResolvedValue(settingsWith([LAB]));
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '32768' } });
    fireEvent.change(screen.getByTestId('endpoint-key'), { target: { value: 'sk-local' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.putAnalyzerEndpointKey).toHaveBeenCalledWith('lab', 'sk-local'));
    expect(vi.mocked(api.createAnalyzerEndpoint).mock.calls[0][0]).toMatchObject({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 32768, gpu: 'any' });
    expect(vi.mocked(api.createAnalyzerEndpoint).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.putAnalyzerEndpointKey).mock.invocationCallOrder[0]);
  });

  it('editing the host with a saved key prompts for the key and blocks Save until it is re-entered', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockResolvedValue(settingsWith([{ ...LAB, baseUrl: 'http://10.0.0.5:8080/v1' }]));
    vi.mocked(api.putAnalyzerEndpointKey).mockResolvedValue(settingsWith([LAB]));
    renderSection({ endpoints: [LAB], keyStatus: { lab: 'set' } });
    fireEvent.click(screen.getByTestId('endpoint-edit-lab'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://10.0.0.5:8080/v1' } });
    expect(screen.getByTestId('endpoint-key-reentry')).toHaveTextContent(/re-enter the API key/i);
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(api.updateAnalyzerEndpoint).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('endpoint-key'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.putAnalyzerEndpointKey).toHaveBeenCalledWith('lab', 'sk-new'));
  });

  it('refuses an unload URL on another origin', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '32768' } });
    fireEvent.change(screen.getByTestId('endpoint-unload-url'), { target: { value: 'http://127.0.0.1:9999/api/models/unload/{model}' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(await screen.findByText(/must use the same host and port as the base URL/i)).toBeInTheDocument();
    expect(api.createAnalyzerEndpoint).not.toHaveBeenCalled();
  });

  it('List models prefills the smallest served context only when the field is empty', async () => {
    vi.mocked(api.previewAnalyzerEndpointModels).mockResolvedValue({ status: 'ok', models: [{ model: 'a', contextTokens: 32768 }, { model: 'b', contextTokens: 8192 }], suggestedContextTokens: 8192 });
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.click(screen.getByTestId('endpoint-list-models'));
    await waitFor(() => expect(screen.getByTestId('endpoint-context-tokens')).toHaveValue(8192));
  });

  it('a llama-swap Detect for a model asks before it may load the model, then sends allowModelLoad', async () => {
    vi.mocked(api.previewAnalyzerEndpointModels).mockResolvedValue({ status: 'ok', models: [{ model: 'qwen3-30b' }] });
    vi.mocked(detectAnalyzerEndpointContext).mockResolvedValue({ contextTokens: 40960, source: 'llama-swap /props' });
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.click(screen.getByTestId('endpoint-list-models'));
    await screen.findByRole('option', { name: 'qwen3-30b' });
    fireEvent.change(screen.getByTestId('endpoint-detect-flavor'), { target: { value: 'llama-swap' } });
    fireEvent.change(screen.getByTestId('endpoint-detect-model'), { target: { value: 'qwen3-30b' } });
    fireEvent.click(screen.getByTestId('endpoint-detect'));
    expect(screen.getByText(/may load qwen3-30b on the server/i)).toBeInTheDocument();
    expect(detectAnalyzerEndpointContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Detect anyway' }));
    await waitFor(() =>
      expect(detectAnalyzerEndpointContext).toHaveBeenCalledWith(expect.objectContaining({ flavor: 'llama-swap', model: 'qwen3-30b', allowModelLoad: true })),
    );
    await waitFor(() => expect(screen.getByTestId('endpoint-context-tokens')).toHaveValue(40960));
  });

  it('a delete refused because settings still reference the endpoint shows the references', async () => {
    vi.mocked(api.deleteAnalyzerEndpoint).mockRejectedValue(
      new AnalyzerEndpointError(409, 'referenced', 'Analyzer endpoint "lab" is still used by 1 saved setting(s).', ['Account setting "defaultAnalysisModel"']),
    );
    renderSection({ endpoints: [LAB] });
    fireEvent.click(screen.getByTestId('endpoint-delete-lab'));
    expect(await screen.findByTestId('endpoint-row-error-lab')).toHaveTextContent('Account setting "defaultAnalysisModel"');
  });

  it('a free-text model id becomes the default analysis model', async () => {
    vi.mocked(api.putUserSettings).mockImplementation(async (patch) => patch as never);
    renderSection({ endpoints: [LAB] });
    fireEvent.change(screen.getByTestId('endpoint-free-model-lab'), { target: { value: 'qwen3-30b-a3b' } });
    fireEvent.click(screen.getByTestId('endpoint-use-free-model-lab'));
    await waitFor(() => expect(api.putUserSettings).toHaveBeenCalledWith({ defaultAnalysisModel: 'openai:lab::qwen3-30b-a3b' }));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npx vitest run src/components/settings/analyzer-endpoints-section.test.tsx`  Expected: FAIL — `Failed to resolve import "./analyzer-endpoints-section"`.

- [ ] **Step 3: Implement** — create `src/components/settings/analyzer-endpoints-section.tsx`:

```tsx
/* #3084 W3d — Model Manager → Analyzer endpoints. Named OpenAI Chat Completions-
   compatible servers (llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter…).
   Context size is required and only prefilled from served values; keys bind to the base
   URL's origin; the GPU card drives guards and TTS eviction; nothing probes on its own. */
import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  createAnalyzerEndpoint,
  deleteAnalyzerEndpoint,
  fetchAnalyzerCatalog,
  saveAccountSettings,
  saveAnalyzerEndpointKey,
  updateAnalyzerEndpoint,
} from '../../store/account-slice';
import { api, detectAnalyzerEndpointContext, AnalyzerEndpointError } from '../../lib/api';
import { defaultGpuForBaseUrl } from '../../lib/analyzer-endpoints';
import { endpointModelId } from '../../lib/model-id';
import { modelLabel } from '../../lib/model-label';
import type { AnalyzerEndpoint, AnalyzerEndpointInput, AnalyzerEndpointModelsPreview, GpuDevice } from '../../lib/types';
import { ConfirmDialog } from '../../modals/confirm-dialog';
import { FieldRow } from '../account-forms';
import { ModelTestButton } from './model-test-button';

type Mode = AnalyzerEndpoint['structuredOutput'];

export interface EndpointDraft {
  id: string;
  name: string;
  baseUrl: string;
  gpu: string;
  gpuTouched: boolean;
  unloadUrl: string;
  concurrency: string;
  ceilingMinutes: string;
  structuredOutput: Mode;
  maxOutputTokens: string;
  contextTokens: string;
  maxInputTokensPerRequest: string;
  key: string;
  noKey: boolean;
}

type DraftErrors = Partial<Record<'name' | 'baseUrl' | 'contextTokens' | 'unloadUrl' | 'key', string>>;

const INPUT = 'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30';

export function slugifyEndpointId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'endpoint';
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function draftFrom(e: AnalyzerEndpoint | null): EndpointDraft {
  return {
    id: e?.id ?? '',
    name: e?.name ?? '',
    baseUrl: e?.baseUrl ?? '',
    gpu: e?.gpu ?? 'none',
    gpuTouched: e !== null,
    unloadUrl: e?.unloadUrl ?? '',
    concurrency: String(e?.concurrency ?? 1),
    ceilingMinutes: String(Math.round((e?.requestCeilingMs ?? 1_800_000) / 60_000)),
    structuredOutput: e?.structuredOutput ?? 'schema',
    maxOutputTokens: String(e?.maxOutputTokens ?? 0),
    contextTokens: e ? String(e.contextTokens) : '',
    maxInputTokensPerRequest: e?.maxInputTokensPerRequest ? String(e.maxInputTokensPerRequest) : '',
    key: '',
    noKey: false,
  };
}

export function validateEndpointDraft(
  d: EndpointDraft,
  original: AnalyzerEndpoint | null,
  keyStatus: 'set' | 'unset' | 'origin-mismatch' | undefined,
): { errors: DraftErrors; input: AnalyzerEndpointInput | null; hostChanged: boolean } {
  const errors: DraftErrors = {};
  if (d.name.trim() === '') errors.name = 'Give the endpoint a name.';
  const origin = originOf(d.baseUrl.trim());
  if (!origin) errors.baseUrl = 'Enter the server base URL, e.g. http://127.0.0.1:8080/v1.';
  const context = Number.parseInt(d.contextTokens, 10);
  if (!Number.isInteger(context) || context < 512) {
    errors.contextTokens = 'Enter the context size your server actually serves (tokens). Use List models or Detect to fill it.';
  }
  if (d.unloadUrl.trim() !== '' && originOf(d.unloadUrl.trim()) !== origin) {
    errors.unloadUrl = 'The unload URL must use the same host and port as the base URL.';
  }
  const hostChanged = original !== null && origin !== null && originOf(original.baseUrl) !== origin && keyStatus !== undefined && keyStatus !== 'unset';
  if (hostChanged && d.key.trim() === '' && !d.noKey) {
    errors.key = `The host changed — re-enter the API key for ${original?.name}. The saved key is only sent to ${originOf(original?.baseUrl ?? '')}.`;
  }
  if (Object.keys(errors).length > 0) return { errors, input: null, hostChanged };
  const maxInput = Number.parseInt(d.maxInputTokensPerRequest, 10);
  const input: AnalyzerEndpointInput = {
    id: d.id,
    name: d.name.trim(),
    baseUrl: d.baseUrl.trim(),
    gpu: d.gpu,
    ...(d.unloadUrl.trim() !== '' ? { unloadUrl: d.unloadUrl.trim() } : {}),
    concurrency: Math.min(16, Math.max(1, Number.parseInt(d.concurrency, 10) || 1)),
    requestCeilingMs: Math.min(240, Math.max(1, Number.parseInt(d.ceilingMinutes, 10) || 30)) * 60_000,
    structuredOutput: d.structuredOutput,
    reasoningStyle: original?.reasoningStyle ?? 'not_controllable',
    reasoning: original?.reasoning ?? 'model-default',
    maxOutputTokens: Math.max(0, Number.parseInt(d.maxOutputTokens, 10) || 0),
    contextTokens: context,
    ...(Number.isInteger(maxInput) && maxInput >= 256 ? { maxInputTokensPerRequest: maxInput } : {}),
    ...(original?.extraParams ? { extraParams: original.extraParams } : {}),
  };
  return { errors, input, hostChanged };
}

function refusalText(err: unknown): string {
  if (err instanceof AnalyzerEndpointError) return [err.message, ...err.details].join(' ');
  return (err as { message?: string }).message ?? 'The request failed.';
}

export function AnalyzerEndpointsSection() {
  const dispatch = useAppDispatch();
  const endpoints = useAppSelector((s) => s.account.analyzerEndpoints) ?? [];
  const keyStatus = useAppSelector((s) => s.account.analyzerEndpointKeyStatus) ?? {};
  const catalog = useAppSelector((s) => s.account.analyzerCatalog);
  const [devices, setDevices] = useState<GpuDevice[]>([]);
  const [editing, setEditing] = useState<AnalyzerEndpoint | null | undefined>(undefined); // undefined = closed, null = new
  const [draft, setDraft] = useState<EndpointDraft>(draftFrom(null));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AnalyzerEndpointModelsPreview | null>(null);
  const [detectFlavor, setDetectFlavor] = useState<'llama.cpp' | 'llama-swap'>('llama.cpp');
  const [detectModel, setDetectModel] = useState('');
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [freeModels, setFreeModels] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.getGpuDevices().then((r) => setDevices(r.devices)).catch(() => setDevices([]));
    void dispatch(fetchAnalyzerCatalog(undefined));
  }, [dispatch]);

  const hostChanged = useMemo(
    () => editing != null && originOf(editing.baseUrl) !== originOf(draft.baseUrl) && (keyStatus[editing.id] ?? 'unset') !== 'unset',
    [editing, draft.baseUrl, keyStatus],
  );

  const open = (endpoint: AnalyzerEndpoint | null) => {
    setEditing(endpoint);
    setDraft(draftFrom(endpoint));
    setErrors({});
    setSaveError(null);
    setPreview(null);
    setDetectNote(null);
  };

  const set = <K extends keyof EndpointDraft>(key: K, value: EndpointDraft[K]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value };
      if (key === 'baseUrl' && !d.gpuTouched) next.gpu = defaultGpuForBaseUrl(String(value));
      if (key === 'gpu') next.gpuTouched = true;
      return next;
    });

  const save = async () => {
    const withId = editing ? draft : { ...draft, id: slugifyEndpointId(draft.name, endpoints.map((e) => e.id)) };
    const result = validateEndpointDraft(withId, editing ?? null, editing ? keyStatus[editing.id] : undefined);
    setErrors(result.errors);
    if (!result.input) return;
    setSaveError(null);
    try {
      if (editing) await dispatch(updateAnalyzerEndpoint({ endpointId: editing.id, input: result.input })).unwrap();
      else await dispatch(createAnalyzerEndpoint(result.input)).unwrap();
      if (withId.key.trim() !== '') {
        await dispatch(saveAnalyzerEndpointKey({ endpointId: result.input.id, key: withId.key.trim() })).unwrap();
      } else if (result.hostChanged && withId.noKey) {
        await dispatch(saveAnalyzerEndpointKey({ endpointId: result.input.id, key: null })).unwrap();
      }
      setEditing(undefined);
      void dispatch(fetchAnalyzerCatalog({ refresh: true }));
    } catch (err) {
      setSaveError(refusalText(err));
    }
  };

  const listModels = async () => {
    const out = await api.previewAnalyzerEndpointModels({
      baseUrl: draft.baseUrl.trim(),
      ...(editing ? { endpointId: editing.id } : {}),
      ...(draft.key.trim() !== '' ? { apiKey: draft.key.trim() } : {}),
    });
    setPreview(out);
    if (out.suggestedContextTokens && draft.contextTokens.trim() === '') set('contextTokens', String(out.suggestedContextTokens));
  };

  const runDetect = async (allowModelLoad: boolean) => {
    setDetectNote(null);
    try {
      const out = await detectAnalyzerEndpointContext({
        baseUrl: draft.baseUrl.trim(),
        flavor: detectFlavor,
        ...(detectModel ? { model: detectModel } : {}),
        ...(editing ? { endpointId: editing.id } : {}),
        ...(draft.key.trim() !== '' ? { apiKey: draft.key.trim() } : {}),
        ...(allowModelLoad ? { allowModelLoad: true } : {}),
      });
      set('contextTokens', String(out.contextTokens));
      setDetectNote(`Detected ${out.contextTokens.toLocaleString()} tokens from ${out.source}.`);
    } catch (err) {
      setDetectNote(refusalText(err));
    }
  };

  const onDetect = () => {
    if (detectFlavor === 'llama-swap' && detectModel) setConfirmLoad(true);
    else void runDetect(false);
  };

  const remove = async (id: string) => {
    setRowErrors((r) => ({ ...r, [id]: '' }));
    try {
      await dispatch(deleteAnalyzerEndpoint(id)).unwrap();
    } catch (err) {
      setRowErrors((r) => ({ ...r, [id]: refusalText(err) }));
    }
  };

  const useFreeModel = (id: string) => {
    const model = (freeModels[id] ?? '').trim();
    if (model === '') return;
    void dispatch(saveAccountSettings({ defaultAnalysisModel: endpointModelId(id, model) }));
  };

  return (
    <div data-testid="analyzer-endpoints-section" className="space-y-4">
      {endpoints.map((e) => {
        const group = catalog?.groups.find((g) => g.kind === 'endpoint' && g.id === e.id);
        return (
          <div key={e.id} data-testid={`endpoint-row-${e.id}`} className="rounded-xl border border-ink/10 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink flex-1">{e.name}</span>
              <span className="text-xs text-ink/55">{e.baseUrl} · {e.gpu} · {e.contextTokens.toLocaleString()} ctx · key {keyStatus[e.id] ?? 'unset'}</span>
              <button type="button" data-testid={`endpoint-edit-${e.id}`} onClick={() => open(e)} className="px-3 py-1 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">Edit</button>
              <button type="button" data-testid={`endpoint-delete-${e.id}`} onClick={() => void remove(e.id)} className="px-3 py-1 rounded-full border border-rose-300 text-xs text-rose-700 min-h-[44px] fine-pointer:min-h-0">Delete</button>
            </div>
            {rowErrors[e.id] && <p data-testid={`endpoint-row-error-${e.id}`} className="text-xs text-rose-700">{rowErrors[e.id]}</p>}
            {group?.status === 'error' && <p className="text-xs text-amber-800">Could not list models: {group.error}</p>}
            {(group?.models ?? []).map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 pl-2">
                <span className="text-xs text-ink flex-1">{modelLabel(m.id, catalog)}</span>
                <ModelTestButton entry={m} label={modelLabel(m.id, catalog)} />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 pl-2">
              <input
                data-testid={`endpoint-free-model-${e.id}`}
                placeholder="model id (if the list is empty)"
                value={freeModels[e.id] ?? ''}
                onChange={(ev) => setFreeModels((f) => ({ ...f, [e.id]: ev.target.value }))}
                className="px-3 py-1.5 rounded-xl border border-ink/15 bg-white text-xs text-ink min-h-[44px] fine-pointer:min-h-0"
              />
              <button type="button" data-testid={`endpoint-use-free-model-${e.id}`} onClick={() => useFreeModel(e.id)} className="px-3 py-1 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">Use as default analysis model</button>
            </div>
          </div>
        );
      })}

      {editing === undefined ? (
        <button type="button" data-testid="add-endpoint" onClick={() => open(null)} className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0">
          Add endpoint
        </button>
      ) : (
        <div data-testid="endpoint-editor" className="rounded-xl border border-ink/15 p-4 space-y-3">
          <FieldRow label="Name">
            <input data-testid="endpoint-name" value={draft.name} onChange={(e) => set('name', e.target.value)} className={INPUT} />
            {errors.name && <p className="mt-1 text-xs text-rose-700">{errors.name}</p>}
          </FieldRow>
          <FieldRow label="Base URL" sublabel="The OpenAI-compatible root, ending in /v1 for most servers.">
            <input data-testid="endpoint-base-url" value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="http://127.0.0.1:8080/v1" className={INPUT} />
            {errors.baseUrl && <p className="mt-1 text-xs text-rose-700">{errors.baseUrl}</p>}
          </FieldRow>
          <FieldRow label="API key" sublabel="Optional. Stored for this host only and never shown again; sent only to this base URL's host.">
            <input data-testid="endpoint-key" type="password" autoComplete="off" value={draft.key} onChange={(e) => set('key', e.target.value)} className={INPUT} />
            {hostChanged && (
              <div data-testid="endpoint-key-reentry" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                The host changed — re-enter the API key for {editing?.name}. The saved key is only sent to {originOf(editing?.baseUrl ?? '')}.
                <label className="mt-1 flex items-center gap-2">
                  <input type="checkbox" data-testid="endpoint-no-key" checked={draft.noKey} onChange={(e) => set('noKey', e.target.checked)} />
                  This server needs no key
                </label>
              </div>
            )}
            {errors.key && <p className="mt-1 text-xs text-rose-700">{errors.key}</p>}
          </FieldRow>
          <FieldRow label="Context size (tokens)" sublabel="Required: what the server actually serves per request, not the model's training context. List models fills it from served values; Detect reads llama.cpp / llama-swap.">
            <div className="flex flex-wrap items-center gap-2">
              <input data-testid="endpoint-context-tokens" type="number" min={512} value={draft.contextTokens} onChange={(e) => set('contextTokens', e.target.value)} className="w-40 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm" />
              <button type="button" data-testid="endpoint-list-models" onClick={() => void listModels()} className="px-3 py-1.5 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">List models</button>
              <select data-testid="endpoint-detect-flavor" value={detectFlavor} onChange={(e) => setDetectFlavor(e.target.value as 'llama.cpp' | 'llama-swap')} className="px-2 py-1.5 rounded-full border border-ink/15 text-xs">
                <option value="llama.cpp">llama.cpp</option>
                <option value="llama-swap">llama-swap</option>
              </select>
              <select data-testid="endpoint-detect-model" value={detectModel} onChange={(e) => setDetectModel(e.target.value)} className="px-2 py-1.5 rounded-full border border-ink/15 text-xs">
                <option value="">(no model)</option>
                {(preview?.models ?? []).map((m) => (
                  <option key={m.model} value={m.model}>{m.model}</option>
                ))}
              </select>
              <button type="button" data-testid="endpoint-detect" onClick={onDetect} className="px-3 py-1.5 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">Detect</button>
            </div>
            {preview?.status === 'failed' && <p className="mt-1 text-xs text-amber-800">Could not list models: {preview.error}</p>}
            {detectNote && <p className="mt-1 text-xs text-ink/60">{detectNote}</p>}
            {errors.contextTokens && <p data-testid="endpoint-context-error" className="mt-1 text-xs text-rose-700">{errors.contextTokens}</p>}
          </FieldRow>
          <FieldRow label="GPU" sublabel="The card this server runs on. Castwright asks before analysing on the voice engine's card and unloads it there when a voice model needs the memory. Use None for a remote or CPU server; Any treats it as sharing every card.">
            <select data-testid="endpoint-gpu" value={draft.gpu} onChange={(e) => set('gpu', e.target.value)} className={INPUT}>
              <option value="none">None (remote or CPU)</option>
              <option value="any">Any card</option>
              {devices.map((d) => (
                <option key={d.idx} value={`cuda:${d.idx}`}>{`${d.name} (cuda:${d.idx})`}</option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="Unload URL" sublabel="Optional, same host as the base URL. Castwright POSTs it to free the card for a voice model. {model} is replaced by the last model used, e.g. http://127.0.0.1:8080/api/models/unload/{model} for llama-swap.">
            <input data-testid="endpoint-unload-url" value={draft.unloadUrl} onChange={(e) => set('unloadUrl', e.target.value)} className={INPUT} />
            {errors.unloadUrl && <p className="mt-1 text-xs text-rose-700">{errors.unloadUrl}</p>}
          </FieldRow>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldRow label="Concurrent requests" sublabel="1–16. Match your server's parallel slots.">
              <input data-testid="endpoint-concurrency" type="number" min={1} max={16} value={draft.concurrency} onChange={(e) => set('concurrency', e.target.value)} className={INPUT} />
            </FieldRow>
            <FieldRow label="Request ceiling (minutes)" sublabel="Longest one request may run, counted after it leaves the queue. Default 30.">
              <input data-testid="endpoint-ceiling-minutes" type="number" min={1} max={240} value={draft.ceilingMinutes} onChange={(e) => set('ceilingMinutes', e.target.value)} className={INPUT} />
            </FieldRow>
            <FieldRow label="Structured output" sublabel="schema sends the output schema; json asks for any JSON object (some servers, e.g. LM Studio, reject it); off sends neither. llama.cpp ignores the schema while a model is thinking — use Test to see what this model does.">
              <select data-testid="endpoint-structured-output" value={draft.structuredOutput} onChange={(e) => set('structuredOutput', e.target.value as Mode)} className={INPUT}>
                <option value="schema">schema</option>
                <option value="json">json</option>
                <option value="off">off</option>
              </select>
            </FieldRow>
            <FieldRow label="Max output tokens" sublabel="0 = Auto (the model's limit, or context minus input).">
              <input data-testid="endpoint-max-output-tokens" type="number" min={0} value={draft.maxOutputTokens} onChange={(e) => set('maxOutputTokens', e.target.value)} className={INPUT} />
            </FieldRow>
            <FieldRow label="Max input tokens per request" sublabel="Optional cap; chunks are sized to fit it.">
              <input data-testid="endpoint-max-input-tokens" type="number" min={256} value={draft.maxInputTokensPerRequest} onChange={(e) => set('maxInputTokensPerRequest', e.target.value)} className={INPUT} />
            </FieldRow>
          </div>
          {saveError && <p data-testid="endpoint-save-error" className="text-xs text-rose-700">{saveError}</p>}
          <div className="flex items-center gap-3">
            <button type="button" data-testid="endpoint-save" onClick={() => void save()} className="px-4 py-2 rounded-xl bg-ink text-white text-sm min-h-[44px] fine-pointer:min-h-0">Save endpoint</button>
            <button type="button" data-testid="endpoint-cancel" onClick={() => setEditing(undefined)} className="px-4 py-2 rounded-xl border border-ink/15 text-sm min-h-[44px] fine-pointer:min-h-0">Cancel</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmLoad}
        eyebrow="Detect context size"
        title="Load the model to read its context?"
        body={<p>Detecting may load {detectModel} on the server (llama-swap starts it to answer). That can take a while and uses its GPU memory.</p>}
        confirmLabel="Detect anyway"
        cancelLabel="Cancel"
        onConfirm={() => {
          setConfirmLoad(false);
          void runDetect(true);
        }}
        onClose={() => setConfirmLoad(false)}
      />
    </div>
  );
}
```

`src/components/model-settings-form.tsx` — after `GROUP_SERVER_CONFIG` (`:57-63`):

```tsx
const GROUP_ANALYZER_ENDPOINTS: ConfigGroup = {
  id: 'model-analyzer-endpoints',
  label: 'Analyzer endpoints (OpenAI-compatible)',
  help: 'Your own OpenAI Chat Completions-compatible servers — llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter — used for analysis. Their models appear in every analysis-model picker once listed.',
  risk: 'low',
  collapsedByDefault: false,
};
```

`MODEL_SETTINGS_SECTIONS` (`:74-88`) — after the `GROUP_SERVER_CONFIG` entry: `{ id: GROUP_ANALYZER_ENDPOINTS.id, label: GROUP_ANALYZER_ENDPOINTS.label, risk: GROUP_ANALYZER_ENDPOINTS.risk },`. After `</SettingsSection>` of the Server configuration section (`:538`):

```tsx
      <SettingsSection group={GROUP_ANALYZER_ENDPOINTS} overriddenCount={0}>
        <AnalyzerEndpointsSection />
      </SettingsSection>
```

(import `AnalyzerEndpointsSection` from `./settings/analyzer-endpoints-section`.) The endpoints section saves on its own buttons; the form's "Save changes" does not include endpoints (they are refused by the general PUT).

- [ ] **Step 4: Run and confirm it passes**
Run: `npx vitest run src/components/settings/analyzer-endpoints-section.test.tsx src/components/model-settings-form.test.tsx` then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `validateEndpointDraft`: delete the `contextTokens` check → red: "refuses to save without a context size". Restore.
2. `validateEndpointDraft`: drop `&& !d.noKey` / the `hostChanged` key error → red: "editing the host with a saved key prompts for the key and blocks Save…". Restore.
3. `onDetect`: call `runDetect(true)` without the confirm → red: "a llama-swap Detect for a model asks before it may load the model…". Restore.
4. `set`: remove the `!d.gpuTouched` default → red: "GPU defaults to any for a loopback host and none for a remote host…". Restore.
5. `save`: write the key before the endpoint write → red: "creates the endpoint, then writes the typed key bound to the saved base URL". Restore.

- [ ] **Step 6: Commit**
```bash
git add src/components/settings/analyzer-endpoints-section.tsx src/components/settings/analyzer-endpoints-section.test.tsx src/components/model-settings-form.tsx src/components/model-settings-form.test.tsx
git commit -m "feat(frontend): Settings section for OpenAI-compatible analyzer endpoints"
```

---
### Task 3d.9: Playwright (mock mode) — add an endpoint, pick its model, GPU guard by card, host change asks for the key

**Files:**
- Modify: `src/lib/api.ts:8687-8698` (`mockGetConfig` merges `__SEED_CONFIG_VALUES__`)
- Create: `e2e/analyzer-endpoints.spec.ts`
- Test: `src/lib/api.config.test.ts` (extend)

**Interfaces:**
- Consumes: the Task 3d.7/3d.8 test ids; 3b's mock endpoint CRUD/key functions (they mutate `MOCK_USER_SETTINGS.analyzerEndpoints` and return the settings body with `analyzerEndpointKeyStatus`); Task 3c.6 seeds `__SEED_ENDPOINT_MODELS__`, `__SEED_ANALYZER_CAPABILITIES__`; `mockGetGpuDevices` default cards `cuda:0` "RTX 4070 Laptop", `cuda:1` "RTX 5070 Ti" (`api.ts:8616-8622`); `window.__store__` (`src/main.tsx:57`, e2e gate); `waitForRouteReady`, `stubAccountModelProbes` (`e2e/helpers.ts:91`, `:192`).
- Produces: `e2e/analyzer-endpoints.spec.ts`; `__SEED_CONFIG_VALUES__` seed for `mockGetConfig`.

Selectors verified against the components written in this plan (Tasks 3c.8, 3d.7, 3d.8) and the existing guard dialog copy (`use-local-analyzer-guard.tsx:100`, confirm/cancel labels `:114-115`). Detect is not exercised: it has no mock by design. "+ custom params" lands in wave 5 through `runLabelSuffixes`; the spec leaves a comment at that assertion, not an assertion.

Keeps green: `src/lib/api.config.test.ts`, e2e `advanced-settings.spec.ts`, `model-manager-analyzer-knobs.spec.ts`, `gpu-device-badge.spec.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/api.config.test.ts`:

```ts
import { mockGetConfig } from './api';

describe('mockGetConfig seed (#3084 e2e)', () => {
  it('merges __SEED_CONFIG_VALUES__ over the mock values', async () => {
    (globalThis as Record<string, unknown>).__SEED_CONFIG_VALUES__ = {
      'tts.kokoro.device': { key: 'tts.kokoro.device', effective: 'cuda:0', source: 'override', locked: false, overridden: true },
    };
    try {
      const res = await mockGetConfig();
      expect(res.values['tts.kokoro.device']?.effective).toBe('cuda:0');
    } finally {
      delete (globalThis as Record<string, unknown>).__SEED_CONFIG_VALUES__;
    }
  });
});
```

Create `e2e/analyzer-endpoints.spec.ts`:

```ts
/* #3084 W3d — OpenAI-compatible analyzer endpoints in mock mode (VITE_USE_MOCKS=true).
   Endpoint CRUD, keys, the catalog and the Test action are fulfilled in-process by the
   mock api layer; seeds arrive through window globals (see mockGetAnalyzerModels). */
import { test, expect, type Page } from '@playwright/test';
import { waitForRouteReady, stubAccountModelProbes } from './helpers';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await stubAccountModelProbes(page);
});

async function addEndpoint(page: Page, opts: { name: string; baseUrl: string; context: string; gpu?: string; key?: string }) {
  await page.getByTestId('add-endpoint').click();
  await page.getByTestId('endpoint-name').fill(opts.name);
  await page.getByTestId('endpoint-base-url').fill(opts.baseUrl);
  await page.getByTestId('endpoint-context-tokens').fill(opts.context);
  if (opts.gpu) await page.getByTestId('endpoint-gpu').selectOption(opts.gpu);
  if (opts.key) await page.getByTestId('endpoint-key').fill(opts.key);
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-editor')).toBeHidden();
}

test('add an endpoint (context required), pick its model, and the label shows "schema (not enforced)" from a Test record', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__SEED_ENDPOINT_MODELS__ = { 'lab-server': ['qwen3-30b'] };
    w.__SEED_ANALYZER_CAPABILITIES__ = {
      'openai:lab-server::qwen3-30b': {
        serverUrl: 'http://127.0.0.1:8080/v1',
        testedAt: '2026-09-11T10:00:00.000Z',
        control: { ok: true },
        structuredOutput: { schema: { configured: 'ignored' } },
        reasoning: {},
      },
    };
  });
  await page.goto('/#/models');
  await waitForRouteReady(page);

  await page.getByTestId('add-endpoint').click();
  await page.getByTestId('endpoint-name').fill('Lab server');
  await page.getByTestId('endpoint-base-url').fill('http://127.0.0.1:8080/v1');
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-context-error')).toBeVisible();
  await page.getByTestId('endpoint-context-tokens').fill('32768');
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-row-lab-server')).toBeVisible();

  const picker = page.getByTestId('account-default-analysis-model');
  await expect(picker.locator('option[value="openai:lab-server::qwen3-30b"]')).toHaveCount(1);
  await picker.selectOption('openai:lab-server::qwen3-30b');
  const label = page.getByTestId('analyzer-default-model-label');
  await expect(label).toContainText('Lab server · qwen3-30b');
  await expect(label).toContainText('schema (not enforced)');
  // Wave 5 appends "+ custom params" through runLabelSuffixes; asserted there, not here.
});

test('the GPU guard prompts for an endpoint on the TTS card and not for one on another card', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__SEED_CONFIG_VALUES__ = {
      'tts.kokoro.device': { key: 'tts.kokoro.device', effective: 'cuda:0', source: 'override', locked: false, overridden: true },
    };
    w.__SEED_ENDPOINT_MODELS__ = { 'same-card': ['m0'], 'other-card': ['m1'] };
  });
  await page.goto('/#/advanced');
  await waitForRouteReady(page);
  await expect(page.getByRole('button', { name: 'Reset all' })).toBeVisible();
  await page.goto('/#/models');
  await waitForRouteReady(page);

  await addEndpoint(page, { name: 'Same card', baseUrl: 'http://127.0.0.1:8080/v1', context: '8192', gpu: 'cuda:0' });
  await addEndpoint(page, { name: 'Other card', baseUrl: 'http://127.0.0.1:8081/v1', context: '8192', gpu: 'cuda:1' });

  await page.evaluate(() => {
    const w = window as unknown as { __store__: { dispatch: (a: unknown) => void } };
    w.__store__.dispatch({
      type: 'chapters/setActiveStream',
      payload: { streamKey: 'b1::1', bookId: 'b1', chapterId: 1, modelKey: 'kokoro-v1', done: 0, total: 3, inProgress: 1, lastTickAt: Date.now(), halted: false },
    });
  });

  await page.getByTestId('model-test-openai:same-card::m0').click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByText('Pause audio generation to analyse?')).toBeVisible();
  await page.getByRole('button', { name: 'Wait' }).click();
  await expect(page.getByTestId('model-test-result-openai:same-card::m0')).toHaveCount(0);

  await page.getByTestId('model-test-openai:other-card::m1').click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByText('Pause audio generation to analyse?')).toHaveCount(0);
  await expect(page.getByTestId('model-test-result-openai:other-card::m1')).toContainText('tested');
});

test('editing the host of an endpoint with a saved key asks for the key again', async ({ page }) => {
  await page.goto('/#/models');
  await waitForRouteReady(page);
  await addEndpoint(page, { name: 'Keyed', baseUrl: 'http://127.0.0.1:8080/v1', context: '8192', key: 'sk-test' });

  await page.getByTestId('endpoint-edit-keyed').click();
  await page.getByTestId('endpoint-base-url').fill('http://10.0.0.5:8080/v1');
  await expect(page.getByTestId('endpoint-key-reentry')).toBeVisible();
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-editor')).toBeVisible();

  await page.getByTestId('endpoint-key').fill('sk-new');
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-editor')).toBeHidden();
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npx vitest run src/lib/api.config.test.ts` and `npx playwright test --project=chromium e2e/analyzer-endpoints.spec.ts`
Expected: FAIL — the seed is ignored (`expected 'auto'`/`undefined` to be `'cuda:0'`); in the GPU spec the other-card Test prompts (TTS card unknown → fail closed) and the result never appears.

- [ ] **Step 3: Implement** — `src/lib/api.ts:8689-8697`, `mockGetConfig`'s `values` line becomes:

```ts
    values: {
      ...MOCK_CONFIG_VALUES,
      ...((globalThis as unknown as { __SEED_CONFIG_VALUES__?: ConfigValues }).__SEED_CONFIG_VALUES__ ?? {}),
    },
```

(add `ConfigValues` to the file's `./types` type import if absent).

- [ ] **Step 4: Run and confirm they pass**
Run: `npx vitest run src/lib/api.config.test.ts`, `npx playwright test --project=chromium e2e/analyzer-endpoints.spec.ts`, then `npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. `analyzerSharesTtsDevice` (Task 3d.6): return `true` for every `openai` input → red: "the GPU guard prompts for an endpoint on the TTS card and not for one on another card". Restore.
2. `AnalyzerEndpointsSection` `hostChanged`: return `false` → red: "editing the host of an endpoint with a saved key asks for the key again". Restore.
3. `model-settings-form.tsx`: render `analyzerModelLabel(defaultAnalysisModel, account.analyzerCatalog)` without `runLabelSuffixes` → red: the first spec ("schema (not enforced)"). Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/api.ts src/lib/api.config.test.ts e2e/analyzer-endpoints.spec.ts
git commit -m "test(e2e): analyzer endpoints — add, pick, card-aware guard, key re-entry"
```

---

### Task 3d.10: On-box acceptance — extend "Live structured output", add "Long silent prefill" and "Same-card eviction"

**Files:**
- Modify: `docs/testing/onbox-acceptance-register.md` (the 3c row, two new Group A rows, the glance count, the owed line, a Last-change note, the Group A `next-id` marker)
- Modify: `docs/testing/openai-analyzer-onbox-acceptance.md` (created in 3c)
- Modify: `docs/testing/onbox-acceptance-register-live-view.html`

Row ids are minted at ship time from Group A's `<!-- next-id: A… -->` marker (bump it once per row in the same commit); below, `‹row-3c›` is the id PR 3c minted, `‹A-new-1›`/`‹A-new-2›` the two ids minted here.

- [ ] **Step 1: Extend the 3c row** — append to `### ‹row-3c› · Live structured output — Test action`:

```markdown
**Extended by PR #NNNN (#3084 W3d — endpoints selectable).** Also run a real chapter in
`schema` mode on the llama-swap endpoint (thinking on, then off), on a `gemma-*` and on a
`gemini-*` model, and record: conformance of each response against the Test record
(`enforced` runs must never need the validation retry for missing required keys), Gemini
`schema` attribution quality against `json` on the same chapter. This row gates Gemini's
`schema` default.
```

- [ ] **Step 2: Add two rows to Group A**

```markdown
### ‹A-new-1› · Long silent prefill completes on an endpoint ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), PR #NNNN) · **slower card of a 2-card box, llama-swap with a ≥64k-context model**

The OpenAI transport starts its idle watchdog only after the first delta and bounds the
call with the endpoint's request ceiling (default 30 min). Automated tests use a fake
server; only a real prefill of a very long prompt shows that no timeout, retry or cloud
fallback fires before the first token.

- Add the llama-swap endpoint with `gpu` = the slower card, context ≥ 64k, and analyse a
  chapter whose stage-1 prompt exceeds 64k tokens.
- Observe the server log: no `analyzer-timeout`, no idle retry, no fallback announcement;
  the chapter completes. Record time to first token and total time.
- Criteria: `docs/testing/openai-analyzer-onbox-acceptance.md` § "Long silent prefill".

### ‹A-new-2› · Same-card eviction of an endpoint for a Qwen load ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), PR #NNNN) · **2-card boot (8 GB + 16 GB), llama-swap with a per-model unload URL, Qwen TTS**

`withCapacityRetry` POSTs the unload URL of every endpoint on the denied card (or `any`),
with the same once-per-call latch and in-flight gate as Ollama. Unit tests inject the
eviction; only real VRAM shows the card actually frees.

- Endpoint `gpu` = `cuda:N` (the card Qwen targets), unload URL
  `http://127.0.0.1:<port>/api/models/unload/{model}`, one analysis call made first (so a
  last-used model exists). With analysis idle, load Qwen on that card: the log shows the
  unload POST, capacity is re-probed, Qwen loads — no out-of-memory.
- Pin Qwen to the other card: no unload POST.
- Start an analysis on the endpoint, then trigger a Qwen load on its card: no unload POST;
  the reverse guard prompts on Resume/Regenerate.
- Remove the unload URL and repeat step 1: the failure message names "Unload URL".
- Criteria: `docs/testing/openai-analyzer-onbox-acceptance.md` § "Same-card eviction".
```

Update the glance table's Group A count (+2), prepend a `> **Last change: <date> (#3084 W3d), <owed> → <owed + 2>.**` note naming both rows and the extension, bump the marker twice, run `npm run register:build` and copy its owed total into the `**NN owed.**` line if it differs.

- [ ] **Step 3: Run sheet** — append to `docs/testing/openai-analyzer-onbox-acceptance.md`:

```markdown
## Live structured output — real chapters (added in W3d)

5. Pick the llama-swap model as the per-run model; analyse one chapter with thinking on,
   then off (`chat_template_kwargs` / server config). Result:
6. Same chapter on `gemma-4-31b-it` and `gemini-3.6-flash` in `schema`, then `json`
   (Advanced → `analyzer.gemini.structuredOutput`). Compare attributions. Result:

## Long silent prefill

1. Endpoint on the slower card, context ≥ 64k; chapter whose stage-1 prompt > 64k tokens.
2. Time to first token: ___  Total: ___  Timeouts/retries/fallbacks in the log: ___
   Result:

## Same-card eviction

1. Qwen on the endpoint's card, analysis idle → unload POST logged, Qwen loaded. Result:
2. Qwen on the other card → no unload POST. Result:
3. Analysis running on the endpoint → no unload POST; Resume prompts. Result:
4. Unload URL removed → NoCapacityError text names "Unload URL". Result:
```

- [ ] **Step 4: Live view** — after the 3c row's `</details>`, insert one block per new row, same markup:

```html
    <details class="item">
      <summary><span class="num">‹A-new-1›</span><span class="iname">Long silent prefill completes on an endpoint</span><span class="risk">slower card of a 2-card box, llama-swap with a ≥64k-context model</span><span class="chev">›</span></summary>
      <div class="body">
        <p>A chapter whose prompt exceeds 64k tokens on a llama-swap endpoint on the slower card completes within the request ceiling: no timeout, idle retry or fallback. Record time to first token and total time.</p>
        <p>Criteria: <code>docs/testing/openai-analyzer-onbox-acceptance.md</code> § Long silent prefill. #3084.</p>
      </div>
    </details>
    <details class="item">
      <summary><span class="num">‹A-new-2›</span><span class="iname">Same-card eviction of an endpoint for a Qwen load</span><span class="risk">2-card boot, llama-swap per-model unload URL, Qwen TTS</span><span class="chev">›</span></summary>
      <div class="body">
        <p>With analysis idle, a Qwen load on the endpoint's card POSTs its unload URL and succeeds; a load on the other card does not; during a run nothing is unloaded and the guard prompts; without an unload URL the failure names the setting.</p>
        <p>Criteria: <code>docs/testing/openai-analyzer-onbox-acceptance.md</code> § Same-card eviction. #3084.</p>
      </div>
    </details>
```

and append the W3d paragraph to the 3c row's `<div class="body">`. Run `npm run register:build`, `npm run check:onbox-register`, save the live page from the register header's URL and run `npm run check:onbox-register -- --against-published <file>`; publish `docs/testing/onbox-acceptance-register-live-view.html` to that URL (Artifact tool, `url` set) only when it passes.

- [ ] **Step 5: Commit**
```bash
git add docs/testing/onbox-acceptance-register.md docs/testing/openai-analyzer-onbox-acceptance.md docs/testing/onbox-acceptance-register-live-view.html
git commit -m "docs(docs): on-box rows for endpoint prefill, same-card eviction and live structured output"
```

---

### Task 3d.11: Ship PR 3d

- [ ] **Step 1: Derived artifacts** — `npm run openapi:types` (commit any diff), `npm run typecheck`, `npm run check:cycles`, `npm run config:check` (Task 3d.4 changed the `analyzer.engine` options; run `npm run config:sync` if the managed block changed).

- [ ] **Step 2: Release notes**

`docs/release-notes-next.md`:

```markdown
- **OpenAI-compatible analyzer endpoints are selectable** (#3084, W3d). Model Manager → Analyzer endpoints adds, edits and deletes named servers (llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter) with a required served context size (List models prefill from `max_model_len` / `meta.n_ctx` / `context_length`; on-demand Detect with a "may load the model" confirmation for llama-swap), an origin-bound API key that must be re-entered when the host changes, a GPU card (`none` / `any` / `cuda:N`, loopback hosts default to `any`), an optional same-origin unload URL with `{model}` substitution, concurrency, request ceiling and structured-output mode. `selectAnalyzer` builds `OpenAIAnalyzer` (Gemini fallback only on unreachable, under `allowCloudFallback`); `analysisEngine` accepts `openai`. Endpoint calls on a GPU count as analyzer calls in flight; TTS capacity admission unloads endpoints on the denied card (same latch and in-flight gate as Ollama, capacity re-probed after the POST, the failure message names the Unload URL setting). The forward/reverse GPU guards and the generation hold compare the endpoint's card with the TTS card and fail closed when either is unknown; pickers list endpoint models and run labels show the structured-output mode.
```

`RELEASE_NOTES.md`:

```markdown
- **Analyse with your own OpenAI-compatible server.** Point Castwright at llama.cpp, llama-swap, LM Studio, vLLM or OpenRouter, tell it which graphics card the server uses, and pick its models anywhere you choose an analysis model. Castwright asks before analysing on the card your voices are using, frees that card when a voice model needs it, and shows whether the model really follows its output format.
```

- [ ] **Step 3: Verify** — `npm run verify:fast:branch` and `npm run test:e2e`. Expected: green.

- [ ] **Step 4: Commit, push, PR**
```bash
git add docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): release notes for selectable analyzer endpoints"
git push -u origin feat/server,frontend-3084-w3d-selectable
```
PR title: `feat(server,frontend): OpenAI-compatible analyzer endpoints become selectable`. Body: `## Summary` (the Delivers list), `## Test plan` (every test file, each task's mutation-proof red output, the e2e run, the three on-box rows), `Refs #3084`, **Also fixed, found in passing:** 3a's compile-forced `step-defaults.tsx` narrowing removed; `getResolvedAnalysisEngine`'s stale "cannot yield openai" comment; `NoCapacityError` gained notes rather than mislabelling an endpoint as a loaded blocker; the seven `<optgroup key={g.engine}>` keys that would collide with two endpoint groups.

- [ ] **Step 5: Review gate** — `pr-review-gate` at depth `high` (multi-scope `server,frontend`); fold findings; merge only with cloud `verify.yml` green. Suggest `/compact` after merge.
