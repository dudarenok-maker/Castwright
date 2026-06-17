# VRAM Telemetry Substrate (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passively measure real per-machine, per-variant VRAM footprints during normal usage (analyzer + all TTS modes) and persist them, with **no decision consuming the data yet** — the substrate that will earn the deferred MB-accounting engine (#845 v2).

**Architecture:** Revive two built, self-contained modules from branch `feat/server-dynamic-analyzer-models` (`model-vram-stats.ts` Ollama-`size_vram` sampler; `device-total.ts` boot nvidia-smi total-probe), wire the analyzer sampler **record-only** (NOT `keepAliveFor`), add an OOM-safe **absolute** `vram_reserved_mb`-at-peak sampler for the TTS engines **guarded by a clean-process gate** (`qwen:design` is sampled while VoiceDesign is resident; `qwen:synth`/`coqui` only from a process that has never loaded VoiceDesign — so the sticky reserved pool reflects that engine's true peak, not a stale design peak), and rotate the stats file on GPU-fingerprint change. Everything appends to one JSONL under `telemetryDir()`.

**Tech Stack:** TypeScript (Node ESM, `.js` suffixes), Vitest (node env), Express, Python (sidecar `/health`, pytest). Server tests: `npm run test:server` (root); sidecar: `npm run test:sidecar`.

## Global Constraints

- **Node ESM:** every relative import ends in `.js`. Source is `.ts`.
- **Spec:** `docs/superpowers/specs/2026-06-17-vram-telemetry-mb-accounting-design.md` (v1). **Issue:** #845 (`fs-45`).
- **Branch:** `feat/server-vram-telemetry-v1`, cut off current `main`. Do **NOT** merge the stale `feat/server-dynamic-analyzer-models` branch — port individual files only.
- **v1 records; it never decides.** No `costMb`/`planLoad`/`splitFits`, no `withGpuLoad` signature change, no route, no frontend. `keepAliveFor()` and the concurrency semaphore stay exactly as on `main`.
- **Sidecar change is ONE additive `/health` field** (`qwen_design_ever_loaded`) + its health-client mirror. No other sidecar behavior changes.
- **Best-effort telemetry:** every record/sample path is fire-and-forget; it MUST NOT throw into or block the analysis/synthesis path.
- **OOM-safety (TTS):** record the **absolute** `vram_reserved_mb` at an op's peak, never a before/after delta (absolute over-estimates — the safe direction). For `qwen:synth`/`coqui`, the **clean-process gate** prevents a prior design's sticky reserved pool from poisoning the synth pool.
- **Persisted file:** `telemetryDir()/model-vram-stats.jsonl` = `<WORKSPACE_ROOT>/.telemetry/model-vram-stats.jsonl`.
- **TEST ISOLATION (MANDATORY for every new/edited test that touches the telemetry file):** the telemetry modules resolve `WORKSPACE_ROOT` once at module-eval from `process.env.WORKSPACE_DIR` (confirmed: `server/src/workspace/paths.ts:28` reads `process.env.WORKSPACE_DIR`; `WORKSPACE_ROOT` is the derived const, not the env var). Vitest runs files in parallel forks, so every such test MUST set a unique workspace BEFORE importing the module. This is the plan's mandated shape (several server tests set `WORKSPACE_DIR` similarly, e.g. `server/src/cover/store.test.ts`, `server/src/routes/book-state.test.ts` — though they use a `resetModules`+`doMock` variant; use the `beforeAll`-import variant below verbatim):

  ```typescript
  import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  let stats: typeof import('./model-vram-stats.js');
  beforeAll(async () => {
    process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-tel-'));
    stats = await import('./model-vram-stats.js'); // dynamic import AFTER the env is set
  });
  ```

  Reference all module functions through the dynamically-imported binding (`stats.recordVramSample(...)`), not a static top-of-file import. `beforeEach` still `rm`s the file for within-file isolation.

- **SAMPLING ENV GATE (the seam that keeps existing fetch-count tests green):** both wired sample sites (analyzer `chat()` and the TTS `maybeSampleSidecarEngine`) issue an extra `fetch` (`/api/ps` resp. `/health`) through `global.fetch`. Existing suites stub `global.fetch` and assert EXACT call counts/indices, so the extra call would break them. The fix is a single **call-time** env gate, read on every invocation (NOT at module-eval — so it survives `vi.resetModules()`): sampling is ON unless `process.env.CASTWRIGHT_VRAM_SAMPLE === '0'`. Production never sets it (default ON). Every existing fetch-count suite we touch adds `beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; }); afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });`. The new wiring tests set it to `'1'` so sampling fires. This replaces any per-mock surgery.

- **Commit convention:** `<type>(<scope>): <subject>` — scopes `server` / `sidecar`.

---

### Task 1: Port `device-total.ts` (boot nvidia-smi total probe)

**Files:** Create `server/src/gpu/device-total.ts`; Test `server/src/gpu/device-total.test.ts`.

**Interfaces — Produces:** `getDeviceTotalVramMb(): number | null`, `setDeviceTotalVramMb(mb): void`, `parseNvidiaSmiTotalMb(raw): number | null`, `initDeviceTotalVram(): Promise<void>`, `_resetDeviceTotalForTests(): void`.

(This module is pure in-memory — no telemetry file, so no isolation pattern needed.)

- [ ] **Step 1: Cut the branch**

```bash
git switch main && git pull --ff-only
git switch -c feat/server-vram-telemetry-v1
```

- [ ] **Step 2: Port verbatim**

```bash
git show feat/server-dynamic-analyzer-models:server/src/gpu/device-total.ts      > server/src/gpu/device-total.ts
git show feat/server-dynamic-analyzer-models:server/src/gpu/device-total.test.ts > server/src/gpu/device-total.test.ts
```

- [ ] **Step 3: Run — expect PASS**

Run: `npm run test:server -- device-total`
Expected: PASS — 3 tests.

- [ ] **Step 4: Commit**

```bash
git add server/src/gpu/device-total.ts server/src/gpu/device-total.test.ts
git commit -m "feat(server): boot-time GPU total-VRAM probe (device-total)"
```

---

### Task 2: Port `model-vram-stats.ts` + per-key trim (M2) + export reader

**Files:** Create `server/src/analyzer/model-vram-stats.ts`, `server/src/analyzer/model-vram-stats.test.ts`.

**Interfaces — Produces:** `canonicalVramKey(model, numCtx): string`, `recordVramSample(rec): Promise<void>`, `sampleAndRecordVram(url, model, numCtx, fetchFn?): Promise<void>`, `initVramStats(): Promise<void>`, `readAllVramRecords(): Promise<VramSampleRecord[]>`, `vramStatsFilePath(): string`, existing EMA helpers (dormant). `interface VramSampleRecord { at: string; key: string; vramMb: number }`.

- [ ] **Step 1: Port verbatim**

```bash
git show feat/server-dynamic-analyzer-models:server/src/analyzer/model-vram-stats.ts      > server/src/analyzer/model-vram-stats.ts
git show feat/server-dynamic-analyzer-models:server/src/analyzer/model-vram-stats.test.ts > server/src/analyzer/model-vram-stats.test.ts
```

- [ ] **Step 2: Make the file-writing tests isolated, then run — expect PASS**

Only the `sampleAndRecordVram` describe block writes the real telemetry file (via `recordVramSample`); the `model-vram-stats helpers` describe (`canonicalVramKey`, `foldEma`, `_emaFromRecords`) is pure in-memory — leave it alone. Convert just the `sampleAndRecordVram` describe (and the new per-key-trim describe in Step 3) to the isolation pattern (Global Constraints): add the `beforeAll` tmpdir + dynamic import, reference `stats.*`, and add `beforeEach(async () => { await rm(stats.vramStatsFilePath(), { force: true }); })`. The ported test imports `sampleAndRecordVram`/`emaForModelSync`/`_resetVramCacheForTests` through the `stats` binding now.

Run: `npm run test:server -- model-vram-stats`
Expected: PASS.

- [ ] **Step 3: Write the failing per-key-trim test**

Append (using the isolated `stats` binding):

```typescript
describe('per-key trim (M2)', () => {
  beforeEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(stats.vramStatsFilePath(), { force: true });
  });

  it('keeps the last 50 samples for EACH key independently', async () => {
    for (let i = 0; i < 60; i++) await stats.recordVramSample({ at: `c${i}`, key: 'chatty@32768', vramMb: i });
    for (let i = 0; i < 3; i++) await stats.recordVramSample({ at: `r${i}`, key: 'rare@32768', vramMb: 1000 + i });
    const recs = await stats.readAllVramRecords();
    const chatty = recs.filter((r) => r.key === 'chatty@32768');
    const rare = recs.filter((r) => r.key === 'rare@32768');
    expect(chatty).toHaveLength(50);
    expect(chatty[0].vramMb).toBe(10); // 0..9 dropped, last-50 kept
    expect(rare).toHaveLength(3);
  });
});
```

- [ ] **Step 4: Run — expect FAIL** (`readAllVramRecords` not exported; chatty=60)

Run: `npm run test:server -- model-vram-stats`
Expected: FAIL.

- [ ] **Step 5: Implement per-key trim + exported reader**

In `model-vram-stats.ts`: replace `const MAX_LINES = 1000;` with `const MAX_PER_KEY = 50;`. Extract the existing line-parse into a shared `parseRecords`, point the existing private `readRecords()` at it, and add `readAllVramRecords`:

```typescript
function parseRecords(raw: string): VramSampleRecord[] {
  const out: VramSampleRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as VramSampleRecord); } catch { /* skip corrupt line */ }
  }
  return out;
}

async function readRecords(): Promise<VramSampleRecord[]> {
  try { return parseRecords(await readFile(vramStatsFilePath(), 'utf8')); }
  catch { return []; }
}

/** Read every persisted sample in chronological (file) order. */
export async function readAllVramRecords(): Promise<VramSampleRecord[]> {
  return readRecords();
}
```

Replace the trim tail of `recordVramSample` (the old `if (lines.length > MAX_LINES)` block) with a per-key cap:

```typescript
    const recs = parseRecords(await readFile(path, 'utf8'));
    const counts = new Map<string, number>();
    for (const r of recs) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    if ([...counts.values()].some((n) => n > MAX_PER_KEY)) {
      const kept = new Map<string, number>();
      const out: VramSampleRecord[] = [];
      for (let i = recs.length - 1; i >= 0; i--) {        // newest-first
        const r = recs[i];
        const used = kept.get(r.key) ?? 0;
        if (used >= MAX_PER_KEY) continue;
        kept.set(r.key, used + 1);
        out.push(r);
      }
      out.reverse();                                      // restore chronological
      await writeFile(path, `${out.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    }
```

Leave the EMA helpers untouched (dormant in v1).

- [ ] **Step 6: Run — expect PASS**

Run: `npm run test:server -- model-vram-stats`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/model-vram-stats.ts server/src/analyzer/model-vram-stats.test.ts
git commit -m "feat(server): measured per-model VRAM store with per-key trim"
```

---

### Task 3: Telemetry fingerprint — rotate stats file on GPU change (Unit C)

**Files:** Create `server/src/gpu/telemetry-fingerprint.ts`, `server/src/gpu/telemetry-fingerprint.test.ts`.

**Interfaces — Consumes** `getDeviceTotalVramMb` (Task 1), `vramStatsFilePath` (Task 2). **Produces** `rotateStatsIfDeviceChanged(currentTotalMb: number | null): Promise<'kept' | 'rotated' | 'first-run'>`.

- [ ] **Step 1: Write the failing test** (isolation pattern — set `WORKSPACE_DIR` + dynamic-import both `./telemetry-fingerprint.js` and `../analyzer/model-vram-stats.js` in `beforeAll`)

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fp: typeof import('./telemetry-fingerprint.js');
let stats: typeof import('../analyzer/model-vram-stats.js');
let telemetryDir: () => string;
beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-fp-'));
  fp = await import('./telemetry-fingerprint.js');
  stats = await import('../analyzer/model-vram-stats.js');
  ({ telemetryDir } = await import('../workspace/paths.js'));
});

describe('telemetry fingerprint rotation', () => {
  const marker = () => join(telemetryDir(), 'vram-fingerprint.json');
  beforeEach(async () => {
    await mkdir(telemetryDir(), { recursive: true });
    await rm(stats.vramStatsFilePath(), { force: true });
    await rm(`${stats.vramStatsFilePath()}.stale`, { force: true });
    await rm(marker(), { force: true });
  });

  it('first run writes the marker', async () => {
    expect(await fp.rotateStatsIfDeviceChanged(12288)).toBe('first-run');
    expect(JSON.parse(await readFile(marker(), 'utf8')).totalMb).toBe(12288);
  });
  it('same fingerprint keeps the file', async () => {
    await fp.rotateStatsIfDeviceChanged(12288);
    await writeFile(stats.vramStatsFilePath(), '{"at":"x","key":"k","vramMb":1}\n', 'utf8');
    expect(await fp.rotateStatsIfDeviceChanged(12288)).toBe('kept');
    await access(stats.vramStatsFilePath());
  });
  it('changed fingerprint rotates to .stale and rewrites marker', async () => {
    await fp.rotateStatsIfDeviceChanged(8188);
    await writeFile(stats.vramStatsFilePath(), '{"at":"x","key":"k","vramMb":1}\n', 'utf8');
    expect(await fp.rotateStatsIfDeviceChanged(12288)).toBe('rotated');
    await access(`${stats.vramStatsFilePath()}.stale`);
    expect(JSON.parse(await readFile(marker(), 'utf8')).totalMb).toBe(12288);
  });
  it('null total (no nvidia-smi) is a no-op', async () => {
    await fp.rotateStatsIfDeviceChanged(12288);
    expect(await fp.rotateStatsIfDeviceChanged(null)).toBe('kept');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

Run: `npm run test:server -- telemetry-fingerprint`

- [ ] **Step 3: Implement**

```typescript
/* Per-machine staleness guard for the VRAM telemetry. If the device total
   changes (card swap / different box / moved install), numbers from the old
   card must not persist. On change we rename the stats file to `.stale` (kept
   for forensics, never read) and stamp the new fingerprint. A null total
   (non-NVIDIA / no nvidia-smi) is a no-op — can't fingerprint, never rotate. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryDir } from '../workspace/paths.js';
import { vramStatsFilePath } from '../analyzer/model-vram-stats.js';

const markerPath = () => join(telemetryDir(), 'vram-fingerprint.json');

export async function rotateStatsIfDeviceChanged(
  currentTotalMb: number | null,
): Promise<'kept' | 'rotated' | 'first-run'> {
  if (currentTotalMb == null) return 'kept';
  await mkdir(telemetryDir(), { recursive: true });
  let prev: number | null = null;
  try { prev = (JSON.parse(await readFile(markerPath(), 'utf8')) as { totalMb?: number }).totalMb ?? null; }
  catch { prev = null; }
  if (prev == null) {
    await writeFile(markerPath(), JSON.stringify({ totalMb: currentTotalMb }), 'utf8');
    return 'first-run';
  }
  if (prev === currentTotalMb) return 'kept';
  try { await rename(vramStatsFilePath(), `${vramStatsFilePath()}.stale`); }
  catch { /* no stats file yet */ }
  await writeFile(markerPath(), JSON.stringify({ totalMb: currentTotalMb }), 'utf8');
  return 'rotated';
}
```

- [ ] **Step 4: Run — expect PASS** (4 tests). - [ ] **Step 5: Commit**

```bash
git add server/src/gpu/telemetry-fingerprint.ts server/src/gpu/telemetry-fingerprint.test.ts
git commit -m "feat(server): rotate VRAM telemetry on GPU fingerprint change"
```

---

### Task 4: Boot wiring — probe total, rotate stale, prime cache

**Files:** Modify `server/src/index.ts` (top-level await block near `await resetOrphanedQueueEntries()`, ~line 420 — confirmed genuine ESM top-level await).

- [ ] **Step 1: Add imports** (near other `./gpu` / `./analyzer` imports)

```typescript
import { initDeviceTotalVram, getDeviceTotalVramMb } from './gpu/device-total.js';
import { rotateStatsIfDeviceChanged } from './gpu/telemetry-fingerprint.js';
import { initVramStats } from './analyzer/model-vram-stats.js';
```

- [ ] **Step 2: Add the boot block** (immediately after the `await resetOrphanedQueueEntries()…` statement and its trailing `.catch(...)` ~line 431 — a genuine ESM top-level `await`. Do NOT chase `app.listen`; there's an unrelated upgrade-coordinator block between them.)

```typescript
// VRAM telemetry substrate (fs-45 v1, record-only — nothing consumes this yet).
// Order: probe device total → rotate stale stats if GPU changed → prime cache.
await initDeviceTotalVram();
await rotateStatsIfDeviceChanged(getDeviceTotalVramMb());
await initVramStats();
```

- [ ] **Step 3: Typecheck + full server suite**

Run: `npm run typecheck` → PASS. Run: `npm run test:server` → PASS (additive boot wiring).

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): wire VRAM telemetry boot init (probe, rotate, prime)"
```

---

### Task 5: Wire the analyzer sampler (record-only) — Unit A, env-gated

The sample call adds a `/api/ps` fetch on the chat path. `ollama.test.ts` stubs `global.fetch` and asserts EXACT call counts/indices (and uses `mockResolvedValueOnce` *queues* for the retry tests — an extra `/api/ps` GET would consume a queued chat response and crash). So instead of rewriting ~10 mocks, gate the sample behind the `CASTWRIGHT_VRAM_SAMPLE` env (Global Constraints): `ollama.test.ts` turns it OFF in one `beforeAll`, leaving every existing mock untouched. The new wiring test turns it ON.

**Files:** Modify `server/src/analyzer/ollama.ts` (insert at the success `return buf`, ~line 643, **inside** the GPU-lock `try`); Modify `server/src/analyzer/ollama.test.ts` (one `beforeAll`/`afterAll` only); Create `server/src/analyzer/ollama-vram-sample.test.ts`.

- [ ] **Step 1: Write the real wiring test** (drives the actual `OllamaAnalyzer.runStage1Chapter`, sampling ON)

`chat()` is private, reached via `OllamaAnalyzer.runStage1Chapter(...)` (the entrypoint `ollama.test.ts` itself drives). Reuse that file's NDJSON helpers + valid-response constant so the stage call succeeds and reaches chat()'s `return buf`.

```typescript
// ollama-vram-sample.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stats: typeof import('./model-vram-stats.js');
let mod: typeof import('./ollama.js');
beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-ollama-'));
  process.env.CASTWRIGHT_VRAM_SAMPLE = '1'; // sampling ON for this file
  stats = await import('./model-vram-stats.js');
  mod = await import('./ollama.js');
});
beforeEach(async () => { await rm(stats.vramStatsFilePath(), { force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

// Build an Ollama-style NDJSON /api/chat response. COPY `VALID_RESPONSE`
// (a schema-valid stage1 JSON string) + the `ndjsonStream`/`okResponse` helpers
// from ollama.test.ts:41-126 — do not invent the schema.
function chatResponse() {
  return okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32)));
}

it('records an analyzer VRAM sample after a successful chat', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/ps')) {
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3.5:9b', size: 6e9, size_vram: 6e9 }] }) } as any;
    }
    return chatResponse(); // /api/chat
  });
  vi.stubGlobal('fetch', fetchMock);
  const analyzer = new mod.OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
  await analyzer.runStage1Chapter('m_id', 1, '# stage1 prompt', {});
  const recs = await stats.readAllVramRecords();
  expect(recs.some((r) => r.key === 'qwen3.5:9b@32768')).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL** (no sample recorded yet)

Run: `npm run test:server -- ollama-vram-sample`

- [ ] **Step 3: Insert the gated record-only call in `chat()`**

Add the import at the top of `ollama.ts`:

```typescript
import { sampleAndRecordVram } from './model-vram-stats.js';
```

At the success `return buf` (~line 643 — grep the unique `return buf;` inside `chat()`; it is inside the `try` that still holds the GPU lock, so the model is provably resident), record first, gated:

```typescript
    // fs-45 v1: record this model's real GPU footprint while provably resident.
    // Env-gated (Global Constraints) so fetch-count tests can opt out; best-effort.
    if (process.env.CASTWRIGHT_VRAM_SAMPLE !== '0') {
      await sampleAndRecordVram(this.url, this.model, resolveAnalyzerNumCtx());
    }
    return buf;
```

- [ ] **Step 4: Turn sampling OFF in the existing `ollama.test.ts`**

Add (top of the outer `describe`, or file scope), so every existing mock/count assertion is untouched:

```typescript
beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });
```

(No other edit to `ollama.test.ts` — the env gate makes the `/api/ps` call never fire there.)

- [ ] **Step 5: Run the analyzer suites — expect PASS, keep-alive unchanged**

Run: `npm run test:server -- ollama`
Expected: PASS — `ollama-vram-sample` (sampling on, records), the untouched `ollama.test.ts` (sampling off), and any `keepAliveFor` test all green. If `keepAliveFor` behavior changed, revert — v1 must not touch it.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts server/src/analyzer/ollama-vram-sample.test.ts
git commit -m "feat(server): record analyzer VRAM footprint on each chat (record-only)"
```

---

### Task 6: Sidecar clean-process gate — `qwen_design_ever_loaded` on `/health`

The OOM-safe gate for `qwen:synth`/`coqui`: a process that has loaded VoiceDesign carries a sticky-high reserved pool forever, so its reserved reading is design-contaminated. Expose a one-way "design ever loaded this process" flag so the server only samples synth/coqui from clean processes.

**Files:** Modify `server/tts-sidecar/main.py` (module-level flag near the other Qwen design state ~line 1931; set inside `QwenEngine._ensure_design_loaded` ~line 1288; `/health` dict — insert after the `"qwen_loaded": qwen_loaded,` line ~2870); Modify `server/tts-sidecar/tests/test_memory.py`.

> **Venv precondition:** these TDD steps need the sidecar venv at `server/tts-sidecar/.venv`. On a box without it, the test SKIPs (exit 0) and you cannot fail-first/pass locally — implement per this task and rely on Task 9's `verify` on a bootstrapped box (note it in the task's commit/PR). The commands below call the venv pytest directly because `npm run test:sidecar` does NOT forward a `-k` filter (`run-tests.ps1` ignores extra args).

- [ ] **Step 1: Write the failing pytest** — mirror the existing `/health` VRAM test (`test_memory.py:759`, which constructs the client inline with `TestClient`; there is NO `client` fixture)

```python
def test_health_exposes_qwen_design_ever_loaded(monkeypatch):
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    with TestClient(main.app) as client:
        body = client.get("/health").json()
    assert body["qwen_design_ever_loaded"] is False  # fresh process, no design yet
```

(Use the same `main` / `TestClient` imports the file already has at the top.)

- [ ] **Step 2: Run — expect FAIL** (`KeyError`/missing key)

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_memory.py -k qwen_design_ever_loaded -q`
Expected: FAIL — `qwen_design_ever_loaded` absent. (If it instead prints a SKIP/venv banner, see the precondition above.)

- [ ] **Step 3: Implement the module flag + /health field**

Add the module-level flag near the other Qwen design state (~line 1931, by `_design_idle_task`):

```python
# fs-45 v1 — one-way, process-lifetime flag. Set the first time VoiceDesign is
# loaded; the sticky CUDA reserved pool stays design-sized afterward, so the
# Node telemetry only samples qwen:synth/coqui from a process where this is False.
_QWEN_DESIGN_EVER_LOADED = False
```

In `QwenEngine._ensure_design_loaded` (~line 1288), **inside** the `if self._design is None:` branch, right after the load (`self._design = self._load_qwen_model(...)` ~1295), set it:

```python
        global _QWEN_DESIGN_EVER_LOADED
        _QWEN_DESIGN_EVER_LOADED = True
```

In the `/health` return dict, add the field right after `"qwen_loaded": qwen_loaded,`:

```python
        "qwen_design_ever_loaded": _QWEN_DESIGN_EVER_LOADED,
```

- [ ] **Step 4: Run — expect PASS**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_memory.py -k qwen_design_ever_loaded -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_memory.py
git commit -m "feat(sidecar): expose qwen_design_ever_loaded on /health (clean-process gate)"
```

---

### Task 7: TTS reserved-at-peak recorder + the gate (Unit B module)

**Files:** Create `server/src/gpu/sidecar-vram-sample.ts`, `server/src/gpu/sidecar-vram-sample.test.ts`. Modify `server/src/routes/sidecar-health.ts` (add `qwenDesignEverLoaded`).

**Interfaces — Consumes** `recordVramSample` (Task 2), `probeSidecarHealth` (`routes/sidecar-health.ts`). **Produces** `recordSidecarEngineVram(key, reservedMb): Promise<void>`, `sampleSidecarEngineVram(key, health): Promise<void>` where `key: 'qwen:synth' | 'qwen:design' | 'coqui'`.

- [ ] **Step 1: Add `qwenDesignEverLoaded` to the health client**

In `server/src/routes/sidecar-health.ts`: add `qwenDesignEverLoaded?: boolean;` to `SidecarHealthResult` (near `qwenLoaded`), and in the result construction (near `vramReservedMb`) add:

```typescript
      qwenDesignEverLoaded: body.qwen_design_ever_loaded === true,
```

- [ ] **Step 2: Write the failing test** (isolation pattern)

```typescript
let stats: typeof import('../analyzer/model-vram-stats.js');
let s: typeof import('./sidecar-vram-sample.js');
beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-sc-'));
  stats = await import('../analyzer/model-vram-stats.js');
  s = await import('./sidecar-vram-sample.js');
});
beforeEach(async () => { await rm(stats.vramStatsFilePath(), { force: true }); });

it('records the absolute reserved reading under the engine:mode key', async () => {
  await s.recordSidecarEngineVram('qwen:design', 5200);
  expect(await stats.readAllVramRecords()).toEqual([expect.objectContaining({ key: 'qwen:design', vramMb: 5200 })]);
});
it('discards null / non-positive / absurd readings', async () => {
  for (const v of [null, 0, -5, 999_999]) await s.recordSidecarEngineVram('coqui', v as any);
  expect(await stats.readAllVramRecords()).toHaveLength(0);
});

describe('sampleSidecarEngineVram gate', () => {
  it('records qwen:design when qwen is loaded (no clean-process gate on design)', async () => {
    await s.sampleSidecarEngineVram('qwen:design', { vramReservedMb: 5200, qwenLoaded: true, qwenDesignEverLoaded: true });
    expect(await stats.readAllVramRecords()).toHaveLength(1);
  });
  it('SKIPS qwen:synth when design was ever loaded (poisoned process)', async () => {
    await s.sampleSidecarEngineVram('qwen:synth', { vramReservedMb: 5200, qwenLoaded: true, qwenDesignEverLoaded: true });
    expect(await stats.readAllVramRecords()).toHaveLength(0);
  });
  it('records qwen:synth from a clean process (design never loaded)', async () => {
    await s.sampleSidecarEngineVram('qwen:synth', { vramReservedMb: 1800, qwenLoaded: true, qwenDesignEverLoaded: false });
    expect(await stats.readAllVramRecords()).toEqual([expect.objectContaining({ key: 'qwen:synth', vramMb: 1800 })]);
  });
  it('SKIPS coqui when design was ever loaded; records when clean', async () => {
    await s.sampleSidecarEngineVram('coqui', { vramReservedMb: 3400, qwenDesignEverLoaded: true });
    expect(await stats.readAllVramRecords()).toHaveLength(0);
    await s.sampleSidecarEngineVram('coqui', { vramReservedMb: 3400, qwenDesignEverLoaded: false });
    expect(await stats.readAllVramRecords()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (module not found)

Run: `npm run test:server -- sidecar-vram-sample`

- [ ] **Step 4: Implement**

```typescript
/* fs-45 v1 — TTS engine VRAM sampler. Records the ABSOLUTE sidecar
   `vram_reserved_mb` at an op's peak (NOT a delta). Reserved is a sticky,
   process-wide high-water mark → over-estimates (the OOM-SAFE direction).
   qwen:design is sampled while VoiceDesign is resident (correct peak).
   qwen:synth/coqui are sampled ONLY from a clean process (design never loaded),
   so the sticky pool reflects that engine's own peak, not a stale design peak. */
import { recordVramSample } from '../analyzer/model-vram-stats.js';

type SidecarVramKey = 'qwen:synth' | 'qwen:design' | 'coqui';
const SANE_MAX_MB = 200_000;

export async function recordSidecarEngineVram(key: SidecarVramKey, reservedMb: number | null): Promise<void> {
  if (reservedMb == null || !Number.isFinite(reservedMb)) return;
  if (reservedMb <= 0 || reservedMb > SANE_MAX_MB) return;
  await recordVramSample({ at: new Date().toISOString(), key, vramMb: reservedMb });
}

/** Record from an already-probed health snapshot, applying the clean-process gate. */
export async function sampleSidecarEngineVram(
  key: SidecarVramKey,
  health: { vramReservedMb: number | null; qwenLoaded?: boolean; qwenDesignEverLoaded?: boolean },
): Promise<void> {
  if (key === 'qwen:design') {
    if (health.qwenLoaded !== true) return;        // sanity: qwen must be resident
  } else {
    // qwen:synth / coqui — only from a process uncontaminated by a prior design.
    if (health.qwenDesignEverLoaded !== false) return;
  }
  await recordSidecarEngineVram(key, health.vramReservedMb);
}

/** One-liner for the wired call sites: env-gated (so fetch-count tests opt out
    via CASTWRIGHT_VRAM_SAMPLE=0) + probes /health + applies the gate. The env
    check is FIRST so a disabled sample issues no /health fetch at all. Best-effort. */
export async function maybeSampleSidecarEngine(key: SidecarVramKey): Promise<void> {
  if (process.env.CASTWRIGHT_VRAM_SAMPLE === '0') return;
  try {
    const { probeSidecarHealth } = await import('../routes/sidecar-health.js');
    await sampleSidecarEngineVram(key, await probeSidecarHealth());
  } catch { /* best-effort */ }
}
```

(Add a unit test asserting `maybeSampleSidecarEngine` is a no-op when `process.env.CASTWRIGHT_VRAM_SAMPLE === '0'` — set it in the test, assert no row + that `probeSidecarHealth` isn't reached by mocking it to throw.)

- [ ] **Step 5: Run — expect PASS** (all cases). - [ ] **Step 6: Commit**

```bash
git add server/src/gpu/sidecar-vram-sample.ts server/src/gpu/sidecar-vram-sample.test.ts server/src/routes/sidecar-health.ts
git commit -m "feat(server): TTS reserved-at-peak recorder with clean-process gate"
```

---

### Task 8: Wire TTS sampling at design + engine-ready call sites

**Files:** Modify `server/src/routes/qwen-voice.ts` (before `return { voiceId, url }` ~line 373 — **inside** the `withGpuLoad` callback, VoiceDesign still resident; `probeSidecarHealth` already imported via `./sidecar-health.js` at ~line 279); Modify `server/src/tts/ensure-sidecar-loaded.ts` (after `await withGpuLoad(...)` resolves ~line 130 — **outside** the lock; `engine` in scope); Modify `server/src/tts/ensure-sidecar-loaded.test.ts` + `server/src/routes/qwen-voice.test.ts` (turn sampling OFF) and add the wiring test.

- [ ] **Step 1: Wire both call sites with the one-liner**

In `ensure-sidecar-loaded.ts`, after the `await withGpuLoad(...)` block resolves (engine loaded, lock released). Kokoro excluded — onnxruntime VRAM is torch-invisible (deferred to v2):

```typescript
  // fs-45 v1: sample this engine's reserved footprint (env-gated + clean-process
  // gate inside maybeSampleSidecarEngine). Best-effort, record-only.
  if (engine === 'qwen' || engine === 'coqui') {
    const { maybeSampleSidecarEngine } = await import('../gpu/sidecar-vram-sample.js');
    await maybeSampleSidecarEngine(engine === 'qwen' ? 'qwen:synth' : 'coqui');
  }
```

In `qwen-voice.ts`, inside the `withGpuLoad` callback, just before it returns `{ voiceId, url }`:

```typescript
        // fs-45 v1: record the design peak (Base + VoiceDesign resident here).
        const { maybeSampleSidecarEngine } = await import('../gpu/sidecar-vram-sample.js');
        await maybeSampleSidecarEngine('qwen:design');
```

- [ ] **Step 2: Turn sampling OFF in the existing fetch-count suites**

Both `ensure-sidecar-loaded.test.ts` and `qwen-voice.test.ts` stub `global.fetch` and assert call counts — the new `/health` probe would inflate them. Add to each (file/outer-describe scope):

```typescript
beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });
```

(With `'0'`, `maybeSampleSidecarEngine` returns before any fetch — existing assertions are untouched.)

- [ ] **Step 3: Run the touched suites — expect PASS** (sampling off, no behavior change)

Run: `npm run test:server -- qwen-voice ensure-sidecar-loaded`
Expected: PASS — existing assertions unaffected.

- [ ] **Step 4: Write the failing wiring test** (new file `server/src/tts/ensure-sidecar-vram.test.ts` — own isolation + sampling ON; stub `global.fetch` to branch `/load` vs `/health`, so `probeSidecarHealth` runs for real, no `vi.doMock` fragility)

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedSidecarUrl: () => 'http://localhost:9000',
  readConfigOverrides: () => ({}),
}));
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: async (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class extends Error {},
}));

let stats: typeof import('../analyzer/model-vram-stats.js');
let mod: typeof import('./ensure-sidecar-loaded.js');
beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-ensure-'));
  process.env.CASTWRIGHT_VRAM_SAMPLE = '1';
  stats = await import('../analyzer/model-vram-stats.js');
  mod = await import('./ensure-sidecar-loaded.js');
});
beforeEach(async () => { await rm(stats.vramStatsFilePath(), { force: true }); });
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

it('records qwen:synth from a clean process after engine-ready', async () => {
  global.fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/health')) {
      return { ok: true, json: async () => ({ vram_reserved_mb: 1800, qwen_loaded: true, qwen_design_ever_loaded: false, engines: ['qwen'] }) } as any;
    }
    return { ok: true, json: async () => ({ status: 'ready' }) } as any; // /load
  }) as unknown as typeof fetch;
  await mod.ensureSidecarEngineReady('qwen', undefined, { timeoutMs: 40, pollIntervalMs: 5 });
  const recs = await stats.readAllVramRecords();
  expect(recs.some((r) => r.key === 'qwen:synth' && r.vramMb === 1800)).toBe(true);
});
```

(`probeSidecarHealth` reads `body.vram_reserved_mb` / `qwen_loaded` / `qwen_design_ever_loaded` — the snake_case keys this `/health` mock returns.)

- [ ] **Step 5: Run — expect FAIL** then, after Step 1's wiring is in place, PASS

Run: `npm run test:server -- ensure-sidecar-vram`
Expected: with Step 1 wired, PASS — a `qwen:synth` row at 1800. (Write this test, watch it FAIL if you stub the wiring out, then confirm PASS with the real wiring.)

- [ ] **Step 6: Typecheck + all touched suites**

Run: `npm run typecheck` → PASS.
Run: `npm run test:server -- qwen-voice ensure-sidecar sidecar-vram-sample`
Expected: PASS — existing suites (sampling off) + the new wiring test (sampling on).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts \
        server/src/tts/ensure-sidecar-loaded.ts server/src/tts/ensure-sidecar-loaded.test.ts \
        server/src/tts/ensure-sidecar-vram.test.ts
git commit -m "feat(server): sample TTS engine VRAM at design + engine-ready (gated)"
```

---

### Task 9: Regression plan doc + INDEX + full verify + PR

**Files:** Create `docs/features/223-vram-telemetry-substrate.md` (223 confirmed free; re-confirm against `docs/features/INDEX.md`); Modify `docs/features/INDEX.md`.

- [ ] **Step 1: Write the regression plan** from `docs/features/TEMPLATE.md`, `status: active`:
  - **What:** passive per-machine VRAM telemetry — analyzer `size_vram`; TTS absolute reserved-at-peak (`qwen:design` while VoiceDesign resident; `qwen:synth`/`coqui` clean-process-gated). Record-only.
  - **Invariants:** (1) no decision consumes the data; `keepAliveFor`/semaphore unchanged. (2) TTS samples are absolute (over-estimate = safe), never deltas. (3) `qwen:synth`/`coqui` only from a process where `qwen_design_ever_loaded` is false. (4) synth/design separate pools. (5) stats rotate on GPU-fingerprint change. (6) per-key trim keeps rare keys.
  - **Documented residual:** within one process, switching between heavy engines (e.g. coqui then qwen) can leave a sticky-high reserved reading; the gate only excludes design-contamination. Recycles reset it. v2's per-model sidecar accounting supersedes this.
  - **v2 trigger:** start the MB engine only once telemetry from a real 12/16 GB card shows the MB decision flips ≥1 real eviction vs the `gpu.safeCoexistMb` threshold.
  - **Manual acceptance:** GPU box — run analysis + a voice design + a generation; confirm `<WORKSPACE_ROOT>/.telemetry/model-vram-stats.jsonl` gains `…@<numCtx>`, `qwen:design`, and (on a fresh/recycled process) `qwen:synth`/`coqui` rows; design-then-generate in the SAME process records NO `qwen:synth` (gate). Spoof the device total → `.stale` rotation. Links #845.

- [ ] **Step 2: Add the INDEX entry** under the `## Plans by area` heading in `docs/features/INDEX.md`, near the 221/222 entries (same area). Re-confirm 223 is unused first.

- [ ] **Step 3: Full battery**

Run: `LOW_CONCURRENCY=1 npm run verify`
Expected: PASS — typecheck + all tests + e2e + build. NOTE: on a box without the sidecar venv, `test:sidecar` SKIPs (exit 0) — so Task 6's `qwen_design_ever_loaded` test is NOT actually exercised here. If you're on such a box, say so explicitly in the PR ("sidecar leg skipped — venv absent; pytest verified on a bootstrapped box / CI") rather than claiming sidecar coverage.

- [ ] **Step 4: Commit, push, PR**

```bash
git add docs/features/223-vram-telemetry-substrate.md docs/features/INDEX.md
git commit -m "docs(docs): regression plan for VRAM telemetry substrate (fs-45 v1)"
git push -u origin feat/server-vram-telemetry-v1
gh pr create --title "feat(server): VRAM telemetry substrate (fs-45 v1)" --body "$(cat <<'BODY'
## Summary
Passive per-machine, per-variant VRAM telemetry — the substrate that will earn the deferred MB-accounting engine (#845 v2). Revives the parked analyzer size_vram sampler + boot device-total probe (record-only, no keepAliveFor change), adds an OOM-safe absolute reserved-at-peak sampler for the Qwen/Coqui TTS engines with a clean-process gate (new sidecar /health flag qwen_design_ever_loaded), and rotates the stats file on GPU change. Nothing consumes the data for a decision in v1.

## Test plan
- New unit suites: model-vram-stats (per-key trim + isolation), device-total, telemetry-fingerprint, sidecar-vram-sample (+ gate), analyzer + ensure-sidecar wiring tests; pytest for the new /health flag.
- LOW_CONCURRENCY=1 npm run verify green.
- Manual GPU-box acceptance per docs/features/223.

Refs #845
BODY
)"
```

---

## Self-review notes

- **Spec coverage:** Unit A → Tasks 2/4/5; Unit B module → Tasks 6(gate)/7, wiring → Task 8; Unit C → Tasks 3/4; per-key trim (M2) → Task 2; staleness → Task 3. Kokoro/AMD/engine/route/warning are explicit v1 non-goals.
- **Review fixes folded:** synth-pool poisoning (B-BLOCKER-1) → clean-process gate (Tasks 6–8); test isolation race (A-BLOCKER-2) → mandatory `WORKSPACE_DIR` tmpdir + dynamic-import pattern in Global Constraints, applied to every telemetry test; `ollama.test.ts` fetch-count breakage (A-BLOCKER-1) → Task 5 Step 4; dead-wiring gap (MAJOR 3) → real wiring tests in Tasks 5 & 8; insertion lines pinned (`:643` inside lock; `:373` design inside lock; `:130` engine-ready outside lock).
- **BLOCKER-2 (load-time vs peak) accepted with rationale:** in a clean process, reserved is sticky, so chapters 2+ sample the true synth peak; the rare chapter-1 load-time-floor sample sits below v2's p95 and is discarded. Documented in the regression plan.
- **Type consistency:** `'qwen:synth'|'qwen:design'|'coqui'` union shared across Tasks 7/8; `readAllVramRecords`/`VramSampleRecord`/`vramStatsFilePath` shared Tasks 2/3/5/7; health fields `vramReservedMb`/`qwenLoaded`/`qwenDesignEverLoaded` (camelCase) verified against `sidecar-health.ts`.
- **Delivery-review fixes folded:** the fetch-count breakage in BOTH `ollama.test.ts` (Task 5) and `ensure-sidecar-loaded.test.ts`/`qwen-voice.test.ts` (Task 8) is solved by the single call-time `CASTWRIGHT_VRAM_SAMPLE` env gate — existing suites set `'0'` (no extra fetch, no mock surgery), wiring tests set `'1'`. Task 5's driver is the real `OllamaAnalyzer.runStage1Chapter` reusing `ollama.test.ts`'s `ndjsonStream`/`okResponse`/`VALID_RESPONSE`; Task 6's pytest uses inline `TestClient(main.app)` (no nonexistent `client` fixture) and a direct venv-pytest `-k` command (since `npm run test:sidecar` drops `-k`), with the no-venv SKIP caveat; Task 8's wiring test stubs `global.fetch` to branch `/load` vs `/health` (real `probeSidecarHealth`, no `vi.doMock`-on-dynamic-import fragility). Anchors pinned: `/health` insert after `"qwen_loaded"`; flag set inside `_ensure_design_loaded`'s `if self._design is None:`; boot block after `resetOrphanedQueueEntries().catch(...)`.
- **No unresolved placeholders.** Task 5's wiring test names the exact helpers to copy from `ollama.test.ts:41-126`.
