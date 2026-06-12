# Model Manager Ollama controls + "Voice engine" rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every installed Ollama model its own Load/Unload control in the Model Manager, and finish renaming user-facing "TTS" copy to "Voice engine" across the app, server/sidecar error text, and docs.

**Architecture:** Two independent changes on one branch. Part A threads an optional `{ model }` through the `POST /api/ollama/{load,unload}` routes and the `api.loadAnalyzer`/`unloadAnalyzer` client wrappers, flips the Model Manager pill gate from "default analyzer only" to "every analyzer row", and makes a no-model unload evict ALL resident Ollama models (closing a co-residency OOM gap). Part B is a careful, sense-by-sense copy sweep that preserves every load-bearing token matched by detection logic.

**Tech Stack:** Vite + React 18 + TS (frontend), Express + Vitest (server), pytest (Python sidecar), Playwright (e2e). Spec: `docs/superpowers/specs/2026-06-12-model-manager-ollama-voice-engine-design.md`.

**Branch:** `feat/frontend-model-manager-ollama-controls` (already cut from `main`).

**Reference facts (verified against code):**
- `express.json` is global (`server/src/index.ts:120`) — routes can read `req.body`.
- `probeOllamaHealth()` (`ollama-health.ts:77`) already returns `resident: string[]` from `/api/ps` — reuse it for evict-all.
- Ollama tags contain colons (`qwen3.5:4b`); parse the model id with `slice('ollama:'.length)`, never `split(':')`.
- Detection invariants to PRESERVE in Part B (never delete these tokens): `unreachable`, `stopped responding`, `did not complete within`, `RecycleStormError`, `recycled N×`, `"poisoned":true`, `ECONNREFUSED`, `fetch failed`, `sidecar not reachable`.

---

## Part A — Per-model Ollama Load/Unload

### Task 1: `/api/ollama/load` accepts an optional `{ model }`

**Files:**
- Modify: `server/src/routes/ollama-health.ts:226-244`
- Test: `server/src/routes/ollama-health.test.ts` (the `POST /api/ollama/load` describe at :138)

- [ ] **Step 1: Write the failing test** — add inside the existing `describe('POST /api/ollama/load')`:

```ts
it('targets the model from the request body when provided, still threading num_ctx/num_gpu', async () => {
  fetchMock.mockResolvedValue(new Response('', { status: 200 }));

  const res = await request(makeApp())
    .post('/api/ollama/load')
    .send({ model: 'llama3.1:8b' });

  expect(res.status).toBe(200);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.model).toBe('llama3.1:8b');
  expect(body.keep_alive).toBe('5m');
  expect(body.options?.num_ctx).toBe(16384);
  expect(body.options?.num_gpu).toBe(999);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts -t "targets the model from the request body"`
Expected: FAIL — `body.model` is the configured default (`qwen3.5:4b`), not `llama3.1:8b`.

- [ ] **Step 3: Implement** — change the `/load` handler signature + model resolution:

```ts
ollamaHealthRouter.post('/load', async (req: Request, res: Response) => {
  const url = getResolvedOllamaUrl();
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const model = requested || getResolvedOllamaModel();
  const result = await callOllamaGenerate(
    url,
    {
      model,
      prompt: '',
      keep_alive: '5m',
      stream: false,
      options: { num_ctx: resolveAnalyzerNumCtx(), num_gpu: resolveAnalyzerNumGpu() },
    },
    LOAD_TIMEOUT_MS,
  );
  if (!result.ok) {
    return res.status(result.status).json({ status: 'error', error: result.error });
  }
  return res.json({ status: 'ready' });
});
```

- [ ] **Step 4: Run the load tests, verify green**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts -t "POST /api/ollama/load"`
Expected: PASS (the new test + the two existing no-body tests, which still resolve to the default).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ollama-health.ts server/src/routes/ollama-health.test.ts
git commit -m "feat(server): /api/ollama/load accepts an explicit model target"
```

---

### Task 2: `/api/ollama/unload` — explicit model OR evict all resident

**Files:**
- Modify: `server/src/routes/ollama-health.ts:249-261`
- Test: `server/src/routes/ollama-health.test.ts` (the `POST /api/ollama/unload` describe at :179)

- [ ] **Step 1: Write the failing tests** — replace the existing `'POSTs /api/generate with keep_alive: 0…'` test body and add a second:

```ts
it('evicts a single model when one is named in the body', async () => {
  fetchMock.mockResolvedValue(new Response('', { status: 200 }));

  const res = await request(makeApp())
    .post('/api/ollama/unload')
    .send({ model: 'llama3.1:8b' });

  expect(res.status).toBe(200);
  // exactly one /api/generate eviction, for that model
  const genCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/generate'));
  expect(genCalls).toHaveLength(1);
  const body = JSON.parse(genCalls[0][1].body);
  expect(body.model).toBe('llama3.1:8b');
  expect(body.keep_alive).toBe(0);
});

it('with no model, evicts EVERY resident model reported by /api/ps', async () => {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith('/api/tags')) {
      return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    }
    if (String(url).endsWith('/api/ps')) {
      return Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: 'qwen3.5:4b' }, { name: 'llama3.1:8b' }] }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('', { status: 200 })); // /api/generate
  });

  const res = await request(makeApp()).post('/api/ollama/unload');

  expect(res.status).toBe(200);
  const evicted = fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith('/api/generate'))
    .map((c) => JSON.parse(c[1].body).model);
  expect(evicted.sort()).toEqual(['llama3.1:8b', 'qwen3.5:4b']);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts -t "POST /api/ollama/unload"`
Expected: FAIL — the no-body path currently evicts only the configured default; the evict-all test sees one call, not two.

- [ ] **Step 3: Implement** — rewrite the `/unload` handler:

```ts
ollamaHealthRouter.post('/unload', async (req: Request, res: Response) => {
  const url = getResolvedOllamaUrl();
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  // Explicit model → evict just that one. No model → evict every resident
  // model (so the TTS auto-evict path frees ALL analyzer VRAM, not just the
  // configured default — a manually-warmed non-default model would otherwise
  // stay co-resident and OOM the GPU).
  const targets = requested ? [requested] : (await probeOllamaHealth()).resident ?? [];
  for (const model of targets) {
    const result = await callOllamaGenerate(
      url,
      { model, prompt: '', keep_alive: 0, stream: false },
      PROBE_TIMEOUT_MS,
    );
    if (!result.ok) {
      return res.status(result.status).json({ status: 'error', error: result.error });
    }
  }
  return res.json({ status: 'unloaded', unloaded: targets });
});
```

- [ ] **Step 4: Run, verify green**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts -t "POST /api/ollama/unload"`
Expected: PASS. Note the existing `'returns 503 when Ollama is unreachable'` test sends no body — `probeOllamaHealth()` will return `resident: []` (its fetch is rejected), so `targets` is empty and the route returns `{status:'unloaded', unloaded:[]}` with status 200. **Update that test** to send an explicit model so it still exercises the upstream-error path:

```ts
const res = await request(makeApp()).post('/api/ollama/unload').send({ model: 'qwen3.5:4b' });
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ollama-health.ts server/src/routes/ollama-health.test.ts
git commit -m "feat(server): /api/ollama/unload evicts a named model, or all resident when none given"
```

---

### Task 3: `api.ts` — thread `{ model }`, add a 2nd mock Ollama model, per-model residency

**Files:**
- Modify: `src/lib/api.ts` — `realLoadAnalyzer`/`realUnloadAnalyzer` (:5491-5503), `mockLoadAnalyzer`/`mockUnloadAnalyzer` (:5541-5551), the `MOCK_OLLAMA_MODEL_LOADED` flag (:5458), the mock inventory ollama row (:5407-5419), `mockGetOllamaHealth` resident (≈:5561), and the `Api` interface signatures for `loadAnalyzer`/`unloadAnalyzer`.

- [ ] **Step 1: Update the real wrappers to accept a model**

```ts
async function realLoadAnalyzer(opts: { model?: string } = {}): Promise<ModelControlResult> {
  const res = await fetch('/api/ollama/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.model ? { model: opts.model } : {}),
  });
  return (await res
    .json()
    .catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}

async function realUnloadAnalyzer(opts: { model?: string } = {}): Promise<ModelControlResult> {
  const res = await fetch('/api/ollama/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.model ? { model: opts.model } : {}),
  });
  return (await res
    .json()
    .catch(() => ({ status: 'error', error: `HTTP ${res.status}` }))) as ModelControlResult;
}
```

- [ ] **Step 2: Replace the single mock boolean with a resident Set** — replace `let MOCK_OLLAMA_MODEL_LOADED = false;` (:5458) with:

```ts
/* Per-model residency for the mock analyzer rows so the Model Manager's
   Load/Stop pills round-trip independently under VITE_USE_MOCKS=true. Starts
   with the default model resident, mirroring the inventory's loaded:true. */
const MOCK_OLLAMA_RESIDENT = new Set<string>(['qwen3.5:4b']);
```

- [ ] **Step 3: Update the mock load/unload to mutate the Set**

```ts
async function mockLoadAnalyzer(opts: { model?: string } = {}): Promise<ModelControlResult> {
  await wait(60);
  MOCK_OLLAMA_RESIDENT.add(opts.model ?? 'qwen3.5:4b');
  return { status: 'ready' };
}

async function mockUnloadAnalyzer(opts: { model?: string } = {}): Promise<ModelControlResult> {
  await wait(40);
  if (opts.model) MOCK_OLLAMA_RESIDENT.delete(opts.model);
  else MOCK_OLLAMA_RESIDENT.clear();
  return { status: 'unloaded' };
}
```

- [ ] **Step 4: Add a 2nd, non-default mock Ollama row and derive `loaded` from the Set** — in the mock inventory items array, replace the single `ollama:qwen3.5:4b` entry (:5407-5419) with two entries:

```ts
      {
        id: 'ollama:qwen3.5:4b',
        kind: 'analyzer',
        label: 'qwen3.5:4b',
        present: true,
        sizeBytes: 2_600_000_000,
        diskPath: null,
        loaded: MOCK_OLLAMA_RESIDENT.has('qwen3.5:4b'),
        isDefaultEngine: true,
        isFallbackEngine: false,
        removable: true,
        updatable: true,
      },
      {
        id: 'ollama:llama3.1:8b',
        kind: 'analyzer',
        label: 'llama3.1:8b',
        present: true,
        sizeBytes: 4_700_000_000,
        diskPath: null,
        loaded: MOCK_OLLAMA_RESIDENT.has('llama3.1:8b'),
        isDefaultEngine: false,
        isFallbackEngine: false,
        removable: true,
        updatable: true,
      },
```

- [ ] **Step 5: Wire mock Ollama health residency to the Set** — find `mockGetOllamaHealth` (≈:5561) and change its `resident`/`modelResident` to read the Set:

```ts
    resident: Array.from(MOCK_OLLAMA_RESIDENT),
    modelResident: MOCK_OLLAMA_RESIDENT.has('qwen3.5:4b'),
```

Also update `mockRemoveModel` (:5436): the loaded guard for `ollama:qwen3.5:4b` should read the Set so an unloaded default can be removed — change the hard-coded `model-loaded` return to `if (id === 'ollama:qwen3.5:4b' && MOCK_OLLAMA_RESIDENT.has('qwen3.5:4b')) return { ok:false, code:'model-loaded', error:'qwen3.5:4b is loaded.' };`

- [ ] **Step 6: Update the `Api` interface** — find the `loadAnalyzer` / `unloadAnalyzer` signatures in the `Api`/`type` block and change to:

```ts
  loadAnalyzer: (opts?: { model?: string }) => Promise<ModelControlResult>;
  unloadAnalyzer: (opts?: { model?: string }) => Promise<ModelControlResult>;
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no callers break — existing `api.unloadAnalyzer()` / `loadAnalyzer()` no-arg calls still satisfy the optional param).

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): analyzer load/unload accept a model; mock per-model residency + 2nd ollama model"
```

---

### Task 4: Model Manager — pill on every Ollama row, sliced model name, per-kind unreachable

**Files:**
- Modify: `src/views/model-manager.tsx:294-315`
- Modify: `src/components/ModelControlPill.tsx:172` (button aria-label, A4)
- Test: `src/views/model-manager.test.tsx`

- [ ] **Step 1: Write the failing test** — add to `model-manager.test.tsx` (mirror the existing inventory-mocking pattern in that file; the helper that stubs `api.getModelInventory` returns an items array — include a non-default analyzer row):

```ts
it('shows a Load/Unload pill on a NON-default Ollama row and calls the API with that model', async () => {
  const loadSpy = vi.fn().mockResolvedValue({ status: 'ready' });
  // stub api.getModelInventory to return a non-default, not-loaded ollama row
  // (follow the file's existing mock-inventory helper) with:
  //   { id: 'ollama:llama3.1:8b', kind: 'analyzer', label: 'llama3.1:8b',
  //     present: true, loaded: false, isDefaultEngine: false, sizeBytes: 1,
  //     diskPath: null, isFallbackEngine: false, removable: true, updatable: true }
  // and api.loadAnalyzer = loadSpy, sidecarReachable: true.
  renderModelManager();
  const row = await screen.findByTestId('model-row-ollama:llama3.1:8b');
  const loadBtn = within(row).getByRole('button', { name: /load model/i });
  fireEvent.click(loadBtn);
  await waitFor(() => expect(loadSpy).toHaveBeenCalledWith({ model: 'llama3.1:8b' }));
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run src/views/model-manager.test.tsx -t "NON-default Ollama row"`
Expected: FAIL — no pill renders on a non-default analyzer row (`hasControl` is false), so the button query throws.

- [ ] **Step 3: Implement the gate + model threading** — in `ModelRow` (`model-manager.tsx`), replace lines 296-315:

```ts
  const engine = TTS_ENGINE_BY_ID[item.id];
  const isAnalyzer = item.kind === 'analyzer';
  /* A Load/Unload pill is meaningful for the sidecar TTS engines and for every
     installed Ollama analyzer model (all analyzer rows are Ollama; cloud Gemini
     is not a disk artifact and never appears in the inventory). */
  const hasControl = item.present && (engine !== undefined || isAnalyzer);

  /* Analyzer residency depends on the Ollama daemon, not the TTS sidecar — an
     unreachable daemon already yields zero analyzer rows, so analyzer rows are
     never 'unreachable' here. Only TTS rows gate on sidecar reachability. */
  const reachable = isAnalyzer ? true : sidecarReachable;
  const controlState: ModelControlState = !reachable
    ? 'unreachable'
    : busy
      ? 'loading'
      : item.loaded
        ? 'ready'
        : 'idle';
  const controlKind: ModelKind = isAnalyzer ? 'analyzer' : 'tts';

  /* Ollama tags contain colons (ollama:qwen3.5:4b) — slice the prefix, never
     split(':'). Mirrors performRemoval in models-inventory.ts. */
  const analyzerModel = isAnalyzer ? item.id.slice('ollama:'.length) : undefined;
  const doLoad = () =>
    onAction(() =>
      engine ? api.loadSidecar({ engine }) : api.loadAnalyzer(analyzerModel ? { model: analyzerModel } : undefined),
    );
  const doStop = () =>
    onAction(() =>
      engine ? api.unloadSidecar({ engine }) : api.unloadAnalyzer(analyzerModel ? { model: analyzerModel } : undefined),
    );
```

- [ ] **Step 4: A4 — thread engineLabel into the button aria** — in `ModelControlPill.tsx:172`, change the button `aria-label`:

```tsx
        aria-label={`${action.label} (${engineLabel ?? kindNoun(kind)})`}
```

- [ ] **Step 5: Run, verify green**

Run: `npx vitest run src/views/model-manager.test.tsx`
Expected: PASS (new test + existing Model Manager tests).

- [ ] **Step 6: Commit**

```bash
git add src/views/model-manager.tsx src/components/ModelControlPill.tsx src/views/model-manager.test.tsx
git commit -m "feat(frontend): Load/Unload pill on every Ollama model in the Model Manager"
```

---

### Task 5: e2e — drive Load/Unload on a non-default Ollama row (mock mode)

**Files:**
- Modify: `e2e/model-manager-dual-model.spec.ts` (add a case) OR Create: `e2e/model-manager-ollama-load.spec.ts`

- [ ] **Step 1: Write the spec** (model on the existing model-manager spec's navigation to `#/models`):

```ts
import { test, expect } from '@playwright/test';

test('loads and unloads a non-default Ollama model from the Model Manager', async ({ page }) => {
  await page.goto('/#/models');
  const row = page.getByTestId('model-row-ollama:llama3.1:8b');
  await expect(row).toBeVisible();
  // starts not resident
  await expect(row).toHaveAttribute('data-loaded', 'false');
  await row.getByRole('button', { name: /load model/i }).click();
  await expect(row).toHaveAttribute('data-loaded', 'true');
  await row.getByRole('button', { name: /stop/i }).click();
  await expect(row).toHaveAttribute('data-loaded', 'false');
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- model-manager-ollama-load`
Expected: PASS. (If the inventory poll cadence makes the assertion racy, the `onAction` refetch already runs after each click — assert on `data-loaded` which the row already exposes.)

- [ ] **Step 3: Commit**

```bash
git add e2e/
git commit -m "test(e2e): Load/Unload a non-default Ollama model in the Model Manager"
```

---

## Part B — "TTS" → "Voice engine" copy sweep

Apply the mapping by sense (see spec): "TTS sidecar"/"TTS engine"/"TTS model" → "voice engine"; "TTS voice" → "voice"; "Loading TTS…" → "Loading voice engine…". **Capitalize to match context.** Touch only user-visible strings — never identifiers, type/field names, OpenAPI `description:`, or comments.

### Task 6: App-rendered strings + paired tests

**Files (exact strings):**
- `src/components/ModelControlPill.tsx:118` — `kindNoun`: `return kind === 'tts' ? 'TTS model' : 'Analyzer';` → `'Voice engine'`.
- `src/modals/profile-drawer.tsx` — the `<label>` "TTS engine for this character" → "Voice engine for this character"; `:1733` `'Loading TTS model (~30s)…'` → `'Loading voice engine (~30s)…'`; `:1271` "…the TTS voice line above…" → "…the voice line above…".
- `src/views/generation.tsx` — `:1421` "Recovering — restarting TTS engine…" → "Recovering — restarting voice engine…"; `:925` "The TTS engine may be synthesising…" → "The voice engine may be synthesising…"; `:935` "…current TTS model." → "…current voice engine."
- `src/modals/queue-modal.tsx:549` — `'Mixes TTS engines. Turn on "Keep both TTS engines loaded"…'` → `'Mixes voice engines. Turn on "Keep both voice engines loaded"…'`.
- `src/views/voices.tsx` — `:903`/`:927` `'Loading TTS…'` → `'Loading voice engine…'`; `:1944` "switch your TTS model to assign these" → "switch your voice engine to assign these".
- `src/data/help-topics.ts` — `:16`/`:36`/`:38` "TTS sidecar" → "voice engine" (visible help copy).
- `src/data/help-failures.ts:17` — `'recycle-storm': 'TTS engine keeps restarting'` → `'Voice engine keeps restarting'`.
- `src/components/model-settings-form.tsx` — scan for any remaining visible "TTS" (the engine sub-label is already "voice engine"; confirm nothing visible says "TTS").

**Paired test/fixture updates (same commit):**
- `src/data/help-failures.test.ts` — the recycle-storm title pin.
- `src/modals/profile-drawer.test.tsx:1047` — `getByLabelText('TTS engine for this character')` → `'Voice engine for this character'`.
- `src/views/generation.test.tsx:416` — `'Recovering — restarting TTS engine…'` → `'Recovering — restarting voice engine…'`.
- `src/views/model-manager.test.tsx:274` — `describe('… — TTS sidecar preferences')` → "voice engine preferences" (cosmetic).
- e2e: `e2e/cast.spec.ts:44`, `e2e/voice-design-progress.spec.ts:64`, `e2e/single-voice-design-background.spec.ts:57` — the `getByLabel('TTS engine for this character')` query.

- [ ] **Step 1: Grep the live surface to catch stragglers**

Run: `npx rg -n "TTS (sidecar|engine|model|voice)|Loading TTS" src e2e`
Cross-check every hit against the list above; visible string → rename, comment/identifier/api-types → leave.

- [ ] **Step 2: Apply the renames** to the source files listed above (visible strings only).

- [ ] **Step 3: Apply the paired test/fixture updates** so the asserted copy matches.

- [ ] **Step 4: Run the affected unit suites**

Run: `npm run test -- src/data/help-failures.test.ts src/views/generation.test.tsx src/modals/profile-drawer.test.tsx src/views/model-manager.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ e2e/
git commit -m "refactor(frontend): rename user-facing TTS copy to 'voice engine'"
```

---

### Task 7: Server + sidecar user-facing error text

**INVARIANT (must hold):** change only the "TTS sidecar"/"TTS engine"/"TTS model" prose. Preserve every token detection logic matches: `unreachable`, `stopped responding`, `did not complete within`, `RecycleStormError`, `recycled N×`, `"poisoned":true`, `ECONNREFUSED`, `fetch failed`, `sidecar not reachable`. (Verified: `cast-design.ts:94` `SIDECAR_DOWN_RE` and `failure-taxonomy.ts` signatures key only on those tokens, never on "TTS".)

**Files (exact strings):**
- `server/tts-sidecar/main.py` — `:2815`/`:3118`/`:3218`/`:3318` `"TTS sidecar is recycling to free memory; retry shortly."` → `"Voice engine is recycling to free memory; retry shortly."`; `:3102`/`:3209`/`:3303` `"TTS sidecar is in a poisoned CUDA state…"` → `"Voice engine is in a poisoned CUDA state…"` (keep the surrounding `"poisoned": true` JSON field untouched).
- `server/src/routes/chapter-splice.ts:122` — "modelKey must be a supported TTS model id for a re-record." → "…supported voice-engine model id…".
- `server/src/routes/chapter-qa-repair.ts:209` — "modelKey must be a supported TTS model id to repair." → "…supported voice-engine model id…".
- Locate the "TTS sidecar (…) is unreachable" / "stopped responding to /health during voice design." producers (grep `server/src` for `is unreachable` / `stopped responding`); rename the "TTS sidecar" prefix → "Voice engine", **keeping** "unreachable"/"stopped responding".

**Paired test updates (same commit):**
- `server/src/routes/failure-taxonomy.test.ts:96` and `server/src/routes/generation-error.test.ts:143` and `server/src/tts/synthesise-chapter.test.ts:563` — the poisoned-state prose.
- `server/src/tts/ensure-sidecar-loaded.test.ts:76` — the recycling prose.
- `server/src/routes/cast-design.test.ts:270`/`:304` — the "TTS sidecar … unreachable / stopped responding" prose.
- `src/store/chapters-slice.test.ts:523` — the `errorReason: 'TTS sidecar timed out'` fixture → "Voice engine timed out".
- Sidecar pytest: grep `server/tts-sidecar/tests` for the recycling/poisoned prose and update any exact-string assertions.

- [ ] **Step 1: Grep server + sidecar for visible "TTS" error prose**

Run: `npx rg -n "TTS sidecar|TTS engine|TTS model" server/src server/tts-sidecar --glob '!**/*.test.ts'`
Classify each: visible message string → rename; comment/identifier → leave.

- [ ] **Step 2: Apply the renames** (source), preserving the INVARIANT tokens.

- [ ] **Step 3: Update the paired test assertions** listed above.

- [ ] **Step 4: Run the server + taxonomy + sidecar suites**

Run: `npm run test:server && npm run test:server-slow`
Run (if venv bootstrapped): `npm run test:sidecar`
Expected: PASS. If a failure-taxonomy test goes red, a detection token was dropped — restore it; only the "TTS" prose may change.

- [ ] **Step 5: Commit**

```bash
git add server/ src/store/chapters-slice.test.ts
git commit -m "refactor(server,sidecar): rename user-facing TTS error text to 'voice engine'"
```

---

### Task 8: Docs

**Files:**
- `README.md:47` — "TTS engines" → "Voice engines" (heading/prose).
- `INSTALL.md:247`/`:273`/`:282` — "Account → Defaults for new books → TTS engine" → the new UI label ("Voice engine").

- [ ] **Step 1: Apply the doc edits.**

- [ ] **Step 2: Commit**

```bash
git add README.md INSTALL.md
git commit -m "docs: rename 'TTS engine' to 'Voice engine' in README + INSTALL"
```

---

### Task 9: Full verification + plan/spec closeout

- [ ] **Step 1: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green. Triage any failure as related (fix here) vs pre-existing (surface to user, do not bundle).

- [ ] **Step 2: Update the spec status** — set the spec frontmatter `Status:` to "implemented" and add a one-line ship note (commit SHAs).

- [ ] **Step 3: Final commit + push the branch; open a draft PR**

```bash
git add docs/superpowers/specs/2026-06-12-model-manager-ollama-voice-engine-design.md
git commit -m "docs(docs): mark Model Manager Ollama + voice-engine spec implemented"
git push -u origin feat/frontend-model-manager-ollama-controls
gh pr create --draft --title "feat(frontend,server): per-model Ollama Load/Unload + 'Voice engine' rename" --body "<Summary + Test plan; links the spec>"
```

Run `npm run verify` until green, then `gh pr ready` for the single billed CI run.

---

## Self-review

**Spec coverage:** A1 evict-all (Task 2) ✓ · A2 second mock model (Task 3) ✓ · A3 slice-not-split (Task 4) ✓ · A4 button aria (Task 4) ✓ · per-kind unreachable (Task 4) ✓ · `{model}` through routes+api (Tasks 1-3) ✓ · pill on every analyzer row (Task 4) ✓ · e2e (Task 5) ✓ · Part B app strings (Task 6) ✓ · server/sidecar error text + INVARIANT (Task 7) ✓ · docs (Task 8) ✓ · verify (Task 9) ✓.

**Type consistency:** `loadAnalyzer`/`unloadAnalyzer` take `opts?: { model?: string }` in the real wrappers (Task 3 Step 1), mock wrappers (Task 3 Step 3), and the `Api` interface (Task 3 Step 6); callers in `model-manager.tsx` pass `{ model } | undefined` (Task 4 Step 3) — consistent. Route bodies read `req.body?.model` (Tasks 1-2) matching what the client POSTs (Task 3 Steps 1). `data-loaded` attribute used by the e2e spec (Task 5) already exists on `ModelRow` (`model-manager.tsx:321`).

**Placeholder scan:** no TBD/TODO; every code step shows the code; test steps give exact commands + expected outcomes. The two grep steps (Task 6 Step 1, Task 7 Step 1) are straggler-catchers over an enumerated list, not "decide later".
