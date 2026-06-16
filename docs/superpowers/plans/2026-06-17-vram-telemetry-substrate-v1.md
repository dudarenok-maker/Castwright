# VRAM Telemetry Substrate (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passively measure real per-machine, per-variant VRAM footprints during normal usage (analyzer + TTS) and persist them, with **no decision consuming the data yet** — the substrate that will later earn the deferred MB-accounting engine (#845 v2).

**Architecture:** Revive two built, verified-self-contained modules from branch `feat/server-dynamic-analyzer-models` (`model-vram-stats.ts` Ollama-`size_vram` sampler; `device-total.ts` boot nvidia-smi total-probe), wire the analyzer sampler **record-only** (NOT `keepAliveFor`), add an OOM-safe **absolute** `vram_reserved_mb`-at-peak sampler for the TTS engines, and rotate the stats file when the GPU fingerprint changes. Everything appends to one JSONL under `telemetryDir()`.

**Tech Stack:** TypeScript (Node ESM, `.js` import suffixes), Vitest (node env), Express. Server tests run from repo root via `npm run test:server` (or `cd server && npm run test`).

## Global Constraints

- **Node ESM:** every relative import ends in `.js`. Source is `.ts`.
- **Spec:** `docs/superpowers/specs/2026-06-17-vram-telemetry-mb-accounting-design.md` (v1 section). **Issue:** #845 (`fs-45`).
- **Branch:** `feat/server-vram-telemetry-v1`, cut off current `main`. Do **NOT** merge the stale `feat/server-dynamic-analyzer-models` branch — port the individual files only.
- **v1 records; it never decides.** No `costMb`/`planLoad`/`splitFits`, no `withGpuLoad` signature change, no route, no frontend, no sidecar change. `keepAliveFor()` and the concurrency semaphore stay exactly as on `main`.
- **Best-effort telemetry:** every record/sample path is fire-and-forget and MUST NOT throw into its caller or block the analysis/synthesis path.
- **OOM-safety principle (TTS):** record the **absolute** `vram_reserved_mb` at an op's peak, never a before/after delta. Absolute over-estimates (sticky high-water mark) → the conservative/safe direction.
- **Commit convention:** `<type>(<scope>): <subject>` — scope `server` here.
- **Persisted file:** `telemetryDir()/model-vram-stats.jsonl`, where `telemetryDir()` is `server/src/workspace/paths.ts` → `<WORKSPACE_ROOT>/.telemetry/`.

---

### Task 1: Port `device-total.ts` (boot nvidia-smi total probe)

**Files:**
- Create: `server/src/gpu/device-total.ts`
- Test: `server/src/gpu/device-total.test.ts`

**Interfaces:**
- Produces: `getDeviceTotalVramMb(): number | null`, `setDeviceTotalVramMb(mb: number | null): void`, `parseNvidiaSmiTotalMb(raw: string): number | null`, `initDeviceTotalVram(): Promise<void>`, `_resetDeviceTotalForTests(): void`.

- [ ] **Step 1: Cut the branch**

```bash
git switch main && git pull --ff-only
git switch -c feat/server-vram-telemetry-v1
```

- [ ] **Step 2: Port the two files verbatim from the parked branch**

These files are complete and self-contained (imports: only `node:child_process`). Copy them byte-for-byte:

```bash
git show feat/server-dynamic-analyzer-models:server/src/gpu/device-total.ts      > server/src/gpu/device-total.ts
git show feat/server-dynamic-analyzer-models:server/src/gpu/device-total.test.ts > server/src/gpu/device-total.test.ts
```

- [ ] **Step 3: Run the ported test — expect PASS (it is already complete)**

Run: `npm run test:server -- device-total`
Expected: PASS — 3 tests (`parses nvidia-smi memory.total CSV output`, `returns null for unparseable output`, `caches a set value and serves it synchronously`).

- [ ] **Step 4: Commit**

```bash
git add server/src/gpu/device-total.ts server/src/gpu/device-total.test.ts
git commit -m "feat(server): boot-time GPU total-VRAM probe (device-total)"
```

---

### Task 2: Port `model-vram-stats.ts` + switch to per-key trim (M2 fix)

The ported module trims the JSONL to the last 1000 lines **globally**. Because the analyzer samples on every chapter chat, a low-frequency key (coqui, a second analyzer tag) can be trimmed out before it accumulates a useful count. Change the cap to **per-key last-N** so a chatty key can't evict a rare key's history.

**Files:**
- Create: `server/src/analyzer/model-vram-stats.ts`
- Test: `server/src/analyzer/model-vram-stats.test.ts`

**Interfaces:**
- Consumes: `telemetryDir()` from `../workspace/paths.js` (exists on `main`).
- Produces: `canonicalVramKey(model, numCtx): string`, `recordVramSample(rec: VramSampleRecord): Promise<void>`, `sampleAndRecordVram(url, model, numCtx, fetchFn?): Promise<void>`, `initVramStats(): Promise<void>`, `readAllVramRecords(): Promise<VramSampleRecord[]>` (renamed export of the existing private reader — needed by Task 6's tests), plus the existing EMA helpers (dormant in v1). `interface VramSampleRecord { at: string; key: string; vramMb: number }`.

- [ ] **Step 1: Port the two files verbatim from the parked branch**

```bash
git show feat/server-dynamic-analyzer-models:server/src/analyzer/model-vram-stats.ts      > server/src/analyzer/model-vram-stats.ts
git show feat/server-dynamic-analyzer-models:server/src/analyzer/model-vram-stats.test.ts > server/src/analyzer/model-vram-stats.test.ts
```

- [ ] **Step 2: Run the ported test — expect PASS**

Run: `npm run test:server -- model-vram-stats`
Expected: PASS (the helper + `sampleAndRecordVram` suites that ship with the file).

- [ ] **Step 3: Write the failing per-key-trim test**

Append to `server/src/analyzer/model-vram-stats.test.ts`:

```typescript
import { recordVramSample, readAllVramRecords } from './model-vram-stats.js';
import { rm } from 'node:fs/promises';
import { vramStatsFilePath } from './model-vram-stats.js';

describe('per-key trim (M2)', () => {
  beforeEach(async () => {
    await rm(vramStatsFilePath(), { force: true });
  });

  it('keeps the last MAX_PER_KEY samples for EACH key independently', async () => {
    // 60 samples for a chatty key, then 3 for a rare key.
    for (let i = 0; i < 60; i++) {
      await recordVramSample({ at: `c${i}`, key: 'chatty@32768', vramMb: i });
    }
    for (let i = 0; i < 3; i++) {
      await recordVramSample({ at: `r${i}`, key: 'rare@32768', vramMb: 1000 + i });
    }
    const recs = await readAllVramRecords();
    const chatty = recs.filter((r) => r.key === 'chatty@32768');
    const rare = recs.filter((r) => r.key === 'rare@32768');
    // chatty capped at 50; rare's 3 samples SURVIVE (global-1000 trim would keep them
    // too here, but the point is per-key capping — verify chatty is exactly 50, newest).
    expect(chatty).toHaveLength(50);
    expect(chatty[0].vramMb).toBe(10); // oldest surviving = sample #10 (0..9 dropped)
    expect(rare).toHaveLength(3);
  });
});
```

- [ ] **Step 4: Run it — expect FAIL**

Run: `npm run test:server -- model-vram-stats`
Expected: FAIL — `readAllVramRecords` is not exported yet, and chatty has 60, not 50.

- [ ] **Step 5: Implement per-key trim + export the reader**

In `server/src/analyzer/model-vram-stats.ts`: replace the `MAX_LINES` constant and the trim block inside `recordVramSample`, and export the reader.

Replace `const MAX_LINES = 1000;` with:

```typescript
const MAX_PER_KEY = 50;
```

Replace the trim tail of `recordVramSample` (the `if (lines.length > MAX_LINES)` block) with a per-key cap:

```typescript
    const raw = await readFile(path, 'utf8');
    const recs = parseRecords(raw);
    const counts = new Map<string, number>();
    for (const r of recs) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    if ([...counts.values()].some((n) => n > MAX_PER_KEY)) {
      const keep = new Map<string, number>(); // remaining budget per key, filled newest-first
      const out: VramSampleRecord[] = [];
      for (let i = recs.length - 1; i >= 0; i--) {
        const r = recs[i];
        const used = keep.get(r.key) ?? 0;
        if (used >= MAX_PER_KEY) continue;
        keep.set(r.key, used + 1);
        out.push(r);
      }
      out.reverse(); // restore chronological order
      await writeFile(path, `${out.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    }
```

Factor the line-parsing the existing `readRecords()` already does into an exported pair (the existing `readRecords` stays private; add the thin exports):

```typescript
function parseRecords(raw: string): VramSampleRecord[] {
  const out: VramSampleRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as VramSampleRecord);
    } catch {
      /* skip corrupt/partial line */
    }
  }
  return out;
}

/** Read every persisted sample in chronological (file) order. */
export async function readAllVramRecords(): Promise<VramSampleRecord[]> {
  try {
    return parseRecords(await readFile(vramStatsFilePath(), 'utf8'));
  } catch {
    return [];
  }
}
```

Update the existing private `readRecords()` to call `parseRecords()` (DRY — same parse). Leave EMA helpers untouched (dormant in v1).

- [ ] **Step 6: Run the tests — expect PASS**

Run: `npm run test:server -- model-vram-stats`
Expected: PASS — the ported suites + the new per-key-trim test.

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/model-vram-stats.ts server/src/analyzer/model-vram-stats.test.ts
git commit -m "feat(server): measured per-model VRAM store with per-key trim"
```

---

### Task 3: Telemetry fingerprint — rotate the stats file on GPU change (Unit C)

**Files:**
- Create: `server/src/gpu/telemetry-fingerprint.ts`
- Test: `server/src/gpu/telemetry-fingerprint.test.ts`

**Interfaces:**
- Consumes: `getDeviceTotalVramMb()` (Task 1), `vramStatsFilePath()` + `telemetryDir()`.
- Produces: `rotateStatsIfDeviceChanged(currentTotalMb: number | null): Promise<'kept' | 'rotated' | 'first-run'>`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { telemetryDir } from '../workspace/paths.js';
import { vramStatsFilePath } from '../analyzer/model-vram-stats.js';
import { rotateStatsIfDeviceChanged } from './telemetry-fingerprint.js';

const marker = `${telemetryDir()}/vram-fingerprint.json`;

describe('telemetry fingerprint rotation', () => {
  beforeEach(async () => {
    await mkdir(telemetryDir(), { recursive: true });
    await rm(vramStatsFilePath(), { force: true });
    await rm(marker, { force: true });
    await rm(`${vramStatsFilePath()}.stale`, { force: true });
  });

  it('first run writes the marker and keeps the (empty) file', async () => {
    expect(await rotateStatsIfDeviceChanged(12288)).toBe('first-run');
    expect(JSON.parse(await readFile(marker, 'utf8')).totalMb).toBe(12288);
  });

  it('same fingerprint keeps the stats file', async () => {
    await rotateStatsIfDeviceChanged(12288);
    await writeFile(vramStatsFilePath(), '{"at":"x","key":"k","vramMb":1}\n', 'utf8');
    expect(await rotateStatsIfDeviceChanged(12288)).toBe('kept');
    await access(vramStatsFilePath()); // still there
  });

  it('changed fingerprint rotates the stats file to .stale and rewrites the marker', async () => {
    await rotateStatsIfDeviceChanged(8188);
    await writeFile(vramStatsFilePath(), '{"at":"x","key":"k","vramMb":1}\n', 'utf8');
    expect(await rotateStatsIfDeviceChanged(12288)).toBe('rotated');
    await access(`${vramStatsFilePath()}.stale`); // moved aside
    expect(JSON.parse(await readFile(marker, 'utf8')).totalMb).toBe(12288);
  });

  it('null total (no nvidia-smi) is a no-op (kept), never rotates', async () => {
    await rotateStatsIfDeviceChanged(12288);
    expect(await rotateStatsIfDeviceChanged(null)).toBe('kept');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:server -- telemetry-fingerprint`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/* Per-machine staleness guard for the VRAM telemetry. The stats JSONL carries
   no GPU identity; if the device total changes (card swap, different box, moved
   install) numbers from the old card must not persist into a future decision.
   On a change we rename the stats file to `.stale` (kept for forensics, never
   read) and stamp the new fingerprint. A null total (non-NVIDIA / no nvidia-smi)
   is a no-op — we can't fingerprint, so we never rotate on it. */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryDir } from '../workspace/paths.js';
import { vramStatsFilePath } from '../analyzer/model-vram-stats.js';

function markerPath(): string {
  return join(telemetryDir(), 'vram-fingerprint.json');
}

export async function rotateStatsIfDeviceChanged(
  currentTotalMb: number | null,
): Promise<'kept' | 'rotated' | 'first-run'> {
  if (currentTotalMb == null) return 'kept'; // can't fingerprint → never rotate
  await mkdir(telemetryDir(), { recursive: true });
  let prev: number | null = null;
  try {
    prev = (JSON.parse(await readFile(markerPath(), 'utf8')) as { totalMb?: number }).totalMb ?? null;
  } catch {
    prev = null;
  }
  if (prev == null) {
    await writeFile(markerPath(), JSON.stringify({ totalMb: currentTotalMb }), 'utf8');
    return 'first-run';
  }
  if (prev === currentTotalMb) return 'kept';
  try {
    await rename(vramStatsFilePath(), `${vramStatsFilePath()}.stale`);
  } catch {
    /* no stats file yet — nothing to rotate */
  }
  await writeFile(markerPath(), JSON.stringify({ totalMb: currentTotalMb }), 'utf8');
  return 'rotated';
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm run test:server -- telemetry-fingerprint`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/gpu/telemetry-fingerprint.ts server/src/gpu/telemetry-fingerprint.test.ts
git commit -m "feat(server): rotate VRAM telemetry on GPU fingerprint change"
```

---

### Task 4: Boot wiring — probe total, rotate stale, prime cache

**Files:**
- Modify: `server/src/index.ts` (the top-level boot `await` block, near `await resetOrphanedQueueEntries()` ~line 420)

**Interfaces:**
- Consumes: `initDeviceTotalVram` (Task 1), `getDeviceTotalVramMb` (Task 1), `rotateStatsIfDeviceChanged` (Task 3), `initVramStats` (Task 2).

- [ ] **Step 1: Add the imports**

Near the other `./gpu` / `./analyzer` imports in `server/src/index.ts`:

```typescript
import { initDeviceTotalVram, getDeviceTotalVramMb } from './gpu/device-total.js';
import { rotateStatsIfDeviceChanged } from './gpu/telemetry-fingerprint.js';
import { initVramStats } from './analyzer/model-vram-stats.js';
```

- [ ] **Step 2: Add the boot block (ORDER MATTERS)**

Immediately after `await resetOrphanedQueueEntries()...` (and before `app.listen`), add:

```typescript
// VRAM telemetry substrate (fs-45 v1, record-only — nothing consumes this yet).
// Order: probe the device total → rotate stale stats if the GPU changed →
// prime the in-memory sample cache from the surviving file. Best-effort.
await initDeviceTotalVram();
await rotateStatsIfDeviceChanged(getDeviceTotalVramMb());
await initVramStats();
```

- [ ] **Step 3: Typecheck + boot smoke**

Run: `npm run typecheck`
Expected: PASS (no type errors).

Run: `npm run test:server`
Expected: PASS — the full server suite is unaffected (this is additive, best-effort boot wiring).

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): wire VRAM telemetry boot init (probe, rotate, prime)"
```

---

### Task 5: Wire the analyzer sampler (record-only) — Unit A

Add the single record-only call on the analyzer chat path. This is the ONLY change to `ollama.ts`. Do **not** touch `keepAliveFor()`.

**Files:**
- Modify: `server/src/analyzer/ollama.ts` (the `chat()` method, after a successful response — main has it ~line 435–544)
- Test: `server/src/analyzer/ollama-vram-sample.test.ts` (new, focused)

**Interfaces:**
- Consumes: `sampleAndRecordVram`, `resolveAnalyzerNumCtx` (both already in `ollama.ts`'s module).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { vramStatsFilePath, readAllVramRecords } from './model-vram-stats.js';

// This test pins the CONTRACT: after a successful analyzer chat, a VRAM sample
// is recorded for the analyzer model, best-effort. We exercise sampleAndRecordVram
// directly with a stubbed /api/ps (the wiring in chat() just calls it) to keep the
// test independent of the chat HTTP surface.
import { sampleAndRecordVram } from './model-vram-stats.js';

describe('analyzer VRAM sampling (record-only)', () => {
  beforeEach(async () => {
    await rm(vramStatsFilePath(), { force: true });
  });

  it('records a sample for the resident analyzer model', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        models: [{ name: 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL', size: 4_000_000_000, size_vram: 4_000_000_000 }],
      }),
    });
    await sampleAndRecordVram('http://x', 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL', 32768, fetchFn as any);
    const recs = await readAllVramRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].key).toBe('gemma-4-E4B-it-GGUF:UD-Q4_K_XL@32768');
    expect(recs[0].vramMb).toBeGreaterThan(3000);
  });
});
```

- [ ] **Step 2: Run it — expect PASS** (this asserts the module contract Task 5 wires; if it fails, Task 2's port is wrong)

Run: `npm run test:server -- ollama-vram-sample`
Expected: PASS.

- [ ] **Step 3: Add the import + the record-only call in `chat()`**

Add to the imports at the top of `server/src/analyzer/ollama.ts`:

```typescript
import { sampleAndRecordVram } from './model-vram-stats.js';
```

In `chat()`, after the response is parsed and the call has clearly succeeded (just before `chat()` returns its result), add the fire-and-forget sample. `this.url` and `this.model` are the instance fields; `resolveAnalyzerNumCtx()` is already imported:

```typescript
    // fs-45 v1: record this model's real GPU footprint while it's provably
    // resident (best-effort; never throws, never blocks). Record-only — no
    // decision consumes it in v1.
    await sampleAndRecordVram(this.url, this.model, resolveAnalyzerNumCtx());
```

(Note: `sampleAndRecordVram` swallows all its own errors, so `await` here cannot throw into the chat path.)

- [ ] **Step 4: Guard test — keepAliveFor is UNCHANGED**

Confirm no behavior change to keep-alive. Run the existing analyzer suite:

Run: `npm run test:server -- ollama`
Expected: PASS — every existing `ollama` test (including any `keepAliveFor` test) stays green. If `keepAliveFor` changed, you touched too much — revert that.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/ollama-vram-sample.test.ts
git commit -m "feat(server): record analyzer VRAM footprint on each chat (record-only)"
```

---

### Task 6: TTS absolute reserved-at-peak recorder — Unit B (module)

A small recorder that takes an **absolute** `vram_reserved_mb` reading and appends it under a TTS engine/mode key, with the OOM-safe guards. Pure w.r.t. the sidecar — the reserved value is injected, so it's fully unit-testable.

**Files:**
- Create: `server/src/gpu/sidecar-vram-sample.ts`
- Test: `server/src/gpu/sidecar-vram-sample.test.ts`

**Interfaces:**
- Consumes: `recordVramSample` (Task 2).
- Produces: `recordSidecarEngineVram(key: 'qwen:synth' | 'qwen:design' | 'coqui', reservedMb: number | null): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { vramStatsFilePath, readAllVramRecords } from '../analyzer/model-vram-stats.js';
import { recordSidecarEngineVram } from './sidecar-vram-sample.js';

describe('recordSidecarEngineVram (absolute, OOM-safe)', () => {
  beforeEach(async () => {
    await rm(vramStatsFilePath(), { force: true });
  });

  it('records the absolute reserved reading under the engine:mode key', async () => {
    await recordSidecarEngineVram('qwen:design', 5200);
    const recs = await readAllVramRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].key).toBe('qwen:design');
    expect(recs[0].vramMb).toBe(5200);
  });

  it('keeps synth and design in SEPARATE pools (no cross-contamination)', async () => {
    await recordSidecarEngineVram('qwen:design', 5200);
    await recordSidecarEngineVram('qwen:synth', 1800);
    const recs = await readAllVramRecords();
    expect(recs.filter((r) => r.key === 'qwen:design')).toHaveLength(1);
    expect(recs.filter((r) => r.key === 'qwen:synth')).toHaveLength(1);
  });

  it('discards a null / non-positive / absurd reading', async () => {
    await recordSidecarEngineVram('coqui', null);
    await recordSidecarEngineVram('coqui', 0);
    await recordSidecarEngineVram('coqui', -5);
    await recordSidecarEngineVram('coqui', 999_999); // > any real card
    expect(await readAllVramRecords()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:server -- sidecar-vram-sample`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/* fs-45 v1 — TTS engine VRAM sampler. Records the ABSOLUTE sidecar
   `vram_reserved_mb` at an op's peak (NOT a before/after delta). The reserved
   pool is a sticky, process-wide high-water mark, so this over-estimates a
   model's footprint — which is the OOM-SAFE direction for any future eviction
   decision. The op's engine+mode is known at the call site (a design op vs a
   synth load), so we never infer mode from /health. Best-effort; never throws. */

import { recordVramSample } from '../analyzer/model-vram-stats.js';

type SidecarVramKey = 'qwen:synth' | 'qwen:design' | 'coqui';

const SANE_MAX_MB = 200_000; // larger than any real card → guards against garbage readings

export async function recordSidecarEngineVram(
  key: SidecarVramKey,
  reservedMb: number | null,
): Promise<void> {
  if (reservedMb == null || !Number.isFinite(reservedMb)) return;
  if (reservedMb <= 0 || reservedMb > SANE_MAX_MB) return;
  await recordVramSample({ at: new Date().toISOString(), key, vramMb: reservedMb });
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm run test:server -- sidecar-vram-sample`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/gpu/sidecar-vram-sample.ts server/src/gpu/sidecar-vram-sample.test.ts
git commit -m "feat(server): absolute reserved-at-peak TTS VRAM recorder"
```

---

### Task 7: Wire TTS sampling at the design + engine-ready call sites — Unit B (wiring)

Read the existing `probeSidecarHealth().vramReservedMb` after each TTS op and record it. Mode is explicit at each site. The `qwenLoaded` field guards against recording when the engine isn't actually resident.

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (after `designQwenVoiceForCharacter`'s design fetch succeeds, inside the `withGpuLoad` callback — main ~line 270+)
- Modify: `server/src/tts/ensure-sidecar-loaded.ts` (after `withGpuLoad(...)` resolves in `ensureSidecarEngineReady`, ~line 116+)
- Test: `server/src/gpu/sidecar-vram-sample.wiring.test.ts` (new — drives the two recording helpers with a stubbed health probe)

**Interfaces:**
- Consumes: `recordSidecarEngineVram` (Task 6), `probeSidecarHealth` (`routes/sidecar-health.ts`, returns `{ vramReservedMb: number | null; qwenLoaded?: boolean; ... }`).

- [ ] **Step 1: Write the failing test for a thin recording helper**

To keep the two call sites a one-liner and testable without HTTP, add a helper `sampleSidecarEngineVram(key, health)` that takes an already-probed health result. Test it:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { vramStatsFilePath, readAllVramRecords } from '../analyzer/model-vram-stats.js';
import { sampleSidecarEngineVram } from './sidecar-vram-sample.js';

describe('sampleSidecarEngineVram (from a health snapshot)', () => {
  beforeEach(async () => {
    await rm(vramStatsFilePath(), { force: true });
  });

  it('records qwen:design when qwen is loaded and reserved is sane', async () => {
    await sampleSidecarEngineVram('qwen:design', { vramReservedMb: 5200, qwenLoaded: true });
    const recs = await readAllVramRecords();
    expect(recs).toEqual([expect.objectContaining({ key: 'qwen:design', vramMb: 5200 })]);
  });

  it('skips qwen keys when qwen is NOT loaded (guard against a wrong reading)', async () => {
    await sampleSidecarEngineVram('qwen:synth', { vramReservedMb: 5200, qwenLoaded: false });
    expect(await readAllVramRecords()).toHaveLength(0);
  });

  it('records coqui regardless of qwenLoaded', async () => {
    await sampleSidecarEngineVram('coqui', { vramReservedMb: 3400, qwenLoaded: false });
    expect(await readAllVramRecords()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:server -- sidecar-vram-sample.wiring`
Expected: FAIL — `sampleSidecarEngineVram` not exported.

- [ ] **Step 3: Implement the helper in `server/src/gpu/sidecar-vram-sample.ts`**

```typescript
/** Record an engine sample from an already-probed health snapshot. For qwen
    keys, only record when qwen is actually loaded (guards against sampling a
    reading taken while the wrong/no model is resident). Best-effort. */
export async function sampleSidecarEngineVram(
  key: SidecarVramKey,
  health: { vramReservedMb: number | null; qwenLoaded?: boolean },
): Promise<void> {
  if ((key === 'qwen:synth' || key === 'qwen:design') && health.qwenLoaded !== true) return;
  await recordSidecarEngineVram(key, health.vramReservedMb);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm run test:server -- sidecar-vram-sample.wiring`
Expected: PASS — 3 tests.

- [ ] **Step 5: Wire the design call site (`qwen:design`)**

In `server/src/routes/qwen-voice.ts`, inside `designQwenVoiceForCharacter`'s `withGpuLoad` callback, **after the design fetch has succeeded and produced the voice** (just before that callback returns its `{ voiceId, url }`), add:

```typescript
        // fs-45 v1: record the absolute reserved-at-peak for the design combo
        // (Base + VoiceDesign still resident here). Best-effort, record-only.
        try {
          const { probeSidecarHealth } = await import('./sidecar-health.js');
          const { sampleSidecarEngineVram } = await import('../gpu/sidecar-vram-sample.js');
          await sampleSidecarEngineVram('qwen:design', await probeSidecarHealth());
        } catch {
          /* telemetry is best-effort */
        }
```

- [ ] **Step 6: Wire the engine-ready call site (`qwen:synth` / `coqui`)**

In `server/src/tts/ensure-sidecar-loaded.ts`, **after** the `await withGpuLoad(...)` block resolves in `ensureSidecarEngineReady` (the engine is now loaded), add — only for the two torch engines we measure:

```typescript
  // fs-45 v1: record this engine's absolute reserved footprint now it's loaded.
  // Kokoro is intentionally excluded (onnxruntime VRAM is invisible to torch's
  // reserved figure — deferred to v2). Best-effort, record-only.
  if (engine === 'qwen' || engine === 'coqui') {
    try {
      const { probeSidecarHealth } = await import('../routes/sidecar-health.js');
      const { sampleSidecarEngineVram } = await import('../gpu/sidecar-vram-sample.js');
      await sampleSidecarEngineVram(engine === 'qwen' ? 'qwen:synth' : 'coqui', await probeSidecarHealth());
    } catch {
      /* telemetry is best-effort */
    }
  }
```

- [ ] **Step 7: Typecheck + the two touched suites**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run test:server -- qwen-voice ensure-sidecar-loaded`
Expected: PASS — existing tests for both files stay green (the additions are best-effort and guarded by `try/catch`; if a test mocks `probeSidecarHealth` it still resolves).

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/tts/ensure-sidecar-loaded.ts server/src/gpu/sidecar-vram-sample.ts server/src/gpu/sidecar-vram-sample.wiring.test.ts
git commit -m "feat(server): sample TTS engine VRAM at design + engine-ready"
```

---

### Task 8: Regression plan doc + INDEX + full verify

**Files:**
- Create: `docs/features/223-vram-telemetry-substrate.md` (confirm 223 is free; if not, take the next integer — `git log --oneline -- docs/features | head` / check `INDEX.md`)
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the regression plan**

Create `docs/features/223-vram-telemetry-substrate.md` from `docs/features/TEMPLATE.md`, `status: active`, covering:
- **What:** passive per-machine VRAM telemetry (analyzer `size_vram` + TTS absolute reserved-at-peak), record-only.
- **Invariants:** (1) no decision consumes the data in v1; `keepAliveFor`/semaphore unchanged; (2) TTS samples are absolute readings (over-estimate = safe), never deltas; (3) synth/design are separate pools; (4) stats rotate on GPU-fingerprint change; (5) per-key trim keeps rare keys.
- **v2 trigger (DEFERRED engine):** start the MB-accounting engine only once telemetry from a real 12/16 GB card shows the MB decision would flip ≥1 real eviction vs the `gpu.safeCoexistMb` threshold.
- **Manual acceptance:** run an analysis + a voice design + a generation on the GPU box; confirm `<WORKSPACE_ROOT>/.telemetry/model-vram-stats.jsonl` gains `…@<numCtx>`, `qwen:design`, `qwen:synth`/`coqui` rows; swap/spoof the device total and confirm a `.stale` rotation. Links #845.

- [ ] **Step 2: Add the INDEX entry**

Add a one-line entry for plan 223 under the appropriate area in `docs/features/INDEX.md`.

- [ ] **Step 3: Full local battery**

Run: `LOW_CONCURRENCY=1 npm run verify`
Expected: PASS — typecheck + all tests + e2e + build. (No e2e/frontend was touched, so the delta is the new server tests.)

- [ ] **Step 4: Commit + push + PR**

```bash
git add docs/features/223-vram-telemetry-substrate.md docs/features/INDEX.md
git commit -m "docs(docs): regression plan for VRAM telemetry substrate (fs-45 v1)"
git push -u origin feat/server-vram-telemetry-v1
gh pr create --title "feat(server): VRAM telemetry substrate (fs-45 v1)" --body "$(cat <<'BODY'
## Summary
Passive per-machine, per-variant VRAM telemetry — the substrate that will earn the deferred MB-accounting engine (#845 v2). Revives the parked analyzer `size_vram` sampler + boot device-total probe (record-only, no `keepAliveFor` change), adds an OOM-safe absolute reserved-at-peak sampler for the Qwen/Coqui TTS engines, and rotates the stats file on GPU change. Nothing consumes the data for a decision in v1.

## Test plan
- New unit suites: model-vram-stats (per-key trim), device-total, telemetry-fingerprint, sidecar-vram-sample (+ wiring), analyzer record-only.
- `LOW_CONCURRENCY=1 npm run verify` green.
- Manual GPU-box acceptance per docs/features/223.

Refs #845
BODY
)"
```

---

## Self-review notes

- **Spec coverage:** Unit A → Tasks 2/4/5; Unit B module → Task 6, wiring → Task 7; Unit C → Tasks 3/4; per-key trim (M2) → Task 2; staleness → Task 3; symbol-name (m1) and resident→key (M1) are v2 notes, not v1 code. Kokoro/AMD/engine/route/warning are explicit v1 non-goals — no task, by design.
- **Best-effort everywhere:** every sample/record path swallows its own errors; the `await`s cannot throw into analysis/synthesis.
- **No decision in v1:** Task 5 step 4 explicitly guards that `keepAliveFor` stays green; no `withGpuLoad` signature change, no `costMb`.
- **Type consistency:** `recordSidecarEngineVram(key, reservedMb)` and `sampleSidecarEngineVram(key, health)` both use the `'qwen:synth'|'qwen:design'|'coqui'` union; `readAllVramRecords()`/`VramSampleRecord` shared across Tasks 2/5/6/7; `probeSidecarHealth()` field is `vramReservedMb` (camelCase, verified in `sidecar-health.ts`).
- **Open choice resolved:** Unit B needs no new sidecar field — `/health` already exposes `vram_reserved_mb` + `qwenLoaded`, and mode is known at the call site.
